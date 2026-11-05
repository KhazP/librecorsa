import type { VehicleModelId } from "@/types/f1";

/**
 * Handling version of each vehicle model. Every recorded lap carries the version of the model it was driven on,
 * and laps only rank against laps of the same version: personal bests, ghosts and the online boards all split by it.
 *
 * BUMP THE MODEL'S NUMBER IN THE SAME COMMIT AS ANY CHANGE THAT MAKES ITS CARS FASTER OR SLOWER: tyre, aero, engine,
 * gearbox, brakes, suspension, mass / fuel, driver aids, track grip or the integrator. Bump only the models the
 * change touches (a GT3-only change bumps "amg-gt3"). Renames, refactors and changes that leave lap times alone
 * (audio, rendering, telemetry, UI) do not bump it. Laps set on an older version stay on their own board.
 *
 * Version 0 is reserved for legacy laps recorded before versions existed.
 */
export const PHYSICS_VERSION: Readonly<Record<VehicleModelId, number>> = {
  vf26: 1,
  "f12026-car": 1,
  "amg-gt3": 1,
};

/** Physics version a lap of this model is recorded with now */
export function physicsVersionOf(vehicle: VehicleModelId): number {
  return PHYSICS_VERSION[vehicle];
}

/** A version number a recording may carry: 0 (legacy) or a positive integer */
export function isPhysicsVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
}
