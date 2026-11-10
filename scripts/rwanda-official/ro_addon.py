"""
The road sections of the official Rwanda layout that are not on the built lap: the outer line of Turn 1, the outer
hairpin of Turn 8 and the link that cuts the north-east loop short (src/alt.npz, my fit of the published render).
Each is a short open strip joined to the built lap at both ends. Where it runs on or beside the built road it takes
that road's own cross-section, so the junction is one surface; its own profile and banking take over once the two
roads are apart.

    build(T, ground)  ->  data/addons.npz  (baked mesh grids, footprint rasters) and what the built lap has to give way to

Pure numpy / scipy: runs in the prep venv. Blender (bl_addon.py) and export_json.py only read the baked file.
"""
import os

import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt, gaussian_filter1d
from scipy.spatial import cKDTree

import ro_design as rd
from ro_foot import Foot, NAMES, SINK

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
DATA = os.path.join(HERE, 'data')
E0, N0 = -86.0, 391.0

# side: which side of the built lap it lies on (+1 right, -1 left); hug: how strongly its profile keeps to the built
# ground while it runs through the built lap's run-off (the link climbs straight through instead); runoff: painted run-off outside its tightest corner (m); layout: the lap
# that uses it
SPEC = {
    't1o': dict(side=1, runoff=10.0, hug=1.0, layout='long'),
    't8o': dict(side=-1, runoff=23.0, hug=1.0, layout='long'),
    'link': dict(side=-1, runoff=12.0, hug=0.0, inner_wall=True, layout='short'),
}
assert NAMES == tuple(SPEC)
ROAD_F = np.linspace(-1, 1, 13)       # close columns: where it blends into the built road the surface curves across
DK = np.array([0.0, 0.25, 0.7, 1.15, 1.5])
HK = np.array([0.0, 0.018, 0.032, 0.026, 0.0])
PCOLS = np.array([0.0, 1.5, 3.5, 7.0, 12.0, 20.0, 30.0])
NOSE_CLEAR_M = 2.5        # no barrier nearer an add-on's road than this (where it closes on the built road, the nose stops short)
UNDER = 0.008             # how far below the built road an add-on's asphalt lies where the two overlap (its lines and kerbs: deeper)
BED = 0.30                # the terrain lies this far under an add-on
PPM = 2.0                 # footprint rasters, pixels per metre
WARP_R = 25.0             # the built lap's ground meets an add-on's edge over this distance
PULL_R = 3.0              # ... and within this distance of it, ground still standing above the edge is taken down to it
LAT = np.array([-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12.0])


def sstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def g1(a, sig):
    return gaussian_filter1d(np.asarray(a, float), sig, mode='nearest')


def cross(tb, hinge, lat):
    """Design.cross_z for a section of its own: tb = tan(bank), the banked plane runs to `hinge` from the centre"""
    tr = np.tan(rd.RUNOFF_BANK_MAX * np.tanh(np.arctan(tb) / rd.RUNOFF_BANK_MAX))
    u = np.maximum(0.0, np.abs(lat) - hinge)
    ramp = u - 4.0 * (1 - np.exp(-u / 4.0))
    return -tb * lat + (tb - tr) * np.sign(lat) * ramp


def on_paint(q):
    """Which points lie on the built lap's painted run-off (or its road)"""
    return q['d'] - q['hws'] <= q['pw'] + 0.3


def runs(m):
    """(start, end) of every run of True in a 1-D mask, end exclusive"""
    d = np.diff(np.r_[0, m.astype(int), 0])
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def inside_dist(m):
    """Stations from each True one to the nearest False (the ends count as False)"""
    n = len(m)
    d = np.where(m, 1e9, 0.0)
    d[0] = min(d[0], 1.0)
    d[-1] = min(d[-1], 1.0)
    for i in range(1, n):
        d[i] = min(d[i], d[i - 1] + 1)
    for i in range(n - 2, -1, -1):
        d[i] = min(d[i], d[i + 1] + 1)
    return d


class Spine:
    """The built lap around one add-on: the nearest station, lateral offset and section height of any point"""

    def __init__(self, T, sa, sb):
        self.T = T
        self.win = rd.wrap_range(sa - 80, sb + 80, T.n)
        self.tree = cKDTree(np.c_[T.x[self.win], T.y[self.win]])
        self.grade = np.gradient(np.r_[T.z[-1], T.z, T.z[0]])[1:-1]

    def at(self, P):
        T = self.T
        P = np.asarray(P, float)
        sh = P.shape[:-1]
        Q = P.reshape(-1, 2)
        d, k = self.tree.query(Q)
        i = self.win[k]
        dx, dy = Q[:, 0] - T.x[i], Q[:, 1] - T.y[i]
        lat = dx * T.rx[i] + dy * T.ry[i]
        ds = dx * T.tx[i] + dy * T.ty[i]
        z = T.z[i] + self.grade[i] * ds + T.cross_z(i, lat)
        side = (lat > 0).astype(int)
        cor = np.where(side == 1, T.corridor(1)[i], T.corridor(0)[i])
        zg = np.where(side == 1, T.ground_z(i, 1, np.abs(lat)), T.ground_z(i, 0, np.abs(lat))) + self.grade[i] * ds
        wl = np.where(side == 1, T.wall_offset(1)[i], T.wall_offset(0)[i])
        pw = np.where(side == 1, T.pw[1][i], T.pw[0][i])
        pu = np.where(side == 1, T.pu0[1][i], T.pu0[0][i])
        return dict(i=i.reshape(sh), ls=lat.reshape(sh), zs=z.reshape(sh), d=d.reshape(sh), hws=(T.width[i] / 2).reshape(sh),
                    cor=cor.reshape(sh), zg=zg.reshape(sh), wl=wl.reshape(sh), pw=pw.reshape(sh), pu=pu.reshape(sh),
                    sf=(i + ds).reshape(sh))


class Addon:
    def __init__(self, T, name, A, ground, speed):
        sp = SPEC[name]
        self.name, self.T = name, T
        sa, sb = int(A[name + '_sa']), int(A[name + '_sb'])
        X, Y = A[name + '_x'] - E0, A[name + '_y'] - N0
        c = np.r_[0, np.cumsum(np.hypot(np.diff(X), np.diff(Y)))]
        L = float(c[-1])
        nj = int(round(L / 2.0)) * 2 + 1                # an even number of ~1 m steps: 2 m mesh rows end on the last
        s = np.linspace(0, L, nj)
        h = L / (nj - 1)
        x, y = np.interp(s, c, X), np.interp(s, c, Y)
        tx, ty = np.gradient(x, h), np.gradient(y, h)
        ln = np.hypot(tx, ty)
        tx, ty = tx / ln, ty / ln
        th = np.unwrap(np.arctan2(ty, tx))
        kap = g1(np.gradient(th, h), 2.0)
        self.sa, self.sb, self.L, self.n, self.h, self.s = sa, sb, L, nj, h, s
        self.x, self.y, self.tx, self.ty, self.rx, self.ry, self.kap = x, y, tx, ty, ty, -tx, kap
        self.spine = Spine(T, sa, sb)
        q0 = self.spine.at(np.c_[x, y])
        i0, zs0, d0 = q0['i'], q0['zs'], q0['d']
        self.i0 = i0
        hw = np.interp(s, [0, L], [T.width[sa] / 2, T.width[sb] / 2])
        gap = d0 - T.width[i0] / 2 - hw                 # between the two roads' edges (< 0 where they overlap)
        self.hw, self.gap = hw, gap
        self.w = self.blend(d0 - T.width[i0] / 2)
        self.v = speed(x, y)

        # ---- its own profile: the built lap's height and grade at both ends; between them the smoothest line that
        # stays on the built ground while the section is inside the built corridor, and near the natural ground beyond ----
        za, zb, ga, gb = T.z[sa], T.z[sb], self.spine.grade[sa], self.spine.grade[sb]
        gz = ground(x, y)
        ws = sp['hug'] * (1 - sstep((d0 - q0['wl'] - 5.0) / 20.0))
        hard = d0 - T.width[i0] / 2 < 1.0                    # its centre on the built road: exactly that road's section
        ws = np.where(hard, 1e12, ws)
        wg = 0.03
        tgt = (ws * zs0 + wg * gz) / (ws + wg)
        D2 = np.zeros((nj - 2, nj))
        r = np.arange(nj - 2)
        D2[r, r], D2[r, r + 1], D2[r, r + 2] = 1.0, -2.0, 1.0
        fixed = np.array([0, 1, nj - 2, nj - 1])
        zf = zs0[fixed]                                       # the built road's own heights at both ends
        free = np.setdiff1d(np.arange(nj), fixed)
        own = g1((~hard).astype(float), 6.0) > 0.01           # where the profile is its own to shape

        def solve(lam):
            M = lam / h ** 4 * D2.T @ D2 + np.diag(ws + wg)
            rhs = (ws + wg) * tgt - M[:, fixed] @ zf
            z = np.zeros(nj)
            z[fixed] = zf
            z[free] = np.linalg.solve(M[np.ix_(free, free)], rhs[free])
            return z, self.v ** 2 * g1(np.gradient(np.gradient(z, h), h), 3.0)

        _, a_st = solve(1e9)
        blk = rd.wrap_range(sa, sb, T.n)                      # no worse than the built lap is over the same stretch
        a_sp = T.v[blk] ** 2 * g1(np.gradient(np.gradient(T.z[blk])), 3.0)
        if not own.any():
            own[:] = True
        lo, hi = min(-3.2, 1.1 * a_st[own].min(), a_sp.min()), max(5.5, 1.1 * a_st[own].max(), a_sp.max())
        self.lim = (lo, hi)
        lam = 3e3
        while True:
            zo, acc = solve(lam)
            if (acc[own].min() >= lo and acc[own].max() <= hi) or lam > 5e8:
                break
            lam *= 2
        self.zo, self.fit, self.vacc = zo, lam, acc
        self.cut = zo - gz
        self.off = zo - zs0

        # ---- its own banking ----
        R = 1 / np.maximum(np.abs(kap), 1e-6)
        corner = np.abs(kap) > 1 / 650
        e0 = -np.sign(kap) * np.where(corner, 0.04 + 0.02 * np.clip((120 - R) / 75, 0, 1), 0.0)
        if corner.any():
            ci = np.flatnonzero(corner)
            near = ci[np.argmin(np.abs(np.arange(nj)[:, None] - ci[None]), 1)]
            e = np.where(corner, e0, 0.02 * np.sign(e0[near]))
        else:
            e = np.full(nj, 0.02)
        self.e = g1(e, 9.0)

        # ---- bands: 0 left, 1 right; the outer side is the one away from the built lap ----
        o = 1 if sp['side'] > 0 else 0
        inn = 1 - o
        self.o = o
        pa, gv = np.zeros((2, nj)), np.zeros((2, nj))
        g = np.maximum(gap, 0)
        far = sstep((gap - 10) / 6)
        pa[inn] = g * (1 - far)                         # paved across to the built road while the two are close
        gv[inn] = 4.0 * far
        base = np.interp(s, [0, L], [T.pw[o][sa], T.pw[o][sb]])
        ends = [T.band_edges(o)[st, rd.WALL] - T.pw[o][st] for st in (sa, sb)]
        rest = np.interp(s, [0, L], ends)
        mid = sstep(s / 40) * sstep((L - s) / 40)
        pa[o] = base * (1 - mid) + np.minimum(base, 3.0) * mid
        gv[o] = rest * (1 - mid) + np.clip(rest, 2.5, 5.0) * mid
        jj = np.arange(nj)
        apex = int(np.argmax(np.abs(kap)))
        a, b = next((a, b) for a, b in runs(corner & (np.sign(kap) == np.sign(kap[apex]))) if a <= apex < b)
        bump = sstep(1 - np.maximum(np.maximum(a - 60 - jj, jj - (b + 30)), 0) / 45.0)
        out_side = 1 if kap[apex] > 0 else 0
        if out_side == o:
            pa[o] = np.maximum(pa[o], sp['runoff'] * bump)
        else:
            pa[inn] = np.minimum(np.maximum(pa[inn], sp['runoff'] * bump), g)
            gv[inn] = np.minimum(gv[inn], np.maximum(g - pa[inn], 0))
        self.pa, self.gv = g1(pa, 3.0), g1(gv, 3.0)
        self.pa[inn] = np.minimum(self.pa[inn], g)
        self.tec = np.zeros((2, nj), bool)
        self.tec[out_side] = bump > 0.5
        wall = np.zeros((2, nj), bool)
        wall[o] = True
        wall[inn] = (gap > 30) | bool(sp.get('inner_wall'))   # (the link closes off the infield it runs beside)
        self.wall = wall

        # ---- kerbs: the inside of every bend tighter than R 230, and the outside of its exit (and entry if tight) ----
        kerb = np.zeros((2, nj))
        kin = g1((np.abs(kap) >= 1 / 230).astype(float), 3.0) > 0.01
        for side in (0, 1):
            sg = rd.SIDE_SIGN[side]
            m = kin & (np.sign(kap) == -sg)
            for ca, cb in runs(corner):
                if (1 if kap[(ca + cb) // 2] > 0 else 0) != side:
                    continue
                m[max(cb - 25, 0):cb + 40] = True
                if 1 / np.abs(kap[ca:cb]).max() < 150:
                    m[max(ca - 30, 0):ca + 6] = True
            kerb[side] = np.clip(inside_dist(m) / 14.0, 0, 1)
        self.kerb = kerb

    # ---- surface ------------------------------------------------------------------------------------------------
    def blend(self, d_edge):
        """How much of the built lap's own section a point takes: all of it on the built road, none 8 m beyond its edge"""
        return 1 - sstep((np.asarray(d_edge, float) - 0.5) / 7.5)

    def surf(self, jj, lat):
        """Points at stations jj (m,), lateral offsets lat (m, c): xy, height, and where they are on the built lap"""
        jj = np.asarray(jj)
        lat = np.asarray(lat, float)
        P = np.stack([self.x[jj][:, None] + self.rx[jj][:, None] * lat, self.y[jj][:, None] + self.ry[jj][:, None] * lat], -1)
        q = self.spine.at(P)
        own = self.zo[jj][:, None] + cross(self.e[jj][:, None], self.hw[jj][:, None] + rd.KERB_HINGE_M, lat)
        ww = self.blend(q['d'] - q['hws'])
        z = ww * q['zs'] + (1 - ww) * own
        return P, z, q

    def outer(self, side):
        return self.hw + self.pa[side] + self.gv[side]

    def bank(self):
        """Cross slope of the road as built (+ = left higher), from its two edges"""
        jj = np.arange(self.n)
        _, z, _ = self.surf(jj, np.stack([-self.hw, self.hw], 1))
        return (z[:, 0] - z[:, 1]) / (2 * self.hw)


def bake(ad, out):
    """Mesh grids of one add-on at 2 m rows, every vertex already at its final height, and which quads to draw"""
    T, nm = ad.T, ad.name
    jr = np.arange(0, ad.n, 2)
    nr = len(jr)
    out[nm + '_s'] = ad.s[jr]

    def grid(lat, dz=0.0, under=True, margin=0.3, sink=UNDER):
        P, z, q = ad.surf(jr, lat)
        on = q['d'] < q['hws']                                  # on the built road: hide beneath it
        zz = np.where(on, q['zs'] - sink, z) if under else z
        deep = q['d'] < q['hws'] - margin
        hidden = deep[:-1, :-1] & deep[:-1, 1:] & deep[1:, :-1] & deep[1:, 1:]
        return np.concatenate([P, (zz + dz)[..., None]], -1), ~hidden, q

    lat = ad.hw[jr][:, None] * ROAD_F
    P, vis, _ = grid(lat)
    out[nm + '_road'], out[nm + '_road_m'], out[nm + '_road_lat'] = P, vis, lat
    Pc, visc, qc = grid((ad.hw[jr] + 1.6)[:, None] * np.array([-1.0, 0.0, 1.0]), under=False, margin=-1.6)
    out[nm + '_col'], out[nm + '_col_m'] = Pc, visc
    out_side = 1 if ad.kap[int(np.argmax(np.abs(ad.kap)))] > 0 else 0       # the side its tightest bend's stripes are on
    for side in (0, 1):
        sg = rd.SIDE_SIGN[side]
        t = 'LR'[side]
        hw, pa, gv = ad.hw[jr], ad.pa[side][jr], ad.gv[side][jr]
        P, vis, _ = grid(sg * (hw[:, None] + np.array([-0.25, -0.10])), dz=0.006, sink=0.05)
        out[nm + '_line' + t], out[nm + '_line' + t + '_m'] = P, vis
        kf = ad.kerb[side][jr]
        P, vis, _ = grid(sg * (hw[:, None] + DK), sink=0.12)             # a kerb on the built road stays out of sight
        P[..., 2] += 0.004 + kf[:, None] * HK
        kq = (kf > 0.02)
        out[nm + '_kerb' + t], out[nm + '_kerb' + t + '_m'] = P, vis & (kq[:-1] & kq[1:])[:, None]
        d = np.minimum(PCOLS[None, :], pa[:, None])
        P, vis, qp = grid(sg * (hw[:, None] + d))
        wq = d[:, 1:] - d[:, :-1]
        out[nm + '_paint' + t], out[nm + '_paint' + t + '_m'], out[nm + '_paint' + t + '_d'] = P, vis & ((wq[:-1] > 0.02) | (wq[1:] > 0.02)), d
        d = pa[:, None] + gv[:, None] * np.linspace(0, 1, 3)
        P, vis, q = grid(sg * (hw[:, None] + d))
        # Where these bands lie on the built lap's painted run-off they are that paint, with its stripes carried on up
        # to the new asphalt: laid in their own pattern (or as grass) they crossed it as a second set of stripes and a
        # green strip. That goes quad by quad, except on a far side that has stripes of its own: there only in the rows
        # where the built run-off carries on well beyond this band (the section runs inside it), so that its own
        # stripes still follow it out of a junction and into one whose run-off is no wider than its own.
        onv, onp = on_paint(q), on_paint(qp)
        if side == ad.o and side == out_side:
            beyond = on_paint(ad.surf(jr, sg * (hw + pa + gv + 3.0)[:, None])[2])[:, 0]
            row = np.zeros(nr, bool)
            for a, b in runs(beyond & onp[:, -1]):
                row[a:b] = b - a >= 5
            onv, onp = onv & row[:, None], onp & row[:, None]
        for key, qq, on in (('_paint', qp, onp), ('_verge', q, onv)):
            n4 = on[:-1, :-1].astype(int) + on[:-1, 1:] + on[1:, :-1] + on[1:, 1:]
            sf = qq['sf']
            even = np.maximum(np.abs(sf[1:, :-1] - sf[:-1, :-1]), np.abs(sf[1:, 1:] - sf[:-1, 1:])) < 6.0
            out[nm + key + t + '_b'] = (n4 >= 3) & even
            out[nm + key + t + '_buv'] = np.stack([qq['pu'] + np.maximum(qq['d'] - qq['hws'], 0), sf], -1)
        out[nm + '_verge' + t], out[nm + '_verge' + t + '_m'] = P, vis & ((gv[:-1] > 0.05) | (gv[1:] > 0.05))[:, None]
        # the outer edge: a skirt into the ground where the terrain takes over, a barrier where the built lap has none
        edge = P[:, -1]
        ls, cor, wl = q['ls'][:, -1], q['cor'][:, -1], q['wl'][:, -1]
        clear = (np.abs(ls) > cor + 0.3) | (q['d'][:, -1] > 70)
        P2 = np.stack([edge, edge + np.c_[sg * ad.rx[jr] * 1.5, sg * ad.ry[jr] * 1.5, np.full(nr, -1.2)]], 1)
        out[nm + '_skirt' + t], out[nm + '_skirt' + t + '_m'] = P2, (clear[:-1] & clear[1:])[:, None]
        wq = ad.wall[side][jr] & ((np.abs(ls) > wl + 0.5) | (q['d'][:, -1] > 70)) & (pa + gv >= NOSE_CLEAR_M)
        out[nm + '_wall' + t], out[nm + '_wall' + t + '_m'] = edge, wq[:-1] & wq[1:]
        out[nm + '_tec' + t + '_m'] = (wq & ad.tec[side][jr])[:-1] & (wq & ad.tec[side][jr])[1:]
    for k in ('x', 'y', 'tx', 'ty', 'kap', 'hw', 'w', 'zo', 'e', 'gap', 'v', 'kerb', 'pa', 'gv', 'wall', 'off'):
        out[nm + '_' + k] = getattr(ad, k)
    out[nm + '_ends'] = np.array([ad.sa, ad.sb])

    # ---- footprint: outline raster, the surface height under every pixel, and a dense cloud for the terrain ----
    jj = np.arange(ad.n)
    oL, oR = ad.outer(0), ad.outer(1)
    cols = np.linspace(0, 1, 41)
    lat = -oL[:, None] + (oL + oR)[:, None] * cols
    P, z, q = ad.surf(jj, lat)
    cloud = np.concatenate([P, z[..., None]], -1).reshape(-1, 3)
    mg = WARP_R + 6
    x0, y1 = cloud[:, 0].min() - mg, cloud[:, 1].max() + mg
    W, H = int((cloud[:, 0].max() + mg - x0) * PPM) + 1, int((y1 - cloud[:, 1].min() + mg) * PPM) + 1
    poly = np.vstack([P[:, 0], P[::-1, -1]])
    foot = np.zeros((H, W), np.uint8)
    cv2.fillPoly(foot, [np.int32(np.round(np.c_[(poly[:, 0] - x0) * PPM, (y1 - poly[:, 1]) * PPM]))], 1)
    road = np.zeros((H, W), np.uint8)
    Pr, _, _ = ad.surf(jj, np.stack([-(ad.hw + 1.5), ad.hw + 1.5], 1))
    poly = np.vstack([Pr[:, 0], Pr[::-1, 1]])
    cv2.fillPoly(road, [np.int32(np.round(np.c_[(poly[:, 0] - x0) * PPM, (y1 - poly[:, 1]) * PPM]))], 1)
    py, px = np.nonzero(cv2.dilate(foot, np.ones((5, 5), np.uint8)))
    _, k = cKDTree(cloud[:, :2]).query(np.c_[x0 + px / PPM, y1 - py / PPM])
    zr = np.zeros((H, W), np.float32)
    zr[py, px] = cloud[k, 2]
    # the built lap's ground within WARP_R of the footprint rises or falls to meet the add-on's edge; nothing moves
    # within 1.5 m of the built road, and nothing outside the built corridor (the terrain is graded there instead)
    dist, (iy, ix) = distance_transform_edt(foot == 0, return_indices=True)
    dist /= PPM
    py, px = np.nonzero((dist > 0) & (dist < WARP_R))
    ny, nx = iy[py, px], ix[py, px]
    qn = ad.spine.at(np.c_[x0 + nx / PPM, y1 - ny / PPM])
    de = np.where((np.abs(qn['ls']) < qn['cor']) & (qn['d'] < 70) & (qn['d'] >= qn['hws']), zr[ny, nx] - qn['zg'], 0.0)
    qp = ad.spine.at(np.c_[x0 + px / PPM, y1 - py / PPM])
    # ... and in the wedge between the built road and an add-on leaving it the ground slopes evenly from the one to the
    # other: held to the built road's plane it met the add-on, which has dropped away by then, as a torn step
    off = np.clip(qp['d'] - qp['hws'] - 1.5, 0, None)
    guard = np.maximum(sstep(off / 8.0), off / (off + dist[py, px] + 1e-6)) * (np.abs(qp['ls']) < qp['cor'] + 2.0) * (qp['d'] < 70)
    warp = np.zeros((H, W), np.float32)
    warp[py, px] = de * sstep(1 - dist[py, px] / WARP_R) * guard
    # smoothed among the pixels outside the footprint only: averaged with the zeros inside it, the ground stopped at half
    # the height it had to reach just where it meets the add-on's edge
    free = (foot == 0).astype(np.float32)
    warp = cv2.GaussianBlur(warp * free, (0, 0), 1.5) / np.maximum(cv2.GaussianBlur(free, (0, 0), 1.5), 1e-3) * free
    out[nm + '_foot'], out[nm + '_roadfoot'], out[nm + '_zr'], out[nm + '_org'] = foot, road, zr, np.array([x0, y1, PPM])
    out[nm + '_warp'] = warp
    # and right beside the footprint the built ground never stands proud of the add-on's edge: what the warp leaves of a
    # step (the built road's own strip is held, so its neighbour can be high) is taken down over PULL_R
    near_w, near_z = np.zeros((H, W), np.float32), np.zeros((H, W), np.float32)
    near_w[py, px] = sstep(1 - dist[py, px] / PULL_R) * sstep(off / 2.0) * (np.abs(qp['ls']) < qp['cor'] + 2.0) * (qp['d'] < 70)
    near_z[py, px] = zr[ny, nx]
    out[nm + '_near_w'], out[nm + '_near_z'] = near_w, near_z
    out[nm + '_foot_in'] = cv2.erode(foot, np.ones((3, 3), np.uint8))
    ad.warp_range = (float(warp.min()), float(warp.max()))
    out[nm + '_cloud'] = cloud[::2].astype(np.float32)
    return cloud


def load(T, ground):
    """The add-ons as objects (their geometry and surface), without baking"""
    A = np.load(os.path.join(SRC, 'alt.npz'))
    cl = {k: np.load(os.path.join(SRC, 'cl_%s.npz' % k)) for k in ('long', 'short')}
    ads = {}
    for nm in NAMES:
        c = cl[SPEC[nm]['layout']]
        tr = cKDTree(np.c_[c['E'] - E0, c['N'] - N0])
        ads[nm] = Addon(T, nm, A, ground, lambda x, y, tr=tr, c=c: c['v'][tr.query(np.c_[x, y])[1]])
    return ads


def build(T, ground, quiet=False):
    """Bakes every add-on; returns how far the built corridor's edge moves (2, n) to pass beneath or beside them"""
    out, clouds = {}, []
    for nm, ad in load(T, ground).items():
        clouds.append(bake(ad, out))
        if not quiet:
            g = np.gradient(ad.zo, ad.h)
            print('%-5s %.1f m from station %d to %d; ends %.2f / %.2f m off the built line; own profile %.1f..%.1f m, grades %.1f%%..%.1f%%, '
                  'stiffness %.0e, cut %.1f / fill %.1f m, vertical %.1f..%.1f m/s2 (allowed %.1f..%.1f); gap to the built road up to %.0f m; kerbs %d/%d m, wall %d/%d m' % (
                      nm, ad.L, ad.sa, ad.sb, np.hypot(ad.x[0] - T.x[ad.sa], ad.y[0] - T.y[ad.sa]), np.hypot(ad.x[-1] - T.x[ad.sb], ad.y[-1] - T.y[ad.sb]),
                      ad.zo.min(), ad.zo.max(), g.min() * 100, g.max() * 100, ad.fit, -ad.cut.min(), ad.cut.max(), ad.vacc.min(), ad.vacc.max(), ad.lim[0], ad.lim[1],
                      ad.gap.max(), (ad.kerb[0] > 0).sum(), (ad.kerb[1] > 0).sum(), ad.wall[0].sum(), ad.wall[1].sum()))
    np.savez_compressed(os.path.join(DATA, 'addons.npz'), **out)
    F = Foot(out)
    delta = np.zeros((2, T.n))
    for side in (0, 1):
        P = T.world(np.arange(T.n), rd.SIDE_SIGN[side] * T.corridor(side))
        delta[side] = F.settle(P[:, :2], T.edge_z[side]) - T.edge_z[side]
        if not quiet:
            print('  corridor edge %s: moved at %d stations, %.2f..%.2f m' % ('LR'[side], (np.abs(delta[side]) > 0.01).sum(), delta[side].min(), delta[side].max()))
    return delta, np.vstack(clouds)


def plan_png(T, path):
    """Top view of the add-ons on the built lap, for a look before building"""
    A = np.load(os.path.join(DATA, 'addons.npz'))
    for nm in NAMES:
        R = A[nm + '_road']
        x0, x1, y0, y1 = R[..., 0].min() - 60, R[..., 0].max() + 60, R[..., 1].min() - 60, R[..., 1].max() + 60
        ppm = min(6.0, 1900 / max(x1 - x0, y1 - y0))
        img = np.full((int((y1 - y0) * ppm), int((x1 - x0) * ppm), 3), (96, 150, 110), np.uint8)

        def px(P):
            return np.int32(np.round(np.c_[(P[..., 0].ravel() - x0) * ppm, (y1 - P[..., 1].ravel()) * ppm])).reshape(P.shape[:-1] + (2,))

        def fill(G, M, col):
            Q = px(G)
            for r, c in zip(*np.nonzero(M)):
                cv2.fillConvexPoly(img, np.array([Q[r, c], Q[r, c + 1], Q[r + 1, c + 1], Q[r + 1, c]]), col, cv2.LINE_AA)

        i = np.arange(T.n)
        for side in (0, 1):
            sg = rd.SIDE_SIGN[side]
            e = T.band_edges(side) + T.width[:, None] / 2
            for k, col in ((0, (150, 205, 225)), (3, (140, 180, 200)), (4, (70, 150, 100)), (6, (66, 135, 100)), (7, (110, 108, 106))):
                G = np.stack([T.world(i, sg * e[:, k])[:, :2], T.world(i, sg * e[:, k + 1])[:, :2]], 1)
                near = (G[:, 0, 0] > x0) & (G[:, 0, 0] < x1) & (G[:, 0, 1] > y0) & (G[:, 0, 1] < y1)
                fill(G[near], (np.diff(np.flatnonzero(near)) == 1)[:, None], col)
            Wl = px(T.world(i, sg * T.wall_offset(side))[:, :2])
            cv2.polylines(img, [Wl], True, (30, 30, 200), 1, cv2.LINE_AA)
        for side in (0, 1):
            t = 'LR'[side]
            fill(A[nm + '_verge' + t], A[nm + '_verge' + t + '_m'], (60, 170, 90))
            fill(A[nm + '_paint' + t], A[nm + '_paint' + t + '_m'], (190, 225, 240))
        G = np.stack([T.world(i, -T.width / 2)[:, :2], T.world(i, T.width / 2)[:, :2]], 1)
        near = (G[:, 0, 0] > x0) & (G[:, 0, 0] < x1) & (G[:, 0, 1] > y0) & (G[:, 0, 1] < y1)
        fill(R, A[nm + '_road_m'], (70, 62, 58))
        fill(G[near], (np.diff(np.flatnonzero(near)) == 1)[:, None], (48, 46, 44))
        for side in (0, 1):
            t = 'LR'[side]
            fill(A[nm + '_kerb' + t], A[nm + '_kerb' + t + '_m'], (60, 60, 235))
            Wp = px(A[nm + '_wall' + t])
            for r in np.flatnonzero(A[nm + '_wall' + t + '_m']):
                cv2.line(img, tuple(Wp[r]), tuple(Wp[r + 1]), (0, 220, 255) if A[nm + '_tec' + t + '_m'][r] else (255, 60, 200), 2, cv2.LINE_AA)
        cv2.imwrite(path % nm, img)
