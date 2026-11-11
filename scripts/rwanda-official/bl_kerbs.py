"""
The kerbs' blocks: what a kerb looks like, laid over what the cars drive on.

`Track_Kerbs` and `Track_Kerbs_Alt` stay the surface under the wheels, untouched: a smooth hump whose serrations the
game adds as a ripple (src/lib/sim/track-surfaces.ts). A real kerb is a row of 0.8 m blocks, each a ramp that rises
along the lap and drops to the next (FIA kerb types 1, 2 and 5). This lays two rows of them over the hump, red and
white in turn and the second row a block out of step, and takes the paint off the hump under them: it shows as bare
concrete only where a block is left out at a junction. The blocks carry no surface tag, so no wheel ever touches them;
they stand 5 mm over the hump at a block's start and at most 27 mm over it at its end.

    import bl_kerbs; bl_kerbs.build()        # after bl_addon.build(): it reads the kerbs as the junctions left them
"""
import numpy as np
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import bl_common as bc
import bl_track

NAME = 'Track_Kerb_Blocks'
SOURCES = ('Track_Kerbs', 'Track_Kerbs_Alt')
U_M, V_M = 6.0, 1.5                     # metres along and across per unit of the kerbs' uv (bl_track.kerbs)
BLOCK_M = 0.8                           # a block along the lap
ACROSS = np.array([0.0, 0.25, 0.75, 1.15, 1.5])                 # columns, metres out from the road's edge; two rows of 0.75 m
RISE = np.array([0.001, 0.014, 0.022, 0.016, 0.001])            # what a block's end stands over its start, per column
LIFT = 0.005                            # the blocks over the hump they lie on
TAPER_BLOCKS = 10                       # a kerb's first and last blocks grow to their height over this many
ROW_OF = (0, 0, 1, 1)                   # the row each of the four quads across belongs to
MIN_RUN_M = 1.6


def _corners(ob):
    """The kerb's triangles over its own uv: per corner (metres along, metres across) and its place, per triangle its corners"""
    me = ob.data
    me.calc_loop_triangles()
    nl = len(me.loops)
    uv = np.zeros(nl * 2)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2) * (U_M, V_M)
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
    return uv[first], co[lv[first]], cid.reshape(-1)[tl].reshape(-1, 3)


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

    def ends(self):
        """Where the blocks' ends lie along the run, a block's length apart on the ground (the uv runs by the lap's
        centre line: on the inside of a hairpin a metre of it is 0.6 m of kerb)"""
        a = np.linspace(0.0, self.len, max(2, int(np.ceil(self.len / 0.25)) + 1))
        mid = [next((p for p in (self.at(x, d) for d in (0.75, 0.4, 1.1)) if p is not None), None) for x in a]
        step = np.diff(a)
        for i in range(len(step)):
            if mid[i] is not None and mid[i + 1] is not None:
                step[i] = float(np.linalg.norm(mid[i + 1] - mid[i]))
        ground = np.concatenate([[0.0], np.cumsum(step)])
        n = max(1, int(round(ground[-1] / BLOCK_M)))
        return np.interp(np.linspace(0.0, ground[-1], n + 1), ground, a)


def build():
    T = bc.design()
    m = bl_track.materials()
    sig = bl_track.signature(T)
    V, F, UV, MI, SM = [], [], [], [], []
    out = {'runs': 0, 'blocks': 0, 'quads left out': 0}
    over = _ground_from_above()

    def uncovered(p):
        """The point, or nothing where other ground lies over the kerb there (an extra road's kerb or paint across it)"""
        if p is None:
            return None
        hit = over.ray_cast(Vector((p[0], p[1], p[2] + 1.0)), Vector((0.0, 0.0, -1.0)))
        return None if hit[0] is not None and hit[0].z > p[2] + 0.002 else p
    for src in SOURCES:
        ob = bpy.data.objects.get(src)
        if not ob:
            continue
        P2, X, tri = _corners(ob)
        for pick in _runs(tri, len(P2)):
            run = Run(P2, X, tri[pick])
            if run.len < MIN_RUN_M:
                continue
            ends = run.ends()
            nb = len(ends) - 1
            base = [[uncovered(run.at(a, d)) for d in ACROSS] for a in ends]
            out['runs'] += 1
            for k in range(nb):
                lo, hi = base[k], base[k + 1]
                grow = min(1.0, (k + 1) / TAPER_BLOCKS, (nb - k) / TAPER_BLOCKS)
                flag = src == 'Track_Kerbs' and bool(sig[int(run.a0 + 0.5 * (ends[k] + ends[k + 1])) % T.n])
                for c in range(len(ACROSS) - 1):
                    q = (lo[c], lo[c + 1], hi[c + 1], hi[c])
                    if any(p is None for p in q):
                        out['quads left out'] += 1
                        continue
                    up = np.array([[0, 0, LIFT], [0, 0, LIFT], [0, 0, LIFT + grow * RISE[c + 1]], [0, 0, LIFT + grow * RISE[c]]])
                    top = np.array(q) + up
                    # the end face: down from this block's end to where the next one starts
                    face = np.array([top[3], top[2], q[2] + (0, 0, LIFT), q[3] + (0, 0, LIFT)])
                    colour = (k + ROW_OF[c]) % 2
                    band = colour + 2 * ((k // 2) % 2)                   # the texture has two blocks of each colour
                    u0, u1 = (band + 0.08) / 4, (band + 0.92) / 4
                    v0, v1 = ACROSS[c] / V_M, ACROSS[c + 1] / V_M
                    along = np.array(q[3]) - np.array(q[0])
                    for quad, uv, smooth, toward in ((top, [(u0, v0), (u0, v1), (u1, v1), (u1, v0)], True, np.array([0, 0, 1.0])),
                                                     (face, [(u1, v0), (u1, v1), (u1, v1), (u1, v0)], False, along)):
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
        # the hump under the blocks is bare concrete now
        me = ob.data
        me.materials.clear()
        me.materials.append(m['kerb_base'])
        me.polygons.foreach_set('material_index', np.zeros(len(me.polygons), np.int32))
        me.update()
    V, F = _weld(np.vstack(V), np.vstack(F), np.array(SM))
    ob = bc.make_mesh(NAME, V, F, [m['kerb'], m['kerb_rw']], np.array(MI), loop_uv=np.array(UV).reshape(-1, 2))
    out['triangles'] = 2 * len(F)
    return out


def _ground_from_above():
    """Everything a car can drive on, as one surface to look down on"""
    P, T, n = [], [], 0
    for ob in bpy.data.collections[bc.COLL].objects:
        if ob.type != 'MESH' or not ob.get('surface'):
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
    """Corners that share a place become one vertex, the tops' among themselves and the end faces' among theirs: a
    block's top is one curved face to the light, and its end stays a crisp step under it"""
    kind = np.zeros(len(V), np.int64)
    kind[F[top].ravel()] = 1
    key = np.c_[np.round(V / 1e-4).astype(np.int64), kind]
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    idx = first[inv.reshape(-1)]
    used, remap = np.unique(idx, return_inverse=True)
    return V[used], remap.reshape(-1)[F]
