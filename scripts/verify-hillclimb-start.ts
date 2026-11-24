/**
 * Point-to-point (hill climb) standing-start rules (#191):
 * - Spawning at rest inside the 10 m start box and launching across the line starts a valid run.
 * - Backing out past 10 m behind the line (the 60 m run-up on Goodwood / Borgloh) clears the standing-start flag so a
 *   flying start across the line is invalid, even though the car started at rest on the grid.
 * - Coming back to rest inside the 10 m box re-arms a valid standing start.
 * - Teleporting or restoring a pose at speed behind the line starts an invalid run.
 *
 *   npx tsx scripts/verify-hillclimb-start.ts
 */
import assert from 'node:assert/strict';
import { VEHICLE_MODELS } from '../src/lib/cars/vehicle-models';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { createFlatTestTrack } from './lib/flat-track';
import type { BuiltTrackData } from '../src/lib/track-data';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(68)} ${detail}`);
  if (!ok) failures.push(name);
};

const L = 5000;
const DT = 1 / 120;

function makeHillClimbTrack(): BuiltTrackData {
  const flat = createFlatTestTrack(L, 40, 1000);
  return {
    ...flat,
    pointToPoint: { finishS: 1900, endS: 2150, startS: L - 60 },
    spawnGrid: [
      {
        slot: 1,
        s: L - 6,
        lateral: 0,
        position: [0, 0, L - 6],
        yawRad: 0,
        forward: [0, 0, 1],
      },
    ],
  };
}

/** Step forward at full throttle until the car crosses s = 0, returning whether the run started valid */
function launchAcrossLine(car: SimulatorCar, maxSteps = 1200): { crossed: boolean; valid: boolean; speedKmh: number } {
  let prevS = car.sMeters;
  for (let i = 0; i < maxSteps; i++) {
    car.step(DT, { throttle: 1, brake: 0, analogSteer: 0 });
    if (prevS > L * 0.85 && car.sMeters < L * 0.15) {
      return { crossed: true, valid: car.telemetry.lapInvalid !== true, speedKmh: car.telemetry.speedKmh };
    }
    prevS = car.sMeters;
  }
  return { crossed: false, valid: false, speedKmh: car.telemetry.speedKmh };
}

/** Reverse from spawn until s < targetS (at least 10 m behind the line), then brake to a stop */
function reversePast(car: SimulatorCar, targetS: number, maxSteps = 1200): boolean {
  let reached = false;
  for (let i = 0; i < maxSteps; i++) {
    const needReverse = car.telemetry.gear >= 0;
    car.step(DT, {
      throttle: needReverse ? 0 : 0.7,
      brake: needReverse ? 1 : 0,
      shiftDown: needReverse && i % 15 === 0,
      analogSteer: 0,
    });
    if (car.sMeters < targetS && car.sMeters > L - 150) {
      reached = true;
      break;
    }
  }
  if (!reached) return false;
  // Brake cleanly to a standstill before shifting back into 1st (just like a player reversing to take a run-up)
  for (let i = 0; i < 600 && Math.abs(car.vxMs) > 0.05; i++) {
    car.step(DT, { throttle: 0, brake: 1, analogSteer: 0 });
  }
  return Math.abs(car.vxMs) <= 0.1 && car.sMeters < L - 10;
}

/** Shift into first gear from reverse/neutral while stationary */
function shiftToFirst(car: SimulatorCar): void {
  for (let i = 0; i < 120 && car.telemetry.gear < 1; i++) {
    car.step(DT, { throttle: 0, brake: 1, shiftUp: i % 15 === 0, analogSteer: 0 });
  }
}

const track = makeHillClimbTrack();

const engines: { name: string; create: () => SimulatorCar }[] = [
  { name: 'F1Physics2026 (lc26)', create: () => new F1Physics2026(track) },
  { name: 'F12026CarSim (f12026-car)', create: () => VEHICLE_MODELS['f12026-car'].createSim(track, null) },
  { name: 'F12026CarSim (amg-gt3)', create: () => VEHICLE_MODELS['amg-gt3'].createSim(track, null) },
];

for (const engine of engines) {
  console.log(`\n${engine.name}`);

  // 1. Normal standing start from grid spawn (L - 6 m)
  {
    const car = engine.create();
    car.resetToStartGrid(false);
    // Idle 0.2 s at rest, then launch
    for (let i = 0; i < 24; i++) car.step(DT, { throttle: 0, brake: 0, analogSteer: 0 });
    const res = launchAcrossLine(car);
    check(`${engine.name}: standing start from spawn is valid`, res.crossed && res.valid, `${res.speedKmh.toFixed(1)} km/h`);
  }

  // 2. Reverse-back flying start exploit (#191): spawn at rest, back up past L - 10 m, then launch across line
  {
    const car = engine.create();
    car.resetToStartGrid(false);
    // Let atRestOnLine latch at rest inside the 10 m box
    for (let i = 0; i < 24; i++) car.step(DT, { throttle: 0, brake: 0, analogSteer: 0 });
    const backed = reversePast(car, L - 25);
    assert.ok(backed, `${engine.name}: failed to reverse past L - 25 m (s=${car.sMeters.toFixed(1)}, gear=${car.telemetry.gear})`);
    shiftToFirst(car);
    const res = launchAcrossLine(car);
    check(
      `${engine.name}: backing out past 10 m invalidates flying start (#191)`,
      res.crossed && !res.valid,
      `${res.speedKmh.toFixed(1)} km/h, lapInvalid=${car.telemetry.lapInvalid}`,
    );
  }

  // 3. Back out past 10 m, roll back into the 10 m box, come to a full stop, then launch -> valid again
  {
    const car = engine.create();
    car.resetToStartGrid(false);
    const backed = reversePast(car, L - 20);
    assert.ok(backed, `${engine.name}: failed to reverse past L - 20 m`);
    shiftToFirst(car);
    // Creep into the 10 m box [L - 10, L - 2] and stop completely
    for (let i = 0; i < 1200; i++) {
      const inBox = car.sMeters >= L - 8 && car.sMeters < L - 1;
      car.step(DT, { throttle: inBox ? 0 : car.telemetry.speedKmh < 15 ? 0.25 : 0, brake: inBox ? 1 : 0, analogSteer: 0 });
      if (inBox && Math.abs(car.vxMs) < 0.1) break;
    }
    assert.ok(car.sMeters >= L - 10 && car.sMeters < L && Math.abs(car.vxMs) < 0.5, `${engine.name}: stopped inside 10 m box (s=${car.sMeters.toFixed(1)}, v=${car.vxMs.toFixed(2)})`);
    // Hold at rest briefly so atRestOnLine re-arms
    for (let i = 0; i < 10; i++) car.step(DT, { throttle: 0, brake: 1, analogSteer: 0 });
    const res = launchAcrossLine(car);
    check(`${engine.name}: stopping again inside 10 m re-arms a valid run`, res.crossed && res.valid, `${res.speedKmh.toFixed(1)} km/h`);
  }

  // 4. Teleport / restorePose behind the line at speed -> invalid
  {
    const car = engine.create();
    car.resetToStartGrid(false);
    car.teleportToDistance(L - 5, 25, 0);
    const res = launchAcrossLine(car);
    check(`${engine.name}: teleport at speed inside 10 m is invalid`, res.crossed && !res.valid, `${res.speedKmh.toFixed(1)} km/h`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll hill-climb standing-start checks passed.');
