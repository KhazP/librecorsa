/**
 * The simulation worker's entry: started by `worker-sim-host.ts`, it feeds the page's commands to a `SimRuntime` and
 * runs its clock. While the page is driving, the car advances on this thread's own timer (a wake every 4 ms, one
 * tick each, caught up by the clock when a wake is late), so a frame that takes long to draw does not stall it.
 */
import { SIM_TICK_S, type SimCommand, type SimEvent } from "./sim-protocol";
import { SimRuntime } from "./sim-runtime";

/** The worker's global scope, as far as this file uses it (the DOM typings describe a window, not a worker) */
interface WorkerScope {
  onmessage: ((event: MessageEvent<SimCommand>) => void) | null;
  postMessage(message: SimEvent, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** With no controls from the page for this long the clock stops (ms): a hidden tab, a stalled frame loop */
const QUIET_PAGE_MS = 250;

const wallNowMs = () => performance.timeOrigin + performance.now();
const runtime = new SimRuntime((event) => {
  if (event.type === "state") event.wallMs = wallNowMs();
  scope.postMessage(event);
});

let timer: ReturnType<typeof setTimeout> | null = null;
let lastWakeMs = 0;
let lastInputsMs = 0;

function wake(): void {
  timer = null;
  const now = performance.now();
  if (now - lastInputsMs > QUIET_PAGE_MS) runtime.hold();
  if (!runtime.running) return;
  runtime.advance((now - lastWakeMs) / 1000);
  lastWakeMs = now;
  timer = setTimeout(wake, SIM_TICK_S * 1000);
}

scope.onmessage = (event) => {
  const command = event.data;
  try {
    runtime.handle(command);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (command.type === "inputs") {
    lastInputsMs = performance.now();
    // The clock starts with the first controls after a stop
    if (timer === null && runtime.running) {
      lastWakeMs = lastInputsMs;
      timer = setTimeout(wake, SIM_TICK_S * 1000);
    }
  }
};
