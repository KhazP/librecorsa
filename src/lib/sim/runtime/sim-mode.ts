/**
 * Where the simulation runs: in a Web Worker (what ships), where a frame that takes long to draw no longer stalls the
 * car, or on the page's own thread. The worker drives the player's own car in practice, on a keyboard, a gamepad or
 * touch; AI and online races and a steering wheel's car still run on the page, as does everything when the worker
 * cannot start. `?sim=main` in the address keeps the whole simulation on the page and `?sim=worker` undoes that; the
 * choice is kept for the browser.
 */
export type SimMode = "main" | "worker";

const STORAGE_KEY = "librecorsa.simMode";

export function simMode(): SimMode {
  if (typeof window === "undefined" || typeof Worker === "undefined") return "main";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("sim");
    if (fromUrl === "worker" || fromUrl === "main") localStorage.setItem(STORAGE_KEY, fromUrl);
    return localStorage.getItem(STORAGE_KEY) === "main" ? "main" : "worker";
  } catch {
    return "worker";
  }
}
