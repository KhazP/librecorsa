"""
A small example circuit for scripts/tracks/build_blender_track.py, modelled in Blender from code.

    blender -b --factory-startup -P scripts/tracks/example_circuit.py -- <out dir>

writes <out dir>/example_circuit.glb (Blender's own glTF export, named the way build_blender_track.py reads it),
<out dir>/example_circuit.json (its settings) and <out dir>/example_circuit.blend (the scene, to open and look round).

A 1.86 km anticlockwise loop: a 555 m straight with a pit lane on its inside, a 90 degree left, a kink, a hairpin,
esses, a banked sweeper and a last corner, over gentle hills. Every surface is a band along the centreline: the road
(12 m, banked in the sweeper), kerbs on the corners, run-off outside them, grass out to a barrier on both sides.
"""
import json
import math
import os
import sys

import bpy
import numpy as np

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else os.path.join(bpy.app.tempdir, 'example_circuit')
HW = 6.0  # half the road's width (m)
KERB_W = 1.2
RUNOFF_W = 8.0


def turtle(cmds, x=0.0, y=0.0):
    """Points every ~1 m along straights ('S', length) and arcs ('A', radius, degrees, left positive)"""
    h = 0.0
    pts = []
    for c in cmds:
        if c[0] == 'S':
            n = max(1, int(round(c[1])))
            ds = c[1] / n
            for _ in range(n):
                x += math.cos(h) * ds
                y += math.sin(h) * ds
                pts.append((x, y))
        else:
            a = math.radians(c[2])
            al = c[1] * abs(a)
            n = max(1, int(round(al)))
            ds, dh = al / n, a / n
            for _ in range(n):
                h += dh / 2
                x += math.cos(h) * ds
                y += math.sin(h) * ds
                h += dh / 2
                pts.append((x, y))
    return np.array(pts), x, y


def layout(south, closing):
    return [('S', closing + 400), ('A', 50, 90), ('S', 150), ('A', 80, -30), ('S', 80), ('A', 18, 150), ('S', 120),
            ('A', 60, -30), ('S', 250), ('A', 60, 40), ('A', 60, -40), ('S', 100), ('A', 110, 90), ('S', south),
            ('A', 40, 90)]


def centreline():
    """The closed centreline every 1 m, starting where the main straight begins"""
    _, _, y0 = turtle(layout(0.0, 0.0))
    south = y0  # the south straight heads exactly south: it brings the end down to y = 0
    _, x1, _ = turtle(layout(south, 0.0))
    closing = -x1  # and the main straight starts that much further back
    pts, _, _ = turtle(layout(south, closing), x=-closing)
    pts = np.vstack([[(-closing, 0.0)], pts[:-1]])
    seg = np.linalg.norm(np.roll(pts, -1, 0) - pts, axis=1)
    sc = np.concatenate([[0.0], np.cumsum(seg)])
    L = sc[-1]
    n = int(round(L))
    s = np.linspace(0.0, L, n, endpoint=False)
    loop = np.vstack([pts, pts[:1]])
    return np.column_stack([np.interp(s, sc, loop[:, 0]), np.interp(s, sc, loop[:, 1])]), L / n, closing


def smooth(a, sigma):
    k = max(1, int(3 * sigma))
    x = np.arange(-k, k + 1)
    w = np.exp(-0.5 * (x / sigma) ** 2)
    w /= w.sum()
    return np.convolve(np.concatenate([a[-k:], a, a[:k]]), w, 'valid')


P, DS, CLOSING = centreline()
N = len(P)
S = np.arange(N) * DS
L = N * DS
T = np.roll(P, -1, 0) - np.roll(P, 1, 0)
T /= np.linalg.norm(T, axis=1)[:, None]
RGT = np.column_stack([T[:, 1], -T[:, 0]])  # the right-hand side, Z up
TN = np.roll(T, -1, 0)
K = smooth((T[:, 0] * TN[:, 1] - T[:, 1] * TN[:, 0]) / DS, 3.0)  # curvature, left turns positive
ZC = 5.0 * np.sin(2 * math.pi * S / L) + 3.0 * np.sin(4 * math.pi * S / L + 0.8) + 100.0
# The sweeper (110 m radius) banks 5 degrees towards its inside: the right side is higher
BANK = np.radians(5.0) * np.clip(smooth(((K > 0.75 / 110) & (K < 1.3 / 110)).astype(float), 15.0) * 1.6, 0, 1)

# How far each side may reach before it meets another part of the circuit: half the distance to the nearest
# centreline point more than 80 m away along the lap, and inside a corner no further than its centre
sub = np.arange(0, N, 5)
D = np.linalg.norm(P[sub, None, :] - P[None, sub, :], axis=2)
ds_lap = np.abs(S[sub, None] - S[None, sub])
D[np.minimum(ds_lap, L - ds_lap) < 80.0] = np.inf
GAP = np.interp(S, S[sub], D.min(1), period=L)
corner = smooth((np.abs(K) > 1 / 260).astype(float), 12.0) > 0.05
K_WIDE = smooth(K, 25.0)
START_I = int(np.argmin(np.abs(P[:, 0] - 150.0) + np.abs(P[:, 1]) + (S > 600) * 1e6))
PIT = (START_I - 230, START_I - 180, START_I + 100, START_I + 150)  # entry ramp, pit straight, exit ramp


def pit_offset(i):
    """The pit lane's centre on the left of the main straight (m from the centreline), or None"""
    e0, e1, x0, x1 = PIT
    ramp = lambda t: 9.5 + 10.5 * (3 * t * t - 2 * t * t * t)
    if e0 <= i < e1:
        return ramp((i - e0) / (e1 - e0))
    if e1 <= i <= x0:
        return 20.0
    if x0 < i <= x1:
        return ramp(1.0 - (i - x0) / (x1 - x0))
    return None


def side_offsets(sg):
    """Per sample on one side (sg -1 left, +1 right): the outer edges of the kerb, run-off and grass (= the wall)"""
    inside = sg * K_WIDE < 0  # which way the corner turns, read over its whole length
    limit = np.minimum(GAP / 2, np.where(inside, 0.85 / np.maximum(np.abs(K), 1e-6), np.inf)) - 0.3
    want = np.where(corner & ~inside, 30.0, np.where(corner, 12.0, 16.0))
    if sg < 0:
        want[PIT[0] - 20:PIT[3] + 20] = 28.0
    wall = np.minimum(smooth(want, 15.0), limit)
    wall = np.maximum(wall, HW + 1.0)
    kerb = HW + np.where(corner, KERB_W, 0.0)
    out_corner = smooth((corner & ~inside).astype(float), 10.0) > 0.3
    runoff = np.minimum(kerb + np.where(out_corner, RUNOFF_W, 0.0), wall - 1.0)
    kerb = np.minimum(kerb, runoff)
    return kerb, runoff, wall


def z_at(i, sg, o, edge):
    """Height at offset o on side sg: the banked road plane out to `edge`, then 2 % down"""
    zp = ZC[i] + sg * np.minimum(o, edge) * np.tan(BANK[i])
    return zp - 0.02 * np.maximum(o - edge, 0.0)


MATS = {}


def material(name, rgb, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    bsdf = next(nd for nd in m.node_tree.nodes if nd.type == 'BSDF_PRINCIPLED')
    for ident, val in (('Base Color', (*rgb, 1.0)), ('Roughness', rough), ('Metallic', metal)):
        next(sk for sk in bsdf.inputs if sk.identifier == ident).default_value = val
    m.diffuse_color = (*rgb, 1.0)
    MATS[name] = m
    return m


def add_mesh(name, verts, faces, mats, face_mat=None, uv=None):
    verts = np.asarray(verts, float)
    faces = np.asarray(faces, int)
    # every face up (or towards the road for a wall's inner face, which is drawn from both sides anyway)
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 3] if faces.shape[1] == 4 else faces[:, 2]]
    flip = np.cross(b - a, c - a)[:, 2] < 0
    faces[flip] = faces[flip][:, ::-1]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts.tolist(), [], faces.tolist())
    for mn in mats:
        me.materials.append(MATS[mn])
    if face_mat is not None:
        me.polygons.foreach_set('material_index', np.asarray(face_mat, np.int32))
    if uv is not None:
        lay = me.uv_layers.new(name='UVMap')
        vi = np.zeros(len(me.loops), np.int32)
        me.loops.foreach_get('vertex_index', vi)
        lay.data.foreach_set('uv', np.asarray(uv, np.float32)[vi].ravel())
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def band(name, idx, closed, sg, inner, outer, zf, mat, lat=1, mats=None, face_mat=None, v_scale=5.0, min_w=0.05):
    """A strip along the samples `idx` on side sg between offsets inner[i] and outer[i], `lat` faces across"""
    verts, uv = [], []
    for i in idx:
        for q in range(lat + 1):
            o = inner[i] + (outer[i] - inner[i]) * q / lat
            p = P[i] + RGT[i] * sg * o
            verts.append((p[0], p[1], zf(i, o)))
            uv.append((o / (2 * HW) if name.startswith('Road') else o / 5.0, S[i] / v_scale))
    faces, fm = [], []
    m = len(idx)
    for k in range(m if closed else m - 1):
        k2 = (k + 1) % m
        if min(outer[idx[k]] - inner[idx[k]], outer[idx[k2]] - inner[idx[k2]]) < min_w:
            continue
        for q in range(lat):
            faces.append((k * (lat + 1) + q, k * (lat + 1) + q + 1, k2 * (lat + 1) + q + 1, k2 * (lat + 1) + q))
            fm.append(face_mat(idx[k]) if face_mat else 0)
    return add_mesh(name, verts, faces, mats or [mat], fm if face_mat else None, uv)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    material('Asphalt', (0.06, 0.06, 0.065), 0.9)
    material('KerbRed', (0.6, 0.03, 0.03), 0.7)
    material('KerbWhite', (0.85, 0.85, 0.85), 0.7)
    material('Runoff', (0.32, 0.32, 0.3), 0.9)
    material('Grass', (0.09, 0.22, 0.05), 1.0)
    material('Armco', (0.55, 0.57, 0.6), 0.45, 0.6)
    material('Paint', (0.9, 0.9, 0.9), 0.6)
    material('Stand', (0.1, 0.18, 0.4), 0.7)
    material('Ground', (0.07, 0.16, 0.04), 1.0)

    every = list(range(N))
    # The road: one banked plane from the left edge (-HW) across to the right one, four faces wide
    road_z = lambda i, o: ZC[i] + o * np.tan(BANK[i])
    band('Road', every, True, 1, np.full(N, -HW), np.full(N, HW), road_z, 'Asphalt', lat=4, v_scale=12.0)
    for sg, nm in ((-1, 'L'), (1, 'R')):
        kerb, runoff, wall = side_offsets(sg)
        edge = np.full(N, HW)
        kz = lambda i, o, sg=sg: z_at(i, sg, o, HW + KERB_W) + 0.012
        band(f'Kerb_{nm}', every, True, sg, edge, kerb, kz, None, mats=['KerbRed', 'KerbWhite'],
             face_mat=lambda i: int(S[i] // 2) % 2)
        gz = lambda i, o, sg=sg, kerb=kerb: z_at(i, sg, o, kerb[i])
        band(f'Runoff_{nm}', every, True, sg, kerb, runoff, gz, 'Runoff', lat=2)
        band(f'Grass_{nm}', every, True, sg, runoff, wall, gz, 'Grass', lat=3)
        # the barrier: 0.3 m thick, 1 m high, standing 0.3 m into the ground
        verts, faces = [], []
        for k, i in enumerate(every):
            g = gz(i, wall[i])
            for o, zz in ((wall[i], g - 0.3), (wall[i], g + 1.0), (wall[i] + 0.3, g + 1.0), (wall[i] + 0.3, g - 0.3)):
                p = P[i] + RGT[i] * sg * o
                verts.append((p[0], p[1], zz))
            k2 = (k + 1) % N
            for q in range(3):
                faces.append((k * 4 + q, k * 4 + q + 1, k2 * 4 + q + 1, k2 * 4 + q))
        add_mesh(f'Wall_{nm}', verts, faces, ['Armco'])
        if sg < 0:
            pit_idx = list(range(PIT[0], PIT[3] + 1))
            pc = np.zeros(N)
            for i in pit_idx:
                pc[i] = pit_offset(i)
            pz = lambda i, o, kerb=kerb: z_at(i, -1, o, kerb[i]) + 0.01
            band('PitLane', pit_idx, False, -1, pc - 3.5, pc + 3.5, pz, 'Asphalt', lat=2, v_scale=12.0)
            line = [(*(P[i] + RGT[i] * -1 * pc[i]), pz(i, pc[i]) + 0.3) for i in pit_idx]
            me = bpy.data.meshes.new('Track_PitLane')
            me.from_pydata(line, [(k, k + 1) for k in range(len(line) - 1)], [])
            ob = bpy.data.objects.new('Track_PitLane', me)
            bpy.context.scene.collection.objects.link(ob)

    # The start line, a grandstand behind the right-hand barrier, and the ground round it all (scenery)
    i0 = START_I
    sl = list(range(i0, i0 + 2))
    band('StartLine', sl, False, 1, np.full(N, -HW), np.full(N, HW), lambda i, o: road_z(i, o) + 0.004,
         'Paint', lat=1)
    st = list(range(i0 - 60, i0 + 61))
    band('Grandstand', st, False, 1, np.full(N, 21.0), np.full(N, 33.0),
         lambda i, o: z_at(i, 1, 21.0, HW) + (o - 21.0) * 0.5, 'Stand', lat=1)
    lo, hi = P.min(0) - 400.0, P.max(0) + 400.0
    gzv = float(ZC.min()) - 1.5
    add_mesh('Ground', [(lo[0], lo[1], gzv), (hi[0], lo[1], gzv), (hi[0], hi[1], gzv), (lo[0], hi[1], gzv)],
             [(0, 1, 2, 3)], ['Ground'])

    # Track_Centreline: loose edges round the middle of the road, floating 0.5 m over it
    cl_verts = [(P[i, 0], P[i, 1], ZC[i] + 0.5) for i in range(N)]
    me = bpy.data.meshes.new('Track_Centreline')
    me.from_pydata(cl_verts, [(i, (i + 1) % N) for i in range(N)], [])
    ob = bpy.data.objects.new('Track_Centreline', me)
    bpy.context.scene.collection.objects.link(ob)
    # Track_Start: an arrow on the start line pointing the way the cars go
    e = bpy.data.objects.new('Track_Start', None)
    e.empty_display_type = 'SINGLE_ARROW'
    e.empty_display_size = 6.0
    e.location = (P[i0, 0], P[i0, 1], ZC[i0] + 1.0)
    e.rotation_euler = (0.0, math.pi / 2, math.atan2(T[i0, 1], T[i0, 0]))
    bpy.context.scene.collection.objects.link(e)


def export():
    os.makedirs(OUT, exist_ok=True)
    glb = os.path.join(OUT, 'example_circuit.glb')
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_mesh_edges=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'example_circuit.blend'))
    settings = {
        'name': 'Example Circuit',
        'layout': 'Test loop',
        'country': '',
        'city': '',
        'baseAltitudeM': 100,
        'pitboxes': 10,
        'description': 'A 1.86 km test loop built by scripts/tracks/example_circuit.py: a long straight, a hairpin, '
                       'esses and a banked sweeper.',
        'credit': {'title': 'Example circuit', 'author': 'LibreCorsa', 'url': 'https://github.com/librecorsa/librecorsa',
                   'short': None, 'license': 'AGPL-3.0', 'licenseUrl': 'https://github.com/librecorsa/librecorsa/blob/main/LICENSE'},
    }
    with open(os.path.join(OUT, 'example_circuit.json'), 'w', encoding='utf-8') as f:
        json.dump(settings, f, indent=2)
        f.write('\n')
    print(f'example circuit: {L:.0f} m, start line at {S[START_I]:.0f} m, straight {CLOSING + 400:.0f} m, '
          f'narrowest gap to another stretch {GAP.min():.0f} m -> {glb}')


build()
export()
