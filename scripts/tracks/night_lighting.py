"""
Night lighting of a circuit raced under lights: where the floodlight masts stand and which stretches of the lap are
covered (tunnels). build_blender_track.py calls `place` when the circuit's settings have a `nightLighting` block and
writes the result into the track data (`metadata.nightLighting`); the game draws the masts and lights the road from it
(src/lib/render/venue-night-lighting.ts).

Settings (all optional):
    "nightLighting": {
        "lampSpacingM": 46,      # one mast about every this far, alternating sides
        "lampHeightM": 13,       # lamp head above the road
        "tunnelColors": ["#39d8ff", "#8f63ff"]   # the light inside each tunnel, in lap order (repeats)
    }

Result:
    {
        "lamps": [[x, y, z, heightM, towardX, towardZ], ...],   # mast foot (game coordinates), unit vector to the road
        "tunnels": [{"s0": m, "s1": m, "color": "#rrggbb"}, ...]
    }

A mast stands behind the barrier on its side of the road, where nothing of the model is in its way (a grandstand, a
bridge, a building); if both sides are taken that mast is left out. No mast stands in a tunnel or under a roof.
"""
import numpy as np
from scipy.spatial import cKDTree

HELPERS = ('Track_Centreline', 'Track_Start', 'Track_PitLane')
# A stretch of road counts as a tunnel from this length; a gantry or a footbridge over the road is shorter
MIN_TUNNEL_M = 40.0
# Overhead geometry this far above the road covers it (lower is the road's own kerbs and walls)
COVER_LO_M, COVER_HI_M = 2.4, 18.0


def _overhead_points(prims, offset):
    """Points on every roughly level triangle of the model (corners, edge midpoints, centre), in game coordinates"""
    out = []
    for p in prims:
        if p.name.split('.')[0] in HELPERS or len(p.f) == 0:
            continue
        tri = p.v[p.f].astype(np.float64) + offset
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        level = np.abs(n[:, 1]) > 0.5 * np.maximum(np.linalg.norm(n, axis=1), 1e-9)
        tri = tri[level]
        if not len(tri):
            continue
        a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
        out += [a, b, c, (a + b) / 2, (b + c) / 2, (c + a) / 2, (a + b + c) / 3]
    return np.concatenate(out) if out else np.zeros((0, 3))


def _all_vertices(prims, offset):
    vs = [p.v.astype(np.float64) + offset for p in prims if p.name.split('.')[0] not in HELPERS and len(p.f)]
    return np.concatenate(vs) if vs else np.zeros((0, 3))


def _runs(flags, s, lap, min_len, max_gap):
    """Closed-lap runs of True in `flags` as (s0, s1), gaps up to `max_gap` m closed, runs under `min_len` m dropped"""
    n = len(flags)
    if flags.all() or not flags.any():
        return [(0.0, lap)] if flags.all() else []
    step = lap / n
    f = flags.copy()
    gap = int(round(max_gap / step))
    # close short gaps (the lap wraps)
    idx = np.nonzero(f)[0]
    for a, b in zip(idx, np.roll(idx, -1)):
        d = (b - a) % n
        if 1 < d <= gap + 1:
            for k in range(1, d):
                f[(a + k) % n] = True
    start = next(i for i in range(n) if f[i] and not f[i - 1])
    out, i, count = [], start, 0
    while count < n:
        if f[i % n]:
            j = i
            while f[j % n] and j - i < n:
                j += 1
            if (j - i) * step >= min_len:
                out.append((float(s[i % n]), float(s[(j - 1) % n])))
            count += j - i
            i = j
        else:
            i += 1
            count += 1
    return out


def place(data, settings, prims, log=print):
    """The circuit's `nightLighting` block from its track data, its settings and the model's primitives (glbio.prims)"""
    samples = data['samples']
    lap = float(data['metadata']['lengthMeters'])
    offset = np.array(data['metadata'].get('modelOffset', [0, 0, 0]), dtype=np.float64)
    P = np.array([smp['p'] for smp in samples], dtype=np.float64)
    T = np.array([smp['t'] for smp in samples], dtype=np.float64)
    S = np.array([smp['s'] for smp in samples], dtype=np.float64)
    # The road's right at each sample (tangent x up), level
    R = np.stack([-T[:, 2], np.zeros(len(T)), T[:, 0]], axis=1)
    R /= np.maximum(np.linalg.norm(R, axis=1, keepdims=True), 1e-9)
    n = len(samples)

    over = _overhead_points(prims, offset)
    over_tree = cKDTree(over[:, [0, 2]]) if len(over) else None

    def covered_at(x, z, y, radius):
        if over_tree is None:
            return False
        near = over_tree.query_ball_point([x, z], radius)
        if not near:
            return False
        dy = over[near, 1] - y
        return bool(((dy > COVER_LO_M) & (dy < COVER_HI_M)).any())

    covered = np.array([covered_at(P[i, 0], P[i, 2], P[i, 1], 3.5) for i in range(n)])
    colors = settings.get('tunnelColors') or ['#cfe6ff']
    tunnels = [
        {'s0': round(s0, 1), 's1': round(s1, 1), 'color': colors[k % len(colors)]}
        for k, (s0, s1) in enumerate(sorted(_runs(covered, S, lap, MIN_TUNNEL_M, 15.0)))
    ]
    in_tunnel = np.zeros(n, dtype=bool)
    for t in tunnels:
        span = (S >= t['s0'] - 12) & (S <= t['s1'] + 12) if t['s0'] <= t['s1'] else (S >= t['s0'] - 12) | (S <= t['s1'] + 12)
        in_tunnel |= span

    verts = _all_vertices(prims, offset)
    vert_tree = cKDTree(verts[:, [0, 2]]) if len(verts) else None
    height = float(settings.get('lampHeightM', 13))
    spacing = float(settings.get('lampSpacingM', 46))

    def clear(x, z, y):
        """Nothing of the model in the mast's column, and no roof over its head"""
        if vert_tree is not None:
            near = vert_tree.query_ball_point([x, z], 1.3)
            if near:
                dy = verts[near, 1] - y
                if ((dy > 1.6) & (dy < height + 1.5)).any():
                    return False
        return not covered_at(x, z, y + height - COVER_LO_M + 0.5, 3.0)

    lamps = []
    skipped = 0
    count = max(1, int(round(lap / spacing)))
    for k in range(count):
        i = int(round(k * n / count)) % n
        if in_tunnel[i]:
            continue
        smp = samples[i]
        half = 0.5 * float(smp.get('w', 14))
        placed = False
        for side in ((1, -1) if k % 2 == 0 else (-1, 1)):
            wall = float(smp.get('wR' if side > 0 else 'wL') or 0)
            base = min(max(wall, half + 3.0), 30.0)
            for extra in (2.5, 5.0, 8.0):
                d = base + extra
                x, z = P[i, 0] + R[i, 0] * side * d, P[i, 2] + R[i, 2] * side * d
                if clear(x, z, P[i, 1]):
                    lamps.append([round(x, 2), round(float(P[i, 1]), 2), round(z, 2), height,
                                  round(-side * R[i, 0], 3), round(-side * R[i, 2], 3)])
                    placed = True
                    break
            if placed:
                break
        skipped += 0 if placed else 1
    log(f'  night lighting: {len(lamps)} masts ({skipped} left out: no free spot), '
        f'{len(tunnels)} tunnels {[(t["s0"], t["s1"]) for t in tunnels]}')
    return {'lamps': lamps, 'tunnels': tunnels}
