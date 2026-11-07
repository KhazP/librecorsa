/**
 * How an AI race is set up: length, field, grid, racecraft, damage and the start. Saved with the player's settings and read when
 * a race is started (changes apply from the next start).
 */
import type { DamageLevel } from './car-damage';

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
  start: RaceStartKind;
  aggression: RaceAggression;
}

export const DEFAULT_RACE_SETUP: RaceSetup = {
  laps: 5,
  opponents: 5,
  grid: 'back',
  aiGrid: 'qualifying',
  damage: 'reduced',
  start: 'standing',
  aggression: 'normal',
};

export const RACE_LAP_OPTIONS = [3, 5, 10, 20] as const;
/** Every AI car runs the full vehicle model: more cars cost frame time on slower machines */
export const RACE_OPPONENT_OPTIONS = [3, 5, 7, 9] as const;
export const MAX_RACE_OPPONENTS = 11;

export const PLAYER_GRID_LABELS: Record<PlayerGridSlot, string> = { back: 'Back', middle: 'Middle', front: 'Pole', random: 'Random' };
export const AI_GRID_LABELS: Record<AiGridOrder, string> = { pace: 'By pace', qualifying: 'Qualifying', reversed: 'Reversed' };
export const RACE_START_LABELS: Record<RaceStartKind, string> = { standing: 'Standing', rolling: 'Rolling' };
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
    start: pick(r.start, ['standing', 'rolling'] as const, d.start),
    aggression: pick(r.aggression, ['clean', 'normal', 'hard'] as const, d.aggression),
  };
}
