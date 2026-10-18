# Rwanda F1 2026 Web Simulator

A high-frequency, browser-based **2026 Formula 1 simulator** set on a **fictional, fan-made Rwanda circuit** (`5.30 km`, 14 corners, `1,400 m` altitude) at Bugesera. Built with **Next.js 15**, **React 19**, **Three.js (WebGL2)**, and the **Web Audio API**, the simulator runs entirely client-side as a static web app and supports zero-cost serverless **WebRTC Peer-to-Peer multiplayer**.

This is an independent fan project. It is not affiliated with Formula 1, the FIA or any team.

---

## Key Features

### 1. Fan-Made Rwanda Circuit
- **Laser-Sharp 3D Track Mesh & Environment**: The full `5,301 m` clockwise layout (`public/tracks/rwanda/rwanda_2026.glb`), built procedurally in Blender. It has a 52 m elevation range, banked corners and a rubbered-in racing line. Red/white apex kerbs and Rwanda-flag exit kerbs, painted run-off and gravel traps are included. Around the circuit are TecPro and Armco barriers, debris fences, the pit lane and pit building, and covered and open grandstands. A start gantry with live start lights, jumbotrons showing the circuit map, the paddock, the lake and East African foliage complete the scene.
- **Optional real-world circuits**: pick a circuit under *Circuit* on the title menu: Red Bull Ring, Suzuka (2001), Shanghai, Madring (2026), Nürburgring GP, the Indianapolis oval and Motegi. Each is a CC BY 4.0 Sketchfab scan converted by `scripts/tracks/build_track.py`. The script traces the centreline from the racing-surface material, rescales the model to the official lap length, and detects width, elevation, banking, kerbs, run-off, gravel, barriers, corners and DRS zones. It writes `public/tracks/<id>/track_data.json`, plus a GLB with hidden `Track_Collider_*` / `Track_Surface_*` physics meshes and WebP textures, which `scripts/compress-track-glb.mjs` then meshopt-compresses (the physics meshes stay bit-exact). Those details are auto-detected and can differ from the real venue. Open the sim with `?colliders=1` to draw the physics surfaces over the scan (road blue, kerb red, run-off yellow, gravel orange, grass green, barriers magenta).
- **3D Optimal Racing Line & Dynamic Braking Zone**: Displays a 3D dashed racing line along the circuit that dynamically transitions between **Emerald Green** (full throttle), **Amber Yellow** (lift / prepare to brake), and **Crimson Red** (active braking zone) based on real-time vehicle speed, aerodynamic downforce, and upcoming corner apex speeds. On every circuit the line is the lap-time-optimal one for the car class, not the geometric minimum-curvature line: the F1 cars share one, and the GT3 drives and shows its own (`scripts/optimize-racing-line.ts`).
- **Broadcast & Onboard Camera Views**: `C` cycles **Cockpit Eye-Point** (live steering-wheel LCD, live wing mirrors, suspension/kerb micro-shake), **Broadcast T-Cam**, **Chase** and **Trackside TV**: automatic telephoto (18–24°) broadcast cameras on dolly splines along the outside of each corner, which pan with the car, cut between stations and zoom in as it attacks the kerbs.
- **Golden-hour rendering**: AgX tone mapping, a 14° sun `Sky` baked into a PMREM environment, horizon fog, a car-tracking ±55 m sun shadow, mipmap bloom (rear FIA light, sun), clearcoat paint, carbon weave, a rubbered-in racing line with specular sheen, and GPU tyre deformation (contact-patch flattening, sidewall bulge, carcass shear) driven by the tyre model's load, lateral force and camber (`src/lib/render/`).

### 2. 500 Hz 4-Wheel Vehicle Dynamics & 2026 F1 Regulations
- **VF26 Car Data**: Chassis, suspension, tyre, aero, engine, ERS, gearbox and brake parameters live in `src/lib/sim/vf26-data.ts`, calibrated to 2026 FIA technical regulation baselines and empirical aerodynamic / tyre lookup tables.
- **3D Cartesian Rigid-Body Integration (`500 Hz` / `dt = 0.002 s`, 4 × 2 kHz sub-steps)**: Decoupled fixed-timestep physics solver integrating world position and heading directly in 3D Cartesian space, with wheels riding the track cross-section surface on a smooth (C2 spline) track reference.
- **2026 FIA Power Unit & Active Aerodynamics**:
  - **1.6L V6 Turbo ICE (`~540 kW`) + `350 kW` MGU-K Hybrid System** with `4 MJ` ERS battery State-of-Charge management, brake-by-wire regenerative harvest, auto-clutch launch, and **Manual Override (`/boost`)** sustaining full electrical deployment up to `337 km/h`.
  - **Active Aerodynamics (`Z-Mode` & `X-Mode`)**: Switch between high-downforce cornering configuration (`Z-Mode`) and low-drag straight-line profile (`X-Mode`), with altitude-corrected air density ($\rho \approx 1.07\text{ kg/m}^3$) and ride-height-sensitive wings and floor. X-Mode top speeds: `≈338 / 331 / 324 km/h` for the low / balanced / high downforce packages.
- **Tyres, Suspension & Brakes**:
  - Tyre model with a Pacejka Magic Formula slip curve fitted to the compound data, combined slip, load sensitivity, carcass relaxation, a load-dependent rolling radius and pneumatic trail. A 9-node thermal model (inner/middle/outer × surface/bulk/carcass) drives the grip window, and ideal-gas inflation pressure sets the carcass stiffness. Wear is modelled too. All of this covers the **Soft**, **Medium** and **Hard** compounds.
  - Double-wishbone geometry (roll centres computed from suspension hardpoints), springs, dampers, bump stops, anti-roll bars and heave elements, and a preload/power/coast ramp limited-slip differential; brake-by-wire with MGU-K harvest and optional TC/ABS. `320 → 100 km/h` takes `~100 m` with ABS.
  - Traction control works on the friction circle: the wheelspin it allows shrinks as the rear tyres use more grip for cornering, so a throttle stab mid-corner is caught instead of spinning the car.
- **Gamepad Steering Assist**: Slip-angle-limited controller steering (`src/lib/sim/gamepad-assist.ts`). Full stick steers up to the front tyres' peak slip angle at any speed, the wheel self-aligns toward the rear axle's direction of travel to catch slides, and a yaw-rate guard stops held countersteer from turning into a tank-slapper. Can be switched off in the settings panel.
- **Racing-Line AI**: Follows the circuit's racing line with a target-speed profile computed from the car's grip, downforce, brakes and power, and laps the circuit in `~1:38–1:39`.

- **f12026-car (selectable)**: A second 6-DOF rigid-body car model (`src/lib/sim/f12026-car`). Pick it under *Car setup → Car* in the Esc menu, or open the sim with `?car=f12026-car`; the choice is remembered. It is a rigid body on the track GLB's `Track_Collider_Road` / surface colliders, with barrier contact against `Track_Collider_Wall_Left/Right` (the car is deflected along the wall and scrubs speed). It uses a load-sensitive normalized-slip tyre model (`Dy0`, `Dx0`, `lsExpY`, `lsExpX`, `Fz0`, `friction_limit_angle`, `dcamber0/1(_x)`) and a friction-ellipse combined-slip formulation (`combinedFactor`, `new_combined`). DRS is driver-operated (X): it opens only inside a DRS zone after the car crosses that zone's detection point (within 1 s of the car ahead when racing the AI), and closes on the brake or a lift. A HUD panel shows the live telemetry channels `WHEEL_SR_*`, `BUMPSTOPUP_TRAVEL_*`, `AERO_HEIGHT`, `AERO_BALANCE`, `LSD_LOCKING_TORQUE` and `CHANGED_DRS_OPEN`, plus each tyre's friction-circle use.
- **Mercedes-AMG GT3 (selectable)**: A GT3 car on the 6-DOF vehicle model (`src/lib/sim/gt3`), picked under *Car setup → Car* or with `?car=amg-gt3`. Configured with a naturally aspirated 6.2L V8, 6-speed sequential gearbox, double-wishbone suspension, GT3 aero package, slicks, conventional hydraulic brakes and multi-stage ABS / TC slip limits (no ERS or DRS). The braking line, braking warning and HUD target speed use the GT3's own planning model, so its braking points come much earlier than the F1 car's. On the brakes the auto gearbox clicks down early and keeps the engine near 6200 rpm, as a driver on the paddles would.

### 3. 2026 F1 3D Model, Driver & Sounds
- Renders the 2026 F1 car (`public/vf26/model/vf26.glb`) with reshaped 2026 aero: drooped, tapered nose, swept front wing and deeper sidepod undercut. The livery is matte navy with gloss yellow and red accents, satin carbon and gunmetal rims, with no sponsor branding. The wheels and uprights steer and spin, the brake discs glow, the shift lights follow rpm, X-Mode opens the wings using DRS poses, and the tyre sidewall changes with the compound.
- The 3D driver (suit, gloves, shoes and helmet in matching Metallic Blue / Navy) sits in the cockpit, and their hands follow the steering wheel through the `driver_steer` animation. The helmet is hidden in the cockpit camera, and the cockpit, Broadcast T-Cam and nose cameras use the onboard camera anchors.
- Engine, turbo and transmission sounds are crossfaded by rpm, throttle, boost and speed (`src/lib/sim/vf26-audio.ts`), switching between interior and exterior banks with the camera.
- The GT3 (`public/gt3/`) has its own cockpit, with a working steering wheel, shift lights and TC / ABS lights, plus its own multi-layer sound bank covering engine, transmission, gear shifts, overrun and downshift backfires, the limiter, tyre skid and the traction-control cut.


### 4. Serverless WebRTC Peer-to-Peer Multiplayer
- **6-Character Room Code Mode**: Host or join a room across the internet using `RTCPeerConnection` + unordered/unreliable `RTCDataChannel` (`ordered: false, maxRetransmits: 0`) over Google Public STUN (`stun:stun.l.google.com:19302`) and the public PeerJS signaling broker.
- **Zero-Broker Manual SDP Copy-Paste Fallback**: Establish direct browser-to-browser WebRTC P2P connections without any signaling server by exchanging compact SDP Offer/Answer tokens.
- **Same-Machine Multi-Tab Sync**: Automatic zero-configuration multiplayer across local browser tabs via `BroadcastChannel`, alongside autonomous AI grid cars interpolated at display frame rate via **Cubic Hermite splines** and **Quaternion Slerp**.

### 5. Multi-Sample F1 V6 Hybrid Audio & Broadcast Telemetry HUD
- **Web Audio Synthesis**: Crossfades recorded F1 engine loops across RPM bands with turbocharger lag, MGU-K inverter whine, straight-cut gearbox harmonics, ignition-cut upshift crackles, and per-wheel tire squeal/kerb rumble.
- **Race HUD**: a broadcast-style HUD with a timing tower, start lights, a lap timer with a live delta and sector colours, rev lights, gear and speed, ERS and active aero, and tyres showing tread temperature across each one plus pressures. The pause menu holds the session settings (AI opponents, assists), car setup, the corner list and multiplayer.
- **AI opponents**: an optional 5-car AI field, switched on from the pause menu. It starts behind the lights and handles traffic and side-by-side racing.

---

## Controls

| Input | Action |
| :--- | :--- |
| **`W` / `Up Arrow`** | Throttle (ramped like a pedal) |
| **`S` / `Down Arrow`** | Brake (ramped like a pedal) |
| **`A` / `D`** or **`Left` / `Right`** | Steering (speed-sensitive on keyboard) |
| **Gamepad** (Xbox / PlayStation) | Left stick steer (Gamepad Steering Assist), `RT` / `R2` throttle, `LT` / `L2` brake, `A` / `✕` boost |
| **`V`** | Toggle 1:1 Analog Mouse Steering |
| **`Space` / `Shift` / `B` / `/boost`** | Activate `350 kW` MGU-K Manual Override Boost |
| **`X`** | Toggle 2026 Active Aero (`Z-Mode` / `X-Mode`) |
| **`E` / `Q`** | Manual Upshift / Downshift |
| **`C`** | Cycle Camera Views (`Cockpit`, `Broadcast T-Cam`, `Chase`, `Trackside TV`) |
| **`R`** | Toggle 3D Dynamic Racing & Braking Line |
| **`P`** | Toggle Racing-Line AI Autopilot |
| **`M`** | Mute / Unmute F1 Engine Audio |
| **`Backspace`** | Reset to `270 km/h` Flying Lap Start |

---

## Tech Stack

- **Framework**: Next.js 15 (Static Export `output: "export"`) & React 19
- **3D Rendering**: Three.js (`WebGLRenderer`, ACES Filmic Tone Mapping, PBR Clearcoat & Instanced Meshes)
- **Networking**: WebRTC (`RTCPeerConnection`, `RTCDataChannel`), Google Public STUN, `BroadcastChannel`
- **Styling**: Tailwind CSS v4 & Lucide Icons
- **Verification**: TypeScript & `tsx` automated physics/geometry verification suite

---

## Local Development & Verification

```bash
# Install dependencies
npm install

# Type-check the whole project (tsc --noEmit)
npm run typecheck

# Run every scripts/verify-*.ts suite except verify-driver-laps, stopping at the first failure
# (physics, f12026-car, GT3, input, lap tools, race session, realism, telemetry out, WebHID FFB).
# CI runs typecheck + verify before every GitHub Pages deploy.
npm run verify

# Run a single suite directly
npx tsx scripts/verify-gt3.ts

# Slow: player-style laps for both cars in every assist preset at full pace (no spins, stays on the asphalt);
# pass a pace list to test more, e.g. npm run verify:laps -- 0.9,0.95,1
npm run verify:laps

# Start the local development server
npm run dev

# Build static production export into ./out
npm run build
```

---

## Deployment (GitHub Pages)

This repository includes an automated GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) configured for **GitHub Pages**. Every push to `main` runs `npm run build` and deploys the static `./out` bundle directly to GitHub Pages with zero backend hosting costs.

---

## License & Credits

- **Source Code (`src/`)**: Licensed under the [MIT License](LICENSE).
- **F1 2026 Car Model**: `"AM26 - F1 25/F1 2026 DLC"` ([https://skfb.ly/pKNCK](https://skfb.ly/pKNCK)) by **DeX** is licensed under [Creative Commons Attribution (CC BY 4.0)](http://creativecommons.org/licenses/by/4.0/).
- **GT3 Car Model**: `"2020 Mercedes-Benz AMG GT3"` ([https://skfb.ly/pOTPL](https://skfb.ly/pOTPL)) by **Ddiaz Design** is licensed under [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/).
- **3D & Audio Assets (`public/`)**: Provided for non-commercial personal and educational use only.
- **Optional circuits**: Red Bull Ring, Suzuka, Shanghai, Madring, Nürburgring and Indianapolis circuit models by **Dave**, and the Motegi model by **Kevin Love SketchFab**, all on Sketchfab under [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) (links in [CREDITS.md](CREDITS.md)).
- **Full Credits**: See [CREDITS.md](CREDITS.md).

