"use client";

/**
 * Online board position for each personal best listed in the circuit browser's detail panel (#172).
 *
 * A named `GET /api/laps` read is no-store and runs a 6-statement D1 batch, so ranks are only fetched when the detail
 * panel is showing a circuit, only for its listed current-physics PB cars (at most 4), and cached in memory for the
 * session keyed by circuit, car, board revision (`lapPhysicsVersion`) and driver name. Setting a new PB there drops
 * that entry immediately; offline, unnamed, local-only or failed reads stay quiet and show nothing.
 */
import { useEffect, useState } from "react";
import type { VehicleModelId } from "@/types/f1";
import { lapPhysicsVersion } from "@/lib/sim/lap-types";
import { driverNameKey, fetchBoardPage, formatCount, type BoardPage } from "@/lib/net/board-client";

/** Where the player stands on the car's current open online board for a circuit */
export interface CircuitBoardRank {
  /** Place in the board's order (matches the Lap times board's row and banner) */
  pos: number;
  /** Tied rank (1 + drivers strictly faster) */
  rank: number;
  /** Drivers on that board */
  total: number;
  /** The lap time (ms) currently held on the online board for this driver */
  lapTimeMs: number;
}

/** One row of the circuit browser detail panel's personal-best list */
export interface DetailPbEntry {
  vehicle: VehicleModelId;
  lapTimeMs: number;
  legacyPhysics: boolean;
}

/** At most 4 PB rows in the detail panel, always keeping the currently selected car when it has a PB */
export function selectDetailPbs(circuitPbs: readonly DetailPbEntry[], vehicleModel?: VehicleModelId): DetailPbEntry[] {
  const top = circuitPbs.slice(0, 4);
  if (vehicleModel && !top.some((e) => e.vehicle === vehicleModel)) {
    const mine = circuitPbs.find((e) => e.vehicle === vehicleModel);
    if (mine) top.splice(3, 1, mine);
  }
  return top;
}

/** "P12 of 340": matches the Lap times board's position wording */
export function formatCircuitBoardRank(r: Pick<CircuitBoardRank, "pos" | "total">): string {
  return `P${formatCount(r.pos)} of ${formatCount(r.total)}`;
}

/** Session cache key: circuit, car, board revision (`lapPhysicsVersion`), and normalized driver name */
export function circuitBoardRankKey(trackId: string, vehicle: VehicleModelId, physics: number, nameKey: string): string {
  return `${trackId}|${vehicle}|${physics}|${nameKey}`;
}

type FetchRankPage = (
  trackId: string,
  vehicle: VehicleModelId,
  opts: { physics: number; name: string; limit: number },
) => Promise<BoardPage | null>;

export interface CircuitBoardRankStoreDeps {
  fetchPage?: FetchRankPage;
  isOnline?: () => boolean;
  physicsOf?: (vehicle: VehicleModelId, trackId: string) => number;
}

interface CacheEntry {
  /** Null when the board answered and this driver has no lap on it (local-only PB) */
  result: CircuitBoardRank | null;
  /** Local PB time (ms) when this entry was read: a new PB changes it and drops the entry */
  pbMs: number;
  /** Board upload version when read: lets a subsequent upload refresh unposted or older online entries */
  boardVersion: number;
}

interface InFlightEntry {
  pbMs: number;
  boardVersion: number;
  promise: Promise<CircuitBoardRank | null | undefined>;
}

export type PeekRankResult = { hit: true; value: CircuitBoardRank | null } | { hit: false };

export interface CircuitBoardRankStore {
  /** Pure cache read for rendering; never mutates or starts a request */
  peek(
    trackId: string,
    vehicle: VehicleModelId,
    driverName: string | undefined,
    pbMs: number,
    boardVersion?: number,
  ): PeekRankResult;
  /** Drops a cached entry if the local PB changed or a newer upload may have superseded it */
  pruneStale(
    trackId: string,
    vehicle: VehicleModelId,
    driverName: string | undefined,
    pbMs: number,
    boardVersion?: number,
  ): void;
  /**
   * Returns the player's online board rank for `(trackId, vehicle)` on the default current board (unfiltered,
   * `lapPhysicsVersion`). Resolves to `null` when the player is not on the board (cached), or `undefined` when
   * skipped (no driver name / offline) or failed (not cached).
   */
  load(
    trackId: string,
    vehicle: VehicleModelId,
    driverName: string | undefined,
    pbMs: number,
    boardVersion?: number,
  ): Promise<CircuitBoardRank | null | undefined>;
  /** Drops cached ranks for a circuit and car (optionally one specific board revision) */
  invalidate(trackId: string, vehicle: VehicleModelId, physics?: number): void;
  /** Drops the whole session cache (for tests) */
  clear(): void;
}

const browserIsOnline = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;

const isStale = (entry: CacheEntry, pbMs: number, boardVersion: number): boolean =>
  entry.pbMs !== pbMs || (boardVersion !== entry.boardVersion && (entry.result === null || entry.result.lapTimeMs > pbMs));

/** In-memory session store for circuit-detail board ranks (factory exported so tests can inject fakes) */
export function createCircuitBoardRankStore(deps: CircuitBoardRankStoreDeps = {}): CircuitBoardRankStore {
  const fetchPage: FetchRankPage = deps.fetchPage ?? ((track, car, opts) => fetchBoardPage(track, car, opts));
  const isOnline = deps.isOnline ?? browserIsOnline;
  const physicsOf = deps.physicsOf ?? ((vehicle: VehicleModelId, trackId: string) => lapPhysicsVersion(vehicle, trackId));

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlightEntry>();
  const generations = new Map<string, number>();

  const bumpGen = (key: string): number => {
    const next = (generations.get(key) ?? 0) + 1;
    generations.set(key, next);
    return next;
  };

  const peek: CircuitBoardRankStore["peek"] = (trackId, vehicle, driverName, pbMs, boardVersion = 0) => {
    const nameKey = driverNameKey(driverName ?? "");
    if (!nameKey) return { hit: false };
    const physics = physicsOf(vehicle, trackId);
    const key = circuitBoardRankKey(trackId, vehicle, physics, nameKey);
    const entry = cache.get(key);
    if (!entry || isStale(entry, pbMs, boardVersion)) return { hit: false };
    return { hit: true, value: entry.result };
  };

  const pruneStale: CircuitBoardRankStore["pruneStale"] = (trackId, vehicle, driverName, pbMs, boardVersion = 0) => {
    const nameKey = driverNameKey(driverName ?? "");
    if (!nameKey) return;
    const physics = physicsOf(vehicle, trackId);
    const key = circuitBoardRankKey(trackId, vehicle, physics, nameKey);
    const entry = cache.get(key);
    if (entry && isStale(entry, pbMs, boardVersion)) {
      cache.delete(key);
      bumpGen(key);
    }
  };

  const load: CircuitBoardRankStore["load"] = (trackId, vehicle, driverName, pbMs, boardVersion = 0) => {
    const trimmed = driverName?.trim() ?? "";
    const nameKey = driverNameKey(trimmed);
    if (!nameKey) return Promise.resolve(undefined);
    const physics = physicsOf(vehicle, trackId);
    const key = circuitBoardRankKey(trackId, vehicle, physics, nameKey);
    const existing = cache.get(key);
    if (existing) {
      if (!isStale(existing, pbMs, boardVersion)) return Promise.resolve(existing.result);
      cache.delete(key);
      bumpGen(key);
    }
    if (!isOnline()) return Promise.resolve(undefined);

    const running = inFlight.get(key);
    if (running && running.pbMs === pbMs && running.boardVersion === boardVersion) return running.promise;

    const gen = bumpGen(key);
    let raw: Promise<BoardPage | null>;
    try {
      raw = fetchPage(trackId, vehicle, { physics, name: trimmed, limit: 1 });
    } catch {
      raw = Promise.resolve(null);
    }
    const promise: Promise<CircuitBoardRank | null | undefined> = raw
      .catch(() => null)
      .then((page) => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
        if (!page) return undefined;
        const result: CircuitBoardRank | null = page.me
          ? {
              pos: page.me.pos,
              rank: page.me.rank,
              total: Math.max(page.total, page.me.pos),
              lapTimeMs: page.me.entry.lapTimeMs,
            }
          : null;
        if ((generations.get(key) ?? 0) === gen) {
          cache.set(key, { result, pbMs, boardVersion });
        }
        return result;
      });
    inFlight.set(key, { pbMs, boardVersion, promise });
    return promise;
  };

  const invalidate: CircuitBoardRankStore["invalidate"] = (trackId, vehicle, physics) => {
    const prefix = physics !== undefined ? `${trackId}|${vehicle}|${physics}|` : `${trackId}|${vehicle}|`;
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
        bumpGen(key);
      }
    }
    for (const key of [...inFlight.keys()]) {
      if (key.startsWith(prefix)) {
        inFlight.delete(key);
        bumpGen(key);
      }
    }
  };

  const clear: CircuitBoardRankStore["clear"] = () => {
    for (const key of [...inFlight.keys()]) bumpGen(key);
    cache.clear();
    inFlight.clear();
  };

  return { peek, pruneStale, load, invalidate, clear };
}

const defaultStore = createCircuitBoardRankStore();

/** Drops cached board rank(s) for a circuit and car (e.g. after setting a new personal best there) */
export function invalidateCircuitBoardRank(trackId: string, vehicle: VehicleModelId, physics?: number): void {
  defaultStore.invalidate(trackId, vehicle, physics);
}

/** Brief settle delay before uncached fetches so rapid keyboard/D-pad scrubbing across cards skips D1 reads */
const FETCH_DEBOUNCE_MS = 120;

/**
 * Fetches and caches the player's online board position for each listed current-physics PB in the detail panel.
 * Returns a map of `vehicle -> CircuitBoardRank` containing only confirmed board positions (never errors).
 */
export function useCircuitBoardRanks(
  trackId: string,
  entries: readonly DetailPbEntry[],
  driverName: string | undefined,
  boardVersion = 0,
): Readonly<Partial<Record<VehicleModelId, CircuitBoardRank>>> {
  const [, setTick] = useState(0);
  const [online, setOnline] = useState(() => browserIsOnline());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setOnline(browserIsOnline());
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const name = driverName?.trim() ?? "";
  const nameKey = driverNameKey(name);
  const eligible = entries.filter((e) => !e.legacyPhysics);
  const entriesKey = eligible.map((e) => `${e.vehicle}:${e.lapTimeMs}`).join("|");

  // Synchronous read from the session cache avoids any flash when revisiting a circuit
  const ranks: Partial<Record<VehicleModelId, CircuitBoardRank>> = {};
  if (nameKey) {
    for (const e of eligible) {
      const hit = defaultStore.peek(trackId, e.vehicle, name, e.lapTimeMs, boardVersion);
      if (hit.hit && hit.value) ranks[e.vehicle] = hit.value;
    }
  }

  useEffect(() => {
    if (!nameKey || !entriesKey) return;
    const items = entriesKey.split("|").map((part) => {
      const sep = part.lastIndexOf(":");
      return { vehicle: part.slice(0, sep) as VehicleModelId, lapTimeMs: Number(part.slice(sep + 1)) };
    });
    const misses: { vehicle: VehicleModelId; lapTimeMs: number }[] = [];
    for (const item of items) {
      defaultStore.pruneStale(trackId, item.vehicle, name, item.lapTimeMs, boardVersion);
      if (!defaultStore.peek(trackId, item.vehicle, name, item.lapTimeMs, boardVersion).hit) {
        misses.push(item);
      }
    }
    if (misses.length === 0 || !online) return;

    let alive = true;
    const timer = setTimeout(() => {
      for (const item of misses) {
        void defaultStore.load(trackId, item.vehicle, name, item.lapTimeMs, boardVersion).then((res) => {
          if (alive && res) setTick((n) => n + 1);
        });
      }
    }, FETCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trackId, entriesKey, name, nameKey, boardVersion, online]);

  return ranks;
}
