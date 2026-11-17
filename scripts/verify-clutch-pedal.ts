/**
 * The driver's clutch pedal through the car adapter, on flat ground:
 *   npx tsx scripts/verify-clutch-pedal.ts
 *
 * Held, the clutch is open: the engine revs on the spot and the car stays put. Let out, the car drives off. Never
 * pressed (absent or 0), the car drives exactly as it did before the pedal existed. The autopilot drives on the car's
 * own clutch whatever the pedal says.
 */
import { createFlatTestTrack } from './lib/flat-track';
import { createBmwM1ProcarSim } from '../src/lib/sim/classic/BmwM1ProcarSim';
import { createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import type { ControlInputs } from '../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 120;
const track = createFlatTestTrack(30_000, 3000);

const CARS: { name: string; make: () => F12026CarSim }[] = [
  { name: 'BMW M1 Procar', make: () => createBmwM1ProcarSim(track) },
  { name: 'Suzuki Liana', make: () => createSuzukiLianaSim(track) },
  { name: 'Mercedes-AMG GT3', make: () => createAmgGt3Sim(track, null) },
];

/** A car at rest on the flat, on the player's settings with no aids */
function standing(make: () => F12026CarSim): F12026CarSim {
  const sim = make();
  sim.assistPreset = 'pro';
  sim.teleportToDistance(1000, 0);
  return sim;
}

const drive = (sim: F12026CarSim, seconds: number, inputs: Partial<ControlInputs>) => {
  for (let t = 0; t < seconds; t += DT) sim.step(DT, { ...inputs });
};

for (const car of CARS) {
  console.log(`\n== ${car.name}`);

  // Clutch held with half throttle: the engine revs free of the wheels and the car stays where it is
  const held = standing(car.make);
  drive(held, 0.5, { throttle: 0.5, clutch: 1 });
  drive(held, 2, { throttle: 0.5, clutch: 1 });
  const heldKmh = held.telemetry.speedKmh;
  const heldRpm = held.telemetry.rpm;
  check('clutch held: the car stays put', heldKmh < 1, `${heldKmh.toFixed(2)} km/h`);
  check('clutch held: the engine revs on the spot', heldRpm > 2500, `${Math.round(heldRpm)} rpm, engagement ${held.telemetry.clutch.toFixed(2)}`);

  // Let out over half a second, the throttle held: it drives off
  for (let t = 0; t < 0.5; t += DT) held.step(DT, { throttle: 0.5, clutch: 1 - t / 0.5 });
  drive(held, 2, { throttle: 0.5 });
  check('clutch let out: the car drives off', held.telemetry.speedKmh > 15, `${held.telemetry.speedKmh.toFixed(1)} km/h`);

  // Never pressed: absent and 0 give the very same car, step for step
  const absent = standing(car.make);
  const zero = standing(car.make);
  let same = true;
  for (let t = 0; t < 6 && same; t += DT) {
    absent.step(DT, { throttle: 1 });
    zero.step(DT, { throttle: 1, clutch: 0 });
    same = absent.telemetry.speedKmh === zero.telemetry.speedKmh && absent.telemetry.rpm === zero.telemetry.rpm;
  }
  check('clutch at 0: the same car as without a pedal', same, `${absent.telemetry.speedKmh.toFixed(3)} / ${zero.telemetry.speedKmh.toFixed(3)} km/h`);

  // The autopilot drives on the car's own clutch, whatever the pedal says
  const auto = standing(car.make);
  auto.aiAutopilot = true;
  drive(auto, 4, { throttle: 0, clutch: 1 });
  check('autopilot: the pedal is not its clutch', auto.telemetry.speedKmh > 10, `${auto.telemetry.speedKmh.toFixed(1)} km/h`);
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll clutch pedal checks passed.');
process.exit(failures.length ? 1 : 0);
