/**
 * Headless checks for the Suzuki Liana 1.6 (`src/lib/sim/road`): the f12026-car vehicle model on alekabul's Liana
 * data, driving its front wheels.
 *
 *   npx tsx scripts/verify-liana.ts
 *
 * Straight line, braking and cornering on flat ground, the front-wheel drive, ABS / TC through the simulator
 * adapter, then autopilot laps of the Top Gear test track. The ranges are the road car's (Suzuki's figures, Top Gear's
 * lap board) and the Assetto Corsa car's (its 100 % AI lapped 1:41.7–1:43.0 there), not tuned to these numbers.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { setActiveTrack, getActiveTrackData, type RawTrackJson } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';
import { SUZUKI_LIANA_PROFILE_CAR, createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const C = SUZUKI_LIANA_CONFIG;

const makeCar = () => new VehiclePhysics({ ground: flat, config: C, airDensity: 1.225 });

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, stop?: (car: VehiclePhysics, t: number) => boolean): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, drive(car, t));
    t += DT;
    if (stop?.(car, t)) break;
  }
  return t;
}

console.log('\n== Liana config');
{
  check('Front-wheel drive, five gears, 7000 rpm limiter', C.drivenAxle === 'front' && C.gearbox.ratios.length === 5 && C.gearbox.gears.redline_rpm === 7000, '');
  check('No hybrid, wings or brake-by-wire', C.ers.ERS_MAX_DEPLOY === 0 && C.aero.wings.length === 0 && C.brakes.brakeByWire === false, '');
  const car = makeCar();
  check('The engine drives the front wheels', car.drivenWheels[0] === 0 && car.drivenWheels[1] === 1, `wheels ${car.drivenWheels.join(', ')}`);
}

console.log('\n== At rest');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  run(car, 3, () => ({ throttle: 0, brake: 1, steer: 0 }));
  const travel = car.wheels.map((w) => w.compression * 1000);
  check('Settles off its bump stops', travel.every((mm, i) => Math.abs(mm) < (i < 2 ? 75 : 55)), `compression ${travel.map((m) => fmt(m, 1)).join(' / ')} mm`);
  const fz = car.wheels.map((w) => w.fz);
  const front = (fz[0] + fz[1]) / fz.reduce((a, b) => a + b, 0);
  // 64 % of the sprung mass on the front, as the mod's CG_LOCATION puts it, plus the hubs: 60.5 % of the car
  check('Front axle carries ≈ 60.5 % of the weight', Math.abs(front - 0.605) < 0.01, `${fmt(front * 100, 1)} %`);
}

console.log('\n== Straight line (flat ground, sea level)');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  let pedal = 0.6;
  let t100 = NaN;
  let vmax = 0;
  let rearDrive = 0;
  let frontDrive = 0;
  run(car, 90, (c) => {
    const sr = Math.max(c.wheels[0].slipRatio, c.wheels[1].slipRatio);
    pedal = THREE.MathUtils.clamp(pedal + (0.1 - sr) * 0.25, 0.3, 1);
    return { throttle: pedal, brake: 0, steer: 0 };
  }, (c, time) => {
    const v = c.telemetry.speedKmh;
    if (Number.isNaN(t100) && v >= 100) t100 = time;
    vmax = Math.max(vmax, v);
    frontDrive = Math.max(frontDrive, c.wheels[0].driveTorqueNm + c.wheels[1].driveTorqueNm);
    rearDrive = Math.max(rearDrive, Math.abs(c.wheels[2].driveTorqueNm) + Math.abs(c.wheels[3].driveTorqueNm));
    return false;
  });
  console.log(`      0-100 ${fmt(t100)} s, vmax ${fmt(vmax, 1)} km/h in ${car.gear}th`);
  check('Drive torque reaches the fronts only', frontDrive > 500 && rearDrive === 0, `front ${fmt(frontDrive, 0)} Nm, rear ${fmt(rearDrive, 0)} Nm`);
  // Suzuki quotes 11.7 s and 185 km/h. The mod's torque curve is the engine's own, which this model (as Assetto Corsa)
  // takes at the wheels: ≈ 9 % more than the road car puts down, so a little quicker
  check('0-100 km/h 10.0–12.5 s', t100 > 10.0 && t100 < 12.5, `${fmt(t100)} s`);
  check('Top speed 175–195 km/h', vmax > 175 && vmax < 195, `${fmt(vmax, 1)} km/h`);

  // A stamp on the pedal with the ABS on (the real car has it), as a road test does it
  const sim = createSuzukiLianaSim(createFlatTestTrack(30_000, 3000));
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 100 / 3.6);
  let peakG = 0;
  const s0 = sim.sMeters;
  for (let t = 0; t < 10 && sim.telemetry.speedKmh > 1; t += 1 / 120) {
    sim.step(1 / 120, { brake: 1 });
    peakG = Math.max(peakG, -sim.telemetry.longitudinalG);
  }
  const dist = sim.sMeters - s0;
  // A 2002 small saloon on its road tyres: ≈ 40–45 m; the mod's brakes top out near 0.9 g
  check('ABS stop 100→0 km/h 38–52 m', dist > 38 && dist < 52, `${fmt(dist, 1)} m, peak ${fmt(peakG, 2)} g`);

  const pm = SUZUKI_LIANA_PROFILE_CAR;
  let planned = 0;
  for (let v = 100 / 3.6; v > 1; v -= 0.05) {
    const grip = pm.muLong * (9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  check('Braking line plans 100→0 km/h 0–15 % longer', planned >= dist && planned < dist * 1.15, `${fmt(planned, 1)} m planned vs ${fmt(dist, 1)} m stopped`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed)');
// A 2002 economy saloon on 185/65 R14s holds ≈ 0.75–0.8 g
for (const [kmh, lo, hi] of [
  [60, 0.7, 0.95],
  [110, 0.7, 0.95],
] as const) {
  const car = makeCar();
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  let frontSa = 0;
  let rearSa = 0;
  run(car, 10, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 10) * 0.6 };
  }, (c) => {
    const lat = Math.abs(c.telemetry.latG);
    if (lat > maxLat) {
      maxLat = lat;
      frontSa = 0.5 * (Math.abs(c.wheels[0].slipAngleRad) + Math.abs(c.wheels[1].slipAngleRad));
      rearSa = 0.5 * (Math.abs(c.wheels[2].slipAngleRad) + Math.abs(c.wheels[3].slipAngleRad));
    }
    const beta = Math.atan2(c.velocity.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)), c.velocity.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion)));
    return Math.abs(beta) > 0.35;
  });
  check(`Peak lateral at ${kmh} km/h ${lo}–${hi} g`, maxLat > lo && maxLat < hi, `${fmt(maxLat, 2)} g`);
  // A nose-heavy front-driver runs out of front grip first
  check(`Understeers at the limit at ${kmh} km/h`, frontSa > rearSa, `front ${fmt((frontSa * 180) / Math.PI, 1)}°, rear ${fmt((rearSa * 180) / Math.PI, 1)}° slip at the peak`);
}

console.log('\n== Driver aids through the adapter');
{
  const wide = createFlatTestTrack(30_000, 3000);
  const DTS = 1 / 120;
  // 102 bhp can't spin the fronts on a dry road past walking pace: on standing water it can
  const wet = { waterMm: 1.2, wetness: wetnessFromWater(1.2), ambientC: 15, rain: 0.8 };
  const launch = (preset: 'pro' | 'assisted') => {
    const sim = createSuzukiLianaSim(wide);
    sim.assistPreset = preset;
    sim.setWeatherSample(wet);
    sim.teleportToDistance(1000, 6);
    // Mean, not peak: the clutch snatches the fronts for a frame at each shift, before any TC can act
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 6; t += DTS) {
      sim.setWeatherSample(wet);
      sim.step(DTS, { throttle: 1 });
      if (sim.telemetry.speedKmh > 25) {
        sum += Math.max(sim.telemetry.wheelSlipRatios[0], sim.telemetry.wheelSlipRatios[1]);
        n++;
      }
    }
    return { slip: sum / n, kmh: sim.telemetry.speedKmh };
  };
  const tc = launch('assisted');
  const raw = launch('pro');
  check('TC holds front wheelspin in the wet (from 25 km/h)', tc.slip < 0.16 && tc.slip < raw.slip * 0.5 && tc.kmh >= raw.kmh,
    `mean front slip ${fmt(tc.slip, 2)} with TC, ${fmt(raw.slip, 2)} without; ${fmt(tc.kmh, 0)} / ${fmt(raw.kmh, 0)} km/h after 6 s`);
  const stop = (preset: 'pro' | 'semi_pro') => {
    const sim = createSuzukiLianaSim(wide);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 110 / 3.6);
    let lock = 0;
    const s0 = sim.sMeters;
    for (let t = 0; t < 8 && sim.telemetry.speedKmh > 20; t += DTS) {
      sim.step(DTS, { brake: 1 });
      lock = Math.max(lock, -Math.min(...sim.telemetry.wheelSlipRatios));
    }
    return { lock, dist: sim.sMeters - s0 };
  };
  const abs = stop('semi_pro');
  const locked = stop('pro');
  check('ABS keeps the wheels turning on a stamp', abs.lock < 0.4 && abs.dist < locked.dist + 2, `max lock ${fmt(abs.lock, 2)} with ABS (${fmt(abs.dist, 0)} m), ${fmt(locked.lock, 2)} without (${fmt(locked.dist, 0)} m)`);
}

console.log('\n== Autopilot round the Top Gear test track');
if (!existsSync('public/tracks/topgear/track_data.json')) {
  check('Top Gear test track is ported', false, 'public/tracks/topgear/track_data.json missing');
} else {
  setActiveTrack('topgear', JSON.parse(readFileSync('public/tracks/topgear/track_data.json', 'utf8')) as RawTrackJson);
  const track = getActiveTrackData();
  const root = loadGlbGeometry(`public${track.meshUrl ?? '/tracks/topgear/topgear.glb'}`);
  const lap = (sim: F12026CarSim) => {
    sim.resetToStartGrid(true);
    sim.aiAutopilot = true;
    sim.aiPaceScale = 1;
    const lap0 = sim.telemetry.lapCount;
    let t = 0;
    let beyond = -Infinity;
    let maxSlip = 0;
    while (t < 400 && sim.telemetry.lapCount < lap0 + 2) {
      sim.step(1 / 60, {});
      t += 1 / 60;
      beyond = Math.max(beyond, Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
      maxSlip = Math.max(maxSlip, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, sim.vxMs))) * 180) / Math.PI);
    }
    return { done: sim.telemetry.lapCount === lap0 + 2, lapS: (sim.telemetry.lastLapTimeMs ?? 0) / 1000, beyond, maxSlip, top: sim.telemetry.allTimeTopSpeedKmh };
  };
  const r = lap(createSuzukiLianaSim(track, root));
  const m = Math.floor(r.lapS / 60);
  const lapStr = `${m}:${fmt(r.lapS - 60 * m, 1).padStart(4, '0')}`;
  check('Flying lap completes and stays on the track', r.done && r.beyond <= 0 && r.maxSlip < 10,
    `lap ${lapStr}, top ${fmt(r.top, 0)} km/h, CG ${fmt(Math.max(0, r.beyond), 1)} m past the edge, max body slip ${fmt(r.maxSlip, 1)}°`);
  // The Assetto Corsa car's 100 % AI: 1:41.7–1:43.0; its author's own laps 1:46.7; the real car's board ≈ 1:42–1:50
  check('Lap 1:38–1:52 (the AC car\'s AI: 1:41.7–1:43.0)', r.lapS > 98 && r.lapS < 112, lapStr);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll Liana checks passed.');
if (failures.length) process.exitCode = 1;
