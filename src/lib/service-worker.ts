import { withBasePath } from "@/lib/base-path";

/**
 * Production builds register public/sw.js, which keeps the circuits, cars and sounds a player downloads and serves
 * them again once the server says they are current, keeps the game's pages and scripts for offline play, and serves
 * imported mod packages. Development never caches (and drops a worker a preview build may have left on this origin).
 */
export function registerAssetCache(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") {
    void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => void r.unregister()));
    return;
  }
  // One address for every build: the browser installs a new worker only when sw.js itself changes, and the kept files
  // stay through any deploy (they are checked against the server, never tied to a build). The worker takes over the
  // page as it activates, so what this visit downloads after that is kept for the next one
  navigator.serviceWorker
    .register(withBasePath("/sw.js"), { scope: withBasePath("/") })
    .catch((err) => console.warn("Asset cache not available", err));
  // A page that never loads a circuit (the home page, a visit cut short) still gets its offline copy, later
  window.setTimeout(requestShellSync, SHELL_SYNC_FALLBACK_MS);
}

/** How long after the page opens the offline copy is brought up to date when no circuit asked for it first */
const SHELL_SYNC_FALLBACK_MS = 60_000;

let shellAsked = false;

const askShellSync = (worker: ServiceWorker | null | undefined) => worker?.postMessage({ type: "librecorsa:sync-shell" });

/**
 * Brings the worker's offline copy of the game up to the build the server lists (a no-op when it is already), once per
 * page. Asked once the first circuit has loaded, so its few MB never compete with the circuit's download; asked on
 * every load, since a deploy that leaves sw.js as it was installs no new worker
 */
export function requestShellSync(): void {
  if (shellAsked || typeof window === "undefined" || !("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
  shellAsked = true;
  void navigator.serviceWorker.ready.then((reg) => askShellSync(reg.active)).catch(() => {});
  // A new sw.js that takes over after that (the visit that updates it) is asked again: the one asked may have been the
  // old worker, which an older build's sw.js doesn't answer
  navigator.serviceWorker.addEventListener("controllerchange", () => askShellSync(navigator.serviceWorker.controller));
}
