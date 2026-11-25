/**
 * The player's own totals across every session, shown under Settings > Profile and data > Driver: time driven and the
 * distance of the laps completed, per car and circuit, and the races. Kept in this browser and synced with the account
 * (save-model.ts), like the race history they count from.
 *
 * A race is counted from its race-history record as that is saved (useRaceHistory), by the record's id: a result that
 * firms up (a penalty, the rest of the field finishing) replaces what it counted instead of adding to it. Until the
 * totals are first written they are read from the races already in the history (their race times as time driven, no
 * distance), so a returning player sees them at once and the race on track is not counted twice. Storage is wrapped so
 * a private window or a full quota never breaks the game.
 */
import { loadRaceHistory, RACE_HISTORY_MAX, type HistoryStorage, type RaceRecord } from "./race-history";

export const DRIVER_STATS_KEY = "librecorsa.driverStats";

/** What one race added to the totals, kept for the last races so a result saved again replaces it */
interface CountedRace {
  id: string;
  /** Place at the flag; null for a retirement */
  finish: number | null;
  /** The player set the race's fastest lap */
  fastestLap: boolean;
}

export interface DriverStats {
  version: 1;
  /** Time driven (s): on track and not paused */
  drivingS: number;
  /** Distance of the laps completed (m) */
  distanceM: number;
  /** Races with a result, retirements included */
  races: number;
  /** Races the player was classified in */
  finishes: number;
  wins: number;
  podiums: number;
  /** Races in which the player set the fastest lap */
  fastestLaps: number;
  /** The finishing places added up, for the average */
  finishSum: number;
  /** Time driven per car id and per circuit id (s) */
  carS: Record<string, number>;
  trackS: Record<string, number>;
  /** The last races counted, newest first */
  counted: CountedRace[];
}

export const emptyDriverStats = (): DriverStats => ({
  version: 1,
  drivingS: 0,
  distanceM: 0,
  races: 0,
  finishes: 0,
  wins: 0,
  podiums: 0,
  fastestLaps: 0,
  finishSum: 0,
  carS: {},
  trackS: {},
  counted: [],
});

const browserStorage = (): HistoryStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function times(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (count(s) > 0) out[k] = count(s);
  return out;
}

function parseCounted(v: unknown): CountedRace[] {
  if (!Array.isArray(v)) return [];
  const out: CountedRace[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string") continue;
    const finish = typeof r.finish === "number" && Number.isFinite(r.finish) && r.finish >= 1 ? r.finish : null;
    out.push({ id: r.id, finish, fastestLap: r.fastestLap === true });
  }
  return out.slice(0, RACE_HISTORY_MAX);
}

/** Stored totals as they were saved; null for anything else */
function parseStats(raw: string): DriverStats | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || (v as { version?: unknown }).version !== 1) return null;
    const r = v as Record<string, unknown>;
    return {
      version: 1,
      drivingS: count(r.drivingS),
      distanceM: count(r.distanceM),
      races: count(r.races),
      finishes: count(r.finishes),
      wins: count(r.wins),
      podiums: count(r.podiums),
      fastestLaps: count(r.fastestLaps),
      finishSum: count(r.finishSum),
      carS: times(r.carS),
      trackS: times(r.trackS),
      counted: parseCounted(r.counted),
    };
  } catch {
    return null;
  }
}

/** Adds (sign 1) or takes back (sign -1) what one race counts */
function applyRace(s: DriverStats, race: CountedRace, sign: 1 | -1): void {
  s.races += sign;
  if (race.finish !== null) {
    s.finishes += sign;
    s.finishSum += sign * race.finish;
    if (race.finish === 1) s.wins += sign;
    if (race.finish <= 3) s.podiums += sign;
  }
  if (race.fastestLap) s.fastestLaps += sign;
}

function addTime(s: DriverStats, seconds: number, carId: string, trackId: string): void {
  s.drivingS += seconds;
  s.carS[carId] = (s.carS[carId] ?? 0) + seconds;
  s.trackS[trackId] = (s.trackS[trackId] ?? 0) + seconds;
}

/** The totals the race history already holds (it does not say who set the fastest lap) */
export function statsFromHistory(history: readonly RaceRecord[]): DriverStats {
  const s = emptyDriverStats();
  for (const r of history.slice(0, RACE_HISTORY_MAX)) {
    const race: CountedRace = { id: r.id, finish: r.finish, fastestLap: false };
    applyRace(s, race, 1);
    s.counted.push(race);
    if (r.raceTimeS !== null && r.raceTimeS > 0) addTime(s, r.raceTimeS, r.carId, r.trackId);
  }
  return s;
}

/** The totals as saved, or, before they were first written, as the race history has them */
export function loadDriverStats(storage: HistoryStorage | null = browserStorage()): DriverStats {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(DRIVER_STATS_KEY) ?? null;
  } catch {
    // Blocked: read as never written
  }
  return (raw !== null ? parseStats(raw) : null) ?? statsFromHistory(loadRaceHistory(storage));
}

function updateStats(change: (s: DriverStats) => void, storage: HistoryStorage | null): DriverStats {
  const s = loadDriverStats(storage);
  change(s);
  try {
    storage?.setItem(DRIVER_STATS_KEY, JSON.stringify(s));
  } catch {
    // Full or blocked: the totals are shown, not kept
  }
  return s;
}

/** Time on track, driving and not paused (s), with the car and circuit it was in */
export function recordDrivingTime(
  seconds: number,
  carId: string,
  trackId: string,
  storage: HistoryStorage | null = browserStorage(),
): void {
  // Under a second is a menu toggled over the car, not driving
  if (!Number.isFinite(seconds) || seconds < 1) return;
  updateStats((s) => addTime(s, seconds, carId, trackId), storage);
}

/** A completed lap's distance (m) */
export function recordLapDistance(distanceM: number, storage: HistoryStorage | null = browserStorage()): void {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return;
  updateStats((s) => {
    s.distanceM += distanceM;
  }, storage);
}

/**
 * A race's result, each time its race-history record is saved: the first time it is added, after that it replaces
 * what it counted before
 */
export function recordRaceResult(
  record: Pick<RaceRecord, "id" | "finish">,
  fastestLap: boolean,
  storage: HistoryStorage | null = browserStorage(),
): DriverStats {
  return updateStats((s) => {
    const before = s.counted.find((c) => c.id === record.id);
    if (before) applyRace(s, before, -1);
    const race: CountedRace = { id: record.id, finish: record.finish, fastestLap };
    applyRace(s, race, 1);
    s.counted = [race, ...s.counted.filter((c) => c.id !== record.id)].slice(0, RACE_HISTORY_MAX);
  }, storage);
}

/** Average place at the flag over the races finished; null before the first */
export const averageFinish = (s: DriverStats): number | null => (s.finishes > 0 ? s.finishSum / s.finishes : null);

/** The id with the most time; null when nothing has any */
export function mostDriven(times: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  let bestS = 0;
  for (const [id, s] of Object.entries(times)) {
    if (s > bestS) {
      bestS = s;
      best = id;
    }
  }
  return best;
}
