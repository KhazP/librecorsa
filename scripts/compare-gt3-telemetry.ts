/**
 * Compares the GT3 vehicle model against reference GT3 telemetry logs (Valencia, 3 runs, ~24 min;
 * TC 3, ABS 3, race setup). G channels in those logs are in g.
 *
 *   npx tsx "scripts/compare-gt3-telemetry.ts"
 *
 * The reference numbers are what a quick driver achieved, so they are lower bounds of the car: sustained (1 s) lateral g by
 * speed, braking g by speed (95th percentile above 60 % pedal), full-throttle g by speed, engine rpm per m/s of rear
 * wheel speed by gear, the slip the ABS and TC allow, and the steering needed per curvature and per g.
 * Sea-level air (ρ 1.2) like Valencia, flat ground.
 */
import * as THREE from 'three';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';

/** [km/h, value] from reference GT3 MoTeC logs */
const REF = {
  lateralG: [[81, 1.7], [99, 1.79], [117, 1.79], [153, 2.13], [171, 2.01]] as const,
  brakingG: [[99, 1.68], [117, 1.72], [153, 1.83], [189, 2.03], [225, 2.11], [243, 2.12]] as const,
  throttleG: [[63, 0.95], [99, 0.77], [135, 0.64], [171, 0.45], [207, 0.3], [243, 0.19]] as const,
  rpmPerMs: { 2: 181.2, 3: 141.3, 4: 115.3, 5: 100.8 } as Record<number, number>,
  limiterRpm: 7899,
  absFrontSlip: 0.077,
  tcRearSlip: 0.091,
  /** Road-wheel understeer gradient (deg per g), from steering-wheel angle = A·κ + B·a_y with a 12.6 ratio (0.2–1.6 g; the
   * 144–216 km/h bins alone, linear range, give 1.25–1.6) */
  understeerDegPerG: 1.44,
};

const DT = 1 / 120;
const RHO = 1.2;
const flat = new FlatGroundQuery(0);
const cfg = AMG_GT3_CONFIG;
const makeCar = (v0 = 0) => {
  const c = new VehiclePhysics({ ground: flat, config: cfg, airDensity: RHO });
  c.reset(0, 0, 0, v0);
  return c;
};
const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const row = (name: string, ours: number, ref: number, d = 2) =>
  console.log(`  ${name.padEnd(30)} ours ${fmt(ours, d).padStart(7)}   REF ${fmt(ref, d).padStart(7)}   ${fmt((ours / ref - 1) * 100, 0).padStart(4)} %`);
function run(car: VehiclePhysics, seconds: number, drive: (c: VehiclePhysics, t: number) => VehicleInputs, each?: (c: VehiclePhysics, t: number) => boolean): void {
  for (let t = 0; t < seconds; t += DT) {
    car.step(DT, drive(car, t));
    if (each?.(car, t)) break;
  }
}
const bodySlip = (c: VehiclePhysics) => {
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion);
  const lat = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion);
  return Math.atan2(c.velocity.dot(lat), c.velocity.dot(fwd));
};

console.log('\n== Sustained lateral g (slow steer ramp at constant speed, best 1 s average)');
const slopes: { invV2: number; degPerG: number }[] = [];
for (const [kmh, ref] of REF.lateralG) {
  const car = makeCar(kmh / 3.6);
  let pedal = 0.3;
  const hist: number[] = [];
  let best = 0;
  const pts: [number, number][] = [];
  let steer = 0;
  run(car, 14, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    // Full lock is reached at 81 km/h; faster, the ramp tops out where the same lateral g needs it (∝ 1/v²)
    steer = Math.min(1, t / 14) * 0.9 * Math.min(1, 1.6 * (81 / kmh) ** 2);
    return { throttle: pedal, brake: 0, steer: -steer };
  }, (c, t) => {
    const ay = Math.abs(c.telemetry.latG);
    hist.push(ay);
    if (hist.length > 120) hist.shift();
    if (hist.length === 120) best = Math.max(best, hist.reduce((a, b) => a + b, 0) / 120);
    // Road-wheel angle vs lateral g in the linear range (reference high-speed bins give the same ~1.4 deg/g there)
    if (ay > 0.2 && ay < 1.0 && t > 1) pts.push([ay, steer * cfg.chassis.maxRoadWheelDeg]);
    return Math.abs(bodySlip(c)) > 0.35;
  });
  row(`${kmh} km/h`, best, ref);
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const k = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  slopes.push({ invV2: 1 / (kmh / 3.6) ** 2, degPerG: k });
}
{
  // dδ/da_y = 57.3·L·g / v² + K: the intercept against 1/v² is the understeer gradient
  const n = slopes.length;
  const mx = slopes.reduce((a, p) => a + p.invV2, 0) / n;
  const my = slopes.reduce((a, p) => a + p.degPerG, 0) / n;
  const m = slopes.reduce((a, p) => a + (p.invV2 - mx) * (p.degPerG - my), 0) / slopes.reduce((a, p) => a + (p.invV2 - mx) ** 2, 0);
  console.log(`  road-wheel steer per g: ${slopes.map((p) => fmt(p.degPerG, 2)).join(' / ')} deg; geometric term ${fmt(m / 57.3 / 9.81, 2)} m (wheelbase ${cfg.chassis.wheelbase})`);
  row('understeer gradient (deg/g)', my - m * mx, REF.understeerDegPerG);
}

console.log('\n== Braking g at speed (threshold braking, slip held at reference ABS level)');
for (const [kmh, ref] of REF.brakingG) {
  const car = makeCar(kmh / 3.6 + 3);
  let pedal = 1;
  let g = NaN;
  run(car, 3, (c) => {
    const sr = Math.min(...c.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (sr < -REF.absFrontSlip ? -0.08 : 0.04), 0.2, 1);
    return { throttle: 0, brake: pedal, steer: 0 };
  }, (c) => {
    if (c.telemetry.speedKmh <= kmh) {
      g = -c.telemetry.lonG;
      return true;
    }
    return false;
  });
  row(`${kmh} km/h`, g, ref);
}

console.log('\n== Full-throttle g at speed (rear slip held at reference TC level)');
{
  const car = makeCar(40 / 3.6);
  let pedal = 0.6;
  const seen = new Map<number, number>();
  run(car, 60, (c) => {
    const sr = Math.max(c.wheels[2].slipRatio, c.wheels[3].slipRatio);
    pedal = THREE.MathUtils.clamp(pedal + (REF.tcRearSlip - sr) * 0.25, 0.3, 1);
    return { throttle: pedal, brake: 0, steer: 0 };
  }, (c) => {
    for (const [kmh] of REF.throttleG) if (!seen.has(kmh) && c.telemetry.speedKmh >= kmh) seen.set(kmh, c.telemetry.lonG);
    return seen.size === REF.throttleG.length;
  });
  for (const [kmh, ref] of REF.throttleG) row(`${kmh} km/h`, seen.get(kmh) ?? NaN, ref);
}

console.log('\n== Gearing and engine');
{
  const gb = cfg.gearbox;
  const R = cfg.tyreCompounds.PhysicsTyreCompound_GT3_Soft.rear.radius;
  for (const g of [2, 3, 4, 5]) row(`gear ${g} rpm per m/s`, (gb.ratios[g - 1] * gb.finalDrive * 60) / (2 * Math.PI * R), REF.rpmPerMs[g], 1);
  row('limiter rpm', gb.gears.redline_rpm, REF.limiterRpm, 0);
}
