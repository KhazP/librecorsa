/**
 * Headless checks for the Nissan Skyline GT-R BCNR33 JGTC (`src/lib/sim/classic`): the f12026-car vehicle model on
 * gregsediting's Assetto Corsa data, a rear-driven twin-turbo GT500 car with a ride-height aero map.
 *
 *   npx tsx scripts/verify-nissan-r33-jgtc.ts
 *
 * At rest, the turbos, the aero map against speed, straight line, braking and cornering on flat ground, the driver aids
 * through the simulator adapter, the gearbox, the ported body (when this copy has it), then autopilot laps of Rwanda
 * against the GT3's. The ranges are what the mod's data gives in Assetto Corsa terms (its tables, gearing, brake torque
 * and tyre data), not tuned to these numbers.
 */
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { turboSteadyBoost } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { NISSAN_R33_CONFIG } from '../src/lib/sim/classic/NissanR33Config';
import { NISSAN_R33_PROFILE_CAR, NISSAN_R33_SIM_PROFILE, createNissanR33Sim } from '../src/lib/sim/classic/NissanR33Sim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { measureDownshift, measureUpshift } from './lib/upshift-test';
import { evaluateBrakePadMuFactor } from '../src/lib/sim/brake-physics';
import { hasFile, noteSkip } from './lib/hosted-files';
import { readFileSync } from 'node:fs';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const C = NISSAN_R33_CONFIG;
const RHO = 1.225;
const MASS = C.chassis.totalMassKg;
const RADIUS = C.tyreCompounds[C.compoundSlots.soft].front.radius;
const lerp = (lut: readonly (readonly [number, number])[], x: number) => {
  if (x <= lut[0][0]) return lut[0][1];
  for (let i = 1; i < lut.length; i++) {
    if (x <= lut[i][0]) return lut[i - 1][1] + ((lut[i][1] - lut[i - 1][1]) * (x - lut[i - 1][0])) / (lut[i][0] - lut[i - 1][0]);
  }
  return lut[lut.length - 1][1];
};
/** Crank torque the curve gives at `rpm` with the boost made (Nm) */
const crankNm = (rpm: number) => (lerp(C.engine.powerCurve, rpm) * 1000 * 30) / (Math.PI * rpm);

const makeCar = () => new VehiclePhysics({ ground: flat, config: C, airDensity: RHO });

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, stop?: (car: VehiclePhysics, t: number) => boolean): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, drive(car, t));
    t += DT;
    if (stop?.(car, t)) break;
  }
  return t;
}

console.log('\n== R33 config');
{
  check('Rear-wheel drive, six gears, 7000 rpm limiter', !('drivenAxle' in C) && C.gearbox.ratios.length === 6 && C.gearbox.gears.redline_rpm === 7000, '');
  check('No hybrid, DRS or brake-by-wire; no heave springs', C.ers.ERS_MAX_DEPLOY === 0 && C.brakes.brakeByWire === false && C.suspensions.front.heave.rate === 0 && C.suspensions.rear.heave.rate === 0, '');
  check('Ride-height aero map with a splitter and a rear wing on top', C.aero.rhMap !== undefined && C.aero.wings.length === 2 && C.aero.rhMap.clA === 3 && C.aero.rhMap.cdA === 1.1, '');
  const car = makeCar();
  check('The engine drives the rear wheels', car.drivenWheels[0] === 2 && car.drivenWheels[1] === 3, `wheels ${car.drivenWheels.join(', ')}`);
}

console.log('\n== Turbos');
{
  const turbo = C.engine.turbo!;
  // Two turbos of 1.0 each [spec TURBO_0 / TURBO_1]: torque × (1 + 1 + 1) at full boost, × (1 + 2 · 0.787) at 4000 rpm
  check('Full boost from 4400 rpm, torque × 3', turboSteadyBoost(turbo, 4400) === 2 && turboSteadyBoost(turbo, 6000) === 2 && Math.abs(turboSteadyBoost(turbo, 4000) - 2 * (4000 / 4400) ** 2.5) < 1e-9,
    `boost ${fmt(turboSteadyBoost(turbo, 3000))} / ${fmt(turboSteadyBoost(turbo, 4000))} / ${fmt(turboSteadyBoost(turbo, 4400))} at 3000 / 4000 / 4400 rpm`);
  // power.lut 204 Nm at 4400 rpm × 3, 170.2 at 6000 × 3, before the driveline's 0.92
  const wheel4400 = crankNm(4400) * 0.92;
  const wheel6000 = crankNm(6000) * 0.92;
  const peakKw = Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 0.92;
  check('612 Nm at 4400 rpm, 321 kW at the wheels at 6000', Math.abs(wheel4400 - 612) < 0.5 && Math.abs(wheel6000 - 510.6) < 0.5 && Math.abs(peakKw - 320.8) < 0.5,
    `${fmt(wheel4400, 1)} Nm, ${fmt(wheel6000, 1)} Nm, peak ${fmt(peakKw, 1)} kW`);

  // Spool: LAG_UP 0.965 at 333 Hz is an 84 ms time constant, LAG_DN 0.990 300 ms. In second near 4400 rpm, off the
  // throttle until the boost is gone, then flat out: the gauge (bar over atmospheric) reaches 63 % of its rise in about
  // one time constant (the engine's own torque lag adds a little); a lift lets it run down over ≈ 0.3 s
  const sim = createNissanR33Sim(createFlatTestTrack(30_000, 3000));
  sim.assistPreset = 'semi_pro';
  sim.autoGearbox = false;
  const v4400 = ((4400 * Math.PI) / 30 / (C.gearbox.ratios[1] * C.gearbox.finalDrive)) * RADIUS;
  sim.teleportToDistance(1000, v4400);
  for (let t = 0; t < 1.5; t += DT) sim.step(DT, { throttle: 0 });
  const gear = sim.telemetry.gear;
  const boost0 = sim.telemetry.turboBoostBar - 1;
  let tUp = NaN;
  let full = 0;
  const H = 1 / 600;
  for (let t = 0; t < 1; t += H) {
    sim.step(H, { throttle: 1 });
    full = Math.max(full, sim.telemetry.turboBoostBar - 1);
  }
  // Again, timing the rise against that full
  sim.teleportToDistance(1000, v4400);
  for (let t = 0; t < 1.5; t += DT) sim.step(DT, { throttle: 0 });
  for (let t = 0; t < 1 && Number.isNaN(tUp); t += H) {
    sim.step(H, { throttle: 1 });
    if (sim.telemetry.turboBoostBar - 1 >= 0.63 * full) tUp = t;
  }
  let tDown = NaN;
  for (let t = 0; t < 1.5; t += H) sim.step(H, { throttle: 1 });
  const held = sim.telemetry.turboBoostBar - 1;
  for (let t = 0; t < 2 && Number.isNaN(tDown); t += H) {
    sim.step(H, { throttle: 0 });
    if (sim.telemetry.turboBoostBar - 1 <= 0.37 * held) tDown = t;
  }
  check('Spools up in ≈ 84 ms near 4400 rpm, runs down in ≈ 0.3 s', gear === 2 && boost0 < 0.05 && full > 0.9 && tUp > 0.06 && tUp < 0.16 && tDown > 0.24 && tDown < 0.4,
    `second from ${fmt(boost0)} bar: 63 % of ${fmt(full)} bar in ${fmt(tUp * 1000, 0)} ms; down to 37 % in ${fmt(tDown * 1000, 0)} ms`);
}

console.log('\n== At rest');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  run(car, 3, () => ({ throttle: 0, brake: 1, steer: 0 }));
  const t = car.telemetry;
  const fz = car.wheels.map((w) => w.fz);
  const total = fz.reduce((a, b) => a + b, 0);
  const front = (fz[0] + fz[1]) / total;
  // 45 % of the sprung weight forward [spec CG_LOCATION]; the hubs, 37 kg each in front and 41 at the rear, move it a little
  const hubFront = (FRONT_SHARE_WITH_HUBS());
  check('Front axle carries ≈ 45 % of the weight', Math.abs(front - hubFront) < 0.005 && Math.abs(total - MASS * 9.81) < 5, `${fmt(front * 100, 1)} % (${fmt(hubFront * 100, 1)} % from the data)`);
  // The pickups 0.353 / 0.354 m under the CG's level, the body 0.400 / 0.395 m up at the axles: 47 / 41 mm
  check('Rides at the data\'s 47 / 41 mm at the pickups', Math.abs(t.aeroHeightFront - 0.047) < 0.004 && Math.abs(t.aeroHeightRear - 0.041) < 0.004,
    `${fmt(t.aeroHeightFront * 1000, 1)} / ${fmt(t.aeroHeightRear * 1000, 1)} mm`);
}

function FRONT_SHARE_WITH_HUBS(): number {
  const hubs = 2 * C.chassis.unsprungMassFront + 2 * C.chassis.unsprungMassRear;
  return ((MASS - hubs) * C.chassis.frontWeightFraction + 2 * C.chassis.unsprungMassFront) / MASS;
}

console.log('\n== Aero against speed (flat, held speed)');
{
  const map = C.aero.rhMap!;
  /** The map's CL·A, CD·A and front share at these ride heights, the wings at their set angles [spec] */
  const expected = (front: number, rear: number) => {
    const seg = (axis: number[], x: number): [number, number, number] => {
      if (x <= axis[0]) return [0, 0, 0];
      if (x >= axis[axis.length - 1]) return [axis.length - 1, axis.length - 1, 0];
      let i = 0;
      while (x > axis[i + 1]) i++;
      return [i, i + 1, (x - axis[i]) / (axis[i + 1] - axis[i])];
    };
    const [r0, r1, tr] = seg(map.rearRh, rear);
    const [c0, c1, tc] = seg(map.frontRh, front);
    const at = (t: number[][]) => {
      const top = t[r0][c0] + (t[r0][c1] - t[r0][c0]) * tc;
      const bot = t[r1][c0] + (t[r1][c1] - t[r1][c0]) * tc;
      return top + (bot - top) * tr;
    };
    const splitter = 1.2 * 0.4705;
    const wing = 1.4 * 0.405;
    const body = map.clA * at(map.cl);
    return { clA: body + splitter + wing, cdA: map.cdA * at(map.cd) + 1.2 * 0.0025, bal: (body * at(map.balance) + splitter) / (body + splitter + wing) };
  };
  const at = (kmh: number) => {
    const car = makeCar();
    car.reset(0, 0, 0, kmh / 3.6);
    let pedal = 0.5;
    run(car, 6, (c) => {
      pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.01 : -0.01), 0, 1);
      return { throttle: pedal, brake: 0, steer: 0 };
    });
    const t = car.telemetry;
    const q = 0.5 * RHO * (kmh / 3.6) ** 2;
    const freeRadius = 0.5 * (car.wheels[0].rollingRadius + car.wheels[0].deflection / 3 + car.wheels[1].rollingRadius + car.wheels[1].deflection / 3);
    return { clA: t.downforceN / q, cdA: t.dragN / q, bal: t.AERO_BALANCE / 100, front: t.aeroHeightFront, rear: t.aeroHeightRear, freeRadius, omega: car.wheels[0].omega };
  };
  for (const kmh of [100, 250]) {
    const m = at(kmh);
    const e = expected(m.front, m.rear);
    // The wings ride on the body's pitch, and the map's roll and yaw tables are 1 straight ahead: within 2 %
    check(`At ${kmh} km/h the map and wings give their tables' forces`, Math.abs(m.clA / e.clA - 1) < 0.02 && Math.abs(m.cdA / e.cdA - 1) < 0.02 && Math.abs(m.bal - e.bal) < 0.01,
      `CL·A ${fmt(m.clA)} (${fmt(e.clA)}) CD·A ${fmt(m.cdA, 3)} (${fmt(e.cdA, 3)}) front ${fmt(m.bal * 100, 1)} % (${fmt(e.bal * 100, 1)}) at ${fmt(m.front * 1000, 0)} / ${fmt(m.rear * 1000, 0)} mm`);
    if (kmh === 250) {
      // The body's colliders are 50 mm above the pickups: the pickups may run down to the map's −10 mm, the body not touch
      check('The body clear of the road at 250 km/h', Math.min(m.front, m.rear) > -0.04, `pickups ${fmt(m.front * 1000, 0)} / ${fmt(m.rear * 1000, 0)} mm`);
      // 0.03 mm of radius per rad/s of spin [spec RADIUS_ANGULAR_K]: ≈ 6 mm at 250 km/h
      const grown = (m.freeRadius - RADIUS) * 1000;
      check('Front tyres grow 0.03 mm per rad/s of spin', Math.abs(grown - 0.03 * m.omega) < 0.25, `${fmt(grown, 1)} mm at ${fmt(m.omega, 0)} rad/s`);
    }
  }
  // In the data's own terms at rest (47 / 41 mm): CL·A 2.52 + 1.13 = 3.65 m², CD·A 1.0, 42 % front
  const rest = expected(0.047, 0.041);
  check('At the static ride height: CL·A 3.6–3.7 m², CD·A 0.98–1.03 m², 41–44 % front', rest.clA > 3.6 && rest.clA < 3.7 && rest.cdA > 0.98 && rest.cdA < 1.03 && rest.bal > 0.41 && rest.bal < 0.44,
    `${fmt(rest.clA)} m², ${fmt(rest.cdA, 3)} m², ${fmt(rest.bal * 100, 1)} %`);
}

const pad = createFlatTestTrack(30_000, 3000);

console.log('\n== Straight line through the adapter');
{
  const sim = createNissanR33Sim(pad);
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  let t100 = NaN;
  let t200 = NaN;
  let vmax = 0;
  for (let t = 0; t < 60; t += DT) {
    sim.step(DT, { throttle: 1 });
    const v = sim.telemetry.speedKmh;
    vmax = Math.max(vmax, v);
    if (Number.isNaN(t100) && v >= 100) t100 = t;
    if (Number.isNaN(t200) && v >= 200) t200 = t;
  }
  // A 63 km/h first gear on ≈ 1.3 g of rear grip (no TC: it spins), then 2.3× down into second at 2900 rpm, where the
  // turbos make a third of their boost: ≈ 1.6 s in first, ≈ 1.6 s from 63 to 100 km/h at 0.5–0.9 g
  check('0-100 km/h 3.0–4.2 s on a flat-out start', t100 > 3.0 && t100 < 4.2, `${fmt(t100)} s, 0-200 ${fmt(t200)} s`);
  // Drag-limited in sixth: the wheel power (falling past 6000 rpm) against CD·A ≈ 1.0 m² and the rolling resistance on
  // the weight and ≈ 3.6 m² of downforce; sixth reaches 292 km/h at the limiter
  const sixth = (rpm: number) => ((rpm * Math.PI) / 30 / (C.gearbox.ratios[5] * C.gearbox.finalDrive)) * RADIUS;
  let vDrag = 0;
  for (let v = 60; v < sixth(7000); v += 0.05) {
    const rpm = (v / RADIUS) * C.gearbox.ratios[5] * C.gearbox.finalDrive * (30 / Math.PI);
    const pWheel = crankNm(rpm) * 0.92 * (rpm * Math.PI) / 30;
    const resist = 0.5 * RHO * 1.0 * v * v + 0.01 * (MASS * 9.81 + 0.5 * RHO * 3.65 * v * v);
    if (pWheel < resist * v) break;
    vDrag = v;
  }
  check('Top speed within 3 % of what power and drag give, under the limiter', Math.abs(vmax / 3.6 / vDrag - 1) < 0.03 && vmax / 3.6 < sixth(7000),
    `${fmt(vmax, 1)} km/h vs ${fmt(vDrag * 3.6, 1)} (limiter in sixth ${fmt(sixth(7000) * 3.6, 0)})`);
}

console.log('\n== Braking through the adapter');
{
  const stop = (preset: 'pro' | 'semi_pro') => {
    const sim = createNissanR33Sim(pad);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 200 / 3.6);
    const s0 = sim.sMeters;
    let lock = 0;
    let gAt150 = NaN;
    let gearAt150 = 0;
    for (let t = 0; t < 10 && sim.telemetry.speedKmh > 1; t += DT) {
      sim.step(DT, { brake: 1 });
      if (sim.telemetry.speedKmh > 30) lock = Math.max(lock, -Math.min(...sim.telemetry.wheelSlipRatios));
      if (Number.isNaN(gAt150) && sim.telemetry.speedKmh < 150) {
        gAt150 = -sim.telemetry.longitudinalG;
        gearAt150 = sim.telemetry.gear;
      }
    }
    return { dist: sim.sMeters - s0, lock, gAt150, gearAt150 };
  };
  const raw = stop('pro');
  const abs = stop('semi_pro');
  // 3500 Nm, 59 % front [spec brakes.ini]: 19.4 kN at the road; the tyres could take more, so the brakes, not the grip,
  // set the stop. The torque also slows the spinning wheels (ANGULAR_INERTIA) and, through the gear, the engine
  // (INERTIA): the car decelerates as if ≈ 110 kg heavier [spec, derived]
  const fb = (2 * C.brakes.maxTorqueNm) / RADIUS;
  const wheelsKg = (2 * C.chassis.wheelInertiaFront + 2 * C.chassis.wheelInertiaRear) / RADIUS ** 2;
  const engineKg = (gear: number) => C.engine.inertia * ((C.gearbox.ratios[gear - 1] * C.gearbox.finalDrive) / RADIUS) ** 2;
  const resist = (v: number) => 0.5 * RHO * 1.0 * v * v + 0.01 * (MASS * 9.81 + 0.5 * RHO * 3.65 * v * v);
  const at150 = (fb + resist(150 / 3.6)) / (MASS + wheelsKg + engineKg(raw.gearAt150)) / 9.81;
  check('Brake-torque limited: the data\'s torque and drag at 150 km/h', Math.abs(raw.gAt150 / at150 - 1) < 0.04,
    `${fmt(raw.gAt150)} g in gear ${raw.gearAt150} (${fmt(at150)} from the data), max lock ${fmt(raw.lock)}`);
  // The stop with the engine through third, the box's middle gear on the way down
  let ideal = 0;
  for (let v = 200 / 3.6; v > 1; v -= 0.05) ideal += (v * 0.05) / ((fb + resist(v)) / (MASS + wheelsKg + engineKg(3)));
  check('200→0 km/h within 5 % of what the brake torque and drag give', Math.abs(raw.dist / ideal - 1) < 0.05 && Math.abs(abs.dist / ideal - 1) < 0.05,
    `${fmt(raw.dist, 1)} m without ABS, ${fmt(abs.dist, 1)} m with, ${fmt(ideal, 1)} m from the data`);

  const pm = NISSAN_R33_PROFILE_CAR;
  let planned = 0;
  for (let v = 200 / 3.6; v > 1; v -= 0.05) {
    const n = 1 + (pm.downforceCoef * v * v) / pm.massKg / 9.81;
    const grip = pm.muLong * Math.pow(n, -(pm.muLoadExp ?? 0)) * (9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  check('Braking line never plans shorter than the car stops', planned >= abs.dist * 0.97, `${fmt(planned, 1)} m planned vs ${fmt(abs.dist, 1)} m stopped`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed)');
// The GT3 holds 1.6–1.9 g here on similar slicks; the R33 is as heavy, with ≈ 3.6 m² of CL·A against the GT3's ≈ 2.2, and
// its CG 0.40 m up on a 1.55 m track loads the outer tyres hard, where the slicks' steep load sensitivity (LS_EXPY 0.6)
// costs it grip
for (const [kmh, lo, hi] of [
  [100, 1.55, 1.95],
  [200, 1.9, 2.4],
] as const) {
  const car = makeCar();
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  let frontSa = 0;
  let rearSa = 0;
  run(car, 12, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 12) * 0.6 };
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
  // 45 % of the weight forward with the stiffer front roll (ARB 45 / 35 kN/m) and the aero 42–45 % front: the fronts give first
  check(`Understeers at the limit at ${kmh} km/h`, frontSa > rearSa, `front ${fmt((frontSa * 180) / Math.PI, 1)}°, rear ${fmt((rearSa * 180) / Math.PI, 1)}° slip at the peak`);
}

console.log('\n== Driver aids through the adapter');
{
  const dials = NISSAN_R33_SIM_PROFILE.assistDials;
  // ABS fitted but off by default, no TC [spec electronics.ini]
  check('Pro: no ABS, no TC; semi-pro: the ABS at 12 %; assisted adds a TC', dials.pro.absLevel === 0 && dials.pro.tcLevel === 0 && dials.semi_pro.tcLevel === 0 &&
    NISSAN_R33_SIM_PROFILE.electronics!.absLevels[12 - dials.semi_pro.absLevel] === 0.12 && dials.assisted.tcLevel > 0, '');
  // On a damp road the slicks spin in first at 55 km/h flat out; the assisted TC holds them above its 50 km/h floor
  const damp = { waterMm: 0.3, wetness: wetnessFromWater(0.3), ambientC: 15, rain: 0.3 };
  const exit = (preset: 'pro' | 'assisted') => {
    const sim = createNissanR33Sim(pad);
    sim.assistPreset = preset;
    sim.setWeatherSample(damp);
    sim.teleportToDistance(1000, 55 / 3.6);
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
  const tc = exit('assisted');
  const raw = exit('pro');
  check('Assisted TC holds rear wheelspin on a damp road', tc < 0.15 && tc < raw * 0.4, `mean rear slip ${fmt(tc, 2)} with TC, ${fmt(raw, 2)} without`);

  // From 120 km/h on a damp road: the wheels lock without ABS; the ABS holds them near its 12 % (abs.lut position 3)
  const lock = (preset: 'pro' | 'semi_pro') => {
    const sim = createNissanR33Sim(pad);
    sim.assistPreset = preset;
    sim.setWeatherSample(damp);
    sim.teleportToDistance(1000, 120 / 3.6);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 3 && sim.telemetry.speedKmh > 30; t += DT) {
      sim.setWeatherSample(damp);
      sim.step(DT, { brake: 1 });
      sum += -Math.min(...sim.telemetry.wheelSlipRatios);
      n++;
    }
    return sum / n;
  };
  const absSlip = lock('semi_pro');
  const rawSlip = lock('pro');
  check('Semi-pro ABS holds the wheels near 12 % on a damp road where pro locks them', rawSlip > 0.5 && absSlip > 0.08 && absSlip < 0.16,
    `mean worst-wheel slip ${fmt(absSlip, 3)} with ABS, ${fmt(rawSlip, 2)} without`);
}

console.log('\n== Brakes, fuel and steering from the car\'s data');
{
  const pads = [0, 400, 1000, 1200].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
  check('Pad friction 0.97 / 1.00 / 0.96 / 0.90 at 0 / 400 / 1000 / 1200 °C', [0.97, 1, 0.96, 0.9].every((v, i) => Math.abs(pads[i] - v) < 1e-9), pads.map((v) => fmt(v)).join(' / '));

  // Fuel flow follows the engine's speed: 0.00574 l/s per 1000 rpm at full throttle, 0.74 kg/l
  const sim = createNissanR33Sim(pad);
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  let expected = 0;
  for (let t = 0; t < 30; t += DT) {
    sim.step(DT, { throttle: 1 });
    expected += (sim.telemetry.rpm / 1000) * 0.00574 * 0.74 * DT;
  }
  const burnt = f0 - sim.telemetry.fuelKg;
  check('30 s flat out burns what CONSUMPTION 0.00574 gives at the engine\'s speed', Math.abs(burnt / expected - 1) < 0.05, `${fmt(burnt, 3)} kg vs ${fmt(expected, 3)} kg`);

  // A pad turns the rack no faster than hands turn the 250° of rim lock (900°/s)
  const steer = createNissanR33Sim(pad);
  steer.teleportToDistance(1000, 50 / 3.6);
  let tLock = NaN;
  for (let t = 0; t < 1 && Number.isNaN(tLock); t += DT / 4) {
    steer.step(DT / 4, { analogSteer: 1 });
    if (steer.steerAngleNorm >= 0.999) tLock = t + DT / 4;
  }
  check('Full lock from centre in 0.27–0.29 s (250° at 900°/s)', tLock > 0.27 && tLock < 0.29, `${fmt(tLock, 3)} s`);
}

console.log('\n== Up-shift');
{
  // A dog box: 100 ms between gears with the ignition cut for 110 ms
  const u = measureUpshift((t) => createNissanR33Sim(t), 120);
  check('An up-shift on a light pedal: the dogs are out, then the driven wheels take the engine\'s excess, under 15 % of slip', u.to === u.from + 1 && u.gMin < u.gBefore - 0.05 && u.slipPeak < 0.15,
    `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
}

console.log('\n== Down-shift');
{
  // A 70 % blip in the 150 ms between gears; the clutch, home by 180 ms, takes up what it leaves
  const d = measureDownshift((t) => createNissanR33Sim(t), 150, 4, 0.5);
  check('A down-shift on the brakes: the blip brings the engine up, no wheel slips past 8 % and the car is not tugged 0.25 g harder', d.to === d.from - 1 && d.slipPeak < 0.08 && d.gMin > d.gBefore - 0.25,
    `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
  // No down-shift protection in the data (ACTIVE=0): the box takes it up to the engine's 9000 rpm damage threshold. In
  // second at the speed where first lands this far over the limiter (the car settles in second there), one pull of the
  // paddle
  const g = C.gearbox;
  const takes = (overRpm: number) => {
    const car = makeCar();
    const v = (((g.gears.redline_rpm + overRpm) * Math.PI) / 30 / (g.ratios[0] * g.finalDrive)) * RADIUS;
    car.reset(0, 0, 0, v);
    run(car, 0.05, () => ({ throttle: 0.2, brake: 0, steer: 0 }));
    const from = car.gear;
    car.step(DT, { throttle: 0, brake: 0, steer: 0, shiftDown: true });
    return `${from}→${car.gear}`;
  };
  const over1500 = takes(1500);
  const over2500 = takes(2500);
  check('The box takes a down-shift that lands 1500 rpm over the limiter and refuses one 2500 over', over1500 === '2→1' && over2500 === '2→2', `1500 over: ${over1500}, 2500 over: ${over2500}`);
}

console.log('\n== Ported body');
{
  // A hosted car: carById lists it only where the hosted content is on, so the file is read by its path
  const glb = 'public/cars/nissan-r33-jgtc/model/nissan-r33-jgtc.glb';
  if (!hasFile(glb)) {
    noteSkip('Ported body', glb);
  } else {
    const buf = readFileSync(glb);
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
      nodes: { name: string; mesh?: number; children?: number[]; extras?: Record<string, unknown> }[];
    };
    const byName = new Map(json.nodes.map((n) => [n.name, n]));
    const extras = byName.get('CAR')?.extras as { wheelbaseM?: number; tyreRadius?: Record<string, number> } | undefined;
    check('CAR / BODY / WHEEL_xx rig nodes', ['CAR', 'BODY', 'WHEEL_LF', 'WHEEL_RF', 'WHEEL_LR', 'WHEEL_RR'].every((n) => byName.has(n)), '');
    if (extras?.wheelbaseM !== undefined && extras.tyreRadius) {
      // The body's rear tyres are drawn 7 mm larger than the data's 0.3606 m
      check('Wheelbase and tyre radii match the physics (2.72 m, 0.361 m)', Math.abs(extras.wheelbaseM - C.chassis.wheelbase) < 0.01 && Math.abs(extras.tyreRadius.LF - RADIUS) < 0.01 && Math.abs(extras.tyreRadius.LR - RADIUS) < 0.01,
        `${fmt(extras.wheelbaseM, 3)} m, front ${fmt(extras.tyreRadius.LF, 3)}, rear ${fmt(extras.tyreRadius.LR, 3)} m`);
    }
  }
}

console.log('\n== Autopilot round Rwanda against the GT3');
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
  const r33 = lap(createNissanR33Sim(track, root));
  const gt3 = lap(createAmgGt3Sim(track, root));
  check('Flying lap completes, CG within 0.5 m of the edge', r33.done && r33.beyond <= 0.5 && r33.maxSlip < 12,
    `lap ${fmt(r33.lapS, 2)} s, top ${fmt(r33.top, 0)} km/h, CG ${fmt(Math.max(0, r33.beyond), 2)} m past the edge, max body slip ${fmt(r33.maxSlip, 1)}°`);
  console.log(`      the GT3 on the same autopilot: ${fmt(gt3.lapS, 2)} s, top ${fmt(gt3.top, 0)} km/h`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll R33 checks passed.');
if (failures.length) process.exitCode = 1;
