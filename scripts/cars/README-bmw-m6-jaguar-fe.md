# BMW M6 GT3 & Jaguar I-Type 4 Formula E — Porting & Legality Documentation

Converted from vetted Creative Commons Sketchfab GLB sources via `scripts/cars/port_bmw_m6_jaguar_fe.mjs` into LibreCorsa's generic ported-car rig (`CAR` / `BODY` / `STEER` / `WHEEL_RF` / `WHEEL_LF` / `WHEEL_RR` / `WHEEL_LR`).

## 1. Provenance & Licensing (Legality Audit)

All third-party assets were audited prior to integration to ensure **zero game-rip provenance** (no Forza Motorsport, Assetto Corsa Kunos/encrypted, or Gran Turismo rips) and **explicit permissive / CC licensing** compatible with LibreCorsa:

| Asset | Author | Source URL | License | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **BMW M6 GT3** (`bmw-m6-gt3`) 3D Model | **ᗩᒪE᙭. Kᗩ.🚗** | https://sketchfab.com/3d-models/fb5d595766974a57868f84890f4425d2 | **CC BY-NC 4.0** (`https://creativecommons.org/licenses/by-nc/4.0/`) | Single-author scratch-built/engraved Sketchfab model (`85,105` tris). Non-commercial attribution preserved in `src/lib/cars/car-registry.ts` and `CREDITS.md`. |
| **Jaguar I-Type 4 Formula E** (`jaguar-fe`) 3D Model | **3dblender_1** | https://sketchfab.com/3d-models/c722e175f91240a88eec2d777b6d503f | **CC BY 4.0** (`https://creativecommons.org/licenses/by/4.0/`) | Single-author scratch-built Blender model (`295,806` tris). Attribution preserved in `src/lib/cars/car-registry.ts` and `CREDITS.md`. |
| **BMW M6 GT3** Audio (`BMW_M6_GT3_SOUND`) | **corsamode** | Reuses `/cars/bmw-m4-gt3/audio/` | Non-commercial AC mod (see `CREDITS.md`) | Existing hosted LibreCorsa GT3 BMW sound bank; scaled to `7000 rpm` redline. |
| **Jaguar I-Type 4 Formula E** Audio (`JAGUAR_FE_SOUND`) | LibreCorsa | Procedural Web Audio (`electric: true` in `src/lib/sim/CarAudio.ts`) | **AGPL-3.0-or-later** | 100% procedural EV inverter + straight-cut gear whine synthesis; bypasses all combustion audio loops. |
| **BMW M6 GT3** Tyre Sidewall | **sagatron918** | Existing `public/cars/shared/tyres/gt/` Michelin pack | Used with permission (see `CREDITS.md`) | Configured in `src/lib/render/gt-tyre-sidewall.ts`. |

- **Excluded / Rejected Downloads**: Earlier unverified or game-ripped downloads in `carsupd/` are excluded from git (`carsupd/` is untracked/local-only). `carsupd/porsche911.glb` was verified via `git hash-object` to be an identical duplicate (`ad2f53484a98dad42790e758c17ec2137cf2741f`) of `formula_e__jaguar_i_type-4.glb` and was not integrated.
- **Hosted Asset Policy**: Per `.gitignore` and `CREDITS.md`, `public/cars/<id>/` binary models/thumbnails remain hosted-only (not committed to git); `REPO_CAR_IDS` in `src/lib/hosted-content.ts` enables local testing.

## 2. Physics & Rigging Summary

- **BMW M6 GT3 (`src/lib/sim/gt3/BmwM6Gt3Config.ts`, `BmwM6Gt3Sim.ts`)**:
  - 4.4L Twin-Turbo V8 (P63) torque curve (`372 kW` BoP shaft cap, `7000 rpm` redline, `1385 kg`, `51.5%` front weight bias, `2.771 m` wheelbase, 6-speed sequential Ricardo ratios).
  - Un-steered the source model's 22° showroom front wheels (`WHEEL_LF` / `WHEEL_RF`), separated steering wheel + paddles into `STEER`, added a live `BMW_DASH_SCREEN` digital dashboard, smoked motorsport glass, and calibrated `BMW_M6_GT3_by_Alex_Ka` PBR materials.
- **Jaguar I-Type 4 Formula E (`src/lib/sim/fe/JaguarFeConfig.ts`, `JaguarFeSim.ts`)**:
  - Single-speed electric reduction gearbox (`ratios: [2.25]`, `finalDrive: 3.10`, `18,500 rpm`, `~322 km/h` top speed, `~2.8s` 0–100 km/h launch).
  - `300 kW` (`402 hp`) race power + `350 kW` (`469 hp`) Attack Mode / Boost, `52 kWh` (`187.2 MJ`) battery with `250 kW` regen, and **zero** DRS / Straight Mode (`hasDrs: false`, `carOvertakingRules` returns `undefined`).
  - TV Pod (`tcam`) camera automatically engages the `GrandPrixHud` `HaloCluster` (`src/components/F1TelemetryHud.tsx`, `GrandPrixHud.tsx`, `grand-prix-halo.tsx`), adapted to 1-speed gear display and aligned over the Halo, plus a live OLED telemetry display on the steering wheel (`Object_55` / `Material.002`).
