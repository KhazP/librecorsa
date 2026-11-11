/**
 * Powertrain checks for the rigid-body cars (`VehiclePhysics`): what the engine makes is what reaches the road.
 *
 *   npx tsx scripts/verify-powertrain.ts
 *
 * Each car's crank power curve is its wheel torque curve over the driveline efficiency, so at full throttle the wheels
 * must get the wheel curve back: the power the clutch passes to the driven wheels (plus what spins the engine up)
 * equals the curve at that rpm. On the overrun the drivetrain passes 1:1, and on the F1 the brake-by-wire lets the
 * harvest fill the rear axle's share of the pedal without ever exceeding it.
 */
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { compoundData, F12026_CAR_CONFIG, type CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { MTR_496R_CONFIG } from '../src/lib/sim/proto/Mtr496rConfig';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';
import { VF26_TUNED_CONFIG } from '../src/lib/sim/f12026-car/Vf26Tune';
import { Lut } from '../src/lib/sim/lut';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 3) => v.toFixed(d);
const DT = 1 / 500;
const makeCar = (config: CarPhysicsConfig, v0: number) => {
  const car = new VehiclePhysics({ ground: new FlatGroundQuery(0), config, airDensity: 1.2 });
  car.reset(0, 0, 0, v0);
  return car;
};

console.log('== Full throttle: the wheels get the wheel curve');
/**
 * Mean power into the driven wheels over the wheel curve at the same rpm, on a flat-out run from `v0` (m/s): from third
 * gear up, 0.8 s clear of a shift, off the limiter and without wheelspin. The engine's own spin-up is counted at the
 * wheel side (it takes the same driveline loss)
 */
function wheelPowerRatio(config: CarPhysicsConfig, v0: number): number {
  const car = makeCar(config, v0);
  const crankKw = new Lut(config.engine.powerCurve);
  const eff = config.gearbox.efficiency;
  const [dl, dr] = car.drivenWheels;
  let wheelKw = 0;
  let curveKw = 0;
  let sinceShift = 0;
  let gear = car.gear;
  let prevOmega = car.engineOmega;
  for (let i = 0; i < 45 / DT; i++) {
    car.step(DT, { throttle: 1, brake: 0, steer: 0 });
    const alpha = (car.engineOmega - prevOmega) / DT;
    prevOmega = car.engineOmega;
    if (car.gear !== gear) {
      gear = car.gear;
      sinceShift = 0;
    } else sinceShift++;
    if (i < 2 / DT || sinceShift < 0.8 / DT || car.gear < 3 || car.rpm > config.gearbox.gears.redline_rpm - 150) continue;
    const W = car.wheels;
    if (Math.max(Math.abs(W[dl].slipRatio), Math.abs(W[dr].slipRatio)) > 0.05) continue;
    wheelKw += (W[dl].driveTorqueNm * W[dl].omega + W[dr].driveTorqueNm * W[dr].omega + config.engine.inertia * car.engineOmega * alpha * eff) / 1000;
    curveKw += crankKw.evaluate(car.rpm) * eff;
  }
  return wheelKw / curveKw;
}
for (const [name, config, v0] of [
  ['GT3', AMG_GT3_CONFIG, 30],
  ['496R', MTR_496R_CONFIG, 40],
  ['Liana', SUZUKI_LIANA_CONFIG, 15],
] as const) {
  const r = wheelPowerRatio(config, v0);
  check(`${name}: wheel power is its wheel curve, within 1 %`, Math.abs(r - 1) < 0.01, `ratio ${fmt(r)}`);
}

console.log('\n== F1 on the brakes: harvest fills the rear axle\'s share, never more');
for (const brake of [0.15, 0.3]) {
  const cfg = F12026_CAR_CONFIG;
  const car = makeCar(cfg, 250 / 3.6);
  for (let i = 0; i < 1 / DT; i++) car.step(DT, { throttle: 1, brake: 0, steer: 0 });
  const rearTyre = compoundData(cfg, cfg.compoundSlots.soft).modelData;
  let rear = 0;
  let demand = 0;
  let drivetrain = 0;
  for (let i = 0; i < 0.8 / DT; i++) {
    car.step(DT, { throttle: 0, brake, steer: 0 });
    if (i < 0.3 / DT) continue;
    for (const k of [2, 3]) {
      const w = car.wheels[k];
      const rolling = w.fz * (rearTyre.rollingResistance + (rearTyre.rollingResistanceSpeedSq ?? 0) * w.vx * w.vx) * w.rollingRadius;
      // Caliper torque (the wheel's brake torque less its rolling resistance) plus what the drivetrain takes
      rear += w.brakeTorqueNm - rolling - w.driveTorqueNm;
      drivetrain += -w.driveTorqueNm;
    }
    demand += 2 * brake * cfg.brakes.maxTorqueNm * (1 - car.dynamicBrakeBias);
  }
  const ratio = rear / demand;
  check(`${Math.round(brake * 100)} % pedal: rear torque within 3 % of its share of the demand`, drivetrain / demand > 0.5 && Math.abs(ratio - 1) < 0.03,
    `ratio ${fmt(ratio)}, ${fmt((100 * drivetrain) / demand, 0)} % of it through the drivetrain`);
}

console.log('\n== Plain ramp differentials lock by their data');
/**
 * Lock share of a car's diff: the locking torque beyond the preload over the torque into the diff, on a flat-out run
 * (`power`) and lifted off in gear (`coast`), from the telemetry's locking torque and the driven wheels' drive torque
 */
function lockShares(config: CarPhysicsConfig, v0: number): { power: number; coast: number } {
  const preload = config.differential.settings.preload;
  const measure = (throttle: number) => {
    const car = makeCar(config, v0);
    const [dl, dr] = car.drivenWheels;
    let lock = 0;
    let into = 0;
    for (let i = 0; i < 3 / DT; i++) {
      car.step(DT, { throttle, brake: 0, steer: 0 });
      if (i < 1.5 / DT) continue;
      lock += car.telemetry.LSD_LOCKING_TORQUE - preload;
      into += Math.abs(car.wheels[dl].driveTorqueNm + car.wheels[dr].driveTorqueNm);
    }
    return lock / into;
  };
  return { power: measure(1), coast: measure(0) };
}
for (const [name, config, v0] of [
  ['GT3', AMG_GT3_CONFIG, 40],
  ['496R', MTR_496R_CONFIG, 50],
  ['Liana', SUZUKI_LIANA_CONFIG, 25],
] as const) {
  const want = config.differential.settings;
  const got = lockShares(config, v0);
  check(`${name}: locks ${want.power} on power and ${want.coast} on the overrun`, Math.abs(got.power - want.power) < 0.005 && Math.abs(got.coast - want.coast) < 0.005,
    `${fmt(got.power)} / ${fmt(got.coast)}`);
}

console.log('\n== In gear with no pedal: the car stays where it stands');
for (const [name, config] of [
  ['VF26', VF26_TUNED_CONFIG as unknown as CarPhysicsConfig],
  ['F1 2026', F12026_CAR_CONFIG as unknown as CarPhysicsConfig],
  ['GT3', AMG_GT3_CONFIG],
  ['496R', MTR_496R_CONFIG],
  ['Liana', SUZUKI_LIANA_CONFIG],
] as const) {
  // Standing on the grid in first gear for 20 s, feet off
  const grid = makeCar(config, 0);
  let moved = 0;
  for (let i = 0; i < 20 / DT; i++) {
    grid.step(DT, { throttle: 0, brake: 0, steer: 0 });
    moved = Math.max(moved, Math.abs(grid.speedMs));
  }
  check(`${name}: stands still on the grid, engine at its idle`, moved < 0.02 && grid.rpm > 0.9 * config.engine.idleRpm,
    `${fmt(moved * 3.6, 2)} km/h at most, ${grid.rpm.toFixed(0)} rpm`);
  // The pedal has the clutch back: off the line and past 60 km/h
  let to60 = NaN;
  for (let i = 0; i < 12 / DT && Number.isNaN(to60); i++) {
    grid.step(DT, { throttle: 1, brake: 0, steer: 0 });
    if (grid.speedMs * 3.6 >= 60) to60 = (i + 1) * DT;
  }
  check(`${name}: full pedal launches it from there`, to60 < 12, `60 km/h in ${fmt(to60, 2)} s`);
  // Braked to a stop from 60 km/h and let go: it stays stopped
  const stop = makeCar(config, 60 / 3.6);
  for (let i = 0; i < 8 / DT; i++) stop.step(DT, { throttle: 0, brake: 0.6, steer: 0 });
  // (the first seconds are the springs settling as the brakes come off)
  let after = 0;
  for (let i = 0; i < 10 / DT; i++) {
    stop.step(DT, { throttle: 0, brake: 0, steer: 0 });
    if (i >= 5 / DT) after = Math.max(after, Math.abs(stop.speedMs));
  }
  check(`${name}: braked to a stop and let go, it stays stopped`, after < 0.02, `${fmt(after * 3.6, 2)} km/h at most, 5 s on`);
}

console.log('\n== The VF26 off the line: the engine is held where it has torque');
{
  const cfg = VF26_TUNED_CONFIG as unknown as CarPhysicsConfig;
  const run = (pedal: number) => {
    const car = makeCar(cfg, 0);
    for (let i = 0; i < 1 / DT; i++) car.step(DT, { throttle: 0, brake: 1, steer: 0 });
    let to100 = NaN;
    let slip = 0;
    let rpmAt1s = 0;
    for (let i = 1; i <= 6 / DT; i++) {
      car.step(DT, { throttle: pedal, brake: 0, steer: 0 });
      if (i === Math.round(0.5 / DT)) rpmAt1s = car.rpm;
      if (Number.isNaN(to100) && car.speedMs * 3.6 >= 100) to100 = i * DT;
      slip = Math.max(slip, car.wheels[2].slipRatio, car.wheels[3].slipRatio);
    }
    return { to100, slip, rpmAt1s };
  };
  const most = run(0.8);
  check('four fifths of the pedal: half a second in the engine is past 5500 rpm, not at its idle', most.rpmAt1s > 5500, `${most.rpmAt1s.toFixed(0)} rpm`);
  check('... and it is at 100 km/h within 4 s, the rear wheels gripping', most.to100 < 4 && most.slip < 0.3, `${fmt(most.to100, 2)} s, slip ${fmt(most.slip, 2)} at most`);
  const full = run(1);
  check('the whole pedal with no traction control spins the rear wheels past their grip', full.slip > 0.3, `slip ${fmt(full.slip, 2)}`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll powertrain checks passed.');
if (failures.length) process.exitCode = 1;
