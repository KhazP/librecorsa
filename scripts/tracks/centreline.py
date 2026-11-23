"""Road masks, waypoint-guided routing along the racing surface, smoothing and re-centring."""
import numpy as np
import cv2
from scipy import ndimage
import os
from skimage.graph import MCP_Geometric

from surface import Raster


def horizontal(tris, min_ny=0.6):
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    ln = np.linalg.norm(n, axis=1)
    return (ln > 1e-9) & (np.abs(n[:, 1]) > min_ny * np.maximum(ln, 1e-9))


def build_masks(T, M, trace_mats, road_mats, res=0.5, margin=120.0):
    hz = horizontal(T)
    tr = hz & np.isin(M, trace_mats)
    rd = hz & np.isin(M, list(trace_mats) + list(road_mats))
    xz = T[rd][:, :, [0, 2]]
    lo = xz.reshape(-1, 2).min(0) - margin
    hi = xz.reshape(-1, 2).max(0) + margin
    R = Raster(lo, hi, res)
    trace = R.fill(R.zeros(), T[tr][:, :, [0, 2]])
    road = R.fill(R.zeros(), xz)
    k = np.ones((5, 5), np.uint8)
    trace = cv2.morphologyEx(trace, cv2.MORPH_CLOSE, k)
    road = cv2.morphologyEx(road, cv2.MORPH_CLOSE, k)
    return R, trace, road


def route(R, trace, road, start, ahead, waypoints, route_res=1.0, bridge_cost=None, block=None):
    """Closed path (world xz polyline) through start → waypoints → start along the trace mask. `block` (mask raster):
    cells the path may not enter at all, kept at any overlap so a thin wall survives the coarser routing grid."""
    f = int(round(route_res / R.res))
    tr = cv2.resize(trace, (trace.shape[1] // f, trace.shape[0] // f), interpolation=cv2.INTER_AREA) > 0
    rd = cv2.resize(road, (road.shape[1] // f, road.shape[0] // f), interpolation=cv2.INTER_AREA) > 0
    if block is not None:
        bl = cv2.resize(block, (block.shape[1] // f, block.shape[0] // f), interpolation=cv2.INTER_AREA) > 0
        tr &= ~bl
        rd &= ~bl
    dt = ndimage.distance_transform_edt(tr) * route_res
    # off the paved mask: very expensive but finite, so gaps in a scan's road material can be bridged
    cost = np.full(tr.shape, float(bridge_cost) if bridge_cost else np.inf)
    cost[rd] = 25.0
    cost[tr] = 1.0 + 8.0 * np.clip(1.0 - dt[tr] / 4.0, 0, 1) ** 2

    def px(p):
        q = (np.asarray(p, float) - R.lo) / route_res
        r, c = int(round(q[1])), int(round(q[0]))
        # snap to the nearest traversable cell
        if not tr[r, c]:
            ys, xs = np.nonzero(tr[max(0, r - 60):r + 61, max(0, c - 60):c + 61])
            if len(ys) == 0:
                raise RuntimeError(f'waypoint {p} is not near the trace mask')
            k = np.argmin((ys - min(r, 60)) ** 2 + (xs - min(c, 60)) ** 2)
            r, c = ys[k] + max(0, r - 60), xs[k] + max(0, c - 60)
        return (r, c)

    pts = [start] + list(waypoints)
    paths = []
    if len(waypoints) == 0:
        # One-waypoint loop: cut the road just behind the start so the cheapest way from a point ahead of
        # the start to a point behind it runs the full lap in the driving direction.
        d = np.asarray(ahead, float) - np.asarray(start, float)
        d /= np.linalg.norm(d)
        # start projected onto the trace mask
        r0, c0 = px(start)
        s = np.array([c0 * route_res + R.lo[0], r0 * route_res + R.lo[1]])
        nrm = np.array([-d[1], d[0]])
        c2 = cost.copy()
        # the cut spans the whole connected paved width across the start (wide aprons, run-off), then 3 m more. Paved
        # is the masks, not a finite cost: with `bridge_cost` every cell is finite, and the cut would run the full
        # 150 m and sever any other stretch of the circuit beside the start
        for side in (-1.0, 1.0):
            gap = 0.0
            t = 0.0
            while t < 150.0 and gap < 3.0:
                q = s + nrm * side * t
                r, c = px_raw(q, R.lo, route_res)
                if not (0 <= r < c2.shape[0] and 0 <= c < c2.shape[1]):
                    break
                gap = 0.0 if rd[r, c] or tr[r, c] else gap + 0.25
                for dd in (-1, 0, 1):
                    rr, cc = r + int(round(d[1] * dd)), c + int(round(d[0] * dd))
                    if 0 <= rr < c2.shape[0] and 0 <= cc < c2.shape[1]:
                        c2[rr, cc] = np.inf
                t += 0.25
        a = px(s + d * 6)
        b = px(s - d * 6)
        m = MCP_Geometric(c2, fully_connected=True)
        m.find_costs([a], [b])
        paths.append(np.array(m.traceback(b)))
    else:
        for k in range(len(pts)):
            a = px(pts[k])
            b = px(pts[(k + 1) % len(pts)])
            m = MCP_Geometric(cost, fully_connected=True)
            m.find_costs([a], [b])
            try:
                p = np.array(m.traceback(b))
            except ValueError:
                if os.environ.get('ROUTE_DEBUG'):
                    np.savez(os.environ['ROUTE_DEBUG'], cost=m.find_costs([a])[0], grid=cost, lo=R.lo, res=route_res)
                raise RuntimeError(f'no paved path from {pts[k]} to {pts[(k + 1) % len(pts)]}') from None
            paths.append(p if k == 0 else p[1:])
    rc = np.concatenate(paths).astype(float)
    xz = np.stack([rc[:, 1] * route_res + R.lo[0], rc[:, 0] * route_res + R.lo[1]], 1)
    return xz


def px_raw(q, lo, res):
    p = (np.asarray(q, float) - lo) / res
    return int(round(p[1])), int(round(p[0]))


def resample_closed(xz, ds):
    """Evenly spaced points (spacing ≈ ds) along a closed polyline."""
    p = np.vstack([xz, xz[:1]])
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    keep = np.concatenate([[True], seg > 1e-6])
    p = p[keep]
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    L = s[-1]
    n = max(8, int(round(L / ds)))
    t = np.linspace(0, L, n, endpoint=False)
    x = np.interp(t, s, p[:, 0])
    z = np.interp(t, s, p[:, 1])
    return np.stack([x, z], 1), L


def smooth_closed(xz, sigma_samples):
    return np.stack([ndimage.gaussian_filter1d(xz[:, k], sigma_samples, mode='wrap') for k in range(xz.shape[1])], 1)


def smooth_closed_keep_radius(xz, sigma_samples):
    """Gaussian smoothing with its shrink taken back out (one unshrink step, as Taubin smoothing): noise goes,
    bends keep their radius"""
    a = smooth_closed(xz, sigma_samples)
    return a - (smooth_closed(a, sigma_samples) - a)


def tangents(xz):
    t = np.roll(xz, -1, 0) - np.roll(xz, 1, 0)
    return t / np.linalg.norm(t, axis=1, keepdims=True)


def rights(tan):
    """Horizontal right-hand unit vectors (−tz, tx) — the convention of track-data.ts."""
    return np.stack([-tan[:, 1], tan[:, 0]], 1)


def edge_distances(R, road, xz, rgt, max_m=20.0, step=0.25, gap_m=1.0):
    """Distance from each point to the road edge on the left (−right) and right sides."""
    out = np.zeros((len(xz), 2))
    offs = np.arange(0, max_m + step, step)
    gap = int(round(gap_m / step))
    for side_i, side in enumerate((-1.0, 1.0)):
        pts = xz[:, None, :] + side * offs[None, :, None] * rgt[:, None, :]
        inside = R.sample(road, pts) > 0
        for i in range(len(xz)):
            row = inside[i]
            d = max_m
            run = 0
            for k in range(len(row)):
                if row[k]:
                    run = 0
                else:
                    run += 1
                    if run > gap:
                        d = offs[k - run + 1] if k - run + 1 >= 0 else 0.0
                        break
            out[i, side_i] = d
    return out


def recentre(R, road, xz, ds, iters=3, max_shift=3.0, keep_radius=False, max_width_ratio=1.35, max_local_ratio=1.2):
    """Centre the line between the raster road edges. `keep_radius`: smooth without pulling bends inward (a
    gaussian moves a bend of radius R toward its centre by about sigma^2 / 2R: over 2 m per pass in a 12 m hairpin)"""
    for _ in range(iters):
        tan = tangents(xz)
        rgt = rights(tan)
        ed = edge_distances(R, road, xz, rgt)
        L, Rr = ed[:, 0], ed[:, 1]
        w = L + Rr
        # pit-lane merges, junctions and paved run-off widen the mask locally; re-centring there would
        # drag the centre sideways, so only trust samples close to the local (~250 m) typical width
        wtyp = ndimage.median_filter(w, max(9, int(250 / ds) | 1), mode='wrap')
        valid = (L < 19) & (Rr < 19) & (w > 5) & (w < max_local_ratio * wtyp + 1.0) & (w < max_width_ratio * np.median(w) + 1.0)
        off = np.where(valid, (Rr - L) / 2.0, np.nan)
        # fill gaps (junctions, run-off merges) by periodic interpolation
        idx = np.arange(len(off))
        good = ~np.isnan(off)
        if good.sum() < 10:
            break
        off = np.interp(idx, idx[good], off[good], period=len(off))
        off = ndimage.median_filter(off, 7, mode='wrap')
        off = ndimage.gaussian_filter1d(off, 3, mode='wrap')
        off = np.clip(off, -max_shift, max_shift)
        xz = xz + rgt * off[:, None]
        xz = smooth_closed_keep_radius(xz, 1.5) if keep_radius else smooth_closed(xz, 1.5)
        xz, _ = resample_closed(xz, ds)
    return xz
