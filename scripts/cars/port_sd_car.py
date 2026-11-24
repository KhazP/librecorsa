"""Port a Speed Dreams car (its AC3D models, textures and XML) into LibreCorsa's ported-car GLB layout.

usage: python -P scripts/cars/port_sd_car.py <car folder> <out.glb> --params <params.json> [--skins-out <folder>]
         [--thumb <thumb.webp>] [--info <info.json>] [--shared <folder> ...] [--no-driver]

    uv run --python 3.14 --no-project --with numpy --with pillow python -P scripts/cars/port_sd_car.py \
      ~/.local/share/speed-dreams-2/cars/models/ls2-cavallo-360r /tmp/cavallo.glb --params /tmp/cavallo-params.json

The car's parameters come in as JSON (`--params`): its XML merged over its category's and converted to SI, as
scripts/lib/sd-params.ts reads them (`npm run mod -- import sd-car` writes it). Read here: the models in `Graphic
Objects` (the body of range 1, the driver's first pose, the steering wheel, the 3D wheels), the axles' and wheels'
positions and sizes, the ride heights, and the `Driver` and `Bonnet` eye points. `--shared` names the folders the game
also looks in for models and textures (its data/objects and data/textures): the default wheels live there.

What Speed Dreams draws, as its graphics engine (osggraph) draws it:
  - .acc / .ac files are AC3D: objects with `loc` / `rot` baked down the tree, the first `texture` of each object (the
    others are for track shaders), the first UV pair of each ref, triangle strips (SURF 0x?4), fans (0x?3) and polygons
    (0x?0); lines are dropped. `texrep` / `texoff` move the UVs. A SURF with 0x20 is two-sided.
  - Only objects named `:WI…`, `WI…`, `RIM…` or `GLASS…` show their texture's alpha (blended); every other object is
    opaque whatever its texture holds.
  - The AC frame is x forward, y up, z right, metres; the car's XML frame x forward, y left, z up, with its origin at the
    model's origin and z = 0 on the body's reference plane, which stands `ride height` above the road at each axle.
  - Wheels are a unit model (`3d front wheel` / `3d rear wheel` / `3d wheel`, default the game's `wheel`, level 0 of its
    four speed levels) scaled to the tyre's diameter and width, drawn as the left wheel and turned about z for the right.
    Its tyre is the object named TIRE / TYRE (else the part outside the rim's radius), the rest its rim.
  - A livery (skin) replaces each texture `<name>.<ext>` by `<name>-<skin>.<ext>` where the car has one; the steering
    wheel keeps its own.

Output node layout (read by src/lib/ported-car-model.ts):
    CAR (extras: wheelCentres, tyreRadius, tyreHalfWidth, wheelbaseM, trackWidthM, steer, cameras, skinMaps, source)
      BODY            the body, one mesh per material, and DRIVER (the driver in his straight-ahead pose)
      STEER           the steering wheel, local +Z along the column into the dash (when the car has one of its own)
      WHEEL_RF        hub pivot at the tyre's centre (likewise LF, RR, LR)
        WHEEL_RF_RIM  the rim
        WHEEL_RF_TYRE the tyre, one primitive
Axes: +X left, +Y up, +Z forward, metres, lowest tyre point at y = 0, X centred on the four wheels.
"""
import argparse
import io
import json
import math
import os
import re
import shlex
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from port_sketchfab_gt3 import GlbWriter, make_steer_frame  # noqa: E402
from port_ac_car import merge, paint_swatch, resize_straight, srgb_to_linear  # noqa: E402

CORNERS = ('RF', 'LF', 'RR', 'LR')
# The XML's wheel sections, by rig corner
WHEEL_SECTION = {'RF': 'Front Right Wheel', 'LF': 'Front Left Wheel', 'RR': 'Rear Right Wheel', 'LR': 'Rear Left Wheel'}
TRANSPARENT_NAME = re.compile(r'^(:WI|WI|RIM|GLASS)', re.I)
TYRE_NAME = re.compile(r'tire|tyre|tread|rubber', re.I)
# The driver's own objects in a body model (HEAD, not HEADLIGHTS): drawn single-sided, so an eye point inside the head
# (the cockpit camera) sees out through it
DRIVER_NAME = re.compile(r'^(driver|head|helmet|neck|visor|face)(_|\d|$)', re.I)


def ac_to_rig(p):
    """AC (x forward, y up, z right) -> rig (+X left, +Y up, +Z forward): a proper rotation, so faces keep their winding"""
    p = np.asarray(p, np.float64)
    return np.stack([-p[..., 2], p[..., 1], p[..., 0]], -1)


def sd_to_rig(p):
    """The XML's frame (x forward, y left, z up) -> rig"""
    p = np.asarray(p, np.float64)
    return np.stack([p[..., 1], p[..., 2], p[..., 0]], -1)


# ---------------------------------------------------------------------------------------------------------------------
# AC3D (.ac / .acc), as osggraph's car loader reads it (ReaderWriterACC)
# ---------------------------------------------------------------------------------------------------------------------


def read_ac(path):
    """Every object with geometry in `path` as a mesh in the AC frame, its transforms baked:
    dict(name, texture, pos (n,3), nrm (n,3) or None, uv (n,2), tris (m,3), mats (m,) material index, two (m,) bool)
    plus the file's materials [dict(name, rgb, spec, shi, trans)]"""
    with open(path, 'r', encoding='latin-1') as f:
        lines = f.read().splitlines()
    if not lines or not lines[0].startswith('AC3D'):
        raise ValueError(f'{path}: not an AC3D file')
    materials = []
    meshes = []
    i = 1

    def tokens(line):
        try:
            return shlex.split(line, posix=True)
        except ValueError:
            return line.split()

    def parse_object(R, t):
        nonlocal i
        name, texture = '', None
        rep, off = np.ones(2), np.zeros(2)
        rot, loc = np.eye(3), np.zeros(3)
        verts = None
        surfs = []
        while i < len(lines):
            tk = tokens(lines[i])
            i += 1
            if not tk:
                continue
            k = tk[0]
            if k == 'name':
                name = tk[1] if len(tk) > 1 else ''
            elif k == 'data':
                i += 1
            elif k == 'texture':
                # The first texture is the colour map; the others (tiled, skids, shad) are for the track shaders
                if texture is None:
                    texture = tk[1] if len(tk) > 1 else ''
                    if texture == 'empty_texture_no_mapping':
                        texture = ''
            elif k == 'texrep':
                rep = np.array([float(tk[1]), float(tk[2])])
            elif k == 'texoff':
                off = np.array([float(tk[1]), float(tk[2])])
            elif k == 'rot':
                rot = np.array([float(v) for v in tk[1:10]]).reshape(3, 3)
            elif k == 'loc':
                loc = np.array([float(v) for v in tk[1:4]])
            elif k == 'numvert':
                n = int(tk[1])
                rows = [lines[i + j].split() for j in range(n)]
                i += n
                verts = np.array([[float(v) for v in r[:6]] + [math.nan] * (6 - len(r[:6])) for r in rows], np.float64) \
                    if n else np.zeros((0, 6))
            elif k == 'numsurf':
                for _ in range(int(tk[1])):
                    flags, mat, refs = 0, 0, []
                    while i < len(lines):
                        st = lines[i].split()
                        i += 1
                        if not st:
                            continue
                        if st[0] == 'SURF':
                            flags = int(st[1], 0)
                        elif st[0] == 'mat':
                            mat = int(st[1])
                        elif st[0] == 'refs':
                            n = int(st[1])
                            for j in range(n):
                                r = lines[i + j].split()
                                refs.append((int(r[0]), float(r[1]) if len(r) > 2 else 0.0, float(r[2]) if len(r) > 2 else 0.0))
                            i += n
                            break
                    surfs.append((flags, mat, refs))
            elif k == 'kids':
                # Rotation then translation, composed down the tree (AC3D's loc / rot)
                Rw = R @ rot
                tw = R @ loc + t
                if verts is not None and len(verts) and surfs:
                    m = build_mesh(name, texture, verts, surfs, Rw, tw, rep, off)
                    if m is not None:
                        meshes.append(m)
                for _ in range(int(tk[1])):
                    # Each kid starts with its OBJECT line
                    while i < len(lines) and not lines[i].startswith('OBJECT'):
                        i += 1
                    i += 1
                    parse_object(Rw, tw)
                return

    while i < len(lines):
        tk = tokens(lines[i])
        i += 1
        if not tk:
            continue
        if tk[0] == 'MATERIAL':
            def after(key, n):
                j = tk.index(key) if key in tk else -1
                return [float(v) for v in tk[j + 1:j + 1 + n]] if j >= 0 else [0.0] * n
            materials.append(dict(name=tk[1], rgb=after('rgb', 3), spec=after('spec', 3), shi=after('shi', 1)[0],
                                  trans=after('trans', 1)[0]))
        elif tk[0] == 'OBJECT':
            parse_object(np.eye(3), np.zeros(3))
    return meshes, materials


def build_mesh(name, texture, verts, surfs, R, t, rep, off):
    """One object's surfaces as triangles over (vertex, uv) pairs"""
    key_index = {}
    pos_i, uvs, tris, mats, two = [], [], [], [], []

    def vid(ref):
        idx, u, v = ref
        k = (idx, round(u, 6), round(v, 6))
        if k not in key_index:
            key_index[k] = len(pos_i)
            pos_i.append(idx)
            uvs.append((u * rep[0] + off[0], v * rep[1] + off[1]))
        return key_index[k]

    for flags, mat, refs in surfs:
        kind = flags & 0x0F
        if kind in (1, 2) or len(refs) < 3:
            continue
        ids = [vid(r) for r in refs]
        if kind == 4:
            tri = [(ids[k], ids[k + 1], ids[k + 2]) if k % 2 == 0 else (ids[k + 1], ids[k], ids[k + 2]) for k in range(len(ids) - 2)]
        else:
            # A polygon (0) or a fan (3): a fan from its first vertex
            tri = [(ids[0], ids[k], ids[k + 1]) for k in range(1, len(ids) - 1)]
        for a, b, c in tri:
            if len({pos_i[a], pos_i[b], pos_i[c]}) < 3:
                continue
            tris.append((a, b, c))
            mats.append(mat)
            two.append(bool(flags & 0x20))
    if not tris:
        return None
    pos_i = np.array(pos_i)
    pos = verts[pos_i, :3] @ R.T + t
    has_n = not np.isnan(verts[:, 3:6]).any()
    nrm = verts[pos_i, 3:6] @ R.T if has_n else None
    return dict(name=name, texture=texture, pos=pos, nrm=nrm, uv=np.array(uvs, np.float64), tris=np.array(tris, np.int64),
                mats=np.array(mats), two=np.array(two))


def smooth_normals(pos, tris):
    """Per-vertex normals averaged over the faces sharing a position (osggraph's SmoothingVisitor)"""
    keys = np.round(pos, 5)
    _, inv = np.unique(keys, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    fn = np.cross(pos[tris[:, 1]] - pos[tris[:, 0]], pos[tris[:, 2]] - pos[tris[:, 0]])
    acc = np.zeros((inv.max() + 1, 3))
    for k in range(3):
        np.add.at(acc, inv[tris[:, k]], fn)
    n = acc[inv]
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


# ---------------------------------------------------------------------------------------------------------------------
# The car
# ---------------------------------------------------------------------------------------------------------------------


class Params:
    """The merged parameters (`--params`): section path -> {key: SI number or string}"""

    def __init__(self, path):
        with open(path, encoding='utf-8') as f:
            self.s = json.load(f)['sections']

    def num(self, section, key, default=None):
        v = self.s.get(section, {}).get(key)
        return float(v) if isinstance(v, (int, float)) else default

    def str(self, section, key, default=None):
        v = self.s.get(section, {}).get(key)
        return v if isinstance(v, str) else default

    def children(self, section):
        pre = section + '/'
        return sorted({k[len(pre):].split('/')[0] for k in self.s if k.startswith(pre)},
                      key=lambda n: (0, int(n)) if n.isdigit() else (1, n))


class Finder:
    """Model and texture files as the game finds them: the car's folder, then the shared folders"""

    def __init__(self, car_dir, shared):
        self.dirs = [car_dir, *shared]
        self.car_dir = car_dir

    def find(self, name):
        if not name:
            return None
        base = os.path.basename(name.replace('\\', '/'))
        for d in self.dirs:
            for cand in (base, base.lower()):
                p = os.path.join(d, cand)
                if os.path.isfile(p):
                    return p
        return None


class Textures:
    """Each texture once: JPEG when opaque, PNG when a blended object reads its alpha, capped in size"""

    def __init__(self, writer, finder, max_tex, small_tex, quality):
        self.w, self.finder = writer, finder
        self.max_tex, self.small_tex, self.q = max_tex, small_tex, quality
        self.cache = {}
        self.stats = []
        writer.j['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]

    def load(self, name):
        p = self.finder.find(name)
        if not p:
            return None
        im = Image.open(p)
        im.load()
        return im.convert('RGBA')

    def encode(self, im, cap, alpha):
        if max(im.size) > cap:
            k = cap / max(im.size)
            size = (max(1, round(im.width * k)), max(1, round(im.height * k)))
            im = resize_straight(im, size) if alpha else im.convert('RGB').resize(size, Image.LANCZOS)
        buf = io.BytesIO()
        if alpha:
            im.convert('RGBA').save(buf, format='PNG', optimize=True)
            return buf.getvalue(), 'image/png', im.size
        im.convert('RGB').save(buf, format='JPEG', quality=self.q, optimize=True)
        return buf.getvalue(), 'image/jpeg', im.size

    def index(self, name, alpha, big):
        """The texture index of image `name` (None when the game wouldn't find it either)"""
        key = (name, alpha)
        if key in self.cache:
            return self.cache[key]
        im = self.load(name)
        if im is None:
            self.cache[key] = None
            return None
        alpha = alpha and np.asarray(im)[..., 3].min() < 255
        data, mime, size = self.encode(im, self.max_tex if big else self.small_tex, alpha)
        bv = self.w.add_view(data)
        self.w.j['images'].append({'name': name, 'bufferView': bv, 'mimeType': mime})
        self.w.j['textures'].append({'sampler': 0, 'source': len(self.w.j['images']) - 1})
        self.stats.append((name, size, mime, len(data)))
        self.cache[key] = len(self.w.j['textures']) - 1
        return self.cache[key]


def object_class(name, texture, part):
    """The material class the game's clean-up recognises (src/lib/render/ported-car-materials.ts), from what the object is"""
    n = (name or '').lower()
    if part == 'tyre':
        return 'tyre'
    if part == 'rim':
        return 'rim'
    if part == 'steer':
        return 'interior_steer'
    if part == 'driver' or DRIVER_NAME.match(name or ''):
        return 'driver'
    if TRANSPARENT_NAME.match(name or '') or re.search(r'glass|window|windscreen|windshield', n):
        return 'glass'
    if re.search(r'light|lamp', n):
        return 'light'
    if 'mirror' in n:
        return 'mirror'
    if re.search(r'interior|cockpit|seat|chair|cage|dash|belt', n) or re.search(r'-int\b|_int\b', (texture or '').lower()):
        return 'interior'
    if re.search(r'exhaust|chrome|engine', n):
        return 'metal'
    if re.search(r'tire|tyre', n):
        return 'tyre'
    return 'paint'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('car_dir')
    ap.add_argument('out')
    ap.add_argument('--params', required=True, help="the car's merged parameters as JSON (scripts/lib/sd-params.ts)")
    ap.add_argument('--shared', action='append', default=[], help="the game's shared model and texture folders")
    ap.add_argument('--skins-out', default=None, help="write each livery's files into <folder>/<livery id>/")
    ap.add_argument('--thumb', default=None, help="write the car's picture (its preview image) as a .webp")
    ap.add_argument('--info', default=None, help='write what the port measured and found as JSON')
    ap.add_argument('--no-driver', action='store_true', help='leave the driver out')
    ap.add_argument('--no-steer-search', action='store_true', help="don't look for a steering wheel modelled into the body")
    ap.add_argument('--max-tex', type=int, default=2048)
    ap.add_argument('--small-tex', type=int, default=1024)
    ap.add_argument('--jpeg-quality', type=int, default=88)
    a = ap.parse_args()

    car_dir = os.path.abspath(a.car_dir)
    car = os.path.basename(os.path.normpath(car_dir))
    P = Params(a.params)
    finder = Finder(car_dir, a.shared)
    warnings = []
    G = 'Graphic Objects'

    # ---- What the car is made of
    body_file = P.str(f'{G}/Ranges/1', 'car') if '1' in P.children(f'{G}/Ranges') else None
    body_path = finder.find(body_file or f'{car}.acc') or finder.find(f'{car}.ac')
    if not body_path:
        sys.exit(f'{car}: no body model ({body_file or car + ".acc"}) in {car_dir}')
    parts = []  # (part, corner, mesh) with geometry in the XML frame's AC axes, converted below

    body_meshes, body_mats = read_ac(body_path)
    for m in body_meshes:
        parts.append(('body', None, m, body_mats, np.zeros(3)))

    drivers = P.children(f'{G}/Driver')
    if drivers and not a.no_driver:
        sec = f'{G}/Driver/{drivers[0]}'
        dpath = finder.find(P.str(sec, 'driver'))
        if dpath:
            off = np.array([P.num(sec, 'xpos', 0.0), P.num(sec, 'ypos', 0.0), P.num(sec, 'zpos', 0.0)])
            dm, dmats = read_ac(dpath)
            for m in dm:
                parts.append(('driver', None, m, dmats, off))
        else:
            warnings.append(f'driver model {P.str(sec, "driver")} not found')

    # ---- Axles and wheels: the XML's positions, the tyre's size (wheel.cpp)
    xF = P.num('Front Axle', 'xpos', 0.0)
    xR = P.num('Rear Axle', 'xpos', 0.0)
    wheels = {}
    for c in CORNERS:
        sec = WHEEL_SECTION[c]
        rim_r = P.num(sec, 'rim diameter', 0.33) / 2
        width = P.num(sec, 'tire width', 0.145)
        height = P.num(sec, 'tire height', 0.0) or width * P.num(sec, 'tire height-width ratio', 0.75)
        rh = P.num(sec, 'ride height', 0.2)
        radius = rim_r + height
        wheels[c] = dict(x=xF if c[1] == 'F' else xR, y=P.num(sec, 'ypos', 0.8 if c[0] == 'L' else -0.8), rim=rim_r,
                         radius=radius, width=width, rh=rh)
    # The body's reference plane level, at the mean ride height: Speed Dreams rakes the body by the front and rear ride
    # heights, the rig keeps its frame level (the physics pitches it) with every tyre on the road
    rh_mean = float(np.mean([wheels[c]['rh'] for c in CORNERS]))
    # The model is the left wheel, its outer face towards AC -z (the car's left)
    wheel_models = {}
    for axle in ('F', 'R'):
        prefix = P.str(G, '3d front wheel' if axle == 'F' else '3d rear wheel') or P.str(G, '3d wheel') or 'wheel'
        wpath = finder.find(f'{prefix}0.acc') or finder.find(f'{prefix}0.ac')
        if not wpath:
            sys.exit(f'{car}: no wheel model {prefix}0.acc in {car_dir} or the shared folders ({", ".join(a.shared) or "none given"})')
        wheel_models[axle] = (wpath, *read_ac(wpath))

    for c in CORNERS:
        w = wheels[c]
        wpath, wmeshes, wmats = wheel_models[c[1]]
        named = any(TYRE_NAME.search(m['name'] or '') for m in wmeshes)
        rim_frac = w['rim'] / w['radius']
        for m in wmeshes:
            pos = m['pos'] * np.array([2 * w['radius'], 2 * w['radius'], w['width']])
            nrm = None if m['nrm'] is None else m['nrm'] / np.array([2 * w['radius'], 2 * w['radius'], w['width']])
            if c[0] == 'R':
                # The right wheels turned half a turn about the vertical: AC x -> -x, z -> -z
                pos = pos * np.array([-1, 1, -1])
                nrm = None if nrm is None else nrm * np.array([-1, 1, -1])
            # Centre: the axle's xpos, the wheel's ypos, its radius above the road (`rh_mean` under z = 0)
            centre_sd = np.array([w['x'], w['y'], w['radius'] - rh_mean])
            centre_ac = np.array([centre_sd[0], centre_sd[2], -centre_sd[1]])
            mm = dict(m, pos=pos + centre_ac, nrm=nrm)
            if named:
                kind = 'tyre' if TYRE_NAME.search(m['name'] or '') else 'rim'
                parts.append((kind, c, mm, wmats, np.zeros(3)))
            else:
                # No named tyre: the triangles outside the rim's radius are the tyre
                r = np.hypot(m['pos'][:, 0], m['pos'][:, 1]) * 2
                cen = r[m['tris']].mean(1)
                tyre = cen >= rim_frac * 0.98
                for kind, mask in (('tyre', tyre), ('rim', ~tyre)):
                    if mask.any():
                        parts.append((kind, c, dict(mm, tris=mm['tris'][mask], mats=m['mats'][mask], two=m['two'][mask]), wmats, np.zeros(3)))

    # ---- Steering wheel: rotated by `angle` (degrees) about the XML's y, then moved to its place
    steer = None
    sw = f'{G}/Steer Wheel'
    spath = finder.find(P.str(sw, 'hi res model')) or finder.find(P.str(sw, 'model'))
    if spath:
        ang = math.radians(P.num(sw, 'angle', 0.0))
        pivot_sd = np.array([P.num(sw, 'xpos', 0.0), P.num(sw, 'ypos', 0.0), P.num(sw, 'zpos', 0.0)])
        # R_y(angle) in the XML frame, as an AC-frame rotation (AC y = XML z, AC z = -XML y)
        Ry = np.array([[math.cos(ang), 0, math.sin(ang)], [0, 1, 0], [-math.sin(ang), 0, math.cos(ang)]])
        S = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])  # AC -> XML axes: (x, -z, y)
        R_ac = np.linalg.inv(S) @ Ry @ S
        smeshes, smats = read_ac(spath)
        pivot_ac = np.array([pivot_sd[0], pivot_sd[2], -pivot_sd[1]])
        for m in smeshes:
            parts.append(('steer', None, dict(m, pos=m['pos'] @ R_ac.T + pivot_ac, nrm=None if m['nrm'] is None else m['nrm'] @ R_ac.T),
                          smats, np.zeros(3)))
        column_sd = Ry @ np.array([1.0, 0, 0])
        steer = dict(pivot=sd_to_rig(pivot_sd), column=sd_to_rig(column_sd))
    elif P.str(sw, 'model') or P.str(sw, 'hi res model'):
        warnings.append('steering wheel model not found')

    # ---- Into the rig's axes; driver offsets are in the XML frame
    rig_parts = []
    for kind, corner, m, mats, off_sd in parts:
        pos = ac_to_rig(m['pos']) + sd_to_rig(off_sd)
        nrm = ac_to_rig(m['nrm']) if m['nrm'] is not None else smooth_normals(pos, m['tris'])
        uv = np.c_[m['uv'][:, 0], 1.0 - m['uv'][:, 1]]
        rig_parts.append(dict(kind=kind, corner=corner, name=m['name'], texture=m['texture'], pos=pos, nrm=nrm, uv=uv,
                              tris=m['tris'], mats=m['mats'], two=m['two'], acmats=mats))

    # A steering wheel modelled into the body (no `Steer Wheel` of its own): the body's separate piece in front of the
    # driver's eyes that is a flat disc a steering wheel's size, made the STEER node so it turns, and the game frames its
    # cockpit views on it
    if steer is None and not a.no_steer_search:
        eyes_sd = np.array([P.num('Driver', 'xpos', 0.0), P.num('Driver', 'ypos', 0.0), P.num('Driver', 'zpos', 0.8)])
        found = find_steering_wheel(rig_parts, sd_to_rig(eyes_sd))
        if found:
            idx, tris_of, centre, axis = found
            for i, mask in zip(idx, tris_of):
                p = rig_parts[i]
                rig_parts.append(dict(p, kind='steer', tris=p['tris'][mask], mats=p['mats'][mask], two=p['two'][mask]))
                p['tris'], p['mats'], p['two'] = p['tris'][~mask], p['mats'][~mask], p['two'][~mask]
            # The column runs forward and down into the dash (rig axes in the XML's convention before conversion)
            steer = dict(pivot=centre, column=axis)
            warnings.append(f'steering wheel found in the body at {np.round(centre, 3).tolist()}')

    # Shift: lowest tyre point to y = 0, X centred on the four wheels
    tyres = [p for p in rig_parts if p['kind'] == 'tyre']
    if sorted({p['corner'] for p in tyres}) != sorted(CORNERS):
        sys.exit(f'{car}: no tyre found on every wheel')
    centres0 = {c: sd_to_rig([wheels[c]['x'], wheels[c]['y'], wheels[c]['radius'] - rh_mean]) for c in CORNERS}
    shift = np.array([-np.mean([centres0[c][0] for c in CORNERS]), -min(p['pos'][:, 1].min() for p in tyres), 0.0])
    for p in rig_parts:
        p['pos'] = p['pos'] + shift
    if steer:
        steer['pivot'] = steer['pivot'] + shift

    wheel_centres, tyre_radius, tyre_half_width = {}, {}, {}
    for axle in ('F', 'R'):
        lc, rc = centres0['L' + axle] + shift, centres0['R' + axle] + shift
        x, y, z = 0.5 * (lc[0] - rc[0]), 0.5 * (lc[1] + rc[1]), 0.5 * (lc[2] + rc[2])
        wheel_centres['WHEEL_L' + axle] = [round(float(x), 5), round(float(y), 5), round(float(z), 5)]
        wheel_centres['WHEEL_R' + axle] = [round(float(-x), 5), round(float(y), 5), round(float(z), 5)]
        for side in 'LR':
            tyre_radius[side + axle] = round(0.5 * (wheels['L' + axle]['radius'] + wheels['R' + axle]['radius']), 5)
            tyre_half_width[side + axle] = round(0.25 * (wheels['L' + axle]['width'] + wheels['R' + axle]['width']), 5)

    # ---- Liveries: `<name>-<skin>.<ext>` beside the textures the body, driver and wheels use
    used_tex = sorted({p['texture'] for p in rig_parts if p['texture'] and p['kind'] != 'steer'})
    used_stems = {os.path.splitext(os.path.basename(t))[0].lower() for t in used_tex}
    not_skins = {os.path.splitext(os.path.basename(P.str(G, k) or ''))[0].lower() for k in ('tachometer texture', 'speedometer texture')}
    files = os.listdir(car_dir)
    skin_ids = set()
    pat = re.compile(rf'^{re.escape(car)}-(.+)\.(png|jpe?g|rgb|bmp|tga)$', re.I)
    for f in files:
        m = pat.match(f)
        if not m:
            continue
        sid = m.group(1)
        if sid.lower() == 'preview' or sid.lower().endswith('-preview') or f'{car}-{sid}'.lower() in used_stems or f'{car}-{sid}'.lower() in not_skins:
            continue
        if sid.lower() in ('int', 'rpm', 'speed', 'src', 'template'):
            continue
        skin_ids.add(sid)
    skin_ids = sorted(skin_ids)

    def skin_file(tex, sid):
        stem, ext = os.path.splitext(os.path.basename(tex))
        for cand in (f'{stem}-{sid}{ext}', f'{stem}-{sid}.png'):
            if os.path.isfile(os.path.join(car_dir, cand)):
                return os.path.join(car_dir, cand)
        return None

    skinned_tex = [t for t in used_tex if any(skin_file(t, s) for s in skin_ids)]

    # ---- Materials and meshes
    writer = GlbWriter(use_quantization=False)
    writer.j['asset']['generator'] = 'scripts/cars/port_sd_car.py'
    pool = Textures(writer, finder, a.max_tex, a.small_tex, a.jpeg_quality)
    main_tex = next((t for t in used_tex if os.path.splitext(os.path.basename(t))[0].lower() == car.lower()), used_tex[0] if used_tex else None)
    mat_index = {}
    counts = {}
    skin_maps = {}
    missing_tex = set()

    def material(p, acmat_i):
        acm = p['acmats'][acmat_i] if acmat_i < len(p['acmats']) else dict(name='', rgb=[1, 1, 1], spec=[0, 0, 0], shi=20, trans=0)
        blended = bool(TRANSPARENT_NAME.match(p['name'] or '')) or acm['trans'] > 0
        cls = object_class(p['name'], p['texture'], p['kind'])
        key = (p['texture'], cls, blended, tuple(np.round(acm['rgb'], 3)), round(acm['trans'], 3), round(acm['shi']))
        if key in mat_index:
            return mat_index[key]
        tex = None
        if p['texture']:
            tex = pool.index(p['texture'], alpha=blended, big=p['texture'] == main_tex)
            if tex is None:
                missing_tex.add(p['texture'])
        # A shiny surface (high `shi`) is a smooth one
        rough = float(np.clip(1.0 - math.sqrt(max(acm['shi'], 0.0) / 128.0), 0.15, 0.9))
        pbr = {'baseColorFactor': [round(float(v), 4) for v in srgb_to_linear(np.array(acm['rgb']) * 255)] + [round(1.0 - acm['trans'], 4)],
               'metallicFactor': 0.6 if cls in ('rim', 'metal') else 0.0, 'roughnessFactor': rough if cls not in ('tyre',) else 0.85}
        if tex is not None:
            pbr['baseColorTexture'] = {'index': tex}
        counts[cls] = counts.get(cls, 0) + 1
        gm = {'name': f'{cls}_{counts[cls]:02d}', 'pbrMetallicRoughness': pbr}
        if blended:
            gm['alphaMode'] = 'BLEND'
        writer.j['materials'].append(gm)
        mi = len(writer.j['materials']) - 1
        mat_index[key] = mi
        if p['texture'] in skinned_tex:
            stem = re.sub(r'[^A-Za-z0-9]+', '_', os.path.splitext(os.path.basename(p['texture']))[0]).strip('_').lower()
            skin_maps[gm['name']] = f'{stem}.png' if blended else f'{stem}.jpg'
        return mi

    def prims(group, origin=None, to_local=None, one=False):
        """One primitive per glTF material over `group`; `one`: everything in the first's material (a tyre)"""
        by_mat = {}
        for p in group:
            for ami in np.unique(p['mats']):
                sel = p['mats'] == ami
                for two in (False, True):
                    s2 = sel & (p['two'] == two)
                    if s2.any():
                        mi = material(p, int(ami))
                        by_mat.setdefault(mi, []).append((p, s2, two))
        if one and by_mat:
            first = sorted(by_mat)[0]
            by_mat = {first: [x for v in by_mat.values() for x in v]}
        out = []
        for mi in sorted(by_mat):
            items = []
            double = False
            for p, sel, two in by_mat[mi]:
                used = np.unique(p['tris'][sel])
                remap = -np.ones(len(p['pos']), np.int64)
                remap[used] = np.arange(len(used))
                items.append((p['pos'][used], p['nrm'][used], p['uv'][used].astype(np.float32), remap[p['tris'][sel]].astype(np.uint32)))
                double = double or two
            pos, nrm, uv, tris = merge(items)
            if origin is not None:
                pos = pos - origin
            if to_local is not None:
                pos = pos @ to_local[:3, :3].T + to_local[:3, 3]
                nrm = nrm @ to_local[:3, :3].T
            if double and not writer.j['materials'][mi]['name'].startswith('driver'):
                writer.j['materials'][mi]['doubleSided'] = True
            out.append((mi, writer.add_primitive(pos, nrm, uv, tris, mi)))
        return out

    wheel_nodes = []
    for c in CORNERS:
        centre = np.array(wheel_centres[f'WHEEL_{c}'])
        (_, tyre_prim), = prims([p for p in rig_parts if p['kind'] == 'tyre' and p['corner'] == c], origin=centre, one=True)
        tyre_node = writer.add_mesh_node(f'WHEEL_{c}_TYRE', [tyre_prim])
        rim_prims = [pi for _, pi in prims([p for p in rig_parts if p['kind'] == 'rim' and p['corner'] == c], origin=centre)]
        rim_node = writer.add_mesh_node(f'WHEEL_{c}_RIM', rim_prims)
        wheel_nodes.append(writer.add_node(f'WHEEL_{c}', children=[rim_node, tyre_node], translation=centre))

    body_kids = [writer.add_mesh_node(f'BODY_{writer.j["materials"][mi]["name"]}', [pi])
                 for mi, pi in prims([p for p in rig_parts if p['kind'] == 'body'])]
    driver_parts = [p for p in rig_parts if p['kind'] == 'driver']
    if driver_parts:
        body_kids.append(writer.add_node('DRIVER', children=[writer.add_mesh_node(f'DRIVER_{writer.j["materials"][mi]["name"]}', [pi])
                                                             for mi, pi in prims(driver_parts)]))
    body_node = writer.add_node('BODY', children=body_kids)
    children = [body_node]
    if steer:
        M = make_steer_frame(steer['pivot'], steer['column'])
        to_steer = np.linalg.inv(M)
        steer_kids = [writer.add_mesh_node(f'STEER_{writer.j["materials"][mi]["name"]}', [pi])
                      for mi, pi in prims([p for p in rig_parts if p['kind'] == 'steer'], to_local=to_steer)]
        children.append(writer.add_node('STEER', children=steer_kids, matrix=M))
    children += wheel_nodes

    # ---- Cameras: the XML's eye points; the others from the body's shape
    solid = np.vstack([p['pos'] for p in rig_parts if p['kind'] == 'body'])
    eyes = sd_to_rig([P.num('Driver', 'xpos', 0.0), P.num('Driver', 'ypos', 0.0), P.num('Driver', 'zpos', 0.8)]) + shift
    has_bonnet = 'Bonnet' in {k.split('/')[0] for k in P.s}
    bonnet = sd_to_rig([P.num('Bonnet', 'xpos', 0.0), P.num('Bonnet', 'ypos', 0.0), P.num('Bonnet', 'zpos', 0.8)]) + shift

    def top_y(x, z, half=0.08):
        m = (np.abs(solid[:, 0] - x) < half) & (np.abs(solid[:, 2] - z) < half)
        return float(solid[m, 1].max()) if m.any() else float(solid[:, 1].max())

    nose_z = float(solid[:, 2].max())
    length = float(solid[:, 2].max() - solid[:, 2].min())
    bumper_y = top_y(0.0, nose_z - 0.12, half=0.12) + 0.06
    over_head = top_y(float(eyes[0]), float(eyes[2]), half=0.25)
    far = max(1.0, length / 4.6)
    r3 = lambda v: [round(float(x), 3) for x in v]  # noqa: E731
    # The XML's bonnet view: ahead of the driver it is a dash or bonnet camera; behind him (an open-wheeler's airbox
    # camera) it is the T-cam
    own_bonnet = has_bonnet and np.linalg.norm(bonnet - eyes) > 0.05
    behind = own_bonnet and bonnet[2] < eyes[2]
    dash = bonnet if own_bonnet and not behind else eyes + np.array([0.0, -0.06, 0.35])
    tcam = bonnet if behind else np.array([0.0, max(over_head, float(eyes[1])) + 0.22, float(eyes[2]) - 0.13])
    cameras = {
        'cockpit': {'pos': r3(eyes), 'pitchDeg': -2.0, 'fov': 60},
        'tcam': {'pos': r3(tcam), 'pitchDeg': -6.0 if behind else -8.0, 'fov': 60},
        'dash': {'pos': r3(dash), 'pitchDeg': -3.0, 'fov': 60},
        'bumper': {'pos': r3([0.0, bumper_y, nose_z - 0.05]), 'pitchDeg': -2.0, 'fov': 60},
        'nearChase': {'pos': r3([0.0, 2.1, -5.3 * far]), 'pitchDeg': -10, 'fov': 60},
        'farChase': {'pos': r3([0.0, 2.6, -7.3 * far]), 'pitchDeg': -10, 'fov': 60},
    }

    lf, rf, lr, rr = (wheel_centres[f'WHEEL_{c}'] for c in ('LF', 'RF', 'LR', 'RR'))
    extras = {
        'wheelCentres': wheel_centres,
        'tyreRadius': tyre_radius,
        'tyreHalfWidth': tyre_half_width,
        'wheelbaseM': round(lf[2] - lr[2], 5),
        'trackWidthM': {'front': round(lf[0] - rf[0], 5), 'rear': round(lr[0] - rr[0], 5)},
        **({'steer': {'pivot': r3(steer['pivot']), 'columnAxis': [round(float(v), 5) for v in steer['column']]}} if steer else {}),
        'cameras': cameras,
        **({'skinMaps': dict(sorted(skin_maps.items()))} if skin_maps else {}),
        'source': {'title': car, 'model': os.path.basename(body_path), 'converted': 'scripts/cars/port_sd_car.py'},
    }
    root = writer.add_node('CAR', children=children, extras=extras)
    # Not 'CAR': three's GLTFLoader names the scene first, so the root node would load as CAR_1
    writer.j['scenes'][0] = {'name': 'Scene', 'nodes': [root]}
    writer.j['asset']['extras'] = extras['source']
    writer.save(a.out)
    for t in sorted(missing_tex):
        warnings.append(f'texture {t} not found (left untextured, as the game draws it)')

    # ---- Liveries as files, named as skinMaps names them
    liveries = []

    def swatch_of(path):
        try:
            return paint_swatch(Image.open(path))
        except Exception:  # noqa: BLE001
            return ['#808080', '#202020']

    def write_livery_file(src_img, out_path, blended, big):
        data, _, _ = pool.encode(src_img, a.max_tex if big else a.small_tex, blended)
        with open(out_path, 'wb') as f:
            f.write(data)

    if a.skins_out and skin_maps:
        files_of = {}
        for mname, fname in skin_maps.items():
            files_of[fname] = next(t for t in skinned_tex if re.sub(r'[^A-Za-z0-9]+', '_', os.path.splitext(os.path.basename(t))[0]).strip('_').lower() == os.path.splitext(fname)[0])
        for sid in skin_ids:
            d = os.path.join(a.skins_out, sid)
            os.makedirs(d, exist_ok=True)
            for fname, tex in sorted(files_of.items()):
                src = skin_file(tex, sid) or finder.find(tex)
                im = Image.open(src)
                im.load()
                write_livery_file(im.convert('RGBA'), os.path.join(d, fname), fname.endswith('.png'), tex == main_tex)
            prev = os.path.join(car_dir, f'{car}-{sid}-preview.jpg')
            if os.path.isfile(prev):
                save_thumb(prev, os.path.join(d, 'thumb.webp'))
            main_skin = skin_file(main_tex, sid) if main_tex else None
            liveries.append({'id': sid, 'name': sid.replace('-', ' ').replace('_', ' ').title(), 'dir': d,
                             'swatch': swatch_of(main_skin) if main_skin else ['#808080', '#202020']})

    thumb = None
    prev = os.path.join(car_dir, f'{car}-preview.jpg')
    if a.thumb and os.path.isfile(prev):
        save_thumb(prev, a.thumb)
        thumb = a.thumb
    main_path = finder.find(main_tex) if main_tex else None

    nverts = sum(len(p['pos']) for p in rig_parts)
    ntris = sum(len(p['tris']) for p in rig_parts)
    print(f'wrote {a.out} ({os.path.getsize(a.out) / 1e6:.2f} MB): {len(body_kids)} body meshes, '
          f'{"a steering wheel, " if steer else ""}{"a driver, " if driver_parts else ""}4 wheels; {nverts} vertices, {ntris} triangles; '
          f'{len(writer.j["materials"])} materials, {len(pool.stats)} textures')
    print(f'  wheelbase {extras["wheelbaseM"]:.3f} m, track {extras["trackWidthM"]}, tyre radius {tyre_radius}, liveries {skin_ids}')
    for w in warnings:
        print(f'  note: {w}')
    if a.info:
        info = {
            'extras': extras,
            'paint': {'id': 'standard', 'name': 'Standard', 'swatch': swatch_of(main_path) if main_path else ['#808080', '#202020']},
            'liveries': liveries,
            'thumb': thumb,
            'skinIds': skin_ids,
            'mainTexture': main_tex,
            'steeringWheel': bool(steer),
            'driver': bool(driver_parts),
            'bodyBox': {'min': r3(solid.min(0)), 'max': r3(solid.max(0))},
            'bodyPlan': body_plan(np.vstack([p['pos'] for p in rig_parts if p['kind'] in ('body', 'driver')]),
                                  0.5 * (wheel_centres['WHEEL_LF'][2] + wheel_centres['WHEEL_LR'][2])),
            'shift': r3(shift),
            'warnings': warnings,
        }
        with open(a.info, 'w', encoding='utf-8') as f:
            json.dump(info, f, indent=2)


def find_steering_wheel(parts, eyes):
    """The body's steering wheel: among the body's separate pieces (vertices shared by position), the flat one a steering
    wheel's size (22 to 45 cm across, at most 12 cm deep) between 20 and 85 cm ahead of `eyes` and up to 55 cm under
    them, nearest the usual place, 45 cm ahead and 25 cm under. ([part indices], [triangle masks], centre, column axis)
    in rig axes, or None"""
    want = eyes + np.array([0.0, -0.25, 0.45])
    best = None
    for i, p in enumerate(parts):
        if p['kind'] != 'body' or not len(p['tris']):
            continue
        pos, tris = p['pos'], p['tris']
        near = (pos[:, 2] > eyes[2] + 0.2) & (pos[:, 2] < eyes[2] + 0.85) & (pos[:, 1] < eyes[1]) & (pos[:, 1] > eyes[1] - 0.55) & \
               (np.abs(pos[:, 0] - eyes[0]) < 0.3)
        if not near[tris].all(1).any():
            continue
        # Pieces: triangles joined through vertices at the same place
        _, key = np.unique(np.round(pos, 4), axis=0, return_inverse=True)
        key = key.reshape(-1)
        parent = np.arange(key.max() + 1)

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for a, b, c in key[tris]:
            ra, rb, rc = find(a), find(b), find(c)
            parent[rb] = ra
            parent[find(rc)] = ra
        roots = np.array([find(k) for k in key[tris[:, 0]]])
        for r in np.unique(roots):
            mask = roots == r
            pts = pos[np.unique(tris[mask])]
            if len(pts) < 12 or not near[tris[mask]].all():
                continue
            c = pts.mean(0)
            _, sv, vt = np.linalg.svd(pts - c, full_matrices=False)
            extent = np.ptp((pts - c) @ vt.T, axis=0)
            if not (0.22 <= extent[0] <= 0.45 and 0.22 <= extent[1] <= 0.45 and extent[2] <= 0.12):
                continue
            centre = 0.5 * (pts.min(0) + pts.max(0))
            d = float(np.linalg.norm(centre - want))
            if best is None or d < best[0]:
                axis = vt[2] if vt[2][2] > 0 else -vt[2]
                best = (d, i, mask, centre, axis)
    if best is None:
        return None
    _, i, mask, centre, axis = best
    return [i], [mask], centre, axis


def body_plan(pts, mid_z):
    """The body's outline at barrier height, as scripts/cars/measure-car-plans.ts measures it: points 8 cm to 0.8 m above the
    body's floor, folded onto the right half and hulled, from the nose round to the tail, simplified to within 5 cm, as
    [half width, z from the axles' midpoint]"""
    floor = pts[:, 1].min()
    band = pts[(pts[:, 1] >= floor + 0.08) & (pts[:, 1] <= floor + 0.8)]
    if len(band) < 3:
        return None
    half = [(abs(float(x)), float(z) - mid_z) for x, _, z in band]
    nose = max(q[1] for q in half)
    tail = min(q[1] for q in half)
    half += [(0.0, nose), (0.0, tail)]
    ps = sorted(set(half))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])  # noqa: E731
    lo, up = [], []
    for q in ps:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], q) <= 0:
            lo.pop()
        lo.append(q)
    for q in reversed(ps):
        while len(up) >= 2 and cross(up[-2], up[-1], q) <= 0:
            up.pop()
        up.append(q)
    h = lo[:-1] + up[:-1]
    top = h.index((0.0, nose))
    chain = [h[top]]
    for k in range(1, len(h)):
        q = h[(top - k) % len(h)]
        chain.append(q)
        if q[0] == 0:
            break
    if chain[1][0] == 0:
        chain.reverse()

    def simplify(c, tol):
        if len(c) <= 2:
            return c
        (ax, az), (bx, bz) = c[0], c[-1]
        dx, dz = bx - ax, bz - az
        ln = math.hypot(dx, dz) or 1.0
        d = [abs((q[0] - ax) * dz - (q[1] - az) * dx) / ln for q in c[1:-1]]
        i = int(np.argmax(d)) + 1
        if d[i - 1] <= tol:
            return [c[0], c[-1]]
        return simplify(c[:i + 1], tol)[:-1] + simplify(c[i:], tol)

    plan = [[round(q[0], 2), round(q[1], 2)] for q in simplify(chain, 0.05)]
    return plan if 3 <= len(plan) <= 64 else None


def save_thumb(src, out):
    """The car browser's picture: the preview cropped to 16:9 at 960 x 540"""
    im = Image.open(src).convert('RGB')
    w, h = im.size
    if w / h > 16 / 9:
        nw = round(h * 16 / 9)
        im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = round(w * 9 / 16)
        im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    im.resize((960, 540), Image.LANCZOS).save(out, format='WEBP', quality=82)


if __name__ == '__main__':
    with np.errstate(all='ignore'):
        main()
