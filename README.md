<div align="center">

<img src="docs/media/banner.png" alt="LibreCorsa: open-source 500 Hz motorsport sim" width="100%" />

<p>
  <a href="https://librecorsa.org/"><b>▶&nbsp; Play in your browser</b></a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#controls">Controls</a>
  &nbsp;·&nbsp;
  <a href="#development">Development</a>
  &nbsp;·&nbsp;
  <a href="CREDITS.md">Credits</a>
</p>

<p>
  <a href="https://github.com/KhazP/librecorsa/actions/workflows/deploy-pages.yml"><img alt="Build and deploy" src="https://github.com/KhazP/librecorsa/actions/workflows/deploy-pages.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/code-MIT-CCFF00?labelColor=08090D" /></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-F5F7FA?labelColor=08090D&logo=nextdotjs&logoColor=white" />
  <img alt="Three.js" src="https://img.shields.io/badge/Three.js-WebGL2-00E5FF?labelColor=08090D&logo=threedotjs&logoColor=white" />
  <img alt="Physics at 500 Hz" src="https://img.shields.io/badge/physics-500%20Hz-FF2A3C?labelColor=08090D" />
  <a href="https://buymeacoffee.com/alpyalayg"><img alt="Buy me a coffee" src="https://img.shields.io/badge/buy%20me%20a%20coffee-alpyalayg-FFDD00?labelColor=08090D&logo=buymeacoffee&logoColor=white" /></a>
</p>

</div>

**LibreCorsa** is an open-source racing simulator that runs entirely in the browser. It has 500 Hz vehicle dynamics, a thermal tyre model, 2026-regulation open-wheelers and a GT3 car. There are four circuits, AI races, ghosts and replays, and peer-to-peer multiplayer. It works with a keyboard, gamepad, touch screen or a force-feedback wheel. Nothing to install, and no server: it ships as a static site.

<p align="center">
  <img src="docs/media/race-grid-shanghai.jpg" alt="Lined up on the grid at Shanghai against five AI cars" width="100%" />
</p>

<table>
  <tr>
    <td width="33%"><img src="docs/media/title-menu.jpg" alt="Title menu" /></td>
    <td width="33%"><img src="docs/media/on-track.jpg" alt="On track at the Rwanda circuit" /></td>
    <td width="33%"><img src="docs/media/loading-suzuka.jpg" alt="Loading Suzuka" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Title menu and garage</sub></td>
    <td align="center"><sub>Rwanda International Circuit</sub></td>
    <td align="center"><sub>Every circuit draws itself while it loads</sub></td>
  </tr>
</table>

> LibreCorsa is an independent fan project. It is not affiliated with Formula 1, the FIA, any team or any circuit.

---

## Features

### Physics
- **500 Hz fixed-step integration** (4 × 2 kHz sub-steps), with each wheel riding the real track surface. The default open-wheeler's chassis is planar (speed, side-slip and yaw on the local road plane) plus sprung heave, pitch and roll; the f12026-car and the GT3 run on a 6-DOF rigid body.
- **Tyres**: a Pacejka-style slip curve with combined slip, load sensitivity, carcass relaxation and a load-dependent rolling radius. A 9-node thermal model (inner/middle/outer × surface/bulk/carcass) sets the grip window, ideal-gas pressure sets carcass stiffness, and the tyres wear. Soft, medium and hard slicks, plus intermediates and full wets that clear water up to a depth and aquaplane past it.
- **Chassis**: double-wishbone kinematics with roll centres from the hardpoints, springs, dampers, bump stops, anti-roll bars and heave elements. There's a preload / power / coast limited-slip differential and thermal brakes whose pad friction changes with temperature.
- **Aero**: ride-height-sensitive wings and floor, altitude-corrected air density, and dirty air behind other cars. 2026 active aero switches between Z-mode (cornering) and X-mode (straights).
- **Surfaces**: one data table for road, kerb, sausage kerb, run-off, pit lane, grass and gravel, with dry and wet friction, rolling resistance, a bump ripple you feel through the wheel, vibration and whether it counts for track limits. A circuit can override it in its track data. Kerbs rise to a 32 mm crown with a 4 mm ripple.
- **Weather and time of day**: clear, overcast, light rain, heavy rain, drying and dynamic weather. The water film builds and drains, and the cars dry the racing line first. Six times of day, and the clock can run at up to 60×.
- **Evolving track**: the racing line rubbers in as you drive.
- **Assists**: traction control on the friction circle, ABS, and a slip-angle-limited steering assist for keyboards and gamepads (S-curve key ramp, self-aligning, slide catch) with pedal slip help for the keys. Each can be tuned, and all but the keyboard's steering assist switched off.
- **Realism levels**: Casual (no tyre wear or fuel use, milder rain), Standard and Full.

### Cars
| Car | Model | Notes |
| :-- | :-- | :-- |
| **2026 open-wheeler** (default) | Planar chassis + heave / pitch / roll, 4 sprung corners | 1.6 L V6 turbo + 350 kW MGU-K, 4 MJ battery, manual override boost, Z/X-mode aero |
| **f12026-car** | 6-DOF rigid body on the track colliders | Load-sensitive normalized-slip tyres, driver-operated DRS with detection points, live telemetry channels |
| **Mercedes-AMG GT3** | 6-DOF rigid body | 6.2 L NA V8, 6-speed sequential, multi-stage ABS / TC, its own braking-point model |

Each car has its own cockpit, steering wheel and shift lights, plus a multi-layer sound bank (engine, turbo, transmission, shifts, backfires, limiter, tyre skid, TC cut). Interior and exterior sounds switch with the camera.

### Circuits
| Circuit | Country | Length |
| :-- | :-- | --: |
| **Rwanda International Circuit** (fictional, default) | Rwanda | 5.30 km |
| Suzuka Circuit | Japan | 5.83 km |
| Shanghai International Circuit | China | 5.44 km |
| Mobility Resort Motegi | Japan | 4.78 km |
| Chang International Circuit | Thailand | 4.57 km |
| Okayama International Circuit (GP / Piper / Formula Drift) | Japan | 3.70 / 1.97 / 1.97 km |
| Red Bull Ring — Spielberg (GP / South / Inner skill course) | Austria | 4.32 / 2.34 / 0.94 km |
| Circuit de Monaco | Monaco | 3.30 km |

The Rwanda circuit was built in Blender for this project: 14 corners, 52 m of elevation, 1,400 m above sea level. The Sketchfab circuits are CC BY 4.0 scans converted by `scripts/tracks/build_track.py`, and Chang, Okayama, Spielberg (Red Bull Ring), and Monaco are Assetto Corsa circuits by **Mitja Bonca** (used with permission), converted by `scripts/tracks/port_ac_track.py` with their 3D/2D trees, dynamic tyre grooves, skidmarks, starting lights and trackside semaphores, AI fast/pit lanes, kerbs, surface tables, section names, DRS zones, and TV cameras. Every circuit is meshopt-compressed (`npm run compress-tracks`) while keeping hidden physics meshes bit-exact, and has a lap-time-optimal racing line for each car class. Open the sim with `?colliders=1` to see the physics surfaces drawn over the circuit.

### Racing
- **Race the AI**: a 5-car field with a standing start behind the lights, traffic and side-by-side racing, and a results screen. The AI level runs from Rookie to Alien and can be changed from the pause menu. Each car class has a tuning file in [`public/ai`](public/ai), with per-circuit and per-section overrides. The AI learns braking points and apex speeds corner by corner. In the rain it fits intermediates or full wets and plans its corner speeds and braking on the wet grip.
- **Split gaps**: the gap to the car ahead and behind at every sector split.
- **Practice tools**: lap and sector timing, a live delta, a ghost of your best lap (saved in your browser, and it can be exported and imported), a 90-second instant replay with free cameras, and a lap summary.
- **Multiplayer**: peer-to-peer over WebRTC. Use a 6-character room code, or a manual offer/answer copy-paste with no signalling server at all. Browser tabs on the same machine pair up automatically. Other players' cars are predicted to the present from their newest packet and the measured latency, so you touch a car where you see it; contact with them is soft and switches off while their packets are stale.
- **Online leaderboard**: laps and their ghosts go to a free Supabase project ([`scripts/leaderboard-supabase`](scripts/leaderboard-supabase)). Without one configured, the board lists your own best laps. A Cloudflare Worker version is in [`scripts/leaderboard-worker`](scripts/leaderboard-worker).
- **Cameras**: cockpit eye-point with live mirrors and the steering-wheel display, a broadcast T-cam, chase, and trackside TV cameras that pan, zoom and cut between corners.

### Hardware
- **Wheels**: steering, pedals and buttons through the browser for any wheel. Force feedback straight from the browser over WebHID for bases that use the standard HID PID protocol, or through a local bridge on Windows. See [Wheels and force feedback](#wheels-and-force-feedback) for what has been tested.
- **Gamepads**: Xbox and PlayStation, with rumble and trigger rumble.
- **Touch**: on-screen pedals and steering, or tilt to steer.
- **Telemetry out**: 60 Hz UDP JSON through the bridge, for dashboards and motion rigs.
- **Setup wizard**: picks your device and tunes steering, pedals and force feedback on first launch.

### Wheels and force feedback

Steering, pedals and buttons come through the browser's Gamepad API, so any wheel that Windows, macOS or Linux sees as a game controller can drive. Force feedback has two paths:

- **In the browser (WebHID, Chrome or Edge)**: click **Connect wheel** in the wheel setup. It drives bases that expose the standard USB HID PID force-feedback reports, with nothing to install. Experimental.
- **Local bridge (Windows)**: a small helper that talks DirectInput to any force-feedback wheel. It needs a copy of this repository and Node.js: run `npm install` once, then `npm run ffb` and keep it open. The game finds it on `127.0.0.1:18500`. For the hosted site, allow its origin when you start the bridge (origin only, no path):
  - PowerShell: `$env:FFB_ALLOW_ORIGIN="https://librecorsa.org"; npm run ffb`
  - cmd: `set "FFB_ALLOW_ORIGIN=https://librecorsa.org" && npm run ffb`

Only what the maintainer has driven is marked tested. Everything else is what the code should do, not a promise:

| Wheel | Browser (WebHID) | Bridge (Windows) | Status |
| :-- | :-- | :-- | :-- |
| MOZA R9 V2 + KS | Connects and steers | Expected | **Tested: connects. Force feedback not yet confirmed** |
| Other MOZA bases, Simucube 2, VRS, OpenFFBoard, other HID PID bases | Expected | Expected | Untested |
| Simagic, Cammus, Asetek, Fanatec DD (PC mode), Thrustmaster DD | Unknown: without HID PID force feedback the page switches to the bridge | Expected | Untested |
| Logitech G29, G920, G923, G PRO | No: proprietary force feedback | Expected | Untested |
| Thrustmaster T150, T248, T300, TMX; Fanatec CSL Elite | Unknown, likely not | Expected | Untested |

Drove one of these, or a wheel that isn't listed? A [wheel report](https://github.com/KhazP/librecorsa/issues/new?template=wheel-report.yml) moves it into the table.

---

## Physics validation

The physics is checked against data, not just tuned by feel, and the evidence is generated from the simulator's own code so anyone can reproduce it ([full page](docs/physics/README.md), `npm run physics:report`).

- **The GT3 against a real car.** The Mercedes-AMG GT3 runs the same manoeuvres as reference GT3 Evo MoTeC logs: sustained cornering, braking and full-throttle g by speed, gearing and the understeer gradient. Every point sits within −10 % to +16 % of the logs, and `npm run verify` fails the build if one leaves its tolerance.
- **Tyre curves for every car**: force against slip angle at four loads, grip against load, temperature and pressure.
- **Honest gaps**: the VF26 reaches 6–18 % less cornering g than the cornering-limit table in its reference data, and the page says so.
- **Frame-rate independence**: physics runs in fixed 2 ms steps (500 Hz, four 2 kHz substeps), so the same three-second launch ends within 0.3 km/h and 0.2 m at 30, 60, 144 or 240 fps.

<p align="center">
  <img src="docs/physics/gt3-lateral-g.svg" alt="GT3 sustained lateral g against speed: simulator line against MoTeC reference points, inside the shaded CI tolerance" width="49%" />
  <img src="docs/physics/tyre-fy-vs-slip-gt3.svg" alt="GT3 tyre lateral force against slip angle at 2, 4, 6 and 8 kN, each peaking near 6 degrees" width="49%" />
</p>

---

## Controls

| Input | Action |
| :-- | :-- |
| `W` / `↑` · `S` / `↓` | Throttle · brake (ramped like a pedal) |
| `A` / `D` or `←` / `→` | Steer (speed-sensitive on keyboard) |
| `E` / `Q` | Upshift / downshift |
| `Space` / `Shift` / `B` | Manual override boost (MGU-K) |
| `X` | Active aero (Z-mode / X-mode) or DRS |
| `C` | Cycle cameras |
| `R` | Racing and braking line |
| `P` | Racing-line autopilot |
| `V` | 1:1 mouse steering |
| `M` | Mute |
| `Backspace` | Restart from a flying lap |
| `Esc` | Pause menu |
| **Gamepad** | Left stick steer · `RT` / `R2` throttle · `LT` / `L2` brake · `A` / `✕` boost |

Every binding can be changed under **Controls**.

---

## Development

```bash
npm install
npm run dev              # dev server at http://localhost:3000
npm run build            # static export into ./out
```

| Script | What it does |
| :-- | :-- |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm run verify` | Every `scripts/verify-*.ts` suite (physics, f12026-car, GT3, input, lap tools, race session, realism, weather, AI tuning, telemetry out, WebHID FFB) |
| `npm run verify:laps` | Slow: player-style laps for every car and assist preset at full pace |
| `npm run physics:report` | Regenerate the [physics validation page](docs/physics/README.md): tyre curves, the GT3 against MoTeC logs, frame-rate checks |
| `npm run race:headless` | A full-physics AI race without rendering, faster than real time, with a results table. `-- --track suzuka --car amg-gt3 --weather heavy_rain --sweep skill` |
| `npm run compress-tracks` | Meshopt-compress the circuit GLBs and check the physics meshes are unchanged |
| `npm run ffb` | Local force-feedback and telemetry bridge (Windows) |

The tech is **Next.js 16** (static export), **React 19**, **Three.js** (WebGL2, AgX tone mapping, PBR), the **Web Audio API**, **WebRTC**, **WebHID** and **Tailwind CSS 4**.

### Deployment
Every push to `main` runs typecheck and the verify suites, then builds `./out` and deploys it to Cloudflare at [librecorsa.org](https://librecorsa.org/) (`.github/workflows/deploy-pages.yml`, `wrangler.jsonc`). The old GitHub Pages address, `khazp.github.io/librecorsa/`, serves a redirect page that keeps old links working and carries a returning player's saved settings, setups and ghost laps over (`cloudflare/old-site-redirect.html`, `cloudflare/worker.js`). Cloudflare's asset store takes files up to 25 MiB, so CI moves anything bigger into the `librecorsa-assets` R2 bucket and the Worker serves it from there at the same URL. Hosting costs nothing.

---

## License & credits

- **Code** is under the [MIT License](LICENSE).
- **3D models and audio** in `public/` are for non-commercial, personal and educational use. Each one keeps its own license.
- **Cars**: the 2026 car model is by **DeX** ([CC BY 4.0](https://skfb.ly/pKNCK)), and the Mercedes-AMG GT3 by **Ddiaz Design** ([CC BY-NC-SA 4.0](https://skfb.ly/pOTPL)).
- **Circuits**: the Sketchfab scans are by **Dave** and **Dave Love SketchFab**, plus Motegi by **Kevin Love SketchFab** (all CC BY 4.0); Chang International Circuit, Okayama International Circuit, Spielberg (Red Bull Ring), and Circuit de Monaco are by **Mitja Bonca** (used with permission).
- **Rwanda trackside trees**: the acacia by **evolveduk** and the shrub by **Natural_Disbuster (lemedesign)**, both CC BY 4.0.
- **Rwanda stands**: the grandstands, open stands and media centre are the project's own, generated by `scripts/rwanda-stands.mjs`.
- **Rwanda props**: the jumbotrons, start lights, masts, tents and camera platforms are the project's own (`scripts/rwanda-props.mjs`); the helicopter is "Cedric-EC135" by **PatrickBiani**, CC BY 4.0.
- **Rights holders**: if you made a model, texture, sound or other asset used here and want it credited, corrected or removed, open a [**rights / takedown request**](https://github.com/KhazP/librecorsa/issues/new?template=takedown-request.yml) — it will be fixed or removed from the live site, usually within 7 days.

> [!CAUTION]
> **No Official Cryptocurrency:** LibreCorsa has no official token or cryptocurrency, and is not related to any third-party actors trying to profit off of this repo. Any coin on crypto sites using the LibreCorsa name, logo, or repository link is unauthorized and unaffiliated with the developer.

Full attribution and links are in [CREDITS.md](CREDITS.md).
