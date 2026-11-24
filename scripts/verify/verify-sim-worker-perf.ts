/**
 * The simulation worker's `?perf=1` timing (src/lib/sim/runtime/sim-worker.ts): the worker's entry run in this process
 * on a stand-in clock, timers and runtime, so only its own clock and timing are checked.
 *
 * Driving, a pause (the page's `hold`, or the page going quiet) and driving again: no report counts the stop as wall
 * time of the simulation, so its share of the time spent simulating stays what it was before the stop.
 *
 *   npx tsx scripts/verify/verify-sim-worker-perf.ts
 */
import { SIM_TICK_S, type SimCommand, type SimEvent } from '../../src/lib/sim/runtime/sim-protocol';
import { SimRuntime } from '../../src/lib/sim/runtime/sim-runtime';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(78)} ${detail}`);
  if (!ok) failures.push(name);
};

// ---- The stand-ins: a clock that moves only when told, timers on it, and a runtime that takes 0.5 ms a wake
let nowMs = 1000;
Object.defineProperty(performance, 'now', { value: () => nowMs, configurable: true });
const timers: { at: number; fn: () => void; id: number }[] = [];
let timerId = 0;
(globalThis as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms = 0) => {
  timers.push({ at: nowMs + ms, fn, id: ++timerId });
  return timerId;
};
/** Runs every timer due by `nowMs + ms` in order, the clock at each one's time */
function pass(ms: number): void {
  const until = nowMs + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = timers[0];
    if (!next || next.at > until) break;
    timers.shift();
    nowMs = Math.max(nowMs, next.at);
    next.fn();
  }
  nowMs = until;
}

const BUSY_MS = 0.5;
const runtime = SimRuntime.prototype as unknown as Record<string, unknown>;
Object.defineProperty(runtime, 'running', { get(this: { driving?: boolean }) { return this.driving === true; }, configurable: true });
runtime.handle = function (this: { driving?: boolean }, command: SimCommand) {
  if (command.type === 'inputs') this.driving = true;
  if (command.type === 'hold') this.driving = false;
};
runtime.hold = function (this: { driving?: boolean }) {
  this.driving = false;
};
runtime.advance = function () {
  nowMs += BUSY_MS;
  return 1;
};

const posted: SimEvent[] = [];
const scope: { onmessage: ((e: { data: SimCommand }) => void) | null; postMessage: (m: SimEvent) => void } = {
  onmessage: null,
  postMessage: (m) => posted.push(m),
};
(globalThis as unknown as { self: unknown }).self = scope;

const send = (command: SimCommand) => scope.onmessage!({ data: command });
/** The page driving for `ms`: controls every frame (16 ms) */
function drive(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    send({ type: 'inputs', inputs: { throttle: 1 } });
    pass(16);
  }
}
const reports = () => posted.filter((e): e is Extract<SimEvent, { type: 'perf' }> => e.type === 'perf');

async function main() {
  await import('../../src/lib/sim/runtime/sim-worker');
  send({ type: 'perf', on: true });
  pass(500);

  // Driving for 3 s: one wake every SIM_TICK_S, each 0.5 ms busy
  drive(3000);
  const steady = reports();
  const share = (r: { spanMs: number; busyMs: number }) => r.busyMs / r.spanMs;
  const steadyShare = steady.length ? share(steady[steady.length - 1]) : 0;
  check('driving: a report about once a second', steady.length >= 2 && steady.every((r) => r.spanMs >= 1000 && r.spanMs < 1100), steady.map((r) => r.spanMs.toFixed(0)).join(' '));
  const expected = BUSY_MS / (SIM_TICK_S * 1000 + BUSY_MS);
  check('driving: the busy share is the wakes\' work', Math.abs(steadyShare - expected) < 0.02, `${(100 * steadyShare).toFixed(1)} % (expected ${(100 * expected).toFixed(1)} %)`);

  // Paused (the page's hold) for a minute, then driving again
  const before = reports().length;
  send({ type: 'hold' });
  pass(60_000);
  check('paused: no reports while the clock is stopped', reports().length === before);
  drive(2500);
  const afterHold = reports().slice(before);
  check(
    'after a pause: no report counts the pause as simulation time',
    afterHold.length >= 1 && afterHold.every((r) => r.spanMs < 2000),
    afterHold.map((r) => `${r.spanMs.toFixed(0)} ms`).join(' '),
  );
  check(
    'after a pause: the busy share stays what it was',
    afterHold.length >= 1 && afterHold.every((r) => Math.abs(share(r) - expected) < 0.02),
    afterHold.map((r) => `${(100 * share(r)).toFixed(1)} %`).join(' '),
  );

  // The page going quiet (a hidden tab) for 30 s: the clock stops itself, the same again
  const beforeQuiet = reports().length;
  pass(30_000);
  drive(2500);
  const afterQuiet = reports().slice(beforeQuiet);
  check(
    'after the page went quiet: no report counts the stop either',
    afterQuiet.length >= 1 && afterQuiet.every((r) => r.spanMs < 2000 && Math.abs(share(r) - expected) < 0.03),
    afterQuiet.map((r) => `${r.spanMs.toFixed(0)} ms ${(100 * share(r)).toFixed(1)} %`).join(', '),
  );

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll sim worker perf checks passed');
  process.exit(0);
}

void main();
