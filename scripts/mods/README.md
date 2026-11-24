# scripts/mods

The tools for mod packages: checking, packing and listing them, and importing content from other games and tools
into them. Players and modders start at [docs/modding.md](../../docs/modding.md) (the package format) and
[docs/importing-mods.md](../../docs/importing-mods.md) (from another game to a package). This page is for changing
the tools.

```
mod-tool.ts          npm run mod -- …: check, pack, index, catalogue, import, from-circuit, from-car
lib/
  package-check.ts   a package folder checked as the game's importer checks it, and its content hash
  zip-writer.ts      the zip `pack` writes (what src/lib/mods/zip-reader.ts reads)
  mods-index.ts      a mods folder's _index.json, for the dev server
  catalogue.ts       a catalogue of packed packages (src/lib/mods/mod-catalogue.ts), from a folder of zips
  manifest-file.ts   mod.json read, started, added to and written; ids and credits made from a source's
  circuit-package.ts a circuit the converters built (public/tracks/<id>/) → a package
  car-package.ts     a converted car (its GLB, liveries, sound, physics patch, licence files) → a package
  package-paths.ts   the ids and paths the packagers write and copy, checked before anything is written or deleted
  aero-fit.ts        a converted car's aero scaled until, driven, it makes the source's downforce and drag
  car-sanity.ts      a converted car driven headless: flat out on a straight, braking, a lap on the autopilot
  importer.ts        what an importer is, and the options every importer takes
  licences.ts        the one licence reader: a source's statements read whole, what may be shared, what a package carries
  sd-fetch.ts        Speed Dreams' circuits, cars and shared data, fetched once into scripts/mods/.cache/speed-dreams/ and
                     checked against their pins (scripts/cars/speed-dreams-cars.json, importers/sd-track.circuits.json)
  toolchain.ts       running the repository's Python (uv) and TypeScript (tsx) converters
licences/            the full texts of the licences content may be shared under, which a package carries (`LICENSE-<id>.txt`)
importers/
  <name>.ts          one per source: `npm run mod -- import <name>`
  sd-track.circuits.json   Speed Dreams' circuits as its asset database lists them, each archive pinned by its sha256
```

The game's side of packages (the manifest's rules, the zip reader, the store, the loader) is in `src/lib/mods/`; the
tools import it rather than repeat it, so a package the tools pass is one the game takes.

## A catalogue

`npm run mod -- catalogue <folder> [--base-url <url>] [--out <file>]` reads every `.zip` in the folder with the game's
zip reader, unpacks each into a temporary folder and runs `checkPackage` on it (what `check` runs), then lists it
with its size, SHA-256 and content hash. Links are `<base-url><file name>`; without `--base-url` they are the file
names, so the catalogue must sit beside the zips. A picture with a zip's name (`<name>.webp`, `.png`, `.jpg`) is its
preview. The catalogue is read back with the game's own `parseCatalogue` before it is written, and nothing is written
when any zip fails. The format and where the game reads catalogues are in docs/modding.md.

## How an import runs

Every importer does the same three things:

1. **Convert** the source with the converter for its kind, into a working copy the game's builders understand. A
   circuit is built with the shared circuit builder (`scripts/tracks/build_blender_track.py`, or
   `port_ac_track.py` for an Assetto Corsa circuit) into `public/tracks/<working id>/`, run with `--no-register` so
   the game's own circuit list is never touched: the builder writes the circuit's listing beside its files
   (`circuit.json`). A car is ported into a GLB laid out as the game's rig expects (docs/PORTING-CARS.md).
   An Assetto Corsa circuit needs no entry in `AC_TRACKS`: given an id of its own and `--src`, `port_ac_track.py`
   reads its settings from the mod (`scripts/tracks/ac_mod_entry.py`), and `--entry-only <file>` writes them out
   without building, which is how `ac-track` names and credits the package before the build.
2. **Package** it with `packageCircuit` or `packageCar`, which check every id and path first (`lib/package-paths.ts`:
   nothing outside the package, no symbolic link), copy only what the package needs, rename the game's URLs to paths
   in the package, write mod.json, and check the folder as the game will.
3. **Clean up** the working copy (`--keep-build` keeps it), and return the package's folder: the tool rebuilds
   `public/mods/_index.json` when the package went there, so the dev server lists it at once.

Game-specific extractors live with their pipelines, next to the converters they feed: circuits in
`scripts/tracks/` (`extract_<source>_track.py`), cars in `scripts/cars/` (`port_<source>_car.py`).

## Adding an importer

Add `importers/<name>.ts`, default-exporting an `Importer` (lib/importer.ts): a one-line `summary`, a `usage`, and a
`run(argv)` that parses its arguments with `parseImportArgs` (which adds the package options and `--keep-build`),
converts, calls a packager, and returns the package's folder. `npm run mod -- import` finds it by its file name.
`importers/blender-track.ts` is the smallest one to copy.

- Put the source's credit and licence in the package: `packageCredit` keeps https links only, and the source's own
  statement files and the licence's text go in with `extraFiles`.
- What the source's licence allows decides what an import does, and the import says so plainly. Every importer reads
  it with `lib/licences.ts`, and no other code decides a licence:
  - `statementFiles(folder)` reads every statement file a folder has (readme, licence, copying, copyright, credits,
    authors, `<name>-readme.txt`), and `readLicenceText` / `readLicenceEntry` (a licence field: a database's,
    ui_car.json's) give a reading, `{ licences, problems, holders }`. A problem in any statement blocks sharing.
  - Only the licences whose texts are in `licences/` can be shared under, with an explicit version (the Free Art
    License, named in Speed Dreams' way, aside). Non-commercial or no-derivatives terms, negations, "?" or "*", a
    licence without a text here and restrictive wording are problems. `scripts/verify/verify-licences.ts` lists the
    cases; add one there for any statement a source writes that the reader gets wrong.
  - `creditLicence(reading)` gives the credit's licence fields: the licences' names and link when shareable, else
    "unknown" and `PERSONAL_USE_NOTE`, word for word. `licenceTextFiles(reading)` gives the texts to carry
    (`LICENSE-<id>.txt`), none when it isn't shareable.
  - Speed Dreams' content is free by default, so a circuit or car without a licence that lets a player share it is
    refused, with the reason (`importers/sd-track.ts` `circuitLicence` shows the whole gate). An asset database's
    word counts only for a copy fetched at the revision it pins (`pinnedCircuit`, `pinnedCar`) and with no statement
    file of its own. `--personal` converts the rest, marked for personal use.
  - Most Assetto Corsa mods can't be shared, so `ac-track` and `ac-car` always package them, for the player's own use
    unless the mod's statements, or a licence in the modder's settings, allow sharing. An F1 25 mod (`f1-track`) is
    always for personal use.
- Give it a suite (`scripts/verify/verify-<name>.ts`) that runs on a small sample, skipped when the sample isn't there.
- A source it downloads (`--fetch`) goes in `scripts/mods/.cache/<source>/`, which git ignores, at a pinned revision.
- A car with physics of its own: match its aero with `fitAero` and drive it with `driveSanity` before packaging it, so
  a conversion that spins, crawls or can't stop is caught here rather than by a player.
