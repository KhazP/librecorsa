import * as THREE from "three";
import type { TyreVisualState } from "@/lib/sim/simulator-car";
import { createGroundHit, type GroundQuery } from "@/lib/sim/f12026-car/TrackColliderQuery";
import type { TyreDeformationHandle } from "./tyre-deformation";

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

/**
 * Static camber baked into a wheel node, in the physics' camberLeftRad sense (+ = top toward +X): a rotation a about
 * the forward (Z) axis moves the top of the wheel toward −X for a > 0
 */
export function bakedCamberOf(wheel: THREE.Object3D): number {
  return -new THREE.Euler().setFromQuaternion(wheel.quaternion, "ZYX").z;
}

/** One wheel corner of a car rig: a steer pivot (unsprung, steered) holding a spin group (the rotating parts) */
export interface RigCorner {
  steer: THREE.Object3D;
  spin: THREE.Object3D;
  isFront: boolean;
  isLeft: boolean;
  /** Steer pivot height at rest; lowered by the tyre's visual squash so the flat patch stays on the road */
  restY: number;
  tyre: TyreDeformationHandle | null;
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
}

/** The ground probe starts this far above the wheel's first estimate, so a road a little above it is still found */
const PROBE_ABOVE_M = 0.6;

const _p = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hit = createGroundHit();

/**
 * Car-frame height (m) of the road under a wheel at (`xInCar`, `zInCar`) on a car drawn at `position` /
 * `quaternion`. A wheel on the road (`onRoad`) sits on `ground`, probed under the point at `contactY` (the
 * physics' own contact height there) and probed again from that first estimate: on a tilted car, moving a point
 * along the car's up also moves it across the road, so a single probe misses by the slope over that shift. A wheel
 * off the ground hangs where the physics puts it, and a car without a collider (or a probe that finds no ground)
 * keeps `contactY`.
 */
export function seatCorner(
  ground: GroundQuery | null,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  xInCar: number,
  zInCar: number,
  contactY: number,
  onRoad: boolean
): number {
  if (!onRoad || !ground) return contactY;
  // A world height difference along the car's up, which steep tilts would blow up
  const upY = Math.max(0.5, _up.set(0, 1, 0).applyQuaternion(quaternion).y);
  _p.set(xInCar, contactY, zInCar).applyQuaternion(quaternion).add(position);
  if (!ground.query(_p.x, _p.z, _p.y + PROBE_ABOVE_M, _hit)) return contactY;
  let y = contactY + (_hit.height - _p.y) / upY;
  _p.set(xInCar, y, zInCar).applyQuaternion(quaternion).add(position);
  if (ground.query(_p.x, _p.z, _p.y + PROBE_ABOVE_M, _hit)) y += (_hit.height - _p.y) / upY;
  return y;
}

/**
 * Height of the road under a rig corner in the car frame (m). The physics' tyre contacts (`contactInCar`) give it
 * along the line through that side's front and rear contacts, at the corner's own z, so a model whose wheelbase
 * differs from the vehicle model's still sits on the road when the body pitches; a tyre on the road (`onRoad`) then
 * sits on the car's ground under the corner itself (`seatCorner`), which also takes in a model's different track
 * width on cambered, crowned and kerbed road. Without tyre state the wheel rests on the ground under the corner; 0
 * (the car frame's origin plane) when the vehicle model's tyres give no contacts.
 */
export function cornerRoadHeight(corner: RigCorner, wheels?: WheelSeating): number {
  if (!wheels) return 0;
  const { x, z } = corner.steer.position;
  const tyres = wheels.tyres;
  if (!tyres) return seatCorner(wheels.ground, wheels.position, wheels.quaternion, x, z, 0, true);
  const front = tyres[corner.isLeft ? 1 : 0]?.contactInCar;
  const rear = tyres[corner.isLeft ? 3 : 2]?.contactInCar;
  if (!front || !rear) return 0;
  const span = front.z - rear.z;
  const contactY =
    Math.abs(span) > 0.5 ? front.y + ((z - front.z) * (front.y - rear.y)) / span : corner.isFront ? front.y : rear.y;
  const own = tyres[corner.isFront ? (corner.isLeft ? 1 : 0) : corner.isLeft ? 3 : 2];
  return seatCorner(wheels.ground, wheels.position, wheels.quaternion, x, z, contactY, own.onRoad);
}

/**
 * Per frame, for every car model: steers the fronts (`roadWheelRad`, + = left, with Ackermann), spins every wheel,
 * applies the tyres' visual deformation and puts each wheel on the road under it (corners and `wheels.tyres` in
 * physics wheel order). The steer pivot rests at `restY` (tyre bottom on the car frame's origin plane), drops by the
 * tyre's visual squash so the flattened patch stays where the bottom was, and follows the road under the corner in
 * the car frame: the wheels are unsprung, so they do not move with the body's heave, pitch and roll on the rigid-body
 * model.
 */
export function updateCorners(
  corners: readonly RigCorner[],
  roadWheelRad: number,
  wheelRotationRad: number,
  wheels?: WheelSeating
): void {
  corners.forEach((c, i) => {
    if (c.isFront) {
      const inside = (roadWheelRad > 0) === c.isLeft;
      c.steer.rotation.y = roadWheelRad * (inside ? ACKERMANN_INSIDE : ACKERMANN_OUTSIDE);
    }
    c.spin.rotation.x = wheelRotationRad;
    if (!wheels) return;
    const state = wheels.tyres?.[i];
    let squash = 0;
    if (state && c.tyre) {
      c.tyre.update(state, wheelRotationRad);
      squash = c.tyre.axleDropM;
    }
    c.steer.position.y = c.restY - squash + cornerRoadHeight(c, wheels);
  });
}
