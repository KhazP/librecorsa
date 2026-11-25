/**
 * BMW M6 GT3 simulator adapter: `F12026CarSim` driving `BMW_M6_GT3_CONFIG` with twin-turbo S63/P63 V8 characteristics.
 */
import type { BuiltTrackData } from "@/lib/track-data";
import type * as THREE from "three";
import { type CarSimProfile, F12026CarSim } from "../f12026-car/F12026CarSim";
import { BMW_M6_GT3_CONFIG, BMW_M6_GT3_ELECTRONICS as E } from "./BmwM6Gt3Config";
import type { CarSoundSource } from "../CarAudio";
import type { SpeedProfileCarModel } from "../speed-profile";

export const BMW_M6_GT3_SOUND: CarSoundSource = {
  id: "bmw-m6-gt3",
  assetDir: "/cars/bmw-m4-gt3/audio/",
  limiterRpm: 7000,
  physicsLimiterRpm: BMW_M6_GT3_CONFIG.gearbox.gears.redline_rpm,
};

const C = BMW_M6_GT3_CONFIG;
const tyreRadius = (axle: "front" | "rear") => C.tyreCompounds[C.compoundSlots.soft]?.[axle]?.radius ?? 0.36;

export const BMW_M6_GT3_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 1.19,
  dragCoef: 0.555,
  rearDownforceShare: 0.55,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.52,
  muLong: 1.42,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius("front") + (1 - C.brakes.front_bias) / tyreRadius("rear")),
  maxDrivePowerW: 372_000,
  vMaxMs: 91,
};

export const BMW_M6_GT3_SIM_PROFILE: CarSimProfile = {
  id: "bmw-m6-gt3",
  config: BMW_M6_GT3_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: true,
  coldPsiRange: [18, 26],
  frontCamberRange: [-4.0, -1.5],
  rearCamberRange: [-3.2, -1.0],
  setupPressureRefC: 25,
  steerRatio: 12.6,
  enduranceAbsMaps: true,
  tcSlipAngleDial: true,
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  aeroPackagesDeg: { low_downforce: [-2, -3], balanced: [0, 0], high_downforce: [0, 3] },
  padLateralMu: 1.62,
  braking: { lowG: 1.7, aeroG: 0.55, refMs: 70 },
  understeerRadPerMs2: 0.0014,
  speedProfile: BMW_M6_GT3_PROFILE_CAR,
  racingLine: "gt3",
  fuelFlowKgS: 0.036,
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 5, absLevel: 0, tcSlipAngleLevel: 0 },
    semi_pro: { tcLevel: 10, tc2Level: 6, absLevel: 9, tcSlipAngleLevel: 10 },
    assisted: { tcLevel: 12, tc2Level: 9, absLevel: 11, tcSlipAngleLevel: 12 },
  },
  keyboardSteer: { lowSpeedRate: 1.55, highSpeedRate: 1.05, returnRate: 1.1 },
};

export function createBmwM6Gt3Sim(
  track: BuiltTrackData,
  root?: THREE.Object3D | null,
  bodyPlan?: readonly (readonly [number, number])[],
): F12026CarSim {
  if (!bodyPlan) return new F12026CarSim(track, root, BMW_M6_GT3_SIM_PROFILE);
  return new F12026CarSim(track, root, {
    ...BMW_M6_GT3_SIM_PROFILE,
    config: { ...BMW_M6_GT3_CONFIG, chassis: { ...BMW_M6_GT3_CONFIG.chassis, bodyPlan } },
  });
}
