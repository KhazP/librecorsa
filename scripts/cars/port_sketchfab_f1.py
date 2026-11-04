#!/usr/bin/env python3
"""
Port a Sketchfab F1 car GLB (Dave Love / @Tyler_Dave export layout) into the
LibreCorsa generic ported-car rig format consumed by `src/lib/ported-car-model.ts`.

Run with:
  uv run --python 3.14 --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
    python -P scripts/cars/port_sketchfab_f1.py <src.glb> public/cars/<id>/model/<id>.glb [options]

Dependencies: Python stdlib + numpy + Pillow (PIL).
"""

import argparse
import io
import json
import math
import os
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image


# ---------------------------------------------------------------------------
# Per-car presets (auto-selected by car id / filename, overridable via CLI)
# ---------------------------------------------------------------------------
CAR_PRESETS = {
    "sf26": {
        "tyre_mats": ["tyre_tread", "tyre_sides"],
        "rim_mats": ["sf25_wheel_hub", "discs.008"],
        "steer_mats": [
            "kers_green.004", "kers_red.004", "kers_blue", "CLEARLED.004",
            "plastic_interior.002", "sf25_lcd", "CLARED", "sf25_sw_carbon",
            "sf25_sw", "sf25_sw_decals",
        ],
        "steer_box": (-0.145, 0.145, 0.555, 0.745, 0.415, 0.540),
    },
    "w17": {
        "tyre_mats": ["tread_medium.007", "sidewall.007"],
        "rim_mats": ["mercedes_wheel_hub.007", "discs.007"],
        "steer_mats": [
            "mercedes_sw.005", "sw_decals.003", "sw_carbon.003",
            "indicator_lights.004", "rev_lights.003", "generics_lcd.003",
            "kers_red.003", "kers_green.003", "whitelight.003", "CLEARLED.003",
        ],
        "steer_box": (-0.145, 0.145, 0.460, 0.640, 0.540, 0.700),
    },
    "rb22": {
        "tyre_mats": ["sidewall.007"],
        "rim_mats": ["redbull_wheel_hub.007", "discs.007"],
        "steer_mats": [
            "redbull_steeringwheel.004", "black_s.006", "redbull_carbon2.007",
            "kers_blue.003", "gp21_LCD.003", "clearled.003", "sw_decals.004",
        ],
        "steer_box": (-0.140, 0.140, 0.485, 0.670, 0.650, 0.805),
    },
    "sf71h": {
        "tyre_mats": ["Tyre.001"],
        "rim_mats": ["Rim.001", "Rim_Logos.001", "Rim_Alpha.001", "EXT_Disc.001"],
        "steer_mats": [
            "LCD.001", "INT_Steer_Decals.001", "INT_Steer_Carbon.001",
            "INT_Steer_Decals_Alpha.001", "INT_Steer_Details_Metal.001",
            "INT_Steer_Details_Plastic.001", "INT_Steer_Rubber.001", "Cockpit_LR.001",
        ],
        "steer_box": (-0.145, 0.145, 0.510, 0.695, 0.325, 0.485),
    },
    "rb8": {
        # generic_tread_slick.003 is the outer tread/shoulder (r up to 0.322m);
        # generic_tyre_sof.003 is the inner sidewall ring (r <= 0.300m) placed on _RIM
        # so WHEEL_xx_TYRE has a single primitive (THREE.Mesh) for installTyreDeformation.
        "tyre_mats": ["generic_tread_slick.003"],
        "tyre_bbox_mats": ["generic_tread_slick.003", "generic_tyre_sof.003"],
        "rim_mats": ["lr2_wheel", "lr2_wheel_BLUR", "BRAKE.003", "generic_tyre_sof.003"],
        "skip_mats": ["RIM_BLUR.003"],
        "steer_mats": [
            "rb2_steering_wheel2", "rb2_steering_wheel", "int_led_alphs", "int_led.003",
        ],
        "steer_box": (-0.140, 0.140, 0.470, 0.640, 0.570, 0.630),
    },
    "r25": {
        "tyre_mats": ["Tyre.003"],
        "rim_mats": [
            "WILLIAMSRIM.002", "WILLIAMSSPOKE.002", "WILLIAMSHUB.002",
            "TREADMH.002", "Brake_Disk.002",
        ],
        "skip_mats": ["RIM_BLUR.002", "WILLIAMSRIM_BLUR_LIP.002"],
        "steer_mats": [
            "SW_BUTTONS_plastic", "RENAULTBUTTONS", "ALC.002",
            "RENAULTWHEELCARBON", "RENAULTSWHL", "material", "CLEARLED.003", "Metal.003",
        ],
        "steer_box": (-0.140, 0.140, 0.450, 0.655, 0.465, 0.540),
    },
    "f2004": {
        "tyre_mats": ["Tyre.007"],
        "rim_mats": ["Rim.007", "Rim_Decals.005", "Brake_Disk.005"],
        "skip_mats": ["DAMAGE_GLASS.005"],
        "steer_mats": [
            "INT_Carbon1Mult250.003", "INT_LCD.003", "INT_LEDS.003",
            "INT_Details.003", "INT_Plastic.003", "Metal.003",
            "INT_Steering_Arm.003", "Glass_Clear.007", "INT_Details_Opaque.003",
        ],
        "steer_box": (-0.140, 0.140, 0.385, 0.620, 0.305, 0.380),
    },
}


# ---------------------------------------------------------------------------
# GLB I/O & Matrix / Accessor Helpers
# ---------------------------------------------------------------------------
def read_glb(path: str):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError(f"{path} is not a valid GLB file (magic={magic!r})")
    off = 12
    jchunk = None
    bchunk = b""
    while off < total:
        clen, ctype = struct.unpack_from("<I4s", data, off)
        off += 8
        if ctype == b"JSON":
            jchunk = json.loads(data[off : off + clen].decode("utf-8"))
        elif ctype == b"BIN\x00":
            bchunk = data[off : off + clen]
        off += clen
    return jchunk, bchunk


def write_glb(path: str, jchunk: dict, bchunk: bytes):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    jb = json.dumps(jchunk, separators=(",", ":")).encode("utf-8")
    jpad = (4 - (len(jb) % 4)) % 4
    jb += b" " * jpad
    bpad = (4 - (len(bchunk) % 4)) % 4
    bb = bchunk + (b"\x00" * bpad)
    total = 12 + 8 + len(jb) + 8 + len(bb)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(jb), b"JSON"))
        f.write(jb)
        f.write(struct.pack("<I4s", len(bb), b"BIN\x00"))
        f.write(bb)


def quat_to_mat(q):
    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0.0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0.0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def node_local_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    M = np.eye(4, dtype=np.float64)
    if "translation" in node:
        T = np.eye(4, dtype=np.float64)
        T[:3, 3] = node["translation"]
        M = M @ T
    if "rotation" in node:
        M = M @ quat_to_mat(node["rotation"])
    if "scale" in node:
        S = np.diag(list(node["scale"]) + [1.0])
        M = M @ S
    return M


def read_accessor(j: dict, b: bytes, idx: int) -> np.ndarray:
    acc = j["accessors"][idx]
    bv = j["bufferViews"][acc["bufferView"]]
    off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    cnt = acc["count"]
    ct = acc["componentType"]
    dt = {
        5120: np.int8,
        5121: np.uint8,
        5122: np.int16,
        5123: np.uint16,
        5125: np.uint32,
        5126: np.float32,
    }[ct]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    itemsize = np.dtype(dt).itemsize * ncomp
    stride = bv.get("byteStride", itemsize)
    if stride == itemsize:
        arr = np.frombuffer(b, dtype=dt, count=cnt * ncomp, offset=off).copy()
        return arr.reshape((cnt, ncomp)) if ncomp > 1 else arr
    raw = np.frombuffer(b, dtype=np.uint8, count=(cnt - 1) * stride + itemsize, offset=off)
    out = np.empty((cnt, ncomp), dtype=dt)
    for k in range(cnt):
        out[k] = np.frombuffer(raw[k * stride : k * stride + itemsize], dtype=dt)
    return out if ncomp > 1 else out[:, 0]


def find_connected_components(n_verts: int, tris: np.ndarray) -> np.ndarray:
    """Union-Find connected components over triangle vertex indices (pure numpy/Python)."""
    parent = np.arange(n_verts, dtype=np.int32)
    for a, b, c in tris:
        ra = a
        while parent[ra] != ra:
            parent[ra] = parent[parent[ra]]
            ra = parent[ra]
        rb = b
        while parent[rb] != rb:
            parent[rb] = parent[parent[rb]]
            rb = parent[rb]
        rc = c
        while parent[rc] != rc:
            parent[rc] = parent[parent[rc]]
            rc = parent[rc]
        if ra != rb:
            parent[rb] = ra
        if ra != rc:
            parent[rc] = ra
    for i in range(n_verts):
        r = i
        while parent[r] != r:
            parent[r] = parent[parent[r]]
            r = parent[r]
        parent[i] = r
    return parent


def subset_primitive(prim_data: dict, tri_mask: np.ndarray) -> dict | None:
    """Extract a triangle subset of a primitive and compact its vertex arrays."""
    tris = prim_data["indices"][tri_mask]
    if len(tris) == 0:
        return None
    used_v, new_idx = np.unique(tris, return_inverse=True)
    out = {
        "material": prim_data["material"],
        "indices": new_idx.reshape((-1, 3)).astype(np.uint32),
        "POSITION": prim_data["POSITION"][used_v].copy(),
    }
    for attr in ("NORMAL", "TEXCOORD_0", "TEXCOORD_1"):
        if attr in prim_data and prim_data[attr] is not None:
            out[attr] = prim_data[attr][used_v].copy()
    return out


def merge_primitives(prims: list[dict], translate: np.ndarray | None = None) -> dict:
    """Merge multiple primitives of the same material into a single primitive."""
    pos_list = []
    norm_list = []
    tc0_list = []
    tc1_list = []
    idx_list = []
    v_offset = 0
    has_norm = any("NORMAL" in p and p["NORMAL"] is not None for p in prims)
    has_tc0 = any("TEXCOORD_0" in p and p["TEXCOORD_0"] is not None for p in prims)
    has_tc1 = any("TEXCOORD_1" in p and p["TEXCOORD_1"] is not None for p in prims)

    for p in prims:
        nv = len(p["POSITION"])
        pos = p["POSITION"].astype(np.float64)
        if translate is not None:
            pos = pos + translate
        pos_list.append(pos.astype(np.float32))
        if has_norm:
            if "NORMAL" in p and p["NORMAL"] is not None:
                norm_list.append(p["NORMAL"].astype(np.float32))
            else:
                norm_list.append(np.tile(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), (nv, 1)))
        if has_tc0:
            if "TEXCOORD_0" in p and p["TEXCOORD_0"] is not None:
                tc0_list.append(p["TEXCOORD_0"].astype(np.float32))
            else:
                tc0_list.append(np.zeros((nv, 2), dtype=np.float32))
        if has_tc1:
            if "TEXCOORD_1" in p and p["TEXCOORD_1"] is not None:
                tc1_list.append(p["TEXCOORD_1"].astype(np.float32))
            else:
                tc1_list.append(np.zeros((nv, 2), dtype=np.float32))
        idx_list.append(p["indices"].astype(np.uint32) + v_offset)
        v_offset += nv

    out = {
        "material": prims[0]["material"],
        "POSITION": np.vstack(pos_list),
        "indices": np.vstack(idx_list),
    }
    if has_norm:
        out["NORMAL"] = np.vstack(norm_list)
    if has_tc0:
        out["TEXCOORD_0"] = np.vstack(tc0_list)
    if has_tc1:
        out["TEXCOORD_1"] = np.vstack(tc1_list)
    return out


# ---------------------------------------------------------------------------
# Auto-detection fallback for unknown Sketchfab F1 GLBs
# ---------------------------------------------------------------------------
def auto_detect_preset(j: dict, baked_prims: list[dict]) -> dict:
    mats = j.get("materials", [])
    tyre_mats = []
    rim_mats = []
    steer_mats = []
    skip_mats = []

    # Group vertex positions by material name
    mat_pts = {}
    for p in baked_prims:
        mi = p["material"]
        mname = mats[mi].get("name", f"mat_{mi}") if mi is not None else "none"
        mat_pts.setdefault(mname, []).append(p["POSITION"])

    for mname, plist in mat_pts.items():
        pts = np.vstack(plist)
        low = mname.lower()
        if "blur" in low and ("rim" in low or "lip" in low):
            skip_mats.append(mname)
            continue
        if "damage_glass" in low:
            skip_mats.append(mname)
            continue
        all_outboard = bool(np.all(np.abs(pts[:, 0]) > 0.45))
        if all_outboard and any(k in low for k in ("tyre", "tread", "sidewall")) and "treadmh" not in low:
            tyre_mats.append(mname)
        elif all_outboard and any(
            k in low for k in ("wheel_hub", "rim", "lr2_wheel", "spoke", "williams", "treadmh", "disc", "disk", "brake")
        ):
            rim_mats.append(mname)
        if any(k in low for k in ("_sw", "steer", "swhl", "renaultbuttons", "renaultwheel", "sw_buttons", "lcd", "clearled", "clared", "int_led")):
            steer_mats.append(mname)

    return {
        "tyre_mats": tyre_mats,
        "rim_mats": rim_mats,
        "steer_mats": steer_mats,
        "skip_mats": skip_mats,
        "steer_box": (-0.150, 0.150, 0.380, 0.750, 0.300, 0.810),
    }


# ---------------------------------------------------------------------------
# Main Porter Pipeline
# ---------------------------------------------------------------------------
def port_f1_car(
    src_path: str,
    dst_path: str,
    car_id: str | None = None,
    scale_override: float | None = None,
    target_wheelbase: float | None = None,
    max_tex_size: int = 2048,
    small_tex_size: int = 1024,
    jpeg_quality: int = 92,
    tyre_mats_override: list[str] | None = None,
    rim_mats_override: list[str] | None = None,
    steer_mats_override: list[str] | None = None,
    steer_box_override: tuple[float, float, float, float, float, float] | None = None,
    no_steer: bool = False,
):
    j, b = read_glb(src_path)
    if car_id is None:
        stem = Path(dst_path).stem.lower()
        if stem not in CAR_PRESETS:
            stem = Path(src_path).stem.lower()
        car_id = stem

    # 1. Bake world transforms from scene root
    world_mats = {}

    def walk(ni: int, parent_m: np.ndarray):
        m = parent_m @ node_local_matrix(j["nodes"][ni])
        world_mats[ni] = m
        for c in j["nodes"][ni].get("children", []):
            walk(c, m)

    scene_idx = j.get("scene", 0)
    for r in j["scenes"][scene_idx]["nodes"]:
        walk(r, np.eye(4, dtype=np.float64))

    mats = j.get("materials", [])
    baked_prims = []

    for ni, node in enumerate(j["nodes"]):
        if "mesh" not in node or ni not in world_mats:
            continue
        M = world_mats[ni]
        R = M[:3, :3]
        t = M[:3, 3]
        R_inv_T = np.linalg.inv(R).T
        det_sign = -1.0 if np.linalg.det(R) < 0 else 1.0

        mesh = j["meshes"][node["mesh"]]
        for prim in mesh["primitives"]:
            if prim.get("mode", 4) != 4:
                continue
            attrs = prim["attributes"]
            pos = read_accessor(j, b, attrs["POSITION"]).astype(np.float64)
            pos = (pos @ R.T) + t

            norm = None
            if "NORMAL" in attrs:
                n_raw = read_accessor(j, b, attrs["NORMAL"]).astype(np.float64)
                n_w = n_raw @ R_inv_T
                n_len = np.linalg.norm(n_w, axis=1, keepdims=True)
                n_len[n_len < 1e-12] = 1.0
                norm = (n_w / n_len).astype(np.float32)

            tc0 = read_accessor(j, b, attrs["TEXCOORD_0"]).astype(np.float32) if "TEXCOORD_0" in attrs else None
            tc1 = read_accessor(j, b, attrs["TEXCOORD_1"]).astype(np.float32) if "TEXCOORD_1" in attrs else None

            if "indices" in prim:
                indices = read_accessor(j, b, prim["indices"]).astype(np.uint32).reshape((-1, 3))
            else:
                indices = np.arange(len(pos), dtype=np.uint32).reshape((-1, 3))

            if det_sign < 0:
                indices = indices[:, [0, 2, 1]]

            baked_prims.append(
                {
                    "node_idx": ni,
                    "material": prim.get("material", 0),
                    "POSITION": pos.astype(np.float32),
                    "NORMAL": norm,
                    "TEXCOORD_0": tc0,
                    "TEXCOORD_1": tc1,
                    "indices": indices,
                }
            )

    # 2. Resolve preset / CLI overrides
    preset = CAR_PRESETS.get(car_id) or auto_detect_preset(j, baked_prims)
    tyre_mat_names = list(tyre_mats_override or preset["tyre_mats"])
    tyre_bbox_mat_names = set(tyre_mats_override or preset.get("tyre_bbox_mats", tyre_mat_names))
    rim_mat_names = set(rim_mats_override or preset["rim_mats"])
    steer_mat_names = set(steer_mats_override or preset.get("steer_mats", []))
    skip_mat_names = set(preset.get("skip_mats", []))
    steer_box = steer_box_override or preset.get("steer_box", (-0.145, 0.145, 0.40, 0.75, 0.30, 0.80))

    primary_tyre_mat_name = tyre_mat_names[0]
    primary_tyre_mat_idx = None
    for mi, m in enumerate(mats):
        if m.get("name") == primary_tyre_mat_name:
            primary_tyre_mat_idx = mi
            break

    # 3. Measure raw tyre positions & apply optional scale + X centering + Y floor normalization
    tyre_pts_raw = []
    for p in baked_prims:
        mname = mats[p["material"]].get("name", "")
        if mname in tyre_bbox_mat_names:
            tyre_pts_raw.append(p["POSITION"].astype(np.float64))
    if not tyre_pts_raw:
        raise RuntimeError(f"[{car_id}] Could not find any tyre primitives for materials {tyre_mat_names}")
    tyre_pts_Concat = np.vstack(tyre_pts_raw)

    # Compute raw wheelbase to determine scale factor if target_wheelbase is given
    f_z_raw = 0.5 * (
        tyre_pts_Concat[(tyre_pts_Concat[:, 0] < 0) & (tyre_pts_Concat[:, 2] > 0)][:, 2].mean()
        + tyre_pts_Concat[(tyre_pts_Concat[:, 0] > 0) & (tyre_pts_Concat[:, 2] > 0)][:, 2].mean()
    )
    r_z_raw = 0.5 * (
        tyre_pts_Concat[(tyre_pts_Concat[:, 0] < 0) & (tyre_pts_Concat[:, 2] < 0)][:, 2].mean()
        + tyre_pts_Concat[(tyre_pts_Concat[:, 0] > 0) & (tyre_pts_Concat[:, 2] < 0)][:, 2].mean()
    )
    raw_wb = float(f_z_raw - r_z_raw)

    scale = 1.0
    if scale_override is not None:
        scale = float(scale_override)
    elif target_wheelbase is not None:
        scale = float(target_wheelbase) / raw_wb

    if abs(scale - 1.0) > 1e-6:
        for p in baked_prims:
            p["POSITION"] = (p["POSITION"].astype(np.float64) * scale).astype(np.float32)
        tyre_pts_Concat = tyre_pts_Concat * scale

    # Compute per-corner raw tyre bounding boxes
    corners_raw = {}
    for wname, mask in [
        ("RF", (tyre_pts_Concat[:, 0] < 0) & (tyre_pts_Concat[:, 2] > 0)),
        ("LF", (tyre_pts_Concat[:, 0] > 0) & (tyre_pts_Concat[:, 2] > 0)),
        ("RR", (tyre_pts_Concat[:, 0] < 0) & (tyre_pts_Concat[:, 2] < 0)),
        ("LR", (tyre_pts_Concat[:, 0] > 0) & (tyre_pts_Concat[:, 2] < 0)),
    ]:
        pts = tyre_pts_Concat[mask]
        if len(pts) == 0:
            raise RuntimeError(f"[{car_id}] Missing tyre geometry in quadrant {wname}")
        bmin = pts.min(axis=0)
        bmax = pts.max(axis=0)
        corners_raw[wname] = (bmin, bmax, 0.5 * (bmin + bmax))

    # Center X across the 4 wheels and shift Y so the lowest tyre point is at y = 0
    x_shift = -0.25 * sum(corners_raw[w][2][0] for w in ("RF", "LF", "RR", "LR"))
    y_shift = -min(corners_raw[w][0][1] for w in ("RF", "LF", "RR", "LR"))
    global_shift = np.array([x_shift, y_shift, 0.0], dtype=np.float64)

    for p in baked_prims:
        p["POSITION"] = (p["POSITION"].astype(np.float64) + global_shift).astype(np.float32)

    for w in ("RF", "LF", "RR", "LR"):
        bmin, bmax, ctr = corners_raw[w]
        corners_raw[w] = (bmin + global_shift, bmax + global_shift, ctr + global_shift)

    # Compute symmetrized wheel centres, tyreRadius, and tyreHalfWidth per axle
    def axle_metrics(left_key: str, right_key: str):
        l_min, l_max, l_ctr = corners_raw[left_key]
        r_min, r_max, r_ctr = corners_raw[right_key]
        l_rad = 0.5 * (l_max[1] - l_min[1])
        r_rad = 0.5 * (r_max[1] - r_min[1])
        l_hw = 0.5 * (l_max[0] - l_min[0])
        r_hw = 0.5 * (r_max[0] - r_min[0])
        abs_x = 0.5 * (abs(l_ctr[0]) + abs(r_ctr[0]))
        avg_z = 0.5 * (l_ctr[2] + r_ctr[2])
        avg_rad = 0.5 * (l_rad + r_rad)
        avg_hw = 0.5 * (l_hw + r_hw)
        return abs_x, avg_rad, avg_z, avg_hw

    f_abs_x, f_rad, f_z, f_hw = axle_metrics("LF", "RF")
    r_abs_x, r_rad, r_z, r_hw = axle_metrics("LR", "RR")

    wheel_centres = {
        "WHEEL_RF": [round(-f_abs_x, 5), round(f_rad, 5), round(f_z, 5)],
        "WHEEL_LF": [round(+f_abs_x, 5), round(f_rad, 5), round(f_z, 5)],
        "WHEEL_RR": [round(-r_abs_x, 5), round(r_rad, 5), round(r_z, 5)],
        "WHEEL_LR": [round(+r_abs_x, 5), round(r_rad, 5), round(r_z, 5)],
    }
    tyre_radius = {
        "RF": round(f_rad, 5),
        "LF": round(f_rad, 5),
        "RR": round(r_rad, 5),
        "LR": round(r_rad, 5),
    }
    tyre_half_width = {
        "RF": round(f_hw, 5),
        "LF": round(f_hw, 5),
        "RR": round(r_hw, 5),
        "LR": round(r_hw, 5),
    }
    wheelbase_m = round(f_z - r_z, 5)

    # 4. Partition primitives into WHEEL_xx_TYRE, WHEEL_xx_RIM, STEER, and BODY
    wheel_tyre_prims = {w: [] for w in ("RF", "LF", "RR", "LR")}
    wheel_rim_prims = {w: [] for w in ("RF", "LF", "RR", "LR")}
    steer_prims = []
    body_prims = []

    xmin, xmax, ymin, ymax, zmin, zmax = [v * scale for v in steer_box]
    ymin += y_shift
    ymax += y_shift

    for p in baked_prims:
        mname = mats[p["material"]].get("name", "")
        if mname in skip_mat_names:
            continue

        pos = p["POSITION"]
        tris = p["indices"]
        tri_c = pos[tris].mean(axis=1)

        if mname in tyre_mat_names:
            # Unify all tyre primitives into primary_tyre_mat_idx so WHEEL_xx_TYRE has 1 primitive
            p_unified = dict(p)
            if primary_tyre_mat_idx is not None:
                p_unified["material"] = primary_tyre_mat_idx
            for wname, mask in [
                ("RF", (tri_c[:, 0] < 0) & (tri_c[:, 2] > 0)),
                ("LF", (tri_c[:, 0] > 0) & (tri_c[:, 2] > 0)),
                ("RR", (tri_c[:, 0] < 0) & (tri_c[:, 2] < 0)),
                ("LR", (tri_c[:, 0] > 0) & (tri_c[:, 2] < 0)),
            ]:
                sub = subset_primitive(p_unified, mask)
                if sub is not None:
                    wheel_tyre_prims[wname].append(sub)
            continue

        if mname in rim_mat_names:
            for wname, mask in [
                ("RF", (tri_c[:, 0] < 0) & (tri_c[:, 2] > 0)),
                ("LF", (tri_c[:, 0] > 0) & (tri_c[:, 2] > 0)),
                ("RR", (tri_c[:, 0] < 0) & (tri_c[:, 2] < 0)),
                ("LR", (tri_c[:, 0] > 0) & (tri_c[:, 2] < 0)),
            ]:
                sub = subset_primitive(p, mask)
                if sub is not None:
                    wheel_rim_prims[wname].append(sub)
            continue

        if not no_steer and mname in steer_mat_names:
            in_v = (
                (pos[:, 0] >= xmin)
                & (pos[:, 0] <= xmax)
                & (pos[:, 1] >= ymin)
                & (pos[:, 1] <= ymax)
                & (pos[:, 2] >= zmin)
                & (pos[:, 2] <= zmax)
            )
            if np.all(in_v):
                steer_prims.append(p)
                continue
            elif np.any(in_v):
                comp = find_connected_components(len(pos), tris)
                unique_c, inv = np.unique(comp, return_inverse=True)
                comp_ok = np.ones(len(unique_c), dtype=bool)
                np.logical_and.at(comp_ok, inv, in_v)
                v_ok = comp_ok[inv]
                t_ok = v_ok[tris[:, 0]]
                if np.any(t_ok):
                    sub_sw = subset_primitive(p, t_ok)
                    if sub_sw is not None:
                        steer_prims.append(sub_sw)
                if np.any(~t_ok):
                    sub_bd = subset_primitive(p, ~t_ok)
                    if sub_bd is not None:
                        body_prims.append(sub_bd)
                continue

        body_prims.append(p)

    # Ensure BODY lowest point doesn't dip below y = 0.0
    body_pts = np.vstack([p["POSITION"] for p in body_prims])
    nose_z = float(body_pts[:, 2].max())
    tail_z = float(body_pts[:, 2].min())
    rh_mask = (np.abs(body_pts[:, 0]) < 0.15) & (body_pts[:, 2] > -0.8) & (body_pts[:, 2] < 0.2)
    rh_pts = body_pts[rh_mask]
    rh_top = rh_pts[np.argmax(rh_pts[:, 1])] if len(rh_pts) > 0 else np.array([0.0, 1.10, -0.35])

    # Compute steering wheel pivot
    if steer_prims:
        sw_pts = np.vstack([p["POSITION"] for p in steer_prims])
        sw_min = sw_pts.min(axis=0)
        sw_max = sw_pts.max(axis=0)
        steer_ctr = np.array(
            [0.0, round(float(0.5 * (sw_min[1] + sw_max[1])), 5), round(float(0.5 * (sw_min[2] + sw_max[2])), 5)],
            dtype=np.float64,
        )
    else:
        steer_ctr = np.array([0.0, 0.58, 0.48], dtype=np.float64)

    # 5. Compute cameras
    cameras = {
        "cockpit": {
            "pos": [0.0, round(float(steer_ctr[1] + 0.135), 4), round(float(steer_ctr[2] - 0.45), 4)],
            "pitchDeg": -5.865,
            "fov": 55,
        },
        "tcam": {
            "pos": [0.09, round(float(rh_top[1] - 0.045), 4), round(float(rh_top[2] + 0.03), 4)],
            "pitchDeg": -12.3,
            "fov": 55,
        },
        "dash": {
            "pos": [0.0, round(float(steer_ctr[1] + 0.135), 4), round(float(steer_ctr[2] - 0.16), 4)],
            "pitchDeg": -0.02,
            "fov": 55,
        },
        "bumper": {
            "pos": [0.0, 0.711, round(float(nose_z - 0.38), 4)],
            "pitchDeg": -0.165,
            "fov": 55,
        },
        "nearChase": {
            "pos": [0.0, 1.8, -5.095],
            "pitchDeg": -5.0,
            "fov": 55,
        },
        "farChase": {
            "pos": [0.0, 2.5, -6.425],
            "pitchDeg": -5.0,
            "fov": 55,
        },
    }

    # 6. Clean up materials & determine which materials use textures / texCoord 1
    used_mat_indices = set()
    for plist in (
        body_prims,
        steer_prims,
        *wheel_tyre_prims.values(),
        *wheel_rim_prims.values(),
    ):
        for p in plist:
            used_mat_indices.add(p["material"])

    old_to_new_mat = {}
    new_materials = []
    mat_needs_tc0 = {}
    mat_needs_tc1 = {}
    large_tex_indices = set()

    # Measure total triangle area / vertex count per material to know which textures are main livery/body
    mat_vert_counts = {}
    for p in body_prims:
        mat_vert_counts[p["material"]] = mat_vert_counts.get(p["material"], 0) + len(p["POSITION"])

    for old_mi in sorted(used_mat_indices):
        m = json.loads(json.dumps(mats[old_mi]))
        # Strip zero-scale normalTexture
        if "normalTexture" in m and m["normalTexture"].get("scale", 1.0) == 0.0:
            del m["normalTexture"]

        has_any_tex = False
        has_tc1 = False
        pbr = m.get("pbrMetallicRoughness", {})
        for k in ("baseColorTexture", "metallicRoughnessTexture"):
            if k in pbr:
                has_any_tex = True
                if pbr[k].get("texCoord", 0) == 1:
                    has_tc1 = True
                if mat_vert_counts.get(old_mi, 0) > 8000 or any(
                    w in m.get("name", "").lower() for w in ("paint", "body", "carpaint", "livery", "wing")
                ):
                    large_tex_indices.add(pbr[k]["index"])
        for k in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            if k in m:
                has_any_tex = True
                if m[k].get("texCoord", 0) == 1:
                    has_tc1 = True

        new_mi = len(new_materials)
        old_to_new_mat[old_mi] = new_mi
        new_materials.append(m)
        mat_needs_tc0[new_mi] = has_any_tex
        mat_needs_tc1[new_mi] = has_tc1

    # Remap material indices on all primitives and strip unused UV channels
    def remap_and_group_by_mat(prims: list[dict], translate: np.ndarray | None = None) -> list[dict]:
        by_mat = {}
        for p in prims:
            new_mi = old_to_new_mat[p["material"]]
            p_copy = dict(p)
            p_copy["material"] = new_mi
            if not mat_needs_tc0[new_mi]:
                p_copy["TEXCOORD_0"] = None
            if not mat_needs_tc1[new_mi]:
                p_copy["TEXCOORD_1"] = None
            by_mat.setdefault(new_mi, []).append(p_copy)
        return [merge_primitives(plist, translate=translate) for _, plist in sorted(by_mat.items())]

    # 7. Build output nodes and meshes
    out_buffers = bytearray()
    out_buffer_views = []
    out_accessors = []
    out_meshes = []
    out_nodes = []

    def append_bytes(raw: bytes, target: int | None = None) -> int:
        pad = (4 - (len(out_buffers) % 4)) % 4
        if pad:
            out_buffers.extend(b"\x00" * pad)
        off = len(out_buffers)
        out_buffers.extend(raw)
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(raw)}
        if target is not None:
            bv["target"] = target
        bv_idx = len(out_buffer_views)
        out_buffer_views.append(bv)
        return bv_idx

    def add_accessor(arr: np.ndarray, component_type: int, acc_type: str, target: int) -> int:
        bv_idx = append_bytes(arr.tobytes(), target=target)
        acc = {
            "bufferView": bv_idx,
            "byteOffset": 0,
            "componentType": component_type,
            "count": int(len(arr)),
            "type": acc_type,
        }
        if acc_type == "VEC3" and component_type == 5126:
            acc["min"] = [float(x) for x in arr.min(axis=0)]
            acc["max"] = [float(x) for x in arr.max(axis=0)]
        acc_idx = len(out_accessors)
        out_accessors.append(acc)
        return acc_idx

    def build_gltf_primitive(merged: dict) -> dict:
        attrs = {}
        pos = merged["POSITION"].astype(np.float32)
        attrs["POSITION"] = add_accessor(pos, 5126, "VEC3", 34962)
        if "NORMAL" in merged and merged["NORMAL"] is not None:
            attrs["NORMAL"] = add_accessor(merged["NORMAL"].astype(np.float32), 5126, "VEC3", 34962)
        if "TEXCOORD_0" in merged and merged["TEXCOORD_0"] is not None:
            attrs["TEXCOORD_0"] = add_accessor(merged["TEXCOORD_0"].astype(np.float32), 5126, "VEC2", 34962)
        if "TEXCOORD_1" in merged and merged["TEXCOORD_1"] is not None:
            attrs["TEXCOORD_1"] = add_accessor(merged["TEXCOORD_1"].astype(np.float32), 5126, "VEC2", 34962)

        idx_flat = merged["indices"].reshape(-1)
        if len(pos) <= 65535:
            idx_acc = add_accessor(idx_flat.astype(np.uint16), 5123, "SCALAR", 34963)
        else:
            idx_acc = add_accessor(idx_flat.astype(np.uint32), 5125, "SCALAR", 34963)

        return {
            "attributes": attrs,
            "indices": idx_acc,
            "material": merged["material"],
            "mode": 4,
        }

    # BODY group node + child mesh nodes (1 per material)
    body_merged_list = remap_and_group_by_mat(body_prims, translate=None)
    body_child_nodes = []
    for i, mp in enumerate(body_merged_list):
        m_idx = len(out_meshes)
        mname = new_materials[mp["material"]].get("name", f"mat_{mp['material']}")
        out_meshes.append({"name": f"BODY_{mname}", "primitives": [build_gltf_primitive(mp)]})
        n_idx = len(out_nodes)
        out_nodes.append({"name": f"BODY_{i}_{mname}", "mesh": m_idx})
        body_child_nodes.append(n_idx)

    body_node_idx = len(out_nodes)
    out_nodes.append({"name": "BODY", "children": body_child_nodes})
    car_children = [body_node_idx]

    # STEER pivot node (optional)
    if steer_prims:
        steer_merged_list = remap_and_group_by_mat(steer_prims, translate=-steer_ctr)
        steer_child_nodes = []
        for i, mp in enumerate(steer_merged_list):
            m_idx = len(out_meshes)
            mname = new_materials[mp["material"]].get("name", f"mat_{mp['material']}")
            out_meshes.append({"name": f"STEER_{mname}", "primitives": [build_gltf_primitive(mp)]})
            n_idx = len(out_nodes)
            out_nodes.append({"name": f"STEER_{i}_{mname}", "mesh": m_idx})
            steer_child_nodes.append(n_idx)
        steer_node_idx = len(out_nodes)
        out_nodes.append(
            {
                "name": "STEER",
                "translation": [round(float(x), 5) for x in steer_ctr],
                "children": steer_child_nodes,
            }
        )
        car_children.append(steer_node_idx)

    # Four WHEEL_xx nodes, each with WHEEL_xx_RIM and single-primitive WHEEL_xx_TYRE
    for wname in ("RF", "LF", "RR", "LR"):
        raw_ctr = corners_raw[wname][2]
        rim_merged = remap_and_group_by_mat(wheel_rim_prims[wname], translate=-raw_ctr)
        tyre_merged = remap_and_group_by_mat(wheel_tyre_prims[wname], translate=-raw_ctr)
        if len(tyre_merged) != 1:
            raise RuntimeError(f"[{car_id}] Expected 1 merged tyre primitive for {wname}, got {len(tyre_merged)}")

        rim_gl_prims = [build_gltf_primitive(mp) for mp in rim_merged]
        rim_mesh_idx = len(out_meshes)
        out_meshes.append({"name": f"WHEEL_{wname}_RIM", "primitives": rim_gl_prims})
        rim_node_idx = len(out_nodes)
        out_nodes.append({"name": f"WHEEL_{wname}_RIM", "mesh": rim_mesh_idx})

        tyre_gl_prim = build_gltf_primitive(tyre_merged[0])
        tyre_mesh_idx = len(out_meshes)
        out_meshes.append({"name": f"WHEEL_{wname}_TYRE", "primitives": [tyre_gl_prim]})
        tyre_node_idx = len(out_nodes)
        out_nodes.append({"name": f"WHEEL_{wname}_TYRE", "mesh": tyre_mesh_idx})

        wheel_node_idx = len(out_nodes)
        out_nodes.append(
            {
                "name": f"WHEEL_{wname}",
                "translation": wheel_centres[f"WHEEL_{wname}"],
                "children": [rim_node_idx, tyre_node_idx],
            }
        )
        car_children.append(wheel_node_idx)

    # Root CAR node
    car_extras = {
        "wheelCentres": wheel_centres,
        "tyreRadius": tyre_radius,
        "tyreHalfWidth": tyre_half_width,
        "wheelbaseM": wheelbase_m,
        "steerBase": [round(float(x), 5) for x in steer_ctr],
        "cameras": cameras,
        "source": j.get("asset", {}).get("extras", {}),
    }
    car_node_idx = len(out_nodes)
    out_nodes.append({"name": "CAR", "children": car_children, "extras": car_extras})

    # 8. Compact and re-encode referenced textures & images
    old_textures = j.get("textures", [])
    old_images = j.get("images", [])
    old_bvs = j.get("bufferViews", [])

    used_tex_indices = set()
    for m in new_materials:
        pbr = m.get("pbrMetallicRoughness", {})
        for k in ("baseColorTexture", "metallicRoughnessTexture"):
            if k in pbr:
                used_tex_indices.add(pbr[k]["index"])
        for k in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            if k in m:
                used_tex_indices.add(m[k]["index"])
        for ext in m.get("extensions", {}).values():
            if isinstance(ext, dict):
                for v in ext.values():
                    if isinstance(v, dict) and "index" in v:
                        used_tex_indices.add(v["index"])

    old_to_new_tex = {}
    new_textures = []
    used_img_indices = set()
    img_max_dim = {}

    for old_ti in sorted(used_tex_indices):
        t = dict(old_textures[old_ti])
        old_ii = t["source"]
        used_img_indices.add(old_ii)
        cap = max_tex_size if old_ti in large_tex_indices else small_tex_size
        img_max_dim[old_ii] = max(img_max_dim.get(old_ii, 0), cap)
        old_to_new_tex[old_ti] = len(new_textures)
        new_textures.append(t)

    old_to_new_img = {}
    new_images = []
    for old_ii in sorted(used_img_indices):
        img_def = old_images[old_ii]
        bv = old_bvs[img_def["bufferView"]]
        raw = b[bv.get("byteOffset", 0) : bv.get("byteOffset", 0) + bv["byteLength"]]
        im = Image.open(io.BytesIO(raw))
        cap = img_max_dim.get(old_ii, small_tex_size)
        w, h = im.size
        if max(w, h) > cap:
            scale_f = cap / float(max(w, h))
            im = im.resize((max(1, int(round(w * scale_f))), max(1, int(round(h * scale_f)))), Image.LANCZOS)

        has_alpha = im.mode in ("RGBA", "LA") or ("transparency" in im.info)
        if has_alpha:
            rgba = im.convert("RGBA")
            alpha_min = int(np.array(rgba)[:, :, 3].min())
            if alpha_min == 255:
                has_alpha = False

        buf = io.BytesIO()
        if has_alpha:
            im.convert("RGBA").save(buf, format="PNG", optimize=True)
            mime = "image/png"
        else:
            im.convert("RGB").save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
            mime = "image/jpeg"

        encoded = buf.getvalue()
        img_bv_idx = append_bytes(encoded, target=None)
        old_to_new_img[old_ii] = len(new_images)
        new_images.append(
            {
                "name": img_def.get("name", f"img_{old_ii}"),
                "bufferView": img_bv_idx,
                "mimeType": mime,
            }
        )

    for t in new_textures:
        t["source"] = old_to_new_img[t["source"]]

    for m in new_materials:
        pbr = m.get("pbrMetallicRoughness", {})
        for k in ("baseColorTexture", "metallicRoughnessTexture"):
            if k in pbr:
                pbr[k]["index"] = old_to_new_tex[pbr[k]["index"]]
        for k in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            if k in m:
                m[k]["index"] = old_to_new_tex[m[k]["index"]]
        for ext in m.get("extensions", {}).values():
            if isinstance(ext, dict):
                for v in ext.values():
                    if isinstance(v, dict) and "index" in v:
                        v["index"] = old_to_new_tex[v["index"]]

    out_json = {
        "asset": j.get("asset", {"version": "2.0"}),
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [car_node_idx]}],
        "nodes": out_nodes,
        "meshes": out_meshes,
        "materials": new_materials,
        "textures": new_textures,
        "images": new_images,
        "samplers": j.get("samplers", [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]),
        "accessors": out_accessors,
        "bufferViews": out_buffer_views,
        "buffers": [{"byteLength": len(out_buffers)}],
    }
    if "extensionsUsed" in j:
        out_json["extensionsUsed"] = j["extensionsUsed"]

    write_glb(dst_path, out_json, bytes(out_buffers))
    mb = os.path.getsize(dst_path) / (1024 * 1024)
    print(
        f"[{car_id}] -> {dst_path} ({mb:.2f} MB) | "
        f"wb={wheelbase_m:.3f}m trackF={2*f_abs_x:.3f}m trackR={2*r_abs_x:.3f}m "
        f"rF={f_rad:.3f}m rR={r_rad:.3f}m steer={'yes' if steer_prims else 'no'} "
        f"bodyMeshes={len(body_child_nodes)} imgs={len(new_images)}"
    )


def parse_args():
    p = argparse.ArgumentParser(description="Port a Sketchfab F1 GLB to LibreCorsa ported-car layout.")
    p.add_argument("src", help="Source Sketchfab GLB path")
    p.add_argument("dst", help="Destination GLB path (public/cars/<id>/model/<id>.glb)")
    p.add_argument("--car", default=None, help="Car preset ID (sf26, w17, rb22, sf71h, rb8, r25, f2004)")
    p.add_argument("--scale", type=float, default=None, help="Uniform scale factor override")
    p.add_argument("--wheelbase", type=float, default=None, help="Scale uniformly to match target wheelbase (m)")
    p.add_argument("--max-tex", type=int, default=2048, help="Max resolution (px) for main body/livery textures")
    p.add_argument("--small-tex", type=int, default=1024, help="Max resolution (px) for secondary/part textures")
    p.add_argument("--jpeg-quality", type=int, default=92, help="JPEG quality for opaque textures")
    p.add_argument("--tyre-mats", nargs="*", default=None, help="Override tyre material names")
    p.add_argument("--rim-mats", nargs="*", default=None, help="Override rim material names")
    p.add_argument("--steer-mats", nargs="*", default=None, help="Override steering wheel material names")
    p.add_argument(
        "--steer-box",
        nargs=6,
        type=float,
        metavar=("XMIN", "XMAX", "YMIN", "YMAX", "ZMIN", "ZMAX"),
        default=None,
        help="Override steering wheel bounding box in metres",
    )
    p.add_argument("--no-steer", action="store_true", help="Do not split a STEER node")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    port_f1_car(
        src_path=args.src,
        dst_path=args.dst,
        car_id=args.car,
        scale_override=args.scale,
        target_wheelbase=args.wheelbase,
        max_tex_size=args.max_tex,
        small_tex_size=args.small_tex,
        jpeg_quality=args.jpeg_quality,
        tyre_mats_override=args.tyre_mats,
        rim_mats_override=args.rim_mats,
        steer_mats_override=args.steer_mats,
        steer_box_override=tuple(args.steer_box) if args.steer_box else None,
        no_steer=args.no_steer,
    )
