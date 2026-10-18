/**
 * Browser storage for lap ghosts: personal bests in IndexedDB, plus .json ghost files
 * exported to and imported from the user's disk. Every call degrades to null / false / []
 * when storage is unavailable (SSR, private windows, blocked site data).
 */
import type { VehicleModelId } from "@/types/f1";
import { validateLapRecording } from "@/lib/sim/lap-recorder";
import type { LapRecording } from "@/lib/sim/lap-types";

const DB_NAME = "bugesera-laps";
const DB_VERSION = 1;
const STORE_NAME = "bestLaps";
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function lapKey(trackId: string, vehicle: VehicleModelId): string {
  return `${trackId}|${vehicle}`;
}

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

/** Personal-best lap for a circuit and car, or null */
export async function loadBestLap(trackId: string, vehicle: VehicleModelId): Promise<LapRecording | null> {
  const raw = await runRequest("readonly", (store) => store.get(lapKey(trackId, vehicle)));
  if (raw === null || raw === undefined) return null;
  const lap = validateLapRecording(raw);
  return lap && lap.trackId === trackId && lap.vehicle === vehicle ? lap : null;
}

/** Stores the lap if it is faster than the stored one (or none is stored); resolves true when stored */
export async function saveBestLapIfFaster(rec: LapRecording): Promise<boolean> {
  const lap = validateLapRecording(rec);
  if (!lap) return false;
  const db = await openDb();
  if (!db) return false;
  const key = lapKey(lap.trackId, lap.vehicle);
  return new Promise<boolean>((resolve) => {
    try {
      // Read and write in one transaction so two laps cannot race each other
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      let stored = false;
      const current = store.get(key);
      current.onsuccess = () => {
        const best = validateLapRecording(current.result ?? null);
        if (best && best.lapTimeMs <= lap.lapTimeMs) return;
        store.put(lap, key);
        stored = true;
      };
      tx.oncomplete = () => resolve(stored);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
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

/** Removes the stored personal best for a circuit and car */
export async function deleteBestLap(trackId: string, vehicle: VehicleModelId): Promise<void> {
  await runRequest("readwrite", (store) => store.delete(lapKey(trackId, vehicle)));
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
