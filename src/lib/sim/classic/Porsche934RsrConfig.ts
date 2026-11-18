/**
 * Porsche 934 Turbo RSR (1976, Group 4) vehicle data for `VehiclePhysics` (same data model as the f12026-car, see
 * `F12026CarConfig`): the racing 911 Turbo, a 3.0 L flat six behind the rear axle with one big turbo, a four-speed box
 * and rear-wheel drive.
 *
 * The numbers come from Pfalzdriver's Porsche 934 Turbo RSR for Assetto Corsa, mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics / setup); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * One turbo with a lot of lag and no hybrid or DRS; no ABS or traction control (electronics.ini has both PRESENT=0).
 * MacPherson struts at the front, wishbones at the rear, two sets of tyres (the newer "Slicks", the data's default,
 * and the original Group 4 tyres), and three aero elements: the front spoiler, which works in ground effect, the rear
 * wing and the body, which only drags. 60 % of the weight sits on the rear wheels.
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
  TurboData,
  TyreGeometry,
  TyresCompoundData,
} from '../f12026-car/F12026CarConfig';
import { deriveRainCompound, turboSteadyBoost } from '../f12026-car/F12026CarConfig';
import { modBodyHeightM, modCornerStops } from '../mod-suspension';

/** Driveline efficiency of this model; the wheel torque curve is divided by it for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/** The data's turbo lag closes this share of the gap per step, 444 steps a second [derived] */
const lagSeconds = (lag: number) => Number((1 / ((1 - lag) * 444)).toFixed(4));

/**
 * One turbo [spec TURBO_0]: it asks for MAX_BOOST 1.41 × (throttle × rpm / 4950)^2.8, held to its WASTEGATE 1.41, and
 * the torque is × (1 + boost). Full boost comes at 4950 rpm with the throttle wide open; at 3500 rpm it is a third of
 * it, and half throttle at 6000 rpm makes 0.35 of the 1.41. LAG_UP 0.997 / LAG_DN 0.991: a 0.75 s spool-up and a
 * 0.25 s run-down [derived]. This model spools faster with the exhaust flow, so the 0.75 s is set at REFERENCE_RPM
 * [est]: 1.1 s at 3500 rpm, 0.6 s at 6000. The boost controller (ctrl_turbo0.ini) holds the wastegate to 0.6 at 1000
 * rpm, 1.2 at 2000 and 2.0 from 3500: above what the turbo makes at every rpm, so it never limits it [derived].
 * DISPLAY_MAX_BOOST 1.40 on the gauge [spec]
 */
const TURBO: TurboData = {
  maxBoost: 1.41,
  referenceRpm: 4950,
  gamma: 2.8,
  spoolUpS: lagSeconds(0.997),
  spoolRefRpm: 4950,
  spoolDownS: lagSeconds(0.991),
  displayMaxBoostBar: 1.4,
  throttleInBoostLaw: true,
};

/** Wheel torque before the turbo (rpm → Nm) [spec power.lut]: 210 Nm at 6000 rpm, 506 Nm there with the boost */
const WHEEL_TORQUE: [number, number][] = [
  [0, 58],
  [500, 58],
  [1000, 96],
  [1500, 137],
  [2000, 162],
  [2500, 180],
  [3000, 189],
  [3500, 191],
  [4000, 197],
  [4500, 203],
  [5000, 206],
  [5500, 209],
  [6000, 210],
  [6500, 209],
  [7000, 206],
  [7500, 180],
  [8000, 137],
  [8400, 92],
];

/** Points added between the table's, so the curve follows the boost's power law where it rises (rpm) [derived] */
const BOOST_RPMS = [2750, 3250, 3750, 4250, 4750, 4950];
const lerpTorque = (rpm: number) => {
  const i = WHEEL_TORQUE.findIndex(([r]) => r >= rpm);
  const [r0, t0] = WHEEL_TORQUE[i - 1];
  const [r1, t1] = WHEEL_TORQUE[i];
  return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
};
const CURVE_POINTS: [number, number][] = [...WHEEL_TORQUE, ...BOOST_RPMS.map((rpm) => [rpm, lerpTorque(rpm)] as [number, number])].sort(
  (a, b) => a[0] - b[0]
);

/**
 * Crank power (kW) at full throttle with the boost the turbo makes there in steady state, as this model's curve is (the
 * lag, and at part throttle the smaller boost, act on it at run time): ≈ 395 kW (530 hp) at 7000 rpm, ≈ 364 kW of it at
 * the wheels [derived]
 */
const POWER_CURVE: LutPoints = CURVE_POINTS.map(([rpm, nm]) => [
  rpm,
  Number((((nm * (1 + turboSteadyBoost(TURBO, rpm))) / DRIVELINE_EFFICIENCY) * rpm * Math.PI / 30 / 1000).toFixed(3)),
]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque from nothing at idle, 120 Nm at 6000 rpm [spec COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [900, 0],
    [6000, 120],
    [8400, 176.471],
  ] as LutPoints,
  // Pedal → throttle: a quick first tenth, linear from half way [spec throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [0.1, 0.2],
    [0.2, 0.28],
    [0.3, 0.36],
    [0.4, 0.45],
    [0.5, 0.5],
    [0.6, 0.6],
    [0.7, 0.7],
    [0.8, 0.8],
    [0.9, 0.9],
    [1, 1],
  ] as LutPoints,
  // Throttle slides and intake filling, as the GT3's [est]; the turbo's lag comes on top
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  turbo: TURBO,
  // [spec MINIMUM]
  idleRpm: 900,
  // Engine 0.110 + gearbox 0.0182 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.1282,
  // 20 Hz limiter: the cut lasts one cycle [spec LIMITER_HZ]
  limiterCutS: 1 / 20,
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
 * Four-speed manual on a 4.222 final drive, the setup has no other ratios [spec drivetrain.ini]: ≈ 317 km/h in fourth
 * at the 8400 rpm limiter, past where power and drag stop it (≈ 305 km/h). The gaps are wide (1.52, 1.35, 1.22), so
 * each up-shift drops the revs to where the boost has to build again. An up-shift is 250 ms between gears with the
 * throttle cut for the same 250 ms [spec CHANGE_UP_TIME, AUTO_CUTOFF_TIME]
 */
const GEARBOX = {
  ratios: [1.833, 1.208, 0.893, 0.733],
  reverse: 2.4375,
  finalDrive: 4.222,
  shiftTimeS: 0.25,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.27,
  // As the R32's [est]; the box is between gears for the whole cut anyway
  shiftTorqueFraction: 0.1,
  upshiftNeutralS: 0.25,
  upshiftCutS: 0.25,
  // The cut is the driver's foot off the pedal: the engine slows on its overrun drag through the change, and the turbo
  // runs down with it
  upshiftCutLift: true,
  // Down: 270 ms between gears with the driver's 70 % heel-and-toe blip, risen in 20 ms; the clutch let out from 280 ms
  // and home at 700 [spec CHANGE_DN_TIME, DOWNSHIFT_PROFILE, AUTOBLIP (ELECTRONIC=0, LEVEL 0.7)]. The data has no
  // down-shift protection, so the box takes a down-shift up to the 8450 rpm where the engine starts to take damage
  // [spec DAMAGE RPM_THRESHOLD]
  downshift: { neutralS: 0.27, clutchReleaseS: 0.28, clutchHomeS: 0.7, blip: { level: 0.7, riseS: 0.02 }, overRevRpm: 50 },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 8400,
    // [spec ai.ini GEARS UP]
    upshift_rpm: 7200,
    // [spec ai.ini GEARS DOWN]
    downshift_rpm: 4200,
    // Into a braking zone the auto box clicks down while the lower gear lands under 7600 rpm: the boosted engine makes
    // its power from 5000 rpm to there [est]
    brake_downshift_rpm: 7600,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

const MASS = 1165;
const WHEELBASE = 2.296;
/** Share of the sprung weight on the front axle [spec CG_LOCATION]: the engine hangs behind the rear axle */
const FRONT_WEIGHT = 0.4;
/** Hub masses [spec HUB_MASS] */
const FRONT_HUB_KG = 45;
const REAR_HUB_KG = 58;
/** Sprung load on a front / rear spring at static ride (N): the car less its hubs [derived] */
const SPRUNG_KG = MASS - 2 * FRONT_HUB_KG - 2 * REAR_HUB_KG;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * FRONT_WEIGHT) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * (1 - FRONT_WEIGHT)) / 2;
/**
 * The first tyres' radial rate at the 28 / 35 psi they run at hot (N/m): RATE at the static pressure +
 * PRESSURE_SPRING_GAIN per psi [spec tyres.ini FRONT / REAR]
 */
const HOT_FRONT_TYRE_RATE = 208_000 + 9000 * (28 - 22);
const HOT_REAR_TYRE_RATE = 260_000 + 15_000 * (35 - 26);
/**
 * The mod measures its stops from the suspension's design position, with the springs working on their rod lengths
 * (`mod-suspension.ts`): at static ride the fronts hang 18 mm below it and the rears sit 29 mm into it, so the stops
 * are these far from static [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN; derived]
 */
const FRONT_STOPS = modCornerStops({
  staticLoadN: FRONT_STATIC_LOAD_N,
  springRate: 70_000,
  rodLength: 0.045,
  packerRange: 0.2188,
  bumpStopUp: 0.0195,
  bumpStopDn: 0.0378,
});
const REAR_STOPS = modCornerStops({
  staticLoadN: REAR_STATIC_LOAD_N,
  springRate: 58_000,
  rodLength: 0.02,
  packerRange: 0.1835,
  bumpStopUp: 0.2017,
  bumpStopDn: 0.083,
});
const mm = (m: number) => Number(m.toFixed(4));
/** No heave element: a spring that never engages */
const NO_HEAVE = { rate: 0, gap: 1, packerGap: 1, packerRate: 0 };

/**
 * The strut's axis, top mount to its foot on the upright, from the wheel centre [spec STRUT_CAR, STRUT_TYRE]; the
 * upright's lower ball joint is the strut's foot (WBTYRE_BOTTOM is the same point)
 */
const STRUT_CAR: [number, number, number] = [0.17, 0.385, -0.02631];
const STRUT_TYRE: [number, number, number] = [0.052, -0.14, 0.015];
const strutDx = STRUT_CAR[0] - STRUT_TYRE[0];
const strutDy = STRUT_CAR[1] - STRUT_TYRE[1];
const strutLen = Math.hypot(strutDx, strutDy);
/** The virtual upper arm's inboard end, 1 m from the top mount square to the strut, 150 mm either side of it [derived] */
const VIRTUAL_ARM: [number, number] = [
  Number((STRUT_CAR[0] + strutDy / strutLen).toFixed(4)),
  Number((STRUT_CAR[1] - strutDx / strutLen).toFixed(4)),
];

/**
 * MacPherson struts at the front, double wishbones at the rear: the mod's wheel rates, anti-roll bars, bump stops,
 * packers and two-stage dampers [spec suspensions.ini], the stops at their distance from static ride (above). The
 * fronts reach the strut's own stop (500 kN/m, as a strut's is) after 38 mm of bump and droop only 20 mm before their
 * stop; the packers are 192 mm up. The rears' packers are 135 mm up, their bump stops 173 mm, their droop stops 112 mm
 * down. The front bar is twice the rear's (28 against 13.5 kN/m). Hardpoints are [x inboard, y up, z forward] from the
 * wheel centre [spec]; the strut is solved as a wishbone with a virtual upper arm square to it. Camber gain and
 * roll-centre heights are what the kinematic solver gives on them at static [derived]: both ends gain 20–23° of
 * negative camber per metre of bump, roll centres 44 mm up.
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_Strut',
    actuation: 'push_rod',
    // A strut: no rocker, the spring's leverage stays put [est]
    rockerProgressivityPerM: 0,
    // [spec STATIC_CAMBER]
    staticCamber: -1.9,
    camberGainKinematic: -23,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 70_000, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // The strut's rigid stop first, then the packer at BUMP_STOP_RATE [spec BUMPSTOP_UP, PACKER_RANGE, BUMP_STOP_RATE]
    bumpStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 500_000, progression: 0, hardStop: { range: mm(FRONT_STOPS.packerGapM), rate: 100_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.0443,
    // [spec ARB FRONT]
    arb: 28_000,
    hardpoints: [
      [VIRTUAL_ARM[0], VIRTUAL_ARM[1], Number((STRUT_CAR[2] + 0.15).toFixed(4))],
      [VIRTUAL_ARM[0], VIRTUAL_ARM[1], Number((STRUT_CAR[2] - 0.15).toFixed(4))],
      [0.295, -0.138, 0.34],
      [0.33, -0.14, -0.02],
      STRUT_CAR,
      STRUT_TYRE,
      [0.378, -0.09, 0.06],
      [0.04, -0.0865, 0.15],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // Coilovers on the wishbones, no rocker: the leverage grows a little as the arm comes level [est]
    rockerProgressivityPerM: 0.3,
    // [spec STATIC_CAMBER]
    staticCamber: -2,
    camberGainKinematic: -19.6,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 58_000, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(REAR_STOPS.packerGapM), rate: 120_000, progression: 0, hardStop: { range: mm(REAR_STOPS.bumpStopGapM), rate: 120_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: 0.0438,
    // [spec ARB REAR]
    arb: 13_500,
    hardpoints: [
      [0.32221, 0.11247, 0.12655],
      [0.32221, 0.10666, -0.20708],
      [0.41891, -0.13113, 0.46344],
      [0.41891, -0.14976, -0.05175],
      [0.09378, 0.13098, -0.01905],
      [0.06939, -0.14921, 0.01624],
      [0.39276, -0.07859, -0.17501],
      [0.08213, -0.0688, -0.13076],
    ],
  },
  dampers_controller: {
    front: {
      // [spec DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND, DAMP_FAST_*THRESHOLD]
      base: damper(4273, 1934, 8875, 7601),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.06,
      fastReboundThresholdMs: 0.12,
    },
    rear: {
      base: damper(3273, 1934, 8873, 3601),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.06,
      fastReboundThresholdMs: 0.12,
    },
  },
};

/** Tyre radius [spec tyres.ini RADIUS] */
const FRONT_RADIUS = 0.299;
const REAR_RADIUS = 0.31;
/**
 * The body's height at each axle is the tyre's loaded radius less the wheel centre's height in the body frame (BASEY
 * −0.090 / −0.187 below the CG's level, plus the static offset): 0.398 m at the front, 0.460 m at the rear, so the CG,
 * 40 % of the weight forward, rides 0.435 m up [spec BASEY, RADIUS; derived]. The ride-height pickups sit 0.31 m
 * (front) and 0.32 m (rear) below the CG's level [spec car.ini RIDE]: 88 / 140 mm off the ground at rest, a 52 mm rake.
 */
const FRONT_PICKUP_Y = -0.31;
const REAR_PICKUP_Y = -0.32;
const FRONT_BODY_HEIGHT = modBodyHeightM(FRONT_RADIUS, (FRONT_STATIC_LOAD_N + FRONT_HUB_KG * 9.81) / HOT_FRONT_TYRE_RATE, -0.09, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(REAR_RADIUS, (REAR_STATIC_LOAD_N + REAR_HUB_KG * 9.81) / HOT_REAR_TYRE_RATE, -0.187, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * (1 - FRONT_WEIGHT)).toFixed(4));
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT + FRONT_PICKUP_Y).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT + REAR_PICKUP_Y).toFixed(4));

/** The data gives no yaw gains: the elements' lift doesn't change as the car slides [spec] */
const FLAT: LutPoints = [
  [0, 1],
  [30, 1],
];

/**
 * The body element: chord 1 × span 1.75 m, CD 0.39 at 0° (its table × CD_GAIN 1), no lift (CL_GAIN 0), no ground-height
 * tables [spec WING_0]: a constant 0.683 m² of drag (its table moves it under 2 % over ±5° of pitch)
 */
const BODY_CDA = Number((1 * 1.75 * 0.39).toFixed(4));

/** The front spoiler's height above the front ride-height pickup (m) [spec WING_1 POSITION, car.ini RIDE] */
const SPOILER_ABOVE_PICKUP = 0.05;

/**
 * Front spoiler and rear wing with the mod's angle-of-attack tables × their CL_GAIN 0.2 and the spoiler's ground-height
 * tables [spec aero.ini]; neither has drag of its own (CD_GAIN 0), so the body's is all of it. The spoiler sits 50 mm
 * above the front pickup, so its ground-height tables are moved by that to read the pickup's clearance: at the 88 mm
 * the pickup rides at, the spoiler is 138 mm up and makes 0.85 of its lift. At rest, CL·A ≈ 0.16 m² (0.07 spoiler, 0.09
 * wing) for CD·A 0.68 m²: the spoiler 0.6 m ahead of the front axle and the wing 0.8 m behind the rear one, so the
 * downforce is near even between the axles on a car that carries 60 % of its weight at the back. Each acts at its
 * element's height.
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: BODY_CDA,
  // The body's drag 0.18 m above the CG [spec WING_0 POSITION]
  dragCentreY: 0.18,
  wings: [
    {
      name: 'FRONT_WING',
      // [spec WING_1 CHORD × SPAN, POSITION, ANGLE; the setup has no steps for it]
      area: 1.9,
      positionZ: 1.9,
      angleDeg: 0,
      heightRef: 'front',
      // [spec wing_front_AOA_CL.lut × CL_GAIN 0.2]
      lutAOA_CL: [
        [-10, -0.08],
        [0, 0.045],
        [1, 0.049],
        [2, 0.053],
        [3, 0.057],
        [4, 0.061],
      ],
      // [spec CD_GAIN 0]
      lutAOA_CD: [
        [-10, 0],
        [30, 0],
      ],
      // [spec height_frontwing_CL.lut, height_frontwing_CD.lut], read at the spoiler's own height
      lutGH_CL_mult: [
        [0 - SPOILER_ABOVE_PICKUP, 0],
        [0.01 - SPOILER_ABOVE_PICKUP, 1.08],
        [0.04 - SPOILER_ABOVE_PICKUP, 1.05],
        [0.05 - SPOILER_ABOVE_PICKUP, 1.04],
        [0.06 - SPOILER_ABOVE_PICKUP, 1.03],
        [0.07 - SPOILER_ABOVE_PICKUP, 1.02],
        [0.08 - SPOILER_ABOVE_PICKUP, 1.01],
        [0.09 - SPOILER_ABOVE_PICKUP, 0.98],
        [0.12 - SPOILER_ABOVE_PICKUP, 0.85],
      ],
      lutGH_CD_mult: [
        [0 - SPOILER_ABOVE_PICKUP, 0.97],
        [0.005 - SPOILER_ABOVE_PICKUP, 0.99],
        [0.01 - SPOILER_ABOVE_PICKUP, 0.994],
        [0.02 - SPOILER_ABOVE_PICKUP, 0.998],
        [0.03 - SPOILER_ABOVE_PICKUP, 1],
        [0.04 - SPOILER_ABOVE_PICKUP, 1.002],
        [0.05 - SPOILER_ABOVE_PICKUP, 1.004],
        [0.06 - SPOILER_ABOVE_PICKUP, 1.006],
      ],
      lutYaw_CL_mult: FLAT,
      dragY: -0.26,
    },
    {
      name: 'REAR_WING',
      // [spec WING_2 CHORD × SPAN, POSITION, ANGLE 0; the setup has no steps for it]
      area: 0.996,
      positionZ: -1.79482,
      angleDeg: 0,
      heightRef: 'rear',
      // [spec wing_rear_AOA_CL.lut × CL_GAIN 0.2]
      lutAOA_CL: [
        [-10, -0.08],
        [0, 0.0884],
        [1, 0.0952],
        [2, 0.1024],
        [3, 0.1134],
        [4, 0.1164],
        [5, 0.1034],
        [6, 0.1304],
        [7, 0.1374],
        [8, 0.1444],
        [9, 0.1514],
        [10, 0.1594],
      ],
      // [spec CD_GAIN 0]
      lutAOA_CD: [
        [-10, 0],
        [30, 0],
      ],
      lutGH_CL_mult: [
        [0, 1],
        [0.3, 1],
      ],
      lutGH_CD_mult: [
        [0, 1],
        [0.3, 1],
      ],
      lutYaw_CL_mult: FLAT,
      dragY: 0.4336,
    },
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane level with the pickups [spec RIDE]
  floorOffsetY: 0.5 * (FRONT_PICKUP_Y + REAR_PICKUP_Y),
  // The body's ground colliders: the nose's underside 0.28 m below the CG, from the nose to the tail's [spec colliders.ini
  // COLLIDER_0–2]
  plank: { y: -0.28, frontZ: 2.08, rearZ: -1.775 },
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/**
 * 0.275 m wide at the front, 0.38 m at the rear, R 0.299 / 0.31 m on a 0.24 m rim radius [spec tyres.ini WIDTH, RADIUS,
 * RIM_RADIUS]; the slicks' radius grows 0.04 mm per rad/s of spin, ≈ 9 mm at 250 km/h, the Group 4 tyres' 0.015 mm
 * [spec RADIUS_ANGULAR_K]
 */
const geometry = (width: number, radius: number, growth: number): TyreGeometry => ({
  width,
  radius,
  rimRadius: 0.24,
  verticalRateScale: 1,
  radiusGrowthPerRadS: growth,
});

/** Slip ratio at the peak of the drive force: tan(FRICTION_LIMIT_ANGLE) / CX_MULT 1 of theoretical slip [derived] */
const peakSlipRatio = (frictionLimitDeg: number) => {
  const theoretical = Math.tan((frictionLimitDeg * Math.PI) / 180);
  return Number((theoretical / (1 - theoretical)).toFixed(4));
};

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the static pressure + PRESSURE_SPRING_GAIN per psi [spec] */
const pressureSpring = (rate: number, perPsi: number, staticPsi: number): LutPoints =>
  [14, 18, 22, 24, 26, 28, 32, 35, 40, 45].map((p) => [p, Math.round(rate + perPsi * (p - staticPsi))]);

/**
 * Lateral grip against camber, both sets [spec tire_ccurve_bias_1-5deg.lut, DCAMBER_LUT]: a bias-ply's, best at 1.5° of
 * camber leaning into the corner (× 1.055) and falling away either side; it takes the place of the DCAMBER_0 / _1
 * parabola, which the compounds also list
 */
const BIAS_CAMBER: LutPoints = [
  [-90, 0.7],
  [-30, 0.84],
  [-20, 0.87],
  [-10, 0.92],
  [-6, 0.96],
  [-3, 1.02],
  [-2, 1.05],
  [-1.5, 1.055],
  [-1, 1.0525],
  [-0.5, 1.04],
  [0, 1],
  [2.5, 0.94],
  [5, 0.9],
  [10, 0.855],
  [20, 0.8],
  [30, 0.76],
  [90, 0.6],
];

/**
 * What the two sets share: the M1's heat capacities, hysteresis and cooling [est]. From the pit lane's 20 °C the slicks
 * reach 60–70 °C by the third lap (88–97 % of their grip, the data's curve full at 80 °C) and their pressures come up to
 * the ideal; on the GT3's capacities and the M1's old 0.0044 they sat at 53–63 °C (82–94 %) and lapped 0.7 s slower
 */
const THERMAL_COMMON = {
  // Pressure moves the heat: the sliding heat and the crown against the shoulders [ref], the rolling heat by
  // PRESSURE_RR_GAIN [spec]
  pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
  // The data's own thermal constants are for AC's tyre model, not this one
  surfaceHeatCapacity: 900,
  coreHeatCapacity: 5500,
  slipHeatShare: 0.35,
  hysteresis: 0.0084,
  surfaceToCore: 40,
  surfaceCooling: [5, 0.6] as [number, number],
  // Through the sidewalls; the rest of the carcass's heat leaves through the gas and the rim [est]
  coreCooling: [4, 0.1] as [number, number],
  thermalVerticalK: -0.001,
  thermalVerticalRefC: 80,
};

/**
 * "Slicks", the data's default set (COMPOUND_DEFAULT 1), added to the mod for drivers who found the Group 4 tyres too
 * much [spec tyres.ini FRONT_1 / REAR_1]: peak μ 1.401 at a reference load (3800 N front, 4770 rear) falling with load
 * by the power law LS_EXP 0.72, so μ ≈ 1.61 on the fronts and 1.54 on the rears at the static loads. Their grip peaks
 * at 10.5° (front) and 10° (rear) of slip and falls only to 88 % past it: a forgiving tyre.
 */
const SLICK: TyresCompoundData = {
  name: 'Slicks',
  shortName: 'S',
  tyre_compound: 'PhysicsTyreCompound_GT3_Soft',
  // Sliding under load wears in proportion, counted per 2000 N of it [spec VIRTUALKM USE_LOAD, WEAR_CURVE
  // slicksDRM_935_front.lut]. One curve: the front's (the rear's lasts 41 % more km)
  wear: {
    curve: [
      [0, 98],
      [0.2, 98.7],
      [0.5, 99.1],
      [1, 100],
      [1.8107, 100],
      [3.2050, 99],
      [4.0063, 99],
      [5.6088, 97.5],
      [7.2114, 95],
      [8.8139, 93],
      [10.4164, 91.5],
      [12.0189, 89],
      [13.6214, 87],
      [15.224, 84],
      [16.8265, 82],
      [18.429, 80],
      [20.0315, 78],
      [21.6341, 78],
      [23.2366, 77.5],
      [24.8391, 75.5],
      [26.4416, 74],
      [28.0442, 71],
      [29.6467, 69],
      [31.2492, 67.5],
      [32.8517, 65],
      [34.4543, 63],
      [36.0568, 60],
      [37.6593, 58],
      [39.2618, 55],
      [40.8643, 52],
      [42.4669, 50],
      [50.4795, 40],
    ],
    loadScaled: true,
    loadRefN: 2000,
  },
  front: geometry(0.275, FRONT_RADIUS, 4e-5),
  rear: geometry(0.38, REAR_RADIUS, 4e-5),
  modelData: {
    // [spec DY_REF, DX_REF at FZ0; LS_EXPY, LS_EXPX]
    Dy0: 1.401,
    Dx0: 1.401,
    lsExpY: 0.72,
    lsExpX: 0.72,
    Fz0: 3800,
    // A brush tyre, on the mod's own shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with load
    // (18.7 % per FZ0) and with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the fuller rising branch [spec XMU],
    // the longitudinal stiffness [spec CX_MULT] and the grip lost to sliding speed [spec SPEED_SENSITIVITY]. No
    // COMBINED_FACTOR in the data: the friction circle
    curve: 'brush',
    curveFullness: 0.27,
    friction_limit_angle: 10.5,
    peakSlipLoadGain: 0.187,
    peakSlipPressureGain: 0.45,
    combinedExponent: 2,
    longStiffnessMult: 1,
    speedSensitivity: 0.005899,
    // Unused by a brush tyre (the magic-formula family's stiffness law)
    pKy2: 4.2,
    slip_ratio_limit: peakSlipRatio(10.5),
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    // [spec FALLOFF_LEVEL, FALLOFF_SPEED]
    use_slip_falloff: true,
    falloff_level: 0.88,
    falloff_slope: 5,
    // [spec RELAXATION_LENGTH]
    relaxationLengthX: 0.05323,
    relaxationLengthY: 0.05323,
    // 12 N + 0.00098 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
    rollingResistance: 0.012,
    rollingResistanceSpeedSq: 9.8e-7,
    // Scrub at the peak slip, and no more past it [spec ROLLING_RESISTANCE_SLIP]
    rollingResistanceSlipGain: 3.3,
    rollingResistanceSlipMax: 1,
    // [spec DAMP]
    verticalDamping: 800,
    // No BRAKE_DX_MOD in the data
    brakeDxMod: 0,
  },
  thermalData: {
    // Grip against tread temperature (°C) [spec tcurve_frontDRM_935.lut]: full at 80 °C, 74 % cold, and a sharp step
    // from 83 % to 94 % between 58 and 62 °C. The rears' curve (tcurve_rearDRM_935.lut) takes to 75 °C to make that
    // step and holds on past 130 °C; one curve serves both here, the front's
    thermalPerformanceCurve: [
      [0, 0.74],
      [20, 0.79],
      [40, 0.8],
      [50, 0.82],
      [58, 0.83],
      [60, 0.88],
      [62, 0.94],
      [65, 0.96],
      [70, 0.97],
      [75, 0.985],
      [78, 0.995],
      [80, 1],
      [90, 0.995],
      [100, 0.988],
      [110, 0.98],
      [130, 0.97],
    ],
    // Within 0.1 % of the peak [derived]
    optimalTempC: [80, 82],
    // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]; the graining wears off as the tread slides
    tread: { grainGain: 0.5, grainGamma: 1, blisterGain: 0.5, blisterGamma: 1, wearOffWithSlip: true },
    ...THERMAL_COMMON,
  },
  pressureData: {
    // [spec PRESSURE_IDEAL]
    optimalPsi: 32,
    // [spec PRESSURE_STATIC], set cold
    setPsi: 24,
    pressureSpringCurve: pressureSpring(382_432, 3450, 24),
    // [spec PRESSURE_RR_GAIN]
    pressureRollingGain: 0.6,
    pressureGripSensitivity: 1.0,
    // 0.5 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
    pressureGripLossPerPsi: 0.005,
    // No blankets in 1976: set in the pit lane at 20 °C [est]
    coldRefC: 20,
  },
  camberData: {
    // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1, DCAMBER_LUT]
    camberGain: 0.197,
    contact_camber_c1: 1,
    contact_camber_c2: 40,
    dcamber0: 1.5,
    dcamber1: -13,
    dcamberLut: BIAS_CAMBER,
    dcamber0_x: 0,
    dcamber1_x: -6,
  },
  // The wider rear: its own reference load, peak slip angle and its growth, the fuller branch, sliding loss, rolling
  // resistance, camber thrust and pressures [spec REAR_1]
  rearOverride: {
    modelData: {
      Fz0: 4770,
      curveFullness: 0.2,
      friction_limit_angle: 10,
      peakSlipPressureGain: 0.48,
      slip_ratio_limit: peakSlipRatio(10),
      speedSensitivity: 0.0054925,
      relaxationLengthX: 0.05672,
      relaxationLengthY: 0.05672,
      rollingResistanceSpeedSq: 8.8e-7,
      rollingResistanceSlipGain: 3.5,
    },
    camberData: { camberGain: 0.26, dcamber0: 1.6 },
    pressureData: { pressureSpringCurve: pressureSpring(400_140, 3850, 24) },
  },
};

/** The Group 4 tyres' load tables (N → peak μ) [spec DY_CURVE / DX_CURVE] */
const loadTable = (mu: number[]): LutPoints => [0, 3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000].map((fz, i) => [fz, mu[i]]);
const G4_FRONT_Y = loadTable([1.6, 1.43104, 1.27744, 1.1392, 1.01632, 0.9088, 0.82816, 0.77056, 0.73216]);
const G4_FRONT_X = loadTable([1.52, 1.439744, 1.366784, 1.30112, 1.242752, 1.19168, 1.153376, 1.126016, 1.107776]);
const G4_REAR_Y = loadTable([1.6, 1.47232, 1.34464, 1.2304, 1.1296, 1.04224, 0.97504, 0.92128, 0.88768]);
const G4_REAR_X = loadTable([1.52, 1.459352, 1.398704, 1.34444, 1.29656, 1.255064, 1.223144, 1.197608, 1.181648]);

/**
 * The original Group 4 tyres [spec tyres.ini FRONT / REAR, "Good Year V70"]: grip from the load tables, ≈ 1.47 on the
 * fronts and 1.46 on the rears at the static loads, less than the slicks, peaking at 5.5° (front) and 5° (rear) of slip
 * and falling to 70 % past it, quickly: a tyre that lets go. In the hard slot.
 */
const GROUP4: TyresCompoundData = {
  name: 'Group 4 tyres',
  shortName: 'H',
  tyre_compound: 'PhysicsTyreCompound_GT3_Hard',
  // [spec VIRTUALKM USE_LOAD, WEAR_CURVE tire_wcurve_slick.lut, both axles]
  wear: {
    curve: [
      [0, 95],
      [0.3, 100],
      [1, 100],
      [3, 98.5],
      [5, 97.5],
      [10, 95],
      [15, 92.5],
      [20, 90],
    ],
    loadScaled: true,
    loadRefN: 2000,
  },
  front: geometry(0.275, FRONT_RADIUS, 1.5e-5),
  rear: geometry(0.38, REAR_RADIUS, 1.5e-5),
  modelData: {
    // The tables at FZ0, and the power law the tables replace [spec FZ0, LS_EXPY, LS_EXPX]
    Dy0: 1.43104,
    Dx0: 1.439744,
    lsExpY: 0.85,
    lsExpX: 0.9,
    Fz0: 3000,
    dyCurve: G4_FRONT_Y,
    dxCurve: G4_FRONT_X,
    // A brush tyre on the mod's shape data, as the slicks [spec FRICTION_LIMIT_ANGLE, FLEX_GAIN, PRESSURE_FLEX_GAIN, XMU,
    // COMBINED_FACTOR, CX_MULT, SPEED_SENSITIVITY]
    curve: 'brush',
    curveFullness: 0.27,
    friction_limit_angle: 5.5,
    peakSlipLoadGain: 0.09,
    peakSlipPressureGain: -0.3,
    combinedExponent: 2,
    longStiffnessMult: 1,
    speedSensitivity: 0.001,
    pKy2: 4.2,
    slip_ratio_limit: peakSlipRatio(5.5),
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    // [spec FALLOFF_LEVEL, FALLOFF_SPEED]
    use_slip_falloff: true,
    falloff_level: 0.7,
    falloff_slope: 10,
    // [spec RELAXATION_LENGTH]
    relaxationLengthX: 0.105,
    relaxationLengthY: 0.105,
    // 15 N + 0.001 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
    rollingResistance: 0.015,
    rollingResistanceSpeedSq: 1e-6,
    // [spec ROLLING_RESISTANCE_SLIP]
    rollingResistanceSlipGain: 0.8,
    rollingResistanceSlipMax: 1,
    // [spec DAMP]
    verticalDamping: 1000,
    // [spec BRAKE_DX_MOD]
    brakeDxMod: -0.02,
  },
  thermalData: {
    // Grip against tread temperature (°C) [spec tire_heat_slick_90_mu.lut, both axles]: full at 90 °C, 60 % cold
    thermalPerformanceCurve: [
      [0, 0.6],
      [10, 0.66],
      [20, 0.725],
      [30, 0.795],
      [40, 0.8575],
      [50, 0.9125],
      [60, 0.9575],
      [65, 0.9725],
      [70, 0.985],
      [75, 0.992],
      [80, 0.996],
      [85, 0.999],
      [90, 1],
      [95, 0.995],
      [100, 0.9875],
      [105, 0.976],
      [110, 0.9625],
      [120, 0.9325],
      [130, 0.9025],
      [140, 0.8725],
      [150, 0.8475],
      [160, 0.8275],
      [180, 0.8025],
      [200, 0.79],
      [250, 0.78],
      [300, 0.775],
      [350, 0.77],
      [400, 0.76],
      [450, 0.75],
    ],
    // Within 0.1 % of the peak [derived]
    optimalTempC: [85, 90],
    // No graining or blistering [spec GRAIN_GAIN 0, BLISTER_GAIN 0]
    tread: { grainGain: 0, grainGamma: 1, blisterGain: 0, blisterGamma: 1, wearOffWithSlip: true },
    ...THERMAL_COMMON,
  },
  pressureData: {
    // [spec PRESSURE_IDEAL]
    optimalPsi: 28,
    // [spec PRESSURE_STATIC], set cold
    setPsi: 22,
    pressureSpringCurve: pressureSpring(208_000, 9000, 22),
    // [spec PRESSURE_RR_GAIN]
    pressureRollingGain: 0.5,
    pressureGripSensitivity: 1.0,
    // [spec PRESSURE_D_GAIN]
    pressureGripLossPerPsi: 0.005,
    coldRefC: 20,
  },
  camberData: {
    // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1, DCAMBER_LUT]
    camberGain: 0.2,
    contact_camber_c1: 1,
    contact_camber_c2: 40,
    dcamber0: 1.2,
    dcamber1: -12,
    dcamberLut: BIAS_CAMBER,
    dcamber0_x: 0,
    dcamber1_x: -6,
  },
  // The rear's own load tables, peak slip angle and its growth, relaxation, rolling resistance and pressures [spec REAR]
  rearOverride: {
    modelData: {
      Dy0: 1.47232,
      Dx0: 1.459352,
      dyCurve: G4_REAR_Y,
      dxCurve: G4_REAR_X,
      Fz0: 3000,
      friction_limit_angle: 5,
      peakSlipLoadGain: 0.07,
      slip_ratio_limit: peakSlipRatio(5),
      relaxationLengthX: 0.09,
      relaxationLengthY: 0.09,
      rollingResistance: 0.016,
      rollingResistanceSpeedSq: 8.8e-7,
    },
    pressureData: { optimalPsi: 35, setPsi: 26, pressureSpringCurve: pressureSpring(260_000, 15_000, 26) },
  },
};

/**
 * The slicks in the soft and medium slots, the Group 4 tyres in the hard, and rain tyres on the slicks' carcass, as the
 * Nissans' [est]: the mod has none
 */
const TYRES = {
  PhysicsTyreCompound_GT3_Soft: SLICK,
  PhysicsTyreCompound_GT3_Hard: GROUP4,
  PhysicsTyreCompound_GT3_Intermediate: deriveRainCompound(SLICK, 'intermediate', 'PhysicsTyreCompound_GT3_Intermediate', 'Intermediate'),
  PhysicsTyreCompound_GT3_Wet: deriveRainCompound(SLICK, 'wet', 'PhysicsTyreCompound_GT3_Wet', 'Wet'),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Equivalent box 1.775 × 1.17 × 4.275 m [spec car.ini INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const PORSCHE_934_RSR_CONFIG = {
  screenName: 'Porsche 934 Turbo RSR',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: FRONT_WEIGHT,
    // [spec WHEELBASE, TRACK]. The data's front track is 9 cm narrower than the body's front wheels stand (1.517 m in
    // porsche-934-rsr.glb, the rear's 1.517 against 1.501), so the front contact patches sit ≈ 4 cm inboard of the drawn
    // tyres; the handling is the data's
    wheelbase: WHEELBASE,
    trackWidthFront: 1.43,
    trackWidthRear: 1.501,
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(1.17, 4.275), roll: box(1.775, 1.17), yaw: box(1.775, 4.275) },
    // [spec HUB_MASS]
    unsprungMassFront: FRONT_HUB_KG,
    unsprungMassRear: REAR_HUB_KG,
    // The tank sits in the nose, 1.0 m ahead of the CG and 0.24 m above it [spec FUELTANK POSITION]
    fuelTank: { y: 0.2427303, z: 1.00375 },
    // [spec tyres.ini ANGULAR_INERTIA]
    wheelInertiaFront: 1.6,
    wheelInertiaRear: 2.4,
    // 540° of rim lock each way on a 16.9:1 rack [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 540 / 16.9,
    // The strut (STRUT_TYRE → STRUT_CAR) leans back 4.5° and meets the ground 27.5 mm ahead of the contact patch [derived]
    ffbMechanicalTrailM: 0.0275,
    // The body's plan at barrier height, measured from porsche-934-rsr.glb (`scripts/measure-car-plans.ts`)
    bodyPlan: [[0.00, 2.05], [0.51, 2.02], [0.74, 1.86], [0.90, 1.53], [0.95, -0.89], [0.94, -1.52], [0.61, -2.26], [0.00, -2.35]],
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 1000 Nm clutch; the auto clutch bites at 1200 rpm and closes by 1800 [spec CLUTCH, AUTOCLUTCH]. On the throttle in
  // first it slips at 4000 instead: at 1300 rpm the engine makes 110 Nm and no boost, and a flat-out start sat there
  // for two seconds (0-100 in 7.2 s); from 4000 the turbo has something to work with (≈ 5 s on cold slicks), and from
  // 5500 the rears go up in smoke [est]
  clutch: { maxTorqueNm: 1000, biteRpm: 1200, lockRpm: 1800, launchRpm: 4000 },
  // Locking torque = preload + POWER / COAST × input torque [spec DIFFERENTIAL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.25, coast: 0.4, preload: 20, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // 2700 Nm at full pedal, 60 % front, bias adjustable in 0.5 % steps, a 1000 Nm handbrake [spec brakes.ini]. The pads
  // grip 70 % cold, 80 % at 300 °C and fully only from 450 to 600 °C, falling to 80 % at 800 and 20 % at 1200 (the
  // front's curve; the rear's falls to 70 % at 800). Out of the garage on the full realism level the discs are at the
  // air's 35 °C [est], so the first stops are on 70 % brakes: the car the modder warns about. The iron discs' model is
  // set for a GT3's ducts, on which these discs peaked at 260 °C (front) and 180 (rear) a lap, braking on ≈ 79 % for
  // good: on 40 % of that air they reach 460–490 °C and 370–420 [est], the rears on 0.8 of the fronts' cooling as the
  // data's COOL_TRANSFER has it (0.012 against 0.015) [derived]
  brakes: {
    maxTorqueNm: 2700,
    front_bias: 0.6,
    handbrakeTorqueNm: 1000,
    ebbStep: 0.005,
    brakeByWire: false,
    discMaterial: 'endurance-steel',
    padMuCurve: [
      [0, 0.7],
      [300, 0.8],
      [450, 1],
      [600, 1],
      [800, 0.8],
      [1200, 0.2],
    ],
    garageDiscTempC: 35,
    ductShare: 0.4,
    rearDuctShare: 0.8,
    migration: { amount: 0, rampStart: 0 },
  },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: TYRES,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_GT3_Soft',
    medium: 'PhysicsTyreCompound_GT3_Soft',
    hard: 'PhysicsTyreCompound_GT3_Hard',
    intermediate: 'PhysicsTyreCompound_GT3_Intermediate',
    wet: 'PhysicsTyreCompound_GT3_Wet',
  },
} satisfies CarPhysicsConfig;

/**
 * The car has no traction control or ABS (PRESENT=0), but the data sets both up: TC at 20 % wheelspin cycling at
 * 100 Hz, off under 30 km/h; ABS at 20 % cycling at 200 Hz [spec electronics.ini; no CURVE]. They serve the assisted
 * presets (and the semi-pro ABS, which the AI brakes on); the ABS's other positions step 0.5 % either side [est]. The
 * data's 20 % is the slicks' grip peak (22.75 %), so the TC's looser positions run up to 25 % and its tighter ones down
 * to 6 %, where it holds the car on the power out of a corner as the other cars' top positions do [est]. The lateral
 * and rear slide terms are the Nissans' [est]
 */
export const PORSCHE_934_RSR_ELECTRONICS = {
  absLevels: [0.17, 0.175, 0.18, 0.185, 0.19, 0.195, 0.2, 0.205, 0.21, 0.215, 0.22, 0.225],
  absDefault: 0.2,
  absRateHz: 200,
  tcLevels: [0.06, 0.08, 0.1, 0.12, 0.14, 0.17, 0.2, 0.21, 0.22, 0.23, 0.24, 0.25],
  tcDefault: 0.2,
  tcRateHz: 100,
  tcMinSpeedKmh: 30,
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
