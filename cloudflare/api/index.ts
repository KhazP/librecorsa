/**
 * librecorsa.org's online API, served by the site Worker under /api (cloudflare/worker.js):
 *   GET /api/config               which online features this deployment has switched on
 *   GET /api/rooms/<CODE>         WebSocket to a private room's server (room.ts)
 *   POST /api/laps, GET /api/laps, GET /api/laps/<id>   the lap boards (board.ts)
 *   POST /api/drivers/rename                           a driver's new name, their laps with it (board.ts)
 *   GET /api/races/next, /api/races/<n>                 WebSocket to a scheduled race's server (race.ts)
 *   GET /api/races/waiting                              who is waiting for the next race (race.ts, read only)
 *   POST /api/usage               one stretch of driving for the anonymous daily totals (usage.ts)
 *   GET /api/admin/stats          the owner's numbers, with the X-Admin-Key header (admin.ts)
 *   GET /api/races/results, GET /api/drivers/record     the open races' results (results.ts)
 * Every feature is optional: with its binding missing or its switch off (wrangler.jsonc `vars`), the config says
 * so and the game falls back to what works without a server.
 *
 * Nothing here is kept at the edge: Workers caching is on for the site's large files, so every answer says no-store.
 */
import { DEFAULT_RACE_SLOT_S, nextRaceSlot, raceSlot } from "../../src/lib/net/race-schedule";
import { challengeProblem } from "../../src/lib/net/weekly-challenge";
import { boardDeps, ghostOf, listLaps, renameDriver, submitLap } from "./board";
import { driverRecord, listRaceResults } from "./results";
import { ROOM_CODE_RE } from "./room";
import { adminKeyMatches, adminStats } from "./admin";
import { turnConfigured } from "./turn";
import { recordUsage } from "./usage";
import type { Env } from "./types";

export { RaceServer } from "./race";
export { RoomServer } from "./room";

const on = (value: string | undefined): boolean => value === "on";

/** Seconds between scheduled races: RACE_SLOT_S, else every 20 minutes */
export function raceSlotSeconds(env: Env): number {
  const s = Number(env.RACE_SLOT_S);
  return Number.isInteger(s) && s >= 30 && s <= 86_400 ? s : DEFAULT_RACE_SLOT_S;
}

/** What the game may use online, as the Worker is configured right now */
export function onlineConfig(env: Env): { rooms: boolean; relay: boolean; races: boolean; board: boolean; raceSlotS: number; usage: boolean } {
  return {
    rooms: on(env.ONLINE_ROOMS) && Boolean(env.ROOMS),
    relay: on(env.ONLINE_ROOMS) && Boolean(env.ROOMS) && turnConfigured(env),
    races: on(env.ONLINE_RACES) && Boolean(env.RACES),
    board: on(env.ONLINE_BOARD) && Boolean(env.BOARD_DB) && Boolean(env.GHOSTS),
    raceSlotS: raceSlotSeconds(env),
    usage: on(env.ONLINE_USAGE) && Boolean(env.BOARD_DB),
  };
}

/** The request's Origin when it may call the API: the site itself, or a development origin from DEV_ORIGINS */
function allowedOrigin(request: Request, url: URL, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === url.origin) return origin;
  const extra = (env.DEV_ORIGINS ?? "").split(",").map((o) => o.trim());
  return extra.includes(origin) ? origin : null;
}

function headersFor(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Admin-Key";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

export function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headersFor(origin), "Content-Type": "application/json; charset=utf-8" },
  });
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
    const slot = nextRaceSlot(Date.now(), config.raceSlotS);
    const to = new URL(request.url);
    to.searchParams.set("peek", "1");
    const res = await env.RACES.get(env.RACES.idFromName(`race-${config.raceSlotS}-${slot.index}`)).fetch(new Request(to));
    const seen = (await res.json().catch(() => null)) as { waiting?: unknown; names?: unknown } | null;
    const waiting = typeof seen?.waiting === "number" ? seen.waiting : 0;
    const names = Array.isArray(seen?.names) ? seen.names.filter((n): n is string => typeof n === "string") : [];
    return json({ ok: true, startsMs: slot.startsMs, waiting, names }, 200, origin);
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

  if (path === "/api/drivers/rename" && request.method === "POST") {
    const deps = config.board ? boardDeps(env, challengeProblem) : null;
    if (!deps) return json({ ok: false, error: "The lap boards are off" }, 404, origin);
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
        const answer = await submitLap(deps, request);
        return json(answer.body, answer.status, origin);
      }
      if (path === "/api/laps" && request.method === "GET") {
        const answer = await listLaps(deps, url);
        return json(answer.body, answer.status, origin);
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

  // The owner's numbers: without the right key this falls through to the plain "Not found" below
  if (path === "/api/admin/stats" && request.method === "GET" && env.BOARD_DB && (await adminKeyMatches(request.headers.get("X-Admin-Key"), env.ADMIN_KEY))) {
    try {
      const answer = await adminStats({ db: env.BOARD_DB, now: Date.now }, url);
      return json(answer.body, answer.status, origin);
    } catch (err) {
      console.error("admin stats", err);
      return json({ ok: false, error: "The numbers could not be read" }, 500, origin);
    }
  }

  return json({ ok: false, error: "Not found" }, 404, origin);
}
