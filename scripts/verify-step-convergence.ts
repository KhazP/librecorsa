/**
 * Step-size convergence of the rigid-body engine (`VehiclePhysics`): the same manoeuvres run with the force loop at
 * 1, 2 (the game's) and 4 kHz. A result that moves with the step is the integration's, not the car's: the game's 2 kHz
 * must sit within a per cent or two of 4 kHz on everything a driver feels (cornering, braking, launching, a kerb).
 *
 *   npx tsx scripts/verify-step-convergence.ts
 *
 * The cars' controls and aids run at 500 Hz in every case; only the substep count changes.
 */
import { DEFAULT_SURFACE_TABLE } from '../src/lib/sim/track-surfaces';
import type { CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { FlatGroundQuery, type GroundHit, type GroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { MTR_496R_CONFIG } from '../src/lib/sim/proto/Mtr496rConfig';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 500;
const flat = new FlatGroundQuery(0);

/** A road with a kerb across it: 50 mm high, ramped up over 0.3 m, 2 m on top, ramped down, starting at z = 40 m */
class KerbGround implements GroundQuery {
  query(_x: number, z: number, probeY: number, out: GroundHit): boolean {
    const d = z - 40;
    const up = Math.min(1, Math.max(0, d / 0.3));
    const down = Math.min(1, Math.max(0, (d - 2.3) / 0.3));
    const h = 0.05 * (up - down);
    if (h > probeY) return false;
    out.height = h;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.surface = 'road';
    out.grip = DEFAULT_SURFACE_TABLE.road.friction;
    out.props = DEFAULT_SURFACE_TABLE.road;
    out.source = 'kerb';
    return true;
  }
}
const kerb = new KerbGround();

/** Runs `fn` with the engine's force loop at `substeps` per 500 Hz step (4 = the game's 2 kHz) */
function atSubsteps<T>(substeps: number, fn: () => T): T {
  const engine = VehiclePhysics as unknown as { SUBSTEPS: number };
  const game = engine.SUBSTEPS;
  engine.SUBSTEPS = substeps;
  try {
    return fn();
  } finally {
    engine.SUBSTEPS = game;
  }
}

interface Measures {
  /** Mean lateral g of a held corner */
  cornerG: number;
  /** Distance of a firm stop (m) */
  stopM: number;
  /** Speed 4 s after a full-throttle launch from rest (km/h) */
  launchKmh: number;
  /** Peak front tyre load over the kerb, as a multiple of its static load */
  kerbPeak: number;
}

function measure(config: CarPhysicsConfig, cornerKmh: number, steer: number, stopKmh: number, brake: number): Measures {
  const make = (ground: GroundQuery = flat) => new VehiclePhysics({ ground, config, airDensity: 1.2 });

  // A held corner: the speed kept by the throttle, the steering wound on over a second and held
  let car = make();
  car.reset(0, 0, 0, cornerKmh / 3.6);
  let pedal = 0.3;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 7 / DT; i++) {
    pedal = Math.min(1, Math.max(0, pedal + (car.telemetry.speedKmh < cornerKmh ? 0.004 : -0.004)));
    car.step(DT, { throttle: pedal, brake: 0, steer: -steer * Math.min(1, i * DT) });
    if (i > 5 / DT) {
      sum += Math.abs(car.telemetry.latG);
      n++;
    }
  }
  const cornerG = sum / n;

  // A firm stop on a held pedal, to 20 km/h
  car = make();
  car.reset(0, 0, 0, stopKmh / 3.6);
  for (let i = 0; i < 0.5 / DT; i++) car.step(DT, { throttle: 0.3, brake: 0, steer: 0 });
  const z0 = car.position.z;
  for (let i = 0; i < 12 / DT && car.telemetry.speedKmh > 20; i++) car.step(DT, { throttle: 0, brake, steer: 0 });
  const stopM = car.position.z - z0;

  // A launch: full throttle from rest on the car's own clutch and gearbox
  car = make();
  car.autoShift = true;
  car.reset(0, 0, 0, 0);
  for (let i = 0; i < 4 / DT; i++) car.step(DT, { throttle: 1, brake: 0, steer: 0 });
  const launchKmh = car.telemetry.speedKmh;

  // A kerb at 100 km/h, straight on
  car = make(kerb);
  car.reset(0, 0, 0, 100 / 3.6);
  const staticFz = 0.5 * (car.wheels[0].fz + car.wheels[1].fz) || 1;
  let rest = 0;
  let restN = 0;
  let peak = 0;
  for (let i = 0; i < 3 / DT; i++) {
    car.step(DT, { throttle: 0.2, brake: 0, steer: 0 });
    const fz = 0.5 * (car.wheels[0].fz + car.wheels[1].fz);
    if (car.position.z < 35 && i > 0.5 / DT) {
      rest += fz;
      restN++;
    }
    peak = Math.max(peak, fz);
  }
  const kerbPeak = peak / (restN ? rest / restN : staticFz);
  return { cornerG, stopM, launchKmh, kerbPeak };
}

const CARS: [string, CarPhysicsConfig, number, number, number, number][] = [
  // name, config, corner km/h, steer (share of lock), stop from km/h, brake pedal
  ['f12026', F12026_CAR_CONFIG, 160, 0.12, 250, 0.7],
  ['GT3', AMG_GT3_CONFIG, 120, 0.16, 200, 0.6],
  ['496R', MTR_496R_CONFIG, 140, 0.16, 220, 0.6],
  ['Liana', SUZUKI_LIANA_CONFIG, 80, 0.14, 120, 0.5],
];

const pct = (a: number, b: number) => (100 * (a - b)) / b;
for (const [name, config, cornerKmh, steer, stopKmh, brake] of CARS) {
  const at = (substeps: number) => atSubsteps(substeps, () => measure(config, cornerKmh, steer, stopKmh, brake));
  const coarse = at(2);
  const game = at(4);
  const fine = at(8);
  const row = (label: string, pick: (m: Measures) => number, unit: string, tol: number, digits = 2) => {
    const g = pick(game);
    const dFine = pct(g, pick(fine));
    const dCoarse = pct(pick(coarse), pick(fine));
    check(`${name}: ${label} at 2 kHz within ${tol} % of 4 kHz`, Math.abs(dFine) <= tol && Number.isFinite(g),
      `${g.toFixed(digits)} ${unit} (${dFine >= 0 ? '+' : ''}${dFine.toFixed(2)} %; 1 kHz ${dCoarse >= 0 ? '+' : ''}${dCoarse.toFixed(2)} %)`);
  };
  row(`corner at ${cornerKmh} km/h`, (m) => m.cornerG, 'g', 1, 3);
  row(`stop from ${stopKmh} km/h`, (m) => m.stopM, 'm', 1.5, 1);
  row('launch, speed after 4 s', (m) => m.launchKmh, 'km/h', 2, 1);
  row('kerb, peak front load', (m) => m.kerbPeak, '× static', 5);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll step-size convergence checks passed.');
if (failures.length) process.exitCode = 1;
