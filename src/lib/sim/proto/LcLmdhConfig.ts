/**
 * LC-LMDH (LibreCorsa LMDh Prototype) vehicle data for `VehiclePhysics` (same data model as the f12026-car, see
 * `F12026CarConfig`): a closed-cockpit endurance prototype to the LMDh technical regulations, with a twin-turbo V8, the
 * class's spec hybrid system on a seven-speed spec gearbox, rear-wheel drive and brake-by-wire rear brakes.
 *
 * Where each number comes from:
 *  - [spec]     read from a retrieved document: the LMDh technical regulations (19 October 2026 issue), the article
 *               named, or where said the spec gearbox's published data or a simulator's manual for the car
 *  - [claim]    a published balance-of-performance or supplier figure taken from the car's brief, whose source
 *               document was not retrieved: to be checked against the bulletin before it is relied on
 *  - [est]      an estimate: nothing public gives it (centre of gravity, inertia, gear ratios, spring and damper
 *               rates, the aero map, the tyres)
 *  - [derived]  computed from other values in this file
 *
 * The regulations cap the power at the driveshafts (engine and hybrid together) on a curve against engine speed, so
 * the engine here is trimmed while the motor deploys (`EngineData.outputPowerCap`): the hybrid fills the turbos' lag
 * and brakes the rear axle, and adds no power at the limit. No ABS (Art. 11.5.1); traction control is allowed
 * (Art. 9.3).
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

/**
 * Measured on the car's body (`scripts/cars/port_lmdh_body.py` writes them to `artifacts/lmdh_hardpoints.json`, scaled
 * to the 3148 mm wheelbase): the track widths, and each axle's tyre radius and width (m). The model is 28 mm wider than
 * the 2000 mm the regulations allow (Art. 3.1.2), so the tracks are ≈ 1.4 % wide of a real car's, and its rear tyre
 * stands 4 mm over the 28 in the regulations allow (Art. 12.3.1): the physics follows the body, so the wheels sit in
 * their arches and on the road. Copy the file's numbers here when the body is rebuilt
 */
export const LC_LMDH_HARDPOINTS = {
  trackWidthFront: 1.69096,
  trackWidthRear: 1.62913,
  wheelRadiusFront: 0.35056,
  wheelRadiusRear: 0.3594,
  tyreWidthFront: 0.295,
  tyreWidthRear: 0.358,
};

/** Gearbox and final-drive efficiency [est]. The regulated power is measured after it, at the driveshafts */
const DRIVELINE_EFFICIENCY = 0.94;

/**
 * The engine speed the regulated power curve is normalised to (rpm) [spec: a simulator's manual for the car, not the
 * balance-of-performance bulletin, which was not retrieved]; engines may not exceed 10 000 rpm (Art. 5.2.1) [spec]
 */
const N_MAX = 8158;

/**
 * The regulated power curve at the wheels (Art. 5.1.2) [spec]: N / Nmax → kW on its 500 kW line. It peaks at
 * 0.95 Nmax; under 0.55 Nmax the power must stay below the curve's first point; the table ends at 1.025 Nmax
 */
const POWER_CURVE_500: [number, number][] = [
  [0.55, 246],
  [0.575, 269],
  [0.6, 289],
  [0.625, 309],
  [0.65, 330],
  [0.675, 351],
  [0.7, 372],
  [0.725, 393],
  [0.75, 413],
  [0.775, 432],
  [0.8, 449],
  [0.825, 464],
  [0.85, 475],
  [0.875, 485],
  [0.9, 492],
  [0.925, 497],
  [0.95, 500],
  [0.975, 498],
  [1.0, 495],
  [1.025, 427],
];

/**
 * The car's peak on that curve (kW) [claim: balance-of-performance bulletin]: 507 kW up to 230 km/h and 506 kW from
 * 240 km/h, in a straight line between. The whole curve scales with it
 */
const P_MAX_KW = 507;
const POWER_SCALE_VS_KMH: LutPoints = [
  [0, P_MAX_KW / 500],
  [230, P_MAX_KW / 500],
  [240, 506 / 500],
  [400, 506 / 500],
];

/** The limit at the driveshafts on the 500 kW line (rpm → kW), held at its first point below 0.55 Nmax [derived] */
const SHAFT_POWER_CAP: LutPoints = [[0, POWER_CURVE_500[0][1]], ...POWER_CURVE_500.map(([n, kw]) => [Math.round(n * N_MAX), kw] as [number, number])];

/** The limiter: the end of the regulated curve, 1.025 Nmax [derived] */
const LIMITER_RPM = Math.round(1.025 * N_MAX);

/**
 * What the engine can make on its own at the crank (rpm → kW) [est]: 5 % over the car's limit through the gearbox's
 * losses from 0.55 Nmax up, so the limit is what the car runs on with or without the hybrid, and a twin-turbo V8's
 * rising torque below it (≈ 590 Nm at 4500 rpm)
 */
const ENGINE_MARGIN = 1.05;
const POWER_CURVE: LutPoints = [
  [0, 0],
  [1000, 21],
  [2000, 80],
  [3000, 157],
  [4000, 243],
  ...POWER_CURVE_500.map(
    ([n, kw]) => [Math.round(n * N_MAX), Number(((kw * (P_MAX_KW / 500) * ENGINE_MARGIN) / DRIVELINE_EFFICIENCY).toFixed(1))] as [number, number]
  ),
  [LIMITER_RPM + 250, 380],
  [LIMITER_RPM + 600, 0],
];

const ENGINE = {
  powerCurve: POWER_CURVE,
  outputPowerCap: { curve: SHAFT_POWER_CAP, vsSpeedKmh: POWER_SCALE_VS_KMH },
  // Linear overrun torque: 50 kW of engine braking at Nmax [claim], 58.5 Nm there [derived]
  coastCurve: [
    [0, 0],
    [2000, 0],
    [N_MAX, 58.5],
    [LIMITER_RPM + 600, 63],
  ] as LutPoints,
  // A linear pedal: the engine control is torque-based (Art. 5.2.3) [spec]
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ] as LutPoints,
  // Drive-by-wire actuator and intake filling [est]; the turbos' lag is its own (below)
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  // Two turbos on a 4.6 L V8 [est]: 1 bar of boost made from 3500 rpm, spooling in ≈ 0.25 s at 5000 rpm and running
  // down in 0.5 s off the pedal. The hybrid motor fills what the lag costs while it may deploy
  turbo: { maxBoost: 1, referenceRpm: 3500, gamma: 1.5, spoolUpS: 0.25, spoolRefRpm: 5000, spoolDownS: 0.5, displayMaxBoostBar: 1 },
  idleRpm: 2000,
  // Crank, flywheel, clutch and the motor's rotor through its gear [est]
  inertia: 0.165,
  // 25 Hz limiter: the cut lasts one cycle [est]
  limiterCutS: 0.04,
};

/**
 * The spec hybrid system: one motor-generator on the gearbox's clutch shaft (Art. 5.3.2) [spec], so here on the crank
 * whenever the clutch is closed. 50 kW of deployment [spec: the spec gearbox's published data; the regulations leave
 * the figure to the balance of performance] and 200 kW of regeneration [claim], on a 1.35 kWh store [claim] with 3.6 MJ
 * of usable charge [est]. The regulations do not ration its energy by lap or distance (Art. 5.3.10) [spec]: no per-lap
 * allowance. Regeneration is on the brake pedal only [est: the regulations also allow it off the throttle]
 */
const ERS = {
  // The motor's torque at the crank [est]; the power limits bind above ≈ 3400 rpm (deploy) and 6000 rpm (harvest)
  torqueLut: [
    [0, 140],
    [10_000, 140],
  ] as LutPoints,
  coastLut: [
    [0, 320],
    [10_000, 320],
  ] as LutPoints,
  ERS_MAX_DEPLOY: 50_000,
  maxHarvestW: 200_000,
  ERS_MAX_CHARGE: 3_600_000,
  deployPerLapJ: Number.POSITIVE_INFINITY,
  harvestPerLapJ: Number.POSITIVE_INFINITY,
  // Motor, inverter and cells [est]
  deployEfficiency: 0.95,
  harvestEfficiency: 0.9,
  liftThrottle: 0,
  topGearLiftHarvestW: 0,
};

const FLAT: LutPoints = [
  [0, 1],
  [400, 1],
];

const mode = (
  performance_mode_name: PerformanceModeName,
  deployFraction: number,
  socFloor: number,
  brakeHarvestScale: number
): PerformanceModeData => ({
  performance_mode_name,
  deployFraction,
  deployVsSpeed: FLAT,
  socFloor,
  brakeHarvestScale,
  liftHarvestScale: 0,
  topGearClipHarvestW: 0,
  partThrottleHarvestW: 0,
  coastTorqueScale: 1,
  ebbOffset: 0,
});

/**
 * The wheel's hybrid modes on the simulator's five positions [est]: qualifying (all 50 kW until the store is empty),
 * attack, balanced, build (a little deployment, full regeneration) and no deployment
 */
const PERFORMANCE_MODES = {
  PSH: mode('PSH', 1, 0, 1),
  RAC: mode('RAC', 1, 0.15, 1),
  BAL: mode('BAL', 0.6, 0.3, 1),
  LIC: mode('LIC', 0.25, 0.5, 1),
  CHR: mode('CHR', 0, 1, 1),
};

/**
 * Seven forward gears (Art. 9.6.1) [spec] with two homologated sets (Art. 9.6.2) [spec]: one that reaches 340 km/h
 * without passing Nmax on a 349 mm tyre radius, and a shorter one for the other circuits. The ratios are not public
 * [est]. The long set's final drive makes seventh 3.157 overall, which is that 340 km/h at Nmax [derived from the
 * rule]; the sprint set's makes it 3.408, 315 km/h at Nmax on the same radius [est]. An up-shift cuts the engine for
 * at least 30 ms (Art. 9.8.2) [spec], here 38 ms [est]; a down-shift that would land over the limiter is refused
 * (Art. 9.8.4 allows the protection) [spec]
 */
const GEAR_RATIOS = [2.917, 2.267, 1.833, 1.524, 1.304, 1.148, 1.036];
const FINAL_DRIVE_SPRINT = 3.29;
const FINAL_DRIVE_LONG = 3.047;

const gearbox = (finalDrive: number) => ({
  ratios: GEAR_RATIOS,
  reverse: 2.8,
  finalDrive,
  shiftTimeS: 0.038,
  downshiftTimeS: 0.08,
  shiftTorqueFraction: 0.1,
  // A pneumatic dog box: 30 ms between gears inside the 38 ms cut [est]
  upshiftNeutralS: 0.03,
  upshiftCutS: 0.038,
  // Down: 80 ms between gears, the clutch home by 120 ms, a 60 % blip [est]; a shift that would land within 200 rpm
  // of the limiter is refused (no `overRevRpm`)
  downshift: { neutralS: 0.08, clutchReleaseS: 0.05, clutchHomeS: 0.12, blip: { level: 0.6, riseS: 0.01 } },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    redline_rpm: LIMITER_RPM,
    // The auto box changes up just past Nmax, where the regulated curve starts to fall [derived]
    upshift_rpm: N_MAX,
    downshift_rpm: 5200,
    // Into a braking zone it clicks down while the lower gear lands under 7600 rpm, short of the refusal [est]
    brake_downshift_rpm: 7600,
  },
});

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

/** Dry mass [claim: balance-of-performance bulletin; the regulations' floor is 1030 kg, Art. 4.1] and an 80 kg driver [est] */
const DRY_MASS = 1059;
const MASS = DRY_MASS + 80;
/** [spec Art. 3.1.5] */
const WHEELBASE = 3.148;
/** Share of the weight on the front axle: homologated per car and not public (Art. 4.2) [est] */
const FRONT_WEIGHT = 0.46;
const CG_HEIGHT = 0.275;
/** The floor's height at the axles at rest (m) [est] */
const FRONT_TARGET_HEIGHT = 0.048;
const REAR_TARGET_HEIGHT = 0.068;

/**
 * Double wishbones on push rods at both ends, each axle with its corner springs, a third (heave) spring and an anti-roll
 * element; all rates at the wheel [est]. The front is mostly its heave spring (a corner spring of 60 N/mm beside a
 * 480 N/mm heave element, 300 N/mm a wheel in heave), with a roll spring and the anti-roll bar's middle blade as one
 * 85 N/mm roll rate; the rear carries more on its corners (165 N/mm, 200 N/mm third spring, 20 N/mm bar). Ride
 * frequencies ≈ 5.5 Hz front and 4.8 Hz rear on the sprung mass, so the floor holds its height under ≈ 17 kN of
 * downforce. Packers on the heave elements catch the last of the travel. Four-way dampers with their knee at 65 mm/s:
 * the heave dampers carry about half the damping in heave (ζ ≈ 0.6 in bump, ≈ 0.75 in rebound), the corner dampers
 * all of it in roll.
 *
 * The car's own pickup points are not public: the hardpoints are the simulator's GT push-rod wishbone layout [est],
 * `[x inboard, y up, z forward]` from the wheel centre, and the camber gain and roll-centre heights are what the
 * kinematic solver gives for it on this car's tracks and tyres [derived]: roll centres 30 mm front and 59 mm rear, a
 * third of the braking load carried by the front links (anti-dive), ≈ 3 °/m of toe-out in bump at the front and
 * ≈ 7 °/m of toe-in at the rear.
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    staticCamber: -2.9,
    camberGainKinematic: -44,
    springs: { wheel_rate: 60_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 480_000, gap: 0, packerGap: 0.02, packerRate: 900_000 },
    bumpStop: { range: 0.032, rate: 150_000, progression: 4_000_000 },
    droopTravel: 0.035,
    rollCentreHeight: 0.0297,
    arb: 85_000,
    hardpoints: [
      [0.44, 0.0804, 0.197],
      [0.44, -0.0062, -0.145],
      [0.487, -0.167, 0.215],
      [0.487, -0.1906, -0.155],
      [0.128, 0.135, -0.025],
      [0.098, -0.128, 0.017],
      [0.447, -0.1554, 0.16],
      [0.097, -0.112, 0.14],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    staticCamber: -2.1,
    camberGainKinematic: -25,
    springs: { wheel_rate: 165_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 200_000, gap: 0, packerGap: 0.026, packerRate: 700_000 },
    bumpStop: { range: 0.04, rate: 150_000, progression: 4_000_000 },
    droopTravel: 0.045,
    rollCentreHeight: 0.0594,
    arb: 20_000,
    hardpoints: [
      [0.44, 0.0838, 0.251],
      [0.44, 0.1086, -0.123],
      [0.52, -0.1092, 0.16],
      [0.52, -0.1337, -0.221],
      [0.128, 0.148, 0.052],
      [0.11, -0.112, -0.055],
      [0.505, -0.1117, -0.25],
      [0.11, -0.1, -0.165],
    ],
  },
  dampers_controller: {
    front: {
      base: damper(5200, 2300, 7000, 3000),
      heave: damper(9600, 4200, 12_400, 5200),
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.065,
    },
    rear: {
      base: damper(6000, 2600, 8200, 3400),
      heave: damper(8000, 3600, 10_400, 4400),
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.065,
    },
  },
};

/** Reference area of the aero coefficients (m²) [est] */
const REF_AREA = 1.92;
/** A table of CL·A or CD·A (m²) as coefficients on the reference area */
const perArea = (lut: LutPoints): LutPoints => lut.map(([x, v]) => [x, Number((v / REF_AREA).toFixed(4))]);

/**
 * Splitter, underfloor and rear wing, with the body's drag as a constant [est]. Nothing public gives the car's map:
 * the regulations homologate each car inside a window of downforce and drag measured in one wind tunnel (Art. 3.9),
 * and the figures for it are in an appendix that was not retrieved. The numbers here make a car of CL·A ≈ 3.96 m² and
 * CD·A ≈ 0.99 m² (4 : 1) with 46.5 % of the downforce on the front axle, running 30 mm front and 42 mm rear at speed
 * on a 5.5° rear wing:
 *  - the splitter (CL·A 1.17 m²) works in ground effect: most at 22 mm, losing it quickly below 15 mm as it chokes
 *  - the underfloor and diffuser (1.84 m²) read the mean ride height and the rake
 *  - the rear wing (0.95 m² at 5.5°) gains 0.065 m² of CL·A and 0.022 m² of CD·A a degree over its 1–9° range; it sits
 *    0.8 m behind the rear axle, so a degree moves the balance ≈ 1.1 % rearward
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: 0.62,
  dragCentreY: 0.08,
  wings: [
    {
      name: 'FRONT_WING',
      area: REF_AREA,
      // 0.3 m ahead of the front axle
      positionZ: 2.0,
      angleDeg: 0,
      heightRef: 'front',
      // Against the body's pitch from its static rake (deg, + nose down)
      lutAOA_CL: perArea([
        [-3, 0.98],
        [-1, 1.11],
        [0, 1.17],
        [1, 1.22],
        [2, 1.26],
        [4, 1.3],
      ]),
      lutAOA_CD: perArea([
        [-3, 0.045],
        [0, 0.05],
        [4, 0.06],
      ]),
      lutGH_CL_mult: [
        [0, 0.3],
        [0.008, 0.62],
        [0.015, 0.98],
        [0.022, 1.08],
        [0.03, 1],
        [0.045, 0.9],
        [0.06, 0.82],
        [0.08, 0.72],
        [0.12, 0.6],
      ],
      lutGH_CD_mult: [
        [0, 1.05],
        [0.03, 1],
        [0.12, 0.97],
      ],
      lutYaw_CL_mult: [[0, 1], [5, 0.99], [10, 0.96], [20, 0.86], [30, 0.75]],
      dragY: -0.2,
    },
    {
      name: 'VENTURI_FLOOR',
      area: REF_AREA,
      positionZ: -0.1,
      angleDeg: 0,
      heightRef: 'mean',
      // Against the rake (deg): 0.22° at speed, 0.36° at rest
      lutAOA_CL: perArea([
        [-1, 1.47],
        [-0.3, 1.71],
        [0.2, 1.84],
        [0.6, 1.9],
        [1, 1.88],
        [1.6, 1.75],
        [2.5, 1.47],
      ]),
      lutAOA_CD: perArea([
        [-1, 0.11],
        [0.2, 0.12],
        [2.5, 0.14],
      ]),
      lutGH_CL_mult: [
        [0, 0.2],
        [0.01, 0.55],
        [0.02, 0.95],
        [0.028, 1.05],
        [0.036, 1],
        [0.05, 0.9],
        [0.065, 0.78],
        [0.085, 0.62],
        [0.11, 0.48],
        [0.15, 0.35],
      ],
      lutGH_CD_mult: [
        [0, 1.04],
        [0.036, 1],
        [0.15, 0.95],
      ],
      lutYaw_CL_mult: [[0, 1], [5, 0.98], [10, 0.93], [20, 0.8], [30, 0.65]],
      dragY: -0.22,
    },
    {
      name: 'REAR_WING',
      area: REF_AREA,
      positionZ: -2.25,
      // The middle of its 1–9° range
      angleDeg: 5.5,
      heightRef: 'rear',
      lutAOA_CL: perArea([
        [-6, 0.2],
        [0, 0.5925],
        [9, 1.1775],
        [12, 1.3],
        [15, 1.32],
      ]),
      lutAOA_CD: perArea([
        [-6, 0.03],
        [0, 0.079],
        [9, 0.277],
        [12, 0.36],
        [15, 0.47],
      ]),
      lutGH_CL_mult: [
        [0, 1],
        [0.3, 1],
      ],
      lutGH_CD_mult: [
        [0, 1],
        [0.3, 1],
      ],
      lutYaw_CL_mult: [[0, 1], [5, 0.975], [10, 0.92], [20, 0.78], [30, 0.62]],
      dragY: 0.5,
    },
  ],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane level with the ride heights' mean [derived]
  floorOffsetY: -(CG_HEIGHT - 0.5 * (FRONT_TARGET_HEIGHT + REAR_TARGET_HEIGHT)),
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/** 29/71-18 front and 34/71-18 rear on 18 in rims (Art. 12.3.3, 12.5.2) [spec], at the size the body's own are */
const RIM_RADIUS = 0.2286;
const LMDH_FRONT: TyreGeometry = { width: LC_LMDH_HARDPOINTS.tyreWidthFront, radius: LC_LMDH_HARDPOINTS.wheelRadiusFront, rimRadius: RIM_RADIUS, verticalRateScale: 1 };
const LMDH_REAR: TyreGeometry = { width: LC_LMDH_HARDPOINTS.tyreWidthRear, radius: LC_LMDH_HARDPOINTS.wheelRadiusRear, rimRadius: RIM_RADIUS, verticalRateScale: 1 };

/** The tyres' reference load (N) [est] */
const FZ0 = 3500;

/**
 * Peak grip against load (N → μ) [est]: μ0 · (Fz / Fz0)^(n − 1), held below a fifth of the reference load, with the
 * contact patch saturating a little more above 8 kN (a prototype's tyre under downforce and braking)
 */
function loadCurve(mu0: number, lsExp: number): LutPoints {
  const loads = [0, 700, 1500, 2500, 3500, 4500, 5500, 6500, 8000, 9500, 11_000, 13_000, 16_000];
  return loads.map((fz) => {
    const mu = mu0 * Math.max(0.2, fz / FZ0) ** (lsExp - 1);
    const saturation = fz > 8000 ? 1 - 0.02 * ((fz - 8000) / 4000) ** 1.3 : 1;
    return [fz, Number((mu * saturation).toFixed(4))];
  });
}

/** Radial rate against pressure (psi gauge → N/m) [est]: `rate` at the 26 psi the tyre runs at, 9 kN/m a psi */
const pressureSpring = (rate: number): LutPoints => [18, 22, 26, 30, 34].map((p) => [p, rate + 9000 * (p - 26)]);

/**
 * The class's spec slick [est]: nothing of the supplier's data is public. A brush tyre of μ 1.68 front and 1.72 rear at
 * 3.5 kN, losing a fifth of that per doubling of the load, peaking near 6.5° of slip angle and 10 % of slip ratio; the
 * thermal, pressure and camber terms are the simulator's closed-wheel slick estimates. `grip` scales a compound
 */
function lmdhCompound(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  grip: number,
  thermalCurve: LutPoints,
  window: [number, number]
): TyresCompoundData {
  const front = Number((1.68 * grip).toFixed(4));
  const rear = Number((1.72 * grip).toFixed(4));
  return {
    name,
    shortName,
    tyre_compound,
    front: LMDH_FRONT,
    rear: LMDH_REAR,
    modelData: {
      Dy0: front,
      Dx0: front,
      lsExpY: 0.8,
      lsExpX: 0.82,
      Fz0: FZ0,
      dyCurve: loadCurve(front, 0.8),
      dxCurve: loadCurve(front, 0.82),
      curve: 'brush',
      friction_limit_angle: 6.5,
      peakSlipLoadGain: 0.05,
      peakSlipPressureGain: 0.05,
      combinedExponent: 2,
      longStiffnessMult: 1.1,
      speedSensitivity: 0.0005,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 4,
      slip_ratio_limit: 0.1,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      use_slip_falloff: true,
      falloff_level: 0.86,
      falloff_slope: 4,
      relaxationLengthX: 0.1,
      relaxationLengthY: 0.1,
      rollingResistance: 0.01,
      rollingResistanceSpeedSq: 4e-7,
      verticalDamping: 520,
      brakeDxMod: 0,
    },
    thermalData: {
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      surfaceHeatCapacity: 1800,
      coreHeatCapacity: 11_000,
      slipHeatShare: 0.35,
      hysteresis: 0.0044,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 90,
    },
    pressureData: {
      optimalPsi: 26,
      pressureSpringCurve: pressureSpring(290_000),
      pressureGripSensitivity: 1,
      pressureGripLossPerPsi: 0.0025,
      // Starts warm, as the simulator's other slicks do [est]
      coldRefC: 60,
    },
    camberData: {
      camberGain: 0.14,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: 0.8,
      dcamber1: -4.6,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    // The 34 cm rear: its own grip at the same reference load, and a stiffer carcass
    rearOverride: {
      modelData: { Dy0: rear, Dx0: rear, Fz0: FZ0, dyCurve: loadCurve(rear, 0.8), dxCurve: loadCurve(rear, 0.82), friction_limit_angle: 6.3 },
      pressureData: { pressureSpringCurve: pressureSpring(320_000) },
    },
  };
}

const TYRES = {
  PhysicsTyreCompound_Proto_Soft: lmdhCompound(
    'PhysicsTyreCompound_Proto_Soft',
    'Slick Soft',
    'S',
    1,
    [[0, 0.72], [20, 0.76], [45, 0.88], [60, 0.96], [70, 1], [90, 1], [105, 0.96], [125, 0.88], [150, 0.8], [300, 0.6]],
    [70, 90]
  ),
  PhysicsTyreCompound_Proto_Medium: lmdhCompound(
    'PhysicsTyreCompound_Proto_Medium',
    'Slick Medium',
    'M',
    0.985,
    [[0, 0.7], [20, 0.74], [45, 0.85], [60, 0.93], [75, 0.98], [80, 1], [98, 1], [112, 0.96], [130, 0.88], [150, 0.8], [300, 0.6]],
    [80, 98]
  ),
  PhysicsTyreCompound_Proto_Hard: lmdhCompound(
    'PhysicsTyreCompound_Proto_Hard',
    'Slick Hard',
    'H',
    0.97,
    [[0, 0.68], [20, 0.72], [45, 0.82], [60, 0.9], [75, 0.96], [88, 1], [105, 1], [120, 0.96], [140, 0.86], [160, 0.8], [300, 0.6]],
    [88, 105]
  ),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** The slicks plus rain tyres on the medium's carcass, as the simulator's other closed-wheel cars [est] */
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

const config = (finalDrive: number, rearWingDeg: number) =>
  ({
    screenName: 'LC-LMDH',
    chassis: {
      // With driver, no fuel
      totalMassKg: MASS,
      frontWeightFraction: FRONT_WEIGHT,
      wheelbase: WHEELBASE,
      trackWidthFront: LC_LMDH_HARDPOINTS.trackWidthFront,
      trackWidthRear: LC_LMDH_HARDPOINTS.trackWidthRear,
      // [est]
      cgHeight: CG_HEIGHT,
      // [est]: a radius of gyration of 1.25 m in yaw, the engine and the gearbox close behind the cockpit
      inertia: { pitch: 1650, roll: 420, yaw: 1780 },
      // Wheel, tyre, brake, upright and half the links [est]; a rim alone is at least 8.75 / 9.25 kg (Art. 12.5.3)
      unsprungMassFront: 24.5,
      unsprungMassRear: 27.5,
      // The cell sits behind the driver, a little ahead of the CG [est]
      fuelTank: { y: -0.03, z: 0.1 },
      // [est]
      wheelInertiaFront: 1.35,
      wheelInertiaRear: 1.65,
      // 225° of rim lock each way on a 12.5 : 1 rack [est]
      maxRoadWheelDeg: 225 / 12.5,
      ffbMechanicalTrailM: 0.02,
      // Power steering, engine-driven: the same assist at any speed [est]
      powerSteering: { steeringRatio: 12.5, deadbandNm: 2, rampNm: 15, maxRatio: 1.2 },
    },
    engine: ENGINE,
    ers: ERS,
    performanceModes: PERFORMANCE_MODES,
    gearbox: gearbox(finalDrive),
    // [est]: the launch slips the clutch at 4500 rpm
    clutch: { maxTorqueNm: 1300, biteRpm: 1800, lockRpm: 1900, launchRpm: 4500 },
    // The spec mechanical plate differential (Art. 9.9) [spec]: 45° drive and 65° coast ramps on six friction faces with
    // 65 Nm of preload [est]. Each face's friction 0.07 [est]: it locks 42 % of the drive torque and 20 % on the overrun
    differential: {
      type: 'LSD_Ramp',
      settings: { power: 0.07, coast: 0.07, preload: 65, friction_faces: 6, power_ramp_deg: 45, coast_ramp_deg: 65 },
    },
    // Carbon discs of up to 381 mm (Art. 11.3.2) [spec]. 6800 Nm an axle pair at full pedal, 56 % front, moving 1 %
    // forward over the pedal's travel [est]. The rear circuit is brake-by-wire (Art. 5.3.9, 11.7) [spec]: the rear
    // calipers give way to the motor's regeneration and the engine's overrun, so the axle brakes what the pedal asks
    brakes: { maxTorqueNm: 6800, front_bias: 0.56, ebbStep: 0.005, brakeByWire: true, migration: { amount: 0.01, rampStart: 0 } },
    suspensions: SUSPENSIONS,
    aero: { ...AERO, wings: AERO.wings.map((w) => (w.name === 'REAR_WING' ? { ...w, angleDeg: rearWingDeg } : w)) },
    tyreCompounds: TYRES_WITH_RAIN,
    compoundSlots: {
      soft: 'PhysicsTyreCompound_Proto_Soft',
      medium: 'PhysicsTyreCompound_Proto_Medium',
      hard: 'PhysicsTyreCompound_Proto_Hard',
      intermediate: 'PhysicsTyreCompound_Proto_Intermediate',
      wet: 'PhysicsTyreCompound_Proto_Wet',
    },
  }) satisfies CarPhysicsConfig;

/** The car as the game drives it: the sprint gear set, the rear wing in the middle of its range */
export const LC_LMDH_CONFIG = config(FINAL_DRIVE_SPRINT, 5.5);

/**
 * The same car in its long-circuit trim: the long gear set and the rear wing at its 1° minimum. Not selectable in the
 * garage (a car has one final drive there): `scripts/verify-lc-lmdh.ts` checks its top speed
 */
export const LC_LMDH_LONG_CONFIG = config(FINAL_DRIVE_LONG, 1);

/** What the regulations and the bulletin fix, for the checks: Nmax, the 500 kW line and the car's scale on it */
export const LC_LMDH_POWER = { nMax: N_MAX, curve500Kw: POWER_CURVE_500, scaleVsKmh: POWER_SCALE_VS_KMH };

/**
 * Traction control (Art. 9.3) [spec]: allowed wheelspin for each of the twelve switch positions, 8 % by default,
 * working from 40 km/h [est]. The car has no ABS (Art. 11.5.1) [spec]: the ABS table is the simulator's own, for the
 * driver-assist presets that add one
 */
export const LC_LMDH_ELECTRONICS = {
  absLevels: [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17],
  absDefault: 0.09,
  absRateHz: 240,
  tcLevels: [0.05, 0.055, 0.06, 0.065, 0.07, 0.075, 0.08, 0.085, 0.09, 0.1, 0.11, 0.12],
  tcDefault: 0.08,
  tcRateHz: 250,
  tcMinSpeedKmh: 40,
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
