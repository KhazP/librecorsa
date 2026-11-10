/**
 * The page's end of the simulation worker: starts it and talks to it (`sim-protocol.ts`).
 */
import type { SimCommand, SimEvent } from "./sim-protocol";

export interface SimWorkerLink {
  post(command: SimCommand, transfer?: Transferable[]): void;
  /** Calls `listener` with every event from the worker; returns the unsubscribe */
  listen(listener: (event: SimEvent) => void): () => void;
  /** Time for a message to reach the worker and its answer to come back (ms); rejects when the worker fails to start */
  ping(): Promise<number>;
  dispose(): void;
}

export function startSimWorker(): SimWorkerLink {
  // The bundler finds the worker's code by this exact `new Worker(new URL(...))` form and emits it as its own chunk
  const worker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module", name: "librecorsa-sim" });
  const listeners = new Set<(event: SimEvent) => void>();
  let failed: unknown = null;
  const waiting = new Map<number, { sentMs: number; done: (ms: number) => void; fail: (reason: unknown) => void }>();
  let nextId = 1;
  worker.onmessage = (e: MessageEvent<SimEvent>) => {
    const event = e.data;
    if (event.type === "pong") {
      const w = waiting.get(event.id);
      waiting.delete(event.id);
      w?.done(performance.now() - w.sentMs);
    }
    for (const listener of listeners) listener(event);
  };
  worker.onerror = (e) => {
    failed = e.message || "The simulation worker failed to start";
    for (const w of waiting.values()) w.fail(failed);
    waiting.clear();
  };
  return {
    post: (command, transfer) => worker.postMessage(command, transfer ?? []),
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ping: () =>
      new Promise<number>((done, fail) => {
        if (failed !== null) return fail(failed);
        const id = nextId++;
        waiting.set(id, { sentMs: performance.now(), done, fail });
        worker.postMessage({ type: "ping", id } satisfies SimCommand);
      }),
    dispose: () => {
      worker.terminate();
      listeners.clear();
      waiting.clear();
    },
  };
}
