/**
 * What the simulator, the AI field and the renderer need from the player's car. Implemented by the LC26
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
  TrackSamplePoint,
  TyreSetup,
} from '@/types/f1';
import type { VehicleWheelState } from './vehicle-types';
import {
  createGroundHit,
  WALL_SEGMENT_STRIDE,
  type GroundHit,
  type GroundQuery,
  type TrackSurfaceKind,
  type WallQuery,
} from './f12026-car/TrackColliderQuery';
import type { SteeringAssistSettings, SteeringSource } from './steering-assist';
import type { BrakingGuide } from './speed-profile';
import type { ContactBox } from './contact-box';

/** Per-wheel state used by the skid marks / smoke, multiplayer and AI peers. Order FR, FL, RR, RL. */
export type SimulatorWheel = Pick<
  VehicleWheelState,
  'worldPos' | 'zRoad' | 'fzN' | 'combinedSlipNorm' | 'slideSpeedMs' | 'lockShare' | 'surfaceType' | 'spinVel'
>;

/** Per-corner tyre state for the GPU tyre deformation (order FR, FL, RR, RL). Updated in place each step. */
export interface TyreVisualState {
  /** Loaded radius R_unloaded − δ (m) */
  loadedRadiusM: number;
  /** Radial deflection δ = Fz / radial rate (m) */
  verticalDeflectionM: number;
  /** Lateral tyre force in the wheel frame (N, + left) */
  lateralForceN: number;
  /**
   * Camber leaning toward +left relative to the road (rad). Not drawn: the drawn tyre's camber is its wheel model's
   * own orientation against the road (`corner-rig.ts`)
   */
  camberRad: number;
  /**
   * Carcass deflection of the relaxation-length tyre model (m, wheel frame), in its own sign convention: x + while the
   * tyre drives (rim faster than the road, Fx +), y + while the contact slides toward +left (Fy −, so the tread is
   * pulled toward −left). Only the elastic part: past the grip peak (normalised combined slip > 1) the states are
   * scaled back to the peak's, the rest being sliding. Absent (a replayed or remote car): the renderer falls back to
   * `lateralForceN` for the lateral shear and draws no wind-up.
   */
  carcassDeflectionXM?: number;
  carcassDeflectionYM?: number;
  /**
   * Bottom of the tyre in the car frame (`worldPosition` / `worldQuaternion`, m): the road under a tyre `onRoad`, the
   * hub less the unloaded radius for a tyre off the ground. On the rigid-body model the car frame rides on the sprung
   * body, so the rigs put the unsprung wheels here rather than carrying them with the body's heave, pitch and roll;
   * a tyre on the road is then seated on the car's ground under the model's own corner (`seatCorner`). Absent: the
   * car frame's origin plane is the road under the wheels.
   */
  contactInCar?: { x: number; y: number; z: number };
  /**
   * The tyre stands on the road: its contact is the road under it, and the rigs seat it on the car's ground under
   * the model's own corner (`seatCorner`). False for a rigid-body tyre off the ground, which hangs at `contactInCar`.
   * The LC26 draws no wheel travel (its body moves on the rig, its wheels stay on the road), so its tyres always do.
   */
  onRoad: boolean;
}

export interface SimulatorCar {
  readonly telemetry: CarTelemetry;
  /** Ground-level origin of the car model and its orientation (model axes: +X left, +Y up, +Z forward) */
  readonly worldPosition: THREE.Vector3;
  readonly worldQuaternion: THREE.Quaternion;
  /** True 3D world-space linear velocity (m/s) at the car origin, including vertical velocity on slopes */
  readonly worldVelocity?: THREE.Vector3;
  /** Fixed-step models: simulated time not yet stepped this frame (s); the pose is drawn carried forward by it */
  readonly renderLeadS?: number;
  readonly wheels: readonly [SimulatorWheel, SimulatorWheel, SimulatorWheel, SimulatorWheel];
  /** Optional visual tyre state per corner (FR, FL, RR, RL) for the GPU tyre deformation */
  readonly tyreVisuals?: readonly [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState];
  /**
   * The track collider the car drives on, for reading only (the rigs seat the drawn wheels on it, `seatCorner`);
   * null / absent while the car is on the track samples' ground
   */
  readonly groundQuery?: GroundQuery | null;
  readonly wheelbaseM: number;
  /** Static height of the centre of gravity above the ground (m) */
  readonly cgHeightM: number;
  readonly maxSteerAngleRad: number;
  /** Mass (kg) and yaw inertia (kg·m²) for car-to-car contact (absent: an F1 car's) */
  readonly contactMassKg?: number;
  readonly contactYawInertiaKgM2?: number;
  /** The car's box for car-to-car contact, round its body's outline (absent: `DEFAULT_CONTACT_BOX`, an F1 car's) */
  readonly contactBox?: ContactBox;
  /** The car's own braking guidance for the braking line (absent / null: the circuit's LC26 profile) */
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
  readonly racingLineId?: import('@/types/f1').RacingLineId;
  aiAutopilot: boolean;
  /** Fraction of the car's limit speed the autopilot runs at */
  aiPaceScale?: number;
  /** A car that plans its autopilot speeds on its tyres' grip on this road (0.05 steps); the weather pace then leaves it be */
  aiPlanGrip?(): number;
  /** Traffic lateral offset bias from the racing line (m) */
  aiLineBiasM?: number;
  /** Traffic speed cap (m/s) */
  aiSpeedCapMs?: number;
  /**
   * A plan's level-ground top speed is no limit to this car: in a tow it runs past it, held by its own drag (the race
   * field sets it unless the driver is told to lift, under a yellow or a blue flag)
   */
  aiTopSpeedOpen?: boolean;
  /** AI tuning: target speed along the lap replacing the autopilot's own limit profile (m/s, uniform spacing) */
  aiTargetSpeedMs?: Float64Array | null;
  /** A plan for the autopilot to track as given (`ai/drive-plan.ts`); null: its own line and limit profile */
  aiPlan?: import('./ai/drive-plan').AiDrivePlan | null;
  /** AI tuning: steering gain multiplier of the autopilot */
  aiSteerGain?: number;
  /** The autopilot's own limit speed along the lap (m/s, uniform spacing), which AI tuning scales */
  aiBaseSpeedProfile?(): ArrayLike<number>;
  aeroPreset: AeroSetupPreset;
  assistPreset: DriverAssistPreset;
  /** The controller's stick goes through the steering assist (off = raw stick to the rack); the keyboard always does */
  gamepadAssistEnabled: boolean;
  /** Automatic gear changes; off = the driver shifts with Gear up / Gear down (AI cars keep it on) */
  autoGearbox: boolean;
  /** Automatic clutch & anti-stall (default true); false with manual gears enables bite point, clutch slip and stalls */
  autoClutch: boolean;
  /** Keyboard and controller steering assist (its settings follow the player's tuning) and what steered last */
  readonly steeringAssist: { settings: SteeringAssistSettings; readonly source: SteeringSource | null };
  autoXMode: boolean;
  /** A 2026 F1 car uses the Overtake earned in a race by itself (the player's Automatic Overtake) */
  autoOvertake?: boolean;
  activeAeroMode: ActiveAeroMode;
  tireCompound: TireCompound;

  /** Advance by a render frame */
  step(dtSeconds: number, inputs: Partial<ControlInputs>): unknown;
  /**
   * `fieldSize`: a race's rolling start, every car of the field at one speed (`rollingStartSpeedMs`). `raceStart`: a
   * race's grid, after its formation lap (warm tyres and brakes), not a car out of the garage
   */
  resetToStartGrid(flyingStart?: boolean, gridSlot?: number, fieldSize?: number, raceStart?: boolean): void;
  teleportToDistance(sMeters: number, speedMs?: number, lateral?: number): void;
  teleportToTurn(turnNumber: number): void;
  /**
   * Puts the car back at a recorded pose (world x, z and heading, + yaw = atan2(forward.x, forward.z)),
   * on the ground and rolling at `speedMs`, keeping the tyres' heat and wear. `s` is a hint for the track projection.
   */
  /** `pitLane`: the car is put back in the pit lane (a flashback to a moment in it, a handover from the sim worker) */
  restorePose?(pose: { x: number; z: number; yawRad: number; speedMs: number; s?: number; lapCount?: number; outLap?: boolean; pitLane?: boolean }): void;
  /** The AI field drives the car down the pit lane on its own path, no forces (pit/pit-lane.ts) */
  driveInPitLane?(x: number, z: number, yawRad: number, speedMs: number, laneM: number, offsetM: number): void;
  /** Out of the pit lane, back on the road rolling at `speedMs`: the physics drive the car again */
  leavePitLane?(x: number, z: number, yawRad: number, speedMs: number): void;
  /** The field stops driving the car down the lane and places it itself (a restart, a flashback) */
  endPitDrive?(): void;
  getTyreSetup(): TyreSetup;
  setTyreSetup(setup: TyreSetup): void;
  activateBoostOverride(): boolean;
  /** Race control for the overtaking aids (the 1 s and lap rules, `overtaking-rules.ts`); null = practice, free use */
  raceControl?: import('./overtaking-rules').OvertakingRaceControl | null;
  /** The car's overtaking aids (absent: none, e.g. a GT3) */
  readonly overtakingRules?: import('./overtaking-rules').OvertakingRules;
  /** Set the overtaking aids of the car's era (a 2026-model car standing in for an older one) */
  setOvertakingRules?(rules: import('./overtaking-rules').OvertakingRules): void;
  /** Instantiate an AI opponent car of the exact same vehicle model & profile */
  createAiPeerCar?(): SimulatorCar;
  /** Attach loaded 3D track collider root */
  attachTrackRoot?(root: THREE.Object3D): void;
  /** Track limits: 'strict' (any excursion deletes the lap) or 'judged' by race control (`TrackLimitsMonitor`) */
  trackLimitsMode?: 'strict' | 'judged';
  /** Judged mode: an excursion is being judged; a lap completed meanwhile does not count */
  trackLimitsHold?: boolean;
  /** A manual start's lights: the car held on the grid, its engine live (`race-start.ts`) */
  gridHold?: boolean;
  /** Rolling-start formation speed limiter (m/s): clamps driver speed smoothly until green flag; undefined = off */
  speedLimiterMs?: number;
  /** Race control deleted the running lap */
  invalidateLap?(): void;
  /** Garage chassis setup (wing trim, ride height, springs, bars, dampers) as offsets from the car's baseline */
  getChassisSetup?(): ChassisSetup;
  applyChassisSetup?(setup: ChassisSetup): void;
  /** Read or update the live in-race MFD tuner state */
  getLiveTunerState?(): LiveTunerState;
  setLiveTuner?(patch: LiveTunerPatch): void;

  /** Apply the car's damage (`car-damage.ts`): aero, per-wheel grip and toe, engine; null = undamaged */
  setDamageEffects?(effects: Readonly<import('./car-damage').CarDamageEffects> | null): void;
  /** The car puts itself back on the line when stuck on autopilot (default true; a race field rejoins its own cars) */
  aiSelfRecovery?: boolean;
  /** An AI driver's kickdown on top of the auto box (the race field's own cars only; default false) */
  aiKickdown?: boolean;
  /** Apply trailing vortex wake / slipstream deficit from cars ahead */
  setAeroWakeState?(wake: import('./aero-wake').AeroWakeState): void;
  /** Apply the dynamic track evolution sample under the car */
  setTrackEvolutionSample?(sample: import('./track-evolution').TrackEvolutionSample): void;
  /** Apply the weather under the car: water on the road, air temperature (`weather.ts`) */
  setWeatherSample?(sample: import('./weather').WeatherContactSample): void;
  /** Simulation realism level's switches (tyre wear, temperature grip, fuel use, wet severity) */
  setSimRealism?(flags: import('./sim-realism').SimRealismFlags): void;
  /** A time trial is driven (true) or practice (false): a 2026 F1 car's energy allowances (qualifying's or practice's) */
  setEnergySession?(timeTrial: boolean): void;
  /** An AI car that fits the tyres the weather calls for (`TrackEnvironment` swaps them) */
  aiAutoTyres?: boolean;
  /** AI driver skill level (0..100, default 70 = Pro); informs autopilot exit throttle, TC/ABS dials and ERS strategy */
  aiSkill?: number;
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
/** Slower than this (the circuit's speed profile, km/h) a stretch on a fast straight counts as the last corner */
const FLYING_CORNER_KMH = 200;
/** Curvature past this (1/m; R ≈ 222 m) ends the final straight even when speed stays above 200 km/h (e.g. Riverside T9) */
const FLYING_STRAIGHT_MAX_CURV = 0.0045;
/** Lateral acceleration cap (g) when a flying start itself must sit inside a corner near S/F (no yaw rate at spawn) */
const FLYING_CORNER_LAT_G = 0.75;

/** Acceleration a flying start assumes out of the last corner (m/s²) */
const FLYING_EXIT_ACCEL = 0.5 * 9.81;

/**
 * Where a flying lap starts (`s`, m along the lap): 450 m before the line, or 20 m past the exit of the last
 * corner (`cornerS`) where the final straight is shorter. Detects the last corner by both speed (< 200 km/h on fast
 * straights) and curvature (> `FLYING_STRAIGHT_MAX_CURV`, catching fast sweepers like Riverside T9 and Watkins Glen
 * Short as well as slow-exit straights like Le Mans 1982's Ford Chicane where S/F itself is under 200 km/h).
 * Guarantees `cornerS` never lies ahead of `s` (which previously wrapped `s - cornerS` around the full lap and
 * launched cars at 270 km/h out of slow chicanes). `cornerS` is null on a full-length run-up.
 */
export function flyingStartPoint(track: {
  totalLengthM: number;
  getSampleAtDistance(s: number): { optimalSpeedKmh: number; curvature?: number };
}): { s: number; cornerS: number | null } {
  const L = track.totalLengthM;
  const sfSpeedKmh = track.getSampleAtDistance(L - 5).optimalSpeedKmh;
  const fastStraight = sfSpeedKmh >= FLYING_CORNER_KMH;
  let straight = 0;
  let prevSpeed = sfSpeedKmh;
  for (let d = 5; d <= FLYING_RUN_UP_M; d += 5) {
    const smp = track.getSampleAtDistance(L - d);
    if (Math.abs(smp.curvature ?? 0) > FLYING_STRAIGHT_MAX_CURV) break;
    if (fastStraight) {
      if (smp.optimalSpeedKmh < FLYING_CORNER_KMH) break;
    } else if (smp.optimalSpeedKmh > prevSpeed + 1) {
      // Walked back past the last corner exit into an upstream braking zone
      break;
    }
    prevSpeed = smp.optimalSpeedKmh;
    straight = d;
  }
  if (straight >= FLYING_RUN_UP_M) return { s: L - FLYING_RUN_UP_M, cornerS: null };
  if (straight >= 25) {
    const runUp = Math.max(Math.min(40, straight - 5), straight - 20);
    return { s: L - runUp, cornerS: L - straight - 5 };
  }
  // S/F itself lies inside or immediately after a tight corner (e.g. Spielberg Inner, Dunsfold, VIR Patriot):
  // pick the straightest point 15..40 m before the line instead of pushing deeper into a hairpin, and anchor
  // `cornerS` at `s` so exit speed never wraps around the whole lap.
  let bestD = 20;
  let bestCurv = Infinity;
  for (let d = 15; d <= 40; d += 5) {
    const c = Math.abs(track.getSampleAtDistance(L - d).curvature ?? 0);
    if (c < bestCurv - 1e-4) {
      bestCurv = c;
      bestD = d;
    }
  }
  return { s: L - bestD, cornerS: L - bestD };
}

/** Speed (m/s) a car leaving the last corner at `exitMs` carries `distanceM` further on */
export function flyingExitSpeedMs(exitMs: number, distanceM: number): number {
  return Math.sqrt(exitMs * exitMs + 2 * FLYING_EXIT_ACCEL * Math.max(0, distanceM));
}

/**
 * Solo flying-start speed (m/s) at `s`: capped by `spotSpeedMs(s)`, 90 % of the track's optimal speed at `s`,
 * the exit speed carried from `start.cornerS` (using signed distance so it never wraps around the lap), and
 * a lateral-g ceiling when the spawn stretch itself curves tighter than `FLYING_STRAIGHT_MAX_CURV`.
 */
export function flyingStartSpeedMs(
  track: {
    totalLengthM: number;
    getSampleAtDistance(s: number): { optimalSpeedKmh: number; curvature: number };
  },
  start: { s: number; cornerS: number | null },
  s: number,
  spotSpeedMs: (at: number) => number,
  cornerExitMs: number
): number {
  const L = track.totalLengthM;
  const sample = track.getSampleAtDistance(s);
  let speed = Math.min(spotSpeedMs(s), (0.9 * sample.optimalSpeedKmh) / 3.6);
  if (start.cornerS !== null) {
    const d = ((((s - start.cornerS + L / 2) % L) + L) % L) - L / 2;
    speed = Math.min(speed, flyingExitSpeedMs(cornerExitMs, d));
  }
  let maxCurv = Math.abs(sample.curvature);
  for (let d = 5; d <= 25; d += 5) {
    maxCurv = Math.max(maxCurv, Math.abs(track.getSampleAtDistance(s + d).curvature));
  }
  if (maxCurv > FLYING_STRAIGHT_MAX_CURV) {
    speed = Math.min(speed, Math.sqrt((FLYING_CORNER_LAT_G * 9.81) / maxCurv));
  }
  return speed;
}

/**
 * A solo flying lap's start as the boards' lap times were set on it: where it begins and how fast, as before the rework
 * above. Where, how fast or which way a timed lap begins moves the boards' times, so a solo flying lap keeps this start,
 * checked as it was (`startPose` with no barriers, over `START_HANDS_OFF_S` of travel), until the boards are reset for
 * another reason; the rework (`flyingStartPoint` with `flyingStartSpeedMs`, the barrier clearance and
 * `startHandsOffRunM`) waits for that reset, and a race's rolling start already starts from `flyingStartPoint`. Known:
 * it hands a car the circuit car's (the LC26's) speed, up to 270 km/h on a full 450 m run-up even out of a slow corner
 * (Chang, Le Mans 1982) and ~188 km/h after a short one, more than a slower car earns there; fair between players, as
 * every player of a car and circuit gets the same start. On a few layouts it starts the car into a wall or off the road
 * (Spielberg Inner, VIR Patriot and its reverse, Watkins Glen short, Riverside), which the rework fixes.
 *
 * 450 m before the line, or 20 m past the exit of the last corner (`cornerS`: the last point of the speed profile under
 * 200 km/h) where the final straight is shorter, never closer than 40 m to the line; `cornerS` is null on a full run-up.
 */
export function boardFlyingStartPoint(track: {
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

/**
 * A solo flying lap's speed at `s` (m/s), as the boards' laps were set on it (`boardFlyingStartPoint`): the spot's
 * speed, and no more than the car carries from the last corner's exit (distance counted forward round the lap)
 */
export function boardFlyingStartSpeedMs(
  lapLengthM: number,
  start: { s: number; cornerS: number | null },
  s: number,
  spotSpeedMs: (at: number) => number,
  cornerExitMs: number
): number {
  const speed = spotSpeedMs(s);
  if (start.cornerS === null) return speed;
  const d = (((s - start.cornerS) % lapLengthM) + lapLengthM) % lapLengthM;
  return Math.min(speed, flyingExitSpeedMs(cornerExitMs, d));
}

/**
 * A car put down at speed for a flying lap has no yaw rate and its wheel straight, so it runs straight on until its
 * driver reacts: for this long (s) its tyres must stay on the asphalt with no help (`startPose`)
 */
export const START_HANDS_OFF_S = 1;
/** Peak longitudinal acceleration (m/s²) allowed for when computing the distance covered during `START_HANDS_OFF_S` */
const START_HANDS_OFF_ACCEL_MS2 = 9.81;

/** Distance (m) a car starting at `speedMs` covers during `START_HANDS_OFF_S` under full throttle */
export function startHandsOffRunM(speedMs: number): number {
  return speedMs * START_HANDS_OFF_S + 0.5 * START_HANDS_OFF_ACCEL_MS2 * START_HANDS_OFF_S * START_HANDS_OFF_S;
}
/** What those tyres may run on: the road and its kerbs, not run-off, gravel, grass, sausage kerbs or the pit lane */
const START_SURFACES: ReadonlySet<TrackSurfaceKind> = new Set(['road', 'kerb']);
/** Spacing of the checks along that run (m) */
const START_RUN_STEP_M = 2;
/** Spacing of the spots `startPose` tries across the road (m) */
const START_LATERAL_STEP_M = 0.25;
/**
 * Furthest `startPose` turns a car off the road's heading (rad) or moves it off its line (m) to keep its tyres on.
 * A start that needs more is in a corner (VIR Patriot's: 100 m radius at 185 km/h, where only a car turned 24° and
 * moved 7 m across the road kept them on for a second), and stays on its line along the road
 */
const START_MAX_TURN_RAD = (10 * Math.PI) / 180;
const START_MAX_SHIFT_M = 2;
/** Minimum clearance (m) from any barrier collider to the car's footprint during the hands-off run */
const START_WALL_MARGIN_M = 0.5;
const START_WALL_Y_SLACK_M = 1.5;
const _startWallIds = new Int32Array(256);

/** A car's tyres for `startPose`: their outer edges either side of its centre, its axles ahead of and behind it (m) */
export interface StartFootprint {
  halfWidthM: number;
  frontM: number;
  rearM: number;
}

/** Where a car starts: world x / z, heading (rad, `atan2` of its forward x and z) and its offset right of the centreline (m) */
export interface StartPose {
  x: number;
  z: number;
  yawRad: number;
  lateral: number;
}

interface StartTrack {
  getSampleAtDistance(s: number): Pick<TrackSamplePoint, 'position' | 'tangent' | 'binormal'>;
}

/** The point `lateral` m right of the centreline at `s`, across the road as a car is placed (`binormal` flattened) */
function pointAcross(track: StartTrack, s: number, lateral: number): [number, number] {
  const smp = track.getSampleAtDistance(s);
  const b = smp.binormal;
  const bl = Math.hypot(b.x, b.z) || 1;
  return [smp.position.x + (b.x / bl) * lateral, smp.position.z + (b.z / bl) * lateral];
}

function pointToSegDistSq2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  const ex = px - (ax + t * dx);
  const ez = pz - (az + t * dz);
  return ex * ex + ez * ez;
}

/** True when the car footprint centred at (cx, cy, cz) heading (fx, fz) keeps at least `marginM` clear of every barrier */
function wallClearAt(
  walls: WallQuery,
  cx: number,
  cy: number,
  cz: number,
  fx: number,
  fz: number,
  fp: StartFootprint,
  marginM: number
): boolean {
  const radius = Math.hypot(Math.max(fp.frontM, fp.rearM), fp.halfWidthM) + marginM + 0.5;
  const n = walls.near(cx, cz, radius, _startWallIds);
  if (n === 0) return true;
  const segs = walls.segments;
  const marginSq = marginM * marginM;
  for (let k = 0; k < n; k++) {
    const o = _startWallIds[k] * WALL_SEGMENT_STRIDE;
    if (cy < segs[o + 4] - START_WALL_Y_SLACK_M || cy > segs[o + 5] + START_WALL_Y_SLACK_M) continue;
    const ax = segs[o];
    const az = segs[o + 1];
    const bx = segs[o + 2];
    const bz = segs[o + 3];
    if (pointToSegDistSq2D(cx, cz, ax, az, bx, bz) < marginSq) return false;
    for (const along of [fp.frontM, 0, -fp.rearM]) {
      for (const across of [-fp.halfWidthM, fp.halfWidthM]) {
        const px = cx + fx * along - fz * across;
        const pz = cz + fz * along + fx * across;
        if (pointToSegDistSq2D(px, pz, ax, az, bx, bz) < marginSq) return false;
      }
    }
  }
  return true;
}

/**
 * How far (m, up to `runM`) a car at (x, z), `s` along the lap, heading `yawRad`, runs straight on before a tyre's
 * outer edge leaves the asphalt (`START_SURFACES`) or its footprint comes within `START_WALL_MARGIN_M` of a barrier,
 * read off the circuit's colliders every `START_RUN_STEP_M`
 */
function straightRunOnAsphaltM(
  track: StartTrack,
  ground: GroundQuery | null,
  walls: WallQuery | null,
  hit: GroundHit,
  s: number,
  pose: StartPose,
  fp: StartFootprint,
  runM: number
): number {
  const fx = Math.sin(pose.yawRad);
  const fz = Math.cos(pose.yawRad);
  let clean = 0;
  for (let d = 0; d <= runM + 1e-6; d += START_RUN_STEP_M) {
    const smpY = track.getSampleAtDistance(s + d).position.y;
    const cx = pose.x + fx * d;
    const cz = pose.z + fz * d;
    if (ground) {
      const probeY = smpY + 3;
      for (const along of [fp.frontM, -fp.rearM]) {
        for (const across of [-fp.halfWidthM, fp.halfWidthM]) {
          // (-fz, fx) is the car's right, as the binormal is the road's
          const x = cx + fx * along - fz * across;
          const z = cz + fz * along + fx * across;
          if (!ground.query(x, z, probeY, hit) || !START_SURFACES.has(hit.surface)) return clean;
        }
      }
    }
    if (walls && !wallClearAt(walls, cx, smpY + 0.5, cz, fx, fz, fp, START_WALL_MARGIN_M)) return clean;
    clean = Math.min(runM, d);
  }
  return runM;
}

/**
 * Where a car put down at `s` at speed for a flying lap starts, and which way it points (`START_HANDS_OFF_S`). On its
 * line (`lateral`) heading along the road wherever, from there, its tyres stay on the asphalt and clear of barriers
 * for `runM` (m) hands-off, as on a straight. Where they would not (a short final straight on the last corner's exit,
 * or a racing line hugging a pit wall), it aims at its line `runM` ahead (or the centreline if the line ahead crowds
 * a barrier), from `lateral` or the nearest spot within `lo`..`hi` that keeps them on and clear, turned no further
 * than `START_MAX_TURN_RAD` and moved no further than `START_MAX_SHIFT_M` (or toward the centreline if a barrier
 * blocks `alongRoad`). Failing a full clean run, it keeps the longest clear pose found when `alongRoad` hits a wall,
 * else stays on its line along the road.
 */
export function startPose(
  track: StartTrack,
  ground: GroundQuery | null,
  s: number,
  lateral: number,
  aimLateral: (s: number) => number,
  lo: number,
  hi: number,
  footprint: StartFootprint,
  runM: number,
  walls: WallQuery | null = null
): StartPose {
  const tangent = track.getSampleAtDistance(s).tangent;
  const [x0, z0] = pointAcross(track, s, lateral);
  const alongRoad: StartPose = { x: x0, z: z0, yawRad: Math.atan2(tangent.x, tangent.z), lateral };
  if ((!ground && !walls) || !(runM > 0)) return alongRoad;
  const hit = createGroundHit();
  const run = (pose: StartPose) => straightRunOnAsphaltM(track, ground, walls, hit, s, pose, footprint, runM);
  const alongClean = run(alongRoad);
  if (alongClean >= runM) return alongRoad;
  // The centreline is the fallback for a line ahead that crowds a barrier: with no barriers to keep clear of, the
  // search is the one a solo flying lap's start has always made (`boardFlyingStartPoint`), and the boards with it
  const aimTargets = walls ? [aimLateral(s + runM), 0] : [aimLateral(s + runM)];
  const toCentre = lateral > 0 ? -1 : 1;
  // Allow shifting all the way to the centreline when moving away from a close barrier, otherwise cap at START_MAX_SHIFT_M
  const maxShift = Math.max(START_MAX_SHIFT_M, walls ? Math.abs(lateral) : 0);
  let bestPose = alongRoad;
  let bestClean = alongClean;
  for (const targetLat of aimTargets) {
    const [ax, az] = pointAcross(track, s + runM, targetLat);
    for (let k = 0; k * START_LATERAL_STEP_M <= maxShift + 1e-9; k++) {
      const shift = k * START_LATERAL_STEP_M;
      for (const side of k === 0 ? [0] : [toCentre, -toCentre]) {
        if (shift > START_MAX_SHIFT_M + 1e-9 && side !== toCentre) continue;
        const lat = lateral + side * shift;
        if (k > 0 && (lat < lo || lat > hi)) continue;
        const [x, z] = pointAcross(track, s, lat);
        const pose: StartPose = { x, z, yawRad: Math.atan2(ax - x, az - z), lateral: lat };
        const turn = pose.yawRad - alongRoad.yawRad;
        if (Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn))) > START_MAX_TURN_RAD) continue;
        const clean = run(pose);
        if (clean >= runM) return pose;
        if (clean > bestClean + 0.5) {
          bestClean = clean;
          bestPose = pose;
        }
      }
    }
  }
  // Keep a strictly safer pose if `alongRoad` itself is blocked by a barrier
  const wallBlocked = walls !== null && straightRunOnAsphaltM(track, null, walls, hit, s, alongRoad, footprint, runM) < runM;
  return wallBlocked ? bestPose : alongRoad;
}

/** Gap between grid slots in a flying start's queue (m); the slots alternate sides */
export const FLYING_SLOT_SPACING_M = 28;

/** Tighter staggered spacing between slots in a rolling-start formation (m) */
export const ROLLING_SLOT_SPACING_M = 14;

/** Target formation speed for a rolling start (m/s): 65 km/h (Nuzzi-style rolling start) */
export const ROLLING_START_PACE_MS = 65 / 3.6;

/** Maximum lead distance before Start/Finish for pole in a rolling start (m): ~9 s formation approach at 65 km/h */
export const ROLLING_START_MAX_LEAD_M = 165;
/** No rolling-start slot where the road within 10 m curves tighter than this (1/m: a 33 m radius, a hairpin) */
const ROLLING_SLOT_MAX_CURVATURE = 0.03;
/** The most cornering a car placed with no yaw rate is asked for at the field's speed (g) */
const ROLLING_START_LAT_G = 1;

interface RollingStartTrack {
  totalLengthM: number;
  getSampleAtDistance(s: number): { optimalSpeedKmh: number; curvature: number };
}

/**
 * Where the first `count` grid slots of a race's rolling start line up (m along the lap): pole starts no further than
 * `ROLLING_START_MAX_LEAD_M` (~165 m, ~9 s at 65 km/h) before Start/Finish (or closer where the final straight is
 * shorter), with each subsequent slot `ROLLING_SLOT_SPACING_M` (14 m) behind on alternating sides, skipping hairpins
 * up to 120 m further back so no car is dropped onto an apex with no yaw rate.
 * The queue skips only within half a lap of the front: on a short, twisty layout it otherwise ran round onto itself.
 */
export function rollingStartSlots(track: RollingStartTrack, start: { s: number }, count: number): number[] {
  const L = track.totalLengthM;
  const wrap = (s: number) => ((s % L) + L) % L;
  const curved = (s: number) => {
    for (let d = -10; d <= 10; d += 5) if (Math.abs(track.getSampleAtDistance(wrap(s + d)).curvature) > ROLLING_SLOT_MAX_CURVATURE) return true;
    return false;
  };
  const distToLine = (((L - start.s) % L) + L) % L;
  const leadDist = Math.min(distToLine > 0 ? distToLine : ROLLING_START_MAX_LEAD_M, ROLLING_START_MAX_LEAD_M);
  const leadStartS = L - leadDist;
  const slots: number[] = [];
  let s = leadStartS;
  for (let slot = 0; slot < count; slot++) {
    if (slot > 0) {
      s -= ROLLING_SLOT_SPACING_M;
      for (let back = 0; back < 120 && leadStartS - s < L / 2 && curved(s); back += 5) s -= 5;
    }
    slots.push(wrap(s));
  }
  return slots;
}

/**
 * The one speed a whole field takes a rolling start at (m/s): the formation pace, or slower where any of its slots
 * (`rollingStartSlots`) would be. Each slot allows `spotSpeedMs` at its spot, 90 % of the lap's speed there (the
 * circuit's profile, which is still accelerating out of a corner where the car's grip limit alone would allow far
 * more), no more than 1 g of cornering and, in or after the last corner, no more than the car carries out of it
 * (`cornerExitMs` at `start.cornerS`). One speed for every car: each slot once took its own, the leader 188 km/h out
 * of the last corner and the cars 28 m behind it 270 km/h, and they braked into each other and spun
 */
export function rollingStartSpeedMs(
  track: RollingStartTrack,
  start: { s: number; cornerS: number | null },
  fieldSize: number,
  spotSpeedMs: (s: number) => number,
  cornerExitMs: number
): number {
  const L = track.totalLengthM;
  let speed = ROLLING_START_PACE_MS;
  for (const s of rollingStartSlots(track, start, fieldSize)) {
    const sample = track.getSampleAtDistance(s);
    speed = Math.min(speed, spotSpeedMs(s), (0.9 * sample.optimalSpeedKmh) / 3.6);
    speed = Math.min(speed, Math.sqrt((ROLLING_START_LAT_G * 9.81) / Math.max(1e-4, Math.abs(sample.curvature))));
    if (start.cornerS !== null) {
      // Signed: a slot before the corner's end is still in it (unsigned, it was a whole lap from leaving it)
      const d = ((((s - start.cornerS + L / 2) % L) + L) % L) - L / 2;
      speed = Math.min(speed, flyingExitSpeedMs(cornerExitMs, d));
    }
  }
  return speed;
}
