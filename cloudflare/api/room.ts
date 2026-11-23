/**
 * The room server: one Durable Object per room code. It introduces the players of a private room to each other and
 * coordinates room-level settings and private-room qualifying (server-enforced private only), while the race itself
 * runs directly between their browsers (src/lib/sim/multiplayer-sync.ts).
 *
 * Sockets (GET /api/rooms/<CODE>?role=host&token=<secret>[&kind=private|public] or ?role=guest), JSON text messages:
 *   server -> host   { t: "welcome", iceServers }            the room is open under this code
 *                    { t: "taken" }                           another device already hosts this code (then closed)
 *                    { t: "signal", from: <guest>, data }     a guest's offer or candidate
 *                    { t: "left", id: <guest> }               a guest's socket closed
 *   server -> guest  { t: "welcome", id, iceServers }         the host is here: send the offer
 *                    { t: "nohost" } | { t: "full" }          nobody hosts this code / the room is full (then closed)
 *                    { t: "signal", data }                    the host's answer or candidate
 *   host -> server   { t: "signal", to: <guest>, data }
 *                    { t: "settings", settings }              update room LobbySettings (qualifying forced 0 on public rooms)
 *                    { t: "start_session", peers? }           start qualifying (private + qualifyingMinutes > 0) or race
 *                    { t: "start_qualifying", peers? }        start qualifying explicitly (private rooms only)
 *                    { t: "start_race", peers? }              start race immediately (sorts grid by qualifying laps if active)
 *                    { t: "abort" }                           return room to lobby phase
 *   guest -> server  { t: "signal", data }
 *   either -> server { t: "join", peerId }                    bind game peerId to this socket
 *                    { t: "progress", race } | { t: "lap", bestLapMs, sessionId? }  report valid qualifying best lap
 *   server -> all    { t: "room_state", state }               room settings & phase snapshot
 *                    { t: "phase", phase, sessionId, ... }    phase transition (qualifying / racing / lobby)
 *                    { t: "qualifying_update", sessionId, qualifyingEndsAt, times }
 *                    { t: "error", code, message }            validation error (e.g. qualifying_private_only)
 * A literal "ping" is answered "pong" without waking the object, which sleeps between messages.
 *
 * The host's token is a secret its browser made up: the same host coming back (a network change, the page woken up)
 * takes its room over again, while another device asking for a code in use is told it is taken.
 */
import {
  buildRaceGrid,
  FALLBACK_TRACK_ID,
  MIN_QUALIFYING_LAP_MS,
  PEER_ID_RE,
  sanitizeLobbySettings,
  sanitizeRace,
  sortQualifyingTimes,
  withLobbyDefaults,
  type LobbySettings,
  type QualifyingTime,
  type RoomKind,
  type RoomPhase,
} from "../../src/lib/net/wire";
import { generateIceServers, type IceServer } from "./turn";
import { workers, type DurableObjectState, type Env, type ServerSocket } from "./types";

export const ROOM_CODE_RE = /^[A-Z0-9]{3,6}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_GUESTS = 15;
/** An offer with its candidates is a few kB */
const MAX_MESSAGE_CHARS = 32 * 1024;
/** Messages one socket may send per ten seconds (an offer or answer plus its candidates is a few dozen) */
const MAX_MESSAGES_PER_10S = 200;
/** Valid qualifying lap bounds (ms): shared 10 s floor, under ~2.7 h */
const MIN_LAP_MS = MIN_QUALIFYING_LAP_MS;
const MAX_LAP_MS = 10_000_000;

type Attachment =
  | { role: "host"; peerId?: string }
  | { role: "guest"; id: string; peerId?: string; token?: string }
  | { role: "refused" };

export interface RoomSessionState {
  kind: RoomKind;
  phase: RoomPhase;
  settings: LobbySettings;
  sessionId: string | null;
  qualifyingEndsAt: number | null;
  qualifyingLaps: Record<string, number>;
  qualifying: QualifyingTime[];
  grid: string[];
  participants: string[];
}

const HOST_TAG = "host";
const guestTag = (id: string) => `g:${id}`;
const STATE_KEY = "roomState";

function defaultRoomState(kind: RoomKind): RoomSessionState {
  return {
    kind,
    phase: "lobby",
    settings: sanitizeLobbySettings(
      withLobbyDefaults({
        trackId: FALLBACK_TRACK_ID,
        laps: 5,
        collisions: "ghost_lap1",
        carClass: "any",
      }),
      kind,
    ),
    sessionId: null,
    qualifyingEndsAt: null,
    qualifyingLaps: {},
    qualifying: [],
    grid: [],
    participants: [],
  };
}

function attachmentOf(ws: ServerSocket): Attachment | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return a && typeof a === "object" && typeof a.role === "string" ? a : null;
}

function senderPeerId(who: Exclude<Attachment, { role: "refused" }>): string {
  if (who.peerId) return who.peerId;
  return who.role === "host" ? "host" : who.id;
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

function cleanPeerList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 32)) {
    if (typeof item !== "string" || !PEER_ID_RE.test(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : null;
}

export class RoomServer {
  /** Per socket: messages in the current ten-second window (in memory: starts again when the object wakes) */
  private rates = new WeakMap<ServerSocket, { windowStartMs: number; count: number }>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
    /** Replaced in tests */
    private readonly iceServers: (env: Env) => Promise<IceServer[]> = generateIceServers,
    /** Replaced in tests for deterministic qualifying timers */
    private readonly now: () => number = Date.now,
    /** Replaced in tests for deterministic random grids */
    private readonly rng: () => number = Math.random,
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
    const kindParam = url.searchParams.get("kind");
    const kind: RoomKind = kindParam === "public" || url.searchParams.get("public") === "1" ? "public" : "private";
    if (role !== "host" && role !== "guest") return new Response("Bad role", { status: 400 });
    if (role === "host" && !TOKEN_RE.test(token)) return new Response("Bad token", { status: 400 });
    const pair = new workers.WebSocketPair();
    await this.connect(role, token, pair[1], kind);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  private async loadRoomState(defaultKind: RoomKind = "private"): Promise<RoomSessionState> {
    const saved = await this.state.storage.get<RoomSessionState>(STATE_KEY);
    if (saved && typeof saved === "object" && (saved.kind === "private" || saved.kind === "public")) {
      return {
        ...saved,
        settings: sanitizeLobbySettings(saved.settings, saved.kind),
        qualifyingLaps: saved.qualifyingLaps ? { ...saved.qualifyingLaps } : {},
        qualifying: Array.isArray(saved.qualifying) ? [...saved.qualifying] : [],
        grid: Array.isArray(saved.grid) ? [...saved.grid] : [],
        participants: Array.isArray(saved.participants) ? [...saved.participants] : [],
      };
    }
    return defaultRoomState(defaultKind);
  }

  private async saveRoomState(roomState: RoomSessionState): Promise<void> {
    await this.state.storage.put(STATE_KEY, roomState);
  }

  private broadcast(message: unknown): void {
    for (const ws of this.state.getWebSockets()) {
      const a = attachmentOf(ws);
      if (!a || a.role === "refused") continue;
      send(ws, message);
    }
  }

  private activeParticipants(roomState: RoomSessionState, explicitPeers: string[] | null = null): string[] {
    const fromSockets: string[] = [];
    const connected = new Set<string>();
    for (const ws of this.state.getWebSockets(HOST_TAG)) {
      const a = attachmentOf(ws);
      if (a && a.role === "host") {
        const pid = senderPeerId(a);
        if (!connected.has(pid)) {
          connected.add(pid);
          fromSockets.push(pid);
        }
      }
    }
    for (const ws of this.state.getWebSockets()) {
      const a = attachmentOf(ws);
      if (a && a.role === "guest") {
        const pid = senderPeerId(a);
        if (!connected.has(pid)) {
          connected.add(pid);
          fromSockets.push(pid);
        }
      }
    }
    const preferred = explicitPeers && explicitPeers.length > 0 ? explicitPeers : roomState.participants;
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const p of preferred) {
      if (connected.has(p) && !seen.has(p)) {
        seen.add(p);
        merged.push(p);
      }
    }
    if (!explicitPeers || merged.length === 0) {
      for (const p of fromSockets) {
        if (!seen.has(p)) {
          seen.add(p);
          merged.push(p);
        }
      }
    }
    roomState.participants = merged;
    return merged;
  }

  /** Takes a new socket into the room as its host or a guest, or tells it why not and closes it */
  async connect(role: "host" | "guest", token: string, server: ServerSocket, kind: RoomKind = "private"): Promise<void> {
    const refuse = (message: unknown) => {
      this.state.acceptWebSocket(server, ["refused"]);
      server.serializeAttachment({ role: "refused" } satisfies Attachment);
      send(server, message);
      close(server, 4000, "refused");
    };

    if (role === "host") {
      const current = this.state.getWebSockets(HOST_TAG).filter((ws) => attachmentOf(ws)?.role === "host");
      const owner = await this.state.storage.get<string>("hostToken");
      if (current.length > 0 && owner !== token) return refuse({ t: "taken" });
      // The same host back on a new socket: demote before closing so a still-listed closing socket never triggers peer_id_taken
      for (const old of current) {
        old.serializeAttachment({ role: "refused" } satisfies Attachment);
        close(old, 4001, "replaced");
      }
      const freshHost = owner !== token || !(await this.state.storage.get<RoomSessionState>(STATE_KEY));
      await this.state.storage.put("hostToken", token);
      if (freshHost) {
        // Evict lingering guests from any prior host's room before resetting room state
        for (const ws of this.state.getWebSockets()) {
          if (attachmentOf(ws)?.role === "guest") {
            ws.serializeAttachment({ role: "refused" } satisfies Attachment);
            close(ws, 4001, "room_reset");
          }
        }
        await this.state.storage.deleteAlarm();
        const fresh = defaultRoomState(kind);
        fresh.participants = ["host"];
        await this.saveRoomState(fresh);
      }
      this.state.acceptWebSocket(server, [HOST_TAG]);
      server.serializeAttachment({ role: "host" } satisfies Attachment);
      send(server, { t: "welcome", iceServers: await this.iceServers(this.env) });
      return;
    }

    const activeHostCount = this.state.getWebSockets(HOST_TAG).filter((ws) => attachmentOf(ws)?.role === "host").length;
    if (activeHostCount === 0) return refuse({ t: "nohost" });
    const guestToken = TOKEN_RE.test(token) ? token : undefined;
    const activeGuests = this.state.getWebSockets().filter((ws) => attachmentOf(ws)?.role === "guest");
    const replacedGuests = guestToken
      ? activeGuests.filter((ws) => {
          const oa = attachmentOf(ws);
          return oa?.role === "guest" && oa.token === guestToken;
        })
      : [];
    if (activeGuests.length - replacedGuests.length >= MAX_GUESTS) return refuse({ t: "full" });
    const replacedIds: string[] = [];
    const replacedKeys = new Set<string>();
    // The same guest back on a new socket: demote before closing so a half-open socket never triggers full or
    // peer_id_taken, and run leave cleanup below because webSocketClose skips refused sockets
    for (const old of replacedGuests) {
      const oa = attachmentOf(old);
      if (oa?.role !== "guest") continue;
      replacedIds.push(oa.id);
      replacedKeys.add(senderPeerId(oa));
      replacedKeys.add(oa.id);
      old.serializeAttachment({ role: "refused" } satisfies Attachment);
      close(old, 4001, "replaced");
    }
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.state.acceptWebSocket(server, [guestTag(id)]);
    server.serializeAttachment({ role: "guest", id, ...(guestToken ? { token: guestToken } : {}) } satisfies Attachment);
    const roomState = await this.loadRoomState();
    let participantsChanged = false;
    for (const staleKey of replacedKeys) {
      const stillOwned = this.state.getWebSockets().some((other) => {
        const a = attachmentOf(other);
        return a !== null && a.role !== "refused" && (senderPeerId(a) === staleKey || (a.role === "guest" && a.id === staleKey));
      });
      if (!stillOwned) {
        const idx = roomState.participants.indexOf(staleKey);
        if (idx >= 0) {
          roomState.participants.splice(idx, 1);
          participantsChanged = true;
        }
      }
    }
    if (!roomState.participants.includes(id)) {
      roomState.participants.push(id);
      participantsChanged = true;
    }
    if (participantsChanged) await this.saveRoomState(roomState);
    if (replacedIds.length > 0) {
      for (const host of this.state.getWebSockets(HOST_TAG)) {
        if (attachmentOf(host)?.role !== "host") continue;
        for (const oldId of replacedIds) send(host, { t: "left", id: oldId });
      }
    }
    send(server, { t: "welcome", id, iceServers: await this.iceServers(this.env) });
  }

  /** Transitions from qualifying (or lobby) to racing, sorting the grid by qualifying best laps if qualifying ran */
  private async transitionToRacing(roomState: RoomSessionState, explicitPeers: string[] | null = null): Promise<void> {
    const peers = this.activeParticipants(roomState, explicitPeers);
    const fromQualifying = roomState.phase === "qualifying";
    const qualifying = fromQualifying ? sortQualifyingTimes(peers, roomState.qualifyingLaps) : [];
    const grid = buildRaceGrid(peers, {
      gridOrder: roomState.settings.gridOrder ?? "qualifying",
      qualifyingTimes: fromQualifying ? qualifying : undefined,
      fromQualifying,
      rng: this.rng,
    });
    const sessionId = roomState.sessionId ?? crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    roomState.phase = "racing";
    roomState.sessionId = sessionId;
    roomState.qualifyingEndsAt = null;
    roomState.qualifying = qualifying;
    roomState.grid = grid;
    await this.state.storage.deleteAlarm();
    await this.saveRoomState(roomState);
    this.broadcast({
      t: "phase",
      phase: "racing",
      sessionId,
      grid,
      qualifying,
      settings: roomState.settings,
      startedAt: this.now(),
    });
  }

  /** Starts a private-room qualifying session and sets the Durable Object alarm for its deadline */
  private async startQualifyingSession(
    ws: ServerSocket,
    roomState: RoomSessionState,
    explicitPeers: string[] | null = null,
    requestedSessionId?: string,
  ): Promise<void> {
    if (roomState.kind === "public") {
      send(ws, { t: "error", code: "qualifying_private_only", message: "Qualifying is only available in private rooms" });
      return;
    }
    const minutes = roomState.settings.qualifyingMinutes ?? 0;
    if (minutes <= 0) {
      send(ws, { t: "error", code: "qualifying_disabled", message: "Qualifying duration must be greater than 0" });
      return;
    }
    const peers = this.activeParticipants(roomState, explicitPeers);
    const sessionId =
      requestedSessionId && PEER_ID_RE.test(requestedSessionId)
        ? requestedSessionId.slice(0, 32)
        : crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const qualifyingEndsAt = this.now() + minutes * 60_000;
    roomState.phase = "qualifying";
    roomState.sessionId = sessionId;
    roomState.qualifyingEndsAt = qualifyingEndsAt;
    roomState.qualifyingLaps = {};
    roomState.qualifying = sortQualifyingTimes(peers, {});
    roomState.grid = [];
    await this.saveRoomState(roomState);
    await this.state.storage.setAlarm(qualifyingEndsAt);
    this.broadcast({
      t: "phase",
      phase: "qualifying",
      sessionId,
      minutes,
      qualifyingEndsAt,
      settings: roomState.settings,
      times: roomState.qualifying,
    });
  }

  /** Fires when the qualifying timer expires: sorts the race grid by valid bestLapMs and transitions to racing */
  async alarm(): Promise<void> {
    const roomState = await this.loadRoomState();
    if (roomState.phase !== "qualifying" || roomState.qualifyingEndsAt === null) return;
    if (this.now() < roomState.qualifyingEndsAt) {
      await this.state.storage.setAlarm(roomState.qualifyingEndsAt);
      return;
    }
    await this.transitionToRacing(roomState);
  }

  /** Read-only snapshot of the current room state (used in tests and diagnostics) */
  async getRoomState(): Promise<RoomSessionState> {
    return this.loadRoomState();
  }

  private withinRate(ws: ServerSocket): boolean {
    const now = this.now();
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
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message);
      if (!parsed || typeof parsed !== "object") return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.t) {
      case "signal": {
        if (typeof msg.data !== "object" || msg.data === null) return;
        if (who.role === "guest") {
          for (const host of this.state.getWebSockets(HOST_TAG)) {
            if (attachmentOf(host)?.role !== "host") continue;
            send(host, { t: "signal", from: who.id, data: msg.data });
          }
        } else if (typeof msg.to === "string" && /^[a-f0-9]{12}$/.test(msg.to)) {
          for (const guest of this.state.getWebSockets(guestTag(msg.to))) send(guest, { t: "signal", data: msg.data });
        }
        return;
      }

      case "join": {
        if (typeof msg.peerId !== "string" || !PEER_ID_RE.test(msg.peerId)) return;
        const nextPeerId = msg.peerId;
        // Once a socket binds a peerId, prevent switching it mid-connection (idempotent re-send is a no-op)
        if (who.peerId !== undefined) {
          if (who.peerId !== nextPeerId) {
            send(ws, { t: "error", code: "peer_id_locked", message: "Peer ID is already bound for this connection" });
          }
          return;
        }
        // Prevent hijacking any currently connected socket's peerId/id or claiming the host default id as a guest
        let taken = who.role === "guest" && nextPeerId === "host";
        const replaceable: { socket: ServerSocket; id: string; peerId: string }[] = [];
        if (!taken) {
          for (const other of this.state.getWebSockets()) {
            if (other === ws) continue;
            const oa = attachmentOf(other);
            if (!oa || oa.role === "refused") continue;
            const conflict = senderPeerId(oa) === nextPeerId || (oa.role === "guest" && oa.id === nextPeerId);
            if (!conflict) continue;
            if (who.role === "guest" && who.token && oa.role === "guest" && oa.token === who.token) {
              replaceable.push({ socket: other, id: oa.id, peerId: senderPeerId(oa) });
              continue;
            }
            taken = true;
            break;
          }
        }
        if (taken) {
          send(ws, { t: "error", code: "peer_id_taken", message: "Peer ID is already owned by another connection" });
          return;
        }
        for (const r of replaceable) {
          r.socket.serializeAttachment({ role: "refused" } satisfies Attachment);
          close(r.socket, 4001, "replaced");
        }
        const oldPeerId = senderPeerId(who);
        const updated: Attachment =
          who.role === "host"
            ? { role: "host", peerId: nextPeerId }
            : { role: "guest", id: who.id, peerId: nextPeerId, ...(who.token ? { token: who.token } : {}) };
        ws.serializeAttachment(updated);
        const roomState = await this.loadRoomState();
        for (const r of replaceable) {
          for (const staleKey of new Set([r.peerId, r.id])) {
            if (staleKey === nextPeerId || staleKey === oldPeerId) continue;
            const stillOwned = this.state.getWebSockets().some((other) => {
              const a = attachmentOf(other);
              return a !== null && a.role !== "refused" && (senderPeerId(a) === staleKey || (a.role === "guest" && a.id === staleKey));
            });
            if (!stillOwned) {
              const staleIdx = roomState.participants.indexOf(staleKey);
              if (staleIdx >= 0) roomState.participants.splice(staleIdx, 1);
            }
          }
        }
        const idx = roomState.participants.indexOf(oldPeerId);
        if (idx >= 0) {
          if (roomState.participants.includes(nextPeerId) && oldPeerId !== nextPeerId) {
            roomState.participants.splice(idx, 1);
          } else {
            roomState.participants[idx] = nextPeerId;
          }
        } else if (!roomState.participants.includes(nextPeerId)) {
          roomState.participants.push(nextPeerId);
        }
        if (oldPeerId !== nextPeerId && roomState.qualifyingLaps[oldPeerId] !== undefined) {
          const prev = roomState.qualifyingLaps[nextPeerId];
          roomState.qualifyingLaps[nextPeerId] =
            prev === undefined ? roomState.qualifyingLaps[oldPeerId] : Math.min(prev, roomState.qualifyingLaps[oldPeerId]);
          delete roomState.qualifyingLaps[oldPeerId];
        }
        await this.saveRoomState(roomState);
        if (replaceable.length > 0) {
          for (const host of this.state.getWebSockets(HOST_TAG)) {
            if (attachmentOf(host)?.role !== "host") continue;
            for (const r of replaceable) send(host, { t: "left", id: r.id });
          }
        }
        return;
      }

      case "settings": {
        if (who.role !== "host" || !msg.settings || typeof msg.settings !== "object") return;
        const roomState = await this.loadRoomState();
        const rawSettings = msg.settings as Record<string, unknown>;
        const requestedQuali = typeof rawSettings.qualifyingMinutes === "number" ? rawSettings.qualifyingMinutes : 0;
        roomState.settings = sanitizeLobbySettings({ ...roomState.settings, ...rawSettings }, roomState.kind);
        await this.saveRoomState(roomState);
        if (roomState.kind === "public" && requestedQuali > 0) {
          send(ws, { t: "error", code: "qualifying_private_only", message: "Qualifying is only available in private rooms" });
        }
        this.broadcast({ t: "room_state", state: roomState });
        return;
      }

      case "start_qualifying": {
        if (who.role !== "host") return;
        const roomState = await this.loadRoomState();
        const reqId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
        await this.startQualifyingSession(ws, roomState, cleanPeerList(msg.peers), reqId);
        return;
      }

      case "start_session": {
        if (who.role !== "host") return;
        const roomState = await this.loadRoomState();
        const explicitPeers = cleanPeerList(msg.peers);
        const reqId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
        if (roomState.kind === "private" && (roomState.settings.qualifyingMinutes ?? 0) > 0) {
          await this.startQualifyingSession(ws, roomState, explicitPeers, reqId);
        } else {
          roomState.settings = sanitizeLobbySettings(roomState.settings, roomState.kind);
          await this.transitionToRacing(roomState, explicitPeers);
        }
        return;
      }

      case "start_race": {
        if (who.role !== "host") return;
        const roomState = await this.loadRoomState();
        await this.transitionToRacing(roomState, cleanPeerList(msg.peers));
        return;
      }

      case "progress":
      case "lap": {
        const roomState = await this.loadRoomState();
        if (roomState.phase !== "qualifying" || !roomState.sessionId) return;
        let bestLapMs: number | null = null;
        if (msg.t === "progress") {
          const race = sanitizeRace(msg.race);
          if (!race || race.id !== roomState.sessionId) return;
          bestLapMs = race.best;
        } else {
          if (typeof msg.sessionId !== "string" || msg.sessionId !== roomState.sessionId) return;
          bestLapMs = typeof msg.bestLapMs === "number" && Number.isFinite(msg.bestLapMs) ? msg.bestLapMs : null;
        }
        if (bestLapMs === null || bestLapMs < MIN_LAP_MS || bestLapMs > MAX_LAP_MS) return;
        const peerId = senderPeerId(who);
        if (!roomState.participants.includes(peerId)) roomState.participants.push(peerId);
        const rounded = Math.round(bestLapMs);
        const prev = roomState.qualifyingLaps[peerId];
        if (prev !== undefined && rounded >= prev) return;
        roomState.qualifyingLaps[peerId] = rounded;
        roomState.qualifying = sortQualifyingTimes(roomState.participants, roomState.qualifyingLaps);
        await this.saveRoomState(roomState);
        this.broadcast({
          t: "qualifying_update",
          sessionId: roomState.sessionId,
          qualifyingEndsAt: roomState.qualifyingEndsAt,
          times: roomState.qualifying,
        });
        return;
      }

      case "abort": {
        if (who.role !== "host") return;
        const roomState = await this.loadRoomState();
        roomState.phase = "lobby";
        roomState.sessionId = null;
        roomState.qualifyingEndsAt = null;
        roomState.qualifyingLaps = {};
        roomState.qualifying = [];
        roomState.grid = [];
        await this.state.storage.deleteAlarm();
        await this.saveRoomState(roomState);
        this.broadcast({ t: "phase", phase: "lobby", settings: roomState.settings });
        return;
      }

      default:
        return;
    }
  }

  async webSocketClose(ws: ServerSocket, code: number): Promise<void> {
    const who = attachmentOf(ws);
    if (who && who.role !== "refused") {
      const peerId = senderPeerId(who);
      const stillOwnedElsewhere = this.state.getWebSockets().some((other) => {
        if (other === ws) return false;
        const oa = attachmentOf(other);
        return oa !== null && oa.role !== "refused" && senderPeerId(oa) === peerId;
      });
      if (!stillOwnedElsewhere) {
        const roomState = await this.loadRoomState();
        const idx = roomState.participants.indexOf(peerId);
        if (idx >= 0) {
          roomState.participants.splice(idx, 1);
          await this.saveRoomState(roomState);
        }
      }
      if (who.role === "guest") {
        for (const host of this.state.getWebSockets(HOST_TAG)) {
          if (attachmentOf(host)?.role !== "host") continue;
          send(host, { t: "left", id: who.id });
        }
      }
    }
    close(ws, code === 1005 || code === 1006 ? 1000 : code, "closed");
  }

  async webSocketError(ws: ServerSocket): Promise<void> {
    close(ws, 1011, "error");
  }
}
