/** Public address of the hosted game, for canonical URLs, the sitemap and share cards */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://librecorsa.org").replace(/\/+$/, "");

export const SITE_NAME = "LibreCorsa";
export const SITE_TITLE = "LibreCorsa: free open-source racing simulator in your browser";
export const SITE_DESCRIPTION =
  "Free, open-source sim racing in your browser: 500 Hz physics, open-wheelers and a GT3, AI races, multiplayer and wheel force feedback. Nothing to install.";
export const REPO_URL = "https://github.com/librecorsa/librecorsa";
/** Where a rights holder asks for an asset to be credited, corrected or removed */
export const TAKEDOWN_URL = `${REPO_URL}/issues/new?template=takedown-request.yml`;
/** Voluntary tips (same as .github/FUNDING.yml); never unlocks anything, the assets are non-commercial */
export const SUPPORT_URL = "https://buymeacoffee.com/alpyalayg";
/** Where to write to me: the press page, privacy requests and mods sent in from the home page's About section */
export const CONTACT_EMAIL = "contact@alpyalay.org";
/** Porting guides, app IDs and how the physics work (docs-site/, built from docs/) */
export const DOCS_URL = "https://docs.librecorsa.org";
/** Private vulnerability reports (SECURITY.md, /.well-known/security.txt) */
export const SECURITY_REPORT_URL = `${REPO_URL}/security/advisories/new`;
/**
 * A GitHub issue reporting a board lap (.github/ISSUE_TEMPLATE/lap-report.yml), titled "[Lap Issue] driver · circuit ·
 * car · time" with the lap's details filled in
 */
export function lapReportUrl(lap: { driver: string; circuit: string; car: string; lapTime: string; lapId: string }): string {
  const what = `${lap.circuit} · ${lap.car} · ${lap.lapTime}`;
  const q = new URLSearchParams({
    template: "lap-report.yml",
    title: `[Lap Issue] ${lap.driver} · ${what}`,
    driver: lap.driver,
    lap: what,
    "lap-id": lap.lapId,
  });
  return `${REPO_URL}/issues/new?${q.toString()}`;
}
/** My own accounts, where I post about the game; they link back to the site */
export const AUTHOR_LINKS = [
  { label: "YouTube", href: "https://www.youtube.com/@KhazAlp" },
  { label: "X", href: "https://x.com/alpyalay" },
] as const;
