/**
 * Headless checks for the MTRacing 496R (`src/lib/sim/proto`): the f12026-car vehicle model on munyuturbo's Assetto
 * Corsa data, a rear-driven prototype with ground-effect aero.
 *
 *   npx tsx scripts/verify-mtr-496r.ts
 *
 * At rest, the aero map against speed, straight line, braking and cornering on flat ground, the driver aids through the
 * simulator adapter, the ported body (when this copy has it), then autopilot laps of Rwanda against the GT3's. The
 * ranges are what the mod's data gives in Assetto Corsa terms (its wing tables, its gearing, the GT3's grip below it),
 * not tuned to these numbers.
 */
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { MTR_496R_CONFIG } from '../src/lib/sim/proto/Mtr496rConfig';
import { MTR_496R_PROFILE_CAR, createMtr496rSim } from '../src/lib/sim/proto/Mtr496rSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { carById } from '../src/lib/cars/car-registry';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { downshiftTakenAt, measureDownshift, measureUpshift } from './lib/upshift-test';
import { evaluateBrakePadMuFactor } from '../src/lib/sim/brake-physics';
import { DEFAULT_CHASSIS_SETUP } from '../src/lib/sim/car-setup';
import { hasFile, noteSkip } from './lib/hosted-files';
import { readFileSync } from 'node:fs';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const C = MTR_496R_CONFIG;

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

console.log('\n== 496R config');
{
  check('Rear-wheel drive, six gears, 10 000 rpm limiter', !('drivenAxle' in C) && C.gearbox.ratios.length === 6 && C.gearbox.gears.redline_rpm === 10_000, '');
  check('No hybrid or brake-by-wire; splitter, diffuser and rear wing', C.ers.ERS_MAX_DEPLOY === 0 && C.brakes.brakeByWire === false && C.aero.wings.length === 3, '');
  check('Heave springs on both axles', C.suspensions.front.heave.rate > 0 && C.suspensions.rear.heave.rate > 0, '');
  const car = makeCar();
  check('The engine drives the rear wheels', car.drivenWheels[0] === 2 && car.drivenWheels[1] === 3, `wheels ${car.drivenWheels.join(', ')}`);
}

console.log('\n== At rest');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  run(car, 3, () => ({ throttle: 0, brake: 1, steer: 0 }));
  const t = car.telemetry;
  const fz = car.wheels.map((w) => w.fz);
  const front = (fz[0] + fz[1]) / fz.reduce((a, b) => a + b, 0);
  check('Front axle carries ≈ 48.5 % of the weight', Math.abs(front - 0.485) < 0.01, `${fmt(front * 100, 1)} %`);
  // The pickups 0.181 / 0.170 m under the CG's level, the body 0.245 / 0.255 m up at the axles: 64 / 85 mm
  check('Rides at the mod\'s 64 / 85 mm', Math.abs(t.aeroHeightFront - 0.064) < 0.004 && Math.abs(t.aeroHeightRear - 0.085) < 0.004,
    `${fmt(t.aeroHeightFront * 1000, 1)} / ${fmt(t.aeroHeightRear * 1000, 1)} mm`);
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
    const q = 0.5 * 1.225 * (kmh / 3.6) ** 2;
    // The front tyres' free radius: the rolling radius with the third of the deflection it gives up put back
    const freeRadius = 0.5 * (car.wheels[0].rollingRadius + car.wheels[0].deflection / 3 + car.wheels[1].rollingRadius + car.wheels[1].deflection / 3);
    return { clA: t.downforceN / q, cdA: t.dragN / q, bal: t.AERO_BALANCE, front: t.aeroHeightFront, rear: t.aeroHeightRear, freeRadius, omega: car.wheels[0].omega };
  };
  const slow = at(100);
  const fast = at(300);
  // Splitter, rear wing and a diffuser that works from rest at this ride height (its table peaks at 35–60 mm)
  check('CL·A 3.1–3.6 m² from 100 to 300 km/h', slow.clA > 3.1 && slow.clA < 3.6 && fast.clA > 3.1 && fast.clA < 3.6,
    `${fmt(slow.clA)} m² at 100, ${fmt(fast.clA)} m² at 300 km/h`);
  check('CD·A 1.1–1.3 m²', slow.cdA > 1.1 && slow.cdA < 1.3 && fast.cdA > 1.1 && fast.cdA < 1.3, `${fmt(slow.cdA)} / ${fmt(fast.cdA)} m²`);
  // The front wing ahead of the front axle, the rear wing behind the rear: 40–42 % on the front
  check('Aero balance 38–44 % front', slow.bal > 38 && slow.bal < 44 && fast.bal > 38 && fast.bal < 44, `${fmt(slow.bal, 1)} / ${fmt(fast.bal, 1)} %`);
  check('Floor clear of the ground at 300 km/h', Math.min(fast.front, fast.rear) > 0.04, `${fmt(fast.front * 1000, 0)} / ${fmt(fast.rear * 1000, 0)} mm`);
  // 0.025 mm of radius per rad/s of spin: 2 mm at 100 km/h, 6 mm at 300
  const grown = (fast.freeRadius - 0.34) * 1000;
  check('Front tyres grow 6 mm by 300 km/h', Math.abs(grown - 0.025 * fast.omega) < 0.2 && grown > 5.5 && grown < 6.5 && (slow.freeRadius - 0.34) * 1000 < 2.3,
    `${fmt((slow.freeRadius - 0.34) * 1000, 1)} mm at 100, ${fmt(grown, 1)} mm at 300 km/h (${fmt(fast.omega, 0)} rad/s)`);
}

const pad = createFlatTestTrack(30_000, 3000);

console.log('\n== Straight line through the adapter (its own TC)');
{
  const sim = createMtr496rSim(pad);
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  let t100 = NaN;
  let t200 = NaN;
  let vmax = 0;
  for (let t = 0; t < 45; t += DT) {
    sim.step(DT, { throttle: 1 });
    const v = sim.telemetry.speedKmh;
    vmax = Math.max(vmax, v);
    if (Number.isNaN(t100) && v >= 100) t100 = t;
    if (Number.isNaN(t200) && v >= 200) t200 = t;
  }
  // The mod quotes 3.7 s; its TC only works above 50 km/h, so a flat-out start spins the rears to there
  check('0-100 km/h 3.0–4.2 s on a flat-out start', t100 > 3.0 && t100 < 4.2, `${fmt(t100)} s, 0-200 ${fmt(t200)} s`);
  // 410 kW at the wheels against CD·A ≈ 1.18 m²; sixth runs to 338 km/h at the limiter
  check('Top speed 290–315 km/h', vmax > 290 && vmax < 315, `${fmt(vmax, 1)} km/h`);
}

console.log('\n== Braking through the adapter');
{
  const stop = (preset: 'pro' | 'semi_pro') => {
    const sim = createMtr496rSim(pad);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 200 / 3.6);
    const s0 = sim.sMeters;
    let lock = 0;
    for (let t = 0; t < 10 && sim.telemetry.speedKmh > 1; t += DT) {
      sim.step(DT, { brake: 1 });
      if (sim.telemetry.speedKmh > 30) lock = Math.max(lock, -Math.min(...sim.telemetry.wheelSlipRatios));
    }
    return { dist: sim.sMeters - s0, lock };
  };
  const abs = stop('semi_pro');
  const raw = stop('pro');
  // 5900 Nm brakes and no ABS of its own: a stamp locks the wheels; the semi-pro ABS holds them
  check('A stamp on 5900 Nm brakes locks the wheels without ABS', raw.lock > 0.5, `max lock ${fmt(raw.lock, 2)}, ${fmt(raw.dist, 0)} m`);
  check('Semi-pro ABS stops 200→0 km/h in under 100 m', abs.lock < 0.3 && abs.dist < 100 && abs.dist < raw.dist, `${fmt(abs.dist, 1)} m, max lock ${fmt(abs.lock, 2)}`);

  const pm = MTR_496R_PROFILE_CAR;
  let planned = 0;
  for (let v = 200 / 3.6; v > 1; v -= 0.05) {
    const grip = pm.muLong * (9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  // The stop above is on the tyres' starting (blanket) temperature, a little short of their window
  check('Braking line never plans shorter than the car stops', planned >= abs.dist * 0.9, `${fmt(planned, 1)} m planned vs ${fmt(abs.dist, 1)} m stopped`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed)');
// Slicks out of 60 °C blankets: the GT3 holds 1.6–1.9 g here; the 496R is 300 kg lighter with more downforce
for (const [kmh, lo, hi] of [
  [100, 1.8, 2.15],
  [200, 2.2, 2.65],
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
  // Aero balance 41 % front against 48.5 % of the weight: the fronts give first
  check(`Understeers at the limit at ${kmh} km/h`, frontSa > rearSa, `front ${fmt((frontSa * 180) / Math.PI, 1)}°, rear ${fmt((rearSa * 180) / Math.PI, 1)}° slip at the peak`);
}

console.log('\n== Tyres: wear, graining, pressure in the heat, flat spots');
{
  type Cfg = typeof C;
  const withTyres = (fn: (t: Cfg['tyreCompounds'][keyof Cfg['tyreCompounds']] & object) => object): Cfg =>
    ({ ...C, tyreCompounds: Object.fromEntries(Object.entries(C.tyreCompounds).map(([k, t]) => [k, t && fn(t)])) }) as Cfg;
  const at = (cfg: Cfg, kmh: number) => {
    const car = new VehiclePhysics({ ground: flat, config: cfg, airDensity: 1.225 });
    car.reset(0, 0, 0, kmh / 3.6);
    return car;
  };
  const soft = C.tyreCompounds[C.compoundSlots.soft]!;
  // Sliding wear counts the load per 2000 N [spec VIRTUALKM USE_LOAD]: the same hard corner wears 1.5 × what it would
  // counted per the tyre's 3000 N FZ0
  const cornerWear = (cfg: Cfg) => {
    const car = at(cfg, 120);
    run(car, 4, (_, t) => ({ throttle: 0.4, brake: 0, steer: 0.25 * Math.min(1, t) }));
    return car.wheels.reduce((sum, w) => sum + w.wear, 0);
  };
  const perFz0 = cornerWear(withTyres((t) => ({ ...t, wear: t.wear && { ...t.wear, loadRefN: undefined } })));
  const per2000 = cornerWear(C);
  check('Sliding wear counted per 2000 N of load', soft.wear?.loadScaled === true && soft.wear.loadRefN === 2000 && Math.abs(per2000 / perFz0 - 1.5) < 0.02,
    `${fmt(per2000 / perFz0, 3)} × the wear counted per FZ0`);

  // Graining wears off as the tread slides, not as it rolls: a grained, warm tyre on a straight keeps its graining
  {
    const car = at(C, 150);
    for (const w of car.wheels) {
      w.grainLevel = 0.3;
      w.bandTempsC.fill(95);
      w.bandCoreTempsC.fill(95);
    }
    run(car, 60, () => ({ throttle: 0.3, brake: 0, steer: 0 }));
    const lost = 0.3 - Math.min(...car.wheels.map((w) => w.grainLevel));
    check('A grained tyre keeps its graining over a minute of straight', soft.thermalData.tread?.wearOffWithSlip === true && lost < 2e-4,
      `${fmt(lost * 1e4, 2)}e-4 lost (rolling alone would take ≈ 8e-4)`);
  }

  // Pressure moves the heat: 4 psi under the set pressure runs the carcass hotter than 4 psi over (rolling heat by
  // PRESSURE_RR_GAIN, the sliding heat), and the over-inflated tread runs on its crown
  {
    const weave = (dp: number) => {
      const car = at(C, 150);
      for (const w of car.wheels) w.coldPressurePsi += dp;
      run(car, 60, (_, t) => ({ throttle: 0.3, brake: 0, steer: 0.04 * Math.sin(t * 0.8) }));
      const w = car.wheels[0];
      return { core: w.coreTempC, crown: w.bandTempsC[1] - 0.5 * (w.bandTempsC[0] + w.bandTempsC[2]) };
    };
    const low = weave(-4);
    const high = weave(4);
    check('An under-inflated tyre runs hotter, an over-inflated one on its crown', low.core - high.core > 1 && high.crown > low.crown,
      `carcass ${fmt(low.core, 1)} °C at −4 psi, ${fmt(high.core, 1)} °C at +4; crown over shoulders ${fmt(low.crown, 2)} / ${fmt(high.crown, 2)} °C`);
  }

  // Scrub drag stops growing at the peak slip [spec ROLLING_RESISTANCE_SLIP]
  check('Tyre scrub held at its peak-slip value past the peak', soft.modelData.rollingResistanceSlipMax === 1, '');

  // A softer compound flat-spots sooner: twice the softness, twice the flat after the same locked stop
  {
    const lockUp = (cfg: Cfg) => {
      const car = at(cfg, 150);
      run(car, 0.6, () => ({ throttle: 0, brake: 1, steer: 0 }));
      return car.wheels[0].flatSpotSeverity;
    };
    const base = lockUp(C);
    const softer = lockUp(withTyres((t) => ({ ...t, flatSpotSoftness: 2 })));
    check('Flat-spot softness scales the flat a lock-up grinds', base > 0.01 && Math.abs(softer / base - 2) < 0.1, `${fmt(base, 3)} → ${fmt(softer, 3)}`);
  }
}

console.log('\n== Traction control through the adapter');
{
  // At its mod's power the 496R no longer spins its slicks on a dry road at 70 km/h: on a damp one it does
  const damp = { waterMm: 0.3, wetness: wetnessFromWater(0.3), ambientC: 15, rain: 0.3 };
  const exit = (preset: 'pro' | 'semi_pro') => {
    const sim = createMtr496rSim(pad);
    sim.assistPreset = preset;
    sim.setWeatherSample(damp);
    sim.teleportToDistance(1000, 70 / 3.6);
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
  const tc = exit('semi_pro');
  const raw = exit('pro');
  // Above the TC's 50 km/h floor, its 9 % target in the second it works
  check('TC holds rear wheelspin above 50 km/h on a damp road', tc < 0.15 && tc < raw * 0.6, `mean rear slip ${fmt(tc, 2)} with TC, ${fmt(raw, 2)} without`);
}

console.log('\n== Brakes, fuel and steering from the car\'s data');
{
  // The pads' own curve, not the steel material's (full by ~100 °C, down to ≈ 0.6 by 900 °C)
  const pads = [0, 400, 900, 1200].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
  check('Pad friction 0.80 / 1.00 / 0.97 / 0.82 at 0 / 400 / 900 / 1200 °C', [0.8, 1, 0.97, 0.82].every((v, i) => Math.abs(pads[i] - v) < 1e-9),
    pads.map((v) => fmt(v)).join(' / '));
  const car = makeCar();
  car.reset(0, 0, 0);
  run(car, 0.5, () => ({ throttle: 0, brake: 0, steer: 0 }));
  // Discs start at 380 °C, a little short of the curve's 400 °C peak
  check('Fresh discs: pad friction 0.99 at 380 °C', Math.abs(car.wheels[0].brakeDisc.muFactor - 0.99) < 0.002, `${fmt(car.wheels[0].brakeDisc.muFactor, 3)}`);

  // Fuel flow follows the engine's speed: a constant 0.036 kg/s flat out burnt 1.12 kg here
  const sim = createMtr496rSim(pad);
  sim.assistPreset = 'semi_pro';
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  for (let t = 0; t < 30; t += DT) sim.step(DT, { throttle: 1 });
  const burnt = f0 - sim.telemetry.fuelKg;
  check('30 s flat out from rest burns 0.95–1.07 kg', burnt > 0.95 && burnt < 1.07, `${fmt(burnt, 3)} kg`);

  // The minimum 4 kg flat out: the tank runs dry and the engine stops firing, so the car coasts down
  const dry = createMtr496rSim(pad);
  dry.assistPreset = 'semi_pro';
  dry.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, fuelDeltaKg: -200 });
  dry.teleportToDistance(1000, 0);
  let tEmpty = NaN;
  let vEmpty = 0;
  for (let t = 0; t < 150 && !(t > tEmpty + 20); t += DT) {
    dry.step(DT, { throttle: 1 });
    if (Number.isNaN(tEmpty) && dry.telemetry.fuelKg <= 0) {
      tEmpty = t;
      vEmpty = dry.telemetry.speedKmh;
    }
  }
  const vLater = dry.telemetry.speedKmh;
  check('An empty tank: the car slows to under 60 % of its speed in 20 s', tEmpty > 90 && tEmpty < 125 && vLater < 0.6 * vEmpty && Number.isFinite(vLater),
    `dry after ${fmt(tEmpty, 1)} s at ${fmt(vEmpty, 0)} km/h, ${fmt(vLater, 0)} km/h 20 s later`);

  // A mouse or pad turns the rack no faster than hands turn the 240° of rim lock on its 14:1 rack (900°/s)
  const steer = createMtr496rSim(pad);
  steer.teleportToDistance(1000, 50 / 3.6);
  let tLock = NaN;
  for (let t = 0; t < 1 && Number.isNaN(tLock); t += DT / 4) {
    steer.step(DT / 4, { analogSteer: 1 });
    if (steer.steerAngleNorm >= 0.999) tLock = t + DT / 4;
  }
  check('Full lock from centre in 0.26–0.28 s (240° at 900°/s)', tLock > 0.26 && tLock < 0.28, `${fmt(tLock, 3)} s`);
}

console.log('\n== Ported body');
{
  const def = carById('mtr-496r');
  const glb = `public${def.modelUrl}`;
  if (!hasFile(glb)) {
    noteSkip('Ported body', glb);
  } else {
    const buf = readFileSync(glb);
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
      nodes: { name: string; mesh?: number; children?: number[]; extras?: Record<string, unknown> }[];
      meshes: { primitives: unknown[] }[];
    };
    const byName = new Map(json.nodes.map((n) => [n.name, n]));
    const corners = ['RF', 'LF', 'RR', 'LR'];
    check('CAR / BODY / STEER / WHEEL_xx rig nodes', ['CAR', 'BODY', 'STEER', ...corners.map((c) => `WHEEL_${c}`)].every((n) => byName.has(n)), '');
    check('Each tyre is one primitive (the tyre shader)', corners.every((c) => {
      const tyre = byName.get(`WHEEL_${c}_TYRE`);
      return tyre?.mesh !== undefined && json.meshes[tyre.mesh].primitives.length === 1;
    }), '');
    const extras = byName.get('CAR')?.extras as { wheelbaseM: number; cameras: Record<string, unknown>; tyreRadius: Record<string, number> };
    check('Wheelbase matches the physics (2.8 m)', Math.abs(extras.wheelbaseM - C.chassis.wheelbase) < 0.02, `${fmt(extras.wheelbaseM, 3)} m`);
    check('Tyre radii match the physics', Math.abs(extras.tyreRadius.LF - 0.34) < 0.005 && Math.abs(extras.tyreRadius.LR - 0.355) < 0.005,
      `front ${fmt(extras.tyreRadius.LF, 3)}, rear ${fmt(extras.tyreRadius.LR, 3)} m`);
    check('Cockpit, dash, bumper and roof cameras', ['cockpit', 'dash', 'bumper', 'tcam'].every((k) => k in extras.cameras), '');
    // The wheel's screen and its nine shift lights are STEER nodes of their own, with the mod's thresholds
    const steerKids = (byName.get('STEER')?.children ?? []).map((i) => json.nodes[i].name);
    const ledNodes = [...Array.from({ length: 8 }, (_, i) => `RPM_${i}`), 'RPM_LIMITER_1'];
    const revLeds = (byName.get('CAR')?.extras as { revLeds?: { leds: { node: string; rpm: number }[]; blinkRpm?: number } }).revLeds;
    check('Wheel screen and shift lights under STEER', ['GEO_LCD', ...ledNodes].every((n) => steerKids.includes(n)), `${steerKids.length} STEER children`);
    check('Shift lights 8000–9500 rpm, blinking at 9600', revLeds?.leds.length === 9 && revLeds.leds[0].rpm === 8000 && revLeds.leds[8].rpm === 9500 && revLeds.blinkRpm === 9600,
      revLeds ? revLeds.leds.map((l) => `${l.node}@${l.rpm}`).join(' ') : 'no revLeds');
    // Every livery in the registry has its files, named as the GLB's skinMaps say
    const skinMaps = (byName.get('CAR')?.extras as { skinMaps?: Record<string, string> }).skinMaps ?? {};
    const files = [...new Set(Object.values(skinMaps))];
    const skins = def.skins ?? [];
    const missing = skins.flatMap((s) => files.map((f) => `public/cars/mtr-496r/skins/${s.id}/${f}`)).filter((f) => !hasFile(f));
    check('20 liveries, each with its paint, decals and sunstrip', skins.length === 20 && files.length === 3 && missing.length === 0,
      missing.length ? `missing ${missing.slice(0, 3).join(', ')}` : `${files.join(', ')}`);
    check('Under 9 MB before meshopt', buf.length < 9e6, `${fmt(buf.length / 1e6)} MB`);
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
  const proto = lap(createMtr496rSim(track, root));
  const gt3 = lap(createAmgGt3Sim(track, root));
  check('Flying lap completes, CG within 0.5 m of the edge', proto.done && proto.beyond <= 0.5 && proto.maxSlip < 12,
    `lap ${fmt(proto.lapS, 2)} s, top ${fmt(proto.top, 0)} km/h, CG ${fmt(Math.max(0, proto.beyond), 2)} m past the edge, max body slip ${fmt(proto.maxSlip, 1)}°`);
  // 300 kg lighter, more downforce and a little more power than the GT3
  check('Quicker than the GT3', proto.lapS < gt3.lapS - 2, `${fmt(proto.lapS, 2)} s vs the GT3's ${fmt(gt3.lapS, 2)} s`);
}

console.log('\n== Up-shift');
{
  // A dog box: 40 ms between gears with the ignition cut for 60 ms (16 % with the gear changed in no time)
  const u = measureUpshift((t) => createMtr496rSim(t), 90);
  check('An up-shift on a light pedal: the dogs are out, then the driven wheels take the engine\'s excess, under 15 % of slip', u.to === u.from + 1 && u.gMin < u.gBefore - 0.1 && u.slipPeak < 0.15, `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
}

console.log('\n== Down-shift');
{
  // A 60 % blip in the 100 ms between gears; the clutch takes up what it leaves
  const d = measureDownshift((t) => createMtr496rSim(t), 190, 4, 0.5);
  check('A down-shift on the brakes: the blip brings the engine up, no wheel slips past 6 % and the car is not tugged 0.25 g harder', d.to === d.from - 1 && d.slipPeak < 0.06 && d.gMin > d.gBefore - 0.25, `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
  const g = MTR_496R_CONFIG.gearbox;
  const taken = downshiftTakenAt((t) => createMtr496rSim(t), 4, g.ratios, g.gears.redline_rpm, 300);
  const refused = !downshiftTakenAt((t) => createMtr496rSim(t), 4, g.ratios, g.gears.redline_rpm, 700);
  check('The box takes a down-shift that lands 300 rpm over the limiter and refuses one 700 over', taken && refused, `300 over: ${taken ? 'taken' : 'refused'}, 700 over: ${refused ? 'refused' : 'taken'}`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll 496R checks passed.');
if (failures.length) process.exitCode = 1;
