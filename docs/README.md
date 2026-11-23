# LibreCorsa docs

LibreCorsa is a free, open-source racing sim that runs in the browser at [librecorsa.org](https://librecorsa.org/). These pages are for people who play it, want to add to it or want to check how it works. I write them alongside the code, so they change when the code does.

You can read them at [docs.librecorsa.org](https://docs.librecorsa.org/) or here in the repository's `docs/` folder. They're the same files.

## Start here

- [FAQ](FAQ.md): short answers on what LibreCorsa is, playing it, the cars and circuits, and the licence.

## Playing

- [Controls, controllers and wheels](CONTROLS.md): keyboard, gamepad, touch and wheel setup, and force feedback.
- [Racing online and the lap boards](ONLINE.md): rooms, scheduled races, the boards and the weekly challenge.
- [Performance and troubleshooting](PERFORMANCE.md): graphics settings, phones, and what to try when something goes wrong.
- [Checking a download](DOWNLOADS.md): where the desktop and Android apps come from, their app IDs and how to check that a file is mine.

## Porting

- [Porting cars](PORTING-CARS.md): a car mod from another game, or a Sketchfab-style model, into the game.
- [Porting circuits](PORTING-TRACKS.md): converting a circuit mod, or building one in Blender.
- [Porting a circuit from an F1 25 mod](PORTING-F1-MODS.md): extracting a track mod's `.erp` archive, for your own use.
- [Porting wheels](PORTING-WHEELS.md): getting a wheel's force feedback working over WebHID.

## Contributing

- [Get involved](GET-INVOLVED.md): reporting bugs, bringing a circuit or car, translating, code and docs.
- [Translating](TRANSLATING.md): adding a language, translating it with an AI model, and adding text to the game.

## How it works

- [How the code fits together](ARCHITECTURE.md): a map of the repository, the threads, and the rules that keep players' data working.
- [Physics validation](physics/README.md): the tyre model and the cars measured against real telemetry and reference data.
- [Race AI, contact and damage](race-ai.md): how the AI drivers race, and what happens when cars touch.

## Elsewhere

- Source code, issues and releases: [github.com/librecorsa/librecorsa](https://github.com/librecorsa/librecorsa)
- Contributing: [CONTRIBUTING.md](../CONTRIBUTING.md)
- Reporting a security problem: [SECURITY.md](../SECURITY.md)
