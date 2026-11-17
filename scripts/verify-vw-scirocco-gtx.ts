/**
 * Headless checks for the Volkswagen Scirocco GTX 16V (`src/lib/sim/road`): the f12026-car vehicle model on
 * Pfalzdriver's Scirocco data, driving its front wheels.
 *
 *   npx tsx scripts/verify-vw-scirocco-gtx.ts
 *
 * The rear resting on its droop stops, straight line, braking and cornering on flat ground, the front-wheel drive,
 * ABS / TC through the simulator adapter, then an autopilot lap of Dunsfold Aerodrome. The ranges are the road car's
 * (Volkswagen's figures) and the Assetto Corsa car's, not tuned to these numbers.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { setActiveTrack, getActiveTrackData, type RawTrackJson } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { compoundData } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { VW_SCIROCCO_CONFIG } from '../src/lib/sim/road/VwSciroccoConfig';
import { VW_SCIROCCO_PROFILE_CAR, createVwSciroccoSim } from '../src/lib/sim/road/VwSciroccoSim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { downshiftThenThrottle, measureDownshift, measureUpshift } from './lib/upshift-test';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { noteSkip } from './lib/hosted-files';
import { evaluateBrakePadMuFactor } from '../src/lib/sim/brake-physics';
import { buildDoubleWishboneHardpoints, solveCornerKinematics3D } from '../src/lib/sim/suspension-kinematics';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const C = VW_SCIROCCO_CONFIG;
const RADIUS = C.tyreCompounds.PhysicsTyreCompound_Road_Street.front.radius;

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

console.log('\n== Scirocco config');
{
  check('Front-wheel drive, five gears, 7500 rpm limiter', C.drivenAxle === 'front' && C.gearbox.ratios.length === 5 && C.gearbox.gears.redline_rpm === 7500, '');
  check('No hybrid or brake-by-wire', C.ers.ERS_MAX_DEPLOY === 0 && C.brakes.brakeByWire === false, '');
  const street = compoundData(C, C.compoundSlots.soft).modelData;
  const muAt3kN = (curve: readonly (readonly number[])[] | undefined) => curve?.find((p) => p[0] === 3000)?.[1] ?? NaN;
  check('Tyre grip at 3 kN is the mod\'s 1.19 both ways', muAt3kN(street.dyCurve) === 1.19 && muAt3kN(street.dxCurve) === 1.19,
    `${fmt(muAt3kN(street.dyCurve), 3)} / ${fmt(muAt3kN(street.dxCurve), 3)}`);
  check('The rear droop travel is negative (the rear rests on its stops)', C.suspensions.rear.droopTravel < -0.07 && C.suspensions.rear.droopTravel > -0.08,
    `${fmt(C.suspensions.rear.droopTravel * 1000, 1)} mm`);
  const car = makeCar();
  check('The engine drives the front wheels', car.drivenWheels[0] === 0 && car.drivenWheels[1] === 1, `wheels ${car.drivenWheels.join(', ')}`);
}

console.log('\n== Suspension geometry');
{
  const D = 180 / Math.PI;
  for (const front of [true, false]) {
    const spec = front ? C.suspensions.front : C.suspensions.rear;
    const hp = buildDoubleWishboneHardpoints(spec.hardpoints, front, spec.actuation);
    const halfTrack = 0.5 * (front ? C.chassis.trackWidthFront : C.chassis.trackWidthRear);
    const at = (z: number) => solveCornerKinematics3D(hp, z, 0, true, RADIUS);
    const gain = ((at(0.005).uprightCamberRad - at(-0.005).uprightCamberRad) / 0.01) * D;
    const rc = -at(0).contactInboardPerBump * halfTrack;
    check(`${front ? 'Front' : 'Rear'}: the hardpoints give the config's camber gain and roll centre`, Math.abs(gain - spec.camberGainKinematic) < 1 && Math.abs(rc - spec.rollCentreHeight) < 0.003,
      `${fmt(gain, 1)} °/m, roll centre ${fmt(rc * 1000, 1)} mm`);
  }
  // The rear's two arms swing on one axis: no camber or toe over its travel
  const rear = buildDoubleWishboneHardpoints(C.suspensions.rear.hardpoints, false, C.suspensions.rear.actuation);
  const r = (z: number) => solveCornerKinematics3D(rear, z, 0, true, RADIUS);
  const drift = Math.max(...[-0.05, 0.05, 0.1].map((z) => Math.max(Math.abs(r(z).uprightCamberRad), Math.abs(r(z).wheelSteerRad)) * D));
  check('Rear trailing arms: no camber or toe from −50 to +100 mm', drift < 0.05, `${fmt(drift, 3)}° at most`);
}

console.log('\n== At rest');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  run(car, 3, () => ({ throttle: 0, brake: 1, steer: 0 }));
  const travel = car.wheels.map((w) => w.compression * 1000);
  // The fronts on their springs; the rears 76 mm in, on the droop stops, as the mod's settle
  check('Fronts on their springs, rears settled 76 mm onto the droop stops', Math.abs(travel[0]) < 15 && Math.abs(travel[1]) < 15 && travel.slice(2).every((mm) => mm > 70 && mm < 80),
    `compression ${travel.map((m) => fmt(m, 1)).join(' / ')} mm`);
  const fz = car.wheels.map((w) => w.fz);
  const front = (fz[0] + fz[1]) / fz.reduce((a, b) => a + b, 0);
  // 62.5 % of the sprung mass on the front, as the mod's CG_LOCATION puts it, plus the hubs: 58.7 % of the car
  check('Front axle carries ≈ 58.7 % of the weight', Math.abs(front - 0.587) < 0.01, `${fmt(front * 100, 1)} %`);
  // Level once settled: the front wheel centres sit 0.298 m and the rears 0.290 m below the CG in the body frame
  const bodyPitchDeg = (Math.asin(new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion).y) * 180) / Math.PI;
  check('The body sits within half a degree of level', Math.abs(bodyPitchDeg) < 0.5, `${fmt(bodyPitchDeg, 2)}° nose ${bodyPitchDeg > 0 ? 'up' : 'down'}`);
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
    pedal = THREE.MathUtils.clamp(pedal + (0.12 - sr) * 0.25, 0.3, 1);
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
  // Volkswagen quotes 8.1 s and 205 km/h for the 139 PS 16V; the mod's sheet 8.0 s and 209 km/h
  check('0-100 km/h 7.4–9.0 s', t100 > 7.4 && t100 < 9.0, `${fmt(t100)} s`);
  check('Top speed 200–212 km/h', vmax > 200 && vmax < 212, `${fmt(vmax, 1)} km/h`);

  // A stamp on the pedal with the semi-pro ABS (the AI's)
  const sim = createVwSciroccoSim(createFlatTestTrack(30_000, 3000));
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 100 / 3.6);
  let peakG = 0;
  const s0 = sim.sMeters;
  for (let t = 0; t < 10 && sim.telemetry.speedKmh > 1; t += 1 / 120) {
    sim.step(1 / 120, { brake: 1 });
    peakG = Math.max(peakG, -sim.telemetry.longitudinalG);
  }
  const dist = sim.sMeters - s0;
  // A mid-80s coupé on 195 road tyres: ≈ 40–45 m
  check('ABS stop 100→0 km/h 36–48 m', dist > 36 && dist < 48, `${fmt(dist, 1)} m, peak ${fmt(peakG, 2)} g`);

  const pm = VW_SCIROCCO_PROFILE_CAR;
  let planned = 0;
  for (let v = 100 / 3.6; v > 1; v -= 0.05) {
    const grip = pm.muLong * (9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  check('Braking line plans 100→0 km/h 0–15 % longer', planned >= dist && planned < dist * 1.15, `${fmt(planned, 1)} m planned vs ${fmt(dist, 1)} m stopped`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed)');
// On its mod's tyre data (μ 1.19 at 3 kN on 195 road tyres) the Scirocco peaks at ≈ 1.07 g on the ramp and holds
// ≈ 0.93 g (measure-ggv): more than the road car's ≈ 0.8 g on its period tyres
for (const [kmh, lo, hi] of [
  [60, 0.95, 1.15],
  [110, 0.95, 1.15],
] as const) {
  const car = makeCar();
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  let frontSa = 0;
  let rearSa = 0;
  let innerRearFz = Infinity;
  run(car, 10, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 10) * 0.6 };
  }, (c) => {
    const lat = Math.abs(c.telemetry.latG);
    if (lat > maxLat) {
      maxLat = lat;
      frontSa = 0.5 * (Math.abs(c.wheels[0].slipAngleRad) + Math.abs(c.wheels[1].slipAngleRad));
      rearSa = 0.5 * (Math.abs(c.wheels[2].slipAngleRad) + Math.abs(c.wheels[3].slipAngleRad));
      innerRearFz = Math.min(c.wheels[2].fz, c.wheels[3].fz);
    }
    const beta = Math.atan2(c.velocity.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)), c.velocity.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion)));
    return Math.abs(beta) > 0.35;
  });
  check(`Peak lateral at ${kmh} km/h ${lo}–${hi} g`, maxLat > lo && maxLat < hi, `${fmt(maxLat, 2)} g`);
  check(`Understeers at the limit at ${kmh} km/h`, frontSa > rearSa, `front ${fmt((frontSa * 180) / Math.PI, 1)}°, rear ${fmt((rearSa * 180) / Math.PI, 1)}° slip at the peak`);
  // The rigid rear in roll unloads the inside rear: well under its 1.6 kN static share at the limit
  check(`The inside rear unloads at the limit at ${kmh} km/h`, innerRearFz < 700, `${fmt(innerRearFz, 0)} N on the inside rear`);
}

console.log('\n== Driver aids through the adapter');
{
  const wide = createFlatTestTrack(30_000, 3000);
  const DTS = 1 / 120;
  const wet = { waterMm: 1.2, wetness: wetnessFromWater(1.2), ambientC: 15, rain: 0.8 };
  const launch = (preset: 'pro' | 'assisted') => {
    const sim = createVwSciroccoSim(wide);
    sim.assistPreset = preset;
    sim.setWeatherSample(wet);
    sim.teleportToDistance(1000, 6);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 6; t += DTS) {
      sim.setWeatherSample(wet);
      sim.step(DTS, { throttle: 1 });
      if (sim.telemetry.speedKmh > 45) {
        sum += Math.max(sim.telemetry.wheelSlipRatios[0], sim.telemetry.wheelSlipRatios[1]);
        n++;
      }
    }
    return { slip: n ? sum / n : 0, kmh: sim.telemetry.speedKmh };
  };
  const tc = launch('assisted');
  const raw = launch('pro');
  check('TC holds front wheelspin in the wet (from 45 km/h)', tc.slip < 0.14 && tc.slip <= raw.slip && tc.kmh >= raw.kmh - 4,
    `mean front slip ${fmt(tc.slip, 2)} with TC, ${fmt(raw.slip, 2)} without; ${fmt(tc.kmh, 0)} / ${fmt(raw.kmh, 0)} km/h after 6 s`);
  const stop = (preset: 'pro' | 'semi_pro', onWet = false) => {
    const sim = createVwSciroccoSim(wide);
    sim.assistPreset = preset;
    if (onWet) sim.setWeatherSample(wet);
    sim.teleportToDistance(1000, 110 / 3.6);
    let lock = 0;
    const s0 = sim.sMeters;
    for (let t = 0; t < 8 && sim.telemetry.speedKmh > 20; t += DTS) {
      if (onWet) sim.setWeatherSample(wet);
      sim.step(DTS, { brake: 1 });
      lock = Math.max(lock, -Math.min(...sim.telemetry.wheelSlipRatios));
    }
    return { lock, dist: sim.sMeters - s0 };
  };
  const absWet = stop('semi_pro', true);
  const lockedWet = stop('pro', true);
  check('A stamp locks the wheels on standing water, not with ABS', lockedWet.lock > 0.9 && absWet.lock < 0.4 && absWet.dist < lockedWet.dist + 2,
    `max lock ${fmt(absWet.lock, 2)} with ABS (${fmt(absWet.dist, 0)} m), ${fmt(lockedWet.lock, 2)} without (${fmt(lockedWet.dist, 0)} m)`);
}

console.log('\n== Auto box through wheelspin');
{
  const LIMITER_RPM = C.gearbox.gears.redline_rpm - 100;
  const flatOut = (steer: number) => {
    const sim = createVwSciroccoSim(createFlatTestTrack(30_000, 3000));
    sim.assistPreset = 'semi_pro';
    let limiterS = 0;
    let shifts = 0;
    let gear = 1;
    let firstUpKmh = NaN;
    for (let t = 0; t < 15; t += DT) {
      sim.step(DT, { throttle: 1, analogSteer: steer });
      const tel = sim.telemetry;
      if (tel.rpm >= LIMITER_RPM) limiterS += DT;
      if (tel.gear > 0 && tel.gear !== gear) {
        if (shifts === 0) firstUpKmh = tel.speedKmh;
        shifts++;
        gear = tel.gear;
      }
    }
    return { limiterS, shifts, gear, firstUpKmh };
  };
  // 7000 rpm in first is 52 km/h on the 0.2475 m tyres, ≈ 50 km/h on their loaded radius
  const straight = flatOut(0);
  check('Straight: the first shift near the road speed of 7000 rpm', straight.firstUpKmh > 44 && straight.limiterS === 0, `1 > 2 at ${fmt(straight.firstUpKmh, 0)} km/h, ${fmt(straight.limiterS, 1)} s on the limiter`);
  for (const steer of [0.45, 0.7]) {
    const r = flatOut(steer);
    check(`Flat out on ${steer * 100} % lock: off the limiter, no hunting`, r.limiterS < 0.5 && r.shifts >= 1 && r.shifts <= 2 && r.gear >= 2,
      `${fmt(r.limiterS, 1)} s on the limiter in 15 s, ${r.shifts} shift(s), 1 > 2 at ${fmt(r.firstUpKmh, 0)} km/h, in gear ${r.gear}`);
  }
}

console.log('\n== Brakes, fuel and steering from the car\'s data');
{
  const pads = [20, 400, 1000].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
  check('Pad friction 0.90 cold, 1.00 at 400 °C, 0.70 at 1000 °C', Math.abs(pads[0] - 0.9072) < 0.005 && pads[1] === 1 && Math.abs(pads[2] - 0.7) < 0.001, pads.map((v) => fmt(v, 3)).join(' / '));
  check('Brake force 1500 Nm at 66 % front', C.brakes.maxTorqueNm === 1500 && C.brakes.front_bias === 0.66, `${fmt((2 * C.brakes.maxTorqueNm) / RADIUS / 1000, 1)} kN at the road`);

  const wide = createFlatTestTrack(30_000, 3000);
  // 0.003 l/s per 1000 rpm flat out
  // The fuel-flow model, burning (the game's sprints run on a fixed load, `SimRealismFlags.fuelUse`)
  const sim = createVwSciroccoSim(wide);
  sim.setSimRealism({ ...SIM_REALISM_FLAGS.full, fuelUse: true });
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  for (let t = 0; t < 30; t += DT) sim.step(DT, { throttle: 1 });
  const burnt = f0 - sim.telemetry.fuelKg;
  check('30 s flat out from rest burns 0.35–0.50 kg', burnt > 0.35 && burnt < 0.5, `${fmt(burnt, 3)} kg`);

  // 450° of rim lock at 900°/s
  const steer = createVwSciroccoSim(wide);
  steer.teleportToDistance(1000, 50 / 3.6);
  let tLock = NaN;
  for (let t = 0; t < 2 && Number.isNaN(tLock); t += DT / 4) {
    steer.step(DT / 4, { analogSteer: 1 });
    if (steer.steerAngleNorm >= 0.999) tLock = t + DT / 4;
  }
  check('Full lock from centre in 0.49–0.51 s (450° at 900°/s)', tLock > 0.49 && tLock < 0.51, `${fmt(tLock, 3)} s`);
}

console.log('\n== Autopilot round Dunsfold Aerodrome');
if (!existsSync('public/tracks/dunsfold/track_data.json')) {
  noteSkip('Autopilot round Dunsfold', 'public/tracks/dunsfold/track_data.json');
} else {
  setActiveTrack('dunsfold', JSON.parse(readFileSync('public/tracks/dunsfold/track_data.json', 'utf8')) as RawTrackJson);
  const track = getActiveTrackData();
  const root = loadGlbGeometry(`public${track.meshUrl ?? '/tracks/dunsfold/dunsfold.glb'}`);
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
  const r = lap(createVwSciroccoSim(track, root));
  const m = Math.floor(r.lapS / 60);
  const lapStr = `${m}:${fmt(r.lapS - 60 * m, 1).padStart(4, '0')}`;
  check('Flying lap completes and stays on the track', r.done && r.beyond <= 0 && r.maxSlip < 10,
    `lap ${lapStr}, top ${fmt(r.top, 0)} km/h, CG ${fmt(Math.max(0, r.beyond), 1)} m past the edge, max body slip ${fmt(r.maxSlip, 1)}°`);
  // 1:30.6 when first measured, 11 s under the Liana (its AC AI lapped 1:41.7–1:43.0): 35 bhp more on a lighter car,
  // and the mod's tyres hold 0.93 g to the Liana's 0.83
  check('Lap 1:27–1:35', r.lapS > 87 && r.lapS < 95, lapStr);
}

console.log('\n== Up-shift');
{
  const u = measureUpshift((t) => createVwSciroccoSim(t), 45);
  check('An up-shift on a light pedal: the dogs are out, then the driven wheels take the engine\'s excess, under 20 % of slip', u.to === u.from + 1 && u.gMin < u.gBefore && u.slipPeak < 0.2, `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
}

console.log('\n== Down-shift');
{
  const d = measureDownshift((t) => createVwSciroccoSim(t), 110, 4, 0.5);
  check('A down-shift on the brakes: the blip brings the engine up, no wheel slips past 8 % and the car is not tugged 0.25 g harder', d.to === d.from - 1 && d.slipPeak < 0.08 && d.gMin > d.gBefore - 0.25, `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
  const p = downshiftThenThrottle((t) => createVwSciroccoSim(t), 90, 4);
  check('Full throttle 0.3 s after a down-shift: the car pulls at once and the engine does not flare', p.pushG > 0.1 && p.flareRpm < 300, `${p.pushG.toFixed(2)} g a tenth of a second in, the engine at most ${p.flareRpm.toFixed(0)} rpm ahead of the wheels`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll Scirocco checks passed.');
if (failures.length) process.exitCode = 1;
