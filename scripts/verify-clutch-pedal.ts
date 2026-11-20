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
import { CLUTCH_BITE_LOCK, CLUTCH_BITE_START, clutchPedalEngagement } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { DEFAULT_PLAYER_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';
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

  // Default autoClutch keeps the engine running at standstill and under braking in gear
  const noStall = standing(car.make);
  noStall.autoGearbox = false;
  noStall.autoClutch = true;
  drive(noStall, 1.5, { throttle: 0, brake: 1, clutch: 0 });
  check('auto-clutch on: braking at rest in gear does not stall', noStall.telemetry.engineStalled === false && noStall.telemetry.rpm > 400, `${noStall.telemetry.rpm} rpm`);
}

console.log('\n== Full manual clutch: bite point, slip, stalling and restart');
check('default settings enable auto-clutch and semi-pro assists', DEFAULT_PLAYER_SETTINGS.autoClutch === true && DEFAULT_PLAYER_SETTINGS.assistPreset === 'semi_pro', `autoClutch=${DEFAULT_PLAYER_SETTINGS.autoClutch}, preset=${DEFAULT_PLAYER_SETTINGS.assistPreset}`);
check('autoClutch persists through settings save/load', parsePlayerSettings({ autoClutch: false }).autoClutch === false && parsePlayerSettings({}).autoClutch === true, '');
check(
  'bite point curve: open at floor, progressive in bite zone, locked near top',
  clutchPedalEngagement(1) === 0 &&
    clutchPedalEngagement(CLUTCH_BITE_START) === 0 &&
    clutchPedalEngagement(0.65) > 0 &&
    clutchPedalEngagement(0.65) < 0.5 &&
    clutchPedalEngagement(0.4) > clutchPedalEngagement(0.65) &&
    clutchPedalEngagement(CLUTCH_BITE_LOCK) === 1 &&
    clutchPedalEngagement(0) === 1,
  `p=0.65 -> ${clutchPedalEngagement(0.65).toFixed(2)}, p=0.40 -> ${clutchPedalEngagement(0.4).toFixed(2)}`,
);

// Suzuki Liana (manual road car): dump clutch -> stall, restart via clutch, smooth bite-point launch
const liana = standing(() => createSuzukiLianaSim(track));
liana.autoGearbox = false;
liana.autoClutch = false;
// Hold brake and dump clutch in 1st with no throttle -> stalls
drive(liana, 1.0, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: dumping clutch at standstill stalls the engine', liana.telemetry.engineStalled === true && liana.telemetry.rpm < 200, `stalled=${liana.telemetry.engineStalled}, ${liana.telemetry.rpm} rpm`);

// Hold clutch in to crank and restart
drive(liana, 0.8, { throttle: 0, brake: 1, clutch: 1 });
check('manual clutch: holding clutch restarts a stalled engine', liana.telemetry.engineStalled === false && liana.telemetry.rpm >= 600, `stalled=${liana.telemetry.engineStalled}, ${liana.telemetry.rpm} rpm`);

// Smooth bite-point launch: bring revs up slightly, slip clutch through bite zone, then release -> drives off cleanly
drive(liana, 0.25, { throttle: 0.45, brake: 0, clutch: 1 });
let peakSlip = 0;
for (let t = 0; t < 0.9; t += DT) {
  const pedal = Math.max(0, 0.78 - (t / 0.9) * 0.78);
  liana.step(DT, { throttle: 0.45, brake: 0, clutch: pedal });
  peakSlip = Math.max(peakSlip, liana.telemetry.clutchSlip ?? 0);
}
drive(liana, 2.0, { throttle: 0.5, brake: 0, clutch: 0 });
check(
  'manual clutch: bite-point slip launch accelerates without stalling',
  liana.telemetry.engineStalled === false && peakSlip > 0.05 && liana.telemetry.speedKmh > 15,
  `stalled=${liana.telemetry.engineStalled}, peakSlip=${peakSlip.toFixed(2)}, ${liana.telemetry.speedKmh.toFixed(1)} km/h`,
);

// Braking to a complete stop in gear without pressing clutch stalls
drive(liana, 2.5, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: braking to a stop in gear without clutching stalls', liana.telemetry.engineStalled === true, `stalled=${liana.telemetry.engineStalled}, ${liana.telemetry.rpm} rpm`);

// Shifting to Neutral restarts
liana.step(DT, { throttle: 0, brake: 1, neutral: true, clutch: 0 });
drive(liana, 0.8, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: shifting to neutral restarts a stalled engine', liana.telemetry.engineStalled === false && liana.telemetry.gear === 0 && liana.telemetry.rpm >= 600, `gear=${liana.telemetry.gear}, ${liana.telemetry.rpm} rpm`);

// Re-enabling autoClutch immediately recovers a stalled car
liana.step(DT, { shiftUp: true, clutch: 1 });
drive(liana, 1.0, { throttle: 0, brake: 1, clutch: 0 });
const stalledAgain = liana.telemetry.engineStalled === true;
liana.autoClutch = true;
drive(liana, 0.1, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: turning auto-clutch back on recovers stall', stalledAgain && liana.telemetry.engineStalled === false && liana.telemetry.rpm >= 600, `${liana.telemetry.rpm} rpm`);

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll clutch pedal checks passed.');
process.exit(failures.length ? 1 : 0);
