/**
 * The running order of a race, as a timing screen classifies it. The game orders its own standings with it
 * (race-session.ts), and the race server (cloudflare/api/race.ts) and a room's host classify the official result with
 * it (src/lib/net/official-result.ts), so all of them agree.
 *
 * No three.js and no DOM: the Worker imports this file.
 */
import type { TireCompound } from "@/types/f1";

/** One car in the classification */
export interface RacerProgress {
  id: string;
  code: string;
  name: string;
  color: string;
  isPlayer: boolean;
  /** Race distance from the start line (m), laps included; negative on the grid behind the line */
  distM: number;
  /** Speed for the in-bucket gap correction (m/s) */
  speedMs: number;
  finishTimeS: number | null;
  bestLapMs: number | null;
  /** Last completed lap (ms) */
  lastLapMs?: number | null;
  /** Time penalties to add at the flag (s) */
  penaltyS?: number;
  compound?: TireCompound;
  /**
   * Laps completed when the car took the flag. After the winner finishes, every car finishes on its next line
   * crossing, so a lapped car finishes a lap (or more) short; absent on a finisher = the full race distance
   */
  finishLaps?: number;
  /** Grid slot (0 = pole), the last tie-break; absent = behind everyone with one */
  grid?: number;
  /** Retired (a multiplayer car whose peer dropped before the flag): classified DNF, behind every runner */
  dnf?: boolean;
}

/** Race time at the flag with the time penalties added (s); null while running */
export const classifiedTimeS = (r: Pick<RacerProgress, "finishTimeS" | "penaltyS">): number | null =>
  r.finishTimeS === null ? null : r.finishTimeS + (r.penaltyS ?? 0);

const gridOf = (r: RacerProgress) => r.grid ?? Number.MAX_SAFE_INTEGER;

/**
 * Running order, as a timing screen classifies it: finishers on laps completed, then race time (penalties included);
 * a car still running sits where its distance puts it against the line each finisher crossed (so a lead-lap car on
 * its last lap is ahead of a lapped finisher); retired cars last. Ties go to whoever got there first (the earlier
 * line crossing for finishers), then the grid. Without the lap length, finishers simply lead the runners.
 */
export function raceOrder<T extends RacerProgress>(racers: readonly T[], lapLengthM?: number): T[] {
  return [...racers].sort((a, b) => {
    if (!!a.dnf !== !!b.dnf) return a.dnf ? 1 : -1;
    const aFin = a.finishTimeS !== null && !a.dnf;
    const bFin = b.finishTimeS !== null && !b.dnf;
    if (aFin && bFin) {
      // A finisher without a lap count ran the full distance: at least as many laps as any lapped finisher
      const la = a.finishLaps ?? Infinity;
      const lb = b.finishLaps ?? Infinity;
      if (la !== lb) return lb - la;
      return (
        (classifiedTimeS(a) as number) - (classifiedTimeS(b) as number) ||
        (a.finishTimeS as number) - (b.finishTimeS as number) ||
        gridOf(a) - gridOf(b)
      );
    }
    if (aFin !== bFin) {
      if (lapLengthM === undefined) return aFin ? -1 : 1;
      const fin = aFin ? a : b;
      const run = aFin ? b : a;
      // A full-distance finisher (no lap count) is at the line no runner can pass without finishing
      const line = fin.finishLaps === undefined ? Infinity : fin.finishLaps * lapLengthM;
      const runnerAhead = run.distM > line;
      return runnerAhead === aFin ? 1 : -1;
    }
    return b.distM - a.distM || gridOf(a) - gridOf(b);
  });
}
