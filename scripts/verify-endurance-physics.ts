/**
 * Headless checks for the engine's multi-body and endurance features (`VehiclePhysics`, `F12026CarSim`): chassis
 * torsion, bump rubbers, strip contact, the rim and gas cavity, the tie rod's leverage, cold starts, the prototype's
 * carbon brakes and hybrid dials, the spark-first traction cut, the coolant, the wearing skid block, the garage's new
 * settings, and the sprint fuel ballast.
 *
 *   npx tsx scripts/verify-endurance-physics.ts
 *
 * `scripts/endurance-report.ts` prints the two endurance cars' numbers against their targets; this holds the
 * mechanisms themselves.
 */
import * as THREE from 'three';
import { VehiclePhysics, bumpRubberForce, computeBandLoadShares, stripLoadGrip, tyrePeakMu, createTyreRuntime, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { FlatGroundQuery, type GroundHit, type GroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { DEFAULT_SURFACE_TABLE } from '../src/lib/sim/track-surfaces';
import { compoundData, type CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { LC_LMDH_CONFIG } from '../src/lib/sim/proto/LcLmdhConfig';
import { createLcLmdhSim, LC_LMDH_SIM_PROFILE } from '../src/lib/sim/proto/LcLmdhSim';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';
import { buildDoubleWishboneHardpoints, solveCornerKinematics3D } from '../src/lib/sim/suspension-kinematics';
import { tyreGaugePressureOfGas } from '../src/lib/sim/tyre-pressure';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { DEFAULT_CHASSIS_SETUP } from '../src/lib/sim/car-setup';
import { createFlatTestTrack } from './lib/flat-track';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const GT3 = AMG_GT3_CONFIG as unknown as CarPhysicsConfig;
const LMDH = LC_LMDH_CONFIG as unknown as CarPhysicsConfig;
const make = (cfg: CarPhysicsConfig, ground: GroundQuery = flat) => new VehiclePhysics({ ground, config: cfg, airDensity: 1.18, ambientC: 25 });
const run = (car: VehiclePhysics, s: number, drive: (c: VehiclePhysics, t: number) => VehicleInputs) => {
  for (let t = 0; t < s; t += DT) car.step(DT, drive(car, t));
};
/**
 * Steady cornering at about 30 m/s on a slow steer ramp, held under the front tyres' limit (past it the fronts take no
 * more of the load transfer and its split stops meaning anything)
 */
const corner = (c: VehiclePhysics, t: number): VehicleInputs => ({ throttle: THREE.MathUtils.clamp(0.4 + (30 - c.speedMs) * 0.4, 0, 1), brake: 0, steer: Math.min(0.3, t / 3) });

console.log('\n== Chassis torsion');
{
  const withK = (k: number | null) => {
    const cfg = structuredClone(GT3);
    if (k === null) delete cfg.chassis.chassisTorsion;
    else cfg.chassis.chassisTorsion = { torsionalStiffnessNmPerDeg: k, torsionalDampingNmsPerDeg: 270, frontRollInertiaShare: 0.48 };
    const car = make(cfg);
    car.reset(0, 0, 0, 30);
    run(car, 5, corner);
    const W = car.wheels;
    const mF = Math.abs((W[0].fz - W[1].fz) * cfg.chassis.trackWidthFront);
    const mR = Math.abs((W[2].fz - W[3].fz) * cfg.chassis.trackWidthRear);
    return { pos: car.position.clone(), lltd: mF / (mF + mR), twistDeg: (car.chassisTwistRad * 180) / Math.PI, sane: car.stateIsSane() };
  };
  const rigid = withK(null);
  const huge = withK(1e9);
  const soft = withK(300);
  check('An infinitely stiff chassis drives as the rigid body', huge.pos.distanceTo(rigid.pos) < 1e-3 && Math.abs(huge.lltd - rigid.lltd) < 1e-4 && huge.sane,
    `${fmt(huge.pos.distanceTo(rigid.pos) * 1000, 3)} mm apart, LLTD ${fmt(huge.lltd, 4)} vs ${fmt(rigid.lltd, 4)}`);
  check('A soft chassis twists and moves load transfer toward the weight split', soft.sane && Math.abs(soft.twistDeg) > 0.01 && Math.abs(soft.lltd - 0.482) < Math.abs(rigid.lltd - 0.482),
    `twist ${fmt(soft.twistDeg, 3)}°, front LLTD ${fmt(soft.lltd, 3)} (rigid ${fmt(rigid.lltd, 3)})`);
}

console.log('\n== Bump rubbers');
{
  const bs = GT3.suspensions.front.bumpStop;
  const dampMax = (0.35 * GT3.chassis.unsprungMassFront) / 0.0005;
  const into = 0.01;
  const el = bs.rate * into + bs.progression * into * into;
  const at0 = bumpRubberForce(bs, into, 0, dampMax);
  const jump = Math.max(Math.abs(bumpRubberForce(bs, into, 1e-6, dampMax) - at0), Math.abs(bumpRubberForce(bs, into, -1e-6, dampMax) - at0));
  let negative = false;
  let slopeMax = 0;
  for (let v = -3; v <= 3; v += 0.001) {
    if (bumpRubberForce(bs, into, v, dampMax) < 0) negative = true;
    slopeMax = Math.max(slopeMax, Math.abs(bumpRubberForce(bs, into, v + 0.001, dampMax) - bumpRubberForce(bs, into, v, dampMax)) / 0.001);
  }
  check('At rest a rubber carries its whole elastic force', Math.abs(at0 - el) < 1e-6, `${fmt(at0, 0)} N`);
  check('Continuous through zero speed, never pulls', jump < 1 && !negative, `jump ${fmt(jump, 3)} N`);
  check('Its force never changes with speed faster than the hub step allows', slopeMax <= dampMax * 1.01, `${fmt(slopeMax, 0)} of ${fmt(dampMax, 0)} Ns/m`);
  check('Out of the rubber it gives back less than it took going in', bumpRubberForce(bs, into, -0.3, dampMax) < bumpRubberForce(bs, into, 0.3, dampMax) * 0.7,
    `${fmt(bumpRubberForce(bs, into, -0.3, dampMax), 0)} N extending, ${fmt(bumpRubberForce(bs, into, 0.3, dampMax), 0)} N squeezing at 0.3 m/s`);
}

console.log('\n== Strip contact');
{
  const even = stripLoadGrip([1 / 3, 1 / 3, 1 / 3], 1, 1, 1, 1);
  const shoulder = stripLoadGrip([0.55, 0.3, 0.15], 1, 1, 1, 1);
  const held = stripLoadGrip([0.5933, 1 / 3, 0.0733], 1, 1, 1, 1);
  check('An even patch grips as the whole tyre', Math.abs(even - 1) < 1e-12, fmt(even, 6));
  // Σ s·(3s)^−0.085: 1 % for [0.55, 0.30, 0.15], 1.9 % with the camber shift held at its limit
  check('Load piled on a shoulder costs grip by Fz^−0.085', Math.abs(shoulder - 0.9903) < 2e-4 && Math.abs(held - 0.9816) < 2e-4,
    `${fmt(shoulder, 4)} and ${fmt(held, 4)}`);
  // The strips' shares: camber × 6.5 onto the inner strip (held to ±0.26), the crown onto the middle strip (held to
  // −0.20 / +0.22), floors of 0.14 in the middle and 0.06 on the shoulders
  const sh: [number, number, number] = [0, 0, 0];
  const at = (camDeg: number, psi = 26, crown = 0, growthM = 0) => {
    computeBandLoadShares(sh, camDeg * (Math.PI / 180), psi, 26, crown, growthM);
    return [...sh];
  };
  const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 5e-4);
  const shares = (a: number[]) => a.map((x) => fmt(x, 3)).join(' / ');
  const flat = at(0);
  check('Flat, at the optimum pressure: three even strips', near(flat, [1 / 3, 1 / 3, 1 / 3]), shares(flat));
  const c12 = at(1.2);
  check('−1.2° camber moves 0.136 onto the inner strip', near(c12, [0.4695, 1 / 3, 0.1972]), shares(c12));
  const c35 = at(3.5);
  check('−3.5° camber: the shift held at 0.26', near(c35, [0.5933, 1 / 3, 0.0733]), shares(c35));
  const over = at(0, 28.6, 0.62);
  check('10 % over-inflated (crown 0.62): 0.062 onto the middle strip', near(over, [0.3023, 0.3953, 0.3023]), shares(over));
  const under = at(0, 23.4, 0.62);
  check('10 % under-inflated: the shoulders take it', near(under, [0.3643, 0.2713, 0.3643]), shares(under));
  const spun = at(0, 26, 0, 0.004);
  check('4 mm of centrifugal growth crowns the middle strip by 0.048', near(spun, [0.3093, 0.3813, 0.3093]), shares(spun));
}

console.log('\n== Rim and gas');
{
  // The spec's own figures: 135 kPa cold at 25 °C, the gas at 91.5 °C, the carcass stretching 0.0018 a psi
  const hot = tyreGaugePressureOfGas(19.58, 25, 91.5, 0.0018);
  check('135 kPa cold reaches ≈ 26.66 psi with the gas at 91.5 °C', Math.abs(hot - 26.66) < 0.05, `${fmt(hot)} psi`);
  // Hard braking heats the discs, the discs the rims, the rims the gas
  const car = make(GT3);
  car.coldGarageStart = true;
  car.reset(0, 0, 0, 60);
  const rim0 = car.wheels[0].rimTempC;
  for (let i = 0; i < 6; i++) {
    run(car, 2.5, () => ({ throttle: 0, brake: 0.5, steer: 0 }));
    run(car, 5, () => ({ throttle: 1, brake: 0, steer: 0 }));
  }
  check('The brakes heat the rims, which heat the gas', car.wheels[0].rimTempC > rim0 + 5 && car.wheels[0].gasTempC > 30,
    `rim ${fmt(rim0, 0)} → ${fmt(car.wheels[0].rimTempC, 0)} °C, gas ${fmt(car.wheels[0].gasTempC, 0)} °C, disc ${fmt(car.wheels[0].brakeDisc.surfaceTempC, 0)} °C`);
  // A compound without rim data rides on a typical racing wheel: its brakes heat its rims and gas the same way
  const f1 = make(F12026_CAR_CONFIG as unknown as CarPhysicsConfig);
  f1.reset(0, 0, 0, 60);
  const f1Rim0 = f1.wheels[0].rimTempC;
  for (let i = 0; i < 6; i++) {
    run(f1, 2.5, () => ({ throttle: 0, brake: 0.5, steer: 0 }));
    run(f1, 5, () => ({ throttle: 1, brake: 0, steer: 0 }));
  }
  check('A compound without rim data gets a typical wheel, heated by its brakes', f1.wheels[0].rimTempC > f1Rim0 + 5,
    `rim ${fmt(f1Rim0, 0)} → ${fmt(f1.wheels[0].rimTempC, 0)} °C, gas ${fmt(f1.wheels[0].gasTempC, 0)} °C`);
}

console.log('\n== Tie-rod leverage');
{
  for (const [name, cfg] of [['GT3', GT3], ['LC-LMDH', LMDH], ['f12026', F12026_CAR_CONFIG as unknown as CarPhysicsConfig]] as const) {
    const s = cfg.suspensions.front;
    const hp = buildDoubleWishboneHardpoints(s.hardpoints, true, s.actuation, { geometry: s.actuation === 'pull_rod' ? 'f1' : 'gt3' });
    const r = compoundData(cfg, cfg.compoundSlots.soft).front.radius;
    const at0 = solveCornerKinematics3D(hp, 0, 0, true, r).tieRodLeverageNorm;
    const inner = solveCornerKinematics3D(hp, 0, 0.3, true, r).tieRodLeverageNorm;
    const outer = solveCornerKinematics3D(hp, 0, 0.3, false, r).tieRodLeverageNorm;
    check(`${name}: 1 straight ahead, changing with lock`, Math.abs(at0 - 1) < 1e-9 && Math.abs(inner - outer) > 0.01, `${fmt(at0, 3)} / ${fmt(inner, 3)} / ${fmt(outer, 3)}`);
  }
}

const pad = createFlatTestTrack(40_000, 3000);

console.log('\n== Cold starts');
{
  const start = (make: typeof createAmgGt3Sim | typeof createLcLmdhSim, level: 'full' | 'standard', how: 'garage' | 'flying' | 'race') => {
    const sim = make(pad, null);
    sim.setSimRealism(SIM_REALISM_FLAGS[level]);
    sim.resetToStartGrid(how === 'flying', 0, undefined, how === 'race');
    const v = (sim as unknown as { vehicle: VehiclePhysics }).vehicle;
    return { tyre: v.wheels[0].coreTempC, disc: v.wheels[0].brakeDisc.surfaceTempC, psi: v.wheels[0].pressurePsi };
  };
  const g = start(createAmgGt3Sim, 'full', 'garage');
  const gf = start(createAmgGt3Sim, 'full', 'flying');
  const gr = start(createAmgGt3Sim, 'full', 'race');
  const gs = start(createAmgGt3Sim, 'standard', 'garage');
  check('Full realism: the GT3 leaves the garage on cold tyres and brakes', g.tyre < 32 && g.disc < 40, `${fmt(g.tyre, 0)} °C tyres, ${fmt(g.disc, 0)} °C discs, ${fmt(g.psi, 1)} psi`);
  check('A flying start and a race grid are warm (a formation lap)', gf.tyre >= 75 && gf.disc > 150 && gr.tyre >= 75 && gr.disc > 150, `${fmt(gf.tyre, 0)} / ${fmt(gr.tyre, 0)} °C tyres`);
  check('Standard realism warms them out of the garage', gs.tyre >= 75 && gs.disc > 150, `${fmt(gs.tyre, 0)} °C, ${fmt(gs.disc, 0)} °C`);
  const l = start(createLcLmdhSim, 'full', 'garage');
  check('Full realism: the LC-LMDH out of the garage on 35 °C carbon', l.disc < 40 && l.tyre < 32, `${fmt(l.tyre, 0)} °C tyres, ${fmt(l.disc, 0)} °C discs`);
}

console.log('\n== Carbon brakes');
{
  const stop = (hot: boolean) => {
    const car = make(LMDH);
    car.coldGarageStart = !hot;
    car.reset(0, 0, 0, 200 / 3.6);
    if (hot) for (const w of car.wheels) w.brakeDisc.surfaceTempC = w.brakeDisc.coreTempC = 450;
    const z0 = car.position.z;
    let pedal = 1;
    for (let t = 0; t < 15 && car.telemetry.speedKmh > 2; t += DT) {
      const sr = Math.min(...car.wheels.map((w) => w.slipRatio));
      pedal = THREE.MathUtils.clamp(pedal + (sr < -0.11 ? -0.08 : 0.04), 0.15, 1);
      car.step(DT, { throttle: 0, brake: pedal, steer: 0 });
    }
    return car.position.z - z0;
  };
  const hot = stop(true);
  const cold = stop(false);
  check('Cold carbon out of the garage stops 10–50 % longer from 200 km/h', cold > hot * 1.1 && cold < hot * 1.5, `${fmt(cold, 1)} m cold, ${fmt(hot, 1)} m hot`);
  const disc = make(LMDH);
  disc.reset(0, 0, 0, 80);
  const t0 = disc.wheels[0].brakeDisc.discThicknessMm;
  for (let i = 0; i < 4; i++) {
    run(disc, 3, () => ({ throttle: 0, brake: 1, steer: 0 }));
    run(disc, 6, () => ({ throttle: 1, brake: 0, steer: 0 }));
  }
  check('Braking wears the discs', disc.wheels[0].brakeDisc.discThicknessMm < t0, `${fmt(t0 - disc.wheels[0].brakeDisc.discThicknessMm, 5)} mm`);
}

console.log('\n== Hybrid dials and the traction cut');
{
  // Throttle and brake cycles: the battery swings about its target and comes back to it lap after lap
  const car = make(LMDH);
  car.reset(0, 0, 0, 60);
  const store = LMDH.ers.ERS_MAX_CHARGE;
  car.ersEnergyJ = 0.5 * store;
  let deployed = 0;
  const lap = () => {
    for (let t = 0; t < 14; t += DT) {
      car.step(DT, { throttle: 1, brake: 0, steer: 0 });
      deployed += Math.max(0, car.telemetry.MGUK_POWER) * DT;
    }
    for (let t = 0; t < 3.5; t += DT) car.step(DT, { throttle: 0, brake: 0.8, steer: 0 });
    return car.ersEnergyJ / store;
  };
  lap();
  const a = lap();
  const b = lap();
  check('40 / 170 kW: the battery comes back within 8 % a cycle', Math.abs(b - a) < 0.08 && deployed > 0, `${fmt(a * 100, 1)} → ${fmt(b * 100, 1)} %, ${fmt(deployed / 1e6, 2)} MJ deployed`);
  // Under the shaft limit (fourth gear at 4500 rpm) half the traction cut's allowance takes half the drive away
  const pull = (cut: number) => {
    const c = make(LMDH);
    c.reset(0, 0, 0, 140 / 3.6);
    c.autoShift = false;
    c.ersEnergyJ = store;
    run(c, 1.5, (cc) => ({ throttle: 1, brake: 0, steer: 0, shiftUp: cc.gear < 4, shiftDown: cc.gear > 4, ignitionCut: cut }));
    return c.driveshaftPowerW;
  };
  const full = pull(1);
  const half = pull(0.5);
  check('The spark-first cut takes off what the traction control asks for', Math.abs(half / full - 0.5) < 0.08, `${fmt(half / 1000, 0)} of ${fmt(full / 1000, 0)} kW at half allowance`);
  // Held, a deep cut keeps to what it asks for: the split goes by the drive before the cut. Read back after it, each step
  // counted the cut as the motor's larger share and took more, down to half the 30 % allowed. Shaft power against the
  // uncut car's at the same road speed, 1.5 s into the cut
  const held = (cut: number) => {
    const c = make(LMDH);
    c.reset(0, 0, 0, 140 / 3.6);
    c.autoShift = false;
    c.ersEnergyJ = store;
    const into4 = (cc: VehiclePhysics, allow: number): VehicleInputs => ({ throttle: 1, brake: 0, steer: 0, shiftUp: cc.gear < 4, shiftDown: cc.gear > 4, ignitionCut: allow });
    run(c, 0.6, (cc) => into4(cc, 1));
    const out: { v: number; p: number }[] = [];
    run(c, 1.5, (cc) => {
      out.push({ v: cc.speedMs, p: cc.driveshaftPowerW });
      return into4(cc, cut);
    });
    return out;
  };
  const ref = held(1);
  const deep = held(0.3);
  const last = deep[deep.length - 1];
  const k = ref.findIndex((x) => x.v >= last.v);
  const r0 = ref[Math.max(0, k - 1)];
  const r1 = ref[Math.max(0, k)];
  const refP = r0.p + ((r1.p - r0.p) * (last.v - r0.v)) / Math.max(1e-9, r1.v - r0.v);
  check('A cut held for 1.5 s at 30 % allowance leaves 24–36 % of the drive', Math.abs(last.p / refP - 0.3) < 0.06, `${fmt(last.p / 1000, 0)} of ${fmt(refP / 1000, 0)} kW at ${fmt(last.v * 3.6, 0)} km/h`);
}

console.log('\n== Coolant');
{
  const flatOut = (radiator: number) => {
    const car = make(GT3);
    car.reset(0, 0, 0, 75);
    car.coolingSteps = { brakeDuctFront: 0, brakeDuctRear: 0, radiator };
    run(car, 240, () => ({ throttle: 1, brake: 0, steer: 0 }));
    return car.coolantTempC;
  };
  const base = flatOut(0);
  const taped = flatOut(-2);
  check('A baseline radiator holds under the derate flat out', base < 112, `${fmt(base, 0)} °C`);
  check('Taped two steps it runs hotter and past the derate', taped > base + 10 && taped > 112, `${fmt(taped, 0)} °C`);
}

console.log('\n== Skid block');
{
  // A 60 mm hump between the wheels: the plank rides over it, the wheels either side
  class Hump implements GroundQuery {
    readonly smooth = true;
    readonly stateless = true;
    query(x: number, z: number, probeY: number, out: GroundHit): boolean {
      const h = Math.abs(x) < 0.4 && z > 10 && z < 40 ? 0.06 : 0;
      if (h > probeY) return false;
      out.height = h;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      out.surface = 'road';
      out.grip = DEFAULT_SURFACE_TABLE.road.friction;
      out.props = DEFAULT_SURFACE_TABLE.road;
      out.source = 'flat';
      return true;
    }
  }
  const car = make(LMDH, new Hump());
  car.reset(0, 0, 0, 25);
  run(car, 2, () => ({ throttle: 0.3, brake: 0, steer: 0 }));
  const worn = Math.max(...car.plankWearMm);
  check('Riding over a hump wears the skid, never past its margin', worn > 0 && worn <= (LMDH.aero.plankPhysics?.initialWearMarginMm ?? 0), `${fmt(worn, 4)} mm`);
}

console.log('\n== Garage and fuel');
{
  const lmdh = createLcLmdhSim(pad, null);
  lmdh.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, arbRearPct: -100, gearRatioSet: 1, cornerPackerRearMm: 4 });
  const c = (lmdh as unknown as { config: CarPhysicsConfig }).config;
  check('LC-LMDH: the rear bar detaches, the long gears go in, packers add up', c.suspensions.rear.arb === 0 && c.gearbox.finalDrive === 3 && Math.abs((c.suspensions.rear.bumpStop.packerGap ?? 0) - 0.012) < 1e-9,
    `bar ${c.suspensions.rear.arb} N/m, final drive ${c.gearbox.finalDrive}, rear packers ${fmt((c.suspensions.rear.bumpStop.packerGap ?? 0) * 1000, 0)} mm`);
  const liana = createSuzukiLianaSim(pad, null);
  liana.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, arbFrontPct: -100 });
  const lc = (liana as unknown as { config: CarPhysicsConfig }).config;
  check('A car without a detachable bar keeps half of it', Math.abs(lc.suspensions.front.arb - SUZUKI_LIANA_CONFIG.suspensions.front.arb * 0.5) < 1, `${fmt(lc.suspensions.front.arb, 0)} N/m`);
  lmdh.assistPreset = 'semi_pro';
  lmdh.setLiveTuner({ absLevel: 8 });
  const lmdhAbs = lmdh.absLevel;
  // A class without ABS (`absAllowed: false`, which no car sets now): only Assisted runs one
  const noAbs = new F12026CarSim(pad, null, { ...LC_LMDH_SIM_PROFILE, absAllowed: false });
  noAbs.assistPreset = 'semi_pro';
  noAbs.setLiveTuner({ absLevel: 8 });
  const banned = noAbs.absLevel;
  noAbs.assistPreset = 'assisted';
  noAbs.setLiveTuner({ absLevel: 8 });
  check('LC-LMDH: ABS on semi-pro; a class without it runs one only on Assisted', lmdhAbs === 8 && banned === 0 && noAbs.absLevel === 8, `${lmdhAbs} / ${banned} / ${noAbs.absLevel}`);
  const fuel = createAmgGt3Sim(pad, null);
  fuel.setSimRealism(SIM_REALISM_FLAGS.full);
  fuel.teleportToDistance(1000, 0);
  const f0 = fuel.telemetry.fuelKg;
  for (let t = 0; t < 30; t += DT) fuel.step(DT, { throttle: 1 });
  check('Full realism: the 30 kg sprint ballast stays aboard', f0 === 30 && fuel.telemetry.fuelKg === 30, `${fmt(f0, 1)} → ${fmt(fuel.telemetry.fuelKg, 1)} kg`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll endurance physics checks passed.');
if (failures.length) process.exit(1);
