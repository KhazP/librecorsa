"""
Extract a Codemasters Ego ERPK v3 track archive (e.g. Qiddiya Speed Park) into a clean
uncompressed glTF 2.0 (.glb) + settings JSON ready for `scripts/tracks/build_blender_track.py`.

Usage:
    uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt --with texture2ddecoder \
        python -P scripts/tracks/extract_erp_track.py \
        --erp ~/Downloads/Qiddiya_Track/qiddiya_V38/qiddiya.erp \
        --out-glb /tmp/qiddiya_raw.glb \
        --out-settings /tmp/qiddiya_raw.json
"""
import argparse
import collections
import io
import json
import os
import re
import struct
import subprocess
from compression import zstd

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
import texture2ddecoder

# Ego Engine GfxSurfaceRes format codes -> decoder name
EGO_TEX_DECODERS = {
    52: "bc1",   # BC1_UNORM
    54: "bc1",   # BC1_UNORM_SRGB
    55: "bc3",   # BC3_UNORM
    57: "bc3",   # BC3_UNORM_SRGB
    62: "bc3",   # BC3_UNORM (alpha)
    65: "bc5",   # BC5_UNORM (normals)
    70: "bc7",   # BC7_UNORM_SRGB
}

# Surface role classification by diffuse texture filename (lowercased)
# Verified against maintrack spline: v12s_asphalt_d covers 1315/1315 knots directly;
# v12s_roaddark_d covers 0/1315 maintrack knots (it is asphalt runoff & pit lane).
ROAD_KEYS = ("v12s_asphalt_d",)
RUNOFF_KEYS = ("v12s_roaddark_d", "v38g_asphalt", "asphalt_new", "roada_")
KERB_KEYS = ("v12s_kerb_d", "orange_kerbs")
GRASS_KEYS = ("ml_grass", "ov_grass_")
GRAVEL_KEYS = ("ml_sand", "ov_sand_")
WALL_OR_RUNOFF_KEYS = (
    "ml_conc", "concrete02", "wall01w", "wall01r", "wallcement", "wallcem",
    "wallpit", "pitwall", "tun_wall", "ov_concrete", "sidewalk_",
    "polished_concrete", "conca", "concg", "string_concretesta",
)
# Light sources by diffuse texture name -> (day, night) emissive strength, first match wins. The GLB carries them in
# each material's extras (`nightEmissive`); the game scales the emissive between the two with the sun
# (src/lib/render/venue-night-lighting.ts). Night values above ~1.1 bloom on High.
EMISSIVE_RULES: list[tuple[str, float, float]] = [
    ("v21s_flood", 0.7, 7.0),        # floodlight panels on the grandstand roofs
    ("musco", 0.7, 7.0),
    ("ceiling_light", 0.8, 4.0),     # tunnel ceiling lamps
    ("v22p_bulb", 0.6, 4.0),         # festoon bulbs over the paddock
    ("v22f_lantern", 0.5, 2.6),
    ("tun_violet", 0.9, 2.2),        # the tunnels' lit banners
    ("tun_cyan", 0.9, 2.2),
    ("v20b_led", 0.7, 1.2),          # the paddock buildings' lit canopies and facades: wide white surfaces, not strips
    ("neon_", 0.8, 2.0),
    ("ledwall", 0.8, 2.0),
    ("ledmesh", 0.6, 1.8),
    ("floor_led", 0.5, 1.6),
    ("_led", 0.8, 2.0),
    ("_scr_", 0.7, 1.7),             # video screens
    ("v13g_screens", 0.7, 1.7),
    ("v22b_ring", 0.4, 1.8),         # the Blade's lilac ring and fins
    ("v22b_fin", 0.4, 1.8),
    ("v20b_gfx_", 0.0, 0.9),         # the Blade deck's painted graphics, lit at night
    ("cats_eye", 0.0, 1.4),
    ("v36f_glass", 0.0, 1.0),        # the finished tower's window grid
]
# The towers' skins: a facade texture whose alpha leaves only rows of square panels (the mod draws them with an alpha
# test, so the sky shows through two thirds of every tower). Here each skin is baked solid, dark glass between the
# panels, and a share of the panels are lit windows at night.
TOWER_SKIN_KEYS = ("v36w_skin_",)
# The paint of the start grid: its boxes are where the cars stand (painted_grid.py, through the settings' gridBoxes)
GRID_BOX_KEYS = ("core_grid_boxes",)
# The painted lines on the road (its edges, the pit lane's): each keeps its own mesh, unsimplified (MESHOPT_SIMPLIFY_JS
# keys on these stems), so they stay on the asphalt they are painted on. Folded into the flat-colour scenery and
# simplified with it, a white edge line came out as wedges and spikes up to a metre off its place
LINE_KEYS = ("v12s_line_white", "_line_1_")
# Kerbs and painted lines lie a millimetre or two over the run-off and asphalt under them: drawn with this depth offset
# (glTF material extras `depthOffset`, read by src/lib/scene-builder.ts), they no longer fight those for depth and break
# up into jagged, cut-off pieces at a distance
PAINT_DEPTH_OFFSET = -2
TOWER_GLASS_RGB = (44, 58, 80)
# The glass between a tower's panels glows this share of its colour at night, so the towers stand against the sky as
# buildings and not only as rows of lit windows
TOWER_GLASS_NIGHT = 0.5
TOWER_WINDOWS_NIGHT = 1.5
# High-poly foliage / decorative fence textures trimmed for web/mobile budget
HEAVY_FOLIAGE_KEYS = ("palm_frond", "palm_bark", "palmleaf", "rpalmbark")
HEAVY_FENCE_KEYS = ("fence02", "palmleaf")
# Ultra-dense architectural slat/LED meshes whose sub-0.12 m^2 micro-triangles are invisible at racing speed
MICRO_DETAIL_SCENERY_KEYS = ("v20b_led", "v20b_pal", "v22f_led", "v22f_pal")

# Visually verified brand/sponsor/third-party texture substrings -> replaced with clean flat colour (no texture shipped).
# Reviewed against contact sheets of all 465 Qiddiya textures:
#   wall01r (Pirelli), wall01w (MSC), wallcement002 (stc), wallcement003 (Aramco),
#   wallcement004 & v20p_lenovo (Lenovo), pet3 (Petronas), cryptocom (Crypto.com),
#   front_512 (Radisson), awnimgs (Essington awnings), citycenter_lv_2_vd & cc_vdara (Google Earth Vegas),
#   commiss01 (photo of a real person), plus oka_sptile_sp_* / sponsor / stc_ / logo / bbrds.
BRAND_REPLACE_COLORS: list[tuple[str, tuple[float, float, float]]] = [
    ("wall01r", (0.28, 0.29, 0.31)),
    ("wall01w", (0.32, 0.33, 0.35)),
    ("wallcement002", (0.34, 0.35, 0.36)),
    ("wallcement003", (0.34, 0.35, 0.36)),
    ("wallcement004", (0.34, 0.35, 0.36)),
    ("v20p_lenovo", (0.12, 0.13, 0.16)),
    ("pet3", (0.12, 0.13, 0.16)),
    ("cryptocom", (0.10, 0.12, 0.16)),
    ("front_512", (0.42, 0.40, 0.38)),
    ("awnimgs", (0.22, 0.23, 0.26)),
    ("citycenter_lv", (0.48, 0.44, 0.39)),
    ("cc_vdara", (0.45, 0.43, 0.40)),
    ("commiss01", (0.30, 0.32, 0.34)),
    ("rest02", (0.44, 0.41, 0.38)),
    ("string_concretesta", (0.36, 0.36, 0.37)),
    ("string_tribuna02", (0.32, 0.33, 0.36)),
    ("cameratruck", (0.28, 0.29, 0.31)),
    ("pagoda", (0.40, 0.39, 0.38)),
    ("pitbox", (0.30, 0.31, 0.33)),
    ("oka_sptile_sp_", (0.10, 0.11, 0.14)),
    ("sponsor", (0.10, 0.11, 0.14)),
    ("stc_", (0.12, 0.12, 0.15)),
    ("logo", (0.12, 0.13, 0.16)),
    ("bbrds", (0.10, 0.11, 0.14)),
]


def match_brand_replacement(tex_name: str):
    tl = tex_name.lower()
    for key, rgb in BRAND_REPLACE_COLORS:
        if key in tl:
            return rgb
    return None


def read_erp_index(path: str):
    with open(path, "rb") as f:
        magic = f.read(4)
        if magic != b"ERPK":
            raise SystemExit(f"Not an ERPK archive: {magic!r}")
        ver, _pad, info_off, _info_size, res_off, _unk = struct.unpack("<IQQQQQ", f.read(44))
        if ver < 3:
            raise SystemExit(f"Unsupported ERPK version {ver} (expected >= 3)")
        f.seek(info_off)
        num_files, _num_temp = struct.unpack("<II", f.read(8))
        idx = {}
        for _ in range(num_files):
            f.read(4)  # entry_len
            id_len = struct.unpack("<H", f.read(2))[0]
            res_id = f.read(id_len).rstrip(b"\x00").decode("utf-8", "replace")
            res_type = f.read(16).rstrip(b"\x00").decode("utf-8", "replace")
            _unk_type, num_frags = struct.unpack("<IB", f.read(5))
            frags = [struct.unpack("<4sQQIBQ", f.read(33)) for _ in range(num_frags)]
            f.read(16)  # hash
            idx[res_id] = (res_type, frags)
    return res_off, idx


def read_frag(f, res_off: int, frag) -> bytes:
    _fname, foff, _fsize, _fflags, fcomp, fpacked = frag
    f.seek(res_off + foff)
    raw = f.read(fpacked)
    if fcomp == 0x11:
        return zstd.decompress(raw)
    return raw


def decode_surface_pil(f, res_off: int, frags):
    if len(frags) < 2:
        return None
    d0 = read_frag(f, res_off, frags[0])
    if len(d0) < 28:
        return None
    vals = struct.unpack_from("<7I", d0, 0)
    fmt, w, h = vals[2], vals[3], vals[4]
    dec = EGO_TEX_DECODERS.get(fmt)
    if not dec or w <= 0 or h <= 0 or w > 8192 or h > 8192:
        return None
    d1 = read_frag(f, res_off, frags[1])
    try:
        if dec == "bc1":
            rgba = texture2ddecoder.decode_bc1(d1, w, h)
        elif dec == "bc3":
            rgba = texture2ddecoder.decode_bc3(d1, w, h)
        elif dec == "bc5":
            rgba = texture2ddecoder.decode_bc5(d1, w, h)
        elif dec == "bc7":
            rgba = texture2ddecoder.decode_bc7(d1, w, h)
        else:
            return None
        return Image.frombytes("RGBA", (w, h), rgba, "raw", "BGRA")
    except Exception as exc:
        print(f"  [warn] texture decode failed ({w}x{h} fmt={fmt}): {exc}")
        return None


def encode_pil(im: Image.Image, max_dim: int, need_alpha: bool):
    w, h = im.size
    if max(w, h) > max_dim:
        scale = max_dim / max(w, h)
        nw = max(4, int(round(w * scale)))
        nh = max(4, int(round(h * scale)))
        im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    if need_alpha:
        im.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    im.convert("RGB").save(buf, format="JPEG", quality=86, optimize=True)
    return buf.getvalue(), "image/jpeg"


def srgb_to_linear_rgb(rgb01: tuple[float, float, float]) -> tuple[float, float, float]:
    out = []
    for c in rgb01:
        c = max(0.0, min(1.0, float(c)))
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2])


def parse_splines(ts_bytes: bytes):
    """Extract TrackSpaceSpline knot sequences from BXML payload."""
    spline_starts = [(m.start(), m.group(1).decode("utf-8", "replace"))
                     for m in re.finditer(rb"TrackSpaceSpline\x00name\x00([^\x00]+)\x00", ts_bytes)]
    out = {}
    for si, (start, name) in enumerate(spline_starts):
        end = spline_starts[si + 1][0] if si + 1 < len(spline_starts) else len(ts_bytes)
        chunk = ts_bytes[start:end]
        pts = [
            tuple(float(x) for x in m.group(1).decode().split(","))
            for m in re.finditer(rb"position\x00([-\d.eE]+,\s*[-\d.eE]+,\s*[-\d.eE]+)\x00", chunk)
        ]
        if pts:
            out[name] = np.array(pts, dtype=np.float32)
    return out


def classify_texture(tex_name: str) -> str:
    tl = tex_name.lower()
    if any(k in tl for k in ROAD_KEYS):
        return "Road"
    if any(k in tl for k in RUNOFF_KEYS):
        return "Runoff"
    if any(k in tl for k in KERB_KEYS):
        return "Kerb"
    if any(k in tl for k in GRASS_KEYS):
        return "Grass"
    if any(k in tl for k in GRAVEL_KEYS):
        return "Gravel"
    if any(k in tl for k in WALL_OR_RUNOFF_KEYS):
        return "WallOrRunoff"
    return "Scenery"


def emissive_gains(tex_name: str):
    """(day, night) emissive strength of a light-source texture, or None"""
    tl = tex_name.lower()
    for key, day, night in EMISSIVE_RULES:
        if key in tl:
            return (day, night)
    return None


def is_line_texture(tex_name: str) -> bool:
    tl = tex_name.lower()
    return any(k in tl for k in LINE_KEYS)


def is_neon_texture(tex_name: str) -> bool:
    return emissive_gains(tex_name) is not None


def painted_grid_boxes(pos: np.ndarray, ind: np.ndarray) -> list:
    """The grid boxes in a mesh of start-grid paint, each as its corner points. A box is a bracket about 2.7 m wide;
    the mesh also carries every box's side marker and its number, which are narrower one way"""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    tris = ind.reshape(-1, 3).astype(np.int64)
    _, welded = np.unique(np.round(pos / 0.02).astype(np.int64), axis=0, return_inverse=True)
    welded = welded.reshape(-1)
    wt = welded[tris]
    n = int(welded.max()) + 1
    rows = np.concatenate([wt[:, 0], wt[:, 1], wt[:, 2]])
    cols = np.concatenate([wt[:, 1], wt[:, 2], wt[:, 0]])
    count, label = connected_components(coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n)), directed=False)
    piece_of_tri = label[wt[:, 0]]
    boxes = []
    for piece in range(count):
        pts = pos[np.unique(tris[piece_of_tri == piece])]
        if len(pts) < 4:
            continue
        ext = pts.max(axis=0) - pts.min(axis=0)
        if 2.4 <= ext[0] <= 5.0 and 2.4 <= ext[2] <= 5.0:
            boxes.append([[round(float(v), 3) for v in p] for p in pts])
    return boxes


def bake_tower_skin(im: Image.Image, seed: int):
    """A tower skin as (solid facade, lit windows): dark glass where the alpha cut the facade away, and nearly half
    the panels lit, each at its own brightness"""
    from scipy import ndimage

    a = np.asarray(im.convert("RGBA"), dtype=np.float32)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    panel = alpha >= 115.0
    glass = np.array(TOWER_GLASS_RGB, dtype=np.float32)
    base = np.where(panel[:, :, None], rgb, glass)
    labels, count = ndimage.label(panel)
    rng = np.random.default_rng(seed)
    lit = np.where(rng.random(count + 1) < 0.45, rng.uniform(0.35, 1.0, count + 1), 0.0).astype(np.float32)
    lit[0] = 0.0
    glow = np.where(panel[:, :, None], rgb * lit[labels][:, :, None], glass * TOWER_GLASS_NIGHT)
    to_im = lambda arr: Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    return to_im(base), to_im(glow)


def build_glb(
    groups: dict,
    flat_vcol_groups: dict,
    flat_gains: dict,
    tex_blobs: dict,
    tex_meta: dict,
    main_spline: np.ndarray,
    pit_spline: np.ndarray | None,
    out_path: str,
):
    """Write an uncompressed glTF 2.0 (.glb) with merged meshes, PBR materials, and track helper nodes."""
    bin_chunks = bytearray()
    buffer_views = []
    accessors = []
    images = []
    textures = []
    materials = []
    meshes = []
    nodes = []

    def pad4():
        rem = len(bin_chunks) % 4
        if rem:
            bin_chunks.extend(b"\x00" * (4 - rem))

    def add_bv(data: bytes, target: int | None = None) -> int:
        pad4()
        off = len(bin_chunks)
        bin_chunks.extend(data)
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target is not None:
            bv["target"] = target
        buffer_views.append(bv)
        return len(buffer_views) - 1

    def add_acc(arr: np.ndarray, comp_type: int, acc_type: str, target: int | None = None, minmax: bool = False) -> int:
        bv_idx = add_bv(arr.tobytes(), target=target)
        acc = {
            "bufferView": bv_idx,
            "componentType": comp_type,
            "count": int(len(arr)),
            "type": acc_type,
        }
        if minmax and len(arr) > 0:
            acc["min"] = [float(x) for x in arr.min(axis=0)]
            acc["max"] = [float(x) for x in arr.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]

    tex_to_gltf_idx = {}
    for tex_key, (blob, mime) in tex_blobs.items():
        bv_idx = add_bv(blob)
        img_idx = len(images)
        images.append({"bufferView": bv_idx, "mimeType": mime, "name": tex_key})
        tex_idx = len(textures)
        textures.append({"sampler": 0, "source": img_idx})
        tex_to_gltf_idx[tex_key] = tex_idx

    mat_cache = {}

    def get_material(tex_key: str) -> int:
        if tex_key in mat_cache:
            return mat_cache[tex_key]
        meta = tex_meta.get(tex_key, {})
        is_mask = meta.get("alpha_mask", False)
        gains = meta.get("gains")
        is_neon = gains is not None
        flat_rgb = meta.get("flat_rgb")

        pbr = {"metallicFactor": 0.0, "roughnessFactor": 0.85}
        if flat_rgb is not None:
            lin = srgb_to_linear_rgb(flat_rgb)
            pbr["baseColorFactor"] = [lin[0], lin[1], lin[2], 1.0]
            pbr["roughnessFactor"] = 0.78
        elif tex_key in tex_to_gltf_idx:
            pbr["baseColorTexture"] = {"index": tex_to_gltf_idx[tex_key]}
            pbr["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
        else:
            pbr["baseColorFactor"] = [0.45, 0.45, 0.48, 1.0]

        mat = {
            "name": tex_key.replace(".tif", ""),
            "pbrMetallicRoughness": pbr,
        }
        if is_mask:
            mat["alphaMode"] = "MASK"
            mat["alphaCutoff"] = 0.45
            mat["doubleSided"] = True
        if meta.get("double_sided"):
            mat["doubleSided"] = True
        if meta.get("role") == "Kerb" or is_line_texture(tex_key):
            mat["extras"] = {"depthOffset": PAINT_DEPTH_OFFSET}
        if is_neon:
            if flat_rgb is not None:
                lin = srgb_to_linear_rgb(flat_rgb)
                mat["emissiveFactor"] = [lin[0], lin[1], lin[2]]
            else:
                mat["emissiveFactor"] = [1.0, 1.0, 1.0]
                glow_key = meta.get("emissive_tex", tex_key)
                if glow_key in tex_to_gltf_idx:
                    mat["emissiveTexture"] = {"index": tex_to_gltf_idx[glow_key]}
            mat.setdefault("extras", {})["nightEmissive"] = {"day": gains[0], "night": gains[1]}
            if not meta.get("keep_rough"):
                pbr["roughnessFactor"] = 0.35

        m_idx = len(materials)
        materials.append(mat)
        mat_cache[tex_key] = m_idx
        return m_idx

    root_children = []
    role_counter = collections.Counter()

    # 1. Textured / role-keyed merged meshes
    for (role, tex_key), parts in sorted(groups.items()):
        if not parts:
            continue
        pos_list, nrm_list, uv_list, idx_list = [], [], [], []
        v_off = 0
        for pos, nrm, uv, ind in parts:
            pos_list.append(pos)
            nrm_list.append(nrm)
            uv_list.append(uv)
            idx_list.append(ind.astype(np.uint32) + v_off)
            v_off += len(pos)

        all_pos = np.ascontiguousarray(np.concatenate(pos_list, axis=0), dtype=np.float32)
        all_nrm = np.ascontiguousarray(np.concatenate(nrm_list, axis=0), dtype=np.float32)
        all_uv = np.ascontiguousarray(np.concatenate(uv_list, axis=0), dtype=np.float32)
        all_idx = np.ascontiguousarray(np.concatenate(idx_list, axis=0), dtype=np.uint32)

        if len(all_pos) == 0 or len(all_idx) == 0:
            continue

        lens = np.linalg.norm(all_nrm, axis=1, keepdims=True)
        bad = lens[:, 0] < 1e-4
        all_nrm[bad] = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        lens[bad] = 1.0
        all_nrm /= lens

        pos_acc = add_acc(all_pos, 5126, "VEC3", target=34962, minmax=True)
        nrm_acc = add_acc(all_nrm, 5126, "VEC3", target=34962)
        uv_acc = add_acc(all_uv, 5126, "VEC2", target=34962)
        if len(all_pos) <= 65535:
            ind_acc = add_acc(all_idx.astype(np.uint16), 5123, "SCALAR", target=34963)
        else:
            ind_acc = add_acc(all_idx, 5125, "SCALAR", target=34963)

        mat_idx = get_material(tex_key)
        role_counter[role] += 1
        stem = re.sub(r"[^a-zA-Z0-9_]+", "_", tex_key.replace(".tif", "")).strip("_")[:36]
        node_name = f"{role}_{role_counter[role]:03d}_{stem}"

        mesh_idx = len(meshes)
        meshes.append({
            "name": node_name,
            "primitives": [{
                "attributes": {
                    "POSITION": pos_acc,
                    "NORMAL": nrm_acc,
                    "TEXCOORD_0": uv_acc,
                },
                "indices": ind_acc,
                "material": mat_idx,
                "mode": 4,
            }],
        })
        node_idx = len(nodes)
        nodes.append({"name": node_name, "mesh": mesh_idx})
        root_children.append(node_idx)

    # 2. Merged vertex-coloured flat-colour Scenery meshes (opaque + neon) — collapses 100+ flat materials into 2 draws
    for (role, kind), parts in sorted(flat_vcol_groups.items()):
        if not parts:
            continue
        pos_list, nrm_list, col_list, idx_list = [], [], [], []
        v_off = 0
        for pos, nrm, rgb_lin, ind in parts:
            pos_list.append(pos)
            nrm_list.append(nrm)
            c = np.empty((len(pos), 3), dtype=np.float32)
            c[:, 0], c[:, 1], c[:, 2] = rgb_lin[0], rgb_lin[1], rgb_lin[2]
            col_list.append(c)
            idx_list.append(ind.astype(np.uint32) + v_off)
            v_off += len(pos)

        all_pos = np.ascontiguousarray(np.concatenate(pos_list, axis=0), dtype=np.float32)
        all_nrm = np.ascontiguousarray(np.concatenate(nrm_list, axis=0), dtype=np.float32)
        all_col = np.ascontiguousarray(np.concatenate(col_list, axis=0), dtype=np.float32)
        all_idx = np.ascontiguousarray(np.concatenate(idx_list, axis=0), dtype=np.uint32)
        if len(all_pos) == 0 or len(all_idx) == 0:
            continue

        lens = np.linalg.norm(all_nrm, axis=1, keepdims=True)
        bad = lens[:, 0] < 1e-4
        all_nrm[bad] = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        lens[bad] = 1.0
        all_nrm /= lens

        pos_acc = add_acc(all_pos, 5126, "VEC3", target=34962, minmax=True)
        nrm_acc = add_acc(all_nrm, 5126, "VEC3", target=34962)
        col_acc = add_acc(all_col, 5126, "VEC3", target=34962)
        if len(all_pos) <= 65535:
            ind_acc = add_acc(all_idx.astype(np.uint16), 5123, "SCALAR", target=34963)
        else:
            ind_acc = add_acc(all_idx, 5125, "SCALAR", target=34963)

        is_neon = kind.startswith("flat_neon")
        mat = {
            "name": f"{role}_{kind}",
            "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.35 if is_neon else 0.78,
            },
        }
        if is_neon:
            # The vertex colours carry each strip's hue: the game multiplies the emissive by them (`vertexColor`),
            # so one draw glows in every colour
            day, night = flat_gains[kind]
            mat["emissiveFactor"] = [1.0, 1.0, 1.0]
            mat["extras"] = {"nightEmissive": {"day": day, "night": night, "vertexColor": True}}
        mat_idx = len(materials)
        materials.append(mat)

        node_name = f"{role}_000_{kind}"
        mesh_idx = len(meshes)
        meshes.append({
            "name": node_name,
            "primitives": [{
                "attributes": {
                    "POSITION": pos_acc,
                    "NORMAL": nrm_acc,
                    "COLOR_0": col_acc,
                },
                "indices": ind_acc,
                "material": mat_idx,
                "mode": 4,
            }],
        })
        node_idx = len(nodes)
        nodes.append({"name": node_name, "mesh": mesh_idx})
        root_children.append(node_idx)

    # 3. Helper nodes: Track_Centreline, Track_PitLane, Track_Start
    def add_line_node(name: str, pts: np.ndarray, closed: bool):
        pts32 = np.ascontiguousarray(pts, dtype=np.float32)
        n = len(pts32)
        edges = [[i, i + 1] for i in range(n - 1)]
        if closed:
            edges.append([n - 1, 0])
        edge_arr = np.ascontiguousarray(np.array(edges, dtype=np.uint32).reshape(-1))
        p_acc = add_acc(pts32, 5126, "VEC3", target=34962, minmax=True)
        e_acc = add_acc(edge_arr, 5125, "SCALAR", target=34963)
        m_idx = len(meshes)
        meshes.append({
            "name": name,
            "primitives": [{
                "attributes": {"POSITION": p_acc},
                "indices": e_acc,
                "mode": 1,
            }],
        })
        n_idx = len(nodes)
        nodes.append({"name": name, "mesh": m_idx})
        root_children.append(n_idx)

    add_line_node("Track_Centreline", main_spline, closed=True)
    if pit_spline is not None and len(pit_spline) >= 4:
        add_line_node("Track_PitLane", pit_spline, closed=False)

    p0 = main_spline[0].astype(np.float64)
    p1 = main_spline[min(3, len(main_spline) - 1)].astype(np.float64)
    fwd = p1 - p0
    fwd[1] = 0.0
    fwd /= max(1e-6, np.linalg.norm(fwd))
    up = np.array([0.0, 1.0, 0.0])
    right = np.cross(fwd, up)
    right /= max(1e-6, np.linalg.norm(right))
    mat4 = [
        float(right[0]), float(right[1]), float(right[2]), 0.0,
        float(fwd[0]),   float(fwd[1]),   float(fwd[2]),   0.0,
        float(up[0]),    float(up[1]),    float(up[2]),    0.0,
        float(p0[0]),    float(p0[1]),    float(p0[2]),    1.0,
    ]
    start_idx = len(nodes)
    nodes.append({"name": "Track_Start", "matrix": mat4})
    root_children.append(start_idx)

    pad4()
    gltf = {
        "asset": {"version": "2.0", "generator": "LibreCorsa extract_erp_track.py"},
        "scene": 0,
        "scenes": [{"nodes": root_children}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "textures": textures,
        "images": images,
        "samplers": samplers,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(bin_chunks)}],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "

    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_chunks)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as out:
        out.write(struct.pack("<4sII", b"glTF", 2, total_len))
        out.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        out.write(json_bytes)
        out.write(struct.pack("<II", len(bin_chunks), 0x004E4942))
        out.write(bin_chunks)

    return len(meshes), len(materials), len(images), total_len


MESHOPT_SIMPLIFY_JS = r"""
import { NodeIO } from "@gltf-transform/core";
import { weld, prune } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

await MeshoptSimplifier.ready;
const glbPath = process.argv[1];
const io = new NodeIO();
const doc = await io.read(glbPath);

// Weld identical vertices (position + normal + UV + color match in gltf-transform weld, preserving seams).
await doc.transform(weld());

let beforeTris = 0;
let afterTris = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  const name = mesh.getName() || "";
  let mTris = 0;
  for (const p of mesh.listPrimitives()) {
    if (p.getMode() !== 4) continue;
    const idx = p.getIndices();
    mTris += idx ? idx.getCount() / 3 : (p.getAttribute("POSITION")?.getCount() ?? 0) / 3;
  }
  beforeTris += mTris;

  // The road's painted lines (LINE_KEYS) lie a few mm over the asphalt: any simplification lifts or drops them
  const isExact = name.startsWith("Road") || name.startsWith("Kerb") || name.startsWith("PitLane") || name.startsWith("Track_") ||
    /v12s_line_white|_line_1(_|$)/.test(name);
  if (isExact || mTris < 1200) {
    afterTris += mTris;
    continue;
  }

  // ErrorAbsolute uses real world-space metres instead of bounding-box fraction (merged meshes span ~2 km).
  let ratio = 0.40;
  let errorM = 0.30;
  let flags = ["ErrorAbsolute"];
  if (/flat_neon|neon_|_led|ledwall|ledmesh|tun_(cyan|violet)|ceiling_light|flood|bulb|lantern/.test(name)) {
    // Light strips are thin tubes and ribbons: a coarse error folds them flat or tears them
    ratio = 0.5;
    errorM = 0.05;
  } else if (name.startsWith("Scenery")) {
    if (name.includes("flat_opaque")) {
      // Every flat-coloured building, stand and structure in one mesh: at 1.6 m the walls of the smaller buildings
      // folded away and left their windows hanging in the air
      ratio = 0.3;
      errorM = 0.12;
    } else if (name.includes("palm")) {
      ratio = 0.16;
      errorM = 0.70;
    } else if (mTris > 40000) {
      ratio = 0.14;
      errorM = 1.15;
    } else if (mTris > 10000) {
      ratio = 0.20;
      errorM = 0.65;
    } else {
      ratio = 0.34;
      errorM = 0.30;
    }
  } else if (name.startsWith("Grass") || name.startsWith("Gravel")) {
    ratio = 0.25;
    // Ground beside the road: its edges meet the kerbs and run-off, which a coarse error turned into jagged teeth
    errorM = 0.05;
    flags = ["ErrorAbsolute", "LockBorder"];
  } else if (name.startsWith("Runoff") || name.startsWith("Wall")) {
    ratio = 0.28;
    errorM = 0.05;
    flags = ["ErrorAbsolute", "LockBorder"];
  }

  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const posAcc = prim.getAttribute("POSITION");
    const idxAcc = prim.getIndices();
    if (!posAcc || !idxAcc) continue;
    const posArr = posAcc.getArray();
    const rawIdx = idxAcc.getArray();
    const u32Idx = rawIdx instanceof Uint32Array ? rawIdx : Uint32Array.from(rawIdx);
    const targetCount = Math.max(90, Math.floor((u32Idx.length / 3) * ratio) * 3);
    if (targetCount >= u32Idx.length) continue;

    // Use simplifyWithAttributes when TEXCOORD_0 or NORMAL exists so UV seams & hard shading are preserved!
    const nrmAcc = prim.getAttribute("NORMAL");
    const uvAcc = prim.getAttribute("TEXCOORD_0");
    let newIdx;
    if (nrmAcc || uvAcc) {
      const nv = posAcc.getCount();
      const stride = (nrmAcc ? 3 : 0) + (uvAcc ? 2 : 0);
      const attrs = new Float32Array(nv * stride);
      const weights = [];
      let off = 0;
      if (nrmAcc) {
        const na = nrmAcc.getArray();
        for (let i = 0; i < nv; i++) {
          attrs[i * stride + off] = na[i * 3];
          attrs[i * stride + off + 1] = na[i * 3 + 1];
          attrs[i * stride + off + 2] = na[i * 3 + 2];
        }
        weights.push(0.5, 0.5, 0.5);
        off += 3;
      }
      if (uvAcc) {
        const ua = uvAcc.getArray();
        for (let i = 0; i < nv; i++) {
          attrs[i * stride + off] = ua[i * 2];
          attrs[i * stride + off + 1] = ua[i * 2 + 1];
        }
        weights.push(0.5, 0.5);
      }
      [newIdx] = MeshoptSimplifier.simplifyWithAttributes(
        u32Idx, posArr, 3, attrs, stride, weights, null, targetCount, errorM, flags
      );
    } else {
      [newIdx] = MeshoptSimplifier.simplify(u32Idx, posArr, 3, targetCount, errorM, flags);
    }

    if (newIdx.length >= 3 && newIdx.length < u32Idx.length) {
      // Compact vertices referenced by newIdx so unreferenced verts don't bloat the GLB!
      const [remap, uniqueCount] = MeshoptSimplifier.compactMesh(newIdx);
      for (const sem of prim.listSemantics()) {
        const acc = prim.getAttribute(sem);
        const es = acc.getElementSize();
        const src = acc.getArray();
        const dst = new src.constructor(uniqueCount * es);
        for (let i = 0; i < remap.length; i++) {
          const r = remap[i];
          if (r !== 0xffffffff) {
            for (let k = 0; k < es; k++) dst[r * es + k] = src[i * es + k];
          }
        }
        acc.setArray(dst);
      }
      const outIdx = uniqueCount <= 65535 ? Uint16Array.from(newIdx) : newIdx;
      idxAcc.setArray(outIdx);
    }
  }

  let mAfter = 0;
  for (const p of mesh.listPrimitives()) {
    if (p.getMode() !== 4) continue;
    const idx = p.getIndices();
    mAfter += idx ? idx.getCount() / 3 : 0;
  }
  afterTris += mAfter;
}

await doc.transform(prune({ keepLeaves: true }));
await io.write(glbPath, doc);
console.log(`  meshopt simplify: ${Math.round(beforeTris).toLocaleString()} -> ${Math.round(afterTris).toLocaleString()} tris`);
"""


def run_meshopt_simplify(glb_path: str):
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    r = subprocess.run(
        ["node", "--input-type=module", "-e", MESHOPT_SIMPLIFY_JS, glb_path],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print("  [warn] meshopt simplify failed:", r.stderr.strip())
    else:
        print(r.stdout.strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n")[0])
    ap.add_argument("--erp", required=True, help="Path to qiddiya.erp")
    ap.add_argument("--out-glb", required=True, help="Output uncompressed GLB for build_blender_track.py")
    ap.add_argument("--out-settings", required=True, help="Output settings JSON for build_blender_track.py")
    ap.add_argument("--track", default="qiddiya", help="Track code inside the ERP archive (default: qiddiya)")
    ap.add_argument("--mat-prefix", default="qdy_mat_", help="Material name prefix for track-owned meshes")
    ap.add_argument("--max-road-tex", type=int, default=1024, help="Max texture dimension for road/kerb/key surfaces")
    ap.add_argument("--max-scenery-tex", type=int, default=512, help="Max texture dimension for scenery")
    ap.add_argument("--foliage-dist", type=float, default=18.0, help="Drop high-poly palm meshes farther than this (m)")
    ap.add_argument("--scenery-max-dist", type=float, default=200.0, help="Drop small non-landmark scenery farther than this (m)")
    ap.add_argument("--tiny-scenery-min-tris", type=int, default=120, help="Merge tiny flat/distant scenery below this threshold")
    ap.add_argument("--skip-fence02", action=argparse.BooleanOptionalAction, default=True, help="Skip 818k-tri fence02 geometry (keep fence03)")
    ap.add_argument("--simplify", action=argparse.BooleanOptionalAction, default=True, help="Run UV/normal-safe meshoptimizer QEM simplify on non-road meshes")
    args = ap.parse_args()

    erp_path = os.path.expanduser(args.erp)
    track_tag = f"tracks/{args.track}/"
    print(f"Reading ERPK v3 index: {erp_path}")
    res_off, idx = read_erp_index(erp_path)
    print(f"  {len(idx):,} resources indexed")

    with open(erp_path, "rb") as f:
        # 1. Splines
        ts_id = f"eaid://environment_package/{track_tag}ai/{args.track}_ai_track.trackspacespline"
        splines = parse_splines(read_frag(f, res_off, idx[ts_id][1][0]))
        main_spline = splines["maintrack"]
        pit_spline = splines.get("pit_1")
        print(f"  maintrack: {len(main_spline)} knots, pit_1: {len(pit_spline) if pit_spline is not None else 0} knots")
        spline_tree = cKDTree(main_spline[:, [0, 2]])
        pit_tree = cKDTree(pit_spline[:, [0, 2]]) if pit_spline is not None and len(pit_spline) > 0 else None

        # 2. Map track-owned materials -> (shader, diffuse_uri, diffuse_name)
        mat_info = {}
        for rid, (rt, frags) in idx.items():
            if rt == "GfxMaterialRes" and args.mat_prefix in rid:
                d = read_frag(f, res_off, frags[0])
                eaids = [e.decode("utf-8", "replace") for e in re.findall(rb"eaid://[^\x00]+", d)]
                shader = eaids[0].split("/")[-1] if eaids else ""
                tex_uris = [e for e in eaids[1:] if e.endswith(".tif")]
                diff_uri = tex_uris[0] if tex_uris else ""
                diff_name = diff_uri.split("/")[-1] if diff_uri else "untextured"
                mat_info[rid.split("/")[-1]] = (shader, diff_uri, diff_name)
        print(f"  {len(mat_info)} {args.mat_prefix}* materials parsed")

        # 3. Pre-decode all referenced track-owned diffuse textures so we can detect flat solid colours
        #    and collapse 100+ flat-colour Scenery materials into 2 vertex-coloured draw calls!
        raw_meshes = []
        tex_uris_needed = {}
        tex_meta = {}
        skipped_fence = skipped_foliage = skipped_far = 0
        grid_boxes = []

        for rid, (rt, frags) in idx.items():
            if rt != "GfxMatBindRes" or track_tag not in rid:
                continue
            d = read_frag(f, res_off, frags[0])
            mats = [m.decode().split("/")[-1] for m in re.findall(rb"eaid://[^\x00]+\.material", d)]
            if not mats or not mats[0].startswith(args.mat_prefix):
                continue

            shader, diff_uri, diff_name = mat_info.get(mats[0], ("", "", "untextured"))
            dl = diff_name.lower()

            if args.skip_fence02 and any(k in dl for k in HEAVY_FENCE_KEYS):
                skipped_fence += 1
                continue

            stem = rid.split("/")[-1].split(".emb")[0]
            vb0_k = f"eaid://environment_package/{track_tag}objects/idf/{stem}.idf?lod=all&vb=0"
            vb1_k = f"eaid://environment_package/{track_tag}objects/idf/{stem}.idf?lod=all&vb=1"
            vb3_k = f"eaid://environment_package/{track_tag}objects/idf/{stem}.idf?lod=all&vb=3"
            ib0_k = f"eaid://environment_package/{track_tag}objects/idf/{stem}.idf?lod=all&ib=0"
            if vb0_k not in idx or ib0_k not in idx:
                continue

            vb0_b = read_frag(f, res_off, idx[vb0_k][1][1])
            pos = np.frombuffer(vb0_b, dtype=np.float32).reshape(-1, 3).copy()
            nv = len(pos)
            if nv == 0:
                continue

            role = classify_texture(diff_name)
            brand_rgb = match_brand_replacement(diff_name)
            is_heavy_foliage = any(k in dl for k in HEAVY_FOLIAGE_KEYS)

            sample_pts = pos[::max(1, nv // 16), [0, 2]]
            min_dist = float(spline_tree.query(sample_pts)[0].min())

            if is_heavy_foliage and min_dist > args.foliage_dist:
                skipped_foliage += 1
                continue

            if role == "Scenery" and min_dist > args.scenery_max_dist:
                extent = float(np.linalg.norm(pos.max(axis=0) - pos.min(axis=0)))
                if extent < 45.0:
                    skipped_far += 1
                    continue

            ib_hdr = read_frag(f, res_off, idx[ib0_k][1][0])
            ib_stride, ib_cnt = struct.unpack_from("<II", ib_hdr, 4)
            ib_b = read_frag(f, res_off, idx[ib0_k][1][1])
            ind_dtype = np.uint16 if ib_stride == 2 else np.uint32
            ind = np.frombuffer(ib_b, dtype=ind_dtype)[:ib_cnt].astype(np.uint32).copy()
            n_tri = len(ind) // 3
            if n_tri == 0:
                continue
            ind = ind[: n_tri * 3]
            if ind.max() >= nv:
                continue
            if any(k in dl for k in GRID_BOX_KEYS):
                grid_boxes += painted_grid_boxes(pos, ind)

            if vb1_k in idx:
                vb1_b = read_frag(f, res_off, idx[vb1_k][1][1])
                nrm = np.frombuffer(vb1_b, dtype=np.float16).reshape(-1, 4)[:nv, :3].astype(np.float32)
            else:
                nrm = np.tile(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), (nv, 1))

            if vb3_k in idx:
                vb3_b = read_frag(f, res_off, idx[vb3_k][1][1])
                uv = np.frombuffer(vb3_b, dtype=np.float16).reshape(-1, 4)[:nv, :2].astype(np.float32)
                uv = np.nan_to_num(uv, nan=0.0, posinf=0.0, neginf=0.0)
            else:
                uv = np.zeros((nv, 2), dtype=np.float32)

            is_tower = any(k in dl for k in TOWER_SKIN_KEYS)
            is_mask = ("mask" in shader.lower() or "alpha" in shader.lower()) and not is_tower
            gains = (0.0, TOWER_WINDOWS_NIGHT) if is_tower else emissive_gains(diff_name)

            # Drop invisible micro-sliver triangles on ultra-dense architectural slat/LED & flat-neon chunks
            # (preserves all larger faces, UVs and hard normals untouched — zero texture smearing).
            if role == "Scenery" and any(k in dl for k in MICRO_DETAIL_SCENERY_KEYS):
                tris = ind.reshape(-1, 3)
                areas = 0.5 * np.linalg.norm(
                    np.cross(pos[tris[:, 1]] - pos[tris[:, 0]], pos[tris[:, 2]] - pos[tris[:, 0]]), axis=1
                )
                keep = areas >= 0.14
                if not keep.any():
                    continue
                ind = tris[keep].reshape(-1)
            # Neon and LED strips keep every triangle: they are thin tubes and ribbons, all small faces, and an
            # area cut removed whole strips

            if brand_rgb is not None:
                # Visually reviewed brand/third-party texture -> clean neutral colour, no texture exported
                tex_key = f"__clean_{int(brand_rgb[0]*100)}_{int(brand_rgb[1]*100)}_{int(brand_rgb[2]*100)}__"
                tex_meta[tex_key] = {"alpha_mask": False, "gains": None, "flat_rgb": brand_rgb, "role": role}
            else:
                tex_key = diff_name
                if tex_key not in tex_meta:
                    tex_meta[tex_key] = {"alpha_mask": is_mask, "gains": gains, "flat_rgb": None, "role": role}
                    if is_tower:
                        tex_meta[tex_key].update({"tower": True, "double_sided": True, "keep_rough": True})
                elif is_mask:
                    tex_meta[tex_key]["alpha_mask"] = True
                if diff_uri and tex_key not in tex_uris_needed:
                    tex_uris_needed[tex_key] = diff_uri + ".image"

            raw_meshes.append((role, tex_key, dl, min_dist, pos, nrm, uv, ind))

        # 4. Decode track-owned textures; detect flat solid-colour Scenery textures (std < 12)
        #    and tiny low-impact Scenery textures (< tiny_scenery_min_tris total) -> vertex-coloured!
        scenery_tex_tris = collections.Counter()
        for role, tex_key, _dl, _md, _pos, _nrm, _uv, ind in raw_meshes:
            if role == "Scenery":
                scenery_tex_tris[tex_key] += len(ind) // 3

        tex_blobs = {}
        flat_vcol_rgb = {}  # tex_key -> linear RGB for Scenery vertex-colour merging
        decoded = collapsed_flat = collapsed_tiny = 0

        for tex_key, img_uri in tex_uris_needed.items():
            if track_tag not in img_uri or img_uri not in idx:
                continue
            meta = tex_meta[tex_key]
            im = decode_surface_pil(f, res_off, idx[img_uri][1])
            if im is None:
                continue
            if meta.get("tower"):
                base, glow = bake_tower_skin(im, seed=len(tex_blobs))
                tex_blobs[tex_key] = encode_pil(base, max_dim=args.max_scenery_tex, need_alpha=False)
                tex_blobs[tex_key + "#windows"] = encode_pil(glow, max_dim=args.max_scenery_tex, need_alpha=False)
                meta["emissive_tex"] = tex_key + "#windows"
                decoded += 2
                continue
            rgb_arr = np.asarray(im.convert("RGB"), dtype=np.float32)
            max_std = float(rgb_arr.std(axis=(0, 1)).max())
            mean_rgb01 = tuple(float(x) / 255.0 for x in rgb_arr.mean(axis=(0, 1)))

            if meta["role"] == "Scenery" and not meta["alpha_mask"] and max_std < 12.0 and not is_line_texture(tex_key):
                flat_vcol_rgb[tex_key] = srgb_to_linear_rgb(mean_rgb01)
                collapsed_flat += 1
                continue
            # A light source with a picture on it (the tunnels' banners, the screens) keeps it however few triangles
            # it has: its mean colour would be a dark smear
            if (meta["role"] == "Scenery" and not meta["alpha_mask"] and meta["gains"] is None
                    and scenery_tex_tris[tex_key] < args.tiny_scenery_min_tris and not is_line_texture(tex_key)):
                flat_vcol_rgb[tex_key] = srgb_to_linear_rgb(mean_rgb01)
                collapsed_tiny += 1
                continue

            max_dim = args.max_road_tex if meta["role"] in ("Road", "Kerb") else args.max_scenery_tex
            tex_blobs[tex_key] = encode_pil(im, max_dim=max_dim, need_alpha=meta["alpha_mask"])
            decoded += 1

        # Also fold brand-replaced Scenery into flat_vcol_rgb so they share the single Scenery_000_flat_opaque draw
        for tex_key, meta in tex_meta.items():
            if meta.get("flat_rgb") is not None and meta["role"] == "Scenery":
                flat_vcol_rgb[tex_key] = srgb_to_linear_rgb(meta["flat_rgb"])

        print(f"  textures: {decoded} kept, {collapsed_flat} flat-colour merged, {collapsed_tiny} tiny scenery merged")

    # 5. Partition raw meshes into final surface groups
    groups = collections.defaultdict(list)
    flat_vcol_groups = collections.defaultdict(list)
    # One merged glowing mesh per emissive strength (neon strips, ceiling lamps ...): its kind -> (day, night)
    flat_gains: dict[str, tuple[float, float]] = {}
    kept_tris = 0

    for role, tex_key, dl, _min_dist, pos, nrm, uv, ind in raw_meshes:
        kept_tris += len(ind) // 3
        if role == "Scenery" and tex_key in flat_vcol_rgb:
            gains = tex_meta[tex_key].get("gains")
            kind = "flat_opaque"
            if gains is not None:
                kind = next((k for k, g in flat_gains.items() if g == gains), f"flat_neon{len(flat_gains) + 1}")
                flat_gains[kind] = gains
            flat_vcol_groups[("Scenery", kind)].append((pos, nrm, flat_vcol_rgb[tex_key], ind))
        elif role == "WallOrRunoff":
            tris = ind.reshape(-1, 3)
            v0, v1, v2 = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
            fn = np.cross(v1 - v0, v2 - v0)
            ny = fn[:, 1] / np.maximum(np.linalg.norm(fn, axis=1), 1e-8)
            up_mask = ny > 0.55
            down_mask = ny < -0.55
            wall_mask = (~up_mask) & (~down_mask)
            if wall_mask.any():
                groups[("Wall", tex_key)].append((pos, nrm, uv, tris[wall_mask].reshape(-1)))
            if up_mask.any():
                groups[("Runoff", tex_key)].append((pos, nrm, uv, tris[up_mask].reshape(-1)))
            if down_mask.any():
                groups[("Scenery", tex_key)].append((pos, nrm, uv, tris[down_mask].reshape(-1)))
        elif role == "Runoff":
            tris = ind.reshape(-1, 3)
            v0, v1, v2 = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
            fn = np.cross(v1 - v0, v2 - v0)
            ny = fn[:, 1] / np.maximum(np.linalg.norm(fn, axis=1), 1e-8)
            up_tris = tris[ny > 0.55]
            other_tris = tris[ny <= 0.55]
            if len(other_tris):
                groups[("Scenery", tex_key)].append((pos, nrm, uv, other_tris.reshape(-1)))
            if len(up_tris):
                if pit_tree is not None and "v12s_roaddark_d" in dl:
                    centroids = pos[up_tris].mean(axis=1)
                    pdists, _ = pit_tree.query(centroids[:, [0, 2]])
                    mdists, _ = spline_tree.query(centroids[:, [0, 2]])
                    pit_mask = (pdists < 12.0) & (pdists < mdists)
                    if pit_mask.any():
                        groups[("PitLane", tex_key)].append((pos, nrm, uv, up_tris[pit_mask].reshape(-1)))
                    if (~pit_mask).any():
                        groups[("Runoff", tex_key)].append((pos, nrm, uv, up_tris[~pit_mask].reshape(-1)))
                else:
                    groups[("Runoff", tex_key)].append((pos, nrm, uv, up_tris.reshape(-1)))
        else:
            groups[(role, tex_key)].append((pos, nrm, uv, ind))

    print(f"  kept {len(raw_meshes):,} ERP chunks ({kept_tris:,} raw tris) -> "
          f"{len(groups) + len(flat_vcol_groups)} merged draw groups "
          f"[skipped fence02={skipped_fence}, distant palms={skipped_foliage}, far scenery={skipped_far}]")

    # 6. Write uncompressed GLB, then run seam-safe meshoptimizer QEM simplify on non-road meshes
    n_mesh, n_mat, n_img, byte_len = build_glb(
        groups, flat_vcol_groups, flat_gains, tex_blobs, tex_meta, main_spline, pit_spline, args.out_glb
    )
    lit = sorted(k for k, m in tex_meta.items() if m.get("gains") is not None)
    print(f"  {len(lit)} light-source materials ({len(flat_gains)} merged glow meshes: {flat_gains})")
    print(f"Wrote {args.out_glb}: {byte_len / 1e6:.1f} MB ({n_mesh} meshes, {n_mat} materials, {n_img} images)")
    if args.simplify:
        run_meshopt_simplify(args.out_glb)

    # 7. Write settings JSON for build_blender_track.py
    # The credit the index already has for this circuit wins: a rebuild must not put an older one back
    credit = {
        "title": "Qiddiya Speed Park",
        "author": "Maxim555 (circuit) & Zhenix (scenery)",
        "authorUrl": "https://www.overtake.gg/members/maxim555king.1524527/",
        "url": "https://www.overtake.gg/members/maxim555king.1524527/",
        "short": None,
        "license": "Used with permission",
        "licenseUrl": "https://www.overtake.gg/members/maxim555king.1524527/",
        "note": "Circuit by Maxim555, scenery by Zhenix (Quaresma) from his F1 25 version. Both used with permission.",
    }
    index_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                              "public", "tracks", "index.json")
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as jf:
            listed = next((e for e in json.load(jf) if e.get("id") == args.track), None)
        if listed and listed.get("credit"):
            credit = listed["credit"]
            print(f"  credit from index.json: {credit.get('author')} ({credit.get('license')})")
    settings = {
        "name": "Qiddiya Speed Park",
        "layout": "Grand Prix layout",
        "country": "Saudi Arabia",
        "city": "Qiddiya, Riyadh",
        "baseAltitudeM": 650,
        "pitboxes": 22,
        # The Blade's crest is sharp at its outer edge: a smoother profile (crest radius 150 m) cut it by up to half a metre
        # and the cars drove under the drawn road
        "crestMinRadiusM": 20,
        "profileSmoothSamples": 0.6,
        # T19, T13-T15 and the Blade bank quickly: the road surface is cut finer there (build_track.subdivide_twisted_road)
        "roadTwistM": 0.005,
        # T13 (the hairpin) and T19 (banked 10 degrees) are tight and curve vertically: built from 5 m rows on straight
        # chords, the collider broke its slope at every row and sagged off the road height the wheels read, and the cars
        # jumped (build_track.upsample_rows). Two rows a sample: T19's bounce 0.77 -> 0.10 g rms on an autopilot lap
        # (four: 0.05, but 4 MB more of uncompressed collider in the GLB)
        "colliderRowsPerSample": 2,
        "turns_override": [[740, "The Blade"]],
        "description": "High-speed desert circuit featuring the 55 m elevated Turn 1 Blade hairpin and neon tunnel sections.",
        "credit": credit,
        # A night race: sessions start at night until the player picks a time of day (track-registry.ts)
        "defaultTimeOfDay": "night",
        # Floodlights and tunnel light at night (scripts/tracks/night_lighting.py places them, build_blender_track.py
        # writes them into the track data, src/lib/render/venue-night-lighting.ts draws them)
        "nightLighting": {
            "lampSpacingM": 46,
            "lampHeightM": 13,
            "tunnelColors": ["#39d8ff", "#8f63ff"],
        },
    }
    if grid_boxes:
        # The start grid stands on the painted boxes (scripts/tracks/painted_grid.py)
        settings["gridBoxes"] = grid_boxes
        print(f"  {len(grid_boxes)} painted grid boxes")
    os.makedirs(os.path.dirname(os.path.abspath(args.out_settings)), exist_ok=True)
    with open(args.out_settings, "w", encoding="utf-8") as sf:
        json.dump(settings, sf, indent=2)
        sf.write("\n")
    print(f"Wrote {args.out_settings}")


if __name__ == "__main__":
    main()
