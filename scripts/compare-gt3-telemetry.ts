/**
 * Compares the GT3 vehicle model against reference GT3 telemetry logs (Valencia, 3 runs, ~24 min;
 * TC 3, ABS 3, race setup). The manoeuvres and reference data live in `lib/gt3-reference.ts`;
 * `verify-gt3-telemetry.ts` asserts the same table.
 *
 *   npx tsx "scripts/compare-gt3-telemetry.ts"
 */
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { GT3_REF, measureGt3 } from './lib/gt3-reference';

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const row = (name: string, ours: number, ref: number, d = 2) =>
  console.log(`  ${name.padEnd(30)} ours ${fmt(ours, d).padStart(7)}   REF ${fmt(ref, d).padStart(7)}   ${fmt((ours / ref - 1) * 100, 0).padStart(4)} %`);

const m = measureGt3();

console.log('\n== Sustained lateral g (slow steer ramp at constant speed, best 1 s average)');
for (const [kmh, ours, ref] of m.lateralG) row(`${kmh} km/h`, ours, ref);
console.log(`  road-wheel steer per g: ${m.steerPerG.map((x) => fmt(x, 2)).join(' / ')} deg; geometric term ${fmt(m.geometricTermM, 2)} m (wheelbase ${AMG_GT3_CONFIG.chassis.wheelbase})`);
row('understeer gradient (deg/g)', m.understeerDegPerG, GT3_REF.understeerDegPerG);

console.log('\n== Braking g at speed (threshold braking, slip held at reference ABS level)');
for (const [kmh, ours, ref] of m.brakingG) row(`${kmh} km/h`, ours, ref);

console.log('\n== Full-throttle g at speed (rear slip held at reference TC level)');
for (const [kmh, ours, ref] of m.throttleG) row(`${kmh} km/h`, ours, ref);

console.log('\n== Gearing and engine');
for (const [g, ours, ref] of m.rpmPerMs) row(`gear ${g} rpm per m/s`, ours, ref, 1);
row('limiter rpm', m.limiterRpm, GT3_REF.limiterRpm, 0);
