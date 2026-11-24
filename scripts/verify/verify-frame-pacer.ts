/**
 * The 30 fps cap's pacing (src/lib/render/frame-pacer.ts): which animation frames draw on 60, 90, 120, 144, 165 and
 * 240 Hz screens with the browser's timestamp jitter, so every one averages 30 fps (a 120 Hz screen too, not 60) with
 * even intervals where the screen's rate allows; no frames drawn back to back after a missed vsync or a stall; and
 * the cap off drawing every frame.
 *
 *   npx tsx scripts/verify/verify-frame-pacer.ts
 */
import { vehicleModelSpec } from "../../src/lib/cars/vehicle-models";
import { FramePacer, TOLERANCE_MS } from "../../src/lib/render/frame-pacer";
import { createSimHost, loopbackTransport } from "../../src/lib/sim/runtime/sim-host";
import { getActiveTrackData } from "../../src/lib/track-data";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(86)} ${detail}`);
  if (!ok) failed++;
}

/** A deterministic jitter in [-amp, amp] (ms) */
function jitter(i: number, amp: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amp;
}

/** Runs a pacer over `seconds` of a `hz` screen; returns the drawn frames' timestamps */
function run(pacer: FramePacer, hz: number, seconds: number, jitterMs = 0, start = 1000): number[] {
  const drawn: number[] = [];
  const period = 1000 / hz;
  const frames = Math.round(seconds * hz);
  for (let i = 0; i < frames; i++) {
    const t = start + i * period + jitter(i, jitterMs);
    if (pacer.shouldDraw(t)) drawn.push(t);
  }
  return drawn;
}

const intervals = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]);
const fpsOf = (ts: number[]) => (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000);
const range = (xs: number[]) => `${Math.min(...xs).toFixed(1)}-${Math.max(...xs).toFixed(1)} ms`;

check("The tolerance is under half a frame of a 144 Hz screen (else it would draw at 36 fps there)", TOLERANCE_MS < (1000 / 144) * 0.6);

// --- Cap off ---
{
  const p = new FramePacer(0);
  const drawn = run(p, 120, 5);
  check("Cap off: every frame of a 120 Hz screen draws", drawn.length === 600);
}

// --- Screens that are a multiple of 30 Hz: even pacing ---
for (const [hz, every] of [
  [60, 2],
  [90, 3],
  [120, 4],
] as const) {
  const p = new FramePacer(30);
  const drawn = run(p, hz, 20, 1.5);
  const iv = intervals(drawn);
  const fps = fpsOf(drawn);
  const period = 1000 / hz;
  check(`${hz} Hz with ±1.5 ms jitter: 30 fps`, Math.abs(fps - 30) < 0.2, fps.toFixed(2));
  check(
    `${hz} Hz: every ${every}th frame draws, all intervals within the jitter of 33.3 ms`,
    iv.every((v) => Math.abs(v - every * period) < 3.1),
    range(iv)
  );
}

// --- Without jitter, exactly even ---
{
  const p = new FramePacer(30);
  const iv = intervals(run(p, 60, 10));
  check("60 Hz without jitter: every interval 33.33 ms", iv.every((v) => Math.abs(v - 1000 / 30) < 1e-6));
}

// --- Screens that aren't a multiple, or so fast the jitter is most of a frame: the average holds, no short frames ---
for (const hz of [144, 165, 240]) {
  const p = new FramePacer(30);
  const drawn = run(p, hz, 20, 1);
  const iv = intervals(drawn);
  const fps = fpsOf(drawn);
  check(`${hz} Hz with ±1 ms jitter: averages 30 fps`, Math.abs(fps - 30) < 0.5, fps.toFixed(2));
  check(`${hz} Hz: no interval under 25 ms (nothing near 40 fps)`, iv.every((v) => v > 25), range(iv));
}

// --- What the tolerance is for ---
{
  // 60 Hz timestamps that come a hair early: a strict `>= 33.33` would skip them and draw every third (20 fps)
  const p = new FramePacer(30);
  const drawn: number[] = [];
  for (let i = 0; i < 600; i++) {
    const t = 1000 + i * (1000 / 60) - (i % 2 ? 0.02 : 0);
    if (p.shouldDraw(t)) drawn.push(t);
  }
  check("60 Hz frames stamped a hair early still draw: 30 fps, not 20", Math.abs(fpsOf(drawn) - 30) < 0.2, fpsOf(drawn).toFixed(2));
}

// --- No catching up ---
{
  // A missed vsync at 60 Hz: the late frame draws, the next one a whole interval later (not the next vsync)
  const p = new FramePacer(30);
  const times: number[] = [];
  for (let i = 0; i < 120; i++) if (i !== 30) times.push(1000 + i * (1000 / 60));
  const drawn = times.filter((t) => p.shouldDraw(t));
  const iv = intervals(drawn);
  check("A missed vsync: no two frames drawn a vsync apart afterwards", iv.every((v) => v > 30), range(iv));
}
{
  // A 2 s stall (a hidden tab): the first frame back draws, then 30 fps again, no burst
  const p = new FramePacer(30);
  const before = run(p, 60, 2, 0, 1000);
  const after = run(p, 60, 2, 0, 5000);
  const iv = intervals(after);
  check("After a 2 s stall: the first frame back draws", after[0] === 5000 && before.length > 0);
  check("...and the rest 33.3 ms apart, no burst to catch up", iv.every((v) => Math.abs(v - 1000 / 30) < 1e-6), range(iv));
}

// --- Switching ---
{
  const p = new FramePacer(30);
  run(p, 60, 1);
  p.setCap(0);
  const free = run(p, 60, 1, 0, 3000);
  p.setCap(30);
  const capped = run(p, 60, 1, 0, 5000);
  check("Cap off mid-session: every frame draws from the next", free.length === 60);
  check("Cap on again: the first frame draws, then every other", capped[0] === 5000 && capped.length === 30, String(capped.length));
}
{
  // The system's own 30 Hz (iOS Low Power Mode) under the cap: every frame draws, none is skipped down to 15
  const p = new FramePacer(30);
  const drawn = run(p, 30, 10, 1.5);
  check("A 30 Hz system cap under the 30 fps cap: every frame draws (not 15 fps)", drawn.length === 300, String(drawn.length));
}

// --- The car as drawn under the cap: the worker's 250 Hz states carried forward to each drawn frame ---
{
  // A 120 Hz page sending controls every frame and drawing every fourth; the worker on its own clock, waking every
  // 4 ms or so (setTimeout jitter). Each drawn frame should show the car where it is at that moment: its step from the
  // last drawn frame matching its speed over the interval. The worker's latest state as it is (no carrying forward)
  // is up to a tick old, a sawtooth of up to 4 ms of travel per drawn frame.
  const loop = loopbackTransport();
  // The page's clock is the frame's time; the loopback stamps each state with its wake's (both from 0)
  let pageNowMs = 0;
  const host = createSimHost(loop.transport, () => pageNowMs);
  const track = getActiveTrackData(1200);
  const twin = vehicleModelSpec("lc26").createSim(track, null);
  const car = host.adopt(twin, "lc26");
  // As the game sets a new car up (verify-sim-runtime's setUp)
  car.aiAutopilot = false;
  car.assistPreset = "semi_pro";
  car.autoGearbox = true;
  car.tireCompound = "medium";
  car.resetToStartGrid(false);
  host.endFrame(true);
  const pacer = new FramePacer(30);
  const STEP_MS = 0.25;
  let nextWake = 0;
  let lastWake = 0;
  let nextFrame = 0;
  let frameNo = 0;
  const drawn: { t: number; x: number; z: number; raw: { x: number; z: number }; v: number }[] = [];
  const sim = () => loop.runtime.simulatedCar!;
  // Eight seconds flat out down the straight (from the grid: 0 to about 250 km/h), drawn from 1.5 s on
  for (let t = 0; t <= 8000; t += STEP_MS) {
    // The worker's wake: whole ticks of the time since the last
    if (t >= nextWake) {
      loop.advance((t - lastWake) / 1000);
      lastWake = t;
      nextWake = t + 4 + Math.abs(jitter(Math.round(t * 4), 1.2));
    }
    // A page frame: controls out, the stand-in read (carried forward to now), the frame ended
    if (t >= nextFrame) {
      pageNowMs = t;
      car.step(1 / 120, { throttle: 1, brake: 0, analogSteer: 0 });
      host.endFrame(true);
      if (pacer.shouldDraw(t) && t > 1500) {
        const s = sim();
        drawn.push({ t, x: car.worldPosition.x, z: car.worldPosition.z, raw: { x: s.worldPosition.x, z: s.worldPosition.z }, v: Math.hypot(car.worldVelocity?.x ?? 0, car.worldVelocity?.z ?? 0) });
      }
      frameNo++;
      nextFrame = frameNo * (1000 / 120) + jitter(frameNo, 0.6);
    }
  }
  const errs: number[] = [];
  const rawErrs: number[] = [];
  for (let i = 1; i < drawn.length; i++) {
    const a = drawn[i - 1];
    const b = drawn[i];
    const expected = ((a.v + b.v) / 2) * ((b.t - a.t) / 1000);
    errs.push(Math.abs(Math.hypot(b.x - a.x, b.z - a.z) - expected) / expected);
    rawErrs.push(Math.abs(Math.hypot(b.raw.x - a.raw.x, b.raw.z - a.raw.z) - expected) / expected);
  }
  const worst = (xs: number[]) => Math.max(...xs);
  const speedKmh = drawn[drawn.length - 1].v * 3.6;
  check("The worker drove the car under the cap", host.remote && drawn.length > 180 && speedKmh > 200, `${drawn.length} drawn frames, ${speedKmh.toFixed(0)} km/h`);
  check(
    "Each drawn frame's step matches the car's speed over the interval within 2% (carried forward to the frame)",
    worst(errs) < 0.02,
    `worst ${(worst(errs) * 100).toFixed(2)}%`
  );
  check(
    "...where the worker's latest state as it is would be off by several % (a tick's sawtooth)",
    worst(rawErrs) > 4 * worst(errs),
    `worst ${(worst(rawErrs) * 100).toFixed(1)}%`
  );
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll frame pacing checks passed.");
