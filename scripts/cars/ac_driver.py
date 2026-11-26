"""An Assetto Corsa car's driver for scripts/cars/port_ac_car.py: the figure driver3d.ini names, as AC seats it in the
car, written into the car's GLB beside its body.

AC builds the driver from four files: the model (content/driver/<NAME>.kn5, a suit and gloves skinned to a RIG_
skeleton, the helmet, face and neck brace rigid on its bones), the car's base pose (driver_base_pos.knh, a node
hierarchy whose transforms replace the model's by name), the steering animation (animations/steer.ksanim, which
replaces the transforms of the nodes it names, the whole upper body, by the steering wheel's angle) and the gear
shift animations. The low-detail model (<NAME>_B.kn5) is rigid parts on the same bones. Each team of a mod can sit
the same model in its own pose.

Output, a child of the GLB's CAR node (read by src/lib/render/ported-driver.ts):
    DRIVER              at driver3d.ini's POSITION in the car's frame; extras: what the game needs to drive it
      DRV_DRIVER        the skeleton (kn5 node names with `DRIVER:` as `DRV_`), at rest in the steering animation's
        ...             centre frame: the wheel straight. Rigid parts (helmet, face, neck brace) are meshes on their
                        nodes
      DRV_SUIT          skinned to the skeleton (the kn5's own inverse bind matrices)
      DRV_GLOVES
      DRV_LOD           the low-detail model at rest, one mesh per material, hidden until a far opponent shows it
    animations: `steer` (time 0 to 1 is full left lock to full right, 0.5 straight), `shift_up`, `shift_dw` (the
    fingers' turn from each animation's first frame, to add on top of the steering)

The steering animation spans the steering wheel's rotation from its centre frame to either end, LOCK degrees each
way: AC plays it at 0.5 + angle / (2 LOCK) (with LOCK=360 the hands turn 7.3 degrees a frame of 100, as the wheel
does). The hands don't turn at one rate, though, nor always at LOCK's: they slow towards a regrip, and five teams'
clips turn ~360 degrees each way under a LOCK of 400-480. So each frame is timed at the rim angle its hands show
(`fit_steer`: the grips' mean turn about the wheel's axis, the centre's rate through a regrip), and the hands stay on
the rim wherever they hold it (`clipLockDeg` the clip's span; the data's LOCK kept as `lockDeg`).
"""
import io
import math
import os
import re
import struct

import numpy as np
from PIL import Image

# The livery's textures each get a size cap of their own: an AI field loads every livery's files
CAPS = {'helmet': 1024, 'suit': 1024, 'gloves': 512, 'face': 512, 'hans': 512, 'visor': 256, 'part': 512}


def gltf_name(kn5_name):
    """A kn5 node name as a glTF node name three keeps as written: `DRIVER:RIG_Head` -> `DRV_RIG_Head`"""
    name = re.sub(r'^DRIVER:', 'DRV_', kn5_name)
    return re.sub(r'[^A-Za-z0-9_-]+', '_', name)


# ---------------------------------------------------------------------------------------------------------------------
# Transforms
# ---------------------------------------------------------------------------------------------------------------------


def quat_of(R):
    """Unit quaternion (x, y, z, w) of rotation matrix R"""
    m = R
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def mat_of(q, t, s=(1.0, 1.0, 1.0)):
    x, y, z, w = q
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m = np.eye(4)
    m[:3, :3] = r * np.asarray(s, np.float64)
    m[:3, 3] = t
    return m


def trs_of(m):
    """(quaternion, translation, scale) of a 4x4 rotation-scale-translation matrix"""
    s = np.linalg.norm(m[:3, :3], axis=0)
    return quat_of(m[:3, :3] / s), m[:3, 3].copy(), s


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])


def slerp(a, b, u):
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        q = a + u * (b - a)
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - u) * th) * a + math.sin(u * th) * b) / math.sin(th)


# ---------------------------------------------------------------------------------------------------------------------
# AC's files
# ---------------------------------------------------------------------------------------------------------------------


def read_knh(path):
    """{node name: local 4x4} of a .knh node hierarchy (name, matrix, child count, children; depth-first), the first of
    a name"""
    b = open(path, 'rb').read()
    out = {}
    o = 0

    def node():
        nonlocal o
        n = struct.unpack_from('<i', b, o)[0]
        o += 4
        name = b[o:o + n].decode('latin1')
        o += n
        m = np.frombuffer(b, '<f4', 16, o).astype(np.float64).reshape(4, 4).T
        o += 64
        kids = struct.unpack_from('<i', b, o)[0]
        o += 4
        out.setdefault(name, m)
        for _ in range(kids):
            node()

    node()
    return out


def read_clip(path):
    """{node name: (quaternions (F, 4) x y z w, translations (F, 3), scales (F, 3))} of a .ksanim, each node's
    quaternions kept in one hemisphere from frame to frame"""
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
            trs = [trs_of(m.T) for m in fr]
            q = np.array([x[0] for x in trs])
            t = np.array([x[1] for x in trs])
            s = np.array([x[2] for x in trs])
        else:
            fr = np.frombuffer(b, '<f4', count * 10, o).astype(np.float64).reshape(count, 10)
            o += count * 40
            q, t, s = fr[:, 0:4].copy(), fr[:, 4:7].copy(), fr[:, 7:10].copy()
            q /= np.linalg.norm(q, axis=1, keepdims=True)
        for k in range(1, len(q)):
            if np.dot(q[k], q[k - 1]) < 0:
                q[k] = -q[k]
        out[name] = (q, t, s)
    return out


def sample(track, u):
    """A clip track's local 4x4 at u in [0, 1] of its frames (linear, as three's mixer plays the exported clip)"""
    q, t, s = track
    f = u * (len(q) - 1)
    k = min(int(math.floor(f)), len(q) - 2) if len(q) > 1 else 0
    a = f - k if len(q) > 1 else 0.0
    if len(q) == 1:
        return mat_of(q[0], t[0], s[0])
    return mat_of(slerp(q[k], q[k + 1], a), t[k] + a * (t[k + 1] - t[k]), s[k] + a * (s[k + 1] - s[k]))


def driver_setup(pac, car_dir, data):
    """What driver3d.ini sets up, with the files it names, or None (no driver3d.ini, or its model isn't installed)"""
    if 'driver3d.ini' not in data:
        return None
    cp = pac.ini(data['driver3d.ini'])
    name = cp.get('MODEL', 'NAME', fallback='').strip()
    content = os.path.dirname(os.path.dirname(os.path.normpath(os.path.abspath(car_dir))))
    kn5 = os.path.join(content, 'driver', f'{name}.kn5')
    if not name or not os.path.isfile(kn5):
        print(f'  driver: {name or "no model"} not found under {os.path.join(content, "driver")}, left out')
        return None
    lod = os.path.join(content, 'driver', f'{name}_B.kn5')
    anim = os.path.join(car_dir, 'animations')
    steer = cp.get('STEER_ANIMATION', 'NAME', fallback='steer.ksanim').strip()
    hide = []
    for sec in cp.sections():
        if sec.startswith('HIDE_OBJECT_') and cp.get(sec, 'NAME', fallback='').strip():
            hide.append(cp.get(sec, 'NAME').strip())
    shift = None
    if cp.has_section('SHIFT_ANIMATION'):
        s = cp['SHIFT_ANIMATION']
        shift = {k: float(s.get(k, d)) for k, d in (('BLEND_TIME', 100), ('POSITIVE_TIME', 150), ('STATIC_TIME', 10),
                                                    ('NEGATIVE_TIME', 150), ('PRELOAD_RPM', 0),
                                                    ('INVERT_SHIFTING_HANDS', 0))}
    head = None
    if cp.has_section('HEAD_MOVEMENT'):
        h = cp['HEAD_MOVEMENT']
        head = {k: float(h.get(k, 0)) for k in ('FILTER', 'MAX_G', 'ROLL_MAX_DEG', 'PITCH_MAX_DEG', 'YAW_MAX_DEG')}
    return {
        'name': name,
        'kn5': kn5,
        'lod': lod if os.path.isfile(lod) else None,
        'knh': os.path.join(car_dir, 'driver_base_pos.knh'),
        'position': pac.vec3(cp.get('MODEL', 'POSITION', fallback='0,0,0')),
        'steer': os.path.join(anim, steer),
        'lock': float(cp.get('STEER_ANIMATION', 'LOCK', fallback='360')),
        'shift_up': os.path.join(anim, 'shift_up.ksanim'),
        'shift_dw': os.path.join(anim, 'shift_dw.ksanim'),
        'shift': shift,
        'hide': hide,
        'head': head,
    }


# ---------------------------------------------------------------------------------------------------------------------
# Pose
# ---------------------------------------------------------------------------------------------------------------------


def posed_locals(nodes, knh, clip, u):
    """Each node's local 4x4 as AC poses it: the model's, the base pose's where it names the node, then the steering
    animation's at u (None: no animation) where it names it"""
    out = []
    for n in nodes:
        loc = n['local']
        if n['kind'] == 1:
            if n['name'] in knh:
                loc = knh[n['name']]
            if clip is not None and n['name'] in clip:
                loc = sample(clip[n['name']], u)
        out.append(loc)
    return out


def worlds_of(nodes, locals_):
    out = []
    for n, loc in zip(nodes, locals_):
        out.append((out[n['parent']] if n['parent'] is not None else np.eye(4)) @ loc)
    return out


def fit_steer(nodes, knh, clip, to_steer):
    """How the steering animation's hands turn with the steering wheel: each hand's grip (the middle of its fingers'
    bases, where they close round the rim) over the central frames, where the hands hold the rim, in the wheel's
    plane. The angle it turns per frame about the wheel's axis is the rim's; a circle fitted to its path says how
    closely it keeps to one spot on the rim. `to_steer` maps the driver's frame into the wheel's (x left, y up, z down
    the column). Returns the rim degrees from the centre frame to either end, the direction (+1: later frames turn the
    wheel right, clockwise as the driver sees it), and each hand's path"""
    frames = len(next(iter(clip.values()))[0])
    by_name = {n['name']: i for i, n in reversed(list(enumerate(nodes))) if n['kind'] == 1}
    wrists = [k for k in by_name if re.search(r'HAND_?L$', k, re.I)][:1] + [k for k in by_name if re.search(r'HAND_?R$', k, re.I)][:1]
    if len(wrists) < 2 or frames < 8:
        return None
    grips = {}
    for w in wrists:
        fingers = [i for i, n in enumerate(nodes) if n['parent'] == by_name[w] and n['kind'] == 1
                   and 'thumb' not in n['name'].lower()]
        grips[w] = fingers or [by_name[w]]
    mid = (frames - 1) / 2
    half = max(3, frames // 8)
    window = [f for f in range(frames) if abs(f - mid) <= half]
    paths = {w: [] for w in wrists}
    for f in window:
        ws = worlds_of(nodes, posed_locals(nodes, knh, clip, f / (frames - 1)))
        for w in wrists:
            p = to_steer @ np.mean([ws[i][:, 3] for i in grips[w]], 0)
            paths[w].append(p[:3])
    hands = []
    for w in wrists:
        xyz = np.array(paths[w])
        xy = xyz[:, :2]
        # x^2 + y^2 + D x + E y + F = 0
        A = np.c_[xy, np.ones(len(xy))]
        D, E, F = np.linalg.lstsq(A, -(xy ** 2).sum(1), rcond=None)[0]
        c = np.array([-D / 2, -E / 2])
        r = math.sqrt(max(1e-9, c @ c - F))
        ang = np.unwrap(np.arctan2(xy[:, 1], xy[:, 0]))
        slope = math.degrees(np.polyfit(np.array(window, np.float64), ang, 1)[0])
        radii = np.linalg.norm(xy, axis=1)
        hands.append({'node': gltf_name(w), 'radius': [round(float(radii.min()), 4), round(float(radii.max()), 4)],
                      'depth': round(float(xyz[:, 2].mean()), 4), 'circleOffset': round(float(np.linalg.norm(c)), 4),
                      'circleRadius': round(r, 4), 'degPerFrame': round(slope, 3)})
    rates = [h['degPerFrame'] for h in hands]
    if rates[0] * rates[1] <= 0:
        return None
    # The wheel turns clockwise (to the right, as the driver sees it: x is left) as the angle about +z grows
    direction = 1 if rates[0] > 0 else -1
    nominal = abs(float(np.mean(rates)))

    # The rim's angle each frame shows: the grips' mean turn from the centre frame, frame by frame outward. Where the
    # hands let go to take a new grip (their turn stalls or runs back), the wheel turns on at the centre's rate
    turn = []
    for f in range(frames):
        ws = worlds_of(nodes, posed_locals(nodes, knh, clip, f / (frames - 1)))
        turn.append([math.atan2(*(to_steer @ np.mean([ws[i][:, 3] for i in grips[w]], 0))[1::-1]) for w in wrists])
    # In the exported clip's order, where the turn grows to the right
    turn = np.degrees(np.unwrap(np.array(turn), axis=0)).mean(1)
    if direction < 0:
        turn = turn[::-1]
    lo, hi = int(math.floor(mid)), int(math.ceil(mid))
    rim = np.zeros(frames)
    rim[lo] = turn[lo] - 0.5 * (turn[lo] + turn[hi]) if lo != hi else 0.0
    rim[hi] = turn[hi] - 0.5 * (turn[lo] + turn[hi]) if lo != hi else 0.0
    for f in range(hi + 1, frames):
        step = turn[f] - turn[f - 1]
        rim[f] = rim[f - 1] + (step if step >= 0.3 * nominal else nominal)
    for f in range(lo - 1, -1, -1):
        step = turn[f + 1] - turn[f]
        rim[f] = rim[f + 1] - (step if step >= 0.3 * nominal else nominal)
    span = float(max(-rim[0], rim[-1]))
    return {'clipLockDeg': round(span, 1), 'linearLockDeg': round(nominal * (frames - 1) / 2, 1), 'direction': direction,
            'rimDeg': rim, 'hands': hands, 'frames': frames}


# ---------------------------------------------------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------------------------------------------------


def role_of(nodes, i, material, by_name):
    """What a driver mesh is (suit, gloves, helmet, visor, face, hans, part), from its node's names and its material"""
    names = ' '.join([nodes[i]['name']] + [nodes[a]['name'] for a in ancestor_ids(nodes, i)]).lower()
    m = by_name[material]
    if 'helmet' in names:
        return 'visor' if m['blend'] == 1 or 'glass' in (m['maps'].get('txDiffuse') or '').lower() else 'helmet'
    for role in ('glove', 'suit', 'face', 'hans'):
        if role in names or role in material.lower():
            return 'gloves' if role == 'glove' else role
    return 'part'


def ancestor_ids(nodes, i):
    out = []
    p = nodes[i]['parent']
    while p is not None:
        out.append(p)
        p = nodes[p]['parent']
    return out


def driver_materials(pac, car_dir, setup):
    """The driver's kn5 read once with its materials planned: {nodes, textures (keys 'drv:<name>'), materials (kn5 name
    -> {gltf name, role, spec, kn5}), livery: [(file, colour key, cap, gltf name)]}. A material is a livery's when a
    skin folder has a file replacing one of the textures its colour is made of (helmet, suit, gloves)"""
    textures, materials, nodes = pac.read_kn5(setup['kn5'])
    tex = {f'drv:{k}': v for k, v in textures.items()}
    by_name = {m['name']: m for m in materials}
    # Each kn5 material's role, from the meshes drawn in it
    roles = {}
    for i, n in enumerate(nodes):
        if n['mesh'] is not None and n['active'] and n['mesh']['visible']:
            mat = materials[n['mesh']['mat']]['name']
            roles.setdefault(mat, role_of(nodes, i, mat, by_name))
    skins_dir = os.path.join(car_dir, 'skins')
    skin_names = set()
    if os.path.isdir(skins_dir):
        for d in os.listdir(skins_dir):
            if os.path.isdir(os.path.join(skins_dir, d)):
                skin_names |= {f.lower() for f in os.listdir(os.path.join(skins_dir, d))}
    stats = pac.TexStats(tex)
    out, count, livery = {}, {}, []
    for mat in sorted(roles, key=lambda k: [m['name'] for m in materials].index(k)):
        role = roles[mat]
        src = by_name[mat]
        m2 = dict(src, name=f'drv:{mat}', maps={k: f'drv:{v}' for k, v in src['maps'].items()})
        spec, _ = pac.auto_spec(m2, stats, {}, None)
        count[role] = count.get(role, 0) + 1
        base = {'helmet': 'driver_helmet_paint', 'visor': 'driver_visor'}.get(role, f'driver_{role}')
        name = base if count[role] == 1 else f'{base}{count[role]}'
        sources = [src['maps'].get(s) for s in ('txDiffuse', 'txDetail')] if (spec.get('tex') or '').startswith(
            ('bake:', 'bakemean:')) else [src['maps'].get('txDiffuse')]
        entry = {'name': name, 'role': role, 'spec': spec, 'kn5': src}
        if spec.get('tex') and any((s or '').lower() in skin_names for s in sources):
            fname = re.sub(r'_paint', '', name) + ('.png' if spec.get('mode', 'OPAQUE') != 'OPAQUE' else '.jpg')
            entry['livery'] = fname
            livery.append((fname, spec['tex'], CAPS.get(role, CAPS['part']), name))
        out[mat] = entry
    return {'textures': textures, 'tex': tex, 'materials': materials, 'nodes': nodes, 'plan': out, 'livery': livery,
            'skin_names': skin_names}


def skin_textures(car_dir, skin, textures):
    """{'drv:<kn5 texture>': bytes} of a skin folder's files replacing the driver kn5's textures (by name, any case)"""
    sdir = os.path.join(car_dir, 'skins', skin or '')
    if not skin or not os.path.isdir(sdir):
        return {}
    lower = {t.lower(): t for t in textures}
    return {f'drv:{lower[f.lower()]}': open(os.path.join(sdir, f), 'rb').read() for f in sorted(os.listdir(sdir))
            if f.lower() in lower}


# ---------------------------------------------------------------------------------------------------------------------
# GLB
# ---------------------------------------------------------------------------------------------------------------------


def add_driver(pac, writer, pool, car_dir, data, shift, steer_frame, skin):
    """Write the car's driver into `writer` (its textures through `pool`, the body's): returns (DRIVER node index,
    {gltf material: livery file}) or None. `shift` moves the car's kn5 frame to the model's; `steer_frame` is the STEER
    node's 4x4 in the model's frame"""
    setup = driver_setup(pac, car_dir, data)
    if setup is None:
        return None
    drv = driver_materials(pac, car_dir, setup)
    nodes, plan = drv['nodes'], drv['plan']
    # The textures and materials the pool reads, under names of their own (a driver's `glass.dds` is not the car's)
    pool.src.update(drv['tex'])
    pool.src.update(skin_textures(car_dir, skin, drv['textures']))
    for mat, e in plan.items():
        src = e['kn5']
        pool.mats[f'drv:{mat}'] = dict(src, name=f'drv:{mat}', maps={k: f'drv:{v}' for k, v in src['maps'].items()})

    knh = read_knh(setup['knh']) if os.path.isfile(setup['knh']) else {}
    clip = read_clip(setup['steer']) if os.path.isfile(setup['steer']) else None
    place = np.eye(4)
    place[:3, 3] = np.asarray(shift, np.float64) + np.asarray(setup['position'], np.float64)
    fit = fit_steer(nodes, knh, clip, np.linalg.inv(steer_frame) @ place) if clip else None
    if clip is not None and fit is None:
        raise SystemExit(f"driver: the steering animation's hands don't turn about the wheel ({setup['steer']})")
    # Later frames turn the wheel left: the exported clip runs the other way, so its time grows to the right
    reverse = bool(fit and fit['direction'] < 0)
    rest = posed_locals(nodes, knh, clip, 0.5)

    # Materials
    mat_index = {}

    def material(mat):
        if mat in mat_index:
            return mat_index[mat]
        e = plan[mat]
        spec = e['spec']
        mode = spec.get('mode', 'OPAQUE')
        pbr = {'metallicFactor': float(spec.get('metal', 0.0)), 'roughnessFactor': float(spec.get('rough', 0.5))}
        colour = pac.srgb_to_linear(spec.get('color', (255, 255, 255))).tolist()
        colour = [round(c * float(spec.get('scale', 1.0)), 4) for c in colour]
        tex = f"drv:{e['kn5']['maps']['txDetail']}" if spec.get('detail') else spec.get('tex')
        if tex:
            pbr['baseColorTexture'] = {'index': pool.colour(tex, alpha=(mode != 'OPAQUE'), cap=CAPS.get(e['role'], 512))}
        pbr['baseColorFactor'] = colour + [float(spec.get('alpha', 1.0))]
        gm = {'name': e['name'], 'pbrMetallicRoughness': pbr, 'extras': {'kn5': [mat]}}
        if spec.get('normal'):
            gm['normalTexture'] = {'index': pool.normal(spec['normal'])}
        if mode != 'OPAQUE':
            gm['alphaMode'] = mode
        writer.j['materials'].append(gm)
        mat_index[mat] = len(writer.j['materials']) - 1
        return mat_index[mat]

    def uv_of(mesh, mat):
        uv = mesh['uv'].astype(np.float32)
        if plan[mat]['spec'].get('detail'):
            uv = uv * np.float32(plan[mat]['kn5']['props'].get('detailUVMultiplier', 1.0) or 1.0)
        return uv

    mats = drv['materials']
    children = {i: [] for i in range(len(nodes))}
    for i, n in enumerate(nodes):
        if n['parent'] is not None:
            children[n['parent']].append(i)
    root = next((i for i, n in enumerate(nodes) if n['kind'] == 1 and n['name'] == 'DRIVER:DRIVER'), None)
    if root is None:
        raise SystemExit(f"driver: {setup['kn5']} has no DRIVER:DRIVER node")

    gl_index = {}
    tris = {'hr': 0, 'lod': 0}

    def build(i):
        """The glTF node of transform node i (its meshes as its own glTF mesh, its transform children as nodes)"""
        kids = [build(c) for c in children[i] if nodes[c]['kind'] == 1]
        prims = []
        for c in children[i]:
            me = nodes[c]['mesh']
            if nodes[c]['kind'] != 2 or me is None or not (nodes[c]['active'] and me['visible']):
                continue
            mat = mats[me['mat']]['name']
            prims.append(writer.add_primitive(me['pos'], me['nrm'], uv_of(me, mat), me['idx'].reshape(-1, 3), material(mat)))
            tris['hr'] += len(me['idx']) // 3
        q, t, s = trs_of(rest[i])
        node = {'name': gltf_name(nodes[i]['name']), 'rotation': [float(v) for v in q],
                'translation': [float(v) for v in t]}
        if np.abs(s - 1).max() > 1e-4:
            node['scale'] = [float(v) for v in s]
        if kids:
            node['children'] = kids
        if prims:
            writer.j['meshes'].append({'name': node['name'], 'primitives': prims})
            node['mesh'] = len(writer.j['meshes']) - 1
        writer.j['nodes'].append(node)
        gl_index[nodes[i]['name']] = len(writer.j['nodes']) - 1
        return gl_index[nodes[i]['name']]

    skeleton = build(root)
    driver_kids = [skeleton]

    # Skinned meshes: the kn5's vertices and its inverse bind matrices (the skeleton's world at bind is the model's own
    # pose; glTF and three place a skinned mesh by its joints alone)
    skins = {}
    for i, n in enumerate(nodes):
        me = n['mesh']
        if n['kind'] != 3 or me is None or not (n['active'] and me['visible']):
            continue
        bones = me['bones']
        key = tuple(b for b, _ in bones)
        if key not in skins:
            ibm = np.array([bm.T.reshape(-1) for _, bm in bones], np.float32)  # glTF: column-major
            acc = writer.add_accessor(ibm, 'MAT4', 5126)
            missing = [b for b in key if b not in gl_index]
            if missing:
                raise SystemExit(f'driver: skinned to nodes outside the skeleton: {missing}')
            writer.j.setdefault('skins', []).append({'name': gltf_name(n['name']), 'inverseBindMatrices': acc,
                                                     'joints': [gl_index[b] for b in key], 'skeleton': skeleton})
            skins[key] = len(writer.j['skins']) - 1
        mat = mats[me['mat']]['name']
        joints = np.clip(np.round(me['joints']), 0, len(bones) - 1).astype(np.uint8)
        weights = np.clip(me['weights'], 0, None).astype(np.float32)
        weights[np.arange(len(weights)), np.argmax(weights, 1)] += np.float32(weights.sum(1) <= 0)
        weights /= weights.sum(1, keepdims=True)
        joints[weights <= 0] = 0
        prim = writer.add_primitive(me['pos'], me['nrm'], uv_of(me, mat), me['idx'].reshape(-1, 3), material(mat))
        prim['attributes']['JOINTS_0'] = writer.add_accessor(np.ascontiguousarray(joints), 'VEC4', 5121, target=34962)
        prim['attributes']['WEIGHTS_0'] = writer.add_accessor(np.ascontiguousarray(weights), 'VEC4', 5126, target=34962)
        tris['hr'] += len(me['idx']) // 3
        name = 'DRV_' + re.sub(r'[^A-Za-z0-9]+', '_', n['name'].split(':')[-1]).upper()
        writer.j['meshes'].append({'name': name, 'primitives': [prim]})
        writer.j['nodes'].append({'name': name, 'mesh': len(writer.j['meshes']) - 1, 'skin': skins[key]})
        driver_kids.append(len(writer.j['nodes']) - 1)

    # The low-detail model at rest, one mesh per material, in the driver's frame
    lod_info = None
    if setup['lod']:
        _, lmats, lnodes = pac.read_kn5(setup['lod'])
        lws = worlds_of(lnodes, posed_locals(lnodes, knh, clip, 0.5))
        groups = {}
        for i, n in enumerate(lnodes):
            me = n['mesh']
            if me is None or not (n['active'] and me['visible']):
                continue
            mat = lmats[me['mat']]['name']
            if mat not in plan:
                print(f'  driver LOD: material {mat} is not the model\'s, left out')
                continue
            R = lws[i][:3, :3]
            pos = me['pos'].astype(np.float64) @ R.T + lws[i][:3, 3]
            nrm = me['nrm'].astype(np.float64) @ np.linalg.inv(R)
            t = me['idx'].reshape(-1, 3).astype(np.uint32)
            if np.linalg.det(R) < 0:
                t = t[:, ::-1]
            groups.setdefault(mat, []).append((pos, nrm, uv_of(me, mat), t))
            tris['lod'] += len(me['idx']) // 3
        prims = []
        for mat in sorted(groups, key=lambda k: list(plan).index(k)):
            pos, nrm, uv, t = pac.merge(groups[mat])
            prims.append(writer.add_primitive(pos, nrm, uv, t, material(mat)))
        if prims:
            writer.j['meshes'].append({'name': 'DRV_LOD', 'primitives': prims})
            writer.j['nodes'].append({'name': 'DRV_LOD', 'mesh': len(writer.j['meshes']) - 1})
            driver_kids.append(len(writer.j['nodes']) - 1)
            lod_info = {'node': 'DRV_LOD', 'model': os.path.basename(setup['lod'])[:-4], 'draws': len(prims)}

    # Animations: the steering, and the shifts as the fingers' turn on top of it
    animations = []
    gl_nodes = writer.j['nodes']

    def clip_channels(tracks, times, deltas=False):
        samplers, channels = [], []
        tacc = None
        for name in sorted(tracks):
            if name not in gl_index:
                continue
            q, t, s = tracks[name]
            node = gl_index[name]
            if deltas:
                d = np.array([qmul(q[0] * [-1, -1, -1, 1], qq) for qq in q])
                if max(math.degrees(2 * math.acos(min(1.0, abs(float(x[3]))))) for x in d) < 0.5:
                    continue
                outs = [('rotation', d.astype(np.float32))]
            else:
                outs = []
                if np.abs(q - q[0]).max() > 1e-6:
                    outs.append(('rotation', q.astype(np.float32)))
                if np.abs(t - t[0]).max() > 1e-6:
                    outs.append(('translation', t.astype(np.float32)))
            for path, arr in outs:
                if tacc is None:
                    tacc = writer.add_accessor(times.reshape(-1, 1), 'SCALAR', 5126, with_bounds=True)
                acc = writer.add_accessor(np.ascontiguousarray(arr), 'VEC4' if path == 'rotation' else 'VEC3', 5126)
                samplers.append({'input': tacc, 'output': acc, 'interpolation': 'LINEAR'})
                channels.append({'sampler': len(samplers) - 1, 'target': {'node': node, 'path': path}})
        return samplers, channels

    steer_info = None
    if clip is not None:
        frames = len(next(iter(clip.values()))[0])
        tracks = {k: tuple(a[::-1] for a in v) for k, v in clip.items()} if reverse else clip
        # Each frame at the rim angle its hands show (time 0.5 + 0.5 angle / clipLockDeg)
        times = (0.5 + 0.5 * fit['rimDeg'] / fit['clipLockDeg']).astype(np.float32)
        samplers, channels = clip_channels(tracks, times)
        animations.append({'name': 'steer', 'samplers': samplers, 'channels': channels})
        steer_info = {'clip': 'steer', 'lockDeg': setup['lock'], 'clipLockDeg': fit['clipLockDeg'],
                      'linearLockDeg': fit['linearLockDeg'], 'frames': frames, 'reversed': reverse, 'hands': fit['hands']}
    shift_info = None
    if setup['shift'] and all(os.path.isfile(setup[k]) for k in ('shift_up', 'shift_dw')):
        shift_info = {'blendMs': setup['shift']['BLEND_TIME'], 'positiveMs': setup['shift']['POSITIVE_TIME'],
                      'staticMs': setup['shift']['STATIC_TIME'], 'negativeMs': setup['shift']['NEGATIVE_TIME'],
                      'invertHands': bool(setup['shift']['INVERT_SHIFTING_HANDS'])}
        for key in ('shift_up', 'shift_dw'):
            tracks = read_clip(setup[key])
            frames = len(next(iter(tracks.values()))[0])
            samplers, channels = clip_channels(tracks, np.arange(frames, dtype=np.float32) / np.float32(frames - 1),
                                               deltas=True)
            if channels:
                animations.append({'name': key, 'samplers': samplers, 'channels': channels})
                shift_info[key] = sorted({gl_nodes[c['target']['node']]['name'] for c in channels})
    if animations:
        writer.j.setdefault('animations', []).extend(animations)

    hide = [gltf_name(h) for h in setup['hide'] if gltf_name(h) in {gl_nodes[k]['name'] for k in gl_index.values()}]
    head_node = next((gltf_name(k) for k in gl_index if re.search(r'RIG_Head$', k)), None)
    extras = {
        'model': setup['name'],
        'steer': steer_info,
        'shift': shift_info,
        'hide': hide,
        'hideMissing': [h for h in setup['hide'] if gltf_name(h) not in hide],
        'head': {'node': head_node, 'filter': setup['head']['FILTER'], 'maxG': setup['head']['MAX_G'],
                 'rollDeg': setup['head']['ROLL_MAX_DEG'], 'pitchDeg': setup['head']['PITCH_MAX_DEG'],
                 'yawDeg': setup['head']['YAW_MAX_DEG']} if setup['head'] and head_node else None,
        'lod': lod_info,
        'tris': tris,
    }
    writer.j['nodes'].append({'name': 'DRIVER', 'translation': [float(v) for v in place[:3, 3]],
                              'children': driver_kids, 'extras': extras})
    driver_node = len(writer.j['nodes']) - 1
    skin_maps = {e['name']: e['livery'] for e in plan.values() if e.get('livery')}
    print(f"  driver {setup['name']}: {tris['hr']} triangles, {len(skins)} skin(s) on {len(gl_index)} nodes; "
          f"low detail {tris['lod']} triangles in {lod_info['draws'] if lod_info else 0} meshes; hidden in the cockpit "
          f"{hide} (not in the model: {extras['hideMissing']})")
    if fit:
        print(f"  driver steering: LOCK {setup['lock']:.0f}, the hands turn {fit['linearLockDeg']:.0f} deg to either end at "
              f"the centre's rate, the clip spans {fit['clipLockDeg']:.0f} as they turn "
              f"({'reversed' if reverse else 'as authored'}); " +
              '; '.join(f"{h['node']} grip {h['radius'][0]:.3f}-{h['radius'][1]:.3f} m from the axis, its circle "
                        f"{h['circleOffset'] * 1000:.0f} mm off it" for h in fit['hands']))
    return driver_node, skin_maps


def export_driver_skins(pac, car_dir, out_dir, ids, default_skin, jpeg_quality, only=None):
    """Each skin's driver livery files (its helmet, suit and gloves where they differ from the default skin's, which the
    GLB wears) into <out_dir>/<skin id>/: {skin folder: [files]}"""
    data = pac.read_car_data(car_dir)
    setup = driver_setup(pac, car_dir, data)
    if setup is None:
        return {}
    drv = driver_materials(pac, car_dir, setup)
    if not drv['livery']:
        return {}
    mats = {f'drv:{k}': dict(e['kn5'], name=f'drv:{k}', maps={s: f'drv:{v}' for s, v in e['kn5']['maps'].items()})
            for k, e in drv['plan'].items()}

    def sources(key):
        if key.startswith(('bake:', 'bakemean:')):
            maps = mats[key.split(':', 1)[1]]['maps']
            return [maps[s] for s in ('txDiffuse', 'txDetail') if maps.get(s)]
        return [key]

    def image(key, src, cap):
        # As TexturePool.colour / _add make the GLB's own
        if key.startswith(('bake:', 'bakemean:')):
            im = pac.baked_image(key, src, mats, cap)
        else:
            im = pac.decode(src[key]).convert('RGB')
        if max(im.size) > cap:
            k = cap / max(im.size)
            im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
        return im

    base = {**drv['tex'], **skin_textures(car_dir, default_skin, drv['textures'])}
    out = {}
    for skin, sid in ids.items():
        if only is not None and skin not in only and sid not in only and skin != default_skin:
            continue
        src = {**drv['tex'], **skin_textures(car_dir, skin, drv['textures'])}
        files = []
        for fname, key, cap, _ in drv['livery']:
            if all(src.get(n) == base.get(n) for n in sources(key)):
                continue
            os.makedirs(os.path.join(out_dir, sid), exist_ok=True)
            im = image(key, src, cap)
            path = os.path.join(out_dir, sid, fname)
            if fname.endswith('.png'):
                im.convert('RGBA').save(path, format='PNG', optimize=True)
            else:
                im.convert('RGB').save(path, format='JPEG', quality=jpeg_quality, optimize=True)
            files.append(fname)
        out[skin] = files
    return out
