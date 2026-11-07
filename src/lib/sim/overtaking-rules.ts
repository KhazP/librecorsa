/**
 * The overtaking aids by era, as race control runs them.
 *
 * - 2026 on (`straight-mode-2026`): both wings' flaps open (Straight Mode) in every DRS zone for every car, with no gap
 *   rule. The 1 s gap instead earns Overtake Mode: a car within 1 s of the car ahead at the detection point (nominally
 *   the last corner) gets the override deployment and 0.5 MJ of extra electrical energy for the following lap. Not on
 *   the first lap until the leader has passed the detection point.
 * - Up to 2025 (`drs-rear`): only the rear flap opens (DRS), only in a zone, and in a race only for a car within 1 s of
 *   the car ahead (lapped cars included) at that zone's detection point, from the moment the leader has completed two
 *   laps. Free use in practice.
 *
 * Wet tracks shut the flaps in both eras (`isRearFlapAllowedInWet`). There is no safety car in the sim, so its
 * lockout does not apply.
 */
import type { DrsZoneDef } from '@/lib/track-data';

export type OvertakingRules = 'straight-mode-2026' | 'drs-rear';

/** Gap to the car ahead at a detection point that earns the aid (s) */
export const DETECTION_GAP_S = 1;
/** Race laps the leader completes before DRS is enabled */
export const DRS_ENABLED_AFTER_LEADER_LAPS = 2;
/** Overtake Mode's extra electrical energy for the lap it is earned for (J) */
export const OVERTAKE_EXTRA_DEPLOY_J = 500_000;

/** The aids of a car's season: Straight Mode + Overtake from 2026, rear-flap DRS before */
export const overtakingRulesForSeason = (season: number): OvertakingRules => (season >= 2026 ? 'straight-mode-2026' : 'drs-rear');

/**
 * Race control for one car's overtaking aids. Absent (or `racing` false): practice, the aids are free to use.
 */
export interface OvertakingRaceControl {
  /** A race is on (the start lights included); after the flag the aids are free again */
  readonly racing: boolean;
  /** At a detection point: did this car earn the aid (the gap and lap rules)? Asked only while racing */
  earnedAtDetection(zoneId: string): boolean;
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

/**
 * Overtake Mode for one car: earned at the detection point for one lap, until it crosses that point again and race
 * control judges the gap afresh.
 */
export class OvertakeGrant {
  /** Earned at the last detection point crossed */
  public earned = false;

  reset(): void {
    this.earned = false;
  }

  /** Call once per step with the lap progress before and after it */
  observe(prev: number, p: number, zones: readonly DrsZoneDef[], control: OvertakingRaceControl | null | undefined): void {
    const zone = overtakeDetectionZone(zones);
    if (!zone || !crossedForward(prev, p, zone.detection)) return;
    this.earned = control?.racing ? control.earnedAtDetection(zone.id) : false;
  }

  /** The override may be used: always in practice, in a race only once earned */
  available(control: OvertakingRaceControl | null | undefined): boolean {
    return !control?.racing || this.earned;
  }

  /** Extra deploy allowance this lap (J): only an Overtake earned in a race */
  extraDeployJ(control: OvertakingRaceControl | null | undefined): number {
    return control?.racing && this.earned ? OVERTAKE_EXTRA_DEPLOY_J : 0;
  }
}
