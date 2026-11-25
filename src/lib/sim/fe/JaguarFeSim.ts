/**
 * Jaguar I-Type 4 (Gen2 Formula E) simulator adapter:
 * - Electric powertrain with 200 kW base + 50 kW Attack Mode / Boost (`hasErs: true`)
 * - No Straight Mode / DRS (`hasDrs: false`)
 * - No fuel consumption (`fuelFlowKgS: 0`)
 */
import type { BuiltTrackData } from "@/lib/track-data";
import type * as THREE from "three";
import { OPEN_WHEEL_KEYBOARD_STEER } from "@/lib/input/keyboard-steer";
import type { CarSoundSource } from "../CarAudio";
import type { SpeedProfileCarModel } from "../speed-profile";
import { type CarSimProfile, F12026CarSim, F12026_ELECTRONICS, F1_ASSIST_DIALS } from "../f12026-car/F12026CarSim";
import { JAGUAR_FE_CONFIG } from "./JaguarFeConfig";

export const JAGUAR_FE_SOUND: CarSoundSource = {
  id: "jaguar-fe",
  assetDir: "/cars/f12026/audio/",
  limiterRpm: 12500,
  physicsLimiterRpm: JAGUAR_FE_CONFIG.gearbox.gears.redline_rpm,
  electric: true,
};

const C = JAGUAR_FE_CONFIG;
const tyreRadius = (axle: "front" | "rear") => C.tyreCompounds[C.compoundSlots.soft]?.[axle]?.radius ?? 0.3305;

export const JAGUAR_FE_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 1.55,
  dragCoef: 0.34,
  rearDownforceShare: 0.54,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.62,
  muLong: 1.50,
  maxBrakeForceN:
    0.92 *
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius("front") + (1 - C.brakes.front_bias) / tyreRadius("rear")),
  maxDrivePowerW: 380_000,
  vMaxMs: 93,
};

export const JAGUAR_FE_SIM_PROFILE: CarSimProfile = {
  id: "jaguar-fe",
  config: JAGUAR_FE_CONFIG,
  hasErs: true,
  hasDrs: false,
  turbo: false,
  coldPsiRange: [18, 25],
  setupPressureRefC: 25,
  frontCamberRange: [-3.5, -1.0],
  rearCamberRange: [-2.8, -0.5],
  tcMinSpeedMs: 2,
  electronics: F12026_ELECTRONICS,
  assistDials: F1_ASSIST_DIALS,
  aeroPackagesDeg: { low_downforce: [-1.5, -2], balanced: [0, 0], high_downforce: [1.5, 2.5] },
  padLateralMu: 1.68,
  steerRatio: 12.5,
  braking: { lowG: 1.45, aeroG: 0.75, refMs: 65 },
  understeerRadPerMs2: 0.0012,
  speedProfile: JAGUAR_FE_PROFILE_CAR,
  keyboardSteer: OPEN_WHEEL_KEYBOARD_STEER,
  fuelFlowKgS: 0,
  aiMaxKerbRiseM: 0.06,
};

export function createJaguarFeSim(
  track: BuiltTrackData,
  root?: THREE.Object3D | null,
): F12026CarSim {
  return new F12026CarSim(track, root, JAGUAR_FE_SIM_PROFILE);
}
