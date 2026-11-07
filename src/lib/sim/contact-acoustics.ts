/**
 * First-Principles Contact Patch, Suspension & Brake Acoustics Engine (`contact-acoustics.ts`)
 *
 * Synthesizes and evaluates per-corner (FL, FR, RL, RR) mechanical/surface acoustics on top of CarAudio's own
 * tyre squeal, scrub, kerb and gravel layers:
 * 3. Suspension Stroke & High-G Chassis Rattle:
 *    - Per-wheel suspension deflection differentiation into stroke velocity `v_susp` (EMA factor 0.4)
 *      and stroke acceleration `a_susp` (asymmetric buildup 0.5 when rising, decay 0.06 when falling),
 *      plus smoothed vertical load (EMA 0.1).
 *    - Damper compression thump (`(|v_susp| / 10)^0.7`) and sharp bump/kerb mechanical rattle
 *      (`(|a_susp| / 80)^2.0`).
 * 4. Surface Rolling & Debris:
 *    - Asphalt rolling road roar scaled by `speed^1.1`, vertical load offset (-0.1..+0.1), and
 *      high-slip amplitude chop (`1 - noise * slip^2.5`).
 *    - Wheel-arch pebble/marble scatter clicks when `tireDirtyLevel > 0.05`.
 * 5. High-Performance Brake Squeal:
 *    - Band-limited metallic rotor squeal active in the partial-to-firm brake pedal window
 *      (0.2..0.6 pedal curve with 0.8 exponent), gated by wheel angular speed low-speed fadeout and
 *      brake disc temperature window (180..750 degC), with pedal pressure pitch rise and rotor
 *      size/speed timbre shift.
 *    - Interior vs. exterior camera mix and gain scaling (`INTERIOR_CAMERAS`).
 */

import type { CameraMode, SurfaceType, TelemetryData, TireCompound } from '@/types/f1';

/** Cameras mounted on/in the chassis that receive cockpit acoustic attenuation and interior filtering */
export const CONTACT_INTERIOR_CAMERAS: ReadonlySet<CameraMode> = new Set<CameraMode>([
  'cockpit',
  'cockpit_shoulder',
  'nose',
  'tv_pod',
]);

/** Clamps `value` to `[min, max]` and guards against NaN/Infinity */
export function clampSafe(value: number, min: number, max: number, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    value = fallback;
  }
  return value < min ? min : value > max ? max : value;
}

/**
 * Linearly maps `value` from `[inMin, inMax]` to `[outMin, outMax]`.
 * When `clamp` is true (default), constrains the result to `[min(outMin, outMax), max(outMin, outMax)]`,
 * preserving inverted output ranges such as pitch drops or pedal release curves.
 */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  clamp = true
): number {
  if (!Number.isFinite(value)) return outMin;
  const span = inMax - inMin;
  if (Math.abs(span) < 1e-12) return outMin;
  const mapped = ((value - inMin) / span) * (outMax - outMin) + outMin;
  if (!clamp) return mapped;
  return outMin < outMax
    ? Math.max(outMin, Math.min(outMax, mapped))
    : Math.max(outMax, Math.min(outMin, mapped));
}

/**
 * Deterministic 1D integer hash returning a signed gradient in `[-1, 1]`.
 */
function grad1D(n: number): number {
  let x = (n | 0) * 374761393;
  x = ((x << 13) ^ x) | 0;
  const hashed = (x * ((x * x * 15731 + 789221) | 0) + 1376312589) & 0x7fffffff;
  return 1.0 - hashed / 1073741824.0;
}

/**
 * Single-octave smooth 1D gradient noise in `[-1, 1]` using quintic Hermite interpolation.
 */
export function gradientNoise1D(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const xi = Math.floor(x);
  const xf = x - xi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const g0 = grad1D(xi) * xf;
  const g1 = grad1D(xi + 1) * (xf - 1);
  // Scale factor 1.85 normalizes peak quintic gradient amplitude to [-1, 1]
  return clampSafe((g0 + u * (g1 - g0)) * 1.85, -1, 1, 0);
}

/**
 * Deterministic multi-octave 1D fractal Brownian motion (Perlin/gradient noise) in `[-1, 1]`.
 */
export function fbmNoise1D(x: number, octaves = 4): number {
  if (!Number.isFinite(x)) return 0;
  const count = Math.max(1, Math.min(8, octaves | 0));
  let total = 0;
  let amplitude = 1.0;
  let frequency = 1.0;
  let norm = 0;
  for (let o = 0; o < count; o++) {
    total += gradientNoise1D(x * frequency + o * 17.37) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.02;
  }
  return norm > 0 ? clampSafe(total / norm, -1, 1, 0) : 0;
}

/** Axle-level physical tyre and brake geometry parameters */
export interface AxleAcousticsConfig {
  tireWidthM: number;
  tireRadiusM: number;
  rimRadiusM: number;
  idealPressurePsi: number;
  psiLow: number;
  psiHigh: number;
  maxLoadN: number;
  optSlipAngleDeg: number;
  basePitch: number;
  baseTimbre: number;
  baseBrakePitch: number;
  maxBrakeTorqueNm: number;
  brakeTorqueFader: number;
  brakeMinPedalLevel: number;
  brakeMaxPedalLevel: number;
}

/** Vehicle-level acoustic profile covering open-wheel formula cars and closed-cockpit GT cars */
export interface ContactAcousticsVehicleProfile {
  id: string;
  isOpenWheeler: boolean;
  isRaceCar: boolean;
  treadLevel: number;
  brakeBiasFront: number;
  front: AxleAcousticsConfig;
  rear: AxleAcousticsConfig;
}

export interface AxleSpecInit {
  tireWidthM: number;
  tireRadiusM: number;
  rimRadiusM: number;
  idealPressurePsi: number;
  optSlipAngleDeg: number;
  maxBrakeTorqueNm: number;
  isOpenWheeler: boolean;
  isRaceCar: boolean;
}

/** Derives axle acoustic constants from physical tyre & brake dimensions */
export function buildAxleAcousticsConfig(spec: AxleSpecInit): AxleAcousticsConfig {
  const aspectRatio =
    (spec.tireRadiusM * 2 - spec.rimRadiusM * 2) / Math.max(0.05, spec.tireWidthM);
  const basePitch = Number(mapRange(spec.tireWidthM, 0.05, 0.5, 0.55, 0.0, true).toFixed(2));
  const baseTimbre = Number(mapRange(aspectRatio, 0.2, 1.2, 0.35, -0.2, true).toFixed(2));
  const baseBrakePitch = Number(mapRange(spec.tireRadiusM, 0.15, 0.8, 0.5, -0.3, true).toFixed(2));
  const maxLoadN = Math.round(mapRange(spec.tireRadiusM, 0.05, 0.4, 5000, 14000, true) / 100) * 100;
  return {
    tireWidthM: spec.tireWidthM,
    tireRadiusM: spec.tireRadiusM,
    rimRadiusM: spec.rimRadiusM,
    idealPressurePsi: spec.idealPressurePsi,
    psiLow: spec.idealPressurePsi - 15,
    psiHigh: spec.idealPressurePsi + 10,
    maxLoadN,
    optSlipAngleDeg: spec.optSlipAngleDeg,
    basePitch,
    baseTimbre,
    baseBrakePitch,
    maxBrakeTorqueNm: spec.maxBrakeTorqueNm,
    brakeTorqueFader: spec.isRaceCar ? 1.0 : 0.5,
    brakeMinPedalLevel: spec.isRaceCar && !spec.isOpenWheeler ? 2.0 : 0.8,
    brakeMaxPedalLevel: 0.0,
  };
}

/** Default 2026 Open-Wheel Formula car profile (18-inch rims, 305/405 mm slicks) */
export const OPEN_WHEELER_ACOUSTICS_PROFILE: ContactAcousticsVehicleProfile = {
  id: 'open-wheeler',
  isOpenWheeler: true,
  isRaceCar: true,
  treadLevel: 0,
  brakeBiasFront: 0.56,
  front: buildAxleAcousticsConfig({
    tireWidthM: 0.305,
    tireRadiusM: 0.36,
    rimRadiusM: 0.2286,
    idealPressurePsi: 23.0,
    optSlipAngleDeg: 6.5,
    maxBrakeTorqueNm: 5200 * 0.56,
    isOpenWheeler: true,
    isRaceCar: true,
  }),
  rear: buildAxleAcousticsConfig({
    tireWidthM: 0.405,
    tireRadiusM: 0.36,
    rimRadiusM: 0.2286,
    idealPressurePsi: 21.0,
    optSlipAngleDeg: 7.0,
    maxBrakeTorqueNm: 5200 * 0.44,
    isOpenWheeler: true,
    isRaceCar: true,
  }),
};

/** Default closed-cockpit GT3 car profile */
export const GT3_ACOUSTICS_PROFILE: ContactAcousticsVehicleProfile = {
  id: 'gt3',
  isOpenWheeler: false,
  isRaceCar: true,
  treadLevel: 0,
  brakeBiasFront: 0.61,
  front: buildAxleAcousticsConfig({
    tireWidthM: 0.3,
    tireRadiusM: 0.34,
    rimRadiusM: 0.2286,
    idealPressurePsi: 27.5,
    optSlipAngleDeg: 7.5,
    maxBrakeTorqueNm: 4800 * 0.61,
    isOpenWheeler: false,
    isRaceCar: true,
  }),
  rear: buildAxleAcousticsConfig({
    tireWidthM: 0.31,
    tireRadiusM: 0.355,
    rimRadiusM: 0.2286,
    idealPressurePsi: 27.5,
    optSlipAngleDeg: 7.5,
    maxBrakeTorqueNm: 4800 * 0.39,
    isOpenWheeler: false,
    isRaceCar: true,
  }),
};

/** Selects the acoustic profile for a given sound bank id and optional tyre compound */
export function profileForCarSoundId(
  soundId: string,
  compound?: TireCompound
): ContactAcousticsVehicleProfile {
  const isGt3 = soundId.includes('gt3');
  const base = isGt3 ? GT3_ACOUSTICS_PROFILE : OPEN_WHEELER_ACOUSTICS_PROFILE;
  const treadLevel = compound === 'intermediate' || compound === 'wet' ? 1 : 0;
  if (treadLevel === base.treadLevel) return base;
  return { ...base, treadLevel };
}

/** Per-corner persistent state for suspension differentiation, load smoothing, and surface fade envelopes */
export interface CornerAcousticsState {
  travelM: number;
  velocityMs: number;
  prevVelocityMs: number;
  accelerationMs2: number;
  smoothedVelocityMs: number;
  smoothedAccelerationMs2: number;
  loadN: number;
  smoothedLoadN: number;
  asphaltFade: number;
  brakeSmoothedIntensity: number;
  debrisPhase: number;
}

/** Complete 4-corner mutable state for `evaluateContactAcoustics` */
export interface ContactAcousticsState {
  corners: [
    CornerAcousticsState,
    CornerAcousticsState,
    CornerAcousticsState,
    CornerAcousticsState,
  ];
  timeSec: number;
}

function createCornerState(): CornerAcousticsState {
  return {
    travelM: 0,
    velocityMs: 0,
    prevVelocityMs: 0,
    accelerationMs2: 0,
    smoothedVelocityMs: 0,
    smoothedAccelerationMs2: 0,
    loadN: 0,
    smoothedLoadN: 0,
    asphaltFade: 0,
    brakeSmoothedIntensity: 0,
    debrisPhase: 0,
  };
}

/** Creates a fresh zeroed 4-corner acoustics state */
export function createContactAcousticsState(): ContactAcousticsState {
  return {
    corners: [
      createCornerState(),
      createCornerState(),
      createCornerState(),
      createCornerState(),
    ],
    timeSec: 0,
  };
}

/** Resets an existing state object in-place without allocating */
export function resetContactAcousticsState(state: ContactAcousticsState): void {
  state.timeSec = 0;
  for (let i = 0; i < 4; i++) {
    const c = state.corners[i];
    c.travelM = 0;
    c.velocityMs = 0;
    c.prevVelocityMs = 0;
    c.accelerationMs2 = 0;
    c.smoothedVelocityMs = 0;
    c.smoothedAccelerationMs2 = 0;
    c.loadN = 0;
    c.smoothedLoadN = 0;
    c.asphaltFade = 0;
    c.brakeSmoothedIntensity = 0;
    c.debrisPhase = 0;
  }
}

/** Per-corner physical input into `evaluateContactAcoustics` */
export interface CornerContactInput {
  /** Normalized combined slip ratio relative to peak grip (0..10+) */
  ndSlip: number;
  /** Signed longitudinal slip ratio */
  slipRatio: number;
  /** Lateral slip angle (degrees) */
  slipAngleDeg: number;
  /** Vertical contact normal force Fz (Newtons) */
  loadN: number;
  /** Tyre inflation pressure (psi gauge) */
  pressurePsi: number;
  /** Wheel angular speed (rad/s) */
  angularSpeedRadS: number;
  /** Wheel ground speed magnitude (m/s) */
  groundSpeedMs: number;
  /** Vertical suspension compression travel (meters) */
  suspensionTravelM: number;
  /** Contact patch surface type */
  surface: SurfaceType;
  /** Brake disc temperature (°C) */
  brakeTempC: number;
  /** Off-track dirt / marble / pebble pickup level (0..1) */
  tireDirtyLevel: number;
}

/** Full vehicle frame input for `evaluateContactAcoustics` */
export interface ContactAcousticsInput {
  corners: [CornerContactInput, CornerContactInput, CornerContactInput, CornerContactInput];
  /** Normalized brake pedal application (0..1) */
  brakePedal: number;
  /** Optional front brake bias override (0..1) */
  brakeBiasFront?: number;
  /** Active camera view mode */
  cameraMode?: CameraMode;
  /** Simulation step time (seconds) */
  dt: number;
  /** Optional explicit clock time (seconds) for deterministic noise evaluation */
  timeSec?: number;
}

export interface CornerSuspensionOutput {
  damperVelocity: number;
  rattle: number;
  pitch: number;
  volume: number;
  rawVelocityMs: number;
  smoothedVelocityMs: number;
  rawAccelerationMs2: number;
  smoothedAccelerationMs2: number;
  smoothedLoadN: number;
  insideMix: number;
  cameraGain: number;
}

export interface CornerAsphaltOutput {
  speedNorm: number;
  slip: number;
  pitch: number;
  timbre: number;
  volume: number;
  loadOffset: number;
  slipVolumeChop: number;
  fade: number;
  insideMix: number;
  cameraGain: number;
}

export interface CornerDebrisOutput {
  active: boolean;
  intensity: number;
  clickRateHz: number;
  triggerClick: boolean;
}

export interface CornerBrakeOutput {
  pitch: number;
  timbre: number;
  pedalCurve: number;
  lowSpeedFadeout: number;
  tempGate: number;
  intensity: number;
  smoothedIntensity: number;
  volume: number;
  effectiveGain: number;
  insideMix: number;
  cameraGain: number;
}

export interface CornerAcousticsFrame {
  suspension: CornerSuspensionOutput;
  asphalt: CornerAsphaltOutput;
  debris: CornerDebrisOutput;
  brakes: CornerBrakeOutput;
}

export interface ContactAcousticsFrame {
  corners: [
    CornerAcousticsFrame,
    CornerAcousticsFrame,
    CornerAcousticsFrame,
    CornerAcousticsFrame,
  ];
  isInteriorCamera: boolean;
  suspensionAggregate: { damperVelocity: number; rattle: number; pitch: number; volume: number };
  asphaltAggregate: {
    volume: number;
    pitch: number;
    timbre: number;
    speedNorm: number;
    slipChop: number;
  };
  debrisAggregate: { intensity: number; clickRateHz: number; triggerClick: boolean };
  brakeAggregate: {
    volume: number;
    effectiveGain: number;
    pitch: number;
    timbre: number;
    intensity: number;
    tempGate: number;
  };
}

function createEmptyCornerFrame(): CornerAcousticsFrame {
  return {
    suspension: {
      damperVelocity: 0,
      rattle: 0,
      pitch: 1.1,
      volume: 1,
      rawVelocityMs: 0,
      smoothedVelocityMs: 0,
      rawAccelerationMs2: 0,
      smoothedAccelerationMs2: 0,
      smoothedLoadN: 0,
      insideMix: 0,
      cameraGain: 1,
    },
    asphalt: {
      speedNorm: 0,
      slip: 0,
      pitch: 1,
      timbre: 0,
      volume: 0,
      loadOffset: 0,
      slipVolumeChop: 0,
      fade: 0,
      insideMix: 0,
      cameraGain: 1,
    },
    debris: {
      active: false,
      intensity: 0,
      clickRateHz: 0,
      triggerClick: false,
    },
    brakes: {
      pitch: 0,
      timbre: 0,
      pedalCurve: 0,
      lowSpeedFadeout: 0,
      tempGate: 0,
      intensity: 0,
      smoothedIntensity: 0,
      volume: 0,
      effectiveGain: 0,
      insideMix: 0,
      cameraGain: 1,
    },
  };
}

/** Creates a pre-allocated output frame for zero-allocation evaluation */
export function createContactAcousticsFrame(): ContactAcousticsFrame {
  return {
    corners: [
      createEmptyCornerFrame(),
      createEmptyCornerFrame(),
      createEmptyCornerFrame(),
      createEmptyCornerFrame(),
    ],
    isInteriorCamera: false,
    suspensionAggregate: { damperVelocity: 0, rattle: 0, pitch: 1.25, volume: 0 },
    asphaltAggregate: { volume: 0, pitch: 1.0, timbre: 0.4, speedNorm: 0, slipChop: 0 },
    debrisAggregate: { intensity: 0, clickRateHz: 0, triggerClick: false },
    brakeAggregate: {
      volume: 0,
      effectiveGain: 0,
      pitch: 0.2,
      timbre: 0.6,
      intensity: 0,
      tempGate: 0,
    },
  };
}

// Smoothing constants for suspension travel differentiation & vertical load
const VELOCITY_SMOOTHING_FACTOR = 0.4;
const LOAD_SMOOTHING_FACTOR = 0.1;
const ACCEL_BUILDUP_FACTOR = 0.5;
const ACCEL_DECAY_FACTOR = 0.06;

// Interior camera volume multipliers per acoustic layer
const SUSP_INTERIOR_VOL_MULT = 1.0;
const ASPHALT_INTERIOR_VOL_MULT = 0.65;
const BRAKE_INTERIOR_VOL_MULT = 0.8;
const BRAKE_BASE_EVENT_VOL = 0.6;

/**
 * Pure-math contact patch, suspension, surface texture, and brake squeal evaluator.
 * Mutates `state` (and optional `outFrame`) in-place with zero heap allocations.
 */
export function evaluateContactAcoustics(
  input: ContactAcousticsInput,
  state: ContactAcousticsState,
  profile: ContactAcousticsVehicleProfile = OPEN_WHEELER_ACOUSTICS_PROFILE,
  outFrame?: ContactAcousticsFrame
): ContactAcousticsFrame {
  const frame = outFrame ?? createContactAcousticsFrame();
  const dt = clampSafe(input.dt, 0, 1.0, 1 / 60);
  if (typeof input.timeSec === 'number' && Number.isFinite(input.timeSec)) {
    state.timeSec = input.timeSec;
  } else {
    state.timeSec += dt;
  }
  const timeSec = state.timeSec;

  const isInterior =
    input.cameraMode !== undefined && CONTACT_INTERIOR_CAMERAS.has(input.cameraMode);
  frame.isInteriorCamera = isInterior;

  const brakeBiasFront = clampSafe(
    input.brakeBiasFront ?? profile.brakeBiasFront,
    0.1,
    0.9,
    0.56
  );
  const brakePedal = clampSafe(input.brakePedal, 0, 1, 0);

  // Interior mix factors depend on open-wheel vs closed-cockpit body shell
  const suspInsideMix = isInterior ? (profile.isOpenWheeler ? 0.2 : 1.0) : 0;
  const asphaltInsideMix = isInterior ? (profile.isOpenWheeler ? 0.2 : 0.6) : 0;
  const brakeInsideMix = isInterior ? (profile.isOpenWheeler ? 0.2 : 1.0) : 0;

  const suspCamGain = isInterior ? SUSP_INTERIOR_VOL_MULT : 1.0;
  const asphaltCamGain = isInterior ? ASPHALT_INTERIOR_VOL_MULT : 1.0;
  const brakeCamGain = isInterior ? BRAKE_INTERIOR_VOL_MULT : 1.0;

  for (let i = 0; i < 4; i++) {
    const cornerIn = input.corners[i];
    const cornerState = state.corners[i];
    const cornerOut = frame.corners[i];
    const isFront = i < 2;
    const axle = isFront ? profile.front : profile.rear;
    const tireIndex1 = i + 1;

    // -------------------------------------------------------------------------
    // 3. Suspension Stroke Differentiation & Load Smoothing
    // -------------------------------------------------------------------------
    const rawVelocity =
      dt > 1e-6 ? (cornerState.travelM - cornerIn.suspensionTravelM) / dt : 0;
    const rawAcceleration =
      dt > 1e-6 ? (rawVelocity - cornerState.prevVelocityMs) / dt : 0;

    const smoothedVelocity =
      cornerState.smoothedVelocityMs +
      (Math.abs(rawVelocity) - cornerState.smoothedVelocityMs) * VELOCITY_SMOOTHING_FACTOR;

    const absAccel = Math.abs(rawAcceleration);
    const accelFactor =
      absAccel > cornerState.smoothedAccelerationMs2
        ? ACCEL_BUILDUP_FACTOR
        : ACCEL_DECAY_FACTOR;
    const smoothedAcceleration =
      cornerState.smoothedAccelerationMs2 +
      (absAccel - cornerState.smoothedAccelerationMs2) * accelFactor;

    const loadN = Math.max(0, cornerIn.loadN);
    const smoothedLoadN =
      cornerState.smoothedLoadN + (loadN - cornerState.smoothedLoadN) * LOAD_SMOOTHING_FACTOR;

    cornerState.prevVelocityMs = rawVelocity;
    cornerState.travelM = cornerIn.suspensionTravelM;
    cornerState.velocityMs = rawVelocity;
    cornerState.accelerationMs2 = rawAcceleration;
    cornerState.smoothedVelocityMs = smoothedVelocity;
    cornerState.smoothedAccelerationMs2 = smoothedAcceleration;
    cornerState.loadN = loadN;
    cornerState.smoothedLoadN = smoothedLoadN;

    const damperVelocity = mapRange(Math.abs(rawVelocity), 0, 10, 0, 1, true) ** 0.7;
    const rattle = mapRange(Math.abs(smoothedAcceleration), 0, 80, 0, 1, true) ** 2.0;

    cornerOut.suspension.damperVelocity = damperVelocity;
    cornerOut.suspension.rattle = rattle;
    cornerOut.suspension.pitch = 1.0 + tireIndex1 * 0.1;
    cornerOut.suspension.volume = 1.0 * suspCamGain;
    cornerOut.suspension.rawVelocityMs = rawVelocity;
    cornerOut.suspension.smoothedVelocityMs = smoothedVelocity;
    cornerOut.suspension.rawAccelerationMs2 = rawAcceleration;
    cornerOut.suspension.smoothedAccelerationMs2 = smoothedAcceleration;
    cornerOut.suspension.smoothedLoadN = smoothedLoadN;
    cornerOut.suspension.insideMix = suspInsideMix;
    cornerOut.suspension.cameraGain = suspCamGain;

    const ndSlip = Math.max(0, cornerIn.ndSlip);
    const absAngVel = Math.abs(cornerIn.angularSpeedRadS);
    const groundSpeedMs = Math.max(0, cornerIn.groundSpeedMs);

    // -------------------------------------------------------------------------
    // 4. Surface Rolling & Debris
    // -------------------------------------------------------------------------
    const baseSurfaceSpeed = Math.max(groundSpeedMs * 0.015, absAngVel * 0.005);
    const surfaceSlip = mapRange(ndSlip, 0.0, 5.0, 0.0, 1.0, true) ** 0.8;

    // 4a. Asphalt rolling roar
    const onAsphalt = cornerIn.surface === 'asphalt';
    const asphaltSpeedNorm = baseSurfaceSpeed ** 1.1;
    const asphaltLoadOffset = mapRange(loadN, 0.0, axle.maxLoadN, -0.1, 0.1, true);
    const chopNoise = Math.sqrt(
      Math.abs(fbmNoise1D(timeSec * 0.004 + tireIndex1 * 2000, 3))
    );
    const slipVolumeChop = clampSafe(chopNoise * surfaceSlip ** 2.5, 0.0, 0.98, 0.0);

    const asphaltTargetFade = onAsphalt ? 1.0 : 0.0;
    const asphaltFadeRate = asphaltTargetFade > cornerState.asphaltFade ? 10.0 : 20.0;
    const asphaltFade = clampSafe(
      cornerState.asphaltFade +
        (asphaltTargetFade - cornerState.asphaltFade) * asphaltFadeRate * dt,
      0.0,
      1.0,
      0.0
    );
    cornerState.asphaltFade = asphaltFade;

    const asphaltEventBaseVol = profile.treadLevel > 0 ? 0.7 : 0.3;
    const asphaltTimbre = axle.baseTimbre + 0.25 + profile.treadLevel * 0.2;
    const asphaltPitch = mapRange(asphaltSpeedNorm ** 1.2, 0.0, 1.0, 1.0, 0.5, true);
    const asphaltVolume = Math.max(
      0.0,
      (asphaltEventBaseVol + asphaltLoadOffset) *
        (1.0 - slipVolumeChop) *
        asphaltSpeedNorm *
        asphaltFade
    );

    cornerOut.asphalt.speedNorm = asphaltSpeedNorm;
    cornerOut.asphalt.slip = surfaceSlip;
    cornerOut.asphalt.pitch = asphaltPitch;
    cornerOut.asphalt.timbre = asphaltTimbre;
    cornerOut.asphalt.volume = asphaltVolume;
    cornerOut.asphalt.loadOffset = asphaltLoadOffset;
    cornerOut.asphalt.slipVolumeChop = slipVolumeChop;
    cornerOut.asphalt.fade = asphaltFade;
    cornerOut.asphalt.insideMix = asphaltInsideMix;
    cornerOut.asphalt.cameraGain = asphaltCamGain;

    // 4d. Wheel-arch pebble / marble debris scatter when tireDirtyLevel > 0.05
    const dirtyLevel = clampSafe(cornerIn.tireDirtyLevel, 0, 1, 0);
    const debrisActive = dirtyLevel > 0.05 && groundSpeedMs > 1.0;
    const debrisIntensity = debrisActive
      ? mapRange(dirtyLevel, 0.05, 1.0, 0.0, 1.0, true) *
        mapRange(groundSpeedMs, 1.0, 55.0, 0.15, 1.0, true)
      : 0.0;
    const clickRateHz = debrisActive
      ? mapRange(dirtyLevel, 0.05, 1.0, 3.0, 38.0, true) *
        mapRange(groundSpeedMs, 1.0, 60.0, 0.2, 1.0, true)
      : 0.0;
    let triggerClick = false;
    if (debrisActive) {
      cornerState.debrisPhase += clickRateHz * dt;
      if (cornerState.debrisPhase >= 1.0) {
        triggerClick = true;
        cornerState.debrisPhase -= Math.floor(cornerState.debrisPhase);
      }
    } else {
      cornerState.debrisPhase = 0;
    }

    cornerOut.debris.active = debrisActive;
    cornerOut.debris.intensity = debrisIntensity;
    cornerOut.debris.clickRateHz = clickRateHz;
    cornerOut.debris.triggerClick = triggerClick;

    // -------------------------------------------------------------------------
    // 5. High-Performance Brake Squeal
    // -------------------------------------------------------------------------
    const brakeSpeed = Math.max(0, absAngVel * 0.03);
    const lowSpeedFadeout = mapRange(brakeSpeed, 0.0, 0.2, 0.0, 1.0, true);
    const brakeSizePitchMod = mapRange(axle.maxBrakeTorqueNm, 2500, 5000, 0.3, 0.0, true);

    // Disc temperature window: 180..750 degC
    const brakeTempC = cornerIn.brakeTempC;
    const tempGate =
      brakeTempC > 180 && brakeTempC < 750
        ? Math.min(
            mapRange(brakeTempC, 180, 250, 0.25, 1.0, true),
            mapRange(brakeTempC, 650, 750, 1.0, 0.25, true)
          )
        : 0.0;

    // Partial-to-firm brake pedal window (0.2..0.6 pedal curve with 0.8 exponent)
    const rawPedalCurve =
      mapRange(
        brakePedal,
        0.2,
        0.6,
        axle.brakeMinPedalLevel * lowSpeedFadeout,
        axle.brakeMaxPedalLevel * lowSpeedFadeout,
        true
      ) ** 0.8;
    // Smooth entry ramp below 0.2 so light grazing builds into the 0.2..0.6 squeal window
    const pedalWindowEntry = mapRange(brakePedal, 0.05, 0.2, 0.0, 1.0, true);
    const brakePedalCurve = rawPedalCurve * pedalWindowEntry;

    // Subtle pitch rise from pedal pressure and pedal curve
    const pedalPressurePitchAdd =
      mapRange(brakePedal, 0.2, 0.8, 0.0, 0.015, true) +
      mapRange(brakePedalCurve, 0.0, 1.0, 0.0, profile.isRaceCar ? 0.005 : 0.015, true);
    const brakePitch = axle.baseBrakePitch + pedalPressurePitchAdd + brakeSizePitchMod;

    const baseBrakeTimbre = profile.isRaceCar ? 0.6 : 0.15;
    const speedTimbreAdd = mapRange(brakeSpeed, 0.0, 1.0, 0.0, 0.1, true);
    const brakeTimbre = baseBrakeTimbre + speedTimbreAdd;

    const brakePctAxle = brakePedal * (isFront ? brakeBiasFront : 1.0 - brakeBiasFront);
    const rawBrakeIntensity = brakePctAxle * brakePedalCurve * tempGate;
    const smoothedBrakeIntensity = clampSafe(
      cornerState.brakeSmoothedIntensity +
        (rawBrakeIntensity - cornerState.brakeSmoothedIntensity) * Math.min(1.0, 10.0 * dt),
      0.0,
      1.0,
      0.0
    );
    cornerState.brakeSmoothedIntensity = smoothedBrakeIntensity;

    const zeroBrakeFadeout = mapRange(brakePedal, 0.0, 0.05, smoothedBrakeIntensity, 1.0, true);
    const brakeVolume =
      BRAKE_BASE_EVENT_VOL *
      axle.brakeTorqueFader *
      lowSpeedFadeout *
      zeroBrakeFadeout *
      tempGate;
    const brakeEffectiveGain = brakeVolume * smoothedBrakeIntensity * brakeCamGain;

    cornerOut.brakes.pitch = brakePitch;
    cornerOut.brakes.timbre = brakeTimbre;
    cornerOut.brakes.pedalCurve = brakePedalCurve;
    cornerOut.brakes.lowSpeedFadeout = lowSpeedFadeout;
    cornerOut.brakes.tempGate = tempGate;
    cornerOut.brakes.intensity = rawBrakeIntensity;
    cornerOut.brakes.smoothedIntensity = smoothedBrakeIntensity;
    cornerOut.brakes.volume = brakeVolume;
    cornerOut.brakes.effectiveGain = brakeEffectiveGain;
    cornerOut.brakes.insideMix = brakeInsideMix;
    cornerOut.brakes.cameraGain = brakeCamGain;
  }

  // ---------------------------------------------------------------------------
  // Aggregate across axles & corners for efficient synthesis
  // ---------------------------------------------------------------------------
  const fl = frame.corners[0];
  const fr = frame.corners[1];
  const rl = frame.corners[2];
  const rr = frame.corners[3];

  // Suspension aggregate
  let maxDamperVel = 0;
  let maxRattle = 0;
  let suspPitch = 1.25;
  for (let i = 0; i < 4; i++) {
    const s = frame.corners[i].suspension;
    if (s.damperVelocity > maxDamperVel) {
      maxDamperVel = s.damperVelocity;
      suspPitch = s.pitch;
    }
    if (s.rattle > maxRattle) {
      maxRattle = s.rattle;
    }
  }
  frame.suspensionAggregate.damperVelocity = maxDamperVel;
  frame.suspensionAggregate.rattle = maxRattle;
  frame.suspensionAggregate.pitch = suspPitch;
  frame.suspensionAggregate.volume = suspCamGain;

  // Asphalt aggregate
  frame.asphaltAggregate.volume =
    0.25 *
    (fl.asphalt.volume + fr.asphalt.volume + rl.asphalt.volume + rr.asphalt.volume) *
    asphaltCamGain;
  frame.asphaltAggregate.pitch =
    0.25 * (fl.asphalt.pitch + fr.asphalt.pitch + rl.asphalt.pitch + rr.asphalt.pitch);
  frame.asphaltAggregate.timbre =
    0.25 * (fl.asphalt.timbre + fr.asphalt.timbre + rl.asphalt.timbre + rr.asphalt.timbre);
  frame.asphaltAggregate.speedNorm =
    0.25 *
    (fl.asphalt.speedNorm +
      fr.asphalt.speedNorm +
      rl.asphalt.speedNorm +
      rr.asphalt.speedNorm);
  frame.asphaltAggregate.slipChop = Math.max(
    fl.asphalt.slipVolumeChop,
    fr.asphalt.slipVolumeChop,
    rl.asphalt.slipVolumeChop,
    rr.asphalt.slipVolumeChop
  );

  // Debris aggregate
  frame.debrisAggregate.intensity = Math.max(
    fl.debris.intensity,
    fr.debris.intensity,
    rl.debris.intensity,
    rr.debris.intensity
  );
  frame.debrisAggregate.clickRateHz =
    fl.debris.clickRateHz +
    fr.debris.clickRateHz +
    rl.debris.clickRateHz +
    rr.debris.clickRateHz;
  frame.debrisAggregate.triggerClick =
    fl.debris.triggerClick ||
    fr.debris.triggerClick ||
    rl.debris.triggerClick ||
    rr.debris.triggerClick;

  // Brake aggregate
  let maxBrakeGain = 0;
  let maxBrakeVol = 0;
  let maxBrakeIntensity = 0;
  let maxTempGate = 0;
  let brakePitch = fl.brakes.pitch;
  let brakeTimbre = fl.brakes.timbre;
  for (let i = 0; i < 4; i++) {
    const b = frame.corners[i].brakes;
    if (b.effectiveGain >= maxBrakeGain) {
      maxBrakeGain = b.effectiveGain;
      brakePitch = b.pitch;
      brakeTimbre = b.timbre;
    }
    if (b.volume > maxBrakeVol) maxBrakeVol = b.volume;
    if (b.intensity > maxBrakeIntensity) maxBrakeIntensity = b.intensity;
    if (b.tempGate > maxTempGate) maxTempGate = b.tempGate;
  }
  frame.brakeAggregate.volume = maxBrakeVol;
  frame.brakeAggregate.effectiveGain = maxBrakeGain;
  frame.brakeAggregate.pitch = brakePitch;
  frame.brakeAggregate.timbre = brakeTimbre;
  frame.brakeAggregate.intensity = maxBrakeIntensity;
  frame.brakeAggregate.tempGate = maxTempGate;

  return frame;
}

/**
 * Populates a reusable `ContactAcousticsInput` from live `TelemetryData` with zero allocations.
 */
export function fillContactAcousticsInputFromTelemetry(
  telemetry: TelemetryData,
  profile: ContactAcousticsVehicleProfile,
  cameraMode: CameraMode,
  dt: number,
  target: ContactAcousticsInput
): ContactAcousticsInput {
  const speedMs = Math.max(0, telemetry.speedKmh / 3.6);
  target.brakePedal = clampSafe(telemetry.brake, 0, 1, 0);
  target.brakeBiasFront = telemetry.liveTuner
    ? clampSafe(telemetry.liveTuner.brakeBiasPct * 0.01, 0.3, 0.8, profile.brakeBiasFront)
    : profile.brakeBiasFront;
  target.cameraMode = cameraMode;
  target.dt = dt;

  for (let i = 0; i < 4; i++) {
    const c = target.corners[i];
    const isFront = i < 2;
    const axle = isFront ? profile.front : profile.rear;

    const slipRatio = telemetry.wheelSlipRatios?.[i] ?? telemetry.tireSlipRatio?.[i] ?? 0;
    const slipAngleDeg = telemetry.wheelSlipAnglesDeg?.[i] ?? 0;
    const circleNorm = telemetry.f12026?.circleFraction?.[i];
    const combinedNorm =
      typeof circleNorm === 'number' && Number.isFinite(circleNorm)
        ? Math.max(
            circleNorm,
            Math.hypot(slipRatio / 0.09, slipAngleDeg / Math.max(1, axle.optSlipAngleDeg))
          )
        : Math.max(
            (telemetry.tireSlipRatio?.[i] ?? 0) * 2.2,
            Math.hypot(slipRatio / 0.09, slipAngleDeg / Math.max(1, axle.optSlipAngleDeg))
          );

    c.ndSlip = clampSafe(combinedNorm, 0, 12, 0);
    c.slipRatio = clampSafe(slipRatio, -5, 5, 0);
    c.slipAngleDeg = clampSafe(slipAngleDeg, -60, 60, 0);
    c.loadN = clampSafe(telemetry.wheelLoadsN?.[i] ?? (isFront ? 3200 : 3800), 0, 25000, 3200);
    c.pressurePsi = clampSafe(
      telemetry.tirePressuresPsi?.[i] ??
        telemetry.tireOptimalPsi?.[i] ??
        axle.idealPressurePsi,
      10,
      60,
      axle.idealPressurePsi
    );

    const radiusM = Math.max(0.15, axle.tireRadiusM);
    c.groundSpeedMs = speedMs;
    c.angularSpeedRadS = (speedMs / radiusM) * (1 + slipRatio);
    c.suspensionTravelM = (telemetry.suspensionTravelMm?.[i] ?? 0) * 0.001;
    c.surface = telemetry.wheelSurfaces?.[i] ?? telemetry.surface ?? 'asphalt';
    c.brakeTempC = clampSafe(telemetry.brakeTempsC?.[i] ?? 320, 0, 1400, 320);
    c.tireDirtyLevel = clampSafe(telemetry.tireDirtyLevel?.[i] ?? 0, 0, 1, 0);
  }

  return target;
}

/**
 * Zero-Allocation WebAudio Synthesizer for Contact Patch, Suspension & Brake Acoustics.
 * Pre-allocates all oscillators, noise sources, filters, waveshapers, and gain nodes in `constructor`.
 */
export class ContactAcousticsRig {
  private readonly ctx: AudioContext;
  private profile: ContactAcousticsVehicleProfile;
  public readonly state: ContactAcousticsState;
  public readonly lastFrame: ContactAcousticsFrame;
  private readonly scratchInput: ContactAcousticsInput;
  private seededFromTelemetry = false;

  // Master interior/exterior filter & bus
  private readonly rigBus: GainNode;
  private readonly interiorFilter: BiquadFilterNode;

  // 3. Suspension Stroke Thump & High-G Chassis Rattle
  private readonly suspThumpOsc: OscillatorNode;
  private readonly suspThumpFilter: BiquadFilterNode;
  private readonly suspThumpGain: GainNode;

  private readonly suspRattleSource: AudioBufferSourceNode;
  private readonly suspRattleFilter: BiquadFilterNode;
  private readonly suspRattleGain: GainNode;

  // 4. Surface Rolling & Debris Clicks
  private readonly asphaltSource: AudioBufferSourceNode;
  private readonly asphaltFilter: BiquadFilterNode;
  private readonly asphaltGain: GainNode;

  private readonly debrisSource: AudioBufferSourceNode;
  private readonly debrisFilter: BiquadFilterNode;
  private readonly debrisGain: GainNode;

  // 5. High-Performance Metallic Brake Rotor Squeal
  private readonly brakePrimaryOsc: OscillatorNode;
  private readonly brakeHarmonicOsc: OscillatorNode;
  private readonly brakeHarmonicGain: GainNode;
  private readonly brakeFilter: BiquadFilterNode;
  private readonly brakeGain: GainNode;

  private disposed = false;

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    noiseBuffer?: AudioBuffer,
    profile: ContactAcousticsVehicleProfile = OPEN_WHEELER_ACOUSTICS_PROFILE
  ) {
    this.ctx = ctx;
    this.profile = profile;
    this.state = createContactAcousticsState();
    this.lastFrame = createContactAcousticsFrame();
    this.scratchInput = {
      corners: [
        {
          ndSlip: 0,
          slipRatio: 0,
          slipAngleDeg: 0,
          loadN: 3200,
          pressurePsi: 23,
          angularSpeedRadS: 0,
          groundSpeedMs: 0,
          suspensionTravelM: 0,
          surface: 'asphalt',
          brakeTempC: 300,
          tireDirtyLevel: 0,
        },
        {
          ndSlip: 0,
          slipRatio: 0,
          slipAngleDeg: 0,
          loadN: 3200,
          pressurePsi: 23,
          angularSpeedRadS: 0,
          groundSpeedMs: 0,
          suspensionTravelM: 0,
          surface: 'asphalt',
          brakeTempC: 300,
          tireDirtyLevel: 0,
        },
        {
          ndSlip: 0,
          slipRatio: 0,
          slipAngleDeg: 0,
          loadN: 3800,
          pressurePsi: 21,
          angularSpeedRadS: 0,
          groundSpeedMs: 0,
          suspensionTravelM: 0,
          surface: 'asphalt',
          brakeTempC: 300,
          tireDirtyLevel: 0,
        },
        {
          ndSlip: 0,
          slipRatio: 0,
          slipAngleDeg: 0,
          loadN: 3800,
          pressurePsi: 21,
          angularSpeedRadS: 0,
          groundSpeedMs: 0,
          suspensionTravelM: 0,
          surface: 'asphalt',
          brakeTempC: 300,
          tireDirtyLevel: 0,
        },
      ],
      brakePedal: 0,
      brakeBiasFront: profile.brakeBiasFront,
      cameraMode: 'chase',
      dt: 1 / 60,
    };

    const sharedNoise = noiseBuffer ?? ContactAcousticsRig.createNoiseBuffer(ctx, 2.0);

    // Master interior filter & rig bus
    this.interiorFilter = ctx.createBiquadFilter();
    this.interiorFilter.type = 'lowpass';
    this.interiorFilter.frequency.value = 14000;
    this.interiorFilter.Q.value = 0.7;

    this.rigBus = ctx.createGain();
    this.rigBus.gain.value = 1.0;
    this.interiorFilter.connect(this.rigBus);
    this.rigBus.connect(destination);

    // 3. Suspension Damper Thump & Mechanical Chassis Rattle
    this.suspThumpOsc = ctx.createOscillator();
    this.suspThumpOsc.type = 'sine';
    this.suspThumpOsc.frequency.value = 64;
    this.suspThumpFilter = ctx.createBiquadFilter();
    this.suspThumpFilter.type = 'lowpass';
    this.suspThumpFilter.frequency.value = 125;
    this.suspThumpGain = ctx.createGain();
    this.suspThumpGain.gain.value = 0;
    this.suspThumpOsc.connect(this.suspThumpFilter);
    this.suspThumpFilter.connect(this.suspThumpGain);
    this.suspThumpGain.connect(this.interiorFilter);
    this.suspThumpOsc.start();

    this.suspRattleSource = ctx.createBufferSource();
    this.suspRattleSource.buffer = sharedNoise;
    this.suspRattleSource.loop = true;
    this.suspRattleFilter = ctx.createBiquadFilter();
    this.suspRattleFilter.type = 'bandpass';
    this.suspRattleFilter.frequency.value = 2150;
    this.suspRattleFilter.Q.value = 3.6;
    this.suspRattleGain = ctx.createGain();
    this.suspRattleGain.gain.value = 0;
    this.suspRattleSource.connect(this.suspRattleFilter);
    this.suspRattleFilter.connect(this.suspRattleGain);
    this.suspRattleGain.connect(this.interiorFilter);
    this.suspRattleSource.start();

    // 4. Asphalt Roar & Wheel-Arch Debris Scatter
    this.asphaltSource = ctx.createBufferSource();
    this.asphaltSource.buffer = sharedNoise;
    this.asphaltSource.loop = true;
    this.asphaltFilter = ctx.createBiquadFilter();
    this.asphaltFilter.type = 'bandpass';
    this.asphaltFilter.frequency.value = 230;
    this.asphaltFilter.Q.value = 1.1;
    this.asphaltGain = ctx.createGain();
    this.asphaltGain.gain.value = 0;
    this.asphaltSource.connect(this.asphaltFilter);
    this.asphaltFilter.connect(this.asphaltGain);
    this.asphaltGain.connect(this.interiorFilter);
    this.asphaltSource.start();

    this.debrisSource = ctx.createBufferSource();
    this.debrisSource.buffer = sharedNoise;
    this.debrisSource.loop = true;
    this.debrisFilter = ctx.createBiquadFilter();
    this.debrisFilter.type = 'bandpass';
    this.debrisFilter.frequency.value = 3400;
    this.debrisFilter.Q.value = 4.5;
    this.debrisGain = ctx.createGain();
    this.debrisGain.gain.value = 0;
    this.debrisSource.connect(this.debrisFilter);
    this.debrisFilter.connect(this.debrisGain);
    this.debrisGain.connect(this.interiorFilter);
    this.debrisSource.start();

    // 5. High-Performance Brake Rotor Squeal Voice
    this.brakePrimaryOsc = ctx.createOscillator();
    this.brakePrimaryOsc.type = 'sine';
    this.brakePrimaryOsc.frequency.value = 3650;
    this.brakeHarmonicOsc = ctx.createOscillator();
    this.brakeHarmonicOsc.type = 'triangle';
    this.brakeHarmonicOsc.frequency.value = 5180;
    this.brakeHarmonicGain = ctx.createGain();
    this.brakeHarmonicGain.gain.value = 0.25;
    this.brakeFilter = ctx.createBiquadFilter();
    this.brakeFilter.type = 'bandpass';
    this.brakeFilter.frequency.value = 3800;
    this.brakeFilter.Q.value = 11.0;
    this.brakeGain = ctx.createGain();
    this.brakeGain.gain.value = 0;

    this.brakePrimaryOsc.connect(this.brakeFilter);
    this.brakeHarmonicOsc.connect(this.brakeHarmonicGain);
    this.brakeHarmonicGain.connect(this.brakeFilter);
    this.brakeFilter.connect(this.brakeGain);
    this.brakeGain.connect(this.interiorFilter);
    this.brakePrimaryOsc.start();
    this.brakeHarmonicOsc.start();
  }

  private static createNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.05;
    }
    return buffer;
  }

  public setProfile(profile: ContactAcousticsVehicleProfile): void {
    this.profile = profile;
  }

  public getProfile(): ContactAcousticsVehicleProfile {
    return this.profile;
  }

  public reset(): void {
    this.seededFromTelemetry = false;
    resetContactAcousticsState(this.state);
  }

  /**
   * Evaluates contact acoustics from raw telemetry and updates all WebAudio synthesis nodes.
   */
  public updateFromTelemetry(
    telemetry: TelemetryData,
    cameraMode: CameraMode,
    dtSeconds: number
  ): ContactAcousticsFrame {
    if (!this.seededFromTelemetry) {
      for (let i = 0; i < 4; i++) {
        this.state.corners[i].travelM = (telemetry.suspensionTravelMm?.[i] ?? 0) * 0.001;
        const loadN = telemetry.wheelLoadsN?.[i] ?? (i < 2 ? 3200 : 3800);
        this.state.corners[i].loadN = loadN;
        this.state.corners[i].smoothedLoadN = loadN;
      }
      this.seededFromTelemetry = true;
    }

    fillContactAcousticsInputFromTelemetry(
      telemetry,
      this.profile,
      cameraMode,
      dtSeconds,
      this.scratchInput
    );
    return this.update(this.scratchInput);
  }

  /**
   * Evaluates `input` and schedules zero-allocation parameter updates on all WebAudio nodes.
   */
  public update(input: ContactAcousticsInput): ContactAcousticsFrame {
    const frame = evaluateContactAcoustics(input, this.state, this.profile, this.lastFrame);
    if (this.disposed) return frame;

    const now = this.ctx.currentTime;
    const tau = 0.022;

    // Master interior/exterior acoustic filtering
    const insideMix = frame.corners[0].brakes.insideMix;
    const interiorCutoffHz = mapRange(insideMix, 0.0, 1.0, 14000, 3800, true);
    this.interiorFilter.frequency.setTargetAtTime(interiorCutoffHz, now, 0.03);

    // 3. Suspension Stroke Thump & High-G Chassis Rattle
    const thumpFreqHz = clampSafe(52 * frame.suspensionAggregate.pitch, 45, 95, 64);
    this.suspThumpOsc.frequency.setTargetAtTime(thumpFreqHz, now, 0.018);
    this.suspThumpGain.gain.setTargetAtTime(
      frame.suspensionAggregate.damperVelocity *
        frame.suspensionAggregate.volume *
        0.055,
      now,
      0.018
    );
    this.suspRattleGain.gain.setTargetAtTime(
      frame.suspensionAggregate.rattle * frame.suspensionAggregate.volume * 0.048,
      now,
      0.015
    );

    // 4. Asphalt Rolling Roar & Debris Clicks
    const asphaltCutoffHz = clampSafe(
      180 + frame.asphaltAggregate.timbre * 220 + (1.0 - frame.asphaltAggregate.pitch) * 140,
      140,
      520,
      230
    );
    this.asphaltFilter.frequency.setTargetAtTime(asphaltCutoffHz, now, 0.03);
    this.asphaltGain.gain.setTargetAtTime(frame.asphaltAggregate.volume * 0.042, now, 0.025);

    if (frame.debrisAggregate.triggerClick) {
      const clickPeak = clampSafe(frame.debrisAggregate.intensity * 0.045, 0.004, 0.05, 0.015);
      this.debrisGain.gain.setValueAtTime(clickPeak, now);
      this.debrisGain.gain.setTargetAtTime(0, now + 0.004, 0.008);
    }

    // 5. High-Performance Brake Squeal
    const brakeFreqHz = clampSafe(
      3400 + frame.brakeAggregate.pitch * 1200,
      2600,
      5200,
      3650
    );
    this.brakePrimaryOsc.frequency.setTargetAtTime(brakeFreqHz, now, tau);
    this.brakeHarmonicOsc.frequency.setTargetAtTime(brakeFreqHz * 1.414, now, tau);
    this.brakeHarmonicGain.gain.setTargetAtTime(
      0.15 + frame.brakeAggregate.timbre * 0.35,
      now,
      tau
    );
    this.brakeFilter.frequency.setTargetAtTime(brakeFreqHz, now, tau);
    this.brakeGain.gain.setTargetAtTime(frame.brakeAggregate.effectiveGain * 0.026, now, tau);

    return frame;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const stopNode = (node: AudioScheduledSourceNode) => {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // Ignore if already stopped
      }
    };
    stopNode(this.suspThumpOsc);
    stopNode(this.suspRattleSource);
    stopNode(this.asphaltSource);
    stopNode(this.debrisSource);
    stopNode(this.brakePrimaryOsc);
    stopNode(this.brakeHarmonicOsc);
    try {
      this.interiorFilter.disconnect();
      this.rigBus.disconnect();
    } catch {
      // Ignore
    }
  }
}
