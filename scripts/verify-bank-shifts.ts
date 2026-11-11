/**
 * Verification for the sound banks' gear changes (`src/lib/sim/vf26-audio.ts`): the bank of the car with a manual
 * box (the Liana's) is loaded on a mock Web Audio graph and fed the Liana's own sim, flat out through its 2 > 3
 * up-shift, and the engine's on-load and overrun voices are read off every frame. Through the clutch the engine is
 * heard on its overrun note as the revs fall: it never goes quiet.
 *
 * Run with: npx tsx scripts/verify-bank-shifts.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LoopGrid, Vf26SoundBank, type Vf26AudioInputs } from "../src/lib/sim/vf26-audio";
import { SUZUKI_LIANA_SOUND, createSuzukiLianaSim } from "../src/lib/sim/road/SuzukiLianaSim";
import { createFlatTestTrack } from "./lib/flat-track";
import { skipSuiteWithout } from "./lib/hosted-files";

// The Liana's sound bank is hosted on librecorsa.org only: a clone and CI have no bank to hear
skipSuiteWithout("public/cars/liana/audio/manifest.json");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// A Web Audio graph that only has to be built and driven: params remember the last value they were sent
class Param {
  value = 0;
  setTargetAtTime(x: number) {
    this.value = x;
    return this;
  }
  setValueAtTime(x: number) {
    this.value = x;
    return this;
  }
  linearRampToValueAtTime(x: number) {
    this.value = x;
    return this;
  }
  exponentialRampToValueAtTime(x: number) {
    this.value = x;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}
class Node {
  readonly gain = new Param();
  readonly frequency = new Param();
  readonly Q = new Param();
  readonly playbackRate = new Param();
  type = "";
  buffer: unknown = null;
  loop = false;
  connect<T>(dest: T): T {
    return dest;
  }
  disconnect() {}
  start() {}
  stop() {}
}
const ctx = {
  currentTime: 0,
  sampleRate: 48000,
  destination: new Node(),
  createGain: () => new Node(),
  createBiquadFilter: () => new Node(),
  createBufferSource: () => new Node(),
  decodeAudioData: () => Promise.resolve({ duration: 2.4, length: 115200, sampleRate: 48000 }),
};

// The bank's files come off the disk
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const path = join(process.cwd(), "public", url.replace(/^\/+/, ""));
  try {
    const bytes = await readFile(path);
    return { ok: true, json: async () => JSON.parse(bytes.toString("utf8")), arrayBuffer: async () => bytes.buffer };
  } catch {
    return { ok: false };
  }
};

// Every engine grid's level, read as the bank sends it each frame
const levels = new Map<LoopGrid, number>();
const update = LoopGrid.prototype.update;
LoopGrid.prototype.update = function (this: LoopGrid, x: number, level: number, ...rest: unknown[]) {
  levels.set(this, level);
  return (update as (...a: unknown[]) => void).call(this, x, level, ...rest);
};

type EngineGrids = Record<"ext" | "int", { on: LoopGrid; off: LoopGrid }>;

/** The Liana flat out from rest on a flat road, its telemetry heard by its bank as CarAudio hands it over */
async function upshiftFlatOut() {
  const bank = new Vf26SoundBank(ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode, SUZUKI_LIANA_SOUND.assetDir);
  const loaded = await bank.load("ext");
  const engine = (bank as unknown as { engine: EngineGrids }).engine.ext;
  const sim = createSuzukiLianaSim(createFlatTestTrack(30_000, 3000));
  sim.teleportToDistance(1000, 6);
  const dt = 1 / 120;
  let steady = 0;
  let shiftAt = -1;
  let rpmAtShift = 0;
  const trace: { t: number; rpm: number; on: number; off: number }[] = [];
  for (let t = 0; t < 14 && (shiftAt < 0 || t < shiftAt + 0.6); t += dt) {
    const before = sim.telemetry.gear;
    const rpmBefore = sim.telemetry.rpm;
    sim.step(dt, { throttle: 1 });
    const tm = sim.telemetry;
    ctx.currentTime += dt;
    const inp: Vf26AudioInputs = {
      rpm: tm.rpm,
      throttle: tm.throttle,
      pedal: tm.throttle,
      gear: tm.gear,
      speedKmh: tm.speedKmh,
      boostBarGauge: 0,
      view: "ext",
      limiterRpm: SUZUKI_LIANA_SOUND.limiterRpm,
    };
    bank.update(inp, dt);
    const on = levels.get(engine.on) ?? 0;
    const off = levels.get(engine.off) ?? 0;
    if (shiftAt < 0 && before === 2 && tm.gear === 3) {
      shiftAt = t;
      rpmAtShift = rpmBefore;
    }
    if (shiftAt < 0 && tm.gear === 2) steady = Math.hypot(on, off);
    if (shiftAt >= 0) trace.push({ t: t - shiftAt, rpm: tm.rpm, on, off });
  }
  return { loaded, steady, trace, rpmAtShift };
}

async function main() {
  console.log("The Liana's 2 > 3 up-shift flat out, its own sim heard through its own bank");
  const { loaded, steady, trace, rpmAtShift } = await upshiftFlatOut();
  check("bank loads from public/", loaded);
  check("the sim shifts 2 > 3 straight from gear to gear", trace.length > 0 && steady > 0, `${trace.length} frames after the shift`);
  const clutchOut = trace.find((s) => s.t >= 0.2);
  check(
    "with the foot off, the revs fall through the change instead of hanging at the shift point",
    !!clutchOut && clutchOut.rpm < rpmAtShift - 400,
    `${rpmAtShift.toFixed(0)} rpm at the shift, ${clutchOut?.rpm.toFixed(0)} rpm 0.2 s in`
  );
  const quietest = trace.reduce((m, s) => Math.min(m, Math.hypot(s.on, s.off)), Infinity);
  check(
    "the engine never goes quiet through the clutch (equal-power level stays above 0.8 of steady)",
    quietest > 0.8 * steady,
    `steady ${steady.toFixed(2)}, quietest ${quietest.toFixed(2)}`
  );
  const clutchIn = trace.filter((s) => s.t > 0.02 && s.t < 0.15);
  check(
    "with the clutch in, the overrun voice carries the engine",
    clutchIn.length > 0 && clutchIn.every((s) => s.off > 0.8 * steady && s.off > s.on),
    clutchIn.map((s) => `${s.on.toFixed(2)}/${s.off.toFixed(2)}`).slice(0, 3).join(" ")
  );
  const after = trace[trace.length - 1];
  check("back on the on-load voice once the clutch bites", after.on > 0.9 && after.off < 0.3, `${after.on.toFixed(2)}/${after.off.toFixed(2)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
