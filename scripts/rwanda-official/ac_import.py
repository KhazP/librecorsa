"""
RISE Motordrome's Assetto Corsa release, read back for the game: the .kn5 models and extension/ext_config.ini of the
released track folder, turned into what the game's model takes from them (ac_merge.mjs puts the two together).

    $PY -I scripts/rwanda-official/ac_import.py <release>/tracks/rwanda_official

Writes data/ac/:
  layers.glb   the meshes, in the game's frame (the release's coordinates are the game's, to the millimetre):
               - the scenery the release added (lakeside, village, facades, domes, dressing, lights, safety Tecpro,
                 grandstand seats, the near horizon), named to the game's contract (Prop_*, Env_*, Ground_*, Track_*);
               - the main model's meshes the release changed (REPLACE);
               - the barrier colliders, which the release moved up to 0.75 m in where it added Tecpro.
               Every node says what it is for in its extras: `ac` = add, replace or collider, `target` = the game's node.
  look.json    the colour and texture changes ext_config.ini makes to materials the game already has, and the
               colour its multilayer ground shaders give each grass node (as a vertex-colour multiplier)
  tex/*.png    the textures both of them use

The road, kerbs, run-off, pit lane, gravel and verges the cars drive on are the game's already (checked here: the
release's physics meshes lie within 2 cm of the game's), and both laps' track data stay as they are.

Left out, and why:
  - the trees of the main model (Trees_*): CSP hides them and draws its own; the game has scenery/foliage.glb
  - rwanda_official_screens.kn5: the main model's screens already show the feed in the game; the release splits
    their faces only for CSP's live timing board
  - per-lap models (closures, groove, timing gates, the short lap's brake boards): both laps share one model here
  - horizon meshes beyond the game's far plane (5.5 km): the outer rings and the far apron
"""
import io
import json
import os
import re
import struct
import sys
from collections import OrderedDict, defaultdict

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tracks'))
import port_ac_track as act  # noqa: E402  (its KN5 reader)

OUT = os.path.join(HERE, 'data', 'ac')
FAR_M = 5300.0
MAX_TEX = 1024
# Strips (barrier and wall textures, 8:1 and wider) keep twice the length, as their detail runs along them
MAX_STRIP_TEX = 2048

LAYERS = OrderedDict([
    ('rwanda_official_lakeside.kn5', 'Lakeside'),
    ('rwanda_official_village.kn5', 'Village'),
    ('rwanda_official_facades.kn5', 'Facades'),
    ('rwanda_official_domes.kn5', 'Domes'),
    ('rwanda_official_dressing.kn5', 'Dressing'),
    ('rwanda_official_lights.kn5', 'Lights'),
    ('rwanda_official_safety.kn5', 'Safety'),
    ('rwanda_official_seats.kn5', 'Seats'),
    ('rwanda_official_horizon.kn5', 'Horizon'),
])

# The main model's meshes the release changed: the Turn 1 bridge, the marshal posts (rebuilt) and the painted lines
REPLACE = ('Prop_Bridge_T1', 'Prop_MarshalPosts', 'Track_Markings', 'Track_Markings_Alt')

WALLS = {
    'left': 'Track_Collider_Wall_Left', 'right': 'Track_Collider_Wall_Right', 'alt': 'Track_Collider_Wall_Alt',
    'join': 'Track_Collider_Wall_Join', 'pit': 'Track_Collider_Wall_Pit', 'pitouter': 'Track_Collider_Wall_PitOuter',
}

# ksMultilayer grass in the release: the AC material per surface object, and the game's node with that ground
GRASS_NODES = {
    'ac_Terrain_Grass__GRASS_verge': 'Ground_Verge',
    'ac_Terrain_Grass__GRASS_verge_alt': 'Ground_Verge_Alt',
    'ac_Terrain_Grass__GRASS_terrain': 'Terrain',
    'ac_Terrain_Grass__GRASS_lawns': 'Ground_Lawns',
    'ac_Terrain_Grass__ac_Terrain_Far': 'Terrain_Far',
}
# Other release materials whose game material has another name
MATERIAL_ALIASES = {'ac_Forest_Canopy__ac_Env_ForestCanopy': 'Forest_Canopy'}
# Release materials made per object (`<material>__<object>`) carry the game node's vertex colours baked into their
# texture, as Assetto Corsa draws none: a new texture for one replaces those colours too
BAKED_NODES = {'ac_Forest_Canopy__ac_Env_ForestCanopy': 'Env_ForestCanopy'}

# Flat pieces lying on the terrain (drawn as decals over it), and the plants and stone banks round the lake
GROUND = re.compile(r'Shore|Paving|Hoggin|Path|Paved|Wetland')
ENV = re.compile(r'Papyrus|Reed|Island|Palm|Planting|Revetment|Riprap')


def log(*a):
    print(*a, flush=True)


def game_material_name(name):
    if name in MATERIAL_ALIASES:
        return MATERIAL_ALIASES[name]
    return name[3:] if name.startswith('ac_') else name


def srgb_to_linear(c):
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def decode(raw):
    return Image.open(io.BytesIO(raw)).convert('RGBA')


def uniform_colour(img):
    """The texture's one colour (sRGB 0-255) when it is a flat swatch, else None"""
    a = np.asarray(img, np.float64).reshape(-1, 4)
    if img.size[0] * img.size[1] <= 256 and a[:, :3].std(0).max() < 1.0:
        return a[:, :3].mean(0)
    return None


def mean_rgba(img):
    return np.asarray(img, np.float64).reshape(-1, 4).mean(0)


def capped(img):
    w, h = img.size
    cap = MAX_STRIP_TEX if max(w, h) >= 8 * min(w, h) else MAX_TEX
    s = min(1.0, cap / max(w, h))
    return img if s >= 1.0 else img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


class Textures:
    def __init__(self):
        self.files = {}

    def save(self, key, img, keep_alpha):
        if key in self.files:
            return self.files[key]
        fn = re.sub(r'[^A-Za-z0-9_.-]', '_', os.path.splitext(key)[0]) + '.png'
        img = capped(img)
        if not keep_alpha:
            img = img.convert('RGB')
        img.save(os.path.join(OUT, 'tex', fn), optimize=True)
        self.files[key] = fn
        return fn


def world(node):
    m = node['mesh']
    p = m['pos'].astype(np.float64)
    pw = (np.c_[p, np.ones(len(p))] @ node['world'].T)[:, :3]
    r3 = node['world'][:3, :3]
    n = m['nrm'].astype(np.float64) @ np.linalg.inv(r3)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    return pw.astype(np.float32), n.astype(np.float32), m['uv'].astype(np.float32), m['idx'].astype(np.uint32)


def shown(node):
    m = node['mesh']
    return m is not None and m['visible'] and m['renderable'] and node['active']


def base_name(kn5_name):
    """ac_Prop_MarshalPosts_SUB1 -> Prop_MarshalPosts (the game's node)"""
    s = kn5_name[3:] if kn5_name.startswith('ac_') else kn5_name
    return re.sub(r'_SUB\d+$', '', s)


def layer_node_name(layer, kn5_name):
    """A layer mesh's name in the game, and whether it casts a shadow"""
    s = re.sub(r'^(rwLk|rwVl|rwFc|rwHz)_|^ac_|^Dress_', '', kn5_name)
    if layer == 'Safety' or layer == 'Seats':
        return s, True
    if layer == 'Horizon':
        return ('Ground_Horizon_' if GROUND.search(s) else 'Prop_Horizon_') + s, False
    if GROUND.search(s):
        return f'Ground_{layer}_{s}', False
    if ENV.search(s):
        # Palms cast; the papyrus and reed beds (thousands of low cards round the lake) do not
        return f'Env_{layer}_{s}', 'Palm' in s
    return f'Prop_{layer}_{s.replace(layer + "_", "", 1)}', True


class Glb:
    """A plain glTF 2.0 binary: float positions, normals and UVs, uint32 indices, PNG textures"""

    def __init__(self):
        self.j = {'asset': {'version': '2.0', 'generator': 'scripts/rwanda-official/ac_import.py'},
                  'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'materials': [],
                  'accessors': [], 'bufferViews': [], 'buffers': [], 'images': [], 'textures': [],
                  'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]}
        self.bin = bytearray()
        self.mats = {}
        self.imgs = {}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.bin += data
        self.j['bufferViews'].append(v)
        return len(self.j['bufferViews']) - 1

    def accessor(self, arr, ctype, kind, target, minmax=False):
        acc = {'bufferView': self.view(np.ascontiguousarray(arr).tobytes(), target), 'componentType': ctype,
               'count': len(arr), 'type': kind}
        if minmax:
            acc['min'] = arr.min(0).tolist()
            acc['max'] = arr.max(0).tolist()
        self.j['accessors'].append(acc)
        return len(self.j['accessors']) - 1

    def texture(self, png_path):
        if png_path not in self.imgs:
            data = open(png_path, 'rb').read()
            self.j['images'].append({'bufferView': self.view(data), 'mimeType': 'image/png',
                                     'name': os.path.splitext(os.path.basename(png_path))[0]})
            self.j['textures'].append({'source': len(self.j['images']) - 1, 'sampler': 0})
            self.imgs[png_path] = len(self.j['textures']) - 1
        return self.imgs[png_path]

    def material(self, name, spec):
        if name not in self.mats:
            self.j['materials'].append(spec)
            self.mats[name] = len(self.j['materials']) - 1
        return self.mats[name]

    def node(self, name, prims, extras):
        gp = []
        for pos, nrm, uv, idx, mat in prims:
            attrs = {'POSITION': self.accessor(pos, 5126, 'VEC3', 34962, minmax=True)}
            if nrm is not None:
                attrs['NORMAL'] = self.accessor(nrm, 5126, 'VEC3', 34962)
            if uv is not None:
                attrs['TEXCOORD_0'] = self.accessor(uv, 5126, 'VEC2', 34962)
            gp.append({'attributes': attrs, 'indices': self.accessor(idx, 5125, 'SCALAR', 34963), 'material': mat})
        self.j['meshes'].append({'name': name, 'primitives': gp})
        self.j['nodes'].append({'name': name, 'mesh': len(self.j['meshes']) - 1, 'extras': extras})
        self.j['scenes'][0]['nodes'].append(len(self.j['nodes']) - 1)

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j['buffers'] = [{'byteLength': len(self.bin)}]
        for k in ('images', 'textures'):
            if not self.j[k]:
                del self.j[k]
        js = json.dumps(self.j, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin))
        out += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(self.bin), 0x004E4942) + self.bin
        open(path, 'wb').write(out)


def kn5_material(glb, tex, m, textures):
    """A release material as glTF: its texture (or its flat colour), alpha test and a roughness from its specular"""
    name = game_material_name(m['name'])
    if name in glb.mats:
        return glb.mats[name]
    spec = float(m['props'].get('ksSpecular', 0.04))
    rough = 0.35 if spec >= 0.3 else 0.55 if spec >= 0.15 else 0.85
    metal = 0.6 if re.search(r'steel|metal', name, re.I) else 0.0
    pbr = {'baseColorFactor': [1.0, 1.0, 1.0, 1.0], 'metallicFactor': metal, 'roughnessFactor': rough}
    gm = {'name': name, 'pbrMetallicRoughness': pbr}
    at = m['shader'].endswith('AT') or m['alpha_tested']
    raw = tex.get(m['maps'].get('txDiffuse', ''))
    if raw is not None:
        img = decode(raw)
        flat = uniform_colour(img)
        if flat is not None and not at:
            pbr['baseColorFactor'] = srgb_to_linear(flat).round(4).tolist() + [1.0]
        else:
            fn = textures.save(m['maps']['txDiffuse'], img, keep_alpha=at)
            pbr['baseColorTexture'] = {'index': glb.texture(os.path.join(OUT, 'tex', fn))}
    if at:
        gm['alphaMode'] = 'MASK'
        gm['alphaCutoff'] = 0.5
        gm['doubleSided'] = True
    return glb.material(name, gm)


def check_frame(nodes):
    """The release's road must be the game's and face up (counter-clockwise from above, as glTF draws it)"""
    road = [n for n in nodes if n['mesh'] is not None and n['name'].endswith('ROAD_asphalt_road')]
    if not road:
        raise SystemExit('no ROAD_asphalt_road mesh in the main model')
    pos, _, _, idx = world(road[0])
    t = pos[idx.reshape(-1, 3)]
    up = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])[:, 1]
    up = up[np.abs(up) > 1e-6]  # the release leaves zero-area triangles where it split the road for its surfaces
    frac = float((up > 0).mean())
    if frac < 0.99:
        raise SystemExit(f'road faces point up for only {frac:.1%} of its triangles: the winding or frame differs')


def parse_ext_config(path):
    """CSP's ini: repeated section names allowed, PROP_... keys repeat; returns [(section, [(key, value)])]"""
    out = []
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.split(' ;', 1)[0].strip()
        if not line or line.startswith(';'):
            continue
        if line.startswith('['):
            out.append((line.strip('[]'), []))
        elif '=' in line and out:
            k, v = line.split('=', 1)
            out[-1][1].append((k.strip(), v.strip()))
    return out


def csp_materials(ext_dir):
    """Per AC material, in file order: the shader and resources of every active SHADER_REPLACEMENT naming it"""
    per = defaultdict(lambda: {'shader': None, 'res': {}, 'props': {}})
    for sec, kv in parse_ext_config(os.path.join(ext_dir, 'ext_config.ini')):
        if not sec.startswith('SHADER_REPLACEMENT'):
            continue
        d = dict(kv)
        if d.get('ACTIVE', '1').strip() == '0' or 'MATERIALS' not in d:
            continue
        res, slot = {}, {}
        for k, v in kv:
            m = re.match(r'RESOURCE_(\d+)$', k)
            if m:
                slot[m.group(1)] = v
            m = re.match(r'RESOURCE_FILE_(\d+)$', k)
            if m:
                res[m.group(1)] = v
        props = {}
        for k, v in kv:
            if k.startswith('PROP_'):
                pname, *vals = [x.strip() for x in v.split(',')]
                props[pname] = [float(x) for x in vals]
        for mat in [x.strip() for x in d['MATERIALS'].split(',')]:
            e = per[mat]
            if 'SHADER' in d:
                e['shader'] = d['SHADER']
            for i, s in slot.items():
                if i in res:
                    e['res'][s] = res[i]
            e['props'].update(props)
    return per


def multilayer_tint(e, ext_dir):
    """ksMultilayer's mean colour factor: magicMult x sum over the mask's channels of weight x its layer's mean"""
    need = ('txMask', 'txDetailR', 'txDetailG', 'txDetailB', 'txDetailA')
    if not all(k in e['res'] for k in need):
        return None
    load = lambda k: mean_rgba(Image.open(os.path.join(ext_dir, e['res'][k])).convert('RGBA'))
    mask = load('txMask') / 255.0
    mask = mask / max(mask.sum(), 1e-6)
    layers = [load(k)[:3] / 255.0 for k in need[1:]]
    magic = e['props'].get('magicMult', [1.0])[0]
    return magic * sum(w * c for w, c in zip(mask, layers))


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = os.path.abspath(sys.argv[1])
    ext = os.path.join(src, 'extension')
    os.makedirs(os.path.join(OUT, 'tex'), exist_ok=True)
    for f in os.listdir(os.path.join(OUT, 'tex')):
        os.remove(os.path.join(OUT, 'tex', f))
    glb, textures = Glb(), Textures()

    # The main model: the frame check, the replaced meshes and the colliders
    tex, mats, nodes = act.read_kn5_full(os.path.join(src, 'rwanda_official.kn5'))
    check_frame(nodes)
    kn5_mean = {}
    for m in mats:
        raw = tex.get(m['maps'].get('txDiffuse', ''))
        if raw is not None:
            kn5_mean[m['name']] = mean_rgba(decode(raw))[:3]
    groups = defaultdict(list)
    for n in nodes:
        if shown(n) and base_name(n['name']) in REPLACE:
            groups[base_name(n['name'])].append(n)
    for target in REPLACE:
        if not groups[target]:
            raise SystemExit(f'{target}: not in the main model')
        prims = [(*world(n), kn5_material(glb, tex, mats[n['mesh']['mat']], textures)) for n in groups[target]]
        glb.node(target, prims, {'ac': 'replace', 'target': target})
        log(f'replace {target}: {sum(len(p[3]) // 3 for p in prims)} triangles')
    hidden = glb.material('Collider_Hidden', {'name': 'Collider_Hidden'})
    for n in nodes:
        m = re.match(r'\d+WALL_collider_wall_(\w+)$', n['name'])
        if m and n['mesh'] is not None:
            pos, nrm, _, idx = world(n)
            glb.node(WALLS[m.group(1)], [(pos, nrm, None, idx, hidden)], {'ac': 'collider', 'target': WALLS[m.group(1)]})
            log(f'collider {WALLS[m.group(1)]}: {len(idx) // 3} triangles')

    # The layers
    for fn, layer in LAYERS.items():
        ltex, lmats, lnodes = act.read_kn5_full(os.path.join(src, fn))
        for m in lmats:
            raw = ltex.get(m['maps'].get('txDiffuse', ''))
            if raw is not None and m['name'] not in kn5_mean:
                kn5_mean[m['name']] = mean_rgba(decode(raw))[:3]
        per = OrderedDict()
        for n in lnodes:
            if not shown(n):
                continue
            pos, nrm, uv, idx = world(n)
            if np.hypot(pos[:, 0], pos[:, 2]).max() > FAR_M:
                log(f'  {layer}: {n["name"]} reaches past {FAR_M:.0f} m, left out')
                continue
            name, cast = layer_node_name(layer, n['name'])
            per.setdefault(name, (cast, []))[1].append((pos, nrm, uv, idx, kn5_material(glb, ltex, lmats[n['mesh']['mat']], textures)))
        tris = 0
        for name, (cast, prims) in per.items():
            glb.node(name, prims, {'ac': 'add', 'layer': layer, 'castShadow': cast})
            tris += sum(len(p[3]) // 3 for p in prims)
        log(f'add {layer}: {len(per)} nodes, {tris} triangles')

    # The look: ext_config.ini's replacements on materials the game has
    look = {'materials': {}, 'vertexColour': {}, 'dropVertexColour': []}
    for mat, e in csp_materials(ext).items():
        shader = e['shader'] or ''
        if shader.startswith('ksMultilayer'):
            tint = multilayer_tint(e, ext)
            if tint is None or np.abs(tint - 1).max() < 0.03:
                continue
            if mat in GRASS_NODES:
                look['vertexColour'][GRASS_NODES[mat]] = tint.round(4).tolist()
            else:
                look['materials'].setdefault(game_material_name(mat), {})['colourMultiply'] = tint.round(4).tolist()
            continue
        out = {}
        d = e['res'].get('txDiffuse')
        if d:
            img = Image.open(os.path.join(ext, d)).convert('RGBA')
            flat = uniform_colour(img)
            if flat is not None and mat in kn5_mean:
                # A flat swatch: the change of colour, so the game's own (linear) factor moves by the same ratio
                ratio = srgb_to_linear(flat) / np.maximum(srgb_to_linear(kn5_mean[mat]), 1e-4)
                out['colourMultiply'] = ratio.round(4).tolist()
            elif flat is None:
                out['baseColorTexture'] = textures.save(d, img, keep_alpha=False)
                if mat in BAKED_NODES:
                    look['dropVertexColour'].append(BAKED_NODES[mat])
        nm = e['res'].get('txNormal')
        if nm:
            out['normalTexture'] = textures.save(nm, Image.open(os.path.join(ext, nm)).convert('RGBA'), keep_alpha=False)
        mult = e['props'].get('diffuseMult')
        if shader.endswith('_UVMult') and mult:
            # CSP's UVMult: a negative multiplier scales u only
            s = abs(mult[0])
            out['uvScale'] = [s, 1.0] if mult[0] < 0 else [s, s]
        if out:
            look['materials'][game_material_name(mat)] = out
    for k, v in sorted(look['materials'].items()):
        log(f'look {k}: {v}')
    for k, v in sorted(look['vertexColour'].items()):
        log(f'look {k} (vertex colour): x{v}')
    for k in look['dropVertexColour']:
        log(f'look {k}: its vertex colours give way to the new texture')

    glb.write(os.path.join(OUT, 'layers.glb'))
    json.dump(look, open(os.path.join(OUT, 'look.json'), 'w'), indent=1)
    log(f'wrote {os.path.relpath(OUT)}/layers.glb ({os.path.getsize(os.path.join(OUT, "layers.glb")) / 1e6:.1f} MB), '
        f'look.json, {len(textures.files)} textures')


if __name__ == '__main__':
    main()
