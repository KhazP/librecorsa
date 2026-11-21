/**
 * The simulation worker's entry: started by `worker-sim-host.ts`, it feeds the page's commands to a `SimRuntime` and
 * runs its clock. While the page is driving, the car advances on this thread's own timer (a wake every 4 ms, one
 * tick each, caught up by the clock when a wake is late), so a frame that takes long to draw does not stall it.
 */
import { SIM_TICK_S, type SimCommand, type SimEvent } from "./sim-protocol";
import { FIELD_TICKS, SimRuntime } from "./sim-runtime";

/** The worker's global scope, as far as this file uses it (the DOM typings describe a window, not a worker) */
interface WorkerScope {
  onmessage: ((event: MessageEvent<SimCommand>) => void) | null;
  postMessage(message: SimEvent, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** With no controls from the page for this long the clock stops (ms): a hidden tab, a stalled frame loop */
const QUIET_PAGE_MS = 250;

const wallNowMs = () => performance.timeOrigin + performance.now();
/** Wall timestamp of the wake currently advancing (0 outside wake: immediate placement replies use wallNowMs()) */
let stepWallMs = 0;
const runtime = new SimRuntime((event) => {
  if (event.type === "state") event.wallMs = stepWallMs > 0 ? stepWallMs : wallNowMs();
  scope.postMessage(event);
});

let timer: ReturnType<typeof setTimeout> | null = null;
let lastWakeMs = 0;
let lastInputsMs = 0;

/** `?perf=1` (the page's `perf` command): the work timed since the last report, sent about once a second */
const PERF_REPORT_MS = 1000;
let perf: { sinceMs: number; ticks: number; busyMs: number; maxWakeMs: number } | null = null;

function wake(): void {
  timer = null;
  const now = performance.now();
  if (now - lastInputsMs > QUIET_PAGE_MS) runtime.hold();
  if (!runtime.running) return;
  // Stamp `wallMs` at the simulated instant `now` (before `advance()` runs) so heavy AI frames never skew timestamps forward
  stepWallMs = performance.timeOrigin + now;
  const ticks = runtime.advance((now - lastWakeMs) / 1000);
  stepWallMs = 0;
  lastWakeMs = now;
  const end = performance.now();
  const busy = end - now;
  if (perf) {
    perf.ticks += ticks;
    perf.busyMs += busy;
    perf.maxWakeMs = Math.max(perf.maxWakeMs, busy);
    if (end - perf.sinceMs >= PERF_REPORT_MS) {
      scope.postMessage({ type: "perf", spanMs: end - perf.sinceMs, ticks: perf.ticks, busyMs: perf.busyMs, maxWakeMs: perf.maxWakeMs });
      perf = { sinceMs: end, ticks: 0, busyMs: 0, maxWakeMs: 0 };
    }
  }
  // In an AI race, align wakes to FIELD_TICKS (8 ms = 125 Hz) and compensate for busy work so player & AI stay phase-locked
  // with half the postMessage structured-clone load; solo practice keeps the 4 ms wake interval.
  const nextMs = runtime.inRace ? Math.max(1, FIELD_TICKS * SIM_TICK_S * 1000 - busy) : SIM_TICK_S * 1000;
  timer = setTimeout(wake, nextMs);
}

scope.onmessage = (event) => {
  const command = event.data;
  if (command.type === "perf") {
    perf = command.on ? { sinceMs: performance.now(), ticks: 0, busyMs: 0, maxWakeMs: 0 } : null;
    return;
  }
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
      // `?perf=1`: the stop (a pause, a menu, a hidden tab) is no simulation time, so it is left out of the report's span
      if (perf) perf.sinceMs = Math.min(lastInputsMs, perf.sinceMs + (lastInputsMs - lastWakeMs));
      lastWakeMs = lastInputsMs;
      timer = setTimeout(wake, SIM_TICK_S * 1000);
    }
  }
};
