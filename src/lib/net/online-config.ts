/**
 * The game's online side (cloudflare/api): where it lives and which parts of it are switched on.
 *
 * NEXT_PUBLIC_ONLINE_API is its base URL ("/api" on librecorsa.org, a full URL in development). Without it every
 * feature is off and the game uses what needs no server: room codes through the public PeerJS broker, lap times kept
 * in this browser. The switches are read at run time (GET <base>/config), so a feature can be turned off on the
 * server without a new build.
 *
 * A server that doesn't answer is not a server that said "off" (issue #122: one failed read at start used to keep lap
 * posting off for the whole session, without a word). While it is out of reach the read is tried again, a few seconds
 * later and then less and less often, up to once a minute (`configRetryDelayMs`), and at once when the browser comes
 * back online or a lap is about to go up. Everything that needs the server watches the answer (`watchOnlineConfig`)
 * rather than asking once.
 */

import { ACCOUNT_PROVIDERS, type AccountProvider } from "@/lib/account/api-types";
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
  /** The anonymous usage counter takes reports (src/lib/net/usage.ts) */
  usage: boolean;
  /** The live count takes heartbeats from tabs with the game in view (src/lib/net/live-heartbeat.ts) */
  live: boolean;
  /** Player accounts (src/lib/account): sign-in and the cloud save */
  accounts: boolean;
  /** The ways into an account this server offers (Discord and Google only once set up); [] while accounts are off */
  accountProviders: readonly AccountProvider[];
}

const OFF: OnlineConfig = {
  rooms: false,
  relay: false,
  races: false,
  board: false,
  raceSlotS: DEFAULT_RACE_SLOT_S,
  usage: false,
  live: false,
  accounts: false,
  accountProviders: [],
};

/** One read of the switches gives up after this long (ms): as long as every other read of the API is given */
export const CONFIG_TIMEOUT_MS = 8000;
/** A good answer is kept this long (ms) */
export const CONFIG_KEEP_MS = 10 * 60_000;
/**
 * After a failed read: the first retry (ms), the longest the wait grows to, and how far each wait is spread either way
 * (a share of it), so tabs that lost the server at the same moment don't all come back at the same moment
 */
export const CONFIG_RETRY_FIRST_MS = 5_000;
export const CONFIG_RETRY_MAX_MS = 60_000;
export const CONFIG_RETRY_SPREAD = 0.2;
/** No two reads closer than this (ms), whatever asks: the retry timer, the browser back online, a lap to post */
export const CONFIG_MIN_GAP_MS = 3_000;

/**
 * The wait (ms) before the next read after `failures` failed ones in a row: 5 s, 10 s, 20 s, 40 s, then a minute,
 * each spread ±20 % (`random` in [0, 1))
 */
export function configRetryDelayMs(failures: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(Number.isFinite(failures) ? failures : 1));
  const base = Math.min(CONFIG_RETRY_MAX_MS, CONFIG_RETRY_FIRST_MS * 2 ** Math.min(n - 1, 30));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(base * (1 - CONFIG_RETRY_SPREAD + 2 * CONFIG_RETRY_SPREAD * r));
}

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
  // A path ("/api") is on the page's own site; a full URL stands as it is
  const base = onlineApiBase.startsWith("/")
    ? `${pageOrigin ?? (typeof window !== "undefined" ? window.location.origin : "")}${onlineApiBase}`
    : onlineApiBase;
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
    usage: r.usage === true,
    live: r.live === true,
    accounts: r.accounts === true,
    accountProviders: r.accounts === true ? parseAccountProviders(r.accountProviders) : [],
  };
}

/** The providers named in the answer that this build knows, each once, in the order the server gave them */
function parseAccountProviders(raw: unknown): AccountProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: AccountProvider[] = [];
  for (const p of raw) if (ACCOUNT_PROVIDERS.includes(p as AccountProvider) && !out.includes(p as AccountProvider)) out.push(p as AccountProvider);
  return out;
}

/** The answer of GET <base>/config: an object that says whether the board is on (anything else is no answer) */
function isConfigAnswer(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).board === "boolean";
}

const sameConfig = (a: OnlineConfig, b: OnlineConfig): boolean =>
  (Object.keys(OFF) as (keyof OnlineConfig)[]).every((k) =>
    // The one list compares by its members: every answer parses to a new array
    k === "accountProviders" ? a[k].join() === b[k].join() : a[k] === b[k]
  );

/**
 * Whether the online side answered:
 *   ok           it did, and `config` is what it said
 *   unreachable  it didn't (no network, a timeout, an error page): tried again with backoff
 *   none         this build has no online side: everything off for good
 */
export type OnlineReach = "ok" | "unreachable" | "none";

export interface OnlineState {
  /** The switches: the server's last answer (kept while it is out of reach), all off before it has given one */
  config: OnlineConfig;
  reach: OnlineReach;
}

/** The lap board as the game treats it: on, turned off (by the server or the build), or not reached yet */
export type BoardState = "on" | "off" | "unreachable";

export function boardStateOf(s: OnlineState): BoardState {
  if (s.config.board) return "on";
  return s.reach === "unreachable" ? "unreachable" : "off";
}

/** What a config source runs on: the browser's clock and network, or a test's fakes */
export interface ConfigSourceEnv {
  /** GET <base>/config; null without an online side */
  url: string | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  /** In [0, 1): spreads the retries */
  random: () => number;
  /** The page is hidden, or the browser knows it is offline: a timed retry waits until `wake` */
  idle: () => boolean;
  /** Called when the first watcher comes and when the last one goes (the browser's online and visibility events) */
  onWatching?: (watched: boolean) => void;
}

export interface ConfigSource {
  /**
   * The switches as the server has them now: a good answer is kept 10 minutes; after a failed read the last known
   * state is given until the next retry is due. `fresh`: when the last read failed, try now (a lap is about to go up,
   * a room to open), unless the last try was under CONFIG_MIN_GAP_MS ago
   */
  read(opts?: { fresh?: boolean }): Promise<OnlineState>;
  /** The state as last known, without asking; null before the first answer */
  peek(): OnlineState | null;
  /**
   * Calls `listener` with the state now (when known) and again whenever it changes. While anything watches, a failed
   * read is retried on a timer. Returns the way to stop watching
   */
  watch(listener: (state: OnlineState) => void): () => void;
  /**
   * A request to the server got no answer: it is out of reach until a read of the switches says otherwise. The wait
   * before that read grows with each such request in a row (a good read of the switches doesn't reset it, an answered
   * request does), so uploads that never get through while the switches do are not sent every few seconds
   */
  markUnreachable(): void;
  /** A request to the server got an answer (any answer): the requests-in-a-row count starts again */
  markAnswered(): void;
  /** The browser came back online (`now`), or the page into view: a retry goes out if one is due (or at once with `now`) */
  wake(opts?: { now?: boolean }): void;
}

export function createConfigSource(env: ConfigSourceEnv): ConfigSource {
  const NONE: OnlineState = { config: OFF, reach: "none" };
  let state: OnlineState | null = env.url ? null : NONE;
  /** The server's last answer, kept while it is out of reach (its switches seldom change) */
  let lastGood: OnlineConfig | null = null;
  /** When the state was settled, when the last read went out, and when the next retry is due (ms) */
  let settledAt = 0;
  let triedAt = Number.NEGATIVE_INFINITY;
  let retryAt = 0;
  let failures = 0;
  /** Requests in a row that got no answer (`markUnreachable`), until one gets an answer (`markAnswered`) */
  let strikes = 0;
  let pending: Promise<OnlineState> | null = null;
  let timer: unknown = null;
  const watchers = new Set<(state: OnlineState) => void>();

  const schedule = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
    if (state?.reach !== "unreachable" || watchers.size === 0 || pending) return;
    timer = env.setTimer(() => {
      timer = null;
      // Hidden or offline: nothing goes out until the page is back in view or online (`wake`)
      if (!env.idle()) void attempt();
    }, Math.max(0, retryAt - env.now()));
  };

  const settle = (next: OnlineState) => {
    const changed = state === null || state.reach !== next.reach || !sameConfig(state.config, next.config);
    state = next;
    settledAt = env.now();
    if (next.reach === "unreachable") retryAt = settledAt + configRetryDelayMs(failures, env.random);
    schedule();
    if (changed) for (const listener of [...watchers]) listener(next);
  };

  const attempt = (): Promise<OnlineState> => {
    const url = env.url;
    if (!url) return Promise.resolve(NONE);
    pending ??= (async () => {
      triedAt = env.now();
      let next: OnlineState;
      try {
        const res = await env.fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) });
        const body: unknown = res.ok ? await res.json() : null;
        if (!isConfigAnswer(body)) throw new Error("No config in the answer");
        lastGood = parseOnlineConfig(body);
        failures = 0;
        next = { config: lastGood, reach: "ok" };
      } catch {
        failures++;
        next = { config: lastGood ?? OFF, reach: "unreachable" };
      }
      pending = null;
      settle(next);
      return next;
    })();
    return pending;
  };

  const read = (opts: { fresh?: boolean } = {}): Promise<OnlineState> => {
    if (!env.url) return Promise.resolve(NONE);
    if (pending) return pending;
    if (state) {
      const now = env.now();
      if (state.reach === "ok" && now - settledAt < CONFIG_KEEP_MS) return Promise.resolve(state);
      const due = now >= retryAt || (opts.fresh === true && now - triedAt >= CONFIG_MIN_GAP_MS);
      if (state.reach === "unreachable" && !due) return Promise.resolve(state);
    }
    return attempt();
  };

  return {
    read,
    peek: () => state,
    watch(listener) {
      watchers.add(listener);
      if (watchers.size === 1) env.onWatching?.(true);
      if (state) listener(state);
      // A missing or stale answer is read now; a change reaches every watcher, this one included
      void read();
      schedule();
      return () => {
        if (!watchers.delete(listener) || watchers.size > 0) return;
        schedule();
        env.onWatching?.(false);
      };
    },
    markUnreachable() {
      strikes++;
      if (!env.url || pending || state?.reach === "unreachable") return;
      failures = Math.max(failures + 1, strikes);
      triedAt = env.now();
      settle({ config: lastGood ?? OFF, reach: "unreachable" });
    },
    markAnswered() {
      strikes = 0;
    },
    wake(opts = {}) {
      if (!env.url || pending || state?.reach !== "unreachable" || env.idle()) return;
      const now = env.now();
      if (now - triedAt < CONFIG_MIN_GAP_MS) return;
      if (opts.now === true || now >= retryAt) void attempt();
    },
  };
}

/** The page's one source: the browser's clock and network, woken by its online and visibility events */
const source: ConfigSource = createConfigSource({
  url: onlineUrl("/config"),
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  random: Math.random,
  idle: () =>
    typeof document !== "undefined" && (document.visibilityState === "hidden" || (typeof navigator !== "undefined" && navigator.onLine === false)),
  onWatching: (watched) => {
    if (typeof window === "undefined") return;
    if (watched) {
      window.addEventListener("online", onBackOnline);
      document.addEventListener("visibilitychange", onShown);
    } else {
      window.removeEventListener("online", onBackOnline);
      document.removeEventListener("visibilitychange", onShown);
    }
  },
});
function onBackOnline(): void {
  source.wake({ now: true });
}
function onShown(): void {
  if (document.visibilityState === "visible") source.wake();
}

/** The switches as the server has them now (see `ConfigSource.read`); all off while it has never answered */
export function getOnlineConfig(opts?: { fresh?: boolean }): Promise<OnlineConfig> {
  return source.read(opts).then((s) => s.config);
}

/** The switches and whether the server answered (see `ConfigSource.read`) */
export function readOnlineConfig(opts?: { fresh?: boolean }): Promise<OnlineState> {
  return source.read(opts);
}

/** Follows the switches as they change (see `ConfigSource.watch`); returns the way to stop */
export function watchOnlineConfig(listener: (state: OnlineState) => void): () => void {
  return source.watch(listener);
}

/** A request to the API got no answer: the game treats the server as out of reach and starts retrying */
export function markOnlineUnreachable(): void {
  source.markUnreachable();
}

/** A request to the API got an answer: requests that got none are counted afresh (see `ConfigSource.markUnreachable`) */
export function markOnlineAnswered(): void {
  source.markAnswered();
}
