# Porting cars

A fresh clone of LibreCorsa ships with one circuit (RISE Motordrome) and two cars, the LC26 Prototype (`public/cars/f12026/model/` and `public/cars/f12026/audio/`) and the LC25 Prototype (`public/cars/lc25/`). This guide walks through porting additional cars into a local clone from two common sources:

- **Car mods from other racing sims:** Folders containing `.kn5` geometry, skins, and FMOD `.bank` audio.
- **Sketchfab-style 3D models:** Standalone `.glb` / `.gltf` downloads.

Because each porting script was built around specific source cars, treat them as adaptable templates: you will usually need to inspect the source hierarchy and add or tweak a preset.

## Prerequisites

- **Node.js:** Run `npm install` once to enable the simulator, verification scripts, and GLB compressor.
- **[uv](https://docs.astral.sh/uv/):** Runs the Python converters with isolated `--with` dependencies, with no manual virtualenv or Blender installation required (the scripts read and write GLB binaries directly).
- **Audio tools (for FMOD banks):** `ffmpeg` compiled with `libvorbis`, plus system `libvorbis` and `libogg` libraries (loaded by `python-fsb5` to decode Vorbis banks). By default the script looks for `/opt/homebrew/bin/ffmpeg`; override it with `--ffmpeg <path>` if installed elsewhere.

## Expected GLB rig

`src/lib/ported-car-model.ts` expects every ported car in a single `.glb` structured as follows:

```text
CAR                 root node storing vehicle measurements in glTF extras
  BODY              non-rotating meshes: chassis, cockpit, glass, lights, brake callipers
  STEER             steering wheel pivot, local +Z along the steering column into the dash (optional)
  WHEEL_RF          hub pivot centred on the tyre (same pattern for WHEEL_LF, WHEEL_RR, WHEEL_LR)
    WHEEL_RF_RIM    wheel rim, hub, and brake disc
    WHEEL_RF_TYRE   tyre mesh as a single primitive (required by the tyre deformation shader)
```

Coordinate system and metadata contract:

- **Units and orientation:** Metres, `+X` to the car's left, `+Y` up, `+Z` forward, lowest tyre point resting at `y = 0`, and `X` centred across the four wheels.
- **Root `extras`:** Must include `wheelCentres` (`WHEEL_RF`, `WHEEL_LF`, `WHEEL_RR`, `WHEEL_LR`), `tyreRadius` and `tyreHalfWidth` (`RF`, `LF`, `RR`, `LR`), `wheelbaseM`, and `cameras` (`cockpit`, `tcam`, `dash`, `bumper`, `nearChase`, `farChase`, each `{ pos, pitchDeg, fov }`).
- **Root discovery:** LibreCorsa locates the root node by the presence of `wheelCentres` in its extras rather than by node name. All porting scripts below produce this structure automatically.

## Route A: Porting a car mod from another sim

### Converting the 3D body

`scripts/cars/port_ac_car.py` reads the mod's main `.kn5` model and a chosen skin. It splits geometry by node hierarchy: meshes under `WHEEL_RF`/`LF`/`RR`/`LR` become wheels, `STEER_HR` becomes the steering wheel, and everything else goes into `BODY`. The cockpit eye position is read from `DRIVEREYES` in `car.ini` (inside `data/` or `data.acd`).

```bash
uv run --python 3.14 --no-project --with numpy --with pillow \
  python -P scripts/cars/port_ac_car.py \
  path/to/<car folder> public/cars/<id>/model/<id>.glb --skin <skin folder>
```

Useful options:

- `--car <preset>`: Override the preset (defaults to matching the folder name in `PRESET_BY_FOLDER`; `auto` builds an automatic one).
- `--kn5 <file>`: Specify the `.kn5` filename (defaults to `<folder name>.kn5`).
- `--max-tex`, `--small-tex`, `--normal-tex`: Texture resolution caps in pixels (defaults: `2048`, `1024`, `512`).
- `--jpeg-quality`: Texture compression quality (default: `88`).
- `--skins-out <folder>`: Export texture overrides for every skin in the mod folder.
- `--skins-only <a,b>`: Export only the skins named.
- `--report <file.json>`: Write what the porter made and what it found.

A car with no preset gets an automatic one, and the porter prints what it found:

- **Model:** `<folder name>.kn5`, else the file `lods.ini` names for LOD_0, else the largest `.kn5` that is neither a lower LOD nor the collider.
- **Tyres** under each `WHEEL_xx`: the meshes AC's tyre shader (`ksTyres`) draws, else those named as tyres (`tyre`, `tire`, `gomma`, `rubber`… on the material, then the node), else by shape (the outermost ring round the hub).
- **Paint:** the body material named as paint that covers the most of the body and is repainted by the most skins.
- **Windscreen:** the glass most of the driver's sight lines pass through (from `DRIVEREYES`), an outer layer before an inner one or a gauge's glass.
- **Discs** beside the wheels (`DISC_xx` at all four corners) spin with them. Broken glass, blurred rims, the low-detail cockpit and fastened belts are left out.
- **Materials** come from their shader values (as with `auto=True`), every texture a skin replaces becomes a livery file, and the name comes from `ui/ui_car.json`.

> Keep the mod's original folder name intact: `data.acd` decryption derives its key from the folder name.

The automatic choices are guesses. When one is wrong, a preset of the car's own in `PRESETS` fixes it; copy the closest and configure:

- **`materials`:** Maps source material names to glTF names and PBR properties. Unlisted materials fall back to a plain diffuse surface. Setting `auto=True` leaves `materials` empty and derives PBR parameters automatically from the mod's shader values, requiring only `paint` to be named. Material names matter: `src/lib/render/ported-car-materials.ts` assigns paint, rubber, metal, glass, and mirror shaders based on them.
- **`tyre_prefix` or `tyre_materials`:** Identifies the tyre mesh under each `WHEEL_xx` node (for example, `object__90` on the Liana). One of the two is required, or the script aborts with `"expected one tyre under each WHEEL_xx"`. When using `tyre_prefix`, each tyre must use a single material.
- **`skin_files` and `bake:` entries:** Bakes skin detail maps into paint textures (`auto=True` presets pick skin textures by filename instead). `--skin` falls back to the preset's `default_skin`.
- **`windscreen` and `title`:** `windscreen` names the glass material used to frame the dash camera; `title` populates `source.title` in glTF extras.

### Converting the FMOD sound bank

`scripts/audio/port_ac_bank.py` unpacks an FMOD `.bank` into RPM-anchored Ogg Vorbis loops, one-shots, and a `manifest.json` (see `public/cars/f12026/audio/` for a reference output).

```bash
# 1. List all samples in the bank (name, sample rate, channels, duration)
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --list "/path/to/car.bank"

# 2. Inspect RPM bands and natural pitch RPM for each sample
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --inspect "/path/to/car.bank"

# 3. Export public/cars/<id>/audio/ using your entry in car_configs.json
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --car <id>
```

Add an entry for your car in `scripts/audio/car_configs.json` (copying `f12026` as a template). For a quick start, `--auto <bank> --out <folder> --limiter <rpm> --idle <rpm>` makes one from the bank's sample names instead (interior or exterior, on or off the throttle, and an rpm or a word such as `onlow`, `offmedhigh` or `idle`, spread over the car's own idle-to-limiter range); check it by ear. An entry holds:

- `outDir`: Target directory, e.g., `public/cars/<id>/audio`.
- `intBank` (and optional `extBank` when interior/exterior banks are separate): Absolute path or path relative to `$AC_BANKS_DIR` / `~/Downloads`.
- `sourceDescription`: Attribution metadata copied into `manifest.json`.
- `engine.int` and `engine.ext`: Each defines `on` (load) and `off` (coast) arrays of `{ "rpm", "rootRpm", "sample" }`, pairing anchor RPMs with natural pitch RPMs from `--inspect` (defaults to `rpm`) and sample names from `--list`.
- `throttleCurve` and `lift`: Copy from an entry with a similar engine architecture.
- Optional channels: `turbo`, `transmission`, `skid`, `tractionControl`, `oneshots`, `shiftFallbackSample`, and `limiterFallbackSample`.

Running `--car` automatically deletes any stale `.ogg` files in `outDir` not referenced by the generated manifest.

## Route B: Porting a Sketchfab-style GLB

### Open-wheel cars

`scripts/cars/port_sketchfab_f1.py` bakes node transforms, detects tyres, rims, and steering wheels by material name, and writes a compliant rig:

```bash
uv run --python 3.14 --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_f1.py \
  path/to/model.glb public/cars/<id>/model/<id>.glb
```

- **Auto-detection and presets:** Matches `CAR_PRESETS` by input/output filename or `--car <preset>`. For unknown models, it classifies materials automatically: names matching `tyre`, `tread`, or `sidewall` sitting more than `0.45 m` from the centreline become tyres; `rim`, `wheel_hub`, `disc`, or `brake` become rims; `steer`, `_sw`, or `lcd` attach to the steering wheel.
- **Manual overrides:** If heuristics miss, pass `--tyre-mats`, `--rim-mats`, or `--steer-mats` with explicit material lists, constrain the steering wheel with `--steer-box XMIN XMAX YMIN YMAX ZMIN ZMAX` (in metres), or pass `--no-steer` to keep the wheel inside `BODY`. If tyre detection fails (`"Could not find any tyre primitives"`), the error prints every material name it checked.
- **Scaling and textures:** Resize via `--scale <factor>` or `--wheelbase <metres>`, and adjust textures with `--max-tex`, `--small-tex`, and `--jpeg-quality` (defaults: `2048`, `1024`, `92`).
- **Orientation prerequisite:** The script does not rotate the model, so make sure the source GLB already follows standard glTF orientation (`+Z` forward, `+Y` up) and uses metric scale before running, because detection heuristics measure prior to `--scale`.

### GT3 and closed-wheel cars

`scripts/cars/port_sketchfab_gt3.py` contains two dedicated converters (`port_ddiaz_bmw` if the GLB has a `3DWheel Front L` node, otherwise `port_vtx_amg`) rather than a generic converter:

```bash
uv run --python 3.14 --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_gt3.py path/to/model.glb public/cars/<id>/model/<id>.glb
```

To port another closed-wheel Sketchfab car, add a new `port_<model>` function modelled on the closer existing converter and dispatch to it in `main()`, reusing `GlbWriter`, `make_steer_frame`, and `copy_and_downscale_materials` from the same script.

## Registering the car

Once the model (and optional audio) are in `public/cars/<id>/`:

1. **`src/lib/cars/car-registry.ts`:** Add your ID to the `CarId` union and append an entry to `ALL_CARS`:
   - Metadata: `id`, `classId` (`"f1"`, `"gt3"`, `"proto"`, `"classic"`, or `"road"`), `title`, `sub`, `badge`, `year`.
   - Physics: `quality` (`"own"`, `"shared"`, or `"era"`) and `physics` (a `VehicleModelId` from `src/types/f1.ts`, such as `"lc26"`, `"f12026-car"`, `"amg-gt3"`, or `"liana"`).
   - Assets and attribution: `modelUrl: "/cars/<id>/model/<id>.glb"`, `sound` (a `CarSoundSource`), and `credit: { title, author, url, license, licenseUrl }`.
2. **`src/lib/hosted-content.ts`:** Add your ID to `REPO_CAR_IDS` so local clones display it in the car selector. (Setting `NEXT_PUBLIC_HOSTED_CONTENT=1` instead exposes all hosted cars, even those whose files you don't have locally.)
3. **Exhaustive maps:** Add an entry to `EXPECTED_SOUNDS` (including `maxIdleRpm`) in `scripts/verify/verify-car-sounds.ts` and a dash camera entry to `OVER_WHEEL` in `src/lib/render/onboard-views.ts`. Both use `Record<CarId, ...>`, so TypeScript will flag missing entries.

Cars with `classId: "f1"` automatically respect the menu's open-wheel physics toggle (`physics` determines which chassis the body fits). Cars using `amg-gt3` physics inherit the AMG GT3's camera rig framed around their own steering wheel.

## Wiring up sound

Declare a `CarSoundSource` in `src/lib/sim/CarAudio.ts` and reference it in your `ALL_CARS` entry:

```ts
export const MY_CAR_SOUND: CarSoundSource = {
  id: "<id>",
  assetDir: "/cars/<id>/audio/",
  limiterRpm: 12500,
};
```

Set `limiterRpm` to the recording's rev limiter. If the underlying physics model revs to a different limit, also provide `physicsLimiterRpm` so LibreCorsa rescales pitch to hit the limiter cleanly. If you haven't ported a dedicated audio bank yet, reuse `F1_2026_SOUND` (included in the repository).

## Verification and compression

```bash
npx tsc --noEmit
npx tsx scripts/verify/verify-ported-roots.ts   # verifies every listed car GLB loads as the browser expects
npm run dev
```

Open `http://localhost:3000/?car=<id>` to inspect your port in-game. For `f1`-class cars, append `&f1physics=lc26` or `&f1physics=f12026-car` to test both open-wheel physics engines.

Although `scripts/verify/verify-ported-gt3.ts` targets the hosted GT3 models by name (and skips them in a local clone), it is a great checklist for verifying your own port: GLB file size, single-primitive tyres, symmetrical wheel centres, ground clearance, and all six camera viewpoints.

During deployment, car GLBs are meshopt-compressed (LibreCorsa loads both raw and compressed files). Keep raw GLBs locally while iterating, as the porters and verification tools operate on uncompressed meshes. To test compressed file size, run `node scripts/cars/compress-car-glb.mjs <file.glb>` on a copy: it overwrites the input file in place.

## Licences

- Only port models and sounds you have the right to use. A model's licence and a mod's terms come with it, and a game's own assets usually can't be redistributed at all.
- **Unlicensed or unauthorised mods are for local use only.** If a mod has no licence, or its author hasn't said you can use it, keep it on your own machine: don't commit it, upload it, host it or share it in any form.
- **Releasing a ported car needs permission.** Before you publish one on your fork, your own site or anywhere else, get the author's permission, or check that its licence allows redistribution, and keep a record of it.
- Keep ported content local by default. `public/cars/` is gitignored apart from the 2026 car, so never commit a car's models or sounds. To get a car you have permission for into the game, open a pull request with its code and a download link to the files, as [Get involved](GET-INVOLVED.md#bring-a-circuit-or-a-car) describes.
- If you share a ported car anywhere, credit its author the way `CREDITS.md` does: title, author, link, licence, and what you changed.
