import { text as t } from "@/lib/text";
import { REPO_URL } from "./site";

/**
 * The apps' downloads, each app from its own GitHub release:
 * - the desktop app for Windows, macOS and Linux (launcher/): a launcher-v* release, made by
 *   .github/workflows/release-launcher.yml with the files launcher/build.mjs names. It is the repository's latest
 *   release, which installed copies update themselves from.
 * - the Android app (android/): an android-v* release, made by .github/workflows/release-android.yml and never marked
 *   latest.
 *
 * A link only ever goes to a file that is there: until a release is out (`published: false`) its buttons go to the
 * releases page, and a file a release doesn't have (`file: null`) to that release's page. Never a dead 404 link.
 */

export type PlatformId = "windows" | "macos" | "linux" | "android";
export type DetectedPlatform = "windows" | "macos-arm64" | "macos-x64" | "linux" | "android" | null;

export interface AppRelease {
  /** The release's tag, such as launcher-v0.3.0 */
  tag: string;
  /** The version in its file names */
  version: string;
  /** YYYY-MM-DD, or null while it isn't out */
  date: string | null;
  /** Whether the release is out on GitHub: until it is, its links go to the releases page */
  published: boolean;
}

export interface DownloadArtifact {
  id: string;
  /** Visible button text (starts with the action/target so WCAG 2.5.3 Label in Name holds cleanly) */
  label: string;
  /** Architecture or format note shown alongside size */
  detail: string;
  /** Asset filename on GitHub Releases, or null when the release doesn't have it */
  file: string | null;
  /** Exact asset size in bytes, or null when not known yet */
  sizeBytes: number | null;
}

export interface PlatformDownload {
  id: PlatformId;
  name: string;
  /** The release its files come from */
  release: AppRelease;
  summary: string;
  /** Short honest note on opening/installing the build */
  installNote: string;
  /** Optional terminal command shown in <code> inside the note */
  installCommand?: string;
  /** Whether the published build carries a trusted signature */
  signed: boolean;
  /** Short badge word when signed/unsigned status should be called out */
  statusLabel: string;
  artifacts: readonly DownloadArtifact[];
}

/**
 * The desktop app's release. launcher-v0.3.0 is its first: until it is out the Windows, macOS and Linux buttons go to
 * the releases page. After it is published, set `published: true` and `date`, and fill in each desktop file's
 * `sizeBytes` from the release (`gh release view launcher-v0.3.0 --json assets`). For a later release, change `tag`,
 * `version` and `date` (the file names follow `version`), then the sizes.
 */
export const DESKTOP_RELEASE: AppRelease = {
  tag: "launcher-v0.3.0",
  version: "0.3.0",
  date: null,
  published: false,
};

/**
 * The Android app's release. Its APK is still the one released with desktop-v0.2.2, the Electron app's release, which
 * carried the APK too. For an android-v* release, change `tag`, `version`, `date`, and the APK's file name and size.
 */
export const ANDROID_RELEASE: AppRelease = {
  tag: "desktop-v0.2.2",
  version: "0.2.2",
  date: "2026-11-23",
  published: true,
};

export const RELEASE_LINKS = {
  allReleasesUrl: `${REPO_URL}/releases`,
  codeSigningPolicyUrl: `${REPO_URL}#code-signing-policy`,
} as const;

/** A desktop file's name, as launcher/build.mjs makes it: LibreCorsa-<version>-<platform>.<format> */
const desktopFile = (platform: string): string => `LibreCorsa-${DESKTOP_RELEASE.version}-${platform}`;

export const PLATFORM_DOWNLOADS: readonly PlatformDownload[] = [
  {
    id: "windows",
    name: "Windows",
    release: DESKTOP_RELEASE,
    get summary() { return t("game.downloads.desktopSummary"); },
    get installNote() { return t("game.downloads.windowsZipNote"); },
    signed: false,
    get statusLabel() { return t("game.downloads.windowsStatusLabel"); },
    artifacts: [
      {
        id: "windows-x64",
        get label() { return t("game.downloads.windowsZipLabel"); },
        get detail() { return t("game.downloads.windowsZipDetail"); },
        file: desktopFile("win-x64.zip"),
        sizeBytes: null,
      },
    ],
  },
  {
    id: "macos",
    name: "macOS",
    release: DESKTOP_RELEASE,
    get summary() { return t("game.downloads.desktopSummary"); },
    get installNote() { return t("game.downloads.macosDmgNote"); },
    signed: false,
    get statusLabel() { return t("game.downloads.macosStatusLabel"); },
    artifacts: [
      {
        id: "macos-arm64",
        get label() { return t("game.downloads.macosArm64Label"); },
        get detail() { return t("game.downloads.macosArm64Detail"); },
        file: desktopFile("mac-arm64.dmg"),
        sizeBytes: null,
      },
      {
        id: "macos-x64",
        get label() { return t("game.downloads.macosX64Label"); },
        get detail() { return t("game.downloads.macosX64Detail"); },
        file: desktopFile("mac-x64.dmg"),
        sizeBytes: null,
      },
    ],
  },
  {
    id: "linux",
    name: "Linux",
    release: DESKTOP_RELEASE,
    get summary() { return t("game.downloads.desktopSummary"); },
    get installNote() { return t("game.downloads.linuxTarNote"); },
    installCommand: `tar -xzf ${desktopFile("linux-x64.tar.gz")} && ./LibreCorsa/librecorsa`,
    signed: false,
    statusLabel: "tar.gz",
    artifacts: [
      {
        id: "linux-x64",
        get label() { return t("game.downloads.linuxTarLabel"); },
        get detail() { return t("game.downloads.linuxX64Detail"); },
        file: desktopFile("linux-x64.tar.gz"),
        sizeBytes: null,
      },
    ],
  },
  {
    id: "android",
    name: "Android",
    release: ANDROID_RELEASE,
    get summary() { return t("game.downloads.androidSummary"); },
    get installNote() { return t("game.downloads.androidInstallNote"); },
    signed: true,
    get statusLabel() { return t("game.downloads.androidStatusLabel"); },
    artifacts: [
      {
        id: "android-apk",
        get label() { return t("game.downloads.androidApkLabel"); },
        get detail() { return t("game.downloads.androidApkDetail"); },
        file: "LibreCorsa-0.2.2-android.apk",
        sizeBytes: 1_329_339,
      },
    ],
  },
];

/** A release's own page once it is out, else the releases page (never a dead 404 link) */
export function releasePageUrl(release: AppRelease): string {
  return release.published ? `${REPO_URL}/releases/tag/${release.tag}` : RELEASE_LINKS.allReleasesUrl;
}

/** Whether an artifact's button downloads the file itself: its release is out and has it */
export function isDirectDownload(artifact: DownloadArtifact, release: AppRelease): boolean {
  return release.published && artifact.file !== null;
}

/** The file on GitHub Releases when it is there, else the release's page or the releases page (releasePageUrl) */
export function artifactHref(artifact: DownloadArtifact, release: AppRelease): string {
  if (!isDirectDownload(artifact, release)) return releasePageUrl(release);
  return `${REPO_URL}/releases/download/${release.tag}/${artifact.file}`;
}

/** Human-readable decimal megabytes (121_681_020 → "122 MB", 1_430_000 → "1.4 MB") */
export function formatDownloadSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / 1e6;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Identify the visitor's platform for highlighting the matching download first.
 * Checks Android before Linux (Android UAs include "Linux") and returns null for iOS / unknown.
 */
export function detectVisitorPlatform(
  userAgent: string,
  uaDataPlatform?: string,
  uaDataArch?: string,
): DetectedPlatform {
  const ua = userAgent.toLowerCase();
  const platform = (uaDataPlatform ?? "").toLowerCase();
  const arch = (uaDataArch ?? "").toLowerCase();

  if (platform === "android" || ua.includes("android")) return "android";
  if (platform === "ios" || /iphone|ipad|ipod/.test(ua)) return null;
  if (platform === "windows" || ua.includes("windows")) return "windows";
  if (platform === "macos" || ua.includes("macintosh") || ua.includes("mac os x")) {
    if (arch === "x86" || arch === "x86_64" || arch === "amd64") return "macos-x64";
    return "macos-arm64";
  }
  if (platform === "chrome os" || ua.includes("cros")) return null;
  if (platform === "linux" || (ua.includes("linux") && !ua.includes("android"))) return "linux";
  return null;
}

/** Map a specific detected platform/architecture to its platform card id */
export function platformIdOf(detected: DetectedPlatform): PlatformId | null {
  if (!detected) return null;
  if (detected === "macos-arm64" || detected === "macos-x64") return "macos";
  return detected;
}

/**
 * Reorder platform cards in DOM order so the visitor's platform comes first (preserving keyboard/focus order
 * without CSS `order` reordering).
 */
export function orderPlatformsForVisitor(
  platforms: readonly PlatformDownload[],
  detected: DetectedPlatform,
): PlatformDownload[] {
  const targetId = platformIdOf(detected);
  if (!targetId) return [...platforms];
  const match = platforms.find((p) => p.id === targetId);
  if (!match) return [...platforms];
  return [match, ...platforms.filter((p) => p.id !== targetId)];
}
