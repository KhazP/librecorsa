/**
 * Mercedes-AMG GT3 Evo vehicle data for `VehiclePhysics` (same data model as the f12026-car, see `F12026CarConfig`).
 *
 * Values are calibrated to FIA GT3 homologation parameters:
 *  - [spec]     car / engine / drivetrain / suspensions / tyres / aero / brakes / electronics specification
 *  - [est]      engineering estimate where a runtime value is inferred
 *  - [derived]  computed from other values in this file
 *
 * No hybrid, DRS or heave spring: the ERS is zeroed, every performance mode is the same map, the heave element
 * has no rate, and the brakes are conventional hydraulics (no brake-by-wire).
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

/** Gearbox efficiency of this model; the mod's torque curve is at the wheels, so the crank torque is curve / this */
const DRIVELINE_EFFICIENCY = 0.92;

/** The mod's torque curve (rpm → Nm at the wheels) [mod power.lut] */
const WHEEL_TORQUE: [number, number][] = [
  [0, 100],
  [513, 262],
  [4107, 518],
  [4615, 529],
  [6160, 520],
  [6673, 502],
  [7187, 462],
  [7700, 412],
  [8213, 372],
  [8500, 0],
];

/** Crank power (kW) at the curve's points [derived] */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, ((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque, 100 Nm at 7700 rpm [mod COAST_REF]
  coastCurve: [
    [0, 0],
    [7700, 100],
    [8500, 110],
  ] as LutPoints,
  // [mod throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [0.1, 0.1],
    [0.2, 0.2],
    [0.3, 0.35],
    [0.4, 0.5],
    [0.5, 0.65],
    [0.6, 0.7],
    [0.7, 0.75],
    [0.8, 0.8],
    [0.9, 0.9],
    [1, 1],
  ] as LutPoints,
  idleRpm: 2000,
  // Engine 0.130 + gearbox 0.018 [mod]
  inertia: 0.148,
  // 25 Hz limiter [mod LIMITER_HZ]
  limiterCutS: 0.02,
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

/** 6-speed sequential [mod drivetrain.ini]: ~280 km/h at the 7700 rpm limiter in 6th */
const GEARBOX = {
  ratios: [3.0, 2.125, 1.667, 1.381, 1.208, 1.083],
  reverse: 3.0,
  finalDrive: 3.1,
  // 100 ms up-shift with the ignition cut [mod CHANGE_UP_TIME]
  shiftTimeS: 0.1,
  shiftTorqueFraction: 0.1,
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    redline_rpm: 7700,
    // [mod AUTO_SHIFTER]
    upshift_rpm: 6950,
    downshift_rpm: 3800,
    // Into a braking zone the auto box clicks down while the lower gear lands under 6300 rpm (the shift lights'
    // second stage), so the engine stays in its power band on the brakes instead of lugging down to 3800 [est]
    brake_downshift_rpm: 6300,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

/**
 * Double wishbones front and rear: wheel rates, ARBs, bump rubbers and two-stage dampers [mod suspensions.ini].
 * The free travel to the rubber is the mod's bump-stop height less the static compression [derived]; roll centres and
 * kinematic camber gain are estimates (AC solves them from the wishbone points). No third element.
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    staticCamber: -3.5,
    camberGainKinematic: -12,
    springs: { wheel_rate: 80_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    bumpStop: { range: 0.02, rate: 135_000, progression: 5_000_000 },
    droopTravel: 0.06,
    rollCentreHeight: 0.05,
    arb: 50_000,
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    staticCamber: -2.5,
    camberGainKinematic: -10,
    springs: { wheel_rate: 120_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    bumpStop: { range: 0.025, rate: 130_000, progression: 5_000_000 },
    droopTravel: 0.055,
    rollCentreHeight: 0.065,
    arb: 18_650,
  },
  dampers_controller: {
    front: {
      base: damper(10_600, 3800, 12_375, 5485),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.06,
      fastReboundThresholdMs: 0.12,
    },
    rear: {
      base: damper(6017, 3875, 10_770, 4600),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.06,
      fastReboundThresholdMs: 0.12,
    },
  },
};

/** The mod's wings all use chord 1 × span 2.1221 m as the reference area [mod aero.ini] */
const WING_AREA = 2.1221;
const FRONT_TARGET_HEIGHT = 0.055;
const REAR_TARGET_HEIGHT = 0.07;
const WHEELBASE = 2.65;
/** Static rake (deg) [derived] */
const STATIC_RAKE_DEG = (Math.asin((REAR_TARGET_HEIGHT - FRONT_TARGET_HEIGHT) / WHEELBASE) * 180) / Math.PI;
/** The mod's diffuser sits at 2° + pitch; this model feeds the floor its rake, so its angle axis is shifted [derived] */
const DIFFUSER_ANGLE_DEG = 2;
const toRake = (lut: LutPoints): LutPoints => lut.map(([aoa, v]) => [aoa - DIFFUSER_ANGLE_DEG + STATIC_RAKE_DEG, v]);

/**
 * Splitter, diffuser and rear wing with the mod's angle-of-attack and ground-height maps; the body's drag is the
 * mod's body element at 0° (it has no lift). Left out: the mod's yaw and damage terms, and its below-60 km/h
 * diffuser controller. [mod aero.ini, wing_*.lut, height_*.lut]
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: 0.455 * WING_AREA,
  wings: [
    {
      name: 'FRONT_WING',
      area: WING_AREA,
      positionZ: 2.0,
      angleDeg: 2,
      heightRef: 'front',
      lutAOA_CL: [
        [-10, -0.065548],
        [-2, 0.447647],
        [0, 0.536207],
        [2, 0.550613],
        [4, 0.536207],
        [6, 0.468342],
        [8, 0.412936],
        [10, 0.344126],
      ],
      lutAOA_CD: [
        [-10, 0],
        [-2, 0],
        [0, 0],
        [2, 0.00325],
        [4, 0.0065],
        [6, 0.00975],
        [8, 0.013],
        [10, 0.01625],
        [12, 0.0195],
      ],
      lutGH_CL_mult: [
        [0, 0],
        [0.01, 0.02],
        [0.038, 0.2],
        [0.045, 1.07],
        [0.05, 1.06],
        [0.06, 1.04],
        [0.065, 1.02],
        [0.0754, 0.95],
        [0.08, 0.92],
        [0.085, 0.8],
        [0.09, 0.6],
        [0.11, 0.5],
        [0.135, 0.3],
        [0.155, 0.2],
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
    },
    {
      name: 'VENTURI_FLOOR',
      area: WING_AREA,
      positionZ: -0.2,
      angleDeg: 0,
      heightRef: 'mean',
      lutAOA_CL: toRake([
        [-10, 0],
        [-1, 0.360486],
        [0, 0.447647],
        [1, 0.458796],
        [2, 0.450635],
        [5, 0.425048],
        [8, 0.294963],
        [10, 0.032788],
        [12, 0],
      ]),
      lutAOA_CD: toRake([
        [-10, 0],
        [30, 0],
      ]),
      lutGH_CL_mult: [
        [0, 0],
        [0.01, 0],
        [0.039, 0.02],
        [0.045, 0.3],
        [0.048, 1],
        [0.055, 1.02],
        [0.0664, 1.01],
        [0.0754, 0.97],
        [0.08, 0.95],
        [0.085, 0.92],
        [0.095, 0.7],
        [0.11, 0.3],
        [0.135, 0.2],
        [0.155, 0],
      ],
      lutGH_CD_mult: [
        [0, 1],
        [0.2, 1],
      ],
    },
    {
      name: 'REAR_WING',
      area: WING_AREA,
      positionZ: -2.1,
      angleDeg: 5,
      heightRef: 'rear',
      lutAOA_CL: [
        [-10, -0.262197],
        [-2, 0.288391],
        [0, 0.360518],
        [2, 0.445728],
        [4, 0.469518],
        [6, 0.504005],
        [8, 0.557087],
        [10, 0.576796],
        [12, 0.629278],
        [14, 0.662073],
        [16, 0.662073],
      ],
      lutAOA_CD: [
        [-10, 0],
        [-2, 0.026],
        [0, 0],
        [2, 0.0065],
        [4, 0.039],
        [6, 0.0715],
        [8, 0.0975],
        [10, 0.1495],
        [12, 0.234],
        [14, 0.2795],
        [16, 0.351],
      ],
      lutGH_CL_mult: [
        [0, 1],
        [0.3, 1],
      ],
      lutGH_CD_mult: [
        [0, 1],
        [0.3, 1],
      ],
    },
  ],
  // The mod's ground-height maps peak at 45–66 mm; 55 mm is its minimum ride height [mod RULES], rake [est]
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane at the mean target height below the 0.40 m CG [derived]
  floorOffsetY: -(0.4 - 0.5 * (FRONT_TARGET_HEIGHT + REAR_TARGET_HEIGHT)),
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/** Front 0.300 × R 0.340, rear 0.310 × R 0.355, rim R 0.2413 [mod tyres.ini] */
const GT3_FRONT: TyreGeometry = { width: 0.3, radius: 0.34, rimRadius: 0.2413, verticalRateScale: 1 };
const GT3_REAR: TyreGeometry = { width: 0.31, radius: 0.355, rimRadius: 0.2413, verticalRateScale: 1.007 };

/**
 * The mod's GT3 slick [mod tyres.ini, front values; the rear's differ by under 1 %, except LS_EXPY 0.81 vs 0.79,
 * averaged]. The mod ships one compound; soft / medium / hard here are that tyre on the mod's three temperature
 * curves (tcurve_slicksGT3s / m / h).
 */
function gt3Compound(tyre_compound: PhysicsTyreCompound, name: string, shortName: 'S' | 'M' | 'H', thermalCurve: LutPoints, window: [number, number]): TyresCompoundData {
  return {
    name,
    shortName,
    tyre_compound,
    front: GT3_FRONT,
    rear: GT3_REAR,
    modelData: {
      Dy0: 1.6678,
      Dx0: 1.5778,
      lsExpY: 0.799,
      lsExpX: 0.809,
      Fz0: 3768,
      friction_limit_angle: 6.3,
      // AC derives it at run time; the mod's TC (0.10) and ABS (0.12) limits sit around it [est]
      slip_ratio_limit: 0.1,
      combinedFactor: 1,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [mod FALLOFF_LEVEL / FALLOFF_SPEED]
      use_slip_falloff: true,
      falloff_level: 0.85,
      falloff_slope: 3,
      relaxationLengthX: 0.1,
      relaxationLengthY: 0.1,
      rollingResistance: 0.012,
      verticalDamping: 500,
      pneumaticTrail: 0.04,
    },
    thermalData: {
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // AC's thermal model is not this one: these are estimates
      surfaceHeatCapacity: 1800,
      coreHeatCapacity: 11000,
      slipHeatShare: 0.35,
      hysteresis: 0.0038,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 90,
    },
    pressureData: {
      optimalPsi: 26,
      // RATE 272 675 N/m at 16 psi + 12 667 N/m per psi [mod]
      pressureSpringCurve: [
        [16, 272_675],
        [20, 323_343],
        [26, 399_345],
        [30, 450_013],
        [34, 500_681],
      ],
      // ≈ the mod's 0.5 % grip per psi off the ideal over the usual ±2–4 psi
      pressureGripSensitivity: 1.0,
      coldRefC: 60,
    },
    camberData: {
      camberGain: 0.133,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: 1.65,
      dcamber1: -13,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
  };
}

const TYRES = {
  PhysicsTyreCompound_GT3_Soft: gt3Compound(
    'PhysicsTyreCompound_GT3_Soft',
    'GT3 Soft',
    'S',
    [
      [0, 0.7],
      [20, 0.8],
      [45, 0.9],
      [60, 0.98],
      [70, 1],
      [80, 1],
      [85, 1],
      [100, 0.97],
      [140, 0.95],
      [180, 0.95],
      [240, 0.8],
      [300, 0.6],
    ],
    [70, 85]
  ),
  PhysicsTyreCompound_GT3_Medium: gt3Compound(
    'PhysicsTyreCompound_GT3_Medium',
    'GT3 Medium',
    'M',
    [
      [0, 0.7],
      [20, 0.8],
      [45, 0.9],
      [60, 0.95],
      [70, 0.98],
      [80, 1],
      [90, 1],
      [95, 1],
      [105, 0.97],
      [140, 0.95],
      [180, 0.95],
      [240, 0.8],
      [300, 0.6],
    ],
    [80, 95]
  ),
  PhysicsTyreCompound_GT3_Hard: gt3Compound(
    'PhysicsTyreCompound_GT3_Hard',
    'GT3 Hard',
    'H',
    [
      [0, 0.7],
      [20, 0.8],
      [45, 0.9],
      [60, 0.95],
      [70, 0.97],
      [80, 1],
      [90, 1],
      [105, 1],
      [115, 0.97],
      [160, 0.95],
      [180, 0.95],
      [240, 0.8],
      [300, 0.6],
    ],
    [80, 105]
  ),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Box inertia from the mod's 1.75 × 1.05 × 4.10 m [mod car.ini INERTIA, derived] */
const MASS = 1355;
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const AMG_GT3_CONFIG = {
  screenName: 'Mercedes-AMG GT3',
  chassis: {
    // With driver, no fuel [mod]
    totalMassKg: MASS,
    frontWeightFraction: 0.48,
    wheelbase: WHEELBASE,
    trackWidthFront: 1.75,
    trackWidthRear: 1.72,
    // Hub heights 55 / 60 mm below the CG on the 0.340 / 0.355 m tyres [mod BASEY, derived]
    cgHeight: 0.4,
    inertia: { pitch: box(1.05, 4.1), roll: box(1.75, 1.05), yaw: box(1.75, 4.1) },
    unsprungMassFront: 39,
    unsprungMassRear: 46,
    wheelInertiaFront: 1.6,
    wheelInertiaRear: 1.9,
    // 320° lock / 13.6 ratio [mod]
    maxRoadWheelDeg: 320 / 13.6,
    // ~7° caster on a road-car-derived upright: more caster trail than the F1's 12 mm, so a heavier rim
    ffbMechanicalTrailM: 0.025,
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // Auto-clutch 2300–3200 rpm [mod]
  clutch: { maxTorqueNm: 820, biteRpm: 2300, lockRpm: 3200 },
  // Locking torque = preload + POWER / COAST × input torque, as the mod's diff [mod]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.3, coast: 0.45, preload: 98, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // [mod brakes.ini]
  brakes: { maxTorqueNm: 4000, front_bias: 0.65, ebbStep: 0.005, brakeByWire: false },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: TYRES,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_GT3_Soft',
    medium: 'PhysicsTyreCompound_GT3_Medium',
    hard: 'PhysicsTyreCompound_GT3_Hard',
  },
} satisfies CarPhysicsConfig;

/**
 * The mod's driver-aid tables [mod electronics.ini, abs_settings.lut, traction_control.lut]: allowed slip ratio for
 * each of the 12 switch positions, the default position, and the speed traction control starts at.
 */
export const AMG_GT3_ELECTRONICS = {
  absLevels: [0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19],
  absDefault: 0.12,
  absRateHz: 200,
  tcLevels: [0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19],
  tcDefault: 0.1,
  tcRateHz: 135,
  tcMinSpeedKmh: 40,
};
