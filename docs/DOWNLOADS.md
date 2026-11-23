# Checking a download

The game runs in the browser, so you don't need to download anything. The desktop and Android apps open the same site with a few extras: wheels and controllers without a permission prompt on desktop, and fullscreen on Android.

## Where the apps come from

I only publish them in two places:

- [librecorsa.org/download](https://librecorsa.org/download)
- [GitHub Releases](https://github.com/librecorsa/librecorsa/releases), where the download page's links point

The desktop app checks the same GitHub releases for updates. A copy from anywhere else isn't mine, even if it has the name and the logo.

## App IDs

| App | ID |
|---|---|
| Android | `org.librecorsa.app` |
| Windows, macOS and Linux | `org.librecorsa.desktop` |
| Installed from the browser | `https://librecorsa.org/play` (the web app manifest's `id`) |

## Checking a file

Every file on a GitHub release lists its SHA-256 next to it. Compare it with the file you downloaded:

```sh
# macOS and Linux
shasum -a 256 LibreCorsa-<version>-android.apk
```

```powershell
# Windows (PowerShell)
Get-FileHash .\LibreCorsa-<version>-win-x64-Setup.exe
```

## Android signing key

I sign the Android app with one key. Its certificate's SHA-256 fingerprint is:

```
E0:C1:29:35:79:69:C0:83:B6:C6:19:EF:28:F7:11:1B:B6:3E:6B:91:05:FA:91:31:89:57:37:57:58:6C:FE:29
```

The site publishes the same fingerprint at [librecorsa.org/.well-known/assetlinks.json](https://librecorsa.org/.well-known/assetlinks.json). Chrome checks it there before it opens the app fullscreen. To check an APK yourself, use `apksigner` from the Android SDK build tools:

```sh
apksigner verify --print-certs LibreCorsa-<version>-android.apk
```

It prints the same fingerprint in lower case without the colons:

```
Signer #1 certificate SHA-256 digest: e0c129357969c083b6c619ef28f7111bb63e6b9105fa913189573757586cfe29
```

(`keytool -printcert -jarfile` won't work here: the APK only carries the newer APK signature, not the old JAR one.)

Android also refuses to install an update signed with a different key over the app you already have.

## Windows and macOS warnings

The Windows and macOS builds aren't code-signed yet. Windows signing is being set up through the SignPath Foundation. Until then, Windows SmartScreen shows a warning on the first run (click More info, then Run anyway), and macOS asks you to allow the app in System Settings > Privacy & Security.
