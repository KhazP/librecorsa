# LibreCorsa native app wrappers

I wrap the live site (`https://librecorsa.org/play`) instead of bundling game assets into the apps. That keeps site updates instant while letting players install LibreCorsa from app stores or run it on desktop with hardware access that browsers restrict.

## Android (Trusted Web Activity)

The Android wrapper lives in `android/` (package id `org.librecorsa.app`, `minSdkVersion` 24) and opens `https://librecorsa.org/play` inside Chrome as a Trusted Web Activity.

### Signing key

I generated the upload keystore outside the repository at `~/Documents/GitHub/_android-signing/librecorsa-upload.jks` (alias `upload`), with its passwords stored beside it in `keystore-passwords.txt`. I never commit either file. Losing this keystore blocks app updates on Google Play unless I go through Play App Signing key reset support.

### Digital Asset Links

Chrome only hides the URL bar once `https://librecorsa.org/.well-known/assetlinks.json` is live with `Content-Type: application/json` (configured in `public/_headers`).

- For **direct APK installs** (from GitHub Releases or `librecorsa.org/download`), `public/.well-known/assetlinks.json` already carries the upload keystore's SHA-256, so signed APKs verify and open fullscreen with no URL bar immediately.
- If/when uploading `android/app/build/outputs/bundle/release/app-release.aab` to **Google Play** with Play App Signing enabled, copy Google's App Signing certificate SHA-256 from Play Console (Setup -> App signing) and add it to `sha256_cert_fingerprints` in `public/.well-known/assetlinks.json` alongside the upload key fingerprint, then redeploy the site. Otherwise Play Store installs will fall back to showing the URL bar.

### Build

`android/app/build.gradle` reads release signing and optional version overrides from environment variables so no secret lives in the repository. (Avoid running `npx @bubblewrap/cli update`, which would overwrite the manual changes in `AndroidManifest.xml`, `LauncherActivity.java` and `build.gradle`.)

```bash
cd android
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
export ANDROID_HOME="$HOME/.bubblewrap/android-sdk"
export LIBRECORSA_ANDROID_KEYSTORE="$HOME/Documents/GitHub/_android-signing/librecorsa-upload.jks"
export LIBRECORSA_ANDROID_KEY_ALIAS="upload"
export LIBRECORSA_ANDROID_KEYSTORE_PASSWORD=...
export LIBRECORSA_ANDROID_KEY_PASSWORD=...
# Optional tag/release version overrides (defaults: 0.2.0 / versionCode 2):
# export LIBRECORSA_ANDROID_VERSION_NAME=0.2.2
# export LIBRECORSA_ANDROID_VERSION_CODE=202

./gradlew assembleRelease --no-daemon   # signed APK -> android/app/build/outputs/apk/release/app-release.apk
./gradlew bundleRelease --no-daemon     # signed AAB -> android/app/build/outputs/bundle/release/app-release.aab
```

With any of the four signing variables unset, Gradle still builds an unsigned release artifact (useful for CI compilation checks, though Android refuses to install unsigned APKs). Verify a signed APK locally with:

```bash
"$(ls -1 "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -n 1)" \
  verify --verbose --print-certs android/app/build/outputs/apk/release/app-release.apk
```

### Play Store release notes (optional / later)

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

### Tag-based CI release (Windows, macOS, Linux and Android together)

`.github/workflows/release-desktop.yml` builds macOS, Windows, Linux installers **and** the signed Android APK into a single GitHub Release when I push a `desktop-v*` tag (keeping all platforms on one Latest release so desktop `electron-updater` always finds `latest*.yml`):

```bash
# Update desktop/package.json version if desired, commit on main, then tag:
git tag desktop-v0.2.2
git push origin desktop-v0.2.2
```

- The desktop jobs attach `.exe`, `.dmg`, `.zip`, `.AppImage`, `.blockmap` and `latest*.yml` files.
- The `build-android` job derives `versionName` and a monotonic `versionCode` (`MAJOR*10000 + MINOR*100 + PATCH`) from the tag, signs `LibreCorsa-<version>-android.apk` when the four Android signing secrets are set (`LIBRECORSA_ANDROID_KEYSTORE_BASE64`, `LIBRECORSA_ANDROID_KEYSTORE_PASSWORD`, `LIBRECORSA_ANDROID_KEY_ALIAS`, `LIBRECORSA_ANDROID_KEY_PASSWORD`), and verifies the signature with `apksigner` before attaching it. If those secrets are unset, the job still verifies compilation and skips uploading an un-installable unsigned APK.
- After publishing a tag, update `APP_RELEASE` and `PLATFORM_DOWNLOADS` in `src/lib/downloads.ts` so `librecorsa.org/download` and the home hub's Download tab point directly at the new release's assets.

### Code signing and OS warnings

The builds are configured for signing and notarization via environment variables, but currently ship unsigned:

- **Windows**: Without Authenticode signing, Microsoft Defender SmartScreen shows "Windows protected your PC" on first run until reputation builds or the binary is signed. Signing options include Azure Trusted Signing (around $9.99/month for eligible entities), a commercial OV/EV code-signing certificate, or free open-source signing through SignPath Foundation.
- **macOS**: Without an Apple Developer ID Application certificate and notarization ($99/year Apple Developer Program), macOS Gatekeeper blocks downloaded `.dmg`/`.app` files until the user overrides it in System Settings -> Privacy & Security (or strips quarantine). In-app auto-update via `MacUpdater` (Squirrel.Mac) also requires macOS builds to be signed.
- **Linux**: AppImage works without code signing (`chmod +x` and run, with FUSE2 / `libfuse2` installed on older distros).

To enable CI signing later, add repository secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (macOS), and `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (Windows).

### Windows signing through SignPath

SignPath Foundation signs the Windows installer for free (organization LibreCorsa [OSS], project `librecorsa`). The Windows job uploads the unsigned `*-Setup.exe` as the `signpath-unsigned-win` artifact, SignPath signs it, and `desktop/scripts/refresh-update-info.js` rebuilds the installer's `.blockmap` and its `latest.yml` entry from the signed file, because signing changes the bytes the auto-updater checks.

- **Setup**: the repository secret `SIGNPATH_API_TOKEN` holds the API token of SignPath's "CI builds" user, and the Actions settings allow `signpath/github-action-submit-signing-request`. The artifact configuration in SignPath is a `<zip-file>` holding one `<pe-file path="LibreCorsa-*-win-x64-Setup.exe" product-name="LibreCorsa" product-version="${version}">` with `<authenticode-sign/>`. SignPath Foundation requires those product name and version restrictions, and the workflow passes `version` (from `desktop/package.json`, synced from the tag) as a parameter.
- **Test signing**: run "Release Apps" by hand (Actions tab, or `gh workflow run release-desktop.yml --ref <branch> -f signing_policy=test-signing`). A manual run builds and signs with SignPath's self-signed test certificate and never publishes a release. The signed installer is in the run's `desktop-win` artifact.
- **Release signing**: once SignPath has imported the production certificate, set the repository variable `SIGNPATH_SIGN_RELEASES` to `true`. From then on every `desktop-v*` tag waits for me to approve the signing request in SignPath (up to an hour) before the release is published. While the variable is unset, tag builds ship unsigned as before.

Only the installer is signed. `LibreCorsa.exe` inside it is Electron's prebuilt binary, and SignPath Foundation's terms only allow signing binaries built from the project's own source, and they explicitly allow unsigned upstream binaries inside a signed installer. The uninstaller stays unsigned too.
