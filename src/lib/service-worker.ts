import { withBasePath } from "@/lib/base-path";

/** This build's id (next.config.ts): the service worker keys its asset cache on it */
const VERSION = process.env.NEXT_PUBLIC_ASSET_VERSION || "dev";

/**
 * Production builds register public/sw.js, which serves the circuits, cars and sounds from the browser's cache on
 * repeat visits. Development never caches (and drops a worker a preview build may have left on this origin).
 */
export function registerAssetCache(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") {
    void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => void r.unregister()));
    return;
  }
  // At once: the worker takes over the page as it activates, so the circuit and car this first visit downloads are
  // already cached for the next one
  navigator.serviceWorker
    .register(withBasePath(`/sw.js?v=${encodeURIComponent(VERSION)}`), { scope: withBasePath("/") })
    .catch((err) => console.warn("Asset cache not available", err));
}
