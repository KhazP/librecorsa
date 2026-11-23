/**
 * Words the account store shows or sends: what a sign-in return says to the player, and what this device calls
 * itself in the account's device list. Pure, so the verify suite checks them.
 */
import { AUTH_RESULTS, AUTH_RESULT_PARAM, type AuthResult } from "./api-types";

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

/** What each sign-in return (`#lc-account=<result>`) says */
export const AUTH_NOTICES: Readonly<Record<AuthResult, Notice>> = {
  "signed-in": { kind: "ok", text: "You are signed in." },
  created: { kind: "ok", text: "Your account is ready, and you are signed in." },
  linked: { kind: "ok", text: "That sign-in is now on your account." },
  merged: { kind: "ok", text: "The two accounts are now one. Their saves are combined at the next sync." },
  "already-linked": { kind: "ok", text: "That sign-in was already on your account." },
  cancelled: { kind: "ok", text: "Sign-in cancelled. Nothing changed." },
  failed: { kind: "error", text: "Sign-in did not work. Try again in a moment." },
};

/**
 * The sign-in return in an address fragment: `result` is what the server said (null for a value this build doesn't
 * know), `rest` the fragment without it ("" when nothing else was there). Null when the fragment has no return.
 */
export function readAuthReturn(hash: string): { result: AuthResult | null; rest: string } | null {
  const parts = hash.replace(/^#/, "").split("&").filter(Boolean);
  const at = parts.findIndex((p) => p === AUTH_RESULT_PARAM || p.startsWith(`${AUTH_RESULT_PARAM}=`));
  if (at < 0) return null;
  let value = parts[at].slice(AUTH_RESULT_PARAM.length + 1);
  try {
    value = decodeURIComponent(value);
  } catch {
    // A broken escape: not one of the results
  }
  const result = AUTH_RESULTS.includes(value as AuthResult) ? (value as AuthResult) : null;
  return { result, rest: parts.filter((_, i) => i !== at).join("&") };
}

/** The system in a user agent; null when it says none the game knows */
function systemOf(ua: string, maxTouchPoints: number): string | null {
  if (/Windows/.test(ua)) return "Windows";
  if (/iPhone|iPod/.test(ua)) return "iOS";
  // iPadOS Safari asks for the desktop site with a Mac user agent; touch points give it away (install-app.ts)
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "iPadOS";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

/** The browser in a user agent. Edge, Opera and Samsung Internet also name Chrome and Safari, so they go first */
function browserOf(ua: string): string {
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "A browser";
}

/**
 * What this device is called in the account's device list: "Chrome on macOS", "Safari on iOS", and "LibreCorsa app on
 * Windows" for the desktop app (Electron names itself in its user agent) or "LibreCorsa app on Android" for the store
 * app (store-mode.ts). Nothing else from the user agent is kept.
 */
export function deviceLabelFor(userAgent: string, opts: { maxTouchPoints?: number; storeBuild?: boolean } = {}): string {
  const system = systemOf(userAgent, opts.maxTouchPoints ?? 0);
  const app = /Electron\//.test(userAgent) || opts.storeBuild === true;
  if (app) return `LibreCorsa app on ${system ?? (opts.storeBuild ? "Android" : "a computer")}`;
  const browser = browserOf(userAgent);
  return system ? `${browser} on ${system}` : browser;
}
