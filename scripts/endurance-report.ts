/**
 * Endurance calibration report for the GT3 and the LC-LMDH: the numbers their balance-of-performance trims are held
 * to, measured on the vehicle model.
 *
 *   npx tsx scripts/endurance-report.ts [--car amg-gt3|lc-lmdh] [--laps] [--json]
 *
 * Flat-pad measures (ρ 1.18, a warm sea-level day): the aero at 200 km/h in the sprint and low-drag trims, top speed
 * alone and 12 m behind a car of the same speed in the low-drag trim on the long gears, steady cornering at 80 and 240
 * km/h on tyres and brakes in their working window, a threshold stop from 200 km/h hot and out of the garage, and the
 * steering column's peak torque braking over a 50 mm kerb. With `--laps`: three autopilot laps of Le Mans 1982 from a
 * cold garage start (pressures, tyre wear a lap, the battery's swing), which needs the circuit's hosted files.
 */
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { FlatGroundQuery, type GroundHit, type GroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { DEFAULT_SURFACE_TABLE } from '../src/lib/sim/track-surfaces';
import type { CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { evaluateAeroWakeDeficit } from '../src/lib/sim/aero-wake';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { AMG_GT3_SIM_PROFILE } from '../src/lib/sim/gt3/AmgGt3Sim';
import { LC_LMDH_CONFIG } from '../src/lib/sim/proto/LcLmdhConfig';
import { LC_LMDH_SIM_PROFILE } from '../src/lib/sim/proto/LcLmdhSim';
import { F12026CarSim, type CarSimProfile } from '../src/lib/sim/f12026-car/F12026CarSim';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { DEFAULT_CHASSIS_SETUP } from '../src/lib/sim/car-setup';

const RHO = 1.18;
const DT = 1 / 120;

export interface CarCase {
  id: string;
  config: CarPhysicsConfig;
  profile: CarSimProfile;
}
export const CASES: CarCase[] = [
  { id: 'amg-gt3', config: AMG_GT3_CONFIG as unknown as CarPhysicsConfig, profile: AMG_GT3_SIM_PROFILE },
  { id: 'lc-lmdh', config: LC_LMDH_CONFIG as unknown as CarPhysicsConfig, profile: LC_LMDH_SIM_PROFILE },
];

/** The config in a trim: the profile's aero package and one of its gear sets */
export function trimmed(c: CarCase, aero: 'balanced' | 'low_downforce', gearSet: number): CarPhysicsConfig {
  const cfg = structuredClone(c.config);
  const [front, rear] = c.profile.aeroPackagesDeg[aero];
  for (const w of cfg.aero.wings) w.angleDeg += w.name === 'FRONT_WING' ? front : w.name === 'REAR_WING' ? rear : 0;
  const set = cfg.gearSets?.[gearSet];
  if (set) {
    cfg.gearbox.ratios = [...set.ratios];
    cfg.gearbox.reverse = set.reverse;
    cfg.gearbox.finalDrive = set.finalDrive;
  }
  return cfg;
}

const flat = new FlatGroundQuery(0);
const make = (cfg: CarPhysicsConfig, ground: GroundQuery = flat) => new VehiclePhysics({ ground, config: cfg, airDensity: RHO, ambientC: 25, trackTempC: 35 });

/** Tyres and brakes in their working window: the tread at `tyreC`, the gas at `gasC`, the discs at `discC` */
function preheat(car: VehiclePhysics, tyreC = 85, gasC = 94, discC = 420): void {
  for (const w of car.wheels) {
    w.bandTempsC.fill(tyreC);
    w.bandCarcassTempsC.fill(tyreC);
    w.bandCoreTempsC.fill(tyreC);
    w.surfaceTempC = w.coreTempC = tyreC;
    w.gasTempC = gasC;
    w.rimTempC = gasC;
    w.brakeDisc.surfaceTempC = w.brakeDisc.coreTempC = discC;
  }
  car.refreshTyrePressures();
}

export function aeroAt(cfg: CarPhysicsConfig, kmh: number) {
  const car = make(cfg);
  car.reset(0, 0, 0, kmh / 3.6);
  for (let t = 0; t < 1.5; t += DT) {
    const err = kmh / 3.6 - car.speedMs;
    car.step(DT, { throttle: THREE.MathUtils.clamp(0.5 + err * 0.5, 0, 1), brake: 0, steer: 0 });
  }
  const q = 0.5 * RHO * car.speedMs ** 2;
  return { clA: car.telemetry.downforceN / q, cdA: car.telemetry.dragN / q, frontPct: car.telemetry.AERO_BALANCE };
}

export function topSpeed(cfg: CarPhysicsConfig, towGapM?: number): number {
  const car = make(cfg);
  car.reset(0, 0, 0, 60);
  let pedal = 0.8;
  let vmax = 0;
  for (let t = 0; t < 90; t += DT) {
    if (towGapM !== undefined) {
      car.setAeroWakeState(
        evaluateAeroWakeDeficit(0, 0, car.speedMs, [{ sMeters: towGapM, lateralOffsetM: 0, speedMs: car.speedMs } as never], 1e6)
      );
    }
    const sr = Math.max(...car.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (0.08 - sr) * 0.25, 0.3, 1);
    car.step(DT, { throttle: pedal, brake: 0, steer: 0 });
    vmax = Math.max(vmax, car.telemetry.speedKmh);
  }
  return vmax;
}

/** Peak steady lateral g on a slow steer ramp at a held speed, hot */
export function skidpad(cfg: CarPhysicsConfig, kmh: number): number {
  const car = make(cfg);
  const target = kmh / 3.6;
  car.reset(0, 0, 0, target);
  preheat(car);
  const prev = car.velocity.clone();
  const left = new THREE.Vector3();
  let best = 0;
  const win: number[] = [];
  for (let t = 0; t < 14; t += DT) {
    const err = target - car.speedMs;
    car.step(DT, { throttle: THREE.MathUtils.clamp(0.4 + err * 0.5, 0, 1), brake: THREE.MathUtils.clamp(-err * 0.3, 0, 1), steer: Math.min(1, t / 12) });
    left.set(1, 0, 0).applyQuaternion(car.quaternion);
    const g = Math.abs(car.velocity.clone().sub(prev).divideScalar(DT).dot(left)) / 9.81;
    prev.copy(car.velocity);
    win.push(g);
    if (win.length > 60) win.shift();
    if (win.length === 60 && Math.abs(car.speedMs - target) < 0.04 * target) best = Math.max(best, win.reduce((a, b) => a + b, 0) / 60);
  }
  return best;
}

/** A threshold stop from `fromKmh`: the pedal held at the edge of locking, as a driver without ABS does */
export function brakeStop(cfg: CarPhysicsConfig, fromKmh: number, hot: boolean): { distM: number; peakG: number } {
  const car = make(cfg);
  car.coldGarageStart = !hot;
  car.reset(0, 0, 0, fromKmh / 3.6);
  if (hot) preheat(car);
  const z0 = car.position.z;
  let pedal = 1;
  let peakG = 0;
  for (let t = 0; t < 20; t += DT) {
    const sr = Math.min(...car.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (sr < -0.11 ? -0.08 : 0.04), 0.15, 1);
    car.step(DT, { throttle: 0, brake: pedal, steer: 0 });
    peakG = Math.max(peakG, -car.telemetry.lonG);
    if (car.telemetry.speedKmh < 2) break;
  }
  return { distM: car.position.z - z0, peakG };
}

/** A 50 mm kerb under the left wheels (body +X is left at yaw 0, so world x > 0.4 m) from z 40 m to 46 m */
class KerbStrip implements GroundQuery {
  readonly smooth = true;
  readonly stateless = true;
  query(x: number, z: number, probeY: number, out: GroundHit): boolean {
    const on = x > 0.4 && z > 40 && z < 46;
    // A sawtooth-faced kerb: 50 mm over its first 0.25 m, flat on top
    const h = on ? 0.05 * Math.min(1, (z - 40) / 0.25) : 0;
    if (h > probeY) return false;
    out.height = h;
    out.nx = 0;
    out.ny = 1;
    out.nz = on && z - 40 < 0.25 ? -0.196 : 0;
    const n = Math.hypot(out.ny, out.nz);
    out.ny /= n;
    out.nz /= n;
    out.surface = 'kerb';
    out.grip = DEFAULT_SURFACE_TABLE.road.friction;
    out.props = DEFAULT_SURFACE_TABLE.kerb ?? DEFAULT_SURFACE_TABLE.road;
    out.source = 'flat';
    return true;
  }
}

/** The steering column's peak torque braking hard in a straight line over a 50 mm kerb under the left wheels (Nm) */
export function kerbBrakePullNm(cfg: CarPhysicsConfig): number {
  const car = make(cfg, new KerbStrip());
  car.reset(0, 0, 0, 150 / 3.6);
  preheat(car);
  const ratio = cfg.chassis.powerSteering?.steeringRatio ?? 12.6;
  let peak = 0;
  for (let t = 0; t < 3; t += 1 / 500) {
    car.step(1 / 500, { throttle: 0, brake: 0.85, steer: 0 });
    for (const s of car.takeFfbSubframeSamples()) peak = Math.max(peak, Math.abs(s));
  }
  return (peak * 600) / ratio;
}

/** Three autopilot laps of Le Mans 1982 from a cold garage start */
export function laps(c: CarCase) {
  const file = 'public/tracks/le_mans_82/track_data.json';
  if (!existsSync(file)) return null;
  setActiveTrack('le_mans_82', JSON.parse(readFileSync(file, 'utf8')) as RawTrackJson);
  const track = getActiveTrackData();
  const sim = new F12026CarSim(track, null, c.profile);
  sim.setSimRealism(SIM_REALISM_FLAGS.full);
  sim.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, gearRatioSet: 1 });
  sim.aeroPreset = 'low_downforce';
  sim.resetToStartGrid(false);
  sim.aiAutopilot = true;
  sim.aiPaceScale = 1;
  const v = (sim as unknown as { vehicle: VehiclePhysics }).vehicle;
  const lapsOut: { lapS: number; psi: number[]; coreC: number[]; gasC: number[]; rimC: number[]; wearPct: number[]; socPct: number; fuelKg: number; topKmh: number }[] = [];
  let top = 0;
  const soc0 = v.ersEnergyJ;
  let wear0 = v.wheels.map((w) => w.wear);
  let lap0 = sim.telemetry.lapCount;
  let socMin = 1;
  let socMax = 0;
  let t = 0;
  while (t < 900 && lapsOut.length < 3) {
    sim.step(1 / 60, {});
    t += 1 / 60;
    const soc = v.ersEnergyJ / Math.max(1, c.config.ers.ERS_MAX_CHARGE);
    socMin = Math.min(socMin, soc);
    socMax = Math.max(socMax, soc);
    top = Math.max(top, sim.telemetry.speedKmh);
    if (sim.telemetry.lapCount !== lap0) {
      lap0 = sim.telemetry.lapCount;
      lapsOut.push({
        lapS: (sim.telemetry.lastLapTimeMs ?? 0) / 1000,
        psi: v.wheels.map((w) => +w.pressurePsi.toFixed(2)),
        coreC: v.wheels.map((w) => +w.coreTempC.toFixed(0)),
        gasC: v.wheels.map((w) => +w.gasTempC.toFixed(0)),
        rimC: v.wheels.map((w) => +w.rimTempC.toFixed(0)),
        wearPct: v.wheels.map((w, i) => +((w.wear - wear0[i]) * 100).toFixed(2)),
        socPct: +(soc * 100).toFixed(1),
        fuelKg: +v.fuelMassKg.toFixed(2),
        topKmh: +top.toFixed(1),
      });
      top = 0;
      wear0 = v.wheels.map((w) => w.wear);
    }
  }
  return { laps: lapsOut, socStartPct: +((soc0 / Math.max(1, c.config.ers.ERS_MAX_CHARGE)) * 100).toFixed(1), socSwingPct: +((socMax - socMin) * 100).toFixed(1) };
}

const args = process.argv.slice(2);
if (!process.env.ENDURANCE_REPORT_LIB) main();

function main(): void {
const only = args.includes('--car') ? args[args.indexOf('--car') + 1] : undefined;
const out: Record<string, unknown> = {};
for (const c of CASES) {
  if (only && only !== c.id) continue;
  const sprint = trimmed(c, 'balanced', 0);
  const lowDrag = trimmed(c, 'low_downforce', c.config.gearSets && c.config.gearSets.length > 1 ? 1 : 0);
  const hot = brakeStop(sprint, 200, true);
  const cold = brakeStop(sprint, 200, false);
  const r = {
    aeroSprint: aeroAt(sprint, 200),
    aeroLowDrag: aeroAt(lowDrag, 200),
    vmaxSoloKmh: +topSpeed(lowDrag).toFixed(1),
    vmaxTowKmh: +topSpeed(lowDrag, 12).toFixed(1),
    skidpad80G: +skidpad(sprint, 80).toFixed(3),
    skidpad240G: +skidpad(sprint, 240).toFixed(3),
    brake200HotM: +hot.distM.toFixed(1),
    brake200HotPeakG: +hot.peakG.toFixed(2),
    brake200ColdM: +cold.distM.toFixed(1),
    kerbBrakePullNm: +kerbBrakePullNm(sprint).toFixed(1),
    laps: args.includes('--laps') ? laps(c) : undefined,
  };
  out[c.id] = r;
  if (!args.includes('--json')) console.log(c.id, JSON.stringify(r, null, 1));
}
if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
}
