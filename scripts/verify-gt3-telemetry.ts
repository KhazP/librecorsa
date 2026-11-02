/**
 * GT3 calibration: the vehicle model stays within tolerance of the reference GT3 telemetry logs (Valencia MoTeC,
 * see `lib/gt3-reference.ts`) on sustained lateral g, understeer gradient, braking g, full-throttle g and gearing.
 * Any change to the GT3's tyres, aero, suspension or engine has to keep this table where it is.
 *
 * The logs are a quick driver's laps, so they are lower bounds of the car: the band allows a little more than the
 * reference and a little less (the model has no driver, kerbs or bumps).
 *
 * Run: npx tsx scripts/verify-gt3-telemetry.ts
 */
import { GT3_REF, measureGt3 } from './lib/gt3-reference';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}

const pct = (ours: number, ref: number) => (ours / ref - 1) * 100;
const band = (name: (at: number) => string, rows: [number, number, number][], lo: number, hi: number) => {
  for (const [at, ours, ref] of rows) {
    const d = pct(ours, ref);
    check(`${name(at)} within ${lo}…+${hi} % of the reference`, Number.isFinite(d) && d >= lo && d <= hi, `${ours.toFixed(2)} vs ${ref.toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(1)} %)`);
  }
};

const m = measureGt3();

console.log('Sustained lateral g');
band((at) => `lateral g at ${at} km/h`, m.lateralG, -12, 12);
const k = m.understeerDegPerG;
check('understeer gradient near the reference 1.44 deg/g', k > 1.1 && k < 1.8, `${k.toFixed(2)} deg/g`);
check('steer-per-g fit recovers the wheelbase', Math.abs(m.geometricTermM - 2.65) < 0.5, `${m.geometricTermM.toFixed(2)} m`);

console.log('Braking g');
band((at) => `braking g at ${at} km/h`, m.brakingG, -12, 12);

console.log('Full-throttle g');
band((at) => `full-throttle g at ${at} km/h`, m.throttleG, -15, 20);

console.log('Gearing');
band((g) => `gear ${g} rpm per m/s`, m.rpmPerMs, -1, 1);
check('limiter rpm', Math.abs(m.limiterRpm - GT3_REF.limiterRpm) <= 10, `${m.limiterRpm} rpm`);

console.log(`\nAll ${passed} GT3 telemetry checks passed.`);
