/**
 * Verification suite for the contact acoustics rig (`src/lib/sim/contact-acoustics.ts`) as CarAudio plays it: every
 * check drives `CarAudioEngine.update` with a telemetry fixture on a mock Web Audio graph, and reads the result off
 * the AudioParams (the last value each was set to) and the node connections.
 *
 * Run with: npx tsx scripts/verify-contact-acoustics.ts
 */

import { CarAudioEngine } from "../src/lib/sim/CarAudio";
import type { CarTelemetry } from "../src/types/f1";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
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
    if (x > 0) this.pulses++;
    return this;
  }
  setTargetAtTime(x: number, t: number, tau: number) {
    assertFinite(x, t, tau);
    this.last = x;
    return this;
  }
  linearRampToValueAtTime(x: number, t: number) {
    assertFinite(x, t);
    this.last = x;
    return this;
  }
  exponentialRampToValueAtTime(x: number, t: number) {
    assertFinite(x, t);
    this.last = x;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class MockNode {
  readonly outs: MockNode[] = [];
  started = false;
  stopped = false;
  startOffset = 0;
  constructor(readonly ctx: MockContext, readonly kind: string) {
    ctx.nodes.push(this);
  }
  connect<T extends MockNode>(dest: T): T {
    this.outs.push(dest);
    return dest;
  }
  disconnect() {
    this.outs.length = 0;
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
    this.destination = new MockNode(this, "destination");
    MockContext.all.push(this);
  }
  createGain() {
    return new MockGain(this, "gain");
  }
  createBiquadFilter() {
    return new MockFilter(this, "filter");
  }
  createOscillator() {
    return new MockSource(this, "oscillator");
  }
  createBufferSource() {
    return new MockSource(this, "buffer");
  }
  createDynamicsCompressor() {
    return new MockCompressor(this, "compressor");
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


// ---------------------------------------------------------------------------------------------------------------
// Telemetry fixture and driving
// ---------------------------------------------------------------------------------------------------------------

type Quad<T> = [T, T, T, T];
const quad = <T>(x: T): Quad<T> => [x, x, x, x];

/** A car at 40 m/s in 5th on the throttle, on asphalt, nothing sliding, bouncing, braking or dirty */
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

interface Run {
  engine: CarAudioEngine;
  ctx: MockContext;
}

function start(): Run {
  const engine = new CarAudioEngine();
  engine.init();
  const ctx = MockContext.all[MockContext.all.length - 1];
  return { engine, ctx };
}

/** Drive `seconds` of frames at `hz`, the telemetry a function of the time into the run */
function drive(run: Run, seconds: number, hz: number, fixture: (t: number) => CarTelemetry): void {
  const dt = 1 / hz;
  const frames = Math.round(seconds * hz);
  for (let k = 0; k < frames; k++) {
    run.ctx.currentTime += dt;
    run.engine.update(fixture((k + 1) * dt), dt);
  }
}

/** Every gain node's level after one second of `fixture`, by creation order (the same in every run) */
function gainLevels(fixture: (t: number) => CarTelemetry): number[] {
  const run = start();
  drive(run, 1, 60, fixture);
  return run.ctx.nodes.map((n) => (n instanceof MockGain ? n.gain.last : 0));
}

/** The gain nodes that open further under fixture `b` than under `a`: the voices `b` brings in */
function voicesRaisedBy(a: (t: number) => CarTelemetry, b: (t: number) => CarTelemetry): number[] {
  const la = gainLevels(a);
  return gainLevels(b).flatMap((l, i) => (l > la[i] + 1e-6 ? [i] : []));
}

const steady = (over: Partial<CarTelemetry> = {}) => () => telemetry(over);

// ---------------------------------------------------------------------------------------------------------------

console.log("1. The rig plays none of CarAudio's tyre, kerb and off-track voices again");
{
  const slide = voicesRaisedBy(steady(), steady({ wheelSlipAnglesDeg: quad(12), tireSlipRatio: quad(2) }));
  check("A slide brings in exactly two voices: CarAudio's squeal tone and scrub", slide.length === 2, `${slide}`);

  const kerb = voicesRaisedBy(steady(), steady({ surface: "kerb", wheelSurfaces: quad("kerb") }));
  check("A kerb brings in exactly one rumble voice", kerb.length === 1, `${kerb}`);

  for (const surface of ["grass", "runoff"] as const) {
    const off = voicesRaisedBy(steady(), steady({ surface, wheelSurfaces: quad(surface) }));
    check(`${surface}: exactly one off-track voice comes in`, off.length === 1, `${off}`);
  }
}

console.log("\n2. Each of the rig's four sounds follows its own input");
{
  const roar = voicesRaisedBy(steady({ wheelLoadsN: quad(2000) }), steady({ wheelLoadsN: quad(12000) }));
  check("More tyre load raises one voice (the road roar)", roar.length === 1, `${roar}`);

  const thump = voicesRaisedBy(steady(), steady({ suspensionVelocityMs: quad(0.6) }));
  check("Shock velocity raises one voice (the damper thump)", thump.length === 1, `${thump}`);

  // Same |velocity| both ways, so the thump stays put and only the rattle hears the reversals
  const alternating = (t: number) =>
    telemetry({ suspensionVelocityMs: quad(Math.round(t * 60) % 2 === 0 ? 0.3 : -0.3) });
  const rattle = voicesRaisedBy(steady({ suspensionVelocityMs: quad(0.3) }), alternating);
  check("Reversing shock velocity raises one voice (the chassis rattle)", rattle.length === 1, `${rattle}`);

  const braking = { throttle: 0, brake: 0.3 };
  const squeal = voicesRaisedBy(
    steady({ ...braking, brakeTempsC: quad(100) }),
    steady({ ...braking, brakeTempsC: quad(400) })
  );
  check("Discs in their squeal window raise one voice (the brake squeal)", squeal.length === 1, `${squeal}`);

  const clicks = (dirt: number) => {
    const run = start();
    drive(run, 1, 60, steady({ tireDirtyLevel: quad(dirt) }));
    return run.ctx.nodes.reduce((sum, n) => sum + (n instanceof MockGain ? n.gain.pulses : 0), 0);
  };
  const clean = clicks(0);
  const dirty = clicks(0.6);
  check("Dirty tyres click, clean ones do not", clean === 0 && dirty > 5, `clean ${clean}, dirty ${dirty} clicks in 1 s`);
}

console.log("\n3. Teardown");
{
  const run = start();
  drive(run, 0.5, 60, steady({ brake: 0.3, suspensionVelocityMs: quad(0.4), tireDirtyLevel: quad(0.5) }));
  run.engine.dispose();
  const playing = run.ctx.sources.filter((s) => s.started && !s.stopped && run.ctx.state !== "closed");
  check("dispose() leaves no source playing", playing.length === 0, `${run.ctx.sources.length} sources`);
}

console.log(`\nContact acoustics verification: all ${passed} checks passed.`);
