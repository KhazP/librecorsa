/**
 * Qualifying before an AI race: the player drives alone against a session clock, and the best clean lap sets the
 * grid against the AI cars' times (ai-opponents.ts `assignGrid`).
 *
 * Every lap is timed from a flying start, under the strict limits of practice (any excursion deletes the lap, one in
 * the last sector the next lap too: track-limits.ts). A lap the autopilot drove any of never counts. When the clock
 * runs out, a lap already under way and still clean may be finished: the session ends at the next line crossing.
 * Anything else ends it at once.
 *
 * No three.js and no DOM.
 */

/** Session lengths on offer (min); 0 = no qualifying */
export const QUALIFYING_MINUTES = [0, 5, 10, 15] as const;
export type QualifyingMinutes = (typeof QUALIFYING_MINUTES)[number];

export type QualifyingState = "running" | "last_lap" | "done";

/** One frame of the player's car, as the lap timing sees it */
export interface QualifyingFrame {
  lapCount: number;
  /** The lap just completed (ms) and whether it counted (the physics' own verdict, track limits included) */
  lastLapTimeMs: number | null;
  lastLapValid: boolean;
  /** The lap under way: its clock (ms) and whether it is already deleted */
  currentLapTimeMs: number;
  lapInvalid: boolean;
  /** The autopilot is driving: the lap under way can no longer count */
  autopilot: boolean;
}

export interface QualifyingLap {
  ms: number;
  valid: boolean;
}

export class QualifyingSession {
  elapsedS = 0;
  state: QualifyingState = "running";
  bestMs: number | null = null;
  readonly laps: QualifyingLap[] = [];
  private seenLapCount: number | null = null;
  private seenLapTimeMs: number | null = null;
  /** The lap under way had the autopilot on, or was deleted */
  private tainted = false;

  /** The lap under way can still count */
  get lapCounts(): boolean {
    return !this.tainted;
  }

  constructor(readonly durationS: number) {}

  get remainingS(): number {
    return Math.max(0, this.durationS - this.elapsedS);
  }

  /** One frame of driving (the clock stands still while paused or in the menus: not called then) */
  update(dtS: number, f: QualifyingFrame): QualifyingState {
    if (this.state === "done") return this.state;
    this.elapsedS += Math.max(0, dtS);
    const completed = this.seenLapCount !== null && f.lapCount > this.seenLapCount && f.lastLapTimeMs !== null && f.lastLapTimeMs > 0;
    // The lap clock going back with no lap completed: the run was restarted, a fresh lap under way
    const restarted = !completed && this.seenLapTimeMs !== null && f.currentLapTimeMs + 50 < this.seenLapTimeMs;
    this.seenLapCount = f.lapCount;
    this.seenLapTimeMs = f.currentLapTimeMs;
    if (restarted) {
      // After the flag a restart is no lap under way any more
      if (this.state === "last_lap") {
        this.state = "done";
        return this.state;
      }
      this.tainted = false;
    }
    if (completed) {
      const valid = f.lastLapValid && !this.tainted;
      this.laps.push({ ms: f.lastLapTimeMs as number, valid });
      if (valid && (this.bestMs === null || (f.lastLapTimeMs as number) < this.bestMs)) this.bestMs = f.lastLapTimeMs;
      this.tainted = false;
      if (this.state === "last_lap") {
        this.state = "done";
        return this.state;
      }
    }
    if (f.autopilot || f.lapInvalid) this.tainted = true;
    if (this.state === "running" && this.elapsedS >= this.durationS) {
      // The flag: a lap under way and still clean may be finished
      this.state = f.currentLapTimeMs > 0 && !this.tainted ? "last_lap" : "done";
    } else if (this.state === "last_lap" && this.tainted) {
      this.state = "done";
    }
    return this.state;
  }
}

/** A car in the qualifying classification: its best lap (ms), null without a clean one */
export interface QualifyingEntry {
  id: string;
  lapMs: number | null;
}

/**
 * The grid from qualifying: the clean laps quickest first, then the cars without one in the order given (for the
 * AI field, its pace order)
 */
export function qualifyingOrder<T extends QualifyingEntry>(entries: readonly T[]): T[] {
  const indexed = entries.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => {
    const am = a.e.lapMs;
    const bm = b.e.lapMs;
    if (am !== null && bm !== null) return am - bm || a.i - b.i;
    if (am !== null) return -1;
    if (bm !== null) return 1;
    return a.i - b.i;
  });
  return indexed.map((x) => x.e);
}

/**
 * What a race's grid is drawn from after qualifying: the player's best clean lap (ms, null without one) and the
 * reference lap the AI cars' times are taken from (ms, null when none could be had: the AI cars then line up by pace,
 * the player behind them as the race setup says)
 */
export interface QualifyingGridInput {
  playerMs: number | null;
  refLapMs: number | null;
  /**
   * The reference's level against an AI driver at full pace: a circuit's AI line check (a lap on the drive plans,
   * which the field's quickest levels plan beyond) is a shade slower than such a driver, a lone autopilot lap is one
   */
  refBase: number;
}

/** A line check's flying lap: the AI cars drive the plans its grip reach takes past it */
export const LINE_CHECK_REF_BASE = 0.995;
/** A lone autopilot lap at full pace */
export const AUTOPILOT_REF_BASE = 1;
/**
 * Lap time per unit of pace under full pace (share of the reference): measured on AI fields at Pro (LC26 at RISE,
 * GT3 at the Red Bull Ring, LC26 at Istanbul), 0.61-0.68
 */
export const AI_QUALI_SLOPE = 0.65;

/** An AI car's qualifying lap (ms) at its pace for the session (its own, with a lap's luck) */
export function aiQualifyingMs(refLapMs: number, refBase: number, pace: number): number {
  return Math.round(refLapMs * (refBase + AI_QUALI_SLOPE * (1 - pace)));
}

/** One line of the qualifying classification the race lines up in */
export interface QualifyingResult {
  code: string;
  isPlayer: boolean;
  lapMs: number | null;
}
