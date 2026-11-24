# LibreCorsa launcher

A small native program that runs LibreCorsa with no network: it serves the game's static export (`out/` from
`npm run build`) and the player's mod packages on `127.0.0.1`, and opens the game in a Chromium browser as an app
window. It is written in Go with the standard library only, and is meant to replace the Electron wrapper in
`desktop/` for offline play.

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
```

The browser profile the game runs in, and with it the saves (laps, settings, imported mods), lives in
`<config dir>/LibreCorsa/browser`: `~/Library/Application Support` on macOS, `%LocalAppData%` on Windows (not the
roaming profile: it holds the downloaded circuits and cars), `~/.config` on Linux. A Snap or Flatpak browser can only
write inside its own folder, so with one of those it is `~/snap/<name>/common/LibreCorsa` or
`~/.var/app/<id>/config/LibreCorsa`. Replacing the folder above with a newer release keeps them.

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
refused, and files are opened through `os.Root`, which also stops symbolic links that lead outside.

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

## Building

```sh
npm run launcher:build                         # binaries only, into launcher/dist/<os>-<arch>/
npm run launcher:build -- --bundle             # plus game/ (from out/) and mods/ beside each
npm run launcher:build -- --only darwin-arm64  # one target
```

Targets: darwin/arm64, darwin/amd64, windows/amd64, linux/amd64, built with `-trimpath -buildvcs=false -ldflags "-s -w"`
and `CGO_ENABLED=0`. The bundle leaves out source maps, `_headers` and a clone's `out/mods/`. Tests:
`cd launcher && go vet ./... && go test -race ./...`.

## Not yet

- The binaries are not signed or notarized: macOS Gatekeeper and Windows SmartScreen will warn on first run
  (macOS: right-click → Open; Windows: More info → Run anyway).
- The game's hosted cars and circuits (served from librecorsa.org) are only offline when they are in the export.
- The force-feedback bridge (`scripts/ffb-bridge/ffb-bridge.ts`) is not part of it yet.
