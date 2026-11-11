/**
 * Tyre smoke and skid marks (`src/lib/sim/tyre-slide-fx.ts`) on the rigid-body cars, driven headlessly on flat ground:
 *
 *   npx tsx scripts/verify-tyre-slide-fx.ts
 *
 * A clean corner taken up to the car's peak lateral grip leaves neither smoke nor marks, nor does firm braking that
 * keeps the wheels rolling; a locked wheel smokes and marks the road, the more from higher speed.
 */
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { VF26_TUNED_CONFIG } from '../src/lib/sim/f12026-car/Vf26Tune';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { MTR_496R_CONFIG } from '../src/lib/sim/proto/Mtr496rConfig';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';
import { lockShareOf, tyreMarkLevel, tyreSmokeLevel } from '../src/lib/sim/tyre-slide-fx';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);

type Wheel = VehiclePhysics['wheels'][number];
/** Smoke and mark levels from what `F12026CarSim` hands the renderer for this wheel */
const fxOf = (w: Wheel, level: typeof tyreSmokeLevel) =>
  w.fz > 0 ? level(w.fz, w.combinedSlip, Math.hypot(w.slipVelX, w.vy), lockShareOf(w.slipVelX, w.vx)) : 0;
const smokeOf = (w: Wheel) => fxOf(w, tyreSmokeLevel);
const markOf = (w: Wheel) => fxOf(w, tyreMarkLevel);
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);

const CARS = [
  { name: 'VF26', config: VF26_TUNED_CONFIG, fullSteer: 0.6 },
  { name: 'AMG GT3', config: AMG_GT3_CONFIG, fullSteer: 0.6 },
  { name: 'MTR 496R', config: MTR_496R_CONFIG, fullSteer: 0.6 },
  { name: 'Liana', config: SUZUKI_LIANA_CONFIG, fullSteer: 1 },
];

for (const { name, config, fullSteer } of CARS) {
  console.log(`\n== ${name}`);
  const make = () => new VehiclePhysics({ ground: flat, config: config as never, airDensity: 1.225 });

  // A steer ramp at constant speed: every frame up to the peak lateral g is a clean corner on the limit
  for (const kmh of [80, 160]) {
    const car = make();
    car.reset(0, 0, 0, kmh / 3.6);
    const frames: { lat: number; smoke: number; mark: number }[] = [];
    for (let t = 0; t < 8; t += DT) {
      const inp: VehicleInputs = { throttle: Math.min(1, Math.max(0, 0.3 + (kmh / 3.6 - car.speedMs) * 0.3)), brake: 0, steer: Math.min(1, t / 8) * fullSteer };
      car.step(DT, inp);
      frames.push({ lat: Math.abs(car.telemetry.latG), smoke: Math.max(...car.wheels.map(smokeOf)), mark: Math.max(...car.wheels.map(markOf)) });
    }
    const peak = Math.max(...frames.map((f) => f.lat));
    const ip = frames.findIndex((f) => f.lat === peak);
    for (const k of ['smoke', 'mark'] as const) {
      const clean = Math.max(...frames.slice(0, ip + 1).map((f) => f[k]));
      const past = Math.max(...frames.slice(ip + 1).map((f) => f[k]), 0);
      check(`Clean corner at ${kmh} km/h up to ${peak.toFixed(2)} g: no ${k === 'mark' ? 'marks' : k}`, clean < 0.03, `max ${clean.toFixed(3)} (past the peak ${past.toFixed(2)})`);
    }
  }

  // Full brake pedal, no ABS: the frames with a wheel locked at speed, and those with a wheel still rolling (under
  // 10 % slip). Between them a wheel going into a lock starts to smoke a moment before it stops
  for (const kmh of [100, 250]) {
    const car = make();
    car.reset(0, 0, 0, kmh / 3.6);
    const locked: Wheel[] = [];
    const rolling: Wheel[] = [];
    for (let t = 0; t < 8 && car.speedMs > 8; t += DT) {
      car.step(DT, { throttle: 0, brake: 1, steer: 0 });
      for (const w of car.wheels) {
        const lock = lockShareOf(w.slipVelX, w.vx);
        if (w.fz <= 300) continue;
        const copy = { fz: w.fz, combinedSlip: w.combinedSlip, slipVelX: w.slipVelX, vy: w.vy, vx: w.vx } as Wheel;
        if (lock > 0.9 && Math.abs(w.vx) > 15) locked.push(copy);
        else if (lock < 0.1) rolling.push(copy);
      }
    }
    for (const [k, of] of [['smoke', smokeOf], ['mark', markOf]] as const) {
      const r = Math.max(0, ...rolling.map(of));
      check(`Braking from ${kmh} km/h, wheels rolling: no ${k === 'mark' ? 'marks' : k}`, r < 0.03, `max ${r.toFixed(3)} over ${rolling.length} wheel-steps`);
      if (locked.length) check(`Braking from ${kmh} km/h, a wheel locked above 54 km/h: ${k === 'mark' ? 'marks' : k}`, median(locked.map(of)) > 0.4, `median ${median(locked.map(of)).toFixed(2)} over ${locked.length} wheel-steps`);
    }
    if (!locked.length) console.log(`      no wheel locked above 54 km/h from ${kmh} km/h`);
  }

  // Cruising straight at speed
  {
    const car = make();
    car.reset(0, 0, 0, 200 / 3.6);
    let max = 0;
    for (let t = 0; t < 3; t += DT) {
      car.step(DT, { throttle: 0.6, brake: 0, steer: 0 });
      max = Math.max(max, ...car.wheels.map(smokeOf), ...car.wheels.map(markOf));
    }
    check('Straight at 200 km/h: no smoke or marks', max < 0.01, `max ${max.toFixed(3)}`);
  }
}

console.log('\n== Smoke and mark model');
{
  // A locked tyre at 40 m/s under 4 kN; the same sliding at 12 m/s well past its peak; a tyre on the limit
  const lock = tyreSmokeLevel(4000, 5000, 40, 1);
  const slowLock = tyreSmokeLevel(3000, 5000, 6, 1);
  const slide = tyreSmokeLevel(4000, 1.8, 12, 0);
  const limit = tyreSmokeLevel(6000, 1.0, 6, 0);
  check('A lock-up smokes more from speed than near a stop', lock > 0.9 && slowLock < lock && slowLock > 0, `${lock.toFixed(2)} vs ${slowLock.toFixed(2)}`);
  check('A tyre on its grip peak does not smoke, one past it a little', limit === 0 && slide > 0 && slide < 0.3, `${limit.toFixed(2)} / ${slide.toFixed(2)}`);
  check('No load, no smoke', tyreSmokeLevel(0, 5000, 40, 1) === 0, '');
  // A slide that marks the road before it smokes
  const lightMark = tyreMarkLevel(4000, 1.8, 6, 0);
  const lightSmoke = tyreSmokeLevel(4000, 1.8, 6, 0);
  check('A light slide marks the road before it smokes', lightMark > 0 && lightSmoke === 0, `mark ${lightMark.toFixed(2)}, smoke ${lightSmoke.toFixed(2)}`);
  check('A tyre on its grip peak leaves no mark', tyreMarkLevel(6000, 1.0, 6, 0) === 0, '');
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll tyre smoke and skid mark checks passed');
