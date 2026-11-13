/**
 * A flying lap of the AI car on the full physics, tracking a supplied line with its speed plan (the D1 tracker),
 * timed on its second lap from a flying start. Reports the lap time, the frames spent off the track, the barrier hits
 * and the worst distance from the line. `line` names the car: the F1 line is driven by the f12026-car, or by the LC26
 * (`lc26`, its own physics and limits on the same line), on the rigid-body engine it ships on.
 */
import type { BuiltTrackData } from '../../../src/lib/track-data';
import { F12026CarSim } from '../../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../../src/lib/sim/gt3/AmgGt3Sim';
import { createLc26Sim } from '../../../src/lib/sim/f12026-car/Lc26Sim';
import { createSuzukiLianaSim } from '../../../src/lib/sim/road/SuzukiLianaSim';
import { createMtr496rSim } from '../../../src/lib/sim/proto/Mtr496rSim';
import type { VehicleModelId } from '../../../src/types/f1';
import { aiTrackFor } from '../../../src/lib/sim/ai/ai-track';
import { carLimitsFor } from '../../../src/lib/sim/ai/ggv';
import { makeDrivePlan, type AiDrivePlan } from '../../../src/lib/sim/ai/drive-plan';
import type { SimulatorCar } from '../../../src/lib/sim/simulator-car';
import type * as THREE from 'three';

export interface PhysicsLap {
  lapS: number;
  offTrackFrames: number;
  maxErrM: number;
  meanErrM: number;
  /** Barrier impacts over the timed lap (above 2 m/s; on the LC26, decelerations no brake can give) */
  wallHits: number;
  plan: AiDrivePlan;
  /** Driven lateral offset and speed per AI grid point (NaN where not visited) */
  n: Float64Array;
  v: Float64Array;
  /** Time since the timed lap's start at each AI grid point (s; NaN where not visited) */
  t: Float64Array;
}

/** Who drives a physics lap: `f1` is the f12026-car and `gt3` the AMG (the cars each line was made for), or any car by id */
export type PhysicsLapCar = 'f1' | 'gt3' | VehicleModelId;

export const physicsLapVehicle = (car: PhysicsLapCar): VehicleModelId => (car === 'f1' ? 'f12026-car' : car === 'gt3' ? 'amg-gt3' : car);

function simFor(vehicle: VehicleModelId, track: BuiltTrackData, root: THREE.Object3D | null): SimulatorCar {
  switch (vehicle) {
    case 'amg-gt3':
      return createAmgGt3Sim(track, root);
    case 'lc26':
      return createLc26Sim(track, root);
    case 'liana':
      return createSuzukiLianaSim(track, root);
    case 'mtr-496r':
      return createMtr496rSim(track, root);
    default:
      return new F12026CarSim(track, root);
  }
}

export function physicsLap(
  track: BuiltTrackData,
  root: THREE.Object3D | null,
  line: PhysicsLapCar,
  offsets: ArrayLike<number>,
  gripScale = 0.95,
  maxS = 400
): PhysicsLap {
  const t = aiTrackFor(track);
  const vehicle = physicsLapVehicle(line);
  const plan = makeDrivePlan(t, offsets, carLimitsFor(vehicle, gripScale));
  const car = simFor(vehicle, track, root);
  car.assistPreset = 'pro';
  car.aiAutopilot = true;
  car.aiPaceScale = 1;
  car.aiPlan = plan;
  car.resetToStartGrid(true, 0);
  // On the line being judged from the start (the flying start puts the car on the stored line)
  car.teleportToDistance(car.sMeters, car.vxMs, plan.n[((Math.round(car.sMeters / t.ds) % t.n) + t.n) % t.n]);
  const L = track.totalLengthM;
  const n = new Float64Array(t.n).fill(NaN), v = new Float64Array(t.n).fill(NaN), tAt = new Float64Array(t.n).fill(NaN);
  let laps = 0, prev = car.sMeters, lapStart = 0, time = 0, off = 0, maxErr = 0, sumErr = 0, cnt = 0;
  let walls = 0, lastWallMs = 0, prevVx = car.vxMs, inHit = false;
  const dt = 1 / 120;
  while (laps < 2 && time < maxS) {
    car.step(dt, {});
    time += dt;
    const s = car.sMeters;
    if (s < prev - L / 2) {
      laps++;
      if (laps === 1) lapStart = time;
    }
    prev = s;
    // Impacts: the rigid-body cars report theirs; on the LC26 one is a deceleration no brake can give, counted once
    const wall = car.telemetry.f12026?.wallImpact;
    const rigidHit = !!wall && wall.atMs !== lastWallMs && wall.speedMs > 2;
    lastWallMs = wall?.atMs ?? lastWallMs;
    const decelHit = !car.telemetry.f12026 && (car.vxMs - prevVx) / dt < -75;
    prevVx = car.vxMs;
    if (laps === 1) {
      const i = ((Math.round(s / t.ds) % t.n) + t.n) % t.n;
      n[i] = car.lateralOffsetM;
      v[i] = car.vxMs;
      if (!Number.isFinite(tAt[i])) tAt[i] = time - lapStart;
      if (car.telemetry.offTrack) off++;
      if (rigidHit || (decelHit && !inHit)) walls++;
      const e = Math.abs(car.lateralOffsetM - plan.n[i]);
      maxErr = Math.max(maxErr, e);
      sumErr += e;
      cnt++;
    }
    inHit = decelHit;
  }
  return { lapS: laps >= 2 ? time - lapStart : Infinity, offTrackFrames: off, maxErrM: maxErr, meanErrM: cnt ? sumErr / cnt : NaN, wallHits: walls, plan, n, v, t: tAt };
}
