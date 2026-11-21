/**
 * Live 3D Double Wishbone + Steering Tie-Rod Kinematics Solver & Chassis Torsion
 * (`src/lib/sim/suspension-kinematics.ts`)
 *
 * Implements 3D double-wishbone and pushrod/pullrod linkage geometry:
 * - Solves 3D upper wishbone (`WBCAR_TOP_FRONT/REAR`, `WBTYRE_TOP`) and lower wishbone
 *   (`WBCAR_BOTTOM_FRONT/REAR`, `WBTYRE_BOTTOM`) ball-joint positions as a function of vertical wheel
 *   travel `zBumpM` using Rodrigues' 3D axis rotation and rigid upright distance constraints.
 * - Computes the live 3D kingpin axis (`WBTYRE_TOP - WBTYRE_BOTTOM`), Kingpin Inclination (KPI),
 *   caster angle, mechanical caster trail `casterTrailM`, and scrub radius `scrubRadiusM`.
 * - Solves 3D tie-rod steering kinematics (`WBCAR_STEER`, `WBTYRE_STEER`) for non-linear Ackermann
 *   inner/outer wheel steer angles and kinematic bump steer (dynamic toe).
 * - Computes live Front-View Instant Centres (FVIC) for left and right corners to determine dynamic
 *   roll-centre height `rollCentreHeightM` and lateral roll-centre migration `rollCentreLatOffsetM`.
 * - Computes Side-View Instant Centres (SVIC) from inclined wishbone axes to evaluate anti-dive
 *   (front braking) and anti-squat (rear traction) vertical link reaction forces.
 * - Models pushrod / pullrod bellcrank rocker motion ratio `motionRatio(zBumpM)`.
 * - Solves the upright as a rigid body (kingpin from the ball joints, turned about it until the tie rod is at its
 *   length for the rack position) for the exact camber `uprightCamberRad`, road-wheel angle `wheelSteerRad` (Ackermann
 *   and bump steer from the arm geometry), kingpin scrub / trail at the ground, and the paths of the contact patch and
 *   the hub per unit of travel (`contact*PerBump`, `hub*PerBump`): the virtual-work coefficients that give a multibody
 *   suspension's roll centre, jacking, anti-dive, anti-squat and anti-lift. The f12026-car / GT3 physics uses these.
 *   `dynamicCamberDeltaRad`, `roadSteerRad`, `bumpSteerToeInRad`, `scrubRadiusM` and the axle's `rollCentreHeightM`
 *   keep their earlier blended forms for the LC26, whose hardpoints carry no tie rod.
 */

export type Vec3Tuple = readonly [number, number, number];

export interface DoubleWishboneHardpoints {
  /** Upper wishbone front chassis pivot [x_inboard, y_up, z_fwd] from wheel center (m) */
  carTopFront: Vec3Tuple;
  /** Upper wishbone rear chassis pivot [x_inboard, y_up, z_fwd] from wheel center (m) */
  carTopRear: Vec3Tuple;
  /** Lower wishbone front chassis pivot [x_inboard, y_up, z_fwd] from wheel center (m) */
  carBottomFront: Vec3Tuple;
  /** Lower wishbone rear chassis pivot [x_inboard, y_up, z_fwd] from wheel center (m) */
  carBottomRear: Vec3Tuple;
  /** Upright upper ball joint [x_inboard, y_up, z_fwd] from wheel center (m) */
  tyreTop: Vec3Tuple;
  /** Upright lower ball joint [x_inboard, y_up, z_fwd] from wheel center (m) */
  tyreBottom: Vec3Tuple;
  /** Steering rack / toe-link inner ball joint [x_inboard, y_up, z_fwd] (m) */
  carSteer: Vec3Tuple;
  /** Upright steering arm ball joint [x_inboard, y_up, z_fwd] (m) */
  tyreSteer: Vec3Tuple;
  /** Tie-rod (toe-link) length from `carSteer` to `tyreSteer` at static (m) */
  tieRodLengthM: number;
  /**
   * Rack travel per radian of commanded road-wheel angle, linearised about straight ahead (m/rad, signed for this
   * steering arm's layout). The rack moves both inner tie-rod joints together, as a pinion does, so each wheel's own
   * angle (and the Ackermann between them) comes out of the arm geometry. Measured on the hardpoints by
   * `buildDoubleWishboneHardpoints`.
   */
  rackTravelPerSteerRad: number;
  /** 1 / the tie rod's |dψ / d rack| at static ride height, straight ahead: `tieRodLeverageNorm` is 1 there */
  tieRodLeverageScale?: number;
  /** Actuation topology ('pull_rod' for modern F1 front, 'push_rod' for rear / GT3) */
  actuation: 'pull_rod' | 'push_rod';
  /** Rocker bellcrank progressive motion ratio slope (per m of bump) */
  rockerProgressivityPerM: number;
  /** The car's static mechanical caster trail (m), which `casterTrailM` adds the kinematic change to */
  staticCasterTrailM: number;
}

export interface CornerKinematicsState {
  /**Solved upper ball joint in wheel-reference frame [x_inboard, y_up, z_fwd] (m) */
  tyreTop: [number, number, number];
  /** Solved lower ball joint in wheel-reference frame [x_inboard, y_up, z_fwd] (m) */
  tyreBottom: [number, number, number];
  /** Dynamic camber change from wishbone + steering KPI/caster geometry (rad, negative = top inward) */
  dynamicCamberDeltaRad: number;
  /**
   * Camber change of the wheel from the solved upright pose (rad, negative = top inward): the wishbones' travel plus
   * the caster / KPI camber of the steer angle, exact for the hardpoints (no blend)
   */
  uprightCamberRad: number;
  /** Kinematic bump steer toe change from tie-rod arc mismatch (rad, + = toe-in) */
  bumpSteerToeInRad: number;
  /** Road wheel steer angle including Ackermann and bump steer (rad, + = left) */
  roadSteerRad: number;
  /**
   * Road-wheel angle of the solved upright (rad, + = left): the tie rod at its length from the rack's position, so the
   * steering arm's Ackermann and the toe link's bump steer are both in it
   */
  wheelSteerRad: number;
  /** Kingpin inclination angle in front view (rad) */
  kpiRad: number;
  /** Caster angle in side view (rad) */
  casterRad: number;
  /** Mechanical caster trail at the ground plane (m, + = kingpin pierces ground ahead of contact patch): the static
   * trail plus the hardpoints' kinematic change with travel */
  casterTrailM: number;
  /**
   * Kingpin scrub radius at the ground plane (m, + = inboard of the contact patch centre): a 22 mm base plus 35 % of
   * the kingpin's ground offset from the hardpoints, held within 8–42 mm (not the raw geometric offset)
   */
  scrubRadiusM: number;
  /** Kingpin axis's ground point inboard of the contact patch centre (m): the hardpoints' own scrub radius */
  kingpinScrubM: number;
  /** Kingpin axis's ground point ahead of the contact patch centre (m): the hardpoints' own mechanical trail */
  kingpinTrailM: number;
  /** Instantaneous pushrod/pullrod rocker motion ratio (normalized to 1.0 at static ride height) */
  motionRatioNorm: number;
  /**
   * The tie rod's leverage on this wheel's steering now against straight ahead at static ride height:
   * (dψ / d rack) × `rackTravelPerSteerRad`. A moment about the kingpin reaches the rack, and so the steering wheel, by
   * this share of what a constant steering ratio gives (the arm's angle to the tie rod changes with lock and bump)
   */
  tieRodLeverageNorm: number;
  /**
   * Contact patch motion per metre of wheel-centre bump, inboard and forward (m/m). These are the front- and side-view
   * swing-arm slopes for a force at the ground (virtual work: a force F there loads the wheel's travel by F · dr/dz):
   * −inboard is tan θ of the front-view instant centre (roll centre, jacking), +forward the anti-dive slope of an
   * outboard brake.
   */
  contactInboardPerBump: number;
  contactForwardPerBump: number;
  /**
   * Wheel-centre motion per metre of its bump, inboard and forward (m/m): the swing-arm slopes for a force at the hub,
   * as a driveshaft's (anti-squat of an inboard drive, Milliken RCVD §17.4) or the unsprung mass's own inertia
   */
  hubInboardPerBump: number;
  hubForwardPerBump: number;
  /** Front-view instant centre [u_inboard, v_up] from wheel center (m) */
  fvic: [number, number];
  /** Side-view pitch slope tan(theta_svic) for anti-dive / anti-squat */
  svicPitchSlope: number;
}

export type CornerKinematicsOutput = CornerKinematicsState;

export interface AxleKinematicsState {
  left: CornerKinematicsState;
  right: CornerKinematicsState;
  /** Dynamic roll-centre height above ground at the axle (m) */
  rollCentreHeightM: number;
  /** Lateral roll-centre migration from car centreline (m, + = left) */
  rollCentreLatOffsetM: number;
  /**
   * Side-view swing-arm slope tan θ at the contact patch, mean of the two wheels (+ = the patch moves forward in bump).
   * Times wheelbase / CG height and the axle's share of the braking force it is the anti-dive fraction of a front axle
   * (+) or the anti-lift fraction of a rear one (−), Milliken RCVD §17.3
   */
  antiPitchFraction: number;
}

import { LC26_CHASSIS } from './lc26-data';

const DEG2RAD = Math.PI / 180;

/** Raw hardpoints [carTopFront, carTopRear, carBottomFront, carBottomRear, tyreTop, tyreBottom] */
type RawHardpoints = ReadonlyArray<readonly [number, number, number]>;

/** F1 (LC26 mod) front / rear double wishbones, used when no raw hardpoints are given (the car's own data) */
const F1_FRONT_HARDPOINTS: RawHardpoints = LC26_CHASSIS.front.hardpoints;
const F1_REAR_HARDPOINTS: RawHardpoints = LC26_CHASSIS.rear.hardpoints;
/**
 * GT3 (Mercedes-AMG GT3 Evo 18" upright & double-wishbone geometry from unpacked reference data, expressed in
 * [x_inboard, y_up, z_fwd] from wheel center):
 * - Front: KPI ≈ 4.7°, Caster ≈ 11.5°, shorter/inclined upper wishbone for negative camber gain in bump
 * - Rear: Double-wishbone + toe link with anti-squat geometry
 */
const GT3_FRONT_HARDPOINTS: RawHardpoints = [
  [0.440, 0.098, 0.197],
  [0.440, 0.072, -0.145],
  [0.487, -0.122, 0.215],
  [0.487, -0.155, -0.155],
  [0.128, 0.135, -0.025],
  [0.098, -0.128, 0.017],
  [0.447, -0.120, 0.160],
  [0.110, -0.112, 0.140],
];
const GT3_REAR_HARDPOINTS: RawHardpoints = [
  [0.440, 0.092, 0.251],
  [0.440, 0.092, -0.123],
  [0.520, -0.125, 0.160],
  [0.520, -0.112, -0.221],
  [0.128, 0.148, 0.052],
  [0.110, -0.112, -0.055],
  [0.505, -0.109, -0.250],
  [0.110, -0.100, -0.165],
];

export interface DoubleWishboneOptions {
  /** Default geometry when no raw hardpoints are given (F1 = the LC26 mod's) */
  geometry?: 'f1' | 'gt3';
  /**
   * The car's static mechanical caster trail (m): the solver reports it plus the kinematic change with travel.
   * Default 0.012 (F1) / 0.025 (GT3).
   */
  staticCasterTrailM?: number;
  /** Rocker leverage growth per m of bump (`motionRatioNorm`); default by actuation, 1.35 pullrod / 1.15 pushrod */
  rockerProgressivityPerM?: number;
}

/**
 * Builds a complete `DoubleWishboneHardpoints` descriptor from the 6-tuple (or 8-tuple with steer link) hardpoints
 * array in `LC26_CHASSIS.front.hardpoints` / `F12026_SUSPENSIONS` / `AMG_GT3_SUSPENSIONS` (or synthesizes default
 * F1/GT3 double-wishbone geometry when raw hardpoints are omitted).
 */
export function buildDoubleWishboneHardpoints(
  rawHardpoints?: RawHardpoints,
  isFront = true,
  actuation: 'pull_rod' | 'push_rod' = isFront ? 'pull_rod' : 'push_rod',
  options: DoubleWishboneOptions = {}
): DoubleWishboneHardpoints {
  const gt3 = options.geometry === 'gt3';
  const hp =
    rawHardpoints && rawHardpoints.length >= 6
      ? rawHardpoints
      : gt3
        ? isFront
          ? GT3_FRONT_HARDPOINTS
          : GT3_REAR_HARDPOINTS
        : isFront
          ? F1_FRONT_HARDPOINTS
          : F1_REAR_HARDPOINTS;

  // Steering tie-rod / rear toe-link attachments (use unpacked points [6],[7] when provided)
  const carSteer: Vec3Tuple =
    hp.length >= 8
      ? hp[6]
      : isFront
        ? [0.666, 0.014, -0.082]
        : [0.718, 0.008, -0.075];
  const tyreSteer: Vec3Tuple =
    hp.length >= 8
      ? hp[7]
      : isFront
        ? [0.096, -0.009, -0.074]
        : [0.104, 0.014, -0.072];

  const out: DoubleWishboneHardpoints = {
    carTopFront: hp[0],
    carTopRear: hp[1],
    carBottomFront: hp[2],
    carBottomRear: hp[3],
    tyreTop: hp[4],
    tyreBottom: hp[5],
    carSteer,
    tyreSteer,
    tieRodLengthM: Math.hypot(tyreSteer[0] - carSteer[0], tyreSteer[1] - carSteer[1], tyreSteer[2] - carSteer[2]),
    rackTravelPerSteerRad: 1,
    actuation,
    rockerProgressivityPerM: options.rockerProgressivityPerM ?? (actuation === 'pull_rod' ? 1.35 : 1.15),
    staticCasterTrailM: options.staticCasterTrailM ?? (gt3 ? 0.025 : 0.012),
  };
  // Rack ratio: with 1 m per "radian", a 1 mm nudge of the rack reads straight off the left wheel's solved angle
  const nudgeM = 0.001;
  const nudged = solveCornerKinematics3D(out, 0, nudgeM, true, 0.33).wheelSteerRad;
  out.rackTravelPerSteerRad = Math.abs(nudged) > 1e-6 ? nudgeM / nudged : 0;
  out.tieRodLeverageScale = 1;
  const lev = solveCornerKinematics3D(out, 0, 0, true, 0.33).tieRodLeverageNorm;
  out.tieRodLeverageScale = lev > 0 ? 1 / lev : undefined;
  return out;
}

/** Rotate vector `v` around unit axis `k` by `angleRad` (Rodrigues' formula); `dOut` gets d(out)/d(angle) */
function rotateAroundAxis(
  vx: number,
  vy: number,
  vz: number,
  kx: number,
  ky: number,
  kz: number,
  angleRad: number,
  out: [number, number, number],
  dOut?: [number, number, number]
): void {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const dot = kx * vx + ky * vy + kz * vz;
  const cx = ky * vz - kz * vy;
  const cy = kz * vx - kx * vz;
  const cz = kx * vy - ky * vx;
  out[0] = vx * c + cx * s + kx * dot * (1 - c);
  out[1] = vy * c + cy * s + ky * dot * (1 - c);
  out[2] = vz * c + cz * s + kz * dot * (1 - c);
  if (dOut) {
    dOut[0] = -vx * s + cx * c + kx * dot * s;
    dOut[1] = -vy * s + cy * c + ky * dot * s;
    dOut[2] = -vz * s + cz * c + kz * dot * s;
  }
}

const _rotU: [number, number, number] = [0, 0, 0];
const _rotL: [number, number, number] = [0, 0, 0];
const _dRot: [number, number, number] = [0, 0, 0];
const _dRotL: [number, number, number] = [0, 0, 0];
const _dRotU: [number, number, number] = [0, 0, 0];
const _armA: [number, number, number] = [0, 0, 0];
const _axisA: [number, number, number] = [0, 0, 0];
const _hubA: [number, number, number] = [0, 0, 0];
const _armS: [number, number, number] = [0, 0, 0];
const _spin: [number, number, number] = [0, 0, 0];
const _hub: [number, number, number] = [0, 0, 0];

const TWO_PI = 2 * Math.PI;

/** Wrap an angle in [-2π, 2π] to (−π, π] without trig calls */
function fastWrapAngle(a: number): number {
  if (a > Math.PI) return a - TWO_PI;
  if (a <= -Math.PI) return a + TWO_PI;
  return a;
}

/** Rotate `v` about unit axis `k` by the angle whose cosine and sine are `c`, `s` (Rodrigues) */
function rotateCosSin(
  vx: number,
  vy: number,
  vz: number,
  kx: number,
  ky: number,
  kz: number,
  c: number,
  s: number,
  out: [number, number, number]
): void {
  const dot = kx * vx + ky * vy + kz * vz;
  out[0] = vx * c + (ky * vz - kz * vy) * s + kx * dot * (1 - c);
  out[1] = vy * c + (kz * vx - kx * vz) * s + ky * dot * (1 - c);
  out[2] = vz * c + (kx * vy - ky * vx) * s + kz * dot * (1 - c);
}

/**
 * 1D bump-travel LUT for a `DoubleWishboneHardpoints` geometry.
 *
 * All wishbone Newton iterations, upright alignment transforms, hinge velocities, and the
 * zero-steer (straight-ahead / rear-axle) tie-rod pose depend solely on `(hp, zBumpM)` and
 * are independent of `rackTravelPerSteerRad`, `tieRodLeverageScale`, `isLeft`, and
 * `loadedRadiusM`. Precomputing 65 knots across [-80 mm, +80 mm] (2.5 mm spacing, with
 * static z = 0 on an exact knot) eliminates both Newton loops and ~30 trig ops per corner
 * per physics substep while staying within ~2 µm / 1e-5 rad of the direct solver.
 */
const LUT_MIN_Z = -0.08;
const LUT_MAX_Z = 0.08;
const LUT_INTERVALS = 64;
const LUT_SAMPLES = LUT_INTERVALS + 1;
const LUT_INV_DZ = LUT_INTERVALS / (LUT_MAX_Z - LUT_MIN_Z);
const LUT_STRIDE = 39;

interface WishboneBumpLut {
  readonly data: Float64Array;
  readonly kpi0: number;
  readonly svicPitchSlope: number;
  readonly uCarX: number;
  readonly uCarY: number;
  readonly lCarX: number;
  readonly lCarY: number;
  readonly invDy0Dz0: number;
  readonly armSq: number;
  readonly tieRodLenSq: number;
}

const _bumpLutCache = new WeakMap<DoubleWishboneHardpoints, WishboneBumpLut>();

function buildWishboneBumpLut(hp: DoubleWishboneHardpoints): WishboneBumpLut {
  // Lower wishbone hinge axis on the chassis: C_LF -> C_LR
  const lAxX = hp.carBottomRear[0] - hp.carBottomFront[0];
  const lAxY = hp.carBottomRear[1] - hp.carBottomFront[1];
  const lAxZ = hp.carBottomRear[2] - hp.carBottomFront[2];
  const lAxLen = Math.hypot(lAxX, lAxY, lAxZ) || 1;
  const klX = lAxX / lAxLen;
  const klY = lAxY / lAxLen;
  const klZ = lAxZ / lAxLen;

  const rL0x = hp.tyreBottom[0] - hp.carBottomFront[0];
  const rL0y = hp.tyreBottom[1] - hp.carBottomFront[1];
  const rL0z = hp.tyreBottom[2] - hp.carBottomFront[2];
  const liftL = klZ * rL0x - klX * rL0z;
  const armLenL = Math.max(0.2, Math.abs(liftL));
  const liftLSign = Math.sign(liftL || 1);

  // Upper wishbone hinge axis on the chassis: C_UF -> C_UR
  const uAxX = hp.carTopRear[0] - hp.carTopFront[0];
  const uAxY = hp.carTopRear[1] - hp.carTopFront[1];
  const uAxZ = hp.carTopRear[2] - hp.carTopFront[2];
  const uAxLen = Math.hypot(uAxX, uAxY, uAxZ) || 1;
  const kuX = uAxX / uAxLen;
  const kuY = uAxY / uAxLen;
  const kuZ = uAxZ / uAxLen;

  const rU0x = hp.tyreTop[0] - hp.carTopFront[0];
  const rU0y = hp.tyreTop[1] - hp.carTopFront[1];
  const rU0z = hp.tyreTop[2] - hp.carTopFront[2];
  const liftU = kuZ * rU0x - kuX * rU0z;
  const armLenU = Math.max(0.18, Math.abs(liftU));
  const liftUSign = Math.sign(liftU || 1);

  // Rigid upright strut between upper and lower ball joints
  const uprightDx0 = hp.tyreTop[0] - hp.tyreBottom[0];
  const uprightDy0 = hp.tyreTop[1] - hp.tyreBottom[1];
  const uprightDz0 = hp.tyreTop[2] - hp.tyreBottom[2];
  const uprightLenSq = uprightDx0 * uprightDx0 + uprightDy0 * uprightDy0 + uprightDz0 * uprightDz0;
  const k0Len = Math.sqrt(uprightLenSq) || 1;
  const k0x = uprightDx0 / k0Len;
  const k0y = uprightDy0 / k0Len;
  const k0z = uprightDz0 / k0Len;
  const kpi0 = Math.atan2(uprightDx0, uprightDy0);

  const arm0x = hp.tyreSteer[0] - hp.tyreBottom[0];
  const arm0y = hp.tyreSteer[1] - hp.tyreBottom[1];
  const arm0z = hp.tyreSteer[2] - hp.tyreBottom[2];
  const armSq = arm0x * arm0x + arm0y * arm0y + arm0z * arm0z;
  const tieRodLenSq = hp.tieRodLengthM * hp.tieRodLengthM;

  const uCarX = 0.5 * (hp.carTopFront[0] + hp.carTopRear[0]);
  const uCarY = 0.5 * (hp.carTopFront[1] + hp.carTopRear[1]);
  const lCarX = 0.5 * (hp.carBottomFront[0] + hp.carBottomRear[0]);
  const lCarY = 0.5 * (hp.carBottomFront[1] + hp.carBottomRear[1]);

  const svSlopeU = uAxY / Math.max(0.1, Math.abs(uAxZ));
  const svSlopeL = lAxY / Math.max(0.1, Math.abs(lAxZ));
  const svicPitchSlope = 0.5 * (Math.abs(svSlopeU) + Math.abs(svSlopeL));
  const invDy0Dz0 = uprightDz0 / Math.max(0.05, uprightDy0);

  const csX0 = hp.carSteer[0];
  const csY0 = hp.carSteer[1];
  const csZ0 = hp.carSteer[2];

  const data = new Float64Array(LUT_SAMPLES * LUT_STRIDE);

  for (let i = 0; i < LUT_SAMPLES; i++) {
    const z = LUT_MIN_Z + (i / LUT_INTERVALS) * (LUT_MAX_Z - LUT_MIN_Z);

    // 1. Lower wishbone ball joint at bump z
    let thetaL = liftLSign * Math.asin(Math.max(-0.45, Math.min(0.45, z / armLenL)));
    for (let it = 0; it < 3; it++) {
      rotateAroundAxis(rL0x, rL0y, rL0z, klX, klY, klZ, thetaL, _rotL, _dRot);
      const errY = _rotL[1] - rL0y - z;
      if (Math.abs(_dRot[1]) < 1e-4) break;
      thetaL = Math.max(-0.5, Math.min(0.5, thetaL - errY / _dRot[1]));
    }
    rotateAroundAxis(rL0x, rL0y, rL0z, klX, klY, klZ, thetaL, _rotL, _dRotL);
    const botX = hp.carBottomFront[0] + _rotL[0];
    const botY = hp.carBottomFront[1] + _rotL[1];
    const botZ = hp.carBottomFront[2] + _rotL[2];

    // 2. Upper wishbone ball joint keeping rigid upright length
    let thetaU = liftUSign * Math.asin(Math.max(-0.45, Math.min(0.45, z / armLenU)));
    for (let it = 0; it < 4; it++) {
      rotateAroundAxis(rU0x, rU0y, rU0z, kuX, kuY, kuZ, thetaU, _rotU, _dRot);
      const tx = hp.carTopFront[0] + _rotU[0] - botX;
      const ty = hp.carTopFront[1] + _rotU[1] - botY;
      const tz = hp.carTopFront[2] + _rotU[2] - botZ;
      const err = tx * tx + ty * ty + tz * tz - uprightLenSq;
      const deriv = 2 * (tx * _dRot[0] + ty * _dRot[1] + tz * _dRot[2]);
      if (Math.abs(deriv) < 1e-6) break;
      thetaU = Math.max(-0.5, Math.min(0.5, thetaU - err / deriv));
    }
    rotateAroundAxis(rU0x, rU0y, rU0z, kuX, kuY, kuZ, thetaU, _rotU, _dRotU);
    const topX = hp.carTopFront[0] + _rotU[0];
    const topY = hp.carTopFront[1] + _rotU[1];
    const topZ = hp.carTopFront[2] + _rotU[2];

    // 3. Dynamic 3D kingpin vector
    const kx = topX - botX;
    const ky = topY - botY;
    const kz = topZ - botZ;
    const kpiRad = Math.atan2(kx, Math.max(0.05, ky));
    const casterRad = Math.atan2(-kz, Math.max(0.05, ky));

    const kSq = kx * kx + ky * ky + kz * kz;
    const kLen = Math.sqrt(kSq) || 1;
    const k1x = kx / kLen;
    const k1y = ky / kLen;
    const k1z = kz / kLen;

    // 4. Upright alignment k0 -> k1
    let alX = k0y * k1z - k0z * k1y;
    let alY = k0z * k1x - k0x * k1z;
    let alZ = k0x * k1y - k0y * k1x;
    const alSin = Math.hypot(alX, alY, alZ);
    const alCos = k0x * k1x + k0y * k1y + k0z * k1z;
    if (alSin > 1e-12) {
      alX /= alSin;
      alY /= alSin;
      alZ /= alSin;
    } else {
      alX = 1;
      alY = 0;
      alZ = 0;
    }

    rotateCosSin(arm0x, arm0y, arm0z, alX, alY, alZ, alCos, alSin, _armA);
    rotateCosSin(1, 0, 0, alX, alY, alZ, alCos, alSin, _axisA);
    rotateCosSin(-hp.tyreBottom[0], -hp.tyreBottom[1], -hp.tyreBottom[2], alX, alY, alZ, alCos, alSin, _hubA);

    // 5. Hinge velocity & cross-kingpin upright angular velocity per unit bump
    const dBy = Math.abs(_dRotL[1]) > 1e-6 ? _dRotL[1] : 1e-6;
    const vBx = _dRotL[0] / dBy;
    const vBy = _dRotL[1] / dBy;
    const vBz = _dRotL[2] / dBy;
    const dUe = kx * _dRotU[0] + ky * _dRotU[1] + kz * _dRotU[2];
    const thetaURate = Math.abs(dUe) > 1e-9 ? (kx * vBx + ky * vBy + kz * vBz) / dUe : 0;
    const dvX = _dRotU[0] * thetaURate - vBx;
    const dvY = _dRotU[1] * thetaURate - vBy;
    const dvZ = _dRotU[2] * thetaURate - vBz;
    const om0x = (ky * dvZ - kz * dvY) / kSq;
    const om0y = (kz * dvX - kx * dvZ) / kSq;
    const om0z = (kx * dvY - ky * dvX) / kSq;

    // 6. Zero-steer (rackM = 0) tie-rod closure, identical for left/right and independent of loadedRadiusM
    const bcX = botX - csX0;
    const bcY = botY - csY0;
    const bcZ = botZ - csZ0;
    const kArm = k1x * _armA[0] + k1y * _armA[1] + k1z * _armA[2];
    const kBc = k1x * bcX + k1y * bcY + k1z * bcZ;
    const pCos = bcX * _armA[0] + bcY * _armA[1] + bcZ * _armA[2] - kBc * kArm;
    const qSin =
      bcX * (k1y * _armA[2] - k1z * _armA[1]) +
      bcY * (k1z * _armA[0] - k1x * _armA[2]) +
      bcZ * (k1x * _armA[1] - k1y * _armA[0]);
    const rhs = 0.5 * (tieRodLenSq - (bcX * bcX + bcY * bcY + bcZ * bcZ) - armSq) - kBc * kArm;
    const pq = Math.hypot(pCos, qSin);
    let psi0 = 0;
    if (pq > 1e-9) {
      const phase = Math.atan2(qSin, pCos);
      const spread = Math.acos(Math.max(-1, Math.min(1, rhs / pq)));
      const psiA = fastWrapAngle(phase + spread);
      const psiB = fastWrapAngle(phase - spread);
      psi0 = Math.abs(psiA) < Math.abs(psiB) ? psiA : psiB;
    }
    const psiCos0 = Math.cos(psi0);
    const psiSin0 = Math.sin(psi0);
    rotateCosSin(_armA[0], _armA[1], _armA[2], k1x, k1y, k1z, psiCos0, psiSin0, _armS);
    rotateCosSin(_axisA[0], _axisA[1], _axisA[2], k1x, k1y, k1z, psiCos0, psiSin0, _spin);
    rotateCosSin(_hubA[0], _hubA[1], _hubA[2], k1x, k1y, k1z, psiCos0, psiSin0, _hub);

    const wX0 = botX + _hub[0];
    const wY0 = botY + _hub[1];
    const wZ0 = botZ + _hub[2];
    const aX0 = _spin[0];
    const aY0 = _spin[1];
    const aZ0 = _spin[2];
    const uprightCamber0 = Math.asin(Math.max(-1, Math.min(1, aY0)));
    const toeIn0 = Math.atan2(-aZ0, aX0);
    const invGLen0 = 1 / Math.sqrt(Math.max(1e-9, 1 - aY0 * aY0));
    const gUnitX0 = aY0 * aX0 * invGLen0;
    const gUnitY0 = (aY0 * aY0 - 1) * invGLen0;
    const gUnitZ0 = aY0 * aZ0 * invGLen0;

    const rsX = _armS[0];
    const rsY = _armS[1];
    const rsZ = _armS[2];
    const tcX = botX + rsX - csX0;
    const tcY = botY + rsY - csY0;
    const tcZ = botZ + rsZ - csZ0;
    const vsX = vBx + om0y * rsZ - om0z * rsY;
    const vsY = vBy + om0z * rsX - om0x * rsZ;
    const vsZ = vBz + om0x * rsY - om0y * rsX;
    const turnDen =
      tcX * (k1y * rsZ - k1z * rsY) + tcY * (k1z * rsX - k1x * rsZ) + tcZ * (k1x * rsY - k1y * rsX);
    const turnRate0 = Math.abs(turnDen) > 1e-9 ? -(tcX * vsX + tcY * vsY + tcZ * vsZ) / turnDen : 0;
    const absDPsiDRack0 = Math.abs(turnDen) > 1e-9 ? Math.abs(tcX / turnDen) : 0;
    const omX0 = om0x + turnRate0 * k1x;
    const omY0 = om0y + turnRate0 * k1y;
    const omZ0 = om0z + turnRate0 * k1z;
    const vWx0 = vBx + omY0 * _hub[2] - omZ0 * _hub[1];
    const vWy0 = vBy + omZ0 * _hub[0] - omX0 * _hub[2];
    const vWz0 = vBz + omX0 * _hub[1] - omY0 * _hub[0];
    const perHub0 = 1 / (Math.abs(vWy0) > 0.2 ? vWy0 : 1);

    const o = i * LUT_STRIDE;
    data[o] = topX;
    data[o + 1] = topY;
    data[o + 2] = topZ;
    data[o + 3] = botX;
    data[o + 4] = botY;
    data[o + 5] = botZ;
    data[o + 6] = kpiRad;
    data[o + 7] = casterRad;
    data[o + 8] = k1x;
    data[o + 9] = k1y;
    data[o + 10] = k1z;
    data[o + 11] = _armA[0];
    data[o + 12] = _armA[1];
    data[o + 13] = _armA[2];
    data[o + 14] = _axisA[0];
    data[o + 15] = _axisA[1];
    data[o + 16] = _axisA[2];
    data[o + 17] = _hubA[0];
    data[o + 18] = _hubA[1];
    data[o + 19] = _hubA[2];
    data[o + 20] = vBx;
    data[o + 21] = vBy;
    data[o + 22] = vBz;
    data[o + 23] = om0x;
    data[o + 24] = om0y;
    data[o + 25] = om0z;
    data[o + 26] = uprightCamber0;
    data[o + 27] = toeIn0;
    data[o + 28] = wX0;
    data[o + 29] = wY0;
    data[o + 30] = wZ0;
    data[o + 31] = gUnitX0;
    data[o + 32] = gUnitY0;
    data[o + 33] = gUnitZ0;
    data[o + 34] = vWx0 * perHub0;
    data[o + 35] = vWz0 * perHub0;
    data[o + 36] = (omY0 * gUnitZ0 - omZ0 * gUnitY0) * perHub0;
    data[o + 37] = (omX0 * gUnitY0 - omY0 * gUnitX0) * perHub0;
    data[o + 38] = absDPsiDRack0;
  }

  return {
    data,
    kpi0,
    svicPitchSlope,
    uCarX,
    uCarY,
    lCarX,
    lCarY,
    invDy0Dz0,
    armSq,
    tieRodLenSq,
  };
}

function getWishboneBumpLut(hp: DoubleWishboneHardpoints): WishboneBumpLut {
  let lut = _bumpLutCache.get(hp);
  if (!lut) {
    lut = buildWishboneBumpLut(hp);
    _bumpLutCache.set(hp, lut);
  }
  return lut;
}

/** A zeroed corner state to solve into (avoids per-step allocation) */
export function createCornerKinematicsState(): CornerKinematicsState {
  return {
    tyreTop: [0, 0, 0],
    tyreBottom: [0, 0, 0],
    dynamicCamberDeltaRad: 0,
    uprightCamberRad: 0,
    bumpSteerToeInRad: 0,
    roadSteerRad: 0,
    wheelSteerRad: 0,
    kpiRad: 0,
    casterRad: 0,
    casterTrailM: 0,
    scrubRadiusM: 0,
    kingpinScrubM: 0,
    kingpinTrailM: 0,
    motionRatioNorm: 1,
    tieRodLeverageNorm: 1,
    contactInboardPerBump: 0,
    contactForwardPerBump: 0,
    hubInboardPerBump: 0,
    hubForwardPerBump: 0,
    fvic: [1.6, 0.05],
    svicPitchSlope: 0,
  };
}

/** A zeroed axle state to solve into (avoids per-step allocation) */
export function createAxleKinematicsState(): AxleKinematicsState {
  return {
    left: createCornerKinematicsState(),
    right: createCornerKinematicsState(),
    rollCentreHeightM: 0,
    rollCentreLatOffsetM: 0,
    antiPitchFraction: 0,
  };
}

/**
 * Solves the 3D double-wishbone and tie-rod kinematics for a single wheel corner.
 *
 * @param hp Double-wishbone & tie-rod hardpoint coordinates
 * @param zBumpM Vertical wheel travel from static ride height (m, + = bump / compression)
 * @param nominalSteerRad Commanded road-wheel steer angle at the rack (rad, + = left)
 * @param isLeft True for left-hand wheel (FL/RL), false for right-hand wheel (FR/RR)
 * @param loadedRadiusM Current loaded tyre radius (m)
 * @param out Optional state to write into (returned)
 */
export function solveCornerKinematics3D(
  hp: DoubleWishboneHardpoints,
  zBumpM: number,
  nominalSteerRad: number,
  isLeft: boolean,
  loadedRadiusM: number,
  out: CornerKinematicsState = createCornerKinematicsState()
): CornerKinematicsState {
  const z = Math.max(LUT_MIN_Z, Math.min(LUT_MAX_Z, Number.isFinite(zBumpM) ? zBumpM : 0));
  const radius = Math.max(0.2, Number.isFinite(loadedRadiusM) ? loadedRadiusM : 0.33);

  const lut = getWishboneBumpLut(hp);
  const d = lut.data;
  const pos = (z - LUT_MIN_Z) * LUT_INV_DZ;
  let idx = pos | 0;
  if (idx >= LUT_INTERVALS) idx = LUT_INTERVALS - 1;
  const t = pos - idx;
  const o0 = idx * LUT_STRIDE;
  const o1 = o0 + LUT_STRIDE;

  // 1-2. Interpolate solved upper/lower ball joints and kingpin angles from 1D bump LUT
  const topX = d[o0] + (d[o1] - d[o0]) * t;
  const topY = d[o0 + 1] + (d[o1 + 1] - d[o0 + 1]) * t;
  const topZ = d[o0 + 2] + (d[o1 + 2] - d[o0 + 2]) * t;
  const botX = d[o0 + 3] + (d[o1 + 3] - d[o0 + 3]) * t;
  const botY = d[o0 + 4] + (d[o1 + 4] - d[o0 + 4]) * t;
  const botZ = d[o0 + 5] + (d[o1 + 5] - d[o0 + 5]) * t;
  const kpiRad = d[o0 + 6] + (d[o1 + 6] - d[o0 + 6]) * t;
  const casterRad = d[o0 + 7] + (d[o1 + 7] - d[o0 + 7]) * t;

  // 3. Kingpin ground intersection (wheel centre moved with lower ball joint: wheelCenterY - botY = -tyreBottom[1])
  const kx = topX - botX;
  const ky = topY - botY;
  const kz = topZ - botZ;
  const invKy = 1 / Math.max(0.05, ky);
  const sGroundNum = -hp.tyreBottom[1] - radius;
  const sGround = sGroundNum * invKy;
  const kpGroundX = botX + sGround * kx;
  const scrubRadiusM = Math.max(0.008, Math.min(0.042, 0.022 + kpGroundX * 0.35));
  const trailDelta = sGround * kz - sGroundNum * lut.invDy0Dz0;
  const casterTrailM = Math.max(0.002, hp.staticCasterTrailM + Math.max(-0.015, Math.min(0.015, trailDelta)));

  // 4. Kinematic bump steer & Ackermann
  const arcDiffX = (topX - hp.tyreTop[0]) - (botX - hp.tyreBottom[0]);
  const bumpSteerToeInRad = Math.max(-0.006, Math.min(0.006, arcDiffX * 0.12 - z * z * 0.18));
  const bumpSteerLeftRad = isLeft ? -bumpSteerToeInRad : bumpSteerToeInRad;

  let roadSteerRad: number;
  if (nominalSteerRad === 0) {
    roadSteerRad = bumpSteerLeftRad;
  } else {
    const ackermannCoeff = 0.14;
    const sinNom = Math.sin(nominalSteerRad);
    const signedAckermann = isLeft
      ? nominalSteerRad * (1 + ackermannCoeff * sinNom)
      : nominalSteerRad * (1 - ackermannCoeff * sinNom);
    roadSteerRad = signedAckermann + bumpSteerLeftRad;
  }

  // 5. Dynamic camber gain from 3D wishbone rotation + steering caster/KPI camber effect
  const wishboneCamberInwardRad = -(kpiRad - lut.kpi0);
  const sinRoad = Math.sin(roadSteerRad);
  const cosRoad = Math.cos(roadSteerRad);
  const casterCamberSign = isLeft ? sinRoad : -sinRoad;
  const steerCamberInwardRad = casterRad * casterCamberSign * 0.35 + kpiRad * (1 - cosRoad) * 0.5;
  const dynamicCamberDeltaRad = wishboneCamberInwardRad + steerCamberInwardRad;

  // 6. Front-View Instant Centre (FVIC) from live upper and lower wishbone inclinations
  const slopeU = (lut.uCarY - topY) / Math.max(0.1, lut.uCarX - topX);
  const slopeL = (lut.lCarY - botY) / Math.max(0.1, lut.lCarX - botX);
  let icU = 1.6;
  let icV = 0.05;
  if (Math.abs(slopeU - slopeL) > 1e-4) {
    icU = (botY - slopeL * botX - topY + slopeU * topX) / (slopeU - slopeL);
    icV = topY + slopeU * (icU - topX);
  }

  // 8. Pushrod / Pullrod bellcrank rocker progressive motion ratio
  const motionRatioNorm = Math.max(0.85, Math.min(1.28, 1 + hp.rockerProgressivityPerM * z));

  // 9-10. Rigid-body upright pose & velocities per unit bump
  let uprightCamberRad: number;
  let wheelSteerRad: number;
  let kingpinScrubM: number;
  let kingpinTrailM: number;
  let tieRodLeverageNorm: number;
  let contactInboardPerBump: number;
  let contactForwardPerBump: number;
  let hubInboardPerBump: number;
  let hubForwardPerBump: number;

  const levScale = hp.tieRodLeverageScale ?? hp.rackTravelPerSteerRad;

  if (nominalSteerRad === 0) {
    // Fast path for rear wheels (100% of calls) and straight-line front wheels:
    // entire zero-steer tie-rod closure is precomputed in the 1D bump LUT.
    uprightCamberRad = d[o0 + 26] + (d[o1 + 26] - d[o0 + 26]) * t;
    const toeIn0 = d[o0 + 27] + (d[o1 + 27] - d[o0 + 27]) * t;
    wheelSteerRad = isLeft ? -toeIn0 : toeIn0;

    const wX0 = d[o0 + 28] + (d[o1 + 28] - d[o0 + 28]) * t;
    const wY0 = d[o0 + 29] + (d[o1 + 29] - d[o0 + 29]) * t;
    const wZ0 = d[o0 + 30] + (d[o1 + 30] - d[o0 + 30]) * t;
    const gUnitX0 = d[o0 + 31] + (d[o1 + 31] - d[o0 + 31]) * t;
    const gUnitY0 = d[o0 + 32] + (d[o1 + 32] - d[o0 + 32]) * t;
    const gUnitZ0 = d[o0 + 33] + (d[o1 + 33] - d[o0 + 33]) * t;

    const cpX = wX0 + radius * gUnitX0;
    const cpY = wY0 + radius * gUnitY0;
    const cpZ = wZ0 + radius * gUnitZ0;
    const sKp = (cpY - botY) * invKy;
    kingpinScrubM = botX + sKp * kx - cpX;
    kingpinTrailM = botZ + sKp * kz - cpZ;

    hubInboardPerBump = d[o0 + 34] + (d[o1 + 34] - d[o0 + 34]) * t;
    hubForwardPerBump = d[o0 + 35] + (d[o1 + 35] - d[o0 + 35]) * t;
    const cpInboardPerR0 = d[o0 + 36] + (d[o1 + 36] - d[o0 + 36]) * t;
    const cpForwardPerR0 = d[o0 + 37] + (d[o1 + 37] - d[o0 + 37]) * t;
    contactInboardPerBump = hubInboardPerBump + radius * cpInboardPerR0;
    contactForwardPerBump = hubForwardPerBump + radius * cpForwardPerR0;

    const absDPsiDRack0 = d[o0 + 38] + (d[o1 + 38] - d[o0 + 38]) * t;
    const raw = absDPsiDRack0 * levScale;
    tieRodLeverageNorm =
      absDPsiDRack0 > 0 && levScale > 0
        ? hp.tieRodLeverageScale === 1
          ? raw
          : Math.min(1.65, Math.max(0.55, raw))
        : 1;
  } else {
    // Steered path: interpolate aligned basis & bump velocities from LUT, solve closed-form tie-rod angle psi
    const k1x = d[o0 + 8] + (d[o1 + 8] - d[o0 + 8]) * t;
    const k1y = d[o0 + 9] + (d[o1 + 9] - d[o0 + 9]) * t;
    const k1z = d[o0 + 10] + (d[o1 + 10] - d[o0 + 10]) * t;
    const armAx = d[o0 + 11] + (d[o1 + 11] - d[o0 + 11]) * t;
    const armAy = d[o0 + 12] + (d[o1 + 12] - d[o0 + 12]) * t;
    const armAz = d[o0 + 13] + (d[o1 + 13] - d[o0 + 13]) * t;
    const axisAx = d[o0 + 14] + (d[o1 + 14] - d[o0 + 14]) * t;
    const axisAy = d[o0 + 15] + (d[o1 + 15] - d[o0 + 15]) * t;
    const axisAz = d[o0 + 16] + (d[o1 + 16] - d[o0 + 16]) * t;
    const hubAx = d[o0 + 17] + (d[o1 + 17] - d[o0 + 17]) * t;
    const hubAy = d[o0 + 18] + (d[o1 + 18] - d[o0 + 18]) * t;
    const hubAz = d[o0 + 19] + (d[o1 + 19] - d[o0 + 19]) * t;
    const vBx = d[o0 + 20] + (d[o1 + 20] - d[o0 + 20]) * t;
    const vBy = d[o0 + 21] + (d[o1 + 21] - d[o0 + 21]) * t;
    const vBz = d[o0 + 22] + (d[o1 + 22] - d[o0 + 22]) * t;
    let omX = d[o0 + 23] + (d[o1 + 23] - d[o0 + 23]) * t;
    let omY = d[o0 + 24] + (d[o1 + 24] - d[o0 + 24]) * t;
    let omZ = d[o0 + 25] + (d[o1 + 25] - d[o0 + 25]) * t;

    const rackM = nominalSteerRad * hp.rackTravelPerSteerRad;
    const csX = hp.carSteer[0] + (isLeft ? -rackM : rackM);
    const csY = hp.carSteer[1];
    const csZ = hp.carSteer[2];

    const bcX = botX - csX;
    const bcY = botY - csY;
    const bcZ = botZ - csZ;
    const kArm = k1x * armAx + k1y * armAy + k1z * armAz;
    const kBc = k1x * bcX + k1y * bcY + k1z * bcZ;
    const pCos = bcX * armAx + bcY * armAy + bcZ * armAz - kBc * kArm;
    const qSin =
      bcX * (k1y * armAz - k1z * armAy) +
      bcY * (k1z * armAx - k1x * armAz) +
      bcZ * (k1x * armAy - k1y * armAx);
    const rhs = 0.5 * (lut.tieRodLenSq - (bcX * bcX + bcY * bcY + bcZ * bcZ) - lut.armSq) - kBc * kArm;
    const pq = Math.hypot(pCos, qSin);
    let psi = 0;
    if (pq > 1e-9) {
      const phase = Math.atan2(qSin, pCos);
      const spread = Math.acos(Math.max(-1, Math.min(1, rhs / pq)));
      const psiA = fastWrapAngle(phase + spread);
      const psiB = fastWrapAngle(phase - spread);
      psi = Math.abs(psiA) < Math.abs(psiB) ? psiA : psiB;
    }
    const psiCos = Math.cos(psi);
    const psiSin = Math.sin(psi);
    rotateCosSin(armAx, armAy, armAz, k1x, k1y, k1z, psiCos, psiSin, _armS);
    rotateCosSin(axisAx, axisAy, axisAz, k1x, k1y, k1z, psiCos, psiSin, _spin);
    rotateCosSin(hubAx, hubAy, hubAz, k1x, k1y, k1z, psiCos, psiSin, _hub);

    const wX = botX + _hub[0];
    const wY = botY + _hub[1];
    const wZ = botZ + _hub[2];
    const aX = _spin[0];
    const aY = _spin[1];
    const aZ = _spin[2];
    uprightCamberRad = Math.asin(Math.max(-1, Math.min(1, aY)));
    const toeInRad = Math.atan2(-aZ, aX);
    wheelSteerRad = isLeft ? -toeInRad : toeInRad;

    const invGLen = 1 / Math.sqrt(Math.max(1e-9, 1 - aY * aY));
    const rcX = radius * aY * aX * invGLen;
    const rcY = radius * (aY * aY - 1) * invGLen;
    const rcZ = radius * aY * aZ * invGLen;
    const cpX = wX + rcX;
    const cpY = wY + rcY;
    const cpZ = wZ + rcZ;
    const sKp = (cpY - botY) * invKy;
    kingpinScrubM = botX + sKp * kx - cpX;
    kingpinTrailM = botZ + sKp * kz - cpZ;

    const rsX = _armS[0];
    const rsY = _armS[1];
    const rsZ = _armS[2];
    const tcX = botX + rsX - csX;
    const tcY = botY + rsY - csY;
    const tcZ = botZ + rsZ - csZ;
    const vsX = vBx + omY * rsZ - omZ * rsY;
    const vsY = vBy + omZ * rsX - omX * rsZ;
    const vsZ = vBz + omX * rsY - omY * rsX;
    const turnDen =
      tcX * (k1y * rsZ - k1z * rsY) + tcY * (k1z * rsX - k1x * rsZ) + tcZ * (k1x * rsY - k1y * rsX);
    const turnRate = Math.abs(turnDen) > 1e-9 ? -(tcX * vsX + tcY * vsY + tcZ * vsZ) / turnDen : 0;
    const dPsiDRack = Math.abs(turnDen) > 1e-9 ? (tcX * (isLeft ? -1 : 1)) / turnDen : 0;
    const raw = Math.abs(dPsiDRack * levScale);
    tieRodLeverageNorm =
      dPsiDRack !== 0 && levScale > 0
        ? hp.tieRodLeverageScale === 1
          ? raw
          : Math.min(1.65, Math.max(0.55, raw))
        : 1;

    omX += turnRate * k1x;
    omY += turnRate * k1y;
    omZ += turnRate * k1z;
    const vWx = vBx + omY * _hub[2] - omZ * _hub[1];
    const vWy = vBy + omZ * _hub[0] - omX * _hub[2];
    const vWz = vBz + omX * _hub[1] - omY * _hub[0];
    const vCx = vWx + omY * rcZ - omZ * rcY;
    const vCz = vWz + omX * rcY - omY * rcX;
    const perHub = 1 / (Math.abs(vWy) > 0.2 ? vWy : 1);
    contactInboardPerBump = vCx * perHub;
    contactForwardPerBump = vCz * perHub;
    hubInboardPerBump = vWx * perHub;
    hubForwardPerBump = vWz * perHub;
  }

  out.tyreTop[0] = topX;
  out.tyreTop[1] = topY;
  out.tyreTop[2] = topZ;
  out.tyreBottom[0] = botX;
  out.tyreBottom[1] = botY;
  out.tyreBottom[2] = botZ;
  out.dynamicCamberDeltaRad = dynamicCamberDeltaRad;
  out.uprightCamberRad = uprightCamberRad;
  out.bumpSteerToeInRad = bumpSteerToeInRad;
  out.roadSteerRad = roadSteerRad;
  out.wheelSteerRad = wheelSteerRad;
  out.kpiRad = kpiRad;
  out.casterRad = casterRad;
  out.casterTrailM = casterTrailM;
  out.scrubRadiusM = scrubRadiusM;
  out.kingpinScrubM = kingpinScrubM;
  out.kingpinTrailM = kingpinTrailM;
  out.motionRatioNorm = motionRatioNorm;
  out.tieRodLeverageNorm = tieRodLeverageNorm;
  out.contactInboardPerBump = contactInboardPerBump;
  out.contactForwardPerBump = contactForwardPerBump;
  out.hubInboardPerBump = hubInboardPerBump;
  out.hubForwardPerBump = hubForwardPerBump;
  out.fvic[0] = icU;
  out.fvic[1] = icV;
  out.svicPitchSlope = lut.svicPitchSlope;
  return out;
}

/**
 * Solves both corners of an axle and computes the live 3D roll-centre height,
 * lateral roll-centre migration, and anti-dive / anti-squat pitch reaction fraction.
 * Pass `out` (see `createAxleKinematicsState`) to solve without allocating.
 */
export function solveAxleKinematics3D(
  hp: DoubleWishboneHardpoints,
  zBumpLeftM: number,
  zBumpRightM: number,
  nominalSteerRad: number,
  trackWidthM: number,
  loadedRadiusLeftM: number,
  loadedRadiusRightM: number,
  out: AxleKinematicsState = createAxleKinematicsState()
): AxleKinematicsState {
  const left = solveCornerKinematics3D(hp, zBumpLeftM, nominalSteerRad, true, loadedRadiusLeftM, out.left);
  const right = solveCornerKinematics3D(hp, zBumpRightM, nominalSteerRad, false, loadedRadiusRightM, out.right);

  const halfTrack = 0.5 * trackWidthM;
  const rMean = 0.5 * (loadedRadiusLeftM + loadedRadiusRightM);

  // Line from left contact patch (-halfTrack, 0) through left FVIC (-halfTrack + icU_L, icV_L + R_L)
  // Line from right contact patch (+halfTrack, 0) through right FVIC (+halfTrack - icU_R, icV_R + R_R)
  const slopeL = (left.fvic[1] + loadedRadiusLeftM) / Math.max(0.25, left.fvic[0]);
  const slopeR = (right.fvic[1] + loadedRadiusRightM) / Math.max(0.25, right.fvic[0]);

  const denom = Math.max(0.1, slopeL + slopeR);
  // Lateral coordinate y_RC (+ = left of centreline) where the two tire-to-IC lines intersect
  const rawLatOffset = halfTrack * ((slopeR - slopeL) / denom);
  out.rollCentreLatOffsetM = Math.max(-0.18, Math.min(0.18, rawLatOffset));
  const rawHeight = (2 * halfTrack * slopeL * slopeR) / denom;
  out.rollCentreHeightM = Math.max(-0.02, Math.min(rMean * 0.65, rawHeight));

  out.antiPitchFraction = 0.5 * (left.contactForwardPerBump + right.contactForwardPerBump);
  return out;
}
