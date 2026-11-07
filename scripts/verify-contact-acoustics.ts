/**
 * Verification suite for the contact acoustics rig (`src/lib/sim/contact-acoustics.ts`) as CarAudio plays it: every
 * check drives `CarAudioEngine.update` with a telemetry fixture on a mock Web Audio graph, and reads the result off
 * the AudioParams (the value each was last set or targeted to) and the node connections. The rig's voices are found
 * by what drives them, not by reaching into either class.
 *
 * Run with: npx tsx scripts/verify-contact-acoustics.ts
 */

import { BMW_M4_GT3_SOUND, CarAudioEngine } from "../src/lib/sim/CarAudio";
import type { CarTelemetry } from "../src/types/f1";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Mock Web Audio: AudioParams throw on non-finite values, as the browsers' do
// ---------------------------------------------------------------------------------------------------------------

function assertFinite(...xs: number[]): void {
  for (const x of xs) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new TypeError(`non-finite AudioParam value ${x}`);
  }
}

class MockParam {
  private v: number;
  /** The value the param is heading for: the last one set or targeted */
  last: number;
  writes = 0;
  /** setValueAtTime calls with a value above zero (the debris clicks) */
  pulses = 0;
  constructor(v: number) {
    this.v = v;
    this.last = v;
  }
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    assertFinite(x);
    this.v = this.last = x;
  }
  setValueAtTime(x: number, t: number) {
    assertFinite(x, t);
    this.last = x;
    this.writes++;
    if (x > 0) this.pulses++;
    return this;
  }
  setTargetAtTime(x: number, t: number, tau: number) {
    assertFinite(x, t, tau);
    this.last = x;
    this.writes++;
    return this;
  }
  linearRampToValueAtTime(x: number, t: number) {
    assertFinite(x, t);
    this.last = x;
    this.writes++;
    return this;
  }
  exponentialRampToValueAtTime(x: number, t: number) {
    assertFinite(x, t);
    this.last = x;
    this.writes++;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class MockNode {
  readonly outs: MockNode[] = [];
  constructor(readonly ctx: MockContext) {
    ctx.nodes.push(this);
  }
  connect<T extends MockNode>(dest: T): T {
    this.outs.push(dest);
    return dest;
  }
  disconnect() {
    this.outs.length = 0;
  }
  params(): MockParam[] {
    return Object.values(this).filter((v): v is MockParam => v instanceof MockParam);
  }
}

class MockGain extends MockNode {
  readonly gain = new MockParam(1);
}
class MockFilter extends MockNode {
  type = "lowpass";
  readonly frequency = new MockParam(350);
  readonly Q = new MockParam(1);
  readonly gain = new MockParam(0);
}
class MockSource extends MockNode {
  type = "sine";
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  startOffset = 0;
  readonly frequency = new MockParam(440);
  readonly playbackRate = new MockParam(1);
  onended: (() => void) | null = null;
  start(_when = 0, offset = 0) {
    this.started = true;
    this.startOffset = offset;
  }
  stop() {
    this.stopped = true;
  }
}
class MockCompressor extends MockNode {
  readonly threshold = new MockParam(-24);
  readonly knee = new MockParam(30);
  readonly ratio = new MockParam(12);
  readonly attack = new MockParam(0.003);
  readonly release = new MockParam(0.25);
}

class MockContext {
  static all: MockContext[] = [];
  readonly nodes: MockNode[] = [];
  readonly sampleRate = 8000;
  currentTime = 0;
  state = "running";
  readonly destination: MockNode;
  constructor() {
    this.destination = new MockNode(this);
    MockContext.all.push(this);
  }
  createGain() {
    return new MockGain(this);
  }
  createBiquadFilter() {
    return new MockFilter(this);
  }
  createOscillator() {
    return new MockSource(this);
  }
  createBufferSource() {
    return new MockSource(this);
  }
  createDynamicsCompressor() {
    return new MockCompressor(this);
  }
  createWaveShaper() {
    return Object.assign(new MockNode(this), { curve: null as Float32Array | null });
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
  }
  decodeAudioData() {
    return Promise.reject(new Error("no audio in the mock"));
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
  get sources(): MockSource[] {
    return this.nodes.filter((n): n is MockSource => n instanceof MockSource);
  }
}

// No sound banks or sample files in the test: CarAudio falls back to its synthesised voices
(globalThis as unknown as { window: unknown }).window = { AudioContext: MockContext };
(globalThis as unknown as { fetch: unknown }).fetch = () => Promise.resolve({ ok: false });

/** Whether `from` reaches `to` through the graph */
function feeds(from: MockNode, to: MockNode): boolean {
  return from === to || from.outs.some((n) => feeds(n, to));
}

// ---------------------------------------------------------------------------------------------------------------
// Telemetry fixture and driving
// ---------------------------------------------------------------------------------------------------------------

type Quad<T> = [T, T, T, T];
const quad = <T>(x: T): Quad<T> => [x, x, x, x];

/** An F1 car at 40 m/s in 5th on the throttle, on asphalt, nothing sliding, bouncing, braking or dirty */
function telemetry(over: Partial<CarTelemetry> = {}): CarTelemetry {
  return {
    speedKmh: 144,
    speedMs: 40,
    rpm: 9000,
    gear: 5,
    throttle: 0.6,
    brake: 0,
    turboBoostBar: 2,
    mgukPowerKw: 120,
    surface: "asphalt",
    wheelSurfaces: quad("asphalt"),
    wheelSlipRatios: quad(0),
    wheelSlipAnglesDeg: quad(0),
    tireSlipRatio: quad(0),
    wheelLoadsN: quad(4000),
    suspensionTravelMm: quad(20),
    suspensionVelocityMs: quad(0),
    brakeTempsC: quad(400),
    tireDirtyLevel: quad(0),
    trackDistanceM: 1000,
    ...over,
  } as CarTelemetry;
}
const steady = (over: Partial<CarTelemetry> = {}) => () => telemetry(over);
type Fixture = (t: number) => CarTelemetry;

interface Run {
  engine: CarAudioEngine;
  ctx: MockContext;
}

function start(): Run {
  const engine = new CarAudioEngine();
  engine.init();
  return { engine, ctx: MockContext.all[MockContext.all.length - 1] };
}

/** One frame of `dt` seconds (the audio clock moves with it) */
function frame(run: Run, tel: CarTelemetry, dt = 1 / 60): void {
  run.ctx.currentTime += dt;
  run.engine.update(tel, dt);
}

/** `seconds` of frames at `hz`, the telemetry a function of the time into this stretch */
function drive(run: Run, seconds: number, hz: number, fixture: Fixture, each?: (t: number) => void): void {
  const frames = Math.round(seconds * hz);
  for (let k = 1; k <= frames; k++) {
    frame(run, fixture(k / hz), 1 / hz);
    each?.(k / hz);
  }
}

/** A voice's level, by its gain node's index; NaN (failing every check on it) when the voice was never found */
const gainOf = (run: Run, index: number) => (run.ctx.nodes[index] as MockGain | undefined)?.gain.last ?? NaN;

/** Every gain node's level after one second of `fixture`, by creation order (the same in every run) */
function gainLevels(fixture: Fixture): number[] {
  const run = start();
  drive(run, 1, 60, fixture);
  return run.ctx.nodes.map((n) => (n instanceof MockGain ? n.gain.last : 0));
}

/** The gain nodes that open further under fixture `b` than under `a`: the voices `b` brings in */
function voicesRaisedBy(a: Fixture, b: Fixture): number[] {
  const la = gainLevels(a);
  return gainLevels(b).flatMap((l, i) => (l > la[i] + 1e-6 ? [i] : []));
}

const clicksIn = (run: Run) =>
  run.ctx.nodes.reduce((n, node) => n + (node instanceof MockGain ? node.gain.pulses : 0), 0);

// ---------------------------------------------------------------------------------------------------------------

console.log("1. Tyre squeal, kerb and off-track: CarAudio's voices only, the rig adds none");
{
  const slide = voicesRaisedBy(steady(), steady({ wheelSlipAnglesDeg: quad(12), tireSlipRatio: quad(2) }));
  check("A slide brings in exactly two voices: CarAudio's squeal tone and scrub", slide.length === 2, `gains ${slide}`);

  const kerb = voicesRaisedBy(steady(), steady({ surface: "kerb", wheelSurfaces: quad("kerb") }));
  check("A kerb brings in exactly one rumble voice", kerb.length === 1, `gain ${kerb}`);

  for (const surface of ["grass", "runoff"] as const) {
    const off = voicesRaisedBy(steady(), steady({ surface, wheelSurfaces: quad(surface) }));
    check(`${surface}: exactly one off-track voice comes in`, off.length === 1, `gain ${off}`);
  }
}

console.log("\n2. Each of the rig's four sounds follows its own input");
const roarV = voicesRaisedBy(steady({ wheelLoadsN: quad(2000) }), steady({ wheelLoadsN: quad(12000) }));
const thumpV = voicesRaisedBy(steady(), steady({ suspensionVelocityMs: quad(0.6) }));
// Same |velocity| both ways, so the thump stays put and only the rattle hears the reversals
const reversing: Fixture = (t) => telemetry({ suspensionVelocityMs: quad(Math.round(t * 60) % 2 === 0 ? 0.3 : -0.3) });
const rattleV = voicesRaisedBy(steady({ suspensionVelocityMs: quad(0.3) }), reversing);
const braking = { throttle: 0, brake: 0.3 };
const squealV = voicesRaisedBy(
  steady({ ...braking, brakeTempsC: quad(100) }),
  steady({ ...braking, brakeTempsC: quad(400) })
);
const [ROAR, THUMP, RATTLE, SQUEAL] = [roarV[0], thumpV[0], rattleV[0], squealV[0]];
{
  check("Tyre load raises one voice: the road roar", roarV.length === 1, `gain ${roarV}`);
  check("Shock velocity raises one voice: the damper thump", thumpV.length === 1, `gain ${thumpV}`);
  check("Reversing shock velocity raises one voice: the chassis rattle", rattleV.length === 1, `gain ${rattleV}`);
  check("Discs in their temperature window raise one voice: the brake squeal", squealV.length === 1, `gain ${squealV}`);
  check("They are four different voices", new Set([ROAR, THUMP, RATTLE, SQUEAL]).size === 4);

  const roarOn = (surface: "asphalt" | "kerb") => gainLevels(steady({ wheelSurfaces: quad(surface) }))[ROAR];
  check("The roar is an asphalt sound: it fades out on a kerb", roarOn("kerb") < 0.01 * roarOn("asphalt"));

  const squealAt = (brake: number) => gainLevels(steady({ throttle: 0, brake }))[SQUEAL];
  check(
    "A disc squeals under a light pedal, not clamped hard",
    squealAt(0.3) > 0 && squealAt(0.9) === 0,
    `0.3: ${squealAt(0.3).toExponential(2)}, 0.9: ${squealAt(0.9)}`
  );

  const clicks = (dirt: number) => {
    const run = start();
    drive(run, 1, 60, steady({ tireDirtyLevel: quad(dirt) }));
    return clicksIn(run);
  };
  const [clean, dirty] = [clicks(0), clicks(0.6)];
  check("Dirty tyres click, clean ones do not", clean === 0 && dirty > 5, `${clean} / ${dirty} in 1 s`);
}

console.log("\n3. The physics car, not the sound bank, decides open- or closed-wheel");
{
  const squeal = (carId: string | null, bmwBank: boolean) => {
    const run = start();
    if (bmwBank) run.engine.setCar(BMW_M4_GT3_SOUND);
    const f12026 = carId ? ({ carId } as CarTelemetry["f12026"]) : undefined;
    drive(run, 1, 60, steady({ ...braking, f12026 }));
    return gainOf(run, SQUEAL);
  };
  const f1 = squeal(null, false);
  const gt3 = squeal("amg-gt3", false);
  check(
    "The GT3's steel discs squeal louder than the F1 car's carbon ones",
    gt3 > 1.5 * f1,
    `${gt3.toExponential(2)} vs ${f1.toExponential(2)}`
  );
  check("A GT3 sound bank on F1 physics squeals like the F1 car", squeal("f12026-car", true) === f1);
}

console.log("\n4. The same at 60 and 144 frames a second");
{
  // A lap-ish stretch: speed swinging, a kerb, a braking zone, the dampers working, the tyres sliding and dirty.
  // The steps sit on twelfths of a second, where frames of both rates end, and take effect in the frame after
  const lap: Fixture = (t) =>
    telemetry({
      speedKmh: 160 + 80 * Math.sin(t),
      throttle: t <= 1.5 ? 0.8 : 0,
      brake: t <= 1.5 ? 0 : 0.35,
      wheelSurfaces: t > 0.75 && t <= 1.25 ? quad("kerb") : quad("asphalt"),
      suspensionVelocityMs: quad(1.0 * Math.sin(2 * Math.PI * 6 * t)),
      tireSlipRatio: quad(2 + 2 * Math.sin(3 * t)),
      wheelLoadsN: quad(4000 + 2000 * Math.sin(2 * t)),
      tireDirtyLevel: [0.9, 0.7, 0.5, 0.3],
    });
  // In twelfths of a second; 10, 16 and 19 are 83 ms on from the kerb, off it and onto the brakes, mid-fade
  const sampleAt = new Set([7, 10, 13, 16, 19, 25, 31, 36]);
  const trace = (hz: number) => {
    const run = start();
    const samples: number[][] = [];
    drive(run, 3, hz, lap, (t) => {
      const twelfths = Math.round(t * 12);
      if (Math.abs(t * 12 - twelfths) < 1e-9 && sampleAt.has(twelfths)) {
        samples.push([ROAR, THUMP, RATTLE, SQUEAL].map((i) => gainOf(run, i)));
      }
    });
    return { samples, clicks: clicksIn(run) };
  };
  const a = trace(60);
  const b = trace(144);
  ["roar", "thump", "rattle", "brake squeal"].forEach((name, v) => {
    const peak = Math.max(...a.samples.map((s) => s[v]), ...b.samples.map((s) => s[v]));
    const worst = Math.max(...a.samples.map((s, k) => Math.abs(s[v] - b.samples[k][v])));
    check(
      `${name}: within 5 % of its peak at every sample`,
      peak > 0 && worst <= 0.05 * peak,
      `worst ${((100 * worst) / peak).toFixed(1)} %`
    );
  });
  check(
    "Debris: as many clicks at either rate",
    Math.abs(a.clicks - b.clicks) <= 0.03 * a.clicks,
    `${a.clicks} at 60 Hz, ${b.clicks} at 144 Hz`
  );
}

console.log("\n5. No thump or rattle burst across a pause, a teleport or a car change");
{
  const bouncing = steady({ suspensionVelocityMs: quad(0.8), suspensionTravelMm: quad(20) });
  // Where the car is after the break: settled, the travel somewhere else entirely
  const after = (trackDistanceM = 1000) =>
    telemetry({ suspensionVelocityMs: quad(0), suspensionTravelMm: quad(60), trackDistanceM });

  const control = start();
  drive(control, 1, 60, bouncing);
  frame(control, after());
  const burst = gainOf(control, RATTLE);
  const reversingRattle = gainLevels(reversing)[RATTLE];
  check(
    "Control: the same velocity step mid-drive does rattle, so the checks below can see a burst",
    burst > 0.2 * reversingRattle,
    `${burst.toExponential(2)}, ${(burst / reversingRattle).toFixed(2)} of the reversing dampers' rattle`
  );

  const breaks: [string, (run: Run) => CarTelemetry][] = [
    ["pause and resume", (run) => {
      run.engine.setPaused(true);
      run.ctx.currentTime += 2;
      run.engine.setPaused(false);
      return after();
    }],
    ["teleport while driving", () => after(3000)],
    ["car change", (run) => {
      run.engine.setCar(BMW_M4_GT3_SOUND);
      return after();
    }],
    ["suspended context", (run) => {
      run.ctx.state = "suspended";
      run.engine.update(after(), 1 / 60);
      run.ctx.state = "running";
      return after();
    }],
  ];
  for (const [name, breakIt] of breaks) {
    const run = start();
    drive(run, 1, 60, bouncing);
    frame(run, breakIt(run));
    const thump = gainOf(run, THUMP);
    const rattle = gainOf(run, RATTLE);
    check(
      `${name}: silent dampers on the first frame after`,
      thump === 0 && rattle < 0.01 * burst,
      `thump ${thump.toExponential(2)}, rattle ${rattle.toExponential(2)}`
    );
  }
}

console.log("\n6. Non-finite telemetry neither throws nor sticks");
{
  // The car changes what it does across the bad frames (dampers reversing, then steady; then the brakes on), so a
  // level stuck from before them shows against the clean run
  const before: Partial<CarTelemetry> = { tireDirtyLevel: quad(0.4), wheelSlipAnglesDeg: quad(6) };
  const timeline = (bad: Partial<CarTelemetry>): Fixture => (t) =>
    t <= 0.5
      ? telemetry({ ...before, suspensionVelocityMs: quad(Math.round(t * 60) % 2 === 0 ? 0.3 : -0.3) })
      : t <= 0.7
        ? telemetry({ ...before, ...bad })
        : telemetry({ ...before, ...braking, suspensionVelocityMs: quad(0.6) });
  const clean = start();
  drive(clean, 2, 60, timeline({}));
  const cleanGains = clean.ctx.nodes.map((n) => (n instanceof MockGain ? n.gain.last : 0));

  const bads: Partial<CarTelemetry>[] = [
    { speedKmh: NaN },
    { rpm: NaN },
    { throttle: NaN },
    { brake: NaN },
    { suspensionVelocityMs: quad(Infinity) },
    { wheelSlipRatios: quad(NaN) },
    { tireSlipRatio: quad(NaN) },
    { wheelLoadsN: quad(NaN) },
    { brakeTempsC: quad(NaN) },
    { liveTuner: { brakeBiasPct: NaN } as CarTelemetry["liveTuner"] },
  ];
  for (const bad of bads) {
    const run = start();
    let error = "";
    try {
      drive(run, 2, 60, timeline(bad));
    } catch (e) {
      error = String(e);
    }
    const worst = run.ctx.nodes.reduce(
      (m, n, i) => (n instanceof MockGain ? Math.max(m, Math.abs(n.gain.last - cleanGains[i])) : m),
      0
    );
    check(
      `${Object.keys(bad)[0]}: no throw, and back to the clean run's levels after`,
      !error && worst < 1e-6,
      error || `worst ${worst.toExponential(1)}`
    );
  }
}

console.log("\n7. Noise loops and teardown");
{
  const run = start();
  drive(run, 0.5, 60, steady({ brake: 0.3, suspensionVelocityMs: quad(0.4), tireDirtyLevel: quad(0.5) }));
  const debrisGain = run.ctx.nodes.findIndex((n) => n instanceof MockGain && n.gain.pulses > 0);
  const loops = run.ctx.sources.filter((s) => s.buffer !== null);
  const rigLoops = loops.filter((s) => [ROAR, RATTLE, debrisGain].some((i) => feeds(s, run.ctx.nodes[i])));
  const alignedWithAnother = rigLoops.filter((s) =>
    loops.some((o) => o !== s && o.buffer === s.buffer && o.startOffset === s.startOffset)
  );
  check(
    "The rig's roar, rattle and debris loops each start at their own point of the shared noise",
    rigLoops.length === 3 && alignedWithAnother.length === 0,
    `${rigLoops.length} rig loops, offsets ${rigLoops.map((s) => s.startOffset.toFixed(3))}`
  );

  run.engine.dispose();
  const playing = run.ctx.sources.filter((s) => s.started && !s.stopped && run.ctx.state !== "closed");
  check("dispose() leaves no source playing", playing.length === 0, `${run.ctx.sources.length} sources`);
  const writes = () => run.ctx.nodes.reduce((n, node) => n + node.params().reduce((m, p) => m + p.writes, 0), 0);
  const before = writes();
  run.engine.update(telemetry(), 1 / 60);
  check("update() after dispose() touches nothing", writes() === before);
}

console.log(`\nContact acoustics verification: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
