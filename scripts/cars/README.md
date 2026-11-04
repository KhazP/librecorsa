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
