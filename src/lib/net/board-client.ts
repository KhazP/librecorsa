/**
 * Reading the online boards a page at a time, and their totals (cloudflare/api/board.ts and stats.ts). Kept free of
 * the simulator (no ghost store, no lap recorder), so the home page can load it on its own when its board comes into
 * view. Every answer is checked before use; anything malformed reads as "could not be read".
 *
 *   fetchBoardPage     one page of a circuit's board, for one car or every car, and where a driver stands on it
 *   fetchCircuitTotals a circuit's laps and drivers ("1,204 laps · 312 drivers")
 *   fetchSiteStats     tabs in view now and drivers to date (the title screen's line)
 *   fetchPopular       the circuits and cars driven most this past month, as ranks (the browsers' Most driven sort)
 *   fetchSiteTotals    hours, laps, countries and drivers to date (the press page)
 *   fetchPublicStats   public aggregate stats for /stats (all-time totals, 30-day breakdown, boards and open races)
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
  // A mod circuit has no board (its laps never go up): empty, without asking
  if (trackId.startsWith("mod:")) return { entries: [], offset: 0, total: 0, me: null, near: null, physics: [] };
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
  if (trackId.startsWith("mod:")) return { laps: 0, drivers: 0 };
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

/** The circuits and cars driven most over the last `days` days, most first; ids below the server's floor are left out */
export interface PopularRanks {
  days: number;
  circuits: string[];
  cars: VehicleModelId[];
}

const MAX_RANKED = 500;
const TRACK_ID = /^[a-z0-9_-]+$/;

/** Null when there is no online side, the usage totals are off, or it could not be read */
export async function fetchPopular(): Promise<PopularRanks | null> {
  const url = onlineUrl("/stats/popular");
  if (!url || !(await getOnlineConfig()).usage) return null;
  const res = await requestJson(url, { method: "GET" }, true);
  return res && res.status === 200 ? parsePopular(res.body) : null;
}

/** The server's ranks, checked: null when malformed, and any id that isn't one dropped */
export function parsePopular(body: unknown): PopularRanks | null {
  if (!isRecord(body) || body.ok !== true) return null;
  const { days, circuits, cars } = body;
  const n = count(days);
  if (n === null || n < 1 || !Array.isArray(circuits) || !Array.isArray(cars) || circuits.length > MAX_RANKED || cars.length > MAX_RANKED) return null;
  return {
    days: n,
    circuits: circuits.filter((id): id is string => cappedString(id, MAX_TRACK_ID_LENGTH) !== null && TRACK_ID.test(id)),
    cars: cars.filter(isVehicleModelId),
  };
}

/** Everything the usage totals have counted since `since` ("2026-11-11"), and drivers to date (null with the boards off) */
export interface SiteTotals {
  since: string;
  hours: number;
  laps: number;
  countries: number;
  drivers: number | null;
}

/** Null when there is no online side, the usage totals are off, nothing is counted yet, or it could not be read */
export async function fetchSiteTotals(): Promise<SiteTotals | null> {
  const url = onlineUrl("/stats/totals");
  if (!url || !(await getOnlineConfig()).usage) return null;
  const res = await requestJson(url, { method: "GET" }, true);
  return res && res.status === 200 ? parseSiteTotals(res.body) : null;
}

/** The server's totals, checked: null when malformed or before anything was counted */
export function parseSiteTotals(b: unknown): SiteTotals | null {
  if (!isRecord(b) || b.ok !== true) return null;
  const since = typeof b.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.since) ? b.since : null;
  const hours = count(b.hours);
  const laps = count(b.laps);
  const countries = count(b.countries);
  if (since === null || hours === null || laps === null || countries === null) return null;
  return { since, hours, laps, countries, drivers: count(b.drivers) };
}

export interface PublicUsageGroup {
  id: string;
  sessions: number;
  minutes: number;
  laps: number;
}

export interface PublicShareGroup {
  id: string;
  sessions: number;
  minutes: number;
}

export interface PublicCount {
  id: string;
  n: number;
}

export interface PublicStatsData {
  days: number;
  from: string;
  to: string;
  allTime: { since: string | null; hours: number; laps: number; countries: number; drivers: number | null };
  totals: { sessions: number; minutes: number; laps: number; countries: number; lapsCounted: boolean };
  perDay: { day: string; sessions: number; minutes: number; laps: number; countries: number }[];
  byCircuit: PublicUsageGroup[];
  byCar: PublicUsageGroup[];
  byMode: PublicUsageGroup[];
  byCountry: PublicUsageGroup[];
  extras: {
    input: PublicShareGroup[];
    device: PublicShareGroup[];
    weather: PublicShareGroup[];
    assists: PublicShareGroup[];
  } | null;
  boards: {
    lapsTotal: number;
    lapsInRange: number;
    driversTotal: number;
    lapsBy: {
      assists: PublicCount[];
      realism: PublicCount[];
      surface: PublicCount[];
      compound: PublicCount[];
    };
    challenges: { event: string; laps: number; drivers: number }[];
  } | null;
  races: {
    count: number;
    cars: number;
    finished: number;
    drivers: number;
    fieldMax: number;
    perDay: { day: string; races: number; cars: number }[];
    perWeek: { week: string; races: number; cars: number }[];
  } | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const nonNeg = (value: unknown): number | null => {
  const n = finiteNumber(value);
  return n !== null && n >= 0 && n <= MAX_COUNT ? n : null;
};

function parseUsageGroups(raw: unknown): PublicUsageGroup[] | null {
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const out: PublicUsageGroup[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const id = cappedString(item.id, MAX_ID_LENGTH);
    const sessions = count(item.sessions);
    const minutes = nonNeg(item.minutes);
    const laps = count(item.laps);
    if (id === null || sessions === null || minutes === null || laps === null) return null;
    out.push({ id, sessions, minutes, laps });
  }
  return out;
}

function parseShareGroups(raw: unknown): PublicShareGroup[] | null {
  if (!Array.isArray(raw) || raw.length > 50) return null;
  const out: PublicShareGroup[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const id = cappedString(item.id, MAX_ID_LENGTH);
    const sessions = count(item.sessions);
    const minutes = nonNeg(item.minutes);
    if (id === null || sessions === null || minutes === null) return null;
    out.push({ id, sessions, minutes });
  }
  return out;
}

function parsePublicCounts(raw: unknown): PublicCount[] | null {
  if (!Array.isArray(raw) || raw.length > 50) return null;
  const out: PublicCount[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const id = cappedString(item.id, MAX_ID_LENGTH);
    const n = count(item.n);
    if (id === null || n === null) return null;
    out.push({ id, n });
  }
  return out;
}

/** Public aggregate stats for /stats: null when off, unreachable, or malformed */
export async function fetchPublicStats(): Promise<PublicStatsData | null> {
  const url = onlineUrl("/stats/public");
  if (!url || !(await getOnlineConfig()).usage) return null;
  const res = await requestJson(url, { method: "GET" }, true);
  return res && res.status === 200 ? parsePublicStats(res.body) : null;
}

/** The server's public stats answer, checked: null when malformed */
export function parsePublicStats(b: unknown): PublicStatsData | null {
  if (!isRecord(b) || b.ok !== true) return null;
  const days = count(b.days);
  const from = typeof b.from === "string" && ISO_DAY.test(b.from) ? b.from : null;
  const to = typeof b.to === "string" && ISO_DAY.test(b.to) ? b.to : null;
  if (days === null || days < 1 || days > 366 || !from || !to) return null;

  if (!isRecord(b.allTime)) return null;
  const allSince = b.allTime.since === null ? null : typeof b.allTime.since === "string" && ISO_DAY.test(b.allTime.since) ? b.allTime.since : undefined;
  const allHours = count(b.allTime.hours);
  const allLaps = count(b.allTime.laps);
  const allCountries = count(b.allTime.countries);
  const allDrivers = b.allTime.drivers === null ? null : count(b.allTime.drivers);
  if (allSince === undefined || allHours === null || allLaps === null || allCountries === null || (b.allTime.drivers !== null && allDrivers === null)) return null;

  if (!isRecord(b.totals) || typeof b.totals.lapsCounted !== "boolean") return null;
  const tSessions = count(b.totals.sessions);
  const tMinutes = nonNeg(b.totals.minutes);
  const tLaps = count(b.totals.laps);
  const tCountries = count(b.totals.countries);
  if (tSessions === null || tMinutes === null || tLaps === null || tCountries === null) return null;

  if (!Array.isArray(b.perDay) || b.perDay.length > 366) return null;
  const perDay: PublicStatsData["perDay"] = [];
  for (const row of b.perDay) {
    if (!isRecord(row) || typeof row.day !== "string" || !ISO_DAY.test(row.day)) return null;
    const sessions = count(row.sessions);
    const minutes = nonNeg(row.minutes);
    const laps = count(row.laps);
    const countries = count(row.countries);
    if (sessions === null || minutes === null || laps === null || countries === null) return null;
    perDay.push({ day: row.day, sessions, minutes, laps, countries });
  }

  const byCircuit = parseUsageGroups(b.byCircuit);
  const byCar = parseUsageGroups(b.byCar);
  const byMode = parseUsageGroups(b.byMode);
  const byCountry = parseUsageGroups(b.byCountry);
  if (!byCircuit || !byCar || !byMode || !byCountry) return null;

  let extras: PublicStatsData["extras"] = null;
  if (b.extras !== null) {
    if (!isRecord(b.extras)) return null;
    const input = parseShareGroups(b.extras.input);
    const device = parseShareGroups(b.extras.device);
    const weather = parseShareGroups(b.extras.weather);
    const assists = parseShareGroups(b.extras.assists);
    if (!input || !device || !weather || !assists) return null;
    extras = { input, device, weather, assists };
  }

  let boards: PublicStatsData["boards"] = null;
  if (b.boards !== null) {
    if (!isRecord(b.boards) || !isRecord(b.boards.lapsBy) || !Array.isArray(b.boards.challenges) || b.boards.challenges.length > 50) return null;
    const lapsTotal = count(b.boards.lapsTotal);
    const lapsInRange = count(b.boards.lapsInRange);
    const driversTotal = count(b.boards.driversTotal);
    const assists = parsePublicCounts(b.boards.lapsBy.assists);
    const realism = parsePublicCounts(b.boards.lapsBy.realism);
    const surface = parsePublicCounts(b.boards.lapsBy.surface);
    const compound = parsePublicCounts(b.boards.lapsBy.compound);
    if (lapsTotal === null || lapsInRange === null || driversTotal === null || !assists || !realism || !surface || !compound) return null;
    const challenges: NonNullable<PublicStatsData["boards"]>["challenges"] = [];
    for (const c of b.boards.challenges) {
      if (!isRecord(c)) return null;
      const event = cappedString(c.event, MAX_ID_LENGTH);
      const laps = count(c.laps);
      const drivers = count(c.drivers);
      if (event === null || laps === null || drivers === null) return null;
      challenges.push({ event, laps, drivers });
    }
    boards = { lapsTotal, lapsInRange, driversTotal, lapsBy: { assists, realism, surface, compound }, challenges };
  }

  let races: PublicStatsData["races"] = null;
  if (b.races !== null) {
    if (!isRecord(b.races) || !Array.isArray(b.races.perDay) || !Array.isArray(b.races.perWeek)) return null;
    const raceCount = count(b.races.count);
    const cars = count(b.races.cars);
    const finished = count(b.races.finished);
    const drivers = count(b.races.drivers);
    const fieldMax = count(b.races.fieldMax);
    if (raceCount === null || cars === null || finished === null || drivers === null || fieldMax === null) return null;
    const racesPerDay: NonNullable<PublicStatsData["races"]>["perDay"] = [];
    for (const d of b.races.perDay) {
      if (!isRecord(d) || typeof d.day !== "string" || !ISO_DAY.test(d.day)) return null;
      const r = count(d.races);
      const c = count(d.cars);
      if (r === null || c === null) return null;
      racesPerDay.push({ day: d.day, races: r, cars: c });
    }
    const perWeek: NonNullable<PublicStatsData["races"]>["perWeek"] = [];
    for (const w of b.races.perWeek) {
      if (!isRecord(w)) return null;
      const week = cappedString(w.week, MAX_ID_LENGTH);
      const r = count(w.races);
      const c = count(w.cars);
      if (week === null || r === null || c === null) return null;
      perWeek.push({ week, races: r, cars: c });
    }
    races = { count: raceCount, cars, finished, drivers, fieldMax, perDay: racesPerDay, perWeek };
  }

  return {
    days,
    from,
    to,
    allTime: { since: allSince, hours: allHours, laps: allLaps, countries: allCountries, drivers: allDrivers },
    totals: { sessions: tSessions, minutes: tMinutes, laps: tLaps, countries: tCountries, lapsCounted: b.totals.lapsCounted },
    perDay,
    byCircuit,
    byCar,
    byMode,
    byCountry,
    extras,
    boards,
    races,
  };
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
