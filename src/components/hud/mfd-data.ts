"use client";

import { useEffect, useRef, useState } from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import type { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { VF26_CHASSIS } from "@/lib/sim/vf26-data";

/** One line of the relative: a car near the player on the road, whatever its race position */
export interface RelativeRow {
  key: string;
  code: string;
  color: string;
  isPlayer: boolean;
  /** Race position when racing */
  position?: number;
  /** Road distance to the car (m), + = ahead of the player */
  dsM: number;
  /** Time to the car on the road (s), + = ahead; estimated from the player's best lap where there is one */
  gapS: number;
  /** Laps the car is ahead of (+) or behind (−) the player in race distance */
  lapDiff: number;
  compound?: TireCompound;
  penaltyS?: number;
}

/** Signed shortest road distance from a to b on a lap of length L, in (−L/2, L/2] */
function wrapDs(a: number, b: number, L: number): number {
  let d = (((b - a) % L) + L) % L;
  if (d > L / 2) d -= L;
  return d;
}

/**
 * On-track relative table: the cars nearest the player by road distance, `n` ahead and `n` behind, with the
 * time it takes to close the gap on the road and how many laps up or down each car is.
 */
export function computeRelatives(
  t: CarTelemetry,
  tracker: LapDeltaTracker | null,
  L: number,
  playerCompound: TireCompound,
  n = 3,
): RelativeRow[] {
  const playerS = t.trackDistanceM;
  const standings = t.race?.standings;
  const me = standings?.find((s) => s.isPlayer);
  const rows: { base: Omit<RelativeRow, "dsM" | "gapS" | "lapDiff">; s: number; race?: number }[] = [];
  if (standings && standings.some((s) => s.trackS !== undefined)) {
    standings.forEach((s, i) => {
      if (s.isPlayer || s.trackS === undefined) return;
      rows.push({
        base: {
          key: `${s.driverCode}-${i}`,
          code: s.driverCode,
          color: s.teamColorHex,
          isPlayer: false,
          position: i + 1,
          compound: s.compound,
          penaltyS: s.penaltyS,
        },
        s: s.trackS,
        race: s.raceDistM,
      });
    });
  } else if (t.peers) {
    for (const p of t.peers) {
      rows.push({ base: { key: p.peerId, code: p.driverCode, color: p.teamColorHex, isPlayer: false }, s: p.trackDistanceM });
    }
  }
  const speed = Math.max(15, t.speedMs);
  const gapOf = (ds: number, s: number): number => {
    const ref = tracker?.hasReference
      ? ds >= 0
        ? tracker.referenceGapS(playerS, s, L)
        : tracker.referenceGapS(s, playerS, L)
      : null;
    const abs = ref !== null && ref >= 0 ? ref : Math.abs(ds) / speed;
    return ds >= 0 ? abs : -abs;
  };
  const placed: RelativeRow[] = rows.map(({ base, s, race }) => {
    const dsM = wrapDs(playerS, s, L);
    const lapDiff = race !== undefined && me?.raceDistM !== undefined ? Math.round((race - me.raceDistM - dsM) / L) : 0;
    return { ...base, dsM, gapS: gapOf(dsM, s), lapDiff };
  });
  const ahead = placed.filter((r) => r.dsM >= 0).sort((a, b) => a.dsM - b.dsM).slice(0, n).reverse();
  const behind = placed.filter((r) => r.dsM < 0).sort((a, b) => b.dsM - a.dsM).slice(0, n);
  const player: RelativeRow = {
    key: "player",
    code: me?.driverCode ?? "YOU",
    color: me?.teamColorHex ?? "#CCFF00",
    isPlayer: true,
    position: t.race?.position,
    dsM: 0,
    gapS: 0,
    lapDiff: 0,
    compound: playerCompound,
    penaltyS: me?.penaltyS,
  };
  return [...ahead, player, ...behind];
}

/** One completed lap as the MFD keeps it */
export interface LapRecord {
  lap: number;
  timeMs: number;
  sectorsMs: [number, number, number];
  valid: boolean;
  /** Fuel burnt (kg), battery used (state-of-charge points, + = drained) and mean tread wear added (%) over the lap */
  fuelKg: number;
  ersPct: number;
  wearPct: number;
}

const HISTORY = 12;

const meanWear = (t: CarTelemetry) => (t.tireWearPct[0] + t.tireWearPct[1] + t.tireWearPct[2] + t.tireWearPct[3]) / 4;

/**
 * Completed laps with their sector splits, validity and what each one cost in fuel, battery and tread. The sim keeps
 * each sector until the next lap overwrites it, so the first two are read on the line; the third is what remains of
 * the lap time.
 */
export function useLapHistory(t: CarTelemetry): LapRecord[] {
  const [laps, setLaps] = useState<LapRecord[]>([]);
  const prev = useRef<{ lapCount: number } | null>(null);
  const start = useRef<{ fuel: number; ers: number; wear: number } | null>(null);

  useEffect(() => {
    const p = prev.current;
    const now = { fuel: t.fuelKg, ers: t.ersBatteryPercent, wear: meanWear(t) };
    if (p && t.lapCount < p.lapCount) {
      // Back to the grid / pit lane: a new session
      setLaps([]);
      start.current = now;
    } else if (p && t.lapCount === p.lapCount + 1 && t.lastLapTimeMs !== null) {
      const s0 = start.current;
      const s1 = Math.max(0, t.sectorTimesMs[0]);
      const s2 = Math.max(0, t.sectorTimesMs[1]);
      const rec: LapRecord = {
        lap: t.lapCount,
        timeMs: t.lastLapTimeMs,
        sectorsMs: [s1, s2, s1 > 0 && s2 > 0 ? Math.max(0, t.lastLapTimeMs - s1 - s2) : 0],
        valid: t.lastLapValid !== false,
        fuelKg: s0 ? Math.max(0, s0.fuel - now.fuel) : 0,
        ersPct: s0 ? s0.ers - now.ers : 0,
        wearPct: s0 ? Math.max(0, now.wear - s0.wear) : 0,
      };
      // An out-lap (no start snapshot) still counts for times, not for the averages
      if (!s0) rec.fuelKg = rec.ersPct = rec.wearPct = Number.NaN;
      setLaps((l) => [...l, rec].slice(-HISTORY));
      start.current = now;
    } else if (p && t.lapCount !== p.lapCount) {
      start.current = now;
    } else if (!p && t.currentLapTimeMs < 1000) {
      // Mounted on the line: the first lap counts in full (mounted mid-lap, it only counts for its time)
      start.current = now;
    }
    prev.current = { lapCount: t.lapCount };
  }, [t]);

  return laps;
}

export interface FuelStrategy {
  /** The car carries fuel at all (the f12026-car and GT3 run without a fuel model) */
  hasFuel: boolean;
  fuelKg: number;
  /** Rolling mean over the last three timed laps (kg, battery points, tread %); null before the first one */
  avgFuelKg: number | null;
  avgErsPct: number | null;
  avgWearPct: number | null;
  /** Laps the fuel on board lasts at the average */
  lapsOfFuel: number | null;
  /** Race laps still to run (fractional), null outside a race */
  raceLapsLeft: number | null;
  /** Fuel per lap that makes the flag */
  targetKg: number | null;
  /** Fuel to save per lap (kg) and the lift-and-coast that saves it (s per lap), when short */
  saveKg: number | null;
  liftS: number | null;
  /** Fuel left over at the flag at the current average (kg, negative = short) */
  marginKg: number | null;
  samples: number;
}

const AVG_LAPS = 3;

/** Fuel, energy and tread per lap from the lap history, and what the race still needs */
export function fuelStrategy(t: CarTelemetry, laps: LapRecord[], L: number): FuelStrategy {
  const recent = laps.filter((l) => Number.isFinite(l.fuelKg)).slice(-AVG_LAPS);
  const n = recent.length;
  const mean = (f: (l: LapRecord) => number) => (n ? recent.reduce((s, l) => s + f(l), 0) / n : null);
  const avgFuelKg = mean((l) => l.fuelKg);
  const hasFuel = t.fuelKg > 0.01;
  const me = t.race?.standings.find((s) => s.isPlayer);
  const raceLapsLeft =
    t.race?.totalLaps && t.race.phase !== "finished"
      ? Math.max(0, t.race.totalLaps - (me?.raceDistM !== undefined ? me.raceDistM / L : t.race.lap - 1 + t.trackProgress))
      : null;
  const lapsOfFuel = hasFuel && avgFuelKg && avgFuelKg > 0.001 ? t.fuelKg / avgFuelKg : null;
  const targetKg = hasFuel && raceLapsLeft && raceLapsLeft > 0.05 ? t.fuelKg / raceLapsLeft : null;
  const short = avgFuelKg !== null && targetKg !== null && avgFuelKg > targetKg;
  const saveKg = short ? avgFuelKg - targetKg : null;
  return {
    hasFuel,
    fuelKg: t.fuelKg,
    avgFuelKg: hasFuel ? avgFuelKg : null,
    avgErsPct: mean((l) => l.ersPct),
    avgWearPct: mean((l) => l.wearPct),
    lapsOfFuel,
    raceLapsLeft,
    targetKg,
    saveKg,
    // Coasting saves the full-throttle flow for as long as the driver is off the pedal
    liftS: saveKg !== null ? saveKg / VF26_CHASSIS.fuelFlowKgS : null,
    marginKg: hasFuel && avgFuelKg !== null && raceLapsLeft !== null ? t.fuelKg - avgFuelKg * raceLapsLeft : null,
    samples: n,
  };
}
