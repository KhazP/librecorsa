import type * as THREE from "three";
import { text as t } from "@/lib/text";
import type { TireCompound, VehicleModelId } from "@/types/f1";
import type { BuiltTrackData } from "@/lib/track-data";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import type { CarClassRule } from "@/lib/sim/multiplayer-sync";
import { F1Physics2026 } from "@/lib/f1-physics-2026";
import { F12026CarSim, F12026_SIM_PROFILE, type CarSimProfile } from "@/lib/sim/f12026-car/F12026CarSim";
import { F12026_CAR_CONFIG, carCompoundSlots, type CarPhysicsConfig } from "@/lib/sim/f12026-car/F12026CarConfig";
import { createLc26Sim } from "@/lib/sim/f12026-car/Lc26Sim";
import { LC25_SIM_PROFILE, createLc25Sim } from "@/lib/sim/f12025-car/Lc25Sim";
import { LC25_CAR_CONFIG } from "@/lib/sim/f12025-car/Lc25Config";
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
import { BMW_M1_PROCAR_SIM_PROFILE, createBmwM1ProcarSim } from "@/lib/sim/classic/BmwM1ProcarSim";
import { BMW_M1_PROCAR_CONFIG } from "@/lib/sim/classic/BmwM1ProcarConfig";
import { CHAPARRAL_2D_67_SIM_PROFILE, CHAPARRAL_2D_SIM_PROFILE, createChaparral2d67Sim, createChaparral2dSim } from "@/lib/sim/classic/Chaparral2dSim";
import { CHAPARRAL_2D_67_CONFIG, CHAPARRAL_2D_CONFIG } from "@/lib/sim/classic/Chaparral2dConfig";
import { PORSCHE_934_RSR_SIM_PROFILE, createPorsche934RsrSim } from "@/lib/sim/classic/Porsche934RsrSim";
import { PORSCHE_934_RSR_CONFIG } from "@/lib/sim/classic/Porsche934RsrConfig";
import { F12007_SIM_PROFILE, createF12007Sim } from "@/lib/sim/f1-2007/F12007Sim";
import { F12007_CONFIG } from "@/lib/sim/f1-2007/F12007Config";
import { VW_SCIROCCO_SIM_PROFILE, createVwSciroccoSim } from "@/lib/sim/road/VwSciroccoSim";
import { VW_SCIROCCO_CONFIG } from "@/lib/sim/road/VwSciroccoConfig";
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
  /**
   * A new car of this model on a circuit; `trackRoot` is the circuit mesh its ground queries hit. `bodyPlan`: the plan
   * of another body it wears (`CarDefinition.bodyPlan`), taken by the models that carry more than one body (the GT3)
   */
  createSim(track: BuiltTrackData, trackRoot: THREE.Object3D | null, bodyPlan?: readonly (readonly [number, number])[]): SimulatorCar;
  /** Rev limiter (rpm): the shift beep sounds 150 rpm short of it */
  limiterRpm: number;
  /** Top of the telemetry-out packet's rpm bar */
  telemetryMaxRpm: number;
  tyreSetupRanges: TyreSetupRanges;
  /** The chassis a ported body on this model is fitted to (axles, floor), and the axles it drives (the car's card) */
  rigConfig: Pick<CarPhysicsConfig, "chassis" | "aero" | "drivenAxle" | "awd" | "compoundSlots">;
  /** The model's own car (no ported GLB) has the GT3 dash and mirrors rather than the LC26 wheel display */
  gt3Cockpit: boolean;
  /** The plank throws sparks off the road at speed */
  floorSparks: boolean;
  /**
   * The one tyre this model runs in every compound slot (a road car's street tyre): the menus name it instead of
   * offering slicks and rain tyres. Absent: the soft / medium / hard / intermediate / wet choice
   */
  onlyTyre?: string;
  /**
   * The profile the game's car simulation (F12026CarSim) runs this model on: what a mod car's physics file patches
   * (mods/mod-physics.ts). Absent for the LC26, whose own simulation is another
   */
  simProfile?: CarSimProfile;
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
  lc25: {
    id: "lc25",
    classId: "f1",
    createSim: (track, trackRoot) => createLc25Sim(track, trackRoot),
    limiterRpm: LC25_CAR_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 15000,
    tyreSetupRanges: LC25_SIM_PROFILE,
    rigConfig: LC25_CAR_CONFIG,
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
    simProfile: F12026_SIM_PROFILE,
    rigConfig: F12026_CAR_CONFIG,
    gt3Cockpit: false,
    floorSparks: true,
  },
  "amg-gt3": {
    id: "amg-gt3",
    classId: "gt3",
    createSim: (track, trackRoot, bodyPlan) => createAmgGt3Sim(track, trackRoot, bodyPlan),
    limiterRpm: AMG_GT3_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 8250,
    tyreSetupRanges: AMG_GT3_SIM_PROFILE,
    simProfile: AMG_GT3_SIM_PROFILE,
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
    simProfile: SUZUKI_LIANA_SIM_PROFILE,
    rigConfig: SUZUKI_LIANA_CONFIG,
    // Its only body is the ported GLB, which brings its own cameras
    gt3Cockpit: false,
    floorSparks: false,
    get onlyTyre() {
      return t("game.tyres.street");
    },
  },
  "mtr-496r": {
    id: "mtr-496r",
    classId: "proto",
    createSim: (track, trackRoot) => createMtr496rSim(track, trackRoot),
    limiterRpm: MTR_496R_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 10_500,
    tyreSetupRanges: MTR_496R_SIM_PROFILE,
    simProfile: MTR_496R_SIM_PROFILE,
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
    simProfile: LC_LMDH_SIM_PROFILE,
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
    simProfile: NISSAN_R33_SIM_PROFILE,
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
    simProfile: NISSAN_R32_SIM_PROFILE,
    rigConfig: NISSAN_R32_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
  },
  // Pfalzdriver's cars: each one's only body is its ported GLB, which brings its own cameras
  "bmw-m1-procar": {
    id: "bmw-m1-procar",
    classId: "classic",
    createSim: (track, trackRoot) => createBmwM1ProcarSim(track, trackRoot),
    limiterRpm: BMW_M1_PROCAR_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 10_000,
    tyreSetupRanges: BMW_M1_PROCAR_SIM_PROFILE,
    simProfile: BMW_M1_PROCAR_SIM_PROFILE,
    rigConfig: BMW_M1_PROCAR_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
  },
  "vw-scirocco-gtx": {
    id: "vw-scirocco-gtx",
    classId: "road",
    createSim: (track, trackRoot) => createVwSciroccoSim(track, trackRoot),
    limiterRpm: VW_SCIROCCO_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 8000,
    tyreSetupRanges: VW_SCIROCCO_SIM_PROFILE,
    simProfile: VW_SCIROCCO_SIM_PROFILE,
    rigConfig: VW_SCIROCCO_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
    get onlyTyre() {
      return t("game.tyres.street");
    },
  },
  // NPanic's Chaparrals: each one's only body is its ported GLB, which brings its own cameras
  "chaparral-2d": {
    id: "chaparral-2d",
    classId: "classic",
    createSim: (track, trackRoot) => createChaparral2dSim(track, trackRoot),
    limiterRpm: CHAPARRAL_2D_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 8000,
    tyreSetupRanges: CHAPARRAL_2D_SIM_PROFILE,
    simProfile: CHAPARRAL_2D_SIM_PROFILE,
    rigConfig: CHAPARRAL_2D_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
  },
  "chaparral-2d-67": {
    id: "chaparral-2d-67",
    classId: "classic",
    createSim: (track, trackRoot) => createChaparral2d67Sim(track, trackRoot),
    limiterRpm: CHAPARRAL_2D_67_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 8000,
    tyreSetupRanges: CHAPARRAL_2D_67_SIM_PROFILE,
    simProfile: CHAPARRAL_2D_67_SIM_PROFILE,
    rigConfig: CHAPARRAL_2D_67_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
  },
  // Pfalzdriver's 934: its only body is its ported GLB, which brings its own cameras
  "porsche-934-rsr": {
    id: "porsche-934-rsr",
    classId: "classic",
    createSim: (track, trackRoot) => createPorsche934RsrSim(track, trackRoot),
    limiterRpm: PORSCHE_934_RSR_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 9000,
    tyreSetupRanges: PORSCHE_934_RSR_SIM_PROFILE,
    simProfile: PORSCHE_934_RSR_SIM_PROFILE,
    rigConfig: PORSCHE_934_RSR_CONFIG,
    gt3Cockpit: false,
    floorSparks: false,
  },
  // Cimmerian Iter's 2007 grid: one physics for every team; each team's body is its ported GLB, chosen by the livery,
  // and brings its own cameras
  "f1-2007": {
    id: "f1-2007",
    classId: "f1",
    createSim: (track, trackRoot) => createF12007Sim(track, trackRoot),
    limiterRpm: F12007_CONFIG.gearbox.gears.redline_rpm,
    telemetryMaxRpm: 20000,
    tyreSetupRanges: F12007_SIM_PROFILE,
    simProfile: F12007_SIM_PROFILE,
    rigConfig: F12007_CONFIG,
    gt3Cockpit: false,
    floorSparks: true,
  },
};

export const vehicleModelSpec = (id: VehicleModelId): VehicleModel => VEHICLE_MODELS[id];

/**
 * A new car of a model on a circuit, on `profile` when the car has physics of its own (a mod car's physics file, run
 * by the game's car simulation), else the model's own
 */
export function createVehicleSim(
  vehicle: VehicleModelId,
  track: BuiltTrackData,
  trackRoot: THREE.Object3D | null,
  bodyPlan?: readonly (readonly [number, number])[],
  profile?: CarSimProfile,
): SimulatorCar {
  if (profile) return new F12026CarSim(track, trackRoot, profile);
  // Another body on the model (a mod car, the BMW on the AMG): the model's own profile with that body's outline
  const own = VEHICLE_MODELS[vehicle].simProfile;
  if (bodyPlan && own) return new F12026CarSim(track, trackRoot, { ...own, bodyPlan });
  return VEHICLE_MODELS[vehicle].createSim(track, trackRoot, bodyPlan);
}

export const isVehicleModelId = (value: unknown): value is VehicleModelId =>
  typeof value === "string" && Object.hasOwn(VEHICLE_MODELS, value);

/** The vehicle models an online room's class rule lets in: "any" every model, a class its own models */
/**
 * The tyre compounds a car's data fills, softest first: the garage, the pit wall and the pre-race show list these (a
 * super soft only on a car whose data has one). The first is the one the car starts on in the dry
 */
export function carTyreCompounds(vehicle: VehicleModelId): TireCompound[] {
  return carCompoundSlots(VEHICLE_MODELS[vehicle].rigConfig.compoundSlots);
}

/**
 * The compound a car switched to starts on: the last car's, but a car left on its own first (softest) compound starts
 * the next on that one's first (from any car to the F1 2007 its super soft, and back to the other car's soft)
 */
export function switchedCarCompound(
  last: TireCompound,
  lastCompounds: readonly TireCompound[] | undefined,
  nextCompounds: readonly TireCompound[] | undefined
): TireCompound {
  return last === (lastCompounds?.[0] ?? "soft") ? (nextCompounds?.[0] ?? "soft") : last;
}

export function vehicleModelsFor(rule: CarClassRule): VehicleModelId[] {
  return Object.values(VEHICLE_MODELS)
    .filter((m) => rule === "any" || m.classId === rule)
    .map((m) => m.id);
}
