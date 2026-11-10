/**
 * The simulation worker's entry: started by `worker-sim-host.ts`, it answers the page's commands (`sim-protocol.ts`).
 */
import type { SimCommand, SimEvent } from "./sim-protocol";

/** The worker's global scope, as far as this file uses it (the DOM typings describe a window, not a worker) */
interface WorkerScope {
  onmessage: ((event: MessageEvent<SimCommand>) => void) | null;
  postMessage(message: SimEvent, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const command = event.data;
  if (command.type === "ping") scope.postMessage({ type: "pong", id: command.id });
};
