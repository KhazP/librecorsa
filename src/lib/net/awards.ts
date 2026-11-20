/**
 * Driver badges and the weekly challenge's Hall of Fame (issue #129), as the game reads them from the online side
 * (cloudflare/api/awards.ts):
 *   fetchHallOfFame   every weekly challenge's podiums, one per physics version (V1, V2), and the most decorated drivers
 *   fetchBadges       the badges of a few drivers at once (the names on a board page), kept a few minutes
 *
 * The badges:
 *   weekly_gold / weekly_silver / weekly_bronze   first, second or third on a finished week's board, under a physics
 *                                                 version (a week driven on V1 and V2 has a podium on each)
 *   track_record                                  holds the fastest lap on an open board laps go on now (a circuit in
 *                                                 the game, a car on its current physics)
 *   og                                            has a lap on a Physics V1 board: drove LibreCorsa before Physics V2
 *   bulb                                          given by hand, for an idea or a contribution, with a note
 *
 * The types are shared with the Worker, which imports them only as types: nothing here runs on the server.
 */
import { getOnlineConfig, onlineUrl } from "./online-config";
import { driverNameKey, requestJson } from "./board-client";

export const BADGE_TYPES = ["weekly_gold", "weekly_silver", "weekly_bronze", "track_record", "og", "bulb"] as const;
export type BadgeType = (typeof BADGE_TYPES)[number];
export const isBadgeType = (v: unknown): v is BadgeType => (BADGE_TYPES as readonly unknown[]).includes(v);

/** The badges the owner may give by hand; the weekly medals come from the boards alone */
export const MANUAL_BADGE_TYPES = ["bulb", "og", "track_record"] as const satisfies readonly BadgeType[];
export type ManualBadgeType = (typeof MANUAL_BADGE_TYPES)[number];

/** The most names one badge read asks for */
export const MAX_BADGE_NAMES = 64;

/** One week and physics version a medal was won in */
export interface BadgeEvent {
  event: string;
  /** "v1", "v2" */
  physics: string;
}

/** One kind of badge a driver holds, with how many times */
export interface DriverBadge {
  type: BadgeType;
  count: number;
  /** The weeks of a weekly medal, newest first */
  events?: BadgeEvent[];
  /** The boards of a track record: circuit and car */
  boards?: { trackId: string; vehicle: string }[];
  /** What a badge given by hand was given for (the Bulb's idea) */
  note?: string;
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

/** GET /api/hall-of-fame */
export interface HallOfFameAnswer {
  ok: true;
  /** The week running now ("2026-W47") */
  current: string;
  /** Newest week first, V2 before V1 within a week */
  events: HallOfFameEvent[];
  /** Finished weeks only: most golds, then silvers, then bronzes */
  mostDecorated: DecoratedDriver[];
}

/** The badge order everywhere: medals first, best first */
const ORDER: Record<BadgeType, number> = { weekly_gold: 0, weekly_silver: 1, weekly_bronze: 2, track_record: 3, og: 4, bulb: 5 };
export const sortBadges = (badges: readonly DriverBadge[]): DriverBadge[] => [...badges].sort((a, b) => ORDER[a.type] - ORDER[b.type]);

const BADGE_NAME: Record<BadgeType, string> = {
  weekly_gold: "Weekly Gold",
  weekly_silver: "Weekly Silver",
  weekly_bronze: "Weekly Bronze",
  track_record: "Track Record",
  og: "OG Driver",
  bulb: "Idea Contributor",
};

/** "Weekly Gold", "Idea Contributor" */
export const badgeName = (type: BadgeType): string => BADGE_NAME[type];

/** "V2" for "v2" */
export const physicsName = (physics: string): string => physics.toUpperCase();

/**
 * The words of a badge's tooltip and spoken name: "Weekly Gold ×2", "Track Record ×3", "OG Driver",
 * "Idea Contributor — Wet weather tyres"
 */
export function badgeLabel(b: DriverBadge): string {
  const times = b.count > 1 ? ` ×${b.count}` : "";
  const note = b.type === "bulb" && b.note ? ` — ${b.note}` : "";
  return `${BADGE_NAME[b.type]}${times}${note}`;
}

/** A longer line for a tooltip: what the badge means and where it was won */
export function badgeDetail(b: DriverBadge): string {
  switch (b.type) {
    case "weekly_gold":
    case "weekly_silver":
    case "weekly_bronze": {
      const place = b.type === "weekly_gold" ? "First" : b.type === "weekly_silver" ? "Second" : "Third";
      const weeks = (b.events ?? []).slice(0, 4).map((e) => `${e.event} ${physicsName(e.physics)}`);
      return `${place} in a weekly challenge${weeks.length ? `: ${weeks.join(", ")}${(b.events?.length ?? 0) > weeks.length ? "…" : ""}` : ""}`;
    }
    case "track_record":
      return `Fastest lap on ${b.count === 1 ? "an open board" : `${b.count} open boards`}`;
    case "og":
      return "Drove LibreCorsa on Physics V1";
    case "bulb":
      return b.note ? `Idea Contributor: ${b.note}` : "Idea or community contribution";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const PHYSICS_RE = /^[a-z0-9]{1,12}$/;
const EVENT_RE = /^\d{4}-W\d{2}$/;

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
    badge.boards = raw.boards
      .slice(0, 200)
      .filter((b): b is { trackId: string; vehicle: string } => isRecord(b) && str(b.trackId, 64) !== null && str(b.vehicle, 32) !== null)
      .map((b) => ({ trackId: b.trackId, vehicle: b.vehicle }));
  }
  const note = str(raw.note, 200);
  if (note) badge.note = note;
  return badge;
}

/** The badges of a badge read, by name key; null for an answer that isn't one */
export function parseBadges(body: unknown): Record<string, DriverBadge[]> | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.badges)) return null;
  const out: Record<string, DriverBadge[]> = {};
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
  return { ok: true, current: typeof body.current === "string" && EVENT_RE.test(body.current) ? body.current : "", events, mostDecorated };
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
const kept = new Map<string, { badges: DriverBadge[]; atMs: number }>();
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
  const missing = keys.filter((k) => !pending.has(k) && !((kept.get(k)?.atMs ?? -Infinity) > nowMs - BADGE_KEEP_MS));
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
        if (!parsed) return;
        for (const k of chunk) kept.set(k, { badges: parsed[k] ?? [], atMs: nowMs });
      })();
      for (const k of chunk) pending.set(k, job);
      void job.finally(() => {
        for (const k of chunk) if (pending.get(k) === job) pending.delete(k);
      });
    }
  }
  await Promise.all(keys.map((k) => pending.get(k)).filter((p): p is Promise<void> => p !== undefined));
  const out: Record<string, DriverBadge[]> = {};
  for (const k of keys) {
    const badges = kept.get(k)?.badges;
    if (badges && badges.length > 0) out[k] = badges;
  }
  return out;
}
