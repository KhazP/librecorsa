"""Port Sketchfab GT3 GLBs (BMW M4 GT3 Evo & Mercedes-AMG GT3 Evo) into LibreCorsa's generic car rig layout.

usage: python -P scripts/cars/port_sketchfab_gt3.py <source.glb> <out.glb>

Supported sources (CC BY-NC-SA 4.0):
  - "2025 BMW M4 GT3 EVO G82" by Ddiaz Design (@ddiaz-design)
    https://sketchfab.com/3d-models/2025-bmw-m4-gt3-evo-g82-113f83dd87064697a5ec2511d280b9d5
  - "Mercedes-AMG GT3 Red Bull Racing" by VTX (@VTX_car)
    https://sketchfab.com/3d-models/mercedes-amg-gt3-red-bull-racing-035f061cb6624effbc483d5f9b5ecaba

Output node layout (read by src/lib/ported-car-model.ts):
    CAR (extras: wheelCentres, tyreRadius, tyreHalfWidth, wheelbaseM, trackWidthM, steer, cameras, source)
      BODY              body, interior, glass, lights, brake discs & callipers (baked in car frame)
      STEER             steering-wheel pivot (local +Z along steering column into the dash; rotateZ(+) turns right)
      WHEEL_RF          front-right hub pivot at wheelCentres.WHEEL_RF
        WHEEL_RF_RIM    rim mesh centred on the wheel hub in car axes
        WHEEL_RF_TYRE   tyre mesh centred on the wheel hub in car axes
      WHEEL_LF          front-left hub pivot
      WHEEL_RR          rear-right hub pivot
      WHEEL_LR          rear-left hub pivot

Coordinate convention: +X left, +Y up, +Z forward, metres, floor at y = 0, X centred on the four wheels.
"""
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

CORNER_ORDER = ('RF', 'LF', 'RR', 'LR')
DDIAZ_WHEEL_NODES = {
    'LF': '3DWheel Front L',
    'RF': '3DWheel Front R',
    'LR': '3DWheel Rear L',
    'RR': '3DWheel Rear R',
}


def local_matrix(n):
    if 'matrix' in n:
        return np.array(n['matrix'], dtype=np.float64).reshape(4, 4).T
    T = np.eye(4, dtype=np.float64)
    if 'translation' in n:
        T[:3, 3] = n['translation']
    R = np.eye(4, dtype=np.float64)
    if 'rotation' in n:
        x, y, z, w = n['rotation']
        R[:3, :3] = [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    S = np.eye(4, dtype=np.float64)
    if 'scale' in n:
        S[0, 0], S[1, 1], S[2, 2] = n['scale']
    return T @ R @ S


def to_gltf_matrix(m):
    return [float(v) for v in m.T.ravel()]


class SourceGlb:
    """Minimal GLB reader for extracting accessors, images, and materials."""

    COMP_DTYPE = {
        5120: np.int8,
        5121: np.uint8,
        5122: np.int16,
        5123: np.uint16,
        5125: np.uint32,
        5126: np.float32,
    }
    TYPE_COUNT = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

    def __init__(self, path):
        with open(path, 'rb') as f:
            data = f.read()
        magic, version, _ = struct.unpack_from('<III', data, 0)
        assert magic == 0x46546C67 and version == 2, f'Not a glTF 2.0 GLB: {path}'
        jlen, jtype = struct.unpack_from('<II', data, 12)
        assert jtype == 0x4E4F534A
        self.j = json.loads(data[20:20 + jlen])
        blen, btype = struct.unpack_from('<II', data, 20 + jlen)
        assert btype == 0x004E4942
        self.bin = memoryview(data)[28 + jlen:28 + jlen + blen]

    def accessor(self, idx):
        acc = self.j['accessors'][idx]
        bv = self.j['bufferViews'][acc['bufferView']]
        dtype = self.COMP_DTYPE[acc['componentType']]
        ncomp = self.TYPE_COUNT[acc['type']]
        count = acc['count']
        base = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
        stride = bv.get('byteStride')
        item_bytes = np.dtype(dtype).itemsize * ncomp
        if not stride or stride == item_bytes:
            arr = np.frombuffer(self.bin, dtype=dtype, count=count * ncomp, offset=base)
            return arr.reshape(count, ncomp).copy() if ncomp > 1 else arr.copy()
        out = np.empty((count, ncomp), dtype=dtype)
        for i in range(count):
            out[i] = np.frombuffer(self.bin, dtype=dtype, count=ncomp, offset=base + i * stride)
        return out if ncomp > 1 else out.ravel()

    def view_bytes(self, bv_idx):
        bv = self.j['bufferViews'][bv_idx]
        off = bv.get('byteOffset', 0)
        return bytes(self.bin[off:off + bv['byteLength']])


class GlbWriter:
    """Builds a clean glTF 2.0 binary with optional KHR_mesh_quantization for compact normals/UVs."""

    def __init__(self, use_quantization=False):
        self.use_quantization = use_quantization
        self.j = {
            'asset': {'version': '2.0', 'generator': 'scripts/cars/port_sketchfab_gt3.py'},
            'scenes': [{'name': 'CAR', 'nodes': []}],
            'scene': 0,
            'nodes': [],
            'meshes': [],
            'materials': [],
            'textures': [],
            'images': [],
            'samplers': [],
            'accessors': [],
            'bufferViews': [],
            'buffers': [{'byteLength': 0}],
        }
        if use_quantization:
            self.j['extensionsUsed'] = ['KHR_mesh_quantization']
            self.j['extensionsRequired'] = ['KHR_mesh_quantization']
        self.bin = bytearray()

    def add_view(self, payload, target=None, byte_stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        bv = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(payload)}
        if target is not None:
            bv['target'] = target
        if byte_stride is not None:
            bv['byteStride'] = byte_stride
        self.bin.extend(payload)
        self.j['bufferViews'].append(bv)
        return len(self.j['bufferViews']) - 1

    def add_accessor(self, arr, kind, comp, target=None, normalized=False, byte_stride=None, with_bounds=False):
        bv_idx = self.add_view(arr.tobytes(), target=target, byte_stride=byte_stride)
        acc = {
            'bufferView': bv_idx,
            'componentType': comp,
            'count': int(len(arr)),
            'type': kind,
        }
        if normalized:
            acc['normalized'] = True
        if with_bounds:
            acc['min'] = [float(x) for x in arr.min(0)]
            acc['max'] = [float(x) for x in arr.max(0)]
        self.j['accessors'].append(acc)
        return len(self.j['accessors']) - 1

    def add_primitive(self, pos, nrm, uv0, indices, mat_idx, uv1=None, quantize=False):
        pos = np.ascontiguousarray(pos, dtype=np.float32)
        nrm = np.ascontiguousarray(nrm, dtype=np.float32)
        norms = np.linalg.norm(nrm, axis=1, keepdims=True)
        nrm = np.where(norms > 1e-8, nrm / np.maximum(norms, 1e-8), np.array([0.0, 1.0, 0.0], dtype=np.float32))

        attrs = {
            'POSITION': self.add_accessor(pos, 'VEC3', 5126, target=34962, with_bounds=True),
        }
        if quantize and self.use_quantization:
            # 4-byte aligned int8 normalized normals (KHR_mesh_quantization)
            nrm_i8 = np.zeros((len(nrm), 4), dtype=np.int8)
            nrm_i8[:, :3] = np.clip(np.round(nrm * 127.0), -127, 127).astype(np.int8)
            attrs['NORMAL'] = self.add_accessor(
                nrm_i8, 'VEC3', 5120, target=34962, normalized=True, byte_stride=4
            )
        else:
            attrs['NORMAL'] = self.add_accessor(nrm, 'VEC3', 5126, target=34962)

        if uv0 is not None:
            uv0 = np.ascontiguousarray(uv0, dtype=np.float32)
            if quantize and self.use_quantization and uv0.min() >= 0.0 and uv0.max() <= 1.0:
                uv0_u16 = np.clip(np.round(uv0 * 65535.0), 0, 65535).astype(np.uint16)
                attrs['TEXCOORD_0'] = self.add_accessor(uv0_u16, 'VEC2', 5123, target=34962, normalized=True)
            else:
                attrs['TEXCOORD_0'] = self.add_accessor(uv0, 'VEC2', 5126, target=34962)

        if uv1 is not None:
            uv1 = np.ascontiguousarray(uv1, dtype=np.float32)
            if quantize and self.use_quantization and uv1.min() >= 0.0 and uv1.max() <= 1.0:
                uv1_u16 = np.clip(np.round(uv1 * 65535.0), 0, 65535).astype(np.uint16)
                attrs['TEXCOORD_1'] = self.add_accessor(uv1_u16, 'VEC2', 5123, target=34962, normalized=True)
            else:
                attrs['TEXCOORD_1'] = self.add_accessor(uv1, 'VEC2', 5126, target=34962)

        idx_flat = np.ascontiguousarray(indices.ravel())
        if len(pos) < 65536:
            idx_arr = idx_flat.astype(np.uint16)
            idx_acc = self.add_accessor(idx_arr, 'SCALAR', 5123, target=34963)
        else:
            idx_arr = idx_flat.astype(np.uint32)
            idx_acc = self.add_accessor(idx_arr, 'SCALAR', 5125, target=34963)

        return {'attributes': attrs, 'indices': idx_acc, 'material': mat_idx}

    def add_mesh_node(self, name, prims, matrix=None, translation=None):
        mesh_idx = len(self.j['meshes'])
        self.j['meshes'].append({'name': name, 'primitives': prims})
        node = {'name': name, 'mesh': mesh_idx}
        if matrix is not None:
            node['matrix'] = to_gltf_matrix(matrix)
        if translation is not None:
            node['translation'] = [float(v) for v in translation]
        self.j['nodes'].append(node)
        return len(self.j['nodes']) - 1

    def add_node(self, name, children=(), matrix=None, translation=None, extras=None):
        node = {'name': name}
        if children:
            node['children'] = list(children)
        if matrix is not None:
            node['matrix'] = to_gltf_matrix(matrix)
        if translation is not None:
            node['translation'] = [float(v) for v in translation]
        if extras is not None:
            node['extras'] = extras
        self.j['nodes'].append(node)
        return len(self.j['nodes']) - 1

    def save(self, path):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j['buffers'][0]['byteLength'] = len(self.bin)
        js = json.dumps(self.j, separators=(',', ':')).encode('utf-8')
        js += b' ' * (-len(js) % 4)
        total_len = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total_len))
            f.write(struct.pack('<II', len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942))
            f.write(self.bin)


def transform_prim(src, prim, M_world, need_uv1=False):
    """Read primitive attributes and transform positions/normals by 4x4 matrix M_world."""
    pos = src.accessor(prim['attributes']['POSITION']).astype(np.float64)
    nrm = src.accessor(prim['attributes']['NORMAL']).astype(np.float64)
    uv0 = src.accessor(prim['attributes']['TEXCOORD_0']).astype(np.float32) if 'TEXCOORD_0' in prim['attributes'] else None
    uv1 = (
        src.accessor(prim['attributes']['TEXCOORD_1']).astype(np.float32)
        if need_uv1 and 'TEXCOORD_1' in prim['attributes']
        else None
    )
    tris = src.accessor(prim['indices']).ravel().reshape(-1, 3).astype(np.uint32)

    R = M_world[:3, :3]
    t = M_world[:3, 3]
    pos_w = np.einsum('ij,kj->ik', pos, R) + t
    R_nrm = np.linalg.inv(R).T
    nrm_w = np.einsum('ij,kj->ik', nrm, R_nrm)
    if np.linalg.det(R) < 0:
        tris = tris[:, ::-1]
    return pos_w, nrm_w, uv0, uv1, tris


def subset_prim(pos, nrm, uv0, uv1, tris, tri_mask):
    """Extract a triangle subset and compact its vertex arrays."""
    sub_tris = tris[tri_mask]
    used_verts, new_indices = np.unique(sub_tris.ravel(), return_inverse=True)
    sub_pos = pos[used_verts]
    sub_nrm = nrm[used_verts]
    sub_uv0 = uv0[used_verts] if uv0 is not None else None
    sub_uv1 = uv1[used_verts] if uv1 is not None else None
    return sub_pos, sub_nrm, sub_uv0, sub_uv1, new_indices.reshape(-1, 3)


def make_steer_frame(pivot, column_axis):
    """Build 4x4 STEER node matrix with local +Z along column_axis (into the dash) and local +X horizontal."""
    z_axis = np.array(column_axis, dtype=np.float64)
    z_axis /= np.linalg.norm(z_axis)
    x_axis = np.array([1.0, 0.0, 0.0], dtype=np.float64)
    x_axis -= np.dot(x_axis, z_axis) * z_axis
    x_axis /= np.linalg.norm(x_axis)
    y_axis = np.cross(z_axis, x_axis)
    M = np.eye(4, dtype=np.float64)
    M[:3, 0] = x_axis
    M[:3, 1] = y_axis
    M[:3, 2] = z_axis
    M[:3, 3] = pivot
    return M


def copy_and_downscale_materials(src, writer, max_base_tex, max_aux_tex, jpeg_quality=88):
    """Copy materials, textures, samplers, and downscaled images into writer."""
    writer.j['samplers'] = src.j.get(
        'samplers', [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    )

    # Identify which images are used as baseColor/emissive vs normal/metallicRoughness/occlusion,
    # and which images are referenced by BLEND/MASK materials that require an alpha channel.
    base_images = set()
    primary_images = set()
    alpha_images = set()
    used_tex_indices = set()
    textures = src.j.get('textures', [])
    PRIMARY_KEYWORDS = ('Livery', 'paint', 'Exterior', 'Cockpit', 'Steering', 'Tyre', 'Tire', 'Rim', 'Hub')

    def mark_tex(tinfo, is_base=False, is_primary=False, needs_alpha=False):
        if not tinfo:
            return
        ti = tinfo['index']
        used_tex_indices.add(ti)
        img_idx = textures[ti]['source']
        if is_base:
            base_images.add(img_idx)
        if is_primary:
            primary_images.add(img_idx)
        if needs_alpha:
            alpha_images.add(img_idx)

    cleaned_materials = []
    for m in src.j.get('materials', []):
        m = json.loads(json.dumps(m))
        name = m.get('name', '')
        ext = m.get('extensions', {})
        if 'KHR_materials_transmission' in ext:
            del ext['KHR_materials_transmission']
            pbr = m.setdefault('pbrMetallicRoughness', {})
            col = pbr.get('baseColorFactor', [1.0, 1.0, 1.0, 1.0])
            pbr['baseColorFactor'] = col[:3] + [0.35]
            m['alphaMode'] = 'BLEND'
        if not ext:
            m.pop('extensions', None)

        if name in ('glassMAT_Glass1', 'MI_Mercedes_AMG_GT3_Evo_windows_Glass_Inst'):
            pbr = m.setdefault('pbrMetallicRoughness', {})
            col = pbr.get('baseColorFactor', [1.0, 1.0, 1.0, 1.0])
            pbr['baseColorFactor'] = col[:3] + [0.35]
            m['alphaMode'] = 'BLEND'
        elif name == 'WorldGridMaterial':
            # Mirror glass surface on the VTX AMG GT3 Evo
            m['pbrMetallicRoughness'] = {
                'baseColorFactor': [0.9, 0.92, 0.95, 1.0],
                'metallicFactor': 1.0,
                'roughnessFactor': 0.05,
            }

        alpha_mode = m.get('alphaMode', 'OPAQUE')
        needs_alpha = alpha_mode in ('BLEND', 'MASK')
        is_primary = any(k.lower() in name.lower() for k in PRIMARY_KEYWORDS)
        pbr = m.get('pbrMetallicRoughness', {})
        mark_tex(pbr.get('baseColorTexture'), is_base=True, is_primary=is_primary, needs_alpha=needs_alpha)
        mark_tex(pbr.get('metallicRoughnessTexture'), is_base=False)
        mark_tex(m.get('normalTexture'), is_base=False)
        mark_tex(m.get('occlusionTexture'), is_base=False)
        mark_tex(m.get('emissiveTexture'), is_base=True, is_primary=is_primary)
        for ext_val in m.get('extensions', {}).values():
            if isinstance(ext_val, dict):
                for k, v in ext_val.items():
                    if k.endswith('Texture') and isinstance(v, dict):
                        mark_tex(v, is_base=False)
        cleaned_materials.append(m)

    # Re-encode only referenced images and remap texture indices
    old_to_new_img = {}
    for ti in sorted(used_tex_indices):
        img_idx = textures[ti]['source']
        if img_idx in old_to_new_img:
            continue
        img_def = src.j['images'][img_idx]
        raw = src.view_bytes(img_def['bufferView'])
        im = Image.open(io.BytesIO(raw))
        im.load()

        if img_idx in primary_images:
            max_dim = max_base_tex
        elif img_idx in base_images:
            max_dim = max_aux_tex
        else:
            max_dim = min(max_aux_tex, 256)
        if max(im.size) > max_dim:
            scale = max_dim / max(im.size)
            new_size = (max(1, int(round(im.width * scale))), max(1, int(round(im.height * scale))))
            im = im.resize(new_size, Image.LANCZOS)

        has_alpha = img_idx in alpha_images and im.mode in ('RGBA', 'LA', 'PA')
        if has_alpha:
            rgba = im.convert('RGBA')
            alpha_min = np.asarray(rgba)[..., 3].min()
            if alpha_min == 255:
                has_alpha = False

        buf = io.BytesIO()
        if has_alpha:
            im.convert('RGBA').save(buf, format='PNG', optimize=True)
            mime = 'image/png'
        else:
            im.convert('RGB').save(buf, format='JPEG', quality=jpeg_quality, optimize=True)
            mime = 'image/jpeg'

        bv_idx = writer.add_view(buf.getvalue())
        new_img_idx = len(writer.j['images'])
        writer.j['images'].append({
            'name': img_def.get('name', f'image_{new_img_idx}'),
            'bufferView': bv_idx,
            'mimeType': mime,
        })
        old_to_new_img[img_idx] = new_img_idx

    old_to_new_tex = {}
    for ti in sorted(used_tex_indices):
        tdef = dict(textures[ti])
        tdef['source'] = old_to_new_img[tdef['source']]
        new_ti = len(writer.j['textures'])
        writer.j['textures'].append(tdef)
        old_to_new_tex[ti] = new_ti

    def remap_tex(tinfo):
        if isinstance(tinfo, dict) and 'index' in tinfo:
            tinfo['index'] = old_to_new_tex[tinfo['index']]

    for m in cleaned_materials:
        pbr = m.get('pbrMetallicRoughness', {})
        remap_tex(pbr.get('baseColorTexture'))
        remap_tex(pbr.get('metallicRoughnessTexture'))
        remap_tex(m.get('normalTexture'))
        remap_tex(m.get('occlusionTexture'))
        remap_tex(m.get('emissiveTexture'))
        for ext_val in m.get('extensions', {}).values():
            if isinstance(ext_val, dict):
                for k, v in ext_val.items():
                    if k.endswith('Texture'):
                        remap_tex(v)
        writer.j['materials'].append(m)


def port_ddiaz_bmw(src, dst):
    """Port Ddiaz Design '2025 BMW M4 GT3 EVO G82' GLB."""
    nodes = src.j['nodes']
    by_name = {n.get('name'): i for i, n in enumerate(nodes)}

    # Walk from RootNode down (dropping the top 0.01 wrapper so coordinates are in metres, +X left, +Y up, +Z forward)
    W = {}

    def walk(i, P):
        W[i] = P @ local_matrix(nodes[i])
        for c in nodes[i].get('children', []):
            walk(c, W[i])

    walk(by_name['RootNode'], np.eye(4, dtype=np.float64))

    def subtree_mesh_nodes(root_idx):
        out = [root_idx] if 'mesh' in nodes[root_idx] else []
        for c in nodes[root_idx].get('children', []):
            out.extend(subtree_mesh_nodes(c))
        return out

    # Compute overall floor min_y and wheel X centring
    all_mesh_nodes = [i for i in W if 'mesh' in nodes[i]]
    min_y = min(
        transform_prim(src, src.j['meshes'][nodes[i]['mesh']]['primitives'][0], W[i])[0][:, 1].min()
        for i in all_mesh_nodes
    )

    wheel_subtrees = {c: subtree_mesh_nodes(by_name[wname]) for c, wname in DDIAZ_WHEEL_NODES.items()}
    wheel_node_set = {ni for sub in wheel_subtrees.values() for ni in sub}

    # First pass over tyres to find wheel centres for exact X centring
    raw_tyre_centres = {}
    for corner, sub_nodes in wheel_subtrees.items():
        for ni in sub_nodes:
            mesh = src.j['meshes'][nodes[ni]['mesh']]
            prim = mesh['primitives'][0]
            mat_name = src.j['materials'][prim['material']]['name']
            if mat_name.startswith('Tire'):
                pos, _, _, _, _ = transform_prim(src, prim, W[ni])
                raw_tyre_centres[corner] = 0.5 * (pos.min(0) + pos.max(0))

    x_shift = -float(np.mean([c[0] for c in raw_tyre_centres.values()]))
    y_shift = -float(min_y)
    T_shift = np.eye(4, dtype=np.float64)
    T_shift[0, 3] = x_shift
    T_shift[1, 3] = y_shift
    for i in W:
        W[i] = T_shift @ W[i]

    writer = GlbWriter(use_quantization=False)
    copy_and_downscale_materials(src, writer, max_base_tex=2048, max_aux_tex=1024, jpeg_quality=90)

    # Build the 4 wheel nodes (RF, LF, RR, LR) and collect brake discs/callipers for BODY
    wheel_nodes = []
    wheel_centres = {}
    tyre_radius = {}
    tyre_half_width = {}
    brake_body_nodes = []

    for corner in CORNER_ORDER:
        sub_nodes = wheel_subtrees[corner]
        tyre_data = None
        rim_data = None
        for ni in sub_nodes:
            mesh = src.j['meshes'][nodes[ni]['mesh']]
            prim = mesh['primitives'][0]
            mat_idx = prim['material']
            mat_name = src.j['materials'][mat_idx]['name']
            pos, nrm, uv0, _, tris = transform_prim(src, prim, W[ni])
            if mat_name.startswith('Tire'):
                tyre_data = (pos, nrm, uv0, tris, mat_idx)
            elif 'Hub' in mat_name:
                rim_data = (pos, nrm, uv0, tris, mat_idx)
            else:
                # Brake disc and calliper do not spin with the wheel; put them under BODY
                brake_body_nodes.append((nodes[ni].get('name', f'BRAKE_{corner}'), pos, nrm, uv0, tris, mat_idx))

        assert tyre_data is not None and rim_data is not None, f'Missing tyre or rim on {corner}'
        t_pos, t_nrm, t_uv0, t_tris, t_mat = tyre_data
        r_pos, r_nrm, r_uv0, r_tris, r_mat = rim_data

        centre = 0.5 * (t_pos.min(0) + t_pos.max(0))
        wheel_centres[f'WHEEL_{corner}'] = [float(v) for v in centre]
        tyre_radius[corner] = float(np.hypot(t_pos[:, 1] - centre[1], t_pos[:, 2] - centre[2]).max())
        tyre_half_width[corner] = float(0.5 * (t_pos[:, 0].max() - t_pos[:, 0].min()))

        rim_prim = writer.add_primitive(r_pos - centre, r_nrm, r_uv0, r_tris, r_mat)
        tyre_prim = writer.add_primitive(t_pos - centre, t_nrm, t_uv0, t_tris, t_mat)
        rim_node = writer.add_mesh_node(f'WHEEL_{corner}_RIM', [rim_prim])
        tyre_node = writer.add_mesh_node(f'WHEEL_{corner}_TYRE', [tyre_prim])
        wheel_nodes.append(writer.add_node(f'WHEEL_{corner}', children=[rim_node, tyre_node], translation=centre))

    # Steering wheel: roundel node BMW:ANC_SteeringWheel_00 gives the exact hub centre; tilt is 9.05 deg
    roundel_ni = subtree_mesh_nodes(by_name['BMW:ANC_SteeringWheel_00'])[0]
    r_pos, _, _, _, _ = transform_prim(
        src, src.j['meshes'][nodes[roundel_ni]['mesh']]['primitives'][0], W[roundel_ni]
    )
    steer_pivot = 0.5 * (r_pos.min(0) + r_pos.max(0))
    # Steering column axis points forward and slightly down into the dashboard (+Z local)
    pitch_rad = np.deg2rad(9.05)
    column_axis = [0.0, -float(np.sin(pitch_rad)), float(np.cos(pitch_rad))]
    M_steer = make_steer_frame(steer_pivot, column_axis)

    steer_kids = []
    body_kids = []

    for b_name, b_pos, b_nrm, b_uv0, b_tris, b_mat in brake_body_nodes:
        prim = writer.add_primitive(b_pos, b_nrm, b_uv0, b_tris, b_mat)
        body_kids.append(writer.add_mesh_node(b_name, [prim]))

    for ni in all_mesh_nodes:
        if ni in wheel_node_set:
            continue
        n = nodes[ni]
        name = n.get('name', f'node_{ni}')
        mesh = src.j['meshes'][n['mesh']]
        prim = mesh['primitives'][0]
        mat_idx = prim['material']
        pos, nrm, uv0, _, tris = transform_prim(src, prim, W[ni])

        pmin, pmax = pos.min(0), pos.max(0)
        in_steer_box = (
            pmin[0] >= 0.15
            and pmax[0] <= 0.47
            and pmin[1] >= 0.63
            and pmax[1] <= 0.86
            and pmin[2] >= 0.005
            and pmax[2] <= 0.105
        )
        if 'SteeringWheel' in name or in_steer_box:
            pos_s = np.einsum('ij,jk->ik', pos - steer_pivot, M_steer[:3, :3])
            nrm_s = np.einsum('ij,jk->ik', nrm, M_steer[:3, :3])
            s_prim = writer.add_primitive(pos_s, nrm_s, uv0, tris, mat_idx)
            steer_kids.append(writer.add_mesh_node(name, [s_prim]))
        else:
            b_prim = writer.add_primitive(pos, nrm, uv0, tris, mat_idx)
            body_kids.append(writer.add_mesh_node(name, [b_prim]))

    body_node = writer.add_node('BODY', children=body_kids)
    steer_node = writer.add_node('STEER', children=steer_kids, matrix=M_steer)

    lf, rf = wheel_centres['WHEEL_LF'], wheel_centres['WHEEL_RF']
    lr, rr = wheel_centres['WHEEL_LR'], wheel_centres['WHEEL_RR']
    cameras = {
        'cockpit': {'pos': [round(float(steer_pivot[0]), 3), 0.96, -0.39], 'pitchDeg': -4.17, 'fov': 60},
        'tcam': {'pos': [0.0, 1.48, -0.15], 'pitchDeg': -7, 'fov': 58},
        'dash': {'pos': [round(float(steer_pivot[0]), 3), 0.88, 0.08], 'pitchDeg': -3, 'fov': 58},
        'bumper': {'pos': [0.0, 0.95, 1.15], 'pitchDeg': -3, 'fov': 60},
        'nearChase': {'pos': [0.0, 1.9, -5.4], 'pitchDeg': -10, 'fov': 60},
        'farChase': {'pos': [0.0, 2.4, -7.4], 'pitchDeg': -10, 'fov': 60},
    }
    extras = {
        'wheelCentres': wheel_centres,
        'tyreRadius': tyre_radius,
        'tyreHalfWidth': tyre_half_width,
        'wheelbaseM': float(lf[2] - lr[2]),
        'trackWidthM': {'front': float(lf[0] - rf[0]), 'rear': float(lr[0] - rr[0])},
        'steer': {'pivot': [float(v) for v in steer_pivot], 'columnAxis': column_axis},
        'cameras': cameras,
        'source': {
            **src.j.get('asset', {}).get('extras', {}),
            'converted': 'scripts/cars/port_sketchfab_gt3.py',
        },
    }
    car_root = writer.add_node('CAR', children=[body_node, steer_node, *wheel_nodes], extras=extras)
    writer.j['scenes'][0]['nodes'] = [car_root]
    writer.j['asset']['extras'] = extras['source']
    writer.save(dst)
    return extras, len(steer_kids), len(body_kids)


def port_vtx_amg(src, dst):
    """Port VTX 'Mercedes-AMG GT3 Red Bull Racing' GLB."""
    nodes = src.j['nodes']

    # Scene root has +X forward, +Y up, -Z left. Ry(-90 deg) rotates into +X left, +Y up, +Z forward.
    R_align = np.array(
        [
            [0.0, 0.0, -1.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    W = {}

    def walk(i, P):
        W[i] = P @ local_matrix(nodes[i])
        for c in nodes[i].get('children', []):
            walk(c, W[i])

    for root_i in src.j['scenes'][0]['nodes']:
        walk(root_i, R_align)

    all_mesh_nodes = [i for i in W if 'mesh' in nodes[i]]
    min_y = min(
        transform_prim(src, src.j['meshes'][nodes[i]['mesh']]['primitives'][0], W[i])[0][:, 1].min()
        for i in all_mesh_nodes
    )

    # Locate the tyre mesh to compute wheel X centring before shifting
    tyre_nodes = [
        i
        for i in all_mesh_nodes
        if src.j['materials'][src.j['meshes'][nodes[i]['mesh']]['primitives'][0]['material']]['name']
        == 'MI_Mercedes_AMG_GT3_Evo_Tyre_Inst'
    ]
    assert len(tyre_nodes) == 1
    t_pos0, _, _, _, t_tris0 = transform_prim(
        src, src.j['meshes'][nodes[tyre_nodes[0]]['mesh']]['primitives'][0], W[tyre_nodes[0]]
    )
    t_cent0 = t_pos0[t_tris0].mean(1)
    raw_wheel_xs = []
    for is_left in (False, True):
        for is_front in (True, False):
            mask = (t_cent0[:, 0] > 0 if is_left else t_cent0[:, 0] < 0) & (
                t_cent0[:, 2] > 0 if is_front else t_cent0[:, 2] < 0
            )
            sub_p = t_pos0[np.unique(t_tris0[mask].ravel())]
            raw_wheel_xs.append(0.5 * (sub_p[:, 0].min() + sub_p[:, 0].max()))

    x_shift = -float(np.mean(raw_wheel_xs))
    y_shift = -float(min_y)
    T_shift = np.eye(4, dtype=np.float64)
    T_shift[0, 3] = x_shift
    T_shift[1, 3] = y_shift
    for i in W:
        W[i] = T_shift @ W[i]

    writer = GlbWriter(use_quantization=True)
    copy_and_downscale_materials(src, writer, max_base_tex=1024, max_aux_tex=512, jpeg_quality=86)

    # Collect rim and tyre meshes and split by quadrant into (RF, LF, RR, LR)
    rim_parts = {c: [] for c in CORNER_ORDER}
    tyre_parts = {c: [] for c in CORNER_ORDER}
    rim_mat_idx = None
    tyre_mat_idx = None

    def corner_mask(tri_centroids, corner):
        want_left = corner.endswith('L') or corner.startswith('L')
        want_front = corner.endswith('F')
        x_ok = tri_centroids[:, 0] > 0 if want_left else tri_centroids[:, 0] < 0
        z_ok = tri_centroids[:, 2] > 0 if want_front else tri_centroids[:, 2] < 0
        return x_ok & z_ok

    # Steering wheel hub is centred on the steering column quick-release shaft at (0.4000, 0.7226 - min_y, -0.150)
    steer_pivot = np.array([0.4000 + x_shift, 0.7226 + y_shift, -0.150], dtype=np.float64)
    column_axis = [0.0, 0.0, 1.0]
    M_steer = make_steer_frame(steer_pivot, column_axis)

    steer_kids = []
    body_kids = []

    for ni in all_mesh_nodes:
        n = nodes[ni]
        mesh = src.j['meshes'][n['mesh']]
        prim = mesh['primitives'][0]
        mat_idx = prim['material']
        mat_name = src.j['materials'][mat_idx]['name']
        need_uv1 = mat_name == 'MI_Mercedes_AMG_GT3_Evo_Lights'
        pos, nrm, uv0, uv1, tris = transform_prim(src, prim, W[ni], need_uv1=need_uv1)
        cent = pos[tris].mean(1)

        if mat_name == 'MI_Mercedes_AMG_GT3_Evo_Tyre_Inst':
            tyre_mat_idx = mat_idx
            for c in CORNER_ORDER:
                m = corner_mask(cent, c)
                if m.any():
                    tyre_parts[c].append(subset_prim(pos, nrm, uv0, uv1, tris, m))
        elif mat_name == 'MI_Mercedes_AMG_GT3_Evo_Rim_Inst':
            rim_mat_idx = mat_idx
            for c in CORNER_ORDER:
                m = corner_mask(cent, c)
                if m.any():
                    rim_parts[c].append(subset_prim(pos, nrm, uv0, uv1, tris, m))
        elif 'Steering_Wheel' in mat_name:
            pos_s = np.einsum('ij,jk->ik', pos - steer_pivot, M_steer[:3, :3])
            nrm_s = np.einsum('ij,jk->ik', nrm, M_steer[:3, :3])
            s_prim = writer.add_primitive(pos_s, nrm_s, uv0, tris, mat_idx, uv1=uv1, quantize=True)
            steer_kids.append(writer.add_mesh_node(n.get('name', f'STEER_{ni}'), [s_prim]))
        elif mat_name == 'MI_Mercedes_AMG_GT3_Evo_Interior_Stickers':
            # Split steering-wheel button stickers from cabin/dash stickers
            in_sw = (
                (cent[:, 0] >= 0.23)
                & (cent[:, 0] <= 0.57)
                & (cent[:, 1] >= 0.62)
                & (cent[:, 1] <= 0.81)
                & (cent[:, 2] >= -0.18)
                & (cent[:, 2] <= -0.11)
            )
            if in_sw.any():
                sp, sn, suv0, suv1, stris = subset_prim(pos, nrm, uv0, uv1, tris, in_sw)
                pos_s = np.einsum('ij,jk->ik', sp - steer_pivot, M_steer[:3, :3])
                nrm_s = np.einsum('ij,jk->ik', sn, M_steer[:3, :3])
                s_prim = writer.add_primitive(pos_s, nrm_s, suv0, stris, mat_idx, uv1=suv1, quantize=True)
                steer_kids.append(writer.add_mesh_node('STEER_Stickers', [s_prim]))
            if (~in_sw).any():
                bp, bn, buv0, buv1, btris = subset_prim(pos, nrm, uv0, uv1, tris, ~in_sw)
                b_prim = writer.add_primitive(bp, bn, buv0, btris, mat_idx, uv1=buv1, quantize=True)
                body_kids.append(writer.add_mesh_node(n.get('name', f'BODY_{ni}'), [b_prim]))
        else:
            b_prim = writer.add_primitive(pos, nrm, uv0, tris, mat_idx, uv1=uv1, quantize=True)
            body_kids.append(writer.add_mesh_node(n.get('name', f'BODY_{ni}'), [b_prim]))

    def merge_parts(parts):
        pos_list, nrm_list, uv0_list, tris_list = [], [], [], []
        v_offset = 0
        for p, n, u0, _, t in parts:
            pos_list.append(p)
            nrm_list.append(n)
            uv0_list.append(u0)
            tris_list.append(t + v_offset)
            v_offset += len(p)
        return (
            np.vstack(pos_list),
            np.vstack(nrm_list),
            np.vstack(uv0_list),
            np.vstack(tris_list),
        )

    wheel_nodes = []
    wheel_centres = {}
    tyre_radius = {}
    tyre_half_width = {}

    for corner in CORNER_ORDER:
        t_pos, t_nrm, t_uv0, t_tris = merge_parts(tyre_parts[corner])
        r_pos, r_nrm, r_uv0, r_tris = merge_parts(rim_parts[corner])

        centre = 0.5 * (t_pos.min(0) + t_pos.max(0))
        wheel_centres[f'WHEEL_{corner}'] = [float(v) for v in centre]
        tyre_radius[corner] = float(np.hypot(t_pos[:, 1] - centre[1], t_pos[:, 2] - centre[2]).max())
        tyre_half_width[corner] = float(0.5 * (t_pos[:, 0].max() - t_pos[:, 0].min()))

        # Keep tyre attributes unquantized float32; rim can use quantized normals/UVs
        rim_prim = writer.add_primitive(r_pos - centre, r_nrm, r_uv0, r_tris, rim_mat_idx, quantize=True)
        tyre_prim = writer.add_primitive(t_pos - centre, t_nrm, t_uv0, t_tris, tyre_mat_idx, quantize=False)
        rim_node = writer.add_mesh_node(f'WHEEL_{corner}_RIM', [rim_prim])
        tyre_node = writer.add_mesh_node(f'WHEEL_{corner}_TYRE', [tyre_prim])
        wheel_nodes.append(writer.add_node(f'WHEEL_{corner}', children=[rim_node, tyre_node], translation=centre))

    body_node = writer.add_node('BODY', children=body_kids)
    steer_node = writer.add_node('STEER', children=steer_kids, matrix=M_steer)

    lf, rf = wheel_centres['WHEEL_LF'], wheel_centres['WHEEL_RF']
    lr, rr = wheel_centres['WHEEL_LR'], wheel_centres['WHEEL_RR']
    cameras = {
        'cockpit': {'pos': [round(float(steer_pivot[0]), 3), 0.94, -0.58], 'pitchDeg': -4.17, 'fov': 60},
        'tcam': {'pos': [0.0, 1.38, -0.35], 'pitchDeg': -7, 'fov': 58},
        'dash': {'pos': [round(float(steer_pivot[0]), 3), 0.85, -0.10], 'pitchDeg': -3, 'fov': 58},
        'bumper': {'pos': [0.0, 0.92, 0.90], 'pitchDeg': -3, 'fov': 60},
        'nearChase': {'pos': [0.0, 1.85, -5.2], 'pitchDeg': -10, 'fov': 60},
        'farChase': {'pos': [0.0, 2.35, -7.2], 'pitchDeg': -10, 'fov': 60},
    }
    extras = {
        'wheelCentres': wheel_centres,
        'tyreRadius': tyre_radius,
        'tyreHalfWidth': tyre_half_width,
        'wheelbaseM': float(lf[2] - lr[2]),
        'trackWidthM': {'front': float(lf[0] - rf[0]), 'rear': float(lr[0] - rr[0])},
        'steer': {'pivot': [float(v) for v in steer_pivot], 'columnAxis': column_axis},
        'cameras': cameras,
        'source': {
            **src.j.get('asset', {}).get('extras', {}),
            'converted': 'scripts/cars/port_sketchfab_gt3.py',
        },
    }
    car_root = writer.add_node('CAR', children=[body_node, steer_node, *wheel_nodes], extras=extras)
    writer.j['scenes'][0]['nodes'] = [car_root]
    writer.j['asset']['extras'] = extras['source']
    writer.save(dst)
    return extras, len(steer_kids), len(body_kids)


def main(src_path, dst_path):
    with np.errstate(all='ignore'):
        src = SourceGlb(src_path)
        node_names = {n.get('name') for n in src.j.get('nodes', [])}
        if '3DWheel Front L' in node_names:
            extras, n_steer, n_body = port_ddiaz_bmw(src, dst_path)
        else:
            extras, n_steer, n_body = port_vtx_amg(src, dst_path)

    size_mb = os.path.getsize(dst_path) / (1024 * 1024)
    wc = extras['wheelCentres']
    print(f'wrote {dst_path} ({size_mb:.2f} MiB / {os.path.getsize(dst_path) / 1e6:.2f} MB)')
    print('  wheelCentres:', {k: [round(x, 4) for x in v] for k, v in wc.items()})
    print('  tyreRadius:', {k: round(v, 4) for k, v in extras['tyreRadius'].items()})
    print('  tyreHalfWidth:', {k: round(v, 4) for k, v in extras['tyreHalfWidth'].items()})
    print(
        f'  wheelbase: {extras["wheelbaseM"]:.4f} m, '
        f'track F: {extras["trackWidthM"]["front"]:.4f} m, R: {extras["trackWidthM"]["rear"]:.4f} m'
    )
    print(f'  meshes: {n_body} body, {n_steer} steer, 4 wheels (rim + tyre)')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: python -P scripts/cars/port_sketchfab_gt3.py <source.glb> <out.glb>')
    main(sys.argv[1], sys.argv[2])
