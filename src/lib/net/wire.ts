/**
 * What multiplayer sends over the wire, and the checks on it: the car state packet, the lobby and the control
 * messages (hello, ready, ping, lobby, start, abort, and finish, result, identify for the official result). Everything from the network goes through a sanitizer here before
 * the game, a room's host or the race server (cloudflare/api/race.ts) uses or passes it on.
 *
 * No three.js and no DOM: the Worker imports this file.
 */
import { foldVehicleModelId, isVehicleModelId, TIRE_COMPOUNDS, type CustomLiveryColors, type TireCompound, type VehicleModelId } from '../../types/f1';
import {
  sanitizeWeatherSync,
  TIME_OF_DAY_PRESETS,
  TIME_SCALES,
  WEATHER_PRESETS,
  type TimeOfDayId,
  type WeatherPresetId,
  type WeatherSyncState,
} from '../sim/weather';
import type { RulePresetId, TrackLimitsChoice } from '../sim/race-rules';
import type { DamageLevel } from '../sim/car-damage';
import type { CarClassId } from '../cars/car-registry';

// The car state packet travels in binary (state-codec.ts); everything else is JSON
export { decodeState, encodeState, MAX_STATE_BYTES, PROTOCOL_VERSION, stateInfoJson, StateInfoMemory } from './state-codec';

/** Minimum plausible qualifying lap time (ms): shared by RoomServer, wire sanitizers, host and client */
export const MIN_QUALIFYING_LAP_MS = 10_000;

/**
 * The compounds a peer's report may name. A client from before the super soft reads one as no compound (its `cmp`
 * check), and keeps the rest of the report
 */
const PEER_COMPOUNDS: readonly TireCompound[] = TIRE_COMPOUNDS;
/** Network input is untrusted: only a known model id is kept */
const asPeerVehicle = (raw: unknown): VehicleModelId | undefined => {
  const v = foldVehicleModelId(raw);
  return isVehicleModelId(v) ? v : undefined;
};

export interface NetworkVehiclePacket {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  /** Selected livery id (absent from older clients: falls back to driverCode) */
  liveryId?: string | null;
  /** Custom livery colours when liveryId === "custom" */
  customLivery?: CustomLiveryColors;
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
  /** The sender is flashing its headlights (absent from older clients) */
  fl?: boolean;
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
  /** Tyre compound: super soft (on a car that has one) / soft / medium / hard / intermediate / wet */
  cmp?: TireCompound;
}

/**
 * 'protected' is an open race's rule: ghosted on the opening lap, and after it a car that is a danger to the others
 * can't touch them (src/lib/sim/contact-guard.ts)
 */
export type CollisionMode = 'on' | 'ghost_lap1' | 'off' | 'protected';
/** Which cars a room lets in: any car, or one class of the registry's (car-registry.ts `CAR_CLASSES`) */
export type CarClassRule = 'any' | CarClassId;

/** How the cars leave the grid: from a standstill behind the lights, or queued at formation speed */
export type MpStartType = 'standing' | 'rolling';
/**
 * How the grid lines up: by qualifying (the quickest clean lap on pole; without a session, the order players joined,
 * host on pole), reversed (the same order back to front: the quickest last, cars without a lap still at the back), or
 * drawn at random
 */
export type MpGridOrder = 'random' | 'reverse' | 'qualifying';
/** Qualifying session lengths a private room offers (min); 0 = none. Public rooms never qualify */
export const MP_QUALIFYING_MINUTES = [0, 3, 5, 10] as const;
export type MpQualifyingMinutes = (typeof MP_QUALIFYING_MINUTES)[number];
/** The sporting rules (race-rules.ts) as a room picks them; `classic` is the strike ladder every older build judges by */
export interface MpRaceRules {
  preset: RulePresetId | 'classic';
  trackLimits: TrackLimitsChoice;
  /** Time penalties (track limits & jump starts); default true */
  penalties?: boolean;
  /** Mechanical & aero damage level; default 'off' */
  damage?: DamageLevel;
}
/** A private room (a code friends share) or a public one (a scheduled or quick race anyone may enter) */
export type RoomKind = 'private' | 'public';

export const MP_START_TYPES: readonly MpStartType[] = ['standing', 'rolling'];
export const MP_GRID_ORDERS: readonly MpGridOrder[] = ['qualifying', 'reverse', 'random'];
export const MP_RULE_PRESETS: readonly MpRaceRules['preset'][] = ['classic', 'auto', 'open_wheel', 'endurance_sprint'];
export const MP_DAMAGE_LEVELS: readonly DamageLevel[] = ['off', 'reduced', 'full'];
const MP_TRACK_LIMITS: readonly TrackLimitsChoice[] = ['auto', 'off'];
const ROOM_PHASES: readonly RoomPhase[] = ['lobby', 'qualifying', 'racing'];

export interface LobbySettings {
  trackId: string;
  laps: number;
  collisions: CollisionMode;
  carClass: CarClassRule;
  /** Everyone drives this car (a scheduled race's); absent: any car the class allows */
  vehicle?: VehicleModelId;
  // Everything below is absent from older hosts: `withLobbyDefaults` fills it in as those races always ran
  /** The session's weather, time of day and clock speed (weather.ts presets); absent: whatever the host drives in */
  weather?: WeatherPresetId;
  timeOfDay?: TimeOfDayId;
  timeScale?: number;
  startType?: MpStartType;
  /** A standing start's launch is the driver's: clutch and revs held through the lights. Absent: each player's own setting */
  manualStart?: boolean;
  gridOrder?: MpGridOrder;
  rules?: MpRaceRules;
  /** Qualifying before the race (min): private rooms only, always 0 in a public one */
  qualifyingMinutes?: MpQualifyingMinutes;
  /** The mod package the circuit comes from (src/lib/mods), so a guest can tell whether theirs is the same */
  trackMod?: RoomModRef;
}

/** A mod package as a room names it: enough to tell a guest what to install, and whether theirs is the same */
export interface RoomModRef {
  packageId: string;
  name: string;
  version: string;
  /** Its content hash (mod-manifest.ts `packageHash`) */
  hash: string;
}

const MOD_PACKAGE_ID = /^[a-z0-9][a-z0-9_-]{0,15}\.[a-z0-9][a-z0-9_-]{0,23}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function asModRef(v: unknown): RoomModRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.packageId !== 'string' || !MOD_PACKAGE_ID.test(m.packageId)) return undefined;
  if (typeof m.hash !== 'string' || !SHA256.test(m.hash)) return undefined;
  return { packageId: m.packageId, name: clampStr(m.name, 80, m.packageId), version: clampStr(m.version, 32, ''), hash: m.hash };
}

/** The settings an older host's lobby (or race) leaves out, as those races always ran */
export const LOBBY_DEFAULTS = {
  startType: 'standing',
  manualStart: false,
  gridOrder: 'qualifying',
  rules: { preset: 'classic', trackLimits: 'auto', penalties: true, damage: 'off' },
  qualifyingMinutes: 0,
} as const satisfies Partial<LobbySettings>;

/** The settings with every optional rule in place (weather, time and launch stay as given: absent is meaningful) */
export function withLobbyDefaults<T extends Partial<LobbySettings>>(
  s: T,
): T & Required<Pick<LobbySettings, 'startType' | 'manualStart' | 'gridOrder' | 'rules' | 'qualifyingMinutes'>> {
  return {
    ...s,
    startType: s.startType ?? LOBBY_DEFAULTS.startType,
    manualStart: s.manualStart ?? LOBBY_DEFAULTS.manualStart,
    gridOrder: s.gridOrder ?? LOBBY_DEFAULTS.gridOrder,
    rules: {
      preset: s.rules?.preset ?? LOBBY_DEFAULTS.rules.preset,
      trackLimits: s.rules?.trackLimits ?? LOBBY_DEFAULTS.rules.trackLimits,
      penalties: s.rules?.penalties ?? LOBBY_DEFAULTS.rules.penalties,
      damage: s.rules?.damage ?? LOBBY_DEFAULTS.rules.damage,
    },
    qualifyingMinutes: s.qualifyingMinutes ?? LOBBY_DEFAULTS.qualifyingMinutes,
  };
}

/** One driver's qualifying: best clean lap (ms), null without one */
export interface QualifyingTime {
  peer: string;
  ms: number | null;
}

/** Where a room is between races: open, qualifying (until `endsAtHostMs` on the host's clock), or racing */
export type RoomPhase = 'lobby' | 'qualifying' | 'racing';

export interface RoomSessionInfo {
  phase: RoomPhase;
  /** The qualifying session's id: laps count for it while each car's progress carries this id */
  id: string;
  minutes?: number;
  /** Host clock (ms) at which qualifying ends */
  endsAtHostMs?: number;
  /** The classification so far, quickest first */
  times?: QualifyingTime[];
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
  /** Whether this is a private room or a public/scheduled one (absent from older hosts) */
  roomKind?: RoomKind;
  /** Qualifying, while a private room runs it (absent from older hosts: the room is open or racing) */
  session?: RoomSessionInfo;
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
  // Absent from older hosts: a standing start, the classic rules, each player's own launch
  weather?: WeatherPresetId;
  timeOfDay?: TimeOfDayId;
  timeScale?: number;
  startType?: MpStartType;
  manualStart?: boolean;
  gridOrder?: MpGridOrder;
  rules?: MpRaceRules;
  /** The qualifying classification the grid was drawn from, quickest first */
  qualifying?: QualifyingTime[];
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
  /** A room's host to a guest on another version of the game, or in a disallowed car class */
  | { type: 'refuse'; reason: 'version' }
  | { type: 'refuse'; reason: 'car_class'; carClass?: CarClassRule; vehicle?: VehicleModelId }
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
  | { type: 'identify'; driverKey: string }
  /** A driver's valid best lap during a private room's qualifying session (sent to host) */
  | { type: 'quali_lap'; id: string; bestLapMs: number };

export interface ControlEnvelope {
  ctl: ControlMessage;
  from: string;
  /** Recipient peer id; absent = everyone */
  to?: string;
}

/** The default circuit (DEFAULT_TRACK_ID in track-data.ts, which loads three.js and so can't be imported here) */
export const FALLBACK_TRACK_ID = 'rwanda_official_short';

// Cut by code point, not UTF-16 unit, so a name never ends in half an emoji (a lone surrogate draws as a broken glyph)
const clampStr = (v: unknown, max: number, fallback: string) =>
  typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f<>]/g, '')).slice(0, max).join('') : fallback;
const stripDiacritics = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const peerChars = (peerId: unknown): string =>
  typeof peerId === 'string' ? stripDiacritics(peerId).replace(/^PEER[_-]?/, '').replace(/[^A-Z0-9]/g, '') : '';

/**
 * Normalizes a 3-character uppercase driver code (`[A-Z0-9]{3}` with at least one letter) so online lobbies and timing
 * boards never show blank codes. Preserves valid 3-char codes (including deduplicated codes with digits like `DR2`),
 * folds diacritics (`Éric` -> `ERI`), and derives from `fallbackName` / `peerId` / `DRV` when blank or incomplete.
 */
export function normalizeDriverCode(rawCode: unknown, fallbackName?: unknown, peerId?: unknown): string {
  const rawAlnum = typeof rawCode === 'string' ? stripDiacritics(rawCode).replace(/[^A-Z0-9]/g, '') : '';
  if (rawAlnum.length >= 2 && /[A-Z]/.test(rawAlnum.slice(0, 3))) return rawAlnum.slice(0, 3);

  const nameWords =
    typeof fallbackName === 'string'
      ? stripDiacritics(fallbackName)
          .split(/[^A-Z0-9]+/)
          .filter((w) => /[A-Z]/.test(w))
      : [];
  const nameLetters = nameWords.join('').replace(/[^A-Z]/g, '');
  const nameAlnum = nameWords.join('');

  if (rawAlnum.length > 0 && /[A-Z]/.test(rawAlnum)) {
    if (nameLetters.length >= 3 && nameLetters.startsWith(rawAlnum)) return nameLetters.slice(0, 3);
    if (nameAlnum.length >= 3 && nameAlnum.startsWith(rawAlnum)) return nameAlnum.slice(0, 3);
    const pad = (nameAlnum.slice(rawAlnum.length) + peerChars(peerId) + 'DRV').slice(0, 3 - rawAlnum.length);
    return (rawAlnum + pad).slice(0, 3);
  }

  if (nameWords.length >= 2) {
    const lastLetters = nameWords[nameWords.length - 1].replace(/[^A-Z]/g, '');
    if (lastLetters.length >= 3) return lastLetters.slice(0, 3);
  }
  if (nameLetters.length >= 3) return nameLetters.slice(0, 3);
  if (nameAlnum.length >= 3 && /[A-Z]/.test(nameAlnum.slice(0, 3))) return nameAlnum.slice(0, 3);
  if (nameAlnum.length > 0 && /[A-Z]/.test(nameAlnum)) {
    return (nameAlnum + peerChars(peerId) + 'DRV').slice(0, 3);
  }

  const p = peerChars(peerId);
  if (p.length >= 3 && /[A-Z]/.test(p.slice(0, 3))) return p.slice(0, 3);
  return 'DRV';
}

const CODE_SUFFIX_CHARS = '23456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Assigns every entry a unique, non-blank 3-character uppercase driver code in deterministic array order.
 * The first entry keeps its normalized code; colliding entries try alternate letters from their name before
 * falling back to numbered/suffixed variants (`XX2`, `XX3`, ..., `X10`).
 */
export function dedupeDriverCodes<T extends { id: string; code?: unknown; name?: unknown }>(
  entries: readonly T[],
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const e of entries) {
    if (out.has(e.id)) continue;
    const base = normalizeDriverCode(e.code, e.name, e.id);
    if (!used.has(base)) {
      used.add(base);
      out.set(e.id, base);
      continue;
    }
    let chosen: string | null = null;
    if (typeof e.name === 'string') {
      const words = stripDiacritics(e.name)
        .split(/[^A-Z0-9]+/)
        .filter((w) => /[A-Z]/.test(w));
      const candidates: string[] = [];
      if (words.length >= 2) {
        const first = words[0].replace(/[^A-Z]/g, '');
        const last = words[words.length - 1].replace(/[^A-Z]/g, '');
        if (first.length >= 3) candidates.push(first.slice(0, 3));
        if (first.length >= 1 && last.length >= 2) candidates.push((first[0] + last.slice(0, 2)).slice(0, 3));
        if (first.length >= 2 && last.length >= 1) candidates.push((first.slice(0, 2) + last[0]).slice(0, 3));
      }
      const joined = words.join('').replace(/[^A-Z0-9]/g, '');
      for (let i = 3; i < joined.length; i++) candidates.push(base.slice(0, 2) + joined[i]);
      for (const c of candidates) {
        if (c.length === 3 && /[A-Z]/.test(c) && !used.has(c)) {
          chosen = c;
          break;
        }
      }
    }
    if (!chosen) {
      const p2 = base.slice(0, 2);
      for (let i = 0; i < CODE_SUFFIX_CHARS.length; i++) {
        const c = p2 + CODE_SUFFIX_CHARS[i];
        if (!used.has(c)) {
          chosen = c;
          break;
        }
      }
    }
    if (!chosen) {
      const p1 = /[A-Z]/.test(base[0]) ? base[0] : 'D';
      for (let n = 10; n <= 99; n++) {
        const c = `${p1}${n}`;
        if (!used.has(c)) {
          chosen = c;
          break;
        }
      }
    }
    const finalCode = chosen ?? base;
    used.add(finalCode);
    out.set(e.id, finalCode);
  }
  return out;
}

const asCode = (v: unknown, name?: unknown, peerId?: unknown) => normalizeDriverCode(v, name, peerId);
const asColor = (v: unknown) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#E10600');
const finite = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const COLLISION_MODES: readonly CollisionMode[] = ['on', 'ghost_lap1', 'off', 'protected'];
const version = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : undefined);
// Every class id, kept by the compiler: a class added to the registry fails here until it is listed (no value import:
// the Worker loads this file without the car registry)
const CAR_CLASS_RULE_IDS: Record<CarClassRule, true> = { any: true, f1: true, gt3: true, proto: true, classic: true, road: true };
const CAR_CLASSES = Object.keys(CAR_CLASS_RULE_IDS) as readonly CarClassRule[];

/**
 * Vehicle model -> car class, kept by the compiler (every `VehicleModelId` must be listed here; mirrors
 * `VEHICLE_MODELS[id].classId` without importing three.js so the Cloudflare Worker can enforce class locks).
 */
export const VEHICLE_CLASS_BY_MODEL: Readonly<Record<VehicleModelId, CarClassId>> = {
  lc26: 'f1',
  lc25: 'f1',
  'f12026-car': 'f1',
  'amg-gt3': 'gt3',
  liana: 'road',
  'mtr-496r': 'proto',
  'lc-lmdh': 'proto',
  'nissan-r33-jgtc': 'classic',
  'nissan-r32-jtcc': 'classic',
  'bmw-m1-procar': 'classic',
  'vw-scirocco-gtx': 'road',
  'chaparral-2d': 'classic',
  'chaparral-2d-67': 'classic',
  'porsche-934-rsr': 'classic',
  'f1-2007': 'f1',
};

/** The car class a vehicle model belongs to */
export function vehicleClassOf(vehicle: VehicleModelId): CarClassId {
  return VEHICLE_CLASS_BY_MODEL[vehicle];
}

/** A room or race's car restriction: either a single spec vehicle, a car class, or unrestricted (`any`) */
export interface VehicleRule {
  carClass: CarClassRule;
  vehicle?: VehicleModelId;
}

/** True when the lobby/race restricts which car or class players may drive */
export function isVehicleRestricted(rule: VehicleRule | null | undefined): boolean {
  return Boolean(rule && (rule.vehicle !== undefined || rule.carClass !== 'any'));
}

/**
 * True when `vehicle` is permitted under `rule`.
 * - If `rule.vehicle` is set (spec/one-make lobby such as an open `lc-lmdh` race), only that exact vehicle is allowed.
 * - Else if `rule.carClass !== 'any'`, only vehicles belonging to that class are allowed.
 * - When `rule` is unrestricted (`carClass === 'any'` and no `vehicle`), every vehicle is allowed.
 * - `allowUnspecified`: when true, an omitted `vehicle` (undefined) is treated as allowed (for legacy callers/tests).
 */
export function isVehicleAllowed(
  vehicle: VehicleModelId | undefined,
  rule: VehicleRule | null | undefined,
  options?: { allowUnspecified?: boolean },
): boolean {
  if (!rule || !isVehicleRestricted(rule)) return true;
  if (vehicle === undefined) return options?.allowUnspecified === true;
  if (rule.vehicle !== undefined) return vehicle === rule.vehicle;
  return VEHICLE_CLASS_BY_MODEL[vehicle] === rule.carClass;
}

export function sanitizeRace(v: unknown): PeerRaceProgress | undefined {
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

const asWeather = (v: unknown): WeatherPresetId | undefined =>
  WEATHER_PRESETS.includes(v as WeatherPresetId) ? (v as WeatherPresetId) : undefined;
const asTimeOfDay = (v: unknown): TimeOfDayId | undefined =>
  TIME_OF_DAY_PRESETS.includes(v as TimeOfDayId) ? (v as TimeOfDayId) : undefined;
const asTimeScale = (v: unknown): number | undefined => {
  const n = finite(v, 0, 120);
  if (n === null) return undefined;
  return TIME_SCALES.includes(n) ? n : Math.round(n);
};
const asStartType = (v: unknown): MpStartType | undefined =>
  MP_START_TYPES.includes(v as MpStartType) ? (v as MpStartType) : undefined;
const asGridOrder = (v: unknown): MpGridOrder | undefined =>
  MP_GRID_ORDERS.includes(v as MpGridOrder) ? (v as MpGridOrder) : undefined;
const asQualifyingMinutes = (v: unknown): MpQualifyingMinutes | undefined =>
  typeof v === 'number' && (MP_QUALIFYING_MINUTES as readonly number[]).includes(v) ? (v as MpQualifyingMinutes) : undefined;
const asRoomKind = (v: unknown): RoomKind | undefined => (v === 'private' || v === 'public' ? v : undefined);

export function sanitizeRaceRules(v: unknown): MpRaceRules | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const preset = MP_RULE_PRESETS.includes(r.preset as MpRaceRules['preset']) ? (r.preset as MpRaceRules['preset']) : 'classic';
  const trackLimits = MP_TRACK_LIMITS.includes(r.trackLimits as TrackLimitsChoice) ? (r.trackLimits as TrackLimitsChoice) : 'auto';
  const penalties = typeof r.penalties === 'boolean' ? r.penalties : true;
  const damage = MP_DAMAGE_LEVELS.includes(r.damage as DamageLevel) ? (r.damage as DamageLevel) : 'off';
  return { preset, trackLimits, penalties, damage };
}

/** Validates lobby settings from the network or client; public rooms always force `qualifyingMinutes = 0` */
export function sanitizeLobbySettings(v: unknown, roomKind?: RoomKind): LobbySettings {
  const st = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const weather = asWeather(st.weather);
  const timeOfDay = asTimeOfDay(st.timeOfDay);
  const timeScale = asTimeScale(st.timeScale);
  const startType = asStartType(st.startType);
  const manualStart = typeof st.manualStart === 'boolean' ? st.manualStart : undefined;
  const gridOrder = asGridOrder(st.gridOrder);
  const rules = sanitizeRaceRules(st.rules);
  const rawQuali = asQualifyingMinutes(st.qualifyingMinutes);
  const qualifyingMinutes: MpQualifyingMinutes | undefined = roomKind === 'public' ? 0 : rawQuali;
  const out: LobbySettings = {
    trackId: clampStr(st.trackId, 64, FALLBACK_TRACK_ID),
    laps: Math.round(finite(st.laps, 1, 99) ?? 5),
    collisions: COLLISION_MODES.includes(st.collisions as CollisionMode) ? (st.collisions as CollisionMode) : 'on',
    carClass: CAR_CLASSES.includes(st.carClass as CarClassRule) ? (st.carClass as CarClassRule) : 'any',
    vehicle: asPeerVehicle(st.vehicle),
  };
  if (weather !== undefined) out.weather = weather;
  if (timeOfDay !== undefined) out.timeOfDay = timeOfDay;
  if (timeScale !== undefined) out.timeScale = timeScale;
  if (startType !== undefined) out.startType = startType;
  if (manualStart !== undefined) out.manualStart = manualStart;
  if (gridOrder !== undefined) out.gridOrder = gridOrder;
  if (rules !== undefined) out.rules = rules;
  if (qualifyingMinutes !== undefined) out.qualifyingMinutes = qualifyingMinutes;
  // Only the package the circuit comes from: a reference left from the room's last mod circuit (settings are merged
  // over the old ones) or one naming another package says nothing about this circuit
  const trackMod = asModRef(st.trackMod);
  if (trackMod && out.trackId.startsWith(`mod:${trackMod.packageId}/`)) out.trackMod = trackMod;
  return out;
}

function sanitizeQualifyingTimes(v: unknown): QualifyingTime[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: QualifyingTime[] = [];
  for (const item of v.slice(0, 32)) {
    if (!item || typeof item !== 'object') continue;
    const q = item as Record<string, unknown>;
    if (typeof q.peer !== 'string' || !q.peer) continue;
    out.push({ peer: q.peer.slice(0, 64), ms: finite(q.ms, MIN_QUALIFYING_LAP_MS, 1e7) });
  }
  return out;
}

function sanitizeRoomSession(v: unknown): RoomSessionInfo | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  if (!ROOM_PHASES.includes(s.phase as RoomPhase) || typeof s.id !== 'string') return undefined;
  const out: RoomSessionInfo = {
    phase: s.phase as RoomPhase,
    id: s.id.slice(0, 32),
  };
  const minutes = asQualifyingMinutes(s.minutes);
  if (minutes !== undefined) out.minutes = minutes;
  const endsAtHostMs = finite(s.endsAtHostMs, -1e15, 1e15);
  if (endsAtHostMs !== null) out.endsAtHostMs = endsAtHostMs;
  const times = sanitizeQualifyingTimes(s.times);
  if (times !== undefined) out.times = times;
  return out;
}

/**
 * Sorts qualifying participants by valid `bestLapMs` ascending; drivers without a valid lap are ordered behind them
 * in their original `peers` order.
 */
export function sortQualifyingTimes(
  peers: readonly string[],
  times: ReadonlyMap<string, number | null> | Record<string, number | null | undefined>,
): QualifyingTime[] {
  const getTime = (peer: string): number | null => {
    const raw = times instanceof Map ? times.get(peer) : (times as Record<string, number | null | undefined>)[peer];
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  };
  const indexed = peers.map((peer, idx) => ({ peer, ms: getTime(peer), idx }));
  indexed.sort((a, b) => {
    if (a.ms !== null && b.ms !== null) return a.ms - b.ms || a.idx - b.idx;
    if (a.ms !== null) return -1;
    if (b.ms !== null) return 1;
    return a.idx - b.idx;
  });
  return indexed.map(({ peer, ms }) => ({ peer, ms }));
}

/**
 * Builds the race starting grid from `peers`.
 * - After a qualifying session (`fromQualifying: true`): always sorted by valid `bestLapMs` ascending, with drivers
 *   without a valid lap ordered behind them.
 * - Without qualifying: applies `gridOrder` (`qualifying` uses any recorded times or join order; `reverse` reverses
 *   the order; `random` shuffles using `rng`).
 */
export function buildRaceGrid(
  peers: readonly string[],
  options: {
    gridOrder?: MpGridOrder;
    qualifyingTimes?: ReadonlyMap<string, number | null> | Record<string, number | null | undefined> | readonly QualifyingTime[];
    fromQualifying?: boolean;
    rng?: () => number;
  } = {},
): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const p of peers) {
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  const toMap = (src: typeof options.qualifyingTimes): Map<string, number | null> => {
    const m = new Map<string, number | null>();
    if (!src) return m;
    if (Array.isArray(src)) {
      for (const row of src) m.set(row.peer, row.ms);
    } else if (src instanceof Map) {
      for (const [k, v] of src) m.set(k, v);
    } else {
      for (const [k, v] of Object.entries(src)) m.set(k, v ?? null);
    }
    return m;
  };
  if (options.fromQualifying) {
    return sortQualifyingTimes(unique, toMap(options.qualifyingTimes)).map((q) => q.peer);
  }
  const order = options.gridOrder ?? 'qualifying';
  if (order === 'random') {
    const out = [...unique];
    const rng = options.rng ?? Math.random;
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.max(0, Math.min(0.999999999999, rng())) * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
  if (order === 'reverse') {
    if (options.qualifyingTimes) {
      const sorted = sortQualifyingTimes(unique, toMap(options.qualifyingTimes));
      const timed = sorted.filter((q) => q.ms !== null).reverse();
      const untimed = sorted.filter((q) => q.ms === null);
      return [...timed, ...untimed].map((q) => q.peer);
    }
    return [...unique].reverse();
  }
  if (options.qualifyingTimes) {
    return sortQualifyingTimes(unique, toMap(options.qualifyingTimes)).map((q) => q.peer);
  }
  return unique;
}

export function sanitizeStart(v: unknown): RaceStartInfo | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  const lightsStartHostMs = finite(s.lightsStartHostMs, -1e15, 1e15);
  const holdMs = finite(s.holdMs, 0, 5000);
  const laps = finite(s.laps, 1, 99);
  if (typeof s.id !== 'string' || lightsStartHostMs === null || holdMs === null || laps === null) return null;
  if (!Array.isArray(s.grid)) return null;
  const out: RaceStartInfo = {
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
  const weather = asWeather(s.weather);
  const timeOfDay = asTimeOfDay(s.timeOfDay);
  const timeScale = asTimeScale(s.timeScale);
  const startType = asStartType(s.startType);
  const gridOrder = asGridOrder(s.gridOrder);
  const rules = sanitizeRaceRules(s.rules);
  const qualifying = sanitizeQualifyingTimes(s.qualifying);
  if (weather !== undefined) out.weather = weather;
  if (timeOfDay !== undefined) out.timeOfDay = timeOfDay;
  if (timeScale !== undefined) out.timeScale = timeScale;
  if (startType !== undefined) out.startType = startType;
  if (typeof s.manualStart === 'boolean') out.manualStart = s.manualStart;
  if (gridOrder !== undefined) out.gridOrder = gridOrder;
  if (rules !== undefined) out.rules = rules;
  if (qualifying !== undefined) out.qualifying = qualifying;
  return out;
}

export function sanitizeLobby(v: unknown): LobbyState | null {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  if (typeof l.hostId !== 'string' || !Array.isArray(l.players)) return null;
  const roomKind = asRoomKind(l.roomKind);
  const session = sanitizeRoomSession(l.session);
  const out: LobbyState = {
    hostId: l.hostId.slice(0, 64),
    weather: sanitizeWeatherSync(l.weather) ?? undefined,
    proto: version(l.proto),
    sim: version(l.sim),
    settings: sanitizeLobbySettings(l.settings, roomKind),
    players: (() => {
      const rawPlayers = l.players.slice(0, 32).flatMap((p): LobbyPlayer[] => {
        if (!p || typeof p !== 'object') return [];
        const q = p as Record<string, unknown>;
        if (typeof q.peerId !== 'string') return [];
        const peerId = q.peerId.slice(0, 64);
        const name = clampStr(q.name, 16, 'Driver');
        return [
          {
            peerId,
            name,
            code: asCode(q.code, name, peerId),
            color: asColor(q.color),
            vehicle: asPeerVehicle(q.vehicle),
            trackId: typeof q.trackId === 'string' ? q.trackId.slice(0, 64) : undefined,
            ready: q.ready === true,
            isHost: q.isHost === true,
          },
        ];
      });
      const codes = dedupeDriverCodes(rawPlayers.map((p) => ({ id: p.peerId, code: p.code, name: p.name })));
      return rawPlayers.map((p) => ({ ...p, code: codes.get(p.peerId) ?? p.code }));
    })(),
    race: l.race ? sanitizeStart(l.race) : null,
  };
  if (roomKind !== undefined) out.roomKind = roomKind;
  if (session !== undefined) out.session = session;
  return out;
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
  const name = typeof p.name === 'string' ? clampStr(p.name, 16, 'Driver') : undefined;
  return {
    peerId: p.peerId,
    driverCode: asCode(p.driverCode, name, p.peerId),
    teamColorHex: asColor(p.teamColorHex),
    ...(p.liveryId === null
      ? { liveryId: null }
      : typeof p.liveryId === 'string' && p.liveryId.length > 0 && !p.liveryId.startsWith('mod:')
        ? { liveryId: p.liveryId.slice(0, 32) }
        : {}),
    ...(typeof p.customLivery === 'object' &&
    p.customLivery !== null &&
    !Array.isArray(p.customLivery) &&
    typeof (p.customLivery as Record<string, unknown>).primary === 'string' &&
    typeof (p.customLivery as Record<string, unknown>).secondary === 'string' &&
    typeof (p.customLivery as Record<string, unknown>).accent === 'string'
      ? {
          customLivery: {
            primary: asColor((p.customLivery as Record<string, unknown>).primary),
            secondary: asColor((p.customLivery as Record<string, unknown>).secondary),
            accent: asColor((p.customLivery as Record<string, unknown>).accent),
          },
        }
      : {}),
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
    fl: p.fl === true ? true : undefined,
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
    case 'hello': {
      const name = clampStr(m.name, 16, 'Driver');
      return {
        type: 'hello',
        name,
        code: asCode(m.code, name),
        color: asColor(m.color),
        vehicle: asPeerVehicle(m.vehicle),
        trackId: typeof m.trackId === 'string' ? m.trackId.slice(0, 64) : undefined,
        proto: version(m.proto),
        sim: version(m.sim),
      };
    }
    case 'refuse':
      if (m.reason === 'version') return { type: 'refuse', reason: 'version' };
      if (m.reason === 'car_class') {
        const carClass = CAR_CLASSES.includes(m.carClass as CarClassRule) ? (m.carClass as CarClassRule) : undefined;
        const vehicle = asPeerVehicle(m.vehicle);
        return { type: 'refuse', reason: 'car_class', ...(carClass ? { carClass } : {}), ...(vehicle ? { vehicle } : {}) };
      }
      return null;
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
    case 'quali_lap': {
      const bestLapMs = finite(m.bestLapMs, MIN_QUALIFYING_LAP_MS, 1e7);
      if (typeof m.id !== 'string' || bestLapMs === null) return null;
      return { type: 'quali_lap', id: m.id.slice(0, 32), bestLapMs: Math.round(bestLapMs) };
    }
    default:
      return null;
  }
}

