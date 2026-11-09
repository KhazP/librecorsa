/**
 * The room server: one Durable Object per room code. It introduces the players of a private room to each other and
 * then stays out of the way: the host and each guest exchange their connection offers through it, and the race itself
 * runs directly between their browsers (src/lib/sim/multiplayer-sync.ts).
 *
 * Sockets (GET /api/rooms/<CODE>?role=host&token=<secret> or ?role=guest), JSON text messages:
 *   server -> host   { t: "welcome", iceServers }            the room is open under this code
 *                    { t: "taken" }                           another device already hosts this code (then closed)
 *                    { t: "signal", from: <guest>, data }     a guest's offer or candidate
 *                    { t: "left", id: <guest> }               a guest's socket closed
 *   server -> guest  { t: "welcome", id, iceServers }         the host is here: send the offer
 *                    { t: "nohost" } | { t: "full" }          nobody hosts this code / the room is full (then closed)
 *                    { t: "signal", data }                    the host's answer or candidate
 *   host -> server   { t: "signal", to: <guest>, data }
 *   guest -> server  { t: "signal", data }
 * A literal "ping" is answered "pong" without waking the object, which sleeps between messages.
 *
 * The host's token is a secret its browser made up: the same host coming back (a network change, the page woken up)
 * takes its room over again, while another device asking for a code in use is told it is taken.
 */
import { generateIceServers, type IceServer } from "./turn";
import { workers, type DurableObjectState, type Env, type ServerSocket } from "./types";

export const ROOM_CODE_RE = /^[A-Z0-9]{3,6}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_GUESTS = 15;
/** An offer with its candidates is a few kB */
const MAX_MESSAGE_CHARS = 32 * 1024;
/** Messages one socket may send per ten seconds (an offer or answer plus its candidates is a few dozen) */
const MAX_MESSAGES_PER_10S = 200;

type Attachment = { role: "host" } | { role: "guest"; id: string } | { role: "refused" };

const HOST_TAG = "host";
const guestTag = (id: string) => `g:${id}`;

function attachmentOf(ws: ServerSocket): Attachment | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return a && typeof a === "object" && typeof a.role === "string" ? a : null;
}

function send(ws: ServerSocket, message: unknown): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket closed meanwhile
  }
}

function close(ws: ServerSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed
  }
}

export class RoomServer {
  /** Per socket: messages in the current ten-second window (in memory: starts again when the object wakes) */
  private rates = new WeakMap<ServerSocket, { windowStartMs: number; count: number }>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
    /** Replaced in tests */
    private readonly iceServers: (env: Env) => Promise<IceServer[]> = generateIceServers,
  ) {
    state.setWebSocketAutoResponse(new workers.WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token") ?? "";
    if (role !== "host" && role !== "guest") return new Response("Bad role", { status: 400 });
    if (role === "host" && !TOKEN_RE.test(token)) return new Response("Bad token", { status: 400 });
    const pair = new workers.WebSocketPair();
    await this.connect(role, token, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** Takes a new socket into the room as its host or a guest, or tells it why not and closes it */
  async connect(role: "host" | "guest", token: string, server: ServerSocket): Promise<void> {
    const refuse = (message: unknown) => {
      this.state.acceptWebSocket(server, ["refused"]);
      server.serializeAttachment({ role: "refused" } satisfies Attachment);
      send(server, message);
      close(server, 4000, "refused");
    };

    if (role === "host") {
      const current = this.state.getWebSockets(HOST_TAG);
      const owner = await this.state.storage.get<string>("hostToken");
      if (current.length > 0 && owner !== token) return refuse({ t: "taken" });
      // The same host back on a new socket: the old one goes
      for (const old of current) close(old, 4001, "replaced");
      await this.state.storage.put("hostToken", token);
      this.state.acceptWebSocket(server, [HOST_TAG]);
      server.serializeAttachment({ role: "host" } satisfies Attachment);
      send(server, { t: "welcome", iceServers: await this.iceServers(this.env) });
      return;
    }

    const guests = this.state.getWebSockets().filter((ws) => attachmentOf(ws)?.role === "guest").length;
    if (this.state.getWebSockets(HOST_TAG).length === 0) return refuse({ t: "nohost" });
    if (guests >= MAX_GUESTS) return refuse({ t: "full" });
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.state.acceptWebSocket(server, [guestTag(id)]);
    server.serializeAttachment({ role: "guest", id } satisfies Attachment);
    send(server, { t: "welcome", id, iceServers: await this.iceServers(this.env) });
  }

  private withinRate(ws: ServerSocket): boolean {
    const now = Date.now();
    let r = this.rates.get(ws);
    if (!r || now - r.windowStartMs >= 10_000) {
      r = { windowStartMs: now, count: 0 };
      this.rates.set(ws, r);
    }
    return ++r.count <= MAX_MESSAGES_PER_10S;
  }

  async webSocketMessage(ws: ServerSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS || !this.withinRate(ws)) return;
    const who = attachmentOf(ws);
    if (!who || who.role === "refused") return;
    let msg: { t?: unknown; to?: unknown; data?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || msg.t !== "signal" || typeof msg.data !== "object" || msg.data === null) return;

    if (who.role === "guest") {
      for (const host of this.state.getWebSockets(HOST_TAG)) send(host, { t: "signal", from: who.id, data: msg.data });
    } else if (typeof msg.to === "string" && /^[a-f0-9]{12}$/.test(msg.to)) {
      for (const guest of this.state.getWebSockets(guestTag(msg.to))) send(guest, { t: "signal", data: msg.data });
    }
  }

  async webSocketClose(ws: ServerSocket, code: number): Promise<void> {
    const who = attachmentOf(ws);
    if (who?.role === "guest") {
      for (const host of this.state.getWebSockets(HOST_TAG)) send(host, { t: "left", id: who.id });
    }
    close(ws, code === 1005 || code === 1006 ? 1000 : code, "closed");
  }

  async webSocketError(ws: ServerSocket): Promise<void> {
    close(ws, 1011, "error");
  }
}
