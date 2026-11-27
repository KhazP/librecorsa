"use client";

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CarTelemetry } from "@/types/f1";
import { revLedBand, revLeds, type RevLedBand } from "@/lib/sim/rev-range";
import { displayLapNumber, HUD_GREEN, HUD_RED, HUD_SHIFT, HUD_YELLOW } from "../hud-format";
import { completedLap, type LapRecord } from "../third-party-data";
import { useHudModeRef } from "../hud-mode";

/**
 * Hooks and small pieces the third-party HUD layouts share: the laps driven this run, the fuel used per lap, the
 * session clock and the rev lights. Each layout draws them in its own look; the readings are the game's one set.
 * The run's readings are kept by `HudRunProvider`, which the HUD mounts above every style: hiding the HUD or switching
 * layout mid-race keeps the laps, the fuel use and the clock.
 */

/** Rev light band colours: the HUD's and the car wheel's one set of bands, from the colour tokens */
export const REV_BAND_COLOR: Record<RevLedBand, string> = {
  green: HUD_GREEN,
  yellow: HUD_YELLOW,
  red: HUD_RED,
  shift: HUD_SHIFT,
};

/**
 * `count` rev lights at the car's rpm, lit by the one rule the HUD, the wheel and the pad share (`revLeds`): which are
 * on, and each light's colour (every light in the shift colour at the shift point)
 */
export function revLights(rpm: number, revRange: readonly [number, number], count: number) {
  const { lit, atShift } = revLeds(rpm, revRange, count);
  return {
    lit,
    atShift,
    on: (i: number) => atShift || i < lit,
    color: (i: number) => (atShift ? HUD_SHIFT : REV_BAND_COLOR[revLedBand(i, count)]),
  };
}

/** The laps kept for the layouts to list (each shows as many as it has room for) */
const LAPS_KEPT = 12;

/**
 * The laps completed this run, newest first. A restart (new run id) clears them; a lap is recorded when the lap
 * counter steps up and the lap time arrives with it.
 */
function useLapRecords(t: CarTelemetry): LapRecord[] {
  const runId = t.runId ?? 0;
  const [laps, setLaps] = useState<LapRecord[]>([]);
  const prev = useRef({ runId, lapCount: t.lapCount, completed: 0, sectors: [...t.sectorTimesMs] as [number, number, number] });
  useEffect(() => {
    const p = prev.current;
    if (p.runId !== runId) {
      prev.current = { runId, lapCount: t.lapCount, completed: 0, sectors: [...t.sectorTimesMs] as [number, number, number] };
      setLaps([]);
      return;
    }
    let completed = p.completed;
    if (t.lapCount > p.lapCount && t.lastLapTimeMs && t.lastLapTimeMs > 0) {
      completed += 1;
      const rec = completedLap(completed, t.lastLapTimeMs, p.sectors, t.lastLapValid !== false);
      setLaps((l) => [rec, ...l].slice(0, LAPS_KEPT));
    }
    prev.current = { runId, lapCount: t.lapCount, completed, sectors: [...t.sectorTimesMs] as [number, number, number] };
  }, [runId, t.lapCount, t.lastLapTimeMs, t.lastLapValid, t.sectorTimesMs]);
  return laps;
}

/**
 * Fuel used per lap (kg), averaged over the last three full laps; null until a lap has been run from line to line.
 * A restart or a refuel (the fuel going up) starts the count again.
 */
function useFuelUse(t: CarTelemetry): number | null {
  const runId = t.runId ?? 0;
  const [perLap, setPerLap] = useState<number | null>(null);
  const state = useRef<{ runId: number; lapCount: number; startKg: number | null; used: number[]; lastKg: number }>({
    runId,
    lapCount: t.lapCount,
    startKg: null,
    used: [],
    lastKg: t.fuelKg,
  });
  useEffect(() => {
    const s = state.current;
    if (s.runId !== runId || t.fuelKg > s.lastKg + 0.5) {
      state.current = { runId, lapCount: t.lapCount, startKg: null, used: [], lastKg: t.fuelKg };
      setPerLap(null);
      return;
    }
    s.lastKg = t.fuelKg;
    if (t.lapCount !== s.lapCount) {
      // The first line crossing starts the count: the lap out of the grid or the pits is not a full lap
      if (s.startKg !== null && t.lapCount === s.lapCount + 1) {
        const used = s.startKg - t.fuelKg;
        if (used > 0.01) {
          s.used = [...s.used, used].slice(-3);
          setPerLap(s.used.reduce((a, b) => a + b, 0) / s.used.length);
        }
      }
      s.startKg = t.fuelKg;
      s.lapCount = t.lapCount;
    }
  }, [runId, t.lapCount, t.fuelKg]);
  return t.fuelKg > 0 ? perLap : null;
}

/**
 * Seconds on track this run, ticking once a second: a restart starts again from zero, and the clock stops while the
 * game is paused or in a replay (the HUD hidden), as the session's own time does
 */
function useRunClock(t: CarTelemetry): number {
  const runId = t.runId ?? 0;
  const mode = useHudModeRef();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    const id = window.setInterval(() => {
      if (mode.current !== "hidden") setSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [runId, mode]);
  return seconds;
}

/** Fuel on board when this run started (or at the last refuel) */
function useRunStartFuel(t: CarTelemetry): number {
  const runId = t.runId ?? 0;
  const [start, setStart] = useState({ runId, kg: t.fuelKg });
  useEffect(() => {
    if (start.runId !== runId || t.fuelKg > start.kg) setStart({ runId, kg: t.fuelKg });
  }, [runId, t.fuelKg, start]);
  return start.runId === runId ? Math.max(start.kg, t.fuelKg) : t.fuelKg;
}

interface HudRun {
  laps: readonly LapRecord[];
  fuelPerLapKg: number | null;
  startFuelKg: number;
  sessionS: number;
  lapBase: number;
}

const HudRunContext = createContext<HudRun>({ laps: [], fuelPerLapKg: null, startFuelKg: 0, sessionS: 0, lapBase: 0 });

/** Tracks the sim `lapCount` offset at the start of each session so solo sessions start at Lap 1 */
function useSessionLapBase(t: CarTelemetry, sessionSeq: number): number {
  const ref = useRef({ seq: sessionSeq, base: 0 });
  if (ref.current.seq !== sessionSeq) {
    ref.current = { seq: sessionSeq, base: Math.max(0, t.lapCount - 1) };
  } else if (t.lapCount - 1 < ref.current.base) {
    ref.current.base = Math.max(0, t.lapCount - 1);
  }
  return ref.current.base;
}

/**
 * Keeps the run's laps, fuel use, clock, and session lap baseline for every HUD layout and panel. Mounted by the HUD
 * above every style and kept while the HUD is hidden, so neither the HUD button nor a layout switch resets them.
 */
export function HudRunProvider({ t, sessionSeq = 0, children }: { t: CarTelemetry; sessionSeq?: number; children: React.ReactNode }) {
  const laps = useLapRecords(t);
  const fuelPerLapKg = useFuelUse(t);
  const startFuelKg = useRunStartFuel(t);
  const sessionS = useRunClock(t);
  const lapBase = useSessionLapBase(t, sessionSeq);
  const value = useMemo(
    () => ({ laps, fuelPerLapKg, startFuelKg, sessionS, lapBase }),
    [laps, fuelPerLapKg, startFuelKg, sessionS, lapBase],
  );
  return <HudRunContext.Provider value={value}>{children}</HudRunContext.Provider>;
}

/** Authoritative display lap number for any HUD widget (uses `race.lap` during races, session-anchored `lapCount` otherwise) */
export function useDisplayLap(t: Pick<CarTelemetry, "lapCount" | "race">): number {
  return displayLapNumber(t, useContext(HudRunContext).lapBase);
}

/** The laps completed this run, newest first, at most `max` */
export function useLapHistory(max = LAPS_KEPT): LapRecord[] {
  const { laps } = useContext(HudRunContext);
  return useMemo(() => laps.slice(0, max), [laps, max]);
}

/** Fuel used per lap (kg) over the last full laps; null until one has been measured, or on a car without fuel */
export function useFuelPerLap(): number | null {
  return useContext(HudRunContext).fuelPerLapKg;
}

/** Fuel on board when this run started (or at the last refuel) */
export function useStartFuel(): number {
  return useContext(HudRunContext).startFuelKg;
}

/** Seconds on track this run, paused with the game */
export function useSessionClock(): number {
  return useContext(HudRunContext).sessionS;
}
