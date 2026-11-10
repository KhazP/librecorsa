/**
 * Headless checks for the Suzuki Liana 1.6 (`src/lib/sim/road`): the f12026-car vehicle model on alekabul's Liana
 * data, driving its front wheels.
 *
 *   npx tsx scripts/verify-liana.ts
 *
 * Straight line, braking and cornering on flat ground, the front-wheel drive, ABS / TC through the simulator
 * adapter, then autopilot laps of Dunsfold Aerodrome (the Top Gear test track). The ranges are the road car's (Suzuki's figures, Top Gear's
 * lap board) and the Assetto Corsa car's (its 100 % AI lapped 1:41.7–1:43.0 there), not tuned to these numbers.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as THREE from 'three';
import { setActiveTrack, getActiveTrackData, type RawTrackJson } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { compoundData } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';
import { SUZUKI_LIANA_PROFILE_CAR, createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { downshiftTakenAt, measureDownshift, measureUpshift } from './lib/upshift-test';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';
import { noteSkip } from './lib/hosted-files';
import { evaluateBrakePadMuFactor } from '../src/lib/sim/brake-physics';

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
  // The mod's tyre data: μ = DY0 + DY1 · Fz / 2000 N, so 1.2557 − 0.05 · 2 at 4 kN and 1.1967 − 0.048 · 2 along
  const street = compoundData(C, C.compoundSlots.soft).modelData;
  const muAt4kN = (curve: readonly (readonly number[])[] | undefined) => curve?.find((p) => p[0] === 4000)?.[1] ?? NaN;
  check('Tyre grip at 4 kN is the mod\'s: 1.156 across, 1.101 along', Math.abs(muAt4kN(street.dyCurve) - 1.1557) < 0.001 && Math.abs(muAt4kN(street.dxCurve) - 1.1007) < 0.001,
    `${fmt(muAt4kN(street.dyCurve), 3)} / ${fmt(muAt4kN(street.dxCurve), 3)}`);
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

  // The tank is 1.37 m behind the CG: 30 kg of fuel puts its own weight and more on the rear axle, and lifts the front
  const fuelled = makeCar();
  fuelled.setFuelMass(30);
  fuelled.refreshStaticGeometry();
  fuelled.reset(0, 0, 0);
  run(fuelled, 3, () => ({ throttle: 0, brake: 1, steer: 0 }));
  const rearGainN = fuelled.wheels[2].fz + fuelled.wheels[3].fz - fz[2] - fz[3];
  const frontGainN = fuelled.wheels[0].fz + fuelled.wheels[1].fz - fz[0] - fz[1];
  const tank = C.chassis.fuelTank;
  const expectedRear = 30 * 9.81 * (1 - C.chassis.frontWeightFraction) + (30 * 9.81 * Math.abs(tank.z)) / C.chassis.wheelbase;
  check('30 kg of fuel in the rear tank loads the rear axle with 270 N, 24 N more than its weight', Math.abs(rearGainN - expectedRear) < 6 && Math.abs(frontGainN + rearGainN - 30 * 9.81) < 3,
    `rear +${fmt(rearGainN, 0)} N, front ${fmt(frontGainN, 0)} N (expected rear +${fmt(expectedRear, 0)} N)`);
}

console.log('\n== Handbrake and tyre scrub');
{
  // The handbrake works the rear brakes only: from 60 km/h, clutch out, it locks them and the car slows on its rears
  const car = makeCar();
  car.reset(0, 0, 0, 60 / 3.6);
  run(car, 0.5, () => ({ throttle: 0, brake: 0, steer: 0, clutch: 1 }));
  const v0 = car.telemetry.speedKmh;
  run(car, 1, () => ({ throttle: 0, brake: 0, steer: 0, clutch: 1, handbrake: 1 }));
  const rearRim = Math.max(Math.abs(car.wheels[2].omega), Math.abs(car.wheels[3].omega)) * 0.288 * 3.6;
  const frontRim = Math.min(Math.abs(car.wheels[0].omega), Math.abs(car.wheels[1].omega)) * 0.288 * 3.6;
  const decelG = (v0 - car.telemetry.speedKmh) / 3.6 / 9.81;
  check('The handbrake locks the rears and leaves the fronts rolling', rearRim < 3 && frontRim > car.telemetry.speedKmh * 0.9 && decelG > 0.25 && decelG < 0.5,
    `rears ${fmt(rearRim, 1)} km/h at the rim, fronts ${fmt(frontRim, 1)} of ${fmt(car.telemetry.speedKmh, 1)} km/h, ${fmt(decelG, 2)} g`);

  // A street tyre scrubs when it works: coasting at 90 km/h, clutch out, a held corner near the limit slows the car
  // harder than the straight does by more than the slip angle's own drag
  const coast = (steer: number) => {
    const c = makeCar();
    c.reset(0, 0, 0, 90 / 3.6);
    run(c, 0.4, (_, t) => ({ throttle: 0, brake: 0, steer: steer * Math.min(1, t / 0.3), clutch: 1 }));
    let scrubNm = 0;
    let n = 0;
    run(c, 0.6, () => {
      for (const w of c.wheels) scrubNm += w.brakeTorqueNm;
      n++;
      return { throttle: 0, brake: 0, steer, clutch: 1 };
    });
    return { torque: scrubNm / n, slip: Math.max(...c.wheels.map((w) => w.combinedSlip)) };
  };
  const straight = coast(0);
  const corner = coast(-0.12);
  check('Rolling drag is 2.5–6 × the free-rolling drag in a hard corner', corner.torque > 2.5 * straight.torque && corner.torque < 6 * straight.torque && corner.slip > 0.5,
    `${fmt(straight.torque, 0)} Nm straight, ${fmt(corner.torque, 0)} Nm at ${fmt(corner.slip, 2)} of the peak slip`);
}

console.log('\n== Tyres: scrub past the peak, pressure in the heat, graining');
{
  const tyre = compoundData(C, C.compoundSlots.soft);
  const m = tyre.modelData;
  const p = tyre.pressureData;
  // In a slide past the peak slip the scrub holds at its value at the peak [spec ROLLING_RESISTANCE_SLIP]: each wheel's
  // rolling drag is at most (free rolling) × (1 + gain) with the pressure's factor, however far it slides
  {
    const car = makeCar();
    car.reset(0, 0, 0, 90 / 3.6);
    let worst = 0;
    let slid = 0;
    run(car, 2, (_, t) => {
      for (const w of car.wheels) {
        if (w.combinedSlip < 1.3 || Math.abs(w.omega) < 25 || w.fz < 500) continue;
        slid = Math.max(slid, w.combinedSlip);
        const soft = 1 + (p.pressureRollingGain ?? 0) * (p.optimalPsi / w.pressurePsi - 1);
        const free = (m.rollingResistance + (m.rollingResistanceSpeedSq ?? 0) * w.vx * w.vx) * soft;
        worst = Math.max(worst, w.brakeTorqueNm / (w.fz * w.rollingRadius * free) / (1 + (m.rollingResistanceSlipGain ?? 0) * soft));
      }
      return { throttle: 0, brake: 0, steer: -0.6 * Math.min(1, t / 0.3), clutch: 1 };
    });
    check('Sliding past the peak scrubs no more than at the peak', m.rollingResistanceSlipMax === 1 && slid > 1.5 && worst < 1.02,
      `up to ${fmt(slid, 2)} × the peak slip, drag ${fmt(worst, 3)} × its peak-slip value`);
  }
  // Pressure moves the heat: 4 psi under the set pressure runs the carcass hotter than 4 psi over
  {
    const weave = (dp: number) => {
      const car = makeCar();
      car.reset(0, 0, 0, 90 / 3.6);
      for (const w of car.wheels) w.coldPressurePsi += dp;
      run(car, 60, (_, t) => ({ throttle: 0.3, brake: 0, steer: 0.04 * Math.sin(t * 0.8) }));
      return car.wheels[0].coreTempC;
    };
    const low = weave(-4);
    const high = weave(4);
    check('An under-inflated tyre runs hotter', tyre.thermalData.pressureHeat !== undefined && low - high > 0.4, `carcass ${fmt(low, 2)} °C at −4 psi, ${fmt(high, 2)} °C at +4`);
  }
  // Graining wears off as the tread slides: a grained, warm tyre on a straight keeps it
  {
    const car = makeCar();
    car.reset(0, 0, 0, 90 / 3.6);
    for (const w of car.wheels) {
      w.grainLevel = 0.3;
      w.bandTempsC.fill(80);
      w.bandCoreTempsC.fill(80);
    }
    run(car, 60, () => ({ throttle: 0.2, brake: 0, steer: 0 }));
    const lost = 0.3 - Math.min(...car.wheels.map((w) => w.grainLevel));
    check('A grained tyre keeps its graining over a minute of straight', tyre.thermalData.tread?.wearOffWithSlip === true && lost < 1e-4, `${fmt(lost * 1e4, 2)}e-4 lost`);
  }
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
// On its mod's tyre data the Liana peaks at ≈ 0.95 g at town speeds and ≈ 0.88 g at 110 km/h (the sliding speed costs
// grip), and holds ≈ 0.83 g
for (const [kmh, lo, hi] of [
  [60, 0.88, 1.0],
  [110, 0.82, 0.94],
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
  // The mod's street tyre holds its grip past the peak, so its TC (12 % slip) trims the wheelspin rather than rescuing
  // the launch: under its target, well under the untamed slip, and no more than a few km/h for it
  // A spinning street tyre scrubs its own speed off, so the untamed wheelspin is modest too
  check('TC holds front wheelspin in the wet (from 25 km/h)', tc.slip < 0.12 && tc.slip < raw.slip * 0.9 && tc.kmh >= raw.kmh - 4,
    `mean front slip ${fmt(tc.slip, 2)} with TC, ${fmt(raw.slip, 2)} without; ${fmt(tc.kmh, 0)} / ${fmt(raw.kmh, 0)} km/h after 6 s`);
  const stop = (preset: 'pro' | 'semi_pro', onWet = false) => {
    const sim = createSuzukiLianaSim(wide);
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
  const abs = stop('semi_pro');
  const locked = stop('pro');
  // On a dry road its 1600 Nm brakes cannot lock the tyres; on standing water they do, and the ABS keeps them turning
  const absWet = stop('semi_pro', true);
  const lockedWet = stop('pro', true);
  check('A stamp locks the wheels on standing water, not with ABS', lockedWet.lock > 0.9 && absWet.lock < 0.4 && absWet.dist < lockedWet.dist + 2,
    `max lock ${fmt(absWet.lock, 2)} with ABS (${fmt(absWet.dist, 0)} m), ${fmt(lockedWet.lock, 2)} without (${fmt(lockedWet.dist, 0)} m)`);
  check('Dry stamp: the ABS holds its slip and costs under a tenth of the stop', abs.lock < 0.2 && abs.dist < locked.dist * 1.1, `max lock ${fmt(abs.lock, 2)} with ABS (${fmt(abs.dist, 0)} m), ${fmt(locked.lock, 2)} without (${fmt(locked.dist, 0)} m)`);
}

console.log('\n== Brakes, fuel and steering from the car\'s data');
{
  // The data gives the pads no temperature curve: full friction cold and hot (the steel material's was 0.80 at 20 °C)
  const pads = [20, 380, 900].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
  check('Pad friction 1.00 at 20, 380 and 900 °C', pads.every((v) => v === 1), pads.map((v) => fmt(v)).join(' / '));

  const wide = createFlatTestTrack(30_000, 3000);
  // Fuel flow follows the engine's speed: a constant 0.006 kg/s flat out burnt 0.187 kg here
  const sim = createSuzukiLianaSim(wide);
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  for (let t = 0; t < 30; t += DT) sim.step(DT, { throttle: 1 });
  const burnt = f0 - sim.telemetry.fuelKg;
  check('30 s flat out from rest burns 0.16–0.185 kg', burnt > 0.16 && burnt < 0.185, `${fmt(burnt, 3)} kg`);

  // A mouse or pad turns the rack no faster than hands turn the 540° of rim lock on its 15:1 rack (900°/s)
  const steer = createSuzukiLianaSim(wide);
  steer.teleportToDistance(1000, 50 / 3.6);
  let tLock = NaN;
  for (let t = 0; t < 2 && Number.isNaN(tLock); t += DT / 4) {
    steer.step(DT / 4, { analogSteer: 1 });
    if (steer.steerAngleNorm >= 0.999) tLock = t + DT / 4;
  }
  check('Full lock from centre in 0.59–0.61 s (540° at 900°/s)', tLock > 0.59 && tLock < 0.61, `${fmt(tLock, 3)} s`);
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
  const r = lap(createSuzukiLianaSim(track, root));
  const m = Math.floor(r.lapS / 60);
  const lapStr = `${m}:${fmt(r.lapS - 60 * m, 1).padStart(4, '0')}`;
  check('Flying lap completes and stays on the track', r.done && r.beyond <= 0 && r.maxSlip < 10,
    `lap ${lapStr}, top ${fmt(r.top, 0)} km/h, CG ${fmt(Math.max(0, r.beyond), 1)} m past the edge, max body slip ${fmt(r.maxSlip, 1)}°`);
  // The Assetto Corsa car's 100 % AI: 1:41.7–1:43.0; its author's own laps 1:46.7; the real car's board ≈ 1:42–1:50
  check('Lap 1:38–1:52 (the AC car\'s AI: 1:41.7–1:43.0)', r.lapS > 98 && r.lapS < 112, lapStr);
}

console.log('\n== Up-shift');
{
  // A manual box: the lever is between gears for a quarter of a second, the engine slowing meanwhile (22 % with the gear changed in no time)
  const u = measureUpshift((t) => createSuzukiLianaSim(t), 45);
  check('An up-shift on a light pedal: the dogs are out, then the driven wheels take the engine\'s excess, under 20 % of slip', u.to === u.from + 1 && u.gMin < u.gBefore && u.slipPeak < 0.2, `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
}

console.log('\n== Down-shift');
{
  // The driver's heel and toe in the quarter second between gears, then the clutch let out slowly
  const d = measureDownshift((t) => createSuzukiLianaSim(t), 110, 4, 0.5);
  check('A down-shift on the brakes: the blip brings the engine up, no wheel slips past 8 % and the car is not tugged 0.25 g harder', d.to === d.from - 1 && d.slipPeak < 0.08 && d.gMin > d.gBefore - 0.25, `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll Liana checks passed.');
if (failures.length) process.exitCode = 1;
