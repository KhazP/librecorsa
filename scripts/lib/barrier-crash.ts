/**
 * Barrier crash harness for the verify scripts: a car flat out (no brakes) into the outside barrier of a corner at
 * a set angle, then a recovery drive away. Penetration is measured on the car's body outline against the GLB's
 * `Track_Collider_Wall_*` segments, which sit on the track-facing face of the visible barrier.
 */
import type { BuiltTrackData } from '../../src/lib/track-data';
import { WALL_SEGMENT_STRIDE, type WallQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';

export interface CrashInputs {
  throttle: number;
  brake: number;
  /** +1 = full right lock */
  steer: number;
  /** Paddles (a press per frame they are set) */
  shiftUp?: boolean;
  shiftDown?: boolean;
}

/** One car model behind a common driving surface */
export interface CrashCar {
  /** Put the car at (x, z) heading `yawRad` (atan2(forward.x, forward.z)) at `speedMs`; `s` = its track distance */
  place(x: number, z: number, yawRad: number, speedMs: number, s: number): void;
  step(dt: number, inputs: CrashInputs): void;
  /** CG and heading */
  pose(): { x: number; z: number; yawRad: number; speedMs: number };
  /** Body outline in the body frame: [left, forward] (m) */
  readonly outline: ReadonlyArray<readonly [number, number]>;
  /** Current gear (−1 = reverse); `hasReverse` = the gearbox can select it */
  gear(): number;
  readonly hasReverse: boolean;
}

export interface CrashScenario {
  /** Track distance of the impact point on the barrier */
  sHit: number;
  /** -1 = left barrier, +1 = right */
  side: -1 | 1;
  /** Angle between the path and the barrier (deg) */
  angleDeg: number;
  speedKmh: number;
  /** Render frame rate the car is stepped at */
  fps: number;
}

export interface CrashResult {
  /** Deepest any outline point got past the barrier face (m, 0 = never past) */
  maxPenM: number;
  /** Deepest the CG got past the barrier face (m) */
  maxCgPenM: number;
  /** Speed when contact started (km/h) */
  impactKmh: number;
  /** After the hit (before the recovery drive): outline past the face (m), CG past the face */
  settledPenM: number;
  cgBehind: boolean;
  /** Recovery: track distance covered, final speed, the outline's deepest point past the face meanwhile, reversed */
  recoveryProgressM: number;
  recoveryKmh: number;
  recoveryPenM: number;
  reversed: boolean;
  /** Clear of the barrier, back on the track side, moving along the track */
  droveAway: boolean;
  finite: boolean;
}

/** A track-facing wall point with its barrier direction (unit, along the lap) and normal (unit, toward the track) */
export function barrierPoint(track: BuiltTrackData, walls: WallQuery, s: number, side: -1 | 1) {
  const smp = track.getSampleAtDistance(s);
  const ids = new Int32Array(512);
  const n = walls.near(smp.position.x, smp.position.z, 80, ids);
  const seg = walls.segments;
  let best: { x: number; z: number; tx: number; tz: number; nx: number; nz: number; ds: number } | null = null;
  for (let k = 0; k < n; k++) {
    const o = ids[k] * WALL_SEGMENT_STRIDE;
    const mx = 0.5 * (seg[o] + seg[o + 2]);
    const mz = 0.5 * (seg[o + 1] + seg[o + 3]);
    const pr = track.projectWorldToTrack(mx, mz, s);
    if (Math.sign(pr.lateralOffset) !== side) continue;
    const ds = Math.abs(pr.s - s);
    if (best && ds >= best.ds) continue;
    let tx = seg[o + 2] - seg[o];
    let tz = seg[o + 3] - seg[o + 1];
    const tl = Math.hypot(tx, tz);
    tx /= tl;
    tz /= tl;
    if (tx * smp.tangent.x + tz * smp.tangent.z < 0) {
      tx = -tx;
      tz = -tz;
    }
    // Normal toward the centreline
    let nx = -tz;
    let nz = tx;
    if ((pr.sample.position.x - mx) * nx + (pr.sample.position.z - mz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    best = { x: mx, z: mz, tx, tz, nx, nz, ds };
  }
  if (!best) throw new Error(`no ${side < 0 ? 'left' : 'right'} barrier near s ${s.toFixed(0)} m`);
  return best;
}

/**
 * Signed distance of world points from the barrier face on one side of the track (+ = track side, − = past it):
 * the nearest wall segment on that side, its normal turned toward the centreline.
 */
export function barrierGauge(track: BuiltTrackData, walls: WallQuery, side: -1 | 1) {
  const ids = new Int32Array(512);
  const seg = walls.segments;
  /** Per segment: 0 = other side, ±1 = normal sign toward the track */
  const orient = new Map<number, number>();
  const orientOf = (i: number, hint: number) => {
    let v = orient.get(i);
    if (v === undefined) {
      const o = i * WALL_SEGMENT_STRIDE;
      const mx = 0.5 * (seg[o] + seg[o + 2]);
      const mz = 0.5 * (seg[o + 1] + seg[o + 3]);
      const pr = track.projectWorldToTrack(mx, mz, hint);
      if (Math.sign(pr.lateralOffset) !== side) v = 0;
      else {
        const dx = seg[o + 2] - seg[o];
        const dz = seg[o + 3] - seg[o + 1];
        v = (pr.sample.position.x - seg[o]) * -dz + (pr.sample.position.z - seg[o + 1]) * dx >= 0 ? 1 : -1;
      }
      orient.set(i, v);
    }
    return v;
  };
  return (x: number, z: number, hintS: number): number => {
    const n = walls.near(x, z, 8, ids);
    let bestD2 = Infinity;
    let signed = Infinity;
    for (let k = 0; k < n; k++) {
      const i = ids[k];
      const sign = orientOf(i, hintS);
      if (sign === 0) continue;
      const o = i * WALL_SEGMENT_STRIDE;
      const ax = seg[o];
      const az = seg[o + 1];
      const dx = seg[o + 2] - ax;
      const dz = seg[o + 3] - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-8) continue;
      const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2));
      const ex = x - (ax + t * dx);
      const ez = z - (az + t * dz);
      const d2 = ex * ex + ez * ez;
      if (d2 >= bestD2) continue;
      bestD2 = d2;
      const len = Math.sqrt(len2);
      signed = (sign * ((x - ax) * -dz + (z - az) * dx)) / len;
    }
    return signed;
  };
}

/**
 * Flat out into the barrier along a straight path at `angleDeg` to it, starting 10 m off it; then 1.5 s off the pedals
 * and a recovery drive (pure pursuit on the centreline, part throttle, reversing off the barrier first if the car has
 * stopped nose-in and has a reverse gear) of up to 15 s.
 */
export function runBarrierCrash(track: BuiltTrackData, walls: WallQuery, car: CrashCar, sc: CrashScenario): CrashResult {
  const wp = barrierPoint(track, walls, sc.sHit, sc.side);
  const gauge = barrierGauge(track, walls, sc.side);
  const th = (sc.angleDeg * Math.PI) / 180;
  // Path direction: along the barrier, turned into it by the angle
  const dx = Math.cos(th) * wp.tx - Math.sin(th) * wp.nx;
  const dz = Math.cos(th) * wp.tz - Math.sin(th) * wp.nz;
  const runUp = 10 / Math.sin(th);
  const x0 = wp.x - dx * runUp;
  const z0 = wp.z - dz * runUp;
  const p0 = track.projectWorldToTrack(x0, z0, sc.sHit);
  car.place(x0, z0, Math.atan2(dx, dz), sc.speedKmh / 3.6, p0.s);

  const dt = 1 / sc.fps;
  let hint = p0.s;
  /** Outline's deepest point past the face (≥ 0), its smallest clearance, and the CG's depth past it */
  const outlinePen = () => {
    const p = car.pose();
    const fx = Math.sin(p.yawRad);
    const fz = Math.cos(p.yawRad);
    // Body +left = up × forward = (fz, −fx)
    let gap = Infinity;
    for (const [l, f] of car.outline) gap = Math.min(gap, gauge(p.x + fz * l + fx * f, p.z - fx * l + fz * f, hint));
    return { pen: Math.max(0, -gap), gap, cg: -gauge(p.x, p.z, hint), pose: p };
  };
  const finiteNow = () => {
    const p = car.pose();
    return [p.x, p.z, p.yawRad, p.speedMs].every(Number.isFinite);
  };

  let maxPen = 0;
  let maxCgPen = -Infinity;
  let impactKmh = 0;
  let t = 0;
  let tContact = -1;
  let finite = true;
  // Flat out, steering straight, no brakes until the hit; then the driver lifts for 1.5 s
  while (t < 6) {
    const prev = car.pose();
    car.step(dt, tContact < 0 ? { throttle: 1, brake: 0, steer: 0 } : { throttle: 0, brake: 0, steer: 0 });
    t += dt;
    if (!finiteNow()) {
      finite = false;
      break;
    }
    const m = outlinePen();
    hint = track.projectWorldToTrack(m.pose.x, m.pose.z, hint).s;
    maxPen = Math.max(maxPen, m.pen);
    maxCgPen = Math.max(maxCgPen, m.cg);
    // Contact: the outline within 5 cm of the face, or a sudden loss of speed next to it (at a low frame rate the
    // bounce can be over within one frame)
    if (tContact < 0 && (m.gap < 0.05 || (m.gap < 1.5 && m.pose.speedMs < 0.9 * prev.speedMs))) {
      tContact = t;
      impactKmh = prev.speedMs * 3.6;
    }
    if (tContact >= 0 && t - tContact > 1.5) break;
  }
  const settled = outlinePen();

  // Recovery: aim 30 m up the track at part throttle. Stopped with the nose on the barrier, a car with a reverse gear
  // backs off first, as a driver would.
  const sStart = hint;
  let recPen = 0;
  let tr = 0;
  let stoppedS = 0;
  let mode: 'drive' | 'toReverse' | 'reverse' | 'toDrive' = 'drive';
  let reverseS = 0;
  let reversed = false;
  let pulse = false;
  let turnSign = 0;
  while (finite && tr < 15) {
    const m0 = outlinePen();
    const p = m0.pose;
    const look = track.getSampleAtDistance((hint + 30) % track.totalLengthM);
    const tx = look.position.x - p.x;
    const tz = look.position.z - p.z;
    const fx = Math.sin(p.yawRad);
    const fz = Math.cos(p.yawRad);
    // right = forward × up = (−fz, fx)
    let alpha = Math.atan2(tx * -fz + tz * fx, tx * fx + tz * fz);
    // Facing away from the target, α flips sign across ±180°: keep turning the way the turn is already going
    if (Math.abs(alpha) > 2.6 && turnSign !== 0 && Math.sign(alpha) !== turnSign) alpha = turnSign * Math.PI;
    if (Math.abs(alpha) > 0.3) turnSign = Math.sign(alpha);
    const steer = Math.max(-1, Math.min(1, 2 * alpha));
    const noseIn = m0.gap < 0.5 && fx * wp.nx + fz * wp.nz < -0.3;
    stoppedS = p.speedMs < 1 ? stoppedS + dt : 0;
    if (mode === 'drive' && car.hasReverse && noseIn && stoppedS > 0.5) mode = 'toReverse';
    pulse = !pulse;
    let inputs: CrashInputs;
    if (mode === 'toReverse') {
      inputs = { throttle: 0, brake: 1, steer: 0, shiftDown: pulse };
      if (car.gear() < 0) {
        mode = 'reverse';
        reverseS = 0;
        reversed = true;
      }
    } else if (mode === 'reverse') {
      // Backing up swings the nose the other way
      inputs = { throttle: 0.4, brake: 0, steer: -steer };
      reverseS += dt;
      if (reverseS > 2 || m0.gap > 3) mode = 'toDrive';
    } else if (mode === 'toDrive') {
      inputs = { throttle: 0, brake: 1, steer: 0, shiftUp: p.speedMs < 1 && pulse };
      if (car.gear() >= 1) mode = 'drive';
    } else {
      inputs = { throttle: 0.35, brake: 0, steer };
    }
    car.step(dt, inputs);
    tr += dt;
    if (!finiteNow()) {
      finite = false;
      break;
    }
    const m = outlinePen();
    hint = track.projectWorldToTrack(m.pose.x, m.pose.z, hint).s;
    recPen = Math.max(recPen, m.pen);
    const progress = ((hint - sStart + track.totalLengthM * 1.5) % track.totalLengthM) - track.totalLengthM * 0.5;
    if (progress > 60) break;
  }
  const end = outlinePen();
  const recoveryProgressM = ((hint - sStart + track.totalLengthM * 1.5) % track.totalLengthM) - track.totalLengthM * 0.5;
  const recoveryKmh = end.pose.speedMs * 3.6;
  return {
    maxPenM: maxPen,
    maxCgPenM: maxCgPen,
    impactKmh,
    settledPenM: Math.max(0, settled.pen),
    cgBehind: settled.cg > 0,
    recoveryProgressM,
    recoveryKmh,
    recoveryPenM: recPen,
    reversed,
    droveAway: finite && recoveryProgressM > 40 && recoveryKmh > 20 && end.cg < 0 && end.pen <= 0.05,
    finite,
  };
}
