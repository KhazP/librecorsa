"""
Terrain and lake of the official Rwanda layout, built in Blender from data/terrain.npz: a constrained Delaunay
triangulation of the site's points that meets the track corridor's two edges exactly.

    import bl_terrain; bl_terrain.build()
"""
import os
import numpy as np
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import delaunay_2d_cdt

import ro_design as rd
import bl_common as bc
from bl_common import mat

SAVANNA = np.array([0.36, 0.44, 0.21])
NEAR_M = 70.0            # terrain within this distance of the centreline is tagged for the physics
_bvh = None


def inside(P, poly, chunk=3000):
    """Even-odd test of points P (m, 2) against a closed polygon (k, 2)"""
    x0, y0 = poly[:, 0][None], poly[:, 1][None]
    q = np.roll(poly, -1, 0)
    x1, y1 = q[:, 0][None], q[:, 1][None]
    out = np.zeros(len(P), bool)
    for a in range(0, len(P), chunk):
        x, y = P[a:a + chunk, 0][:, None], P[a:a + chunk, 1][:, None]
        cross = (y0 > y) != (y1 > y)
        with np.errstate(divide='ignore', invalid='ignore'):
            xi = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
        out[a:a + chunk] = (cross & (x < xi)).sum(1) % 2 == 1
    return out


def tone(C):
    """Bare laterite reads far redder from the satellite classes than the site looks: pull it towards dry grass"""
    C = np.asarray(C, float)
    w = np.clip((C[:, 0] - C[:, 1] - 0.05) / 0.2, 0, 1)[:, None] * 0.7
    return C * (1 - w) + SAVANNA * w


def build():
    global _bvh
    T = bc.design()
    ter = np.load(os.path.join(rd.DATA, 'terrain.npz'))
    n = int(ter['n_loop'])
    V = np.vstack([ter['bnd'], ter['free']])
    C = tone(np.vstack([ter['bnd_col'], ter['free_col']]))
    loop = np.arange(n)
    edges = [(int(a), int(b)) for a, b in zip(loop, np.roll(loop, -1))] + \
            [(int(a), int(b)) for a, b in zip(loop + n, np.roll(loop, -1) + n)]
    vo, _, fo, ov, _, _ = delaunay_2d_cdt([Vector((float(x), float(y))) for x, y in V[:, :2]], edges, [], 0, 1e-5)
    src = np.array([o[0] if o else -1 for o in ov])
    extra = int((src < 0).sum())
    if extra:
        raise RuntimeError(f'{extra} vertices were added by the triangulation: the corridor edges cross')
    V, C = V[src], C[src]
    F = np.array([f for f in fo if len(f) == 3], int)
    cen = V[F].mean(1)[:, :2]

    # Drop what lies inside the corridor: between the right (outer) and the left (inner) loop
    left, right = ter['bnd'][:n, :2], ter['bnd'][n:, :2]
    lo, hi = right.min(0) - 5, right.max(0) + 5
    cand = np.all((cen > lo) & (cen < hi), 1)
    in_corr = np.zeros(len(F), bool)
    in_corr[cand] = inside(cen[cand], right) & ~inside(cen[cand], left)
    F = F[~in_corr]
    cen = cen[~in_corr]
    # Triangles face up
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    down = np.cross(b - a, c - a)[:, 2] < 0
    F[down] = F[down][:, ::-1]

    # Near field (tagged) / far field
    cl = np.stack([T.x[::4], T.y[::4]], 1)
    dist = np.full(len(F), np.inf)
    for i in range(0, len(F), 4000):
        d = cen[i:i + 4000, None, :] - cl[None]
        dist[i:i + 4000] = np.sqrt((d ** 2).sum(-1).min(1))
    near = dist < NEAR_M
    g = mat('Terrain_Grass', tex='grass', rough=0.95, vcol=True)
    out = {}
    for name, sel, extras in (('Terrain', near, {'surface': 'grass'}), ('Terrain_Far', ~near, None)):
        f = F[sel]
        used = np.unique(f)
        remap = np.zeros(len(V), int)
        remap[used] = np.arange(len(used))
        bc.make_mesh(name, V[used], remap[f], [g], uv=V[used][:, :2] / 6, col=C[used], extras=extras)
        out[name] = len(f)

    lv, lf = ter['lake_v'], ter['lake_f'].astype(int)
    a, b, c = lv[lf[0, 0]], lv[lf[0, 1]], lv[lf[0, 2]]
    if np.cross(b - a, c - a)[2] < 0:
        lf = lf[:, ::-1]
    water = mat('Lake_Water', color=(0.15, 0.27, 0.42), rough=0.06)
    bc.make_mesh('Lake', lv, lf, [water], smooth=False)
    out['Lake'] = len(lf) * 2

    _bvh = BVHTree.FromPolygons([Vector(p) for p in V.tolist()], F.tolist())
    out['dropped'] = int(in_corr.sum())
    out['Env_ForestCanopy'] = canopy(ter)
    return out


def ground(x, y):
    """Terrain height under a point (None over the corridor)"""
    global _bvh
    if _bvh is None:
        V, F = [], []
        for name in ('Terrain', 'Terrain_Far'):
            me = bpy.data.objects[name].data
            base = len(V)
            V += [v.co.copy() for v in me.vertices]
            F += [[base + i for i in p.vertices] for p in me.polygons]
        _bvh = BVHTree.FromPolygons(V, F)
    hit = _bvh.ray_cast(Vector((x, y, 2000.0)), Vector((0, 0, -1)))
    return None if hit[0] is None else hit[0].z


def sheet(x0, y0, h, m, seed, jit, top0, grove_m, vary):
    """One bumpy sheet over the cells of mask m (h metres each): vertices, colours, triangles. Its rim comes down into
    the ground."""
    ny, nx = m.shape
    rng = np.random.default_rng(seed)
    p = np.pad(m, 1)
    inner = m & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:] & p[:-2, :-2] & p[2:, 2:] & p[:-2, 2:] & p[2:, :-2]
    j2 = rng.uniform(-jit, jit, (ny, nx, 2))
    X = x0 + np.arange(nx)[None] * h + j2[..., 0]
    Y = y0 + np.arange(ny)[:, None] * h + j2[..., 1]
    # two scales of bumps: groves and single crowns
    bump = rng.normal(0, 1, (ny, nx))
    grove = np.zeros((ny, nx))
    for _ in range(3):
        b = np.pad(bump, 1, mode='edge')
        bump2 = (b[:-2, 1:-1] + b[2:, 1:-1] + b[1:-1, :-2] + b[1:-1, 2:] + 2 * b[1:-1, 1:-1]) / 6
        grove, bump = bump2, bump2
    grove /= max(grove.std(), 1e-6)
    top = top0 + grove_m * grove + rng.uniform(-vary[0], vary[1], (ny, nx))
    idx = -np.ones((ny, nx), int)
    V, C = [], []
    for j, i in zip(*np.nonzero(m)):
        z = ground(float(X[j, i]), float(Y[j, i]))
        if z is None or z < 0.6:
            continue
        idx[j, i] = len(V)
        if inner[j, i]:
            lum = float(np.clip(0.92 + 0.07 * grove[j, i] + rng.uniform(-0.07, 0.07), 0.72, 1.14))
            V.append((X[j, i], Y[j, i], z + top[j, i]))
            C.append((0.27 * lum, 0.37 * lum, 0.17 * lum * (1 + rng.uniform(-0.1, 0.1))))
        else:
            V.append((X[j, i], Y[j, i], z - 0.8))
            C.append((0.19, 0.27, 0.13))
    F = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            q = (idx[j, i], idx[j, i + 1], idx[j + 1, i + 1], idx[j + 1, i])
            if min(q) < 0 or not (inner[j, i] or inner[j, i + 1] or inner[j + 1, i + 1] or inner[j + 1, i]):
                continue
            if (i + j) % 2:
                F += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
            else:
                F += [(q[0], q[1], q[3]), (q[1], q[2], q[3])]
    return np.array(V, float).reshape(-1, 3), np.array(C, float).reshape(-1, 3), np.array(F, int).reshape(-1, 3)


def canopy(ter=None):
    """
    Closed woodland away from the track as one bumpy sheet above the ground (the trees still stand in it and break
    its outline): terrain.npz marks the cells. A second, coarser sheet is the far country's woodlots and wooded ridges,
    where no tree is planted at all.
    """
    ter = ter if ter is not None else np.load(os.path.join(rd.DATA, 'terrain.npz'))
    x0, y0, h = (float(v) for v in ter['can'])
    parts = [sheet(x0, y0, h, ter['can_mask'].astype(bool), 182, 6.0, 7.2, 1.6, (1.3, 1.6))]
    if 'can_far' in ter.files:
        x0, y0, h = (float(v) for v in ter['can_far'])
        parts.append(sheet(x0, y0, h, ter['can_far_mask'].astype(bool), 183, 0.3 * h, 11.0, 2.6, (2.0, 3.0)))
    V = np.vstack([q[0] for q in parts])
    C = np.vstack([q[1] for q in parts])
    off = np.cumsum([0] + [len(q[0]) for q in parts])
    F = np.vstack([q[2] + o for q, o in zip(parts, off)])
    used = np.unique(F)
    remap = np.zeros(len(V), int)
    remap[used] = np.arange(len(used))
    g = mat('Forest_Canopy', tex='canopy', rough=0.95, vcol=True)
    bc.make_mesh('Env_ForestCanopy', V[used], remap[F], [g], uv=V[used][:, :2] / 32, col=C[used])
    return len(F)


def export_trees(keepouts=()):
    """
    data/trees.json for foliage.mjs: every tree of terrain.npz on the built ground, in the game's frame (x, y up,
    z = -north), without those inside the keep-out circles (x, y, radius) of the scenery.
    """
    import json
    ter = np.load(os.path.join(rd.DATA, 'terrain.npz'))
    out, cut = [], 0
    ko = np.asarray(keepouts, float).reshape(-1, 3)
    # how many canopy cells (18 m) a tree stands inside the closed woodland's sheet: foliage.mjs thins the deep ones
    cx0, cy0, ch = (float(v) for v in ter['can'])
    cur = ter['can_mask'].astype(bool)
    deep = np.zeros(cur.shape, int)
    while cur.any():
        deep += cur
        q = np.pad(cur, 1)
        cur = cur & q[:-2, 1:-1] & q[2:, 1:-1] & q[1:-1, :-2] & q[1:-1, 2:]
    for x, y, kind, scale, yaw in ter['trees']:
        z = ground(float(x), float(y))
        if z is None or z < 0.25:
            cut += 1
            continue
        if len(ko) and (np.hypot(ko[:, 0] - x, ko[:, 1] - y) < ko[:, 2]).any():
            cut += 1
            continue
        k = int(kind)
        ci, cj = int(round((x - cx0) / ch)), int(round((y - cy0) / ch))
        d = int(deep[cj, ci]) if 0 <= cj < deep.shape[0] and 0 <= ci < deep.shape[1] else 0
        out.append({'m': 'shrub' if k == 2 else 'acacia', 'x': round(float(x), 2), 'y': round(z, 2), 'z': round(float(-y), 2),
                    's': round(float(scale) * (1.0, 1.45, 1.3)[k], 3), 'yaw': round(float(yaw), 3), 'd': d})
    with open(os.path.join(rd.DATA, 'trees.json'), 'w') as f:
        json.dump(out, f)
    return len(out), cut
