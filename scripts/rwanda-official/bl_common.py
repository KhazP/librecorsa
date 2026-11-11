"""
Blender-side helpers of the official Rwanda layout build: materials, mesh creation from numpy arrays, swept strips and
the design's ground lookup. Loaded inside Blender (bpy + numpy only).
"""
import os
import numpy as np
import bpy

import ro_design as rd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
TEX = os.path.join(HERE, 'data', 'tex')
REPO_TEX = os.path.join(HERE, 'assets', 'textures')            # barrier, fence and gantry textures of the project's own
COLL = 'RO'
STEP = rd.MESH_STEP


def srgb2lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# ---- design -----------------------------------------------------------------------------------------------------------
_T = None


def design(reload=False):
    """The design with its band edges cached, and the mesh stations (every STEP metres)"""
    global _T
    if _T is None or reload:
        _T = rd.Design()
        _T.be = [_T.band_edges(0), _T.band_edges(1)]
        _T.idx = np.arange(0, _T.n, STEP)
    return _T


def ground_z(T, i, side, la):
    """rd.Design.ground_z with cached band edges; i and la broadcast to the same shape"""
    sg = rd.SIDE_SIGN[side]
    e = T.be[side][i]
    hw = T.width[i] / 2
    zc = T.z[i] + T.cross_z(i, sg * la)
    w0, w1 = hw + e[..., rd.BACK0], hw + e[..., rd.EDGE]
    zw = T.z[i] + T.cross_z(i, sg * w1)
    t = np.clip((la - w0) / np.maximum(w1 - w0, 1e-6), 0, 1)
    t = t * t * (3 - 2 * t)
    return zc + t * (T.edge_z[side][i] - zw)


def pts(T, side, d, dz=0.0, idx=None):
    """Points of the mesh stations, d metres outside the road edge of one side ((n,) or (n, m)), dz above the ground"""
    idx = T.idx if idx is None else idx
    d = np.asarray(d, float)
    I = idx if d.ndim == 1 else np.broadcast_to(idx[:, None], d.shape)
    la = T.width[I] / 2 + d
    sg = rd.SIDE_SIGN[side]
    z = ground_z(T, I, side, la) + dz
    return np.stack([T.x[I] + sg * T.rx[I] * la, T.y[I] + sg * T.ry[I] * la, z], -1)


def at(T, s, lat, dz=0.0):
    """World points at fractional stations s and lateral offsets lat (+ right), dz above the built ground"""
    s, lat = np.broadcast_arrays(np.asarray(s, float) % T.n, np.asarray(lat, float))
    dz = np.broadcast_to(np.asarray(dz, float), s.shape)
    i0 = np.floor(s).astype(int) % T.n
    f = s - np.floor(s)
    i1 = (i0 + 1) % T.n
    out = np.zeros(s.shape + (3,))
    la = np.abs(lat)
    z = 0.0
    for i, w in ((i0, 1 - f), (i1, f)):
        zz = np.where(lat >= 0, ground_z(T, i, 1, la), ground_z(T, i, 0, la))
        z = z + w * zz
        out[..., 0] += w * (T.x[i] + T.rx[i] * lat)
        out[..., 1] += w * (T.y[i] + T.ry[i] * lat)
    out[..., 2] = z + dz
    return out


def frame(T, s):
    """Position on the centreline, unit tangent and unit right vector (2D) at fractional station s"""
    s = float(s) % T.n
    i0 = int(np.floor(s)) % T.n
    i1 = (i0 + 1) % T.n
    f = s - np.floor(s)
    t = np.array([T.tx[i0] * (1 - f) + T.tx[i1] * f, T.ty[i0] * (1 - f) + T.ty[i1] * f])
    t /= np.hypot(*t)
    p = np.array([T.x[i0] * (1 - f) + T.x[i1] * f, T.y[i0] * (1 - f) + T.y[i1] * f, T.z[i0] * (1 - f) + T.z[i1] * f])
    return p, t, np.array([t[1], -t[0]])


# ---- images, materials ------------------------------------------------------------------------------------------------
def image(name):
    """data/tex/<name>.png, else the repo's own scenery texture <name>.webp"""
    key = 'ro_' + name
    img = bpy.data.images.get(key)
    p = os.path.join(TEX, name + '.png')
    if not os.path.exists(p):
        p = os.path.join(REPO_TEX, name + '.webp')
    if img:
        if bpy.path.abspath(img.filepath) != p:
            img.filepath = p
        img.reload()
        return img
    img = bpy.data.images.load(p)
    img.name = key
    return img


def mat(name, color=(1, 1, 1), rough=0.8, metal=0.0, tex=None, vcol=False, alpha=None, double=False, emit=None,
        emit_strength=1.0, a=1.0, nor=None, tile=1.0):
    """
    A glTF-friendly Principled material. `color` is a display (sRGB) colour; with a texture it becomes the base
    colour factor, unless `vcol` multiplies the 'Col' attribute in instead. alpha: None | 'BLEND' | 'MASK'.
    `nor` is a normal map (OpenGL convention) beside the texture. `tile` repeats both that many times across one unit
    of the mesh's uv (glTF: KHR_texture_transform): a scan of 2 m of ground on a surface whose uv runs by 8 m takes
    4, and the uv stays what the game reads the surface's ripple from.
    """
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    lin = tuple(srgb2lin(color)) + (1.0,)
    src = None
    t = None
    where = None
    if tile != 1.0 and (tex or nor):
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (tile, tile, 1.0)
        nt.links.new(tc.outputs['UV'], mp.inputs['Vector'])
        where = mp.outputs['Vector']
    if tex:
        t = nt.nodes.new('ShaderNodeTexImage')              # the first image node: the colour (bl_ac.py reads it so)
        t.image = image(tex)
        if where is not None:
            nt.links.new(where, t.inputs['Vector'])
        src = t.outputs['Color']
    if nor:
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = image(nor)
        tn.image.colorspace_settings.name = 'Non-Color'
        if where is not None:
            nt.links.new(where, tn.inputs['Vector'])
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    fac = None
    if vcol:
        vc = nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = 'Col'
        fac = vc.outputs['Color']
    elif tuple(color) != (1, 1, 1) and src is not None:
        rgb = nt.nodes.new('ShaderNodeRGB')
        rgb.outputs[0].default_value = lin
        fac = rgb.outputs[0]
    if src is not None and fac is not None:
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1.0
        nt.links.new(src, mix.inputs[6])
        nt.links.new(fac, mix.inputs[7])
        src = mix.outputs[2]
    elif src is None:
        src = fac
    if src is not None:
        nt.links.new(src, bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = lin
    if alpha and t is not None:
        nt.links.new(t.outputs['Alpha'], bsdf.inputs['Alpha'])
    elif a < 1.0:
        bsdf.inputs['Alpha'].default_value = a
    if alpha or a < 1.0:
        try:
            m.surface_render_method = 'BLENDED' if (alpha == 'BLEND' or a < 1.0) else 'DITHERED'
        except Exception:
            pass
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = tuple(srgb2lin(emit)) + (1.0,)
        bsdf.inputs['Emission Strength'].default_value = emit_strength
    m.use_backface_culling = not double
    m.diffuse_color = tuple(color) + (1.0,)
    return m


# ---- meshes -----------------------------------------------------------------------------------------------------------
def collection(name=COLL):
    c = bpy.data.collections.get(name)
    if not c:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def remove(name):
    ob = bpy.data.objects.get(name)
    if ob:
        me = ob.data
        bpy.data.objects.remove(ob)
        if me is not None and me.users == 0 and isinstance(me, bpy.types.Mesh):
            bpy.data.meshes.remove(me)


def make_mesh(name, V, F, mats=(), mat_idx=None, uv=None, loop_uv=None, col=None, smooth=True, extras=None,
              coll=COLL):
    """
    An object from arrays: V (n, 3); F (m, k) faces of one size; uv per vertex (n, 2) or loop_uv per face corner
    (m * k, 2); col per vertex (n, 3) in display (sRGB) values. `extras` become glTF node extras.
    """
    remove(name)
    V = np.asarray(V, np.float32)
    F = np.asarray(F, np.int32)
    k = F.shape[1]
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(V))
    me.vertices.foreach_set('co', V.ravel())
    me.loops.add(F.size)
    me.loops.foreach_set('vertex_index', F.ravel())
    me.polygons.add(len(F))
    me.polygons.foreach_set('loop_start', np.arange(0, F.size, k, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(F), k, np.int32))
    for m in mats:
        me.materials.append(m)
    if mat_idx is not None:
        me.polygons.foreach_set('material_index', np.asarray(mat_idx, np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.full(len(F), bool(smooth)))
    if uv is not None:
        loop_uv = np.asarray(uv, np.float32)[F.ravel()]
    if loop_uv is not None:
        l = me.uv_layers.new(name='UVMap')
        l.data.foreach_set('uv', np.asarray(loop_uv, np.float32).ravel())
    if col is not None:
        ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        rgba = np.ones((len(V), 4), np.float32)
        rgba[:, :3] = srgb2lin(col)
        ca.data.foreach_set('color', rgba.ravel())
        me.color_attributes.active_color = ca
        me.color_attributes.render_color_index = 0
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    collection(coll).objects.link(ob)
    for key, v in (extras or {}).items():
        ob[key] = v
    return ob


class Parts:
    """Accumulates strips / loose geometry into one mesh with several materials"""

    def __init__(self, k=4):
        self.V, self.F, self.UV, self.MI, self.C = [], [], [], [], []
        self.n = 0
        self.k = k
        self.has_col = False

    def add(self, V, F, loop_uv=None, mi=0, col=None):
        V = np.asarray(V, float).reshape(-1, 3)
        F = np.asarray(F, int).reshape(-1, self.k)
        if len(F) == 0:
            return
        used = np.unique(F)
        if len(used) < len(V):                      # drop the vertices no face uses (masked strips)
            remap = np.zeros(len(V), int)
            remap[used] = np.arange(len(used))
            F = remap[F]
            if col is not None and np.ndim(col) == 2 and len(col) == len(V):
                col = np.asarray(col, float)[used]
            V = V[used]
        self.V.append(V)
        self.F.append(F + self.n)
        self.UV.append(np.zeros((F.size, 2)) if loop_uv is None else np.asarray(loop_uv, float).reshape(-1, 2))
        self.MI.append(np.full(len(F), mi, int))
        if col is not None:
            self.has_col = True
        self.C.append(np.ones((len(V), 3)) if col is None else np.broadcast_to(np.asarray(col, float), (len(V), 3)))
        self.n += len(V)

    def strip(self, P, mask=None, flip=False, uv=None, uv_far=None, mi=0, col=None, closed=True):
        V, F, L = strip(P, mask, flip, uv, uv_far, closed)
        self.add(V, F, L, mi, None if col is None else np.asarray(col, float).reshape(-1, 3))

    def build(self, name, mats, smooth=True, extras=None, uv=True):
        if not self.F:
            remove(name)
            return None
        return make_mesh(name, np.vstack(self.V), np.vstack(self.F), mats, np.concatenate(self.MI),
                         loop_uv=np.vstack(self.UV) if uv else None, col=np.vstack(self.C) if self.has_col else None,
                         smooth=smooth, extras=extras)


def strip(P, mask=None, flip=False, uv=None, uv_far=None, closed=True):
    """
    Quads of a swept grid P (n, m, 3): rows along the lap, columns across. Returns V, F and the per-corner uv.
    mask (n,) or (n, m - 1) keeps the quads that start at each row. uv (n, m, 2) is the uv of each vertex; uv_far
    is the uv of row i + 1 as the quads of row i see it (default: uv of the next row), which keeps a closed strip's
    last quad from running the texture backwards. Faces point up when the columns run left to right; `flip` turns
    them over.
    """
    P = np.asarray(P, float)
    n, m = P.shape[:2]
    rows = np.arange(n if closed else n - 1)
    I, J = np.meshgrid(rows, np.arange(m - 1), indexing='ij')
    I2 = (I + 1) % n
    q = np.stack([I * m + J, I * m + J + 1, I2 * m + J + 1, I2 * m + J], -1)
    L = None
    if uv is not None:
        uv = np.asarray(uv, float)
        far = np.roll(uv, -1, 0) if uv_far is None else np.asarray(uv_far, float)
        L = np.stack([uv[I, J], uv[I, J + 1], far[I, J + 1], far[I, J]], -2)
    if mask is None:
        keep = np.ones(I.shape, bool)
    else:
        mask = np.asarray(mask, bool)
        keep = mask[rows][:, None] & np.ones(I.shape, bool) if mask.ndim == 1 else mask[rows]
    q = q[keep]
    if L is not None:
        L = L[keep]
    if flip:
        q = q[:, ::-1]
        if L is not None:
            L = L[:, ::-1]
    return P.reshape(-1, 3), q, None if L is None else L.reshape(-1, 2)


def box(c, half, yaw=0.0, uv_scale=None):
    """A box: centre c, half sizes, yaw about Z. Returns V (24, 3), F (6, 4) with outward faces, loop uv (24, 2)"""
    hx, hy, hz = half
    cs, sn = np.cos(yaw), np.sin(yaw)
    faces = []
    uvs = []
    # (normal axis, sign): corners counter-clockwise seen from outside
    defs = [((1, 0, 0), (0, 1, 0), (0, 0, 1), hx, hy, hz), ((-1, 0, 0), (0, -1, 0), (0, 0, 1), hx, hy, hz),
            ((0, 1, 0), (-1, 0, 0), (0, 0, 1), hy, hx, hz), ((0, -1, 0), (1, 0, 0), (0, 0, 1), hy, hx, hz),
            ((0, 0, 1), (1, 0, 0), (0, 1, 0), hz, hx, hy), ((0, 0, -1), (1, 0, 0), (0, -1, 0), hz, hx, hy)]
    for nrm, ua, va, hn, hu, hv in defs:
        nrm, ua, va = np.array(nrm, float), np.array(ua, float), np.array(va, float)
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            faces.append(nrm * hn + ua * su * hu + va * sv * hv)
            sc = uv_scale or (2 * hu, 2 * hv)
            uvs.append(((su + 1) * hu / sc[0], (sv + 1) * hv / sc[1]))
    V = np.array(faces)
    V = np.c_[V[:, 0] * cs - V[:, 1] * sn, V[:, 0] * sn + V[:, 1] * cs, V[:, 2]] + np.asarray(c, float)
    return V, np.arange(24).reshape(6, 4), np.array(uvs)


# ---- looking at the work ----------------------------------------------------------------------------------------------
def view(s, back=30.0, height=6.0, lat=0.0, ahead=40.0, tlat=0.0, th=1.0, lens=24.0):
    """Put the scene camera `back` metres before station s, `lat` to the right, looking `ahead` of the station"""
    from mathutils import Vector
    T = design()
    eye = Vector(at(T, s - back, lat, height).tolist())
    tgt = Vector(at(T, s + ahead, tlat, th).tolist())
    return look_from(eye, tgt, lens)


def look_from(eye, tgt, lens=24.0):
    from mathutils import Vector
    cam = bpy.data.objects.get('RO_Camera')
    if not cam:
        cam = bpy.data.objects.new('RO_Camera', bpy.data.cameras.new('RO_Camera'))
        bpy.context.scene.collection.objects.link(cam)
    eye, tgt = Vector(eye), Vector(tgt)
    cam.location = eye
    cam.rotation_euler = (tgt - eye).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    cam.data.clip_start, cam.data.clip_end = 0.3, 20000.0
    bpy.context.scene.camera = cam
    bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y = 1280, 720
    return tuple(round(v, 1) for v in eye)
