/**
 * Headless checks for the f12026-car vehicle model (`src/lib/sim/f12026-car`).
 *
 *   npx tsx scripts/verify-f12026-car.ts
 *
 * Loads the real track colliders from public/tracks/rwanda/rwanda_2026.glb (geometry + node extras only,
 * no textures), then runs config, collider, static, straight-line, braking, cornering, DRS, ERS and
 * full-lap checks.
 */
import * as THREE from 'three';
import { getRwandaTrackData, RWANDA_DRS_ZONES, RWANDA_SPAWN_GRID } from '../src/lib/track-data';
import { Lut } from '../src/lib/sim/lut';
import { F12026_CAR_CONFIG, type CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import {
  createGroundHit,
  FlatGroundQuery,
  type GroundQuery,
  TrackColliderQuery,
  TrackWallQuery,
  type WallQuery,
} from '../src/lib/sim/f12026-car/TrackColliderQuery';
import {
  combinedSlipForces,
  createTyreRuntime,
  tyreSlipCurve,
  type VehicleEvent,
  VehiclePhysics,
  type VehicleInputs,
} from '../src/lib/sim/f12026-car/VehiclePhysics';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { checkBarrierCrashes, vehicleCrashCar } from './lib/barrier-crash';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const RWANDA_AIR_DENSITY = 1.06;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DT = 1 / 120;

function makeCar(ground: GroundQuery, extra: Partial<ConstructorParameters<typeof VehiclePhysics>[0]> = {}) {
  return new VehiclePhysics({ ground, airDensity: RWANDA_AIR_DENSITY, ...extra });
}

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, stop?: (car: VehiclePhysics, t: number) => boolean): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, drive(car, t));
    t += DT;
    if (stop?.(car, t)) break;
  }
  return t;
}

/** Throttle with a simple slip limiter (a driver feathering the pedal, not an ECU aid) */
function launchDriver(target = 0.1) {
  let pedal = 0.6;
  return (car: VehiclePhysics): VehicleInputs => {
    const sr = Math.max(car.wheels[2].slipRatio, car.wheels[3].slipRatio);
    pedal = THREE.MathUtils.clamp(pedal + (target - sr) * 0.25, 0.3, 1);
    return { throttle: pedal, brake: 0, steer: 0 };
  };
}

/** Threshold braking: full pedal, backing off when a wheel starts to lock */
function brakeDriver() {
  let pedal = 1;
  return (car: VehiclePhysics): VehicleInputs => {
    const sr = Math.min(...car.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (sr < -0.12 ? -0.1 : 0.05), 0.2, 1);
    return { throttle: 0, brake: pedal, steer: 0 };
  };
}

function finite(car: VehiclePhysics): boolean {
  return [car.position.x, car.position.y, car.position.z, car.velocity.x, car.velocity.y, car.velocity.z, car.angularVelocity.y].every(Number.isFinite);
}

// ---------------------------------------------------------------------------
// 1. Config
// ---------------------------------------------------------------------------

console.log('\n== f12026-car config');
{
  const cfg = F12026_CAR_CONFIG;
  const power = new Lut(cfg.engine.powerCurve);
  let peak = 0;
  let peakLo = Infinity;
  let peakHi = -Infinity;
  for (let rpm = 4000; rpm <= 15000; rpm += 50) {
    const p = power.evaluate(rpm);
    if (p > peak + 1e-9) {
      peak = p;
      peakLo = peakHi = rpm;
    } else if (Math.abs(p - peak) < 1e-9) peakHi = rpm;
  }
  check('ICE peak 580 kW over 10 500–12 500 rpm', peak === 580 && peakLo === 10500 && peakHi === 12500, `${peak} kW ${peakLo}–${peakHi} rpm`);
  check('Mass / distribution / wheelbase / tracks', cfg.chassis.totalMassKg === 800 && cfg.chassis.frontWeightFraction === 0.455 && cfg.chassis.wheelbase === 3.6 && cfg.chassis.trackWidthFront === 1.6 && cfg.chassis.trackWidthRear === 1.55, '800 kg 45.5 % 3.60 / 1.60 / 1.55 m');
  check('Gears: 8 fwd + R, 15000 / 13200 / 9800', cfg.gearbox.ratios.length === 8 && cfg.gearbox.reverse > 0 && cfg.gearbox.gears.redline_rpm === 15000 && cfg.gearbox.gears.upshift_rpm === 13200 && cfg.gearbox.gears.downshift_rpm === 9800, '');
  const k = new Lut(cfg.ers.torqueLut);
  // Deploy torque = min(P / ω, torqueLut): the LUT's chords sit slightly above the 120 kW hyperbola
  const kw = (rpm: number) => Math.min(cfg.ers.ERS_MAX_DEPLOY / ((rpm * Math.PI) / 30), k.evaluate(rpm)) * ((rpm * Math.PI) / 30) / 1000;
  let kwMax = 0;
  for (let rpm = 1000; rpm <= 15000; rpm += 50) kwMax = Math.max(kwMax, kw(rpm));
  check('MGU-K ≤ 120 kW, 4 MJ store', kwMax <= 120.001 && kw(12000) > 119 && cfg.ers.ERS_MAX_DEPLOY === 120000 && cfg.ers.ERS_MAX_CHARGE === 4e6, `${fmt(kwMax, 1)} kW peak`);
  const tyres = cfg.tyreCompounds;
  const peakOf = (c: keyof typeof tyres) => Math.max(...tyres[c].thermalData.thermalPerformanceCurve.map((p) => p[1]));
  check('Compound peaks 1.00 / 0.96 / 0.92', peakOf('PhysicsTyreCompound_F1_Soft') === 1 && peakOf('PhysicsTyreCompound_F1_Medium') === 0.96 && peakOf('PhysicsTyreCompound_F1_Hard') === 0.92, '');
  check('Tyres 305 / 405 × R 0.360, 25 psi', tyres.PhysicsTyreCompound_F1_Soft.front.width === 0.305 && tyres.PhysicsTyreCompound_F1_Soft.rear.width === 0.405 && tyres.PhysicsTyreCompound_F1_Soft.front.radius === 0.36 && tyres.PhysicsTyreCompound_F1_Soft.pressureData.optimalPsi === 25, '');
}

// ---------------------------------------------------------------------------
// 2. Track colliders
// ---------------------------------------------------------------------------

console.log('\n== Track colliders (rwanda_2026.glb)');
const trackRoot = loadGlbGeometry('public/tracks/rwanda/rwanda_2026.glb');
const t0 = performance.now();
const colliders = TrackColliderQuery.fromTrackRoot(trackRoot);
console.log(`      built ${colliders.triangleCount} triangles in ${fmt(performance.now() - t0, 0)} ms`);
const track = getRwandaTrackData();
{
  const hit = createGroundHit();
  const slot = RWANDA_SPAWN_GRID[0];
  const ok = colliders.query(slot.position[0], slot.position[2], slot.position[1] + 2, hit);
  check('Grid slot 1 is on the road collider', ok && hit.surface === 'road' && hit.grip === 1 && Math.abs(hit.height - slot.position[1]) < 0.3, `${hit.surface} grip ${hit.grip} y ${fmt(hit.height)} vs ${fmt(slot.position[1])} (${hit.source})`);

  // Walk the centreline and both edges of every sample
  let roadHits = 0;
  let misses = 0;
  let runoff = 0;
  let maxDy = 0;
  const offEdge: Record<string, number> = {};
  for (const s of track.samples) {
    const p = s.position;
    if (colliders.query(p.x, p.z, p.y + 2, hit)) {
      if (hit.surface === 'road') roadHits++;
      maxDy = Math.max(maxDy, Math.abs(hit.height - p.y));
    } else misses++;
    const edge = p.clone().addScaledVector(s.binormal, s.width / 2 + 4);
    if (colliders.query(edge.x, edge.z, edge.y + 3, hit)) {
      offEdge[hit.surface] = (offEdge[hit.surface] ?? 0) + 1;
      if (hit.surface === 'runoff' && Math.abs(hit.grip - 0.75) < 1e-6) runoff++;
    }
  }
  check('Centreline: every sample hits road', misses === 0 && roadHits === track.samples.length, `${roadHits}/${track.samples.length}, max |Δy| ${fmt(maxDy, 3)} m`);
  check('4 m past the right edge reads its own surface', Object.keys(offEdge).length > 1 && runoff > 0, JSON.stringify(offEdge));

  const q0 = performance.now();
  let n = 0;
  for (let k = 0; k < 200_000; k++) {
    const s = track.samples[k % track.samples.length];
    if (colliders.query(s.position.x + ((k * 7) % 13) - 6, s.position.z, s.position.y + 2, hit)) n++;
  }
  const us = ((performance.now() - q0) * 1000) / 200_000;
  check('Query cost', us < 5, `${fmt(us, 2)} µs/query (${n} hits)`);
}

// ---------------------------------------------------------------------------
// 3. Static on the real track
// ---------------------------------------------------------------------------

console.log('\n== Static (grid slot 1, Rwanda colliders)');
{
  const slot = RWANDA_SPAWN_GRID[0];
  const car = makeCar(colliders);
  car.reset(slot.position[0], slot.position[2], slot.yawRad);
  const W = car.wheels;
  const sum = W.reduce((a, w) => a + w.fz, 0);
  const front = (W[0].fz + W[1].fz) / sum;
  const tel = car.telemetry;
  check('Wheel loads carry the weight', Math.abs(sum / (800 * 9.81) - 1) < 0.02, `${fmt(sum, 0)} N`);
  check('Front load share ≈ 45.5 %', Math.abs(front - 0.455) < 0.015, `${fmt(front * 100, 1)} %`);
  check('Static floor heights ≈ 32 / 70 mm', Math.abs(tel.aeroHeightFront - 0.032) < 0.006 && Math.abs(tel.aeroHeightRear - 0.07) < 0.008, `${fmt(tel.aeroHeightFront * 1000, 1)} / ${fmt(tel.aeroHeightRear * 1000, 1)} mm`);
  car.step(1, { throttle: 0, brake: 1, steer: 0 });
  check('Parked car stays parked', car.velocity.length() < 0.05, `${fmt(car.velocity.length(), 3)} m/s`);
}

// ---------------------------------------------------------------------------
// 4. Straight line (flat, ρ = 1.06)
// ---------------------------------------------------------------------------

const flat = new FlatGroundQuery(0);
console.log('\n== Straight line (flat ground, ρ 1.06)');
{
  const car = makeCar(flat, { performanceMode: 'PSH' });
  car.reset(0, 0, 0);
  const drive = launchDriver();
  let t100 = NaN;
  let t200 = NaN;
  let t300 = NaN;
  let vmax = 0;
  const t = run(car, 70, (c) => drive(c), (c, time) => {
    const v = c.telemetry.speedKmh;
    if (Number.isNaN(t100) && v >= 100) t100 = time;
    if (Number.isNaN(t200) && v >= 200) t200 = time;
    if (Number.isNaN(t300) && v >= 300) t300 = time;
    vmax = Math.max(vmax, v);
    return !finite(c);
  });
  console.log(`      0-100 ${fmt(t100)} s, 0-200 ${fmt(t200)} s, 0-300 ${fmt(t300)} s, vmax ${fmt(vmax, 1)} km/h in ${car.gear}th, ` +
    `SOC ${fmt(car.telemetry.ERS_CHARGE * 100, 0)} %, deployed ${fmt(car.lapDeployJ / 1e6, 2)} MJ`);
  // Real cars do ~2.6 s; this is traction-limited (~1.1 g) on 70 °C blanket tyres with a pedal-feathering driver
  check('0-100 km/h 2.4–3.4 s', t100 > 2.4 && t100 < 3.4, `${fmt(t100)} s`);
  check('0-200 km/h 4.4–6.0 s', t200 > 4.4 && t200 < 6.0, `${fmt(t200)} s`);
  check('Top speed 320–352 km/h (DRS shut)', vmax > 320 && vmax < 352.5, `${fmt(vmax, 1)} km/h after ${fmt(t, 0)} s`);
  check('Per-lap deploy cap 4 MJ', car.lapDeployJ <= 4e6 + 1, `${fmt(car.lapDeployJ / 1e6, 3)} MJ`);
  check('Shifted into 8th', car.gear === 8, `gear ${car.gear}`);
  check('Floor runs lower at speed', car.telemetry.AERO_HEIGHT < 0.045 && car.telemetry.AERO_HEIGHT > 0.008, `${fmt(car.telemetry.aeroHeightFront * 1000, 1)} / ${fmt(car.telemetry.aeroHeightRear * 1000, 1)} mm, balance ${fmt(car.telemetry.AERO_BALANCE, 1)} %`);

  // Braking 300 → 100 km/h: threshold braking (no ABS), half-full ES so the MGU-K can harvest
  const b = makeCar(flat);
  b.reset(0, 0, 0, 300 / 3.6);
  let dist = 0;
  let peakG = 0;
  let locked = false;
  const z0 = b.position.z;
  b.ersEnergyJ = 0.5 * 4e6;
  const brake = brakeDriver();
  run(b, 10, (c) => brake(c), (c) => {
    peakG = Math.max(peakG, -c.telemetry.lonG);
    if (c.wheels.some((w) => w.slipRatio < -0.3)) locked = true;
    dist = c.position.z - z0;
    return c.telemetry.speedKmh <= 100;
  });
  check('Braking 300→100 km/h 75–130 m', dist > 75 && dist < 130, `${fmt(dist, 1)} m, peak ${fmt(peakG, 2)} g, harvest ${fmt(b.lapHarvestJ / 1e3, 0)} kJ${locked ? ', locked a wheel' : ''}`);
  check('Peak deceleration 4–6.5 g', peakG > 4 && peakG < 6.5, `${fmt(peakG, 2)} g`);
  check('Harvests under braking', b.lapHarvestJ > 50e3, `${fmt(b.lapHarvestJ / 1e3, 0)} kJ`);
}

// ---------------------------------------------------------------------------
// 5. Cornering: steady-speed steer ramp
// ---------------------------------------------------------------------------

console.log('\n== Cornering (flat, steer ramp at constant speed)');
for (const kmh of [120, 240]) {
  const car = makeCar(flat);
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let spun = false;
  let pedal = 0.3;
  run(car, 8, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 8) * 0.9 };
  }, (c) => {
    maxLat = Math.max(maxLat, Math.abs(c.telemetry.latG));
    const beta = Math.atan2(c.velocity.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)), c.velocity.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion)));
    if (Math.abs(beta) > 0.35) spun = true;
    return spun || !finite(c);
  });
  const lo = kmh < 200 ? 2.2 : 3.4;
  const hi = kmh < 200 ? 3.8 : 5.5;
  check(`Peak lateral at ${kmh} km/h ${lo}–${hi} g`, maxLat > lo && maxLat < hi, `${fmt(maxLat, 2)} g${spun ? ' (rotated past 20°)' : ''}`);
}

// Trail braking and over-limit steer in fast corners (semi_pro, the adapter's assists). The brake-by-wire holds
// the rear at the bias demand under engine overrun and harvest, downshifts rev-match, and the wider rear tyre's
// higher reference load keeps the limit balance on the understeer side.
{
  const wide = createFlatTestTrack(30_000, 3000);
  const corner = (vKmh: number, steer: number, brake: number) => {
    const sim = new F12026CarSim(wide);
    sim.assistPreset = 'semi_pro';
    sim.teleportToDistance(1500, vKmh / 3.6);
    let st = 0;
    for (let t = 0; t < 4; t += 1 / 120) {
      st = Math.min(steer, st + 0.15 / 120);
      sim.step(1 / 120, { throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (vKmh / 3.6 - sim.vxMs), 0, 1), analogSteer: st });
    }
    const vSteady = sim.telemetry.speedKmh;
    let maxSlip = 0;
    for (let t = 0; brake > 0 && t < 2; t += 1 / 120) {
      sim.step(1 / 120, { brake: Math.min(brake, (t / 0.08) * brake), analogSteer: steer });
      maxSlip = Math.max(maxSlip, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs)))) * 180) / Math.PI);
    }
    return { vSteady, maxSlip };
  };
  const trailCases: [number, number, number][] = [
    [200, 0.08, 0.3], [200, 0.12, 1], [250, 0.1, 0.3], [250, 0.12, 0.6], [290, 0.08, 0.3], [290, 0.12, 1],
  ];
  const slips = trailCases.map(([v, s, b]) => corner(v, s, b).maxSlip);
  check('Trail braking in fast corners keeps the rear planted', Math.max(...slips) < 10,
    trailCases.map(([v, s, b], i) => `${v}/${s}/${b}: ${fmt(slips[i], 1)}°`).join(', '));
  const over = [200, 250, 290].map((v) => corner(v, 0.25, 0).vSteady);
  check('Over-limit steer washes wide instead of spinning', over.every((v, i) => v > [200, 250, 290][i] * 0.9),
    `${over.map((v) => fmt(v, 0)).join(' / ')} km/h held at steer 0.25`);
}

// Edges of the drivable world: a raised verge, a drop the nose falls off, wheelspin through the gears
console.log('\n== Steps, ledges and gear hunting (flat ground with a step at z = 12 m)');
{
  /** Flat ground that steps by `dh` (m) past z = 12 m */
  const stepGround = (dh: number): GroundQuery => ({
    query(_x, z, probeY, out) {
      const h = z > 12 ? dh : 0;
      if (h > probeY) return false;
      Object.assign(out, { height: h, nx: 0, ny: 1, nz: 0, surface: 'road', grip: 1, source: 'step' });
      return true;
    },
  });
  const across = (dh: number, speedMs: number, throttle: number) => {
    const car = makeCar(stepGround(dh));
    car.reset(0, 0, 0, speedMs);
    let maxY = -Infinity;
    let maxFz = 0;
    let maxKmh = 0;
    run(car, 4, () => ({ throttle, brake: 0, steer: 0 }), (c) => {
      maxY = Math.max(maxY, c.position.y);
      maxFz = Math.max(maxFz, ...c.wheels.map((w) => w.fz));
      maxKmh = Math.max(maxKmh, c.telemetry.speedKmh);
      return !finite(c);
    });
    // Overshoot above the ride height it settles at on top of the step
    return { finite: finite(car), rise: maxY - car.position.y, maxFz, maxKmh, z: car.position.z };
  };
  // A 21 cm verge at walking pace and at 70 km/h: the tyre rolls up it instead of taking it in one step
  const slow = across(0.21, 5, 0.15);
  const fast = across(0.21, 20, 0.3);
  // At walking pace the tyres roll up it; at 72 km/h a 21 cm face throws the car (as a sausage kerb does) but
  // must not fire it into the sky
  check('Rolls up a 21 cm step instead of launching', slow.finite && fast.finite && slow.rise < 0.25 && fast.rise < 1 && Math.max(slow.maxFz, fast.maxFz) < 60_000,
    `overshoot above the settled ride height ${fmt(slow.rise * 1000, 0)} / ${fmt(fast.rise * 1000, 0)} mm at 5 / 20 m/s, peak wheel load ${fmt(Math.max(slow.maxFz, fast.maxFz) / 1000, 1)} kN`);
  // Off a 1.3 m ledge at crawling pace: the body drops while the rears still stand on the top
  const ledge = across(-1.3, 4, 0.1);
  check('Drops off a 1.3 m ledge without blowing up', ledge.finite && ledge.maxKmh < 40 && ledge.z > 12,
    `max ${fmt(ledge.maxKmh, 0)} km/h, ended at z ${fmt(ledge.z, 1)} m`);

  // Accelerating on 30 % wheelspin: the inflated engine rpm upshifts early, and the new gear's road rpm can sit
  // under the downshift point; the auto box must not bounce between the two
  const car = makeCar(flat);
  car.reset(0, 0, 0);
  const spin = launchDriver(0.3);
  const gears: number[] = [];
  run(car, 12, (c) => spin(c), (c) => {
    if (gears[gears.length - 1] !== c.gear) gears.push(c.gear);
    return !finite(c);
  });
  const downs = gears.filter((g, i) => i > 0 && g < gears[i - 1]).length;
  check('No gear hunting under wheelspin', downs === 0, `gears ${gears.join('→')}`);
}

// ---------------------------------------------------------------------------
// 6. DRS, heave gating, ERS modes
// ---------------------------------------------------------------------------

console.log('\n== DRS / suspension type / ERS modes');
{
  const rw = F12026_CAR_CONFIG.aero.wings.find((w) => w.name === 'REAR_WING')!;
  const cl = new Lut(rw.lutAOA_CL).evaluate(rw.angleDeg);
  const cd = new Lut(rw.lutAOA_CD).evaluate(rw.angleDeg);
  check('Rear wing DRS: −18 % CL, −28 % CD', Math.abs(cl * rw.drs!.clMult / cl - 0.82) < 1e-9 && Math.abs(cd * rw.drs!.cdMult / cd - 0.72) < 1e-9, '');

  const events: string[] = [];
  const drsCar = makeCar(flat, { onEvent: (e) => e.type === 'CHANGED_DRS_OPEN' && events.push(String(e.open)) });
  drsCar.reset(0, 0, 0, 300 / 3.6);
  const hold = (c: VehiclePhysics) => ({ throttle: c.telemetry.speedKmh < 300 ? 1 : 0.6, brake: 0, steer: 0 });
  run(drsCar, 1.5, hold);
  const dragShut = drsCar.telemetry.dragN;
  const downShut = drsCar.telemetry.downforceN;
  drsCar.step(DT, { ...hold(drsCar), drs: true });
  run(drsCar, 1.0, hold);
  const dragOpen = drsCar.telemetry.dragN;
  const downOpen = drsCar.telemetry.downforceN;
  drsCar.step(DT, { throttle: 0, brake: 0.5, steer: 0 });
  check('DRS opens / closes on brake (CHANGED_DRS_OPEN)', events.join(',') === 'true,false', events.join(','));
  check('DRS cuts drag and downforce', dragOpen < dragShut * 0.93 && downOpen < downShut, `drag ${fmt(dragShut, 0)}→${fmt(dragOpen, 0)} N, DF ${fmt(downShut, 0)}→${fmt(downOpen, 0)} N`);

  const zoneCar = makeCar(flat, { drsZones: [{ id: 'Z', detection: 0.5, start: 0.6, end: 0.7 }], locateProgress: () => 0.2 });
  zoneCar.reset(0, 0, 0, 250 / 3.6);
  zoneCar.step(DT, { throttle: 1, brake: 0, steer: 0, drs: true });
  run(zoneCar, 0.5, () => ({ throttle: 1, brake: 0, steer: 0 }));
  check('DRS stays shut outside a ZoneData_DRSZone', !zoneCar.drsOpen && zoneCar.drsBlend === 0, '');

  const strut: CarPhysicsConfig = structuredClone(F12026_CAR_CONFIG);
  strut.suspensions.front.type = 'SuspensionType_Strut';
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: string) => warns.push(m);
  makeCar(flat, { config: strut });
  console.warn = origWarn;
  check('Heave ignored on non-double-wishbone', warns.some((w) => w.includes('IGNORING HEAVE SPRING BECAUSE SUSPENSION FRONT IS NOT DOUBLE WISHBONE')), warns[0] ?? 'no warning');

  const soc = (mode: 'PSH' | 'RAC' | 'BAL') => {
    const c = makeCar(flat, { performanceMode: mode });
    c.reset(0, 0, 0, 150 / 3.6);
    c.ersEnergyJ = 0.45 * 4e6;
    run(c, 12, () => ({ throttle: 1, brake: 0, steer: 0 }));
    return c.ersEnergyJ / 4e6;
  };
  const sP = soc('PSH');
  const sR = soc('RAC');
  const sB = soc('BAL');
  check('SOC floors: PSH < RAC (20 %) < BAL (40 %)', sP < 0.19 && sR >= 0.195 && sR < 0.25 && sB >= 0.395, `PSH ${fmt(sP * 100, 1)} %, RAC ${fmt(sR * 100, 1)} %, BAL ${fmt(sB * 100, 1)} %`);
  const ebb = makeCar(flat, { performanceMode: 'RAC' });
  const ebb0 = makeCar(flat, { performanceMode: 'PSH' });
  check('RAC moves EBB one step forward', ebb.brakeBias > ebb0.brakeBias, `${fmt(ebb0.brakeBias * 100, 1)} → ${fmt(ebb.brakeBias * 100, 1)} %`);
}

// ---------------------------------------------------------------------------
// 7. A lap of Rwanda on the colliders (pure-pursuit driver on the centreline)
// ---------------------------------------------------------------------------

console.log('\n== Lap on the Rwanda colliders');
{
  const L = track.totalLengthM;
  let hintS = RWANDA_SPAWN_GRID[0].s;
  const progress = (x: number, z: number) => {
    const p = track.projectWorldToTrack(x, z, hintS);
    hintS = p.s;
    return p.s / L;
  };
  const car = makeCar(colliders, { drsZones: RWANDA_DRS_ZONES, locateProgress: progress });
  const slot = RWANDA_SPAWN_GRID[0];
  car.reset(slot.position[0], slot.position[2], slot.yawRad);
  const ex = new THREE.Vector3();
  const ez = new THREE.Vector3();
  let travelled = 0;
  let lastS = slot.s;
  let airborne = 0;
  let frames = 0;
  let maxLateral = 0;
  const surfaces: Record<string, number> = {};
  let pedal = 0;
  let tc = 1;
  let abs = 1;
  let lapResets = 0;
  let lastDeploy = 0;
  const t = run(
    car,
    400,
    (c) => {
      const p = track.projectWorldToTrack(c.position.x, c.position.z, hintS);
      const v = c.speedMs;
      const look = track.getSampleAtDistance((p.s + Math.max(10, v * 0.55)) % L);
      ex.set(1, 0, 0).applyQuaternion(c.quaternion);
      ez.set(0, 0, 1).applyQuaternion(c.quaternion);
      const d = look.position.clone().sub(c.position);
      const alpha = Math.atan2(d.dot(ex), d.dot(ez));
      // Pure pursuit plus countersteer on body slip (steer toward where the car is going)
      const beta = Math.atan2(c.velocity.dot(ex), Math.max(1, c.velocity.dot(ez)));
      const delta = Math.atan((2 * c.wheelbaseM * Math.sin(alpha)) / Math.max(5, d.length())) + 0.8 * beta;
      // Target: 60 % of the circuit's braking-limit speed over the next 120 m
      let vTarget = Infinity;
      for (let k = 0; k <= 120; k += 10) {
        const s = track.getSampleAtDistance((p.s + k) % L);
        vTarget = Math.min(vTarget, ((s.brakeLimitKmh ?? s.optimalSpeedKmh) * 0.6) / 3.6);
      }
      const err = vTarget - v;
      pedal = THREE.MathUtils.clamp(pedal + err * 0.01, -1, 1);
      // Feather the pedals like a driver: back off on wheelspin / lock-up
      const spin = Math.max(c.wheels[2].slipRatio, c.wheels[3].slipRatio);
      const lock = Math.min(...c.wheels.map((w) => w.slipRatio));
      tc = THREE.MathUtils.clamp(tc + (0.06 - spin) * 0.3, 0.1, 1);
      abs = THREE.MathUtils.clamp(abs + (lock < -0.12 ? -0.1 : 0.05), 0.2, 1);
      return {
        throttle: Math.min(Math.max(0, pedal), tc),
        brake: Math.min(Math.max(0, -pedal), abs),
        steer: THREE.MathUtils.clamp(-delta / c.maxSteerRad, -1, 1),
      };
    },
    (c) => {
      const p = track.projectWorldToTrack(c.position.x, c.position.z, hintS);
      let ds = p.s - lastS;
      if (ds < -L / 2) ds += L;
      if (ds > L / 2) ds -= L;
      travelled += ds;
      lastS = p.s;
      maxLateral = Math.max(maxLateral, Math.abs(p.lateralOffset));
      if (c.lapDeployJ < lastDeploy) lapResets++;
      lastDeploy = c.lapDeployJ;
      frames++;
      for (const w of c.wheels) {
        if (!w.grounded || w.fz <= 0) airborne++;
        surfaces[w.ground.surface] = (surfaces[w.ground.surface] ?? 0) + 1;
      }
      // Run 50 m past the start so the finish line is crossed with energy already deployed
      return travelled >= L + 50 || !finite(c) || maxLateral > 25;
    }
  );
  const air = airborne / (frames * 4);
  console.log(`      lap ${fmt(travelled, 0)} / ${fmt(L, 0)} m in ${fmt(t, 1)} s (avg ${fmt((travelled / t) * 3.6, 0)} km/h), max |lateral| ${fmt(maxLateral, 1)} m, ` +
    `tyres ${car.telemetry.tyreSurfaceTempC.map((x) => fmt(x, 0)).join('/')} °C, ${car.telemetry.tyrePressurePsi.map((x) => fmt(x, 1)).join('/')} psi`);
  console.log(`      wheel surfaces ${JSON.stringify(surfaces)}`);
  check('Completes a lap on the colliders', travelled >= L && finite(car), `${fmt(travelled, 0)} m`);
  check('Stays on the track', maxLateral < 10, `${fmt(maxLateral, 1)} m`);
  check('Wheels loaded on the collider', air < 0.01, `${fmt(air * 100, 2)} % unloaded wheel-steps`);
  check('ERS lap counters reset at the line', lapResets >= 1 && car.lapDeployJ <= 4e6 + 1, `${lapResets} reset(s), ${fmt(car.lapDeployJ / 1e6, 2)} MJ deployed since`);
}

// ---------------------------------------------------------------------------
// 8. Stereo's combined slip (this model's interpretation)
// ---------------------------------------------------------------------------

console.log('\n== Combined slip (combinedFactor / new_combined / falloff)');
{
  const base = F12026_CAR_CONFIG.tyreCompounds.PhysicsTyreCompound_F1_Soft;
  const tyreWith = (patch: Partial<typeof base.modelData>) => createTyreRuntime({ ...base, modelData: { ...base.modelData, ...patch } });
  const noCross = { new_combined: false, fx_shift_SA: 0, fx_scale_SA: 0, fy_shift_SR: 0, fy_scale_SR: 0 };
  const out = { fx: 0, fy: 0, sx: 0, sy: 0 };
  const t1 = tyreWith({ combinedFactor: 1 });
  let circleErr = 0;
  for (const [sx, sy] of [
    [0.3, 0.4],
    [0.8, 0.6],
    [1.2, 0.5],
    [0.1, 2],
  ]) {
    combinedSlipForces(t1, noCross, sx, sy, out);
    const s = Math.hypot(sx, sy);
    circleErr = Math.max(circleErr, Math.abs(Math.hypot(out.fx, out.fy) - tyreSlipCurve(t1, s)), Math.abs(Math.atan2(out.fy, out.fx) - Math.atan2(sy, sx)));
  }
  check('k = 1: friction circle (magnitude + direction)', circleErr < 1e-9, `max err ${circleErr.toExponential(1)}`);
  combinedSlipForces(t1, noCross, 0.6, 0, out);
  const pure = out.fx;
  combinedSlipForces(tyreWith({ combinedFactor: 0.4 }), noCross, 0.6, 0, out);
  check('Pure slip independent of k', Math.abs(out.fx - pure) < 1e-12 && out.fy === 0, '');
  combinedSlipForces(t1, noCross, 0.6, 0.6, out);
  const fK1 = Math.hypot(out.fx, out.fy);
  combinedSlipForces(tyreWith({ combinedFactor: 0.5 }), noCross, 0.6, 0.6, out);
  const fK05 = Math.hypot(out.fx, out.fy);
  combinedSlipForces(tyreWith({ combinedFactor: 1.5 }), noCross, 0.6, 0.6, out);
  const fK15 = Math.hypot(out.fx, out.fy);
  check('k < 1 relaxes, k > 1 tightens the cross-axis penalty', fK05 > fK1 && fK15 < fK1, `|F| ${fmt(fK05, 3)} / ${fmt(fK1, 3)} / ${fmt(fK15, 3)} (k 0.5 / 1 / 1.5)`);
  const cross = { new_combined: true, fx_shift_SA: 0, fx_scale_SA: 0.3, fy_shift_SR: 0, fy_scale_SR: 0.2 };
  combinedSlipForces(t1, cross, 0.5, 0.8, out);
  const sxm = 0.5 * (1 - 0.3 * 0.8);
  const sym = 0.8 * (1 - 0.2 * 0.5);
  check('new_combined scales: s_x,mod / s_y,mod', Math.abs(out.sx - sxm) < 1e-12 && Math.abs(out.sy - sym) < 1e-12, `${fmt(out.sx, 3)} / ${fmt(out.sy, 3)}`);
  combinedSlipForces(t1, { ...cross, new_combined: false }, 0.5, 0.8, out);
  check('new_combined off ignores the cross terms', out.sx === 0.5 && out.sy === 0.8, '');
  combinedSlipForces(t1, { new_combined: true, fx_shift_SA: 0.1, fx_scale_SA: 0, fy_shift_SR: -0.05, fy_scale_SR: 0 }, 0, 0.5, out);
  check('fx_shift_SA: lateral slip shifts the longitudinal force', Math.abs(out.sx - 0.05) < 1e-12 && out.fx > 0, `s_x,mod ${fmt(out.sx, 3)}`);
  const tf = tyreWith({ use_slip_falloff: true, falloff_level: 0.7, falloff_slope: 0.6 });
  const at1 = tyreSlipCurve(tf, 1);
  const just = tyreSlipCurve(tf, 1 + 1e-6);
  const mid = tyreSlipCurve(tf, 2);
  const far = tyreSlipCurve(tf, 10);
  check(
    'use_slip_falloff: 1 at peak, decays to falloff_level',
    Math.abs(at1 - 1) < 1e-6 && Math.abs(just - 1) < 1e-6 && Math.abs(far - 0.7) < 1e-6 && mid < 1 && mid > 0.7,
    `F(1) ${fmt(at1, 4)} F(2) ${fmt(mid, 3)} F(10) ${fmt(far, 3)}`
  );
}

// ---------------------------------------------------------------------------
// 9. DRS detection (ZoneData_DRSZone): flat 1 km "lap", progress from the distance driven
// ---------------------------------------------------------------------------

console.log('\n== DRS detection / auto-close');
{
  const zones = [{ id: 'Z', detection: 0.1, start: 0.12, end: 0.3 }];
  const drsRun = (eligible: boolean) => {
    const events: VehicleEvent[] = [];
    const car = makeCar(flat, {
      drsZones: zones,
      locateProgress: (_x, z) => 0.05 + z / 1000,
      drsEligibleAtDetection: () => eligible,
      onEvent: (e) => events.push(e),
    });
    car.reset(0, 0, 0, 250 / 3.6);
    const full: VehicleInputs = { throttle: 1, brake: 0, steer: 0 };
    const press = (inp: VehicleInputs) => {
      car.step(DT, { ...inp, drs: true });
      car.step(DT, inp);
    };
    press(full);
    run(car, 0.2, () => full);
    const openedEarly = car.drsOpen;
    run(car, 3, () => full, (c) => c.trackProgress > 0.13);
    press(full);
    const openedInZone = car.drsOpen;
    const available = car.telemetry.drsAvailable;
    press({ throttle: 0.2, brake: 0, steer: 0 });
    const afterLift = car.drsOpen;
    press(full);
    const reopened = car.drsOpen;
    press({ throttle: 0, brake: 0.3, steer: 0 });
    const afterBrake = car.drsOpen;
    const det = events.find((e): e is Extract<VehicleEvent, { type: 'DRS_DETECTION' }> => e.type === 'DRS_DETECTION');
    const opens = events.flatMap((e) => (e.type === 'CHANGED_DRS_OPEN' ? [e.open] : []));
    return { openedEarly, openedInZone, available, afterLift, reopened, afterBrake, det, opens };
  };
  const ok = drsRun(true);
  check('No DRS before the detection point', !ok.openedEarly, '');
  check('Detection crossed → DRS_DETECTION (eligible)', ok.det?.zone === 'Z' && ok.det.eligible && ok.available, JSON.stringify(ok.det));
  check('Opens in the zone after detection', ok.openedInZone, '');
  check('Auto-closes on a throttle lift', !ok.afterLift, '');
  check('Re-opens in the same zone, closes on the brake', ok.reopened && !ok.afterBrake, `CHANGED_DRS_OPEN ${ok.opens.join(',')}`);
  const no = drsRun(false);
  check('Not eligible at detection → stays shut', !no.openedInZone && !no.reopened && no.det?.eligible === false && no.opens.length === 0, JSON.stringify(no.det));
}

// ---------------------------------------------------------------------------
// 10. Barrier walls
// ---------------------------------------------------------------------------

console.log('\n== Barrier walls (Track_Collider_Wall_*)');
/** Does the CG path a → b cross any wall segment? */
const crossesWall = (walls: WallQuery, ax: number, az: number, bx: number, bz: number) => {
  const ids = new Int32Array(256);
  const n = walls.near(bx, bz, Math.hypot(bx - ax, bz - az) + 1, ids);
  const seg = walls.segments;
  const side = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  for (let k = 0; k < n; k++) {
    const o = ids[k] * 6;
    const cx = seg[o];
    const cz = seg[o + 1];
    const dx = seg[o + 2];
    const dz = seg[o + 3];
    if (side(ax, az, bx, bz, cx, cz) * side(ax, az, bx, bz, dx, dz) < 0 && side(cx, cz, dx, dz, ax, az) * side(cx, cz, dx, dz, bx, bz) < 0) return true;
  }
  return false;
};
{
  // A straight wall 2.5 m to the car's left (+X), hit at 10° and 200 km/h
  const wall: WallQuery = {
    segments: new Float32Array([2.5, -2000, 2.5, 2000, -1, 2]),
    near: (_x, _z, _r, out) => {
      out[0] = 0;
      return 1;
    },
  };
  const coast: VehicleInputs = { throttle: 0, brake: 0, steer: 0 };
  const ez = new THREE.Vector3();
  for (const deg of [10, 30]) {
    const impacts: number[] = [];
    const car = makeCar(flat, { walls: wall, onEvent: (e) => void (e.type === 'WALL_IMPACT' && impacts.push(e.speedMs)) });
    const free = makeCar(flat);
    car.reset(0, 0, deg * (Math.PI / 180), 200 / 3.6);
    free.reset(0, 0, deg * (Math.PI / 180), 200 / 3.6);
    let maxX = -Infinity;
    let maxVxAfter = -Infinity;
    run(car, 1, () => coast, (c, t) => {
      maxX = Math.max(maxX, c.position.x);
      if (t > 0.3) maxVxAfter = Math.max(maxVxAfter, c.velocity.x);
      return !finite(c);
    });
    run(free, 1, () => coast);
    ez.set(0, 0, 1).applyQuaternion(car.quaternion);
    const yawDeg = Math.atan2(ez.x, ez.z) * (180 / Math.PI);
    const scrubKmh = (free.speedMs - car.speedMs) * 3.6;
    check(
      `${deg}° hit: WALL_IMPACT, stays on its side`,
      impacts.length > 0 && impacts[0] > 2 && maxX < 2.5 - 0.3 && finite(car),
      `${impacts.length ? fmt(impacts[0], 1) : '—'} m/s into the wall, max CG x ${fmt(maxX, 2)} m (wall at 2.5)`
    );
    check(
      `${deg}° hit: deflected along the wall, speed scrubbed`,
      maxVxAfter < 0.5 && Math.abs(yawDeg) < 2 && scrubKmh > (deg < 20 ? 5 : 30),
      `into-wall speed after ${fmt(maxVxAfter, 2)} m/s, yaw ${fmt(yawDeg, 1)}°, ${fmt(scrubKmh, 0)} km/h lost vs free rolling`
    );
  }
}
{
  // Every surface a car can reach (out to the barriers) is free of steps; only the sausage kerbs stand proud.
  // Probed every metre along the lap and every 25 cm across, stopping 30 cm short of a wall.
  const walls = TrackWallQuery.fromTrackRoot(trackRoot);
  const hit = createGroundHit();
  const nearWalls = new Int32Array(64);
  let steps = 0;
  let probes = 0;
  let worst = 0;
  let worstAt = '—';
  for (let s = 0; s < track.totalLengthM; s += 1) {
    const smp = track.getSampleAtDistance(s);
    const bl = Math.hypot(smp.binormal.x, smp.binormal.z);
    for (const side of [-1, 1]) {
      let prevH = NaN;
      let prevSurface = '';
      for (let lat = 0; lat <= 40; lat += 0.25) {
        const x = smp.position.x + (smp.binormal.x / bl) * lat * side;
        const z = smp.position.z + (smp.binormal.z / bl) * lat * side;
        if (walls.near(x, z, 0.3, nearWalls) > 0 || !colliders.query(x, z, smp.position.y + 5, hit)) break;
        probes++;
        const step = Math.abs(hit.height - prevH);
        if (hit.surface !== 'sausage' && prevSurface !== 'sausage' && step > 0.06) {
          steps++;
          if (step > worst) {
            worst = step;
            worstAt = `s ${fmt(s, 0)} m, ${fmt(lat * side, 2)} m (${prevSurface} → ${hit.surface})`;
          }
        }
        prevH = hit.height;
        prevSurface = hit.surface;
      }
    }
  }
  // Between the track edges every contact is full-grip asphalt (no run-off or grass patch, pit exit included)
  let lowGrip = 0;
  let lowGripAt = '—';
  let edgeProbes = 0;
  for (let s = 0; s < track.totalLengthM; s += 1) {
    const smp = track.getSampleAtDistance(s);
    const bl = Math.hypot(smp.binormal.x, smp.binormal.z);
    const hw = smp.width / 2 - 0.05;
    for (let lat = -hw; lat <= hw; lat += 0.25) {
      const x = smp.position.x + (smp.binormal.x / bl) * lat;
      const z = smp.position.z + (smp.binormal.z / bl) * lat;
      const ok = colliders.query(x, z, smp.position.y + 5, hit);
      edgeProbes++;
      if (!ok || !['road', 'kerb', 'sausage', 'pitlane'].includes(hit.surface) || hit.grip < 0.95) {
        if (lowGrip++ === 0) lowGripAt = `s ${fmt(s, 0)} m, ${fmt(lat, 2)} m (${ok ? `${hit.surface}, grip ${hit.grip}` : 'no surface'})`;
      }
    }
  }
  check('Full grip everywhere between the track edges', lowGrip === 0, `${edgeProbes} probes, ${lowGrip} off-asphalt${lowGrip ? `, first at ${lowGripAt}` : ''}`);
  check(
    'No steps on any reachable surface (> 6 cm, sausage kerbs aside)',
    steps === 0 && probes > 100000,
    `${probes} probes, ${steps} steps${steps ? `, worst ${fmt(worst * 100, 0)} cm at ${worstAt}` : ''}`
  );
}
{
  // Rwanda colliders: aim at the left barrier of a straight at 20° and 160 km/h
  const walls = TrackWallQuery.fromTrackRoot(trackRoot);
  console.log(`      ${walls.segmentCount} wall segments`);
  let pick = track.samples[0];
  for (const s of track.samples) {
    const wl = s.wallLeftM ?? Infinity;
    if (Math.abs(s.curvature) < 0.002 && wl > 6 && wl < 14 && s.s > 300) {
      pick = s;
      break;
    }
  }
  const impacts: number[] = [];
  const car = makeCar(colliders, { walls, onEvent: (e) => void (e.type === 'WALL_IMPACT' && impacts.push(e.speedMs)) });
  const b = pick.binormal;
  const bl = Math.hypot(b.x, b.z);
  const x0 = pick.position.x - (b.x / bl) * 2;
  const z0 = pick.position.z - (b.z / bl) * 2;
  // Turning the heading toward +X of the body (left) by 20°
  const heading = Math.atan2(pick.tangent.x, pick.tangent.z) + 20 * (Math.PI / 180);
  car.reset(x0, z0, heading, 160 / 3.6);
  let crossed = false;
  let px = car.position.x;
  let pz = car.position.z;
  let minLat = Infinity;
  let hintS = pick.s;
  run(
    car,
    3,
    () => ({ throttle: 0.3, brake: 0, steer: 0 }),
    (c) => {
      if (crossesWall(walls, px, pz, c.position.x, c.position.z)) crossed = true;
      px = c.position.x;
      pz = c.position.z;
      const pr = track.projectWorldToTrack(px, pz, hintS);
      hintS = pr.s;
      minLat = Math.min(minLat, pr.lateralOffset);
      return crossed || !finite(c);
    }
  );
  check(
    'Rwanda barrier: impact, no pass-through',
    impacts.length > 0 && !crossed && finite(car),
    `s ${fmt(pick.s, 0)} m, wall ${fmt(pick.wallLeftM ?? Number.NaN, 1)} m left, ${impacts.length ? `${fmt(impacts[0], 1)} m/s impact` : 'no impact'}, min lateral ${fmt(minLat, 1)} m`
  );
  // Missed braking points: flat out at 300 km/h into the outside barriers of Turns 1 and 2, then drive away
  checkBarrierCrashes(check, 'f12026-car', track, walls, () => vehicleCrashCar(new F12026CarSim(track, trackRoot)));
}

// ---------------------------------------------------------------------------
// 11. Simulator adapter (F12026CarSim): track coordinates, autopilot laps on the colliders
// ---------------------------------------------------------------------------

console.log('\n== F12026CarSim (simulator adapter)');
{
  const sim = new F12026CarSim(track, trackRoot);
  const slot = RWANDA_SPAWN_GRID[0];
  check(
    'Grid slot 0: track coordinates',
    Math.abs(sim.sMeters - slot.s) < 2 && Math.abs(sim.lateralOffsetM - slot.lateral) < 0.3 && sim.onTrackColliders,
    `s ${fmt(sim.sMeters, 1)} / ${slot.s}, lateral ${fmt(sim.lateralOffsetM, 2)} / ${slot.lateral}`
  );
  const lat0 = sim.lateralOffsetM;
  sim.lateralOffsetM = lat0 - 1;
  const s0 = sim.sMeters;
  sim.sMeters = s0 - 3;
  check(
    'sMeters / lateralOffsetM setters move the car',
    Math.abs(sim.lateralOffsetM - (lat0 - 1)) < 0.1 && Math.abs(sim.sMeters - (s0 - 3)) < 0.1,
    `lateral ${fmt(sim.lateralOffsetM, 2)}, s ${fmt(sim.sMeters, 2)}`
  );
  sim.resetToStartGrid(true);
  check('Flying start', sim.telemetry.speedKmh > 260 && sim.telemetry.gear >= 6, `${fmt(sim.telemetry.speedKmh, 0)} km/h gear ${sim.telemetry.gear}`);
  sim.aiAutopilot = true;
  let t = 0;
  let maxLat = 0;
  const startLap = sim.telemetry.lapCount;
  // The first crossing of the line starts the timed lap
  while (t < 240 && sim.telemetry.lapCount < startLap + 1) {
    sim.step(1 / 60, {});
    t += 1 / 60;
    maxLat = Math.max(maxLat, Math.abs(sim.lateralOffsetM));
  }
  const tel = sim.telemetry;
  const ch = tel.f12026!;
  check(
    'Autopilot lap timed on the colliders',
    tel.lastLapTimeMs !== null && tel.lapCount === startLap + 1 && maxLat < 10,
    `lap ${tel.lastLapTimeMs !== null ? fmt(tel.lastLapTimeMs / 1000, 1) : '—'} s, max |lateral| ${fmt(maxLat, 1)} m`
  );
  // The same lap at any frame rate: the autopilot's controllers integrate over the real slice length
  {
    const lapAt = (hz: number) => {
      const c = new F12026CarSim(track, trackRoot);
      c.resetToStartGrid(true);
      c.aiAutopilot = true;
      const lap0 = c.telemetry.lapCount;
      let tt = 0;
      while (tt < 240 && c.telemetry.lapCount < lap0 + 2) {
        c.step(1 / hz, {});
        tt += 1 / hz;
      }
      return (c.telemetry.lastLapTimeMs ?? 0) / 1000;
    };
    const times = [60, 144, 234].map(lapAt);
    const spread = Math.max(...times) - Math.min(...times);
    check(
      'Autopilot lap does not depend on the frame rate',
      times.every((x) => x > 0) && spread < 1,
      `60 / 144 / 234 Hz: ${times.map((x) => fmt(x, 2)).join(' / ')} s (spread ${fmt(spread, 2)} s)`
    );
  }
  // At full pace (this car's own limit) it still keeps the car on the asphalt, in every assist preset
  for (const preset of ['assisted', 'pro'] as const) {
    const fast = new F12026CarSim(track, trackRoot);
    fast.assistPreset = preset;
    fast.resetToStartGrid(true);
    fast.aiAutopilot = true;
    fast.aiPaceScale = 1;
    const lap0 = fast.telemetry.lapCount;
    let tf = 0;
    let beyond = -Infinity;
    let maxSlip = 0;
    while (tf < 240 && fast.telemetry.lapCount < lap0 + 2) {
      fast.step(1 / 60, {});
      tf += 1 / 60;
      beyond = Math.max(beyond, Math.abs(fast.lateralOffsetM) - track.getSampleAtDistance(fast.sMeters).width / 2);
      maxSlip = Math.max(maxSlip, (Math.abs(Math.atan2(fast.vyMs, Math.max(1, fast.vxMs))) * 180) / Math.PI);
    }
    check(
      `Autopilot at full pace stays on the asphalt (${preset})`,
      fast.telemetry.lapCount === lap0 + 2 && beyond <= 0 && maxSlip < 10,
      `lap ${fmt((fast.telemetry.lastLapTimeMs ?? 0) / 1000, 1)} s, CG ${fmt(Math.max(0, beyond), 1)} m past the edge, max body slip ${fmt(maxSlip, 1)}°`
    );
  }
  check(
    'Engineering channels mapped',
    ch.drsOpenEvents > 0 && ch.AERO_BALANCE > 20 && ch.AERO_BALANCE < 60 && ch.AERO_HEIGHT > 0 && ch.drsDetection !== null,
    `AERO_BALANCE ${fmt(ch.AERO_BALANCE, 1)} %, AERO_HEIGHT ${fmt(ch.AERO_HEIGHT * 1000, 0)} mm, ${ch.drsOpenEvents} CHANGED_DRS_OPEN, last detection ${ch.drsDetection?.zone}`
  );
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll f12026-car checks passed.');
process.exit(failures.length ? 1 : 0);
