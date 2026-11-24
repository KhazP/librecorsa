# Verifying downloads

LibreCorsa runs directly in your browser with nothing to install. Optional native wrappers for desktop and Android load the same live site while adding platform conveniences: silent WebHID access for wheels and DualSense controllers on desktop, and full-screen immersive mode on Android.

## Official sources

Official builds are published in only two places:

- [librecorsa.org/download](https://librecorsa.org/download)
- [GitHub Releases](https://github.com/librecorsa/librecorsa/releases) (where the download page links point)

The desktop wrapper checks the same GitHub Releases feed for updates. Builds hosted anywhere else are unofficial, even if they carry the LibreCorsa name and logo.

## App IDs

| Platform | Identifier |
| :-- | :-- |
| Android | `org.librecorsa.app` |
| Windows, macOS, and Linux | `org.librecorsa.desktop` |
| Browser install (PWA) | `https://librecorsa.org/play` (web app manifest `id`) |

## Verifying file checksums

Every asset on a GitHub release lists its SHA-256 checksum alongside the download. Compare it against your local file:

```sh
# macOS and Linux
shasum -a 256 LibreCorsa-<version>-android.apk
```

```powershell
# Windows (PowerShell)
Get-FileHash .\LibreCorsa-<version>-win-x64-Setup.exe
```

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

Desktop builds for Windows and macOS are not yet code-signed (Windows code signing is currently being set up through the SignPath Foundation). Until signing is in place:

- **Windows:** SmartScreen displays an unrecognized-app warning on first launch—click **More info**, then **Run anyway**.
- **macOS:** Gatekeeper blocks the unsigned app on first launch—allow it under **System Settings > Privacy & Security**.
