/**
 * Small helpers of the account screens: dates as the player reads them, the ways into an account as a list, link
 * codes as they are typed, and whether this is the desktop app (which can't follow a sign-in page and back).
 */
import { useSyncExternalStore } from "react";
import { LINK_CODE_ALPHABET, PROVIDER_LABELS, type AccountProvider } from "@/lib/account/api-types";
import { CATALOGS, formatLocale } from "@/i18n/catalogs";
import { text, textLocale } from "@/lib/text";

const DAY_MS = 86_400_000;

/** "23 Nov 2026", in the player's language (Latin digits, as everywhere in the game) */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(formatLocale(textLocale()), { day: "numeric", month: "short", year: "numeric" });
}

/**
 * "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", "2 months ago", in the player's language: a
 * phrase that goes into a sentence ("Synced {ago}")
 */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, now - ms) / 1000;
  if (s < 60) return text("game.account.justNow");
  const rtf = new Intl.RelativeTimeFormat(formatLocale(textLocale()), { numeric: "auto" });
  const m = Math.floor(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.max(1, Math.floor((now - ms) / DAY_MS));
  if (d < 31) return rtf.format(-d, "day");
  if (d < 365) return rtf.format(-Math.floor(d / 30), "month");
  return rtf.format(-Math.floor(d / 365), "year");
}

/** Whole minutes a link code has left (0 under a minute); null once it has run out */
export function minutesLeft(expiresAt: number, now = Date.now()): number | null {
  const left = expiresAt - now;
  return left <= 0 ? null : Math.floor(left / 60_000);
}

/**
 * "Discord, Google and a passkey" in the player's language. In a right-to-left language each name is isolated and the
 * list as a whole runs right to left, so a list that starts with a Latin name ("Discord وGoogle") keeps its order
 * where the message puts it.
 */
function listOf(names: string[]): string {
  const locale = textLocale();
  const rtl = CATALOGS[locale]?.dir === "rtl";
  const items = rtl ? names.map((n) => `\u2068${n}\u2069`) : names;
  const list = items.length <= 1 ? (items[0] ?? "") : new Intl.ListFormat(formatLocale(locale), { style: "long", type: "conjunction" }).format(items);
  return rtl && list ? `\u2067${list}\u2069` : list;
}

/**
 * "Discord", "Discord and Google", "Discord, Google and a passkey". A passkey alone is "Passkey", as on its button, or
 * "a passkey" inside a sentence (`inSentence`: "Signed in with a passkey")
 */
export function providerList(providers: readonly AccountProvider[], inSentence = false): string {
  const unique = [...new Set(providers)];
  const names = unique.map((p) =>
    p === "passkey" ? text(inSentence || unique.length > 1 ? "game.account.aPasskey" : "game.account.passkey") : PROVIDER_LABELS[p],
  );
  return listOf(names);
}

/** "Alp", "Alp and Bo", "Alp, Bo and Cy" */
export function nameList(names: readonly string[]): string {
  return listOf([...names]);
}

/** The question before a device joins an account: whose it is, and how it is signed in to */
export function joinQuestion(driverName: string | null, providers: readonly AccountProvider[]): string {
  const ways = providers.length ? providerList(providers) : "";
  if (driverName) return ways ? text("game.account.join.named", { name: driverName, ways }) : text("game.account.join.namedOnly", { name: driverName });
  return ways ? text("game.account.join.this", { ways }) : text("game.account.join.thisOnly");
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
