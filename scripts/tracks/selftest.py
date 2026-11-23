"""
Checks of the converters' helpers on small made-up inputs, so they run without any mod source or model:

    python -P scripts/tracks/selftest.py
"""
import contextlib
import io
import json
import os
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import build_track as bt  # noqa: E402
import centreline as cl  # noqa: E402
import glbio  # noqa: E402
import glbwrite  # noqa: E402
from surface import Raster  # noqa: E402


class Glb:
    """A GLB put together by hand: arrays go into one buffer, each with its own view"""

    def __init__(self):
        self.j = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [],
                  'accessors': [], 'bufferViews': [], 'materials': []}
        self.bin = bytearray()

    def view(self, arr, target=None):
        while len(self.bin) % 4:
            self.bin += b'\0'
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': arr.nbytes}
        if target:
            v['target'] = target
        self.j['bufferViews'].append(v)
        self.bin += arr.tobytes()
        return len(self.j['bufferViews']) - 1

    def accessor(self, arr, typ, target=None):
        comp = {np.dtype(np.float32): 5126, np.dtype(np.uint32): 5125, np.dtype(np.uint16): 5123}[arr.dtype]
        a = {'bufferView': self.view(arr, target), 'componentType': comp, 'count': len(arr), 'type': typ}
        if typ == 'VEC3':
            a['min'] = arr.min(0).tolist()
            a['max'] = arr.max(0).tolist()
        self.j['accessors'].append(a)
        return len(self.j['accessors']) - 1

    def mesh(self, name, V, F, material):
        prim = {'attributes': {'POSITION': self.accessor(np.asarray(V, np.float32), 'VEC3', 34962)},
                'indices': self.accessor(np.asarray(F, np.uint32).reshape(-1), 'SCALAR', 34963), 'material': material}
        self.j['meshes'].append({'name': name, 'primitives': [prim]})
        self.j['nodes'].append({'name': name, 'mesh': len(self.j['meshes']) - 1})
        self.j['scenes'][0]['nodes'].append(len(self.j['nodes']) - 1)
        return prim

    def save(self, path):
        self.j['buffers'] = [{'byteLength': len(self.bin)}]
        js = json.dumps(self.j).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        bn = bytes(self.bin) + b'\0' * ((4 - len(self.bin) % 4) % 4)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bn)))
            f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
            f.write(struct.pack('<II', len(bn), 0x004E4942) + bn)


def oval_masks(apart):
    """A narrow oval's masks: straights `apart` m apart (the start one on z = 0), 12 m wide, and a road-only apron
    beside the start"""
    R = Raster(np.array([-200.0, -200.0]), np.array([200.0, 200.0]), 0.5)
    trace = R.zeros()
    rad = apart / 2
    pts = [[x, 0.0] for x in np.linspace(-100, 100, 201)]
    pts += [[100 + rad * np.sin(a), rad - rad * np.cos(a)] for a in np.linspace(0, np.pi, 60)[1:]]
    pts += [[x, apart] for x in np.linspace(100, -100, 201)[1:]]
    pts += [[-100 - rad * np.sin(a), rad + rad * np.cos(a)] for a in np.linspace(0, np.pi, 60)[1:-1]]
    cv2.polylines(trace, [np.round(R.to_px(np.array(pts))).astype(np.int32)], True, 255, 24)
    road = trace.copy()
    apron = np.round(R.to_px(np.array([[-30, -6], [30, -6], [30, -11], [-30, -11]]))).astype(np.int32)
    cv2.fillConvexPoly(road, apron, 255)
    return R, trace, road


def test_route_start_cut():
    """With no waypoints the road is cut across the start. The cut ends 3 m past the paving, also with `bridgeCost`
    (every cell finite), so the back straight 40 m away stays open and the lap is routed on the road"""
    for apart in (40.0, 120.0):
        R, trace, road = oval_masks(apart)
        for bridge in (None, 400):
            path = cl.route(R, trace, road, [0.0, 0.0], [10.0, 0.0], [], bridge_cost=bridge)
            on_road = (R.sample(road, path) > 0).mean()
            assert on_road > 0.99, f'straights {apart} m apart, bridgeCost {bridge}: {on_road:.0%} of the route on the road'


def stadium(r0, half, n=2000):
    """A stadium's centre line driven anticlockwise seen from above (left turns, the outside on the right): straights
    on z = -r0 and z = r0 from x = -half to half. Returns its points, their right vectors and the distance along it"""
    L1, La = 2 * half, np.pi * r0
    s = np.linspace(0, 2 * L1 + 2 * La, n, endpoint=False)
    P, T = np.empty((n, 2)), np.empty((n, 2))
    for i, v in enumerate(s):
        if v < L1:
            P[i], T[i] = (half - v, -r0), (-1, 0)
        elif v < L1 + La:
            a = (v - L1) / r0
            P[i], T[i] = (-half - r0 * np.sin(a), -r0 * np.cos(a)), (-np.cos(a), np.sin(a))
        elif v < 2 * L1 + La:
            P[i], T[i] = (-half + v - L1 - La, r0), (1, 0)
        else:
            a = (v - 2 * L1 - La) / r0
            P[i], T[i] = (half + r0 * np.sin(a), r0 * np.cos(a)), (np.cos(a), -np.sin(a))
    return P, np.stack([-T[:, 1], T[:, 0]], 1), s


def band(P, Rt, a, b, keep=None):
    """Quads round the loop P between two lines, each (offset to the right, height); `keep` the quads to make"""
    n = len(P)
    V = np.empty((2 * n, 3))
    for k, (o, y) in enumerate((a, b)):
        V[k::2] = np.column_stack([P[:, 0] + Rt[:, 0] * o, np.full(n, y), P[:, 1] + Rt[:, 1] * o])
    i = np.nonzero(np.ones(n, bool) if keep is None else keep)[0]
    j = (i + 1) % n
    return V, np.stack([2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1], 1)


def test_wall_lane_oval():
    """build_track.py on an oval with `wallLaneWidthM`: 24 m paving, the outside wall flush with its edge and a 30 m
    hole in that wall. The lane is laid off the wall all round (across the hole too), and the model is scaled so the
    lane, the lap the circuit gets, matches `realLengthM`"""
    r0, half, real = 120.0, 200.0, 1680.0
    P, Rt, s = stadium(r0, half)
    hole = (s > 2 * half + np.pi * r0 + 150) & (s < 2 * half + np.pi * r0 + 180)
    g = Glb()
    g.j['materials'] = [{'name': name, 'pbrMetallicRoughness': {'baseColorFactor': rgb + [1.0]}}
                        for name, rgb in (('asphalt', [0.25] * 3), ('wall', [0.6] * 3), ('grass', [0.2, 0.5, 0.15]))]
    g.mesh('Road', *band(P, Rt, (-12.0, 0.0), (12.0, 0.0)), 0)
    g.mesh('Wall', *band(P, Rt, (12.0, 0.0), (12.0, 1.2), keep=~hole), 1)
    g.mesh('GrassIn', *band(P, Rt, (-40.0, -0.02), (-12.0, -0.02)), 2)
    g.mesh('GrassOut', *band(P, Rt, (12.0, -0.02), (40.0, -0.02)), 2)
    with tempfile.TemporaryDirectory() as tmp:
        g.save(os.path.join(tmp, 'oval.glb'))
        cfg = {'src': os.path.join(tmp, 'oval.glb'), 'trace': [0], 'start': [0.0, -r0], 'ahead': [-10.0, -r0],
               'realLengthM': real, 'wallLaneWidthM': 10.0, 'kerb': [], 'cornerKerbs': False, 'name': 'Oval',
               'layout': 'Oval', 'country': '', 'city': '',
               'credit': {'title': '', 'author': '', 'url': '', 'short': None, 'license': '', 'licenseUrl': ''}}
        with open(os.path.join(tmp, 'tracks.json'), 'w', encoding='utf-8') as f:
            json.dump({'oval': cfg}, f)
        # the build reads its settings next to itself and writes under the repository: both in the temporary folder
        saved = bt.HERE, bt.ROOT, sys.argv
        bt.HERE, bt.ROOT, sys.argv = tmp, tmp, ['build_track.py', 'oval', '--no-glb', '--no-line-opt']
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                bt.main()
        finally:
            bt.HERE, bt.ROOT, sys.argv = saved
        with open(os.path.join(tmp, 'public', 'tracks', 'oval', 'track_data.json'), encoding='utf-8') as f:
            d = json.load(f)
    m = d['metadata']
    assert abs(m['lengthMeters'] / real - 1) < 0.012, f"lap {m['lengthMeters']} m, official {real} m"
    # in the model's own units, the lane's distance from the stadium's spine stays within the wall raster's steps all
    # round the lap (a wall distance of 0 m across the hole put the lane over 4 m left there)
    xz = (np.array([q['p'] for q in d['samples']]) - np.array(m['modelOffset']))[:, [0, 2]] / m['modelScale']
    dist = np.hypot(np.maximum(np.abs(xz[:, 0]) - half, 0.0), xz[:, 1])
    assert dist.max() - dist.min() < 2.5, f'lane {dist.min() - r0:.1f}..{dist.max() - r0:.1f} m right of the centre line'


def read_accessor(j, b, ai):
    """An accessor's values, sparse ones applied"""
    a = j['accessors'][ai]
    n = glbio.NC[a['type']]
    out = glbio.acc(j, b, ai).copy() if 'bufferView' in a else np.zeros((a['count'], n), glbio.CT[a['componentType']])
    sp = a.get('sparse')
    if sp:
        def part(p, dt, k):
            bv = j['bufferViews'][p['bufferView']]
            o = bv.get('byteOffset', 0) + p.get('byteOffset', 0)
            return np.frombuffer(b, dt, sp['count'] * k, o).reshape(sp['count'], k)
        idx = part(sp['indices'], glbio.CT[sp['indices']['componentType']], 1)[:, 0]
        out[idx] = part(sp['values'], glbio.CT[a['componentType']], n)
    return out


def test_glb_sparse_accessors():
    """glbwrite.write_track_glb keeps a sparse accessor's indices and values with it (a morph target's, with and
    without a base view)"""
    g = Glb()
    V = np.array([[0, 0, 0], [10, 0, 0], [0, 0, 10], [10, 0, 10]], np.float32)
    prim = g.mesh('Ramp', V, [0, 1, 2, 2, 1, 3], 0)
    g.j['materials'] = [{'name': 'grey'}]
    targets = []
    for base in (None, np.full((4, 3), 0.25, np.float32)):
        ai = g.accessor(base, 'VEC3') if base is not None else None
        a = g.j['accessors'][ai] if ai is not None else {'componentType': 5126, 'count': 4, 'type': 'VEC3'}
        a['sparse'] = {'count': 2,
                       'indices': {'bufferView': g.view(np.array([1, 3], np.uint16)), 'componentType': 5123},
                       'values': {'bufferView': g.view(np.array([[0, 1, 0], [0, 2, 0]], np.float32))}}
        if ai is None:
            g.j['accessors'].append(a)
            ai = len(g.j['accessors']) - 1
        targets.append({'POSITION': ai})
    prim['targets'] = targets
    want = [[[0, 0, 0], [0, 1, 0], [0, 0, 0], [0, 2, 0]], [[.25] * 3, [0, 1, 0], [.25] * 3, [0, 2, 0]]]
    with tempfile.TemporaryDirectory() as tmp:
        g.save(os.path.join(tmp, 'in.glb'))
        j, b = glbio.load(os.path.join(tmp, 'in.glb'))
        glbwrite.write_track_glb(j, b, 1.0, np.zeros(3), [], os.path.join(tmp, 'out.glb'), log=lambda *a: None)
        j2, b2 = glbio.load(os.path.join(tmp, 'out.glb'))
    pr = next(m for m in j2['meshes'] if m.get('name') == 'Ramp')['primitives'][0]
    for k, tg in enumerate(pr['targets']):
        sp = j2['accessors'][tg['POSITION']]['sparse']
        for part in ('indices', 'values'):
            assert sp[part]['bufferView'] < len(j2['bufferViews']), f'target {k}: sparse {part} view out of range'
        got = read_accessor(j2, b2, tg['POSITION'])
        assert np.allclose(got, want[k]), f'target {k}: {got.tolist()}'


def test_turn_names_over_the_start_line():
    """apply_turn_names with a sections.ini section that runs over the start line (IN 0.95, OUT 0.06 of a 4 km lap):
    the corner 30 m past the line, in the middle of it, takes its name, and a corner half a lap away does not"""
    import port_ac_track as pat
    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, 'sections.ini'), 'w', encoding='utf-8') as f:
            f.write('[SECTION_0]\nIN=0.95\nOUT=0.06\nTEXT=Start Curve\n\n[SECTION_1]\nIN=0.20\nOUT=0.25\nTEXT=Hairpin\n')
        turns = [{'number': k + 1, 'sApprox': sa, 'name': f'Turn {k + 1}', 'complexName': f'Turn {k + 1}'}
                 for k, sa in enumerate((30, 900, 2010, 3900))]
        got = [t['name'] for t in pat.apply_turn_names(turns, tmp, 4000.0, {})]
    assert got == ['Start Curve', 'Hairpin', 'Turn 3', 'Start Curve'], got


def test_carry_previous_lines():
    """A build without the optimiser keeps the previous build's lines when the centreline has as many samples, and
    says it did, so they don't get the street hairpin margin again; otherwise it leaves the new data as it is"""
    import port_ac_track as pat

    def build(n, ro):
        return {'metadata': {}, 'samples': [{'ro': ro, 'v': 100.0} for _ in range(n)]}
    prev = build(4, 1.5)
    prev['metadata']['lapTime'] = 61.2
    for s in prev['samples']:
        s['roGt3'] = 0.5
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'track_data.json')
        with contextlib.redirect_stdout(io.StringIO()):
            missing = pat.carry_previous_lines(path, build(4, 0.0))
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(prev, f)
            other = build(5, 0.0)
            moved = pat.carry_previous_lines(path, other)
            same = build(4, 0.0)
            kept = pat.carry_previous_lines(path, same)
    assert not missing and not moved and kept, (missing, moved, kept)
    assert all(s['ro'] == 0.0 and 'roGt3' not in s for s in other['samples']) and 'lapTime' not in other['metadata']
    assert all(s['ro'] == 1.5 and s['roGt3'] == 0.5 for s in same['samples']) and same['metadata']['lapTime'] == 61.2


def test_road_profile_height():
    """The road keeps its crossfall out to its edge however low the ground beside it lies; past the edge it eases down
    to that ground; a column comes in smoothly as the road widens past it; inside the road the profile is plain
    interpolation between its columns"""
    import build_track as bt
    lat = np.array(bt.LAT)
    plane = list(-0.02 * lat)
    ditch = plane[:]
    ditch[7] = plane[7] - 1.0  # 8 m right: a ditch
    # inside the road's outermost column, plain interpolation
    for x in (-4.0, -1.0, 0.0, 2.0, 4.9):
        assert abs(bt.road_profile_height(ditch, 6.5, x) - float(np.interp(x, lat, ditch))) < 1e-12, x
    # the edge and the metres before it stay on the road's plane
    for x in (5.5, 6.0, 6.5):
        assert abs(bt.road_profile_height(ditch, 6.5, x) - (-0.02 * x)) < 1e-9, x
    # past the edge, down to the ditch at its column
    past = [bt.road_profile_height(ditch, 6.5, x) for x in (6.5, 7.0, 7.5, 8.0)]
    assert all(b < a for a, b in zip(past, past[1:])) and abs(past[-1] - ditch[7]) < 1e-9, past
    # widening past the ditch's column: no step at the edge, and once the column is 0.5 m inside it is road
    hws = np.arange(7.0, 9.0, 0.001)
    edge = np.array([bt.road_profile_height(ditch, h, h) for h in hws])
    assert np.abs(np.diff(edge)).max() < 0.005, np.abs(np.diff(edge)).max()
    h = 8.6
    assert abs(bt.road_profile_height(ditch, h, h) - (ditch[7] + (ditch[7] - ditch[6]) / 3.0 * (h - 8.0))) < 1e-9
    # a narrow road (a 4 m country lane) leans on its centre and 2.5 m columns only
    assert abs(bt.road_profile_height(ditch, 2.0, 2.0) - float(np.interp(2.0, lat, ditch))) < 1e-12


def test_subdivide_twisted_road():
    """A road strip whose crossfall grows 2 % a row: its quads twist, and the cut one keeps every small quad under the
    limit, lies on the bilinear patches (its edges the strip's own) and covers the same area, facing the same way"""
    n, ncol = 6, 7
    V = np.zeros((n, ncol, 3))
    for i in range(n):
        for c in range(ncol):
            lat = -10 + c * 20 / 6
            V[i, c] = (lat, 0.02 * i * lat, i * 5.0)
    P = V.reshape(-1, 3)
    F = []
    for i in range(n - 2):  # the last interval missing, as a skipped stretch leaves it
        for c in range(ncol - 1):
            v00, v01, v10, v11 = i * ncol + c, i * ncol + c + 1, (i + 1) * ncol + c, (i + 1) * ncol + c + 1
            F += [v00, v10, v01, v01, v10, v11]
    F = np.array(F, np.uint32)
    P2, F2 = bt.subdivide_twisted_road(P, F, ncol, 0.005)
    T0, T2 = P[F.reshape(-1, 3)], P2[F2.reshape(-1, 3)]
    assert np.abs(P2[:, 1] - 0.02 * (P2[:, 2] / 5) * P2[:, 0]).max() < 1e-9
    fn0 = np.cross(T0[:, 1] - T0[:, 0], T0[:, 2] - T0[:, 0])
    fn2 = np.cross(T2[:, 1] - T2[:, 0], T2[:, 2] - T2[:, 0])
    assert (fn0[:, 1] > 0).all() == (fn2[:, 1] > 0).all()
    area = lambda fn: 0.5 * np.linalg.norm(fn, axis=1).sum()
    assert abs(area(fn0) - area(fn2)) < 0.05, (area(fn0), area(fn2))
    # nothing drawn over the missing interval
    assert T2[:, :, 2].max() <= (n - 2) * 5.0 + 1e-9
    # each small quad (two triangles) twists less than the limit
    Q = T2.reshape(-1, 2, 3, 3)
    a, b, c, d = Q[:, 0, 0], Q[:, 0, 2], Q[:, 0, 1], Q[:, 1, 2]  # v00, v01, v10, v11
    assert np.abs(a[:, 1] - b[:, 1] - c[:, 1] + d[:, 1]).max() <= 0.005 + 1e-9


def test_upsample_rows():
    """A circle of radius 40 m sampled every ~5 m, heights a parabola along it: the cut rows lie on the circle (the
    chords between the samples sag 8 cm inside it), face across it, keep the samples where they were, and their heights
    follow the parabola closer than straight lines between the samples do"""
    R = 40.0
    n = int(2 * np.pi * R / 5)
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    xz = np.stack([R * np.cos(a), R * np.sin(a)], 1)
    rgt = cl.rights(cl.tangents(xz))
    h = lambda ang: 0.5 * np.sin(ang) ** 2
    yprof = np.tile(h(a)[:, None], (1, 9))
    z2 = np.zeros((n, 2))
    out = bt.upsample_rows(4, xz, rgt, yprof, np.full(n, 12.0), np.zeros(n), np.zeros(n, bool), np.zeros(n, bool),
                           z2, z2, z2 + 10, np.zeros((n, 2), bool), np.zeros((n, 2), bool))
    xz_u, rgt_u, yprof_u = out[0], out[1], out[2]
    r = np.linalg.norm(xz_u, axis=1)
    assert np.abs(r - R).max() < 1e-3, np.abs(r - R).max()
    assert np.abs(np.einsum('ij,ij->i', rgt_u, xz_u / r[:, None])).min() > 0.9999
    assert np.einsum('ij,ij->i', rgt_u[::4], rgt).min() > 0.99
    assert np.allclose(xz_u[::4], xz) and np.allclose(yprof_u[::4], yprof)
    ang = np.arctan2(xz_u[:, 1], xz_u[:, 0])
    lin = np.repeat(yprof[:, 0], 4) + (np.roll(yprof[:, 0], -1) - yprof[:, 0]).repeat(4) * np.tile(np.arange(4) / 4, n)
    assert np.abs(yprof_u[:, 0] - h(ang)).max() < 0.3 * np.abs(lin - h(ang)).max()
    assert len(out[10]) == 4 * n and out[10].dtype == bool


def test_recentre_wide_road():
    """A 12 m stadium whose bottom straight widens asymmetrically to 24 m (bowing +12 m right): default `recentre`
    rejects the wide stretch as a merge apron, while `max_width_ratio=2.2, max_local_ratio=2.2` centres it between
    the wide edges; `refine_ac_width` with `max_w=26.0` tracks the 24 m width instead of clipping at 22 m"""
    import port_ac_track as pat
    from surface import TriSoup

    P, Rt, s = stadium(120.0, 200.0, n=600)
    # Widen the first straight smoothly from 12 m (-6..+6) to 24 m (-6..+18) over s in [100, 300]
    t = np.clip(np.minimum((s - 100.0) / 30.0, (300.0 - s) / 30.0), 0.0, 1.0)
    ramp = t * t * (3.0 - 2.0 * t)
    oL = np.full(len(P), -6.0)
    oR = 6.0 + 12.0 * ramp
    n = len(P)
    V = np.empty((2 * n, 3))
    V[0::2] = np.column_stack([P[:, 0] + Rt[:, 0] * oL, np.zeros(n), P[:, 1] + Rt[:, 1] * oL])
    V[1::2] = np.column_stack([P[:, 0] + Rt[:, 0] * oR, np.zeros(n), P[:, 1] + Rt[:, 1] * oR])
    i = np.arange(n)
    j = (i + 1) % n
    F = np.stack([2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1], 1).reshape(-1, 3)
    T = V[F]

    R, _, road = cl.build_masks(T, np.zeros(len(T), np.int32), [0], [])
    xz, L = cl.resample_closed(P, 5.0)
    ds = L / len(xz)
    # Default ratios reject the 24 m wide stretch (keeps line near the original spine, z ≈ -120)
    xz_def = cl.recentre(R, road, xz, ds, iters=2, max_shift=3.0, keep_radius=True)
    # Raised ratios accept the 24 m stretch and move the centreline +6 m right (z ≈ -126 on the bottom straight)
    xz_wide = cl.recentre(R, road, xz, ds, iters=3, max_shift=3.0, keep_radius=True,
                          max_width_ratio=2.2, max_local_ratio=2.2)
    mid_def = xz_def[(np.abs(xz_def[:, 0]) < 30.0) & (xz_def[:, 1] < 0)]
    mid_wide = xz_wide[(np.abs(xz_wide[:, 0]) < 30.0) & (xz_wide[:, 1] < 0)]
    # Default ratios reject everything past ~15.4 m so the centreline stalls 3+ m short of the wide stretch's centre
    assert mid_def[:, 1].mean() > -123.0, mid_def[:, 1].mean()
    assert abs(mid_wide[:, 1].mean() - (-126.0)) < 0.6, mid_wide[:, 1].mean()

    # refine_ac_width tracks the 24 m width when max_w=26.0 (instead of clipping at 22.0)
    soup = TriSoup(T, np.ones(len(T), np.int32), np.zeros((len(T), 3), np.uint8))
    rgt_w = cl.rights(cl.tangents(xz_wide))
    w_init = np.where((np.abs(xz_wide[:, 0]) < 80.0) & (xz_wide[:, 1] < 0), 23.0, 12.0)
    w_ref, _ = pat.refine_ac_width(soup, {1}, {2}, xz_wide, rgt_w, np.zeros(len(xz_wide)), np.zeros(len(xz_wide)),
                                   w_init, 8.5, 26.0, med_samples=3, smooth_sigma=0.8)
    wide_sel = (np.abs(xz_wide[:, 0]) < 30.0) & (xz_wide[:, 1] < 0)
    assert abs(w_ref[wide_sel].mean() - 24.0) < 0.6, w_ref[wide_sel].mean()


TESTS = [test_route_start_cut, test_wall_lane_oval, test_glb_sparse_accessors, test_turn_names_over_the_start_line,
         test_carry_previous_lines, test_road_profile_height, test_subdivide_twisted_road, test_upsample_rows,
         test_recentre_wide_road]

if __name__ == '__main__':
    failed = 0
    for t in TESTS:
        try:
            t()
            print('PASS', t.__name__)
        except AssertionError as e:
            failed += 1
            print('FAIL', t.__name__, e)
    print(f'{failed} failed' if failed else 'all passed')
    sys.exit(1 if failed else 0)
