/**
 * Verification suite for the dual-Pacejka Steering Rack Self-Aligning Torque (SAT),
 * Axle Vertical Shock Load (Delta Fz), 6-tap FIR smoothing filter, and >10g High-Impact
 * Crash Torque Suppression:
 *   npx tsx scripts/verify-rack-sat-ffb.ts
 */
import assert from "node:assert/strict";
import type { CarTelemetry } from "../src/types/f1";
import { DEFAULT_WHEEL_SETTINGS } from "../src/lib/input/device-input";
import { buildTelemetryPacket } from "../src/lib/input/telemetry-out";
import {
  evaluatePacejkaSat,
  RACK_SAT_EMA_ALPHA,
  RACK_SAT_FIR_TAPS,
  RACK_SAT_FZ_NOM_N,
  RACK_SAT_HIGH_IMPACT_ATTEN,
  RACK_SAT_HIGH_IMPACT_G,
  RACK_SAT_OVERSTEER_OFFSET_RAD,
  RACK_SAT_OVERSTEER_SOFT_RAMP_RAD,
  RACK_SAT_Q_DZ2,
  RACK_SAT_SHOCK_VEL_CAP_MS,
  RACK_SAT_UNDERSTEER_OFFSET_RAD,
  RackSatSynthesizer,
  stepRackSat,
  WheelFfbClient,
} from "../src/lib/input/wheel-ffb";
import { hapticMagnitudes } from "../src/lib/sim/gamepad-haptics";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const near = (a: number, b: number, eps = 1e-5) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (|diff| = ${Math.abs(a - b)})`);

console.log("1. 6-Tap FIR Filter & Pacejka Magic Formula Core");

check("6-tap FIR kernel coefficients sum to unity (1.0 DC gain)", () => {
  assert.equal(RACK_SAT_FIR_TAPS.length, 6);
  const sum = RACK_SAT_FIR_TAPS.reduce((acc, c) => acc + c, 0);
  near(sum, 1.0, 1e-6);
});

check("evaluatePacejkaSat is antisymmetric, zero at origin, and bounded by peak D", () => {
  assert.equal(evaluatePacejkaSat(0, 2.5, 1.85, 0.85, -0.88), 0);
  const pos = evaluatePacejkaSat(0.18, 2.5, 1.85, 0.85, -0.88);
  const neg = evaluatePacejkaSat(-0.18, 2.5, 1.85, 0.85, -0.88);
  near(pos, -neg, 1e-9);
  assert.ok(pos > 0 && pos <= 0.85);
});

console.log("2. Rear Oversteer Pacejka SAT & Soft Ramp");

check("below 5 m/s minimum activation speed, SAT and bump torques remain zero", () => {
  const synth = new RackSatSynthesizer();
  const out = synth.step({
    speedMs: 4.5,
    lateralVelMs: 1.5,
    longitudinalVelMs: 4.5,
    shockVelMs: [1.2, 1.2, 1.2, 1.2],
  });
  assert.equal(out.oversteerTorque, 0);
  assert.equal(out.understeerTorque, 0);
  assert.equal(out.bumpTorque, 0);
  assert.equal(out.totalAddedTorque, 0);
});

check("rear oversteer SAT respects 0.030 rad deadband and grows monotonically past threshold", () => {
  const synthTiny = new RackSatSynthesizer({ understeerGain: 0, bumpsGain: 0 });
  const tiny = synthTiny.step({
    speedMs: 40,
    lateralVelMs: 0.15, // r = 0.00375 rad -> sa < 0.030
    longitudinalVelMs: 40,
  });
  assert.ok(Math.abs(tiny.rearPacejkaSa) < RACK_SAT_OVERSTEER_OFFSET_RAD);
  assert.equal(tiny.oversteerTorque, 0);

  const synthMod = new RackSatSynthesizer({ understeerGain: 0, bumpsGain: 0 });
  const mod = synthMod.step({
    speedMs: 40,
    lateralVelMs: 4.0, // r = 0.10 rad
    longitudinalVelMs: 40,
  });
  const synthHigh = new RackSatSynthesizer({ understeerGain: 0, bumpsGain: 0 });
  const high = synthHigh.step({
    speedMs: 40,
    lateralVelMs: 8.0, // r = 0.20 rad
    longitudinalVelMs: 40,
  });
  assert.ok(mod.oversteerTorque > 0, "positive rear sideslip produces positive counter-steering torque");
  assert.ok(high.oversteerTorque > mod.oversteerTorque, "larger rear slide produces stronger oversteer SAT");
  assert.ok(high.oversteerIntensityPct > mod.oversteerIntensityPct);
});

check("rear sideslip soft ramp scales oversteer torque when |r| < 0.015 rad", () => {
  // With B=2.5, C=1.85, D=0.85, E=-0.88, at r=0.012 rad: sa ≈ 0.0471 > 0.030 rad while |r| < 0.015 rad
  const synth = new RackSatSynthesizer({ understeerGain: 0, bumpsGain: 0 });
  const r = 0.012;
  const out = synth.step({
    speedMs: 50,
    rearSlipAngleRad: r,
  });
  const sa = out.rearPacejkaSa;
  assert.ok(sa > RACK_SAT_OVERSTEER_OFFSET_RAD);
  const expectedRamp = r / RACK_SAT_OVERSTEER_SOFT_RAMP_RAD;
  const expectedTorque = (sa - RACK_SAT_OVERSTEER_OFFSET_RAD) * (2.0 - sa) * expectedRamp;
  near(out.oversteerTorque, expectedTorque, 1e-6);
});

console.log("3. Front Understeer Pacejka SAT & Turn-Entry Yaw Gate");

check("front understeer SAT opposes front slip past 0.040 rad and halves on low-yaw turn entry (<0.1 rad/s)", () => {
  // Steady cornering with high front push: delta_road = 0.22 rad, yawRate = 0.20 rad/s, v = 30 m/s, L = 2.7 m
  // alpha_f = 0.22 - (0.20 * 1.35) / 30 = 0.211 rad
  const synthMidCorner = new RackSatSynthesizer({ oversteerGain: 0, bumpsGain: 0 });
  const mid = synthMidCorner.step({
    speedMs: 30,
    roadSteerRad: 0.22,
    yawRateRadS: 0.20,
    wheelbaseM: 2.7,
  });
  assert.ok(mid.frontPacejkaSa > RACK_SAT_UNDERSTEER_OFFSET_RAD);
  assert.ok(mid.understeerTorque > 0);
  // Combined SAT is tau_over - tau_under, so pure understeer reduces steering weight (negative SAT contribution)
  assert.ok(mid.rawSatTorque < 0);
  assert.ok(mid.understeerIntensityPct > 0);

  // Same front slip angle at initial turn-in with |yawRate| = 0.04 < 0.1 rad/s -> entryRamp = 0.5
  const alphaTarget = mid.frontSlipAngleRad;
  const lowYaw = 0.04;
  const deltaForSameAlpha = alphaTarget + (lowYaw * 1.35) / 30;
  const synthEntry = new RackSatSynthesizer({ oversteerGain: 0, bumpsGain: 0 });
  const entry = synthEntry.step({
    speedMs: 30,
    roadSteerRad: deltaForSameAlpha,
    yawRateRadS: lowYaw,
    wheelbaseM: 2.7,
  });
  near(entry.frontSlipAngleRad, mid.frontSlipAngleRad, 1e-6);
  near(entry.understeerTorque, mid.understeerTorque * 0.5, 1e-6);
});

console.log("4. Axle Vertical Shock Load (Delta Fz) & Digressive Load Sensitivity");

check("compression increases Delta Fz and digressively reduces normalized Pacejka peak D (Q_DZ2 = -0.2)", () => {
  const synthComp = new RackSatSynthesizer();
  const comp = synthComp.step({
    speedMs: 40,
    shockVelMs: [1.0, 1.0, 1.0, 1.0], // +1.0 m/s compression -> Delta Fz = 2000 N -> dfz = 2/3
    rearSlipAngleRad: 0.15,
    frontSlipAngleRad: 0.15,
  });
  const synthReb = new RackSatSynthesizer();
  const reb = synthReb.step({
    speedMs: 40,
    shockVelMs: [-1.0, -1.0, -1.0, -1.0], // -1.0 m/s rebound -> Delta Fz = -2000 N -> dfz = -2/3
    rearSlipAngleRad: 0.15,
    frontSlipAngleRad: 0.15,
  });

  near(comp.deltaFzFrontN, 2000, 1e-5);
  near(comp.dfzFront, 2000 / RACK_SAT_FZ_NOM_N, 1e-6);
  assert.ok(comp.bumpTorque > 0, "compression adds positive bump torque");
  assert.ok(reb.bumpTorque < 0, "rebound adds negative bump torque");
  assert.ok(RACK_SAT_Q_DZ2 < 0, "Q_DZ2 is digressive");
  assert.ok(comp.rearPeakD < 0.85 && reb.rearPeakD > 0.85);
  assert.ok(comp.frontPeakD < 0.70 && reb.frontPeakD > 0.70);
});

check("suspension travel (mm) differentiates across frames and applies EMA alpha = 0.030", () => {
  const synth = new RackSatSynthesizer();
  // Frame 0 seeds prevSuspMm
  synth.step({
    speedMs: 35,
    dtS: 0.01,
    suspensionTravelMm: [10, 10, 12, 12],
  });
  // Frame 1: +15 mm over 10 ms = 1.5 m/s on front, +5 mm over 10 ms = 0.5 m/s on rear (seeds firstBump)
  const f1 = synth.step({
    speedMs: 35,
    dtS: 0.01,
    suspensionTravelMm: [25, 25, 17, 17],
  });
  near(f1.filteredVelFrontMs, 1.5, 1e-6);
  near(f1.filteredVelRearMs, 0.5, 1e-6);

  // Frame 2: 0 m/s -> EMA decays by (1 - 0.030)
  const f2 = synth.step({
    speedMs: 35,
    dtS: 0.01,
    suspensionTravelMm: [25, 25, 17, 17],
  });
  near(f2.filteredVelFrontMs, 1.5 * (1 - RACK_SAT_EMA_ALPHA), 1e-6);
  near(f2.filteredVelRearMs, 0.5 * (1 - RACK_SAT_EMA_ALPHA), 1e-6);
});

check("extreme shock velocities above 2.5 m/s are hyperbolically attenuated", () => {
  const synth = new RackSatSynthesizer();
  const v = 4.5; // 2.0 m/s above the 2.5 m/s cap
  const out = synth.step({
    speedMs: 45,
    shockVelMs: [v, v, 0, 0],
  });
  const expectedAtten = 1.0 / (1.0 + (v - RACK_SAT_SHOCK_VEL_CAP_MS) * 0.45);
  near(out.shockAttenuation, expectedAtten, 1e-6);
  near(out.deltaFzFrontN, 2000 * v * expectedAtten, 1e-4);
});

console.log("5. >10G High-Impact Crash Suppression & 6-Tap FIR Convergence");

check("resultant horizontal acceleration > 10g zeroes bump torque, zeroes shakers, and attenuates SAT to 0.25x", () => {
  const normal = stepRackSat({
    speedMs: 45,
    shockVelMs: [1.2, 1.2, 1.0, 1.0],
    rearSlipAngleRad: 0.16,
    lateralG: 2.5,
    longitudinalG: 1.0,
  });
  assert.equal(normal.highImpactActive, false);
  assert.ok(normal.bumpTorque > 0);
  assert.ok(normal.oversteerIntensityPct > 0);

  // g_res = hypot(8.0, 7.0) = 10.63g > 10.0g
  const crash = stepRackSat({
    speedMs: 45,
    shockVelMs: [1.2, 1.2, 1.0, 1.0],
    rearSlipAngleRad: 0.16,
    lateralG: 8.0,
    longitudinalG: -7.0,
  });
  assert.ok(crash.resultantG > RACK_SAT_HIGH_IMPACT_G);
  assert.equal(crash.highImpactActive, true);
  assert.equal(crash.bumpTorque, 0, "bump amplification zeroed on >10g impact");
  assert.equal(crash.oversteerIntensityPct, 0, "oversteer shaker zeroed on >10g impact");
  assert.equal(crash.understeerIntensityPct, 0, "understeer shaker zeroed on >10g impact");
  // With dfz=0 on crash, check that filteredSatTorque is 0.25x of an un-bumped normal step
  const unbumpedNormal = stepRackSat({
    speedMs: 45,
    bumpsGain: 0,
    rearSlipAngleRad: 0.16,
    lateralG: 2.0,
    longitudinalG: 1.0,
  });
  near(crash.filteredSatTorque, unbumpedNormal.filteredSatTorque * RACK_SAT_HIGH_IMPACT_ATTEN, 1e-6);
});

check("6-tap FIR filter converges to exact steady-state SAT after 6 identical steps", () => {
  const synth = new RackSatSynthesizer({ bumpsGain: 0, understeerGain: 0 });
  let last = synth.step({ speedMs: 40, rearSlipAngleRad: 0.14 });
  // Because rearSideslip is constant 0.14 from frame 1 onward, rawSatTorque is constant
  const firstFiltered = last.filteredSatTorque;
  near(firstFiltered, last.rawSatTorque * RACK_SAT_FIR_TAPS[0], 1e-6);
  for (let i = 1; i < 6; i++) {
    last = synth.step({ speedMs: 40, rearSlipAngleRad: 0.14 });
  }
  near(last.filteredSatTorque, last.rawSatTorque, 1e-5);
});

console.log("6. WheelFfbClient, TelemetryOutPacket & GamepadHaptics Integration");

check("WheelFfbClient layers SAT into frame force and 500 Hz subframes and suppresses >10g impacts", () => {
  const client = new WheelFfbClient();
  const wheel = { ...DEFAULT_WHEEL_SETTINGS, ffbEnabled: true, ffbGain: 1.0, ffbMinForce: 0, ffbFilterS: 0 };

  const slideTel = {
    speedKmh: 160,
    ffbTorqueNorm: 0.2,
    ffbSubframeSamples: [0.2, 0.2, 0.2],
    rearSlipAngleDeg: 10,
    frontSlipAngleDeg: 2,
    suspensionTravelMm: [15, 15, 20, 20],
    lateralG: 1.8,
    longitudinalG: 0.2,
  } as unknown as CarTelemetry;

  client.update(slideTel, wheel, [], 1000, true, "f12026-car");
  const normalForce = client.force;
  assert.ok(normalForce > 0.2, `SAT adds counter-steer force onto base torque (${normalForce})`);
  assert.ok((client.meter.oversteerIntensityPct ?? 0) > 0);
  assert.equal(client.meter.highImpactActive, false);

  const crashTel = {
    ...slideTel,
    lateralG: 9.0,
    longitudinalG: 6.5, // hypot = 11.1g > 10g
  } as unknown as CarTelemetry;
  client.update(crashTel, wheel, [], 1016, true, "f12026-car");
  assert.equal(client.meter.highImpactActive, true);
  assert.equal(client.meter.oversteerIntensityPct, 0);
  assert.ok(client.force < normalForce * 0.4, `crash force attenuated (${client.force} vs ${normalForce})`);
});

check("TelemetryOutPacket and GamepadHaptics expose oversteer/understeer shaker cues and zero on >10g crash", () => {
  const slideTel = {
    speedKmh: 150,
    steering: 0.4,
    rearSlipAngleDeg: 11,
    frontSlipAngleDeg: 9,
    tireSlipRatio: [0.5, 0.5, 0.8, 0.8],
    wheelSlipRatios: [0.02, 0.02, 0.08, 0.08],
    lateralG: 1.5,
    longitudinalG: -0.3,
  } as unknown as CarTelemetry;

  const pkt = buildTelemetryPacket(slideTel, {
    car: "f12026-car",
    track: "rwanda_2026",
    maxRpm: 12000,
    yawRateRadS: 0.25,
    pitchRad: 0,
    rollRad: 0,
    nowMs: 2000,
  });
  assert.ok((pkt.oversteerPct ?? 0) > 0, "packet includes non-zero oversteerPct");
  assert.ok((pkt.understeerPct ?? 0) > 0, "packet includes non-zero understeerPct");

  const rumbleNormal = hapticMagnitudes(slideTel, 0.1);
  assert.ok(rumbleNormal.strong > 0 && rumbleNormal.weak > 0);

  const crashTel = { ...slideTel, lateralG: 8.5, longitudinalG: 8.5 } as unknown as CarTelemetry;
  const pktCrash = buildTelemetryPacket(crashTel, {
    car: "f12026-car",
    track: "rwanda_2026",
    maxRpm: 12000,
    yawRateRadS: 0.25,
    pitchRad: 0,
    rollRad: 0,
    nowMs: 2016,
  });
  assert.equal(pktCrash.oversteerPct, 0);
  assert.equal(pktCrash.understeerPct, 0);
  assert.deepEqual(hapticMagnitudes(crashTel, 0.1), { weak: 0, strong: 0 });
});

console.log(`\n${passed} checks passed`);
