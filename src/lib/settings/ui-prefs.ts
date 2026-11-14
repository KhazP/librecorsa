import { useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_INTERFACE_SETTINGS,
  parseInterface,
  SETTINGS_STORAGE_KEY,
  type ColorPalette,
  type InterfaceSettings,
  type UnitSettings,
} from "./player-settings";

/**
 * The interface preferences as the page applies them (Settings > Display > Interface): the colour palette and the
 * UI scale go onto <html>, where the CSS reads them (palette.css, globals.css), and the units are kept here for
 * whatever prints a number. One call, from wherever the settings are held, whenever they change.
 */
let current: InterfaceSettings = DEFAULT_INTERFACE_SETTINGS;
const listeners = new Set<() => void>();

export function applyInterfaceSettings(ui: InterfaceSettings): void {
  const changed = ui !== current;
  current = ui;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (ui.palette === "standard") delete root.dataset.palette;
    else root.dataset.palette = ui.palette;
    const scale = String(ui.scale);
    if (root.style.getPropertyValue("--lc-ui-scale") !== scale) {
      root.style.setProperty("--lc-ui-scale", scale);
      // ui-zoom.ts caches the zoom between resizes: tell it the scale moved (only then: a resize also resizes the
      // renderer)
      window.dispatchEvent(new Event("resize"));
    }
  }
  if (changed) for (const l of listeners) l();
}

/**
 * For a page outside the game (the home page): the saved units, palette and interface size, read once after the
 * first render. The game applies its own as it reads the whole save; coming from the game they are already in place.
 */
export function useSavedInterfaceSettings(): void {
  useEffect(() => {
    if (current !== DEFAULT_INTERFACE_SETTINGS) return;
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const json: unknown = raw ? JSON.parse(raw) : null;
      if (json && typeof json === "object") applyInterfaceSettings(parseInterface((json as { ui?: unknown }).ui));
    } catch {
      // Storage unavailable or a corrupt save: the defaults stay
    }
  }, []);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The player's units, re-rendering when they change */
export function useUnits(): UnitSettings {
  return useSyncExternalStore(
    subscribe,
    () => current.units,
    () => DEFAULT_INTERFACE_SETTINGS.units,
  );
}

/** The colour palette in use, re-rendering when it changes */
export function usePalette(): ColorPalette {
  return useSyncExternalStore(
    subscribe,
    () => current.palette,
    () => DEFAULT_INTERFACE_SETTINGS.palette,
  );
}

/** For code outside React (canvas drawing, formatters called per frame) */
export const currentUnits = (): UnitSettings => current.units;
