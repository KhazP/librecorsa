"use client";

import { createContext, useContext, useRef, type RefObject } from "react";

/**
 * What the in-race HUD may do right now, set by F1TelemetryHud:
 * - "live": driving; every panel takes input.
 * - "results": the race results card is up and owns the D-pad and the keys; the MFD tuner leaves them alone (the
 *   pedals and the touch controls still drive).
 * - "hidden": paused, or in an instant replay. The HUD stays mounted, so its folds, lap history and timers carry on,
 *   but it is invisible and inert, and its window listeners (keys, pad, tilt) do nothing.
 */
export type HudMode = "live" | "results" | "hidden";

export const HudModeContext = createContext<HudMode>("live");

export function useHudMode(): HudMode {
  return useContext(HudModeContext);
}

/** The HUD mode in a ref, for window listeners and pollers that read it when the event arrives */
export function useHudModeRef(): RefObject<HudMode> {
  const mode = useHudMode();
  const ref = useRef(mode);
  ref.current = mode;
  return ref;
}
