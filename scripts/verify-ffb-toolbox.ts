/**
 * Verification for the force-feedback post-processing adapted from Adam's FFB Toolbox (downforce compensation,
 * collision protection, peak-relative slip and shift cues):
 *   npx tsx scripts/verify-ffb-toolbox.ts
 */
import assert from "node:assert/strict";
import type { CarTelemetry } from "../src/types/f1";
import { DEFAULT_WHEEL_SETTINGS, type WheelSettings } from "../src/lib/input/device-input";
import {
  DF_COMP_MIN_FRONT_N,
  DF_COMP_MIN_MULT,
  DownforceCompensator,
  downforceCompMult,
} from "../src/lib/input/ffb-toolbox";
import { WheelFfbClient } from "../src/lib/input/wheel-ffb";

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

console.log(`\n${passed} checks passed`);
