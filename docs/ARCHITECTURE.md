# How the code fits together

A map of the repository for anyone who wants to change the code: where each part lives and how the parts talk to each other. It names the files to start from. Their own header comments go deeper, and they win where this page and the code disagree. For setting up and running the checks, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## In short

- **The game is a static site.** Next.js 16 exports it to `out/` (`output: "export"` in `next.config.ts`). There's no server-side rendering at run time.
- **`/play` is the game.** `TrackGate` loads the circuit, `LibreCorsaSimulator` is the React shell (menus, settings, HUD), and `DriveSession` owns the renderer, the scene, the player's car and the frame loop.
- **The physics runs in a Web Worker by default**, at 500 Hz in fixed 2 ms steps. The page draws with Three.js and sends the inputs.
- **The online side is optional.** A Cloudflare Worker (`cloudflare/`) serves rooms, races, lap boards, accounts and the usage counter. Without it the game still has peer-to-peer rooms and local lap times.
- **Most cars and circuits aren't in git.** A clone has RISE Motordrome and the 2026 car. Everything else is served from R2 on librecorsa.org.

## Where things are

| Folder | What's in it |
| :-- | :-- |
| `src/app/` | The pages (`/`, `/play`, `/press`, `/download`, `/privacy`, `/about`, `/account`, `/admin`) and static route handlers (`/build.json`, `/feed.xml`, `/.well-known/security.txt`, the manifest, robots and sitemap) |
| `src/components/` | React: the game shell, `menu/`, `hud/`, `settings/`, `home/`, `account/` and the UI kit in `ui/` |
| `src/lib/sim/` | Physics, cars, race control, AI, laps, replays, weather and multiplayer |
| `src/lib/sim/runtime/` | The sim worker and how the page talks to it |
| `src/lib/render/` | Lighting, sky, cameras, car models, graphics quality |
| `src/lib/input/` | Bindings, pads, wheels, WebHID force feedback, telemetry out |
| `src/lib/net/` | Wire formats, race schedule, results and online config |
| `src/lib/audio/`, `src/lib/sim/CarAudio.ts` | Music and car sound |
| `src/i18n/` | Languages: messages, translator notes and glossaries |
| `public/tracks/`, `public/cars/`, `public/ai/` | Circuit data, car files and AI tuning |
| `cloudflare/` | The Worker: `worker.js` serves the site, `api/` the online side; `migrations/` for D1 |
| `scripts/` | The `verify-*.ts` suites, circuit and car converters, reports, the force-feedback bridge |
| `docs/`, `docs-site/` | These pages, and the Astro site that publishes them |
| `desktop/`, `android/` | The Electron app and the Android app, both opening librecorsa.org/play |

## From /play to the first frame

1. **`src/app/play/page.tsx`** renders `TrackGate`. Nothing of the simulator loads before that.
2. **`src/components/TrackGate.tsx`** activates the circuit (`activateTrack` fetches its `track_data.json`) and mounts the simulator, again for each new circuit. It also registers the service worker and watches for a newer build (`/build.json`).
3. **`src/components/LibreCorsaSimulator.tsx`** is the React shell: title menu, settings, HUD, boards and multiplayer. It creates one `DriveSession` per mounted circuit.
4. **`src/lib/drive-session.ts`** runs everything per frame: input, the car, cameras, replay, race control, the weather's look, audio cues and the HUD. It goes loading → title → wizard → driving, and the physics only runs while driving. The loop is `renderer.setAnimationLoop`, so a VR headset drives it in VR.

The active circuit is a module-level global (`src/lib/track-data.ts`). That's why `TrackGate` remounts the simulator when the circuit changes, instead of swapping it under a running session.

## Threads and the frame loop

- **Which path runs** is decided in `src/lib/sim/runtime/sim-mode.ts`. The worker drives the player's car in practice and runs AI races on keyboard, controller or touch. Online races and a wheel's car run on the page, and so does everything when the worker can't start. `?sim=main` or `?sim=worker` forces one.
- **The worker** (`runtime/sim-worker.ts`) wakes every 4 ms (`SIM_TICK_S`), catches up by the clock and stops when the page has gone quiet for 250 ms. `runtime/sim-runtime.ts` is the thread-free core it runs, which `scripts/verify-sim-runtime.ts` drives directly.
- **Messages** are plain data, listed in `runtime/sim-protocol.ts`. The page sends inputs, settings and race commands. The worker sends the car's state (with the steering-torque samples for force feedback) and the AI field's poses (`field-frame.ts`).
- **The page keeps a twin of the car** (`runtime/sim-host.ts`, `remote-car.ts`). Settings changed on it are mirrored to the worker's car, and the page can take the car back at any time.
- **Smoothing**: the page carries the last state forward by velocity and yaw rate to the moment it draws (`car-state.ts`), up to 50 ms.
- **The physics step** is 2 ms with four sub-steps (2 kHz), as `FIXED_DT` and `SUBSTEPS` in `f12026-car/VehiclePhysics.ts` set it. One 4 ms worker tick is two physics steps. AI cars in a race can use a lighter path with two sub-steps.
- **The frame-rate cap only skips drawing** (`render/frame-pacer.ts`): input, physics, the network and lap timing keep running.
- **Other workers**: car LOD simplification (`render/car-lod-worker.ts`), the meshopt decoder, the KTX2 transcoder and the service worker (`public/sw.js`).

## Physics

- **`src/lib/sim/simulator-car.ts`** is the interface every car implements.
- **`src/lib/sim/f12026-car/VehiclePhysics.ts`** is the rigid-body car every model uses: a 6-DOF body on the circuit's collider meshes, with five ground samples per wheel, double-wishbone suspension, a thermal tyre model, aero maps and the drivetrain.
- **`f12026-car/F12026CarSim.ts`** connects it to the game: track colliders, assists, DRS and the era's overtaking rules.
- **Each car is a config** on that model: `f12026-car/` (the 2026 Prototype), `gt3/`, `proto/` (LMDh, MTR 496R), `classic/` and `road/`. Each `*Sim.ts` pairs a config with its sound.
- **The car list** is `src/lib/cars/car-registry.ts`: a car is a body and a sound on one of the vehicle models in `vehicle-models.ts`. Setups, telemetry and boards are keyed by the model.
- **Shared parts** sit beside them: suspension kinematics, aero wake, brakes, gearbox, the 2026 energy rules (`f12026-car/ers-2026.ts`), wet tyres and the realism levels (`sim-realism.ts`; the checks test "full").
- **The ground**: `f12026-car/TrackColliderQuery.ts` answers ray queries against the circuit's collider meshes, and `sim/track-surfaces.ts` is the table of road, kerb, grass and gravel properties.
- **Weather and the track**: `sim/weather.ts` (deterministic from the conditions and a seed, water as a film depth), `sim/track-environment.ts` and `sim/track-evolution.ts` (rubber, marbles, track temperature, car-to-car contact).

[Physics validation](physics/README.md) shows how the model is checked against real data.

## Circuits and their data

- **`public/tracks/index.json`** lists every circuit: id, layout, length, credit, kind and where its data is.
- **`public/tracks/<id>/track_data.json`** holds the circuit's metadata, DRS zones, cameras, turns, sectors, grid, pit lane, limits and a sample every few metres along the lap, with the racing lines. RISE Motordrome's short layout is the reference schema, read by `src/lib/track-data.ts`.
- **`src/lib/track-registry.ts`** lists the circuits and loads one. `src/lib/hosted-content.ts` decides which a build shows: everything with `NEXT_PUBLIC_HOSTED_CONTENT=1`, only what's in the repository without it.
- **Converters** in `scripts/tracks/`: `port_ac_track.py` for Assetto Corsa mods and `build_blender_track.py` for a circuit modelled in Blender. Both write the GLB and `track_data.json` and optimise the racing lines. `scripts/rwanda-official/` builds RISE Motordrome itself. See [Porting circuits](PORTING-TRACKS.md).

## Rendering

- **`src/lib/scene-builder.ts`** builds the circuit's scene: a quick stand-in at once, then the circuit's own model when it arrives.
- **Car models**: `src/lib/car-builder-2026.ts`, `ported-car-model.ts` and the livery painters in `render/`. GLBs are meshopt-compressed, and phones get KTX2 textures (`render/ktx2.ts`).
- **Light and sky**: `render/golden-hour-environment.ts` (renderer, post effects, graphics quality), `render/physical-sky.ts` (atmosphere and clouds on Medium and High), night lighting, rain and headlights.
- **Graphics quality** is Low, Medium or High. `render/adaptive-quality.ts` steps down for the session when frames run long and never changes the saved settings. `render/gpu-health.ts` handles a lost GPU context.
- **Cameras**: `render/camera-rig.ts` and its neighbours.
- **The HUD** is React on top of the canvas: `src/components/F1TelemetryHud.tsx` reads a live telemetry store without re-rendering the shell. The widgets are in `src/components/hud/`, the layouts in `hud/styles/`, and `src/lib/settings/hud-layouts.ts` is the list of layouts.

## Audio

- **`src/lib/sim/CarAudio.ts`**: one `AudioContext`, with the engine voice from a sample bank, recorded samples or a synth, through a compressor to the master gain.
- **`sim/lc26-audio.ts`** plays the multi-layer banks (`manifest.json` plus ogg files in each car's `audio/` folder). `opponent-audio.ts` places the other cars in 3D, and `contact-acoustics.ts` adds road, kerb and stone noise.
- **Music**: `src/lib/audio/` picks and plays the tracks on two decks that keep playing across circuit changes.

## Input, wheels and telemetry

- **`src/lib/input/bindings.ts`** holds the rebindable controls. `device-input.ts` reads the Gamepad API, and keyboard, touch and gyro steering each have a file.
- **Force feedback**: `wheel-ffb.ts` either talks to the local bridge (`npm run ffb`, `scripts/ffb-bridge.ts`) or plays the 500 Hz torque samples over WebHID. `webhid-ffb.ts` speaks HID PID and the classic Logitech commands, with separate files for Logitech HID++ and Thrustmaster. See [Porting wheels](PORTING-WHEELS.md).
- **Controllers**: rumble in `sim/gamepad-haptics.ts`, and DualSense triggers, haptics and lights over WebHID.
- **Telemetry out** (`input/telemetry-out.ts`): about 60 packets a second through the bridge, as UDP JSON with stable field names.

## Race AI

- **`sim/ai-opponents.ts`** runs the field: the start, traffic, contact and standings. `sim/ai-race.ts` is the same interface whether the field runs on the page or in the worker.
- **Driving**: `ai-mpc.ts` follows the racing line, `ai-racecraft.ts` makes the judgements about the cars around (overlap, who owns a corner), and `ai-learning.ts` lets each car adjust itself corner by corner during a session.
- **Planning**: `speed-profile.ts` and `sim/ai/` (the grip limits, the speed plan and a local planner).
- **Tuning** is data: `public/ai/<class>.json`, with per-circuit and per-section overrides.
- **`npm run race:headless`** (`scripts/race-headless.ts`) runs a full-physics race without drawing.

[Race AI](race-ai.md) explains how the layers work together.

## Races, laps and replays

- **Setting up and starting**: `race-setup.ts`, `race-rules.ts`, `race-start.ts` (including jump starts) and `qualifying.ts`.
- **Race control**: track limits, penalties (`penalty-ledger.ts`), blue and yellow flags, the Virtual Safety Car and incidents.
- **Laps**: `lap-recorder.ts` records and validates laps and plays ghosts. `ghost-store.ts` keeps them in IndexedDB. `lap-plausibility.ts` is shared with the Worker's lap check.
- **Replays**: `replay-buffer.ts`, a ring of typed-array chunks.
- **Results** go to the HUD (`RaceResults`, `PodiumOverlay`), to `race-history.ts` locally, and to one official result per race from the race server or room host (`net/official-result.ts`).

## Multiplayer

- **`src/lib/sim/multiplayer-sync.ts`** connects players three ways: a room code over WebRTC (paired by the site's room server, or the public PeerJS broker without it), a manual offer/answer copy-paste, or `BroadcastChannel` between tabs on one machine.
- **Car states** go out 60 times a second as a binary packet (`src/lib/net/state-codec.ts`). Byte 0 is `PROTOCOL_VERSION`, and hosts and the race server refuse any other.
- **Messages** (lobby, start, results) and their sanitisers are in `net/wire.ts`, which the Worker imports too.
- **Open races** follow a schedule worked out from the clock alone (`net/race-schedule.ts`) on the week's circuit and car (`net/weekly-challenge.ts`).

## The online side

- **`cloudflare/worker.js`** serves the static export first. The Worker runs for `/api/*` and for big files, which it serves from the `librecorsa-assets` R2 bucket. `wrangler.jsonc` is at the repository root.
- **`cloudflare/api/index.ts`** is the route table. Each feature has a switch in `wrangler.jsonc` (rooms, boards, races, usage, live count, accounts), which the game reads at `/api/config`.
- **Durable Objects**: `RoomServer` (`room.ts`), `RaceServer` (`race.ts`) and `PresenceCounter` (`presence.ts`).
- **D1**: the lap boards and results (`cloudflare/migrations/`) and accounts (`cloudflare/migrations-accounts/`).
- **Accounts**: the server is `cloudflare/api/accounts/`, the shared types `src/lib/account/api-types.ts`, the client `src/lib/account/` and the screens `src/components/account/`.
- **The usage counter** is `api/usage.ts`, with the client in `src/lib/net/usage.ts`. The [privacy page](https://librecorsa.org/privacy) says what it keeps.

[cloudflare/README.md](../cloudflare/README.md) covers setting up your own copy and running it locally.

## Menus, settings and languages

- **Menus** are in `src/components/menu/`: the title menu, first-run wizard, circuit and car browsers, Engineer's Garage, race setup and loading screen. `useMenuNav` and `useFocusNav` make them work with a controller.
- **Settings**: `src/components/settings/SettingsScreen.tsx` and its panes. `src/lib/settings/player-settings.ts` validates the saved settings field by field. `src/components/settings/storage.ts` lists every storage key, and `src/lib/account/save-model.ts` says which of them follow an account.
- **The UI kit** is `src/components/ui/`, with the rules in `docs/DESIGN.md`. `scripts/check-ui.mjs` checks them.
- **Languages**: `src/i18n/runtime.ts` starts in English and switches after the page loads. The messages are `src/i18n/messages/<language>/<area>.json`. Code outside React reads text through `src/lib/text.ts`, which stays free of React because the workers import it. See [Translating](TRANSLATING.md).
- **The service worker** (`public/sw.js`) keeps downloaded circuits, cars and sounds across deploys and checks each against the server by ETag.

## Tools and checks

- **`npm run verify`** (`scripts/run-verify.mjs`) runs every `scripts/verify-*.ts` suite, several at once, longest first. Suites skip what needs the hosted cars and circuits. `npm run verify:laps` is the slow full-pace lap check.
- **`npm run physics:report`** regenerates the physics validation page. `npm run race:headless` runs AI races.
- **Assets**: `npm run compress-tracks` compresses circuits and checks the physics meshes stay bit-exact. `npm run upload-hosted` sends hosted files to R2.
- **CI**: `checks.yml` runs the typecheck, the suites and the build on every pull request. `deploy-pages.yml` runs them again on `main`, then builds with the hosted content and deploys. `deploy-docs.yml` publishes these pages, and `release-desktop.yml` builds the apps from a `desktop-v*` tag.

## Rules that keep players' data and races working

1. **Some names never change.** The `bugesera.*` storage keys and the `bugesera-laps` database hold players' settings and ghosts. The same goes for HUD layout ids, the first car id of each vehicle model, and entries in `circuit-board-resets.ts`. A lap-board table change is a new file in `cloudflare/migrations/`, never an edit to one already applied.
2. **A new storage key goes in two lists**: `STORAGE_KEYS` in `src/components/settings/storage.ts` and `KEY_CLASSES` in `src/lib/account/save-model.ts`.
3. **`PHYSICS_VERSION`** (`src/lib/sim/lap-types.ts`) goes up when a physics change makes old lap times unfair to compare, with a line in `PHYSICS_VERSIONS`. New laps then go to new boards and the old ones stay readable. A change to one circuit goes in `circuit-board-resets.ts` instead.
4. **`PROTOCOL_VERSION`** (`src/lib/net/state-codec.ts`) goes up with any change to what goes over the wire.
5. **Some modules must stay free of the page and of Three.js**, because the Cloudflare Worker or the sim worker imports them. Among them are `net/wire.ts`, `net/state-codec.ts`, `penalty-ledger.ts`, `official-result.ts`, `race-schedule.ts`, `weekly-challenge.ts`, `vehicle-class.ts`, `track-kinds.ts`, `text.ts` and `runtime/sim-runtime.ts`.
6. **There are two simulation paths.** A new member of `SimulatorCar` has to be classified in `MEMBERS` in `runtime/remote-car.ts`, or it won't compile. A setting or call the worker must mirror goes in `CAR_SETTABLE` or `CAR_CALLABLE` in `runtime/sim-protocol.ts`.
7. **Hosted files go up before the code that names them.** A deploy that points at a file R2 doesn't have yet breaks that circuit or car for players.
8. **The privacy page changes in the same commit** as anything that changes what the game stores or sends.
9. **Physics changes keep `npm run verify` passing.** If a change is meant to move a number, update the check and say why in the pull request.
