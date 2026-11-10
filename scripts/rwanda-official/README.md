# RISE Motordrome

Builds `public/tracks/rwanda_official/` in Blender: my reading of the circuit's official design (17 corners,
anticlockwise, beside Lake Kidogo) from its published renders and figures, on the site's real ground. Nothing here
comes from a game mod, and the build reads nothing from another circuit's folder: the two tree models (third-party,
CC BY 4.0, credited in `assets/credits.json`) and the project's own barrier, fence, pit wall and gantry textures are
in `assets/`.

One model, two laps over it:

| Id | Lap | Route |
| :-- | :-- | :-- |
| `rwanda_official` | Grand Prix, 5.89 km, 17 corners | outer line through Turn 1, the loop over the ridge, the outer hairpin at Turn 8 |
| `rwanda_official_short` | Short, 5.34 km, 14 corners | inner line through Turn 1, the link road instead of the loop, the inner sweep at Turn 8 |

The inputs (`src/`: my traced centreline and alternate routes, the terrain model, the satellite view, the published
aerial render rectified into a site plan) and everything the steps write on the way (`data/`, the `.blend`) stay out
of the repository.

## Figures

| | Built (Grand Prix lap) | Published |
| :-- | :-- | :-- |
| Length, corners, direction | 5.89 km as traced on the render, 17, anticlockwise | 6 km, 17, anticlockwise |
| Climbed per lap | 191 m | 190 to 197 m |
| Steepest grades | 12.8 % down, 14.8 % up | 12 to 13 %, 14 to 15 % at most |
| Turn 2 | 10.7 % down off the plateau towards it, 12.5 % banking, 14.7 % climb out | 10.8 % down, 12 % banking, 14 to 15 % out |
| Back straight | 1,040 m, from 85 m down to 15 m in the valley, back up to 33 m at its end and 41 m at the Turn 7 apex | over 1,000 m, downhill into the valley, rising into a hairpin |
| Altitude | 1,336 to 1,414 m | 1,300 to 1,400 m |
| Camber | every corner tighter than 180 m radius banks towards its inside | no off-camber corners |

Every figure in the left column is read from the two `track_data.json` files. The lengths are what the traced lines
measure; nothing is scaled to the published 6 km. Two wide kinks on the plateau (190 to 300 m radius) keep the
straight's 2 % crossfall. The short lap climbs 174 m between 1,336 and 1,408 m; its link road leaves a stretch that is
already at 14 % and reaches the upper road 20 m higher within 165 m, so it peaks at 16 %; between 1,120 and 1,135 m
of the short lap the banking is still rolling over from the bend before (under 2 % the wrong way).

The climb: the profile first built stood where the smoothed ground put it and climbed 169 m. The published 190 m is
reached without raising the summit (`src/scratch/design/climb190.py`, a linear programme over the lap's heights): the
lows go down and three humps go up, each within 3.7 m of the lowest or highest ground nearby, at the same steepest
grades and the same vertical acceleration as before. The Bowl's low is 3.4 m deeper (16.2 m), the saddle at Turn 4 1.8
m (57.2 m), the valley of the back straight 5 m (14.5 m, 60 m further on, towards the lowest ground); the Turn 7 hill
is 1.6 m higher (41.6 m), the hump after Turn 8 5.1 m (30.6 m) and the crest of the esses 3.4 m (23.2 m). The plateau,
the pit straight, the summit, the lagoon and the built ends of the three junctions are where they were. A crest in a
bend, or within 60 m before one, stays at 2.5 m/s2 or what was built: at 4.5 m/s2 the short lap's racing line ran off
after the crest of the esses. Cut or fill deeper than 5 m: 814 m of the lap (719 m before), deeper than 10 m: 64 m (101
m before). Against the published grades the lap now holds 14.5 % or more for 117 m (20 m before). `src/` is local and
not in the repository.

The lagoon inside Turn 11 and its stone causeway, the papyrus marsh, the road bridge over the exit of Turn 17, the
lakeside terraces, the huts, the infield's support buildings, truck yards and tree-lined roads, the kart circuit beside
the back straight, the tents on the west field, the roads and the groves of trees stand where the render shows them.
The west end (back straight, Turn 7, Turn 8) is traced on the designer's own aerial; where the two published aerials
disagree, that one wins. Closed woodland away from the track is one canopy mesh with the trees standing in it.

Around the site: the game draws 5.5 km, so the land climbs into a rim of hills between 3.35 and 4.15 km out (crest
121 to 194 m above the lake; the real ground is kept where it is higher) and the lake stops at its foot. Beyond the
lap's surroundings the ground takes field, crop, fallow and woodland colours, and a second, coarser canopy sheet is
the far country's woodlots, where no tree is planted. Trees: 17,548 spots, 14,065 instanced after thinning the ones
deep inside the canopy sheet, in four levels of detail. The packed circuit file is 6.8 MB and 481,000 triangles.

Where the three extra road sections leave the built lap, the built ground gives way to them: what lies wholly under
their asphalt, kerbs, paint and verge is taken out, what crosses their edge is cut fine and meets it a centimetre
lower, and the ground beside them comes to the edge's height within 3 m (a kerb or a painted line keeps its height
above the ground it lies on). Inside the link's hairpin, where the bands of the way in, the bend and the way out meet,
they come to one height and the heart of the bend is level. The game drives on the highest paved surface under a
wheel, so every one of these was a ledge otherwise; the layout check walks both laps from the centre to the barriers
and allows no step over 6 cm. The open stands show scaffolding at
the back and ends under a band of banners; the big screens show their picture on both faces.

## Steps

```bash
PY=~/.venvs/librecorsa-tracks/bin/python   # numpy, scipy, opencv, pillow, scikit-image

$PY -I scripts/rwanda-official/prep.py all          # data/design.npz, data/addons.npz, data/terrain.npz: the design, the extra roads, the ground
$PY -I scripts/rwanda-official/prep_textures.py     # data/tex/*.png: every texture, drawn
```

In Blender (5.x), with this folder on `sys.path`:

```python
import bl_track, bl_addon, bl_terrain, bl_scenery, bl_export
bl_track.build()      # road, markings, kerbs, run-off, verges, pit lane, barriers, colliders
bl_addon.build()      # outer Turn 1, outer Turn 8, the link; the built lap's ground and barriers give way, ends are joined
bl_terrain.build()    # terrain against the corridor's edges, lake
bl_scenery.build()    # buildings, stands, bridge, roads, lakeside, gantries, screens, towers; writes data/trees.json
bl_export.export()    # data/rwanda_official_raw.glb, data/walls.npz (the barriers as lines, for the track data)
```

Then:

```bash
node scripts/rwanda-official/post.mjs                # rwanda_official.glb: alpha modes, WebP textures

# only when the design changed (it resets the racing lines):
$PY scripts/rwanda-official/export_json.py           # both laps' track_data.json
for id in rwanda_official rwanda_official_short; do
  npx tsx scripts/optimize-racing-line.ts --track $id --car f1
  npx tsx scripts/optimize-racing-line.ts --track $id --car gt3
  npx tsx scripts/ai/check-lines.ts --track $id --ceiling 1,1.04,1.08 --write
done

node scripts/rwanda-official/foliage.mjs             # scenery/foliage.glb: the trees, instanced (reads the track data)
npx tsx scripts/verify-rwanda-official.ts
npx tsx scripts/verify-rwanda-official.ts short
```

`prep.py terrain` rebuilds the ground alone. After a change to the terrain or the scenery only, the track data and the
racing lines stay as they are.

## Assetto Corsa project

The same build as an FBX for Kunos' ksEditor, with the track folder around it. Not loaded in ksEditor or in Assetto
Corsa yet: the folder's README lists the steps left on a PC.

```bash
node scripts/rwanda-official/ac_trees.mjs            # data/ac_trees.glb: the instanced trees baked into plain meshes
```

```python
import bl_ac
bl_ac.export('~/Desktop/rwanda_official')            # the FBX, one small timing-gate FBX per lap, texture/*.png, the .fbx.ini files; the scene is left as it was
```

```bash
$PY -I scripts/rwanda-official/ac_data.py ~/Desktop/rwanda_official [preview.jpg]   # track/rwanda_official: surfaces, lighting, maps, interface files, extension/ext_config.ini, README
```

Physics meshes carry AC's names (`ROAD`, `PIT`, `KERB`, `RUNOFF`, `SAND`, `GRASS`, `WALL`); grid, pit boxes and hotlap
start are dummies taken from the Grand Prix lap's track data, 0.6 m above the road. The two laps part between the first and the second
timing gate, so each lap's gates are a small model of their own, listed in that layout's `models_*.ini`.
`extension/ext_config.ini` sets up Custom Shaders Patch's 3D grass and rain from the material names in the `.fbx.ini`
(keys as in CSP's track docs); `ac_data.py` stops if a material it expects is gone. The `.kn5` files themselves still
come out of ksEditor.

| File | What it holds |
| :-- | :-- |
| `ro_design.py` | The cross-section and band layout shared by every step |
| `ro_site.py` | The site plan around the track: lagoon, causeway, marsh, level ground, roads, bridge, stands, cameras, screens, fan zones |
| `ro_addon.py`, `ro_foot.py` | The three road sections off the built lap: their lines, profiles, bands and footprints |
| `prep.py`, `prep_terrain.py`, `prep_textures.py` | Centreline, heights, camber, run-off, walls; terrain points, colours, trees; textures |
| `bl_common.py` | Blender helpers: materials, meshes from arrays, swept strips |
| `bl_track.py`, `bl_addon.py`, `bl_terrain.py`, `bl_scenery.py`, `bl_export.py` | The Blender build |
| `post.mjs`, `foliage.mjs`, `export_json.py` | The game's files |
| `ac_trees.mjs`, `bl_ac.py`, `ac_data.py` | The Assetto Corsa project |
| `assets/` | The tree models with their credits, and the project's own barrier, fence, pit wall and gantry textures |
