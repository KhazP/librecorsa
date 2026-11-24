"""
Exports the built scene (collection RO) to data/rwanda_official_raw.glb; post.mjs then turns it into the game's file.

    import bl_export; bl_export.export()
"""
import os
import numpy as np
import bpy

import bl_common as bc

RAW = os.path.join(bc.HERE, 'data', 'rwanda_official_raw.glb')
WALLS = os.path.join(bc.HERE, 'data', 'walls.npz')


def walls(path=WALLS):
    """Every barrier the cars can hit as a line on the ground (the way the game reads the wall colliders: each face
    is the segment between its two corners farthest apart in plan), for export_json.py to measure barrier distances"""
    seg = []
    for o in bpy.data.collections[bc.COLL].objects:
        if o.type != 'MESH' or not (o.get('collider') == 'wall' or o.name.startswith('Track_Collider_Wall')):
            continue
        V = np.zeros(len(o.data.vertices) * 3)
        o.data.vertices.foreach_get('co', V)
        V = V.reshape(-1, 3)[:, :2]
        for f in o.data.polygons:
            P = V[list(f.vertices)]
            d = np.hypot(*(P[:, None] - P[None]).transpose(2, 0, 1))
            a, b = np.unravel_index(int(np.argmax(d)), d.shape)
            if d[a, b] > 0.05:
                seg.append((*P[a], *P[b]))
    seg = np.unique(np.round(np.array(seg), 3), axis=0)
    np.savez(path, seg=seg)
    return len(seg)


def export(path=RAW):
    col = bpy.data.collections[bc.COLL]
    hidden = [o for o in col.objects if o.hide_viewport]
    for o in hidden:                                    # the colliders: exported, the game hides them
        o.hide_viewport = False
    try:
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', collection=bc.COLL, export_apply=True,
                                  export_extras=True, export_yup=True, export_animations=False, export_skins=False,
                                  export_morph=False, export_cameras=False, export_lights=False,
                                  export_vertex_color='MATERIAL', export_image_format='AUTO')
    finally:
        for o in hidden:
            o.hide_viewport = True
    return path, os.path.getsize(path), len(col.objects), walls()
