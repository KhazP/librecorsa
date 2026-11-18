/**
 * Chaparral 2D vehicle data for `VehiclePhysics` (same data model as the f12026-car, see `F12026CarConfig`): Jim
 * Hall's closed sports prototype, a Chevrolet V8 behind the driver in a fibreglass tub, a torque-converter gearbox
 * with the driver picking the gear, and rear-wheel drive. Two cars:
 *  - 1966 (`CHAPARRAL_2D_CONFIG`): the 327 cu in (5.4 L) small block and a two-speed box, as it won the Nürburgring
 *    1000 km;
 *  - 1967 (`CHAPARRAL_2D_67_CONFIG`): the 427 cu in (7.0 L) big block, a three-speed box, a wider nose and two aero
 *    kits, Daytona's raised spoiler and Sebring's bigger one with front canards.
 *
 * The numbers come from NPanic's Chaparral 2D for Assetto Corsa (physics by Bazza), mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics / setup); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * No turbo, hybrid or DRS, and no ABS or traction control (electronics.ini has both PRESENT=0). Double wishbones at
 * both ends with no heave springs, one set of slicks, and wing-element aero: the body lifts at both ends (the data's
 * FRONT and REAR elements), the spoiler and the 1966 gurney extension or the 1967 canards push down, and the body drags.
 */
import type { LutPoints } from '../lut';
import type {
  AeroData,
  CarPhysicsConfig,
  DamperSettingsUnits,
  PerformanceModeData,
  PerformanceModeName,
  PhysicsTyreCompound,
  SuspensionsData,
  TyreGeometry,
  TyresCompoundData,
  WingData,
} from '../f12026-car/F12026CarConfig';
import { deriveRainCompound } from '../f12026-car/F12026CarConfig';
import { modBodyHeightM, modCornerStops } from '../mod-suspension';

/** Driveline efficiency of this model; the wheel torque curve is divided by it for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/** Crank power (kW) of a wheel torque curve (rpm → Nm after the driveline) [derived] */
const crankPower = (wheelTorque: readonly (readonly [number, number])[]): LutPoints =>
  wheelTorque.map(([rpm, nm]) => [rpm, Number((((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000).toFixed(3))]);

/**
 * The overrun line: nothing at the 1100 rpm idle, `torque` at 6000 rpm, straight on past the limiter [spec engine.ini
 * COAST_REF, NON_LINEARITY 0]
 */
const coastLine = (torque: number): LutPoints => [
  [0, 0],
  [1100, 0],
  [6000, torque],
  [7250, Number((torque * (7250 - 1100) / (6000 - 1100)).toFixed(1))],
];

/** 327 small block: torque after the driveline [spec power.lut], 421 Nm at 5250 rpm, 368 at 6750 */
const WHEEL_TORQUE_327: [number, number][] = [
  [0, 0],
  [250, 71],
  [500, 172],
  [750, 201],
  [1000, 214],
  [1250, 279],
  [1500, 292],
  [1750, 298],
  [2000, 310],
  [2250, 337],
  [2500, 358],
  [2750, 367],
  [3000, 374],
  [3250, 377],
  [3500, 380],
  [3750, 390],
  [4000, 397],
  [4250, 407],
  [4500, 412],
  [4750, 417],
  [5000, 419],
  [5250, 421],
  [5500, 417],
  [5750, 408],
  [6000, 395],
  [6250, 386],
  [6500, 377],
  [6750, 368],
  [7000, 132],
  [7250, 4],
];

/** 427 big block: torque after the driveline [spec power.lut], 504 Nm at 4500 rpm, 405 at the 6800 limiter */
const WHEEL_TORQUE_427: [number, number][] = [
  [0, 0],
  [250, 148],
  [500, 123],
  [750, 183],
  [1000, 209],
  [1250, 256],
  [1500, 311],
  [1750, 340],
  [2000, 363],
  [2250, 374],
  [2500, 398],
  [2750, 402],
  [3000, 414],
  [3250, 428],
  [3500, 458],
  [3600, 455],
  [3700, 458],
  [3800, 471],
  [3900, 475],
  [4000, 480],
  [4100, 484],
  [4200, 489],
  [4300, 493],
  [4400, 500],
  [4500, 504],
  [4600, 502],
  [4700, 502],
  [4800, 500],
  [4900, 494],
  [5000, 489],
  [5100, 484],
  [5200, 480],
  [5300, 481],
  [5400, 486],
  [5500, 486],
  [5600, 484],
  [5700, 477],
  [5800, 472],
  [5900, 466],
  [6000, 469],
  [6100, 471],
  [6200, 468],
  [6300, 463],
  [6400, 458],
  [6500, 446],
  [6600, 430],
  [6700, 415],
  [6800, 405],
];

/**
 * An engine on the data's curves: idle 1100 rpm, a 20 Hz limiter whose cut lasts one cycle, a tenth of a change in air
 * density reaching the torque, the pedal straight through to the throttle [spec engine.ini, throttle.lut]; `inertia` is
 * the engine's plus the gearbox's 0.035 [spec INERTIA]
 */
const engine = (wheelTorque: [number, number][], coastTorque: number, inertia: number) => ({
  powerCurve: crankPower(wheelTorque),
  coastCurve: coastLine(coastTorque),
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ] as LutPoints,
  // Carburettor slides and intake filling, as the M1's [est]
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  idleRpm: 1100,
  inertia,
  limiterCutS: 1 / 20,
  airDensitySensitivity: 0.1,
});

const NONE: LutPoints = [
  [0, 0],
  [10000, 0],
];

/** No hybrid. The store holds 1 J only so the state-of-charge maths stays finite. */
const ERS = {
  torqueLut: NONE,
  coastLut: NONE,
  ERS_MAX_DEPLOY: 0,
  maxHarvestW: 0,
  ERS_MAX_CHARGE: 1,
  deployPerLapJ: 0,
  harvestPerLapJ: 0,
  deployEfficiency: 1,
  harvestEfficiency: 1,
  liftThrottle: 0,
  topGearLiftHarvestW: 0,
};

/**
 * The default tune's engine braking: half the engine's overrun torque reaches the rears off the throttle [est], where the
 * data's held-on clutch passes all of it. At full strength the overrun braked the rears like a light pedal, and trail
 * braking in a fast corner spun the car. The garage's Engine braking slider runs from a quarter of it to all of it
 */
export const CHAPARRAL_ENGINE_BRAKING = 0.5;

const mode = (performance_mode_name: PerformanceModeName): PerformanceModeData => ({
  performance_mode_name,
  deployFraction: 0,
  deployVsSpeed: [
    [0, 0],
    [400, 0],
  ],
  socFloor: 0,
  brakeHarvestScale: 0,
  liftHarvestScale: 0,
  topGearClipHarvestW: 0,
  partThrottleHarvestW: 0,
  coastTorqueScale: CHAPARRAL_ENGINE_BRAKING,
  ebbOffset: 0,
});

/**
 * The gearbox: the driver picks the gear, the converter takes up the drive. An up-shift is 220 ms between gears with
 * the throttle cut for 200 ms, a down-shift 250 ms with the clutch let out from 150 ms and home at 250, and the driver's
 * own blip, 70 % of the pedal risen in 10 ms [spec CHANGE_UP_TIME, AUTO_CUTOFF_TIME, CHANGE_DN_TIME, DOWNSHIFT_PROFILE,
 * AUTOBLIP (ELECTRONIC=0)]. The data has no down-shift protection: the box takes a down-shift up to the 6850 rpm where
 * the engine starts to take damage [spec DAMAGE RPM_THRESHOLD]
 */
const gearbox = (ratios: number[], reverse: number, finalDrive: number, brakeDownshiftRpm: number) => ({
  ratios,
  reverse,
  finalDrive,
  shiftTimeS: 0.22,
  downshiftTimeS: 0.25,
  // As the M1's [est]; the box is between gears for most of the cut anyway
  shiftTorqueFraction: 0.1,
  upshiftNeutralS: 0.22,
  upshiftCutS: 0.2,
  // The cut is the driver's foot off the pedal: the engine slows on its overrun drag through the change
  upshiftCutLift: true,
  downshift: { neutralS: 0.25, clutchReleaseS: 0.15, clutchHomeS: 0.25, blip: { level: 0.7, riseS: 0.01 }, overRevRpm: 50 },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 6800,
    // [spec drivetrain.ini AUTO_SHIFTER UP / DOWN]
    upshift_rpm: 6700,
    downshift_rpm: 3900,
    // Into a braking zone the auto box clicks down while the lower gear lands under this [est]
    brake_downshift_rpm: brakeDownshiftRpm,
  },
});

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);
/** No heave element: a spring that never engages */
const NO_HEAVE = { rate: 0, gap: 1, packerGap: 1, packerRate: 0 };
const mm = (m: number) => Number(m.toFixed(5));

const WHEELBASE = 2.311;
/** Hub masses [spec HUB_MASS] */
const FRONT_HUB_KG = 65;
const REAR_HUB_KG = 80;
/** Tyre radii [spec tyres.ini RADIUS] */
const FRONT_RADIUS = 0.325;
const REAR_RADIUS = 0.335;
/** The slicks' radial rate (N/m): RATE at the static pressure + 2800 N/m per psi [spec PRESSURE_SPRING_GAIN] */
const FRONT_RATE = 295_422;
const REAR_RATE = 315_422;
const PSI_RATE = 2800;
/** Pickups 0.23 m under the CG's level at both axles [spec car.ini RIDE] */
const PICKUP_Y = -0.23;

/** What differs between the two cars' chassis and suspension data */
interface ChassisVariant {
  /** With driver, no fuel [spec TOTALMASS] */
  mass: number;
  /** Share of the sprung weight on the front axle [spec CG_LOCATION] */
  frontWeight: number;
  /** [spec REAR ROD_LENGTH, SPRING_RATE, DAMP_BUMP, DAMP_REBOUND, WBCAR_STEER y] */
  rearRodLength: number;
  rearSpringRate: number;
  rearDamp: [number, number];
  rearSteerY: number;
  /** [spec tyres.ini FRONT / REAR PRESSURE_STATIC] */
  frontPsi: number;
  rearPsi: number;
  /** Rear camber gain and roll centre the kinematic solver gives on its hardpoints [derived] */
  rearCamberGain: number;
  rearRollCentre: number;
}

const V66: ChassisVariant = {
  mass: 847,
  frontWeight: 0.465,
  rearRodLength: 0.045,
  rearSpringRate: 38_000,
  rearDamp: [2900, 3600],
  rearSteerY: -0.0915,
  frontPsi: 30,
  rearPsi: 30,
  rearCamberGain: -15.7,
  rearRollCentre: 0.0508,
};

const V67: ChassisVariant = {
  mass: 927,
  frontWeight: 0.4,
  rearRodLength: 0.04,
  rearSpringRate: 42_000,
  rearDamp: [3000, 4200],
  rearSteerY: -0.0935,
  frontPsi: 31,
  rearPsi: 30,
  rearCamberGain: -15.7,
  rearRollCentre: 0.0497,
};

/**
 * The static loads, the stops from static ride and the heights the body rides at. The mod measures its stops from the
 * suspension's design position with the springs working on their rod lengths (`mod-suspension.ts`); the body's height
 * at an axle is the tyre's loaded radius at its 37 psi ideal less the wheel centre's height in the body frame (BASEY
 * −0.043 / −0.061 below the CG's level, plus the static offset) [spec BASEY, ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN,
 * RADIUS, RATE; derived]
 */
function ride(v: ChassisVariant) {
  const sprungKg = v.mass - 2 * FRONT_HUB_KG - 2 * REAR_HUB_KG;
  const frontLoadN = (sprungKg * 9.81 * v.frontWeight) / 2;
  const rearLoadN = (sprungKg * 9.81 * (1 - v.frontWeight)) / 2;
  const front = modCornerStops({ staticLoadN: frontLoadN, springRate: 28_000, rodLength: 0.045, packerRange: 0.122, bumpStopUp: 0.077, bumpStopDn: 0.055 });
  const rear = modCornerStops({ staticLoadN: rearLoadN, springRate: v.rearSpringRate, rodLength: v.rearRodLength, packerRange: 0.143, bumpStopUp: 0.0994, bumpStopDn: 0.0446 });
  const hotFront = FRONT_RATE + PSI_RATE * (37 - v.frontPsi);
  const hotRear = REAR_RATE + PSI_RATE * (37 - v.rearPsi);
  const frontBody = modBodyHeightM(FRONT_RADIUS, (frontLoadN + FRONT_HUB_KG * 9.81) / hotFront, -0.043, front.staticOffsetM);
  const rearBody = modBodyHeightM(REAR_RADIUS, (rearLoadN + REAR_HUB_KG * 9.81) / hotRear, -0.061, rear.staticOffsetM);
  return {
    front,
    rear,
    cgHeight: Number((frontBody + (rearBody - frontBody) * (1 - v.frontWeight)).toFixed(4)),
    frontTarget: Number((frontBody + PICKUP_Y).toFixed(4)),
    rearTarget: Number((rearBody + PICKUP_Y).toFixed(4)),
  };
}

/** A pair of stops as the config takes them: the nearer first; at the same travel their BUMP_STOP_RATEs add [spec] */
function stops(packerGapM: number, bumpStopGapM: number, rate: number) {
  if (Math.abs(packerGapM - bumpStopGapM) < 1e-4) return { range: mm(packerGapM), rate: 2 * rate, progression: 0 };
  return { range: mm(Math.min(packerGapM, bumpStopGapM)), rate, progression: 0, hardStop: { range: mm(Math.max(packerGapM, bumpStopGapM)), rate } };
}

/**
 * Double wishbones front and rear on the mod's wheel rates, bars, stops and two-stage dampers [spec suspensions.ini]:
 * soft springs (28 / 38–42 kN/m) on a light car, the front bar near twice the rear's (10 against 6 kN/m). The rear's
 * long radius rods reach 0.89 m forward to the tub. Hardpoints are [x inboard, y up, z forward] from the wheel centre
 * [spec]; camber gain and roll-centre heights are what the kinematic solver gives on them at static [derived]: both ends
 * gain negative camber in bump (27 °/m front, 16 rear), both roll centres about 5 cm up.
 */
function suspensions(v: ChassisVariant, r: ReturnType<typeof ride>): SuspensionsData {
  return {
    front: {
      type: 'SuspensionType_DoubleWishbone',
      actuation: 'push_rod',
      // [spec STATIC_CAMBER]
      staticCamber: -1.4,
      camberGainKinematic: -26.6,
      // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
      springs: { wheel_rate: 28_000, helper_rate: 0, helper_range: 0 },
      heave: NO_HEAVE,
      // Packers and bump stop meet 77 mm up from static ride [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE 40000]
      bumpStop: stops(r.front.packerGapM, r.front.bumpStopGapM, 40_000),
      // [spec BUMPSTOP_DN]
      droopTravel: mm(r.front.droopM),
      rollCentreHeight: 0.0535,
      // [spec ARB FRONT]
      arb: 10_000,
      hardpoints: [
        [0.42, 0.1013, 0.055],
        [0.29, 0.0618, -0.201],
        [0.44, -0.15, 0.092],
        [0.329, -0.15221, -0.202],
        [0.1835, 0.1181, -0.01865],
        [0.1405, -0.15221, 0.0179],
        [0.4238, 0.0535, 0.114],
        [0.1754, 0.0675, 0.1258],
      ],
    },
    rear: {
      type: 'SuspensionType_DoubleWishbone',
      actuation: 'push_rod',
      // [spec STATIC_CAMBER]
      staticCamber: -1.2,
      camberGainKinematic: v.rearCamberGain,
      springs: { wheel_rate: v.rearSpringRate, helper_rate: 0, helper_range: 0 },
      heave: NO_HEAVE,
      // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE 45000]
      bumpStop: stops(r.rear.packerGapM, r.rear.bumpStopGapM, 45_000),
      droopTravel: mm(r.rear.droopM),
      rollCentreHeight: v.rearRollCentre,
      // [spec ARB REAR]
      arb: 6000,
      hardpoints: [
        [0.40341, 0.1748, 0.8879],
        [0.45321, 0.1584, 0.0524],
        [0.38581, -0.0591, 0.8879],
        [0.52591, -0.1049, -0.042],
        [0.21311, 0.1726, 0.0382],
        [0.2351, -0.1049, 0.0438],
        [0.52591, v.rearSteerY, -0.042],
        [0.2351, -0.1049, -0.158],
      ],
    },
    dampers_controller: {
      front: {
        // [spec DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND, DAMP_FAST_*THRESHOLD]
        base: damper(2100, 1300, 2700, 1300),
        heave: NO_DAMPER,
        roll: NO_DAMPER,
        pitch: NO_DAMPER,
        fastThresholdMs: 0.058,
        fastReboundThresholdMs: 0.088,
      },
      rear: {
        base: damper(v.rearDamp[0], 1200, v.rearDamp[1], 1800),
        heave: NO_DAMPER,
        roll: NO_DAMPER,
        pitch: NO_DAMPER,
        fastThresholdMs: 0.058,
        fastReboundThresholdMs: 0.088,
      },
    },
  };
}

/**
 * AC's YAW_CL_GAIN as a table: CL × (1 + gain · |yaw| in radians), at the slide angles the car meets (|deg| → ×)
 * [spec, derived]
 */
const yawTable = (yawGain: number): LutPoints =>
  [0, 2, 5, 10, 20, 30].map((deg) => [deg, Number(Math.max(0, 1 + (yawGain * deg * Math.PI) / 180).toFixed(4))]);
const FLAT: LutPoints = [
  [0, 1],
  [0.3, 1],
];

/**
 * The body's drag: chord 1 × span 1.73 m, CD 0.39 at 0° × CD_GAIN 0.88, no lift (CL_GAIN 0) [spec WING_0]: 0.594 m²
 * (its pitch table moves it under 2 % over the rake the car runs at, its ground-height table about as much)
 */
const BODY_CDA = Number((1 * 1.73 * 0.39 * 0.88).toFixed(4));

/** An element of the data whose lift and drag are tables of a setup position, 0 or 50 [spec aero.ini, wing_*.lut] */
const element = (
  name: WingData['name'],
  area: number,
  positionZ: number,
  heightRef: WingData['heightRef'],
  cl: LutPoints,
  cd: LutPoints,
  yawGain: number,
  dragY: number,
): WingData => ({
  name,
  area,
  positionZ,
  angleDeg: 0,
  heightRef,
  lutAOA_CL: cl,
  lutAOA_CD: cd,
  lutGH_CL_mult: FLAT,
  lutGH_CD_mult: FLAT,
  lutYaw_CL_mult: yawTable(yawGain),
  dragY,
});

/**
 * The body lifts: 0.090 m² over the nose (the data's FRONT element, CL −0.082 × CL_GAIN 1 on 1.1 m², 0.24 m ahead of
 * the front axle) and 0.069 m² over the tail (REAR, −0.033 × 1.5 on 1.4 m²) [spec WING_1, WING_2]. These read no angle
 * (one-point tables), so the garage's aero packages, which move the FRONT_WING and REAR_WING elements' angles, leave
 * them as they are
 */
const bodyLift66 = [
  element('FRONT_WING', 1.1, 1.48, 'front', [[0, -0.082]], [[0, 0]], -0.06, -0.241),
  element('REAR_WING', 1.4, -1.1, 'rear', [[0, -0.0495]], [[0, 0]], -0.05, 0.4),
];

/**
 * 1966: the rear spoiler and its gurney extension, each 0 (down / off) or 50 (raised / fitted), set 0 [spec WING_4,
 * WING_3, ANGLE 0; setup.ini 0–50 in one step]: the spoiler adds 0.052 m² of downforce and 0.065 m² of drag raised, the
 * extension 0.029 m² and 0.019 m² fitted, and at 0 its small lip already gives 0.011 m² and takes 0.019 m² of the
 * body's drag. Both read REAR_WING: the garage's high-downforce package raises the spoiler and fits the extension.
 */
const AERO_ELEMENTS_66: WingData[] = [
  ...bodyLift66,
  element('REAR_WING', 0.24, -1.96, 'rear', [[0, 0.045], [50, 0.12]], [[0, -0.08], [50, 0.08]], -0.05, 0.34),
  element('REAR_WING', 0.432, -2.1, 'rear', [[0, 0], [50, 0.12]], [[0, 0], [50, 0.15]], -0.05, 0.5),
];

/**
 * 1967: the nose's lift 0.7 of the 1966 car's and 0.27 m further forward, the tail's 1.25 of its 1.5 [spec WING_1
 * POSITION, CL_GAIN; WING_2 CL_GAIN]; Daytona's kit (0) or Sebring's (50): canards 1.96 m ahead of the CG (0.063 m² of
 * downforce, 0.029 m² of drag) and the bigger spoiler 1.9 m behind it (0.065 / 0.054 m²) [spec WING_3, WING_4]. The
 * canards read FRONT_WING and the spoiler REAR_WING: the garage's high-downforce package is the Sebring kit.
 */
const AERO_ELEMENTS_67: WingData[] = [
  element('FRONT_WING', 1.1, 1.75, 'front', [[0, -0.0574]], [[0, 0]], -0.06, -0.241),
  element('REAR_WING', 1.4, -1.1, 'rear', [[0, -0.04125]], [[0, 0]], -0.05, 0.4),
  element('FRONT_WING', 0.36, 1.96, 'front', [[0, 0], [50, 0.176]], [[0, 0], [50, 0.08]], -0.05, 0),
  element('REAR_WING', 0.432, -1.9, 'rear', [[0, 0], [50, 0.15]], [[0, 0], [50, 0.125]], -0.05, 0.5),
];

function aero(wings: WingData[], r: ReturnType<typeof ride>, plank: { y: number; frontZ: number; rearZ: number }): AeroData {
  return {
    front_lift: 0,
    rear_lift: 0,
    drag: BODY_CDA,
    // The body's drag 0.20 m above the CG [spec WING_0 POSITION]
    dragCentreY: 0.2,
    wings,
    front_target_height: r.frontTarget,
    rear_target_height: r.rearTarget,
    // Floor plane level with the pickups [spec RIDE]
    floorOffsetY: PICKUP_Y,
    plank,
    drsTransitionS: 0.25,
    drsCloseThrottle: 0.5,
    airDensity: 1.225,
  };
}

/**
 * Slicks 0.235 m wide on R 0.325 m at the front, 0.305 m on R 0.335 m at the rear, both on a 0.228 m rim radius; the
 * radius grows 0.057 mm per rad/s of spin, ≈ 12 mm at 250 km/h [spec tyres.ini WIDTH, RADIUS, RIM_RADIUS,
 * RADIUS_ANGULAR_K]
 */
const FRONT_TYRE: TyreGeometry = { width: 0.235, radius: FRONT_RADIUS, rimRadius: 0.2278, verticalRateScale: 1, radiusGrowthPerRadS: 5.7e-5 };
const REAR_TYRE: TyreGeometry = { width: 0.305, radius: REAR_RADIUS, rimRadius: 0.2278, verticalRateScale: 1, radiusGrowthPerRadS: 5.7e-5 };

/** Slip ratio at the peak of the drive force: tan(FRICTION_LIMIT_ANGLE) / CX_MULT of theoretical slip [derived] */
const peakSlipRatio = (frictionLimitDeg: number) => {
  const theoretical = Math.tan((frictionLimitDeg * Math.PI) / 180) / 0.95;
  return Number((theoretical / (1 - theoretical)).toFixed(4));
};

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the static pressure + 2800 N/m per psi [spec] */
const pressureSpring = (rate: number, staticPsi: number): LutPoints =>
  [12, 20, 26, 30, 31, 35, 37, 42, 47].map((p) => [p, Math.round(rate + PSI_RATE * (p - staticPsi))]);

/**
 * The data's one compound, "LM60" [spec tyres.ini FRONT / REAR]: the newer tyre data, peak μ at a reference load
 * (DY_REF / DX_REF at FZ0) falling with load by a power law (LS_EXPY / LS_EXPX); the file's DY0 / DY1 and FLEX entries
 * belong to the older kind and are not read. At the 1966 car's static loads that is μ ≈ 1.27 on the fronts and 1.25 on
 * the rears.
 */
function lm60(frontPsi: number, rearPsi: number): TyresCompoundData {
  return {
    name: 'LM60',
    shortName: 'M',
    tyre_compound: 'PhysicsTyreCompound_GT3_Medium',
    // Sliding under load wears in proportion, counted per 2000 N of it [spec VIRTUALKM USE_LOAD, WEAR_CURVE
    // hard_front.lut; the rear's hard_rear.lut is the same]
    wear: {
      curve: [
        [0, 99],
        [0.18, 100],
        [9, 100],
        [16.2, 99],
        [19.8, 98],
        [36, 95],
      ],
      loadScaled: true,
      loadRefN: 2000,
    },
    front: FRONT_TYRE,
    rear: REAR_TYRE,
    modelData: {
      // [spec DY_REF, DX_REF at FZ0; LS_EXPY, LS_EXPX]
      Dy0: 1.26,
      Dx0: 1.27,
      lsExpY: 0.7911,
      lsExpX: 0.8025,
      Fz0: 2060,
      // A brush tyre, on the mod's own shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with
      // load (3.96 % per FZ0) and with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the longitudinal stiffness
      // [spec CX_MULT], the rising branch's fullness [spec XMU] and the grip lost to sliding speed [spec
      // SPEED_SENSITIVITY]. No COMBINED_FACTOR in the data: the friction circle
      curve: 'brush',
      curveFullness: 0.2,
      friction_limit_angle: 9.5,
      peakSlipLoadGain: 0.0396,
      peakSlipPressureGain: 0.6,
      combinedExponent: 2,
      longStiffnessMult: 0.95,
      speedSensitivity: 0.004075,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 4.2,
      slip_ratio_limit: peakSlipRatio(9.5),
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [spec FALLOFF_LEVEL, FALLOFF_SPEED]: a gentle slope past the peak, to 97.6 %
      use_slip_falloff: true,
      falloff_level: 0.976,
      falloff_slope: 2,
      // [spec RELAXATION_LENGTH]
      relaxationLengthX: 0.10313,
      relaxationLengthY: 0.10313,
      // 12 N + 0.00078 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
      rollingResistance: 0.012,
      rollingResistanceSpeedSq: 7.8e-7,
      // Scrub at the peak slip, and no more past it [spec ROLLING_RESISTANCE_SLIP]
      rollingResistanceSlipGain: 0.954,
      rollingResistanceSlipMax: 1,
      // [spec DAMP]
      verticalDamping: 500,
      // [spec BRAKE_DX_MOD]
      brakeDxMod: 0.06,
    },
    thermalData: {
      // Grip against tread temperature (°C) [spec tcurve_60s.lut]: full from 40 to 80 °C, 80 % stone cold
      thermalPerformanceCurve: [
        [0, 0.8],
        [20, 0.9],
        [40, 1],
        [80, 1],
        [90, 0.998],
        [110, 0.995],
        [140, 0.98],
        [180, 0.95],
        [240, 0.8],
        [300, 0.6],
      ],
      optimalTempC: [40, 80],
      // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]; the graining wears off as the tread slides
      tread: { grainGain: 0.4, grainGamma: 1, blisterGain: 0.3, blisterGamma: 1, wearOffWithSlip: true },
      // Pressure moves the heat: the sliding heat and the crown against the shoulders [ref], the rolling heat by
      // PRESSURE_RR_GAIN [spec]
      pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
      // The M1's heat capacities, hysteresis and cooling [est]: the data's own thermal constants are for AC's tyre model,
      // not this one. From the pit lane's 20 °C the tyres reach 54–60 °C by the third lap, 50 °C past where their grip is
      // full, their pressures at the data's 37 psi ideal (on the GT3's capacities and the M1's old 0.0044 they sat 3–5 psi
      // short)
      surfaceHeatCapacity: 900,
      coreHeatCapacity: 5500,
      slipHeatShare: 0.35,
      hysteresis: 0.0084,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      // Through the sidewalls; the rest of the carcass's heat leaves through the gas and the rim [est]
      coreCooling: [4, 0.1],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 80,
    },
    pressureData: {
      // [spec PRESSURE_IDEAL]
      optimalPsi: 37,
      // [spec PRESSURE_STATIC], set cold
      setPsi: frontPsi,
      pressureSpringCurve: pressureSpring(FRONT_RATE, frontPsi),
      // [spec PRESSURE_RR_GAIN]
      pressureRollingGain: 1.1,
      pressureGripSensitivity: 1.0,
      // 0.8 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
      pressureGripLossPerPsi: 0.008,
      // No blankets in 1966: set in the pit lane at 20 °C [est]
      coldRefC: 20,
    },
    camberData: {
      // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]: grip falls off with camber either way (no gain leaning in)
      camberGain: 0.19,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: 0,
      dcamber1: -3,
      dcamber0_x: 0,
      dcamber1_x: -3,
    },
    // The wider rear: its own reference load, load sensitivity, peak slip angle and its growth, sliding loss, rolling
    // resistance, relaxation, damping, camber thrust and radial rate [spec REAR]
    rearOverride: {
      modelData: {
        Fz0: 2673,
        lsExpY: 0.8583,
        lsExpX: 0.8563,
        friction_limit_angle: 8.5,
        peakSlipLoadGain: 0.0379,
        slip_ratio_limit: peakSlipRatio(8.5),
        speedSensitivity: 0.003955,
        relaxationLengthX: 0.10893,
        relaxationLengthY: 0.10893,
        rollingResistanceSpeedSq: 5.5e-7,
        rollingResistanceSlipGain: 0.98,
        verticalDamping: 650,
      },
      camberData: { camberGain: 0.28 },
      pressureData: { setPsi: rearPsi, pressureSpringCurve: pressureSpring(REAR_RATE, rearPsi) },
    },
  };
}

/** The slicks plus rain tyres on their carcass, as the M1's [est]: the mod has slicks only */
const tyres = (frontPsi: number, rearPsi: number) => {
  const slick = lm60(frontPsi, rearPsi);
  return {
    PhysicsTyreCompound_GT3_Medium: slick,
    PhysicsTyreCompound_GT3_Intermediate: deriveRainCompound(slick, 'intermediate', 'PhysicsTyreCompound_GT3_Intermediate', 'Intermediate'),
    PhysicsTyreCompound_GT3_Wet: deriveRainCompound(slick, 'wet', 'PhysicsTyreCompound_GT3_Wet', 'Wet'),
  } satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;
};

/** Equivalent box 1.554 × 0.903 × 3.612 m [spec car.ini INERTIA] */
const inertia = (mass: number) => {
  const box = (a: number, b: number) => (mass / 12) * (a * a + b * b);
  return { pitch: box(0.903, 3.612), roll: box(1.554, 0.903), yaw: box(1.554, 3.612) };
};

/** One element (front, rear) of the setup's two aero kits: 0 the base, 50 the other [spec setup.ini WING_x] */
export const CHAPARRAL_AERO_KIT_DEG = 50;

/**
 * 2000 Nm at full pedal, the bias adjustable in 0.5 % steps, no handbrake; the pads' grip is 70 % cold,
 * full from 400 to 600 °C, 70 % at 800 and 20 % at 1200 (the same curve front and rear) [spec brakes.ini]. The iron
 * discs' model is set for a GT3's ducts, on which these peaked at 211 °C (front) and 130 (rear) a lap, braking on
 * 84 / 79 % of the torque: on 40 % of that air the fronts reach 400–410 °C and the rears 235–260 (87 %) [est], the
 * rears on the fronts' cooling as the data's COOL_TRANSFER has it (0.009 both) [spec]
 */
const BRAKES = {
  maxTorqueNm: 2000,
  // The default tune's 63 % front [est]: at the data's 56 % [spec FRONT_SHARE] the rears, which carry 54–60 % of the
  // weight and lose much of it to the transfer under braking, spun the car braking in fast corners. The garage's
  // adjuster still runs 48–80 %
  front_bias: 0.63,
  handbrakeTorqueNm: 0,
  ebbStep: 0.005,
  brakeByWire: false,
  discMaterial: 'endurance-steel' as const,
  ductShare: 0.4,
  padMuCurve: [
    [0, 0.7],
    [300, 0.9],
    [400, 1],
    [600, 1],
    [800, 0.7],
    [1200, 0.2],
  ] as LutPoints,
  migration: { amount: 0, rampStart: 0 },
};

/** Locking torque = preload + POWER / COAST × input torque [spec DIFFERENTIAL] */
const DIFFERENTIAL = {
  type: 'LSD_Ramp' as const,
  settings: { power: 0.45, coast: 0.3, preload: 5, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
};

/**
 * The converter: the data gives it as an auto clutch held on (FORCED_ON) that takes up the drive from 1150 rpm and is
 * home only by 6700 [spec CLUTCH MAX_TORQUE 1200, AUTOCLUTCH MIN_RPM / MAX_RPM], so the engine runs up to ≈ 3300 rpm
 * against the wheels at full pedal before the drive locks up, as a torque converter's stall speed does
 */
const CONVERTER = { maxTorqueNm: 1200, biteRpm: 1150, lockRpm: 6700 };

const SCREEN = { '66': 'Chaparral 2D', '67': 'Chaparral 2D 427' } as const;

function config(year: '66' | '67') {
  const v = year === '66' ? V66 : V67;
  const r = ride(v);
  return {
    screenName: SCREEN[year],
    chassis: {
      totalMassKg: v.mass,
      frontWeightFraction: v.frontWeight,
      // [spec WHEELBASE, TRACK]. The data's tracks are 2–5 cm wider than the body's wheels stand (chaparral-2d.glb), so
      // the contact patches sit a little outboard of the drawn tyres; the handling is the data's
      wheelbase: WHEELBASE,
      trackWidthFront: 1.422,
      trackWidthRear: 1.346,
      cgHeight: r.cgHeight,
      inertia: inertia(v.mass),
      unsprungMassFront: FRONT_HUB_KG,
      unsprungMassRear: REAR_HUB_KG,
      // The tank 0.10 m below the CG and 0.20 m (1967: 0.40 m) ahead of it [spec FUELTANK POSITION]
      fuelTank: { y: -0.1, z: year === '66' ? 0.2 : 0.4 },
      // [spec tyres.ini ANGULAR_INERTIA]
      wheelInertiaFront: 1.26,
      wheelInertiaRear: 1.84,
      // 360° of rim lock each way on a 14.1:1 rack [spec STEER_LOCK, STEER_RATIO]
      maxRoadWheelDeg: 360 / 14.1,
      // The kingpin (WBTYRE_BOTTOM → WBTYRE_TOP) leans back 7.7° and meets the ground 41 mm ahead of the contact patch [derived]
      ffbMechanicalTrailM: 0.041,
      // The body's plan at barrier height, measured from the GLB (`scripts/measure-car-plans.ts`)
      bodyPlan: year === '66'
        ? [[0.0, 2.12], [0.57, 1.87], [0.83, 1.48], [0.89, -1.24], [0.71, -1.98], [0.0, -2.04]]
        : [[0.0, 2.12], [0.66, 1.89], [0.88, 1.68], [0.89, -1.24], [0.8, -2.04], [0.0, -2.12]],
    },
    engine: year === '66' ? engine(WHEEL_TORQUE_327, 130, 0.245) : engine(WHEEL_TORQUE_427, 156, 0.27),
    ers: ERS,
    performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
    // 1966: two speeds, 1.76 and direct, on the 2.88 final drive (the setup's tallest of four): first runs to ≈ 170 km/h
    // and second to ≈ 300 at the limiter. 1967: three, 1.91 / 1.30 / 0.98 on 2.70: ≈ 165 / 245 / 325 km/h [spec
    // drivetrain.ini GEARS, final.rto]
    gearbox: year === '66' ? gearbox([1.76, 1], 1.76, 2.88, 6300) : gearbox([1.91, 1.3, 0.98], 2.462, 2.7, 6300),
    clutch: CONVERTER,
    differential: DIFFERENTIAL,
    brakes: BRAKES,
    suspensions: suspensions(v, r),
    // The body's ground colliders: the tub's underside 0.25 m below the CG, from its tail to the nose's (1967: the
    // longer nose) [spec colliders.ini COLLIDER_0, COLLIDER_1]
    aero: aero(year === '66' ? AERO_ELEMENTS_66 : AERO_ELEMENTS_67, r, { y: -0.25, frontZ: year === '66' ? 1.91 : 2.01, rearZ: -0.79 }),
    tyreCompounds: tyres(v.frontPsi, v.rearPsi),
    compoundSlots: {
      soft: 'PhysicsTyreCompound_GT3_Medium',
      medium: 'PhysicsTyreCompound_GT3_Medium',
      hard: 'PhysicsTyreCompound_GT3_Medium',
      intermediate: 'PhysicsTyreCompound_GT3_Intermediate',
      wet: 'PhysicsTyreCompound_GT3_Wet',
    },
  } satisfies CarPhysicsConfig;
}

export const CHAPARRAL_2D_CONFIG = config('66');
export const CHAPARRAL_2D_67_CONFIG = config('67');

/**
 * The car has no traction control or ABS (PRESENT=0), but the data sets both up: TC at 12 % wheelspin cycling at
 * 200 Hz, off under 60 km/h; ABS at 13 % cycling at 220 Hz [spec electronics.ini]. They serve the assisted presets (and
 * the semi-pro ABS, which the AI brakes on); the other positions step 0.5 % (ABS) and 1 % (TC) either side [est]. The
 * lateral and rear slide terms are the M1's [est]
 */
export const CHAPARRAL_2D_ELECTRONICS = {
  absLevels: [0.1, 0.105, 0.11, 0.115, 0.12, 0.125, 0.13, 0.135, 0.14, 0.145, 0.15, 0.155],
  absDefault: 0.13,
  absRateHz: 220,
  tcLevels: [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17],
  tcDefault: 0.12,
  tcRateHz: 200,
  tcMinSpeedKmh: 60,
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
