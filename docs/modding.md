# Making mods

A mod package adds circuits, cars and liveries to LibreCorsa without changing the game. Players import a package's `.zip` (or its folder) in the game's **Mods** panel. It then stays in their browser and works offline. The offline launcher also reads packages from its `mods/` folder.

A package holds **data only, never code**. The game's page holds each player's driver key and saves, so nothing in a package is ever run: no scripts, no shaders, no HTML.

Laps driven with mod content are the player's own and never go on the online boards or the weekly challenge. A mod circuit keeps its personal bests and ghosts. A mod car's laps last the session only, because the car shares its vehicle model's id. Online rooms work: a host on a mod circuit names the package and its content hash, and a guest can ready up only with the same version installed. Other drivers see a car only by its vehicle model. So in a scheduled race a mod car is swapped for the model's own car, and in any room so is a mod car with physics of its own.

If a package keeps the game from starting, open it with `?mods=off` at the end of the address (`/play?mods=off`). The packages are then listed in the Mods panel but add nothing, so you can switch the broken one off or remove it.

## The package

A package is a folder with `mod.json` at its top:

```
jdoe.monza-66/
  mod.json
  README.md                  optional, for players
  monza/track_data.json      a circuit's data (scripts/tracks write it)
  monza/monza.glb            its model
  monza/scenery/trees.glb    scenery the data names
  skins/blue/…               a livery for one of the game's cars
  cars/gt-x/gt-x.glb         a car's body
  cars/gt-x/thumb.webp       its picture in the car browser (optional)
  cars/gt-x/audio/…          its sound bank (optional)
  cars/gt-x/skins/red/…      its liveries
```

A package may carry `.glb .gltf .bin .json .webp .png .jpg .ktx2 .ogg .wav .mp3 .txt .md` files. Paths are relative and use forward slashes, with no `..`. At most 2 GB uncompressed.

## mod.json

```json
{
  "format": 1,
  "id": "jdoe.monza-66",
  "name": "Monza 1966",
  "version": "1.0.0",
  "description": "The 1966 road course with the banking.",
  "credit": {
    "author": "J. Doe",
    "url": "https://example.org/monza-66",
    "license": "CC BY-NC-SA 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by-nc-sa/4.0/"
  },
  "tracks": [
    {
      "id": "full",
      "name": "Autodromo di Monza",
      "layout": "1966 with banking",
      "country": "Italy",
      "city": "Monza",
      "lengthM": 10000,
      "turns": 9,
      "direction": "clockwise",
      "data": "monza/track_data.json"
    }
  ],
  "skins": [
    { "car": "amg-gt3", "id": "blue", "name": "#7 Blue", "swatch": ["#1040c0", "#ffffff"] }
  ],
  "cars": [
    {
      "id": "gt-x",
      "title": "GT X",
      "sub": "2024 · 4.0 L V8 · rear-wheel drive",
      "badge": "GT X",
      "classId": "gt3",
      "year": 2024,
      "physics": "amg-gt3",
      "model": "cars/gt-x/gt-x.glb",
      "sound": { "dir": "cars/gt-x/audio", "limiterRpm": 7500 },
      "skins": [
        { "id": "factory", "name": "Factory", "swatch": ["#111111", "#d0d0d0"] },
        { "id": "red", "name": "Red", "swatch": ["#c00000", "#111111"] }
      ]
    }
  ]
}
```

- **`id`**: `author.name`, in lowercase letters, digits, `-` and `_`. The author part is at most 16 characters and the name at most 24. It is also the folder's name in `mods/`. Never change it between versions: the game treats a new id as a new package.
- **`version`**: any string. Players see it, and an online room shows it when a guest's copy differs.
- **Ids inside the package** (circuits, cars, liveries): at most 16 characters. The game names them `mod:<package>/<id>`, so they can never collide with the game's own or with another package's.
- **`credit`**: shown in the game's credits and on each circuit and car. Links must be `https://`. A circuit or car may have its own `credit` when it is someone else's work.

### Circuits

`data` is a `track_data.json` as the game's converters write it (see [Porting circuits](PORTING-TRACKS.md)). Its `metadata.mesh.url` and `metadata.mesh.scenery` name the model and scenery by their paths in the package (`"monza/monza.glb"`), not `/tracks/…` URLs. Everything else in the file is read exactly as for the game's own circuits: surfaces, kerbs, DRS zones, the racing line, the AI plans and the pit lane.

`type` (`permanent`, `street`, `oval`, `hillclimb`) and `defaultTimeOfDay` (`dawn`, `morning`, `noon`, `afternoon`, `golden_hour`, `dusk`, `night`) are optional.

### Liveries for the game's cars

`car` is one of the game's car ids: `amg-gt3`, `bmw-m4-gt3`, `mtr-496r`, `lc-lmdh`, `liana`, `nissan-r33-jgtc`, `nissan-r32-jtcc`, `bmw-m1-procar`, `vw-scirocco-gtx`, `chaparral-2d`, `chaparral-2d-67`, `porsche-934-rsr`. A livery's files sit in `skins/<id>/`, or the folder its `dir` names. Their file names are the car model's own texture names, as in the game's livery folders (`public/cars/<car>/skins/<skin>/`). `files` lists them when a livery changes only some, and `variant` picks a body variant when the car has them. A `thumb.webp` in the folder is its picture in the picker.

### Cars

A car is a new body and sound on one of the game's vehicle models (`physics`): `lc26`, `f12026-car`, `amg-gt3`, `liana`, `mtr-496r`, `lc-lmdh`, `nissan-r33-jgtc`, `nissan-r32-jtcc`, `bmw-m1-procar`, `vw-scirocco-gtx`, `chaparral-2d`, `chaparral-2d-67`, `porsche-934-rsr`. It takes that model's handling, setups, tyres and AI.

- **`model`**: a GLB laid out as the game's rig expects. `scripts/cars/port_ac_car.py` writes one ([Porting cars](PORTING-CARS.md)).
- **`bodyPlan`**: optional. The body's outline at barrier height, so barriers meet this car's shape rather than the model's own. `scripts/measure-car-plans.ts` prints one.
- **`sound`**: a sound bank folder in the package with the bank's own limiter rpm (`{ "dir": …, "limiterRpm": … }`), or one of the game's cars (`{ "car": "amg-gt3" }`).
- **`skins`**: the first is the paint the model was made in. The others are file liveries as above, in `<model folder>/skins/<id>/` by default.
- **`classId`**: `f1`, `gt3`, `proto`, `classic` or `road`. Along with `year`, it decides where the car sits in the menus.

### A car with its own physics

Instead of driving exactly like a vehicle model, a car can change one: `"physics": { "base": "amg-gt3", "file": "cars/gt-x/physics.json" }`. The file lists only what differs from the base model's profile:

```json
{
  "format": 1,
  "profile": {
    "config": {
      "chassis": { "totalMassKg": 1180, "frontWeightFraction": 0.46 },
      "gearbox": { "gears": { "redline_rpm": 8200 } }
    },
    "turbo": true
  }
}
```

The game's car simulation runs the result in the browser and in its simulation worker, just as it runs the game's own cars. Its profile has the same shape as the profiles in `src/lib/sim/*/` (`*_SIM_PROFILE`, with `config` from `*Config.ts`). The patch can only change values the base has, and each must stay the same kind: a number for a number, a list for a list, objects merged key by key. A misspelt key or a value of the wrong kind stops the car loading, and the Mods panel names its path. The car's garage ranges, AI and HUD are the base model's.

`npm run physics:report` and the `scripts/verify-*.ts` checks show how the game's own cars were measured, which is a good start for checking yours. Its laps are kept for the session only, so they never stand in the base model's bests or ghosts.

Any base works except `lc26`, which runs a simulation of its own.

## Checking and packing

```
npm run mod -- check path/to/jdoe.monza-66
npm run mod -- pack  path/to/jdoe.monza-66 [out.zip]
```

`check` reads the package as the game's importer does. It catches every problem in `mod.json`, every file it names but the package lacks, and paths or file types the game refuses. It also prints the package's content hash, which online rooms compare. `pack` does the same, then writes a zip the importer reads (deflate, no zip64). Any zip tool works as well, as long as `mod.json` is at the top of the archive or in its one folder.

## Trying it in a clone

`npm run dev` doesn't run the game's service worker, so a package imported in the panel there can't load its files. Put the package folder in `public/mods/` instead (it is gitignored), then run:

```
npm run mod -- index
```

This writes `public/mods/_index.json`, which lists the packages for the game. Run it again after changing a package, since the content hash changes too. A production build (`npm run build`, served from `out/`) and the live site both run the service worker, so importing in the Mods panel works there.

## What a package can't do (yet)

- Physics outside what the game's car simulation models. A physics file changes a base model's values, not the simulation itself.
- Garage ranges, AI or a HUD of its own. A car with its own physics takes these from its base model.
- Replace any of the game's own circuits, cars or liveries. Packages only add to them.
- Run code of any kind.
