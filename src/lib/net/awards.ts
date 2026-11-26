/**
 * Driver badges and the weekly challenge's Hall of Fame (issue #129), as the game reads them from the online side
 * (cloudflare/api/awards.ts):
 *   fetchHallOfFame   every weekly challenge's podiums, one per physics version (V1, V2), and the most decorated drivers
 *   fetchBadges       the badges of a few drivers at once (the names on a board page), kept a few minutes
 *
 * The badges:
 *   weekly_gold / weekly_silver / weekly_bronze   first, second or third on a finished week's board, under a physics
 *                                                 version (a week driven on V1 and V2 has a podium on each)
 *   track_record (Fastest Lap, FL)                holds the fastest lap on an open board laps go on now (a circuit in
 *                                                 the game, a car on its current physics)
 *   og                                            has a lap on a Physics V1 board: drove LibreCorsa before Physics V2
 *   bulb                                          given by hand, for an idea or a contribution, with a note
 *   creator                                       the game's maker: a name held by the maker's driver key
 *   goat                                          (issue #181) at the top of the Hall of Fame's Most decorated list,
 *                                                 a tie at the top shared (goat.ts holds the rule)
 *   stig                                          holds P1 on the permanent Middle Gear Lap Board (Suzuki Liana 1.6 at
 *                                                 Dunsfold Aerodrome, current shipping physics); moves when beaten
 *
 * The types are shared with the Worker, which imports them only as types: nothing here runs on the server.
 */
import { text as t } from "@/lib/text";
import { getOnlineConfig, onlineUrl } from "./online-config";
import { driverNameKey, requestJson } from "./board-client";
import type { VehicleModelId } from "@/types/f1";
import {
  isVehicleClassId,
  VEHICLE_CLASS_IDS,
  vehicleClassOf,
  vehicleDisplayName,
  type VehicleClassId,
} from "@/lib/cars/vehicle-class";

export const BADGE_TYPES = ["creator", "goat", "stig", "weekly_gold", "weekly_silver", "weekly_bronze", "track_record", "og", "bulb"] as const;
export type BadgeType = (typeof BADGE_TYPES)[number];
export const isBadgeType = (v: unknown): v is BadgeType => (BADGE_TYPES as readonly unknown[]).includes(v);

/** The badges the owner may give by hand; the weekly medals and the GOAT come from the boards alone */
export const MANUAL_BADGE_TYPES = ["bulb", "og", "track_record"] as const satisfies readonly BadgeType[];
export type ManualBadgeType = (typeof MANUAL_BADGE_TYPES)[number];

/** The most names one badge read asks for */
export const MAX_BADGE_NAMES = 64;

/** Minimum distinct drivers on an open board before its P1 grants a Fastest Lap badge (matches cloudflare/api/awards.ts) */
export const MIN_RECORD_DRIVERS = 5;

/** One week and physics version a medal was won in */
export interface BadgeEvent {
  event: string;
  /** "v1", "v2" */
  physics: string;
}

/** One contested open board where a driver holds P1 */
export interface RecordBoard {
  trackId: string;
  vehicle: string;
  /** Fastest lap time on this board (ms), when returned by the server */
  lapTimeMs?: number;
  /** Unique drivers on this board, when returned by the server */
  drivers?: number;
}

/** One kind of badge a driver holds, with how many times */
export interface DriverBadge {
  type: BadgeType;
  count: number;
  /** The weeks of a weekly medal, newest first */
  events?: BadgeEvent[];
  /** The boards of a fastest lap: circuit, car, lap time and competition count */
  boards?: RecordBoard[];
  /** What a badge given by hand was given for (the Bulb's idea) */
  note?: string;
}

/** Where a badge pill is being shown, so Fastest Lap badges stay relevant to the car or class in view */
export type BadgeContext =
  | { scope: "all" }
  | { scope: "vehicle"; vehicle: VehicleModelId }
  | { scope: "class"; classId: VehicleClassId };

export interface ClassRecordGroup {
  classId: VehicleClassId;
  boards: RecordBoard[];
  count: number;
}

export interface VehicleRecordGroup {
  vehicle: string;
  classId: VehicleClassId | null;
  boards: RecordBoard[];
  count: number;
}

/** GET /api/badges?names=a,b: each asked name's badges, by its name key (board.ts driverNameKey) */
export interface BadgesAnswer {
  ok: true;
  badges: Record<string, DriverBadge[]>;
}

export interface PodiumPlace {
  /** 1 gold, 2 silver, 3 bronze */
  place: 1 | 2 | 3;
  name: string;
  nameKey: string;
  lapTimeMs: number | null;
}

/** One week's podium under one physics version */
export interface HallOfFameEvent {
  event: string;
  /** "v1", "v2" */
  physics: string;
  trackId: string;
  vehicle: string;
  /** The week running now: its podium can still change and wins no medal yet */
  current: boolean;
  podium: PodiumPlace[];
}

export interface DecoratedDriver {
  name: string;
  nameKey: string;
  gold: number;
  silver: number;
  bronze: number;
  total: number;
}

/** One driver in the Fastest Lap Record Holders table (overall or within one car class) */
export interface RecordHolder {
  name: string;
  nameKey: string;
  /** Number of contested Fastest Lap records held in this slice */
  count: number;
  /** Per-vehicle breakdown in this slice, most records first */
  byVehicle: { vehicle: string; count: number }[];
  /** Contested boards held in this slice, most competitive first */
  boards: RecordBoard[];
}

/** Live Fastest Lap leaders overall and per car class, from contested open boards */
export interface HallOfFameRecordHolders {
  minDrivers: number;
  overall: RecordHolder[];
  byClass: Partial<Record<VehicleClassId, RecordHolder[]>>;
}

/** GET /api/hall-of-fame */
export interface HallOfFameAnswer {
  ok: true;
  /** The week running now ("2026-W47") */
  current: string;
  /** Newest week first, V2 before V1 within a week */
  events: HallOfFameEvent[];
  /** Finished weeks only: most golds, then silvers, then bronzes */
  mostDecorated: DecoratedDriver[];
  /** Live Fastest Lap leaders on contested boards, overall and per car class */
  recordHolders: HallOfFameRecordHolders;
}

/** The badge order everywhere, as BADGE_TYPES: the Creator (who the driver is) first, the GOAT, The Stig, then medals, best first */
const ORDER: Record<BadgeType, number> = { creator: 0, goat: 1, stig: 2, weekly_gold: 3, weekly_silver: 4, weekly_bronze: 5, track_record: 6, og: 7, bulb: 8 };
export const sortBadges = (badges: readonly DriverBadge[]): DriverBadge[] => [...badges].sort((a, b) => ORDER[a.type] - ORDER[b.type]);

const BADGE_NAME: Record<BadgeType, string> = {
  get weekly_gold() { return t("game.badges.weeklyGold"); },
  get weekly_silver() { return t("game.badges.weeklySilver"); },
  get weekly_bronze() { return t("game.badges.weeklyBronze"); },
  get track_record() { return t("game.badges.fastestLap"); },
  get og() { return t("game.badges.og"); },
  get bulb() { return t("game.badges.bulb"); },
  get creator() { return t("game.badges.creator"); },
  get goat() { return t("game.badges.goat"); },
  get stig() { return t("game.badges.stig"); },
};

/** "Weekly Gold", "Idea Contributor" */
export const badgeName = (type: BadgeType): string => BADGE_NAME[type];

/** "V2" for "v2" */
export const physicsName = (physics: string): string => physics.toUpperCase();

/**
 * The words of a badge's tooltip and spoken name: "Weekly Gold ×2", "Fastest Lap ×3", "OG Driver",
 * "Idea Contributor — Wet weather tyres"
 */
export function badgeLabel(b: DriverBadge): string {
  const name = b.count > 1 ? t("game.badges.times", { badge: BADGE_NAME[b.type], count: String(b.count) }) : BADGE_NAME[b.type];
  return b.type === "bulb" && b.note ? t("game.badges.withNote", { badge: name, note: b.note }) : name;
}

const CLASS_RANK = new Map<VehicleClassId, number>(VEHICLE_CLASS_IDS.map((c, i) => [c, i]));

/** Groups a driver's Fastest Lap boards by car class, ordered by most records then class menu order */
export function groupBoardsByClass(boards: readonly RecordBoard[] | undefined): ClassRecordGroup[] {
  if (!boards || boards.length === 0) return [];
  const map = new Map<VehicleClassId, RecordBoard[]>();
  for (const b of boards) {
    const c = vehicleClassOf(b.vehicle);
    if (!c) continue;
    const list = map.get(c);
    if (list) list.push(b);
    else map.set(c, [b]);
  }
  return [...map.entries()]
    .map(([classId, list]) => ({ classId, boards: list, count: list.length }))
    .sort((a, b) => b.count - a.count || (CLASS_RANK.get(a.classId) ?? 99) - (CLASS_RANK.get(b.classId) ?? 99));
}

/** Groups a driver's Fastest Lap boards by vehicle model, ordered by most records then class order */
export function groupBoardsByVehicle(boards: readonly RecordBoard[] | undefined): VehicleRecordGroup[] {
  if (!boards || boards.length === 0) return [];
  const map = new Map<string, RecordBoard[]>();
  for (const b of boards) {
    const list = map.get(b.vehicle);
    if (list) list.push(b);
    else map.set(b.vehicle, [b]);
  }
  return [...map.entries()]
    .map(([vehicle, list]) => ({ vehicle, classId: vehicleClassOf(vehicle), boards: list, count: list.length }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.classId ? (CLASS_RANK.get(a.classId) ?? 99) : 99) - (b.classId ? (CLASS_RANK.get(b.classId) ?? 99) : 99) ||
        (a.vehicle < b.vehicle ? -1 : a.vehicle > b.vehicle ? 1 : 0),
    );
}

/**
 * Narrows a driver's badges to the board or multiplayer room in view:
 *   - `scope: "all"` keeps every Fastest Lap record
 *   - `scope: "vehicle"` keeps only Fastest Lap records in that vehicle model
 *   - `scope: "class"` keeps only Fastest Lap records in that car class
 * Non-FL badges (the GOAT, weekly medals, OG, Bulb, Creator) are never filtered out: they belong to the driver, not to
 * a car.
 */
export function filterBadgesForContext(badges: readonly DriverBadge[], context?: BadgeContext): DriverBadge[] {
  if (!context || context.scope === "all") return [...badges];
  const out: DriverBadge[] = [];
  for (const b of badges) {
    if (b.type !== "track_record") {
      out.push(b);
      continue;
    }
    const matching = (b.boards ?? []).filter((board) =>
      context.scope === "vehicle" ? board.vehicle === context.vehicle : vehicleClassOf(board.vehicle) === context.classId,
    );
    if (matching.length > 0) {
      out.push({ ...b, count: matching.length, boards: matching });
    }
  }
  return out;
}

/**
 * The badges a name typed into a room may wear. A room never checks a player's name against its claim, so the Creator
 * (which stands for who the driver is) stays off there; the rest only say what a name has done on the boards.
 */
export const roomNameBadges = (badges: readonly DriverBadge[]): DriverBadge[] => badges.filter((b) => b.type !== "creator");

/** A longer line for a tooltip: what the badge means and where it was won */
export function badgeDetail(b: DriverBadge): string {
  switch (b.type) {
    case "weekly_gold":
    case "weekly_silver":
    case "weekly_bronze": {
      const place = b.type === "weekly_gold" ? "first" : b.type === "weekly_silver" ? "second" : "third";
      const weeks = (b.events ?? []).slice(0, 4).map((e) => `${e.event} ${physicsName(e.physics)}`);
      return weeks.length
        ? t("game.badges.medalDetailWeeks", { place, weeks: `${weeks.join(", ")}${(b.events?.length ?? 0) > weeks.length ? "…" : ""}` })
        : t("game.badges.medalDetail", { place });
    }
    case "track_record": {
      const groups = groupBoardsByVehicle(b.boards);
      if (groups.length === 0) {
        return t("game.badges.recordDetailCount", { count: b.count });
      }
      const parts = groups.slice(0, 4).map((g) => t("game.badges.recordCar", { car: vehicleDisplayName(g.vehicle), count: String(g.count) }));
      const extra = groups.length > 4 ? "…" : "";
      const manual = Math.max(0, b.count - (b.boards?.length ?? 0));
      if (manual > 0) parts.push(t("game.badges.recordManual", { count: String(manual) }));
      return t("game.badges.recordDetail", { boards: `${parts.join(" · ")}${extra}` });
    }
    case "og":
      return t("game.badges.ogDetail");
    case "bulb":
      return b.note ? t("game.badges.bulbDetailNote", { note: b.note }) : t("game.badges.bulbDetail");
    case "creator":
      return t("game.badges.creatorDetail");
    case "goat":
      return t("game.badges.goatDetail");
    case "stig":
      return t("game.badges.stigDetail");
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const PHYSICS_RE = /^[a-z0-9]{1,12}$/;
const EVENT_RE = /^\d{4}-W\d{2}$/;

function parseRecordBoard(raw: unknown): RecordBoard | null {
  if (!isRecord(raw)) return null;
  const trackId = str(raw.trackId, 64);
  const vehicle = str(raw.vehicle, 32);
  if (!trackId || !vehicle) return null;
  const out: RecordBoard = { trackId, vehicle };
  if (typeof raw.lapTimeMs === "number" && Number.isFinite(raw.lapTimeMs) && raw.lapTimeMs > 0) {
    out.lapTimeMs = raw.lapTimeMs;
  }
  if (typeof raw.drivers === "number" && Number.isInteger(raw.drivers) && raw.drivers >= 1 && raw.drivers <= 1_000_000) {
    out.drivers = raw.drivers;
  }
  return out;
}

/** One badge as read from the server, or null when it doesn't hold together */
export function parseBadge(raw: unknown): DriverBadge | null {
  if (!isRecord(raw) || !isBadgeType(raw.type)) return null;
  const count = typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count >= 1 && raw.count <= 10_000 ? raw.count : 1;
  const badge: DriverBadge = { type: raw.type, count };
  if (Array.isArray(raw.events)) {
    badge.events = raw.events
      .slice(0, 200)
      .filter((e): e is BadgeEvent => isRecord(e) && typeof e.event === "string" && EVENT_RE.test(e.event) && typeof e.physics === "string" && PHYSICS_RE.test(e.physics))
      .map((e) => ({ event: e.event, physics: e.physics }));
  }
  if (Array.isArray(raw.boards)) {
    badge.boards = raw.boards.slice(0, 200).map(parseRecordBoard).filter((b): b is RecordBoard => b !== null);
  }
  const note = str(raw.note, 200);
  if (note) badge.note = note;
  return badge;
}

/** The badges of a badge read, by name key; null for an answer that isn't one */
export function parseBadges(body: unknown): Record<string, DriverBadge[]> | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.badges)) return null;
  const out: Record<string, DriverBadge[]> = Object.create(null);
  for (const [key, list] of Object.entries(body.badges).slice(0, MAX_BADGE_NAMES)) {
    if (!Array.isArray(list)) continue;
    out[key] = sortBadges(list.map(parseBadge).filter((b): b is DriverBadge => b !== null));
  }
  return out;
}

function parsePlace(raw: unknown): PodiumPlace | null {
  if (!isRecord(raw) || (raw.place !== 1 && raw.place !== 2 && raw.place !== 3)) return null;
  const name = str(raw.name, 64);
  const nameKey = str(raw.nameKey, 64);
  if (!name || nameKey === null) return null;
  const lapTimeMs = typeof raw.lapTimeMs === "number" && Number.isFinite(raw.lapTimeMs) && raw.lapTimeMs > 0 ? raw.lapTimeMs : null;
  return { place: raw.place, name, nameKey, lapTimeMs };
}

function parseRecordHolder(raw: unknown): RecordHolder | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name, 64);
  const nameKey = str(raw.nameKey, 64);
  const count = typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count >= 1 && raw.count <= 10_000 ? raw.count : null;
  if (!name || !nameKey || count === null) return null;
  const boards = Array.isArray(raw.boards)
    ? raw.boards.slice(0, 80).map(parseRecordBoard).filter((b): b is RecordBoard => b !== null)
    : [];
  const byVehicle = Array.isArray(raw.byVehicle)
    ? raw.byVehicle
        .slice(0, 32)
        .filter(
          (v): v is { vehicle: string; count: number } =>
            isRecord(v) &&
            str(v.vehicle, 32) !== null &&
            typeof v.count === "number" &&
            Number.isInteger(v.count) &&
            v.count >= 1 &&
            v.count <= 10_000,
        )
        .map((v) => ({ vehicle: v.vehicle, count: v.count }))
    : groupBoardsByVehicle(boards).map((g) => ({ vehicle: g.vehicle, count: g.count }));
  return { name, nameKey, count, byVehicle, boards };
}

function parseRecordHolders(raw: unknown): HallOfFameRecordHolders {
  const empty: HallOfFameRecordHolders = { minDrivers: MIN_RECORD_DRIVERS, overall: [], byClass: {} };
  if (!isRecord(raw)) return empty;
  const minDrivers =
    typeof raw.minDrivers === "number" && Number.isInteger(raw.minDrivers) && raw.minDrivers >= 1 && raw.minDrivers <= 1000
      ? raw.minDrivers
      : MIN_RECORD_DRIVERS;
  const overall = Array.isArray(raw.overall)
    ? raw.overall.slice(0, 50).map(parseRecordHolder).filter((h): h is RecordHolder => h !== null)
    : [];
  const byClass: Partial<Record<VehicleClassId, RecordHolder[]>> = {};
  if (isRecord(raw.byClass)) {
    for (const classId of VEHICLE_CLASS_IDS) {
      const list = raw.byClass[classId];
      if (!Array.isArray(list)) continue;
      const parsed = list.slice(0, 50).map(parseRecordHolder).filter((h): h is RecordHolder => h !== null);
      if (parsed.length > 0) byClass[classId] = parsed;
    }
  }
  return { minDrivers, overall, byClass };
}

/** The Hall of Fame as read from the server; null for an answer that isn't one */
export function parseHallOfFame(body: unknown): HallOfFameAnswer | null {
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.events)) return null;
  const events: HallOfFameEvent[] = [];
  for (const e of body.events.slice(0, 500)) {
    if (!isRecord(e) || typeof e.event !== "string" || !EVENT_RE.test(e.event) || typeof e.physics !== "string" || !PHYSICS_RE.test(e.physics)) continue;
    const podium = Array.isArray(e.podium) ? e.podium.slice(0, 3).map(parsePlace).filter((p): p is PodiumPlace => p !== null) : [];
    if (podium.length === 0) continue;
    events.push({ event: e.event, physics: e.physics, trackId: str(e.trackId, 64) ?? "", vehicle: str(e.vehicle, 32) ?? "", current: e.current === true, podium });
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
  const mostDecorated: DecoratedDriver[] = Array.isArray(body.mostDecorated)
    ? body.mostDecorated
        .slice(0, 50)
        .filter((d): d is Record<string, unknown> => isRecord(d) && str(d.name, 64) !== null && str(d.nameKey, 64) !== null)
        .map((d) => ({ name: d.name as string, nameKey: d.nameKey as string, gold: n(d.gold), silver: n(d.silver), bronze: n(d.bronze), total: n(d.total) }))
    : [];
  const recordHolders = parseRecordHolders(body.recordHolders);
  return {
    ok: true,
    current: typeof body.current === "string" && EVENT_RE.test(body.current) ? body.current : "",
    events,
    mostDecorated,
    recordHolders,
  };
}

/** The Hall of Fame; null without an online board, or when it can't be read */
export async function fetchHallOfFame(): Promise<HallOfFameAnswer | null> {
  const url = onlineUrl("/hall-of-fame");
  if (!url || !(await getOnlineConfig()).board) return null;
  const res = await requestJson(url, { method: "GET" }, true);
  if (!res || res.status !== 200) return null;
  return parseHallOfFame(res.body);
}

/** Badges read in the last few minutes, by name key: a board's pages and a re-render ask again for free */
const BADGE_KEEP_MS = 5 * 60_000;
/** Backoff after a failed or 429 badge read so UI re-renders don't hammer the rate limit */
const BADGE_FAIL_KEEP_MS = 60_000;
const kept = new Map<string, { badges: DriverBadge[]; untilMs: number }>();
const pending = new Map<string, Promise<void>>();

/** Forgets every badge kept (the checks start each case clean) */
export function forgetBadges(): void {
  kept.clear();
  pending.clear();
}

/** The names a badge read asks for: their keys, each once, in the order given, at most MAX_BADGE_NAMES */
export function badgeQueryNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = driverNameKey(name);
    if (!key || key.length > 64 || key.includes(",") || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The badges of these drivers, by name key: those kept from an earlier read, the rest in one read per 64 names. A name
 * whose read fails (offline, no online board, the API down) has no badges, and nothing goes wrong: badges are a
 * garnish on the board, never a reason it can't be shown. `fetchJson` stands in for the network in the checks.
 */
export async function fetchBadges(
  names: readonly string[],
  opts: { nowMs?: number; fetchJson?: (url: string) => Promise<{ status: number; body: unknown } | null> } = {},
): Promise<Record<string, DriverBadge[]>> {
  const nowMs = opts.nowMs ?? Date.now();
  const keys = badgeQueryNames(names);
  const missing = keys.filter((k) => !pending.has(k) && !((kept.get(k)?.untilMs ?? -Infinity) > nowMs));
  if (missing.length > 0) {
    const base = onlineUrl("/badges");
    const read =
      opts.fetchJson ??
      (async (url: string) => {
        if (!(await getOnlineConfig()).board) return null;
        return requestJson(url, { method: "GET" }, true);
      });
    for (let i = 0; i < missing.length; i += MAX_BADGE_NAMES) {
      const chunk = missing.slice(i, i + MAX_BADGE_NAMES);
      const job = (async () => {
        if (!base && !opts.fetchJson) return;
        // Sorted, so the same names make the same address and the edge keeps one copy of it
        const query = new URLSearchParams({ names: [...chunk].sort().join(",") });
        const res = await read(`${base ?? "/api/badges"}?${query.toString()}`).catch(() => null);
        const parsed = res && res.status === 200 ? parseBadges(res.body) : null;
        if (!parsed) {
          for (const k of chunk) {
            kept.set(k, { badges: kept.get(k)?.badges ?? [], untilMs: nowMs + BADGE_FAIL_KEEP_MS });
          }
          return;
        }
        for (const k of chunk) kept.set(k, { badges: Object.hasOwn(parsed, k) ? parsed[k] : [], untilMs: nowMs + BADGE_KEEP_MS });
      })();
      for (const k of chunk) pending.set(k, job);
      void job.finally(() => {
        for (const k of chunk) if (pending.get(k) === job) pending.delete(k);
      });
    }
  }
  await Promise.all(keys.map((k) => pending.get(k)).filter((p): p is Promise<void> => p !== undefined));
  const out: Record<string, DriverBadge[]> = Object.create(null);
  for (const k of keys) {
    const badges = kept.get(k)?.badges;
    if (badges && badges.length > 0) out[k] = badges;
  }
  return out;
}
