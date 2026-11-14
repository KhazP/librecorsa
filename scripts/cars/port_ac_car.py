"""Port an Assetto Corsa car (.kn5 + one skin) into LibreCorsa's ported-car GLB layout.

usage: python -P scripts/cars/port_ac_car.py <ac car folder> <out.glb> [--car liana] [--skin light_blue] [--kn5 x.kn5]

    uv run --python 3.14 --no-project --with numpy --with pillow python -P scripts/cars/port_ac_car.py \
      path/to/suzuki_liana public/cars/liana/model/liana.glb --skin light_blue
    uv run --python 3.14 --no-project --with numpy --with pillow python -P scripts/cars/port_ac_car.py \
      <unpacked MTRacing_496R.rar>/content/cars/mt_mtr_496r public/cars/mtr-496r/model/mtr-496r.glb

Each car has a preset (`PRESETS`): its material table, the nodes and materials it leaves out, the skin files that
override the kn5's, how its tyres and spinning parts are named, and its windscreen. `--car` picks one; by default the
car folder's name does. The reader, the hierarchy split, the multi-map paint bake and the camera reads are generic AC.
The car folder is read only. Its LODs (`<car>_B/C/D.kn5`), `collider.kn5`, damage, dirt and blur textures and the
blurred rims (`RIM_BLUR_*`) are left out.

Output node layout (read by src/lib/ported-car-model.ts):
    CAR (extras: wheelCentres, tyreRadius, tyreHalfWidth, wheelbaseM, trackWidthM, steer, cameras, source)
      BODY              body, cabin, glass, lights and brake callipers, one mesh per material
      STEER             steering wheel pivot (AC's STEER_HR: local +Z down the column into the dash); a preset's
                        `steer_nodes` (a screen, shift lights) are child nodes of their own, named as in the kn5
      WHEEL_RF          hub pivot at the tyre's centre
        WHEEL_RF_RIM    wheel, hubcap, brake disc / drum (one primitive per material); a car whose discs sit beside the
                        wheel (`DISC_RF`, the preset's `spinning`) has them here too
        WHEEL_RF_TYRE   tyre, one primitive (the tyre deformation shader)
      WHEEL_LF / WHEEL_RR / WHEEL_LR

Axes: AC's kn5 frame is already the rig's (+X left, +Y up, +Z forward, metres, right-handed, counter-clockwise
faces), so the only change is a shift: lowest tyre point to y = 0, X centred on the wheels.

Paint: the body's ksPerPixelMultiMap shader multiplies its diffuse by the skin's detail colour where the diffuse alpha
is 0 (`diffuse * (detail * (1 - a) + a)`, sampled in AC's gamma space); `bake_multimap` bakes that into one opaque
colour texture, so the paint carries the skin's colour and the badges (alpha 1) their own.
"""
import argparse
import configparser
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
    `parent` (index or None), `active` (own flag and every ancestor's), `world` (4x4) and `mesh`."""
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
        mesh = None
        if kind == 1:
            mat4 = parent_mat @ r.f32(16).reshape(4, 4).T
        elif kind in (2, 3):
            r.u8()  # cast shadows
            visible, transparent = bool(r.u8()), bool(r.u8())
            if kind == 3:  # skinned: bone names and bind matrices
                for _ in range(r.i32()):
                    r.str()
                    r.take(64)
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
        me = len(nodes)
        nodes.append({'name': name, 'kind': kind, 'active': active, 'world': mat4, 'mesh': mesh, 'parent': parent})
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
        return {f: open(os.path.join(data_dir, f), 'rb').read().decode('latin1') for f in os.listdir(data_dir)}
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
    cp = configparser.ConfigParser(inline_comment_prefixes=(';',), strict=False, interpolation=None)
    cp.optionxform = str
    cp.read_string(text)
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
}
# The car folders the presets were written for
PRESET_BY_FOLDER = {'suzuki_liana': 'liana', 'mt_mtr_496r': 'mtr-496r',
                    'nissan_skyline_bcnr33_jgtc': 'nissan-r33-jgtc', 'nissan_r32_jtcc': 'nissan-r32-jtcc'}


def srgb_to_linear(c):
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def decode(raw):
    im = Image.open(io.BytesIO(raw))
    im.load()
    return im.convert('RGBA')


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
        det = np.asarray(tiled.resize(size, Image.BICUBIC), np.float32)[..., :3] / 255.0
        if diffuse.size != size:
            d = np.asarray(diffuse.resize(size, Image.BICUBIC), np.float32) / 255.0
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
        diffuse = diffuse.resize((round(diffuse.width * k), round(diffuse.height * k)), Image.LANCZOS)
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
            im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
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
        return self._add(key, decode(self.src[name]).convert('RGB'), self.normal_tex, False, normal=True)

    def mean_colour(self, name):
        return np.asarray(decode(self.src[name]), np.float64)[..., :3].reshape(-1, 3).mean(0)


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
            uvm = props.get('detailUVMultiplier', 1.0) or 1.0
            tex = ('bake:' if abs(uvm - 1.0) < 1e-3 and not t['flat'] else 'bakemean:') + name
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
    if nrm and shader != 'ksWindscreen':
        n = stats(nrm)
        if n is not None and not n['flat']:
            spec['normal'] = nrm

    paint_of = next((p for p in preset.get('paint', ()) if p != name and diff and
                     (by_name.get(p) or {}).get('maps', {}).get('txDiffuse') == diff), None) if by_name else None
    if paint_of and not glass:
        # Another part drawn from the paint's own atlas (a banner, a weatherstrip): the paint's texture, so a livery
        # changes one file for both. The atlas's alpha is the multimap mask, not transparency
        paint_det = (by_name[paint_of]['maps'].get('txDetail') if 'MultiMap' in by_name[paint_of]['shader'] else None)
        spec.pop('detail', None)
        spec.update(tex=('bakemean:' + paint_of) if paint_det else diff, color=(255, 255, 255), mode='OPAQUE', alpha=1.0)
    if name in preset.get('paint', ()):
        cls = 'paint'
        # The livery bakes over its mean detail colour, at the paint's size cap
        spec['tex'] = 'bakemean:' + name if det else diff
        spec.pop('detail', None)
        spec.update(color=(255, 255, 255), scale=1.0, mode='OPAQUE', alpha=1.0)
    elif shader == 'ksTyres':
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
        rgb = vec3(sec.get('EMISSIVE', '1,0,0'))
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


def export_skins(car_dir, preset, textures, materials, out_dir, max_tex, small_tex, jpeg_quality):
    """Every skin's livery files (`preset['skin_maps']`) into <out_dir>/<skin>/, and skins.json listing them"""
    by_name = {m['name']: m for m in materials}
    skins_dir = os.path.join(car_dir, 'skins')
    listing = []
    for skin in sorted(os.listdir(skins_dir)):
        sdir = os.path.join(skins_dir, skin)
        if not os.path.isdir(sdir):
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
                    diffuse = diffuse.resize((round(diffuse.width * k), round(diffuse.height * k)), Image.LANCZOS)
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


def export_auto_skins(car_dir, preset, textures, materials, skin_files, out_dir, max_tex, jpeg_quality, default_skin):
    """Every skin's livery files (an `auto` preset's: each colour map made from a texture a livery replaces) into
    <out_dir>/<skin>/, and skins.json listing them (its name, number, two main colours from its paint, and `files`).
    A skin gets only the files whose textures differ from the default skin's, the one the GLB is painted in: the rest
    stay as the model has them (CarSkin.files). The default skin is listed first."""
    by_name = {m['name']: m for m in materials}
    names = {n.lower() for n in preset.get('skin_textures', ())}
    files = sorted({(f, key) for f, key in skin_files.values()})
    paint_file = next(f for f, key in files if key.split(':', 1)[-1] in preset['paint'] or
                      any(key == (by_name[p]['maps'].get('txDiffuse') or '') for p in preset['paint']))

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
    skins.sort(key=lambda d: d != default_skin)
    listing = []
    written = 0
    for skin in skins:
        src = {**textures, **skin_overrides(car_dir, skin, textures, names)}
        os.makedirs(os.path.join(out_dir, skin), exist_ok=True)
        own = []
        for fname, key in files:
            if all(src[n] == base[n] for n in sources(key)):
                continue
            im = image(key, src)
            out = os.path.join(out_dir, skin, fname)
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
        listing.append({'id': skin, 'name': str(ui.get('skinname', '')).strip(), 'number': str(ui.get('number', '')),
                        'swatch': paint_swatch(paint), 'files': own})
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
    """('skip'|'body'|'steer'|'tyre'|'rim', corner) of node `i`, whose mesh has kn5 material `mat`"""
    n = nodes[i]
    anc = ancestors(nodes, i)
    if (any(a.startswith('RIM_BLUR_') for a in anc) or n['name'].startswith(preset['skip_node_prefixes'])
            or n['name'] in preset['skip_nodes'] or any(a in preset['skip_nodes'] for a in anc)):
        return 'skip', None
    for a in anc:
        if a.startswith('WHEEL_') and a[6:] in CORNERS:
            if preset.get('tyre_materials'):
                return ('tyre' if mat in preset['tyre_materials'] else 'rim'), a[6:]
            return ('tyre' if n['name'].startswith(preset['tyre_prefix']) else 'rim'), a[6:]
        for prefix in preset['spinning']:
            if a.startswith(prefix) and a[len(prefix):] in CORNERS:
                return 'rim', a[len(prefix):]
        if a.startswith('STEER_HR'):
            return 'steer', None
    return 'body', None


def port(car_dir, out_path, preset, skin, kn5_name, max_tex, small_tex, normal_tex, jpeg_quality):
    MATERIALS = preset['materials']
    kn5_path = os.path.join(car_dir, kn5_name or f'{os.path.basename(os.path.normpath(car_dir))}.kn5')
    textures, materials, nodes = read_kn5(kn5_path)
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

    def spec_of(key):
        """The material spec of kn5 material `key` ('material@node' for a node's own entry)"""
        if key not in specs:
            base = key.split('@')[0]
            if key in MATERIALS:
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
        parts.append([kind, corner, mat, *world_mesh(n), n['name']])

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
    steer_node = next(n for n in nodes if n['name'] == 'STEER_HR' and n['kind'] == 1)
    pivot = steer_node['world'][:3, 3] + shift
    column = steer_node['world'][:3, 2] / np.linalg.norm(steer_node['world'][:3, 2])
    if column[2] < 0:
        column = -column
    M_steer = make_steer_frame(pivot, column)
    steer_parts = [p for p in parts if p[0] == 'steer']
    rim_pts = np.vstack([p[3] for p in steer_parts])
    normal_axis = np.linalg.svd(rim_pts - rim_pts.mean(0), full_matrices=False)[2][2]
    steer_tilt_err = math.degrees(math.acos(min(1.0, abs(float(normal_axis @ column)))))

    writer = GlbWriter(use_quantization=False)
    writer.j['asset']['generator'] = 'scripts/cars/port_ac_car.py'
    used = {p[2] for p in parts}
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
                big = tex.startswith(('bake:body', 'bakemean:')) or skinnable(tex)
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
            gm['extras'] = {'kn5': [kn5_name]}
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

    # Body: one mesh per material (front callipers included: the rig has no steer-only part of a wheel)
    body_parts = [p for p in parts if p[0] == 'body']
    order = {m['name']: i for i, m in enumerate(materials)}
    body_parts.sort(key=lambda p: order[p[2]])
    body_kids = [writer.add_mesh_node(f'BODY_{node_label(mi)}', [pi])
                 for mi, pi in prims(body_parts, order=lambda k: order[k])]
    body_node = writer.add_node('BODY', children=body_kids)

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

    # Cameras. The driver's eyes from car.ini (DRIVEREYES is in the kn5's frame: 27 cm over and 47 cm behind the
    # steering wheel); the others from the geometry (car.ini's bonnet / bumper positions land inside the dash and the
    # engine bay)
    car_ini = ini(data['car.ini']) if 'car.ini' in data else None
    eyes = np.array(vec3(car_ini['GRAPHICS']['DRIVEREYES'])) + shift if car_ini else pivot + [0, 0.27, -0.47]
    solid = np.vstack([p[3] for p in body_parts if spec_of(p[2]).get('mode', 'OPAQUE') == 'OPAQUE'])
    glass = np.vstack([p[3] for p in body_parts if p[2] in preset['windscreen']])

    def top_y(x, z, below, half=0.06):
        m = (np.abs(solid[:, 0] - x) < half) & (np.abs(solid[:, 2] - z) < half) & (solid[:, 1] < below)
        return float(solid[m, 1].max())

    # dash: over the instrument binnacle, 8 cm under the windscreen (a straight fit through its glass in front of the
    # driver) and clear of the dash top
    dash_z = float(pivot[2] + 0.30)
    near = glass[(np.abs(glass[:, 0] - eyes[0]) < 0.15) & (glass[:, 1] > eyes[1] - 0.4) & (glass[:, 2] > 0.2)]
    slope, icpt = np.polyfit(near[:, 2], near[:, 1], 1)
    glass_y = float(slope * dash_z + icpt)
    dash_y = max(glass_y - 0.08, top_y(eyes[0], dash_z, glass_y) + 0.05)
    # bumper: centre line, just above the front bumper's top, at its nose
    front = solid[(np.abs(solid[:, 0]) < 0.15) & (solid[:, 1] > 0.3) & (solid[:, 1] < 0.9)]
    nose_z = float(front[:, 2].max())
    bumper_y = top_y(0.0, nose_z - 0.08, 1.0, half=0.1) + 0.06
    # tcam: over the roof above the driver's head, as high over it as the GT3 ports' (cameras.ini's roof camera,
    # 12 cm over it at -15.5 deg, filled half the frame with roof)
    roof_y = float(solid[(np.abs(solid[:, 0]) < 0.2) & (np.abs(solid[:, 2] - eyes[2]) < 0.2), 1].max())
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

    rev_leds = read_rev_leds(data, set(own_steer))

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
        **({'skinMaps': {MATERIALS[m]['name']: f for m, (f, _) in preset['skin_maps'].items()}}
           if preset.get('skin_maps') else {}),
        **({'skinMaps': {name: f for name, (f, _) in sorted(skin_files.items())}} if skin_files else {}),
        'source': {
            'title': preset['title'],
            'kn5': os.path.basename(kn5_path),
            'skin': skin,
            'converted': 'scripts/cars/port_ac_car.py',
        },
    }
    car_root = writer.add_node('CAR', children=[body_node, steer_out, *wheel_nodes], extras=extras)
    # Not 'CAR' (GlbWriter's default): three's GLTFLoader names the scene first, so the root node would load as
    # CAR_1 and the rig's getObjectByName('CAR') would find the scene, without the extras
    writer.j['scenes'][0] = {'name': 'Scene', 'nodes': [car_root]}
    writer.j['asset']['extras'] = extras['source']
    writer.save(out_path)

    nverts = sum(len(p[3]) for p in parts)
    ntris = sum(len(p[6]) for p in parts)
    print(f'wrote {out_path} ({os.path.getsize(out_path) / 1e6:.2f} MB)')
    print(f'  rev LEDs: {json.dumps(rev_leds)}')
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
    ap.add_argument('car_dir', help='the AC car folder (content/cars/<id>)')
    ap.add_argument('out', help='output .glb')
    ap.add_argument('--car', default=None, choices=sorted(PRESETS), help='car preset (default: by the folder name)')
    ap.add_argument('--skin', default=None, help="skin folder whose maps override the kn5 (default: the preset's)")
    ap.add_argument('--kn5', default=None, help='kn5 file in the car folder (default <folder name>.kn5)')
    ap.add_argument('--max-tex', type=int, default=2048, help='paint texture size cap (px)')
    ap.add_argument('--small-tex', type=int, default=1024, help='other colour textures size cap (px)')
    ap.add_argument('--normal-tex', type=int, default=512, help='normal map size cap (px)')
    ap.add_argument('--jpeg-quality', type=int, default=88)
    ap.add_argument('--skins-out', default=None,
                    help="also write every skin's livery files (the preset's skin_maps) into this folder")
    a = ap.parse_args()
    car = a.car or PRESET_BY_FOLDER.get(os.path.basename(os.path.normpath(a.car_dir)))
    if car is None:
        ap.error(f'no preset for {a.car_dir}: pass --car')
    preset = PRESETS[car]
    with np.errstate(all='ignore'):
        _, skin_files = port(a.car_dir, a.out, preset, a.skin or preset['default_skin'], a.kn5, a.max_tex, a.small_tex,
                             a.normal_tex, a.jpeg_quality)
        if a.skins_out:
            kn5 = os.path.join(a.car_dir, a.kn5 or f'{os.path.basename(os.path.normpath(a.car_dir))}.kn5')
            textures, materials, _ = read_kn5(kn5)
            if preset.get('auto'):
                if not skin_files:
                    ap.error(f'{car} has no livery files to export')
                export_auto_skins(a.car_dir, preset, textures, materials, skin_files, a.skins_out, a.max_tex,
                                  a.jpeg_quality, a.skin or preset['default_skin'])
            else:
                if not preset['skin_maps']:
                    ap.error(f'{car} has no skin_maps to export')
                export_skins(a.car_dir, preset, textures, materials, a.skins_out, a.max_tex, a.small_tex,
                             a.jpeg_quality)


if __name__ == '__main__':
    main()
