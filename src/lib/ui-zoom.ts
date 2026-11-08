import { useSyncExternalStore } from "react";

/**
 * The big-screen UI scale, `--lc-ui-zoom` in globals.css: 1 up to a 1080p-class window, more on a 1440p or 4K
 * one at 100 % OS scaling, so menus and HUD keep their size on screen instead of shrinking into the corners.
 * Menus take it as CSS `zoom` (`.lc-ui-zoom`); the HUD multiplies its corner-group scale by it, so it never
 * zooms the virtual mirror's frame, which lives in window pixels.
 */
let zoom: number | null = null;
const listeners = new Set<() => void>();

function read(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lc-ui-zoom"));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function onResize(): void {
  const next = read();
  if (next === zoom) return;
  zoom = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // Nobody listened while the window may have changed size: start from a fresh read
    zoom = read();
    window.addEventListener("resize", onResize);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("resize", onResize);
  };
}

/** Cached between resizes: the HUD asks on every telemetry frame */
function snapshot(): number {
  zoom ??= read();
  return zoom;
}

/** The current UI zoom, re-rendering when a window resize crosses one of its steps */
export function useUiZoom(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 1);
}
