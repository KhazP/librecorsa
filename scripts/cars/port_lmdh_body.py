"""Build the LC-LMDH body GLB from a single-file prototype model, in the generic car rig's layout.

Runs inside Blender, headless (bpy and numpy only):

    BLENDER="$HOME/Library/Application Support/Steam/steamapps/common/Blender/Blender.app/Contents/MacOS/Blender"
    "$BLENDER" --background --factory-startup --python scripts/cars/port_lmdh_body.py -- \
        reference_data/lmdh/<source>.glb public/cars/lc-lmdh/model/lc-lmdh.glb

    # the raw model's node tree, triangle counts, animations and materials only:
    "$BLENDER" --background --factory-startup --python scripts/cars/port_lmdh_body.py -- \
        reference_data/lmdh/<source>.glb --report-only

Writes `artifacts/lmdh_mesh_report.json` (the source as imported) and `artifacts/lmdh_hardpoints.json` (wheel
centres, track widths, tyre radii and the body's measured box against the regulation limits). `--compress` then runs
`scripts/compress-car-glb.mjs` on the output (meshopt, which the game's loader decodes); without it the file stays
raw, as the other car tools leave theirs.

Output node layout (read by src/lib/ported-car-model.ts):
    CAR (extras: wheelCentres, tyreRadius, tyreHalfWidth, wheelbaseM, trackWidthM, steer, cameras, source)
      BODY              everything that does not spin: body, floor, cockpit, lights, suspension, callipers
      STEER             steering-wheel pivot, column along its local +Z (left out when no steering wheel is found)
      WHEEL_RF          hub pivot at wheelCentres.WHEEL_RF; likewise WHEEL_LF, WHEEL_RR, WHEEL_LR
        WHEEL_RF_RIM    rim, spokes, nut and brake disc, centred on the hub
        WHEEL_RF_TYRE   tyre, one primitive, centred on the hub

Frame: metres, +X left, +Y up, +Z forward, lowest tyre contact at y = 0, origin under the middle of the wheelbase.

What it does, in order:
 1. Report: node tree, triangles, animations, materials and images of the source.
 2. Animations are removed (the nodes' own pose is kept), hidden objects and props (`--drop`) deleted, transforms
    baked.
 3. Wheels are found from geometry: the four round loose parts standing on the floor. The axle with the wider
    tyres is the rear one (the longer overhang breaks a tie; `--flip-nose` overrides).
 4. One uniform scale takes the wheelbase to `--wheelbase` (3.148 m). Length, width and height are then measured
    and compared with the limits; nothing is stretched to meet them.
 5. Each loose part inside a wheel's cylinder and centred on its axle spins with it (tyre if it is a ring out at the
    tread, rim otherwise); off-centre parts there (callipers, uprights) stay on the body.
 6. Paint: no texture that carried a livery, a number, a sponsor or a maker's mark survives. A source material
    becomes one of the output's own by what its colour texture is: a flat one keeps its mean colour, a patterned
    one on the body is a painted panel (`--livery-mats` adds unnamed ones), dark bare panels and the underfloor take
    a generated carbon weave, tyres plain rubber, rims a plain alloy; lights keep their emission. Only cockpit
    plastics, switches and buttons keep their texture (`--keep-tex`), with `--scrub` to black out a rectangle.
    The painted panels are then cut along planes into the livery: a centre stripe and two raked bands.
    Raised lettering modelled as geometry has to be named with `--drop`: look for it in the stills.
 7. Decimation to the triangle budget (before the livery is cut, so its edges stay clean), textures capped,
    export, and the CAR node's extras written into the GLB. Shading normals are rebuilt: the source's are dropped,
    and objects modelled inside out (mirrored halves) are turned.
"""
import argparse
import json
import math
import os
import re
import struct
import subprocess
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

SOURCE = {
    "author": "kilianhoffmann13 (https://sketchfab.com/kilianhoffmann13)",
    "license": "CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)",
    "source": "https://sketchfab.com/models/d786aa263a804254aa92543dda11dba0",
    "converted": "scripts/cars/port_lmdh_body.py",
}

# Regulation box the measured body is checked against (technical regulations 3.1): maxima, not targets. The 1.060 m
# height is above the floor's reference plane, which sits a skid block (20 mm) and the ride height above the ground.
WHEELBASE_M = 3.148
MAX_LENGTH_M = 5.100
MAX_WIDTH_M = 2.000
MAX_HEIGHT_ABOVE_REFERENCE_M = 1.060
SKID_BLOCK_M = 0.020
MAX_FRONT_OVERHANG_M = 1.100
MAX_REAR_OVERHANG_M = 0.850

CORNERS = ("RF", "LF", "RR", "LR")

DROP_RE = r"air.?jack|jack.?stand|pit.?stand|shadow|ground|backdrop|turntable|studio|hdri|sky"
STEER_RE = r"steer|volant|lenkrad"
TYRE_RE = re.compile(r"tyre|tire|tread|sidewall|rubber", re.I)
CARBON_RE = re.compile(r"carbon|carb|_cf\b", re.I)
GLASS_RE = re.compile(r"glass|windshield|windscreen|visor|lens|perspex", re.I)
METAL_RE = re.compile(r"chrome|metal|allu|alu\b|alloy|exhaust|hub|caliper|calliper|titanium|steel|bolt", re.I)
DISC_RE = re.compile(r"disc|disk|rotor|brake", re.I)
INTERIOR_RE = re.compile(r"int_|interior|cockpit|seat|headrest|belt|dash|steer", re.I)
PAINT_RE = re.compile(r"paint|body|livery|skin", re.I)
MIRROR_RE = re.compile(r"mirror", re.I)
KEEP_TEX_RE = r"plastic|button|switch|rotor"


def log(*a):
    print("[lmdh]", *a, flush=True)


# --------------------------------------------------------------------------------------------------------------------
# Scene helpers


def mesh_objects():
    return [o for o in bpy.data.objects if o.type == "MESH"]


def verts_of(mesh):
    co = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", co)
    return co.reshape(-1, 3).astype(np.float64)


def tri_count(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def total_tris(objs=None):
    return sum(tri_count(o.data) for o in (objs if objs is not None else mesh_objects()))


def principled(mat):
    if not mat or not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def socket(node, *names):
    for n in names:
        s = node.inputs.get(n)
        if s is not None:
            return s
    return None


def image_behind(sock, depth=6):
    """The first image texture feeding a socket (through mix, separate and normal-map nodes)"""
    if sock is None or not sock.is_linked or depth == 0:
        return None
    node = sock.links[0].from_node
    if node.type == "TEX_IMAGE":
        return node.image
    for s in node.inputs:
        img = image_behind(s, depth - 1)
        if img:
            return img
    return None


def import_glb(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    kw = {"filepath": path}
    props = bpy.ops.import_scene.gltf.get_rna_type().properties.keys()
    # Vertices the file split at UV seams and hard edges are welded again, so that "loose part" means a real part
    if "merge_vertices" in props:
        kw["merge_vertices"] = True
    bpy.ops.import_scene.gltf(**kw)
    log(f"imported {os.path.basename(path)}: {len(bpy.data.objects)} objects, {total_tris()} triangles")


# --------------------------------------------------------------------------------------------------------------------
# 1. Report


def material_report(mat):
    out = {"name": mat.name}
    p = principled(mat)
    if not p:
        return out
    textures = []
    for s in p.inputs:
        img = image_behind(s)
        if img:
            textures.append({"input": s.name, "image": img.name, "size": [img.size[0], img.size[1]]})
    base = socket(p, "Base Color")
    alpha = socket(p, "Alpha")
    em = socket(p, "Emission Strength")
    emc = socket(p, "Emission Color", "Emission")
    out.update(
        baseColor=[round(float(v), 4) for v in base.default_value] if base else None,
        metallic=round(float(socket(p, "Metallic").default_value), 3),
        roughness=round(float(socket(p, "Roughness").default_value), 3),
        alpha=round(float(alpha.default_value), 3) if alpha else 1.0,
        alphaTextured=bool(alpha and alpha.is_linked),
        emissionStrength=round(float(em.default_value), 3) if em else 0.0,
        emissionColor=[round(float(v), 4) for v in emc.default_value] if emc else None,
        textures=textures,
    )
    return out


def write_mesh_report(path, source):
    nodes = []
    for o in bpy.data.objects:
        entry = {
            "name": o.name,
            "type": o.type,
            "parent": o.parent.name if o.parent else None,
            "hidden": bool(o.hide_viewport or o.hide_render or o.hide_get()),
            "animated": bool(o.animation_data and o.animation_data.action),
        }
        if o.type == "MESH":
            w = verts_of(o.data)
            if len(w):
                m = np.array(o.matrix_world)
                w = w @ m[:3, :3].T + m[:3, 3]
                entry["bboxMin"] = [round(float(v), 4) for v in w.min(axis=0)]
                entry["bboxMax"] = [round(float(v), 4) for v in w.max(axis=0)]
            entry["triangles"] = tri_count(o.data)
            entry["vertices"] = len(o.data.vertices)
            entry["materials"] = [s.material.name if s.material else None for s in o.material_slots]
        nodes.append(entry)
    actions = []
    for a in bpy.data.actions:
        fr = a.frame_range
        actions.append({"name": a.name, "frames": [float(fr[0]), float(fr[1])], "curves": len(getattr(a, "fcurves", []) or [])})
    images = [{"name": i.name, "size": [i.size[0], i.size[1]], "bytes": (i.packed_file.size if i.packed_file else None)} for i in bpy.data.images]
    report = {
        "source": os.path.basename(source),
        "sourceBytes": os.path.getsize(source),
        "frame": "as imported by Blender: +Z up, units as authored",
        "objects": len(nodes),
        "meshObjects": sum(1 for n in nodes if n["type"] == "MESH"),
        "triangles": sum(n.get("triangles", 0) for n in nodes),
        "animations": actions,
        "materials": [material_report(m) for m in bpy.data.materials],
        "images": images,
        "nodes": nodes,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as f:
        json.dump(report, f, indent=1)
    log(f"mesh report: {path} ({report['meshObjects']} meshes, {report['triangles']} triangles, {len(actions)} animations, {len(report['materials'])} materials)")
    return report


# --------------------------------------------------------------------------------------------------------------------
# 2. Animations, props, transforms


def strip_and_flatten(rest_frame, drop_re):
    scene = bpy.context.scene
    # Without --rest-frame nothing is evaluated: the nodes' own transforms are the pose (doors shut, jacks up)
    if rest_frame is not None:
        scene.frame_set(rest_frame)
    bpy.context.view_layer.update()
    world = {o.name: o.matrix_world.copy() for o in bpy.data.objects}

    def path_of(o):
        names = []
        while o:
            names.append(o.name)
            o = o.parent
        return " / ".join(reversed(names))

    paths = {o.name: path_of(o) for o in bpy.data.objects}
    for o in bpy.data.objects:
        o.animation_data_clear()
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)

    drop = re.compile(drop_re, re.I) if drop_re else None
    dropped = []
    keep = []
    for o in list(bpy.data.objects):
        hidden = o.hide_viewport or o.hide_render or o.hide_get()
        named = bool(drop and (drop.search(paths[o.name]) or any(s.material and drop.search(s.material.name) for s in o.material_slots)))
        if o.type != "MESH" or hidden or named or len(o.data.polygons) == 0:
            if o.type == "MESH" and (hidden or named):
                dropped.append(paths[o.name])
            continue
        keep.append(o)
    for o in keep:
        if o.data.users > 1:
            o.data = o.data.copy()
        o.modifiers.clear()
        # The file's own shading normals go: mirrored halves carry them pointing inward, and decimation redoes them
        custom = o.data.attributes.get("custom_normal")
        if custom is not None:
            o.data.attributes.remove(custom)
        o["src_path"] = paths[o.name]  # the names of the groups it sat in, which say what it is
        m = world[o.name]
        o.parent = None
        o.data.transform(m)
        if m.determinant() < 0:
            o.data.flip_normals()
        o.matrix_world = Matrix.Identity(4)
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    if dropped:
        log(f"dropped {len(dropped)} hidden or prop objects: {', '.join(dropped[:12])}{' ...' if len(dropped) > 12 else ''}")
    return dropped


def transform_all(m):
    for o in mesh_objects():
        o.data.transform(m)
        o.data.update()


def fix_inverted(z_mid):
    """Objects modelled inside out (a mirrored half whose faces were never turned, hidden in the source by
    double-sided materials): turned when most of their area faces the car's long axis. Frame: length along Y."""
    turned = []
    for o in mesh_objects():
        me = o.data
        n = len(me.polygons)
        if n < 8:
            continue
        c = np.empty(n * 3, dtype=np.float32)
        me.polygons.foreach_get("center", c)
        c = c.reshape(-1, 3)
        nr = np.empty(n * 3, dtype=np.float32)
        me.polygons.foreach_get("normal", nr)
        nr = nr.reshape(-1, 3)
        area = np.empty(n, dtype=np.float32)
        me.polygons.foreach_get("area", area)
        out = c[:, 0] * nr[:, 0] + (c[:, 2] - z_mid) * nr[:, 2]
        # Only parts that sit clear of the axis say anything (a hub or a spine part faces every way)
        far = np.hypot(c[:, 0], c[:, 2] - z_mid) > 0.25
        if area[far].sum() < 0.02:
            continue
        share = float((area[far] * (out[far] > 0)).sum() / area[far].sum())
        if share < 0.3:
            me.flip_normals()
            me.update()
            turned.append(o.get("src_path", o.name).split(" / ")[-1])
    return turned


def scene_bounds():
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for o in mesh_objects():
        v = verts_of(o.data)
        if len(v):
            lo = np.minimum(lo, v.min(axis=0))
            hi = np.maximum(hi, v.max(axis=0))
    return lo, hi


# --------------------------------------------------------------------------------------------------------------------
# 3. Loose parts and wheels


def vertex_components(n, edges):
    """Label of the loose part each vertex belongs to (0..k-1)"""
    lab = np.arange(n, dtype=np.int64)
    if len(edges):
        a, b = edges[:, 0], edges[:, 1]
        while True:
            la, lb = lab[a], lab[b]
            m = np.minimum(la, lb)
            new = lab.copy()
            np.minimum.at(new, la, m)
            np.minimum.at(new, lb, m)
            while True:
                nn = new[new]
                if np.array_equal(nn, new):
                    break
                new = nn
            if np.array_equal(new, lab):
                break
            lab = new
    _, inv = np.unique(lab, return_inverse=True)
    return inv


def reduce_by(labels, values, k, fn):
    order = np.argsort(labels, kind="stable")
    sl = labels[order]
    starts = np.flatnonzero(np.r_[True, sl[1:] != sl[:-1]])
    out = fn.reduceat(values[order], starts, axis=0)
    full = np.zeros((k,) + values.shape[1:], dtype=values.dtype)
    full[sl[starts]] = out
    return full


class Parts:
    """Every loose part of every mesh object: its box, centroid and the object it lives in"""

    def __init__(self):
        self.objs = mesh_objects()
        self.vert_part = []  # per object: global part id of each vertex
        obj_of, lo, hi, cen = [], [], [], []
        offset = 0
        for oi, o in enumerate(self.objs):
            me = o.data
            v = verts_of(me)
            e = np.empty(len(me.edges) * 2, dtype=np.int32)
            me.edges.foreach_get("vertices", e)
            lab = vertex_components(len(v), e.reshape(-1, 2).astype(np.int64))
            k = int(lab.max()) + 1 if len(lab) else 0
            self.vert_part.append(lab + offset)
            if k:
                lo.append(reduce_by(lab, v, k, np.minimum))
                hi.append(reduce_by(lab, v, k, np.maximum))
                cnt = np.bincount(lab, minlength=k)[:, None]
                cen.append(reduce_by(lab, v, k, np.add) / np.maximum(cnt, 1))
                obj_of.append(np.full(k, oi))
            offset += k
        self.count = offset
        self.obj_of = np.concatenate(obj_of) if obj_of else np.zeros(0, dtype=int)
        self.lo = np.concatenate(lo) if lo else np.zeros((0, 3))
        self.hi = np.concatenate(hi) if hi else np.zeros((0, 3))
        self.centroid = np.concatenate(cen) if cen else np.zeros((0, 3))


def find_wheels(parts, name_re=r"wheel|tyre|tire"):
    """Four round loose parts standing on the floor, one per quadrant: centre, radius and half width of each.
    Frame: length along Y, Z up. Falls back to whole objects named as wheels."""
    lo, hi = parts.lo, parts.hi
    glo, ghi = lo.min(axis=0), hi.max(axis=0)
    length = ghi[1] - glo[1]
    floor = glo[2]
    d = hi - lo

    def pick(c_lo, c_hi):
        dd = c_hi - c_lo
        dia = np.maximum(dd[:, 1], dd[:, 2])
        ok = (
            (c_lo[:, 2] - floor < 0.012 * length)
            & (np.abs(dd[:, 1] - dd[:, 2]) < 0.10 * dia)
            & (dia > 0.09 * length)
            & (dia < 0.20 * length)
            & (dd[:, 0] > 0.20 * dia)
            & (dd[:, 0] < 0.85 * dia)
        )
        mid = 0.5 * (glo + ghi)
        cx = 0.5 * (c_lo[:, 0] + c_hi[:, 0])
        cy = 0.5 * (c_lo[:, 1] + c_hi[:, 1])
        found = {}
        for qx in (-1, 1):
            for qy in (-1, 1):
                idx = np.flatnonzero(ok & (np.sign(cx - mid[0]) == qx) & (np.sign(cy - mid[1]) == qy))
                if len(idx):
                    i = idx[np.argmax(dia[idx])]
                    found[(qx, qy)] = {
                        "centre": 0.5 * (c_lo[i] + c_hi[i]),
                        "radius": 0.5 * float(dia[i]),
                        "half": 0.5 * float(dd[i, 0]),
                        "bottom": float(c_lo[i, 2]),
                    }
        return found

    wheels = pick(lo, hi)
    how = "loose parts on the floor"
    if len(wheels) < 4:
        rx = re.compile(name_re, re.I)
        o_lo, o_hi = [], []
        for oi, o in enumerate(parts.objs):
            if rx.search(o.get("src_path", o.name)):
                sel = parts.obj_of == oi
                if sel.any():
                    o_lo.append(lo[sel].min(axis=0))
                    o_hi.append(hi[sel].max(axis=0))
        if o_lo:
            wheels = pick(np.array(o_lo), np.array(o_hi))
            how = "objects named as wheels"
    if len(wheels) < 4:
        raise SystemExit(
            f"[lmdh] found {len(wheels)} of 4 wheels. Read the mesh report for how the wheels are built "
            "(one welded mesh, or a prop under the car that --drop should remove) and adjust."
        )
    return wheels, how


def nose_votes(wheels, glo, ghi):
    """+1: the nose is at -Y already; -1: at +Y. From tyre widths (rear wider) and overhangs (front longer)."""
    lo_y = [w for (qx, qy), w in wheels.items() if qy < 0]
    hi_y = [w for (qx, qy), w in wheels.items() if qy > 0]
    half_lo = np.mean([w["half"] for w in lo_y])
    half_hi = np.mean([w["half"] for w in hi_y])
    y_lo = np.mean([w["centre"][1] for w in lo_y])
    y_hi = np.mean([w["centre"][1] for w in hi_y])
    over_lo = y_lo - glo[1]
    over_hi = ghi[1] - y_hi
    votes = {
        "tyreWidth": 0 if abs(half_hi / half_lo - 1) < 0.06 else (1 if half_hi > half_lo else -1),
        "overhang": 0 if abs(over_lo - over_hi) < 0.02 * (ghi[1] - glo[1]) else (1 if over_lo > over_hi else -1),
    }
    decision = votes["tyreWidth"] or votes["overhang"] or 1
    return decision, votes


# --------------------------------------------------------------------------------------------------------------------
# 5. Buckets


def face_first_vertex(me):
    ls = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", ls)
    lv = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", lv)
    return lv[ls], ls, lv


def split_object(obj, face_bucket, names):
    """One object per bucket present among the object's faces; returns {bucket name: object}"""
    out = {}
    present = np.unique(face_bucket)
    if len(present) == 1:
        out[names[int(present[0])]] = obj
        return out
    for b in present:
        dup = obj.copy()
        dup.data = obj.data.copy()
        bpy.context.scene.collection.objects.link(dup)
        bm = bmesh.new()
        bm.from_mesh(dup.data)
        bm.faces.ensure_lookup_table()
        gone = [f for f in bm.faces if face_bucket[f.index] != b]
        bmesh.ops.delete(bm, geom=gone, context="FACES")
        bm.to_mesh(dup.data)
        bm.free()
        out[names[int(b)]] = dup
    bpy.data.objects.remove(obj, do_unlink=True)
    return out


def join(objs, name):
    if not objs:
        return None
    target = objs[0]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=target, object=target, selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
    target.name = name
    target.data.name = name
    return target


def assign_buckets(parts, wheels_final, steer_re, no_steer):
    """wheels_final: {corner: centre (x, y, z), radius, half}. Returns {bucket: [objects]} after splitting."""
    names = ["BODY", "STEER", "DROP"] + [f"WHEEL_{c}_RIM" for c in CORNERS] + [f"WHEEL_{c}_TYRE" for c in CORNERS]
    idx = {n: i for i, n in enumerate(names)}
    steer_rx = re.compile(steer_re, re.I) if steer_re and not no_steer else None
    buckets = {n: [] for n in names}
    stats = {c: {"tyreParts": 0, "rimParts": 0, "offAxisParts": 0, "radialSplit": False} for c in CORNERS}

    for oi, o in enumerate(parts.objs):
        me = o.data
        v = verts_of(me)
        lab_global = parts.vert_part[oi]
        base = int(lab_global.min()) if len(lab_global) else 0
        lab = lab_global - base
        k = int(lab.max()) + 1 if len(lab) else 0
        part_bucket = np.full(k, idx["BODY"])
        vert_bucket_override = None
        if steer_rx and steer_rx.search(o.get("src_path", o.name)):
            part_bucket[:] = idx["STEER"]
        elif k:
            p_lo = parts.lo[base : base + k]
            p_hi = parts.hi[base : base + k]
            p_cen = parts.centroid[base : base + k]
            for c in CORNERS:
                w = wheels_final[c]
                cx, cy, cz = w["centre"]
                R, hw = w["radius"], w["half"]
                near = (p_lo[:, 0] > cx - 1.25 * hw) & (p_hi[:, 0] < cx + 1.25 * hw) & (p_lo[:, 1] > cy - 1.1 * R) & (p_hi[:, 1] < cy + 1.1 * R) & (p_hi[:, 2] < cz + 1.1 * R)
                if not near.any():
                    continue
                radial = np.hypot(v[:, 1] - cy, v[:, 2] - cz)
                rmax = reduce_by(lab, radial, k, np.maximum)
                rmin = reduce_by(lab, radial, k, np.minimum)
                off = np.hypot(p_cen[:, 1] - cy, p_cen[:, 2] - cz)
                inside = near & (rmax <= 1.03 * R)
                tyre = inside & (rmin > 0.55 * R) & (rmax > 0.90 * R)
                spins = inside & ~tyre & (off <= 0.20 * R)
                whole = spins & (rmax > 0.90 * R)  # tyre and rim welded into one part: cut by radius below
                part_bucket[tyre] = idx[f"WHEEL_{c}_TYRE"]
                part_bucket[spins] = idx[f"WHEEL_{c}_RIM"]
                stats[c]["tyreParts"] += int(tyre.sum())
                stats[c]["rimParts"] += int(spins.sum())
                stats[c]["offAxisParts"] += int((inside & ~tyre & ~spins).sum())
                if whole.any():
                    stats[c]["radialSplit"] = True
                    if vert_bucket_override is None:
                        vert_bucket_override = np.full(len(v), -1)
                    sel = whole[lab] & (radial > 0.69 * R)
                    vert_bucket_override[sel] = idx[f"WHEEL_{c}_TYRE"]

        first, ls, lv = face_first_vertex(me)
        face_bucket = part_bucket[lab[first]] if k else np.zeros(len(me.polygons), dtype=int)
        if vert_bucket_override is not None:
            # A face goes to the tyre when all its corners are beyond the rim's edge
            lt = np.empty(len(me.polygons), dtype=np.int32)
            me.polygons.foreach_get("loop_total", lt)
            per_loop = vert_bucket_override[lv]
            face_min = np.minimum.reduceat(per_loop, ls)
            face_max = np.maximum.reduceat(per_loop, ls)
            cut = (face_min >= 0) & (face_min == face_max)
            face_bucket = np.where(cut, face_min, face_bucket)
        for name, obj in split_object(o, face_bucket, names).items():
            buckets[name].append(obj)
    return buckets, stats


# --------------------------------------------------------------------------------------------------------------------
# 6. Paint


def new_material(name):
    m = bpy.data.materials.new(name)
    if not m.node_tree:
        m.use_nodes = True
    return m


class Palette:
    """The output's own materials. Nothing of the source's survives but a kept texture or a light's emission."""

    def __init__(self, opts):
        self.cache = {}
        self.opts = opts
        self.weave = None
        self.counter = {}

    def flat(self, name, rgb, metallic, roughness, alpha=1.0, coat=0.0, emission=None):
        if name in self.cache:
            return self.cache[name]
        m = new_material(name)
        p = principled(m)
        socket(p, "Base Color").default_value = (*rgb, 1.0)
        socket(p, "Metallic").default_value = metallic
        socket(p, "Roughness").default_value = roughness
        if alpha < 1.0:
            socket(p, "Alpha").default_value = alpha
            if hasattr(m, "surface_render_method"):
                m.surface_render_method = "BLENDED"
            elif hasattr(m, "blend_method"):
                m.blend_method = "BLEND"
        c = socket(p, "Coat Weight", "Clearcoat")
        if c is not None and coat:
            c.default_value = coat
            # A satin coat: a mirror-clear one turns a flat panel (the fin, an endplate) into a mirror of the car
            cr = socket(p, "Coat Roughness", "Clearcoat Roughness")
            if cr is not None:
                cr.default_value = 0.3
        if emission:
            socket(p, "Emission Color", "Emission").default_value = (*emission[0], 1.0)
            socket(p, "Emission Strength").default_value = emission[1]
        self.cache[name] = m
        return m

    def paint(self, zone="primary"):
        rgb = {"primary": self.opts.paint_rgb, "accent": self.opts.accent_rgb, "secondary": self.opts.secondary_rgb}[zone]
        return self.flat(f"paint_{zone}", rgb, 0.0, 0.42, coat=1.0)

    def tyre(self):
        return self.flat("tyre_rubber", (0.02, 0.02, 0.022), 0.0, 0.9)

    def rim(self):
        return self.flat("rim_alloy", (0.05, 0.052, 0.056), 0.85, 0.36)

    def disc(self):
        return self.flat("brake_disc", (0.075, 0.075, 0.08), 0.3, 0.6)

    def carbon(self):
        if "carbon_weave" in self.cache:
            return self.cache["carbon_weave"]
        m = self.flat("carbon_weave", (0.05, 0.05, 0.055), 0.0, 0.4, coat=0.6)
        p = principled(m)
        tex = m.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = self.weave_image()
        tex.extension = "REPEAT"
        m.node_tree.links.new(tex.outputs["Color"], socket(p, "Base Color"))
        return m

    def weave_image(self, size=256, tows=8):
        """2x2 twill: every tow passes over two and under two, each row stepped one across"""
        if self.weave:
            return self.weave
        cell = size // tows
        y, x = np.mgrid[0:size, 0:size]
        ci, cj = x // cell, y // cell
        warp = ((ci + cj) % 4) < 2
        fx = (x % cell) / cell - 0.5
        fy = (y % cell) / cell - 0.5
        across = np.where(warp, fx, fy)  # brightness falls off across the tow, toward its edges
        along = np.where(warp, fy, fx)
        shade = 0.10 + 0.14 * np.cos(across * math.pi) ** 2 * (0.75 + 0.25 * np.cos(along * math.pi))
        shade = np.where(warp, shade, shade * 0.62)
        rgba = np.dstack([shade, shade, shade * 1.04, np.ones_like(shade)]).astype(np.float32)
        img = bpy.data.images.new("carbon_weave", size, size, alpha=False)
        img.pixels.foreach_set(rgba.ravel())
        img.pack()
        self.weave = img
        return img

    def numbered(self, kind, rgb, metallic, roughness, alpha=1.0, emission=None, image=None):
        key = (kind, tuple(round(float(c), 2) for c in rgb), round(metallic, 1), round(roughness, 1), round(alpha, 2), None if not emission else (tuple(round(float(c), 2) for c in emission[0]), round(emission[1], 1)), image.name if image else None)
        if key in self.cache:
            return self.cache[key]
        self.counter[kind] = self.counter.get(kind, 0) + 1
        m = self.flat(f"{kind}_{self.counter[kind]:03d}", rgb, metallic, roughness, alpha, emission=emission)
        if image:
            tex = m.node_tree.nodes.new("ShaderNodeTexImage")
            tex.image = image
            m.node_tree.links.new(tex.outputs["Color"], socket(principled(m), "Base Color"))
        self.cache[key] = m
        return m


_tex_stats = {}


def texture_stats(img):
    """Mean colour (linear), spread of the stored values and mean alpha of an image"""
    if not img or img.size[0] == 0:
        return None
    if img.name in _tex_stats:
        return _tex_stats[img.name]
    ch = img.channels
    px = np.empty(img.size[0] * img.size[1] * ch, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, ch)
    rgb = px[:, :3] if ch >= 3 else np.repeat(px[:, :1], 3, axis=1)
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    out = {
        "mean": tuple(float(v) for v in lin.mean(axis=0)),
        "spread": float(rgb.std(axis=0).max()),
        "alpha": float(px[:, 3].mean()) if ch == 4 else 1.0,
        "size": max(img.size[0], img.size[1]),
    }
    _tex_stats[img.name] = out
    return out


def scrub_images(specs):
    """--scrub IMAGE:x0,y0,x1,y1 paints a rectangle black (pixels from the top left, as an image viewer shows them)"""
    done = []
    for spec in specs or []:
        name, rect = spec.split(":")[:2]
        img = bpy.data.images.get(name)
        if not img:
            log(f"warning: --scrub image {name} not found")
            continue
        x0, y0, x1, y1 = (int(v) for v in rect.split(","))
        w, h = img.size
        px = np.empty(w * h * img.channels, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(h, w, img.channels)
        px[h - y1 : h - y0, x0:x1, :3] = 0.0
        img.pixels.foreach_set(px.ravel())
        img.pack()
        done.append(spec)
    return done


def classify(mat, opts):
    """What a source material becomes: (class, data). Classes: light, glass, tyre, carbon, keep (its texture stays),
    interior, metal, mirror, part (flat colour) and livery (a painted panel)."""
    if mat is None:
        return "livery", None
    p = principled(mat)
    name = mat.name
    if not p:
        return "livery", None
    base = socket(p, "Base Color")
    alpha = socket(p, "Alpha")
    em_s = socket(p, "Emission Strength")
    em_c = socket(p, "Emission Color", "Emission")
    rough = float(socket(p, "Roughness").default_value)
    img = image_behind(base)
    st = texture_stats(img)
    rgb = st["mean"] if st else tuple(float(v) for v in base.default_value[:3])
    flat = st is None or st["spread"] < 0.04 or st["size"] <= 64
    if em_s and em_c and float(em_s.default_value) > 0 and (em_c.is_linked or max(em_c.default_value[:3]) > 0.01):
        return "light", (rgb, (tuple(float(v) for v in em_c.default_value[:3]), float(em_s.default_value)))
    a = float(alpha.default_value) if alpha else 1.0
    if alpha is not None and alpha.is_linked and st:
        a = st["alpha"]
    # An alpha channel that is empty or full is not coverage (converted models keep other masks there)
    see_through = 0.02 < a < 0.98
    if GLASS_RE.search(name) or (see_through and not INTERIOR_RE.search(name) and not METAL_RE.search(name)):
        return "glass", ((0.03, 0.035, 0.04) if not flat else rgb, min(max(a, 0.25), 0.5))
    if opts.drop_mats and re.search(opts.drop_mats, name, re.I):
        return "decal", None
    if opts.livery_mats and re.search(opts.livery_mats, name, re.I):
        return "livery", None
    if TYRE_RE.search(name):
        return "tyre", None
    if CARBON_RE.search(name):
        return "carbon", None
    if not flat and opts.keep_tex and re.search(opts.keep_tex, name, re.I):
        return "keep", (img, max(rough, 0.3), bool(INTERIOR_RE.search(name)))
    if MIRROR_RE.search(name):
        return "mirror", (rgb,)
    if METAL_RE.search(name) or DISC_RE.search(name):
        return "metal", (rgb, 0.8, max(rough, 0.25))
    if INTERIOR_RE.search(name):
        return "interior", (rgb, 0.0, max(rough, 0.45))
    if flat and not PAINT_RE.search(name):
        return "part", (rgb, 0.0, max(rough, 0.4))
    return "livery", None


def set_box_uvs(me, faces_mask, scale):
    """Box-projected UVs (metres * scale) for the masked faces, so the weave tiles at one size everywhere"""
    if not faces_mask.any():
        return
    uv_layer = me.uv_layers.active or me.uv_layers.new(name="UVMap")
    n_loops = len(me.loops)
    uv = np.empty(n_loops * 2, dtype=np.float32)
    uv_layer.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    lt = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_total", lt)
    nrm = np.empty(len(me.polygons) * 3, dtype=np.float32)
    me.polygons.foreach_get("normal", nrm)
    nrm = nrm.reshape(-1, 3)
    loop_face = np.repeat(np.arange(len(me.polygons)), lt)
    lv = np.empty(n_loops, dtype=np.int32)
    me.loops.foreach_get("vertex_index", lv)
    co = verts_of(me)[lv]
    axis = np.argmax(np.abs(nrm), axis=1)[loop_face]
    u = np.where(axis == 0, co[:, 1], co[:, 0])
    w = np.where(axis == 2, co[:, 1], co[:, 2])
    sel = faces_mask[loop_face]
    uv[sel, 0] = u[sel] * scale
    uv[sel, 1] = w[sel] * scale
    uv_layer.data.foreach_set("uv", uv.ravel())


def repaint(obj, role, palette, opts, summary):
    """Replace the object's materials. role: BODY, STEER, RIM or TYRE."""
    me = obj.data
    nfaces = len(me.polygons)
    if nfaces == 0:
        return
    mi = np.empty(nfaces, dtype=np.int32)
    me.polygons.foreach_get("material_index", mi)
    old = [s.material for s in obj.material_slots] or [None]
    mi = np.clip(mi, 0, len(old) - 1)
    if role == "TYRE":
        me.materials.clear()
        me.materials.append(palette.tyre())
        me.polygons.foreach_set("material_index", np.zeros(nfaces, dtype=np.int32))
        return

    centre = np.empty(nfaces * 3, dtype=np.float32)
    me.polygons.foreach_get("center", centre)
    centre = centre.reshape(-1, 3)
    normal = np.empty(nfaces * 3, dtype=np.float32)
    me.polygons.foreach_get("normal", normal)
    normal = normal.reshape(-1, 3)

    new_mats = []
    new_index = np.zeros(nfaces, dtype=np.int32)
    drop = np.zeros(nfaces, dtype=bool)
    carbon_faces = np.zeros(nfaces, dtype=bool)

    def slot(mat):
        if mat not in new_mats:
            new_mats.append(mat)
        return new_mats.index(mat)

    for si, mat in enumerate(old):
        faces = mi == si
        if not faces.any():
            continue
        kind, data = classify(mat, opts)
        name = mat.name if mat else "(none)"
        if role == "RIM" and kind not in ("light", "glass"):
            kind = "disc" if (mat and DISC_RE.search(mat.name)) else "rim"
        summary["materials"].setdefault(name, {})[role] = [kind, int(faces.sum())]
        if kind == "light":
            new_index[faces] = slot(palette.numbered("light", data[0], 0.0, 0.3, emission=data[1]))
        elif kind == "glass":
            new_index[faces] = slot(palette.numbered("glass", data[0], 0.0, 0.05, data[1]))
        elif kind == "rim":
            new_index[faces] = slot(palette.rim())
        elif kind == "disc":
            new_index[faces] = slot(palette.disc())
        elif kind == "decal":
            drop |= faces
        elif kind == "tyre":
            new_index[faces] = slot(palette.tyre())
        elif kind == "carbon":
            new_index[faces] = slot(palette.carbon())
            carbon_faces |= faces
        elif kind == "keep":
            new_index[faces] = slot(palette.numbered("interior" if (data[2] or role == "STEER") else "part", (0.8, 0.8, 0.8), 0.0, data[1], image=data[0]))
        elif kind == "mirror":
            new_index[faces] = slot(palette.numbered("mirror", data[0], 1.0, 0.03))
        elif kind in ("metal", "part", "interior"):
            if kind == "part" and role == "BODY" and max(data[0]) < opts.carbon_darker_than:
                # Bare dark panels of the body are the exposed carbon
                new_index[faces] = slot(palette.carbon())
                carbon_faces |= faces
            else:
                new_index[faces] = slot(palette.numbered("interior" if role == "STEER" and kind == "part" else kind, *data))
        elif role == "STEER":
            new_index[faces] = slot(palette.numbered("interior", (0.03, 0.03, 0.032), 0.0, 0.6))
        else:
            # Painted panel. Its lowest strip becomes carbon later, cut along a plane (paint_zones)
            new_index[faces] = slot(palette.paint())

    set_box_uvs(me, carbon_faces, 1.0 / opts.weave_m)
    me.materials.clear()
    for m in new_mats or [palette.paint()]:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", new_index)
    if drop.any():
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if drop[f.index]], context="FACES")
        bm.to_mesh(me)
        bm.free()
        summary["facesDropped"] += int(drop.sum())
    me.update()


def paint_zones(body, palette, opts):
    """The livery, cut into the painted panels along planes so its edges are clean: the strip below
    `--carbon-below` is bare carbon, then a centre stripe from nose to tail and two raked bands across the flanks
    and engine cover. Frame: x left, y rearward, z up, metres."""
    me = body.data
    names = [m.name if m else "" for m in me.materials]
    if "paint_primary" not in names:
        return {}
    primary = names.index("paint_primary")
    rake = opts.band_rake
    n = Vector((0.0, 1.0, -rake)).normalized()
    b0, b1, b2, b3 = opts.bands
    cuts = [(Vector((0, 0, opts.carbon_below)), Vector((0, 0, 1)))]
    if not opts.plain:
        cuts += [(Vector((s * opts.stripe_half, 0, 0)), Vector((1, 0, 0))) for s in (-1, 1)]
        cuts += [(Vector((0, t, 0)), n) for t in (b0, b1, b2, b3)]
    bm = bmesh.new()
    bm.from_mesh(me)
    for co, no in cuts:
        faces = [f for f in bm.faces if f.material_index == primary]
        geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no, clear_inner=False, clear_outer=False)
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()

    def index_of(mat):
        if mat.name not in names:
            me.materials.append(mat)
            names.append(mat.name)
        return names.index(mat.name)

    carbon = index_of(palette.carbon())
    accent = index_of(palette.paint("accent"))
    secondary = index_of(palette.paint("secondary"))
    count = {"carbon": 0, "accent": 0, "secondary": 0}
    to_carbon = np.zeros(len(bm.faces), dtype=bool)
    for f in bm.faces:
        if f.material_index != primary:
            continue
        c = f.calc_center_median()
        t = c.y - rake * c.z
        if c.z < opts.carbon_below:
            f.material_index = carbon
            to_carbon[f.index] = True
            count["carbon"] += 1
        elif opts.plain:
            continue
        elif abs(c.x) < opts.stripe_half or b0 < t < b1:
            f.material_index = accent
            count["accent"] += 1
        elif b2 < t < b3:
            f.material_index = secondary
            count["secondary"] += 1
    bm.to_mesh(me)
    bm.free()
    me.update()
    set_box_uvs(me, to_carbon, 1.0 / opts.weave_m)
    return count


# --------------------------------------------------------------------------------------------------------------------
# 7. Budget, rig, export


def split_cabin(body):
    """The body as two objects: the outside (paint, carbon, glass, lights) and the rest (cabin trim, metal, small
    parts), so the cabin can give up its triangles before the outline does. Returns (outside, cabin or None)."""
    me = body.data
    mi = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("material_index", mi)
    cabin = np.array([bool(m and re.match(r"interior|metal|mirror|part", m.name)) for m in me.materials] or [False])
    bucket = cabin[np.clip(mi, 0, len(cabin) - 1)].astype(int)
    parts = split_object(body, bucket, ["outside", "cabin"])
    return parts.get("outside"), parts.get("cabin")


def decimate(obj, ratio):
    ratio = float(min(1.0, max(0.02, ratio)))
    if ratio >= 0.999:
        return
    mod = obj.modifiers.new("budget", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    obj.modifiers.clear()
    obj.data = new
    bpy.data.meshes.remove(old)
    new.name = obj.name


def smooth(obj, angle_deg=38.0):
    me = obj.data
    me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
    if hasattr(me, "set_sharp_from_angle"):
        me.set_sharp_from_angle(angle=math.radians(angle_deg))
    me.update()


def fit_budget(rig_meshes, lo, hi, tyre_cap, rim_cap, steer_cap, cabin_cap):
    """Triangles into [lo, hi]: wheels to their caps first, then the body takes what is left"""
    before = total_tris(list(rig_meshes.values()))
    touched = True  # normals are always rebuilt: the source's were dropped
    for name, o in rig_meshes.items():
        cap = tyre_cap if name.endswith("_TYRE") else rim_cap if name.endswith("_RIM") else steer_cap if name == "STEER" else None
        if cap:
            n = tri_count(o.data)
            if n > cap:
                decimate(o, cap / n)
                touched = True
    body = rig_meshes.get("BODY")
    target = 0.5 * (lo + hi) + 0.25 * (hi - lo)
    if body is not None and total_tris(list(rig_meshes.values())) > hi:
        outside, cabin = split_cabin(body)
        rest = sum(tri_count(o.data) for n, o in rig_meshes.items() if n != "BODY")
        if cabin is not None and tri_count(cabin.data) > cabin_cap:
            decimate(cabin, cabin_cap / tri_count(cabin.data))
        rest += tri_count(cabin.data) if cabin is not None else 0
        if outside is not None:
            for _ in range(3):
                n_out = tri_count(outside.data)
                if rest + n_out <= hi:
                    break
                decimate(outside, max(0.02, (target - rest) / n_out))
        body = join([o for o in (outside, cabin) if o is not None], "BODY")
        rig_meshes["BODY"] = body
    if touched:
        for o in rig_meshes.values():
            smooth(o)
    after = total_tris(list(rig_meshes.values()))
    return before, after


def cap_textures(limit):
    resized = []
    used = set()
    for m in bpy.data.materials:
        if m.users and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image:
                    used.add(n.image)
    for img in used:
        w, h = img.size
        if max(w, h) > limit:
            s = limit / max(w, h)
            img.scale(max(1, round(w * s)), max(1, round(h * s)))
            if img.packed_file:
                img.pack()
            resized.append([img.name, [w, h], [img.size[0], img.size[1]]])
    return resized


def steer_frame(obj):
    """Pivot and column axis of the steering wheel: its centre, and the thin axis of its points, toward the nose (-Y)"""
    v = verts_of(obj.data)
    pivot = 0.5 * (v.min(axis=0) + v.max(axis=0))
    _, _, vt = np.linalg.svd(v - v.mean(axis=0), full_matrices=False)
    col = vt[2] / np.linalg.norm(vt[2])
    if col[1] > 0:
        col = -col
    y_axis = -col  # glTF local +Z is Blender local -Y
    up = np.array([0.0, 0.0, 1.0])
    z_axis = up - up.dot(y_axis) * y_axis
    z_axis /= np.linalg.norm(z_axis)
    x_axis = np.cross(y_axis, z_axis)
    m = Matrix.Identity(4)
    for r in range(3):
        m[r][0], m[r][1], m[r][2], m[r][3] = x_axis[r], y_axis[r], z_axis[r], pivot[r]
    return m, pivot, col


def to_gltf(p):
    """Blender (x left, y rearward, z up) to the rig's glTF frame (+X left, +Y up, +Z forward)"""
    return [round(float(p[0]), 5), round(float(p[2]), 5), round(float(-p[1]), 5)]


def build_rig(buckets, wheels, opts, palette, summary):
    scene = bpy.context.scene
    car = bpy.data.objects.new("CAR", None)
    scene.collection.objects.link(car)
    rig = {}

    body = join(buckets["BODY"], "BODY")
    summary["bodyFaces"] = len(body.data.polygons) if body else 0
    if body:
        repaint(body, "BODY", palette, opts, summary)
        body.parent = car
        rig["BODY"] = body

    steer_info = None
    steer = join(buckets["STEER"], "STEER")
    if steer and len(steer.data.polygons):
        repaint(steer, "STEER", palette, opts, summary)
        m, pivot, col = steer_frame(steer)
        steer.data.transform(m.inverted())
        steer.matrix_world = m
        steer.parent = car
        rig["STEER"] = steer
        steer_info = {"pivot": to_gltf(pivot), "columnAxis": to_gltf(col)}

    for c in CORNERS:
        w = wheels[c]
        hub = bpy.data.objects.new(f"WHEEL_{c}", None)
        scene.collection.objects.link(hub)
        hub.parent = car
        hub.location = Vector(w["centre"])
        for part, role in (("RIM", "RIM"), ("TYRE", "TYRE")):
            o = join(buckets[f"WHEEL_{c}_{part}"], f"WHEEL_{c}_{part}")
            if not o:
                log(f"warning: WHEEL_{c}_{part} is empty")
                continue
            repaint(o, role, palette, opts, summary)
            # Geometry about the wheel's own measured axle; the pivot sits at the left/right symmetric centre
            o.data.transform(Matrix.Translation(-Vector(w["own"])))
            o.parent = hub
            o.matrix_parent_inverse = Matrix.Identity(4)
            o.location = (0, 0, 0)
            rig[o.name] = o
    for o in buckets["DROP"]:
        bpy.data.objects.remove(o, do_unlink=True)
    return car, rig, steer_info


def export_glb(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    want = {
        "filepath": path,
        "export_format": "GLB",
        "export_yup": True,
        "export_apply": False,
        "export_animations": False,
        "export_cameras": False,
        "export_lights": False,
        "export_extras": False,
        "export_skins": False,
        "export_morph": False,
        "export_image_format": "AUTO",
        "export_jpeg_quality": 90,
        "export_tangents": False,
        "use_selection": False,
    }
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    bpy.ops.export_scene.gltf(**{k: v for k, v in want.items() if k in props})


def patch_extras(path, extras):
    """Write the CAR node's extras and the asset's source into the GLB's JSON chunk"""
    with open(path, "rb") as f:
        data = f.read()
    magic, version, _ = struct.unpack_from("<4sII", data, 0)
    jlen, jtype = struct.unpack_from("<I4s", data, 12)
    if magic != b"glTF" or jtype != b"JSON":
        raise SystemExit("[lmdh] exported file is not a GLB")
    j = json.loads(data[20 : 20 + jlen])
    rest = data[20 + jlen :]
    names = [n.get("name") for n in j["nodes"]]
    if "CAR" not in names:
        raise SystemExit("[lmdh] exported GLB has no CAR node")
    j["nodes"][names.index("CAR")]["extras"] = extras
    j.setdefault("asset", {})["extras"] = extras["source"]
    for n in j["nodes"]:
        n.pop("extras", None) if n.get("name") != "CAR" else None
    body = json.dumps(j, separators=(",", ":"), default=float).encode("utf-8")
    body += b" " * (-len(body) % 4)
    out = struct.pack("<4sII", b"glTF", version, 12 + 8 + len(body) + len(rest)) + struct.pack("<I4s", len(body), b"JSON") + body + rest
    with open(path, "wb") as f:
        f.write(out)
    tris = 0
    for mesh in j.get("meshes", []):
        for prim in mesh["primitives"]:
            acc = j["accessors"][prim["indices"]] if "indices" in prim else j["accessors"][prim["attributes"]["POSITION"]]
            tris += acc["count"] // 3
    return {"nodes": names, "triangles": tris, "materials": [m.get("name") for m in j.get("materials", [])], "images": len(j.get("images", [])), "bytes": len(out)}


# --------------------------------------------------------------------------------------------------------------------


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="port_lmdh_body.py")
    ap.add_argument("source")
    ap.add_argument("out", nargs="?", default="public/cars/lc-lmdh/model/lc-lmdh.glb")
    ap.add_argument("--report", default="artifacts/lmdh_mesh_report.json")
    ap.add_argument("--hardpoints", default="artifacts/lmdh_hardpoints.json")
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--wheelbase", type=float, default=WHEELBASE_M)
    ap.add_argument("--rest-frame", type=int, default=None, help="freeze the animated parts at this frame (default: the nodes' own pose, animations ignored)")
    ap.add_argument("--drop", default=DROP_RE, help="regex of object or material names to delete (props, stands)")
    ap.add_argument("--steer", default=STEER_RE, help="regex of object or material names that make up the steering wheel")
    ap.add_argument("--no-steer", action="store_true")
    ap.add_argument("--flip-nose", action="store_true", help="the automatic front/rear decision is wrong: turn the car round")
    ap.add_argument("--paint", default="0.80,0.81,0.83", help="linear RGB of the painted panels")
    ap.add_argument("--accent", default="0.0,0.30,0.38", help="linear RGB of the centre stripe and the wide band")
    ap.add_argument("--secondary", default="0.02,0.022,0.026", help="linear RGB of the narrow band")
    ap.add_argument("--plain", action="store_true", help="one paint colour, no stripe or bands")
    ap.add_argument("--stripe-half", type=float, default=0.085, help="half width of the centre stripe (m)")
    ap.add_argument("--band-rake", type=float, default=0.9, help="how far the bands lean forward per metre of height")
    ap.add_argument("--bands", default="0.55,1.0,1.08,1.17", help="wide band from,to and narrow band from,to: y - rake * z (m)")
    ap.add_argument("--carbon-below", type=float, default=0.20, help="painted panels below this height (m) become carbon")
    ap.add_argument("--carbon-darker-than", type=float, default=0.06, help="flat body parts darker than this (linear) become carbon")
    ap.add_argument("--keep-tex", default=KEEP_TEX_RE, help="regex of source materials whose colour texture is kept")
    ap.add_argument("--livery-mats", default="", help="regex of source materials to treat as painted panels")
    ap.add_argument("--drop-mats", default="", help="regex of source materials whose faces are deleted")
    ap.add_argument("--scrub", action="append", help="IMAGE:x0,y0,x1,y1 black out a rectangle of a kept texture (repeatable)")
    ap.add_argument("--weave-m", type=float, default=0.064, help="size of one weave tile (m)")
    ap.add_argument("--tris", default="65000,95000", help="triangle budget: low,high")
    ap.add_argument("--tyre-tris", type=int, default=2200)
    ap.add_argument("--rim-tris", type=int, default=5200)
    ap.add_argument("--steer-tris", type=int, default=7000)
    ap.add_argument("--cabin-tris", type=int, default=9000, help="cap for the body's cabin trim, metal and small parts")
    ap.add_argument("--max-tex", type=int, default=2048)
    ap.add_argument("--compress", action="store_true", help="run scripts/compress-car-glb.mjs on the output")
    opts = ap.parse_args(argv)
    opts.paint_rgb = tuple(float(v) for v in opts.paint.split(","))
    opts.accent_rgb = tuple(float(v) for v in opts.accent.split(","))
    opts.secondary_rgb = tuple(float(v) for v in opts.secondary.split(","))
    opts.bands = tuple(float(v) for v in opts.bands.split(","))

    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import_glb(opts.source)
    raw = write_mesh_report(opts.report, opts.source)
    if opts.report_only:
        return

    dropped = strip_and_flatten(opts.rest_frame, opts.drop)

    # Length along Y
    lo, hi = scene_bounds()
    if (hi[0] - lo[0]) > (hi[1] - lo[1]):
        transform_all(Matrix.Rotation(math.pi / 2, 4, "Z"))
    parts = Parts()
    log(f"{parts.count} loose parts in {len(parts.objs)} objects")
    found, how = find_wheels(parts)
    glo, ghi = parts.lo.min(axis=0), parts.hi.max(axis=0)
    decision, votes = nose_votes(found, glo, ghi)
    if opts.flip_nose:
        decision = -decision
    turn = Matrix.Rotation(math.pi, 4, "Z") if decision < 0 else Matrix.Identity(4)

    def turned(p):
        return np.array(turn @ Vector(p))

    quads = {}
    for (qx, qy), w in found.items():
        c = turned(w["centre"])
        quads[("L" if c[0] > 0.5 * (turned(glo)[0] + turned(ghi)[0]) else "R") + ("F" if (qy * decision) < 0 else "R")] = {**w, "centre": c}
    front_y = 0.5 * (quads["LF"]["centre"][1] + quads["RF"]["centre"][1])
    rear_y = 0.5 * (quads["LR"]["centre"][1] + quads["RR"]["centre"][1])
    source_wheelbase = abs(rear_y - front_y)
    scale = opts.wheelbase / source_wheelbase
    mid_x = np.mean([w["centre"][0] for w in quads.values()])
    floor = min(w["bottom"] for w in quads.values())
    place = Matrix.Scale(scale, 4) @ Matrix.Translation((-mid_x, -0.5 * (front_y + rear_y), -floor)) @ turn
    transform_all(place)
    inverted = fix_inverted(0.45)
    if inverted:
        log(f"turned {len(inverted)} inside-out objects: {', '.join(inverted[:16])}{' ...' if len(inverted) > 16 else ''}")

    wheels = {}
    for axle, (l, r) in {"F": ("LF", "RF"), "R": ("LR", "RR")}.items():
        own = {k: np.array(Matrix.Scale(scale, 4) @ Matrix.Translation((-mid_x, -0.5 * (front_y + rear_y), -floor)) @ Vector(quads[k]["centre"])) for k in (l, r)}
        half_track = float(0.5 * (own[l][0] - own[r][0]))
        y = float(0.5 * (own[l][1] + own[r][1]))
        z = float(0.5 * (own[l][2] + own[r][2]))
        radius = float(0.5 * (quads[l]["radius"] + quads[r]["radius"]) * scale)
        half = float(0.5 * (quads[l]["half"] + quads[r]["half"]) * scale)
        wheels[l] = {"centre": (half_track, y, z), "own": own[l], "radius": radius, "half": half}
        wheels[r] = {"centre": (-half_track, y, z), "own": own[r], "radius": radius, "half": half}

    # Membership is tested about each wheel's own measured axle
    parts = Parts()
    measured = {c: {"centre": tuple(wheels[c]["own"]), "radius": wheels[c]["radius"], "half": wheels[c]["half"]} for c in CORNERS}
    buckets, wheel_stats = assign_buckets(parts, measured, opts.steer, opts.no_steer)

    scrubbed = scrub_images(opts.scrub)
    palette = Palette(opts)
    summary = {"materials": {}, "facesDropped": 0, "bodyFaces": 0}
    car, rig, steer_info = build_rig(buckets, wheels, opts, palette, summary)

    tri_lo, tri_hi = (int(v) for v in opts.tris.split(","))
    before, after = fit_budget(rig, tri_lo, tri_hi, opts.tyre_tris, opts.rim_tris, opts.steer_tris, opts.cabin_tris)
    zones = paint_zones(rig["BODY"], palette, opts) if "BODY" in rig else {}
    resized = cap_textures(opts.max_tex)
    try:
        bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    except TypeError:
        bpy.data.orphans_purge()

    lo, hi = scene_bounds_world(rig)
    length, width, height = hi[1] - lo[1], hi[0] - lo[0], hi[2]
    # The roof without aerials and the like: the highest loose part that is more than 0.3 m across
    wide = np.maximum(parts.hi[:, 0] - parts.lo[:, 0], parts.hi[:, 1] - parts.lo[:, 1]) > 0.3
    roof = float(parts.hi[wide, 2].max()) if wide.any() else float(height)
    front_axle, rear_axle = wheels["LF"]["centre"][1], wheels["LR"]["centre"][1]
    front_overhang, rear_overhang = front_axle - lo[1], hi[1] - rear_axle

    wheel_centres = {f"WHEEL_{c}": to_gltf(wheels[c]["centre"]) for c in CORNERS}
    sx = steer_info["pivot"][0] if steer_info else 0.36
    sy = steer_info["pivot"][1] if steer_info else 0.62
    sz = steer_info["pivot"][2] if steer_info else 0.35
    rear_z = -float(hi[1])
    cameras = {
        "cockpit": {"pos": [round(sx, 3), round(sy + 0.20, 3), round(sz - 0.43, 3)], "pitchDeg": -4, "fov": 60},
        "tcam": {"pos": [0.0, round(float(height) + 0.10, 3), round(sz - 0.55, 3)], "pitchDeg": -7, "fov": 58},
        "dash": {"pos": [round(sx, 3), round(sy + 0.125, 3), round(sz + 0.045, 3)], "pitchDeg": -3, "fov": 58},
        "bumper": {"pos": [0.0, 0.55, round(-float(front_axle) + 0.35, 3)], "pitchDeg": -3, "fov": 60},
        "nearChase": {"pos": [0.0, 1.55, round(rear_z - 3.1, 3)], "pitchDeg": -10, "fov": 60},
        "farChase": {"pos": [0.0, 2.05, round(rear_z - 5.1, 3)], "pitchDeg": -10, "fov": 60},
    }
    extras = {
        "wheelCentres": wheel_centres,
        "tyreRadius": {c: round(wheels[c]["radius"], 5) for c in CORNERS},
        "tyreHalfWidth": {c: round(wheels[c]["half"], 5) for c in CORNERS},
        "wheelbaseM": round(float(rear_axle - front_axle), 5),
        "trackWidthM": {"front": round(2 * wheels["LF"]["centre"][0], 5), "rear": round(2 * wheels["LR"]["centre"][0], 5)},
        "cameras": cameras,
        "source": SOURCE,
    }
    if steer_info:
        extras["steer"] = steer_info

    export_glb(opts.out)
    written = patch_extras(opts.out, extras)
    missing = [n for n in ["CAR", "BODY"] + [f"WHEEL_{c}{s}" for c in CORNERS for s in ("", "_RIM", "_TYRE")] if n not in written["nodes"]]
    raw_bytes = written["bytes"]
    if opts.compress:
        subprocess.run(["node", os.path.join(repo, "scripts", "compress-car-glb.mjs"), os.path.abspath(opts.out)], check=True, cwd=repo)

    hard = {
        "source": os.path.basename(opts.source),
        "frame": "metres, +X left, +Y up, +Z forward, tyre contact at y = 0, origin under the middle of the wheelbase",
        "scaleApplied": round(float(scale), 6),
        "sourceWheelbase": round(float(source_wheelbase), 5),
        "wheelsFoundFrom": how,
        "noseVotes": votes,
        "noseFlippedByHand": bool(opts.flip_nose),
        "wheelbaseM": extras["wheelbaseM"],
        "trackWidthFront": extras["trackWidthM"]["front"],
        "trackWidthRear": extras["trackWidthM"]["rear"],
        "wheelRadius": {"front": extras["tyreRadius"]["LF"], "rear": extras["tyreRadius"]["LR"]},
        "tyreWidth": {"front": round(2 * wheels["LF"]["half"], 5), "rear": round(2 * wheels["LR"]["half"], 5)},
        "wheelCentres": wheel_centres,
        "leftRightAsymmetryM": {
            axle: round(float(abs(abs(wheels[l]["own"][0]) - abs(wheels[r]["own"][0]))), 5) for axle, (l, r) in {"front": ("LF", "RF"), "rear": ("LR", "RR")}.items()
        },
        "wheelParts": wheel_stats,
        "steer": steer_info,
        "steeringWheelSide": None if not steer_info else ("left" if steer_info["pivot"][0] > 0 else "right"),
        "body": {
            "lengthM": round(float(length), 4),
            "widthM": round(float(width), 4),
            "heightAboveGroundM": round(float(height), 4),
            "roofAboveGroundM": round(roof, 4),
            "frontOverhangM": round(float(front_overhang), 4),
            "rearOverhangM": round(float(rear_overhang), 4),
        },
        "limits": {
            "lengthMax": MAX_LENGTH_M,
            "widthMax": MAX_WIDTH_M,
            "heightAboveReferencePlaneMax": MAX_HEIGHT_ABOVE_REFERENCE_M,
            "frontOverhangMax": MAX_FRONT_OVERHANG_M,
            "rearOverhangMax": MAX_REAR_OVERHANG_M,
            "wheelbase": WHEELBASE_M,
        },
        "againstLimits": {
            "length": round(float(length - MAX_LENGTH_M), 4),
            "width": round(float(width - MAX_WIDTH_M), 4),
            "rideHeightImpliedByRoof": round(float(roof - MAX_HEIGHT_ABOVE_REFERENCE_M - SKID_BLOCK_M), 4),
            "frontOverhang": round(float(front_overhang - MAX_FRONT_OVERHANG_M), 4),
            "rearOverhang": round(float(rear_overhang - MAX_REAR_OVERHANG_M), 4),
        },
        "triangles": {"source": raw["triangles"], "beforeBudget": before, "afterBudget": after, "inFile": written["triangles"], "budget": [tri_lo, tri_hi]},
        "materialsIn": summary["materials"],
        "materialsOut": written["materials"],
        "facesDropped": summary["facesDropped"],
        "paintZones": zones,
        "texturesScrubbed": scrubbed,
        "texturesResized": resized,
        "images": written["images"],
        "objectsDropped": dropped,
        "objectsTurnedInsideOut": inverted,
        "missingNodes": missing,
        "file": {"path": opts.out, "rawBytes": raw_bytes, "bytes": os.path.getsize(opts.out), "compressed": bool(opts.compress)},
    }
    os.makedirs(os.path.dirname(os.path.abspath(opts.hardpoints)), exist_ok=True)
    with open(opts.hardpoints, "w") as f:
        json.dump(hard, f, indent=1, default=float)

    log(f"wheelbase {hard['wheelbaseM']} m (scale {scale:.5f}), track F {hard['trackWidthFront']} R {hard['trackWidthRear']}, tyre radius F {hard['wheelRadius']['front']} R {hard['wheelRadius']['rear']}")
    log(f"body {length:.3f} x {width:.3f} x {height:.3f} m, roof {roof:.3f} m (limits {MAX_LENGTH_M} x {MAX_WIDTH_M}, {MAX_HEIGHT_ABOVE_REFERENCE_M} above the reference plane)")
    log(f"triangles {raw['triangles']} -> {written['triangles']} (budget {tri_lo}-{tri_hi}); {os.path.getsize(opts.out) / 1e6:.2f} MB -> {opts.out}")
    for label, bad in (
        ("longer than the limit", length > MAX_LENGTH_M + 0.003),
        ("wider than the limit", width > MAX_WIDTH_M + 0.003),
        ("outside the triangle budget", not (tri_lo <= written["triangles"] <= tri_hi)),
        ("missing rig nodes: " + ", ".join(missing), bool(missing)),
        ("steering wheel not found (no STEER node)", steer_info is None and not opts.no_steer),
    ):
        if bad:
            log("warning:", label)
    log(f"hardpoints: {opts.hardpoints}")


def scene_bounds_world(rig):
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    bpy.context.view_layer.update()
    for o in rig.values():
        v = verts_of(o.data)
        if not len(v):
            continue
        m = np.array(o.matrix_world)
        w = v @ m[:3, :3].T + m[:3, 3]
        lo = np.minimum(lo, w.min(axis=0))
        hi = np.maximum(hi, w.max(axis=0))
    return lo, hi


if __name__ == "__main__":
    main()
