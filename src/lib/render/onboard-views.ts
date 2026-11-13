import * as THREE from "three";
import type { CameraMode } from "@/types/f1";
import type { CarId } from "@/lib/cars/car-registry";
import type { Lc26CameraAnchor, Lc26ModelInstance } from "@/lib/lc26-car-model";
import { CAMERA_MODES } from "./camera-modes";
import { isNudgeView, isZeroNudge, nudgeOf, type CameraNudges } from "@/lib/settings/camera-nudges";

/**
 * Where the dash view sits in each car: from the driver's eye (the car's cockpit anchor, in the chassis' axes: +X left,
 * +Y up, +Z forward), with its pitch and field of view. Placed from each model and checked in the car: in the GT3s,
 * whose screens stand on the dash, the camera is just past the rim, over the screen; where the screen is on the wheel
 * (the 2026 Prototype, the 496R) or the dials sit low behind it (the Liana) it stays on the driver's side, looking over
 * or through the rim.
 */
interface OverWheelView {
  fromEye: readonly [number, number, number];
  pitchDeg: number;
  fovDeg: number;
}

const OVER_WHEEL: Readonly<Record<CarId, OverWheelView>> = {
  lc26: { fromEye: [0, -0.03, 0.18], pitchDeg: -14, fovDeg: 58 },
  // Both GT3 cameras sit ahead of everything the wheel sweeps (the near plane is 12 cm), so no grip crosses the lens
  "amg-gt3": { fromEye: [0, -0.08, 0.56], pitchDeg: -13, fovDeg: 58 },
  "bmw-m4-gt3": { fromEye: [0, -0.05, 0.62], pitchDeg: -18, fovDeg: 58 },
  "mtr-496r": { fromEye: [0, -0.04, 0.14], pitchDeg: -10, fovDeg: 58 },
  "lc-lmdh": { fromEye: [0, -0.04, 0.14], pitchDeg: -10, fovDeg: 58 },
  liana: { fromEye: [0, -0.075, 0.3], pitchDeg: -20, fovDeg: 58 },
  "nissan-r33-jgtc": { fromEye: [0, -0.06, 0.25], pitchDeg: -14, fovDeg: 58 },
  "nissan-r32-jtcc": { fromEye: [0, -0.06, 0.25], pitchDeg: -14, fovDeg: 58 },
};

/** A car not in the table: a little ahead of and below the eye */
const FALLBACK: OverWheelView = { fromEye: [0, -0.05, 0.25], pitchDeg: -8, fovDeg: 58 };

/** The dash view's own field of view in a car (before the base FOV and the player's seat) */
export const dashViewFovDeg = (car: CarId): number => (OVER_WHEEL[car] ?? FALLBACK).fovDeg;

/**
 * The anchor a view's camera sits on this frame: the model's own, or the dash view placed from the eye, moved (and its
 * FOV widened or narrowed) by the player's seat for that car and view. Returns scratch objects (or the model's own
 * anchors, never changed): read them this frame only.
 */
export class OnboardViews {
  private readonly overWheel: Lc26CameraAnchor = { pos: new THREE.Vector3(), pitchRad: 0, fovDeg: 58 };
  private readonly nudged: Lc26CameraAnchor = { pos: new THREE.Vector3(), pitchRad: 0, fovDeg: 58 };

  resolve(
    anchors: Lc26ModelInstance["cameraAnchors"] | null,
    mode: CameraMode,
    car: CarId,
    nudges: CameraNudges | undefined
  ): Lc26CameraAnchor | null {
    const view = CAMERA_MODES[mode];
    if (!anchors || !view.anchor) return null;
    let base: Lc26CameraAnchor;
    if (view.anchor === "overWheel") {
      // From the eye before the player's cockpit nudge: moving one view leaves the other where it was
      const spec = OVER_WHEEL[car] ?? FALLBACK;
      base = this.overWheel;
      const eye = anchors.cockpit.pos;
      base.pos.set(eye.x + spec.fromEye[0], eye.y + spec.fromEye[1], eye.z + spec.fromEye[2]);
      base.pitchRad = spec.pitchDeg * THREE.MathUtils.DEG2RAD;
      base.fovDeg = spec.fovDeg;
    } else {
      base = anchors[view.anchor];
    }
    if (!isNudgeView(mode)) return base;
    const n = nudgeOf(nudges, car, mode);
    if (isZeroNudge(n)) return base;
    const out = this.nudged;
    out.pos.set(base.pos.x - n.right, base.pos.y + n.up, base.pos.z + n.fwd);
    out.pitchRad = base.pitchRad + n.tiltDeg * THREE.MathUtils.DEG2RAD;
    // The base FOV every car shares shifts this again in the camera rig
    out.fovDeg = base.fovDeg + n.fovDeg;
    return out;
  }
}
