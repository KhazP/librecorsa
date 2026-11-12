import { useSyncExternalStore } from "react";
import type { VehicleModelId } from "@/types/f1";
import { carById, type CarId } from "@/lib/cars/car-registry";

/**
 * Which vehicle model a ported F1 car (one with its own GLB) drives on: the 6-DOF rigid-body model (default) or the
 * F1 2026 Prototype's. None is listed now, so the switch shows nowhere. The F1 2026 Prototype keeps its own model; the GT3s have one model. The rigid-body model
 * has no car of its own in the list: a saved choice of it opens the Prototype.
 */
export type F1ModPhysics = Extract<VehicleModelId, "f12026-car" | "vf26">;

export const F1_MOD_PHYSICS_OPTIONS: readonly { id: F1ModPhysics; title: string; sub: string }[] = [
  { id: "f12026-car", title: "Rigid-body", sub: "6-DOF multibody · track colliders · DRS" },
  { id: "vf26", title: "2026 Prototype", sub: "The Prototype's car · active aero" },
];

const STORAGE_KEY = "librecorsa.f1ModPhysics";
const DEFAULT: F1ModPhysics = "f12026-car";

const isF1ModPhysics = (v: unknown): v is F1ModPhysics => v === "f12026-car" || v === "vf26";

function load(): F1ModPhysics {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("f1physics");
    if (isF1ModPhysics(fromUrl)) return fromUrl;
    const saved = localStorage.getItem(STORAGE_KEY);
    return isF1ModPhysics(saved) ? saved : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

let current: F1ModPhysics | null = null;
const listeners = new Set<() => void>();

export function getF1ModPhysics(): F1ModPhysics {
  if (current === null) current = typeof window === "undefined" ? DEFAULT : load();
  return current;
}

export function setF1ModPhysics(next: F1ModPhysics): void {
  if (next === getF1ModPhysics()) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
  listeners.forEach((l) => l());
}

export function subscribeF1ModPhysics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useF1ModPhysics(): F1ModPhysics {
  return useSyncExternalStore(subscribeF1ModPhysics, getF1ModPhysics, () => DEFAULT);
}

/** Whether the physics switch applies to this car: a ported F1 car (its own GLB on the generic rig) */
export const carTakesPhysicsSwitch = (id: CarId): boolean => {
  const def = carById(id);
  return def.classId === "f1" && !!def.modelUrl;
};

/** The vehicle model a car drives on, with the physics switch applied to the ported F1 cars */
export const carPhysics = (id: CarId, modPhysics: F1ModPhysics = getF1ModPhysics()): VehicleModelId =>
  carTakesPhysicsSwitch(id) ? modPhysics : carById(id).physics;
