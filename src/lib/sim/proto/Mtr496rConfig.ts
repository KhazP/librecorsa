/**
 * MTRacing 496R (2025) vehicle data for `VehiclePhysics` (same data model as the f12026-car, see `F12026CarConfig`): a
 * fictional closed-cockpit prototype with a 4.0 L naturally aspirated V8, rear-wheel drive and hypercar-level aero.
 *
 * The numbers come from munyuturbo's MTRacing 496R v0.9 (OverTake, Assetto Corsa), mapped onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * No hybrid, DRS (its drs.ini is empty) or ABS (electronics.ini has traction control only). Double wishbones with a
 * heave spring on each axle, three slicks, and four aero elements: a front splitter and a diffuser that work in ground
 * effect, a rear wing, and the body, which only drags. The mod's fin element points at tables the car doesn't ship, so
 * Assetto Corsa reads it as nothing; it is left out.
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

/** Wheel torque curve (rpm → Nm) [spec power.lut]: 457 Nm at 8300 rpm, ≈ 410 kW at the wheels at 8900 */
const WHEEL_TORQUE: [number, number][] = [
  [0, 100],
  [500, 192.3],
  [1000, 235.8],
  [1315, 247.3],
  [1500, 252.8],
  [2000, 266],
  [2500, 280.1],
  [3000, 299.9],
  [3500, 328.8],
  [4000, 348.4],
  [4500, 372],
  [5000, 399.1],
  [5500, 420],
  [6000, 443.3],
  [6500, 448.7],
  [7000, 442.5],
  [7500, 452.6],
  [8000, 454.6],
  [8300, 456.6],
  [8500, 454.1],
  [8900, 439.4],
  [9500, 403.6],
  [10000, 356.9],
  [10500, 243.2],
  [10800, 0],
];

/** Crank power (kW) at the curve's points [derived] */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, ((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque, 120 Nm at 9600 rpm [spec COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [9600, 120],
    [10800, 135],
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
  // Drive-by-wire and intake filling, as the GT3's [est]
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  // [spec MINIMUM]
  idleRpm: 2100,
  // Engine 0.130 + gearbox 0.012 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.142,
  // 25 Hz limiter: half a cycle cut [spec LIMITER_HZ]
  limiterCutS: 0.02,
};

const NONE: LutPoints = [
  [0, 0],
  [11000, 0],
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
 * Six-speed paddle-shift sequential on a 4.0 final drive [spec drivetrain.ini; its GEAR_7 line is past COUNT=6 and
 * unused]: ≈ 338 km/h in sixth at the 10 000 rpm limiter, past the drag-limited top speed. The ignition cuts for the
 * 60 ms auto-cutoff of an up-shift [spec AUTO_CUTOFF_TIME]
 */
const GEARBOX = {
  ratios: [2.511, 1.955, 1.582, 1.328, 1.131, 0.989],
  reverse: 2.5,
  finalDrive: 4.0,
  shiftTimeS: 0.06,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.1,
  shiftTorqueFraction: 0.1,
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 10_000,
    // [spec AUTO_SHIFTER UP]
    upshift_rpm: 8850,
    // [spec AUTO_SHIFTER DOWN]
    downshift_rpm: 6800,
    // Into a braking zone the auto box clicks down while the lower gear lands under 8500 rpm, near peak power [est]
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

const MASS = 1025;
const WHEELBASE = 2.8;
/** Share of the sprung weight on the front axle [spec CG_LOCATION] */
const FRONT_WEIGHT = 0.485;
/** Sprung load on a front / rear spring at static ride (N): the car less its hubs (36 / 39 kg) [derived] */
const SPRUNG_KG = MASS - 2 * 36 - 2 * 39;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * FRONT_WEIGHT) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * (1 - FRONT_WEIGHT)) / 2;
/** Tyre radial rate at the 35 psi it runs at (N/m): 254 300 at 26 psi + 5233 per psi [spec RATE, PRESSURE_SPRING_GAIN] */
const HOT_TYRE_RATE = 254_300 + 5233 * 9;
/**
 * The mod measures its stops from the suspension's design position, with the springs working on their rod lengths
 * (`mod-suspension.ts`): at static ride the fronts sit 1.9 mm into their travel and the rears 11.4 mm, so the stops are
 * these far from static [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN of FRONT / REAR / HEAVE_*; derived]
 */
const FRONT_STOPS = modCornerStops({
  staticLoadN: FRONT_STATIC_LOAD_N,
  springRate: 120_000,
  rodLength: 0.005,
  packerRange: 0.02,
  bumpStopUp: 0.055,
  bumpStopDn: 0.055,
  heave: { springRate: 120_000, rodLength: 0.02, packerRange: 0.1, bumpStopUp: 0.06 },
});
const REAR_STOPS = modCornerStops({
  staticLoadN: REAR_STATIC_LOAD_N,
  springRate: 90_000,
  rodLength: 0,
  packerRange: 0.05,
  bumpStopUp: 0.05,
  bumpStopDn: 0.05,
  heave: { springRate: 150_000, rodLength: 0.005, packerRange: 0.08, bumpStopUp: 0.08 },
});
const mm = (m: number) => Number(m.toFixed(4));

/**
 * Double wishbones front and rear with a heave spring on each axle: the mod's wheel rates, anti-roll bars, bump stops,
 * packers and two-stage dampers [spec suspensions.ini], the stops at their distance from static ride (above). The
 * front's packers, 13 mm up, are the first stop its wheels meet, its bump stop 53 mm up the second; the rear's packer
 * and bump stop come in together 39 mm up. The heave elements carry their share of the weight at static (their springs
 * are preloaded by their rod); a heave element's own bump stop is rigid (500 kN/m), the front's 58 mm up, the rear's
 * behind its 150 kN/m packer at 64 mm. Hardpoints are [x inboard, y up, z forward] from the wheel centre [spec]; camber
 * gain and roll-centre heights are what the kinematic solver gives on them at static [derived].
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -2.1,
    camberGainKinematic: -26.8,
    springs: { wheel_rate: 120_000, helper_rate: 0, helper_range: 0 },
    // [spec HEAVE_FRONT SPRING_RATE, PROGRESSIVE_SPRING_RATE, BUMPSTOP_UP]
    heave: { rate: 120_000, gap: 0, packerGap: mm(FRONT_STOPS.heaveBumpStopGapM), packerRate: 500_000, progressiveRate: 10_000 },
    // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(FRONT_STOPS.packerGapM), rate: 150_000, progression: 0, hardStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 150_000 } },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.0527,
    // [spec ARB FRONT]
    arb: 120_000,
    hardpoints: [
      [0.4592, 0.08933, 0.1029],
      [0.4592, 0.08786, -0.3122],
      [0.5233, -0.1593, 0.1761],
      [0.5233, -0.1408, -0.2271],
      [0.108, 0.14802, -0.0331],
      [0.0418, -0.141, 0.013],
      [0.48, 0.0451, 0.1845],
      [0.04058, 0.1003, 0.1],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -1.75,
    camberGainKinematic: -35.7,
    springs: { wheel_rate: 90_000, helper_rate: 0, helper_range: 0 },
    // [spec HEAVE_REAR SPRING_RATE, PROGRESSIVE_SPRING_RATE, PACKER_RANGE, BUMP_STOP_RATE]
    heave: { rate: 150_000, gap: 0, packerGap: mm(REAR_STOPS.heavePackerGapM), packerRate: 150_000, progressiveRate: 10_000 },
    // The packer and the bump stop meet at the same travel: twice the rate [spec PACKER_RANGE = BUMPSTOP_UP, BUMP_STOP_RATE]
    bumpStop: { range: mm(REAR_STOPS.packerGapM), rate: 300_000, progression: 0 },
    // [spec BUMPSTOP_DN]
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: 0.1203,
    // [spec ARB REAR]
    arb: 20_000,
    hardpoints: [
      [0.4614, 0.05858, 0.4],
      [0.5546, 0.06058, 0.06803],
      [0.5102, -0.095, 0.44],
      [0.6606, -0.095, -0.0963],
      [0.0816, 0.1353, 0.0828],
      [0.0036, -0.0889, 0.015],
      [0.6646, -0.05352, -0.1753],
      [0.0906, -0.02552, -0.1293],
    ],
  },
  dampers_controller: {
    front: {
      base: damper(9000, 3400, 5000, 4000),
      // [spec HEAVE_FRONT DAMP_*, DAMP_FAST_BUMPTHRESHOLD / REBOUNDTHRESHOLD]
      heave: damper(4660, 1700, 5610, 2660),
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.1,
      fastReboundThresholdMs: 0.1,
      heaveFastThresholdMs: 0.088,
      heaveFastReboundThresholdMs: 0.18,
    },
    rear: {
      base: damper(7500, 3000, 8400, 4000),
      // [spec HEAVE_REAR DAMP_*, DAMP_FAST_BUMPTHRESHOLD / REBOUNDTHRESHOLD]
      heave: damper(4850, 1340, 5040, 2180),
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.1,
      fastReboundThresholdMs: 0.1,
      heaveFastThresholdMs: 0.088,
      heaveFastReboundThresholdMs: 0.18,
    },
  },
};

/**
 * The body's height at each axle is the tyre's loaded radius less the wheel centre's height in the body frame (BASEY
 * 0.085 / 0.080 above the CG's level, plus the static offset): 0.245 m at the front, 0.255 m at the rear, so the CG,
 * 48.5 % of the weight forward, rides 0.250 m up [spec BASEY, RADIUS; derived]. The ride-height pickups sit 0.181 m
 * (front) and 0.170 m (rear) below the CG's level [spec RIDE]: 64 / 85 mm off the ground at rest, where the splitter's
 * and the diffuser's ground-effect tables (25-140 mm) work.
 */
const FRONT_BODY_HEIGHT = modBodyHeightM(0.34, FRONT_STATIC_LOAD_N / HOT_TYRE_RATE + (36 * 9.81) / HOT_TYRE_RATE, 0.085, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(0.355, REAR_STATIC_LOAD_N / HOT_TYRE_RATE + (39 * 9.81) / HOT_TYRE_RATE, 0.08, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * (1 - FRONT_WEIGHT)).toFixed(4));
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT - 0.181).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT - 0.17).toFixed(4));
/** Static rake (deg) [derived] */
const STATIC_RAKE_DEG = (Math.asin((REAR_TARGET_HEIGHT - FRONT_TARGET_HEIGHT) / WHEELBASE) * 180) / Math.PI;

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
/** The floor reads its angle with the body's rake added, which AC's diffuser doesn't at rest: its table shifts by it */
const toRake = (lut: LutPoints): LutPoints => shiftX(lut, STATIC_RAKE_DEG);

/** Splitter and diffuser span 1.5 m, rear wing 1.7 m, all on a 1 m chord [spec aero.ini] */
const SPLITTER_AREA = 1.5;
const DIFFUSER_AREA = 1.5;
const REAR_WING_AREA = 1.7;
/**
 * The body element: chord 1 × span 1.9 m, CD 0.496 at 0° × CD_GAIN 1.03, no lift [spec WING_0]. Its ground-height
 * drag table runs from 0.30 to 0.47 m, the element's own height (0.20 m above the CG, ≈ 0.48 m at rest): 1.08 at the
 * ≈ 0.465 m it rides at on a straight [derived height_body_CD.lut]
 */
const BODY_CDA = 0.496 * 1.03 * 1.9 * 1.08;

/**
 * Splitter, diffuser and rear wing with the mod's angle-of-attack and ground-height tables, their gains folded in
 * [spec aero.ini]; the body's drag as a constant. Each element's ground height is its own: the splitter sits 4 mm below
 * the front pickup, so its table moves by that; the diffuser is level with the pickups' mean. The yaw tables are the
 * elements' YAW_CL_GAIN. At rest, CL·A ≈ 2.6 m² (0.84 splitter, 1.43 rear wing, 0.3 diffuser) for CD·A ≈ 1.2 m²; the
 * diffuser comes in as the car settles at speed (≈ 1.3 m² of CL·A at 70 mm).
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: BODY_CDA,
  // The body's drag acts 0.20 m above the CG and the rear wing's 0.61 m [spec POSITION]: ≈ 0.24 m for the sum [derived]
  dragCentreY: 0.24,
  wings: [
    {
      name: 'FRONT_WING',
      area: SPLITTER_AREA,
      // [spec WING_1 POSITION, ANGLE]
      positionZ: 2.42,
      angleDeg: 1,
      heightRef: 'front',
      lutAOA_CL: gain(
        [
          [-10, -0.02],
          [-2, 0.46],
          [0, 0.465],
          [1, 0.475],
          [2, 0.48],
          [4, 0.49],
          [8, 0.545],
          [12, 0.565],
          [16, 0.615],
        ],
        1.2
      ),
      lutAOA_CD: [
        [-10, 0],
        [-2, 0.015],
        [0, 0],
        [2, 0.01],
        [5, 0.03],
        [8, 0.06],
        [10, 0.09],
        [12, 0.12],
        [14, 0.15],
      ],
      lutGH_CL_mult: shiftX(
        [
          [0, 0],
          [0.02, 0],
          [0.025, 1.28],
          [0.035, 1.07],
          [0.045, 1.06],
          [0.055, 1.05],
          [0.065, 1],
          [0.075, 1],
          [0.0854, 1],
          [0.095, 1],
          [0.105, 0.95],
          [0.115, 0.9],
          [0.13, 0.8],
          [0.14, 0.7],
        ],
        0.004
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
        0.004
      ),
      lutYaw_CL_mult: yawTable(-0.04),
    },
    {
      name: 'VENTURI_FLOOR',
      area: DIFFUSER_AREA,
      // [spec WING_3 POSITION, ANGLE 0]
      positionZ: -0.22,
      angleDeg: 0,
      heightRef: 'mean',
      lutAOA_CL: toRake(
        gain(
          [
            [-10, -0.1],
            [-2, 0.54],
            [0, 0.9],
            [2, 1],
            [8, 0.9],
            [10, 0.8],
            [12, 0.6],
            [14, 0.5],
            [16, 0.4],
            [20, 0.3],
            [24, 0],
            [26, 0],
          ],
          0.93
        )
      ),
      lutAOA_CD: toRake([
        [-10, 0],
        [0, 0],
        [1, 0],
        [3, 0.06],
        [5, 0.08],
        [8, 0.08],
        [10, 0.1],
        [30, 0.1],
      ]),
      lutGH_CL_mult: [
        [0, 0],
        [0.02, 0],
        [0.035, 1.1],
        [0.04, 1],
        [0.06, 0.95],
        [0.07, 0.9],
        [0.08, 0.65],
        [0.1, 0.25],
        [0.12, 0.1],
        [0.14, 0.05],
      ],
      lutGH_CD_mult: [
        [0, 0.97],
        [0.005, 0.99],
        [0.01, 0.994],
        [0.02, 0.998],
        [0.03, 1],
        [0.04, 1.002],
        [0.05, 1.004],
        [0.06, 1.006],
      ],
      lutYaw_CL_mult: yawTable(-1.16),
    },
    {
      name: 'REAR_WING',
      area: REAR_WING_AREA,
      // [spec WING_2 POSITION, ANGLE 8 of the setup's 1–15]
      positionZ: -1.8,
      angleDeg: 8,
      heightRef: 'rear',
      lutAOA_CL: gain(
        [
          [-10, -0.18],
          [-2, 0.04],
          [0, 0.4],
          [1, 0.55],
          [4, 0.605],
          [6, 0.65],
          [8, 0.7],
          [12, 0.74],
          [16, 0.78],
        ],
        1.2
      ),
      lutAOA_CD: gain(
        [
          [-10, 1],
          [-2, 0.0025],
          [0, 0.01],
          [1, 0.015],
          [4, 0.02],
          [8, 0.035],
          [12, 0.05],
          [16, 0.065],
        ],
        2
      ),
      lutGH_CL_mult: [
        [0, 1],
        [0.3, 1],
      ],
      lutGH_CD_mult: [
        [0, 1],
        [0.3, 1],
      ],
      lutYaw_CL_mult: yawTable(-0.25),
    },
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane level with the pickups' mean, 0.1755 m below the CG [derived]
  floorOffsetY: -(CG_HEIGHT - 0.5 * (FRONT_TARGET_HEIGHT + REAR_TARGET_HEIGHT)),
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/**
 * Front 0.290 × R 0.340, rear 0.340 × R 0.355, rim R 0.2413; the radius grows 0.025 mm per rad/s of spin, 6 mm at
 * 300 km/h [spec tyres.ini RADIUS_ANGULAR_K]
 */
const PROTO_FRONT: TyreGeometry = { width: 0.29, radius: 0.34, rimRadius: 0.2413, verticalRateScale: 1, radiusGrowthPerRadS: 2.5e-5 };
const PROTO_REAR: TyreGeometry = { width: 0.34, radius: 0.355, rimRadius: 0.2413, verticalRateScale: 1, radiusGrowthPerRadS: 2.5e-5 };

/** The tyres' reference load [spec FZ0] */
const FZ0 = 3000;

/** The mod's load-sensitivity tables (N → peak μ) [spec Soft / Medium / Hard_Comp_y / _x.lut] */
const LOADS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000];
const loadTable = (mu: number[]): LutPoints => LOADS.map((fz, i) => [fz, mu[i]]);
const COMPOUND_GRIP = {
  soft: {
    y: [2.023, 1.94, 1.86, 1.783, 1.711, 1.645, 1.584, 1.529, 1.477, 1.428, 1.382, 1.339, 1.3, 1.265, 1.234, 1.208, 1.187, 1.172, 1.162, 1.153, 1.15],
    x: [1.936, 1.869, 1.804, 1.744, 1.686, 1.636, 1.592, 1.551, 1.514, 1.478, 1.447, 1.417, 1.393, 1.372, 1.355, 1.341, 1.33, 1.32, 1.311, 1.302, 1.296],
  },
  medium: {
    y: [2.003, 1.921, 1.841, 1.765, 1.694, 1.629, 1.568, 1.514, 1.462, 1.414, 1.368, 1.326, 1.287, 1.252, 1.222, 1.196, 1.175, 1.16, 1.15, 1.141, 1.139],
    x: [1.917, 1.85, 1.786, 1.727, 1.669, 1.62, 1.576, 1.535, 1.499, 1.463, 1.433, 1.403, 1.379, 1.358, 1.341, 1.328, 1.317, 1.307, 1.298, 1.289, 1.283],
  },
  hard: {
    y: [1.983, 1.901, 1.823, 1.747, 1.677, 1.612, 1.552, 1.498, 1.447, 1.399, 1.354, 1.312, 1.274, 1.24, 1.209, 1.184, 1.163, 1.149, 1.139, 1.13, 1.127],
    x: [1.897, 1.832, 1.768, 1.709, 1.652, 1.603, 1.56, 1.52, 1.484, 1.448, 1.418, 1.389, 1.365, 1.345, 1.328, 1.314, 1.303, 1.294, 1.285, 1.276, 1.27],
  },
};

/** Radial stiffness against inflation (psi gauge → N/m): RATE at the 26 psi static pressure + 5233 N/m per psi [spec] */
const pressureSpring = (rate: number): LutPoints => [15, 20, 26, 30, 35, 40, 45].map((p) => [p, Math.round(rate + 5233 * (p - 26))]);

function protoCompound(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  grip: { y: number[]; x: number[] },
  /** RATE [spec] */
  rate: number,
  thermalCurve: LutPoints,
  window: [number, number],
  /** Grip (% of new) against km slid [spec Wear_*.lut] */
  wearCurve: LutPoints
): TyresCompoundData {
  const dyCurve = loadTable(grip.y);
  const dxCurve = loadTable(grip.x);
  return {
    name,
    shortName,
    tyre_compound,
    wear: { curve: wearCurve },
    front: PROTO_FRONT,
    rear: PROTO_REAR,
    modelData: {
      // The tables at FZ0, and the power law the tables replace [spec FZ0, LS_EXPY, LS_EXPX]
      Dy0: grip.y[3],
      Dx0: grip.x[3],
      lsExpY: 0.72,
      lsExpX: 0.86,
      Fz0: FZ0,
      dyCurve,
      dxCurve,
      // A brush tyre, on the mod's own shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], its growth with load
      // (6.2 % per FZ0) and with a soft tyre [spec FLEX_GAIN, PRESSURE_FLEX_GAIN], the combined-slip exponent
      // [spec COMBINED_FACTOR], the longitudinal stiffness [spec CX_MULT] and the grip lost to sliding speed
      // [spec SPEED_SENSITIVITY]
      curve: 'brush',
      friction_limit_angle: 6.216,
      peakSlipLoadGain: 0.0621,
      peakSlipPressureGain: -0.06,
      combinedExponent: 2.23,
      longStiffnessMult: 1.24,
      speedSensitivity: 0.002,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 4.2,
      // Slip ratio at the peak of the drive force: tan(6.216°) / 1.24 of theoretical slip [derived]. The mod's TC
      // (9 % default) sits just under it
      slip_ratio_limit: 0.096,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [spec FALLOFF_LEVEL, FALLOFF_SPEED]
      use_slip_falloff: true,
      falloff_level: 0.86,
      falloff_slope: 4,
      // [spec RELAXATION_LENGTH]
      relaxationLengthX: 0.1,
      relaxationLengthY: 0.1,
      // 5 N + 0.00039 N·s²/m² per kN of load [spec ROLLING_RESISTANCE_0 / _1]
      rollingResistance: 0.005,
      rollingResistanceSpeedSq: 3.9e-7,
      // 2.2 % more at the peak slip [spec ROLLING_RESISTANCE_SLIP]
      rollingResistanceSlipGain: 0.022,
      // [spec DAMP]
      verticalDamping: 540,
      pneumaticTrail: 0.04,
      // [spec BRAKE_DX_MOD]
      brakeDxMod: 0.1,
    },
    thermalData: {
      // Grip against tread temperature (°C) [spec tcurve_*.lut]
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]
      tread: { grainGain: 0.5, grainGamma: 1, blisterGain: 0.5, blisterGamma: 1 },
      // The GT3 slick's heat capacities and cooling [est]
      surfaceHeatCapacity: 1800,
      coreHeatCapacity: 11000,
      slipHeatShare: 0.35,
      hysteresis: 0.0038,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 85,
    },
    pressureData: {
      // [spec PRESSURE_IDEAL]
      optimalPsi: 35,
      pressureSpringCurve: pressureSpring(rate),
      // [spec PRESSURE_RR_GAIN]
      pressureRollingGain: 0.97,
      pressureGripSensitivity: 1.0,
      // 0.2 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
      pressureGripLossPerPsi: 0.002,
      // Out of 60 °C blankets, as the GT3's, the way AC's default tyre-blanket assist starts them: the mod's curves give
      // 71 % grip at 25 °C [est]. (Its 26 psi static pressure is the ambient set that reaches 35 psi hot.)
      coldRefC: 60,
    },
    camberData: {
      // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]
      camberGain: 0.1488,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: 1.102,
      dcamber1: -7.891,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    // The 340 mm rear: the same reference load and tables [spec REAR], its own stiffness peak (≈ 15.3 kN, 1.08 × the
    // GT3's 325 mm rear) [est]
    rearOverride: {
      modelData: { Fz0: FZ0, pKy2: 5.1 },
    },
  };
}

const TYRES = {
  PhysicsTyreCompound_Proto_Soft: protoCompound(
    'PhysicsTyreCompound_Proto_Soft',
    'Slick Soft',
    'S',
    COMPOUND_GRIP.soft,
    254_300,
    [
      [0, 0.7],
      [20, 0.7],
      [30, 0.72],
      [45, 0.8],
      [60, 0.95],
      [70, 1],
      [80, 1],
      [85, 1],
      [100, 0.96],
      [120, 0.88],
      [140, 0.8],
      [240, 0.8],
      [300, 0.6],
    ],
    [70, 85],
    [[0, 99.5], [0.72, 100], [4, 100], [12, 99], [20, 98], [30, 96.4], [36, 94], [48, 90.5], [60, 80], [70, 70], [71, 20]]
  ),
  PhysicsTyreCompound_Proto_Medium: protoCompound(
    'PhysicsTyreCompound_Proto_Medium',
    'Slick Medium',
    'M',
    COMPOUND_GRIP.medium,
    354_300,
    [
      [0, 0.7],
      [20, 0.7],
      [30, 0.72],
      [45, 0.8],
      [60, 0.92],
      [70, 0.97],
      [80, 1],
      [88, 1],
      [95, 0.99],
      [100, 0.97],
      [120, 0.88],
      [140, 0.8],
      [240, 0.8],
      [300, 0.6],
    ],
    [80, 88],
    [[0, 99.5], [0.48, 100], [4.8, 100], [14, 99.7], [20, 99], [30, 97.4], [36, 95.7], [48, 92.5], [60, 81], [70, 72], [71, 22]]
  ),
  PhysicsTyreCompound_Proto_Hard: protoCompound(
    'PhysicsTyreCompound_Proto_Hard',
    'Slick Hard',
    'H',
    COMPOUND_GRIP.hard,
    424_300,
    [
      [0, 0.7],
      [20, 0.7],
      [30, 0.72],
      [45, 0.8],
      [60, 0.92],
      [70, 0.98],
      [80, 1],
      [90, 1],
      [102, 0.99],
      [120, 0.92],
      [140, 0.82],
      [160, 0.8],
      [240, 0.8],
      [300, 0.6],
    ],
    [80, 90],
    [[0, 99.8], [0.48, 100], [7.2, 100], [20, 99.6], [28.8, 98.5], [48, 96], [62.4, 94], [65, 89], [75, 75], [80, 74], [81, 20]]
  ),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/**
 * The slicks plus rain tyres on the medium's carcass, as the GT3's [est]. The mod's own "Wet" is the hard slick's grip
 * with a cooler window: Assetto Corsa has no water, so it has no tread to model.
 */
const TYRES_WITH_RAIN = {
  ...TYRES,
  PhysicsTyreCompound_Proto_Intermediate: deriveRainCompound(
    TYRES.PhysicsTyreCompound_Proto_Medium,
    'intermediate',
    'PhysicsTyreCompound_Proto_Intermediate',
    'Intermediate'
  ),
  PhysicsTyreCompound_Proto_Wet: deriveRainCompound(TYRES.PhysicsTyreCompound_Proto_Medium, 'wet', 'PhysicsTyreCompound_Proto_Wet', 'Wet'),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Equivalent box 1.9 × 0.9 × 4.5 m [spec INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const MTR_496R_CONFIG = {
  screenName: 'MTRacing 496R',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: FRONT_WEIGHT,
    // [spec WHEELBASE, TRACK]
    wheelbase: WHEELBASE,
    trackWidthFront: 1.54,
    trackWidthRear: 1.55,
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(0.9, 4.5), roll: box(1.9, 0.9), yaw: box(1.9, 4.5) },
    // [spec HUB_MASS]
    unsprungMassFront: 36,
    unsprungMassRear: 39,
    // The tank sits 0.10 m behind the CG, level with it [spec FUELTANK POSITION]
    fuelTank: { y: 0, z: -0.1 },
    // [spec ANGULAR_INERTIA]
    wheelInertiaFront: 1.8,
    wheelInertiaRear: 1.8,
    // 240° lock each way on a 14:1 rack [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 240 / 14,
    // The kingpin (WBTYRE_BOTTOM → WBTYRE_TOP) leans back 9.1° and meets the ground 45 mm ahead of the contact patch [derived]
    ffbMechanicalTrailM: 0.045,
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 1000 Nm clutch; the auto clutch bites at 1800 rpm and closes by 1900 [spec CLUTCH, AUTOCLUTCH]
  clutch: { maxTorqueNm: 1000, biteRpm: 1800, lockRpm: 1900 },
  // Locking torque = preload + POWER / COAST × input torque [spec DIFFERENTIAL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.3, coast: 0.55, preload: 60, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // 5900 Nm at full pedal, 58 % front, bias adjustable in 0.5 % steps; the pads' grip peaks at 400 °C and is 80 % of it
  // cold, like steel discs [spec brakes.ini]
  brakes: { maxTorqueNm: 5900, front_bias: 0.58, ebbStep: 0.005, brakeByWire: false, discMaterial: 'endurance-steel', migration: { amount: 0, rampStart: 0 } },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: TYRES_WITH_RAIN,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_Proto_Soft',
    medium: 'PhysicsTyreCompound_Proto_Medium',
    hard: 'PhysicsTyreCompound_Proto_Hard',
    intermediate: 'PhysicsTyreCompound_Proto_Intermediate',
    wet: 'PhysicsTyreCompound_Proto_Wet',
  },
} satisfies CarPhysicsConfig;

/**
 * Traction control at 9 % wheelspin by default, cycling at 360 Hz, off under 50 km/h [spec electronics.ini]; its other
 * positions step 0.5 % from 12 % to 6 % [spec traction_control.lut]. The car has no ABS: the ABS table is the GT3's, for
 * the assisted preset only [est].
 */
export const MTR_496R_ELECTRONICS = {
  absLevels: [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17],
  absDefault: 0.09,
  absRateHz: 240,
  tcLevels: [0.06, 0.065, 0.07, 0.075, 0.08, 0.085, 0.09, 0.095, 0.1, 0.105, 0.11, 0.12],
  tcDefault: 0.09,
  tcRateHz: 360,
  tcMinSpeedKmh: 50,
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
