/**
 * Track Occupancy Grid, Per-Wheel Surface Query & Dynamic Braking Line Evaluator
 *
 * - Track boundary occupancy, inside/outside border queries, and 4-wheel surface
 *   classification (`asphalt`, `kerb`, `runoff`, `grass`).
 * - `CURV_LOOK_AHEAD_DISTANCE = 300`, `CURV_LOOK_AHEAD_VECTOR_SIZE = 12` lookahead
 *   curvature & speed vectors, and full vehicle observation state vector.
 */

import * as THREE from 'three';
import { SurfaceType, TrackSamplePoint } from '@/types/f1';
import { BuiltTrackData, catmullRomWeights, evaluateSampleLateralHeightM } from '@/lib/track-data';
import { type BrakingGuide, sampleProfile } from './speed-profile';

export const CURV_LOOK_AHEAD_DISTANCE = 300; // meters
export const CURV_LOOK_AHEAD_VECTOR_SIZE = 12; // 12 lookahead samples

/**
 * Full vehicle and track-relative observation vector
 */
export interface RaceGymObservation {
  speedMs: number;
  localVelocityX: number;
  localVelocityY: number;
  localVelocityZ: number;
  angularVelocityX: number;
  angularVelocityY: number;
  angularVelocityZ: number;
  accelX: number;
  accelY: number;
  rollRad: number;
  pitchRad: number;
  yawRad: number;
  engineRpm: number;
  gear: number;
  normalizedSplinePosition: number;
  /** Signed lateral distance from optimal racing line (m) */
  gapToRacingLineM: number;
  /** Signed lateral distance from track centerline (m) */
  lateralOffsetCenterM: number;
  /** Heading error relative to racing line tangent (rad) */
  headingErrorRad: number;
  /** 4-wheel slip angles [FR, FL, RR, RL] (rad) */
  slipAngleRad: [number, number, number, number];
  /** 4-wheel slip ratios [FR, FL, RR, RL] */
  slipRatio: [number, number, number, number];
  /** 4-wheel vertical tire loads [FR, FL, RR, RL] (N) */
  tyreLoadN: [number, number, number, number];
  /** 4-wheel dynamic ride heights [FR, FL, RR, RL] (m) */
  rideHeightM: [number, number, number, number];
  /** 4-wheel tire core temperatures [FR, FL, RR, RL] (°C) */
  tyreTempC: [number, number, number, number];
  /** 12-point lookahead curvature vector over 300m (1/m) */
  lookaheadCurvatures: number[];
  /** 12-point lookahead optimal reference speed vector over 300m (m/s) */
  lookaheadTargetSpeedsMs: number[];
  /** Number of wheels currently outside the white track lines */
  wheelsOutOfTrack: number;
  /** True if all 4 wheels are outside track boundaries */
  outOfTrack: boolean;
}

export interface WheelGroundContact {
  zRoad: number;
  surfaceType: SurfaceType;
  frictionMult: number;
  bumpM: number;
  bankRad: number;
  pitchSlopeRad: number;
  lateralOffsetM: number;
  halfWidthM: number;
  isOutOfTrack: boolean;
}

/** Kerb cross-section (m above the road) vs distance outward from the asphalt edge (scripts/rwanda-2026/build_surfaces.py) */
const KERB_PROFILE_L = [-0.35, -0.3, 0.05, 0.45, 0.95, 1.35, 1.45];
const KERB_PROFILE_Z = [0, 0.008, 0.03, 0.05, 0.045, 0.012, 0];
function kerbProfileM(outwardM: number): number {
  if (outwardM <= KERB_PROFILE_L[0] || outwardM >= KERB_PROFILE_L[KERB_PROFILE_L.length - 1]) return 0;
  let i = 0;
  while (outwardM > KERB_PROFILE_L[i + 1]) i++;
  const f = (outwardM - KERB_PROFILE_L[i]) / (KERB_PROFILE_L[i + 1] - KERB_PROFILE_L[i]);
  return KERB_PROFILE_Z[i] + (KERB_PROFILE_Z[i + 1] - KERB_PROFILE_Z[i]) * f;
}

/**
 * Queries the exact 3D road elevation, banking, longitudinal slope, and surface type
 * under a wheel at world coordinates `(worldX, worldZ)` (Three.js X, Z plane).
 */
export function queryWheelGroundContact(
  track: BuiltTrackData,
  worldX: number,
  worldZ: number,
  approxS: number,
  carSpeedMs: number
): WheelGroundContact {
  const stepM = track.totalLengthM / track.samples.length;

  // Continuous segment / lateral location (see BuiltTrackData.locateWorldPoint)
  const loc = track.locateWorldPoint(worldX, worldZ, approxS);
  const s0 = track.samples[loc.i0];
  const sNext = track.samples[loc.i1];
  const t = loc.t;

  // Signed lateral offset from track centerline (+right along horizontal binormal, -left)
  const lateralOffsetM = loc.lateralH;
  const absLat = Math.abs(lateralOffsetM);

  const halfWidthM = (s0.width + (sNext.width - s0.width) * t) * 0.5;
  const bankRad = s0.bankingRad + (sNext.bankingRad - s0.bankingRad) * t;
  const slopeSin = s0.slopeSin + (sNext.slopeSin - s0.slopeSin) * t;
  const pitchSlopeRad = Math.asin(THREE.MathUtils.clamp(slopeSin, -0.5, 0.5));

  // Track surface elevation at the wheel's lateral position from the 9-point cross-section
  // profiles, Catmull-Rom interpolated along the track (same as getSampleAtDistance)
  const n = track.samples.length;
  const [w0, w1, w2, w3] = catmullRomWeights(t);
  const zRoad =
    w0 * evaluateSampleLateralHeightM(track.samples[(loc.i0 - 1 + n) % n], lateralOffsetM) +
    w1 * evaluateSampleLateralHeightM(s0, lateralOffsetM) +
    w2 * evaluateSampleLateralHeightM(sNext, lateralOffsetM) +
    w3 * evaluateSampleLateralHeightM(track.samples[(loc.i1 + 1) % n], lateralOffsetM);

  // Classify surface under this specific wheel (asphalt, kerb, runoff, gravel -> grass class, grass).
  // Painted run-off and gravel widths come per side from the track export; older data falls back to 5.2 m.
  const kerbInner = halfWidthM - 0.35;
  const kerbOuter = halfWidthM + 1.45;
  const left = lateralOffsetM < 0;
  const lerpEdge = (a: number | undefined, b: number | undefined, fallback: number) =>
    a === undefined || b === undefined ? fallback : a + (b - a) * t;
  const runoffW = left
    ? lerpEdge(s0.runoffLeftM, sNext.runoffLeftM, 5.2)
    : lerpEdge(s0.runoffRightM, sNext.runoffRightM, 5.2);
  const gravelW = left
    ? lerpEdge(s0.gravelLeftM, sNext.gravelLeftM, 0)
    : lerpEdge(s0.gravelRightM, sNext.gravelRightM, 0);
  const runoffOuter = halfWidthM + Math.max(1.6, runoffW);
  const gravelOuter = runoffOuter + gravelW;

  let surfaceType: SurfaceType = 'asphalt';
  let frictionMult = 1.0;
  let bumpM = 0;

  const sCoord = s0.s + t * stepM;
  // Kerb presence on this side, eased between samples: the kerbs ramp up from flush at their ends
  const k0 = (left ? s0.kerbLeft : s0.kerbRight) ? 1 : 0;
  const k1 = (left ? sNext.kerbLeft : sNext.kerbRight) ? 1 : 0;
  const kerbRamp = THREE.MathUtils.smoothstep(k0 + (k1 - k0) * t, 0, 1);
  if (kerbRamp > 0 && absLat > kerbInner && absLat <= kerbOuter) {
    surfaceType = 'kerb';
    frictionMult = 0.89;
    // The kerb's raised cross-section (same profile as the Track_Kerbs mesh) plus its serrated ridges every
    // ~0.65 m along s
    bumpM = kerbRamp * (kerbProfileM(absLat - halfWidthM) + Math.sin(sCoord * 9.6) * 0.004 * Math.min(1, carSpeedMs / 8));
  } else if (absLat <= halfWidthM) {
    surfaceType = 'asphalt';
    frictionMult = 1.0;
    bumpM = Math.sin(sCoord * 0.45) * 0.0004;
  } else if (absLat <= runoffOuter) {
    surfaceType = 'runoff';
    frictionMult = 0.68;
    bumpM = Math.sin(sCoord * 3.2 + lateralOffsetM * 2.5) * 0.0038;
  } else if (absLat <= gravelOuter) {
    // Gravel trap: loose, bumpy and low grip (classified with grass for audio / FX)
    surfaceType = 'grass';
    frictionMult = 0.38;
    bumpM = Math.sin(sCoord * 7.3 + lateralOffsetM * 5.1) * 0.016;
  } else {
    surfaceType = 'grass';
    frictionMult = 0.48;
    bumpM = Math.sin(sCoord * 4.8 + lateralOffsetM * 3.1) * 0.010;
  }

  return {
    zRoad,
    surfaceType,
    frictionMult,
    bumpM,
    bankRad,
    pitchSlopeRad,
    lateralOffsetM,
    halfWidthM,
    isOutOfTrack: absLat > kerbOuter,
  };
}

/**
 * Computes the 12-point lookahead curvature & optimal target speed vectors over 300m
 * (`CURV_LOOK_AHEAD_DISTANCE = 300`, `CURV_LOOK_AHEAD_VECTOR_SIZE = 12`).
 */
export function computeLookaheadVectors(
  track: BuiltTrackData,
  currentS: number
): { lookaheadCurvatures: number[]; lookaheadTargetSpeedsMs: number[] } {
  const lookaheadCurvatures: number[] = [];
  const lookaheadTargetSpeedsMs: number[] = [];
  const stepDist = CURV_LOOK_AHEAD_DISTANCE / CURV_LOOK_AHEAD_VECTOR_SIZE; // 25m steps

  for (let i = 1; i <= CURV_LOOK_AHEAD_VECTOR_SIZE; i++) {
    const sampleS = (currentS + i * stepDist) % track.totalLengthM;
    const sp: TrackSamplePoint = track.getSampleAtDistance(sampleS);
    lookaheadCurvatures.push(sp.curvature);
    lookaheadTargetSpeedsMs.push(sp.optimalSpeedKmh / 3.6);
  }

  return { lookaheadCurvatures, lookaheadTargetSpeedsMs };
}

/** Reaction allowance: a marker turns red this long before the last possible brake point (s) */
const BRAKE_REACTION_S = 0.1;
/** Yellow warning lead before the red brake point (s) */
const BRAKE_WARNING_S = 0.6;

/**
 * Evaluates the dynamic braking urgency (`0.0` = full throttle green, `0.5` = caution/lift yellow,
 * `1.0` = heavy threshold braking red) for a racing line marker at track distance `markerS`
 * given the player's current speed `carSpeedMs` and position `carS`.
 *
 * Uses the car model's braking envelope (the backward pass of its speed profile: the car's own `guide`, else
 * the circuit's VF26 profile in `brakeLimitKmh`): a car arriving at the marker at its current speed must already
 * be braking there when that speed exceeds the envelope. The marker goes yellow up to 0.6 s before that point.
 */
export function evaluateDynamicBrakingUrgency(
  track: BuiltTrackData,
  carS: number,
  carSpeedMs: number,
  markerS: number,
  guide?: BrakingGuide | null
): number {
  const totalLen = track.totalLengthM;
  const deltaS = (markerS - carS + totalLen) % totalLen;

  // Markers further ahead just show the static braking zones
  if (deltaS > 260) {
    if (guide) {
      const n = guide.brakingZone.length;
      return guide.brakingZone[Math.round((((markerS % totalLen) + totalLen) % totalLen) / (totalLen / n)) % n];
    }
    return THREE.MathUtils.clamp(track.getSampleAtDistance(markerS).brakingZone, 0, 1);
  }

  const envelopeAt = (s: number) => {
    if (guide) return sampleProfile(guide.brakeEnvelopeMs, s, totalLen);
    const sp = track.getSampleAtDistance(((s % totalLen) + totalLen) % totalLen);
    return (sp.brakeLimitKmh ?? sp.optimalSpeedKmh) / 3.6;
  };
  const v = carSpeedMs;
  const sRed = markerS + v * BRAKE_REACTION_S;
  // Red: braking has to start at (or before) this marker
  if (v > envelopeAt(sRed) + 0.5) return 1.0;
  // Yellow: the brake point lies within the warning lead after the marker
  const warnDist = v * BRAKE_WARNING_S;
  for (let d = 5; d <= warnDist; d += 5) {
    if (v > envelopeAt(sRed + d) + 0.5) return 0.35 + 0.6 * (1 - d / warnDist);
  }
  return 0;
}
