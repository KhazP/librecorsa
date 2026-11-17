/**
 * Headless checks for the BMW M1 Procar (`src/lib/sim/classic`): the f12026-car vehicle model on Pfalzdriver's Assetto
 * Corsa data, a mid-engined, rear-driven Group 4 car with a naturally aspirated straight six and wing aero.
 *
 *   npx tsx scripts/verify-bmw-m1-procar.ts
 *
 * The engine, at rest, the suspension geometry, the aero against speed, straight line, braking and cornering on flat
 * ground, the driver aids through the simulator adapter, the gearbox, the ported body (when this copy has it), then
 * autopilot laps of Rwanda against the GT3's. The ranges are what the mod's data gives in Assetto Corsa terms (its
 * tables, gearing, brake torque and tyre data), not tuned to these numbers.
 */
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { BMW_M1_PROCAR_CONFIG } from '../src/lib/sim/classic/BmwM1ProcarConfig';
import { BMW_M1_PROCAR_PROFILE_CAR, BMW_M1_PROCAR_SIM_PROFILE, createBmwM1ProcarSim } from '../src/lib/sim/classic/BmwM1ProcarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { buildDoubleWishboneHardpoints, solveCornerKinematics3D } from '../src/lib/sim/suspension-kinematics';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
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
const C = BMW_M1_PROCAR_CONFIG;
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
/** Crank torque the curve gives at `rpm` (Nm) */
const crankNm = (rpm: number) => (lerp(C.engine.powerCurve, rpm) * 1000 * 30) / (Math.PI * rpm);
const [SPOILER, WING] = C.aero.wings;
/** The aero the data gives with the front spoiler `hFront` m off the road, the elements at their set angles [spec] */
const expectedAero = (hFront: number) => {
  const spoiler = SPOILER.area * lerp(SPOILER.lutAOA_CL, SPOILER.angleDeg) * lerp(SPOILER.lutGH_CL_mult, hFront);
  const wing = WING.area * lerp(WING.lutAOA_CL, WING.angleDeg);
  const cdA = C.aero.drag + SPOILER.area * lerp(SPOILER.lutAOA_CD, SPOILER.angleDeg) * lerp(SPOILER.lutGH_CD_mult, hFront) + WING.area * lerp(WING.lutAOA_CD, WING.angleDeg);
  return { clA: spoiler + wing, cdA };
};

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

console.log('\n== M1 config');
{
  check('Rear-wheel drive, five gears, 9200 rpm limiter, no turbo', !('drivenAxle' in C) && C.gearbox.ratios.length === 5 && C.gearbox.gears.redline_rpm === 9200 && !('turbo' in C.engine) && !BMW_M1_PROCAR_SIM_PROFILE.turbo, '');
  check('No hybrid, DRS or brake-by-wire; no heave springs', C.ers.ERS_MAX_DEPLOY === 0 && C.brakes.brakeByWire === false && C.suspensions.front.heave.rate === 0 && C.suspensions.rear.heave.rate === 0, '');
  check('Wing aero: a front spoiler and a rear wing, no ride-height map', C.aero.rhMap === undefined && C.aero.wings.length === 2 && SPOILER.name === 'FRONT_WING' && WING.name === 'REAR_WING', '');
  const car = makeCar();
  check('The engine drives the rear wheels', car.drivenWheels[0] === 2 && car.drivenWheels[1] === 3, `wheels ${car.drivenWheels.join(', ')}`);
}

console.log('\n== Engine');
{
  // power.lut after the driveline's 0.92: 340 Nm at 6500 rpm, 318 at 9000
  const wheel6500 = crankNm(6500) * 0.92;
  const wheel9000 = crankNm(9000) * 0.92;
  const kwAt = (rpm: number) => lerp(C.engine.powerCurve, rpm);
  check('340 Nm at the wheels at 6500 rpm, 318 at 9000', Math.abs(wheel6500 - 340) < 0.5 && Math.abs(wheel9000 - 318) < 0.5, `${fmt(wheel6500, 1)} Nm, ${fmt(wheel9000, 1)} Nm`);
  check('≈ 330 kW at the crank at the 9200 rpm limiter, 303 at the wheels', Math.abs(kwAt(9200) - 329.7) < 1 && Math.abs(kwAt(9200) * 0.92 - 303.3) < 1, `${fmt(kwAt(9200), 1)} kW, ${fmt(kwAt(9200) * 0.92, 1)} kW at the wheels`);
  // Coast: nothing at idle, 120 Nm at 8900 rpm [spec COAST_REF]
  check('Overrun 0 at idle, 120 Nm at 8900 rpm', lerp(C.engine.coastCurve, 1100) === 0 && lerp(C.engine.coastCurve, 8900) === 120, `${fmt(lerp(C.engine.coastCurve, 5000), 1)} Nm at 5000 rpm`);
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
  // 46.5 % of the sprung weight forward [spec CG_LOCATION]; the hubs, 38 kg each in front and 45 at the rear, move it a little
  const hubs = 2 * C.chassis.unsprungMassFront + 2 * C.chassis.unsprungMassRear;
  const hubFront = ((MASS - hubs) * C.chassis.frontWeightFraction + 2 * C.chassis.unsprungMassFront) / MASS;
  check('Front axle carries ≈ 46 % of the weight', Math.abs(front - hubFront) < 0.005 && Math.abs(total - MASS * 9.81) < 5, `${fmt(front * 100, 1)} % (${fmt(hubFront * 100, 1)} % from the data)`);
  // The pickups 0.30 / 0.345 m under the CG's level, the body 0.404 / 0.447 m up at the axles: 104 / 102 mm
  check("Rides at the data's 104 / 102 mm at the pickups", Math.abs(t.aeroHeightFront - 0.104) < 0.004 && Math.abs(t.aeroHeightRear - 0.102) < 0.004,
    `${fmt(t.aeroHeightFront * 1000, 1)} / ${fmt(t.aeroHeightRear * 1000, 1)} mm`);
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
}

console.log('\n== Aero against speed (flat, held speed)');
{
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
    return { clA: t.downforceN / q, cdA: t.dragN / q, bal: t.AERO_BALANCE, front: t.aeroHeightFront, rear: t.aeroHeightRear, freeRadius, omega: car.wheels[0].omega };
  };
  for (const kmh of [100, 250]) {
    const m = at(kmh);
    const e = expectedAero(m.front);
    // The elements ride on the body's pitch, so their angles move a little: within 4 %
    check(`At ${kmh} km/h the spoiler, wing and body give their tables' forces`, Math.abs(m.clA / e.clA - 1) < 0.04 && Math.abs(m.cdA / e.cdA - 1) < 0.04,
      `CL·A ${fmt(m.clA, 3)} (${fmt(e.clA, 3)}) CD·A ${fmt(m.cdA, 3)} (${fmt(e.cdA, 3)}) front ${fmt(m.bal, 1)} % at ${fmt(m.front * 1000, 0)} / ${fmt(m.rear * 1000, 0)} mm`);
    // The spoiler 0.85 m ahead of the front axle and the wing 0.82 m behind the rear one, of near equal lift
    check(`Aero balance 40–60 % front at ${kmh} km/h`, m.bal > 40 && m.bal < 60, `${fmt(m.bal, 1)} %`);
    if (kmh === 250) {
      // 0.025 mm of radius per rad/s of spin [spec RADIUS_ANGULAR_K]: ≈ 6 mm at 250 km/h
      const grown = (m.freeRadius - RADIUS) * 1000;
      check('Front tyres grow 0.025 mm per rad/s of spin', Math.abs(grown - 0.025 * m.omega) < 0.25, `${fmt(grown, 1)} mm at ${fmt(m.omega, 0)} rad/s`);
    }
  }
  // In the data's own terms at rest (104 mm): CL·A 0.18 + 0.18, CD·A 0.43 + 0.09 + 0.01
  const rest = expectedAero(0.104);
  check('At the static ride height: CL·A 0.34–0.38 m², CD·A 0.50–0.54 m²', rest.clA > 0.34 && rest.clA < 0.38 && rest.cdA > 0.5 && rest.cdA < 0.54, `${fmt(rest.clA, 3)} m², ${fmt(rest.cdA, 3)} m²`);
}

const pad = createFlatTestTrack(30_000, 3000);

console.log('\n== Straight line through the adapter');
{
  const sim = createBmwM1ProcarSim(pad);
  sim.assistPreset = 'pro';
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
  // 1095 kg on ≈ 300 kW at the wheels, an 85 km/h first gear on the open-ish slicks (no TC: it spins), then the 260 ms
  // change into second with the pedal up
  check('0-100 km/h 3.6–5.0 s on a flat-out start', t100 > 3.6 && t100 < 5.0, `${fmt(t100)} s, 0-200 ${fmt(t200)} s`);
  // Fifth reaches ≈ 293 km/h at the limiter; the wheel power against CD·A ≈ 0.52 m² and the rolling resistance would go
  // faster, so the limiter sets the top speed
  const fifth = (rpm: number) => ((rpm * Math.PI) / 30 / (C.gearbox.ratios[4] * C.gearbox.finalDrive)) * RADIUS;
  const rr = 0.012;
  let vDrag = 0;
  for (let v = 60; v < 120; v += 0.05) {
    const rpm = (v / RADIUS) * C.gearbox.ratios[4] * C.gearbox.finalDrive * (30 / Math.PI);
    const pWheel = crankNm(Math.min(rpm, 9250)) * 0.92 * (rpm * Math.PI) / 30;
    const resist = 0.5 * RHO * 0.52 * v * v + rr * (MASS * 9.81 + 0.5 * RHO * 0.36 * v * v);
    if (pWheel < resist * v) break;
    vDrag = v;
  }
  const vTop = Math.min(vDrag, fifth(9200));
  check('Top speed within 3 % of the limiter in fifth (power and drag would go faster)', vDrag > fifth(9200) && Math.abs(vmax / 3.6 / vTop - 1) < 0.03,
    `${fmt(vmax, 1)} km/h vs limiter ${fmt(fifth(9200) * 3.6, 1)} (power and drag ${fmt(vDrag * 3.6, 0)})`);
}

console.log('\n== Braking through the adapter');
{
  const stop = (preset: 'pro' | 'semi_pro') => {
    const sim = createBmwM1ProcarSim(pad);
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
  // 2700 Nm, 66 % front [spec brakes.ini]: 18.3 kN at the road, 1780 Nm on each front wheel. Under 1.5 g a front tyre
  // carries ≈ 3.9 kN, where the slick's μ (1.46 at FZ0 2962 N, falling with load, × 1.06 on the brakes [spec DX_REF,
  // LS_EXPX, BRAKE_DX_MOD]) gives ≈ 5.6 kN, under the 6.0 kN the brake asks of it: a mid-engined car on a front-heavy
  // bias, so full pedal locks the fronts without ABS
  check('Full pedal locks the fronts without ABS', raw.lock > 0.5 && raw.gAt150 < 1.45, `max lock ${fmt(raw.lock)}, ${fmt(raw.gAt150)} g at 150 km/h in gear ${raw.gearAt150}`);
  // With the ABS the tyres, not the torque, set the stop: a little longer than the brakes alone could give (the spinning
  // wheels and the engine through third slowing with the car), far shorter than locked
  const fb = (2 * C.brakes.maxTorqueNm) / RADIUS;
  const wheelsKg = (2 * C.chassis.wheelInertiaFront + 2 * C.chassis.wheelInertiaRear) / RADIUS ** 2;
  const engineKg = (gear: number) => C.engine.inertia * ((C.gearbox.ratios[gear - 1] * C.gearbox.finalDrive) / RADIUS) ** 2;
  const resist = (v: number) => 0.5 * RHO * 0.52 * v * v + 0.012 * (MASS * 9.81 + 0.5 * RHO * 0.36 * v * v);
  let ideal = 0;
  for (let v = 200 / 3.6; v > 1; v -= 0.05) ideal += (v * 0.05) / ((fb + resist(v)) / (MASS + wheelsKg + engineKg(3)));
  check('200→0 km/h with ABS 0–12 % longer than the brake torque and drag allow, shorter than locked', abs.dist > ideal && abs.dist < ideal * 1.12 && abs.dist < raw.dist,
    `${fmt(abs.dist, 1)} m with ABS, ${fmt(raw.dist, 1)} m locked, ${fmt(ideal, 1)} m on the brake torque alone`);

  const pm = BMW_M1_PROCAR_PROFILE_CAR;
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
// μ ≈ 1.5 at the static loads, but the 0.43 m CG on the data's 1.83 m track and the front bar five times the rear's
// load the outer front hard, where the power law costs it grip: the fronts set the limit
for (const [kmh, lo, hi] of [
  [100, 1.15, 1.45],
  [200, 1.2, 1.5],
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
  check(`Understeers at the limit at ${kmh} km/h`, frontSa > rearSa, `front ${fmt((frontSa * 180) / Math.PI, 1)}°, rear ${fmt((rearSa * 180) / Math.PI, 1)}° slip at the peak`);
}

console.log('\n== Driver aids through the adapter');
{
  const dials = BMW_M1_PROCAR_SIM_PROFILE.assistDials;
  const E = BMW_M1_PROCAR_SIM_PROFILE.electronics!;
  // No ABS, no TC on the car [spec electronics.ini PRESENT=0]
  check('Pro: no ABS, no TC; semi-pro: the ABS at 12 %; assisted adds a TC', dials.pro.absLevel === 0 && dials.pro.tcLevel === 0 && dials.semi_pro.tcLevel === 0 &&
    E.absLevels[12 - dials.semi_pro.absLevel] === 0.12 && dials.assisted.tcLevel > 0, '');
  // On a damp road the slicks spin in first at 55 km/h flat out; the assisted TC holds them above its 50 km/h floor
  const damp = { waterMm: 0.3, wetness: wetnessFromWater(0.3), ambientC: 15, rain: 0.3 };
  const exit = (preset: 'pro' | 'assisted') => {
    const sim = createBmwM1ProcarSim(pad);
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
  check('Assisted TC holds rear wheelspin on a damp road', tc < 0.15 && tc < raw * 0.5, `mean rear slip ${fmt(tc, 2)} with TC, ${fmt(raw, 2)} without`);

  // From 120 km/h on a damp road: the wheels lock without ABS; the semi-pro ABS holds them near its 12 %, the worst
  // (a front, on the 66 % bias) a little past it between the 150 Hz pump's cycles [spec RATE_HZ]
  const lock = (preset: 'pro' | 'semi_pro') => {
    const sim = createBmwM1ProcarSim(pad);
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
  check('Semi-pro ABS holds the wheels near 12 % on a damp road where pro locks them', rawSlip > 0.5 && absSlip > 0.08 && absSlip < 0.18,
    `mean worst-wheel slip ${fmt(absSlip, 3)} with ABS, ${fmt(rawSlip, 2)} without`);
}

console.log("\n== Brakes, fuel and steering from the car's data");
{
  const pads = [0, 300, 600, 900].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
  check('Pad friction 0.85 / 1.00 / 1.00 / 0.90 at 0 / 300 / 600 / 900 °C', [0.85, 1, 1, 0.9].every((v, i) => Math.abs(pads[i] - v) < 1e-9), pads.map((v) => fmt(v)).join(' / '));

  // Fuel flow follows the engine's speed: 0.005 l/s per 1000 rpm at full throttle, 0.74 kg/l
  // The fuel-flow model, burning (the game's sprints run on a fixed load, `SimRealismFlags.fuelUse`)
  const sim = createBmwM1ProcarSim(pad);
  sim.setSimRealism({ ...SIM_REALISM_FLAGS.full, fuelUse: true });
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  let expected = 0;
  for (let t = 0; t < 30; t += DT) {
    sim.step(DT, { throttle: 1 });
    expected += (sim.telemetry.rpm / 1000) * 0.005 * 0.74 * DT;
  }
  const burnt = f0 - sim.telemetry.fuelKg;
  check("30 s flat out burns what CONSUMPTION 0.005 gives at the engine's speed", Math.abs(burnt / expected - 1) < 0.05, `${fmt(burnt, 3)} kg vs ${fmt(expected, 3)} kg`);

  // A pad turns the rack no faster than hands turn the 360° of rim lock (900°/s)
  const steer = createBmwM1ProcarSim(pad);
  steer.teleportToDistance(1000, 50 / 3.6);
  let tLock = NaN;
  for (let t = 0; t < 1 && Number.isNaN(tLock); t += DT / 4) {
    steer.step(DT / 4, { analogSteer: 1 });
    if (steer.steerAngleNorm >= 0.999) tLock = t + DT / 4;
  }
  check('Full lock from centre in 0.39–0.41 s (360° at 900°/s)', tLock > 0.39 && tLock < 0.41, `${fmt(tLock, 3)} s`);
}

console.log('\n== Up-shift');
{
  // 260 ms between gears with the pedal up as long
  // At 70 km/h, under the limiter: in first at 90 km/h the engine sits on it, with no drive to lose in the shift
  const u = measureUpshift((t) => createBmwM1ProcarSim(t), 70);
  check("An up-shift on a light pedal: the drive goes, then the driven wheels take the engine's excess, under 16 % of slip", u.to === u.from + 1 && u.gMin < u.gBefore - 0.05 && u.slipPeak < 0.16,
    `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
}

console.log('\n== Down-shift');
{
  // A 90 % heel-and-toe blip in the 270 ms between gears; the clutch takes up what it leaves
  const d = measureDownshift((t) => createBmwM1ProcarSim(t), 170, 4, 0.5);
  check('A down-shift on the brakes: the blip brings the engine up, no wheel slips past 8 % and the car is not tugged 0.25 g harder', d.to === d.from - 1 && d.slipPeak < 0.08 && d.gMin > d.gBefore - 0.25,
    `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
  // No down-shift protection in the data: the box takes a down-shift up to the engine's 9700 rpm damage threshold. In
  // second at a speed where first would land over the limiter (the car starts in first there and its box shifts up; the
  // pull waits for that shift to finish), one pull of the lever
  const g = C.gearbox;
  const takes = (overRpm: number) => {
    const car = makeCar();
    const v = (((g.gears.redline_rpm + overRpm) * Math.PI) / 30 / (g.ratios[0] * g.finalDrive)) * RADIUS;
    car.reset(0, 0, 0, v);
    run(car, 0.4, () => ({ throttle: 0.3, brake: 0, steer: 0 }));
    const from = car.gear;
    const over = (car.speedMs / RADIUS) * g.ratios[0] * g.finalDrive * (30 / Math.PI) - g.gears.redline_rpm;
    car.step(DT, { throttle: 0, brake: 0, steer: 0, shiftDown: true });
    return { shift: `${from}→${car.gear}`, over };
  };
  // The light pedal through the settle gains ≈ 250 rpm
  const near = takes(150);
  const far = takes(800);
  check('The box takes a down-shift that lands under 500 rpm over the limiter and refuses one well past it', near.over < 500 && far.over > 600 && near.shift === '2→1' && far.shift === '2→2',
    `${fmt(near.over, 0)} over: ${near.shift}, ${fmt(far.over, 0)} over: ${far.shift}`);
}

console.log('\n== Ported body');
{
  // A hosted car: carById lists it only where the hosted content is on, so the file is read by its path
  const glb = 'public/cars/bmw-m1-procar/model/bmw-m1-procar.glb';
  if (!hasFile(glb)) {
    noteSkip('Ported body', glb);
  } else {
    const buf = readFileSync(glb);
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
      nodes: { name: string; mesh?: number; children?: number[]; extras?: Record<string, unknown> }[];
    };
    const byName = new Map(json.nodes.map((n) => [n.name, n]));
    const extras = byName.get('CAR')?.extras as { wheelbaseM?: number; tyreRadius?: Record<string, number>; trackWidthM?: { front: number; rear: number } } | undefined;
    check('CAR / BODY / WHEEL_xx rig nodes', ['CAR', 'BODY', 'WHEEL_LF', 'WHEEL_RF', 'WHEEL_LR', 'WHEEL_RR'].every((n) => byName.has(n)), '');
    if (extras?.wheelbaseM !== undefined && extras.tyreRadius) {
      check('Wheelbase and tyre radii match the physics (2.53 m, 0.295 m)', Math.abs(extras.wheelbaseM - C.chassis.wheelbase) < 0.01 && Math.abs(extras.tyreRadius.LF - RADIUS) < 0.01 && Math.abs(extras.tyreRadius.LR - RADIUS) < 0.01,
        `${fmt(extras.wheelbaseM, 3)} m, front ${fmt(extras.tyreRadius.LF, 3)}, rear ${fmt(extras.tyreRadius.LR, 3)} m`);
    }
    // The data's tracks are wider than the drawn wheels stand (see the config): shown, not checked
    if (extras?.trackWidthM) {
      console.log(`      drawn tracks ${fmt(extras.trackWidthM.front, 3)} / ${fmt(extras.trackWidthM.rear, 3)} m, the physics' ${fmt(C.chassis.trackWidthFront, 3)} / ${fmt(C.chassis.trackWidthRear, 3)} m`);
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
  const m1 = lap(createBmwM1ProcarSim(track, root));
  const gt3 = lap(createAmgGt3Sim(track, root));
  check('Flying lap completes, CG within 0.5 m of the edge', m1.done && m1.beyond <= 0.5 && m1.maxSlip < 12,
    `lap ${fmt(m1.lapS, 2)} s, top ${fmt(m1.top, 0)} km/h, CG ${fmt(Math.max(0, m1.beyond), 2)} m past the edge, max body slip ${fmt(m1.maxSlip, 1)}°`);
  console.log(`      the GT3 on the same autopilot: ${fmt(gt3.lapS, 2)} s, top ${fmt(gt3.top, 0)} km/h`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll M1 checks passed.');
if (failures.length) process.exitCode = 1;
