LibreCorsa as a desktop app: the game runs from this computer, with no network needed, opens in its own window, and converts circuits and cars from other games into mods. Built by GitHub Actions from this tag's source (`.github/workflows/release-launcher.yml`).

## Downloads
- **macOS (Apple Silicon):** `LibreCorsa-*-mac-arm64.dmg` (or the `.zip`)
- **macOS (Intel):** `LibreCorsa-*-mac-x64.dmg` (or the `.zip`)
- **Windows (x64):** `LibreCorsa-*-win-x64.zip`
- **Linux (x64):** `LibreCorsa-*-linux-x64.tar.gz`

`launcher-latest.json` and its `.sig` are for the app itself: it checks for a newer release, and installs one only when its signature matches the key built into the app.

## Installing
- **macOS:** open the `.dmg` and drag LibreCorsa to Applications. The app isn't notarised yet (no Apple Developer ID), so the first time macOS says it can't check it: open **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to LibreCorsa (on macOS 14 and older, right-click the app and choose **Open**). Or run `xattr -dr com.apple.quarantine /Applications/LibreCorsa.app`. macOS then asks once to let LibreCorsa use Documents, where your mods go.
- **Windows:** unzip the folder anywhere you can write to (not Program Files), and run `LibreCorsa.exe`. If SmartScreen stops it, click **More info**, then **Run anyway**.
- **Linux:** unpack the folder anywhere and run `librecorsa`; it adds LibreCorsa to your app menu.

The game opens in Chrome, Edge, Brave or Chromium when one is installed (wheels, pedals and pads need one), else in your default browser. Closing the game's window quits the app.

## Your files
Mods and the circuits and cars to convert are in **Documents/LibreCorsa** (`mods/`, `import/`); the Mods panel's **Open folder** buttons take you there. Saves live in the app's own browser profile and stay through updates.

## Updates
The app checks this repository's releases every few hours when online, downloads a newer one in the background, and offers **Restart to update** on the title screen (or installs it the next time it starts). If an update can't be installed, the app keeps its version.

## Code signing policy
Free Windows code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). Who builds, reviews and approves releases, and what the app sends, is in the [code signing policy](https://github.com/librecorsa/librecorsa#code-signing-policy).
