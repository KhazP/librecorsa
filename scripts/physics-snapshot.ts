/**
 * Physics snapshot of every rigid-body car: a fingerprint of a scripted run over a bumpy pad (identical when an engine
 * change leaves a car alone) and the numbers a change to the engine should be held against: top speed, braking,
 * steady cornering at three speeds, hot tyre pressures and the solver's cost per 500 Hz step.
 *
 *   npx tsx scripts/physics-snapshot.ts [--json out.json] [--only id,id] [--no-hash] [--compare before.json]
 */
import * as THREE from 'three';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { FlatGroundQuery, type GroundHit, type GroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { DEFAULT_SURFACE_TABLE } from '../src/lib/sim/track-surfaces';
import type { CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { LC26_CAR_CONFIG } from '../src/lib/sim/f12026-car/Lc26Config';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { LC_LMDH_CONFIG } from '../src/lib/sim/proto/LcLmdhConfig';
import { MTR_496R_CONFIG } from '../src/lib/sim/proto/Mtr496rConfig';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';
import { NISSAN_R33_CONFIG } from '../src/lib/sim/classic/NissanR33Config';
import { NISSAN_R32_CONFIG } from '../src/lib/sim/classic/NissanR32Config';
import { BMW_M1_PROCAR_CONFIG } from '../src/lib/sim/classic/BmwM1ProcarConfig';
import { VW_SCIROCCO_CONFIG } from '../src/lib/sim/road/VwSciroccoConfig';
import { CHAPARRAL_2D_CONFIG, CHAPARRAL_2D_67_CONFIG } from '../src/lib/sim/classic/Chaparral2dConfig';
import { PORSCHE_934_RSR_CONFIG } from '../src/lib/sim/classic/Porsche934RsrConfig';

const CARS: Record<string, CarPhysicsConfig> = {
  'f12026-car': F12026_CAR_CONFIG as unknown as CarPhysicsConfig,
  lc26: LC26_CAR_CONFIG as unknown as CarPhysicsConfig,
  'amg-gt3': AMG_GT3_CONFIG as unknown as CarPhysicsConfig,
  'lc-lmdh': LC_LMDH_CONFIG as unknown as CarPhysicsConfig,
  'mtr-496r': MTR_496R_CONFIG as unknown as CarPhysicsConfig,
  liana: SUZUKI_LIANA_CONFIG as unknown as CarPhysicsConfig,
  'nissan-r33-jgtc': NISSAN_R33_CONFIG as unknown as CarPhysicsConfig,
  'nissan-r32-jtcc': NISSAN_R32_CONFIG as unknown as CarPhysicsConfig,
  'bmw-m1-procar': BMW_M1_PROCAR_CONFIG as unknown as CarPhysicsConfig,
  'vw-scirocco-gtx': VW_SCIROCCO_CONFIG as unknown as CarPhysicsConfig,
  'chaparral-2d': CHAPARRAL_2D_CONFIG as unknown as CarPhysicsConfig,
  'chaparral-2d-67': CHAPARRAL_2D_67_CONFIG as unknown as CarPhysicsConfig,
  'porsche-934-rsr': PORSCHE_934_RSR_CONFIG as unknown as CarPhysicsConfig,
};

/** Flat road with a strip of 25 mm sine kerbs across the run (x 2..6 m, every 0.9 m along z) and a 40 mm ramp */
class KerbGround implements GroundQuery {
  readonly smooth = true;
  readonly stateless = true;
  query(x: number, z: number, probeY: number, out: GroundHit): boolean {
    let h = 0;
    let dhdz = 0;
    if (x > 2 && x < 6 && z > 20 && z < 80) {
      const k = (2 * Math.PI) / 0.9;
      h = 0.0125 * (1 - Math.cos(k * z));
      dhdz = 0.0125 * k * Math.sin(k * z);
    }
    if (h > probeY) return false;
    const n = Math.hypot(dhdz, 1);
    out.height = h;
    out.nx = 0;
    out.ny = 1 / n;
    out.nz = -dhdz / n;
    out.surface = 'road';
    out.grip = DEFAULT_SURFACE_TABLE.road.friction;
    out.props = DEFAULT_SURFACE_TABLE.road;
    out.source = 'flat';
    return true;
  }
}

const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const make = (cfg: CarPhysicsConfig, ground: GroundQuery = flat) => new VehiclePhysics({ ground, config: cfg });
const latAccelG = (car: VehiclePhysics, prev: THREE.Vector3): number => {
  const a = car.velocity.clone().sub(prev).divideScalar(DT);
  const left = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion);
  return Math.abs(a.dot(left)) / 9.81;
};

function fingerprint(cfg: CarPhysicsConfig): string {
  const car = make(cfg, new KerbGround());
  car.reset(4, 0, 0, 25);
  const h = createHash('sha256');
  for (let i = 0; i < 1800; i++) {
    const t = i * DT;
    const inp: VehicleInputs = {
      throttle: t < 4 ? 0.8 : t < 6 ? 0 : t < 9 ? 1 : 0.2,
      brake: t >= 4 && t < 6 ? 0.7 : 0,
      steer: t < 6 ? 0.04 * Math.sin(t * 3) : 0.35 * Math.sin((t - 6) * 2.4),
    };
    car.step(DT, inp);
    if (i % 60 === 59) {
      const w = car.wheels;
      const v = [
        car.position.x, car.position.y, car.position.z, car.velocity.x, car.velocity.y, car.velocity.z,
        car.quaternion.x, car.quaternion.y, car.quaternion.z, car.quaternion.w,
        ...w.flatMap((x) => [x.omega, x.surfaceTempC, x.coreTempC, x.pressurePsi, x.fz, x.brakeDisc.surfaceTempC]),
      ];
      h.update(v.map((x) => x.toPrecision(10)).join(','));
    }
  }
  return h.digest('hex').slice(0, 16);
}

function topSpeed(cfg: CarPhysicsConfig): number {
  const car = make(cfg);
  car.reset(0, 0, 0, 30);
  let pedal = 0.6;
  let vmax = 0;
  for (let t = 0; t < 70; t += DT) {
    const sr = Math.max(...car.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (0.1 - sr) * 0.25, 0.3, 1);
    car.step(DT, { throttle: pedal, brake: 0, steer: 0 });
    vmax = Math.max(vmax, car.telemetry.speedKmh);
  }
  return vmax;
}

function braking(cfg: CarPhysicsConfig, fromKmh: number): { distM: number; peakG: number } {
  const car = make(cfg);
  car.reset(0, 0, 0, fromKmh / 3.6);
  const z0 = car.position.z;
  let pedal = 1;
  let peakG = 0;
  for (let t = 0; t < 15; t += DT) {
    const sr = Math.min(...car.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (sr < -0.12 ? -0.1 : 0.05), 0.2, 1);
    car.step(DT, { throttle: 0, brake: pedal, steer: 0 });
    peakG = Math.max(peakG, -car.telemetry.lonG);
    if (car.telemetry.speedKmh < 5) break;
  }
  return { distM: car.position.z - z0, peakG };
}

/** Peak steady lateral g on a slow steer ramp at a held speed */
function cornering(cfg: CarPhysicsConfig, kmh: number): number {
  const car = make(cfg);
  const target = kmh / 3.6;
  car.reset(0, 0, 0, target);
  const prev = car.velocity.clone();
  let best = 0;
  const win: number[] = [];
  for (let t = 0; t < 12; t += DT) {
    const err = target - car.speedMs;
    const steer = Math.min(1, t / 10);
    car.step(DT, { throttle: THREE.MathUtils.clamp(0.35 + err * 0.4, 0, 1), brake: THREE.MathUtils.clamp(-err * 0.2, 0, 1), steer });
    const g = latAccelG(car, prev);
    prev.copy(car.velocity);
    win.push(g);
    if (win.length > 30) win.shift();
    if (win.length === 30 && Math.abs(car.speedMs - target) < 0.05 * target) best = Math.max(best, win.reduce((a, b) => a + b, 0) / 30);
  }
  return best;
}

/** Two minutes on a steady circle at 120 km/h-ish: tyre carcass temperatures and hot pressures */
function hotTyres(cfg: CarPhysicsConfig): { coreC: number[]; psi: number[]; discC: number[] } {
  const car = make(cfg);
  car.reset(0, 0, 0, 30);
  for (let t = 0; t < 120; t += DT) {
    const err = 30 - car.speedMs;
    const lap = t % 20;
    car.step(DT, {
      throttle: lap > 16 ? (Math.max(...car.wheels.map((w) => w.slipRatio)) > 0.08 ? 0.3 : 1) : THREE.MathUtils.clamp(0.4 + err * 0.4, 0, 1),
      brake: lap > 18 ? 0.8 : THREE.MathUtils.clamp(-err * 0.2, 0, 1),
      steer: lap < 14 ? 0.25 : 0,
    });
  }
  return {
    coreC: car.wheels.map((w) => +w.coreTempC.toFixed(1)),
    psi: car.wheels.map((w) => +w.pressurePsi.toFixed(2)),
    discC: car.wheels.map((w) => +w.brakeDisc.surfaceTempC.toFixed(0)),
  };
}

function stepCostMs(cfg: CarPhysicsConfig): number {
  const car = make(cfg);
  car.reset(0, 0, 0, 40);
  for (let i = 0; i < 600; i++) car.step(0.002, { throttle: 0.7, brake: 0, steer: 0.2 * Math.sin(i * 0.01) });
  const n = 4000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) car.step(0.002, { throttle: 0.7, brake: 0, steer: 0.2 * Math.sin(i * 0.01) });
  return (performance.now() - t0) / n;
}

const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const only = arg('--only')?.split(',');
const out: Record<string, unknown> = {};
for (const [id, cfg] of Object.entries(CARS)) {
  if (only && !only.includes(id)) continue;
  const r = {
    hash: args.includes('--no-hash') ? '' : fingerprint(cfg),
    vmaxKmh: +topSpeed(cfg).toFixed(1),
    brake200: braking(cfg, 200),
    latG80: +cornering(cfg, 80).toFixed(3),
    latG160: +cornering(cfg, 160).toFixed(3),
    latG240: +cornering(cfg, 240).toFixed(3),
    hot: hotTyres(cfg),
    stepMs: +stepCostMs(cfg).toFixed(4),
  };
  r.brake200 = { distM: +r.brake200.distM.toFixed(1), peakG: +r.brake200.peakG.toFixed(2) };
  out[id] = r;
  console.log(id.padEnd(16), JSON.stringify(r));
}
const json = arg('--json');
if (json) writeFileSync(json, JSON.stringify(out, null, 2));
const cmp = arg('--compare');
if (cmp) {
  const before = JSON.parse(readFileSync(cmp, 'utf8')) as Record<string, any>;
  console.log('\nchanges against', cmp);
  for (const [id, r] of Object.entries(out) as [string, any][]) {
    const b = before[id];
    if (!b) continue;
    const d = (k: string, x: number, y: number) => `${k} ${y}→${x} (${(((x - y) / Math.max(1e-9, Math.abs(y))) * 100).toFixed(1)} %)`;
    console.log(
      id.padEnd(16),
      // A run with --no-hash leaves the hash empty: nothing to say about the trajectory
      !r.hash || !b.hash ? 'not hashed' : r.hash === b.hash ? 'same trajectory' : 'trajectory CHANGED',
      '|',
      [d('vmax', r.vmaxKmh, b.vmaxKmh), d('brake', r.brake200.distM, b.brake200.distM), d('g80', r.latG80, b.latG80), d('g160', r.latG160, b.latG160), d('g240', r.latG240, b.latG240), d('step', r.stepMs, b.stepMs)].join(', ')
    );
  }
}
