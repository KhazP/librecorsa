/**
 * What the simulator, the AI field and the renderer need from the player's car. Implemented by the VF26
 * model (`F1Physics2026`) and by the f12026-car adapter (`F12026CarSim`), so either can be driven.
 */
import type { ChassisSetup } from './car-setup';
import type * as THREE from 'three';
import type {
  ActiveAeroMode,
  AeroSetupPreset,
  CarTelemetry,
  ControlInputs,
  DriverAssistPreset,
  LiveTunerPatch,
  LiveTunerState,
  TireCompound,
  TyreSetup,
} from '@/types/f1';
import type { VehicleWheelState } from './vehicle-types';
import type { GamepadAssistSettings } from './gamepad-assist';
import type { BrakingGuide } from './speed-profile';

/** Per-wheel state used by the skid marks / smoke, multiplayer and AI peers. Order FR, FL, RR, RL. */
export type SimulatorWheel = Pick<VehicleWheelState, 'worldPos' | 'zRoad' | 'fzN' | 'combinedSlipNorm' | 'surfaceType' | 'spinVel'>;

/** Per-corner tyre state for the GPU tyre deformation (order FR, FL, RR, RL). Updated in place each step. */
export interface TyreVisualState {
  /** Loaded radius R_unloaded − δ (m) */
  loadedRadiusM: number;
  /** Radial deflection δ = Fz / radial rate (m) */
  verticalDeflectionM: number;
  /** Lateral tyre force in the wheel frame (N, + left) */
  lateralForceN: number;
  /** Camber leaning toward +left relative to the road (rad) */
  camberRad: number;
}

export interface SimulatorCar {
  readonly telemetry: CarTelemetry;
  /** Ground-level origin of the car model and its orientation (model axes: +X left, +Y up, +Z forward) */
  readonly worldPosition: THREE.Vector3;
  readonly worldQuaternion: THREE.Quaternion;
  readonly wheels: readonly [SimulatorWheel, SimulatorWheel, SimulatorWheel, SimulatorWheel];
  /** Optional visual tyre state per corner (FR, FL, RR, RL) for the GPU tyre deformation */
  readonly tyreVisuals?: readonly [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState];
  readonly wheelbaseM: number;
  readonly maxSteerAngleRad: number;
  /** Mass (kg) and yaw inertia (kg·m²) for car-to-car contact (absent: an F1 car's) */
  readonly contactMassKg?: number;
  readonly contactYawInertiaKgM2?: number;
  /** The car's own braking guidance for the braking line (absent / null: the circuit's VF26 profile) */
  readonly brakingGuide?: BrakingGuide | null;

  /** Track distance (m) and signed offset from the centreline (m, + right); writable to move the car */
  sMeters: number;
  lateralOffsetM: number;
  /** Body longitudinal velocity (m/s); writable */
  vxMs: number;
  /** Body lateral velocity (m/s, + left) */
  readonly vyMs: number;
  /** Yaw rate (rad/s, + = turning right) */
  readonly yawRateRadS: number;
  /** Steering −1..1, + = right */
  readonly steerAngleNorm: number;
  /** Extra chassis pitch / roll / heave applied to the rig on top of `worldQuaternion` */
  readonly pitchRad: number;
  readonly rollRad: number;
  readonly rideHeightOffsetM: number;
  readonly wheelRotationRad: number;
  readonly ersEnergyJ: number;

  /** Identifier of this vehicle model (derived from the car's profile) */
  readonly vehicleId?: import('@/types/f1').VehicleModelId;
  /** Racing line family used by this car ('f1' | 'gt3') */
  readonly racingLineId?: 'f1' | 'gt3';
  aiAutopilot: boolean;
  /** Fraction of the car's limit speed the autopilot runs at */
  aiPaceScale?: number;
  /** Traffic lateral offset bias from the racing line (m) */
  aiLineBiasM?: number;
  /** Traffic speed cap (m/s) */
  aiSpeedCapMs?: number;
  aeroPreset: AeroSetupPreset;
  assistPreset: DriverAssistPreset;
  gamepadAssistEnabled: boolean;
  /** Controller steering assist; its settings follow the player's sensitivity choice */
  readonly gamepadAssist: { settings: GamepadAssistSettings };
  autoXMode: boolean;
  activeAeroMode: ActiveAeroMode;
  tireCompound: TireCompound;

  /** Advance by a render frame */
  step(dtSeconds: number, inputs: Partial<ControlInputs>): unknown;
  resetToStartGrid(flyingStart?: boolean, gridSlot?: number): void;
  teleportToDistance(sMeters: number, speedMs?: number, lateral?: number): void;
  teleportToTurn(turnNumber: number): void;
  /**
   * Flashback: put the car back at a recorded pose (world x, z and heading, + yaw = atan2(forward.x, forward.z)),
   * on the ground and rolling at `speedMs`, keeping the tyres' heat and wear. `s` is a hint for the track projection.
   */
  restorePose?(pose: { x: number; z: number; yawRad: number; speedMs: number; s?: number }): void;
  getTyreSetup(): TyreSetup;
  setTyreSetup(setup: TyreSetup): void;
  activateBoostOverride(): boolean;
  /** Instantiate an AI opponent car of the exact same vehicle model & profile */
  createAiPeerCar?(): SimulatorCar;
  /** Attach loaded 3D track collider root */
  attachTrackRoot?(root: THREE.Object3D): void;
  /** Track limits: 'strict' (any excursion deletes the lap) or 'judged' by race control (`TrackLimitsMonitor`) */
  trackLimitsMode?: 'strict' | 'judged';
  /** Judged mode: an excursion is being judged; a lap completed meanwhile does not count */
  trackLimitsHold?: boolean;
  /** Race control deleted the running lap */
  invalidateLap?(): void;
  /** Garage chassis setup (wing trim, ride height, springs, bars, dampers) as offsets from the car's baseline */
  getChassisSetup?(): ChassisSetup;
  applyChassisSetup?(setup: ChassisSetup): void;
  /** Read or update the live in-race MFD tuner state */
  getLiveTunerState?(): LiveTunerState;
  setLiveTuner?(patch: LiveTunerPatch): void;

  /** Apply trailing vortex wake / slipstream deficit from cars ahead */
  setAeroWakeState?(wake: import('./aero-wake').AeroWakeState): void;
  /** Apply the dynamic track evolution sample under the car */
  setTrackEvolutionSample?(sample: import('./track-evolution').TrackEvolutionSample): void;
  /**
   * Apply a car-to-car contact resolved by `resolveCarToCarObbCollision` (Three.js world, Y up), as deltas:
   * `posDeltaX/Z` move the car (m), `velDeltaX/Z` change its world horizontal velocity (m/s) and `yawRateDeltaRadS`
   * its yaw rate about +Y (rad/s, + = counter-clockwise from above, i.e. turning left; note `yawRateRadS` is + right).
   * The caller clamps the deltas per frame.
   */
  applyRigidBodyCollision?(
    posDeltaX: number,
    posDeltaZ: number,
    velDeltaX: number,
    velDeltaZ: number,
    yawRateDeltaRadS: number
  ): void;
}

/** A flying lap's run-up is this long where the final straight allows it (m) */
const FLYING_RUN_UP_M = 450;
/** Slower than this (the circuit's speed profile, km/h) a stretch counts as the last corner, not the straight */
const FLYING_CORNER_KMH = 200;

/** Acceleration a flying start assumes out of the last corner (m/s²) */
const FLYING_EXIT_ACCEL = 0.5 * 9.81;

/**
 * Where a flying lap starts (`s`, m along the lap): 450 m before the line, or 20 m past the exit of the last
 * corner (`cornerS`: the last point of the speed profile under 200 km/h) where the final straight is shorter
 * (Shanghai, Suzuka), so no car is dropped into a corner with no yaw rate. Never closer than 40 m to
 * the line. `cornerS` is null on a full-length run-up.
 */
export function flyingStartPoint(track: {
  totalLengthM: number;
  getSampleAtDistance(s: number): { optimalSpeedKmh: number };
}): { s: number; cornerS: number | null } {
  const L = track.totalLengthM;
  let straight = 0;
  for (let d = 5; d <= FLYING_RUN_UP_M; d += 5) {
    if (track.getSampleAtDistance(L - d).optimalSpeedKmh < FLYING_CORNER_KMH) break;
    straight = d;
  }
  if (straight >= FLYING_RUN_UP_M) return { s: L - FLYING_RUN_UP_M, cornerS: null };
  return { s: L - Math.max(40, straight - 20), cornerS: L - straight - 5 };
}

/** Speed (m/s) a car leaving the last corner at `exitMs` carries `distanceM` further on */
export function flyingExitSpeedMs(exitMs: number, distanceM: number): number {
  return Math.sqrt(exitMs * exitMs + 2 * FLYING_EXIT_ACCEL * Math.max(0, distanceM));
}
