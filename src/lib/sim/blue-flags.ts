/**
 * Blue-flag rules for an AI race: lapped cars must let faster leaders past without defending or blocking.
 *
 *  - Player enforcement (`BlueFlagJudge`): when a car at least half a lap ahead in race distance closes within
 *    `BLUE_FLAG_SHOW_S` (1.2 s) and `BLUE_FLAG_SHOW_M` (90 m) behind the player on the road, race control shows the
 *    blue flag. Holding the lapping car up past `BLUE_FLAG_WARN_S` raises a blue-flag warning; ignoring it past
 *    `BLUE_FLAG_PENALTY_S` awards a +5 s time penalty (and repeats every `BLUE_FLAG_REPEAT_PENALTY_S` if the player
 *    continues blocking). Letting the lapper through clears the flag immediately.
 *  - AI yielding (`blueFlagYieldTarget`): tells a lapped AI car which side of the road to pull onto (outside of the
 *    next corner, or the wider clear side on a straight) and how much to lift so the pass finishes cleanly in 1–2 s
 *    rather than dragging on for half a lap.
 *
 * No three.js and no DOM: safe for the sim worker and headless verification scripts.
 */

/** Road gap & time gap at which a blue flag turns on */
export const BLUE_FLAG_SHOW_S = 1.2;
export const BLUE_FLAG_SHOW_M = 90;
/** Hysteresis gap so brief corner separation does not reset an active warning */
export const BLUE_FLAG_CLEAR_S = 1.8;
export const BLUE_FLAG_CLEAR_M = 125;
/** Continuous blocking time before a warning and before a time penalty (s) */
export const BLUE_FLAG_WARN_S = 6;
export const BLUE_FLAG_PENALTY_S = 14;
export const BLUE_FLAG_REPEAT_PENALTY_S = 10;
export const BLUE_FLAG_PENALTY_SECONDS = 5;
/** Lapper ahead of the player on the road by this much (m) clears the flag */
export const BLUE_FLAG_PASSED_M = 2;

export interface BlueFlagCar {
  code: string;
  /** Total race distance (m, laps included) */
  distM: number;
  /** Road distance behind the player in [0, trackLengthM); values > L/2 mean ahead of the player */
  behindM: number;
  /** Current forward speed (m/s) */
  speedMs: number;
  /** Retired, finished, off-track, or hazard cars do not trigger blue flags */
  exempt: boolean;
}

export interface BlueFlagEvent {
  kind: 'warning' | 'penalty';
  code: string;
  seconds?: number;
}

export interface BlueFlagActive {
  /** Car code of the closest lapping car behind the player */
  code: string;
  /** True once the player has been warned for ignoring the blue flag */
  warned: boolean;
  /** Seconds left until the next time penalty */
  remainingS: number;
}

interface TrackedLapper {
  code: string;
  heldS: number;
  warned: boolean;
  nextPenaltyS: number;
}

/** Tracks blue-flag exposure for the player's car in an AI race */
export class BlueFlagJudge {
  private readonly tracked = new Map<string, TrackedLapper>();
  private current: BlueFlagActive | null = null;

  public reset(): void {
    this.tracked.clear();
    this.current = null;
  }

  /** Active blue flag for the HUD, or null when no lapping car is close behind */
  public get active(): BlueFlagActive | null {
    return this.current;
  }

  public update(
    dt: number,
    playerDistM: number,
    trackLengthM: number,
    cars: readonly BlueFlagCar[],
    active: boolean
  ): BlueFlagEvent[] {
    if (!active || trackLengthM <= 0) {
      this.tracked.clear();
      this.current = null;
      return [];
    }
    const events: BlueFlagEvent[] = [];
    const seen = new Set<string>();
    let closest: { code: string; behindM: number; entry: TrackedLapper } | null = null;

    for (const c of cars) {
      if (c.exempt || c.distM - playerDistM < 0.5 * trackLengthM) continue;
      const existing = this.tracked.get(c.code);
      const speed = Math.max(5, c.speedMs);
      // Lapper passed the player on the road: clear immediately
      const aheadM = c.behindM > trackLengthM * 0.5 ? trackLengthM - c.behindM : -1;
      if (aheadM >= BLUE_FLAG_PASSED_M) {
        this.tracked.delete(c.code);
        continue;
      }
      const inShow = c.behindM > 0 && c.behindM <= BLUE_FLAG_SHOW_M && c.behindM / speed <= BLUE_FLAG_SHOW_S;
      const inKeep = existing !== undefined && c.behindM > 0 && c.behindM <= BLUE_FLAG_CLEAR_M && c.behindM / speed <= BLUE_FLAG_CLEAR_S;
      if (!inShow && !inKeep) {
        if (existing) this.tracked.delete(c.code);
        continue;
      }
      seen.add(c.code);
      const entry: TrackedLapper = existing ?? {
        code: c.code,
        heldS: 0,
        warned: false,
        nextPenaltyS: BLUE_FLAG_PENALTY_S,
      };
      // Only accumulate blocking time while the lapper is actually held up within show range (or right on our tail)
      if (inShow) {
        entry.heldS += dt;
        if (!entry.warned && entry.heldS >= BLUE_FLAG_WARN_S) {
          entry.warned = true;
          events.push({ kind: 'warning', code: c.code });
        }
        if (entry.heldS >= entry.nextPenaltyS) {
          entry.nextPenaltyS += BLUE_FLAG_REPEAT_PENALTY_S;
          events.push({ kind: 'penalty', code: c.code, seconds: BLUE_FLAG_PENALTY_SECONDS });
        }
      }
      this.tracked.set(c.code, entry);
      if (!closest || c.behindM < closest.behindM) {
        closest = { code: c.code, behindM: c.behindM, entry };
      }
    }

    for (const code of [...this.tracked.keys()]) {
      if (!seen.has(code)) this.tracked.delete(code);
    }

    this.current = closest
      ? {
          code: closest.code,
          warned: closest.entry.warned,
          remainingS: Math.max(0, closest.entry.nextPenaltyS - closest.entry.heldS),
        }
      : null;

    return events;
  }
}

export interface BlueFlagYieldInput {
  /** Racing line offset here (m, + right) */
  lineLatM: number;
  /** Usable half-width of the road (m) */
  halfRoadM: number;
  /** Inside of the next corner (+1 right, -1 left, 0 straight) */
  insideSign: number;
  /** Lapping car's current lateral offset (m, + right) */
  lapperLatM: number;
  /** Our current lateral offset (m, + right) */
  myLatM: number;
  /** Distance the lapper is behind us along the road (m, positive) */
  gapM: number;
  /** Lapping car's forward speed (m/s) */
  lapperSpeedMs: number;
  /** Car width (m) */
  carWidthM?: number;
}

export interface BlueFlagYieldPlan {
  /** Target lateral offset off the racing line (m, + right) */
  targetLatM: number;
  /** Pace multiplier (0..1) so the lapper clears swiftly */
  paceScale: number;
  /** Optional speed cap (m/s) when the lapper is right behind our line; Infinity otherwise */
  speedCapMs: number;
}

/**
 * Computes a clean, predictable yield line and lift for a lapped AI car:
 *  - Corner ahead (`insideSign !== 0`): pull to the outside (`-insideSign`) so the leader gets the apex.
 *  - Straight (`insideSign === 0`): pull away from the lapper's side (or toward the wider half of the road).
 *  - Lift progressively as the lapper closes so the pass completes cleanly without abrupt brake-checking.
 */
export function blueFlagYieldTarget(inp: BlueFlagYieldInput): BlueFlagYieldPlan {
  const carW = inp.carWidthM ?? 1.95;
  const edge = Math.max(0.5, inp.halfRoadM - 0.35);
  let side: number;
  if (inp.insideSign !== 0) {
    side = -Math.sign(inp.insideSign);
  } else {
    const dLat = inp.myLatM - inp.lapperLatM;
    if (Math.abs(dLat) > 0.7) {
      side = Math.sign(dLat);
    } else {
      const roomRight = edge - inp.lineLatM;
      const roomLeft = inp.lineLatM + edge;
      side = roomRight >= roomLeft ? 1 : -1;
    }
  }
  const shiftM = inp.insideSign !== 0 ? 2.6 : 2.9;
  const targetLatM = Math.max(-edge, Math.min(edge, inp.lineLatM + side * shiftM));
  const paceScale = inp.gapM <= 28 ? 0.86 : inp.gapM <= 55 ? 0.91 : 0.96;
  const inLapperPath = Math.abs(inp.myLatM - inp.lapperLatM) < carW + 0.5;
  // Once clearly off the lapper's line, just lift gently; if still close ahead, ease below its speed so it clears quickly
  const speedCapMs = inp.gapM <= 26 && !inLapperPath ? Math.max(15, inp.lapperSpeedMs - 3) : Infinity;
  return { targetLatM, paceScale, speedCapMs };
}
