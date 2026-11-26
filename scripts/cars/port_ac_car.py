"""Port an Assetto Corsa car (.kn5 + one skin) into LibreCorsa's ported-car GLB layout.

usage: python -P scripts/cars/port_ac_car.py <ac car folder> <out.glb> [--car liana] [--skin light_blue] [--kn5 x.kn5]

    uv run --python 3.14 --no-project --with numpy --with pillow python -P scripts/cars/port_ac_car.py \
      path/to/suzuki_liana public/cars/liana/model/liana.glb --skin light_blue
    uv run --python 3.14 --no-project --with numpy --with pillow python -P scripts/cars/port_ac_car.py \
      <unpacked MTRacing_496R.rar>/content/cars/mt_mtr_496r public/cars/mtr-496r/model/mtr-496r.glb

Each car has a preset (`PRESETS`): its material table, the nodes and materials it leaves out, the skin files that
override the kn5's, how its tyres and spinning parts are named, and its windscreen. `--car` picks one; by default the
car folder's name does, and a car with none gets an automatic one (`auto_preset`: found in the model, see there). The
reader, the hierarchy split, the multi-map paint bake and the camera reads are generic AC.
The car folder is read only. Its LODs (`<car>_B/C/D.kn5`), `collider.kn5`, damage, dirt and blur textures and the
blurred rims (`RIM_BLUR_*`) are left out.

Output node layout (read by src/lib/ported-car-model.ts):
    CAR (extras: wheelCentres, tyreRadius, tyreHalfWidth, wheelbaseM, trackWidthM, steer, cameras, source)
      BODY              body, cabin, glass and lights, one mesh per material
        MIRROR_n        a mirror mirrors.ini names ([MIRROR_n] NAME=<kn5 mesh>), its glass in a material of its own
                        (extras: mirror {node, kn5}); CAR's extras list them as `mirrors`
      STEER             steering wheel pivot (AC's STEER_HR: local +Z down the column into the dash); a preset's
                        `steer_nodes` (a screen, shift lights) are child nodes of their own, named as in the kn5
      WHEEL_RF          hub pivot at the tyre's centre
        WHEEL_RF_RIM    wheel, hubcap, brake disc / drum (one primitive per material); a car whose discs sit beside the
                        wheel (`DISC_RF`, the preset's `spinning`) has them here too
        WHEEL_RF_TYRE   tyre, one primitive (the tyre deformation shader)
      WHEEL_LF / WHEEL_RR / WHEEL_LR
      HUB_RF            what hangs off the corner's SUSP_RF (upright, calliper, a fixed hub fairing), at the tyre's
                        centre: steered and sprung with the wheel, not spinning (only where the kn5 has any)

Axes: AC's kn5 frame is already the rig's (+X left, +Y up, +Z forward, metres, right-handed, counter-clockwise
faces), so the only change is a shift: lowest tyre point to y = 0, X centred on the wheels.

Paint: the body's ksPerPixelMultiMap shader multiplies its diffuse by the skin's detail colour where the diffuse alpha
is 0 (`diffuse * (detail * (1 - a) + a)`, sampled in AC's gamma space); `bake_multimap` bakes that into one opaque
colour texture, so the paint carries the skin's colour and the badges (alpha 1) their own.
"""
import argparse
import configparser
import hashlib
import io
import json
import math
import os
import re
import struct
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from port_sketchfab_gt3 import GlbWriter, make_steer_frame  # noqa: E402

CORNERS = ('RF', 'LF', 'RR', 'LR')

# ---------------------------------------------------------------------------------------------------------------------
# KN5 reader (a copy of scripts/tracks/port_ac_track.py's, recording each node's parent)
# ---------------------------------------------------------------------------------------------------------------------


class _Reader:
    def __init__(self, data):
        self.b = memoryview(data)
        self.o = 0

    def take(self, n):
        v = self.b[self.o:self.o + n]
        self.o += n
        return v

    def i32(self):
        return struct.unpack('<i', self.take(4))[0]

    def u8(self):
        return self.take(1)[0]

    def f32(self, n=1):
        v = np.frombuffer(self.take(4 * n), '<f4').astype(np.float64)
        return v[0] if n == 1 else v

    def str(self):
        return bytes(self.take(self.i32())).decode('utf-8', 'replace')


def read_kn5(path):
    """Textures {name: bytes}, materials [{name, shader, blend, alpha_tested, props, maps}] and nodes (depth-first) with
    `parent` (index or None), `active` (own flag and every ancestor's), `world` (4x4), `local` (4x4, a transform node's
    own) and `mesh`. A skinned mesh (a driver's suit) also has `bones` ([(node name, inverse bind 4x4)]), `joints` and
    `weights` (4 per vertex, the joints as indices into `bones`)."""
    r = _Reader(open(path, 'rb').read())
    if bytes(r.take(6)) != b'sc6969':
        raise ValueError(f'{path}: not a kn5 file')
    version = r.i32()
    if version > 5:
        r.i32()
    textures = {}
    for _ in range(r.i32()):
        r.i32()
        tname = r.str()
        textures[tname] = bytes(r.take(r.i32()))
    materials = []
    for _ in range(r.i32()):
        mname, shader = r.str(), r.str()
        blend, tested = r.u8(), bool(r.u8())
        r.i32()
        props = {}
        for _ in range(r.i32()):
            pname = r.str()
            props[pname] = float(r.f32())
            r.f32(9)
        maps = {}
        for _ in range(r.i32()):
            slot = r.str()
            r.i32()
            maps[slot] = r.str()
        materials.append({'name': mname, 'shader': shader, 'blend': blend, 'alpha_tested': tested, 'props': props,
                          'maps': maps})

    nodes = []

    def parse_node(parent_mat, parent_active, parent):
        kind = r.i32()
        name = r.str()
        nchild = r.i32()
        active = bool(r.u8()) and parent_active
        mat4 = parent_mat
        local = np.eye(4)
        mesh = None
        bones = None
        if kind == 1:
            local = r.f32(16).reshape(4, 4).T
            mat4 = parent_mat @ local
        elif kind in (2, 3):
            r.u8()  # cast shadows
            visible, transparent = bool(r.u8()), bool(r.u8())
            if kind == 3:  # skinned: bone names and inverse bind matrices
                bones = [(r.str(), r.f32(16).reshape(4, 4).T) for _ in range(r.i32())]
            n = r.i32()
            stride = 44 if kind == 2 else 76
            v = np.frombuffer(r.take(n * stride), '<f4').reshape(n, stride // 4).astype(np.float32)
            idx = np.frombuffer(r.take(r.i32() * 2), '<u2').copy()
            mat_idx = r.i32()
            r.i32()
            r.take(8)
            renderable = True
            if kind == 2:
                r.take(16)
                renderable = bool(r.u8())
            mesh = {'pos': v[:, 0:3], 'nrm': v[:, 3:6], 'uv': v[:, 6:8], 'idx': idx, 'mat': mat_idx,
                    'visible': visible, 'transparent': transparent, 'renderable': renderable}
            if bones is not None:
                # After the tangent: 4 weights, then 4 joints (as floats)
                mesh.update(bones=bones, weights=v[:, 11:15].copy(), joints=v[:, 15:19].copy())
        me = len(nodes)
        nodes.append({'name': name, 'kind': kind, 'active': active, 'world': mat4, 'local': local, 'mesh': mesh,
                      'parent': parent})
        for _ in range(nchild):
            parse_node(mat4, active, me)

    parse_node(np.eye(4), True, None)
    return textures, materials, nodes


def ancestors(nodes, i):
    out = []
    p = nodes[i]['parent']
    while p is not None:
        out.append(nodes[p]['name'])
        p = nodes[p]['parent']
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Car data (data/ folder, else data.acd: Assetto Corsa's per-folder key, as Content Manager unpacks it)
# ---------------------------------------------------------------------------------------------------------------------


def _i32(x):
    x &= 0xFFFFFFFF
    return x - (1 << 32) if x & 0x80000000 else x


def _cdiv(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def acd_key(folder_name):
    s = [ord(c) for c in folder_name.lower()]
    n = len(s)
    k = [_i32(sum(s)), 0, 0, -125, 66, 101, 171, 171]
    for i in range(0, n - 1, 2):
        k[1] = _i32(_i32(s[i] * k[1]) - s[i + 1])
    for i in range(1, n - 3, 3):
        k[2] = _i32(-27 - s[i - 1] + _cdiv(_i32(s[i] * k[2]), s[i + 1] + 27))
    for i in range(1, n):
        k[3] = _i32(k[3] - s[i])
    for i in range(1, n - 4, 4):
        k[4] = _i32(_i32((s[i - 1] + 15) * _i32((s[i] + 15) * k[4])) + 22)
    for i in range(0, n - 2, 2):
        k[5] = _i32(k[5] - s[i])
    for i in range(0, n - 2, 2):
        k[6] = k[6] - _cdiv(k[6], s[i]) * s[i]
    for i in range(0, n - 1):
        k[7] = _i32(_cdiv(k[7], s[i]) + s[i + 1])
    return '-'.join(str(v & 0xFF) for v in k)


def read_car_data(car_dir):
    """{file name: text} from the car's data folder or data.acd ({} when neither is there)"""
    data_dir = os.path.join(car_dir, 'data')
    if os.path.isdir(data_dir):
        # Its files: a folder in it (a mod's backup, its extension data) is no file of the car's data
        return {f: open(os.path.join(data_dir, f), 'rb').read().decode('latin1') for f in os.listdir(data_dir)
                if os.path.isfile(os.path.join(data_dir, f))}
    acd = os.path.join(car_dir, 'data.acd')
    if not os.path.isfile(acd):
        return {}
    key = [ord(c) for c in acd_key(os.path.basename(os.path.normpath(car_dir)))]
    d = open(acd, 'rb').read()
    out, o = {}, 0
    while o < len(d):
        nl = struct.unpack_from('<i', d, o)[0]
        o += 4
        if nl < 0:  # versioned archives start with a header word
            o += 4
            continue
        name = d[o:o + nl].decode('latin1')
        o += nl
        dl = struct.unpack_from('<i', d, o)[0]
        o += 4
        raw = np.frombuffer(d, np.uint8, dl * 4, o)[::4].astype(np.int32)
        o += dl * 4
        keys = np.resize(np.array(key, np.int32), dl)
        out[name] = ((raw - keys) & 0xFF).astype(np.uint8).tobytes().decode('latin1')
    return out


def ini(text):
    """An AC INI file as AC reads it: a byte-order mark (read as latin-1, or as text), lines before the first section
    and lines that are no `key=value` are let pass"""
    cp = configparser.ConfigParser(inline_comment_prefixes=(';',), strict=False, interpolation=None)
    cp.optionxform = str
    text = text.removeprefix('\ufeff').removeprefix('\xef\xbb\xbf')
    head = re.search(r'^\s*\[', text, re.M)
    try:
        cp.read_string(text[head.start():] if head else '')
    except configparser.ParsingError:
        # Raised once the file is read: every line it could read is in `cp`
        pass
    return cp


def vec3(s):
    return [float(v) for v in s.replace(' ', '').split(',')[:3]]


# ---------------------------------------------------------------------------------------------------------------------
# Materials. AC's ks* shaders mostly use flat 32 px colour textures and their reflection settings; glTF gets constant
# factors for those and real textures only where a map carries detail. The GLB names steer the rig's material clean-up
# (src/lib/render/ported-car-materials.ts classifies by name: *paint*/*body* -> paint, *glass*/*light* -> kept as
# authored, *tyre*/*rubber* -> rubber, *chrome*/*metal*/*steel*/*brake*/*hub* -> metal, *mirror* -> mirror).
# color: sRGB 0-255 (factor, or tint over the texture); tex: a texture key from `TexturePool.colour`; detail: the
# material's ksPerPixelMultiMap detail map (carbon weave) as its colour, its UVs scaled by its detailUVMultiplier;
# mode: OPAQUE / MASK (AC's alpha-tested shaders) / BLEND
# ---------------------------------------------------------------------------------------------------------------------

LIANA_MATERIALS = {
    # Exterior
    'body': dict(name='liana_body_paint', tex='bake:body', metal=0.0, rough=0.25),
    'caliper': dict(name='brake_caliper', tex='bake:body', metal=0.6, rough=0.5),
    'rotor': dict(name='brake_disc', tex='bake:body', metal=1.0, rough=0.35),
    'emblem': dict(name='emblem_chrome', tex='bake:body', metal=1.0, rough=0.2),
    'misc': dict(name='badge_chrome', tex='bake:body', metal=1.0, rough=0.2),
    'defrost_lines': dict(name='defrost_lines', tex='crop:nodamage_lod0.dds', metal=0.0, rough=0.4, mode='BLEND'),
    'black': dict(name='black_trim', color=(38, 38, 38), rough=0.6),
    'frame': dict(name='black_frame', color=(35, 35, 35), rough=0.55),
    'bumper_frame': dict(name='black_bumper_frame', color=(35, 35, 35), rough=0.6),
    'matte_colors': dict(name='matte_black', color=(30, 30, 30), rough=0.8),
    'plastic2': dict(name='black_plastic', color=(40, 40, 40), rough=0.5),
    'rubber_trim': dict(name='rubber_trim', color=(28, 28, 28), rough=0.85),
    'weatherstrip': dict(name='weatherstrip_rubber', color=(25, 25, 25), rough=0.9),
    'bottom': dict(name='underfloor_black', color=(20, 20, 20), rough=0.9),
    'undercarriage': dict(name='underfloor', color=(10, 10, 10), rough=0.9),
    'chrome': dict(name='chrome', color=(235, 235, 235), metal=1.0, rough=0.08),
    'chrome_2': dict(name='chrome_trim', color=(225, 225, 225), metal=1.0, rough=0.12, normal='lights_lod0_N.dds'),
    'mirrorMiddle': dict(name='mirror_face', color=(235, 235, 235), metal=1.0, rough=0.02),
    'black_glass': dict(name='black_glass', color=(12, 12, 12), rough=0.08),
    'window': dict(name='window_glass', color=(34, 52, 48), alpha=0.28, rough=0.05, mode='BLEND', double=True),
    'glass': dict(name='lens_glass', color=(240, 240, 240), alpha=0.12, rough=0.03, mode='BLEND', double=True),
    # Lamps keep their texture (lights_lod0.dds, alpha for the coloured lenses)
    'head_light': dict(name='head_light', tex='lights_lod0.dds', metal=0.5, rough=0.15, normal='lights_lod0_N.dds'),
    'tail_light_lod0': dict(name='tail_light', tex='lights_lod0.dds', rough=0.3, normal='lights_lod0_N.dds'),
    'reflector': dict(name='tail_light_reflector', tex='lights_lod0.dds', rough=0.25, normal='lights_lod0_N.dds'),
    'textured_reflector': dict(name='light_textured_reflector', tex='lights_lod0.dds', metal=0.3, rough=0.2,
                               normal='lights_lod0_N.dds'),
    'lights_glass': dict(name='reverse_light_glass', tex='lights_lod0.dds', rough=0.1),
    'reverse_light_lod0': dict(name='reverse_light', tex='lights_lod0.dds', rough=0.3),
    'detail_glass_amber': dict(name='light_glass_amber', tex='lights_lod0.dds', rough=0.05, mode='BLEND',
                               normal='lights_lod0_N.dds'),
    'detail_glass_red': dict(name='light_glass_red', tex='lights_lod0.dds', rough=0.05, mode='BLEND',
                             normal='lights_lod0_N.dds'),
    'detail_glass_clear': dict(name='light_glass_clear', tex='lights_lod0.dds', rough=0.05, mode='BLEND',
                               normal='lights_lod0_N.dds'),
    # Wheels
    'EXT_Tire': dict(name='tyre', tex='Gomma_unica_BASE.dds', rough=0.9, normal='Gomma_Base_NM.dds'),
    'rim': dict(name='hubcap', tex='wheel_lod0.dds', metal=0.0, rough=0.35),
    'outer_rim': dict(name='wheel_steel_outer', color=(45, 45, 45), metal=0.6, rough=0.45),
    'inner_rim': dict(name='wheel_steel_inner', color=(40, 40, 40), metal=0.6, rough=0.5),
    'wheel_black': dict(name='wheel_cover_black', color=(30, 30, 30), rough=0.6),
    'drum': dict(name='brake_drum', color=(60, 60, 60), metal=0.8, rough=0.55),
    'hub': dict(name='wheel_hub', color=(50, 50, 50), metal=0.8, rough=0.45),
    # Cabin
    'plastic': dict(name='interior_plastic', tex='bake:plastic', rough=0.6),
    'badge': dict(name='interior_decals', tex='interior_lod0.dds', rough=0.5, mode='BLEND'),
    'bump_plastic': dict(name='dash_grain_plastic', tex='plastic_classicgrain.dds', rough=0.65,
                         normal='Plastic_ClassicGrain_NRMII.dds'),
    'cloth': dict(name='seat_cloth', tex='common_cloth_grey_diffuse.dds', rough=0.95, normal='common_cloth_normals.dds'),
    'headliner': dict(name='headliner', tex='mean:interior_lod0.dds', rough=0.95),
    'leather': dict(name='leather_black', color=(30, 30, 30), rough=0.6),
    'metal': dict(name='interior_metal', color=(150, 150, 150), metal=1.0, rough=0.3),
    'mottled': dict(name='mottled_plastic', color=(45, 45, 45), rough=0.7),
    'reflector_cp': dict(name='interior_black_gloss', color=(40, 40, 40), rough=0.3),
    'rubber': dict(name='interior_rubber', color=(25, 25, 25), rough=0.9),
    'solid': dict(name='interior_black', color=(35, 35, 35), rough=0.6),
    'bump_leather': dict(name='steering_leather', tex='Leather_DIF.dds', rough=0.55, normal='Leather_DIF_NRM.dds'),
    'bump_plastic2': dict(name='steering_plastic', color=(90, 90, 90), rough=0.5, normal='PLASTICA_NRM.dds'),
    'Material #29': dict(name='digital_gauge_screen', color=(6, 6, 6), rough=0.2),
    'rpm': dict(name='gauge_tacho', tex='suz_liana_02_tach_static.png', rough=0.4, emissive=0.35),
    'Material #27': dict(name='gauge_fuel', tex='suz_liana_02_gas_static_a.png', rough=0.4, emissive=0.35),
    'rpm2': dict(name='gauge_black', color=(10, 10, 10), rough=0.4),
}

# The MTRacing 496R (munyuturbo). Its own bodywork is the MT_* materials; the tub, lamps, mirrors, cockpit, wheels and
# brakes keep the base car's material names (Material_CAR_*, Material_INT_*, INT_*, EXT_*)
MTR_496R_MATERIALS = {
    # Bodywork: the skin's paint (4096 px, its own AO baked in) under its multimap mask (the mirror housings and other
    # alpha-0 areas take the dark flake map's colour), carbon, trim and glass
    'MT_ext_carpaint': dict(name='mtr_body_paint', tex='bakemean:MT_ext_carpaint', metal=0.0, rough=0.25),
    'MT_carbon': dict(name='mtr_carbon', detail=True, color=(210, 210, 210), rough=0.3),
    'MT_ext_plastic': dict(name='black_trim', color=(30, 30, 30), rough=0.5),
    'MT_ext_rubber': dict(name='rubber_trim', color=(25, 25, 25), rough=0.85),
    'MT_metal': dict(name='trim_metal', color=(90, 90, 90), metal=1.0, rough=0.2),
    'MT_Exhaust': dict(name='exhaust_metal', color=(70, 70, 70), metal=1.0, rough=0.3),
    'MT_Exhaust_in': dict(name='exhaust_inner_black', color=(6, 6, 6), rough=0.9),
    'MT_black': dict(name='matte_black', color=(6, 6, 6), rough=0.9),
    'MT_ext_window': dict(name='window_glass', color=(34, 42, 46), alpha=0.3, rough=0.05, mode='BLEND', double=True),
    'MT_headlight_glass': dict(name='lens_glass', color=(240, 240, 240), alpha=0.12, rough=0.03, mode='BLEND',
                               double=True),
    'headlight_reflector': dict(name='headlight_chrome', color=(225, 225, 225), metal=1.0, rough=0.1),
    'MT_door_decals': dict(name='door_decals', tex='mt_door_decals.dds', rough=0.4, mode='MASK'),
    'MT_ext_hachimaki': dict(name='sunstrip_decal', tex='mt_hachimaki.dds', rough=0.3),
    'MT_int_hachimaki': dict(name='sunstrip_inner_decal', tex='mt_hachimaki.dds', rough=0.5, mode='BLEND'),
    'MT_net': dict(name='grille_mesh', tex='GRID.dds', rough=0.6, mode='MASK', double=True),
    'MT_radiator': dict(name='radiator', tex='Radiator_D.dds', rough=0.6),
    'MT_suspention_arm_metal': dict(name='suspension_arm_metal', tex='Suspention_Texture.dds', metal=0.5, rough=0.4),
    'LMH_lifting_hook_red_plastic': dict(name='lifting_hook_red', tex='Suspention_Texture.dds', rough=0.5),
    'MT_rear_suspention_decal': dict(name='rear_suspension_decal', tex='MT_Rear_Suspention_Decal.dds', rough=0.5,
                                     mode='MASK'),
    'MT_int_plastic': dict(name='mtr_interior_plastic', color=(36, 36, 36), rough=0.6),
    'Badge': dict(name='fuel_filler_badge', tex='Badge.dds', rough=0.5),
    # The base car's tub, lamps and mirrors
    'Material_CAR_transp': dict(name='lamp_glass', color=(230, 240, 240), alpha=0.15, rough=0.03, mode='BLEND',
                                double=True),
    'Material_CAR_lights': dict(name='tail_light', tex='lights_D_rear2.dds', rough=0.3),
    'Material_CAR_mirror': dict(name='mirror_face', color=(235, 235, 235), metal=1.0, rough=0.02),
    'Material_CAR_skin_body': dict(name='chassis_panels', tex='skin_D_orange_trasp.dds', rough=0.4),
    'Material_CAR_plastic': dict(name='chassis_plastic', tex='skin_D.dds', rough=0.5),
    'Material_CAR_gloss': dict(name='chassis_gloss', tex='skin_D.dds', rough=0.2),
    'Material_CAR__body_carbon': dict(name='tub_carbon', detail=True, color=(210, 210, 210), rough=0.35),
    'Material_CAR_mechanics': dict(name='chassis_mechanics', tex='mechanics.dds', rough=0.5, mode='MASK'),
    # Wheels and brakes
    'EXT_Tyre': dict(name='tyre', tex='tyre_d.dds', rough=0.9, normal='tyre_nm.dds'),
    'EXT_Rim': dict(name='rim_alloy', tex='Rim_D.dds', metal=0.6, rough=0.35),
    'EXT_Brake_disc': dict(name='brake_disc', tex='Brake_Disc_DIF.dds', metal=0.8, rough=0.45),
    'EXT_BrakeCaliper': dict(name='brake_caliper', tex='bake:EXT_BrakeCaliper', metal=0.4, rough=0.45),
    'EXT_Mechanics': dict(name='hub_mechanics', tex='EXT_Mechanics.dds', metal=0.5, rough=0.45),
    'EXT_Mechanics_multipmap_AT': dict(name='hub_mechanics_detail', tex='EXT_Mechanics.dds', metal=0.5, rough=0.45,
                                       mode='MASK'),
    # Cockpit
    'Material_INT_chrome': dict(name='interior_chrome', color=(120, 120, 120), metal=1.0, rough=0.2),
    'Material_INT_belt': dict(name='seat_belt', tex='Cockpit_Belt.dds', rough=0.9),
    'Material_INT_plastic_COLORS': dict(name='interior_colours', tex='COLORS_palette.dds', rough=0.5),
    'Material_INT_plastic_black_seats': dict(name='seat_black', color=(20, 20, 20), rough=0.7),
    'Material_INT_skin': dict(name='interior_carbon', detail=True, color=(210, 210, 210), rough=0.35),
    'INT_DETAILS_METAL_NM': dict(name='interior_metal_details', tex='INT_Details.dds', metal=0.6, rough=0.4),
    'INT_DETAILS_PLASTIC_NM': dict(name='interior_plastic_details', tex='INT_Details.dds', rough=0.5),
    'INT_DETAILS_ALU_NM': dict(name='interior_alu', tex='INT_Details.dds', metal=1.0, rough=0.3),
    'INT_DETAILS_METAL_AT_NM': dict(name='interior_metal_details_cut', tex='INT_Details.dds', metal=0.6, rough=0.4,
                                    mode='MASK'),
    'INT_DETAILS_CHROME_NM': dict(name='interior_chrome_details', tex='INT_Details.dds', metal=1.0, rough=0.2),
    'INT_Decals_logos_FLAT': dict(name='interior_decals', tex='INT_Decals.dds', rough=0.5, mode='MASK'),
    'INT_LED': dict(name='dash_led', tex='INT_LED.dds', rough=0.3, mode='MASK'),
    'INT_LEDS': dict(name='wheel_leds', tex='INT_LED_sq.dds', rough=0.3),
    'INT_LEDS_LIMITER': dict(name='wheel_limiter_leds', tex='INT_LED_sq.dds', rough=0.3),
    'INT_LCD': dict(name='wheel_lcd', tex='LCD.dds', rough=0.2, emissive=0.35),
    # The wheel's screen on its own: the game draws its live display over it (src/lib/render/steering-display.ts)
    'INT_LCD@GEO_LCD': dict(name='INT_DISPLAY', color=(8, 8, 10), rough=0.25),
    'INT_CARBON_STEER': dict(name='steering_carbon', detail=True, color=(210, 210, 210), rough=0.35),
    'INT_OCC_PLASTIC_Black': dict(name='steering_plastic', color=(40, 40, 40), rough=0.6),
    'INT_OCC_RUBBER_Rollbar': dict(name='steering_rubber_grip', color=(28, 28, 28), rough=0.9),
    'INT_OCC_CARBON_base': dict(name='cockpit_carbon', detail=True, color=(210, 210, 210), rough=0.4),
}

# Per car: its material table; the materials and nodes it leaves out; the skin files that override the kn5's; the name
# its tyre meshes start with; the nodes beside a wheel that spin with it (`<prefix><corner>`); its windscreen
# material(s), which place the dash camera
PRESETS = {
    'liana': dict(
        title='Suzuki Liana',
        materials=LIANA_MATERIALS,
        # The blurred rims (inactive in AC, shown above 30 km/h), the 32 shift-light quads
        skip_materials={'blur_rim', 'blur_lip', 'motec_trasp_fx'},
        skip_node_prefixes=('LED_',),
        skip_nodes=(),
        # The body's ksPerPixelMultiMap detail map
        skin_files=('MAT_plancia.dds',),
        default_skin='light_blue',
        steer_nodes=(),
        skin_maps={},
        tyre_prefix='object__90',
        spinning=(),
        windscreen=('window',),
    ),
    'mtr-496r': dict(
        title='MTRacing 496R',
        materials=MTR_496R_MATERIALS,
        # The windscreen's inner face (a near-clear second layer) and the blur rims; the belts drawn fastened round a
        # driver the car doesn't carry (CINTURE_OFF, the belts lying on the seat, stays)
        skip_materials={'MT_int_window', 'EXT_Rim_Blur', 'EXT_Rim_Blur_Alfa', 'DAMAGE_GLASS'},
        skip_node_prefixes=(),
        skip_nodes=('CINTURE_ON',),
        skin_files=('skin.dds', 'skin_MAP.dds', 'mt_door_decals.dds', 'mt_hachimaki.dds'),
        default_skin='04_mtrgreen_metallic',
        # The wheel's screen and its shift lights (digital_instruments.ini's RPM_* LEDs) as nodes of their own, so the
        # game can draw the screen and light each LED
        steer_nodes=('GEO_LCD', 'RPM_'),
        # What a livery changes, as files beside the model (`--skins-out`): kn5 material -> (file, how it is made). The
        # game swaps these onto the GLB materials of the same names (extras.skinMaps) for the skin a player picks
        skin_maps={
            'MT_ext_carpaint': ('paint.jpg', 'bakemean'),
            'MT_door_decals': ('decals.png', 'diffuse'),
            'MT_ext_hachimaki': ('sunstrip.png', 'diffuse'),
            'MT_int_hachimaki': ('sunstrip.png', 'diffuse'),
        },
        tyre_prefix='g_Tyre_',
        spinning=('DISC_',),
        windscreen=('MT_ext_window',),
    ),
    # gregsediting's (Greg_ST's) JGTC and JTCC Nissans. `auto`: every material comes from its AC shader values (`auto_spec`), so the
    # preset names only the paint, the tyres, what is left out and what a livery replaces
    'nissan-r33-jgtc': dict(
        title='Nissan Skyline GT-R BCNR33 JGTC',
        auto=True,
        materials={},
        paint=('body_paint',),
        skip_materials=set(),
        skip_node_prefixes=(),
        skip_nodes=('COCKPIT_LR',),
        default_skin='23_pennzoil',
        steer_nodes=(),
        tyre_materials=('EXT_Front_Tyres', 'EXT_Rear_Tyres'),
        tyre_prefix=None,
        spinning=(),
        windscreen=('Glass_Windsceen_EX',),
        skin_textures=('car_paint.dds', 'EXT_Banner.dds', 'rim_color.dds', 'calipers_color.dds'),
    ),
    'nissan-r32-jtcc': dict(
        title='Nissan Skyline GT-R R32 JTCC',
        auto=True,
        materials={},
        paint=('body',),
        skip_materials=set(),
        skip_node_prefixes=(),
        # The belts drawn fastened round a driver the car doesn't carry
        skip_nodes=('COCKPIT_LR', 'CINTURE_ON'),
        default_skin='12_calsonic_skyline',
        steer_nodes=(),
        tyre_materials=('EXT_Tyre',),
        tyre_prefix=None,
        spinning=(),
        windscreen=('Glass_OUT',),
        # The paint, window stickers and wheels, and the cockpit's team colours and dash decals
        skin_textures=('EXT_Skin_Colour.dds', 'window_sticker.dds', 'wheel_detail_color.dds', 'rim.dds',
                       'dashboard_decals.dds', 'steer_center.dds', 'rollcage_color.dds', 'interior_metal_color.dds'),
    ),
    # Pfalzdriver's Scirocco and M1 Procar
    'vw-scirocco-gtx': dict(
        title='Volkswagen Scirocco GTX 16V',
        auto=True,
        materials={},
        paint=('carpaint',),
        # The broken-glass layers AC shows only once a window is smashed
        skip_materials={'DAMAGE_GLASS'},
        skip_node_prefixes=(),
        skip_nodes=('COCKPIT_LR',),
        default_skin='Mars Red',
        steer_nodes=(),
        tyre_materials=('WHEEL_TYRE',),
        tyre_prefix=None,
        spinning=(),
        windscreen=('Ext_Glass',),
        # The paint colour is the body's detail map; the plates, glass tint, bumper, grille and lamp colours vary too
        skin_textures=('metal_detail.dds', 'Plate_D.dds', 'ext_glass.dds', 'bumper_color.dds', 'grille_color.dds',
                       '1aoplastic1.dds', 'amber_tail.dds'),
    ),
    'bmw-m1-procar': dict(
        title='BMW M1 Procar',
        auto=True,
        materials={},
        paint=('bmw_m1_paint_bodywork2__Bodywork_',),
        # The broken-glass layers AC shows only once a window is smashed (the front indicators' glass among them)
        skip_materials={'DAMAGE_GLASS', 'DAMAGE_GLASS.001'},
        skip_node_prefixes=(),
        # The belts drawn fastened round a driver the car doesn't carry
        skip_nodes=('COCKPIT_LR', 'CINTURE_ON'),
        default_skin='1979_Procar_Piquet_6',
        steer_nodes=(),
        tyre_materials=('bmw_m1_tyre_Tyres',),
        tyre_prefix=None,
        spinning=(),
        windscreen=('EXT_GLASS',),
        # The paint, sun strip, roll cage, steering wheel and tyre lettering
        skin_textures=('car_paint_MAP.dds', 'metal_detail.dds', 'glass_up.dds', 'rollcage.dds', 'steer_m1.dds',
                       'TYRE_d_2.dds'),
        # A skin folder whose name lost its umlaut in the mod's archive
        skin_ids={'1980_Procar_M�ller_66': '1980_procar_mueller_66'},
    ),
    'porsche-934-rsr': dict(
        title='Porsche 934 Turbo RSR',
        auto=True,
        materials={},
        paint=('EXT_CARPAINT',),
        # The broken-glass layers AC shows only once a window is smashed
        skip_materials={'DAMAGE_GLASS'},
        skip_node_prefixes=(),
        # The belts drawn fastened round a driver the car doesn't carry
        skip_nodes=('COCKPIT_LR', 'CINTURE_ON'),
        default_skin='DRM 200 Miles Nuernberg 6',
        steer_nodes=(),
        tyre_materials=('TIRES',),
        tyre_prefix=None,
        spinning=(),
        windscreen=('EXT_GLASS_FRONT',),
        # The paint, the window banners, and (a few skins') roll cage and belts
        skin_textures=('ext_skin.dds', 'ext_glass.dds', 'int_glass.dds', 'rollcage.dds', 'cinture.dds'),
    ),
    # NPanic's Chaparral 2D, 1966 (327) and 1967 (427). Their liveries change parts as well as paint: a part (`parts`:
    # kn5 node -> part, or an `extension/` kn5 the mod inserts, `extra_kn5`) is a node of its own, shown only for the
    # liveries of its variants (`part_variants`; a livery's variant is `skin_variants`, else 'base')
    'chaparral-2d': dict(
        title='Chaparral 2D (1966)',
        auto=True,
        materials={},
        paint=('EXT_Main_Body',),
        # The windscreen's inner face (a second, near-clear layer over the outer glass)
        skip_materials={'INT_Window'},
        skip_node_prefixes=(),
        # The gurney extension and the centre lamps' covers as the mod's default setup has them: off (the kn5 has the
        # extension fitted, and the covers tucked away)
        skip_nodes=('COCKPIT_LR', 'EXT_Gurney_Animation', 'EXT_Mainlights_Cover_Animation'),
        default_skin='7_nurb_1000_1966',
        steer_nodes=(),
        tyre_materials=('EXT_Tire',),
        tyre_prefix=None,
        spinning=('DISC_',),
        windscreen=('EXT_Window',),
        # The paint, the number plate and (one Sebring car's) gauge labels
        skin_textures=('EXT_Body.dds', 'EXT_Licence_Plate.dds', 'INT_Labels_Gauges.dds'),
        # The Sebring and Daytona cars (the skins' ext_config.ini MODEL_REPLACEMENT) wear the Sebring scoop and fixed
        # light covers, and no roof mirror or number plate
        parts={'EXT_Scoop': 'scoop', 'EXT_Mirror_Roof': 'roof_mirror', 'EXT_License_Plate': 'plate'},
        extra_kn5=(('EXT_Scoop_Sebring.kn5', 'scoop_sebring'), ('EXT_Mirror_Roof_Off.kn5', 'roof_mirror_off'),
                   ('EXT_Fixed_Lightcover.kn5', 'light_covers_fixed')),
        part_variants={'scoop': ('base',), 'roof_mirror': ('base',), 'plate': ('base',),
                       'scoop_sebring': ('sebring',), 'roof_mirror_off': ('sebring',),
                       'light_covers_fixed': ('sebring',)},
        skin_variants={'11_sebring_1966': 'sebring', '12_sebring_1966': 'sebring', '65_daytona_1966': 'sebring'},
    ),
    'chaparral-2d-67': dict(
        title='Chaparral 2D (1967)',
        auto=True,
        materials={},
        paint=('EXT_Main_Body',),
        skip_materials={'INT_Window'},
        skip_node_prefixes=(),
        # The centre lamps' covers, tucked away in the kn5 (the default setup's covers off)
        skip_nodes=('COCKPIT_LR', 'EXT_Mainlights_Cover_Animation'),
        default_skin='14_daytona_1967',
        steer_nodes=(),
        tyre_materials=('EXT_Tire',),
        tyre_prefix=None,
        spinning=('DISC_',),
        windscreen=('EXT_Window',),
        skin_textures=('EXT_Body.dds', 'EXT_Licence_Plate.dds', 'INT_Labels_Gauges.dds'),
        # Daytona's raised gurney spoiler; Sebring's big spoiler and front canards (the mod's two setup aero kits)
        parts={'EXT_Daytona_Wing': 'daytona_wing', 'EXT_Sebring_Wing': 'sebring_wing', 'EXT_Canards': 'canards'},
        extra_kn5=(),
        part_variants={'daytona_wing': ('base',), 'sebring_wing': ('sebring',), 'canards': ('sebring',)},
        # The Sebring kit sits scaled down inside the body at rest; the setup's aero 50 (the last frame) fits it
        part_poses={'EXT_Sebring_Wing': ('rear_aero.ksanim', 100), 'EXT_Canards': ('canards.ksanim', 100)},
        skin_variants={'5_sebring_1967': 'sebring'},
    ),
}
# The car folders the presets were written for
PRESET_BY_FOLDER = {'suzuki_liana': 'liana', 'mt_mtr_496r': 'mtr-496r',
                    'nissan_skyline_bcnr33_jgtc': 'nissan-r33-jgtc', 'nissan_r32_jtcc': 'nissan-r32-jtcc',
                    'pfa_vw_scirocco_53b': 'vw-scirocco-gtx', 'pddw_bmw_procar_m1': 'bmw-m1-procar',
                    'pfa_porsche_934t_rsr_rr': 'porsche-934-rsr',
                    'wsc_legends_chaparral_2d_66': 'chaparral-2d', 'wsc_legends_chaparral_2d_67': 'chaparral-2d-67'}


def skin_id(preset, folder):
    """A skin folder's name as the livery's id, which is also its folder in URLs and on the asset host: lower case, each
    run of anything but letters, digits and '-' as one '_' (a preset's `skin_ids` names the odd one out). A name with
    none of those (all of it in another script) is `skin_` and a hash of the name, so it is never empty"""
    if folder in preset.get('skin_ids', {}):
        return preset['skin_ids'][folder]
    sid = re.sub(r'[^a-z0-9-]+', '_', folder.lower()).strip('_')
    return sid or 'skin_' + hashlib.sha1(folder.encode('utf-8')).hexdigest()[:8]


def unique_skin_ids(preset, folders):
    """{folder: id} for the skin folders: `skin_id`, with `_2`, `_3`… after an id an earlier folder has, so no two
    liveries share a folder ("Red car" and "red_car")"""
    out, used = {}, set()
    for folder in folders:
        sid = base = skin_id(preset, folder)
        n = 2
        while sid in used:
            sid, n = f'{base}_{n}', n + 1
        used.add(sid)
        out[folder] = sid
    return out


def srgb_to_linear(c):
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def decode(raw):
    im = Image.open(io.BytesIO(raw))
    im.load()
    return im.convert('RGBA')


def resize_straight(im, size, resample=Image.LANCZOS):
    """`im` resized with its colour and alpha filtered apart. Pillow filters RGBA premultiplied, which blacks out the
    colour wherever the alpha is 0, and a multimap's alpha is a mask (a paint atlas can be 0 all over), not coverage"""
    if im.mode != 'RGBA':
        return im.resize(size, resample)
    rgb = im.convert('RGB').resize(size, resample)
    rgb.putalpha(im.getchannel('A').resize(size, resample))
    return rgb


def bake_multimap(diffuse, detail, uv_mult, flat=False):
    """AC's ksPerPixelMultiMap colour: diffuse * (detail * (1 - diffuse.a) + diffuse.a), in gamma space, as an opaque
    RGB image at the larger of the two sizes (the detail tiled `uv_mult` times; a flat detail, or any with `flat`, is
    its mean colour)"""
    d = np.asarray(diffuse, np.float32) / 255.0
    t = np.asarray(detail, np.float32) / 255.0
    flat = flat or t[..., :3].reshape(-1, 3).std(0).max() < 2 / 255
    if flat:
        size = diffuse.size
        det = np.broadcast_to(t[..., :3].reshape(-1, 3).mean(0), (size[1], size[0], 3))
    else:
        reps = max(1, int(round(uv_mult)))
        size = (max(diffuse.size[0], detail.size[0] * reps), max(diffuse.size[1], detail.size[1] * reps))
        tiled = Image.fromarray((np.tile(t, (reps, reps, 1)) * 255).astype(np.uint8), 'RGBA')
        det = np.asarray(resize_straight(tiled, size, Image.BICUBIC), np.float32)[..., :3] / 255.0
        if diffuse.size != size:
            d = np.asarray(resize_straight(diffuse, size, Image.BICUBIC), np.float32) / 255.0
    a = d[..., 3:4]
    rgb = d[..., :3] * (det * (1.0 - a) + a)
    return Image.fromarray(np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8), 'RGB')


def baked_image(key, src, mats, limit):
    """The colour map of 'bake:<kn5 material>' / 'bakemean:<kn5 material>' from textures `src`: its diffuse times its
    detail as AC's multimap shades them ('bakemean:': the detail as its mean colour, for a fine pattern such as paint
    flake tiled past any bake size; the diffuse comes down to `limit` first)"""
    m = mats[key.split(':', 1)[1]]
    diffuse = decode(src[m['maps']['txDiffuse']])
    detail = decode(src[m['maps']['txDetail']])
    mean = key.startswith('bakemean:')
    if mean and max(diffuse.size) > limit:
        k = limit / max(diffuse.size)
        diffuse = resize_straight(diffuse, (round(diffuse.width * k), round(diffuse.height * k)))
    return bake_multimap(diffuse, detail, m['props'].get('detailUVMultiplier', 1.0), flat=mean)


def skin_overrides(car_dir, skin, textures, names=None):
    """{kn5 texture name: bytes} of the files in a skin's folder that replace the kn5's textures (AC matches the names
    regardless of case); `names` (lower case) limits them"""
    sdir = os.path.join(car_dir, 'skins', skin or '')
    if not skin or not os.path.isdir(sdir):
        return {}
    lower = {t.lower(): t for t in textures}
    out = {}
    for f in sorted(os.listdir(sdir)):
        k = f.lower()
        if k in lower and (names is None or k in names):
            out[lower[k]] = open(os.path.join(sdir, f), 'rb').read()
    return out


class TexturePool:
    """Encodes each output texture once: JPEG when opaque, PNG when its alpha matters, capped in size"""

    def __init__(self, writer, kn5_tex, skin_tex, kn5_mats, max_tex, small_tex, normal_tex, jpeg_quality, alpha_keys):
        self.w = writer
        # Textures some blended material reads the alpha of (encoded once, so decided up front)
        self.alpha_keys = alpha_keys
        self.src = {**kn5_tex, **skin_tex}
        self.mats = {m['name']: m for m in kn5_mats}
        self.max_tex, self.small_tex, self.normal_tex = max_tex, small_tex, normal_tex
        self.q = jpeg_quality
        self.cache = {}
        self.stats = []
        self.writer_sampler()

    def writer_sampler(self):
        self.w.j['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]

    def _add(self, key, im, cap, alpha, normal=False):
        if max(im.size) > cap:
            k = cap / max(im.size)
            # An opaque map's alpha goes unused (and may be a mask of 0s, which a premultiplied filter would black out)
            im = (im if alpha else im.convert('RGB')).resize((max(1, round(im.width * k)), max(1, round(im.height * k))),
                                                            Image.LANCZOS)
        buf = io.BytesIO()
        if alpha:
            im.convert('RGBA').save(buf, format='PNG', optimize=True)
            mime = 'image/png'
        else:
            im.convert('RGB').save(buf, format='JPEG', quality=self.q if not normal else max(self.q, 92),
                                   optimize=True, subsampling=0 if normal else 2)
            mime = 'image/jpeg'
        bv = self.w.add_view(buf.getvalue())
        self.w.j['images'].append({'name': key, 'bufferView': bv, 'mimeType': mime})
        self.w.j['textures'].append({'sampler': 0, 'source': len(self.w.j['images']) - 1})
        self.stats.append((key, im.size, mime, len(buf.getvalue())))
        idx = len(self.w.j['textures']) - 1
        self.cache[key] = idx
        return idx

    def colour(self, key, alpha=False, cap=None):
        """Texture index for a colour map key: '<texture name>', 'bake:<kn5 material>', 'crop:<texture>' (handled by
        the caller, which passes the cropped image through `image`)"""
        if key in self.cache:
            return self.cache[key]
        if key.startswith(('bake:', 'bakemean:')):
            limit = cap or self.max_tex
            return self._add(key, baked_image(key, self.src, self.mats, limit), limit, False)
        im = decode(self.src[key])
        has_alpha = (alpha or key in self.alpha_keys) and np.asarray(im)[..., 3].min() < 255
        return self._add(key, im, cap or self.small_tex, has_alpha)

    def image(self, key, im, alpha):
        if key in self.cache:
            return self.cache[key]
        return self._add(key, im, self.small_tex, alpha)

    def normal(self, name):
        key = f'normal:{name}'
        if key in self.cache:
            return self.cache[key]
        # A merged tyre normal map holds a band per map (`merge_tyre_textures`): twice the cap keeps each one's size
        cap = self.normal_tex * (2 if name.startswith('merged:') else 1)
        return self._add(key, decode(self.src[name]).convert('RGB'), cap, False, normal=True)

    def mean_colour(self, name):
        return np.asarray(decode(self.src[name]), np.float64)[..., :3].reshape(-1, 3).mean(0)

    def data_map(self, key, im, alpha=False):
        """A map of values rather than colours (a finish map), encoded once as a normal map is (no chroma subsampling),
        or as PNG with `alpha`"""
        if key in self.cache:
            return self.cache[key]
        return self._add(key, im, FINISH_MAP_SIZE, alpha, normal=True)


# ---------------------------------------------------------------------------------------------------------------------
# Materials from AC's shader values (`auto` presets). AC lights a material as `diffuse map * (ksAmbient * ambient +
# ksDiffuse * N.L)` with a Blinn-Phong highlight of exponent ksSpecularEXP and a reflection of strength fresnelC rising
# to fresnelMaxLevel; modders darken a grey map with a low ksDiffuse instead of painting it black. So: the base colour is
# the diffuse (times its multimap detail, as `bake_multimap`), dimmed by ksDiffuse against AC's usual ~0.4; roughness
# follows the highlight's exponent; a material is metal when it reflects strongly head on, or reflects strongly at
# grazing angles and is named or textured as metal. The GLB name is its class plus a number, because the game's
# material clean-up (src/lib/render/ported-car-materials.ts) classes materials by name and the kn5 names mislead it
# ('carPaint' on an interior part, 'Body_plasitcs1' on a plastic one); the kn5 names are kept in the material's extras.
# ---------------------------------------------------------------------------------------------------------------------

# Palette textures: cell size (px) and cells to a row
PALETTE_CELL = 8
PALETTE_COLS = 16
# Roughness steps a palette material is snapped to
_ROUGH_BUCKETS = (0.2, 0.35, 0.5, 0.65, 0.8, 0.95)
_AT_SHADER = re.compile(r'(?:ksPerPixel|_)AT(?:_|$)')
_METALISH = re.compile(r'chrome|metal|alu|steel|titan|rim|hub|exhaust|bolt|screw|disc|disk|brake|calip|iron|gold|bronze',
                       re.I)
_GLASSISH = re.compile(r'glass|gls|window|windscreen|windsceen|windshield', re.I)
_LIGHTISH = re.compile(r'light|lamp|bulb|reflector|lens|(^|_)leds?(_|$)', re.I)
_SCREENISH = re.compile(r'display|digit|gauge|lcd|screen|motec|meter', re.I)
_DECALISH = re.compile(r'decal|sticker|banner|symbol|logo|badge|tags?(_|$)|number|livery', re.I)


class TexStats:
    """Whether each texture is one flat colour, and its mean colour and alpha (sRGB 0-255)"""

    def __init__(self, src):
        self.src = src
        self.cache = {}

    def __call__(self, name):
        if name not in self.cache:
            if name not in self.src:
                self.cache[name] = None
            else:
                a = np.asarray(decode(self.src[name]), np.float32)
                rgb = a[..., :3].reshape(-1, 3)
                self.cache[name] = dict(flat=bool(rgb.std(0).max() < 3.0), mean=rgb.mean(0), alpha=float(a[..., 3].mean()),
                                        amin=float(a[..., 3].min()))
        return self.cache[name]


def multimap_bake_key(m, stats):
    """The colour-map key of a ksPerPixelMultiMap material `m` whose diffuse carries a pattern: 'bake:' when its detail is
    drawn once over the diffuse's own UVs (detailUVMultiplier 1, not one flat colour: a livery, its numbers and
    sponsors), else 'bakemean:' (a fine tiled pattern, carbon weave or paint flake, as its mean colour)"""
    det = m['maps'].get('txDetail')
    t = stats(det) if det else None
    uvm = m['props'].get('detailUVMultiplier', 1.0) or 1.0
    return ('bake:' if abs(uvm - 1.0) < 1e-3 and t is not None and not t['flat'] else 'bakemean:') + m['name']


def auto_spec(m, stats, preset, by_name=None):
    """The spec (as the MATERIALS tables write them) of kn5 material `m`, from its shader and values, plus its class"""
    name, shader, props, maps = m['name'], m['shader'], m['props'], m['maps']
    diff = maps.get('txDiffuse')
    det = maps.get('txDetail') if 'MultiMap' in shader and props.get('useDetail', 0) >= 0.5 else None
    d = stats(diff) if diff else None
    t = stats(det) if det else None
    words = ' '.join(x for x in (name, diff or '', det or '') if x)
    exp_ = max(0.0, props.get('ksSpecularEXP', 20.0))
    rough = float(np.clip((2.0 / (exp_ + 2.0)) ** 0.25, 0.08, 0.95))
    fc, fmax = props.get('fresnelC', 0.0), props.get('fresnelMaxLevel', 0.0)
    metal = 1.0 if fc >= 0.5 or (fmax >= 0.35 and _METALISH.search(words)) else 0.0
    lum = max(props.get('ksDiffuse', 0.4), props.get('ksAmbient', 0.4))
    scale = float(np.clip(lum / 0.4, 0.05, 1.0))
    blend = m['blend'] == 1
    glass = shader == 'ksWindscreen' or (blend and bool(_GLASSISH.search(words)))
    spec = dict(rough=round(rough, 2), metal=metal)

    colour, tex, alpha = None, None, 1.0
    if d is None:
        colour = np.array([128.0, 128.0, 128.0])
    elif t is not None:
        a = d['alpha'] / 255.0
        if d['flat'] and t['flat']:
            colour = d['mean'] * (t['mean'] / 255.0 * (1.0 - a) + a)
        elif d['flat']:
            if a < 0.5:
                # A flat diffuse over a patterned detail (carbon weave, brushed metal): the detail, tinted
                spec['detail'] = True
                colour = d['mean'] * (1.0 - a) + 255.0 * a
            else:
                colour = d['mean']
        else:
            # The detail tiled on the diffuse's own UVs bakes as it is; one tiled finer, as its mean colour
            tex = multimap_bake_key(m, stats)
    elif d['flat']:
        colour = d['mean']
        alpha = d['alpha'] / 255.0
    else:
        tex = diff

    if glass:
        mode = 'BLEND'
        if tex is None:
            alpha = min(alpha, 0.6)
    elif blend:
        mode = 'BLEND'
    elif (m['alpha_tested'] or _AT_SHADER.search(shader)) and d is not None and d['amin'] < 128:
        mode = 'MASK'
    else:
        mode = 'OPAQUE'
        alpha = 1.0
    if tex is None:
        alpha = float(alpha)
    spec['mode'] = mode
    spec['alpha'] = round(alpha, 3)
    if tex:
        spec['tex'] = tex
    spec['color'] = tuple(int(round(float(c))) for c in np.clip(colour if colour is not None else (255, 255, 255), 0, 255))
    spec['scale'] = round(scale, 2)
    nrm = maps.get('txNormal')
    # A damage shader's normal map is its dents (AC fades it in with the damage): the undamaged car has none
    if nrm and 'damage' in shader.lower() and 'damage' in nrm.lower():
        nrm = None
    if nrm and shader != 'ksWindscreen':
        n = stats(nrm)
        if n is not None and not n['flat']:
            spec['normal'] = nrm

    paint_of = next((p for p in preset.get('paint', ()) if p != name and diff and
                     (by_name.get(p) or {}).get('maps', {}).get('txDiffuse') == diff), None) if by_name else None
    if paint_of and not glass:
        # Another part drawn from the paint's own atlas (a banner, a weatherstrip, a wishbone): the paint's texture, so a
        # livery changes one file for both. The atlas's alpha is the multimap mask, not transparency
        paint_det = (by_name[paint_of]['maps'].get('txDetail') if 'MultiMap' in by_name[paint_of]['shader'] else None)
        spec.pop('detail', None)
        spec.update(tex=multimap_bake_key(by_name[paint_of], stats) if paint_det else diff, color=(255, 255, 255),
                    mode='OPAQUE', alpha=1.0)
    if name in preset.get('paint', ()):
        cls = 'paint'
        # The livery bakes at the paint's size cap: a livery drawn 1:1 as it is, a tiled detail (flake) as its mean colour
        spec['tex'] = multimap_bake_key(m, stats) if det else diff
        spec.pop('detail', None)
        spec.update(color=(255, 255, 255), scale=1.0, mode='OPAQUE', alpha=1.0)
    elif shader == 'ksTyres' or name in preset.get('tyre_class', ()):
        # AC's tyre shader, or a tyre an automatic preset found by its name or shape
        cls = 'tyre'
    elif glass:
        cls = 'glass'
    elif _SCREENISH.search(name):
        cls = 'lcd'
    elif _LIGHTISH.search(name):
        cls = 'light'
    elif 'mirror' in name.lower() and fc >= 0.5:
        cls = 'mirror'
    elif 'carbon' in words.lower():
        cls = 'carbon'
    elif _DECALISH.search(words):
        cls = 'decal'
    elif metal:
        cls = 'metal'
    else:
        cls = 'part'
    # A flat colour with no map of any kind: drawn from the class's palette texture (`port`), so such parts share one
    # material per class and finish instead of one each
    if 'tex' not in spec and not spec.get('detail') and 'normal' not in spec and spec['mode'] == 'OPAQUE':
        spec['palette'] = True
    # Finishes in steps, so near-identical kn5 materials come out as one
    spec['rough'] = min(_ROUGH_BUCKETS, key=lambda r: abs(r - spec['rough']))
    if 'tex' in spec or spec.get('detail'):
        spec['scale'] = round(spec['scale'] * 10) / 10
    return spec, cls


# ---------------------------------------------------------------------------------------------------------------------
# Finishes from AC's shader values (an automatic preset's materials). AC draws a material as its diffuse lit through
# ksAmbient / ksDiffuse, a highlight of ksSpecular and ksSpecularEXP, and a reflection of its surroundings rising from
# fresnelC head on to fresnelMaxLevel at grazing angles; a multimap masks those per pixel with its txMaps (R specular,
# G gloss, B reflection) and, where its detail is drawn, the detail's alpha (a livery's panel gaps and matte stickers,
# a carbon weave's tows). glTF gets the same: roughness from the highlight, KHR_materials_specular for the reflection
# head on (its colour factor over a dielectric's 0.04) and at grazing angles (its factor), and a polished coat's sharp
# reflections as KHR_materials_clearcoat; a map holds what varies per pixel (R clearcoat, G roughness, B metalness), and
# a tiled detail's weave stays a repeating roughness map. extras.acFinish marks the material, so the game keeps the
# finish as made (src/lib/render/ported-car-materials.ts) instead of finishing it by its name.
# ---------------------------------------------------------------------------------------------------------------------

# The classes whose finish comes from the AC values (glass, lights, screens, tyres and mirrors keep the game's own)
FINISH_CLASSES = ('paint', 'part', 'carbon', 'decal', 'metal')
# A coat polished to mirror its surroundings: AC's reflection reaching this far at grazing angles, under a highlight at
# least this tight
LACQUER_FRESNEL = 0.3
LACQUER_EXP = 100.0
# The detail alpha of a full coat (a multimap livery's paint carries about this; less is a thinner one)
FULL_COAT_ALPHA = 0.25
FINISH_MAP_SIZE = 1024
CLEARCOAT_ROUGHNESS = 0.06


def skin_shader_replacements(car_dir, skin):
    """{kn5 material: {property: value}} a skin's ext_config.ini sets for its materials ([SHADER_REPLACEMENT_...]:
    MATERIALS = a, b and its PROP_... = name, value lines, which repeat their key); {} without one"""
    path = os.path.join(car_dir or '', 'skins', skin or '', 'ext_config.ini')
    if not car_dir or not skin or not os.path.isfile(path):
        return {}
    sections, section = [], None
    for line in open(path, 'rb').read().decode('latin1').splitlines():
        line = line.split(';', 1)[0].split('//', 1)[0].strip()
        if line.startswith('[') and line.endswith(']'):
            section = None
            if line[1:-1].strip().upper().startswith('SHADER_REPLACEMENT'):
                section = {'materials': [], 'props': {}}
                sections.append(section)
            continue
        if section is None or '=' not in line:
            continue
        k, v = (s.strip() for s in line.split('=', 1))
        if k.upper() == 'MATERIALS':
            section['materials'] = [s.strip() for s in v.split(',') if s.strip()]
        elif k.upper().startswith('PROP_'):
            name, _, value = (s.strip() for s in v.partition(','))
            try:
                section['props'][name] = float(value.split(',')[0])
            except ValueError:
                pass
    out = {}
    for sec in sections:
        for mat in sec['materials']:
            out.setdefault(mat, {}).update(sec['props'])
    return out


def apply_skin_shader_replacements(car_dir, skin, materials):
    """Sets a skin's material properties (`skin_shader_replacements`) on `materials`; returns what it set"""
    rep = skin_shader_replacements(car_dir, skin)
    for m in materials:
        if m['name'] in rep:
            m['props'] = {**m['props'], **rep[m['name']]}
    return rep


def ac_finish(m, cls, spec):
    """The glTF finish of kn5 material `m` (its class and `auto_spec`) from its AC values, or None for a class the
    game finishes itself: {rough, metal, specular (F90), specular_color (F0 over 0.04), clearcoat, lacquer, ...}"""
    if cls not in FINISH_CLASSES:
        return None
    p = m['props']
    exp_ = max(0.0, p.get('ksSpecularEXP', 20.0))
    fc, fmax = max(0.0, p.get('fresnelC', 0.0)), max(0.0, p.get('fresnelMaxLevel', 0.0))
    fmax = max(fmax, fc)
    lacquer = fmax >= LACQUER_FRESNEL and exp_ >= LACQUER_EXP
    f0 = float(np.clip(fc, 0.004, 1.0))
    # A polished coat: its sharp reflection (the clearcoat, 4 % head on) rises to fresnelMaxLevel at grazing angles, over
    # a base reflecting fresnelC all round. Any other surface: one reflection from fresnelC head on to fresnelMaxLevel
    f90 = f0 if lacquer else float(np.clip(fmax, f0, 1.0))
    return dict(
        rough=round(float(np.clip((2.0 / (exp_ + 2.0)) ** 0.25, 0.08, 0.95)), 3),
        exp=exp_,
        metal=float(spec.get('metal', 0.0)),
        specular=round(f90, 3),
        specular_color=round(f0 / (0.04 * f90), 3),
        clearcoat=round(min(1.0, fmax), 3) if lacquer else 0.0,
        lacquer=lacquer,
    )


def finish_map(m, src, fin):
    """The per-pixel finish of a multimap drawn once over its UVs (R clearcoat, G roughness, B metalness, at most
    FINISH_MAP_SIZE) and the mean of its reflection mask, or (None, 1) when nothing in it varies: the reflection masked
    by txMaps' B and the detail's alpha where the detail is drawn (the coat full at FULL_COAT_ALPHA), the highlight's
    exponent by txMaps' G"""
    maps, props = m['maps'], m['props']
    if 'MultiMap' not in m['shader'] or maps.get('txDiffuse') not in src:
        return None, 1.0
    diffuse = decode(src[maps['txDiffuse']])
    side = min(FINISH_MAP_SIZE, max(diffuse.size))
    size = (side, side)
    ad = np.asarray(diffuse.getchannel('A').resize(size, Image.BILINEAR), np.float32) / 255.0
    refl = np.ones(size[::-1], np.float32)
    coat = np.ones(size[::-1], np.float32)
    gloss = np.ones(size[::-1], np.float32)
    uvm = props.get('detailUVMultiplier', 1.0) or 1.0
    if props.get('useDetail', 0) >= 0.5 and maps.get('txDetail') in src and abs(uvm - 1.0) < 1e-3:
        at = np.asarray(decode(src[maps['txDetail']]).getchannel('A').resize(size, Image.BILINEAR), np.float32) / 255.0
        refl *= at * (1.0 - ad) + ad
        coat *= np.clip(refl / FULL_COAT_ALPHA, 0.0, 1.0)
    if maps.get('txMaps') in src:
        mp = np.asarray(decode(src[maps['txMaps']]).convert('RGB').resize(size, Image.BILINEAR), np.float32) / 255.0
        refl *= mp[..., 2]
        coat *= mp[..., 2]
        gloss = np.maximum(mp[..., 1], 1e-3)
    used = np.asarray(diffuse.convert('L').resize(size, Image.BILINEAR), np.float32) > 8
    mean = float(refl[used].mean()) if used.any() else 1.0
    rough = np.clip((2.0 / (fin['exp'] * gloss + 2.0)) ** 0.25, 0.08, 0.95)
    cc = fin['clearcoat'] * coat
    metal = np.full(size[::-1], fin['metal'], np.float32)
    if cc.std() < 0.01 and rough.std() < 0.01:
        return None, mean
    rgb = np.stack([cc, rough, metal], -1)
    return Image.fromarray(np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8), 'RGB'), mean


def weave_map(m, src, fin):
    """A tiled detail's weave (carbon: its alpha the tows' sheen) as a repeating map, and its repeat count, or None:
    G roughness, B metalness, A the reflection's strength (KHR_materials_specular reads A), the glossy tows at the
    material's own roughness and the ones between rougher and duller"""
    maps, props = m['maps'], m['props']
    uvm = props.get('detailUVMultiplier', 1.0) or 1.0
    if ('MultiMap' not in m['shader'] or props.get('useDetail', 0) < 0.5 or maps.get('txDetail') not in src
            or abs(uvm - 1.0) < 1e-3):
        return None
    det = decode(src[maps['txDetail']])
    a = np.asarray(det.getchannel('A'), np.float32) / 255.0
    if a.std() < 0.05:
        return None
    rough = np.clip(fin['rough'] * (1.5 - 0.5 * a), 0.08, 0.95)
    rgba = np.stack([np.zeros_like(a), rough, np.full_like(a, fin['metal']), a], -1)
    return Image.fromarray(np.clip(rgba * 255.0 + 0.5, 0, 255).astype(np.uint8), 'RGBA'), float(uvm)


def reflection_occlusion(m, src):
    """The mean of a multimap's txMaps B (its reflection mask, an AO bake here) over the texels it covers, or 1"""
    t = m['maps'].get('txMaps')
    if t not in src:
        return 1.0
    b = np.asarray(decode(src[t]).getchannel('B'), np.float32) / 255.0
    used = b > 0.02
    return float(b[used].mean()) if used.any() else 1.0


def apply_ac_finish(gm, m, cls, spec, pool, writer):
    """Writes `ac_finish` of kn5 material `m` onto glTF material `gm` (its maps through `pool`); returns the finish"""
    fin = ac_finish(m, cls, spec)
    if fin is None:
        return None
    used = writer.j.setdefault('extensionsUsed', [])

    def uses(ext):
        if ext not in used:
            used.append(ext)

    pbr = gm['pbrMetallicRoughness']
    pbr['metallicFactor'], pbr['roughnessFactor'] = fin['metal'], fin['rough']
    p = m['props']
    if cls == 'paint':
        # The paint dimmed by its own ksDiffuse / ksAmbient, as `auto_spec` dims every other material
        k = float(np.clip(max(p.get('ksDiffuse', 0.4), p.get('ksAmbient', 0.4)) / 0.4, 0.05, 1.0))
        pbr['baseColorFactor'] = [round(c * k, 4) for c in pbr['baseColorFactor'][:3]] + pbr['baseColorFactor'][3:]
    gm.setdefault('extensions', {})['KHR_materials_specular'] = {
        'specularFactor': fin['specular'], 'specularColorFactor': [fin['specular_color']] * 3}
    uses('KHR_materials_specular')
    # A tiled detail's weave, else a 1:1 multimap's per-pixel map
    weave = weave_map(m, pool.src, fin)
    fmap, refl_mean = (None, 1.0) if weave is not None else finish_map(m, pool.src, fin)
    if fmap is not None:
        # The base reflection (fresnelC all round under a coat) dimmed as AC's mask dims it on average
        gm['extensions']['KHR_materials_specular']['specularFactor'] = round(fin['specular'] * refl_mean, 3)
        ti = pool.data_map(f"finish:{m['name']}", fmap)
        pbr['metallicRoughnessTexture'] = {'index': ti}
        pbr['metallicFactor'] = pbr['roughnessFactor'] = 1.0
    elif weave is not None:
        im, reps = weave
        ti = pool.data_map(f"weave:{m['maps']['txDetail']}", im, alpha=True)
        tiled = {'index': ti, 'extensions': {'KHR_texture_transform': {'scale': [reps, reps]}}}
        pbr['metallicRoughnessTexture'] = tiled
        pbr['metallicFactor'] = pbr['roughnessFactor'] = 1.0
        # The weave's alpha masks the reflection, and the material's txMaps B dims it where the bodywork shades it
        spec_ext = gm['extensions']['KHR_materials_specular']
        spec_ext['specularTexture'] = json.loads(json.dumps(tiled))
        spec_ext['specularFactor'] = round(fin['specular'] * reflection_occlusion(m, pool.src), 3)
        uses('KHR_texture_transform')
    elif not fin['lacquer']:
        # One reflection all over: dimmed as the material's txMaps B dims it on average
        gm['extensions']['KHR_materials_specular']['specularFactor'] = round(
            fin['specular'] * reflection_occlusion(m, pool.src), 3)
    if fin['clearcoat'] > 0:
        coat = {'clearcoatFactor': 1.0 if fmap is not None else round(fin['clearcoat'] * reflection_occlusion(m, pool.src), 3),
                'clearcoatRoughnessFactor': CLEARCOAT_ROUGHNESS}
        if fmap is not None:
            coat['clearcoatTexture'] = {'index': pbr['metallicRoughnessTexture']['index']}
        gm['extensions']['KHR_materials_clearcoat'] = coat
        uses('KHR_materials_clearcoat')
    gm['extras'] = {**gm.get('extras', {}), 'acFinish': {
        k: round(float(p[k]), 3) for k in ('ksAmbient', 'ksDiffuse', 'ksSpecular', 'ksSpecularEXP', 'fresnelC',
                                           'fresnelMaxLevel') if k in p}}
    return fin


# ---------------------------------------------------------------------------------------------------------------------
# Port
# ---------------------------------------------------------------------------------------------------------------------


def read_rev_leds(data, nodes):
    """The shift lights digital_instruments.ini drives, among `nodes`: {leds: [{node, rpm, color}], blinkRpm, blinkHz}.
    [LED_n] gives a node, its switch-on rpm and its EMISSIVE colour (normalised to its brightest channel); an
    [RPM_SERIE_n] lights PREFIX<START_INDEX>..<END_INDEX> from RPM_START to RPM_END, in red (it gives no colour)."""
    if 'digital_instruments.ini' not in data:
        return None
    cp = ini(data['digital_instruments.ini'])
    leds, blink = [], None

    def colour(sec):
        # A value may end in a `//` comment (`EMISSIVE=125,0,0  //133,255,128`)
        rgb = vec3(sec.get('EMISSIVE', '1,0,0').split('//')[0])
        top = max(rgb) or 1.0
        return [round(c / top, 3) for c in rgb]

    for name in cp.sections():
        sec = cp[name]
        if name.startswith('LED_') and sec.get('OBJECT_NAME') in nodes and float(sec.get('RPM_SWITCH', 0)) > 0:
            leds.append({'node': sec['OBJECT_NAME'], 'rpm': float(sec['RPM_SWITCH']), 'color': colour(sec)})
        elif name.startswith('RPM_SERIE_'):
            a, b = int(sec.get('START_INDEX', 0)), int(sec.get('END_INDEX', 0))
            r0, r1 = float(sec.get('RPM_START', 0)), float(sec.get('RPM_END', 0))
            for k in range(a, b + 1):
                node = f"{sec.get('PREFIX', '')}{k}"
                if node in nodes:
                    leds.append({'node': node, 'rpm': r0 + (r1 - r0) * (k - a) / max(1, b - a), 'color': [1.0, 0.0, 0.0]})
        else:
            continue
        if 'BLINK_SWITCH' in sec and blink is None:
            blink = (float(sec['BLINK_SWITCH']), float(sec.get('BLINK_HZ', 5)))
    if not leds:
        return None
    out = {'leds': sorted(leds, key=lambda l: (l['rpm'], l['node']))}
    if blink:
        out['blinkRpm'], out['blinkHz'] = blink
    return out


def paint_swatch(path):
    """The two main colours of a skin's baked paint (`paint.jpg`, or the image itself), as #rrggbb: its atlas's black
    background and the darkest AO left out, quantised to 1/16 steps; the second must differ from the first"""
    im = path if isinstance(path, Image.Image) else Image.open(path)
    px = np.asarray(im.convert('RGB').resize((256, 256)), np.int32).reshape(-1, 3)
    px = px[px.max(1) > 14] // 16 * 16 + 8
    if not len(px):
        return ['#101010', '#101010']
    keys, counts = np.unique(px, axis=0, return_counts=True)
    order = np.argsort(-counts)
    first = keys[order[0]]
    second = next((keys[i] for i in order[1:] if np.abs(keys[i] - first).sum() > 96), first)
    return ['#%02x%02x%02x' % tuple(int(v) for v in c) for c in (first, second)]


def export_skins(car_dir, preset, textures, materials, out_dir, max_tex, small_tex, jpeg_quality, only=None):
    """Every skin's livery files (`preset['skin_maps']`) into <out_dir>/<skin>/, and skins.json listing them. `only`:
    the skin folders to export (by folder name or id), as `export_auto_skins` takes them"""
    by_name = {m['name']: m for m in materials}
    skins_dir = os.path.join(car_dir, 'skins')
    listing = []
    for skin in sorted(os.listdir(skins_dir)):
        sdir = os.path.join(skins_dir, skin)
        if not os.path.isdir(sdir) or (only is not None and skin not in only and skin_id(preset, skin) not in only):
            continue
        src = dict(textures)
        for f in preset['skin_files']:
            if os.path.isfile(os.path.join(sdir, f)):
                src[f] = open(os.path.join(sdir, f), 'rb').read()
        os.makedirs(os.path.join(out_dir, skin), exist_ok=True)
        done = set()
        for mat, (fname, how) in preset['skin_maps'].items():
            if fname in done:
                continue
            done.add(fname)
            m = by_name[mat]
            diffuse = decode(src[m['maps']['txDiffuse']])
            if how == 'bakemean':
                if max(diffuse.size) > max_tex:
                    k = max_tex / max(diffuse.size)
                    diffuse = resize_straight(diffuse, (round(diffuse.width * k), round(diffuse.height * k)))
                im = bake_multimap(diffuse, decode(src[m['maps']['txDetail']]), 1.0, flat=True)
            else:
                im = diffuse
                if max(im.size) > small_tex:
                    k = small_tex / max(im.size)
                    im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
            out = os.path.join(out_dir, skin, fname)
            if fname.endswith('.png'):
                im.convert('RGBA').save(out, format='PNG', optimize=True)
            else:
                im.convert('RGB').save(out, format='JPEG', quality=jpeg_quality, optimize=True)
        ui = {}
        if os.path.isfile(os.path.join(sdir, 'ui_skin.json')):
            try:
                ui = json.loads(open(os.path.join(sdir, 'ui_skin.json'), 'rb').read().decode('utf-8', 'replace'))
            except ValueError:
                ui = {}
        listing.append({'id': skin, 'name': ui.get('skinname', ''), 'number': ui.get('number', ''),
                        'swatch': paint_swatch(os.path.join(out_dir, skin, 'paint.jpg'))})
    with open(os.path.join(out_dir, 'skins.json'), 'w') as fh:
        json.dump(listing, fh, indent=1)
    print(f'  {len(listing)} skins -> {out_dir}')
    return listing


def export_auto_skins(car_dir, preset, textures, materials, skin_files, out_dir, max_tex, jpeg_quality, default_skin,
                      only=None):
    """Every skin's livery files (an `auto` preset's: each colour map made from a texture a livery replaces) into
    <out_dir>/<skin>/, and skins.json listing them (its name, number, two main colours from its paint, and `files`).
    A skin gets only the files whose textures differ from the default skin's, the one the GLB is painted in: the rest
    stay as the model has them (CarSkin.files). The default skin is listed first. `only`: the skin folders to export
    (by folder name or id), the default skin always among them."""
    by_name = {m['name']: m for m in materials}
    names = {n.lower() for n in preset.get('skin_textures', ())}
    files = sorted({(f, key) for f, key in skin_files.values()})
    paint_file = next((f for f, key in files if key.split(':', 1)[-1] in preset['paint'] or
                       any(key == (by_name[p]['maps'].get('txDiffuse') or '') for p in preset['paint'])), None)
    if paint_file is None:
        # An automatic preset whose paint no skin repaints: each livery's colours from its first file
        paint_file = files[0][0]

    def sources(key):
        if key.startswith(('bake:', 'bakemean:')):
            maps = by_name[key.split(':', 1)[1]]['maps']
            return [maps[s] for s in ('txDiffuse', 'txDetail') if maps.get(s)]
        return [key]

    def image(key, src):
        im = baked_image(key, src, by_name, max_tex) if key.startswith(('bake:', 'bakemean:')) else decode(src[key])
        if max(im.size) > max_tex:
            k = max_tex / max(im.size)
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        return im

    base = {**textures, **skin_overrides(car_dir, default_skin, textures, names)}
    skins = sorted(d for d in os.listdir(os.path.join(car_dir, 'skins')) if os.path.isdir(os.path.join(car_dir, 'skins', d)))
    ids = unique_skin_ids(preset, skins)
    if only is not None:
        skins = [d for d in skins if d == default_skin or d in only or ids[d] in only]
    skins.sort(key=lambda d: d != default_skin)
    listing = []
    written = 0
    for skin in skins:
        src = {**textures, **skin_overrides(car_dir, skin, textures, names)}
        sid = ids[skin]
        os.makedirs(os.path.join(out_dir, sid), exist_ok=True)
        own = []
        for fname, key in files:
            if all(src[n] == base[n] for n in sources(key)):
                continue
            im = image(key, src)
            out = os.path.join(out_dir, sid, fname)
            if fname.endswith('.png'):
                im.convert('RGBA').save(out, format='PNG', optimize=True)
            else:
                im.convert('RGB').save(out, format='JPEG', quality=jpeg_quality, optimize=True)
            own.append(fname)
            written += 1
        paint = image(next(k for f, k in files if f == paint_file), src)
        ui = {}
        ui_path = os.path.join(car_dir, 'skins', skin, 'ui_skin.json')
        if os.path.isfile(ui_path):
            try:
                ui = json.loads(open(ui_path, 'rb').read().decode('utf-8-sig', 'replace'))
            except ValueError:
                ui = {}
        entry = {'id': sid, 'name': str(ui.get('skinname', '')).strip(), 'number': str(ui.get('number', '')),
                 'swatch': paint_swatch(paint), 'files': own}
        if preset.get('generated'):
            # The skin's own folder, for its preview picture (scripts/mods/importers/ac-car.ts)
            entry['folder'] = skin
        if skin in preset.get('skin_variants', {}):
            entry['variant'] = preset['skin_variants'][skin]
        listing.append(entry)
    with open(os.path.join(out_dir, 'skins.json'), 'w') as fh:
        json.dump(listing, fh, indent=1, ensure_ascii=False)
    print(f'  {len(listing)} skins, {written} livery files -> {out_dir}')
    return listing


def world_mesh(node):
    me = node['mesh']
    w = node['world']
    R, t = w[:3, :3], w[:3, 3]
    pos = me['pos'].astype(np.float64) @ R.T + t
    nrm = me['nrm'].astype(np.float64) @ np.linalg.inv(R)
    tris = me['idx'].reshape(-1, 3).astype(np.uint32)
    if np.linalg.det(R) < 0:
        tris = tris[:, ::-1]
    return pos, nrm, me['uv'].astype(np.float32).copy(), tris


def merge(parts):
    pos, nrm, uv, tris, off = [], [], [], [], 0
    for p, n, u, t in parts:
        pos.append(p)
        nrm.append(n)
        uv.append(u)
        tris.append(t + off)
        off += len(p)
    return np.vstack(pos), np.vstack(nrm), np.vstack(uv), np.vstack(tris)


def uv_region(uv):
    """Integer tile offset and [u0, v0, u1, v1] bounds of a UV set that stays inside one texture repeat"""
    tile = np.floor(uv.min(0))
    lo, hi = uv.min(0) - tile, uv.max(0) - tile
    assert (hi <= 1.0 + 1e-4).all(), 'UVs span more than one repeat'
    return tile, np.r_[lo, hi]


def classify(nodes, i, preset, mat):
    """('skip'|'body'|'steer'|'tyre'|'rim'|'hub', corner) of node `i`, whose mesh has kn5 material `mat`. A hub part
    hangs off a corner's SUSP_xx (an upright, a calliper, a fixed hub fairing): it steers and rides with the wheel but
    doesn't spin"""
    n = nodes[i]
    anc = ancestors(nodes, i)
    if (any(a.startswith('RIM_BLUR_') for a in anc) or n['name'].startswith(preset['skip_node_prefixes'])
            or n['name'] in preset['skip_nodes'] or any(a in preset['skip_nodes'] for a in anc)):
        return 'skip', None
    for a in anc:
        if a.startswith('WHEEL_') and a[6:] in CORNERS:
            # An automatic preset names the tyre meshes it found (`detect_tyres`)
            if preset.get('tyre_nodes') is not None:
                return ('tyre' if i in preset['tyre_nodes'] else 'rim'), a[6:]
            if preset.get('tyre_materials'):
                return ('tyre' if mat in preset['tyre_materials'] else 'rim'), a[6:]
            return ('tyre' if n['name'].startswith(preset['tyre_prefix']) else 'rim'), a[6:]
        for prefix in preset['spinning']:
            if a.startswith(prefix) and a[len(prefix):] in CORNERS:
                return 'rim', a[len(prefix):]
        if a.startswith('SUSP_') and a[5:] in CORNERS:
            return 'hub', a[5:]
        if a.startswith('STEER_HR'):
            return 'steer', None
    return 'body', None


def read_ksanim(path):
    """{node name: [4x4 local matrix per frame]} of an AC .ksanim (version 1: matrices; 2: rotation quaternion x, y, z,
    w, translation and scale per frame)"""
    b = open(path, 'rb').read()
    o = 0

    def i32():
        nonlocal o
        o += 4
        return struct.unpack_from('<i', b, o - 4)[0]

    version, out = i32(), {}
    for _ in range(i32()):
        n = i32()
        name = b[o:o + n].decode('latin1')
        o += n
        count = i32()
        if version == 1:
            fr = np.frombuffer(b, '<f4', count * 16, o).astype(np.float64).reshape(count, 4, 4)
            o += count * 64
            out[name] = [m.T for m in fr]
            continue
        fr = np.frombuffer(b, '<f4', count * 10, o).astype(np.float64).reshape(count, 10)
        o += count * 40
        mats = []
        for x, y, z, w, tx, ty, tz, sx, sy, sz in fr:
            r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
            m = np.eye(4)
            m[:3, :3] = r * np.array([sx, sy, sz])
            m[:3, 3] = (tx, ty, tz)
            mats.append(m)
        out[name] = mats
    return out


def ancestor_ids(nodes, i):
    out = []
    p = nodes[i]['parent']
    while p is not None:
        out.append(p)
        p = nodes[p]['parent']
    return out


def pose_nodes(car_dir, preset, nodes):
    """Put the preset's `part_poses` nodes ({node: (ksanim file, frame)}) where that frame of the mod's animation has
    them (a part the setup scales out of sight at rest, such as an aero kit), their subtrees with them"""
    for name, (fname, frame) in preset.get('part_poses', {}).items():
        local = read_ksanim(os.path.join(car_dir, 'animations', fname))[name][frame]
        i = next(k for k, n in enumerate(nodes) if n['name'] == name and n['kind'] == 1)
        parent = nodes[i]['parent']
        world = (nodes[parent]['world'] if parent is not None else np.eye(4)) @ local
        delta = world @ np.linalg.inv(nodes[i]['world'])
        for k in range(len(nodes)):
            if k == i or i in ancestor_ids(nodes, k):
                nodes[k]['world'] = delta @ nodes[k]['world']


def add_extension_parts(car_dir, preset, textures, materials, nodes):
    """Append the preset's `extra_kn5` (the mod's `extension/` kn5s, in the car's frame) to `nodes`, and return
    {node index: part} for every mesh in a part (`parts` names kn5 nodes whose subtrees are one). An extension material
    with the car's own name and maps is the car's; one that differs is added as `<name>~<file stem>`, and its textures
    only where the car has none of that name"""
    part_of = {}
    by_name = {m['name']: i for i, m in enumerate(materials)}
    for fname, part in preset.get('extra_kn5', ()):
        tex, mats, ext_nodes = read_kn5(os.path.join(car_dir, 'extension', fname))
        for k, v in tex.items():
            textures.setdefault(k, v)
        remap = {}
        for i, m in enumerate(mats):
            own = by_name.get(m['name'])
            if own is not None and materials[own]['maps'] == m['maps']:
                remap[i] = own
            else:
                materials.append({**m, 'name': f"{m['name']}~{fname.rsplit('.', 1)[0]}"})
                remap[i] = len(materials) - 1
        base = len(nodes)
        for n in ext_nodes:
            n = dict(n)
            if n['parent'] is not None:
                n['parent'] += base
            if n['mesh'] is not None:
                n['mesh'] = {**n['mesh'], 'mat': remap[n['mesh']['mat']]}
                part_of[len(nodes)] = part
            nodes.append(n)
    parts = preset.get('parts', {})
    for i, n in enumerate(nodes):
        if n['mesh'] is None or i in part_of:
            continue
        for name in [n['name'], *ancestors(nodes, i)]:
            if name in parts:
                part_of[i] = parts[name]
                break
    return part_of


# ---------------------------------------------------------------------------------------------------------------------
# The tyres as a mod's extension config draws them (an automatic preset's car). Its extension/ext_config.ini may give
# each set of compounds tyre meshes of their own ([TYRES_FX_CUSTOM_MESHES_...]: a grooved dry tyre and a slick, both in
# the kn5 at once) and textures of their own ([TYRES_FX_CUSTOMTEXTURE_<compound>]: from a zip under the game's
# extension/textures). The car is drawn as that config draws it on the data's default compound: that compound's meshes, the
# others hidden, in its textures. A tyre whose tread and sidewall are kn5 materials with textures of their own then
# becomes one material over a texture of both, since the rig draws a tyre as one primitive.
# ---------------------------------------------------------------------------------------------------------------------

def ext_config_sections(car_dir):
    """The mod's extension/ext_config.ini as [(section, {KEY: value})], in order and with repeated sections kept (the
    game numbers `..._...` sections itself); [] without one"""
    path = os.path.join(car_dir, 'extension', 'ext_config.ini')
    if not os.path.isfile(path):
        return []
    out = []
    for line in open(path, 'rb').read().decode('latin1').splitlines():
        line = line.split(';', 1)[0].strip()
        if line.startswith('[') and line.endswith(']'):
            out.append((line[1:-1].strip(), {}))
        elif out and '=' in line:
            k, v = line.split('=', 1)
            out[-1][1][k.strip().upper()] = v.strip()
    return out


def default_compound(data):
    """The short name of the data's default tyre compound (tyres.ini COMPOUND_DEFAULT), or None"""
    cp = ini(data.get('tyres.ini', ''))
    idx = int(float(cp['COMPOUND_DEFAULT'].get('INDEX', '0'))) if cp.has_section('COMPOUND_DEFAULT') else 0
    sec = 'FRONT' if idx == 0 else f'FRONT_{idx}'
    if not cp.has_section(sec):
        return None
    return cp[sec].get('SHORT_NAME', '').strip() or None


def extension_texture(car_dir, ref):
    """The bytes of an extension texture reference (`cars\\pack.zip::file.dds` under the game's extension/textures, or a loose
    file there), or None"""
    import zipfile
    root = os.path.normpath(os.path.join(car_dir, '..', '..', '..', 'extension', 'textures'))
    path, _, member = ref.replace('\\', '/').partition('::')
    full = os.path.join(root, path)
    if not os.path.isfile(full):
        return None
    if not member:
        return open(full, 'rb').read()
    with zipfile.ZipFile(full) as z:
        name = next((n for n in z.namelist() if n.lower() == member.lower()), None)
        return z.read(name) if name else None


def apply_extension_tyres(car_dir, data, textures, materials, nodes):
    """Hide the tyre meshes the extension config shows only for compounds other than the default one, and give the default compound's
    tyre materials the config's textures for it. Returns what it did, for the report"""
    sections = ext_config_sections(car_dir)
    short = default_compound(data)
    done = {'compound': short, 'hidden': [], 'textures': {}}
    if not sections or not short:
        return done
    sets = []
    for name, kv in sections:
        if not name.upper().startswith('TYRES_FX_CUSTOM_MESHES'):
            continue
        for k, v in kv.items():
            m = re.fullmatch(r'TYRES_(\d+)', k)
            if m and f'TYRES_{m[1]}_MESHES' in kv:
                sets.append(({c.strip() for c in v.split(',')}, {s.strip() for s in kv[f'TYRES_{m[1]}_MESHES'].split(',')}))
    keep = next((meshes for comps, meshes in sets if short in comps), None)
    if keep is not None:
        # Names matched loosely, as a mod may misspell them (F1 2007's config lists SSide_RF for SSideRF)
        loose = lambda name: name.replace('_', '').lower()  # noqa: E731
        hide = {loose(m) for m in set().union(*(meshes for _, meshes in sets)) - keep} - {loose(m) for m in keep}
        for i, n in enumerate(nodes):
            if n['mesh'] is not None and hide.intersection(map(loose, [n['name'], *ancestors(nodes, i)])):
                n['mesh']['visible'] = False
                done['hidden'].append(n['name'])
    by_name = {m['name']: m for m in materials}
    pattern = re.compile(rf'TYRES_FX_CUSTOMTEXTURE_{re.escape(short)}(_\d+)?', re.I)
    for name, kv in sections:
        if not pattern.fullmatch(name) or kv.get('MATERIAL') not in by_name:
            continue
        mat = by_name[kv['MATERIAL']]
        for key, slot in (('TXDIFFUSE', 'txDiffuse'), ('TXNORMAL', 'txNormal')):
            raw = extension_texture(car_dir, kv[key]) if kv.get(key) else None
            if raw is None:
                continue
            tex_name = 'ext:' + kv[key].replace('\\', '/').rsplit(':', 1)[-1]
            textures[tex_name] = raw
            mat['maps'] = {**mat['maps'], slot: tex_name}
            done['textures'][f"{kv['MATERIAL']}.{slot}"] = tex_name
    return done


def merge_tyre_textures(textures, materials, nodes):
    """A tyre drawn in several kn5 materials with textures of their own (a tread and a sidewall) as one material over
    one texture of them all: each material's maps in a band of its own, top to bottom, and its meshes' UVs moved into
    that band. Only where every such mesh's UVs stay within one tile, which a band can hold. Returns the merged
    material's name, or None"""
    tyre = detect_tyres(nodes, materials)
    mats = list(dict.fromkeys(nodes[i]['mesh']['mat'] for i in tyre['nodes']))
    diffuse = [materials[m]['maps'].get('txDiffuse') for m in mats]
    if len(mats) < 2 or len(set(diffuse)) < 2 or not all(d in textures for d in diffuse):
        return None
    tiles = {}
    for i in tyre['nodes']:
        uv = nodes[i]['mesh']['uv']
        u0, u1, v0, v1 = uv[:, 0].min(), uv[:, 0].max(), uv[:, 1].min(), uv[:, 1].max()
        tile = math.floor(v0 + 1e-3)
        if u0 < -1e-3 or u1 > 1 + 1e-3 or v1 > tile + 1 + 1e-3:
            return None
        tiles[i] = tile
    k = len(mats)
    side = 1024

    def band_image(slot, fill):
        img = Image.new('RGBA', (side, side * k), fill)
        for b, m in enumerate(mats):
            name = materials[m]['maps'].get(slot)
            if name in textures:
                im = Image.open(io.BytesIO(textures[name])).convert('RGBA').resize((side, side), Image.LANCZOS)
                img.paste(im, (0, b * side))
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return buf.getvalue()

    textures['merged:tyre.png'] = band_image('txDiffuse', (0, 0, 0, 255))
    maps = {'txDiffuse': 'merged:tyre.png'}
    if any(materials[m]['maps'].get('txNormal') in textures for m in mats):
        textures['merged:tyre_nm.png'] = band_image('txNormal', (128, 128, 255, 255))
        maps['txNormal'] = 'merged:tyre_nm.png'
    first = materials[mats[0]]
    materials.append({**first, 'name': 'tyre_merged', 'maps': maps})
    merged = len(materials) - 1
    for i in tyre['nodes']:
        me = nodes[i]['mesh']
        b = mats.index(me['mat'])
        uv = me['uv'].astype(np.float32).copy()
        # v runs down the image from the tile's top; the band holds it at 1/k of the height, half a texel in
        uv[:, 1] = tiles[i] + (b + np.clip(uv[:, 1] - tiles[i], 0.5 / side, 1 - 0.5 / side)) / k
        nodes[i]['mesh'] = {**me, 'uv': uv, 'mat': merged}
    return 'tyre_merged'


def read_digital_items(data, nodes, frames):
    """The texts digital_instruments.ini draws ([ITEM_n]: a gear, speed, rpm, fuel, lap time ... on a node's plane), as
    the rig's `digitalItems` extras: each with its parent node's frame in the node the rig puts it on (`frames`: kn5
    node name -> (rig node, 4x4 in that node's axes)), its place, size, colour and format. AC draws each from its
    POSITION along the node's -X (the driver's right), its baseline there, SIZE high"""
    if 'digital_instruments.ini' not in data:
        return []
    cp = ini(data['digital_instruments.ini'])
    items = []
    for name in sorted((s for s in cp.sections() if s.startswith('ITEM_')), key=lambda s: int(s[5:]) if s[5:].isdigit() else 0):
        # Values without their `//` comments
        sec = {k.upper(): v.split('//')[0].strip() for k, v in cp[name].items()}
        parent = sec.get('PARENT', '').strip()
        if parent not in frames or not sec.get('TYPE'):
            continue
        attach, frame = frames[parent]
        rgba = [float(x) for x in sec.get('COLOR', '255,255,255,255').split(',')[:4] if x.strip()]
        rgba = (rgba + [255.0] * 4)[:4]
        item = {
            'attach': attach,
            'frame': [round(float(v), 6) for v in np.asarray(frame).T.reshape(-1)],
            'type': sec['TYPE'].strip().upper(),
            'position': [round(float(v), 5) for v in vec3(sec.get('POSITION', '0,0,0'))],
            'size': float(sec.get('SIZE', '0.01')),
            'color': [round(c / 255, 4) for c in rgba],
            'intensity': float(sec.get('INTENSITY', '1')),
            'font': sec.get('FONT', '').strip(),
            'align': sec.get('ALIGN', 'LEFT').strip().upper(),
        }
        for key, field in (('TEXT', 'text'), ('PREFIX', 'prefix'), ('POSTFIX', 'postfix'), ('UNITS', 'units')):
            if sec.get(key, '').strip():
                item[field] = sec[key].strip()
        if sec.get('DECIMALS', '').strip():
            item['decimals'] = int(float(sec['DECIMALS']))
        items.append(item)
    return items


# ---------------------------------------------------------------------------------------------------------------------
# Automatic presets: a car with no preset of its own. AC cars keep a few conventions the rig relies on (the WHEEL_xx
# hubs, STEER_HR, car.ini's DRIVEREYES); the rest of a preset is found in the model. The tyres are the meshes under each
# WHEEL_xx that AC's tyre shader draws or that are named as tyres, else the outermost ring round the hub; the paint is
# the body material named as paint, covering the most of the body and repainted by the most skins; the windscreen is the
# glass in front of the driver's eyes. The materials come from their shader values (`auto`), and every texture a skin
# replaces is a livery file. ui/ui_car.json names the car.
# ---------------------------------------------------------------------------------------------------------------------

# The low-detail cockpit AC swaps in at a distance, and the belts drawn fastened round a driver the car doesn't carry
AUTO_SKIP_NODES = ('COCKPIT_LR', 'CINTURE_ON')
_TYRE_WORD = re.compile(r'tyre|tire|gomma|pneu|reifen|rubber', re.I)
_NOT_TYRE = re.compile(r'rim|blur|brake|disc|disk|calip|hub|nut|bolt|valve|spoke|lug', re.I)
_PAINT_WORD = re.compile(r'paint|livery', re.I)
_BODY_WORD = re.compile(r'body|skin|ext_?main|exterior|shell|carroz', re.I)
_NOT_PAINT = re.compile(r'glass|window|light|lamp|lens|tyre|tire|rim|brake|disc|chrome|mirror|interior|(^|_)int_|cockpit|'
                        r'seat|dash|carbon|decal|logo|number|badge|plate|grill|black|rubber|exhaust|engine|shadow|wheel',
                        re.I)
_BROKEN_GLASS = re.compile(r'damage.?glass|glass.?damage|broken.?glass', re.I)
_BLUR = re.compile(r'blur', re.I)


def read_loose_json(path):
    """A JSON file as mods write them: a byte-order mark, raw line breaks in strings and trailing commas are let pass
    ({} when it still can't be read)"""
    if not os.path.isfile(path):
        return {}
    text = open(path, 'rb').read().decode('utf-8-sig', 'replace')
    for attempt in (text, re.sub(r',\s*([}\]])', r'\1', text)):
        try:
            out = json.loads(attempt, strict=False)
            return out if isinstance(out, dict) else {}
        except ValueError:
            continue
    return {}


def car_model_path(car_dir, name):
    """A model the car's data names (lods.ini's FILE), as a path inside the car folder with '/' between its folders, or
    None: not a .kn5, an absolute path, a drive, a '..' step, a link that leads out of the folder, or no such file
    (scripts/cars/ac-car-info.ts `carModelPath` reads it the same way)"""
    raw = name.strip()
    parts = raw.replace('\\', '/').split('/')
    if not raw.lower().endswith('.kn5') or parts[0] == '' or re.match(r'^[A-Za-z]:', parts[0]) or '..' in parts:
        return None
    parts = [p for p in parts if p not in ('', '.')]
    root = os.path.realpath(car_dir)
    full = os.path.join(root, *parts)
    if not parts or not os.path.isfile(full) or not os.path.realpath(full).startswith(root + os.sep):
        return None
    return '/'.join(parts)


def find_kn5(car_dir, data=None):
    """The car's main model: <folder name>.kn5, else the file lods.ini names for LOD_0 when it is a model inside the
    folder (`car_model_path`), else the largest kn5 in the folder that is neither its collider nor a lower LOD (nor a link
    out of the folder)"""
    folder = os.path.basename(os.path.normpath(car_dir))
    if os.path.isfile(os.path.join(car_dir, f'{folder}.kn5')):
        return f'{folder}.kn5'
    data = read_car_data(car_dir) if data is None else data
    lods = next((v for k, v in data.items() if k.lower() == 'lods.ini'), None)
    if lods:
        cp = ini(lods)
        sec = next((s for s in cp.sections() if s.upper() == 'LOD_0'), None)
        name = car_model_path(car_dir, cp[sec].get('FILE', '')) if sec else None
        if name:
            return name
    lower = re.compile(r'(^collider|_lod_?[b-z]|_[b-z])\.kn5$', re.I)
    found = [f for f in os.listdir(car_dir) if f.lower().endswith('.kn5') and not lower.search(f) and car_model_path(car_dir, f)]
    if not found:
        raise SystemExit(f'{car_dir}: no .kn5 model in the folder')
    return max(found, key=lambda f: os.path.getsize(os.path.join(car_dir, f)))


def skin_folders(car_dir):
    sdir = os.path.join(car_dir, 'skins')
    return sorted(d for d in os.listdir(sdir) if os.path.isdir(os.path.join(sdir, d))) if os.path.isdir(sdir) else []


def skin_override_counts(car_dir, textures):
    """{kn5 texture name (lower case): how many skins replace it}"""
    lower = {t.lower() for t in textures}
    counts = {}
    for skin in skin_folders(car_dir):
        for f in os.listdir(os.path.join(car_dir, 'skins', skin)):
            if f.lower() in lower:
                counts[f.lower()] = counts.get(f.lower(), 0) + 1
    return counts


def visible_meshes(nodes):
    """Indices of the nodes with a mesh AC draws"""
    return [i for i, n in enumerate(nodes)
            if n['mesh'] is not None and n['active'] and n['mesh']['visible'] and n['mesh']['renderable']]


def wheel_corner(nodes, i):
    """The corner of the nearest WHEEL_xx above node `i` (as `classify` reads it), or None"""
    for a in ancestors(nodes, i):
        if a.startswith('WHEEL_') and a[6:] in CORNERS:
            return a[6:]
    return None


def detect_tyres(nodes, materials):
    """The tyre meshes under each WHEEL_xx: {'nodes': their indices, 'materials': their kn5 materials (the first names
    the merged tyre: AC's tyre shader first, then the most vertices), 'how': {corner: how it was found}}. A tyre is drawn
    by AC's tyre shader or named as one (its material, else its node), and reaches the wheel's outer edge; failing
    those, it is the outermost ring round the hub: the meshes reaching within 3 % of the wheel's largest radius, about
    the spin axis (X), whose own hole is at least 40 % of their radius"""
    found, how = [], {}
    for c in CORNERS:
        meshes = [i for i in visible_meshes(nodes) if wheel_corner(nodes, i) == c
                  and not any(a.startswith('RIM_BLUR_') for a in ancestors(nodes, i))
                  and not nodes[i]['name'].startswith('RIM_BLUR_')
                  and not _BLUR.search(materials[nodes[i]['mesh']['mat']]['name'])]
        if not meshes:
            raise SystemExit(f'nothing drawn under WHEEL_{c}: not an Assetto Corsa car model laid out for the game')
        pts = {i: world_mesh(nodes[i])[0] for i in meshes}
        allp = np.vstack(list(pts.values()))
        centre = 0.5 * (allp.min(0) + allp.max(0))
        radii = {}
        for i, p in pts.items():
            r = np.hypot(p[:, 1] - centre[1], p[:, 2] - centre[2])
            radii[i] = (float(r.min()), float(r.max()))
        outer = max(r[1] for r in radii.values())

        def named(i):
            m = materials[nodes[i]['mesh']['mat']]
            if m['shader'] == 'ksTyres':
                return 'tyre shader'
            if _TYRE_WORD.search(m['name']) and not _NOT_TYRE.search(m['name']):
                return 'material name'
            if _TYRE_WORD.search(nodes[i]['name']) and not _NOT_TYRE.search(nodes[i]['name']):
                return 'node name'
            return None

        by_name = [i for i in meshes if named(i) and radii[i][1] >= 0.9 * outer]
        if by_name:
            found += by_name
            how[c] = named(by_name[0])
            continue
        ring = [i for i in meshes if radii[i][1] >= 0.97 * outer and radii[i][0] >= 0.4 * radii[i][1]]
        if not ring:
            raise SystemExit(f'no tyre under WHEEL_{c}: no mesh is named as a tyre, and none is a ring at the wheel\'s '
                             f'outer edge (its tyre and rim are one mesh?)')
        found += ring
        how[c] = 'outermost ring'
    verts = {}
    for i in found:
        name = materials[nodes[i]['mesh']['mat']]['name']
        verts[name] = verts.get(name, 0) + len(nodes[i]['mesh']['pos'])
    by_mat = {m['name']: m for m in materials}
    order = sorted(verts, key=lambda n: (by_mat[n]['shader'] != 'ksTyres', -verts[n], n))
    return {'nodes': set(found), 'materials': tuple(order), 'how': how}


def detect_paint(nodes, materials, overrides, n_skins):
    """The body's paint material and every candidate's score: the share of the body it covers (against the largest),
    the share of the skins that repaint one of its maps, a paint's name, and a part's name against it"""
    by_name = {m['name']: m for m in materials}
    area = {}
    for i in visible_meshes(nodes):
        if wheel_corner(nodes, i) or any(a.startswith('STEER_HR') for a in ancestors(nodes, i)):
            continue
        m = materials[nodes[i]['mesh']['mat']]
        if m['blend'] == 1 or m['shader'] == 'ksTyres':
            continue
        pos, _, _, tris = world_mesh(nodes[i])
        if not len(tris):
            continue
        e1, e2 = pos[tris[:, 1]] - pos[tris[:, 0]], pos[tris[:, 2]] - pos[tris[:, 0]]
        area[m['name']] = area.get(m['name'], 0.0) + float(0.5 * np.linalg.norm(np.cross(e1, e2), axis=1).sum())
    if not area:
        return None, {}
    top = max(area.values()) or 1.0
    scores = {}
    for name, a in area.items():
        maps = [by_name[name]['maps'].get(s) for s in ('txDiffuse', 'txDetail')]
        repainted = max((overrides.get(t.lower(), 0) for t in maps if t), default=0) / max(1, n_skins)
        s = 3.0 * a / top + 3.0 * repainted
        if _PAINT_WORD.search(name):
            s += 3.0
        elif _BODY_WORD.search(name):
            s += 1.0
        if _NOT_PAINT.search(name) and not _PAINT_WORD.search(name):
            s -= 2.0
        if 'MultiMap' in by_name[name]['shader']:
            s += 0.5
        scores[name] = round(s, 3)
    return max(scores, key=lambda n: (scores[n], area[n])), scores


_OUTER_GLASS = re.compile(r'ext|out|wind|front|screen|_ex($|_)', re.I)
_INNER_GLASS = re.compile(r'(^|[_\s])int|interior|inner|inside|_in($|_)|gauge|dash|instrument|lcd|display|visor|helmet',
                          re.I)


def _ray_hits(origin, dirs, pos, tris):
    """Which of the rays from `origin` along `dirs` (n x 3) cross any of the triangles, 30 cm to 3 m out"""
    v0, v1, v2 = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    e1, e2 = v1 - v0, v2 - v0
    hits = np.zeros(len(dirs), bool)
    for k, d in enumerate(dirs):
        pv = np.cross(d, e2)
        det = (e1 * pv).sum(1)
        ok = np.abs(det) > 1e-9
        inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
        tv = origin - v0
        u = (tv * pv).sum(1) * inv
        qv = np.cross(tv, e1)
        v = (qv @ d) * inv
        t = (e2 * qv).sum(1) * inv
        hits[k] = bool((ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0.3) & (t < 3.0)).any())
    return hits


def detect_windscreen(nodes, materials, eyes):
    """The glass in front of the driver's eyes (the dash camera is fitted to it), or None: of the glass materials (by
    name, or AC's windscreen shader), the one the most sight lines from the eyes pass through (40 deg either side,
    8 deg down to 12 up), an outer layer's name counting for more and an inner layer's or a gauge's for less"""
    dirs = np.array([[math.sin(math.radians(y)) * math.cos(math.radians(p)), math.sin(math.radians(p)),
                      math.cos(math.radians(y)) * math.cos(math.radians(p))]
                     for y in range(-40, 41, 5) for p in range(-8, 13, 4)])
    meshes = {}
    for i in visible_meshes(nodes):
        if wheel_corner(nodes, i):
            continue
        m = materials[nodes[i]['mesh']['mat']]
        if _BROKEN_GLASS.search(m['name']) or not (m['shader'] == 'ksWindscreen' or _GLASSISH.search(m['name'])):
            continue
        pos, _, _, tris = world_mesh(nodes[i])
        if len(tris):
            meshes.setdefault(m['name'], []).append((pos, tris))
    score = {}
    for name, parts in meshes.items():
        hit = np.zeros(len(dirs), bool)
        for pos, tris in parts:
            hit |= _ray_hits(np.asarray(eyes, float), dirs, pos, tris)
        weight = (1.5 if _OUTER_GLASS.search(name) else 1.0) * (0.25 if _INNER_GLASS.search(name) else 1.0)
        score[name] = weight * int(hit.sum())
    best = max(score, key=lambda n: (score[n], n), default=None)
    return best if best is not None and score[best] >= 2 else None


def ini_driver_eyes(data):
    """car.ini's [GRAPHICS] DRIVEREYES (the kn5's frame), whatever the file's case; None when it has none"""
    car_ini = next((v for k, v in data.items() if k.lower() == 'car.ini'), None)
    if car_ini:
        cp = ini(car_ini)
        if cp.has_section('GRAPHICS') and cp['GRAPHICS'].get('DRIVEREYES'):
            try:
                eyes = vec3(cp['GRAPHICS']['DRIVEREYES'])
            except ValueError:
                return None
            if len(eyes) == 3 and all(math.isfinite(v) for v in eyes):
                return np.array(eyes)
    return None


def driver_eyes(nodes, data):
    """car.ini's DRIVEREYES (the kn5's frame), else 27 cm over and 47 cm behind STEER_HR; None without either"""
    eyes = ini_driver_eyes(data)
    if eyes is not None:
        return eyes
    steer = next((n for n in nodes if n['name'] == 'STEER_HR' and n['kind'] == 1), None)
    return steer['world'][:3, 3] + [0, 0.27, -0.47] if steer is not None else None


# The glass of a mirror mirrors.ini names: reflective while the game's live mirror is off (an opponent, a far view)
MIRROR_GLASS = dict(name='mirror_face', color=(235, 235, 235), metal=1.0, rough=0.02)


def read_mirrors(data):
    """mirrors.ini's [MIRROR_n] sections, in order: [(section, NAME)], the NAME a kn5 node's; [] without the file"""
    text = next((v for k, v in data.items() if k.lower() == 'mirrors.ini'), None)
    if not text:
        return []
    cp = ini(text)
    found = []
    for s in cp.sections():
        m = re.fullmatch(r'MIRROR_(\d+)', s.strip(), re.I)
        name = cp[s].get('NAME', '').strip()
        if m and name:
            found.append((int(m.group(1)), f'MIRROR_{m.group(1)}', name))
    return [(section, name) for _, section, name in sorted(found)]


def mirror_meshes(nodes, mirrors):
    """{index of a mesh node: its mirrors.ini section}: the mesh named exactly as the section's NAME (the kn5 has a
    transform and a mesh of that name), else the meshes under a node of that name. Exact names only: a bare
    `hon_body_a` must not take in the rest of `hon_body_a.*`"""
    out = {}
    for section, name in mirrors:
        own = [i for i, n in enumerate(nodes) if n['mesh'] is not None and n['name'] == name]
        if not own:
            own = [i for i, n in enumerate(nodes) if n['mesh'] is not None and name in ancestors(nodes, i)]
        for i in own:
            out.setdefault(i, section)
    return out


def auto_preset(car_dir, loaded, data, kn5_name, title=None, overrides=None, n_skins=None):
    """A preset for a car with none (see above), with `detected`: what was found and how. `overrides` and `n_skins`
    (the skins' replaced textures) default to the car folder's skins"""
    textures, materials, nodes = loaded
    skins = skin_folders(car_dir) if car_dir else []
    if overrides is None:
        overrides = skin_override_counts(car_dir, textures)
    n_skins = len(skins) if n_skins is None else n_skins
    tyres = detect_tyres(nodes, materials)
    paint, paint_scores = detect_paint(nodes, materials, overrides, n_skins)
    eyes = driver_eyes(nodes, data)
    windscreen = detect_windscreen(nodes, materials, eyes) if eyes is not None else None
    names = {n['name'] for n in nodes}
    spinning = ('DISC_',) if all(f'DISC_{c}' in names for c in CORNERS) else ()
    # The wheel's shift lights (digital_instruments.ini) as nodes of their own, so the game can light each
    leds = tuple(sorted({led['node'] for led in (read_rev_leds(data, names) or {}).get('leds', [])}))
    skip_materials = {m['name'] for m in materials if _BROKEN_GLASS.search(m['name']) or _BLUR.search(m['name'])}
    by_lower = {t.lower(): t for t in textures}
    skin_textures = tuple(sorted(by_lower.get(t, t) for t in overrides))
    preset = dict(
        title=title or os.path.basename(os.path.normpath(car_dir or 'car')),
        kn5=kn5_name,
        auto=True,
        materials={},
        paint=(paint,) if paint else (),
        skip_materials=skip_materials,
        skip_node_prefixes=('RIM_BLUR_',),
        skip_nodes=AUTO_SKIP_NODES,
        default_skin=skins[0] if skins else None,
        steer_nodes=leds,
        # The same lights where they are on the body (a dash's), each a BODY node of its own
        led_nodes=leds,
        tyre_nodes=tyres['nodes'],
        tyre_materials=tyres['materials'],
        tyre_class=set(tyres['materials']),
        tyre_prefix=None,
        spinning=spinning,
        windscreen=(windscreen,) if windscreen else (),
        skin_textures=skin_textures,
        generated=True,
    )
    preset['detected'] = {
        'tyres': tyres['how'],
        'tyreMaterials': list(tyres['materials']),
        'tyreNodes': sorted({nodes[i]['name'] for i in tyres['nodes']}),
        'paint': paint,
        'paintScores': dict(sorted(paint_scores.items(), key=lambda kv: -kv[1])[:5]),
        'windscreen': windscreen,
        'spinning': list(spinning),
        'skipMaterials': sorted(skip_materials),
        'skinTextures': list(skin_textures),
        'defaultSkin': preset['default_skin'],
        'skins': len(skins),
    }
    return preset


def synthetic_model(spec):
    """Materials and nodes (as `read_kn5` gives them) of a model described in JSON, for testing the detection without a
    car: nodes [{name, parent, t: [x, y, z] (a transform), or mat + shape: ring (r, r0, w) / disc (r, w) / box (size)}]"""
    materials = [{'name': m['name'], 'shader': m.get('shader', 'ksPerPixel'), 'blend': m.get('blend', 0),
                  'alpha_tested': False, 'props': m.get('props', {}), 'maps': m.get('maps', {})}
                 for m in spec['materials']]
    nodes = []
    seg = 24
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    for n in spec['nodes']:
        parent = n.get('parent')
        world = (nodes[parent]['world'] if parent is not None else np.eye(4)).copy()
        mesh = None
        if 'mat' in n:
            shape, w = n.get('shape', 'box'), n.get('w', 0.25)
            if shape in ('ring', 'disc'):
                r, r0 = n['r'], (n.get('r0', 0.65 * n['r']) if shape == 'ring' else 0.0)
                pos = [[x, rr * math.sin(a), rr * math.cos(a)] for x in (-w / 2, w / 2) for rr in (r0, r) for a in ang]
                tris = []
                for k in range(seg):
                    q = (k + 1) % seg
                    for b0, b1 in ((seg, 3 * seg), (0, seg), (2 * seg, 3 * seg)):
                        tris += [(b0 + k, b0 + q, b1 + k), (b1 + k, b0 + q, b1 + q)]
            else:
                sx, sy, sz = n.get('size', (1, 1, 1))
                pos = [[x * sx / 2, y * sy / 2, z * sz / 2] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
                tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6),
                        (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
            pos = np.asarray(pos, np.float32) + np.asarray(n.get('at', (0, 0, 0)), np.float32)
            mesh = {'pos': pos, 'nrm': np.zeros_like(pos), 'uv': np.zeros((len(pos), 2), np.float32),
                    'idx': np.asarray(tris, np.uint16).reshape(-1), 'mat': n['mat'], 'visible': True,
                    'transparent': False, 'renderable': True}
        else:
            world[:3, 3] += n.get('t', (0, 0, 0))
        nodes.append({'name': n['name'], 'kind': 2 if mesh else 1, 'active': n.get('active', True), 'world': world,
                      'mesh': mesh, 'parent': parent})
    return materials, nodes


def port(car_dir, out_path, preset, skin, kn5_name, max_tex, small_tex, normal_tex, jpeg_quality, loaded=None):
    MATERIALS = preset['materials']
    kn5_path = os.path.join(car_dir, kn5_name or preset.get('kn5') or f'{os.path.basename(os.path.normpath(car_dir))}.kn5')
    textures, materials, nodes = loaded if loaded is not None else read_kn5(kn5_path)
    pose_nodes(car_dir, preset, nodes)
    part_of = add_extension_parts(car_dir, preset, textures, materials, nodes)
    part_variants = preset.get('part_variants', {})
    by_name = {m['name']: m for m in materials}
    auto = bool(preset.get('auto'))
    skin_tex = {}
    if auto:
        skin_tex = skin_overrides(car_dir, skin, textures)
    elif skin:
        for f in preset['skin_files']:
            p = os.path.join(car_dir, 'skins', skin, f)
            if os.path.isfile(p):
                skin_tex[f] = open(p, 'rb').read()
    data = read_car_data(car_dir)
    stats = TexStats({**textures, **skin_tex})
    specs = {}
    # The meshes mirrors.ini names (`mirror_meshes`): MIRROR_n nodes of their own in a material of their own
    mirror_at = mirror_meshes(nodes, read_mirrors(data))
    mirror_section = {}  # id(part) -> its mirrors.ini section

    def spec_of(key):
        """The material spec of kn5 material `key` ('material@node' for a node's own entry)"""
        if key not in specs:
            base = key.split('@')[0]
            if '@' in key and key.split('@', 1)[1] in mirror_section.values():
                # A mirror's glass ('material@MIRROR_n'): its own material, shared with nothing else
                specs[key] = (MIRROR_GLASS, None)
            elif key in MATERIALS:
                specs[key] = (MATERIALS[key], None)
            elif auto:
                specs[key] = auto_spec(by_name[base], stats, preset, by_name)
            else:
                # Unknown material: its diffuse texture as a plain dielectric
                src = by_name[base]
                specs[key] = (dict(name=key, tex=src['maps'].get('txDiffuse'), rough=0.5,
                                   mode='BLEND' if src['blend'] == 1 else 'OPAQUE'), None)
        return specs[key][0]

    # The textures a livery replaces (`auto` presets): a colour map made from one of them goes at the paint's size cap
    # and becomes a livery file of its own
    skin_names = {n.lower() for n in preset.get('skin_textures', ())}

    def skinnable(tex):
        if not tex or not skin_names:
            return False
        if tex.startswith(('bake:', 'bakemean:')):
            maps = by_name[tex.split(':', 1)[1]]['maps']
            return any((maps.get(s) or '').lower() in skin_names for s in ('txDiffuse', 'txDetail'))
        return tex.lower() in skin_names

    # Visible meshes, by part
    parts = []  # (kind, corner, kn5 material, pos, nrm, uv, tris)
    dropped = {}
    for i, n in enumerate(nodes):
        me = n['mesh']
        if me is None:
            continue
        mat = materials[me['mat']]['name']
        kind, corner = classify(nodes, i, preset, mat)
        if not (n['active'] and me['visible'] and me['renderable']) or mat in preset['skip_materials']:
            kind = 'skip'
        if kind == 'skip':
            dropped[mat] = dropped.get(mat, 0) + 1
            continue
        part = part_of.get(i) if kind == 'body' else None
        parts.append([kind, corner, mat, *world_mesh(n), n['name'], part])
        if kind == 'body' and part is None and i in mirror_at:
            mirror_section[id(parts[-1])] = mirror_at[i]

    # Shift: lowest tyre point to y = 0, X centred on the four tyres
    tyres = [p for p in parts if p[0] == 'tyre']
    assert sorted({p[1] for p in tyres}) == sorted(CORNERS), 'expected one tyre under each WHEEL_xx'
    centres0 = {c: np.mean([0.5 * (p[3].min(0) + p[3].max(0)) for p in tyres if p[1] == c], 0) for c in CORNERS}
    shift = np.array([-np.mean([centres0[c][0] for c in CORNERS]), -min(p[3][:, 1].min() for p in tyres), 0.0])
    for p in parts:
        p[3] = p[3] + shift

    # Wheel centres: tyre bounding-box centres, mirrored exactly per axle
    wheel_centres, tyre_radius, tyre_half_width = {}, {}, {}
    measured = {}
    for c in CORNERS:
        t_pos = np.vstack([p[3] for p in tyres if p[1] == c])
        centre = 0.5 * (t_pos.min(0) + t_pos.max(0))
        measured[c] = centre
        tyre_radius[c] = float(np.hypot(t_pos[:, 1] - centre[1], t_pos[:, 2] - centre[2]).max())
        tyre_half_width[c] = float(0.5 * (t_pos[:, 0].max() - t_pos[:, 0].min()))
    for axle in ('F', 'R'):
        lc, rc = measured['L' + axle], measured['R' + axle]
        x = 0.5 * (lc[0] - rc[0])
        y, z = 0.5 * (lc[1] + rc[1]), 0.5 * (lc[2] + rc[2])
        wheel_centres['WHEEL_L' + axle] = [round(float(x), 5), round(float(y), 5), round(float(z), 5)]
        wheel_centres['WHEEL_R' + axle] = [round(float(-x), 5), round(float(y), 5), round(float(z), 5)]
        r = 0.5 * (tyre_radius['L' + axle] + tyre_radius['R' + axle])
        hw = 0.5 * (tyre_half_width['L' + axle] + tyre_half_width['R' + axle])
        for side in 'LR':
            tyre_radius[side + axle] = round(float(r), 5)
            tyre_half_width[side + axle] = round(float(hw), 5)

    # Steering wheel frame: AC's STEER_HR (local Z down the column into the dash, as the rig turns it)
    steer_node = next((n for n in nodes if n['name'] == 'STEER_HR' and n['kind'] == 1), None)
    if steer_node is not None:
        pivot = steer_node['world'][:3, 3] + shift
        column = steer_node['world'][:3, 2] / np.linalg.norm(steer_node['world'][:3, 2])
        if column[2] < 0:
            column = -column
    else:
        # A model without STEER_HR (an automatic preset's car): a column 20 deg down into the dash, where the driver's
        # eyes put the wheel (the cameras' rule below, the other way round)
        eyes0 = driver_eyes(nodes, data)
        if eyes0 is None:
            raise SystemExit('the model has no STEER_HR and car.ini no DRIVEREYES: nothing places the cockpit')
        pivot = eyes0 + shift + [0, -0.27, 0.47]
        column = np.array([0.0, -math.sin(math.radians(20)), math.cos(math.radians(20))])
    M_steer = make_steer_frame(pivot, column)
    steer_parts = [p for p in parts if p[0] == 'steer']
    steer_tilt_err = 0.0
    if steer_parts:
        rim_pts = np.vstack([p[3] for p in steer_parts])
        normal_axis = np.linalg.svd(rim_pts - rim_pts.mean(0), full_matrices=False)[2][2]
        steer_tilt_err = math.degrees(math.acos(min(1.0, abs(float(normal_axis @ column)))))

    writer = GlbWriter(use_quantization=False)
    writer.j['asset']['generator'] = 'scripts/cars/port_ac_car.py'
    # A mirror's kn5 material is drawn only as the mirror's own (`spec_of`)
    used = {p[2] for p in parts if id(p) not in mirror_section}
    alpha_keys = {s['tex'] for s in MATERIALS.values() if s.get('mode', 'OPAQUE') != 'OPAQUE' and s.get('tex')}
    alpha_keys |= {spec_of(k)['tex'] for k in used if spec_of(k).get('tex') and spec_of(k).get('mode', 'OPAQUE') != 'OPAQUE'}
    pool = TexturePool(writer, textures, skin_tex, materials, max_tex, small_tex, normal_tex, jpeg_quality, alpha_keys)

    # Materials: one glTF material per kn5 material in use; an `auto` preset's kn5 materials that come out the same
    # share one (named by its class and a number, its kn5 names in its extras)
    mat_index = {}
    uv_remap = {}
    shared = {}
    skin_files = {}  # glTF material name -> livery file (`auto` presets)
    # Palette materials (`auto_spec`'s flat colours): (class, metal, roughness) -> material; each colour's cell
    palettes = {}
    palette_cells = {}  # (class, metal, roughness) -> [colour, ...]
    palette_uv = {}  # kn5 material -> (palette key, cell index)

    def palette_cell(pkey, rgb):
        cells = palette_cells.setdefault(pkey, [])
        if rgb not in cells:
            cells.append(rgb)
        return pkey, cells.index(rgb)

    def material_for(kn5_name):
        if kn5_name in mat_index:
            return mat_index[kn5_name]
        # 'material@node': a node with a material entry of its own (the kn5 material's maps)
        src = by_name[kn5_name.split('@')[0]]
        spec = spec_of(kn5_name)
        cls = specs[kn5_name][1]
        mode = spec.get('mode', 'OPAQUE')
        pbr = {'metallicFactor': float(spec.get('metal', 0.0)), 'roughnessFactor': float(spec.get('rough', 0.5))}
        colour = [1.0, 1.0, 1.0]
        alpha = float(spec.get('alpha', 1.0))
        tex = src['maps']['txDetail'] if spec.get('detail') else spec.get('tex')
        if tex and tex.startswith('mean:'):
            colour = srgb_to_linear(pool.mean_colour(tex[5:])).tolist()
            tex = None
        elif spec.get('color') is not None:
            colour = srgb_to_linear(spec['color']).tolist()
        colour = [c * float(spec.get('scale', 1.0)) for c in colour]
        if tex:
            if tex.startswith('crop:'):
                # A small region of a large atlas, cut out with its alpha (the rear window's defrost lines)
                uvs = np.vstack([p[5] for p in parts if p[2] == kn5_name])
                tile, (u0, v0, u1, v1) = uv_region(uvs)
                im = decode(textures[tex[5:]])
                W, H = im.size
                box = (max(0, int(u0 * W) - 2), max(0, int(v0 * H) - 2), min(W, int(math.ceil(u1 * W)) + 2),
                       min(H, int(math.ceil(v1 * H)) + 2))
                crop = im.crop(box)
                uv_remap[kn5_name] = (tile, box, (W, H))
                ti = pool.image(f'{tex[5:]}#{kn5_name}', crop, alpha=True)
            else:
                # A merged tyre texture holds a band per texture: the paint's cap keeps each band at the others' size
                big = tex.startswith(('bake:body', 'bakemean:', 'merged:')) or skinnable(tex)
                ti = pool.colour(tex, alpha=(mode != 'OPAQUE'), cap=max_tex if big else None)
            pbr['baseColorTexture'] = {'index': ti}
        pbr['baseColorFactor'] = [round(float(v), 4) if auto else float(v) for v in colour] + [alpha]
        gm = {'name': spec.get('name', kn5_name), 'pbrMetallicRoughness': pbr}
        if spec.get('normal'):
            gm['normalTexture'] = {'index': pool.normal(spec['normal'])}
        if spec.get('emissive') and 'baseColorTexture' in pbr:
            gm['emissiveTexture'] = {'index': pbr['baseColorTexture']['index']}
            gm['emissiveFactor'] = [float(spec['emissive'])] * 3
        if mode != 'OPAQUE':
            gm['alphaMode'] = mode
        if spec.get('double'):
            gm['doubleSided'] = True
        if auto and (preset.get('generated') or preset.get('ac_finish')) and not spec.get('palette'):
            # The finish from the AC material's own values (`apply_ac_finish`)
            apply_ac_finish(gm, src, cls, spec, pool, writer)
        if spec.get('palette'):
            # One material per class and finish; its colour comes from the palette (UVs at the colour's cell)
            pkey = (cls, float(spec.get('metal', 0.0)), float(spec['rough']))
            linear = np.array(colour[:3])
            srgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(np.maximum(linear, 0), 1 / 2.4) - 0.055)
            cell = palette_cell(pkey, tuple(int(round(float(c) * 255)) for c in np.clip(srgb, 0, 1)))
            palette_uv[kn5_name] = cell
            if pkey in palettes:
                mi = palettes[pkey]
                writer.j['materials'][mi]['extras']['kn5'].append(kn5_name)
                mat_index[kn5_name] = mi
                return mi
            gm = {'name': f'{cls}_{len(shared):03d}', 'pbrMetallicRoughness': {
                'baseColorFactor': [1.0, 1.0, 1.0, 1.0], 'metallicFactor': pbr['metallicFactor'],
                'roughnessFactor': pbr['roughnessFactor']}, 'extras': {'kn5': [kn5_name], 'palette': True}}
            shared[('palette', pkey)] = len(writer.j['materials'])
            palettes[pkey] = len(writer.j['materials'])
            writer.j['materials'].append(gm)
            mat_index[kn5_name] = palettes[pkey]
            return palettes[pkey]
        if cls is not None:
            key = json.dumps([cls, {k: v for k, v in gm.items() if k != 'name'}], sort_keys=True)
            if key in shared:
                mi = shared[key]
                writer.j['materials'][mi]['extras']['kn5'].append(kn5_name)
                mat_index[kn5_name] = mi
                return mi
            gm['name'] = f'{cls}_{len(shared):03d}'
            gm['extras'] = {**gm.get('extras', {}), 'kn5': [kn5_name]}
            if tex and skinnable(tex):
                stem = re.sub(r'[^A-Za-z0-9]+', '_', tex.split(':', 1)[-1].rsplit('.', 1)[0]).strip('_').lower()
                skin_files[gm['name']] = (f'{stem}.png' if mode != 'OPAQUE' else f'{stem}.jpg', tex)
            shared[key] = len(writer.j['materials'])
        writer.j['materials'].append(gm)
        mat_index[kn5_name] = len(writer.j['materials']) - 1
        return mat_index[kn5_name]

    def uv_of(uv, kn5_name):
        if kn5_name in palette_uv:
            # Every vertex at its colour's cell centre (the palette is written once all colours are known)
            pkey, i = palette_uv[kn5_name]
            n = len(palette_cells[pkey])
            cols = min(n, PALETTE_COLS)
            rows = (n + PALETTE_COLS - 1) // PALETTE_COLS
            u, v = (i % PALETTE_COLS + 0.5) / cols, (i // PALETTE_COLS + 0.5) / rows
            return np.tile(np.array([[u, v]], np.float32), (len(uv), 1))
        if spec_of(kn5_name).get('detail'):
            # The detail map tiles detailUVMultiplier times across the material's UVs (the sampler repeats)
            src = by_name[kn5_name.split('@')[0]]
            uv = uv * np.float32(src['props'].get('detailUVMultiplier', 1.0) or 1.0)
        if kn5_name in uv_remap:
            tile, box, (W, H) = uv_remap[kn5_name]
            uv = uv - tile.astype(np.float32)
            uv = np.c_[(uv[:, 0] * W - box[0]) / (box[2] - box[0]), (uv[:, 1] * H - box[1]) / (box[3] - box[1])]
        return uv.astype(np.float32)

    def prims(group, to_local=None, origin=None, key=lambda p: p[2], order=None):
        """One primitive per glTF material over `group` (parts), moved into a local frame. A preset with its own
        material table keeps one per kn5 material, in `order` of their names (default alphabetical)"""
        out = []
        groups = {}
        if auto:
            for p in group:
                groups.setdefault(material_for(key(p)), []).append(p)
            items = [groups[mi] for mi in sorted(groups)]
        else:
            for p in group:
                groups.setdefault(key(p), []).append(p)
            items = [groups[k] for k in sorted(groups, key=order)]
        for ps in items:
            mi = material_for(key(ps[0]))
            pos, nrm, uv, tris = merge([(p[3], p[4], uv_of(p[5], key(p)), p[6]) for p in ps])
            if origin is not None:
                pos = pos - origin
            if to_local is not None:
                pos = pos @ to_local[:3, :3].T + to_local[:3, 3]
                nrm = nrm @ M_steer[:3, :3]
            out.append((mi, writer.add_primitive(pos, nrm, uv, tris, mi)))
        return out

    def node_label(mi):
        return writer.j['materials'][mi]['name']

    # Every material first, so each palette knows all its colours before any UVs point into it
    order0 = {m['name']: i for i, m in enumerate(materials)}
    if auto:
        for k in sorted(used, key=lambda k: order0[k]):
            material_for(k)

    # Wheels: hub pivots at the (mirrored) tyre centres; rim parts one primitive per material. A tyre in several kn5
    # materials (`tyre_materials`: tread and sidewall) is one primitive in the first's
    wheel_nodes = []
    hub_nodes = []
    for c in CORNERS:
        centre = np.array(wheel_centres[f'WHEEL_{c}'])
        corner_tyres = [p for p in tyres if p[1] == c]
        tyre_mats = {p[2] for p in corner_tyres}
        if preset.get('tyre_materials'):
            first = next(m for m in preset['tyre_materials'] if m in tyre_mats)
            corner_tyres = [[*p[:2], first, *p[3:]] for p in corner_tyres]
        else:
            assert len(tyre_mats) == 1, f'{c} tyre uses several materials: {tyre_mats}'
        (_, tyre_prim), = prims(corner_tyres, origin=centre)
        tyre_node = writer.add_mesh_node(f'WHEEL_{c}_TYRE', [tyre_prim])
        rim_prims = [pi for _, pi in prims([p for p in parts if p[0] == 'rim' and p[1] == c], origin=centre)]
        rim_node = writer.add_mesh_node(f'WHEEL_{c}_RIM', rim_prims)
        wheel_nodes.append(writer.add_node(f'WHEEL_{c}', children=[rim_node, tyre_node], translation=centre))
        # The corner's hub parts (under SUSP_xx): steered and sprung with the wheel, not spinning
        hub_prims = [pi for _, pi in prims([p for p in parts if p[0] == 'hub' and p[1] == c], origin=centre)]
        if hub_prims:
            hub_nodes.append(writer.add_mesh_node(f'HUB_{c}', hub_prims, translation=centre))

    # Steering wheel, in the STEER frame
    to_steer = np.linalg.inv(M_steer)
    steer_kids = []
    own_node = lambda p: p[7].startswith(preset['steer_nodes']) if preset['steer_nodes'] else False  # noqa: E731
    for mi, pi in prims([p for p in steer_parts if not own_node(p)], to_local=to_steer):
        steer_kids.append(writer.add_mesh_node(f'STEER_{node_label(mi)}', [pi]))
    own_steer = sorted({p[7] for p in steer_parts if own_node(p)})
    for name in own_steer:
        node_key = lambda p, name=name: f'{p[2]}@{name}' if f'{p[2]}@{name}' in MATERIALS else p[2]  # noqa: E731
        out = prims([p for p in steer_parts if p[7] == name], to_local=to_steer, key=node_key)
        steer_kids.append(writer.add_mesh_node(name, [pi for _, pi in out]))

    # Body: one mesh per material (a wheel's callipers and uprights are its HUB_xx)
    body_parts = [p for p in parts if p[0] == 'body']
    order = {m['name']: i for i, m in enumerate(materials)}
    body_parts.sort(key=lambda p: order[p[2]])
    led_nodes = set(preset.get('led_nodes', ()))
    is_mirror = lambda p: id(p) in mirror_section  # noqa: E731
    body_kids = [writer.add_mesh_node(f'BODY_{node_label(mi)}', [pi])
                 for mi, pi in prims([p for p in body_parts if p[8] is None and p[7] not in led_nodes and not is_mirror(p)],
                                     order=lambda k: order[k])]
    # Shift lights on the body (digital_instruments.ini's, on a dash rather than the wheel): nodes of their own
    body_leds = sorted({p[7] for p in body_parts if p[8] is None and p[7] in led_nodes and not is_mirror(p)})
    for name in body_leds:
        out = prims([p for p in body_parts if p[7] == name and not is_mirror(p)], order=lambda k: order[k])
        body_kids.append(writer.add_mesh_node(name, [pi for _, pi in out]))
    # The mirrors (mirrors.ini): MIRROR_n, the glass of every mesh its NAME gives in one material of its own, the
    # section in the node's extras, for the game's live mirrors to find
    mirrors = []
    for section in sorted(set(mirror_section.values()), key=lambda s: int(s.split('_')[1])):
        group = [p for p in body_parts if mirror_section.get(id(p)) == section]
        out = prims(group, key=lambda p, section=section: f'{p[2]}@{section}')
        node = writer.add_mesh_node(section, [pi for _, pi in out])
        entry = {'node': section, 'kn5': sorted({p[7] for p in group})}
        writer.j['nodes'][node]['extras'] = {'mirror': entry}
        body_kids.append(node)
        mirrors.append(entry)
    # A livery's parts (`parts`, `extra_kn5`): PART_<name>, one mesh per material, shown for its variants' liveries
    variant_nodes = {}
    for part in sorted({p[8] for p in body_parts if p[8] is not None}):
        out = prims([p for p in body_parts if p[8] == part], order=lambda k: order[k])
        kids = [writer.add_mesh_node(f'PART_{part}_{node_label(mi)}', [pi]) for mi, pi in out]
        body_kids.append(writer.add_node(f'PART_{part}', children=kids))
        variant_nodes[f'PART_{part}'] = list(part_variants.get(part, ('base',)))
    body_node = writer.add_node('BODY', children=body_kids)
    # The cameras read the body as the first livery wears it
    body_parts = [p for p in body_parts if p[8] is None or 'base' in part_variants.get(p[8], ('base',))]

    # The palettes: PALETTE_CELL px per colour, PALETTE_COLS to a row, sampled without filtering
    if palettes:
        writer.j['samplers'].append({'magFilter': 9728, 'minFilter': 9728, 'wrapS': 33071, 'wrapT': 33071})
        nearest = len(writer.j['samplers']) - 1
        for pkey, mi in palettes.items():
            cells = palette_cells[pkey]
            cols, rows = min(len(cells), PALETTE_COLS), (len(cells) + PALETTE_COLS - 1) // PALETTE_COLS
            im = Image.new('RGB', (cols * PALETTE_CELL, rows * PALETTE_CELL))
            for i, rgb in enumerate(cells):
                x, y = (i % PALETTE_COLS) * PALETTE_CELL, (i // PALETTE_COLS) * PALETTE_CELL
                im.paste(rgb, (x, y, x + PALETTE_CELL, y + PALETTE_CELL))
            buf = io.BytesIO()
            im.save(buf, format='PNG', optimize=True)
            writer.j['images'].append({'name': f'palette:{pkey[0]}:{pkey[1]}:{pkey[2]}', 'bufferView': writer.add_view(buf.getvalue()),
                                       'mimeType': 'image/png'})
            writer.j['textures'].append({'sampler': nearest, 'source': len(writer.j['images']) - 1})
            writer.j['materials'][mi]['pbrMetallicRoughness']['baseColorTexture'] = {'index': len(writer.j['textures']) - 1}
        print(f'  palettes: {len(palettes)} materials for {sum(len(c) for c in palette_cells.values())} colours, '
              f'{len(palette_uv)} kn5 materials')
    steer_out = writer.add_node('STEER', children=steer_kids, matrix=M_steer)
    # The driver driver3d.ini seats in the car, where the mod ships its model (scripts/cars/ac_driver.py)
    driver = None
    if preset.get('driver', True):
        import ac_driver
        driver = ac_driver.add_driver(sys.modules[__name__], writer, pool, car_dir, data, shift, M_steer, skin)

    # Cameras. The driver's eyes from car.ini (DRIVEREYES is in the kn5's frame: 27 cm over and 47 cm behind the
    # steering wheel); the others from the geometry (car.ini's bonnet / bumper positions land inside the dash and the
    # engine bay)
    ini_eyes = ini_driver_eyes(data)
    eyes = ini_eyes + shift if ini_eyes is not None else pivot + [0, 0.27, -0.47]
    solid = np.vstack([p[3] for p in body_parts if spec_of(p[2]).get('mode', 'OPAQUE') == 'OPAQUE'])
    windscreen = [p[3] for p in body_parts if p[2] in preset['windscreen']]
    glass = np.vstack(windscreen) if windscreen else np.zeros((0, 3))

    def top_y(x, z, below, half=0.06, fallback=None):
        m = (np.abs(solid[:, 0] - x) < half) & (np.abs(solid[:, 2] - z) < half) & (solid[:, 1] < below)
        # Nothing there (an open cockpit, an automatic preset's guess): the caller's fallback
        if not m.any() and fallback is not None:
            return fallback
        return float(solid[m, 1].max())

    # dash: over the instrument binnacle, 8 cm under the windscreen (a straight fit through its glass in front of the
    # driver) and clear of the dash top
    dash_z = float(pivot[2] + 0.30)
    near = glass[(np.abs(glass[:, 0] - eyes[0]) < 0.15) & (glass[:, 1] > eyes[1] - 0.4) & (glass[:, 2] > 0.2)]
    if len(near) >= 3:
        slope, icpt = np.polyfit(near[:, 2], near[:, 1], 1)
        glass_y = float(slope * dash_z + icpt)
        dash_y = max(glass_y - 0.08, top_y(eyes[0], dash_z, glass_y) + 0.05)
    else:
        # No windscreen in front of the driver (an open car, or none found): over the dash top, under the eyes
        dash_y = max(top_y(eyes[0], dash_z, float(eyes[1]), fallback=float(eyes[1]) - 0.2) + 0.05, float(eyes[1]) - 0.15)
    # bumper: centre line, just above the front bumper's top, at its nose
    front = solid[(np.abs(solid[:, 0]) < 0.15) & (solid[:, 1] > 0.3) & (solid[:, 1] < 0.9)]
    nose_z = float(front[:, 2].max()) if len(front) else float(solid[:, 2].max())
    bumper_y = top_y(0.0, nose_z - 0.08, 1.0, half=0.1, fallback=0.5) + 0.06
    # tcam: over the roof above the driver's head, as high over it as the GT3 ports' (cameras.ini's roof camera,
    # 12 cm over it at -15.5 deg, filled half the frame with roof)
    over = (np.abs(solid[:, 0]) < 0.2) & (np.abs(solid[:, 2] - eyes[2]) < 0.2)
    roof_y = float(solid[over, 1].max()) if over.any() else float(eyes[1]) + 0.1
    tcam_pos, tcam_pitch = [0.0, roof_y + 0.22, float(eyes[2] - 0.13)], -8.0
    r3 = lambda v: [round(float(x), 3) for x in v]  # noqa: E731
    cameras = {
        'cockpit': {'pos': r3(eyes), 'pitchDeg': -2.0, 'fov': 60},
        'tcam': {'pos': r3(tcam_pos), 'pitchDeg': round(tcam_pitch, 1), 'fov': 60},
        'dash': {'pos': r3([eyes[0], dash_y, dash_z]), 'pitchDeg': -4.0, 'fov': 60},
        'bumper': {'pos': r3([0.0, bumper_y, nose_z - 0.05]), 'pitchDeg': -2.0, 'fov': 60},
        'nearChase': {'pos': [0.0, 2.1, -5.3], 'pitchDeg': -10, 'fov': 60},
        'farChase': {'pos': [0.0, 2.6, -7.3], 'pitchDeg': -10, 'fov': 60},
    }

    rev_leds = read_rev_leds(data, set(own_steer) | set(body_leds))
    # digital_instruments.ini's texts, on the nodes they are drawn on: the wheel's (STEER) or the body's
    item_parents = set()
    if 'digital_instruments.ini' in data:
        dcp = ini(data['digital_instruments.ini'])
        item_parents = {dcp[s].get('PARENT', '').strip() for s in dcp.sections() if s.startswith('ITEM_')}
    to_model = np.eye(4)
    to_model[:3, 3] = shift
    item_frames = {}
    for i, n in enumerate(nodes):
        if n['name'] in item_parents and n['name'] not in item_frames:
            world = to_model @ n['world']
            item_frames[n['name']] = ('STEER', to_steer @ world) if 'STEER_HR' in ancestors(nodes, i) else ('BODY', world)
    digital_items = read_digital_items(data, nodes, item_frames)

    lf, rf, lr, rr = (wheel_centres[f'WHEEL_{c}'] for c in ('LF', 'RF', 'LR', 'RR'))
    extras = {
        'wheelCentres': wheel_centres,
        'tyreRadius': tyre_radius,
        'tyreHalfWidth': tyre_half_width,
        'wheelbaseM': round(lf[2] - lr[2], 5),
        'trackWidthM': {'front': round(lf[0] - rf[0], 5), 'rear': round(lr[0] - rr[0], 5)},
        'steer': {'pivot': r3(pivot), 'columnAxis': [round(float(v), 5) for v in column]},
        'cameras': cameras,
        **({'revLeds': rev_leds} if rev_leds else {}),
        **({'digitalItems': digital_items} if digital_items else {}),
        **({'mirrors': mirrors} if mirrors else {}),
        **({'skinMaps': {MATERIALS[m]['name']: f for m, (f, _) in preset['skin_maps'].items()}}
           if preset.get('skin_maps') else {}),
        **({'skinMaps': {name: f for name, (f, _) in sorted(skin_files.items())}} if skin_files else {}),
        # PART_<name> -> the variants whose liveries show it (CarSkin.variant, 'base' when a livery names none)
        **({'partVariants': variant_nodes} if variant_nodes else {}),
        'source': {
            'title': preset['title'],
            'kn5': os.path.basename(kn5_path),
            'skin': skin,
            'converted': 'scripts/cars/port_ac_car.py',
        },
    }
    if driver is not None:
        # Its helmet, suit and gloves are the livery's
        extras['skinMaps'] = {**extras.get('skinMaps', {}), **driver[1]}
    car_root = writer.add_node('CAR', children=[body_node, steer_out, *wheel_nodes, *hub_nodes,
                                                *([driver[0]] if driver is not None else [])], extras=extras)
    # Not 'CAR' (GlbWriter's default): three's GLTFLoader names the scene first, so the root node would load as
    # CAR_1 and the rig's getObjectByName('CAR') would find the scene, without the extras
    writer.j['scenes'][0] = {'name': 'Scene', 'nodes': [car_root]}
    writer.j['asset']['extras'] = extras['source']
    writer.save(out_path)

    nverts = sum(len(p[3]) for p in parts)
    ntris = sum(len(p[6]) for p in parts)
    print(f'wrote {out_path} ({os.path.getsize(out_path) / 1e6:.2f} MB)')
    print(f'  rev LEDs: {json.dumps(rev_leds)}')
    print(f'  mirrors: {json.dumps(mirrors)}')
    print(f'  {len(parts)} kn5 meshes -> {len(body_kids)} body meshes, {len(steer_kids)} steer, 4 wheels; '
          f'{nverts} vertices, {ntris} triangles; {len(writer.j["materials"])} materials')
    print(f'  dropped meshes by material: {dropped}')
    print(f'  shift {np.round(shift, 5).tolist()}')
    print('  wheelCentres:', wheel_centres)
    print('  tyreRadius:', tyre_radius, ' tyreHalfWidth:', tyre_half_width)
    print(f'  wheelbase {extras["wheelbaseM"]:.4f} m, track F {extras["trackWidthM"]["front"]:.4f} '
          f'R {extras["trackWidthM"]["rear"]:.4f}; steering wheel plane vs STEER_HR column {steer_tilt_err:.2f} deg')
    print('  cameras:', json.dumps(cameras))
    tex_bytes = sum(s[3] for s in pool.stats)
    print(f'  textures: {len(pool.stats)}, {tex_bytes / 1e6:.2f} MB')
    for key, size, mime, nbytes in pool.stats:
        print(f'    {key:44s} {size[0]:5d}x{size[1]:<5d} {mime:10s} {nbytes / 1e3:8.1f} kB')
    if skin_files:
        print('  livery files:', {n: f for n, (f, _) in skin_files.items()})
    return extras, skin_files


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('car_dir', nargs='?', help='the AC car folder (content/cars/<id>)')
    ap.add_argument('out', nargs='?', help='output .glb')
    ap.add_argument('--car', default=None, choices=sorted(PRESETS) + ['auto'],
                    help="car preset (default: by the folder name; a folder with none, or 'auto', gets an automatic one)")
    ap.add_argument('--skin', default=None, help="skin folder whose maps override the kn5 (default: the preset's)")
    ap.add_argument('--kn5', default=None,
                    help='kn5 file in the car folder (default <folder name>.kn5; an automatic preset finds the model)')
    ap.add_argument('--max-tex', type=int, default=2048, help='paint texture size cap (px)')
    ap.add_argument('--small-tex', type=int, default=1024, help='other colour textures size cap (px)')
    ap.add_argument('--normal-tex', type=int, default=512, help='normal map size cap (px)')
    ap.add_argument('--jpeg-quality', type=int, default=88)
    ap.add_argument('--skins-out', default=None,
                    help="also write every skin's livery files (the preset's skin_maps) into this folder")
    ap.add_argument('--skins-only', default=None,
                    help="with --skins-out: the skin folders to export, comma-separated")
    ap.add_argument('--no-driver', action='store_true',
                    help="leave out the driver driver3d.ini names, even where the mod ships its model")
    ap.add_argument('--report', default=None,
                    help='also write what was made as JSON: the preset (and what an automatic one found), the rig '
                         'measurements and the skins')
    ap.add_argument('--detect', default=None, metavar='MODEL.json|CAR',
                    help="run an automatic preset's detection on a model described in JSON (`synthetic_model`), or on a "
                         "car folder (beside its own preset's choices, when it has one), and print what it finds")
    a = ap.parse_args()
    if a.detect and os.path.isdir(a.detect):
        data = read_car_data(a.detect)
        kn5_name = a.kn5 or find_kn5(a.detect, data)
        preset = auto_preset(a.detect, read_kn5(os.path.join(a.detect, kn5_name)), data, kn5_name)
        own = PRESETS.get(a.car or PRESET_BY_FOLDER.get(os.path.basename(os.path.normpath(a.detect)), ''))
        out = {'kn5': kn5_name, 'detected': preset['detected']}
        if own:
            out['preset'] = {'paint': list(own.get('paint', ())), 'windscreen': list(own['windscreen']),
                             'tyreMaterials': list(own.get('tyre_materials') or ()), 'tyrePrefix': own.get('tyre_prefix'),
                             # A material table's paint: the kn5 materials it names as paint
                             'paintByTable': sorted(k for k, v in own['materials'].items() if 'paint' in v.get('name', ''))}
        print(json.dumps(out, indent=1))
        return
    if a.detect:
        spec = json.load(open(a.detect))
        materials, nodes = synthetic_model(spec)
        data = {'car.ini': f"[GRAPHICS]\nDRIVEREYES={','.join(str(v) for v in spec['eyes'])}\n"} if 'eyes' in spec else {}
        overrides = {k.lower(): v for k, v in spec.get('overrides', {}).items()}
        preset = auto_preset(None, ({}, materials, nodes), data, None, overrides=overrides, n_skins=spec.get('skins', 0))
        print(json.dumps(preset['detected'], indent=1))
        return
    if not (a.car_dir and a.out):
        ap.error('name the car folder and the output .glb')
    car = a.car or PRESET_BY_FOLDER.get(os.path.basename(os.path.normpath(a.car_dir)))
    loaded = None
    if car is None or car == 'auto':
        data = read_car_data(a.car_dir)
        kn5_name = a.kn5 or find_kn5(a.car_dir, data)
        loaded = read_kn5(os.path.join(a.car_dir, kn5_name))
        # The tyres as the mod's extension config draws them on the default compound, in one material
        ext = apply_extension_tyres(a.car_dir, data, *loaded)
        merged = merge_tyre_textures(*loaded)
        if ext['hidden'] or ext['textures'] or merged:
            print(f"  extension tyres ({ext['compound']}): {len(ext['hidden'])} meshes hidden, textures {ext['textures']}, "
                  f"merged {merged}")
        ui = read_loose_json(os.path.join(a.car_dir, 'ui', 'ui_car.json'))
        title = str(ui.get('name') or '').strip() or None
        preset = auto_preset(a.car_dir, loaded, data, kn5_name, title=title)
        # The material values the painted skin's ext_config.ini sets (its paint's gloss and reflection)
        replaced = apply_skin_shader_replacements(a.car_dir, a.skin or preset['default_skin'], loaded[1])
        if replaced:
            print(f'  skin material values: {replaced}')
        car = 'auto'
        print(f'automatic preset for {a.car_dir} ({kn5_name}):')
        print('  ' + json.dumps(preset['detected']))
    else:
        preset = PRESETS[car]
    if a.no_driver:
        preset = {**preset, 'driver': False}
    listing = None
    with np.errstate(all='ignore'):
        extras, skin_files = port(a.car_dir, a.out, preset, a.skin or preset['default_skin'], a.kn5, a.max_tex,
                                  a.small_tex, a.normal_tex, a.jpeg_quality, loaded=loaded)
        if a.skins_out:
            kn5 = os.path.join(a.car_dir, a.kn5 or preset.get('kn5') or
                               f'{os.path.basename(os.path.normpath(a.car_dir))}.kn5')
            textures, materials, _ = read_kn5(kn5)
            if preset.get('auto'):
                if not skin_files and preset.get('generated'):
                    # Nothing a skin repaints: the model's own paint is the one livery
                    listing = []
                    print('  no livery files: the skins repaint nothing the model shows')
                elif not skin_files and a.report:
                    listing = []
                elif not skin_files:
                    ap.error(f'{car} has no livery files to export')
                else:
                    only = set(a.skins_only.split(',')) if a.skins_only else None
                    listing = export_auto_skins(a.car_dir, preset, textures, materials, skin_files, a.skins_out,
                                                a.max_tex, a.jpeg_quality, a.skin or preset['default_skin'], only)
                    if preset.get('driver', True):
                        # Each livery's driver: its helmet, and its suit and gloves where they differ
                        import ac_driver
                        folders = sorted(d for d in os.listdir(os.path.join(a.car_dir, 'skins'))
                                         if os.path.isdir(os.path.join(a.car_dir, 'skins', d)))
                        ids = unique_skin_ids(preset, folders)
                        own = ac_driver.export_driver_skins(sys.modules[__name__], a.car_dir, a.skins_out, ids,
                                                            a.skin or preset['default_skin'], a.jpeg_quality, only)
                        folder_of = {sid: f for f, sid in ids.items()}
                        for entry in listing:
                            entry['files'] = entry['files'] + own.get(folder_of.get(entry['id']), [])
                        with open(os.path.join(a.skins_out, 'skins.json'), 'w') as fh:
                            json.dump(listing, fh, indent=1, ensure_ascii=False)
                        print(f"  driver livery files: {sum(len(v) for v in own.values())}")
            elif not preset['skin_maps'] and a.report:
                # The importer's run: the model's own paint is the one livery
                listing = []
            else:
                if not preset['skin_maps']:
                    ap.error(f'{car} has no skin_maps to export')
                listing = export_skins(a.car_dir, preset, textures, materials, a.skins_out, a.max_tex, a.small_tex,
                                       a.jpeg_quality, set(a.skins_only.split(',')) if a.skins_only else None)
    if a.report:
        def plain(v):
            return sorted(v) if isinstance(v, (set, frozenset)) else list(v) if isinstance(v, tuple) else v

        kept = ('title', 'kn5', 'paint', 'windscreen', 'spinning', 'default_skin', 'skin_textures', 'generated')
        report = {'car': car, 'preset': {k: plain(preset[k]) for k in kept if k in preset},
                  'detected': preset.get('detected'), 'skin': a.skin or preset['default_skin'], 'extras': extras,
                  'skins': listing}
        with open(a.report, 'w') as fh:
            json.dump(report, fh, indent=1, ensure_ascii=False)


if __name__ == '__main__':
    main()
