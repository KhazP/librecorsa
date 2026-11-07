/**
 * Wheel force feedback through the local bridge.
 *
 * A browser cannot play DirectInput force feedback, so `npm run ffb` runs a small bridge on the PC
 * (scripts/ffb-bridge.ts → FfbHelper.exe) that owns the wheel's constant-force effect, as a native sim does. This
 * client streams one packet per frame over a localhost WebSocket: the shaped rim force (the physics' steering torque
 * with the player's gain, minimum force and the soft lock past the car's steering lock), the frame's 500 Hz physics
 * samples, plus kerb / ABS vibration levels. The helper plays the samples out at 500 Hz, synthesises the vibrations,
 * rate-limits, and fades to zero by itself when packets stop (paused tab, closed sim).
 *
 * In-browser WebHID force feedback does the same here: each frame's samples are played out to the wheel over the next
 * frame on a 2 ms timer (as fast as the browser's timers and the wheel's writes allow), with the vibrations
 * synthesised on that clock rather than at the frame rate.
 */
import type { CarTelemetry } from "@/types/f1";
import { CAR_WHEEL_LOCK_DEG, carWheelLockDeg, findPad, type PadLike, wheelRimAngleDeg, type WheelSettings } from "./device-input";
import { WebHidFfb } from "./webhid-ffb";

export const FFB_BRIDGE_PORT = 18500;
const BRIDGE_URL = `ws://127.0.0.1:${FFB_BRIDGE_PORT}`;
const RECONNECT_MS = 5000;
/** Degrees past the car's steering lock over which the soft-lock spring builds to full force */
const SOFT_LOCK_RAMP_DEG = 12;
/** Below this the minimum force eases in, so the rim does not notch across the centre */
const MIN_FORCE_EASE = 0.02;

/** "replaced": another tab took the bridge over; this one stays off it until FFB is switched off and on again */
export type FfbConnection = "off" | "connecting" | "connected" | "unreachable" | "replaced";

export interface FfbStatus {
  connection: FfbConnection;
  /** Wheel the bridge drives, once it reports one */
  device: string | null;
  /** Bridge-side problem (no force-feedback wheel, another program owns it, …) */
  error: string | null;
}

/**
 * Steering torque → rim force (+ = right): gain, then minimum force.
 * When `speedKmh` is provided (live driving), minimum force is gated off at standstill (≤ 1 km/h) and ramps in up to
 * 6 km/h (`clamp((speedKmh - 1) * 0.2, 0, 1)`) so a parked direct-drive wheel never jumps or oscillates at rest.
 */
export function shapeFfbForce(
  torque: number,
  wheel: Pick<WheelSettings, "ffbGain" | "ffbMinForce">,
  speedKmh?: number
): number {
  const f = torque * wheel.ffbGain;
  const a = Math.abs(f);
  const speedGate =
    speedKmh !== undefined && Number.isFinite(speedKmh) ? Math.max(0, Math.min(1, (speedKmh - 1.0) * 0.2)) : 1;
  const minForce = wheel.ffbMinForce * speedGate;
  if (minForce <= 0 || a === 0) return f;
  const u = Math.min(1, a / MIN_FORCE_EASE);
  return Math.sign(f) * (minForce * u * u * (3 - 2 * u) + (1 - minForce) * a);
}

/** Soft-lock spring (+ = right) once the rim turns past the car's steering lock: the end stop a real rack has */
export function softLockForce(rimDeg: number, carLockDeg: number = CAR_WHEEL_LOCK_DEG): number {
  const lock = carLockDeg > 0 ? carLockDeg : CAR_WHEEL_LOCK_DEG;
  const over = Math.abs(rimDeg) - lock / 2;
  return over > 0 ? -Math.sign(rimDeg) * Math.min(1, over / SOFT_LOCK_RAMP_DEG) : 0;
}

/** The gain and minimum force for a car: its own (set from the meter) or the global ones */
export function ffbStrengthFor(
  wheel: Pick<WheelSettings, "ffbGain" | "ffbMinForce" | "ffbPerCar">,
  vehicle: string | undefined
): Pick<WheelSettings, "ffbGain" | "ffbMinForce"> {
  const own = vehicle ? wheel.ffbPerCar?.[vehicle] : undefined;
  return own ? { ffbGain: own.gain, ffbMinForce: own.minForce } : { ffbGain: wheel.ffbGain, ffbMinForce: wheel.ffbMinForce };
}

/** Direction test, as the bridge helper plays it: a held pull each way (s, s between, share of full force) */
const TEST_PULL_S = 1.0;
const TEST_GAP_S = 0.3;
const TEST_LEVEL = 0.25;
export const DIRECTION_TEST_S = 2 * TEST_PULL_S + TEST_GAP_S;
const smoothStep = (e0: number, e1: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
};
const pull = (x: number) => smoothStep(0, 0.2, x) * (1 - smoothStep(0.8, 1, x));

/**
 * Direction-test force (+ = right) `tS` seconds in: right then left, the other way round when inverted (as the game's
 * forces will be). Zero before the start and once {@link DIRECTION_TEST_S} has passed.
 */
export function directionTestForce(tS: number, invert: boolean): number {
  const sign = invert ? -1 : 1;
  const second = TEST_PULL_S + TEST_GAP_S;
  if (tS < 0 || tS >= DIRECTION_TEST_S) return 0;
  if (tS < TEST_PULL_S) return sign * TEST_LEVEL * pull(tS / TEST_PULL_S);
  if (tS < second) return 0;
  return -sign * TEST_LEVEL * pull((tS - second) / TEST_PULL_S);
}
const TEST_STEP_MS = 10;
/** If WebHID frame updates stop arriving (hidden tab, stalled loop), zero the wheel's constant-force effect after 150 ms */
export const HID_WATCHDOG_MS = 150;
/** WebHID playback timer (ms); the physics samples it plays are 2 ms apart */
const HID_TICK_MS = 2;
const PHYSICS_SAMPLE_MS = 2;
/** Vibrations mixed into the WebHID force (no separate channel): kerb buzz, ABS pulse, tyre slide, grass/gravel rumble, road bumps */
const HID_KERB_HZ = 40;
const HID_KERB_AMPLITUDE = 0.12;
const HID_ABS_HZ = 25;
const HID_ABS_AMPLITUDE = 0.1;
const HID_SLIDE_HZ = 27;
const HID_SLIDE_AMPLITUDE = 0.08;
const HID_ROUGH_HZ = 18;
const HID_ROUGH_AMPLITUDE = 0.12;
const HID_BUMP_HZ = 22;
const HID_BUMP_AMPLITUDE = 0.1;
const clockMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Rim speed (deg/s) at which the damper reaches its full force */
const DAMPING_FULL_DEG_S = 600;
/** Share of full force the damper may add at most */
const DAMPING_MAX_FORCE = 0.35;
/** Force history for the gain suggestion: about a lap at 60 fps */
const METER_WINDOW = 4800;
/** Histogram bins for the meter's percentile: 0.01 wide, the last one catching everything from 2 up */
const METER_BINS = 201;

/** 6-tap finite impulse response (FIR) low-pass kernel for steering rack self-aligning torque (sum = 1.0) */
export const RACK_SAT_FIR_TAPS = [
  0.1295867,
  0.2311436,
  0.2582509,
  0.1923936,
  0.1156718,
  0.0729534,
] as const;

/** Exponential moving average coefficient for axle shock velocities and rear sideslip tangent */
export const RACK_SAT_EMA_ALPHA = 0.030;
/** Digressive vertical load sensitivity of peak self-aligning torque (negative reduces normalized peak under compression) */
export const RACK_SAT_Q_DZ2 = -0.2;
/** Nominal single-wheel vertical load reference (N) */
export const RACK_SAT_FZ_NOM_N = 3000.0;
/** Base axle vertical shock damping coefficient (Ns/m) */
export const RACK_SAT_CZ_BASE_NSM = 2000.0;
/** Axle shock velocity threshold above which extreme compression spikes are attenuated (m/s) */
export const RACK_SAT_SHOCK_VEL_CAP_MS = 2.5;
/** Hyperbolic attenuation rate for extreme shock velocities above the cap (s/m) */
export const RACK_SAT_SHOCK_ATTEN_RATE = 0.45;
/** Conversion scale from normalised axle vertical damping load to direct steering rack bump torque */
export const RACK_SAT_BUMP_TORQUE_SCALE = 0.08;
/** Minimum activation speed for Pacejka self-aligning torque synthesis (m/s) */
export const RACK_SAT_MIN_SPEED_MS = 5.0;
/** Rear oversteer Pacejka SAT deadband offset (~1.7 deg in radians) */
export const RACK_SAT_OVERSTEER_OFFSET_RAD = 0.030;
/** Front understeer Pacejka SAT deadband offset (~2.3 deg in radians) */
export const RACK_SAT_UNDERSTEER_OFFSET_RAD = 0.040;
/** Rear sideslip soft-ramp threshold below which oversteer SAT eases in linearly (rad) */
export const RACK_SAT_OVERSTEER_SOFT_RAMP_RAD = 0.015;
/** Turn-entry yaw-rate threshold below which front understeer counter-torque is halved (rad/s) */
export const RACK_SAT_UNDERSTEER_YAW_GATE_RAD_S = 0.1;
/** Front understeer counter-torque shaping scale */
export const RACK_SAT_UNDERSTEER_SCALE = 0.65;
/** Symmetric saturation clamp for combined self-aligning torque before FIR filtering */
export const RACK_SAT_MAX_TORQUE = 0.5;
/** Resultant horizontal acceleration threshold above which crash torque suppression engages (g) */
export const RACK_SAT_HIGH_IMPACT_G = 10.0;
/** Multiplier applied to steering rack SAT torque during >10g high-impact collisions */
export const RACK_SAT_HIGH_IMPACT_ATTEN = 0.25;
/** Reference SAT torque corresponding to 100% shaker intensity */
export const RACK_SAT_SHAKER_REF_TORQUE = 0.8;
/** Default kinematic wheelbase used when not specified by the vehicle telemetry (m) */
export const RACK_SAT_DEFAULT_WHEELBASE_M = 2.7;
/** Reference road-wheel steering lock used when converting normalised [-1..1] steering input (rad) */
const MAX_ROAD_STEER_RAD = 0.35;

const OVERSTEER_B = 2.5;
const OVERSTEER_C = 1.85;
const OVERSTEER_D_BASE = 0.85;
const OVERSTEER_E = -0.88;

const UNDERSTEER_B = 3.0;
const UNDERSTEER_C = 1.75;
const UNDERSTEER_D_BASE = 0.70;
const UNDERSTEER_E = -0.55;

export interface RackSatState {
  prevSuspMm: [number, number, number, number];
  hasPrevSusp: boolean;
  firstBump: boolean;
  filteredVelFrontMs: number;
  filteredVelRearMs: number;
  firstRearFrame: boolean;
  filteredRearSideslip: number;
  firHistory: Float32Array;
  firIndex: number;
}

export interface RackSatStepInput {
  /** Forward speed (m/s); if omitted, derived from `speedKmh / 3.6` */
  speedMs?: number;
  /** Speed (km/h); fallback when `speedMs` is omitted */
  speedKmh?: number;
  /** Frame time step (s) used to differentiate `suspensionTravelMm` into m/s shock velocities */
  dtS?: number;
  /** Per-corner suspension compression [FL, FR, RL, RR] (mm) */
  suspensionTravelMm?: readonly [number, number, number, number] | readonly number[];
  /** Optional direct per-corner shock velocity [FL, FR, RL, RR] (m/s, + = compression) */
  shockVelMs?: readonly [number, number, number, number] | readonly number[];
  /** Chassis local lateral velocity v_lat (m/s, + = right) */
  lateralVelMs?: number;
  /** Chassis local longitudinal velocity v_lon (m/s, + = forward) */
  longitudinalVelMs?: number;
  /** Rear axle slip angle (rad), used when local chassis velocities are not supplied */
  rearSlipAngleRad?: number;
  /** Rear axle slip angle (deg), fallback when `rearSlipAngleRad` is not supplied */
  rearSlipAngleDeg?: number;
  /** Per-corner slip angles [FL, FR, RL, RR] (deg) */
  wheelSlipAnglesDeg?: readonly number[];
  /** Front road-wheel steering angle delta_road (rad, + = right) */
  roadSteerRad?: number;
  /** Normalised steering angle -1..1 (+ = right), fallback when `roadSteerRad` is not supplied */
  steering?: number;
  /** Front slip angle (rad), fallback when kinematic steering inputs are not supplied */
  frontSlipAngleRad?: number;
  /** Front slip angle (deg), fallback when `frontSlipAngleRad` is not supplied */
  frontSlipAngleDeg?: number;
  /** Chassis yaw rate psi_dot (rad/s, + = turning right) */
  yawRateRadS?: number;
  /** Vehicle wheelbase L (m, defaults to 2.7 m) */
  wheelbaseM?: number;
  /** Lateral acceleration (g) */
  lateralG?: number;
  /** Longitudinal acceleration (g) */
  longitudinalG?: number;
  /** Vertical bump damping gain k_bumps (defaults to 1.0) */
  bumpsGain?: number;
  /** Rear oversteer SAT gain k_oversteer (defaults to 1.0) */
  oversteerGain?: number;
  /** Front understeer SAT gain k_understeer (defaults to 1.0) */
  understeerGain?: number;
}

export interface RackSatStepOutput {
  /** EMA-filtered front axle shock velocity (m/s, + = compression) */
  filteredVelFrontMs: number;
  /** EMA-filtered rear axle shock velocity (m/s, + = compression) */
  filteredVelRearMs: number;
  /** High-velocity shock spike attenuation factor (0..1, 1 when max|v| <= 2.5 m/s) */
  shockAttenuation: number;
  /** Front axle vertical damping load change Delta Fz,front (N) */
  deltaFzFrontN: number;
  /** Rear axle vertical damping load change Delta Fz,rear (N) */
  deltaFzRearN: number;
  /** Normalised front vertical load change Delta fz,front = Delta Fz,front / 3000 */
  dfzFront: number;
  /** Normalised rear vertical load change Delta fz,rear = Delta Fz,rear / 3000 */
  dfzRear: number;
  /** Direct vertical bump torque term added to the steering rack */
  bumpTorque: number;
  /** EMA-filtered rear sideslip tangent r (rad) */
  rearSideslipRad: number;
  /** Front kinematic slip angle alpha_f (rad) */
  frontSlipAngleRad: number;
  /** Vertical-load-modulated rear Pacejka peak coefficient D_o */
  rearPeakD: number;
  /** Vertical-load-modulated front Pacejka peak coefficient D_u */
  frontPeakD: number;
  /** Raw rear Pacejka Magic Formula output sa before deadband shaping */
  rearPacejkaSa: number;
  /** Raw front Pacejka Magic Formula output sa_u before deadband shaping */
  frontPacejkaSa: number;
  /** Shaped rear oversteer self-aligning torque tau_over */
  oversteerTorque: number;
  /** Shaped front understeer counter-torque tau_under */
  understeerTorque: number;
  /** Combined clamped SAT torque tau_sat = clamp(tau_over - tau_under, -0.5, 0.5), attenuated on >10g impact */
  rawSatTorque: number;
  /** 6-tap FIR filtered SAT torque, attenuated on >10g impact */
  filteredSatTorque: number;
  /** Alias for `filteredSatTorque` */
  satTorque: number;
  /** Combined rack torque addition (`filteredSatTorque + bumpTorque`) */
  totalAddedTorque: number;
  /** Resultant horizontal acceleration sqrt(gLat^2 + gLon^2) (g) */
  resultantG: number;
  /** True when `resultantG > 10.0` g */
  highImpactActive: boolean;
  /** Oversteer shaker intensity (%, 0..100; 0 during high impact or below speed threshold) */
  oversteerIntensityPct: number;
  /** Understeer shaker intensity (%, 0..100; 0 during high impact or below speed threshold) */
  understeerIntensityPct: number;
}

/** Evaluates the Pacejka Magic Formula with inner atan argument clamped to [-pi/2, pi/2] */
export function evaluatePacejkaSat(slipRad: number, B: number, C: number, D: number, E: number): number {
  const bs = B * slipRad;
  const x = bs - E * (bs - Math.atan(bs));
  const halfPi = Math.PI * 0.5;
  const arg = Math.max(-halfPi, Math.min(halfPi, C * Math.atan(x)));
  return D * Math.sin(arg);
}

export function createRackSatState(): RackSatState {
  return {
    prevSuspMm: [0, 0, 0, 0],
    hasPrevSusp: false,
    firstBump: true,
    filteredVelFrontMs: 0,
    filteredVelRearMs: 0,
    firstRearFrame: true,
    filteredRearSideslip: 0,
    firHistory: new Float32Array(RACK_SAT_FIR_TAPS.length),
    firIndex: 0,
  };
}

export function resetRackSatState(state: RackSatState): void {
  state.prevSuspMm[0] = 0;
  state.prevSuspMm[1] = 0;
  state.prevSuspMm[2] = 0;
  state.prevSuspMm[3] = 0;
  state.hasPrevSusp = false;
  state.firstBump = true;
  state.filteredVelFrontMs = 0;
  state.filteredVelRearMs = 0;
  state.firstRearFrame = true;
  state.filteredRearSideslip = 0;
  state.firHistory.fill(0);
  state.firIndex = 0;
}

export function createRackSatOutput(): RackSatStepOutput {
  return {
    filteredVelFrontMs: 0,
    filteredVelRearMs: 0,
    shockAttenuation: 1,
    deltaFzFrontN: 0,
    deltaFzRearN: 0,
    dfzFront: 0,
    dfzRear: 0,
    bumpTorque: 0,
    rearSideslipRad: 0,
    frontSlipAngleRad: 0,
    rearPeakD: OVERSTEER_D_BASE,
    frontPeakD: UNDERSTEER_D_BASE,
    rearPacejkaSa: 0,
    frontPacejkaSa: 0,
    oversteerTorque: 0,
    understeerTorque: 0,
    rawSatTorque: 0,
    filteredSatTorque: 0,
    satTorque: 0,
    totalAddedTorque: 0,
    resultantG: 0,
    highImpactActive: false,
    oversteerIntensityPct: 0,
    understeerIntensityPct: 0,
  };
}

/**
 * Pure step evaluation for the dual-Pacejka steering rack self-aligning torque (SAT), axle vertical shock load
 * modulation, 6-tap FIR smoothing filter, and >10g high-impact crash torque suppression.
 */
export function stepRackSat(
  input: RackSatStepInput,
  state: RackSatState = createRackSatState(),
  out: RackSatStepOutput = createRackSatOutput()
): RackSatStepOutput {
  const gLat = typeof input.lateralG === "number" && Number.isFinite(input.lateralG) ? Math.abs(input.lateralG) : 0;
  const gLon =
    typeof input.longitudinalG === "number" && Number.isFinite(input.longitudinalG) ? Math.abs(input.longitudinalG) : 0;
  const resultantG = Math.hypot(gLat, gLon);
  const highImpactActive = resultantG > RACK_SAT_HIGH_IMPACT_G;

  const speedMs =
    typeof input.speedMs === "number" && Number.isFinite(input.speedMs) && input.speedMs !== 0
      ? Math.abs(input.speedMs)
      : typeof input.speedKmh === "number" && Number.isFinite(input.speedKmh)
        ? Math.abs(input.speedKmh) / 3.6
        : 0;
  const dtS = typeof input.dtS === "number" && Number.isFinite(input.dtS) && input.dtS > 0 ? input.dtS : 0;

  // Differentiate per-corner suspension travel (mm -> m/s) or read direct shock velocities
  let hasVelSample = false;
  let vFL = 0;
  let vFR = 0;
  let vRL = 0;
  let vRR = 0;
  const shockVel = input.shockVelMs;
  const susp = input.suspensionTravelMm;
  if (
    shockVel &&
    shockVel.length >= 4 &&
    Number.isFinite(shockVel[0]) &&
    Number.isFinite(shockVel[1]) &&
    Number.isFinite(shockVel[2]) &&
    Number.isFinite(shockVel[3])
  ) {
    vFL = shockVel[0];
    vFR = shockVel[1];
    vRL = shockVel[2];
    vRR = shockVel[3];
    hasVelSample = true;
  } else if (
    susp &&
    susp.length >= 4 &&
    Number.isFinite(susp[0]) &&
    Number.isFinite(susp[1]) &&
    Number.isFinite(susp[2]) &&
    Number.isFinite(susp[3])
  ) {
    if (state.hasPrevSusp && dtS > 0) {
      const invDtMmToM = 1e-3 / dtS;
      vFL = (susp[0] - state.prevSuspMm[0]) * invDtMmToM;
      vFR = (susp[1] - state.prevSuspMm[1]) * invDtMmToM;
      vRL = (susp[2] - state.prevSuspMm[2]) * invDtMmToM;
      vRR = (susp[3] - state.prevSuspMm[3]) * invDtMmToM;
      hasVelSample = true;
    }
    state.prevSuspMm[0] = susp[0];
    state.prevSuspMm[1] = susp[1];
    state.prevSuspMm[2] = susp[2];
    state.prevSuspMm[3] = susp[3];
    state.hasPrevSusp = true;
  }

  const rawBumpsGain =
    typeof input.bumpsGain === "number" && Number.isFinite(input.bumpsGain) ? Math.max(0, input.bumpsGain) : 1.0;
  const effectiveBumpsGain = highImpactActive ? 0 : rawBumpsGain;

  let shockAttenuation = 1;
  let deltaFzFrontN = 0;
  let deltaFzRearN = 0;
  let dfzFront = 0;
  let dfzRear = 0;
  let bumpTorque = 0;

  if (speedMs > RACK_SAT_MIN_SPEED_MS && effectiveBumpsGain > 0 && hasVelSample) {
    const avgFront = (vFL + vFR) * 0.5;
    const avgRear = (vRL + vRR) * 0.5;
    if (state.firstBump) {
      state.filteredVelFrontMs = avgFront;
      state.filteredVelRearMs = avgRear;
      state.firstBump = false;
    } else {
      const oneMinusAlpha = 1.0 - RACK_SAT_EMA_ALPHA;
      state.filteredVelFrontMs = RACK_SAT_EMA_ALPHA * avgFront + oneMinusAlpha * state.filteredVelFrontMs;
      state.filteredVelRearMs = RACK_SAT_EMA_ALPHA * avgRear + oneMinusAlpha * state.filteredVelRearMs;
    }

    deltaFzFrontN = RACK_SAT_CZ_BASE_NSM * state.filteredVelFrontMs * effectiveBumpsGain;
    deltaFzRearN = RACK_SAT_CZ_BASE_NSM * state.filteredVelRearMs * effectiveBumpsGain;

    const maxVel = Math.max(Math.abs(state.filteredVelFrontMs), Math.abs(state.filteredVelRearMs));
    if (maxVel > RACK_SAT_SHOCK_VEL_CAP_MS) {
      const excess = maxVel - RACK_SAT_SHOCK_VEL_CAP_MS;
      shockAttenuation = 1.0 / (1.0 + excess * RACK_SAT_SHOCK_ATTEN_RATE);
      deltaFzFrontN *= shockAttenuation;
      deltaFzRearN *= shockAttenuation;
    }

    dfzFront = deltaFzFrontN / RACK_SAT_FZ_NOM_N;
    dfzRear = deltaFzRearN / RACK_SAT_FZ_NOM_N;
    bumpTorque = (dfzFront + dfzRear) * RACK_SAT_BUMP_TORQUE_SCALE;
  }

  let rearSideslipRad = 0;
  let frontSlipAngleRad = 0;
  let rearPeakD = OVERSTEER_D_BASE * (1.0 + RACK_SAT_Q_DZ2 * dfzRear);
  let frontPeakD = UNDERSTEER_D_BASE * (1.0 + RACK_SAT_Q_DZ2 * dfzFront);
  let rearPacejkaSa = 0;
  let frontPacejkaSa = 0;
  let oversteerTorque = 0;
  let understeerTorque = 0;
  let combinedSat = 0;
  let oversteerIntensityPct = 0;
  let understeerIntensityPct = 0;

  if (speedMs > RACK_SAT_MIN_SPEED_MS) {
    // 1. Rear Oversteer SAT
    let rRaw = 0;
    if (typeof input.lateralVelMs === "number" && Number.isFinite(input.lateralVelMs)) {
      const vLonAbs =
        typeof input.longitudinalVelMs === "number" &&
        Number.isFinite(input.longitudinalVelMs) &&
        Math.abs(input.longitudinalVelMs) > 1e-3
          ? Math.abs(input.longitudinalVelMs)
          : speedMs;
      rRaw = vLonAbs > 1e-3 ? input.lateralVelMs / vLonAbs : 0;
    } else if (typeof input.rearSlipAngleRad === "number" && Number.isFinite(input.rearSlipAngleRad)) {
      rRaw = input.rearSlipAngleRad;
    } else if (typeof input.rearSlipAngleDeg === "number" && Number.isFinite(input.rearSlipAngleDeg)) {
      rRaw = (input.rearSlipAngleDeg * Math.PI) / 180;
    } else if (
      input.wheelSlipAnglesDeg &&
      input.wheelSlipAnglesDeg.length >= 4 &&
      Number.isFinite(input.wheelSlipAnglesDeg[2]) &&
      Number.isFinite(input.wheelSlipAnglesDeg[3])
    ) {
      rRaw = ((input.wheelSlipAnglesDeg[2] + input.wheelSlipAnglesDeg[3]) * 0.5 * Math.PI) / 180;
    }

    if (state.firstRearFrame) {
      state.filteredRearSideslip = rRaw;
      state.firstRearFrame = false;
    } else {
      state.filteredRearSideslip =
        RACK_SAT_EMA_ALPHA * rRaw + (1.0 - RACK_SAT_EMA_ALPHA) * state.filteredRearSideslip;
    }
    rearSideslipRad = state.filteredRearSideslip;
    const absR = Math.abs(rearSideslipRad);

    const oversteerGain =
      typeof input.oversteerGain === "number" && Number.isFinite(input.oversteerGain)
        ? Math.max(0, input.oversteerGain)
        : 1.0;
    const understeerGain =
      typeof input.understeerGain === "number" && Number.isFinite(input.understeerGain)
        ? Math.max(0, input.understeerGain)
        : 1.0;

    rearPeakD = OVERSTEER_D_BASE * (1.0 + RACK_SAT_Q_DZ2 * dfzRear);
    rearPacejkaSa = evaluatePacejkaSat(rearSideslipRad, OVERSTEER_B, OVERSTEER_C, rearPeakD, OVERSTEER_E);
    const ramp = absR < RACK_SAT_OVERSTEER_SOFT_RAMP_RAD ? absR / RACK_SAT_OVERSTEER_SOFT_RAMP_RAD : 1.0;
    const absSa = Math.abs(rearPacejkaSa);
    if (absSa > RACK_SAT_OVERSTEER_OFFSET_RAD) {
      const saExcess = rearPacejkaSa - Math.sign(rearPacejkaSa) * RACK_SAT_OVERSTEER_OFFSET_RAD;
      oversteerTorque = saExcess * (2.0 - absSa) * oversteerGain * ramp;
    }

    // 2. Front Understeer SAT
    if (understeerGain > 0) {
      const wheelbaseM =
        typeof input.wheelbaseM === "number" && Number.isFinite(input.wheelbaseM) && input.wheelbaseM > 0
          ? input.wheelbaseM
          : RACK_SAT_DEFAULT_WHEELBASE_M;
      const yawRateRadS =
        typeof input.yawRateRadS === "number" && Number.isFinite(input.yawRateRadS) ? input.yawRateRadS : 0;

      const hasKinematicSteer =
        typeof input.roadSteerRad === "number" ||
        typeof input.yawRateRadS === "number" ||
        (typeof input.steering === "number" &&
          input.frontSlipAngleRad === undefined &&
          input.frontSlipAngleDeg === undefined);

      if (hasKinematicSteer) {
        const deltaRoad =
          typeof input.roadSteerRad === "number" && Number.isFinite(input.roadSteerRad)
            ? input.roadSteerRad
            : typeof input.steering === "number" && Number.isFinite(input.steering)
              ? input.steering * MAX_ROAD_STEER_RAD
              : 0;
        frontSlipAngleRad = deltaRoad - (yawRateRadS * (wheelbaseM * 0.5)) / speedMs;
      } else if (typeof input.frontSlipAngleRad === "number" && Number.isFinite(input.frontSlipAngleRad)) {
        frontSlipAngleRad = input.frontSlipAngleRad;
      } else if (typeof input.frontSlipAngleDeg === "number" && Number.isFinite(input.frontSlipAngleDeg)) {
        frontSlipAngleRad = (input.frontSlipAngleDeg * Math.PI) / 180;
      }

      frontPeakD = UNDERSTEER_D_BASE * (1.0 + RACK_SAT_Q_DZ2 * dfzFront);
      frontPacejkaSa = evaluatePacejkaSat(frontSlipAngleRad, UNDERSTEER_B, UNDERSTEER_C, frontPeakD, UNDERSTEER_E);
      const absSaU = Math.abs(frontPacejkaSa);
      if (absSaU > RACK_SAT_UNDERSTEER_OFFSET_RAD) {
        const saUExcess = frontPacejkaSa - Math.sign(frontPacejkaSa) * RACK_SAT_UNDERSTEER_OFFSET_RAD;
        const entryRamp = Math.abs(yawRateRadS) < RACK_SAT_UNDERSTEER_YAW_GATE_RAD_S ? 0.5 : 1.0;
        understeerTorque = saUExcess * (2.0 - absSaU) * understeerGain * RACK_SAT_UNDERSTEER_SCALE * entryRamp;
      }
    }

    combinedSat = Math.max(
      -RACK_SAT_MAX_TORQUE,
      Math.min(RACK_SAT_MAX_TORQUE, oversteerTorque - understeerTorque)
    );

    if (!highImpactActive) {
      oversteerIntensityPct = Math.min(
        100,
        Math.max(0, (Math.abs(oversteerTorque) / RACK_SAT_SHAKER_REF_TORQUE) * 100)
      );
      understeerIntensityPct = Math.min(
        100,
        Math.max(0, (Math.abs(understeerTorque) / RACK_SAT_SHAKER_REF_TORQUE) * 100)
      );
    }
  }

  // Push un-attenuated combined SAT into the 6-tap FIR ring buffer and apply high-impact 0.25x attenuation
  const tapCount = RACK_SAT_FIR_TAPS.length;
  const writeIdx = state.firIndex;
  state.firHistory[writeIdx] = combinedSat;
  state.firIndex = (writeIdx + 1) % tapCount;

  let firSum = 0;
  for (let i = 0; i < tapCount; i++) {
    const histIdx = (writeIdx - i + tapCount) % tapCount;
    firSum += RACK_SAT_FIR_TAPS[i] * state.firHistory[histIdx];
  }

  const impactMult = highImpactActive ? RACK_SAT_HIGH_IMPACT_ATTEN : 1.0;
  const rawSatTorque = combinedSat * impactMult;
  const filteredSatTorque = firSum * impactMult;
  const totalAddedTorque = filteredSatTorque + bumpTorque;

  out.filteredVelFrontMs = state.filteredVelFrontMs;
  out.filteredVelRearMs = state.filteredVelRearMs;
  out.shockAttenuation = shockAttenuation;
  out.deltaFzFrontN = deltaFzFrontN;
  out.deltaFzRearN = deltaFzRearN;
  out.dfzFront = dfzFront;
  out.dfzRear = dfzRear;
  out.bumpTorque = bumpTorque;
  out.rearSideslipRad = rearSideslipRad;
  out.frontSlipAngleRad = frontSlipAngleRad;
  out.rearPeakD = rearPeakD;
  out.frontPeakD = frontPeakD;
  out.rearPacejkaSa = rearPacejkaSa;
  out.frontPacejkaSa = frontPacejkaSa;
  out.oversteerTorque = oversteerTorque;
  out.understeerTorque = understeerTorque;
  out.rawSatTorque = rawSatTorque;
  out.filteredSatTorque = filteredSatTorque;
  out.satTorque = filteredSatTorque;
  out.totalAddedTorque = totalAddedTorque;
  out.resultantG = resultantG;
  out.highImpactActive = highImpactActive;
  out.oversteerIntensityPct = oversteerIntensityPct;
  out.understeerIntensityPct = understeerIntensityPct;
  return out;
}

/**
 * Zero-allocation synthesizer for dual-Pacejka self-aligning torque (oversteer + understeer), axle vertical shock
 * velocity load modulation, 6-tap FIR filtering, and >10g high-impact crash suppression.
 */
export class RackSatSynthesizer {
  readonly state: RackSatState = createRackSatState();
  readonly output: RackSatStepOutput = createRackSatOutput();
  bumpsGain: number;
  oversteerGain: number;
  understeerGain: number;
  wheelbaseM: number;

  constructor(options?: {
    bumpsGain?: number;
    oversteerGain?: number;
    understeerGain?: number;
    wheelbaseM?: number;
  }) {
    this.bumpsGain = options?.bumpsGain ?? 1.0;
    this.oversteerGain = options?.oversteerGain ?? 1.0;
    this.understeerGain = options?.understeerGain ?? 1.0;
    this.wheelbaseM = options?.wheelbaseM ?? RACK_SAT_DEFAULT_WHEELBASE_M;
  }

  step(input: RackSatStepInput): RackSatStepOutput {
    return stepRackSat(
      {
        ...input,
        bumpsGain: input.bumpsGain ?? this.bumpsGain,
        oversteerGain: input.oversteerGain ?? this.oversteerGain,
        understeerGain: input.understeerGain ?? this.understeerGain,
        wheelbaseM: input.wheelbaseM ?? this.wheelbaseM,
      },
      this.state,
      this.output
    );
  }

  reset(): void {
    resetRackSatState(this.state);
    const o = this.output;
    o.filteredVelFrontMs = 0;
    o.filteredVelRearMs = 0;
    o.shockAttenuation = 1;
    o.deltaFzFrontN = 0;
    o.deltaFzRearN = 0;
    o.dfzFront = 0;
    o.dfzRear = 0;
    o.bumpTorque = 0;
    o.rearSideslipRad = 0;
    o.frontSlipAngleRad = 0;
    o.rearPeakD = OVERSTEER_D_BASE;
    o.frontPeakD = UNDERSTEER_D_BASE;
    o.rearPacejkaSa = 0;
    o.frontPacejkaSa = 0;
    o.oversteerTorque = 0;
    o.understeerTorque = 0;
    o.rawSatTorque = 0;
    o.filteredSatTorque = 0;
    o.satTorque = 0;
    o.totalAddedTorque = 0;
    o.resultantG = 0;
    o.highImpactActive = false;
    o.oversteerIntensityPct = 0;
    o.understeerIntensityPct = 0;
  }
}

export interface FfbMeterState {
  /** Force sent this frame, before the bridge's clip (+ = right) */
  force: number;
  clipping: boolean;
  /** Decaying peak of |force| */
  peak: number;
  /** Gain that would put the 98th-percentile force at 90 % for this car; null when the current gain is fine or no data */
  suggestedGain: number | null;
  /** Rear oversteer self-aligning shaker intensity (%, 0..100) */
  oversteerIntensityPct?: number;
  /** Front understeer self-aligning shaker intensity (%, 0..100) */
  understeerIntensityPct?: number;
  /** True when horizontal resultant acceleration exceeds the 10g high-impact suppression threshold */
  highImpactActive?: boolean;
}

export class WheelFfbClient {
  /** Alternative force output (the WebHID driver); when set and WebHID FFB is on, forces go there instead of the bridge */
  hidSink: ((force: number) => void) | null = null;
  /** Linked WebHID driver (for hardware damper forwarding) */
  hidDriver: WebHidFfb | null = null;
  /** Dual-Pacejka steering rack SAT, axle vertical shock load & >10g high-impact synthesizer */
  readonly rackSat = new RackSatSynthesizer();
  meter: FfbMeterState = {
    force: 0,
    clipping: false,
    peak: 0,
    suggestedGain: null,
    oversteerIntensityPct: 0,
    understeerIntensityPct: 0,
    highImpactActive: false,
  };
  private lastRimDeg: number | null = null;
  private lastFrontSuspMm: [number, number] | null = null;
  private lastUpdateMs = 0;
  private filtered = 0;
  private history = new Float32Array(METER_WINDOW);
  private meterBins = new Uint32Array(METER_BINS);
  private historyCount = 0;
  private historyIdx = 0;
  private lastSuggestMs = 0;
  /** WebHID playback: the frame's samples still to play, the force held once they run out, vibration levels */
  private hidQueue: number[] = [];
  private hidHold = 0;
  private hidActiveDriving = false;
  private hidKerb = 0;
  private hidAbs = 0;
  private hidSlide = 0;
  private hidRough = 0;
  private hidBump = 0;
  private hidNoise = 0;
  private hidPlayer: ReturnType<typeof setInterval> | null = null;
  /** Clock (ms) of the last played sample slot and of the last frame update */
  private hidSlotMs = 0;
  private hidPushMs = 0;
  /** WebHID direction test in progress: it owns the force until it ends */
  private hidTest: { timer: ReturnType<typeof setInterval> } | null = null;

  private ws: WebSocket | null = null;
  private replaced = false;
  private lastAttemptMs = -Infinity;
  private listeners = new Set<() => void>();
  status: FfbStatus = { connection: "off", device: null, error: null };
  /** Force sent this frame (+ = right; |v| > 1 is clipped by the bridge) */
  force = 0;

  /**
   * Every frame, menus included: keeps the bridge connection while FFB is on and sends the force (zero outside the
   * car, so the wheel goes limp in the menus as it does in a native sim).
   */
  update(
    telemetry: CarTelemetry,
    wheelSettings: WheelSettings,
    pads: readonly PadLike[],
    nowMs: number,
    driving: boolean,
    vehicle?: string
  ): void {
    const useHid = wheelSettings.hidFfb && this.hidSink !== null;
    // The bridge also carries telemetry out; with WebHID force feedback it is only needed for that
    this.keepConnection((wheelSettings.ffbEnabled && !useHid) || wheelSettings.telemetryOut, nowMs);
    const wheel: WheelSettings = { ...wheelSettings, ...ffbStrengthFor(wheelSettings, vehicle) };
    const dtS = this.lastUpdateMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - this.lastUpdateMs) / 1000)) : 0;
    this.lastUpdateMs = nowMs;
    const activeHid = this.hidDriver ?? (webHidFfb.status.state === "ready" ? webHidFfb : null);
    const hwDamper = useHid && activeHid !== null && activeHid.hasHardwareDamper();
    let force = 0;
    let kerb = 0;
    let abs = 0;
    let slide = 0;
    let rough = 0;
    let bump = 0;
    let oversteerIntensityPct = 0;
    let understeerIntensityPct = 0;
    let highImpactActive = false;
    let subframes: number[] | undefined;
    if (driving && wheel.ffbEnabled) {
      const satTel = telemetry as CarTelemetry & RackSatStepInput;
      const hasSatTelemetry =
        telemetry.rearSlipAngleDeg !== undefined ||
        telemetry.frontSlipAngleDeg !== undefined ||
        telemetry.wheelSlipAnglesDeg !== undefined ||
        satTel.rearSlipAngleRad !== undefined ||
        satTel.frontSlipAngleRad !== undefined ||
        satTel.lateralVelMs !== undefined ||
        satTel.shockVelMs !== undefined;
      const satOut = this.rackSat.step({
        speedMs: satTel.speedMs,
        speedKmh: telemetry.speedKmh,
        dtS,
        suspensionTravelMm: telemetry.suspensionTravelMm,
        shockVelMs: satTel.shockVelMs,
        lateralVelMs: satTel.lateralVelMs,
        longitudinalVelMs: satTel.longitudinalVelMs,
        rearSlipAngleRad: satTel.rearSlipAngleRad,
        rearSlipAngleDeg: telemetry.rearSlipAngleDeg,
        wheelSlipAnglesDeg: telemetry.wheelSlipAnglesDeg,
        roadSteerRad: satTel.roadSteerRad,
        steering: hasSatTelemetry ? telemetry.steering : undefined,
        frontSlipAngleRad: satTel.frontSlipAngleRad,
        frontSlipAngleDeg: telemetry.frontSlipAngleDeg,
        yawRateRadS: satTel.yawRateRadS,
        wheelbaseM: satTel.wheelbaseM,
        lateralG: telemetry.lateralG,
        longitudinalG: telemetry.longitudinalG,
        bumpsGain: hasSatTelemetry ? satTel.bumpsGain : 0,
        oversteerGain: hasSatTelemetry ? satTel.oversteerGain : 0,
        understeerGain: hasSatTelemetry ? satTel.understeerGain : 0,
      });
      oversteerIntensityPct = satOut.oversteerIntensityPct;
      understeerIntensityPct = satOut.understeerIntensityPct;
      highImpactActive = satOut.highImpactActive;
      const addedSatTorque = hasSatTelemetry ? satOut.totalAddedTorque : 0;
      const impactScale = highImpactActive ? RACK_SAT_HIGH_IMPACT_ATTEN : 1.0;

      const baseTorque = Number.isFinite(telemetry.ffbTorqueNorm) ? (telemetry.ffbTorqueNorm as number) : 0;
      const torque = (baseTorque + addedSatTorque) * impactScale;
      const speedKmh = Number.isFinite(telemetry.speedKmh) ? telemetry.speedKmh : 0;
      const gyroFactor = Math.max(0, Math.min(1, (speedKmh - 10) / 180));
      if (hwDamper) {
        activeHid.setDamper(wheel.ffbDamping * (0.4 + 0.6 * gyroFactor));
      }
      const steerPad = wheel.steer ? findPad(pads, wheel.steer.padId) : undefined;
      const rimDeg =
        wheel.steer && steerPad
          ? wheelRimAngleDeg(steerPad.axes[wheel.steer.axis] ?? wheel.steer.center, wheel.steer, wheel.rotationDeg)
          : null;
      const carLockDeg = carWheelLockDeg(vehicle, wheel.steerLockPerCar);
      const softLock = rimDeg !== null ? softLockForce(rimDeg, carLockDeg) : 0;
      // Damper: static wheel damper + speed-scaled gyroscopic self-aligning damper + cushioned soft-lock stop damper
      let damping = 0;
      if (rimDeg !== null && this.lastRimDeg !== null && dtS > 0) {
        const rimSpeed = (rimDeg - this.lastRimDeg) / dtS;
        const rawBaseDamp =
          wheel.ffbDamping > 0
            ? wheel.ffbDamping * DAMPING_MAX_FORCE + 0.12 * gyroFactor * Math.min(1, wheel.ffbDamping * 1.5)
            : 0;
        // When the wheel's 1 kHz hardware PID damper is active, reduce software gamepad-axis differentiated damping by 70%
        const baseDamp = hwDamper ? rawBaseDamp * 0.3 : rawBaseDamp;
        // Inside the soft-lock zone, damp motion pushing deeper into the stop so the rim never bounces off lock
        const inSoftLock = Math.abs(rimDeg) > carLockDeg / 2 && rimSpeed * rimDeg > 0;
        const lockDamp = inSoftLock ? 0.45 : 0;
        damping = -(baseDamp + lockDamp) * Math.max(-1, Math.min(1, rimSpeed / DAMPING_FULL_DEG_S));
      }
      this.lastRimDeg = rimDeg;
      // Optional smoothing of the physics torque (the soft lock and damper stay immediate). It has to run over the
      // 500 Hz subframes too, since those (not `force`) are what the wheel plays whenever the physics supplies them
      const filterS = wheel.ffbFilterS > 0 && dtS > 0 ? wheel.ffbFilterS : 0;
      const smooth = (x: number, h: number): number => {
        if (filterS > 0) this.filtered += (x - this.filtered) * (1 - Math.exp(-h / filterS));
        else this.filtered = x;
        return this.filtered;
      };
      const rawSub = telemetry.ffbSubframeSamples;
      let shaped: number;
      if (rawSub && rawSub.length > 0) {
        const h = dtS / rawSub.length;
        subframes = rawSub.map((sample) => {
          const sampleTorque = ((Number.isFinite(sample) ? sample : 0) + addedSatTorque) * impactScale;
          let sf = smooth(shapeFfbForce(sampleTorque, wheel, telemetry.speedKmh), h) + softLock + damping;
          if (wheel.ffbInvert) sf = -sf;
          return Math.round(sf * 1e4) / 1e4;
        });
        // The held value once the subframes run out: the filtered end of this frame (unfiltered, the frame's torque)
        shaped = filterS > 0 ? this.filtered : smooth(shapeFfbForce(torque, wheel, telemetry.speedKmh), dtS);
      } else {
        shaped = smooth(shapeFfbForce(torque, wheel, telemetry.speedKmh), dtS);
      }
      this.recordMeter(shaped, wheel.ffbGain, nowMs);
      force = shaped + softLock + damping;
      if (wheel.ffbInvert) force = -force;

      const fronts = telemetry.wheelSurfaces;
      if (speedKmh > 15 && fronts && (fronts[0] === "kerb" || fronts[1] === "kerb")) kerb = wheel.ffbKerb;
      if (speedKmh > 5 && telemetry.f12026?.absActive) abs = wheel.ffbAbs;
      if (
        speedKmh > 10 &&
        fronts &&
        (fronts[0] === "grass" ||
          fronts[1] === "grass" ||
          (fronts[0] as string) === "gravel" ||
          (fronts[1] as string) === "gravel")
      ) {
        rough = Math.max(0.2, Math.min(1, (speedKmh - 10) / 80)) * Math.max(0.4, wheel.ffbKerb);
      }
      if (speedKmh > 15) {
        const extraTel = telemetry as CarTelemetry & { frontSlipRatio?: number; ndSlip?: number };
        const frontSlipRatio = Math.max(
          Math.abs(telemetry.wheelSlipRatios?.[0] ?? 0),
          Math.abs(telemetry.wheelSlipRatios?.[1] ?? 0),
          Math.abs(extraTel.frontSlipRatio ?? 0)
        );
        const ndSlip = Math.max(
          telemetry.tireSlipRatio?.[0] ?? 0,
          telemetry.tireSlipRatio?.[1] ?? 0,
          extraTel.ndSlip ?? 0
        );
        if (frontSlipRatio > 0.12 || ndSlip > 1.15) {
          const slipExcess = Math.max(
            frontSlipRatio > 0.12 ? (frontSlipRatio - 0.12) / 0.35 : 0,
            ndSlip > 1.15 ? (ndSlip - 1.15) / 1.2 : 0
          );
          slide = Math.max(0, Math.min(1, slipExcess));
        }
      }
      const susp = telemetry.suspensionTravelMm;
      this.hidBump = dtS > 0 ? this.hidBump * Math.exp(-dtS * 14) : 0;
      if (!highImpactActive && susp && Number.isFinite(susp[0]) && Number.isFinite(susp[1])) {
        if (this.lastFrontSuspMm !== null && dtS > 0) {
          const v0 = Math.abs(susp[0] - this.lastFrontSuspMm[0]) / dtS;
          const v1 = Math.abs(susp[1] - this.lastFrontSuspMm[1]) / dtS;
          const maxVelMmS = Math.max(v0, v1);
          if (maxVelMmS > 120) {
            this.hidBump = Math.max(this.hidBump, Math.min(1, (maxVelMmS - 120) / 1000));
          }
        }
        this.lastFrontSuspMm = [susp[0], susp[1]];
      } else {
        this.lastFrontSuspMm = null;
        if (highImpactActive) this.hidBump = 0;
      }
      if (this.hidBump > 0.01) bump = this.hidBump;
    } else {
      if (hwDamper) activeHid.setDamper(0);
      this.rackSat.reset();
      this.lastRimDeg = null;
      this.lastFrontSuspMm = null;
      this.hidBump = 0;
      this.filtered = 0;
    }
    this.force = force;
    this.meter = {
      ...this.meter,
      force,
      clipping: Math.abs(force) > 1,
      peak: Math.max(Math.abs(force), this.meter.peak * Math.exp(-dtS / 1.5)),
      oversteerIntensityPct,
      understeerIntensityPct,
      highImpactActive,
    };
    if (useHid) {
      if (this.hidTest) return;
      this.hidPlay(subframes, force, driving && wheel.ffbEnabled, kerb, abs, slide, rough, bump);
      return;
    }
    this.hidStopPlayer();
    this.send(
      subframes && subframes.length > 0
        ? { t: "f", f: Math.round(force * 1e4) / 1e4, k: kerb, a: abs, s: subframes }
        : { t: "f", f: Math.round(force * 1e4) / 1e4, k: kerb, a: abs }
    );
  }

  /**
   * WebHID: queues this frame's 500 Hz samples (or just its force) and plays the first at once; the timer plays the
   * rest over the next frame, one per 2 ms slot, as the bridge helper does
   */
  private hidPlay(
    samples: number[] | undefined,
    force: number,
    activeDriving: boolean,
    kerb: number,
    abs: number,
    slide = 0,
    rough = 0,
    bump = 0
  ): void {
    const now = clockMs();
    this.hidQueue = samples && samples.length > 0 ? samples.slice() : [];
    this.hidHold = this.hidQueue.length > 0 ? this.hidQueue[this.hidQueue.length - 1] : force;
    this.hidActiveDriving = activeDriving;
    this.hidKerb = kerb;
    this.hidAbs = abs;
    this.hidSlide = slide;
    this.hidRough = rough;
    this.hidBump = bump;
    this.hidPushMs = now;
    this.hidSlotMs = now;
    this.hidEmit(now, 1);
    const hasBuzz = kerb > 0 || abs > 0 || slide > 0 || rough > 0 || bump > 0;
    const active = activeDriving && (this.force !== 0 || this.hidQueue.length > 0 || hasBuzz);
    if (active && this.hidPlayer === null) {
      const timer = setInterval(() => this.hidTick(), HID_TICK_MS);
      (timer as { unref?: () => void }).unref?.();
      this.hidPlayer = timer;
    } else if (!active) {
      this.hidStopPlayer();
    }
  }

  /** Timer: plays the samples due since the last tick (the latest of them), or zeroes the wheel once frames stop */
  private hidTick(): void {
    const now = clockMs();
    if (now - this.hidPushMs > HID_WATCHDOG_MS) {
      // Frame updates stopped (hidden tab, stalled loop): let go of the wheel
      this.hidStopPlayer();
      this.force = 0;
      this.hidSink?.(0);
      return;
    }
    const slots = Math.floor((now - this.hidSlotMs) / PHYSICS_SAMPLE_MS);
    if (slots < 1) return;
    this.hidSlotMs += slots * PHYSICS_SAMPLE_MS;
    this.hidEmit(now, slots);
  }

  /** Advances `slots` samples and sends the force with the vibrations, synthesised on the real clock */
  private hidEmit(nowMs: number, slots: number): void {
    let f = this.hidHold;
    if (this.hidQueue.length > 0) {
      const take = Math.min(slots, this.hidQueue.length);
      f = this.hidQueue[take - 1];
      this.hidQueue.splice(0, take);
    }
    const t = nowMs / 1000;
    if (this.hidRough > 0) {
      this.hidNoise += (Math.random() * 2 - 1 - this.hidNoise) * 0.18;
    } else {
      this.hidNoise = 0;
    }
    const buzz =
      HID_KERB_AMPLITUDE * this.hidKerb * Math.sin(2 * Math.PI * HID_KERB_HZ * t) +
      HID_ABS_AMPLITUDE * this.hidAbs * Math.sign(Math.sin(2 * Math.PI * HID_ABS_HZ * t)) +
      HID_SLIDE_AMPLITUDE * this.hidSlide * Math.sin(2 * Math.PI * HID_SLIDE_HZ * t) +
      HID_ROUGH_AMPLITUDE * this.hidRough * (0.65 * Math.sin(2 * Math.PI * HID_ROUGH_HZ * t) + 0.35 * this.hidNoise) +
      HID_BUMP_AMPLITUDE * this.hidBump * Math.sin(2 * Math.PI * HID_BUMP_HZ * t);
    this.hidSink?.(Math.max(-1, Math.min(1, f + (this.hidActiveDriving ? buzz : 0))));
  }

  private hidStopPlayer(): void {
    if (this.hidPlayer !== null) {
      clearInterval(this.hidPlayer);
      this.hidPlayer = null;
    }
    this.hidQueue = [];
    this.hidActiveDriving = false;
  }

  /** Zero the wheel now (pause menu opened, hidden tab, blurred window) instead of waiting for the next frame */
  stop(): void {
    this.cancelHidTest();
    this.hidStopPlayer();
    this.rackSat.reset();
    this.lastFrontSuspMm = null;
    this.hidBump = 0;
    this.force = 0;
    this.hidSink?.(0);
    this.send({ t: "f", f: 0, k: 0, a: 0 });
  }

  /** Forwards a telemetry packet to the bridge, which sends it as one UDP datagram to 127.0.0.1:<port> */
  sendTelemetry(port: number, packet: object): void {
    this.send({ t: "tel", port, d: packet });
  }

  /** Forget the force history (car or gain changed) */
  resetMeter(): void {
    this.historyCount = 0;
    this.historyIdx = 0;
    this.rackSat.reset();
    this.meter = {
      force: 0,
      clipping: false,
      peak: 0,
      suggestedGain: null,
      oversteerIntensityPct: 0,
      understeerIntensityPct: 0,
      highImpactActive: false,
    };
  }

  /** Keeps |force| history and, once a second, works out a gain that uses the wheel's range without clipping */
  private recordMeter(shaped: number, gain: number, nowMs: number): void {
    this.history[this.historyIdx] = Math.abs(shaped);
    this.historyIdx = (this.historyIdx + 1) % METER_WINDOW;
    this.historyCount = Math.min(METER_WINDOW, this.historyCount + 1);
    if (nowMs - this.lastSuggestMs < 1000 || this.historyCount < 600 || gain <= 0) return;
    this.lastSuggestMs = nowMs;
    // 98th percentile of |force| from a histogram (0.01 bins up to 2): no copy and sort of the 4800-sample window
    const bins = this.meterBins.fill(0);
    for (let i = 0; i < this.historyCount; i++) bins[Math.min(METER_BINS - 1, Math.floor(this.history[i] * 100))]++;
    const rank = Math.floor(this.historyCount * 0.98);
    let seen = 0;
    let bin = 0;
    while (bin < METER_BINS - 1 && seen + bins[bin] <= rank) seen += bins[bin++];
    const p98 = (bin + 0.5) / 100;
    let suggested: number | null = null;
    if (p98 > 0.02 && (p98 > 1 || p98 < 0.55)) {
      suggested = Math.round(Math.min(2, Math.max(0.1, (gain * 0.9) / p98)) * 20) / 20;
      if (Math.abs(suggested - gain) < 0.05) suggested = null;
    }
    this.meter = { ...this.meter, suggestedGain: suggested };
  }

  /**
   * Plays the direction test: a held pull right, then left (left first when inverted, as the game's forces will be).
   * Through the WebHID wheel while it is the force output, otherwise the bridge's; false when neither is connected.
   */
  test(invert: boolean): boolean {
    if (!this.hidSink) return this.send({ t: "test", inv: invert });
    this.cancelHidTest();
    this.hidStopPlayer();
    const start = Date.now();
    const timer = setInterval(() => {
      const tS = (Date.now() - start) / 1000;
      if (tS >= DIRECTION_TEST_S || !this.hidSink) {
        this.cancelHidTest();
        return;
      }
      this.hidSink(directionTestForce(tS, invert));
    }, TEST_STEP_MS);
    this.hidTest = { timer };
    this.hidSink(directionTestForce(0, invert));
    return true;
  }

  private cancelHidTest(): void {
    if (!this.hidTest) return;
    clearInterval(this.hidTest.timer);
    this.hidTest = null;
    this.hidSink?.(0);
  }

  /** useSyncExternalStore pair (bound, so they can be passed as they are) */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getStatus = (): FfbStatus => this.status;

  dispose(): void {
    this.stop();
    this.keepConnection(false, 0);
  }

  private send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setStatus(next: FfbStatus) {
    const s = this.status;
    if (s.connection === next.connection && s.device === next.device && s.error === next.error) return;
    this.status = next;
    for (const l of this.listeners) l();
  }

  private keepConnection(on: boolean, nowMs: number) {
    if (!on) {
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        ws.close();
      }
      this.lastAttemptMs = -Infinity;
      this.replaced = false;
      this.setStatus({ connection: "off", device: null, error: null });
      return;
    }
    if (this.replaced || this.ws || typeof WebSocket === "undefined" || nowMs - this.lastAttemptMs < RECONNECT_MS) return;
    this.lastAttemptMs = nowMs;
    // Each failed attempt logs a connection error in the console; hence the slow retry, and only while FFB is on
    const ws = new WebSocket(BRIDGE_URL);
    this.ws = ws;
    if (this.status.connection === "off") this.setStatus({ connection: "connecting", device: null, error: null });
    ws.onopen = () => {
      if (this.ws === ws) this.setStatus({ connection: "connected", device: null, error: null });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      try {
        const m = JSON.parse(e.data) as { type?: string; ok?: boolean; device?: string | null; error?: string | null };
        if (m.type === "replaced") {
          this.replaced = true;
          this.setStatus({ connection: "replaced", device: null, error: null });
        } else if (m.type === "status") {
          this.setStatus({ connection: "connected", device: m.device ?? null, error: m.ok ? null : (m.error ?? "Wheel not ready") });
        }
      } catch {
        // not ours
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.replaced) this.setStatus({ connection: "unreachable", device: null, error: null });
    };
  }
}

/** One client for the app: the simulator loop streams through it, the wheel setup screen shows its status */
export const wheelFfb = new WheelFfbClient();

/**
 * The app's WebHID driver. Pairing (connect) runs from the wheel setup's click; on load the simulator only reopens a
 * wheel granted before (reconnect). While it is ready it is wheelFfb's force output; any other state hands the force
 * back to the bridge.
 */
export const webHidFfb = new WebHidFfb();
linkHidSink(wheelFfb, webHidFfb);

/**
 * Keeps `client.hidSink` pointing at `hid` exactly while it is ready; returns the unsubscribe. The client's forces are
 * + = right, a PID magnitude along +X is + = left (the direction a force comes from), so the sign flips here.
 */
export function linkHidSink(client: WheelFfbClient, hid: WebHidFfb): () => void {
  const sync = () => {
    const ready = hid.status.state === "ready";
    client.hidDriver = ready ? hid : null;
    client.hidSink = ready ? (f) => hid.setForce(-f) : null;
  };
  sync();
  return hid.subscribe(sync);
}
