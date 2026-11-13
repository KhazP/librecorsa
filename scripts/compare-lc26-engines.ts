/**
 * The LC26 on its two engines, side by side: `F1Physics2026` (the one it ships on) and the rigid-body `VehiclePhysics`
 * on the same data, then the car a driver gets on the rigid-body engine (that data tuned, `Lc26Tune.ts`), with the
 * reference envelope that came with the car's data (`LC26_AI_REFERENCE`).
 *
 *   npx tsx scripts/compare-lc26-engines.ts
 *
 * Flat ground, sea-level air, soft tyres, no driver aids, the same pedal and steering traces for both: straight-line
 * times, top speed, a stop from 300 km/h, sustained lateral g at five speeds, the steering it takes, and what the car
 * does past the limit. Prints a table; `scripts/verify-lc26-fold.ts` asserts the bands.
 */
import { measureLc26, LC26_ENGINES, LC26_TUNED, type Lc26Measurement } from './lib/lc26-measure';
import { LC26_AI_REFERENCE } from '../src/lib/sim/lc26-data';

const results: [string, Lc26Measurement][] = [...LC26_ENGINES, LC26_TUNED].map(({ name, make }) => [name, measureLc26(make)]);
const pad = (s: string, n: number) => s.padEnd(n);
const row = (label: string, pick: (m: Lc26Measurement) => string, ref = '') =>
  console.log(pad(label, 30) + results.map(([, m]) => pad(pick(m), 24)).join('') + ref);

console.log(pad('', 30) + results.map(([name]) => pad(name, 24)).join('') + 'reference');
const refAccel = (kmh: number) => {
  // The reference's time to a speed, read off its (s, m/s) points
  const pts = LC26_AI_REFERENCE.accel;
  const v = kmh / 3.6;
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][1]) return `${(pts[i - 1][0] + ((v - pts[i - 1][1]) / (pts[i][1] - pts[i - 1][1])) * (pts[i][0] - pts[i - 1][0])).toFixed(2)} s`;
  }
  return '';
};
for (const kmh of [100, 200, 300]) row(`0–${kmh} km/h`, (m) => `${m.accelS[kmh]?.toFixed(2) ?? '–'} s`, refAccel(kmh));
row('Top speed', (m) => `${m.topSpeedKmh.toFixed(0)} km/h`, `${LC26_AI_REFERENCE.topSpeedKmh} km/h`);
row('300–100 km/h', (m) => `${m.brakeM.toFixed(1)} m, ${m.brakePeakG.toFixed(2)} g`);
LC26_AI_REFERENCE.lateral.forEach(([v, a], i) => row(`Lateral g at ${(v * 3.6).toFixed(0)} km/h`, (m) => `${m.lateralG[i].toFixed(2)} g`, `${(a / 9.81).toFixed(2)} g`));
row('Steer for 1.5 g at 180 km/h', (m) => `${m.steerFor15G.toFixed(3)} of lock`);
row('Yaw rate overshoot, step steer', (m) => `${(m.stepOvershoot * 100).toFixed(0)} %`);
row('Lift-off at 2.5 g: slip angle', (m) => `${m.liftOffSlipDeg.toFixed(1)}°`);
