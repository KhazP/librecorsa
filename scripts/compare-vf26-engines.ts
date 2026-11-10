/**
 * The VF26 on its two engines, side by side: `F1Physics2026` (the one it ships on) and the rigid-body `VehiclePhysics`
 * on the same data (`createVf26Sim`), with the reference envelope that came with the car's data (`VF26_AI_REFERENCE`).
 *
 *   npx tsx scripts/compare-vf26-engines.ts
 *
 * Flat ground, sea-level air, soft tyres, no driver aids, the same pedal and steering traces for both: straight-line
 * times, top speed, a stop from 300 km/h, sustained lateral g at five speeds, the steering it takes, and what the car
 * does past the limit. Prints a table; `scripts/verify-vf26-fold.ts` asserts the bands.
 */
import { measureVf26, VF26_ENGINES, type Vf26Measurement } from './lib/vf26-measure';
import { VF26_AI_REFERENCE } from '../src/lib/sim/vf26-data';

const results: [string, Vf26Measurement][] = VF26_ENGINES.map(({ name, make }) => [name, measureVf26(make)]);
const pad = (s: string, n: number) => s.padEnd(n);
const row = (label: string, pick: (m: Vf26Measurement) => string, ref = '') =>
  console.log(pad(label, 30) + results.map(([, m]) => pad(pick(m), 16)).join('') + ref);

console.log(pad('', 30) + results.map(([name]) => pad(name, 16)).join('') + 'reference');
const refAccel = (kmh: number) => {
  // The reference's time to a speed, read off its (s, m/s) points
  const pts = VF26_AI_REFERENCE.accel;
  const v = kmh / 3.6;
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][1]) return `${(pts[i - 1][0] + ((v - pts[i - 1][1]) / (pts[i][1] - pts[i - 1][1])) * (pts[i][0] - pts[i - 1][0])).toFixed(2)} s`;
  }
  return '';
};
for (const kmh of [100, 200, 300]) row(`0–${kmh} km/h`, (m) => `${m.accelS[kmh]?.toFixed(2) ?? '–'} s`, refAccel(kmh));
row('Top speed', (m) => `${m.topSpeedKmh.toFixed(0)} km/h`, `${VF26_AI_REFERENCE.topSpeedKmh} km/h`);
row('300–100 km/h', (m) => `${m.brakeM.toFixed(1)} m, ${m.brakePeakG.toFixed(2)} g`);
VF26_AI_REFERENCE.lateral.forEach(([v, a], i) => row(`Lateral g at ${(v * 3.6).toFixed(0)} km/h`, (m) => `${m.lateralG[i].toFixed(2)} g`, `${(a / 9.81).toFixed(2)} g`));
row('Steer for 1.5 g at 180 km/h', (m) => `${m.steerFor15G.toFixed(3)} of lock`);
row('Yaw rate overshoot, step steer', (m) => `${(m.stepOvershoot * 100).toFixed(0)} %`);
row('Lift-off at 2.5 g: slip angle', (m) => `${m.liftOffSlipDeg.toFixed(1)}°`);
