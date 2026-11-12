# Ported GT3 cars (`amg-gt3`, `bmw-m4-gt3`)

`scripts/cars/port_sketchfab_gt3.py` converts the two Sketchfab GT3 GLBs into the generic car rig layout read by `src/lib/ported-car-model.ts`.

## Sources (CC BY-NC-SA 4.0)

* **Mercedes-AMG GT3 Evo (`amg-gt3`, its GLB in `public/cars/amg-gt3-evo/`)**: `"Mercedes-AMG GT3"` by **Vecarz** (`@heynic`), <https://sketchfab.com/3d-models/mercedes-amg-gt3-wwwvecarzcom-6a3f7e3455064721b74b7f0b66427a07>, ported from the Red Bull Racing version by **VTX** (`@VTX_car`), <https://sketchfab.com/3d-models/mercedes-amg-gt3-red-bull-racing-035f061cb6624effbc483d5f9b5ecaba>
* **BMW M4 GT3 Evo (`bmw-m4-gt3`)**: `"2025 BMW M4 GT3 EVO G82"` by **Ddiaz Design** (`@ddiaz-design`), <https://sketchfab.com/3d-models/2025-bmw-m4-gt3-evo-g82-113f83dd87064697a5ec2511d280b9d5>

## Run commands

```bash
uv run --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_gt3.py \
  path/to/amg_gt3_rb.glb \
  public/cars/amg-gt3-evo/model/amg-gt3-evo.glb

uv run --no-project --with numpy --with scipy --with opencv-python-headless --with pillow \
  python -P scripts/cars/port_sketchfab_gt3.py \
  path/to/bmw_m4_gt3.glb \
  public/cars/bmw-m4-gt3/model/bmw-m4-gt3.glb
```

*(If the cached `uv` Python is 3.10, omit `-P`.)*

## Output layout (`CAR` root)

* Axes: `+X` left, `+Y` up, `+Z` forward, metres, floor at `y = 0`, X centred on the four wheels.
* `CAR` root `extras`: `wheelCentres`, `tyreRadius`, `tyreHalfWidth`, `wheelbaseM`, `trackWidthM`, `steer`, `cameras`, `source`.
* `BODY`: exterior, interior, seat, glass, lights, brake discs and callipers baked in car space.
* `STEER`: steering-wheel pivot with local `+Z` pointing along the steering column into the dash (`rotateZ(+)` turns the top of the wheel right).
* `WHEEL_RF`, `WHEEL_LF`, `WHEEL_RR`, `WHEEL_LR`: hub pivots at `wheelCentres`, each with `WHEEL_<corner>_RIM` and `WHEEL_<corner>_TYRE` children centred on the hub.
