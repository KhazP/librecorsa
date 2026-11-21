App versions of LibreCorsa that open the live site at https://librecorsa.org/play, so they stay as current as the site. Built by GitHub Actions from this tag's source (`.github/workflows/release-desktop.yml`).

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
Free Windows code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). Windows signing is being set up. Who builds, reviews and approves releases, and what the app sends, is in the [code signing policy](https://github.com/KhazP/librecorsa#code-signing-policy).
