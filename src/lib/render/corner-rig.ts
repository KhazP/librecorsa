import * as THREE from "three";
import type { TyreVisualState } from "@/lib/sim/simulator-car";
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

/**
 * Height of the road under a rig corner in the car frame (m), from the physics' tyre contacts (`contactInCar`, tyres in
 * physics wheel order FR, FL, RR, RL): along the line through that side's front and rear contacts, at the corner's own
 * z, so a model whose wheelbase differs from the vehicle model's still sits on the road when the body pitches.
 * 0 (the car frame's origin plane) when the vehicle model gives no contacts.
 */
export function cornerRoadHeight(corner: RigCorner, tyres?: readonly TyreVisualState[]): number {
  const front = tyres?.[corner.isLeft ? 1 : 0]?.contactInCar;
  const rear = tyres?.[corner.isLeft ? 3 : 2]?.contactInCar;
  if (!front || !rear) return 0;
  const span = front.z - rear.z;
  if (!(Math.abs(span) > 0.5)) return corner.isFront ? front.y : rear.y;
  return front.y + ((corner.steer.position.z - front.z) * (front.y - rear.y)) / span;
}

/**
 * Per frame, for every car model: steers the fronts (`roadWheelRad`, + = left, with Ackermann), spins every wheel,
 * applies the tyres' visual deformation and puts each wheel on the road under it (corners and `tyres` in physics wheel
 * order). The steer pivot rests at `restY` (tyre bottom on the car frame's origin plane), drops by the tyre's visual
 * squash so the flattened patch stays where the bottom was, and follows the road under the corner in the car frame:
 * the wheels are unsprung, so they do not move with the body's heave, pitch and roll on the rigid-body model.
 */
export function updateCorners(
  corners: readonly RigCorner[],
  roadWheelRad: number,
  wheelRotationRad: number,
  tyres?: readonly TyreVisualState[]
): void {
  corners.forEach((c, i) => {
    if (c.isFront) {
      const inside = (roadWheelRad > 0) === c.isLeft;
      c.steer.rotation.y = roadWheelRad * (inside ? ACKERMANN_INSIDE : ACKERMANN_OUTSIDE);
    }
    c.spin.rotation.x = wheelRotationRad;
    const state = tyres?.[i];
    if (!state) return;
    let squash = 0;
    if (c.tyre) {
      c.tyre.update(state, wheelRotationRad);
      squash = c.tyre.axleDropM;
    }
    c.steer.position.y = c.restY - squash + cornerRoadHeight(c, tyres);
  });
}
