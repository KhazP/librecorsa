/**
 * What the simulator, the AI field and the renderer need from the player's car. Implemented by the VF26
 * model (`F1Physics2026`) and by the f12026-car adapter (`F12026CarSim`), so either can be driven.
 */
import type * as THREE from 'three';
import type {
  ActiveAeroMode,
  AeroSetupPreset,
  CarTelemetry,
  ControlInputs,
  DriverAssistPreset,
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

  aiAutopilot: boolean;
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
  teleportToTurn(turnNumber: number): void;
  getTyreSetup(): TyreSetup;
  setTyreSetup(setup: TyreSetup): void;
  activateBoostOverride(): boolean;
}
