/**
 * The cloud save's model: which of the game's stored data follows the player between devices, how this device's share
 * of it is read (`collect`) and written back (`apply`), and how two saves become one (`combineSaves`).
 *
 * Pure: no DOM, no network, no clock of its own, so the verify suite runs it exactly as the browser does. The sync
 * engine (sync-engine.ts) brings the storage, the time and the best laps.
 *
 * What moves and what stays is the plan's "Local save: what moves, what stays": the player's settings (their share of
 * PlayerSettings), car and tyre setups, saved setups, liveries, the last car and circuit, race history and personal
 * bests follow the account. Controls, graphics, field of view, HUD, volumes, the driver key and anything about this
 * browser or its hardware stay on the device.
 */
import { SAVE_DOC_VERSION, SHA256_HEX_RE, type CloudBestLap, type SaveDoc, type Stamped } from "./api-types";
import type { FirstSyncChoice, SaveSummary } from "./account-store";
import type { AudioSettings, InterfaceSettings, PlayerSettings } from "@/lib/settings/player-settings";
import { RACE_HISTORY_MAX } from "@/lib/sim/race-history";

// ---------------------------------------------------------------------------------------------------------------
// What is stored where

/** Synced: goes in the cloud save. Device: stays here. Rebuilt: made again from other data or fetched from the boards */
export type KeyClass = "synced" | "device" | "rebuilt";

/** The settings save (player-settings.ts SETTINGS_STORAGE_KEY): synced, but only its account fields */
export const SETTINGS_KEY = "bugesera.settings.v1";
/** This device's change times and its last sync with the account (device only) */
export const SYNC_STATE_KEY = "librecorsa.syncState";
/** sessionStorage: the cloud save a reload was made for in this tab, so a save that won't stick can't loop */
export const RELOAD_MARK_KEY = "librecorsa.accountReload";
/** Saved setups kept per car (car-setup.ts GARAGE_PRESETS_MAX; the verify suite checks they agree) */
export const PRESETS_MAX = 24;
/** Longest saved setup name (EngineersGarage) */
const PRESET_NAME_MAX = 32;

/**
 * Every key the game keeps under its prefixes (`bugesera.`, `librecorsa.`, `lc.`), by class. A key written with a
 * placeholder ("<car>") stands for a family: every key that starts with the text before the "<". The list in Settings
 * (src/components/settings/storage.ts STORAGE_KEYS) is checked against this one, so a key added there must be added
 * here too.
 */
export const KEY_CLASSES: Readonly<Record<string, KeyClass>> = {
  // Synced
  [SETTINGS_KEY]: "synced",
  "bugesera.vehicle": "synced",
  "bugesera.track": "synced",
  // The 2026 Prototype's tyre setup has the key without a car (tyre-setup.ts)
  "bugesera.tyreSetup": "synced",
  "bugesera.tyreSetup.<car>": "synced",
  "lc.garage.chassis.<car>": "synced",
  "lc.garage.presets.<car>": "synced",
  "librecorsa.carSkins": "synced",
  "librecorsa.raceHistory": "synced",
  "librecorsa.driverStats": "synced",
  // Careers (career/career-state.ts): combined per career, the newer of the two copies of one winning
  "librecorsa.career": "synced",
  "librecorsa.f1ModPhysics": "synced",
  // Credentials and network: each device keeps its own key and registers it with the account
  "bugesera.driverKey": "device",
  "bugesera.turn": "device",
  "lc.roomHostToken": "device",
  // Hardware
  "bugesera.gpu": "device",
  "bugesera.gpuLoss": "device",
  "bugesera.ffb_polarity_v2": "device",
  "bugesera.rumble": "device",
  // First run and one-time prompts
  "bugesera.onboarded": "device",
  "librecorsa.install-hint": "device",
  "librecorsa.update-reload": "device",
  "librecorsa.dualsense-prompt": "device",
  "librecorsa.supportPrompt": "device",
  "librecorsa.whatsNewSeen": "device",
  "librecorsa.signInHintShown": "device",
  // Mod packages are on this device only (the launcher's folder, its browser's storage), and so is which are off
  "librecorsa.mods.disabled": "device",
  // The player's own rules while a challenge or a career round has its own (LibreCorsaSimulator.tsx): put back on this device
  "librecorsa.ownRules": "device",
  // UI state
  "lc.mfdPage": "device",
  // The page the Endurance and Racing line HUD layouts' paged boxes were left on
  "lc.endurancePage": "device",
  "lc.hud.racing-line.page": "device",
  "lc.seatHintCars": "device",
  "librecorsa.boardFilters": "device",
  // URL flags
  "librecorsa.simMode": "device",
  "librecorsa.lc26Engine": "device",
  "librecorsa.vf26Engine": "device",
  // What the AI learnt per corner: it drives back in on this device only
  "librecorsa.ai-learn.v1.<circuit>.<class>.<driver>": "device",
  // Laps waiting to post
  "lc.boardMiss": "device",
  // Not game data
  "librecorsa.adminKey": "device",
  // The sync's own records
  [SYNC_STATE_KEY]: "device",
  [RELOAD_MARK_KEY]: "device",
  // Rebuilt from IndexedDB, or fetched from the boards
  "librecorsa.bestLapSummaries.v1": "rebuilt",
  "librecorsa.bestLapsUpdatedAt": "rebuilt",
  "lc.boardBest": "rebuilt",
  "lc.challengeBest": "rebuilt",
};

const EXACT = new Map<string, KeyClass>();
/** Longest prefix first, so a family inside another one wins */
const FAMILIES: { prefix: string; cls: KeyClass }[] = [];
for (const [key, cls] of Object.entries(KEY_CLASSES)) {
  const at = key.indexOf("<");
  if (at < 0) EXACT.set(key, cls);
  else FAMILIES.push({ prefix: key.slice(0, at), cls });
}
FAMILIES.sort((a, b) => b.prefix.length - a.prefix.length);

/** What a stored key is; null for a key the game doesn't know (never synced) */
export function classifyKey(key: string): KeyClass | null {
  const exact = EXACT.get(key);
  if (exact) return exact;
  for (const f of FAMILIES) if (key.length > f.prefix.length && key.startsWith(f.prefix)) return f.cls;
  return null;
}

/** Keys that go in the save's `keys` (the settings go in its `settings`, field by field) */
export const isSyncedKey = (key: string): boolean => key !== SETTINGS_KEY && classifyKey(key) === "synced";

const PRESETS_PREFIX = "lc.garage.presets.";
const RACE_HISTORY_KEY = "librecorsa.raceHistory";
/** Lists two devices can each add to: combined entry by entry instead of one side winning */
const isPresetsKey = (key: string) => key.startsWith(PRESETS_PREFIX);

/** Account: follows the player. Device: stays here. Split: an object with members of both kinds */
export type SettingsShare = "account" | "device" | "split";

/**
 * Every PlayerSettings field and where it lives. `satisfies` makes a new field a type error until it is placed here;
 * the verify suite checks the same at run time.
 */
export const SETTINGS_SPLIT = {
  // Controls
  device: "device",
  keys: "device",
  padButtons: "device",
  padSensitivity: "device",
  wheel: "device",
  mouseSteer: "device",
  padTuning: "device",
  dualSense: "device",
  keyboardTuning: "device",
  gamepadAssist: "device",
  // View and screen
  cockpitFovDeg: "device",
  cameraNudges: "device",
  hud: "device",
  graphics: "device",
  touch: "device",
  // Driving
  assistPreset: "account",
  racingLine: "account",
  autoGearbox: "account",
  autoClutch: "account",
  autoOvertake: "account",
  ghost: "account",
  // Profile and look
  profile: "account",
  liveryId: "account",
  customLivery: "account",
  camera: "account",
  // Sessions
  aiSkill: "account",
  race: "account",
  realism: "account",
  practiceDamage: "account",
  conditions: "account",
  timeOfDayChosen: "account",
  library: "account",
  // Music choices follow the player, the volumes stay with the speakers
  audio: "split",
  // Units and palette follow the player, the scale and the Settings detail level suit this screen
  ui: "split",
} as const satisfies Record<keyof PlayerSettings, SettingsShare>;

export const AUDIO_SPLIT = {
  volume: "device",
  kerbs: "device",
  muted: "device",
  menuMusic: "device",
  raceMusic: "device",
  replayMusic: "device",
  raceMusicOn: "account",
  musicOff: "account",
  musicMuted: "account",
  spotter: "account",
  spotterVolume: "device",
  spotterVoice: "account",
  spotterRadio: "account",
} as const satisfies Record<keyof AudioSettings, "account" | "device">;

export const UI_SPLIT = {
  units: "account",
  scale: "device",
  palette: "account",
  detail: "device",
  // Automatic follows each browser's own language, and a phone and a PC may be set up in different ones
  language: "device",
} as const satisfies Record<keyof InterfaceSettings, "account" | "device">;

const SUB_SPLITS: Readonly<Record<string, Readonly<Record<string, "account" | "device">>>> = { audio: AUDIO_SPLIT, ui: UI_SPLIT };

/** The PlayerSettings fields that go in the save */
export const ACCOUNT_SETTINGS_FIELDS: readonly string[] = Object.entries(SETTINGS_SPLIT)
  .filter(([, share]) => share !== "device")
  .map(([field]) => field);

const isAccountField = (field: string) => ACCOUNT_SETTINGS_FIELDS.includes(field);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The account's share of a settings field's stored value; undefined when there is none */
function accountShare(field: string, value: unknown): unknown {
  const sub = SUB_SPLITS[field];
  if (!sub) return value;
  if (!isObj(value)) return undefined;
  const out: Obj = {};
  for (const [member, share] of Object.entries(sub)) if (share === "account" && value[member] !== undefined) out[member] = value[member];
  return Object.keys(out).length ? out : undefined;
}

/**
 * What a newer build saves that this one doesn't know: a key no class here names, a settings field PlayerSettings
 * doesn't have, a member of a split field neither split names. A save keeps them as they are, so an older build never
 * drops a newer one's data; they are never written into this device's storage.
 */
const isUnknownKey = (key: string) => classifyKey(key) === null;
const isUnknownField = (field: string) => !Object.hasOwn(SETTINGS_SPLIT, field);
function unknownMembers(field: string, value: unknown): Obj {
  const sub = SUB_SPLITS[field];
  const out: Obj = {};
  if (!sub || !isObj(value)) return out;
  for (const [member, v] of Object.entries(value)) if (!Object.hasOwn(sub, member)) out[member] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Hashing (change detection only: fast and synchronous, not for security)

/** JSON with object keys in sorted order, so equal values always give the same text */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  if (isObj(v)) {
    const parts: string[] = [];
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) parts.push(`${JSON.stringify(k)}:${stableStringify(v[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A 64-bit hash of a text as 16 hex digits (cyrb53's mixing, both halves kept) */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const hashValue = (v: unknown) => hashText(stableStringify(v));
/** A settings field's value as this build compares it: its account share (a split field's known members only) */
const fieldHash = (field: string, value: unknown) => hashValue(accountShare(field, value));
/** What a removed key hashes to in the sync base */
const REMOVED_HASH = "-";

// ---------------------------------------------------------------------------------------------------------------
// This device's change times (librecorsa.syncState)

/** A value as last seen: its hash, and when it changed (0 = it was already there when tracking began) */
export interface SeenValue {
  h: string;
  t: number;
}

/**
 * Per synced key and settings field, the hash of the value this device and the cloud last agreed on (a removed key:
 * "-"). Two saves are combined three ways against it: a side still at the base didn't change, so the other side's
 * value is the newer one whatever the clocks say. A deletion on one device so sticks instead of coming back from the
 * other's copy.
 */
export interface SyncBase {
  keys: Record<string, string>;
  settings: Record<string, string>;
}

/** This device's last sync with an account */
export interface AccountSyncRecord {
  /** The account's id */
  id: string;
  /** The cloud save's rev after the last sync */
  rev: number;
  /** The rev whose save this device has taken on (written into its storage) */
  appliedRev: number;
  base: SyncBase;
  lastSyncedAt: number;
  /** `localHash` of this device's save at the end of the last sync: a different one means something changed since */
  localHash: string;
  /** Ghosts already fetched from the cloud (SHA-256), newest last: not asked for again */
  fetched: string[];
}

export interface SyncState {
  v: 1;
  /** When this device first collected its save (0: never) */
  since: number;
  keys: Record<string, SeenValue>;
  settings: Record<string, SeenValue>;
  /** Synced keys this device saw go, and when */
  removed: Record<string, number>;
  /** The SHA-256 of each best lap's ghost by its store key, kept while its time and date stay the same */
  ghosts: Record<string, { ms: number; at: number; sha: string }>;
  account: AccountSyncRecord | null;
  /**
   * By account id: the driver key (its AccountKey id) whose join was answered `keyElsewhere`. That key stays on the
   * other account, so the session has no current key here; it isn't sent again on every start
   */
  keyElsewhere: Record<string, string>;
}

export const emptySyncState = (): SyncState => ({ v: 1, since: 0, keys: {}, settings: {}, removed: {}, ghosts: {}, account: null, keyElsewhere: {} });

/** Tombstones kept at most; the oldest go first */
const MAX_REMOVED = 200;
/** Fetched ghost hashes remembered at most */
const MAX_FETCHED = 1000;

function parseSeen(raw: unknown): Record<string, SeenValue> {
  const out: Record<string, SeenValue> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isObj(v) && typeof v.h === "string" && isTime(v.t)) out[k] = { h: v.h, t: v.t };
  return out;
}

function parseTimes(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isTime(v)) out[k] = v;
  return out;
}

function parseHashes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The stored sync state, field by field; anything unreadable starts afresh */
export function parseSyncState(text: string | null): SyncState {
  const state = emptySyncState();
  if (!text) return state;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return state;
  }
  if (!isObj(raw) || raw.v !== 1) return state;
  state.since = isTime(raw.since) ? raw.since : 0;
  state.keys = parseSeen(raw.keys);
  state.settings = parseSeen(raw.settings);
  state.removed = parseTimes(raw.removed);
  if (isObj(raw.ghosts)) {
    for (const [k, g] of Object.entries(raw.ghosts)) {
      if (isObj(g) && isTime(g.ms) && isTime(g.at) && typeof g.sha === "string" && SHA256_HEX_RE.test(g.sha)) state.ghosts[k] = { ms: g.ms, at: g.at, sha: g.sha };
    }
  }
  state.keyElsewhere = parseHashes(raw.keyElsewhere);
  const a = raw.account;
  if (isObj(a) && typeof a.id === "string" && isTime(a.rev) && isTime(a.appliedRev)) {
    const base = isObj(a.base) ? a.base : {};
    state.account = {
      id: a.id,
      rev: a.rev,
      appliedRev: a.appliedRev,
      base: { keys: parseHashes(base.keys), settings: parseHashes(base.settings) },
      lastSyncedAt: isTime(a.lastSyncedAt) ? a.lastSyncedAt : 0,
      localHash: typeof a.localHash === "string" ? a.localHash : "",
      fetched: Array.isArray(a.fetched) ? a.fetched.filter((s): s is string => typeof s === "string" && SHA256_HEX_RE.test(s)).slice(-MAX_FETCHED) : [],
    };
  }
  return state;
}

/** Notes ghosts as fetched (the newest kept when the list is full) */
export const rememberFetched = (fetched: readonly string[], shas: readonly string[]): string[] =>
  [...fetched.filter((s) => !shas.includes(s)), ...shas].slice(-MAX_FETCHED);

/** The newest tombstones, at most MAX_REMOVED */
function trimRemoved(removed: Record<string, number>): Record<string, number> {
  const entries = Object.entries(removed);
  if (entries.length <= MAX_REMOVED) return removed;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_REMOVED));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and writing this device's save

/** What `collect` and `apply` need of localStorage (an in-memory one in the verify suite) */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Every key in the storage (a failing storage reads as empty) */
function storageKeys(storage: StorageLike): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null) out.push(k);
    }
  } catch {
    // Storage blocked: nothing to read
  }
  return out;
}

const read = (storage: StorageLike, key: string): string | null => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

/** The stored settings as an object; null when there are none or they don't parse */
function readSettings(storage: StorageLike): Obj | null {
  const text = read(storage, SETTINGS_KEY);
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** When a value changed: kept while its hash is the same, 0 on the first collect ever, else now */
function stampOf(prev: SeenValue | undefined, h: string, first: boolean, now: number): number {
  if (prev && prev.h === h) return prev.t;
  return first ? 0 : now;
}

export const emptySave = (savedAt = 0, savedBy = ""): SaveDoc => ({
  v: SAVE_DOC_VERSION,
  savedAt,
  savedBy,
  keys: {},
  settings: {},
  bestLaps: {},
  removed: {},
});

/**
 * This device's save, from its storage: the synced keys as stored, the account's share of the settings, the best
 * laps the caller read from IndexedDB. Each value carries when it changed, from the sync state: a value seen before
 * keeps its time, a changed or new one takes `now`, and on the very first collect everything is 0 (not known), which
 * the first-sync screen's choice then decides. A synced key that was here last time and is gone now becomes a
 * tombstone. Returns the save and the updated sync state (the caller stores it).
 */
export function collect(
  storage: StorageLike,
  state: SyncState,
  opts: { now: number; savedBy: string; bestLaps?: Record<string, CloudBestLap> }
): { doc: SaveDoc; state: SyncState } {
  const { now } = opts;
  const first = state.since === 0;
  const doc = emptySave(now, opts.savedBy);
  const seenKeys: Record<string, SeenValue> = {};
  const removed = { ...state.removed };

  for (const key of storageKeys(storage)) {
    if (!isSyncedKey(key)) continue;
    const value = read(storage, key);
    if (value === null) continue;
    const h = hashText(value);
    const t = stampOf(state.keys[key], h, first, now);
    seenKeys[key] = { h, t };
    doc.keys[key] = { value, t };
    delete removed[key];
  }
  for (const key of Object.keys(state.keys)) if (!seenKeys[key] && removed[key] === undefined) removed[key] = now;

  const seenSettings = { ...state.settings };
  const settings = readSettings(storage);
  if (settings) {
    for (const field of ACCOUNT_SETTINGS_FIELDS) {
      const value = accountShare(field, settings[field]);
      if (value === undefined) continue;
      const h = hashValue(value);
      const t = stampOf(state.settings[field], h, first, now);
      seenSettings[field] = { h, t };
      doc.settings[field] = { value, t };
    }
  }

  doc.bestLaps = { ...(opts.bestLaps ?? {}) };
  doc.removed = trimRemoved(removed);
  return {
    doc,
    state: { ...state, since: first ? now : state.since, keys: seenKeys, settings: seenSettings, removed: doc.removed },
  };
}

/**
 * Writes a save into this device's storage: each synced key it holds, the removal of each key it says was removed,
 * and its settings fields merged into the stored settings (this device's own fields untouched). Anything in the save
 * that isn't synced (a driver key, a device setting) is ignored. The sync state takes the save's change times, so the
 * next collect sees nothing new. `drop`: keys of this device's that the save leaves out (`dropsOf`), each with the
 * value it had when read; one changed since is kept. They go without a tombstone: only this device lets them go.
 * `changed`: something in storage is different now (the page reloads to use it).
 */
export function apply(storage: StorageLike, doc: SaveDoc, state: SyncState, drop: Record<string, string> = {}): { state: SyncState; changed: boolean } {
  const keys = { ...state.keys };
  const seenSettings = { ...state.settings };
  const removed = { ...state.removed };
  let changed = false;
  const write = (key: string, value: string | null): boolean => {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
      return true;
    } catch {
      // Full or blocked: the value stays as it was here, and the sync state says so
      return false;
    }
  };

  for (const [key, s] of Object.entries(doc.keys)) {
    if (!isSyncedKey(key) || typeof s?.value !== "string") continue;
    const current = read(storage, key);
    if (current !== s.value) {
      if (!write(key, s.value)) continue;
      changed = true;
    }
    keys[key] = { h: hashText(s.value), t: isTime(s.t) ? s.t : 0 };
    delete removed[key];
  }
  for (const [key, t] of Object.entries(doc.removed)) {
    if (!isSyncedKey(key) || doc.keys[key] || !isTime(t)) continue;
    if (read(storage, key) !== null) {
      if (!write(key, null)) continue;
      changed = true;
    }
    delete keys[key];
    removed[key] = Math.max(removed[key] ?? 0, t);
  }
  for (const [key, value] of Object.entries(drop)) {
    if (!isSyncedKey(key) || doc.keys[key] || doc.removed[key] !== undefined || read(storage, key) !== value) continue;
    if (!write(key, null)) continue;
    changed = true;
    delete keys[key];
  }

  const fields = Object.entries(doc.settings).filter(([field, s]) => isAccountField(field) && isObj(s) && s.value !== undefined);
  if (fields.length) {
    const stored = readSettings(storage);
    const next: Obj = stored ? { ...stored } : {};
    const seen: Record<string, SeenValue> = {};
    let settingsChanged = false;
    for (const [field, s] of fields) {
      const share = accountShare(field, s.value);
      if (share === undefined) continue;
      const before = accountShare(field, next[field]);
      if (stableStringify(before) !== stableStringify(share)) {
        // A split field keeps this device's own members (the volumes, the interface scale)
        next[field] = SUB_SPLITS[field] ? { ...(isObj(next[field]) ? (next[field] as Obj) : {}), ...(share as Obj) } : share;
        settingsChanged = true;
      }
      seen[field] = { h: hashValue(share), t: isTime(s.t) ? s.t : 0 };
    }
    // Not written (storage full): the fields stay as they were here, and so do their change times
    if (!settingsChanged || write(SETTINGS_KEY, JSON.stringify(next))) {
      Object.assign(seenSettings, seen);
      if (settingsChanged) changed = true;
    }
  }

  return { state: { ...state, keys, settings: seenSettings, removed: trimRemoved(removed) }, changed };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a save from the network

function parseBestLap(v: unknown): CloudBestLap | null {
  if (!isObj(v)) return null;
  const { trackId, vehicle, lapTimeMs, recordedAt, ghost } = v;
  if (typeof trackId !== "string" || typeof vehicle !== "string" || typeof ghost !== "string" || !SHA256_HEX_RE.test(ghost)) return null;
  if (typeof lapTimeMs !== "number" || !Number.isFinite(lapTimeMs) || lapTimeMs <= 0) return null;
  return { trackId, vehicle, lapTimeMs, recordedAt: isTime(recordedAt) ? recordedAt : 0, ghost };
}

/**
 * A save as sent by the server (or another device through it), entry by entry; entries that don't read are dropped.
 * Null when it isn't a save this build can read: a newer version's save is never written over by an older build.
 */
export function readSaveDoc(raw: unknown): SaveDoc | null {
  if (!isObj(raw) || raw.v !== SAVE_DOC_VERSION) return null;
  const doc = emptySave(isTime(raw.savedAt) ? raw.savedAt : 0, typeof raw.savedBy === "string" ? raw.savedBy.slice(0, 80) : "");
  if (isObj(raw.keys)) {
    for (const [k, s] of Object.entries(raw.keys)) if (isObj(s) && typeof s.value === "string") doc.keys[k] = { value: s.value, t: isTime(s.t) ? s.t : 0 };
  }
  if (isObj(raw.settings)) {
    for (const [k, s] of Object.entries(raw.settings)) if (isObj(s) && s.value !== undefined) doc.settings[k] = { value: s.value, t: isTime(s.t) ? s.t : 0 };
  }
  if (isObj(raw.bestLaps)) {
    for (const [k, b] of Object.entries(raw.bestLaps)) {
      const lap = parseBestLap(b);
      if (lap) doc.bestLaps[k] = lap;
    }
  }
  doc.removed = parseTimes(raw.removed);
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------
// Combining two saves

type KeySide = { removed: false; value: string; t: number } | { removed: true; t: number } | null;

function keySide(doc: SaveDoc, key: string): KeySide {
  const s = doc.keys[key];
  if (s && typeof s.value === "string") return { removed: false, value: s.value, t: isTime(s.t) ? s.t : 0 };
  const t = doc.removed[key];
  return isTime(t) ? { removed: true, t } : null;
}

const keySideHash = (s: Exclude<KeySide, null>) => (s.removed ? REMOVED_HASH : hashText(s.value));

/**
 * Which side a single value comes from when both changed it (Combine): the newer change when both times are known and
 * differ; a known change over one not known; the cloud's on a tie or when neither is known (the account's save is what
 * this device joined)
 */
export function pickSide(localT: number, cloudT: number): "local" | "cloud" {
  if (localT > 0 && cloudT > 0 && localT !== cloudT) return localT > cloudT ? "local" : "cloud";
  return localT > 0 && cloudT === 0 ? "local" : "cloud";
}

/** The list stored under a key, or null when it isn't one */
function parseList(text: string): Obj[] | null {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter(isObj) : null;
  } catch {
    return null;
  }
}

const numberOr = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Both sides' race history: every race once (the same race on both: the final result over a provisional one, else the
 * preferred side's), newest first, the game's last RACE_HISTORY_MAX kept.
 */
export function combineRaceHistory(preferred: string, other: string): string {
  const a = parseList(preferred);
  const b = parseList(other);
  if (!a) return b ? other : preferred;
  if (!b) return preferred;
  const byId = new Map<string, Obj>();
  for (const r of a) if (typeof r.id === "string") byId.set(r.id, r);
  for (const r of b) {
    if (typeof r.id !== "string") continue;
    const kept = byId.get(r.id);
    if (!kept || (r.final === true && kept.final !== true)) byId.set(r.id, r);
  }
  const list = [...byId.values()].sort((x, y) => numberOr(y.atMs, 0) - numberOr(x.atMs, 0)).slice(0, RACE_HISTORY_MAX);
  return JSON.stringify(list);
}

/** A saved setup's content: everything but what names and dates it */
const setupContent = (p: Obj) => stableStringify({ ...p, id: undefined, name: undefined, savedAt: undefined });

/** "Name (2)", "Name (3)"...: the first not taken, within the name length the garage allows */
function freeName(name: string, taken: readonly Obj[]): string {
  const used = new Set(taken.map((p) => String(p.name).toLowerCase()));
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, PRESET_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Both sides' saved setups for one car. The same setup (by id) once, the more recently saved copy; two setups with the
 * same name keep both, the other side's renamed "Name (2)" (unless they are the same setup saved twice). Newest first,
 * the garage's PRESETS_MAX kept.
 */
export function combinePresets(preferred: string, other: string): string {
  const a = parseList(preferred);
  const b = parseList(other);
  if (!a) return b ? other : preferred;
  if (!b) return preferred;
  const out = a.filter((p) => typeof p.name === "string");
  for (const p of b) {
    const name = p.name;
    if (typeof name !== "string") continue;
    const same = out.findIndex((q) => q.id !== undefined && q.id === p.id);
    if (same >= 0) {
      if (numberOr(p.savedAt, 0) > numberOr(out[same].savedAt, 0)) out[same] = p;
      continue;
    }
    const clash = out.find((q) => String(q.name).toLowerCase() === name.toLowerCase());
    if (clash) {
      if (setupContent(clash) === setupContent(p)) continue;
      out.push({ ...p, name: freeName(name, out) });
    } else out.push(p);
  }
  // A stable sort: setups saved at the same moment keep their order
  return JSON.stringify(out.sort((x, y) => numberOr(y.savedAt, 0) - numberOr(x.savedAt, 0)).slice(0, PRESETS_MAX));
}

export interface CombineOptions {
  /** This device's last agreed values (its sync record); none for two saves that never met (a first sync, a merge) */
  base?: SyncBase | null;
}

/** Combine: both sides' values, value by value (see combineSaves) */
function combineValues(local: SaveDoc, cloud: SaveDoc, base: SyncBase | null, out: SaveDoc): void {
  const keys = new Set([...Object.keys(local.keys), ...Object.keys(cloud.keys), ...Object.keys(local.removed), ...Object.keys(cloud.removed)]);
  for (const key of keys) {
    if (!isSyncedKey(key)) continue;
    const l = keySide(local, key);
    const c = keySide(cloud, key);
    const b = base?.keys[key];
    let res: KeySide;
    // The cloud no longer has a value this device still holds as agreed: it was taken out there (the account took
    // another device's save as it was), so it goes here too
    if (l && !c && b !== undefined && keySideHash(l) === b) res = null;
    else if (!l || !c) res = l ?? c;
    else if (keySideHash(l) === keySideHash(c)) res = { ...c, t: Math.max(l.t, c.t) };
    else if (b !== undefined && keySideHash(l) === b) res = c;
    else if (b !== undefined && keySideHash(c) === b) res = l;
    else if (!l.removed && !c.removed && (key === RACE_HISTORY_KEY || key === CAREER_KEY || isPresetsKey(key))) {
      const value =
        key === RACE_HISTORY_KEY
          ? combineRaceHistory(c.value, l.value)
          : key === CAREER_KEY
            ? combineCareers(c.value, l.value)
            : combinePresets(c.value, l.value);
      res = { removed: false, value, t: Math.max(l.t, c.t) };
    } else res = pickSide(l.t, c.t) === "local" ? l : c;
    if (!res) continue;
    if (res.removed) out.removed[key] = res.t;
    else out.keys[key] = { value: res.value, t: res.t };
  }

  const fields = new Set([...Object.keys(local.settings), ...Object.keys(cloud.settings)]);
  for (const field of fields) {
    if (!isAccountField(field)) continue;
    const l = local.settings[field];
    const c = cloud.settings[field];
    let res: Stamped<unknown> | undefined;
    if (!l || !c) res = l ?? c;
    else {
      const lh = fieldHash(field, l.value);
      const ch = fieldHash(field, c.value);
      const b = base?.settings[field];
      if (lh === ch) res = { value: c.value, t: Math.max(l.t, c.t) };
      else if (b !== undefined && lh === b) res = c;
      else if (b !== undefined && ch === b) res = l;
      else res = pickSide(l.t, c.t) === "local" ? l : c;
    }
    if (res) out.settings[field] = { value: res.value, t: res.t };
  }
}

/**
 * Use the cloud save / Keep this device's save: the chosen side's synced keys, removals and settings as they are. A
 * key only the other side has is left out (`dropsOf` takes it off this device); a settings field only the other side
 * has is kept, as nothing on the chosen side says otherwise.
 */
function takeValues(chosen: SaveDoc, other: SaveDoc, out: SaveDoc): void {
  for (const [key, s] of Object.entries(chosen.keys)) if (isSyncedKey(key)) out.keys[key] = { value: s.value, t: s.t };
  for (const [key, t] of Object.entries(chosen.removed)) if (isSyncedKey(key) && !chosen.keys[key]) out.removed[key] = t;
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    const s = chosen.settings[field] ?? other.settings[field];
    if (s) out.settings[field] = { value: s.value, t: s.t };
  }
}

/**
 * A newer build's keys, settings fields and split-field members, kept whatever the choice: by their times where both
 * sides have one (the cloud's on a tie), else from the side that has it
 */
function carryUnknown(local: SaveDoc, cloud: SaveDoc, out: SaveDoc): void {
  const keys = new Set([...Object.keys(local.keys), ...Object.keys(cloud.keys), ...Object.keys(local.removed), ...Object.keys(cloud.removed)]);
  for (const key of keys) {
    if (!isUnknownKey(key)) continue;
    const l = keySide(local, key);
    const c = keySide(cloud, key);
    const res = !l || !c ? (l ?? c) : pickSide(l.t, c.t) === "local" ? l : c;
    if (!res) continue;
    if (res.removed) out.removed[key] = res.t;
    else out.keys[key] = { value: res.value, t: res.t };
  }
  for (const field of new Set([...Object.keys(local.settings), ...Object.keys(cloud.settings)])) {
    const l = local.settings[field];
    const c = cloud.settings[field];
    if (isUnknownField(field)) {
      const res = !l || !c ? (l ?? c) : pickSide(l.t, c.t) === "local" ? l : c;
      if (res) out.settings[field] = { value: res.value, t: res.t };
      continue;
    }
    const kept = out.settings[field];
    if (!kept || !SUB_SPLITS[field]) continue;
    const extra = { ...unknownMembers(field, l?.value), ...unknownMembers(field, c?.value) };
    if (Object.keys(extra).length) out.settings[field] = { value: { ...extra, ...(accountShare(field, kept.value) as Obj | undefined) }, t: kept.t };
  }
}

/**
 * One save from two: `local` (this device's, or a folded account's) and `cloud` (the account's), as `choice` says.
 *   combine  Both sides, value by value:
 *            - race history: both sides' races once each, within the game's cap
 *            - saved setups: both sides' per car; a clash on a name keeps both, one renamed "(2)"
 *            - everything else (settings fields, car and tyre setups, liveries, last car and circuit): the newer
 *              change by its time, a known time over an unknown one, the cloud's on a tie (pickSide). Removals count
 *              as changes, so a tombstone newer than the value removes it.
 *            With a `base`, a side whose value is still the base one didn't change: the other side's value is taken as
 *            it is (a setup deleted on one device stays deleted).
 *   cloud    The account's save as it is: this device's own values are replaced, and its keys the account lacks go.
 *   local    This device's save as it is: the account's values are replaced, and its keys this device lacks go.
 * Under every choice the best laps are both sides', the faster where both have one: a personal best is never thrown
 * away. The result is written by this device: `savedAt` and `savedBy` are local's.
 */
export function combineSaves(local: SaveDoc, cloud: SaveDoc, choice: FirstSyncChoice, opts: CombineOptions = {}): SaveDoc {
  const out = emptySave(local.savedAt, local.savedBy);
  if (choice === "combine") combineValues(local, cloud, opts.base ?? null, out);
  else if (choice === "cloud") takeValues(cloud, local, out);
  else takeValues(local, cloud, out);
  carryUnknown(local, cloud, out);

  const preferLocal = choice === "local";
  for (const key of new Set([...Object.keys(local.bestLaps), ...Object.keys(cloud.bestLaps)])) {
    const l = local.bestLaps[key];
    const c = cloud.bestLaps[key];
    const pick = !l ? c : !c ? l : l.lapTimeMs < c.lapTimeMs ? l : c.lapTimeMs < l.lapTimeMs ? c : preferLocal ? l : c;
    if (pick) out.bestLaps[key] = pick;
  }

  out.removed = trimRemoved(out.removed);
  return out;
}

/**
 * This device's synced keys that `result` leaves out (neither a value nor a removal), with the value each had: what
 * Use the cloud save, or another device's Keep this device's save, takes off this device (`apply`'s `drop`)
 */
export function dropsOf(local: SaveDoc, result: SaveDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, s] of Object.entries(local.keys)) if (isSyncedKey(key) && !result.keys[key] && result.removed[key] === undefined) out[key] = s.value;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing and describing saves

/** A hash of what a save holds (its values, not their times or who wrote it): equal hashes, nothing to send */
export function contentHash(doc: SaveDoc): string {
  const keys: Record<string, string> = {};
  for (const [k, s] of Object.entries(doc.keys)) keys[k] = s.value;
  const settings: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(doc.settings)) settings[k] = s.value;
  const laps: Record<string, string> = {};
  for (const [k, b] of Object.entries(doc.bestLaps)) laps[k] = `${b.lapTimeMs}:${b.ghost}`;
  return hashValue({ keys, settings, laps, removed: Object.keys(doc.removed).sort() });
}

/** Like contentHash, with laps by time only (no ghost hash): what the sync checks for changes without reading ghosts */
export function localHash(doc: SaveDoc, laps: Record<string, number>): string {
  return hashValue({ c: contentHash({ ...doc, bestLaps: {} }), laps });
}

/**
 * The sync base after a sync, value by value, from what this device holds now (`after`, read back once the result was
 * written or left for later): the result's where it holds it. Where it still holds what it had before the sync
 * (`local`: the value wasn't written yet, or couldn't be, storage being full), that: it agreed to replace it, so at the
 * next sync a value still at it takes the cloud's. A value changed during the sync keeps the old base.
 */
export function nextBase(result: SaveDoc, local: SaveDoc, after: SaveDoc, old: SyncBase | null): SyncBase {
  const base: SyncBase = { keys: {}, settings: {} };
  const keys = new Set([...Object.keys(result.keys), ...Object.keys(result.removed), ...Object.keys(local.keys), ...Object.keys(local.removed)]);
  const sideHash = (doc: SaveDoc, key: string) => {
    const side = keySide(doc, key);
    return side ? keySideHash(side) : undefined;
  };
  for (const key of keys) {
    if (!isSyncedKey(key)) continue;
    const rh = sideHash(result, key);
    const ah = sideHash(after, key);
    if (ah !== undefined && ah === rh) base.keys[key] = rh;
    else if (ah !== undefined && ah === sideHash(local, key)) base.keys[key] = ah;
    else if (old?.keys[key] !== undefined) base.keys[key] = old.keys[key];
  }
  const hashIn = (doc: SaveDoc, field: string) => (doc.settings[field] ? fieldHash(field, doc.settings[field].value) : undefined);
  for (const field of new Set([...Object.keys(result.settings), ...Object.keys(local.settings)])) {
    if (!isAccountField(field)) continue;
    const rh = hashIn(result, field);
    const ah = hashIn(after, field);
    if (ah !== undefined && ah === rh) base.settings[field] = rh;
    else if (ah !== undefined && ah === hashIn(local, field)) base.settings[field] = ah;
    else if (old?.settings[field] !== undefined) base.settings[field] = old.settings[field];
  }
  return base;
}

/** Whether writing `result` would change any synced key or settings field of the device whose save is `local` */
export function differsLocally(local: SaveDoc, result: SaveDoc): boolean {
  for (const [k, s] of Object.entries(result.keys)) if (isSyncedKey(k) && local.keys[k]?.value !== s.value) return true;
  for (const k of Object.keys(result.removed)) if (isSyncedKey(k) && local.keys[k] && !result.keys[k]) return true;
  if (Object.keys(dropsOf(local, result)).length) return true;
  for (const [f, s] of Object.entries(result.settings)) {
    if (!isAccountField(f)) continue;
    const l = local.settings[f];
    if (!l || fieldHash(f, l.value) !== fieldHash(f, s.value)) return true;
  }
  return false;
}

function listLength(doc: SaveDoc, key: string): number {
  const s = doc.keys[key];
  return s ? (parseList(s.value)?.length ?? 0) : 0;
}

/** What a save holds, for the first-sync screen. `side` "local": this device's (no date or writer) */
export function summarizeSave(doc: SaveDoc | null, side: "local" | "cloud"): SaveSummary {
  if (!doc) return { bestLaps: 0, setups: 0, races: 0, savedAt: null, savedBy: null };
  let setups = 0;
  for (const key of Object.keys(doc.keys)) if (isPresetsKey(key)) setups += listLength(doc, key);
  return {
    bestLaps: Object.keys(doc.bestLaps).length,
    setups,
    races: listLength(doc, RACE_HISTORY_KEY),
    savedAt: side === "cloud" ? doc.savedAt : null,
    savedBy: side === "cloud" ? doc.savedBy || null : null,
  };
}

const CAREER_KEY = "librecorsa.career";

/**
 * Two devices' careers: every career either holds, and of a career both hold (the same id), the copy last changed. The
 * career shown is the one changed last. Text the game cannot read keeps the other side's
 */
export function combineCareers(cloud: string, local: string): string {
  const read = (t: string): { v: number; runs: { id: string; updatedAt: number }[]; activeId: string | null; removed?: string[] } | null => {
    try {
      const v: unknown = JSON.parse(t);
      return isObj(v) && Array.isArray(v.runs) ? (v as never) : null;
    } catch {
      return null;
    }
  };
  const c = read(cloud);
  const l = read(local);
  if (!c || !l) return c ? cloud : local;
  // A career deleted on either device stays deleted
  const removed = [...new Set([...(Array.isArray(c.removed) ? c.removed : []), ...(Array.isArray(l.removed) ? l.removed : [])])];
  const byId = new Map<string, { id: string; updatedAt: number }>();
  for (const r of [...c.runs, ...l.runs]) {
    if (!r || typeof r.id !== "string" || removed.includes(r.id)) continue;
    const had = byId.get(r.id);
    if (!had || (r.updatedAt ?? 0) > (had.updatedAt ?? 0)) byId.set(r.id, r);
  }
  const runs = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const latest = runs.reduce<{ id: string; updatedAt: number } | null>((m, r) => (!m || r.updatedAt > m.updatedAt ? r : m), null);
  return JSON.stringify({ v: 1, runs, activeId: latest?.id ?? null, ...(removed.length ? { removed } : {}) });
}

/**
 * Nothing in the save is the player's own work: no best laps, races, saved setups, car or tyre setups or liveries.
 * The settings, the last car and circuit don't count: every device that opened the game once has them.
 */
export function isEmptySave(doc: SaveDoc): boolean {
  if (Object.keys(doc.bestLaps).length) return false;
  for (const [key, s] of Object.entries(doc.keys)) {
    if (key === CAREER_KEY) {
      try {
        const v: unknown = JSON.parse(s.value);
        if (isObj(v) && Array.isArray(v.runs) && v.runs.length) return false;
      } catch {
        // Unreadable: nothing the game would use
      }
      continue;
    }
    if (key === RACE_HISTORY_KEY || isPresetsKey(key)) {
      if ((parseList(s.value)?.length ?? 0) > 0) return false;
    } else if (key === "librecorsa.carSkins") {
      try {
        const v: unknown = JSON.parse(s.value);
        if (isObj(v) && Object.keys(v).length) return false;
      } catch {
        // Unreadable: nothing the game would use
      }
    } else if (key.startsWith("bugesera.tyreSetup") || key.startsWith("lc.garage.chassis.")) return false;
  }
  return true;
}

/**
 * The first sync of this device with an account (the plan's "First sign-in on a second device"):
 *   cloud empty            upload, no question
 *   this device empty      download, no question
 *   both hold a save       ask (Combine / Use the cloud save / Keep this device's save)
 */
export function firstSyncDecision(local: SaveDoc, cloud: SaveDoc | null): "upload" | "download" | "ask" {
  if (!cloud) return "upload";
  if (isEmptySave(local)) return "download";
  return isEmptySave(cloud) ? "upload" : "ask";
}
