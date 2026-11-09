/**
 * Short-lived connection servers from Cloudflare's TURN service, for players whose networks block a direct link
 * (strict routers, mobile data). They are only handed out through a room's socket (room.ts), never from an open
 * endpoint: traffic through them is billed to this account.
 */
import type { Env } from "./types";

/** One entry of RTCPeerConnection's `iceServers` */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Longer than any race session: an allocation is refreshed with the same credentials for as long as it lives */
const CREDENTIAL_TTL_S = 6 * 3600;
const REQUEST_TIMEOUT_MS = 4000;

const isIceUrl = (u: unknown): u is string => typeof u === "string" && u.length <= 256 && /^(stun|turns?):/i.test(u);

/** Keeps well-formed servers only, and no port-53 URLs (browsers time out on them) */
export function cleanIceServers(raw: unknown): IceServer[] {
  if (!Array.isArray(raw)) return [];
  const out: IceServer[] = [];
  for (const entry of raw.slice(0, 8)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const urls = (Array.isArray(e.urls) ? e.urls : [e.urls]).filter(isIceUrl).filter((u) => !/:53(\?|$)/.test(u));
    if (urls.length === 0) continue;
    const server: IceServer = { urls };
    if (typeof e.username === "string" && e.username.length <= 512) server.username = e.username;
    if (typeof e.credential === "string" && e.credential.length <= 512) server.credential = e.credential;
    out.push(server);
  }
  return out;
}

/** True when a TURN key is configured */
export const turnConfigured = (env: Env): boolean => Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);

/** Fresh connection servers; [] when no key is configured or the service can't be reached (players connect directly) */
export async function generateIceServers(env: Env, fetcher: typeof fetch = fetch): Promise<IceServer[]> {
  if (!turnConfigured(env)) return [];
  try {
    const res = await fetcher(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID ?? "")}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { iceServers?: unknown };
    return cleanIceServers(body.iceServers);
  } catch {
    return [];
  }
}
