/**
 * BMW M6 GT3 vehicle data for `VehiclePhysics` (S63/P63 4.4L Twin-Turbo V8).
 *
 * Compared to the 6.2L NA AMG GT3 Evo:
 *  - Longer wheelbase (2.771 m vs 2.625 m) and slightly higher dry+driver mass (1385 kg), giving greater
 *    high-speed stability and a slightly forward static balance (51.5% front from the front-mid twin-turbo V8).
 *  - Twin-turbo V8 torque curve peaking lower (5500 rpm) with fatter mid-range pull (3000–5500 rpm),
 *    7000 rpm redline, and subtle turbo spool lag.
 *  - Longer Ricardo 6-speed sequential ratios paired to the 7000 rpm rev ceiling.
 */
import type { LutPoints } from "../lut";
import type { CarPhysicsConfig } from "../f12026-car/F12026CarConfig";
import { AMG_GT3_CONFIG, AMG_GT3_ELECTRONICS } from "./AmgGt3Config";

const DRIVELINE_EFFICIENCY = 0.92;

/** P63 4.4L Twin-Turbo V8 wheel torque curve (rpm -> Nm at the wheels) */
const WHEEL_TORQUE: [number, number][] = [
  [0, 120],
  [500, 280],
  [1000, 340],
  [1500, 410],
  [2000, 480],
  [2500, 560],
  [3000, 625],
  [3500, 665],
  [4000, 690],
  [4500, 695],
  [5000, 680],
  [5500, 645],
  [6000, 590],
  [6500, 535],
  [7000, 470],
  [7500, 320],
  [8000, 0],
];

/** Endurance BoP shaft power cap (~372 kW / 500 hp at driveshafts across the mid-top band) */
const SHAFT_POWER_CAP: LutPoints = [
  [0, 372],
  [4500, 372],
  [5500, 372],
  [6500, 366],
  [7000, 345],
  [7300, 260],
];

const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [
  rpm,
  ((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000,
]);

const ENGINE = {
  ...AMG_GT3_CONFIG.engine,
  powerCurve: POWER_CURVE,
  outputPowerCap: { curve: SHAFT_POWER_CAP },
  ramAirGainPerKPa: 0.0028,
  coastCurve: [
    [0, 0],
    [7000, 92],
    [8000, 108],
  ] as LutPoints,
  torqueResponseS: { rise: 0.045, fall: 0.025 },
  idleRpm: 1900,
  inertia: 0.162,
  turbo: {
    maxBoost: 1.45,
    referenceRpm: 3500,
    gamma: 1.5,
    spoolUpS: 0.22,
    spoolRefRpm: 4500,
    spoolDownS: 0.14,
    displayMaxBoostBar: 1.45,
  },
};

const SPRINT_GEARS = {
  label: "Sprint",
  ratios: [2.42, 1.88, 1.46, 1.18, 1.01, 0.885],
  reverse: 3.65,
  finalDrive: 3.38,
};

const LOW_DRAG_GEARS = {
  label: "Low drag",
  ratios: [2.42, 1.88, 1.46, 1.18, 0.99, 0.85],
  reverse: 3.65,
  finalDrive: 3.22,
};

export const BMW_M6_GT3_CONFIG: CarPhysicsConfig = {
  ...AMG_GT3_CONFIG,
  screenName: "BMW M6 GT3",
  chassis: {
    ...AMG_GT3_CONFIG.chassis,
    totalMassKg: 1385,
    frontWeightFraction: 0.515,
    wheelbase: 2.771,
    trackWidthFront: 1.752,
    trackWidthRear: 1.664,
    cgHeight: 0.435,
    inertia: { pitch: 1960, roll: 515, yaw: 2240 },
    bodyPlan: [
      [0.0, 2.38],
      [0.58, 2.32],
      [0.98, 2.05],
      [1.01, 0.8],
      [1.01, -1.85],
      [0.92, -2.25],
      [0.62, -2.38],
      [0.0, -2.38],
    ],
  },
  engine: ENGINE,
  gearbox: {
    ...AMG_GT3_CONFIG.gearbox,
    ratios: [...SPRINT_GEARS.ratios],
    reverse: SPRINT_GEARS.reverse,
    finalDrive: SPRINT_GEARS.finalDrive,
    gears: {
      redline_rpm: 7000,
      upshift_rpm: 6750,
      downshift_rpm: 3500,
      brake_downshift_rpm: 5850,
    },
  },
  gearSets: [SPRINT_GEARS, LOW_DRAG_GEARS],
  clutch: { maxTorqueNm: 880, biteRpm: 2100, lockRpm: 3000 },
  differential: {
    ...AMG_GT3_CONFIG.differential,
    settings: {
      ...AMG_GT3_CONFIG.differential.settings,
      power: 0.34,
      coast: 0.54,
      preload: 65,
    },
  },
  brakes: {
    ...AMG_GT3_CONFIG.brakes,
    maxTorqueNm: 4950,
    front_bias: 0.65,
  },
  aero: {
    ...AMG_GT3_CONFIG.aero,
    wings: AMG_GT3_CONFIG.aero.wings.map((w, i) => ({
      ...w,
      area: w.area * (i === 1 ? 1.02 : 0.98),
      lutAOA_CD: w.lutAOA_CD.map(([a, cd]) => [a, cd * 0.97] as [number, number]),
    })),
  },
};

export const BMW_M6_GT3_ELECTRONICS = AMG_GT3_ELECTRONICS;
