/**
 * Virtual Safety Car (VSC) controller for AI races.
 *
 * Deployed automatically when a car retires on/near the road or a double-yellow hazard persists (`VSC_TRIGGER_S`),
 * neutralizing the field without spawning a physical pace car:
 *  - Every car follows a reference VSC pace (`VSC_PACE_SHARE` of the track's optimal speed, clamped to
 *    `[VSC_MIN_SPEED_MS, VSC_MAX_SPEED_MS]`), holding gaps across the field.
 *  - No overtaking and no overtaking aids (Straight Mode / DRS / Overtake Mode) while VSC is active.
 *  - The player manages an FIA-style live time delta (`deltaS`): positive (+) = safe, negative (−) = too fast.
 *    After a short initial reaction grace window (`VSC_GRACE_S`), staying below `−VSC_VIOLATION_MARGIN_S` for
 *    `VSC_VIOLATION_HOLD_S` — or crossing into green flag below the delta — draws a +5 s time penalty.
 *  - Once the triggering hazard clears (and at least `VSC_MIN_DURATION_S` has elapsed), race control announces
 *    "VSC ending" for a randomised 5–9 s window before waving green.
 *
 * No three.js and no DOM: safe for the sim worker and headless verification scripts.
 */

export type VscPhase = 'none' | 'deployed' | 'ending';

/** Share of optimal corner/straight speed used as VSC target pace (~35 % slower than racing speed) */
export const VSC_PACE_SHARE = 0.65;
/** Floor and ceiling on the VSC reference speed (m/s: ~65 km/h to ~216 km/h) */
export const VSC_MIN_SPEED_MS = 18;
export const VSC_MAX_SPEED_MS = 60;
/** Earliest race time a VSC can trigger (s) — avoids Lap 1 Turn 1 start bunching */
export const VSC_EARLIEST_RACE_S = 15;
/** Persistent double-yellow duration before VSC deploys (s) */
export const VSC_TRIGGER_S = 3.5;
/** Minimum and maximum deployed duration before transitioning to ending (s) */
export const VSC_MIN_DURATION_S = 14;
export const VSC_MAX_DURATION_S = 30;
/** Unpredictable "VSC ending" countdown range (s) */
export const VSC_ENDING_MIN_S = 5;
export const VSC_ENDING_MAX_S = 9;
/** Cooldown between consecutive VSC periods (s) */
export const VSC_COOLDOWN_S = 90;
/** Reaction grace window on initial deployment before delta infringements are penalised (s) */
export const VSC_GRACE_S = 4.0;
/** Starting delta buffer when VSC deploys (s) so lifting smoothly keeps the driver positive */
export const VSC_INITIAL_DELTA_S = 1.2;
/** Delta below −0.5 s counts as speeding under VSC */
export const VSC_VIOLATION_MARGIN_S = 0.5;
/** Continuous speeding below margin before a +5 s penalty is issued (s) */
export const VSC_VIOLATION_HOLD_S = 3.0;
/** Repeat penalty cooldown if the player keeps speeding (s) */
export const VSC_PENALTY_COOLDOWN_S = 10;
export const VSC_PENALTY_SECONDS = 5;

/** VSC target speed (m/s) for a track sample whose racing optimal speed is `optimalSpeedKmh` */
export function vscReferenceSpeedMs(optimalSpeedKmh: number): number {
  const raw = (Math.max(0, optimalSpeedKmh) / 3.6) * VSC_PACE_SHARE;
  return Math.max(VSC_MIN_SPEED_MS, Math.min(VSC_MAX_SPEED_MS, raw));
}

export interface VscUpdateInput {
  dt: number;
  raceTimeS: number;
  /** True while racing (not lights, not finished, not rolling formation) */
  racing: boolean;
  /** True near the end of the final lap where VSC should not newly deploy */
  finalLapClosing: boolean;
  /** True when a retired car is currently sitting on/by the track waiting for marshals */
  hasRetiredOnTrack: boolean;
  /** True when any active double-yellow hazard is on track */
  hasDoubleYellow: boolean;
  /** Player forward speed (m/s) */
  playerSpeedMs: number;
  /** Track optimal racing speed at the player's current position (km/h) */
  playerOptimalKmh: number;
  /** True when player delta should be judged (human driving, still running) */
  judgePlayer: boolean;
  /** Deterministic RNG returning [0, 1) for the ending countdown */
  rng?: () => number;
}

export interface VscEvent {
  kind: 'deployed' | 'ending' | 'green' | 'penalty';
  seconds?: number;
  detail?: string;
}

export interface VscStatus {
  phase: 'deployed' | 'ending';
  /** Positive = safe (slower than or on VSC target), negative = too fast */
  deltaS: number;
  /** Remaining reaction grace window (s, 0 once active enforcement begins) */
  graceS: number;
  /** Current VSC target speed at the player's track position (km/h) */
  speedKmh: number;
}

export class VscController {
  private _phase: VscPhase = 'none';
  private phaseAgeS = 0;
  private endingDurationS = VSC_ENDING_MIN_S;
  private triggerAccumS = 0;
  private cooldownUntilS = 0;
  private deltaS = VSC_INITIAL_DELTA_S;
  private graceS = 0;
  private violationS = 0;
  private penaltyCooldownS = 0;
  private lastSpeedKmh = 120;

  public reset(): void {
    this._phase = 'none';
    this.phaseAgeS = 0;
    this.endingDurationS = VSC_ENDING_MIN_S;
    this.triggerAccumS = 0;
    this.cooldownUntilS = 0;
    this.deltaS = VSC_INITIAL_DELTA_S;
    this.graceS = 0;
    this.violationS = 0;
    this.penaltyCooldownS = 0;
    this.lastSpeedKmh = 120;
  }

  public get phase(): VscPhase {
    return this._phase;
  }

  public get active(): boolean {
    return this._phase !== 'none';
  }

  public status(): VscStatus | undefined {
    if (this._phase === 'none') return undefined;
    return {
      phase: this._phase,
      deltaS: Math.round(this.deltaS * 100) / 100,
      graceS: Math.max(0, Math.round(this.graceS * 10) / 10),
      speedKmh: Math.round(this.lastSpeedKmh),
    };
  }

  /** Manually deploy a VSC (useful for tests or race director triggers) */
  public deploy(raceTimeS: number): VscEvent {
    this._phase = 'deployed';
    this.phaseAgeS = 0;
    this.triggerAccumS = 0;
    this.deltaS = VSC_INITIAL_DELTA_S;
    this.graceS = VSC_GRACE_S;
    this.violationS = 0;
    this.penaltyCooldownS = 0;
    this.cooldownUntilS = raceTimeS + VSC_COOLDOWN_S;
    return { kind: 'deployed', detail: 'Maintain positive delta · no overtaking' };
  }

  public update(inp: VscUpdateInput): VscEvent[] {
    const events: VscEvent[] = [];
    if (!inp.racing) {
      this.triggerAccumS = 0;
      if (this._phase !== 'none') {
        this._phase = 'none';
        this.phaseAgeS = 0;
        this.graceS = 0;
        this.violationS = 0;
      }
      return events;
    }

    const vRef = vscReferenceSpeedMs(inp.playerOptimalKmh);
    this.lastSpeedKmh = vRef * 3.6;

    if (this._phase === 'none') {
      const eligible = inp.raceTimeS >= VSC_EARLIEST_RACE_S && inp.raceTimeS >= this.cooldownUntilS && !inp.finalLapClosing;
      if (!eligible) {
        this.triggerAccumS = 0;
        return events;
      }
      if (inp.hasRetiredOnTrack) {
        events.push(this.deploy(inp.raceTimeS));
        return events;
      }
      if (inp.hasDoubleYellow) {
        this.triggerAccumS += inp.dt;
        if (this.triggerAccumS >= VSC_TRIGGER_S) {
          events.push(this.deploy(inp.raceTimeS));
        }
      } else {
        this.triggerAccumS = Math.max(0, this.triggerAccumS - inp.dt * 2);
      }
      return events;
    }

    // Active VSC ('deployed' or 'ending'): update player delta and phase timers
    this.phaseAgeS += inp.dt;
    if (this.graceS > 0) this.graceS = Math.max(0, this.graceS - inp.dt);
    if (this.penaltyCooldownS > 0) this.penaltyCooldownS = Math.max(0, this.penaltyCooldownS - inp.dt);

    if (inp.judgePlayer) {
      const playerV = Math.max(0, inp.playerSpeedMs);
      // Driving at vRef holds delta steady; slower gains positive time, faster loses delta
      this.deltaS = Math.max(-10, Math.min(15, this.deltaS + (1 - playerV / vRef) * inp.dt));
      if (this.graceS <= 0 && this.deltaS < -VSC_VIOLATION_MARGIN_S) {
        this.violationS += inp.dt;
        if (this.violationS >= VSC_VIOLATION_HOLD_S && this.penaltyCooldownS <= 0) {
          this.violationS = 0;
          this.penaltyCooldownS = VSC_PENALTY_COOLDOWN_S;
          events.push({
            kind: 'penalty',
            seconds: VSC_PENALTY_SECONDS,
            detail: 'VSC delta infringement',
          });
        }
      } else {
        this.violationS = Math.max(0, this.violationS - inp.dt * 1.5);
      }
    }

    if (this._phase === 'deployed') {
      const incidentActive = inp.hasRetiredOnTrack || inp.hasDoubleYellow;
      const canEnd =
        (this.phaseAgeS >= VSC_MIN_DURATION_S && !incidentActive) ||
        this.phaseAgeS >= VSC_MAX_DURATION_S ||
        inp.finalLapClosing;
      if (canEnd) {
        this._phase = 'ending';
        this.phaseAgeS = 0;
        const r = inp.rng ? inp.rng() : 0.5;
        this.endingDurationS = VSC_ENDING_MIN_S + Math.max(0, Math.min(1, r)) * (VSC_ENDING_MAX_S - VSC_ENDING_MIN_S);
        events.push({ kind: 'ending', detail: 'Hold positive delta · prepare for green' });
      }
    } else if (this._phase === 'ending') {
      if (this.phaseAgeS >= this.endingDurationS) {
        if (inp.judgePlayer && this.deltaS < -VSC_VIOLATION_MARGIN_S && this.penaltyCooldownS <= 0) {
          events.push({
            kind: 'penalty',
            seconds: VSC_PENALTY_SECONDS,
            detail: 'VSC delta negative at green flag',
          });
        }
        this._phase = 'none';
        this.phaseAgeS = 0;
        this.cooldownUntilS = inp.raceTimeS + VSC_COOLDOWN_S;
        events.push({ kind: 'green', detail: 'Track clear · racing resumes' });
      }
    }

    return events;
  }
}
