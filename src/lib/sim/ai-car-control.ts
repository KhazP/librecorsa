/**
 * An AI driver's hands when the car stops doing what the autopilot asks: a knock from another car or a barrier, a
 * slide past what a driver can catch, a spin, a stop, and the rejoin.
 *
 * The autopilot (F12026CarSim / F1Physics2026) is a 500 Hz yaw controller with no reaction time: left to itself it
 * catches every slide at once, so a punted AI car shrugged the hit off while the player's car spun. Here a knock
 * starts a human reaction time in which the driver holds the wheel and lifts; after it the autopilot gets the car
 * back only if it is still within the driver's catch (body slip and yaw-rate error), otherwise it is a spin: both feet
 * in until the car stops. A stopped car waits for a gap in the traffic behind, then rejoins slowly; a car facing the
 * wrong way turns round at walking pace; one that cannot (beached, pinned) is recovered by the marshals.
 *
 * `update` says, per frame, whether the autopilot drives or which inputs the field steps the car with instead.
 */
import type { ControlInputs } from '@/types/f1';

export type AiControlMode = 'racing' | 'startled' | 'spinning' | 'stopped' | 'rejoining' | 'retired';

/** What the car is doing, read by the field each frame */
export interface AiControlCarState {
  /** Body velocity (m/s): forward, + left */
  vxMs: number;
  vyMs: number;
  /** Yaw rate (rad/s, + right) */
  yawRateRadS: number;
  /** The road's own yaw rate here at this speed (speed × curvature, rad/s, + right) */
  roadYawRateRadS: number;
  /** Heading against the track direction (rad, wrapped to ±π) */
  headingErrRad: number;
  /** Offset from the centre of the road (m, + right) */
  lateralM: number;
  /** Steering −1..1 and pedals as last driven */
  steer: number;
  throttle: number;
  brake: number;
}

export interface AiControlOutput {
  /** The autopilot drives (the field sets the speed cap and line bias as usual) */
  autopilot: boolean;
  /** Otherwise the car is stepped with these */
  inputs: Partial<ControlInputs>;
  /** An extra speed cap for the autopilot (m/s): a rejoin at walking pace */
  speedCapMs: number;
}

/** Knock sizes that start a reaction (yaw rate change rad/s, lateral speed change m/s, barrier impact m/s) */
export const KNOCK_YAW_RADS = 0.18;
export const KNOCK_LATERAL_MS = 0.9;
export const KNOCK_WALL_MS = 4;
/** A slide this far past the line (body slip, rad) is a spin whatever the reaction: ~24° */
const SPIN_SLIP_RAD = 0.42;
/** Yaw rate beyond the road's that no driver gathers up (rad/s) */
const SPIN_YAW_ERR_RADS = 1.6;
/** Spinning cars brake to this speed before they count as stopped (m/s) */
const STOPPED_MS = 3;
/** Shortest wait at a standstill before the rejoin (s) */
const MIN_STOP_S = 1.2;
/** A rejoin starts at this speed cap and opens up over REJOIN_RAMP_S (m/s, s) */
const REJOIN_CAP_MS = 12;
const REJOIN_RAMP_S = 5;
/** Heading error past which the car turns round before it rejoins (rad, ~70°) */
const WRONG_WAY_RAD = 1.22;
/** ... and the error at which the turn is done and the autopilot takes the car back (rad, ~35°) */
const TURN_DONE_RAD = 0.6;
/** Speed a car turning round is held to (m/s): full lock and the throttle below it, off the throttle above */
const TURN_CAP_MS = 6;
/** Not moving / not turned round after this long: the marshals step in (s) */
const MARSHAL_AFTER_S = 9;
/** A driver who has just gathered the car up is already reacting: no new startle for this long (s) */
const RESETTLE_S = 0.4;

export class AiCarControl {
  public mode: AiControlMode = 'racing';
  private timerS = 0;
  /** Inputs held through the reaction time */
  private heldSteer = 0;
  private heldThrottle = 0;
  private heldBrake = 0;
  /** Seconds since the car last made progress in a stop / rejoin */
  private stuckS = 0;
  /** Turning round on the spot: from facing the wrong way until the car points down the road again */
  private turning = false;
  /** The lock it turns round on (−1 left, + 1 right), held for the whole turn; 0: not turning */
  private turnSteer = 0;
  /** The marshals are needed (the field moves the car when the road behind is clear) */
  public needsMarshal = false;
  /** Spins since the start */
  public spins = 0;
  /** Seconds since the driver last took the car back (a new knock within the settle time doesn't startle again) */
  private sinceRecoveredS = Infinity;
  private readonly out: AiControlOutput = { autopilot: true, inputs: {}, speedCapMs: Infinity };

  constructor(
    /** Reaction time of this driver (s) */
    public reactionS = 0.25,
    /** Body slip the driver still catches after the reaction (rad) */
    public catchSlipRad = 0.24
  ) {}

  public reset(): void {
    this.mode = 'racing';
    this.timerS = 0;
    this.stuckS = 0;
    this.turning = false;
    this.turnSteer = 0;
    this.needsMarshal = false;
    this.spins = 0;
    this.sinceRecoveredS = Infinity;
  }

  /** In the race, not out of it */
  get racing(): boolean {
    return this.mode === 'racing';
  }

  /** The driver is not in control of the car: a spin or a stop (race control may wave a yellow) */
  get incident(): boolean {
    return this.mode === 'spinning' || this.mode === 'stopped' || (this.mode === 'rejoining' && this.timerS < 2);
  }

  /** A knock: a contact or a barrier hit. Starts the reaction time if the driver is racing; `strong`: a big one */
  public knock(state: AiControlCarState, strong = false): void {
    // Just after gathering the car up the driver is already reacting: only a strong knock startles again
    if (this.mode !== 'racing' || (this.sinceRecoveredS < RESETTLE_S && !strong)) return;
    this.mode = 'startled';
    this.timerS = this.reactionS;
    this.heldSteer = state.steer;
    // A driver lifts on a hit; a braking driver keeps braking
    this.heldThrottle = Math.min(state.throttle, 0.3);
    this.heldBrake = state.brake;
  }

  /** Out of the race (terminal damage): the car is braked to a stop and stays */
  public retire(): void {
    this.mode = 'retired';
  }

  /** Stalled while racing (pinned, beached): wait at a standstill, then rejoin as after a spin */
  public stall(): void {
    if (this.mode !== 'racing') return;
    this.mode = 'stopped';
    this.timerS = 0;
    this.stuckS = 0;
  }

  /** Called once the marshals moved the car: it rejoins from where it was put */
  public marshalled(): void {
    this.needsMarshal = false;
    this.mode = 'rejoining';
    this.timerS = 0;
    this.stuckS = 0;
  }

  /**
   * One frame. `clearBehind`: no car is coming up on this stretch within a few seconds (the field's call), so a
   * stopped car may go.
   */
  public update(dt: number, s: AiControlCarState, clearBehind: boolean): AiControlOutput {
    const out = this.out;
    out.autopilot = true;
    out.speedCapMs = Infinity;
    const speed = Math.hypot(s.vxMs, s.vyMs);
    const slip = speed > 5 ? Math.abs(Math.atan2(s.vyMs, Math.max(0.1, Math.abs(s.vxMs)))) + (s.vxMs < 0 ? Math.PI / 2 : 0) : 0;
    const yawErr = Math.abs(s.yawRateRadS - s.roadYawRateRadS);

    this.sinceRecoveredS += dt;
    switch (this.mode) {
      case 'racing':
        // A slide no driver catches, knocked or not (the autopilot alone would gather up anything)
        if (speed > 12 && (slip > SPIN_SLIP_RAD || yawErr > SPIN_YAW_ERR_RADS)) this.startSpin();
        break;
      case 'startled':
        this.timerS -= dt;
        if (this.timerS <= 0) {
          if (slip < this.catchSlipRad && yawErr < 0.9 * SPIN_YAW_ERR_RADS) {
            this.mode = 'racing';
            this.sinceRecoveredS = 0;
          } else this.startSpin();
        } else if (slip > SPIN_SLIP_RAD * 1.3) {
          this.startSpin();
        }
        break;
      case 'spinning':
        // Gathered it up after all: a half spin that came back straight, still rolling forward
        if (speed > 15 && slip < 0.12 && Math.abs(s.headingErrRad) < 0.5 && yawErr < 0.4) {
          this.mode = 'racing';
          break;
        }
        if (speed < STOPPED_MS) {
          this.mode = 'stopped';
          this.timerS = 0;
          this.stuckS = 0;
        }
        break;
      case 'stopped':
        this.timerS += dt;
        if (this.timerS >= MIN_STOP_S && clearBehind) {
          this.mode = 'rejoining';
          this.timerS = 0;
          this.stuckS = 0;
        }
        break;
      case 'rejoining': {
        this.timerS += dt;
        const headingErr = Math.abs(s.headingErrRad);
        this.turning = headingErr > WRONG_WAY_RAD || (this.turning && headingErr > TURN_DONE_RAD);
        if (!this.turning) this.turnSteer = 0;
        const wrongWay = this.turning;
        // Progress: rolling and pointing the right way
        this.stuckS = speed < 1.5 || wrongWay ? this.stuckS + dt : 0;
        if (this.stuckS > MARSHAL_AFTER_S) this.needsMarshal = true;
        if (wrongWay) {
          // A spin turn, as a driver does it: full lock and the throttle, so a rear-driven car lights its tyres and
          // comes round within its own length (its turning circle is wider than most roads), and a front-driven one
          // pulls its nose round on its tight lock. Off the throttle above walking pace. A car facing back up the road
          // can come round either way: it swings its nose across the road, away from the edge it stands nearer; one
          // still facing down the road turns the short way
          this.timerS = 0;
          if (this.turnSteer === 0) {
            const backwards = headingErr > Math.PI / 2;
            this.turnSteer = backwards ? (s.lateralM > 0 ? 1 : -1) : s.headingErrRad > 0 ? 1 : -1;
          }
          out.autopilot = false;
          out.inputs = { throttle: speed < TURN_CAP_MS ? 1 : 0, brake: 0, analogSteer: this.turnSteer };
        } else {
          out.speedCapMs = REJOIN_CAP_MS + (this.timerS / REJOIN_RAMP_S) * 80;
          if (this.timerS > REJOIN_RAMP_S && speed > 20) this.mode = 'racing';
        }
        break;
      }
      case 'retired':
        break;
    }

    if (this.mode === 'startled') {
      out.autopilot = false;
      out.inputs = { throttle: this.heldThrottle, brake: this.heldBrake, analogSteer: this.heldSteer };
    } else if (this.mode === 'spinning' || this.mode === 'retired') {
      // Both feet in: locked wheels slide the car straight on rather than flicking it round again
      out.autopilot = false;
      out.inputs = { throttle: 0, brake: 1, analogSteer: 0 };
    } else if (this.mode === 'stopped') {
      out.autopilot = false;
      out.inputs = { throttle: 0, brake: 1, analogSteer: 0 };
    }
    return out;
  }

  private startSpin(): void {
    this.mode = 'spinning';
    this.spins++;
  }
}

/** A driver's reaction time and catch for an AI skill 0..100 and a seeded draw 0..1 */
export function aiControlTraits(skill: number, draw: number): { reactionS: number; catchSlipRad: number } {
  const k = Math.min(1, Math.max(0, skill / 100));
  return {
    // 0.36 s for a rookie to 0.17 s for an alien, ± 0.04 s per driver
    reactionS: 0.36 - 0.19 * k + (draw - 0.5) * 0.08,
    // ~10° to ~16°
    catchSlipRad: 0.17 + 0.11 * k,
  };
}
