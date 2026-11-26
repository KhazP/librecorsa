import { tripleRects } from "./screen-layout";

/**
 * Where the menus and the HUD go: the whole window, or on three screens the centre one (as sims keep them, so the
 * driver never turns their head to read a lap time and no button sits across a seam). The game sets it
 * (LibreCorsaSimulator.tsx); code that lays the UI out by the window's width reads it here instead.
 */
export interface UiFrame {
  /** CSS px from the window's left */
  x: number;
  w: number;
}

let frame: UiFrame | null = null;
const listeners = new Set<() => void>();

/** The centre screen of three on a window this size (CSS px) */
export function centreFrame(width: number, height: number): UiFrame {
  const centre = tripleRects(width, height, 1)[1];
  return { x: centre.x, w: centre.w };
}

export function setUiFrame(next: UiFrame | null): void {
  if (next === frame || (next && frame && next.x === frame.x && next.w === frame.w)) return;
  frame = next;
  for (const l of listeners) l();
}

/** The centre screen while there are three, else null (the whole window) */
export const uiFrame = (): UiFrame | null => frame;

/** The width the UI lays out in (CSS px): the centre screen of three, else the window */
export const uiViewportWidth = (): number => (frame ? frame.w : typeof window !== "undefined" ? window.innerWidth : 0);

/** Calls `listener` when the UI's width may have changed: a resize, or one screen becoming three and back */
export function onUiViewportChange(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("resize", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("resize", listener);
  };
}
