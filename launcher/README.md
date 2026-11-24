# LibreCorsa launcher

A small native program that runs LibreCorsa with no network: it serves the game's static export (`out/` from
`npm run build`) and the player's mod packages on `127.0.0.1`, and opens the game in a Chromium browser as an app
window. It also converts a circuit or a car copied from another game into a mod package, from the game's Mods panel,
with nothing for the player to install. It is written in Go with the standard library only, and is meant to replace
the Electron wrapper in `desktop/` for offline play.

## Running it

```sh
./librecorsa              # serve and open the game
./librecorsa --no-browser # serve only; open the printed URL yourself
```

It prints the URL (`http://127.0.0.1:47826/play`) and serves until stopped with Ctrl+C. Starting it a second time
while it runs just opens the game again.

| Flag           | Default                                         | What it does                                       |
| -------------- | ----------------------------------------------- | -------------------------------------------------- |
| `--game <dir>` | `game/` beside the binary, else `../out`        | The game's static export                           |
| `--mods <dir>` | `mods/` beside the binary (created if missing); in a clone or with `go run`, `../public/mods` | Mod packages, one folder each |
| `--import <dir>` | `import/` beside the binary (created if missing, with a README); in a clone, `launcher/import` | Circuits and cars to convert |
| `--converter <dir>` | `converter/` beside the binary; in a clone, `launcher/dist/converter` | The converter bundle |
| `--toolchain <dir>` | `<config dir>/LibreCorsa/toolchain` | Where the converter's tools are downloaded |
| `--port <n>`   | `47826`                                         | Port on 127.0.0.1                                  |
| `--no-browser` | off                                             | Don't open a browser                               |
| `--version`    |                                                 | Print the version and exit                         |

In a clone, after `npm run build`: `cd launcher && go run . --no-browser` serves `../out`, with the packages in
`../public/mods` (where `npm run mod -- index` lists them for the dev server too).

## Folder layout

A release (`npm run launcher:build -- --bundle`) is one folder per platform:

```
librecorsa(.exe)   the launcher
game/              the game's static export (a copy of out/)
mods/              mod packages; starts empty, with a README.txt
import/            circuits and cars to convert; starts empty, with a README.txt
converter/         the converter: the mod tools and the Python converters (launcher/converter/build.mjs)
```

The browser profile the game runs in, and with it the saves (laps, settings, imported mods), lives in
`<config dir>/LibreCorsa/browser`: `~/Library/Application Support` on macOS, `%LocalAppData%` on Windows (not the
roaming profile: it holds the downloaded circuits and cars), `~/.config` on Linux. A Snap or Flatpak browser can only
write inside its own folder, so with one of those it is `~/snap/<name>/common/LibreCorsa` or
`~/.var/app/<id>/config/LibreCorsa`. Replacing the folder above with a newer release keeps them (copy `mods/` and
`import/` across). The converter's downloaded tools go beside the profile, in `<config dir>/LibreCorsa/toolchain`.

## Why a fixed port

A browser keeps a site's storage per origin, and the origin includes the port. If the port changed between runs, the
game would open on an empty origin each time and the player's saves would seem lost. So the port is fixed, and when it
is taken the launcher does not move to another:

- taken by another copy of the launcher (it asks `/__launcher`, which answers who it is): it opens the game there and exits;
- taken by anything else: it says so and exits with an error. `--port` picks another, with its own saves.

The server listens on 127.0.0.1 only, and refuses any request whose `Host` isn't `127.0.0.1:<port>` or
`localhost:<port>`, so a web page can't point a name of its own at it and read the game or the mods (DNS rebinding).
Every answer says `Cross-Origin-Resource-Policy: same-origin`, so another site's page can't embed one either.
Requests can't leave the game or mods folders: paths with `..`, encoded or not, backslashes or absolute names are
refused, and files are opened through `os.Root`, which also stops symbolic links that lead outside. Files are only read
(GET and HEAD); the one thing that takes a POST is the converter's API below, with checks of its own.

## Why Chromium

Wheels, pedals and pads (and the DualSense's triggers) are read over WebHID, which only Chromium browsers have. The
launcher looks for Chrome, Edge, Brave and Chromium in their usual install locations on macOS, Windows and Linux, then
on `PATH`, and opens the first with `--app` (a window without tabs or address bar) on the profile above, apart from
the player's own. One that won't start, or quits with an error at once, leaves the next. With none that opens it opens
the default browser and says that controllers need one of those; the game still runs.

## Mods

Drop a package into `mods/` as a folder named by its id, with its `mod.json` inside:

```
mods/
  acme.ring/
    mod.json
    ring/track.glb
    ...
```

A package id is `<author>.<name>` (lowercase letters, digits, `-` and `_`; see `src/lib/mods/mod-manifest.ts`).
Folders named otherwise, or without a `mod.json`, are ignored. The game reads the list from `/mods/_index.json`, which
the launcher makes on each request with each package's content hash (computed like `packageHash` in
`mod-manifest.ts`; `.DS_Store`, `Thumbs.db` and `__MACOSX/` don't count). A package's hash is kept until a file's
name, size or time changes, so the list stays cheap. Reload the game after adding or changing a package. A package
imported in the game's Mods panel with the same id wins over the folder's.

A `_catalogue/` folder in `mods/` offers packed packages in the Mods panel, to install in a click
(`npm run mod -- catalogue mods/_catalogue` writes its `catalogue.json` from the zips in it; docs/modding.md). The
launcher serves only `catalogue.json`, `.zip` files and `.webp`, `.png` and `.jpg` previews from it, at
`/mods/_catalogue/<name>`, with no subfolders.

## Converting circuits and cars

The player copies a circuit's or a car's folder from another game into `import/` and opens the game's Mods panel
(`src/components/menu/LauncherImports.tsx`, shown only under the launcher). It lists each folder with what it was
recognised as, and converts one into a package in `mods/` with `npm run mod -- import <kind> <folder> --out <mods>`,
run from the converter bundle. The game lists the package when it restarts; the panel offers the restart.

| Kind            | Recognised by (in the folder, or in the one folder inside it)                 |
| --------------- | ----------------------------------------------------------------------------- |
| `ac-car`        | a `.kn5`, and `data.acd` or `data/car.ini`                                    |
| `ac-track`      | a `.kn5` or `models*.ini`, and `ui/ui_track.json` or `ui/<layout>/ui_track.json` |
| `sd-track`      | an `.xml` whose `<params>` says `type="trackdef"`                             |
| `sd-car`        | an `.xml` with a `<section name="Car">`, and an `.acc` or `.ac` model           |
| `f1-track`      | an `.erp`                                                                     |
| `blender-track` | a `.glb` beside a `.json` of the same name (its settings)                     |

Anything else is listed as unknown (a zip as "unzip it first"), and a kind is only offered when the release's
converter has its importer (`converter/converter.json`). Links are never followed when a folder is recognised, and a
folder that holds a link anywhere is refused: the converter reads files by their paths, and a link could hand it any
file on the computer.

### First use: the downloads

The converter runs on Python and Node, which a release doesn't carry. The first time the player presses Convert, the
panel shows what will be downloaded and its size, and nothing is fetched until they agree:

| What    | Version  | From                                              | Size (macOS arm64) |
| ------- | -------- | ------------------------------------------------- | ------------------ |
| uv      | 0.13.9   | `https://github.com/astral-sh/uv/releases/download/0.13.9/uv-<platform>.tar.gz` (`.zip` on Windows) | 14.6 MB |
| Node.js | v26.13.1 | `https://nodejs.org/dist/v26.13.1/node-v26.13.1-<platform>.tar.gz` (`.zip` on Windows) | 58.3 MB |
| Python 3.14 and the converters' packages | as uv 0.13.9 pins it; `scripts/tracks/requirements.txt` | fetched by uv from python-build-standalone and PyPI | about 135 MB |

Each URL, size and SHA-256 is pinned in `toolchain.go` for every platform a release is built for. A download is
fetched over HTTPS only (a redirect elsewhere is refused), its size and SHA-256 are checked before it is opened, and
only the program itself is taken out of the archive (a regular file at its pinned path, written through `os.Root`;
links and other entries are passed over). uv then installs Python 3.14 (it checks each Python build against the
SHA-256 it carries) and fetches the packages, held to what PyPI had on a pinned date (`UV_EXCLUDE_NEWER`), so their
dependencies are the same on every machine. Python goes only into that folder: no `python3.14` on the player's
PATH, nothing in the Windows registry. Everything goes into `<config dir>/LibreCorsa/toolchain` (uv, Node, uv's
cache and its Pythons; about 770 MB once unpacked on macOS), with a `toolchain.json` saying what was set up: a
release with other pins or other packages sets up again. Deleting the folder takes it all away. On a fast line the
whole first use takes under a minute.

### How a conversion runs

- One job at a time (a download or a conversion); a second gets `409`.
- The program and its arguments are fixed (`<toolchain>/node <converter>/scripts/mods/mod-tool.mjs import <kind>
  <folder> --out <mods>`), never run through a shell, in the converter's folder. Nothing from the imported folder is
  run: it is only the importer's input.
- The environment is the launcher's own, not the player's: `PATH` starts with the toolchain's Node and uv, and only
  what a program needs to start (home, temporary folder, language, Windows' system folders) is kept from the player's;
  `NODE_OPTIONS`, `PYTHONPATH`, uv settings and the like are not passed on.
- Its output goes to the job's log only (the last 2000 lines), which the panel shows under "Show the log".
- Stopping it stops its whole process tree (a process group on macOS and Linux, `taskkill /T` on Windows).
- Each package it wrote is then checked as the game will take it (`mod-tool.mjs check`): one with problems fails the
  job, with the problems listed. The panel shows the package's credit and licence, and any line of the importer's
  about the source's licence ("for personal use only"), above the log.
- The converter's working copies (`converter/public/tracks/<working id>/`, named in converter.json as `work`) are
  removed before and after, so a stopped conversion leaves nothing behind.

### The API, and who may call it

| Endpoint                          | What                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `GET /__launcher`                 | who answers (`{ "app": "librecorsa-launcher", "imports": true }`) |
| `GET /__launcher/imports`         | the import folder, each entry's kind, the converter and the toolchain's state, the last job |
| `POST /__launcher/toolchain`      | start the first-use download (`202`, then poll)                 |
| `POST /__launcher/convert`        | start a conversion: `{ "folder": "<name in import/>" }`         |
| `GET /__launcher/convert`         | the running or last job: step, progress, log tail, packages, problems |
| `POST /__launcher/convert/cancel` | stop the running job                                             |

Only the game's own page may call them:

- the Host check every request passes (DNS rebinding);
- every call (GET too) carries `X-LibreCorsa-Launcher: 1`. A page of another site can't send a custom header without
  a CORS preflight, which the launcher never answers, and a form or a link can't send one at all;
- a POST must come with `Origin: http://<the Host it was sent to>` (the launcher's own origin), and a browser's
  `Sec-Fetch-Site` other than `same-origin` is refused;
- a POST's body is JSON (`Content-Type: application/json`, which a form can't send), at most 4 KB, with no field
  but the ones expected;
- a folder is named as it is listed: one path segment, no `..`, separator, drive letter or hidden name, and it must
  be a folder (not a link) directly in `import/`, opened through `os.Root`.

## Building

```sh
npm run launcher:build                         # binaries only, into launcher/dist/<os>-<arch>/
npm run launcher:build -- --bundle             # plus game/ (from out/) and mods/ beside each
npm run launcher:build -- --only darwin-arm64  # one target
```

Targets: darwin/arm64, darwin/amd64, windows/amd64, linux/amd64, built with `-trimpath -buildvcs=false -ldflags "-s -w"`
and `CGO_ENABLED=0`. The bundle leaves out source maps, `_headers` and a clone's `out/mods/`. Tests:
`cd launcher && go vet ./... && go test -race ./...`.

`--bundle` also builds the converter once (`node launcher/converter/build.mjs`, into `launcher/dist/converter`) and
copies it beside each launcher. It is everything an import needs except Python, Node and what they download, and it
keeps the repository's layout, so the tools find each other where they do in a clone:

- the Python converters (`scripts/tracks`, `scripts/cars`) with the data files they read;
- the mod tool, each importer, and the scripts an import runs (the racing-line optimiser, the GLB compressors), each
  bundled by esbuild into a `.mjs` where its source is, their npm packages inlined and the code they share in
  `scripts/_chunks/`. `runTsx` (scripts/mods/lib/toolchain.ts) and `build_track.py` run that `.mjs` when the
  TypeScript source isn't there;
- `converter.json`, which names the mod tool, the importers, and Python's version and requirements files;
- `THIRD_PARTY_NOTICES.txt`, the licences of the inlined npm packages.

It holds no program of its own, so it is the same for every platform (about 4 MB). Of the dependencies that are
native code or WebAssembly: meshoptimizer carries its WebAssembly inside its JavaScript, so it is inlined like the
rest; @gltf-transform is plain JavaScript; Draco isn't used by any converter (nor installed); sharp, a native module
that @gltf-transform's texture functions load, is left out for a stub that says so, since no converter makes textures
in Node (they are made in Python, with Pillow). A converter that one day needs sharp would install a pinned copy into
the toolchain folder on first use rather than ship one per platform. The build refuses any `.node` file in a bundle.

In a clone: `npm run build`, `node launcher/converter/build.mjs`, then `cd launcher && go run . --no-browser` uses
`dist/converter` and `launcher/import/`.

## Not yet

- The binaries are not signed or notarized: macOS Gatekeeper and Windows SmartScreen will warn on first run
  (macOS: right-click → Open; Windows: More info → Run anyway).
- The game's hosted cars and circuits (served from librecorsa.org) are only offline when they are in the export.
- The force-feedback bridge (`scripts/ffb-bridge/ffb-bridge.ts`) is not part of it yet.

- The force-feedback bridge (`scripts/ffb-bridge/ffb-bridge.ts`) is not part of it yet.
- The converter's downloads are pinned for darwin/arm64, darwin/amd64, windows/amd64 and linux/amd64 only (the
  targets above); elsewhere the panel says the tools aren't available. The Python packages are pinned by version and
  date, not by hash, and a converter that adds packages of its own (`uv run --with`) fetches them on its first run.
