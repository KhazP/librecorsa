/**
 * VeloSoft LC-26 (`lc26-f1`) — Clean-Room 6-DOF Multibody Suspension,
 * 10 mm Ti-6Al-4V Plank Contact/Wear & 500 Hz Kingpin WebHID FFB Module.
 *
 * Strictly derived from first-principles vehicle dynamics (Milliken & Milliken,
 * Race Car Vehicle Dynamics ch. 16-19; Pacejka, Tire and Vehicle Dynamics ch. 3-4;
 * Archard sliding wear law) and `specs/lc26-contract.json` (FIA 2026 Section C Issue 21).
 *
 * Solver timing compatibility:
 * - 500 Hz outer loop (`dt = 0.002 s`) for WebHID direct-drive FFB & plank wear integration
 * - 4 × 2000 Hz inner 6-DOF substeps (`subDt = 0.0005 s`) for unsprung hub & wishbone integration
 */

import {
  LC26_ACTUATION_RODS_LOCAL,
  LC26_CHASSIS_DATA,
  LC26_FIA_DATUM_PLANES,
  LC26_FRONT_HARDPOINTS,
  LC26_FRONT_HARDPOINTS_RAW,
  LC26_MASS_AND_INERTIA,
  LC26_PLANK_SPEC,
  LC26_REAR_HARDPOINTS,
  LC26_REAR_HARDPOINTS_RAW,
  LC26_SOLVER_RATES,
  LC26_TYRE_DIMENSIONS,
  type AxleSuspensionData,
  type ChassisData,
  type DamperControllerData,
  type DoubleWishboneHardpoints,
  type Lc26GarageSetup,
  type Lc26KingpinFfbInput,
  type Lc26KingpinFfbOutput,
  type Lc26PlankWearState,
  type Lc26SuspensionModule,
  type PowerSteeringData,
  type SolverCornerOrder,
  type SuspensionsData,
  type Vec3Tuple,
} from './contract-types';
import {
  createAxleKinematicsState,
  createCornerKinematicsState,
  solveAxleKinematics3D,
  solveCornerKinematics3D,
  type AxleKinematicsState,
  type CornerKinematicsState,
} from '@/lib/sim/suspension-kinematics';
import {
  damperForce,
  springDeflectionFor,
  springForce,
} from '@/lib/sim/f12026-car/VehiclePhysics';
import {
  contactHalfLengthM,
  driverRackTorqueNm,
  kingpinMomentNm,
} from '@/lib/sim/f12026-car/steering-torque';

// ---------------------------------------------------------------------------
// Physical Constants & Unit Conversions
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
/** Standard gravitational acceleration matching `VehiclePhysics.ts` (`9.81 m/s^2`) */
const GRAVITY_MS2 = 9.81;

/** Nominal Direct-Drive steering base torque ceiling (Nm) for `webHidNormalized` (`-1..+1`) */
export const LC26_WEBHID_NOMINAL_MAX_TORQUE_NM = 15.0;

/** Reference radial carcass vertical stiffnesses (N/m) for 2026 narrowed 18" Pirelli slicks at hot optimal psi */
export const LC26_NOMINAL_TYRE_VERTICAL_RATE_NM = {
  front: 360_000,
  rear: 385_000,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Converts anti-roll bar roll stiffness `K_phi` (Nm/deg of chassis roll) into
 * per-wheel vertical ARB rate `k_arb` (N/m) for `AxleSuspensionData.arb`:
 * `M_roll = k_arb * T^2 * (pi / 180) * phi_deg`.
 */
export function arbNmDegToWheelRateNm(stiffnessNmDeg: number, trackWidthM: number): number {
  const denom = trackWidthM * trackWidthM * DEG2RAD;
  return denom > 1e-9 ? Math.max(0, stiffnessNmDeg) / denom : 0;
}

/**
 * Converts per-wheel vertical ARB rate `k_arb` (N/m) into axle roll stiffness
 * `K_phi` (Nm/deg of chassis roll).
 */
export function wheelRateNmToArbNmDeg(wheelRateNm: number, trackWidthM: number): number {
  return Math.max(0, wheelRateNm) * trackWidthM * trackWidthM * DEG2RAD;
}

// ---------------------------------------------------------------------------
// Hydraulic Power Steering & Chassis Config
// ---------------------------------------------------------------------------

/**
 * Engine-driven constant-pressure F1 hydraulic power-steering rotary spool valve:
 * - `steeringRatio: 11.2` (`±210°` lock -> `±18.75°` nominal road wheel angle)
 * - `deadbandNm: 1.4` Nm centre-lap deadband preserves crisp unassisted straight-line road feel at 345 km/h
 * - `rampNm: 8.1` Nm progressive torsion-bar valve opening
 * - `maxRatio: 3.85` full assist ratio keeps peak >4g high-downforce cornering at ~13.6 Nm (< 15 Nm DD clip)
 */
export const LC26_POWER_STEERING: PowerSteeringData = {
  steeringRatio: 11.2,
  deadbandNm: 1.4,
  rampNm: 8.1,
  maxRatio: 3.85,
};

/**
 * Complete LC-26 `ChassisData` pairing contract mass/inertia/geometry (`768 kg`, `46.0%` front weight,
 * `20.4 mm` mechanical trail, `0.035 deg/kN` rack compliance) with hydraulic power steering.
 */
export const LC26_CHASSIS_WITH_POWER_STEERING: ChassisData = {
  ...LC26_CHASSIS_DATA,
  powerSteering: { ...LC26_POWER_STEERING },
};

// ---------------------------------------------------------------------------
// Torsion Bars, 3rd Heave Springs, Packers, ARBs & 4-Way Dampers
// ---------------------------------------------------------------------------

/**
 * Front pull-rod double-wishbone + tie-rod suspension specification:
 * - Corner torsion bars (`150 N/mm` wheel rate) + preloaded 3rd heave spring (`400 N/mm`)
 *   give `700 N/mm` initial axle heave rate for supple mechanical grip & kerb compliance.
 * - Progressive packer engages at `3.8 mm` heave (`+2100 N/mm` -> `2800 N/mm` axle heave rate)
 *   holding dynamic front ride height stably above ground at `345 km/h` without bottoming oscillation,
 *   while single-wheel `32 mm` kerb strikes see only `0.5 * heave` and `0.25x` heave wheel rate.
 */
export const LC26_FRONT_AXLE_SUSPENSION: AxleSuspensionData = {
  type: 'SuspensionType_DoubleWishbone',
  actuation: 'pull_rod',
  staticCamber: -3.15,
  camberGainKinematic: -21.6,
  springs: {
    wheel_rate: 150_000,
    helper_rate: 0,
    helper_range: 0,
  },
  heave: {
    rate: 400_000,
    gap: 0,
    packerGap: 0.0038,
    packerRate: 2_100_000,
  },
  bumpStop: {
    range: 0.028,
    rate: 420_000,
    progression: 7_500_000,
    hardStop: {
      range: 0.042,
      rate: 2_200_000,
    },
  },
  droopTravel: 0.035,
  rollCentreHeight: 0.0255,
  arb: 95_000, // 3881.3 Nm/deg roll stiffness at 1.530 m front track
  hardpoints: LC26_FRONT_HARDPOINTS_RAW,
};

/**
 * Rear push-rod double-wishbone + toe-link suspension specification:
 * - Corner torsion bars (`120 N/mm` wheel rate) + preloaded 3rd heave spring (`280 N/mm`)
 *   give `520 N/mm` initial axle heave rate for traction compliance out of slow corners.
 * - Progressive packer engages at `10.5 mm` heave (`+1550 N/mm` -> `2070 N/mm` axle heave rate)
 *   stabilizing diffuser throat & rear ride height at `345 km/h` without porpoising.
 */
export const LC26_REAR_AXLE_SUSPENSION: AxleSuspensionData = {
  type: 'SuspensionType_DoubleWishbone',
  actuation: 'push_rod',
  staticCamber: -1.85,
  camberGainKinematic: -19.5,
  springs: {
    wheel_rate: 120_000,
    helper_rate: 0,
    helper_range: 0,
  },
  heave: {
    rate: 280_000,
    gap: 0,
    packerGap: 0.0105,
    packerRate: 1_550_000,
  },
  bumpStop: {
    range: 0.032,
    rate: 380_000,
    progression: 6_800_000,
    hardStop: {
      range: 0.044,
      rate: 2_000_000,
    },
  },
  droopTravel: 0.035,
  rollCentreHeight: 0.0689,
  arb: 58_000, // 2169.6 Nm/deg roll stiffness at 1.464 m rear track
  hardpoints: LC26_REAR_HARDPOINTS_RAW,
};

/**
 * 4-way digressive dampers (corner base + decoupled heave, roll & pitch modes).
 * Calibrated from first principles for `2000 Hz` (`h = 0.5 ms`) symplectic hub stability:
 * - Front critical hub limit `m_u / h = 51,000 Ns/m`: slow single-wheel slope = `14,200 Ns/m` (`alpha = 0.278`),
 *   high-speed kerb blow-off slope = `3,500 Ns/m` (`alpha = 0.069`).
 * - Rear critical hub limit `m_u / h = 57,000 Ns/m`: slow single-wheel slope = `12,775 Ns/m` (`alpha = 0.224`),
 *   high-speed kerb blow-off slope = `3,194 Ns/m` (`alpha = 0.056`).
 */
export const LC26_FRONT_DAMPERS: DamperControllerData = {
  base: {
    slow_bump: 5_200,
    fast_bump: 1_550,
    slow_rebound: 7_400,
    fast_rebound: 2_150,
  },
  heave: {
    slow_bump: 9_600,
    fast_bump: 2_400,
    slow_rebound: 13_200,
    fast_rebound: 3_200,
  },
  roll: {
    slow_bump: 4_200,
    fast_bump: 1_200,
    slow_rebound: 5_800,
    fast_rebound: 1_650,
  },
  pitch: {
    slow_bump: 3_600,
    fast_bump: 1_050,
    slow_rebound: 4_800,
    fast_rebound: 1_400,
  },
  fastThresholdMs: 0.065,
  fastReboundThresholdMs: 0.075,
  heaveFastThresholdMs: 0.055,
  heaveFastReboundThresholdMs: 0.065,
};

export const LC26_REAR_DAMPERS: DamperControllerData = {
  base: {
    slow_bump: 4_800,
    fast_bump: 1_450,
    slow_rebound: 6_800,
    fast_rebound: 2_000,
  },
  heave: {
    slow_bump: 8_400,
    fast_bump: 2_200,
    slow_rebound: 11_600,
    fast_rebound: 2_950,
  },
  roll: {
    slow_bump: 3_600,
    fast_bump: 1_100,
    slow_rebound: 5_000,
    fast_rebound: 1_500,
  },
  pitch: {
    slow_bump: 3_400,
    fast_bump: 1_000,
    slow_rebound: 4_600,
    fast_rebound: 1_350,
  },
  fastThresholdMs: 0.068,
  fastReboundThresholdMs: 0.078,
  heaveFastThresholdMs: 0.058,
  heaveFastReboundThresholdMs: 0.068,
};

export const LC26_SUSPENSIONS_DATA: SuspensionsData = {
  front: LC26_FRONT_AXLE_SUSPENSION,
  rear: LC26_REAR_AXLE_SUSPENSION,
  dampers_controller: {
    front: LC26_FRONT_DAMPERS,
    rear: LC26_REAR_DAMPERS,
  },
};

// ---------------------------------------------------------------------------
// 3D Multibody Kinematics & Pullrod / Pushrod Actuation Evaluators
// ---------------------------------------------------------------------------

export interface Lc26ActuationRodEvaluation {
  readonly axle: 'front' | 'rear';
  readonly actuation: 'pull_rod' | 'push_rod';
  readonly staticRodLengthM: number;
  readonly currentRodLengthM: number;
  /** Positive in jounce for both pull-rod (tension extension) and push-rod (compression shortening) */
  readonly axialJounceStrokeM: number;
  /** Signed geometric change `currentRodLengthM - staticRodLengthM` (+ = tension elongation, - = compression shortening) */
  readonly signedLengthDeltaM: number;
  /** Instantaneous bellcrank spring/damper motion ratio (`dStroke_spring / dz_wheel`) */
  readonly effectiveMotionRatio: number;
  /** Solved upright outer pickup in wheel-reference coordinates `[x_inboard, y_up, z_fwd]` (m) */
  readonly uprightOuterLocalM: Vec3Tuple;
}

export interface Lc26AxleKinematicsEvaluation {
  readonly axle: 'front' | 'rear';
  readonly state: AxleKinematicsState;
  readonly leftTotalCamberDeg: number;
  readonly rightTotalCamberDeg: number;
  readonly leftBumpSteerToeInDeg: number;
  readonly rightBumpSteerToeInDeg: number;
  readonly leftRoadSteerDeg: number;
  readonly rightRoadSteerDeg: number;
  readonly kpiDeg: number;
  readonly casterDeg: number;
  readonly scrubRadiusMm: number;
  readonly mechanicalTrailMm: number;
  /** FVIC geometric roll-centre height above ground (m) */
  readonly rollCentreHeightM: number;
  /** Virtual-work contact-patch swing-arm roll-centre height above ground (m) */
  readonly virtualWorkRollCentreHeightM: number;
  /** Front outboard-brake anti-dive percentage (Milliken RCVD §17.3, 0 for rear) */
  readonly antiDivePct: number;
  /** Rear anti-squat percentage from SVIC / inboard halfshaft drive (Milliken RCVD §17.4, 0 for front) */
  readonly antiSquatPct: number;
}

function vec3Dist(a: Vec3Tuple, b: Vec3Tuple): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Rigidly maps an upright-mounted pickup (`uprightOuter` at rest) through the solved 3D
 * upper/lower wishbone ball-joint displacement and upright steer rotation.
 */
function solveUprightAttachmentPoint(
  hp: DoubleWishboneHardpoints,
  kin: CornerKinematicsState,
  restPoint: Vec3Tuple,
  isLeft: boolean,
): [number, number, number] {
  const b0 = hp.tyreBottom;
  const t0 = hp.tyreTop;
  const k0x = t0[0] - b0[0];
  const k0y = t0[1] - b0[1];
  const k0z = t0[2] - b0[2];
  const k0Len = Math.hypot(k0x, k0y, k0z) || 1;
  const u0x = k0x / k0Len;
  const u0y = k0y / k0Len;
  const u0z = k0z / k0Len;

  const b1 = kin.tyreBottom;
  const t1 = kin.tyreTop;
  const k1x = t1[0] - b1[0];
  const k1y = t1[1] - b1[1];
  const k1z = t1[2] - b1[2];
  const k1Len = Math.hypot(k1x, k1y, k1z) || 1;
  const u1x = k1x / k1Len;
  const u1y = k1y / k1Len;
  const u1z = k1z / k1Len;

  // Offset from lower ball joint at static
  let rx = restPoint[0] - b0[0];
  let ry = restPoint[1] - b0[1];
  let rz = restPoint[2] - b0[2];

  // Minimal rotation aligning static kingpin u0 -> live kingpin u1
  let ax = u0y * u1z - u0z * u1y;
  let ay = u0z * u1x - u0x * u1z;
  let az = u0x * u1y - u0y * u1x;
  const sinA = Math.hypot(ax, ay, az);
  const cosA = clamp(u0x * u1x + u0y * u1y + u0z * u1z, -1, 1);
  if (sinA > 1e-8) {
    ax /= sinA;
    ay /= sinA;
    az /= sinA;
    const dot = ax * rx + ay * ry + az * rz;
    const cx = ay * rz - az * ry;
    const cy = az * rx - ax * rz;
    const cz = ax * ry - ay * rx;
    rx = rx * cosA + cx * sinA + ax * dot * (1 - cosA);
    ry = ry * cosA + cy * sinA + ay * dot * (1 - cosA);
    rz = rz * cosA + cz * sinA + az * dot * (1 - cosA);
  }

  // Steer rotation about live kingpin u1 (in wheel-local coordinates where +X is inboard)
  const localSteerSign = isLeft ? 1 : -1;
  const psi = localSteerSign * kin.wheelSteerRad;
  if (Math.abs(psi) > 1e-8) {
    const c = Math.cos(psi);
    const s = Math.sin(psi);
    const dot = u1x * rx + u1y * ry + u1z * rz;
    const cx = u1y * rz - u1z * ry;
    const cy = u1z * rx - u1x * rz;
    const cz = u1x * ry - u1y * rx;
    rx = rx * c + cx * s + u1x * dot * (1 - c);
    ry = ry * c + cy * s + u1y * dot * (1 - c);
    rz = rz * c + cz * s + u1z * dot * (1 - c);
  }

  return [b1[0] + rx, b1[1] + ry, b1[2] + rz];
}

/**
 * Evaluates exact 3D front pull-rod or rear push-rod linkage stroke and instantaneous
 * bellcrank motion ratio at vertical wheel travel `zBumpM` (+ = jounce).
 */
export function evaluateLc26ActuationRod(
  axle: 'front' | 'rear',
  zBumpM: number,
  nominalSteerRad = 0,
  isLeft = true,
): Lc26ActuationRodEvaluation {
  const isFront = axle === 'front';
  const hp = isFront ? LC26_FRONT_HARDPOINTS : LC26_REAR_HARDPOINTS;
  const rodSpec = isFront ? LC26_ACTUATION_RODS_LOCAL.frontPullrod : LC26_ACTUATION_RODS_LOCAL.rearPushrod;
  const r0 = isFront ? LC26_TYRE_DIMENSIONS.front.unloadedRadiusM : LC26_TYRE_DIMENSIONS.rear.unloadedRadiusM;

  const kin0 = solveCornerKinematics3D(hp, 0, 0, isLeft, r0);
  const p0 = solveUprightAttachmentPoint(hp, kin0, rodSpec.uprightOuter, isLeft);
  const staticRodLengthM = vec3Dist(rodSpec.chassisInner, p0);

  const eps = 0.0005;
  const kin = solveCornerKinematics3D(hp, zBumpM, nominalSteerRad, isLeft, r0);
  const kinPlus = solveCornerKinematics3D(hp, zBumpM + eps, nominalSteerRad, isLeft, r0);
  const kinMinus = solveCornerKinematics3D(hp, zBumpM - eps, nominalSteerRad, isLeft, r0);

  const p = solveUprightAttachmentPoint(hp, kin, rodSpec.uprightOuter, isLeft);
  const pPlus = solveUprightAttachmentPoint(hp, kinPlus, rodSpec.uprightOuter, isLeft);
  const pMinus = solveUprightAttachmentPoint(hp, kinMinus, rodSpec.uprightOuter, isLeft);

  const currentRodLengthM = vec3Dist(rodSpec.chassisInner, p);
  const lenPlus = vec3Dist(rodSpec.chassisInner, pPlus);
  const lenMinus = vec3Dist(rodSpec.chassisInner, pMinus);

  const signedLengthDeltaM = currentRodLengthM - staticRodLengthM;
  // Pull-rod elongates (+dL) in jounce; push-rod shortens (-dL) in jounce
  const axialJounceStrokeM = isFront ? signedLengthDeltaM : -signedLengthDeltaM;

  // Finite-difference rod axial rate normalized to zBump=0, combined with bellcrank rocker progressivity
  const kinZeroPlus = solveCornerKinematics3D(hp, eps, 0, isLeft, r0);
  const kinZeroMinus = solveCornerKinematics3D(hp, -eps, 0, isLeft, r0);
  const rodSlope0 =
    Math.abs(
      vec3Dist(rodSpec.chassisInner, solveUprightAttachmentPoint(hp, kinZeroPlus, rodSpec.uprightOuter, isLeft)) -
        vec3Dist(rodSpec.chassisInner, solveUprightAttachmentPoint(hp, kinZeroMinus, rodSpec.uprightOuter, isLeft)),
    ) /
    (2 * eps);
  const rodSlopeNow = Math.abs(lenPlus - lenMinus) / (2 * eps);
  const geometricRatioScale = rodSlope0 > 1e-6 ? rodSlopeNow / rodSlope0 : 1;
  const effectiveMotionRatio = rodSpec.nominalMotionRatio * geometricRatioScale * kin.motionRatioNorm;

  return {
    axle,
    actuation: hp.actuation,
    staticRodLengthM,
    currentRodLengthM,
    axialJounceStrokeM,
    signedLengthDeltaM,
    effectiveMotionRatio,
    uprightOuterLocalM: p,
  };
}

/**
 * Evaluates full 3D double-wishbone + tie-rod kinematics for the front or rear axle,
 * including live camber, bump steer, Ackermann, roll-centre height, and Milliken
 * anti-dive / anti-squat percentages.
 */
export function evaluateLc26AxleKinematics(
  axle: 'front' | 'rear',
  zBumpLeftM: number,
  zBumpRightM: number,
  nominalSteerRad = 0,
  loadedRadiusLeftM?: number,
  loadedRadiusRightM?: number,
  frontBrakeBias01 = 0.57,
): Lc26AxleKinematicsEvaluation {
  const isFront = axle === 'front';
  const hp = isFront ? LC26_FRONT_HARDPOINTS : LC26_REAR_HARDPOINTS;
  const spec = isFront ? LC26_FRONT_AXLE_SUSPENSION : LC26_REAR_AXLE_SUSPENSION;
  const trackM = isFront ? LC26_CHASSIS_DATA.trackWidthFront : LC26_CHASSIS_DATA.trackWidthRear;
  const defaultR = isFront ? LC26_TYRE_DIMENSIONS.front.unloadedRadiusM : LC26_TYRE_DIMENSIONS.rear.unloadedRadiusM;
  const rL = loadedRadiusLeftM ?? defaultR;
  const rR = loadedRadiusRightM ?? defaultR;

  const state = solveAxleKinematics3D(
    hp,
    zBumpLeftM,
    zBumpRightM,
    isFront ? nominalSteerRad : 0,
    trackM,
    rL,
    rR,
    createAxleKinematicsState(),
  );

  const leftTotalCamberDeg = spec.staticCamber + state.left.uprightCamberRad * RAD2DEG;
  const rightTotalCamberDeg = spec.staticCamber + state.right.uprightCamberRad * RAD2DEG;

  const rackSteer = isFront ? nominalSteerRad : 0;
  const leftBumpSteerToeInDeg = -(state.left.wheelSteerRad - rackSteer) * RAD2DEG;
  const rightBumpSteerToeInDeg = (state.right.wheelSteerRad - rackSteer) * RAD2DEG;

  const halfTrack = 0.5 * trackM;
  const vwSlopeMean = -0.5 * (state.left.contactInboardPerBump + state.right.contactInboardPerBump);
  const virtualWorkRollCentreHeightM = halfTrack * vwSlopeMean;

  const wheelbaseOverCg = LC26_CHASSIS_DATA.wheelbase / LC26_CHASSIS_DATA.cgHeight;
  // Front outboard caliper braking anti-dive % = frontBrakeBias * tan(theta_f) * (L / h_cg) * 100
  const antiDivePct = isFront
    ? Math.max(0, frontBrakeBias01 * state.antiPitchFraction * wheelbaseOverCg * 100)
    : 0;
  // Rear RWD inboard-differential anti-squat % = hubForwardPerBump (or SVIC slope) * (L / h_cg) * 100
  const rearHubAntiSquatSlope = 0.5 * (state.left.hubForwardPerBump + state.right.hubForwardPerBump);
  const antiSquatPct = !isFront
    ? Math.max(0, Math.max(rearHubAntiSquatSlope, state.left.svicPitchSlope) * wheelbaseOverCg * 100)
    : 0;

  return {
    axle,
    state,
    leftTotalCamberDeg,
    rightTotalCamberDeg,
    leftBumpSteerToeInDeg,
    rightBumpSteerToeInDeg,
    leftRoadSteerDeg: state.left.wheelSteerRad * RAD2DEG,
    rightRoadSteerDeg: state.right.wheelSteerRad * RAD2DEG,
    kpiDeg: state.left.kpiRad * RAD2DEG,
    casterDeg: state.left.casterRad * RAD2DEG,
    scrubRadiusMm: state.left.kingpinScrubM * 1000,
    mechanicalTrailMm: state.left.kingpinTrailM * 1000,
    rollCentreHeightM: state.rollCentreHeightM,
    virtualWorkRollCentreHeightM,
    antiDivePct,
    antiSquatPct,
  };
}

// ---------------------------------------------------------------------------
// Explicit Heave / Torsion Bar / Packer / ARB / 4-Way Damper Force Evaluator
// ---------------------------------------------------------------------------

export interface Lc26StaticAxleEquilibrium {
  readonly staticCornerTotalFzN: number;
  readonly staticCornerSprungLoadN: number;
  readonly springPreloadM: number;
  readonly heaveFreeM: number;
}

/**
 * Computes exact static corner vertical load, torsion-bar preload deflection, and
 * preloaded 3rd heave spring datum matching `VehiclePhysics.computeStaticGeometry()`.
 */
export function computeLc26StaticSpringPreload(
  axle: 'front' | 'rear',
  suspensions: SuspensionsData = LC26_SUSPENSIONS_DATA,
  chassis: ChassisData = LC26_CHASSIS_WITH_POWER_STEERING,
  fuelMassKg = 0,
): Lc26StaticAxleEquilibrium {
  const isFront = axle === 'front';
  const spec = isFront ? suspensions.front : suspensions.rear;
  const unsprungKg = isFront ? chassis.unsprungMassFront : chassis.unsprungMassRear;
  const fuel = Math.max(0, finiteOr(fuelMassKg));
  const totalMass = chassis.totalMassKg + fuel;
  const tankShiftN = (fuel * GRAVITY_MS2 * (chassis.fuelTank?.z ?? 0)) / chassis.wheelbase;
  const axleShare = isFront ? chassis.frontWeightFraction : 1 - chassis.frontWeightFraction;
  const staticCornerTotalFzN =
    0.5 * (totalMass * GRAVITY_MS2 * axleShare + (isFront ? tankShiftN : -tankShiftN));
  const staticCornerSprungLoadN = Math.max(0, staticCornerTotalFzN - unsprungKg * GRAVITY_MS2);

  const preloaded = spec.heave.rate > 0 && spec.heave.gap <= 0;
  let lo = 0;
  let hi = springDeflectionFor(staticCornerSprungLoadN, spec.springs);
  for (let k = 0; preloaded && k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (springForce(mid, spec.springs) + 0.5 * spec.heave.rate * mid > staticCornerSprungLoadN) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return {
    staticCornerTotalFzN,
    staticCornerSprungLoadN,
    springPreloadM: hi,
    heaveFreeM: preloaded ? -hi : spec.heave.gap,
  };
}

export interface Lc26SuspensionDynamicInput {
  /** 4-corner wheel compression from static ride height `[FL, FR, RL, RR]` (m, + = jounce) */
  readonly compressionM: SolverCornerOrder<number>;
  /** 4-corner wheel compression velocity `[FL, FR, RL, RR]` (m/s, + = bump) */
  readonly compressionVelMs: SolverCornerOrder<number>;
}

export interface Lc26CornerForceBreakdown {
  readonly cornerSpringN: number;
  readonly bumpStopN: number;
  readonly droopStopN: number;
  readonly arbN: number;
  readonly heaveSpringN: number;
  readonly packerN: number;
  readonly baseDamperN: number;
  readonly heaveDamperN: number;
  readonly rollDamperN: number;
  readonly pitchDamperN: number;
  readonly totalWheelForceN: number;
  readonly packerClearanceM: number;
}

export interface Lc26SuspensionForceEvaluation {
  readonly corners: SolverCornerOrder<Lc26CornerForceBreakdown>;
  readonly frontHeaveM: number;
  readonly rearHeaveM: number;
  readonly frontPackerEngaged: boolean;
  readonly rearPackerEngaged: boolean;
}

const DROOP_STOP_RATE_NM = 1_000_000;
const DROOP_STOP_DAMP_NSM = 3_000;

/**
 * Evaluates full 4-corner LC-26 suspension forces (torsion bars, 3rd heave springs,
 * progressive packers, ARBs, bump/droop stops, and 4-way base/heave/roll/pitch dampers)
 * identically to `VehiclePhysics.ts`'s `2000 Hz` substep solver.
 */
export function evaluateLc26SuspensionForces(
  input: Lc26SuspensionDynamicInput,
  suspensions: SuspensionsData = LC26_SUSPENSIONS_DATA,
  chassis: ChassisData = LC26_CHASSIS_WITH_POWER_STEERING,
  fuelMassKg = 0,
): Lc26SuspensionForceEvaluation {
  const c = input.compressionM;
  const v = input.compressionVelMs;
  const vPitch = 0.5 * (0.5 * (v[0] + v[1]) - 0.5 * (v[2] + v[3]));

  const outCorners: Lc26CornerForceBreakdown[] = [];
  let frontHeaveM = 0;
  let rearHeaveM = 0;
  let frontPackerEngaged = false;
  let rearPackerEngaged = false;

  for (let ai = 0; ai < 2; ai++) {
    const isFront = ai === 0;
    const s = isFront ? suspensions.front : suspensions.rear;
    const d = isFront ? suspensions.dampers_controller.front : suspensions.dampers_controller.rear;
    const eq = computeLc26StaticSpringPreload(isFront ? 'front' : 'rear', suspensions, chassis, fuelMassKg);

    const knee = d.fastThresholdMs;
    const reboundKnee = d.fastReboundThresholdMs ?? knee;
    const heaveKnee = d.heaveFastThresholdMs ?? knee;
    const heaveReboundKnee = d.heaveFastReboundThresholdMs ?? d.heaveFastThresholdMs ?? reboundKnee;

    const cL = c[ai * 2];
    const cR = c[ai * 2 + 1];
    const vL = v[ai * 2];
    const vR = v[ai * 2 + 1];

    const heave = 0.5 * (cL + cR);
    const hv = 0.5 * (vL + vR);
    if (isFront) frontHeaveM = heave;
    else rearHeaveM = heave;

    const hx = Math.max(0, heave - eq.heaveFreeM);
    const axleHeaveSpring = (s.heave.rate + (s.heave.progressiveRate ?? 0) * hx) * hx;
    const intoPacker = Math.max(0, heave - s.heave.packerGap);
    const axlePacker = s.heave.packerRate * intoPacker;
    if (isFront) frontPackerEngaged = intoPacker > 0;
    else rearPackerEngaged = intoPacker > 0;

    const axleHeaveDamper = damperForce(d.heave, hv, heaveKnee, heaveReboundKnee);
    const axlePitchDamper = damperForce(d.pitch, isFront ? vPitch : -vPitch, knee);
    const arbForce = s.arb * (cL - cR);
    const rollDamper = damperForce(d.roll, 0.5 * (vL - vR), knee);

    for (let side = 0; side < 2; side++) {
      const cw = side === 0 ? cL : cR;
      const vw = side === 0 ? vL : vR;
      const sign = side === 0 ? 1 : -1;

      const cornerSpringN = springForce(eq.springPreloadM + cw, s.springs);
      const intoRubber = cw - s.bumpStop.range;
      let bumpStopN = 0;
      if (intoRubber > 0) {
        bumpStopN += s.bumpStop.rate * intoRubber + s.bumpStop.progression * intoRubber * intoRubber;
      }
      if (s.bumpStop.hardStop && cw > s.bumpStop.hardStop.range) {
        bumpStopN += s.bumpStop.hardStop.rate * (cw - s.bumpStop.hardStop.range);
      }

      const pastDroop = -s.droopTravel - cw;
      const droopStopN =
        pastDroop > 0 ? -(DROOP_STOP_RATE_NM * pastDroop + DROOP_STOP_DAMP_NSM * Math.max(0, -vw)) : 0;

      const baseDamperN = damperForce(d.base, vw, knee, reboundKnee);
      const arbN = sign * arbForce;
      const rollDamperN = sign * rollDamper;
      const heaveSpringN = 0.5 * axleHeaveSpring;
      const packerN = 0.5 * axlePacker;
      const heaveDamperN = 0.5 * axleHeaveDamper;
      const pitchDamperN = 0.5 * axlePitchDamper;

      const totalWheelForceN =
        cornerSpringN +
        bumpStopN +
        droopStopN +
        arbN +
        heaveSpringN +
        packerN +
        baseDamperN +
        heaveDamperN +
        rollDamperN +
        pitchDamperN;

      outCorners.push({
        cornerSpringN,
        bumpStopN,
        droopStopN,
        arbN,
        heaveSpringN,
        packerN,
        baseDamperN,
        heaveDamperN,
        rollDamperN,
        pitchDamperN,
        totalWheelForceN,
        packerClearanceM: s.heave.packerGap - heave,
      });
    }
  }

  return {
    corners: [outCorners[0], outCorners[1], outCorners[2], outCorners[3]],
    frontHeaveM,
    rearHeaveM,
    frontPackerEngaged,
    rearPackerEngaged,
  };
}

/**
 * Applies `Lc26GarageSetup` suspension parameters cleanly onto `SuspensionsData`
 * plus ride-height and static-toe solver targets.
 */
export function applyLc26GarageSuspensionSetup(
  setup: Pick<
    Lc26GarageSetup,
    | 'frontRideHeightMm'
    | 'rearRideHeightMm'
    | 'frontHeaveRateNmm'
    | 'rearHeaveRateNmm'
    | 'frontCornerRateNmm'
    | 'rearCornerRateNmm'
    | 'frontArbStiffnessNmDeg'
    | 'rearArbStiffnessNmDeg'
    | 'frontPackerGapMm'
    | 'rearPackerGapMm'
    | 'camberDeg'
    | 'toeDeg'
  >,
  baseSuspensions: SuspensionsData = LC26_SUSPENSIONS_DATA,
): {
  readonly suspensions: SuspensionsData;
  readonly frontTargetRideHeightM: number;
  readonly rearTargetRideHeightM: number;
  /** Static toe-in angles (rad, + = toe-in) for `VehiclePhysics.staticToeRad` */
  readonly staticToeInRad: { readonly front: number; readonly rear: number };
} {
  const meanFrontCamber = 0.5 * (setup.camberDeg[0] + setup.camberDeg[1]);
  const meanRearCamber = 0.5 * (setup.camberDeg[2] + setup.camberDeg[3]);

  const suspensions: SuspensionsData = {
    front: {
      ...baseSuspensions.front,
      staticCamber: clamp(meanFrontCamber, -4.5, -1.5),
      springs: {
        ...baseSuspensions.front.springs,
        wheel_rate: clamp(setup.frontCornerRateNmm * 1000, 70_000, 260_000),
      },
      heave: {
        ...baseSuspensions.front.heave,
        rate: clamp(setup.frontHeaveRateNmm * 1000, 120_000, 750_000),
        packerGap: clamp(setup.frontPackerGapMm / 1000, 0, 0.030),
      },
      arb: arbNmDegToWheelRateNm(setup.frontArbStiffnessNmDeg, LC26_CHASSIS_DATA.trackWidthFront),
    },
    rear: {
      ...baseSuspensions.rear,
      staticCamber: clamp(meanRearCamber, -3.5, -0.5),
      springs: {
        ...baseSuspensions.rear.springs,
        wheel_rate: clamp(setup.rearCornerRateNmm * 1000, 60_000, 220_000),
      },
      heave: {
        ...baseSuspensions.rear.heave,
        rate: clamp(setup.rearHeaveRateNmm * 1000, 100_000, 600_000),
        packerGap: clamp(setup.rearPackerGapMm / 1000, 0, 0.040),
      },
      arb: arbNmDegToWheelRateNm(setup.rearArbStiffnessNmDeg, LC26_CHASSIS_DATA.trackWidthRear),
    },
    dampers_controller: {
      front: {
        base: { ...baseSuspensions.dampers_controller.front.base },
        heave: { ...baseSuspensions.dampers_controller.front.heave },
        roll: { ...baseSuspensions.dampers_controller.front.roll },
        pitch: { ...baseSuspensions.dampers_controller.front.pitch },
        fastThresholdMs: baseSuspensions.dampers_controller.front.fastThresholdMs,
        fastReboundThresholdMs: baseSuspensions.dampers_controller.front.fastReboundThresholdMs,
        heaveFastThresholdMs: baseSuspensions.dampers_controller.front.heaveFastThresholdMs,
        heaveFastReboundThresholdMs: baseSuspensions.dampers_controller.front.heaveFastReboundThresholdMs,
      },
      rear: {
        base: { ...baseSuspensions.dampers_controller.rear.base },
        heave: { ...baseSuspensions.dampers_controller.rear.heave },
        roll: { ...baseSuspensions.dampers_controller.rear.roll },
        pitch: { ...baseSuspensions.dampers_controller.rear.pitch },
        fastThresholdMs: baseSuspensions.dampers_controller.rear.fastThresholdMs,
        fastReboundThresholdMs: baseSuspensions.dampers_controller.rear.fastReboundThresholdMs,
        heaveFastThresholdMs: baseSuspensions.dampers_controller.rear.heaveFastThresholdMs,
        heaveFastReboundThresholdMs: baseSuspensions.dampers_controller.rear.heaveFastReboundThresholdMs,
      },
    },
  };

  return {
    suspensions,
    frontTargetRideHeightM: clamp(setup.frontRideHeightMm / 1000, 0.015, 0.065),
    rearTargetRideHeightM: clamp(setup.rearRideHeightMm / 1000, 0.030, 0.095),
    staticToeInRad: {
      // `toeDeg[0]` is frontToeOutDeg -> negative toe-in
      front: -setup.toeDeg[0] * DEG2RAD,
      rear: setup.toeDeg[1] * DEG2RAD,
    },
  };
}

// ---------------------------------------------------------------------------
// Physical 10 mm Ti-6Al-4V Skid-Block Plank Contact, Wear & Floor-Stall Trigger
// ---------------------------------------------------------------------------

export const LC26_PLANK_CONTACT_PARAMS = {
  /** Linear stiffness of glass-reinforced resin plank + Ti-6Al-4V mount per strike (N/m) */
  linearStiffnessNm: 1_450_000,
  /** Non-linear quadratic Hertzian/flexural stiffening per strike (N/m^2) */
  quadraticStiffnessNm2: 185_000_000,
  /** Vertical impact contact damping per strike (Ns/m) */
  contactDampingNsm: 16_500,
  /** Penetration depth over which contact damping ramps in smoothly (m) */
  dampingRampPenetrationM: 0.001,
  /** Maximum reaction force clamp per strike (N) */
  maxStrikeForceN: 65_000,
  /** Ti-6Al-4V on dry macadam kinetic sliding friction coefficient */
  slidingFrictionMu: 0.34,
  /** Archard specific wear coefficient (mm worn per N*m of normal force * sliding distance) */
  archardWearMmPerNm: 7.5e-8,
  /** Minimum sliding speed (m/s) for pyrophoric titanium spark ignition */
  sparkMinSpeedMs: 10.0,
  /** Speed (m/s) at which titanium spark ignition efficiency reaches unity */
  sparkFullSpeedMs: 35.0,
  /** Frictional dissipation power (W) producing ~63% spark shower intensity */
  sparkReferencePowerW: 55_000,
  /** Spark rise time constant (s) */
  sparkRiseTauS: 0.004,
  /** Incandescent titanium grain cooling decay time constant (s) */
  sparkDecayTauS: 0.028,
  /** Mid-floor Venturi throat reference clearance (m) below which aerodynamic choking begins */
  floorStallOnsetClearanceM: 0.0115,
  /** Mid-floor Venturi throat reference clearance (m) at full aerodynamic choke/stall */
  floorStallFullClearanceM: 0.0045,
} as const;

const PLANK_STRIKE_WHEELBASE_FRACTIONS: readonly [front: number, mid: number, rear: number] = [
  LC26_PLANK_SPEC.strikes.frontSplitter.fiaMm[0] / (LC26_FIA_DATUM_PLANES.wheelbaseM * 1000),
  LC26_PLANK_SPEC.strikes.midFloor.fiaMm[0] / (LC26_FIA_DATUM_PLANES.wheelbaseM * 1000),
  LC26_PLANK_SPEC.strikes.rearTeaTray.fiaMm[0] / (LC26_FIA_DATUM_PLANES.wheelbaseM * 1000),
];

/** Creates a fresh `10.0 mm` scrutineering-new plank state with zero contact load and zero sparks. */
export function createInitialPlankWearState(): Lc26PlankWearState {
  return {
    frontSplitterMm: LC26_PLANK_SPEC.thicknessNewMm,
    midFloorMm: LC26_PLANK_SPEC.thicknessNewMm,
    rearTeaTrayMm: LC26_PLANK_SPEC.thicknessNewMm,
    strikeForcesN: [0, 0, 0],
    sparkIntensity01: 0,
  };
}

/**
 * Evaluates instantaneous vertical ground clearance (m, `< 0` = ground penetration)
 * at each of the 3 Ti-6Al-4V skid strike coordinates (`frontSplitter`, `midFloor`, `rearTeaTray`)
 * from local pitch + heave (`frontRideHeightM`, `rearRideHeightM`) and remaining skid thickness.
 */
export function computeLc26PlankStrikeClearancesM(
  frontRideHeightM: number,
  rearRideHeightM: number,
  state: Pick<Lc26PlankWearState, 'frontSplitterMm' | 'midFloorMm' | 'rearTeaTrayMm'> = {
    frontSplitterMm: LC26_PLANK_SPEC.thicknessNewMm,
    midFloorMm: LC26_PLANK_SPEC.thicknessNewMm,
    rearTeaTrayMm: LC26_PLANK_SPEC.thicknessNewMm,
  },
): readonly [frontM: number, midM: number, rearM: number] {
  const frh = finiteOr(frontRideHeightM, LC26_FIA_DATUM_PLANES.staticFrontRideHeightM);
  const rrh = finiteOr(rearRideHeightM, LC26_FIA_DATUM_PLANES.staticRearRideHeightM);
  const thicknessesMm = [state.frontSplitterMm, state.midFloorMm, state.rearTeaTrayMm] as const;

  const evalPoint = (idx: 0 | 1 | 2): number => {
    const u = PLANK_STRIKE_WHEELBASE_FRACTIONS[idx];
    const refPlaneHeightM = (1 - u) * frh + u * rrh;
    const skidThicknessM = clamp(finiteOr(thicknessesMm[idx], LC26_PLANK_SPEC.thicknessNewMm), 0, 20) / 1000;
    return refPlaneHeightM - skidThicknessM;
  };

  return [evalPoint(0), evalPoint(1), evalPoint(2)];
}

/**
 * Steps physical `10.0 mm` plank & Ti-6Al-4V skid-block ground strike contact,
 * Archard frictional energy wear (`mm` worn proportional to `F_N * |speed| * dt`),
 * and pyrophoric titanium spark intensity (`0..1`).
 */
export function stepLc26PlankWear(
  prev: Lc26PlankWearState,
  frontRideHeightM: number,
  rearRideHeightM: number,
  verticalVelMs: number,
  speedMs: number,
  dtS: number,
): Lc26PlankWearState {
  const dt = Math.max(0, finiteOr(dtS, LC26_SOLVER_RATES.outerDtS));
  const absSpeed = Math.abs(finiteOr(speedMs));
  const vVert = finiteOr(verticalVelMs);

  const clearances = computeLc26PlankStrikeClearancesM(frontRideHeightM, rearRideHeightM, prev);
  const prevMm = [
    clamp(finiteOr(prev.frontSplitterMm, LC26_PLANK_SPEC.thicknessNewMm), 0, LC26_PLANK_SPEC.thicknessNewMm),
    clamp(finiteOr(prev.midFloorMm, LC26_PLANK_SPEC.thicknessNewMm), 0, LC26_PLANK_SPEC.thicknessNewMm),
    clamp(finiteOr(prev.rearTeaTrayMm, LC26_PLANK_SPEC.thicknessNewMm), 0, LC26_PLANK_SPEC.thicknessNewMm),
  ];
  const forces: [number, number, number] = [0, 0, 0];
  const nextMm: [number, number, number] = [prevMm[0], prevMm[1], prevMm[2]];

  const p = LC26_PLANK_CONTACT_PARAMS;
  let totalStrikeForceN = 0;

  for (let i = 0; i < 3; i++) {
    const penetrationM = Math.max(0, -clearances[i]);
    if (penetrationM > 0 && prevMm[i] > 0) {
      const elasticN =
        p.linearStiffnessNm * penetrationM + p.quadraticStiffnessNm2 * penetrationM * penetrationM;
      const dampScale = Math.min(1, penetrationM / p.dampingRampPenetrationM);
      // Negative verticalVelMs (body plunging into ground) increases normal reaction; upward rebound unloads cleanly
      const rawForceN = elasticN - p.contactDampingNsm * dampScale * vVert;
      const fN = clamp(rawForceN, 0, p.maxStrikeForceN);
      forces[i] = fN;
      totalStrikeForceN += fN;

      if (dt > 0 && absSpeed > 0 && fN > 0) {
        const wearDeltaMm = p.archardWearMmPerNm * fN * absSpeed * dt;
        nextMm[i] = Math.max(0, prevMm[i] - wearDeltaMm);
      }
    }
  }

  // Pyrophoric Ti-6Al-4V spark intensity from total sliding frictional power
  const frictionPowerW = p.slidingFrictionMu * totalStrikeForceN * absSpeed;
  const speedGate = smoothstep(p.sparkMinSpeedMs, p.sparkFullSpeedMs, absSpeed);
  const targetSpark01 =
    totalStrikeForceN > 0 && absSpeed > p.sparkMinSpeedMs
      ? clamp(speedGate * (1 - Math.exp(-frictionPowerW / p.sparkReferencePowerW)), 0, 1)
      : 0;

  const prevSpark = clamp(finiteOr(prev.sparkIntensity01), 0, 1);
  let sparkIntensity01: number;
  if (dt <= 0) {
    sparkIntensity01 = targetSpark01 > prevSpark ? targetSpark01 : prevSpark;
  } else {
    const tau = targetSpark01 >= prevSpark ? p.sparkRiseTauS : p.sparkDecayTauS;
    const alpha = 1 - Math.exp(-dt / tau);
    sparkIntensity01 = prevSpark + (targetSpark01 - prevSpark) * alpha;
  }
  if (sparkIntensity01 < 1e-3 && targetSpark01 === 0) {
    sparkIntensity01 = 0;
  }

  return {
    frontSplitterMm: nextMm[0],
    midFloorMm: nextMm[1],
    rearTeaTrayMm: nextMm[2],
    strikeForcesN: forces,
    sparkIntensity01: clamp(sparkIntensity01, 0, 1),
  };
}

export interface Lc26PlankLegalityReport {
  /** FIA C3.15.13 race legality: `true` iff every titanium measurement pad >= `9.0 mm` (`<= 1.0 mm` worn) */
  readonly isLegal: boolean;
  readonly minThicknessMm: number;
  readonly maxWearMm: number;
  readonly wornPerStrikeMm: readonly [front: number, mid: number, rear: number];
  /** Secondary FIA Issue 21 inspection hole minimum (`>= 8.0 mm`) */
  readonly fiaInspectionHoleLegal: boolean;
}

/** Evaluates post-session FIA scrutineering legality of the `10.0 mm` plank (`< 9.0 mm` = DSQ). */
export function evaluateLc26PlankLegality(state: Lc26PlankWearState): Lc26PlankLegalityReport {
  const newMm = LC26_PLANK_SPEC.thicknessNewMm;
  const minThicknessMm = Math.min(state.frontSplitterMm, state.midFloorMm, state.rearTeaTrayMm);
  const wornFront = Math.max(0, newMm - state.frontSplitterMm);
  const wornMid = Math.max(0, newMm - state.midFloorMm);
  const wornRear = Math.max(0, newMm - state.rearTeaTrayMm);
  const maxWearMm = Math.max(wornFront, wornMid, wornRear);

  return {
    isLegal: minThicknessMm >= LC26_PLANK_SPEC.minLegalThicknessMm,
    minThicknessMm,
    maxWearMm,
    wornPerStrikeMm: [wornFront, wornMid, wornRear],
    fiaInspectionHoleLegal: minThicknessMm >= LC26_PLANK_SPEC.fiaIssue21HoleInspectionMinMm,
  };
}

export interface Lc26FloorStallEvaluation {
  /** `true` when severe bottoming chokes the Venturi floor throat and triggers diffuser stall */
  readonly stallTriggered: boolean;
  /** Continuous `0..1` choke factor (`0` = attached Venturi flow, `1` = fully choked throat) */
  readonly stallSeverity01: number;
  /** Instantaneous reference-plane height above ground at the mid-floor Venturi throat (m) */
  readonly throatReferenceClearanceM: number;
}

/**
 * Evaluates whether severe chassis bottoming chokes the underfloor Venturi throat,
 * feeding active-aero / ground-effect porpoising & diffuser-stall logic.
 */
export function evaluateLc26FloorStallTrigger(
  frontRideHeightM: number,
  rearRideHeightM: number,
  plankState?: Lc26PlankWearState,
): Lc26FloorStallEvaluation {
  const uMid = PLANK_STRIKE_WHEELBASE_FRACTIONS[1];
  const throatReferenceClearanceM =
    (1 - uMid) * finiteOr(frontRideHeightM, LC26_FIA_DATUM_PLANES.staticFrontRideHeightM) +
    uMid * finiteOr(rearRideHeightM, LC26_FIA_DATUM_PLANES.staticRearRideHeightM);

  const p = LC26_PLANK_CONTACT_PARAMS;
  const clearanceChoke01 =
    1 -
    smoothstep(
      p.floorStallFullClearanceM,
      p.floorStallOnsetClearanceM,
      throatReferenceClearanceM,
    );

  const midStrikeN = plankState ? plankState.strikeForcesN[1] + 0.5 * plankState.strikeForcesN[0] : 0;
  const strikeChoke01 = smoothstep(1_800, 8_500, midStrikeN);
  const stallSeverity01 = clamp(Math.max(clearanceChoke01, strikeChoke01), 0, 1);

  return {
    stallTriggered: stallSeverity01 > 0.05,
    stallSeverity01,
    throatReferenceClearanceM,
  };
}

// ---------------------------------------------------------------------------
// 500 Hz Kingpin WebHID Force Feedback & Radial-Belt Pneumatic Trail
// ---------------------------------------------------------------------------

/**
 * Computes first-principles radial-belt pneumatic trail `t_p` (m) for a `280/705-R18`
 * front slick at vertical load `verticalLoadN` and normalized slip ratio `slipRatioToPeak = |alpha| / alpha_peak`:
 * - Parabolic contact-patch half-length `a = sqrt(2*R*delta - delta^2)` -> zero-slip trail `t_p0 = a / 3`.
 * - C1-smooth radial-belt plateau on `s in [0, 1]` (`dt_p/ds = 0` at `s = 0` and `s = 1`) so combined
 *   kingpin + pneumatic torque builds strictly monotonically all the way to peak grip (`s = 1`).
 * - Rapid adhesion-detachment collapse for `s > 1` (`exp(-2.6*(s - 1)^2)`), naturally lightening the
 *   steering wheel in front understeer while `20.4 mm` mechanical caster trail prevents sign inversion.
 */
export function computeLc26PneumaticTrailM(
  verticalLoadN: number,
  slipRatioToPeak: number,
  unloadedRadiusM: number = LC26_TYRE_DIMENSIONS.front.unloadedRadiusM,
  verticalRateNm: number = LC26_NOMINAL_TYRE_VERTICAL_RATE_NM.front,
): number {
  const fz = Math.max(0, finiteOr(verticalLoadN));
  if (fz <= 0) return 0;

  const deflectionM = clamp(fz / Math.max(50_000, verticalRateNm), 0, 0.06);
  const patchHalfLenM = contactHalfLengthM(unloadedRadiusM, deflectionM);
  const trail0M = patchHalfLenM / 3;

  const s = Math.abs(finiteOr(slipRatioToPeak));
  const adhesionDrop = 0.12;
  const collapseRate = 2.6;
  const slidingNegativeShare = 0.08;

  if (s <= 1) {
    return trail0M * (1 - adhesionDrop * s * s * (3 - 2 * s));
  }
  const d = s - 1;
  const decay = Math.exp(-collapseRate * d * d);
  return trail0M * ((1 - adhesionDrop) * decay - slidingNegativeShare * (1 - decay));
}

/**
 * Computes pneumatic self-aligning moment `M_z` (Nm, `+` = turns wheel left) from
 * corner-plane lateral force `lateralForceN` (N, `+` = left) and vertical load `verticalLoadN` (N).
 */
export function computeLc26FrontPneumaticAligningNm(
  lateralForceN: number,
  verticalLoadN: number,
  slipRatioToPeak: number,
): number {
  const trailM = computeLc26PneumaticTrailM(verticalLoadN, slipRatioToPeak);
  return -finiteOr(lateralForceN) * trailM;
}

const UNIT_EX = { x: 1, y: 0, z: 0 } as const;
const UNIT_EY = { x: 0, y: 1, z: 0 } as const;
const UNIT_EZ = { x: 0, y: 0, z: 1 } as const;
const UNIT_N = { x: 0, y: 1, z: 0 } as const;

const _ffbKinLeft = createCornerKinematicsState();
const _ffbKinRight = createCornerKinematicsState();

export interface Lc26KingpinFfbOptions {
  readonly chassis?: ChassisData;
  readonly powerSteering?: PowerSteeringData;
  readonly frontHardpoints?: DoubleWishboneHardpoints;
  readonly nominalDdMaxTorqueNm?: number;
}

/**
 * Solves 500 Hz 3D kingpin self-aligning steering rack force, hydraulic power-steering
 * column torque, and WebHID normalized Direct-Drive output (`-1..+1` on a `15 Nm` DD base):
 * - Projects `Fx`, `Fy`, `Fz`, `Mz`, and camber/lateral overturning `Mx` about the live 3D
 *   solved kingpin axis (`KPI = 7.70°`, `caster = 4.64°`, `scrub = 24.6 mm`, `mech trail = 20.4 mm`).
 * - Applies `0.035 deg/kN` steering rack/tie-rod compliance under lateral load.
 * - Routes asymmetric `frontKerbImpulseN` normal spikes directly through 3D KPI + scrub + caster
 *   geometry so one-wheel kerb strikes tug the rim authentically while symmetric straight-line
 *   loads at `345 km/h` cancel to exact zero (`0.000 Nm`) with zero center chatter.
 */
export function computeLc26KingpinFfb(
  input: Lc26KingpinFfbInput,
  options: Lc26KingpinFfbOptions = {},
): Lc26KingpinFfbOutput {
  const chassis = options.chassis ?? LC26_CHASSIS_WITH_POWER_STEERING;
  const ps = options.powerSteering ?? chassis.powerSteering ?? LC26_POWER_STEERING;
  const hp = options.frontHardpoints ?? LC26_FRONT_HARDPOINTS;
  const ddMaxNm = Math.max(1, options.nominalDdMaxTorqueNm ?? LC26_WEBHID_NOMINAL_MAX_TORQUE_NM);

  const steerNorm = clamp(finiteOr(input.steeringWheelNormalized), -1, 1);
  const maxRoadSteerRad = chassis.maxRoadWheelDeg * DEG2RAD;
  const nominalRoadSteerRad = -steerNorm * maxRoadSteerRad;
  const complianceRadPerN = ((chassis.steerComplianceDegPerKN ?? 0) * DEG2RAD) / 1000;

  const r0 = LC26_TYRE_DIMENSIONS.front.unloadedRadiusM;
  const tyreWidthM = LC26_TYRE_DIMENSIONS.front.widthM;
  const kVert = LC26_NOMINAL_TYRE_VERTICAL_RATE_NM.front;
  const staticCamberRad = LC26_FRONT_AXLE_SUSPENSION.staticCamber * DEG2RAD;

  const moments: [number, number] = [0, 0];

  for (let side = 0; side < 2; side++) {
    const isLeft = side === 0;
    const inboardSign = isLeft ? -1 : 1;
    const zBumpM = clamp(finiteOr(input.frontHeaveM[side]), -0.040, 0.050);
    const fx = finiteOr(input.frontLongitudinalForceN[side]);
    const fy = finiteOr(input.frontLateralForceN[side]);
    const baseFz = Math.max(0, finiteOr(input.frontVerticalLoadN[side]));
    const kerbFz = input.frontKerbImpulseN ? Math.max(0, finiteOr(input.frontKerbImpulseN[side])) : 0;
    const fz = baseFz + kerbFz;
    const mz = finiteOr(input.frontPneumaticAligningNm[side]);

    const loadedRadiusM = clamp(r0 - baseFz / kVert, 0.28, r0);
    const kin = solveCornerKinematics3D(
      hp,
      zBumpM,
      nominalRoadSteerRad,
      isLeft,
      loadedRadiusM,
      isLeft ? _ffbKinLeft : _ffbKinRight,
    );

    // Steering rack & tie-rod elastic deflection bends road wheel slightly back toward straight under lateral force
    const complianceRad = -complianceRadPerN * fy;
    const wheelSteerRad = kin.wheelSteerRad + complianceRad;

    const fw = {
      x: Math.sin(wheelSteerRad),
      y: 0,
      z: Math.cos(wheelSteerRad),
    };
    const lw = {
      x: Math.cos(wheelSteerRad),
      y: 0,
      z: -Math.sin(wheelSteerRad),
    };

    // Overturning moment Mx from camber thrust shift & lateral carcass deflection (symmetric left/right at zero steer)
    const camberLeftRad = (isLeft ? 1 : -1) * (staticCamberRad + kin.uprightCamberRad);
    const yCpShift = clamp(
      -0.35 * tyreWidthM * Math.sin(camberLeftRad) + (fy / Math.max(500, fz)) * 0.018,
      -0.45 * tyreWidthM,
      0.45 * tyreWidthM,
    );
    const mx = fz * yCpShift;

    // Asymmetric serrated kerb strikes also carry a slight (~5 deg) inboard kerb-bevel lateral component
    const kerbLateralN = kerbFz > 0 ? (isLeft ? -1 : 1) * kerbFz * 0.087 : 0;

    moments[side] = kingpinMomentNm(
      UNIT_EX,
      UNIT_EY,
      UNIT_EZ,
      UNIT_N,
      fw,
      lw,
      inboardSign,
      wheelSteerRad,
      loadedRadiusM,
      {
        kpiRad: kin.kpiRad,
        casterRad: kin.casterRad,
        scrubRadiusM: kin.kingpinScrubM,
        casterTrailM: kin.kingpinTrailM,
      },
      fx,
      fy + kerbLateralN,
      fz,
      mz,
      mx,
    );
  }

  // Exact numerical symmetry guard against 1e-16 floating-point residue on balanced straight-ahead loads
  let rawKingpinSumNm = moments[0] + moments[1];
  if (Math.abs(rawKingpinSumNm) < 1e-11) {
    rawKingpinSumNm = 0;
  }

  const rackArmM = Math.max(0.025, Math.abs(hp.rackTravelPerSteerRad));
  const rackForceN = rawKingpinSumNm / rackArmM;

  const assistedRackEquivalentNm = driverRackTorqueNm(
    rawKingpinSumNm,
    Math.abs(finiteOr(input.speedMs)),
    ps,
  );
  const columnTorqueNm = assistedRackEquivalentNm / Math.max(1, ps.steeringRatio);
  const webHidNormalized = clamp(columnTorqueNm / ddMaxNm, -1, 1);

  return {
    columnTorqueNm: columnTorqueNm === 0 ? 0 : columnTorqueNm,
    rackForceN: rackForceN === 0 ? 0 : rackForceN,
    webHidNormalized: webHidNormalized === 0 ? 0 : webHidNormalized,
    kingpinMomentsNm: [moments[0], moments[1]],
  };
}

// ---------------------------------------------------------------------------
// Module Factory & Singleton Export (`LC26_SUSPENSION_MODULE`)
// ---------------------------------------------------------------------------

export interface Lc26SuspensionModuleOverrides {
  readonly chassis?: Partial<ChassisData>;
  readonly suspensions?: SuspensionsData;
  readonly powerSteering?: Partial<PowerSteeringData>;
}

/** Builds a clean-room `Lc26SuspensionModule` instance (with optional garage/test overrides). */
export function createLc26SuspensionModule(
  overrides: Lc26SuspensionModuleOverrides = {},
): Lc26SuspensionModule {
  const powerSteering: PowerSteeringData = {
    ...LC26_POWER_STEERING,
    ...overrides.powerSteering,
  };
  const chassis: ChassisData = {
    ...LC26_CHASSIS_WITH_POWER_STEERING,
    ...overrides.chassis,
    powerSteering,
  };
  const suspensions: SuspensionsData = overrides.suspensions ?? LC26_SUSPENSIONS_DATA;

  return {
    chassis,
    suspensions,
    powerSteering,
    computeKingpinFfb(input: Lc26KingpinFfbInput): Lc26KingpinFfbOutput {
      return computeLc26KingpinFfb(input, {
        chassis,
        powerSteering,
        frontHardpoints: LC26_FRONT_HARDPOINTS,
      });
    },
    stepPlankWear(
      prev: Lc26PlankWearState,
      frontRideHeightM: number,
      rearRideHeightM: number,
      verticalVelMs: number,
      speedMs: number,
      dtS: number,
    ): Lc26PlankWearState {
      return stepLc26PlankWear(prev, frontRideHeightM, rearRideHeightM, verticalVelMs, speedMs, dtS);
    },
  };
}

/** Default VeloSoft LC-26 (`lc26-f1`) suspension, plank wear & 500 Hz kingpin WebHID FFB module. */
export const LC26_SUSPENSION_MODULE: Lc26SuspensionModule = createLc26SuspensionModule();
