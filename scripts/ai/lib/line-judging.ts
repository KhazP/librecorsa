/**
 * What the line tools (check-lines.ts, optimize-lines.ts) call a clean physics lap, and when a new line's laps pass
 * against the current line's. Pure, so scripts/verify-ai-line-tools.ts can pin the rules.
 */

/** The part of a physics lap (lib/physics-lap.ts) the rules read */
export interface JudgedLap {
  lapS: number;
  offTrackFrames: number;
  wallHits: number;
  maxErrM: number;
}

/** A clean lap: finished, no barrier hit, at most 12 frames off the road and never `maxErrM` off the line */
export function isCleanLap(l: JudgedLap, maxErrM = 2.5): boolean {
  return Number.isFinite(l.lapS) && l.wallHits === 0 && l.offTrackFrames <= 12 && l.maxErrM < maxErrM;
}

/** A lap no worse than another: finished if that one did, with no more barrier hits and frames off the road */
export function noWorseLap(l: JudgedLap, than: JudgedLap): boolean {
  return (Number.isFinite(l.lapS) || !Number.isFinite(than.lapS)) && l.wallHits <= than.wallHits && l.offTrackFrames <= than.offTrackFrames;
}

/**
 * Which judges a candidate need not drive cleanly: none when `strict` (a batch run, where nobody reads the log), else
 * those already unclean on the current line (the LC26 through Monaco's barriers), as long as one judge is clean on it
 */
export function excusedJudges(current: readonly JudgedLap[], strict: boolean, maxErrM = 2.5): boolean[] {
  const clean = current.map((l) => isCleanLap(l, maxErrM));
  const anyClean = clean.some(Boolean);
  return clean.map((c) => !strict && anyClean && !c);
}

/**
 * A candidate's laps pass: clean for every judge, except an excused one, which must still be no worse than on the
 * current line (an excused judge was once let through on a line 1403 frames off the road, at Barbagallo)
 */
export function candidatePasses(cand: readonly JudgedLap[], current: readonly JudgedLap[], excused: readonly boolean[], maxErrM = 2.5): boolean {
  return cand.every((l, k) => isCleanLap(l, maxErrM) || (excused[k] && noWorseLap(l, current[k])));
}

/** The time a line is ranked by: its judges' laps summed, an excused judge's left out (it may not finish at all) */
export function timedLaps(laps: readonly JudgedLap[], excused: readonly boolean[]): number {
  return laps.reduce((a, l, k) => a + (excused[k] ? 0 : l.lapS), 0);
}
