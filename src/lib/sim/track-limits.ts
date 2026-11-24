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
 * What a strike costs is the race's ladder (`TrackLimitsRules.scoring`, from race-rules.ts):
 *   - "legacy": every strike is a warning, and every `STRIKES_PER_PENALTY`th one a time penalty, +3 s the first time,
 *     +5 s after that (online races, until every build judges by the presets);
 *   - "four_strike": a strike is one point;
 *   - "weighted_pts": a strike scores the excursion's weighted points (`weightedCutPoints`: the time gained, the
 *     distance cut, how the driver drove off the track and any wall riding), in quarter points; a corner cut that
 *     gained no time but took a real shortcut scores too;
 *   - "disabled": excursions are not judged (course cuts still are).
 * With points, the black-and-white flag comes one point before `pointsAllowed`, +5 s at it, +10 s at twice it, and
 * disqualification at three times it; a single cut big enough (`IMMEDIATE_*`) is a time penalty at once instead.
 * A position gained off the track is watched for `PASS_MONITOR_S`, then has to be handed back within
 * `POSITION_GIVE_BACK_S`, or it is +5 s (+10 s for more than one place).
 *
 * A course cut (the car jumps round the lap off its road, course-limits.ts) is no excursion to judge: the lap is
 * deleted, and in a race, once the car is back on the track, a time penalty takes back more than it gained: the time
 * saved (the reference time over the stretch from where it left the road to where it rejoined, less the time it took)
 * plus `COURSE_CUT_MARGIN_S`, and never under `COURSE_CUT_MIN_PENALTY_S`; none when the reference shows the road the
 * car took lost it the margin or more (the Grand Prix lap's loop driven on the short lap). Any excursion being judged
 * ends with it.
 *
 * Barrier contact (the car's summed contact while moving, `TrackLimitsFrame.wallContactS`): on a hill climb any touch
 * breaks the rule (a run that hits the bales is done), on a circuit only riding the wall does, contact adding up to
 * `WALL_RIDE_S` within `WALL_RIDE_WINDOW_S` (a brush off a barrier does not). Outside a race a breach deletes the lap
 * ("Wall contact"), and on a circuit, as an excursion does, one in the last sector or still going at the line deletes
 * the next lap too; in a race it is judged as time off the track, like any excursion.
 */
import { text as t } from "@/lib/text";
import type { TrackLimitsReason, TrackLimitsStatus } from "@/types/f1";
import { CourseCutWatch } from "./course-limits";
import type { TrackLimitsScoring } from "./race-rules";

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
/**
 * Wall-riding on a circuit: barrier contact (while moving) adding up to this within the window below (s). Measured
 * with the real cars: the racing lines touch no barrier anywhere; driving every corner with the outer wheels on or
 * past the edge (Monaco, Norisring, the F1 and the GT3) adds up to at most 0.30 s in any 3 s; leaning on Monaco's and
 * Norisring's barriers on purpose for two seconds or more, 0.40-1.03 s (the car bounces along the wall, so it touches
 * it a fifth to a third of the time)
 */
const WALL_RIDE_S = 0.35;
const WALL_RIDE_WINDOW_S = 3.0;
/** In a race, a breach of the wall rule is time off the track until the car has been clear of the wall this long (s) */
const WALL_CLEAR_S = 0.5;

export const STRIKES_PER_PENALTY = 3;
/** A course cut's penalty: the time it saved plus this, rounded up to the second, and at least the minimum (s) */
export const COURSE_CUT_MARGIN_S = 5;
export const COURSE_CUT_MIN_PENALTY_S = 10;
export const FIRST_PENALTY_S = 3;
export const REPEAT_PENALTY_S = 5;

/** Points ladders: a pass gained off the track is watched this long before it must be handed back (s) */
export const PASS_MONITOR_S = 3;
/** … and then has this long to be handed back (s) */
export const POSITION_GIVE_BACK_S = 15;
/** One cut this big is a time penalty at once: its weighted points, the distance it cut (m), or the time it gained (s) */
export const IMMEDIATE_5S_POINTS = 3;
export const IMMEDIATE_10S_POINTS = 8;
export const IMMEDIATE_SHORTCUT_M = 18;
export const IMMEDIATE_GAIN_S = 2;
/** The ladder's time penalties at one and two times the allowance (s); three times is disqualification */
export const LADDER_PENALTIES_S = [5, 10] as const;
/** Braking zone: the brake over this at over this speed while off the track (m/s) */
const BRAKING_ZONE_BRAKE = 0.15;
const BRAKING_ZONE_MS = 18;

/** How a race scores its excursions (race-rules.ts) */
export interface TrackLimitsRules {
  scoring: TrackLimitsScoring;
  /** Points to the first time penalty */
  pointsAllowed: number;
}

export const LEGACY_TRACK_LIMITS: TrackLimitsRules = { scoring: "legacy", pointsAllowed: STRIKES_PER_PENALTY };

/** What a judged excursion did, for its weighted points */
export interface CutInput {
  /** Time gained over the reference lap through the excursion (s, + = faster); null without a reference */
  gainS: number | null;
  /** Distance cut: the shortest legal way between leaving and rejoining (the inside edge), less the way the car drove (m) */
  shortcutM: number;
  /** Mean throttle while off the track (0..1) */
  offThrottleAvg: number;
  /** Braked hard at speed while off (cutting a braking zone) */
  brakingZone: boolean;
  /** Speed at the rejoin less the speed leaving the track (m/s) */
  speedGainMs: number;
  /** Track curvature driven past while off (rad): a chicane turns the road both ways */
  curvatureRad: number;
  /** The excursion was riding a wall, and how long it touched it (s) */
  wallRiding: boolean;
  wallContactS: number;
}

/**
 * One excursion's weighted track-limits points, in quarter points (0 under 0.15): the time gained (or a credit for
 * time lost, except through a chicane taken flat out), the distance cut past the first 1.5 m, scaled by how the driver
 * drove off the track (lifting halves it, braking in a braking zone and a faster rejoin add to it), plus any wall riding
 */
export function weightedCutPoints(c: CutInput): number {
  const g = c.gainS;
  const chicaneCut = c.curvatureRad > 0.35 && (g ?? 0) > -0.1 && c.offThrottleAvg > 0.45;
  const timePts =
    g === null ? 0 : g > 0 ? 1.85 * g + 0.55 * Math.max(0, g - 0.5) ** 2 : g <= -0.02 && !chicaneCut ? 0.75 * g : 0;
  const shortcutPts = c.shortcutM < 1.5 ? 0 : 0.14 * (c.shortcutM - 1.5);
  let scale = 0.5 + 0.5 * Math.max(0, Math.min(1, c.offThrottleAvg));
  if (c.brakingZone && (g ?? 0) > 0) scale *= 1.25;
  if (c.speedGainMs > 1.5) scale *= 1.15;
  scale = Math.max(0.5, Math.min(1.35, scale));
  const wallPts = c.wallRiding ? Math.max(1, 1.25 * c.wallContactS) : 0;
  const raw = Math.max(0, (timePts + shortcutPts) * scale + wallPts);
  return raw < 0.15 ? 0 : Math.round(raw / 0.25) * 0.25;
}

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
  /** Speed (m/s), world position (m) and the road's half width here (m), for the points ladders' measures of a cut */
  speedMs?: number;
  posX?: number;
  posZ?: number;
  halfWidthM?: number;
  /**
   * Seconds the car's body has touched a barrier while moving, summed since the car was placed (its `wallContactS`
   * channel): the contact between two frames is its rise (a drop, a placement, is none). Absent: none is judged
   */
  wallContactS?: number;
  /** How barrier contact is judged: "touch" (a hill climb: any touch), "ride" (a circuit: wall-riding only); absent: not */
  wallRule?: "touch" | "ride";
}

export interface TrackLimitsEvent {
  kind: "warning" | "penalty" | "cleared" | "lap_invalid" | "no_advantage" | "disqualified";
  reason?: TrackLimitsReason;
  penaltyS?: number;
  /** Lap on which the excursion started */
  lap: number;
}

interface Excursion {
  startLap: number;
  /** Session clock (`TrackLimitsMonitor.clockS`) when this excursion started, for Flashback rewind checks */
  startedAtClockS: number;
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
  /** Places gained off the track (to hand back) */
  placesGained: number;
  /** Points ladders' measures: throttle × time off, braking zone, curvature driven past, wall riding */
  throttleS: number;
  brakingZone: boolean;
  curvatureRad: number;
  lastDistM: number;
  wallRiding: boolean;
  wallS: number;
  /** How fast the car left the track, and rejoined it (m/s) */
  leaveSpeedMs?: number;
  rejoinSpeedMs?: number;
  /**
   * The way from where the car left the track, every frame until the excursion is decided: the road's inside edge
   * (the shortest legal line: the centreline less the half width on every bend) and the car's own path (m); null
   * without positions. `shortcutM` is what they read at the last rejoin
   */
  way: { insideM: number; drivenM: number; x: number; z: number } | null;
  shortcutM: number;
  /** The weighted points this excursion scores, once judged (points ladders) */
  points: number;
}

export class TrackLimitsMonitor {
  private session: TrackLimitsSession = "practice";
  private rules: TrackLimitsRules = LEGACY_TRACK_LIMITS;
  /** Points ladders: points so far, ladder steps paid (1 = +5 s, 2 = +10 s, 3 = disqualified), the last step flagged */
  private points = 0;
  private steps = 0;
  private flaggedStep = -1;
  private dq = false;
  /** Barrier contact this frame (s) */
  private wallDeltaS = 0;
  private warnings = 0;
  private totalStrikes = 0;
  private penalties = 0;
  /** Track-limits penalties alone (an illegal-overtake penalty does not make the next one a repeat) */
  private limitPenalties = 0;
  private penaltyS = 0;
  private lastOnTrackPosition: number | null = null;
  private exc: Excursion | null = null;
  /** Strict limits: the car was off the track last frame, and the next lap is to be deleted too (for the wall: riding it) */
  private wasOff = false;
  private nextLapDeleted = false;
  private nextLapWall = false;
  private nextLapDeletedAtClockS: number | null = null;
  /** Strict limits: the lap count and lap clock last frame (null until the first frame of a run) */
  private seenLapCount: number | null = null;
  private seenLapTimeMs: number | null = null;
  /** Lap distance last frame (m), and its jumps round the lap, for course cuts; null until the first frame of a run */
  private seenDistM: number | null = null;
  private readonly cutWatch = new CourseCutWatch();
  /** Session clock (s, the frames' dtS); where and when the car was last on the track with no jump pending */
  private clockS = 0;
  private onRoad: { distM: number; clockS: number } | null = null;
  /** A race's course cut owing its penalty: where and when the car left the road, plus when the cut was detected */
  private cutFrom: { distM: number; clockS: number; detectedClockS: number } | null = null;
  /** A course cut and the car not back on the track since: the rest of that excursion is the cut, not judged */
  private afterCut = false;
  /** The last frame was judged (`TrackLimitsFrame.active`); a verdict waiting while not is kept off the HUD */
  private active = true;
  /** Barrier contact: the car's contact total last frame, the contact of the window's frames (clock, s pairs) and its sum */
  private seenWallS: number | null = null;
  private readonly wallLog: number[] = [];
  private wallSumS = 0;
  /** A breach of the wall rule in progress (from the frame it broke it until the window holds no contact), and contact this frame */
  private wallBreach = false;
  private wallNow = false;
  /** Session clock of the last frame with barrier contact */
  private wallLastS = -Infinity;
  private message: TrackLimitsStatus["message"] = null;
  private readonly ladderStatus: NonNullable<TrackLimitsStatus["ladder"]> = {
    scoring: "four_strike",
    points: 0,
    pointsAllowed: 0,
    blackWhite: false,
    disqualified: false,
  };
  private readonly status: TrackLimitsStatus = {
    warnings: 0,
    strikesPerPenalty: STRIKES_PER_PENALTY,
    totalStrikes: 0,
    penaltyS: 0,
    pending: null,
    message: null,
  };

  /** Starts a new session or race: everything back to zero. `rules`: a race's ladder (legacy without) */
  reset(session: TrackLimitsSession, rules: TrackLimitsRules = LEGACY_TRACK_LIMITS): void {
    this.session = session;
    this.rules = rules;
    this.points = 0;
    this.steps = 0;
    this.flaggedStep = -1;
    this.dq = false;
    this.wallDeltaS = 0;
    this.warnings = 0;
    this.totalStrikes = 0;
    this.penalties = 0;
    this.limitPenalties = 0;
    this.penaltyS = 0;
    this.lastOnTrackPosition = null;
    this.exc = null;
    this.wasOff = false;
    this.nextLapDeleted = false;
    this.nextLapWall = false;
    this.nextLapDeletedAtClockS = null;
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
    this.seenWallS = null;
    this.wallLog.length = 0;
    this.wallSumS = 0;
    this.wallBreach = false;
    this.wallNow = false;
    this.wallLastS = -Infinity;
  }

  /**
   * Reconciles track-limits watches after a Flashback rewind by `rewindS` seconds:
   * - Drops excursions / cuts / forfeits that began inside the rewound window (`startedAt > restoredClockS`).
   * - Preserves any excursion, course cut, or next-lap forfeit that was already pending before the restored moment,
   *   preventing zero-rewind or post-offence Flashback from erasing pending verdicts or give-back orders.
   * - In strict (practice) mode, flashing back across Start/Finish or into Sector 3 also forfeits the next lap.
   * - Resets `seenLapCount` / `seenLapTimeMs` and transient jump/wall watchers so the restore itself never registers
   *   as a lap start or course cut.
   */
  noteFlashback(
    nowMs: number,
    rewindS = 0,
    opts?: { crossedLine?: boolean; inLastSector?: boolean }
  ): void {
    const restoredClockS = Math.max(0, this.clockS - Math.max(0, rewindS));
    if (this.exc) {
      if (this.exc.startedAtClockS > restoredClockS) {
        this.exc = null;
      } else {
        // Keep the pending excursion/give-back, dropping the spatial trace anchor so the jump doesn't inflate curvatureRad
        this.exc.way = null;
        this.exc.lastDistM = Number.NaN;
      }
    }
    if (this.cutFrom && this.cutFrom.detectedClockS > restoredClockS) {
      this.cutFrom = null;
      this.afterCut = false;
    }
    if (
      this.nextLapDeleted &&
      this.nextLapDeletedAtClockS !== null &&
      this.nextLapDeletedAtClockS > restoredClockS
    ) {
      this.nextLapDeleted = false;
      this.nextLapWall = false;
      this.nextLapDeletedAtClockS = null;
    }
    const forfeitNext = this.session === "practice" && Boolean(opts?.crossedLine || opts?.inLastSector);
    if (forfeitNext && !this.nextLapDeleted) {
      this.nextLapDeleted = true;
      this.nextLapWall = false;
      this.nextLapDeletedAtClockS = restoredClockS;
    }
    this.clockS = restoredClockS;
    this.seenLapCount = null;
    this.seenLapTimeMs = null;
    this.wasOff = false;
    this.seenDistM = null;
    this.cutWatch.reset();
    this.onRoad = null;
    this.seenWallS = null;
    this.wallLog.length = 0;
    this.wallSumS = 0;
    this.wallBreach = false;
    this.wallNow = false;
    this.message = {
      kind: "lap_invalid",
      text: t("game.trackLimits.flashbackDeleted"),
      detail: forfeitNext ? t("game.trackLimits.currentAndNextInvalid") : t("game.trackLimits.currentInvalid"),
      atMs: nowMs,
    };
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

  /** Disqualified by the points ladder (three times the allowance) */
  get disqualified(): boolean {
    return this.dq;
  }

  /** Points so far (points ladders; 0 otherwise) */
  get pointsTotal(): number {
    return this.points;
  }

  get scoring(): TrackLimitsScoring {
    return this.rules.scoring;
  }

  private get laddered(): boolean {
    return this.rules.scoring === "four_strike" || this.rules.scoring === "weighted_pts";
  }

  /** An excursion is still being judged: a lap that ends now cannot count as clean */
  get judging(): boolean {
    return this.exc !== null;
  }

  /** Advances the judging by one frame; returns the race-control decision taken this frame, if any */
  update(frame: TrackLimitsFrame): TrackLimitsEvent | null {
    this.active = frame.active;
    this.clockS += frame.dtS;
    const wallBroken = this.wallFrame(frame);
    // In a race, a breach of the wall rule is judged as time off the track, until the car is clear of the wall (it
    // bounces along it, touching it a fifth to a third of the time)
    const riding = this.wallBreach && this.clockS - this.wallLastS < WALL_CLEAR_S;
    const f = this.session === "race" && riding && !frame.offTrack ? { ...frame, offTrack: true } : frame;
    if (this.courseCut(f)) {
      const race = this.session === "race";
      const deleted = race ? null : this.strict(f);
      if (!deleted && !race) this.totalStrikes++;
      this.exc = null;
      this.message = {
        kind: "lap_invalid",
        text: t("game.trackLimits.courseCutDeleted"),
        detail: race ? t("game.trackLimits.penaltyOnceBack") : t("game.trackLimits.leftLapRoad"),
        atMs: f.nowMs,
      };
      if (race) {
        const origin = this.onRoad ?? { distM: f.distM, clockS: this.clockS };
        this.cutFrom = { ...origin, detectedClockS: this.clockS };
      }
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
    if (this.session === "practice") return this.strict(f, wallBroken);
    // Track limits off, or the driver already disqualified: no excursion is judged
    if (this.rules.scoring === "disabled" || this.dq) {
      this.exc = null;
      return null;
    }
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

    this.trace(e, f);
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

  /**
   * Barrier contact this frame against the frame's wall rule: a hill climb's any touch, a circuit's wall-riding
   * (contact adding up to `WALL_RIDE_S` within `WALL_RIDE_WINDOW_S`). True on the frame a breach starts; a breach lasts
   * until the window holds no contact (scraping along the barrier is one breach, not one a frame)
   */
  private wallFrame(f: TrackLimitsFrame): boolean {
    const total = f.wallContactS;
    const prev = this.seenWallS;
    this.seenWallS = total ?? null;
    this.wallDeltaS = 0;
    if (total === undefined || prev === null || !f.wallRule || !f.active) {
      this.wallLog.length = 0;
      this.wallSumS = 0;
      this.wallBreach = false;
      this.wallNow = false;
      return false;
    }
    const d = Math.max(0, total - prev);
    this.wallDeltaS = d;
    this.wallNow = d > 0;
    if (this.wallNow) this.wallLastS = this.clockS;
    if (d > 0) {
      this.wallLog.push(this.clockS, d);
      this.wallSumS += d;
    }
    while (this.wallLog.length > 0 && this.wallLog[0] <= this.clockS - WALL_RIDE_WINDOW_S) {
      this.wallSumS -= this.wallLog[1];
      this.wallLog.splice(0, 2);
    }
    if (this.wallLog.length === 0) this.wallSumS = 0;
    const over = f.wallRule === "touch" ? this.wallNow : this.wallSumS >= WALL_RIDE_S;
    if (over && !this.wallBreach) {
      this.wallBreach = true;
      return true;
    }
    if (this.wallLog.length === 0) this.wallBreach = false;
    return false;
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
      this.message = { kind: "lap_invalid", text: t("game.trackLimits.courseCutDeleted"), detail: t("game.trackLimits.noTimeGained"), atMs: f.nowMs };
      return { kind: "lap_invalid", lap: f.lapCount };
    }
    const seconds = Math.max(COURSE_CUT_MIN_PENALTY_S, Math.ceil((savedS ?? 0) + COURSE_CUT_MARGIN_S));
    this.penalties++;
    this.penaltyS += seconds;
    this.message = {
      kind: "penalty",
      text: t("game.trackLimits.courseCutPenalty", { seconds: seconds.toFixed(1) }),
      detail: savedS !== null && savedS > 0 ? t("game.trackLimits.secondsGained", { seconds: savedS.toFixed(1) }) : t("game.trackLimits.lapDeleted"),
      atMs: f.nowMs,
    };
    return { kind: "penalty", reason: "course_cut", penaltyS: seconds, lap: f.lapCount };
  }

  /** The state for the HUD (updated in place) */
  snapshot(nowMs: number): TrackLimitsStatus {
    const s = this.status;
    if (this.laddered) {
      // The meter towards the next ladder step (pips for strikes, quarter points for the weighted ladder)
      const A = this.rules.pointsAllowed;
      s.warnings = Math.max(0, Math.min(A, this.points - Math.min(this.steps, 2) * A));
      s.strikesPerPenalty = A;
      const l = (s.ladder = this.ladderStatus);
      l.scoring = this.rules.scoring as "four_strike" | "weighted_pts";
      l.points = this.points;
      l.pointsAllowed = A;
      l.blackWhite = !this.dq && this.points >= (this.steps + 1) * A - 1 - 1e-9;
      l.disqualified = this.dq;
    } else {
      s.warnings = this.warnings;
      // Track limits off in a race: no meter to show
      s.strikesPerPenalty = this.rules.scoring === "disabled" && this.session === "race" ? 0 : STRIKES_PER_PENALTY;
      s.ladder = undefined;
    }
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
                  ? // A position to hand back: the bar is the time left
                    Math.max(0, Math.min(1, e.windowS / this.handBackWindowS))
                  : e.giveBackTarget !== null
                    ? Math.max(0, Math.min(1, e.liftDoneS))
                    : Math.max(0, Math.min(1, e.liftDoneS / Math.max(1e-3, e.liftOwedS))),
            // A pass is watched before its hand-back clock starts: the bar stays full meanwhile
            remainingS: e.stage === "give_back" ? Math.max(0, Math.min(e.windowS, this.handBackWindowS)) : 0,
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
  private strict(f: TrackLimitsFrame, wallBroken = false): TrackLimitsEvent | null {
    const started =
      this.seenLapCount !== null &&
      (f.lapCount !== this.seenLapCount || (f.lapTimeMs !== undefined && this.seenLapTimeMs !== null && f.lapTimeMs < this.seenLapTimeMs));
    this.seenLapCount = f.lapCount;
    this.seenLapTimeMs = f.lapTimeMs ?? null;
    const wasOff = this.wasOff;
    this.wasOff = f.offTrack && f.active;
    if (!f.active) {
      // A lap the autopilot starts is not the player's: the next lap's deletion lapses with it
      if (started) {
        this.nextLapDeleted = this.nextLapWall = false;
        this.nextLapDeletedAtClockS = null;
      }
      return null;
    }

    // A circuit's wall-ride (a breach of its rule, until the window is clear) is an excursion of its own: in the last
    // sector it deletes the next lap too, and on a frame with no sector, one still going as that lap starts does. A hill
    // climb's run ends at its finish: nothing carries over to the next one
    const rideBreach = f.wallRule === "ride" && this.wallBreach;
    let deleted = false;
    let wallDeleted = false;
    if (started && (this.nextLapDeleted || (rideBreach && f.sector === undefined))) {
      wallDeleted = this.nextLapDeleted ? this.nextLapWall : true;
      this.nextLapDeleted = this.nextLapWall = false;
      this.nextLapDeletedAtClockS = null;
      deleted = true;
      this.message = wallDeleted
        ? { kind: "lap_invalid", text: t("game.trackLimits.wallDeleted"), detail: t("game.trackLimits.rodeWallBeforeLine"), atMs: f.nowMs }
        : { kind: "lap_invalid", text: t("game.trackLimits.limitsDeleted"), detail: t("game.trackLimits.offBeforeLine"), atMs: f.nowMs };
    }
    if (f.offTrack) {
      const lastSector = f.sector === 3;
      if (!wasOff || (lastSector && !this.nextLapDeleted)) {
        deleted = true;
        wallDeleted = false;
        this.message = {
          kind: "lap_invalid",
          text: t("game.trackLimits.limitsDeleted"),
          detail: lastSector ? t("game.trackLimits.nextLapToo") : t("game.trackLimits.offTrack"),
          atMs: f.nowMs,
        };
      }
      if (lastSector) {
        this.nextLapDeleted = true;
        this.nextLapWall = false;
        this.nextLapDeletedAtClockS = this.clockS;
      }
    }
    const wallNext = rideBreach && this.wallNow && f.sector === 3 && !this.nextLapDeleted;
    if (wallNext) {
      this.nextLapDeleted = this.nextLapWall = true;
      this.nextLapDeletedAtClockS = this.clockS;
    }
    if ((wallBroken || wallNext) && !deleted) {
      this.totalStrikes++;
      this.message = {
        kind: "lap_invalid",
        text: t("game.trackLimits.wallDeleted"),
        detail: wallNext ? t("game.trackLimits.nextLapToo") : f.wallRule === "touch" ? t("game.trackLimits.touchedBarrier") : t("game.trackLimits.rodeWall"),
        atMs: f.nowMs,
      };
      return { kind: "lap_invalid", reason: "wall_contact", lap: f.lapCount };
    }
    if (!deleted) return null;
    this.totalStrikes++;
    return wallDeleted ? { kind: "lap_invalid", reason: "wall_contact", lap: f.lapCount } : { kind: "lap_invalid", lap: f.lapCount };
  }

  private startExcursion(f: TrackLimitsFrame): Excursion {
    return {
      startLap: f.lapCount,
      startedAtClockS: this.clockS,
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
      placesGained: 0,
      throttleS: 0,
      brakingZone: false,
      curvatureRad: 0,
      lastDistM: f.distM,
      wallRiding: false,
      wallS: 0,
      leaveSpeedMs: f.speedMs,
      way: f.posX !== undefined && f.posZ !== undefined ? { insideM: 0, drivenM: 0, x: f.posX, z: f.posZ } : null,
      shortcutM: 0,
      points: 0,
    };
  }

  /** Lap distance moved this frame (m, wrapped round the line); set by `trace` */
  private lastDs = 0;

  /**
   * Follows the excursion's way, every frame from where the car left the track until it is decided (going off again
   * while it is being judged makes one longer way): the road's inside edge and the car's own path
   */
  private trace(e: Excursion, f: TrackLimitsFrame): void {
    if (!Number.isFinite(e.lastDistM)) {
      e.lastDistM = f.distM;
      this.lastDs = 0;
      return;
    }
    const L = f.lapLengthM;
    const ds = L ? ((((f.distM - e.lastDistM + L / 2) % L) + L) % L) - L / 2 : f.distM - e.lastDistM;
    e.lastDistM = f.distM;
    this.lastDs = ds;
    const w = e.way;
    if (!w || f.posX === undefined || f.posZ === undefined) return;
    w.insideM += ds * Math.max(0, 1 - Math.abs(f.curvature) * (f.halfWidthM ?? 0));
    w.drivenM += Math.hypot(f.posX - w.x, f.posZ - w.z);
    w.x = f.posX;
    w.z = f.posZ;
  }

  /** The time a position gained off the track has to be handed back in, once watched (s) */
  private get handBackWindowS(): number {
    return this.laddered ? POSITION_GIVE_BACK_S : ILLEGAL_OVERTAKE_WINDOW_S;
  }

  private whileOff(e: Excursion, f: TrackLimitsFrame): TrackLimitsEvent | null {
    if (f.offTrack) {
      e.offS += f.dtS;
      e.onS = 0;
      e.minThrottle = Math.min(e.minThrottle, f.throttle);
      e.maxBrake = Math.max(e.maxBrake, f.brake);
      e.throttleS += f.throttle * f.dtS;
      if (f.brake > BRAKING_ZONE_BRAKE && (f.speedMs ?? 0) > BRAKING_ZONE_MS) e.brakingZone = true;
      e.curvatureRad += Math.abs(f.curvature * this.lastDs);
      if (this.wallBreach) e.wallRiding = true;
      e.wallS += this.wallDeltaS;
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
    e.rejoinSpeedMs = f.speedMs;
    e.shortcutM = e.way ? Math.max(0, e.way.insideM - e.way.drivenM) : 0;
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
      e.placesGained = e.entryPosition - f.racePosition;
      e.giveBackTarget = null;
      e.stage = "give_back";
      // The points ladders watch the pass first, then start the hand-back clock
      e.windowS = this.laddered ? PASS_MONITOR_S + POSITION_GIVE_BACK_S : ILLEGAL_OVERTAKE_WINDOW_S;
      e.liftDoneS = 0;
      return null;
    }

    const hasRef = e.deltaAtEntry !== null && f.deltaS !== null && f.lapCount === e.startLap;
    const gain = hasRef ? (e.deltaAtEntry as number) - (f.deltaS as number) : null;
    // The points ladders measure the cut: one big enough is a time penalty at once
    let shortcut = false;
    if (this.laddered) {
      const shortcutM = e.shortcutM;
      const offS = Math.max(1e-3, e.offS);
      e.points = weightedCutPoints({
        gainS: gain,
        shortcutM,
        offThrottleAvg: e.throttleS / offS,
        brakingZone: e.brakingZone,
        speedGainMs: e.rejoinSpeedMs !== undefined && e.leaveSpeedMs !== undefined ? e.rejoinSpeedMs - e.leaveSpeedMs : 0,
        curvatureRad: e.curvatureRad,
        wallRiding: e.wallRiding,
        wallContactS: e.wallS,
      });
      if (e.points >= IMMEDIATE_5S_POINTS || shortcutM >= IMMEDIATE_SHORTCUT_M || (gain ?? 0) >= IMMEDIATE_GAIN_S) {
        return this.immediatePenalty(e, f, e.points >= IMMEDIATE_10S_POINTS ? 10 : 5, shortcutM, gain);
      }
      // The weighted ladder scores a real shortcut that gained no time (a cut chicane taken slowly is still cut)
      shortcut = this.rules.scoring === "weighted_pts" && e.points >= 0.25 && shortcutM >= 1.5;
    }

    if (hasRef) {
      e.gainS = gain;
      const threshold = e.insideCut ? CUT_GAIN_THRESHOLD_S : GAIN_THRESHOLD_S;
      if ((gain as number) <= threshold) return shortcut ? this.strike("corner_cut", f) : this.close("no_advantage", f);
      e.reason = e.insideCut ? "corner_cut" : "gained";
      // Give it back: get the delta back up to where it was at the entry
      e.giveBackTarget = e.deltaAtEntry;
    } else {
      const lifted = e.minThrottle < NO_LIFT_THROTTLE || e.maxBrake > NO_LIFT_BRAKE;
      if (lifted && !e.insideCut) return shortcut ? this.strike("corner_cut", f) : this.close("no_advantage", f);
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
            text: wasOvertake ? t("game.trackLimits.positionHandedBack") : t("game.trackLimits.advantageGivenBack"),
            detail: t("game.trackLimits.noFurtherAction"),
            atMs: f.nowMs,
          }
        : { kind, text: t("game.trackLimits.trackLimits"), detail: t("game.trackLimits.noAdvantage"), atMs: f.nowMs };
    return { kind, lap };
  }

  /** A cut too big for the points meter: a time penalty at once */
  private immediatePenalty(e: Excursion, f: TrackLimitsFrame, seconds: number, shortcutM: number, gain: number | null): TrackLimitsEvent {
    const lap = e.startLap;
    const reason: TrackLimitsReason = e.insideCut || shortcutM >= 1.5 ? "corner_cut" : "gained";
    this.exc = null;
    this.totalStrikes++;
    this.penalties++;
    this.penaltyS += seconds;
    this.message = {
      kind: "penalty",
      text: t("game.trackLimits.timePenalty", { seconds: seconds.toFixed(1) }),
      detail:
        gain !== null && gain >= 0.5
          ? t("game.trackLimits.limitsGained", { seconds: gain.toFixed(1) })
          : shortcutM >= 1.5
            ? t("game.trackLimits.limitsCutMetres", { metres: String(Math.round(shortcutM)) })
            : t("game.trackLimits.limitsMajorCut"),
      atMs: f.nowMs,
    };
    return { kind: "penalty", reason, penaltyS: seconds, lap };
  }

  private strike(reason: TrackLimitsReason, f: TrackLimitsFrame): TrackLimitsEvent {
    const lap = this.exc?.startLap ?? f.lapCount;
    const excPoints = this.exc?.points ?? 0;
    const placesGained = this.exc?.placesGained ?? 0;
    this.exc = null;
    this.totalStrikes++;
    const why = t("game.trackLimits.why", { reason });
    if (this.session === "practice") {
      this.message = { kind: "lap_invalid", text: t("game.trackLimits.limitsDeleted"), detail: why, atMs: f.nowMs };
      return { kind: "lap_invalid", reason, lap };
    }
    if (reason === "illegal_overtake") {
      const seconds = this.laddered && placesGained > 1 ? 10 : REPEAT_PENALTY_S;
      this.penalties++;
      this.penaltyS += seconds;
      this.message = {
        kind: "penalty",
        text: t("game.trackLimits.timePenalty", { seconds: seconds.toFixed(1) }),
        detail: why,
        atMs: f.nowMs,
      };
      return { kind: "penalty", reason, penaltyS: seconds, lap };
    }
    if (this.laddered) {
      return this.addPoints(this.rules.scoring === "four_strike" ? 1 : Math.max(0.25, excPoints), reason, why, f, lap);
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
        text: t("game.trackLimits.timePenalty", { seconds: seconds.toFixed(1) }),
        detail: t("game.trackLimits.limitsWhy", { reason }),
        atMs: f.nowMs,
      };
      return { kind: "penalty", reason, penaltyS: seconds, lap };
    }
    this.message = {
      kind: "warning",
      text: t("game.trackLimits.warningCount", { count: this.warnings, max: STRIKES_PER_PENALTY }),
      detail: why,
      atMs: f.nowMs,
    };
    return { kind: "warning", reason, lap };
  }

  /** "2.75 pts", "3 strikes" */
  private pointsText(): string {
    if (this.rules.scoring !== "four_strike") return t("game.trackLimits.points", { points: this.points.toFixed(2) });
    return t("game.trackLimits.strikes", { count: Math.round(this.points) });
  }

  /** The points ladder: a strike's points, and the step they reach (black-and-white flag, +5 s, +10 s, disqualified) */
  private addPoints(pts: number, reason: TrackLimitsReason, why: string, f: TrackLimitsFrame, lap: number): TrackLimitsEvent {
    const A = this.rules.pointsAllowed;
    this.points = Math.round((this.points + pts) * 4) / 4;
    let seconds = 0;
    while (this.steps < 3 && this.points >= (this.steps + 1) * A - 1e-9) {
      this.steps++;
      if (this.steps <= LADDER_PENALTIES_S.length) seconds += LADDER_PENALTIES_S[this.steps - 1];
    }
    if (this.steps >= 3) {
      this.dq = true;
      this.penaltyS += seconds;
      this.message = { kind: "disqualified", text: t("game.trackLimits.disqualified"), detail: this.pointsText(), atMs: f.nowMs };
      return { kind: "disqualified", reason, penaltyS: seconds || undefined, lap };
    }
    if (seconds > 0) {
      this.penalties++;
      this.limitPenalties++;
      this.penaltyS += seconds;
      this.message = {
        kind: "penalty",
        text: t("game.trackLimits.timePenalty", { seconds: seconds.toFixed(1) }),
        detail: t("game.trackLimits.limitsPoints", { points: this.pointsText() }),
        atMs: f.nowMs,
      };
      return { kind: "penalty", reason, penaltyS: seconds, lap };
    }
    if (this.points >= (this.steps + 1) * A - 1 - 1e-9 && this.flaggedStep !== this.steps) {
      this.flaggedStep = this.steps;
      this.message = {
        kind: "final_warning",
        text: t("game.trackLimits.blackWhiteFlag"),
        detail:
          this.steps < LADDER_PENALTIES_S.length
            ? t("game.trackLimits.nextPenalty", { why, seconds: String(LADDER_PENALTIES_S[this.steps]) })
            : t("game.trackLimits.nextDisqualification", { why }),
        atMs: f.nowMs,
      };
      return { kind: "warning", reason, lap };
    }
    this.message = {
      kind: "warning",
      text: t("game.trackLimits.warning"),
      detail: t("game.trackLimits.warningDetail", { why, points: this.pointsText() }),
      atMs: f.nowMs,
    };
    return { kind: "warning", reason, lap };
  }
}
