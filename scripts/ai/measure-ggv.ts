/**
 * What each car can do, measured on its own physics: steady cornering, braking and traction limits against speed
 * (a g-g-v table), on the flat test pad with the aids the AI drives with.
 *
 *   npx tsx scripts/ai/measure-ggv.ts [--car f12026-car|amg-gt3|vf26|liana|mtr-496r|all] [--out public/ai/ggv.json]
 *
 * Cornering: an ISO 4138-style slow steer ramp at each held speed, the best 1 s mean lateral g (scripts/lib/handling-
 * tests.ts). Braking: full pedal with the AI's ABS from each speed, the mean deceleration from 0.15 s to 0.5 s.
 * Traction: full pedal with TC from each speed in a mid gear, the mean acceleration over 0.5 s. All on level ground
 * with no wind, warm tyres, a half fuel load (the car's default).
 */
import { writeFileSync } from 'node:fs';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { createSuzukiLianaSim } from '../../src/lib/sim/road/SuzukiLianaSim';
import { createMtr496rSim } from '../../src/lib/sim/proto/Mtr496rSim';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { createFlatTestTrack } from '../lib/flat-track';
import { steadyRamp } from '../lib/handling-tests';

type CarId = 'f12026-car' | 'amg-gt3' | 'vf26' | 'liana' | 'mtr-496r';
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const which = opt('car', 'all');
const outPath = opt('out', '');
const pad = createFlatTestTrack(40_000, 3000);
const DT = 1 / 240;

const makers: Record<CarId, () => SimulatorCar> = {
  'f12026-car': () => new F12026CarSim(pad),
  'amg-gt3': () => createAmgGt3Sim(pad),
  vf26: () => new F1Physics2026(pad),
  liana: () => createSuzukiLianaSim(pad),
  'mtr-496r': () => createMtr496rSim(pad),
};

function straightLine(make: () => SimulatorCar, vMs: number, mode: 'brake' | 'throttle', windowS: number): number {
  const car = make();
  car.assistPreset = 'semi_pro';
  car.autoGearbox = true;
  car.teleportToDistance(1500, vMs, 0);
  // Settle at speed (holding it), then apply the pedal
  for (let t = 0; t < 1.0; t += DT) car.step(DT, { throttle: 0.6 * (vMs / 90) + 0.2, analogSteer: 0 });
  car.teleportToDistance(car.sMeters, vMs, 0);
  for (let t = 0; t < 0.3; t += DT) car.step(DT, { throttle: 0.6 * (vMs / 90) + 0.2, analogSteer: 0 });
  // From 0.15 s after the pedal (brake pressure and the engine's torque build over the first tenth or so)
  let t = 0;
  let v0 = car.vxMs;
  for (; t < 0.15 + windowS; t += DT) {
    if (t < 0.15) v0 = car.vxMs;
    car.step(DT, mode === 'brake' ? { brake: 1, analogSteer: 0 } : { throttle: 1, analogSteer: 0 });
  }
  return (car.vxMs - v0) / windowS / 9.81;
}

const result: Record<string, { speedsMs: number[]; latG: number[]; brakeG: number[]; accelG: number[] }> = {};
for (const id of (which === 'all' ? Object.keys(makers) : [which]) as CarId[]) {
  const make = makers[id];
  // The road car tops out near 52 m/s
  const speeds = id === 'liana' ? [10, 15, 20, 25, 30, 35, 40, 45, 50] : [15, 25, 35, 45, 55, 65, 75, 85];
  const row = { speedsMs: speeds, latG: [] as number[], brakeG: [] as number[], accelG: [] as number[] };
  for (const v of speeds) {
    row.latG.push(steadyRamp(make, v, 10).maxG);
    row.brakeG.push(-straightLine(make, v, 'brake', 0.35));
    row.accelG.push(straightLine(make, v, 'throttle', 0.5));
  }
  result[id] = row;
  console.log(`\n${id}`);
  console.log(`  speed km/h  ${speeds.map((v) => String(Math.round(v * 3.6)).padStart(6)).join('')}`);
  console.log(`  lateral g   ${row.latG.map((g) => g.toFixed(2).padStart(6)).join('')}`);
  console.log(`  braking g   ${row.brakeG.map((g) => g.toFixed(2).padStart(6)).join('')}`);
  console.log(`  traction g  ${row.accelG.map((g) => g.toFixed(2).padStart(6)).join('')}`);
}
if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 1));
