# Desktop and Android apps

LibreCorsa runs directly in your browser with nothing to install, and also offers optional desktop and Android apps.

- **The desktop app** for Windows, macOS, and Linux. It runs a lightweight local server on `127.0.0.1` that mirrors `librecorsa.org` while caching every page, car, and circuit it loads — so you play the live game when online and your cached copy when offline. It opens the game in a dedicated Chromium app window (so WebHID wheels, pedals, and DualSense controllers work out of the box), loads mod packages from `Documents/LibreCorsa/mods/`, converts circuits and cars from other games inside the in-game Mods panel, and updates itself from signed releases.
- **The Android app**, which opens the live site full-screen as a Trusted Web Activity (TWA) with no browser bar (requires Android 7 or later and Chrome).

## Installing and running

- **Windows:** Download `LibreCorsa-<version>-win-x64.zip`, extract the `LibreCorsa/` folder somewhere writable (for example inside your user folder), and open `LibreCorsa.exe`.
- **macOS:** Download `LibreCorsa-<version>-mac-arm64.dmg` (Apple Silicon) or `mac-x64.dmg` (Intel) and drag `LibreCorsa.app` into **Applications** (or another writable folder) before launching.
- **Linux:** Download `LibreCorsa-<version>-linux-x64.tar.gz`, unpack it, and run `./LibreCorsa/librecorsa`. On first start it adds an application menu entry (`org.librecorsa.LibreCorsa.desktop`) for itself.
- **Android:** Download and install `LibreCorsa-<version>-android.apk` (see [Verifying the Android signing certificate](#verifying-the-android-signing-certificate)).

When opened, the desktop app looks for **Chrome**, **Edge**, **Brave**, or **Chromium** and launches the game in its own `--app` window (no tabs or address bar) using an isolated browser profile. Closing the game window shuts the launcher down automatically (it waits for any active mod conversion, download, or update to finish first). Launching the app again while it is already running simply opens the game in the running instance.

## Where the desktop app stores its files

### Your mods and import folders (`Documents/LibreCorsa`)

On first launch, the desktop app creates two folders in your system **Documents** folder (following Windows' Known Folder / OneDrive path, Linux's `XDG_DOCUMENTS_DIR`, or `~/Documents`), both openable directly via **Open folder** in the in-game **Mods** panel:

- **`Documents/LibreCorsa/mods/`** — Drop unpacked mod packages here, one `<author>.<name>` folder with its `mod.json` inside (reload the game after adding or editing a package). See [Making mods](modding.md).
- **`Documents/LibreCorsa/mods/_catalogue/`** — Optional local catalogue folder holding `catalogue.json`, `.zip` mod packages, and `.webp` / `.png` / `.jpg` previews for one-click installation from the Mods panel.
- **`Documents/LibreCorsa/import/`** — Copy unzipped circuit or car folders from other games here to convert them into LibreCorsa mod packages from the Mods panel.

### App data, cache, and logs

Everything else lives in your per-user application data folder:

| Platform | App data folder |
| :-- | :-- |
| **macOS** | `~/Library/Application Support/LibreCorsa/` |
| **Windows** | `%LocalAppData%\LibreCorsa\` |
| **Linux** | `~/.config/LibreCorsa/` |

Inside that folder:

- **`browser/`** — Dedicated Chromium profile storing your local saves (personal bests, settings, setups, career saves, and driver identity key). If Linux uses a Snap or Flatpak Chromium browser, the profile lives inside that browser's sandbox directory instead (`~/snap/<name>/common/LibreCorsa` or `~/.var/app/<id>/config/LibreCorsa`).
- **`site/`** — Cached mirror of pages, cars, and circuits fetched from `librecorsa.org`. Deleting this folder frees disk space without touching your saves; files simply re-download when loaded again.
- **`toolchain/`** — Isolated `uv`, Node.js, and Python 3.14 tools downloaded on first use of the mod converter (about `770 MB` unpacked on macOS). Deleting this folder removes the converter toolchain cleanly.
- **`update/`** — Staged self-updates waiting to be installed on restart.
- **`launcher.log`** — Diagnostic log written by the desktop app (rotates to `launcher.log.1` past `1 MB`).

## Playing offline

- **Online mirroring with offline fallback:** Every page, car, and circuit served from `librecorsa.org` is streamed to the browser and cached atomically in `site/`. When you are offline — or if `librecorsa.org` fails to respond within 6 seconds — the desktop app seamlessly serves cached copies (or the bundled static export beside the app for files never fetched).
- **Load hosted content once online:** Most cars and circuits are hosted on `librecorsa.org` rather than bundled inside the installer, so load any circuit or car you want to drive offline at least once while connected.
- **Force offline mode:** Run the launcher from a terminal with `--offline` to skip all network checks immediately.
- **Accounts in the desktop app:** Because third-party sign-in redirects and passkeys belong to `librecorsa.org`, signing in to an optional account from the desktop app uses a one-time link code: on a browser signed in to `librecorsa.org`, open **Settings > Profile and data > Account > Show a code for another device**, then enter that code under **Use a code from another device** in the desktop app (codes work once and expire after 10 minutes).

## Built-in mod importer and converter

You can convert circuits and cars from other games directly inside the desktop app's **Mods** panel without installing Python or Node yourself:

1. Unzip the source circuit or car into a folder inside `Documents/LibreCorsa/import/`.
2. Open the in-game **Mods** panel; LibreCorsa detects each folder's format automatically:

| Format | Recognised by |
| :-- | :-- |
| **Assetto Corsa car (`ac-car`)** | A `.kn5` model plus `data.acd` or `data/car.ini` |
| **Assetto Corsa track (`ac-track`)** | A `.kn5` or `models*.ini` plus `ui/ui_track.json` (or `ui/<layout>/ui_track.json`) |
| **Speed Dreams track (`sd-track`)** | An `.xml` file with `type="trackdef"` |
| **Speed Dreams car (`sd-car`)** | An `.xml` file with `<section name="Car">` plus an `.acc` or `.ac` model |
| **Blender track (`blender-track`)** | A `.glb` model beside a `.json` settings file of the same name |

3. Click **Convert**. The first time you convert a mod, the panel lists the exact downloads and sizes (`uv`, Node.js, and Python 3.14 plus converter packages) and waits for your confirmation. `uv` and Node.js are downloaded over HTTPS, verified against pinned SHA-256 hashes (re-verified before every run), and installed strictly inside `toolchain/` without modifying your system `PATH` or registry.
4. Converted packages are validated automatically and placed in `Documents/LibreCorsa/mods/`; restart when prompted to load them. See [Importing mods from other games](importing-mods.md) for format details and licensing rules.

## Troubleshooting the desktop app

- **Port `47826` already in use:** The desktop app always serves on `http://127.0.0.1:47826` because browser saves are tied to the exact origin and port. If another program is holding port `47826`, the app reports an error instead of silently moving to a new empty save origin. You can start it on a different port with `--port <number>` (note that a different port uses a separate save origin).
- **No Chromium browser found:** If none of Chrome, Edge, Brave, or Chromium is installed, the launcher falls back to your system's default browser. The game runs normally, but WebHID steering wheel force feedback and DualSense adaptive triggers require a Chromium-based browser.
- **Self-update shows a download link instead of updating:** The app can only replace itself in a writable folder (such as `/Applications` as an administrator on macOS, or an extracted user folder on Windows/Linux). Running `LibreCorsa.app` straight from a mounted `.dmg` or quarantine location disables in-place updates and shows a release link instead.
- **Windows force-feedback bridge:** Wheels that need the local Windows FFB bridge (`scripts/ffb-bridge`) still run the bridge separately alongside the desktop app (see [Controls, controllers, and wheels](CONTROLS.md)).
- **Inspecting logs and CLI flags:** Check `launcher.log` in your app data folder if the launcher fails to start. Useful command-line flags include `--offline`, `--no-browser` (serve only and print a one-time session URL), `--no-update`, `--port <n>`, and `--version`.

## Official sources

Official builds are published in only two places:

- [librecorsa.org/download](https://librecorsa.org/download)
- [GitHub Releases](https://github.com/librecorsa/librecorsa/releases) (where the download page links point)

Each app has its own releases: `launcher-v<version>` for the desktop app, which are the repository's latest release, and `android-v<version>` for the Android app. The desktop app updates itself from the same GitHub Releases. Builds hosted anywhere else are unofficial, even if they carry the LibreCorsa name and logo.

## App IDs

| Platform | Identifier |
| :-- | :-- |
| macOS | `org.librecorsa.launcher` (`LibreCorsa.app`) |
| Windows | `LibreCorsa.exe`, product name LibreCorsa in its version information |
| Linux | `org.librecorsa.LibreCorsa.desktop` (the app menu entry the app adds for itself) |
| Android | `org.librecorsa.app` |
| Browser install (PWA) | `https://librecorsa.org/play` (web app manifest `id`) |

Before the desktop app, an earlier one (built with Electron) opened librecorsa.org on Windows, macOS and Linux, as `org.librecorsa.desktop`. Copies already installed keep working but get no more updates; its last version points to the new app.

## Verifying file checksums

Every asset on a GitHub release lists its SHA-256 checksum alongside the download. Compare it against your local file:

```sh
# macOS and Linux
shasum -a 256 LibreCorsa-<version>-mac-arm64.dmg
shasum -a 256 LibreCorsa-<version>-linux-x64.tar.gz
shasum -a 256 LibreCorsa-<version>-android.apk
```

```powershell
# Windows (PowerShell)
Get-FileHash .\LibreCorsa-<version>-win-x64.zip
```

Every file also comes with a signed build provenance attestation: a record of the workflow and tag that built it. Check one with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify LibreCorsa-<version>-win-x64.zip -R librecorsa/librecorsa
```

## How the desktop app updates itself

Each desktop release carries `launcher-latest.json`, which lists the release's version and, for each platform, its archive (`LibreCorsa-<version>-win-x64.zip`, `-mac-arm64.zip`, `-mac-x64.zip`, `-linux-x64.tar.gz`) with its size and SHA-256, and `launcher-latest.json.sig`, the list's Ed25519 signature. The app fetches both from the latest release when it starts and every few hours, and installs an update only when:

- the signature matches the public key built into the app;
- the version is newer than its own (never a downgrade);
- the archive comes from this repository's releases over HTTPS, with the size and SHA-256 the list gives.

It unpacks the update into a staging folder, checks that the new version runs, and puts it in place at the next start, or when you press **Restart to update** on the title screen. If anything fails, it keeps the version it has.

## Verifying the Android signing certificate

Every official Android APK is signed with the same release key. Its certificate's SHA-256 fingerprint is:

```
E0:C1:29:35:79:69:C0:83:B6:C6:19:EF:28:F7:11:1B:B6:3E:6B:91:05:FA:91:31:89:57:37:57:58:6C:FE:29
```

The exact same fingerprint is published at [librecorsa.org/.well-known/assetlinks.json](https://librecorsa.org/.well-known/assetlinks.json), which Chrome validates before granting full-screen Trusted Web Activity (TWA) mode. You can verify any downloaded APK yourself using `apksigner` from the Android SDK Build-Tools:

```sh
apksigner verify --print-certs LibreCorsa-<version>-android.apk
```

The output should match the same digest in lowercase without colons:

```
Signer #1 certificate SHA-256 digest: e0c129357969c083b6c619ef28f7111bb63e6b9105fa913189573757586cfe29
```

> `keytool -printcert -jarfile` will not work on this APK, because it uses modern APK Signature Schemes rather than legacy JAR signing.

Android also enforces signature consistency on upgrades and refuses to install an APK signed with a different key over an existing installation.

## Windows and macOS security warnings

The desktop app isn't signed by Apple, nor yet for Windows:

- **Windows:** signing `LibreCorsa.exe` through the [SignPath Foundation](https://signpath.org) is being set up. Until it is in place, SmartScreen shows an unrecognized-app warning on first launch: click **More info**, then **Run anyway**.
- **macOS:** the app has no Apple Developer ID and isn't notarised, so Gatekeeper stops it the first time. Open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to LibreCorsa.
