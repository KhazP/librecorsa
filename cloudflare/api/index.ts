/**
 * librecorsa.org's online API, served by the site Worker under /api (cloudflare/worker.js):
 *   GET /api/config               which online features this deployment has switched on
 *   GET /api/rooms/<CODE>         WebSocket to a private room's server (room.ts)
 *   POST /api/laps, GET /api/laps, GET /api/laps/<id>   the lap boards (board.ts)
 * Every feature is optional: with its binding missing or its switch off (wrangler.jsonc `vars`), the config says
 * so and the game falls back to what works without a server.
 *
 * Nothing here is kept at the edge: Workers caching is on for the site's large files, so every answer says no-store.
 */
import { boardDeps, ghostOf, listLaps, submitLap, type EventRule } from "./board";
import { ROOM_CODE_RE } from "./room";
import { turnConfigured } from "./turn";
import type { Env } from "./types";

export { RoomServer } from "./room";

const on = (value: string | undefined): boolean => value === "on";

/** What the game may use online, as the Worker is configured right now */
export function onlineConfig(env: Env): { rooms: boolean; relay: boolean; races: boolean; board: boolean } {
  return {
    rooms: on(env.ONLINE_ROOMS) && Boolean(env.ROOMS),
    relay: on(env.ONLINE_ROOMS) && Boolean(env.ROOMS) && turnConfigured(env),
    races: on(env.ONLINE_RACES) && Boolean(env.RACES),
    board: on(env.ONLINE_BOARD) && Boolean(env.BOARD_DB) && Boolean(env.GHOSTS),
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
    headers["Access-Control-Allow-Headers"] = "Content-Type";
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

/** Which laps may go on a weekly challenge's board */
const eventRule: EventRule = () => "Unknown event";

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

  if (path === "/api/laps" || path.startsWith("/api/laps/")) {
    const deps = config.board ? boardDeps(env, eventRule) : null;
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

  return json({ ok: false, error: "Not found" }, 404, origin);
}
