/**
 * Checks the gamepad rumble mix without a browser: headroom layering, per-wheel roughness from shock velocity, the
 * impact pulse, that the trigger pulses are untouched by it, and that the brake trigger's limit buzz reads braking
 * slip only:
 *   npx tsx scripts/verify-gamepad-rumble.ts
 */
import assert from 'node:assert/strict';
import type { CarTelemetry } from '../src/types/f1';
import { RACK_SAT_HIGH_IMPACT_G } from '../src/lib/input/wheel-ffb';
import {
  createRumbleMixState,
  GamepadHaptics,
  hapticMagnitudes,
  layerRumble,
  type RumbleMixState,
  triggerMagnitudes,
} from '../src/lib/sim/gamepad-haptics';
import { axleSlipFromTelemetry } from '../src/lib/sim/tyre-slip';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
/** Partial telemetry cast through unknown: only the fields the mix reads are filled */
const tel = (o: Record<string, unknown>) => o as unknown as CarTelemetry;
const four = (v: number) => [v, v, v, v];

/** 150 km/h in a straight line on asphalt, 2 kN on each corner, nothing happening */
const cruise = (o: Record<string, unknown> = {}) =>
  tel({
    speedKmh: 150,
    throttle: 0.5,
    brake: 0,
    steering: 0,
    lateralG: 0,
    longitudinalG: 0,
    verticalG: 1,
    wheelSlipRatios: four(0),
    tireSlipRatio: four(0),
    wheelLoadsN: four(2000),
    suspensionVelocityMs: four(0),
    wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
    surface: 'asphalt',
    onKerbLeft: false,
    onKerbRight: false,
    ...o,
  });
const DT = 1 / 60;
/** Steps `mix` through `frames` frames of `t` from `startS`; returns the last frame's motors and the time after it */
function run(mix: RumbleMixState, t: CarTelemetry, startS: number, frames: number) {
  let out = { weak: 0, strong: 0 };
  for (let i = 0; i < frames; i++) out = hapticMagnitudes(t, startS + i * DT, undefined, mix);
  return { out, timeS: startS + frames * DT };
}

console.log('Headroom layering');
check('layering stays within 0..1, never below its largest cue, and in any order gives the same', () => {
  const cues = [0, 0.04, 0.25, 0.45, 0.6, 0.8, 1];
  for (const a of cues) {
    for (const b of cues) {
      const ab = layerRumble(layerRumble(0, a), b);
      near(ab, layerRumble(layerRumble(0, b), a));
      assert.ok(ab <= 1 && ab >= Math.max(a, b) - 1e-12, `${a} + ${b} → ${ab}`);
    }
  }
  assert.equal(layerRumble(0.5, Number.NaN), 0.5, 'a broken cue adds nothing');
  assert.equal(layerRumble(0.5, -2), 0.5);
  assert.equal(layerRumble(0.5, 3), 1);
});
check('strong motor: lock-up, wheelspin and an oversteer slide stack below full, each still felt', () => {
  const lockUp = cruise({ wheelSlipRatios: [-0.45, -0.45, 0, 0] });
  const all = cruise({ wheelSlipRatios: [-0.45, -0.45, 0.5, 0.5] });
  const alone = hapticMagnitudes(lockUp, 0).strong;
  const stacked = hapticMagnitudes(all, 0, { oversteerIntensityPct: 100, understeerIntensityPct: 0 }).strong;
  near(alone, 0.8);
  near(stacked, 1 - (1 - 0.8) * (1 - 0.6) * (1 - 0.45)); // 0.956: summed, it was clipped to 1
  assert.ok(stacked < 1 && stacked > alone);
});
check('weak motor: a kerb strike under tyre scrub and understeer stays below full', () => {
  const kerb = cruise({ onKerbLeft: true });
  const kerbAlone = hapticMagnitudes(kerb, 0).weak; // timeS = 0: the 12 Hz kerb pulse is on
  const stacked = hapticMagnitudes(cruise({ onKerbLeft: true, tireSlipRatio: [1.2, 1.2, 0, 0] }), 0, {
    oversteerIntensityPct: 0,
    understeerIntensityPct: 100,
  }).weak;
  assert.ok(stacked < 1 && stacked > kerbAlone, `kerb ${kerbAlone.toFixed(3)} → stacked ${stacked.toFixed(3)}`);
  assert.ok(hapticMagnitudes(kerb, 1 / 24 + 0.001).weak < 0.05, 'kerb pulse still off on its off half');
});

console.log('Surface roughness');
check('smooth asphalt with braking-dive shock velocity is silent', () => {
  for (const v of [0, 0.03, 0.06, 0.08]) {
    assert.equal(hapticMagnitudes(cruise({ suspensionVelocityMs: four(v) }), 0).strong, 0, `${v} m/s`);
  }
});
check('roughness grows with shock velocity, full at 0.9 m/s on every wheel', () => {
  const at = (v: number) => hapticMagnitudes(cruise({ suspensionVelocityMs: [v, -v, v, -v] }), 0).strong;
  assert.ok(at(0.2) > 0 && at(0.2) < at(0.5) && at(0.5) < at(0.9), `${at(0.2)} < ${at(0.5)} < ${at(0.9)}`);
  near(at(0.9), 1);
  near(at(2), 1);
});
check('a wheel off the ground adds nothing however fast its damper moves; one loaded wheel is a quarter', () => {
  const one = (loadN: number) =>
    hapticMagnitudes(cruise({ suspensionVelocityMs: [1.5, 0, 0, 0], wheelLoadsN: [loadN, 2000, 2000, 2000] }), 0).strong;
  assert.equal(one(0), 0);
  assert.equal(one(150), 0, 'below the load gate');
  near(one(2000), 0.25);
  assert.ok(one(600) > 0 && one(600) < 0.25, 'partly gated');
});
check('a one-frame spike is held briefly, then gone', () => {
  const mix = createRumbleMixState();
  run(mix, cruise(), 0, 5);
  const spike = hapticMagnitudes(cruise({ suspensionVelocityMs: four(0.9) }), 5 * DT, undefined, mix).strong;
  const next = hapticMagnitudes(cruise(), 6 * DT, undefined, mix).strong;
  const later = run(mix, cruise(), 7 * DT, 18).out.strong;
  near(spike, 1);
  near(next, Math.exp(-DT / 0.05), 1e-9);
  assert.ok(later < 0.01, `rings out (${later})`);
  assert.equal(hapticMagnitudes(cruise(), 6 * DT).strong, 0, 'without the state each frame stands alone');
});
check('off track: grass and run-off texture from the surface table, scaled by speed, never a flat 0.35', () => {
  const on = (surface: string, speedKmh: number, loadN = 2000) =>
    hapticMagnitudes(cruise({ speedKmh, surface, wheelSurfaces: [surface, surface, surface, surface], wheelLoadsN: four(loadN) }), 0).strong;
  near(on('grass', 150), 0.4 * 0.5); // grass vibration 0.5
  near(on('runoff', 150), 0.4 * 0.15); // painted run-off 0.15
  assert.equal(on('asphalt', 150), 0);
  assert.equal(on('kerb', 150), 0, 'kerbs have their own pulse');
  assert.ok(on('grass', 40) < on('grass', 150) && on('grass', 5) === 0, 'builds with speed');
  assert.equal(on('grass', 150, 0), 0, 'airborne over the grass');
  const twoWheels = hapticMagnitudes(cruise({ surface: 'grass', wheelSurfaces: ['grass', 'asphalt', 'grass', 'asphalt'] }), 0).strong;
  near(twoWheels, on('grass', 150) / 2);
  assert.equal(hapticMagnitudes(cruise({ surface: 'grass' }), 0).strong, 0, 'the car-level surface alone adds nothing');
  const bumpy = hapticMagnitudes(cruise({ surface: 'grass', wheelSurfaces: four(0).map(() => 'grass'), suspensionVelocityMs: four(0.6) }), 0).strong;
  assert.ok(bumpy > on('grass', 150), 'rough grass is felt on top of the texture');
});

console.log('Impact pulse');
check('a wall hit is a pulse on the strong motor, not a mute', () => {
  const crash = cruise({ lateralG: 9, longitudinalG: 6.5, onKerbLeft: true }); // 11.1 g
  const m = hapticMagnitudes(crash, 0);
  near(m.strong, 0.6 + 0.4 * ((Math.hypot(9, 6.5) - RACK_SAT_HIGH_IMPACT_G) / RACK_SAT_HIGH_IMPACT_G));
  assert.ok(m.weak > 0.5, 'the kerb strike under it is still felt');
  near(hapticMagnitudes(cruise({ lateralG: 40 }), 0).strong, 1);
  near(hapticMagnitudes(cruise(), 0, { highImpactActive: true }).strong, 0.6);
  assert.equal(hapticMagnitudes(cruise({ lateralG: 6, longitudinalG: -5 }), 0).strong, 0, 'hard cornering under braking is not a crash');
});
check('a crash stands the slide cues down', () => {
  const slide = { oversteerIntensityPct: 100, understeerIntensityPct: 100, highImpactActive: true };
  const m = hapticMagnitudes(cruise(), 0, slide);
  near(m.strong, 0.6);
  near(m.weak, 0.04 * 0.5, 1e-9); // road texture only
});
check('a landing rings out with the 0.1 s decay; a clean lap\'s heave does not fire', () => {
  // 1.1 g of compression: Rwanda's crests and dips peak there on a clean lap
  const lap = createRumbleMixState();
  const learnt = run(lap, cruise(), 0, 60);
  assert.equal(run(lap, cruise({ wheelLoadsN: four(2000 * 2.1) }), learnt.timeS, 1).out.strong, 0);

  const mix = createRumbleMixState();
  const { timeS } = run(mix, cruise(), 0, 60);
  near(mix.weightN, 8000, 1e-6);
  // Airborne: no load at all reads as negative heave and is not a hit
  const r = run(mix, cruise({ wheelLoadsN: four(0), verticalG: 1.8 }), timeS, 3);
  assert.equal(r.out.strong, 0);
  // The landing: 2.2 g of compression
  const landing = hapticMagnitudes(cruise({ wheelLoadsN: four(2000 * 3.2) }), r.timeS, undefined, mix).strong;
  near(landing, (2.2 - 1.4) / (3 - 1.4));
  near(mix.weightN, 8000, 1e-6); // the hit itself does not skew the weight
  const after = run(mix, cruise(), r.timeS + DT, 6).out.strong;
  near(after, landing * Math.exp(-0.1 / 0.1), 1e-6);
  assert.ok(run(mix, cruise(), r.timeS + 7 * DT, 24).out.strong < 0.01, 'back to the normal mix within 0.5 s');
});
check('downforce at speed is not a hit, and the weight estimate follows a different car', () => {
  const mix = createRumbleMixState();
  const { timeS } = run(mix, cruise(), 0, 30);
  // 3 g of downforce: the tyres carry three times the weight, which verticalG accounts for
  const fast = run(mix, cruise({ speedKmh: 320, verticalG: 3, wheelLoadsN: four(6000) }), timeS, 30);
  assert.equal(fast.out.strong, 0);
  // A GT3 after an F1 car (1.75× the weight): reads as a hit at first, but the estimate settles on it
  const gt3 = run(mix, cruise({ wheelLoadsN: four(3500) }), fast.timeS, 60 * 12);
  near(mix.weightN, 14000, 50);
  assert.equal(gt3.out.strong, 0);
});
check('a car settling below 10 km/h is not a hit', () => {
  const mix = createRumbleMixState();
  const { timeS } = run(mix, cruise({ speedKmh: 0 }), 0, 30);
  assert.equal(hapticMagnitudes(cruise({ speedKmh: 4, wheelLoadsN: four(8000) }), timeS, undefined, mix).strong, 0);
});
check('telemetry missing the new channels (or broken ones) stays finite', () => {
  const mix = createRumbleMixState();
  for (const t of [
    tel({ speedKmh: 120 }),
    tel({ speedKmh: 120, wheelLoadsN: [Number.NaN, 2000, 2000, 2000], suspensionVelocityMs: [Number.NaN, 0.5, 0, 0], verticalG: Number.NaN }),
    cruise({ verticalG: 0 }),
  ]) {
    for (let i = 0; i < 5; i++) {
      const m = hapticMagnitudes(t, i * DT, undefined, mix);
      assert.ok(Number.isFinite(m.weak) && Number.isFinite(m.strong) && m.weak >= 0 && m.strong >= 0 && m.weak <= 1 && m.strong <= 1);
    }
  }
});

console.log('Trigger cues and pad wiring');
/** Hard braking into a lock-up (as verify-telemetry-out): front wheels locked at −0.30 */
const braking = cruise({ throttle: 0, brake: 0.8, wheelSlipRatios: [-0.3, -0.25, 0.05, 0.04], tireSlipRatio: [0.3, 0.25, 0.05, 0.04] });
check('ABS, lock-up and TC trigger pulses are unchanged, in a crash too', () => {
  near(triggerMagnitudes(braking, 0).left, 0.35 + 0.45 * (0.3 / 0.45));
  assert.equal(triggerMagnitudes(braking, 0.03).left, 0);
  near(triggerMagnitudes(cruise({ ...braking, lateralG: 12 }), 0).left, 0.35 + 0.45 * (0.3 / 0.45));
  const tc = cruise({ speedKmh: 80, throttle: 0.8, wheelSlipRatios: [0, 0, 0.1, 0.1], f12026: { tcActive: true, absActive: false } });
  near(triggerMagnitudes(tc, 0.01).right, 0.25 + 0.45 * 0.2);
  assert.equal(triggerMagnitudes(tc, 0.03).right, 0);
  const abs = cruise({ ...braking, speedKmh: 20, wheelSlipRatios: [-0.05, 0, 0, 0], f12026: { absActive: true, tcActive: false } });
  assert.ok(triggerMagnitudes(abs, 0).left >= 0.35);
});

check('braking part of the slip: all of it braking in a straight line, none cornering or under power', () => {
  const slip = (nd: number, slipRatio: number, angleDeg: number) =>
    axleSlipFromTelemetry({ tireSlipRatio: four(nd), wheelSlipRatios: four(slipRatio), wheelSlipAnglesDeg: four(angleDeg), wheelLoadsN: four(3000) });
  near(slip(0.9, -0.09, 0).brakeNdSlip, 0.9);
  near(slip(0.9, 0, 7).brakeNdSlip, 0);
  near(slip(0.9, 0.08, 0).brakeNdSlip, 0, 1e-12);
  const trail = slip(0.9, -0.06, 4).brakeNdSlip;
  assert.ok(trail > 0.3 && trail < 0.9, `trail braking counts in part (${trail.toFixed(3)})`);
  near(slip(0.9, 0, 7).totalNdSlip, 0.9, 1e-12); // the combined slip the steering assist reads is unchanged
});
check('aids off: the brake trigger buzzes for braking slip, not for cornering at the limit while braking', () => {
  const absOff = { absLevel: 0, tcLevel: 5 };
  const at = (nd: number, slipRatio: number, angleDeg: number) =>
    triggerMagnitudes(
      cruise({
        speedKmh: 120,
        throttle: 0,
        brake: 0.6,
        tireSlipRatio: four(nd),
        wheelSlipRatios: four(slipRatio),
        wheelSlipAnglesDeg: four(angleDeg),
        wheelLoadsN: four(3000),
        liveTuner: absOff,
      }),
      0
    ).left;
  assert.equal(at(0.95, -0.01, 7), 0, 'cornering at the limit, braking lightly: no buzz (combined slip would have)');
  const straight = at(0.8, -0.08, 0.5);
  assert.ok(straight > 0.1, `approaching a lock-up: buzz (${straight.toFixed(3)})`);
  const trail = at(0.8, -0.06, 4);
  assert.ok(trail > 0 && trail < straight, `trail braking: lighter (${trail.toFixed(3)})`);
  near(at(1.4, -0.3, 0), 0.35 + 0.45 * (0.3 / 0.45)); // locked: the lock-up pulse, as before
});

/** Replaces navigator.getGamepads for one block, then restores it */
function withPads(pads: unknown[], fn: () => void) {
  const g = globalThis as unknown as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => pads } });
  try {
    fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete g.navigator;
  }
}
type Call = { type: string; p: Record<string, number> };
const fakeActuator = (effects: string[] | undefined, calls: Call[]) => ({
  effects,
  playEffect: (type: string, p: Record<string, number>) => {
    calls.push({ type, p });
    return undefined;
  },
  reset: () => {
    calls.push({ type: 'reset', p: {} });
    return undefined;
  },
});
check('a hit goes out at once past the send gate, with the trigger cues beside it; stop clears the pulse', () => {
  const calls: Call[] = [];
  withPads([{ vibrationActuator: fakeActuator(['dual-rumble', 'trigger-rumble'], calls) }], () => {
    const h = new GamepadHaptics();
    // Cruising with no pulse running: only a change of the motors sends
    h.update(cruise(), 0.05, true, { triggerRumble: true });
    assert.equal(calls.length, 1);
    h.update(cruise(), DT / 4, true, { triggerRumble: true });
    assert.equal(calls.length, 1, 'nothing new inside the send interval');
    h.update(cruise({ wheelSlipRatios: [-0.45, -0.45, 0, 0] }), DT / 4, true, { triggerRumble: true });
    assert.equal(calls.length, 1, 'a lock-up onset waits for the gate: only a hit skips it');
    h.update(cruise({ lateralG: 15 }), DT / 4, true, { triggerRumble: true });
    assert.equal(calls.length, 2, 'the hit is not held back by the gate');
    assert.ok(calls[1].p.strongMagnitude >= 0.6);
    h.update(cruise({ ...braking, lateralG: 15 }), DT, true, { triggerRumble: true });
    h.stop();
    assert.equal(calls[calls.length - 1].type, 'reset');
    h.update(cruise(), DT, true, { triggerRumble: true });
    assert.ok(calls[calls.length - 1].p.strongMagnitude < 0.01, 'stop() cleared the envelope');
  });
});

console.log(`\n${passed} checks passed`);
