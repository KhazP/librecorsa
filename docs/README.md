# LibreCorsa Documentation

LibreCorsa is a free, open-source racing simulator that runs directly in your browser at [librecorsa.org](https://librecorsa.org/). These docs cover everything from setting up a wheel and racing online to building mods, porting hardware or content, and inspecting the physics engine.

Everything here is maintained alongside the source code and published at [docs.librecorsa.org](https://docs.librecorsa.org/) directly from the repository's `docs/` directory.

## Playing

- **[Controls, controllers, and wheels](CONTROLS.md)** — Keyboard bindings, gamepads, DualSense features, touch controls, wheel calibration, and force feedback.
- **[Driving, setups, weather, and 2026 rules](DRIVING.md)** — Realism levels, tyre thermodynamics and wet grip, track evolution, 2026 active aero and MGU-K rules, and Garage setup sheets.
- **[Racing online and lap boards](ONLINE.md)** — Private multiplayer rooms, scheduled open races, leaderboards, ghosts, setup sharing, and the weekly challenge.
- **[UDP telemetry and the local bridge](TELEMETRY.md)** — Streaming 60 Hz JSON telemetry to dashboards, SimHub, bass shakers, and motion rigs, plus bridge CLI flags.
- **[Performance and troubleshooting](PERFORMANCE.md)** — System requirements, graphics presets, automatic quality scaling, offline caching, URL parameters, and fixing common issues.
- **[Verifying downloads](DOWNLOADS.md)** — Official release sources, app IDs, SHA-256 checksums, and Android signing certificate verification.

## Modding

- **[Making mods](modding.md)** — Creating, validating, and packaging data-only mod packages for circuits, cars, liveries, and custom physics patches.
- **[Importing mods from other games](importing-mods.md)** — Converting Speed Dreams, Assetto Corsa and F1 25 circuits and cars (and your own Blender circuits) into packages, in the launcher or from the command line, and what their licences allow.

## Porting

- **[Porting cars](PORTING-CARS.md)** — Converting car mods or Sketchfab-style GLB models and FMOD audio banks for a local build.
- **[Porting circuits](PORTING-TRACKS.md)** — Converting Assetto Corsa track mods or modelling and exporting an original circuit in Blender.
- **[Porting a circuit from an F1 25 mod](PORTING-F1-MODS.md)** — Extracting `.erp` track archives for personal, local use.
- **[Porting wheels](PORTING-WHEELS.md)** — Debugging and adding WebHID force feedback support for steering wheel bases.

## Contributing

- **[Translating](TRANSLATING.md)** — Adding new languages, translating with an AI workflow, and writing localizable strings in code.
- **[Self-hosting and the online backend](SELF-HOSTING.md)** — Deploying LibreCorsa statically or with the optional Cloudflare Worker (D1, R2, Durable Objects, and TURN).

## How it works

- **[Physics validation](physics/README.md)** — Tyre curves, real-car MoTeC telemetry comparisons, reference benchmarks, and fixed-step integration checks.
- **[Race AI, contact, and damage](race-ai.md)** — How AI drivers plan lines and overtakes, react to collisions, take damage, and get stewarded by race control.

## Elsewhere

- **Source code, issues, and releases:** [github.com/librecorsa/librecorsa](https://github.com/librecorsa/librecorsa)
- **Contributing guide:** [CONTRIBUTING.md](../CONTRIBUTING.md)
- **Reporting a security issue:** [SECURITY.md](../SECURITY.md)
