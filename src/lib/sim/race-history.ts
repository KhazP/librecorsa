/**
 * The player's last races, kept in this browser: when, where, in what, what kind of race, from where on the grid to
 * where at the flag, the best lap, the race time and the penalties. Nothing is replayed from it. The storage is
 * wrapped so a private window or a full quota never breaks the results screen.
 */
import type { RaceResultEntry } from "@/types/f1";

const STORAGE_KEY = "librecorsa.raceHistory";
/** Races kept, newest first */
export const RACE_HISTORY_MAX = 50;

/** As the usage modes name them */
export type RaceKind = "ai_race" | "open_race" | "room_race";

export interface RaceRecord {
  /** One race (its result is saved again as it firms up) */
  id: string;
  /** When the player took the flag (epoch ms) */
  atMs: number;
  trackId: string;
  carId: string;
  kind: RaceKind;
  /** Place on the grid (1 = pole); null when not known */
  grid: number | null;
  /** Place at the flag; null for a retirement */
  finish: number | null;
  fieldSize: number;
  bestLapMs: number | null;
  /** Race time at the flag, penalties included (s); null for a retirement */
  raceTimeS: number | null;
  penaltyS: number;
  /** The classification was final when last saved */
  final: boolean;
}

export type HistoryStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): HistoryStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const KINDS: readonly RaceKind[] = ["ai_race", "open_race", "room_race"];
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored record as it was saved, or null for anything else */
function parseRecord(v: unknown): RaceRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.trackId !== "string" || typeof r.carId !== "string") return null;
  if (!KINDS.includes(r.kind as RaceKind) || numOrNull(r.atMs) === null || numOrNull(r.fieldSize) === null) return null;
  return {
    id: r.id,
    atMs: r.atMs as number,
    trackId: r.trackId,
    carId: r.carId,
    kind: r.kind as RaceKind,
    grid: numOrNull(r.grid),
    finish: numOrNull(r.finish),
    fieldSize: r.fieldSize as number,
    bestLapMs: numOrNull(r.bestLapMs),
    raceTimeS: numOrNull(r.raceTimeS),
    penaltyS: numOrNull(r.penaltyS) ?? 0,
    final: r.final === true,
  };
}

/** The saved races, newest first (empty when there are none or storage is unavailable) */
export function loadRaceHistory(storage: HistoryStorage | null = browserStorage()): RaceRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map(parseRecord).filter((r): r is RaceRecord => r !== null).slice(0, RACE_HISTORY_MAX);
  } catch {
    return [];
  }
}

/**
 * Saves a race: a record with the same id is replaced where it stands (a provisional result firming up), a new one
 * goes first; the oldest beyond the last 50 are dropped. Returns the list as now saved (or as it would be, when
 * storage fails).
 */
export function saveRaceRecord(record: RaceRecord, storage: HistoryStorage | null = browserStorage()): RaceRecord[] {
  const list = loadRaceHistory(storage);
  const at = list.findIndex((r) => r.id === record.id);
  const next = at >= 0 ? list.map((r, i) => (i === at ? record : r)) : [record, ...list].slice(0, RACE_HISTORY_MAX);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Full or blocked: the race is shown, not kept
  }
  return next;
}

/** The player's record of a race from its classification; null while the player has no row in it */
export function recordFromResults(
  results: readonly RaceResultEntry[],
  final: boolean,
  meta: { id: string; atMs: number; trackId: string; carId: string; kind: RaceKind }
): RaceRecord | null {
  const me = results.find((r) => r.isPlayer);
  if (!me) return null;
  const out = me.dnf || me.finishTimeS === null;
  return {
    ...meta,
    grid: me.gridPosition ?? null,
    finish: out ? null : me.position,
    fieldSize: results.length,
    bestLapMs: me.bestLapMs,
    raceTimeS: out ? null : me.finishTimeS,
    penaltyS: me.penaltyS ?? 0,
    final,
  };
}

/** Places gained (+) or lost (−) from the grid to the flag; null when either is not known */
export const placesGained = (grid: number | null | undefined, finish: number | null | undefined): number | null =>
  grid == null || finish == null ? null : grid - finish;
