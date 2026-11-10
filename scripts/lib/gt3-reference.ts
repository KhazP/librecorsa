/**
 * The GT3 vehicle model measured the way the reference GT3 telemetry logs were (Valencia, 3 runs, ~24 min;
 * TC 3, ABS 3, race setup). G channels in those logs are in g.
 *
 * The reference numbers are what a quick driver achieved, so they are lower bounds of the car: sustained (1 s) lateral g
 * by speed, braking g by speed (95th percentile above 60 % pedal), full-throttle g by speed, engine rpm per m/s of rear
 * wheel speed by gear, the slip the ABS and TC allow, and the steering needed per curvature and per g.
 * Sea-level air (ρ 1.2) like Valencia, flat ground, no driver aids (the slip targets stand in for them), and the car
 * in the state those runs were driven in: tyres in their working window, part of a tank of fuel aboard.
 *
 * Shared by `compare-gt3-telemetry.ts` (prints the table) and `verify-gt3-telemetry.ts` (asserts it).
 */
import * as THREE from 'three';
import { FlatGroundQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../../src/lib/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../../src/lib/sim/gt3/AmgGt3Config';

/** [km/h, value] from reference GT3 MoTeC logs */
export const GT3_REF = {
  lateralG: [[81, 1.7], [99, 1.79], [117, 1.79], [153, 2.13], [171, 2.01]] as const,
  brakingG: [[99, 1.68], [117, 1.72], [153, 1.83], [189, 2.03], [225, 2.11], [243, 2.12]] as const,
  throttleG: [[63, 0.95], [99, 0.77], [135, 0.64], [171, 0.45], [207, 0.3], [243, 0.19]] as const,
  rpmPerMs: { 2: 181.2, 3: 141.3, 4: 115.3, 5: 100.8 } as Record<number, number>,
  limiterRpm: 7899,
  absFrontSlip: 0.077,
  tcRearSlip: 0.091,
  /** Road-wheel understeer gradient (deg per g), from steering-wheel angle = A·κ + B·a_y with a 12.6 ratio (0.2–1.6 g; the
   * 144–216 km/h bins alone, linear range, give 1.25–1.6) */
  understeerDegPerG: 1.44,
};

export interface Gt3Measurement {
  /** [km/h, ours, reference] */
  lateralG: [number, number, number][];
  /** Road-wheel steer per g at each lateral-g speed (deg) */
  steerPerG: number[];
  /** Geometric term of the steer-per-g fit (m; ≈ the wheelbase) */
  geometricTermM: number;
  understeerDegPerG: number;
  brakingG: [number, number, number][];
  throttleG: [number, number, number][];
  /** [gear, ours, reference] */
  rpmPerMs: [number, number, number][];
  limiterRpm: number;
}

const DT = 1 / 120;
const RHO = 1.2;

function run(car: VehiclePhysics, seconds: number, drive: (c: VehiclePhysics, t: number) => VehicleInputs, each?: (c: VehiclePhysics, t: number) => boolean): void {
  for (let t = 0; t < seconds; t += DT) {
    car.step(DT, drive(car, t));
    if (each?.(car, t)) break;
  }
}

const bodySlip = (c: VehiclePhysics) => {
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(c.quaternion);
  const lat = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion);
  return Math.atan2(c.velocity.dot(lat), c.velocity.dot(fwd));
};

/** Runs every reference manoeuvre on the given config (the GT3's own by default) */
/** The state the car is measured in: tyres at this carcass and tread temperature (°C; omitted: as they leave the blankets), this much fuel (kg) */
export interface Gt3Conditions {
  tyreTempC?: number;
  fuelKg?: number;
}

/**
 * The reference runs' state: tyres in the middle of the slick's 70–85 °C window, half the 50 kg the car starts a
 * session on (three runs over 24 min). Measured from the blankets with an empty tank, the car reads 1–2 % less grip
 * and 2 % more acceleration than it has on a lap
 */
export const GT3_LOG_CONDITIONS: Gt3Conditions = { tyreTempC: 77, fuelKg: 25 };

export function measureGt3(cfg = AMG_GT3_CONFIG, conditions: Gt3Conditions = GT3_LOG_CONDITIONS): Gt3Measurement {
  const flat = new FlatGroundQuery(0);
  const makeCar = (v0 = 0) => {
    const c = new VehiclePhysics({ ground: flat, config: cfg, airDensity: RHO });
    if (conditions.fuelKg) {
      c.setFuelMass(conditions.fuelKg);
      c.refreshStaticGeometry();
    }
    c.reset(0, 0, 0, v0);
    const warm = conditions.tyreTempC;
    if (warm !== undefined) {
      for (const w of c.wheels) {
        w.surfaceTempC = w.coreTempC = warm;
        for (let b = 0; b < 3; b++) w.bandTempsC[b] = w.bandCoreTempsC[b] = w.bandCarcassTempsC[b] = warm;
        w.circumferentialTempsC.fill(warm);
      }
    }
    return c;
  };

  // Sustained lateral g: slow steer ramp at constant speed, best 1 s average
  const lateralG: [number, number, number][] = [];
  const slopes: { invV2: number; degPerG: number }[] = [];
  for (const [kmh, ref] of GT3_REF.lateralG) {
    const car = makeCar(kmh / 3.6);
    let pedal = 0.3;
    const hist: number[] = [];
    let best = 0;
    const pts: [number, number][] = [];
    let steer = 0;
    run(car, 14, (c, t) => {
      pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
      // Full lock is reached at 81 km/h; faster, the ramp tops out where the same lateral g needs it (∝ 1/v²)
      steer = Math.min(1, t / 14) * 0.9 * Math.min(1, 1.6 * (81 / kmh) ** 2);
      return { throttle: pedal, brake: 0, steer: -steer };
    }, (c, t) => {
      const ay = Math.abs(c.telemetry.latG);
      hist.push(ay);
      if (hist.length > 120) hist.shift();
      if (hist.length === 120) best = Math.max(best, hist.reduce((a, b) => a + b, 0) / 120);
      // Road-wheel angle vs lateral g in the linear range (reference high-speed bins give the same ~1.4 deg/g there)
      if (ay > 0.2 && ay < 1.0 && t > 1) pts.push([ay, steer * cfg.chassis.maxRoadWheelDeg]);
      return Math.abs(bodySlip(c)) > 0.35;
    });
    lateralG.push([kmh, best, ref]);
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const k = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    slopes.push({ invV2: 1 / (kmh / 3.6) ** 2, degPerG: k });
  }
  // dδ/da_y = 57.3·L·g / v² + K: the intercept against 1/v² is the understeer gradient
  const n = slopes.length;
  const mx = slopes.reduce((a, p) => a + p.invV2, 0) / n;
  const my = slopes.reduce((a, p) => a + p.degPerG, 0) / n;
  const m = slopes.reduce((a, p) => a + (p.invV2 - mx) * (p.degPerG - my), 0) / slopes.reduce((a, p) => a + (p.invV2 - mx) ** 2, 0);

  // Braking g at speed: threshold braking, slip held at the reference ABS level. The stop starts 8 m/s above the speed,
  // so the dive has settled, and the g is the mean over the 3 m/s around it (the time from 1.5 m/s above to 1.5 m/s
  // below): a single sample just after the pedal goes down reads the pitch transient, not the grip
  const brakingG: [number, number, number][] = [];
  for (const [kmh, ref] of GT3_REF.brakingG) {
    const v = kmh / 3.6;
    const car = makeCar(v + 8);
    let pedal = 1;
    let tAbove = NaN;
    let g = NaN;
    let prevSpeed = v + 8;
    let prevT = 0;
    // The moment the speed passed `at`, between the last step and this one
    const crossed = (at: number, speed: number, t: number) => prevT + ((prevSpeed - at) / Math.max(1e-9, prevSpeed - speed)) * (t - prevT);
    run(car, 4, (c) => {
      const sr = Math.min(...c.wheels.map((w) => w.slipRatio));
      pedal = THREE.MathUtils.clamp(pedal + (sr < -GT3_REF.absFrontSlip ? -0.08 : 0.04), 0.2, 1);
      return { throttle: 0, brake: pedal, steer: 0 };
    }, (c, t) => {
      const speed = c.telemetry.speedKmh / 3.6;
      if (Number.isNaN(tAbove) && speed <= v + 1.5) tAbove = crossed(v + 1.5, speed, t);
      if (speed <= v - 1.5) {
        g = 3 / (crossed(v - 1.5, speed, t) - tAbove) / 9.81;
        return true;
      }
      prevSpeed = speed;
      prevT = t;
      return false;
    });
    brakingG.push([kmh, g, ref]);
  }

  // Full-throttle g at speed: rear slip held at the reference TC level
  const throttleG: [number, number, number][] = [];
  {
    const car = makeCar(40 / 3.6);
    let pedal = 0.6;
    const seen = new Map<number, number>();
    run(car, 60, (c) => {
      const sr = Math.max(c.wheels[2].slipRatio, c.wheels[3].slipRatio);
      pedal = THREE.MathUtils.clamp(pedal + (GT3_REF.tcRearSlip - sr) * 0.25, 0.3, 1);
      return { throttle: pedal, brake: 0, steer: 0 };
    }, (c) => {
      for (const [kmh] of GT3_REF.throttleG) if (!seen.has(kmh) && c.telemetry.speedKmh >= kmh) seen.set(kmh, c.telemetry.lonG);
      return seen.size === GT3_REF.throttleG.length;
    });
    for (const [kmh, ref] of GT3_REF.throttleG) throttleG.push([kmh, seen.get(kmh) ?? NaN, ref]);
  }

  // Gearing and engine
  const gb = cfg.gearbox;
  const R = cfg.tyreCompounds.PhysicsTyreCompound_GT3_Soft.rear.radius;
  const rpmPerMs: [number, number, number][] = [2, 3, 4, 5].map((g) => [g, (gb.ratios[g - 1] * gb.finalDrive * 60) / (2 * Math.PI * R), GT3_REF.rpmPerMs[g]]);

  return {
    lateralG,
    steerPerG: slopes.map((p) => p.degPerG),
    geometricTermM: m / 57.3 / 9.81,
    understeerDegPerG: my - m * mx,
    brakingG,
    throttleG,
    rpmPerMs,
    limiterRpm: gb.gears.redline_rpm,
  };
}
