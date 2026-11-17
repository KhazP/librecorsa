# LibreCorsa native app wrappers

I wrap the live site (`https://librecorsa.org/play`) instead of bundling game assets into the apps. That keeps site updates instant while letting players install LibreCorsa from app stores or run it on desktop with hardware access that browsers restrict.

## Android (Trusted Web Activity)

The Android wrapper lives in `android/` (package id `org.librecorsa.app`, `minSdkVersion` 24) and opens `https://librecorsa.org/play` inside Chrome as a Trusted Web Activity.

### Signing key

I generated the upload keystore outside the repository at `~/Documents/GitHub/_android-signing/librecorsa-upload.jks` (alias `upload`), with its passwords stored beside it in `keystore-passwords.txt`. I never commit either file. Losing this keystore blocks app updates on Google Play unless I go through Play App Signing key reset support.

### Digital Asset Links

Chrome only hides the URL bar once `https://librecorsa.org/.well-known/assetlinks.json` is live with `Content-Type: application/json` (configured in `public/_headers`).

- Before deploy, Chrome shows a custom tab URL bar for `librecorsa.org`.
- After uploading `android/app-release-bundle.aab` to Google Play with Play App Signing enabled, I must copy Google's App Signing certificate SHA-256 from Play Console (Setup -> App signing) and add it to `sha256_cert_fingerprints` in `public/.well-known/assetlinks.json` alongside the upload key fingerprint, then redeploy the site. Otherwise Play Store installs will fall back to showing the URL bar.

### Build

On macOS, Bubblewrap expects `~/.bubblewrap/config.json` with a `jdkPath` pointing to the `.jdk` bundle root (without `/Contents/Home`) and an `androidSdkPath` directory containing platform-tools and build-tools.

```bash
cd android
export BUBBLEWRAP_KEYSTORE_PASSWORD=...
export BUBBLEWRAP_KEY_PASSWORD=...
npx @bubblewrap/cli build \
  --signingKeyPath ~/Documents/GitHub/_android-signing/librecorsa-upload.jks \
  --signingKeyAlias upload
```

This writes `android/app-release-bundle.aab` (upload to Google Play) and `android/app-release-signed.apk` (install directly via `adb install -r` for testing). Both files are git-ignored.

### Play Store release notes

- Google Play registration costs $25 once.
- New personal developer accounts must complete a closed test with opted-in testers (12 testers for 14 days) before Google enables production release access.

## Desktop (Electron)

The desktop wrapper lives in `desktop/` with its own `package.json` and exact pinned `electron` version. Keeping Chromium up to date by bumping that pinned Electron version is important because the app loads a live remote website.

What the wrapper adds over a browser:

- Requests the discrete GPU on multi-GPU laptops (`force_high_performance_gpu`).
- Disables `backgroundThrottling` so telemetry and timers do not stall if unfocused.
- Grants WebHID silently for DualSense controllers and racing wheels on `https://librecorsa.org` without a device picker prompt, while keeping keyboards, mice, security keys, and other origins blocked.
- Enforces `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload API, in-app navigation restricted to `https://librecorsa.org`, and external links routed to the system browser.
- Opens in a 90% work-area window with `F11` to toggle fullscreen.
- Checks GitHub Releases via `electron-updater` on startup when packaged.

### Local run, test, and build

```bash
cd desktop
npm ci
npm run check   # syntax checks and unit tests for navigation + WebHID policy
npm start       # launch against https://librecorsa.org/play
```

To build unsigned installers locally:

```bash
cd desktop
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac    # arm64 + x64 .dmg and .zip
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win    # x64 NSIS .exe
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:linux  # x64 AppImage
```

Outputs land in `desktop/dist/` (git-ignored). I still need to test `.exe` on Windows and `.AppImage` on Linux because cross-building from macOS packages those binaries without running them on the target OSes.

### Tag-based CI release

`.github/workflows/release-desktop.yml` builds macOS, Windows, and Linux installers only when I push a `desktop-v*` tag (pushing to `main` only deploys the site):

```bash
# Update desktop/package.json version if desired, commit on main, then tag:
git tag desktop-v0.2.0
git push origin desktop-v0.2.0
```

All three jobs attach installers, `.blockmap` files, and `latest*.yml` manifests to that `desktop-v*` GitHub Release.

### Code signing and OS warnings

The builds are configured for signing and notarization via environment variables, but currently ship unsigned:

- **Windows**: Without Authenticode signing, Microsoft Defender SmartScreen shows "Windows protected your PC" on first run until reputation builds or the binary is signed. Signing options include Azure Trusted Signing (around $9.99/month for eligible entities), a commercial OV/EV code-signing certificate, or free open-source signing through SignPath Foundation.
- **macOS**: Without an Apple Developer ID Application certificate and notarization ($99/year Apple Developer Program), macOS Gatekeeper blocks downloaded `.dmg`/`.app` files until the user overrides it in System Settings -> Privacy & Security (or strips quarantine). In-app auto-update via `MacUpdater` (Squirrel.Mac) also requires macOS builds to be signed.
- **Linux**: AppImage works without code signing (`chmod +x` and run, with FUSE2 / `libfuse2` installed on older distros).

To enable CI signing later, add repository secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (macOS), and `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (Windows).

### Windows signing through SignPath

SignPath Foundation signs the Windows installer for free (organization LibreCorsa [OSS], project `librecorsa`). The Windows job uploads the unsigned `*-Setup.exe` as the `signpath-unsigned-win` artifact, SignPath signs it, and `desktop/scripts/refresh-update-info.js` rebuilds the installer's `.blockmap` and its `latest.yml` entry from the signed file, because signing changes the bytes the auto-updater checks.

- **Setup**: the repository secret `SIGNPATH_API_TOKEN` holds the API token of SignPath's "CI builds" user, and the Actions settings allow `signpath/github-action-submit-signing-request`. The artifact configuration in SignPath is a `<zip-file>` holding one `<pe-file path="LibreCorsa-*-win-x64-Setup.exe">` with `<authenticode-sign/>`.
- **Test signing**: run "Release Desktop App" by hand (Actions tab, or `gh workflow run release-desktop.yml --ref <branch> -f signing_policy=test-signing`). A manual run builds and signs with SignPath's self-signed test certificate and never publishes a release. The signed installer is in the run's `desktop-win` artifact.
- **Release signing**: once SignPath has imported the production certificate, set the repository variable `SIGNPATH_SIGN_RELEASES` to `true`. From then on every `desktop-v*` tag waits for me to approve the signing request in SignPath (up to an hour) before the release is published. While the variable is unset, tag builds ship unsigned as before.

Only the installer is signed. SignPath can't open an NSIS installer to sign the app inside it, so `LibreCorsa.exe` and the uninstaller stay unsigned.
