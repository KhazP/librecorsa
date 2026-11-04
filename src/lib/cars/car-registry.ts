import type { VehicleModelId } from "@/types/f1";
import {
  BMW_M4_GT3_SOUND,
  F2004_SOUND,
  FA26_SOUND,
  R25_SOUND,
  RB8_SOUND,
  RB22_SOUND,
  SF26_SOUND,
  SF71H_SOUND,
  W17_SOUND,
  type CarSoundSource,
} from "@/lib/sim/CarAudio";
import { AMG_GT3_SOUND } from "@/lib/sim/gt3/AmgGt3Sim";

/**
 * The cars in the picker, grouped by class. A car is a body and a sound on one of the vehicle models
 * (`VehicleModelId`): setups, telemetry, lap records and leaderboards stay keyed by that model, so a new car only
 * needs its GLB (`public/cars/<id>/model/`), its sound bank (`public/cars/<id>/audio/`) and an entry here.
 * The first car of each vehicle model keeps the model's id, so saved choices and `?car=` links still resolve.
 */
export type CarId =
  | "vf26"
  | "f12026-car"
  | "sf26"
  | "w17"
  | "rb22"
  | "sf71h"
  | "rb8"
  | "r25"
  | "f2004"
  | "amg-gt3"
  | "amg-gt3-evo"
  | "bmw-m4-gt3";

export type CarClassId = "f1-2026" | "gt3";

export interface CarClass {
  id: CarClassId;
  title: string;
  sub: string;
  color: string;
}

export interface CarDefinition {
  id: CarId;
  classId: CarClassId;
  title: string;
  sub: string;
  badge: string;
  /** The vehicle model that drives it */
  physics: VehicleModelId;
  /** A ported GLB on the generic rig (`ported-car-model.ts`); absent: the vehicle model's own car */
  modelUrl?: string;
  sound: CarSoundSource;
}

export const CAR_CLASSES: readonly CarClass[] = [
  { id: "f1-2026", title: "F1 2026", sub: "Active aero · hybrid", color: "#CCFF00" },
  { id: "gt3", title: "GT3", sub: "ABS · TC", color: "#00E5FF" },
];

export const CARS: readonly CarDefinition[] = [
  {
    id: "vf26",
    classId: "f1-2026",
    title: "FA-26 Prototype",
    sub: "Curvilinear 2026 model · active aero",
    badge: "FA-26",
    physics: "vf26",
    sound: FA26_SOUND,
  },
  {
    id: "f12026-car",
    classId: "f1-2026",
    title: "FA-26 Rigid-Body",
    sub: "6-DOF rigid-body · track colliders · DRS",
    badge: "6-DOF",
    physics: "f12026-car",
    sound: FA26_SOUND,
  },
  {
    id: "sf26",
    classId: "f1-2026",
    title: "SF-26",
    sub: "2026 car · FA-26 physics",
    badge: "SF-26",
    physics: "vf26",
    modelUrl: "/cars/sf26/model/sf26.glb",
    sound: SF26_SOUND,
  },
  {
    id: "w17",
    classId: "f1-2026",
    title: "W17",
    sub: "2026 car · FA-26 physics",
    badge: "W17",
    physics: "vf26",
    modelUrl: "/cars/w17/model/w17.glb",
    sound: W17_SOUND,
  },
  {
    id: "rb22",
    classId: "f1-2026",
    title: "RB22",
    sub: "2026 car · FA-26 physics",
    badge: "RB22",
    physics: "vf26",
    modelUrl: "/cars/rb22/model/rb22.glb",
    sound: RB22_SOUND,
  },
  {
    id: "sf71h",
    classId: "f1-2026",
    title: "SF71H",
    sub: "2018 car · FA-26 physics",
    badge: "SF71H",
    physics: "vf26",
    modelUrl: "/cars/sf71h/model/sf71h.glb",
    sound: SF71H_SOUND,
  },
  {
    id: "rb8",
    classId: "f1-2026",
    title: "RB8",
    sub: "2012 car · FA-26 physics",
    badge: "RB8",
    physics: "vf26",
    modelUrl: "/cars/rb8/model/rb8.glb",
    sound: RB8_SOUND,
  },
  {
    id: "r25",
    classId: "f1-2026",
    title: "R25",
    sub: "2005 car · FA-26 physics",
    badge: "R25",
    physics: "vf26",
    modelUrl: "/cars/r25/model/r25.glb",
    sound: R25_SOUND,
  },
  {
    id: "f2004",
    classId: "f1-2026",
    title: "F2004",
    sub: "2004 car · FA-26 physics",
    badge: "F2004",
    physics: "vf26",
    modelUrl: "/cars/f2004/model/f2004.glb",
    sound: F2004_SOUND,
  },
  {
    id: "amg-gt3",
    classId: "gt3",
    title: "Mercedes-AMG GT3",
    sub: "GT3 Pro · 6.2L V8 · Multi-stage ABS / TC",
    badge: "GT3 PRO",
    physics: "amg-gt3",
    sound: AMG_GT3_SOUND,
  },
  {
    id: "amg-gt3-evo",
    classId: "gt3",
    title: "Mercedes-AMG GT3 Evo",
    sub: "GT3 Evo · AMG GT3 physics · ABS / TC",
    badge: "GT3 EVO",
    physics: "amg-gt3",
    modelUrl: "/cars/amg-gt3-evo/model/amg-gt3-evo.glb",
    sound: AMG_GT3_SOUND,
  },
  {
    id: "bmw-m4-gt3",
    classId: "gt3",
    title: "BMW M4 GT3 Evo",
    sub: "G82 GT3 Evo · AMG GT3 physics · ABS / TC",
    badge: "M4 GT3",
    physics: "amg-gt3",
    modelUrl: "/cars/bmw-m4-gt3/model/bmw-m4-gt3.glb",
    sound: BMW_M4_GT3_SOUND,
  },
];

const BY_ID = new Map<string, CarDefinition>(CARS.map((c) => [c.id, c]));

export const isCarId = (value: unknown): value is CarId => typeof value === "string" && BY_ID.has(value);

export const carById = (id: CarId): CarDefinition => BY_ID.get(id) ?? CARS[0];

export const carClass = (id: CarClassId): CarClass => CAR_CLASSES.find((c) => c.id === id) ?? CAR_CLASSES[0];

/**
 * Whether the livery picker repaints this car. Ported cars (`modelUrl`) keep the paint their GLB was authored
 * with; the menus show "Factory livery" for them instead of the swatches.
 */
export const carTakesLivery = (id: CarId): boolean => !carById(id).modelUrl;

/** Shown in place of the livery swatches for a car that keeps its own paint */
export const FACTORY_LIVERY_NOTE = "Factory livery: this car keeps its original paint.";

/** The classes that have cars, in picker order */
export const carClassesInUse = (): CarClass[] => CAR_CLASSES.filter((k) => CARS.some((c) => c.classId === k.id));

export const carsInClass = (id: CarClassId): CarDefinition[] => CARS.filter((c) => c.classId === id);

/** The car that stands for a vehicle model (its first car), e.g. for a leaderboard entry or a class rule */
export const carForVehicle = (vehicle: VehicleModelId): CarDefinition =>
  CARS.find((c) => c.physics === vehicle) ?? CARS[0];
