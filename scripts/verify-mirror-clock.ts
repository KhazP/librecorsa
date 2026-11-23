/**
 * The live mirrors' cadence (src/lib/render/mirror-clock.ts, #186): every second drawn frame at 60 fps and up (30 Hz at
 * 60, 60 at 120, 72 at 144, so fast screens keep what they had), every drawn frame under about 45 fps (the 30 fps cap
 * and a 30-40 fps machine on Low), never under about 22 Hz between, no flipping between the two cadences at a frame rate
 * on the edge with the browser's timestamp jitter, and a GC hitch at 60 fps not switching it.
 *
 *   npx tsx scripts/verify-mirror-clock.ts
 */
import { MirrorClock } from "../src/lib/render/mirror-clock";

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

interface Run {
  /** Mirror renders per second over the measured part */
  hz: number;
  /** Longest time between two mirror renders (ms) */
  maxGapMs: number;
  /** Times the clock switched cadence over the measured part */
  switches: number;
}

/**
 * Feeds a clock `seconds` of drawn frames at `fps` (each interval jittered by up to `jitterMs`), the first `warmS`
 * seconds unmeasured; `hitchAt` frames come `hitchMs` late
 */
function run(clock: MirrorClock, fps: number, seconds: number, jitterMs = 1, warmS = 2, hitchAt: number[] = [], hitchMs = 0): Run {
  const period = 1000 / fps;
  const frames = Math.round(seconds * fps);
  const warm = Math.round(warmS * fps);
  let t = 0;
  let renders = 0;
  let lastRender = NaN;
  let maxGapMs = 0;
  let switches = 0;
  let mode = clock.rendersEveryFrame;
  for (let i = 0; i < frames; i++) {
    const dt = period + jitter(i, jitterMs) + (hitchAt.includes(i) ? hitchMs : 0);
    t += dt;
    const render = clock.tick(dt);
    if (i < warm) {
      mode = clock.rendersEveryFrame;
      if (render) lastRender = t;
      continue;
    }
    if (clock.rendersEveryFrame !== mode) {
      switches++;
      mode = clock.rendersEveryFrame;
    }
    if (render) {
      renders++;
      if (Number.isFinite(lastRender)) maxGapMs = Math.max(maxGapMs, t - lastRender);
      lastRender = t;
    }
  }
  return { hz: renders / (seconds - warmS), maxGapMs, switches };
}

const fmt = (r: Run) => `${r.hz.toFixed(1)} Hz, longest gap ${r.maxGapMs.toFixed(1)} ms, ${r.switches} switches`;

// Every second frame at 60 fps and faster: what the mirrors always did there
for (const fps of [60, 90, 120, 144, 165, 240]) {
  const r = run(new MirrorClock(), fps, 12);
  check(`${fps} fps: every second frame (${(fps / 2).toFixed(0)} Hz)`, Math.abs(r.hz - fps / 2) < 0.6 && r.switches === 0, fmt(r));
}
// 60 fps exactly alternates from the first frame
{
  const c = new MirrorClock();
  const seq = Array.from({ length: 8 }, () => (c.tick(1000 / 60) ? 1 : 0)).join("");
  check("60 fps: renders on the first frame, then strictly every second one", seq === "10101010", seq);
}
// Every drawn frame under about 45 fps: the 30 fps cap, and Low on a 30-40 fps machine
for (const fps of [24, 30, 35, 40]) {
  const r = run(new MirrorClock(), fps, 12);
  check(`${fps} fps: every drawn frame (${fps} Hz)`, Math.abs(r.hz - fps) < 0.6 && r.switches === 0, fmt(r));
}
// Between the two: never under about 22 Hz
for (const fps of [42, 44, 46, 48, 50, 55]) {
  const r = run(new MirrorClock(), fps, 12);
  check(`${fps} fps: at least 22 Hz`, r.hz >= 22, fmt(r));
}
// On the edge with jitter (frames 3 ms either way): one cadence, not a flicker between both (a single switch is the
// average settling past a threshold it sits right on)
for (const fps of [42, 43, 44, 45, 47, 49, 50]) {
  const r = run(new MirrorClock(), fps, 30, 3);
  check(`${fps} fps with 3 ms jitter: no switching back and forth`, r.switches <= 1, fmt(r));
}
// A GC hitch at 60 fps (one 120 ms frame, then two in a row) keeps every second frame
{
  const r = run(new MirrorClock(), 60, 10, 1, 2, [300, 420, 421], 120);
  check("60 fps with 120 ms hitches: stays at every second frame", r.switches === 0 && r.hz > 29, fmt(r));
}
// A machine that slows from 60 to 38 fps mid-race switches once, within a second, and back once it recovers
{
  const c = new MirrorClock();
  run(c, 60, 4);
  const slow = run(c, 38, 6, 1, 1);
  const back = run(c, 60, 6, 1, 1);
  check("60 -> 38 fps: switches to every frame within a second, once", c.rendersEveryFrame === false && slow.switches === 0 && Math.abs(slow.hz - 38) < 0.6, `38 fps: ${fmt(slow)}`);
  check("38 -> 60 fps: back to every second frame within a second, once", back.switches === 0 && Math.abs(back.hz - 30) < 0.6, `60 fps: ${fmt(back)}`);
}
// Low's old rule for reference: every fourth frame at 35 fps was under 9 Hz
check("old Low cadence at 35 fps was under 10 Hz (the report's video: 7-10 Hz)", 35 / 4 < 10, `${(35 / 4).toFixed(1)} Hz`);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll mirror cadence checks passed");
