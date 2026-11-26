/**
 * F1 2007 vehicle data for `VehiclePhysics` (same data model as the f12026-car, see `F12026CarConfig`): a 2007 Formula
 * 1 car, a 2.4 L V8 revving to 19 000 rpm behind the driver, a seven-speed paddle-shift gearbox and rear-wheel drive.
 *
 * The numbers come from Cimmerian Iter's F1 2007 for Assetto Corsa (used with the author's permission), from the Ferrari
 * F2007's data. The mod's eleven team cars share one engine, gearbox, tyre, brake, aero and setup data set (the files
 * differ only by blank lines); only their wheelbases, tracks and CG positions differ, so one profile serves every team.
 * Mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics / setup); the file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * No turbo, hybrid or DRS. Traction control, still legal in 2007, is on (electronics.ini TC PRESENT=1); there is no
 * ABS (PRESENT=0). Double wishbones at both ends with a third (heave) spring on each axle, four dry Bridgestone
 * compounds (three of them in the garage's slots, see `TYRES`) and seven aero elements: the front and rear wings on
 * their setup positions, the body's drag, and the floor at each end as one element that reads the body's pitch and one
 * that reads its ground height.
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
import { NUZZI_RAIN_TYRE_DESIGN } from '../wet-tyres';
import { modBodyHeightM, modCornerStops } from '../mod-suspension';

/** Driveline efficiency of this model; the wheel torque curve is divided by it for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/**
 * Torque after the driveline (rpm → Nm) [spec power.lut]: 289 Nm at 17 000 rpm, 270 at the 19 000 rpm limiter, falling
 * to nothing by 20 000
 */
const WHEEL_TORQUE: [number, number][] = [
  [0, 100],
  [1000, 109],
  [2000, 109],
  [3000, 93],
  [4000, 98],
  [5000, 115],
  [6000, 124],
  [7000, 156],
  [8000, 183],
  [9000, 200],
  [10000, 210],
  [11000, 225],
  [12000, 230],
  [13000, 240],
  [14000, 254],
  [15000, 260],
  [16000, 281],
  [17000, 289],
  [17500, 285],
  [18000, 282],
  [18500, 275],
  [19000, 270],
  [19500, 100],
  [20000, 0],
];

/** Crank power (kW): ≈ 584 kW (783 hp) at the 19 000 rpm limiter, ≈ 537 kW of it at the wheels [derived] */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [
  rpm,
  Number((((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000).toFixed(3)),
]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque from nothing at the 4000 rpm idle to 130 Nm at 19 000 rpm, straight on past it [spec engine.ini
  // COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [4000, 0],
    [19000, 130],
    [20000, 138.667],
  ] as LutPoints,
  // Pedal → throttle, a straight line [spec throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ] as LutPoints,
  // Throttle slides and intake filling, as the 496R's [est]
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  // [spec MINIMUM]
  idleRpm: 4000,
  // Engine 0.035 + gearbox 0.01 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.045,
  // 100 Hz limiter: the cut lasts one cycle [spec LIMITER_HZ]
  limiterCutS: 1 / 100,
  // A tenth of a change in air density reaches the torque [spec ALTITUDE_SENSITIVITY]
  airDensitySensitivity: 0.1,
};

const NONE: LutPoints = [
  [0, 0],
  [20000, 0],
];

/** No hybrid (KERS came in 2009). The store holds 1 J only so the state-of-charge maths stays finite. */
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
 * Seven speeds on a 5.7 final drive [spec drivetrain.ini GEARS]: at the 19 000 rpm limiter ≈ 135 / 164 / 199 / 230 / 257
 * / 284 / 317 km/h on the tyres' 0.33 m radius (a little more as they grow with speed). The setup's other ratios
 * (first.rto … final.rto) are not offered. An up-shift is 20 ms between gears with the spark cut for 25 ms [spec
 * CHANGE_UP_TIME, AUTO_CUTOFF_TIME]
 */
const GEARBOX = {
  ratios: [3.073, 2.536, 2.084, 1.799, 1.611, 1.461, 1.31],
  // [spec GEAR_R −4]
  reverse: 4,
  finalDrive: 5.7,
  // The longer of the change and the cut [spec CHANGE_UP_TIME, AUTO_CUTOFF_TIME]
  shiftTimeS: 0.025,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.03,
  // As the 496R's [est]
  shiftTorqueFraction: 0.1,
  upshiftNeutralS: 0.02,
  upshiftCutS: 0.025,
  // Down: 30 ms between gears with the control unit's 75 % blip, risen in 2 ms; the clutch let out from 15 ms and home at
  // 30 [spec CHANGE_DN_TIME, DOWNSHIFT_PROFILE, AUTOBLIP (ELECTRONIC=1, LEVEL 0.75)]; the down-shift protection takes a
  // gear that lands up to 1200 rpm over the limiter [spec DOWNSHIFT_PROTECTION OVERREV]
  downshift: { neutralS: 0.03, clutchReleaseS: 0.015, clutchHomeS: 0.03, blip: { level: 0.75, riseS: 0.002 }, overRevRpm: 1200 },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 19000,
    // [spec AUTO_SHIFTER UP, DOWN]: the power peaks at the limiter, so up at 18 800 (ai.ini's 17 800 / 14 500 are the
    // AI's own, not used)
    upshift_rpm: 18800,
    downshift_rpm: 13000,
    // Into a braking zone the auto box clicks down while the lower gear lands under 18 000 rpm [est]
    brake_downshift_rpm: 18000,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

/** With the driver, no fuel [spec car.ini TOTALMASS]. BMW Sauber's data says 605 kg, the other ten 680: the Ferrari's here */
const MASS = 680;
const WHEELBASE = 3.131;
/** Share of the sprung weight on the front axle [spec CG_LOCATION] */
const FRONT_WEIGHT = 0.46;
/** Hub masses [spec HUB_MASS] */
const FRONT_HUB_KG = 27;
const REAR_HUB_KG = 33;
/** Sprung load on a front / rear corner at static ride (N): the car less its hubs [derived] */
const SPRUNG_KG = MASS - 2 * FRONT_HUB_KG - 2 * REAR_HUB_KG;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * FRONT_WEIGHT) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * (1 - FRONT_WEIGHT)) / 2;
/**
 * The first tyre set's (the Super Soft's) radial rate at its 21 psi ideal (N/m): RATE at the 16 psi static pressure +
 * PRESSURE_SPRING_GAIN per psi [spec tyres.ini FRONT / REAR]. The other compounds' are within 3 %: under 0.1 mm of ride
 */
const HOT_FRONT_TYRE_RATE = 264_521 + 12_100 * (21 - 16);
const HOT_REAR_TYRE_RATE = 278_443 + 12_800 * (21 - 16);
/**
 * The mod measures its stops from the suspension's design position, with the corner springs and the axle's heave spring
 * working on their rod lengths (`mod-suspension.ts`): at static ride the fronts hang 4.7 mm and the rears 8.6 mm below
 * it, so the stops are these far from static [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN, HEAVE_*; derived]
 */
const FRONT_STOPS = modCornerStops({
  staticLoadN: FRONT_STATIC_LOAD_N,
  springRate: 180_000,
  rodLength: 0.01,
  packerRange: 0.03,
  bumpStopUp: 0.035,
  bumpStopDn: 0.02,
  heave: { springRate: 120_000, rodLength: 0.01, packerRange: 0.04, bumpStopUp: 0.04 },
});
const REAR_STOPS = modCornerStops({
  staticLoadN: REAR_STATIC_LOAD_N,
  springRate: 80_000,
  rodLength: 0.02,
  packerRange: 0.065,
  bumpStopUp: 0.04,
  bumpStopDn: 0.025,
  heave: { springRate: 100_000, rodLength: 0.02, packerRange: 0.04, bumpStopUp: 0.04 },
});
const mm = (m: number) => Number(m.toFixed(4));

/**
 * Double wishbones at both ends with the mod's wheel rates, anti-roll bars, heave springs, bump stops, packers and
 * dampers [spec suspensions.ini], the stops at their distance from static ride (above). The fronts reach their packers
 * after 25 mm of bump and their bump stops after 40; the rears their bump stops after 49 and their packers after 54;
 * the heave springs' packers engage after 35 mm (front) and 29 mm (rear) of heave. The front bar is 6.5 times the
 * rear's (130 against 20 kN/m). Hardpoints are [x inboard, y up, z forward] from the wheel centre [spec]; camber gain
 * and roll-centre heights are what the kinematic solver gives on them at static [derived]: −7.4° of camber per metre of
 * bump at the front and −23.2 at the rear, roll centres 24 mm and 66 mm up. The rods are push rods, as the 2007 cars'
 * were [est]; the dampers are single-stage (their fast thresholds are 1 m/s) and the heave elements have none [spec].
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -3.2,
    camberGainKinematic: -7.4,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 180_000, helper_rate: 0, helper_range: 0 },
    // [spec HEAVE_FRONT SPRING_RATE, PACKER_RANGE, BUMP_STOP_RATE]: its packers come before its own bump stop
    heave: { rate: 120_000, gap: 0, packerGap: mm(FRONT_STOPS.heavePackerGapM), packerRate: 80_000, progressiveRate: 0 },
    // The packers first, then the bump stop, both at BUMP_STOP_RATE [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(FRONT_STOPS.packerGapM), rate: 80_000, progression: 0, hardStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 80_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.0245,
    // [spec ARB FRONT]
    arb: 130_000,
    hardpoints: [
      [0.6759, 0.0712, -0.022],
      [0.6764, 0.0675, -0.4856],
      [0.7054, -0.1473, 0.0125],
      [0.7049, -0.1435, -0.425],
      [0.1097, 0.0818, -0.0228],
      [0.0754, -0.1548, 0.002],
      [0.6764, 0.0678, 0.03],
      [0.10651, 0.0782, 0.025],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -2,
    camberGainKinematic: -23.2,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 80_000, helper_rate: 0, helper_range: 0 },
    // [spec HEAVE_REAR SPRING_RATE, PACKER_RANGE, BUMP_STOP_RATE]
    heave: { rate: 100_000, gap: 0, packerGap: mm(REAR_STOPS.heavePackerGapM), packerRate: 80_000, progressiveRate: 0 },
    // The bump stop first, then the packers, both at BUMP_STOP_RATE [spec BUMPSTOP_UP, PACKER_RANGE, BUMP_STOP_RATE]
    bumpStop: { range: mm(REAR_STOPS.bumpStopGapM), rate: 80_000, progression: 0, hardStop: { range: mm(REAR_STOPS.packerGapM), rate: 80_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: 0.0657,
    // [spec ARB REAR]
    arb: 20_000,
    hardpoints: [
      [0.6525, 0.0766, 0.4],
      [0.652, 0.0796, -0.105],
      [0.68, -0.1006, 0.52],
      [0.6843, -0.1021, -0.1],
      [0.1724, 0.1182, -0.07],
      [0.1358, -0.1085, -0.02],
      [0.6744, -0.0463, -0.18],
      [0.1473, -0.0373, -0.15],
    ],
  },
  dampers_controller: {
    front: {
      // [spec DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND, DAMP_FAST_*THRESHOLD; HEAVE_FRONT DAMP_* 0]
      base: damper(7290, 7290, 7790, 7790),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 1,
      fastReboundThresholdMs: 1,
      heaveFastThresholdMs: 1,
      heaveFastReboundThresholdMs: 1,
    },
    rear: {
      base: damper(6330, 6330, 6698, 6698),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 1,
      fastReboundThresholdMs: 1,
      heaveFastThresholdMs: 1,
      heaveFastReboundThresholdMs: 1,
    },
  },
};

/** Tyre radius, every compound [spec tyres.ini RADIUS] */
const TYRE_RADIUS = 0.33;
/** Ride-height pickups 0.22 m below the CG's level, front and rear [spec car.ini RIDE] */
const PICKUP_Y = -0.22;
/**
 * The body's height at each axle is the tyre's loaded radius less the wheel centre's height in the body frame (BASEY
 * 0.087 / 0.046 above the CG's level, plus the static offset): 0.243 m at the front, 0.287 m at the rear, so the CG, 46 %
 * of the weight forward, rides 0.267 m up [spec BASEY, RADIUS; derived]. The pickups ride 23.5 mm (front) and 66.9 mm
 * (rear) off the ground at rest: a 43 mm rake, 0.79° nose down.
 */
const FRONT_BODY_HEIGHT = modBodyHeightM(TYRE_RADIUS, (FRONT_STATIC_LOAD_N + FRONT_HUB_KG * 9.81) / HOT_FRONT_TYRE_RATE, 0.0865519890719754, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(TYRE_RADIUS, (REAR_STATIC_LOAD_N + REAR_HUB_KG * 9.81) / HOT_REAR_TYRE_RATE, 0.0464494393655868, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * (1 - FRONT_WEIGHT)).toFixed(4));
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT + PICKUP_Y).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT + PICKUP_Y).toFixed(4));
/** The body's pitch at rest (deg, + nose down) [derived] */
const STATIC_RAKE_DEG = (Math.asin((REAR_TARGET_HEIGHT - FRONT_TARGET_HEIGHT) / WHEELBASE) * 180) / Math.PI;

// ---------------------------------------------------------------------------
// Aero tables [spec aero.ini, the *.lut files], all at CL_GAIN / CD_GAIN 1 and CHORD × SPAN 1 m²
// ---------------------------------------------------------------------------

/**
 * The wings' lift and drag against their setup position, 0–100 (the tables' "angle" axis is the setup's scale, not
 * degrees) [spec FWCL.lut, FWCD.lut, RWCL.lut, RWCD.lut]: every fifth point of the tables, which are smooth enough that
 * the points between stay within 1e-4 of them
 */
const FW_CL: LutPoints = [
  [-2, 0.2942], [-1, 0.2971], [0, 0.3], [5, 0.3144], [10, 0.3286], [15, 0.3426],
  [20, 0.3564], [25, 0.37], [30, 0.3834], [35, 0.3966], [40, 0.4096], [45, 0.4224],
  [50, 0.435], [55, 0.4474], [60, 0.4596], [65, 0.4716], [70, 0.4834], [75, 0.495],
  [80, 0.5064], [85, 0.5176], [90, 0.5286], [95, 0.5394], [100, 0.55], [101, 0.5521],
];

const FW_CD: LutPoints = [
  [-2, 0.1768], [-1, 0.1784], [0, 0.18], [5, 0.1881], [10, 0.1962], [15, 0.2045],
  [20, 0.2128], [25, 0.2213], [30, 0.2298], [35, 0.2385], [40, 0.2472], [45, 0.2561],
  [50, 0.265], [55, 0.2741], [60, 0.2832], [65, 0.2925], [70, 0.3018], [75, 0.3113],
  [80, 0.3208], [85, 0.3305], [90, 0.3402], [95, 0.3501], [100, 0.36], [101, 0.362],
];

const RW_CL: LutPoints = [
  [-2, 0.2025], [-1, 0.2062], [0, 0.21], [5, 0.2294], [10, 0.2496], [15, 0.2706],
  [20, 0.2924], [25, 0.315], [30, 0.3384], [35, 0.3626], [40, 0.3876], [45, 0.4134],
  [50, 0.44], [55, 0.4674], [60, 0.4956], [65, 0.5246], [70, 0.5544], [75, 0.585],
  [80, 0.6164], [85, 0.6486], [90, 0.6816], [95, 0.7154], [100, 0.75], [101, 0.757],
];

const RW_CD: LutPoints = [
  [-2, 0.0904], [-1, 0.0952], [0, 0.1], [5, 0.1237], [10, 0.1468], [15, 0.1693],
  [20, 0.1912], [25, 0.2125], [30, 0.2332], [35, 0.2533], [40, 0.2728], [45, 0.2917],
  [50, 0.31], [55, 0.3277], [60, 0.3448], [65, 0.3613], [70, 0.3772], [75, 0.3925],
  [80, 0.4072], [85, 0.4213], [90, 0.4348], [95, 0.4477], [100, 0.46], [101, 0.4624],
];
/**
 * The floor's lift against the body's pitch (deg, + nose down), ±3°, 0 at rest: the front's (no drag) and the rear's
 * with its drag, which goes negative nose down [spec FRONTAOACL.lut, REARAOACL.lut, REARAOACD.lut]
 */
const FRONT_PITCH_CL: LutPoints = [
  [-3, -0.8], [-2.90164, -0.8], [-2.80328, -0.8], [-2.70492, -0.8], [-2.60656, -0.8],
  [-2.5082, -0.8], [-2.40984, -0.8], [-2.31148, -0.8], [-2.21311, -0.8], [-2.11475, -0.8],
  [-2.01639, -0.8], [-1.91803, -0.8], [-1.81967, -0.8], [-1.72131, -0.8], [-1.62295, -0.8],
  [-1.52459, -0.8], [-1.42623, -0.8], [-1.32787, -0.8], [-1.22951, -0.8], [-1.13115, -0.8],
  [-1.03279, -0.8], [-0.93443, -0.72419], [-0.83607, -0.64565], [-0.7377, -0.57137], [-0.63934, -0.50117],
  [-0.54098, -0.4349], [-0.44262, -0.37235], [-0.34426, -0.31337], [-0.2459, -0.25778], [-0.14754, -0.20539],
  [-0.04918, -0.15604], [0.04918, -0.10955], [0.14754, -0.06574], [0.2459, -0.02444], [0.34426, 0.01453],
  [0.44262, 0.05135], [0.54098, 0.08618], [0.63934, 0.11921], [0.7377, 0.15061], [0.83607, 0.18056],
  [0.93443, 0.20923], [1.03279, 0.2368], [1.13115, 0.26344], [1.22951, 0.28934], [1.32787, 0.31466],
  [1.42623, 0.33958], [1.52459, 0.36427], [1.62295, 0.38892], [1.72131, 0.4137], [1.81967, 0.43878],
  [1.91803, 0.46434], [2.01639, 0.49056], [2.11475, 0.51761], [2.21311, 0.54567], [2.31148, 0.5749],
  [2.40984, 0.6055], [2.5082, 0.63763], [2.60656, 0.67147], [2.70492, 0.7072], [2.80328, 0.74498],
  [2.90164, 0.78501],
];

const REAR_PITCH_CL: LutPoints = [
  [-3, -0.8], [-2.90164, -0.8], [-2.80328, -0.8], [-2.70492, -0.8], [-2.60656, -0.8],
  [-2.5082, -0.8], [-2.40984, -0.8], [-2.31148, -0.8], [-2.21311, -0.8], [-2.11475, -0.8],
  [-2.01639, -0.8], [-1.91803, -0.8], [-1.81967, -0.73093], [-1.72131, -0.65346], [-1.62295, -0.58172],
  [-1.52459, -0.51547], [-1.42623, -0.45445], [-1.32787, -0.39841], [-1.22951, -0.34708], [-1.13115, -0.30021],
  [-1.03279, -0.25754], [-0.93443, -0.21882], [-0.83607, -0.1838], [-0.7377, -0.15221], [-0.63934, -0.1238],
  [-0.54098, -0.09832], [-0.44262, -0.07551], [-0.34426, -0.05511], [-0.2459, -0.03686], [-0.14754, -0.02052],
  [-0.04918, -0.00582], [0.04918, 0.00748], [0.14754, 0.01966], [0.2459, 0.03096], [0.34426, 0.04164],
  [0.44262, 0.05195], [0.54098, 0.06215], [0.63934, 0.0725], [0.7377, 0.08325], [0.83607, 0.09466],
  [0.93443, 0.10699], [1.03279, 0.12048], [1.13115, 0.13541], [1.22951, 0.15201], [1.32787, 0.17055],
  [1.42623, 0.19129], [1.52459, 0.21448], [1.62295, 0.24037], [1.72131, 0.26923], [1.81967, 0.3013],
  [1.91803, 0.33685], [2.01639, 0.37613], [2.11475, 0.4194], [2.21311, 0.46691], [2.31148, 0.51891],
  [2.40984, 0.57567], [2.5082, 0.63744], [2.60656, 0.70447], [2.70492, 0.77703], [2.80328, 0.85537],
  [2.90164, 0.93973],
];

const REAR_PITCH_CD: LutPoints = [
  [-3, 3.66807], [-2.90164, 3.3896], [-2.80328, 3.12549], [-2.70492, 2.87538], [-2.60656, 2.63887],
  [-2.5082, 2.41558], [-2.40984, 2.20513], [-2.31148, 2.00713], [-2.21311, 1.82119], [-2.11475, 1.64694],
  [-2.01639, 1.48399], [-1.91803, 1.33194], [-1.81967, 1.19043], [-1.72131, 1.05905], [-1.62295, 0.93744],
  [-1.52459, 0.8252], [-1.42623, 0.72194], [-1.32787, 0.6273], [-1.22951, 0.54087], [-1.13115, 0.46227],
  [-1.03279, 0.39113], [-0.93443, 0.32705], [-0.83607, 0.26966], [-0.7377, 0.21856], [-0.63934, 0.17337],
  [-0.54098, 0.1337], [-0.44262, 0.09918], [-0.34426, 0.06942], [-0.2459, 0.04403], [-0.14754, 0.02263],
  [-0.04918, 0.00483], [0.04918, -0.00975], [0.14754, -0.02149], [0.2459, -0.03079], [0.34426, -0.03802],
  [0.44262, -0.04357], [0.54098, -0.04783], [0.63934, -0.05117], [0.7377, -0.05399], [0.83607, -0.05667],
  [0.93443, -0.05959], [1.03279, -0.06314], [1.13115, -0.06771], [1.22951, -0.07367], [1.32787, -0.08141],
  [1.42623, -0.09132], [1.52459, -0.10378], [1.62295, -0.11917], [1.72131, -0.13789], [1.81967, -0.16031],
  [1.91803, -0.18682], [2.01639, -0.21781], [2.11475, -0.25366], [2.21311, -0.29475], [2.31148, -0.34147],
  [2.40984, -0.3942], [2.5082, -0.45334], [2.60656, -0.51925], [2.70492, -0.59233], [2.80328, -0.67297],
  [2.90164, -0.76154],
];
/**
 * The floor's lift against the pickup's ground clearance (m) at its axle: nothing on the ground, then the front's from
 * 1.22 at 5 mm down to 0.79 at 50 mm, the rear's 1.68 at 5 mm, 1.73 at 26 mm and 1.12 at 100 mm, and the rear's drag
 * [spec FRONTGHCL.lut, REARGHCL.lut, REARGHCD.lut]
 */
const FRONT_GH_CL: LutPoints = [
  [0, 0], [0.005, 1.21949], [0.00576, 1.2111], [0.00653, 1.20275], [0.00729, 1.19444],
  [0.00805, 1.18616], [0.00881, 1.17793], [0.00958, 1.16974], [0.01034, 1.16159], [0.0111, 1.15347],
  [0.01186, 1.1454], [0.01263, 1.13736], [0.01339, 1.12936], [0.01415, 1.12141], [0.01492, 1.11349],
  [0.01568, 1.10561], [0.01644, 1.09777], [0.0172, 1.08997], [0.01797, 1.08221], [0.01873, 1.07449],
  [0.01949, 1.06681], [0.02025, 1.05917], [0.02102, 1.05157], [0.02178, 1.044], [0.02254, 1.03648],
  [0.02331, 1.029], [0.02407, 1.02155], [0.02483, 1.01415], [0.02559, 1.00678], [0.02636, 0.99945],
  [0.02712, 0.99216], [0.02788, 0.98492], [0.02864, 0.97771], [0.02941, 0.97054], [0.03017, 0.96341],
  [0.03093, 0.95632], [0.03169, 0.94927], [0.03246, 0.94225], [0.03322, 0.93528], [0.03398, 0.92835],
  [0.03475, 0.92145], [0.03551, 0.9146], [0.03627, 0.90778], [0.03703, 0.90101], [0.0378, 0.89427],
  [0.03856, 0.88758], [0.03932, 0.88092], [0.04008, 0.8743], [0.04085, 0.86772], [0.04161, 0.86118],
  [0.04237, 0.85468], [0.04314, 0.84822], [0.0439, 0.8418], [0.04466, 0.83542], [0.04542, 0.82907],
  [0.04619, 0.82277], [0.04695, 0.81651], [0.04771, 0.81028], [0.04847, 0.8041], [0.04924, 0.79795],
  [0.05, 0.79185],
];

const REAR_GH_CL: LutPoints = [
  [0, 0], [0.005, 1.6822], [0.00661, 1.68942], [0.00822, 1.69606], [0.00983, 1.70212],
  [0.01144, 1.7076], [0.01305, 1.7125], [0.01466, 1.71682], [0.01627, 1.72056], [0.01788, 1.72372],
  [0.01949, 1.7263], [0.0211, 1.7283], [0.02271, 1.72972], [0.02432, 1.73056], [0.02593, 1.73082],
  [0.02754, 1.7305], [0.02915, 1.7296], [0.03076, 1.72812], [0.03237, 1.72606], [0.03398, 1.72342],
  [0.03559, 1.7202], [0.0372, 1.71639], [0.03881, 1.71201], [0.04042, 1.70705], [0.04203, 1.70151],
  [0.04364, 1.69539], [0.04525, 1.68868], [0.04686, 1.6814], [0.04847, 1.67354], [0.05008, 1.6651],
  [0.05169, 1.65607], [0.05331, 1.64647], [0.05492, 1.63629], [0.05653, 1.62552], [0.05814, 1.61418],
  [0.05975, 1.60226], [0.06136, 1.58975], [0.06297, 1.57667], [0.06458, 1.56301], [0.06619, 1.54876],
  [0.0678, 1.53394], [0.06941, 1.51853], [0.07102, 1.50255], [0.07263, 1.48598], [0.07424, 1.46884],
  [0.07585, 1.45111], [0.07746, 1.43281], [0.07907, 1.41392], [0.08068, 1.39446], [0.08229, 1.37441],
  [0.0839, 1.35379], [0.08551, 1.33258], [0.08712, 1.31079], [0.08873, 1.28843], [0.09034, 1.26548],
  [0.09195, 1.24195], [0.09356, 1.21785], [0.09517, 1.19316], [0.09678, 1.16789], [0.09839, 1.14205],
  [0.1, 1.11562],
];

const REAR_GH_CD: LutPoints = [
  [0, 0.05687], [0.005, 0.07482], [0.00661, 0.08035], [0.00822, 0.08576], [0.00983, 0.09104],
  [0.01144, 0.0962], [0.01305, 0.10124], [0.01466, 0.10615], [0.01627, 0.11094], [0.01788, 0.11561],
  [0.01949, 0.12016], [0.0211, 0.12458], [0.02271, 0.12888], [0.02432, 0.13306], [0.02593, 0.13711],
  [0.02754, 0.14104], [0.02915, 0.14485], [0.03076, 0.14854], [0.03237, 0.1521], [0.03398, 0.15554],
  [0.03559, 0.15886], [0.0372, 0.16205], [0.03881, 0.16513], [0.04042, 0.16807], [0.04203, 0.1709],
  [0.04364, 0.1736], [0.04525, 0.17618], [0.04686, 0.17864], [0.04847, 0.18098], [0.05008, 0.18319],
  [0.05169, 0.18528], [0.05331, 0.18724], [0.05492, 0.18909], [0.05653, 0.19081], [0.05814, 0.1924],
  [0.05975, 0.19388], [0.06136, 0.19523], [0.06297, 0.19646], [0.06458, 0.19757], [0.06619, 0.19855],
  [0.0678, 0.19941], [0.06941, 0.20015], [0.07102, 0.20076], [0.07263, 0.20125], [0.07424, 0.20162],
  [0.07585, 0.20187], [0.07746, 0.20199], [0.07907, 0.20199], [0.08068, 0.20187], [0.08229, 0.20163],
  [0.0839, 0.20126], [0.08551, 0.20077], [0.08712, 0.20015], [0.08873, 0.19942], [0.09034, 0.19856],
  [0.09195, 0.19757], [0.09356, 0.19647], [0.09517, 0.19524], [0.09678, 0.19389], [0.09839, 0.19242],
  [0.1, 0.19082],
];

/** A table moved along its axis */
const shiftX = (lut: LutPoints, dx: number): LutPoints => lut.map(([x, v]) => [Number((x + dx).toFixed(5)), v]);
/**
 * The data's pitch tables read 0 with the body at rest; this model's floor elements read the body's whole pitch, rake
 * included, so the tables move by the static rake (as the 496R's diffuser and the GT3's do)
 */
const toRake = (lut: LutPoints): LutPoints => shiftX(lut, STATIC_RAKE_DEG);
/** YAW_CL_GAIN as a table: CL × (1 + gain · |yaw| in radians), at the slide angles the car meets (|deg| → ×) [spec, derived] */
const yawTable = (yawGain: number): LutPoints =>
  [0, 2, 5, 10, 20, 30].map((deg) => [deg, Number(Math.max(0, 1 + (yawGain * deg * Math.PI) / 180).toFixed(4))]);
/** A table that is 1 (or 0) whatever its input [spec Neutral.lut, or CD_GAIN 0] */
const ONE: LutPoints = [
  [-10, 1],
  [10, 1],
];
const ZERO: LutPoints = [
  [-10, 0],
  [10, 0],
];

/** The body's drag: CD 0.54 at every pitch (its table is flat) on 1 m², no lift (BODYCL.lut is 0) [spec WING_0] */
const BODY_CDA = 0.54;

/**
 * The front wing (45 of 100) and the rear wing (60 of 100) [spec WING_1, WING_2 ANGLE]; the garage's aero packages move
 * them in the setup's steps of 5 (front) and 10 (rear) [spec setup.ini WING_1, WING_2]. Their lift and drag change by
 * under 0.3 % per degree of pitch, which this model adds to the position as the data does.
 */
const wing = (name: 'FRONT_WING' | 'REAR_WING', positionZ: number, angleDeg: number, cl: LutPoints, cd: LutPoints, dragY: number): WingData => ({
  name,
  area: 1,
  positionZ,
  angleDeg,
  heightRef: name === 'FRONT_WING' ? 'front' : 'rear',
  lutAOA_CL: cl,
  lutAOA_CD: cd,
  // [spec LUT_GH_* Neutral.lut]
  lutGH_CL_mult: ONE,
  lutGH_CD_mult: ONE,
  // [spec YAW_CL_GAIN −0.2]
  lutYaw_CL_mult: yawTable(-0.2),
  dragY,
});

/**
 * One end of the floor as two elements, as the data has it: one reads the body's pitch (its tables move by the static
 * rake, above) and one the pickup's ground clearance at its axle. Both sit level with the pickups (POSITION y −0.22, as
 * PICKUP_*_HEIGHT), so the ground-height tables read the pickups' clearance as they are [spec WING_3–6]
 */
const floor = (
  heightRef: 'front' | 'rear',
  positionZ: number,
  pitch: { cl: LutPoints; cd: LutPoints },
  ground: { cl: LutPoints; cd: LutPoints; cdGain: number; yawGain: number },
): WingData[] => [
  {
    name: 'VENTURI_FLOOR',
    area: 1,
    positionZ,
    angleDeg: 0,
    heightRef,
    lutAOA_CL: toRake(pitch.cl),
    lutAOA_CD: toRake(pitch.cd),
    lutGH_CL_mult: ONE,
    lutGH_CD_mult: ONE,
    // [spec YAW_CL_GAIN 0]
    lutYaw_CL_mult: yawTable(0),
    dragY: PICKUP_Y,
  },
  {
    name: 'VENTURI_FLOOR',
    area: 1,
    positionZ,
    angleDeg: 0,
    heightRef,
    // A lift of 1 × the ground-height table [spec LUT_AOA_CL Neutral.lut, CL_GAIN 1]
    lutAOA_CL: ONE,
    // The front's has no drag (CD_GAIN 0); the rear's is 1 × its ground-height table [spec LUT_AOA_CD Neutral.lut, CD_GAIN]
    lutAOA_CD: ground.cdGain ? ONE : ZERO,
    lutGH_CL_mult: ground.cl,
    lutGH_CD_mult: ground.cd,
    lutYaw_CL_mult: yawTable(ground.yawGain),
    dragY: PICKUP_Y,
  },
];

/**
 * Seven elements [spec aero.ini]. At rest (pickups 23.5 / 66.9 mm up, the wings on 45 / 60) CL·A ≈ 3.36 m², 42 % of it
 * on the front axle, for CD·A ≈ 1.34 m²:
 *  - front wing 2.41 m ahead of the CG (0.71 m ahead of the front axle): CL·A 0.42, CD·A 0.26;
 *  - rear wing 1.60 m behind (0.15 m behind the rear axle): CL·A 0.50, CD·A 0.34;
 *  - front floor 1.71 m ahead: −0.13 from its pitch table at rest, 1.03 from its ground-height table (1.22 at 5 mm,
 *    0.79 at 50 mm, nothing on the ground);
 *  - rear floor 1.40 m behind: ≈ 0 from its pitch table, 1.54 from its ground-height table (1.73 at 26 mm, 1.12 at
 *    100 mm), which also drags 0.20 m² (0.06 on the ground);
 *  - the body's 0.54 m² of drag.
 * Nose down, the pitch tables add front and rear downforce and take drag off (0.48 m² of CL·A more and 0.06 m² less CD·A
 * at 1° of extra rake); as the car settles at speed the front floor gains and the rear floor first gains, then loses
 * past its 26 mm peak.
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: BODY_CDA,
  // The body's drag 0.18 m above the CG [spec WING_0 POSITION]
  dragCentreY: 0.18,
  wings: [
    // [spec WING_1 POSITION, ANGLE 45, FWCL.lut, FWCD.lut]
    wing('FRONT_WING', 2.405, 45, FW_CL, FW_CD, -0.1),
    // [spec WING_2 POSITION, ANGLE 60, RWCL.lut, RWCD.lut]
    wing('REAR_WING', -1.595, 60, RW_CL, RW_CD, 0.48),
    // [spec WING_3 FRONTAOACL.lut (CD_GAIN 0), WING_4 FRONTGHCL.lut (CD_GAIN 0), YAW_CL_GAIN −0.2]
    ...floor('front', 1.705, { cl: FRONT_PITCH_CL, cd: ZERO }, { cl: FRONT_GH_CL, cd: ONE, cdGain: 0, yawGain: -0.2 }),
    // [spec WING_5 REARAOACL.lut, REARAOACD.lut; WING_6 REARGHCL.lut, REARGHCD.lut, YAW_CL_GAIN −0.3]
    ...floor('rear', -1.395, { cl: REAR_PITCH_CL, cd: REAR_PITCH_CD }, { cl: REAR_GH_CL, cd: REAR_GH_CD, cdGain: 1, yawGain: -0.3 }),
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane level with the pickups [spec RIDE]
  floorOffsetY: PICKUP_Y,
  // The body's ground collider: 0.175 m below the CG, from 1.15 m ahead of it to 1.65 m behind [spec colliders.ini
  // COLLIDER_0 CENTRE, SIZE]
  plank: { y: -0.175, frontZ: 1.15, rearZ: -1.65 },
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

// ---------------------------------------------------------------------------
// Tyre tables [spec tyres.ini], per compound: peak μ against load (N) on each axle, wear and temperature
// ---------------------------------------------------------------------------

const S_FRONT_DY: LutPoints = [
  [0, 2.04], [1000, 1.9451], [2000, 1.8534], [3000, 1.7654], [4000, 1.6815], [5000, 1.6023],
  [6000, 1.5283], [7000, 1.4599], [8000, 1.3977], [9000, 1.3422], [10000, 1.2938], [11000, 1.2531],
  [12000, 1.2206], [13000, 1.1968], [14000, 1.1821], [15000, 1.1771], [24000, 1.1771],
];
const S_FRONT_DX: LutPoints = [
  [0, 1.9673], [1000, 1.8701], [2000, 1.7832], [3000, 1.7061], [4000, 1.6381], [5000, 1.5789],
  [6000, 1.5278], [7000, 1.4844], [8000, 1.4481], [9000, 1.4183], [10000, 1.3946], [11000, 1.3764],
  [12000, 1.3631], [13000, 1.3543], [14000, 1.3494], [15000, 1.3479], [24000, 1.3479],
];
const S_REAR_DY: LutPoints = [
  [0, 2.1012], [1000, 2.0076], [2000, 1.9188], [3000, 1.8349], [4000, 1.7564], [5000, 1.6834],
  [6000, 1.6161], [7000, 1.5549], [8000, 1.5], [9000, 1.4515], [10000, 1.4099], [11000, 1.3752],
  [12000, 1.3478], [13000, 1.328], [14000, 1.3159], [15000, 1.3118], [24000, 1.3118],
];
const S_REAR_DX: LutPoints = [
  [0, 2.0263], [1000, 1.9263], [2000, 1.8403], [3000, 1.7674], [4000, 1.7063], [5000, 1.6562],
  [6000, 1.6158], [7000, 1.5842], [8000, 1.5603], [9000, 1.5431], [10000, 1.5314], [11000, 1.5242],
  [12000, 1.5204], [13000, 1.519], [14000, 1.519], [15000, 1.5192], [24000, 1.5192],
];
const S_WEAR: LutPoints = [
  [0, 98], [0.2, 100], [0.4, 99.633], [0.6, 99.272], [0.8, 98.917], [1, 98.568],
  [1.4, 98.225], [1.8, 97.557], [2.2, 96.913], [2.6, 96.293], [3, 95.697], [3.4, 95.125],
  [3.8, 94.577], [4.2, 94.053], [4.6, 93.553], [5, 93.077], [5.4, 92.625], [5.8, 92.197],
  [6.2, 91.793], [6.6, 91.413], [7, 91.057], [7.4, 90.725], [7.8, 90.417], [8.2, 90.133],
  [8.6, 89.873], [9, 89.637], [9.4, 89.425], [9.8, 89.237], [10.2, 89.073], [10.6, 88.933],
  [11, 88.817], [11.4, 88.725], [11.8, 88.657], [12.2, 88.613],
];
const S_TEMP: LutPoints = [
  [20, 0.934], [25, 0.936], [30, 0.939], [35, 0.942], [40, 0.946], [45, 0.951], [50, 0.957],
  [55, 0.963], [60, 0.97], [65, 0.976], [70, 0.983], [75, 0.989], [80, 0.994], [85, 0.998],
  [90, 1], [95, 1], [100, 1], [105, 1], [110, 1], [115, 0.999], [120, 0.997],
  [125, 0.994], [130, 0.991], [135, 0.988], [140, 0.975], [145, 0.963], [150, 0.958], [155, 0.954],
  [160, 0.95], [165, 0.947], [170, 0.943], [175, 0.941], [180, 0.939], [185, 0.937], [190, 0.935],
  [195, 0.934], [200, 0.933],
];

const M_FRONT_DY: LutPoints = [
  [0, 2.0194], [1000, 1.9255], [2000, 1.8347], [3000, 1.7475], [4000, 1.6645], [5000, 1.5861],
  [6000, 1.5128], [7000, 1.4452], [8000, 1.3836], [9000, 1.3286], [10000, 1.2807], [11000, 1.2405],
  [12000, 1.2083], [13000, 1.1847], [14000, 1.1702], [15000, 1.1652], [24000, 1.1652],
];
const M_FRONT_DX: LutPoints = [
  [0, 1.9474], [1000, 1.8512], [2000, 1.7652], [3000, 1.6888], [4000, 1.6216], [5000, 1.563],
  [6000, 1.5124], [7000, 1.4694], [8000, 1.4335], [9000, 1.404], [10000, 1.3805], [11000, 1.3625],
  [12000, 1.3494], [13000, 1.3406], [14000, 1.3358], [15000, 1.3343], [24000, 1.3343],
];
const M_REAR_DY: LutPoints = [
  [0, 2.08], [1000, 1.9873], [2000, 1.8994], [3000, 1.8164], [4000, 1.7387], [5000, 1.6664],
  [6000, 1.5998], [7000, 1.5392], [8000, 1.4848], [9000, 1.4369], [10000, 1.3956], [11000, 1.3613],
  [12000, 1.3342], [13000, 1.3145], [14000, 1.3026], [15000, 1.2985], [24000, 1.2985],
];
const M_REAR_DX: LutPoints = [
  [0, 2.0058], [1000, 1.9068], [2000, 1.8217], [3000, 1.7495], [4000, 1.6891], [5000, 1.6395],
  [6000, 1.5995], [7000, 1.5682], [8000, 1.5446], [9000, 1.5275], [10000, 1.5159], [11000, 1.5088],
  [12000, 1.5051], [13000, 1.5037], [14000, 1.5037], [15000, 1.5039], [24000, 1.5039],
];
const M_WEAR: LutPoints = [
  [0, 98], [0.2, 100], [0.4, 99.706], [0.6, 99.416], [0.8, 99.129], [1, 98.847],
  [1.4, 98.568], [1.8, 98.022], [2.2, 97.492], [2.6, 96.976], [3, 96.476], [3.4, 95.992],
  [3.8, 95.523], [4.2, 95.069], [4.6, 94.631], [5, 94.208], [5.4, 93.8], [5.8, 93.408],
  [6.2, 93.031], [6.6, 92.669], [7, 92.323], [7.4, 91.992], [7.8, 91.676], [8.2, 91.376],
  [8.6, 91.092], [9, 90.822], [9.4, 90.568], [9.8, 90.329], [10.2, 90.106], [10.6, 89.898],
  [11, 89.705], [11.4, 89.528], [11.8, 89.366], [12.2, 89.22],
];
const M_TEMP: LutPoints = [
  [20, 0.933], [25, 0.935], [30, 0.937], [35, 0.94], [40, 0.943], [45, 0.948], [50, 0.953],
  [55, 0.959], [60, 0.966], [65, 0.973], [70, 0.98], [75, 0.986], [80, 0.992], [85, 0.996],
  [90, 0.999], [95, 1], [100, 1], [105, 1], [110, 1], [115, 0.999], [120, 0.995],
  [125, 0.99], [130, 0.985], [135, 0.98], [140, 0.975], [145, 0.97], [150, 0.965], [155, 0.956],
  [160, 0.951], [165, 0.948], [170, 0.944], [175, 0.942], [180, 0.939], [185, 0.937], [190, 0.936],
  [195, 0.934], [200, 0.933],
];

const H_FRONT_DY: LutPoints = [
  [0, 1.9992], [1000, 1.9062], [2000, 1.8163], [3000, 1.7301], [4000, 1.6479], [5000, 1.5703],
  [6000, 1.4977], [7000, 1.4307], [8000, 1.3697], [9000, 1.3153], [10000, 1.2679], [11000, 1.2281],
  [12000, 1.1962], [13000, 1.1728], [14000, 1.1585], [15000, 1.1535], [24000, 1.1535],
];
const H_FRONT_DX: LutPoints = [
  [0, 1.9279], [1000, 1.8327], [2000, 1.7475], [3000, 1.6719], [4000, 1.6054], [5000, 1.5473],
  [6000, 1.4973], [7000, 1.4547], [8000, 1.4191], [9000, 1.39], [10000, 1.3667], [11000, 1.3489],
  [12000, 1.3359], [13000, 1.3272], [14000, 1.3224], [15000, 1.321], [24000, 1.321],
];
const H_REAR_DY: LutPoints = [
  [0, 2.0592], [1000, 1.9674], [2000, 1.8804], [3000, 1.7982], [4000, 1.7213], [5000, 1.6497],
  [6000, 1.5838], [7000, 1.5238], [8000, 1.47], [9000, 1.4225], [10000, 1.3817], [11000, 1.3477],
  [12000, 1.3209], [13000, 1.3014], [14000, 1.2895], [15000, 1.2855], [24000, 1.2855],
];
const H_REAR_DX: LutPoints = [
  [0, 1.9858], [1000, 1.8878], [2000, 1.8035], [3000, 1.732], [4000, 1.6722], [5000, 1.6231],
  [6000, 1.5835], [7000, 1.5526], [8000, 1.5291], [9000, 1.5122], [10000, 1.5007], [11000, 1.4937],
  [12000, 1.49], [13000, 1.4887], [14000, 1.4886], [15000, 1.4888], [24000, 1.4888],
];
const H_WEAR: LutPoints = [
  [0, 98], [0.2, 100], [0.4, 99.755], [0.6, 99.512], [0.8, 99.272], [1, 99.035],
  [1.4, 98.8], [1.8, 98.339], [2.2, 97.888], [2.6, 97.448], [3, 97.019], [3.4, 96.6],
  [3.8, 96.192], [4.2, 95.795], [4.6, 95.408], [5, 95.032], [5.4, 94.667], [5.8, 94.312],
  [6.2, 93.968], [6.6, 93.635], [7, 93.312], [7.4, 93], [7.8, 92.699], [8.2, 92.408],
  [8.6, 92.128], [9, 91.859], [9.4, 91.6], [9.8, 91.352], [10.2, 91.115], [10.6, 90.888],
  [11, 90.672], [11.4, 90.467], [11.8, 90.272], [12.2, 90.088],
];
const H_TEMP: LutPoints = [
  [20, 0.932], [25, 0.933], [30, 0.935], [35, 0.937], [40, 0.94], [45, 0.944], [50, 0.949],
  [55, 0.954], [60, 0.961], [65, 0.967], [70, 0.975], [75, 0.982], [80, 0.988], [85, 0.994],
  [90, 0.997], [95, 1], [100, 1], [105, 1], [110, 1], [115, 0.999], [120, 0.995],
  [125, 0.99], [130, 0.985], [135, 0.98], [140, 0.975], [145, 0.968], [150, 0.963], [155, 0.958],
  [160, 0.954], [165, 0.95], [170, 0.946], [175, 0.943], [180, 0.941], [185, 0.938], [190, 0.936],
  [195, 0.935], [200, 0.934],
];


/**
 * 0.27 m wide at the front, 0.325 m at the rear, R 0.33 m on a 0.1778 m rim radius; the radius grows 0.016 mm (front)
 * and 0.024 mm (rear) per rad/s of spin, ≈ 6 mm at the rear at 300 km/h [spec tyres.ini WIDTH, RADIUS, RIM_RADIUS,
 * RADIUS_ANGULAR_K]
 */
const geometry = (width: number, growth: number): TyreGeometry => ({
  width,
  radius: TYRE_RADIUS,
  rimRadius: 0.1778,
  verticalRateScale: 1,
  radiusGrowthPerRadS: growth,
});
const FRONT_GEOMETRY = geometry(0.27, 1.584e-5);
const REAR_GEOMETRY = geometry(0.325, 2.376e-5);

/** Slip ratio at the peak of the drive force: tan(FRICTION_LIMIT_ANGLE) / CX_MULT 1 of theoretical slip [derived] */
const peakSlipRatio = (frictionLimitDeg: number) => {
  const theoretical = Math.tan((frictionLimitDeg * Math.PI) / 180);
  return Number((theoretical / (1 - theoretical)).toFixed(4));
};

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the 16 psi static pressure + PRESSURE_SPRING_GAIN per psi [spec] */
const pressureSpring = (rate: number, perPsi: number): LutPoints =>
  [6, 10, 14, 16, 18, 21, 24, 28, 32].map((p) => [p, Math.round(rate + perPsi * (p - 16))]);

/** A load table's value at a load (N), linear between its points */
const at = (lut: LutPoints, fz: number): number => {
  for (let i = 1; i < lut.length; i++) {
    if (fz <= lut[i][0]) return lut[i - 1][1] + ((lut[i][1] - lut[i - 1][1]) * (fz - lut[i - 1][0])) / (lut[i][0] - lut[i - 1][0]);
  }
  return lut[lut.length - 1][1];
};

/** Reference loads [spec FZ0] */
const FRONT_FZ0 = 1365.0615;
const REAR_FZ0 = 1602.4635;

/**
 * Lateral grip against camber (degrees, negative leaning into the corner → ×) [spec DCAMBER_LUT]: best at 4° (front) and
 * 2.5° (rear) of camber leaning in (× 1.06), in place of the DCAMBER_0 / _1 parabola the data also lists
 */
const FRONT_CAMBER: LutPoints = [
  [-90, 0.8],
  [-4, 1.06],
  [0, 1],
  [90, 0.7],
];
const REAR_CAMBER: LutPoints = [
  [-90, 0.8],
  [-2.5, 1.06],
  [0, 1],
  [90, 0.7],
];

/**
 * Heat capacities, hysteresis and cooling: the LC25's F1 slicks' [est]. The data's own thermal constants are for another
 * tyre model, not this one, and its performance curves are wide (93 % of the grip at 20 °C), so the grip hardly hangs on
 * the fit
 */
const THERMAL_COMMON = {
  // Pressure moves the heat: the sliding heat and the crown against the shoulders [est, as the LC25's]
  pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
  surfaceHeatCapacity: 1550,
  coreHeatCapacity: 9800,
  slipHeatShare: 0.35,
  hysteresis: 0.008,
  surfaceToCore: 40,
  surfaceCooling: [5, 0.6] as [number, number],
  coreCooling: [4, 0.1] as [number, number],
  thermalVerticalK: -0.0012,
  thermalVerticalRefC: 95,
};

/** What a compound's data gives beyond the shape the four share [spec tyres.ini FRONT_n / REAR_n, THERMAL_*_n] */
interface Bridgestone {
  name: string;
  shortName: TyresCompoundData['shortName'];
  tyre_compound: PhysicsTyreCompound;
  front: { dy: LutPoints; dx: LutPoints; rate: number; perPsi: number; damp: number; rr0: number; rrSlip: number; speedSensitivity: number };
  rear: { dy: LutPoints; dx: LutPoints; rate: number; perPsi: number; damp: number; rr0: number; rrSlip: number; speedSensitivity: number };
  wear: LutPoints;
  temp: LutPoints;
  optimalTempC: [number, number];
}

/**
 * A dry compound on the data's shared shape [spec tyres.ini]: grip from the load tables (peak μ ≈ 1.95–2.0 at a static
 * corner's 1.5–1.8 kN, ≈ 1.6–1.7 at 4 kN, 1.15–1.5 from 15 kN); a brush tyre peaking at 5.7° (front) and 5.2° (rear)
 * of slip, the peak growing 3.8 % / 4.5 % per FZ0 of load [spec FRICTION_LIMIT_ANGLE, FLEX_GAIN] and falling to 90 %
 * past it [spec FALLOFF_LEVEL, FALLOFF_SPEED]; 21 psi hot for the most grip, 0.28 % of it lost per psi away [spec
 * PRESSURE_IDEAL, PRESSURE_D_GAIN]
 */
function bridgestone(c: Bridgestone): TyresCompoundData {
  return {
    name: c.name,
    shortName: c.shortName,
    tyre_compound: c.tyre_compound,
    // Sliding under load wears in proportion, counted per 2000 N of it [spec VIRTUALKM USE_LOAD, WEAR_CURVE]. One curve:
    // the front's (the rear's loses grip ≈ 15–30 % slower)
    wear: { curve: c.wear, loadScaled: true, loadRefN: 2000 },
    front: FRONT_GEOMETRY,
    rear: REAR_GEOMETRY,
    modelData: {
      // The tables at FZ0, and the power law the tables replace [spec FZ0, LS_EXPY, LS_EXPX]
      Dy0: Number(at(c.front.dy, FRONT_FZ0).toFixed(4)),
      Dx0: Number(at(c.front.dx, FRONT_FZ0).toFixed(4)),
      lsExpY: 0.7,
      lsExpX: 0.7,
      Fz0: FRONT_FZ0,
      dyCurve: c.front.dy,
      dxCurve: c.front.dx,
      // A brush tyre on the mod's shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with load and
      // with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the fuller rising branch [spec XMU], the longitudinal
      // stiffness [spec CX_MULT] and the grip lost to sliding speed [spec SPEED_SENSITIVITY]. The front's COMBINED_FACTOR
      // is 0, which this model can't take as an exponent: the friction circle [est]
      curve: 'brush',
      curveFullness: 0.2,
      friction_limit_angle: 5.7,
      peakSlipLoadGain: 0.038,
      peakSlipPressureGain: 0.004,
      combinedExponent: 2,
      longStiffnessMult: 1,
      speedSensitivity: c.front.speedSensitivity,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 4.2,
      slip_ratio_limit: peakSlipRatio(5.7),
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [spec FALLOFF_LEVEL, FALLOFF_SPEED]
      use_slip_falloff: true,
      falloff_level: 0.9,
      falloff_slope: 5,
      // [spec RELAXATION_LENGTH]
      relaxationLengthX: 0.0978,
      relaxationLengthY: 0.0978,
      // ROLLING_RESISTANCE_0 N + 0.000466 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
      rollingResistance: c.front.rr0 / 1000,
      rollingResistanceSpeedSq: 4.66e-7,
      // Scrub at the peak slip, and no more past it [spec ROLLING_RESISTANCE_SLIP; est]
      rollingResistanceSlipGain: c.front.rrSlip / 1000,
      rollingResistanceSlipMax: 1,
      // [spec DAMP]
      verticalDamping: c.front.damp,
      // 8 % more grip braking than driving [spec BRAKE_DX_MOD]
      brakeDxMod: 0.08,
    },
    thermalData: {
      // Grip against tread temperature (°C) [spec PERFORMANCE_CURVE, the same front and rear]
      thermalPerformanceCurve: c.temp,
      // Within 0.1 % of the peak [derived]
      optimalTempC: c.optimalTempC,
      // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]; the graining wears off as the tread slides
      tread: { grainGain: 0.2, grainGamma: 1, blisterGain: 0.2, blisterGamma: 1.5, wearOffWithSlip: true },
      ...THERMAL_COMMON,
    },
    pressureData: {
      // [spec PRESSURE_IDEAL]
      optimalPsi: 21,
      pressureSpringCurve: pressureSpring(c.front.rate, c.front.perPsi),
      // [spec PRESSURE_RR_GAIN]
      pressureRollingGain: 1.2,
      pressureGripSensitivity: 1.0,
      // [spec PRESSURE_D_GAIN]
      pressureGripLossPerPsi: 0.0028,
      // Off 90 °C blankets [spec ADDITIONAL1 BLANKETS_TEMP]. The data's 16 psi (PRESSURE_STATIC) is set cold and reaches
      // the ideal 21 at ≈ 90 °C by its own 0.08 psi per °C; this model's pressure follows the gas, so the cold pressure is
      // the one that reaches 21 psi in the middle of the working window, and the garage states it at 20 °C (the
      // profile's `setupPressureRefC`) [est]
      coldRefC: 90,
    },
    camberData: {
      // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1, DCAMBER_LUT]
      camberGain: 0.1,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: 1.622,
      dcamber1: -11.614,
      dcamberLut: FRONT_CAMBER,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    // The wider rear: its own load tables and reference load, peak slip angle and its growth, combined-slip exponent,
    // relaxation, rolling resistance, damping, camber terms and radial rate [spec REAR_n]
    rearOverride: {
      modelData: {
        Dy0: Number(at(c.rear.dy, REAR_FZ0).toFixed(4)),
        Dx0: Number(at(c.rear.dx, REAR_FZ0).toFixed(4)),
        Fz0: REAR_FZ0,
        dyCurve: c.rear.dy,
        dxCurve: c.rear.dx,
        friction_limit_angle: 5.2,
        peakSlipLoadGain: 0.045,
        // [spec COMBINED_FACTOR]
        combinedExponent: 2.24,
        speedSensitivity: c.rear.speedSensitivity,
        slip_ratio_limit: peakSlipRatio(5.2),
        relaxationLengthX: 0.0984,
        relaxationLengthY: 0.0984,
        rollingResistance: c.rear.rr0 / 1000,
        rollingResistanceSpeedSq: 4.32e-7,
        rollingResistanceSlipGain: c.rear.rrSlip / 1000,
        verticalDamping: c.rear.damp,
      },
      camberData: { dcamber0: 2.595, dcamber1: -29.731, dcamberLut: REAR_CAMBER },
      pressureData: { pressureSpringCurve: pressureSpring(c.rear.rate, c.rear.perPsi), pressureRollingGain: 1.3 },
    },
  };
}

/** Bridgestone Soft [spec tyres.ini FRONT_1 / REAR_1, THERMAL_*_1] */
const SOFT = bridgestone({
  name: 'Bridgestone Soft',
  shortName: 'S',
  tyre_compound: 'PhysicsTyreCompound_F1_Soft',
  front: { dy: S_FRONT_DY, dx: S_FRONT_DX, rate: 267_166.21, perPsi: 12_200, damp: 742, rr0: 9.9, rrSlip: 2994, speedSensitivity: 0.00602 },
  rear: { dy: S_REAR_DY, dx: S_REAR_DX, rate: 281_227.43, perPsi: 12_900, damp: 770, rr0: 9.9, rrSlip: 3038, speedSensitivity: 0.00588 },
  wear: S_WEAR,
  temp: S_TEMP,
  optimalTempC: [90, 110],
});

/**
 * Bridgestone Medium [spec tyres.ini FRONT_2 / REAR_2, THERMAL_*_2]. Its SPEED_SENSITIVITY is 0.0083 on both axles,
 * where the other three compounds' are 0.00602 / 0.00588: it loses more grip to sliding speed [spec]
 */
const MEDIUM = bridgestone({
  name: 'Bridgestone Medium',
  shortName: 'M',
  tyre_compound: 'PhysicsTyreCompound_F1_Medium',
  front: { dy: M_FRONT_DY, dx: M_FRONT_DX, rate: 269_837.8721, perPsi: 12_300, damp: 748, rr0: 9.8, rrSlip: 2941, speedSensitivity: 0.0083 },
  rear: { dy: M_REAR_DY, dx: M_REAR_DX, rate: 284_039.7043, perPsi: 13_000, damp: 776, rr0: 9.8, rrSlip: 3000, speedSensitivity: 0.0083 },
  wear: M_WEAR,
  temp: M_TEMP,
  optimalTempC: [95, 110],
});

/** Bridgestone Hard [spec tyres.ini FRONT_3 / REAR_3, THERMAL_*_3] */
const HARD = bridgestone({
  name: 'Bridgestone Hard',
  shortName: 'H',
  tyre_compound: 'PhysicsTyreCompound_F1_Hard',
  front: { dy: H_FRONT_DY, dx: H_FRONT_DX, rate: 272_536.250821, perPsi: 12_400, damp: 761, rr0: 9.7, rrSlip: 2904, speedSensitivity: 0.00602 },
  rear: { dy: H_REAR_DY, dx: H_REAR_DX, rate: 286_880.101343, perPsi: 13_100, damp: 782, rr0: 9.7, rrSlip: 2978, speedSensitivity: 0.00588 },
  wear: H_WEAR,
  temp: H_TEMP,
  optimalTempC: [95, 110],
});

/**
 * The data has four dry compounds, Super Soft, Soft, Medium and Hard (COMPOUND_DEFAULT 0, the Super Soft), ≈ 1 % of
 * grip apart; the garage has three slots, so Soft, Medium and Hard fill them under their own names and the Super Soft
 * (and its copy, "Slick", FRONT_6) is left out. The data's Intermediate and Wet (FRONT_4, FRONT_5) are copies of the
 * Hard's dry data (the Wet adds a tread cover and depth, the Intermediate nothing), so the rain tyres are derived from
 * the Medium's carcass as the LC25's are: the F1 rain pack's temperature curves and the rain tyres' water clearing and
 * heat ratios [est]
 */
const TYRES = {
  PhysicsTyreCompound_F1_Soft: SOFT,
  PhysicsTyreCompound_F1_Medium: MEDIUM,
  PhysicsTyreCompound_F1_Hard: HARD,
  PhysicsTyreCompound_F1_Intermediate: deriveRainCompound(MEDIUM, 'intermediate', 'PhysicsTyreCompound_F1_Intermediate', 'Intermediate', true, NUZZI_RAIN_TYRE_DESIGN.intermediate),
  PhysicsTyreCompound_F1_Wet: deriveRainCompound(MEDIUM, 'wet', 'PhysicsTyreCompound_F1_Wet', 'Wet', true, NUZZI_RAIN_TYRE_DESIGN.wet),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Equivalent box 1.38 × 1.1 × 3.42 m [spec car.ini INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const F12007_CONFIG = {
  screenName: 'F1 2007',
  chassis: {
    // [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: FRONT_WEIGHT,
    // [spec WHEELBASE, TRACK]: the Ferrari's; the other teams' differ by a few centimetres
    wheelbase: WHEELBASE,
    trackWidthFront: 1.444,
    trackWidthRear: 1.39,
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(1.1, 3.42), roll: box(1.38, 1.1), yaw: box(1.38, 3.42) },
    // [spec HUB_MASS]
    unsprungMassFront: FRONT_HUB_KG,
    unsprungMassRear: REAR_HUB_KG,
    // The tank sits behind the driver, 0.1 m behind the CG and 0.024 m above it [spec FUELTANK POSITION]
    fuelTank: { y: 0.024, z: -0.1 },
    // [spec tyres.ini ANGULAR_INERTIA]
    wheelInertiaFront: 0.93,
    wheelInertiaRear: 1.25,
    // 225° of rim lock each way on a 12:1 rack: 18.75° at the road wheels [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 225 / 12,
    // The kingpin (WBTYRE_BOTTOM → WBTYRE_TOP) leans back 6.0° and meets the ground 19.9 mm ahead of the contact patch
    // [derived]
    ffbMechanicalTrailM: 0.0199,
    // The Ferrari's plan at barrier height, measured from f1-2007-ferrari.glb (`scripts/cars/measure-car-plans.ts`), the
    // one outline for every team's body
    bodyPlan: [[0.00, 2.46], [0.67, 2.41], [0.90, 1.59], [0.85, -1.59], [0.47, -2.11], [0.00, -2.11]],
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 600 Nm clutch; the auto clutch bites at 4500 rpm and closes by 5600 [spec CLUTCH, AUTOCLUTCH]. On the throttle in
  // first it slips at 7000 instead, where the V8 has 156 Nm: 0–100 km/h in 2.8 s (3.0 s closing at 5600); from 7500 up
  // the rears spin up and, without the TC, spin the car [est]
  clutch: { maxTorqueNm: 600, biteRpm: 4500, lockRpm: 5600, launchRpm: 7000 },
  // Locking torque = preload + POWER / COAST × input torque [spec DIFFERENTIAL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.1, coast: 0.4, preload: 15, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // 4200 Nm at full pedal, 59 % front, the bias adjustable in 0.5 % steps, no handbrake [spec brakes.ini]. Carbon discs
  // [est: the data names no material]: the pads grip 77 % cold, fully at 600 °C and 87 % at 1000 (the same curve front
  // and rear) [spec PERF_CURVE]. Hydraulic brakes, no migration
  brakes: {
    maxTorqueNm: 4200,
    front_bias: 0.59,
    handbrakeTorqueNm: 0,
    ebbStep: 0.005,
    brakeByWire: false,
    discMaterial: 'carbon-ceramic',
    padMuCurve: [
      [0, 0.769],
      [100, 0.8229],
      [200, 0.8768],
      [300, 0.9259],
      [400, 0.9654],
      [500, 0.9911],
      [600, 1],
      [700, 0.9902],
      [800, 0.9621],
      [900, 0.9192],
      [1000, 0.8665],
    ],
    migration: { amount: 0, rampStart: 0 },
  },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: TYRES,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_F1_Soft',
    medium: 'PhysicsTyreCompound_F1_Medium',
    hard: 'PhysicsTyreCompound_F1_Hard',
    intermediate: 'PhysicsTyreCompound_F1_Intermediate',
    wet: 'PhysicsTyreCompound_F1_Wet',
  },
} satisfies CarPhysicsConfig;

/**
 * Traction control, as the 2007 cars had it: 8 % wheelspin, cycling at 80 Hz, off under 40 km/h [spec electronics.ini
 * TRACTION_CONTROL]; its switch positions (traction_control.lut) are 15, 16 and 17 %, past the tyres' 10–11 % peak, and
 * sit at the loose end of the table here; the other positions step 0.5–1 % either side of the 8 % [est]. No ABS
 * (PRESENT=0), but the data sets one up at 10 % cycling at 200 Hz [spec]: it serves the assisted presets (and the
 * semi-pro ABS, which the AI brakes on); its other positions step 0.5 % [est]. The lateral and rear slide terms are the
 * F1 calibration's (absent here)
 */
export const F12007_ELECTRONICS = {
  absLevels: [0.07, 0.075, 0.08, 0.085, 0.09, 0.095, 0.1, 0.105, 0.11, 0.115, 0.12, 0.125],
  absDefault: 0.1,
  absRateHz: 200,
  tcLevels: [0.05, 0.055, 0.06, 0.065, 0.07, 0.075, 0.08, 0.09, 0.1, 0.15, 0.16, 0.17],
  tcDefault: 0.08,
  tcRateHz: 80,
  tcMinSpeedKmh: 40,
};
