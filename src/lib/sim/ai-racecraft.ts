/**
 * Racecraft for the AI field: the judgements a racing driver makes about the cars around, layered on the field's
 * traffic planner (`AiOpponentField.planTraffic`):
 *
 *  - overlap, with hysteresis so "alongside" doesn't flicker as the cars swap a few centimetres
 *  - who owns the corner at turn-in: the car on the inside with its nose at least at the other car's middle; the
 *    other leaves it a car's width (the outside car of a pair yields only when it doesn't own the corner)
 *  - one defensive move per straight, never started under braking or against a car already alongside
 *  - no lunge that can't get alongside by the turn-in: a pass is started only if, at the closing speed, the car
 *    draws alongside before the corner's braking ends
 *  - hazards: a car spun, stopped or crawling on the road ahead is passed on the side with room, slowly if there is
 *    little, never followed into
 *  - yellow flags (a hazard within the zone ahead): lift, and no overtaking
 *  - blue flags: a car about to be lapped gives up the inside and doesn't defend
 *
 * Distances along the track (m), lateral offsets + right. The numbers are tuning values, not regulations.
 */

/** Alongside starts when the centres are within 0.85 car lengths, ends past 1.1 (hysteresis) */
const OVERLAP_IN_L = 0.85;
const OVERLAP_OUT_L = 1.1;

/** Whether two cars are alongside now, from the last frame's answer */
export function overlapNow(wasAlongside: boolean, dsM: number, dLatM: number, carLenM: number, carWidM: number): boolean {
  const ds = Math.abs(dsM);
  const lat = Math.abs(dLatM);
  if (wasAlongside) return ds < OVERLAP_OUT_L * carLenM && lat < carWidM + 2.4;
  return ds < OVERLAP_IN_L * carLenM && lat < carWidM + 1.6;
}

/**
 * The corner belongs to me when I'm on its inside with my nose at least at the other car's middle: `dsOtherMinusMe`
 * (centre to centre, + the other car ahead) at most half a car length. `insideSign` is the side of the corner's
 * inside (+ right), `myLatM` / `otherLatM` the offsets.
 */
export function ownsCorner(dsOtherMinusMe: number, myLatM: number, otherLatM: number, insideSign: number, carLenM: number): boolean {
  const onInside = Math.sign(myLatM - otherLatM) === Math.sign(insideSign) && insideSign !== 0;
  return onInside && dsOtherMinusMe <= 0.5 * carLenM;
}

/** Braking distance from `vMs` to `vCornerMs` at a mean deceleration (m) */
export function brakingDistanceM(vMs: number, vCornerMs: number, decelMs2: number): number {
  if (vCornerMs >= vMs) return 0;
  return (vMs * vMs - vCornerMs * vCornerMs) / (2 * Math.max(1, decelMs2));
}

/**
 * Whether a pass started now can draw alongside (the passing car's centre level with the other's) before the corner
 * ahead: at the closing speed, the distance this car covers until then against the distance to the corner's
 * turn-in plus `brakingShare` of its braking zone (a pass completed on the brakes is fair; one started too late to
 * get there is a lunge). `distToCornerM` Infinity: no corner in sight.
 */
export function passFeasible(opts: {
  gapM: number;
  closingMs: number;
  speedMs: number;
  distToCornerM: number;
  brakingZoneM: number;
  brakingShare?: number;
}): boolean {
  if (!Number.isFinite(opts.distToCornerM)) return true;
  if (opts.closingMs <= 0.2) return false;
  const t = Math.max(0, opts.gapM) / opts.closingMs;
  const covered = opts.speedMs * t;
  const reach = opts.distToCornerM - opts.brakingZoneM * (1 - (opts.brakingShare ?? 0.5));
  return covered < reach;
}

/**
 * A car on the road the others must treat as an obstacle, not as a car racing: spun, stopped, rejoining slowly, or
 * crawling (well under the road's speed)
 */
export function isHazardSpeed(speedMs: number, roadSpeedMs: number): boolean {
  return speedMs < Math.max(8, 0.35 * roadSpeedMs);
}

/** Half-width a hazard takes across the road (m): a car sideways is near its length wide */
export function hazardHalfWidthM(headingErrRad: number, carLenM: number, carWidM: number): number {
  const a = Math.abs(Math.sin(headingErrRad));
  return 0.5 * (carWidM * (1 - a) + carLenM * a) + 0.4;
}

/**
 * Where to pass a hazard at `hazLatM` (half-width `hazHalfM`) on a road ±`halfRoadM`: the side with more room, and
 * how much room that is (m of free road beside it); null when neither side has room for the car. The line is the
 * car's own (`lineLatM`) wherever that already clears the hazard: a car stopped off the road needs no move toward it
 * (cars were steered at the gravel to pass "beside" a car stranded there, and ran into it one after another)
 */
export function hazardLine(
  hazLatM: number,
  hazHalfM: number,
  halfRoadM: number,
  carWidM: number,
  lineLatM = 0
): { latM: number; roomM: number } | null {
  const roomRight = halfRoadM - (hazLatM + hazHalfM);
  const roomLeft = hazLatM - hazHalfM + halfRoadM;
  const right = roomRight >= roomLeft;
  const room = Math.min(2 * halfRoadM, right ? roomRight : roomLeft);
  if (room < carWidM + 0.3) return null;
  const clear = 0.5 * carWidM + Math.min(0.8, 0.5 * (room - carWidM));
  const lat = right ? Math.max(lineLatM, hazLatM + hazHalfM + clear) : Math.min(lineLatM, hazLatM - hazHalfM - clear);
  return { latM: Math.max(-halfRoadM, Math.min(halfRoadM, lat)), roomM: room };
}

/** Yellow flag zone around an incident: from this far before it to this far past it (m) */
export const YELLOW_BEFORE_M = 350;
export const YELLOW_AFTER_M = 40;

/** Whether lap distance `s` is inside the yellow zone of an incident at `incidentS` (lap length `L`) */
export function inYellowZone(s: number, incidentS: number, L: number): boolean {
  const d = (((incidentS - s) % L) + L * 1.5) % L - L / 2;
  return d <= YELLOW_BEFORE_M && d >= -YELLOW_AFTER_M;
}

/** Per AI car: what it remembers between frames for its racecraft */
export class RacecraftMemory {
  /** Alongside, per other car's id */
  public readonly alongside = new Map<string, boolean>();
  /** Defensive moves made on this straight */
  public defendMoves = 0;
  /**
   * Where the defensive move under way goes, fixed when it starts so it never mirrors the attacker: an offset from the
   * racing line (m), or from the road's centre for a move off the grid (`defendOffLine`)
   */
  public defendLatM = 0;
  public defendOffLine = false;
  /** Committed to a side for a pass into the corner ahead (+1 right, −1 left, 0 none), and until where (lap m) */
  public commitSide = 0;
  public commitUntilS = 0;
  /** In a corner last frame (the straight's defence count starts again after it) */
  public wasInCorner = false;
  /** The car being passed (its id) and on which side (+1 right, −1 left): the move is held until it is done */
  public passTargetId: string | null = null;
  public passSide = 0;

  public reset(): void {
    this.alongside.clear();
    this.defendMoves = 0;
    this.defendLatM = 0;
    this.defendOffLine = false;
    this.commitSide = 0;
    this.commitUntilS = 0;
    this.wasInCorner = false;
    this.passTargetId = null;
    this.passSide = 0;
  }
}
