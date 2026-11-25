import { encodeLcrReplay, decodeLcrReplay } from "./replay-format";
import type {
  ReplayBookmark,
  ReplayRecordingPayload,
  StoredReplaySummary,
} from "./replay-types";

const DB_NAME = "bugesera-replays";
const DB_VERSION = 1;
const SUMMARY_STORE = "summaries";
const PAYLOAD_STORE = "payloads";

export interface ReplaySaveResult {
  ok: boolean;
  summary?: StoredReplaySummary;
  error?: "unavailable" | "quota" | "corrupt" | "unknown";
}

interface StoredPayloadRecord {
  id: string;
  bytes: ArrayBuffer;
}

const listeners = new Set<() => void>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function notifyChanged(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function subscribeReplays(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function resetReplayDbForTest(): void {
  dbPromise = null;
}

function openReplayDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
          db.createObjectStore(SUMMARY_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(PAYLOAD_STORE)) {
          db.createObjectStore(PAYLOAD_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
      req.onblocked = () => resolve(null);
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });
  return dbPromise;
}

export function buildSummaryFromPayload(payload: ReplayRecordingPayload, byteSize: number): StoredReplaySummary {
  const m = payload.metadata;
  return {
    id: m.id,
    name: m.name,
    recordedAt: m.recordedAt,
    trackId: m.trackId,
    trackName: m.trackName,
    ...(m.layoutId ? { layoutId: m.layoutId } : {}),
    vehicle: m.vehicle,
    vehicleClass: m.vehicleClass,
    raceKind: m.raceKind,
    durationS: m.durationS,
    frameCount: m.frameCount,
    participantCount: m.participantCount,
    physicsVersion: m.physicsVersion,
    lapPhysicsVersion: m.lapPhysicsVersion,
    weatherCondition: m.weather.condition,
    ...(m.trackPreview ? { trackPreview: m.trackPreview } : {}),
    eventCount: payload.events.length,
    bookmarkCount: payload.bookmarks.length,
    byteSize,
  };
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

export async function saveReplayRecording(payload: ReplayRecordingPayload): Promise<ReplaySaveResult> {
  const db = await openReplayDb();
  if (!db) return { ok: false, error: "unavailable" };

  let encoded: Uint8Array;
  try {
    encoded = await encodeLcrReplay(payload);
  } catch {
    return { ok: false, error: "corrupt" };
  }

  const copyBuf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(copyBuf).set(encoded);
  const summary = buildSummaryFromPayload(payload, encoded.byteLength);

  return new Promise<ReplaySaveResult>((resolve) => {
    try {
      const tx = db.transaction([SUMMARY_STORE, PAYLOAD_STORE], "readwrite");
      tx.objectStore(SUMMARY_STORE).put(summary);
      tx.objectStore(PAYLOAD_STORE).put({ id: summary.id, bytes: copyBuf } satisfies StoredPayloadRecord);
      tx.oncomplete = () => {
        notifyChanged();
        resolve({ ok: true, summary });
      };
      tx.onabort = () => {
        resolve({ ok: false, error: isQuotaError(tx.error) ? "quota" : "unknown" });
      };
      tx.onerror = () => {
        resolve({ ok: false, error: isQuotaError(tx.error) ? "quota" : "unknown" });
      };
    } catch (err) {
      resolve({ ok: false, error: isQuotaError(err) ? "quota" : "unknown" });
    }
  });
}

export async function listSavedReplays(): Promise<StoredReplaySummary[]> {
  const db = await openReplayDb();
  if (!db) return [];
  return new Promise<StoredReplaySummary[]>((resolve) => {
    try {
      const tx = db.transaction(SUMMARY_STORE, "readonly");
      const req = tx.objectStore(SUMMARY_STORE).getAll();
      tx.oncomplete = () => {
        const items = (req.result as StoredReplaySummary[] | undefined) ?? [];
        items.sort((a, b) => b.recordedAt - a.recordedAt);
        resolve(items);
      };
      tx.onabort = () => resolve([]);
      tx.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function loadSavedReplay(id: string): Promise<ReplayRecordingPayload | null> {
  const db = await openReplayDb();
  if (!db) return null;
  const record = await new Promise<StoredPayloadRecord | null>((resolve) => {
    try {
      const tx = db.transaction(PAYLOAD_STORE, "readonly");
      const req = tx.objectStore(PAYLOAD_STORE).get(id);
      tx.oncomplete = () => resolve((req.result as StoredPayloadRecord | undefined) ?? null);
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (!record?.bytes) return null;
  try {
    return await decodeLcrReplay(record.bytes);
  } catch {
    return null;
  }
}

export async function loadSavedReplayBytes(id: string): Promise<Uint8Array | null> {
  const db = await openReplayDb();
  if (!db) return null;
  const record = await new Promise<StoredPayloadRecord | null>((resolve) => {
    try {
      const tx = db.transaction(PAYLOAD_STORE, "readonly");
      const req = tx.objectStore(PAYLOAD_STORE).get(id);
      tx.oncomplete = () => resolve((req.result as StoredPayloadRecord | undefined) ?? null);
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return record?.bytes ? new Uint8Array(record.bytes) : null;
}

export async function renameSavedReplay(id: string, nextName: string): Promise<boolean> {
  const trimmed = nextName.trim().slice(0, 120);
  if (!trimmed) return false;
  const payload = await loadSavedReplay(id);
  if (!payload) return false;
  payload.metadata.name = trimmed;
  const res = await saveReplayRecording(payload);
  return res.ok;
}

export async function updateSavedReplayBookmarks(id: string, bookmarks: ReplayBookmark[]): Promise<boolean> {
  const payload = await loadSavedReplay(id);
  if (!payload) return false;
  payload.bookmarks = bookmarks;
  const res = await saveReplayRecording(payload);
  return res.ok;
}

export async function deleteSavedReplay(id: string): Promise<boolean> {
  const db = await openReplayDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction([SUMMARY_STORE, PAYLOAD_STORE], "readwrite");
      tx.objectStore(SUMMARY_STORE).delete(id);
      tx.objectStore(PAYLOAD_STORE).delete(id);
      tx.oncomplete = () => {
        notifyChanged();
        resolve(true);
      };
      tx.onabort = () => resolve(false);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function importLcrFileToStore(fileBytes: ArrayBuffer | Uint8Array): Promise<ReplaySaveResult> {
  let payload: ReplayRecordingPayload;
  try {
    payload = await decodeLcrReplay(fileBytes);
  } catch {
    return { ok: false, error: "corrupt" };
  }
  // Ensure imported replay gets a unique ID if one already exists
  const existing = await listSavedReplays();
  if (existing.some((s) => s.id === payload.metadata.id)) {
    payload.metadata.id = `${payload.metadata.id}-${Date.now().toString(36)}`;
  }
  return saveReplayRecording(payload);
}
