/**
 * Race control for track limits. An excursion (the physics' off-track flag) is judged after the car is back on the
 * asphalt instead of killing the lap the instant a wheel crosses the line:
 *
 *   - a touch shorter than `MIN_EXCURSION_S` is ignored;
 *   - cutting the inside of a corner is always a strike unless the time is given back;
 *   - running wide is a strike only when it gained time over the best lap (delta at the exit vs at the entry,
 *     sampled once the car has settled), or, before there is a best lap, when the driver did not lift;
 *   - a strike can be cancelled by giving the advantage back within `GIVE_BACK_WINDOW_S`: lose the time gained
 *     (with a reference lap), or lift and coast for long enough (without one).
 *
 * In practice a strike deletes the lap. In a race every strike is a warning, and every `STRIKES_PER_PENALTY`th strike
 * is a time penalty: +3 s the first time, +5 s after that.
 */
import type { TrackLimitsReason, TrackLimitsStatus } from "@/types/f1";

/** Off for less than this is a touch, never judged (s) */
const MIN_EXCURSION_S = 0.12;
/** Back on the asphalt this long before the excursion is over (debounces kerb bounces, s) */
const REJOIN_S = 0.15;
/** Settling time after the rejoin before the gain is measured (the exit's speed has to show up in the delta, s) */
const SETTLE_S = 1.0;
/** Gained more than this over the reference lap (s) and it is an advantage */
const GAIN_THRESHOLD_S = 0.1;
/** Inside cuts count from a smaller gain */
const CUT_GAIN_THRESHOLD_S = 0.03;
/** Time allowed to give an advantage back (s) */
const GIVE_BACK_WINDOW_S = 6;
/** Time allowed to hand back a position gained off the track (s) */
const ILLEGAL_OVERTAKE_WINDOW_S = 10;
/** Without a reference: kept the throttle above this and did not brake = did not lift */
const NO_LIFT_THROTTLE = 0.6;
const NO_LIFT_BRAKE = 0.15;
/** Lift-and-coast give-back: throttle below this counts as lifting */
const LIFT_THROTTLE = 0.3;
/** Lift time owed per second spent off the track (clamped to the range below, s) */
const LIFT_PER_OFF_S = 1.0;
const LIFT_MIN_S = 0.6;
const LIFT_MAX_S = 2.0;
/** Curvature from which a stretch is a corner with an inside (1/m) */
const CORNER_CURVATURE = 1 / 450;
/** How long the banner message stays meaningful (ms) */
const MESSAGE_HOLD_MS = 4200;

export const STRIKES_PER_PENALTY = 3;
export const FIRST_PENALTY_S = 3;
export const REPEAT_PENALTY_S = 5;

export type TrackLimitsSession = "practice" | "race";

/** One frame of the player's car */
export interface TrackLimitsFrame {
  /** Wall-clock time (ms, performance.now) for the banner; `dtS` drives the judging */
  nowMs: number;
  dtS: number;
  lapCount: number;
  /** Lap distance (m) */
  distM: number;
  offTrack: boolean;
  throttle: number;
  brake: number;
  /** Signed offset from the centreline (m, + right) and the track's curvature here (1/m, + = right turn) */
  lateralM: number;
  curvature: number;
  /** Live delta to the best lap (s, + = slower), null without one */
  deltaS: number | null;
  /** Current race position (1 = leader) when in a race; used to detect illegal off-track overtakes */
  racePosition?: number;
  /** Racing (judging on) or not (lights, finished, autopilot, paused) */
  active: boolean;
}

export interface TrackLimitsEvent {
  kind: "warning" | "penalty" | "cleared" | "lap_invalid" | "no_advantage";
  reason?: TrackLimitsReason;
  penaltyS?: number;
  /** Lap on which the excursion started */
  lap: number;
}

interface Excursion {
  startLap: number;
  offS: number;
  onS: number;
  deltaAtEntry: number | null;
  entryPosition: number | null;
  minThrottle: number;
  maxBrake: number;
  insideCut: boolean;
  /** "off" → "judging" (settling) → "give_back" */
  stage: "off" | "judging" | "give_back";
  settleS: number;
  reason: TrackLimitsReason | null;
  gainS: number | null;
  /** Delta the driver has to get back to (with a reference): entry delta, i.e. the advantage cancelled */
  giveBackTarget: number | null;
  /** Race position the driver must cede back to if a car was passed off-track */
  giveBackPosition: number | null;
  liftOwedS: number;
  liftDoneS: number;
  windowS: number;
}

export class TrackLimitsMonitor {
  private session: TrackLimitsSession = "practice";
  private warnings = 0;
  private totalStrikes = 0;
  private penalties = 0;
  private penaltyS = 0;
  private lastOnTrackPosition: number | null = null;
  private exc: Excursion | null = null;
  private message: TrackLimitsStatus["message"] = null;
  private readonly status: TrackLimitsStatus = {
    warnings: 0,
    strikesPerPenalty: STRIKES_PER_PENALTY,
    totalStrikes: 0,
    penaltyS: 0,
    pending: null,
    message: null,
  };

  /** Starts a new session or race: everything back to zero */
  reset(session: TrackLimitsSession): void {
    this.session = session;
    this.warnings = 0;
    this.totalStrikes = 0;
    this.penalties = 0;
    this.penaltyS = 0;
    this.lastOnTrackPosition = null;
    this.exc = null;
    this.message = null;
  }

  get mode(): TrackLimitsSession {
    return this.session;
  }

  /** Time penalties so far (s) */
  get penaltyTotalS(): number {
    return this.penaltyS;
  }

  get strikes(): number {
    return this.totalStrikes;
  }

  /** An excursion is still being judged: a lap that ends now cannot count as clean */
  get judging(): boolean {
    return this.exc !== null;
  }

  /** Advances the judging by one frame; returns the race-control decision taken this frame, if any */
  update(f: TrackLimitsFrame): TrackLimitsEvent | null {
    if (!f.active) {
      this.exc = null;
      return null;
    }
    const e = this.exc;
    if (!e) {
      if (f.offTrack) {
        this.exc = this.startExcursion(f);
      } else if (f.racePosition !== undefined) {
        this.lastOnTrackPosition = f.racePosition;
      }
      return null;
    }

    // A lap completed while the excursion was being judged: the physics has already ruled the lap out (see
    // `judging`); in practice nothing more to decide, in a race the strike is still decided below
    if (e.stage === "off") return this.whileOff(e, f);
    if (f.offTrack) {
      // Back off the track before the first excursion was decided: one longer excursion
      e.stage = "off";
      e.onS = 0;
      return null;
    }
    if (e.stage === "judging") return this.whileJudging(e, f);
    return this.whileGivingBack(e, f);
  }

  /** The state for the HUD (updated in place) */
  snapshot(nowMs: number): TrackLimitsStatus {
    const s = this.status;
    s.warnings = this.warnings;
    s.totalStrikes = this.totalStrikes;
    s.penaltyS = this.penaltyS;
    const e = this.exc;
    s.pending =
      e && e.offS >= MIN_EXCURSION_S
        ? {
            stage: e.stage,
            gainS: e.gainS,
            giveBackPosition: e.giveBackPosition,
            progress:
              e.stage !== "give_back"
                ? 0
                : e.giveBackPosition !== null
                  ? 0
                  : e.giveBackTarget !== null
                    ? Math.max(0, Math.min(1, e.liftDoneS))
                    : Math.max(0, Math.min(1, e.liftDoneS / Math.max(1e-3, e.liftOwedS))),
            remainingS: e.stage === "give_back" ? Math.max(0, e.windowS) : 0,
          }
        : null;
    s.message = this.message && nowMs - this.message.atMs < MESSAGE_HOLD_MS ? this.message : null;
    return s;
  }

  private startExcursion(f: TrackLimitsFrame): Excursion {
    return {
      startLap: f.lapCount,
      offS: 0,
      onS: 0,
      deltaAtEntry: f.deltaS,
      entryPosition: this.lastOnTrackPosition ?? f.racePosition ?? null,
      minThrottle: f.throttle,
      maxBrake: f.brake,
      insideCut: false,
      stage: "off",
      settleS: 0,
      reason: null,
      gainS: null,
      giveBackTarget: null,
      giveBackPosition: null,
      liftOwedS: 0,
      liftDoneS: 0,
      windowS: GIVE_BACK_WINDOW_S,
    };
  }

  private whileOff(e: Excursion, f: TrackLimitsFrame): TrackLimitsEvent | null {
    if (f.offTrack) {
      e.offS += f.dtS;
      e.onS = 0;
      e.minThrottle = Math.min(e.minThrottle, f.throttle);
      e.maxBrake = Math.max(e.maxBrake, f.brake);
      // Inside of the corner: the side the track turns towards
      if (Math.abs(f.curvature) > CORNER_CURVATURE && Math.sign(f.lateralM) === Math.sign(f.curvature)) e.insideCut = true;
      return null;
    }
    e.onS += f.dtS;
    if (e.onS < REJOIN_S) return null;
    if (e.offS < MIN_EXCURSION_S) {
      this.exc = null;
      return null;
    }
    e.stage = "judging";
    e.settleS = 0;
    return null;
  }

  private whileJudging(e: Excursion, f: TrackLimitsFrame): TrackLimitsEvent | null {
    e.settleS += f.dtS;
    if (e.settleS < SETTLE_S) return null;

    // Off-track overtake check: if the player gained a race position during the excursion, require handing the position back
    if (e.entryPosition !== null && f.racePosition !== undefined && f.racePosition < e.entryPosition) {
      e.reason = "illegal_overtake";
      e.giveBackPosition = e.entryPosition;
      e.giveBackTarget = null;
      e.stage = "give_back";
      e.windowS = ILLEGAL_OVERTAKE_WINDOW_S;
      e.liftDoneS = 0;
      return null;
    }

    const hasRef = e.deltaAtEntry !== null && f.deltaS !== null && f.lapCount === e.startLap;
    if (hasRef) {
      const gain = (e.deltaAtEntry as number) - (f.deltaS as number);
      e.gainS = gain;
      const threshold = e.insideCut ? CUT_GAIN_THRESHOLD_S : GAIN_THRESHOLD_S;
      if (gain <= threshold) return this.close("no_advantage", f);
      e.reason = e.insideCut ? "corner_cut" : "gained";
      // Give it back: get the delta back up to where it was at the entry
      e.giveBackTarget = e.deltaAtEntry;
    } else {
      const lifted = e.minThrottle < NO_LIFT_THROTTLE || e.maxBrake > NO_LIFT_BRAKE;
      if (lifted && !e.insideCut) return this.close("no_advantage", f);
      e.reason = e.insideCut ? "corner_cut" : "not_lifted";
      e.giveBackTarget = null;
      e.liftOwedS = Math.max(LIFT_MIN_S, Math.min(LIFT_MAX_S, e.offS * LIFT_PER_OFF_S));
    }
    e.stage = "give_back";
    e.windowS = GIVE_BACK_WINDOW_S;
    e.liftDoneS = 0;
    return null;
  }

  private whileGivingBack(e: Excursion, f: TrackLimitsFrame): TrackLimitsEvent | null {
    e.windowS -= f.dtS;
    if (e.giveBackPosition !== null) {
      if (f.racePosition !== undefined && f.racePosition >= e.giveBackPosition) {
        return this.close("cleared", f);
      }
      if (e.windowS > 0) return null;
      return this.strike("illegal_overtake", f);
    }
    if (e.giveBackTarget !== null && f.deltaS !== null && f.lapCount === e.startLap && e.gainS !== null) {
      // Progress: share of the gain lost again since the measurement
      const lost = f.deltaS - (e.giveBackTarget - e.gainS);
      e.liftDoneS = lost / Math.max(1e-3, e.gainS);
      if (f.deltaS >= e.giveBackTarget) return this.close("cleared", f);
    } else {
      if (f.throttle < LIFT_THROTTLE && f.brake < 0.5) e.liftDoneS += f.dtS;
      if (e.giveBackTarget === null && e.liftDoneS >= e.liftOwedS) return this.close("cleared", f);
    }
    if (e.windowS > 0) return null;
    return this.strike(e.reason ?? "gained", f);
  }

  private close(kind: "no_advantage" | "cleared", f: TrackLimitsFrame): TrackLimitsEvent {
    const lap = this.exc?.startLap ?? f.lapCount;
    const wasOvertake = this.exc?.giveBackPosition !== null;
    this.exc = null;
    this.message =
      kind === "cleared"
        ? {
            kind,
            text: wasOvertake ? "Position handed back" : "Advantage given back",
            detail: "No further action",
            atMs: f.nowMs,
          }
        : { kind, text: "Track limits", detail: "No advantage · no action", atMs: f.nowMs };
    return { kind, lap };
  }

  private strike(reason: TrackLimitsReason, f: TrackLimitsFrame): TrackLimitsEvent {
    const lap = this.exc?.startLap ?? f.lapCount;
    this.exc = null;
    this.totalStrikes++;
    const why =
      reason === "illegal_overtake"
        ? "Illegal overtake · position not returned"
        : reason === "corner_cut"
          ? "Corner cut"
          : reason === "not_lifted"
            ? "Did not lift"
            : "Time gained";
    if (this.session === "practice") {
      this.message = { kind: "lap_invalid", text: "Track limits · lap deleted", detail: why, atMs: f.nowMs };
      return { kind: "lap_invalid", reason, lap };
    }
    if (reason === "illegal_overtake") {
      const seconds = REPEAT_PENALTY_S;
      this.penalties++;
      this.penaltyS += seconds;
      this.message = {
        kind: "penalty",
        text: `+${seconds.toFixed(1)}s time penalty`,
        detail: why,
        atMs: f.nowMs,
      };
      return { kind: "penalty", reason, penaltyS: seconds, lap };
    }
    this.warnings++;
    if (this.warnings >= STRIKES_PER_PENALTY) {
      const seconds = this.penalties === 0 ? FIRST_PENALTY_S : REPEAT_PENALTY_S;
      this.penalties++;
      this.penaltyS += seconds;
      this.warnings = 0;
      this.message = {
        kind: "penalty",
        text: `+${seconds.toFixed(1)}s time penalty`,
        detail: `Track limits · ${why.toLowerCase()}`,
        atMs: f.nowMs,
      };
      return { kind: "penalty", reason, penaltyS: seconds, lap };
    }
    this.message = {
      kind: "warning",
      text: `Track limits · warning ${this.warnings}/${STRIKES_PER_PENALTY}`,
      detail: why,
      atMs: f.nowMs,
    };
    return { kind: "warning", reason, lap };
  }
}
