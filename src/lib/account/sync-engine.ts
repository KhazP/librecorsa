/**
 * The cloud save's sync: this device's save against the account's, whenever the account store asks (on start, at the
 * game's save points, when the page is hidden, every few minutes while something changed). One sync:
 *   1. read this device's save (save-model.ts `collect`), the best laps' ghosts hashed with SHA-256
 *   2. read the cloud's, with any saves of folded accounts waiting to be combined (`pending`)
 *   3. combine them (`combineSaves`; on this device's first sync with the account, the first-sync rules)
 *   4. send the ghosts the cloud lacks (`ghosts/missing`, then a PUT each)
 *   5. write the result if it differs from the cloud's; a 409 means another device wrote first: combine again with
 *      what the cloud has now and send again, up to MAX_TRIES
 *   6. write the result into this device's storage (`apply`), or leave that for the next start when the running game
 *      can't take it now (the store decides), and fetch the ghosts this device lacks through the game's own save path
 * When the page is hidden or going away (`leaving`) there is no time for steps 2 and 4: a read of the cloud's save
 * would not come back before the page is gone, so the write after it would never go out. The sync then starts from
 * the cloud's save as this page last read or wrote it, sends no ghosts, and writes with keepalive in one request; if
 * another device wrote since, the write is refused (409) and the next sync does it properly.
 * Everything it needs comes in through SyncEnv, so the verify suite runs it against a fake server.
 */
import { MAX_GHOST_BYTES, MAX_SAVE_BYTES, ghostsOf, type CloudBestLap, type Fail, type SaveAnswer, type SaveDoc } from "./api-types";
import type { AccountApi } from "./account-api";
import type { FirstSyncChoice, SaveSummary } from "./account-store";
import {
  SYNC_STATE_KEY,
  apply,
  collect,
  combineSaves,
  contentHash,
  differsLocally,
  dropsOf,
  emptySyncState,
  firstSyncDecision,
  localHash,
  nextBase,
  parseSyncState,
  readSaveDoc,
  rememberFetched,
  summarizeSave,
  type AccountSyncRecord,
  type StorageLike,
  type SyncState,
} from "./save-model";

/** A personal best as this device stores it, without its recording */
export interface LocalBestLap {
  /** Its IndexedDB key ("<track>|<car>|<board>") */
  key: string;
  trackId: string;
  vehicle: string;
  lapTimeMs: number;
  recordedAt: number;
}

/** This device's personal bests (ghost-store.ts in the browser) */
export interface LocalGhosts {
  list(): Promise<LocalBestLap[]>;
  /** The JSON text of the recording under `key`, as it goes up; null when there is none */
  text(key: string): Promise<string | null>;
  /** Keeps a downloaded recording through the game's own save path; true when it was kept (new or faster) */
  save(text: string): Promise<boolean>;
}

export interface SyncEnv {
  api: AccountApi;
  /** localStorage; null when the browser blocks it */
  storage: StorageLike | null;
  /** null where there is no IndexedDB: best laps then stay out of the sync */
  ghosts: LocalGhosts | null;
  /** SHA-256 of a text as hex; null without Web Crypto (ghosts then stay out of the sync) */
  sha256: ((text: string) => Promise<string>) | null;
  now(): number;
  /** This device's label ("Chrome on macOS"), written into the save as its writer */
  label(): string;
}

export interface SyncRequest {
  accountId: string;
  /**
   * Write the result into this device's storage now (the store reloads the page when that changed something). A
   * function is asked at the last moment, after the network work: whether the running game can still be reloaded
   */
  apply: boolean | (() => boolean);
  /** The first-sync screen's answer */
  choice?: FirstSyncChoice;
  /**
   * The page is hidden or going away: the save goes up in one keepalive request, from the cloud's save as this page
   * last saw it (no read first, no ghosts), best effort
   */
  leaving?: boolean;
}

export type SyncOutcome =
  | {
      kind: "synced";
      rev: number;
      at: number;
      /** A new save went up */
      pushed: boolean;
      /** This device's storage was written: the running game should load it again */
      changedLocal: boolean;
      /** The cloud has values this device didn't take on yet (not applied): they come in at the next start */
      deferred: boolean;
    }
  /** This device's first sync with the account, and both sides hold a save: the player chooses */
  | { kind: "ask"; local: SaveSummary; cloud: SaveSummary }
  | { kind: "failed"; error: string; signedOut?: boolean };

/** Writes tried before a sync gives up on devices writing over each other */
export const MAX_TRIES = 3;
/** Ghosts fetched in one sync at most; the rest come with the next */
const MAX_DOWNLOADS = 60;
/** Hashes asked about in one ghosts/missing call */
const MISSING_BATCH = 100;

export const NO_STORAGE = "This browser does not let the game keep a save, so it can't sync.";
export const NEWER_SAVE = "Your cloud save was made by a newer version of the game. Reload the page to update it.";
export const TOO_BIG = "Your save is too big to sync.";
export const BUSY = "Another device was saving at the same time. The game tries again shortly.";

const failed = (f: Fail | { error: string; signedOut?: boolean }): SyncOutcome => ({
  kind: "failed",
  error: f.error,
  ...(f.signedOut ? { signedOut: true } : {}),
});

const byteLength = (text: string) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length);

export interface SyncEngine {
  sync(req: SyncRequest): Promise<SyncOutcome>;
  /** Notes change times without syncing (signed out, so a later first sync knows what changed when) */
  track(): void;
  /** This device's last sync with the account; null before the first */
  record(accountId: string): AccountSyncRecord | null;
  /** Something in this device's save changed since its last sync with the account (no network) */
  changedSince(accountId: string): Promise<boolean>;
  /** Drops the record of an account (deleted): a sign-in to it again would be a first sync */
  forget(accountId: string): void;
  /**
   * Reads the cloud's save without syncing, so a sync on leaving can start from it: for a page that had nothing to
   * sync on start (it is kept only when it is the save this device last synced with)
   */
  prime(accountId: string): Promise<void>;
}

export function createSyncEngine(env: SyncEnv): SyncEngine {
  /** The cloud's save as this page last read or wrote it, at its rev: where a sync on leaving starts */
  let lastCloud: { accountId: string; rev: number; doc: SaveDoc } | null = null;

  const loadState = (): SyncState => {
    try {
      return parseSyncState(env.storage?.getItem(SYNC_STATE_KEY) ?? null);
    } catch {
      return emptySyncState();
    }
  };
  const saveState = (state: SyncState): void => {
    try {
      env.storage?.setItem(SYNC_STATE_KEY, JSON.stringify(state));
    } catch {
      // Full or blocked: the change times start again next time, which reads as "not known"
    }
  };

  /**
   * This device's best laps, each with its ghost's SHA-256: from the cache while its time and date are the same, else
   * hashed from its recording (`hash` false: only the cached ones, for a quick check)
   */
  async function readLaps(state: SyncState, hash: boolean) {
    const out = { list: [] as LocalBestLap[], bestLaps: {} as Record<string, CloudBestLap>, ghosts: {} as SyncState["ghosts"] };
    if (!env.ghosts) return out;
    try {
      out.list = await env.ghosts.list();
    } catch {
      return out;
    }
    for (const lap of out.list) {
      const cached = state.ghosts[lap.key];
      let sha = cached && cached.ms === lap.lapTimeMs && cached.at === lap.recordedAt ? cached.sha : null;
      if (!sha && hash && env.sha256) {
        const text = await env.ghosts.text(lap.key).catch(() => null);
        if (text) sha = await env.sha256(text).catch(() => null);
      }
      if (!sha) continue;
      out.ghosts[lap.key] = { ms: lap.lapTimeMs, at: lap.recordedAt, sha };
      out.bestLaps[lap.key] = { trackId: lap.trackId, vehicle: lap.vehicle, lapTimeMs: lap.lapTimeMs, recordedAt: lap.recordedAt, ghost: sha };
    }
    return out;
  }

  /** This device's save now, the sync state with its change times, and the hash `changedSince` compares */
  async function readLocal(storage: StorageLike, state: SyncState, hash: boolean) {
    const laps = await readLaps(state, hash);
    const ghosts = hash ? laps.ghosts : { ...state.ghosts, ...laps.ghosts };
    const got = collect(storage, { ...state, ghosts }, { now: env.now(), savedBy: env.label(), bestLaps: laps.bestLaps });
    const times = Object.fromEntries(laps.list.map((l) => [l.key, l.lapTimeMs]));
    return { doc: got.doc, state: got.state, hash: localHash(got.doc, times) };
  }

  /**
   * Sends the ghosts of this device's laps in `doc` that the cloud lacks. A ghost that can't go up (too big, the
   * account's limit, its recording gone) leaves its lap out of the save, or the cloud's lap for that key in.
   */
  async function sendGhosts(doc: SaveDoc, local: SaveDoc, cloud: SaveDoc | null, state: SyncState): Promise<SaveDoc | Fail> {
    const keyOf = new Map<string, string>();
    for (const [key, lap] of Object.entries(doc.bestLaps)) if (local.bestLaps[key]?.ghost === lap.ghost) keyOf.set(lap.ghost, key);
    if (!keyOf.size) return doc;
    const shas = [...keyOf.keys()];
    const missing: string[] = [];
    for (let i = 0; i < shas.length; i += MISSING_BATCH) {
      const ans = await env.api.missingGhosts(shas.slice(i, i + MISSING_BATCH));
      if (!ans.ok) return ans;
      missing.push(...ans.missing.filter((s) => keyOf.has(s)));
    }
    const dropped = new Set<string>();
    for (const sha of missing) {
      const key = keyOf.get(sha) as string;
      const text = env.ghosts ? await env.ghosts.text(key).catch(() => null) : null;
      const same = text !== null && env.sha256 !== null && (await env.sha256(text).catch(() => null)) === sha;
      if (!same || byteLength(text) > MAX_GHOST_BYTES) {
        // The recording changed under its cached hash: hashed again next time
        delete state.ghosts[key];
        dropped.add(sha);
        continue;
      }
      const put = await env.api.putGhost(sha, text);
      if (put.ok) continue;
      if (put.signedOut) return put;
      dropped.add(sha);
    }
    if (!dropped.size) return doc;
    const bestLaps = { ...doc.bestLaps };
    for (const [key, lap] of Object.entries(bestLaps)) {
      if (!dropped.has(lap.ghost)) continue;
      const theirs = cloud?.bestLaps[key];
      if (theirs) bestLaps[key] = theirs;
      else delete bestLaps[key];
    }
    return { ...doc, bestLaps };
  }

  /**
   * Leaving, with no time to send ghosts: a lap of this device's whose ghost the cloud doesn't hold stays as the cloud
   * has it (or out of the save). `behind`: one was held back, to go up with the next sync
   */
  function withCloudGhosts(doc: SaveDoc, cloud: SaveDoc | null): { doc: SaveDoc; behind: boolean } {
    const known = new Set(cloud ? ghostsOf(cloud) : []);
    const bestLaps = { ...doc.bestLaps };
    let behind = false;
    for (const [key, lap] of Object.entries(bestLaps)) {
      if (known.has(lap.ghost)) continue;
      behind = true;
      const theirs = cloud?.bestLaps[key];
      if (theirs) bestLaps[key] = theirs;
      else delete bestLaps[key];
    }
    return { doc: behind ? { ...doc, bestLaps } : doc, behind };
  }

  /** Fetches the cloud's ghosts this device lacks or has a slower lap for, and keeps them through the game's save path */
  async function fetchGhosts(result: SaveDoc, local: SaveDoc, fetched: string[]): Promise<string[]> {
    if (!env.ghosts || !env.sha256) return fetched;
    const got: string[] = [];
    for (const [key, lap] of Object.entries(result.bestLaps)) {
      const mine = local.bestLaps[key];
      if (mine && (mine.ghost === lap.ghost || mine.lapTimeMs <= lap.lapTimeMs)) continue;
      if (fetched.includes(lap.ghost) || got.includes(lap.ghost)) continue;
      if (got.length >= MAX_DOWNLOADS) break;
      const text = await env.api.getGhost(lap.ghost);
      // Not there (yet): asked for again next time
      if (text === null) continue;
      if ((await env.sha256(text).catch(() => null)) === lap.ghost) await env.ghosts.save(text).catch(() => false);
      // Kept, slower than what is here, or not what was asked for: either way not fetched again
      got.push(lap.ghost);
    }
    return rememberFetched(fetched, got);
  }

  async function sync(req: SyncRequest): Promise<SyncOutcome> {
    const storage = env.storage;
    if (!storage) return failed({ error: NO_STORAGE });
    let state = loadState();
    const mine = await readLocal(storage, state, true);
    state = mine.state;
    saveState(state);
    const local = mine.doc;
    const rec = state.account?.id === req.accountId ? state.account : null;

    // Leaving: the cloud's save as this page last saw it, when no other sync (another tab) has moved on from it since
    const quick = req.leaving && lastCloud?.accountId === req.accountId && rec?.rev === lastCloud.rev ? lastCloud : null;
    const got: SaveAnswer = quick ? { ok: true, rev: quick.rev, updatedAt: null, doc: quick.doc, pending: [] } : await env.api.getSave();
    if (!got.ok) return failed(got);
    let cloud = got.doc === null ? null : readSaveDoc(got.doc);
    if (got.doc !== null && !cloud) return failed({ error: NEWER_SAVE });
    let rev = got.rev;
    // A folded account's save this build can't read stays waiting for one that can
    const pending: { id: number; doc: SaveDoc }[] = [];
    for (const p of got.pending ?? []) {
      const doc = readSaveDoc(p.doc);
      if (doc) pending.push({ id: p.id, doc });
    }

    let choice: FirstSyncChoice = "combine";
    if (!rec) {
      if (req.choice) choice = req.choice;
      else {
        const decision = firstSyncDecision(local, cloud);
        if (decision === "ask") return { kind: "ask", local: summarizeSave(local, "local"), cloud: summarizeSave(cloud, "cloud") };
        choice = decision === "upload" ? "local" : "cloud";
      }
    }
    const base = rec?.base ?? null;

    let result: SaveDoc = local;
    let pushed = false;
    /** Laps of this device's held back from the save (leaving): the next sync sends them */
    let behind = false;
    for (let tries = 1; ; tries++) {
      let next = cloud ? combineSaves(local, cloud, choice, { base }) : local;
      // A folded account's save joins without a question, combined value by value; the account's own save wins its ties
      for (const p of pending) next = combineSaves(p.doc, next, "combine");
      next = { ...next, savedAt: env.now(), savedBy: env.label() };
      if (quick && tries === 1) {
        const held = withCloudGhosts(next, cloud);
        behind = held.behind;
        result = held.doc;
      } else {
        const sent = await sendGhosts(next, local, cloud, state);
        if ("ok" in sent) return failed(sent);
        behind = false;
        result = sent;
      }
      if (cloud && !pending.length && contentHash(result) === contentHash(cloud)) break;
      if (byteLength(JSON.stringify(result)) > MAX_SAVE_BYTES) return failed({ error: TOO_BIG });
      const put = await env.api.putSave({ baseRev: rev, doc: result, combinedPending: pending.map((p) => p.id) }, { keepalive: req.leaving === true });
      if (put.ok) {
        rev = put.rev;
        pushed = true;
        break;
      }
      if (!put.conflict || tries >= MAX_TRIES) return failed(put.conflict ? { error: BUSY } : put);
      // Another device wrote first: what it wrote is the cloud's save now
      cloud = put.doc == null ? null : readSaveDoc(put.doc);
      if (put.doc != null && !cloud) return failed({ error: NEWER_SAVE });
      rev = put.rev ?? rev;
    }

    lastCloud = { accountId: req.accountId, rev, doc: pushed || !cloud ? result : cloud };
    // Ghosts first: they go in through ghost-store, which the running game follows, so they need no reload (none on
    // the way out: the next sync fetches them)
    const fetched = quick ? (rec?.fetched ?? []) : await fetchGhosts(result, local, rec?.fetched ?? []);
    // The values last, so a reload for them can follow at once
    const applied = typeof req.apply === "function" ? req.apply() : req.apply;
    let changedLocal = false;
    if (applied) {
      // Keys the result leaves out go too (Use the cloud save, or another device's Keep this device's save)
      const done = apply(storage, result, state, dropsOf(local, result));
      state = done.state;
      changedLocal = done.changed;
    }
    const deferred = !applied && differsLocally(local, result);
    // The laps just fetched and the values just written are this device's now: what later changes are measured from
    const after = await readLocal(storage, state, false);
    state = after.state;
    const at = env.now();
    state.account = {
      id: req.accountId,
      rev,
      appliedRev: applied || !deferred ? rev : (rec?.appliedRev ?? 0),
      base: nextBase(result, local, applied, base),
      lastSyncedAt: at,
      // A lap held back reads as a change, so the next save point or check sends it
      localHash: behind ? "" : after.hash,
      fetched,
    };
    saveState(state);
    return { kind: "synced", rev, at, pushed, changedLocal, deferred };
  }

  return {
    sync,
    track() {
      if (!env.storage) return;
      saveState(collect(env.storage, loadState(), { now: env.now(), savedBy: env.label() }).state);
    },
    record(accountId) {
      const rec = loadState().account;
      return rec?.id === accountId ? rec : null;
    },
    async changedSince(accountId) {
      if (!env.storage) return false;
      const state = loadState();
      if (state.account?.id !== accountId) return false;
      const now = await readLocal(env.storage, state, false);
      saveState(now.state);
      return now.hash !== state.account.localHash;
    },
    async prime(accountId) {
      if (lastCloud?.accountId === accountId) return;
      const got = await env.api.getSave();
      const rec = loadState().account;
      if (!got.ok || got.doc === null || got.pending?.length || rec?.id !== accountId || rec.rev !== got.rev) return;
      const doc = readSaveDoc(got.doc);
      if (doc && lastCloud === null) lastCloud = { accountId, rev: got.rev, doc };
    },
    forget(accountId) {
      if (lastCloud?.accountId === accountId) lastCloud = null;
      const state = loadState();
      if (state.account?.id !== accountId) return;
      saveState({ ...state, account: null });
    },
  };
}

/** SHA-256 of a text's UTF-8 bytes, as hex (Web Crypto: the browser, and Node in the verify suite) */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The game's personal bests in IndexedDB (ghost-store.ts, loaded when first asked for) */
export function browserGhosts(): LocalGhosts {
  const store = () => import("@/lib/sim/ghost-store");
  return {
    async list() {
      const index = await (await store()).listBestLapIndex();
      return Object.entries(index).map(([key, s]) => ({ key, trackId: s.trackId, vehicle: s.vehicle, lapTimeMs: s.lapTimeMs, recordedAt: s.recordedAt }));
    },
    async text(key) {
      const lap = await (await store()).loadBestLapByKey(key);
      return lap ? JSON.stringify(lap) : null;
    },
    async save(text) {
      try {
        return await (await store()).saveBestLapIfFaster(JSON.parse(text));
      } catch {
        return false;
      }
    },
  };
}
