/**
 * The game's side of the anonymous usage counter (usage.ts): a stretch of driving ends when the player leaves the
 * track, changes circuit, car or kind of session, takes the flag, or the page is hidden or closed. Only sent when the
 * online side says the counter is on.
 */
import { useCallback, useEffect, useRef } from "react";
import type { AssistPreset, VehicleModelId } from "@/types/f1";
import { lapConditionsNow, WET_LAP_WATER_MM } from "@/lib/sim/lap-types";
import type { SimRealism } from "@/lib/sim/sim-realism";
import { getOnlineConfig } from "./online-config";
import { sendUsage, UsageClock, type UsageMode } from "./usage";
import { challengeAt, challengeCompound, fitsChallenge } from "./weekly-challenge";

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
  /** What practice is driven with: on the week's circuit and car, to its rules, it is the challenge's time trial */
  assists: AssistPreset;
  realism: SimRealism;
  /** Water on the racing line (mm): a wet track is not the challenge's */
  lineWaterMm: number;
  /** The player has taken the flag */
  raceOver: boolean;
}

/** The mode of a stretch; a multiplayer race is open or a room's as it was when it started */
export function usageModeOf(race: UsageState["race"], scheduledRace: boolean, onChallenge: boolean): UsageMode {
  if (race === "ai") return "ai_race";
  if (race === "mp") return scheduledRace ? "open_race" : "room_race";
  return onChallenge ? "time_trial" : "practice";
}

type Settled = Omit<UsageState, "lineWaterMm"> & { wet: boolean };

/** True when practice so driven is the weekly challenge (the test its board uses) */
export function onChallenge(s: Pick<Settled, "trackId" | "vehicle" | "assists" | "realism" | "wet">): boolean {
  // The tyre is taken as the challenge's: the counter asks which mode was driven, not whether a lap would count
  const conditions = lapConditionsNow({ assists: s.assists, compound: challengeCompound(s.vehicle), lineWaterMm: s.wet ? WET_LAP_WATER_MM : 0, realism: s.realism, vehicle: s.vehicle });
  return fitsChallenge({ trackId: s.trackId, vehicle: s.vehicle, conditions }, challengeAt(Date.now()));
}

/** The counter's switch as last read; read again with each new stretch (the config keeps its answer a while) */
let usageOn = false;

export function useUsageCounter(state: UsageState): void {
  const stateRef = useRef<Settled | null>(null);
  const clockRef = useRef<UsageClock | null>(null);
  /** Whether the multiplayer race under way is a scheduled one, as it was at its start (a lost entry changes nothing) */
  const scheduledRef = useRef<boolean | null>(null);

  const apply = useCallback(() => {
    const clock = clockRef.current;
    const s = stateRef.current;
    if (!clock || !s) return;
    scheduledRef.current = s.race === "mp" ? (scheduledRef.current ?? s.scheduledRace) : null;
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (!s.driving || !visible) {
      clock.set(null, false);
      return;
    }
    void getOnlineConfig().then((config) => {
      usageOn = config.usage;
    });
    const mode = usageModeOf(s.race, scheduledRef.current ?? false, s.race === "practice" && onChallenge(s));
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

  // Only what can change the stretch reaches the effect (the water only as wet or dry)
  const { driving, paused, trackId, vehicle, race, scheduledRace, assists, realism, raceOver } = state;
  const wet = state.lineWaterMm >= WET_LAP_WATER_MM;
  useEffect(() => {
    stateRef.current = { driving, paused, trackId, vehicle, race, scheduledRace, assists, realism, wet, raceOver };
    apply();
  }, [apply, driving, paused, trackId, vehicle, race, scheduledRace, assists, realism, wet, raceOver]);
}
