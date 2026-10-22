/**
 * Mercedes-AMG GT3 Evo vehicle data for `VehiclePhysics` (same data model as the f12026-car, see `F12026CarConfig`).
 *
 * Values are calibrated to FIA GT3 homologation parameters and reference GT3 telemetry:
 *  - [spec]     car / engine / drivetrain / suspensions / tyres / aero / brakes / electronics specification
 *  - [est]      engineering estimate where a runtime value is inferred
 *  - [derived]  computed from other values in this file
 *  - [motec]    fit to reference GT3 Evo MoTeC telemetry logs (Valencia, ~24 min); see scripts/compare-gt3-telemetry.ts
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
import { deriveRainCompound } from '../f12026-car/F12026CarConfig';

/** Gearbox efficiency of this model; the wheel torque curve is divided by this for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/** Wheel torque curve (rpm → Nm at the wheels) [spec power.lut] */
const WHEEL_TORQUE: [number, number][] = [
  [0, 100],
  [500, 250],
  [1000, 280],
  [1500, 330],
  [2000, 350],
  [2500, 410],
  [3000, 450],
  [3500, 470],
  [4000, 506],
  [4500, 517],
  [5000, 524],
  [5500, 534],
  [6000, 544],
  [6500, 520],
  [7000, 490],
  [7500, 450],
  [8000, 400],
  [8500, 350],
  [9000, 200],
  [9500, 0],
];

/** Crank power (kW) at the curve's points [derived] */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, ((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque, 100 Nm at 8000 rpm [spec COAST_REF]
  coastCurve: [
    [0, 0],
    [8000, 100],
    [9500, 118.75],
  ] as LutPoints,
  // [spec throttle.lut]
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
  idleRpm: 2100,
  // Engine 0.130 + gearbox 0.018 [spec]
  inertia: 0.148,
  // 25 Hz limiter [spec LIMITER_HZ]
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

/**
 * 6-speed sequential on a 3.4285 final drive. 2nd–5th are calibrated from engine rpm
 * per m/s of rear wheel speed in each gear in reference GT3 MoTeC logs (181.2 / 141.3 / 115.3 / 100.8 on the 0.3525 m
 * rear) [motec]; 1st is [spec]; 6th keeps 5th's step [est]. ~320 km/h
 * at the 7900 rpm limiter, past the drag-limited top speed
 */
const GEARBOX = {
  ratios: [2.5, 1.951, 1.521, 1.2414, 1.0847, 0.96],
  reverse: 3.818,
  finalDrive: 3.4285,
  // 100 ms up-shift with the ignition cut [spec CHANGE_UP_TIME]
  shiftTimeS: 0.1,
  shiftTorqueFraction: 0.1,
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // Reference telemetry limiter: logs peak at 7899 rpm [motec]
    redline_rpm: 7900,
    // Up-shifts land at a median 7487 rpm [motec]
    upshift_rpm: 7500,
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
 * Double wishbones front and rear: wheel rates, ARBs, bump rubbers and two-stage dampers [spec].
 * The free travel to the rubber is the bump-stop height less the static compression [derived]; roll centres and
 * kinematic camber gain are estimates. No third element.
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    staticCamber: -3.5,
    camberGainKinematic: -12,
    springs: { wheel_rate: 90_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    bumpStop: { range: 0.02, rate: 135_000, progression: 5_000_000 },
    droopTravel: 0.06,
    rollCentreHeight: 0.05,
    arb: 80_000,
    hardpoints: [
      [0.440, 0.098, 0.197],
      [0.440, 0.072, -0.145],
      [0.487, -0.122, 0.215],
      [0.487, -0.155, -0.155],
      [0.128, 0.135, -0.025],
      [0.098, -0.128, 0.017],
      [0.447, -0.120, 0.160],
      [0.110, -0.112, 0.140],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    staticCamber: -2.5,
    camberGainKinematic: -10,
    springs: { wheel_rate: 130_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    bumpStop: { range: 0.025, rate: 130_000, progression: 5_000_000 },
    droopTravel: 0.055,
    rollCentreHeight: 0.065,
    arb: 38_650,
    hardpoints: [
      [0.440, 0.092, 0.251],
      [0.440, 0.092, -0.123],
      [0.520, -0.125, 0.160],
      [0.520, -0.112, -0.221],
      [0.128, 0.148, 0.052],
      [0.110, -0.112, -0.055],
      [0.505, -0.109, -0.250],
      [0.110, -0.100, -0.165],
    ],
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

/** Reference wing area: chord 1 × span 2.1221 m [spec] */
const WING_AREA = 2.1221;
const FRONT_TARGET_HEIGHT = 0.055;
const REAR_TARGET_HEIGHT = 0.07;
const WHEELBASE = 2.65;
/** Static rake (deg) [derived] */
const STATIC_RAKE_DEG = (Math.asin((REAR_TARGET_HEIGHT - FRONT_TARGET_HEIGHT) / WHEELBASE) * 180) / Math.PI;
/** Diffuser sits at 2° + pitch; this model feeds the floor its rake, so its angle axis is shifted [derived] */
const DIFFUSER_ANGLE_DEG = 2;
const toRake = (lut: LutPoints): LutPoints => lut.map(([aoa, v]) => [aoa - DIFFUSER_ANGLE_DEG + STATIC_RAKE_DEG, v]);

/**
 * Splitter, diffuser and rear wing with angle-of-attack and ground-height maps; the body's drag is the
 * body element at 0° (it has no lift). [spec]
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: 0.35 * WING_AREA,
  wings: [
    {
      name: 'FRONT_WING',
      area: WING_AREA,
      positionZ: 2.0,
      angleDeg: 2,
      heightRef: 'front',
      lutAOA_CL: [
        [-10, -0.05],
        [-2, 0.34125],
        [0, 0.4095],
        [2, 0.42],
        [4, 0.4095],
        [6, 0.357],
        [8, 0.315],
        [10, 0.2625],
      ],
      lutAOA_CD: [
        [-10, 0],
        [-2, 0],
        [0, 0],
        [2, 0.0025],
        [4, 0.005],
        [6, 0.0075],
        [8, 0.01],
        [10, 0.0125],
        [12, 0.015],
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
        [-1, 0.275],
        [0, 0.34125],
        [1, 0.35],
        [2, 0.34375],
        [5, 0.325],
        [8, 0.225],
        [10, 0.025],
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
      angleDeg: 6,
      heightRef: 'rear',
      lutAOA_CL: [
        [-10, -0.2],
        [-2, 0.22],
        [0, 0.275],
        [2, 0.34],
        [4, 0.358],
        [6, 0.385],
        [8, 0.425],
        [10, 0.44],
        [12, 0.48],
        [14, 0.505],
        [16, 0.505],
      ],
      lutAOA_CD: [
        [-10, 0],
        [-2, 0.02],
        [0, 0],
        [2, 0.005],
        [4, 0.03],
        [6, 0.055],
        [8, 0.075],
        [10, 0.115],
        [12, 0.18],
        [14, 0.215],
        [16, 0.27],
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
  // Ground-height maps peak at 45–66 mm; 55 mm is minimum ride height [spec], rake [est]
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane at the mean target height below the 0.40 m CG [derived]
  floorOffsetY: -(0.4 - 0.5 * (FRONT_TARGET_HEIGHT + REAR_TARGET_HEIGHT)),
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/** Front 0.315 × R 0.340, rear 0.325 × R 0.3525, rim R 0.2413 [spec] */
const GT3_FRONT: TyreGeometry = { width: 0.315, radius: 0.34, rimRadius: 0.2413, verticalRateScale: 1 };
const GT3_REAR: TyreGeometry = { width: 0.325, radius: 0.3525, rimRadius: 0.2413, verticalRateScale: 282_710 / 280_470 };

/**
 * Builds a 16-point non-power-law load-sensitivity LUT (Fz [N] → μ) for the GT3 315/680-18 front and 325/705-18 rear
 * slicks: follows D_REF · (Fz / Fz0)^(lsExp − 1) through the nominal working range with realistic contact-patch
 * shoulder saturation above 7 kN under heavy aero + braking/kerb compression.
 */
function buildGt3LoadCurve(dRef: number, fz0: number, lsExp: number): LutPoints {
  const loads = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7500, 9000, 11000, 14000];
  return loads.map((fz) => {
    const ratio = Math.max(0.18, fz / fz0);
    const baseMu = dRef * Math.pow(ratio, lsExp - 1);
    const highLoadSaturation = fz > 6500 ? 1 - 0.012 * Math.pow((fz - 6500) / 4000, 1.35) : 1;
    return [fz, Number((baseMu * highLoadSaturation).toFixed(4))] as [number, number];
  });
}

/**
 * GT3 slick [spec]: the front's values, the rear's own Fz0, load sensitivity, 16-point DY/DX curves, peak
 * slip angle, relaxation length, pressure-spring rate, and camber thrust in `rearOverride` ([REAR]). Soft / medium / hard
 * keep the grip steps (DY_REF = DX_REF 1.58 / 1.56 / 1.54) scaled ×1.165 to reference GT3 grip [motec], and three
 * temperature curves.
 */
function gt3Compound(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  /** D_REF (lateral = longitudinal) of the compound */
  gripScale: number,
  thermalCurve: LutPoints,
  window: [number, number]
): TyresCompoundData {
  // Wider 325/705-18 rear slick has ~1.2 % higher peak reference μ at Fz0 = 3910 N and flatter load sensitivity
  const rearGripScale = Number((gripScale * 1.012).toFixed(4));
  return {
    name,
    shortName,
    tyre_compound,
    front: GT3_FRONT,
    rear: GT3_REAR,
    modelData: {
      // D_REF of the load-sensitivity law μ = D_REF·(Fz/FZ0)^(LS_EXP−1), plus 16-point tabulated DY_CURVE / DX_CURVE
      Dy0: gripScale,
      Dx0: gripScale,
      lsExpY: 0.7917,
      lsExpX: 0.8017,
      Fz0: 3787,
      dyCurve: buildGt3LoadCurve(gripScale, 3787, 0.7917),
      dxCurve: buildGt3LoadCurve(gripScale, 3787, 0.8017),
      friction_limit_angle: 6.12,
      // Default TC (0.10) and ABS (0.09) limits sit around it [est]
      slip_ratio_limit: 0.1,
      combinedFactor: 1,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [spec FALLOFF_LEVEL / FALLOFF_SPEED]
      use_slip_falloff: true,
      falloff_level: 0.85,
      falloff_slope: 3,
      relaxationLengthX: 0.09883,
      relaxationLengthY: 0.09883,
      rollingResistance: 0.012,
      verticalDamping: 500,
      pneumaticTrail: 0.04,
      // +9 % longitudinal grip under braking [spec BRAKE_DX_MOD]
      brakeDxMod: 0.09,
    },
    thermalData: {
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // Thermal model estimates
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
      // RATE 280 470 N/m at 16 psi + 13 154 N/m per psi [spec]
      pressureSpringCurve: [
        [16, 280_470],
        [20, 333_086],
        [26, 412_010],
        [30, 464_626],
        [34, 517_242],
      ],
      // ≈ 0.5 % grip per psi off the ideal over the usual ±2–4 psi
      pressureGripSensitivity: 1.0,
      coldRefC: 60,
    },
    camberData: {
      camberGain: 0.134,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: 1.65,
      dcamber1: -13,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    // The 325/705-18 rear [spec REAR / REAR_1 / REAR_2, flatter load-sensitivity curve + 16-pt DY/DX tables + rear spring gain]
    rearOverride: {
      modelData: {
        Dy0: rearGripScale,
        Dx0: rearGripScale,
        Fz0: 3910,
        lsExpY: 0.8044,
        lsExpX: 0.8144,
        dyCurve: buildGt3LoadCurve(rearGripScale, 3910, 0.8044),
        dxCurve: buildGt3LoadCurve(rearGripScale, 3910, 0.8144),
        friction_limit_angle: 6.06,
        relaxationLengthX: 0.10173,
        relaxationLengthY: 0.10173,
      },
      pressureData: {
        optimalPsi: 26,
        // Rear RATE 282 710 N/m at 16 psi + 11 304 N/m per psi [spec REAR PRESSURE_SPRING_GAIN]
        pressureSpringCurve: [
          [16, 282_710],
          [20, 327_926],
          [26, 395_750],
          [30, 440_966],
          [34, 486_182],
        ],
        pressureGripSensitivity: 1.0,
        coldRefC: 60,
      },
      camberData: {
        camberGain: 0.149,
        dcamber0: 1.72,
        dcamber1: -13,
      },
    },
  };
}

const TYRES = {
  PhysicsTyreCompound_GT3_Soft: gt3Compound(
    'PhysicsTyreCompound_GT3_Soft',
    'GT3 Soft',
    'S',
    1.84,
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
    1.817,
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
    1.794,
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

/** The slicks plus rain tyres on the medium's carcass [est] */
const TYRES_WITH_RAIN = {
  ...TYRES,
  PhysicsTyreCompound_GT3_Intermediate: deriveRainCompound(
    TYRES.PhysicsTyreCompound_GT3_Medium,
    'intermediate',
    'PhysicsTyreCompound_GT3_Intermediate',
    'GT3 Intermediate'
  ),
  PhysicsTyreCompound_GT3_Wet: deriveRainCompound(TYRES.PhysicsTyreCompound_GT3_Medium, 'wet', 'PhysicsTyreCompound_GT3_Wet', 'GT3 Wet'),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

/** Box inertia from 1.75 × 1.05 × 4.10 m [spec INERTIA, derived] */
const MASS = 1360;
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const AMG_GT3_CONFIG = {
  screenName: 'Mercedes-AMG GT3',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    frontWeightFraction: 0.48,
    wheelbase: WHEELBASE,
    trackWidthFront: 1.75,
    trackWidthRear: 1.72,
    // Hub heights 55 / 60 mm below the CG on the 0.340 / 0.3525 m tyres [spec BASEY, derived]
    cgHeight: 0.4,
    inertia: { pitch: box(1.05, 4.1), roll: box(1.75, 1.05), yaw: box(1.75, 4.1) },
    unsprungMassFront: 39,
    unsprungMassRear: 46,
    wheelInertiaFront: 1.75,
    wheelInertiaRear: 1.95,
    // 320° lock [spec] on ~12.6 ratio: steering-wheel angle per path
    // curvature is 1900 deg·m over the 2.65 m wheelbase [motec]
    maxRoadWheelDeg: 320 / 12.6,
    // Reference telemetry needs ~1.4° of road-wheel angle per g beyond the geometric (Ackermann) angle, ours ~0.3° rigid: this
    // much rack / bush flex makes up the difference without moving the grip limit [motec]
    steerComplianceDegPerKN: 0.28,
    // ~7° caster on a road-car-derived upright: more caster trail than the F1's 12 mm, so a heavier rim
    ffbMechanicalTrailM: 0.025,
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // Auto-clutch 2300–3200 rpm [spec]
  clutch: { maxTorqueNm: 820, biteRpm: 2300, lockRpm: 3200 },
  // Locking torque = preload + POWER / COAST × input torque [spec]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.3, coast: 0.45, preload: 98, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // Iron discs: steel pad μ(T) curve and heat capacities
  // MAX_TORQUE 4750 / FRONT_SHARE 0.71, ADJUST_STEP 0.5 %
  brakes: { maxTorqueNm: 4750, front_bias: 0.71, ebbStep: 0.005, brakeByWire: false, discMaterial: 'endurance-steel' },
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
 * Driver-aid tables [spec]: allowed slip
 * ratio for each of the 12 switch positions, the default position, and the speed traction control starts at. The
 * defaults sit where ABS 3 / TC 3 hold the wheels in reference telemetry: front slip p50 0.077 / p90 0.098 while the ABS works, rear
 * slip p50 0.091 / p90 0.135 while the TC works [motec].
 */
export const AMG_GT3_ELECTRONICS = {
  absLevels: [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17],
  absDefault: 0.09,
  absRateHz: 240,
  tcLevels: [0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19],
  tcDefault: 0.1,
  tcRateHz: 130,
  tcMinSpeedKmh: 40,
};
