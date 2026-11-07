/**
 * Verification for the force-feedback post-processing adapted from Adam's FFB Toolbox (downforce compensation,
 * collision protection, peak-relative slip and shift cues):
 *   npx tsx scripts/verify-ffb-toolbox.ts
 */
import assert from "node:assert/strict";
import type { CarTelemetry } from "../src/types/f1";
import { DEFAULT_WHEEL_SETTINGS, type WheelSettings } from "../src/lib/input/device-input";
import {
  clampEased,
  COLLISION_BAND,
  COLLISION_FADE_S,
  COLLISION_HOLD_S,
  CollisionGuard,
  DF_COMP_MIN_FRONT_N,
  DF_COMP_MIN_MULT,
  DownforceCompensator,
  downforceCompMult,
  FRONT_SLIP_CUE_END,
  FRONT_SLIP_CUE_START,
  progressiveCue,
  SHIFT_LOOKAHEAD_S,
  ShiftCue,
  slipCue,
} from "../src/lib/input/ffb-toolbox";
import { WheelFfbClient } from "../src/lib/input/wheel-ffb";
import { CRASH_G } from "../src/lib/sim/handling-cues";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (|diff| = ${Math.abs(a - b)})`);

const wheelWith = (patch: Partial<WheelSettings>): WheelSettings => ({
  ...DEFAULT_WHEEL_SETTINGS,
  ffbEnabled: true,
  ffbGain: 1,
  ffbMinForce: 0,
  ffbFilterS: 0,
  ffbDamping: 0,
  ...patch,
});

/** An F1 car at speed: 3 kN static on the front axle, `aeroN` of front downforce on top */
const carTel = (aeroN: number, torque = 0.4, extra: Partial<CarTelemetry> = {}): CarTelemetry =>
  ({
    speedKmh: 290,
    ffbTorqueNorm: torque,
    ffbSubframeSamples: [torque, torque, torque],
    wheelLoadsN: [1500 + aeroN / 2, 1500 + aeroN / 2, 2000, 2000],
    frontDownforceN: aeroN,
    lateralG: 1,
    longitudinalG: 0,
    ...extra,
  }) as unknown as CarTelemetry;

console.log("1. Downforce compensation");

check("multiplier is (static / current)^k: off at k = 0, never above 1, floored, 1 when airborne or NaN", () => {
  near(downforceCompMult(3000, 9000, 0), 1);
  near(downforceCompMult(3000, 9000, 1), 1 / 3);
  near(downforceCompMult(3000, 9000, 0.5), Math.sqrt(1 / 3));
  near(downforceCompMult(3000, 3000, 1), 1);
  near(downforceCompMult(3000, 2000, 1), 1, 0); // a light front (crest) is never boosted
  near(downforceCompMult(1000, 100_000, 1), DF_COMP_MIN_MULT);
  near(downforceCompMult(3000, DF_COMP_MIN_FRONT_N - 1, 1), 1);
  near(downforceCompMult(-50, 4000, 1), 1);
  near(downforceCompMult(Number.NaN, 4000, 1), 1);
  near(downforceCompMult(3000, Number.POSITIVE_INFINITY, 1), 1);
});

check("compensator takes the aero share out of wheelLoadsN, keeps weight transfer, and smooths a kerb spike", () => {
  const comp = new DownforceCompensator();
  // 6 kN of front downforce on 3 kN static: the aero-free share is a third
  for (let i = 0; i < 240; i++) comp.step([4500, 4500, 2000, 2000], 6000, 1 / 60, 1);
  near(comp.staticFrontN, 3000, 1e-3);
  near(comp.currentFrontN, 9000, 1e-3);
  near(comp.mult, 1 / 3, 1e-6);
  // Braking puts 2 kN more on the fronts: that load is mechanical, so less of the force is taken out
  for (let i = 0; i < 240; i++) comp.step([5500, 5500, 1000, 1000], 6000, 1 / 60, 1);
  near(comp.mult, 5000 / 11000, 1e-6);
  // One 16 ms kerb strike doubling the front load moves the multiplier only a little
  const before = comp.mult;
  comp.step([11000, 11000, 1000, 1000], 6000, 1 / 60, 1);
  assert.ok(Math.abs(comp.mult - before) < 0.04, `kerb spike smoothed (${before} → ${comp.mult})`);
});

check("compensator is a no-op when off, without loads, or without downforce", () => {
  const comp = new DownforceCompensator();
  assert.equal(comp.step([4500, 4500, 2000, 2000], 6000, 1 / 60, 0), 1);
  assert.equal(comp.step(undefined, 6000, 1 / 60, 1), 1);
  assert.equal(comp.step([Number.NaN, 4500, 2000, 2000], 6000, 1 / 60, 1), 1);
  const noAero = new DownforceCompensator();
  assert.equal(noAero.step([1500, 1500, 2000, 2000], undefined, 1 / 60, 1), 1);
  assert.equal(new DownforceCompensator().step([0, 0, 0, 0], 6000, 1 / 60, 1), 1, "airborne fronts");
});

check("WheelFfbClient scales the frame force and the 500 Hz subframes by the multiplier", () => {
  const plain = new WheelFfbClient();
  const comp = new WheelFfbClient();
  const tel = carTel(6000);
  let t = 1000;
  for (let i = 0; i < 150; i++, t += 16) {
    plain.update(tel, wheelWith({ ffbDownforceComp: 0 }), [], t, true, "f12026-car");
    comp.update(tel, wheelWith({ ffbDownforceComp: 1 }), [], t, true, "f12026-car");
  }
  near(plain.force, 0.4, 1e-4);
  near(comp.force, 0.4 / 3, 1e-3);
  // The wheel plays the subframes, so they carry the multiplier too
  const played: number[] = [];
  comp.hidSink = (f) => played.push(f);
  comp.update(tel, wheelWith({ ffbDownforceComp: 1 }), [], t, true, "f12026-car");
  comp.hidSink = null;
  assert.ok(played.length > 0, "a subframe was played");
  near(played[0], 0.4 / 3, 1e-3);
  near(comp.meter.downforceMult ?? 0, 1 / 3, 1e-6);
  // At a hairpin (no aero) the compensation leaves the force alone
  const slow = new WheelFfbClient();
  for (let i = 0; i < 5; i++, t += 16) {
    slow.update(carTel(0, 0.4, { speedKmh: 70 } as Partial<CarTelemetry>), wheelWith({ ffbDownforceComp: 1 }), [], t, true, "f12026-car");
  }
  near(slow.force, 0.4, 1e-4);
});

console.log("2. Collision protection");

check("clampEased is the identity inside, hard at the limits, and continuous through the shoulders", () => {
  near(clampEased(0.3, 0, 1, 0.5), 0.3);
  near(clampEased(-1, 0, 1, 0.5), 0);
  near(clampEased(2, 0, 1, 0.5), 1);
  // Shoulder of width 0.5 centred on each limit: identity again from 0.25 / up to 0.75
  near(clampEased(0.25, 0, 1, 0.5), 0.25);
  near(clampEased(0.75, 0, 1, 0.5), 0.75);
  near(clampEased(-0.25, 0, 1, 0.5), 0);
  let prev = clampEased(-0.5, 0, 1, 0.5);
  for (let v = -0.5; v <= 1.5; v += 0.001) {
    const y = clampEased(v, 0, 1, 0.5);
    assert.ok(y >= prev - 1e-12 && y - prev < 0.0011, `monotone and continuous at ${v}`);
    prev = y;
  }
  near(clampEased(5, 0, 1, 0), 1);
});

check("idle guard is the identity", () => {
  const g = new CollisionGuard();
  let seed = 7;
  for (let i = 0; i < 500; i++) {
    seed = (seed * 16807) % 2147483647;
    const x = (seed / 2147483647) * 2 - 1;
    assert.equal(g.step(x, 0.002), x);
  }
  assert.equal(g.blend, 0);
  g.sustain(); // airborne without a contact never starts it
  assert.equal(g.active, false);
  assert.equal(g.step(0.9, 0.002), 0.9);
});

check("a contact seeds the limiter from the calmest of the last 3 samples and holds back the spike", () => {
  const g = new CollisionGuard();
  for (const x of [0.5, 0.42, -0.3, 0.38]) g.step(x, 0.002); // remembers -0.3, 0.38 and … 0.42
  g.trigger();
  // The hit drives the input to full scale: the output starts from -0.3 and may stray only by the band
  const first = g.step(1, 0.002);
  assert.ok(first <= -0.3 + COLLISION_BAND + 0.02, `first protected sample ${first}`);
  // 50 ms of full-scale input: still far below it (the limiter's time constant is 0.22 s)
  let out = first;
  for (let i = 0; i < 25; i++) out = g.step(1, 0.002);
  assert.ok(out < 0.1, `slewed after 50 ms: ${out}`);
  assert.ok(out > first, "but it does follow");
});

check("a falling force is let through fast, and the protection fades out after the hold", () => {
  const g = new CollisionGuard();
  for (let i = 0; i < 3; i++) g.step(0.8, 0.002);
  g.trigger();
  for (let i = 0; i < 5; i++) g.step(0.8, 0.002);
  // The force drops to zero: within 100 ms the output is close to it (release blend 0.1 → τ 22 ms)
  let out = 1;
  for (let i = 0; i < 50; i++) out = g.step(0, 0.002);
  assert.ok(Math.abs(out) < 0.02, `released to ${out}`);
  // No more contacts: after the hold the guard is the identity again
  for (let t = 0; t < COLLISION_HOLD_S; t += 0.002) g.step(0.2, 0.002);
  assert.equal(g.active, false);
  assert.equal(g.step(0.6, 0.002), 0.6);
});

check("sustain keeps a running protection on, a held contact keeps its limiter", () => {
  const g = new CollisionGuard();
  for (let i = 0; i < 3; i++) g.step(0.1, 0.002);
  g.trigger();
  for (let t = 0; t < COLLISION_HOLD_S - COLLISION_FADE_S * 0.25; t += 0.002) {
    g.step(0.1, 0.002);
    g.sustain();
  }
  assert.ok(g.blend > 0.99, `still at full protection (${g.blend})`);
  for (let i = 0; i < 3; i++) g.step(0.9, 0.002);
  g.trigger(); // a contact while one is held does not re-seed from the recent (spiking) samples
  assert.ok(g.step(0.9, 0.002) < 0.9 - COLLISION_BAND, "limiter kept, not reset to the spike");
});

/** Runs a client through 10 frames of `tel`, then returns the force after one frame of `hit` */
function crashForce(wheel: WheelSettings, tel: CarTelemetry, hit: CarTelemetry): { before: number; after: number; client: WheelFfbClient } {
  const client = new WheelFfbClient();
  let t = 1000;
  for (let i = 0; i < 10; i++, t += 16) client.update(tel, wheel, [], t, true, "f12026-car");
  const before = client.force;
  client.update(hit, wheel, [], t, true, "f12026-car");
  return { before, after: client.force, client };
}

check("WheelFfbClient arms the guard on a barrier touch or a new impact, not on an old impact", () => {
  const channels = (over: object) => ({ absActive: false, wallContact: false, wallImpact: null, ...over });
  const calm = carTel(0, 0.3, { speedKmh: 150, f12026: channels({}) } as unknown as Partial<CarTelemetry>);
  const spike = (over: object) =>
    carTel(0, 0.95, { speedKmh: 150, f12026: channels(over) } as unknown as Partial<CarTelemetry>);
  const touch = crashForce(wheelWith({}), calm, spike({ wallContact: true }));
  assert.ok(touch.after < touch.before + 0.25 * (0.95 - touch.before), `barrier touch held back (${touch.before} → ${touch.after})`);
  assert.ok((touch.client.meter.collisionGuard ?? 0) > 0.99);
  const impact = crashForce(wheelWith({}), calm, spike({ wallImpact: { speedMs: 20, atMs: 5000 } }));
  assert.ok(impact.after < impact.before + 0.25 * (0.95 - impact.before), `new impact held back (${impact.before} → ${impact.after})`);
  // An impact already in the telemetry when the car is first driven is not a new one
  const old = carTel(0, 0.3, { speedKmh: 150, f12026: channels({ wallImpact: { speedMs: 20, atMs: 5000 } }) } as unknown as Partial<CarTelemetry>);
  const stale = crashForce(wheelWith({}), old, carTel(0, 0.95, { speedKmh: 150, f12026: channels({ wallImpact: { speedMs: 20, atMs: 5000 } }) } as unknown as Partial<CarTelemetry>));
  near(stale.after, 0.95, 1e-3);
  assert.equal(stale.client.meter.collisionGuard, 0);
  // Switched off, the hit goes straight through
  const off = crashForce(wheelWith({ ffbCollisionGuard: false }), calm, spike({ wallContact: true }));
  near(off.after, 0.95, 1e-3);
});

check(`WheelFfbClient arms the guard on a crash past ${CRASH_G} g with no barrier channel, and only past it`, () => {
  const calm = carTel(0, 0.3, { speedKmh: 150, lateralG: 2, longitudinalG: 1 });
  // The hit throws the kingpin torque to near full scale for the frame: hypot(9, 6.5) = 11.1 g
  const hit = carTel(0, 0.95, { speedKmh: 150, lateralG: 9, longitudinalG: 6.5 });
  const crash = crashForce(wheelWith({}), calm, hit);
  assert.ok(crash.after < crash.before + 0.25 * (0.95 - crash.before), `crash spike held back (${crash.before} → ${crash.after})`);
  assert.ok((crash.client.meter.collisionGuard ?? 0) > 0.99);
  // Hard cornering and braking below the threshold (hypot(7, 6) = 9.2 g) is driving, not a crash
  const hard = crashForce(wheelWith({}), calm, carTel(0, 0.95, { speedKmh: 150, lateralG: 7, longitudinalG: 6 }));
  near(hard.after, 0.95, 1e-3);
  assert.equal(hard.client.meter.collisionGuard, 0);
  // Switched off, the crash goes straight through
  const off = crashForce(wheelWith({ ffbCollisionGuard: false }), calm, hit);
  near(off.after, 0.95, 1e-3);
});

console.log("3. Slip and shift cues");

check("progressive cue: silent below the start, a clear onset, square-law ramp to 1 at the end", () => {
  assert.equal(progressiveCue(0.5, 1, 2), 0);
  assert.equal(progressiveCue(Number.NaN, 1, 2), 0);
  near(progressiveCue(1.1, 1, 2), 0.3 + 0.7 * 0.01);
  near(progressiveCue(2, 1, 2), 1);
  near(progressiveCue(5, 1, 2), 1);
  let prev = 0;
  for (let x = 0.9; x <= 2.1; x += 0.005) {
    const y = progressiveCue(x, 1, 2);
    assert.ok(y >= prev - 1e-12, `monotone at ${x}`);
    prev = y;
  }
});

check("slip cue reads the peak: fronts from just before it, rears only spinning under power", () => {
  assert.equal(slipCue(0.9, 0, 0, false), 0, "grip in hand: no cue");
  assert.ok(slipCue(1.0, 0, 0, false) > 0.1, "at the peak the cue is on (the old fixed 1.15 / 0.12 thresholds were not)");
  near(slipCue(FRONT_SLIP_CUE_END, 0, 0, false), 1);
  assert.ok(slipCue(FRONT_SLIP_CUE_START + 0.2, 0, 0, false) < slipCue(FRONT_SLIP_CUE_START + 0.4, 0, 0, false));
  assert.equal(slipCue(0.5, 1.4, 0, false), 0, "rear slide off the throttle: the rack SAT tells that one");
  assert.ok(slipCue(0.5, 1.4, 0.8, false) > 0.3, "wheelspin under power");
  assert.equal(slipCue(0.5, 1.4, 0.8, true), 0, "traction control already catching it");
});

check("shift cue comes on ahead of the shift point on rising revs, and resets on the next gear or a lift", () => {
  const cue = new ShiftCue();
  const dt = 1 / 60;
  const rate = 3000; // rpm/s
  let rpm = 12_000;
  let firedAt = Number.NaN;
  for (let i = 0; i < 120 && Number.isNaN(firedAt); i++, rpm += rate * dt) {
    if (cue.step(rpm, 4, 1, 0.3, 14_600, dt)) firedAt = rpm;
  }
  assert.ok(firedAt < 14_600 && firedAt > 14_600 - rate * SHIFT_LOOKAHEAD_S * 1.3, `fired at ${firedAt} rpm`);
  assert.equal(cue.step(rpm, 4, 1, 0.3, 14_600, dt), true, "latched until the shift");
  assert.equal(cue.step(rpm - 2500, 5, 1, 0.3, 14_600, dt), false, "next gear clears it");
  assert.equal(cue.step(14_700, 5, 1, 0.3, 14_600, dt), false, "re-arm delay after the shift");
  for (let i = 0; i < 10; i++) cue.step(14_700, 5, 1, 0.3, 14_600, dt);
  assert.equal(cue.on, true, "at the limiter in the new gear");
  assert.equal(cue.step(14_700, 5, 0, 0.3, 14_600, dt), false, "a lift clears it");
  const spin = new ShiftCue();
  for (let i = 0; i < 30; i++) spin.step(14_700, 2, 1, 2.2, 14_600, dt);
  assert.equal(spin.on, false, "wheelspin revs are not a shift point");
  const neutral = new ShiftCue();
  for (let i = 0; i < 30; i++) neutral.step(15_000, 0, 1, 0, 14_600, dt);
  assert.equal(neutral.on, false, "neutral");
});

check("WheelFfbClient plays the slide cue from the peak and the shift cue at the dash's SHIFT rpm", () => {
  type Buzz = { hidSlide: number; hidShift: number };
  const run = (patch: Partial<WheelSettings>, extra: Partial<CarTelemetry>, frames = 12): Buzz => {
    const c = new WheelFfbClient();
    c.hidSink = () => {};
    let t = 1000;
    for (let i = 0; i < frames; i++, t += 16) {
      c.update(carTel(0, 0.2, { speedKmh: 180, throttle: 1, gear: 6, rpm: 13_000, ...extra }), wheelWith(patch), [], t, true, "f12026-car");
    }
    const buzz = { ...(c as unknown as Buzz) };
    c.stop();
    return buzz;
  };
  const tyres = (front: number, rear: number) => ({ tireSlipRatio: [front, front, rear, rear] as [number, number, number, number] });
  assert.equal(run({}, tyres(0.85, 0.4)).hidSlide, 0);
  assert.ok(run({}, tyres(1.05, 0.4)).hidSlide > 0.1, "slide at the peak");
  near(run({ ffbSlip: 0.5 }, tyres(1.6, 0.4)).hidSlide, 0.5, 1e-6);
  assert.equal(run({ ffbSlip: 0 }, tyres(1.6, 0.4)).hidSlide, 0);
  assert.equal(run({}, { rpm: 14_800 }).hidShift, 0, "shift cue is off by default");
  near(run({ ffbShift: 0.7 }, { rpm: 14_800 }).hidShift, 0.7, 1e-9);
  assert.equal(run({ ffbShift: 1 }, { rpm: 12_000 }).hidShift, 0);
  // The GT3 calls the shift at 7500 rpm
  near(run({ ffbShift: 1 }, { rpm: 7600, f12026: { carId: "amg-gt3" } } as unknown as Partial<CarTelemetry>).hidShift, 1, 1e-9);
});

console.log(`\n${passed} checks passed`);
