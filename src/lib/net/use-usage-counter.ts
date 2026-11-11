/**
 * The game's side of the anonymous usage counter (usage.ts): a stretch of driving ends when the player leaves the
 * track, changes circuit, car or kind of session, takes the flag, or the page is hidden or closed. Only sent when the
 * online side says the counter is on.
 */
import { useCallback, useEffect, useRef } from "react";
import type { VehicleModelId } from "@/types/f1";
import { getOnlineConfig } from "./online-config";
import { sendUsage, UsageClock, type UsageMode } from "./usage";

export interface UsageState {
  /** On track (not in the menus or loading) */
  driving: boolean;
  /** The pause menu is open: the clock stops, the stretch goes on */
  paused: boolean;
  trackId: string;
  vehicle: VehicleModelId;
  /** The session's kind: practice, against the AI, or a multiplayer race */
  race: "practice" | "ai" | "mp";
  /** Entered in a scheduled race (an open race), not a room */
  scheduledRace: boolean;
  /** Practice to the weekly challenge's rules: its time trial */
  onChallenge: boolean;
  /** The player has taken the flag */
  raceOver: boolean;
}

/** The mode of a stretch; a multiplayer race is open or a room's as it was when it started */
export function usageModeOf(race: UsageState["race"], scheduledRace: boolean, onChallenge: boolean): UsageMode {
  if (race === "ai") return "ai_race";
  if (race === "mp") return scheduledRace ? "open_race" : "room_race";
  return onChallenge ? "time_trial" : "practice";
}

/** The counter's switch as last read; read again with each new stretch (the config keeps its answer a while) */
let usageOn = false;

export function useUsageCounter(state: UsageState): void {
  const stateRef = useRef(state);
  const clockRef = useRef<UsageClock | null>(null);
  /** Whether the multiplayer race under way is a scheduled one, as it was at its start (a lost entry changes nothing) */
  const scheduledRef = useRef<boolean | null>(null);

  const apply = useCallback(() => {
    const clock = clockRef.current;
    if (!clock) return;
    const s = stateRef.current;
    scheduledRef.current = s.race === "mp" ? (scheduledRef.current ?? s.scheduledRace) : null;
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (!s.driving || !visible) {
      clock.set(null, false);
      return;
    }
    void getOnlineConfig().then((config) => {
      usageOn = config.usage;
    });
    const mode = usageModeOf(s.race, scheduledRef.current ?? false, s.onChallenge);
    clock.set({ trackId: s.trackId, vehicle: s.vehicle, mode }, !s.paused, s.raceOver ? "flag" : "");
  }, []);

  useEffect(() => {
    const clock = new UsageClock((line) => {
      if (usageOn) sendUsage(line);
    });
    clockRef.current = clock;
    // Hidden or closed ends the stretch; back on the page starts a new one
    const onPageHide = () => clock.end();
    document.addEventListener("visibilitychange", apply);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", apply);
    apply();
    return () => {
      document.removeEventListener("visibilitychange", apply);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", apply);
      clock.end();
      clockRef.current = null;
    };
  }, [apply]);

  const { driving, paused, trackId, vehicle, race, scheduledRace, onChallenge, raceOver } = state;
  useEffect(() => {
    stateRef.current = { driving, paused, trackId, vehicle, race, scheduledRace, onChallenge, raceOver };
    apply();
  }, [apply, driving, paused, trackId, vehicle, race, scheduledRace, onChallenge, raceOver]);
}
