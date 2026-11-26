# Importing mods from other games

LibreCorsa can turn a circuit or a car from another game into a [mod package](modding.md): Speed Dreams and Assetto Corsa content, and circuits you model yourself in Blender. An import converts the source, builds what the game needs (racing lines, AI plans, surfaces, the car's rig), checks the result as the game will load it, and writes a package you drive at once.

There are two ways to run one:

- **In the offline launcher**, with no tools to install: drop the folder in, press Convert. See [Converting in the launcher](#converting-in-the-launcher).
- **From the command line**, in a clone of the repository: `npm run mod -- import <importer> <folder>`. See [From the command line](#from-the-command-line).

What you may do with the result depends on the source's licence. Read [Licences at a glance](#licences-at-a-glance) before you share anything.

## Converting in the launcher

The offline launcher converts a circuit or a car from another game into a mod package by itself: no clone, no Python or Node to install.

1. Copy the circuit's or the car's folder into `import/`, beside the launcher (it has a README on what goes there):
   - Assetto Corsa: `content/tracks/<name>` or `content/cars/<name>`
   - Speed Dreams: `data/tracks/<category>/<name>` or `data/cars/models/<name>`
   - your own Blender circuit: a folder with the `.glb` export and its settings `.json`

   Unzip archives first: a folder is converted, not a zip.
2. Open the game's **Mods** panel, in the window the launcher opened (another window, or another browser, can't convert). Under **Convert from another game** each folder is listed with what it was recognised as. Press **Convert**.
3. The first time, the panel asks to download the converter's tools: uv and Node.js (pinned versions, each checked against a SHA-256 built into the launcher, and checked again before every run), then Python 3.14 and its packages through uv. That is about 200 MB, once, into the launcher's own folder beside its browser profile. Nothing is downloaded until you agree.
4. The conversion shows its progress and, under **Show the log**, the converter's output. A car takes about a minute. A circuit takes longer, typically 10 to 20 minutes: the AI's racing lines are worked out on full physics laps.
5. The package goes into the launcher's `mods/` folder and is checked as the game will load it. Press **Restart now** and it is in the game.

A converted package keeps its source's credit and licence, which the panel shows when it is done. Nothing in the import folder is ever run; the converter only reads a copy of it, which the launcher makes first and removes afterwards. A folder holding a link to somewhere else is refused: copy the files themselves. How the launcher keeps this safe is in [launcher/README.md](../launcher/README.md).

## From the command line

In a clone of the repository, with Node.js and [uv](https://docs.astral.sh/uv/) installed (car imports need ffmpeg on your PATH to convert a car's own sound, and borrow a game car's without it; Speed Dreams imports that download anything need git):

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
| `blender-track` | a circuit you modelled in Blender (its `.glb` and settings JSON) |

Every importer also takes:

- `--package <author.name>`, `--name` and `--version`: the package's id, name and version (each has a default made from the source).
- `--out <folder>`: where the package goes. The default is `public/mods/`, which the dev server and the launcher serve: run `npm run dev` and the package is in the game.
- `--keep-build`: keep the converter's working files, for debugging: a circuit's build in `public/tracks/`, a car's working folder.

### Racing lines

A circuit's import works out the AI's racing lines for the F1 cars and the GT3s by driving candidate lines on full physics laps. By default it runs the optimiser lightly: one sweep, without the optimal-control start the game's own circuits get. On E-track-4 that was about a third of the time of the full run, with the AI about two seconds a lap slower.

- `--best-lines`: the full optimiser, as the game's own circuits get. Expect half an hour or more for a long circuit.
- `--no-line-opt`: no optimiser. The import takes about a minute, and the AI drives the minimum-curvature line, clearly slower.

The launcher's **Convert** always uses the light run.

The import never touches the game's own circuits or cars. To share a package, `npm run mod -- pack public/mods/<package>` writes its zip; [a catalogue](modding.md#sharing-packages-through-a-catalogue) can offer it in the Mods panel.

How the importers are built, and how to add one, is in [scripts/mods/README.md](../scripts/mods/README.md).

## From Speed Dreams

[Speed Dreams](https://www.speed-dreams.net/) is a free racing sim with over 70 circuits and over 90 cars, most of them under the Free Art License. That licence lets you share a converted copy if you credit its authors and keep the licence, so Speed Dreams content can become packages you pass on.

### Circuits

```bash
npm run mod -- import sd-track --fetch brno                                 # one of Speed Dreams' own circuits, by its folder name
npm run mod -- import sd-track ~/speed-dreams/data/tracks/circuit/brno      # a circuit folder you already have
```

`--fetch` downloads the circuit the way Speed Dreams' own downloader does, checks it against a pinned hash (`scripts/mods/importers/sd-track.circuits.json`), and keeps it in `scripts/mods/.cache/speed-dreams/`. Speed Dreams' shared surfaces and textures come from its `speed-dreams-data` repository at the commit `scripts/cars/speed-dreams-cars.json` pins: each is fetched once, checked against that commit, and reused.

**What you get:** a package `sd.<circuit>` in `public/mods/`. The road, kerbs, run-off, grass, gravel, pit lane and barriers are rebuilt from the circuit's layout, so the cars drive the same road Speed Dreams does. The buildings, trees and terrain come from the circuit's 3D model. The package includes the circuit's readme and licence files, and the full text of each licence it is shared under.

Options: `--id`, `--country` and `--city` (Speed Dreams files don't say where a circuit is), `--sd-data <folder>` to use your own Speed Dreams data, and the usual package options.

**Limits:** closed circuits only. Grip uses LibreCorsa's surface types, not Speed Dreams' own values. The pit lane path is approximate. Baked shadows on buildings are dropped. Check the circuit's textures for real sponsor logos before you publish it.

### Cars

```bash
npm run mod -- import sd-car --fetch ls2-cavallo-360r                       # one of the cars Speed Dreams lists
npm run mod -- import sd-car ~/speed-dreams/data/cars/models/<car>          # a car folder you already have
```

A fetched car comes from Speed Dreams' own repositories at forge.a-lec.org, at the revision `scripts/cars/speed-dreams-cars.json` pins, and is kept in `scripts/mods/.cache/speed-dreams/`. Its category and the files it shares with other cars (wheels, engine samples) come from `speed-dreams-data` at the commit the same file pins, as the circuits' surfaces do. Nothing downloaded is unpacked or used before it matches its pin, and a car or circuit holding a link, or a file name that reaches outside its folder, is refused.

The package (`sd.<car>`) holds:

- the car's model, with its driver, steering wheel and wheels, its liveries and its picture;
- a sound bank made from its engine sample, pitched as Speed Dreams plays it at every rpm;
- its physics as a patch on the closest of the game's cars (a GT on the AMG GT3, a modern open-wheeler on the 2026 car, a road car on the Scirocco or the Liana). Its weights, engine, gearbox, brakes, tyres, suspension and aero are converted; `CONVERSION.md` in the package lists every value and what was left out;
- the car's and its liveries' readmes and licence files, and the full text of each licence it is shared under.

Before packaging, the importer drives the car in the game's simulation: flat out on a straight, full braking, and a lap of RISE Motordrome. It refuses a car that spins, can't reach a sensible top speed or can't stop.

Options: `--base <model>` picks the car it drives as, `--class` and `--year` place it in the menus, `--id` names it in the package, and `--category <file>` gives its category file when it isn't beside the car (`cars/categories/`).

### Licences

The importer reads every readme, licence, credits and authors file in the circuit's or car's folder, and the notice at the top of its XML (and a car's category's), and converts it only when, together, they let you share a changed copy (see [What counts as shareable](#what-counts-as-shareable)). Anything else is refused with the reason. The official list's licence counts only for a circuit or car fetched with `--fetch` at the revision the importer pins, when its folder has no readme or licence file of its own; a folder you already have takes nothing from the list.

A livery with a readme of its own (`<car>-<livery>-readme.txt`, `<Car>_<Livery>_readme.txt`) must be shareable too, or it is left out. So must a wheel or engine sample the car takes from Speed Dreams' shared data: Speed Dreams' data is under the Free Art License unless its credits say otherwise (`data/sound/SoundCredits.txt`), and a shared sample that can't be shared is replaced by one of the game's sounds.

`--personal` converts a circuit or car anyway, for you alone: its licence is then "unknown" and its credit says **"For personal use only: the author's permission is needed to share it"**, so don't pass it on. Anything the package holds that isn't shareable (a livery, a sample) does the same.

## From Assetto Corsa

Most Assetto Corsa mods don't allow redistribution, and a converted circuit or car is a copy of the mod. The importers always make the package for you to drive, and tell you when you may not share it (see [Licences](#licences-1) below).

### Circuits

```bash
npm run mod -- import ac-track <track folder> [--layout <name>] [--settings <overrides.json>]
```

The track folder is the circuit's folder in Assetto Corsa's `content/tracks`: the one with the `.kn5` models, `ui/`, and `data/` or the layout folders. An import takes 10 to 20 minutes, most of it the racing-line optimiser (see [Racing lines](#racing-lines)).

There is nothing to set up. The importer reads the circuit's settings from the mod and prints each one with where it came from:

- **Layouts**: each folder with an AI lane (`ai/fast_lane.ai`). If the mod has several, the import lists them; pick one with `--layout`, by its folder or its name in Assetto Corsa. A layout without an AI lane can't be imported.
- **Models**: the ones `models_<layout>.ini` places where they were modelled. Models it moves (a helicopter in the sky), Assetto Corsa's moving objects and animated extension objects are left out, and the import says so.
- **Name, country, city, pitboxes, length, author, version and link**: from `ui_track.json`. A circuit tagged street, hill climb or oval gets that type.
- **Surfaces**: the mod's own surface names in `data/surfaces.ini`, read from their grip, whether they count as track, their sound and the pit-lane flag.
- **Author and licence**: from `ui_track.json`, else the readme.

Some values are guessed, and marked GUESSED: the altitude (0 m; it sets the air density), a layout name when the mod has one layout, a country or city the mod doesn't give ("Unknown"), and a description when the mod's is only its name. To change any value, write it in a JSON file and pass it with `--settings`. It takes the keys of the game's own circuit entries in `scripts/tracks/port_ac_track.py`:

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
- **Physics**: the car's own data as a physics patch on one of the game's vehicle models (see [Custom physics patches](modding.md#custom-physics-patches)). The model is chosen by the car's drivetrain, class, tags, year, mass and power: four-wheel-drive cars on `nissan-r32-jtcc` and front-wheel-drive cars on `liana` or `vw-scirocco-gtx`, whatever else they are; a street car whose tags name no race class (a McLaren F1, a 911 GT3 RS) is a road car; then open-wheelers on `f12026-car`, prototypes on `lc-lmdh` or `mtr-496r`, modern GTs on `amg-gt3`, 1990s GTs on `nissan-r33-jgtc`, classic racers on `porsche-934-rsr` or `bmw-m1-procar`, road cars on `liana` or `vw-scirocco-gtx`. `--base` picks another. The import lists every value the game can't take. It then drives the car headless (flat out, braking, a lap of RISE on the autopilot) and stops if the car doesn't drive sanely. Try another `--base` then, or `--no-physics`, which drives exactly as the base model.
- **Name and id**: from `ui/ui_car.json` (name, brand, year, power). The package id is made from its author and the car's name. `--package`, `--name` and `--id` change them.

### Licences

- Kunos's own cars and circuits (the game's and its packs', the `ks_` folders, encrypted or not) are refused, and so is a mod made from them, however its folder is named: a model, a sound bank, its sounds' events or a `parent` named for a Kunos car, a `ks_` model in a circuit, or Kunos named as the author. So is any encrypted model.
- The importer reads every text file in the mod's folder (and a circuit's layout folder, a car's skin folders) and a car's `ui_car.json` licence. If together they let a changed copy be shared (see [What counts as shareable](#what-counts-as-shareable)), the package carries that licence and its full text. A line that forbids sharing, anywhere, outranks any licence.
- Otherwise its licence is "unknown", and its credit says **"For personal use only: the author's permission is needed to share it"**. The import prints this, with the words in the mod that decided it. Keep the package on your own machine: don't upload, host or share it.
- If the author gives you permission to share a circuit, add it to your settings and import again: `{"credit": {"license": "Used with permission"}}`, or the licence they gave, such as `"CC BY 4.0"`. Keep a record of the permission. A licence in your settings that doesn't allow sharing ("All rights reserved", a no-derivatives licence) keeps the circuit for personal use, and so does a note in your settings: the personal-use note always stays.
- The mod's own readme and licence files go in the package either way.
- LibreCorsa hosts some Assetto Corsa circuits with their authors' permission. That permission is the game's and doesn't cover your copy; the import tells you when you import one of them.

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
| Your own Blender circuit  | Converts with the licence your settings give                                                                  | Your call                                               |

### What counts as shareable

Every importer reads licences the same way. A converted copy may be shared only under a licence that allows changing the work and passing it on for any use, and whose full text the package can carry:

- the **Free Art License 1.3** (also when a readme names it without a version, as Speed Dreams' do, or as an older 1.x "or later");
- **CC BY** and **CC BY-SA**, versions 3.0 and 4.0, and **CC0 1.0**;
- the **GNU GPL**, version 2.0 or 3.0, "only" or "or later".

A version is never guessed: "CC-BY" or "the GNU General Public License" alone isn't enough, nor is a version whose text isn't carried ("CC BY 2.0", "Free Art License 1.1" without "or later"). "GPL" alone isn't a licence in a readme (it is as often Grand Prix Legends). MIT, the LGPL and other licences aren't carried, so content under them stays for personal use, as does "public domain" without CC0 1.0.

Every licence and every restriction in every file is read, and one problem anywhere keeps the content from being shared: non-commercial or no-derivatives terms (NC, ND, in any spelling), a licence the text says doesn't apply ("not under the GPL"), one marked with "?" or "*", "Creative Commons" without saying which, and wording such as "all rights reserved", "personal use", "do not upload", "without my permission", "logos are property of their owners", "ripped from" another game or "restricted".

Content that may be shared is credited with its licences and carries their texts (`LICENSE-<id>.txt`) and the source's own readme and licence files. Content that may not has the licence "unknown", the note "For personal use only: the author's permission is needed to share it", and no licence text or link.

Whatever the importer says, you are responsible for what you share. A package never carries code, so it can't harm a player's machine, but it can carry someone else's work.
