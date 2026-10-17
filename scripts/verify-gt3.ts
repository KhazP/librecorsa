/**
 * Headless checks for the Mercedes-AMG GT3 (`src/lib/sim/gt3`): the f12026-car vehicle model on the GT3 data.
 *
 *   npx tsx scripts/verify-gt3.ts
 *
 * Straight line, braking, cornering on flat ground, ABS / TC through the simulator adapter, then autopilot laps
 * on the real Rwanda colliders. The ranges are what a GT3 car does, not tuned to these numbers (see `AmgGt3Config`).
 */
import * as THREE from 'three';
import { getRwandaTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { AMG_GT3_PROFILE_CAR, createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { brakingGuideFor } from '../src/lib/sim/speed-profile';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { checkBarrierCrashes, vehicleCrashCar } from './lib/barrier-crash';
import { TrackWallQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);

const makeCar = () => new VehiclePhysics({ ground: flat, config: AMG_GT3_CONFIG, airDensity: 1.06 });

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, stop?: (car: VehiclePhysics, t: number) => boolean): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, drive(car, t));
    t += DT;
    if (stop?.(car, t)) break;
  }
  return t;
}

console.log('\n== AMG GT3 config');
{
  const c = AMG_GT3_CONFIG;
  check('No hybrid, no brake-by-wire', c.ers.ERS_MAX_DEPLOY === 0 && c.ers.maxHarvestW === 0 && c.brakes.brakeByWire === false, '');
  check('6 gears, 7700 rpm limiter', c.gearbox.ratios.length === 6 && c.gearbox.gears.redline_rpm === 7700, '');
}

console.log('\n== Straight line (flat ground, ρ 1.06)');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  let pedal = 0.6;
  let t100 = NaN;
  let t200 = NaN;
  let vmax = 0;
  run(car, 60, (c) => {
    const sr = Math.max(c.wheels[2].slipRatio, c.wheels[3].slipRatio);
    pedal = THREE.MathUtils.clamp(pedal + (0.1 - sr) * 0.25, 0.3, 1);
    return { throttle: pedal, brake: 0, steer: 0 };
  }, (c, time) => {
    const v = c.telemetry.speedKmh;
    if (Number.isNaN(t100) && v >= 100) t100 = time;
    if (Number.isNaN(t200) && v >= 200) t200 = time;
    vmax = Math.max(vmax, v);
    return false;
  });
  console.log(`      0-100 ${fmt(t100)} s, 0-200 ${fmt(t200)} s, vmax ${fmt(vmax, 1)} km/h in ${car.gear}th, MGU-K ${fmt(car.telemetry.MGUK_POWER, 0)} W`);
  check('0-100 km/h 3.0–4.2 s', t100 > 3.0 && t100 < 4.2, `${fmt(t100)} s`);
  check('0-200 km/h 8.5–12.5 s', t200 > 8.5 && t200 < 12.5, `${fmt(t200)} s`);
  // The gearing tops out at 307 km/h at the limiter; Rwanda's thin air lets it get close
  check('Top speed 270–307 km/h (ρ 1.06)', vmax > 270 && vmax < 307, `${fmt(vmax, 1)} km/h`);
  check('Shifted into 6th', car.gear === 6, `gear ${car.gear}`);

  const b = makeCar();
  b.reset(0, 0, 0, 250 / 3.6);
  let pedalB = 1;
  let peakG = 0;
  const z0 = b.position.z;
  let dist = 0;
  run(b, 10, (c) => {
    const sr = Math.min(...c.wheels.map((w) => w.slipRatio));
    pedalB = THREE.MathUtils.clamp(pedalB + (sr < -0.13 ? -0.1 : 0.05), 0.2, 1);
    return { throttle: 0, brake: pedalB, steer: 0 };
  }, (c) => {
    peakG = Math.max(peakG, -c.telemetry.lonG);
    dist = c.position.z - z0;
    return c.telemetry.speedKmh <= 80;
  });
  check('Braking 250→80 km/h 105–165 m', dist > 105 && dist < 165, `${fmt(dist, 1)} m, peak ${fmt(peakG, 2)} g`);
  check('Peak deceleration 1.6–2.5 g', peakG > 1.6 && peakG < 2.5, `${fmt(peakG, 2)} g`);

  // The braking line's planning model (AMG_GT3_PROFILE_CAR) must stop no shorter than the car does, and not much longer
  const pm = AMG_GT3_PROFILE_CAR;
  let planned = 0;
  for (let v = 250 / 3.6; v > 80 / 3.6; v -= 0.05) {
    const grip = pm.muLong * (9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  check('Braking line plans 250→80 km/h 0–15 % longer', planned >= dist && planned < dist * 1.15, `${fmt(planned, 1)} m planned vs ${fmt(dist, 1)} m driven`);
  const dfCar = makeCar();
  dfCar.reset(0, 0, 0, 150 / 3.6);
  run(dfCar, 2, (c) => ({ throttle: c.telemetry.speedKmh < 150 ? 0.6 : 0.3, brake: 0, steer: 0 }));
  const dfPlan = pm.downforceCoef * dfCar.speedMs ** 2;
  check('Planned downforce at 150 km/h within 20 %', Math.abs(dfPlan / dfCar.telemetry.downforceN - 1) < 0.2, `${fmt(dfPlan, 0)} N planned vs ${fmt(dfCar.telemetry.downforceN, 0)} N`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed)');
for (const [kmh, lo, hi] of [
  [100, 1.3, 1.9],
  [220, 1.7, 2.5],
] as const) {
  const car = makeCar();
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  run(car, 8, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 8) * 0.9 };
  }, (c) => {
    maxLat = Math.max(maxLat, Math.abs(c.telemetry.latG));
    const beta = Math.atan2(c.velocity.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)), c.velocity.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion)));
    return Math.abs(beta) > 0.35;
  });
  check(`Peak lateral at ${kmh} km/h ${lo}–${hi} g`, maxLat > lo && maxLat < hi, `${fmt(maxLat, 2)} g`);
}

console.log('\n== Driver aids through the adapter (semi_pro vs pro)');
{
  const wide = createFlatTestTrack(30_000, 3000);
  const launch = (preset: 'pro' | 'semi_pro') => {
    const sim = createAmgGt3Sim(wide);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 3);
    let maxSr = 0;
    let t100 = NaN;
    for (let t = 0; t < 8; t += DT) {
      sim.step(DT, { throttle: 1 });
      // the mod's TC works from 40 km/h
      if (sim.telemetry.speedKmh > 60) maxSr = Math.max(maxSr, sim.telemetry.wheelSlipRatios[2], sim.telemetry.wheelSlipRatios[3]);
      if (Number.isNaN(t100) && sim.telemetry.speedKmh >= 100) t100 = t;
    }
    return { maxSr, t100 };
  };
  const tc = launch('semi_pro');
  const raw = launch('pro');
  check("TC holds wheelspin on a flat-out launch (from 60 km/h)", tc.maxSr < 0.2 && tc.maxSr < raw.maxSr, `max rear slip ${fmt(tc.maxSr, 2)} with TC, ${fmt(raw.maxSr, 2)} without; 0-100 ${fmt(tc.t100)} / ${fmt(raw.t100)} s`);
  const stop = (preset: 'pro' | 'semi_pro') => {
    const sim = createAmgGt3Sim(wide);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 220 / 3.6);
    let lock = 0;
    let s0 = sim.sMeters;
    for (let t = 0; t < 8 && sim.telemetry.speedKmh > 60; t += DT) {
      sim.step(DT, { brake: 1 });
      lock = Math.max(lock, -Math.min(...sim.telemetry.wheelSlipRatios));
    }
    return { lock, dist: sim.sMeters - s0 };
  };
  const abs = stop('semi_pro');
  const locked = stop('pro');
  check('ABS keeps the wheels turning on a stamp', abs.lock < 0.3 && abs.dist < locked.dist + 2, `max lock ${fmt(abs.lock, 2)} with ABS (${fmt(abs.dist, 0)} m), ${fmt(locked.lock, 2)} without (${fmt(locked.dist, 0)} m)`);
}

console.log('\n== Autopilot on the Rwanda colliders');
{
  const track = getRwandaTrackData();
  const root = loadGlbGeometry('public/tracks/rwanda/rwanda_2026.glb');
  const lap = (sim: F12026CarSim, pace: number) => {
    sim.resetToStartGrid(true);
    sim.aiAutopilot = true;
    sim.aiPaceScale = pace;
    const lap0 = sim.telemetry.lapCount;
    let t = 0;
    let beyond = -Infinity;
    let maxSlip = 0;
    while (t < 300 && sim.telemetry.lapCount < lap0 + 2) {
      sim.step(1 / 60, {});
      t += 1 / 60;
      beyond = Math.max(beyond, Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
      maxSlip = Math.max(maxSlip, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, sim.vxMs))) * 180) / Math.PI);
    }
    return { done: sim.telemetry.lapCount === lap0 + 2, lapS: (sim.telemetry.lastLapTimeMs ?? 0) / 1000, beyond, maxSlip, top: sim.telemetry.allTimeTopSpeedKmh };
  };
  // The GT3's braking line: longer braking zones and slower corners than the circuit's (VF26) line
  const guide = brakingGuideFor(track.samples, 'amg-gt3', AMG_GT3_PROFILE_CAR);
  const n = track.samples.length;
  const red = (zone: (i: number) => number) => Array.from({ length: n }, (_, i) => zone(i)).filter((z) => z >= 1).length * (track.totalLengthM / n);
  const redGt3 = red((i) => guide.brakingZone[i]);
  const redVf26 = red((i) => track.samples[i].brakingZone);
  const minGt3 = Math.min(...guide.speedMs) * 3.6;
  const minVf26 = Math.min(...track.samples.map((s) => s.optimalSpeedKmh));
  check('GT3 braking line: longer braking, slower apexes than the VF26', redGt3 > redVf26 && minGt3 < minVf26,
    `${fmt(redGt3, 0)} m vs ${fmt(redVf26, 0)} m of red, slowest corner ${fmt(minGt3, 0)} vs ${fmt(minVf26, 0)} km/h`);

  const gt3 = lap(createAmgGt3Sim(track, root), 1);
  const f1 = lap(new F12026CarSim(track, root), 1);
  check('GT3 autopilot full-pace lap stays on the asphalt', gt3.done && gt3.beyond <= 0 && gt3.maxSlip < 10,
    `lap ${fmt(gt3.lapS, 1)} s, top ${fmt(gt3.top, 0)} km/h, CG ${fmt(Math.max(0, gt3.beyond), 1)} m past the edge, max body slip ${fmt(gt3.maxSlip, 1)}°`);
  // A GT3 is ~25–35 % slower round a lap than an F1 car
  const ratio = gt3.lapS / f1.lapS;
  check('GT3 lap 1.15–1.45 × the f12026-car', ratio > 1.15 && ratio < 1.45, `${fmt(gt3.lapS, 1)} s vs ${fmt(f1.lapS, 1)} s (× ${fmt(ratio, 2)})`);

  console.log('\n== Barrier hits (missed braking points, Track_Collider_Wall_*)');
  checkBarrierCrashes(check, 'GT3', track, TrackWallQuery.fromTrackRoot(root), () => vehicleCrashCar(createAmgGt3Sim(track, root)));
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll GT3 checks passed.');
if (failures.length) process.exitCode = 1;
