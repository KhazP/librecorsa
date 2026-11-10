/**
 * Scheduled races: one starts every slot (20 minutes by default) on the week's challenge circuit and car, for
 * whoever has joined by then. The slots follow from the clock alone, so the game can count down to the next race
 * without asking the server. No three.js, no DOM: the Worker imports this file.
 */
import { challengeAt, type WeeklyChallenge } from "./weekly-challenge";

export const DEFAULT_RACE_SLOT_S = 20 * 60;
/** Nobody new is taken this close to the lights (ms): they are in time for the next race instead */
export const RACE_JOIN_CUTOFF_MS = 15_000;
/** The race server tells everyone the grid this long before the lights (ms) */
export const RACE_COUNTDOWN_MS = 10_000;

export interface RaceSlot {
  /** Slots since the epoch: the race's number */
  index: number;
  /** When its lights start (epoch ms) */
  startsMs: number;
}

export const raceSlot = (index: number, slotS: number): RaceSlot => ({ index, startsMs: index * slotS * 1000 });

/** The next race that can still be joined at `nowMs` */
export function nextRaceSlot(nowMs: number, slotS: number = DEFAULT_RACE_SLOT_S): RaceSlot {
  return raceSlot(Math.ceil((nowMs + RACE_JOIN_CUTOFF_MS) / (slotS * 1000)), slotS);
}

/** The circuit, car, laps and settings of the race in a slot: the challenge of the week it starts in */
export const raceRules = (slot: RaceSlot): WeeklyChallenge => challengeAt(slot.startsMs);

/** "12:34" until `startsMs` (never negative) */
export function countdownLabel(startsMs: number, nowMs: number): string {
  const s = Math.max(0, Math.ceil((startsMs - nowMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
