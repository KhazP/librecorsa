# Sketchfab F1 Car Porter (`port_sketchfab_f1.py`)

`scripts/cars/port_sketchfab_f1.py` converts single-hierarchy Sketchfab F1 car GLB exports (`Sketchfab_model > root > GLTF_SceneRootNode > <car>_0 > Object_N`) into the node hierarchy and `CAR` root `extras` expected by LibreCorsa's generic ported-car rig (`src/lib/ported-car-model.ts`).

## Usage

Run with `uv` (using cached `numpy` and `Pillow`, without modifying any project virtualenv):

```bash
uv run --python 3.14 --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_f1.py \
  /Users/alpyalay/Downloads/librecorsa-src/<id>/<id>.glb \
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

`scripts/cars/port_ac_car.py` converts an Assetto Corsa car (its main `.kn5` plus one skin) into the same `CAR` / `BODY` / `STEER` / `WHEEL_xx` layout. It is written for the Suzuki Liana 1.6 (its `MATERIALS` table maps the car's 57 kn5 materials); the kn5 reader, the hierarchy split and the paint bake are generic AC.

```bash
uv run --python 3.14 --no-project --with numpy --with pillow \
  python -P scripts/cars/port_ac_car.py \
  /Users/alpyalay/Downloads/librecorsa-src/suzuki_liana/suzuki_liana \
  public/cars/liana/model/liana.glb --skin light_blue
```

Flags: `--skin <folder>` (skin whose maps override the kn5's, default `light_blue`), `--kn5 <file>` (default `<folder name>.kn5`), `--max-tex` / `--small-tex` / `--normal-tex` (size caps: 2048 paint, 1024 other colour maps, 512 normal maps), `--jpeg-quality` (default 88).

- **Axes**: the kn5 frame is already the rig's (+X left, +Y up, +Z forward, counter-clockwise faces); the porter only lifts the lowest tyre point to `y = 0` and centres X on the wheels. car.ini's `GRAPHICS_OFFSET` is not applied (the rig aligns by wheel centres).
- **Parts**: meshes under `WHEEL_xx` are the wheel (the `object__90*` tyre one primitive, everything else `WHEEL_xx_RIM`), under `STEER_HR` the steering wheel (its node frame becomes `STEER`), the rest `BODY`, one mesh per material. Blurred rims (`RIM_BLUR_*`), shift-light quads (`LED_*`), LODs, damage and dirt maps are dropped.
- **Paint**: `ksPerPixelMultiMap` materials are baked to one opaque colour texture as AC shades them, `diffuse * (detail * (1 - diffuse.a) + diffuse.a)` in gamma space, with the skin's `MAT_plancia.dds` as the body's detail: the paint takes the skin colour, badges (alpha 1) keep their own.
- **Cameras**: the cockpit eye from car.ini `DRIVEREYES` (read from `data/` or `data.acd`); dash, bumper and roof cameras placed from the geometry.
