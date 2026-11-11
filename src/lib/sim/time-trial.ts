/**
 * The time trial (the weekly challenge driven on its own): the same car for everyone on its one tyre, the lightest fuel
 * load it allows, and the road fully rubbered in and held there. Put on the car when the challenge is driven and again
 * at every flying restart, so no lap starts on a heavier tank, other tyres or a greener road than another's.
 *
 * The fuel and the road are not part of a lap's stored conditions: they are the same for every challenge lap.
 */
import type { TireCompound, VehicleModelId } from "@/types/f1";
import { challengeCompound } from "@/lib/net/weekly-challenge";
import { CHASSIS_LIMITS, type ChassisSetup } from "./car-setup";
import type { SimulatorCar } from "./simulator-car";
import type { TrackEvolutionState } from "./track-evolution";

export interface TimeTrialRules {
  /** The car the challenge is driven in: on any other the conditions are not put on */
  vehicle: VehicleModelId;
  compound: TireCompound;
}

/** The time trial of a week's challenge */
export function timeTrialRules(vehicle: VehicleModelId): TimeTrialRules {
  return { vehicle, compound: challengeCompound(vehicle) };
}

/** A garage setup with the lightest fuel load: the fuel step's floor, which every car clamps to its own minimum */
export function lowestFuelSetup(setup: ChassisSetup): ChassisSetup {
  return { ...setup, fuelDeltaKg: CHASSIS_LIMITS.fuelDeltaKg.min };
}

/**
 * Puts the time trial's tyre and fuel on the car (`setup`: the player's garage setup, kept but for its fuel) and
 * holds the road at full grip. Call before the car is placed: the placement fits a fresh set of the tyre and fills the
 * tank from the setup. `setCompound` puts the tyre on the car and its model.
 */
export function applyTimeTrial(
  car: SimulatorCar,
  rules: TimeTrialRules,
  setup: ChassisSetup,
  road: TrackEvolutionState,
  setCompound: (compound: TireCompound) => void
): void {
  if (car.tireCompound !== rules.compound) setCompound(rules.compound);
  car.applyChassisSetup?.(lowestFuelSetup(setup));
  if (!road.fullGrip) road.holdFullGrip(true);
}
