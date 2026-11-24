import { loadRaceHistory } from "./race-history";
import { listBestLaps } from "./ghost-store";

export interface DriverStats {
  version: 1;
  totalDrivingS: number;
  totalDistanceM: number;
  racesCompleted: number;
  wins: number;
  podiums: number;
  fastestLaps: number;
  totalFinishPosSum: number;
  longestRaceLaps: number;
  wetDistanceM: number;
  carUsageS: Record<string, number>;
  trackUsageS: Record<string, number>;
}

const STATS_KEY = "lc_driver_stats_v1";

export function emptyDriverStats(): DriverStats {
  return {
    version: 1,
    totalDrivingS: 0,
    totalDistanceM: 0,
    racesCompleted: 0,
    wins: 0,
    podiums: 0,
    fastestLaps: 0,
    totalFinishPosSum: 0,
    longestRaceLaps: 0,
    wetDistanceM: 0,
    carUsageS: {},
    trackUsageS: {},
  };
}

function seedFromRaceHistory(base: DriverStats): DriverStats {
  if (base.racesCompleted > 0) return base;
  const races = loadRaceHistory();
  if (races.length === 0) return base;
  const next = { ...base, carUsageS: { ...base.carUsageS }, trackUsageS: { ...base.trackUsageS } };
  for (const r of races) {
    if (r.finish !== null) {
      next.racesCompleted += 1;
      next.totalFinishPosSum += r.finish;
      if (r.finish === 1) next.wins += 1;
      if (r.finish >= 1 && r.finish <= 3) next.podiums += 1;
    }
    const durS = r.raceTimeS ?? (r.bestLapMs ? r.bestLapMs / 1000 : 0);
    if (durS > 0) {
      next.totalDrivingS += durS;
      next.carUsageS[r.carId] = (next.carUsageS[r.carId] ?? 0) + durS;
      next.trackUsageS[r.trackId] = (next.trackUsageS[r.trackId] ?? 0) + durS;
    }
  }
  return next;
}

export function loadDriverStats(): DriverStats {
  if (typeof window === "undefined") return emptyDriverStats();
  try {
    const raw = window.localStorage.getItem(STATS_KEY);
    if (!raw) {
      const seeded = seedFromRaceHistory(emptyDriverStats());
      if (seeded.racesCompleted > 0) saveDriverStats(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw) as Partial<DriverStats>;
    if (parsed?.version !== 1) return seedFromRaceHistory(emptyDriverStats());
    return seedFromRaceHistory({ ...emptyDriverStats(), ...parsed });
  } catch {
    return emptyDriverStats();
  }
}

export async function hydrateDriverStatsFromBestLaps(): Promise<DriverStats> {
  const s = loadDriverStats();
  if (s.totalDistanceM > 0 && s.totalDrivingS > 0) return s;
  try {
    const summaries = await listBestLaps();
    if (summaries.length === 0) return s;
    const next = { ...s, carUsageS: { ...s.carUsageS }, trackUsageS: { ...s.trackUsageS } };
    for (const lap of summaries) {
      const lapS = lap.lapTimeMs / 1000;
      const distM = lap.trackLengthM && lap.trackLengthM > 0 ? lap.trackLengthM : 4000;
      if (s.totalDistanceM === 0) next.totalDistanceM += distM;
      if (s.totalDrivingS === 0) next.totalDrivingS += lapS;
      if (Object.keys(s.carUsageS).length === 0) {
        next.carUsageS[lap.vehicle] = (next.carUsageS[lap.vehicle] ?? 0) + lapS;
      }
      if (Object.keys(s.trackUsageS).length === 0) {
        next.trackUsageS[lap.trackId] = (next.trackUsageS[lap.trackId] ?? 0) + lapS;
      }
    }
    saveDriverStats(next);
    return next;
  } catch {
    return s;
  }
}

export function saveDriverStats(stats: DriverStats): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // ignore quota errors
  }
}

export function averageFinishOf(stats: DriverStats): string {
  if (stats.racesCompleted <= 0) return "—";
  return `P${(stats.totalFinishPosSum / stats.racesCompleted).toFixed(1)}`;
}

export function topKeyOf(map: Record<string, number>): string | null {
  let best: string | null = null;
  let bestVal = 0;
  for (const [k, v] of Object.entries(map)) {
    if (v > bestVal) {
      bestVal = v;
      best = k;
    }
  }
  return best;
}

export function recordDrivingSlice(drivingS: number, carId: string, trackId: string): void {
  if (drivingS <= 0.5) return;
  const s = loadDriverStats();
  s.totalDrivingS += drivingS;
  s.carUsageS[carId] = (s.carUsageS[carId] ?? 0) + drivingS;
  s.trackUsageS[trackId] = (s.trackUsageS[trackId] ?? 0) + drivingS;
  saveDriverStats(s);
}

export function recordLapStats(distanceM: number, drivingS: number, carId: string, trackId: string): void {
  const s = loadDriverStats();
  if (distanceM > 0) s.totalDistanceM += distanceM;
  if (drivingS > 0) {
    s.totalDrivingS += drivingS;
    s.carUsageS[carId] = (s.carUsageS[carId] ?? 0) + drivingS;
    s.trackUsageS[trackId] = (s.trackUsageS[trackId] ?? 0) + drivingS;
  }
  saveDriverStats(s);
}

export function recordRaceStats(position: number, fastestLap: boolean, totalLaps: number): void {
  const s = loadDriverStats();
  s.racesCompleted += 1;
  if (position === 1) s.wins += 1;
  if (position >= 1 && position <= 3) s.podiums += 1;
  if (fastestLap) s.fastestLaps += 1;
  if (position > 0) s.totalFinishPosSum += position;
  if (totalLaps > s.longestRaceLaps) s.longestRaceLaps = totalLaps;
  saveDriverStats(s);
}
