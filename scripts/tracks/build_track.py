"""
Circuit GLB (a visual model with no physics layers) → simulator track (public/tracks/<id>/track_data.json + <id>.glb).

    python -P scripts/tracks/build_track.py <id> [--debug-dir DIR] [--no-glb] [--no-line-opt]

After the GLB is written it replaces the minimum-curvature racing line with the lap-time lines of the F1 cars
(`ro`) and the GT3 (`roGt3`) by running scripts/ai/optimize-lines.ts (Node.js on PATH).

Per-track settings live in scripts/tracks/tracks.json: source GLB, scale, the material indices of the
racing surface used to trace the centreline (`trace`) and the extra paved materials that bound the road
width (`road`), the start/finish point with a point ahead of it (driving direction) and optional routing
waypoints (needed where the trace mask has junctions, e.g. pit lanes or a figure-of-eight crossover).
scripts/tracks/port_ac_track.py, the Assetto Corsa converter, uses this module's road, kerb, wall and line steps.

Output contract: src/lib/track-data.ts, and the GLB gains
the generated collider / surface nodes the f12026-car and GT3 sims read (TrackColliderQuery.ts).
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import cv2
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import surface as srf  # noqa: E402
import centreline as cl  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
LAT = [-12.0, -8.0, -5.0, -2.5, 0.0, 2.5, 5.0, 8.0, 12.0]
# Kerb cross-section (m above the road) vs distance outward from the asphalt edge: the one profile every circuit uses
# (src/lib/sim/track-surfaces.ts KERB_PROFILE_*)
KERB_PROFILE_L = [-0.30, 0.05, 0.45, 0.95, 1.35]
KERB_PROFILE_Z = [0.0, 0.018, 0.032, 0.026, 0.0]
# Kerbs rise from flush over this distance at both ends of a run
KERB_RAMP_M = 14.0
# Shortest kerb run (m): a paint fleck is not a kerb
KERB_MIN_RUN_M = 20.0
# The scan's kerb paint sets the road edge up to this far inside / outside the raster's edge (m), see refine_width
KERB_EDGE_IN_M = 6.0
KERB_EDGE_OUT_M = 2.6
# Metres along a kerb per texture u (the texture's repeat, and `uvScaleM` for the serration ripple in TrackColliderQuery)
KERB_UV_M = 6.0
# Road surface: largest departure from the fitted bank plane kept from the scan (m)
ROAD_RESIDUAL_M = 0.04
# A profile column counts as road once the road's edge is past it, and comes in over this far as the edge moves out past
# it; the column after it is eased in past the edge over the same distance (road_profile_height)
EDGE_COLUMN_RAMP_M = 0.5
DS = 5.0
WALL_CAP_M = 45.0
# `closeBranches`: tarmac this far past the edge marks another road leaving; its barrier stands this far off the
# edge and runs this far past the mouth on both sides
BRANCH_MOUTH_M = 6.0
BRANCH_CLOSE_GAP_M = 1.2
BRANCH_CLOSE_PAD_M = 8.0


def log(*a):
    print(*a, flush=True)


def periodic_interp_nan(a):
    idx = np.arange(len(a))
    good = np.isfinite(a)
    if good.all():
        return a
    if not good.any():
        return np.zeros_like(a)
    return np.interp(idx, idx[good], a[good], period=len(a))


def cut_masks(R, trace, road, cfg, f, wall_tris=None):
    """`maskCut`: polylines ({"pts": [[x, z], ...], "width": m}) taken out of the paved masks, e.g. a pit wall too thin
    for the scan's mesh to separate the pit lane from the straight, so routing, centring and the width stop there.
    `wall_tris` (from `maskCutMats`): wall triangles whose footprint is taken out the same way, for scans that lay one
    tarmac ribbon under the circuit and a parallel service road with only a concrete wall between them."""
    for cut in cfg.get('maskCut', []):
        p = np.round(R.to_px(np.asarray(cut['pts'], float) * f)).astype(np.int32)
        w = max(1, int(round(cut.get('width', 1.5) / R.res)))
        for m in (trace, road):
            cv2.polylines(m, [p], False, 0, w)
    if wall_tris is not None and len(wall_tris):
        polys = [np.round(R.to_px(t[:, [0, 2]])).astype(np.int32) for t in wall_tris]
        for m in (trace, road):
            cv2.polylines(m, polys, True, 0, 2)
    return R, trace, road


def roll_to_start(xz, start, ahead):
    s = np.asarray(start, float)
    i0 = int(np.argmin(np.linalg.norm(xz - s, axis=1)))
    xz = np.roll(xz, -i0, 0)
    tan = cl.tangents(xz)
    if np.dot(tan[0], np.asarray(ahead, float) - s) < 0:
        xz = np.roll(xz[::-1], 1, 0)
    # exact start: shift by the projection of the start point onto the first segment
    d = xz[1] - xz[0]
    t = float(np.clip(np.dot(s - xz[0], d) / max(1e-9, np.dot(d, d)), -1, 1))
    p = np.vstack([xz, xz[:1]])
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    sc = np.concatenate([[0], np.cumsum(seg)])
    L = sc[-1]
    off = t * seg[0]
    tt = (np.arange(len(xz)) * (L / len(xz)) + off) % L
    x = np.interp(tt, sc, p[:, 0])
    z = np.interp(tt, sc, p[:, 1])
    return np.stack([x, z], 1)


def curvature(xz, k=3):
    a = np.roll(xz, k, 0)
    c = np.roll(xz, -k, 0)
    v1 = xz - a
    v2 = c - xz
    cross = v1[:, 0] * v2[:, 1] - v1[:, 1] * v2[:, 0]
    dot = (v1 * v2).sum(1)
    ang = np.arctan2(cross, dot)
    ln = np.linalg.norm(c - a, axis=1)
    return ang / np.maximum(1e-6, 0.5 * ln)


def circ_runs(flags):
    """Runs of True in a circular mask, as index arrays in driving order"""
    n = len(flags)
    if flags.all():
        return [np.arange(n)]
    start = int(np.argmin(flags))  # a False sample, so no run wraps past the scan start
    out, cur = [], []
    for k in range(n):
        i = (start + k) % n
        if flags[i]:
            cur.append(i)
        elif cur:
            out.append(np.array(cur))
            cur = []
    if cur:
        out.append(np.array(cur))
    return out


def circ_window(n, centre, before, after):
    """Sample indices from `before` samples before `centre` to `after` after it (circular)"""
    return (int(centre) + np.arange(-int(round(before)), int(round(after)) + 1)) % n


def refine_width(soup, road_set, kerb_mats, xz, rgt, yc, bank, width, max_width, kerb_out=KERB_EDGE_OUT_M):
    """The raster edges sit 0.3-0.5 m outside the tarmac (rounding of the filled road triangles at the raster
    resolution), so the road and the physics kerbs ran wide of the scan: measure each edge on the mesh instead.
    The track ends where the road material does (the kerb paint, grass or gravel begins), or at the outer end of
    the white edge line where the tarmac carries on into an asphalt run-off. Returns the new width and the edge
    shifts (n, 2) relative to the old half width.
    The scan's own kerb paint, where it has a kerb material, bounds the track wherever it lies within KERB_EDGE_IN_M
    inside to KERB_EDGE_OUT_M outside the raster edge (apex kerbs the road mask runs over, kerbs beyond a tarmac
    apron past the white line), and keeps its edge over a short median so a 25 m apex kerb is not smoothed away."""
    n = len(xz)
    offs = np.arange(-KERB_EDGE_IN_M, kerb_out + 0.01, 0.1)
    e = np.full((n, 2), np.nan)
    on_kerb = np.zeros((n, 2), bool)
    for i in range(n):
        for si, side in enumerate((-1.0, 1.0)):
            cls = []
            for d in offs:
                lat = width[i] / 2 + d
                p = xz[i] + rgt[i] * side * lat
                h = soup.height_near(p[0], p[1], yc[i] - side * math.sin(bank[i]) * lat, 0.6)
                if h is None:
                    cls.append('x')
                elif h[1] in kerb_mats:
                    cls.append('k')
                elif min(h[2]) > 170:
                    cls.append('w')
                elif h[1] in road_set:
                    cls.append('r')
                else:
                    cls.append('x')
            if cls[0] in 'xk':
                continue
            edge = None
            kerb = False
            for k in range(len(cls) - 2):
                if all(c in 'xk' for c in cls[k:k + 3]):
                    kerb = 'k' in cls[k:k + 3]
                    # without paint the edge is only looked for up to 1 m past the raster's
                    if kerb or offs[k] <= 1.0:
                        edge = offs[k] - 0.05
                    break
            # a white line (at most 0.6 m wide) within reach of the edge bounds the track even with tarmac past it,
            # unless the kerb paint comes after that tarmac
            k0 = next((k for k, d in enumerate(offs) if d >= -1.5 and cls[k] == 'w'), None)
            if k0 is not None and not kerb:
                k1 = k0
                while k1 + 1 < len(cls) and cls[k1 + 1] == 'w':
                    k1 += 1
                if k1 - k0 < 6:
                    edge = min(edge if edge is not None else 9.0, offs[k1] + 0.05)
            if edge is not None:
                e[i, si] = edge
                on_kerb[i, si] = kerb
    for si in range(2):
        col = periodic_interp_nan(e[:, si]) if np.isfinite(e[:, si]).any() else np.zeros(n)
        plain = np.clip(ndimage.median_filter(col, 9, mode='wrap'), -1.5, 0.8)
        near = ndimage.binary_dilation(on_kerb[:, si], np.ones(3))
        painted = np.clip(ndimage.median_filter(np.where(near, col, plain), 3, mode='wrap'), -KERB_EDGE_IN_M, kerb_out)
        e[:, si] = np.where(near, painted, plain)
    new = np.clip(ndimage.gaussian_filter1d(width + e[:, 0] + e[:, 1], 1.0, mode='wrap'), 9.0, max_width)
    return new, e


def find_corners(ks, ds):
    """Corner regions of a curvature trace (+ = right): start / apex / end sample, sign, tightest radius (m)"""
    n = len(ks)
    turn = np.abs(ks) > 1 / 380
    regs, cur = [], None
    start = int(np.argmin(np.abs(ks)))
    for k in (np.arange(n) + start) % n:
        if turn[k] and cur is None:
            cur = [k]
        elif turn[k] and np.sign(ks[k]) != np.sign(ks[cur[-1]]):
            regs.append(cur)
            cur = [k]
        elif turn[k]:
            cur.append(k)
        elif cur is not None:
            regs.append(cur)
            cur = None
    if cur:
        regs.append(cur)
    out = []
    for r in regs:
        r = np.array(r)
        if np.sum(np.abs(ks[r])) * ds < np.radians(14):
            continue
        a = int(r[np.argmax(np.abs(ks[r]))])
        out.append(dict(start=int(r[0]), apex=a, end=int(r[-1]), sign=int(np.sign(ks[a])),
                        rmin=1.0 / max(abs(ks[a]), 1e-6), idx=r))
    return out


def corner_kerbs(xz, ds, kerbL, kerbR, road_beyond, corners_only=False):
    """Kerbs where the scan's paint is missing or not recognised, by rule: an inside kerb around each apex, an outside one from the apex to past the exit, and one at
    turn-in on medium and slow corners (none on the outside of a fast kink). A corner side whose zone already has detected kerb over a third of it keeps
    the detection, bridged across the zone's gaps; one with less gets the rule's kerb. Nothing is added where the
    tarmac carries on past the edge (pit entries and exits, junctions).
    `corners_only` (`kerbCornersOnly`): scans that edge the whole circuit in kerb-coloured paint keep their
    detected kerb only from 20 m before a corner to 40 m past it, so the straights get none."""
    n = len(xz)
    ks = ndimage.gaussian_filter1d(curvature(xz, 2), 1.0, mode='wrap')
    corners = find_corners(ks, ds)
    if corners_only:
        near = np.zeros(n, bool)
        for c in corners:
            near[circ_window(n, c['start'], 20 / ds, (c['end'] - c['start']) % n + 40 / ds)] = True
        log(f'kerbs kept near corners only: dropped L {int((kerbL & ~near).sum())} R {int((kerbR & ~near).sum())} samples')
        kerbL, kerbR = kerbL & near, kerbR & near
    det = {-1: kerbL, 1: kerbR}
    out = {-1: kerbL.copy(), 1: kerbR.copy()}
    added = {-1: 0, 1: 0}
    for c in corners:
        sg, a, r = c['sign'], c['apex'], c['idx']
        inside = r[np.abs(ks[r]) >= 0.45 * abs(ks[a])]
        zones = [(sg, circ_window(n, a, (a - inside[0]) % n + 6 / ds, (inside[-1] - a) % n + 6 / ds))]
        if c['rmin'] < 200:  # fast kinks keep only their inside kerb
            zones.append((-sg, circ_window(n, a, 0, (c['end'] - a) % n + 28 / ds)))
        if c['rmin'] < 130:
            zones.append((-sg, circ_window(n, c['start'], 10 / ds, 18 / ds)))
        for side, idx in zones:
            free = ~road_beyond[idx, 0 if side < 0 else 1]
            hit = np.nonzero(det[side][idx])[0]
            if len(hit) >= len(idx) / 3:
                fill = idx[hit[0]:hit[-1] + 1]
                fill = fill[free[hit[0]:hit[-1] + 1]]
            else:
                fill = idx[free]
            added[side] += int((~out[side][fill]).sum())
            out[side][fill] = True
    log(f'corner kerbs: {len(corners)} corners, added L {added[-1]} R {added[1]} samples to the detected '
        f'L {int(kerbL.sum())} R {int(kerbR.sum())}')
    return out[-1], out[1]


def tidy_kerb_runs(flags, ds, road_beyond_side):
    """Close gaps of up to 2 samples, then stretch runs shorter than KERB_MIN_RUN_M about their middle"""
    n = len(flags)
    f = flags.copy()
    for run in circ_runs(~f):
        if len(run) <= 2 and len(run) < n:
            f[run] = True
    need = int(math.ceil(KERB_MIN_RUN_M / ds))
    for run in circ_runs(f.copy()):
        if len(run) == 1:
            f[run] = False
            continue
        if len(run) >= need:
            continue
        mid = run[len(run) // 2]
        idx = circ_window(n, mid, need // 2, need - 1 - need // 2)
        f[idx[~road_beyond_side[idx]]] = True
    return f


def kerb_texture_png():
    """Red / white kerb paint, one u = KERB_UV_M: six 1 m blocks, worn edges and a faint aggregate grain"""
    from PIL import Image
    w, h = 768, 128
    rng = np.random.default_rng(7)
    u = (np.arange(w) + 0.5) / w * KERB_UV_M
    red = (np.floor(u) % 2 == 0)[None, :].repeat(h, 0)
    img = np.where(red[..., None], np.array([196, 32, 30], float), np.array([232, 232, 226], float))
    img = img * (0.94 + 0.06 * rng.random((h, w, 1)))
    # darker grime toward the outer edge and along the block joints
    v = (np.arange(h) + 0.5) / h
    img *= (1 - 0.10 * np.clip((v - 0.75) / 0.25, 0, 1))[:, None, None]
    joint = np.abs(u - np.round(u)) < 0.015
    img[:, joint] *= 0.75
    import io
    buf = io.BytesIO()
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(buf, 'PNG')
    return buf.getvalue()


def relax_cusps(xz, kmax=1.0 / 10.0, iters=40):
    """Locally re-smooth folds the router leaves in hairpins (radius below ~10 m, tighter than any F1 hairpin)."""
    n_fixed = 0
    for _ in range(iters):
        k = np.maximum(np.abs(curvature(xz, 1)), np.abs(curvature(xz, 2)))
        bad = k > kmax
        if not bad.any():
            break
        n_fixed += int(bad.sum())
        near = ndimage.binary_dilation(np.concatenate([bad[-6:], bad, bad[:6]]), np.ones(9))[6:-6]
        xz = np.where(near[:, None], cl.smooth_closed(xz, 1.5), xz)
        xz, _ = cl.resample_closed(xz, DS)
    if n_fixed:
        ka = np.abs(curvature(xz, 1))
        k = ka.max()
        log(f'relaxed {n_fixed} sample-passes of hairpin folds; tightest radius now {1 / max(k, 1e-9):.1f} m '
            f'at {np.round(xz[int(ka.argmax())], 1).tolist()}')
    return xz


def lane_widen(xz, cfg):
    """`wallLaneWiden`: [{"from": s0, "to": s1, "m": extra}] (m along the lap from the start line): stretches where a
    wall lane is that much wider on its inside, eased in and out over 60 m. Where a chicane rejoins a straight across an
    apron, a 10 m lane is a kink, where the real exit tracks out over the whole paved width."""
    zones = cfg.get('wallLaneWiden', [])
    s = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(xz, axis=0), axis=1))])
    out = np.zeros(len(xz))
    for z in zones:
        a, b, m = z['from'], z['to'], z['m']
        ramp = np.clip(np.minimum(s - a, b - s) / 60.0 + 1.0, 0.0, 1.0)
        out = np.maximum(out, m * ramp * ramp * (3 - 2 * ramp))
    return out


def road_profile_height(yp, hw, lat):
    """Height at lateral offset `lat` (m, + right, |lat| <= 12) of a road of half width `hw` from its profile `yp` (the
    heights at LAT). The road keeps its own crossfall out to its edge: the profile columns past the edge hold the ground
    beside the road (a bank, a ditch, the ground under a bridge), so the height from the last road column on is the line
    through the last two road columns, and only past the edge does it ease to the next column out. Interpolated straight
    towards that column, the last metres of road leaned up to 0.4 m off the mod's road, and the drawn road laid onto them
    tilted across the lane.

    A column counts as road once the edge is past it and comes in over EDGE_COLUMN_RAMP_M as the edge moves on past it;
    past the edge the column after the next one out comes in the same way while the next one is within that distance.
    So the road and the ground beside it change smoothly as the road widens past a column (a column counted as road
    the moment the edge reaches it steps the edge line by up to 0.2 m where it lies off the road's plane).
    src/lib/track-data.ts (evaluateSampleLateralHeightM) reads the profile by the same rule."""
    side = 1 if lat > 0 else -1
    a = abs(lat)
    c0 = len(LAT) // 2

    def col(m):
        return c0 + side * m

    def lat_of(m):
        return abs(LAT[col(m)])

    def line(m0, m1, x):
        return yp[col(m0)] + (yp[col(m1)] - yp[col(m0)]) * (x - lat_of(m0)) / (lat_of(m1) - lat_of(m0))

    def beyond(x):
        return float(np.interp(side * x, LAT, yp))

    # j: the outermost column the edge is past
    j = 0
    while j < c0 and lat_of(j + 1) < hw:
        j += 1

    def road(x):
        if j <= 1:
            return line(0, 1, x)
        if x <= lat_of(j - 1):
            return beyond(x)
        w = min(1.0, (hw - lat_of(j)) / EDGE_COLUMN_RAMP_M)
        return (1.0 - w) * line(j - 2, j - 1, x) + w * line(j - 1, j, x)

    if a <= hw:
        return float(road(a))
    if j >= c0:
        return beyond(a)
    ye = road(hw)

    def ease(m):
        # from the edge to column m, then on through the columns past it
        if m > c0 or a >= lat_of(m):
            return beyond(a)
        return ye + (yp[col(m)] - ye) * (a - hw) / (lat_of(m) - hw)

    u = min(1.0, (lat_of(j + 1) - hw) / EDGE_COLUMN_RAMP_M)
    if u >= 1.0 or j + 2 > c0:
        return float(ease(j + 1))
    return float(u * ease(j + 1) + (1.0 - u) * ease(j + 2))


def smooth_road_profile(yprof, width, ds, sigma=1.5, crest_r=400.0, dip_r=120.0):
    """A race track is a smooth banked plane across its width: scans carry humps and overlapping layers (a 0.5 m,
    10 m long ridge on one half of the road launches a car at 120 km/h). Fit the bank plane
    through the road points, keep at most a few cm of residual, then smooth that residual along the track:
    sigma 1.5 samples (~7.5 m) takes out 10-20 m scan ripple (a washboard at speed) and keeps >80% of crests of 80 m+.
    Then vertical curves along each line: crests no sharper than `crest_r` (R 400 m by default: taken flat at
    230 km/h without going light), compressions no sharper than `dip_r` (R 120 m)."""
    yprof = yprof.copy()
    lat_a = np.array(LAT)
    for i in range(len(yprof)):
        on = np.abs(lat_a) <= width[i] / 2 + 0.3
        A = np.stack([np.ones(on.sum()), lat_a[on]], 1)
        coef, *_ = np.linalg.lstsq(A, yprof[i, on], rcond=None)
        plane = coef[0] + coef[1] * lat_a
        res = yprof[i] - plane
        res[on] = np.clip(res[on], -ROAD_RESIDUAL_M, ROAD_RESIDUAL_M)
        yprof[i] = plane + res
    yprof = ndimage.gaussian_filter1d(yprof, sigma, axis=0, mode='wrap')
    for k in range(len(LAT)):
        col = yprof[:, k]
        for _ in range(60):
            c2 = np.roll(col, -1) - 2 * col + np.roll(col, 1)
            over = (c2 < -ds * ds / crest_r) | (c2 > ds * ds / dip_r)
            if not over.any():
                break
            sm = (np.roll(col, -1) + 2 * col + np.roll(col, 1)) / 4
            col = np.where(ndimage.binary_dilation(over, np.ones(3)), sm, col)
        yprof[:, k] = col
    return yprof


def bank_from_profile(yprof, fall_max):
    """Banking from the road part of the profile (+ = right edge lower); the angle of the rise over 10 m, as the
    runtime's lateral height is tan(bank) · offset"""
    bank = np.arctan(np.clip((yprof[:, 2] - yprof[:, 6]) / 10.0, -fall_max, fall_max))
    return ndimage.gaussian_filter1d(bank, 1.5, mode='wrap')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('id')
    ap.add_argument('--debug-dir', default=None)
    ap.add_argument('--no-glb', action='store_true')
    ap.add_argument('--no-fit', action='store_true', help='keep the model scale (no fit to the official lap length)')
    ap.add_argument('--centreline-only', action='store_true', help='stop after the centreline debug image')
    ap.add_argument('--no-line-opt', action='store_true',
                    help='keep the minimum-curvature line (skip the lap-time optimiser for the F1 and GT3 lines)')
    ap.add_argument('--keep-lines', action='store_true',
                    help="start the racing-line optimiser from the previous build's lines (clamped into the new width)")
    ap.add_argument('--edge-report', action='store_true', help='write <id>_edges.npz (surface classes across each edge) and stop')
    args = ap.parse_args()
    cfgs = json.load(open(os.path.join(HERE, 'tracks.json'), encoding='utf-8'))
    cfg = cfgs[args.id]
    if 'src' not in cfg:
        raise SystemExit(f'{args.id} is an Assetto Corsa port: build it with scripts/tracks/port_ac_track.py')
    cfg['src'] = os.path.expanduser(cfg['src'])
    scale = cfg.get('scale', 1.0)
    r = build(args, cfg, scale, 0)
    if isinstance(r, float):
        scale *= r
        r = build(args, cfg, scale, 1)
    it = 0
    while isinstance(r, np.ndarray):  # centreline moved onto the middle of the mesh edges (meshRecentre)
        it += 1
        r = build(args, cfg, scale, 1, xz_fixed=r, recentre=it < cfg.get('meshRecentreIters', 1))


def build(args, cfg, scale, fit_pass, xz_fixed=None, recentre=True):
    dbg = args.debug_dir
    if dbg:
        os.makedirs(dbg, exist_ok=True)
    log('loading', cfg['src'], 'scale', round(scale, 5))
    j, b, T, M, C = srf.load_world(cfg['src'], scale=scale, clip=cfg.get('clip', 4000.0))
    log('triangles', len(T))

    # ---------------- centreline ----------------
    # start / waypoints / cuts are picked on maps at the configured scale; follow a length fit
    f = scale / cfg.get('scale', 1.0)
    cut_names = set(cfg.get('maskCutMats', []))
    cut_mi = [i for i, m in enumerate(j.get('materials', [])) if m.get('name') in cut_names]
    if cut_names:
        log('mask cut materials', cut_mi)
    wall_tris = T[np.isin(M, cut_mi)] if cut_mi else None
    R, trace, road = cut_masks(*cl.build_masks(T, M, cfg['trace'], cfg.get('road', [])), cfg, f, wall_tris)
    log('raster', R.W, R.H)
    start = [v * f for v in cfg['start']]
    ahead = [v * f for v in cfg['ahead']]
    wps = [[v * f for v in w] for w in cfg.get('waypoints', [])]
    block = None
    if (wall_tris is not None and len(wall_tris)) or cfg.get('maskCut'):
        block = R.zeros()
        if wall_tris is not None and len(wall_tris):
            cv2.polylines(block, [np.round(R.to_px(t[:, [0, 2]])).astype(np.int32) for t in wall_tris], True, 255, 2)
        for cut in cfg.get('maskCut', []):
            cv2.polylines(block, [np.round(R.to_px(np.asarray(cut['pts'], float) * f)).astype(np.int32)], False, 255, 2)
    path = cl.route(R, trace, road, start, ahead, wps, bridge_cost=cfg.get('bridgeCost'), block=block)
    xz, L0 = cl.resample_closed(path, 1.0)
    # path is at 1 m spacing, so sigma in samples = metres; ovals want far more than road courses
    xz = cl.smooth_closed(xz, cfg.get('smoothM', 4.0))
    xz, L0 = cl.resample_closed(xz, DS)
    # The racing surface is often split over several materials (grid boxes, patched / painted sections, a new
    # surface on one straight): add every paved material that lies mostly along the line, so the road edges,
    # centring and width follow the whole visible tarmac rather than just the traced material
    auto = auto_road_mats(T, M, C, xz, set(cfg['trace']) | set(cfg.get('road', [])) | set(cfg.get('kerb', [])),
                          set(cfg.get('notRoad', [])))
    if auto:
        log('road materials added from the line', sorted(auto))
        R, trace, road = cut_masks(*cl.build_masks(T, M, cfg['trace'], list(cfg.get('road', [])) + sorted(auto)), cfg, f, wall_tris)
    if cfg.get('recentre', True):  # off where dense waypoints already place the line (an apron or pit lanes)
        xz = cl.recentre(R, road, xz, DS, keep_radius=cfg.get('recentreKeepRadius', False))
    xz = relax_cusps(xz)
    xz = roll_to_start(xz, start, ahead)
    xz, L = cl.resample_closed(xz, DS)
    xz = roll_to_start(xz, start, ahead)
    if xz_fixed is not None:
        xz = xz_fixed
        L = float(np.linalg.norm(np.roll(xz, -1, 0) - xz, axis=1).sum())
    n = len(xz)
    ds = L / n
    log(f'centreline: {L:.1f} m ({n} samples, ds {ds:.3f}); real {cfg.get("realLengthM")}')
    tan2 = cl.tangents(xz)
    rgt2 = cl.rights(tan2)
    ed = cl.edge_distances(R, road, xz, rgt2)
    hwL = ed[:, 0].copy()
    hwR = ed[:, 1].copy()
    for a in (hwL, hwR):
        # same junction / merge rejection as cl.recentre: a side far wider than its local norm is not the circuit
        typ = ndimage.median_filter(a, max(9, int(250 / ds) | 1), mode='wrap')
        bad = (a >= 19) | (a < 2.5) | (a > 1.25 * typ + 1.0) | (a > 1.35 * np.median(a) + 0.5)
        a[bad] = np.nan
    hwL = periodic_interp_nan(hwL)
    hwR = periodic_interp_nan(hwR)
    lane_w = cfg.get('wallLaneWidthM')
    if lane_w and xz_fixed is None:
        # Ovals: one paved material covers the banking and the flat apron inside it, so the mask's middle is the foot
        # of the banking and a plane fitted across both reads 20 degrees on a 31 degree turn. Measure the racing lane
        # in from the outside (right) edge instead; where the road is narrower than the lane (an infield section of
        # a road course) this is plain centring. Build again on the shifted line.
        # `wallLaneInsetM`: the raster edge sits that far past the foot of the outside wall (only where the paved
        # surface is wider than the lane: an infield road has no wall to be inset from)
        on_oval = np.clip((hwL + hwR - lane_w) / 3.0, 0.0, 1.0)
        sh = hwR - np.minimum(lane_w / 2, (hwL + hwR) / 2) - cfg.get('wallLaneInsetM', 0.0) * on_oval
        # Where the scan's outside wall stands flush with the paving, the lane is laid off the wall itself: the paved
        # edge alone wanders off it where the surface widens (an oval's pit entry), and the lane bulges up to 10 m
        # away from the wall there
        walls0 = wall_raster(R, T, M, cfg.get('wallMaxNy', 0.3))
        wallR = np.full(n0 := len(xz), np.nan)
        for i in range(n0):
            for d in np.arange(1.0, 40.0, 0.5):
                q = np.round(R.to_px(xz[i] + rgt2[i] * d)).astype(int)
                if not (0 <= q[0] < R.W and 0 <= q[1] < R.H):
                    break
                if walls0['mask'][q[1], q[0]]:
                    wallR[i] = d
                    break
        # (the paved edge distance is capped at 20 m: past it the paving reaches at least that far)
        flush = np.isfinite(wallR) & ((np.abs(wallR - ed[:, 1]) < 2.5) | (ed[:, 1] >= 19.5)) & (on_oval > 0.5)
        flush = ndimage.binary_closing(ndimage.binary_opening(flush, np.ones(5)), np.ones(9))
        # the closing bridges holes in the wall where none was found (wallR NaN): carry the wall across them, not 0 m
        sh = np.where(flush, periodic_interp_nan(wallR) - lane_w / 2 - cfg.get('wallLaneGapM', 0.3), sh)
        # the lane widens on its inside where `wallLaneWiden` says so: the centre moves in by half the extra width
        sh = sh - lane_widen(xz, cfg) / 2
        sh = ndimage.gaussian_filter1d(ndimage.median_filter(sh, 9, mode='wrap'), 3.0, mode='wrap')
        lane = xz + rgt2 * sh[:, None]
        # On the oval the lane follows the wall raster's 0.5 m steps: a ~0.3 m wobble every ~50 m that reads as
        # R 180..5000 m turns to anything measuring curvature over 10-20 m (the AI's speed plan braked for them).
        # Smooth it there (radius-keeping), not on an infield road course's tight corners.
        w_oval = ndimage.gaussian_filter1d(on_oval, 4.0, mode='wrap')[:, None]
        lane = w_oval * cl.smooth_closed_keep_radius(lane, 7.0) + (1 - w_oval) * lane
        log(f'wall lane: centreline moved right by median {np.median(sh):.2f} m, range {sh.min():.2f}..{sh.max():.2f} m; '
            f'laid off the wall at {flush.mean():.0%} of the samples')
        xz2, L2 = cl.resample_closed(lane, DS)
        # The lane is the lap the circuit gets, so the fit to the official length is made on it here: the build on
        # this line takes it as fixed and is past the fit (as with the plain centreline, not for the debug map alone)
        real = cfg.get('realLengthM')
        if real and not args.no_fit and not args.centreline_only and abs(real / L2 - 1) > 0.012 and fit_pass == 0:
            log(f'wall lane {L2:.1f} m: scaling model by {real / L2:.4f} to match the official {real} m lap')
            return real / L2
        return roll_to_start(xz2, start, ahead)
    width = ndimage.median_filter(hwL + hwR, 9, mode='wrap')
    if lane_w:
        widen = lane_widen(xz, cfg)
        width = np.where(widen > 0, lane_w + widen, np.minimum(width, lane_w))
    # maxWidth: scans whose single tarmac material is far wider than the circuit (a ~28 m ribbon)
    width = np.clip(ndimage.gaussian_filter1d(width, 2, mode='wrap'), 9.0, cfg.get('maxWidth', 24.0))
    log(f'width: median {np.median(width):.1f} m, range {width.min():.1f}..{width.max():.1f}')

    if dbg:
        img = np.zeros((R.H, R.W, 3), np.uint8)
        img[road > 0] = (90, 90, 90)
        img[trace > 0] = (200, 200, 200)
        p = np.round(R.to_px(xz)).astype(np.int32)
        cv2.polylines(img, [p], True, (0, 0, 255), 1)
        for side, hw in ((-1, width / 2), (1, width / 2)):
            e = np.round(R.to_px(xz + side * rgt2 * hw[:, None])).astype(np.int32)
            cv2.polylines(img, [e], True, (0, 200, 255), 1)
        cv2.circle(img, tuple(p[0]), 8, (0, 255, 0), 2)
        cv2.arrowedLine(img, tuple(p[0]), tuple(p[6]), (0, 255, 0), 2)
        # 100 m world grid with labels, and the numbered waypoints (magenta)
        hi = R.lo + np.array([R.W, R.H]) * R.res
        for gx in np.arange(np.ceil(R.lo[0] / 100) * 100, hi[0], 100):
            x = int((gx - R.lo[0]) / R.res)
            cv2.line(img, (x, 0), (x, R.H - 1), (0, 0, 120), 1)
            for gz in np.arange(np.ceil(R.lo[1] / 100) * 100, hi[1], 400):
                cv2.putText(img, f'{int(gx)}', (x + 3, int((gz - R.lo[1]) / R.res) + 30), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 200, 255), 2)
        for gz in np.arange(np.ceil(R.lo[1] / 100) * 100, hi[1], 100):
            z = int((gz - R.lo[1]) / R.res)
            cv2.line(img, (0, z), (R.W - 1, z), (0, 0, 120), 1)
            for gx in np.arange(np.ceil(R.lo[0] / 100) * 100, hi[0], 400):
                cv2.putText(img, f'{int(gz)}', (int((gx - R.lo[0]) / R.res) + 3, z - 6), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 2)
        for wi, w in enumerate(wps):
            q = np.round(R.to_px(w)).astype(int)
            cv2.circle(img, tuple(q), 14, (255, 0, 255), 3)
            cv2.putText(img, str(wi + 1), (q[0] + 16, q[1] - 8), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 0, 255), 3)
        cv2.imwrite(os.path.join(dbg, f'{args.id}_centreline.png'), img)
        k = 1100 / max(R.W, R.H)
        cv2.imwrite(os.path.join(dbg, f'{args.id}_cl_small.png'),
                    cv2.resize(cv2.dilate(img, np.ones((3, 3), np.uint8)), (int(R.W * k), int(R.H * k)), interpolation=cv2.INTER_AREA))

    if args.centreline_only:
        if dbg:
            np.save(os.path.join(dbg, f'{args.id}_centreline_xz.npy'), xz)
        return None
    real = cfg.get('realLengthM')
    if real and not args.no_fit and abs(real / L - 1) > 0.012 and fit_pass == 0:
        k = real / L
        log(f'scaling model by {k:.4f} to match the official {real} m lap')
        return k

    # ---------------- surfaces under / beside the road ----------------
    corridor = cv2.dilate((road > 0).astype(np.uint8), np.ones((161, 161), np.uint8))
    cen = T.mean(1)[:, [0, 2]]
    inc = R.sample(corridor, cen) > 0
    soup = srf.TriSoup(T[inc], M[inc], C[inc])
    road_set = set(cfg['trace']) | set(cfg.get('road', [])) | auto
    log('surface soup', len(soup.t), 'triangles')
    kerb_mats = set(cfg['kerb']) if 'kerb' in cfg else detect_kerb_mats(T, M, C, xz, width)
    log('kerb materials', sorted(kerb_mats))

    tan = cl.tangents(xz)
    rgt = cl.rights(tan)
    # centre heights, followed continuously so a bridge above / road below never steals the sample
    yc = np.full(n, np.nan)
    # seed from the racing-surface material over the first ~100 m (the line itself may be a different
    # material, and gantries / bridges stand over it), falling back to the lowest hit
    seed = [h[0] for i in range(min(n, 20)) for h in soup.hits(*xz[i]) if h[1] in road_set]
    y_prev = float(np.median(seed)) if seed else min(h[0] for h in soup.hits(*xz[0]))
    slope = 0.0
    misses = 0
    for i in range(n):
        pred = y_prev + slope * ds
        h = soup.height_near(xz[i, 0], xz[i, 1], pred, 1.5, prefer=road_set)
        if h is None:
            h = soup.height_near(xz[i, 0], xz[i, 1], pred, 4.0, prefer=road_set)
        if h is None and misses >= 3:
            # lost the surface: re-acquire on the racing-surface hit nearest the prediction
            road_hits = [q for q in soup.hits(*xz[i]) if q[1] in road_set]
            if road_hits:
                h = min(road_hits, key=lambda q: abs(q[0] - pred))
        if h is None:
            misses += 1
            slope *= 0.5
            y = pred
        else:
            misses = 0
            y = h[0]
            if i > 0:
                slope = 0.7 * slope + 0.3 * (y - y_prev) / ds
        yc[i] = y
        y_prev = y
    yc = ndimage.median_filter(yc, 3, mode='wrap')
    close = yc[-1] - yc[0]
    log(f'elevation {yc.min():.1f}..{yc.max():.1f} m, loop closure {close:+.2f} m')
    if abs(close) > 3.0:
        raise SystemExit(f'centre height does not close the loop ({close:+.1f} m): the tracker followed the wrong layer')

    # lateral profile: march outwards from the centre, predicting each point from the neighbour inside it and
    # the previous sample's crossfall, so banked turns are followed instead of rejected
    # `maxCrossfall` (rise per metre across the road): ovals banked past the default ~15 degrees (31 on a superspeedway)
    fall_max = cfg.get('maxCrossfall', 0.27)
    yprof = np.full((n, len(LAT)), np.nan)
    order = [4, 5, 3, 6, 2, 7, 1, 8, 0]
    for i in range(n):
        row = yprof[i]
        row[4] = yc[i]
        for k in order[1:]:
            lat = LAT[k]
            kin = k - 1 if k > 4 else k + 1
            fall = (yprof[i - 1, k] - yprof[i - 1, kin]) if i > 0 else 0.0
            pred = row[kin] + fall
            p = xz[i] + rgt[i] * lat
            inside = abs(lat) <= (width[i] / 2 + 0.3)
            win = 0.6 if inside else 1.5
            if i == 0 and 'maxCrossfall' in cfg:
                # no previous crossfall to predict from: a start on a banked tri-oval is metres off the flat guess
                win += fall_max * abs(lat - LAT[kin])
            h = soup.height_near(p[0], p[1], pred, win, prefer=road_set if inside else None)
            row[k] = h[0] if h is not None else pred
    # crossfall clamp (a wrong-layer hit still cannot tilt the road past ~15 degrees, or `maxCrossfall`)
    for k, lat in enumerate(LAT):
        dev = yprof[:, k] - yprof[:, 4]
        lim = np.where(np.abs(lat) <= width / 2, fall_max * abs(lat) + 0.1, max(0.35, fall_max + 0.08) * abs(lat) + 0.5)
        yprof[:, k] = yprof[:, 4] + np.clip(dev, -lim, lim)
    yprof = smooth_road_profile(yprof, width, ds)
    yc = yprof[:, 4].copy()
    bank = bank_from_profile(yprof, fall_max)

    if cfg.get('refineEdges', True):
        width_raster = width
        # `kerbEdgeOutM`: how far past the raster edge the scan's kerb paint may still set the edge (corner exits where
        # the racing surface runs on ~3.5 m past the raster's edge to the kerb)
        width, eshift = refine_width(soup, road_set, kerb_mats, xz, rgt, yc, bank, width, cfg.get('maxWidth', 24.0),
                                     cfg.get('kerbEdgeOutM', KERB_EDGE_OUT_M))
        log(f'edges on the mesh: left {np.median(eshift[:, 0]):+.2f} m, right {np.median(eshift[:, 1]):+.2f} m (median); '
            f'width median {np.median(width_raster):.1f} -> {np.median(width):.1f} m, range {width.min():.1f}..{width.max():.1f}')
        if cfg.get('meshRecentre') and recentre and not args.edge_report:
            # The track is symmetric about its centreline, so an edge that moves on one side only moved both by half:
            # put the centreline midway between the mesh edges and build again on it
            sh = ndimage.gaussian_filter1d((eshift[:, 1] - eshift[:, 0]) / 2, cfg.get('meshRecentreSigma', 1.5), mode='wrap')
            log(f'recentring on the mesh edges: |shift| median {np.median(np.abs(sh)):.2f} m, max {np.abs(sh).max():.2f} m')
            xz2, _ = cl.resample_closed(xz + rgt * sh[:, None], DS)
            return roll_to_start(xz2, start, ahead)

    if args.edge_report:
        # lateral surface classes around each edge, for checking where the painted kerbs / lines really are
        offs = np.arange(-4.0, 4.0, 0.1)
        codes = np.zeros((n, 2, len(offs)), np.int8)
        names = ['none', 'kerb', 'white', 'paved', 'grass', 'gravel', 'other', 'roadmat']
        for i in range(n):
            for si, side in enumerate((-1.0, 1.0)):
                for k, d in enumerate(offs):
                    lat = width[i] / 2 + d
                    p = xz[i] + rgt[i] * side * lat
                    h = soup.height_near(p[0], p[1], yc[i] - side * math.sin(bank[i]) * lat, 0.6)
                    if h is None:
                        continue
                    if h[1] in kerb_mats:
                        c = 'kerb'
                    elif min(h[2]) > 170:
                        c = 'white'
                    else:
                        c = srf.classify_colour(h[2])
                        if c == 'paved' and h[1] in road_set:
                            c = 'roadmat'
                    codes[i, si, k] = names.index(c)
        np.savez_compressed(os.path.join(dbg or '.', f'{args.id}_edges.npz'), xz=xz, width=width, offs=offs, codes=codes,
                            names=np.array(names), kerb_mats=np.array(sorted(kerb_mats)))
        log('edge report written')
        return None

    # ---------------- edges: kerbs, run-off, gravel, walls ----------------
    walls = wall_raster(R, T[inc], M[inc], cfg.get('wallMaxNy', 0.3))
    kerbL = np.zeros(n, bool)
    kerbR = np.zeros(n, bool)
    run = np.zeros((n, 2))
    grav = np.zeros((n, 2))
    wall = np.full((n, 2), WALL_CAP_M)
    # the racing surface's own material carries on past the edge (pit entry / exit, a junction): no added kerbs
    road_beyond = np.zeros((n, 2), bool)
    # racing-surface tarmac running on unbroken past the edge: the mouth of another layout's road (`closeBranches`)
    mouth = np.zeros((n, 2), bool)
    follow_ground = cfg.get('edgeFollowGround', False)
    # `pavedMats`: materials that are run-off however their texture reads (an apron's painted yellow line is
    # 'gravel' by colour); with edgeFollowGround the racing surface's own materials count too
    paved_mats = set(cfg.get('pavedMats', [])) | (road_set if follow_ground else set())
    # `grassMats`: ground that is grass however its texture reads (an olive infield reads 'paved' by colour)
    grass_mats = set(cfg.get('grassMats', []))
    for i in range(n):
        for si, side in enumerate((-1.0, 1.0)):
            edge = width[i] / 2
            cls = []
            on_road = 0
            contig = 0
            contig_open = True
            # `edgeFollowGround`: look for each point near the last one found instead of on the road's bank plane
            # carried outward, which on a 31 degree banking runs metres under the flat apron at its foot
            y_follow = yc[i] - side * math.sin(bank[i]) * edge
            for d in np.arange(0.25, 40.0, 0.5):
                p = xz[i] + rgt[i] * side * (edge + d)
                pred = y_follow if follow_ground else yc[i] - side * math.sin(bank[i]) * (edge + d)
                h = soup.height_near(p[0], p[1], pred, 1.2)
                if h is not None:
                    y_follow = h[0]
                cls.append('none' if h is None else 'kerb' if h[1] in kerb_mats else 'paved' if h[1] in paved_mats
                           else 'grass' if h[1] in grass_mats else srf.classify_colour(h[2]))
                if d < 2.0 and h is not None and h[1] in road_set and h[1] not in kerb_mats:
                    on_road += 1
                if contig_open:
                    if h is not None and h[1] in road_set and h[1] not in kerb_mats:
                        contig += 1
                    elif d > 1.0:
                        contig_open = False
            road_beyond[i, si] = on_road >= 3
            mouth[i, si] = contig * 0.5 >= BRANCH_MOUTH_M
            # kerbs may sit just inside the measured edge (scans whose paved material includes them) or outside it
            kh = 0
            for d in (-2.0, -1.4, -0.8, -0.3):
                p = xz[i] + rgt[i] * side * (edge + d)
                h = soup.height_near(p[0], p[1], yc[i] - side * math.sin(bank[i]) * (edge + d), 0.6)
                kh += h is not None and (h[1] in kerb_mats or srf.classify_colour(h[2]) == 'kerb')
            # outside the edge, every 0.25 m (a scan's kerb can be 0.75 m wide), only paint that joins the road
            # counts: past a strip of grass it is another road's
            out_k = 0
            for d in np.arange(0.0, 2.76, 0.25):
                p = xz[i] + rgt[i] * side * (edge + d)
                h = soup.height_near(p[0], p[1], yc[i] - side * math.sin(bank[i]) * (edge + d), 1.2)
                if h is None:
                    continue
                c = 'kerb' if h[1] in kerb_mats else srf.classify_colour(h[2])
                if c in ('grass', 'gravel'):
                    break
                out_k += c == 'kerb'
            kerb = (kh + out_k) >= 2
            if si == 0:
                kerbL[i] = kerb
            else:
                kerbR[i] = kerb
            # run-off: paved / kerb / unknown from the edge; gravel next; then grass
            k = 0
            miss = 0
            while k < len(cls):
                if cls[k] in ('paved', 'kerb', 'other'):
                    miss = 0
                elif miss < 2:
                    miss += 1
                else:
                    break
                k += 1
            r_m = max(0.0, (k - miss) * 0.5)
            g0 = k - miss
            k = g0
            miss = 0
            while k < len(cls):
                if cls[k] == 'gravel':
                    miss = 0
                elif miss < 2:
                    miss += 1
                else:
                    break
                k += 1
            g_m = max(0.0, (k - miss - g0) * 0.5)
            run[i, si] = r_m
            grav[i, si] = g_m
            # first barrier standing on the ground beside the road
            for d in np.arange(edge + 0.5, WALL_CAP_M, 0.5):
                p = xz[i] + rgt[i] * side * d
                q = np.round(R.to_px(p)).astype(int)
                if not (0 <= q[0] < R.W and 0 <= q[1] < R.H):
                    break
                if walls['mask'][q[1], q[0]]:
                    yb = yc[i] - side * math.sin(bank[i]) * d
                    if walls['ymax'][q[1], q[0]] > yb + 0.3 and walls['ymin'][q[1], q[0]] < yb + 1.2:
                        wall[i, si] = d
                        break
    for a in (run, grav):
        for si in range(2):
            a[:, si] = ndimage.median_filter(a[:, si], 5, mode='wrap')
    # `wallMinGapM`: closest a barrier may stand to the road edge (an oval's wall is flush with the racing surface)
    wall_gap = cfg.get('wallMinGapM', 1.5)
    for si in range(2):
        w_ = ndimage.median_filter(wall[:, si], 5, mode='wrap')
        wall[:, si] = np.maximum(w_, width / 2 + wall_gap)
    # On the inside of a bend, offsets past the turning radius fold over to the far side of the corner (a 45 m
    # "no barrier found" wall inside a 14 m hairpin lands across its exit). Keep every inside extent within
    # 0.85 R of the tightest curvature nearby.
    ks = ndimage.gaussian_filter1d(curvature(xz, 2), 1.0, mode='wrap')
    wall_open = np.zeros((n, 2), bool)
    for si, sgn in ((0, -1.0), (1, 1.0)):  # + curvature = right turn = right side inside
        k_in = ndimage.maximum_filter1d(np.clip(sgn * ks, 0, None), 17, mode='wrap')
        lim = np.maximum(0.85 / np.maximum(k_in, 1e-6), width / 2 + wall_gap)
        n_cut = int((wall[:, si] > lim).sum())
        # a barrier found farther out than this is not where the clamp puts it: no wall there (`wall_open`), else
        # it stands across the inside kerb of a hairpin, an invisible wall
        wall_open[:, si] = wall[:, si] > lim + 1.0
        wall[:, si] = np.minimum(wall[:, si], lim)
        if n_cut:
            log(f'{"left" if si == 0 else "right"} barrier pulled inside the turning radius at {n_cut} samples')
        run[:, si] = np.minimum(run[:, si], wall[:, si] - width / 2)
        grav[:, si] = np.minimum(grav[:, si], np.maximum(0, wall[:, si] - width / 2 - run[:, si]))
    # `closeBranches`: scans that carry several layouts (link roads, old chicanes, pit lanes)
    # leave their racing surface running off at each junction. Close each mouth with a barrier just off the edge,
    # physical and visible, so nobody drives off onto the other layout's road.
    closure = np.zeros((n, 2), bool)
    if cfg.get('closeBranches'):
        ds_m = L / n
        grow = max(1, int(round(BRANCH_CLOSE_PAD_M / ds_m)))
        for si in range(2):
            m = ndimage.binary_opening(mouth[:, si], np.ones(max(2, int(round(2.0 / ds_m)))))
            closure[:, si] = ndimage.binary_dilation(m, np.ones(2 * grow + 1)) if m.any() else m
            wall[closure[:, si], si] = width[closure[:, si]] / 2 + BRANCH_CLOSE_GAP_M
            run[:, si] = np.minimum(run[:, si], wall[:, si] - width / 2)
            grav[:, si] = np.minimum(grav[:, si], np.maximum(0, wall[:, si] - width / 2 - run[:, si]))
            wall_open[closure[:, si], si] = False
        log(f'branches closed: L {int(closure[:, 0].sum())} R {int(closure[:, 1].sum())} samples')
    # `openWalls`: [[s0, s1, "L" | "R"], ...] stretches (m along the built line) with no barrier collider, e.g. a
    # pit exit whose lane joins the track past a corner with only a painted line between them
    if cfg.get('openWalls') and not cfg.get('openClampedWalls'):
        wall_open[:] = False
    for s0, s1, side_ in cfg.get('openWalls', []):
        si = 0 if side_ == 'L' else 1
        sm = np.arange(n) * (L / n)
        sel = (sm >= s0) & (sm <= s1) if s0 <= s1 else (sm >= s0) | (sm <= s1)
        wall_open[sel, si] = True
        closure[sel, si] = False
        log(f'walls opened {side_} {s0:.0f}..{s1:.0f} m ({int(sel.sum())} samples)')
    # `closeAt`: [[s0, s1, "L" | "R"], ...] mouths the branch finder misses (a pit entry that leaves a straight paved
    # on that side all along), closed the same way: a visible barrier just off the edge
    for s0, s1, side_ in cfg.get('closeAt', []):
        si = 0 if side_ == 'L' else 1
        sm = np.arange(n) * (L / n)
        sel = (sm >= s0) & (sm <= s1) if s0 <= s1 else (sm >= s0) | (sm <= s1)
        closure[sel, si] = True
        wall[sel, si] = width[sel] / 2 + BRANCH_CLOSE_GAP_M
        run[:, si] = np.minimum(run[:, si], wall[:, si] - width / 2)
        grav[:, si] = np.minimum(grav[:, si], np.maximum(0, wall[:, si] - width / 2 - run[:, si]))
        wall_open[sel, si] = False
        log(f'closed {side_} {s0:.0f}..{s1:.0f} m ({int(sel.sum())} samples)')
    kerbL = ndimage.binary_closing(kerbL, np.ones(3), border_value=0) & ndimage.binary_opening(kerbL | np.roll(kerbL, 1), np.ones(2))
    kerbR = ndimage.binary_closing(kerbR, np.ones(3), border_value=0) & ndimage.binary_opening(kerbR | np.roll(kerbR, 1), np.ones(2))
    road_beyond = ndimage.binary_opening(road_beyond, np.ones((3, 1)))
    if cfg.get('cornerKerbs', True):
        kerbL, kerbR = corner_kerbs(xz, ds, kerbL, kerbR, road_beyond, cfg.get('kerbCornersOnly', False))
    kerbL = tidy_kerb_runs(kerbL, ds, road_beyond[:, 0])
    kerbR = tidy_kerb_runs(kerbR, ds, road_beyond[:, 1])
    log(f'kerbs L {kerbL.mean():.2f} R {kerbR.mean():.2f}; runoff median {np.median(run):.1f} m; '
        f'gravel {np.mean(grav > 1):.2f}; wall median L {np.median(wall[:, 0]):.1f} R {np.median(wall[:, 1]):.1f} m')

    # recentre: circuit centred on the origin, lowest road point ≈ 5 m
    off = np.array([0.5 * (xz[:, 0].min() + xz[:, 0].max()), float(yc.min()) - 5.0, 0.5 * (xz[:, 1].min() + xz[:, 1].max())])
    pos3 = np.stack([xz[:, 0], yc, xz[:, 1]], 1) - off
    data = assemble_track_json(args.id, cfg, pos3, width, bank, yprof - off[1], kerbL, kerbR, run, grav, wall, L, scale)
    data['metadata']['modelOffset'] = [round(float(-v), 4) for v in off]
    # the scan's racing-surface materials, for the runtime asphalt shader (src/lib/render/asphalt-sheen.ts)
    data['metadata']['mesh']['roadMaterials'] = [j['materials'][i].get('name', '') for i in cfg.get('trace', []) + cfg.get('road', []) if i < len(j.get('materials', []))]
    # scan geometry standing on the racing line ([minX, minY, minZ, maxX, maxY, maxZ] in the built world frame),
    # left out when the circuit loads (src/lib/scenery-cuts.ts)
    for key in ('cutBoxes', 'cutMaterials'):
        if cfg.get(key):
            data['metadata']['mesh'][key] = cfg[key]
    out_dir = os.path.join(ROOT, 'public', 'tracks', args.id)
    os.makedirs(out_dir, exist_ok=True)
    if args.keep_lines:
        carry_lines(os.path.join(out_dir, 'track_data.json'), data)
    with open(os.path.join(out_dir, 'track_data.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    log('wrote', os.path.join(out_dir, 'track_data.json'), f'{os.path.getsize(os.path.join(out_dir, "track_data.json")) / 1e3:.0f} kB')
    try:
        update_index(args.id, cfg, data)
    except Exception as e:  # parallel builds: scripts/tracks rebuilds the index afterwards
        log('index update skipped:', e)

    if dbg:
        debug_edges(R, road, trace, xz, rgt, width, wall, run, grav, kerbL, kerbR, walls, os.path.join(dbg, f'{args.id}_edges.png'))

    if not args.no_glb:
        import glbwrite
        extra = collider_meshes(soup, road_set, kerb_mats, xz, rgt, yprof, width, bank, kerbL, kerbR, run, grav, wall, off,
                                cfg.get('scanKerbs', False), (paved_mats, grass_mats) if follow_ground else None,
                                cfg.get('edgeBlendM'), wall_open if (cfg.get('openClampedWalls') or cfg.get('openWalls')) else None,
                                cfg.get('validRunoff'), closure)
        # `underlay`: {"y": height in the source model's frame, "rgb": [r, g, b]}: one flat sheet under the whole scan,
        # so seams between its meshes (along the track edges) show ground, not sky
        ul = cfg.get('underlay')
        if ul:
            txz = T[:, :, [0, 2]].reshape(-1, 2)
            lo_, hi_ = txz.min(0) - 200.0, txz.max(0) + 200.0
            y_ = ul['y'] * scale
            quad = np.array([[lo_[0], y_, lo_[1]], [lo_[0], y_, hi_[1]], [hi_[0], y_, hi_[1]], [hi_[0], y_, lo_[1]]]) - off
            png = cv2.imencode('.png', np.full((4, 4, 3), ul['rgb'][::-1], np.uint8))[1].tobytes()
            extra.append(('Track_Underlay', quad.astype(np.float32), np.array([0, 1, 2, 0, 2, 3], np.uint32),
                          {'_uv': np.array([[0, 0], [0, 1], [1, 1], [1, 0]], np.float32), '_visible': True,
                           '_material': {'name': 'Underlay_Ground', 'png': png, 'roughness': 1.0}}))
            log(f'underlay at y {y_:.1f} (source frame)')
        # `materialOverrides`: {material name: {glTF material fields, pbrMetallicRoughness merged}}, e.g. a
        # base ground exported MASK with alpha 0 (invisible in three.js, so the sky showed through round the track)
        for m in j.get('materials', []):
            ov = cfg.get('materialOverrides', {}).get(m.get('name'))
            if ov:
                ov = dict(ov)
                m.setdefault('pbrMetallicRoughness', {}).update(ov.pop('pbrMetallicRoughness', {}))
                m.update(ov)
                if m.get('alphaMode') == 'OPAQUE':
                    m.pop('alphaCutoff', None)
                log('material override:', m.get('name'))
        glbwrite.write_track_glb(j, b, scale, off, extra, os.path.join(out_dir, f'{args.id}.glb'), clip=cfg.get('clip', 4000.0), log=log)
        if not args.no_line_opt:
            optimise_lines(args.id)
    log('done')
    return None


def carry_lines(old_path, data):
    """Start the racing lines from the previous build's (`ro` F1, `roGt3` GT3; e.g. min-time seeded) instead of the
    minimum-curvature line, clamped into the new width, when the centreline is unchanged"""
    if not os.path.exists(old_path):
        log('keep-lines: no previous track_data.json')
        return
    old_data = json.load(open(old_path, encoding='utf-8'))
    old = old_data['samples']
    new = data['samples']
    same = len(old) == len(new) and max(math.dist(a['p'], b['p']) for a, b in zip(old, new)) <= 0.25
    if not same:
        # the centreline moved: carry each line by where it lies in the world, across the new sample normals
        carried = {}
        o_off = np.array(old_data['metadata'].get('modelOffset', [0, 0, 0]))[[0, 2]]
        n_off = np.array(data['metadata'].get('modelOffset', [0, 0, 0]))[[0, 2]]
        po = np.array([a['p'] for a in old])[:, [0, 2]] - o_off
        to = np.array([a['t'] for a in old])[:, [0, 2]]
        ro_ = np.stack([-to[:, 1], to[:, 0]], 1) / np.linalg.norm(to, axis=1)[:, None]
        pn = np.array([b['p'] for b in new])[:, [0, 2]] - n_off
        tn = np.array([b['t'] for b in new])[:, [0, 2]]
        tn /= np.linalg.norm(tn, axis=1)[:, None]
        rn = np.stack([-tn[:, 1], tn[:, 0]], 1)
        w_new = np.array([b['w'] for b in new])
        ro_geom = np.array([b['ro'] for b in new])
        for key in ('ro', 'roGt3'):
            if not all(key in a for a in old):
                continue
            line = po + ro_ * np.array([a[key] for a in old])[:, None]
            seg = np.roll(line, -1, 0) - line
            out = np.full(len(new), np.nan)
            for i in range(len(new)):
                # segments crossing this sample's normal: along-track coordinate changes sign
                va = (line - pn[i]) @ tn[i]
                vb = va + seg @ tn[i]
                ua = (line - pn[i]) @ rn[i]
                cross = np.nonzero((va <= 0) & (vb > 0) & (np.abs(ua) < 25))[0]
                if len(cross):
                    j = cross[np.argmin(np.abs(ua[cross]))]
                    f = -va[j] / max(vb[j] - va[j], 1e-9)
                    out[i] = (line[j] + f * seg[j] - pn[i]) @ rn[i]
            out = periodic_interp_nan(out)
            off_road = ndimage.binary_dilation(np.abs(out) > w_new / 2, np.ones(13))
            if off_road.any():
                blend = ndimage.gaussian_filter1d(off_road.astype(float), 4.0, mode='wrap')
                out = (1.0 - blend) * out + blend * ro_geom
            carried[key] = out
        if not carried:
            log('keep-lines: centreline moved and the previous build has no lines, not carried')
            return
        log(f'keep-lines: centreline moved, lines carried across by world position')
    clamped = 0
    for i, b in enumerate(new):
        a = old[i] if same else {k: float(v[i]) for k, v in carried.items()}
        for key in ('ro', 'roGt3'):
            if key not in a:
                continue
            lim_l = b['w'] / 2 - (0.7 if b['kL'] else 1.25)
            lim_r = b['w'] / 2 - (0.7 if b['kR'] else 1.25)
            v = min(max(a[key], -lim_l), lim_r)
            clamped += v != a[key]
            b[key] = round(v, 3)
    log(f'keep-lines: carried the previous lines ({clamped} offsets clamped into the new width)')


def optimise_lines(track_id, edge_m=None):
    """Replace the geometric (minimum-curvature) line with each car class's lap-time line: the F1 line (`ro`) and
    the GT3's (`roGt3`), each judged on full physics laps (scripts/ai/optimize-lines.ts). `edge_m`: the car centre's
    margin to the road's edge, when not the optimiser's own (a narrow road lined with barriers)"""
    import subprocess
    edge = f' --edge {edge_m}' if edge_m is not None else ''
    for car in ('f1', 'gt3'):
        r = subprocess.run(f'npx tsx scripts/ai/optimize-lines.ts --track {track_id} --car {car} --write{edge}', cwd=ROOT,
                           shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
        tail = [l for l in r.stdout.splitlines() if l.startswith(('current line:', 'Using:', 'Keeping', 'Wrote'))]
        log(f'{car} racing line:', *(tail[-4:] or [r.stderr[-400:]]))


def apron_runoff(out, xz, rgt, off, ds_m, zones):
    """`validRunoff`: [{"from": s0, "to": s1, "side": "left" | "right"}]: run-off there is part of the track (an oval
    corner taken out over the banking's apron), so its faces move to `Track_Surface_Apron`, tagged as road: full
    grip, and no track-limits strike for running out onto it"""
    from scipy.spatial import cKDTree
    tree = cKDTree(xz)
    rest, keep, moved = [], None, []
    for name, P, F, extras in out:
        if name != 'Track_Surface_Runoff':
            rest.append((name, P, F, extras))
            continue
        tri = F.reshape(-1, 3)
        c = P[tri].mean(1) + off
        _, i = tree.query(c[:, [0, 2]])
        lat = np.einsum('ij,ij->i', c[:, [0, 2]] - xz[i], rgt[i])
        s = i * ds_m
        hit = np.zeros(len(tri), bool)
        for z in zones:
            side = 1.0 if z['side'] == 'right' else -1.0
            hit |= (s >= z['from']) & (s <= z['to']) & (lat * side > 0)
        moved = P[tri[hit]].reshape(-1, 3)
        keep = P[tri[~hit]].reshape(-1, 3)
        rest.append((name, keep, np.arange(len(keep), dtype=np.uint32), extras))
    if len(moved):
        rest.append(('Track_Surface_Apron', moved, np.arange(len(moved), dtype=np.uint32), {'surface': 'road', 'grip': 1.0}))
    log(f'valid run-off: {len(moved) // 3} faces counted as track')
    return rest


def seat_kerbs(P, out):
    """Kerb vertices 8 mm above the drivable surface under them (road, run-off, gravel, grass as built, else the road
    collider), so the kerb continues the ground the wheels come off and reads as kerb at contact"""
    layers = [(name, Q, F) for name, Q, F, _ in out if name.startswith('Track_Surface_') or name == 'Track_Collider_Road']
    soups = [srf.TriSoup(Q[F.reshape(-1, 3)], np.zeros(len(F) // 3, int), np.zeros((len(F) // 3, 3)), cell=2.0, min_ny=0.2)
             for _, Q, F in layers]
    P = P.copy()
    missed = 0
    for k, v in enumerate(P):
        hs = [h[0] for sp in soups for h in sp.hits(v[0], v[2]) if abs(h[0] - v[1]) < 0.3]
        if hs:
            # the surface nearest the road plane carried out (P holds it), not another layer up to 30 cm above
            P[k, 1] = min(hs, key=lambda y: abs(y - v[1])) + 0.008
        else:
            missed += 1
    log(f'scan kerbs seated on the surfaces under them ({missed} of {len(P)} vertices over none, left on the road plane)')
    return P


def reclassify_offroad(out, soup, off, paved_mats, grass_mats):
    """Each run-off / gravel / grass face takes the kind of the scan material under its middle: run-off on paving,
    grass on grass (`edgeFollowGround` circuits, whose junctions and aprons the per-sample bands cannot follow).
    Faces over anything else keep their band's kind."""
    kinds = {'Track_Surface_Runoff': 'runoff', 'Track_Surface_Gravel': 'gravel', 'Track_Surface_Grass': 'grass'}
    pool = {k: [] for k in kinds.values()}
    moved = 0
    rest = []
    for name, P, F, extras in out:
        if name not in kinds:
            rest.append((name, P, F, extras))
            continue
        tri = F.reshape(-1, 3)
        c = P[tri].mean(1) + off
        for t, cc in zip(tri, c):
            h = soup.height_near(cc[0], cc[2], cc[1], 1.0)
            k = kinds[name]
            if h is not None:
                k = 'runoff' if h[1] in paved_mats else 'grass' if h[1] in grass_mats else k
            moved += k != kinds[name]
            pool[k].append(P[t])
    log(f'off-road surfaces: {moved} faces moved to the kind of the scan material under them')
    for name, k in kinds.items():
        if pool[k]:
            V = np.concatenate(pool[k])
            rest.append((name, V, np.arange(len(V), dtype=np.uint32), {'surface': k}))
    return rest


def lap_spline_derivatives(xz):
    """The derivatives of the closed C2 spline through a lap's samples (uniform parameter, one unit per sample), as
    src/lib/track-data.ts solves them: D[i-1] + 4 D[i] + D[i+1] = 3 (P[i+1] - P[i-1]). The game measures where a car is
    across the road from this curve"""
    n = len(xz)
    rhs = 3 * (np.roll(xz, -1, 0) - np.roll(xz, 1, 0))
    row = np.zeros(n)
    row[0], row[1], row[-1] = 4.0, 1.0, 1.0
    eig = np.fft.fft(row)
    return np.real(np.fft.ifft(np.fft.fft(rhs, axis=0) / eig[:, None], axis=0))


def upsample_rows(k, xz, rgt, yprof, width, bank, kerbL, kerbR, run, grav, wall, wall_open=None, closure=None):
    """A closed circuit's sample rows cut `k` times along the lap for its collider meshes (`colliderRowsPerSample`).
    Built from the 5 m rows, every drivable surface was a run of flat 5 m pieces laid on straight chords: on a crest
    or a compression the slope broke at every row, and on a banking round a tight corner the chord's 2-8 cm sag inside
    the curve the game measures the car from (lap_spline_derivatives) put the collider out of step with the road height
    the wheels read, every 5 m (Qiddiya's T13 hairpin and T19, where the cars jumped). The new rows lie on that curve,
    across it, and their heights follow a Catmull-Rom curve through the rows around them, as the game's road height
    does (track-occupancy.ts); widths and walls are straight between rows. Every surface is built from the same rows,
    so their edges meet"""
    n = len(xz)
    f = np.arange(n * k) / k
    i0 = np.floor(f).astype(int)
    t = (f - i0)[:, None]
    i1, im, i2 = (i0 + 1) % n, (i0 - 1) % n, (i0 + 2) % n

    def lin(a):
        a = np.asarray(a)
        tt = t if a.ndim > 1 else t[:, 0]
        return a[i0] * (1 - tt) + a[i1] * tt

    def either(a):
        # a flag holds for a new row when it holds for either row around it
        if a is None:
            return None
        a = np.asarray(a)
        mid = (f - i0) > 0
        return a[i0] | (a[i1] & (mid[:, None] if a.ndim > 1 else mid))

    D = lap_spline_derivatives(xz)
    t2, t3 = t * t, t * t * t
    xz_u = ((2 * t3 - 3 * t2 + 1) * xz[i0] + (t3 - 2 * t2 + t) * D[i0] + (-2 * t3 + 3 * t2) * xz[i1]
            + (t3 - t2) * D[i1])
    tan = (6 * t2 - 6 * t) * xz[i0] + (3 * t2 - 4 * t + 1) * D[i0] + (-6 * t2 + 6 * t) * xz[i1] + (3 * t2 - 2 * t) * D[i1]
    tan /= np.linalg.norm(tan, axis=1, keepdims=True)
    rgt_u = np.stack([-tan[:, 1], tan[:, 0]], 1)
    if np.mean(np.einsum('ij,ij->i', rgt_u[::k], rgt)) < 0:
        rgt_u = -rgt_u
    y0, y1, ym, y2 = yprof[i0], yprof[i1], yprof[im], yprof[i2]
    yprof_u = 0.5 * (2 * y0 + (-ym + y1) * t + (2 * ym - 5 * y0 + 4 * y1 - y2) * t2 + (-ym + 3 * y0 - 3 * y1 + y2) * t3)
    return (xz_u, rgt_u, yprof_u, lin(width), lin(bank), np.asarray(kerbL)[i0], np.asarray(kerbR)[i0], lin(run),
            lin(grav), lin(wall), either(wall_open), either(closure))


def subdivide_twisted_road(P, F, ncol, max_twist_m, k_lat=2):
    """The road surface strip (`ncol` points across every sample row, faces between rows as collider_meshes' strip
    builds them) cut finer where its quads twist: a quad whose crossfall changes from one row to the next folds along
    its diagonal, and on a banking that turns quickly the folds are a few cm and every 2-3 m, which the suspension
    feels as a washboard (Qiddiya's T19 threw the car off the ground). Each quad becomes a bilinear patch, `k_lat`
    across and as many rows along as keep every small quad's twist under `max_twist_m`. A patch's edges are the quad's
    own straight edges, so the kerbs, run-off and road collider beside it still meet it exactly. Heights curved
    through the rows instead (Catmull-Rom) smoothed the turns further but put the road edge out of step with the kerbs
    on the crests, where a car on the kerb bounced more"""
    n = len(P) // ncol
    G = P.reshape(n, ncol, 3)
    ok = np.zeros(n, bool)
    ok[np.asarray(F[0::6], np.int64) // ncol] = True
    # every row with its points cut `k_lat` times across: M points
    u = np.arange((ncol - 1) * k_lat + 1) / k_lat
    c0 = np.minimum(np.floor(u).astype(int), ncol - 2)
    fu = (u - c0)[None, :, None]
    R = G[:, c0] * (1 - fu) + G[:, c0 + 1] * fu
    M = R.shape[1]
    V = [R.reshape(-1, 3)]
    nv = n * M
    Fo = []
    cols = np.arange(M - 1)
    added = 0
    y = G[:, :, 1]
    for i in np.where(ok)[0]:
        i1 = (i + 1) % n
        twist = np.abs(y[i, :-1] - y[i, 1:] - y[i1, :-1] + y[i1, 1:]).max()
        ks = int(min(16, max(1, math.ceil(twist / (max_twist_m * k_lat)))))
        idx = [i * M]
        for r in range(1, ks):
            f = r / ks
            V.append(R[i] * (1 - f) + R[i1] * f)
            idx.append(nv)
            nv += M
        idx.append(i1 * M)
        added += ks - 1
        for a, b in zip(idx[:-1], idx[1:]):
            v00, v01, v10, v11 = a + cols, a + cols + 1, b + cols, b + cols + 1
            Fo.append(np.stack([v00, v10, v01, v01, v10, v11], 1).reshape(-1))
    Fo = np.concatenate(Fo).astype(np.uint32) if Fo else np.zeros(0, np.uint32)
    log(f'road surface: {added} rows added where its quads twist (under {max_twist_m * 100:.1f} cm each), '
        f'{len(F) // 3} -> {len(Fo) // 3} triangles')
    return np.concatenate(V), Fo


def collider_meshes(soup, road_set, kerb_mats, xz, rgt, yprof, width, bank, kerbL, kerbR, run, grav, wall, off, scan_kerbs=False,
                    surface_mats=None, edge_blend_m=None, wall_open=None, valid_runoff=None, closure=None, skip=None,
                    road_twist_m=None):
    """Hidden physics meshes in final world space (source world minus `off`). `scan_kerbs` (`scanKerbs`): the physics
    kerb is the scan's own kerb paint (scan_kerb_mesh) and no generated kerb is drawn over it. `skip`: samples with
    no surfaces (a point-to-point course's dead stretch; pass `wall_open` there too). `road_twist_m` (`roadTwistM`):
    the road surface is cut finer where its quads twist more than this (subdivide_twisted_road)"""
    n = len(xz)

    def prof_y(i, lat):
        if -12.0 <= lat <= 12.0:
            return road_profile_height(yprof[i], hw[i], lat)
        edge = yprof[i, 0] if lat < 0 else yprof[i, -1]
        return float(edge - math.sin(bank[i]) * (lat - (-12.0 if lat < 0 else 12.0)))

    def edge_blend(i, lat, y):
        """`edgeBlendM` = (flat, ease): off the road, the road's own plane carried on for `flat` m past the edge, then
        eased onto the scan's height `y` over `ease` m, so run-off, kerbs and grass meet the road without a step (the
        scan sits up to ~12 cm off the smoothed road at the edge)"""
        if edge_blend_m is None:
            return y
        d = abs(lat) - hw[i]
        pl = plane_out(i, lat) if d > 0 else prof_y(i, lat)
        w = min(1.0, max(0.0, (d - edge_blend_m[0]) / edge_blend_m[1]))
        return pl + w * (y - pl)

    def strip(a, bnd, ncol, prefer, window, from_prof, clamp=None, prof=None, blend=False):
        """Quad strip between per-sample lateral bounds a < bnd (m, + right); heights from the visual mesh,
        kept within `clamp` = (below, above) of the smoothed profile (`prof`, default prof_y) when given, and eased
        off the road's plane (edge_blend) when `blend`."""
        prof_y_ = prof or prof_y
        V = np.zeros((n, ncol, 3))
        for i in range(n):
            lats = np.linspace(a[i], bnd[i], ncol)
            # march outwards from the side nearest the centre so the predicted height follows the ground
            order = np.argsort(np.abs(lats))
            prev = None
            for c in order:
                lat = lats[c]
                pred = prof_y_(i, lat) if (from_prof or prev is None) else prev
                q = xz[i] + rgt[i] * lat
                h = soup.height_near(q[0], q[1], pred, window, prefer=prefer)
                y = h[0] if h is not None else pred
                if clamp is not None:
                    py = prof_y_(i, lat)
                    y = min(max(y, py - clamp[0]), py + clamp[1])
                prev = y
                V[i, c] = (q[0], edge_blend(i, lat, y) if blend else y, q[1])
        ok = (bnd - a) > 0.05
        if skip is not None:
            ok = ok & ~skip
        F = []
        for i in range(n):
            i1 = (i + 1) % n
            if not (ok[i] and ok[i1]):
                continue
            for c in range(ncol - 1):
                v00, v01 = i * ncol + c, i * ncol + c + 1
                v10, v11 = i1 * ncol + c, i1 * ncol + c + 1
                F += [v00, v10, v01, v01, v10, v11]
        P = V.reshape(-1, 3) - off
        return P, np.array(F, np.uint32)

    def kerb_mesh(side, flags, visual=False):
        """Raised kerbs where `flags`, in the shared cross-section (KERB_PROFILE_*, from the asphalt edge outward),
        rising from flush over KERB_RAMP_M at both ends of every run. UVs: u = metres along / KERB_UV_M (the paint's
        repeat, and the serration ripple TrackColliderQuery adds from the surface table), v = 0..1 from the inner to
        the outer edge. The physics kerb stands on the smoothed road profile; the `visual` copy is lifted onto the
        scan wherever that is higher, so the scan's own paint and grass never show through it.
        Returns positions, indices and UVs."""
        V, UV, F = [], [], []
        lat0 = np.array(KERB_PROFILE_L)
        z0 = np.array(KERB_PROFILE_Z)
        nc = len(lat0)
        sub = 2
        for run in circ_runs(flags):
            idx = np.r_[run, (run[-1] + 1) % n]
            run_len = ds_m * (len(idx) - 1)
            base = len(V)
            rows = 0
            for k in range(len(idx) - 1):
                i, i1 = idx[k], idx[k + 1]
                for r in range(sub + (1 if k == len(idx) - 2 else 0)):
                    f = r / sub
                    s_run = (k + f) * ds_m
                    t = min(s_run, run_len - s_run) / KERB_RAMP_M
                    ramp = 0.0 if t <= 0 else 1.0 if t >= 1 else t * t * (3 - 2 * t)
                    for c, (lv, zv) in enumerate(zip(lat0, z0)):
                        lat_i = side * (hw[i] + lv)
                        lat_j = side * (hw[i1] + lv)
                        q = xz[i] + rgt[i] * lat_i
                        q = q + (xz[i1] + rgt[i1] * lat_j - q) * f
                        y = prof_y(i, lat_i) * (1 - f) + prof_y(i1, lat_j) * f + zv * ramp
                        if visual:
                            h = soup.height_near(q[0], q[1], y, 0.25)
                            if h is not None:
                                y = max(y, h[0] + 0.006)
                        V.append((q[0], y, q[1]))
                        UV.append((s_run / KERB_UV_M, c / (nc - 1)))
                    rows += 1
            for r in range(rows - 1):
                for c in range(nc - 1):
                    v00 = base + r * nc + c
                    v01, v10, v11 = v00 + 1, v00 + nc, v00 + nc + 1
                    F += [v00, v10, v01, v01, v10, v11]
        if not V:
            return np.zeros((0, 3)), np.zeros(0, np.uint32), np.zeros((0, 2))
        P = np.array(V)
        Fa = np.array(F, np.int64).reshape(-1, 3)
        # face up (the visual copy is drawn single-sided)
        fn = np.cross(P[Fa[:, 1]] - P[Fa[:, 0]], P[Fa[:, 2]] - P[Fa[:, 0]])
        down = fn[:, 1] < 0
        Fa[down] = Fa[down][:, ::-1]
        return P - off, Fa.reshape(-1).astype(np.uint32), np.array(UV)

    def scan_kerb_mesh():
        """The scan's kerb triangles where they line this circuit's edges (from KERB_EDGE_IN_M inside the asphalt edge
        to 3 m past it, at road height), so the kerbs a car feels are the ones painted on the scan. Each vertex sits on
        the road profile plus the shared kerb cross-section (KERB_PROFILE_*) by its distance past the edge: painted
        kerbs inside the edge stay flush. UVs as kerb_mesh's: u = metres along / KERB_UV_M, v = 0.5 (full ripple)."""
        from scipy.spatial import cKDTree
        Tk = soup.t[np.isin(soup.mat, list(kerb_mats))]
        if not len(Tk):
            return np.zeros((0, 3)), np.zeros(0, np.uint32), np.zeros((0, 2))
        tree = cKDTree(xz)
        tan = np.stack([rgt[:, 1], -rgt[:, 0]], 1)
        c = Tk.mean(1)
        _, ic = tree.query(c[:, [0, 2]])
        relc = c[:, [0, 2]] - xz[ic]
        latc = np.einsum('ij,ij->i', relc, rgt[ic])
        alongc = np.einsum('ij,ij->i', relc, tan[ic])
        ec = np.abs(latc) - hw[ic]
        yc_ = np.array([prof_y(i, l) + min(1.0, abs(a) / ds_m) * (prof_y((i + (1 if a >= 0 else -1)) % n, l) - prof_y(i, l))
                        for i, l, a in zip(ic, latc, alongc)])
        Tk = Tk[(ec > -KERB_EDGE_IN_M) & (ec < 3.0) & (np.abs(c[:, 1] - yc_) < 0.6)]
        if edge_blend_m is not None:
            # halve the longest edge until every edge is under 1.5 m: a scan's kerb triangle can run 10 m along a
            # curb, too long to follow the ground under it
            for _ in range(8):
                e = np.stack([np.linalg.norm(Tk[:, a, [0, 2]] - Tk[:, b, [0, 2]], axis=1) for a, b in ((0, 1), (1, 2), (2, 0))], 1)
                big = e.max(1) > 1.5
                if not big.any():
                    break
                Tb, k = Tk[big], e[big].argmax(1)
                a_, b_, c_ = [Tb[np.arange(len(Tb)), (k + j) % 3] for j in range(3)]
                m_ = (a_ + b_) / 2
                Tk = np.concatenate([Tk[~big], np.stack([a_, m_, c_], 1), np.stack([m_, b_, c_], 1)])
        V = Tk.reshape(-1, 3)
        _, iv = tree.query(V[:, [0, 2]])
        rel = V[:, [0, 2]] - xz[iv]
        lat = np.einsum('ij,ij->i', rel, rgt[iv])
        along = np.einsum('ij,ij->i', rel, tan[iv])
        P = V.copy()
        if edge_blend_m is not None:
            # heights set once the surfaces around it exist (seat_kerbs): the kerb lies on them, not on the scan's
            # kerb triangles (modelled a few cm proud of the ground, a step the wheels hit like a wall)
            def y_at(i, l):
                return prof_y(i, l) if abs(l) <= hw[i] else plane_out(i, l)
            P[:, 1] = [y_at(i, l) + min(1.0, abs(a) / ds_m) * (y_at((i + (1 if a >= 0 else -1)) % n, l) - y_at(i, l))
                       for i, l, a in zip(iv, lat, along)]
        else:
            z = np.interp(np.abs(lat) - hw[iv], KERB_PROFILE_L, KERB_PROFILE_Z, left=0.0, right=0.0)
            P[:, 1] = [prof_y(i, l) + min(1.0, abs(a) / ds_m) * (prof_y((i + (1 if a >= 0 else -1)) % n, l) - prof_y(i, l))
                       for i, l, a in zip(iv, lat, along)] + z
        L_m = ds_m * n
        u = ((iv * ds_m + along) % L_m).reshape(-1, 3)
        wrap = u.max(1) - u.min(1) > L_m / 2  # a triangle across the start line
        u[wrap] = np.where(u[wrap] < L_m / 2, u[wrap] + L_m, u[wrap])
        UV = np.stack([u.reshape(-1) / KERB_UV_M, np.full(len(P), 0.5)], 1)
        F = np.arange(len(P)).reshape(-1, 3)
        fn = np.cross(P[F[:, 1]] - P[F[:, 0]], P[F[:, 2]] - P[F[:, 0]])
        F[fn[:, 1] < 0] = F[fn[:, 1] < 0][:, ::-1]
        log(f'scan kerbs: {len(F)} kerb triangles of the scan used as the physics kerb')
        return P - off, F.reshape(-1).astype(np.uint32), UV

    def merge(parts):
        P, F, base = [], [], 0
        for p, f in parts:
            P.append(p)
            F.append(f + base)
            base += len(p)
        return np.concatenate(P), np.concatenate(F)

    hw = width / 2
    ds_m = float(np.mean(np.linalg.norm(np.roll(xz, -1, 0) - xz, axis=1)))

    def plane_out(i, lat):
        """The road's crossfall at the edge carried on past it"""
        side = 1.0 if lat > 0 else -1.0
        ye = prof_y(i, side * hw[i])
        return ye + (ye - prof_y(i, side * (hw[i] - 2.0))) / 2.0 * (abs(lat) - hw[i])
    out = []
    # road collider: 3 points across, road ± (half width + 1.6 m), on the smoothed profile itself. Scan heights,
    # even clamped to ±3 cm of it, alternate row to row at the 5 m spacing and read as a constant washboard at speed.
    # Where a barrier stands flush with the edge (an oval's outside wall) the collider's 1.6 m past the edge carries
    # the road's own crossfall on: the profile there is the scan's wall foot, which made the edge of the banking bumpy
    flush_side = {-1.0: wall[:, 0] - hw < 1.6, 1.0: wall[:, 1] - hw < 1.6}

    def prof_road(i, lat):
        side = 1.0 if lat > 0 else -1.0
        if abs(lat) <= hw[i] or not (flush_side[side][i] or edge_blend_m is not None):
            return prof_y(i, lat)
        return plane_out(i, lat)

    if edge_blend_m is None:
        out.append(('Track_Collider_Road', *strip(-hw - 1.6, hw + 1.6, 3, road_set, 0.8, True, (0.0, 0.0), prof_road), {'collider': 'road'}))
    else:
        # jointed at the road edges, where the surfaces past them start: one slope from the centre out to ±(hw + 1.6)
        # stood up to 7 cm off the road's edge on a banking
        out.append(('Track_Collider_Road', *merge([strip(-hw - 1.6, -hw, 2, road_set, 0.8, True, (0.0, 0.0), prof_road),
                                                   strip(-hw, hw, 3, road_set, 0.8, True, (0.0, 0.0), prof_road),
                                                   strip(hw, hw + 1.6, 2, road_set, 0.8, True, (0.0, 0.0), prof_road)]),
                    {'collider': 'road'}))
    road_surface = strip(-hw, hw, 7, road_set, 0.8, True, (0.0, 0.0))
    if road_twist_m:
        road_surface = subdivide_twisted_road(*road_surface, 7, float(road_twist_m))
    out.append(('Track_Surface_Road', *road_surface, {'surface': 'road', 'grip': 1.0}))
    kerb_w = 0.0 if scan_kerbs else KERB_PROFILE_L[-1]
    kl = np.where(kerbL, kerb_w, 0.0)
    kr = np.where(kerbR, kerb_w, 0.0)
    scan_kerb = scan_kerb_mesh() if scan_kerbs else None
    if scan_kerb is not None and len(scan_kerb[1]) and edge_blend_m is None:
        out.append(('Track_Surface_Kerb', *scan_kerb[:2], {'surface': 'kerb', 'uvScaleM': KERB_UV_M, '_uv': scan_kerb[2]}))
    for visual in (() if scan_kerbs else (False, True)):
        parts = [kerb_mesh(-1.0, kerbL, visual), kerb_mesh(1.0, kerbR, visual)]
        kP, kF = merge([(p, f) for p, f, _ in parts])
        kUV = np.concatenate([uv for _, _, uv in parts])
        if not len(kF):
            continue
        if visual:
            # what the driver sees: the physics kerb in red / white paint, over the scan's flat paint
            out.append(('Track_Kerbs_Visual', kP, kF, {'_uv': kUV, '_visible': True,
                                                       '_material': {'name': 'Kerb_Paint', 'png': kerb_texture_png(), 'roughness': 0.62}}))
        else:
            out.append(('Track_Surface_Kerb', kP, kF, {'surface': 'kerb', 'uvScaleM': KERB_UV_M, '_uv': kUV}))
    r0L, r0R = hw + kl, hw + kr
    rL, rR = r0L + np.maximum(0, run[:, 0] - kl), r0R + np.maximum(0, run[:, 1] - kr)
    # a barrier flush with the road (an oval's outside wall): nothing between the edge and the wall but the road
    # collider on the smoothed profile (the scan's wall foot made a narrow bumpy run-off there), and the grass
    # starts behind the wall
    flushL, flushR = wall[:, 0] - hw < 1.6, wall[:, 1] - hw < 1.6
    rL, rR = np.where(flushL, r0L, rL), np.where(flushR, r0R, rR)
    # 7 columns (like Grass below) so wide banked runoff (25+ m) steps every ~4 m instead of >13 m and stays inside the height window
    out.append(('Track_Surface_Runoff', *merge([strip(-rL, -r0L, 7, None, 2.0, False, blend=True), strip(r0R, rR, 7, None, 2.0, False, blend=True)]),
                {'surface': 'runoff'}))
    gL, gR = np.where(flushL, rL, rL + grav[:, 0]), np.where(flushR, rR, rR + grav[:, 1])
    out.append(('Track_Surface_Gravel', *merge([strip(-gL, -rL, 3, None, 1.5, False, blend=True), strip(rR, gR, 3, None, 1.5, False, blend=True)]),
                {'surface': 'gravel'}))
    # (1 m behind it: ground starting on the wall line, at the scan's wall-foot height, was a 10-17 cm invisible bump
    # under wheels running against the wall)
    gL, gR = np.where(flushL, np.maximum(gL, wall[:, 0] + 1.0), gL), np.where(flushR, np.maximum(gR, wall[:, 1] + 1.0), gR)
    wL, wR = np.maximum(gL, wall[:, 0]), np.maximum(gR, wall[:, 1])
    # Ground reaches well past the barriers (a car launched over one lands on something) except on the inside of
    # bends, where it stops short of the turning radius so it cannot fold over the far side of the corner
    ks = ndimage.gaussian_filter1d(curvature(xz, 2), 1.0, mode='wrap')
    reach = []
    for wv, sgn in ((wL, -1.0), (wR, 1.0)):
        k_in = ndimage.maximum_filter1d(np.clip(sgn * ks, 0, None), 17, mode='wrap')
        reach.append(np.minimum(wv + 12.0, np.maximum(wv + 2.0, 0.85 / np.maximum(k_in, 1e-6))))
    out.append(('Track_Surface_Grass', *merge([strip(-reach[0], -gL, 7, None, 2.0, False, blend=True), strip(gR, reach[1], 7, None, 2.0, False, blend=True)]),
                {'surface': 'grass'}))
    if surface_mats is not None:
        out = reclassify_offroad(out, soup, off, *surface_mats)
    if valid_runoff:
        out = apron_runoff(out, xz, rgt, off, ds_m, valid_runoff)
    if scan_kerb is not None and len(scan_kerb[1]) and edge_blend_m is not None:
        out.append(('Track_Surface_Kerb', seat_kerbs(scan_kerb[0], out), scan_kerb[1],
                    {'surface': 'kerb', 'uvScaleM': KERB_UV_M, '_uv': scan_kerb[2]}))

    # barriers: vertical quads at the wall line, split at jumps with a return panel along the normal
    for name, side, d in (('Track_Collider_Wall_Left', -1.0, wall[:, 0]), ('Track_Collider_Wall_Right', 1.0, wall[:, 1])):
        base = np.zeros(n)
        pts = np.zeros((n, 2))
        for i in range(n):
            q = xz[i] + rgt[i] * side * d[i]
            pts[i] = q
            pred = prof_y(i, side * d[i])
            h = soup.height_near(q[0], q[1], pred, 3.0)
            base[i] = h[0] if h is not None else pred
        V, F = [], []

        def quad(p0, y0, p1, y1):
            k = len(V)
            # base 1 m below the ground; 3 m tall like a barrier with catch fencing, so a launched car is still caught
            V.extend([(p0[0], y0 - 1.0, p0[1]), (p0[0], y0 + 3.0, p0[1]), (p1[0], y1 - 1.0, p1[1]), (p1[0], y1 + 3.0, p1[1])])
            F.extend([k, k + 2, k + 1, k + 1, k + 2, k + 3])

        for i in range(n):
            i1 = (i + 1) % n
            if wall_open is not None and (wall_open[i, 0 if side < 0 else 1] or wall_open[i1, 0 if side < 0 else 1]):
                continue
            if abs(d[i1] - d[i]) <= 3.0:
                quad(pts[i], base[i], pts[i1], base[i1])
            else:
                # the barrier steps in or out: close the gap across the normal at sample i and continue to sample i1
                q1 = xz[i] + rgt[i] * side * d[i1]
                quad(pts[i], base[i], q1, base[i1])
                quad(q1, base[i1], pts[i1], base[i1])
        out.append((name, np.array(V) - off, np.array(F, np.uint32), {'collider': 'wall'}))
        if closure is not None and closure[:, 0 if side < 0 else 1].any():
            out.append(closure_barrier(xz, rgt, side, d, base, closure[:, 0 if side < 0 else 1], off,
                                       'Track_Barrier_Closure_' + ('Left' if side < 0 else 'Right')))
    return out


def barrier_texture_png():
    """Red / white plastic barrier blocks, one u = 2 m: a 1 m red and a 1 m white block with dark joints"""
    from PIL import Image
    import io
    w, h = 256, 64
    u = (np.arange(w) + 0.5) / w * 2.0
    red = (np.floor(u) % 2 == 0)[None, :].repeat(h, 0)
    img = np.where(red[..., None], np.array([200, 30, 28], float), np.array([236, 236, 232], float))
    v = (np.arange(h) + 0.5) / h
    img *= (0.85 + 0.15 * np.clip(v / 0.3, 0, 1))[:, None, None]
    img[:, np.abs(u - np.round(u)) < 0.02] *= 0.45
    buf = io.BytesIO()
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(buf, 'PNG')
    return buf.getvalue()


def closure_barrier(xz, rgt, side, d, base, mask, off, name):
    """A 0.9 m high, 0.6 m deep row of barrier blocks whose road face is the wall collider at `d`, over `mask`"""
    V, F, UV = [], [], []
    n = len(xz)
    s = 0.0
    for i in range(n):
        i1 = (i + 1) % n
        if not (mask[i] and mask[i1]):
            continue
        p0, p1 = xz[i] + rgt[i] * side * d[i], xz[i1] + rgt[i1] * side * d[i1]
        b0, b1 = xz[i] + rgt[i] * side * (d[i] + 0.6), xz[i1] + rgt[i1] * side * (d[i1] + 0.6)
        seg = float(np.linalg.norm(p1 - p0))
        u0, u1 = s / 2.0, (s + seg) / 2.0
        s += seg
        y0, y1 = base[i], base[i1]
        k = len(V)
        # road face, top, back face (both windings: the generated material is single-sided)
        V.extend([(p0[0], y0 - 0.1, p0[1]), (p0[0], y0 + 0.9, p0[1]), (p1[0], y1 - 0.1, p1[1]), (p1[0], y1 + 0.9, p1[1]),
                  (b0[0], y0 + 0.9, b0[1]), (b1[0], y1 + 0.9, b1[1]), (b0[0], y0 - 0.1, b0[1]), (b1[0], y1 - 0.1, b1[1])])
        UV.extend([(u0, 1.0), (u0, 0.0), (u1, 1.0), (u1, 0.0), (u0, 0.0), (u1, 0.0), (u0, 1.0), (u1, 1.0)])
        for a, b_, c in ((0, 2, 1), (1, 2, 3), (1, 3, 4), (4, 3, 5), (4, 5, 6), (6, 5, 7)):
            F.extend([k + a, k + b_, k + c, k + a, k + c, k + b_])
    V = np.array(V, float).reshape(-1, 3)
    return (name, V - off, np.array(F, np.uint32), {'_uv': np.array(UV, float).reshape(-1, 2), '_visible': True,
            '_material': {'name': 'Barrier_Blocks', 'png': barrier_texture_png(), 'roughness': 0.55}})


def auto_road_mats(T, M, C, xz, known, excluded):
    """Paved materials (grey by texture colour) with at least 30% of their area within 4 m of the line."""
    from scipy.spatial import cKDTree
    nrm = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
    area2 = np.linalg.norm(nrm, axis=1)
    flat = np.abs(nrm[:, 1]) > 0.6 * np.maximum(area2, 1e-9)
    cen = T.mean(1)[:, [0, 2]]
    dist, _ = cKDTree(xz).query(cen, distance_upper_bound=25.0)
    near = flat & np.isfinite(dist)
    out = set()
    for m in np.unique(M[near]):
        m = int(m)
        if m in known or m in excluded:
            continue
        sel = near & (M == m)
        a = area2[sel] * 0.5
        core = a[dist[sel] < 4.0].sum()
        if core < 150.0 or core < 0.3 * a.sum():
            continue
        col = (C[sel] * a[:, None]).sum(0) / a.sum()
        if srf.classify_colour(col) == 'paved':
            out.add(m)
    return out


def detect_kerb_mats(T, M, C, xz, width):
    """Materials whose triangles along the road edges are a red / white stripe mix."""
    from scipy.spatial import cKDTree
    cen = T.mean(1)[:, [0, 2]]
    dist, idx = cKDTree(xz).query(cen, distance_upper_bound=40.0)
    ok = np.isfinite(dist)
    edge = np.full(len(T), 99.0)
    edge[ok] = dist[ok] - width[idx[ok]] / 2
    band = (edge > -2.5) & (edge < 3.5)
    out = set()
    for m in np.unique(M[band]):
        c = C[band & (M == m)]
        if len(c) < 40:
            continue
        red = np.mean([srf.classify_colour(q) == 'kerb' for q in c])
        white = np.mean(c.min(1) > 170)
        if red > 0.12 and white > 0.08:
            out.add(int(m))
    return out


def update_index(tid, cfg, data):
    """public/tracks/index.json: the circuit list the title menu offers."""
    path = os.path.join(ROOT, 'public', 'tracks', 'index.json')
    idx = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else []
    m = data['metadata']
    entry = {'id': tid, 'name': cfg['name'], 'layout': cfg['layout'], 'country': cfg['country'], 'city': cfg['city'],
             'lengthM': m['lengthMeters'], 'turns': len(data['turns']), 'direction': m['direction'],
             'dataUrl': f'/tracks/{tid}/track_data.json', 'credit': m['credit'], 'quality': 'sketchfab'}
    # `unlisted`: built but not offered (e.g. one material covers the circuit, the other roads, pit lane and
    # paddock, so the traced route is not yet the real layout)
    idx = [e for e in idx if e['id'] != tid] + ([] if cfg.get('unlisted') else [entry])
    order = list(json.load(open(os.path.join(HERE, 'tracks.json'), encoding='utf-8')).keys())
    idx.sort(key=lambda e: order.index(e['id']) if e['id'] in order else 99)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(idx, f, indent=2, ensure_ascii=False)
        f.write(chr(10))


def wall_raster(R, T, M, max_ny=0.3):
    """Vertical geometry (barriers, walls, fences, buildings) as a 2D mask with per-cell height range. `max_ny`
    (`wallMaxNy`): walls standing square to a steep banking lean out with it (31 degrees: |ny| ≈ 0.52)."""
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
    ln = np.linalg.norm(n, axis=1)
    vert = (ln > 1e-9) & (np.abs(n[:, 1]) < max_ny * np.maximum(ln, 1e-9))
    V = T[vert]
    ymin_t = V[:, :, 1].min(1)
    ymax_t = V[:, :, 1].max(1)
    tall = (ymax_t - ymin_t) > 0.35
    V, ymin_t, ymax_t = V[tall], ymin_t[tall], ymax_t[tall]
    # longest XZ edge of each triangle, sampled every 0.25 m
    e = [(0, 1), (1, 2), (0, 2)]
    lens = np.stack([np.linalg.norm(V[:, a, [0, 2]] - V[:, b, [0, 2]], axis=1) for a, b in e], 1)
    which = lens.argmax(1)
    A = V[np.arange(len(V)), [e[w][0] for w in which]][:, [0, 2]]
    B = V[np.arange(len(V)), [e[w][1] for w in which]][:, [0, 2]]
    L = lens.max(1)
    keep = L > 0.05
    A, B, L, ymin_t, ymax_t = A[keep], B[keep], L[keep], ymin_t[keep], ymax_t[keep]
    cnt = np.minimum(400, np.ceil(L / 0.25).astype(int) + 1)
    ids = np.repeat(np.arange(len(A)), cnt)
    start = np.repeat(np.cumsum(cnt) - cnt, cnt)
    t = (np.arange(len(ids)) - start) / np.maximum(1, cnt[ids] - 1)
    P = A[ids] + (B[ids] - A[ids]) * t[:, None]
    q = np.round(R.to_px(P)).astype(np.int64)
    ok = (q[:, 0] >= 0) & (q[:, 1] >= 0) & (q[:, 0] < R.W) & (q[:, 1] < R.H)
    q, ids = q[ok], ids[ok]
    flat = q[:, 1] * R.W + q[:, 0]
    ymin = np.full(R.W * R.H, np.inf)
    ymax = np.full(R.W * R.H, -np.inf)
    np.minimum.at(ymin, flat, ymin_t[ids])
    np.maximum.at(ymax, flat, ymax_t[ids])
    mask = np.isfinite(ymin).reshape(R.H, R.W)
    # drop small isolated bits (tree billboards, signs, posts): keep components longer than ~12 m
    lab, nl = ndimage.label(cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8)), structure=np.ones((3, 3)))
    if nl:
        objs = ndimage.find_objects(lab)
        big = np.zeros(nl + 1, bool)
        for k, sl in enumerate(objs):
            if sl is None:
                continue
            ext = max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) * R.res
            big[k + 1] = ext > 12.0
        mask = mask & big[lab]
    return {'mask': mask, 'ymin': ymin.reshape(R.H, R.W), 'ymax': ymax.reshape(R.H, R.W)}


def debug_edges(R, road, trace, xz, rgt, width, wall, run, grav, kerbL, kerbR, walls, path):
    img = np.zeros((R.H, R.W, 3), np.uint8)
    img[road > 0] = (80, 80, 80)
    img[walls['mask']] = (0, 0, 160)
    for si, side in enumerate((-1, 1)):
        hw = width / 2
        for arr, col in ((hw, (0, 200, 255)), (hw + run[:, si], (200, 200, 0)), (hw + run[:, si] + grav[:, si], (0, 140, 255)), (wall[:, si], (255, 0, 255))):
            e = np.round(R.to_px(xz + side * rgt * arr[:, None])).astype(np.int32)
            cv2.polylines(img, [e], True, col, 1)
        kb = kerbL if si == 0 else kerbR
        for i in np.nonzero(kb)[0]:
            p = np.round(R.to_px(xz[i] + side * rgt[i] * (width[i] / 2 + 0.8))).astype(int)
            cv2.circle(img, tuple(p), 1, (0, 0, 255), -1)
    cv2.imwrite(path, img)


def assemble_track_json(tid, cfg, P, width, bank, yprof, kerbL, kerbR, run, grav, wall, L, scale):
    n = len(P)
    ds = L / n
    xz = P[:, [0, 2]]
    tan2 = cl.tangents(xz)
    rgt2 = cl.rights(tan2)
    t3 = np.roll(P, -1, 0) - np.roll(P, 1, 0)
    t3 /= np.linalg.norm(t3, axis=1, keepdims=True)
    s = np.arange(n) * ds
    k = ndimage.gaussian_filter1d(curvature(xz, 3), 1.5, mode='wrap')

    # ---- racing line: curvature-minimising elastic band inside the usable width ----
    ro = racing_line(xz, width, kerbL, kerbR, margin=cfg.get('lineMarginM', 1.25))

    # ---- corners ----
    turns, turn_of = detect_turns(s, k, P, bank, L, cfg.get('turnMergeGapM', 35.0), cfg.get('notTurnsAtM', []),
                                  cfg.get('turnSplitAtM', []))
    # ---- sectors / DRS ----
    sec_bounds = [0.0, L / 3, 2 * L / 3, L]
    sec_of = np.minimum(2, (s / (L / 3)).astype(int)) + 1
    drs = drs_zones(s, k, L)

    # quick planning speed estimate (runtime recomputes the real profile)
    vlim = np.minimum(330.0, np.sqrt(np.maximum(1e-6, 3.2 * 9.81 / np.maximum(np.abs(k), 1e-4))) * 3.6)

    samples = []
    for i in range(n):
        e = ro[i]
        rp = P[i] + np.array([rgt2[i, 0] * e, -math.tan(bank[i]) * e, rgt2[i, 1] * e])
        samples.append({
            's': round(float(s[i]), 3),
            'p': [round(float(v), 3) for v in P[i]],
            'r': [round(float(v), 3) for v in rp],
            't': [round(float(v), 5) for v in t3[i]],
            'yProf': [round(float(v), 3) for v in yprof[i]],
            'ro': round(float(e), 3),
            'w': round(float(width[i]), 2),
            'b': round(float(bank[i]), 4),
            'g': 1,
            'v': round(float(vlim[i]), 1),
            'gas': 1,
            'brk': 0,
            'sec': int(sec_of[i]),
            'turn': int(turn_of[i]),
            'zone': 'main_straight',
            'kL': int(kerbL[i]),
            'kR': int(kerbR[i]),
            'rL': round(float(run[i, 0]), 2),
            'rR': round(float(run[i, 1]), 2),
            'gL': round(float(grav[i, 0]), 2),
            'gR': round(float(grav[i, 1]), 2),
            'wL': round(float(wall[i, 0]), 2),
            'wR': round(float(wall[i, 1]), 2),
        })

    def gate(i):
        hw = width[i] / 2
        lp = P[i] + np.array([-rgt2[i, 0] * hw, math.sin(bank[i]) * hw, -rgt2[i, 1] * hw])
        rp = P[i] + np.array([rgt2[i, 0] * hw, -math.sin(bank[i]) * hw, rgt2[i, 1] * hw])
        return {'s': round(float(s[i]), 2), 'left': [round(float(v), 3) for v in lp], 'right': [round(float(v), 3) for v in rp],
                'normal': [round(float(v), 5) for v in t3[i]]}

    checkpoints = []
    for c in range(22):
        g = gate(int(round(c * n / 22)) % n)
        g['id'] = c
        checkpoints.append(g)
    sectors = [{'id': q + 1, 'startS': round(sec_bounds[q], 2), 'endS': round(sec_bounds[q + 1], 2),
                'gate': gate(int(round(sec_bounds[q] / ds)) % n)} for q in range(3)]

    # ---- grid: 20 slots behind the line, 8 m apart, staggered ±3.4 m ----
    spawn = []
    for slot in range(1, 21):
        ss = L - 11.6 - 8.0 * (slot - 1)
        lat = 3.4 if slot % 2 == 1 else -3.4
        x = ss / ds
        i0 = int(math.floor(x)) % n
        i1 = (i0 + 1) % n
        a = x - math.floor(x)
        c = P[i0] * (1 - a) + P[i1] * a
        rg = rgt2[i0] * (1 - a) + rgt2[i1] * a
        rg /= np.linalg.norm(rg)
        fw = t3[i0] * (1 - a) + t3[i1] * a
        fw /= np.linalg.norm(fw)
        bk = bank[i0] * (1 - a) + bank[i1] * a
        pos = c + np.array([rg[0] * lat, -math.sin(bk) * lat + 0.11, rg[1] * lat])
        spawn.append({'slot': slot, 's': round(ss, 2), 'lateral': lat, 'position': [round(float(v), 3) for v in pos],
                      'yawRad': round(math.atan2(fw[0], fw[2]), 4), 'forward': [round(float(v), 5) for v in fw]})

    # ---- TV cameras: 12 trackside positions on the roomier side ----
    cams = []
    for c in range(12):
        i = int(round((c + 0.5) * n / 12)) % n
        side = 1.0 if wall[i, 1] >= wall[i, 0] else -1.0
        off = min(wall[i, 1 if side > 0 else 0] + 4.0, width[i] / 2 + 25.0)
        p = P[i] + np.array([rgt2[i, 0] * side * off, 9.0, rgt2[i, 1] * side * off])
        look = P[(i + 6) % n]
        f = look - p
        f /= np.linalg.norm(f)
        cams.append({'name': f'TV {c + 1}', 'position': [round(float(v), 3) for v in p], 'forward': [round(float(v), 5) for v in f],
                     'up': [0, 1, 0], 'minFov': 12, 'maxFov': 48, 'inPoint': round(c / 12, 4), 'outPoint': round((c + 1) / 12, 4)})

    bspace = 10.0
    bi = [int(round(q)) % n for q in np.arange(0, n, bspace / ds)]

    def edgept(i, side, d):
        return [round(float(P[i, 0] + rgt2[i, 0] * side * d), 2), round(float(P[i, 1] - side * math.sin(bank[i]) * d), 2),
                round(float(P[i, 2] + rgt2[i, 1] * side * d), 2)]

    boundaries = {
        'spacingM': round(bi[1] * ds if len(bi) > 1 else bspace, 3),
        'left': [edgept(i, -1, width[i] / 2) for i in bi],
        'right': [edgept(i, 1, width[i] / 2) for i in bi],
        'wallLeft': [edgept(i, -1, wall[i, 0]) for i in bi],
        'wallRight': [edgept(i, 1, wall[i, 1]) for i in bi],
    }

    area = 0.5 * np.sum(xz[:, 0] * np.roll(xz[:, 1], -1) - np.roll(xz[:, 0], -1) * xz[:, 1])
    # x right / z down seen from above: positive shoelace area = clockwise
    direction = 'clockwise' if area > 0 else 'anticlockwise'
    cr = cfg['credit']
    meta = {
        'id': tid,
        'name': f"{cfg['name']} — {cfg['layout']}",
        'shortName': cfg['name'],
        'description': cfg.get('description', f"{cfg['name']}, {cfg['layout']} ({L / 1000:.3f} km), converted from a Sketchfab scan of the circuit."),
        'country': cfg['country'],
        'city': cfg['city'],
        'lengthMeters': round(float(L), 2),
        'widthMeters': f'{np.percentile(width, 10):.0f}m-{np.percentile(width, 90):.0f}m',
        'pitboxes': 20,
        'direction': direction,
        'author': f"{cr['author']} (Sketchfab), CC BY 4.0",
        'originOffset': [0, 0, 0],
        'modelScale': round(float(scale), 5),
        'baseAltitudeM': cfg.get('baseAltitudeM', 0),
        'latProfileOffsets': LAT,
        'sampleSpacingM': round(float(ds), 4),
        'elevationRangeM': [round(float(P[:, 1].min()), 1), round(float(P[:, 1].max()), 1)],
        'surfaces': {'roadGrip': 1, 'tarmacGrip': 0.75, 'kerbGrip': 0.96},
        # `surfaceTable`: per-kind overrides of the surface physics (src/lib/sim/track-surfaces.ts)
        **({'surfaceTable': cfg['surfaceTable']} if cfg.get('surfaceTable') else {}),
        'mesh': {'url': f'/tracks/{tid}/{tid}.glb', 'colliders': ['Track_Collider_Road', 'Track_Collider_Wall_Left', 'Track_Collider_Wall_Right']},
        'credit': {'title': cr['title'], 'author': cr['author'], 'url': cr['url'], 'short': cr.get('short'), 'license': 'CC BY 4.0',
                   'licenseUrl': 'http://creativecommons.org/licenses/by/4.0/'},
        'racingLine': {'method': 'curvature-minimising elastic band (pipeline default)'},
    }
    return {
        'metadata': meta,
        'drsZones': drs,
        'cameras': cams,
        'turns': turns,
        'sectors': sectors,
        'checkpoints': checkpoints,
        'spawnGrid': spawn,
        'pitLane': {'entryS': round(float(L - 300), 1), 'exitS': 250, 'widthM': 12, 'centerline': []},
        'boundaries': boundaries,
        'samples': samples,
    }


def racing_line(xz, width, kerbL, kerbR, iters=3000, margin=1.25):
    """Lateral offset (m, + right) of a smooth minimum-curvature line inside the road (kerbs usable), the car's centre
    `margin` m inside the edge (`lineMarginM`: more on a narrow road lined with barriers, a hill climb's)"""
    n = len(xz)
    rgt = cl.rights(cl.tangents(xz))
    lo = -(width / 2 - np.where(ndimage.binary_dilation(kerbL, np.ones(5)), 0.7, margin))
    hi = (width / 2 - np.where(ndimage.binary_dilation(kerbR, np.ones(5)), 0.7, margin))
    e = np.zeros(n)
    for _ in range(iters):
        p = xz + rgt * e[:, None]
        # move each point towards the midpoint of its ±3 neighbours (reduces curvature), projected on the normal
        mid = 0.5 * (np.roll(p, 3, 0) + np.roll(p, -3, 0))
        de = ((mid - p) * rgt).sum(1)
        e = np.clip(e + 0.5 * de, lo, hi)
    return ndimage.gaussian_filter1d(e, 1.0, mode='wrap')


def detect_turns(s, k, P, bank, L, merge_gap_m=35.0, not_turns_at=(), split_at=()):
    """Turns: bends of one sign at least 18 degrees, joined across straights shorter than merge_gap_m. `not_turns_at`
    (`notTurnsAtM`, m along the lap): bends the circuit does not number (a flat kink where the pit exit merges),
    left out so the rest keep their official numbers. `split_at` (`turnSplitAtM`, m along the lap): where one bend
    of a single sign holds two numbered corners (a kink running straight into a hairpin)"""
    n = len(s)
    ds = L / n
    thr = 1.0 / 320.0
    on = np.abs(k) > thr
    # merge short gaps of the same sign, then build segments
    segs = []
    i = 0
    # start scanning at a straight so no segment wraps
    start = int(np.argmin(np.abs(k)))
    order = [(start + q) % n for q in range(n)]
    cur = None
    for q in order:
        if on[q]:
            sg = np.sign(k[q])
            if cur is not None and cur['sign'] == sg and (cur['gap'] * ds) < merge_gap_m:
                cur['idx'].append(q)
                cur['gap'] = 0
            else:
                if cur is not None:
                    segs.append(cur)
                cur = {'sign': sg, 'idx': [q], 'gap': 0}
        elif cur is not None:
            cur['gap'] += 1
            if cur['gap'] * ds >= merge_gap_m:
                segs.append(cur)
                cur = None
    if cur is not None:
        segs.append(cur)
    for sa in split_at:
        for si_, sgm in enumerate(segs):
            idx = np.array(sgm['idx'])
            cut = np.searchsorted(s[idx], sa) if np.all(np.diff(s[idx]) > 0) else 0
            if 0 < cut < len(idx):
                segs[si_:si_ + 1] = [{'sign': sgm['sign'], 'idx': list(idx[:cut]), 'gap': 0},
                                     {'sign': sgm['sign'], 'idx': list(idx[cut:]), 'gap': 0}]
                break
    turns = []
    for sgm in segs:
        idx = np.array(sgm['idx'])
        ang = abs(float(np.sum(k[idx]) * ds))
        if math.degrees(ang) < 18:
            continue
        apex = idx[np.argmax(np.abs(k[idx]))]
        if any(abs(s[apex] - a) < 40.0 for a in not_turns_at):
            continue
        radius = 1.0 / max(1e-4, abs(k[apex]))
        turns.append({'idx': idx, 'apex': int(apex), 'ang': ang, 'r': radius, 'sign': sgm['sign']})
    turns.sort(key=lambda t: s[t['apex']])
    turn_of = np.zeros(n, int)
    out = []
    for num, t in enumerate(turns, 1):
        v = min(330.0, math.sqrt(3.2 * 9.81 * t['r']) * 3.6)
        gear = int(np.clip(round(1 + v / 42), 2, 8))
        d = 'right' if t['sign'] > 0 else 'left'
        lo_i, hi_i = t['idx'].min(), t['idx'].max()
        for q in t['idx']:
            turn_of[q] = num
        sa = float(s[t['apex']])
        out.append({
            'number': num, 'name': f'Turn {num}', 'complexName': f'Turn {num}',
            'sector': int(min(3, sa // (L / 3) + 1)), 'elevationM': round(float(P[t['apex'], 1]), 1),
            'bankingDeg': round(math.degrees(float(bank[t['apex']])), 1), 'apexSpeedKmh': int(round(v)), 'gear': gear,
            'direction': d, 'radiusM': int(round(t['r'])), 'angleDeg': int(round(math.degrees(t['ang']))),
            'description': f"{'Right' if d == 'right' else 'Left'}-hander, {math.degrees(t['ang']):.0f}° at R≈{t['r']:.0f} m.",
            'sApprox': int(round(sa)),
        })
    return out, turn_of


def drs_zones(s, k, L):
    n = len(s)
    ds = L / n
    # flat-out kinks (R > ~400 m) belong to the straight
    straight = np.abs(ndimage.gaussian_filter1d(k, 2.0, mode='wrap')) < 1.0 / 400.0
    straight = ndimage.binary_opening(straight, np.ones(3))
    runs = []
    start = int(np.argmax(~straight))
    q = 0
    while q < n:
        i = (start + q) % n
        if straight[i]:
            j0 = q
            while q < n and straight[(start + q) % n]:
                q += 1
            runs.append(((start + j0) % n, q - j0))
        else:
            q += 1
    runs.sort(key=lambda r: -r[1])
    zones = []
    for zi, (i0, cnt) in enumerate(runs[:3]):
        length = cnt * ds
        if length < 450:
            continue
        st = (s[i0] + 60.0) % L
        en = (s[i0] + length - 90.0) % L
        det = (st - 160.0) % L
        zones.append({'id': f'ZONE_{zi}', 'detection': round(det / L, 4), 'start': round(st / L, 4), 'end': round(en / L, 4)})
    return zones


if __name__ == '__main__':
    main()
