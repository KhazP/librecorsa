/**
 * Verification for the sound bank player's optional layers (`src/lib/sim/lc26-audio.ts`): transmission loops driven
 * by the driveshafts, the electric machine's loop, the load-driven engine filter, the per-view tone stage and the
 * length of the sequential shift cut.
 *
 * 1. The mixing maths on its own (pitch, level and blend from shaft speed, torque and machine power).
 * 2. The 2026 prototype's bank, which has none of the sections, on a mock Web Audio graph: it sounds the same
 *    whether or not the physics reports driveshafts and a machine.
 * 3. A bank built with the sections (the LC-LMDH's, hosted only): its manifest parses, its files are there and its
 *    layers follow the inputs.
 * 4. A pitched grid's loops waking: mid-sweep they start where the others' pitch glide has got to; after a silence
 *    (an opponent's voice handed to another car) they start at the target.
 * 5. Loops in their source bank's own mix (`EngineEntry.gain`, `throttleGain`, `flatEngine`): every loop of a layer at
 *    its own gain, none crossfaded, on a grid and in a ported bank (F1 2007's, hosted only); its gear changes through
 *    the throttle alone (`shift.throttleCut`), its own gear sounds and its transmission recording.
 *
 * Run with: npx tsx scripts/verify/verify-bank-layers.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  drivelineMix,
  loadFilterHz,
  LoopGrid,
  Lc26SoundBank,
  mguMix,
  type DrivelineSpec,
  type Lc26AudioInputs,
  type Lc26AudioManifest,
} from "../../src/lib/sim/lc26-audio";
import { noteSkip } from "../lib/hosted-files";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

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
  outputs: unknown[] = [];
  connect<T>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }
  disconnect() {
    this.outputs = [];
  }
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
  decodeAudioData: () => Promise.resolve({ duration: 2.0, length: 96000, sampleRate: 48000 }),
};
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const path = join(process.cwd(), "public", url.replace(/^\/+/, ""));
  try {
    const bytes = await readFile(path);
    return { ok: true, json: async () => JSON.parse(bytes.toString("utf8")), arrayBuffer: async () => bytes.buffer };
  } catch {
    return { ok: false };
  }
};

// Every grid's axis position and level, as the bank sends them each frame
const sent = new Map<LoopGrid, { x: number; level: number }>();
const gridUpdate = LoopGrid.prototype.update;
LoopGrid.prototype.update = function (this: LoopGrid, x: number, level: number, ...rest: unknown[]) {
  sent.set(this, { x, level });
  return (gridUpdate as (...a: unknown[]) => void).call(this, x, level, ...rest);
};

interface BankInside {
  engine: Record<"ext" | "int", { on: LoopGrid; off: LoopGrid }>;
  transOn: LoopGrid | null;
  transOff: LoopGrid | null;
  mguVoice: { gain: Node; source: Node | null } | null;
  engineFilter: Node;
  viewBus: Record<"ext" | "int", Node>;
  toneNodes: Node[];
  upshiftLen: number;
}

async function loadBank(assetDir: string, view: "ext" | "int") {
  const bank = new Lc26SoundBank(ctx as unknown as AudioContext, ctx.destination as unknown as AudioNode, assetDir);
  const loaded = await bank.load(view);
  // the transmission, raw loops and the other view decode in the background
  await new Promise((r) => setTimeout(r, 150));
  return { bank, loaded, inside: bank as unknown as BankInside };
}

/** Holds the inputs for `seconds` so every smoothed value settles, and returns what the layers were last sent */
function settle(bank: Lc26SoundBank, inside: BankInside, inp: Lc26AudioInputs, seconds = 0.6) {
  const dt = 1 / 120;
  for (let t = 0; t < seconds; t += dt) {
    ctx.currentTime += dt;
    bank.update(inp, dt);
  }
  const on = inside.transOn ? sent.get(inside.transOn) : undefined;
  const off = inside.transOff ? sent.get(inside.transOff) : undefined;
  return {
    transX: on?.x ?? 0,
    transOn: on?.level ?? 0,
    transOff: off?.level ?? 0,
    mguGain: inside.mguVoice?.gain.gain.value ?? 0,
    mguRate: inside.mguVoice?.source?.playbackRate.value ?? 0,
    filterHz: inside.engineFilter.frequency.value,
  };
}

const base: Lc26AudioInputs = {
  rpm: 7000,
  throttle: 1,
  pedal: 1,
  gear: 5,
  speedKmh: 220,
  boostBarGauge: 1.2,
  view: "int",
  limiterRpm: 8500,
};

function mixingMaths(): void {
  console.log("1. Mixing maths");
  const spec: DrivelineSpec = { kmhPerRadS: 1.278, torqueRefNm: 2400, coastTorqueRefNm: 900, floor: 0.12 };
  const drive = drivelineMix(spec, 200, 2400);
  check("shaft speed sets the axis: 200 rad/s on a 0.355 m tyre is 255.6 km/h", near(drive.axisKmh, 255.6, 0.01), drive.axisKmh.toFixed(2));
  check("full drive torque: on-load loops, full level", drive.onness === 1 && near(drive.level, 1, 1e-9));
  const coast = drivelineMix(spec, 200, -900);
  check("full overrun torque (its own reference): off-load loops, full level", coast.onness === 0 && near(coast.level, 1, 1e-9));
  const free = drivelineMix(spec, 200, 0);
  check("no torque: the floor level, halfway between the loops", near(free.level, 0.12, 1e-9) && near(free.onness, 0.5, 1e-9));
  const quarter = drivelineMix(spec, 200, 600);
  check("a quarter of the torque is half the way up from the floor (square root)", near(quarter.level, 0.12 + 0.88 * 0.5, 1e-9), quarter.level.toFixed(3));
  check("a reversing shaft is heard at its speed", near(drivelineMix(spec, -50, 0).axisKmh, 63.9, 0.01));
  check("a physics blow-up (NaN) leaves the layer at rest", drivelineMix(spec, NaN, NaN).axisKmh === 0 && near(drivelineMix(spec, NaN, NaN).level, 0.12, 1e-9));

  const mgu = { baseRpm: 5000, fullKw: 200, gain: { int: 0.5, ext: 0.2 } };
  check("machine with no power reported is silent", mguMix(mgu, 6000, undefined, 1).gain === 0 && mguMix(mgu, 6000, 0, 1).gain === 0);
  check("full regeneration in the cockpit: the interior gain", near(mguMix(mgu, 6000, -200, 1).gain, 0.5, 1e-9));
  check("the same from outside: the exterior gain", near(mguMix(mgu, 6000, -200, 0).gain, 0.2, 1e-9));
  const deploy = mguMix(mgu, 6000, 50, 1).gain;
  check("50 kW of drive is quieter than 200 kW of regeneration, and audible", deploy > 0.15 && deploy < 0.3, deploy.toFixed(3));
  check("pitch follows the machine's speed", near(mguMix(mgu, 7500, 50, 1).rate, 1.5, 1e-9) && mguMix(mgu, 100, 50, 1).rate === 0.25);

  const lf = { coastHz: 2200, loadHz: 16000 };
  check("load filter: 2200 Hz on the overrun, 16 kHz at full load", near(loadFilterHz(lf, 0), 2200, 1e-6) && near(loadFilterHz(lf, 1), 16000, 1e-6));
  check("load filter: the geometric middle at half load", near(loadFilterHz(lf, 0.5), Math.sqrt(2200 * 16000), 1e-6), loadFilterHz(lf, 0.5).toFixed(0));
}

async function bankWithoutSections(): Promise<void> {
  console.log("\n2. A bank without the sections ignores the new inputs (the 2026 prototype's, in the repository)");
  const dir = "/cars/f12026/audio/";
  const m = JSON.parse(readFileSync(join("public", dir, "manifest.json"), "utf8")) as Lc26AudioManifest;
  check("its manifest has no driveline, mgu, loadFilter or viewTone section", !m.driveline && !m.mgu && !m.loadFilter && !m.viewTone);
  const { bank, loaded, inside } = await loadBank(dir, "int");
  check("bank loads from public/", loaded);
  check("no machine voice and no tone stage were built", inside.mguVoice === null && inside.toneNodes.length === 0);
  check("each view's bus still feeds the engine filter directly", inside.viewBus.int.outputs[0] === inside.engineFilter && inside.viewBus.ext.outputs[0] === inside.engineFilter);
  // Long enough for the pedal and rev smoothing to settle, so the two runs can be compared value for value
  const plain = settle(bank, inside, { ...base, limiterRpm: 12500 }, 3);
  const withInputs = settle(bank, inside, { ...base, limiterRpm: 12500, driveshaftRadS: 400, driveshaftTorqueNm: -3000, mguPowerKw: -200, mguRpm: 9000 }, 3);
  check(
    "transmission loops sit at the road speed, at the same levels, with or without driveshaft inputs",
    plain.transX === 220 && withInputs.transX === 220 && near(plain.transOn, withInputs.transOn, 1e-9) && near(plain.transOff, withInputs.transOff, 1e-9) && plain.transOn > 0.9,
    `x ${withInputs.transX}, on ${withInputs.transOn.toFixed(3)}, off ${withInputs.transOff.toFixed(3)}`
  );
  check("the engine filter is where it was", near(plain.filterHz, withInputs.filterHz, 1e-6), `${plain.filterHz.toFixed(0)} Hz`);
  bank.update({ ...base, limiterRpm: 12500, gear: 6 }, 1 / 120);
  check("the sequential shift cut keeps its 60 ms", near(inside.upshiftLen, 0.06, 1e-9));
  bank.dispose();
}

/**
 * `required`: the bank is in the repository, so a missing manifest fails. `viewTone`: the bank has a tone stage per
 * view (absent: its cockpit and outside buses must feed the engine filter directly)
 */
async function bankWithSections(label: string, dir: string, { required, viewTone }: { required: boolean; viewTone: boolean }): Promise<void> {
  console.log(`\n3. A bank built with the sections (${label})`);
  const manifestPath = join("public", dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    if (required) {
      check(`${label}: manifest exists`, false, manifestPath);
      return;
    }
    noteSkip(`${label} bank layers`, manifestPath);
    return;
  }
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Lc26AudioManifest;
  const d = m.driveline;
  check("driveline section: positive axis scale and torque references, floor within 0..1", !!d && d.kmhPerRadS > 0 && d.torqueRefNm > 0 && (d.coastTorqueRefNm ?? 1) > 0 && (d.floor ?? 0) >= 0 && (d.floor ?? 0) < 1);
  check("mgu section: a loop file, a base speed and a full power", !!m.mgu && m.mgu.file.endsWith(".ogg") && m.mgu.baseRpm > 0 && m.mgu.fullKw > 0 && m.mgu.rms > 0.005);
  // Open at full load at least as far as on the overrun: the LC-LMDH's Engine Lab engine holds it wide open throughout
  check("loadFilter section: opens upwards with load, or stays open", !!m.loadFilter && m.loadFilter.coastHz > 200 && m.loadFilter.loadHz >= m.loadFilter.coastHz && m.loadFilter.loadHz <= 20000);
  if (viewTone) check("viewTone section: sane peak and shelf per view", Object.values(m.viewTone ?? {}).length > 0 && Object.values(m.viewTone ?? {}).every((t) => !!t && t.peakHz > 20 && Math.abs(t.peakDb) <= 9 && t.shelfHz > t.peakHz && Math.abs(t.shelfDb) <= 9));
  else check("no viewTone section", !m.viewTone);
  check("shift cut length within 20-120 ms", m.shift?.style === "sequential" && (m.shift.cutS ?? 0.06) >= 0.02 && (m.shift.cutS ?? 0.06) <= 0.12, `${m.shift?.cutS} s`);
  const mguFile = join("public", dir, m.mgu?.file ?? "missing");
  check("the machine's loop is an Ogg stream", existsSync(mguFile) && readFileSync(mguFile).subarray(0, 4).toString("ascii") === "OggS");
  if (!d || !m.mgu || !m.loadFilter) return;

  const { bank, loaded, inside } = await loadBank(dir, "int");
  check("bank loads from public/", loaded);
  if (viewTone) check("tone stage sits between the cockpit bus and the engine filter", inside.toneNodes.length >= 2 && inside.viewBus.int.outputs[0] !== inside.engineFilter && inside.toneNodes[1].outputs[0] === inside.engineFilter);
  else check("no tone stage: both view buses feed the engine filter directly", inside.toneNodes.length === 0 && inside.viewBus.int.outputs[0] === inside.engineFilter && inside.viewBus.ext.outputs[0] === inside.engineFilter);

  // No driveshafts and no machine reported: the loops play as in any bank, the machine is silent
  const legacy = settle(bank, inside, base);
  check("without driveshaft inputs the loops follow the road speed", legacy.transX === 220);
  check("without machine power the machine is silent", legacy.mguGain === 0);
  check("full load opens the engine filter to its load cutoff", near(legacy.filterHz, m.loadFilter.loadHz, 1), `${legacy.filterHz.toFixed(0)} Hz`);

  // Drive: wheelspin at 220 km/h road speed, the shafts turning as at 300 km/h
  const spin = 300 / d.kmhPerRadS;
  const driving = settle(bank, inside, { ...base, driveshaftRadS: spin, driveshaftTorqueNm: d.torqueRefNm, mguPowerKw: 50 });
  check("the loops follow the shafts, not the road (wheelspin is heard)", near(driving.transX, 300, 0.01), `${driving.transX.toFixed(1)} km/h axis at 220 km/h`);
  const intGain = d.gain?.int ?? 1;
  check("full drive torque: the on-load loop at the cockpit gain, the off-load loop out", near(driving.transOn, intGain, 0.01) && driving.transOff < 0.01, `${driving.transOn.toFixed(3)} / ${driving.transOff.toFixed(3)}`);
  check("50 kW from the machine is heard", driving.mguGain > 0.02, driving.mguGain.toFixed(3));
  check("the machine's pitch follows the engine when no speed of its own is given", near(driving.mguRate, base.rpm / m.mgu.baseRpm, 0.01), driving.mguRate.toFixed(3));

  // Overrun under regeneration
  const regen = settle(bank, inside, { ...base, throttle: 0, pedal: 0, driveshaftRadS: spin * 0.6, driveshaftTorqueNm: -(d.coastTorqueRefNm ?? d.torqueRefNm), mguPowerKw: -m.mgu.fullKw, mguRpm: m.mgu.baseRpm * 1.2 });
  check("overrun torque: the off-load loop carries the whine", regen.transOff > 0.9 * intGain && regen.transOn < 0.01, `${regen.transOn.toFixed(3)} / ${regen.transOff.toFixed(3)}`);
  check("full regeneration: the machine at its cockpit gain, louder than at 50 kW", near(regen.mguGain, m.mgu.gain?.int ?? 1, 0.01) && regen.mguGain > driving.mguGain, regen.mguGain.toFixed(3));
  check("the machine's own speed sets its pitch when given", near(regen.mguRate, 1.2, 0.01), regen.mguRate.toFixed(3));
  check("lifting closes the engine filter to its coast cutoff", near(regen.filterHz, m.loadFilter.coastHz, 1), `${regen.filterHz.toFixed(0)} Hz`);

  // Coasting with nothing on the shafts, heard from outside
  const outside = settle(bank, inside, { ...base, view: "ext", throttle: 0, pedal: 0, driveshaftRadS: spin, driveshaftTorqueNm: 0, mguPowerKw: 0 }, 1.2);
  const floor = (d.floor ?? 0.15) * (d.gain?.ext ?? 1);
  check("no torque, from outside: the floor level at the exterior gain, split evenly", near(Math.hypot(outside.transOn, outside.transOff), floor, 0.01) && near(outside.transOn, outside.transOff, 0.005), `${Math.hypot(outside.transOn, outside.transOff).toFixed(3)} vs ${floor.toFixed(3)}`);
  check("no power: the machine falls silent", outside.mguGain === 0);

  bank.resync();
  settle(bank, inside, base, 0.1);
  bank.update({ ...base, gear: 6 }, 1 / 120);
  check("the upshift cut lasts what the manifest says", near(inside.upshiftLen, m.shift?.cutS ?? 0.06, 1e-9), `${inside.upshiftLen} s`);
  bank.dispose();
}

/** A source that remembers the rate it was started at: the waking rate, set before the glide to the target */
class WakeSource extends Node {
  startRate = NaN;
  override start() {
    this.startRate = this.playbackRate.value;
  }
}

function wakingLoops(): void {
  console.log("\n4. Loops waking on a pitched grid");
  const wakeCtx = { currentTime: 0, createGain: () => new Node(), createBufferSource: () => new WakeSource() };
  const dt = 1 / 120;
  let now = 0;
  const makeGrid = () => {
    const grid = new LoopGrid(wakeCtx as unknown as AudioContext, new Node() as unknown as AudioNode, [4000, 6000, 8000]);
    for (const v of grid.voices) v.buffer = { duration: 2 } as AudioBuffer;
    return grid;
  };
  const startRate = (grid: LoopGrid, key: number) =>
    (grid.voiceFor(key) as unknown as { source: WakeSource | null }).source?.startRate ?? NaN;
  const hold = (grid: LoopGrid, x: number, level: number, seconds: number) => {
    for (let t = 0; t < seconds; t += dt) grid.update(x, level, true, (now += dt), dt, 0.03);
  };

  // Mid-sweep: the revs rise from 5000 to 5900, then to 7000 a frame later, where the 8000 rpm loop wakes while the
  // others are a frame into their 20 ms glide towards 5900
  const sweep = makeGrid();
  hold(sweep, 5000, 1, 0.5);
  sweep.update(5900, 1, true, (now += dt), dt, 0.03);
  check("at 5900 rpm the 8000 rpm loop is not playing yet", Number.isNaN(startRate(sweep, 8000)));
  sweep.update(7000, 1, true, (now += dt), dt, 0.03);
  const glide = 5900 + (5000 - 5900) * Math.exp(-dt / 0.02);
  const woke = startRate(sweep, 8000);
  check(
    "a loop waking mid-sweep starts where the others' glide has got to, not at the target",
    near(woke, glide / 8000, 1e-9) && woke < 7000 / 8000 - 0.1,
    `${woke.toFixed(3)}, glide ${(glide / 8000).toFixed(3)}, target ${(7000 / 8000).toFixed(3)}`
  );

  // After a silence (an opponent's voice freed at 5000 rpm, or never used), the loops start at the new car's revs
  for (const [label, silentAt] of [["an old car's revs", 5000], ["a fresh voice", 1]] as const) {
    const handed = makeGrid();
    hold(handed, 5000, 1, 0.5);
    hold(handed, silentAt, 0, 0.5);
    handed.update(7000, 1, true, (now += dt), dt, 0.03);
    const hi = startRate(handed, 8000);
    const lo = startRate(handed, 6000);
    check(
      `a grid silent at ${label} wakes its loops at the target, not swooping up from there`,
      near(hi, 7000 / 8000, 1e-9) && near(lo, 7000 / 6000, 1e-9),
      `${lo.toFixed(3)} / ${hi.toFixed(3)}`
    );
  }
}

/** A voice's gain and playback rate as last sent */
const voiceState = (grid: LoopGrid, key: number) => {
  const v = grid.voiceFor(key) as unknown as { gain: Node; source: Node | null } | undefined;
  return { gain: v?.gain.gain.value ?? NaN, rate: v?.source?.playbackRate.value ?? NaN };
};
const lerp = (t: [number, number][], x: number) => {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) return t[i - 1][1] + ((t[i][1] - t[i - 1][1]) * (x - t[i - 1][0])) / (t[i][0] - t[i - 1][0]);
  return t[t.length - 1][1];
};

async function bankOwnMix(): Promise<void> {
  console.log("\n5. Loops in their bank's own mix (gain tables)");
  // A grid given its keys out of order, each with its gain over rpm: every loop sounds at its own gain, none crossfaded
  const tables: Record<number, [number, number][]> = {
    8000: [[5000, 0], [7000, 1], [20000, 1]],
    4000: [[0, 1], [5000, 1], [7000, 0]],
    6000: [[3000, 0], [5500, 0.8], [9000, 0.2]],
  };
  const keys = [8000, 4000, 6000];
  const grid = new LoopGrid(ctx as unknown as AudioContext, new Node() as unknown as AudioNode, keys, keys.map((k) => tables[k]));
  for (const v of grid.voices) v.buffer = { duration: 2 } as AudioBuffer;
  grid.update(6200, 0.5, true, (ctx.currentTime += 1 / 120), 1 / 120, 0.03);
  const states = keys.map((k) => ({ k, ...voiceState(grid, k), want: lerp(tables[k], 6200) * 0.5 }));
  check(
    "keys out of order: each loop at its own table's gain at 6200 rpm, times the layer's level",
    states.every((s) => near(s.gain, s.want, 1e-9)),
    states.map((s) => `${s.k}: ${s.gain.toFixed(4)} / ${s.want.toFixed(4)}`).join(", ")
  );
  check(
    "each loop pitched to the revs from its own root",
    states.every((s) => s.want < 1e-4 || near(s.rate, 6200 / s.k, 1e-9)),
    states.map((s) => `${s.k}: ${s.rate.toFixed(4)}`).join(", ")
  );

  const dir = "/cars/f1-2007/audio/ferrari/";
  if (!existsSync(join("public", dir, "manifest.json"))) {
    noteSkip("F1 2007's ported bank", join("public", dir, "manifest.json"));
    return;
  }
  const m = JSON.parse(readFileSync(join("public", dir, "manifest.json"), "utf8")) as Lc26AudioManifest;
  const { bank, loaded, inside } = await loadBank(dir, "int");
  check("F1 2007's bank loads", loaded);
  const inp: Lc26AudioInputs = { ...base, rpm: 9300, throttle: 0.45, pedal: 0.45, limiterRpm: 19000 };
  settle(bank, inside, inp, 1.5);
  const tg = m.throttleGain!.int!;
  for (const layer of ["on", "off"] as const) {
    const level = sent.get(inside.engine.int[layer])?.level ?? NaN;
    const want = lerp(tg[layer], 0.45);
    check(`the cockpit ${layer} layer at the throttle's own gain (${want.toFixed(3)} at 45 %), not the sin/cos blend`, near(level, want, 0.002), level.toFixed(4));
    const entries = m.engine.int.filter((e) => e.layer === layer);
    const off = entries
      .map((e) => ({ e, got: voiceState(inside.engine.int[layer], e.rpm).gain, want: lerp(e.gain!, 9300) * level }))
      .filter(({ got, want }) => !(want < 1e-4 && (Number.isNaN(got) || got < 1e-4)) && !near(got, want, 0.002 * Math.max(1, want)));
    check(`every ${layer} loop at its gain table's value at 9300 rpm`, off.length === 0, off.map(({ e, got, want }) => `${e.rpm}: ${got} / ${want}`).join(", "));
  }
  check("no rpm/load filter on the bank's own mix (flatEngine)", inside.engineFilter.frequency.value >= 24000, `${inside.engineFilter.frequency.value} Hz`);

  // The gearbox through the throttle alone (`shift.throttleCut`), at 60 frames a second as the source's game updates
  // its sound: an up-shift shuts the throttle on the frames within the 25 ms cut, a down-shift blips it to 0.75; each
  // plays the view's gear sound, at its own level and pitch; the transmission is its one recording at its own curves
  const played: string[] = [];
  const play = (Lc26SoundBank.prototype as unknown as { playOneshot: (role: string, ...a: unknown[]) => unknown }).playOneshot;
  (Lc26SoundBank.prototype as unknown as { playOneshot: unknown }).playOneshot = function (this: unknown, role: string, ...rest: unknown[]) {
    played.push(role);
    return play.call(this, role, ...rest);
  };
  const dt = 1 / 60;
  const flat: Lc26AudioInputs = { ...base, rpm: 17000, throttle: 1, pedal: 1, gear: 4, speedKmh: 230, boostBarGauge: 0, limiterRpm: 19000 };
  settle(bank, inside, flat, 0.5);
  played.length = 0;
  const onLevels: number[] = [];
  for (let i = 0; i < 4; i++) {
    ctx.currentTime += dt;
    bank.update({ ...flat, gear: 5 }, dt);
    onLevels.push(sent.get(inside.engine.int.on)?.level ?? NaN);
  }
  const full = lerp(tg.on, 1);
  check(
    "an up-shift shuts the throttle on the two frames inside its 25 ms cut, then it is open again",
    onLevels[0] === 0 && onLevels[1] === 0 && near(onLevels[2], full, 1e-6) && near(sent.get(inside.engine.int.off)?.level ?? NaN, lerp(tg.off, 1), 1e-6),
    onLevels.map((v) => v.toFixed(3)).join(" ")
  );
  check("the up-shift plays the cockpit's own gear sound, nothing of the player's", played.join() === "gear_up_int", played.join());
  played.length = 0;
  const coast: Lc26AudioInputs = { ...flat, gear: 5, throttle: 0, pedal: 0 };
  settle(bank, inside, coast, 0.5);
  played.length = 0;
  ctx.currentTime += dt;
  bank.update({ ...coast, gear: 4 }, dt);
  const blipOn = sent.get(inside.engine.int.on)?.level ?? NaN;
  for (let i = 0; i < 3; i++) {
    ctx.currentTime += dt;
    bank.update({ ...coast, gear: 4 }, dt);
  }
  check(
    "a down-shift blips the throttle to 0.75 (drivetrain.ini AUTOBLIP) and lets it close by 40 ms",
    near(blipOn, lerp(tg.on, 0.75), 1e-6) && (sent.get(inside.engine.int.on)?.level ?? NaN) === lerp(tg.on, 0),
    `${blipOn.toFixed(3)} at the blip`
  );
  check("the down-shift plays the cockpit's own down-shift sound, and no backfire pop of the player's", played.join() === "gear_down_int", played.join());
  const tr = settle(bank, inside, { ...flat, speedKmh: 200 }, 0.5);
  const mix = m.transmissionMix!;
  check(
    "the transmission: its one recording at road speed, at its event's throttle curve and the view's level",
    !!inside.transOn && tr.transX === 200 && near(tr.transOn, lerp(mix.throttleGain, 1) * mix.view.int, 1e-6) &&
      inside.transOn.voices.length === 1 && near(voiceState(inside.transOn, inside.transOn.voices[0].key).gain, lerp(m.transmission[0].gain!, 200) * tr.transOn, 1e-4),
    `${tr.transOn.toFixed(3)} x ${lerp(m.transmission[0].gain!, 200).toFixed(3)} at 200 km/h`
  );
  (Lc26SoundBank.prototype as unknown as { playOneshot: unknown }).playOneshot = play;
}

async function main() {
  mixingMaths();
  await bankWithoutSections();
  await bankWithSections("the LC25 Prototype's, in the repository", "/cars/lc25/audio/", { required: true, viewTone: true });
  // Its Engine Lab engine renders the cockpit and the outside itself, with no tone stage on top
  await bankWithSections("the LC-LMDH's", "/cars/lc-lmdh/audio/", { required: false, viewTone: false });
  wakingLoops();
  await bankOwnMix();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
