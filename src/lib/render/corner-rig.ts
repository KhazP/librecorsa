import * as THREE from "three";
import type { TyreVisualState } from "@/lib/sim/simulator-car";
import { createGroundHit, type GroundQuery } from "@/lib/sim/f12026-car/TrackColliderQuery";
import { setLevelProfile, type TyreDeformationHandle, type TyreRoad, type TyreRoadProfile } from "./tyre-deformation";
import { createTyreContactShadow, placeTyreContactShadow } from "./tyre-contact-shadow";

/** Wheel nodes of the car GLBs in physics wheel order 0..3 (FR, FL, RR, RL), and their side suffixes */
export const WHEEL_NODES = ["WHEEL_RF", "WHEEL_LF", "WHEEL_RR", "WHEEL_LR"] as const;
export const WHEEL_SIDES = ["RF", "LF", "RR", "LR"] as const;

/** Ackermann: the inside front wheel turns this much more than the road-wheel angle, the outside this much less */
const ACKERMANN_INSIDE = 1.06;
const ACKERMANN_OUTSIDE = 0.94;

/** Matrix of `obj` relative to `ancestor` (both inside the same, already updated, hierarchy). */
export function relativeMatrix(obj: THREE.Object3D, ancestor: THREE.Object3D): THREE.Matrix4 {
  return new THREE.Matrix4().copy(ancestor.matrixWorld).invert().multiply(obj.matrixWorld);
}

/** One wheel corner of a car rig: a steer pivot (unsprung, steered) holding a spin group (the rotating parts) */
export interface RigCorner {
  steer: THREE.Object3D;
  spin: THREE.Object3D;
  isFront: boolean;
  isLeft: boolean;
  /** Steer pivot height at rest (tyre bottom on the car frame's origin plane), for a corner drawn without tyre state */
  restY: number;
  tyre: TyreDeformationHandle | null;
  /** The tyre's contact shadow on the road (`tyre-contact-shadow.ts`), made on its first seating; null: none */
  shadow?: THREE.Mesh | null;
}

/** What seats a car's drawn wheels on the road: the physics' tyres, the car's ground and the pose it is drawn at */
export interface WheelSeating {
  /**
   * Tyre state per corner in physics wheel order (FR, FL, RR, RL): load, deformation, contacts in the car frame.
   * Absent: a car drawn without its physics (a replayed one), whose undeformed wheels rest on the ground.
   */
  tyres?: readonly TyreVisualState[];
  /** The car's track collider (`SimulatorCar.groundQuery`); null: the physics' contacts alone */
  ground: GroundQuery | null;
  /** The car frame the rig is drawn in (its root's world pose) */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /**
   * How closely the tyres follow the road (default 2): 2 samples the ground across and along each tread (kerb edges,
   * steps) and draws the tyres' contact shadows, 1 samples it across only, 0 flattens each tyre on the plane under
   * its hub. The AI field lowers it with distance.
   */
  detail?: 0 | 1 | 2;
}

/** The ground probe starts this far above the wheel's first estimate, so a road a little above it is still found */
const PROBE_ABOVE_M = 0.6;
/** The road samples across and along a tread start this far above its plane: over a kerb, under a bridge */
const PROFILE_PROBE_ABOVE_M = 0.25;
/** Road samples across the tread at this share of its half-width either side, along it at this share of the radius */
const PROFILE_ACROSS = 0.9;
const PROFILE_ALONG = 0.45;
/** A road sample's height off the plane under the hub is held to this (m): a kerb top above, a drop into grass below */
const PROFILE_RISE_M = 0.08;
const PROFILE_DROP_M = 0.05;
/**
 * An end sample this far off the plane (m) means a kerb edge (or a ramp) between it and the hub: the side is bisected
 * PROFILE_BISECTIONS times so its knots straddle the edge (to an eighth of the way out: about 2 cm), where a straight
 * line from the hub to the end sample would cut a step's corner through the tread
 */
const PROFILE_STEP_M = 0.006;
const PROFILE_BISECTIONS = 3;
/** Width (m) of the rise or drop a knot pair draws at a kerb's edge */
const PROFILE_EDGE_M = 0.002;

const _p = new THREE.Vector3();
const _up = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _hit = createGroundHit();
const _profileHit = createGroundHit();

/**
 * Car-frame height (m) of the road under a wheel at (`xInCar`, `zInCar`) on a car drawn at `position` /
 * `quaternion`. A wheel on the road (`onRoad`) sits on `ground`, probed under the point at `contactY` (the
 * physics' own contact height there) and probed again from that first estimate: on a tilted car, moving a point
 * along the car's up also moves it across the road, so a single probe misses by the slope over that shift. A wheel
 * off the ground hangs where the physics puts it, and a car without a collider (or a probe that finds no ground)
 * keeps `contactY`. `normalInCar`, when given, gets the road's unit normal there in the car frame (zero when no
 * ground was found).
 */
export function seatCorner(
  ground: GroundQuery | null,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  xInCar: number,
  zInCar: number,
  contactY: number,
  onRoad: boolean,
  normalInCar?: THREE.Vector3
): number {
  normalInCar?.set(0, 0, 0);
  if (!onRoad || !ground) return contactY;
  // A world height difference along the car's up, which steep tilts would blow up
  const upY = Math.max(0.5, _up.set(0, 1, 0).applyQuaternion(quaternion).y);
  _p.set(xInCar, contactY, zInCar).applyQuaternion(quaternion).add(position);
  if (!ground.query(_p.x, _p.z, _p.y + PROBE_ABOVE_M, _hit)) return contactY;
  let y = contactY + (_hit.height - _p.y) / upY;
  _p.set(xInCar, y, zInCar).applyQuaternion(quaternion).add(position);
  // A missed second probe leaves the first's hit (and normal) in place
  if (ground.query(_p.x, _p.z, _p.y + PROBE_ABOVE_M, _hit)) y += (_hit.height - _p.y) / upY;
  normalInCar?.set(_hit.nx, _hit.ny, _hit.nz).applyQuaternion(_qi.copy(quaternion).invert());
  return y;
}

/**
 * Height of the road under a rig corner in the car frame (m). The physics' tyre contacts (`contactInCar`) give it
 * along the line through that side's front and rear contacts, at the corner's own z, so a model whose wheelbase
 * differs from the vehicle model's still sits on the road when the body pitches; a tyre on the road (`onRoad`) then
 * sits on the car's ground under the corner itself (`seatCorner`), which also takes in a model's different track
 * width on cambered, crowned and kerbed road. Without tyre state the wheel rests on the ground under the corner; 0
 * (the car frame's origin plane) when the vehicle model's tyres give no contacts. `normalInCar` as `seatCorner`'s.
 */
export function cornerRoadHeight(corner: RigCorner, wheels?: WheelSeating, normalInCar?: THREE.Vector3): number {
  normalInCar?.set(0, 0, 0);
  if (!wheels) return 0;
  const { x, z } = corner.steer.position;
  const tyres = wheels.tyres;
  if (!tyres) return seatCorner(wheels.ground, wheels.position, wheels.quaternion, x, z, 0, true, normalInCar);
  const front = tyres[corner.isLeft ? 1 : 0]?.contactInCar;
  const rear = tyres[corner.isLeft ? 3 : 2]?.contactInCar;
  if (!front || !rear) return 0;
  const span = front.z - rear.z;
  const contactY =
    Math.abs(span) > 0.5 ? front.y + ((z - front.z) * (front.y - rear.y)) / span : corner.isFront ? front.y : rear.y;
  const own = tyres[corner.isFront ? (corner.isLeft ? 1 : 0) : corner.isLeft ? 3 : 2];
  return seatCorner(wheels.ground, wheels.position, wheels.quaternion, x, z, contactY, own.onRoad, normalInCar);
}

/**
 * Road normal under a corner in the car frame from the physics' tyre contacts alone (a car without a collider): the
 * slope across the corner's axle and along its side, each where both of its tyres stand on the road (level otherwise)
 */
function contactsNormal(corner: RigCorner, tyres: readonly TyreVisualState[] | undefined, out: THREE.Vector3): void {
  let across = 0;
  let along = 0;
  if (tyres) {
    const l = tyres[corner.isFront ? 1 : 3];
    const r = tyres[corner.isFront ? 0 : 2];
    const f = tyres[corner.isLeft ? 1 : 0];
    const b = tyres[corner.isLeft ? 3 : 2];
    if (l?.onRoad && r?.onRoad && l.contactInCar && r.contactInCar) {
      const dx = l.contactInCar.x - r.contactInCar.x;
      if (Math.abs(dx) > 0.5) across = (l.contactInCar.y - r.contactInCar.y) / dx;
    }
    if (f?.onRoad && b?.onRoad && f.contactInCar && b.contactInCar) {
      const dz = f.contactInCar.z - b.contactInCar.z;
      if (Math.abs(dz) > 0.5) along = (f.contactInCar.y - b.contactInCar.y) / dz;
    }
  }
  out.set(-across, 1, -along).normalize();
}

/** Each corner's carrier frame (the wheel node its spin group turns in) in its steer pivot's: fixed once built */
const carrierInSteerOf = new WeakMap<RigCorner, THREE.Matrix4>();

function carrierInSteer(corner: RigCorner): THREE.Matrix4 {
  let m = carrierInSteerOf.get(corner);
  if (!m) {
    m = new THREE.Matrix4();
    for (let o = corner.spin.parent; o && o !== corner.steer; o = o.parent) {
      o.updateMatrix();
      m.premultiply(o.matrix);
    }
    carrierInSteerOf.set(corner, m);
  }
  return m;
}

// Per-corner scratch (single-threaded, never escapes a call)
const _normal = new THREE.Vector3();
const _carQInv = new THREE.Quaternion();
const _carrier = new THREE.Matrix4();
const _carrierInv = new THREE.Matrix4();
/** Car → carrier for normals (the transpose of the carrier → car linear part) and for directions */
const _normalToCarrier = new THREE.Matrix3();
const _dirToCarrier = new THREE.Matrix3();
const _contact = new THREE.Vector3();
const _contactC = new THREE.Vector3();
const _normalC = new THREE.Vector3();
const _left = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _s = new THREE.Vector3();

/** The last road sample: its carrier coordinate on the profile's axis and its height above the plane (m) */
const _sample = { t: 0, e: 0 };

/**
 * Probes the road `s` (m) from the contact along `dir` (car frame, on the road plane) and fills `_sample`; false when
 * the probe finds no ground there
 */
function probeRoad(
  dir: THREE.Vector3,
  s: number,
  axis: "x" | "z",
  ground: GroundQuery,
  wheels: WheelSeating,
  plane: THREE.Vector4
): boolean {
  _s.copy(_contact).addScaledVector(dir, s).applyQuaternion(wheels.quaternion).add(wheels.position);
  if (!ground.query(_s.x, _s.z, _s.y + PROFILE_PROBE_ABOVE_M, _profileHit)) return false;
  _s.y = _profileHit.height;
  _s.sub(wheels.position).applyQuaternion(_carQInv).applyMatrix4(_carrierInv);
  _sample.t = axis === "x" ? _s.x : _s.z;
  _sample.e = THREE.MathUtils.clamp(
    plane.x * _s.x + plane.y * _s.y + plane.z * _s.z - plane.w,
    -PROFILE_DROP_M,
    PROFILE_RISE_M
  );
  return true;
}

/**
 * Samples the road `distM` either side of the contact along `dir` (car frame, on the road plane) and writes the
 * profile `out` (`TyreRoad.across` / `along`) on carrier `axis`. Each side is filed under the sign of its carrier
 * coordinate (a mirrored wheel node has its carrier x pointing right). An end sample off the plane is bisected toward
 * the hub so the knots straddle a kerb's edge, and the tread is drawn over the higher side across them, so a step's
 * corner never cuts into it. A missed probe leaves that side level.
 */
function sampleProfile(
  out: TyreRoadProfile,
  dir: THREE.Vector3,
  distM: number,
  axis: "x" | "z",
  ground: GroundQuery,
  wheels: WheelSeating,
  plane: THREE.Vector4
): void {
  setLevelProfile(out, distM);
  for (let side = -1; side <= 1; side += 2) {
    // Which carrier side this is, from the point itself (before any probe can miss)
    _s.copy(_contact).addScaledVector(dir, side * distM).applyMatrix4(_carrierInv);
    const knots = (axis === "x" ? _s.x : _s.z) < 0 ? out.neg : out.pos;
    const negSide = knots === out.neg;
    if (!probeRoad(dir, side * distM, axis, ground, wheels, plane)) continue;
    const endT = Math.abs(_sample.t);
    const endE = _sample.e;
    if (negSide) out.ends.set(endT, endE, out.ends.z, out.ends.w);
    else out.ends.set(out.ends.x, out.ends.y, endT, endE);
    // Straight to the end sample, unless it is off the plane: then bisect for the edge
    let loS = 0, loT = 0, loE = 0;
    let hiS = side * distM, hiT = endT, hiE = endE;
    if (Math.abs(endE) > PROFILE_STEP_M) {
      for (let k = 0; k < PROFILE_BISECTIONS; k++) {
        const midS = 0.5 * (loS + hiS);
        if (!probeRoad(dir, midS, axis, ground, wheels, plane)) break;
        // The edge is in the half that changes more
        if (Math.abs(_sample.e - loE) >= Math.abs(hiE - _sample.e)) {
          hiS = midS;
          hiT = Math.abs(_sample.t);
          hiE = _sample.e;
        } else {
          loS = midS;
          loT = Math.abs(_sample.t);
          loE = _sample.e;
        }
      }
      // Over the edge's interval the tread takes the higher side, as a tyre drapes over a kerb's edge: up at the inner
      // knot for a rise, down at the outer one for a drop (a ramp is out by its slope over ~2 cm at most)
      const edge = Math.min(PROFILE_EDGE_M, Math.max(0, hiT - loT));
      if (hiE >= loE) knots.set(loT, loE, loT + edge, hiE);
      else knots.set(Math.max(loT, hiT - edge), loE, Math.max(loT, hiT), hiE);
    } else {
      knots.set(endT / 3, endE / 3, (2 * endT) / 3, (2 * endE) / 3);
    }
  }
}

/**
 * Seats a corner that has a deforming tyre and its state on the road at `roadY` (car frame) with the road normal
 * `normal` (car frame, unit): the hub (R − d) from the road plane along its normal (d the tyre's visual deflection; a
 * tyre in the air hangs its unloaded radius over the physics' contact), then the road in the tyre's carrier frame for
 * the shader (`TyreRoad`): the plane, its profile across and along the tread from road samples (`detail`), and the
 * wheel's left / forward along it. Places the tyre's contact shadow.
 */
function seatTyre(
  c: RigCorner,
  tyre: TyreDeformationHandle,
  state: TyreVisualState,
  wheels: WheelSeating,
  roadY: number,
  normal: THREE.Vector3,
  detail: number,
  wheelRotationRad: number
): void {
  const R = tyre.unloadedRadiusM;
  const d = tyre.deflectionOf(state);
  const onRoad = state.onRoad;
  const steer = c.steer;
  steer.position.y = onRoad ? roadY + (R - d) / Math.max(0.5, normal.y) : roadY + R;

  // Carrier frame (the steered, cambered wheel node) in the car frame, and back
  steer.updateMatrix();
  _carrier.multiplyMatrices(steer.matrix, carrierInSteer(c));
  _carrierInv.copy(_carrier).invert();
  _normalToCarrier.setFromMatrix4(_carrier).transpose();
  _dirToCarrier.setFromMatrix4(_carrierInv);

  // The road plane through the contact under the hub
  const road: TyreRoad = tyre.road;
  _contact.set(steer.position.x, roadY, steer.position.z);
  _contactC.copy(_contact).applyMatrix4(_carrierInv);
  _normalC.copy(normal).applyMatrix3(_normalToCarrier).normalize();
  road.plane.set(_normalC.x, _normalC.y, _normalC.z, _normalC.dot(_contactC));
  road.contact = onRoad ? 1 : 0;

  // The wheel's left (the steer pivot's +X: never mirrored, unlike some wheel nodes) and forward, along the road
  _left.set(1, 0, 0).applyQuaternion(steer.quaternion);
  _left.addScaledVector(normal, -_left.dot(normal)).normalize();
  _forward.crossVectors(_left, normal);
  road.left.copy(_left).applyMatrix3(_dirToCarrier);
  road.forward.copy(_forward).applyMatrix3(_dirToCarrier);

  // The road's profile under the tread: across it (kerb edges, crown), along it (steps ahead and behind)
  const ground = wheels.ground;
  if (onRoad && ground && detail >= 1) {
    sampleProfile(road.across, _left, PROFILE_ACROSS * tyre.halfWidthM, "x", ground, wheels, road.plane);
  } else {
    setLevelProfile(road.across, PROFILE_ACROSS * tyre.halfWidthM);
  }
  if (onRoad && ground && detail >= 2) {
    sampleProfile(road.along, _forward, PROFILE_ALONG * R, "z", ground, wheels, road.plane);
  } else {
    setLevelProfile(road.along, PROFILE_ALONG * R);
  }
  tyre.update(state, wheelRotationRad);

  // The contact shadow under the patch (the rig's root is the car frame the contact is in)
  if (c.shadow === undefined && steer.parent) c.shadow = createTyreContactShadow(steer.parent);
  if (c.shadow) {
    if (onRoad && detail >= 2) {
      const halfLength = Math.sqrt(Math.max(0, 2 * R * d - d * d));
      const deflection = state.verticalDeflectionM;
      placeTyreContactShadow(c.shadow, _contact, normal, _left, _forward, halfLength, tyre.halfWidthM, deflection);
    } else {
      c.shadow.visible = false;
    }
  }
}

/**
 * Per frame, for every car model: steers the fronts (`roadWheelRad`, + = left, with Ackermann), spins every wheel,
 * applies the tyres' visual deformation and puts each wheel on the road under it (corners and `wheels.tyres` in
 * physics wheel order). A corner with a deforming tyre and its state has its hub (R − d) from the road along the road's
 * normal (d the tyre's visual squash), so the flattened patch lies on the road whatever the body's roll and pitch, and
 * the road under the tyre (plane, kerb profile) goes to its shader (`seatTyre`); one without rests at `restY` (tyre
 * bottom on the car frame's origin plane) over the road. Both follow the road under the corner in the car frame: the
 * wheels are unsprung, so they do not move with the body's heave, pitch and roll on the rigid-body model.
 */
export function updateCorners(
  corners: readonly RigCorner[],
  roadWheelRad: number,
  wheelRotationRad: number,
  wheels?: WheelSeating
): void {
  if (wheels) _carQInv.copy(wheels.quaternion).invert();
  const detail = wheels?.detail ?? 2;
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    if (c.isFront) {
      const inside = (roadWheelRad > 0) === c.isLeft;
      c.steer.rotation.y = roadWheelRad * (inside ? ACKERMANN_INSIDE : ACKERMANN_OUTSIDE);
    }
    c.spin.rotation.x = wheelRotationRad;
    if (!wheels) continue;
    const state = wheels.tyres?.[i];
    const roadY = cornerRoadHeight(c, wheels, _normal);
    if (!state || !c.tyre) {
      c.steer.position.y = c.restY + roadY;
      if (c.shadow) c.shadow.visible = false;
      continue;
    }
    if (_normal.lengthSq() === 0) contactsNormal(c, wheels.tyres, _normal);
    seatTyre(c, c.tyre, state, wheels, roadY, _normal, detail, wheelRotationRad);
  }
}
