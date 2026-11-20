/**
 * Driver badges and the weekly challenge's Hall of Fame (issue #129), on the lap boards' database:
 *   GET /api/hall-of-fame         -> { ok, current, events: [{ event, physics, trackId, vehicle, current, podium }],
 *                                      mostDecorated: [{ name, nameKey, gold, silver, bronze, total }] }
 *   GET /api/badges?names=a,b,... -> { ok, badges: { <name key>: [{ type, count, events?, boards?, note? }] } }
 *                                    (at most MAX_BADGE_NAMES names; more are refused)
 * and, for the owner (admin.ts, behind the admin key), the badges given by hand: list, grant, revoke.
 *
 * The weekly podiums. Each weekly challenge has its own board per physics revision (board.ts); its podium is the first
 * three drivers in the board's order (time, then who set it first). A week driven under both Physics V1 and V2 has a
 * podium under each, and both are kept: the Hall of Fame groups by week and named physics version ("v1", "v2",
 * lap-types.ts PHYSICS_VERSIONS). Should one version have more than one board in a week (a circuit restarted mid-week),
 * the newest board is that version's podium. The week running now shows its podium as it stands and wins no medal.
 * The first time a finished week's podium is read it is written to `driver_awards` (awarded_by 'auto', migration
 * 0008), once per week and version and never again, so a medal survives its laps (a claim that lapses, a merge on
 * rename); from then on that week is read from there.
 *
 * The badges (src/lib/net/awards.ts lists them for the game):
 *   weekly_gold/silver/bronze  the podiums above, finished weeks only, every week and version counted
 *   track_record               holds P1 on an open board laps go on now: a circuit in this build's list
 *                              (public/tracks/index.json), a car on its current revision there (either LC26 engine)
 *   og                         has a lap on a Physics V1 board (any circuit, car or week): drove before Physics V2.
 *                              V1 boards are read only, so the rule never takes the badge from anyone who has it
 *   bulb                       given by hand, for an idea or a contribution, with a note
 * The owner may also give an OG or a track record by hand (set somewhere the boards don't see); the weekly medals come
 * from the boards alone.
 *
 * Every read here works on a database without migration 0008 too: the podiums are then worked out from the laps alone,
 * and there are no badges given by hand.
 */
import trackIndex from "../../public/tracks/index.json";
import { CIRCUIT_REVISION_STEP, isCurrentLapPhysics, PHYSICS_VERSIONS } from "../../src/lib/sim/lap-types";
import { isVehicleModelId } from "../../src/types/f1";
import { challengeAt } from "../../src/lib/net/weekly-challenge";
import type {
  BadgeType,
  DecoratedDriver,
  DriverBadge,
  HallOfFameAnswer,
  HallOfFameEvent,
  ManualBadgeType,
  PodiumPlace,
} from "../../src/lib/net/awards";
import { driverNameKey, EVENT_ID_RE } from "./board";
import type { D1Database, D1PreparedStatement } from "./types";

type Answer = { status: number; body: unknown };
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** The same lists as src/lib/net/awards.ts (imported there as types only, so the Worker carries no client code) */
export const BADGE_TYPES: readonly BadgeType[] = ["weekly_gold", "weekly_silver", "weekly_bronze", "track_record", "og", "bulb"];
export const MANUAL_BADGE_TYPES: readonly ManualBadgeType[] = ["bulb", "og", "track_record"];
export const MAX_BADGE_NAMES = 64;
export const MAX_NOTE_LENGTH = 140;
const MAX_NAME_LENGTH = 64;
const MEDALS = ["weekly_gold", "weekly_silver", "weekly_bronze"] as const;
type Medal = (typeof MEDALS)[number];
const MEDAL_OF_PLACE: Record<1 | 2 | 3, Medal> = { 1: "weekly_gold", 2: "weekly_silver", 3: "weekly_bronze" };
const PLACE_OF_MEDAL: Record<Medal, 1 | 2 | 3> = { weekly_gold: 1, weekly_silver: 2, weekly_bronze: 3 };
/** Drivers listed as the most decorated */
const MOST_DECORATED = 10;

/** The circuits of this build (the list the game reads), whose open boards hold a track record */
const OFFICIAL_CIRCUITS: ReadonlySet<string> = new Set((trackIndex as { id: string }[]).map((t) => t.id));

/**
 * The named physics version of a lap revision: "v1", "v2" (the circuit's restarts and the LC26's rigid-body offset
 * set aside), else "r<n>" for a revision older than every named one
 */
export function physicsIdOf(revision: number): string {
  const p = ((revision % CIRCUIT_REVISION_STEP) + CIRCUIT_REVISION_STEP) % CIRCUIT_REVISION_STEP;
  const named = PHYSICS_VERSIONS.find((v) => p === v.physics || p === v.physics + v.lc26Offset);
  return named ? named.name.toLowerCase() : `r${p}`;
}

/** The lap revisions (on a circuit never restarted, mod CIRCUIT_REVISION_STEP) of Physics V1: what makes an OG */
const OG_REVISIONS: readonly number[] = [PHYSICS_VERSIONS[0].physics, PHYSICS_VERSIONS[0].physics + PHYSICS_VERSIONS[0].lc26Offset];

/** A row of a weekly board: one driver's fastest lap there (the SQL below), or any lap (the checks) */
export interface PodiumRow {
  event: string;
  physics: number;
  track_id: string;
  vehicle: string;
  name_key: string;
  driver_name: string;
  lap_time_ms: number;
  created_at: number;
  id: string;
}

/** A podium worked out from the laps, with the board revision it was read from */
export type LiveEvent = HallOfFameEvent & { revision: number };

/** A week is finished once another has started: an id before the week running now */
export const weekFinished = (event: string, nowMs: number): boolean => event < challengeAt(nowMs).id;

/**
 * The podiums of the weekly boards: per week and board revision, each driver once (their fastest lap), in the board's
 * order (time, then who set it first, then the row), the first three; then per week and named version, the newest
 * board's. Newest week first, V2 before V1.
 */
export function rankPodiums(rows: readonly PodiumRow[], nowMs: number): LiveEvent[] {
  const boards = new Map<string, PodiumRow[]>();
  for (const r of rows) {
    if (!EVENT_ID_RE.test(r.event) || !Number.isFinite(r.lap_time_ms)) continue;
    const k = `${r.event}|${r.physics}`;
    const list = boards.get(k);
    if (list) list.push(r);
    else boards.set(k, [r]);
  }
  const byVersion = new Map<string, LiveEvent>();
  for (const list of boards.values()) {
    list.sort((a, b) => a.lap_time_ms - b.lap_time_ms || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const seen = new Set<string>();
    const podium: PodiumPlace[] = [];
    for (const r of list) {
      if (seen.has(r.name_key)) continue;
      seen.add(r.name_key);
      podium.push({ place: (podium.length + 1) as 1 | 2 | 3, name: r.driver_name, nameKey: r.name_key, lapTimeMs: r.lap_time_ms });
      if (podium.length === 3) break;
    }
    const first = list[0];
    const physics = physicsIdOf(first.physics);
    const key = `${first.event}|${physics}`;
    const had = byVersion.get(key);
    if (had && had.revision > first.physics) continue;
    byVersion.set(key, {
      event: first.event,
      physics,
      revision: first.physics,
      trackId: first.track_id,
      vehicle: first.vehicle,
      current: !weekFinished(first.event, nowMs),
      podium,
    });
  }
  return sortEvents([...byVersion.values()]);
}

function sortEvents<T extends { event: string; physics: string }>(events: T[]): T[] {
  return events.sort((a, b) => (a.event !== b.event ? (a.event < b.event ? 1 : -1) : a.physics < b.physics ? 1 : a.physics > b.physics ? -1 : 0));
}

/** The most decorated drivers of these podiums, finished weeks only: most golds, then silvers, then bronzes, then name */
export function tallyMostDecorated(events: readonly HallOfFameEvent[], limit = MOST_DECORATED): DecoratedDriver[] {
  const tally = new Map<string, DecoratedDriver>();
  // Newest week first, so a driver is listed under the name they last won with
  for (const e of events) {
    if (e.current) continue;
    for (const p of e.podium) {
      const d = tally.get(p.nameKey) ?? { name: p.name, nameKey: p.nameKey, gold: 0, silver: 0, bronze: 0, total: 0 };
      if (p.place === 1) d.gold++;
      else if (p.place === 2) d.silver++;
      else d.bronze++;
      d.total++;
      tally.set(p.nameKey, d);
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit);
}

/** A stored award (migration 0008) */
export interface AwardRow {
  id: number;
  name_key: string;
  badge_type: BadgeType;
  event_id: string;
  physics: string;
  note: string;
  awarded_at: number;
  awarded_by: string;
  driver_name: string;
  track_id: string;
  vehicle: string;
  lap_time_ms: number | null;
}

/** Null when the read fails: the awards table of migration 0008 is not there yet */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Each driver's fastest lap on each weekly board, the first three of each */
const PODIUM_SQL = `WITH best AS (
  SELECT event, physics, track_id, vehicle, name_key, driver_name, lap_time_ms, created_at, id,
    ROW_NUMBER() OVER (PARTITION BY event, physics, name_key ORDER BY lap_time_ms, created_at, id) AS rn
  FROM laps WHERE event != ''
), placed AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY event, physics ORDER BY lap_time_ms, created_at, id) AS place FROM best WHERE rn = 1
)
SELECT event, physics, track_id, vehicle, name_key, driver_name, lap_time_ms, created_at, id FROM placed WHERE place <= 3`;

/** The finished weeks' podiums kept in `driver_awards`, as podiums */
function archivedEvents(rows: readonly AwardRow[]): HallOfFameEvent[] {
  const groups = new Map<string, HallOfFameEvent>();
  for (const r of rows) {
    if (!(MEDALS as readonly string[]).includes(r.badge_type)) continue;
    const k = `${r.event_id}|${r.physics}`;
    const g = groups.get(k) ?? { event: r.event_id, physics: r.physics, trackId: r.track_id, vehicle: r.vehicle, current: false, podium: [] };
    g.podium.push({ place: PLACE_OF_MEDAL[r.badge_type as Medal], name: r.driver_name || r.name_key, nameKey: r.name_key, lapTimeMs: r.lap_time_ms });
    groups.set(k, g);
  }
  for (const g of groups.values()) g.podium.sort((a, b) => a.place - b.place);
  return [...groups.values()];
}

/**
 * Every week's podiums: the finished weeks from the archive (writing there any finished week not in it yet), the week
 * running now from its board. Without migration 0008, every week from its board.
 */
export async function hallOfFameEvents(db: D1Database, nowMs: number): Promise<HallOfFameEvent[]> {
  const live = rankPodiums((await db.prepare(PODIUM_SQL).all<PodiumRow>()).results, nowMs);
  const archived = await orNull(async () =>
    (await db.prepare("SELECT * FROM driver_awards WHERE awarded_by = 'auto' AND badge_type IN ('weekly_gold', 'weekly_silver', 'weekly_bronze')").all<AwardRow>()).results,
  );
  const strip = ({ revision: _revision, ...e }: LiveEvent): HallOfFameEvent => e;
  if (archived === null) return live.map(strip);

  const kept = new Set(archived.map((r) => `${r.event_id}|${r.physics}`));
  const toKeep = live.filter((e) => !e.current && !kept.has(`${e.event}|${e.physics}`));
  if (toKeep.length > 0) {
    const writes: D1PreparedStatement[] = [];
    for (const e of toKeep) {
      for (const p of e.podium) {
        writes.push(
          db
            .prepare(
              "INSERT INTO driver_awards (name_key, badge_type, event_id, physics, note, awarded_at, awarded_by, driver_name, track_id, vehicle, lap_time_ms) VALUES (?, ?, ?, ?, '', ?, 'auto', ?, ?, ?, ?) ON CONFLICT (name_key, badge_type, event_id, physics) DO NOTHING",
            )
            .bind(p.nameKey, MEDAL_OF_PLACE[p.place], e.event, e.physics, nowMs, p.name, e.trackId, e.vehicle, p.lapTimeMs),
        );
      }
    }
    // A write that fails (two readers at once, a read-only replica) costs nothing: the podium is shown from the laps
    // this time and kept the next
    await orNull(() => db.batch(writes));
  }
  const finished = [...archivedEvents(archived), ...toKeep.map(strip)];
  const current = live.filter((e) => e.current).map(strip);
  return sortEvents([...finished, ...current]);
}

export async function hallOfFame(db: D1Database, nowMs: number): Promise<Answer> {
  const events = await hallOfFameEvents(db, nowMs);
  const body: HallOfFameAnswer = { ok: true, current: challengeAt(nowMs).id, events, mostDecorated: tallyMostDecorated(events) };
  return { status: 200, body };
}

/** The name keys of a `names=` list: each once, in order; null when there are too many or one is too long */
export function parseBadgeNames(raw: string | null): string[] | null {
  if (raw === null) return [];
  const parts = raw.split(",");
  if (parts.length > MAX_BADGE_NAMES * 2) return null;
  const keys: string[] = [];
  for (const part of parts) {
    if (part.length > MAX_NAME_LENGTH) return null;
    const key = driverNameKey(part);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.length > MAX_BADGE_NAMES ? null : keys;
}

/**
 * The badges of these drivers (name keys): what their podiums, records and V1 laps say, and what was given by hand.
 * `events` is the Hall of Fame, when already read.
 */
export async function badgesOf(db: D1Database, keys: readonly string[], nowMs: number, events?: readonly HallOfFameEvent[]): Promise<Record<string, DriverBadge[]>> {
  const out: Record<string, DriverBadge[]> = {};
  if (keys.length === 0) return out;
  const marks = keys.map(() => "?").join(", ");
  const [weeks, records, og, manual] = await Promise.all([
    events ? Promise.resolve(events) : hallOfFameEvents(db, nowMs),
    db
      .prepare(
        `SELECT track_id, vehicle, physics, name_key FROM (SELECT track_id, vehicle, physics, name_key, ROW_NUMBER() OVER (PARTITION BY track_id, vehicle, physics ORDER BY lap_time_ms, created_at, id) AS place FROM laps WHERE event = '') WHERE place = 1 AND name_key IN (${marks})`,
      )
      .bind(...keys)
      .all<{ track_id: string; vehicle: string; physics: number; name_key: string }>(),
    db
      .prepare(`SELECT DISTINCT name_key FROM laps WHERE name_key IN (${marks}) AND (physics % ${CIRCUIT_REVISION_STEP}) IN (${OG_REVISIONS.join(", ")})`)
      .bind(...keys)
      .all<{ name_key: string }>(),
    orNull(async () =>
      (await db.prepare(`SELECT * FROM driver_awards WHERE awarded_by != 'auto' AND name_key IN (${marks}) ORDER BY awarded_at DESC, id DESC`).bind(...keys).all<AwardRow>()).results,
    ),
  ]);

  const wanted = new Set(keys);
  const add = (key: string, type: BadgeType): DriverBadge => {
    const list = (out[key] ??= []);
    let b = list.find((x) => x.type === type);
    if (!b) {
      b = { type, count: 0 };
      list.push(b);
    }
    return b;
  };

  for (const e of weeks) {
    if (e.current) continue;
    for (const p of e.podium) {
      if (!wanted.has(p.nameKey)) continue;
      const b = add(p.nameKey, MEDAL_OF_PLACE[p.place]);
      b.count++;
      (b.events ??= []).push({ event: e.event, physics: e.physics });
    }
  }
  for (const r of records.results) {
    if (!OFFICIAL_CIRCUITS.has(r.track_id) || !isVehicleModelId(r.vehicle) || !isCurrentLapPhysics(r.vehicle, r.physics, r.track_id)) continue;
    const b = add(r.name_key, "track_record");
    b.count++;
    (b.boards ??= []).push({ trackId: r.track_id, vehicle: r.vehicle });
  }
  for (const r of og.results) add(r.name_key, "og").count = 1;
  for (const r of manual ?? []) {
    if (!wanted.has(r.name_key) || !(MANUAL_BADGE_TYPES as readonly string[]).includes(r.badge_type)) continue;
    const b = add(r.name_key, r.badge_type);
    if (r.badge_type === "og") b.count = 1;
    else b.count++;
    // The newest note (rows come newest first)
    if (r.note && b.note === undefined) b.note = r.note;
  }
  const order = (t: BadgeType) => BADGE_TYPES.indexOf(t);
  for (const list of Object.values(out)) list.sort((a, b) => order(a.type) - order(b.type));
  return out;
}

export async function listBadges(db: D1Database, url: URL, nowMs: number): Promise<Answer> {
  const keys = parseBadgeNames(url.searchParams.get("names"));
  if (keys === null) return fail(`At most ${MAX_BADGE_NAMES} names of up to ${MAX_NAME_LENGTH} characters`);
  return { status: 200, body: { ok: true, badges: await badgesOf(db, keys, nowMs) } };
}

/* The owner's side (admin.ts serves it behind the admin key) ------------------------------------------------------- */

export interface AwardInput {
  nameKey: string;
  name: string;
  badge: ManualBadgeType;
  note: string;
}

/** A grant as sent ({ name, badge?, note? }), checked: the badge defaults to the Bulb, a note is plain text */
export function checkAwardInput(body: unknown): { ok: true; award: AwardInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Body is not valid JSON" };
  const b = body as { name?: unknown; nameKey?: unknown; name_key?: unknown; badge?: unknown; badge_type?: unknown; note?: unknown };
  const rawName = typeof b.name === "string" ? b.name : typeof b.nameKey === "string" ? b.nameKey : typeof b.name_key === "string" ? b.name_key : "";
  const name = rawName.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return { ok: false, error: "A driver name of 1 to 64 characters is needed" };
  const nameKey = driverNameKey(name);
  if (nameKey.includes(",")) return { ok: false, error: "A driver name can't hold a comma" };
  const rawBadge = b.badge !== undefined ? b.badge : b.badge_type;
  const badge = rawBadge === undefined || rawBadge === null || rawBadge === "" ? "bulb" : rawBadge;
  if (!(MANUAL_BADGE_TYPES as readonly unknown[]).includes(badge)) {
    return { ok: false, error: `Only ${MANUAL_BADGE_TYPES.join(", ")} can be given by hand: the weekly medals come from the boards` };
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return { ok: false, error: "The note must be text" };
  // Control characters go, runs of spaces close up
  const note = (typeof b.note === "string" ? b.note : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (note.length > MAX_NOTE_LENGTH) return { ok: false, error: `A note of up to ${MAX_NOTE_LENGTH} characters` };
  return { ok: true, award: { nameKey, name, badge: badge as ManualBadgeType, note } };
}

/** An award as the owner's page reads it */
export const awardOf = (r: AwardRow) => ({
  id: r.id,
  nameKey: r.name_key,
  name: r.driver_name || r.name_key,
  badge: r.badge_type,
  event: r.event_id,
  physics: r.physics,
  note: r.note,
  awardedAt: r.awarded_at,
  awardedBy: r.awarded_by,
});
export type AdminAward = ReturnType<typeof awardOf>;

/** The badges given by hand, newest first (with `all`, the archived podiums too); with `q`, the drivers whose name has it */
export async function listAwards(db: D1Database, opts: { all?: boolean; q?: string } = {}): Promise<{ awards: AdminAward[]; drivers: { nameKey: string; name: string }[] }> {
  const rows = await db
    .prepare(`SELECT * FROM driver_awards ${opts.all ? "" : "WHERE awarded_by != 'auto'"} ORDER BY awarded_at DESC, id DESC LIMIT 500`)
    .all<AwardRow>();
  let drivers: { nameKey: string; name: string }[] = [];
  const q = opts.q ? driverNameKey(opts.q).slice(0, MAX_NAME_LENGTH) : "";
  if (q) {
    // LIKE with its wildcards taken as letters
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const found = await db
      .prepare(
        "SELECT d.name_key AS nameKey, COALESCE((SELECT driver_name FROM laps WHERE laps.name_key = d.name_key ORDER BY created_at DESC LIMIT 1), d.name_key) AS name FROM drivers d WHERE d.name_key LIKE ? ESCAPE '\\' ORDER BY d.last_seen DESC LIMIT 20",
      )
      .bind(like)
      .all<{ nameKey: string; name: string }>();
    drivers = found.results.map((d) => ({ nameKey: String(d.nameKey), name: String(d.name) }));
  }
  return { awards: rows.results.map(awardOf), drivers };
}

/** Gives a badge by hand; giving it again replaces its note */
export async function grantAward(db: D1Database, award: AwardInput, nowMs: number): Promise<AdminAward | null> {
  const row = await db
    .prepare(
      "INSERT INTO driver_awards (name_key, badge_type, event_id, physics, note, awarded_at, awarded_by, driver_name) VALUES (?, ?, '', '', ?, ?, 'admin', ?) ON CONFLICT (name_key, badge_type, event_id, physics) DO UPDATE SET note = excluded.note, driver_name = excluded.driver_name, awarded_at = excluded.awarded_at, awarded_by = 'admin' RETURNING *",
    )
    .bind(award.nameKey, award.badge, award.note, nowMs, award.name)
    .first<AwardRow>();
  return row ? awardOf(row) : null;
}

/** Takes an award back (one given by hand, or an archived podium the owner strikes out); how many rows went */
export async function revokeAward(db: D1Database, id: number): Promise<number> {
  const done = await db.prepare("DELETE FROM driver_awards WHERE id = ?").bind(id).run();
  return done.meta.changes ?? 0;
}

/**
 * A driver's new name takes their awards with it (board.ts renameDriver). Where the new name already holds the same
 * award, the old row goes. A database without migration 0008 has none to move.
 */
export async function moveDriverAwards(db: D1Database, fromKey: string, toKey: string, toName?: string): Promise<void> {
  await orNull(async () => {
    if (fromKey === toKey) {
      if (toName) await db.prepare("UPDATE driver_awards SET driver_name = ? WHERE name_key = ?").bind(toName, toKey).run();
      return;
    }
    await db.batch([
      toName
        ? db.prepare("UPDATE OR IGNORE driver_awards SET name_key = ?, driver_name = ? WHERE name_key = ?").bind(toKey, toName, fromKey)
        : db.prepare("UPDATE OR IGNORE driver_awards SET name_key = ? WHERE name_key = ?").bind(toKey, fromKey),
      db.prepare("DELETE FROM driver_awards WHERE name_key = ?").bind(fromKey),
    ]);
  });
}
