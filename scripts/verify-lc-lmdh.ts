/**
 * Headless checks for the LC-LMDH (`src/lib/sim/proto/LcLmdh*`): the f12026-car vehicle model on the LMDh technical
 * regulations' published limits, with estimates where a car's data is not public.
 *
 *   npx tsx scripts/verify-lc-lmdh.ts
 *
 * What the regulations fix (dimensions, the power curve, the gearbox's rules), the car at rest and at its top speed on
 * the engine's 500 Hz tick, the aero against speed, straight line and braking, the regulated power at the driveshafts,
 * the hybrid's energy bookkeeping, the gearbox and its limiter, cornering, the driver aids, the telemetry the sound
 * plays from, the registry's preview entry, autopilot laps of RISE Motordrome and the body's GLB against the chassis.
 * The ranges are what the car's own data should give (power against drag and mass, grip against load) and the class's
 * published speed-trap figures, not lap times of a real car: none of the circuits with a published benchmark lap is in
 * the track registry.
 */
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getActiveTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import type { CarPhysicsConfig, PerformanceModeName } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { LC_LMDH_CONFIG, LC_LMDH_HARDPOINTS, LC_LMDH_LONG_CONFIG, LC_LMDH_POWER } from '../src/lib/sim/proto/LcLmdhConfig';
import { LC_LMDH_LONG_SIM_PROFILE, LC_LMDH_PROFILE_CAR, LC_LMDH_SIM_PROFILE, LC_LMDH_SOUND, createLcLmdhSim } from '../src/lib/sim/proto/LcLmdhSim';
import { createMtr496rSim } from '../src/lib/sim/proto/Mtr496rSim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { CARS, carById, carForVehicle, resolveCarId } from '../src/lib/cars/car-registry';
import { HOSTED_CONTENT } from '../src/lib/hosted-content';
import { portedCarRoot } from '../src/lib/ported-car-model';
import { buildDoubleWishboneHardpoints, solveCornerKinematics3D } from '../src/lib/sim/suspension-kinematics';
import { Lut } from '../src/lib/sim/lut';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { downshiftTakenAt, measureDownshift, measureUpshift } from './lib/upshift-test';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
/** The engine's own tick: 500 Hz, four sub-steps each */
const TICK = VehiclePhysics.FIXED_DT;
const flat = new FlatGroundQuery(0);
const C = LC_LMDH_CONFIG;
const RHO = 1.225;

const makeCar = (cfg: CarPhysicsConfig = C) => new VehiclePhysics({ ground: flat, config: cfg, airDensity: RHO });

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, stop?: (car: VehiclePhysics, t: number) => boolean, dt = DT): number {
  let t = 0;
  while (t < seconds) {
    car.step(dt, drive(car, t));
    t += dt;
    if (stop?.(car, t)) break;
  }
  return t;
}

/** Power at the driven shafts now (W): each rear wheel's drive torque × its speed */
const shaftPowerW = (car: VehiclePhysics) => car.wheels[2].driveTorqueNm * car.wheels[2].omega + car.wheels[3].driveTorqueNm * car.wheels[3].omega;
const capCurve = new Lut(C.engine.outputPowerCap.curve);
const capShare = new Lut(C.engine.outputPowerCap.vsSpeedKmh);
/** The regulated limit at the shafts at this engine and road speed (W) */
const capW = (rpm: number, kmh: number) => capCurve.evaluate(rpm) * capShare.evaluate(kmh) * 1000;

console.log('\n== What the regulations fix');
{
  const g = C.gearbox;
  const ch = C.chassis;
  check('Rear-wheel drive, seven gears (Art. 9.6.1)', !('drivenAxle' in C) && g.ratios.length === 7 && LC_LMDH_LONG_CONFIG.gearbox.ratios.length === 7, '');
  check('Wheelbase 3148 mm (Art. 3.1.5)', ch.wheelbase === 3.148, `${ch.wheelbase} m`);
  // The car without its 80 kg driver; the regulations' floor is 1030 kg with up to 70 kg of ballast on it
  const dry = ch.totalMassKg - 80;
  check('Dry mass 1030–1100 kg (Art. 4.1, 4.3)', dry >= 1030 && dry <= 1100, `${dry} kg`);
  const soft = C.tyreCompounds[C.compoundSlots.soft];
  // 29/71-18 and 34/71-18 (Art. 12.3.3): 29 and 34 cm sections, 71 cm tall, as the body's own tyres measure
  const H = LC_LMDH_HARDPOINTS;
  check('Tyres are the body\'s: ≈ 0.29 / 0.34 m wide, ≈ 0.355 m in radius', soft.front.width === H.tyreWidthFront && soft.rear.width === H.tyreWidthRear && soft.front.radius === H.wheelRadiusFront && soft.rear.radius === H.wheelRadiusRear &&
    Math.abs(H.tyreWidthFront - 0.29) < 0.02 && Math.abs(H.tyreWidthRear - 0.34) < 0.02 && Math.abs(H.wheelRadiusFront - 0.355) < 0.006 && Math.abs(H.wheelRadiusRear - 0.355) < 0.006,
    `${H.tyreWidthFront} / ${H.tyreWidthRear} m wide, ${H.wheelRadiusFront} / ${H.wheelRadiusRear} m in radius`);
  // The body's model is 28 mm over the 2000 mm limit (Art. 3.1.2), and its wheels with it
  const widest = Math.max(ch.trackWidthFront + H.tyreWidthFront, ch.trackWidthRear + H.tyreWidthRear);
  check('Tracks are the body\'s, its tyres inside its 2028 mm', widest <= 2.028 && ch.trackWidthFront === H.trackWidthFront && ch.trackWidthRear === H.trackWidthRear,
    `${fmt(ch.trackWidthFront, 3)} / ${fmt(ch.trackWidthRear, 3)} m, ${fmt(widest, 3)} m over the tyres`);
  check('Limiter under the 10 000 rpm the regulations allow (Art. 5.2.1)', g.gears.redline_rpm <= 10_000 && g.gears.redline_rpm === Math.round(1.025 * LC_LMDH_POWER.nMax), `${g.gears.redline_rpm} rpm`);
  // The curve's 500 kW line scaled to the car's 507 kW: its peak at 0.95 Nmax, under the curve's upper, 520 kW line
  const peak = capW(0.95 * LC_LMDH_POWER.nMax, 100) / 1000;
  const peakIsAt95 = LC_LMDH_POWER.curve500Kw.every(([n]) => capW(n * LC_LMDH_POWER.nMax, 100) <= capW(0.95 * LC_LMDH_POWER.nMax, 100));
  check('Power limit: 507 kW at 0.95 Nmax, 506 kW from 240 km/h (Art. 5.1.2)', Math.abs(peak - 507) < 0.6 && peakIsAt95 && peak <= 520 && Math.abs(capW(7750, 300) / 1000 - 506) < 0.6,
    `${fmt(peak, 1)} kW to 230 km/h, ${fmt(capW(0.95 * LC_LMDH_POWER.nMax, 300) / 1000, 1)} kW from 240, ${fmt(capW(LC_LMDH_POWER.nMax, 100) / 1000, 1)} kW at Nmax`);
  // The same limit as a torque at engine speed (Nm), from the regulations' table × 507 / 500
  const anchors: [number, number][] = [[4487, 531], [5099, 587], [5711, 631], [6118, 654], [6730, 668], [7138, 658], [7750, 625], [8158, 587.5], [8362, 494.5]];
  const worstNm = Math.max(...anchors.map(([rpm, nm]) => Math.abs(capW(rpm, 100) / ((rpm * Math.PI) / 30) / nm - 1)));
  check('The limit as torque: 531 Nm at 4487 rpm, 668 at 6730, 494.5 at 8362', worstNm < 0.004, `within ${fmt(worstNm * 100, 2)} % at nine engine speeds`);
  check('Under 0.55 Nmax the limit stays at its first point', capW(2000, 100) === capW(0.55 * LC_LMDH_POWER.nMax, 100), `${fmt(capW(2000, 100) / 1000, 1)} kW`);
  // Art. 9.6.2: one set must reach 340 km/h without passing Nmax, on a 349 mm tyre radius
  const kmhAtNmax = (cfg: CarPhysicsConfig) => (((LC_LMDH_POWER.nMax * Math.PI) / 30 / (cfg.gearbox.ratios[6] * cfg.gearbox.finalDrive)) * 0.349 * 3.6);
  check('The long gear set reaches 340 km/h at Nmax (Art. 9.6.2)', kmhAtNmax(LC_LMDH_LONG_CONFIG) >= 340 && kmhAtNmax(C) < 340,
    `long ${fmt(kmhAtNmax(LC_LMDH_LONG_CONFIG), 1)} km/h, sprint ${fmt(kmhAtNmax(C), 1)} km/h`);
  check('An up-shift cuts the engine for at least 30 ms (Art. 9.8.2)', (g.upshiftCutS ?? 0) >= 0.03, `${fmt((g.upshiftCutS ?? 0) * 1000, 0)} ms`);
  check('Hybrid on the driveline, brake-by-wire rear brakes (Art. 5.3)', C.ers.ERS_MAX_DEPLOY === 50_000 && C.ers.maxHarvestW === 200_000 && C.brakes.brakeByWire === true, '');
  check('No ABS on the car: pro runs none (Art. 11.5.1)', LC_LMDH_SIM_PROFILE.assistDials.pro.absLevel === 0 && LC_LMDH_SIM_PROFILE.assistDials.pro.tcLevel > 0, '');
  const car = makeCar();
  check('The engine drives the rear wheels', car.drivenWheels[0] === 2 && car.drivenWheels[1] === 3, `wheels ${car.drivenWheels.join(', ')}`);
}

console.log('\n== Suspension geometry');
{
  const D = 180 / Math.PI;
  for (const front of [true, false]) {
    const spec = front ? C.suspensions.front : C.suspensions.rear;
    const hp = buildDoubleWishboneHardpoints(spec.hardpoints, front, spec.actuation);
    const halfTrack = 0.5 * (front ? C.chassis.trackWidthFront : C.chassis.trackWidthRear);
    const at = (z: number) => solveCornerKinematics3D(hp, z, 0, true, front ? LC_LMDH_HARDPOINTS.wheelRadiusFront : LC_LMDH_HARDPOINTS.wheelRadiusRear);
    const gain = ((at(0.005).uprightCamberRad - at(-0.005).uprightCamberRad) / 0.01) * D;
    const rc = -at(0).contactInboardPerBump * halfTrack;
    check(`${front ? 'Front' : 'Rear'}: the hardpoints give the config's camber gain and roll centre`, Math.abs(gain - spec.camberGainKinematic) < 1 && Math.abs(rc - spec.rollCentreHeight) < 0.003,
      `${fmt(gain, 1)} °/m, roll centre ${fmt(rc * 1000, 1)} mm`);
  }
  // Heave rate a wheel: its corner spring plus half the axle's third spring; ride frequency on the sprung mass
  const sprung = C.chassis.totalMassKg - 2 * C.chassis.unsprungMassFront - 2 * C.chassis.unsprungMassRear;
  const hz = (axle: 'front' | 'rear', share: number) => Math.sqrt((2 * (C.suspensions[axle].springs.wheel_rate + 0.5 * C.suspensions[axle].heave.rate)) / (sprung * share)) / (2 * Math.PI);
  const f = hz('front', C.chassis.frontWeightFraction);
  const r = hz('rear', 1 - C.chassis.frontWeightFraction);
  check('Ride frequencies 4.5–6 Hz on the springs, the front the stiffer', f > r && r > 4.5 && f < 6, `${fmt(f, 1)} / ${fmt(r, 1)} Hz`);
}

console.log('\n== At rest (500 Hz tick)');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  run(car, 4, () => ({ throttle: 0, brake: 1, steer: 0 }));
  const t = car.telemetry;
  const fz = car.wheels.map((w) => w.fz);
  const front = (fz[0] + fz[1]) / fz.reduce((a, b) => a + b, 0);
  check('Front axle carries 46 % of the weight', Math.abs(front - C.chassis.frontWeightFraction) < 0.01, `${fmt(front * 100, 1)} %`);
  check('Rides at 48 / 68 mm', Math.abs(t.aeroHeightFront - 0.048) < 0.003 && Math.abs(t.aeroHeightRear - 0.068) < 0.003,
    `${fmt(t.aeroHeightFront * 1000, 1)} / ${fmt(t.aeroHeightRear * 1000, 1)} mm`);
  // Two seconds of single ticks: nothing may move
  let rhLo = Infinity;
  let rhHi = -Infinity;
  let maxHub = 0;
  let maxVy = 0;
  let maxSpeed = 0;
  let maxSpin = 0;
  run(car, 2, () => ({ throttle: 0, brake: 1, steer: 0 }), (c) => {
    rhLo = Math.min(rhLo, c.telemetry.aeroHeightFront);
    rhHi = Math.max(rhHi, c.telemetry.aeroHeightFront);
    maxHub = Math.max(maxHub, ...c.wheels.map((w) => Math.abs(w.compressionVel)));
    maxVy = Math.max(maxVy, Math.abs(c.velocity.y));
    maxSpeed = Math.max(maxSpeed, Math.hypot(c.velocity.x, c.velocity.z));
    maxSpin = Math.max(maxSpin, c.angularVelocity.length());
    return false;
  }, TICK);
  check('No jitter at rest: body and hubs under 0.1 mm/s', maxVy < 1e-4 && maxHub < 1e-4 && rhHi - rhLo < 1e-5 && maxSpin < 1e-4,
    `body ${fmt(maxVy * 1e6, 1)} µm/s, hubs ${fmt(maxHub * 1e6, 1)} µm/s, ride height ±${fmt(((rhHi - rhLo) / 2) * 1e6, 2)} µm, ${fmt(maxSpin * 1e6, 1)} µrad/s`);
  check('Stands still on the brake', maxSpeed < 1e-3, `${fmt(maxSpeed * 1000, 3)} mm/s`);
}

console.log('\n== Aero against speed (flat, held speed)');
{
  const at = (kmh: number, cfg: CarPhysicsConfig = C) => {
    const car = makeCar(cfg);
    car.reset(0, 0, 0, kmh / 3.6);
    let pedal = 0.5;
    run(car, 8, (c) => {
      pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.01 : -0.01), 0, 1);
      return { throttle: pedal, brake: 0, steer: 0 };
    });
    const t = car.telemetry;
    const q = 0.5 * RHO * (t.speedKmh / 3.6) ** 2;
    return { clA: t.downforceN / q, cdA: t.dragN / q, bal: t.AERO_BALANCE, front: t.aeroHeightFront, rear: t.aeroHeightRear, downN: t.downforceN };
  };
  const slow = at(100);
  const mid = at(250);
  const fast = at(300);
  // The floor and the splitter gain as the car settles: ≈ 3.6 m² near its static ride height, ≈ 4.1 m² at 300 km/h
  check('CL·A 3.5–4.2 m² from 100 to 300 km/h, growing as it settles', slow.clA > 3.5 && fast.clA < 4.2 && slow.clA < mid.clA && mid.clA < fast.clA,
    `${fmt(slow.clA)} / ${fmt(mid.clA)} / ${fmt(fast.clA)} m² at 100 / 250 / 300 km/h`);
  check('CD·A 0.97–1.01 m²', [slow, mid, fast].every((s) => s.cdA > 0.97 && s.cdA < 1.01), `${fmt(slow.cdA, 3)} / ${fmt(mid.cdA, 3)} / ${fmt(fast.cdA, 3)} m²`);
  check('Downforce over drag 4 : 1 at 250 km/h, on 30 / 44 mm', Math.abs(mid.clA / mid.cdA - 4) < 0.1 && Math.abs(mid.front - 0.03) < 0.003 && Math.abs(mid.rear - 0.043) < 0.004,
    `${fmt(mid.clA / mid.cdA, 2)} : 1 at ${fmt(mid.front * 1000, 1)} / ${fmt(mid.rear * 1000, 1)} mm`);
  // Under the 54 % of the weight on the rear axle, so the car gains understeer with speed
  check('Aero balance 44–48 % front', [slow, mid, fast].every((s) => s.bal > 44 && s.bal < 48), `${fmt(slow.bal, 1)} / ${fmt(mid.bal, 1)} / ${fmt(fast.bal, 1)} %`);
  check('Floor clear of the ground at 300 km/h', Math.min(fast.front, fast.rear) > 0.015, `${fmt(fast.front * 1000, 1)} / ${fmt(fast.rear * 1000, 1)} mm, ${fmt(fast.downN / 1000, 1)} kN of downforce`);
  // The long-circuit trim's 1° wing: 4.5° less, 0.065 m² of CL·A and 0.022 m² of CD·A a degree
  const low = at(250, LC_LMDH_LONG_CONFIG);
  check('The 1° wing sheds ≈ 0.10 m² of CD·A and ≈ 0.3 m² of CL·A', Math.abs(mid.cdA - low.cdA - 0.099) < 0.015 && mid.clA - low.clA > 0.2 && mid.clA - low.clA < 0.45,
    `CD·A ${fmt(low.cdA, 3)} m², CL·A ${fmt(low.clA)} m², balance ${fmt(low.bal, 1)} % front`);
}

const pad = createFlatTestTrack(40_000, 3000);

console.log('\n== Under the most aero load (500 Hz tick)');
{
  // Standing on the brake in a 322 km/h headwind: the downforce of its top speed with no road passing under the tyres
  // (the engine adds a road texture under a moving car), so anything that still moves is the solver's own
  const parked = makeCar();
  parked.reset(0, 0, 0);
  parked.windWorld.set(0, 0, -322 / 3.6).applyQuaternion(parked.quaternion);
  run(parked, 6, () => ({ throttle: 0, brake: 1, steer: 0 }));
  let lo = Infinity;
  let hi = -Infinity;
  let maxHub = 0;
  let maxVy = 0;
  run(parked, 2, () => ({ throttle: 0, brake: 1, steer: 0 }), (c) => {
    lo = Math.min(lo, c.telemetry.aeroHeightFront);
    hi = Math.max(hi, c.telemetry.aeroHeightFront);
    maxHub = Math.max(maxHub, ...c.wheels.map((w) => Math.abs(w.compressionVel)));
    maxVy = Math.max(maxVy, Math.abs(c.velocity.y));
    return false;
  }, TICK);
  check('No jitter under ≈ 19 kN of downforce', parked.telemetry.downforceN > 17_000 && maxVy < 1e-4 && maxHub < 1e-4 && hi - lo < 1e-5,
    `${fmt(parked.telemetry.downforceN / 1000, 1)} kN at ${fmt(parked.telemetry.aeroHeightFront * 1000, 1)} / ${fmt(parked.telemetry.aeroHeightRear * 1000, 1)} mm: body ${fmt(maxVy * 1e6, 1)} µm/s, hubs ${fmt(maxHub * 1e6, 1)} µm/s, ride height ±${fmt(((hi - lo) / 2) * 1e6, 2)} µm`);

  // At its top speed over the road's texture (≈ 0.5 mm rms): the floor moves a fraction of that and stays off its stops
  const car = makeCar();
  car.reset(0, 0, 0, 318 / 3.6);
  run(car, 12, () => ({ throttle: 1, brake: 0, steer: 0 }));
  let rideLo = Infinity;
  let rideHi = -Infinity;
  let sumA = 0;
  let n = 0;
  let prevVy = car.velocity.y;
  let frontTravel = 0;
  let rearTravel = 0;
  run(car, 3, () => ({ throttle: 1, brake: 0, steer: 0 }), (c) => {
    rideLo = Math.min(rideLo, c.telemetry.aeroHeightFront);
    rideHi = Math.max(rideHi, c.telemetry.aeroHeightFront);
    const a = (c.velocity.y - prevVy) / TICK;
    prevVy = c.velocity.y;
    sumA += a * a;
    n++;
    frontTravel = Math.max(frontTravel, c.wheels[0].compression, c.wheels[1].compression);
    rearTravel = Math.max(rearTravel, c.wheels[2].compression, c.wheels[3].compression);
    return false;
  }, TICK);
  const rmsG = Math.sqrt(sumA / n) / 9.81;
  check('At top speed the floor rides the road\'s texture within ±0.25 mm', rideHi - rideLo < 5e-4 && rmsG < 0.03 && rideLo > 0.012,
    `${fmt(car.telemetry.speedKmh, 1)} km/h: front ride height ${fmt(rideLo * 1000, 2)}–${fmt(rideHi * 1000, 2)} mm, body ${fmt(rmsG * 1000, 1)} mg rms`);
  check('Short of the heave packers there', frontTravel < C.suspensions.front.heave.packerGap && rearTravel < C.suspensions.rear.heave.packerGap,
    `travel ${fmt(frontTravel * 1000, 1)} of ${C.suspensions.front.heave.packerGap * 1000} mm front, ${fmt(rearTravel * 1000, 1)} of ${C.suspensions.rear.heave.packerGap * 1000} mm rear`);
}

console.log('\n== Straight line through the adapter (its own TC)');
{
  const sprint = (profile = LC_LMDH_SIM_PROFILE) => {
    const sim = createLcLmdhSim(pad, null, profile);
    sim.assistPreset = 'semi_pro';
    sim.teleportToDistance(1000, 0);
    const at: Record<number, number> = {};
    let vmax = 0;
    for (let t = 0; t < 75; t += DT) {
      sim.step(DT, { throttle: 1 });
      const v = sim.telemetry.speedKmh;
      vmax = Math.max(vmax, v);
      for (const mark of [100, 200, 300]) if (at[mark] === undefined && v >= mark) at[mark] = t;
    }
    return { at, vmax, rpm: sim.telemetry.rpm, gear: sim.telemetry.gear };
  };
  const s = sprint();
  // Traction-limited to ≈ 130 km/h (1.0 g at 54 km/h), then 507 kW on 1180 kg with fuel
  check('0-100 km/h 2.8–3.6 s', s.at[100] > 2.8 && s.at[100] < 3.6, `${fmt(s.at[100])} s`);
  check('0-200 km/h 6.2–7.6 s', s.at[200] > 6.2 && s.at[200] < 7.6, `${fmt(s.at[200])} s`);
  check('0-300 km/h 15–20 s', s.at[300] > 15 && s.at[300] < 20, `${fmt(s.at[300])} s`);
  // 506 kW against CD·A 0.99 m² and the tyres' rolling loss under ≈ 17 kN of downforce: seventh runs out past Nmax,
  // where the regulated power falls away
  check('Sprint set, 5.5° wing: seventh runs out at 314–322 km/h', s.vmax > 314 && s.vmax < 322 && s.gear === 7 && s.rpm > LC_LMDH_POWER.nMax && s.rpm < C.gearbox.gears.redline_rpm,
    `${fmt(s.vmax, 1)} km/h at ${fmt(s.rpm, 0)} rpm`);
  // The class's cars were timed at 322.7–326.7 km/h through the speed trap of a banked oval's road course in
  // qualifying, on the long gear set and little wing. A trap is short of the car's terminal speed, and the long set's
  // rule puts 340 km/h at Nmax: the car must reach the trap's speeds and stay under the rule's
  const l = sprint(LC_LMDH_LONG_SIM_PROFILE);
  check('Long set, 1° wing: terminal speed over the 326.7 km/h trap, under 340', l.vmax > 326.7 && l.vmax < 340 && l.rpm <= LC_LMDH_POWER.nMax, `${fmt(l.vmax, 1)} km/h at ${fmt(l.rpm, 0)} rpm`);
  const wing = (cfg: CarPhysicsConfig, deg: number): CarPhysicsConfig => ({ ...cfg, aero: { ...cfg.aero, wings: cfg.aero.wings.map((w) => (w.name === 'REAR_WING' ? { ...w, angleDeg: deg } : w)) } });
  /** Flat out from a corner's exit speed: the speed at each distance (km/h), and where it ends */
  const pullFrom = (cfg: CarPhysicsConfig, kmh: number, marks: number[]) => {
    const car = makeCar(cfg);
    car.reset(0, 0, 0, kmh / 3.6);
    const at: number[] = [];
    let dist = 0;
    run(car, 70, () => ({ throttle: 1, brake: 0, steer: 0 }), (c) => {
      dist += (c.telemetry.speedKmh / 3.6) * DT;
      if (at.length < marks.length && dist >= marks[at.length]) at.push(c.telemetry.speedKmh);
      return false;
    });
    return { at, terminal: car.telemetry.speedKmh };
  };
  const longMid = pullFrom(wing(LC_LMDH_LONG_CONFIG, 5.5), 130, [1500]);
  // The same gears on the sprint trim's wing: slower than on the 1° wing, faster than the sprint set's seventh allows
  check('Long set on the 5.5° wing: between the sprint set\'s top speed and the 1° wing\'s', longMid.terminal > s.vmax && longMid.terminal < l.vmax, `${fmt(longMid.terminal, 1)} km/h (trap 322.7–326.7)`);
  // Where the traps stand is not in the timing files: 1.5 km of full throttle from a 130 km/h corner [est]
  const longRun = pullFrom(LC_LMDH_LONG_CONFIG, 130, [1500]);
  check('Long set, 1° wing: 318–332 km/h after 1.5 km from 130 km/h', longRun.at[0] > 318 && longRun.at[0] < 332, `${fmt(longRun.at[0], 1)} km/h (trap 322.7–326.7)`);
  // The sprint circuit's trap, at the end of a straight of about a kilometre: 288–291 km/h, on more wing than 5.5°.
  // From a 100 km/h corner [est] the car passes that between 800 m and 1 km
  const sprintRun = pullFrom(wing(C, 9), 100, [800, 1000]);
  check('Sprint set, 9° wing: 284–304 km/h between 800 m and 1 km from 100 km/h', sprintRun.at[0] > 284 && sprintRun.at[1] < 304, `${fmt(sprintRun.at[0], 1)} km/h at 800 m, ${fmt(sprintRun.at[1], 1)} at 1 km (trap 288–291)`);
}

console.log('\n== The regulated power at the driveshafts');
{
  // Flat out from 60 km/h through the gears, in each hybrid mode, as means over 0.2 s (the regulations' own averaging
  // window for the shafts' torque, Art. 5.4.1). The limit is on what the engine and the motor send to the shafts: the
  // shafts' power plus what the engine's own flywheel takes up or gives back as it changes speed. The flywheel's share
  // is not limited here: after an up-shift and as wheelspin ends, the slowing engine hands its energy to the shafts
  // (≈ 17 kJ a change) on top of the limit, which a real car's controller would trim against its torque sensors
  const pull = (mode: PerformanceModeName, soc: number) => {
    const car = makeCar();
    car.reset(0, 0, 0, 60 / 3.6);
    car.setPerformanceMode(mode);
    car.ersEnergyJ = soc * C.ers.ERS_MAX_CHARGE;
    const N = Math.round(0.2 / TICK);
    const sent: number[] = [];
    const limits: number[] = [];
    let sumSent = 0;
    let sumLimit = 0;
    let worst = 0;
    let overJ = 0;
    let changes = 0;
    let gear = car.gear;
    let peakW = 0;
    let peakRpm = 0;
    let deployedJ = 0;
    let t250 = NaN;
    let omega = (car.rpm * Math.PI) / 30;
    const e0 = car.ersEnergyJ;
    run(car, 40, () => ({ throttle: 1, brake: 0, steer: 0 }), (c, t) => {
      const now = (c.rpm * Math.PI) / 30;
      const flywheelW = (C.gearbox.efficiency * 0.5 * C.engine.inertia * (now * now - omega * omega)) / TICK;
      omega = now;
      const p = shaftPowerW(c);
      const limit = capW(c.rpm, c.telemetry.speedKmh);
      sent.push(p + flywheelW);
      limits.push(limit);
      sumSent += p + flywheelW;
      overJ += Math.max(0, p - limit) * TICK;
      if (c.gear > gear) changes++;
      gear = c.gear;
      sumLimit += limit;
      if (sent.length > N) {
        sumSent -= sent.shift()!;
        sumLimit -= limits.shift()!;
      }
      deployedJ += Math.max(0, c.telemetry.MGUK_POWER) * TICK;
      if (sent.length === N) {
        worst = Math.max(worst, sumSent / sumLimit);
        if (sumSent / N > peakW) {
          peakW = sumSent / N;
          peakRpm = c.rpm;
        }
      }
      if (Number.isNaN(t250) && c.telemetry.speedKmh >= 250) t250 = t;
      return false;
    }, TICK);
    return { worst, overJ, changes, peakW, peakRpm, deployedJ, usedJ: e0 - car.ersEnergyJ, t250 };
  };
  const qual = pull('PSH', 1);
  const none = pull('CHR', 1);
  check('Engine and motor never send more than the limit, deploying or not', qual.worst <= 1.005 && none.worst <= 1.005, `at most ${fmt(qual.worst * 100, 1)} % of it deploying, ${fmt(none.worst * 100, 1)} % without`);
  check('The car reaches the limit: 507 kW to the shafts', qual.peakW > 500_000 && qual.peakW < 508_500 && none.peakW > 500_000 && none.peakW < 508_500,
    `${fmt(qual.peakW / 1000, 1)} kW at ${fmt(qual.peakRpm, 0)} rpm deploying, ${fmt(none.peakW / 1000, 1)} kW without`);
  // Not modelled: trimming the engine against the flywheel's own energy, which the shafts' sensors would also read
  check('The flywheel hands the shafts under 25 kJ over the limit a change', qual.changes >= 4 && qual.overJ / qual.changes < 25_000 && none.overJ / none.changes < 25_000,
    `${fmt(qual.overJ / qual.changes / 1000, 1)} kJ a change deploying, ${fmt(none.overJ / none.changes / 1000, 1)} kJ without, over ${qual.changes} up-shifts`);
  // The engine gives way to the motor: 50 kW of deployment buys no time
  check('Deploying adds no power: 60–250 km/h within 1 % either way', Math.abs(qual.t250 / none.t250 - 1) < 0.01, `${fmt(qual.t250)} s deploying, ${fmt(none.t250)} s without`);
  check('The store pays for the deployment through its 95 % efficiency', qual.deployedJ > 300_000 && Math.abs(qual.usedJ / (qual.deployedJ / C.ers.deployEfficiency) - 1) < 0.01 && none.usedJ === 0,
    `${fmt(qual.deployedJ / 1e6, 2)} MJ at the crank for ${fmt(qual.usedJ / 1e6, 2)} MJ of charge`);
}

console.log('\n== Hybrid: deployment, regeneration and the store');
{
  // Steady flat out at 200 km/h in qualifying mode: all 50 kW, never more
  {
    const car = makeCar();
    car.reset(0, 0, 0, 200 / 3.6);
    car.setPerformanceMode('PSH');
    car.ersEnergyJ = C.ers.ERS_MAX_CHARGE;
    let peak = 0;
    run(car, 3, () => ({ throttle: 1, brake: 0, steer: 0 }), (c, t) => {
      if (t > 1) peak = Math.max(peak, c.telemetry.MGUK_POWER);
      return false;
    });
    check('Deploys 50 kW flat out, never more', peak > 49_000 && peak <= 50_000 * 1.005, `${fmt(peak / 1000, 1)} kW`);
  }
  // An empty store deploys nothing; a full one takes no more
  {
    const car = makeCar();
    car.reset(0, 0, 0, 200 / 3.6);
    car.setPerformanceMode('PSH');
    car.ersEnergyJ = 0;
    let peak = 0;
    run(car, 2, () => ({ throttle: 1, brake: 0, steer: 0 }), (c) => {
      peak = Math.max(peak, c.telemetry.MGUK_POWER);
      return false;
    });
    const full = makeCar();
    full.reset(0, 0, 0, 280 / 3.6);
    full.ersEnergyJ = C.ers.ERS_MAX_CHARGE;
    let regen = 0;
    run(full, 2, () => ({ throttle: 0, brake: 0.5, steer: 0 }), (c) => {
      regen = Math.min(regen, c.telemetry.MGUK_POWER);
      return false;
    });
    check('An empty store deploys nothing, a full one takes no more', peak === 0 && regen === 0 && full.ersEnergyJ === C.ers.ERS_MAX_CHARGE, `${fmt(peak / 1000, 1)} kW out, ${fmt(regen / 1000, 1)} kW in`);
  }
  // A stop from 300 km/h at half pedal: up to 200 kW into the store through 90 %, and the rear calipers give way to it
  const stop = (soc: number) => {
    const car = makeCar();
    car.reset(0, 0, 0, 300 / 3.6);
    car.ersEnergyJ = soc * C.ers.ERS_MAX_CHARGE;
    const e0 = car.ersEnergyJ;
    const x0 = car.position.clone();
    let peak = 0;
    let harvested = 0;
    let rearLock = 0;
    run(car, 12, () => ({ throttle: 0, brake: 0.5, steer: 0 }), (c) => {
      peak = Math.min(peak, c.telemetry.MGUK_POWER);
      harvested += Math.max(0, -c.telemetry.MGUK_POWER) * TICK;
      if (c.telemetry.speedKmh > 60) rearLock = Math.max(rearLock, -Math.min(c.wheels[2].slipRatio, c.wheels[3].slipRatio));
      return c.telemetry.speedKmh <= 100;
    }, TICK);
    return { peak, harvested, gained: car.ersEnergyJ - e0, dist: car.position.distanceTo(x0), rearLock };
  };
  const regen = stop(0.2);
  const friction = stop(1);
  check('Regenerates up to 200 kW on the brakes, never more', regen.peak < -150_000 && regen.peak >= -200_000 * 1.01, `${fmt(-regen.peak / 1000, 1)} kW`);
  check('The store gains 90 % of what the motor takes', regen.harvested > 200_000 && Math.abs(regen.gained / (regen.harvested * C.ers.harvestEfficiency) - 1) < 0.01,
    `${fmt(regen.harvested / 1e6, 2)} MJ at the crank, ${fmt(regen.gained / 1e6, 2)} MJ stored (300–100 km/h at half pedal)`);
  // Brake-by-wire: the rear axle brakes what the pedal asks with the motor or without it
  check('Brake-by-wire: the same stop with regeneration as on the calipers alone', Math.abs(regen.dist / friction.dist - 1) < 0.02 && regen.rearLock < 0.12,
    `${fmt(regen.dist, 1)} m regenerating, ${fmt(friction.dist, 1)} m on a full store, rear slip at most ${fmt(regen.rearLock * 100, 1)} %`);
  // The hybrid fills the turbos' lag: off a closed throttle at 4500 rpm the car pulls harder in the first 0.3 s
  const step = (mode: PerformanceModeName) => {
    const car = makeCar();
    car.reset(0, 0, 0, 110 / 3.6);
    car.autoShift = false;
    car.setPerformanceMode(mode);
    car.ersEnergyJ = C.ers.ERS_MAX_CHARGE;
    run(car, 2, (c) => ({ throttle: 0, brake: 0, steer: 0, shiftUp: c.gear < 3, shiftDown: c.gear > 3 }));
    const v0 = car.telemetry.speedKmh;
    run(car, 0.3, () => ({ throttle: 1, brake: 0, steer: 0 }));
    return car.telemetry.speedKmh - v0;
  };
  const filled = step('PSH');
  const lagging = step('CHR');
  check('The motor fills the turbos\' lag off a closed throttle', filled > lagging * 1.03, `+${fmt(filled, 2)} km/h in 0.3 s deploying, +${fmt(lagging, 2)} km/h without`);
}

console.log('\n== Braking through the adapter');
{
  const stop = (preset: 'pro' | 'semi_pro', pedal = 1) => {
    const sim = createLcLmdhSim(pad);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 300 / 3.6);
    for (let t = 0; t < 0.5; t += DT) sim.step(DT, { throttle: 0.9 });
    const s0 = sim.sMeters;
    const v0 = sim.telemetry.speedKmh;
    const gs: number[] = [];
    let lockFront = 0;
    let lockRear = 0;
    let time = 0;
    for (; time < 12 && sim.telemetry.speedKmh > 100; time += DT) {
      sim.step(DT, { brake: pedal });
      gs.push(-sim.telemetry.longitudinalG);
      const slip = sim.telemetry.wheelSlipRatios;
      lockFront = Math.max(lockFront, -Math.min(slip[0], slip[1]));
      lockRear = Math.max(lockRear, -Math.min(slip[2], slip[3]));
    }
    gs.sort((a, b) => a - b);
    return { dist: sim.sMeters - s0, v0, time, peakG: gs[Math.floor(gs.length * 0.98)], meanG: (v0 - sim.telemetry.speedKmh) / 3.6 / time / 9.81, lockFront, lockRear };
  };
  const abs = stop('semi_pro');
  const raw = stop('pro');
  const light = stop('pro', 0.6);
  // ≈ 1.5 g of downforce and 0.35 g of drag at 300 km/h, ≈ 1.7 g on the tyres alone at 100
  check('300–100 km/h in 105–130 m with the semi-pro ABS', abs.dist > 105 && abs.dist < 130, `${fmt(abs.dist, 1)} m in ${fmt(abs.time)} s from ${fmt(abs.v0, 0)} km/h`);
  check('Peak 3.2–3.8 g, 2.3–2.8 g over the stop', abs.peakG > 3.2 && abs.peakG < 3.8 && abs.meanG > 2.3 && abs.meanG < 2.8, `peak ${fmt(abs.peakG)} g, mean ${fmt(abs.meanG)} g`);
  check('A stamp locks the wheels without ABS, and stops later', raw.lockFront > 0.5 && raw.dist > abs.dist, `max lock ${fmt(raw.lockFront)}, ${fmt(raw.dist, 1)} m`);
  // 56 % front: as the downforce bleeds off the fronts give first, which keeps the car straight
  check('The fronts lock before the rears', light.lockFront > 0.5 && light.lockRear < 0.3, `at 60 % pedal: front ${fmt(light.lockFront)}, rear ${fmt(light.lockRear)}`);
  const pm = LC_LMDH_PROFILE_CAR;
  let planned = 0;
  for (let v = 300 / 3.6; v > 100 / 3.6; v -= 0.05) {
    const grip = pm.muLong * (9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  check('Braking line never plans shorter than the car stops', planned >= abs.dist * 0.95, `${fmt(planned, 1)} m planned vs ${fmt(abs.dist, 1)} m stopped`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed)');
// Slicks out of 60 °C: μ ≈ 1.6 on the tyres at low speed, the downforce adding its share of the weight above it
for (const [kmh, lo, hi] of [
  [100, 1.65, 2.05],
  [200, 2.25, 2.75],
  [250, 2.55, 3.15],
] as const) {
  const car = makeCar();
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  let frontSa = 0;
  let rearSa = 0;
  run(car, 12, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 12) * 0.5 };
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
  check(`Understeers at the limit at ${kmh} km/h`, frontSa > rearSa, `front ${fmt((frontSa * 180) / Math.PI, 1)}°, rear ${fmt((rearSa * 180) / Math.PI, 1)}° slip at the peak`);
}

console.log('\n== Traction control through the adapter');
{
  const damp = { waterMm: 0.3, wetness: wetnessFromWater(0.3), ambientC: 15, rain: 0.3 };
  const noTc = { ...LC_LMDH_SIM_PROFILE, assistDials: { ...LC_LMDH_SIM_PROFILE.assistDials, pro: { tcLevel: 0, tc2Level: 4, absLevel: 0 } } };
  const exit = (tcOn: boolean) => {
    const sim = createLcLmdhSim(pad, null, tcOn ? LC_LMDH_SIM_PROFILE : noTc);
    sim.assistPreset = 'pro';
    sim.setWeatherSample(damp);
    sim.teleportToDistance(1000, 80 / 3.6);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 2; t += DT) {
      sim.setWeatherSample(damp);
      sim.step(DT, { throttle: 1 });
      sum += Math.max(sim.telemetry.wheelSlipRatios[2], sim.telemetry.wheelSlipRatios[3]);
      n++;
    }
    return sum / n;
  };
  const tc = exit(true);
  const raw = exit(false);
  // The car's own TC (pro keeps it): its 9 % target in the two seconds it works on a damp road
  check('The car\'s own TC holds rear wheelspin on a damp road', tc < 0.15 && tc < raw * 0.6, `mean rear slip ${fmt(tc, 2)} with TC, ${fmt(raw, 2)} with it off`);
}

console.log('\n== Gearbox and limiter');
{
  // Held in first, flat out: the limiter keeps the engine at the end of its regulated curve
  const sim = createLcLmdhSim(pad);
  sim.assistPreset = 'semi_pro';
  sim.autoGearbox = false;
  sim.teleportToDistance(1000, 30 / 3.6);
  let maxRpm = 0;
  for (let t = 0; t < 8; t += DT) {
    sim.step(DT, { throttle: 1 });
    maxRpm = Math.max(maxRpm, sim.telemetry.rpm);
  }
  const redline = C.gearbox.gears.redline_rpm;
  check('Held in first, the limiter stops the engine at 1.025 Nmax', sim.telemetry.gear === 1 && maxRpm > redline - 150 && maxRpm < redline + 80, `${fmt(maxRpm, 0)} rpm of ${redline}`);
  // The auto box takes every gear on the way to top speed and changes up around Nmax
  const auto = createLcLmdhSim(pad);
  auto.assistPreset = 'semi_pro';
  auto.teleportToDistance(1000, 0);
  const shiftRpm: number[] = [];
  let gear = auto.telemetry.gear;
  let lastRpm = 0;
  for (let t = 0; t < 40; t += DT) {
    auto.step(DT, { throttle: 1 });
    if (auto.telemetry.gear === gear + 1) shiftRpm.push(lastRpm);
    gear = auto.telemetry.gear;
    lastRpm = auto.telemetry.rpm;
  }
  check('The auto box takes all seven gears, changing up near Nmax', gear === 7 && shiftRpm.length === 6 && shiftRpm.slice(1).every((r) => Math.abs(r - LC_LMDH_POWER.nMax) < 250),
    `up-shifts at ${shiftRpm.map((r) => fmt(r, 0)).join(', ')} rpm`);

  const u = measureUpshift((t) => createLcLmdhSim(t), 120);
  check('An up-shift on a light pedal: the drive goes, the wheels slip under 15 %', u.to === u.from + 1 && u.gMin < u.gBefore - 0.05 && u.slipPeak < 0.15,
    `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
  const d = measureDownshift((t) => createLcLmdhSim(t), 200, 5, 0.4);
  check('A down-shift on the brakes: no wheel slips past 8 %, the car is not tugged 0.3 g harder', d.to === d.from - 1 && d.slipPeak < 0.08 && d.gMin > d.gBefore - 0.3,
    `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
  // Over-rev protection (Art. 9.8.4): a shift that would land over the limiter is refused, one well under it is taken
  const g = C.gearbox;
  const taken = downshiftTakenAt((t) => createLcLmdhSim(t), 5, g.ratios, g.gears.redline_rpm, -600);
  const refused = !downshiftTakenAt((t) => createLcLmdhSim(t), 5, g.ratios, g.gears.redline_rpm, 100);
  check('A down-shift that would pass the limiter is refused', taken && refused, `600 rpm under: ${taken ? 'taken' : 'refused'}, 100 over: ${refused ? 'refused' : 'taken'}`);
}

console.log('\n== Fuel and steering');
{
  const sim = createLcLmdhSim(pad);
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  for (let t = 0; t < 30; t += DT) sim.step(DT, { throttle: 1 });
  const burnt = f0 - sim.telemetry.fuelKg;
  // ≈ 0.033 kg/s at 8000 rpm, a little less through the gears
  check('30 s flat out from rest burns 0.8–1.0 kg', f0 === 38 && burnt > 0.8 && burnt < 1.0, `${fmt(burnt, 3)} kg of ${f0} kg`);
  // 225° of rim lock at the hands' 900°/s
  const steer = createLcLmdhSim(pad);
  steer.teleportToDistance(1000, 50 / 3.6);
  let tLock = NaN;
  for (let t = 0; t < 1 && Number.isNaN(tLock); t += DT / 4) {
    steer.step(DT / 4, { analogSteer: 1 });
    if (steer.steerAngleNorm >= 0.999) tLock = t + DT / 4;
  }
  check('Full lock from centre in 0.24–0.26 s (225° at 900°/s)', tLock > 0.24 && tLock < 0.26, `${fmt(tLock, 3)} s`);
}

console.log('\n== What the sound hears: driveshaft and motor telemetry');
{
  const sim = createLcLmdhSim(pad, null);
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  // Off the line the clutch slips: the motor is on the gearbox's side of it, turning with the wheels
  let launch = { rpm: 0, mgu: 0 };
  for (let t = 0; t < 0.4; t += DT) sim.step(DT, { throttle: 1 });
  launch = { rpm: sim.telemetry.rpm, mgu: sim.telemetry.mguRpm ?? NaN };
  for (let t = 0; t < 9; t += DT) sim.step(DT, { throttle: 1 });
  const flat = { ...sim.telemetry };
  const g = sim.vehicle.config.gearbox;
  const overall = g.ratios[flat.gear - 1] * g.finalDrive;
  check('Off the line the motor turns with the gearbox, under the slipping engine', launch.mgu < launch.rpm - 500 && launch.mgu > 0, `motor ${fmt(launch.mgu, 0)} rpm, engine ${fmt(launch.rpm, 0)} rpm`);
  check('In gear the motor turns with the engine', Math.abs((flat.mguRpm ?? NaN) / flat.rpm - 1) < 0.01, `${fmt(flat.mguRpm ?? NaN, 0)} / ${fmt(flat.rpm, 0)} rpm in gear ${flat.gear}`);
  const kmhPerRadS = flat.speedKmh / (flat.driveshaftRadS ?? NaN);
  check('Driveshaft speed is the rear wheels\'', Math.abs((flat.driveshaftRadS ?? NaN) * overall * (30 / Math.PI) / flat.rpm - 1) < 0.01 && kmhPerRadS > 1.2 && kmhPerRadS < 1.3,
    `${fmt(flat.driveshaftRadS ?? NaN, 1)} rad/s at ${fmt(flat.speedKmh, 0)} km/h (${fmt(kmhPerRadS, 3)} km/h a rad/s)`);
  // The shafts carry what the limit allows: torque × speed ≈ 500 kW flat out
  const shaftKw = ((flat.driveshaftTorqueNm ?? NaN) * (flat.driveshaftRadS ?? NaN)) / 1000;
  check('Driveshaft torque flat out is the regulated power over the shafts\' speed', shaftKw > 440 && shaftKw < 512, `${fmt(flat.driveshaftTorqueNm ?? NaN, 0)} Nm, ${fmt(shaftKw, 0)} kW`);
  for (let t = 0; t < 0.6; t += DT) sim.step(DT, { throttle: 0 });
  const lift = { ...sim.telemetry };
  check('Negative on the overrun', (lift.driveshaftTorqueNm ?? 0) < -50, `${fmt(lift.driveshaftTorqueNm ?? NaN, 0)} Nm off the throttle`);
  let regenKw = 0;
  let brakeNm = 0;
  for (let t = 0; t < 0.8; t += DT) {
    sim.step(DT, { throttle: 0, brake: 0.5 });
    regenKw = Math.min(regenKw, sim.telemetry.mgukPowerKw ?? 0);
    brakeNm = Math.min(brakeNm, sim.telemetry.driveshaftTorqueNm ?? 0);
  }
  check('Regenerating: the motor\'s power is negative and the shafts carry it', regenKw < -100 && regenKw >= -202 && brakeNm < (lift.driveshaftTorqueNm ?? 0), `${fmt(regenKw, 0)} kW, shafts ${fmt(brakeNm, 0)} Nm`);
  check('Deploying: the motor\'s power is positive', (flat.mgukPowerKw ?? 0) > 0 || flat.ersBatteryPercent < 1, `${fmt(flat.mgukPowerKw ?? NaN, 1)} kW flat out, store ${fmt(flat.ersBatteryPercent, 0)} %`);
}

console.log('\n== Registry: a preview car on its own body and sound');
{
  if (!HOSTED_CONTENT) {
    console.log('SKIP  (NEXT_PUBLIC_HOSTED_CONTENT is not 1: this copy lists only the repository\'s car)');
  } else {
    const def = carById('lc-lmdh');
    check('Reached by its link, on its own physics', resolveCarId('lc-lmdh') === 'lc-lmdh' && def.physics === 'lc-lmdh' && carForVehicle('lc-lmdh').id === 'lc-lmdh', '');
    check('Left out of the pickers until it has been driven', def.preview === true && !CARS.some((c) => c.id === 'lc-lmdh'), `${CARS.length} cars listed`);
    check('Its own body and sound bank', def.modelUrl === '/cars/lc-lmdh/model/lc-lmdh.glb' && def.sound === LC_LMDH_SOUND && LC_LMDH_SOUND.assetDir === '/cars/lc-lmdh/audio/' && LC_LMDH_SOUND.limiterRpm === C.gearbox.gears.redline_rpm,
      `limiter ${LC_LMDH_SOUND.limiterRpm} rpm`);
  }
}

console.log('\n== Autopilot round RISE Motordrome against the other prototype');
{
  const track = getActiveTrackData();
  const root = loadGlbGeometry('public/tracks/rwanda_official/rwanda_official.glb');
  const lap = (sim: F12026CarSim) => {
    sim.resetToStartGrid(true);
    sim.aiAutopilot = true;
    sim.aiPaceScale = 1;
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
  const lmdh = lap(createLcLmdhSim(track, root));
  const other = lap(createMtr496rSim(track, root));
  check('Flying lap completes, CG within 0.5 m of the edge', lmdh.done && lmdh.beyond <= 0.5 && lmdh.maxSlip < 12,
    `lap ${fmt(lmdh.lapS, 2)} s, top ${fmt(lmdh.top, 0)} km/h, CG ${fmt(Math.max(0, lmdh.beyond), 2)} m past the edge, max body slip ${fmt(lmdh.maxSlip, 1)}°`);
  // 150 kg heavier with fuel, with ≈ 95 kW more and more downforce: within a few seconds of it either way
  check('Within 6 s of the 496R', Math.abs(lmdh.lapS - other.lapS) < 6, `${fmt(lmdh.lapS, 2)} s vs the 496R's ${fmt(other.lapS, 2)} s`);
}

/**
 * The body as the browser loads it (three's GLTFLoader, textures left out so it runs in Node) against the physics it
 * sits on: the rig's nodes, the wheels where the chassis has them, the cameras inside or around the car
 */
async function bodyChecks(): Promise<void> {
  console.log('\n== The body (public/cars/lc-lmdh/model/lc-lmdh.glb)');
  const file = 'public/cars/lc-lmdh/model/lc-lmdh.glb';
  if (!existsSync(file)) {
    console.log(`SKIP  (${file} is not in this copy)`);
    return;
  }
  const buf = readFileSync(file);
  const n = buf.readUInt32LE(12);
  const j = JSON.parse(buf.subarray(20, 20 + n).toString('utf8'));
  delete j.images;
  delete j.textures;
  delete j.samplers;
  for (const m of j.materials ?? []) {
    const pbr = m.pbrMetallicRoughness ?? {};
    delete pbr.baseColorTexture;
    delete pbr.metallicRoughnessTexture;
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    for (const e of Object.values(m.extensions ?? {}) as Record<string, unknown>[]) for (const k of Object.keys(e)) if (k.endsWith('Texture')) delete e[k];
  }
  let json = Buffer.from(JSON.stringify(j));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + n);
  const out = Buffer.alloc(20 + json.length + rest.length);
  out.write('glTF', 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  rest.copy(out, 20 + json.length);
  const scene = await new Promise<THREE.Group>((resolve, reject) =>
    new GLTFLoader().parse(out.buffer.slice(out.byteOffset, out.byteOffset + out.length) as ArrayBuffer, '', (g) => resolve(g.scene), reject)
  );
  scene.updateMatrixWorld(true);
  const root = portedCarRoot(scene);
  type Cam = { pos: [number, number, number]; pitchDeg: number; fov: number };
  const x = root.userData as {
    wheelCentres?: Record<string, [number, number, number]>;
    tyreRadius?: Record<string, number>;
    tyreHalfWidth?: Record<string, number>;
    cameras?: Record<string, Cam>;
    steer?: { pivot: [number, number, number] };
  };
  const names = ['BODY', 'STEER', ...['LF', 'RF', 'LR', 'RR'].flatMap((c) => [`WHEEL_${c}`, `WHEEL_${c}_RIM`, `WHEEL_${c}_TYRE`])];
  const missing = names.filter((name) => !scene.getObjectByName(name));
  check('The rig finds its root, body, steering wheel and four wheels', root !== scene && !!x.wheelCentres && missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `root "${root.name}"`);
  const lf = x.wheelCentres?.WHEEL_LF ?? [0, 0, 0];
  const lr = x.wheelCentres?.WHEEL_LR ?? [0, 0, 0];
  const H = LC_LMDH_HARDPOINTS;
  const mm = (a: number, b: number) => Math.abs(a - b) * 1000;
  check('Wheels where the chassis has them: tracks and wheelbase within 1 mm', mm(2 * lf[0], H.trackWidthFront) < 1 && mm(2 * lr[0], H.trackWidthRear) < 1 && mm(lf[2] - lr[2], C.chassis.wheelbase) < 1,
    `tracks ${fmt(2 * lf[0], 4)} / ${fmt(2 * lr[0], 4)} m, wheelbase ${fmt(lf[2] - lr[2], 4)} m`);
  check('Tyres the size the physics rolls on: radius within 0.5 mm, width within 2 mm',
    mm(x.tyreRadius?.LF ?? 0, H.wheelRadiusFront) < 0.5 && mm(x.tyreRadius?.LR ?? 0, H.wheelRadiusRear) < 0.5 && mm(2 * (x.tyreHalfWidth?.LF ?? 0), H.tyreWidthFront) < 2 && mm(2 * (x.tyreHalfWidth?.LR ?? 0), H.tyreWidthRear) < 2,
    `radius ${x.tyreRadius?.LF} / ${x.tyreRadius?.LR} m, width ${fmt(2 * (x.tyreHalfWidth?.LF ?? 0), 3)} / ${fmt(2 * (x.tyreHalfWidth?.LR ?? 0), 3)} m`);
  const box = new THREE.Box3().setFromObject(scene.getObjectByName('BODY') ?? scene, true).applyMatrix4(root.matrixWorld.clone().invert());
  const size = box.getSize(new THREE.Vector3());
  // 5100 × 2000 mm in the regulations (Art. 3.1.2, 3.1.4); the model is 28 mm wide of it. Nothing stray far from the car
  check('The body is one car: under 5.11 m long, 2.03 m wide, 1.4 m tall', size.z > 4.9 && size.z < 5.11 && size.x > 1.9 && size.x < 2.03 && box.max.y > 1 && box.max.y < 1.4,
    `${fmt(size.z, 3)} × ${fmt(size.x, 3)} m, top ${fmt(box.max.y, 3)} m`);
  const cams = x.cameras ?? {};
  const eye = cams.cockpit?.pos ?? [0, 0, 0];
  const pivot = x.steer?.pivot ?? [0, 0, 0];
  // The driver's eye: on the steering wheel's side, 0.35–0.6 m behind its centre and 0.12–0.3 m above it, under the roof
  check('Cockpit camera at the driver\'s eye, behind and above the steering wheel', Math.abs(eye[0] - pivot[0]) < 0.03 && pivot[2] - eye[2] > 0.35 && pivot[2] - eye[2] < 0.6 && eye[1] - pivot[1] > 0.12 && eye[1] - pivot[1] < 0.3 &&
    box.containsPoint(new THREE.Vector3(...eye)) && eye[1] < box.max.y - 0.15,
    `eye ${eye.join(', ')}; wheel ${pivot.map((v) => fmt(v, 3)).join(', ')}`);
  const near = cams.nearChase?.pos ?? [0, 0, 0];
  const far = cams.farChase?.pos ?? [0, 0, 0];
  const bumper = cams.bumper?.pos ?? [0, 0, 0];
  const tcam = cams.tcam?.pos ?? [0, 0, 0];
  check('Chase cameras 2–6 m behind the tail, the bumper camera in the nose, the T-cam on the roof',
    box.min.z - near[2] > 2 && box.min.z - far[2] > box.min.z - near[2] && box.min.z - far[2] < 6 && bumper[2] > lf[2] && bumper[2] < box.max.z && tcam[1] > 1 && tcam[1] < box.max.y + 0.4,
    `near ${fmt(box.min.z - near[2], 2)} m, far ${fmt(box.min.z - far[2], 2)} m behind; T-cam at ${fmt(tcam[1], 2)} m`);
}

void bodyChecks()
  .catch((e) => {
    failures.push(`body: ${String(e)}`);
  })
  .then(() => {
    console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll LC-LMDH checks passed.');
    if (failures.length) process.exitCode = 1;
  });
