/** Public address of the hosted game, for canonical URLs, the sitemap and share cards */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://librecorsa.org").replace(/\/+$/, "");

export const SITE_NAME = "LibreCorsa";
export const SITE_TITLE = "LibreCorsa: free open-source racing simulator in your browser";
export const SITE_DESCRIPTION =
  "Free, open-source sim racing in your browser: 500 Hz physics, open-wheelers and a GT3, AI races, multiplayer and wheel force feedback. Nothing to install.";
export const REPO_URL = "https://github.com/KhazP/librecorsa";
/** Voluntary tips (same as .github/FUNDING.yml); never unlocks anything, the assets are non-commercial */
export const SUPPORT_URL = "https://buymeacoffee.com/alpyalayg";
/** Where to write to me: the address the press page gives, also for privacy requests */
export const CONTACT_EMAIL = "alpyalay@gmail.com";
