/**
 * App download catalog and visitor platform detection (src/lib/downloads.ts): every platform has valid URLs,
 * Android UA is never misclassified as Linux, iOS gets no desktop/APK recommendation, macOS distinguishes Intel
 * from Apple Silicon via UA-CH, and visitor ordering puts the matching platform first without dropping any others.
 *
 *   npx tsx scripts/verify-downloads.ts
 */
import {
  APP_RELEASE,
  PLATFORM_DOWNLOADS,
  artifactHref,
  detectVisitorPlatform,
  formatDownloadSize,
  orderPlatformsForVisitor,
  platformIdOf,
} from "../src/lib/downloads";

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
        const href = artifactHref(a);
        return href.startsWith("https://github.com/KhazP/librecorsa/releases/") && !href.includes("undefined");
      }),
  ),
);
check(
  "Direct artifacts point to the current release tag",
  PLATFORM_DOWNLOADS.flatMap((p) => p.artifacts)
    .filter((a) => a.file !== null)
    .every((a) => artifactHref(a) === `https://github.com/KhazP/librecorsa/releases/download/${APP_RELEASE.tag}/${a.file}`),
);
check(
  "Unpublished artifacts fall back to the latest release page (no 404)",
  artifactHref({ id: "t", label: "Download .apk", detail: "Android", file: null, sizeBytes: null }) === APP_RELEASE.latestReleasesUrl,
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
