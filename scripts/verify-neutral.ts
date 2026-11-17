/**
 * Neutral through the car adapter, on flat ground:
 *   npx tsx scripts/verify-neutral.ts
 *
 * A neutral press takes the gear out at any speed and wins over a shift pressed with it. Out of neutral at a
 * standstill, up is first and down is reverse; on the move, either paddle (or the auto box on the throttle) puts in
 * the gear that fits the road speed, the revs matched, so the car neither over-revs nor locks its wheels. The
 * autopilot keeps its gear.
 */
import { createFlatTestTrack } from './lib/flat-track';
import { createBmwM1ProcarSim } from '../src/lib/sim/classic/BmwM1ProcarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import type { ControlInputs } from '../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 120;
const track = createFlatTestTrack(30_000, 3000);

const CARS: { name: string; make: () => F12026CarSim; redline: number }[] = [
  { name: 'BMW M1 Procar', make: () => createBmwM1ProcarSim(track), redline: 9200 },
  { name: 'Mercedes-AMG GT3', make: () => createAmgGt3Sim(track, null), redline: 7900 },
  { name: '2026 Prototype', make: () => new F12026CarSim(track, null), redline: 15000 },
];

function standing(make: () => F12026CarSim, autoGearbox: boolean): F12026CarSim {
  const sim = make();
  sim.assistPreset = 'semi_pro';
  sim.autoGearbox = autoGearbox;
  sim.teleportToDistance(1000, 0);
  return sim;
}
const drive = (sim: F12026CarSim, seconds: number, inputs: Partial<ControlInputs>) => {
  for (let t = 0; t < seconds; t += DT) sim.step(DT, { ...inputs });
};
/** One frame with a press in it, then a frame without */
const press = (sim: F12026CarSim, inputs: Partial<ControlInputs>) => {
  sim.step(DT, inputs);
  sim.step(DT, {});
};

for (const car of CARS) {
  console.log(`\n== ${car.name}`);

  // At a standstill: neutral, the engine revs free; up is first, then down from neutral is reverse
  const still = standing(car.make, false);
  drive(still, 0.3, {});
  press(still, { neutral: true });
  check('standstill: a neutral press takes the gear out', still.telemetry.gear === 0, `gear ${still.telemetry.gear}`);
  drive(still, 1.5, { throttle: 0.6 });
  check('in neutral: the car stays put on the throttle', still.telemetry.speedKmh < 1, `${still.telemetry.speedKmh.toFixed(2)} km/h, ${Math.round(still.telemetry.rpm)} rpm`);
  drive(still, 1, {});
  press(still, { shiftDown: true });
  check('standstill: down from neutral is reverse', still.telemetry.gear === -1, `gear ${still.telemetry.gear}`);
  drive(still, 0.5, {});
  press(still, { neutral: true });
  drive(still, 0.5, {});
  press(still, { shiftUp: true });
  check('standstill: up from neutral is first', still.telemetry.gear === 1, `gear ${still.telemetry.gear}`);

  // Both paddles in one frame: neutral wins over the shifts pressed with it
  const both = standing(car.make, false);
  drive(both, 0.3, {});
  press(both, { shiftUp: true, shiftDown: true, neutral: true });
  check('both paddles at once: neutral', both.telemetry.gear === 0, `gear ${both.telemetry.gear}`);

  // On the move: up to speed, neutral, coast; then a downshift puts in the gear for the speed, revs matched
  const moving = standing(car.make, true);
  drive(moving, 8, { throttle: 1 });
  const gearBefore = moving.telemetry.gear;
  moving.autoGearbox = false;
  press(moving, { neutral: true });
  drive(moving, 1, {});
  const coastKmh = moving.telemetry.speedKmh;
  check('at speed: neutral, the car coasts', moving.telemetry.gear === 0 && coastKmh > 60, `from gear ${gearBefore}, ${coastKmh.toFixed(0)} km/h, ${Math.round(moving.telemetry.rpm)} rpm`);
  press(moving, { shiftDown: true });
  const back = moving.telemetry.gear;
  const rpmIn = moving.telemetry.rpm;
  drive(moving, 0.3, {});
  const lostKmh = coastKmh - moving.telemetry.speedKmh;
  check('at speed: down from neutral is a gear for the speed, not reverse or first', back > 1, `gear ${back}`);
  check('at speed: the revs met the road, under the limiter', rpmIn > 2500 && rpmIn < car.redline, `${Math.round(rpmIn)} rpm`);
  check('at speed: no lock-up as the gear goes in', lostKmh < 12, `${lostKmh.toFixed(1)} km/h lost in 0.3 s off the throttle`);

  // The auto box: neutral holds off the throttle; on it, a gear for the speed goes back in
  const auto = standing(car.make, true);
  drive(auto, 8, { throttle: 1 });
  press(auto, { neutral: true });
  drive(auto, 0.5, {});
  check('auto box: neutral holds off the throttle', auto.telemetry.gear === 0, `gear ${auto.telemetry.gear}`);
  drive(auto, 0.5, { throttle: 1 });
  check('auto box: the throttle puts a gear for the speed back in', auto.telemetry.gear > 1, `gear ${auto.telemetry.gear}, ${auto.telemetry.speedKmh.toFixed(0)} km/h`);

  // The autopilot keeps its gear
  const ap = standing(car.make, true);
  ap.aiAutopilot = true;
  drive(ap, 3, {});
  press(ap, { neutral: true });
  check('autopilot: a neutral press is not its own', ap.telemetry.gear !== 0, `gear ${ap.telemetry.gear}`);
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll neutral checks passed.');
process.exit(failures.length ? 1 : 0);
