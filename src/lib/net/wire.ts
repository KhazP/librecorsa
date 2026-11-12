/**
 * What multiplayer sends over the wire, and the checks on it: the car state packet, the lobby and the control
 * messages (hello, ready, ping, lobby, start, abort, and finish, result, identify for the official result). Everything from the network goes through a sanitizer here before
 * the game, a room's host or the race server (cloudflare/api/race.ts) uses or passes it on.
 *
 * No three.js and no DOM: the Worker imports this file.
 */
import { isVehicleModelId, type TireCompound, type VehicleModelId } from '../../types/f1';
import { sanitizeWeatherSync, type WeatherSyncState } from '../sim/weather';

// The car state packet travels in binary (state-codec.ts); everything else is JSON
export { decodeState, encodeState, MAX_STATE_BYTES, PROTOCOL_VERSION, stateInfoJson, StateInfoMemory } from './state-codec';

const PEER_COMPOUNDS: readonly TireCompound[] = ['soft', 'medium', 'hard', 'intermediate', 'wet'];
/** Network input is untrusted: only a known model id is kept */
const asPeerVehicle = (v: unknown): VehicleModelId | undefined =>
  isVehicleModelId(v) ? v : undefined;

export interface NetworkVehiclePacket {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  /** Car the sender drives (absent from older clients: rendered as the AMR) */
  vehicle?: VehicleModelId;
  /** Circuit the sender is on (absent from older clients) */
  trackId?: string;
  /** Monotonic timestamp in milliseconds (`performance.now()` / synchronized clock) */
  timestampMs: number;
  /** World position [x, y, z] (m) */
  pos: [number, number, number];
  /** World orientation quaternion [x, y, z, w] */
  quat: [number, number, number, number];
  /** World linear velocity [vx, vy, vz] (m/s) */
  linVel: [number, number, number];
  /** World angular velocity [wx, wy, wz] (rad/s) */
  angVel: [number, number, number];
  /** Front wheel steering angle (rad) */
  steerAngle: number;
  /** 4-wheel angular speeds [FR, FL, RR, RL] (RPM) */
  wheelRPMs: [number, number, number, number];
  /** Throttle pedal (0..1) */
  throttle: number;
  /** Brake pedal (0..1) */
  brake: number;
  /** Track arc-length s (m) */
  trackS: number;
  /** Speed (km/h) */
  speedKmh: number;
  /** Sender's packet counter (loss statistics); absent from older clients */
  seq?: number;
  /** How long after `timestampMs` the packet left (ms): its sender's frame work before the send (absent from older clients) */
  sendDelayMs?: number;
  /** Driver name (absent from older clients) */
  name?: string;
  /** Progress in a multiplayer race */
  race?: PeerRaceProgress;
  /** The sender judges its own car a hazard (slow, wrong way, off the track): the others pass through it */
  hz?: boolean;
}

/**
 * Car state packets per second, sent on a fixed schedule (MultiplayerSyncManager.update). A room's host and the race
 * server relay each car at this rate to every other.
 */
export const STATE_SEND_HZ = 60;
/**
 * A car sending more than this per second is flooding: a room's host and the race server drop the excess. Half as much
 * again as the send rate, as packets bunch up on the way
 */
export const MAX_STATE_PACKETS_PER_S = 90;

/** A racer's progress, sent with every state packet while a multiplayer race runs */
export interface PeerRaceProgress {
  /** Race id the progress belongs to */
  id: string;
  /** Distance covered since the start line (m), laps included */
  dist: number;
  /** Race time (s, from lights out) at the finish; null while still racing */
  fin: number | null;
  /** Laps completed at the finish: fewer than the race's when lapped (absent from older clients) */
  laps?: number;
  /** Fastest lap of the race (ms); null before one */
  best: number | null;
  /** Last completed lap (ms) */
  last?: number | null;
  /** Time penalties served at the flag (s) */
  pen?: number;
  /** Tyre compound: soft / medium / hard / intermediate / wet */
  cmp?: TireCompound;
}

/**
 * 'protected' is an open race's rule: ghosted on the opening lap, and after it a car that is a danger to the others
 * can't touch them (src/lib/sim/contact-guard.ts)
 */
export type CollisionMode = 'on' | 'ghost_lap1' | 'off' | 'protected';
export type CarClassRule = 'any' | 'f1' | 'gt3';

export interface LobbySettings {
  trackId: string;
  laps: number;
  collisions: CollisionMode;
  carClass: CarClassRule;
  /** Everyone drives this car (a scheduled race's); absent: any car the class allows */
  vehicle?: VehicleModelId;
}

export interface LobbyPlayer {
  peerId: string;
  name: string;
  code: string;
  color: string;
  vehicle?: VehicleModelId;
  trackId?: string;
  ready: boolean;
  isHost: boolean;
}

export interface LobbyState {
  hostId: string;
  settings: LobbySettings;
  players: LobbyPlayer[];
  /** The race in progress, if any */
  race: RaceStartInfo | null;
  /** The host's weather and clock (host-authoritative; guests ease theirs to it) */
  weather?: WeatherSyncState;
  /** The host's protocol version (PROTOCOL_VERSION) and physics revision; a guest on another one can't race it */
  proto?: number;
  sim?: number;
}

/** Everything every client needs to run the same start: the lights are timed on the host's clock */
export interface RaceStartInfo {
  id: string;
  /** Host clock (ms) at which the first red light comes on */
  lightsStartHostMs: number;
  /** Hold after the fifth light before lights out (ms) */
  holdMs: number;
  laps: number;
  collisions: CollisionMode;
  carClass: CarClassRule;
  trackId: string;
  /** Peer ids in grid order */
  grid: string[];
  /** Everyone drives this car (a scheduled race's); absent: any car the class allows */
  vehicle?: VehicleModelId;
}

/** One car in the official result (src/lib/net/official-result.ts) */
export interface OfficialResultRow {
  peer: string;
  position: number;
  /** Race time at the flag with the penalties added (s); null when not (yet) finished */
  timeS: number | null;
  penaltyS: number;
  laps: number;
  bestLapMs: number | null;
  dnf: boolean;
  /** Place on the grid at the start (1 = pole) */
  grid: number;
}

export type ControlMessage =
  /** `proto`, `sim`: the sender's protocol version and physics revision (absent from older clients) */
  | { type: 'hello'; name: string; code: string; color: string; vehicle?: VehicleModelId; trackId?: string; proto?: number; sim?: number }
  /** A room's host to a guest on another version of the game: not let in */
  | { type: 'refuse'; reason: 'version' }
  | { type: 'ping'; t0: number }
  | { type: 'pong'; t0: number; now: number }
  | { type: 'lobby'; lobby: LobbyState }
  | { type: 'ready'; ready: boolean }
  | { type: 'start'; start: RaceStartInfo }
  | { type: 'abort'; id: string }
  /** A car took the flag: once, to the race server or the room's host. timeS is race time at the flag, penalties not added */
  | { type: 'finish'; id: string; timeS: number; penaltyS: number; laps: number; bestLapMs: number | null }
  /** The official result, only ever from the race server or the room's host; final once it no longer changes */
  | { type: 'result'; id: string; final: boolean; rows: OfficialResultRow[] }
  /** The driver key, once after hello on a race server's socket (never in a URL): proves the name for the results */
  | { type: 'identify'; driverKey: string };

export interface ControlEnvelope {
  ctl: ControlMessage;
  from: string;
  /** Recipient peer id; absent = everyone */
  to?: string;
}

/** The default circuit (DEFAULT_TRACK_ID in track-data.ts, which loads three.js and so can't be imported here) */
export const FALLBACK_TRACK_ID = 'rwanda_official_short';

const clampStr = (v: unknown, max: number, fallback: string) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, max) : fallback;
const asCode = (v: unknown) => {
  const s = typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) : '';
  return s.length === 3 ? s : 'DRV';
};
const asColor = (v: unknown) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#E10600');
const finite = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const COLLISION_MODES: readonly CollisionMode[] = ['on', 'ghost_lap1', 'off', 'protected'];
const version = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : undefined);
const CAR_CLASSES: readonly CarClassRule[] = ['any', 'f1', 'gt3'];

function sanitizeRace(v: unknown): PeerRaceProgress | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const dist = finite(r.dist, -10_000, 10_000_000);
  if (typeof r.id !== 'string' || dist === null) return undefined;
  return {
    id: r.id.slice(0, 32),
    dist,
    fin: finite(r.fin, 0, 1e6),
    laps: typeof r.laps === 'number' && Number.isInteger(r.laps) && r.laps >= 0 && r.laps <= 99 ? r.laps : undefined,
    best: finite(r.best, 0, 1e7),
    last: finite(r.last, 0, 1e7),
    pen: finite(r.pen, 0, 600) ?? undefined,
    cmp: PEER_COMPOUNDS.includes(r.cmp as TireCompound) ? (r.cmp as TireCompound) : undefined,
  };
}

export function sanitizeStart(v: unknown): RaceStartInfo | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  const lightsStartHostMs = finite(s.lightsStartHostMs, -1e15, 1e15);
  const holdMs = finite(s.holdMs, 0, 5000);
  const laps = finite(s.laps, 1, 99);
  if (typeof s.id !== 'string' || lightsStartHostMs === null || holdMs === null || laps === null) return null;
  if (!Array.isArray(s.grid)) return null;
  return {
    id: s.id.slice(0, 32),
    lightsStartHostMs,
    holdMs,
    laps: Math.round(laps),
    collisions: COLLISION_MODES.includes(s.collisions as CollisionMode) ? (s.collisions as CollisionMode) : 'on',
    carClass: CAR_CLASSES.includes(s.carClass as CarClassRule) ? (s.carClass as CarClassRule) : 'any',
    trackId: clampStr(s.trackId, 64, FALLBACK_TRACK_ID),
    grid: s.grid.filter((g): g is string => typeof g === 'string').slice(0, 32).map((g) => g.slice(0, 64)),
    vehicle: asPeerVehicle(s.vehicle),
  };
}

export function sanitizeLobby(v: unknown): LobbyState | null {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  const st = (l.settings ?? {}) as Record<string, unknown>;
  if (typeof l.hostId !== 'string' || !Array.isArray(l.players)) return null;
  return {
    hostId: l.hostId.slice(0, 64),
    weather: sanitizeWeatherSync(l.weather) ?? undefined,
    proto: version(l.proto),
    sim: version(l.sim),
    settings: {
      trackId: clampStr(st.trackId, 64, FALLBACK_TRACK_ID),
      laps: Math.round(finite(st.laps, 1, 99) ?? 5),
      collisions: COLLISION_MODES.includes(st.collisions as CollisionMode) ? (st.collisions as CollisionMode) : 'on',
      carClass: CAR_CLASSES.includes(st.carClass as CarClassRule) ? (st.carClass as CarClassRule) : 'any',
      vehicle: asPeerVehicle(st.vehicle),
    },
    players: l.players.slice(0, 32).flatMap((p): LobbyPlayer[] => {
      if (!p || typeof p !== 'object') return [];
      const q = p as Record<string, unknown>;
      if (typeof q.peerId !== 'string') return [];
      return [
        {
          peerId: q.peerId.slice(0, 64),
          name: clampStr(q.name, 16, 'Driver'),
          code: asCode(q.code),
          color: asColor(q.color),
          vehicle: asPeerVehicle(q.vehicle),
          trackId: typeof q.trackId === 'string' ? q.trackId.slice(0, 64) : undefined,
          ready: q.ready === true,
          isHost: q.isHost === true,
        },
      ];
    }),
    race: l.race ? sanitizeStart(l.race) : null,
  };
}

/** Peer ids are generated as `peer_xxxxxxx`; anything else from the network is refused */
export const PEER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `n` finite numbers, each clamped to ±`lim`; null when the shape or a value is wrong */
function finiteVec(v: unknown, n: number, lim: number): number[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    out[i] = Math.max(-lim, Math.min(lim, x));
  }
  return out;
}

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/** World coordinates beyond this (m) are not on any circuit */
const MAX_WORLD_COORD_M = 100_000;

/**
 * Validates a vehicle state packet from the network: every number finite and in range, arrays the right length, the
 * quaternion normalised, strings cleaned. Null when the packet is unusable. A bad value would otherwise reach the
 * prediction, contact and rendering of every client (the host relays what it accepts).
 */
export function sanitizePacket(v: unknown): NetworkVehiclePacket | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (typeof p.peerId !== 'string' || !PEER_ID_RE.test(p.peerId)) return null;
  const timestampMs = finite(p.timestampMs, -1e15, 1e15);
  const pos = finiteVec(p.pos, 3, Infinity);
  const quat = finiteVec(p.quat, 4, 2);
  const linVel = finiteVec(p.linVel, 3, 150);
  const angVel = finiteVec(p.angVel, 3, 30);
  const wheelRPMs = finiteVec(p.wheelRPMs, 4, 10_000);
  if (timestampMs === null || !pos || !quat || !linVel || !angVel || !wheelRPMs) return null;
  if (pos.some((c) => Math.abs(c) > MAX_WORLD_COORD_M)) return null;
  const qLen = Math.hypot(quat[0], quat[1], quat[2], quat[3]);
  if (qLen < 1e-6) return null;
  const seq = typeof p.seq === 'number' && Number.isInteger(p.seq) && p.seq >= 0 ? p.seq : undefined;
  return {
    peerId: p.peerId,
    driverCode: asCode(p.driverCode),
    teamColorHex: asColor(p.teamColorHex),
    vehicle: asPeerVehicle(p.vehicle),
    trackId: typeof p.trackId === 'string' ? p.trackId.slice(0, 64) : undefined,
    timestampMs,
    pos: pos as [number, number, number],
    quat: quat.map((c) => c / qLen) as [number, number, number, number],
    linVel: linVel as [number, number, number],
    angVel: angVel as [number, number, number],
    steerAngle: clampNum(p.steerAngle, -1, 1, 0),
    wheelRPMs: wheelRPMs as [number, number, number, number],
    throttle: clampNum(p.throttle, 0, 1, 0),
    brake: clampNum(p.brake, 0, 1, 0),
    trackS: clampNum(p.trackS, -10_000, 10_000_000, 0),
    speedKmh: clampNum(p.speedKmh, 0, 600, 0),
    seq,
    sendDelayMs: finite(p.sendDelayMs, 0, 1000) ?? undefined,
    name: typeof p.name === 'string' ? clampStr(p.name, 16, 'Driver') : undefined,
    race: sanitizeRace(p.race),
    hz: p.hz === true ? true : undefined,
  };
}

/** A driver key as the game makes them (src/lib/net/driver-key.ts) */
const DRIVER_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const lapCount = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 99 ? v : null);
const place = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 64 ? v : null);

function sanitizeResultRow(v: unknown): OfficialResultRow | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const position = place(r.position);
  const grid = place(r.grid);
  const laps = lapCount(r.laps);
  if (typeof r.peer !== 'string' || !PEER_ID_RE.test(r.peer) || position === null || grid === null || laps === null) return null;
  return {
    peer: r.peer,
    position,
    timeS: finite(r.timeS, 0.001, 1e6),
    penaltyS: finite(r.penaltyS, 0, 600) ?? 0,
    laps,
    bestLapMs: finite(r.bestLapMs, 1, 1e7),
    dnf: r.dnf === true,
    grid,
  };
}

/** Validates a control message from the network; null when it is not one */
export function sanitizeControl(v: unknown): ControlMessage | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      return {
        type: 'hello',
        name: clampStr(m.name, 16, 'Driver'),
        code: asCode(m.code),
        color: asColor(m.color),
        vehicle: asPeerVehicle(m.vehicle),
        trackId: typeof m.trackId === 'string' ? m.trackId.slice(0, 64) : undefined,
        proto: version(m.proto),
        sim: version(m.sim),
      };
    case 'refuse':
      return m.reason === 'version' ? { type: 'refuse', reason: 'version' } : null;
    case 'ping': {
      const t0 = finite(m.t0, -1e15, 1e15);
      return t0 === null ? null : { type: 'ping', t0 };
    }
    case 'pong': {
      const t0 = finite(m.t0, -1e15, 1e15);
      const now = finite(m.now, -1e15, 1e15);
      return t0 === null || now === null ? null : { type: 'pong', t0, now };
    }
    case 'lobby': {
      const lobby = sanitizeLobby(m.lobby);
      return lobby ? { type: 'lobby', lobby } : null;
    }
    case 'ready':
      return { type: 'ready', ready: m.ready === true };
    case 'start': {
      const start = sanitizeStart(m.start);
      return start ? { type: 'start', start } : null;
    }
    case 'abort':
      return typeof m.id === 'string' ? { type: 'abort', id: m.id.slice(0, 32) } : null;
    case 'finish': {
      const timeS = finite(m.timeS, 0.001, 1e6);
      const penaltyS = finite(m.penaltyS, 0, 600);
      const laps = lapCount(m.laps);
      if (typeof m.id !== 'string' || timeS === null || penaltyS === null || laps === null) return null;
      return { type: 'finish', id: m.id.slice(0, 32), timeS, penaltyS, laps, bestLapMs: finite(m.bestLapMs, 1, 1e7) };
    }
    case 'result': {
      if (typeof m.id !== 'string' || !Array.isArray(m.rows)) return null;
      const rows = m.rows.slice(0, 32).map(sanitizeResultRow);
      if (rows.some((r) => r === null)) return null;
      return { type: 'result', id: m.id.slice(0, 32), final: m.final === true, rows: rows as OfficialResultRow[] };
    }
    case 'identify':
      return typeof m.driverKey === 'string' && DRIVER_KEY_RE.test(m.driverKey) ? { type: 'identify', driverKey: m.driverKey } : null;
    default:
      return null;
  }
}

