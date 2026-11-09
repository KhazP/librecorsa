/**
 * The game's online side (cloudflare/api): where it lives and which parts of it are switched on.
 *
 * NEXT_PUBLIC_ONLINE_API is its base URL ("/api" on librecorsa.org, a full URL in development). Without it, or when
 * it can't be reached, every feature reads as off and the game uses what needs no server: room codes through the
 * public PeerJS broker, lap times kept in this browser. The switches are read at run time (GET <base>/config), so a
 * feature can be turned off on the server without a new build.
 */

import { DEFAULT_RACE_SLOT_S } from "./race-schedule";

export interface OnlineConfig {
  /** Room codes are paired by the room server */
  rooms: boolean;
  /** The room server hands out relay servers for players who can't connect directly */
  relay: boolean;
  /** Scheduled races run on the race server */
  races: boolean;
  /** The online lap boards */
  board: boolean;
  /** Seconds between scheduled races */
  raceSlotS: number;
}

const OFF: OnlineConfig = { rooms: false, relay: false, races: false, board: false, raceSlotS: DEFAULT_RACE_SLOT_S };
const CONFIG_TIMEOUT_MS = 5000;
/** A failed read is tried again after this long, a good one is kept this long (ms) */
const RETRY_AFTER_MS = 30_000;
const KEEP_FOR_MS = 10 * 60_000;

/** "/api" or "https://host/api" without a trailing slash; null when no online side is configured */
export function parseApiBase(raw: string | undefined): string | null {
  const url = raw?.trim().replace(/\/+$/, "") ?? "";
  return /^(https?:\/\/|\/)/.test(url) && url.length > 1 ? url : null;
}

export const onlineApiBase = parseApiBase(process.env.NEXT_PUBLIC_ONLINE_API);

/** The API's address for a path ("/config"); null without an online side */
export function onlineUrl(path: string): string | null {
  return onlineApiBase ? `${onlineApiBase}${path}` : null;
}

/** The WebSocket address for a path ("/rooms/ABC123?role=guest"); null without an online side */
export function onlineSocketUrl(path: string, pageOrigin?: string): string | null {
  if (!onlineApiBase) return null;
  const origin = pageOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const base = onlineApiBase.startsWith("/") ? `${origin}${onlineApiBase}` : onlineApiBase;
  return /^https?:\/\//.test(base) ? `${base.replace(/^http/, "ws")}${path}` : null;
}

/** Only the switches, and only real booleans: anything else from the network reads as off */
export function parseOnlineConfig(raw: unknown): OnlineConfig {
  if (typeof raw !== "object" || raw === null) return OFF;
  const r = raw as Record<string, unknown>;
  const slot = r.raceSlotS;
  return {
    rooms: r.rooms === true,
    relay: r.relay === true,
    races: r.races === true,
    board: r.board === true,
    raceSlotS: typeof slot === "number" && Number.isInteger(slot) && slot >= 30 && slot <= 86_400 ? slot : DEFAULT_RACE_SLOT_S,
  };
}

let cached: { config: OnlineConfig; at: number; ok: boolean } | null = null;
let pending: Promise<OnlineConfig> | null = null;

/** The switches as the server has them now (cached for a while); all off when it can't be asked */
export function getOnlineConfig(): Promise<OnlineConfig> {
  const url = onlineUrl("/config");
  if (!url || typeof fetch === "undefined") return Promise.resolve(OFF);
  const now = Date.now();
  if (cached && now - cached.at < (cached.ok ? KEEP_FOR_MS : RETRY_AFTER_MS)) return Promise.resolve(cached.config);
  pending ??= (async () => {
    let config = OFF;
    let ok = false;
    try {
      const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) });
      if (res.ok) {
        config = parseOnlineConfig(await res.json());
        ok = true;
      }
    } catch {
      // Unreachable: everything off for now
    }
    cached = { config, at: Date.now(), ok };
    pending = null;
    return config;
  })();
  return pending;
}
