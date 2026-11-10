/**
 * The race server: one Durable Object per scheduled race (src/lib/net/race-schedule.ts). A scheduled race has no
 * host, so this stands in for one: it keeps the lobby, tells everyone the grid shortly before the lights, answers
 * clock pings so every car's lights run on its clock, and passes each car's state on to the others.
 *
 * It speaks the game's own multiplayer messages (src/lib/net/wire.ts), as a room's host does over WebRTC, so the game
 * follows it with the code that follows a host:
 *   client -> server  { ctl: hello | ping | pong, from }   and car state packets
 *   server -> client  { t: "welcome", now, startsMs, index }, then { ctl: lobby | start | pong, from: "race_server" },
 *                     the other cars' state packets, and their pings and pongs (each car measures its delay to each other)
 *                     { t: "closed" | "full" | "started" | "taken" | "bad" } when it won't take the socket
 * Only the server ever sends a lobby or a start. A socket speaks for one car: the id it connected with.
 *
 * Sockets come through the Worker (GET /api/races/next, or /api/races/<n> to get back into a race under way), which
 * works out the slot from its own clock and passes it on in the query; nobody reaches this object directly.
 */
import { RACE_COUNTDOWN_MS, RACE_JOIN_CUTOFF_MS, raceRules, raceSlot } from "../../src/lib/net/race-schedule";
import { PEER_ID_RE, sanitizeControl, sanitizePacket, type LobbyPlayer, type LobbyState, type RaceStartInfo } from "../../src/lib/net/wire";
import { driverNameKey } from "./board";
import { workers, type D1Database, type DurableObjectState, type Env, type ServerSocket } from "./types";

export const RACE_SERVER_ID = "race_server";
export const MAX_RACERS = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE_CHARS = 16 * 1024;
/** As a room's host: more than this per second from one car is a flood, and the excess is dropped */
const MAX_STATE_PER_S = 60;
const MAX_CONTROL_PER_S = 40;
/** An entrant silent this long when the grid is made has gone (the game pings every 2 s) */
const GONE_AFTER_MS = 12_000;
/** The room closes this long after the lights: a lap is never more than a few minutes, plus time to read the results */
const roomLifeMs = (laps: number) => (laps * 4 + 10) * 60_000;

interface Entrant {
  peer: string;
  token: string;
  /** Set by its hello: without one it is connected but not yet in the lobby */
  name?: string;
  code?: string;
  color?: string;
  vehicle?: LobbyPlayer["vehicle"];
  trackId?: string;
  joinedMs: number;
}

interface Meta {
  index: number;
  startsMs: number;
}

function entrantOf(ws: ServerSocket): Entrant | null {
  const a = ws.deserializeAttachment() as Entrant | null;
  return a && typeof a === "object" && typeof a.peer === "string" ? a : null;
}

function send(ws: ServerSocket, text: string): void {
  try {
    ws.send(text);
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

export class RaceServer {
  /** Per socket, in memory: when it was last heard from, and its messages in the current second */
  private heard = new WeakMap<ServerSocket, number>();
  private rates = new WeakMap<ServerSocket, { windowStartMs: number; state: number; control: number }>();
  /** The race once the grid is made (also in storage: every lobby after the start must carry it) */
  private race: RaceStartInfo | null | undefined;
  private meta: Meta | null | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const q = new URL(request.url).searchParams;
    const index = Number(q.get("slot"));
    const slotS = Number(q.get("slotS"));
    if (!Number.isInteger(index) || index < 1 || !Number.isFinite(slotS) || slotS < 10) return new Response("Bad slot", { status: 400 });
    const pair = new workers.WebSocketPair();
    await this.connect(pair[1], q.get("peer") ?? "", q.get("token") ?? "", raceSlot(index, slotS));
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  private async getMeta(slot?: Meta): Promise<Meta | null> {
    if (this.meta === undefined) this.meta = (await this.state.storage.get<Meta>("meta")) ?? null;
    if (!this.meta && slot) {
      this.meta = { index: slot.index, startsMs: slot.startsMs };
      await this.state.storage.put("meta", this.meta);
      // The grid is made a little before the lights
      await this.state.storage.setAlarm(slot.startsMs - RACE_COUNTDOWN_MS);
    }
    return this.meta;
  }

  private async getRace(): Promise<RaceStartInfo | null> {
    if (this.race === undefined) this.race = (await this.state.storage.get<RaceStartInfo>("race")) ?? null;
    return this.race;
  }

  /**
   * The sockets of entrants (not ones being refused), one per car. `gone` is a socket being closed: while its close
   * is handled the runtime still lists it. A car back on a new socket may briefly have its old one listed too: the
   * newest stands for it.
   */
  private sockets(gone?: ServerSocket): ServerSocket[] {
    const byCar = new Map<string, ServerSocket>();
    for (const ws of this.state.getWebSockets("car")) {
      const peer = ws === gone ? undefined : entrantOf(ws)?.peer;
      if (peer !== undefined) byCar.set(peer, ws);
    }
    return [...byCar.values()];
  }

  /** Takes a new socket into the race, or tells it why not (the game closes it then) */
  async connect(ws: ServerSocket, peer: string, token: string, slot: Meta): Promise<void> {
    const refuse = (t: string) => {
      this.state.acceptWebSocket(ws, ["refused"]);
      send(ws, JSON.stringify({ t }));
      close(ws, 4000, t);
    };
    if (!PEER_ID_RE.test(peer) || peer === RACE_SERVER_ID || !TOKEN_RE.test(token)) return refuse("bad");
    const meta = await this.getMeta(slot);
    if (!meta) return refuse("bad");
    const race = await this.getRace();
    const nowMs = this.now();

    const same = this.state.getWebSockets("car").filter((s) => entrantOf(s)?.peer === peer);
    let joinedMs = nowMs;
    if (same.length > 0) {
      // The same car back on a new socket (its network changed): it takes over. Someone else using its id is refused
      if (same.some((s) => entrantOf(s)?.token !== token)) return refuse("taken");
      joinedMs = entrantOf(same[0])?.joinedMs ?? nowMs;
    }
    if (race) {
      // Under way: only a car on the grid gets back in
      const tokens = (await this.state.storage.get<Record<string, string>>("tokens")) ?? {};
      if (!race.grid.includes(peer) || tokens[peer] !== token) return refuse("started");
    } else if (same.length === 0) {
      if (nowMs > meta.startsMs - RACE_JOIN_CUTOFF_MS) return refuse("closed");
      if (this.sockets().length >= MAX_RACERS) return refuse("full");
    }
    const previous = same.length > 0 ? entrantOf(same[0]) : null;
    for (const old of same) close(old, 4001, "replaced");

    this.state.acceptWebSocket(ws, ["car"]);
    ws.serializeAttachment({ ...(previous ?? {}), peer, token, joinedMs } satisfies Entrant);
    this.heard.set(ws, nowMs);
    send(ws, JSON.stringify({ t: "welcome", now: nowMs, startsMs: meta.startsMs, index: meta.index }));
    // The lobby first: it names this server as the host, which the game needs before it trusts the clock pongs
    send(ws, this.lobbyMessage(meta, race));
  }

  private players(gone?: ServerSocket): LobbyPlayer[] {
    return this.sockets(gone)
      .map(entrantOf)
      .filter((e): e is Entrant => e !== null && e.name !== undefined)
      .sort((a, b) => a.joinedMs - b.joinedMs)
      .map((e) => ({
        peerId: e.peer,
        name: e.name ?? "Driver",
        code: e.code ?? "DRV",
        color: e.color ?? "#E10600",
        vehicle: e.vehicle,
        trackId: e.trackId,
        ready: true,
        isHost: false,
      }));
  }

  private lobbyMessage(meta: Meta, race: RaceStartInfo | null, gone?: ServerSocket): string {
    const rules = raceRules(meta);
    const lobby: LobbyState = {
      hostId: RACE_SERVER_ID,
      settings: { trackId: rules.race.trackId, laps: rules.race.laps, collisions: "protected", carClass: "any", vehicle: rules.race.vehicle },
      players: this.players(gone),
      race,
    };
    return JSON.stringify({ ctl: { type: "lobby", lobby }, from: RACE_SERVER_ID });
  }

  private async broadcastLobby(gone?: ServerSocket): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;
    const text = this.lobbyMessage(meta, await this.getRace(), gone);
    for (const ws of this.sockets(gone)) send(ws, text);
  }

  private withinRate(ws: ServerSocket, kind: "state" | "control", nowMs: number): boolean {
    let r = this.rates.get(ws);
    if (!r || nowMs - r.windowStartMs >= 1000) {
      r = { windowStartMs: nowMs, state: 0, control: 0 };
      this.rates.set(ws, r);
    }
    return ++r[kind] <= (kind === "state" ? MAX_STATE_PER_S : MAX_CONTROL_PER_S);
  }

  async webSocketMessage(ws: ServerSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS) return;
    const who = entrantOf(ws);
    if (!who) return;
    const nowMs = this.now();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null) return;

    if (data.ctl !== undefined) {
      // A socket speaks for its own car only
      if (data.from !== who.peer || !this.withinRate(ws, "control", nowMs)) return;
      const msg = sanitizeControl(data.ctl);
      if (!msg) return;
      this.heard.set(ws, nowMs);
      const to = typeof data.to === "string" && PEER_ID_RE.test(data.to) ? data.to : undefined;
      switch (msg.type) {
        case "hello": {
          ws.serializeAttachment({ ...who, name: msg.name, code: msg.code, color: msg.color, vehicle: msg.vehicle, trackId: msg.trackId } satisfies Entrant);
          await this.broadcastLobby();
          break;
        }
        case "ping": {
          // The server's clock is the race's; the other cars answer too, so each knows its delay to each
          if (!to || to === RACE_SERVER_ID) {
            send(ws, JSON.stringify({ ctl: { type: "pong", t0: msg.t0, now: nowMs }, from: RACE_SERVER_ID, to: who.peer }));
          }
          if (to !== RACE_SERVER_ID) this.relay(ws, JSON.stringify(to ? { ctl: msg, from: who.peer, to } : { ctl: msg, from: who.peer }), to);
          break;
        }
        case "pong":
          if (to && to !== RACE_SERVER_ID) this.relay(ws, JSON.stringify({ ctl: msg, from: who.peer, to }), to);
          break;
        default:
          // ready means nothing here, and a lobby, start or abort only ever comes from the server
          break;
      }
      return;
    }

    const pkt = sanitizePacket(data);
    if (!pkt || pkt.peerId !== who.peer || !this.withinRate(ws, "state", nowMs)) return;
    this.heard.set(ws, nowMs);
    // Cars only matter to each other once there is a race
    if (!(await this.getRace())) return;
    this.relay(ws, JSON.stringify(pkt));
  }

  /** Passes a car's message on to the others (only to `to` when it is addressed) */
  private relay(from: ServerSocket, text: string, to?: string): void {
    for (const ws of this.sockets()) {
      if (ws === from) continue;
      if (to !== undefined && entrantOf(ws)?.peer !== to) continue;
      send(ws, text);
    }
  }

  async webSocketClose(ws: ServerSocket, code: number): Promise<void> {
    close(ws, code === 1005 || code === 1006 ? 1000 : code, "closed");
    // Unless this was the old socket of a car that is already back on a new one
    const who = entrantOf(ws);
    if (who && !this.sockets(ws).some((s) => entrantOf(s)?.peer === who.peer)) await this.broadcastLobby(ws);
  }

  async webSocketError(ws: ServerSocket): Promise<void> {
    close(ws, 1011, "error");
  }

  /** Twice in a race's life: shortly before the lights (the grid), and long after them (the room closes) */
  async alarm(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;
    const nowMs = this.now();
    const race = await this.getRace();
    if (!race) {
      if (nowMs < meta.startsMs - RACE_COUNTDOWN_MS - 1000) {
        await this.state.storage.setAlarm(meta.startsMs - RACE_COUNTDOWN_MS);
        return;
      }
      await this.startRace(meta, nowMs);
      return;
    }
    if (nowMs < meta.startsMs + roomLifeMs(race.laps) - 1000) {
      await this.state.storage.setAlarm(meta.startsMs + roomLifeMs(race.laps));
      return;
    }
    await this.shut();
  }

  private async shut(): Promise<void> {
    for (const ws of this.state.getWebSockets()) close(ws, 1000, "race over");
    this.race = null;
    this.meta = null;
    await this.state.storage.deleteAll();
  }

  /** Makes the grid from whoever is here and tells everyone; nobody here: the room just closes */
  private async startRace(meta: Meta, nowMs: number): Promise<void> {
    const present = this.sockets().filter((ws) => {
      const e = entrantOf(ws);
      const last = this.heard.get(ws);
      return e?.name !== undefined && (last === undefined || nowMs - last <= GONE_AFTER_MS);
    });
    const entrants = present.map(entrantOf).filter((e): e is Entrant => e !== null);
    if (entrants.length === 0) return this.shut();

    const rules = raceRules(meta);
    const times = await this.challengeTimes(rules.id, rules.trackId, rules.vehicle, entrants);
    // Fastest of this week's challenge on pole (its laps, also when the race is on another circuit); without a time,
    // behind them in the order they joined
    entrants.sort((a, b) => (times.get(a.peer) ?? Infinity) - (times.get(b.peer) ?? Infinity) || a.joinedMs - b.joinedMs);
    const race: RaceStartInfo = {
      id: `race${meta.index}`,
      lightsStartHostMs: meta.startsMs,
      holdMs: 200 + Math.random() * 2800,
      laps: rules.race.laps,
      collisions: "protected",
      carClass: "any",
      trackId: rules.race.trackId,
      grid: entrants.map((e) => e.peer),
      vehicle: rules.race.vehicle,
    };
    this.race = race;
    await this.state.storage.put("race", race);
    await this.state.storage.put("tokens", Object.fromEntries(entrants.map((e) => [e.peer, e.token])));
    await this.state.storage.setAlarm(meta.startsMs + roomLifeMs(race.laps));
    const start = JSON.stringify({ ctl: { type: "start", start: race }, from: RACE_SERVER_ID });
    for (const ws of this.sockets()) send(ws, start);
    await this.broadcastLobby();
  }

  /** Each entrant's best lap of the week's challenge (by name), for the grid; none when there is no board */
  private async challengeTimes(event: string, trackId: string, vehicle: string, entrants: Entrant[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const db: D1Database | undefined = this.env.BOARD_DB;
    if (!db) return out;
    try {
      const rows = await db
        .prepare("SELECT name_key, MIN(lap_time_ms) AS best FROM laps WHERE track_id = ? AND vehicle = ? AND event = ? GROUP BY name_key")
        .bind(trackId, vehicle, event)
        .all<{ name_key: string; best: number }>();
      const best = new Map(rows.results.map((r) => [r.name_key, r.best]));
      for (const e of entrants) {
        const t = best.get(driverNameKey(e.name ?? ""));
        if (t !== undefined) out.set(e.peer, t);
      }
    } catch {
      // No times: the grid is the order they joined
    }
    return out;
  }
}
