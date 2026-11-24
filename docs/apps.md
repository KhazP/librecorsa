# LibreCorsa apps

Two apps besides the website: the desktop app for Windows, macOS and Linux, and the Android app. The Android app wraps the live site (`https://librecorsa.org/play`) instead of bundling game assets, which keeps site updates instant while letting players install LibreCorsa from an app store. The desktop app serves the live site on the player's computer and keeps what it loads, so it also plays offline, and it takes mods.

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
# export LIBRECORSA_ANDROID_VERSION_NAME=0.2.4
# export LIBRECORSA_ANDROID_VERSION_CODE=204

./gradlew assembleRelease --no-daemon   # signed APK -> android/app/build/outputs/apk/release/app-release.apk
./gradlew bundleRelease --no-daemon     # signed AAB -> android/app/build/outputs/bundle/release/app-release.aab
```

With any of the four signing variables unset, Gradle still builds an unsigned release artifact (useful for CI compilation checks, though Android refuses to install unsigned APKs). Verify a signed APK locally with:

```bash
"$(ls -1 "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -n 1)" \
  verify --verbose --print-certs android/app/build/outputs/apk/release/app-release.apk
```

### Tag-based CI release

`.github/workflows/release-android.yml` builds the signed APK and publishes it on its own GitHub Release when I push an `android-v*` tag:

```bash
git tag android-v0.2.4
git push origin android-v0.2.4
```

- It derives `versionName` and a monotonic `versionCode` (`MAJOR*10000 + MINOR*100 + PATCH`) from the tag. A new tag must be newer than the last APK released, or phones refuse it as an update: the APKs that came with the old desktop releases count too, up to `desktop-v0.2.3`'s 0.2.3 (versionCode 203).
- It signs `LibreCorsa-<version>-android.apk` when the four Android signing secrets are set (`LIBRECORSA_ANDROID_KEYSTORE_BASE64`, `LIBRECORSA_ANDROID_KEYSTORE_PASSWORD`, `LIBRECORSA_ANDROID_KEY_ALIAS`, `LIBRECORSA_ANDROID_KEY_PASSWORD`) and verifies the signature with `apksigner`. Without them it still checks the build compiles, warns, and a tag run fails rather than publish a release with no APK.
- The release is created with `--latest=false`: the repository's latest release is always the desktop app's, which installed desktop apps update from (`launcher/update.go`).
- A manual run (Actions tab, or `gh workflow run release-android.yml --ref <branch> -f version=0.2.4`) builds and signs but never publishes; the APK is in the run's `android-apk` artifact.
- After publishing, update `ANDROID_RELEASE` and the Android entry of `PLATFORM_DOWNLOADS` in `src/lib/downloads.ts` (tag, version, date, the APK's name and size) so `librecorsa.org/download` and the home hub's Download tab point at it.

### Play Store release notes (optional / later)

- Google Play registration costs $25 once.
- New personal developer accounts must complete a closed test with opted-in testers (12 testers for 14 days) before Google enables production release access.

## Desktop

The desktop app is the launcher in `launcher/`: a Go program that serves the live site on `127.0.0.1`, keeping what it fetches for offline play, with the game's static export bundled beside it, opens the game in Chrome, Edge, Brave or Chromium as an app window, takes mods, converts other games' circuits and cars, and updates itself from Ed25519-signed releases. [launcher/README.md](../launcher/README.md) covers running it, its folders, packaging (`npm run launcher:build -- --bundle`), and `.github/workflows/release-launcher.yml`, which makes a release from a `launcher-v*` tag and signs `LibreCorsa.exe` through SignPath Foundation (the artifact configuration `launcher`; `SIGNPATH_SIGN_RELEASES` turns release signing on).

After publishing a launcher release, update `DESKTOP_RELEASE` in `src/lib/downloads.ts` (`published`, `date`, and each desktop file's `sizeBytes`; for a later release the tag and version too) so the download page links the files.

### Windows signing through SignPath

SignPath Foundation signs `LibreCorsa.exe` for free (organization LibreCorsa [OSS], project `librecorsa`). The Windows job builds the launcher's folder unpacked, uploads `LibreCorsa.exe` as the `signpath-unsigned-launcher` artifact, puts the signed one back, and only then packs the zip, so the update manifest's SHA-256 is the signed archive's.

- **Setup**: the repository secret `SIGNPATH_API_TOKEN` holds the API token of SignPath's "CI builds" user, and the Actions settings allow `signpath/github-action-submit-signing-request`. The artifact configuration `launcher` in SignPath is a `<zip-file>` holding one `<pe-file path="LibreCorsa.exe" product-name="LibreCorsa" product-version="${version}">` with `<authenticode-sign/>`. SignPath Foundation requires those product name and version restrictions; the workflow passes `version` as the launcher's version resource has it (`MAJOR.MINOR.PATCH.0`).
- **Test signing**: run "Release Launcher" by hand (Actions tab, or `gh workflow run release-launcher.yml --ref <branch> -f signing_policy=test-signing`). A manual run builds and signs with SignPath's self-signed test certificate and never publishes a release. The signed app is in the run's `launcher-win` artifact.
- **Release signing**: once SignPath has imported the production certificate, set the repository variable `SIGNPATH_SIGN_RELEASES` to `true`. From then on every `launcher-v*` tag waits for me to approve the signing request in SignPath (up to an hour) before the release is published. While the variable is unset, tag builds ship unsigned.

### The retired Electron app

Until November 2026 the desktop app was an Electron wrapper in `desktop/` (app id `org.librecorsa.desktop`) that opened `https://librecorsa.org/play` and updated itself with `electron-updater` from `desktop-v*` releases. Its last version, `desktop-v0.2.3`, stops checking for updates and points players to the new app; the folder and its workflow (`release-desktop.yml`) were removed after it. The game still recognises Electron in the user agent, since installed copies keep opening the site and sign in to accounts with a code.
