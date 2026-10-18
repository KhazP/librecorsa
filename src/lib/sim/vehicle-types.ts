/**
 * Shared runtime types for the VF26 vehicle model (consumed by the renderer & visual FX).
 */

import type { SurfaceType } from '@/types/f1';
import type { TyreRuntime } from './ac-tyre';

/** Wheel index order: 0 = FR, 1 = FL, 2 = RR, 3 = RL */
export type WheelCornerIndex = 0 | 1 | 2 | 3;

export interface VehicleWheelState {
  index: WheelCornerIndex;
  isFront: boolean;
  isLeft: boolean;
  /** Position relative to the CG in the body frame (m): x forward, y left */
  staticPos: { x: number; y: number };
  /** Contact point in Three.js world space */
  worldPos: { x: number; y: number; z: number };
  /** Road surface height under the wheel (world Y, m) */
  zRoad: number;
  surfaceType: SurfaceType;
  surfaceFrictionMult: number;
  surfaceBumpM: number;
  /** Road height relative to the car's reference plane (m), previous/current outer step */
  roadOffsetPrev: number;
  roadOffset: number;
  /** Road-wheel steer angle (rad, + = left) */
  steerRad: number;
  /** Wheel angular velocity (rad/s) */
  spinVel: number;
  /** Accumulated visual rotation (rad) */
  rotationRad: number;
  /** Loaded tyre normal force (N) */
  fzN: number;
  /** Longitudinal / lateral tyre forces in the wheel frame (N) */
  ftN: number;
  fnN: number;
  /** Signed slip ratio (+ traction) */
  slipRatio: number;
  /** Slip angle (rad) */
  slipAngleRad: number;
  /** Combined normalised slip (1 = peak grip) */
  combinedSlipNorm: number;
  /** Available lateral friction coefficient */
  effectiveMu: number;
  /** Grip multiplier from temperature / camber / wear */
  gripFactor: number;
  /** Self-aligning moment (Nm) */
  torqueAlignNm: number;
  /** Floor clearance at this corner (m) */
  rideHeight: number;
  /** Suspension compression relative to static (m, + = bump) */
  suspCompression: number;
  suspCompressionVel: number;
  /** Unsprung vertical displacement relative to static (m) and velocity (m/s) */
  hubZ: number;
  hubZVel: number;
  /** Camber relative to the road, leaning toward +y (rad) */
  camberLeftRad: number;
  /** Previous sub-step camber angle for gyroscopic precession dγ/dt (rad) */
  prevCamberLeftRad?: number;
  /** 5-point contact patch lateral pressure centroid shift toward inner shoulder (-1..+1) */
  contactCentroidShiftInward?: number;
  /** 5-point contact patch lateral centroid shift (+left, m) for overturning moment Mx */
  contactCentroidShiftLeftM?: number;
  /** Dynamic 3D kingpin mechanical caster trail (m) */
  casterTrailM?: number;
  /** Dynamic 3D kingpin scrub radius (m) */
  scrubRadiusM?: number;
  /** Dynamic 3D kingpin inclination (rad) */
  kpiRad?: number;
  /** Dynamic 3D double-wishbone camber change (rad) */
  kinematicsCamberDeltaRad?: number;
  /** Dynamic 3D tie-rod bump steer toe change (rad) */
  kinematicsBumpSteerRad?: number;
  /** Overturning moment Mx from the contact centroid shift (Nm), last sub-step */
  overturningMomentNm?: number;
  /** Harmonic flat-spot vibration torque at the kingpin (Nm), last sub-step */
  flatSpotVibrationNm?: number;
  /** Brake torque currently applied (Nm) */
  brakeTorqueNm: number;
  /** Brake disc surface temperature (°C) */
  brakeTempC: number;
  /** 2-node physical brake disc state (surface, core, pad glazing, muFactor) */
  brakeDisc: import('./brake-physics').BrakeDiscState;
  /** Tyre runtime (carcass deflection, temperatures, wear) */
  tyre: TyreRuntime;
}
