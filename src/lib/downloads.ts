import { text as t } from "@/lib/text";
import { REPO_URL } from "./site";

/**
 * Native app releases published on GitHub Releases (.github/workflows/release-desktop.yml).
 *
 * All four platforms (Windows, macOS, Linux, Android) ship from one release tag so desktop auto-updates
 * (electron-updater, which reads the repo's Latest release) never collide with a separate Android release.
 * Update APP_RELEASE when a new desktop-v* tag is published (or when an APK is attached to the current tag).
 */

export type PlatformId = "windows" | "macos" | "linux" | "android";
export type DetectedPlatform = "windows" | "macos-arm64" | "macos-x64" | "linux" | "android" | null;

export interface DownloadArtifact {
  id: string;
  /** Visible button text (starts with the action/target so WCAG 2.5.3 Label in Name holds cleanly) */
  label: string;
  /** Architecture or format note shown alongside size */
  detail: string;
  /** Asset filename on GitHub Releases, or null when not attached to this tag yet */
  file: string | null;
  /** Exact asset size in bytes, or null when not attached yet */
  sizeBytes: number | null;
}

export interface PlatformDownload {
  id: PlatformId;
  name: string;
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

export const APP_RELEASE = {
  tag: "desktop-v0.2.2",
  version: "0.2.2",
  /** YYYY-MM-DD */
  date: "2026-11-23",
  releaseUrl: `${REPO_URL}/releases/tag/desktop-v0.2.2`,
  latestReleasesUrl: `${REPO_URL}/releases/latest`,
  allReleasesUrl: `${REPO_URL}/releases`,
  codeSigningPolicyUrl: `${REPO_URL}#code-signing-policy`,
} as const;

export const PLATFORM_DOWNLOADS: readonly PlatformDownload[] = [
  {
    id: "windows",
    name: "Windows",
    get summary() { return t("game.downloads.windowsSummary"); },
    get installNote() { return t("game.downloads.windowsInstallNote"); },
    signed: false,
    get statusLabel() { return t("game.downloads.windowsStatusLabel"); },
    artifacts: [
      {
        id: "windows-x64",
        get label() { return t("game.downloads.windowsX64Label"); },
        get detail() { return t("game.downloads.windowsX64Detail"); },
        file: "LibreCorsa-0.2.2-win-x64-Setup.exe",
        sizeBytes: 121_681_197,
      },
    ],
  },
  {
    id: "macos",
    name: "macOS",
    get summary() { return t("game.downloads.macosSummary"); },
    get installNote() { return t("game.downloads.macosInstallNote"); },
    installCommand: "xattr -cr /Applications/LibreCorsa.app",
    signed: false,
    get statusLabel() { return t("game.downloads.macosStatusLabel"); },
    artifacts: [
      {
        id: "macos-arm64",
        get label() { return t("game.downloads.macosArm64Label"); },
        get detail() { return t("game.downloads.macosArm64Detail"); },
        file: "LibreCorsa-0.2.2-mac-arm64.dmg",
        sizeBytes: 121_566_744,
      },
      {
        id: "macos-x64",
        get label() { return t("game.downloads.macosX64Label"); },
        get detail() { return t("game.downloads.macosX64Detail"); },
        file: "LibreCorsa-0.2.2-mac-x64.dmg",
        sizeBytes: 125_687_175,
      },
    ],
  },
  {
    id: "linux",
    name: "Linux",
    get summary() { return t("game.downloads.linuxSummary"); },
    get installNote() { return t("game.downloads.linuxInstallNote"); },
    installCommand: "chmod +x LibreCorsa-0.2.2-linux-x86_64.AppImage",
    signed: false,
    statusLabel: "AppImage",
    artifacts: [
      {
        id: "linux-x64",
        get label() { return t("game.downloads.linuxX64Label"); },
        get detail() { return t("game.downloads.linuxX64Detail"); },
        file: "LibreCorsa-0.2.2-linux-x86_64.AppImage",
        sizeBytes: 126_167_482,
      },
    ],
  },
  {
    id: "android",
    name: "Android",
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

/** Direct GitHub Releases asset URL when published, else the latest release page (never a dead 404 link) */
export function artifactHref(artifact: DownloadArtifact, tag: string = APP_RELEASE.tag): string {
  if (!artifact.file) return APP_RELEASE.latestReleasesUrl;
  return `${REPO_URL}/releases/download/${tag}/${artifact.file}`;
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
