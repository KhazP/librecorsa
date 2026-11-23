/**
 * Reading the online boards a page at a time, and their totals (cloudflare/api/board.ts and stats.ts). Kept free of
 * the simulator (no ghost store, no lap recorder), so the home page can load it on its own when its board comes into
 * view. Every answer is checked before use; anything malformed reads as "could not be read".
 *
 *   fetchBoardPage     one page of a circuit's board, for one car or every car, and where a driver stands on it
 *   fetchCircuitTotals a circuit's laps and drivers ("1,204 laps · 312 drivers")
 *   fetchSiteStats     tabs in view now and drivers to date (the title screen's line)
 */
import { text as t } from "@/lib/text";
import { isVehicleModelId, type AssistPreset, type VehicleModelId } from "@/types/f1";
import { currentBoardBase, lapPhysicsVersion, MAX_LAP_REVISION, parseLapConditions, revisionOnBoard, type LeaderboardEntry } from "@/lib/sim/lap-types";
import type { SimRealism } from "@/lib/sim/sim-realism";
import { getOnlineConfig, onlineUrl } from "./online-config";

/** The board of every car on a circuit */
export const ALL_CARS = "all";
/** One car's board, or every car's */
export type BoardCar = VehicleModelId | typeof ALL_CARS;

/** Rows on a page of a board */
export const BOARD_PAGE_SIZE = 20;

const REQUEST_TIMEOUT_MS = 8000;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const MAX_CODE_LENGTH = 16;
const MAX_TRACK_ID_LENGTH = 64;
const MAX_COUNT = 1_000_000_000;

/** Narrows the online board to laps driven a certain way; absent fields take every lap */
export interface BoardFilter {
  assists?: AssistPreset;
  realism?: SimRealism;
  surface?: "dry" | "wet";
}

/** One page of a board as fetched */
export interface BoardPage {
  /** The page's rows, in the board's order: the first is in place `offset + 1` */
  entries: LeaderboardEntry[];
  /** Places before the page's first row */
  offset: number;
  /** Drivers on the board (with the filter applied) */
  total: number;
  /**
   * Where the driver asked about stands: their rank (1 + the drivers faster, a tie shares it), their place in the
   * board's order (`pos`, which the pages follow), their lap, and the best lap of the place above (null at the top).
   * Null when they have no lap here.
   */
  me: { rank: number; pos: number; entry: LeaderboardEntry; aboveMs: number | null } | null;
  /** The places either side of the driver's, from place `pos` (asked for with `near`) */
  near: { pos: number; entries: LeaderboardEntry[] } | null;
  /** Physics revisions this car has laps under, newest first (none for every car's board) */
  physics: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string no longer than max, or null */
export function cappedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A whole count the server says, or null */
const count = (value: unknown): number | null => {
  const n = finiteNumber(value);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT ? n : null;
};

export function clampLimit(limit: number, fallback = BOARD_PAGE_SIZE): number {
  return Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit))) : fallback;
}

/**
 * Validates one board row; null when a field is missing or malformed, or it belongs on another board: another
 * circuit, a car or revision `fits` turns down, or laps outside the filter
 */
export function parseBoardEntry(
  raw: unknown,
  trackId: string,
  fits: (vehicle: VehicleModelId, physics: number) => boolean,
  filter: BoardFilter,
): LeaderboardEntry | null {
  if (!isRecord(raw)) return null;
  const name = cappedString(raw.name, MAX_NAME_LENGTH);
  const code = cappedString(raw.code, MAX_CODE_LENGTH);
  const entryTrack = cappedString(raw.trackId, MAX_TRACK_ID_LENGTH);
  const lapTimeMs = finiteNumber(raw.lapTimeMs);
  const recordedAt = finiteNumber(raw.recordedAt);
  const sectors = Array.isArray(raw.sectorTimesMs) ? raw.sectorTimesMs : null;
  if (!sectors || sectors.length !== 3) return null;
  const s0 = finiteNumber(sectors[0]);
  const s1 = finiteNumber(sectors[1]);
  const s2 = finiteNumber(sectors[2]);
  if (!name || !code || !entryTrack || lapTimeMs === null || lapTimeMs <= 0 || recordedAt === null) return null;
  if (s0 === null || s1 === null || s2 === null || s0 < 0 || s1 < 0 || s2 < 0) return null;
  if (entryTrack !== trackId || !isVehicleModelId(raw.vehicle)) return null;
  if (raw.id !== undefined && cappedString(raw.id, MAX_ID_LENGTH) === null) return null;
  const conditions = parseLapConditions(raw.conditions);
  if (!conditions || !fits(raw.vehicle, conditions.physicsVersion)) return null;
  if (filter.assists && conditions.assists !== filter.assists) return null;
  if (filter.realism && conditions.realism !== filter.realism) return null;
  if (filter.surface && conditions.surface !== filter.surface) return null;

  const entry: LeaderboardEntry = {
    name,
    code,
    lapTimeMs,
    sectorTimesMs: [s0, s1, s2],
    vehicle: raw.vehicle,
    trackId: entryTrack,
    recordedAt,
    source: "remote",
    conditions,
  };
  if (typeof raw.id === "string") entry.id = raw.id;
  if (raw.hasSetup === true) entry.hasSetup = true;
  return entry;
}

/** A lap revision as a board may say it */
const isRevision = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LAP_REVISION;

/**
 * Which rows belong on a board: one car's on the revision asked for; every car's on the revision the server says it
 * ranks that car under on the board asked for (`current`), which a browser on the LC26's older engine would not work
 * out the same. Without that list (an older server), this build's own for that board.
 */
function boardFits(car: BoardCar, physics: number, current: unknown, version: number): (vehicle: VehicleModelId, physics: number) => boolean {
  if (car !== ALL_CARS) return (vehicle, p) => vehicle === car && p === physics;
  const said = isRecord(current) ? current : {};
  return (vehicle, p) => {
    const v = said[vehicle];
    return p === (isRevision(v) ? v : revisionOnBoard(version, vehicle));
  };
}

/**
 * An answer of GET /api/laps, validated; null when it is not one. `version`: the board every car's rows were read from
 * (its base revision, lap-types.ts `BoardChoice`), the one laps on the circuit go on now by default
 */
export function parseBoardPage(
  body: unknown,
  trackId: string,
  car: BoardCar,
  physics: number,
  filter: BoardFilter,
  limit: number = BOARD_PAGE_SIZE,
  version: number = currentBoardBase(trackId),
): BoardPage | null {
  if (!isRecord(body) || !Array.isArray(body.laps)) return null;
  const fits = boardFits(car, physics, body.current, version);
  const entries: LeaderboardEntry[] = [];
  for (const row of body.laps.slice(0, clampLimit(limit))) {
    const entry = parseBoardEntry(row, trackId, fits, filter);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
  const offset = count(body.offset) ?? 0;
  const total = count(body.total);
  let me: BoardPage["me"] = null;
  if (isRecord(body.me)) {
    const rank = count(body.me.rank);
    const entry = parseBoardEntry(body.me.lap, trackId, fits, filter);
    const above = finiteNumber(body.me.aboveMs);
    // Only a time faster than the player's own is the place above
    const aboveMs = entry && above !== null && above > 0 && above < entry.lapTimeMs ? above : null;
    if (entry && rank !== null && rank >= 1) {
      const pos = count(body.me.pos);
      me = { rank, pos: pos !== null && pos >= rank ? pos : rank, entry, aboveMs };
    }
  }
  let near: BoardPage["near"] = null;
  if (me && isRecord(body.near) && Array.isArray(body.near.laps)) {
    const from = count(body.near.pos);
    const around = body.near.laps.slice(0, 11).map((row) => parseBoardEntry(row, trackId, fits, filter));
    if (from !== null && from >= 1 && around.every((e) => e !== null)) near = { pos: from, entries: around as LeaderboardEntry[] };
  }
  const revisions = Array.isArray(body.physics)
    ? body.physics.filter(isRevision).slice(0, 20)
    : [];
  const atLeast = offset + entries.length;
  return { entries, offset, total: total !== null && total >= atLeast ? total : atLeast, me, near, physics: revisions };
}

/**
 * fetch() with an 8 s timeout; null on a network error, a timeout or an unreadable body. `shared`: an answer that is
 * the same for everyone, which the browser may keep as briefly as the server says; anything else is never kept.
 */
export async function requestJson(url: string, init: RequestInit, shared = false): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, credentials: "omit", cache: shared ? "default" : "no-store" });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One page of a circuit's online board: one car's (on `physics`, else its revision on the board of base revision
 * `version`, else the revision this browser drives it under there) or every car's (on their revisions on `version`'s
 * board, else the one laps go on now), optionally only laps driven a certain way; with `name`, where that driver stands
 * (and with `near`, the places either side). Null when there is no online board, or it could not be read.
 */
export async function fetchBoardPage(
  trackId: string,
  car: BoardCar,
  opts: { filter?: BoardFilter; physics?: number; version?: number; name?: string; event?: string; offset?: number; limit?: number; near?: number } = {},
): Promise<BoardPage | null> {
  const base = onlineUrl("/laps");
  if (!base || !(await getOnlineConfig()).board) return null;
  const filter = opts.filter ?? {};
  const version = opts.version ?? currentBoardBase(trackId);
  const physics = car === ALL_CARS ? 0 : (opts.physics ?? (opts.version !== undefined ? revisionOnBoard(version, car) : lapPhysicsVersion(car, trackId)));
  const limit = clampLimit(opts.limit ?? BOARD_PAGE_SIZE);
  // The parameters in one fixed order: the edge keeps one copy per address, and the order is part of it. Every car's
  // board laps go on now keeps the address it always had
  const query = new URLSearchParams({ track: trackId, vehicle: car });
  if (car !== ALL_CARS) query.set("physics", String(physics));
  else if (version !== currentBoardBase(trackId)) query.set("version", String(version));
  query.set("limit", String(limit));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  if (offset > 0) query.set("offset", String(offset));
  if (filter.assists) query.set("assists", filter.assists);
  if (filter.realism) query.set("realism", filter.realism);
  if (filter.surface) query.set("surface", filter.surface);
  if (opts.event) query.set("event", opts.event);
  const name = opts.name?.trim().slice(0, MAX_NAME_LENGTH);
  if (name) query.set("name", name);
  if (name && opts.near) query.set("near", String(Math.min(5, Math.max(1, Math.floor(opts.near)))));
  const res = await requestJson(`${base}?${query.toString()}`, { method: "GET" }, !name);
  if (!res || res.status < 200 || res.status >= 300) return null;
  return parseBoardPage(res.body, trackId, car, physics, filter, limit, version);
}

/** A circuit's laps and drivers */
export interface CircuitTotals {
  /** Laps driven there (in that car), every revision: an honest lower bound */
  laps: number;
  /** Drivers on its board (that car's, or every car's), with no filter */
  drivers: number;
}

/**
 * A circuit's totals, for one car (on `physics`) or every car (on the board of base revision `version`, the one laps go
 * on now by default); null without an online board or when unreadable
 */
export async function fetchCircuitTotals(trackId: string, car: BoardCar, physics?: number, version: number = currentBoardBase(trackId)): Promise<CircuitTotals | null> {
  const base = onlineUrl("/stats/circuit");
  if (!base || !(await getOnlineConfig()).board) return null;
  const query = new URLSearchParams({ track: trackId, vehicle: car });
  if (car !== ALL_CARS && physics !== undefined) query.set("physics", String(physics));
  else if (car === ALL_CARS && version !== currentBoardBase(trackId)) query.set("version", String(version));
  const res = await requestJson(`${base}?${query.toString()}`, { method: "GET" }, true);
  if (!res || res.status !== 200 || !isRecord(res.body) || res.body.ok !== true) return null;
  const laps = count(res.body.laps);
  const drivers = count(res.body.drivers);
  return laps !== null && drivers !== null ? { laps, drivers } : null;
}

/** The title screen's numbers: tabs with the game in view, and drivers to date; each null when off */
export interface SiteStats {
  live: number | null;
  drivers: number | null;
}

/** Null when there is no online side, both parts are off, or it could not be read */
export async function fetchSiteStats(): Promise<SiteStats | null> {
  const url = onlineUrl("/stats");
  if (!url) return null;
  const config = await getOnlineConfig();
  if (!config.board && !config.live) return null;
  const res = await requestJson(url, { method: "GET" }, true);
  if (!res || res.status !== 200 || !isRecord(res.body) || res.body.ok !== true) return null;
  const stats = { live: config.live ? count(res.body.live) : null, drivers: config.board ? count(res.body.drivers) : null };
  return stats.live === null && stats.drivers === null ? null : stats;
}

const ASSIST_LABEL = { pro: "game.board.assistsPro", semi_pro: "game.board.assistsSemiPro", assisted: "game.board.assistsAssisted" } as const satisfies Record<AssistPreset, string>;
const REALISM_LABEL = { casual: "game.board.realismCasual", standard: "game.board.realismStandard", full: "game.board.realismFull" } as const satisfies Record<SimRealism, string>;

/** "No assists · Full · Dry": what a lap was driven with */
export function boardLabel(c: { assists: AssistPreset; realism: SimRealism; surface: "dry" | "wet" }): string {
  return t("game.board.conditions", {
    assists: t(ASSIST_LABEL[c.assists]),
    realism: t(REALISM_LABEL[c.realism]),
    surface: t(c.surface === "wet" ? "game.board.surfaceWet" : "game.board.surfaceDry"),
  });
}

/** "1,204": a count as the panels say it, grouped by thousands */
export const formatCount = (n: number): string => n.toLocaleString("en-US");

/** The driver key of a name, as the board compares names: outer spaces off, inner runs as one, lower case */
export function driverNameKey(name: string): string {
  return name.replace(/^ +| +$/g, "").replace(/[ \t\n\r\f\v]+/g, " ").toLowerCase();
}

/** Browser storage key for the player's saved online leaderboard filter toggles */
export const BOARD_FILTER_PREFS_KEY = "librecorsa.boardFilters";

/** Saved toggle state for OnlineBoard filters (unfiltered by default) */
export interface BoardFilterPrefs {
  noAssists: boolean;
  fullRealism: boolean;
  wetOnly: boolean;
}

export const DEFAULT_BOARD_FILTER_PREFS: Readonly<BoardFilterPrefs> = {
  noAssists: false,
  fullRealism: false,
  wetOnly: false,
};

/** Validates a raw stored filter object; malformed or missing fields fall back to off */
export function parseBoardFilterPrefs(raw: unknown): BoardFilterPrefs {
  if (!isRecord(raw)) return { ...DEFAULT_BOARD_FILTER_PREFS };
  return {
    noAssists: raw.noAssists === true,
    fullRealism: raw.fullRealism === true,
    wetOnly: raw.wetOnly === true,
  };
}

/** Reads saved online leaderboard filters from localStorage (SSR and private-mode safe) */
export function loadBoardFilterPrefs(): BoardFilterPrefs {
  try {
    if (typeof window === "undefined" || !window.localStorage) return { ...DEFAULT_BOARD_FILTER_PREFS };
    const text = window.localStorage.getItem(BOARD_FILTER_PREFS_KEY);
    if (!text) return { ...DEFAULT_BOARD_FILTER_PREFS };
    return parseBoardFilterPrefs(JSON.parse(text));
  } catch {
    return { ...DEFAULT_BOARD_FILTER_PREFS };
  }
}

/** Saves online leaderboard filters to localStorage (clears the key when every toggle is off) */
export function saveBoardFilterPrefs(prefs: BoardFilterPrefs): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (!prefs.noAssists && !prefs.fullRealism && !prefs.wetOnly) {
      window.localStorage.removeItem(BOARD_FILTER_PREFS_KEY);
    } else {
      window.localStorage.setItem(
        BOARD_FILTER_PREFS_KEY,
        JSON.stringify({
          noAssists: prefs.noAssists,
          fullRealism: prefs.fullRealism,
          wetOnly: prefs.wetOnly,
        }),
      );
    }
  } catch {
    // Storage unavailable or quota exceeded
  }
}
