"""
The kerbs' blocks: what a kerb looks like, and what a wheel feels of it.

A real kerb is a row of 0.8 m blocks, each a ramp that rises along the lap and drops to the next (FIA kerb types 1, 2
and 5). `Track_Kerbs` and `Track_Kerbs_Alt` are the surface under the wheels: a smooth hump, on which the game stands
those blocks as a ripple (src/lib/sim/track-surfaces.ts, `bumpRise`; the circuit's `surfaceTable` in export_json.py
gives it RISE_M, BLOCK_M and RISE_SHARE). This does two things with them:

  - it lays the blocks one sees over the hump, the ripple's own shape 5 mm higher: two rows, red and white in turn and
    the second row a block out of step. They carry no surface tag; the paint is off the hump under them, which shows
    as bare concrete only where a block is left out at a junction;
  - it rewrites the humps' texture coordinate along the kerb, which the game reads the ripple from, so that a block
    under the wheel starts where the block one sees does: a block's length of it per block, from each stretch's
    start. As built it runs by the lap's centre line (a metre of it is 0.6 m of kerb inside a hairpin), which is kept
    in the meshes' `lap_u` and read from there on a second run.

    import bl_kerbs; bl_kerbs.build()        # after bl_addon.build(): it reads the kerbs as the junctions left them
"""
import numpy as np
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import ro_design as rd
import bl_common as bc
import bl_track

NAME = 'Track_Kerb_Blocks'
SOURCES = ('Track_Kerbs', 'Track_Kerbs_Alt')
U_M, V_M = 6.0, 1.5                     # metres along and across per unit of the kerbs' uv (bl_track.kerbs)
BLOCK_M = rd.KERB_BLOCK_M               # a block along the lap
ACROSS = np.array([0.0, 0.25, 0.75, 1.15, 1.5])                 # columns, metres out from the road's edge; two rows of 0.75 m
RISE_M = rd.KERB_BLOCK_RISE_M           # a block's height at the kerb's middle
RISE_SHARE = rd.KERB_BLOCK_RISE_SHARE   # of a block's length climbing, the rest coming back down
LIFT = 0.005                            # the blocks one sees over the ones under the wheel
KEEP = 'lap_u'                          # the humps' texture coordinate along the lap, as bl_track and bl_addon built it
ROW_OF = (0, 0, 1, 1)                   # the row each of the four quads across belongs to
MIN_RUN_M = 1.6


def _corners(ob):
    """The kerb's triangles over its own uv: per corner (metres along, metres across) and its place, per triangle its corners"""
    me = ob.data
    me.calc_loop_triangles()
    nl = len(me.loops)
    uv = np.zeros(nl * 2)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    keep = me.attributes.get(KEEP)
    if keep is None:                        # first time over this mesh: remember how it was built
        keep = me.attributes.new(KEEP, 'FLOAT', 'CORNER')
        keep.data.foreach_set('value', uv[:, 0].copy())
    else:
        lap = np.zeros(nl)
        keep.data.foreach_get('value', lap)
        uv[:, 0] = lap
    uv = uv * (U_M, V_M)
    lv = np.zeros(nl, np.int32)
    me.loops.foreach_get('vertex_index', lv)
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    tl = np.zeros(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('loops', tl)
    # one corner per vertex and uv: where the lap closes a vertex has two, a lap apart, and the kerb parts there
    key = np.c_[lv, np.round(uv / 0.002)].astype(np.int64)
    _, first, cid = np.unique(key, axis=0, return_index=True, return_inverse=True)
    cid = cid.reshape(-1)
    return uv[first], co[lv[first]], cid[tl].reshape(-1, 3), cid


def _runs(tri, n):
    """Triangles grouped into connected pieces"""
    parent = np.arange(n)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b, c in tri:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra
        parent[rc] = ra
    root = np.array([find(i) for i in tri[:, 0]])
    return [np.flatnonzero(root == r) for r in np.unique(root)]


class Run:
    """One stretch of kerb as a map from (metres along, metres across) to the point of its surface there"""

    def __init__(self, P2, X, tri):
        used, inv = np.unique(tri, return_inverse=True)
        self.used = used
        self.P2, self.X, self.tri = P2[used].copy(), X[used], inv.reshape(-1, 3)
        self.a0 = float(self.P2[:, 0].min())
        self.P2[:, 0] -= self.a0                    # small numbers for the tree: a lap is 5,900 m of them
        self.len = float(self.P2[:, 0].max())
        area = np.abs(np.cross(self.P2[self.tri[:, 1]] - self.P2[self.tri[:, 0]], self.P2[self.tri[:, 2]] - self.P2[self.tri[:, 0]]))
        self.tri = self.tri[area > 1e-9]
        self.bvh = BVHTree.FromPolygons([(p[0], p[1], 0.0) for p in self.P2], [tuple(int(i) for i in t) for t in self.tri])

    def at(self, a, d):
        hit = self.bvh.ray_cast(Vector((a, d, 1.0)), Vector((0.0, 0.0, -1.0)))
        if hit[0] is None:
            return None
        t = self.tri[hit[2]]
        p = self.P2[t]
        v0, v1, v2 = p[1] - p[0], p[2] - p[0], np.array([a, d]) - p[0]
        den = v0[0] * v1[1] - v1[0] * v0[1]
        w1 = (v2[0] * v1[1] - v1[0] * v2[1]) / den
        w2 = (v0[0] * v2[1] - v2[0] * v0[1]) / den
        return (1 - w1 - w2) * self.X[t[0]] + w1 * self.X[t[1]] + w2 * self.X[t[2]]

    def blocks(self):
        """Where the blocks lie along the run: the kerb's own metres at each block's start, crest and end, a block's
        length apart on the ground (the uv runs by the lap's centre line: on the inside of a hairpin a metre of it
        is 0.6 m of kerb), and the same as a map from those metres to blocks for the mesh's corners. The map is
        straight between the mesh's rows, as the game reads it off the triangles, so both agree to the millimetre"""
        a, count = np.unique(np.round(self.P2[:, 0], 3), return_counts=True)
        rows = np.unique(np.r_[0.0, a[count >= 3], self.len])          # a cut end's lone corners make no row
        rows = rows[np.r_[True, np.diff(rows) > 0.05]]
        rows[-1] = self.len
        ground = np.diff(rows)
        for i in range(len(ground)):
            for d in (0.75, 0.4, 1.1, 0.2, 1.3):
                p, q = self.at(rows[i], d), self.at(rows[i + 1], d)
                if p is not None and q is not None:
                    ground[i] = float(np.linalg.norm(q - p))
                    break
        ground = np.r_[0.0, np.cumsum(ground)]
        n = max(1, int(round(ground[-1] / BLOCK_M)))
        ground *= n / ground[-1]                                          # in blocks
        k = np.arange(n)
        return (np.interp(k, ground, rows), np.interp(k + RISE_SHARE, ground, rows), np.interp(k + 1.0, ground, rows),
                lambda at: np.interp(at, rows, ground))


def build():
    T = bc.design()
    m = bl_track.materials()
    sig = bl_track.signature(T)
    V, F, UV, MI, SM = [], [], [], [], []
    out = {'runs': 0, 'blocks': 0, 'quads left out': 0}
    high = RISE_M * np.sin(np.pi * ACROSS / V_M)            # the game's fade across the kerb (TrackColliderQuery.rippleAt)
    over = _ground_from_above()
    beside = _ground_from_above(but=SOURCES)

    def uncovered(p):
        """The point, or nothing where other ground lies over the kerb there (an extra road's kerb or paint across
        it), or within 15 mm of there: the game takes the higher of the two under a wheel"""
        if p is None:
            return None
        hit = over.ray_cast(Vector((p[0], p[1], p[2] + 1.0)), Vector((0.0, 0.0, -1.0)))
        if hit[0] is not None and hit[0].z > p[2] + 0.002:
            return None
        for dx, dy in ((0.015, 0), (-0.015, 0), (0, 0.015), (0, -0.015)):
            hit = beside.ray_cast(Vector((p[0] + dx, p[1] + dy, p[2] + 1.0)), Vector((0.0, 0.0, -1.0)))
            if hit[0] is not None and hit[0].z > p[2] + 0.002:
                return None
        return p
    for src in SOURCES:
        ob = bpy.data.objects.get(src)
        if not ob:
            continue
        P2, X, tri, corner = _corners(ob)
        along = P2[:, 0].copy()                 # per corner: metres along the kerb as the ripple is to read them
        for pick in _runs(tri, len(P2)):
            run = Run(P2, X, tri[pick])
            if run.len < MIN_RUN_M:
                continue
            start, top, end, in_blocks = run.blocks()
            nb = len(start)
            # a block's length of the ripple per block, from a whole number of blocks: the lap's metres stay near
            along[run.used] = BLOCK_M * (round(run.a0 / BLOCK_M) + in_blocks(run.P2[:, 0]))
            base = [[uncovered(run.at(a, d)) for d in ACROSS] for a in np.r_[start, end[-1]]]
            crest = [[uncovered(run.at(a, d)) for d in ACROSS] for a in top]
            out['runs'] += 1
            for k in range(nb):
                lo, mid, hi = base[k], crest[k], base[k + 1]
                flag = src == 'Track_Kerbs' and bool(sig[int(run.a0 + 0.5 * (start[k] + end[k])) % T.n])
                for c in range(len(ACROSS) - 1):
                    q = (lo[c], lo[c + 1], mid[c + 1], mid[c], hi[c + 1], hi[c])
                    if any(p is None for p in q):
                        out['quads left out'] += 1
                        continue
                    q = np.array(q) + (0, 0, LIFT)
                    q[2, 2] += high[c + 1]
                    q[3, 2] += high[c]
                    top = q[[0, 1, 2, 3]]                                # the climb
                    face = q[[3, 2, 4, 5]]                               # and the way down to where the next block starts
                    colour = (k + ROW_OF[c]) % 2
                    band = colour + 2 * ((k // 2) % 2)                   # the texture has two blocks of each colour
                    u0, u1 = (band + 0.08) / 4, (band + 0.92) / 4
                    v0, v1 = ACROSS[c] / V_M, ACROSS[c + 1] / V_M
                    up = np.array([0, 0, 1.0])
                    for quad, uv, smooth, toward in ((top, [(u0, v0), (u0, v1), (u1, v1), (u1, v0)], True, up),
                                                     (face, [(u1, v0), (u1, v1), (u1, v1), (u1, v0)], False, up)):
                        nrm = np.cross(quad[1] - quad[0], quad[3] - quad[0])
                        if nrm @ toward < 0:
                            quad, uv = quad[::-1], uv[::-1]
                        i0 = sum(len(v) for v in V)
                        V.append(quad)
                        F.append(np.arange(i0, i0 + 4))
                        UV.append(uv)
                        MI.append(1 if flag else 0)
                        SM.append(smooth)
                out['blocks'] += 1
        # the ripple under the wheels starts each block where the block one sees does
        me = ob.data
        uv = np.zeros(len(me.loops) * 2)
        me.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        uv[:, 0] = along[corner] / U_M
        me.uv_layers.active.data.foreach_set('uv', uv.ravel())
        # the hump under the blocks is bare concrete now
        me.materials.clear()
        me.materials.append(m['kerb_base'])
        me.polygons.foreach_set('material_index', np.zeros(len(me.polygons), np.int32))
        me.update()
    V, F = _weld(np.vstack(V), np.vstack(F), np.array(SM))
    ob = bc.make_mesh(NAME, V, F, [m['kerb'], m['kerb_rw']], np.array(MI), loop_uv=np.array(UV).reshape(-1, 2))
    out['triangles'] = 2 * len(F)
    return out


def _ground_from_above(but=()):
    """Everything a car can drive on, as one surface to look down on"""
    P, T, n = [], [], 0
    for ob in bpy.data.collections[bc.COLL].objects:
        if ob.type != 'MESH' or ob.name in but or not (ob.get('surface') or ob.get('collider') == 'road') or not len(ob.data.polygons):
            continue
        me = ob.data
        me.calc_loop_triangles()
        co = np.zeros(len(me.vertices) * 3)
        me.vertices.foreach_get('co', co)
        tv = np.zeros(len(me.loop_triangles) * 3, np.int32)
        me.loop_triangles.foreach_get('vertices', tv)
        P.append(co.reshape(-1, 3))
        T.append(tv.reshape(-1, 3) + n)
        n += len(me.vertices)
    return BVHTree.FromPolygons([tuple(p) for p in np.vstack(P)], [tuple(int(i) for i in t) for t in np.vstack(T)])


def _weld(V, F, top):
    """Corners that share a place become one vertex, the climbs' among themselves and the ways down among theirs: a
    block's climb is one curved face to the light, and its crest stays a crisp edge"""
    kind = np.zeros(len(V), np.int64)
    kind[F[top].ravel()] = 1
    key = np.c_[np.round(V / 1e-4).astype(np.int64), kind]
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    idx = first[inv.reshape(-1)]
    used, remap = np.unique(idx, return_inverse=True)
    return V[used], remap.reshape(-1)[F]
