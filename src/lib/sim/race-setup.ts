/**
 * How an AI race is set up: length, field, grid, racecraft, damage and the start. Saved with the player's settings and read when
 * a race is started (changes apply from the next start).
 */
import type { DamageLevel } from './car-damage';
import type { AiRace, RaceDriverLabel } from './ai-race';
import { RACE_START_MODES, type RaceStartMode } from './race-start';
import type { CarClassId } from '@/lib/cars/car-registry';
import { resolveRaceRules, type RaceStartChoice, type ResolvedRaceRules, type RulePresetId, type TrackLimitsChoice } from './race-rules';

export type PlayerGridSlot = 'back' | 'middle' | 'front' | 'random';
export type AiGridOrder = 'pace' | 'qualifying' | 'reversed';
export type RaceStartKind = 'standing' | 'rolling';
/** How hard the field races: added to each driver's own temperament */
export type RaceAggression = 'clean' | 'normal' | 'hard';

export interface RaceSetup {
  laps: number;
  /** AI cars in the field */
  opponents: number;
  /** The player's grid slot */
  grid: PlayerGridSlot;
  /** How the AI cars line up */
  aiGrid: AiGridOrder;
  damage: DamageLevel;
  /** The start: by the rules preset (`auto`), or one outright */
  startMode: RaceStartChoice;
  /** A standing start's launch: the car pulls away by itself, or the player holds the clutch and the revs */
  launch: RaceStartMode;
  aggression: RaceAggression;
  /** Sporting rules: by the player's car class (`auto`), or a preset outright (race-rules.ts) */
  rulePreset: RulePresetId;
  /** Track limits judged by the preset's ladder, or off (course cuts are still penalised) */
  trackLimits: TrackLimitsChoice;
}

export const DEFAULT_RACE_SETUP: RaceSetup = {
  laps: 5,
  opponents: 5,
  grid: 'back',
  aiGrid: 'qualifying',
  damage: 'reduced',
  startMode: 'auto',
  launch: 'assisted',
  aggression: 'normal',
  rulePreset: 'auto',
  trackLimits: 'auto',
};

export const RACE_LAP_OPTIONS = [3, 5, 10, 20] as const;
/** Every AI car runs the full vehicle model: more cars cost frame time on slower machines */
export const RACE_OPPONENT_OPTIONS = [3, 5, 7, 9] as const;
export const MAX_RACE_OPPONENTS = 11;

export const PLAYER_GRID_LABELS: Record<PlayerGridSlot, string> = { back: 'Back', middle: 'Middle', front: 'Pole', random: 'Random' };
export const AI_GRID_LABELS: Record<AiGridOrder, string> = { pace: 'By pace', qualifying: 'Qualifying', reversed: 'Reversed' };
export const RACE_START_LABELS: Record<RaceStartChoice, string> = { auto: 'Auto', standing: 'Standing', rolling: 'Rolling' };
/** ", standing start" for a summary line; nothing when the start follows the car's class */
export const raceStartSuffix = (choice: RaceStartChoice, sep: string): string =>
  choice === 'auto' ? '' : `${sep}${RACE_START_LABELS[choice].toLowerCase()} start`;
export const RACE_AGGRESSION_LABELS: Record<RaceAggression, string> = { clean: 'Clean', normal: 'Normal', hard: 'Hard' };
/**
 * Added to each driver's temperament (−1 waits for a clear gap and rarely defends … +1 late lunges, covers every
 * inside): clean racing gives more room and passes less, hard racing dives later and defends more
 */
export const RACE_AGGRESSION_OFFSET: Record<RaceAggression, number> = { clean: -0.5, normal: 0, hard: 0.4 };

const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
const int = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : fallback;

/** A saved race setup, with anything missing or out of range back at its default */
export function parseRaceSetup(raw: unknown): RaceSetup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_RACE_SETUP;
  return {
    laps: int(r.laps, 1, 50, d.laps),
    opponents: int(r.opponents, 1, MAX_RACE_OPPONENTS, d.opponents),
    grid: pick(r.grid, ['back', 'middle', 'front', 'random'] as const, d.grid),
    aiGrid: pick(r.aiGrid, ['pace', 'qualifying', 'reversed'] as const, d.aiGrid),
    damage: pick(r.damage, ['off', 'reduced', 'full'] as const, d.damage),
    // Saved before the rules presets: a rolling start was a choice, a standing one the old default
    startMode: pick(r.startMode, ['auto', 'standing', 'rolling'] as const, r.start === 'rolling' ? 'rolling' : d.startMode),
    launch: pick(r.launch, RACE_START_MODES, d.launch),
    aggression: pick(r.aggression, ['clean', 'normal', 'hard'] as const, d.aggression),
    rulePreset: pick(r.rulePreset, ['auto', 'open_wheel', 'endurance_sprint'] as const, d.rulePreset),
    trackLimits: pick(r.trackLimits, ['auto', 'off'] as const, d.trackLimits),
  };
}

/** The rules an AI race with this setup runs to, for the player's car class */
export const rulesForSetup = (classId: CarClassId, setup: RaceSetup): ResolvedRaceRules =>
  resolveRaceRules(classId, { rulePreset: setup.rulePreset, start: setup.startMode, trackLimits: setup.trackLimits });

/**
 * Starts an AI race with the race setup: laps, grid, damage, and the start (standing unless asked otherwise) with its
 * launch, the player under their own driver code and colour. `auto` starts standing for every class until the rolling
 * start is redone (race-rules.ts `ROLLING_CLASSES`)
 */
export function startAiRace(
  field: AiRace,
  setup: RaceSetup,
  driver: RaceDriverLabel | null,
  standing = setup.startMode !== 'rolling',
): void {
  field.manualStart = standing && setup.launch === 'manual';
  field.playerDriver = driver ? { code: driver.code, color: driver.color } : null;
  field.raceLaps = setup.laps;
  field.gridOrder = setup.aiGrid;
  field.playerGrid = setup.grid;
  field.damageLevel = setup.damage;
  field.aggressionAdd = RACE_AGGRESSION_OFFSET[setup.aggression];
  field.startRace(standing);
}
