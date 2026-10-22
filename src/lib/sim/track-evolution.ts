/**
 * Dynamic Track Surface Evolution & 3D OBB Car-to-Car Rigid-Body Collision Solver
 * (`src/lib/sim/track-evolution.ts`)
 *
 * Implements:
 * 1. `TrackEvolutionState`: Per-sector dynamic track evolution:
 *    - Racing-line rubber buildup (`racingLineRubber`) from tire shear work, increasing on-line grip.
 *    - Off-line rubber marble shedding (`offLineMarbles`) from tire wear in corners, reducing off-line
 *      grip and feeding `ac-tyre.ts` `stepDirtyLevel` marble pickup when driving off-line.
 *    - Local track surface temperature evolution.
 * 2. `resolveCarToCarObbCollision`: Full 2D/3D Oriented Bounding Box (OBB) Separating Axis Theorem (SAT)
 *    collision detector and rigid-body linear + angular impulse (r × J) solver.
 */

import { marbleLoadEffect, wetGrooveGripEffect } from './wet-tyres';

export const TRACK_EVOLUTION_SECTORS = 64;
const BASELINE_RUBBER = 0.65;

export type SurfaceGripPresetId = 'green' | 'light' | 'medium' | 'natural' | 'heavy' | 'saturated';

export const SURFACE_GRIP_PRESETS: readonly SurfaceGripPresetId[] = [
  'green',
  'light',
  'medium',
  'natural',
  'heavy',
  'saturated',
];

export const SURFACE_GRIP_PRESET_RUBBER: Record<SurfaceGripPresetId, number> = {
  green: 0.08,
  light: 0.30,
  medium: 0.50,
  natural: BASELINE_RUBBER,
  heavy: 0.80,
  saturated: 0.95,
};

export const SURFACE_GRIP_PRESET_LABELS: Record<SurfaceGripPresetId, { label: string; detail: string }> = {
  green: { label: 'Green', detail: 'Freshly washed tarmac, minimal rubber' },
  light: { label: 'Light', detail: 'Early weekend rubber buildup' },
  medium: { label: 'Medium', detail: 'Moderate rubbered-in groove' },
  natural: { label: 'Natural', detail: 'Standard race-ready rubber groove' },
  heavy: { label: 'Heavy', detail: 'Well-rubbered endurance racing line' },
  saturated: { label: 'Saturated', detail: 'Fully saturated dark rubber groove' },
};

/** Time-scale multipliers for dynamic road evolution (0 = static) */
export const SURFACE_TIME_SCALES: readonly number[] = [0, 0.5, 1, 2, 5];

/** Damping of groove accumulation in areas with loose dust/marbles */
export const GROOVE_DUST_DAMPING = 0.25;

/** Base track surface temperature (°C): the cars' own default (F1Physics2026 / VehiclePhysics), so the field's samples
 * don't cool the track */
export const TRACK_EVOLUTION_BASE_C = 41;
/** Rubber laid per second by a car on the line, before the slip-energy part (the base rate of a 60 Hz caller) */
const RUBBER_BASE_RATE_PER_S = 9.0e-4;
/** Heavy rain rinses the line toward this rubber level with a ~20 min time constant */
const WASHED_RUBBER = 0.35;
const WASH_RATE_PER_S = 1 / 1200;

export interface TrackEvolutionSample {
  /** Surface grip multiplier from rubber buildup vs off-line marbles and wet groove inversion (0.82..1.03) */
  gripMultiplier: number;
  /** Off-line marble density at the queried lateral offset (0..1) */
  marbleLevel: number;
  /** Local rubber saturation on the racing line (0..1) */
  rubberLevel: number;
  /** Local track surface temperature (°C) */
  trackTempC: number;
  /** Optional alias for trackTempC (°C) */
  trackSurfaceTempC?: number;
  /** Effective vertical contact load multiplier on loose marbles (0.935..1.0) */
  effectiveLoadMultiplier?: number;
  /** Signed wet-groove grip penalty on the polished racing line when wet (<= 0) */
  grooveWetPenalty?: number;
}

export const DEFAULT_TRACK_EVOLUTION_SAMPLE: TrackEvolutionSample = {
  gripMultiplier: 1,
  marbleLevel: 0,
  rubberLevel: BASELINE_RUBBER,
  trackTempC: TRACK_EVOLUTION_BASE_C,
  trackSurfaceTempC: TRACK_EVOLUTION_BASE_C,
  effectiveLoadMultiplier: 1,
  grooveWetPenalty: 0,
};

/** 4-channel per-sector surface state snapshot (groove, marbles, water depth, temperature delta) */
export interface SurfaceStateSnapshot {
  version: 1;
  sectors: number;
  groove: number[];
  marbles: number[];
  waterDepthMm: number[];
  tempDeltaC: number[];
}

export class TrackEvolutionState {
  public readonly trackLengthM: number;
  public readonly racingLineRubber = new Float64Array(TRACK_EVOLUTION_SECTORS);
  public readonly offLineMarbles = new Float64Array(TRACK_EVOLUTION_SECTORS);
  public readonly sectorTempDeltaC = new Float64Array(TRACK_EVOLUTION_SECTORS);
  public baseTrackTempC: number;
  /** Dynamic road evolution rate scale (1 = normal, 0 = static) */
  public timeScale = 1;

  constructor(trackLengthM: number, baseTrackTempC = TRACK_EVOLUTION_BASE_C) {
    this.trackLengthM = Math.max(100, trackLengthM);
    this.baseTrackTempC = baseTrackTempC;
    this.reset();
  }

  public reset(initialRubber: number | SurfaceGripPresetId = BASELINE_RUBBER): void {
    const r =
      typeof initialRubber === 'string'
        ? (SURFACE_GRIP_PRESET_RUBBER[initialRubber] ?? BASELINE_RUBBER)
        : initialRubber;
    this.racingLineRubber.fill(Math.min(1, Math.max(0, r)));
    this.offLineMarbles.fill(0);
    this.sectorTempDeltaC.fill(0);
  }

  private sectorIndex(sMeters: number): number {
    const u = (((sMeters / this.trackLengthM) % 1) + 1) % 1;
    return Math.min(TRACK_EVOLUTION_SECTORS - 1, Math.floor(u * TRACK_EVOLUTION_SECTORS));
  }

  /**
   * Deposits tire rubber along the racing line and sheds marbles off-line as a car drives over a sector.
   */
  public depositCarPass(
    sMeters: number,
    lateralOffsetM: number,
    racingLineLatM: number,
    slipPowerW: number,
    dt: number
  ): void {
    // A non-finite input (a car mid-reset) must not poison a sector for the rest of the session
    if (![sMeters, lateralOffsetM, racingLineLatM, slipPowerW, dt].every(Number.isFinite) || dt <= 0) return;
    if (this.timeScale <= 0) return;
    const scaledDt = dt * this.timeScale;
    const idx = this.sectorIndex(sMeters);
    const distFromLine = Math.abs(lateralOffsetM - racingLineLatM);
    const energyJ = Math.max(0, slipPowerW) * scaledDt;

    if (distFromLine <= 2.4) {
      // On the racing line: lay down warm rubber (dampened by existing dust/marbles) and sweep away loose marbles
      const dustDamp = 1 - GROOVE_DUST_DAMPING * this.offLineMarbles[idx];
      const rubberInc =
        (RUBBER_BASE_RATE_PER_S * scaledDt + energyJ * 2.2e-9) *
        dustDamp *
        (1 - this.racingLineRubber[idx]);
      this.racingLineRubber[idx] = Math.min(1, this.racingLineRubber[idx] + rubberInc);
      this.offLineMarbles[idx] = Math.max(0, this.offLineMarbles[idx] - 2.0e-5 * scaledDt);
    } else {
      // Driving off-line sweeps a small fraction of marbles off the line
      this.offLineMarbles[idx] = Math.max(0, this.offLineMarbles[idx] - 1.2e-4 * scaledDt);
    }

    // High sliding power in corners sheds rubber marbles outward onto the off-line surface
    if (slipPowerW > 12_000) {
      const marbleShed = (slipPowerW - 12_000) * scaledDt * 1.4e-8;
      this.offLineMarbles[idx] = Math.min(1, this.offLineMarbles[idx] + marbleShed);
    }

    // Local asphalt frictional heating
    this.sectorTempDeltaC[idx] = Math.min(
      4.5,
      Math.max(0, this.sectorTempDeltaC[idx] + energyJ * 4.0e-9 - 0.008 * scaledDt * this.sectorTempDeltaC[idx])
    );
  }

  /**
   * Rain washes the track: the rubber laid on the line is rinsed back toward a green track and the marbles off it are
   * swept away, at a rate set by the rain intensity (0..1). After a shower the line has to rubber in again.
   */
  public weatherWash(rainIntensity: number, dt: number): void {
    if (!(rainIntensity > 0) || !(dt > 0) || !Number.isFinite(rainIntensity + dt)) return;
    if (this.timeScale <= 0) return;
    const k = 1 - Math.exp(-WASH_RATE_PER_S * Math.min(1, rainIntensity) * dt * this.timeScale);
    for (let i = 0; i < TRACK_EVOLUTION_SECTORS; i++) {
      this.racingLineRubber[i] += (WASHED_RUBBER - this.racingLineRubber[i]) * k;
      this.offLineMarbles[i] *= Math.max(0, 1 - 3 * k);
      this.sectorTempDeltaC[i] *= Math.max(0, 1 - 3 * k);
    }
  }

  /**
   * Evaluates the surface grip multiplier, marble level, and local track temperature at `(sMeters, lateralOffsetM)`.
   * At baseline (`racingLineRubber = 0.65`, `offLineMarbles = 0`, `wetness = 0`), `gripMultiplier` is `1.00`.
   * When `wetness > 0.18`, the rubbered-in dry racing line becomes slicker than unrubbered off-line tarmac.
   */
  public sample(
    sMeters: number,
    lateralOffsetM: number,
    racingLineLatM: number,
    wetness = 0,
    wetSeverity = 1
  ): TrackEvolutionSample {
    if (![sMeters, lateralOffsetM, racingLineLatM].every(Number.isFinite)) {
      return { ...DEFAULT_TRACK_EVOLUTION_SAMPLE, trackTempC: this.baseTrackTempC, trackSurfaceTempC: this.baseTrackTempC };
    }
    const idx = this.sectorIndex(sMeters);
    const rubber = this.racingLineRubber[idx];
    const marbles = this.offLineMarbles[idx];
    const distFromLine = Math.abs(lateralOffsetM - racingLineLatM);

    // Gaussian groove width around the racing line (~2.1 m half-width)
    const onLineWeight = Math.exp(-(distFromLine * distFromLine) / (2 * 2.1 * 2.1));
    const offLineWeight = 1 - onLineWeight;

    // Linear + quadratic groove grip curve (`RoadGrooveGripEffect` + `RoadGrooveSqrdGripEffect`):
    // Zero at BASELINE_RUBBER (0.65), +2.3% at 1.0 saturation, -4.3% on green track (0.0)
    const dr = rubber - BASELINE_RUBBER;
    const dryGrooveDelta = 0.072 * dr - 0.015 * dr * Math.abs(dr);
    // Fade the dry groove grip bonus as water fills the pores, then apply the wet-groove inversion penalty
    const wet = Math.min(1, Math.max(0, Number.isFinite(wetness) ? wetness : 0));
    const dryGrooveContribution = onLineWeight * dryGrooveDelta * (1 - 0.75 * wet);
    const grooveWetPenalty = wetGrooveGripEffect(rubber, wet, onLineWeight, wetSeverity);

    // Off-line marble penalty (up to -7.5% grip when marbles accumulate outside the groove)
    const marbleLevel = offLineWeight * marbles;
    const marblePenalty = marbleLevel * 0.075;
    const effectiveLoadMultiplier = marbleLoadEffect(marbleLevel);

    const gripMultiplier = Math.max(
      0.82,
      Math.min(1.03, 1 + dryGrooveContribution + grooveWetPenalty - marblePenalty)
    );

    const trackTempC = this.baseTrackTempC + this.sectorTempDeltaC[idx];
    return {
      gripMultiplier,
      marbleLevel,
      rubberLevel: rubber,
      trackTempC,
      trackSurfaceTempC: trackTempC,
      effectiveLoadMultiplier,
      grooveWetPenalty,
    };
  }

  /** Exports the 4-property per-sector surface state (groove, marbles, water depth, temperature delta) */
  public exportSurfaceState(lineWaterMm?: ArrayLike<number>): SurfaceStateSnapshot {
    const water: number[] = [];
    for (let i = 0; i < TRACK_EVOLUTION_SECTORS; i++) {
      water.push(lineWaterMm && i < lineWaterMm.length ? Number(lineWaterMm[i]) : 0);
    }
    return {
      version: 1,
      sectors: TRACK_EVOLUTION_SECTORS,
      groove: Array.from(this.racingLineRubber),
      marbles: Array.from(this.offLineMarbles),
      waterDepthMm: water,
      tempDeltaC: Array.from(this.sectorTempDeltaC),
    };
  }

  /** Imports a previously saved 4-property per-sector surface state */
  public importSurfaceState(snapshot: SurfaceStateSnapshot): void {
    if (!snapshot || snapshot.sectors !== TRACK_EVOLUTION_SECTORS) return;
    for (let i = 0; i < TRACK_EVOLUTION_SECTORS; i++) {
      if (Number.isFinite(snapshot.groove[i])) {
        this.racingLineRubber[i] = Math.min(1, Math.max(0, snapshot.groove[i]));
      }
      if (Number.isFinite(snapshot.marbles[i])) {
        this.offLineMarbles[i] = Math.min(1, Math.max(0, snapshot.marbles[i]));
      }
      if (Number.isFinite(snapshot.tempDeltaC[i])) {
        this.sectorTempDeltaC[i] = Math.min(10, Math.max(-10, snapshot.tempDeltaC[i]));
      }
    }
  }
}

export interface RigidBodyCollisionCar {
  /** World horizontal position (x, z) in Three.js Y-up coordinates, plus vertical y (m) */
  x: number;
  y: number;
  z: number;
  /** World unit forward vector (fx, fz) in the horizontal (X, Z) plane */
  fwdX: number;
  fwdZ: number;
  /** World horizontal velocity (vx, vz) in (X, Z) plane (m/s) */
  vx: number;
  vz: number;
  /** Yaw angular velocity around vertical Y axis (rad/s, + = CCW from above / turning left) */
  yawRateRadS: number;
  /** Total mass (kg) */
  massKg: number;
  /** Yaw moment of inertia I_yy (kg·m²) */
  yawInertiaKgM2: number;
  /** Half-length of car OBB (m) */
  halfLengthM: number;
  /** Half-width of car OBB (m) */
  halfWidthM: number;
}

export interface ObbCollisionResolution {
  collided: boolean;
  /** Penetration depth (m) */
  penetrationM: number;
  /** Unit collision normal pointing from Car A to Car B in (X, Z) */
  nx: number;
  nz: number;
  /** Normal closing speed at the contact point (m/s) */
  impactSpeedMs: number;
  /** Position correction for Car A (m) */
  posDeltaA: [number, number];
  /** Position correction for Car B (m) */
  posDeltaB: [number, number];
  /** World (X, Z) linear velocity delta for Car A (m/s) */
  velDeltaA: [number, number];
  /** World (X, Z) linear velocity delta for Car B (m/s) */
  velDeltaB: [number, number];
  /** Yaw angular velocity delta for Car A (rad/s, + = CCW from above) */
  yawDeltaA: number;
  /** Yaw angular velocity delta for Car B (rad/s, + = CCW from above) */
  yawDeltaB: number;
}

/** Largest position correction per car per call (m) */
const OBB_MAX_SEPARATION_M = 0.25;

const NO_COLLISION: ObbCollisionResolution = {
  collided: false,
  penetrationM: 0,
  nx: 0,
  nz: 0,
  impactSpeedMs: 0,
  posDeltaA: [0, 0],
  posDeltaB: [0, 0],
  velDeltaA: [0, 0],
  velDeltaB: [0, 0],
  yawDeltaA: 0,
  yawDeltaB: 0,
};

/**
 * Resolves a 3D Oriented Bounding Box (OBB) rigid-body collision between two cars using the
 * Separating Axis Theorem (SAT) and impulse-momentum mechanics with rotational lever arms (r × J).
 */
export function resolveCarToCarObbCollision(
  A: RigidBodyCollisionCar,
  B: RigidBodyCollisionCar,
  restitution = 0.22,
  friction = 0.28
): ObbCollisionResolution {
  // Quick vertical & bounding-sphere rejection
  if (!(Math.abs(A.y - B.y) <= 1.4)) return NO_COLLISION;
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  const maxRad = A.halfLengthM + B.halfLengthM + 0.5;
  // (written so a NaN position is no contact)
  if (!(dx * dx + dz * dz <= maxRad * maxRad)) return NO_COLLISION;

  // Orthonormal 2D axes for Car A and Car B in (X, Z):
  // Forward = (fwdX, fwdZ), Left = (fwdZ, -fwdX)
  const aFx = A.fwdX;
  const aFz = A.fwdZ;
  const aLx = A.fwdZ;
  const aLz = -A.fwdX;

  const bFx = B.fwdX;
  const bFz = B.fwdZ;
  const bLx = B.fwdZ;
  const bLz = -B.fwdX;

  let minOverlap = Infinity;
  let bestNx = 0;
  let bestNz = 0;

  // The four candidate separating axes: A forward, A left, B forward, B left
  for (let i = 0; i < 4; i++) {
    let ux = i === 0 ? aFx : i === 1 ? aLx : i === 2 ? bFx : bLx;
    let uz = i === 0 ? aFz : i === 1 ? aLz : i === 2 ? bFz : bLz;
    const len = Math.hypot(ux, uz);
    if (len < 1e-6) continue;
    ux /= len;
    uz /= len;

    const projA =
      A.halfLengthM * Math.abs(ux * aFx + uz * aFz) +
      A.halfWidthM * Math.abs(ux * aLx + uz * aLz);
    const projB =
      B.halfLengthM * Math.abs(ux * bFx + uz * bFz) +
      B.halfWidthM * Math.abs(ux * bLx + uz * bLz);
    const centerDist = dx * ux + dz * uz;
    const overlap = projA + projB - Math.abs(centerDist);
    if (overlap <= 0) {
      return NO_COLLISION;
    }
    if (overlap < minOverlap) {
      minOverlap = overlap;
      const sign = centerDist >= 0 ? 1 : -1;
      bestNx = ux * sign;
      bestNz = uz * sign;
    }
  }

  // Approximate contact point midway across both the normal overlap and tangent overlap region
  const contactDistA =
    A.halfLengthM * Math.abs(bestNx * aFx + bestNz * aFz) +
    A.halfWidthM * Math.abs(bestNx * aLx + bestNz * aLz) -
    0.5 * minOverlap;
  const perpX = -bestNz;
  const perpZ = bestNx;
  const extAt =
    A.halfLengthM * Math.abs(perpX * aFx + perpZ * aFz) +
    A.halfWidthM * Math.abs(perpX * aLx + perpZ * aLz);
  const extBt =
    B.halfLengthM * Math.abs(perpX * bFx + perpZ * bFz) +
    B.halfWidthM * Math.abs(perpX * bLx + perpZ * bLz);
  const dtCenter = dx * perpX + dz * perpZ;
  const tMin = Math.max(-extAt, dtCenter - extBt);
  const tMax = Math.min(extAt, dtCenter + extBt);
  const contactTangentA = 0.5 * (tMin + tMax);

  const cx = A.x + bestNx * contactDistA + perpX * contactTangentA;
  const cz = A.z + bestNz * contactDistA + perpZ * contactTangentA;

  const rAx = cx - A.x;
  const rAz = cz - A.z;
  const rBx = cx - B.x;
  const rBz = cz - B.z;

  // In Y-up (X, Y, Z), ω = (0, yawRate, 0), so ω × r = (yawRate * r_z, 0, -yawRate * r_x)
  const vpAx = A.vx + A.yawRateRadS * rAz;
  const vpAz = A.vz - A.yawRateRadS * rAx;
  const vpBx = B.vx + B.yawRateRadS * rBz;
  const vpBz = B.vz - B.yawRateRadS * rBx;

  const rvx = vpBx - vpAx;
  const rvz = vpBz - vpAz;
  const vn = rvx * bestNx + rvz * bestNz;

  // Position separation so cars never stay interpenetrating (at most OBB_MAX_SEPARATION_M per car per call, so a
  // deep overlap, e.g. after a teleport, is worked out over a few frames instead of launching the cars)
  const sep = Math.min(OBB_MAX_SEPARATION_M, 0.5 * minOverlap + 0.012);
  const posDeltaA: [number, number] = [-bestNx * sep, -bestNz * sep];
  const posDeltaB: [number, number] = [bestNx * sep, bestNz * sep];

  if (vn >= 0) {
    // Already separating, apply position resolution only
    return {
      collided: true,
      penetrationM: minOverlap,
      nx: bestNx,
      nz: bestNz,
      impactSpeedMs: 0,
      posDeltaA,
      posDeltaB,
      velDeltaA: [0, 0],
      velDeltaB: [0, 0],
      yawDeltaA: 0,
      yawDeltaB: 0,
    };
  }

  // Cross product (r × n)_y in Y-up = r_z * n_x - r_x * n_z
  const rnA = rAz * bestNx - rAx * bestNz;
  const rnB = rBz * bestNx - rBx * bestNz;
  const invMassA = 1 / Math.max(100, A.massKg);
  const invMassB = 1 / Math.max(100, B.massKg);
  const invIa = 1 / Math.max(100, A.yawInertiaKgM2);
  const invIb = 1 / Math.max(100, B.yawInertiaKgM2);

  const invEffMassN = invMassA + invMassB + rnA * rnA * invIa + rnB * rnB * invIb;
  const jn = (-(1 + restitution) * vn) / invEffMassN;

  // Tangential friction impulse
  let tx = rvx - vn * bestNx;
  let tz = rvz - vn * bestNz;
  const vt = Math.hypot(tx, tz);
  let jt = 0;
  if (vt > 1e-4) {
    tx /= vt;
    tz /= vt;
    const rtA = rAz * tx - rAx * tz;
    const rtB = rBz * tx - rBx * tz;
    const invEffMassT = invMassA + invMassB + rtA * rtA * invIa + rtB * rtB * invIb;
    jt = Math.max(-friction * jn, Math.min(friction * jn, -vt / invEffMassT));
  }

  const jx = jn * bestNx + jt * tx;
  const jz = jn * bestNz + jt * tz;

  // Torque around +Y axis: (r × J)_y = r_z * J_x - r_x * J_z
  const torqueYa = -(rAz * jx - rAx * jz);
  const torqueYb = rBz * jx - rBx * jz;

  return {
    collided: true,
    penetrationM: minOverlap,
    nx: bestNx,
    nz: bestNz,
    impactSpeedMs: -vn,
    posDeltaA,
    posDeltaB,
    velDeltaA: [-jx * invMassA, -jz * invMassA],
    velDeltaB: [jx * invMassB, jz * invMassB],
    yawDeltaA: torqueYa * invIa,
    yawDeltaB: torqueYb * invIb,
  };
}
