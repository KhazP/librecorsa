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
  /** Kinematic bump steer toe change from tie-rod arc mismatch (rad, + = toe-in) */
  bumpSteerToeInRad: number;
  /** Road wheel steer angle including Ackermann and bump steer (rad, + = left) */
  roadSteerRad: number;
  /** Kingpin inclination angle in front view (rad) */
  kpiRad: number;
  /** Caster angle in side view (rad) */
  casterRad: number;
  /** Mechanical caster trail at the ground plane (m, + = kingpin pierces ground ahead of contact patch): the static
   * trail plus the hardpoints' kinematic change with travel */
  casterTrailM: number;
  /** Kingpin scrub radius at the ground plane (m, + = kingpin pierces ground inboard of contact patch center) */
  scrubRadiusM: number;
  /** Instantaneous pushrod/pullrod rocker motion ratio (normalized to 1.0 at static ride height) */
  motionRatioNorm: number;
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
  /** Anti-dive / anti-squat fraction (0..0.45) */
  antiPitchFraction: number;
}

const DEG2RAD = Math.PI / 180;

/** Raw hardpoints [carTopFront, carTopRear, carBottomFront, carBottomRear, tyreTop, tyreBottom] */
type RawHardpoints = ReadonlyArray<readonly [number, number, number]>;

/** F1 (VF26 mod) front / rear double wishbones, used when no raw hardpoints are given */
const F1_FRONT_HARDPOINTS: RawHardpoints = [
  [0.68522, 0.223332, -0.0138],
  [0.64544, 0.157367, -0.3252],
  [0.6874, 0.021199, 0.0715],
  [0.64544, -0.017681, -0.3252],
  [0.12506, 0.17361, -0.0138],
  [0.0725, -0.025136, 0.0185],
];
const F1_REAR_HARDPOINTS: RawHardpoints = [
  [0.66332, 0.103062, 0.342009],
  [0.738479, 0.182562, 0.079167],
  [0.69821, 0.025027, 0.052143],
  [0.74228, -0.01693, -0.212241],
  [0.119245, 0.196534, 0.06647],
  [0.09259, 0.0129, 0.052143],
];
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
  /** Default geometry when no raw hardpoints are given (F1 = the VF26 mod's) */
  geometry?: 'f1' | 'gt3';
  /**
   * The car's static mechanical caster trail (m): the solver reports it plus the kinematic change with travel.
   * Default 0.012 (F1) / 0.025 (GT3).
   */
  staticCasterTrailM?: number;
}

/**
 * Builds a complete `DoubleWishboneHardpoints` descriptor from the 6-tuple (or 8-tuple with steer link) hardpoints
 * array in `VF26_CHASSIS.front.hardpoints` / `F12026_SUSPENSIONS` / `AMG_GT3_SUSPENSIONS` (or synthesizes default
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

  return {
    carTopFront: hp[0],
    carTopRear: hp[1],
    carBottomFront: hp[2],
    carBottomRear: hp[3],
    tyreTop: hp[4],
    tyreBottom: hp[5],
    carSteer,
    tyreSteer,
    actuation,
    rockerProgressivityPerM: actuation === 'pull_rod' ? 1.35 : 1.15,
    staticCasterTrailM: options.staticCasterTrailM ?? (gt3 ? 0.025 : 0.012),
  };
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
    bumpSteerToeInRad: 0,
    roadSteerRad: 0,
    kpiRad: 0,
    casterRad: 0,
    casterTrailM: 0,
    scrubRadiusM: 0,
    motionRatioNorm: 1,
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
  rotateAroundAxis(rL0x, rL0y, rL0z, klX, klY, klZ, thetaL, _rotL);
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
  rotateAroundAxis(rU0x, rU0y, rU0z, kuX, kuY, kuZ, thetaU, _rotU);
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

  // Scrub radius (inboard offset of kingpin ground intersection from contact patch center x=0)
  // Clamped to realistic F1/GT3 physical bounds [8 mm .. 42 mm]
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

  out.tyreTop[0] = topX;
  out.tyreTop[1] = topY;
  out.tyreTop[2] = topZ;
  out.tyreBottom[0] = botX;
  out.tyreBottom[1] = botY;
  out.tyreBottom[2] = botZ;
  out.dynamicCamberDeltaRad = dynamicCamberDeltaRad;
  out.bumpSteerToeInRad = bumpSteerToeInRad;
  out.roadSteerRad = roadSteerRad;
  out.kpiRad = kpiRad;
  out.casterRad = casterRad;
  out.casterTrailM = casterTrailM;
  out.scrubRadiusM = scrubRadiusM;
  out.motionRatioNorm = motionRatioNorm;
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

  const meanSvSlope = 0.5 * (left.svicPitchSlope + right.svicPitchSlope);
  out.antiPitchFraction = Math.max(0.05, Math.min(0.35, meanSvSlope * 0.85));
  return out;
}
