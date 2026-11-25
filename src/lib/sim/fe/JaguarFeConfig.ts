/**
 * Jaguar I-Type 4 (Gen2 Formula E) vehicle data for `VehiclePhysics`.
 *
 * Calibrated to FIA Formula E Gen2 technical regulations:
 *  - Minimum weight 900 kg with driver, low CG (0.29 m) from the 52 kWh floor-mounted battery pack.
 *  - 200 kW base race power + 50 kW electric Boost / Attack Mode (250 kW peak) via the EV energy store,
 *    with strong regenerative braking (up to 250 kW harvest).
 *  - No ICE combustion lag, no DRS / Straight Mode (fixed single-element front/rear aero), ~280 km/h top speed.
 *  - 18-inch Michelin Pilot Sport all-weather grooved tyres (0.3305 m radius, mu ~1.35).
 */
import type { LutPoints } from "../lut";
import type { CarPhysicsConfig, PerformanceModeData, PerformanceModeName } from "../f12026-car/F12026CarConfig";
import { LC26_CAR_CONFIG } from "../f12026-car/Lc26Config";

/** Base 300 kW (402 hp) electric motor curve with instant launch & strong mid/high-speed pull */
const EV_POWER_CURVE: LutPoints = [
  [0, 0],
  [500, 60],
  [1200, 145],
  [2200, 245],
  [3400, 300],
  [6000, 300],
  [10000, 300],
  [14000, 300],
  [17500, 296],
  [18500, 0],
];

const EV_COAST_CURVE: LutPoints = [
  [0, 0],
  [6000, 14],
  [12000, 22],
  [18000, 28],
];

/** +120 kW Attack Mode / Boost overlay */
const EV_BOOST_TORQUE_LUT: LutPoints = [
  [0, 420],
  [2500, 380],
  [4500, 280],
  [6000, 200],
  [8000, 150],
  [10000, 120],
  [12000, 100],
  [14000, 85],
  [16000, 74],
  [18500, 64],
];

const EV_ERS = {
  ...LC26_CAR_CONFIG.ers,
  regulations: "f1-2026" as const,
  torqueLut: EV_BOOST_TORQUE_LUT,
  coastLut: [
    [0, 0],
    [18000, 0],
  ] as LutPoints,
  ERS_MAX_DEPLOY: 120_000,
  maxHarvestW: 250_000,
  ERS_MAX_CHARGE: 4_600_000,
  deployPerLapJ: 4_600_000,
  harvestPerLapJ: 4_600_000,
  deployEfficiency: 0.94,
  harvestEfficiency: 0.90,
  liftThrottle: 0.05,
  topGearLiftHarvestW: 45_000,
};

const evMode = (
  performance_mode_name: PerformanceModeName,
  deployFraction: number,
  brakeHarvestScale: number,
): PerformanceModeData => ({
  performance_mode_name,
  deployFraction,
  deployVsSpeed: [
    [0, 1],
    [280, 1],
  ],
  socFloor: 0.05,
  brakeHarvestScale,
  liftHarvestScale: 0.35,
  topGearClipHarvestW: 0,
  partThrottleHarvestW: 0,
  coastTorqueScale: 1,
  ebbOffset: 0,
});

const scaleCompound = (c: (typeof LC26_CAR_CONFIG.tyreCompounds)[keyof typeof LC26_CAR_CONFIG.tyreCompounds]) => ({
  ...c,
  front: {
    ...c.front,
    radius: 0.3305,
    width: 0.285,
    rimRadius: 0.2286, // 18-inch rim
  },
  rear: {
    ...c.rear,
    radius: 0.3305,
    width: 0.315,
    rimRadius: 0.2286,
  },
});

const TYRES = {
  PhysicsTyreCompound_F1_Soft: scaleCompound(LC26_CAR_CONFIG.tyreCompounds.PhysicsTyreCompound_F1_Soft),
  PhysicsTyreCompound_F1_Medium: scaleCompound(LC26_CAR_CONFIG.tyreCompounds.PhysicsTyreCompound_F1_Medium),
  PhysicsTyreCompound_F1_Hard: scaleCompound(LC26_CAR_CONFIG.tyreCompounds.PhysicsTyreCompound_F1_Hard),
  PhysicsTyreCompound_F1_Intermediate: scaleCompound(LC26_CAR_CONFIG.tyreCompounds.PhysicsTyreCompound_F1_Intermediate),
  PhysicsTyreCompound_F1_Wet: scaleCompound(LC26_CAR_CONFIG.tyreCompounds.PhysicsTyreCompound_F1_Wet),
};

export const JAGUAR_FE_CONFIG: CarPhysicsConfig = {
  ...LC26_CAR_CONFIG,
  screenName: "Jaguar I-Type 4",
  chassis: {
    ...LC26_CAR_CONFIG.chassis,
    totalMassKg: 900,
    frontWeightFraction: 0.455,
    wheelbase: 3.2505,
    trackWidthFront: 1.319,
    trackWidthRear: 1.5305,
    cgHeight: 0.29,
    inertia: { pitch: 1120, roll: 260, yaw: 1240 },
    maxRoadWheelDeg: 19,
    bodyPlan: [
      [0.0, 2.36],
      [0.52, 2.28],
      [0.86, 1.45],
      [0.88, 0.2],
      [0.91, -1.95],
      [0.72, -2.65],
      [0.0, -2.65],
    ],
  },
  engine: {
    powerCurve: EV_POWER_CURVE,
    coastCurve: EV_COAST_CURVE,
    throttleResponseCurve: [
      [0, 0],
      [1, 1],
    ] as LutPoints,
    torqueResponseS: { rise: 0.008, fall: 0.008 },
    idleRpm: 250,
    inertia: 0.045,
    limiterCutS: 0.015,
  },
  ers: EV_ERS,
  performanceModes: {
    PSH: evMode("PSH", 1.0, 0.85),
    RAC: evMode("RAC", 0.72, 0.95),
    BAL: evMode("BAL", 0.65, 1.0),
    LIC: evMode("LIC", 0.45, 1.0),
    CHR: evMode("CHR", 0.0, 1.0),
  },
  gearbox: {
    ratios: [2.10],
    reverse: 3.4,
    finalDrive: 3.05,
    shiftTimeS: 0.03,
    downshiftTimeS: 0.04,
    shiftTorqueFraction: 0.95,
    efficiency: 0.96,
    gears: {
      redline_rpm: 18500,
      upshift_rpm: 25000,
      downshift_rpm: 0,
      brake_downshift_rpm: 0,
    },
  },
  clutch: {
    maxTorqueNm: 1100,
    biteRpm: 100,
    lockRpm: 450,
    launchRpm: 4500,
  },
  brakes: {
    ...LC26_CAR_CONFIG.brakes,
    maxTorqueNm: 3200,
    front_bias: 0.56,
  },
  aero: {
    ...LC26_CAR_CONFIG.aero,
    // Fixed aero (no DRS / Straight Mode flaps); high F1-like downforce with low drag for ~330 km/h top speed
    wings: LC26_CAR_CONFIG.aero.wings.map((w, i) => ({
      ...w,
      area: w.area * (i === 0 ? 0.78 : 0.82),
      lutAOA_CD: w.lutAOA_CD.map(([a, cd]) => [a, cd * 0.28] as [number, number]),
      drsScale: 1,
    })),
  },
  tyreCompounds: TYRES,
};
