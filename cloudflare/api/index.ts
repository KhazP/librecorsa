/**
 * librecorsa.org's online API, served by the site Worker under /api (cloudflare/worker.js):
 *   GET /api/config               which online features this deployment has switched on
 *   GET /api/rooms/<CODE>         WebSocket to a private room's server (room.ts)
 *   POST /api/laps, GET /api/laps, GET /api/laps/<id>   the lap boards (board.ts)
 *   POST /api/drivers/rename                           a driver's new name, their laps with it (board.ts)
 *   GET /api/races/next, /api/races/<n>                 WebSocket to a scheduled race's server (race.ts)
 *   GET /api/races/waiting                              who is waiting for the next race (race.ts, read only)
 *   POST /api/usage               one stretch of driving for the anonymous daily totals (usage.ts)
 *   GET /api/admin/stats          the owner's numbers, with the admin key as `Authorization: Bearer <key>` (admin.ts)
 *   GET /api/admin/cloudflare     Cloudflare's numbers for the site, the same way, once an analytics token is set (analytics.ts)
 *   GET/POST /api/admin/awards, DELETE /api/admin/awards/<id>  driver badges given by hand (awards.ts, admin.ts)
 *   GET /api/hall-of-fame, GET /api/badges                     weekly challenge podiums (V1 & V2) and driver badges (awards.ts)
 *   GET /api/races/results, GET /api/drivers/record     the open races' results (results.ts)
 *   GET /api/stats, GET /api/stats/circuit              tabs in view and drivers to date; a circuit's laps and drivers (stats.ts)
 *   POST /api/live                a heartbeat from a tab with the game in view, for the live count (presence.ts)
 * Every feature is optional: with its binding missing or its switch off (wrangler.jsonc `vars`), the config says
 * so and the game falls back to what works without a server.
 *
 * Workers caching is on (for the site's large files), so every answer says no-store, except a few that are the same
 * for everyone who asks and are read on every view of the home page or the title screen: a board's page without a
 * driver's name, and the totals. Those are kept for half a minute or a minute (SHARED_ANSWER_S), at the edge and in
 * the browser, so a crowd on the home page reads the database about once a minute, not once a visit.
 */
import { DEFAULT_RACE_SLOT_S, nextRaceSlot, raceSlot } from "../../src/lib/net/race-schedule";
import { challengeProblem } from "../../src/lib/net/weekly-challenge";
import { boardDeps, ghostOf, listLaps, renameDriver, submitLap } from "./board";
import { driverRecord, listRaceResults } from "./results";
import { ROOM_CODE_RE } from "./room";
import { adminGrantAward, adminKeyMatches, adminListAwards, adminRevokeAward, adminStats } from "./admin";
import { hallOfFame, listBadges } from "./awards";
import { analyticsConfigured, cloudflareStats } from "./analytics";
import { turnConfigured } from "./turn";
import { recordUsage } from "./usage";
import { circuitStats, driversToDate } from "./stats";
import type { DurableObjectNamespace, Env, RateLimit } from "./types";

export { RaceServer } from "./race";
export { RoomServer } from "./room";
export { PresenceCounter } from "./presence";

const on = (value: string | undefined): boolean => value === "on";

/** Seconds between scheduled races: RACE_SLOT_S, else every 20 minutes */
export function raceSlotSeconds(env: Env): number {
  const s = Number(env.RACE_SLOT_S);
  return Number.isInteger(s) && s >= 30 && s <= 86_400 ? s : DEFAULT_RACE_SLOT_S;
}

/** What the game may use online, as the Worker is configured right now */
export function onlineConfig(env: Env): { rooms: boolean; relay: boolean; races: boolean; board: boolean; raceSlotS: number; usage: boolean; live: boolean } {
  return {
    rooms: on(env.ONLINE_ROOMS) && Boolean(env.ROOMS),
    relay: on(env.ONLINE_ROOMS) && Boolean(env.ROOMS) && turnConfigured(env),
    races: on(env.ONLINE_RACES) && Boolean(env.RACES),
    board: on(env.ONLINE_BOARD) && Boolean(env.BOARD_DB) && Boolean(env.GHOSTS),
    raceSlotS: raceSlotSeconds(env),
    usage: on(env.ONLINE_USAGE) && Boolean(env.BOARD_DB),
    live: on(env.ONLINE_LIVE) && Boolean(env.PRESENCE),
  };
}

/** The one object that counts the heartbeats (presence.ts) */
const presenceOf = (ns: DurableObjectNamespace) => ns.get(ns.idFromName("live"));

/** Tabs on /play in view now; null when the count can't be read */
async function liveCount(ns: DurableObjectNamespace, url: URL): Promise<number | null> {
  try {
    const res = await presenceOf(ns).fetch(new Request(new URL("/api/live", url), { method: "GET" }));
    const seen = (await res.json().catch(() => null)) as { live?: unknown } | null;
    return typeof seen?.live === "number" && Number.isInteger(seen.live) && seen.live >= 0 ? seen.live : null;
  } catch {
    return null;
  }
}

/** The request's Origin when it may call the API: the site itself, or a development origin from DEV_ORIGINS */
function allowedOrigin(request: Request, url: URL, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === url.origin) return origin;
  const extra = (env.DEV_ORIGINS ?? "").split(",").map((o) => o.trim());
  return extra.includes(origin) ? origin : null;
}

/**
 * How long the answers anyone may share are kept, in the browser and in Workers caching at the edge (seconds): the
 * home page and the title screen read them on every view, and none of them is about the one asking
 */
export const SHARED_ANSWER_S = { board: 30, circuit: 60, stats: 30, hallOfFame: 60, badges: 60 } as const;

function headersFor(origin: string | null, sharedForS = 0): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": sharedForS > 0 ? `public, max-age=${sharedForS}` : "no-store", Vary: "Origin" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

/** A JSON answer; `sharedForS` lets a successful one be kept for that long (an error never is) */
export function json(body: unknown, status: number, origin: string | null, sharedForS = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headersFor(origin, status === 200 ? sharedForS : 0), "Content-Type": "application/json; charset=utf-8" },
  });
}

/** The answer to any path the API doesn't serve, and to the admin routes without the right key or with a fault */
const notFound = (origin: string | null): Response => json({ ok: false, error: "Not found" }, 404, origin);
/** Past ADMIN_LIMIT: the same answer on an admin route and on any unknown path */
const tooMany = (origin: string | null): Response => json({ ok: false, error: "Too many requests" }, 429, origin);

/** True when this address is past `limit` (a Workers rate-limit binding); without the binding nothing is limited */
async function overLimit(limit: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limit) return false;
  const { success } = await limit.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
  return !success;
}

/** The admin key a request carries: `Authorization: Bearer <key>` (a header Cloudflare's logs redact), else null */
export function bearerKey(request: Request): string | null {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  return m ? m[1] : null;
}

/** The next scheduled race and who is waiting for it: a read of its server, no socket */
async function raceWaiting(races: DurableObjectNamespace, slotS: number, url: URL): Promise<{ startsMs: number; waiting: number; names: string[] }> {
  const slot = nextRaceSlot(Date.now(), slotS);
  const to = new URL(url.toString());
  to.search = "";
  to.searchParams.set("peek", "1");
  const res = await races.get(races.idFromName(`race-${slotS}-${slot.index}`)).fetch(new Request(to));
  const seen = (await res.json().catch(() => null)) as { waiting?: unknown; names?: unknown } | null;
  const waiting = typeof seen?.waiting === "number" ? seen.waiting : 0;
  const names = Array.isArray(seen?.names) ? seen.names.filter((n): n is string => typeof n === "string") : [];
  return { startsMs: slot.startsMs, waiting, names };
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const origin = allowedOrigin(request, url, env);
  // A browser on another site gets no answer it can read, and no socket
  const foreign = request.headers.has("Origin") && origin === null;
  if (request.method === "OPTIONS") return new Response(null, { status: foreign ? 403 : 204, headers: headersFor(origin) });
  if (foreign) return json({ ok: false, error: "Origin not allowed" }, 403, null);

  const path = url.pathname.replace(/\/+$/, "");
  const config = onlineConfig(env);

  if (path === "/api/config" && request.method === "GET") return json(config, 200, origin);

  const room = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (room && request.method === "GET") {
    const code = room[1].toUpperCase();
    if (!config.rooms || !env.ROOMS) return json({ ok: false, error: "Rooms are off" }, 404, origin);
    if (!ROOM_CODE_RE.test(code)) return json({ ok: false, error: "Bad room code" }, 400, origin);
    if (env.ROOM_LIMIT) {
      const { success } = await env.ROOM_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
      if (!success) return json({ ok: false, error: "Too many tries, wait a minute" }, 429, origin);
    }
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  }

  // Who is waiting for the next race, for the Races card of anyone not in it yet: a read of its server, no socket
  if (path === "/api/races/waiting" && request.method === "GET") {
    if (!config.races || !env.RACES) return json({ ok: false, error: "Scheduled races are off" }, 404, origin);
    return json({ ok: true, ...(await raceWaiting(env.RACES, config.raceSlotS, url)) }, 200, origin);
  }

  const race = /^\/api\/races\/(next|\d{1,12})$/.exec(path);
  if (race && request.method === "GET") {
    if (!config.races || !env.RACES) return json({ ok: false, error: "Scheduled races are off" }, 404, origin);
    if (env.ROOM_LIMIT) {
      const { success } = await env.ROOM_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
      if (!success) return json({ ok: false, error: "Too many tries, wait a minute" }, 429, origin);
    }
    // The slot comes from this clock, never the caller's: the next race, or one under way to get back into
    const nowMs = Date.now();
    const slot = race[1] === "next" ? nextRaceSlot(nowMs, config.raceSlotS) : raceSlot(Number(race[1]), config.raceSlotS);
    if (slot.startsMs > nowMs + config.raceSlotS * 1000 + 60_000 || slot.startsMs < nowMs - 3 * 3_600_000) {
      return json({ ok: false, error: "No such race" }, 404, origin);
    }
    const to = new URL(request.url);
    to.searchParams.set("slot", String(slot.index));
    to.searchParams.set("slotS", String(config.raceSlotS));
    return env.RACES.get(env.RACES.idFromName(`race-${config.raceSlotS}-${slot.index}`)).fetch(new Request(to, request));
  }

  // The open races' results (results.ts), on the lap boards' database
  if ((path === "/api/races/results" || path === "/api/drivers/record") && request.method === "GET") {
    if (!config.races || !env.BOARD_DB) return json({ ok: false, error: "Race results are off" }, 404, origin);
    try {
      const answer = path === "/api/races/results" ? await listRaceResults(env.BOARD_DB, url) : await driverRecord(env.BOARD_DB, url);
      return json(answer.body, answer.status, origin);
    } catch (err) {
      console.error("race results", err);
      return json({ ok: false, error: "The race results had a problem. Try again in a moment" }, 500, origin);
    }
  }

  // The weekly challenge's Hall of Fame and driver badges (awards.ts), on the lap boards' database
  if (path === "/api/hall-of-fame" && request.method === "GET") {
    if (!config.board || !env.BOARD_DB) return json({ ok: false, error: "The lap boards are off" }, 404, origin);
    try {
      const answer = await hallOfFame(env.BOARD_DB, Date.now());
      return json(answer.body, answer.status, origin, SHARED_ANSWER_S.hallOfFame);
    } catch (err) {
      console.error("hall of fame", err);
      return json({ ok: false, error: "The Hall of Fame could not be read" }, 500, origin);
    }
  }
  if (path === "/api/badges" && request.method === "GET") {
    if (!config.board || !env.BOARD_DB) return json({ ok: false, error: "The lap boards are off" }, 404, origin);
    try {
      const answer = await listBadges(env.BOARD_DB, url, Date.now());
      return json(answer.body, answer.status, origin, SHARED_ANSWER_S.badges);
    } catch (err) {
      console.error("badges", err);
      return json({ ok: false, error: "The badges could not be read" }, 500, origin);
    }
  }

  // The boards' totals: a circuit's laps and drivers, and the drivers to date (stats.ts)
  if (path === "/api/stats/circuit" && request.method === "GET") {
    if (!config.board || !env.BOARD_DB) return json({ ok: false, error: "The lap boards are off" }, 404, origin);
    try {
      const answer = await circuitStats(env.BOARD_DB, url);
      return json(answer.body, answer.status, origin, SHARED_ANSWER_S.circuit);
    } catch (err) {
      console.error("circuit stats", err);
      return json({ ok: false, error: "The totals could not be read" }, 500, origin);
    }
  }
  // The title screen's line: tabs in view now (presence.ts) and drivers to date; either may be off, never both
  if (path === "/api/stats" && request.method === "GET") {
    const boardOn = config.board && env.BOARD_DB;
    const liveOn = config.live && env.PRESENCE;
    if (!boardOn && !liveOn) return json({ ok: false, error: "The lap boards and the live count are off" }, 404, origin);
    try {
      const [drivers, live] = await Promise.all([
        boardOn && env.BOARD_DB ? driversToDate(env.BOARD_DB) : null,
        liveOn && env.PRESENCE ? liveCount(env.PRESENCE, url) : null,
      ]);
      return json({ ok: true, drivers, live }, 200, origin, SHARED_ANSWER_S.stats);
    } catch (err) {
      console.error("stats", err);
      return json({ ok: false, error: "The totals could not be read" }, 500, origin);
    }
  }

  // A heartbeat from a tab with the game in view (src/lib/net/live-heartbeat.ts): no body, nothing about who sent it
  if (path === "/api/live" && request.method === "POST") {
    if (!config.live || !env.PRESENCE) return json({ ok: false, error: "The live count is off" }, 404, origin);
    if (env.LIVE_LIMIT) {
      const { success } = await env.LIVE_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
      if (!success) return json({ ok: false, error: "Too many heartbeats" }, 429, origin);
    }
    try {
      await presenceOf(env.PRESENCE).fetch(new Request(new URL("/api/live", url), { method: "POST" }));
      return new Response(null, { status: 204, headers: headersFor(origin) });
    } catch (err) {
      console.error("live", err);
      return json({ ok: false, error: "Not counted" }, 500, origin);
    }
  }

  if (path === "/api/drivers/rename" && request.method === "POST") {
    const deps = config.board ? boardDeps(env, challengeProblem) : null;
    if (!deps) return json({ ok: false, error: "The lap boards are off" }, 404, origin);
    // A flood is turned away here, before the hourly count on the database (board.ts) is written to
    if (await overLimit(env.BOARD_LIMIT, request)) return json({ ok: false, error: "Too many changes, try again later" }, 429, origin);
    try {
      const answer = await renameDriver(deps, request);
      return json(answer.body, answer.status, origin);
    } catch (err) {
      console.error("rename", err);
      return json({ ok: false, error: "The lap board had a problem. Try again in a moment" }, 500, origin);
    }
  }

  if (path === "/api/laps" || path.startsWith("/api/laps/")) {
    // A weekly challenge's board takes this week's laps driven to its rules (src/lib/net/weekly-challenge.ts)
    const deps = config.board ? boardDeps(env, challengeProblem) : null;
    if (!deps) return json({ ok: false, error: "The lap boards are off" }, 404, origin);
    try {
      if (path === "/api/laps" && request.method === "POST") {
        if (await overLimit(env.BOARD_LIMIT, request)) {
          // Logged like the board's own refusals (board.ts submitLap): the lap itself is not read
          console.warn(JSON.stringify({ event: "lap_refused", status: 429, error: "Too many uploads, try again later" }));
          return json({ ok: false, error: "Too many uploads, try again later" }, 429, origin);
        }
        const answer = await submitLap(deps, request);
        return json(answer.body, answer.status, origin);
      }
      if (path === "/api/laps" && request.method === "GET") {
        const answer = await listLaps(deps, url);
        // A page without a name is the same for everyone (the home page's); one with a name says where that driver
        // stands and must show their new lap at once
        return json(answer.body, answer.status, origin, url.searchParams.has("name") ? 0 : SHARED_ANSWER_S.board);
      }
      if (request.method === "GET") {
        const ghost = await ghostOf(deps, path.slice("/api/laps/".length));
        if (ghost === null) return json({ ok: false, error: "Not found" }, 404, origin);
        return new Response(ghost, { headers: { ...headersFor(origin), "Content-Type": "application/json; charset=utf-8" } });
      }
    } catch (err) {
      console.error("lap board", err);
      return json({ ok: false, error: "The lap board had a problem. Try again in a moment" }, 500, origin);
    }
  }

  if (path === "/api/usage" && request.method === "POST") {
    if (!config.usage || !env.BOARD_DB) return json({ ok: false, error: "The usage counter is off" }, 404, origin);
    if (env.USAGE_LIMIT) {
      const { success } = await env.USAGE_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
      if (!success) return json({ ok: false, error: "Too many reports" }, 429, origin);
    }
    try {
      const answer = await recordUsage({ db: env.BOARD_DB, now: Date.now }, request);
      return json(answer.body, answer.status, origin);
    } catch (err) {
      console.error("usage", err);
      return json({ ok: false, error: "Not counted" }, 500, origin);
    }
  }

  // The owner's numbers. Every try counts against ADMIN_LIMIT before the key is looked at (a right key too, so a
  // guesser past the limit learns nothing from the answer), and anything short of the numbers is the plain
  // "Not found" every unknown path gets, which counts against the same limit: no key, a wrong one, a route that is
  // off, and a fault while reading
  if (path === "/api/admin" || path.startsWith("/api/admin/")) {
    if (await overLimit(env.ADMIN_LIMIT, request)) return tooMany(origin);
    if (!(await adminKeyMatches(bearerKey(request), env.ADMIN_KEY))) return notFound(origin);
    if (path === "/api/admin/stats" && request.method === "GET" && env.BOARD_DB) {
      const races = config.races ? env.RACES : undefined;
      try {
        const nextRace = races ? async () => (({ startsMs, waiting }) => ({ startsMs, waiting }))(await raceWaiting(races, config.raceSlotS, url)) : undefined;
        const answer = await adminStats({ db: env.BOARD_DB, now: Date.now, nextRace }, url);
        return json(answer.body, answer.status, origin);
      } catch (err) {
        // The message only: the request (and so the key) stays out of the logs
        console.error("admin stats failed:", err instanceof Error ? err.message : "error");
        return notFound(origin);
      }
    }
    // Cloudflare's own numbers for the site (analytics.ts), once an analytics token is set
    if (path === "/api/admin/cloudflare" && request.method === "GET" && analyticsConfigured(env)) {
      try {
        // Called as a plain function: the runtime's fetch refuses to run as another object's method
        const answer = await cloudflareStats(env, Date.now(), (input, init) => fetch(input, init));
        return json(answer, 200, origin);
      } catch (err) {
        console.error("cloudflare stats failed:", err instanceof Error ? err.message : "error");
        return notFound(origin);
      }
    }
    // Driver badges given by hand (awards.ts): list, grant, revoke
    if (path === "/api/admin/awards" && request.method === "GET" && env.BOARD_DB) {
      try {
        const answer = await adminListAwards(env.BOARD_DB, url);
        return json(answer.body, answer.status, origin);
      } catch (err) {
        console.error("admin awards list failed:", err instanceof Error ? err.message : "error");
        return notFound(origin);
      }
    }
    if (path === "/api/admin/awards" && request.method === "POST" && env.BOARD_DB) {
      try {
        const answer = await adminGrantAward(env.BOARD_DB, request, Date.now());
        return json(answer.body, answer.status, origin);
      } catch (err) {
        console.error("admin awards grant failed:", err instanceof Error ? err.message : "error");
        return notFound(origin);
      }
    }
    const awardDelete = /^\/api\/admin\/awards\/(\d{1,12})$/.exec(path);
    if (awardDelete && request.method === "DELETE" && env.BOARD_DB) {
      try {
        const answer = await adminRevokeAward(env.BOARD_DB, Number(awardDelete[1]));
        return json(answer.body, answer.status, origin);
      } catch (err) {
        console.error("admin awards revoke failed:", err instanceof Error ? err.message : "error");
        return notFound(origin);
      }
    }
    return notFound(origin);
  }

  if (await overLimit(env.ADMIN_LIMIT, request)) return tooMany(origin);
  return notFound(origin);
}
