/**
 * Nissan Skyline GT-R R32 JTCC (1993, Group A) vehicle data for `VehiclePhysics` (same data model as the f12026-car,
 * see `F12026CarConfig`): the Japanese Touring Car Championship car, a 2.6 L twin-turbo straight six, five-speed box
 * and ATTESA E-TS four-wheel drive.
 *
 * The numbers come from gregsediting's "Nissan Skyline GT-R R32 JTCC" (Assetto Corsa), mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * Its drivetrain is AC's AWD2 layout (`AwdData`): the rears driven through a ramp differential, the fronts through a
 * centre coupling that picks up drive as the rears spin. Two identical turbos, no hybrid or DRS, and no ABS or traction
 * control (electronics.ini has both PRESENT=0); the brake-operated diff lock it does have (EDL) is carried. Double
 * wishbones at both ends with no heave spring, three slicks, and three aero elements: a front splitter that works in
 * ground effect, a rear wing and its lip, plus the body, which only drags. The mod's ui figures (542 bhp, 541 Nm,
 * 1260 kg) are its sheet's; the data files give 1335 kg and ≈ 470 Nm at the wheels at full boost.
 *
 * Not read: `[AWD]` (AWD2 replaces it), `[DIFFERENTIAL]` (AWD2 has its own rear diff), and the four tables
 * `rear_ratio_vs_lock.lut`, `difflock_gear_mult.lut`, `difflock_brake_mult.lut` and `gear_start.lut`: no file of the car
 * points at them (AC reads such tables only through a `ctrl_*.ini` controller, and the car has none).
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

/**
 * Two identical turbos [spec TURBO_0, TURBO_1]: each makes MAX_BOOST 2 × (rpm / 6000)^2.5, held to its WASTEGATE 0.48,
 * and the torque is × (1 + the sum of the boosts) (AC's turbo). Together: 0.96 from 3390 rpm, which is this model's
 * maxBoost 0.96 reached at 6000 × (0.96 / 4)^0.4 = 3390 rpm with the same gamma [derived]. LAG_UP 0.995 / LAG_DN 0.996
 * close 0.5 % / 0.4 % of the gap each physics tick: at AC's 333 Hz a 0.6 s spool-up and a 0.75 s run-down. This model
 * spools faster with the exhaust flow, so 0.6 s is set at REFERENCE_RPM [derived, est]. The gauge reads the boost it
 * makes: 0.96 bar at full boost [display]
 */
const TURBO: TurboData = {
  maxBoost: 0.96,
  referenceRpm: Number((6000 * (0.96 / 4) ** 0.4).toFixed(1)),
  gamma: 2.5,
  spoolUpS: 0.6,
  spoolRefRpm: 6000,
  spoolDownS: 0.75,
  displayMaxBoostBar: 0.96,
};

/** Wheel torque before the turbos (rpm → Nm) [spec power.lut]: 240 Nm at 6750 rpm, 470 Nm there with the boost */
const WHEEL_TORQUE: [number, number][] = [
  [0, 100],
  [500, 100],
  [1000, 150],
  [1500, 168],
  [2000, 170],
  [2500, 180],
  [3000, 185],
  [3250, 188],
  [3500, 190],
  [3750, 194],
  [4000, 196],
  [4250, 198],
  [4500, 200],
  [4750, 202],
  [5000, 204],
  [5250, 206],
  [5500, 212],
  [5750, 218],
  [6000, 224],
  [6250, 230],
  [6500, 236],
  [6750, 240],
  [7000, 238],
  [7250, 232],
  [7500, 226],
  [7750, 220],
  [8000, 214],
];

/**
 * Crank power (kW) at the curve's points with the boost the turbos make there in steady state at full throttle, as
 * this model's curve is (the turbo's lag acts on it at run time): ≈ 382 kW at the 8000 rpm limiter, ≈ 351 kW of it at
 * the wheels [derived]
 */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [
  rpm,
  Number((((nm * (1 + turboSteadyBoost(TURBO, rpm))) / DRIVELINE_EFFICIENCY) * rpm * Math.PI / 30 / 1000).toFixed(3)),
]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque from nothing at idle, 90 Nm at 4800 rpm [spec COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [2100, 0],
    [4800, 90],
    [8000, 196.7],
  ] as LutPoints,
  // Pedal → throttle: a quick first tenth, then near linear [spec throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [0.1, 0.3],
    [0.2, 0.4],
    [0.3, 0.5],
    [0.4, 0.6],
    [0.5, 0.7],
    [0.6, 0.75],
    [0.7, 0.8],
    [0.8, 0.85],
    [0.9, 0.9],
    [1, 1],
  ] as LutPoints,
  // Throttle actuator and intake filling, as the GT3's [est]; the turbos' lag comes on top
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  turbo: TURBO,
  // [spec MINIMUM]
  idleRpm: 2100,
  // Engine 0.450 + gearbox 0.015 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.465,
  // 40 Hz limiter: the cut lasts one cycle [spec LIMITER_HZ]
  limiterCutS: 0.025,
  // A tenth of a change in air density reaches the torque [spec ALTITUDE_SENSITIVITY]
  airDensitySensitivity: 0.1,
};

const NONE: LutPoints = [
  [0, 0],
  [9000, 0],
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
 * Five-speed box on a 4.111 final drive, the Group A set [spec drivetrain.ini; setup.ini GEAR_SET_0]: ≈ 340 km/h in
 * fifth at the 8000 rpm limiter, past the drag-limited top speed. An up-shift is 240 ms between gears with the throttle
 * cut for the same 240 ms [spec CHANGE_UP_TIME, AUTO_CUTOFF_TIME]
 */
const GEARBOX = {
  ratios: [3.214, 1.925, 1.303, 1.0, 0.752],
  reverse: 3.37,
  finalDrive: 4.111,
  shiftTimeS: 0.24,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.3,
  // As the 496R's [est]; the box is between gears for the whole cut anyway
  shiftTorqueFraction: 0.1,
  upshiftNeutralS: 0.24,
  upshiftCutS: 0.24,
  // AC's auto cut-off shuts the throttle: the engine slows on its overrun drag through the change
  upshiftCutLift: true,
  // Down: 300 ms between gears with an 80 % blip, the clutch out 10 ms in and coming home over the 40 ms of its
  // profile once the gear is in, and up to 100 rpm over the limiter [spec CHANGE_DN_TIME, DOWNSHIFT_PROFILE (10 / 160 /
  // 200 ms), AUTOBLIP, DOWNSHIFT_PROTECTION]
  downshift: { neutralS: 0.3, clutchReleaseS: 0.16, clutchHomeS: 0.34, blip: { level: 0.8, riseS: 0.01 }, overRevRpm: 100 },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 8000,
    // [spec AUTO_SHIFTER UP]
    upshift_rpm: 7900,
    // [spec AUTO_SHIFTER DOWN]
    downshift_rpm: 4200,
    // Into a braking zone the auto box clicks down while the lower gear lands under 7000 rpm: the boosted engine makes
    // its power from 6500 rpm to the limiter [est]
    brake_downshift_rpm: 7000,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

const MASS = 1335;
const WHEELBASE = 2.615;
/** Share of the sprung weight on the front axle [spec CG_LOCATION] */
const FRONT_WEIGHT = 0.59;
/** Sprung load on a front / rear spring at static ride (N): the car less its hubs (48 / 50 kg) [derived] */
const SPRUNG_KG = MASS - 2 * 48 - 2 * 50;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * FRONT_WEIGHT) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * (1 - FRONT_WEIGHT)) / 2;
/** Tyre radial rate at the 28 psi it runs at (N/m): 296 160 at 21 psi + 9398 per psi [spec RATE, PRESSURE_SPRING_GAIN] */
const HOT_TYRE_RATE = 296_160 + 9398 * 7;
/**
 * The mod measures its stops from the suspension's design position, with the springs working on their rod lengths
 * (`mod-suspension.ts`): at static ride the springs hold the fronts 4.6 mm and the rears 4.3 mm short of it, so the stops
 * are these far from static [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN; derived]
 */
const FRONT_STOPS = modCornerStops({
  staticLoadN: FRONT_STATIC_LOAD_N,
  springRate: 103_346,
  rodLength: 0.03648,
  packerRange: 0.055,
  bumpStopUp: 0.0825,
  bumpStopDn: 0.0703,
});
const REAR_STOPS = modCornerStops({
  staticLoadN: REAR_STATIC_LOAD_N,
  springRate: 77_896,
  rodLength: 0.0337,
  packerRange: 0.048,
  bumpStopUp: 0.0833,
  bumpStopDn: 0.0636,
});
const mm = (m: number) => Number(m.toFixed(4));
/** No heave element: a spring that never engages */
const NO_HEAVE = { rate: 0, gap: 1, packerGap: 1, packerRate: 0 };

/**
 * Double wishbones front and rear: the mod's wheel rates, anti-roll bars, bump stops, packers and two-stage dampers
 * [spec suspensions.ini], the stops at their distance from static ride (above): the packers 23 mm (front) and 19 mm
 * (rear) up, the bump stops 87 / 88 mm up, both at BUMP_STOP_RATE. Hardpoints are [x inboard, y up, z forward] from the
 * wheel centre [spec]; camber gain and roll-centre heights are what the kinematic solver gives on them at static
 * [derived].
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -3,
    camberGainKinematic: -28.0,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 103_346, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(FRONT_STOPS.packerGapM), rate: 60_600, progression: 0, hardStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 60_600 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.0967,
    // [spec ARB FRONT]
    arb: 110_000,
    hardpoints: [
      [0.51, 0.415, -0.14],
      [0.465, 0.41, -0.26],
      [0.43, -0.125, 0.265],
      [0.455, -0.105, -0.05],
      [0.2977, 0.5, -0.0215],
      [0.13, -0.115, 0.018],
      [0.45, -0.08, -0.16],
      [0.14, -0.085, -0.1],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -2,
    camberGainKinematic: -51.7,
    // [spec SPRING_RATE, PROGRESSIVE_SPRING_RATE 0]
    springs: { wheel_rate: 77_896, helper_rate: 0, helper_range: 0 },
    heave: NO_HEAVE,
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(REAR_STOPS.packerGapM), rate: 60_600, progression: 0, hardStop: { range: mm(REAR_STOPS.bumpStopGapM), rate: 60_600 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: 0.1929,
    // [spec ARB REAR]
    arb: 28_000,
    hardpoints: [
      [0.255, 0.09415, 0.2],
      [0.4, 0.09415, -0.0479],
      [0.285, -0.07327, 0.2664],
      [0.415, -0.07327, 0.02814],
      [0.11, 0.135, -0.05],
      [0.12, -0.09, 0],
      [0.544, -0.0115, -0.0848],
      [0.21, -0.01, -0.18],
    ],
  },
  dampers_controller: {
    front: {
      // [spec DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND, DAMP_FAST_*THRESHOLD]
      base: damper(6527, 2395, 7437, 2665),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.05,
      fastReboundThresholdMs: 0.05,
    },
    rear: {
      base: damper(6769, 2640, 7954, 3140),
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
 * −0.150 / −0.138 below the CG's level, plus the static offset): 0.486 m at the front, 0.477 m at the rear, so the CG,
 * 59 % of the weight forward, rides 0.482 m up [spec BASEY, RADIUS; derived]. The ride-height pickups sit 0.39 m below
 * the CG's level [spec RIDE]: 96 / 87 mm off the ground at rest.
 */
const FRONT_BODY_HEIGHT = modBodyHeightM(0.342, (FRONT_STATIC_LOAD_N + 48 * 9.81) / HOT_TYRE_RATE, -0.15, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(0.342, (REAR_STATIC_LOAD_N + 50 * 9.81) / HOT_TYRE_RATE, -0.138, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * (1 - FRONT_WEIGHT)).toFixed(4));
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT - 0.39).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT - 0.39).toFixed(4));

/** A table's values × a gain (AC's CL_GAIN / CD_GAIN) */
const gain = (lut: LutPoints, k: number): LutPoints => lut.map(([x, v]) => [x, Number((v * k).toFixed(4))]);
/** A table moved along its axis */
const shiftX = (lut: LutPoints, dx: number): LutPoints => lut.map(([x, v]) => [Number((x + dx).toFixed(4)), v]);
/**
 * AC's YAW_CL_GAIN as a table: CL × (1 + gain · |yaw| in radians), at the slide angles the car meets (|deg| → ×)
 * [spec, derived]
 */
const yawTable = (yawGain: number): LutPoints =>
  [0, 2, 5, 10, 20, 30].map((deg) => [deg, Number(Math.max(0, 1 + (yawGain * deg * Math.PI) / 180).toFixed(4))]);

/**
 * The body element: chord 1.159 × span 1.77 m, CD 0.314 at 0° (its table × CD_GAIN 0.314), no lift (CL_GAIN 0), no
 * ground-height tables [spec WING_0]: a constant 0.644 m² of drag (its table moves it under 1 % over ±5° of pitch)
 */
const BODY_CDA = Number((1.15883 * 1.77 * 0.314).toFixed(4));
/** The rear wing and its lip share one profile [spec wing_rear / wing_lip_AOA_*.lut] */
const REAR_CL: LutPoints = [
  [-25, -0.235],
  [0, 1],
  [5, 1.259],
  [7, 1.415],
  [10, 1.589],
  [12, 1.684],
  [13, 1.754],
  [15, 1.876],
  [18, 2.013],
  [20, 2.084],
  [22, 2.154],
  [25, 2.093],
  [30, 1.648],
];
const REAR_CD: LutPoints = [
  [-25, 3.099],
  [0, 1],
  [5, 1.085],
  [7, 1.162],
  [10, 1.318],
  [12, 1.472],
  [13, 1.623],
  [15, 1.937],
  [18, 2.248],
  [20, 2.558],
  [22, 2.713],
  [25, 2.867],
  [30, 3.099],
];
const FLAT: LutPoints = [
  [0, 1],
  [0.3, 1],
];

/**
 * Splitter, rear wing and lip with the mod's angle-of-attack tables, their gains folded in, and the splitter's
 * ground-height table [spec aero.ini]; the body's drag as a constant. Each element's ground height is its own: the
 * splitter sits 89 mm above the front pickup (POSITION y −0.301 against RIDE −0.39), so its table moves by that, which
 * reads its last point (× 0.731) at any ride height the car runs at. The yaw tables are the elements' YAW_CL_GAIN. At
 * rest, CL·A ≈ 0.59 m² (0.18 splitter, 0.18 wing at 12°, 0.23 lip at 22°) for CD·A ≈ 0.88 m² (0.64 body, 0.08 wing,
 * 0.15 lip); the splitter ahead of the front axle and the wings behind the rear put ≈ 19 % of it on the front.
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: BODY_CDA,
  // Body 0.16 m above the CG, wing 0.63 m, lip 0.53 m [spec POSITION]: ≈ 0.27 m for the sum [derived]
  dragCentreY: 0.27,
  wings: [
    {
      name: 'FRONT_WING',
      // [spec WING_1 CHORD × SPAN, POSITION, ANGLE]
      area: 0.875,
      positionZ: 1.7226,
      angleDeg: 0,
      heightRef: 'front',
      lutAOA_CL: gain(
        [
          [-12, -2.116],
          [-10, -1.527],
          [-8, -0.976],
          [-6, -0.249],
          [-4, 0.427],
          [-2, 0.903],
          [0, 1],
          [2, 1.032],
          [4, 1.064],
          [6, 1.075],
          [8, 1.056],
          [10, 0.978],
          [12, 0.862],
        ],
        0.278
      ),
      // CD_GAIN 0 [spec]
      lutAOA_CD: [
        [-12, 0],
        [12, 0],
      ],
      lutGH_CL_mult: shiftX(
        [
          [0, 0],
          [0.01, 0.994],
          [0.02, 1.057],
          [0.025, 1.056],
          [0.03, 1.061],
          [0.035, 1.067],
          [0.04, 1.038],
          [0.045, 1],
          [0.06, 0.957],
          [0.075, 0.872],
          [0.09, 0.821],
          [0.105, 0.789],
          [0.125, 0.731],
        ],
        -0.089
      ),
      // All 1 [spec wing_front_GH_CD.lut]
      lutGH_CD_mult: FLAT,
      lutYaw_CL_mult: yawTable(-0.403),
    },
    {
      name: 'REAR_WING',
      // [spec WING_2 CHORD × SPAN, POSITION, ANGLE 12; no setup for it]
      area: 0.39,
      positionZ: -2.25,
      angleDeg: 12,
      heightRef: 'rear',
      lutAOA_CL: gain(REAR_CL, 0.276),
      lutAOA_CD: gain(REAR_CD, 0.145),
      lutGH_CL_mult: FLAT,
      lutGH_CD_mult: FLAT,
      lutYaw_CL_mult: yawTable(2.016),
    },
    {
      name: 'REAR_WING',
      // The lip on the boot lid [spec WING_3 CHORD × SPAN, POSITION, ANGLE 22]
      area: 0.39,
      positionZ: -2.25,
      angleDeg: 22,
      heightRef: 'rear',
      lutAOA_CL: gain(REAR_CL, 0.276),
      lutAOA_CD: gain(REAR_CD, 0.145),
      lutGH_CL_mult: FLAT,
      lutGH_CD_mult: FLAT,
      lutYaw_CL_mult: yawTable(2.016),
    },
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane level with the pickups, 0.39 m below the CG [spec RIDE]
  floorOffsetY: -0.39,
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/**
 * Slicks 0.265 m wide, R 0.342 m on a 0.2413 m rim radius front and rear; the radius grows 0.0215 mm (front) / 0.0223 mm
 * (rear) per rad/s of spin, ≈ 4.5 mm at 250 km/h [spec tyres.ini WIDTH, RADIUS, RIM_RADIUS, RADIUS_ANGULAR_K]
 */
const FRONT_TYRE: TyreGeometry = { width: 0.265, radius: 0.342, rimRadius: 0.2413, verticalRateScale: 1, radiusGrowthPerRadS: 2.15e-5 };
const REAR_TYRE: TyreGeometry = { width: 0.265, radius: 0.342, rimRadius: 0.2413, verticalRateScale: 1, radiusGrowthPerRadS: 2.2333e-5 };

/** The tyres' reference load [spec FZ0] */
const FZ0 = 4000;

/** The mod's load-sensitivity tables (N → peak μ) [spec DY_CURVE / DX_CURVE]; the last point is the data's own 150 000 N */
const LOADS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 150000];
const loadTable = (mu: number[]): LutPoints => LOADS.map((fz, i) => [fz, mu[i]]);
interface AxleGrip {
  y: number[];
  x: number[];
}
const COMPOUND_GRIP: Record<'soft' | 'medium' | 'hard', { front: AxleGrip; rear: AxleGrip }> = {
  soft: {
    front: {
      y: [1.902, 1.81, 1.715, 1.62, 1.529, 1.443, 1.365, 1.296, 1.237, 1.191, 1.155, 1.128, 1.108, 1.093, 1.082, 1.072],
      x: [1.833, 1.757, 1.681, 1.605, 1.529, 1.454, 1.382, 1.318, 1.262, 1.218, 1.185, 1.161, 1.143, 1.131, 1.122, 1.115],
    },
    rear: {
      y: [1.906, 1.82, 1.732, 1.645, 1.559, 1.479, 1.405, 1.341, 1.287, 1.245, 1.214, 1.192, 1.177, 1.168, 1.162, 1.158],
      x: [1.836, 1.767, 1.698, 1.629, 1.559, 1.49, 1.424, 1.364, 1.313, 1.274, 1.246, 1.227, 1.215, 1.208, 1.206, 1.205],
    },
  },
  medium: {
    front: {
      y: [1.893, 1.801, 1.707, 1.612, 1.521, 1.436, 1.358, 1.289, 1.231, 1.185, 1.149, 1.122, 1.103, 1.088, 1.077, 1.067],
      x: [1.824, 1.749, 1.673, 1.597, 1.521, 1.447, 1.376, 1.311, 1.256, 1.212, 1.179, 1.155, 1.137, 1.125, 1.117, 1.11],
    },
    rear: {
      y: [1.896, 1.811, 1.724, 1.636, 1.551, 1.471, 1.398, 1.334, 1.281, 1.239, 1.208, 1.186, 1.171, 1.162, 1.156, 1.153],
      x: [1.827, 1.758, 1.689, 1.621, 1.551, 1.483, 1.417, 1.357, 1.306, 1.267, 1.239, 1.22, 1.209, 1.202, 1.2, 1.199],
    },
  },
  hard: {
    front: {
      y: [1.883, 1.792, 1.698, 1.604, 1.513, 1.428, 1.351, 1.283, 1.225, 1.179, 1.144, 1.117, 1.097, 1.082, 1.071, 1.062],
      x: [1.815, 1.74, 1.664, 1.589, 1.513, 1.439, 1.369, 1.304, 1.25, 1.206, 1.173, 1.149, 1.132, 1.12, 1.111, 1.104],
    },
    rear: {
      y: [1.887, 1.802, 1.715, 1.628, 1.544, 1.464, 1.391, 1.327, 1.274, 1.233, 1.202, 1.18, 1.166, 1.156, 1.151, 1.147],
      x: [1.818, 1.749, 1.681, 1.612, 1.544, 1.475, 1.409, 1.35, 1.3, 1.261, 1.233, 1.214, 1.203, 1.196, 1.194, 1.193],
    },
  },
};

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the 21 psi static pressure + 9398 N/m per psi [spec] */
const pressureSpring = (rate: number): LutPoints => [11, 15, 21, 28, 35, 40].map((p) => [p, Math.round(rate + 9398 * (p - 21))]);

/** Slip ratio at the peak of the drive force: tan(FRICTION_LIMIT_ANGLE) / CX_MULT of theoretical slip [derived] */
const peakSlipRatio = (frictionLimitDeg: number) => {
  const theoretical = Math.tan((frictionLimitDeg * Math.PI) / 180) / 1.2;
  return Number((theoretical / (1 - theoretical)).toFixed(4));
};

function slick(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  grip: { front: AxleGrip; rear: AxleGrip },
  /** Grip against tread temperature (°C) [spec Tyre_Temp_*.lut] */
  thermalCurve: LutPoints,
  /** Where that curve is within 0.1 % of its peak [derived] */
  window: [number, number],
  /** Grip (% of new) against km slid [spec Front_Wear_*.lut] */
  wearCurve: LutPoints
): TyresCompoundData {
  return {
    name,
    shortName,
    tyre_compound,
    // Sliding under load wears in proportion, counted per 2000 N of it [spec VIRTUALKM USE_LOAD]. One curve per compound:
    // the front's (the rear's lasts 10 % more km)
    wear: { curve: wearCurve, loadScaled: true, loadRefN: 2000 },
    front: FRONT_TYRE,
    rear: REAR_TYRE,
    modelData: {
      // The tables at FZ0, and the power law the tables replace [spec FZ0, LS_EXPY, LS_EXPX]
      Dy0: grip.front.y[4],
      Dx0: grip.front.x[4],
      lsExpY: 0.72,
      lsExpX: 0.756,
      Fz0: FZ0,
      dyCurve: loadTable(grip.front.y),
      dxCurve: loadTable(grip.front.x),
      // A brush tyre, on the mod's own shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with load
      // (5.9 % per FZ0) and with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the fuller rising branch [spec XMU],
      // the combined-slip exponent [spec COMBINED_FACTOR], the longitudinal stiffness [spec CX_MULT] and the grip lost
      // to sliding speed [spec SPEED_SENSITIVITY]
      curve: 'brush',
      friction_limit_angle: 7.012,
      peakSlipLoadGain: 0.059,
      peakSlipPressureGain: 0.5,
      curveFullness: 0.25,
      combinedExponent: 2.1,
      longStiffnessMult: 1.2,
      speedSensitivity: 0.0034,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 4.2,
      slip_ratio_limit: peakSlipRatio(7.012),
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [spec FALLOFF_LEVEL, FALLOFF_SPEED]
      use_slip_falloff: true,
      falloff_level: 0.8,
      falloff_slope: 2,
      // [spec RELAXATION_LENGTH]
      relaxationLengthX: 0.07475,
      relaxationLengthY: 0.07475,
      // 11.7 N + 0.00106 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
      rollingResistance: 0.011666,
      rollingResistanceSpeedSq: 1.06e-6,
      // Scrub at the peak slip, and no more past it [spec ROLLING_RESISTANCE_SLIP]
      rollingResistanceSlipGain: 5.51,
      rollingResistanceSlipMax: 1,
      // [spec DAMP]
      verticalDamping: 500,
      // [spec BRAKE_DX_MOD]
      brakeDxMod: 0.05,
    },
    thermalData: {
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]; the graining wears off as the tread slides
      tread: { grainGain: 0.5, grainGamma: 1, blisterGain: 0.5, blisterGamma: 1, wearOffWithSlip: true },
      // Pressure moves the heat: the sliding heat and the crown against the shoulders [ref], the rolling heat by
      // PRESSURE_RR_GAIN [spec]
      pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
      // The GT3 slick's heat capacities and cooling, as the 496R's [est]
      surfaceHeatCapacity: 1800,
      coreHeatCapacity: 11000,
      slipHeatShare: 0.35,
      hysteresis: 0.0072,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 85,
    },
    pressureData: {
      // [spec PRESSURE_IDEAL]
      optimalPsi: 28,
      pressureSpringCurve: pressureSpring(296_160),
      // [spec PRESSURE_RR_GAIN]
      pressureRollingGain: 0.55,
      pressureGripSensitivity: 1.0,
      // 0.4 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
      pressureGripLossPerPsi: 0.004,
      // Out of 60 °C blankets [spec ADDITIONAL1 BLANKETS_TEMP]. (Its 21 psi static pressure is the ambient set that reaches
      // 28 psi hot.)
      coldRefC: 60,
    },
    camberData: {
      // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]: the parabola peaks at 3.9° of camber, × 1.037, where the mod's own
      // camber table (DCAMBER_LUT) does
      camberGain: 0.11,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: 1.107,
      dcamber1: -8.195,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    // The rear's own grip tables, load sensitivity, peak slip angle and its growth, and camber curve [spec REAR]
    rearOverride: {
      modelData: {
        Fz0: FZ0,
        Dy0: grip.rear.y[4],
        Dx0: grip.rear.x[4],
        lsExpY: 0.75,
        lsExpX: 0.7875,
        dyCurve: loadTable(grip.rear.y),
        dxCurve: loadTable(grip.rear.x),
        friction_limit_angle: 6.813,
        peakSlipLoadGain: 0.046,
        slip_ratio_limit: peakSlipRatio(6.813),
        rollingResistance: 0.011754,
      },
      camberData: { dcamber0: 1.166, dcamber1: -8.91 },
    },
  };
}

/** km slid → grip (% of new) [spec Front_Wear_*.lut]: the same shape, stretched 1.3 × (medium) and 1.6 × (hard) */
const wearCurve = (lastKm: number): LutPoints =>
  [100, 98.9046, 97.6782, 96.8742, 96.3312, 95.8876, 95.382, 94.6526, 93.5382, 91.8771, 89.6078, 87].map((g, i) => [
    Number(((lastKm * i) / 11).toFixed(4)),
    g,
  ]);

const TYRES = {
  PhysicsTyreCompound_GT3_Soft: slick(
    'PhysicsTyreCompound_GT3_Soft',
    'Slick Soft',
    'S',
    COMPOUND_GRIP.soft,
    [
      [0, 0.9095],
      [25, 0.9352],
      [45, 0.9686],
      [55, 0.9846],
      [65, 0.9959],
      [70, 0.999],
      [75, 1],
      [80, 0.999],
      [85, 0.9959],
      [95, 0.9846],
      [105, 0.9686],
      [125, 0.9352],
    ],
    [70, 80],
    wearCurve(16)
  ),
  PhysicsTyreCompound_GT3_Medium: slick(
    'PhysicsTyreCompound_GT3_Medium',
    'Slick Medium',
    'M',
    COMPOUND_GRIP.medium,
    [
      [0, 0.9094],
      [30, 0.9397],
      [50, 0.9717],
      [60, 0.9863],
      [70, 0.9964],
      [75, 0.9991],
      [80, 1],
      [85, 0.9991],
      [90, 0.9964],
      [100, 0.9863],
      [110, 0.9717],
      [130, 0.9397],
    ],
    [75, 85],
    wearCurve(20.8)
  ),
  PhysicsTyreCompound_GT3_Hard: slick(
    'PhysicsTyreCompound_GT3_Hard',
    'Slick Hard',
    'H',
    COMPOUND_GRIP.hard,
    [
      [0, 0.9098],
      [35, 0.9448],
      [55, 0.9749],
      [65, 0.988],
      [75, 0.9968],
      [80, 0.9992],
      [85, 1],
      [90, 0.9992],
      [95, 0.9968],
      [105, 0.988],
      [115, 0.9749],
      [135, 0.9448],
    ],
    [80, 90],
    wearCurve(25.6)
  ),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/**
 * The slicks plus rain tyres on the medium's carcass, as the 496R's [est]: the mod has slicks only, and Assetto Corsa
 * has no water to model a tread for.
 */
const TYRES_WITH_RAIN = {
  ...TYRES,
  PhysicsTyreCompound_GT3_Intermediate: deriveRainCompound(TYRES.PhysicsTyreCompound_GT3_Medium, 'intermediate', 'PhysicsTyreCompound_GT3_Intermediate', 'Intermediate'),
  PhysicsTyreCompound_GT3_Wet: deriveRainCompound(TYRES.PhysicsTyreCompound_GT3_Medium, 'wet', 'PhysicsTyreCompound_GT3_Wet', 'Wet'),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Equivalent box 1.34 × 1.34 × 4.545 m [spec INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const NISSAN_R32_CONFIG = {
  screenName: 'Nissan Skyline GT-R R32 JTCC',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: FRONT_WEIGHT,
    // [spec WHEELBASE, TRACK]
    wheelbase: WHEELBASE,
    trackWidthFront: 1.584,
    trackWidthRear: 1.52,
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(1.34, 4.545), roll: box(1.34, 1.34), yaw: box(1.34, 4.545) },
    // [spec HUB_MASS]
    unsprungMassFront: 48,
    unsprungMassRear: 50,
    // The tank sits 1.85 m behind the CG, level with it [spec FUELTANK POSITION]
    fuelTank: { y: -0.003253641, z: -1.849837 },
    // [spec ANGULAR_INERTIA]
    wheelInertiaFront: 1.431,
    wheelInertiaRear: 1.767,
    // 360° lock each way on a 12.4:1 rack [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 360 / 12.4,
    // The kingpin (WBTYRE_BOTTOM → WBTYRE_TOP) leans back 3.7° and meets the ground 33 mm ahead of the contact patch [derived]
    ffbMechanicalTrailM: 0.033,
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 750 Nm clutch; the auto clutch bites at 1200 rpm and closes by 1800 [spec CLUTCH, AUTOCLUTCH]
  clutch: { maxTorqueNm: 750, biteRpm: 1200, lockRpm: 1800 },
  // The rear differential: locking torque = preload + POWER / COAST × input torque [spec AWD2 REAR_DIFF_*]. The
  // stability system brakes the faster wheel of each driven axle: up to 100 Nm on the power, none off it [spec EDL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.6, coast: 0.5, preload: 10, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
    brakeLock: { power: { torqueNm: 100, deadZone: 0.02, fullSpin: 0.1 }, coast: { torqueNm: 0, deadZone: 0.025, fullSpin: 0.2 } },
  },
  // ATTESA E-TS: the centre coupling hands the fronts 100 Nm per rad/s the rears run ahead of them, up to 1000 Nm, and
  // the front differential is all but open [spec AWD2 CENTRE_RAMP_TORQUE, CENTRE_MAX_TORQUE, FRONT_DIFF_*]
  awd: {
    centre: { rampNmPerRadS: 100, maxTorqueNm: 1000 },
    secondaryDiff: { power: 0.03, coast: 0.03, preload: 0, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // Iron discs, 2800 Nm at full pedal, 70 % front, bias adjustable in 0.5 % steps; the pads' grip is 98.6 % cold, full
  // at 500-600 °C and 98.9 % at 1200 (the same curve front and rear) [spec brakes.ini PERF_CURVE]. No handbrake
  brakes: {
    maxTorqueNm: 2800,
    front_bias: 0.7,
    ebbStep: 0.005,
    brakeByWire: false,
    discMaterial: 'endurance-steel',
    padMuCurve: [
      [0, 0.986],
      [100, 0.989],
      [200, 0.993],
      [300, 0.996],
      [400, 0.998],
      [500, 1],
      [600, 1],
      [700, 0.999],
      [800, 0.998],
      [900, 0.996],
      [1000, 0.994],
      [1100, 0.992],
      [1200, 0.989],
    ],
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
 * The car has no traction control or ABS (PRESENT=0), but the data sets both up: TC at 10 % wheelspin cycling at 120 Hz,
 * off under 40 km/h, ABS at 12.5 % cycling at 200 Hz [spec electronics.ini]. They serve the assisted presets (and the
 * semi-pro ABS, which the AI brakes on); the other switch positions step 0.5 % either side [est]. The lateral and rear
 * slide terms are the 496R's [est]
 */
export const NISSAN_R32_ELECTRONICS = {
  absLevels: [0.095, 0.1, 0.105, 0.11, 0.115, 0.12, 0.125, 0.13, 0.135, 0.14, 0.145, 0.15],
  absDefault: 0.125,
  absRateHz: 200,
  tcLevels: [0.07, 0.075, 0.08, 0.085, 0.09, 0.095, 0.1, 0.105, 0.11, 0.115, 0.12, 0.125],
  tcDefault: 0.1,
  tcRateHz: 120,
  tcMinSpeedKmh: 40,
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
