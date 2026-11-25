/**
 * One timed lap from a flying start on the full physics, driven by the game's autopilot at full pace (its own driver,
 * or the circuit's checked plan, as a qualifying reference lap is): from the boards' start (what a solo flying lap
 * starts on), from the fair start (`fairStart`: the same spot at no more than the car's own pace), or from a normal
 * start: the fair start's spot and pose at the speed the car carries there itself (`speedKmh`, read off a lap's
 * `spotKmh`), so that lap is a normal flying lap with the tyres, fuel and energy of a first one. Deterministic.
 */
import type * as THREE from 'three';
import { VEHICLE_MODELS } from '../../../src/lib/cars/vehicle-models';
import type { SimulatorCar } from '../../../src/lib/sim/simulator-car';
import type { BuiltTrackData } from '../../../src/lib/track-data';
import type { VehicleModelId } from '../../../src/types/f1';

const DT = 1 / 120;
/** A lap not done in this much driving is not timed (s) */
const GIVE_UP_S = 1200;

export interface FlyingStartLap {
  /** Where the car was put down (m, before the line) and how fast (km/h) */
  startS: number;
  startKmh: number;
  /** Speed at the start's spot on the way round the timed lap (km/h): what the car carries there itself */
  spotKmh: number | null;
  /** The timed lap (ms), null if not done (or a lap counted that wasn't one: the car back over the line) */
  lapMs: number | null;
  /**
   * The lap's verdict. Not known for a normal start: putting the car back voids the lap under way, and the line that
   * starts the timed lap doesn't clear that
   */
  valid: boolean;
  /** Barrier impacts over 2 m/s during the timed lap */
  walls: number;
}

export function flyingStartLap(
  track: BuiltTrackData,
  root: THREE.Object3D | null,
  model: VehicleModelId,
  opts: { fairStart: boolean; speedKmh?: number }
): FlyingStartLap {
  const car: SimulatorCar = VEHICLE_MODELS[model].createSim(track, root);
  car.resetToStartGrid(true, 0, undefined, false, opts.fairStart);
  const L = track.totalLengthM;
  const startS = car.sMeters;
  if (opts.speedKmh !== undefined) {
    // The same spot and heading, the tyres as the start left them, the line still to start the lap
    if (!car.restorePose) throw new Error(`${model} cannot be put back at a pose`);
    const q = car.worldQuaternion;
    const yawRad = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    car.restorePose({ x: car.worldPosition.x, z: car.worldPosition.z, yawRad, speedMs: opts.speedKmh / 3.6, s: startS, lapCount: car.telemetry.lapCount, outLap: true });
  }
  const lap: FlyingStartLap = { startS: startS - L, startKmh: car.vxMs * 3.6, spotKmh: null, lapMs: null, valid: false, walls: 0 };
  car.aiAutopilot = true;
  if (car.aiPaceScale !== undefined) car.aiPaceScale = 1;
  const lap0 = car.telemetry.lapCount;
  let crossed = false;
  let prevS = car.sMeters;
  let lastWallMs = car.telemetry.f12026?.wallImpact?.atMs ?? 0;
  for (let t = 0; t < GIVE_UP_S; t += DT) {
    car.step(DT, {});
    const s = car.sMeters;
    if (s < prevS - L / 2) crossed = true;
    // On the timed lap, passing the start's spot again
    if (crossed && lap.spotKmh === null && prevS < startS && s >= startS && s - prevS < L / 2) lap.spotKmh = car.vxMs * 3.6;
    prevS = s;
    const wall = car.telemetry.f12026?.wallImpact;
    if (wall && wall.atMs !== lastWallMs) {
      lastWallMs = wall.atMs;
      if (crossed && wall.speedMs > 2) lap.walls++;
    }
    if (car.telemetry.lapCount !== lap0) {
      // A lap counted that isn't the timed one (the car back over the line, a lap under the shortest one timed): none
      const ms = car.telemetry.lastLapTimeMs ?? null;
      lap.lapMs = crossed && ms !== null && ms > 0 ? ms : null;
      lap.valid = lap.lapMs !== null && car.telemetry.lastLapValid !== false;
      break;
    }
  }
  return lap;
}
