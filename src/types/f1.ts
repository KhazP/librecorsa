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
  steerRim?: boolean; // `analogSteer` is the rim of a real steering wheel: no limit on how fast it turns the rack
  padSteer?: number; // Optional raw gamepad thumbstick [-1..1] (+ = right), run through the steering assist
  kbSteer?: number; // Optional keyboard steering direction (-1 left, 0, +1 right), always run through the steering assist
  clutch?: number; // Optional manual clutch [0..1]
  /** False when the active input device has no clutch bound; forces auto-clutch fallback so manual clutch cannot soft-lock */
  clutchBound?: boolean;
  manualOverride: boolean;
  /** One-frame press: use the Overtake earned in a race, or stop using it (a 2026 F1 car) */
  overtake?: boolean;
  toggleXMode: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  neutral?: boolean; // One-frame press: out of gear (both shift buttons at once, or the Neutral key / button)
}

export type CameraMode =
  | "chase_close"
  | "chase"
  | "chase_far"
  | "chase_low"
  | "tv_pod"
  | "cockpit_shoulder"
  | "cockpit"
  | "dash"
  | "nose"
  | "helicopter"
  | "tv_side"
  | "free";

/** Dry slicks, then the treaded rain tyres: intermediate (damp / light rain) and full wet (standing water) */
export type TireCompound = "soft" | "medium" | "hard" | "intermediate" | "wet";

export type LiveryCategory = "house" | "grid2026" | "retro" | "custom";

export type LiveryFinish = "gloss" | "satin" | "matte" | "metallic" | "chrome";

export type LiveryPatternId =
  | "librecorsa"
  | "aurora"
  | "verdant"
  | "papaya26"
  | "rosso26"
  | "silver26"
  | "cobalt26"
  | "emerald26"
  | "bleu26"
  | "royal26"
  | "bianco26"
  | "carbon26"
  | "titanium26"
  | "crest26"
  | "retro88_chevron"
  | "retro78_pinstripe"
  | "retro93_tri"
  | "retro05_sky"
  | "retro09_fluoro"
  | "retro99_hornet"
  | "custom";

export interface LiverySponsorSet {
  /** Large sidepod wordmark and chase-cam rear wing banner */
  title: string;
  /** Rear wing top plane and front wing flap partner */
  wing: string;
  /** Nose deck and engine cover secondary partner */
  nose: string;
  /** Halo arch and cockpit collar partner */
  halo: string;
  /** Wing endplate and lower flank technical partner */
  tech: string;
}

export interface LiveryVisualSpec {
  pattern: LiveryPatternId;
  finish: LiveryFinish;
  /** Rich paint colours used by the procedural 2048px canvas livery painter */
  bodyBase: string;
  bodySecondary: string;
  stripePrimary: string;
  stripeSecondary?: string;
  noseTip?: string;
  airbox?: string;
  halo?: string;
  wingMain?: string;
  endplate?: string;
  rimColor?: string;
  numberBg?: string;
  numberColor?: string;
  /** Exposed woven carbon-fibre intensity (0 = fully painted retro, 1 = heavy 2026 carbon flanks/floor) */
  carbonExposure: number;
  sponsors: LiverySponsorSet;
  /** Multi-colour CSS gradient preview used by the livery picker swatch */
  swatchCss?: string;
}

export type LiveryId =
  | "librecorsa"
  | "aurora"
  | "verdant"
  | "grid26_papaya"
  | "grid26_rosso"
  | "grid26_silver"
  | "grid26_cobalt"
  | "grid26_emerald"
  | "grid26_bleu"
  | "grid26_royal"
  | "grid26_bianco"
  | "grid26_carbon"
  | "grid26_titanium"
  | "grid26_crest"
  | "retro_red_white"
  | "retro_black_gold"
  | "retro_tri_93"
  | "retro_sky_05"
  | "retro_fluoro_09"
  | "retro_hornet_99"
  | "custom";

export interface CustomLiveryColors {
  primary: string;
  secondary: string;
  accent: string;
}

export interface LiveryConfig {
  id: LiveryId;
  name: string;
  team: string;
  primary: string;
  secondary: string;
  accent: string;
  number: string;
  /** Grouping in the livery picker (house originals, 2026 grid mockups, retro classics, custom) */
  category?: LiveryCategory;
  /** High-craft procedural livery pattern, finish, multi-zone palette, and fictional sponsors */
  visual?: LiveryVisualSpec;
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
  /** Lap-time line of the F1 cars (LC26, f12026-car), normalised: see `aiLineOffsetM` */
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
  /** Out of the race (terminal damage) */
  retired?: boolean;
  /** Disqualified by race control */
  dq?: boolean;
  /** Damage 0..1 (absent: none) */
  damage?: number;
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
  /** Disqualified (shown in place of the DNF) */
  dq?: boolean;
  /** Time penalties added to the race time (s), already included in `finishTimeS` and `gapS` */
  penaltyS?: number;
  /** Track-limits warnings received (the player's own) */
  trackLimitWarnings?: number;
  /** Place on the grid at the start (1 = pole) */
  gridPosition?: number;
}

/** A race (AI opponents or multiplayer): start procedure, live order and the result */
export interface RaceStatus {
  /** 'finished': the player has taken the flag */
  phase: 'lights' | 'racing' | 'finished';
  /** Red start lights lit (0–5); 0 during the race */
  lightsOn: number;
  /** Seconds until the light sequence starts (multiplayer countdown, an AI race's grid after qualifying); absent otherwise */
  countdownS?: number;
  /** Rolling-start formation approach: the field holds this pace (m/s) until the leader crosses Start/Finish */
  rollingFormation?: { paceMs: number };
  /** The qualifying classification the race lined up in (AI race with qualifying): code, player, best clean lap (ms) */
  qualifying?: { code: string; isPlayer: boolean; lapMs: number | null }[];
  /** Race length (laps) */
  totalLaps?: number;
  /** Final classification once the player has finished */
  results?: RaceResultEntry[];
  /** True once the classification no longer changes */
  resultsFinal?: boolean;
  /** Multiplayer: `results` are the race server's (or the room host's) classification, not this game's own */
  resultsOfficial?: boolean;
  /** Multiplayer race (results come from every player's own timing) */
  multiplayer?: boolean;
  /** Player's position (1 = leading) */
  position: number;
  fieldSize: number;
  lap: number;
  standings: RaceStandingEntry[];
  /** Split gaps to the cars directly ahead and behind the player in the running order */
  splits?: RaceSplits;
  /** Race control's live messages, newest first (AI race) */
  raceControl?: RaceControlFeedMessage[];
  /** The player is coming up on a yellow flag */
  yellow?: boolean;
  /** … and it is a double yellow (a car stopped on the road, or more than one incident) */
  doubleYellow?: boolean;
  /** Blue flag: the car lapping the player is close behind (its code) */
  blueFlag?: string;
  /** True once race control has warned the player for ignoring an active blue flag */
  blueFlagWarn?: boolean;
  /** Virtual Safety Car state when deployed or ending */
  vsc?: { phase: 'deployed' | 'ending'; deltaS: number; graceS: number; speedKmh: number };
  /** A place the player owes back after passing under yellow: to whom, and the time left to give it back */
  giveBack?: { code: string; double: boolean; remainingS: number; progress: number };
  /** The player's car damage (absent: none, or damage off) */
  damage?: PlayerDamageStatus;
}

/** One race-control message for the HUD */
export interface RaceControlFeedMessage {
  id: number;
  kind: 'yellow' | 'green' | 'investigation' | 'penalty' | 'warning' | 'nfa' | 'retired' | 'info';
  text: string;
  detail?: string;
}

/** The player's damage by part, 0 (as new) .. 1 (gone) */
export interface PlayerDamageStatus {
  front: number;
  rear: number;
  left: number;
  right: number;
  /** Suspension per corner: FR, FL, RR, RL */
  suspension: [number, number, number, number];
  punctured: [boolean, boolean, boolean, boolean];
  overall: number;
  terminal: boolean;
}

/** One split gap (time at the same point of the track) to a nearby car */
export interface RaceSplit {
  driverCode: string;
  teamColorHex: string;
  /** Time gap (s, ≥ 0) */
  gapS: number;
  /** How the gap moved over the last few seconds (s; + = growing); absent until known */
  changeS?: number;
}

export interface RaceSplits {
  ahead?: RaceSplit;
  behind?: RaceSplit;
}

/** Cold pressure per tyre (psi gauge): front-left, front-right, rear-left, rear-right */
export interface WheelPressures {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

/** The pressure of one tyre by its corner */
export const pressureAt = (p: WheelPressures, isFront: boolean, isLeft: boolean): number =>
  isFront ? (isLeft ? p.fl : p.fr) : isLeft ? p.rl : p.rr;

/** Both tyres of each axle at one pressure */
export const axlePressures = (front: number, rear: number): WheelPressures => ({ fl: front, fr: front, rl: rear, rr: rear });

/** Driver-set tyre setup. Camber in degrees per axle, negative = top of the tyre leaning inward. */
export interface TyreSetup {
  /** Psi gauge per tyre at the model's cold reference: LC26 20 °C; F12026/GT3 compound blanket temperature. */
  coldPressurePsi: WheelPressures;
  camberDeg: { front: number; rear: number };
}

/** The control a manual start's cue names as the clutch */
export type StartClutchControl = { pad: number } | { key: string } | { name: string };

export interface CarTelemetry {
  /** The last car-to-car contact this car took in a race: its closing speed (m/s), counted up per contact */
  carContact?: { speedMs: number; seq: number };
  speedKmh: number;
  speedMs: number;
  rpm: number;
  gear: number; // -1 = R, 0 = N, 1..8
  throttle: number; // 0..1
  brake: number; // 0..1
  clutch: number; // 0..1 (1 = engaged, 0 = disengaged)
  /** Normalized clutch slip intensity (0..1) while the clutch is partially engaged and engine/wheel speeds differ */
  clutchSlip?: number;
  /** True when the engine has stalled under manual clutch (autoClutch off); hold clutch or shift to N to restart */
  engineStalled?: boolean;
  /** The player's currently bound clutch control, if any (shown on the stall recovery cue) */
  clutchControl?: StartClutchControl;
  steering: number; // -1..1 (positive = right)
  /**
   * The player's own steering this frame, −1..1 (+ = right): the keys' direction, the shaped stick, or the wheel, mouse
   * or touch, whichever steered. The session sets it on the HUD's copy, so the input trace can draw it against
   * `steering` (the road-wheel angle over the lock); absent while not driving and on other cars.
   */
  steerInput?: number;
  /** Road-wheel angle at full lock (deg), to read `steering` in degrees; on the HUD's copy, as `steerInput` */
  steerLockDeg?: number;
  longitudinalG: number;
  lateralG: number;
  /** Aero load as a multiple of the car's weight, 1 + downforce / (mass · g): the cameras, haptics and effects read it; it carries no bumps */
  verticalG: number;
  /**
   * Measured vertical acceleration of the chassis (g): the specific force along the car's up axis an accelerometer on
   * the tub at the CG reads. 1 parked on flat ground, spikes over kerbs and bumps, dips over crests, 0 in the air;
   * low-passed at 20 Hz (`chassis-g.ts`). Feeds the telemetry packet's `gVert`. Absent on a car that does not measure it
   */
  chassisVerticalG?: number;
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
  /** Electric machine speed (rpm), where it differs from the engine's (a unit that can drive with the engine off) */
  mguRpm?: number;
  /** Mean speed of the driven shafts (rad/s) and the torque they carry (Nm, negative on the overrun and under
   * regeneration): heard by sound banks with a `driveline` section (`lc26-audio.ts`) */
  driveshaftRadS?: number;
  driveshaftTorqueNm?: number;
  totalPowerKw: number;
  ersBatteryPercent: number; // 0..100
  /** The motor pushed by the driver: the Boost, or (a 2026 F1 car in a race) the Overtake in use */
  manualOverrideActive: boolean;
  boostRemainingS: number;
  /** A 2026 F1 car's Boost held (it keeps or raises the motor's power; in a race to its power when pressed or 150 kW) */
  ersBoostActive?: boolean;
  /** A 2026 F1 car's Overtake in use in a race (the higher speed curve), and whether the assist is using it */
  overtakeInUse?: boolean;
  overtakeAuto?: boolean;
  /** A 2026 F1 car in a race, where Overtake is earned at the Detection Line (outside a race it is on all the time) */
  overtakeRace?: boolean;
  /** The car's overtaking aids (`overtaking-rules.ts`): 2026 Straight Mode + Overtake, rear-flap DRS, or none (pre-2011) */
  overtakingRules?: import('@/lib/sim/overtaking-rules').OvertakingRules;
  /** The override (Overtake Mode on a 2026 car) may be used now: in a race only once earned within 1 s */
  overtakeAvailable?: boolean;
  /**
   * Race control's Low Grip Conditions for a 2026 F1 car: Overtake off, the Boost only holding the power, the front
   * flaps alone in Straight Mode
   */
  lowGrip?: boolean;
  turboBoostBar: number;
  fuelKg: number;
  // 4-Corner Tires, Suspension & Brakes (Ordered FL, FR, RL, RR for HUD display)
  tireSlipRatio: [number, number, number, number]; // FL, FR, RL, RR combined normalized slip (0..1.5)
  wheelSlipRatios: [number, number, number, number]; // FL, FR, RL, RR signed longitudinal slip ratio
  wheelSlipAnglesDeg: [number, number, number, number]; // FL, FR, RL, RR lateral slip angle (deg)
  wheelLoadsN: [number, number, number, number]; // FL, FR, RL, RR vertical contact load Fz (N)
  /**
   * FL, FR, RL, RR: what the road's shape did to each tyre this frame, from its load hits (0 smooth road, 1 a hard
   * kerb), and left / right: how often those hits came (Hz). From the physics, for the pad and the DualSense
   */
  wheelKerbHit?: [number, number, number, number];
  kerbHitHz?: [number, number];
  wheelRideHeightsMm: [number, number, number, number]; // FL, FR, RL, RR dynamic ride height (mm)
  suspensionTravelMm: [number, number, number, number]; // FL, FR, RL, RR suspension compression (mm)
  suspensionVelocityMs: [number, number, number, number]; // FL, FR, RL, RR shock velocity (m/s, + = compressing), from the last physics step
  tireTempsC: [number, number, number, number]; // FL, FR, RL, RR (°C)
  tireWearPct: [number, number, number, number]; // FL, FR, RL, RR (0..100% wear)
  /** Tread surface temperatures across each tyre, left → right as seen from behind (°C) */
  tireBandTempsC?: [Band3, Band3, Band3, Band3];
  /** Current inflation pressures (psi gauge) */
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
  /**
   * A manual standing start, set by the app shell: the car held on the grid through the lights, a jump start, the
   * control the player holds as the clutch (a standard-mapping pad button, a key's name, or a named control such as
   * "clutch pedal"), and how far they hold it in (0..1, 1 = pressed)
   */
  start?: {
    held: boolean;
    jumped: boolean;
    /** What the jump start costs as it stands (s): +5, or +10 for a big one */
    penaltyS?: number;
    clutch: StartClutchControl;
    clutchIn: number;
  };
  /** The player's reaction to the lights going out at the last start (ms), set by the session (race-start.ts ReactionWatch) */
  startReactionMs?: number;
  /**
   * Qualifying before an AI race (qualifying.ts), set by the session: the clock left (s), whether the lap under way is
   * the last one (the clock has run out) and still counts, and the best clean lap so far (ms)
   */
  qualifying?: { remainingS: number; lastLap: boolean; lapCounts: boolean; bestMs: number | null };
  /** The weekly challenge's time trial is being driven (its car, rules and board), set by the session */
  timeTrial?: boolean;
  /**
   * The player's car damage in practice or a time trial with Practice damage on, set by the session; absent while
   * nothing is broken, and in a race (its damage is `race.damage`)
   */
  practiceDamage?: PlayerDamageStatus;
  /** What the car was last driven with (keyboard, controller, wheel, touch), set by the session; absent until it moves */
  drivingInput?: "keyboard" | "controller" | "wheel" | "touch";
  /**
   * Run counter, set by the app shell: it goes up whenever the run restarts (a new session, a restart, a
   * teleport, a car change). Anything that keeps lap- or run-scoped state resets when it changes,
   * instead of guessing a restart from the lap count or distance.
   */
  runId?: number;
  /** Live engineering telemetry channels, present while driving the f12026-car or GT3 */
  f12026?: F12026Channels;
  /** Live in-race MFD tuner state (TC1/TC2, 4-ch ABS, Brake Bias/Migration, 3-Phase Diff, ERS/Engine Map) */
  liveTuner?: LiveTunerState;
  /** The physics' own verdict on the running lap (judged track limits): false once it has been cut */
  lapInvalid?: boolean;
  /** True while on the out-lap before the first start/finish crossing starts lap timing */
  outLap?: boolean;
  /** Verdict on the lap that was just completed (set together with `lapCount` / `lastLapTimeMs`) */
  lastLapValid?: boolean;
  /** Reference hot pressure at which each tyre grips best (psi gauge) */
  tireOptimalPsi?: [number, number, number, number];
  /** The compound's working window of tread temperature (°C) */
  tireOptimalTempC?: [number, number];
  /** Track-limits judging: warnings, penalties and the excursion being judged */
  trackLimits?: TrackLimitsStatus;
}

/** Why an excursion counted against the driver */
export type TrackLimitsReason = "gained" | "corner_cut" | "not_lifted" | "illegal_overtake" | "course_cut" | "wall_contact";

/** The race-control state of the track-limits judging (see `TrackLimitsMonitor`) */
export interface TrackLimitsStatus {
  /** Warnings in the current strike cycle (0..strikesPerPenalty − 1) and the cycle length */
  warnings: number;
  strikesPerPenalty: number;
  /** Every strike of the session / race */
  totalStrikes: number;
  /** Time penalties awarded (s) */
  penaltyS: number;
  /**
   * A race on a points ladder (race-rules.ts): its points so far against the allowance; `warnings` / `strikesPerPenalty`
   * then hold the meter towards the next step. Absent: the strike ladder of before, or not a race
   */
  ladder?: {
    scoring: 'four_strike' | 'weighted_pts';
    points: number;
    pointsAllowed: number;
    /** Within a point of the next step: the black-and-white flag is out */
    blackWhite: boolean;
    disqualified: boolean;
  };
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
    kind: "warning" | "final_warning" | "penalty" | "disqualified" | "cleared" | "lap_invalid" | "no_advantage";
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
  /**
   * Traction Control slip-angle dial (0 = off, 1 = the most sideways slide before it cuts, 12 = the least), on a car
   * whose electronics have it (`hasTcSlipAngle`)
   */
  tcSlipAngleLevel: number;
  hasTcSlipAngle: boolean;
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
  /** A prototype's hybrid dials (kW): the motor's deployment cap and the braking regeneration cap; null without them */
  motorDeployKw: number | null;
  regenKw: number | null;
  /** The steps each dial has (kW), empty without them */
  motorDeployStepsKw: readonly number[];
  regenStepsKw: readonly number[];
  /** The class bans ABS: the dial stays at 0 unless the Assisted preset keeps it */
  absAllowed: boolean;
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
    | "tcSlipAngleLevel"
    | "absLevel"
    | "brakeBiasPct"
    | "brakeMigrationPct"
    | "diffEntry"
    | "diffMid"
    | "diffExit"
    | "engineMap"
    | "ersMode"
  >
> & { motorDeployKw?: number; regenKw?: number };

/**
 * Player car: the LC26 model (F1Physics2026), the 6-DOF f12026-car, or the Mercedes-AMG GT3, the Suzuki Liana, the
 * MTRacing 496R, the LC-LMDH, the classic Nissans, the BMW M1 Procar, the VW Scirocco and the two Chaparral 2Ds on the
 * same vehicle model
 */
export type VehicleModelId =
  | "lc26"
  | "f12026-car"
  | "amg-gt3"
  | "liana"
  | "mtr-496r"
  | "lc-lmdh"
  | "nissan-r33-jgtc"
  | "nissan-r32-jtcc"
  | "bmw-m1-procar"
  | "vw-scirocco-gtx"
  | "chaparral-2d"
  | "chaparral-2d-67"
  | "porsche-934-rsr";

/** Typed as a Record over VehicleModelId so adding a car fails to compile until it is listed here */
const VEHICLE_MODEL_ID_SET: Record<VehicleModelId, true> = {
  lc26: true,
  "f12026-car": true,
  "amg-gt3": true,
  liana: true,
  "mtr-496r": true,
  "lc-lmdh": true,
  "nissan-r33-jgtc": true,
  "nissan-r32-jtcc": true,
  "bmw-m1-procar": true,
  "vw-scirocco-gtx": true,
  "chaparral-2d": true,
  "chaparral-2d-67": true,
  "porsche-934-rsr": true,
};

/** Every vehicle model id, for validating ids from storage and the network */
export const VEHICLE_MODEL_IDS = Object.keys(VEHICLE_MODEL_ID_SET) as readonly VehicleModelId[];

/**
 * A vehicle model id from a file, a save or the network, followed to the model's present id: the 2026 Prototype's
 * was renamed, and ghost files and older clients still carry the old one
 */
export function foldVehicleModelId(value: unknown): unknown {
  return value === "vf26" ? "lc26" : value; // keep-old-id
}

export function isVehicleModelId(value: unknown): value is VehicleModelId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VEHICLE_MODEL_ID_SET, value);
}

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
  /** A press of the flap button is kept for the zone the car is on or coming to: it opens the flaps once they may open */
  drsQueued: boolean;
  /** Last detection point crossed: zone id, whether DRS was earned, sim time (ms) */
  drsDetection: { zone: string; eligible: boolean; atMs: number } | null;
  /** 2026 Straight Mode: the last time a stretch where the flaps may open came up ahead (sim time, ms) */
  straightModeAhead: { atMs: number } | null;
  /** 2026, in a race: race control's last Overtake Mode verdict at the detection point (sim time, ms) */
  overtakeDetection: { earned: boolean; atMs: number } | null;
  /** Share of the friction circle in use per tyre (telemetry only, 1 = at the limit) */
  circleFraction: [number, number, number, number];
  performanceMode: string;
  /** Which car profile drives the channels ("f12026-car", "amg-gt3", "liana", "mtr-496r"), and whether it has ERS / DRS */
  carId: string;
  hasErs: boolean;
  hasDrs: boolean;
  /** Traction control cutting the throttle / ABS releasing the brakes this step */
  tcActive: boolean;
  absActive: boolean;
  /** Touching a barrier this frame / last impact speed into the wall (m/s) and its sim time (ms) */
  wallContact: boolean;
  /**
   * Seconds the body has touched a barrier while moving, every fixed step counted, since the car was last placed (a
   * placement zeroes it, otherwise it only grows): race control judges barrier contact from its rise between frames,
   * however few of them it sees
   */
  wallContactS: number;
  /** Last barrier impact: into-wall speed, when, and where on the car (m, + left / + forward) */
  wallImpact: { speedMs: number; atMs: number; localX?: number; localZ?: number } | null;
}

export type TelemetryData = CarTelemetry;

