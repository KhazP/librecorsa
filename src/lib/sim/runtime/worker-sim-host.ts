/**
 * The simulation worker as a transport for `sim-host.ts`: starts `sim-worker.ts` and passes messages to and from it.
 */
import type { SimCommand, SimEvent } from "./sim-protocol";
import type { SimTransport } from "./sim-host";

export interface WorkerTransport extends SimTransport {
  /** Time for a message to reach the worker and its answer to come back (ms); rejects when the worker fails to start */
  ping(): Promise<number>;
}

export function startSimWorker(): WorkerTransport {
  // The bundler finds the worker's code by this exact `new Worker(new URL(...))` form and emits it as its own chunk
  const worker = new Worker(new URL("./sim-worker.ts", import.meta.url), { type: "module", name: "librecorsa-sim" });
  const listeners = new Set<(event: SimEvent) => void>();
  let failed: string | null = null;
  const waiting = new Map<number, { sentMs: number; done: (ms: number) => void; fail: (reason: unknown) => void }>();
  let nextId = 1;
  const deliver = (event: SimEvent) => {
    for (const listener of listeners) listener(event);
  };
  worker.onmessage = (e: MessageEvent<SimEvent>) => {
    const event = e.data;
    if (event.type === "pong") {
      const w = waiting.get(event.id);
      waiting.delete(event.id);
      w?.done(performance.now() - w.sentMs);
    }
    if (event.type === "error") console.warn("[sim] worker:", event.message);
    deliver(event);
  };
  worker.onerror = (e) => {
    failed = e.message || "The simulation worker failed";
    console.warn("[sim] worker:", failed);
    for (const w of waiting.values()) w.fail(failed);
    waiting.clear();
    // The game carries on with the page's own car
    deliver({ type: "error", message: failed });
  };
  return {
    post: (command: SimCommand) => {
      if (failed === null) worker.postMessage(command);
    },
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
