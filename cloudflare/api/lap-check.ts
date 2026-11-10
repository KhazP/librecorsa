/**
 * Shape and plausibility of an uploaded lap, before it goes on a board. The checks only stop careless or malformed
 * uploads: anyone can fabricate a lap that passes them, so the boards are friendly, not a referee.
 */
import { lapPlausibilityProblem } from "../../src/lib/sim/lap-plausibility";
import { LAP_SAMPLE_STRIDE, parseLapConditions, type LapConditions, type LapRecording } from "../../src/lib/sim/lap-types";
import { isVehicleModelId } from "../../src/types/f1";

export type CheckedLap = LapRecording & { conditions: LapConditions };
export type LapCheck = { ok: true; rec: CheckedLap } | { ok: false; error: string };

const MAX_LAP_MS = 3_600_000;
const MAX_SPEED_KMH = 420;
const MAX_TIME_DRIFT_S = 1.5;
const MAX_SECTOR_DRIFT_MS = 50;
const MIN_PAIR_DT_S = 0.02;
const MIN_SAMPLES = 10;
const MAX_SAMPLES = 20000;
export const TRACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function checkLap(raw: unknown): LapCheck {
  const bad = (error: string): LapCheck => ({ ok: false, error });
  if (!isRecord(raw)) return bad("Recording must be an object");
  if (raw.version !== 1) return bad("Unsupported version");
  // Assists, realism, tyre, surface and physics revision are shown with the lap; laps without them come from an outdated game
  const conditions = parseLapConditions(raw.conditions);
  if (!conditions) return bad("Missing lap conditions. Update the game and try again");

  const trackId = raw.trackId;
  if (typeof trackId !== "string" || !TRACK_ID_RE.test(trackId)) return bad("Invalid trackId");
  const vehicle = raw.vehicle;
  if (!isVehicleModelId(vehicle)) return bad("Invalid vehicle");

  const driverName = typeof raw.driverName === "string" ? raw.driverName.trim() : "";
  if (driverName.length === 0 || driverName.length > 64) return bad("Invalid driverName");
  const driverCode = typeof raw.driverCode === "string" ? raw.driverCode.trim() : "";
  if (driverCode.length === 0 || driverCode.length > 16) return bad("Invalid driverCode");

  const lapTimeMs = raw.lapTimeMs;
  if (!finite(lapTimeMs) || lapTimeMs <= 0 || lapTimeMs > MAX_LAP_MS) return bad("Invalid lapTimeMs");
  const recordedAt = raw.recordedAt;
  if (!finite(recordedAt) || recordedAt <= 0) return bad("Invalid recordedAt");
  const sampleHz = raw.sampleHz;
  if (!finite(sampleHz) || sampleHz <= 0 || sampleHz > 1000) return bad("Invalid sampleHz");

  const sectors = raw.sectorTimesMs;
  if (!Array.isArray(sectors) || sectors.length !== 3 || !sectors.every((v) => finite(v) && v >= 0)) {
    return bad("Invalid sectorTimesMs");
  }
  const [s0, s1, s2] = sectors as [number, number, number];
  if (Math.abs(s0 + s1 + s2 - lapTimeMs) > MAX_SECTOR_DRIFT_MS) return bad("Sector times do not add up to the lap time");

  const data = raw.data;
  if (!Array.isArray(data) || data.length % LAP_SAMPLE_STRIDE !== 0 || !data.every(finite)) return bad("Invalid data");
  const samples = data as number[];
  const count = samples.length / LAP_SAMPLE_STRIDE;
  if (count < MIN_SAMPLES || count > MAX_SAMPLES) return bad("Recording has too few or too many samples");

  // Per-sample ranges and time that never goes back
  let prevT = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * LAP_SAMPLE_STRIDE;
    const t = samples[o];
    if (t < prevT) return bad("Sample times must not go backwards");
    prevT = t;
    const speed = samples[o + 9];
    const throttle = samples[o + 10];
    const brake = samples[o + 11];
    const steer = samples[o + 12];
    const gear = samples[o + 13];
    if (speed < 0 || speed > MAX_SPEED_KMH) return bad("Sample speed out of range");
    if (throttle < 0 || throttle > 1 || brake < 0 || brake > 1) return bad("Pedal value out of range");
    if (steer < -1 || steer > 1) return bad("Steering value out of range");
    if (!Number.isInteger(gear) || gear < -1 || gear > 8) return bad("Gear out of range");
  }
  if (Math.abs(lapTimeMs / 1000 - prevT) > MAX_TIME_DRIFT_S) return bad("Lap time does not match the samples");

  // Consecutive positions must not imply a teleport
  for (let i = 1; i < count; i++) {
    const a = (i - 1) * LAP_SAMPLE_STRIDE;
    const b = i * LAP_SAMPLE_STRIDE;
    const dt = samples[b] - samples[a];
    if (dt < MIN_PAIR_DT_S) continue;
    const distance = Math.hypot(samples[b + 2] - samples[a + 2], samples[b + 3] - samples[a + 3], samples[b + 4] - samples[a + 4]);
    if ((distance / dt) * 3.6 > MAX_SPEED_KMH) return bad("Positions imply a speed above 420 km/h");
  }
  // The samples agree with each other: the lap closes, and speed, positions and track distance match
  const problem = lapPlausibilityProblem(samples);
  if (problem) return bad(problem);

  return {
    ok: true,
    rec: {
      version: 1,
      trackId,
      vehicle,
      driverName,
      driverCode,
      lapTimeMs,
      sectorTimesMs: [s0, s1, s2],
      recordedAt,
      sampleHz,
      data: samples,
      conditions,
    },
  };
}
