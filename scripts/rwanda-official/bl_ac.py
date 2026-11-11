"""
The Assetto Corsa project of the official Rwanda layout: the built scene as an FBX for ksEditor with AC's object
names, the trees as plain meshes (data/ac_trees.glb, from ac_trees.mjs), every texture as a PNG (AC's shaders do not
read vertex colours, so each tinted surface gets its own tinted copy), the start and pit dummies and ksEditor's
material file; beside it one small FBX per lap with that lap's timing gates. ac_data.py writes the rest of the track
folder around them.

    import bl_ac; bl_ac.export('/Users/<you>/Desktop/rwanda_official')

Nothing here has been loaded in Assetto Corsa: there is no ksEditor on the machine it was written on.
"""
import json
import os
import numpy as np
import bpy
from mathutils import Matrix, Vector

import ro_design as rd
import bl_common as bc

REPO = bc.REPO
TMP = 'AC_Export'
# the game's surface tags -> the key AC reads from the start of an object's name (data/surfaces.ini defines each)
PHYS = {'road': 'ROAD', 'pitlane': 'PIT', 'kerb': 'KERB', 'runoff': 'RUNOFF', 'gravel': 'SAND', 'grass': 'GRASS'}
ALSO = {'Ground_Paddock': 'PIT', 'Ground_Lawns': 'GRASS'}          # reachable ground the game leaves untagged
SKIP = ('Track_Collider_Road',)
ALPHA_TEST = ('Fence_Debris', 'Palm_Leaf', 'Tree_')                  # cut-out materials (by name or its start)
LAYOUTS = (('gp', 'rwanda_official'), ('short', 'rwanda_official_short'))
PIT_BOX_M = 7.6
PIT_SIDE_M = 5.0


def game(p):
    """A point or direction of the game's frame (x, y up, z = -north) in the scene's (x east, y north, z up)"""
    return Vector((p[0], -p[2], p[1]))


def dummy(coll, name, pos, fwd, lift=0.6):
    """An AC dummy: its Z axis along the direction of travel, its Y axis up"""
    f = Vector((fwd[0], fwd[1], 0.0)).normalized()
    up = Vector((0, 0, 1))
    x = up.cross(f)
    m = Matrix((x, up, f)).transposed().to_4x4()
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'ARROWS'
    e.empty_display_size = 2.0
    e.matrix_world = Matrix.Translation(Vector(pos) + Vector((0, 0, lift))) @ m
    coll.objects.link(e)
    return e


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def save_png(path, rgba):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new('ac_tmp', w, h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(rgba, np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def lin2srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def srgb2lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def tex_node(mat):
    return next((n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image), None) if mat and mat.use_nodes else None


def tiling(mat):
    """How often the material repeats its texture over a unit of the mesh's uv (bl_common.mat's Mapping node)"""
    n = next((n for n in mat.node_tree.nodes if n.type == 'MAPPING'), None) if mat and mat.use_nodes else None
    return float(n.inputs['Scale'].default_value[0]) if n else 1.0


def retile(me, slot, k):
    """AC's shaders have no such repeat: the working copy's uv carries it, for the faces of that material"""
    if k == 1.0 or not me.uv_layers or not len(me.polygons):
        return
    mi = np.zeros(len(me.polygons), np.int32)
    me.polygons.foreach_get('material_index', mi)
    start = np.zeros(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_start', start)
    total = np.zeros(len(me.polygons), np.int32)
    me.polygons.foreach_get('loop_total', total)
    pick = np.zeros(len(me.loops), bool)
    pick[np.repeat(start, total) + (np.arange(total.sum()) - np.repeat(np.cumsum(total) - total, total))] = np.repeat(mi == slot, total)
    uv = np.zeros(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    uv[pick] *= k
    me.uv_layers.active.data.foreach_set('uv', uv.ravel())


def uses_vcol(mat):
    return bool(mat and mat.use_nodes and any(n.type == 'VERTEX_COLOR' for n in mat.node_tree.nodes))


def base_colour(mat):
    b = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if mat and mat.use_nodes else None
    return np.array(b.inputs['Base Color'].default_value[:3]) if b else np.ones(3)


def mean_colour(ob):
    """Mean of the object's colour attribute (linear), or None"""
    ca = ob.data.color_attributes.get('Col') or (ob.data.color_attributes[0] if len(ob.data.color_attributes) else None)
    if ca is None:
        return None
    a = np.empty(len(ca.data) * 4, np.float32)
    ca.data.foreach_get('color', a)
    return a.reshape(-1, 4)[:, :3].mean(0)


def export(out, scale='FBX_SCALE_UNITS'):
    out = os.path.abspath(os.path.expanduser(out))
    texdir = os.path.join(out, 'texture')
    os.makedirs(texdir, exist_ok=True)
    old = bpy.data.collections.get(TMP)
    if old:
        for ob in list(old.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.collections.remove(old)
    coll = bpy.data.collections.new(TMP)
    bpy.context.scene.collection.children.link(coll)

    # ---- the trees, as ac_trees.mjs baked them ----
    before = set(bpy.data.objects)
    had = {k: set(getattr(bpy.data, k)) for k in ('materials', 'images', 'textures')}
    bpy.ops.import_scene.gltf(filepath=os.path.join(rd.DATA, 'ac_trees.glb'))
    trees = [o for o in bpy.data.objects if o not in before]
    for o in trees:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        if o.type == 'MESH':
            coll.objects.link(o)
        else:
            bpy.data.objects.remove(o)
    trees = [o for o in trees if o.name in bpy.data.objects and o.type == 'MESH']
    for o in trees:
        o.matrix_world = o.matrix_world.copy()
        o.parent = None

    # ---- the scene's objects under AC's names ----
    report, n_phys = {}, 0
    copies = []
    for src in sorted(bpy.data.collections[bc.COLL].objects, key=lambda o: o.name):
        if src.type != 'MESH' or src.name in SKIP:
            continue
        key = 'WALL' if src.get('collider') == 'wall' else PHYS.get(src.get('surface')) or ALSO.get(src.name)
        ob = src.copy()
        ob.data = src.data.copy()
        ob.hide_viewport = ob.hide_render = False
        coll.objects.link(ob)
        if key:
            n_phys += 1
            ob.name = '%d%s_%s' % (n_phys, key, src.name.split('_', 1)[-1].lower())
            report[key] = report.get(key, 0) + 1
        else:
            ob.name = 'ac_' + src.name
        copies.append((ob, src, key))

    # ---- materials: one PNG each; a tinted copy per object where the scene multiplies vertex colours in ----
    made, mats, n_tex = {}, {}, 0

    def material(mat, ob, key):
        nonlocal n_tex
        if key == 'WALL':
            name, tint, node = 'AC_Wall_Hidden', None, None
        else:
            node = tex_node(mat)
            tint = mean_colour(ob) if uses_vcol(mat) else None
            name = 'ac_' + (mat.name if mat else 'none') + ('__' + ob.name.lstrip('0123456789') if tint is not None else '')
        if name in made:
            return made[name]
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        png = name[3:].lower() + '.png' if key != 'WALL' else 'wall_hidden.png'
        if key == 'WALL':
            rgba = np.zeros((4, 4, 4), np.float32)
        elif node:
            rgba = pixels(node.image).copy()
            if tint is not None:
                rgba[..., :3] = lin2srgb(srgb2lin(rgba[..., :3]) * tint[None, None])
        else:
            rgba = np.ones((4, 4, 4), np.float32)
            rgba[..., :3] = lin2srgb(base_colour(mat) * (tint if tint is not None else 1.0))[None, None]
        save_png(os.path.join(texdir, png), rgba)
        n_tex += 1
        img = bpy.data.images.load(os.path.join(texdir, png))
        t = m.node_tree.nodes.new('ShaderNodeTexImage')
        t.image = img
        m.node_tree.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        cut = key == 'WALL' or any(mat and (mat.name == a or mat.name.startswith(a)) for a in ALPHA_TEST) or \
            (mat is not None and mat.blend_method in ('CLIP', 'HASHED', 'BLEND') and node is not None and rgba[..., 3].min() < 0.9)
        made[name] = m
        mats[name] = dict(texture=png, alpha_test=bool(cut), alpha_blend=key == 'WALL')
        return m

    for ob, src, key in copies:
        for i, mat in enumerate(list(ob.data.materials)):
            retile(ob.data, i, tiling(mat))
            ob.data.materials[i] = material(mat, ob, key)
    for o in trees:
        for i, mat in enumerate(list(o.data.materials)):
            o.data.materials[i] = material(mat, o, None)

    # ---- dummies: grid, pit boxes, hotlap start (both laps share them; each lap's timing gates go in a file of its own) ----
    td = json.load(open(os.path.join(REPO, 'public', 'tracks', 'rwanda_official', 'track_data.json')))
    for i, g in enumerate(td['spawnGrid']):
        dummy(coll, 'AC_START_%d' % i, game(g['position']), game(g['forward']))
    S = td['samples']
    k = len(S) - int(round(300.0 / td['metadata'].get('sampleSpacingM', 5.0)))
    dummy(coll, 'AC_HOTLAP_START_0', game(S[k]['p']), game(S[k]['t']))
    pc = np.array([game(p) for p in td['pitLane']['centerline']])
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pc, axis=0), axis=1))]
    pb = bpy.data.objects.get('Prop_PitBuilding')
    centre = np.array(pb.matrix_world @ (sum((Vector(c) for c in pb.bound_box), Vector()) / 8))
    boxes = int(td['metadata'].get('pitboxes', 20))
    s0 = (seg[-1] - (boxes - 1) * PIT_BOX_M) / 2
    for i in range(boxes):
        s = s0 + i * PIT_BOX_M
        p = np.array([np.interp(s, seg, pc[:, j]) for j in range(3)])
        q = np.array([np.interp(s + 1.0, seg, pc[:, j]) for j in range(3)])
        f = (q - p) / np.linalg.norm(q - p)
        side = np.array([-f[1], f[0], 0.0])
        if np.dot(centre - p, side) < 0:
            side = -side
        dummy(coll, 'AC_PIT_%d' % i, p + side * PIT_SIDE_M, f)

    # ---- FBX ----
    for o in coll.objects:                                   # every mesh carries texture coordinates, flat-coloured ones too
        if o.type == 'MESH' and not o.data.uv_layers:
            o.data.uv_layers.new(name='UVMap')
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in coll.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = coll.objects[0]
    fbx = os.path.join(out, 'rwanda_official.fbx')
    bpy.ops.export_scene.fbx(filepath=fbx, use_selection=True, global_scale=1.0, apply_unit_scale=True, apply_scale_options=scale,
                             axis_forward='-Z', axis_up='Y', object_types={'MESH', 'EMPTY'}, use_mesh_modifiers=False,
                             mesh_smooth_type='FACE', add_leaf_bones=False, bake_anim=False, path_mode='STRIP', embed_textures=False)

    # ---- ksEditor's material file ----
    L = ['[HEADER]', 'VERSION=3', '', '[MATERIAL_LIST]', 'COUNT=%d' % len(mats), '']
    for i, (name, m) in enumerate(sorted(mats.items())):
        shader = 'ksPerPixelAT' if (m['alpha_test'] or m['alpha_blend']) else 'ksPerPixel'
        L += ['[MATERIAL_%d]' % i, 'NAME=' + name, 'SHADER=' + shader, 'ALPHABLEND=%d' % (1 if m['alpha_blend'] else 0),
              'ALPHATEST=%d' % (1 if m['alpha_test'] else 0), 'DEPTHMODE=0', 'VARCOUNT=4']
        for j, (var, val) in enumerate((('ksAmbient', 0.38), ('ksDiffuse', 0.42), ('ksSpecular', 0.04), ('ksSpecularEXP', 12.0))):
            L += ['VAR_%d_NAME=%s' % (j, var), 'VAR_%d_FLOAT1=%g' % (j, val), 'VAR_%d_FLOAT2=0,0' % j, 'VAR_%d_FLOAT3=0,0,0' % j,
                  'VAR_%d_FLOAT4=0,0,0,0' % j]
        L += ['RESCOUNT=1', 'RES_0_NAME=txDiffuse', 'RES_0_SLOT=0', 'RES_0_TEXTURE=' + m['texture'], '']
    for ob, src, key in copies:
        if key == 'WALL':
            L += ['[model_FBX: %s]' % ob.name, 'ACTIVE=1', 'PRIORITY=0', 'VISIBLE=1', 'TRANSPARENT=1', 'CAST_SHADOWS=0', 'LOD_IN=0',
                  'LOD_OUT=0', 'RENDERABLE=0', '']
    with open(fbx + '.ini', 'w') as f:
        f.write('\n'.join(L) + '\n')

    # ---- each lap's timing gates: the laps part between the first and the second gate, so each gets its own small
    #      model (a hidden triangle under the start line comes with the dummies, so the file is not empty of meshes) ----
    timing = {}
    for lay, tid in LAYOUTS:
        tl = json.load(open(os.path.join(REPO, 'public', 'tracks', tid, 'track_data.json')))
        tc = bpy.data.collections.new(TMP + '_Timing')
        bpy.context.scene.collection.children.link(tc)
        for i, sec in enumerate(tl['sectors']):
            gate = sec['gate']
            l, r = game(gate['left']), game(gate['right'])
            wide = (l - r).normalized() * 4.0             # the gate reaches past both edges
            dummy(tc, 'AC_TIME_%d_L' % i, l + wide, game(gate['normal']), lift=0.6)
            dummy(tc, 'AC_TIME_%d_R' % i, r - wide, game(gate['normal']), lift=0.6)
        me = bpy.data.meshes.new('ac_timing_anchor_' + lay)
        o = game(tl['samples'][0]['p']) + Vector((0, 0, -3.0))
        me.from_pydata([o, o + Vector((0.1, 0, 0)), o + Vector((0, 0.1, 0))], [], [(0, 1, 2)])
        me.uv_layers.new(name='UVMap')
        me.materials.append(made['AC_Wall_Hidden'])
        anchor = bpy.data.objects.new('ac_timing_anchor_' + lay, me)
        tc.objects.link(anchor)
        for ob in bpy.context.view_layer.objects:
            ob.select_set(False)
        for ob in tc.objects:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = anchor
        tf = os.path.join(out, 'rwanda_official_%s_timing.fbx' % lay)
        bpy.ops.export_scene.fbx(filepath=tf, use_selection=True, global_scale=1.0, apply_unit_scale=True, apply_scale_options=scale,
                                 axis_forward='-Z', axis_up='Y', object_types={'MESH', 'EMPTY'}, use_mesh_modifiers=False,
                                 mesh_smooth_type='FACE', add_leaf_bones=False, bake_anim=False, path_mode='STRIP', embed_textures=False)
        w = mats['AC_Wall_Hidden']
        with open(tf + '.ini', 'w') as f:
            f.write('\n'.join(['[HEADER]', 'VERSION=3', '', '[MATERIAL_LIST]', 'COUNT=1', '', '[MATERIAL_0]', 'NAME=AC_Wall_Hidden',
                                'SHADER=ksPerPixelAT', 'ALPHABLEND=1', 'ALPHATEST=1', 'DEPTHMODE=0', 'VARCOUNT=0', 'RESCOUNT=1',
                                'RES_0_NAME=txDiffuse', 'RES_0_SLOT=0', 'RES_0_TEXTURE=' + w['texture'], '',
                                '[model_FBX: %s]' % anchor.name, 'ACTIVE=1', 'PRIORITY=0', 'VISIBLE=1', 'TRANSPARENT=1',
                                'CAST_SHADOWS=0', 'LOD_IN=0', 'LOD_OUT=0', 'RENDERABLE=0', '']) + '\n')
        timing[lay] = sorted(ob.name for ob in tc.objects if ob.type == 'EMPTY')
        for ob in list(tc.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)
        bpy.data.collections.remove(tc)

    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in coll.objects if o.type == 'MESH')
    most = max(len(o.data.vertices) for o in coll.objects if o.type == 'MESH')
    names = sorted(o.name for o in coll.objects if o.type == 'MESH' and o.name[0].isdigit())
    res = dict(fbx=fbx, size=os.path.getsize(fbx), objects=len(coll.objects), triangles=tris, most_vertices=most, physics=report,
               physics_names=names, materials=len(mats), textures=n_tex, trees=len(trees), timing=timing,
               dummies=sorted(o.name for o in coll.objects if o.type == 'EMPTY')[:4] + ['...'])
    # the working copies leave the scene again: the .blend stays the game's
    for o in list(coll.objects):
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data and data.users == 0 and isinstance(data, bpy.types.Mesh):
            bpy.data.meshes.remove(data)
    bpy.data.collections.remove(coll)
    for m in made.values():
        if m.users == 0:
            bpy.data.materials.remove(m)
    for k in ('materials', 'textures', 'images'):            # and what came in with the trees
        for d in [d for d in getattr(bpy.data, k) if d not in had[k] and d.users == 0]:
            getattr(bpy.data, k).remove(d)
    return res
