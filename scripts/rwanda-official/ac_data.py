"""
The rest of the Assetto Corsa project of the official Rwanda layout, around the FBX that bl_ac.py writes: the track
folder with both layouts' surfaces, lighting, maps and interface files, the Custom Shaders Patch settings (grass and
rain, from the material names in the .fbx.ini beside the FBX) and a README with the steps left to do on a PC.

    ~/.venvs/librecorsa-tracks/bin/python -I ac_data.py ~/Desktop/rwanda_official [preview.jpg]

Nothing here has been loaded in Assetto Corsa.
"""
import json
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
LAYOUTS = (('gp', 'rwanda_official'), ('short', 'rwanda_official_short'))
KN5 = 'rwanda_official.kn5'

#            key       friction damping wav          pitch ff  dirt valid pit  vib gain / length
SURFACES = (('ROAD',   0.98,   0.0,   '',            0,   'NULL', 0, 1, 0, 0.0, 0.0),
            ('PIT',    0.96,   0.0,   '',            0,   'NULL', 0, 1, 1, 0.0, 0.0),
            ('KERB',   0.94,   0.0,   'kerb.wav',    1.3, '1',    0, 1, 0, 1.0, 1.5),
            ('RUNOFF', 0.93,   0.0,   '',            0,   'NULL', 0, 0, 0, 0.0, 0.0),
            ('GRASS',  0.60,   0.0,   'grass.wav',   0,   'NULL', 1, 0, 0, 0.5, 2.0),
            ('SAND',   0.75,   0.12,  'sand.wav',    0,   'NULL', 1, 0, 0, 0.4, 1.5))


def surfaces():
    L = []
    for i, (key, fr, damp, wav, pitch, ff, dirt, valid, pit, vg, vl) in enumerate(SURFACES):
        L += ['[SURFACE_%d]' % i, 'KEY=' + key, 'FRICTION=%g' % fr, 'DAMPING=%g' % damp, 'WAV=' + wav, 'WAV_PITCH=%g' % pitch,
              'FF_EFFECT=' + ff, 'DIRT_ADDITIVE=%d' % dirt, 'IS_VALID_TRACK=%d' % valid, 'BLACK_FLAG_TIME=0', 'SIN_HEIGHT=0',
              'SIN_LENGTH=0', 'IS_PITLANE=%d' % pit, 'VIBRATION_GAIN=%g' % vg, 'VIBRATION_LENGTH=%g' % vl, '']
    return '\n'.join(L)


# Custom Shaders Patch: each list is the materials whose name starts with one of these (keys as in CSP's track docs)
CSP = (('GRASS_FX', (
           ('GRASS_MATERIALS', ('ac_Terrain_Grass__GRASS_',)),
           ('OCCLUDING_MATERIALS', ('ac_Track_', 'ac_Kerb_', 'ac_Runoff_', 'ac_Paint_', 'ac_Pit_Apron', 'ac_Road_', 'ac_Service_',
                                    'ac_Parking_', 'ac_Path_', 'ac_Court_', 'ac_Helipad_', 'ac_Causeway_', 'ac_Bridge_', 'ac_Lake_',
                                    'ac_Building_White', 'ac_Terrace_', 'ac_Hut_Timber', 'ac_PitWall', 'ac_Forest_Canopy')),
           ('OCCLUDING_MATERIALS_ALPHA', ('ac_Gravel_',)))),
       ('RAIN_FX', (
           ('PUDDLES_MATERIALS', ('ac_Track_', 'ac_Kerb_')),
           ('SOAKING_MATERIALS', ('ac_Track_', 'ac_Road_', 'ac_Service_', 'ac_Parking_', 'ac_Pit_Apron')),
           ('SMOOTH_MATERIALS', ('ac_Building_Glass', 'ac_Roof_Solar', 'ac_Barrier_Armco', 'ac_Gantry_Metal', 'ac_Scaffold_Steel',
                                 'ac_Garage_Door')),
           ('ROUGH_MATERIALS', ('ac_Terrain_Grass__', 'ac_Gravel_', 'ac_Path_', 'ac_Court_', 'ac_Hut_Thatch', 'ac_Stand_Crowd',
                                'ac_Forest_Canopy')),
           ('LINES_MATERIALS', ('ac_Paint_', 'ac_Runoff_')))))


def csp(out):
    """extension/ext_config.ini from the materials the FBX was written with; every list has to find at least one"""
    names = re.findall(r'^NAME=(.+)$', open(os.path.join(out, 'rwanda_official.fbx.ini')).read(), re.M)
    L = ['; Custom Shaders Patch settings of the official Rwanda layout: 3D grass and rain.',
         '; Written from the material names of rwanda_official.fbx.ini. Not tried in the game yet.', '']
    for section, lists in CSP:
        L.append('[%s]' % section)
        for key, starts in lists:
            found = [n for n in names if n.startswith(starts)]
            for s in starts:
                assert any(n.startswith(s) for n in names), 'no material starts with ' + s
            L.append('%s = %s' % (key, ', '.join(found)))
        L.append('')
    return '\n'.join(L)


def geotag(tags):
    """['lat -2.1712', 'lon 30.2210'] as ['2.1712° S', '30.2210° E'] (the form is not confirmed against the game)"""
    try:
        lat, lon = (float(t.split()[-1]) for t in tags)
    except (ValueError, IndexError):
        return tags
    return ['%.4f° %s' % (abs(lat), 'S' if lat < 0 else 'N'), '%.4f° %s' % (abs(lon), 'W' if lon < 0 else 'E')]


def outline(xz, size, margin, width, colour=(255, 255, 255, 255)):
    """The lap drawn in an image of at most `size` pixels: (image, metres per pixel, x offset, z offset)"""
    lo, hi = xz.min(0), xz.max(0)
    sf = max(hi - lo) / (size - 2 * margin)
    w, h = (np.ceil((hi - lo) / sf) + 2 * margin).astype(int)
    img = Image.new('RGBA', (int(w), int(h)), (0, 0, 0, 0))
    px = (xz - lo) / sf + margin
    ImageDraw.Draw(img).line([tuple(p) for p in np.vstack([px, px[:1]])], fill=colour, width=width, joint='curve')
    return img, sf, -lo[0] + margin * sf, -lo[1] + margin * sf


def main(out, preview=None):
    track = os.path.join(out, 'track', 'rwanda_official')
    for lay, tid in LAYOUTS:
        td = json.load(open(os.path.join(REPO, 'public', 'tracks', tid, 'track_data.json')))
        md = td['metadata']
        xz = np.array([[s['p'][0], s['p'][2]] for s in td['samples']])       # AC's ground plane as the game's: x, z
        for d in ('data', 'ai'):
            os.makedirs(os.path.join(track, lay, d), exist_ok=True)
        os.makedirs(os.path.join(track, 'ui', lay), exist_ok=True)
        with open(os.path.join(track, 'models_%s.ini' % lay), 'w') as f:
            f.write('[MODEL_0]\nFILE=%s\nPOSITION=0,0,0\nROTATION=0,0,0\n\n[MODEL_1]\nFILE=rwanda_official_%s_timing.kn5\n'
                    'POSITION=0,0,0\nROTATION=0,0,0\n' % (KN5, lay))
        with open(os.path.join(track, lay, 'data', 'surfaces.ini'), 'w') as f:
            f.write(surfaces())
        with open(os.path.join(track, lay, 'data', 'lighting.ini'), 'w') as f:
            f.write('[LIGHTING]\nSUN_PITCH_ANGLE=45\nSUN_HEADING_ANGLE=0\n')
        img, sf, xo, zo = outline(xz, 1024, 20, 6)
        img.save(os.path.join(track, lay, 'map.png'))
        with open(os.path.join(track, lay, 'data', 'map.ini'), 'w') as f:
            f.write('[PARAMETERS]\nWIDTH=%d\nHEIGHT=%d\nMARGIN=20\nSCALE_FACTOR=%.5f\nX_OFFSET=%.3f\nZ_OFFSET=%.3f\nDRAWING_SIZE=10\n' % (
                img.size[0], img.size[1], sf, xo, zo))
        outline(xz, 256, 14, 3)[0].save(os.path.join(track, 'ui', lay, 'outline.png'))
        if preview and os.path.exists(preview):
            Image.open(preview).convert('RGB').resize((355, 200), Image.LANCZOS).save(os.path.join(track, 'ui', lay, 'preview.png'))
        ui = {'name': md['name'].replace('—', '-'), 'description': md.get('description', ''),
              'tags': ['circuit', 'rwanda', 'africa', 'bugesera', 'anticlockwise'], 'geotags': geotag(md.get('geotags', [])),
              'country': md.get('country', 'Rwanda'), 'city': md.get('city', 'Bugesera'), 'length': '%d m' % md['lengthMeters'],
              'width': str(md.get('widthMeters', '15m')).replace('m-', '-').replace('m', ' m'), 'pitboxes': str(md.get('pitboxes', 20)), 'run': md.get('direction', 'anticlockwise'),
              'author': 'LibreCorsa', 'version': '0.1', 'url': ''}
        with open(os.path.join(track, 'ui', lay, 'ui_track.json'), 'w') as f:
            json.dump(ui, f, indent=2, ensure_ascii=False)
        print('%-5s %s, %d m, map %dx%d at %.2f m/px' % (lay, ui['name'], md['lengthMeters'], img.size[0], img.size[1], sf))

    os.makedirs(os.path.join(track, 'extension'), exist_ok=True)
    with open(os.path.join(track, 'extension', 'ext_config.ini'), 'w') as f:
        f.write(csp(out))
    with open(os.path.join(out, 'README.txt'), 'w') as f:
        f.write(README)
    print('wrote', out)


README = """RISE MOTORDROME - Assetto Corsa project
======================================

This is the project, not yet a track you can load: Assetto Corsa reads .kn5 models, and those are saved by Kunos'
ksEditor, which only runs on Windows. Nothing in this folder has been opened in ksEditor or in Assetto Corsa. Expect
to adjust things on the first try.

What is here
------------
rwanda_official.fbx        the whole circuit: 1.3 million triangles, no mesh over 60,000 vertices, with the grid, the
                           pit boxes and the hotlap start
rwanda_official.fbx.ini    ksEditor's material file: shader and texture of every material
rwanda_official_gp_timing.fbx, rwanda_official_short_timing.fbx (+ .ini)
                           each lap's three timing gates (and one hidden triangle under the start line). The laps
                           part between the first and the second gate, so each has its own.
texture/                   every texture as PNG
track/rwanda_official/     the track folder for content/tracks, complete except for the models:
    models_gp.ini, models_short.ini      each layout loads rwanda_official.kn5 and its own timing model
    gp/, short/                          data/surfaces.ini, data/lighting.ini, data/map.ini, map.png, an empty ai/
    ui/gp/, ui/short/                    ui_track.json, outline.png, preview.png
    extension/ext_config.ini             Custom Shaders Patch: 3D grass (GrassFX) and rain (RainFX) for both layouts

Steps on the PC
---------------
1. Open rwanda_official.fbx in ksEditor (assettocorsa\\sdk\\editor\\ksEditor.exe). It reads the .fbx.ini beside it
   and the textures from texture\\.
2. Check the size: the road is 12 to 15 m wide and the whole lap about 1.8 km across. If the circuit comes in 100
   times too small or too large, re-export from Blender with the other scale option:
   bl_ac.export(folder, scale='FBX_SCALE_ALL').
3. Check the materials. If ksEditor did not take the .fbx.ini:
   - AC_Wall_Hidden: the invisible walls the cars hit (the six objects with WALL in their name). Untick
     "Is Renderable" on those objects, or give the material alpha blend.
   - ac_Fence_Debris, ac_Palm_Leaf, ac_Tree_acacia_branch_1Mat, ac_Tree_bark05_0Mat, ac_Tree_gbushy: shader
     ksPerPixelAT with alpha test on.
4. File > Save KN5 > Track, as track\\rwanda_official\\rwanda_official.kn5.
5. Do the same with the two small files: rwanda_official_gp_timing.fbx as rwanda_official_gp_timing.kn5 and
   rwanda_official_short_timing.fbx as rwanda_official_short_timing.kn5, into the same folder. If ksEditor will not
   take files this small, delete the [MODEL_1] entry from models_gp.ini and models_short.ini and add the Grand Prix
   lap's six AC_TIME dummies to the main model by hand; the short lap then has no working second gate.
6. Copy track\\rwanda_official into assettocorsa\\content\\tracks\\.

Left to do in Assetto Corsa
---------------------------
- AI lines. gp\\ai and short\\ai are empty. Record fast_lane.ai and pit_lane.ai for each layout with the AI app; until
  then use Practice or Hotlap without opponents.
- The two layouts share one model, so both routes are open on both.
- Cameras (data\\cameras.ini) are not written.
- The sun. data\\lighting.ini has plain values (45 degrees up, heading 0); the model's north is -Z. Turn
  SUN_HEADING_ANGLE until the shadows fall the right way. The coordinates in ui_track.json are written as
  "2.1712° S", "30.2210° E"; that format is not confirmed, so check them on the track's page in Content Manager.
- extension\\ext_config.ini lists the materials by the names in rwanda_official.fbx.ini. If a name changed in
  ksEditor, change it there too (Alt + click a surface with Content Manager's Object Inspector shows the name). Grass
  grows on the lawns, the verges and the land around the lap; night lights are not set up.

Names the physics reads
-----------------------
ROAD, PIT (pit lane and apron, speed limit), KERB, RUNOFF (the painted run-off, off track), GRASS, SAND (the gravel)
and WALL. data\\surfaces.ini defines them.

If the cars start facing the wrong way or lying on their side, the AC_START / AC_PIT / AC_HOTLAP_START dummies need
turning: they were written with Z along the direction of travel and Y up, 0.6 m above the road.

Lengths as built: Grand Prix lap 5,895 m, short lap 5,340 m. Anticlockwise.
"""

if __name__ == '__main__':
    main(os.path.abspath(os.path.expanduser(sys.argv[1])), sys.argv[2] if len(sys.argv) > 2 else None)
