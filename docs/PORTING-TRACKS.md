# Porting circuits

The repository includes one circuit, RISE Motordrome. Every other circuit is hosted on librecorsa.org and is gitignored. This guide is how I convert an Assetto Corsa circuit mod for a local clone, and how to build a circuit of your own in Blender. An F1 25 track mod has its own page: [Porting a circuit from an F1 25 mod](PORTING-F1-MODS.md).

The converter was written circuit by circuit, so expect to read it and adjust it for a new one.

## What you need

- Node.js, then `npm install` once (the game, the racing-line optimiser, the checks and the compressor).
- [uv](https://docs.astral.sh/uv/) for the Python scripts. The commands below pull the pinned packages from `scripts/tracks/requirements.txt`, so there is no virtualenv to set up. Other Pillow or OpenCV versions work, but they encode some textures to different bytes.
- For a mod: its track folder, the one with the `.kn5` models, `models*.ini` files, `data/` and the layout folders. You don't need the game itself to convert a mod.
- For your own circuit: [Blender](https://www.blender.org/) (I use 5.3).

## Converting a mod

### 1. Add the circuit

Every circuit has an entry in `AC_TRACKS` at the top of `scripts/tracks/port_ac_track.py`. Copy the closest existing one:

- a circuit with one layout: `oschersleben`
- several layouts in one folder: `okayama` and `okayama_piper`, or the `vir_*` entries
- a street circuit: `monaco` or `norisring`
- a hill climb (one timed run, no laps): `borgloh` or `goodwood`

The fields every entry needs:

- `folder`: the name of the mod's track folder
- `layout_dir`: the layout's subfolder (`''` when the folder holds a single layout)
- `models_ini` (the layout's `models_*.ini`) or `kn5_files` (a list of `.kn5` files, when the mod has no ini)
- `name`, `layout`, `country`, `city`, `description`
- `baseAltitudeM`: the circuit's height above sea level, for air density
- `pitboxes`
- `credit`: `title`, `author`, `url`, `short`, `license`, `licenseUrl`, shown in the game's credits
- `type` (`'street'` or `'hillclimb'`) and `pointToPoint: True` where they apply

The other keys fix things a particular mod needs: `physicsNodeOverrides` when the mod's surface names don't say what a surface is, `hideTextures`, `hideNodes` and `hideMaterials` to leave meshes out, `sectionSkip` and `sectionNames` for corner names, `closeBranches` and `openWalls` where several layouts share the asphalt, `bakeMultilayerMasks` for terrain drawn from a blend mask over a blank base texture (LilSki's circuits), `texturePatches` to paint over one panel of a sign atlas, `extraModels` to draw props from another of the mod's models (never as physics), and `driftingObjects` for a models ini whose `DYNAMIC_OBJECT_n` balloons or blimps float over the circuit (drawn moving as Assetto Corsa moves them, `src/lib/render/drifting-objects.ts`). The comments next to each one in the existing entries say what it was for.

### 2. Point it at the folder

The converter looks for the track folder in this order:

1. `--src <folder>` on the command line (one folder at a time, for any of its layouts)
2. `scripts/tracks/sources.local.json`, a gitignored file mapping folder names (or circuit ids) to paths: `{ "oschersleben": "/path/to/oschersleben" }`
3. `$LIBRECORSA_AC_TRACKS/<folder>`, e.g. set to Assetto Corsa's `content/tracks` if you have the game

### 3. Run it

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/port_ac_track.py <id> --src path/to/<track folder>
```

`<id>` can be one circuit, several separated by commas, or `all`. It writes `public/tracks/<id>/track_data.json` and `public/tracks/<id>/<id>.glb`, adds the circuit to `public/tracks/index.json` and `scripts/tracks/tracks.json`, then runs the lap-time racing-line optimiser for the F1 and GT3 cars (`scripts/ai/optimize-lines.ts`, which judges every candidate line on full physics laps: about 10 to 30 minutes per line, by the lap's length: Qiddiya's 8.2 km took 20-25) and meshopt-compresses the GLB.

- One of the optimiser's starts is an optimal-control solve of a single-track car (`scripts/ai/mintime/solve.py`, CasADi + IPOPT, run through `uv`; its packages are fetched on the first run). Without `uv` on PATH it says so and works from the other starts.
- `--no-line-opt` skips the optimiser. The circuit keeps the racing lines of its last build when the new centreline has as many samples; otherwise it gets the minimum-curvature line.
- `--no-glb` writes only the track data. The optimiser needs the GLB, so it is skipped too and the lines are kept the same way.
- `--no-compress` keeps the raw GLB.
- `--extras-only` grafts just the circuit's `extraModels` and `driftingObjects` into its existing GLB (`scripts/graft-track-extras.mjs`), leaving every other byte of it and the track data as they are. For a circuit whose full rebuild would also change what it ships.

From the mod it reads:

- the `.kn5` models: visual meshes, and the physics meshes by their surface names
- `ai/fast_lane.ai`: required, since the centreline and the road width are taken from it
- `ai/pit_lane.ai`: optional, the pit lane
- `data/`: `surfaces.ini`, `sections.ini`, `drs_zones.ini`, `cameras.ini` and `groove.ini`, each optional

## Building a circuit in Blender

`scripts/tracks/build_blender_track.py` turns a circuit modelled in Blender into the game's files. It runs the same road, kerb, wall and racing-line steps as the mod converter, so you don't need Assetto Corsa.

### Try the example

`scripts/tracks/example_circuit.py` models a small test circuit in Blender from code: a 1.86 km loop with a pit lane, a hairpin, esses and a banked corner. Build it and convert it:

```bash
blender -b --factory-startup -P scripts/tracks/example_circuit.py -- ~/librecorsa-example
```

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/build_blender_track.py example_circuit --glb ~/librecorsa-example/example_circuit.glb
```

On a Mac, `blender` is `/Applications/Blender.app/Contents/MacOS/Blender`. The first command also saves `example_circuit.blend` next to the GLB: open it to see how the meshes are named and laid out.

### Modelling

Work in metres with Blender's Z up; the export turns it into the game's Y up.

- **Surfaces**: name each mesh the cars touch by what it is: `Road`, `Kerb`, `Runoff`, `Gravel`, `Grass`, `Wall` or `PitLane`, alone or followed by `.`, `_`, `-`, a space or a digit (`Road.001`, `Kerb_T1`, `Wall 3`). The cars drive on those meshes' triangles and hit the walls. Meshes with any other name are scenery: drawn, never driven on.
- **The road** should be smooth, with enough faces across it for its camber. Unwrap its UVs: the game draws the road's materials with its own asphalt shader, which needs them. Lay kerbs a centimetre or so above the road edge.
- **Materials**: Principled BSDF, as the glTF exporter expects. The game keeps metalness (up to 0.6) only on material names that say metal (metal, steel, armco, rail, guard, post, pole and the like), and roughness at 0.65 or more (0.8 for ground: asphalt, grass, kerbs, gravel), unless a texture sets them.
- **`Track_Centreline`**: a curve down the middle of the road all the way round, converted to a mesh (Object > Convert > Mesh). It can float above the road; the heights come from the road under it.
- **`Track_Start`**: an empty with Single Arrow display on the start line, rotated so the arrow lies flat and points the way the cars go. The grid lines up behind it, so leave about 180 m of road there.
- **`Track_PitLane`** (optional): the same kind of line down the middle of the pit lane, from its entry to its exit.

Closed circuits only for now: a hill climb still needs the mod converter.

### Exporting

File > Export > glTF 2.0, with:

- Format: glTF Binary (`.glb`)
- Data > Mesh > Loose Edges: on. That's how `Track_Centreline` and `Track_PitLane` get into the file.
- Data > Mesh > Apply Modifiers: on if any mesh is built with modifiers (an Array or Curve road, say). It is off by default, and the meshes then export without them.
- Draco Compression and Meshopt Compression (under Data): off

### Settings

Next to the GLB, a JSON file with the same name (or pass `--settings <file>`):

```json
{
  "name": "My Circuit",
  "layout": "Grand Prix",
  "country": "Somewhere",
  "city": "Some town",
  "baseAltitudeM": 120,
  "pitboxes": 20,
  "description": "One or two sentences for the circuit menu.",
  "credit": { "title": "My Circuit", "author": "Your name", "url": "https://…", "license": "CC BY 4.0", "licenseUrl": "https://…" }
}
```

The keys the mod converter reads also work here, e.g. `minWidthM` for a road narrower than 8.5 m or `turns_override` to name the corners.

### Converting

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/build_blender_track.py <id> --glb path/to/circuit.glb
```

It writes `public/tracks/<id>/track_data.json` and `public/tracks/<id>/<id>.glb`, adds the circuit to `public/tracks/index.json`, runs the racing-line optimiser and compresses the GLB, with the same `--no-line-opt`, `--no-glb` and `--no-compress` options. A DRS zone goes on each of the three longest straights that is at least 450 m long, the TV cameras are spread round the lap, and the corners are numbered in order. Then list it and check it as below.

## Problems you're likely to hit

I ran into these porting Qiddiya Speed Park, a modelled circuit with a sharp crest, tight banked corners and a night race. The settings go in the circuit's settings JSON and work with both converters, except `gridBoxes`, `defaultTimeOfDay` and `nightLighting`, which only `build_blender_track.py` reads.

- **A crest comes out lower than the model.** The road's height profile is smoothed along the lap (`profileSmoothSamples`, 1.5 samples by default, about 7.5 m) and crests are eased to a 400 m radius (`crestMinRadiusM`), so scan ripple doesn't launch the cars. On a clean model with a real sharp crest that cuts the crest down, and the car drives under the drawn road. Lower both: Qiddiya uses `"crestMinRadiusM": 20` and `"profileSmoothSamples": 0.6`.
- **The car bounces through a tight banked corner.** The physics surface is built from rows 5 m apart joined by straight lines. Round a tight banked corner those lines sag a few centimetres off the curve the wheels read the road height from, and the car bounces every 5 m. `"colliderRowsPerSample": 2` puts the rows on that curve, two per 5 m. Four smooths it more but makes the GLB a few MB bigger. If the road also twists quickly, `"roadTwistM"` (Qiddiya: 0.005) cuts the road surface finer where it twists.
- **Kerbs and lines break up in the distance.** Paint lying a millimetre over the road fights it for depth. Give those materials a `depthOffset` in their glTF extras (Qiddiya's paint uses -2) and the game draws them in front. In Blender that's a custom property on the material, exported with Include > Data > Custom Properties on. Paint with a `depthOffset` also moves with the road under it when the game fits the drawn road to the physics one, so long road triangles don't bury the kerbs.
- **The model is too heavy.** Simplify meshes with their UVs kept, or the textures smear. Leave painted lines out of any simplification: they're thin enough to turn into wedges.
- **Sponsor logos.** Real brands hide in textures with generic names. Before you publish, look at every texture the circuit uses (a contact sheet makes it quick) and paint over logos, photos of real people and photos of real places.
- **The grid doesn't sit on the painted boxes.** `gridBoxes` takes the corner points of each painted box in the model's coordinates and stands the grid on the paint (`scripts/tracks/painted_grid.py`).
- **A night race.** `"defaultTimeOfDay": "night"` starts sessions at night until the player picks a time. `nightLighting` places floodlight masts and lights tunnels (its settings are at the top of `scripts/tracks/night_lighting.py`). A material that should glow at night gets `nightEmissive` extras with its `day` and `night` strength.
- **Corner names.** `turns_override` names corners by distance round the lap in metres: `[[740, "The Blade"]]`.
- **Testing a hosted circuit before it's listed.** `"unlisted": true` keeps it out of the game's lists. It still opens by link (`?track=<id>`).

## Listing it in the game

- A clone lists only the circuits in `REPO_TRACK_IDS` in `src/lib/hosted-content.ts`. Add your id there. Setting `NEXT_PUBLIC_HOSTED_CONTENT=1` instead lists every circuit, including hosted ones whose files you don't have.
- `npm run home-outlines` draws the circuit's map for the home page.
- The AI's per-circuit settings are optional: see the tuning files in `public/ai`.
- Both converters add the circuit to `public/tracks/index.json`, which is tracked. Don't commit that change for a circuit whose files only you have: a listed circuit without its files can't load.

## Checking it

```bash
npx tsx scripts/tracks/verify-tracks.ts <id>
npm run dev
```

`verify-tracks.ts` builds the track data through the game's own code, checks the grid sits on the road and the GLB has its collider nodes, and drives a lap in both F1 cars and the GT3. Then pick the circuit in the menu and drive it. Add `?colliders=1` to the address to see the physics surfaces drawn over the circuit.

If you converted with `--no-compress`, `npm run compress-tracks` compresses every listed circuit that isn't yet and checks the physics meshes come out bit-exact.

## What a circuit is

A GLB and a `track_data.json` in `public/tracks/<id>/`:

- **The GLB** needs `Track_Collider_Road`, a low-resolution drivable surface covering the road plus 1.6 m each side, and `Track_Collider_Wall` for the barriers. Drivable and off-road surfaces are meshes tagged with `userData.surface` (`road`, `kerb`, `sausage`, `runoff`, `pitlane`, `gravel` or `grass`) and optionally `userData.grip`. The converters name them `Track_Surface_Road`, `Track_Surface_Kerb`, `Track_Surface_Runoff`, `Track_Surface_Gravel` and `Track_Surface_Grass`. The full contract is the comment at the top of `src/lib/sim/f12026-car/TrackColliderQuery.ts`.
- **`track_data.json`** holds the circuit's metadata, DRS zones, cameras, turns, sectors, spawn grid, pit lane and a sample every few metres along the lap (position, width, banking, racing lines, kerbs, run-off and walls each side). `public/tracks/rwanda_official/track_data.json` is the reference schema, and `src/lib/track-data.ts` reads it.

`scripts/rwanda-official/` builds RISE Motordrome in Blender and writes both files itself, with its own terrain, kerbs and scenery. It is written for that one site, so read it as a worked example of a more detailed build. Its README explains the steps.

## Licences

- Only port circuits you have the right to use. A mod's terms come with it, and a game's own assets usually can't be redistributed at all.
- **Unlicensed or unauthorised mods are for local use only.** If a mod has no licence, or its author hasn't said you can use it, keep it on your own machine: don't commit it, upload it, host it or share it in any form.
- **Releasing a ported circuit needs permission.** Before you publish one on your fork, your own site or anywhere else, get the author's permission, or check that its licence allows redistribution, and keep a record of it.
- Keep ported content local by default. `public/tracks/` is gitignored apart from RISE Motordrome and `index.json`, so never commit a circuit's files. To get a circuit you have permission for into the game, open a pull request with its entries and a download link to the files, as [Get involved](GET-INVOLVED.md#bring-a-circuit-or-a-car) describes.
- If you share a ported circuit anywhere, credit its author the way `CREDITS.md` does: title, author, link, licence, and what you changed.
