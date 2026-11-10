/**
 * Where the simulation runs: on the page's own thread (what ships), or in a Web Worker, where a frame that takes long
 * to draw no longer stalls the cars and the force feedback. The worker is opt-in while it is being driven and compared:
 * `?sim=worker` in the address switches it on and `?sim=main` off, and the choice is kept for the browser.
 */
export type SimMode = "main" | "worker";

const STORAGE_KEY = "librecorsa.simMode";

export function simMode(): SimMode {
  if (typeof window === "undefined" || typeof Worker === "undefined") return "main";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("sim");
    if (fromUrl === "worker" || fromUrl === "main") localStorage.setItem(STORAGE_KEY, fromUrl);
    return localStorage.getItem(STORAGE_KEY) === "worker" ? "worker" : "main";
  } catch {
    return "main";
  }
}
