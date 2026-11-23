/**
 * The overtaking aids by era, as race control runs them.
 *
 * - Before 2011 (`none`): no DRS; the car keeps its flaps shut.
 * - 2026 on (`straight-mode-2026`): both wings' flaps open (Straight Mode) in every DRS zone for every car, with no gap
 *   rule. The 1 s gap instead earns Overtake Mode: a car within 1 s of the car ahead at the detection point (nominally
 *   the last corner) gets the override deployment (the ERS-K's power held to a higher speed) for the following lap,
 *   and may recharge 0.5 MJ more on it (FIA 2026 Section C5.2.10 iii, Section B7.2.1 b v). Not on the first lap until
 *   the leader has passed the detection point. In practice and qualifying Overtake is on all the time.
 * - 2011 to 2025 (`drs-rear`): only the rear flap opens (DRS), only in a zone, and in a race only for a car within 1 s of
 *   the car ahead (lapped cars included) at that zone's detection point, from the moment the leader has completed two
 *   laps. Free use in practice.
 *
 * Wet tracks shut the flaps in both eras (`isRearFlapAllowedInWet`). There is no safety car in the sim, so its
 * lockout does not apply. Under the open-wheel rules a yellow zone shuts the flaps and holds Overtake Mode back
 * (`OvertakingRaceControl.aidsLocked`).
 */
import type { DrsZoneDef } from '@/lib/track-data';

export type OvertakingRules = 'straight-mode-2026' | 'drs-rear' | 'none';

/** Gap to the car ahead at a detection point that earns the aid (s) */
export const DETECTION_GAP_S = 1;
/** Race laps the leader completes before DRS is enabled */
export const DRS_ENABLED_AFTER_LEADER_LAPS = 2;
/** Overtake Mode's extra recharge allowed on the lap it is earned for (J) */
export const OVERTAKE_EXTRA_RECHARGE_J = 500_000;

/** DRS arrived in 2011 */
export const DRS_FIRST_SEASON = 2011;

/** The aids of a car's season: Straight Mode + Overtake from 2026, rear-flap DRS from 2011, none before */
export const overtakingRulesForSeason = (season: number): OvertakingRules =>
  season >= 2026 ? 'straight-mode-2026' : season >= DRS_FIRST_SEASON ? 'drs-rear' : 'none';

/**
 * Race control for one car's overtaking aids. Absent (or `racing` false): practice, the aids are free to use.
 */
export interface OvertakingRaceControl {
  /** A race is on (the start lights included); after the flag the aids are free again */
  readonly racing: boolean;
  /** At a detection point: did this car earn the aid (the gap and lap rules)? Asked only while racing */
  earnedAtDetection(zoneId: string): boolean;
  /** Inside a yellow zone under rules that close the aids there: flaps shut, no Overtake Mode */
  readonly aidsLocked?: boolean;
}

/** What race control knows about a car at a detection point */
export interface DetectionState {
  rules: OvertakingRules;
  /** Time to the car directly ahead on the road, lapped cars included (s); null when there is none */
  gapAheadS: number | null;
  /** Race laps the leader has completed */
  leaderLapsCompleted: number;
}

/** The rule itself: within 1 s of the car ahead, and for DRS only once the leader has completed two laps */
export function earnedAtDetection(s: DetectionState): boolean {
  if (s.rules === 'drs-rear' && s.leaderLapsCompleted < DRS_ENABLED_AFTER_LEADER_LAPS) return false;
  return s.gapAheadS !== null && s.gapAheadS <= DETECTION_GAP_S;
}

/**
 * The car directly ahead on the road of a car at race distance `meDistM` (m, laps included), a lapped car or a car a
 * lap up included: how far ahead on the road (m), and the race distance at which it passed the point `me` is at now.
 */
export function carAheadOnRoad<T extends { distM: number }>(
  meDistM: number,
  others: Iterable<T>,
  lapLengthM: number
): { car: T; roadGapM: number; passedHereAtDistM: number } | null {
  const L = lapLengthM;
  let best = Infinity;
  let ahead: T | null = null;
  for (const c of others) {
    const d = (((c.distM - meDistM) % L) + L) % L;
    if (d > 0 && d < best) {
      best = d;
      ahead = c;
    }
  }
  if (!ahead) return null;
  // Laps the car ahead is down on `me` (negative: up); it passed this point that many laps' distance earlier
  const lapsDown = Math.round((meDistM + best - ahead.distM) / L);
  return { car: ahead, roadGapM: best, passedHereAtDistM: meDistM - lapsDown * L };
}

/** Forward lap-fraction step from `prev` to `p` (0..1 progress, wrapping at the line) */
const forwardStep = (prev: number, p: number): number => {
  let d = p - prev;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return d;
};

/** Did a forward step from `prev` to `p` cross lap fraction `at`? (a jump over 5 % of a lap is a teleport) */
export function crossedForward(prev: number, p: number, at: number): boolean {
  if (!Number.isFinite(prev) || !Number.isFinite(p)) return false;
  const d = forwardStep(prev, p);
  if (!(d > 0 && d < 0.05)) return false;
  const ahead = (((at - prev) % 1) + 1) % 1;
  return ahead > 0 && ahead <= d;
}

/** The Overtake Mode detection point: the last one before the line (the zone onto the main straight) */
export function overtakeDetectionZone(zones: readonly DrsZoneDef[]): DrsZoneDef | undefined {
  let best: DrsZoneDef | undefined;
  for (const z of zones) if (!best || z.detection > best.detection) best = z;
  return best;
}

/** An Overtake Detection Line and the Activation Line after it, as lap fractions (B7.2.1 b viii, ix) */
export interface OvertakeLines {
  detection: number;
  /** Null: active from the detection line (no Activation Line) */
  activation: number | null;
}

/**
 * Overtake Mode for one car: judged at the Detection Line (within the gap of the car ahead), active from the Activation
 * Line after it until the next one, where it is judged afresh (B7.2.3 c). Practice is never judged: Overtake is active
 * all the time there (B7.2.3 b)
 */
export class OvertakeGrant {
  /** Earned at the last Detection Line crossed */
  public earned = false;
  /** Active: from the Activation Line after an earned detection */
  public active = false;
  /** Activation Lines crossed: each starts a new lap of Overtake (unused until the driver uses it) */
  public activations = 0;

  reset(): void {
    this.earned = this.active = false;
  }

  /**
   * Call once per step with the lap progress before and after it, the zones' last detection point serving as both lines.
   * True when race control judged the car at the detection point this step (`earned` holds the verdict)
   */
  observe(prev: number, p: number, zones: readonly DrsZoneDef[], control: OvertakingRaceControl | null | undefined): boolean {
    const zone = overtakeDetectionZone(zones);
    if (!zone) return false;
    return this.observeLines(prev, p, { detection: zone.detection, activation: null }, control);
  }

  /** As `observe`, at the circuit's own Detection and Activation Lines */
  observeLines(prev: number, p: number, lines: OvertakeLines, control: OvertakingRaceControl | null | undefined): boolean {
    let judged = false;
    if (crossedForward(prev, p, lines.detection)) {
      this.earned = control?.racing ? control.earnedAtDetection('OVERTAKE') : false;
      judged = control?.racing === true;
      if (lines.activation === null) this.active = this.earned;
    }
    if (lines.activation !== null && crossedForward(prev, p, lines.activation)) {
      this.active = this.earned;
      this.activations++;
    }
    return judged;
  }

  /** The override may be used: always in practice, in a race only once active */
  available(control: OvertakingRaceControl | null | undefined): boolean {
    if (control?.racing && control.aidsLocked) return false;
    return !control?.racing || this.active;
  }

  /** Extra recharge allowed this lap (J): only an Overtake active in a race (at the line, the lap it begins) */
  extraRechargeJ(control: OvertakingRaceControl | null | undefined): number {
    return control?.racing && this.active && !control.aidsLocked ? OVERTAKE_EXTRA_RECHARGE_J : 0;
  }
}
