/**
 * Simulation realism level (after Speed Dreams, which gates tyre wear and temperature effects by skill level):
 *
 *  - Casual:   no tyre wear, mild tyre-temperature grip effects, half-strength wet weather
 *  - Standard: tyre wear on, softened tyre-temperature grip effects, wet weather at 3/4
 *  - Full:     the complete model (the default, and what every verify suite tests), with cold starts from the garage
 *
 * The races are sprints: every car carries a fixed fuel load as ballast and burns none, at every level.
 */
import { text as t } from "@/lib/text";

export type SimRealism = 'casual' | 'standard' | 'full';
export const SIM_REALISM_LEVELS: readonly SimRealism[] = ['casual', 'standard', 'full'];

export interface SimRealismFlags {
  /** Multiplier on tread wear (and flat-spotting): 0 = off */
  tyreWearScale: number;
  /** Share of the tyre-temperature grip loss applied (1 = full, smaller = simplified) */
  thermalGripScale: number;
  /** Fuel is burnt (and the car gets lighter). Off at every level: sprint races on a fixed fuel ballast */
  fuelUse: boolean;
  /**
   * A car whose data says it races without tyre blankets leaves the garage on cold tyres and cold brakes (a race's grid
   * and a rolling start come after a formation lap, warm). Off: such a car's tyres and brakes start warm
   */
  coldGarageStart: boolean;
  /** Strength of the wet-road grip loss (1 = full) */
  wetSeverity: number;
}

export const SIM_REALISM_FLAGS: Readonly<Record<SimRealism, Readonly<SimRealismFlags>>> = {
  casual: { tyreWearScale: 0, thermalGripScale: 0.25, fuelUse: false, wetSeverity: 0.5, coldGarageStart: false },
  standard: { tyreWearScale: 1, thermalGripScale: 0.5, fuelUse: false, wetSeverity: 0.75, coldGarageStart: false },
  full: { tyreWearScale: 1, thermalGripScale: 1, fuelUse: false, wetSeverity: 1, coldGarageStart: true },
};

export const FULL_REALISM: Readonly<SimRealismFlags> = SIM_REALISM_FLAGS.full;

export const SIM_REALISM_LABELS: Record<SimRealism, { label: string; detail: string }> = {
  casual: { get label() { return t("game.realism.casual"); }, get detail() { return t("game.realism.casualDetail"); } },
  standard: { get label() { return t("game.realism.standard"); }, get detail() { return t("game.realism.standardDetail"); } },
  full: { get label() { return t("game.realism.full"); }, get detail() { return t("game.realism.fullDetail"); } },
};

/** Tyre-temperature grip with the realism level's share of the loss applied */
export function realismThermalGrip(thermal: number, flags: Readonly<SimRealismFlags>): number {
  return 1 - (1 - thermal) * flags.thermalGripScale;
}
