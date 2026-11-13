/**
 * Nissan Skyline GT-R BCNR33 JGTC (1998, GT500) vehicle data for `VehiclePhysics` (same data model as the f12026-car,
 * see `F12026CarConfig`): a front-engined GT car with a twin-turbo straight six, rear-wheel drive, a six-speed
 * sequential and a ride-height aero map.
 *
 * The numbers come from gregsediting's Nissan Skyline BCNR33 JGTC for Assetto Corsa, mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics / setup); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * No hybrid or DRS. ABS is fitted but off by default and there is no traction control (electronics.ini). Double
 * wishbones at both ends with no heave springs, three slicks, and the AC extended-physics aero: a 2D ride-height map
 * for the body (CL / CD / balance against the front and rear ride heights, scaled by roll and yaw) with a front splitter
 * and a rear wing on top. Its diffuser and body wing elements have their gains at 0, so they do nothing.
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
import { tyreGaugePressureAtTemperature } from '../tyre-pressure';

/** Driveline efficiency of this model; the wheel torque curve is divided by it for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/**
 * Torque before boost, after the driveline (rpm → Nm) [spec power.lut]: 218 Nm at 4000 rpm. The turbos multiply it by
 * 1 + boost (below)
 */
const BASE_WHEEL_TORQUE: [number, number][] = [
  [900, 194],
  [1000, 195],
  [1100, 196],
  [1200, 198],
  [1300, 198],
  [1400, 199],
  [1500, 200],
  [1600, 201],
  [1700, 201],
  [1800, 202],
  [1900, 203],
  [2000, 203],
  [2100, 204],
  [2200, 204],
  [2300, 205],
  [2400, 205],
  [2500, 206],
  [2600, 206],
  [2700, 207],
  [2800, 208],
  [2900, 208],
  [3000, 209],
  [3100, 210],
  [3200, 211],
  [3300, 212],
  [3400, 213],
  [3500, 214],
  [3600, 214],
  [3700, 215],
  [3800, 216],
  [3900, 217],
  [4000, 218],
  [4100, 217],
  [4200, 213],
  [4300, 208],
  [4400, 204],
  [4500, 203],
  [4600, 200],
  [4700, 197],
  [4800, 195],
  [4900, 194],
  [5000, 192],
  [5100, 190],
  [5200, 189],
  [5300, 188],
  [5400, 186],
  [5500, 182.5],
  [5600, 180],
  [5700, 178],
  [5800, 175],
  [5900, 172],
  [6000, 170.2],
  [6100, 165.3],
  [6200, 159],
  [6300, 153],
  [6400, 146],
  [6500, 138],
  [6600, 130],
  [6700, 121],
  [6800, 110],
  [6900, 100],
  [7000, 90],
  [7100, 80],
  [7200, 0],
];

/**
 * The two turbochargers, one per bank of three cylinders [spec engine.ini TURBO_0, TURBO_1]. Each adds its own boost to
 * the torque multiplier, 1 + boost₀ + boost₁, and both are the same: MAX_BOOST 1.0 with the wastegate at 1.0 (so it
 * never cuts in below the maximum), full boost from REFERENCE_RPM 4400 on a GAMMA 2.5 rise. Their sum is one turbo of
 * twice the boost on the same curve, which is what this is: torque × 3 at full boost, ≈ 612 Nm at the wheels at 4400 rpm.
 * Their lag is AC's per-step filter, LAG_UP 0.965 / LAG_DN 0.990 at 333 Hz: an 84 ms time constant spooling up and
 * 300 ms running down [derived]. AC's spool time is the same at any rpm; this model's scales with 1 / rpm, so it holds
 * the 84 ms at the 4400 rpm where the boost is made (≈ 55 ms at the 6700 rpm shift point, 120 ms at 3000).
 * The gauge reads one 1.0 bar: the two turbos blow into one plenum at the same pressure [spec DISPLAY_MAX_BOOST]
 */
const TURBO: TurboData = {
  maxBoost: 2,
  referenceRpm: 4400,
  gamma: 2.5,
  spoolUpS: 0.084,
  spoolRefRpm: 4400,
  spoolDownS: 0.3,
  displayMaxBoostBar: 1,
};

/**
 * Crank power with the boost made (kW): the curve × (1 + boost), ÷ the driveline [derived]: ≈ 349 kW at the crank at
 * 6000 rpm, 321 kW (430 hp) at the wheels. The torque below 900 rpm is the curve's first point
 */
const POWER_CURVE: LutPoints = [
  [0, 0],
  ...BASE_WHEEL_TORQUE.map(
    ([rpm, nm]): [number, number] => [rpm, ((nm * (1 + turboSteadyBoost(TURBO, rpm))) / DRIVELINE_EFFICIENCY) * rpm * Math.PI / 30 / 1000]
  ),
];

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque, 51 Nm at 7000 rpm [spec COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [1200, 0],
    [7000, 51],
    [7200, 52.8],
  ] as LutPoints,
  // Pedal → throttle: linear [spec throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ] as LutPoints,
  // Throttle actuator and intake filling, as the GT3's [est]; the turbo lag is its own (above)
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  turbo: TURBO,
  // [spec MINIMUM]
  idleRpm: 1200,
  // Engine 0.197 + gearbox 0.018 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.215,
  // 50 Hz limiter: the cut lasts one cycle [spec LIMITER_HZ]
  limiterCutS: 0.02,
  // A tenth less air costs 1 % of the torque [spec ALTITUDE_SENSITIVITY]
  airDensitySensitivity: 0.1,
};

const NONE: LutPoints = [
  [0, 0],
  [8000, 0],
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
 * Six-speed paddle-shift sequential on a 3.545 final drive [spec drivetrain.ini]: first is a long way below second
 * (4.258 against 1.838, the first.rto pick the data defaults to), and sixth runs to ≈ 292 km/h at the 7000 rpm
 * limiter. The ignition cuts for the 110 ms auto-cutoff of an up-shift [spec AUTO_CUTOFF_TIME]
 */
const GEARBOX = {
  ratios: [4.258, 1.838, 1.443, 1.188, 1.02, 0.919],
  reverse: 2.285,
  finalDrive: 3.545,
  shiftTimeS: 0.11,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.15,
  // As the 496R's [est]
  shiftTorqueFraction: 0.1,
  // Dog box: 100 ms between gears, the ignition cut for 110 ms [spec CHANGE_UP_TIME, AUTO_CUTOFF_TIME]
  upshiftNeutralS: 0.1,
  upshiftCutS: 0.11,
  // Down: 150 ms between gears, the clutch starts home at 100 ms and is home by 180 ms, a 70 % blip risen in 20 ms
  // [spec CHANGE_DN_TIME, DOWNSHIFT_PROFILE, AUTOBLIP]. The blip is AC's driver aid here (ELECTRONIC=0), a driver's
  // heel and toe in this model. The data's down-shift protection is off (ACTIVE=0), so the box takes a down-shift up to
  // the 9000 rpm where the engine starts to take damage [spec DAMAGE RPM_THRESHOLD]
  downshift: { neutralS: 0.15, clutchReleaseS: 0.1, clutchHomeS: 0.18, blip: { level: 0.7, riseS: 0.02 }, overRevRpm: 2000 },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 7000,
    // [spec AUTO_SHIFTER UP]
    upshift_rpm: 6700,
    // [spec AUTO_SHIFTER DOWN]
    downshift_rpm: 3500,
    // Into a braking zone the auto box clicks down while the lower gear lands under 6000 rpm, at peak power [est]
    brake_downshift_rpm: 6000,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

const MASS = 1275;
const WHEELBASE = 2.72;
/** Share of the sprung weight on the front axle [spec CG_LOCATION] */
const FRONT_WEIGHT = 0.45;
/** Hub masses [spec HUB_MASS] */
const FRONT_HUB_KG = 37;
const REAR_HUB_KG = 41;
/** Sprung load on a front / rear spring at static ride (N): the car less its hubs [derived] */
const SPRUNG_KG = MASS - 2 * FRONT_HUB_KG - 2 * REAR_HUB_KG;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * FRONT_WEIGHT) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * (1 - FRONT_WEIGHT)) / 2;
/**
 * The soft slick's radial rate at the 27 psi it runs at (N/m): RATE at the static pressure + PRESSURE_SPRING_GAIN per
 * psi [spec]
 */
const HOT_FRONT_TYRE_RATE = 295_000 + 10_650 * (27 - 21);
const HOT_REAR_TYRE_RATE = 290_000 + 10_925 * (27 - 20);
/**
 * The mod measures its stops from the suspension's design position, with the springs working on their rod lengths
 * (`mod-suspension.ts`): at static ride the fronts sit 0.6 mm into their travel and the rears 4.3 mm, so the stops are
 * these far from static [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN; derived]
 */
const FRONT_STOPS = modCornerStops({
  staticLoadN: FRONT_STATIC_LOAD_N,
  springRate: 120_000,
  rodLength: 0.02,
  packerRange: 0.045,
  bumpStopUp: 0.055,
  bumpStopDn: 0.055,
});
const REAR_STOPS = modCornerStops({
  staticLoadN: REAR_STATIC_LOAD_N,
  springRate: 115_000,
  rodLength: 0.022,
  packerRange: 0.065,
  bumpStopUp: 0.065,
  bumpStopDn: 0.035,
});
const mm = (m: number) => Number(m.toFixed(4));

/**
 * Double wishbones front and rear, no heave springs: the mod's wheel rates, anti-roll bars, bump stops, packers and
 * two-stage dampers [spec suspensions.ini], the stops at their distance from static ride (above). Each corner meets its
 * packer first (24 mm up at the front, 39 mm at the rear) and its bump stop second (54 / 61 mm), both at the data's
 * BUMP_STOP_RATE. Hardpoints are [x inboard, y up, z forward] from the wheel centre [spec]; camber gain and roll-centre
 * heights are what the kinematic solver gives on them at static [derived]. The rear's arms meet outboard of the wheel,
 * so it gains positive camber in bump and its roll centre sits 70 mm under the road.
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -3.7,
    camberGainKinematic: -5.1,
    springs: { wheel_rate: 120_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(FRONT_STOPS.packerGapM), rate: 35_000, progression: 0, hardStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 35_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.0342,
    // [spec ARB FRONT]
    arb: 45_000,
    hardpoints: [
      [0.38995, 0.1357767, 0.08251823],
      [0.39595, 0.1357767, -0.08251823],
      [0.436719, -0.1612271, 0.343843],
      [0.4215514, -0.1612271, -0.04374027],
      [0.1191263, 0.1344876, 0.01439202],
      [0.11121, -0.1711557, 0.01439202],
      [0.549531, -0.1612271, -0.1398844],
      [0.13095, -0.1612271, -0.1120119],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -3.2,
    camberGainKinematic: 17.3,
    springs: { wheel_rate: 115_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(REAR_STOPS.packerGapM), rate: 30_000, progression: 0, hardStop: { range: mm(REAR_STOPS.bumpStopGapM), rate: 30_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: -0.0695,
    // [spec ARB REAR]
    arb: 35_000,
    hardpoints: [
      [0.5240784, 0.0978518, 0.1586779],
      [0.5105181, 0.0978518, -0.01296192],
      [0.5431641, -0.1822778, 0.2360592],
      [0.5230886, -0.1822778, -0.004545711],
      [0.1360698, 0.08218055, 0],
      [0.0866522, -0.1678851, 0],
      [0.5496, -0.115727, -0.18],
      [0.1748366, -0.115727, -0.18],
    ],
  },
  dampers_controller: {
    front: {
      // [spec DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND, DAMP_FAST_*THRESHOLD]
      base: damper(13_000, 5000, 12_500, 5000),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.05,
      fastReboundThresholdMs: 0.05,
    },
    rear: {
      base: damper(10_000, 4000, 9500, 4000),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.05,
      fastReboundThresholdMs: 0.05,
    },
  },
};

/**
 * The body's height at each axle is the tyre's loaded radius less the wheel centre's height in the body frame (BASEY
 * 0.048 below the CG's level, plus the static offset): 0.400 m at the front, 0.395 m at the rear, so the CG, 45 % of the
 * weight forward, rides 0.397 m up [spec BASEY, RADIUS; derived]. The ride-height pickups sit 0.353 m (front) and
 * 0.354 m (rear) below the CG's level [spec car.ini RIDE]: 47 / 41 mm off the ground at rest, inside the aero map's
 * −10 to 75 mm.
 */
const FRONT_PICKUP_Y = -0.353;
const REAR_PICKUP_Y = -0.354;
const FRONT_BODY_HEIGHT = modBodyHeightM(0.3606, (FRONT_STATIC_LOAD_N + FRONT_HUB_KG * 9.81) / HOT_FRONT_TYRE_RATE, -0.048, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(0.3606, (REAR_STATIC_LOAD_N + REAR_HUB_KG * 9.81) / HOT_REAR_TYRE_RATE, -0.048, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * (1 - FRONT_WEIGHT)).toFixed(4));
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT + FRONT_PICKUP_Y).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT + REAR_PICKUP_Y).toFixed(4));

/** AC's YAW_CL_GAIN as a table: CL × (1 + gain · |yaw| in radians), at the slide angles the car meets (|deg| → ×) */
const yawTable = (yawGain: number): LutPoints =>
  [0, 2, 5, 10, 20, 30].map((deg) => [deg, Number(Math.max(0, 1 + (yawGain * deg * Math.PI) / 180).toFixed(4))]);
/** A table moved along its axis */
const shiftX = (lut: LutPoints, dx: number): LutPoints => lut.map(([x, v]) => [Number((x + dx).toFixed(4)), v]);

/**
 * The aero as AC's extended physics has it (car.ini VERSION=extended-2, aero.ini MAP_0):
 *  - The body: CL·A 3.00 and CD·A 1.10 [spec CL_MULT, CD_MULT] × the 2D ride-height tables, read at the RIDE pickups'
 *    ground clearance (rows the rear ride height, columns the front), × the roll and yaw tables; the front share from
 *    the balance table plus its roll and yaw offsets; each force lags 50 ms [spec MAP_*_RH.2Dlut, MAP_ROLL_*, MAP_YAW_*,
 *    *_FORCE_DELAY]. The tables' header rows carry nine values for eight columns of data (the CD table's ninth repeats
 *    0.070, and in all three the ninth is set off by spaces where the others are tab-separated); the columns are read
 *    as the first eight, −10 to 70 mm, the same axis as the rows' first eight, which is the reading where the first two
 *    columns' equal values are the table's flat end below 40 mm, as they are on its rows. The MAP_SPEED_CL / _CD tables are 0 at every speed: read as no change with speed (on another reading they
 *    would cancel the whole map). At rest that is CL·A ≈ 2.5 m², 38 % on the front, and CD·A ≈ 1.0 m²; as the car
 *    settles toward the ground at speed the front share rises to ≈ 42 %.
 *  - The front splitter (WING_0, 1.2 m², 2° of its 0–6) and the rear wing (WING_1, 1.4 m², 4° of its 0–10) on top, at
 *    their angle-of-attack tables [spec aero.ini, CL_GAIN / CD_GAIN 1]: ≈ 0.56 and 0.57 m² of CL·A. The rear wing has no
 *    drag at any angle: its ground-height drag table is 0 everywhere [spec LUT_GH_CD=10_0.lut], so its drag is in the
 *    map's.
 *  - Left out, as AC reads them as nothing: the diffuser and body elements (WING_2–8, CL_GAIN and CD_GAIN 0; the two
 *    dynamic controllers drive two of these), the brake ducts (WING_9 / 10, 0 at their 0° angle) and the GAS / BRAKES
 *    elements (WING_11 / 12, tables of 0).
 *  - Approximated: with a map this model splits each wing's downforce to the axles by where it sits between them, held
 *    to the axles (the splitter, 0.45 m ahead of the front axle, puts all of it on the front instead of 117 % front and
 *    −17 % rear; the wing, 0.45 m behind the rear axle, the same at the rear: the two nearly cancel), and reads the
 *    wings' angle-of-attack tables only: the splitter's ground-height table (1.00 from 65 to 95 mm, where it rides at
 *    speed; 0.95 at rest) and both wings' YAW_CL_GAIN (−0.10: 2 % at 10° of slide) are dropped.
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  // The body's drag is the map's
  drag: 0,
  wings: [
    {
      name: 'FRONT_WING',
      area: 1.2,
      // [spec WING_0 POSITION, ANGLE]
      positionZ: 1.95,
      angleDeg: 2,
      heightRef: 'front',
      lutAOA_CL: [
        [-10, -0.05],
        [-2, 0.3927],
        [1, 0.46122],
        [2, 0.4705],
        [4, 0.49973],
        [5, 0.49551],
        [6, 0.4709],
      ],
      lutAOA_CD: [
        [-10, 0.1],
        [-2, 0],
        [0, 0],
        [2, 0.0025],
        [4, 0.004],
        [6, 0.0055],
        [8, 0.01],
        [10, 0.0125],
        [12, 0.015],
      ],
      // Unread with the map (above); against the front pickup's clearance, the splitter 55 mm above it [spec
      // height_front_CL / _CD.lut, POSITION]
      lutGH_CL_mult: shiftX(
        [
          [0, 0],
          [0.025, 1.15],
          [0.055, 1.02],
          [0.065, 1],
          [0.075, 1],
          [0.0854, 1],
          [0.095, 1],
          [0.105, 0.95],
          [0.115, 0.9],
          [0.13, 0.8],
          [0.14, 0.7],
        ],
        -0.055
      ),
      lutGH_CD_mult: shiftX(
        [
          [0, 0.99],
          [0.01, 0.996],
          [0.052, 0.998],
          [0.065, 0.999],
          [0.0764, 1],
          [0.0884, 1.002],
          [0.09, 1.004],
        ],
        -0.055
      ),
      lutYaw_CL_mult: yawTable(-0.1),
    },
    {
      name: 'REAR_WING',
      area: 1.4,
      // [spec WING_1 POSITION, ANGLE]
      positionZ: -1.67,
      angleDeg: 4,
      heightRef: 'rear',
      lutAOA_CL: [
        [-10, -0.18],
        [-2, 0.04],
        [0, 0.22],
        [2, 0.34],
        [4, 0.405],
        [6, 0.5],
        [8, 0.54],
        [10, 0.55],
        [12, 0.555],
        [14, 0.54],
      ],
      // CD_RW_AOA.lut × its ground-height drag table, 0 [spec LUT_GH_CD=10_0.lut]
      lutAOA_CD: [
        [-10, 0],
        [20, 0],
      ],
      lutGH_CL_mult: [
        [0, 1],
        [1, 1],
      ],
      lutGH_CD_mult: [
        [0, 1],
        [1, 1],
      ],
      lutYaw_CL_mult: yawTable(-0.1),
    },
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // The map's forces act at the pickups' level [spec RIDE]
  floorOffsetY: 0.5 * (FRONT_PICKUP_Y + REAR_PICKUP_Y),
  // The body's ground colliders: their undersides 0.30 m below the CG, from the splitter's front edge to the tail, 50 mm
  // above the pickups [spec colliders.ini COLLIDER_0 / COLLIDER_1, GROUND_ENABLE]
  plank: { y: -0.304, frontZ: 2.125, rearZ: -2.05 },
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
  rhMap: {
    clA: 3,
    cdA: 1.1,
    frontPickupY: FRONT_PICKUP_Y,
    rearPickupY: REAR_PICKUP_Y,
    rearRh: [-0.01, 0.04, 0.045, 0.05, 0.055, 0.06, 0.065, 0.07, 0.075],
    frontRh: [-0.01, 0.04, 0.045, 0.05, 0.055, 0.06, 0.065, 0.07],
    // [spec MAP_CL_RH.2Dlut]
    cl: [
      [0.857, 0.857, 0.836, 0.816, 0.796, 0.775, 0.755, 0.734],
      [0.857, 0.857, 0.836, 0.815, 0.796, 0.775, 0.755, 0.735],
      [0.917, 0.917, 0.896, 0.876, 0.856, 0.835, 0.815, 0.794],
      [0.961, 0.961, 0.94, 0.92, 0.9, 0.879, 0.858, 0.838],
      [0.989, 0.989, 0.967, 0.948, 0.927, 0.906, 0.886, 0.865],
      [1, 1, 0.978, 0.959, 0.938, 0.918, 0.897, 0.877],
      [0.995, 0.995, 0.973, 0.954, 0.933, 0.913, 0.892, 0.872],
      [0.974, 0.974, 0.952, 0.933, 0.912, 0.891, 0.871, 0.85],
      [0.935, 0.935, 0.915, 0.895, 0.875, 0.855, 0.835, 0.815],
    ],
    // [spec MAP_CD_RH.2Dlut]
    cd: [
      [0.906, 0.906, 0.913, 0.92, 0.928, 0.935, 0.942, 0.949],
      [0.905, 0.905, 0.915, 0.925, 0.93, 0.935, 0.945, 0.95],
      [0.913, 0.913, 0.92, 0.928, 0.935, 0.942, 0.949, 0.957],
      [0.92, 0.92, 0.928, 0.935, 0.942, 0.949, 0.957, 0.964],
      [0.928, 0.928, 0.935, 0.942, 0.949, 0.957, 0.964, 0.971],
      [0.935, 0.935, 0.942, 0.949, 0.957, 0.964, 0.971, 0.978],
      [0.942, 0.942, 0.949, 0.957, 0.964, 0.971, 0.978, 0.986],
      [0.949, 0.949, 0.957, 0.965, 0.971, 0.978, 0.986, 0.995],
      [0.957, 0.957, 0.964, 0.97, 0.978, 0.986, 0.99, 1],
    ],
    // [spec MAP_BALANCE_RH.2Dlut, BALANCE_OFFSET 0]
    balance: [
      [0.422, 0.422, 0.39, 0.36, 0.333, 0.306, 0.283, 0.259],
      [0.425, 0.425, 0.395, 0.365, 0.335, 0.305, 0.285, 0.255],
      [0.427, 0.427, 0.4, 0.373, 0.34, 0.316, 0.276, 0.259],
      [0.432, 0.435, 0.415, 0.385, 0.35, 0.325, 0.269, 0.26],
      [0.438, 0.438, 0.425, 0.39, 0.356, 0.33, 0.276, 0.265],
      [0.445, 0.443, 0.435, 0.396, 0.36, 0.34, 0.28, 0.272],
      [0.453, 0.45, 0.45, 0.406, 0.372, 0.352, 0.296, 0.29],
      [0.46, 0.46, 0.46, 0.415, 0.384, 0.364, 0.309, 0.309],
      [0.477, 0.477, 0.48, 0.437, 0.4, 0.38, 0.33, 0.337],
    ],
    // [spec MAP_ROLL_*.lut]
    rollCl: [
      [-3, 0.985],
      [0, 1],
      [3, 0.985],
    ],
    rollCd: [
      [-3, 0.95],
      [0, 1],
      [3, 0.95],
    ],
    rollBalance: [
      [-3, 0.005],
      [0, 0],
      [3, 0.005],
    ],
    // [spec MAP_YAW_*.lut]
    yawCl: [
      [-30, 0.85],
      [-25, 0.96],
      [-5, 0.997],
      [0, 1],
      [5, 0.997],
      [25, 0.96],
      [30, 0.85],
    ],
    yawCd: [
      [-30, 1.05],
      [-25, 1.0375],
      [-5, 1.0025],
      [0, 1],
      [5, 1.0025],
      [25, 1.0375],
      [30, 1.05],
    ],
    yawBalance: [
      [-30, 0.025],
      [-25, 0.02],
      [-5, 0.001],
      [0, 0],
      [5, 0.001],
      [25, 0.02],
      [30, 0.025],
    ],
    // [spec FRONT_FORCE_DELAY, REAR_FORCE_DELAY, DRAG_FORCE_DELAY]
    frontDelayS: 0.05,
    rearDelayS: 0.05,
    dragDelayS: 0.05,
    activeAero: { dClAFront: 0, dClARear: 0, dCdA: 0 },
  },
};

/**
 * Front 0.315 and rear 0.330 m wide, both R 0.3606 on a R 0.2413 rim; the radius grows 0.03 mm per rad/s of spin,
 * 7 mm at 250 km/h [spec tyres.ini RADIUS_ANGULAR_K]
 */
const R33_FRONT: TyreGeometry = { width: 0.315, radius: 0.3606, rimRadius: 0.2413, verticalRateScale: 1, radiusGrowthPerRadS: 3e-5 };
const R33_REAR: TyreGeometry = { width: 0.33, radius: 0.3606, rimRadius: 0.2413, verticalRateScale: 1, radiusGrowthPerRadS: 3e-5 };

/** The tyres' reference loads [spec FZ0] */
const FRONT_FZ0 = 4200;
const REAR_FZ0 = 4100;

/** The load-sensitivity tables' loads (N); the last point is the data's 150 000 [spec DY_CURVE, DX_CURVE] */
const LOADS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000, 11_000, 12_000, 13_000, 14_000, 150_000];
const loadTable = (mu: number[]): LutPoints => LOADS.map((fz, i) => [fz, mu[i]]);
/** A load table's μ at `fz` */
const muAt = (mu: number[], fz: number): number => {
  const i = LOADS.findIndex((l) => l > fz);
  const t = (fz - LOADS[i - 1]) / (LOADS[i] - LOADS[i - 1]);
  return Number((mu[i - 1] + (mu[i] - mu[i - 1]) * t).toFixed(4));
};

/** One axle of one compound, as the data gives it */
interface AxleTyreData {
  /** RATE at PRESSURE_STATIC, and PRESSURE_SPRING_GAIN per psi */
  rate: number;
  springGain: number;
  staticPsi: number;
  /** DY_CURVE / DX_CURVE values at `LOADS` */
  dy: number[];
  dx: number[];
  frictionLimitAngle: number;
  speedSensitivity: number;
  brakeDxMod: number;
  dcamber0: number;
  dcamber1: number;
  /** WEAR_CURVE: grip (% of new) against km slid */
  wear: LutPoints;
}

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the static pressure + the gain per psi [spec] */
const pressureSpring = (a: AxleTyreData): LutPoints =>
  [10, 15, 20, 25, 27, 30, 35].map((p) => [p, Math.round(a.rate + a.springGain * (p - a.staticPsi))]);

/** PRESSURE_STATIC is the pressure set at 20 °C; carried to the blankets' temperature, where the car leaves them [derived] */
const setPsiAt = (staticPsi: number, blanketC: number): number => Number(tyreGaugePressureAtTemperature(staticPsi, 20, blanketC).toFixed(1));

function slickCompound(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  front: AxleTyreData,
  rear: AxleTyreData,
  thermalCurve: LutPoints,
  window: [number, number],
  /** BLANKETS_TEMP / OVERRIDE_BLANKETS_TEMP (°C) */
  blanketC: number,
  /** THERMAL_* GRAIN_GAIN */
  grainGain: number
): TyresCompoundData {
  return {
    name,
    shortName,
    tyre_compound,
    // Sliding under load wears in proportion, counted per 2000 N of it [spec VIRTUALKM USE_LOAD]
    wear: { curve: front.wear, loadScaled: true, loadRefN: 2000 },
    front: R33_FRONT,
    rear: R33_REAR,
    modelData: {
      // The tables at FZ0, and the power law the tables replace [spec FZ0, LS_EXPY, LS_EXPX]
      Dy0: muAt(front.dy, FRONT_FZ0),
      Dx0: muAt(front.dx, FRONT_FZ0),
      lsExpY: 0.6,
      lsExpX: 0.6,
      Fz0: FRONT_FZ0,
      dyCurve: loadTable(front.dy),
      dxCurve: loadTable(front.dx),
      // A brush tyre, on the mod's own shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with load
      // (6.3 % per FZ0) and with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the combined-slip exponent
      // [spec COMBINED_FACTOR], the longitudinal stiffness [spec CX_MULT] and the grip lost to sliding speed
      // [spec SPEED_SENSITIVITY]
      curve: 'brush',
      friction_limit_angle: front.frictionLimitAngle,
      peakSlipLoadGain: 0.063,
      peakSlipPressureGain: 0.2,
      combinedExponent: 2.6,
      longStiffnessMult: 1.18,
      speedSensitivity: front.speedSensitivity,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 4.2,
      // Slip ratio at the peak of the drive force: tan(8°) / 1.18 of theoretical slip [derived]
      slip_ratio_limit: 0.135,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [spec FALLOFF_LEVEL, FALLOFF_SPEED]
      use_slip_falloff: true,
      falloff_level: 0.82,
      falloff_slope: 3,
      // [spec RELAXATION_LENGTH]
      relaxationLengthX: 0.11,
      relaxationLengthY: 0.11,
      // 10 N + 0.0000005 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
      rollingResistance: 0.01,
      rollingResistanceSpeedSq: 5e-10,
      // 15 % more at the peak slip, and no more past it [spec ROLLING_RESISTANCE_SLIP]
      rollingResistanceSlipGain: 0.15,
      rollingResistanceSlipMax: 1,
      // [spec DAMP]
      verticalDamping: 500,
      // [spec BRAKE_DX_MOD]
      brakeDxMod: front.brakeDxMod,
    },
    thermalData: {
      // Grip against tread temperature (°C) [spec *tcurve_slicksJGTC*.lut]: a flat curve, 91 % at 0 °C
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]; the graining wears off as the tread slides
      tread: { grainGain, grainGamma: 1, blisterGain: 0.5, blisterGamma: 1, wearOffWithSlip: true },
      // Pressure moves the heat: the sliding heat and the crown against the shoulders, as the 496R's [est], the rolling
      // heat by PRESSURE_RR_GAIN [spec]
      pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
      // The GT3 slick's heat capacities, rolling heat and cooling [est]: the data's own thermal constants are for AC's
      // tyre model, not this one
      surfaceHeatCapacity: 1800,
      coreHeatCapacity: 11000,
      slipHeatShare: 0.35,
      hysteresis: 0.0044,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 80,
    },
    pressureData: {
      // [spec PRESSURE_IDEAL]
      optimalPsi: 27,
      setPsi: setPsiAt(front.staticPsi, blanketC),
      pressureSpringCurve: pressureSpring(front),
      // [spec PRESSURE_RR_GAIN]
      pressureRollingGain: 0.4,
      pressureGripSensitivity: 1.0,
      // 0.35 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
      pressureGripLossPerPsi: 0.0035,
      // Out of the blankets [spec BLANKETS_TEMP, OVERRIDE_BLANKETS_TEMP]
      coldRefC: blanketC,
    },
    camberData: {
      // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]. The data's DCAMBER_LUT (camber_table_*.lut) puts the same 1.037 peak
      // at 4° leaning in, but flatter either side, and nearly flat leaning out (0.997 at 3°); this model takes the
      // quadratic, which drops faster away from the peak
      camberGain: 0.11,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: front.dcamber0,
      dcamber1: front.dcamber1,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    // The 330 mm rear: its own reference load, tables, stiffness and data [spec REAR, REAR_1, REAR_2]
    rearOverride: {
      modelData: {
        Fz0: REAR_FZ0,
        Dy0: muAt(rear.dy, REAR_FZ0),
        Dx0: muAt(rear.dx, REAR_FZ0),
        dyCurve: loadTable(rear.dy),
        dxCurve: loadTable(rear.dx),
        friction_limit_angle: rear.frictionLimitAngle,
        speedSensitivity: rear.speedSensitivity,
        brakeDxMod: rear.brakeDxMod,
      },
      camberData: { dcamber0: rear.dcamber0, dcamber1: rear.dcamber1 },
      pressureData: { setPsi: setPsiAt(rear.staticPsi, blanketC), pressureSpringCurve: pressureSpring(rear) },
    },
  };
}

/** Front and rear axle data per compound [spec tyres.ini FRONT / REAR, FRONT_1 / REAR_1, FRONT_2 / REAR_2] */
const SOFT_DX = [2.05, 1.97, 1.89, 1.81, 1.73, 1.65, 1.58, 1.51, 1.44, 1.38, 1.33, 1.28, 1.24, 1.21, 1.18, 1.15];
const MEDIUM_DY = [2.04, 1.93, 1.83, 1.74, 1.65, 1.57, 1.49, 1.42, 1.36, 1.31, 1.27, 1.23, 1.2, 1.18, 1.17, 1.15];
const MEDIUM_DX = [1.95, 1.88, 1.81, 1.75, 1.7, 1.63, 1.57, 1.51, 1.45, 1.4, 1.35, 1.31, 1.27, 1.23, 1.2, 1.17];
const HARD_DY = [1.96, 1.86, 1.77, 1.69, 1.62, 1.55, 1.48, 1.42, 1.37, 1.32, 1.28, 1.24, 1.21, 1.18, 1.16, 1.14];
const HARD_DX = [1.85, 1.8, 1.75, 1.7, 1.65, 1.6, 1.55, 1.5, 1.45, 1.4, 1.36, 1.32, 1.28, 1.25, 1.22, 1.19];

const AXLES = {
  soft: {
    front: {
      rate: 295_000,
      springGain: 10_650,
      staticPsi: 21,
      dy: [2.18, 2.05, 1.93, 1.82, 1.72, 1.63, 1.55, 1.47, 1.4, 1.34, 1.29, 1.25, 1.22, 1.19, 1.17, 1.15],
      dx: SOFT_DX,
      frictionLimitAngle: 8,
      speedSensitivity: 0.0019,
      brakeDxMod: 0.085,
      dcamber0: 1.105,
      dcamber1: -8.2,
      wear: [[0, 100], [1.4, 98.9], [2.9, 97.6], [4.3, 96.8], [5.8, 96.3], [7.2, 95.8], [8.7, 95.3], [10.1, 94.6], [11.6, 93.5], [13, 91.8], [14.5, 89.6], [16, 87]],
    },
    rear: {
      rate: 290_000,
      springGain: 10_925,
      staticPsi: 20,
      dy: [2.18, 2.06, 1.95, 1.84, 1.74, 1.64, 1.56, 1.48, 1.41, 1.35, 1.3, 1.26, 1.22, 1.19, 1.17, 1.15],
      dx: SOFT_DX,
      frictionLimitAngle: 8,
      speedSensitivity: 0.00185,
      brakeDxMod: 0.075,
      dcamber0: 1.05,
      dcamber1: -8.2,
      wear: [[0, 100], [1.6, 98.9], [3.2, 97.6], [4.8, 96.8], [6.4, 96.3], [8, 95.8], [9.6, 95.3], [11.2, 94.6], [12.8, 93.5], [14.4, 91.8], [16, 89.6], [17.6, 87]],
    },
  },
  medium: {
    front: {
      rate: 289_000,
      springGain: 10_650,
      staticPsi: 21,
      dy: MEDIUM_DY,
      dx: MEDIUM_DX,
      frictionLimitAngle: 8,
      speedSensitivity: 0.0019,
      brakeDxMod: 0.075,
      dcamber0: 1.05,
      dcamber1: -8,
      wear: [[0, 100], [1.8, 98.9], [3.7, 97.6], [5.6, 96.8], [7.5, 96.3], [9.4, 95.8], [11.3, 95.3], [13.2, 94.6], [15.1, 93.5], [17, 91.8], [18.9, 89.6], [20.8, 87]],
    },
    rear: {
      rate: 284_000,
      springGain: 10_900,
      staticPsi: 20,
      dy: MEDIUM_DY,
      dx: MEDIUM_DX,
      frictionLimitAngle: 8,
      speedSensitivity: 0.0019,
      brakeDxMod: 0.075,
      dcamber0: 1.05,
      dcamber1: -8.2,
      wear: [[0, 100], [2, 98.9], [4.1, 97.6], [6.2, 96.8], [8.3, 96.3], [10.4, 95.8], [12.4, 95.3], [14.5, 94.6], [16.6, 93.5], [18.7, 91.8], [20.8, 89.6], [22.8, 87]],
    },
  },
  hard: {
    front: {
      rate: 285_000,
      springGain: 10_650,
      staticPsi: 21,
      dy: HARD_DY,
      dx: HARD_DX,
      frictionLimitAngle: 8,
      speedSensitivity: 0.0019,
      brakeDxMod: 0.075,
      dcamber0: 1.105,
      dcamber1: -8.2,
      wear: [[0, 100], [2.3, 98.9], [4.6, 97.6], [6.9, 96.8], [9.3, 96.3], [11.6, 95.8], [13.9, 95.3], [16.2, 94.6], [18.6, 93.5], [20.9, 91.8], [23.2, 89.6], [25.6, 87]],
    },
    rear: {
      rate: 280_000,
      springGain: 10_900,
      staticPsi: 20,
      dy: HARD_DY,
      dx: HARD_DX,
      frictionLimitAngle: 7.5,
      speedSensitivity: 0.0019,
      brakeDxMod: 0.075,
      dcamber0: 1.05,
      dcamber1: -8.2,
      wear: [[0, 100], [2.5, 98.9], [5.1, 97.6], [7.6, 96.8], [10.2, 96.3], [12.8, 95.8], [15.3, 95.3], [17.9, 94.6], [20.4, 93.5], [23, 91.8], [25.6, 89.6], [28.1, 87]],
    },
  },
} satisfies Record<'soft' | 'medium' | 'hard', { front: AxleTyreData; rear: AxleTyreData }>;

const TYRES = {
  PhysicsTyreCompound_GT3_Soft: slickCompound(
    'PhysicsTyreCompound_GT3_Soft',
    'Slick Soft',
    'S',
    AXLES.soft.front,
    AXLES.soft.rear,
    [[0, 0.9095], [25, 0.9351], [45, 0.9686], [55, 0.9846], [65, 0.9959], [70, 0.9989], [75, 1], [80, 0.9989], [85, 0.9959], [95, 0.9846], [105, 0.9686], [125, 0.93516]],
    [70, 80],
    85,
    0.3
  ),
  PhysicsTyreCompound_GT3_Medium: slickCompound(
    'PhysicsTyreCompound_GT3_Medium',
    'Slick Medium',
    'M',
    AXLES.medium.front,
    AXLES.medium.rear,
    [[0, 0.9093], [30, 0.9397], [50, 0.9717], [60, 0.9862], [70, 0.9963], [75, 0.999], [80, 1], [85, 0.999], [90, 0.9963], [100, 0.9862], [110, 0.9717], [130, 0.9397]],
    [75, 85],
    80,
    0.5
  ),
  PhysicsTyreCompound_GT3_Hard: slickCompound(
    'PhysicsTyreCompound_GT3_Hard',
    'Slick Hard',
    'H',
    AXLES.hard.front,
    AXLES.hard.rear,
    [[0, 0.9098], [35, 0.9448], [55, 0.9749], [65, 0.9879], [75, 0.9968], [80, 0.9992], [85, 1], [90, 0.9992], [95, 0.9968], [105, 0.9879], [115, 0.9749], [135, 0.9448]],
    [80, 90],
    70,
    0.5
  ),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/**
 * A rain tyre on the medium's carcass, as the GT3's [est]: the data has no treaded tyre. Its set pressure is left to
 * the model (the one that reaches the ideal in its cooler window), not the slick's
 */
const rain = (kind: 'intermediate' | 'wet', compound: PhysicsTyreCompound, name: string): TyresCompoundData => {
  const t = deriveRainCompound(TYRES.PhysicsTyreCompound_GT3_Medium, kind, compound, name);
  return {
    ...t,
    pressureData: { ...t.pressureData, setPsi: undefined },
    rearOverride: { ...t.rearOverride, pressureData: { ...t.rearOverride?.pressureData, setPsi: undefined } },
  };
};

const TYRES_WITH_RAIN = {
  ...TYRES,
  PhysicsTyreCompound_GT3_Intermediate: rain('intermediate', 'PhysicsTyreCompound_GT3_Intermediate', 'Intermediate'),
  PhysicsTyreCompound_GT3_Wet: rain('wet', 'PhysicsTyreCompound_GT3_Wet', 'Wet'),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Equivalent box 1.885 × 1.28 × 4.675 m [spec car.ini INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const NISSAN_R33_CONFIG = {
  screenName: 'Nissan Skyline GT-R BCNR33 JGTC',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: FRONT_WEIGHT,
    // [spec WHEELBASE, TRACK]
    wheelbase: WHEELBASE,
    trackWidthFront: 1.56,
    trackWidthRear: 1.535,
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(1.28, 4.675), roll: box(1.885, 1.28), yaw: box(1.885, 4.675) },
    // [spec HUB_MASS]
    unsprungMassFront: FRONT_HUB_KG,
    unsprungMassRear: REAR_HUB_KG,
    // The tank sits 1.78 m behind the CG and 0.06 m below it [spec FUELTANK POSITION]
    fuelTank: { y: -0.062, z: -1.783 },
    // [spec tyres.ini ANGULAR_INERTIA]
    wheelInertiaFront: 2.21,
    wheelInertiaRear: 2.16,
    // 250° lock each way on a 15:1 rack [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 250 / 15,
    // The kingpin (WBTYRE_BOTTOM → WBTYRE_TOP) stands upright in side view, 14 mm ahead of the axle: 14 mm of trail [derived]
    ffbMechanicalTrailM: 0.0144,
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 1000 Nm clutch; the auto clutch bites at 2300 rpm and closes by 2900 [spec CLUTCH, AUTOCLUTCH]
  clutch: { maxTorqueNm: 1000, biteRpm: 2300, lockRpm: 2900 },
  // Locking torque = preload + POWER / COAST × input torque [spec DIFFERENTIAL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.4, coast: 0.4, preload: 150, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // 3500 Nm at full pedal, 59 % front, bias adjustable in 0.5 % steps; the pads' grip is 97 % cold, 100 % from 400 to
  // 600 °C, 90 % at 1200 (the same curve front and rear) [spec brakes.ini]
  brakes: {
    maxTorqueNm: 3500,
    front_bias: 0.59,
    ebbStep: 0.005,
    brakeByWire: false,
    discMaterial: 'endurance-steel',
    padMuCurve: [[0, 0.97], [200, 0.99], [400, 1], [600, 1], [800, 0.98], [1000, 0.96], [1200, 0.9]],
    migration: { amount: 0, rampStart: 0 },
  },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: TYRES_WITH_RAIN,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_GT3_Soft',
    medium: 'PhysicsTyreCompound_GT3_Medium',
    hard: 'PhysicsTyreCompound_GT3_Hard',
    intermediate: 'PhysicsTyreCompound_GT3_Intermediate',
    wet: 'PhysicsTyreCompound_GT3_Wet',
  },
} satisfies CarPhysicsConfig;

/**
 * ABS is fitted, off by default (PRESENT=1, ACTIVE=0), at 12 % lock slip cycling at 250 Hz; its switch positions are
 * 9, 10, 11, 12, 14 and 16 % [spec electronics.ini, abs.lut], all on this table. The car has no traction control
 * (PRESENT=0): the TC table is the GT3's around the data's dormant 10 % / 140 Hz / 50 km/h, for the assisted preset only
 * [spec SLIP_RATIO_LIMIT, RATE_HZ, MIN_SPEED_KMH; est table].
 */
export const NISSAN_R33_ELECTRONICS = {
  absLevels: [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17],
  absDefault: 0.12,
  absRateHz: 250,
  tcLevels: [0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19],
  tcDefault: 0.1,
  tcRateHz: 140,
  tcMinSpeedKmh: 50,
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
