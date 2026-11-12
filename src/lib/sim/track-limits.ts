/**
 * Race control for track limits.
 *
 * Outside a race (practice, the time trial) the rule is strict: the moment the car is off the track (the physics'
 * off-track flag, all four wheels off) the running lap is deleted, with no give-back. An excursion in the last sector
 * also deletes the next lap, as it gave the car a run onto the straight; a restart clears that.
 *
 * In a race an excursion is judged after the car is back on the asphalt instead of killing the lap the instant a wheel
 * crosses the line:
 *
 *   - a touch shorter than `MIN_EXCURSION_S` is ignored;
 *   - cutting the inside of a corner is always a strike unless the time is given back;
 *   - running wide is a strike only when it gained time over the best lap (delta at the exit vs at the entry,
 *     sampled once the car has settled), or, before there is a best lap, when the driver did not lift;
 *   - a strike can be cancelled by giving the advantage back within `GIVE_BACK_WINDOW_S`: lose the time gained
 *     (with a reference lap), or lift and coast for long enough (without one).
 *
 * Every strike is a warning, and every `STRIKES_PER_PENALTY`th strike is a time penalty: +3 s the first time, +5 s
 * after that.
 *
 * A course cut (the car jumps round the lap off its road, course-limits.ts) is no excursion to judge: the lap is
 * deleted, and in a race, once the car is back on the track, a time penalty takes back more than it gained: the time
 * saved (the reference time over the stretch from where it left the road to where it rejoined, less the time it took)
 * plus `COURSE_CUT_MARGIN_S`, and never under `COURSE_CUT_MIN_PENALTY_S`; none when the reference shows the road the
 * car took lost it the margin or more (the Grand Prix lap's loop driven on the short lap). Any excursion being judged
 * ends with it.
 */
import type { TrackLimitsReason, TrackLimitsStatus } from "@/types/f1";
import { CourseCutWatch } from "./course-limits";

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
/** A course cut's penalty: the time it saved plus this, rounded up to the second, and at least the minimum (s) */
export const COURSE_CUT_MARGIN_S = 5;
export const COURSE_CUT_MIN_PENALTY_S = 10;
export const FIRST_PENALTY_S = 3;
export const REPEAT_PENALTY_S = 5;

/** "practice": strict limits, any driving outside a race; "race": judged, from the lights to the flag */
export type TrackLimitsSession = "practice" | "race";

/** One frame of the player's car */
export interface TrackLimitsFrame {
  /** Wall-clock time (ms, performance.now) for the banner; `dtS` drives the judging */
  nowMs: number;
  dtS: number;
  lapCount: number;
  /** The running lap's clock (ms): it going back is a lap starting, also the first crossing after a restart */
  lapTimeMs?: number;
  /** The sector the car is in (strict limits: an excursion in the last one also deletes the next lap) */
  sector?: 1 | 2 | 3;
  /** Lap distance (m) */
  distM: number;
  /** Lap length (m): with it, a jump of the lap distance no car can drive is a course cut */
  lapLengthM?: number;
  /**
   * Time the car's reference lap takes from one lap distance to another (s, forwards round the lap): the best lap,
   * else its speed profile; null without one. What a course cut saved is measured against it
   */
  stretchRefS?: (fromM: number, toM: number) => number | null;
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
  /** Track-limits penalties alone (an illegal-overtake penalty does not make the next one a repeat) */
  private limitPenalties = 0;
  private penaltyS = 0;
  private lastOnTrackPosition: number | null = null;
  private exc: Excursion | null = null;
  /** Strict limits: the car was off the track last frame, and the next lap is to be deleted too */
  private wasOff = false;
  private nextLapDeleted = false;
  /** Strict limits: the lap count and lap clock last frame (null until the first frame of a run) */
  private seenLapCount: number | null = null;
  private seenLapTimeMs: number | null = null;
  /** Lap distance last frame (m), and its jumps round the lap, for course cuts; null until the first frame of a run */
  private seenDistM: number | null = null;
  private readonly cutWatch = new CourseCutWatch();
  /** Session clock (s, the frames' dtS); where and when the car was last on the track with no jump pending */
  private clockS = 0;
  private onRoad: { distM: number; clockS: number } | null = null;
  /** A race's course cut owing its penalty: where and when the car left the road */
  private cutFrom: { distM: number; clockS: number } | null = null;
  /** A course cut and the car not back on the track since: the rest of that excursion is the cut, not judged */
  private afterCut = false;
  /** The last frame was judged (`TrackLimitsFrame.active`); a verdict waiting while not is kept off the HUD */
  private active = true;
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
    this.limitPenalties = 0;
    this.penaltyS = 0;
    this.lastOnTrackPosition = null;
    this.exc = null;
    this.wasOff = false;
    this.nextLapDeleted = false;
    this.seenLapCount = null;
    this.seenLapTimeMs = null;
    this.seenDistM = null;
    this.cutWatch.reset();
    this.onRoad = null;
    this.cutFrom = null;
    this.lastCutSavedS = null;
    this.afterCut = false;
    this.active = true;
    this.message = null;
  }

  get mode(): TrackLimitsSession {
    return this.session;
  }

  /** Strict limits: an excursion in the last sector has the next lap deleted too (cleared by `reset`) */
  get nextLapForfeit(): boolean {
    return this.nextLapDeleted;
  }

  /** What the last course cut saved against the reference lap (s), as its penalty measured it; null without one */
  lastCutSavedS: number | null = null;

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
    this.active = f.active;
    this.clockS += f.dtS;
    if (this.courseCut(f)) {
      const race = this.session === "race";
      const deleted = race ? null : this.strict(f);
      if (!deleted && !race) this.totalStrikes++;
      this.exc = null;
      this.message = {
        kind: "lap_invalid",
        text: "Course cut · lap deleted",
        detail: race ? "Time penalty once back on the track" : "Left the lap's road",
        atMs: f.nowMs,
      };
      if (race) this.cutFrom = this.onRoad ?? { distM: f.distM, clockS: this.clockS };
      this.afterCut = f.offTrack;
      if (race && !f.offTrack) return this.cutPenalty(f);
      return { kind: "lap_invalid", lap: f.lapCount };
    }
    if (this.afterCut) {
      if (f.offTrack) {
        if (this.session === "race") return null;
      } else {
        this.afterCut = false;
        if (this.cutFrom) return this.cutPenalty(f);
      }
    }
    if (this.session === "practice") return this.strict(f);
    if (!f.active) {
      // An excursion still in progress can't be finished by the driver any more (the autopilot, the lights or the
      // flag took over): forget it. One already back on the track owes a verdict: it waits, its clocks stopped,
      // until the driver drives again or the session is reset (toggling the autopilot must not wipe a give-back)
      if (this.exc?.stage === "off") this.exc = null;
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
      // Back off the track before the first excursion was decided: one longer excursion, judged afresh (the gain
      // measured for the first part no longer stands)
      e.stage = "off";
      e.onS = 0;
      e.gainS = null;
      e.reason = null;
      return null;
    }
    if (e.stage === "judging") return this.whileJudging(e, f);
    return this.whileGivingBack(e, f);
  }

  /** Has a jump of the lap distance further than the car can have driven stood (judged only while driving)? */
  private courseCut(f: TrackLimitsFrame): boolean {
    const prev = this.seenDistM;
    this.seenDistM = f.distM;
    const L = f.lapLengthM;
    if (prev === null || L === undefined || !f.active) {
      this.cutWatch.reset();
      return false;
    }
    const cut = this.cutWatch.update(((((f.distM - prev + L / 2) % L) + L) % L) - L / 2, f.dtS);
    // Where the car left the road: its last spot on the track before the jump
    if (!cut && !f.offTrack && !this.cutWatch.pending) this.onRoad = { distM: f.distM, clockS: this.clockS };
    return cut;
  }

  /**
   * A race's course cut, the car back on the track: a time penalty of what the cut saved against the reference lap
   * (from where it left the road to here), plus the margin, and at least the minimum
   */
  private cutPenalty(f: TrackLimitsFrame): TrackLimitsEvent {
    const from = this.cutFrom;
    this.cutFrom = null;
    const ref = from && f.stretchRefS ? f.stretchRefS(from.distM, f.distM) : null;
    const savedS = from && ref !== null ? ref - (this.clockS - from.clockS) : null;
    this.lastCutSavedS = savedS;
    if (savedS !== null && savedS + COURSE_CUT_MARGIN_S <= 0) {
      // A longer way round: nothing gained to take back
      this.message = { kind: "lap_invalid", text: "Course cut · lap deleted", detail: "No time gained", atMs: f.nowMs };
      return { kind: "lap_invalid", lap: f.lapCount };
    }
    const seconds = Math.max(COURSE_CUT_MIN_PENALTY_S, Math.ceil((savedS ?? 0) + COURSE_CUT_MARGIN_S));
    this.penalties++;
    this.penaltyS += seconds;
    this.message = {
      kind: "penalty",
      text: `Course cut · +${seconds.toFixed(1)}s time penalty`,
      detail: savedS !== null && savedS > 0 ? `${savedS.toFixed(1)} s gained` : "Lap deleted",
      atMs: f.nowMs,
    };
    return { kind: "penalty", reason: "course_cut", penaltyS: seconds, lap: f.lapCount };
  }

  /** The state for the HUD (updated in place) */
  snapshot(nowMs: number): TrackLimitsStatus {
    const s = this.status;
    s.warnings = this.warnings;
    s.totalStrikes = this.totalStrikes;
    s.penaltyS = this.penaltyS;
    const e = this.exc;
    s.pending =
      e && this.active && e.offS >= MIN_EXCURSION_S
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

  /**
   * Strict limits, one frame: the lap is deleted the moment the car is off the track, and an excursion in the last
   * sector deletes the lap that starts next too (said again as that lap starts). Not driving (the autopilot) judges
   * nothing, but the lap starts are still followed.
   */
  private strict(f: TrackLimitsFrame): TrackLimitsEvent | null {
    const started =
      this.seenLapCount !== null &&
      (f.lapCount !== this.seenLapCount || (f.lapTimeMs !== undefined && this.seenLapTimeMs !== null && f.lapTimeMs < this.seenLapTimeMs));
    this.seenLapCount = f.lapCount;
    this.seenLapTimeMs = f.lapTimeMs ?? null;
    const wasOff = this.wasOff;
    this.wasOff = f.offTrack && f.active;
    if (!f.active) {
      // A lap the autopilot starts is not the player's: the next lap's deletion lapses with it
      if (started) this.nextLapDeleted = false;
      return null;
    }

    let deleted = false;
    if (started && this.nextLapDeleted) {
      this.nextLapDeleted = false;
      deleted = true;
      this.message = { kind: "lap_invalid", text: "Track limits · lap deleted", detail: "Off before the line", atMs: f.nowMs };
    }
    if (f.offTrack) {
      const lastSector = f.sector === 3;
      if (!wasOff || (lastSector && !this.nextLapDeleted)) {
        deleted = true;
        this.message = {
          kind: "lap_invalid",
          text: "Track limits · lap deleted",
          detail: lastSector ? "Next lap too" : "Off the track",
          atMs: f.nowMs,
        };
      }
      if (lastSector) this.nextLapDeleted = true;
    }
    if (!deleted) return null;
    this.totalStrikes++;
    return { kind: "lap_invalid", lap: f.lapCount };
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
    // Judged afresh: an earlier verdict on this excursion (it went off again while giving back) no longer applies
    e.giveBackPosition = null;

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
      e.gainS = null;
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
      const seconds = this.limitPenalties === 0 ? FIRST_PENALTY_S : REPEAT_PENALTY_S;
      this.limitPenalties++;
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
