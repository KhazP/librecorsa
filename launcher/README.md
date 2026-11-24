# LibreCorsa launcher

The LibreCorsa desktop app: a small native program that runs LibreCorsa online and offline. It serves the live site
(librecorsa.org) on `127.0.0.1`, keeping on disk every page, car and circuit it fetches, so the game is the live one
when online and the last one seen when not, with the game's static export bundled beside it (`out/` from
`npm run build`) for what was never fetched. It serves the player's mod packages too, opens the game in a Chromium
browser as an app window, and quits when that window closes. It converts a circuit or a car copied from another game
into a mod package, from the game's Mods panel, with nothing for the player to install, and it updates itself from this
repository's releases. It is written in Go with the standard library only, and is meant to replace the Electron
wrapper in `desktop/`, which opens librecorsa.org.

## Running it

A release is an app: LibreCorsa.app on macOS, `LibreCorsa.exe` in its folder on Windows, `librecorsa` in its folder on
Linux (which puts itself in the app menu on its first start). Opened, it shows the game's window; closing the window
quits it. Opening it again while it runs opens the game in the running one.

From a terminal, or in a clone:

```sh
./librecorsa              # serve and open the game; quits with its window
./librecorsa --no-browser # serve only, until Ctrl+C; open the printed URL yourself
```

It prints the URL (`http://127.0.0.1:47826/play`). With `--no-browser` it prints the address that opens the game with
the launcher's session (`/__launcher/open?code=…`, good once; [below](#the-api-and-who-may-call-it)): open that one to
convert from the game's window. On Windows a release is a window app with no console of its own: started from a
command prompt it prints there, started from Explorer only to the log.

| Flag           | Default                                         | What it does                                       |
| -------------- | ----------------------------------------------- | -------------------------------------------------- |
| `--game <dir>` | `game/` beside the launcher (in the macOS app, `Contents/Resources/game`), else `../out` | The game's static export |
| `--mods <dir>` | `Documents/LibreCorsa/mods` (created if missing, with a README); in a clone or with `go run`, `../public/mods` | Mod packages, one folder each |
| `--import <dir>` | `Documents/LibreCorsa/import` (created if missing, with a README); in a clone, `launcher/import` | Circuits and cars to convert |
| `--converter <dir>` | `converter/` beside the launcher (in the macOS app, `Contents/Resources/converter`); in a clone, `launcher/dist/converter` | The converter bundle |
| `--toolchain <dir>` | `<config dir>/LibreCorsa/toolchain` | Where the converter's tools are downloaded |
| `--site <origin>` | `https://librecorsa.org`; none in a clone       | The live site to mirror ([below](#the-live-site-online-and-offline)); `--site ""` for none |
| `--cache <dir>` | `<config dir>/LibreCorsa/site`                 | Where the site's files are kept                    |
| `--offline`    | off                                             | Never contact the site: what is kept, else the export |
| `--port <n>`   | `47826`                                         | Port on 127.0.0.1                                  |
| `--no-browser` | off                                             | Don't open a browser, and serve until stopped     |
| `--no-update`  | off                                             | Don't check for updates, nor install one           |
| `--version`    |                                                 | Print the version and exit                         |

In a clone, after `npm run build`: `cd launcher && go run . --no-browser` serves `../out` and nothing else (no site,
so a developer sees their own build), with the packages in `../public/mods` (where `npm run mod -- index` lists them
for the dev server too). `--site https://librecorsa.org` mirrors the live site over it, as a release does. A clone
never updates itself.

## Where things are

The player's own folders are in **Documents/LibreCorsa** on every system, where people look for them: `mods/` and
`import/`, made on the first start. Documents is the system's own: Windows' Documents known folder
(`SHGetKnownFolderPath`, so one moved to OneDrive or a network share is followed), `XDG_DOCUMENTS_DIR` from
`~/.config/user-dirs.dirs` on Linux (a desktop in another language names it otherwise), else `~/Documents`. The Mods
panel opens either folder in Finder, Explorer or the file manager ("Open folder").

The program's own files sit beside it, and are replaced by an update:

```
macOS    LibreCorsa.app/Contents/MacOS/librecorsa          the launcher
                        Contents/Resources/game/           the game's static export (a copy of out/), served when the site can't be
                        Contents/Resources/converter/      the converter (launcher/converter/build.mjs)
Windows  LibreCorsa/LibreCorsa.exe, game/, converter/
Linux    LibreCorsa/librecorsa, game/, converter/, librecorsa.desktop, librecorsa.png
```

The converter writes its working copies inside its own folder, so in the macOS app (signed, and read-only when macOS
runs it from where it was downloaded) it runs from a copy in `<config dir>/LibreCorsa/converter`, made once per release.

The rest is in the per-user config folder, `<config dir>/LibreCorsa`: `~/Library/Application Support` on macOS,
`%LocalAppData%` on Windows (not the roaming profile: it holds the downloaded circuits and cars), `~/.config` on Linux:

- `browser/`: the browser profile the game runs in, and with it the saves (laps, settings, imported mods). A Snap or
  Flatpak browser can only write inside its own folder, so with one of those it is `~/snap/<name>/common/LibreCorsa`
  or `~/.var/app/<id>/config/LibreCorsa`.
- `toolchain/`: the converter's downloaded tools.
- `site/`: the site's pages, cars and circuits the launcher fetched ([The live site](#the-live-site-online-and-offline)).
- `update/`: an update downloaded and waiting to be installed.
- `launcher.log`: what the launcher says (it has no terminal as an app), moved to `launcher.log.1` past 1 MB.

## Quitting with the window

The launcher starts the browser itself, on a profile of its own, so that browser ends with its last window, and the
launcher with it (`lifetime.go`). On macOS a browser stays open with no window, so there the game's page also tells the
launcher when it closes or reloads (`pagehide`), and once no page of the game is left for 15 s the launcher asks the
browser to end (as quitting it from its menu does) and quits.

With the system's default browser (no Chromium found) there is no process of the launcher's to watch: the game's page
calls `POST /__launcher/alive` every 30 s (`src/lib/mods/launcher-imports.ts`), and the launcher quits once none has
for 2 minutes. It never quits while a conversion or a download runs, nor while an update goes in place: it waits for
them to end. With `--no-browser` it serves until stopped.

## Errors

A failure to start (the port held by another program, the game missing, the mods folder not writable) is shown in a
message box of the system's when the launcher runs as an app: `MessageBoxW` on Windows, `osascript` on macOS, zenity
or kdialog on Linux when one is there. It is in the log either way, with what it said before.

## Why a fixed port

A browser keeps a site's storage per origin, and the origin includes the port. If the port changed between runs, the
game would open on an empty origin each time and the player's saves would seem lost. So the port is fixed, and when it
is taken the launcher does not move to another:

- taken by another copy of the launcher (it asks `/__launcher`, which answers who it is): it opens the game there and exits;
- taken by anything else: it says so and exits with an error. `--port` picks another, with its own saves.

The server listens on 127.0.0.1 only, and refuses any request whose `Host` isn't `127.0.0.1:<port>` or
`localhost:<port>`, so a web page can't point a name of its own at it and read the game or the mods (DNS rebinding).
Every answer says `Cross-Origin-Resource-Policy: same-origin`, so another site's page can't embed one either.
Requests can't leave the game, mods or cache folders: paths with `..`, encoded or not, backslashes or absolute names
are refused, and files are opened through `os.Root`, which also stops symbolic links that lead outside. Files are only
read (GET and HEAD); what takes a POST is the converter's API below, with checks of its own, and `/api`, passed on to
the site, which checks the Origin itself.

## The live site, online and offline

Every page and file outside `/mods/`, `/__launcher…` and `/api/` comes from the site (`--site`, librecorsa.org in a
release), the way the website serves it, hosted cars and circuits included (they live in the site's R2 bucket, which
`cloudflare/worker.js` serves at the same paths, not in the export). Each is kept in the cache folder, and asked about
again as `public/sw.js` does in the browser (`mirror.go`):

- Next's hashed build output (`/_next/static/…`) never changes under its name: a kept copy is served without asking.
- Pages and the files that say which build is current (navigations, `.html`, Next's `.txt` payloads,
  `offline-manifest.json`, `build.json`, `sw.js`, `manifest.webmanifest`) are asked about on every request, with the
  kept copy's ETag: a 304 serves the copy.
- Everything else (models, textures, sounds, track data, which keep their names when they change) is asked about once
  per path per launcher run.

A download is streamed to the browser while it is written, with the site's `Content-Length` and `X-File-Size` (the
loading screen's progress reads it when a file comes compressed, with no length), into a temporary file renamed into
place once whole, so a cut download never leaves a broken copy (and the browser's copy of it fails too, rather
than passing for the whole file). Gzip is taken off on the way, and files are kept as the browser gets them. A Range
for a file not kept goes to the site as it is and isn't kept, but for `bytes=0-`: a media element (the music) asks for
a whole file that way, and it is downloaded and kept, answered as a 206 of all of it. A kept file answers Ranges
itself.

When the site answers 404, the kept copy is dropped and the site's 404 page passed on. When it answers 5xx, or the
network fails, or nothing answers within 6 s, the kept copy is served, else the export beside the launcher (`game/`),
else the export's 404 page; after a network failure the site isn't asked for 30 s, so offline play doesn't wait on
every request. `--offline` never asks it.

The cache folder (`<config dir>/LibreCorsa/site`, this user's alone) holds `files/<path>`, the files as served;
`meta/<path>.json`, each one's ETag, Last-Modified and type, with the size and time of the file it describes (a file
whose record doesn't match isn't served); and `tmp/`, downloads in progress, emptied at start. A page is kept as
`<path>.html` and `/dir/` as `dir/index.html`. Deleting the folder only means downloading again.

### `/api`

The game's online side (lap boards, rooms, races, accounts: `cloudflare/api`) is passed on to `<site>/api/`
(`apiproxy.go`), every method and WebSockets too (a production build calls `/api` and opens its sockets on its own
origin, here `http://127.0.0.1:<port>`), and never kept. With `--offline` it answers `503`, and `502` when the site
can't be reached.

- **Origin.** The API answers only its own origin (`allowedOrigin` in `cloudflare/api/index.ts`), so the launcher's
  own (`http://127.0.0.1:<port>`, `http://localhost:<port>`) is passed on as the site's, and the Referer likewise. Any
  other Origin goes as it is, and the site refuses it as it would on the web.
- **Cookies.** Account sessions are cookies, `__Host-` and `Secure` on https (`cloudflare/api/accounts/http.ts`).
  Chrome (158, tried on macOS) keeps and sends `Secure` and `__Host-` cookies on `http://127.0.0.1:<port>` and
  `http://localhost:<port>`, which it counts as secure, for navigations and fetches alike. So they pass as they are,
  with only a `Domain=` taken off (the site sets none today). The launcher's session cookie (`librecorsa_launcher_*`)
  is never sent on, and the site can't set one of that name. A browser keeps a host's cookies for all its ports, so
  another launcher on another `--port` shares the account's.
- **Headers.** `X-Forwarded-*` and `Forwarded` aren't sent, nor hop-by-hop headers (but an `Upgrade`, for sockets).
  A redirect to the site's own pages comes back as a path on the launcher.

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
fetched over HTTPS only (a redirect is followed only to another `https://` address), its size and SHA-256 are checked
before it is opened, and only the program itself is taken out of the archive (a regular file at its pinned path,
written through `os.Root`; links and other entries are passed over). The program's own size and SHA-256 are pinned
too: uv and Node are checked against them before every run, through `os.Root`, with no link allowed at the program or
on the way to it, so a program changed or replaced after it was downloaded is never run. The toolchain is then not
ready, and the next download replaces it. uv then installs Python 3.14 (it checks each Python build against the
SHA-256 it carries) and fetches the packages, held to what PyPI had on a pinned date (`UV_EXCLUDE_NEWER`), so their
dependencies are the same on every machine. Python goes only into that folder: no `python3.14` on the player's
PATH, nothing in the Windows registry. Everything goes into `<config dir>/LibreCorsa/toolchain` (uv, Node, uv's
cache and its Pythons; about 770 MB once unpacked on macOS), with a `toolchain.json` saying what was set up: a
release with other pins or other packages sets up again. Deleting the folder takes it all away. On a fast line the
whole first use takes under a minute. The folder, the downloads and the programs are this user's alone (0700).

### How a conversion runs

- One job at a time (a download or a conversion); a second gets `409` (`busy`), before anything else is checked.
- The folder is checked when the conversion is asked for, then copied (its folders and regular files only, each
  read through `os.Root` and refused if it isn't the file the walk found) into `<toolchain>/staging/import-*/`, a
  folder only this user can read, and the copy is converted and removed afterwards. Whatever changes in `import/`
  while the converter runs, minutes later, doesn't reach it.
- The program and its arguments are fixed (`<toolchain>/node <converter>/scripts/mods/mod-tool.mjs import <kind>
  <copy> --out <mods>`), never run through a shell, in the converter's folder. Nothing from the imported folder is
  run: it is only the importer's input.
- The environment is the launcher's own, not the player's: `PATH` starts with the toolchain's Node and uv, and only
  what a program needs to start (home, temporary folder, language, Windows' system folders) is kept from the player's;
  `NODE_OPTIONS`, `PYTHONPATH`, uv settings and the like are not passed on.
- Its output goes to the job's log only (the last 2000 lines), which the panel shows under "Show the log".
- Stopping it stops its whole process tree. On macOS and Linux the group is asked to end, and killed 5 s later if
  it hasn't; the kill is called off once the program has ended, since a group with nothing left frees its id for
  another. On Windows the programs are held in a Job Object, ended together and closed with the job, so a Python
  converter whose parent ended first goes too (`taskkill /T`, with a time limit and no window, if the job can't be
  made).
- Each package it wrote is then checked as the game will take it (`mod-tool.mjs check`): one with problems fails the
  job, with the problems listed. The panel shows the package's credit and licence, and any line of the importer's
  about the source's licence ("for personal use only"), above the log.
- The converter's working copies (`converter/public/tracks/<working id>/`, named in converter.json as `work`) are
  removed before and after, so a stopped conversion leaves nothing behind.

### The API, and who may call it

| Endpoint                          | What                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `GET /__launcher`                 | who answers (`{ "app": "librecorsa-launcher", "version": …, "imports": true, "session": <this request holds it> }`) |
| `GET /__launcher/open?code=<code>` | sets the session cookie for a good code (once), then on to `/play`  |
| `GET /__launcher/imports`         | the import folder, each entry's kind, the converter and the toolchain's state, the last job |
| `POST /__launcher/toolchain`      | start the first-use download (`202`, then poll)                 |
| `POST /__launcher/convert`        | start a conversion: `{ "folder": "<name in import/>" }`         |
| `GET /__launcher/convert`         | the running or last job: step, progress, log tail, packages, problems |
| `POST /__launcher/convert/cancel` | stop the running job                                             |
| `POST /__launcher/open-folder`    | open a folder of the player's: `{ "folder": "mods" \| "import" }` (no path: only those two, by name) |
| `POST /__launcher/alive`          | a page of the game is open: `{ "page": "<random id>", "closing": false }` ([Quitting](#quitting-with-the-window)) |
| `GET /__launcher/update`          | the update's state: `none`, `downloading`, `ready`, `available` or `failed`, with the version |
| `POST /__launcher/update/restart` | install the downloaded update now, keeping the game's window ([Updates](#updates)) |

Only the game's own page, in the window the launcher opened, may call them:

- the Host check every request passes (DNS rebinding);
- every call (GET too) carries this run's session cookie (`session.go`). 127.0.0.1 is open to every user of the
  computer, so a header alone would let another user's program in. The launcher opens the game at
  `/__launcher/open?code=<code>`; that answer sets the cookie (`librecorsa_launcher_<port>`, HttpOnly,
  SameSite=Strict, a random value minted for this run, kept with the browser profile so opening the game again while
  the launcher runs keeps it) and moves on to `/play`. The code is good once: it is on the browser's command line,
  which other users can list, so a code used a second time ends the session for everyone (the launcher says so)
  until it starts again. `/__launcher` says whether a request holds the session, and the panel tells a window
  without one to open the game from the launcher. `alive` alone doesn't need it: any window of the game keeps the
  launcher running;
- every call carries `X-LibreCorsa-Launcher: 1`. A page of another site can't send a custom header without a CORS
  preflight, which the launcher never answers, and a form or a link can't send one at all;
- a POST must come with `Origin: http://<the Host it was sent to>` (the launcher's own origin), and a browser's
  `Sec-Fetch-Site` other than `same-origin` is refused;
- a POST with a body sends JSON (`Content-Type: application/json`, which a form can't send), at most 4 KB, with no
  field but the ones expected; one that takes no fields (the download, the cancel, the restart) may also come with no
  body and no `Content-Type`;
- a folder is named as it is listed: one path segment, no `..`, separator, drive letter or hidden name, and it must
  be a folder (not a link) directly in `import/`, opened through `os.Root`.

The game's files and the mod packages are served to any program on the computer, as before: they are what the
player installed, and nothing there changes anything.

## Updates

A release publishes, beside its archives, `launcher-latest.json`: its version, and for each platform the archive's
address, size and SHA-256. Its Ed25519 signature is `launcher-latest.json.sig` (base64), made with the private key in
the `LAUNCHER_UPDATE_KEY` secret. The public key is `launcher/update-key.pub`, built into the launcher (`build.mjs`:
`-X main.updatePublicKeys`). The launcher (`update.go`), when online:

1. fetches the manifest and its signature from `https://github.com/librecorsa/librecorsa/releases/latest/download/`
   15 s after it starts and every 6 hours (when the latest release is the desktop app's, it looks the newest
   `launcher-v*` release up in GitHub's list of releases);
2. checks the signature against its key, then the version: only a newer one goes further (never a downgrade);
3. downloads its platform's archive, over HTTPS only and only from this repository's releases, and checks its size
   and SHA-256 against the manifest before opening it;
4. unpacks it into `<config dir>/LibreCorsa/update/staged` with the rules the converter's tools are held to
   (`update_unpack.go`: folders and regular files only, no link of any kind, no name outside the one folder the
   archive holds, through `os.Root`), and runs the launcher in it with `--version`, which must say the manifest's;
5. puts it in place at the next start, or when the player presses **Restart to update** on the title screen
   (`update_apply.go`): macOS replaces the app bundle whole, Linux the launcher's folder; Windows renames each thing the
   release brings (the running `LibreCorsa.exe` too, which can be renamed but not deleted) into
   `.update-old-<time>` in the folder and puts the new one in its place. The new launcher is started and must answer
   on the port with the new version within 45 s; if anything fails, the moves are undone, the old version stays, and
   that version isn't tried again. After "Restart to update" the new launcher keeps the game's window, its browser
   and its session, and the page reloads from it.

The update goes where the launcher is, so it can only update itself where it can write: a release unpacked in a folder
of the player's, or LibreCorsa.app in /Applications for an administrator. Elsewhere (and run by macOS from where it was
downloaded, or built without `update-key.pub`), the title screen only says a newer release is out, with a link to it.

`npm run launcher:keygen` makes the key: it writes `launcher/update-key.pub` (commit it) and prints the private key,
for the `LAUNCHER_UPDATE_KEY` secret. It refuses to replace a key that is there (`--force`): launchers built with it
would no longer take the updates. `update-key.pub` may list more than one key, one per line, so a new key can be
built in while the releases are still signed with the old one.

## Building

```sh
npm run launcher:build                         # binaries only, into launcher/dist/<os>-<arch>/
npm run launcher:build -- --bundle             # the app for each platform, packed (needs out/ from npm run build)
npm run launcher:build -- --only darwin-arm64  # one target
npm run launcher:build -- --bundle --version 1.2.3
```

Targets: darwin/arm64, darwin/amd64, windows/amd64, linux/amd64, built with `-trimpath -buildvcs=false -ldflags "-s -w"`
and `CGO_ENABLED=0`; Windows as a window app (`-H=windowsgui`), with its icon and version from a `.syso` that a pinned
[go-winres](https://github.com/tc-hib/go-winres) (`go run github.com/tc-hib/go-winres@v0.3.3`, so never in `go.mod`)
writes for the build and removes after. Tests: `cd launcher && go vet ./... && go test -race ./...`.

`--bundle` lays each platform out as above and packs it into `launcher/dist/`:

| Platform | App                                  | Packed                                                         |
| -------- | ------------------------------------ | -------------------------------------------------------------- |
| macOS    | `darwin-<arch>/LibreCorsa.app`: `Info.plist` (`org.librecorsa.launcher`, the version from package.json, `LSUIElement`: no Dock icon or menu, the game's window is the app), `icon.icns` from `launcher/icons` | `LibreCorsa-<version>-mac-<arm64\|x64>.zip`, and `.dmg` on a Mac (hdiutil) |
| Windows  | `windows-amd64/LibreCorsa/`, its icon from `launcher/icons/icon.ico` | `LibreCorsa-<version>-win-x64.zip`                 |
| Linux    | `linux-amd64/LibreCorsa/`, with `librecorsa.desktop` and `librecorsa.png` (`launcher/icons/icon.png`) | `LibreCorsa-<version>-linux-x64.tar.gz`      |

The macOS app is signed ad hoc (`codesign --sign -`) when it is built on a Mac: no Developer ID yet, so macOS asks on
the first start (`release-notes.md`). Each archive holds the app's one folder, written by `go run ./tools/release pack`
(folders and regular files only, executables marked), which is what an update unpacks. `--no-archive` lays out
without packing and `--archive-only` packs what is laid out: the release signs the Windows launcher in between. The
bundle leaves out source maps, `_headers` and a clone's `out/mods/`.

`.github/workflows/release-launcher.yml` makes a release from a `launcher-v<version>` tag: the export once, each
platform on its own runner (macOS for the app and the dmg), `LibreCorsa.exe` signed through SignPath (artifact
configuration `launcher`, the `test-signing` policy on a manual run, `release-signing` once `SIGNPATH_SIGN_RELEASES` is
`true`), then the manifest written and signed (`go run ./tools/release manifest`, which checks the secret is the
committed key's other half), and the release published and marked latest. A manual run builds and signs, and publishes
nothing.

`--bundle` also builds the converter once (`node launcher/converter/build.mjs`, into `launcher/dist/converter`) and
copies it into each app. It is everything an import needs except Python, Node and what they download, and it
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

- The macOS app is signed ad hoc, not with a Developer ID, nor notarised: macOS asks on the first start (System
  Settings > Privacy & Security > Open Anyway), and may ask again for Documents after an update (an ad hoc signature
  changes with each build). Windows SmartScreen warns until the SignPath certificate has a reputation (More info >
  Run anyway).
- `launcher-latest.json` is found at the repository's latest release: a desktop app release made after a launcher
  release becomes the latest, and the launcher then looks the newest launcher release up in GitHub's list of releases
  (60 calls an hour per address without a token: one every 6 hours is far within it).
- Accounts sign in with a link code from another device (as the desktop app did). A provider's sign-in (Discord,
  Google, Steam) comes back to librecorsa.org rather than to the launcher, and passkeys belong to librecorsa.org, so
  neither can finish in the launcher's window.
- The cache folder is never trimmed: a car or circuit taken off the site goes when the site answers 404 for it, and
  nothing else goes. The game's service worker (`public/sw.js`) also keeps the hosted files it loads, in the browser
  profile, so they are on disk twice.
- A browser other than Chrome (the default browser, when no Chromium is found) hasn't been tried with the account
  cookies: one that won't keep a `Secure` cookie on `http://127.0.0.1` can't sign in.
- The force-feedback bridge (`scripts/ffb-bridge/ffb-bridge.ts`) is not part of it yet.
- The converter's downloads are pinned for darwin/arm64, darwin/amd64, windows/amd64 and linux/amd64 only (the
  targets above); elsewhere the panel says the tools aren't available. The Python packages are pinned by version and
  date, not by hash, and a converter that adds packages of its own (`uv run --with`) fetches them on its first run.
- The Python uv installs is checked by uv when it is downloaded, not again before each run, as uv and Node are.
