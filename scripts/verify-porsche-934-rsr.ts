/**
 * Headless checks for the Porsche 934 Turbo RSR (`src/lib/sim/classic/Porsche934Rsr*`): the f12026-car vehicle model on
 * the data of Pfalzdriver's Assetto Corsa car, a 1976 Group 4 racing 911 Turbo: a 3.0 L flat six with one big, laggy
 * turbo, four speeds, struts at the front and 60 % of its weight on the rear wheels.
 *
 *   npx tsx scripts/verify-porsche-934-rsr.ts
 *
 * The config, the engine and its turbo (the boost law at full and part throttle, the spool-up and the run-down), at
 * rest, the suspension geometry, the aero against speed, the launch and straight line, braking (which axle locks first
 * on the data's bias, the pads' fade cold and hot), cornering on both tyre sets, the driver aids, the gear changes, the
 * ported body and its liveries (when this copy has them), then autopilot laps of Rwanda against the GT3's. The ranges
 * are what the mod's data gives in Assetto Corsa terms (its tables, gearing, turbo, brake torque and tyre data), not
 * tuned to these numbers.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { getActiveTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { turboBoostAsked, turboSteadyBoost, type CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { PORSCHE_934_RSR_CONFIG } from '../src/lib/sim/classic/Porsche934RsrConfig';
import { PORSCHE_934_RSR_PROFILE_CAR, PORSCHE_934_RSR_SIM_PROFILE, createPorsche934RsrSim } from '../src/lib/sim/classic/Porsche934RsrSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { buildDoubleWishboneHardpoints, solveCornerKinematics3D } from '../src/lib/sim/suspension-kinematics';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { measureDownshift, measureUpshift } from './lib/upshift-test';
import { evaluateBrakePadMuFactor } from '../src/lib/sim/brake-physics';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { hasFile, noteSkip } from './lib/hosted-files';
import { PORSCHE_934_RSR_SKINS } from '../src/lib/cars/pfalzdriver-skins';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const RHO = 1.225;
const lerp = (lut: readonly (readonly [number, number])[], x: number) => {
  if (x <= lut[0][0]) return lut[0][1];
  for (let i = 1; i < lut.length; i++) {
    if (x <= lut[i][0]) return lut[i - 1][1] + ((lut[i][1] - lut[i - 1][1]) * (x - lut[i - 1][0])) / (lut[i][0] - lut[i - 1][0]);
  }
  return lut[lut.length - 1][1];
};

const C = PORSCHE_934_RSR_CONFIG as unknown as CarPhysicsConfig;
const K = PORSCHE_934_RSR_CONFIG;
const MASS = C.chassis.totalMassKg;
const SLICK = C.tyreCompounds[C.compoundSlots.soft]!;
const RF = SLICK.front.radius;
const RR = SLICK.rear.radius;
const TURBO = K.engine.turbo;
const crankNm = (rpm: number) => (lerp(C.engine.powerCurve, rpm) * 1000 * 30) / (Math.PI * rpm);
/** The car on the slicks (or another dry slot), on flat ground */
const makeCar = (slot: 'soft' | 'hard' = 'soft') =>
  new VehiclePhysics({ ground: flat, config: { ...C, compoundSlots: { ...C.compoundSlots, soft: C.compoundSlots[slot] } }, airDensity: RHO });
/** Rpm of the engine at `v` m/s in gear `g` (1-based) */
const rpmAt = (v: number, g: number) => ((v / RR) * C.gearbox.ratios[g - 1] * C.gearbox.finalDrive * 30) / Math.PI;

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, stop?: (car: VehiclePhysics, t: number) => boolean): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, drive(car, t));
    t += DT;
    if (stop?.(car, t)) break;
  }
  return t;
}

/** Holds `gear` and a target speed with the throttle, then hands over to `drive` (the car rolling at that speed) */
function rollingIn(gear: number, v: number): VehiclePhysics {
  const car = makeCar();
  car.reset(0, 0, 0, v);
  car.gear = gear;
  return car;
}

const pad = createFlatTestTrack(30_000, 3000);

console.log('\n== Config');
{
  check('rear-wheel drive, 4 gears, 8400 rpm limiter, a turbo', !('drivenAxle' in C) && C.gearbox.ratios.length === 4 && C.gearbox.gears.redline_rpm === 8400 && TURBO.maxBoost === 1.41 && PORSCHE_934_RSR_SIM_PROFILE.turbo === true, '');
  check('no hybrid, DRS or brake-by-wire; no heave springs; a strut front', C.ers.ERS_MAX_DEPLOY === 0 && C.brakes.brakeByWire === false && C.suspensions.front.heave.rate === 0 && C.suspensions.rear.heave.rate === 0 && C.suspensions.front.type === 'SuspensionType_Strut', '');
  check('the slicks in soft and medium (the data\'s default), the Group 4 tyres in hard', C.compoundSlots.soft === C.compoundSlots.medium && SLICK.name === 'Slicks' && C.tyreCompounds[C.compoundSlots.hard]!.name === 'Group 4 tyres', '');
  const car = makeCar();
  check('the engine drives the rear wheels', car.drivenWheels[0] === 2 && car.drivenWheels[1] === 3, `wheels ${car.drivenWheels.join(', ')}`);
}

console.log('\n== Engine and turbo');
{
  // 210 Nm at the wheels at 6000 rpm before the boost [power.lut], × 2.41 with it
  const wheel = crankNm(6000) * 0.92;
  check('506 Nm at the wheels at 6000 rpm with full boost (210 × 2.41) [power.lut]', Math.abs(wheel - 210 * 2.41) < 1, `${fmt(wheel, 1)} Nm`);
  const kw = Math.max(...C.engine.powerCurve.map(([, p]) => p));
  check('≈ 395 kW (530 hp) at the crank, ≈ 364 kW at the wheels', Math.abs(kw - 395) < 8, `${fmt(kw, 0)} kW crank (${fmt(kw * 1.341, 0)} hp), ${fmt(kw * 0.92, 0)} kW at the wheels`);
  // Full boost at REFERENCE_RPM with the throttle open; a third of it at 3500; half throttle at 6000 asks for 0.35
  check('boost law: 1.41 from 4950 rpm, 0.53 at 3500 rpm, 0.35 at half throttle and 6000', Math.abs(turboSteadyBoost(TURBO, 4950) - 1.41) < 1e-9 &&
    Math.abs(turboSteadyBoost(TURBO, 3500) - 0.534) < 0.01 && Math.abs(turboBoostAsked(TURBO, 6000, 0.5) - 0.347) < 0.01,
    `${fmt(turboSteadyBoost(TURBO, 3500), 3)} at 3500, ${fmt(turboBoostAsked(TURBO, 6000, 0.5), 3)} at half throttle`);

  // Spool-up: fourth gear at ≈ 4950 rpm, the throttle shut for 3 s, then floored; the rpm hardly moves in a second, so
  // the boost climbs on the data's 0.75 s time constant
  {
    const v = (4950 / rpmAt(1, 4)) * 1;
    const car = rollingIn(4, v);
    run(car, 3, () => ({ throttle: 0, brake: 0, steer: 0 }));
    car.velocity.setLength(v);
    const asked = turboSteadyBoost(TURBO, car.rpm);
    let t63 = NaN;
    run(car, 3, () => ({ throttle: 1, brake: 0, steer: 0 }), (c, t) => {
      const boost = ((c.turboBoostBar - 1) * TURBO.maxBoost) / TURBO.displayMaxBoostBar;
      if (Number.isNaN(t63) && boost >= 0.632 * turboSteadyBoost(TURBO, c.rpm)) t63 = t;
      return !Number.isNaN(t63);
    });
    check('spool-up at 4950 rpm: 63 % of the boost in 0.7–1.0 s (LAG_UP 0.997)', t63 > 0.7 && t63 < 1.0, `${fmt(t63)} s to 63 % of ${fmt(asked, 2)}, at ${fmt(car.rpm, 0)} rpm`);
  }
  // Steady part throttle and full throttle at ≈ 6000 rpm in fourth: the gauge reads the boost the law gives
  {
    const gauge = (pedal: number) => {
      const v = 6000 / rpmAt(1, 4);
      const car = rollingIn(4, v);
      run(car, 4, () => ({ throttle: pedal, brake: 0, steer: 0 }), (c) => {
        // Hold the speed: the test is the boost at this rpm, not the car's acceleration
        c.velocity.setLength(v);
        return false;
      });
      return { bar: car.turboBoostBar, rpm: car.rpm };
    };
    const half = gauge(0.5);
    const full = gauge(1);
    const want = (b: number) => 1 + (TURBO.displayMaxBoostBar * b) / TURBO.maxBoost;
    check('at 6000 rpm the gauge reads 2.40 bar flat out and ≈ 1.34 at half pedal', Math.abs(full.bar - want(1.41)) < 0.03 && Math.abs(half.bar - want(turboBoostAsked(TURBO, half.rpm, 0.5))) < 0.05,
      `${fmt(full.bar)} bar flat out, ${fmt(half.bar)} at half pedal (${fmt(half.rpm, 0)} rpm)`);
  }
  // Run-down: from full boost, a lift empties the turbo on the data's 0.25 s
  {
    const v = 6000 / rpmAt(1, 4);
    const car = rollingIn(4, v);
    run(car, 4, () => ({ throttle: 1, brake: 0, steer: 0 }), (c) => (c.velocity.setLength(v), false));
    const b0 = car.turboBoostBar - 1;
    let t37 = NaN;
    run(car, 2, () => ({ throttle: 0, brake: 0, steer: 0 }), (c, t) => {
      if (Number.isNaN(t37) && c.turboBoostBar - 1 <= 0.368 * b0) t37 = t;
      return !Number.isNaN(t37);
    });
    check('run-down on a lift: down to 37 % of the boost in 0.2–0.35 s (LAG_DN 0.991)', t37 > 0.2 && t37 < 0.35, `${fmt(t37)} s`);
  }
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
  const hubs = 2 * C.chassis.unsprungMassFront + 2 * C.chassis.unsprungMassRear;
  const hubFront = ((MASS - hubs) * C.chassis.frontWeightFraction + 2 * C.chassis.unsprungMassFront) / MASS;
  check("the weight split the data gives (≈ 40 % front)", Math.abs(front - hubFront) < 0.006 && Math.abs(total - MASS * 9.81) < 5, `${fmt(front * 100, 1)} % front (${fmt(hubFront * 100, 1)} % from the data)`);
  check("rides at the data's pickup heights (88 / 140 mm)", Math.abs(t.aeroHeightFront - 0.0883) < 0.005 && Math.abs(t.aeroHeightRear - 0.1398) < 0.005,
    `${fmt(t.aeroHeightFront * 1000, 1)} / ${fmt(t.aeroHeightRear * 1000, 1)} mm`);
}

console.log('\n== Suspension geometry');
{
  const D = 180 / Math.PI;
  for (const front of [true, false]) {
    const spec = front ? C.suspensions.front : C.suspensions.rear;
    const hp = buildDoubleWishboneHardpoints(spec.hardpoints!, front, spec.actuation);
    const halfTrack = 0.5 * (front ? C.chassis.trackWidthFront : C.chassis.trackWidthRear);
    const at = (z: number) => solveCornerKinematics3D(hp, z, 0, true, front ? RF : RR);
    const gain = ((at(0.005).uprightCamberRad - at(-0.005).uprightCamberRad) / 0.01) * D;
    const rc = -at(0).contactInboardPerBump * halfTrack;
    check(`${front ? 'front (strut)' : 'rear'}: the hardpoints give the config's camber gain and roll centre`, Math.abs(gain - spec.camberGainKinematic) < 1 && Math.abs(rc - spec.rollCentreHeight) < 0.003,
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
    return { clA: t.downforceN / q, cdA: t.dragN / q, front: t.aeroHeightFront, rear: t.aeroHeightRear };
  };
  for (const kmh of [120, 250]) {
    const m = at(kmh);
    // The spoiler's lift follows its ground-height table (0.85 of it at the 138 mm it rides at), the wing's its angle
    check(`at ${kmh} km/h CL·A 0.14–0.19 m², CD·A within 3 % of the body's 0.683`, m.clA > 0.14 && m.clA < 0.19 && Math.abs(m.cdA / C.aero.drag - 1) < 0.03,
      `CL·A ${fmt(m.clA, 3)} CD·A ${fmt(m.cdA, 3)} at ${fmt(m.front * 1000, 0)} / ${fmt(m.rear * 1000, 0)} mm`);
  }
}

console.log('\n== Launch and straight line through the adapter');
{
  // A driver's start: 5000 rpm held on the clutch, the clutch out over 0.3 s, then the throttle fed to keep the rears
  // at 15 % slip, on slicks from the pit lane's 20 °C (79 % of their grip). Lifting to catch the wheelspin also lets the
  // boost fall (the throttle works inside the boost law), so the car pulls in surges; the clutch slipping at its
  // launch rpm keeps the engine where the turbo works. The mod lists 5.6 s
  const sim = createPorsche934RsrSim(pad);
  sim.assistPreset = 'pro';
  sim.teleportToDistance(1000, 0);
  let t100 = NaN;
  let t200 = NaN;
  let vmax = 0;
  let thr = 0.5;
  for (let t = 0; t < 72.5; t += DT) {
    const tel = sim.telemetry;
    let clutch = 1;
    if (t < 2.5) thr = THREE.MathUtils.clamp(thr + (tel.rpm < 5000 ? 0.05 : -0.05), 0, 1);
    else {
      clutch = Math.max(0, 1 - (t - 2.5) / 0.3);
      thr = THREE.MathUtils.clamp(thr + (Math.max(...tel.wheelSlipRatios.slice(2)) < 0.15 ? 0.03 : -0.06), 0.2, 1);
    }
    sim.step(DT, { throttle: thr, clutch });
    const v = sim.telemetry.speedKmh;
    vmax = Math.max(vmax, v);
    if (Number.isNaN(t100) && v >= 100) t100 = t - 2.5;
    if (Number.isNaN(t200) && v >= 200) t200 = t - 2.5;
  }
  check('0-100 km/h 4.5–6.5 s from a clutch start, the throttle fed (cold slicks)', t100 > 4.5 && t100 < 6.5, `${fmt(t100)} s, 0-200 ${fmt(t200)} s`);
  // Flat out from rest on the auto clutch (no clutch pedal): the clutch slips at its launch rpm instead of pulling the
  // engine down to its 1200–1800 rpm bite, where it makes 110 Nm and no boost
  {
    const auto = createPorsche934RsrSim(pad);
    auto.assistPreset = 'pro';
    auto.teleportToDistance(1000, 0);
    let minRpm = Infinity;
    let t100a = NaN;
    for (let t = 0; t < 12; t += DT) {
      auto.step(DT, { throttle: 1 });
      if (t > 0.3 && t < 2) minRpm = Math.min(minRpm, auto.telemetry.rpm);
      if (Number.isNaN(t100a) && auto.telemetry.speedKmh >= 100) t100a = t;
    }
    check('flat out from rest on the auto clutch: the engine stays over 3500 rpm, 0-100 4.5–6.0 s', minRpm > 3500 && t100a > 4.5 && t100a < 6,
      `lowest ${fmt(minRpm, 0)} rpm in the first 2 s, 0-100 ${fmt(t100a)} s (the mod lists 5.6)`);
  }
  // Flat out from the same start, no TC: the rears light up
  {
    const raw = createPorsche934RsrSim(pad);
    raw.assistPreset = 'pro';
    raw.teleportToDistance(1000, 0);
    let slip = 0;
    for (let t = 0; t < 5; t += DT) {
      raw.step(DT, { throttle: t < 2.5 ? (raw.telemetry.rpm < 5000 ? 0.6 : 0.2) : 1, clutch: t < 2.5 ? 1 : 0 });
      if (t > 2.5) slip = Math.max(slip, ...raw.telemetry.wheelSlipRatios.slice(2));
    }
    check('a clutch dropped at 5000 rpm flat out with no TC spins the rears', slip > 1, `max rear slip ${fmt(slip)}`);
  }
  // Top gear at the limiter against the power the car has against its drag
  const rTop = (rpm: number) => ((rpm * Math.PI) / 30 / (C.gearbox.ratios[3] * C.gearbox.finalDrive)) * RR;
  const cdA = C.aero.drag;
  let vDrag = 0;
  for (let v = 40; v < 120; v += 0.05) {
    const rpm = (v / RR) * C.gearbox.ratios[3] * C.gearbox.finalDrive * (30 / Math.PI);
    const pWheel = (crankNm(Math.min(rpm, 8400)) * 0.92 * (rpm * Math.PI)) / 30;
    const resist = 0.5 * RHO * cdA * v * v + 0.012 * (MASS * 9.81 + 0.5 * RHO * 0.16 * v * v);
    if (pWheel < resist * v || rpm > 8400) break;
    vDrag = v;
  }
  check('top speed within 3 % of what gearing, power and drag give', Math.abs(vmax / 3.6 / Math.min(vDrag, rTop(8400)) - 1) < 0.03,
    `${fmt(vmax, 1)} km/h vs limiter ${fmt(rTop(8400) * 3.6, 1)}, power and drag ${fmt(vDrag * 3.6, 0)}`);
  check('the plan\'s top speed is the car\'s, within 3 %', Math.abs(PORSCHE_934_RSR_PROFILE_CAR.vMaxMs / (vmax / 3.6) - 1) < 0.03, `${fmt(PORSCHE_934_RSR_PROFILE_CAR.vMaxMs * 3.6, 0)} km/h planned`);
}

console.log('\n== Braking through the adapter');
{
  const stop = (preset: 'pro' | 'semi_pro') => {
    const sim = createPorsche934RsrSim(pad);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 200 / 3.6);
    const s0 = sim.sMeters;
    let lock = 0;
    let firstLock = '';
    for (let t = 0; t < 12 && sim.telemetry.speedKmh > 1; t += DT) {
      sim.step(DT, { brake: 1 });
      const s = sim.telemetry.wheelSlipRatios;
      if (sim.telemetry.speedKmh > 30) lock = Math.max(lock, -Math.min(...s));
      if (!firstLock && Math.min(...s) < -0.3) firstLock = Math.min(s[0], s[1]) < Math.min(s[2], s[3]) ? 'front' : 'rear';
    }
    return { dist: sim.sMeters - s0, lock, firstLock };
  };
  const raw = stop('pro');
  const abs = stop('semi_pro');
  check('200→0 km/h stops; the ABS no longer than pedal alone', abs.dist < raw.dist * 1.03 && abs.dist > 90 && abs.dist < 220,
    `${fmt(abs.dist, 1)} m with ABS, ${fmt(raw.dist, 1)} m without (max lock ${fmt(raw.lock)})`);
  // The 2700 Nm out-brakes the tyres (1.42 g of brake force against ≈ 1.2 g of grip): stamped on with no ABS the wheels
  // lock and the stop is a fifth longer. 61 % of the force on the fronts (60 % of the torque on their smaller radius)
  // against 40 % of the static load: the fronts go first, before the load comes forward
  check('a full pedal with no ABS locks up and stops ≥ 10 % longer', raw.lock > 0.9 && raw.dist > abs.dist * 1.1, `max lock ${fmt(raw.lock)}, first lock: ${raw.firstLock || 'none'}`);
  const pm = PORSCHE_934_RSR_PROFILE_CAR;
  let planned = 0;
  for (let v = 200 / 3.6; v > 1; v -= 0.05) {
    const grip = pm.muLong * Math.max(0.2, 9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  check('the braking line never plans shorter than the car stops', planned >= abs.dist * 0.97, `${fmt(planned, 1)} m planned vs ${fmt(abs.dist, 1)} m stopped`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed, tyres from the pit lane\'s 20 °C)');
for (const [slot, kmh, lo, hi] of [
  ['soft', 100, 1.05, 1.4],
  ['soft', 200, 1.0, 1.4],
  ['hard', 100, 0.85, 1.2],
] as const) {
  const car = makeCar(slot);
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  let peakAt = 0;
  run(car, 12, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 12) * 0.6 };
  }, (c, t) => {
    const lat = Math.abs(c.telemetry.latG);
    if (lat > maxLat) {
      maxLat = lat;
      peakAt = t;
    }
    const beta = Math.atan2(c.velocity.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)), c.velocity.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion)));
    return Math.abs(beta) > 0.35;
  });
  const name = slot === 'soft' ? 'slicks' : 'Group 4 tyres';
  check(`${name}: peak lateral at ${kmh} km/h ${lo}–${hi} g`, maxLat > lo && maxLat < hi, `${fmt(maxLat, 2)} g, ${fmt(peakAt, 1)} s into the ramp`);
}

console.log("\n== Brakes, fuel and aids from the car's data");
{
  const pads = [0, 300, 450, 600, 800].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
  check('pad friction 0.70 / 0.80 / 1.00 / 1.00 / 0.80 at 0 / 300 / 450 / 600 / 800 °C', [0.7, 0.8, 1, 1, 0.8].every((v, i) => Math.abs(pads[i] - v) < 1e-9), pads.map((v) => fmt(v)).join(' / '));
  const garage = evaluateBrakePadMuFactor(C.brakes.garageDiscTempC ?? NaN, 'endurance-steel', 0, C.brakes.padMuCurve);
  check('out of the garage on full realism the discs are at 35 °C: 71 % brakes', Math.abs(garage - 0.712) < 0.005, `${fmt(garage, 3)}`);
  const dials = PORSCHE_934_RSR_SIM_PROFILE.assistDials!;
  const E = PORSCHE_934_RSR_SIM_PROFILE.electronics!;
  check('pro: no ABS, no TC; semi-pro: the ABS at 20 %; assisted adds a TC', dials.pro.absLevel === 0 && dials.pro.tcLevel === 0 && dials.semi_pro.tcLevel === 0 &&
    E.absLevels[12 - dials.semi_pro.absLevel] === 0.2 && dials.assisted.tcLevel > 0, '');
  // The fuel-flow model, burning (the game's sprints run on a fixed load, `SimRealismFlags.fuelUse`)
  const sim = createPorsche934RsrSim(pad);
  sim.setSimRealism({ ...SIM_REALISM_FLAGS.full, fuelUse: true });
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  let expected = 0;
  for (let t = 0; t < 30; t += DT) {
    sim.step(DT, { throttle: 1 });
    expected += (sim.telemetry.rpm / 1000) * PORSCHE_934_RSR_SIM_PROFILE.fuelLPerS1000Rpm! * 0.74 * DT;
  }
  const burnt = f0 - sim.telemetry.fuelKg;
  check("30 s flat out burns what CONSUMPTION gives at the engine's speed", Math.abs(burnt / expected - 1) < 0.05, `${fmt(burnt, 3)} kg vs ${fmt(expected, 3)} kg`);
}

console.log('\n== Gear changes');
{
  const u = measureUpshift((t) => createPorsche934RsrSim(t), 90);
  check('an up-shift on a light pedal: the drive goes, then comes back without a slide', u.to === u.from + 1 && u.gMin < u.gBefore - 0.03 && u.slipPeak < 0.15,
    `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
  const d = measureDownshift((t) => createPorsche934RsrSim(t), 150, 3, 0.5);
  check('a down-shift on the brakes: no wheel slips past 8 %, the car not tugged 0.25 g harder', d.to === d.from - 1 && d.slipPeak < 0.08 && d.gMin > d.gBefore - 0.25,
    `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
}

console.log('\n== Ported body and liveries');
{
  const glb = 'public/cars/porsche-934-rsr/model/porsche-934-rsr.glb';
  if (!hasFile(glb)) {
    noteSkip('934 ported body', glb);
  } else {
    const buf = readFileSync(glb);
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
      nodes: { name: string; extras?: Record<string, unknown> }[];
    };
    const byName = new Map(json.nodes.map((n) => [n.name, n]));
    const extras = byName.get('CAR')?.extras as { wheelbaseM?: number; tyreRadius?: Record<string, number>; skinMaps?: Record<string, string> } | undefined;
    check('CAR / BODY / STEER / WHEEL_xx rig nodes', ['CAR', 'BODY', 'STEER', 'WHEEL_LF', 'WHEEL_RF', 'WHEEL_LR', 'WHEEL_RR'].every((n) => byName.has(n)), '');
    if (extras?.wheelbaseM !== undefined && extras.tyreRadius) {
      check("wheelbase and tyre radii near the physics' (2.296 m, 0.299 / 0.310 m)", Math.abs(extras.wheelbaseM - C.chassis.wheelbase) < 0.01 && Math.abs(extras.tyreRadius.LF - RF) < 0.01 && Math.abs(extras.tyreRadius.LR - RR) < 0.01,
        `${fmt(extras.wheelbaseM, 3)} m, front ${fmt(extras.tyreRadius.LF, 3)}, rear ${fmt(extras.tyreRadius.LR, 3)} m`);
    }
    // Every livery's files are beside the model, the first livery (the one the model is painted in) needs none
    const missing = PORSCHE_934_RSR_SKINS.flatMap((s) => (s.files ?? []).map((f) => `public/cars/porsche-934-rsr/skins/${s.id}/${f}`)).filter((f) => !hasFile(f));
    check(`34 liveries, the first in the model's own paint, every other one's files present`, PORSCHE_934_RSR_SKINS.length === 34 && (PORSCHE_934_RSR_SKINS[0].files ?? []).length === 0 && missing.length === 0,
      missing.length ? `missing ${missing.slice(0, 3).join(', ')}` : `${PORSCHE_934_RSR_SKINS.reduce((n, s) => n + (s.files ?? []).length, 0)} files`);
  }
}

console.log('\n== Autopilot round Rwanda against the GT3');
{
  const track = getActiveTrackData();
  const glb = 'public/tracks/rwanda_official/rwanda_official.glb';
  if (!hasFile(glb)) {
    noteSkip('934 Rwanda laps', glb);
  } else {
    const root = loadGlbGeometry(glb);
    const lap = (sim: F12026CarSim, laps = 2) => {
      sim.resetToStartGrid(true);
      sim.aiAutopilot = true;
      sim.aiPaceScale = 1;
      const lap0 = sim.telemetry.lapCount;
      let t = 0;
      // Per lap: the opening lap's tyres are still cold (the slicks have 74–80 % of their grip under 40 °C), and the
      // autopilot plans on warm ones
      const beyond = [-Infinity, -Infinity, -Infinity];
      const tyres: number[][] = [];
      const discs = [0, 0, 0, 0];
      let maxSlip = 0;
      let bestS = Infinity;
      while (t < 200 * laps && sim.telemetry.lapCount < lap0 + laps) {
        const before = sim.telemetry.lapCount;
        sim.step(1 / 60, {});
        t += 1 / 60;
        const i = Math.min(2, sim.telemetry.lapCount - lap0);
        beyond[i] = Math.max(beyond[i], Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
        maxSlip = Math.max(maxSlip, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, sim.vxMs))) * 180) / Math.PI);
        if (sim.telemetry.lapCount - lap0 === laps - 1) sim.telemetry.brakeTempsC.forEach((c, k) => (discs[k] = Math.max(discs[k], c)));
        if (sim.telemetry.lapCount !== before) {
          tyres.push([...sim.telemetry.tireTempsC]);
          if (sim.telemetry.lapCount - lap0 > 1) bestS = Math.min(bestS, (sim.telemetry.lastLapTimeMs ?? Infinity) / 1000);
        }
      }
      return { done: sim.telemetry.lapCount === lap0 + laps, lapS: bestS, beyond, maxSlip, top: sim.telemetry.allTimeTopSpeedKmh, tyres, discs };
    };
    const m = lap(createPorsche934RsrSim(track, root), 3);
    // It slides on the way into the corners: off the throttle in second at 140–170 km/h, 60 % of the weight at the back
    // and the engine's overrun on the rears step the tail out (up to ≈ 14°), and it catches it on the road
    check('flying laps complete in 135–150 s, CG within 0.5 m of the edge', m.done && m.lapS > 135 && m.lapS < 150 && Math.max(m.beyond[1], m.beyond[2]) <= 0.5 && m.beyond[0] <= 1 && m.maxSlip < 16,
      `best ${fmt(m.lapS, 2)} s, top ${fmt(m.top, 0)} km/h, CG ${fmt(Math.max(0, m.beyond[1], m.beyond[2]), 2)} m past the edge (opening lap on cold tyres ${fmt(Math.max(0, m.beyond[0]), 2)}), max body slip ${fmt(m.maxSlip, 1)}°`);
    // Out of the pit lane's 20 °C the slicks and the discs reach the windows the data's grip curves are made for: the
    // slicks full from 80 °C (83 % below 58), the pads from 450 °C (79 % at 250)
    const t3 = m.tyres[2] ?? [0, 0, 0, 0];
    check('third lap: slicks at 56 °C or more front, 64 °C rear (on the step to 94 %, full at 80 °C)', Math.min(t3[0], t3[1]) >= 56 && Math.min(t3[2], t3[3]) >= 64,
      `tyres by lap ${m.tyres.map((q) => q.join('/')).join(' → ')} °C`);
    check('third lap: discs reach 450 °C front and 350 °C rear under braking', Math.min(m.discs[0], m.discs[1]) >= 450 && Math.min(m.discs[2], m.discs[3]) >= 350, `peak ${m.discs.join(' / ')} °C`);
    const gt3 = lap(createAmgGt3Sim(track, root));
    console.log(`      the GT3 on the same autopilot: ${fmt(gt3.lapS, 2)} s, top ${fmt(gt3.top, 0)} km/h`);
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll Porsche 934 Turbo RSR checks passed.');
process.exit(failures.length ? 1 : 0);
