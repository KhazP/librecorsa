/**
 * Browser storage for lap ghosts: personal bests in IndexedDB, plus .json ghost files
 * exported to and imported from the user's disk. Every call degrades to null / false / []
 * when storage is unavailable (SSR, private windows, blocked site data).
 */
import { foldVehicleModelId, isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { validateLapRecording } from "@/lib/sim/lap-recorder";
import { lapBoardClass, lapPhysicsVersion, type LapRecording } from "@/lib/sim/lap-types";

const DB_NAME = "bugesera-laps";
const DB_VERSION = 1;
const STORE_NAME = "bestLaps";
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const BROADCAST_CHANNEL = "librecorsa-best-laps";
const STORAGE_PING_KEY = "librecorsa.bestLapsUpdatedAt";

export interface BestLapSummary {
  trackId: string;
  vehicle: VehicleModelId;
  lapTimeMs: number;
  physicsVersion?: number;
  recordedAt: number;
}

export interface CircuitBestLap {
  lapTimeMs: number;
  vehicle: VehicleModelId;
  /** True when the lap was driven in the player's currently selected car model */
  forCurrentCar: boolean;
  /** True when only laps from an older physics/circuit board revision exist */
  legacyPhysics: boolean;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let summariesCache: BestLapSummary[] | null = null;
const lapListeners = new Set<() => void>();
let crossTabChannel: BroadcastChannel | null = null;
let crossTabSubscribed = false;

function notifyBestLapsChanged(broadcast = true): void {
  summariesCache = null;
  for (const cb of lapListeners) {
    try {
      cb();
    } catch {
      // Ignore subscriber errors
    }
  }
  if (!broadcast || typeof window === "undefined") return;
  try {
    crossTabChannel ??= typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BROADCAST_CHANNEL) : null;
    crossTabChannel?.postMessage(Date.now());
  } catch {
    // BroadcastChannel unavailable
  }
  try {
    localStorage.setItem(STORAGE_PING_KEY, String(Date.now()));
  } catch {
    // Storage unavailable
  }
}

function ensureCrossTabSubscription(): void {
  if (crossTabSubscribed || typeof window === "undefined") return;
  crossTabSubscribed = true;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      crossTabChannel ??= new BroadcastChannel(BROADCAST_CHANNEL);
      crossTabChannel.addEventListener("message", () => notifyBestLapsChanged(false));
    }
  } catch {
    // Ignore
  }
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_PING_KEY) notifyBestLapsChanged(false);
  });
}

/** Subscribes to local PB saves/deletes (including across open tabs, e.g. /play -> /) */
export function subscribeBestLaps(listener: () => void): () => void {
  ensureCrossTabSubscription();
  lapListeners.add(listener);
  return () => {
    lapListeners.delete(listener);
  };
}

/**
 * Store key of a personal best: one per circuit, car and board class (assists, realism, surface, physics revision),
 * as the online boards split them, so an assisted lap never replaces the pro best. Laps saved before the split (no
 * conditions) keep the old circuit|car key.
 */
function lapKey(trackId: string, vehicle: VehicleModelId, board: string | null = null): string {
  return board ? `${trackId}|${vehicle}|${board}` : `${trackId}|${vehicle}`;
}

const boardOf = (lap: LapRecording): string | null => (lap.conditions ? lapBoardClass(lap.conditions) : null);

/** Opens the lap database once; resolves null when IndexedDB is unavailable */
function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        if (typeof indexedDB === "undefined") {
          resolve(null);
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) {
            req.result.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // Another tab changed the schema: close and reopen on next use
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    }).then((db) => {
      // A failed open is not cached: a transient error (or storage freed later) gets another try on the next call
      if (!db) dbPromise = null;
      return db;
    });
  }
  return dbPromise;
}

/** Runs one request in its own transaction; resolves null on any failure */
function runRequest<T>(
  mode: IDBTransactionMode,
  build: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE_NAME, mode);
          const req = build(tx.objectStore(STORE_NAME));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/**
 * Personal-best lap for a circuit and car on a board class, or null. Without a class (or with no lap on it yet) a
 * best saved before boards were split is used, being of unknown class.
 */
export async function loadBestLap(trackId: string, vehicle: VehicleModelId, board: string | null = null): Promise<LapRecording | null> {
  const read = async (key: string) => {
    const raw = await runRequest("readonly", (store) => store.get(key));
    if (raw === null || raw === undefined) return null;
    const lap = validateLapRecording(raw);
    return lap && lap.trackId === trackId && lap.vehicle === vehicle ? lap : null;
  };
  // A best saved before the 2026 Prototype was renamed sits under its old id
  const old = vehicle === "lc26" ? ("vf26" as VehicleModelId) : null; // keep-old-id
  if (board) {
    const lap = (await read(lapKey(trackId, vehicle, board))) ?? (old ? await read(lapKey(trackId, old, board)) : null);
    if (lap) return lap;
  }
  const legacy = (await read(lapKey(trackId, vehicle))) ?? (old ? await read(lapKey(trackId, old)) : null);
  return legacy && (!board || boardOf(legacy) === null || boardOf(legacy) === board) ? legacy : null;
}

/** Stores the lap if it is faster than the stored one (or none is stored); resolves true when stored */
export async function saveBestLapIfFaster(rec: LapRecording): Promise<boolean> {
  const lap = validateLapRecording(rec);
  if (!lap) return false;
  const db = await openDb();
  if (!db) return false;
  const key = lapKey(lap.trackId, lap.vehicle, boardOf(lap));
  // A best saved before the 2026 Prototype was renamed counts too: a slower first lap under the new id must not hide it
  const oldKey = lap.vehicle === "lc26" ? lapKey(lap.trackId, "vf26" as VehicleModelId, boardOf(lap)) : null; // keep-old-id
  return new Promise<boolean>((resolve) => {
    try {
      // Read and write in one transaction so two laps cannot race each other
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      let stored = false;
      const current = store.get(key);
      const put = () => {
        store.put(lap, key);
        stored = true;
      };
      current.onsuccess = () => {
        const best = validateLapRecording(current.result ?? null);
        if (best && best.lapTimeMs <= lap.lapTimeMs) return;
        if (!oldKey) return put();
        const prior = store.get(oldKey);
        prior.onsuccess = () => {
          const older = validateLapRecording(prior.result ?? null);
          if (older && older.lapTimeMs <= lap.lapTimeMs) return;
          put();
        };
      };
      tx.oncomplete = () => {
        if (stored) notifyBestLapsChanged();
        resolve(stored);
      };
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Lightweight extraction of summary metadata from a raw stored record without scanning ghost sample floats */
export function extractBestLapSummary(raw: unknown): BestLapSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.trackId !== "string" || !r.trackId) return null;
  const vehicle = foldVehicleModelId(r.vehicle);
  if (!isVehicleModelId(vehicle)) return null;
  if (typeof r.lapTimeMs !== "number" || !Number.isFinite(r.lapTimeMs) || r.lapTimeMs <= 0) return null;
  const cond = r.conditions && typeof r.conditions === "object" ? (r.conditions as Record<string, unknown>) : null;
  const pv = cond && typeof cond.physicsVersion === "number" && Number.isFinite(cond.physicsVersion) ? cond.physicsVersion : undefined;
  const recordedAt = typeof r.recordedAt === "number" && Number.isFinite(r.recordedAt) ? r.recordedAt : 0;
  return {
    trackId: r.trackId,
    vehicle,
    lapTimeMs: r.lapTimeMs,
    ...(pv !== undefined ? { physicsVersion: pv } : {}),
    recordedAt,
  };
}

/** Fast cached summary list of every stored personal best, fastest first (skips deep ghost sample validation) */
export async function listBestLapSummaries(): Promise<readonly BestLapSummary[]> {
  if (summariesCache) return summariesCache;
  const all = await runRequest<unknown[]>("readonly", (store) => store.getAll());
  if (!all) return [];
  const out: BestLapSummary[] = [];
  for (const raw of all) {
    const s = extractBestLapSummary(raw);
    if (s) out.push(s);
  }
  out.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
  summariesCache = out;
  return out;
}

/**
 * Picks the headline personal best for a circuit:
 *   1. Current physics revision + currently selected car (fastest across assist/weather boards)
 *   2. Current physics revision + any car (fallback, flagged `forCurrentCar: false` so UI shows its car tag)
 *   3. Older physics revision + currently selected car
 *   4. Older physics revision + any car
 */
export function bestLapForCircuit(
  summaries: readonly BestLapSummary[],
  trackId: string,
  preferredVehicle?: VehicleModelId | null,
): CircuitBestLap | null {
  let curSame: BestLapSummary | null = null;
  let curAny: BestLapSummary | null = null;
  let oldSame: BestLapSummary | null = null;
  let oldAny: BestLapSummary | null = null;

  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    if (s.trackId !== trackId) continue;
    const isCurrentPhysics = s.physicsVersion !== undefined && s.physicsVersion === lapPhysicsVersion(s.vehicle, trackId);
    const sameCar = preferredVehicle != null && s.vehicle === preferredVehicle;
    if (isCurrentPhysics) {
      if (sameCar && (!curSame || s.lapTimeMs < curSame.lapTimeMs)) curSame = s;
      if (!curAny || s.lapTimeMs < curAny.lapTimeMs) curAny = s;
    } else {
      if (sameCar && (!oldSame || s.lapTimeMs < oldSame.lapTimeMs)) oldSame = s;
      if (!oldAny || s.lapTimeMs < oldAny.lapTimeMs) oldAny = s;
    }
  }

  if (curSame) return { lapTimeMs: curSame.lapTimeMs, vehicle: curSame.vehicle, forCurrentCar: true, legacyPhysics: false };
  if (curAny) return { lapTimeMs: curAny.lapTimeMs, vehicle: curAny.vehicle, forCurrentCar: false, legacyPhysics: false };
  if (oldSame) return { lapTimeMs: oldSame.lapTimeMs, vehicle: oldSame.vehicle, forCurrentCar: true, legacyPhysics: true };
  if (oldAny) return { lapTimeMs: oldAny.lapTimeMs, vehicle: oldAny.vehicle, forCurrentCar: false, legacyPhysics: true };
  return null;
}

/** Fastest personal best per vehicle for a circuit (current physics preferred per car), fastest first */
export function bestLapsByVehicleForCircuit(
  summaries: readonly BestLapSummary[],
  trackId: string,
): { vehicle: VehicleModelId; lapTimeMs: number; legacyPhysics: boolean }[] {
  const byVehicle = new Map<VehicleModelId, { lapTimeMs: number; legacyPhysics: boolean }>();
  for (const s of summaries) {
    if (s.trackId !== trackId) continue;
    const legacy = s.physicsVersion === undefined || s.physicsVersion !== lapPhysicsVersion(s.vehicle, trackId);
    const prev = byVehicle.get(s.vehicle);
    if (!prev || (prev.legacyPhysics && !legacy) || (prev.legacyPhysics === legacy && s.lapTimeMs < prev.lapTimeMs)) {
      byVehicle.set(s.vehicle, { lapTimeMs: s.lapTimeMs, legacyPhysics: legacy });
    }
  }
  return [...byVehicle.entries()]
    .map(([vehicle, v]) => ({ vehicle, ...v }))
    .sort((a, b) => Number(a.legacyPhysics) - Number(b.legacyPhysics) || a.lapTimeMs - b.lapTimeMs);
}

/** Every stored personal best (for the local leaderboard), fastest first */
export async function listBestLaps(): Promise<LapRecording[]> {
  const all = await runRequest<unknown[]>("readonly", (store) => store.getAll());
  if (!all) return [];
  const laps: LapRecording[] = [];
  for (const raw of all) {
    const lap = validateLapRecording(raw);
    if (lap) laps.push(lap);
  }
  return laps.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
}

/** Removes the stored personal best for a circuit and car (on one board class; without one, the unsplit best) */
export async function deleteBestLap(trackId: string, vehicle: VehicleModelId, board: string | null = null): Promise<void> {
  await runRequest("readwrite", (store) => store.delete(lapKey(trackId, vehicle, board)));
  notifyBestLapsChanged();
}

/** m.ss.mmm, e.g. 1.23.456 for 83456 ms */
function formatLapFileTime(ms: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${minutes}.${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Downloads the lap as a .json ghost file (anchor + Blob URL, revoked afterwards). File name: `ghost-<trackId>-<vehicle>-<m.ss.mmm>.json` */
export function exportLapFile(rec: LapRecording): void {
  try {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-");
    const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ghost-${safe(rec.trackId)}-${safe(rec.vehicle)}-${formatLapFileTime(rec.lapTimeMs)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // Downloads blocked or unavailable: nothing to do
  }
}

/** Reads a user-chosen file (max 5 MB) and validates it with validateLapRecording; resolves null when invalid */
export async function importLapFile(file: File): Promise<LapRecording | null> {
  try {
    if (file.size > MAX_IMPORT_BYTES) return null;
    const text = await file.text();
    return validateLapRecording(JSON.parse(text));
  } catch {
    return null;
  }
}
