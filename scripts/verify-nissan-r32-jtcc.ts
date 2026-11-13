/**
 * Headless checks for the Nissan Skyline GT-R R32 JTCC (`src/lib/sim/classic`): the f12026-car vehicle model on
 * gregsediting's Assetto Corsa data, a twin-turbo Group A car with rear-biased four-wheel drive (AC's AWD2 layout).
 *
 *   npx tsx scripts/verify-nissan-r32-jtcc.ts
 *
 * At rest, the engine and its turbos, the aero against speed, straight line, braking and cornering on flat ground, the
 * four-wheel drive (the torque split held at speed, the fronts picking up drive as the rears spin, no fight between
 * the axles), the shifts, the driver aids through the simulator adapter, then autopilot laps of Rwanda against the GT3's.
 * The ranges are what the mod's data gives in Assetto Corsa terms, not tuned to these numbers.
 */
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { turboSteadyBoost, type CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { NISSAN_R32_CONFIG } from '../src/lib/sim/classic/NissanR32Config';
import { NISSAN_R32_PROFILE_CAR, NISSAN_R32_SIM_PROFILE, createNissanR32Sim } from '../src/lib/sim/classic/NissanR32Sim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';
import { downshiftTakenAt, measureDownshift, measureUpshift } from './lib/upshift-test';
import { evaluateBrakePadMuFactor } from '../src/lib/sim/brake-physics';
import { plannedMu } from '../src/lib/sim/speed-profile';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const C = NISSAN_R32_CONFIG;
/** The same car driving its rears only: the coupling taken out */
const RWD: CarPhysicsConfig = { ...C, awd: undefined };

const makeCar = (cfg: CarPhysicsConfig = C) => new VehiclePhysics({ ground: flat, config: cfg, airDensity: 1.225 });

function run(car: VehiclePhysics, seconds: number, drive: (car: VehiclePhysics, t: number) => VehicleInputs, each?: (car: VehiclePhysics, t: number) => boolean | void): number {
  let t = 0;
  while (t < seconds) {
    car.step(DT, drive(car, t));
    t += DT;
    if (each?.(car, t)) break;
  }
  return t;
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const axleOmega = (car: VehiclePhysics, front: boolean) => 0.5 * (car.wheels[front ? 0 : 2].omega + car.wheels[front ? 1 : 3].omega);

console.log('\n== R32 config');
{
  const awd = C.awd;
  check('Rear-biased four-wheel drive, five gears, 8000 rpm limiter', !('drivenAxle' in C) && awd !== undefined && C.gearbox.ratios.length === 5 && C.gearbox.gears.redline_rpm === 8000, '');
  check('Centre coupling 100 Nm per rad/s up to 1000 Nm; front diff 3 %, rear 60 / 50 % + 10 Nm',
    awd.centre.rampNmPerRadS === 100 && awd.centre.maxTorqueNm === 1000 && awd.secondaryDiff.power === 0.03 && C.differential.settings.power === 0.6 && C.differential.settings.coast === 0.5 && C.differential.settings.preload === 10, '');
  check('No hybrid, brake-by-wire, ABS or TC of its own; splitter, wing and lip', C.ers.ERS_MAX_DEPLOY === 0 && C.brakes.brakeByWire === false && C.aero.wings.length === 3, '');
  const car = makeCar();
  check('The engine drives the rears, the coupling the fronts', car.drivenWheels.join() === '2,3' && car.coupledWheels?.join() === '0,1' && car.allDrivenWheels.join() === '2,3,0,1',
    `driven ${car.drivenWheels.join(', ')}, coupled ${car.coupledWheels?.join(', ')}`);
}

console.log('\n== Engine and turbos');
{
  const t = C.engine.turbo;
  // Two turbos, each MAX_BOOST 2 × (rpm / 6000)^2.5 held to WASTEGATE 0.48: torque × (1 + the sum)
  const ac = (rpm: number) => 2 * Math.min(0.48, 2 * (rpm / 6000) ** 2.5);
  const rpms = [1000, 2000, 3000, 3390, 5000, 8000];
  const worst = Math.max(...rpms.map((r) => Math.abs(turboSteadyBoost(t, r) - ac(r))));
  check('Steady boost matches the two AC turbos (0.96 from 3390 rpm)', worst < 2e-3, rpms.map((r) => `${r}: ${fmt(turboSteadyBoost(t, r), 3)}`).join(', '));
  // The wheel torque the curve gives at full boost: power.lut × 1.96
  const wheelNm = (rpm: number) => {
    const kw = C.engine.powerCurve.find(([r]) => r === rpm)![1];
    return ((kw * 1000) / ((rpm * Math.PI) / 30)) * C.gearbox.efficiency;
  };
  check('470 Nm at the wheels at 6750 rpm, 419 at 8000 (power.lut × 1.96)', Math.abs(wheelNm(6750) - 470.4) < 0.5 && Math.abs(wheelNm(8000) - 419.4) < 0.5,
    `${fmt(wheelNm(6750), 1)} / ${fmt(wheelNm(8000), 1)} Nm; peak crank ${fmt(Math.max(...C.engine.powerCurve.map(([, kw]) => kw)), 0)} kW`);

  // Spool: from a closed throttle at 6000 rpm in fourth, the boost takes ≈ 0.6 s (AC's LAG_UP at 333 Hz) to 63 %
  const car = makeCar();
  car.reset(0, 0, 0, 0);
  car.autoShift = false;
  car.gear = 4;
  car.reset(0, 0, 0, (6000 / 60 / 4.111) * 2 * Math.PI * 0.342 * 1.0);
  car.gear = 4;
  run(car, 1, () => ({ throttle: 0, brake: 0, steer: 0 }));
  let t63 = NaN;
  run(car, 2, () => ({ throttle: 1, brake: 0, steer: 0 }), (c, tt) => {
    if (Number.isNaN(t63) && c.turboBoostBar - 1 >= 0.63 * 0.96) t63 = tt;
  });
  check('Boost builds to 63 % in 0.35–0.8 s from a lift at 6000 rpm', t63 > 0.35 && t63 < 0.8, `${fmt(t63, 2)} s (rpm ${fmt(car.rpm, 0)})`);
}

console.log('\n== At rest');
{
  const car = makeCar();
  car.reset(0, 0, 0);
  run(car, 3, () => ({ throttle: 0, brake: 1, steer: 0 }));
  const t = car.telemetry;
  const fz = car.wheels.map((w) => w.fz);
  const front = (fz[0] + fz[1]) / fz.reduce((a, b) => a + b, 0);
  // CG_LOCATION places the sprung mass, 59 % forward; the hubs (48 / 50 kg) sit on their axles: 57.5 % of the whole car
  const ch = C.chassis;
  const expected = ((ch.totalMassKg - 2 * ch.unsprungMassFront - 2 * ch.unsprungMassRear) * ch.frontWeightFraction + 2 * ch.unsprungMassFront) / ch.totalMassKg;
  check('Front axle carries ≈ 57.5 % of the weight (59 % of the sprung)', Math.abs(front - expected) < 0.005, `${fmt(front * 100, 1)} % (${fmt(expected * 100, 1)} expected)`);
  // The pickups 0.39 m under the CG's level, the body 0.486 / 0.477 m up at the axles: 96 / 87 mm
  check("Rides at the mod's 96 / 87 mm", Math.abs(t.aeroHeightFront - 0.096) < 0.004 && Math.abs(t.aeroHeightRear - 0.087) < 0.004,
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
    return { clA: t.downforceN / q, cdA: t.dragN / q, bal: t.AERO_BALANCE };
  };
  const slow = at(100);
  const fast = at(250);
  // Splitter (its ground-effect table read past its end), wing at 12° and lip at 22°
  check('CL·A 0.5–0.7 m² from 100 to 250 km/h', slow.clA > 0.5 && slow.clA < 0.7 && fast.clA > 0.5 && fast.clA < 0.7, `${fmt(slow.clA)} m² at 100, ${fmt(fast.clA)} m² at 250 km/h`);
  // Body 0.644, wing 0.083, lip 0.153
  check('CD·A 0.84–0.92 m²', slow.cdA > 0.84 && slow.cdA < 0.92 && fast.cdA > 0.84 && fast.cdA < 0.92, `${fmt(slow.cdA)} / ${fmt(fast.cdA)} m²`);
  // The splitter ahead of the front axle, the wings 0.7 m behind the rear one
  check('Aero balance 12–26 % front', slow.bal > 12 && slow.bal < 26 && fast.bal > 12 && fast.bal < 26, `${fmt(slow.bal, 1)} / ${fmt(fast.bal, 1)} %`);
}

const pad = createFlatTestTrack(30_000, 3000);

console.log('\n== Straight line through the adapter');
{
  const sim = createNissanR32Sim(pad);
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
  // 1335 kg on ≈ 350 kW at full boost, held back off the line: the data's auto clutch closes by 1800 rpm, under the
  // 2100 rpm idle, so the engine pulls away from there with next to no boost, and the 240 ms change into second at
  // 74 km/h spins the rears
  check('0-100 km/h 4.2–5.8 s on a flat-out start', t100 > 4.2 && t100 < 5.8, `${fmt(t100)} s, 0-200 ${fmt(t200)} s`);
  // ≈ 351 kW at the wheels against CD·A ≈ 0.88 m²; fifth runs to ≈ 340 km/h at the limiter
  check('Top speed 290–315 km/h', vmax > 290 && vmax < 315, `${fmt(vmax, 1)} km/h`);
}

console.log('\n== Braking through the adapter');
{
  const stop = (preset: 'pro' | 'semi_pro') => {
    const sim = createNissanR32Sim(pad);
    sim.assistPreset = preset;
    sim.teleportToDistance(1000, 200 / 3.6);
    const s0 = sim.sMeters;
    let lock = 0;
    let peakG = 0;
    for (let t = 0; t < 12 && sim.telemetry.speedKmh > 1; t += DT) {
      sim.step(DT, { brake: 1 });
      if (sim.telemetry.speedKmh > 30) lock = Math.max(lock, -Math.min(...sim.telemetry.wheelSlipRatios));
      peakG = Math.max(peakG, -sim.vehicle.telemetry.lonG);
    }
    return { dist: sim.sMeters - s0, lock, peakG };
  };
  const raw = stop('pro');
  const abs = stop('semi_pro');
  // 2800 Nm on R 0.342 m: 16.4 kN, 1.25 g before drag, less than the slicks hold, so even a stamp stays off the lock
  check('A stamp on 2800 Nm brakes: torque-limited, the wheels keep turning', raw.lock < 0.2, `max lock ${fmt(raw.lock, 2)}, ${fmt(raw.dist, 0)} m, ${fmt(raw.peakG, 2)} g peak`);
  check('200→0 km/h in 115–135 m', raw.dist > 115 && raw.dist < 135 && Math.abs(abs.dist - raw.dist) < 5, `${fmt(raw.dist, 1)} m (semi-pro ABS ${fmt(abs.dist, 1)} m)`);

  const pm = NISSAN_R32_PROFILE_CAR;
  let planned = 0;
  for (let v = 200 / 3.6; v > 1; v -= 0.05) {
    const grip = plannedMu(pm, pm.muLong, v) * (9.81 + (pm.downforceCoef * v * v) / pm.massKg);
    const decel = Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg;
    planned += (v * 0.05) / decel;
  }
  check('Braking line never plans shorter than the car stops', planned >= abs.dist, `${fmt(planned, 1)} m planned vs ${fmt(abs.dist, 1)} m stopped`);
}

console.log('\n== Cornering (flat, steer ramp at constant speed)');
// Slicks out of 60 °C blankets at a corner's loads
// (DY_CURVE ≈ 1.53–1.56 at 4 kN, ≈ 1.37 on the loaded outer front at 6 kN); the 0.59 m² of CL·A puts 81 % of its
// load on the rears, so the understeering front gains little with speed
for (const [kmh, lo, hi] of [
  [100, 1.3, 1.55],
  [180, 1.3, 1.6],
] as const) {
  const car = makeCar();
  car.reset(0, 0, 0, kmh / 3.6);
  let maxLat = 0;
  let pedal = 0.3;
  let frontSa = 0;
  let rearSa = 0;
  let coupling = 0;
  run(car, 12, (c, t) => {
    pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    return { throttle: pedal, brake: 0, steer: -Math.min(1, t / 12) * 0.5 };
  }, (c) => {
    const lat = Math.abs(c.telemetry.latG);
    if (lat > maxLat) {
      maxLat = lat;
      frontSa = 0.5 * (Math.abs(c.wheels[0].slipAngleRad) + Math.abs(c.wheels[1].slipAngleRad));
      rearSa = 0.5 * (Math.abs(c.wheels[2].slipAngleRad) + Math.abs(c.wheels[3].slipAngleRad));
      coupling = c.centreCouplingTorqueNm;
    }
    const beta = Math.atan2(c.velocity.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion)), c.velocity.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion)));
    return Math.abs(beta) > 0.35;
  });
  check(`Peak lateral at ${kmh} km/h ${lo}–${hi} g`, maxLat > lo && maxLat < hi, `${fmt(maxLat, 2)} g, coupling ${fmt(coupling, 0)} Nm at the peak`);
  // 59 % of the weight on the front, ≈ 19 % of the downforce: the fronts give first
  check(`Understeers at the limit at ${kmh} km/h`, frontSa > rearSa, `front ${fmt((frontSa * 180) / Math.PI, 1)}°, rear ${fmt((rearSa * 180) / Math.PI, 1)}° slip at the peak`);
}

console.log('\n== Four-wheel drive');
{
  // Held speed: the rears' small drive slip against the fronts' rolling, less what the fronts' smaller loaded radius
  // takes back, hands the fronts a small share. A gentle pedal holds the speed; the coupling settles with the car, never
  // at its stops, and the axles' speed difference doesn't hunt
  for (const kmh of [80, 160, 240]) {
    const car = makeCar();
    car.reset(0, 0, 0, kmh / 3.6);
    let trim = 0.3;
    const x: number[] = [];
    const total: number[] = [];
    const dw: number[] = [];
    run(car, 14, (c) => {
      const err = kmh - c.telemetry.speedKmh;
      trim = THREE.MathUtils.clamp(trim + 0.0004 * err, 0, 1);
      return { throttle: THREE.MathUtils.clamp(trim + 0.03 * err, 0, 1), brake: 0, steer: 0 };
    }, (c, t) => {
      if (t < 9) return;
      x.push(c.centreCouplingTorqueNm);
      total.push(c.wheels.reduce((sum, w) => sum + w.driveTorqueNm, 0));
      dw.push(axleOmega(c, false) - axleOmega(c, true));
    });
    const share = mean(x) / mean(total);
    const ripple = Math.sqrt(mean(x.map((v) => (v - mean(x)) ** 2)));
    const dwRipple = Math.sqrt(mean(dw.map((v) => (v - mean(dw)) ** 2)));
    check(`At ${kmh} km/h held: the fronts take under 20 % of the drive, steadily`,
      share >= 0 && share < 0.2 && ripple < 5 + 0.1 * mean(x) && Math.max(...x) < C.awd.centre.maxTorqueNm,
      `${fmt(mean(x), 0)} of ${fmt(mean(total), 0)} Nm (${fmt(share * 100, 1)} %), ±${fmt(ripple, 1)} Nm; rears ${fmt(mean(dw), 2)} ± ${fmt(dwRipple, 2)} rad/s ahead`);
  }

  // Flat out in second from 50 km/h: the rears spin, and the coupling hands the fronts 100 Nm per rad/s they run ahead,
  // up to its 1000 Nm, the fronts gripping
  {
    const car = makeCar();
    car.reset(0, 0, 0, 50 / 3.6);
    car.autoShift = false;
    car.gear = 2;
    const rows: { x: number; dOmega: number; rearSlip: number; frontSlip: number }[] = [];
    run(car, 2.5, () => ({ throttle: 1, brake: 0, steer: 0 }), (c) => {
      rows.push({ x: c.centreCouplingTorqueNm, dOmega: axleOmega(c, false) - axleOmega(c, true), rearSlip: 0.5 * (c.wheels[2].slipRatio + c.wheels[3].slipRatio), frontSlip: 0.5 * (c.wheels[0].slipRatio + c.wheels[1].slipRatio) });
    });
    const peak = rows.reduce((a, b) => (b.x > a.x ? b : a));
    const ramp = rows.filter((r) => r.x > 50 && r.x < 950);
    const fit = ramp.length ? Math.max(...ramp.map((r) => Math.abs(r.x - 100 * r.dOmega))) : NaN;
    check('Flat out in second: the fronts pick up drive as the rears spin', peak.x > 300 && peak.rearSlip > peak.frontSlip + 0.03,
      `peak ${fmt(peak.x, 0)} Nm at ${fmt(peak.rearSlip * 100, 1)} % rear / ${fmt(peak.frontSlip * 100, 1)} % front slip`);
    check('The coupling passes 100 Nm per rad/s of rear over front, within 1000 Nm', Math.max(...rows.map((r) => r.x)) <= 1000.001 && fit < 20,
      `${ramp.length} samples on the ramp, worst ${fmt(fit, 1)} Nm off 100 × Δω`);
  }

  // On a damp road from 30 km/h in first: the same car with its rears driven alone spins up and gets away slower
  {
    const damp = { waterMm: 0.5, wetness: wetnessFromWater(0.5), ambientC: 15, rain: 0.4 };
    const launch = (cfg: CarPhysicsConfig) => {
      const sim = new F12026CarSim(pad, null, { ...NISSAN_R32_SIM_PROFILE, config: cfg });
      sim.assistPreset = 'pro';
      sim.setWeatherSample(damp);
      sim.teleportToDistance(1000, 30 / 3.6);
      let slip = 0;
      let n = 0;
      let front = 0;
      let limiter = 0;
      let dropped = 0;
      for (let t = 0; t < 3; t += DT) {
        sim.setWeatherSample(damp);
        sim.step(DT, { throttle: 1 });
        const v = sim.vehicle;
        slip += Math.max(sim.telemetry.wheelSlipRatios[2], sim.telemetry.wheelSlipRatios[3]);
        front = Math.max(front, v.centreCouplingTorqueNm);
        if (v.rpm > C.gearbox.gears.redline_rpm - 150) {
          limiter++;
          // the rears spinning on the limiter, the coupling still handing the fronts their drive
          if (axleOmega(v, false) - axleOmega(v, true) > 1 && v.centreCouplingTorqueNm === 0) dropped++;
        }
        n++;
      }
      return { kmh: sim.telemetry.speedKmh, slip: slip / n, front, limiter, dropped };
    };
    const awd = launch(C);
    const rwd = launch(RWD);
    check('Damp road, 3 s flat out from 30 km/h: AWD gets away faster than RWD', awd.kmh > rwd.kmh + 3 && awd.front > 300,
      `${fmt(awd.kmh, 1)} vs ${fmt(rwd.kmh, 1)} km/h; mean rear slip ${fmt(awd.slip, 2)} vs ${fmt(rwd.slip, 2)}, coupling up to ${fmt(awd.front, 0)} Nm`);
    // The coupling follows the driver's foot, not the torque of the moment: the limiter's 25 ms cuts don't release it
    check('On the limiter, the coupling stays in through the cuts', awd.limiter > 10 && awd.dropped === 0, `${awd.limiter} steps near the limiter, coupling released in ${awd.dropped}`);
  }

  // No fight: round a hairpin on a part pedal the fronts' longer path runs them ahead of the rears, and the one-way
  // coupling stays open instead of winding the axles up against each other (a locked centre would scrub and brake)
  {
    const car = makeCar();
    car.reset(0, 0, 0, 30 / 3.6);
    let pedal = 0.2;
    let worst = 0;
    let ahead = 0;
    run(car, 8, (c) => {
      pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < 30 ? 0.002 : -0.002), 0, 1);
      return { throttle: pedal, brake: 0, steer: 0.5 };
    }, (c, t) => {
      if (t < 4) return;
      worst = Math.max(worst, c.centreCouplingTorqueNm);
      ahead = axleOmega(c, true) - axleOmega(c, false);
    });
    const radius = (car.telemetry.speedKmh / 3.6) ** 2 / Math.max(0.01, Math.abs(car.telemetry.latG) * 9.81);
    check('A part-throttle hairpin: the fronts run ahead, the coupling stays open', worst < 5 && ahead > 0,
      `${fmt(radius, 0)} m radius, ${fmt(Math.abs(car.telemetry.latG), 2)} g: fronts ${fmt(ahead, 2)} rad/s ahead, coupling at most ${fmt(worst, 1)} Nm`);
  }
  {
    const car = makeCar();
    car.reset(0, 0, 0, 160 / 3.6);
    let onBrakes = 0;
    let lifted = 0;
    run(car, 2, () => ({ throttle: 1, brake: 0, steer: 0 }));
    run(car, 1, () => ({ throttle: 0, brake: 0, steer: 0 }), (c, t) => {
      if (t > 0.2) lifted = Math.max(lifted, c.centreCouplingTorqueNm);
    });
    run(car, 2, () => ({ throttle: 0, brake: 1, steer: 0 }), (c) => {
      onBrakes = Math.max(onBrakes, Math.abs(c.centreCouplingTorqueNm));
    });
    check('Off the throttle and on the brakes the coupling is open', lifted === 0 && onBrakes === 0, `lifted ${fmt(lifted, 1)} Nm, braking ${fmt(onBrakes, 1)} Nm`);
  }
  // A flat-out pull through the gears on dry tarmac: between the changes (the coupling lets go for each one) its torque
  // and the axles' speeds don't ring
  {
    const car = makeCar();
    car.reset(0, 0, 0, 40 / 3.6);
    const x: number[] = [];
    let gear = car.gear;
    let sinceShift = 0;
    let rough = 0;
    run(car, 10, () => ({ throttle: 1, brake: 0, steer: 0 }), (c) => {
      if (c.gear !== gear) {
        gear = c.gear;
        sinceShift = 0;
        x.length = 0;
      }
      sinceShift += DT;
      x.push(c.centreCouplingTorqueNm);
      const n = x.length;
      if (sinceShift > 0.6 && n > 2) rough = Math.max(rough, Math.abs(x[n - 1] - 2 * x[n - 2] + x[n - 3]));
    });
    check('No chatter in the coupling through a full-throttle pull', rough < 30 && x.every(Number.isFinite), `largest second difference ${fmt(rough, 1)} Nm per step, 0.6 s on from each change (to gear ${gear})`);
  }
}

console.log('\n== Traction control through the adapter');
{
  const damp = { waterMm: 0.5, wetness: wetnessFromWater(0.5), ambientC: 15, rain: 0.4 };
  const exit = (preset: 'pro' | 'assisted') => {
    const sim = createNissanR32Sim(pad);
    sim.assistPreset = preset;
    sim.setWeatherSample(damp);
    sim.teleportToDistance(1000, 60 / 3.6);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 2; t += DT) {
      sim.setWeatherSample(damp);
      sim.step(DT, { throttle: 1 });
      sum += Math.max(...sim.telemetry.wheelSlipRatios);
      n++;
    }
    return sum / n;
  };
  const tc = exit('assisted');
  const raw = exit('pro');
  // The assisted TC reads the axle that spins the more of the two driven ones
  check('Assisted TC holds the wheelspin on a damp road above 40 km/h', tc < 0.15 && tc < raw * 0.7, `mean worst-wheel slip ${fmt(tc, 2)} with TC, ${fmt(raw, 2)} without`);
}

console.log("\n== Brakes, fuel and steering from the car's data");
{
  const pads = [0, 500, 1200].map((t) => evaluateBrakePadMuFactor(t, 'endurance-steel', 0, C.brakes.padMuCurve));
  check('Pad friction 0.986 / 1.000 / 0.989 at 0 / 500 / 1200 °C', [0.986, 1, 0.989].every((v, i) => Math.abs(pads[i] - v) < 1e-9), pads.map((v) => fmt(v, 3)).join(' / '));

  // 0.004 l/s per 1000 rpm flat out at 0.74 kg/l
  const sim = createNissanR32Sim(pad);
  sim.assistPreset = 'pro';
  sim.teleportToDistance(1000, 0);
  const f0 = sim.telemetry.fuelKg;
  let rpmSum = 0;
  let n = 0;
  for (let t = 0; t < 30; t += DT) {
    sim.step(DT, { throttle: 1 });
    rpmSum += sim.telemetry.rpm;
    n++;
  }
  const burnt = f0 - sim.telemetry.fuelKg;
  const expected = (rpmSum / n / 1000) * 0.004 * 0.74 * 30;
  check('30 s flat out burns 0.004 l/s per 1000 rpm', Math.abs(burnt / expected - 1) < 0.08, `${fmt(burnt, 3)} kg (${fmt(expected, 3)} kg at its mean ${fmt(rpmSum / n, 0)} rpm)`);

  // 360° of rim lock on its 12.4:1 rack, turned at 900°/s
  const steer = createNissanR32Sim(pad);
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
  // 240 ms between gears with the ignition cut as long
  const u = measureUpshift((t) => createNissanR32Sim(t), 90);
  check("An up-shift on a light pedal: the drive goes, then the driven wheels take the engine's excess, under 15 % of slip", u.to === u.from + 1 && u.gMin < u.gBefore - 0.05 && u.slipPeak < 0.15,
    `gear ${u.from} → ${u.to}, slip ${(u.slipBefore * 100).toFixed(1)} % → ${(u.slipPeak * 100).toFixed(1)} %, ${u.gBefore.toFixed(2)} g → ${u.gMin.toFixed(2)} … ${u.gPeak.toFixed(2)} g`);
}

console.log('\n== Down-shift');
{
  // An 80 % blip in the 300 ms between gears; the clutch takes up what it leaves
  const d = measureDownshift((t) => createNissanR32Sim(t), 170, 4, 0.5);
  check('A down-shift on the brakes: the blip brings the engine up, no wheel slips past 6 % and the car is not tugged 0.25 g harder', d.to === d.from - 1 && d.slipPeak < 0.06 && d.gMin > d.gBefore - 0.25,
    `gear ${d.from} → ${d.to}, ${d.gBefore.toFixed(2)} g → ${d.gMin.toFixed(2)} … ${d.gMax.toFixed(2)} g, slip at most ${(d.slipPeak * 100).toFixed(1)} %`);
  const g = C.gearbox;
  const taken = downshiftTakenAt((t) => createNissanR32Sim(t), 4, g.ratios, g.gears.redline_rpm, 50);
  const refused = !downshiftTakenAt((t) => createNissanR32Sim(t), 4, g.ratios, g.gears.redline_rpm, 300);
  check('The box takes a down-shift that lands 50 rpm over the limiter and refuses one 300 over', taken && refused, `50 over: ${taken ? 'taken' : 'refused'}, 300 over: ${refused ? 'refused' : 'taken'}`);
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
    while (t < 360 && sim.telemetry.lapCount < lap0 + 2) {
      sim.step(1 / 60, {});
      t += 1 / 60;
      beyond = Math.max(beyond, Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
      maxSlip = Math.max(maxSlip, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, sim.vxMs))) * 180) / Math.PI);
    }
    const W = sim.vehicle.wheels;
    return {
      done: sim.telemetry.lapCount === lap0 + 2,
      lapS: (sim.telemetry.lastLapTimeMs ?? 0) / 1000,
      beyond,
      maxSlip,
      top: sim.telemetry.allTimeTopSpeedKmh,
      core: [0.5 * (W[0].coreTempC + W[1].coreTempC), 0.5 * (W[2].coreTempC + W[3].coreTempC)],
      window: sim.vehicle.tyreOptimum(0).tempC,
    };
  };
  const r32 = lap(createNissanR32Sim(track, root));
  const gt3 = lap(createAmgGt3Sim(track, root));
  check('Flying lap completes, CG within 0.5 m of the edge', r32.done && r32.beyond <= 0.5 && r32.maxSlip < 12,
    `lap ${fmt(r32.lapS, 2)} s, top ${fmt(r32.top, 0)} km/h, CG ${fmt(Math.max(0, r32.beyond), 2)} m past the edge, max body slip ${fmt(r32.maxSlip, 1)}°`);
  // The GT3 slick's heat model on the mod's 70–90 °C windows: two laps in, the carcasses near their window
  const [lo, hi] = r32.window;
  check('Tyres in or near their window after two laps', r32.core.every((c) => c > lo - 15 && c < hi + 15),
    `carcass front ${fmt(r32.core[0], 0)} °C, rear ${fmt(r32.core[1], 0)} °C; window ${lo}–${hi} °C`);
  // As much power but less than a fifth of the GT3's downforce, on a narrower slick
  check('Slower than the GT3', r32.lapS > gt3.lapS + 2, `${fmt(r32.lapS, 2)} s vs the GT3's ${fmt(gt3.lapS, 2)} s`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll R32 checks passed.');
if (failures.length) process.exitCode = 1;
