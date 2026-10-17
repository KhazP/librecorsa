/**
 * Progress of the startup assets (track GLB, car GLB, shader warm-up) for the loading screen.
 * A tiny external store: the loaders report into it and React reads it with `useAssetProgress()`.
 */
import { useSyncExternalStore } from "react";

export type AssetTaskId = "track" | "car" | "shaders";
export type AssetTaskStatus = "pending" | "loading" | "done" | "failed";

export interface AssetTask {
  id: AssetTaskId;
  label: string;
  /** Share of the overall bar */
  weight: number;
  loadedBytes: number;
  totalBytes: number;
  status: AssetTaskStatus;
  /** performance.now() of the last progress event (stall detection) */
  lastProgressMs: number;
}

export interface AssetProgressSnapshot {
  tasks: readonly AssetTask[];
  /** Weighted 0..1 over all tasks (failed tasks count as complete) */
  progress: number;
  /** Every task is done or failed */
  settled: boolean;
  anyFailed: boolean;
}

/** Fallback sizes when the response carries no Content-Length (e.g. gzip on GitHub Pages) */
const KNOWN_BYTES: Record<AssetTaskId, number> = {
  track: 20_225_944,
  car: 15_297_076,
  shaders: 0,
};

const INITIAL: Record<AssetTaskId, Omit<AssetTask, "lastProgressMs">> = {
  track: { id: "track", label: "Circuit", weight: 0.55, loadedBytes: 0, totalBytes: KNOWN_BYTES.track, status: "pending" },
  car: { id: "car", label: "Car", weight: 0.35, loadedBytes: 0, totalBytes: KNOWN_BYTES.car, status: "pending" },
  shaders: { id: "shaders", label: "Shaders", weight: 0.1, loadedBytes: 0, totalBytes: 0, status: "pending" },
};

const ORDER: readonly AssetTaskId[] = ["track", "car", "shaders"];

const now = () => (typeof performance !== "undefined" ? performance.now() : 0);

let tasks: Record<AssetTaskId, AssetTask> = Object.fromEntries(
  ORDER.map((id) => [id, { ...INITIAL[id], lastProgressMs: 0 }])
) as Record<AssetTaskId, AssetTask>;

function buildSnapshot(): AssetProgressSnapshot {
  const list = ORDER.map((id) => tasks[id]);
  let progress = 0;
  for (const t of list) {
    const frac =
      t.status === "done" || t.status === "failed"
        ? 1
        : t.totalBytes > 0
          ? Math.min(1, t.loadedBytes / t.totalBytes)
          : 0;
    progress += t.weight * frac;
  }
  return {
    tasks: list,
    progress: Math.min(1, progress),
    settled: list.every((t) => t.status === "done" || t.status === "failed"),
    anyFailed: list.some((t) => t.status === "failed"),
  };
}

let snapshot = buildSnapshot();
const listeners = new Set<() => void>();

function update(id: AssetTaskId, patch: Partial<AssetTask>) {
  const prev = tasks[id];
  // A finished task stays finished (a second loader call, e.g. React StrictMode, reuses the cache)
  if ((prev.status === "done" || prev.status === "failed") && patch.status === "loading") return;
  tasks = { ...tasks, [id]: { ...prev, ...patch } };
  snapshot = buildSnapshot();
  for (const l of listeners) l();
}

export const assetProgress = {
  begin(id: AssetTaskId) {
    update(id, { status: "loading", lastProgressMs: now() });
  },
  /** Byte progress from a loader's ProgressEvent */
  progress(id: AssetTaskId, event: { loaded: number; total: number; lengthComputable?: boolean }) {
    if (tasks[id].status !== "loading") return;
    const total = event.lengthComputable !== false && event.total > 0 ? event.total : KNOWN_BYTES[id];
    update(id, { loadedBytes: event.loaded, totalBytes: Math.max(total, event.loaded), lastProgressMs: now() });
  },
  done(id: AssetTaskId) {
    const t = tasks[id];
    update(id, { status: "done", loadedBytes: t.totalBytes, lastProgressMs: now() });
  },
  fail(id: AssetTaskId) {
    if (tasks[id].status === "done") return;
    update(id, { status: "failed", lastProgressMs: now() });
  },
  /** Marks tasks that have been loading without progress for `stallMs` as failed; returns true if any */
  failStalled(stallMs: number): boolean {
    const t = now();
    let any = false;
    for (const id of ORDER) {
      const task = tasks[id];
      if (task.status === "loading" && t - task.lastProgressMs > stallMs) {
        this.fail(id);
        any = true;
      }
    }
    return any;
  },
  get(): AssetProgressSnapshot {
    return snapshot;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useAssetProgress(): AssetProgressSnapshot {
  return useSyncExternalStore(assetProgress.subscribe, assetProgress.get, assetProgress.get);
}

export const formatMegabytes = (bytes: number) => (bytes / 1_048_576).toFixed(1);
