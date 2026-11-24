/**
 * LC25 Prototype — 2025 Formula 1 car configuration for `VehiclePhysics`.
 *
 * Clean-room physics specification built strictly from:
 *  - [fia25]    2025 FIA Formula 1 Technical Regulations (Issue 3, 2025-04-07) & Sporting Regulations (Issue 5)
 *  - [pirelli]  2025 FIA / Pirelli Event Notes (Austria `25R11SPI` & Monaco `25R08MNC`)
 *  - [openf1]   2025 OpenF1 qualifying & race telemetry (#4 Norris, Austria Q 63.971 s & Monaco Q 69.954 s)
 *  - [model]    Measured hardpoints & outline of `public/cars/lc25/model/lc25.glb`
 *  - [est]      Engineering estimate for a 2025 ground-effect Formula 1 car (zero third-party mod data)
 *
 * No plank-wear disqualification / exponential plank-wear mechanic is modelled (standard stiff linear floor contact
 * for sparks only).
 */
import type { LutPoints } from '../lut';
import {
  deriveRainCompound,
  type AeroData,
  type BrakesData,
  type CarPhysicsConfig,
  type DamperSettingsUnits,
  type EngineData,
  type ERSData,
  type PerformanceModeData,
  type PerformanceModeName,
  type PhysicsTyreCompound,
  type SuspensionsData,
  type TurboData,
  type TyresCompoundData,
  type WingData,
} from '../f12026-car/F12026CarConfig';

// ---------------------------------------------------------------------------
// Chassis geometry & mass ([fia25] Art. 3 & Art. 4, [model] lc25.glb)
// ---------------------------------------------------------------------------

/** Minimum dry mass incl. 82 kg driver, excl. fuel (kg) [fia25 Art. 4.1] */
const MASS_KG = 800;
/** Static front axle mass share (within 44.6%–46.1% FIA 2025 Art. 4.2 band) */
const FRONT_WEIGHT_FRACTION = 0.454;
/** Wheelbase measured directly from `lc25.glb` (front axle +1.5045, rear -2.0639 m; FIA max 3.600 m) [model] */
const WHEELBASE_M = 3.5684;
/** Track widths measured directly from `lc25.glb` wheel centres [model] */
const TRACK_FRONT_M = 1.5782;
const TRACK_REAR_M = 1.6012;
/** Unloaded 18-inch tyre radii & section widths matching `lc25.glb` [model, fia25] */
const TYRE_FRONT = { width: 0.3284, radius: 0.3607, rimRadius: 0.2286 } as const;
const TYRE_REAR = { width: 0.4050, radius: 0.3600, rimRadius: 0.2286 } as const;

/** Static ground-effect ride heights (m): low-rake 2025 platform [est] */
const STATIC_RH = { front: 0.034, rear: 0.058 } as const;
/** CG height above ground at static ride height (m) [est] */
const CG_HEIGHT_M = 0.295;
/**
 * Floor reference plane below CG in body frame (m): at static ride the CG sits at `CG_HEIGHT_M` above the ground
 * with the body pitched to the static rake between `STATIC_RH.front` and `STATIC_RH.rear`, so the floor clearance
 * directly under the CG is the static height interpolated at the CG (`a / L` rear + `b / L` front).
 */
const STATIC_CG_RH_M = STATIC_RH.front * FRONT_WEIGHT_FRACTION + STATIC_RH.rear * (1 - FRONT_WEIGHT_FRACTION);
const FLOOR_OFFSET_Y = Number((-(CG_HEIGHT_M - STATIC_CG_RH_M)).toFixed(4));

/** Equivalent uniform-box dimensions W × H × L (m) for principal inertias about CG [est] */
const INERTIA_BOX = { width: 0.92, height: 0.60, length: 3.75 } as const;
const boxInertia = (a: number, b: number) => Math.round((MASS_KG / 12) * (a * a + b * b));

/** Unsprung mass per corner (18" rim + Pirelli slick + upright + carbon brake + half links, kg) [est] */
const UNSPRUNG_KG = { front: 30, rear: 34 } as const;

/** Steering rack geometry (360° rim lock-to-lock, 11:1 base ratio, 20.5° max road-wheel angle for Monaco hairpin) */
export const LC25_STEERING = {
  lockDeg: 225.5,
  ratio: 11,
  maxRoadWheelDeg: 20.5,
  mechanicalTrailM: 0.012,
} as const;

export const LC25_TYRE_SETUP_RANGES: {
  coldPsiRange: [number, number];
  frontCamberRange: [number, number];
  rearCamberRange: [number, number];
} = {
  // Cold pressures stated at 20 °C garage reference (includes 14.4 psi rear cold equivalent of 21.0 psi hot)
  coldPsiRange: [13.5, 27],
  frontCamberRange: [-4.0, -1.5],
  rearCamberRange: [-2.8, -0.5],
};

// ---------------------------------------------------------------------------
// Power Unit — 2025 1.6L 90° V6 Turbo-Hybrid + MGU-H + MGU-K ([fia25] Art. 5)
// ---------------------------------------------------------------------------

/**
 * FIA 2025 Art. 5.2.3 fuel mass flow ceiling (kg/s):
 * Q(N) = 0.009 * N + 5.5 kg/h for N < 10,500 rpm; capped at 100.0 kg/h (0.027778 kg/s) at >= 10,500 rpm.
 */
export const LC25_FUEL_FLOW_CURVE_KGS: LutPoints = [
  [0, 5.5 / 3600],
  [4000, (0.009 * 4000 + 5.5) / 3600],
  [6000, (0.009 * 6000 + 5.5) / 3600],
  [8000, (0.009 * 8000 + 5.5) / 3600],
  [10_500, 100 / 3600],
  [15_000, 100 / 3600],
];

/**
 * Passive turbocharger characteristics (bar gauge; ~3.5 bar abs).
 * While MGU-H anti-lag motoring is active (`deployFraction > 0 && ersEnergyJ > 0`), `VehiclePhysics` overrides
 * spool-up to `mguH.spoolUpS` (25 ms) and holds a `liftFloorBoostFraction` boost floor off-throttle; in `CHR`
 * mode the turbine falls back to this passive exhaust-driven spool.
 */
const TURBO: TurboData = {
  maxBoost: 2.5,
  referenceRpm: 7500,
  gamma: 1.8,
  spoolUpS: 0.24,
  spoolRefRpm: 10_000,
  spoolDownS: 0.16,
  displayMaxBoostBar: 2.5,
};

/**
 * 1.6L V6 turbo ICE crank power (rpm → kW) under the 100 kg/h fuel mass flow limit [fia25 Art. 5.2.3, est]:
 * ~52% thermal efficiency on E10 race fuel peaks near 638 kW (~855 hp) across 10,500–12,300 rpm. Combined with
 * 120 kW MGU-K this delivers ~758 kW (~1,016 hp) at the crank (~724 kW at the rear wheels).
 */
const POWER_CURVE: LutPoints = [
  [1000, 38],
  [2500, 102],
  [3500, 155],
  [5000, 275],
  [6500, 390],
  [8000, 495],
  [9500, 585],
  [10_500, 632],
  [11_500, 638],
  [12_200, 634],
  [12_800, 618],
  [13_500, 590],
  [14_500, 535],
  [15_000, 495],
];

/** Closed-throttle V6 pumping + friction overrun torque (rpm → Nm, positive magnitude) [est] */
const COAST_CURVE: LutPoints = [
  [0, 0],
  [3500, 12],
  [6000, 26],
  [9000, 42],
  [12_000, 56],
  [15_000, 68],
];

const ENGINE: EngineData = {
  powerCurve: POWER_CURVE,
  coastCurve: COAST_CURVE,
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ],
  torqueResponseS: { rise: 0.055, fall: 0.04 },
  wetPedalMap: true,
  turbo: TURBO,
  idleRpm: 4000,
  // Crank + flywheel + MGU-K reflected rotor + gearbox input inertia (kg·m²) [est]
  inertia: 0.085,
  limiterCutS: 0.02,
};

/** MGU-K torque envelope at the crank: 200 Nm ceiling up to the 120 kW power knee (5,730 rpm), then 120 kW hyperbola [fia25 Art. 5.3.3] */
function mgukTorqueLut(maxW: number, maxNm: number): LutPoints {
  const kneeRpm = (maxW / maxNm) * (30 / Math.PI);
  const pts: [number, number][] = [
    [0, maxNm],
    [Number(kneeRpm.toFixed(1)), maxNm],
  ];
  for (let rpm = 6000; rpm <= 15_000; rpm += 1000) {
    if (rpm > kneeRpm) pts.push([rpm, Number((maxW / ((rpm * Math.PI) / 30)).toFixed(2))]);
  }
  return pts;
}

const MGUK_TORQUE = mgukTorqueLut(120_000, 200);

/**
 * 2025 FIA ERS + MGU-H architecture [fia25 Art. 5.3.2–5.3.4]:
 * - MGU-K: ±120 kW, 200 Nm max crank torque, 100 km/h standing-start deploy lockout
 * - Energy Store: 4 MJ usable window; 4 MJ/lap ES → MGU-K deploy cap; 2 MJ/lap MGU-K → ES harvest cap
 * - MGU-H: coaxial with turbo shaft (up to 125,000 rpm), unlimited exhaust harvest (~95 kW peak continuous),
 *   unlimited direct MGU-H → MGU-K transfer bypassing the 4 MJ ES cap, unlimited surplus MGU-H → ES charging
 *   bypassing the 2 MJ MGU-K → ES cap, plus anti-lag compressor motoring.
 */
const ERS: ERSData = {
  regulations: 'f1-2025',
  torqueLut: MGUK_TORQUE,
  coastLut: MGUK_TORQUE,
  ERS_MAX_DEPLOY: 120_000,
  maxHarvestW: 120_000,
  ERS_MAX_CHARGE: 4_000_000,
  deployPerLapJ: 4_000_000,
  harvestPerLapJ: 2_000_000,
  deployEfficiency: 0.95,
  harvestEfficiency: 0.95,
  standingStartLockoutKmh: 100,
  liftThrottle: 0.05,
  topGearLiftHarvestW: 90_000,
  liftHarvestEveryGear: { maxAxleTorqueNm: 850 },
  deployVsGear: [
    [0, 0],
    [1, 0.35],
    [2, 0.65],
    [3, 0.9],
    [4, 1],
    [8, 1],
  ],
  mguH: {
    maxHarvestW: 95_000,
    harvestCurve: [
      [0, 0],
      [4500, 0.05],
      [6500, 0.25],
      [8500, 0.58],
      [10_500, 0.88],
      [11_800, 1.0],
      [13_500, 0.96],
    ],
    motorMaxW: 35_000,
    spoolUpS: 0.025,
    liftFloorBoostFraction: 0.62,
  },
};

const mode = (
  performance_mode_name: PerformanceModeName,
  deployVsSpeed: LutPoints,
  socFloor: number,
  rest: Partial<PerformanceModeData> = {}
): PerformanceModeData => ({
  performance_mode_name,
  deployFraction: 1,
  deployVsSpeed,
  socFloor,
  brakeHarvestScale: 1,
  liftHarvestScale: 1,
  topGearClipHarvestW: 0,
  partThrottleHarvestW: 0,
  coastTorqueScale: 1,
  ebbOffset: 0,
  ...rest,
});

const PERFORMANCE_MODES: Record<PerformanceModeName, PerformanceModeData> = {
  // Qualifying / Overtake: full 120 kW deployment across the entire straight down to 0% ES
  PSH: mode(
    'PSH',
    [
      [0, 0],
      [95, 0.45],
      [125, 0.9],
      [155, 1],
      [360, 1],
    ],
    0,
    { liftHarvestScale: 0.4 }
  ),
  // Race: lap-sustainable deployment, slight taper above 300 km/h while MGU-H sustains straight-line power
  RAC: mode(
    'RAC',
    [
      [0, 0],
      [100, 0.4],
      [130, 0.85],
      [165, 1],
      [300, 1],
      [325, 0.68],
      [350, 0.4],
    ],
    0.12,
    { deployFraction: 0.94, liftHarvestScale: 0.85 }
  ),
  // Balanced: conserves ES on longer straights, modest part-throttle recharge
  BAL: mode(
    'BAL',
    [
      [0, 0],
      [105, 0.35],
      [140, 0.8],
      [175, 1],
      [285, 0.9],
      [310, 0.45],
      [335, 0.2],
    ],
    0.22,
    { deployFraction: 0.8, partThrottleHarvestW: 15_000 }
  ),
  // Lift & Coast: corner-exit punch only, lighter overrun drag for coasting into braking zones
  LIC: mode(
    'LIC',
    [
      [0, 0],
      [110, 0.3],
      [145, 0.75],
      [240, 0.75],
      [275, 0.25],
      [300, 0],
    ],
    0.35,
    { deployFraction: 0.58, coastTorqueScale: 0.4, partThrottleHarvestW: 25_000 }
  ),
  // Charge: zero MGU-K deploy, MGU-H anti-lag motoring disabled, full MGU-H + MGU-K ES harvesting
  CHR: mode(
    'CHR',
    [
      [0, 0],
      [360, 0],
    ],
    1,
    {
      deployFraction: 0,
      liftHarvestScale: 1.2,
      partThrottleHarvestW: 70_000,
      topGearClipHarvestW: 85_000,
      coastTorqueScale: 1.15,
    }
  ),
};

// ---------------------------------------------------------------------------
// Suspension (2025 ground-effect pushrod front / pullrod rear + heave packers)
// ---------------------------------------------------------------------------

/** Corner wheel rates (N/m): compliant for roll and single-wheel kerb absorption [est] */
const WHEEL_RATE = { front: 130_000, rear: 92_000 } as const;
/** Third (heave) springs (N/m): primary vertical aero platform support [est] */
const HEAVE_RATE = { front: 255_000, rear: 285_000 } as const;
/** Heave packers: engage cleanly at ~150 km/h to hold floor in peak ground-effect window [est] */
const HEAVE_PACKER = { gap: { front: 0.003, rear: 0.0045 }, rate: 1_100_000 } as const;
/** Anti-roll bars (N/m at wheel) [est] */
const ARB_RATE = { front: 62_000, rear: 25_000 } as const;

function cornerDamper(axle: 'front' | 'rear', zeta: number): DamperSettingsUnits {
  const sprungKg = MASS_KG - 2 * (UNSPRUNG_KG.front + UNSPRUNG_KG.rear);
  const cornerKg = (sprungKg * (axle === 'front' ? FRONT_WEIGHT_FRACTION : 1 - FRONT_WEIGHT_FRACTION)) / 2;
  const critical = 2 * Math.sqrt((WHEEL_RATE[axle] + 2 * ARB_RATE[axle]) * cornerKg);
  const round = (c: number) => Math.round(c / 100) * 100;
  const slow_bump = round(zeta * critical);
  const slow_rebound = round(1.45 * zeta * critical);
  return {
    slow_bump,
    fast_bump: round(0.55 * slow_bump),
    slow_rebound,
    fast_rebound: round(0.55 * slow_rebound),
  };
}

const NO_DAMPER: DamperSettingsUnits = { slow_bump: 0, fast_bump: 0, slow_rebound: 0, fast_rebound: 0 };

/**
 * 3D wishbone + steering link pickup coordinates `[x_inboard, y_up, z_fwd]` from wheel centre (m).
 * Front: high anti-dive top wishbone geometry for 2025 braking pitch stability, low front RC (~28 mm), ~-8°/m bump camber.
 * Rear: pullrod double wishbone with anti-squat, ~76 mm RC, ~-15°/m bump camber.
 */
const FRONT_HARDPOINTS: ReadonlyArray<readonly [number, number, number]> = [
  [0.690, 0.172, 0.040],   // WBCAR_TOP_FRONT
  [0.650, 0.146, -0.340],  // WBCAR_TOP_REAR
  [0.695, -0.036, 0.070],  // WBCAR_BOTTOM_FRONT
  [0.655, -0.044, -0.320], // WBCAR_BOTTOM_REAR
  [0.130, 0.185, -0.015],  // WBTYRE_TOP
  [0.075, -0.030, 0.015],  // WBTYRE_BOTTOM
  [0.680, 0.160, 0.085],   // WBCAR_STEER
  [0.125, 0.175, 0.085],   // WBTYRE_STEER
];

const REAR_HARDPOINTS: ReadonlyArray<readonly [number, number, number]> = [
  [0.680, 0.145, 0.300],   // WBCAR_TOP_FRONT
  [0.740, 0.175, -0.150],  // WBCAR_TOP_REAR
  [0.700, -0.005, 0.220],  // WBCAR_BOTTOM_FRONT
  [0.740, -0.025, -0.200], // WBCAR_BOTTOM_REAR
  [0.125, 0.195, 0.050],   // WBTYRE_TOP
  [0.095, -0.015, 0.040],  // WBTYRE_BOTTOM
  [0.720, 0.165, -0.070],  // WBCAR_STEER (toe link)
  [0.120, 0.185, -0.070],  // WBTYRE_STEER (toe link)
];

/** Exact 2D front-view kinematic roll centre height (m above ground) and bump camber gain (deg/m) from wishbone points */
function wishboneKinematics(
  hp: ReadonlyArray<readonly [number, number, number]>,
  halfTrack: number,
  tyreRadius: number
): { rollCentreHeight: number; camberGainDegPerM: number } {
  const [cTF, cTR, cBF, cBR, tT, tB] = hp;
  const lerpAtZ = (a: readonly [number, number, number], b: readonly [number, number, number], z: number): [number, number] => {
    const dz = b[2] - a[2];
    const u = Math.abs(dz) > 1e-6 ? (z - a[2]) / dz : 0.5;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  const [xUC, yUC] = lerpAtZ(cTF, cTR, tT[2]);
  const [xLC, yLC] = lerpAtZ(cBF, cBR, tB[2]);
  const mU = (yUC - tT[1]) / (xUC - tT[0]);
  const mL = (yLC - tB[1]) / (xLC - tB[0]);
  const xIC = (tB[1] - mL * tB[0] - (tT[1] - mU * tT[0])) / (mU - mL);
  const yIC = tT[1] + mU * (xIC - tT[0]);
  const rollCentreHeight = Number(((halfTrack / xIC) * (yIC + tyreRadius)).toFixed(4));
  const camberGainDegPerM = Number(((-1 / xIC) * (180 / Math.PI)).toFixed(2));
  return { rollCentreHeight, camberGainDegPerM };
}

const FRONT_KIN = wishboneKinematics(FRONT_HARDPOINTS, TRACK_FRONT_M / 2, TYRE_FRONT.radius);
const REAR_KIN = wishboneKinematics(REAR_HARDPOINTS, TRACK_REAR_M / 2, TYRE_REAR.radius);

const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // Austria -3.00° / Monaco -3.25° [pirelli]
    staticCamber: -3.1,
    camberGainKinematic: FRONT_KIN.camberGainDegPerM,
    springs: { wheel_rate: WHEEL_RATE.front, helper_rate: 0, helper_range: 0 },
    heave: {
      rate: HEAVE_RATE.front,
      gap: 0,
      packerGap: HEAVE_PACKER.gap.front,
      packerRate: HEAVE_PACKER.rate,
      progressiveRate: 25_000,
    },
    bumpStop: { range: 0.032, rate: 280_000, progression: 0 },
    droopTravel: 0.015,
    rollCentreHeight: FRONT_KIN.rollCentreHeight,
    arb: ARB_RATE.front,
    hardpoints: FRONT_HARDPOINTS,
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'pull_rod',
    // Austria -1.75° / Monaco -2.25° [pirelli]
    staticCamber: -1.9,
    camberGainKinematic: REAR_KIN.camberGainDegPerM,
    springs: { wheel_rate: WHEEL_RATE.rear, helper_rate: 0, helper_range: 0 },
    heave: {
      rate: HEAVE_RATE.rear,
      gap: 0,
      packerGap: HEAVE_PACKER.gap.rear,
      packerRate: HEAVE_PACKER.rate,
      progressiveRate: 20_000,
    },
    bumpStop: { range: 0.042, rate: 280_000, progression: 0 },
    droopTravel: 0.024,
    rollCentreHeight: REAR_KIN.rollCentreHeight,
    arb: ARB_RATE.rear,
    hardpoints: REAR_HARDPOINTS,
  },
  dampers_controller: {
    front: {
      base: cornerDamper('front', 0.42),
      heave: { slow_bump: 8500, fast_bump: 5000, slow_rebound: 10500, fast_rebound: 6000 },
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.05,
      fastReboundThresholdMs: 0.05,
    },
    rear: {
      base: cornerDamper('rear', 0.42),
      heave: { slow_bump: 9500, fast_bump: 5500, slow_rebound: 11500, fast_rebound: 6500 },
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.05,
      fastReboundThresholdMs: 0.05,
    },
  },
};

// ---------------------------------------------------------------------------
// Ground-Effect Aerodynamics + Rear-Only DRS ([fia25] Art. 3, [openf1], [est])
// ---------------------------------------------------------------------------

/** Yaw sensitivity helper: CL × max(0, 1 + gain * |yaw_rad|) */
const yawTable = (gain: number): LutPoints =>
  [0, 2, 5, 10, 20, 30].map((deg) => [deg, Number(Math.max(0, 1 + (gain * deg * Math.PI) / 180).toFixed(4))]);

const WINGS: WingData[] = [
  {
    // 2025 4-element front wing (fixed flap — no front active aero under 2025 rules)
    name: 'FRONT_WING',
    area: 1.12,
    positionZ: 2.65,
    angleDeg: 7.0,
    heightRef: 'front',
    dragY: -0.11,
    lutAOA_CL: [
      [-6, 0.48],
      [0, 0.88],
      [7, 1.30],
      [14, 1.66],
      [20, 1.80],
    ],
    lutAOA_CD: [
      [-6, 0.07],
      [0, 0.095],
      [7, 0.148],
      [14, 0.24],
      [20, 0.36],
    ],
    // Mild ground-effect sensitivity: gains downforce down to ~18 mm, stalls cleanly below 8 mm
    lutGH_CL_mult: [
      [0.0, 0.62],
      [0.008, 0.85],
      [0.016, 1.04],
      [0.024, 1.03],
      [0.034, 1.0],
      [0.06, 0.94],
      [0.12, 0.86],
    ],
    lutGH_CD_mult: [
      [0.0, 1.05],
      [0.02, 1.0],
      [0.06, 0.98],
    ],
    lutYaw_CL_mult: yawTable(-0.55),
  },
  {
    // 2025 full Venturi underbody tunnels (peak ground-effect era: ~2.45 m² CL·A at working ride height)
    name: 'VENTURI_FLOOR',
    area: 3.15,
    positionZ: -0.06,
    angleDeg: 3.5,
    heightRef: 'mean',
    dragY: -0.24,
    lutAOA_CL: [
      [-10, 0.78],
      [3.5, 0.78],
      [15, 0.78],
    ],
    lutAOA_CD: [
      [-10, 0.048],
      [3.5, 0.048],
      [15, 0.048],
    ],
    // Venturi throat peak around 28–38 mm mean ride height; stalls cleanly if grounded (< 14 mm)
    lutGH_CL_mult: [
      [0.0, 0.32],
      [0.012, 0.58],
      [0.020, 0.88],
      [0.028, 1.03],
      [0.036, 1.04],
      [0.046, 0.98],
      [0.065, 0.82],
      [0.100, 0.56],
    ],
    lutGH_CD_mult: [
      [0.0, 1.06],
      [0.025, 1.0],
      [0.05, 0.99],
      [0.1, 0.97],
    ],
    lutYaw_CL_mult: yawTable(-0.18),
  },
  {
    // Rear diffuser ramp & beam wing synergy
    name: 'VENTURI_FLOOR',
    area: 1.22,
    positionZ: -1.62,
    angleDeg: 3.5,
    heightRef: 'rear',
    dragY: -0.22,
    lutAOA_CL: [
      [-10, 0.62],
      [3.5, 0.62],
      [15, 0.62],
    ],
    lutAOA_CD: [
      [-10, 0.055],
      [3.5, 0.055],
      [15, 0.055],
    ],
    lutGH_CL_mult: [
      [0.0, 0.58],
      [0.025, 0.92],
      [0.042, 1.03],
      [0.058, 1.0],
      [0.085, 0.78],
      [0.130, 0.48],
    ],
    lutGH_CD_mult: [
      [0.0, 1.05],
      [0.045, 1.0],
      [0.09, 0.85],
    ],
    lutYaw_CL_mult: yawTable(-0.75),
  },
  {
    // Rear wing main plane + beam wing (fixed when DRS opens)
    name: 'REAR_WING',
    area: 0.56,
    positionZ: -2.18,
    angleDeg: 12.0,
    heightRef: 'rear',
    dragY: 0.54,
    lutAOA_CL: [
      [0, 0.35],
      [6, 0.72],
      [12, 1.06],
      [18, 1.34],
      [24, 1.48],
    ],
    lutAOA_CD: [
      [0, 0.08],
      [6, 0.14],
      [12, 0.25],
      [18, 0.41],
      [24, 0.60],
    ],
    lutGH_CL_mult: [[0, 1]],
    lutGH_CD_mult: [[0, 1]],
    lutYaw_CL_mult: yawTable(-1.35),
  },
  {
    // Rear wing upper DRS flap (FIA 2025 Art. 3.10.10: 9.4–13 mm closed → 85 mm open slot gap, < 0.4 s transition)
    // Open reduces total CD·A by ~0.26 m² (-19% drag → +14..+22 km/h on Spielberg straights) [openf1]
    name: 'REAR_WING',
    area: 0.46,
    positionZ: -2.26,
    angleDeg: 18.0,
    heightRef: 'rear',
    dragY: 0.64,
    lutAOA_CL: [
      [0, 0.18],
      [10, 0.72],
      [18, 1.16],
      [26, 1.44],
    ],
    lutAOA_CD: [
      [0, 0.07],
      [10, 0.34],
      [18, 0.65],
      [26, 0.96],
    ],
    lutGH_CL_mult: [[0, 1]],
    lutGH_CD_mult: [[0, 1]],
    drs: { clMult: 0.16, cdMult: 0.12 },
    lutYaw_CL_mult: yawTable(-0.95),
  },
];

const AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  // Bodywork, exposed 18" wheels, suspension & cooling drag area (m²) [est, openf1]
  // Balanced total CD·A ≈ 1.38 m² DRS closed / ~1.12 m² DRS open (matching 2025 Spielberg 302–306 closed / 318–324 open)
  drag: 0.56,
  dragCentreY: 0.14,
  wings: WINGS,
  front_target_height: STATIC_RH.front,
  rear_target_height: STATIC_RH.rear,
  floorOffsetY: FLOOR_OFFSET_Y,
  // Standard stiff linear floor contact for visual sparks only (no plank wear)
  plank: { y: FLOOR_OFFSET_Y, frontZ: 1.45, rearZ: -1.95 },
  wakeSensitivity: {
    dragWakeMult: 1.0,
    frontLiftWakeMult: 1.15,
    diffuserDraftLiftMult: 1.25,
  },
  drsTransitionS: 0.32,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

// ---------------------------------------------------------------------------
// Brakes — Carbon-Carbon + Rear BBW + Dynamic Brake Migration ([fia25], [openf1])
// ---------------------------------------------------------------------------

/** Carbon-carbon pad μ(T): full grip 400–950 °C, softer bite when cold or overheated [est] */
const PAD_MU_CURVE: LutPoints = [
  [0, 0.60],
  [250, 0.85],
  [400, 1.00],
  [950, 1.00],
  [1150, 0.92],
  [1300, 0.75],
];

const BRAKES: BrakesData = {
  // ~5.9–6.4 g peak at 300+ km/h on warm carbon discs (Austria T1/T3/T4 telemetry) [openf1]
  maxTorqueNm: 7200,
  brakeByWire: true,
  front_bias: 0.56,
  ebbStep: 0.005,
  discMaterial: 'carbon-ceramic',
  padMuCurve: PAD_MU_CURVE,
  discStartTempC: 300,
  rearDuctShare: 0.25,
  // Dynamic forward migration at high pedal pressure (+4% past 45% pedal), tapering off for trail-braking rotation
  migration: { amount: 0.04, rampStart: 0.45 },
};

// ---------------------------------------------------------------------------
// Tyres — 2025 Pirelli 18" (305/720-18 F & 405/720-18 R, 70 °C blankets)
// ---------------------------------------------------------------------------

/** High-load contact-patch saturation curve (identical physical shape to LC26 tune so downforce & roll bars balance cleanly) */
const LOAD_SHAPE: LutPoints = [
  [0, 1.0],
  [4000, 1.0],
  [6000, 0.975],
  [8000, 0.94],
  [10_000, 0.89],
  [12_000, 0.83],
  [16_000, 0.72],
];

function buildLoadCurve(dRef: number, fz0: number, lsExp: number): LutPoints {
  const loads = [0, 1000, 2000, 3000, 4000, 6000, 8000, 10_000, 12_000, 16_000];
  const shapeAt = (fz: number): number => {
    for (let i = 1; i < LOAD_SHAPE.length; i++) {
      if (fz <= LOAD_SHAPE[i][0]) {
        const [x0, y0] = LOAD_SHAPE[i - 1];
        const [x1, y1] = LOAD_SHAPE[i];
        return y0 + ((fz - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return LOAD_SHAPE[LOAD_SHAPE.length - 1][1];
  };
  return loads.map((fz) => {
    const ratio = Math.max(0.2, fz / fz0);
    const mu = dRef * Math.pow(ratio, lsExp - 1) * shapeAt(fz);
    return [fz, Number(mu.toFixed(4))];
  });
}

const pressureSpring = (rate: number, refPsi: number): LutPoints =>
  [refPsi - 8, refPsi - 4, refPsi, refPsi + 4, refPsi + 8].map((psi) => [
    psi,
    Math.round(rate * (0.6 + (0.4 * (psi + 14.7)) / (refPsi + 14.7))),
  ]);

/** 2025 Pirelli thermal curves: 70 °C blanket limit, distinct operating windows per compound [pirelli, est] */
const THERMAL_SOFT: LutPoints = [
  [0, 0.84], [25, 0.88], [50, 0.93], [70, 0.985], [78, 1.0], [96, 1.0],
  [108, 0.985], [125, 0.955], [150, 0.91], [200, 0.84], [260, 0.65],
];
const THERMAL_MEDIUM: LutPoints = [
  [0, 0.83], [25, 0.87], [55, 0.935], [75, 0.985], [85, 1.0], [108, 1.0],
  [122, 0.985], [145, 0.955], [180, 0.91], [230, 0.84], [280, 0.68],
];
const THERMAL_HARD: LutPoints = [
  [0, 0.82], [25, 0.86], [60, 0.935], [82, 0.985], [92, 1.0], [118, 1.0],
  [135, 0.985], [160, 0.96], [200, 0.92], [250, 0.85], [300, 0.72],
];

interface SlickSpec {
  tyre_compound: PhysicsTyreCompound;
  name: string;
  shortName: 'S' | 'M' | 'H';
  dyFront: number;
  dxFront: number;
  dyRear: number;
  dxRear: number;
  rateFront: number;
  rateRear: number;
  falloffLevel: number;
  thermalCurve: LutPoints;
  optimalTempC: [number, number];
}

function makeSlick(s: SlickSpec): TyresCompoundData {
  const fz0Front = 4000;
  const fz0Rear = 4200;
  const lsExpYFront = 0.895;
  const lsExpXFront = 0.925;
  const lsExpYRear = 0.912;
  const lsExpXRear = 0.942;

  const frontModel: TyresCompoundData['modelData'] = {
    Dy0: s.dyFront,
    Dx0: s.dxFront,
    lsExpY: lsExpYFront,
    lsExpX: lsExpXFront,
    Fz0: fz0Front,
    dyCurve: buildLoadCurve(s.dyFront, fz0Front, lsExpYFront),
    dxCurve: buildLoadCurve(s.dxFront, fz0Front, lsExpXFront),
    curve: 'brush',
    friction_limit_angle: 6.6,
    speedSensitivity: 0.002,
    pKy2: 4.2,
    slip_ratio_limit: 0.10,
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    use_slip_falloff: true,
    falloff_level: s.falloffLevel,
    falloff_slope: 4,
    relaxationLengthX: 0.10,
    relaxationLengthY: 0.10,
    rollingResistance: 0.011,
    verticalDamping: 650,
    brakeDxMod: 0,
  };

  const rearModel: TyresCompoundData['modelData'] = {
    ...frontModel,
    Dy0: s.dyRear,
    Dx0: s.dxRear,
    lsExpY: lsExpYRear,
    lsExpX: lsExpXRear,
    Fz0: fz0Rear,
    dyCurve: buildLoadCurve(s.dyRear, fz0Rear, lsExpYRear),
    dxCurve: buildLoadCurve(s.dxRear, fz0Rear, lsExpXRear),
    friction_limit_angle: 5.9,
    relaxationLengthX: 0.12,
    relaxationLengthY: 0.12,
    verticalDamping: 700,
  };

  return {
    name: s.name,
    shortName: s.shortName,
    tyre_compound: s.tyre_compound,
    front: { ...TYRE_FRONT, verticalRateScale: 1 },
    rear: { ...TYRE_REAR, verticalRateScale: 1 },
    modelData: frontModel,
    thermalData: {
      thermalPerformanceCurve: s.thermalCurve,
      optimalTempC: s.optimalTempC,
      tread: { grainGain: 0.125, grainGamma: 0.5, blisterGain: 0.125, blisterGamma: 0.5 },
      surfaceHeatCapacity: 1550,
      coreHeatCapacity: 9800,
      slipHeatShare: 0.35,
      hysteresis: 0.0108,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [4, 0.1],
      thermalVerticalK: -0.0012,
      thermalVerticalRefC: 95,
      pressureHeat: { slipGain: 0.5, crownGain: 0.05 },
    },
    pressureData: {
      // 2025 Pirelli hot-running optimum (~23.5 F / 21.0 R psi; Austria min start 22.5/20.0) [pirelli]
      optimalPsi: 23.5,
      pressureSpringCurve: pressureSpring(s.rateFront, 23.5),
      pressureGripSensitivity: 1.0,
      // FIA 2025 slick tyre blanket temperature cap: 70 °C [fia25 Sport Regs Art. 30.5]
      coldRefC: 70,
      pressureRollingGain: 1.3,
    },
    camberData: {
      camberGain: 0.135 * (s.dyFront / 1.86),
      contact_camber_c1: 1,
      contact_camber_c2: 45,
      dcamber0: 1.22,
      dcamber1: -11,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    rearOverride: {
      modelData: rearModel,
      pressureData: {
        optimalPsi: 21.0,
        pressureSpringCurve: pressureSpring(s.rateRear, 21.0),
      },
      camberData: {
        camberGain: 0.158 * (s.dyRear / 1.94),
        dcamber0: 1.32,
        dcamber1: -11,
      },
    },
  };
}

const SOFT = makeSlick({
  tyre_compound: 'PhysicsTyreCompound_F1_Soft',
  name: 'Soft',
  shortName: 'S',
  dyFront: 1.86,
  dxFront: 1.82,
  dyRear: 1.94,
  dxRear: 1.90,
  rateFront: 315_000,
  rateRear: 345_000,
  falloffLevel: 0.86,
  thermalCurve: THERMAL_SOFT,
  optimalTempC: [78, 96],
});

const MEDIUM = makeSlick({
  tyre_compound: 'PhysicsTyreCompound_F1_Medium',
  name: 'Medium',
  shortName: 'M',
  dyFront: 1.815,
  dxFront: 1.775,
  dyRear: 1.895,
  dxRear: 1.855,
  rateFront: 325_000,
  rateRear: 350_000,
  falloffLevel: 0.85,
  thermalCurve: THERMAL_MEDIUM,
  optimalTempC: [85, 108],
});

const HARD = makeSlick({
  tyre_compound: 'PhysicsTyreCompound_F1_Hard',
  name: 'Hard',
  shortName: 'H',
  dyFront: 1.77,
  dxFront: 1.73,
  dyRear: 1.85,
  dxRear: 1.81,
  rateFront: 332_000,
  rateRear: 355_000,
  falloffLevel: 0.84,
  thermalCurve: THERMAL_HARD,
  optimalTempC: [92, 118],
});

const TYRE_COMPOUNDS = {
  PhysicsTyreCompound_F1_Soft: SOFT,
  PhysicsTyreCompound_F1_Medium: MEDIUM,
  PhysicsTyreCompound_F1_Hard: HARD,
  PhysicsTyreCompound_F1_Intermediate: deriveRainCompound(MEDIUM, 'intermediate', 'PhysicsTyreCompound_F1_Intermediate', 'Intermediate', true),
  PhysicsTyreCompound_F1_Wet: deriveRainCompound(MEDIUM, 'wet', 'PhysicsTyreCompound_F1_Wet', 'Full Wet', true),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

// ---------------------------------------------------------------------------
// Complete LC25 Prototype Vehicle Config
// ---------------------------------------------------------------------------

export const LC25_CAR_CONFIG: CarPhysicsConfig = {
  screenName: 'lc25',
  chassis: {
    totalMassKg: MASS_KG,
    frontWeightFraction: FRONT_WEIGHT_FRACTION,
    wheelbase: WHEELBASE_M,
    trackWidthFront: TRACK_FRONT_M,
    trackWidthRear: TRACK_REAR_M,
    cgHeight: CG_HEIGHT_M,
    inertia: {
      pitch: boxInertia(INERTIA_BOX.height, INERTIA_BOX.length),
      roll: boxInertia(INERTIA_BOX.width, INERTIA_BOX.height),
      yaw: boxInertia(INERTIA_BOX.width, INERTIA_BOX.length),
    },
    unsprungMassFront: UNSPRUNG_KG.front,
    unsprungMassRear: UNSPRUNG_KG.rear,
    fuelTank: { y: 0.20, z: -0.18 },
    wheelInertiaFront: 1.42,
    wheelInertiaRear: 1.68,
    maxRoadWheelDeg: LC25_STEERING.maxRoadWheelDeg,
    ffbMechanicalTrailM: LC25_STEERING.mechanicalTrailM,
    steerComplianceDegPerKN: 0.045,
    powerSteering: { steeringRatio: LC25_STEERING.ratio, deadbandNm: 25, rampNm: 6, maxRatio: 0.45 },
    // Body plan at barrier height, measured from `public/cars/lc25/model/lc25.glb` (`scripts/measure-car-plans.ts`)
    bodyPlan: [
      [0.0, 2.92],
      [0.23, 2.92],
      [1.01, 2.67],
      [1.05, 2.37],
      [0.57, -2.45],
      [0.0, -2.49],
    ],
    chassisTorsion: { torsionalStiffnessNmPerDeg: 55_000, torsionalDampingNmsPerDeg: 320, frontRollInertiaShare: 0.43 },
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: PERFORMANCE_MODES,
  // 8-speed seamless gearbox derived from Norris 2025 Austria/Monaco telemetry scaled to R_rear = 0.3600 m [openf1]
  gearbox: {
    ratios: [3.349, 2.494, 2.040, 1.745, 1.510, 1.299, 1.132, 1.000],
    reverse: 3.6,
    finalDrive: 4.78,
    shiftTimeS: 0.015,
    downshiftTimeS: 0.025,
    shiftTorqueFraction: 0.88,
    upshiftCutS: 0.018,
    efficiency: 0.955,
    gears: {
      redline_rpm: 13_000,
      upshift_rpm: 11_850,
      downshift_rpm: 7600,
      brake_downshift_rpm: 10_800,
    },
  },
  clutch: {
    maxTorqueNm: 1100,
    biteRpm: 4000,
    lockRpm: 5800,
    launchRpm: 8800,
  },
  // 3-phase active electronic LSD (Entry / Mid / Exit + High-Speed stability switch at 220 km/h) [est]
  differential: {
    type: 'LSD_Ramp',
    settings: {
      power: 0.16,
      coast: 0.22,
      preload: 100,
      friction_faces: 1,
      power_ramp_deg: 45,
      coast_ramp_deg: 45,
    },
    halfshaft: { stiffnessNmPerRad: 13_500, dampingNmsPerRad: 35 },
    threePhase: true,
    diffEntryLevel: 4,
    diffMidLevel: 4,
    diffExitLevel: 3,
    hiSpdSwitchKmh: 220,
  },
  brakes: BRAKES,
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: TYRE_COMPOUNDS,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_F1_Soft',
    medium: 'PhysicsTyreCompound_F1_Medium',
    hard: 'PhysicsTyreCompound_F1_Hard',
    intermediate: 'PhysicsTyreCompound_F1_Intermediate',
    wet: 'PhysicsTyreCompound_F1_Wet',
  },
};
