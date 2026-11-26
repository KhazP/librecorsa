# Porting circuits

A local clone of LibreCorsa includes one circuit, RISE Motordrome; all other hosted circuits live in R2 and are gitignored. This guide explains how to convert an Assetto Corsa track mod for a local build, as well as how to model and build an original circuit from scratch in Blender.

To extract a track mod from an F1 25 `.erp` archive instead, see [Porting a circuit from an F1 25 mod](PORTING-F1-MODS.md). Because the mod converter evolved circuit by circuit, expect to read through `port_ac_track.py` and add track-specific overrides for new conversions.

## Prerequisites

- **Node.js:** Run `npm install` once for the simulator, racing-line optimizer, verification suites, and meshopt compressor.
- **[uv](https://docs.astral.sh/uv/):** Executes the Python pipeline using the pinned packages in `scripts/tracks/requirements.txt` (no virtualenv setup required; different Pillow or OpenCV versions work too, though encoded texture bytes may vary slightly).
- **For an Assetto Corsa mod:** The extracted track directory containing `.kn5` models, `models*.ini`, `data/`, and any layout subdirectories. You do not need Assetto Corsa installed.
- **For an original circuit:** [Blender](https://www.blender.org/) (developed against Blender 5.3).

## Converting an Assetto Corsa mod

### 1. Set up the circuit

A mod converts without an entry: give it an id of its own and its track folder, and the converter reads its settings from the mod itself (`scripts/tracks/ac_mod_entry.py`): the layouts, the models in `models_<layout>.ini`, the name, place, pitboxes, author and tags in `ui_track.json`, and the mod's own surface keys in `data/surfaces.ini`. It prints every value with where it came from and marks the ones it guessed (the altitude, a layout name, a description). A JSON file of the keys below, passed with `--settings`, is merged over them:

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/port_ac_track.py my_circuit --src path/to/<track folder> [--layout <name>] [--settings my_circuit.json]
```

A mod with several layouts needs `--layout` (the layout's folder, or its name in the game); without it the converter lists them. `npm run mod -- import ac-track` does the same and packages the result ([docs/importing-mods.md](importing-mods.md)).

The circuits the game hosts have hand-written entries in `AC_TRACKS` at the top of `scripts/tracks/port_ac_track.py`, with the fixes each mod needed and the licence it is hosted under. To add one, copy the closest existing entry:

- **Single layout:** `oschersleben`
- **Multi-layout track folder:** `okayama` / `okayama_piper`, or the `vir_*` entries
- **Street circuit:** `monaco` or `norisring`
- **Hill climb (point-to-point timed run):** `borgloh` or `goodwood`

Required fields:

- `folder`: Name of the source track directory.
- `layout_dir`: Layout subfolder name (`""` for single-layout tracks).
- `models_ini` (the layout's `models_*.ini`) or `kn5_files` (explicit list of `.kn5` files when no `.ini` exists).
- `name`, `layout`, `country`, `city`, `description`.
- `baseAltitudeM`: Elevation above sea level in metres (controls air density).
- `pitboxes`: Number of pit stalls.
- `credit`: `{ title, author, url, short, license, licenseUrl }` shown in the game's credits.
- `type` (`"street"` or `"hillclimb"`) and `pointToPoint: True` where applicable.

Optional override keys let you work around quirks in individual mods (see inline comments on existing entries for concrete examples):

- `physicsNodeOverrides`: Override surface classification when mesh names are ambiguous.
- `hideTextures`, `hideNodes`, `hideMaterials`: Exclude unwanted visual geometry.
- `sectionSkip`, `sectionNames`: Clean up or supply corner names.
- `closeBranches`, `openWalls`: Manage barriers where multiple layouts share asphalt.
- `bakeMultilayerMasks`: Bake splat/blend masks over blank base textures (common on LilSki circuits).
- `texturePatches`: Paint over specific regions of a billboard or sign atlas.
- `extraModels`: Import visual-only props from additional `.kn5` files (never added to physics colliders).
- `driftingObjects`: Import animated `DYNAMIC_OBJECT_n` balloons or blimps from `models.ini` (rendered via `src/lib/render/drifting-objects.ts`).

### 2. Point the converter at your track files

The converter resolves the source folder in this priority order:

1. `--src <folder>` passed directly on the CLI (applies to one folder at a time, across any of its layouts).
2. `scripts/tracks/sources.local.json` (gitignored), mapping folder names or circuit IDs to local paths, e.g., `{ "oschersleben": "/path/to/oschersleben" }`.
3. `$LIBRECORSA_AC_TRACKS/<folder>` (for example, pointing directly at Assetto Corsa's `content/tracks` directory).

### 3. Run the converter

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/port_ac_track.py <id> --src path/to/<track folder>
```

`<id>` can be one circuit, several separated by commas, or `all`. It writes `public/tracks/<id>/track_data.json` and `public/tracks/<id>/<id>.glb`, adds the circuit to `public/tracks/index.json` and `scripts/tracks/tracks.json`, then runs the lap-time racing-line optimiser for the F1 and GT3 cars (`scripts/ai/optimize-lines.ts`, which judges every candidate line on full physics laps: about 10 to 30 minutes per line, by the lap's length: Qiddiya's 8.2 km took 20-25) and meshopt-compresses the GLB.

- One of the optimiser's starts is an optimal-control solve of a single-track car (`scripts/ai/mintime/solve.py`, CasADi + IPOPT, run through `uv`; its packages are fetched on the first run). Without `uv` on PATH it says so and works from the other starts.
- `--no-line-opt` skips the optimiser. The circuit keeps the racing lines of its last build when the new centreline has as many samples; otherwise it gets the minimum-curvature line.
- `--no-glb` writes only the track data. The optimiser needs the GLB, so it is skipped too and the lines are kept the same way.
- `--no-compress` keeps the raw GLB.
- `--extras-only` grafts just the circuit's `extraModels` and `driftingObjects` into its existing GLB (`scripts/tracks/graft-track-extras.mjs`), leaving every other byte of it and the track data as they are. For a circuit whose full rebuild would also change what it ships.

- `--no-line-opt`: Skips the racing-line optimizer (reuses previously optimized lines if sample counts match, otherwise computes a minimum-curvature line).
- `--no-glb`: Regenerates `track_data.json` only (also skips line optimization, since the optimizer requires the GLB).
- `--no-compress`: Writes an uncompressed GLB.
- `--extras-only`: Grafts only `extraModels` and `driftingObjects` into an existing GLB (`scripts/tracks/graft-track-extras.mjs`) without touching other geometry or `track_data.json`.
- `--no-register`: Leaves `public/tracks/index.json` and `scripts/tracks/tracks.json` untouched and writes a standalone `circuit.json` next to the build for packaging as a mod (see [Making mods](modding.md)).

Files consumed from the mod directory:

- `.kn5` models (visual geometry plus physics meshes identified by surface naming)
- `ai/fast_lane.ai` (**required**; provides centreline and track widths)
- `ai/pit_lane.ai` (optional pit lane spline)
- `data/surfaces.ini`, `sections.ini`, `drs_zones.ini`, `cameras.ini`, and `groove.ini` (all optional)

## Building a circuit in Blender

`scripts/tracks/build_blender_track.py` turns a Blender-authored circuit into LibreCorsa's runtime format using the exact same road, kerb, barrier, and racing-line pipeline, with no Assetto Corsa files needed.

### Try the worked example

`scripts/tracks/example_circuit.py` procedurally generates a 1.86 km test circuit (complete with pit lane, hairpin, esses, and a banked turn) as both a `.blend` and a `.glb`:

```bash
blender -b --factory-startup -P scripts/tracks/example_circuit.py -- ~/librecorsa-example
```

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/build_blender_track.py example_circuit --glb ~/librecorsa-example/example_circuit.glb
```

On macOS, invoke Blender via `/Applications/Blender.app/Contents/MacOS/Blender`. Open the generated `example_circuit.blend` to inspect exact mesh naming and layout conventions.

### Modelling conventions

Model in metres using Blender's standard `Z`-up orientation (glTF export automatically converts to LibreCorsa's `Y`-up space):

- **Drivable surfaces and walls:** Name every physical mesh starting with `Road`, `Kerb`, `Runoff`, `Gravel`, `Grass`, `Wall`, or `PitLane`, either alone or followed by `.`, `_`, `-`, a space, or a digit (e.g., `Road.001`, `Kerb_T1`, `Wall 3`). Cars drive directly on these triangles and collide with walls. Any other mesh name is treated as visual-only scenery.
- **Road mesh and UVs:** Keep the road surface smooth with enough lateral subdivisions to represent camber cleanly, and unwrap its UVs so LibreCorsa's custom asphalt shader renders properly. Raise kerbs roughly `1 cm` above the road edge.
- **Materials:** Use Principled BSDF materials. Unless driven by a texture map, LibreCorsa only retains metalness (clamped up to `0.6`) on material names containing metal keywords (`metal`, `steel`, `armco`, `rail`, `guard`, `post`, `pole`, etc.), and enforces minimum roughness of `0.65` (`0.8` for ground surfaces such as asphalt, grass, kerbs, and gravel).
- **`Track_Centreline`:** A closed loop tracing the middle of the road, converted to a mesh (**Object > Convert > Mesh**). Vertical height is projected onto the `Road` mesh below, so the loop may float above the surface.
- **`Track_Start`:** A **Single Arrow** Empty placed on the start/finish line, rotated flat so the arrow points in the direction of travel. Leave roughly `180 m` of clear road behind it for the starting grid.
- **`Track_PitLane` (optional):** A loose-edge mesh line running down the middle of the pit lane from pit entry to pit exit.

> `build_blender_track.py` currently supports closed circuits only; point-to-point hill climbs still require the mod converter.

### glTF export settings

In Blender, open **File > Export > glTF 2.0** with these exact options:

- **Format:** glTF Binary (`.glb`)
- **Data > Mesh > Loose Edges:** **On** (required so `Track_Centreline` and `Track_PitLane` export)
- **Data > Mesh > Apply Modifiers:** **On** if your track uses modifiers such as Array or Curve (off by default)
- **Data > Draco Compression** and **Meshopt Compression:** **Off** (the build script handles meshopt compression separately)

### Settings JSON

Place a `.json` file next to your `.glb` with the same stem (or pass `--settings <file>`):

```json
{
  "name": "My Circuit",
  "layout": "Grand Prix",
  "country": "Somewhere",
  "city": "Some town",
  "baseAltitudeM": 120,
  "pitboxes": 20,
  "description": "One or two sentences for the circuit menu.",
  "credit": {
    "title": "My Circuit",
    "author": "Your name",
    "url": "https://…",
    "license": "CC BY 4.0",
    "licenseUrl": "https://…"
  }
}
```

Any applicable mod-converter setting also works here, such as `minWidthM` for roads narrower than `8.5 m`, or `turns_override` to supply custom corner names.

### Running the Blender builder

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/build_blender_track.py <id> --glb path/to/circuit.glb
```

This writes `public/tracks/<id>/track_data.json` and `public/tracks/<id>/<id>.glb`, updates `public/tracks/index.json`, optimizes racing lines, and compresses the GLB (supporting the same `--no-line-opt`, `--no-glb`, `--no-compress`, and `--no-register` flags). DRS zones are placed automatically on up to the three longest straights of at least `450 m`, TV cameras are distributed around the lap, and turns are numbered sequentially.

## Common issues and fixes

These solutions came out of porting Qiddiya Speed Park, a circuit with sharp elevation crests, tight banked corners, and night lighting. Put these keys in your circuit settings JSON; all work with both converters except `gridBoxes`, `defaultTimeOfDay`, and `nightLighting` (`build_blender_track.py` only).

- **Sharp crests come out flattened:** By default, road elevation is smoothed over `1.5` samples (~`7.5 m`, `profileSmoothSamples`) and crests are eased to a `400 m` minimum radius (`crestMinRadiusM`) to suppress laser-scan noise. On a clean modelled circuit with an intentional sharp crest, this drops the physics surface below the visual road. Lower both values (Qiddiya uses `"crestMinRadiusM": 20` and `"profileSmoothSamples": 0.6`).
- **Car bounces every 5 m through tight banked corners:** The physics collider connects sample rows spaced `5 m` apart with straight chords. On steep, tight banking those chords sag a few centimetres beneath the curve sampled by the tyres, causing rhythmic bouncing. Set `"colliderRowsPerSample": 2` (or `4` for even smoother surfaces at the cost of a few extra megabytes) to place intermediate rows on the true curve. For rapidly twisting banking, also tighten `"roadTwistM"` (Qiddiya uses `0.005`).
- **Kerbs and painted lines Z-fight at distance:** Decals sitting a millimetre above asphalt fight the road surface in the depth buffer. Add a `depthOffset` glTF extra to those materials (Qiddiya uses `-2`; in Blender, add a custom property on the material and export with **Include > Data > Custom Properties** enabled). Materials with `depthOffset` also track road-mesh elevation adjustments so long asphalt triangles never swallow painted lines or kerbs.
- **Mesh complexity is too heavy:** Always simplify geometry with UV preservation enabled so textures don't smear, and exclude thin painted lines from simplification so they don't collapse into jagged wedges.
- **Unwanted real-world branding:** Real logos and photos often hide inside generically named textures. Generate a contact sheet of every texture before publishing and paint over real sponsors, people, and recognizable places.
- **Start grid misaligned with painted grid boxes:** Supply `gridBoxes` with the model-space corner coordinates of each painted box so cars spawn directly inside the paint (`scripts/tracks/painted_grid.py`).
- **Night races and glowing materials:** Set `"defaultTimeOfDay": "night"` to default sessions to night, configure `nightLighting` to place floodlight masts and tunnel lights (see options at the top of `scripts/tracks/night_lighting.py`), and add `nightEmissive` glTF extras specifying `day` and `night` emissive intensities on materials that should illuminate after dark.
- **Custom corner names:** Use `turns_override` to label turns by lap distance in metres, e.g., `[[740, "The Blade"]]`.
- **Testing a hosted circuit privately:** Set `"unlisted": true` to hide the circuit from in-game menus while keeping it accessible via `?track=<id>`.

## Listing the circuit in a local clone

- Add your circuit ID to `REPO_TRACK_IDS` in `src/lib/hosted-content.ts` (local clones only display listed IDs; setting `NEXT_PUBLIC_HOSTED_CONTENT=1` displays every hosted circuit even if its files are absent).
- Run `npm run home-outlines` to regenerate the circuit outline map for the home page.
- Per-circuit AI tuning files in `public/ai` are optional.
- Both converters register new circuits in the tracked `public/tracks/index.json` file. Do **not** commit an `index.json` entry for a circuit whose assets only exist locally: a listed circuit without files will fail to load.

## Verification and compression

```bash
npx tsx scripts/tracks/verify-tracks.ts <id>
npm run dev
```

`verify-tracks.ts` parses the circuit through LibreCorsa's runtime loader, verifies grid placement and GLB collider nodes, and simulates test laps in both F1 cars and the GT3. Launch the dev server, select the circuit, and append `?colliders=1` to visualize the physics surfaces overlaid on the 3D scene.

If you built with `--no-compress`, run `npm run compress-tracks` to meshopt-compress all uncompressed circuits and verify that hidden physics colliders remain bit-exact.

## Circuit file format

Every circuit lives under `public/tracks/<id>/` as two core files:

- **`<id>.glb`:** Must contain `Track_Collider_Road` (a clean drivable physics surface extending `1.6 m` past each road edge) and `Track_Collider_Wall` (barriers). Drivable and off-track meshes carry `userData.surface` (`road`, `kerb`, `sausage`, `runoff`, `pitlane`, `gravel`, or `grass`) and optional `userData.grip`, named `Track_Surface_Road`, `Track_Surface_Kerb`, `Track_Surface_Runoff`, `Track_Surface_Gravel`, and `Track_Surface_Grass` by the converters. See the header comment in `src/lib/sim/f12026-car/TrackColliderQuery.ts` for the full collider contract.
- **`track_data.json`:** Stores metadata, DRS zones, TV cameras, turn markers, sectors, starting grid, pit lane, and dense spline samples (position, width, banking, racing lines, kerbs, run-off, and wall offsets). Inspect `public/tracks/rwanda_official/track_data.json` and `src/lib/track-data.ts` as the canonical reference.

For an advanced, fully scripted Blender build (complete with custom terrain, kerbs, and scenery), see `scripts/tracks/rwanda-official/` and its README, which generates RISE Motordrome directly.

## Licences

- Only port circuits you have the right to use. A mod's terms come with it, and a game's own assets usually can't be redistributed at all.
- **Unlicensed or unauthorised mods are for local use only.** If a mod has no licence, or its author hasn't said you can use it, keep it on your own machine: don't commit it, upload it, host it or share it in any form.
- **Releasing a ported circuit needs permission.** Before you publish one on your fork, your own site or anywhere else, get the author's permission, or check that its licence allows redistribution, and keep a record of it.
- Keep ported content local by default. `public/tracks/` is gitignored apart from RISE Motordrome and `index.json`, so never commit a circuit's files. To get a circuit you have permission for into the game, open a pull request with its entries and a download link to the files, as [Get involved](GET-INVOLVED.md#bring-a-circuit-or-a-car) describes.
- If you share a ported circuit anywhere, credit its author the way `CREDITS.md` does: title, author, link, licence, and what you changed.
