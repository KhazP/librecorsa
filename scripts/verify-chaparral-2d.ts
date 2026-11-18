/**
 * Headless checks for the Chaparral 2Ds (`src/lib/sim/classic/Chaparral2d*`): the f12026-car vehicle model on the data
 * of NPanic's Assetto Corsa cars (physics by Bazza), mid-engined, rear-driven sports prototypes of 1966 (327 V8, two
 * speeds) and 1967 (427 V8, three speeds), each on a torque converter.
 *
 *   npx tsx scripts/verify-chaparral-2d.ts
 *
 * Per car: the config, the engine, at rest, the suspension geometry, the aero against speed, the converter's launch,
 * straight line, braking and cornering on flat ground, the driver aids, the gear changes, the livery parts of the
 * ported body (when this copy has it), then autopilot laps of Rwanda against the GT3's. The ranges are what the mod's
 * data gives in Assetto Corsa terms (its tables, gearing, brake torque and tyre data), not tuned to these numbers.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { getActiveTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import type { CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { CHAPARRAL_2D_67_CONFIG, CHAPARRAL_2D_CONFIG, CHAPARRAL_AERO_KIT_DEG } from '../src/lib/sim/classic/Chaparral2dConfig';
import {
  CHAPARRAL_2D_67_PROFILE_CAR,
  CHAPARRAL_2D_67_SIM_PROFILE,
  CHAPARRAL_2D_PROFILE_CAR,
  CHAPARRAL_2D_SIM_PROFILE,
  createChaparral2d67Sim,
  createChaparral2dSim,
} from '../src/lib/sim/classic/Chaparral2dSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { F12026CarSim, CarSimProfile } from '../src/lib/sim/f12026-car/F12026CarSim';
import type { SpeedProfileCarModel } from '../src/lib/sim/speed-profile';
import type { BuiltTrackData } from '../src/lib/track-data';
import { buildDoubleWishboneHardpoints, solveCornerKinematics3D } from '../src/lib/sim/suspension-kinematics';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { measureDownshift, measureUpshift } from './lib/upshift-test';
import { evaluateBrakePadMuFactor } from '../src/lib/sim/brake-physics';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { hasFile, noteSkip } from './lib/hosted-files';
import { CHAPARRAL_2D_67_SKINS, CHAPARRAL_2D_SKINS } from '../src/lib/cars/chaparral-skins';

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

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, stop?: (car: VehiclePhysics, t: number) => boolean): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, drive(car, t));
    t += DT;
    if (stop?.(car, t)) break;
  }
  return t;
}

interface CarCase {
  label: string;
  id: 'chaparral-2d' | 'chaparral-2d-67';
  C: CarPhysicsConfig;
  profile: CarSimProfile;
  plan: SpeedProfileCarModel;
  make: (track: BuiltTrackData, root?: THREE.Object3D | null) => F12026CarSim;
  gears: number;
  /** Peak wheel torque (Nm) and its rpm [spec power.lut] */
  peak: [number, number];
  /** Static ride at the pickups (m) [derived from the data] */
  ride: [number, number];
  /** 0–100 km/h (s), the pedal at `launch` to 90 km/h and flat out from there */
  t100: [number, number];
  launch: number;
  /** Peak lateral g at 100 and 200 km/h */
  lat100: [number, number];
  lat200: [number, number];
  /** Rwanda autopilot lap (s), and how far past the edge its CG may run on the flying lap (m) */
  lap: [number, number];
  edgeM: number;
  skins: readonly { id: string; variant?: string }[];
}

const CARS: CarCase[] = [
  {
    label: '2D 1966',
    id: 'chaparral-2d',
    C: CHAPARRAL_2D_CONFIG,
    profile: CHAPARRAL_2D_SIM_PROFILE,
    plan: CHAPARRAL_2D_PROFILE_CAR,
    make: createChaparral2dSim,
    gears: 2,
    peak: [421, 5250],
    ride: [0.1316, 0.1658],
    t100: [4.0, 5.5],
    launch: 1,
    lat100: [1.05, 1.4],
    lat200: [0.95, 1.35],
    lap: [130, 155],
    edgeM: 0.5,
    skins: CHAPARRAL_2D_SKINS,
  },
  {
    label: '2D 1967',
    id: 'chaparral-2d-67',
    C: CHAPARRAL_2D_67_CONFIG,
    profile: CHAPARRAL_2D_67_SIM_PROFILE,
    plan: CHAPARRAL_2D_67_PROFILE_CAR,
    make: createChaparral2d67Sim,
    gears: 3,
    peak: [504, 4500],
    ride: [0.1323, 0.1534],
    // Flat out from rest the 427 spins its rears in first (checked below); a driver feeds it in
    t100: [4.6, 6.0],
    launch: 0.85,
    lat100: [1.0, 1.4],
    lat200: [0.95, 1.35],
    lap: [128, 155],
    // It runs out ≈ 0.85 m on the power out of two first-gear corners (s ≈ 970 and 4370 m), on the old tyre model and
    // the three-layer one alike: the autopilot's exit plan takes a mid-gear traction figure, and the 427 in first has
    // more than that to give. The bound leaves room for a power slide's spread from run to run
    edgeM: 1.0,
    skins: CHAPARRAL_2D_67_SKINS,
  },
];

const pad = createFlatTestTrack(30_000, 3000);

for (const K of CARS) {
  const { C, label } = K;
  const MASS = C.chassis.totalMassKg;
  const tyres = C.tyreCompounds[C.compoundSlots.soft]!;
  const RF = tyres.front.radius;
  const RR = tyres.rear.radius;
  const crankNm = (rpm: number) => (lerp(C.engine.powerCurve, rpm) * 1000 * 30) / (Math.PI * rpm);
  const makeCar = () => new VehiclePhysics({ ground: flat, config: C, airDensity: RHO });
  /** The aero the data gives with the elements at their set angles (no ground-height tables on this car) */
  const expectedAero = () => {
    let clA = 0;
    let cdA = C.aero.drag;
    for (const w of C.aero.wings) {
      clA += w.area * lerp(w.lutAOA_CL, w.angleDeg);
      cdA += w.area * lerp(w.lutAOA_CD, w.angleDeg);
    }
    return { clA, cdA };
  };

  console.log(`\n==== ${label}`);
  console.log('\n== Config');
  {
    check(`${label}: rear-wheel drive, ${K.gears} gears, 6800 rpm limiter, no turbo`, !('drivenAxle' in C) && C.gearbox.ratios.length === K.gears && C.gearbox.gears.redline_rpm === 6800 && !('turbo' in C.engine) && !K.profile.turbo, '');
    check(`${label}: no hybrid, DRS or brake-by-wire; no heave springs`, C.ers.ERS_MAX_DEPLOY === 0 && C.brakes.brakeByWire === false && C.suspensions.front.heave.rate === 0 && C.suspensions.rear.heave.rate === 0, '');
    check(`${label}: the converter takes up the drive from 1150 to 6700 rpm`, C.clutch.biteRpm === 1150 && C.clutch.lockRpm === 6700 && C.clutch.maxTorqueNm === 1200, '');
    const car = makeCar();
    check(`${label}: the engine drives the rear wheels`, car.drivenWheels[0] === 2 && car.drivenWheels[1] === 3, `wheels ${car.drivenWheels.join(', ')}`);
  }

  console.log('\n== Engine');
  {
    const [nm, rpm] = K.peak;
    const wheel = crankNm(rpm) * 0.92;
    check(`${label}: ${nm} Nm at the wheels at ${rpm} rpm [power.lut]`, Math.abs(wheel - nm) < 0.5, `${fmt(wheel, 1)} Nm`);
    const kw = Math.max(...C.engine.powerCurve.filter(([r]) => r <= 6800).map(([, p]) => p));
    console.log(`      peak crank power under the limiter ${fmt(kw, 0)} kW (${fmt(kw * 1.341, 0)} hp), ${fmt(kw * 0.92, 0)} kW at the wheels`);
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
    check(`${label}: the weight split the data gives`, Math.abs(front - hubFront) < 0.006 && Math.abs(total - MASS * 9.81) < 5, `${fmt(front * 100, 1)} % front (${fmt(hubFront * 100, 1)} % from the data)`);
    check(`${label}: rides at the data's pickup heights`, Math.abs(t.aeroHeightFront - K.ride[0]) < 0.005 && Math.abs(t.aeroHeightRear - K.ride[1]) < 0.005,
      `${fmt(t.aeroHeightFront * 1000, 1)} / ${fmt(t.aeroHeightRear * 1000, 1)} mm (data ${fmt(K.ride[0] * 1000, 1)} / ${fmt(K.ride[1] * 1000, 1)})`);
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
      check(`${label} ${front ? 'front' : 'rear'}: the hardpoints give the config's camber gain and roll centre`, Math.abs(gain - spec.camberGainKinematic) < 1 && Math.abs(rc - spec.rollCentreHeight) < 0.003,
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
    const e = expectedAero();
    for (const kmh of [120, 250]) {
      const m = at(kmh);
      // The elements read one-point or setup-position tables: the body's rake moves them little
      check(`${label}: at ${kmh} km/h the body's lift and drag are the tables'`, Math.abs(m.clA - e.clA) < 0.02 && Math.abs(m.cdA / e.cdA - 1) < 0.04,
        `CL·A ${fmt(m.clA, 3)} (${fmt(e.clA, 3)}) CD·A ${fmt(m.cdA, 3)} (${fmt(e.cdA, 3)}) at ${fmt(m.front * 1000, 0)} / ${fmt(m.rear * 1000, 0)} mm`);
    }
    // The body lifts: a 1960s shape, before wings
    check(`${label}: the body lifts at rest settings (CL·A < 0), CD·A 0.55–0.65 m²`, e.clA < 0 && e.cdA > 0.55 && e.cdA < 0.65, `CL·A ${fmt(e.clA, 3)} m², CD·A ${fmt(e.cdA, 3)} m²`);
    // The high-downforce package moves the kit to 50: more downforce, more drag
    const sim = K.make(pad);
    sim.aeroPreset = 'high_downforce';
    let clKit = 0;
    let cdKit = C.aero.drag;
    for (const w of (sim as unknown as { config: CarPhysicsConfig }).config.aero.wings) {
      clKit += w.area * lerp(w.lutAOA_CL, w.angleDeg);
      cdKit += w.area * lerp(w.lutAOA_CD, w.angleDeg);
    }
    check(`${label}: the high-downforce package fits the aero kit (${CHAPARRAL_AERO_KIT_DEG})`, clKit > e.clA + 0.05 && cdKit > e.cdA, `CL·A ${fmt(clKit, 3)} m², CD·A ${fmt(cdKit, 3)} m²`);
  }

  console.log('\n== Converter launch and straight line through the adapter');
  {
    const sim = K.make(pad);
    sim.assistPreset = 'pro';
    sim.teleportToDistance(1000, 0);
    let t100 = NaN;
    let t200 = NaN;
    let vmax = 0;
    let slipRpm = 0;
    for (let t = 0; t < 60; t += DT) {
      sim.step(DT, { throttle: sim.telemetry.speedKmh < 90 ? K.launch : 1 });
      const v = sim.telemetry.speedKmh;
      vmax = Math.max(vmax, v);
      if (t > 0.5 && t < 1.0) slipRpm = Math.max(slipRpm, sim.telemetry.rpm);
      if (Number.isNaN(t100) && v >= 100) t100 = t;
      if (Number.isNaN(t200) && v >= 200) t200 = t;
    }
    // The converter lets the engine run up towards its stall speed before the drive locks up
    check(`${label}: flat out from rest the converter holds the engine near 3000–4500 rpm`, slipRpm > 2800 && slipRpm < 4800, `${fmt(slipRpm, 0)} rpm in the first second`);
    check(`${label}: 0-100 km/h ${K.t100[0]}–${K.t100[1]} s at ${K.launch * 100} % pedal to 90 km/h`, t100 > K.t100[0] && t100 < K.t100[1], `${fmt(t100)} s, 0-200 ${fmt(t200)} s`);
    if (K.launch < 1) {
      // 1st on the 2.70 final is 5.2:1: the 427's ≈ 500 Nm at the stall speed asks ≈ 7 kN of rears that hold ≈ 6.7
      const raw = K.make(pad);
      raw.assistPreset = 'pro';
      raw.teleportToDistance(1000, 0);
      let slip = 0;
      for (let t = 0; t < 4; t += DT) {
        raw.step(DT, { throttle: 1 });
        slip = Math.max(slip, ...raw.telemetry.wheelSlipRatios.slice(2));
      }
      check(`${label}: flat out from rest with no TC the rears light up`, slip > 0.5, `max rear slip ${fmt(slip)}`);
    }
    // Top gear at the limiter against the power the car has against its drag
    const top = C.gearbox.ratios.length - 1;
    const rTop = (rpm: number) => ((rpm * Math.PI) / 30 / (C.gearbox.ratios[top] * C.gearbox.finalDrive)) * RR;
    const e = expectedAero();
    let vDrag = 0;
    for (let v = 40; v < 120; v += 0.05) {
      const rpm = (v / RR) * C.gearbox.ratios[top] * C.gearbox.finalDrive * (30 / Math.PI);
      const pWheel = crankNm(Math.min(rpm, 6800)) * 0.92 * (rpm * Math.PI) / 30;
      const resist = 0.5 * RHO * e.cdA * v * v + 0.012 * (MASS * 9.81 - 0.5 * RHO * Math.abs(e.clA) * v * v);
      if (pWheel < resist * v || rpm > 6800) break;
      vDrag = v;
    }
    check(`${label}: top speed within 3 % of what gearing, power and drag give`, Math.abs(vmax / 3.6 / Math.min(vDrag, rTop(6800)) - 1) < 0.03,
      `${fmt(vmax, 1)} km/h vs limiter ${fmt(rTop(6800) * 3.6, 1)}, power and drag ${fmt(vDrag * 3.6, 0)}`);
  }

  console.log('\n== Braking through the adapter');
  {
    const stop = (preset: 'pro' | 'semi_pro') => {
      const sim = K.make(pad);
      sim.assistPreset = preset;
      sim.teleportToDistance(1000, 200 / 3.6);
      const s0 = sim.sMeters;
      let lock = 0;
      for (let t = 0; t < 12 && sim.telemetry.speedKmh > 1; t += DT) {
        sim.step(DT, { brake: 1 });
        if (sim.telemetry.speedKmh > 30) lock = Math.max(lock, -Math.min(...sim.telemetry.wheelSlipRatios));
      }
      return { dist: sim.sMeters - s0, lock };
    };
    const raw = stop('pro');
    const abs = stop('semi_pro');
    check(`${label}: 200→0 km/h stops; the ABS no longer than pedal alone`, abs.dist < raw.dist * 1.03 && abs.dist > 80 && abs.dist < 220,
      `${fmt(abs.dist, 1)} m with ABS, ${fmt(raw.dist, 1)} m without (max lock ${fmt(raw.lock)})`);
    const pm = K.plan;
    let planned = 0;
    for (let v = 200 / 3.6; v > 1; v -= 0.05) {
      const grip = pm.muLong * Math.max(0.2, 9.81 + (pm.downforceCoef * v * v) / pm.massKg);
      const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
      planned += (v * 0.05) / decel;
    }
    check(`${label}: the braking line never plans shorter than the car stops`, planned >= abs.dist * 0.97, `${fmt(planned, 1)} m planned vs ${fmt(abs.dist, 1)} m stopped`);
  }

  console.log('\n== Trail braking in a fast corner');
  {
    // Settled at 0.7 g and 180 km/h on the default tune, then the brake with the wheel held where it was. At the data's
    // 56 % bias and full engine braking both cars spun from half the pedal. The 1967 still lets go at a quarter of the
    // pedal held like this: its rears, carrying 60 % of the weight, give up first as the car turns in towards 1 g
    const trail = (brake: number) => {
      const sim = K.make(pad);
      sim.assistPreset = 'pro';
      sim.teleportToDistance(1000, 180 / 3.6);
      let integ = 0;
      let steer = 0;
      let pedal = 0.3;
      for (let t = 0; t < 12; t += DT) {
        const err = 180 - sim.telemetry.speedKmh;
        integ = Math.max(-20, Math.min(20, integ + err * DT));
        pedal = Math.min(1, Math.max(0, 0.25 + 0.04 * err + 0.03 * integ));
        steer = Math.min(0.6, Math.max(0, steer + 0.08 * DT * (0.7 - Math.abs(sim.telemetry.lateralG)) * Math.min(1, t / 2 + 0.2)));
        sim.step(DT, { throttle: pedal, analogSteer: steer });
      }
      const lat = Math.abs(sim.telemetry.lateralG);
      let slip = 0;
      for (let t = 0; t < 2.5 && sim.telemetry.speedKmh > 40; t += DT) {
        sim.step(DT, { brake, analogSteer: steer });
        slip = Math.max(slip, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, sim.vxMs))) * 180) / Math.PI);
      }
      return { lat, slip };
    };
    for (const brake of label.includes('1966') ? [0.25, 0.5] : [0.5]) {
      const r = trail(brake);
      check(`${label}: ${brake * 100} % pedal at 0.7 g and 180 km/h, the wheel held: the car slides under 8°`, Math.abs(r.lat - 0.7) < 0.08 && r.slip < 8,
        `${fmt(r.lat)} g before the brake, ${fmt(r.slip, 1)}° at most`);
    }
  }

  console.log('\n== Cornering (flat, steer ramp at constant speed)');
  for (const [kmh, [lo, hi]] of [
    [100, K.lat100],
    [200, K.lat200],
  ] as const) {
    const car = makeCar();
    car.reset(0, 0, 0, kmh / 3.6);
    let maxLat = 0;
    let pedal = 0.3;
    run(car, 12, (c, t) => {
      pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
      return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 12) * 0.6 };
    }, (c) => {
      maxLat = Math.max(maxLat, Math.abs(c.telemetry.latG));
      const beta = Math.atan2(c.velocity.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)), c.velocity.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion)));
      return Math.abs(beta) > 0.35;
    });
    check(`${label}: peak lateral at ${kmh} km/h ${lo}–${hi} g`, maxLat > lo && maxLat < hi, `${fmt(maxLat, 2)} g`);
  }

  console.log("\n== Brakes, fuel and aids from the car's data");
  {
    const pads = [0, 400, 600, 800].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
    check(`${label}: pad friction 0.70 / 1.00 / 1.00 / 0.70 at 0 / 400 / 600 / 800 °C`, [0.7, 1, 1, 0.7].every((v, i) => Math.abs(pads[i] - v) < 1e-9), pads.map((v) => fmt(v)).join(' / '));
    const dials = K.profile.assistDials!;
    const E = K.profile.electronics!;
    check(`${label}: pro: no ABS, no TC; semi-pro: the ABS at 13 %; assisted adds a TC`, dials.pro.absLevel === 0 && dials.pro.tcLevel === 0 && dials.semi_pro.tcLevel === 0 &&
      E.absLevels[12 - dials.semi_pro.absLevel] === 0.13 && dials.assisted.tcLevel > 0, '');
    // The fuel-flow model, burning (the game's sprints run on a fixed load, `SimRealismFlags.fuelUse`)
    const sim = K.make(pad);
    sim.setSimRealism({ ...SIM_REALISM_FLAGS.full, fuelUse: true });
    sim.assistPreset = 'semi_pro';
    sim.teleportToDistance(1000, 0);
    const f0 = sim.telemetry.fuelKg;
    let expected = 0;
    for (let t = 0; t < 30; t += DT) {
      sim.step(DT, { throttle: 1 });
      expected += (sim.telemetry.rpm / 1000) * K.profile.fuelLPerS1000Rpm! * 0.74 * DT;
    }
    const burnt = f0 - sim.telemetry.fuelKg;
    check(`${label}: 30 s flat out burns what CONSUMPTION gives at the engine's speed`, Math.abs(burnt / expected - 1) < 0.05, `${fmt(burnt, 3)} kg vs ${fmt(expected, 3)} kg`);
  }

  console.log('\n== Gear changes');
  {
    const u = measureUpshift((t) => K.make(t), 90);
    check(`${label}: an up-shift on a light pedal: the drive goes, then comes back without a slide`, u.to === u.from + 1 && u.gMin < u.gBefore - 0.03 && u.slipPeak < 0.15,
      `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
    const d = measureDownshift((t) => K.make(t), 150, K.gears, 0.5);
    check(`${label}: a down-shift on the brakes: no wheel slips past 8 %, the car not tugged 0.25 g harder`, d.to === d.from - 1 && d.slipPeak < 0.08 && d.gMin > d.gBefore - 0.25,
      `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
  }

  console.log('\n== Ported body');
  {
    const glb = `public/cars/${K.id}/model/${K.id}.glb`;
    if (!hasFile(glb)) {
      noteSkip(`${label} ported body`, glb);
    } else {
      const buf = readFileSync(glb);
      const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
        nodes: { name: string; extras?: Record<string, unknown> }[];
      };
      const byName = new Map(json.nodes.map((n) => [n.name, n]));
      const extras = byName.get('CAR')?.extras as { wheelbaseM?: number; tyreRadius?: Record<string, number>; partVariants?: Record<string, string[]> } | undefined;
      check(`${label}: CAR / BODY / STEER / WHEEL_xx rig nodes`, ['CAR', 'BODY', 'STEER', 'WHEEL_LF', 'WHEEL_RF', 'WHEEL_LR', 'WHEEL_RR'].every((n) => byName.has(n)), '');
      if (extras?.wheelbaseM !== undefined && extras.tyreRadius) {
        // The model's wheels stand 1.5 cm shorter in wheelbase than the data's, and its tyres within 1 cm of the data's
        check(`${label}: wheelbase and tyre radii near the physics' (2.311 m, 0.325 / 0.335 m)`, Math.abs(extras.wheelbaseM - C.chassis.wheelbase) < 0.02 && Math.abs(extras.tyreRadius.LF - RF) < 0.01 && Math.abs(extras.tyreRadius.LR - RR) < 0.012,
          `${fmt(extras.wheelbaseM, 3)} m, front ${fmt(extras.tyreRadius.LF, 3)}, rear ${fmt(extras.tyreRadius.LR, 3)} m`);
      }
      // Every livery's variant shows at least one part and the first livery wears the base parts
      const pv = extras?.partVariants ?? {};
      const variants = new Set(K.skins.map((s) => s.variant ?? 'base'));
      check(`${label}: each livery's parts are in the model, the first livery on the base`, K.skins[0].variant === undefined &&
        [...variants].every((v) => Object.values(pv).some((vs) => vs.includes(v))) && Object.keys(pv).every((n) => byName.has(n)),
        `${Object.keys(pv).length} parts for ${[...variants].join(', ')}`);
    }
  }

  console.log('\n== Autopilot round Rwanda against the GT3');
  {
    const track = getActiveTrackData();
    const glb = 'public/tracks/rwanda_official/rwanda_official.glb';
    if (!hasFile(glb)) {
      noteSkip(`${label} Rwanda laps`, glb);
    } else {
      const root = loadGlbGeometry(glb);
      const lap = (sim: F12026CarSim) => {
        sim.resetToStartGrid(true);
        sim.aiAutopilot = true;
        sim.aiPaceScale = 1;
        const lap0 = sim.telemetry.lapCount;
        let t = 0;
        // Per lap: the opening lap's tyres are still under the data's 40 °C window (80–90 % of their grip), and the
        // autopilot plans on warm ones
        const beyond = [-Infinity, -Infinity];
        let maxSlip = 0;
        while (t < 400 && sim.telemetry.lapCount < lap0 + 2) {
          sim.step(1 / 60, {});
          t += 1 / 60;
          const i = sim.telemetry.lapCount - lap0;
          beyond[i] = Math.max(beyond[i], Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
          maxSlip = Math.max(maxSlip, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, sim.vxMs))) * 180) / Math.PI);
        }
        return { done: sim.telemetry.lapCount === lap0 + 2, lapS: (sim.telemetry.lastLapTimeMs ?? 0) / 1000, beyond, maxSlip, top: sim.telemetry.allTimeTopSpeedKmh };
      };
      const m = lap(K.make(track, root));
      check(`${label}: flying lap completes in ${K.lap[0]}–${K.lap[1]} s, CG within ${K.edgeM} m of the edge`, m.done && m.lapS > K.lap[0] && m.lapS < K.lap[1] && m.beyond[1] <= K.edgeM && m.beyond[0] <= 1 && m.maxSlip < 12,
        `lap ${fmt(m.lapS, 2)} s, top ${fmt(m.top, 0)} km/h, CG ${fmt(Math.max(0, m.beyond[1]), 2)} m past the edge (opening lap on cold tyres ${fmt(Math.max(0, m.beyond[0]), 2)}), max body slip ${fmt(m.maxSlip, 1)}°`);
      if (K.id === 'chaparral-2d') {
        const gt3 = lap(createAmgGt3Sim(track, root));
        console.log(`      the GT3 on the same autopilot: ${fmt(gt3.lapS, 2)} s, top ${fmt(gt3.top, 0)} km/h`);
      }
    }
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll Chaparral 2D checks passed.');
if (failures.length) process.exitCode = 1;
