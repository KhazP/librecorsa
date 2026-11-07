/**
 * A flying lap of the AI car on the full physics, tracking a supplied line with its speed plan (the D1 tracker),
 * timed on its second lap from a flying start. Reports the lap time, the frames spent off the track and the worst
 * distance from the line.
 */
import type { BuiltTrackData } from '../../../src/lib/track-data';
import { F12026CarSim } from '../../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../../src/lib/sim/gt3/AmgGt3Sim';
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
  plan: AiDrivePlan;
  /** Driven lateral offset and speed per AI grid point (NaN where not visited) */
  n: Float64Array;
  v: Float64Array;
}

export function physicsLap(
  track: BuiltTrackData,
  root: THREE.Object3D | null,
  line: 'f1' | 'gt3',
  offsets: ArrayLike<number>,
  gripScale = 0.95,
  maxS = 400
): PhysicsLap {
  const t = aiTrackFor(track);
  const plan = makeDrivePlan(t, offsets, carLimitsFor(line === 'gt3' ? 'amg-gt3' : 'f12026-car', gripScale));
  const car: SimulatorCar = line === 'gt3' ? createAmgGt3Sim(track, root) : new F12026CarSim(track, root);
  car.assistPreset = 'pro';
  car.aiAutopilot = true;
  car.aiPaceScale = 1;
  car.aiPlan = plan;
  car.resetToStartGrid(true, 0);
  const L = track.totalLengthM;
  const n = new Float64Array(t.n).fill(NaN), v = new Float64Array(t.n).fill(NaN);
  let laps = 0, prev = car.sMeters, lapStart = 0, time = 0, off = 0, maxErr = 0, sumErr = 0, cnt = 0;
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
    if (laps === 1) {
      const i = ((Math.round(s / t.ds) % t.n) + t.n) % t.n;
      n[i] = car.lateralOffsetM;
      v[i] = car.vxMs;
      if (car.telemetry.offTrack) off++;
      const e = Math.abs(car.lateralOffsetM - plan.n[i]);
      maxErr = Math.max(maxErr, e);
      sumErr += e;
      cnt++;
    }
  }
  return { lapS: laps >= 2 ? time - lapStart : Infinity, offTrackFrames: off, maxErrM: maxErr, meanErrM: cnt ? sumErr / cnt : NaN, plan, n, v };
}
