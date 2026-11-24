The last version of the LibreCorsa app that opens the live site at https://librecorsa.org/play. LibreCorsa has a new desktop app, which plays offline too and takes mods: get it at https://librecorsa.org/download. Built by GitHub Actions from this tag's source (`.github/workflows/release-desktop.yml`).

## What's in it
- When the game has loaded, the app tells you about the new one: **Get the new app** opens the download page in your browser, **Later** asks again in 3 days.
- It no longer looks for updates: this app gets none after this one.
- Your laps and settings come with you when you sign in to your account in both apps. The new app signs in with a code: in this one, open **Settings**, then **Profile and data**, then **Account**, and choose **Show a code for another device**.

Copies already installed update to this version by themselves. The Android app carries on as before.

## Downloads
- **Windows (x64):** `LibreCorsa-*-win-x64-Setup.exe`
- **macOS (Apple Silicon):** `LibreCorsa-*-mac-arm64.dmg`
- **macOS (Intel):** `LibreCorsa-*-mac-x64.dmg`
- **Linux (x64):** `LibreCorsa-*-linux-x86_64.AppImage`
- **Android (APK):** `LibreCorsa-*-android.apk` (Android 7+, Chrome required for fullscreen TWA)

## Opening builds
- **Windows:** unsigned for now — if SmartScreen stops it, click **More info**, then **Run anyway**.
- **macOS:** unsigned — allow it in System Settings > Privacy & Security, or run `xattr -cr /Applications/LibreCorsa.app`.
- **Linux:** run `chmod +x` on the AppImage, then open it (needs FUSE2 / `libfuse2`).
- **Android:** signed APK — allow installing from your browser when prompted. It verifies against `librecorsa.org/.well-known/assetlinks.json` and opens fullscreen with no URL bar.

## Code signing policy
Free Windows code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). Windows signing is being set up. Who builds, reviews and approves releases, and what the app sends, is in the [code signing policy](https://github.com/librecorsa/librecorsa#code-signing-policy).
