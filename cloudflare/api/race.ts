/**
 * The race server: one Durable Object per scheduled race (src/lib/net/race-schedule.ts). A scheduled race has no
 * host, so this stands in for one: it keeps the lobby, tells everyone the grid shortly before the lights, answers
 * clock pings so every car's lights run on its clock, and passes each car's state on to the others.
 *
 * It speaks the game's own multiplayer messages (src/lib/net/wire.ts), as a room's host does over WebRTC, so the game
 * follows it with the code that follows a host:
 *   client -> server  { ctl: hello | identify | ping | pong | finish, from }   and car state packets
 *   server -> client  { t: "welcome", now, startsMs, index }, then { ctl: lobby | start | pong | result, from: "race_server" },
 *                     the other cars' state packets, and their pings and pongs (each car measures its delay to each other)
 *                     { t: "closed" | "full" | "started" | "taken" | "bad" } when it won't take the socket
 * Only the server ever sends a lobby, a start or a result. A socket speaks for one car: the id it connected with.
 *
 * The official result (src/lib/net/official-result.ts): each car reports its finish once; the server keeps the reports
 * in its storage (it can be evicted mid-race), sends the result as they come in, and makes it final when the whole grid
 * is in or 90 s after the first finish, then stores it on D1 (results.ts). A name counts there only when the car proved
 * it with its driver key (`identify`, kept as its SHA-256 only).
 *
 * Sockets come through the Worker (GET /api/races/next, or /api/races/<n> to get back into a race under way), which
 * works out the slot from its own clock and passes it on in the query; nobody reaches this object directly.
 */
import { RACE_COUNTDOWN_MS, RACE_JOIN_CUTOFF_MS, raceRules, raceSlot } from "../../src/lib/net/race-schedule";
import { addFinish, finishProblem, newResultBook, resultCloseMs, resultDue, resultMessage, type FinishMessage, type ResultBook } from "../../src/lib/net/official-result";
import { PEER_ID_RE, sanitizeControl, sanitizePacket, type LobbyPlayer, type LobbyState, type OfficialResultRow, type RaceStartInfo } from "../../src/lib/net/wire";
import { driverNameKey, sha256Hex } from "./board";
import { storeRaceResult, type RaceEntrant } from "./results";
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
/**
 * A week's races are planned at about ten minutes (weekly-challenge.ts), so a lap under 60 % of that share is not
 * believable (the laps are rounded, hence the half lap)
 */
const minLapS = (laps: number) => (0.6 * 600) / (laps + 0.5);
/** Lights out: five red lights a second apart, then the hold */
const lightsOutMs = (race: RaceStartInfo) => race.lightsStartHostMs + 5 * 1000 + race.holdMs;

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
  /** Its driver key was taken (one try per socket) */
  identified?: boolean;
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
  /** The finish reports (also in storage), and the cars that have sent their state in the race (also in storage) */
  private book: ResultBook | null | undefined;
  private seen: Set<string> | undefined;
  /** Each car's latest race distance (m), to order the cars still out; in memory only (lost: the grid orders them) */
  private dist = new Map<string, number>();

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

  private async getBook(): Promise<ResultBook | null> {
    if (this.book === undefined) this.book = (await this.state.storage.get<ResultBook>("book")) ?? null;
    return this.book;
  }

  private async getSeen(): Promise<Set<string>> {
    this.seen ??= new Set((await this.state.storage.get<string[]>("seen")) ?? []);
    return this.seen;
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
    // Back in a race that has finishers: the result as it stands
    const book = race ? await this.getBook() : null;
    if (book && book.firstFinishMs !== null) send(ws, this.resultText(book));
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
        case "identify":
          await this.identify(ws, who, msg.driverKey);
          break;
        case "finish":
          await this.takeFinish(ws, who.peer, msg, nowMs);
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
    const race = await this.getRace();
    if (!race) return;
    this.relay(ws, JSON.stringify(pkt));
    if (pkt.race?.id === race.id) this.dist.set(who.peer, pkt.race.dist);
    // Only a car that has raced may report a finish
    const seen = await this.getSeen();
    if (!seen.has(who.peer)) {
      seen.add(who.peer);
      await this.state.storage.put("seen", [...seen]);
    }
  }

  /** Keeps the SHA-256 of a car's driver key, never the key: at the end it proves the name the car raced under */
  private async identify(ws: ServerSocket, who: Entrant, driverKey: string): Promise<void> {
    if (who.identified) return;
    ws.serializeAttachment({ ...who, identified: true } satisfies Entrant);
    const keys = (await this.state.storage.get<Record<string, string>>("keys")) ?? {};
    keys[who.peer] = await sha256Hex(driverKey);
    await this.state.storage.put("keys", keys);
  }

  /** A car's finish: into the book unless implausible (the first report stands; a repeat hears the result again) */
  private async takeFinish(ws: ServerSocket, peer: string, msg: FinishMessage, nowMs: number): Promise<void> {
    const race = await this.getRace();
    const book = await this.getBook();
    if (!race || !book) return;
    if (book.reports[peer] || book.final) {
      send(ws, this.resultText(book));
      return;
    }
    const problem = finishProblem(book, peer, msg, {
      minLapS: minLapS(race.laps),
      raceTimeS: (nowMs - lightsOutMs(race)) / 1000,
      sentState: (await this.getSeen()).has(peer),
    });
    if (problem !== null) return;
    addFinish(book, peer, msg, nowMs);
    if (resultDue(book, nowMs)) {
      await this.finalize(book, nowMs);
      return;
    }
    await this.state.storage.put("book", book);
    this.broadcast(this.resultText(book));
    await this.armAlarm(book);
  }

  private resultRows(book: ResultBook): OfficialResultRow[] {
    return resultMessage(book, (peer) => {
      const distM = this.dist.get(peer);
      return distM === undefined ? undefined : { distM };
    }).rows;
  }

  private resultText(book: ResultBook): string {
    return JSON.stringify({ ctl: { type: "result", id: book.id, final: book.final, rows: this.resultRows(book) }, from: RACE_SERVER_ID });
  }

  /** Sends a message of the server's to every car */
  private broadcast(text: string): void {
    for (const ws of this.sockets()) send(ws, text);
  }

  /** The result no longer changes: everyone hears it, and it goes on the results board */
  private async finalize(book: ResultBook, nowMs: number): Promise<void> {
    if (book.final) return;
    book.final = true;
    await this.state.storage.put("book", book);
    const rows = this.resultRows(book);
    this.broadcast(this.resultText(book));
    await this.armAlarm(book);
    const db: D1Database | undefined = this.env.BOARD_DB;
    const meta = await this.getMeta();
    const race = await this.getRace();
    if (!db || !meta || !race) return;
    const names = (await this.state.storage.get<Record<string, { name: string; code: string }>>("names")) ?? {};
    const keys = (await this.state.storage.get<Record<string, string>>("keys")) ?? {};
    const entrants: Record<string, RaceEntrant> = {};
    for (const peer of race.grid) entrants[peer] = { name: names[peer]?.name ?? "Driver", code: names[peer]?.code ?? "DRV", keyHash: keys[peer] };
    const rules = raceRules(meta);
    const stored = { id: `open-${meta.startsMs}-${meta.index}`, week: rules.id, kind: "open" as const, trackId: race.trackId, vehicle: race.vehicle ?? rules.race.vehicle, laps: race.laps, finishedMs: nowMs };
    try {
      await storeRaceResult(db, stored, rows, entrants);
    } catch (err) {
      // No results table yet (the migration not applied), or D1 down: the race still had its result
      console.error("race results", err);
    }
  }

  /** The alarm serves both the result's close and the room's: whichever comes first */
  private async armAlarm(book: ResultBook | null): Promise<void> {
    const meta = await this.getMeta();
    const race = await this.getRace();
    if (!meta || !race) return;
    const roomClose = meta.startsMs + roomLifeMs(race.laps);
    const resultClose = book ? resultCloseMs(book) : null;
    await this.state.storage.setAlarm(resultClose !== null ? Math.min(resultClose, roomClose) : roomClose);
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

  /** Shortly before the lights (the grid), 90 s after the first finish (the result turns final), long after the lights (the room closes) */
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
    const book = await this.getBook();
    // An alarm may come a moment early
    if (book && resultDue(book, nowMs + 1000)) await this.finalize(book, nowMs);
    if (nowMs < meta.startsMs + roomLifeMs(race.laps) - 1000) {
      await this.armAlarm(book);
      return;
    }
    await this.shut();
  }

  private async shut(): Promise<void> {
    for (const ws of this.state.getWebSockets()) close(ws, 1000, "race over");
    this.race = null;
    this.meta = null;
    this.book = null;
    this.seen = undefined;
    this.dist.clear();
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
    // The names the grid races under, for the results (a socket opened again later has no attachment of its own)
    await this.state.storage.put("names", Object.fromEntries(entrants.map((e) => [e.peer, { name: e.name ?? "Driver", code: e.code ?? "DRV" }])));
    this.book = newResultBook(race);
    await this.state.storage.put("book", this.book);
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
