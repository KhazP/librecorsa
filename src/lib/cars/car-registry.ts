import type { VehicleModelId } from "@/types/f1";
import { AMR26_SOUND, type CarSoundSource } from "@/lib/sim/CarAudio";
import { AMG_GT3_SOUND } from "@/lib/sim/gt3/AmgGt3Sim";

/**
 * The cars in the picker, grouped by class. A car is a body and a sound on one of the vehicle models
 * (`VehicleModelId`): setups, telemetry, lap records and leaderboards stay keyed by that model, so a new car only
 * needs its GLB (`public/cars/<id>/model/`), its sound bank (`public/cars/<id>/audio/`) and an entry here.
 * The first car of each vehicle model keeps the model's id, so saved choices and `?car=` links still resolve.
 */
export type CarId = "vf26" | "f12026-car" | "amg-gt3";

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
    sound: AMR26_SOUND,
  },
  {
    id: "f12026-car",
    classId: "f1-2026",
    title: "FA-26 Rigid-Body",
    sub: "6-DOF rigid-body · track colliders · DRS",
    badge: "6-DOF",
    physics: "f12026-car",
    sound: AMR26_SOUND,
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
];

const BY_ID = new Map<string, CarDefinition>(CARS.map((c) => [c.id, c]));

export const isCarId = (value: unknown): value is CarId => typeof value === "string" && BY_ID.has(value);

export const carById = (id: CarId): CarDefinition => BY_ID.get(id) ?? CARS[0];

export const carClass = (id: CarClassId): CarClass => CAR_CLASSES.find((c) => c.id === id) ?? CAR_CLASSES[0];

/** The classes that have cars, in picker order */
export const carClassesInUse = (): CarClass[] => CAR_CLASSES.filter((k) => CARS.some((c) => c.classId === k.id));

export const carsInClass = (id: CarClassId): CarDefinition[] => CARS.filter((c) => c.classId === id);

/** The car that stands for a vehicle model (its first car), e.g. for a leaderboard entry or a class rule */
export const carForVehicle = (vehicle: VehicleModelId): CarDefinition =>
  CARS.find((c) => c.physics === vehicle) ?? CARS[0];
