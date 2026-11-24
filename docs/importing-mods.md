# Importing mods from other games

LibreCorsa can turn a circuit or a car from another game into a [mod package](modding.md): Speed Dreams, Assetto Corsa and F1 25 content, and circuits you model yourself in Blender. An import converts the source, builds what the game needs (racing lines, AI plans, surfaces, the car's rig), checks the result as the game will load it, and writes a package you drive at once.

There are two ways to run one:

- **In the offline launcher**, with no tools to install: drop the folder in, press Convert. See [Converting in the launcher](#converting-in-the-launcher).
- **From the command line**, in a clone of the repository: `npm run mod -- import <importer> <folder>`. See [From the command line](#from-the-command-line).

What you may do with the result depends on the source's licence. Read [Licences at a glance](#licences-at-a-glance) before you share anything.

## Converting in the launcher

The offline launcher converts a circuit or a car from another game into a mod package by itself: no clone, no Python or Node to install.

1. Copy the circuit's or the car's folder into `import/`, beside the launcher (it has a README on what goes there):
   - Assetto Corsa: `content/tracks/<name>` or `content/cars/<name>`
   - Speed Dreams: `data/tracks/<category>/<name>` or `data/cars/models/<name>`
   - F1 25: a folder holding the circuit's `.erp`
   - your own Blender circuit: a folder with the `.glb` export and its settings `.json`

   Unzip archives first: a folder is converted, not a zip.
2. Open the game's **Mods** panel, in the window the launcher opened (another window, or another browser, can't convert). Under **Convert from another game** each folder is listed with what it was recognised as. Press **Convert**.
3. The first time, the panel asks to download the converter's tools: uv and Node.js (pinned versions, each checked against a SHA-256 built into the launcher, and checked again before every run), then Python 3.14 and its packages through uv. That is about 200 MB, once, into the launcher's own folder beside its browser profile. Nothing is downloaded until you agree.
4. The conversion shows its progress and, under **Show the log**, the converter's output. A circuit takes a few minutes: its racing lines are worked out lap by lap.
5. The package goes into the launcher's `mods/` folder and is checked as the game will load it. Press **Restart now** and it is in the game.

A converted package keeps its source's credit and licence, which the panel shows when it is done. Nothing in the import folder is ever run; the converter only reads a copy of it, which the launcher makes first and removes afterwards. A folder holding a link to somewhere else is refused: copy the files themselves. How the launcher keeps this safe is in [launcher/README.md](../launcher/README.md).

## From the command line

In a clone of the repository, with Node.js and [uv](https://docs.astral.sh/uv/) installed (car imports also need ffmpeg for sound, and Speed Dreams cars need git):

```bash
npm run mod -- import                     # list the importers
npm run mod -- import <name> --help       # one importer's options
npm run mod -- import <name> <folder>     # convert and package
```

| Importer        | Converts                                                         |
| --------------- | ---------------------------------------------------------------- |
| `sd-track`      | a Speed Dreams circuit (its folder, or `--fetch <circuit>`)      |
| `sd-car`        | a Speed Dreams car (its folder, or `--fetch <car>`)              |
| `ac-track`      | an Assetto Corsa circuit mod (its track folder)                  |
| `ac-car`        | an Assetto Corsa car mod (its `content/cars/<car>` folder)        |
| `f1-track`      | an F1 25 circuit mod (its `.erp`), for personal use only          |
| `blender-track` | a circuit you modelled in Blender (its `.glb` and settings JSON) |

Every importer also takes:

- `--package <author.name>`, `--name` and `--version`: the package's id, name and version (each has a default made from the source).
- `--out <folder>`: where the package goes. The default is `public/mods/`, which the dev server and the launcher serve: run `npm run dev` and the package is in the game.
- `--keep-build`: keep the converter's working copy in `public/tracks/`, for debugging.

The import never touches the game's own circuits or cars. To share a package, `npm run mod -- pack public/mods/<package>` writes its zip; [a catalogue](modding.md#sharing-packages-through-a-catalogue) can offer it in the Mods panel.

How the importers are built, and how to add one, is in [scripts/mods/README.md](../scripts/mods/README.md).

## From Speed Dreams

[Speed Dreams](https://www.speed-dreams.net/) is a free racing sim with over 70 circuits and over 90 cars, most of them under the Free Art License. That licence lets you share a converted copy if you credit its authors and keep the licence, so Speed Dreams content can become packages you pass on.

### Circuits

```bash
npm run mod -- import sd-track --fetch brno                                 # one of Speed Dreams' own circuits, by its folder name
npm run mod -- import sd-track ~/speed-dreams/data/tracks/circuit/brno      # a circuit folder you already have
```

`--fetch` downloads the circuit the way Speed Dreams' own downloader does, checks it against a pinned hash (`scripts/mods/importers/sd-track.circuits.json`), and keeps it in `scripts/mods/.cache/speed-dreams/`. Speed Dreams' shared surfaces and textures are fetched once and reused.

**What you get:** a package `sd.<circuit>` in `public/mods/`. The road, kerbs, run-off, grass, gravel, pit lane and barriers are rebuilt from the circuit's layout, so the cars drive the same road Speed Dreams does. The buildings, trees and terrain come from the circuit's 3D model. The package includes the circuit's readme and the full licence text.

Options: `--id`, `--country` and `--city` (Speed Dreams files don't say where a circuit is), `--sd-data <folder>` to use your own Speed Dreams data, and the usual package options.

**Limits:** closed circuits only. Grip uses LibreCorsa's surface types, not Speed Dreams' own values. The pit lane path is approximate. Baked shadows on buildings are dropped. Check the circuit's textures for real sponsor logos before you publish it.

### Cars

```bash
npm run mod -- import sd-car --fetch ls2-cavallo-360r                       # one of the cars Speed Dreams lists
npm run mod -- import sd-car ~/speed-dreams/data/cars/models/<car>          # a car folder you already have
```

A fetched car comes from Speed Dreams' own repositories at forge.a-lec.org, at the revision `scripts/cars/speed-dreams-cars.json` pins, and is kept in `scripts/mods/.cache/speed-dreams/`.

The package (`sd.<car>`) holds:

- the car's model, with its driver, steering wheel and wheels, its liveries and its picture;
- a sound bank made from its engine sample, pitched as Speed Dreams plays it at every rpm;
- its physics as a patch on the closest of the game's cars (a GT on the AMG GT3, a modern open-wheeler on the 2026 car, a road car on the Scirocco or the Liana). Its weights, engine, gearbox, brakes, tyres, suspension and aero are converted; `CONVERSION.md` in the package lists every value and what was left out;
- the licence texts and the car's own readme.

Before packaging, the importer drives the car in the game's simulation: flat out on a straight, full braking, and a lap of RISE Motordrome. It refuses a car that spins, can't reach a sensible top speed or can't stop.

Options: `--base <model>` picks the car it drives as, `--class` and `--year` place it in the menus, `--id` names it in the package, and `--category <file>` gives its category file when it isn't beside the car (`cars/categories/`).

### Licences

The importer reads each circuit's or car's own readme or licence file, or the official list's entry when it has none, and converts it only when its licence lets you share a changed copy: the Free Art License (most of Speed Dreams), CC BY, CC BY-SA, CC0 or the GPL. Anything else is refused with the reason: no licence, an unclear one, "all rights reserved", non-commercial or no-derivatives licences. `--personal` converts it anyway, for you alone: the package then says "For personal use only, not for sharing", so don't pass it on. A livery whose own readme is unclear is left out.

## From Assetto Corsa

Most Assetto Corsa mods don't allow redistribution, and a converted circuit or car is a copy of the mod. The importers always make the package for you to drive, and tell you when you may not share it (see [Licences](#licences-1) below).

### Circuits

```bash
npm run mod -- import ac-track <track folder> [--layout <name>] [--settings <overrides.json>]
```

The track folder is the circuit's folder in Assetto Corsa's `content/tracks`: the one with the `.kn5` models, `ui/`, and `data/` or the layout folders. An import takes a few minutes, most of it the racing-line optimiser (`--no-line-opt` skips it).

There is nothing to set up. The importer reads the circuit's settings from the mod and prints each one with where it came from:

- **Layouts**: each folder with an AI lane (`ai/fast_lane.ai`). If the mod has several, the import lists them; pick one with `--layout`, by its folder or its name in Assetto Corsa. A layout without an AI lane can't be imported.
- **Models**: the ones `models_<layout>.ini` places where they were modelled. Models it moves (a helicopter in the sky), Assetto Corsa's moving objects and Custom Shaders Patch's animated ones are left out, and the import says so.
- **Name, country, city, pitboxes, length, author, version and link**: from `ui_track.json`. A circuit tagged street, hill climb or oval gets that type.
- **Surfaces**: the mod's own surface names in `data/surfaces.ini`, read from their grip, whether they count as track, their sound and the pit-lane flag.
- **Author and licence**: from `ui_track.json`, else the readme.

Some values are guessed, and marked GUESSED: the altitude (0 m; it sets the air density), a layout name when the mod has one layout, and a description when the mod's is only its name. To change any value, write it in a JSON file and pass it with `--settings`. It takes the keys of the game's own circuit entries in `scripts/tracks/port_ac_track.py`:

```json
{ "name": "Motorsport Arena Oschersleben", "layout": "Grand Prix layout", "baseAltitudeM": 88,
  "credit": { "author": "Mitja Bonca" } }
```

The package id is made from the author and the circuit's name (`--package` sets your own), the circuit's id from its layout's folder (`--id`), and the version from the mod's.

### Cars

```bash
npm run mod -- import ac-car <car folder> [--base <model>] [--no-physics] [--skins all|<skin,skin,…>]
```

Name the car's folder (`content/cars/<car>`), with its `data/` folder or `data.acd`. Keep the folder's own name: a packed `data.acd` is read with a key made from it.

One command makes the whole package:

- **Body**: the car's model in the game's rig. If the repository has a preset for the car, it uses it. Otherwise it makes one: the tyres (by Assetto Corsa's tyre shader, a tyre name, or the outermost ring of each wheel), the paint (by its name and the skins that repaint it) and the windscreen (the glass the driver looks through). It prints what it chose. If a choice is wrong, a preset in `scripts/cars/port_ac_car.py` fixes it ([Porting cars](PORTING-CARS.md)).
- **Liveries**: every skin, or those `--skins` names (the first is the paint the model is made in). Each skin's `preview.jpg` is its picture. The first skin's preview, or else the car's badge, is the car's picture.
- **Sound**: the FMOD bank in `sfx/`, matched by its sample names. Without a bank or ffmpeg, the car uses its base model's sound.
- **Physics**: the car's own data as a physics patch on one of the game's vehicle models (see [Custom physics patches](modding.md#custom-physics-patches)). The model is chosen by the car's class, tags, year, drivetrain, mass and power: open-wheelers on `f12026-car`, prototypes on `lc-lmdh` or `mtr-496r`, modern GTs on `amg-gt3`, 1990s GTs on `nissan-r33-jgtc`, four-wheel-drive cars on `nissan-r32-jtcc`, front-wheel-drive cars on `liana` or `vw-scirocco-gtx`, classic racers on `porsche-934-rsr` or `bmw-m1-procar`, road cars on `liana` or `vw-scirocco-gtx`. `--base` picks another. The import lists every value the game can't take. It then drives the car headless (flat out, braking, a lap of RISE on the autopilot) and stops if the car doesn't drive sanely. Try another `--base` then, or `--no-physics`, which drives exactly as the base model.
- **Name and id**: from `ui/ui_car.json` (name, brand, year, power). The package id is made from its author and the car's name. `--package`, `--name` and `--id` change them.

### Licences

- Kunos's own cars (the game's and its packs', the `ks_` folders, encrypted or not) are refused. So is any encrypted model.
- If the mod names a licence that lets a changed copy be shared (Creative Commons without NoDerivatives, CC0, the GPL, MIT, the public domain), and nothing in its readme says otherwise, the package carries that licence. A line that forbids sharing outranks any licence.
- Otherwise its licence is "unknown", and its credit says **"For personal use only: the author's permission is needed to share it."** The import prints this, with any lines of the readme that set the mod's terms. Keep the package on your own machine: don't upload, host or share it.
- If the author gives you permission, add the licence to your settings and import again: `{"credit": {"license": "Used with permission"}}`. Keep a record of the permission.
- LibreCorsa hosts some Assetto Corsa circuits with their authors' permission. That permission is the game's and doesn't cover your copy; the import tells you when you import one of them.

## From F1 25

```bash
npm run mod -- import f1-track <mod.erp> [--track <code>] [--mat-prefix <prefix>] [--settings <overrides.json>]
```

This runs the extractor Qiddiya Speed Park was ported with ([Porting a circuit from an F1 25 mod](PORTING-F1-MODS.md)) and builds the circuit from what it extracts. Its tables (surfaces, lights, branding) and its settings are Qiddiya's, so another mod needs `--track`, `--mat-prefix` and a settings file with its name, place and credit, and may need the tables edited. `npm run mod -- import f1-track --help` lists the extractor's options.

A circuit from an F1 25 mod is **always for personal use only**, whatever the settings say: an `.erp` carries the base game's files beside the mod's, and a mod author's permission covers their own copy, not yours. The package's credit says so.

## Your own circuit from Blender

```bash
npm run mod -- import blender-track path/to/circuit.glb [--settings circuit.json]
```

Model the circuit as [Porting circuits](PORTING-TRACKS.md) describes (surface meshes named Road, Kerb, Runoff, Gravel, Grass, Wall or PitLane, a `Track_Centreline` and a `Track_Start`), export it as `.glb`, and write its settings (name, place, credit) in a JSON file beside it. The package carries the credit and licence your settings give.

## Licences at a glance

| Source                    | What the import does                                                                                          | Sharing the package                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Speed Dreams              | Converts only content under a licence that allows sharing a changed copy; `--personal` converts the rest       | Yes, with the credit and licence the package carries    |
| Assetto Corsa             | Always converts (Kunos content refused), marking anything without a sharing licence "for personal use only"   | Only when the package names a licence that allows it    |
| F1 25                     | Always converts, always "for personal use only"                                                               | No                                                      |
| Your own Blender circuit  | Converts with the licence your settings give                                                                  | Your call                                               |

Whatever the importer says, you are responsible for what you share. A package never carries code, so it can't harm a player's machine, but it can carry someone else's work.
