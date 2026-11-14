import type * as THREE from "three";
import type { VehicleModelId } from "@/types/f1";
import type { BuiltTrackData } from "@/lib/track-data";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import type { CarClassRule } from "@/lib/sim/multiplayer-sync";
import { F1Physics2026 } from "@/lib/f1-physics-2026";
import { F12026CarSim, F12026_SIM_PROFILE } from "@/lib/sim/f12026-car/F12026CarSim";
import { F12026_CAR_CONFIG, type CarPhysicsConfig } from "@/lib/sim/f12026-car/F12026CarConfig";
import { createLc26Sim } from "@/lib/sim/f12026-car/Lc26Sim";
import { lc26OnRigidBody } from "./lc26-engine";
import { AMG_GT3_SIM_PROFILE, createAmgGt3Sim } from "@/lib/sim/gt3/AmgGt3Sim";
import { AMG_GT3_CONFIG } from "@/lib/sim/gt3/AmgGt3Config";
import { SUZUKI_LIANA_SIM_PROFILE, createSuzukiLianaSim } from "@/lib/sim/road/SuzukiLianaSim";
import { SUZUKI_LIANA_CONFIG } from "@/lib/sim/road/SuzukiLianaConfig";
import { MTR_496R_SIM_PROFILE, createMtr496rSim } from "@/lib/sim/proto/Mtr496rSim";
import { MTR_496R_CONFIG } from "@/lib/sim/proto/Mtr496rConfig";
import { LC_LMDH_SIM_PROFILE, createLcLmdhSim } from "@/lib/sim/proto/LcLmdhSim";
import { LC_LMDH_CONFIG } from "@/lib/sim/proto/LcLmdhConfig";
import { NISSAN_R33_SIM_PROFILE, createNissanR33Sim } from "@/lib/sim/classic/NissanR33Sim";
import { NISSAN_R33_CONFIG } from "@/lib/sim/classic/NissanR33Config";
import { NISSAN_R32_SIM_PROFILE, createNissanR32Sim } from "@/lib/sim/classic/NissanR32Sim";
import { NISSAN_R32_CONFIG } from "@/lib/sim/classic/NissanR32Config";
import { LC26_ENGINE, LC26_TYRE_SETUP_RANGES } from "@/lib/sim/lc26-data";
import type { CarClassId } from "./car-registry";

/** Cold pressure (psi) and static camber (deg) a model's tyre setup is clamped to */
export interface TyreSetupRanges {
  coldPsiRange: readonly [number, number];
  frontCamberRange: readonly [number, number];
  rearCamberRange: readonly [number, number];
}

/**
 * Everything the game needs to know about a vehicle model (the physics a car drives on), in one place: adding a
 * model is one entry here. Values are read from the model's own config wherever it has them.
 */
export interface VehicleModel {
  id: VehicleModelId;
  classId: CarClassId;
  /** A new car of this model on a circuit; `trackRoot` is the circuit mesh its ground queries hit */
  createSim(track: BuiltTrackData, trackRoot: THREE.Object3D | null): SimulatorCar;
  /** Rev limiter (rpm): the shift beep sounds 150 rpm short of it */
  limiterRpm: number;
  /** Top of the telemetry-out packet's rpm bar */
  telemetryMaxRpm: number;
  tyreSetupRanges: TyreSetupRanges;
  /** The chassis a ported body on this model is fitted to (axles, floor) */
  rigConfig: Pick<CarPhysicsConfig, "chassis" | "aero">;
  /** The model's own car (no ported GLB) has the GT3 dash and mirrors rather than the LC26 wheel display */
  gt3Cockpit: boolean;
  /** The plank throws sparks off the road at speed */
  floorSparks: boolean;
  /**
   * The one tyre this model runs in every compound slot (a road car's street tyre): the menus name it instead of
   * offering slicks and rain tyres. Absent: the soft / medium / hard / intermediate / wet choice
   */
  onlyTyre?: string;
}

export const VEHICLE_MODELS: Readonly<Record<VehicleModelId, VehicleModel>> = {
  lc26: {
    id: "lc26",
    classId: "f1",
    createSim: (track, trackRoot) => {
      // On the rigid-body engine, unless the older one was asked for (`lc26-engine.ts`)
      if (lc26OnRigidBody()) return createLc26Sim(track, trackRoot);
      const car = new F1Physics2026(track);
      if (trackRoot) car.attachTrackRoot(trackRoot);
      return car;
    },
    limiterRpm: LC26_ENGINE.limiterRpm,
    telemetryMaxRpm: LC26_ENGINE.maxRpm,
    tyreSetupRanges: LC26_TYRE_SETUP_RANGES,
    // No ported body runs on the LC26 model today; one would be fitted like the other F1 cars
    rigConfig: F12026_CAR_CONFIG,
    gt3Cockpit: false,
    floorSparks: true,
  },
  "f12026-car": {
    id: "f12026-car",
    classId: "f1",
    createSim: (track, trackRoot) => new F12026CarSim(track, trackRoot),
    limiterRpm: F12026_CAR_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 15000,
    tyreSetupRanges: F12026_SIM_PROFILE,
    rigConfig: F12026_CAR_CONFIG,
    gt3Cockpit: false,
    floorSparks: true,
  },
  "amg-gt3": {
    id: "amg-gt3",
    classId: "gt3",
    createSim: (track, trackRoot) => createAmgGt3Sim(track, trackRoot),
    limiterRpm: AMG_GT3_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 8250,
    tyreSetupRanges: AMG_GT3_SIM_PROFILE,
    rigConfig: AMG_GT3_CONFIG,
    gt3Cockpit: true,
    floorSparks: false,
  },
  liana: {
    id: "liana",
    classId: "road",
    createSim: (track, trackRoot) => createSuzukiLianaSim(track, trackRoot),
    limiterRpm: SUZUKI_LIANA_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 7500,
    tyreSetupRanges: SUZUKI_LIANA_SIM_PROFILE,
    rigConfig: SUZUKI_LIANA_CONFIG,
    // Its only body is the ported GLB, which brings its own cameras
    gt3Cockpit: false,
    floorSparks: false,
    onlyTyre: "Street tyres",
  },
  "mtr-496r": {
    id: "mtr-496r",
    classId: "proto",
    createSim: (track, trackRoot) => createMtr496rSim(track, trackRoot),
    limiterRpm: MTR_496R_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 10_500,
    tyreSetupRanges: MTR_496R_SIM_PROFILE,
    rigConfig: MTR_496R_CONFIG,
    // Its only body is the ported GLB, which brings its own cameras
    gt3Cockpit: false,
    floorSparks: false,
  },
  "lc-lmdh": {
    id: "lc-lmdh",
    classId: "proto",
    createSim: (track, trackRoot) => createLcLmdhSim(track, trackRoot),
    limiterRpm: LC_LMDH_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 9000,
    tyreSetupRanges: LC_LMDH_SIM_PROFILE,
    rigConfig: LC_LMDH_CONFIG,
    // Its only body is a ported GLB, which brings its own cameras
    gt3Cockpit: false,
    floorSparks: false,
  },
  // The classic Nissans: each only body is its ported GLB, which brings its own cameras
  "nissan-r33-jgtc": {
    id: "nissan-r33-jgtc",
    classId: "classic",
    createSim: (track, trackRoot) => createNissanR33Sim(track, trackRoot),
    limiterRpm: NISSAN_R33_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 8000,
    tyreSetupRanges: NISSAN_R33_SIM_PROFILE,
    rigConfig: NISSAN_R33_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
  },
  "nissan-r32-jtcc": {
    id: "nissan-r32-jtcc",
    classId: "classic",
    createSim: (track, trackRoot) => createNissanR32Sim(track, trackRoot),
    limiterRpm: NISSAN_R32_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 9000,
    tyreSetupRanges: NISSAN_R32_SIM_PROFILE,
    rigConfig: NISSAN_R32_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
  },
};

export const vehicleModelSpec = (id: VehicleModelId): VehicleModel => VEHICLE_MODELS[id];

export const isVehicleModelId = (value: unknown): value is VehicleModelId =>
  typeof value === "string" && Object.hasOwn(VEHICLE_MODELS, value);

/**
 * The vehicle models an online room's class rule lets in: an F1 or GT3 room admits that class's models, "any" every
 * model. There is no road-car or prototype rule, so those race only in "any" rooms.
 */
export function vehicleModelsFor(rule: CarClassRule): VehicleModelId[] {
  const classId: CarClassId | null = rule === "f1" ? "f1" : rule === "gt3" ? "gt3" : null;
  return Object.values(VEHICLE_MODELS)
    .filter((m) => classId === null || m.classId === classId)
    .map((m) => m.id);
}
