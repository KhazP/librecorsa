# scripts/mods

The tools for mod packages: checking, packing and listing them, and importing content from other games and tools
into them. Players and modders start at [docs/modding.md](../../docs/modding.md) (the package format) and
[docs/importing-mods.md](../../docs/importing-mods.md) (from another game to a package). This page is for changing
the tools.

```
mod-tool.ts          npm run mod -- …: check, pack, index, import, from-circuit, from-car
lib/
  package-check.ts   a package folder checked as the game's importer checks it, and its content hash
  zip-writer.ts      the zip `pack` writes (what src/lib/mods/zip-reader.ts reads)
  mods-index.ts      a mods folder's _index.json, for the dev server
  manifest-file.ts   mod.json read, started, added to and written; ids and credits made from a source's
  circuit-package.ts a circuit the converters built (public/tracks/<id>/) → a package
  car-package.ts     a converted car (its GLB, liveries, sound, physics patch) → a package
  importer.ts        what an importer is, and the options every importer takes
  licences.ts        a source's licence statement read: which licence, whether players may share a conversion
  toolchain.ts       running the repository's Python (uv) and TypeScript (tsx) converters
licences/            the full texts of the licences the importers recognise, for the packages they make
importers/
  <name>.ts          one per source: `npm run mod -- import <name>`
  sd-track.circuits.json   Speed Dreams' circuits as its asset database lists them, each archive pinned by its sha256
```

The game's side of packages (the manifest's rules, the zip reader, the store, the loader) is in `src/lib/mods/`; the
tools import it rather than repeat it, so a package the tools pass is one the game takes.

## How an import runs

Every importer does the same three things:

1. **Convert** the source with the converter for its kind, into a working copy the game's builders understand. A
   circuit is built with the shared circuit builder (`scripts/tracks/build_blender_track.py`, or
   `port_ac_track.py` for an Assetto Corsa circuit) into `public/tracks/<working id>/`, run with `--no-register` so
   the game's own circuit list is never touched: the builder writes the circuit's listing beside its files
   (`circuit.json`). A car is ported into a GLB laid out as the game's rig expects (docs/PORTING-CARS.md).
2. **Package** it with `packageCircuit` or `packageCar`, which copy only what the package needs, rename the game's
   URLs to paths in the package, write mod.json, and check the folder as the game will.
3. **Clean up** the working copy (`--keep-build` keeps it), and rebuild `public/mods/_index.json`, so the dev server
   and the launcher list the new package at once.

Game-specific extractors live with their pipelines, next to the converters they feed: circuits in
`scripts/tracks/` (`extract_<source>_track.py`), cars in `scripts/cars/` (`port_<source>_car.py`).

## Adding an importer

Add `importers/<name>.ts`, default-exporting an `Importer` (lib/importer.ts): a one-line `summary`, a `usage`, and a
`run(argv)` that parses its arguments with `parseImportArgs` (which adds the package options), converts, and calls a
packager. `npm run mod -- import` finds it by its file name. `importers/blender-track.ts` is the smallest one to copy.

- Put the source's credit and licence in the package: `packageCredit` keeps https links only, and a licence file the
  source carries goes in with `extraFiles`.
- Refuse content the source's licence doesn't let a player share, with a message that says so, rather than packaging
  it. `lib/licences.ts` reads a readme's or licence file's statement; `importers/sd-track.ts` (`circuitLicence`) shows
  the whole gate, with `--personal` for a conversion kept to oneself.
- Give it a suite (`scripts/verify-<name>.ts`) that runs on a small sample, skipped when the sample isn't there.
