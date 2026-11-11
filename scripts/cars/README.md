# Sketchfab F1 Car Porter (`port_sketchfab_f1.py`)

`scripts/cars/port_sketchfab_f1.py` converts single-hierarchy Sketchfab F1 car GLB exports (`Sketchfab_model > root > GLTF_SceneRootNode > <car>_0 > Object_N`) into the node hierarchy and `CAR` root `extras` expected by LibreCorsa's generic ported-car rig (`src/lib/ported-car-model.ts`).

## Usage

Run with `uv` (using cached `numpy` and `Pillow`, without modifying any project virtualenv):

```bash
uv run --python 3.14 --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_f1.py \
  path/to/<id>.glb \
  public/cars/<id>/model/<id>.glb
```

### Optional CLI Flags

- `--car <id>`: Explicitly select a car preset (`sf26`, `w17`, `rb22`, `sf71h`, `rb8`, `r25`, `f2004`). By default, inferred from the destination/source filename stem, with an automatic material-name/geometry fallback for unknown models.
- `--scale <factor>` / `--wheelbase <metres>`: Uniformly scale the model by a constant factor or to match a target wheelbase in metres.
- `--max-tex <px>` / `--small-tex <px>`: Maximum texture dimension for primary livery/body textures (default `2048`) and secondary/part textures (default `1024`).
- `--jpeg-quality <1-100>`: JPEG quality for opaque textures (default `92`).
- `--tyre-mats ...` / `--rim-mats ...` / `--steer-mats ...`: Override material name lists for tyres, rims, or steering wheel extraction.
- `--steer-box XMIN XMAX YMIN YMAX ZMIN ZMAX`: Override the 3D bounding box (in metres) used to isolate steering wheel connected components.
- `--no-steer`: Keep the steering wheel inside `BODY` instead of splitting a `STEER` pivot node.

## Output Layout

- **Axes & Scale**: Real-world metres, `+X` car-left, `+Y` up, `+Z` forward, lowest tyre contact at `y = 0`, symmetric wheel X centres.
- **Hierarchy**:
  - `CAR` (root node with `extras`: `wheelCentres`, `tyreRadius`, `tyreHalfWidth`, `wheelbaseM`, `steerBase`, `cameras`, `source`)
    - `BODY` (static chassis, aero, cockpit, suspension, and brake calipers merged by material)
    - `STEER` (steering wheel pivot positioned at the steering hub centre, rotating around local `Z`)
    - `WHEEL_RF`, `WHEEL_LF`, `WHEEL_RR`, `WHEEL_LR` (hub pivots at each tyre's tread centre)
      - `WHEEL_xx_RIM` (rotating wheel rim, spokes, hub, and brake disc)
      - `WHEEL_xx_TYRE` (single-primitive tyre mesh for `installTyreDeformation`)

# Assetto Corsa Car Porter (`port_ac_car.py`)

`scripts/cars/port_ac_car.py` converts an Assetto Corsa car (its main `.kn5` plus one skin) into the same `CAR` / `BODY` / `STEER` / `WHEEL_xx` layout. Each car has a preset in `PRESETS`: its material table, the nodes and materials it leaves out, the skin files that override the kn5's, how its tyre meshes and spinning parts are named, and its windscreen. There are two, the Suzuki Liana 1.6 (`liana`) and the MTRacing 496R (`mtr-496r`); the kn5 reader, the hierarchy split and the paint bake are generic AC.

```bash
uv run --python 3.14 --no-project --with numpy --with pillow \
  python -P scripts/cars/port_ac_car.py \
  path/to/suzuki_liana \
  public/cars/liana/model/liana.glb --skin light_blue
uv run --python 3.14 --no-project --with numpy --with pillow \
  python -P scripts/cars/port_ac_car.py \
  path/to/mt_mtr_496r \
  public/cars/mtr-496r/model/mtr-496r.glb
```

Flags: `--car <preset>` (default: by the car folder's name), `--skins-out <folder>` (also every skin's livery files, the preset's `skin_maps`, into `<folder>/<skin>/` with a `skins.json` listing them: the 496R's go to `public/cars/mtr-496r/skins`), `--skin <folder>` (skin whose maps override the kn5's, default the preset's: `light_blue`, `04_mtrgreen_metallic`), `--kn5 <file>` (default `<folder name>.kn5`), `--max-tex` / `--small-tex` / `--normal-tex` (size caps: 2048 paint, 1024 other colour maps, 512 normal maps), `--jpeg-quality` (default 88).

- **Axes**: the kn5 frame is already the rig's (+X left, +Y up, +Z forward, counter-clockwise faces); the porter only lifts the lowest tyre point to `y = 0` and centres X on the wheels. car.ini's `GRAPHICS_OFFSET` is not applied (the rig aligns by wheel centres).
- **Parts**: meshes under `WHEEL_xx` are the wheel (the tyre, `object__90*` on the Liana and `g_Tyre_*` on the 496R, one primitive; everything else `WHEEL_xx_RIM`, joined by the 496R's `DISC_xx` brake discs), under `STEER_HR` the steering wheel (its node frame becomes `STEER`), the rest `BODY`, one mesh per material. Blurred rims (`RIM_BLUR_*`), LODs, damage and dirt maps are dropped, and each preset's own list (the Liana's shift-light quads, the 496R's fastened belts and inner windscreen).
- **Paint**: `ksPerPixelMultiMap` materials are baked to one opaque colour texture as AC shades them, `diffuse * (detail * (1 - diffuse.a) + diffuse.a)` in gamma space, with the skin's `MAT_plancia.dds` as the body's detail: the paint takes the skin colour, badges (alpha 1) keep their own. The 496R's paint is its skin's `skin.dds` under the same mask with the flake map as its mean colour (`bakemean:`); its carbon takes the material's detail weave, its UVs scaled by `detailUVMultiplier`.
- **Wheel dash**: a preset's `steer_nodes` (the 496R's screen `GEO_LCD` and its `RPM_*` shift lights) stay nodes of their own under `STEER`; the screen's material becomes `INT_DISPLAY`, which the game draws its live display on, and the CAR node's `revLeds` extras give each light's rpm and colour from the car's `digital_instruments.ini` (`src/lib/render/ported-wheel-dash.ts`).
- **Liveries**: the GLB's `skinMaps` extras name the materials a livery repaints and the file each takes from a skin's folder; the rig swaps them in for the livery a player picks (`CarDefinition.skins`).
- **Cameras**: the cockpit eye from car.ini `DRIVEREYES` (read from `data/` or `data.acd`); dash, bumper and roof cameras placed from the geometry.

# Physics from a mod's data (`mod-physics-import.ts`, `verify-mod-parity.ts`)

`port_ac_car.py` ports a car's meshes. Its physics is a `*Config.ts` written by hand from the mod's data files, and two
scripts keep that honest:

```bash
# Draft the part of a config the data states (car folder with data/ or data.acd, or an unpacked data folder)
npx tsx scripts/cars/mod-physics-import.ts <folder> > /tmp/NewCarConfig.draft.ts

# Check every value a config takes from its data against the files, and list the keys it leaves uncarried
npx tsx scripts/verify-mod-parity.ts [--unread]
```

The draft carries each value converted to this sim's units and tagged with its file and key; what the data does not
state is marked `TODO`. The parity suite reads the data folders from the local reference kit (`REALISM_REF`, default
`../_realism-ref/mods/<id>`) and skips a car whose folder is absent. A new car gets a section there.

