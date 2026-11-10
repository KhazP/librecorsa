/**
 * The steering force and the balance cues come from the car's own tyres, with nothing layered on top:
 *   npx tsx scripts/verify-ffb-cues.ts
 *  - the wheel plays the physics' steering torque (gain / minimum force only), in a corner and in a wall hit alike (with
 *    collision protection on, a hit is slew-limited onto that torque, never cut)
 *  - understeer / oversteer cues follow each axle's normalised slip, for the controller rumble and telemetry-out
 */
import assert from 'node:assert/strict';
import type { CarTelemetry } from '../src/types/f1';
import { DEFAULT_WHEEL_SETTINGS } from '../src/lib/input/device-input';
import { shapeFfbForce, WheelFfbClient } from '../src/lib/input/wheel-ffb';
import { buildTelemetryPacket } from '../src/lib/input/telemetry-out';
import { hapticMagnitudes } from '../src/lib/sim/gamepad-haptics';
import { handlingCues } from '../src/lib/sim/handling-cues';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** A car at speed with each axle at the given normalised slip (1 = the tyres' peak) */
function car(o: { front: number; rear: number; torque?: number; latG?: number; lonG?: number; slipDeg?: number }): CarTelemetry {
  const sa = o.slipDeg ?? 3;
  return {
    speedKmh: 180,
    steering: 0.2,
    lateralG: o.latG ?? 3,
    longitudinalG: o.lonG ?? 0,
    ffbTorqueNorm: o.torque ?? -0.3,
    tireSlipRatio: [o.front, o.front, o.rear, o.rear],
    wheelSlipRatios: [0, 0, 0, 0],
    wheelSlipAnglesDeg: [sa, sa, sa, sa],
    wheelLoadsN: [5000, 5000, 6000, 6000],
    wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
    suspensionTravelMm: [20, 20, 25, 25],
    onKerbLeft: false,
    onKerbRight: false,
    surface: 'asphalt',
  } as unknown as CarTelemetry;
}

const wheel = { ...DEFAULT_WHEEL_SETTINGS, ffbEnabled: true, hidFfb: false, ffbGain: 0.8, ffbMinForce: 0.05, ffbDamping: 0, ffbFilterS: 0 };

/** The force the client sends for one frame of this telemetry (bridge path: no WebHID sink) */
function rimForce(t: CarTelemetry, w = wheel): number {
  const c = new WheelFfbClient();
  c.update(t, w, [], 1000, true);
  c.update(t, w, [], 1016, true);
  const f = c.force;
  c.dispose();
  return f;
}

console.log('Steering force');
check('in a steady corner the rim gets the physics torque, shaped by gain and minimum force only', () => {
  for (const slipDeg of [2, 3, 6]) {
    const t = car({ front: 0.8, rear: 0.7, torque: -0.3, slipDeg });
    near(rimForce(t), shapeFfbForce(-0.3, wheel, t.speedKmh), 1e-4);
  }
});
check('a wall hit (15 g) passes the physics torque through instead of muting it', () => {
  const t = car({ front: 1.4, rear: 1.4, torque: 0.9, latG: 15 });
  const target = shapeFfbForce(0.9, wheel, t.speedKmh);
  // Collision protection off: the torque at once
  near(rimForce(t, { ...wheel, ffbCollisionGuard: false }), target, 1e-4);
  // On (the default): slew-limited from the corner's force onto the same torque, not cut to a fraction of it
  const c = new WheelFfbClient();
  let ms = 1000;
  for (let i = 0; i < 10; i++, ms += 16) c.update(car({ front: 0.8, rear: 0.7, torque: -0.3 }), wheel, [], ms, true);
  const before = c.force;
  const seen: number[] = [];
  for (let i = 0; i < 60; i++, ms += 16) {
    c.update(t, wheel, [], ms, true);
    seen.push(c.force);
  }
  c.dispose();
  assert.ok((seen[0] as number) < before + 0.25 * (target - before), `the spike is held back (${before} → ${seen[0]})`);
  for (let i = 1; i < seen.length; i++) assert.ok((seen[i] as number) >= (seen[i - 1] as number) - 1e-9, 'it keeps following the torque');
  assert.ok((seen[30] as number) > 0.9 * target, `close to the torque within 0.5 s (${seen[30]} of ${target})`);
  near(seen.at(-1) as number, target, 1e-3);
});

console.log('Balance cues');
check('fronts past their peak with the rears in hand: understeer, no oversteer', () => {
  const c = handlingCues(car({ front: 1.2, rear: 0.7 }));
  assert.ok(c.understeer > 0.95 && c.oversteer === 0, JSON.stringify(c));
});
check('rears past their peak with the fronts in hand: oversteer, no understeer', () => {
  const c = handlingCues(car({ front: 0.7, rear: 1.2 }));
  assert.ok(c.oversteer > 0.95 && c.understeer === 0, JSON.stringify(c));
});
check('within the grip, or both axles sliding together: neither', () => {
  for (const [front, rear] of [[0.6, 0.5], [0.8, 0.84], [1.3, 1.3]]) {
    const c = handlingCues(car({ front, rear }));
    assert.ok(c.understeer < 0.05 && c.oversteer < 0.05, `${front}/${rear} → ${JSON.stringify(c)}`);
  }
});
check('telemetry-out reports the same cues as percentages', () => {
  const extra = { car: 'f12026-car', track: 'rwanda_official_short', maxRpm: 12000, yawRateRadS: 0, pitchRad: 0, rollRad: 0, nowMs: 0 };
  const p = buildTelemetryPacket(car({ front: 0.7, rear: 1.2 }), extra);
  assert.ok(p.oversteerPct > 95 && p.understeerPct === 0, `${p.oversteerPct} / ${p.understeerPct}`);
});

console.log('Controller rumble');
check('the rear sliding past the fronts shakes the strong motor', () => {
  const calm = hapticMagnitudes(car({ front: 0.7, rear: 0.7 }), 0).strong;
  const sliding = hapticMagnitudes(car({ front: 0.7, rear: 1.2 }), 0).strong;
  assert.ok(sliding > calm + 0.3, `${calm.toFixed(3)} → ${sliding.toFixed(3)}`);
});
check('a wall hit still rumbles', () => {
  const m = hapticMagnitudes(car({ front: 1.4, rear: 1.4, torque: 0.9, latG: 15, lonG: -8 }), 0);
  assert.ok(m.weak > 0.2 && m.strong > 0.1, JSON.stringify(m));
});

console.log(`\n${passed} checks passed`);
