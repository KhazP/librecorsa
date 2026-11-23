/**
 * Small helpers of the account screens: dates as the player reads them, the ways into an account as a list, link
 * codes as they are typed, and whether this is the desktop app (which can't follow a sign-in page and back).
 */
import { useSyncExternalStore } from "react";
import { LINK_CODE_ALPHABET, PROVIDER_LABELS, type AccountProvider } from "@/lib/account/api-types";

const DAY_MS = 86_400_000;

/** "23 Nov 2026" */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", then the date */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, now - ms) / 1000;
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.floor((now - ms) / DAY_MS);
  if (d <= 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return `on ${formatDay(ms)}`;
}

/** What is left of a link code: "9 minutes left", "Less than a minute left"; null once it has run out */
export function formatTimeLeft(expiresAt: number, now = Date.now()): string | null {
  const left = expiresAt - now;
  if (left <= 0) return null;
  const m = Math.floor(left / 60_000);
  if (m < 1) return "Less than a minute left";
  return m === 1 ? "1 minute left" : `${m} minutes left`;
}

/**
 * "Discord", "Discord and Google", "Discord, Google and a passkey". A passkey alone is "Passkey", as on its button, or
 * "a passkey" inside a sentence (`inSentence`: "Signed in with a passkey")
 */
export function providerList(providers: readonly AccountProvider[], inSentence = false): string {
  const unique = [...new Set(providers)];
  const names = unique.map((p) => (p === "passkey" && (inSentence || unique.length > 1) ? "a passkey" : PROVIDER_LABELS[p]));
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The question before a device joins an account: whose it is, and how it is signed in to */
export function joinQuestion(driverName: string | null, providers: readonly AccountProvider[]): string {
  const how = providers.length ? ` (${providerList(providers)})` : "";
  return driverName ? `Join the account of ${driverName}${how}?` : `Join this account${how}?`;
}

/**
 * A link code as it is typed: capitals, only the characters codes use (no 0, O, 1, I or L), at most eight, and a dash
 * after the fourth, so "abcd efgh" reads "ABCD-EFGH"
 */
export function typedLinkCode(raw: string): string {
  const chars = [...raw.toUpperCase()].filter((ch) => LINK_CODE_ALPHABET.includes(ch)).slice(0, 8).join("");
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars;
}

/**
 * The desktop app (Electron): it stays on librecorsa.org and sends every other site to the system browser
 * (desktop/src/nav-policy.js), so a sign-in page of Discord, Google or Steam would never come back to it. Electron
 * names itself in the user agent.
 */
export function inDesktopApp(): boolean {
  return typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent);
}

const noSubscribe = () => () => {};

/** `inDesktopApp()` for a component: false in the static page, the real answer once it runs in the browser */
export function useInDesktopApp(): boolean {
  return useSyncExternalStore(noSubscribe, inDesktopApp, () => false);
}
