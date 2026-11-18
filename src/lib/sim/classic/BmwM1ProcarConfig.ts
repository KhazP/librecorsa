/**
 * BMW M1 Procar (1979, Group 4) vehicle data for `VehiclePhysics` (same data model as the f12026-car, see
 * `F12026CarConfig`): the one-make Procar series car, a mid-mounted 3.5 L straight six (the M88), a five-speed manual
 * and rear-wheel drive.
 *
 * The numbers come from Pfalzdriver's BMW M1 Procar for Assetto Corsa, mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics / setup); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * No turbo, hybrid or DRS, and no ABS or traction control (electronics.ini has both PRESENT=0). Double wishbones at
 * both ends with no heave springs, one set of slicks, and three aero elements: a front spoiler that works in ground
 * effect, the rear wing, and the body, which only drags.
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
} from '../f12026-car/F12026CarConfig';
import { deriveRainCompound } from '../f12026-car/F12026CarConfig';
import { modBodyHeightM, modCornerStops } from '../mod-suspension';

/** Driveline efficiency of this model; the wheel torque curve is divided by it for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/** Torque after the driveline (rpm → Nm) [spec power.lut]: 340 Nm at 6500 rpm, still 314 at 9250 */
const WHEEL_TORQUE: [number, number][] = [
  [0, 0],
  [500, 50],
  [1000, 90],
  [1500, 130],
  [2000, 160],
  [2250, 180],
  [2500, 200],
  [2750, 215],
  [3000, 230],
  [3500, 245],
  [3750, 255],
  [4000, 273],
  [4250, 289],
  [4500, 310],
  [5000, 325],
  [5500, 330],
  [6000, 335],
  [6500, 340],
  [7000, 335],
  [7500, 330],
  [8000, 325],
  [8500, 321],
  [9000, 318],
  [9250, 314],
];

/** Crank power (kW) at the curve's points [derived]: ≈ 330 kW (442 hp) at the 9200 rpm limiter, 303 kW at the wheels */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, Number((((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000).toFixed(3))]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque from nothing at idle, 120 Nm at 8900 rpm [spec COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [1100, 0],
    [8900, 120],
    [9250, 125.4],
  ] as LutPoints,
  // Pedal → throttle: near linear, a little short through the middle [spec throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [0.15, 0.15],
    [0.2, 0.2],
    [0.3, 0.3],
    [0.4, 0.45],
    [0.5, 0.5],
    [0.6, 0.6],
    [0.7, 0.75],
    [0.8, 0.82],
    [0.9, 0.9],
    [1, 1],
  ] as LutPoints,
  // Throttle slides and intake filling, as the GT3's [est]
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  // [spec MINIMUM]
  idleRpm: 1100,
  // Engine 0.175 + gearbox 0.020 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.195,
  // 35 Hz limiter: the cut lasts one cycle [spec LIMITER_HZ]
  limiterCutS: 1 / 35,
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
 * Five-speed manual on the 4.95 final drive, the middle of the five the setup offers (5.25 to 4.60) [spec
 * drivetrain.ini, final.rto]: ≈ 293 km/h in fifth at the 9200 rpm limiter, a little past the drag-limited top speed. An
 * up-shift is 260 ms between gears with the throttle cut for the same 260 ms [spec CHANGE_UP_TIME, AUTO_CUTOFF_TIME]
 */
const GEARBOX = {
  ratios: [2.42, 1.61, 1.14, 0.846, 0.704],
  reverse: 3.24,
  finalDrive: 4.95,
  shiftTimeS: 0.26,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.27,
  // As the R32's [est]; the box is between gears for the whole cut anyway
  shiftTorqueFraction: 0.1,
  upshiftNeutralS: 0.26,
  upshiftCutS: 0.26,
  // The cut is the driver's foot off the pedal: the engine slows on its overrun drag through the change
  upshiftCutLift: true,
  // Down: 270 ms between gears with the driver's 90 % heel-and-toe blip, risen in 10 ms; the clutch let out from 90 ms
  // and home at 180 [spec CHANGE_DN_TIME, DOWNSHIFT_PROFILE, AUTOBLIP (ELECTRONIC=0, LEVEL 0.9)]. The data has no down-shift protection, so the box takes a down-shift up
  // to the 9700 rpm where the engine starts to take damage [spec DAMAGE RPM_THRESHOLD]
  downshift: { neutralS: 0.27, clutchReleaseS: 0.09, clutchHomeS: 0.18, blip: { level: 0.9, riseS: 0.01 }, overRevRpm: 500 },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 9200,
    // [spec ai.ini GEARS UP]
    upshift_rpm: 9000,
    // The next gear down lands under 8000 rpm from here, still on 325 Nm [est: the data's ai.ini DOWN is 1000]
    downshift_rpm: 5500,
    // Into a braking zone the auto box clicks down while the lower gear lands under 8500 rpm: the engine makes its power
    // from 6500 rpm to the limiter [est]
    brake_downshift_rpm: 8500,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

const MASS = 1095;
const WHEELBASE = 2.53;
/** Share of the sprung weight on the front axle [spec CG_LOCATION]: the engine sits behind the driver */
const FRONT_WEIGHT = 0.465;
/** Hub masses [spec HUB_MASS] */
const FRONT_HUB_KG = 38;
const REAR_HUB_KG = 45;
/** Sprung load on a front / rear spring at static ride (N): the car less its hubs [derived] */
const SPRUNG_KG = MASS - 2 * FRONT_HUB_KG - 2 * REAR_HUB_KG;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * FRONT_WEIGHT) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * (1 - FRONT_WEIGHT)) / 2;
/**
 * The slicks' radial rate at the 33 / 35 psi they run at hot (N/m): RATE at the static pressure + PRESSURE_SPRING_GAIN
 * per psi [spec]
 */
const HOT_FRONT_TYRE_RATE = 369_050 + 3850 * (33 - 26);
const HOT_REAR_TYRE_RATE = 391_450 + 3850 * (35 - 28);
/**
 * The mod measures its stops from the suspension's design position, with the springs working on their rod lengths
 * (`mod-suspension.ts`): at static ride the springs hold the fronts 8 mm and the rears 32 mm short of it, so the stops
 * are these far from static [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN; derived]
 */
const FRONT_STOPS = modCornerStops({
  staticLoadN: FRONT_STATIC_LOAD_N,
  springRate: 56_000,
  rodLength: 0.046,
  packerRange: 0.1792,
  bumpStopUp: 0.1865,
  bumpStopDn: 0.0463,
});
const REAR_STOPS = modCornerStops({
  staticLoadN: REAR_STATIC_LOAD_N,
  springRate: 88_000,
  rodLength: 0.06,
  packerRange: 0.2171,
  bumpStopUp: 0.2373,
  bumpStopDn: 0.0474,
});
const mm = (m: number) => Number(m.toFixed(4));
/** No heave element: a spring that never engages */
const NO_HEAVE = { rate: 0, gap: 1, packerGap: 1, packerRate: 0 };

/**
 * Double wishbones front and rear: the mod's wheel rates, anti-roll bars, bump stops, packers and two-stage dampers
 * [spec suspensions.ini], the stops at their distance from static ride (above): the packers 141 mm (front) and 189 mm
 * (rear) up, the bump stops 195 / 270 mm up, so in practice the springs alone hold the car; the rears droop only 15 mm
 * before their stop. The front bar is five times the rear's (43.5 against 8.5 kN/m). Hardpoints are [x inboard, y up,
 * z forward] from the wheel centre [spec]; camber gain and roll-centre heights are what the kinematic solver gives on
 * them at static [derived]: the front arms stand level, so its camber barely moves in bump, while the rear's upper arm,
 * sloping down to the chassis, gains 31° of negative camber per metre.
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -1.6,
    camberGainKinematic: 1.3,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 56_000, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(FRONT_STOPS.packerGapM), rate: 180_000, progression: 0, hardStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 180_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.0317,
    // [spec ARB FRONT]
    arb: 43_500,
    hardpoints: [
      [0.41, 0.15, 0.22],
      [0.41, 0.15, 0],
      [0.52, -0.146, 0.34],
      [0.52, -0.146, -0.01],
      [0.185, 0.14, 0],
      [0.16, -0.16, 0.026],
      [0.454, -0.016, 0.14],
      [0.16, -0.03, 0.15],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -0.6,
    camberGainKinematic: -31.4,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 88_000, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(REAR_STOPS.packerGapM), rate: 80_000, progression: 0, hardStop: { range: mm(REAR_STOPS.bumpStopGapM), rate: 80_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: 0.083,
    // [spec ARB REAR]
    arb: 8500,
    hardpoints: [
      [0.47, 0.158, 0.24],
      [0.47, 0.158, 0],
      [0.53, -0.121, 0.24],
      [0.53, -0.121, 0],
      [0.23, 0.2, 0],
      [0.19, -0.123, -0.01],
      [0.53, -0.121, -0.1],
      [0.19, -0.123, -0.1],
    ],
  },
  dampers_controller: {
    front: {
      // [spec DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND, DAMP_FAST_*THRESHOLD]
      base: damper(3500, 2100, 4900, 2100),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.07,
      fastReboundThresholdMs: 0.11,
    },
    rear: {
      base: damper(3700, 2200, 5200, 2200),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.07,
      fastReboundThresholdMs: 0.11,
    },
  },
};

/** Tyre radius front and rear [spec tyres.ini RADIUS] */
const TYRE_RADIUS = 0.295;
/**
 * The body's height at each axle is the tyre's loaded radius less the wheel centre's height in the body frame (BASEY
 * −0.107 / −0.127 below the CG's level, plus the static offset): 0.404 m at the front, 0.447 m at the rear, so the CG,
 * 46.5 % of the weight forward, rides 0.427 m up [spec BASEY, RADIUS; derived]. The ride-height pickups sit 0.30 m
 * (front) and 0.345 m (rear) below the CG's level [spec car.ini RIDE]: 104 / 102 mm off the ground at rest.
 */
const FRONT_PICKUP_Y = -0.3;
const REAR_PICKUP_Y = -0.345;
const FRONT_BODY_HEIGHT = modBodyHeightM(TYRE_RADIUS, (FRONT_STATIC_LOAD_N + FRONT_HUB_KG * 9.81) / HOT_FRONT_TYRE_RATE, -0.107, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(TYRE_RADIUS, (REAR_STATIC_LOAD_N + REAR_HUB_KG * 9.81) / HOT_REAR_TYRE_RATE, -0.127, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * (1 - FRONT_WEIGHT)).toFixed(4));
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT + FRONT_PICKUP_Y).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT + REAR_PICKUP_Y).toFixed(4));

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
 * The body element: chord 1 × span 1.3 m, CD 0.33 at 0° (its table × CD_GAIN 1), no lift (CL_GAIN 0), no ground-height
 * tables [spec WING_0]: a constant 0.429 m² of drag (its table moves it under 3 % over ±2° of pitch)
 */
const BODY_CDA = Number((1 * 1.3 * 0.33).toFixed(4));

/**
 * Front spoiler and rear wing with the mod's angle-of-attack tables and the spoiler's ground-height tables [spec
 * aero.ini, CL_GAIN / CD_GAIN 1]; the body's drag as a constant. The spoiler's POSITION is level with the front pickup
 * (y −0.30 against RIDE −0.30), so its ground-height tables read the pickup's clearance as they stand: 0.98 of its lift
 * at the 104 mm it rides at. The yaw tables are the elements' YAW_CL_GAIN. At rest, CL·A ≈ 0.36 m² (0.18 spoiler at 3°,
 * 0.18 wing at 3°) for CD·A ≈ 0.52 m² (0.43 body, 0.09 wing, 0.01 spoiler); the spoiler 0.85 m ahead of the front axle
 * and the wing 0.82 m behind the rear one put ≈ half of it on each axle. Each drag acts at its element's height.
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: BODY_CDA,
  // The body's drag 0.15 m above the CG [spec WING_0 POSITION]
  dragCentreY: 0.15,
  wings: [
    {
      name: 'FRONT_WING',
      // [spec WING_1 CHORD × SPAN, POSITION, ANGLE; the setup has no steps for it]
      area: 1.904,
      positionZ: 2.2,
      angleDeg: 3,
      heightRef: 'front',
      lutAOA_CL: [
        [-10, -0.2],
        [-2, -0.06],
        [0, 0.08],
        [1, 0.085],
        [2, 0.09],
        [3, 0.094],
        [4, 0.09],
        [5, 0.09],
      ],
      lutAOA_CD: [
        [-10, 0],
        [-2, 0.0009],
        [0, 0],
        [1, 0.002],
        [2, 0.002],
        [3, 0.003],
        [4, 0.004],
        [5, 0.005],
        [6, 0.006],
      ],
      // [spec height_front_CL.lut, height_front_CD.lut]
      lutGH_CL_mult: [
        [0, 0],
        [0.01, 1.25],
        [0.035, 1.15],
        [0.075, 1.1],
        [0.09, 1.05],
        [0.1, 1],
        [0.11, 0.95],
        [0.12, 0.9],
        [0.13, 0.85],
      ],
      lutGH_CD_mult: [
        [0, 0.99],
        [0.01, 0.996],
        [0.052, 0.998],
        [0.065, 0.999],
        [0.0764, 1],
        [0.0884, 1.002],
        [0.09, 1.004],
      ],
      lutYaw_CL_mult: yawTable(-0.18),
      dragY: -0.3,
    },
    {
      name: 'REAR_WING',
      // [spec WING_2 CHORD × SPAN, POSITION, ANGLE 3; setup.ini WING_2 1–6°]
      area: 1.904,
      positionZ: -2,
      angleDeg: 3,
      heightRef: 'rear',
      lutAOA_CL: [
        [-10, -0.1],
        [-2, 0.06],
        [0, 0.068],
        [1, 0.072],
        [2, 0.08],
        [3, 0.095],
        [4, 0.1],
        [5, 0.098],
        [6, 0.098],
      ],
      lutAOA_CD: [
        [-10, 0],
        [-2, 0.0009],
        [0, 0],
        [1, 0.015],
        [2, 0.03],
        [3, 0.045],
        [4, 0.06],
        [5, 0.075],
        [6, 0.09],
        [7, 0.105],
      ],
      lutGH_CL_mult: FLAT,
      lutGH_CD_mult: FLAT,
      lutYaw_CL_mult: yawTable(-0.3),
      dragY: 0.85,
    },
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane level with the pickups [spec RIDE]
  floorOffsetY: 0.5 * (FRONT_PICKUP_Y + REAR_PICKUP_Y),
  // The body's ground colliders: their undersides 0.32 m below the CG, from the nose to the tail's [spec colliders.ini
  // COLLIDER_0–2]
  plank: { y: -0.32, frontZ: 2.33, rearZ: -1.75 },
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/**
 * Slicks 0.235 m wide at the front and 0.25 m at the rear, R 0.295 m on a 0.22 m rim radius; the radius grows 0.025 mm
 * per rad/s of spin, ≈ 6 mm at 250 km/h [spec tyres.ini WIDTH, RADIUS, RIM_RADIUS, RADIUS_ANGULAR_K]
 */
const FRONT_TYRE: TyreGeometry = { width: 0.235, radius: TYRE_RADIUS, rimRadius: 0.22, verticalRateScale: 1, radiusGrowthPerRadS: 2.5e-5 };
const REAR_TYRE: TyreGeometry = { width: 0.25, radius: TYRE_RADIUS, rimRadius: 0.22, verticalRateScale: 1, radiusGrowthPerRadS: 2.5e-5 };

/** Slip ratio at the peak of the drive force: tan(FRICTION_LIMIT_ANGLE) / CX_MULT of theoretical slip [derived] */
const peakSlipRatio = (frictionLimitDeg: number) => {
  const theoretical = Math.tan((frictionLimitDeg * Math.PI) / 180) / 1.05;
  return Number((theoretical / (1 - theoretical)).toFixed(4));
};

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the static pressure + 3850 N/m per psi [spec] */
const pressureSpring = (rate: number, staticPsi: number): LutPoints =>
  [16, 20, 24, 26, 28, 33, 35, 40, 44].map((p) => [p, Math.round(rate + 3850 * (p - staticPsi))]);

/**
 * The "Vintage Slicks", the data's one compound [spec tyres.ini FRONT / REAR]. Its tyre data is the newer kind: peak μ
 * at a reference load (DY_REF / DX_REF at FZ0) falling with load by a power law (LS_EXPY / LS_EXPX); the file's DY0 /
 * DY1 and FLEX entries belong to the older kind and are not read. At the static loads that is μ ≈ 1.48 on the fronts
 * and 1.51 on the rears.
 */
const SLICK: TyresCompoundData = {
  name: 'Vintage Slicks',
  shortName: 'M',
  tyre_compound: 'PhysicsTyreCompound_GT3_Medium',
  // Sliding under load wears in proportion, counted per 2000 N of it [spec VIRTUALKM USE_LOAD, WEAR_CURVE
  // semislicks_front.lut; the rear's is the same]
  wear: {
    curve: [
      [0, 100],
      [0.25, 100],
      [0.5, 100],
      [0.75, 100],
      [1.25, 99.5],
      [2.5, 99],
      [3.75, 98.5],
      [10, 98],
      [25, 80],
      [27.5, 70],
    ],
    loadScaled: true,
    loadRefN: 2000,
  },
  front: FRONT_TYRE,
  rear: REAR_TYRE,
  modelData: {
    // [spec DY_REF, DX_REF at FZ0; LS_EXPY, LS_EXPX]
    Dy0: 1.42,
    Dx0: 1.46,
    lsExpY: 0.7785,
    lsExpX: 0.7925,
    Fz0: 2962,
    // A brush tyre, on the mod's own shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with load
    // (6.0 % per FZ0) and with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the longitudinal stiffness [spec
    // CX_MULT] and the grip lost to sliding speed [spec SPEED_SENSITIVITY]. No COMBINED_FACTOR in the data: the friction
    // circle. The fuller rising branch [spec XMU], as the Nissans'
    curve: 'brush',
    curveFullness: 0.27,
    friction_limit_angle: 7.8,
    peakSlipLoadGain: 0.0596,
    peakSlipPressureGain: 0.5,
    combinedExponent: 2,
    longStiffnessMult: 1.05,
    speedSensitivity: 0.00396,
    // Unused by a brush tyre (the magic-formula family's stiffness law)
    pKy2: 4.2,
    slip_ratio_limit: peakSlipRatio(7.8),
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    // [spec FALLOFF_LEVEL, FALLOFF_SPEED]: a gentle slope past the peak, to 94 %
    use_slip_falloff: true,
    falloff_level: 0.94,
    falloff_slope: 1,
    // [spec RELAXATION_LENGTH]
    relaxationLengthX: 0.09982,
    relaxationLengthY: 0.09982,
    // 12 N + 0.0005 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
    rollingResistance: 0.012,
    rollingResistanceSpeedSq: 5e-7,
    // Scrub at the peak slip, and no more past it [spec ROLLING_RESISTANCE_SLIP]
    rollingResistanceSlipGain: 5.323,
    rollingResistanceSlipMax: 1,
    // [spec DAMP]
    verticalDamping: 500,
    // [spec BRAKE_DX_MOD]
    brakeDxMod: 0.06,
  },
  thermalData: {
    // Grip against tread temperature (°C) [spec tcurve_semis.lut]: full from 75 to 95 °C, 94 % cold
    thermalPerformanceCurve: [
      [0, 0.94],
      [20, 0.95],
      [40, 0.95],
      [60, 0.99],
      [75, 1],
      [85, 1],
      [95, 1],
      [105, 0.98],
      [140, 0.96],
      [160, 0.88],
      [200, 0.82],
    ],
    optimalTempC: [75, 95],
    // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]; the graining wears off as the tread slides
    tread: { grainGain: 0.4, grainGamma: 1, blisterGain: 0.3, blisterGamma: 1, wearOffWithSlip: true },
    // Pressure moves the heat: the sliding heat and the crown against the shoulders [ref], the rolling heat by
    // PRESSURE_RR_GAIN [spec]
    pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
    // The GT3 slick's cooling, as the Nissans' [est]: the data's own thermal constants are for AC's
    // tyre model, not this one. Half the GT3 slick's heat capacities and its rolling hysteresis [est]: on the GT3's
    // capacities and the M1's old 0.0044 a tyre from the pit lane's 20 °C gained 4–5 °C a lap and sat at 48–54 °C after
    // four (its data's pressures stopping 3–5 psi short of PRESSURE_IDEAL); on these it reaches 56–64 °C by the third
    // lap, the pressures at the ideal as the data has them
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
    optimalPsi: 33,
    // [spec PRESSURE_STATIC], set cold: it reaches the ideal near 70 °C, at the bottom of the grip window
    setPsi: 26,
    pressureSpringCurve: pressureSpring(369_050, 26),
    // [spec PRESSURE_RR_GAIN]
    pressureRollingGain: 0.55,
    pressureGripSensitivity: 1.0,
    // 0.4 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
    pressureGripLossPerPsi: 0.004,
    // No blankets in 1979: set in the pit lane at 20 °C [est]
    coldRefC: 20,
  },
  camberData: {
    // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]: the parabola peaks at 4.5° of camber leaning in, × 1.043
    camberGain: 0.176,
    contact_camber_c1: 1,
    contact_camber_c2: 40,
    dcamber0: 1.1,
    dcamber1: -7,
    dcamber0_x: 0,
    dcamber1_x: -6,
  },
  // The wider rear: its own reference load and grip, load sensitivity, peak slip angle and its growth, sliding loss,
  // rolling resistance, camber thrust and pressures [spec REAR]
  rearOverride: {
    modelData: {
      Fz0: 4749,
      Dy0: 1.37,
      Dx0: 1.41,
      lsExpY: 0.8076,
      lsExpX: 0.8557,
      friction_limit_angle: 6.7,
      peakSlipLoadGain: 0.0575,
      slip_ratio_limit: peakSlipRatio(6.7),
      speedSensitivity: 0.004268,
      rollingResistanceSpeedSq: 5.08e-7,
      rollingResistanceSlipGain: 5.613,
    },
    camberData: { camberGain: 0.196 },
    pressureData: { optimalPsi: 35, setPsi: 28, pressureSpringCurve: pressureSpring(391_450, 28) },
  },
};

/**
 * The slicks plus rain tyres on their carcass, as the Nissans' [est]: the mod has slicks only. One dry compound fills
 * the soft, medium and hard slots
 */
const TYRES = {
  PhysicsTyreCompound_GT3_Medium: SLICK,
  PhysicsTyreCompound_GT3_Intermediate: deriveRainCompound(SLICK, 'intermediate', 'PhysicsTyreCompound_GT3_Intermediate', 'Intermediate'),
  PhysicsTyreCompound_GT3_Wet: deriveRainCompound(SLICK, 'wet', 'PhysicsTyreCompound_GT3_Wet', 'Wet'),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Equivalent box 1.85 × 1.0 × 4.25 m [spec car.ini INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const BMW_M1_PROCAR_CONFIG = {
  screenName: 'BMW M1 Procar',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: FRONT_WEIGHT,
    // [spec WHEELBASE, TRACK]. The data's tracks are 18 / 22 cm wider than the body's wheels stand (1.641 / 1.605 m in
    // bmw-m1-procar.glb: the mod draws its wheels inboard of where its physics puts them), so the contact patches sit
    // ≈ 9 cm outboard of the drawn tyres; the handling is the data's
    wheelbase: WHEELBASE,
    trackWidthFront: 1.825,
    trackWidthRear: 1.829,
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(1.0, 4.25), roll: box(1.85, 1.0), yaw: box(1.85, 4.25) },
    // [spec HUB_MASS]
    unsprungMassFront: FRONT_HUB_KG,
    unsprungMassRear: REAR_HUB_KG,
    // The tank sits 0.70 m behind the CG and 0.15 m below it [spec FUELTANK POSITION]
    fuelTank: { y: -0.15, z: -0.7 },
    // [spec tyres.ini ANGULAR_INERTIA]
    wheelInertiaFront: 1.71,
    wheelInertiaRear: 2.28,
    // 360° of rim lock each way on a 16:1 rack [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 360 / 16,
    // The kingpin (WBTYRE_BOTTOM → WBTYRE_TOP) leans back 4.9° and meets the ground 37 mm ahead of the contact patch [derived]
    ffbMechanicalTrailM: 0.037,
    // The body's plan at barrier height, measured from bmw-m1-procar.glb (`scripts/measure-car-plans.ts`)
    bodyPlan: [[0.00, 2.24], [0.77, 2.16], [0.95, 1.55], [0.98, 1.03], [0.97, -1.42], [0.83, -2.00], [0.00, -2.11]],
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 550 Nm clutch; the auto clutch bites at 1100 rpm and closes by 1500 [spec CLUTCH, AUTOCLUTCH]
  clutch: { maxTorqueNm: 550, biteRpm: 1100, lockRpm: 1500 },
  // Locking torque = preload + POWER / COAST × input torque [spec DIFFERENTIAL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.6, coast: 0.45, preload: 10, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // 2700 Nm at full pedal, 66 % front, bias adjustable in 1 % steps, a 600 Nm handbrake; the pads' grip is 85 % cold,
  // full from 300 to 600 °C and 90 % at 900 (the same curve front and rear) [spec brakes.ini]
  brakes: {
    maxTorqueNm: 2700,
    front_bias: 0.66,
    handbrakeTorqueNm: 600,
    ebbStep: 0.01,
    brakeByWire: false,
    discMaterial: 'endurance-steel',
    padMuCurve: [
      [0, 0.85],
      [100, 0.96],
      [200, 0.98],
      [300, 1],
      [600, 1],
      [700, 0.98],
      [900, 0.9],
    ],
    migration: { amount: 0, rampStart: 0 },
  },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: TYRES,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_GT3_Medium',
    medium: 'PhysicsTyreCompound_GT3_Medium',
    hard: 'PhysicsTyreCompound_GT3_Medium',
    intermediate: 'PhysicsTyreCompound_GT3_Intermediate',
    wet: 'PhysicsTyreCompound_GT3_Wet',
  },
} satisfies CarPhysicsConfig;

/**
 * The car has no traction control or ABS (PRESENT=0), but the data sets both up: TC at 10 % wheelspin cycling at
 * 370 Hz, off under 50 km/h, its switch positions 10–14 % [spec electronics.ini, traction_control.lut]; ABS at 12 %
 * cycling at 150 Hz. They serve the assisted presets (and the semi-pro ABS, which the AI brakes on); the ABS's other
 * positions step 0.5 % either side, the TC's 1 % below the data's five [est]. The lateral and rear slide terms are the
 * Nissans' [est]
 */
export const BMW_M1_PROCAR_ELECTRONICS = {
  absLevels: [0.09, 0.095, 0.1, 0.105, 0.11, 0.115, 0.12, 0.125, 0.13, 0.135, 0.14, 0.145],
  absDefault: 0.12,
  absRateHz: 150,
  tcLevels: [0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15],
  tcDefault: 0.1,
  tcRateHz: 370,
  tcMinSpeedKmh: 50,
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
