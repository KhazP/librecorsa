/**
 * A flying lap of the AI car on the full physics, tracking a supplied line with its speed plan (the D1 tracker),
 * timed on its second lap from a flying start. Reports the lap time, the frames spent off the track, the barrier hits
 * and the worst distance from the line. `line` names the car: the F1 line is driven by the f12026-car, or by the LC26
 * (`lc26`, its own physics and limits on the same line).
 */
import type { BuiltTrackData } from '../../../src/lib/track-data';
import { F12026CarSim } from '../../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../../src/lib/sim/gt3/AmgGt3Sim';
import { F1Physics2026 } from '../../../src/lib/f1-physics-2026';
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
}

/** The LC26 on the circuit's mesh barriers when there is a mesh, as the game attaches it, else on the data's wall lines */
function lc26On(track: BuiltTrackData, root: THREE.Object3D | null): SimulatorCar {
  const car = new F1Physics2026(track);
  if (root) car.attachTrackRoot(root);
  return car as unknown as SimulatorCar;
}

export function physicsLap(
  track: BuiltTrackData,
  root: THREE.Object3D | null,
  line: 'f1' | 'gt3' | 'lc26',
  offsets: ArrayLike<number>,
  gripScale = 0.95,
  maxS = 400
): PhysicsLap {
  const t = aiTrackFor(track);
  const plan = makeDrivePlan(t, offsets, carLimitsFor(line === 'gt3' ? 'amg-gt3' : line === 'lc26' ? 'lc26' : 'f12026-car', gripScale));
  const car: SimulatorCar =
    line === 'gt3' ? createAmgGt3Sim(track, root) : line === 'lc26' ? lc26On(track, root) : new F12026CarSim(track, root);
  car.assistPreset = 'pro';
  car.aiAutopilot = true;
  car.aiPaceScale = 1;
  car.aiPlan = plan;
  car.resetToStartGrid(true, 0);
  // On the line being judged from the start (the flying start puts the car on the stored line)
  car.teleportToDistance(car.sMeters, car.vxMs, plan.n[((Math.round(car.sMeters / t.ds) % t.n) + t.n) % t.n]);
  const L = track.totalLengthM;
  const n = new Float64Array(t.n).fill(NaN), v = new Float64Array(t.n).fill(NaN);
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
      if (car.telemetry.offTrack) off++;
      if (rigidHit || (decelHit && !inHit)) walls++;
      const e = Math.abs(car.lateralOffsetM - plan.n[i]);
      maxErr = Math.max(maxErr, e);
      sumErr += e;
      cnt++;
    }
    inHit = decelHit;
  }
  return { lapS: laps >= 2 ? time - lapStart : Infinity, offTrackFrames: off, maxErrM: maxErr, meanErrM: cnt ? sumErr / cnt : NaN, wallHits: walls, plan, n, v };
}
