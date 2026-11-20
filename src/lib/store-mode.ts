/*
 * The store build: the Android app (a Trusted Web Activity, `android/`) is what goes on Google Play, and inside it the
 * site leaves out what the store's rules make risky: external payment/donation links (Play's payment rules) and
 * third-party GT tyre brand logos. Chrome opens the app's first page with `document.referrer` set to
 * `android-app://<package id>`; later pages in the same tab read the mark left in sessionStorage. The desktop app and
 * the site in a browser are unaffected. `?store=play` turns it on in a browser tab, to check it without a phone.
 *
 * No React here so non-UI modules (`gt-tyre-sidewall.ts`, `report-facts.ts`) can import it cleanly. Components use
 * useStoreBuild (`use-store-build.ts`).
 */

const ANDROID_APP_REFERRER = "android-app://org.librecorsa.app";
const STORE_FLAG_KEY = "lc-store-build";

let storeBuild: boolean | undefined;

/** True inside the Android app (and in a tab opened with `?store=play`), for the rest of that tab's visit */
export function isStoreBuild(): boolean {
  // The server and the sim worker have no page to ask
  if (typeof document === "undefined") return false;
  if (storeBuild !== undefined) return storeBuild;
  let on =
    document.referrer.startsWith(ANDROID_APP_REFERRER) || new URLSearchParams(window.location.search).get("store") === "play";
  try {
    if (on) window.sessionStorage.setItem(STORE_FLAG_KEY, "1");
    else on = window.sessionStorage.getItem(STORE_FLAG_KEY) === "1";
  } catch {
    // Storage blocked: the referrer alone decides, for this page only
  }
  storeBuild = on;
  return on;
}
