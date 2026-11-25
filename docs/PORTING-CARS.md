# Porting cars

The repository includes one circuit (RISE Motordrome) and one car, the 2026 prototype (body in `public/cars/f12026/model/`, sound in `public/cars/f12026/audio/`). This guide is how I add a car to a local clone from two kinds of source:

- **A car mod from another racing game**: a car folder with its KN5 model, skins and an FMOD `.bank` sound file.
- **A Sketchfab-style model**: a glTF/GLB download.

Each porting script was written for particular cars, so expect to read it and adjust it.

## Browser importer: DRS, active aero and electric drive

The in-game Assetto Corsa importer reads `data.acd` or unpacked `data/`. Reimport a car to pick up new physics mappings; existing records are left alone.

If a large archive still runs out of browser memory, extract it locally and use the **Folder** picker on the car's own directory (the one containing the `.kn5` and `data.acd` or `data/`). You do not need to delete the installed car first. The browser reads compressed 7z files in chunks and shares identical large textures without removing any liveries.

For mods you own or have explicit permission to decrypt, the browser importer can restore the main KN5 protected by Custom Shaders Patch (CSP) encoding version 1. Import the complete original package, keeping the original car folder name and `data.acd` if supplied. LibreCorsa rebuilds the textures and geometry locally on HTTPS or localhost, saves a separate copy in the browser (up to 256 MiB per rebuilt model), and leaves the original unchanged. Nothing is uploaded.

Other protection versions and recovery failures are rejected before saving, rather than showing the scrambled preview. To replace an older protected entry, reimport the complete original package or use an unprotected copy from the author. You do not need to delete the installed entry first.

- **Zero-reference turbos:** `REFERENCE_RPM=0` now means boost is available from the first rev, without an invalid 0 RPM power sample. Installed copies with that invalid sample are repaired on reload.
- **Bike-shaped mods such as the Ducati Panigale V4 P Spec:** the importer can align and spin two visible centreline wheels when the mod uses a four-wheel AC chassis underneath. The simulation still uses the authored four-wheel setup, not independent motorcycle balance or CSP's rider and lean animations.
- **DRS:** `drs.ini` binds `ANGLE` or `EFFECT` to the numbered wings in `aero.ini`. The same flap control opens it, but the HUD reads **DRS** instead of **X-mode**. It works in the circuit's DRS zones (with detection in races), unless the car declares `IGNORE_ZONES=1`. Braking, lifting, a wet track, or the car's configured lateral-G limit can close it.
- **Active aero:** `DYNAMIC_CONTROLLER_n` in `aero.ini` drives wing angle from supported inputs (speed, gas, brake, steer, gear, RPM or a constant). Add/multiply stages, limits and filtering are applied to forces. This does not import `.ksanim` wing animation.
- **Hybrids (MGU-K):** the `[KINETIC]` torque and coast curves in `ers.ini`, the supported `ctrl_ers_n.ini` chains, the lap allowance and the authored boost button drive deployment and braking regeneration on the main driven axle. Braking recovery uses braking demand and the coast curve rather than Assetto Corsa's exact `CHARGE_K` formula. Auxiliary motors on a separate axle are not imported.
- **Turbo hybrids (MGU-H):** `[HEAT]` in `ers.ini` supplies a boost-based `CHARGE_K` gain and a `TORQUE_PERC` ceiling relative to the MGU-K. BAL, RAC and CHR charge the battery; PSH, LIC and the car's supported boost override send power directly to the MGU-K without spending the battery's lap allowance. Direct power shares the MGU-K's existing torque and power limits. Recovery is an approximation; it does not electrically spin the turbo or change its boost response.
- **Electric:** a mod that puts all its drive torque in the kinetic unit and has a placeholder-only combustion curve runs on the battery alone. It can launch at zero RPM and recover energy under braking when configured. A finite battery uses an explicit `MAX_KJ` where supplied, otherwise the lap-energy value or the deployment-power × discharge-time estimate. Other electric layouts and CSP Lua powertrains are not inferred.

## What you need

- Node.js, then `npm install` once (the game, the checks and the compressor).
- [uv](https://docs.astral.sh/uv/) for the Python scripts. Each command below pulls its own packages with `--with`, so there is no virtualenv to set up. No Blender: the scripts read and write GLB files directly.
- For sound: `ffmpeg` built with libvorbis, plus the libvorbis and libogg libraries (python-fsb5 loads them to decode Vorbis banks). The script expects `/opt/homebrew/bin/ffmpeg`; pass `--ffmpeg <path>` if yours is elsewhere.

## The rig

The game loads a ported car with `src/lib/ported-car-model.ts`, which expects one GLB laid out like this:

```
CAR                 root node, measurements in its extras
  BODY              everything that doesn't turn: body, cockpit, glass, lights, callipers
  STEER             steering wheel pivot, local +Z along the column into the dash (optional)
  WHEEL_RF          hub pivot at the tyre's centre (likewise WHEEL_LF, WHEEL_RR, WHEEL_LR)
    WHEEL_RF_RIM    rim, hub, brake disc
    WHEEL_RF_TYRE   the tyre as one primitive (the tyre deformation shader needs that)
```

- Metres, +X to the car's left, +Y up, +Z forward, lowest tyre point at y = 0, X centred on the four wheels.
- `CAR` extras: `wheelCentres` (keys `WHEEL_RF`, `WHEEL_LF`, `WHEEL_RR`, `WHEEL_LR`), `tyreRadius` and `tyreHalfWidth` (keys `RF`, `LF`, `RR`, `LR`), `wheelbaseM`, and `cameras` with `cockpit`, `tcam`, `dash`, `bumper`, `nearChase` and `farChase`, each `{ pos, pitchDeg, fov }`.
- The game finds the root by its `wheelCentres`, not by its name. All the porters below write this layout; it matters when you change one.

## Route A: a car mod from another game

### Body

`scripts/cars/port_ac_car.py` reads the folder's main `.kn5` and one skin. It splits the model by the mod's node names: meshes under `WHEEL_RF`/`LF`/`RR`/`LR` become that wheel, meshes under `STEER_HR` the steering wheel, the rest `BODY`. The cockpit camera comes from `DRIVEREYES` in `car.ini`, read from `data/` or `data.acd`.

```bash
uv run --python 3.14 --no-project --with numpy --with pillow \
  python -P scripts/cars/port_ac_car.py \
  path/to/<car folder> public/cars/<id>/model/<id>.glb --skin <skin folder>
```

Options: `--car <preset>` (default: the preset for the folder's name, from `PRESET_BY_FOLDER`), `--kn5 <file>` (default `<folder name>.kn5`), `--max-tex`, `--small-tex` and `--normal-tex` (texture caps in px, defaults 2048, 1024 and 512), `--jpeg-quality` (default 88), `--skins-out <folder>` (also writes every skin's livery files there). Keep the folder's original name: `data.acd` is decoded with a key made from it.

Each car I wrote it for has a preset in `PRESETS`, and the script stops without one, so another mod needs a preset of its own. Copy the closest:

- `materials` maps that car's materials to glTF names and PBR values. A material missing from it falls back to its diffuse texture on a plain surface. A preset with `auto=True` leaves `materials` empty and makes every material from its shader values, naming only the paint in `paint`. The names matter: `src/lib/render/ported-car-materials.ts` picks the paint, rubber, metal, glass and mirror treatments by material name.
- `tyre_prefix` (the tyre nodes' name prefix, `object__90` on the Liana) or `tyre_materials` finds each tyre under its wheel. Set one for your car, or the script stops with "expected one tyre under each WHEEL_xx". With `tyre_prefix`, each tyre must use a single material.
- `skin_files` and the `bake:` entries in `materials` bake the skin's detail map into the paint (an `auto` preset takes the skin folder's textures by name instead); `--skin` defaults to the preset's `default_skin`.
- `windscreen` names the glass material the dash camera is fitted to, and `title` goes into `source.title` in the extras.

### Sound

`scripts/audio/port_ac_bank.py` turns an FMOD `.bank` into the game's format: Ogg Vorbis loops anchored at engine RPMs, one-shots and a `manifest.json`. `public/cars/f12026/audio/` is a finished example.

```bash
# The bank's samples: names, rate, channels, length
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --list "/path/to/car.bank"
# Its RPM intervals and the RPM each sample plays at natural pitch
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --inspect "/path/to/car.bank"
# Write public/cars/<id>/audio/ from your entry in car_configs.json
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --car <id>
```

The mapping is `scripts/audio/car_configs.json`, one entry per car id. Add your own entry (copying `f12026` is a good start):

- `outDir`: `public/cars/<id>/audio`
- `intBank`, plus `extBank` if the mod has separate interior and exterior banks (an absolute path, or relative to `$AC_BANKS_DIR` / `~/Downloads`)
- `sourceDescription`: where the sound came from, copied into the manifest
- `engine.int` and `engine.ext`, each with `on` and `off` lists of `{ "rpm", "rootRpm", "sample" }`: the anchor RPM, the RPM the sample plays at natural pitch (from `--inspect`; defaults to `rpm`) and the sample name (from `--list`)
- `throttleCurve` and `lift`, copied from an entry for a similar engine
- optional: `turbo`, `transmission`, `skid`, `tractionControl`, `oneshots` (sample lists by role, as in the existing entries), `shiftFallbackSample`, `limiterFallbackSample`

`--car` deletes any `.ogg` in `outDir` that the new manifest doesn't use.

## Route B: a Sketchfab-style model

### Open-wheelers

`scripts/cars/port_sketchfab_f1.py` bakes the model's node transforms, finds the tyres, rims and steering wheel by material name, and writes the rig.

```bash
uv run --python 3.14 --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_f1.py \
  path/to/model.glb public/cars/<id>/model/<id>.glb
```

- It takes a preset from `CAR_PRESETS` by the output or input file name, or by `--car <preset>`. For any other model it guesses: materials named like `tyre`, `tread` or `sidewall` that sit more than 0.45 m off the centre line are tyres; `rim`, `wheel_hub`, `disc` or `brake` are rims; `steer`, `_sw` or `lcd` belong to the steering wheel.
- When the guess is wrong, say which materials are which: `--tyre-mats`, `--rim-mats` and `--steer-mats` take lists of material names, `--steer-box XMIN XMAX YMIN YMAX ZMIN ZMAX` is the box (in metres) that holds the steering wheel, and `--no-steer` leaves the wheel in `BODY`. The "Could not find any tyre primitives" error lists the names it tried.
- `--scale <factor>` or `--wheelbase <metres>` resize the model. `--max-tex`, `--small-tex` and `--jpeg-quality` (defaults 2048, 1024, 92) set the textures.
- It doesn't rotate anything. The model must follow the glTF convention (front towards +Z, Y up) and be in metres, since the guess measures before any `--scale`.

### GT3-type cars

`scripts/cars/port_sketchfab_gt3.py` is two converters for two specific models, not a general tool. It takes `<source.glb> <out.glb>` and no options, runs `port_ddiaz_bmw` when the file has a node named `3DWheel Front L` and `port_vtx_amg` otherwise, and the second relies on that model's tyre material name and a measured steering pivot.

```bash
uv run --python 3.14 --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_gt3.py path/to/model.glb public/cars/<id>/model/<id>.glb
```

For another closed-wheel car, add a `port_<model>` function beside those two, modelled on the closer one, and pick it in `main()`. `GlbWriter`, `make_steer_frame` and `copy_and_downscale_materials` in the same file do the writing.

## Registering the car

1. In `src/lib/cars/car-registry.ts`, add the id to the `CarId` union and an entry to `ALL_CARS`:
   - `id`, `classId` (`"f1"`, `"gt3"`, `"proto"`, `"classic"` or `"road"`), `title`, `sub`, `badge`, `year`
   - `quality`: `"own"`, `"shared"` or `"era"`, i.e. whether the physics were built for this car
   - `physics`: the vehicle model under it, a `VehicleModelId` from `src/types/f1.ts` such as `"lc26"`, `"f12026-car"`, `"amg-gt3"` or `"liana"`
   - `modelUrl: "/cars/<id>/model/<id>.glb"`
   - `credit: { title, author, url, license, licenseUrl }` for the model's author
   - `sound`: a `CarSoundSource` (next section)
2. In `src/lib/hosted-content.ts`, add the id to `REPO_CAR_IDS`. A clone lists only those cars, so yours stays hidden without it. Setting `NEXT_PUBLIC_HOSTED_CONTENT=1` instead lists every car, including hosted ones whose files you don't have.
3. In `scripts/verify-car-sounds.ts`, add the id to `EXPECTED_SOUNDS` with its sound and `maxIdleRpm`, and in `src/lib/render/onboard-views.ts` add the car's dash view to `OVER_WHEEL`. Both are typed `Record<CarId, ...>`, so `npx tsc --noEmit` fails until you do.

A ported car of class `f1` follows the open-wheel physics switch in the menu; its `physics` sets the chassis the body is fitted to. A car on `amg-gt3` uses the AMG GT3's cameras, framed on its own steering wheel.

## Sound

Add a `CarSoundSource` to `src/lib/sim/CarAudio.ts` and use it as the entry's `sound`:

```ts
export const MY_CAR_SOUND: CarSoundSource = { id: "<id>", assetDir: "/cars/<id>/audio/", limiterRpm: 12500 };
```

`limiterRpm` is the recording's rev limiter. If the vehicle model's limiter differs, add `physicsLimiterRpm` with the model's, and the sound is rescaled to reach its own limiter. Without a bank of your own, use `F1_2026_SOUND`, the bank the repository ships.

## Checking it

```bash
npx tsc --noEmit
npx tsx scripts/verify-ported-roots.ts   # loads every listed ported GLB the way the browser does
npm run dev
```

Then open `http://localhost:3000/?car=<id>`. For a ported car of class `f1`, add `&f1physics=lc26` or `&f1physics=f12026-car` to try each physics model.

`verify-ported-gt3.ts` checks the GT3s hosted on librecorsa.org by name (and skips them in a clone), so it doesn't check yours. Read it for what a good port measures: GLB size, one-primitive tyres, mirrored wheel centres, the body's height off the road, all six cameras.

The deploy meshopt-compresses every car GLB before building, and the game reads both kinds. I keep the raw file locally, since the porters and the checks above work on it. `node scripts/compress-car-glb.mjs <file.glb>` shows the compressed size, but it rewrites the file in place, so run it on a copy.

## Licences

- Only port models and sounds you have the right to use. A model's licence and a mod's terms come with it, and a game's own assets usually can't be redistributed at all.
- **Unlicensed or unauthorised mods are for local use only.** If a mod has no licence, or its author hasn't said you can use it, keep it on your own machine: don't commit it, upload it, host it or share it in any form.
- **Releasing a ported car needs permission.** Before you publish one on your fork, your own site or anywhere else, get the author's permission, or check that its licence allows redistribution, and keep a record of it.
- Keep ported content local by default. `public/cars/` is gitignored apart from the 2026 car, so never commit a car's models or sounds. To get a car you have permission for into the game, open a pull request with its code and a download link to the files, as [Get involved](GET-INVOLVED.md#bring-a-circuit-or-a-car) describes.
- If you share a ported car anywhere, credit its author the way `CREDITS.md` does: title, author, link, licence, and what you changed.
