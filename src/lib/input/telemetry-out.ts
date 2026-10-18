import type { CarTelemetry } from "@/types/f1";

/** Compact telemetry for dashboards / SimHub / bass shakers, sent ~60 Hz; field names stable (document each with a comment and its unit) */
export interface TelemetryOutPacket {
  /** Packet format version */
  v: 1;
  /** Car model id (e.g. "f12026-car") */
  car: string;
  /** Track id */
  track: string;
  /** Milliseconds since page load */
  t: number;
  /** Speed (km/h) */
  speedKmh: number;
  /** Engine speed (rpm) */
  rpm: number;
  /** Rev limit (rpm) */
  maxRpm: number;
  /** Gear: -1 = R, 0 = N, 1..8 */
  gear: number;
  /** Throttle, 0..1 */
  throttle: number;
  /** Brake, 0..1 */
  brake: number;
  /** Steering, -1..1 (+ = right) */
  steer: number;
  /** Clutch, 0..1 (1 = engaged) */
  clutch: number;
  /** Lateral acceleration (g, + = right) */
  gLat: number;
  /** Longitudinal acceleration (g, + = forward) */
  gLon: number;
  /** Vertical acceleration (g) */
  gVert: number;
  /** Yaw rate (rad/s, + = turning right) */
  yawRate: number;
  /** Pitch (rad) */
  pitch: number;
  /** Roll (rad) */
  roll: number;
  /** ERS battery charge (%, 0..100) */
  ersPct: number;
  /** 2026 manual override (350 kW boost) active */
  boost: boolean;
  /** DRS flap open */
  drs: boolean;
  /** Active aero mode: "Z_MODE" (high downforce) or "X_MODE" (low drag) */
  aeroMode: string;
  /** Fuel on board (kg) */
  fuelKg: number;
  /** Tyre carcass temperatures, FL, FR, RL, RR (°C) */
  tyreTempC: [number, number, number, number];
  /** Hot tyre pressures, FL, FR, RL, RR (psi); 0 when unknown */
  tyrePsi: [number, number, number, number];
  /** Tyre wear, FL, FR, RL, RR (%, 0..100) */
  tyreWearPct: [number, number, number, number];
  /** Brake disc temperatures, FL, FR, RL, RR (°C) */
  brakeTempC: [number, number, number, number];
  /** Longitudinal slip ratio, FL, FR, RL, RR (dimensionless, + = traction) */
  wheelSlip: [number, number, number, number];
  /** Suspension compression, FL, FR, RL, RR (mm) */
  suspTravelMm: [number, number, number, number];
  /** Surface under each wheel, FL, FR, RL, RR: "asphalt" | "kerb" | "runoff" | "grass" */
  surface: [string, string, string, string];
  /** Current lap number */
  lap: number;
  /** Current lap time (ms) */
  lapTimeMs: number;
  /** Last completed lap time (ms); 0 when none */
  lastLapMs: number;
  /** Best lap time (ms); 0 when none */
  bestLapMs: number;
  /** Race position (1 = leading); 0 when not racing */
  position: number;
  /** Progress around the lap, 0..1 */
  trackPos: number;
  /** A wheel is on a kerb */
  kerb: boolean;
  /** Car is off the track surface */
  offTrack: boolean;
  /** ABS is releasing the brakes this step */
  abs: boolean;
  /** Traction control is cutting the throttle this step */
  tc: boolean;
  /** Steering wheel torque from the tyres, -1..1 (+ = turning the rim right) */
  ffb: number;
}

/** Values the telemetry does not carry on CarTelemetry itself */
export interface TelemetryOutExtra {
  /** Car model id */
  car: string;
  /** Track id */
  track: string;
  /** Rev limit (rpm) */
  maxRpm: number;
  /** Yaw rate (rad/s) */
  yawRateRadS: number;
  /** Pitch (rad) */
  pitchRad: number;
  /** Roll (rad) */
  rollRad: number;
  /** Milliseconds since page load */
  nowMs: number;
}

type Quad = [number, number, number, number];

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Rounds to `dp` decimals and clamps to [lo, hi]; non-finite input reads as 0 */
const round = (v: unknown, dp: number, lo = -Infinity, hi = Infinity): number => {
  const f = 10 ** dp;
  return Math.round(Math.min(hi, Math.max(lo, num(v))) * f) / f;
};

const quad = (a: readonly unknown[] | undefined, dp: number, lo = -Infinity, hi = Infinity): Quad => [
  round(a?.[0], dp, lo, hi),
  round(a?.[1], dp, lo, hi),
  round(a?.[2], dp, lo, hi),
  round(a?.[3], dp, lo, hi),
];

const surfaces = (a: readonly unknown[] | undefined): [string, string, string, string] => {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return [s(a?.[0]), s(a?.[1]), s(a?.[2]), s(a?.[3])];
};

/** Maps the sim's per-frame telemetry to the compact dashboard packet (wheel arrays are FL, FR, RL, RR) */
export function buildTelemetryPacket(t: CarTelemetry, extra: TelemetryOutExtra): TelemetryOutPacket {
  const f12 = t.f12026;
  return {
    v: 1,
    car: extra.car,
    track: extra.track,
    t: round(extra.nowMs, 0),
    speedKmh: round(t.speedKmh, 1),
    rpm: round(t.rpm, 0),
    maxRpm: round(extra.maxRpm, 0),
    gear: round(t.gear, 0),
    throttle: round(t.throttle, 3, 0, 1),
    brake: round(t.brake, 3, 0, 1),
    steer: round(t.steering, 3, -1, 1),
    clutch: round(t.clutch, 3, 0, 1),
    gLat: round(t.lateralG, 3),
    gLon: round(t.longitudinalG, 3),
    gVert: round(t.verticalG, 3),
    yawRate: round(extra.yawRateRadS, 3),
    pitch: round(extra.pitchRad, 3),
    roll: round(extra.rollRad, 3),
    ersPct: round(t.ersBatteryPercent, 1, 0, 100),
    boost: t.manualOverrideActive === true,
    drs: f12?.CHANGED_DRS_OPEN ?? false,
    aeroMode: typeof t.activeAeroMode === "string" ? t.activeAeroMode : "",
    fuelKg: round(t.fuelKg, 1),
    tyreTempC: quad(t.tireTempsC, 1),
    tyrePsi: quad(t.tirePressuresPsi, 1),
    tyreWearPct: quad(t.tireWearPct, 1, 0, 100),
    brakeTempC: quad(t.brakeTempsC, 1),
    wheelSlip: quad(t.wheelSlipRatios, 3),
    suspTravelMm: quad(t.suspensionTravelMm, 1),
    surface: surfaces(t.wheelSurfaces),
    lap: round(t.lapCount, 0),
    lapTimeMs: round(t.currentLapTimeMs, 0),
    lastLapMs: round(t.lastLapTimeMs, 0),
    bestLapMs: round(t.bestLapTimeMs, 0),
    position: round(t.race?.position, 0),
    trackPos: round(t.trackProgress, 3, 0, 1),
    kerb: t.onKerbLeft === true || t.onKerbRight === true,
    offTrack: t.offTrack === true,
    abs: f12?.absActive ?? false,
    tc: f12?.tcActive ?? false,
    ffb: round(t.ffbTorqueNorm, 3, -1, 1),
  };
}
