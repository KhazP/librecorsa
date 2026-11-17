/**
 * Volkswagen Scirocco GTX 16V (Mk2, 53B) vehicle data for `VehiclePhysics` (same data model as the f12026-car, see
 * `F12026CarConfig`): the mid-80s coupé with the 1.8 l sixteen-valve four.
 *
 * The numbers come from Pfalzdriver's "Volkswagen Scirocco GTX 16V" (GTPlanet, Assetto Corsa), mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * Front-wheel drive through a mildly locking differential, a five-speed manual on the 2Y box's ratios, a MacPherson
 * strut at the front (solved here as a double wishbone with a long virtual upper arm square to the strut, which gives a
 * strut's camber curve and roll centre) and trailing arms at the rear. No ABS or traction control (electronics.ini
 * has both PRESENT=0). One tyre, the 195 street tyre, in every slot: a road car has no slicks or rain tyres to change to.
 *
 * The rear sits on its droop stops: BUMPSTOP_DN is negative, so at rest the springs (on their 70 mm rods) push the
 * wheels 76 mm past the stop and the stop holds them there. The rear corners don't move until one carries ≈ 4 kN,
 * three times its static load: in a corner the rear axle is all but rigid in roll, which is what lifts the inside rear
 * wheel the way these cars do. The droop travel below is that negative distance, so the car settles onto the stops
 * as the mod's does.
 */
import type { LutPoints } from '../lut';
import type {
  AeroData,
  CarPhysicsConfig,
  DamperSettingsUnits,
  PerformanceModeData,
  PerformanceModeName,
  SuspensionsData,
  TyreGeometry,
  TyresCompoundData,
} from '../f12026-car/F12026CarConfig';
import type { WetTyreTraits } from '../wet-tyres';
import { modBodyHeightM, modCornerStops } from '../mod-suspension';

/** Driveline efficiency of this model; the wheel torque curve is divided by it for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/** Wheel torque curve (rpm → Nm) [spec power.lut]: 168 Nm at 4600–4800 rpm, ≈ 104 kW (139 bhp) at 6400 */
const WHEEL_TORQUE: [number, number][] = [
  [0, 58],
  [500, 58],
  [1000, 77],
  [1200, 97],
  [1600, 121],
  [1800, 129],
  [2200, 141],
  [2400, 145],
  [2800, 152],
  [3200, 157],
  [3400, 159],
  [3800, 163],
  [4000, 164],
  [4200, 166],
  [4400, 167],
  [4800, 168],
  [5000, 167],
  [5400, 166],
  [5600, 164],
  [5800, 163],
  [6200, 161],
  [6400, 157],
  [6600, 147],
  [6800, 133],
  [7000, 110],
  [7200, 92],
  [7600, 58],
];

/** Crank power (kW) at the curve's points [derived] */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, ((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque from nothing at idle, 120 Nm at 6000 rpm [spec COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [900, 0],
    [6000, 120],
    [7600, 157.6],
  ] as LutPoints,
  // Pedal → throttle: a quick first tenth, then near linear [spec throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [0.1, 0.25],
    [0.2, 0.35],
    [0.3, 0.45],
    [0.4, 0.55],
    [0.5, 0.65],
    [0.6, 0.7],
    [0.7, 0.75],
    [0.8, 0.8],
    [0.9, 0.9],
    [1, 1],
  ] as LutPoints,
  // [spec MINIMUM]
  idleRpm: 900,
  // Engine 0.110 + gearbox 0.020 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.13,
  // 20 Hz limiter: the cut lasts one cycle [spec LIMITER_HZ]
  limiterCutS: 0.05,
  // A tenth of a change in air density reaches the torque [spec ALTITUDE_SENSITIVITY]
  airDensitySensitivity: 0.1,
};

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
  coastTorqueScale: 1,
  ebbOffset: 0,
});

/**
 * Five-speed manual on a 3.667 final drive, the 2Y box's ratios [spec drivetrain.ini]: 209 km/h in fifth at the 7500 rpm
 * limiter, the car's quoted top speed. An up-shift is 230 ms between gears with the throttle cut for 220 ms of it [spec
 * CHANGE_UP_TIME, AUTO_CUTOFF_TIME]
 */
const GEARBOX = {
  ratios: [3.445, 2.118, 1.444, 1.129, 0.912],
  reverse: 3.16,
  finalDrive: 3.667,
  shiftTimeS: 0.23,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.26,
  shiftTorqueFraction: 0,
  upshiftNeutralS: 0.23,
  upshiftCutS: 0.22,
  upshiftCutLift: true,
  // Down: 260 ms between gears with the driver's 70 % blip rising over 30 ms, the clutch let out from 110 ms and home
  // at 220 [spec CHANGE_DN_TIME, DOWNSHIFT_PROFILE, AUTOBLIP]
  downshift: { neutralS: 0.26, clutchReleaseS: 0.11, clutchHomeS: 0.22, blip: { level: 0.7, riseS: 0.03 } },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 7500,
    // Past ≈ 7000 rpm the next gear pulls harder than this one (1st → 2nd at 7100, 3rd → 4th at 6850) [derived
    // power.lut, ratios]
    upshift_rpm: 7000,
    // [spec ai.ini GEARS DOWN]
    downshift_rpm: 3500,
    // Into a braking zone the auto box clicks down while the lower gear lands under 6000 rpm, short of the 6400 rpm
    // power peak [est]
    brake_downshift_rpm: 6000,
    // A mild limited-slip: flat out of a slow corner the inside front still spins up, and the box should change up on
    // the engine's speed, not wait for the road speed of the shift point
    spin_upshift: true,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

const MASS = 1020;
const WHEELBASE = 2.41;
/** Share of the sprung weight on the front axle [spec CG_LOCATION] */
const FRONT_WEIGHT = 0.625;
const FRONT_HUB_KG = 90;
const REAR_HUB_KG = 85;
/** Sprung load on a front / rear spring at static ride (N): the car less its hubs [derived] */
const SPRUNG_KG = MASS - 2 * FRONT_HUB_KG - 2 * REAR_HUB_KG;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * FRONT_WEIGHT) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * (1 - FRONT_WEIGHT)) / 2;
/**
 * Tyre radial rate at the 37 psi each runs at hot (N/m): RATE 263 372 at the 28 psi (front) / 30 psi (rear) static
 * pressure + 8112 N/m per psi [spec RATE, PRESSURE_STATIC, PRESSURE_SPRING_GAIN, PRESSURE_IDEAL]
 */
const FRONT_HOT_TYRE_RATE = 263_372 + 8112 * (37 - 28);
const REAR_HOT_TYRE_RATE = 263_372 + 8112 * (37 - 30);
/**
 * The mod measures its stops from the suspension's design position, with the springs working on their rod lengths
 * (`mod-suspension.ts`): the soft front springs hold the fronts 27.9 mm past that position at static, so the packer
 * is 140 mm up, the strut's stop 212 mm up and the droop stop 20.6 mm down. The rear springs would hold the rears
 * 36.7 mm past it, beyond the droop stop BUMPSTOP_DN puts 39.6 mm short of it: the droop travel is −76 mm, and the car
 * settles 76 mm into the rear travel onto the stops (above) [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN; derived]
 */
const FRONT_STOPS = modCornerStops({
  staticLoadN: FRONT_STATIC_LOAD_N,
  springRate: 55_296,
  rodLength: 0.065,
  packerRange: 0.1771,
  bumpStopUp: 0.1843,
  bumpStopDn: 0.0485,
});
const REAR_STOPS = modCornerStops({
  staticLoadN: REAR_STATIC_LOAD_N,
  springRate: 36_974,
  rodLength: 0.07,
  packerRange: 0.2249,
  bumpStopUp: 0.2451,
  bumpStopDn: -0.0396,
});
const mm = (m: number) => Number(m.toFixed(4));
/** No heave element: a spring that never engages */
const NO_HEAVE = { rate: 0, gap: 1, packerGap: 1, packerRate: 0 };

/**
 * The front strut: its top mount stands in for the upper ball joint, with a 1 m virtual upper arm square to the strut
 * axis (STRUT_CAR → STRUT_TYRE) in the front view [derived]; lower arm and tie rod [spec]. Kingpin inclination 17.5°,
 * caster 4.2°; the kinematic solver gives −29.3°/m of camber gain and a 109 mm roll centre on these points, and the
 * rear trailing arms none and 11 mm [derived].
 */
const STRUT_CAR: [number, number, number] = [0.25366, 0.54933, -0.04296];
const STRUT_TYRE: [number, number, number] = [0.07174, -0.1371, 0.01213];
const strutDx = STRUT_CAR[0] - STRUT_TYRE[0];
const strutDy = STRUT_CAR[1] - STRUT_TYRE[1];
const strutLen = Math.hypot(strutDx, strutDy);
/** The virtual upper arm's inboard end, 1 m from the top mount square to the strut, 150 mm either side of it */
const VIRTUAL_ARM: [number, number] = [
  Number((STRUT_CAR[0] + strutDy / strutLen).toFixed(4)),
  Number((STRUT_CAR[1] - strutDx / strutLen).toFixed(4)),
];

/**
 * The rear's two arms in the data pivot on one axis (WBCAR_TOP_* = WBCAR_BOTTOM_*, the toe link along it too): a
 * trailing arm, swinging the hub about a line from 100 mm inboard and 393 mm ahead of it to 800 mm inboard and 303 mm
 * ahead. Solved here as two parallel arms on that axis 140 mm apart, the upright's ball joints' spacing, with a toe
 * link parallel to them: the hub swings about the same line, without the upright's small pitch [derived].
 */
const REAR_UPPER = 0.14;
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_Strut',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -0.6,
    camberGainKinematic: -29.3,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 55_296, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // The packer at BUMP_STOP_RATE, the strut's rigid stop (500 kN/m, as a strut's is) [spec PACKER_RANGE, BUMPSTOP_UP,
    // BUMP_STOP_RATE]
    bumpStop: { range: mm(FRONT_STOPS.packerGapM), rate: 50_000, progression: 0, hardStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 500_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.109,
    // [spec ARB FRONT]
    arb: 20_000,
    hardpoints: [
      [VIRTUAL_ARM[0], VIRTUAL_ARM[1], Number((STRUT_CAR[2] + 0.15).toFixed(4))],
      [VIRTUAL_ARM[0], VIRTUAL_ARM[1], Number((STRUT_CAR[2] - 0.15).toFixed(4))],
      [0.35, -0.1, 0],
      [0.35, -0.1, -0.27],
      STRUT_CAR,
      [0.04, -0.13, 0.0067],
      [0.42, 0.13, 0.127],
      [0.05, 0.16, 0.11],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -0.9,
    camberGainKinematic: 0,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 36_974, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(REAR_STOPS.packerGapM), rate: 50_000, progression: 0, hardStop: { range: mm(REAR_STOPS.bumpStopGapM), rate: 50_000 } },
    // Negative: the rear rests on its droop stops (above) [spec BUMPSTOP_DN]
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: 0.011,
    // [spec ARB REAR]
    arb: 11_000,
    hardpoints: [
      [0.1, -0.09 + REAR_UPPER, 0.393],
      [0.8, -0.09 + REAR_UPPER, 0.303],
      [0.1, -0.09, 0.393],
      [0.8, -0.09, 0.303],
      [0.06, 0, 0],
      [0.06, -0.14, 0],
      [0.8, -0.02, 0.203],
      [0.06, -0.07, -0.1],
    ],
  },
  dampers_controller: {
    front: {
      // [spec DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND, DAMP_FAST_*THRESHOLD]
      base: damper(3273, 1934, 8875, 7601),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.1,
      fastReboundThresholdMs: 0.14,
    },
    rear: {
      base: damper(3273, 1934, 8873, 3601),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.1,
      fastReboundThresholdMs: 0.14,
    },
  },
};

/**
 * The body's height at each axle is the tyre's loaded radius less the wheel centre's height in the body frame (BASEY
 * −0.27 / −0.33, plus the static offset) [spec BASEY, RADIUS; derived]. The rear's is where its springs alone would
 * hold it; the car then settles 76 mm onto the rear droop stops, level with the front, as the mod's does. The
 * ride-height pickups sit 0.40 m below the CG's level [spec RIDE].
 */
const FRONT_BODY_HEIGHT = modBodyHeightM(0.2475, (FRONT_STATIC_LOAD_N + FRONT_HUB_KG * 9.81) / FRONT_HOT_TYRE_RATE, -0.27, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(0.2475, (REAR_STATIC_LOAD_N + REAR_HUB_KG * 9.81) / REAR_HOT_TYRE_RATE, -0.33, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * (1 - FRONT_WEIGHT)).toFixed(4));
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT - 0.4).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT - 0.4).toFixed(4));

/** No ground-height table (the front element names one the data doesn't have): × 1 */
const FLAT: LutPoints = [
  [0, 1],
  [0.3, 1],
];

/**
 * The body element: chord 1 × span 1.67 m at 1° [spec WING_0], CL 0.07 (CL_GAIN 1) and CD 0.185 (its table × CD_GAIN
 * 0.5) there: 0.117 m² of downforce 0.17 m behind the CG, as body lift at the axles, and 0.309 m² of drag
 * [spec, derived]. Its angle-of-attack tables move it little over the car's ±2° of pitch.
 */
const BODY_CLA = 0.07 * 1.67;
// The front axle carries the share of a load at the CG-to-rear-axle distance (FRONT_WEIGHT × wheelbase) less its 0.17 m
const BODY_FRONT_SHARE = (FRONT_WEIGHT * WHEELBASE - 0.17) / WHEELBASE;

/**
 * Body, front splitter and rear spoiler with the mod's angle-of-attack tables, their gains folded in [spec aero.ini]:
 * at rest CL·A ≈ 0.19 m² (0.12 body, 0.04 splitter at 2°, 0.03 spoiler at 3°) for CD·A ≈ 0.33 m². A low drag for the
 * shape: the car runs to its limiter in fifth, as the mod's does.
 */
const AERO: AeroData = {
  front_lift: Number((BODY_CLA * BODY_FRONT_SHARE).toFixed(4)),
  rear_lift: Number((BODY_CLA * (1 - BODY_FRONT_SHARE)).toFixed(4)),
  drag: Number((0.185 * 1.67).toFixed(4)),
  // Body 0.45 m above the CG [spec WING_0 POSITION]: nearly all the drag
  dragCentreY: 0.45,
  wings: [
    {
      name: 'FRONT_WING',
      // [spec WING_1 CHORD × SPAN, POSITION, ANGLE]
      area: 0.96,
      positionZ: 1.8,
      angleDeg: 2,
      heightRef: 'front',
      // × CL_GAIN 0.1
      lutAOA_CL: [
        [-10, -0.005],
        [-2, 0.04],
        [0, 0.035],
        [2, 0.045],
        [5, 0.045],
        [8, 0.045],
        [10, 0.0433],
      ],
      // × CD_GAIN 0.5
      lutAOA_CD: [
        [-10, 0],
        [-2, 0],
        [0, 0],
        [2, 0.02],
        [5, 0.02],
        [8, 0.02],
        [10, 0.02],
      ],
      lutGH_CL_mult: FLAT,
      lutGH_CD_mult: FLAT,
    },
    {
      name: 'REAR_WING',
      // The boot-lid spoiler [spec WING_2 CHORD × SPAN, POSITION, ANGLE]
      area: 1.04,
      positionZ: -1.8,
      angleDeg: 3,
      heightRef: 'rear',
      // × CL_GAIN 0.1
      lutAOA_CL: [
        [-10, -0.04],
        [-2, 0.045],
        [0, 0.0125],
        [2, 0.0225],
        [4, 0.0325],
        [6, 0.0425],
        [8, 0.0525],
        [10, 0.0575],
        [12, 0.0625],
        [14, 0.0675],
        [16, 0.0725],
        [18, 0.0775],
        [20, 0.0825],
        [22, 0.08],
      ],
      // × CD_GAIN 0.1
      lutAOA_CD: [
        [-10, 0.1],
        [-2, 0.00025],
        [0, 0.0006],
        [2, 0.0015],
        [4, 0.003],
        [6, 0.0045],
        [8, 0.006],
        [10, 0.008],
        [12, 0.01],
        [14, 0.012],
        [16, 0.012],
        [18, 0.015],
        [20, 0.02],
        [22, 0.025],
      ],
      lutGH_CL_mult: FLAT,
      lutGH_CD_mult: FLAT,
    },
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane level with the pickups, 0.40 m below the CG [spec RIDE]
  floorOffsetY: -0.4,
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/** 195 street tyre: R 0.2475 m on a 0.19 m rim radius; the radius grows 0.01 mm per rad/s of spin [spec tyres.ini] */
const STREET: TyreGeometry = { width: 0.195, radius: 0.2475, rimRadius: 0.19, verticalRateScale: 1, radiusGrowthPerRadS: 1e-5 };

/** The tyre's reference load [spec FZ0] */
const FZ0 = 2274;
/** The mod's load-sensitivity table (N → peak μ), the same lateral and longitudinal [spec DY_CURVE / DX_CURVE] */
const GRIP: LutPoints = [
  [0, 1.3124],
  [3000, 1.19],
  [6000, 1.07],
  [9000, 0.95],
  [12000, 0.85],
  [15000, 0.77],
  [18000, 0.69],
  [21000, 0.63],
  [24000, 0.59],
];
/** The table at FZ0 [derived] */
const MU_FZ0 = Number((1.3124 + ((1.19 - 1.3124) * FZ0) / 3000).toFixed(4));

/** Slip ratio at the peak of the drive force: tan(FRICTION_LIMIT_ANGLE) / CX_MULT of theoretical slip [derived] */
const peakSlipRatio = (frictionLimitDeg: number) => {
  const theoretical = Math.tan((frictionLimitDeg * Math.PI) / 180) / 1.02;
  return Number((theoretical / (1 - theoretical)).toFixed(4));
};

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the static pressure + 8112 N/m per psi [spec] */
const pressureSpring = (staticPsi: number): LutPoints =>
  [15, 20, 28, 30, 37, 42, 48].map((p) => [p, Math.round(263_372 + 8112 * (p - staticPsi))]);

/**
 * A road tyre's tread clears water well, unlike a slick, and grips on a wet road at about two thirds of its dry level
 * [est, as the Liana's]; it is its own dry tyre, so the grip tables and working window stay as they are.
 */
const STREET_TYRE_TRAITS: WetTyreTraits = {
  dryGrip: 1,
  wetGrip: 0.7,
  clearMm: 2.2,
  treadDepthMm: 7,
  tempShiftC: 0,
  dryWearScale: 1,
  dryHeatScale: 1,
  wetWearScale: 0.7,
};

const STREET_COMPOUND: TyresCompoundData = {
  name: 'Street',
  shortName: 'S',
  tyre_compound: 'PhysicsTyreCompound_Road_Street',
  wetTraits: STREET_TYRE_TRAITS,
  // Grip (% of new) against km slid, counted per 2000 N of load [spec street90_front.lut, VIRTUALKM USE_LOAD]
  wear: {
    curve: [[0, 99], [0.1, 99], [0.2, 100], [0.3, 99], [0.5, 99.5], [1, 99], [1.5, 98.5], [4, 96], [10, 93], [14, 92], [20, 88]],
    loadScaled: true,
    loadRefN: 2000,
  },
  front: STREET,
  rear: STREET,
  modelData: {
    // The table at FZ0, and the power law the table replaces [spec FZ0, LS_EXPY, LS_EXPX]
    Dy0: MU_FZ0,
    Dx0: MU_FZ0,
    lsExpY: 0.8227,
    lsExpX: 0.8901,
    Fz0: FZ0,
    dyCurve: GRIP,
    dxCurve: GRIP,
    // A brush tyre on the mod's own shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with load
    // (3.1 % per FZ0) and with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the fuller rising branch [spec XMU],
    // the longitudinal stiffness [spec CX_MULT] and the grip lost to sliding speed [spec SPEED_SENSITIVITY]
    curve: 'brush',
    friction_limit_angle: 8.79,
    peakSlipLoadGain: 0.0314,
    peakSlipPressureGain: 0.45,
    curveFullness: 0.28,
    combinedExponent: 2,
    longStiffnessMult: 1.02,
    speedSensitivity: 0.003623,
    // Unused by a brush tyre (the magic-formula family's stiffness law)
    pKy2: 4.2,
    slip_ratio_limit: peakSlipRatio(8.79),
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    // Past the peak the grip falls to 87 % [spec FALLOFF_LEVEL, FALLOFF_SPEED]
    use_slip_falloff: true,
    falloff_level: 0.87,
    falloff_slope: 4,
    // [spec RELAXATION_LENGTH]
    relaxationLengthX: 0.07253,
    relaxationLengthY: 0.07253,
    // 10 N + 0.00099 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
    rollingResistance: 0.01,
    rollingResistanceSpeedSq: 9.9e-7,
    // A street tyre scrubs: at the peak slip, and no more past it [spec ROLLING_RESISTANCE_SLIP]
    rollingResistanceSlipGain: 4.698,
    rollingResistanceSlipMax: 1,
    // [spec DAMP]
    verticalDamping: 500,
    // [spec BRAKE_DX_MOD]
    brakeDxMod: 0.05,
  },
  thermalData: {
    // Grip against tread temperature (°C) [spec tcurve_street90.lut]
    thermalPerformanceCurve: [
      [0, 0.8],
      [20, 0.97],
      [40, 0.98],
      [60, 0.99],
      [75, 1],
      [85, 1],
      [95, 0.97],
      [100, 0.96],
      [110, 0.96],
      [140, 0.96],
      [160, 0.95],
      [220, 0.9],
      [250, 0.6],
    ],
    optimalTempC: [75, 85],
    // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]; the graining wears off as the tread slides
    tread: { grainGain: 0.4, grainGamma: 1, blisterGain: 0.4, blisterGamma: 1, wearOffWithSlip: true },
    // Pressure moves the heat: the sliding heat and the crown against the shoulders [ref], the rolling heat by
    // PRESSURE_RR_GAIN [spec]
    pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
    // A street tyre's heat capacities and cooling, as the Liana's [est]
    surfaceHeatCapacity: 1100,
    coreHeatCapacity: 6600,
    slipHeatShare: 0.35,
    hysteresis: 0.0028,
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
    // [spec PRESSURE_STATIC]: 28 psi front, 30 rear, set cold
    setPsi: 28,
    pressureSpringCurve: pressureSpring(28),
    // [spec PRESSURE_RR_GAIN]
    pressureRollingGain: 0.55,
    pressureGripSensitivity: 1.0,
    // 0.4 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
    pressureGripLossPerPsi: 0.004,
    // Set cold in the pits, not on blankets [est]
    coldRefC: 25,
  },
  camberData: {
    // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]
    camberGain: 0.116,
    contact_camber_c1: 1,
    contact_camber_c2: 40,
    dcamber0: 1.1,
    dcamber1: -13,
    dcamber0_x: 0,
    dcamber1_x: -6,
  },
  // The rear's own static pressure [spec REAR PRESSURE_STATIC]
  rearOverride: {
    pressureData: {
      optimalPsi: 37,
      setPsi: 30,
      pressureSpringCurve: pressureSpring(30),
    },
  },
};

/** Equivalent box 1.6 × 1.5 × 4.5 m [spec INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const VW_SCIROCCO_CONFIG = {
  screenName: 'Volkswagen Scirocco GTX 16V',
  drivenAxle: 'front',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: FRONT_WEIGHT,
    // [spec WHEELBASE, TRACK]
    wheelbase: WHEELBASE,
    trackWidthFront: 1.404,
    trackWidthRear: 1.372,
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(1.5, 4.5), roll: box(1.6, 1.5), yaw: box(1.6, 4.5) },
    // [spec HUB_MASS]
    unsprungMassFront: FRONT_HUB_KG,
    unsprungMassRear: REAR_HUB_KG,
    // The tank sits 1.65 m behind the CG and 0.35 m below it [spec FUELTANK POSITION]
    fuelTank: { y: -0.35, z: -1.65 },
    // [spec ANGULAR_INERTIA]
    wheelInertiaFront: 1,
    wheelInertiaRear: 1,
    // 450° lock each way on a 14:1 rack [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 450 / 14,
    // The kingpin (lower ball joint → strut top) leans back 4.2° and meets the ground 15 mm ahead of the contact patch
    // [derived]
    ffbMechanicalTrailM: 0.015,
    // The body's plan at barrier height, measured from vw-scirocco-gtx.glb (`scripts/measure-car-plans.ts`)
    bodyPlan: [[0.00, 2.07], [0.75, 2.00], [0.92, 0.52], [0.76, -1.88], [0.00, -1.95]],
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 400 Nm clutch; the auto clutch bites at 1100 rpm and closes by 1700 [spec CLUTCH, AUTOCLUTCH]
  clutch: { maxTorqueNm: 400, biteRpm: 1100, lockRpm: 1700 },
  // A mild limited-slip: 15 % lock under power, 10 % on the overrun, no preload [spec DIFFERENTIAL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.15, coast: 0.1, preload: 0, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // Discs, 1500 Nm at full pedal, 66 % front, no bias adjuster in the cockpit; a handbrake on the rears. The pads grip
  // at 90 % cold, fully from 250 to 800 °C and fade past it, to 70 % at 1000 °C [spec brakes.ini, HANDBRAKE_TORQUE,
  // PERF_CURVE]
  brakes: {
    maxTorqueNm: 1500,
    front_bias: 0.66,
    handbrakeTorqueNm: 1300,
    ebbStep: 0.01,
    brakeByWire: false,
    discMaterial: 'endurance-steel',
    padMuCurve: [
      [0, 0.9],
      [250, 1],
      [800, 1],
      [1000, 0.7],
      [15000, 0.2],
    ],
    migration: { amount: 0, rampStart: 0 },
  },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: { PhysicsTyreCompound_Road_Street: STREET_COMPOUND },
  compoundSlots: {
    soft: 'PhysicsTyreCompound_Road_Street',
    medium: 'PhysicsTyreCompound_Road_Street',
    hard: 'PhysicsTyreCompound_Road_Street',
    intermediate: 'PhysicsTyreCompound_Road_Street',
    wet: 'PhysicsTyreCompound_Road_Street',
  },
} satisfies CarPhysicsConfig;

/**
 * The car has no traction control or ABS (PRESENT=0), but the data sets both up: each at 12 % slip, the ABS cycling at
 * 250 Hz, the TC at 100 Hz and off under 40 km/h [spec electronics.ini]. They serve the assisted presets (and the
 * semi-pro ABS, which the AI brakes on); the other switch positions step 0.5 % either side, the lateral term is the
 * Liana's [est]
 */
export const VW_SCIROCCO_ELECTRONICS = {
  absLevels: [0.09, 0.095, 0.1, 0.105, 0.11, 0.115, 0.12, 0.125, 0.13, 0.135, 0.14, 0.145],
  absDefault: 0.12,
  absRateHz: 250,
  tcLevels: [0.09, 0.095, 0.1, 0.105, 0.11, 0.115, 0.12, 0.125, 0.13, 0.135, 0.14, 0.145],
  tcDefault: 0.12,
  tcRateHz: 100,
  tcMinSpeedKmh: 40,
  tcLateralTightening: { gain: 0.05, exponent: 1.3, floor: 0.6 },
};
