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
    rockerProgressivityPerM: actuation === 'pull_rod' ? 1.35 : 1.15,
    staticCasterTrailM: options.staticCasterTrailM ?? (gt3 ? 0.025 : 0.012),
  };
  // Rack ratio: with 1 m per "radian", a 1 mm nudge of the rack reads straight off the left wheel's solved angle
  const nudgeM = 0.001;
  const nudged = solveCornerKinematics3D(out, 0, nudgeM, true, 0.33).wheelSteerRad;
  out.rackTravelPerSteerRad = Math.abs(nudged) > 1e-6 ? nudgeM / nudged : 0;
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

/** Angle wrapped to (−π, π] */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
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

/** Ground-plane caster trail (m, + = ahead) of a kingpin through `bot` along (·, ky, kz), wheel centre at (·, cy, cz) */
function kingpinGroundTrail(
  botY: number,
  botZ: number,
  ky: number,
  kz: number,
  wheelCentreY: number,
  wheelCentreZ: number,
  radius: number
): number {
  const s = (wheelCentreY - radius - botY) / Math.max(0.05, ky);
  return botZ + s * kz - wheelCentreZ;
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
  const z = Math.max(-0.08, Math.min(0.08, Number.isFinite(zBumpM) ? zBumpM : 0));
  const radius = Math.max(0.2, Number.isFinite(loadedRadiusM) ? loadedRadiusM : 0.33);

  // 1. Lower wishbone hinge axis on the chassis: C_LF -> C_LR
  const lAxX = hp.carBottomRear[0] - hp.carBottomFront[0];
  const lAxY = hp.carBottomRear[1] - hp.carBottomFront[1];
  const lAxZ = hp.carBottomRear[2] - hp.carBottomFront[2];
  const lAxLen = Math.hypot(lAxX, lAxY, lAxZ) || 1;
  const klX = lAxX / lAxLen;
  const klY = lAxY / lAxLen;
  const klZ = lAxZ / lAxLen;

  // Vector from lower front chassis pivot to lower upright ball joint at static (z = 0)
  const rL0x = hp.tyreBottom[0] - hp.carBottomFront[0];
  const rL0y = hp.tyreBottom[1] - hp.carBottomFront[1];
  const rL0z = hp.tyreBottom[2] - hp.carBottomFront[2];

  // In jounce (+z) the upright, and so the lower ball joint, rises by z relative to the chassis. The rotation sign
  // that lifts the joint depends on the hinge axis direction, so it is taken from dy/dθ = (k × r)_y at θ = 0, and
  // a few Newton steps put the joint's rise on z
  const liftL = klZ * rL0x - klX * rL0z;
  const armLenL = Math.max(0.2, Math.abs(liftL));
  let thetaL = Math.sign(liftL || 1) * Math.asin(Math.max(-0.45, Math.min(0.45, z / armLenL)));
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

  // 2. Upper wishbone hinge axis on the chassis: C_UF -> C_UR
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

  // Rigid upright strut length between upper and lower ball joints
  const uprightDx0 = hp.tyreTop[0] - hp.tyreBottom[0];
  const uprightDy0 = hp.tyreTop[1] - hp.tyreBottom[1];
  const uprightDz0 = hp.tyreTop[2] - hp.tyreBottom[2];
  const uprightLenSq = uprightDx0 * uprightDx0 + uprightDy0 * uprightDy0 + uprightDz0 * uprightDz0;

  // Newton on the upper wishbone angle so the upright keeps its length (start: the upper joint rises by z too)
  let thetaU = Math.sign(liftU || 1) * Math.asin(Math.max(-0.45, Math.min(0.45, z / armLenU)));
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

  // 3. Static vs dynamic 3D Kingpin vector K = tyreTop - tyreBottom
  const kpi0 = Math.atan2(uprightDx0, uprightDy0);

  const kx = topX - botX;
  const ky = topY - botY;
  const kz = topZ - botZ;
  const kpiRad = Math.atan2(kx, Math.max(0.05, ky));
  const casterRad = Math.atan2(-kz, Math.max(0.05, ky));

  // Kingpin intersection with the ground plane: the wheel centre moved with the lower ball joint
  const wheelCenterY = botY - hp.tyreBottom[1];
  const wheelCenterZ = botZ - hp.tyreBottom[2];
  const sGround = (wheelCenterY - radius - botY) / Math.max(0.05, ky);
  const kpGroundX = botX + sGround * kx;

  // Scrub radius: a 22 mm base plus 35 % of the kingpin's ground offset (contact patch centre at x = 0), held within
  // realistic F1/GT3 bounds [8 mm .. 42 mm]
  const scrubRadiusM = Math.max(0.008, Math.min(0.042, 0.022 + kpGroundX * 0.35));
  // Mechanical caster trail: the car's static trail plus the kinematic change with travel (the hardpoints' own
  // ground trail is not the car's: the steering offset and hub geometry are not in them)
  const trail = kingpinGroundTrail(botY, botZ, ky, kz, wheelCenterY, wheelCenterZ, radius);
  const trail0 = kingpinGroundTrail(hp.tyreBottom[1], hp.tyreBottom[2], uprightDy0, uprightDz0, 0, 0, radius);
  const casterTrailM = Math.max(0.002, hp.staticCasterTrailM + Math.max(-0.015, Math.min(0.015, trail - trail0)));

  // 4. Tie-rod Ackermann & Bump Steer:
  // Trailing steering arm angled slightly inboard gives positive Ackermann (inner wheel steers more than outer wheel)
  const ackermannCoeff = 0.14;
  // Turn direction: nominalSteerRad > 0 is turning LEFT (so left wheel is inside, right wheel is outside)
  const signedAckermann = isLeft
    ? nominalSteerRad * (1 + ackermannCoeff * Math.sin(nominalSteerRad))
    : nominalSteerRad * (1 - ackermannCoeff * Math.sin(nominalSteerRad));

  // Kinematic bump steer from the difference between tie-rod arc and lower wishbone arc:
  // Slight roll-understeer (toe-out infront bump / toe-in in rear bump)
  const arcDiffX = (topX - hp.tyreTop[0]) - (botX - hp.tyreBottom[0]);
  const bumpSteerToeInRad = Math.max(-0.006, Math.min(0.006, arcDiffX * 0.12 - z * z * 0.18));
  // Toe-in means left wheel steers right (-), right wheel steers left (+)
  const bumpSteerLeftRad = isLeft ? -bumpSteerToeInRad : bumpSteerToeInRad;
  const roadSteerRad = signedAckermann + bumpSteerLeftRad;

  // 5. Dynamic camber gain from 3D wishbone rotation + steering caster/KPI camber effect
  // Inward camber change: when topX moves further inboard (+kx) than botX, top of tyre leans inward (negative camber)
  const wishboneCamberInwardRad = -(kpiRad - kpi0);
  // Steering camber: positive caster leans both tyres' tops toward the turn, i.e. negative camber on the outside
  // wheel and positive on the inside one; KPI adds positive camber to both as they steer away from straight
  const casterCamberSign = isLeft ? Math.sin(roadSteerRad) : -Math.sin(roadSteerRad);
  const steerCamberInwardRad =
    casterRad * casterCamberSign * 0.35 + kpiRad * (1 - Math.cos(roadSteerRad)) * 0.5;
  const dynamicCamberDeltaRad = wishboneCamberInwardRad + steerCamberInwardRad;

  // 6. Front-View Instant Centre (FVIC) from live upper and lower wishbone inclinations
  const uCarX = 0.5 * (hp.carTopFront[0] + hp.carTopRear[0]);
  const uCarY = 0.5 * (hp.carTopFront[1] + hp.carTopRear[1]);
  const lCarX = 0.5 * (hp.carBottomFront[0] + hp.carBottomRear[0]);
  const lCarY = 0.5 * (hp.carBottomFront[1] + hp.carBottomRear[1]);
  const slopeU = (uCarY - topY) / Math.max(0.1, uCarX - topX);
  const slopeL = (lCarY - botY) / Math.max(0.1, lCarX - botX);
  let icU = 1.6;
  let icV = 0.05;
  if (Math.abs(slopeU - slopeL) > 1e-4) {
    icU = (botY - slopeL * botX - topY + slopeU * topX) / (slopeU - slopeL);
    icV = topY + slopeU * (icU - topX);
  }

  // 7. Side-View Instant Centre (SVIC) pitch slope from wishbone pivot axis inclinations
  const svSlopeU = uAxY / Math.max(0.1, Math.abs(uAxZ));
  const svSlopeL = lAxY / Math.max(0.1, Math.abs(lAxZ));
  const svicPitchSlope = 0.5 * ( Math.abs(svSlopeU) + Math.abs(svSlopeL) );

  // 8. Pushrod / Pullrod bellcrank rocker progressive motion ratio
  const motionRatioNorm = Math.max(0.85, Math.min(1.28, 1 + hp.rockerProgressivityPerM * z));

  // 9. The upright as a rigid body. It carries both ball joints and the steering arm: turn the static kingpin onto the
  // solved one, then about itself until the tie rod (rack end `carSteer` to arm `tyreSteer`) is back at its length.
  // Camber, steer / toe and the paths of the hub and the contact patch all come off that pose (no blend constants).
  const k0Len = Math.sqrt(uprightLenSq) || 1;
  const k0x = uprightDx0 / k0Len;
  const k0y = uprightDy0 / k0Len;
  const k0z = uprightDz0 / k0Len;
  const kLen = Math.hypot(kx, ky, kz) || 1;
  const k1x = kx / kLen;
  const k1y = ky / kLen;
  const k1z = kz / kLen;
  // Alignment k0 → k1: about k0 × k1 by the angle between them
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
  // Steering arm (lower ball joint → arm joint) once aligned
  rotateCosSin(
    hp.tyreSteer[0] - hp.tyreBottom[0],
    hp.tyreSteer[1] - hp.tyreBottom[1],
    hp.tyreSteer[2] - hp.tyreBottom[2],
    alX, alY, alZ, alCos, alSin, _armA
  );
  // The rack slides along the car's lateral axis, so its end moves outboard on one side as it moves inboard on the other
  const rackM = nominalSteerRad * hp.rackTravelPerSteerRad;
  const csX = hp.carSteer[0] + (isLeft ? -rackM : rackM);
  const csY = hp.carSteer[1];
  const csZ = hp.carSteer[2];
  // |B + Rot(k1, ψ)·arm − C|² = L² is P cos ψ + Q sin ψ = rhs: solved in closed form, on the branch nearest straight ahead
  const bcX = botX - csX;
  const bcY = botY - csY;
  const bcZ = botZ - csZ;
  const kArm = k1x * _armA[0] + k1y * _armA[1] + k1z * _armA[2];
  const kBc = k1x * bcX + k1y * bcY + k1z * bcZ;
  const pCos = bcX * _armA[0] + bcY * _armA[1] + bcZ * _armA[2] - kBc * kArm;
  const qSin =
    bcX * (k1y * _armA[2] - k1z * _armA[1]) + bcY * (k1z * _armA[0] - k1x * _armA[2]) + bcZ * (k1x * _armA[1] - k1y * _armA[0]);
  const armSq = _armA[0] * _armA[0] + _armA[1] * _armA[1] + _armA[2] * _armA[2];
  const rhs = 0.5 * (hp.tieRodLengthM * hp.tieRodLengthM - (bcX * bcX + bcY * bcY + bcZ * bcZ) - armSq) - kBc * kArm;
  const pq = Math.hypot(pCos, qSin);
  let psi = 0;
  if (pq > 1e-9) {
    const phase = Math.atan2(qSin, pCos);
    const spread = Math.acos(Math.max(-1, Math.min(1, rhs / pq)));
    const psiA = wrapAngle(phase + spread);
    const psiB = wrapAngle(phase - spread);
    psi = Math.abs(psiA) < Math.abs(psiB) ? psiA : psiB;
  }
  const psiCos = Math.cos(psi);
  const psiSin = Math.sin(psi);
  rotateCosSin(_armA[0], _armA[1], _armA[2], k1x, k1y, k1z, psiCos, psiSin, _armS);
  const sX = botX + _armS[0];
  const sY = botY + _armS[1];
  const sZ = botZ + _armS[2];
  // Wheel spin axis (static: x, inboard) and wheel centre (static: the origin) carried by the same rotation
  rotateCosSin(1, 0, 0, alX, alY, alZ, alCos, alSin, _axisA);
  rotateCosSin(_axisA[0], _axisA[1], _axisA[2], k1x, k1y, k1z, psiCos, psiSin, _spin);
  rotateCosSin(-hp.tyreBottom[0], -hp.tyreBottom[1], -hp.tyreBottom[2], alX, alY, alZ, alCos, alSin, _hubA);
  rotateCosSin(_hubA[0], _hubA[1], _hubA[2], k1x, k1y, k1z, psiCos, psiSin, _hub);
  const wX = botX + _hub[0];
  const wY = botY + _hub[1];
  const wZ = botZ + _hub[2];
  const aX = _spin[0];
  const aY = _spin[1];
  const aZ = _spin[2];
  // Camber: the spin axis tilting up inboard leans the wheel's top outboard (positive camber)
  const uprightCamberRad = Math.asin(Math.max(-1, Math.min(1, aY)));
  // Toe: the wheel heads along spin axis × up; its inboard component is toe-in, which on the left wheel steers right
  const toeInRad = Math.atan2(-aZ, aX);
  const wheelSteerRad = isLeft ? -toeInRad : toeInRad;
  // Contact patch: the lowest point of the wheel disc, a loaded radius from the centre
  const gx = aY * aX;
  const gy = aY * aY - 1;
  const gz = aY * aZ;
  const gLen = Math.sqrt(Math.max(1e-9, 1 - aY * aY));
  const cpX = wX + (radius * gx) / gLen;
  const cpY = wY + (radius * gy) / gLen;
  const cpZ = wZ + (radius * gz) / gLen;
  // Kingpin's ground point (at the contact patch's height) against the contact patch: scrub radius and mechanical trail
  const sKp = (cpY - botY) / Math.max(0.05, ky);
  const kingpinScrubM = botX + sKp * kx - cpX;
  const kingpinTrailM = botZ + sKp * kz - cpZ;

  // 10. Paths per unit of travel (velocities with z as time). Lower ball joint along its arc; upper from the upright
  // keeping its length; the upright's spin from those two plus the tie rod (rack held) keeping its length
  const dBy = Math.abs(_dRotL[1]) > 1e-6 ? _dRotL[1] : 1e-6;
  const vBx = _dRotL[0] / dBy;
  const vBy = _dRotL[1] / dBy;
  const vBz = _dRotL[2] / dBy;
  const dUe = kx * _dRotU[0] + ky * _dRotU[1] + kz * _dRotU[2];
  const thetaURate = Math.abs(dUe) > 1e-9 ? (kx * vBx + ky * vBy + kz * vBz) / dUe : 0;
  const dvX = _dRotU[0] * thetaURate - vBx;
  const dvY = _dRotU[1] * thetaURate - vBy;
  const dvZ = _dRotU[2] * thetaURate - vBz;
  const kSq = kx * kx + ky * ky + kz * kz;
  // Spin across the kingpin: e × Δv / |e|²; the turn about it is whatever keeps the tie rod's length
  let omX = (ky * dvZ - kz * dvY) / kSq;
  let omY = (kz * dvX - kx * dvZ) / kSq;
  let omZ = (kx * dvY - ky * dvX) / kSq;
  const rsX = sX - botX;
  const rsY = sY - botY;
  const rsZ = sZ - botZ;
  const tcX = sX - csX;
  const tcY = sY - csY;
  const tcZ = sZ - csZ;
  const vsX = vBx + omY * rsZ - omZ * rsY;
  const vsY = vBy + omZ * rsX - omX * rsZ;
  const vsZ = vBz + omX * rsY - omY * rsX;
  const turnDen = tcX * (k1y * rsZ - k1z * rsY) + tcY * (k1z * rsX - k1x * rsZ) + tcZ * (k1x * rsY - k1y * rsX);
  const turnRate = Math.abs(turnDen) > 1e-9 ? -(tcX * vsX + tcY * vsY + tcZ * vsZ) / turnDen : 0;
  omX += turnRate * k1x;
  omY += turnRate * k1y;
  omZ += turnRate * k1z;
  const vWx = vBx + omY * _hub[2] - omZ * _hub[1];
  const vWy = vBy + omZ * _hub[0] - omX * _hub[2];
  const vWz = vBz + omX * _hub[1] - omY * _hub[0];
  // Contact patch path as a point of the upright: a force there whose moment about the axle goes into the upright (an
  // outboard caliper, and any lateral force through the bearing) loads the travel along this path, so the upright's
  // pitch in side view counts (anti-dive is measured from the contact patch, Milliken RCVD §17.3)
  const rcX = cpX - wX;
  const rcY = cpY - wY;
  const rcZ = cpZ - wZ;
  const vCx = vWx + omY * rcZ - omZ * rcY;
  const vCz = vWz + omX * rcY - omY * rcX;
  // Per metre of the wheel centre's own rise (the hub travel the springs see)
  const perHub = 1 / (Math.abs(vWy) > 0.2 ? vWy : 1);

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
  out.contactInboardPerBump = vCx * perHub;
  out.contactForwardPerBump = vCz * perHub;
  out.hubInboardPerBump = vWx * perHub;
  out.hubForwardPerBump = vWz * perHub;
  out.fvic[0] = icU;
  out.fvic[1] = icV;
  out.svicPitchSlope = svicPitchSlope;
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
