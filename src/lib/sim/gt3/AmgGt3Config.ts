/**
 * Mercedes-AMG GT3 Evo vehicle data for `VehiclePhysics` (same data model as the f12026-car, see `F12026CarConfig`).
 *
 * Values are calibrated to FIA GT3 homologation parameters and reference GT3 telemetry:
 *  - [spec]     car / engine / drivetrain / suspensions / tyres / aero / brakes / electronics specification
 *  - [est]      engineering estimate where a runtime value is inferred
 *  - [derived]  computed from other values in this file
 *  - [motec]    fit to reference GT3 Evo MoTeC telemetry logs (Valencia, ~24 min); see scripts/compare-gt3-telemetry.ts
 *  - [ref]      a second GT3 reference data set, used where the first left the car's transient behaviour wrong (platform,
 *               dampers, diff, camber, aero ride-height range); checked against the [motec] bands and the handling
 *               scorecard (scripts/handling-report.ts)
 *
 * No hybrid, DRS or heave spring: the ERS is zeroed, every performance mode is the same map, the heave element
 * has no rate, and the brakes are conventional hydraulics (no brake-by-wire).
 *
 * Trimmed to an endurance GT3 balance of performance [bop]: 1365 kg with the driver, 354 kW at the driveshafts under
 * a torque-sensor cap, a 7450 rpm limiter, a low-drag aero window and harder slicks raced without tyre blankets.
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

/**
 * The endurance balance of performance's restrictors [bop]: the curve × 0.985, ≈ 385 kW (516 hp) at the crank at
 * 7000 rpm, which the driveshaft cap below then holds to 354 kW
 */
const TORQUE_SCALE = 0.985;

/**
 * The regulated power at the driveshafts (rpm → kW after the gearbox's losses) [bop]: 354 kW (475 hp) across
 * 5500–7000 rpm, falling with the curve toward the limiter
 */
const SHAFT_POWER_CAP: LutPoints = [
  [0, 354.5],
  [5500, 354.5],
  [6500, 354],
  [7000, 354],
  [7250, 347.8],
  [7450, 336.7],
  [7600, 312.8],
];

/** Crank power (kW) at the curve's points [derived] */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, ((nm * TORQUE_SCALE) / DRIVELINE_EFFICIENCY) * rpm * Math.PI / 30 / 1000]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  outputPowerCap: { curve: SHAFT_POWER_CAP },
  // The front grille's airbox: its dynamic pressure fills the cylinders a little more at speed, under the cap [est]
  ramAirGainPerKPa: 0.0042,
  // Linear overrun torque, 100 Nm at 8000 rpm [spec COAST_REF]
  coastCurve: [
    [0, 0],
    [8000, 100],
    [9500, 118.75],
  ] as LutPoints,
  // Linear pedal [ref]: the earlier map gave 1.5× torque per pedal between 20 and 50 %, the range a driver feeds the power
  // in on a corner exit, so the rears broke away on a small squeeze
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ] as LutPoints,
  // Drive-by-wire actuator and intake filling ≈ 30 ms opening (90 % of a torque step in ≈ 85 ms at 6000 rpm with the
  // crank revolution), 20 ms closing with the overrun fuel cut [est]
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  idleRpm: 2100,
  // Engine 0.130 + gearbox 0.018 [spec]
  inertia: 0.148,
  // 25 Hz limiter: the cut lasts one cycle [spec LIMITER_HZ]
  limiterCutS: 0.04,
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
 * rear) [motec]; 1st is [spec]; 6th keeps 5th's step [est]. The low-drag set's longer 5th and 6th on a 3.25 final
 * drive reach ≈ 311 km/h at the 7450 rpm limiter, headroom for a tow down a long straight [bop]
 */
const SPRINT_GEARS = { label: 'Sprint', ratios: [2.5, 1.951, 1.521, 1.2414, 1.0847, 0.96], reverse: 3.818, finalDrive: 3.4285 };
const LOW_DRAG_GEARS = { label: 'Low drag', ratios: [2.5, 1.951, 1.521, 1.2414, 1.065, 0.93], reverse: 3.818, finalDrive: 3.25 };
const GEARBOX = {
  ratios: [...SPRINT_GEARS.ratios],
  reverse: SPRINT_GEARS.reverse,
  finalDrive: SPRINT_GEARS.finalDrive,
  // Dog box: 50 ms between gears, the ignition cut for 70 ms [ref CHANGE_UP_TIME, AUTO_CUTOFF_TIME]. The first data set's
  // 100 ms leaves the full-throttle g further from the logs across the changes [motec]
  shiftTimeS: 0.07,
  // [spec CHANGE_DN_TIME]
  downshiftTimeS: 0.1,
  shiftTorqueFraction: 0.1,
  upshiftNeutralS: 0.05,
  upshiftCutS: 0.07,
  // Down: 100 ms between gears, the clutch home from 122 to 168 ms, a 73 % blip, and up to 500 rpm over the limiter
  // [ref CHANGE_DN_TIME, DOWNSHIFT_PROFILE, AUTOBLIP, DOWNSHIFT_PROTECTION]
  downshift: { neutralS: 0.1, clutchReleaseS: 0.122, clutchHomeS: 0.168, blip: { level: 0.73, riseS: 0.01 }, overRevRpm: 500 },
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // The endurance balance of performance's limiter [bop] (the reference logs, on a sprint trim, peak at 7899 rpm)
    redline_rpm: 7450,
    upshift_rpm: 7250,
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
 * kinematic camber gain are what the hardpoints give, matched to the reference car's geometry. No third element.
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // Coilovers on the lower wishbones, no rocker: the leverage grows a little as the arm comes level [est]
    rockerProgressivityPerM: 0.4,
    staticCamber: -3.2,
    camberGainKinematic: -45,
    // Front-stiff platform: ride ≈ 3.2 Hz, so the nose holds its height under braking instead of diving onto the stop
    // [ref], a little softer with the coilover's rising leverage [bop]
    springs: { wheel_rate: 168_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    // Long, soft, progressive urethane rubber [ref] that damps and gives back only part of its force [est]
    bumpStop: { range: 0.0425, rate: 10_000, progression: 1_900_000, damper: 3200, risingDamper: 85_000, reboundElasticShare: 0.55 },
    droopTravel: 0.06,
    // The uprights' ball joints inside the barrel raise the front roll centre from the reference's 24 mm [derived]
    rollCentreHeight: 0.049,
    arb: 68_400, // [ref] front roll share 60 %
    allowNoArb: true,
    // Inner pickup heights and pivot-axis tilts, rack height and steering-arm offset set so the solved geometry matches
    // the reference car's: RC and camber gain above, ≈ 33 % anti-dive, near-parallel steering (−10 % Ackermann),
    // ≈ 3 °/m toe-out in bump [derived, ref]
    hardpoints: [
      [0.440, 0.0804, 0.197],
      [0.440, -0.0062, -0.145],
      [0.487, -0.1670, 0.215],
      [0.487, -0.1906, -0.155],
      // Ball joints inside the 18" barrel: KPI 7.4°, caster 5.3°, 26 mm kingpin scrub and 31 mm trail at the ground
      [0.088, 0.142, -0.014],
      [0.052, -0.136, 0.012],
      [0.447, -0.1554, 0.160],
      [0.097, -0.112, 0.140],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // Coilovers on the lower wishbones, no rocker: the leverage grows a little as the arm comes level [est]
    rockerProgressivityPerM: 0.4,
    staticCamber: -2.3,
    camberGainKinematic: -25,
    springs: { wheel_rate: 132_000, helper_rate: 0, helper_range: 0 }, // [ref, bop]
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    bumpStop: { range: 0.056, rate: 9_000, progression: 1_700_000, damper: 3200, risingDamper: 85_000, reboundElasticShare: 0.55 }, // [ref, est]
    droopTravel: 0.055,
    rollCentreHeight: 0.06,
    arb: 40_200, // [ref]
    allowNoArb: true,
    // As the front: RC and camber gain above, no anti-squat, ≈ 32 % anti-lift, ≈ 7 °/m toe-in in bump [derived, ref]
    hardpoints: [
      [0.440, 0.0838, 0.251],
      [0.440, 0.1086, -0.123],
      [0.520, -0.1092, 0.160],
      [0.520, -0.1337, -0.221],
      [0.128, 0.148, 0.052],
      [0.110, -0.112, -0.055],
      [0.505, -0.1117, -0.250],
      [0.110, -0.100, -0.165],
    ],
  },
  dampers_controller: {
    front: {
      // Matched to the stiffer front spring (bump ζ ≈ 0.86) [ref]
      base: damper(12_080, 5000, 15_880, 10_600),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.0575,
      fastReboundThresholdMs: 0.04,
    },
    rear: {
      // Rear bump ζ 0.48 → 0.81: the rear settles instead of bobbing after a load change [ref]
      base: damper(9990, 4400, 11_840, 8140),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.055,
      fastReboundThresholdMs: 0.04,
    },
  },
};

/** Reference wing area: chord 1 × span 2.1221 m [spec] */
const WING_AREA = 2.1221;
/** CG height at static ride height (m) [bop]: the dry-sump front-mid V8 low in the chassis, the ballast on the floor */
const CG_HEIGHT = 0.368;
const FRONT_TARGET_HEIGHT = 0.055;
const REAR_TARGET_HEIGHT = 0.07;
const WHEELBASE = 2.65;
/** Static rake (deg) [derived] */
const STATIC_RAKE_DEG = (Math.asin((REAR_TARGET_HEIGHT - FRONT_TARGET_HEIGHT) / WHEELBASE) * 180) / Math.PI;
/** Diffuser sits at 2° + pitch; this model feeds the floor its rake, so its angle axis is shifted [derived] */
const DIFFUSER_ANGLE_DEG = 2;
const toRake = (lut: LutPoints): LutPoints => lut.map(([aoa, v]) => [aoa - DIFFUSER_ANGLE_DEG + STATIC_RAKE_DEG, v]);

/**
 * Downforce lost to body yaw (|air slip angle| deg → CL multiplier) [est]. The splitter sits in clean air; the
 * underbody's seal suffers more, and the rear wing works in the cabin's wake, which swings across it as the car slides,
 * so it loses most: ≈ 2–3 % at 5°, 9 % at 10°. Between the second reference set's ≈ 1 % at 10° and the earlier 16 %,
 * which moved the balance forward so far that a slide grew by itself.
 */
const YAW_CL_SPLITTER: LutPoints = [[0, 1], [2, 0.998], [5, 0.99], [10, 0.965], [20, 0.88], [30, 0.78]];
const YAW_CL_FLOOR: LutPoints = [[0, 1], [2, 0.997], [5, 0.985], [10, 0.95], [20, 0.84], [30, 0.72]];
const YAW_CL_REAR_WING: LutPoints = [[0, 1], [2, 0.995], [5, 0.975], [10, 0.91], [20, 0.76], [30, 0.62]];

/**
 * Splitter, diffuser and rear wing with angle-of-attack and ground-height maps; the body's drag is the
 * body element at 0° (it has no lift). [spec] Yaw sensitivity per element [est].
 */
const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  // A closed GT3's body drags as a sports car does (C_D ≈ 0.45 on ≈ 2.1 m²): with the wings, CD·A ≈ 1.07 m² in the
  // sprint trim and ≈ 0.99 in the low-drag one, so the regulated 354 kW reaches ≈ 293 km/h at sea level [bop, derived]
  drag: 0.455 * WING_AREA,
  // A closed car's drag acts near the centroid of its frontal area (≈ 0.55 m up a 1.2 m tall body), raised a little by
  // the rear wing at ≈ 1.15 m: ≈ 0.6 m off the ground, 0.2 m above the 0.40 m CG [est]
  dragCentreY: 0.2,
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
      // Stall flank 20 mm below where it was: it used to start 7–10 mm under the 55 mm static ride, so the splitter lost
      // most of its load at speed and under braking (front aero share 0.48 → 0.12 braking from 250 km/h) [ref]
      lutGH_CL_mult: [
        [0, 0],
        [0.018, 0.2],
        [0.025, 1.07],
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
      lutYaw_CL_mult: YAW_CL_SPLITTER,
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
      // Stall flank moved 20 mm lower with the splitter's [ref]
      lutGH_CL_mult: [
        [0, 0],
        [0.019, 0.02],
        [0.025, 0.3],
        [0.028, 1],
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
      lutYaw_CL_mult: YAW_CL_FLOOR,
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
      lutYaw_CL_mult: YAW_CL_REAR_WING,
    },
  ],
  // A tow saves a GT3 less drag than an open-wheeler's wake model gives it: ≈ 6 km/h at the end of a long straight
  // 12 m behind another car [est]
  wakeSensitivity: { dragWakeMult: 0.18, frontLiftWakeMult: 1, diffuserDraftLiftMult: 1 },
  // Each brake duct step and radiator step's drag and downforce [est]
  cooling: {
    brakeDuctFrontCdAPerStep: 0.0045,
    brakeDuctFrontClAPerStep: -0.008,
    brakeDuctRearCdAPerStep: 0.003,
    brakeDuctRearClAPerStep: -0.005,
    radiatorCdAPerStep: 0.0065,
    radiatorClAPerStep: -0.011,
  },
  // Ground-height maps peak at 45–66 mm; 55 mm is minimum ride height [spec], rake [est]
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  // Floor plane at the mean target height below the 0.368 m CG [derived]
  floorOffsetY: -(CG_HEIGHT - 0.5 * (FRONT_TARGET_HEIGHT + REAR_TARGET_HEIGHT)),
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
 * slip angle, relaxation length, pressure-spring rate, and camber thrust in `rearOverride` ([REAR]). The endurance
 * slicks are harder and longer-lasting than the sprint ones the reference laps ran on [bop]: D_REF (longitudinal)
 * 1.690 / 1.662 / 1.614 (the soft 1.7 % over the medium, the medium 3 % over the hard), × 1.131 across, and three
 * temperature curves.
 *
 * Longitudinal [motec]: on the soft, warm, with fuel aboard, stops with the front slip held at the logs' ABS level
 * pull the logs' braking g within 2 % where the tyres set it, 99 to 189 km/h (1.65 / 1.71 / 1.86 / 2.06 g against
 * 1.68 / 1.72 / 1.83 / 2.03 g, the mean of five stops at each speed). From 225 km/h the pedal is down and the brakes'
 * 4850 Nm and the endurance bodywork's drag set it, 6–7 % over the logs' sprint car.
 */
/**
 * Lateral grip over longitudinal [motec]: warm, with fuel aboard, the car on the soft holds the reference laps'
 * sustained lateral g within 2 % from 81 to 171 km/h (1.72 / 1.77 / 1.82 / 1.98 g against 1.70 / 1.79 / 1.79 /
 * 2.01 g). The 153 km/h bin is one fast corner that sits over the 171 km/h one; the car holds 1.92 g there against
 * 2.13. The same lean on the medium and the hard puts the medium at 1.63 g on an 80 km/h skidpad, inside the
 * endurance slick's 1.62–1.74 g [bop]. Each grip is fitted to its own logs, so the lean is further than the second
 * reference's slick, whose lateral load curve sits 6–10 % over its longitudinal one from 1 to 5 kN [ref]
 */
const GT3_LATERAL_GRIP = 1.131;

/** The rim and inflation cavity of an 18" GT3 wheel [est] */
const GT3_RIM_GAS = {
  rimHeatCapacityJK: 4600,
  rimBrakeOverlapAreaM2: 0.072,
  discToRimEmissivity: 0.58,
  discToRimConvectionWK: [2.8, 0.08] as const,
  rimToAmbientConvectionWK: [6.5, 0.52] as const,
  rimToGasConductanceWK: 16.5,
  carcassToGasConductanceWK: 22,
  gasHeatCapacityJK: 52,
  carcassVolumeStretchPerPsi: 0.0018,
};

/** The reference slick's wear: grip (% of new) against km slid [ref] */
const GT3_WEAR_CURVE: [number, number][] = [
  [0, 100],
  [3.69, 99.62],
  [7.37, 98.93],
  [11.06, 97.96],
  [14.75, 96.87],
  [18.43, 95.82],
  [22.12, 94.78],
  [25.8, 93.47],
  [29.49, 91.58],
  [33.18, 88.81],
  [36.86, 84.87],
  [40.55, 80],
];

function gt3Compound(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  /** D_REF (longitudinal) of the compound */
  gripScale: number,
  thermalCurve: LutPoints,
  window: [number, number],
  /**
   * Tread life (× the distance of its wear curve) [est]: the endurance soft / medium / hard at ≈ 0.47 / 0.75 / 1.12,
   * so a medium loses ≈ 2–3 % a lap of Le Mans and lasts a double stint
   */
  wearLife: number
): TyresCompoundData {
  // Wider 325/705-18 rear slick has ~1.2 % higher peak reference μ at Fz0 = 3910 N and flatter load sensitivity
  const rearGripScale = Number((gripScale * 1.012).toFixed(4));
  return {
    name,
    shortName,
    tyre_compound,
    // Grip against the distance the tread has slid, in proportion to the load over the data's 2.5 kN [ref]: little lost
    // over the first 25 km, then the cliff. The medium and the hard stretch it [est]
    wear: { curve: GT3_WEAR_CURVE.map(([km, pct]) => [Number((km * wearLife).toFixed(2)), pct]), loadScaled: true, loadRefN: 2500 },
    front: GT3_FRONT,
    rear: GT3_REAR,
    modelData: {
      // D_REF of the load-sensitivity law μ = D_REF·(Fz/FZ0)^(LS_EXP−1), plus 16-point tabulated DY_CURVE / DX_CURVE
      Dy0: Number((gripScale * GT3_LATERAL_GRIP).toFixed(4)),
      Dx0: gripScale,
      lsExpY: 0.7917,
      lsExpX: 0.8017,
      Fz0: 3787,
      dyCurve: buildGt3LoadCurve(gripScale * GT3_LATERAL_GRIP, 3787, 0.7917),
      dxCurve: buildGt3LoadCurve(gripScale, 3787, 0.8017),
      // A brush tyre: the brush curve to the peak slip angle [motec, with the steering compliance: understeer gradient
      // 1.43 °/g against the logs' 1.44], and the second reference set's shape data, the peak angle growing 4.3 % per
      // Fz0 of load (3.5 % at the rear) and with a softer tyre, the friction circle, the longitudinal stiffness × 1.05
      // and the grip lost to sliding speed [ref]
      curve: 'brush',
      friction_limit_angle: 6.12,
      peakSlipLoadGain: 0.043,
      peakSlipPressureGain: 0.05,
      combinedExponent: 2,
      longStiffnessMult: 1.05,
      speedSensitivity: 0.000353,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 3.65,
      // Default TC (0.10) and ABS (0.09) limits sit around it [est]
      slip_ratio_limit: 0.1,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // [spec FALLOFF_LEVEL / FALLOFF_SPEED]
      use_slip_falloff: true,
      falloff_level: 0.85,
      falloff_slope: 5, // [ref]
      relaxationLengthX: 0.09883,
      relaxationLengthY: 0.09883,
      rollingResistance: 0.012,
      // Speed term in the proportion of a radial tyre's (Wong, Theory of Ground Vehicles: 0.0136 + 0.40e-7·V², V km/h):
      // +26 % at 300 km/h [derived]
      rollingResistanceSpeedSq: 4.6e-7,
      verticalDamping: 500,
      // No extra longitudinal grip under braking [ref]. It was +9 %, then +3 %: the first stood in for the front downforce
      // the splitter stall used to lose under braking, the second for a braking measure that read the dive, not the
      // grip. Measured over a settled stop the logs fit best with none (3.9 % RMS over 99-243 km/h) [motec]
      brakeDxMod: 0,
    },
    thermalData: {
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // Thermal model estimates
      surfaceHeatCapacity: 1800,
      coreHeatCapacity: 11000,
      slipHeatShare: 0.35,
      // Raced without blankets, the carcass has to warm itself on the out-lap, tread bulk and liner both: the rolling
      // loss nearer the tyre's rolling resistance than the blanketed sprint tyre's 0.0044 [bop, est]
      hysteresis: 0.0084,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      // Through the sidewalls; the rest of the carcass's heat leaves through the gas and the rim [est]
      coreCooling: [4, 0.1],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 90,
      // Slow graining / blistering gains and exponents [ref]; the graining wears off as the tread slides
      tread: { grainGain: 0.5, grainGamma: 1, blisterGain: 0.5, blisterGamma: 1, wearOffWithSlip: true },
      // Pressure in the heat, and the crown it gives the contact patch [est]
      pressureHeat: { slipGain: 0.45, crownGain: 0.62 },
      // An 18" forged wheel; the carcass stretches a little as the pressure rises [est]
      rimGas: { ...GT3_RIM_GAS, rimHeatCapacityJK: 4600 },
    },
    pressureData: {
      optimalPsi: 26.3,
      // 140 kPa in the garage at 25 °C, ≈ 26 psi hot [bop]
      setPsi: 20.3,
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
      // 0.25 % of grip per psi off the ideal [ref]
      pressureGripLossPerPsi: 0.0025,
      // No tyre blankets [bop]: pressures set cold in the garage; mid-window (80 °C of its 70–85 °C peak) after a
      // formation lap, or where the realism level warms them anyway
      coldRefC: 25,
      blanketC: 80,
    },
    camberData: {
      camberGain: 0.134,
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      // Flatter camber curve (peak near 5°, ~3× less curvature): grip changes less with roll and over kerbs [ref]
      dcamber0: 0.802,
      dcamber1: -4.595,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    // The 325/705-18 rear [spec REAR / REAR_1 / REAR_2, flatter load-sensitivity curve + 16-pt DY/DX tables + rear spring gain]
    rearOverride: {
      modelData: {
        Dy0: Number((rearGripScale * GT3_LATERAL_GRIP).toFixed(4)),
        Dx0: rearGripScale,
        Fz0: 3910,
        lsExpY: 0.8044,
        lsExpX: 0.8144,
        dyCurve: buildGt3LoadCurve(rearGripScale * GT3_LATERAL_GRIP, 3910, 0.8044),
        dxCurve: buildGt3LoadCurve(rearGripScale, 3910, 0.8144),
        friction_limit_angle: 6.06,
        peakSlipLoadGain: 0.035,
        speedSensitivity: 0.000351,
        pKy2: 3.75,
        relaxationLengthX: 0.10173,
        relaxationLengthY: 0.10173,
      },
      pressureData: {
        optimalPsi: 26.3,
        setPsi: 20.3,
        // Rear RATE 282 710 N/m at 16 psi + 11 304 N/m per psi [spec REAR PRESSURE_SPRING_GAIN]
        pressureSpringCurve: [
          [16, 282_710],
          [20, 327_926],
          [26, 395_750],
          [30, 440_966],
          [34, 486_182],
        ],
        pressureGripSensitivity: 1.0,
        pressureGripLossPerPsi: 0.0025,
        coldRefC: 25,
        blanketC: 80,
      },
      camberData: {
        camberGain: 0.149,
        dcamber0: 0.688, // [ref]
        dcamber1: -3.942,
      },
    },
  };
}

const TYRES = {
  PhysicsTyreCompound_GT3_Soft: gt3Compound(
    'PhysicsTyreCompound_GT3_Soft',
    'GT3 Soft',
    'S',
    1.69,
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
    [70, 85],
    0.47
  ),
  PhysicsTyreCompound_GT3_Medium: gt3Compound(
    'PhysicsTyreCompound_GT3_Medium',
    'GT3 Medium',
    'M',
    1.662,
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
    [80, 95],
    0.75
  ),
  PhysicsTyreCompound_GT3_Hard: gt3Compound(
    'PhysicsTyreCompound_GT3_Hard',
    'GT3 Hard',
    'H',
    1.614,
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
    [80, 105],
    1.12
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

/** With the driver, no fuel: the endurance balance-of-performance weight [bop] */
const MASS = 1365;

export const AMG_GT3_CONFIG = {
  screenName: 'Mercedes-AMG GT3',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // The ballast box moved the balance a little forward [bop]
    frontWeightFraction: 0.482,
    wheelbase: WHEELBASE,
    trackWidthFront: 1.75,
    trackWidthRear: 1.72,
    cgHeight: CG_HEIGHT,
    // The equivalent box (1.78 × 0.99 × 3.85 m) at 1365 kg, with the cage's and the transaxle's polar mass [bop, derived]
    inertia: { pitch: 1845, roll: 495, yaw: 2110 },
    // An 18 in wheel and tyre (25 kg), the brake, the upright and half the links [ref]
    unsprungMassFront: 45,
    unsprungMassRear: 49,
    // No tank position: the car's balance is fitted to telemetry at the CG it has, and the fuel load of those laps is
    // not known, so the fuel rides at the CG
    // Wheel, tyre and disc about the axle (kg·m²) [ref]
    wheelInertiaFront: 1.6,
    wheelInertiaRear: 1.8,
    // 540° lock to lock on the 12.6 : 1 rack [bop]: steering-wheel angle per path curvature is 1900 deg·m over the
    // 2.65 m wheelbase [motec]
    maxRoadWheelDeg: 270 / 12.6,
    // Reference telemetry needs ~1.4° of road-wheel angle per g beyond the geometric (Ackermann) angle, ours ~0.3° rigid: this
    // much rack / bush flex makes up the difference without moving the grip limit [motec]
    steerComplianceDegPerKN: 0.28,
    // ~7° caster on a road-car-derived upright: more caster trail than the F1's 12 mm, so a heavier rim
    ffbMechanicalTrailM: 0.025,
    // Electro-hydraulic power steering: an electrically driven pump, so its flow (and the assist) follows road speed, as
    // the AMG road car's speed-sensitive steering does. A rotary valve's ≈ 2 Nm on-centre lap, full assist (1.4 Nm per
    // Nm of the driver's, ≈ 60 % of the rack load) 15 Nm later, fading out between 20 and 80 km/h so the corners at
    // speed keep their unassisted weight [est]
    powerSteering: { steeringRatio: 12.6, deadbandNm: 2, rampNm: 15, maxRatio: 1.4, speedFadeMs: [20 / 3.6, 80 / 3.6] },
    // The body's plan at barrier height, measured from amg-gt3-evo.glb (`scripts/measure-car-plans.ts`)
    bodyPlan: [[0.00, 2.22], [0.39, 2.21], [0.99, 2.01], [1.02, -1.61], [0.97, -1.99], [0.78, -2.14], [0.46, -2.34], [0.00, -2.34]],
    // Torsional stiffness between the axle structures: an aluminium spaceframe and a steel roll cage [est]
    chassisTorsion: { torsionalStiffnessNmPerDeg: 31_500, torsionalDampingNmsPerDeg: 270, frontRollInertiaShare: 0.48 },
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  gearSets: [SPRINT_GEARS, LOW_DRAG_GEARS],
  // Auto-clutch 2300–3200 rpm [spec]
  clutch: { maxTorqueNm: 820, biteRpm: 2300, lockRpm: 3200 },
  // Locking torque = preload + POWER / COAST × input torque [spec]: 0.30 power and 0.58 coast lock with the dials where
  // the car has them, 60 Nm of preload. A freer coast than the sprint car's 0.67 helps unblanketed tyres turn in; the
  // preload keeps the rear calm on lift-off and trail braking [ref, bop]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.3, coast: 0.58, preload: 60, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
    // Solid steel Ø 32 mm × 0.55 m from the rear transaxle (G 80 GPa): GJ/L ≈ 15 kNm/rad, ≈ 11.5 kNm/rad with the CV
    // joints; shuffle 7.2 Hz in 1st, 19 Hz in 6th. Damping 10 % of critical for a wheel on its own shaft [est]
    halfshaft: { stiffnessNmPerRad: 11_500, dampingNmsPerRad: 31 },
  },
  // Iron discs: steel pad μ(T) curve and heat capacities. 4850 Nm at full pedal, 64 % of the torque to the front: on
  // the smaller front tyres (0.340 m against 0.3525 m) that is 64.8 % of the braking force at the road, so the wide rears
  // do their share [bop]. No brake-by-wire: the bias is the balance bar's, so it does not migrate with pedal travel
  // [spec]. 35 °C out of the garage, 195 °C after a formation lap [est]
  brakes: {
    maxTorqueNm: 4850,
    front_bias: 0.64,
    ebbStep: 0.005,
    brakeByWire: false,
    discMaterial: 'endurance-steel',
    migration: { amount: 0, rampStart: 0 },
    discStartTempC: 195,
    garageDiscTempC: 35,
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
  // The TC lets the rears run p50 0.091 slip while it works [motec]; with the default 0.10 target that is a light
  // tightening at the ≈1.5 g of a typical corner (0.10 × (1 − 0.055·1.5^1.3) ≈ 0.091), not the F1 sim's 0.074 at 1.6 g
  tcLateralTightening: { gain: 0.055, exponent: 1.3, floor: 0.5 },
  // Cornering-aware like a GT3 TC: once the rears slide past 65 % of their peak slip angle the wheelspin allowed
  // shrinks, so a squeeze of throttle out of a slow corner drives the car instead of stepping the rear out (≈ 3° of slide
  // at the default TC against 13°, and 9 km/h quicker 2 s after the apex), while a flat-out exit still moves the rear a
  // few degrees before the cut catches it. Steady cornering and the [motec] slip are unchanged
  tcDryRearSlide: { gain: 1.0, from: 0.65 },
};
