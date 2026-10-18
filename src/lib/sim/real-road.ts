/**
 * `RealRoad` / `LiveTrack` Dynamic Track Surface Evolution & 3D OBB Car-to-Car Rigid-Body Collision Solver
 * (`src/lib/sim/real-road.ts`)
 *
 * Implements:
 * 1. `RealRoadState`: Per-sector dynamic track evolution (rFactor 2 `RealRoad` / PMR `LiveTrack` style):
 *    - Racing-line rubber buildup (`racingLineRubber`) from tire shear work, increasing on-line grip.
 *    - Off-line rubber marble shedding (`offLineMarbles`) from tire wear in corners, reducing off-line
 *      grip and feeding `ac-tyre.ts` `stepDirtyLevel` marble pickup when driving off-line.
 *    - Local track surface temperature evolution.
 * 2. `resolveCarToCarObbCollision`: Full 2D/3D Oriented Bounding Box (OBB) Separating Axis Theorem (SAT)
 *    collision detector and rigid-body linear + angular impulse (r × J) solver.
 */

export const REAL_ROAD_SECTORS = 64;
const BASELINE_RUBBER = 0.65;
/** Base track surface temperature (°C): the cars' own default (F1Physics2026 / VehiclePhysics), so the field's samples
 * don't cool the track */
export const REAL_ROAD_BASE_TRACK_C = 41;
/** Rubber laid per second by a car on the line, before the slip-energy part (the base rate of a 60 Hz caller) */
const RUBBER_BASE_RATE_PER_S = 9.0e-4;

export interface RealRoadSectorQuery {
  /** Surface grip multiplier from rubber buildup vs off-line marbles (0.91..1.025) */
  gripMultiplier: number;
  /** Off-line marble density at the queried lateral offset (0..1) */
  marbleLevel: number;
  /** Local rubber saturation on the racing line (0..1) */
  rubberLevel: number;
  /** Local track surface temperature (°C) */
  trackTempC: number;
  /** Optional alias for trackTempC (°C) */
  trackSurfaceTempC?: number;
}

export const DEFAULT_REAL_ROAD_QUERY: RealRoadSectorQuery = {
  gripMultiplier: 1,
  marbleLevel: 0,
  rubberLevel: BASELINE_RUBBER,
  trackTempC: REAL_ROAD_BASE_TRACK_C,
  trackSurfaceTempC: REAL_ROAD_BASE_TRACK_C,
};

export class RealRoadState {
  public readonly trackLengthM: number;
  public readonly racingLineRubber = new Float64Array(REAL_ROAD_SECTORS);
  public readonly offLineMarbles = new Float64Array(REAL_ROAD_SECTORS);
  public readonly sectorTempDeltaC = new Float64Array(REAL_ROAD_SECTORS);
  public baseTrackTempC: number;

  constructor(trackLengthM: number, baseTrackTempC = REAL_ROAD_BASE_TRACK_C) {
    this.trackLengthM = Math.max(100, trackLengthM);
    this.baseTrackTempC = baseTrackTempC;
    this.reset();
  }

  public reset(initialRubber = BASELINE_RUBBER): void {
    this.racingLineRubber.fill(initialRubber);
    this.offLineMarbles.fill(0);
    this.sectorTempDeltaC.fill(0);
  }

  private sectorIndex(sMeters: number): number {
    const u = (((sMeters / this.trackLengthM) % 1) + 1) % 1;
    return Math.min(REAL_ROAD_SECTORS - 1, Math.floor(u * REAL_ROAD_SECTORS));
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
    const idx = this.sectorIndex(sMeters);
    const distFromLine = Math.abs(lateralOffsetM - racingLineLatM);
    const energyJ = Math.max(0, slipPowerW) * dt;

    if (distFromLine <= 2.4) {
      // On the racing line: lay down warm rubber and sweep away loose marbles
      const rubberInc = (RUBBER_BASE_RATE_PER_S * dt + energyJ * 2.2e-9) * (1 - this.racingLineRubber[idx]);
      this.racingLineRubber[idx] = Math.min(1, this.racingLineRubber[idx] + rubberInc);
      this.offLineMarbles[idx] = Math.max(0, this.offLineMarbles[idx] - 2.0e-5 * dt);
    } else {
      // Driving off-line sweeps a small fraction of marbles off the line
      this.offLineMarbles[idx] = Math.max(0, this.offLineMarbles[idx] - 1.2e-4 * dt);
    }

    // High sliding power in corners sheds rubber marbles outward onto the off-line surface
    if (slipPowerW > 12_000) {
      const marbleShed = (slipPowerW - 12_000) * dt * 1.4e-8;
      this.offLineMarbles[idx] = Math.min(1, this.offLineMarbles[idx] + marbleShed);
    }

    // Local asphalt frictional heating
    this.sectorTempDeltaC[idx] = Math.min(
      4.5,
      Math.max(0, this.sectorTempDeltaC[idx] + energyJ * 4.0e-9 - 0.008 * dt * this.sectorTempDeltaC[idx])
    );
  }

  /**
   * Evaluates the RealRoad surface grip multiplier, marble level, and local track temperature at `(sMeters, lateralOffsetM)`.
   * At baseline (`racingLineRubber = 0.65`, `offLineMarbles = 0`), `gripMultiplier` is `1.00`.
   */
  public sample(sMeters: number, lateralOffsetM: number, racingLineLatM: number): RealRoadSectorQuery {
    if (![sMeters, lateralOffsetM, racingLineLatM].every(Number.isFinite)) {
      return { ...DEFAULT_REAL_ROAD_QUERY, trackTempC: this.baseTrackTempC, trackSurfaceTempC: this.baseTrackTempC };
    }
    const idx = this.sectorIndex(sMeters);
    const rubber = this.racingLineRubber[idx];
    const marbles = this.offLineMarbles[idx];
    const distFromLine = Math.abs(lateralOffsetM - racingLineLatM);

    // Gaussian groove width around the racing line (~2.1 m half-width)
    const onLineWeight = Math.exp(-(distFromLine * distFromLine) / (2 * 2.1 * 2.1));
    const offLineWeight = 1 - onLineWeight;

    // On-line grip bonus relative to baseline 0.65 rubber (+2.5% at 1.0 saturation, -3.5% on green track 0.0)
    const rubberDeltaGrip = (rubber - BASELINE_RUBBER) * 0.07;
    // Off-line marble penalty (up to -7.5% grip when marbles accumulate outside the groove)
    const marbleLevel = offLineWeight * marbles;
    const marblePenalty = marbleLevel * 0.075;

    const gripMultiplier = Math.max(0.88, Math.min(1.03, 1 + onLineWeight * rubberDeltaGrip - marblePenalty));

    const trackTempC = this.baseTrackTempC + this.sectorTempDeltaC[idx];
    return {
      gripMultiplier,
      marbleLevel,
      rubberLevel: rubber,
      trackTempC,
      trackSurfaceTempC: trackTempC,
    };
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
