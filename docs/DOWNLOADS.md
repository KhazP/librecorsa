# Verifying downloads

LibreCorsa runs directly in your browser with nothing to install. There are two apps besides:

- **The desktop app** for Windows, macOS and Linux. It serves the game on your own computer and keeps every page, car and circuit it loads, so it plays the live game from librecorsa.org when you're online and what it kept when you're not. It opens the game in its own window in Chrome, Edge, Brave or Chromium (wheels, pedals and pads need one of those), takes mods from `Documents/LibreCorsa/mods`, converts circuits and cars from other games into mods, and updates itself.
- **The Android app**, which opens the live site full-screen, with no browser bar.

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
