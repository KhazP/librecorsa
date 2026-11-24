/**
 * App download catalog and visitor platform detection (src/lib/downloads.ts): every platform has valid URLs from its
 * own release (the desktop app's for Windows, macOS and Linux, the Android app's), an unpublished release never links
 * a file (no 404), Android UA is never misclassified as Linux, iOS gets no desktop/APK recommendation, macOS distinguishes Intel
 * from Apple Silicon via UA-CH, and visitor ordering puts the matching platform first without dropping any others.
 *
 *   npx tsx scripts/verify/verify-downloads.ts
 */
import {
  ANDROID_RELEASE,
  DESKTOP_RELEASE,
  PLATFORM_DOWNLOADS,
  RELEASE_LINKS,
  artifactHref,
  detectVisitorPlatform,
  formatDownloadSize,
  isDirectDownload,
  orderPlatformsForVisitor,
  platformIdOf,
  releasePageUrl,
  type AppRelease,
  type DownloadArtifact,
} from "../../src/lib/downloads";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failed++;
}

// --- Catalog integrity ---
const ids = PLATFORM_DOWNLOADS.map((p) => p.id);
check("Catalog lists Windows, macOS, Linux and Android", JSON.stringify(ids) === '["windows","macos","linux","android"]', JSON.stringify(ids));
check(
  "Every platform has at least one artifact with a valid GitHub URL",
  PLATFORM_DOWNLOADS.every(
    (p) =>
      p.artifacts.length > 0 &&
      p.artifacts.every((a) => {
        const href = artifactHref(a, p.release);
        return href.startsWith("https://github.com/librecorsa/librecorsa/releases") && !href.includes("undefined");
      }),
  ),
);
check(
  "Windows, macOS and Linux come from the desktop app's release, Android from its own",
  PLATFORM_DOWNLOADS.every((p) => p.release === (p.id === "android" ? ANDROID_RELEASE : DESKTOP_RELEASE)) &&
    DESKTOP_RELEASE !== ANDROID_RELEASE,
);
check(
  "The desktop app's release is a launcher-v tag of its version",
  DESKTOP_RELEASE.tag === `launcher-v${DESKTOP_RELEASE.version}` && ANDROID_RELEASE.tag.endsWith(`-v${ANDROID_RELEASE.version}`),
  `${DESKTOP_RELEASE.tag}, ${ANDROID_RELEASE.tag}`,
);
check(
  "Desktop files are named as launcher/build.mjs makes them",
  JSON.stringify(PLATFORM_DOWNLOADS.filter((p) => p.release === DESKTOP_RELEASE).flatMap((p) => p.artifacts.map((a) => a.file))) ===
    JSON.stringify(["win-x64.zip", "mac-arm64.dmg", "mac-x64.dmg", "linux-x64.tar.gz"].map((f) => `LibreCorsa-${DESKTOP_RELEASE.version}-${f}`)),
);
check(
  "A published release has its date; an unpublished one none",
  [DESKTOP_RELEASE, ANDROID_RELEASE].every((r) => (r.published ? /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "") : r.date === null)),
);
check(
  "Direct artifacts point to their own release's tag",
  PLATFORM_DOWNLOADS.every((p) =>
    p.artifacts
      .filter((a) => isDirectDownload(a, p.release))
      .every((a) => artifactHref(a, p.release) === `https://github.com/librecorsa/librecorsa/releases/download/${p.release.tag}/${a.file}`),
  ),
);
check(
  "Every artifact of an unpublished release links the releases page, never a file (no 404)",
  PLATFORM_DOWNLOADS.filter((p) => !p.release.published).every((p) =>
    p.artifacts.every((a) => !isDirectDownload(a, p.release) && artifactHref(a, p.release) === RELEASE_LINKS.allReleasesUrl),
  ),
);
const unpublished: AppRelease = { tag: "launcher-v9.9.9", version: "9.9.9", date: null, published: false };
const published: AppRelease = { tag: "launcher-v9.9.9", version: "9.9.9", date: "2026-12-01", published: true };
const someFile: DownloadArtifact = { id: "t", label: "Download .zip", detail: "Windows x64", file: "LibreCorsa-9.9.9-win-x64.zip", sizeBytes: null };
const noFile: DownloadArtifact = { ...someFile, file: null };
check(
  "An unpublished release links the releases page, for its files and its own page",
  artifactHref(someFile, unpublished) === RELEASE_LINKS.allReleasesUrl && releasePageUrl(unpublished) === RELEASE_LINKS.allReleasesUrl,
);
check(
  "Once published, a file links itself and a missing one the release's page",
  artifactHref(someFile, published) === "https://github.com/librecorsa/librecorsa/releases/download/launcher-v9.9.9/LibreCorsa-9.9.9-win-x64.zip" &&
    artifactHref(noFile, published) === "https://github.com/librecorsa/librecorsa/releases/tag/launcher-v9.9.9",
);

// --- Size formatting ---
check("121.68 MB formats to rounded MB", formatDownloadSize(121_681_020) === "122 MB", String(formatDownloadSize(121_681_020)));
check("1.36 MB formats with one decimal place", formatDownloadSize(1_360_000) === "1.4 MB", String(formatDownloadSize(1_360_000)));
check("Null or zero bytes returns null", formatDownloadSize(null) === null && formatDownloadSize(0) === null);

// --- Platform detection ---
check(
  "Android UA (which includes Linux) detects as android, not linux",
  detectVisitorPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/135.0.0.0 Mobile Safari/537.36") === "android",
);
check(
  "Windows UA detects as windows",
  detectVisitorPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36") === "windows",
);
check(
  "macOS Safari UA defaults to macos-arm64",
  detectVisitorPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15") === "macos-arm64",
);
check(
  "macOS with UA-CH x86 architecture detects as macos-x64",
  detectVisitorPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "macOS", "x86") === "macos-x64",
);
check(
  "macOS with UA-CH arm architecture detects as macos-arm64",
  detectVisitorPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "macOS", "arm") === "macos-arm64",
);
check(
  "Linux desktop UA detects as linux",
  detectVisitorPlatform("Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0") === "linux",
);
check(
  "iPhone and iPad UAs return null (no native iOS download)",
  detectVisitorPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1") === null &&
    detectVisitorPlatform("Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1") === null,
);
check(
  "ChromeOS UA returns null",
  detectVisitorPlatform("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36") === null,
);

// --- DOM ordering ---
check("platformIdOf maps macOS architectures to macos", platformIdOf("macos-arm64") === "macos" && platformIdOf("macos-x64") === "macos");
const androidFirst = orderPlatformsForVisitor(PLATFORM_DOWNLOADS, "android").map((p) => p.id);
check(
  "Android visitor gets Android first and keeps all 4 platforms",
  JSON.stringify(androidFirst) === '["android","windows","macos","linux"]',
  JSON.stringify(androidFirst),
);
const unknownOrder = orderPlatformsForVisitor(PLATFORM_DOWNLOADS, null).map((p) => p.id);
check(
  "Unknown visitor keeps default catalog order",
  JSON.stringify(unknownOrder) === '["windows","macos","linux","android"]',
  JSON.stringify(unknownOrder),
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll download catalog & detection checks passed.");
