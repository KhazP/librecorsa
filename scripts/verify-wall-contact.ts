/**
 * Barrier contact on the rigid-body cars (`VehiclePhysics.applyWallContacts` over `TrackWallQuery` faces):
 *
 *   npx tsx scripts/verify-wall-contact.ts
 *
 * On synthetic walls over the flat test pad, for the F1 (the Prototype) and the GT3:
 *   - thin posts (6 and 12 cm square) driven at head-on, across the car's width at 15 / 42 / 60 m/s: none may pass
 *     into the car's outline
 *   - the end of a row of bales, hit at a shallow angle along its last metres: the wall's push-out in a sub-step may
 *     not exceed how far the outline moved in it (no throw)
 *   - a straight wall, a row of posts and a row of slanted posts approached yawed 2–20°: the first contact comes at a
 *     face, not in the air before it
 *   - a long slide along a wall built of many short faces: no snag at their joints
 * On the hosted circuits when this clone has them (`public/tracks/<id>`; a GLB to test instead of the hosted one can be
 * named in WALL_BORGLOH_GLB / WALL_GOODWOOD_GLB): Borgloh's thinnest props head-on and yawed, and Goodwood's
 * first-corner bale row. WALL_CARS picks the cars (f1, gt3, f12026); WALL_REPORT=1 prints every run and never fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { getActiveTrackData, setActiveTrack, type RawTrackJson, type BuiltTrackData } from '../src/lib/track-data';
import { TrackWallQuery, createGroundHit, type GroundHit, type WallQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import type { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { createLc26Sim } from '../src/lib/sim/f12026-car/Lc26Sim';
import { loadGlbGeometry } from './lib/glb-geometry';
import { createFlatTestTrack } from './lib/flat-track';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 120;
const STRICT = process.env.WALL_REPORT !== '1';

type Pt = [number, number];
/** The F1 driven (the Prototype on the rigid-body engine), the GT3, and the f12026-car model (WALL_CARS to pick) */
type CarKind = 'f1' | 'gt3' | 'f12026';
const CARS: CarKind[] = (process.env.WALL_CARS ?? 'f1,gt3').split(',') as CarKind[];
const makeCar = (kind: CarKind, track: BuiltTrackData, root: THREE.Object3D | null): F12026CarSim =>
  kind === 'gt3' ? createAmgGt3Sim(track, root) : kind === 'f12026' ? new F12026CarSim(track, root) : createLc26Sim(track, root);

// ---------------------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------------------

function hull(ps: Pt[]): Pt[] {
  const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: Pt[] = [];
  for (const q of p.reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dz - p[1]);
}

/** Signed distance of p into the convex CCW polygon h: > 0 inside (to its nearest edge), < 0 outside */
function depthIn(p: Pt, h: Pt[]): number {
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) inside = false;
    best = Math.min(best, segDist(p, a, b));
  }
  return inside ? best : -best;
}

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Clearance between a convex polygon and a segment: > 0 apart, < 0 overlapping (the segment's deepest point in it) */
function polySegClearance(h: Pt[], a: Pt, b: Pt): number {
  let best = Infinity;
  let overlap = false;
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    const d = h[(i + 1) % h.length];
    if (segsCross(a, b, c, d)) overlap = true;
    best = Math.min(best, segDist(a, c, d), segDist(b, c, d), segDist(c, a, b));
  }
  const da = depthIn(a, h);
  const db = depthIn(b, h);
  if (da > 0 || db > 0) return -Math.max(da, db);
  if (overlap) {
    // Crossing the outline with both ends outside: how far the outline's corners are past the segment's line
    const nx = -(b[1] - a[1]);
    const nz = b[0] - a[0];
    const l = Math.hypot(nx, nz);
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of h) {
      const s = ((q[0] - a[0]) * nx + (q[1] - a[1]) * nz) / l;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    return -Math.min(-lo, hi);
  }
  return best;
}

const _p = new THREE.Vector3();
/** The car's barrier outline in world XZ: the convex hull of its wall probes where they are now */
function outlineWorld(v: VehiclePhysics): Pt[] {
  return hull(
    v.wallProbePoints.map((q) => {
      _p.copy(q).applyQuaternion(v.quaternion).add(v.position);
      return [_p.x, _p.z] as Pt;
    })
  );
}

/** A wall mesh of vertical quads (ax, az) → (bx, bz) from y0 to y1, as a track's collider would be */
function wallMesh(quads: { a: Pt; b: Pt }[], y0 = -0.5, y1 = 1.2): THREE.Mesh {
  const pos: number[] = [];
  for (const { a, b } of quads) {
    pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1]);
    pos.push(a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.Mesh(g);
  m.name = 'Track_Collider_Wall_Props';
  return m;
}

/** A box's four faces: centre (cx, cz), half sizes along x and z, turned `deg` about its centre */
function boxQuads(cx: number, cz: number, hx: number, hz: number, deg = 0): { a: Pt; b: Pt }[] {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  const corners: Pt[] = (
    [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ] as Pt[]
  ).map(([x, z]) => [cx + c * x - s * z, cz + s * x + c * z]);
  return corners.map((a, i) => ({ a, b: corners[(i + 1) % 4] }));
}

// ---------------------------------------------------------------------------------------------------------------
// Instrumentation: the barrier's push-out per sub-step, against how far the outline moved in that sub-step
// ---------------------------------------------------------------------------------------------------------------

interface PushLog {
  /** Largest push-out in one sub-step (m) and the outline's travel in that sub-step */
  worstPush: number;
  worstPushTravel: number;
  /** Largest (push − travel) over the sub-steps (m): > 0 = the wall moved the car further than it had gone in */
  worstExcess: number;
  /** Sum of push-outs within one 1/120 s frame, worst frame */
  frameSum: number;
  worstFrame: number;
}

type Hooked = Record<string, (...args: unknown[]) => unknown>;
/** Wraps the car's sub-step and barrier pass to log each sub-step's push-out (the barrier pass must exist) */
function instrument(v: VehiclePhysics): PushLog {
  const log: PushLog = { worstPush: 0, worstPushTravel: 0, worstExcess: 0, frameSum: 0, worstFrame: 0 };
  const h = v as unknown as Hooked;
  const sub = h.substep;
  const wall = h.applyWallContacts;
  if (typeof sub !== 'function' || typeof wall !== 'function') throw new Error('VehiclePhysics.substep / applyWallContacts not found');
  const pos0 = new THREE.Vector3();
  const quat0 = new THREE.Quaternion();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  h.substep = function (this: VehiclePhysics, ...args: unknown[]) {
    pos0.copy(v.position);
    quat0.copy(v.quaternion);
    return sub.apply(this, args);
  };
  h.applyWallContacts = function (this: VehiclePhysics, ...args: unknown[]) {
    const px = v.position.x;
    const pz = v.position.z;
    const r = wall.apply(this, args);
    const push = Math.hypot(v.position.x - px, v.position.z - pz);
    if (push > 0) {
      let travel = 0;
      for (const q of v.wallProbePoints) {
        a.copy(q).applyQuaternion(quat0).add(pos0);
        b.copy(q).applyQuaternion(v.quaternion);
        travel = Math.max(travel, Math.hypot(b.x + px - a.x, b.z + pz - a.z));
      }
      travel = Math.max(travel, Math.hypot(px - pos0.x, pz - pos0.z));
      if (push > log.worstPush) {
        log.worstPush = push;
        log.worstPushTravel = travel;
      }
      log.worstExcess = Math.max(log.worstExcess, push - travel);
      log.frameSum += push;
    }
    return r;
  };
  return log;
}
const endFrame = (log: PushLog) => {
  log.worstFrame = Math.max(log.worstFrame, log.frameSum);
  log.frameSum = 0;
};

const wallOf = (car: F12026CarSim) => (car.vehicle as unknown as { walls?: WallQuery }).walls;

const crosses = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
};
const wallIds = new Int32Array(1024);
const groundHit = createGroundHit();
/** A barrier segment runs through the car's outline as it stands */
function placedInBarrier(car: F12026CarSim): boolean {
  const walls = wallOf(car);
  if (!walls) return false;
  const v = car.vehicle;
  const h = outlineWorld(v);
  const k = walls.near(v.position.x, v.position.z, 6, wallIds);
  for (let i = 0; i < k; i++) {
    const o = wallIds[i] * 6;
    const a: Pt = [walls.segments[o], walls.segments[o + 1]];
    const b: Pt = [walls.segments[o + 2], walls.segments[o + 3]];
    if (depthIn(a, h) > 0 || depthIn(b, h) > 0) return true;
    for (let e = 0; e < h.length; e++) if (crosses(a, b, h[e], h[(e + 1) % h.length])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------

interface HeadOnResult {
  runs: number;
  through: number;
  /** Runs the car left the scene in: a non-finite position, or 2 m higher or lower over the ground than where it was placed */
  lost: number;
  /** Starts left out: a barrier through the car where it was placed (a prop set just behind one), not a head-on run */
  skipped: number;
  /**
   * Runs lost after the car rolled past 60°: a car on its side can blow up into the air on any surface, old physics or
   * new (a separate fault from barrier contact), so these are reported here, not failed
   */
  rolledLost: number;
  bySpeed: Map<number, number>;
  /** Deepest the post's footprint got inside the car's outline (m), over the runs that did not go through */
  deepest: number;
  detail: string[];
}

/**
 * Head-on at a post whose footprint is `foot` (world XZ points), on the line `t` (unit, the car's heading) with the car's
 * centreline `d` m to the side of the post's centre (sign `side`): 8 offsets × 15 / 42 / 60 m/s × 4 start phases.
 * Through = the footprint got more than 0.2 m inside the outline.
 */
function headOnGrid(
  car: F12026CarSim,
  centre: Pt,
  foot: Pt[],
  t: Pt,
  side: number,
  sOf: (x: number, z: number) => number
): HeadOnResult {
  const v = car.vehicle;
  const lat: Pt = [-t[1], t[0]];
  const yaw = Math.atan2(t[0], t[1]);
  const res: HeadOnResult = { runs: 0, through: 0, lost: 0, skipped: 0, rolledLost: 0, bySpeed: new Map(), deepest: -Infinity, detail: [] };
  for (const d of [0, 0.25, 0.5, 0.68, 0.8, 0.9, 0.95, 1.0]) {
    for (const speed of [15, 42, 60]) {
      for (const ph of [0, 0.25, 0.5, 0.75]) {
        const back = 9 + ph * speed * DT;
        const x0 = centre[0] + lat[0] * side * d - t[0] * back;
        const z0 = centre[1] + lat[1] * side * d - t[1] * back;
        car.restorePose({ x: x0, z: z0, yawRad: yaw, speedMs: speed, s: sOf(x0, z0) });
        if (placedInBarrier(car)) {
          res.skipped++;
          continue;
        }
        // Height over the ground under the car (a hill climb's grade moves it metres up or down on a run)
        const ground = (v as unknown as { ground: { query(x: number, z: number, y: number, out: GroundHit): boolean } }).ground;
        const overGround = (): number =>
          ground.query(v.position.x, v.position.z, v.position.y + 50, groundHit) ? v.position.y - groundHit.height : Number.NaN;
        const placedOver = overGround();
        let lost = !Number.isFinite(v.position.x + v.position.y + v.position.z);
        let deepest = -Infinity;
        let touched = false;
        const trace: string[] = [];
        let rolled = false;
        for (let k = 0; k < 240; k++) {
          const sp = v.speedMs;
          const tel = car.step(DT, { throttle: !touched && sp < speed ? 1 : 0, brake: 0, analogSteer: 0 }) as unknown as { f12026?: { wallContact?: boolean } };
          if (tel.f12026?.wallContact) touched = true;
          // Blown up, or launched: 2 m higher or lower over the ground than where it was placed (no ground under the car,
          // past the edge of the circuit's model, is neither)
          const over = overGround();
          // Tilted past 60° from upright (the body's up axis against the world's)
          if (new THREE.Vector3(0, 1, 0).applyQuaternion(v.quaternion).y < 0.5) rolled = true;
          if (process.env.WALL_TRACE) {
            const e = new THREE.Euler().setFromQuaternion(v.quaternion, 'YXZ');
            trace.push(`k ${k} over ${over.toFixed(2)} v ${v.speedMs.toFixed(1)} vy ${v.velocity.y.toFixed(2)} roll ${(e.z * 57.3).toFixed(0)} pitch ${(e.x * 57.3).toFixed(0)} wall ${(car.telemetry as any).f12026?.wallContact ? 1 : 0}`);
          }
          if (!Number.isFinite(v.position.x + v.position.y + v.position.z) || (Number.isFinite(over) && Math.abs(over - placedOver) > 2)) {
            lost = true;
            break;
          }
          const h = outlineWorld(v);
          for (const q of foot) deepest = Math.max(deepest, depthIn(q, h));
          const along = (v.position.x - centre[0]) * t[0] + (v.position.z - centre[1]) * t[1];
          if (along > 6 || (k > 30 && v.speedMs < 0.3)) break;
        }
        res.runs++;
        if (lost && rolled) {
          res.rolledLost++;
          res.detail.push(`d ${d} ${speed} m/s ph ${ph}: rolled over, then blew up`);
        } else if (lost) {
          // Flown off or blown up: neither a pass nor a hit, a fault of its own
          res.lost++;
          res.detail.push(`d ${d} ${speed} m/s ph ${ph}: lost` + (trace.length ? `\n        ${trace.slice(-14).join('\n        ')}` : ''));
        } else if (deepest > 0.2) {
          res.through++;
          res.bySpeed.set(speed, (res.bySpeed.get(speed) ?? 0) + 1);
          res.detail.push(`d ${d} ${speed} m/s ph ${ph}: ${deepest.toFixed(2)} m in`);
        } else res.deepest = Math.max(res.deepest, deepest);
      }
    }
  }
  return res;
}

interface SwipeResult {
  contacts: number;
  log: PushLog;
  /** Frames within 1 s of first contact with a wheel unloaded (tyre load under 1 N), worst run; all four */
  worstOff: number;
  worstAllOff: number;
  /** Largest gain in upward speed after the first contact (m/s) */
  worstDvy: number;
  lines: string[];
}

/** Rolls the car from a pose until 1.5 s after its first barrier contact, logging push-outs and wheel loads */
function swipe(car: F12026CarSim, starts: { x: number; z: number; yaw: number; speed: number; s: number; tag: string }[]): SwipeResult {
  const v = car.vehicle;
  const log = instrument(v);
  const res: SwipeResult = { contacts: 0, log, worstOff: 0, worstAllOff: 0, worstDvy: 0, lines: [] };
  for (const st of starts) {
    car.restorePose({ x: st.x, z: st.z, yawRad: st.yaw, speedMs: st.speed, s: st.s });
    const before = { ...log };
    log.worstPush = 0;
    log.worstExcess = 0;
    log.worstFrame = 0;
    let touched = -1;
    let off = 0;
    let allOff = 0;
    let vy0 = 0;
    let dvy = 0;
    for (let k = 0; k < 600; k++) {
      const vyPrev = v.velocity.y;
      const tel = car.step(DT, { throttle: 0, brake: 0, analogSteer: 0 }) as unknown as { f12026?: { wallContact?: boolean } };
      endFrame(log);
      if (tel.f12026?.wallContact && touched < 0) {
        touched = k;
        vy0 = vyPrev;
      }
      if (touched >= 0) {
        if (k - touched <= 120) {
          const n = v.wheels.filter((w) => !(w.fz > 1)).length;
          if (n > 0) off++;
          if (n === 4) allOff++;
          dvy = Math.max(dvy, v.velocity.y - vy0);
        }
        if (k - touched > 180) break;
      }
    }
    if (touched >= 0) res.contacts++;
    res.worstOff = Math.max(res.worstOff, off);
    res.worstAllOff = Math.max(res.worstAllOff, allOff);
    res.worstDvy = Math.max(res.worstDvy, dvy);
    res.lines.push(
      `${st.tag}: ${touched < 0 ? 'no contact' : `push ${log.worstPush.toFixed(3)} m (outline moved ${log.worstPushTravel.toFixed(3)}), frame ${log.worstFrame.toFixed(3)} m, wheels off ${off} frames (all ${allOff}), dvy +${dvy.toFixed(2)}, v after ${v.speedMs.toFixed(1)}`}`
    );
    log.worstPush = Math.max(before.worstPush, log.worstPush);
    log.worstPushTravel = before.worstPush >= log.worstPush ? before.worstPushTravel : log.worstPushTravel;
    log.worstExcess = Math.max(before.worstExcess, log.worstExcess);
    log.worstFrame = Math.max(before.worstFrame, log.worstFrame);
  }
  return res;
}

/**
 * Yawed approach: heading `yawDeg` into the wall line (unit `t` along it, the wall on the side `n` points away from),
 * rolling slowly at it; the clearance between the outline and the faces `segs` at the first contact (> 0 = in the air)
 */
function firstContactGap(car: F12026CarSim, start: Pt, t: Pt, n: Pt, yawDeg: number, speed: number, segs: [Pt, Pt][], s0: (x: number, z: number) => number): number {
  const v = car.vehicle;
  const th = (yawDeg * Math.PI) / 180;
  const dir: Pt = [t[0] * Math.cos(th) - n[0] * Math.sin(th), t[1] * Math.cos(th) - n[1] * Math.sin(th)];
  const gapNow = () => {
    const h = outlineWorld(v);
    let gap = Infinity;
    for (const [a, b] of segs) gap = Math.min(gap, polySegClearance(h, a, b));
    return gap;
  };
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  // Started 0.4 m off the faces
  car.restorePose({ x: start[0], z: start[1], yawRad: Math.atan2(dir[0], dir[1]), speedMs: speed, s: s0(start[0], start[1]) });
  const g0 = gapNow();
  const x0 = start[0] - n[0] * (g0 - 0.4);
  const z0 = start[1] - n[1] * (g0 - 0.4);
  car.restorePose({ x: x0, z: z0, yawRad: Math.atan2(dir[0], dir[1]), speedMs: speed, s: s0(x0, z0) });
  // The clearance in the sub-step whose barrier pass first acts (moves the car or changes its speed), as the pass
  // found the outline: ≤ 0 at a real contact, the air gap at a hit in the air
  const h = v as unknown as Hooked;
  const wall = h.applyWallContacts;
  let gap = NaN;
  const vel = new THREE.Vector3();
  h.applyWallContacts = function (this: VehiclePhysics, ...args: unknown[]) {
    if (!Number.isNaN(gap)) return wall.apply(this, args);
    pos.copy(v.position);
    quat.copy(v.quaternion);
    vel.copy(v.velocity);
    const r = wall.apply(this, args);
    if (!pos.equals(v.position) || !vel.equals(v.velocity)) {
      // Measured at the pose the pass found
      const after = v.position.clone();
      const qAfter = v.quaternion.clone();
      v.position.copy(pos);
      v.quaternion.copy(quat);
      gap = gapNow();
      v.position.copy(after);
      v.quaternion.copy(qAfter);
    }
    return r;
  };
  try {
    for (let k = 0; k < 720 && Number.isNaN(gap); k++) car.step(DT, { throttle: v.speedMs < speed ? 0.15 : 0, brake: 0, analogSteer: 0 });
  } finally {
    h.applyWallContacts = wall;
  }
  return gap;
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic walls on the flat pad
// ---------------------------------------------------------------------------------------------------------------

const flat = createFlatTestTrack();
const flatS = (_x: number, z: number) => ((z % flat.totalLengthM) + flat.totalLengthM) % flat.totalLengthM;
const Z0 = 2000;

function flatCar(kind: CarKind, quads: { a: Pt; b: Pt }[]): F12026CarSim {
  const car = makeCar(kind, flat, null);
  car.vehicle.setWalls(new TrackWallQuery([wallMesh(quads)]));
  return car;
}

console.log('\n== Thin posts head-on (flat pad)');
for (const kind of CARS) {
  for (const size of [0.06, 0.12]) {
    const centre: Pt = [0, Z0];
    const car = flatCar(kind, boxQuads(centre[0], centre[1], size / 2, size / 2));
    const foot: Pt[] = [
      [centre[0] - size / 2, centre[1] - size / 2],
      [centre[0] + size / 2, centre[1] - size / 2],
      [centre[0] + size / 2, centre[1] + size / 2],
      [centre[0] - size / 2, centre[1] + size / 2],
    ];
    let through = 0;
    let lost = 0;
    let runs = 0;
    let deepest = -Infinity;
    const bySpeed = new Map<number, number>();
    for (const side of [1, -1]) {
      const r = headOnGrid(car, centre, foot, [0, 1], side, flatS);
      through += r.through;
      lost += r.lost;
      runs += r.runs;
      deepest = Math.max(deepest, r.deepest);
      for (const [s, n] of r.bySpeed) bySpeed.set(s, (bySpeed.get(s) ?? 0) + n);
      if (!STRICT) for (const l of r.detail.slice(0, 6)) console.log(`      ${l}`);
    }
    const sp = [15, 42, 60].map((s) => `${s} m/s ${bySpeed.get(s) ?? 0}`).join(', ');
    check(`${kind}: ${size * 100} cm post head-on, none through`, through === 0 && lost === 0, `${through}/${runs} through [${sp}], ${lost} lost, deepest of the rest ${deepest.toFixed(3)} m in`);
  }
}

console.log('\n== The end of a row of bales (flat pad)');
{
  // Bales 1.2 m deep from x = −4.7 to −3.5 (the car's right), along z up to Z0 where the row ends
  const quads = boxQuads(-4.1, Z0 - 30, 0.6, 30);
  for (const kind of CARS) {
    const car = flatCar(kind, quads);
    const starts = [];
    for (const endOff of [-6, -3, -1.5, -0.5, 0, 0.5, 1, 1.5]) {
      for (const ang of [5, 15, 30]) {
        for (const speed of [15, 30]) {
          // Aimed at the row's road face `endOff` m from its end, from 10 m out, turned `ang` toward it
          const th = (ang * Math.PI) / 180;
          const dir: Pt = [-Math.sin(th), Math.cos(th)];
          const hit: Pt = [-3.5, Z0 + endOff];
          const back = 2.4 / Math.sin(th) + 4;
          starts.push({ x: hit[0] - dir[0] * back, z: hit[1] - dir[1] * back, yaw: Math.atan2(dir[0], dir[1]), speed, s: Z0, tag: `end ${endOff} m ${ang}° ${speed} m/s` });
        }
      }
    }
    const r = swipe(car, starts);
    if (!STRICT) for (const l of r.lines) console.log(`      ${l}`);
    console.log(
      `      ${kind}: ${r.contacts}/${starts.length} contacts; worst push ${r.log.worstPush.toFixed(3)} m (outline moved ${r.log.worstPushTravel.toFixed(3)} m), worst frame ${r.log.worstFrame.toFixed(3)} m, wheels off ${r.worstOff} frames (all ${r.worstAllOff}), dvy +${r.worstDvy.toFixed(2)} m/s`
    );
    check(`${kind}: bale row end, push-out within the sub-step's travel`, r.log.worstExcess <= 0.005, `worst excess ${r.log.worstExcess.toFixed(3)} m`);
  }
}

console.log('\n== Yawed approach: first contact at the face (flat pad)');
{
  // A straight wall along z at x = −4 (its face toward +x), built of 2 m faces
  const wallQuads: { a: Pt; b: Pt }[] = [];
  for (let z = Z0 - 100; z < Z0 + 100; z += 2) wallQuads.push({ a: [-4, z], b: [-4, z + 2] });
  const wallSegs: [Pt, Pt][] = wallQuads.map((q) => [q.a, q.b]);
  // A row of 6 cm posts 1.5 m apart along the same line; and of 12 cm posts turned 30°, whose faces slant across it
  const posts = (size: number, deg: number) => {
    const quads: { a: Pt; b: Pt }[] = [];
    for (let z = Z0 - 60; z < Z0 + 60; z += 1.5) quads.push(...boxQuads(-4 - size / 2, z, size / 2, size / 2, deg));
    return quads;
  };
  const postQuads = posts(0.06, 0);
  const slantQuads = posts(0.12, 30);
  const segsOf = (quads: { a: Pt; b: Pt }[]): [Pt, Pt][] => quads.map((q) => [q.a, q.b]);
  for (const kind of CARS) {
    for (const [name, quads, segs] of [
      ['straight wall', wallQuads, wallSegs],
      ['row of posts', postQuads, segsOf(postQuads)],
      ['row of slanted posts', slantQuads, segsOf(slantQuads)],
    ] as const) {
      const car = flatCar(kind, quads);
      const gaps: string[] = [];
      let worst = -Infinity;
      for (const yawDeg of [2, 5, 10, 20]) {
        for (const off of [0, 0.37, 0.71]) {
          const g = firstContactGap(car, [0, Z0 - 30 + off], [0, 1], [1, 0], yawDeg, 4, segs as [Pt, Pt][], flatS);
          worst = Math.max(worst, g);
          if (off === 0) gaps.push(`${yawDeg}° ${g.toFixed(3)}`);
        }
      }
      check(`${kind}: ${name}, yawed, first contact at the face (≤ 5 mm)`, worst <= 0.005, `gap at the first contact ${gaps.join(', ')} m (worst ${worst.toFixed(3)})`);
    }
  }
}

console.log('\n== Long shallow slide along a wall of short faces (flat pad)');
{
  const quads: { a: Pt; b: Pt }[] = [];
  // 0.5 m faces with a slight zig-zag (±1 cm), as a traced barrier's are
  for (let z = Z0 - 50, i = 0; z < Z0 + 400; z += 0.5, i++) quads.push({ a: [-4 + (i % 2 ? 0.01 : 0), z], b: [-4 + (i % 2 ? 0 : 0.01), z + 0.5] });
  for (const kind of CARS) {
    const car = flatCar(kind, quads);
    const v = car.vehicle;
    const lines: string[] = [];
    let worstDrop = 0;
    let missed = 0;
    for (const ang of [2, 5]) {
      const th = (ang * Math.PI) / 180;
      const dir: Pt = [-Math.sin(th), Math.cos(th)];
      // The CG 2.2 m off the wall, so the outline meets it some 0.8 m further in
      car.restorePose({ x: -1.8, z: Z0 - 0.8 / Math.tan(th), yawRad: Math.atan2(dir[0], dir[1]), speedMs: 40, s: Z0 });
      let touched = -1;
      let v0 = 0;
      let drop = 0;
      let impacts = 0;
      // The last run's impact, if any, is not this one's
      let lastImpact = (car.telemetry as unknown as { f12026?: { wallImpact?: { atMs: number } } }).f12026?.wallImpact?.atMs ?? -1;
      for (let k = 0; k < 600; k++) {
        const before = v.speedMs;
        const tel = car.step(DT, { throttle: 0, brake: 0, analogSteer: 0 }) as unknown as { f12026?: { wallContact?: boolean; wallImpact?: { atMs: number } } };
        const imp = tel.f12026?.wallImpact?.atMs ?? -1;
        const newImpact = imp !== lastImpact && imp >= 0;
        // A frame's contact flag is its last physics step's: a glancing touch inside the frame shows as its impact
        if ((tel.f12026?.wallContact || newImpact) && touched < 0) {
          touched = k;
          v0 = before;
        }
        if (newImpact) {
          impacts++;
          lastImpact = imp;
        }
        if (touched >= 0 && k > touched + 2) drop = Math.max(drop, before - v.speedMs);
        if (touched >= 0 && k - touched >= 240) break;
      }
      worstDrop = Math.max(worstDrop, drop);
      if (touched < 0) missed++;
      lines.push(`${ang}°: ${touched < 0 ? 'no contact' : `${v0.toFixed(1)} → ${v.speedMs.toFixed(1)} m/s over 2 s`}, worst frame drop ${drop.toFixed(2)} m/s, impact events ${impacts}`);
    }
    console.log(`      ${kind}: ${lines.join('; ')}`);
    // After the first hit the tail swings in and takes up to about 1 m/s off in a frame; a joint catching the nose
    // stops the car (5 m/s and more in a frame)
    check(`${kind}: shallow slide, no snag at face joints`, missed === 0 && worstDrop < 1.5, `worst one-frame speed drop ${worstDrop.toFixed(2)} m/s`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Hosted circuits
// ---------------------------------------------------------------------------------------------------------------

const tracksDir = path.join(process.cwd(), 'public', 'tracks');
function loadCircuit(id: string, glbEnv: string): { track: BuiltTrackData; root: THREE.Object3D; raw: RawTrackJson & { metadata?: { pointToPoint?: { startS: number } } }; glb: string } | null {
  const td = path.join(tracksDir, id, 'track_data.json');
  const glb = process.env[glbEnv] ?? path.join(tracksDir, id, `${id}.glb`);
  if (!fs.existsSync(td) || !fs.existsSync(glb)) {
    console.log(`      (skipped: no ${id} track data or GLB in this clone)`);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(td, 'utf8'));
  setActiveTrack(id, raw);
  return { track: getActiveTrackData(), root: loadGlbGeometry(glb), raw, glb };
}

/** The road's tangent and the side the road is on, at a point beside it */
function roadFrame(track: BuiltTrackData, x: number, z: number, onRun: (s: number) => boolean): { t: Pt; roadSide: number; s: number } {
  let bestS = 0;
  let bestD = Infinity;
  for (const sp of track.samples) {
    if (!onRun(sp.s)) continue;
    const d = Math.hypot(sp.position.x - x, sp.position.z - z);
    if (d < bestD) {
      bestD = d;
      bestS = sp.s;
    }
  }
  const sm = track.getSampleAtDistance(bestS);
  const l = Math.hypot(sm.tangent.x, sm.tangent.z);
  const t: Pt = [sm.tangent.x / l, sm.tangent.z / l];
  const lat: Pt = [-t[1], t[0]];
  return { t, roadSide: (sm.position.x - x) * lat[0] + (sm.position.z - z) * lat[1] > 0 ? 1 : -1, s: bestS };
}

console.log('\n== Borgloh: thin props head-on');
{
  // The visible footprints at car height (x0, x1, z0, z1) of the circuit's thinnest props
  const PROPS: { name: string; box: [number, number, number, number] }[] = [
    { name: 'BGP_Weiss_04', box: [217.715, 217.852, 156.21, 156.352] },
    { name: 'BGP_Gelb', box: [518.525, 518.66, 432.486, 432.61] },
    { name: 'CornerSign_013', box: [-590.398, -590.217, -530.814, -530.731] },
    { name: 'SIGN_08', box: [508.747, 508.795, 418.484, 418.529] },
    { name: 'Zaunpfosten_001', box: [535.976, 536.003, 630.034, 630.062] },
  ];
  const c = loadCircuit('borgloh', 'WALL_BORGLOH_GLB');
  if (c) {
    console.log(`      ${path.basename(c.glb)}`);
    const sOf = (x: number, z: number) => c.track.projectWorldToTrack(x, z).s;
    for (const kind of CARS) {
      const car = makeCar(kind, c.track, c.root);
      let through = 0;
      let lost = 0;
      let rolledLost = 0;
      let skipped = 0;
      let runs = 0;
      const per: string[] = [];
      for (const p of PROPS) {
        const [x0, x1, z0, z1] = p.box;
        const centre: Pt = [(x0 + x1) / 2, (z0 + z1) / 2];
        const foot: Pt[] = [
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
        ];
        const f = roadFrame(c.track, centre[0], centre[1], () => true);
        const r = headOnGrid(car, centre, foot, f.t, f.roadSide, sOf);
        through += r.through;
        lost += r.lost;
        rolledLost += r.rolledLost;
        skipped += r.skipped;
        runs += r.runs;
        per.push(`${p.name} ${r.through}${r.lost ? ` (${r.lost} lost)` : ''}${r.skipped ? ` (${r.skipped} starts in a barrier left out)` : ''}`);
        if (!STRICT) for (const l of r.detail.slice(0, 4)) console.log(`      ${kind} ${p.name} ${l}`);
      }
      check(`${kind}: Borgloh thin props head-on, none through`, through === 0, `${through}/${runs} through (${per.join(', ')})`);
      check(`${kind}: …and the car stays in the scene on every run`, lost === 0, `${lost}/${runs} flown off or non-finite` + (rolledLost ? `; ${rolledLost} more blew up after rolling over (not failed here)` : ''));
      // A prop that stands behind a barrier leaves some starts out; the rest of its starts must still be run
      check(`${kind}: …with most starts run`, runs >= 0.6 * (runs + skipped), `${runs} run, ${skipped} placed in a barrier left out`);
      // Yawed 10° toward each prop from the road, nose first: the first contact at a face, not in the air
      const walls = wallOf(car);
      if (walls) {
        const ids = new Int32Array(1024);
        const noseZ = Math.max(...car.vehicle.wallProbePoints.map((q) => q.z));
        const gaps: string[] = [];
        let worst = -Infinity;
        let contacts = 0;
        let approaches = 0;
        for (const p of PROPS) {
          const [x0, x1, z0, z1] = p.box;
          const centre: Pt = [(x0 + x1) / 2, (z0 + z1) / 2];
          const f = roadFrame(c.track, centre[0], centre[1], () => true);
          const toRoad: Pt = [-f.t[1] * f.roadSide, f.t[0] * f.roadSide];
          const k = walls.near(centre[0], centre[1], 12, ids);
          const segs: [Pt, Pt][] = [];
          for (let i = 0; i < k; i++) {
            const o = ids[i] * 6;
            segs.push([
              [walls.segments[o], walls.segments[o + 1]],
              [walls.segments[o + 2], walls.segments[o + 3]],
            ]);
          }
          for (const along of [0, 0.5]) {
            const back = 0.4 / Math.tan((10 * Math.PI) / 180) + noseZ + along;
            const start: Pt = [centre[0] + toRoad[0] * 2.5 - f.t[0] * back, centre[1] + toRoad[1] * 2.5 - f.t[1] * back];
            const g = firstContactGap(car, start, f.t, toRoad, 10, 4, segs, sOf);
            approaches++;
            if (Number.isFinite(g)) {
              worst = Math.max(worst, g);
              contacts++;
            }
            if (along === 0) gaps.push(`${p.name} ${Number.isFinite(g) ? g.toFixed(3) : 'none'}`);
          }
        }
        // Some approaches end on the verge before the prop (the ground there, a fence): at least half must reach it
        check(
          `${kind}: Borgloh props, yawed 10°, first contact at a face (≤ 5 mm)`,
          contacts * 2 >= approaches && worst <= 0.005,
          `gap at the first contact: ${gaps.join(', ')} m (contact on ${contacts} of ${approaches} approaches)`
        );
      }
    }
  }
}

console.log("\n== Goodwood: the first corner's bale row (right)");
{
  const c = loadCircuit('goodwood', 'WALL_GOODWOOD_GLB');
  if (c) {
    console.log(`      ${path.basename(c.glb)}`);
    const L = c.track.totalLengthM;
    const st = c.raw.metadata?.pointToPoint?.startS ?? 0;
    const at = (runM: number, ang: number, speed: number) => {
      const sm = c.track.getSampleAtDistance((st + runM - 12) % L);
      const t: Pt = [sm.tangent.x, sm.tangent.z];
      const tl = Math.hypot(t[0], t[1]);
      t[0] /= tl;
      t[1] /= tl;
      const right: Pt = [-t[1], t[0]];
      const a = (ang * Math.PI) / 180;
      const dir: Pt = [t[0] * Math.cos(a) + right[0] * Math.sin(a), t[1] * Math.cos(a) + right[1] * Math.sin(a)];
      return { x: sm.position.x, z: sm.position.z, yaw: Math.atan2(dir[0], dir[1]), speed, s: (st + runM - 12) % L, tag: `run ${runM} m ${ang}° ${speed} m/s` };
    };
    for (const kind of CARS) {
      const one = swipe(makeCar(kind, c.track, c.root), [at(252, 15, 30)]);
      console.log(`      ${kind} ${one.lines[0]}`);
      const starts = [];
      for (let runM = 244; runM <= 264; runM += 2) for (const ang of [5, 15, 30]) for (const speed of [15, 30]) starts.push(at(runM, ang, speed));
      const r = swipe(makeCar(kind, c.track, c.root), starts);
      if (!STRICT) for (const l of r.lines) console.log(`      ${l}`);
      console.log(
        `      ${kind}: ${r.contacts}/${starts.length} contacts; worst push ${r.log.worstPush.toFixed(3)} m (outline moved ${r.log.worstPushTravel.toFixed(3)} m), worst frame ${r.log.worstFrame.toFixed(3)} m, wheels off ${r.worstOff} frames (all ${r.worstAllOff}), dvy +${r.worstDvy.toFixed(2)} m/s`
      );
      const worstExcess = Math.max(r.log.worstExcess, one.log.worstExcess);
      check(`${kind}: Goodwood T1 bales, push-out within the sub-step's travel`, worstExcess <= 0.005, `worst excess ${worstExcess.toFixed(3)} m`);
    }
  }
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  if (STRICT) process.exit(1);
} else console.log('\nAll wall contact checks passed.');
