"""
The road sections off the built lap (outer Turn 1, outer Turn 8 hairpin, the link), built in Blender from the grids
ro_addon.py baked into data/addons.npz, and the built lap made to give way to them: its run-off, verges and kerbs
sink under them or rise to meet their edges, its barriers open where they pass.

    import bl_addon; bl_addon.build()        (after bl_track.build(), which it needs fresh)
"""
import os
import numpy as np
import bpy
import bmesh

import ro_design as rd
import bl_common as bc
import bl_track
from bl_common import Parts
from mathutils import kdtree
from ro_foot import Foot, NAMES, HUG_R

RUNOFF_SPAN_M, RUNOFF_NEG_M = bl_track.RUNOFF_SPAN_M, bl_track.RUNOFF_NEG_M
# what of the built lap lies on the ground and moves with it, and what stands on it
SETTLE = ('Track_Runoff_Paint', 'Ground_Verge', 'Ground_Gravel', 'Track_Pitlane', 'Ground_Paddock', 'Ground_ServiceRoad',
          'Track_Kerbs', 'Ground_Road_Lines', 'Track_Pit_Markings')
LAID = ('Track_Kerbs', 'Ground_Road_Lines', 'Track_Pit_Markings')    # ... of those, what lies on other ground
LAID_REACH_M = 1.5                      # ground this close to a point of them is the ground it lies on
WALLS = ('Track_Barriers', 'Track_Fences', 'Track_PitWall', 'Track_PitOuterWall', 'Track_Collider_Wall_Left',
         'Track_Collider_Wall_Right', 'Track_Collider_Wall_Pit', 'Track_Collider_Wall_PitOuter')
OBJECTS = ('Track_Asphalt_Alt', 'Track_Markings_Alt', 'Track_Kerbs_Alt', 'Track_Runoff_Alt', 'Ground_Verge_Alt',
           'Track_Barriers_Alt', 'Track_Fences_Alt', 'Track_Collider_Wall_Alt', 'Track_Barriers_Join',
           'Track_Collider_Wall_Join')
JOIN_MAX_M = 40.0                       # two barrier ends this close are joined (never across a road)
TEE_MAX_M = 14.0                        # an end left over is taken to a barrier passing within this
STUB_MAX_M = 30.0                       # a piece of the built lap's barrier cut off shorter than this goes
NOSE_CLEAR_M = 2.5                      # the built lap's barriers stop this far short of an add-on's asphalt
NEAR_M = 6.0                            # how close to an add-on a barrier end has to be to count as one of its junction's
FENCE_UNTIL = {'t1o': 135.0}            # the debris fence in front of the grandstand terrace carries on this far


def coords(ob):
    a = np.zeros(len(ob.data.vertices) * 3, np.float32)
    ob.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def set_coords(ob, V):
    ob.data.vertices.foreach_set('co', np.asarray(V, np.float32).ravel())
    ob.data.update()


def outward(P, sg):
    """Unit vectors pointing away from the road along a line of points on one of its sides"""
    t = np.gradient(P[:, :2], axis=0)
    t /= np.maximum(np.hypot(*t.T), 1e-9)[:, None]
    return np.c_[sg * t[:, 1], -sg * t[:, 0], np.zeros(len(P))]


def box(p, P, o, q, d0, d1, h, s, ulen, vtop, mi, flip):
    """A rail of rectangular section along the line P: from d0 to d1 outward of it, h high, on the quads q"""
    a, b = P + o * d0, P + o * d1
    up = np.array([0, 0, 1.0])
    rows = [(a - up * 0.3, -0.3 / h), (a + up * h, 1.0), (a + up * h, vtop[0]), (b + up * h, vtop[1]), (b + up * h, 1.0), (b - up * 0.3, -0.3 / h)]
    for k in (0, 2, 4):
        G = np.stack([rows[k][0], rows[k + 1][0]], 1)
        uv = np.zeros((len(P), 2, 2))
        uv[..., 0] = (s / ulen)[:, None]
        uv[:, 0, 1], uv[:, 1, 1] = rows[k][1], rows[k + 1][1]
        p.strip(G, mask=q, flip=flip, uv=uv, mi=mi, closed=False)


def build():
    T = bc.design()
    m = bl_track.materials()
    A = np.load(os.path.join(rd.DATA, 'addons.npz'))
    F = Foot(A)
    road, lines, kerb, paint, verge, bar, fen, colw = (Parts() for _ in range(8))
    shade = np.array([1.0, 0.975, 0.96, 0.955, 0.96, 0.975, 1.0])
    hid = [m['hidden']]
    colV, colF, nv = [], [], 0
    for nm in NAMES:
        s = A[nm + '_s']
        P, lat = A[nm + '_road'], A[nm + '_road_lat']
        uv = np.stack([lat / 8 + 0.5, np.broadcast_to(s[:, None] / 8, lat.shape)], -1)
        sh = np.interp(lat / lat[:, -1:], np.linspace(-1, 1, 7), shade)                  # a touch darker where the cars run
        road.strip(P, mask=A[nm + '_road_m'], uv=uv, col=np.broadcast_to(sh[..., None], P.shape), closed=False)
        V, Fq, _ = bc.strip(A[nm + '_col'], A[nm + '_col_m'], closed=False)
        colV.append(V)
        colF.append(Fq + nv)
        nv += len(V)
        kap = A[nm + '_kap']
        out_side = 1 if kap[int(np.argmax(np.abs(kap)))] > 0 else 0
        for side in (0, 1):
            t = 'LR'[side]
            sg = rd.SIDE_SIGN[side]
            fl = side == 0
            lines.strip(A[nm + '_line' + t], mask=A[nm + '_line' + t + '_m'], flip=fl, closed=False)
            G = A[nm + '_kerb' + t]
            uv = np.stack([np.broadcast_to(s[:, None] / 6, G.shape[:2]), np.broadcast_to(bl_track_dk()[None] / 1.5, G.shape[:2])], -1)
            kerb.strip(G, mask=A[nm + '_kerb' + t + '_m'], flip=fl, uv=uv, closed=False)
            G, d = A[nm + '_paint' + t], A[nm + '_paint' + t + '_d']
            pu = 0.0 if side == out_side else 14.0          # the stripes outside the hairpin, plain cream between the roads
            uv = np.stack([(pu + d + RUNOFF_NEG_M) / RUNOFF_SPAN_M, np.broadcast_to(s[:, None] / 12, d.shape)], -1)
            pb = A[nm + '_paint' + t + '_b']                    # ... and the built lap's own stripes where it lies on its run-off
            paint.strip(G, mask=A[nm + '_paint' + t + '_m'] & ~pb, flip=fl, uv=uv, closed=False)
            paint.strip(G, mask=A[nm + '_paint' + t + '_m'] & pb, flip=fl, uv=built_uv(A[nm + '_paint' + t + '_buv']), closed=False)
            vb = A[nm + '_verge' + t + '_b']
            for key in ('_verge', '_skirt'):
                G = A[nm + key + t]
                q = A[nm + key + t + '_m']
                if key == '_verge':
                    paint.strip(G, mask=q & vb, flip=fl, uv=built_uv(A[nm + '_verge' + t + '_buv']), closed=False)
                    q = q & ~vb
                verge.strip(G, mask=q, flip=fl, uv=G[..., :2] / 6, col=np.broadcast_to(bl_track.TRACKSIDE, G.shape), closed=False)
            W, q, qt = A[nm + '_wall' + t], A[nm + '_wall' + t + '_m'], A[nm + '_tec' + t + '_m']
            if q.any():
                o = outward(W, sg)
                box(bar, W, o, q, 0.0, 0.15, 1.0, s, 2.0, (0.72, 0.78), 0, fl)
                box(bar, W, o, qt, -0.75, -0.15, 1.2, s, 3.0, (0.5, 0.58), 1, fl)
                up = np.array([0, 0, 1.0])
                for d0, qq in ((0.0, q & ~qt), (-0.75, qt)):                      # what the cars hit
                    colw.strip(np.stack([W + o * d0 - up * 0.5, W + o * d0 + up * 2.5], 1), mask=qq, flip=fl, closed=False)
                if nm in FENCE_UNTIL:
                    qf = q & (s[:-1] < FENCE_UNTIL[nm])
                    for (da, za, va), (db, zb, vb) in (((0.15, 1.0, 0.0), (0.15, 3.6, 1.0)), ((0.15, 3.6, 0.0), (-0.30, 4.1, 0.26))):
                        G = np.stack([W + o * da + up * za, W + o * db + up * zb], 1)
                        uv = np.zeros((len(W), 2, 2))
                        uv[..., 0] = (s / 2.5)[:, None]
                        uv[:, 0, 1], uv[:, 1, 1] = va, vb
                        fen.strip(G, mask=qf, flip=fl, uv=uv, closed=False)
    road.build('Track_Asphalt_Alt', [m['asphalt']], extras={'surface': 'road', 'grip': 1.0})
    lines.build('Track_Markings_Alt', [m['paint']], uv=False)
    kerb.build('Track_Kerbs_Alt', [m['kerb']], extras={'surface': 'kerb'})
    paint.build('Track_Runoff_Alt', [m['runoff']], extras={'surface': 'runoff', 'grip': 0.75})
    verge.build('Ground_Verge_Alt', [m['grass']], extras={'surface': 'grass'})
    bar.build('Track_Barriers_Alt', [m['armco'], m['tecpro']])
    fen.build('Track_Fences_Alt', [m['fence']])
    colw.build('Track_Collider_Wall_Alt', hid, extras={'collider': 'wall', 'side': 'alt'}, uv=False)

    out = {}
    # ---- the built lap's road collider takes the add-ons' strips in ----
    ob = bpy.data.objects['Track_Collider_Road']
    if not ob.get('ro_addons'):
        V0 = coords(ob)
        F0 = np.zeros(len(ob.data.polygons) * 4, np.int32)
        ob.data.polygons.foreach_get('vertices', F0)
        ob = bc.make_mesh('Track_Collider_Road', np.vstack([V0] + colV), np.vstack([F0.reshape(-1, 4)] + [f + len(V0) for f in colF]),
                          hid, extras={'collider': 'road'})
        ob['ro_addons'] = 1
        ob.hide_viewport = ob.hide_render = True
        out['collider quads added'] = int(sum(len(f) for f in colF))
    # ---- its ground sinks under them and meets their edges ----
    moved = split = gone = 0
    base = []                                                   # (x, y, how far it moved) of the ground that moved
    kd = None
    for name in SETTLE:
        ob = bpy.data.objects.get(name)
        if not ob or ob.get('ro_addons'):
            continue
        split += refine(ob, F)
        V = coords(ob)
        z = F.settle(V[:, :2], V[:, 2])
        if name not in LAID:
            near = (F.cover(V[:, :2])[0] > -(HUG_R + LAID_REACH_M)) | (np.abs(z - V[:, 2]) > 1e-4)
            base.append(np.c_[V[near, :2], (z - V[:, 2])[near]])
        elif base:
            # a kerb on the paint, a line on a road: it moves as the ground under it does and keeps its height above
            # it. Settled on its own it came to the same height as that ground and was gone from the surface
            if kd is None:
                B = np.vstack(base)
                kd = kdtree.KDTree(len(B))
                for i, b in enumerate(B):
                    kd.insert((b[0], b[1], 0.0), i)
                kd.balance()
            d, top = F.ceiling(V[:, :2])
            for i in np.flatnonzero((d > -(HUG_R + LAID_REACH_M)) | (np.abs(z - V[:, 2]) > 1e-4)):
                hits = [(k, r) for _, k, r in kd.find_n((V[i, 0], V[i, 1], 0.0), 3) if r < LAID_REACH_M]
                if hits:
                    w = np.array([1 / (r * r + 0.0025) for _, r in hits])
                    z[i] = V[i, 2] + float((w * B[[k for k, _ in hits], 2]).sum() / w.sum())
                    if d[i] > 0:
                        z[i] = min(z[i], top[i])
        moved += int((np.abs(z - V[:, 2]) > 0.005).sum())
        V[:, 2] = z
        set_coords(ob, V)
        gone += drop_covered(ob, F)
        ob['ro_addons'] = 1
    out['ground vertices moved'] = moved
    out['ground edges split'] = split
    out['ground faces under the new roads removed'] = gone
    # ---- its barriers and fences open where an add-on passes, and stand on the moved ground beside it ----
    cut = 0
    for name in WALLS:
        ob = bpy.data.objects.get(name)
        if not ob or ob.get('ro_addons'):
            continue
        V = coords(ob)
        ins, _, wp = F.at(V[:, :2], inner=True)
        for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):           # and nothing within reach of the new asphalt
            ins |= F.at(V[:, :2] + NOSE_CLEAR_M * np.array([np.cos(a), np.sin(a)]), road=True)[0]
        V[:, 2] += wp
        set_coords(ob, V)
        if ins.any():
            bm = bmesh.new()
            bm.from_mesh(ob.data)
            gone = [f for f in bm.faces if any(ins[v.index] for v in f.verts)]
            cut += len(gone)
            bmesh.ops.delete(bm, geom=gone, context='FACES')
            loose = [v for v in bm.verts if not v.link_faces]
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
            bm.to_mesh(ob.data)
            bm.free()
            ob.data.update()
        ob['ro_addons'] = 1
    out['barrier faces opened'] = cut
    out['barrier ends'] = close_gaps(T, F, m)
    for name in OBJECTS:
        ob = bpy.data.objects.get(name)
        if ob:
            ob.hide_viewport = ob.hide_render = name.startswith('Track_Collider')
            out[name] = sum(len(f.vertices) - 2 for f in ob.data.polygons)
    # ---- what else stands on the new roads ----
    on = {}
    for ob in bpy.data.collections[bc.COLL].objects:
        if ob.type != 'MESH' or not ob.name.startswith(('Prop_', 'Env_')):
            continue
        V = coords(ob)
        ins, zr, _ = F.at(V[:, :2], road=True)
        low = ins & (V[:, 2] < zr + 4.8)
        if low.any():
            on[ob.name] = int(low.sum())
    out['standing on the new roads'] = on
    return out


def built_uv(B):
    """The run-off texture's uv of points given as (metres into the built lap's stripe pattern, its station)"""
    return np.stack([(B[..., 0] + RUNOFF_NEG_M) / RUNOFF_SPAN_M, B[..., 1] / 12], -1)


def drop_covered(ob, F):
    """
    Takes out the faces of a built surface that lie wholly under what an add-on draws. The game drives on the highest
    paved surface under a wheel, grass or not above it: the lap's sunk paint under an add-on's verge was the ground
    there, a quarter of a metre under the grass and a ledge at its end. Faces across the edge stay (they are the seam).
    Returns the number of faces removed.
    """
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    ins = F.covered(np.array([v.co[:2] for v in bm.verts], float).reshape(-1, 2))
    faces = [f for f in bm.faces if all(ins[v.index] for v in f.verts)]
    if faces:
        mid = F.covered(np.array([f.calc_center_median()[:2] for f in faces], float).reshape(-1, 2))
        faces = [f for f, m in zip(faces, mid) if m]
    n = len(faces)
    if n:
        bmesh.ops.delete(bm, geom=faces, context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        bm.to_mesh(ob.data)
        ob.data.update()
    bm.free()
    return n


def refine(ob, F, rounds=8, shortest=0.55):
    """
    Split the edges of a built surface that cross the edge of what an add-on draws until they are short: a face that is half under
    the new road dives under it as a whole, and its far corner stood out of the new verge as a jagged tooth. Returns
    the number of edges split.
    """
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    n = 0
    for _ in range(rounds):
        bm.verts.ensure_lookup_table()
        ins = F.covered(np.array([v.co[:2] for v in bm.verts], float).reshape(-1, 2))
        # ... and the ones that pass under it between two ends outside (a wide face across a narrow verge)
        long = [e for e in bm.edges if e.calc_length() > shortest]
        ends = np.array([[e.verts[0].co[:2], e.verts[1].co[:2]] for e in long], float).reshape(-1, 2, 2)
        mid = np.stack([F.covered(ends[:, 0] + (ends[:, 1] - ends[:, 0]) * f) for f in (0.25, 0.5, 0.75)], 1)
        edges = [e for e, m in zip(long, mid) if ins[e.verts[0].index] != ins[e.verts[1].index] or (m.any() and not ins[e.verts[0].index])]
        if not edges:
            break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=False)
        n += len(edges)
    if n:
        many = [f for f in bm.faces if len(f.verts) > 4]
        if many:
            bmesh.ops.triangulate(bm, faces=many)
        bm.to_mesh(ob.data)
        ob.data.update()
    bm.free()
    return n


def bl_track_dk():
    return np.array([0.0, 0.25, 0.7, 1.15, 1.5])


# ---- barrier ends at the junctions ------------------------------------------------------------------------------------
def wall_segments():
    """Every face of the barrier colliders as a line on the ground: (object, face, ax, ay, az, bx, by, bz), z the base"""
    rows = []
    for ob in bpy.data.collections[bc.COLL].objects:
        if ob.type != 'MESH' or not (ob.get('collider') == 'wall' or ob.name.startswith('Track_Collider_Wall')):
            continue
        V = coords(ob)
        for f in ob.data.polygons:
            P = V[list(f.vertices)].astype(float)
            d = np.hypot(P[:, None, 0] - P[None, :, 0], P[:, None, 1] - P[None, :, 1])
            a, b = np.unravel_index(int(d.argmax()), d.shape)
            if d[a, b] > 0.05:
                za = P[d[a] < 0.02, 2].min() + 0.5
                zb = P[d[b] < 0.02, 2].min() + 0.5
                rows.append((ob.name, f.index, P[a, 0], P[a, 1], za, P[b, 0], P[b, 1], zb))
    return rows


def seg_dist(P, a, b):
    """Distance in plan from points P (n, 2) to the segment a-b, and how far along it the nearest point is (0..1)"""
    e = b - a
    t = np.clip(((P - a) @ e) / max(float(e @ e), 1e-12), 0, 1)
    return np.hypot(*(P - (a + t[:, None] * e)).T), t


def close_gaps(T, F, m):
    """The barrier ends left where the built lap's barriers were opened for the add-ons: cut-off stubs between the
    roads go; ends a few metres apart, or an end and a barrier passing by, are joined, never across a road"""
    for name in ('Track_Barriers_Join', 'Track_Collider_Wall_Join'):        # (an earlier run's)
        bc.remove(name)
    rows = wall_segments()
    n = len(rows)
    A = np.array([r[2:5] for r in rows])
    B = np.array([r[5:8] for r in rows])
    key = lambda p: (int(round(p[0] / 0.05)), int(round(p[1] / 0.05)))
    at = {}
    for k in range(n):
        at.setdefault(key(A[k]), []).append((k, 0))
        at.setdefault(key(B[k]), []).append((k, 1))
    par = list(range(n))

    def find(k):
        while par[k] != k:
            par[k] = par[par[k]]
            k = par[k]
        return k
    for lst in at.values():
        for k, _ in lst[1:]:
            par[find(k)] = find(lst[0][0])
    comp = np.array([find(k) for k in range(n)])
    length = np.hypot(*(B[:, :2] - A[:, :2]).T)
    ring = np.array([[0.0, 0.0]] + [[NEAR_M * np.cos(a), NEAR_M * np.sin(a)] for a in np.linspace(0, 2 * np.pi, 12, endpoint=False)])
    near = lambda p: bool(F.at(p[None, :2] + ring)[0].any())
    ends = [(k, w, (A[k] if w == 0 else B[k])) for lst in at.values() if len(lst) == 1 for k, w in lst]
    ends = [(k, w, p) for k, w, p in ends if near(p)]

    def on_road(P):
        d2 = (P[:, None, 0] - T.x[None]) ** 2 + (P[:, None, 1] - T.y[None]) ** 2
        i = d2.argmin(1)
        return (np.sqrt(d2[np.arange(len(P)), i]) < T.width[i] / 2 + 0.2) | F.at(P, road=True)[0]

    def crosses(a, b):
        k = max(int(np.hypot(*(b[:2] - a[:2])) / 0.5), 2)
        t = np.linspace(0, 1, k + 1)[1:-1, None]
        return bool(on_road(a[None, :2] + t * (b - a)[None, :2]).any())

    # ---- stubs: pieces of the built lap's barriers with a cut end, too short to be a barrier ----
    gone = set()
    stubs = []
    for c in {int(comp[k]) for k, _, _ in ends}:
        sel = np.flatnonzero(comp == c)
        if length[sel].sum() < STUB_MAX_M and all(rows[k][0] in WALLS for k in sel):
            gone.update(int(k) for k in sel)
            stubs.append((round(float(length[sel].sum()), 1), [round(float(v), 0) for v in A[sel[0], :2]]))
    if gone:
        by = {}
        for k in gone:
            by.setdefault(rows[k][0], []).append(rows[k][1])
        for name, faces in by.items():
            ob = bpy.data.objects[name]
            bm = bmesh.new()
            bm.from_mesh(ob.data)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.faces[i] for i in faces], context='FACES')
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
            bm.to_mesh(ob.data)
            bm.free()
            ob.data.update()
        for name in ('Track_Barriers', 'Track_Fences'):                 # and what stood on them
            ob = bpy.data.objects.get(name)
            if not ob:
                continue
            V = coords(ob)[:, :2].astype(float)
            close = np.zeros(len(V), bool)
            for k in gone:
                box_ = (V[:, 0] > min(A[k, 0], B[k, 0]) - 2) & (V[:, 0] < max(A[k, 0], B[k, 0]) + 2) & \
                       (V[:, 1] > min(A[k, 1], B[k, 1]) - 2) & (V[:, 1] < max(A[k, 1], B[k, 1]) + 2)
                if box_.any():
                    close[np.flatnonzero(box_)[seg_dist(V[box_], A[k, :2], B[k, :2])[0] < 1.3]] = True
            if close.any():
                bm = bmesh.new()
                bm.from_mesh(ob.data)
                bmesh.ops.delete(bm, geom=[f for f in bm.faces if all(close[v.index] for v in f.verts)], context='FACES')
                bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
                bm.to_mesh(ob.data)
                bm.free()
                ob.data.update()
    live = np.array([k not in gone for k in range(n)])
    ends = [(k, w, p) for k, w, p in ends if live[k]]

    # ---- joins: first the ends that face each other, then an end and a barrier passing by ----
    joins = []
    used = set()
    pairs = sorted((float(np.hypot(*(ends[i][2][:2] - ends[j][2][:2]))), i, j) for i in range(len(ends)) for j in range(i + 1, len(ends))
                   if comp[ends[i][0]] != comp[ends[j][0]])
    for d, i, j in pairs:
        if d > JOIN_MAX_M:
            break
        if i in used or j in used or crosses(ends[i][2], ends[j][2]):
            continue
        used.update((i, j))
        joins.append((ends[i][2], ends[j][2]))
    left = []
    for i, (k, w, p) in enumerate(ends):
        if i in used:
            continue
        best = None
        cand = np.flatnonzero(live & (comp != comp[k]))
        for c in cand[np.argsort(np.hypot(*((A[cand, :2] + B[cand, :2]) / 2 - p[:2]).T))[:60]]:
            d, t = seg_dist(p[None, :2], A[c, :2], B[c, :2])
            q = A[c] + t[0] * (B[c] - A[c])
            if d[0] <= TEE_MAX_M and (best is None or d[0] < best[0]) and not crosses(p, q):
                best = (float(d[0]), q)
        if best:
            joins.append((p, best[1]))
        else:
            left.append([round(float(v), 0) for v in p[:2]])
    bar, colw = Parts(), Parts()
    up = np.array([0, 0, 1.0])
    for a, b in joins:
        d = float(np.hypot(*(b[:2] - a[:2])))
        if d < 0.05:
            continue
        P = np.array([a, b])
        colw.strip(np.stack([P - up * 0.5, P + up * 2.5], 1), closed=False)
        if d >= 1.0:
            box(bar, P, outward(P, 1.0), np.array([True]), -0.075, 0.075, 1.0, np.array([0.0, d]), 2.0, (0.72, 0.78), 0, False)
    bar.build('Track_Barriers_Join', [m['armco']])
    colw.build('Track_Collider_Wall_Join', [m['hidden']], extras={'collider': 'wall', 'side': 'join'}, uv=False)
    return {'stubs removed': stubs, 'joined': [(round(float(np.hypot(*(b[:2] - a[:2]))), 1), [round(float(v), 0) for v in a[:2]]) for a, b in joins],
            'still open': left}
