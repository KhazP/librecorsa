/**
 * The sporting rules of a race, by car class: which track-limits ladder applies, how the race starts, and whether the
 * overtaking aids close inside a yellow zone.
 *
 * Two presets, named for the kind of racing rather than any series:
 *   - open wheel (the F1 cars): a standing start, and track limits as strikes, one point each, four allowed;
 *   - endurance sprint (everything else): track limits as weighted quarter points, five allowed.
 *
 * `auto` picks the preset from the player's car class; the race setup can pick one outright, or override the start or
 * the track limits on their own.
 *
 * No three.js and no DOM: the worker and the race server can import this file.
 */
import { text as t } from "@/lib/text";
import type { CarClassId } from "@/lib/cars/car-registry";
import type { RaceStartKind } from "./race-setup";

export type RulePresetId = "auto" | "open_wheel" | "endurance_sprint";
/** How track-limit excursions are scored in a race. `legacy`: the strike ladder of before (every third strike +3 s, then +5 s) */
export type TrackLimitsScoring = "legacy" | "disabled" | "four_strike" | "weighted_pts";
/** The race setup's choice for track limits: by the preset, or off */
export type TrackLimitsChoice = "auto" | "off";
/** The race setup's choice for the start: by the preset, or one outright */
export type RaceStartChoice = "auto" | RaceStartKind;

export interface ResolvedRaceRules {
  preset: Exclude<RulePresetId, "auto">;
  startKind: RaceStartKind;
  trackLimits: TrackLimitsScoring;
  /** Points to the first time penalty (the black-and-white flag one point before) */
  pointsAllowed: number;
  /** Straight Mode, the rear flap and Overtake Mode stay closed inside a yellow zone */
  lockAidsInYellow: boolean;
}

export interface RaceRulesChoice {
  rulePreset: RulePresetId;
  start: RaceStartChoice;
  trackLimits: TrackLimitsChoice;
}

export const FOUR_STRIKE_POINTS_ALLOWED = 4;
export const WEIGHTED_POINTS_ALLOWED = 5;

/**
 * The classes a rolling start suits under `auto` (the sports prototypes and GT3s, as their series start). Off until
 * the 2x2 rolling start with its pace car is in: today's rolling start lines the field up at racing speed
 */
const ROLLING_CLASSES: readonly CarClassId[] = [];

/** The preset `auto` gives a car class */
export function presetForClass(classId: CarClassId): Exclude<RulePresetId, "auto"> {
  return classId === "f1" ? "open_wheel" : "endurance_sprint";
}

/** The rules a race runs to, from the player's car class and the race setup's choices */
export function resolveRaceRules(classId: CarClassId, choice: Partial<RaceRulesChoice> = {}): ResolvedRaceRules {
  const preset = !choice.rulePreset || choice.rulePreset === "auto" ? presetForClass(classId) : choice.rulePreset;
  const openWheel = preset === "open_wheel";
  const startKind: RaceStartKind =
    choice.start && choice.start !== "auto" ? choice.start : !openWheel && ROLLING_CLASSES.includes(classId) ? "rolling" : "standing";
  const scoring: TrackLimitsScoring = choice.trackLimits === "off" ? "disabled" : openWheel ? "four_strike" : "weighted_pts";
  return {
    preset,
    startKind,
    trackLimits: scoring,
    pointsAllowed: openWheel ? FOUR_STRIKE_POINTS_ALLOWED : WEIGHTED_POINTS_ALLOWED,
    lockAidsInYellow: openWheel,
  };
}

export const RULE_PRESET_LABELS: Record<RulePresetId, string> = {
  get auto() { return t("game.raceRules.auto"); },
  get open_wheel() { return t("game.raceRules.openWheel"); },
  get endurance_sprint() { return t("game.raceRules.endurance"); },
};
/** What each preset judges, for the rows that pick one (the AI race and a private room) */
export const RULE_PRESET_HINTS: Record<RulePresetId, string> = {
  get auto() { return t("game.raceRules.autoHint"); },
  get open_wheel() { return t("game.raceRules.openWheelHint"); },
  get endurance_sprint() { return t("game.raceRules.enduranceHint"); },
};
export const TRACK_LIMITS_CHOICE_LABELS: Record<TrackLimitsChoice, string> = {
  get auto() { return t("game.raceRules.trackLimitsOn"); },
  get off() { return t("game.raceRules.trackLimitsOff"); },
};
