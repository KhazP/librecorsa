/**
 * The game's side of player accounts: who is signed in, this device's join and first sync, and the actions the
 * account screens call. A small store outside React (`getAccountState` / `subscribeAccount`) with a hook over it.
 *
 * CONTRACT FILE: the exported names and types below are what the account UI (src/components/account) builds on.
 * Keep every export and its signature.
 *
 * Nothing happens until `start()` (the play shell calls it on mount), and nothing at all without an online side,
 * while /api/config says accounts are off, or on the server. When the cloud save brings values the running game holds
 * in memory (settings, setups, liveries), the page reloads once to use them: right after the first-sync choice, or
 * when a sync on start comes back within RELOAD_WINDOW_MS (still on the loading screen or the title) or while the
 * loading screen is still up (a slow device can take longer than that to load a circuit). Later syncs only send: what
 * they bring waits for the next start, so a drive is never cut short.
 */
import { useSyncExternalStore } from "react";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
  normaliseLinkCode,
  type AccountInfo,
  type AccountProvider,
  type AuthResult,
  type PasskeyMode,
  type SignInIntent,
  type SignInProvider,
} from "./api-types";
import { createAccountApi, type AccountApi } from "./account-api";
import { AUTH_NOTICES, deviceLabelFor, readAuthReturn, type Notice } from "./account-text";
import { RELOAD_MARK_KEY, SETTINGS_KEY } from "./save-model";
import { browserGhosts, createSyncEngine, sha256Hex, type SyncEngine } from "./sync-engine";
import { onlineApiBase, watchOnlineConfig } from "@/lib/net/online-config";
import { getOrCreateDriverKey } from "@/lib/net/driver-key";
import { isStoreBuild } from "@/lib/store-mode";

export type AccountPhase =
  /** No online side, or ONLINE_ACCOUNTS is off: nothing about accounts is shown */
  | "off"
  /** Reading the config and the session */
  | "loading"
  | "signed-out"
  | "signed-in";

/** What one side of a first sync holds, for the choice screen */
export interface SaveSummary {
  bestLaps: number;
  /** Saved setups (presets) over every car */
  setups: number;
  races: number;
  /** When it was last written; null for this device */
  savedAt: number | null;
  /** The device that wrote it (cloud), or null */
  savedBy: string | null;
}

export type FirstSyncChoice = "combine" | "cloud" | "local";

export interface SyncStatus {
  status: "idle" | "syncing" | "error";
  /** When this device last pushed or pulled successfully (ms) */
  lastSyncedAt: number | null;
  /** The last failure, for the player */
  error: string | null;
}

export interface AccountState {
  phase: AccountPhase;
  /** The ways in this server offers (Discord and Google only once set up); [] while off */
  providers: readonly AccountProvider[];
  /** Signed in: the account as the server last described it */
  account: AccountInfo | null;
  /**
   * Signed in, but this device hasn't joined the account yet: ask "Join the account of <driverName>?" before any of
   * this device's names or save go up. Declining signs this device out again.
   */
  join: { driverName: string | null; providers: readonly AccountProvider[] } | null;
  /** This device and the cloud both hold a save: ask Combine (default) / Use the cloud save / Keep this device's */
  firstSync: { local: SaveSummary; cloud: SaveSummary } | null;
  /** After joining: names this device's key holds that are on another account */
  elsewhere: readonly string[];
  sync: SyncStatus;
  /** What the last sign-in redirect or action said, for a toast; cleared by dismissNotice */
  notice: { kind: "ok" | "error"; text: string } | null;
}

const INITIAL: AccountState = {
  phase: "off",
  providers: [],
  account: null,
  join: null,
  firstSync: null,
  elsewhere: [],
  sync: { status: "idle", lastSyncedAt: null, error: null },
  notice: null,
};

const NOT_READY = "Accounts are not available yet";

/** Every action resolves null when it worked, else a sentence for the player */
export interface AccountActions {
  /** Reads the switches and the session, and handles a `#lc-account=` sign-in return; safe to call more than once */
  start(): void;
  /** Goes to the provider's page (the browser leaves the game); `returnTo` is a path on this site ("/play") */
  signIn(provider: SignInProvider, intent?: SignInIntent, returnTo?: string): void;
  passkey(mode: PasskeyMode): Promise<string | null>;
  confirmJoin(): Promise<string | null>;
  declineJoin(): Promise<void>;
  chooseFirstSync(choice: FirstSyncChoice): Promise<string | null>;
  syncNow(): Promise<string | null>;
  createLinkCode(): Promise<{ code: string; expiresAt: number } | string>;
  previewLinkCode(code: string): Promise<{ driverName: string | null; providers: AccountProvider[] } | string>;
  redeemLinkCode(code: string): Promise<string | null>;
  removeSession(id: string): Promise<string | null>;
  removeKey(id: string): Promise<string | null>;
  removePasskey(id: string): Promise<string | null>;
  removeIdentity(provider: SignInProvider): Promise<string | null>;
  signOut(): Promise<void>;
  deleteAccount(removeLaps: boolean): Promise<string | null>;
  dismissNotice(): void;
  /** A natural save point (back to the menu, Settings closed): pushes the save after a short wait, when signed in */
  pushSoon(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// The store, over an environment (the browser's below; the verify suite's fakes)

/** A save point's push waits this long (ms), so a burst of save points sends once */
export const PUSH_DELAY_MS = 5_000;
/** While signed in, a check for changes this often (ms): what changed goes up even with no save point */
export const PERIODIC_MS = 3 * 60_000;
/** A sync started on page load may reload the page to use what it brought only this soon after start (ms) */
export const RELOAD_WINDOW_MS = 20_000;
/** Reading the session again after the server couldn't be reached: the first wait and the longest (ms) */
const RETRY_FIRST_MS = 15_000;
const RETRY_MAX_MS = 120_000;

const KEY_ELSEWHERE = "This device's driver key is on another account. Sign in to that account here too to combine the two.";
const BAD_CODE = "A code has 8 letters and digits, like ABCD-EFGH.";
const NO_PASSKEYS = "This browser can't use passkeys.";
const PASSKEY_NOT_USED = "The passkey was not used.";
const PASSKEY_KNOWN = "This passkey is already on an account.";
const PASSKEY_FAILED = "The passkey did not work. Try again.";
const DEFERRED = "Synced. Changes from your other devices load the next time the game starts.";
const CHOOSE_FIRST = "Choose what to keep first.";

export interface AccountStoreEnv {
  api: AccountApi;
  sync: SyncEngine;
  /** Follows /api/config: calls back with the accounts switch and the providers, now and on every change */
  watchConfig(cb: (config: { accounts: boolean; providers: readonly AccountProvider[] }) => void): () => void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  /** The page address's fragment ("#lc-account=signed-in"), and the way to replace it without a navigation ("" drops it) */
  readHash(): string;
  setHash(rest: string): void;
  navigate(url: string): void;
  reload(): void;
  /** sessionStorage, for the reload mark; null when blocked */
  session: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  deviceLabel(): string;
  driverKey(): string;
  /** The driver name in the settings, to name a new passkey on the device */
  driverName(): string | null;
  /** The page's path, where a provider's sign-in comes back to */
  returnPath(): string;
  /** The browser's passkey ceremony: registration for create / add, authentication for signin / link */
  passkey(mode: PasskeyMode, options: unknown): Promise<unknown>;
  /** Calls `cb` when the page is hidden (`leaving` false) or goes away (true); returns the way to stop */
  onLeave(cb: (leaving: boolean) => void): () => void;
  /** The game's loading screen is up: nothing is running that a reload would cut short */
  loadingScreen?(): boolean;
}

/** This driver key is the one the account says the session joined with (AccountKey.id: its SHA-256's first 12 hex) */
async function keyIsCurrent(driverKey: string, account: AccountInfo): Promise<boolean> {
  const current = account.keys.find((k) => k.current);
  if (!current) return false;
  try {
    return (await sha256Hex(driverKey)).slice(0, 12) === current.id;
  } catch {
    // No WebCrypto (an insecure page): keep the session as it is
    return true;
  }
}

/** A return path the server takes ("/play", "/account"); anything else goes back to /play */
export const safeReturnPath = (path: string): string => (/^\/[A-Za-z0-9/_-]*$/.test(path) && !path.startsWith("//") ? path : "/play");

/** The account's ways in, for "Join the account of <name> (<providers>)?" */
const providersOf = (a: AccountInfo): AccountProvider[] => [...a.identities.map((i) => i.provider), ...(a.passkeys.length ? (["passkey"] as const) : [])];

/** What a failed passkey ceremony says (SimpleWebAuthn passes the browser's DOMException names through) */
function passkeyError(err: unknown): string {
  const name = typeof err === "object" && err !== null ? String((err as { name?: unknown }).name ?? "") : "";
  if (name === "NotAllowedError" || name === "AbortError") return PASSKEY_NOT_USED;
  if (name === "InvalidStateError") return PASSKEY_KNOWN;
  return PASSKEY_FAILED;
}

export interface AccountStore {
  getState(): AccountState;
  subscribe(listener: () => void): () => void;
  actions: AccountActions;
}

/** A store over `makeEnv`, asked on `start()`: null (no online side, the server) keeps it off */
export function createAccountStore(makeEnv: () => AccountStoreEnv | null): AccountStore {
  let state: AccountState = INITIAL;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AccountState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };

  let env: AccountStoreEnv | null = null;
  let startedAt = 0;
  let accountsOn = false;
  /** This session has registered its driver key with the account */
  let joined = false;
  /** The sign-in return found on start, handled once accounts turn out to be on */
  let authReturn: ReturnType<typeof readAuthReturn> = null;
  let retryMs = RETRY_FIRST_MS;
  let retryTimer: unknown = null;
  let pushTimer: unknown = null;
  let periodicTimer: unknown = null;
  let stopLeave: (() => void) | null = null;
  /** Syncs run one at a time */
  let queue: Promise<unknown> = Promise.resolve();

  const notice = (n: Notice | null) => set({ notice: n });
  const clear = (id: unknown): null => {
    if (id !== null) env?.clearTimer(id);
    return null;
  };
  const stopTimers = () => {
    retryTimer = clear(retryTimer);
    pushTimer = clear(pushTimer);
    periodicTimer = clear(periodicTimer);
  };

  function toSignedOut(): void {
    joined = false;
    pushTimer = clear(pushTimer);
    periodicTimer = clear(periodicTimer);
    set({ phase: "signed-out", account: null, join: null, firstSync: null, elsewhere: [], sync: INITIAL.sync });
  }

  /** Signed in, joined, past the first sync and no question open: what's changed may go up */
  function ready(): AccountInfo | null {
    const account = state.account;
    if (!env || !accountsOn || state.phase !== "signed-in" || !account || !joined || state.join || state.firstSync) return null;
    return env.sync.record(account.id) ? account : null;
  }

  /** GET /api/account into the state; a signed-out answer signs this device out */
  async function refresh() {
    const e = env as AccountStoreEnv;
    const ans = await e.api.account();
    if (!accountsOn) return ans;
    if (ans.ok) {
      joined = ans.thisDevice.joined;
      const rec = e.sync.record(ans.account.id);
      set({
        phase: "signed-in",
        account: ans.account,
        join: joined ? null : { driverName: ans.account.driverName, providers: providersOf(ans.account) },
        sync: { ...state.sync, lastSyncedAt: state.sync.lastSyncedAt ?? rec?.lastSyncedAt ?? null },
      });
    } else if (ans.signedOut) toSignedOut();
    return ans;
  }

  /** Reloads the page once for the save just written (the mark stops a save that won't stick from looping) */
  function reloadFor(accountId: string, rev: number): void {
    const e = env as AccountStoreEnv;
    const mark = `${accountId}:${rev}`;
    try {
      if (!e.session || e.session.getItem(RELOAD_MARK_KEY) === mark) return;
      e.session.setItem(RELOAD_MARK_KEY, mark);
    } catch {
      // Without the mark a reload can't be told apart from a loop: not made, the save loads next time
      return;
    }
    e.reload();
  }

  function schedulePeriodic(): void {
    periodicTimer = clear(periodicTimer);
    if (!env) return;
    periodicTimer = env.setTimer(() => {
      periodicTimer = null;
      void pushIfChanged(false).finally(() => {
        if (ready()) schedulePeriodic();
      });
    }, PERIODIC_MS);
  }

  /**
   * One sync, after any running one. `apply`: write what it brings into storage (and reload for it); a function is
   * asked at that moment. `tellDeferred`: say so when what it brought waits for the next start
   */
  function runSync(opts: { apply: boolean | (() => boolean); choice?: FirstSyncChoice; leaving?: boolean; tellDeferred?: boolean }): Promise<string | null> {
    const job = queue.then(async (): Promise<string | null> => {
      const e = env;
      const account = state.account;
      if (!e || !accountsOn || state.phase !== "signed-in" || !account || !joined) return NOT_READY;
      // The first-sync question is open: nothing goes up until it is answered
      if (state.firstSync && !opts.choice) return CHOOSE_FIRST;
      set({ sync: { ...state.sync, status: "syncing", error: null } });
      const out = await e.sync.sync({ accountId: account.id, apply: opts.apply, choice: opts.choice, leaving: opts.leaving });
      // Signed out or into another account meanwhile: this answer is stale
      if (state.account?.id !== account.id) return null;
      if (out.kind === "failed") {
        if (out.signedOut) toSignedOut();
        else set({ sync: { ...state.sync, status: "error", error: out.error } });
        return out.error;
      }
      if (out.kind === "ask") {
        set({ firstSync: { local: out.local, cloud: out.cloud }, sync: { ...state.sync, status: "idle" } });
        return null;
      }
      set({ firstSync: null, sync: { status: "idle", lastSyncedAt: out.at, error: null } });
      schedulePeriodic();
      if (out.changedLocal) reloadFor(account.id, out.rev);
      else if (out.deferred && opts.tellDeferred) notice({ kind: "ok", text: DEFERRED });
      return null;
    });
    queue = job.catch(() => null);
    return job;
  }

  /** Sends this device's save when something in it changed since the last sync */
  async function pushIfChanged(leaving: boolean): Promise<void> {
    const account = ready();
    if (!account || !env) return;
    if (await env.sync.changedSince(account.id)) await runSync({ apply: false, leaving });
  }

  /** On start and after a sign-in: the account, the join question, then the first sync or a pull of what's newer */
  async function enter(): Promise<void> {
    const e = env as AccountStoreEnv;
    retryTimer = clear(retryTimer);
    const ans = await refresh();
    if (!ans.ok) {
      if (ans.signedOut) e.sync.track();
      else if (state.phase === "loading") {
        // Not reached: try again later, waiting longer each time
        retryTimer = e.setTimer(() => {
          retryTimer = null;
          if (accountsOn) void enter();
        }, retryMs);
        retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
      }
      return;
    }
    retryMs = RETRY_FIRST_MS;
    // Not joined: the UI asks first
    if (!joined) return;
    let account = ans.account;
    // The session's driver key is no longer this device's (saved data cleared, a key file imported): the session
    // was confirmed on this device already, so its key now joins without asking again
    if (!(await keyIsCurrent(e.driverKey(), account))) {
      const again = await e.api.joinDevice({ driverKey: e.driverKey(), label: e.deviceLabel() });
      if (!again.ok) {
        if (again.signedOut) toSignedOut();
        return;
      }
      const reread = await refresh();
      if (!reread.ok || !joined) return;
      account = reread.account;
    }
    const rec = e.sync.record(account.id);
    // This device's first sync with the account (or its record was cleared): the first-sync rules decide
    if (!rec) {
      await runSync({ apply: true });
      return;
    }
    // A slow device can still be loading the circuit long after the window: a reload there cuts nothing short, and
    // without it such a device would leave the cloud's changes for a next start that is just as slow, every time
    const withinWindow = () => e.now() - startedAt < RELOAD_WINDOW_MS || e.loadingScreen?.() === true;
    if ((account.save?.rev ?? 0) > rec.appliedRev || account.pendingMerges > 0) await runSync({ apply: withinWindow });
    else if (await e.sync.changedSince(account.id)) await runSync({ apply: false });
    else schedulePeriodic();
  }

  function onConfig(config: { accounts: boolean; providers: readonly AccountProvider[] }): void {
    if (!config.accounts) {
      accountsOn = false;
      stopTimers();
      stopLeave?.();
      stopLeave = null;
      joined = false;
      set({ phase: "off", providers: [], account: null, join: null, firstSync: null, elsewhere: [] });
      return;
    }
    const e = env as AccountStoreEnv;
    const was = accountsOn;
    accountsOn = true;
    set({ providers: config.providers });
    if (authReturn) {
      e.setHash(authReturn.rest);
      if (authReturn.result) notice(AUTH_NOTICES[authReturn.result]);
      authReturn = null;
    }
    if (was) return;
    set({ phase: "loading" });
    stopLeave = e.onLeave((leaving) => void pushIfChanged(leaving));
    void enter();
  }

  /** A sign-in that happened without a redirect: say so, then go on as after any sign-in */
  async function signedIn(result: AuthResult): Promise<null> {
    notice(AUTH_NOTICES[result]);
    await enter();
    return null;
  }

  /** A removal, then the account read again (removing this session signs this device out) */
  async function removeThen(call: (api: AccountApi) => Promise<{ ok: true } | { ok: false; error: string; signedOut?: true }>): Promise<string | null> {
    const e = env;
    if (!e || state.phase !== "signed-in") return NOT_READY;
    const ans = await call(e.api);
    if (!ans.ok) {
      if (ans.signedOut) toSignedOut();
      return ans.error;
    }
    await refresh();
    return null;
  }

  const actions: AccountActions = {
    start() {
      if (env) return;
      const e = makeEnv();
      if (!e) return;
      env = e;
      startedAt = e.now();
      authReturn = readAuthReturn(e.readHash());
      e.watchConfig(onConfig);
    },

    signIn(provider, intent = "signin", returnTo) {
      if (!env || !accountsOn) return;
      env.navigate(env.api.signInUrl(provider, intent, safeReturnPath(returnTo ?? env.returnPath())));
    },

    async passkey(mode) {
      const e = env;
      if (!e || !accountsOn) return NOT_READY;
      const naming = mode === "create" || mode === "add";
      const opts = await e.api.passkeyOptions({ mode, ...(naming ? { displayName: e.driverName() ?? "LibreCorsa driver" } : {}) });
      if (!opts.ok) return opts.error;
      let response: unknown;
      try {
        response = await e.passkey(mode, opts.options);
      } catch (err) {
        return err instanceof Error && err.message === NO_PASSKEYS ? NO_PASSKEYS : passkeyError(err);
      }
      const done = await e.api.passkeyVerify({ challengeId: opts.challengeId, response });
      if (!done.ok) return done.error;
      return signedIn(done.result);
    },

    async confirmJoin() {
      const e = env;
      if (!e || state.phase !== "signed-in" || !state.account) return NOT_READY;
      const ans = await e.api.joinDevice({ driverKey: e.driverKey(), label: e.deviceLabel() });
      if (!ans.ok) {
        if (ans.signedOut) toSignedOut();
        return ans.error;
      }
      joined = true;
      set({ join: null, elsewhere: ans.elsewhere });
      if (ans.keyElsewhere) notice({ kind: "error", text: KEY_ELSEWHERE });
      // The names this key brought, then the first sync
      await refresh();
      if (state.phase !== "signed-in") return null;
      return runSync({ apply: true });
    },

    async declineJoin() {
      await actions.signOut();
    },

    async chooseFirstSync(choice) {
      if (!state.firstSync) return NOT_READY;
      return runSync({ apply: true, choice });
    },

    async syncNow() {
      const e = env;
      const account = state.account;
      if (!e || !accountsOn || state.phase !== "signed-in" || !account || !joined) return NOT_READY;
      if (state.firstSync) return CHOOSE_FIRST;
      // Without a record this is the first sync, which may load what it brings; otherwise that waits for the next start
      return runSync(e.sync.record(account.id) ? { apply: false, tellDeferred: true } : { apply: true });
    },

    async createLinkCode() {
      if (!env || state.phase !== "signed-in") return NOT_READY;
      const ans = await env.api.createLinkCode();
      if (!ans.ok) {
        if (ans.signedOut) toSignedOut();
        return ans.error;
      }
      return { code: ans.code, expiresAt: ans.expiresAt };
    },

    async previewLinkCode(raw) {
      if (!env || !accountsOn) return NOT_READY;
      const code = normaliseLinkCode(raw);
      if (!code) return BAD_CODE;
      const ans = await env.api.previewLinkCode(code);
      return ans.ok ? { driverName: ans.driverName, providers: ans.providers } : ans.error;
    },

    async redeemLinkCode(raw) {
      if (!env || !accountsOn) return NOT_READY;
      const code = normaliseLinkCode(raw);
      if (!code) return BAD_CODE;
      const ans = await env.api.redeemLinkCode(code);
      if (!ans.ok) return ans.error;
      return signedIn(ans.result);
    },

    removeSession: (id) => removeThen((api) => api.removeSession(id)),
    removeKey: (id) => removeThen((api) => api.removeKey(id)),
    removePasskey: (id) => removeThen((api) => api.removePasskey(id)),
    removeIdentity: (provider) => removeThen((api) => api.removeIdentity(provider)),

    async signOut() {
      const e = env;
      if (!e || !accountsOn) return;
      const ans = await e.api.signOut();
      // Already signed out on the server is signed out here too
      if (ans.ok || ans.signedOut) toSignedOut();
      else notice({ kind: "error", text: ans.error });
    },

    async deleteAccount(removeLaps) {
      const e = env;
      const account = state.account;
      if (!e || state.phase !== "signed-in" || !account) return NOT_READY;
      const ans = await e.api.deleteAccount({ removeLaps, confirm: "delete" });
      if (!ans.ok) {
        if (ans.signedOut) toSignedOut();
        return ans.error;
      }
      e.sync.forget(account.id);
      toSignedOut();
      const laps = ans.removedLaps === 1 ? "1 lap came" : `${ans.removedLaps} laps came`;
      notice({ kind: "ok", text: removeLaps && ans.removedLaps > 0 ? `Your account is deleted. ${laps} off the boards.` : "Your account is deleted." });
      return null;
    },

    dismissNotice() {
      notice(null);
    },

    pushSoon() {
      const e = env;
      if (!e || !accountsOn) return;
      pushTimer = clear(pushTimer);
      pushTimer = e.setTimer(() => {
        pushTimer = null;
        // Signed out: only the change times, so a later first sync knows what changed when
        if (state.phase === "signed-out") e.sync.track();
        else void pushIfChanged(false);
      }, PUSH_DELAY_MS);
    },
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    actions,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The browser's store

function browserStorage(name: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

/** The browser's environment; null on the server and in a build without an online side */
function browserEnv(): AccountStoreEnv | null {
  if (typeof window === "undefined" || !onlineApiBase) return null;
  const api = createAccountApi({ base: onlineApiBase, fetch: (url, init) => fetch(url, init) });
  const deviceLabel = () => deviceLabelFor(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints ?? 0, storeBuild: isStoreBuild() });
  const storage = browserStorage("localStorage");
  const sync = createSyncEngine({
    api,
    storage,
    ghosts: typeof indexedDB === "undefined" ? null : browserGhosts(),
    sha256: typeof crypto !== "undefined" && crypto.subtle ? sha256Hex : null,
    now: () => Date.now(),
    label: deviceLabel,
  });
  return {
    api,
    sync,
    watchConfig: (cb) => watchOnlineConfig((s) => cb({ accounts: s.config.accounts, providers: s.config.accountProviders })),
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id as number),
    readHash: () => window.location.hash,
    setHash(rest) {
      const { pathname, search } = window.location;
      // The router's own history state is kept: Next.js reads it on back and forward
      window.history.replaceState(window.history.state, "", `${pathname}${search}${rest ? `#${rest}` : ""}`);
    },
    navigate: (url) => window.location.assign(url),
    reload: () => window.location.reload(),
    session: browserStorage("sessionStorage"),
    deviceLabel,
    driverKey: getOrCreateDriverKey,
    driverName() {
      try {
        const saved: unknown = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? "null");
        const name = (saved as { profile?: { name?: unknown } } | null)?.profile?.name;
        return typeof name === "string" && name ? name : null;
      } catch {
        return null;
      }
    },
    returnPath: () => window.location.pathname,
    async passkey(mode, options) {
      if (typeof PublicKeyCredential === "undefined") throw new Error(NO_PASSKEYS);
      const webauthn = await import("@simplewebauthn/browser");
      return mode === "create" || mode === "add"
        ? webauthn.startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON })
        : webauthn.startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
    },
    // LoadingScreen.tsx marks its root
    loadingScreen: () => document.querySelector("[data-loading-screen]") !== null,
    onLeave(cb) {
      const onVisibility = () => {
        if (document.visibilityState === "hidden") cb(false);
      };
      const onPageHide = () => cb(true);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
      };
    },
  };
}

const store = createAccountStore(browserEnv);

export function getAccountState(): AccountState {
  return store.getState();
}

export function subscribeAccount(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function useAccountState(): AccountState {
  return useSyncExternalStore(subscribeAccount, getAccountState, () => INITIAL);
}

export const accountActions: AccountActions = store.actions;
