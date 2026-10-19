import type * as THREE from "three";

export type RunoffStyle =
  | "main_straight"
  | "qatar_maroon"
  | "visit_rwanda_blue"
  | "hills_yellow_green"
  | "bugesera_cyan"
  | "rwandair_blue_yellow";

export type AeroSetupPreset = "low_downforce" | "balanced" | "high_downforce";

export type ActiveAeroMode = "Z_MODE" | "X_MODE";
export type AeroMode = "Z-MODE" | "X-MODE" | ActiveAeroMode;

export type ERSMode = "HARVEST" | "BALANCED" | "HOTLAP" | "OVERRIDE";

/** Three values across a tyre's tread (left, middle, right as seen from behind) */
export type Band3 = [number, number, number];

export type SurfaceType = "asphalt" | "kerb" | "runoff" | "grass";

export type AssistPreset = "pro" | "semi_pro" | "assisted";
export type DriverAssistPreset = AssistPreset;

export interface ControlInputs {
  throttle: number;
  brake: number;
  steerLeft: number;
  steerRight: number;
  analogSteer?: number; // Optional continuous [-1..1] mouse/wheel steer (+ = right), sent to the rack as is
  padSteer?: number; // Optional raw gamepad thumbstick [-1..1] (+ = right), run through the gamepad steering assist
  clutch?: number; // Optional manual clutch [0..1]
  manualOverride: boolean;
  toggleXMode: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
}

export type CameraMode =
  | "chase"
  | "tv_pod"
  | "cockpit_shoulder"
  | "cockpit"
  | "nose"
  | "helicopter"
  | "tv_side";

export type TireCompound = "soft" | "medium" | "hard";

export type LiveryId =
  | "rwanda_2026"
  | "scuderia_red"
  | "silver_arrow"
  | "papaya_apex"
  | "carbon_stealth";

export interface LiveryConfig {
  id: LiveryId;
  name: string;
  team: string;
  primary: string;
  secondary: string;
  accent: string;
  number: string;
}

export interface TrackControlPoint {
  x: number;
  y: number; // Elevation in meters (0m to +50m)
  z: number;
  bankingDeg: number; // Banking angle in degrees (up to 6 deg at T3 & T4-6)
  width: number; // Track width in meters (13m minimum, 15m main straight)
  sector: 1 | 2 | 3;
  turnNumber: number; // 0 for straight, 1..18 for turns
  turnName: string;
  runoffStyle: RunoffStyle;
  kerbLeft: boolean;
  kerbRight: boolean;
  drsZone: boolean;
  racingLineOffset: number; // -1 (left edge) to +1 (right edge)
}

export interface TrackSamplePoint {
  index: number;
  s: number; // Distance along track in meters
  t: number; // Normalized parameter 0..1
  position: THREE.Vector3;
  racingLinePos?: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3; // Right vector across track surface (including banking)
  bankingRad: number;
  width: number;
  curvature: number; // Signed horizontal curvature (1/m), positive = right turn
  verticalCurvature: number; // Signed vertical curvature (1/m)
  slopeSin: number; // Sin of longitudinal slope
  sector: 1 | 2 | 3;
  turnNumber: number;
  turnName: string;
  runoffStyle: RunoffStyle;
  kerbLeft: boolean;
  kerbRight: boolean;
  drsZone: boolean;
  /** Lap-time line of the F1 cars (VF26, f12026-car), normalised: see `aiLineOffsetM` */
  racingLineOffset: number;
  /** The GT3's own lap-time line, same scale (the F1 line where a track has none) */
  racingLineOffsetGt3?: number;
  optimalSpeedKmh: number; // Computed physics target speed at this point
  /** Highest speed here from which the car can still brake for every corner ahead (km/h) */
  brakeLimitKmh?: number;
  brakingZone: number; // 0 = throttle, 0.5 = lift/coast, 1 = heavy braking
  gripMultiplier?: number;
  yProf?: number[]; // 9-point lateral elevation profile across [-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12]m
  /** Painted run-off width beyond the asphalt edge, per side (m) */
  runoffLeftM?: number;
  runoffRightM?: number;
  /** Gravel-trap width beyond the painted run-off, per side (m) */
  gravelLeftM?: number;
  gravelRightM?: number;
  /** Barrier line, unsigned distance from the centreline per side (m) */
  wallLeftM?: number;
  wallRightM?: number;
}


export interface TurnMetadata {
  number: number;
  name: string;
  complexName: string;
  sector: 1 | 2 | 3;
  elevationM: number;
  bankingDeg: number;
  apexSpeedKmh: number;
  gear: number;
  description: string;
  sApprox: number; // Distance in meters from start/finish
  direction?: "left" | "right";
  radiusM?: number;
  angleDeg?: number;
}

/** One car on the proximity radar */
export interface RadarBlip {
  x: number;
  z: number;
  yaw: number;
  color: string;
}

export interface PeerTelemetrySummary {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  trackDistanceM: number;
  speedKmh: number;
  gapSeconds: number;
  isAiPeer: boolean;
}

export interface RaceStandingEntry {
  driverCode: string;
  teamColorHex: string;
  isPlayer: boolean;
  lap: number;
  /** Time behind the leader at the same race distance (s) */
  gapToLeaderS: number;
  /** Player name (multiplayer) */
  name?: string;
  /** Has taken the chequered flag */
  finished?: boolean;
  /** Time to the car directly ahead in the running order (s); absent for the leader */
  intervalS?: number;
  /** Fastest lap / last completed lap (ms) */
  bestLapMs?: number | null;
  lastLapMs?: number | null;
  /** Position on the lap (track arc-length, m) and race distance from the start line, laps included (m) */
  trackS?: number;
  raceDistM?: number;
  /** Tyre compound the car is running */
  compound?: TireCompound;
  /** Time penalties served at the flag (s) */
  penaltyS?: number;
}

/** One line of the final classification */
export interface RaceResultEntry {
  position: number;
  driverCode: string;
  name: string;
  teamColorHex: string;
  isPlayer: boolean;
  /** Race time at the flag (s); null when not (yet) finished */
  finishTimeS: number | null;
  /** Behind the winner (s); null for the winner and for cars still running */
  gapS: number | null;
  /** Laps behind the winner when lapped (0 otherwise) */
  lapsDown: number;
  lapsCompleted: number;
  bestLapMs: number | null;
  /** Still running when the classification closed */
  dnf: boolean;
  /** Time penalties added to the race time (s), already included in `finishTimeS` and `gapS` */
  penaltyS?: number;
  /** Track-limits warnings received (the player's own) */
  trackLimitWarnings?: number;
}

/** A race (AI opponents or multiplayer): start procedure, live order and the result */
export interface RaceStatus {
  /** 'finished': the player has taken the flag */
  phase: 'lights' | 'racing' | 'finished';
  /** Red start lights lit (0–5); 0 during the race */
  lightsOn: number;
  /** Seconds until the light sequence starts (multiplayer countdown); absent otherwise */
  countdownS?: number;
  /** Race length (laps) */
  totalLaps?: number;
  /** Final classification once the player has finished */
  results?: RaceResultEntry[];
  /** True once the classification no longer changes */
  resultsFinal?: boolean;
  /** Multiplayer race (results come from every player's own timing) */
  multiplayer?: boolean;
  /** Player's position (1 = leading) */
  position: number;
  fieldSize: number;
  lap: number;
  standings: RaceStandingEntry[];
}

/** Driver-set tyre setup (front / rear axle). Camber in degrees, negative = top of the tyre leaning inward. */
export interface TyreSetup {
  coldPressurePsi: { front: number; rear: number };
  camberDeg: { front: number; rear: number };
}

export interface CarTelemetry {
  speedKmh: number;
  speedMs: number;
  rpm: number;
  gear: number; // -1 = R, 0 = N, 1..8
  throttle: number; // 0..1
  brake: number; // 0..1
  clutch: number; // 0..1 (1 = engaged, 0 = disengaged)
  steering: number; // -1..1 (positive = right)
  longitudinalG: number;
  lateralG: number;
  verticalG: number;
  // 2026 Aerodynamics & Rwanda Altitude
  altitudeM: number; // ~1385m + track elevation (up to 1435m)
  trackElevationM: number; // 0m to 50m
  airDensityKgM3: number; // ~1.04 kg/m^3 at 1400m
  activeAeroMode: ActiveAeroMode; // Z_MODE (High DF) or X_MODE (Low Drag)
  autoXMode: boolean;
  downforceN: number;
  downforceKgf: number;
  frontDownforceN: number;
  rearDownforceN: number;
  groundEffectFactor: number;
  dragN: number;
  // 2026 Power Unit (~540 kW ICE + 350 kW MGU-K)
  icePowerKw: number;
  mgukPowerKw: number; // -350 (harvest) to +350 (deploy)
  totalPowerKw: number;
  ersBatteryPercent: number; // 0..100
  manualOverrideActive: boolean; // 2026 MOM 350kW boost
  boostRemainingS: number;
  turboBoostBar: number;
  fuelKg: number;
  // 4-Corner Tires, Suspension & Brakes (Ordered FL, FR, RL, RR for HUD display)
  tireSlipRatio: [number, number, number, number]; // FL, FR, RL, RR combined normalized slip (0..1.5)
  wheelSlipRatios: [number, number, number, number]; // FL, FR, RL, RR signed longitudinal slip ratio
  wheelSlipAnglesDeg: [number, number, number, number]; // FL, FR, RL, RR lateral slip angle (deg)
  wheelLoadsN: [number, number, number, number]; // FL, FR, RL, RR vertical contact load Fz (N)
  wheelRideHeightsMm: [number, number, number, number]; // FL, FR, RL, RR dynamic ride height (mm)
  suspensionTravelMm: [number, number, number, number]; // FL, FR, RL, RR suspension compression (mm)
  tireTempsC: [number, number, number, number]; // FL, FR, RL, RR (°C)
  tireWearPct: [number, number, number, number]; // FL, FR, RL, RR (0..100% wear)
  /** Tread surface temperatures across each tyre, left → right as seen from behind (°C) */
  tireBandTempsC?: [Band3, Band3, Band3, Band3];
  /** Hot inflation pressures (psi) */
  tirePressuresPsi?: [number, number, number, number];
  /** Circumferential flat-spot severity per corner (0..1) */
  tireFlatSpotSeverity?: [number, number, number, number];
  /** Surface graining level per corner (0..1) */
  tireGrainLevel?: [number, number, number, number];
  /** Internal blistering level per corner (0..1) */
  tireBlisterLevel?: [number, number, number, number];
  /** Off-track dirt / gravel / marble contamination per corner (0..1) */
  tireDirtyLevel?: [number, number, number, number];
  /** Aero centre of pressure as the front share of downforce (%) */
  aeroCopFrontPct?: number;
  /** Floor ground-effect stall factor: 1 = attached, down to 0.55 when the plank is within 4 mm of the road */
  floorStallFactor?: number;
  /** Slipstream drag multiplier (1.0 in clean air, < 1 in tow) */
  aeroWakeDragMult?: number;
  /** Dirty-air downforce multiplier (1.0 in clean air, < 1 in wake) */
  aeroWakeDownforceMult?: number;
  tireGripFactor: [number, number, number, number]; // FL, FR, RL, RR effective mu / nominal mu
  brakeTempsC: [number, number, number, number]; // FL, FR, RL, RR (°C)
  brakeCoreTempsC?: [number, number, number, number]; // FL, FR, RL, RR internal vane core (°C)
  brakePadMuFactor?: [number, number, number, number]; // FL, FR, RL, RR pad friction efficiency (0.55..1.0)
  wheelSurfaces: [SurfaceType, SurfaceType, SurfaceType, SurfaceType]; // FL, FR, RL, RR
  frontSlipAngleDeg?: number;
  rearSlipAngleDeg?: number;
  /**
   * [-1..1] torque on the steering wheel from the front tyres (aligning moment + caster trail + scrub radius + KPI + gyro),
   * + = turning the rim right: opposite to the steering in a normal corner, so it centres the wheel.
   */
  ffbTorqueNorm?: number;
  /** Sub-frame 500 Hz physical steering rack torque samples accumulated during the last frame */
  ffbSubframeSamples?: number[];
  ffbClipping?: boolean; // True when |ffbTorqueNorm| > 0.95
  onKerbLeft: boolean;
  onKerbRight: boolean;
  offTrack: boolean;
  surface: SurfaceType;
  // Track & Lap Timing
  trackDistanceM: number; // 0..5302
  trackProgress: number; // 0..1
  lateralOffsetM: number; // Distance from centerline (-width/2 to +width/2)
  gapToRacingLineM: number; // Signed offset from optimal racing line (m)
  headingErrorRad: number;
  targetCornerSpeedKmh: number;
  brakingUrgency: number; // 0..1 dynamic braking urgency for upcoming corner
  currentSector: 1 | 2 | 3;
  currentTurnNumber: number;
  currentTurnName: string;
  bankingDeg: number;
  slopePercent: number;
  lapCount: number;
  currentLapTimeMs: number;
  lastLapTimeMs: number | null;
  bestLapTimeMs: number | null;
  sectorTimesMs: [number, number, number];
  bestSectorTimesMs: [number | null, number | null, number | null];
  topSpeedThisLapKmh: number;
  allTimeTopSpeedKmh: number;
  aiAutopilot: boolean;
  peers?: PeerTelemetrySummary[];
  /** Cars within 30 m, in the player's frame: x metres to the right, z metres ahead, yaw relative to the player */
  radar?: RadarBlip[];
  /** Present while racing the AI opponents */
  race?: RaceStatus;
  /** Live engineering telemetry channels, present while driving the f12026-car or GT3 */
  f12026?: F12026Channels;
  /** Live in-race MFD tuner state (TC1/TC2, 4-ch ABS, Brake Bias/Migration, 3-Phase Diff, ERS/Engine Map) */
  liveTuner?: LiveTunerState;
  /** The physics' own verdict on the running lap (judged track limits): false once it has been cut */
  lapInvalid?: boolean;
  /** Verdict on the lap that was just completed (set together with `lapCount` / `lastLapTimeMs`) */
  lastLapValid?: boolean;
  /** Hot pressure at which each tyre grips best (psi) */
  tireOptimalPsi?: [number, number, number, number];
  /** The compound's working window of tread temperature (°C) */
  tireOptimalTempC?: [number, number];
  /** Track-limits judging: warnings, penalties and the excursion being judged */
  trackLimits?: TrackLimitsStatus;
}

/** Why an excursion counted against the driver */
export type TrackLimitsReason = "gained" | "corner_cut" | "not_lifted" | "illegal_overtake";

/** The race-control state of the track-limits judging (see `TrackLimitsMonitor`) */
export interface TrackLimitsStatus {
  /** Warnings in the current strike cycle (0..strikesPerPenalty − 1) and the cycle length */
  warnings: number;
  strikesPerPenalty: number;
  /** Every strike of the session / race */
  totalStrikes: number;
  /** Time penalties awarded (s) */
  penaltyS: number;
  /** An excursion in progress or being judged: what the driver must still give back */
  pending: {
    /** "off": still off the track; "judging": back on, settling; "give_back": must give the time / lift / position back */
    stage: "off" | "judging" | "give_back";
    /** Time gained over the reference lap through the excursion (s); null without a reference */
    gainS: number | null;
    /** Race position the driver must cede back to after an off-track overtake; null when no position was gained */
    giveBackPosition?: number | null;
    /** Give-back progress 0..1 and the time left to complete it (s) */
    progress: number;
    remainingS: number;
  } | null;
  /** The last race-control message, for the banner; `atMs` is the wall-clock time it was issued */
  message: {
    kind: "warning" | "penalty" | "cleared" | "lap_invalid" | "no_advantage";
    text: string;
    detail?: string;
    atMs: number;
  } | null;
}

export type DiffPhase = "ENTRY" | "MID" | "EXIT";

export interface LiveTunerState {
  /** Traction Control Stage 1: Slip threshold dial (0 = OFF, 1 = min intervention / max slip, 12 = max intervention / min slip) */
  tcLevel: number;
  /** Traction Control Stage 2: Torque cut depth / aggressiveness (1..12) */
  tc2Level: number;
  /** 4-Channel ABS dial (0 = OFF, 1 = min intervention, 12 = max stability) */
  absLevel: number;
  /** Front static brake balance (% front, e.g. 56.0 for F1, 61.0 for GT3) */
  brakeBiasPct: number;
  /** Dynamic forward brake migration at full pedal (% ramp, 0.0..5.0) */
  brakeMigrationPct: number;
  /** 3-Phase Electronic Differential Entry coast lock (1..12) */
  diffEntry: number;
  /** 3-Phase Electronic Differential Mid-corner apex lock (1..12) */
  diffMid: number;
  /** 3-Phase Electronic Differential Exit / High-Speed power lock (1..12) */
  diffExit: number;
  /** Active differential phase in real time */
  diffActivePhase: DiffPhase;
  /** Current LSD locking torque (Nm) */
  diffLockingTorqueNm: number;
  /** Engine / throttle torque map (1 = Quali/Max, 2 = Race, 3 = Smooth/Wet, 4 = Lean, 5 = Save) */
  engineMap: number;
  /** ERS deployment mode ('PSH' | 'RAC' | 'BAL' | 'LIC' | 'CHR') */
  ersMode: string;
  /** Whether the car has hybrid ERS */
  hasErs: boolean;
  /** Live TC throttle cut fraction (0 = no cut, 1 = full cut) */
  tcCutFraction: number;
  /** Live 4-wheel ABS pressure release fraction [FL, FR, RL, RR] (0 = no cut, 1 = full release) */
  absCutPerWheel: [number, number, number, number];
  /** Current MGU-K gear deployment ceiling fraction (0.333 in 1st, 0.666 in 2nd, 0.90 in 3rd, 1.0 in 4th+) */
  mgukGearClipFraction: number;
}

export type LiveTunerPatch = Partial<
  Pick<
    LiveTunerState,
    | "tcLevel"
    | "tc2Level"
    | "absLevel"
    | "brakeBiasPct"
    | "brakeMigrationPct"
    | "diffEntry"
    | "diffMid"
    | "diffExit"
    | "engineMap"
    | "ersMode"
  >
>;

/** Player car: the VF26 model (F1Physics2026), the 6-DOF f12026-car, or the Mercedes-AMG GT3 on the same vehicle model */
export type VehicleModelId = "vf26" | "f12026-car" | "amg-gt3";

/** Which lap-time racing line a car drives: the F1 cars share one, the GT3 has its own */
export type RacingLineId = "f1" | "gt3";

/**
 * f12026-car engineering telemetry channels. Wheel order LF, RF, LR, RR (= FL, FR, RL, RR).
 */
export interface F12026Channels {
  /** Longitudinal slip ratio (+ = traction) */
  WHEEL_SR_LF: number;
  WHEEL_SR_RF: number;
  WHEEL_SR_LR: number;
  WHEEL_SR_RR: number;
  /** Remaining travel to the bump rubber (m, negative = compressing the rubber) */
  BUMPSTOPUP_TRAVEL_LF: number;
  BUMPSTOPUP_TRAVEL_RF: number;
  BUMPSTOPUP_TRAVEL_LR: number;
  BUMPSTOPUP_TRAVEL_RR: number;
  /** Mean floor height over the ground at the axles (m) */
  AERO_HEIGHT: number;
  /** Front share of the downforce (%) */
  AERO_BALANCE: number;
  /** Differential locking torque (Nm) */
  LSD_LOCKING_TORQUE: number;
  /** DRS flap state as last reported by a `CHANGED_DRS_OPEN` event */
  CHANGED_DRS_OPEN: boolean;
  /** `CHANGED_DRS_OPEN` events since the car was placed */
  drsOpenEvents: number;
  /** Inside a DRS zone / armed by its detection point */
  drsZone: boolean;
  drsAvailable: boolean;
  /** Last detection point crossed: zone id, whether DRS was earned, sim time (ms) */
  drsDetection: { zone: string; eligible: boolean; atMs: number } | null;
  /** Share of the friction circle in use per tyre (telemetry only, 1 = at the limit) */
  circleFraction: [number, number, number, number];
  performanceMode: string;
  /** Which car profile drives the channels ("f12026-car", "amg-gt3"), and whether it has ERS / DRS */
  carId: string;
  hasErs: boolean;
  hasDrs: boolean;
  /** Traction control cutting the throttle / ABS releasing the brakes this step */
  tcActive: boolean;
  absActive: boolean;
  /** Touching a barrier this frame / last impact speed into the wall (m/s) and its sim time (ms) */
  wallContact: boolean;
  wallImpact: { speedMs: number; atMs: number } | null;
}

export type TelemetryData = CarTelemetry;

