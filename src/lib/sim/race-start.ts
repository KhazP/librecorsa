/**
 * Manual race starts, as the F1 games run them: through the lights the player's car is held on the grid with its
 * engine live, the driver holds the clutch and the revs, and lets the clutch out when the lights go out. Let out
 * earlier, the car goes, and moving off its spot before the lights go out is a jump start, served as time at the flag.
 * Assisted starts keep the car frozen until the lights go out, as before.
 */
import type { RollingFormationStage, VehicleModelId } from '@/types/f1';
import { text as t } from '@/lib/text';

export type RaceStartMode = 'assisted' | 'manual';
export const RACE_START_MODES: readonly RaceStartMode[] = ['assisted', 'manual'];
export const RACE_START_MODE_LABELS: Record<RaceStartMode, string> = {
  get assisted() { return t('game.raceStart.assisted'); },
  get manual() { return t('game.raceStart.manual'); },
};
/** What each launch asks of the player, for the rows that set it */
export const RACE_START_MODE_HINTS: Record<RaceStartMode, string> = {
  get assisted() { return t('game.raceStart.assistedHint'); },
  get manual() { return t('game.raceStart.manualHint'); },
};

/** Time added at the flag for a jump start (s) */
export const JUMP_START_PENALTY_S = 5;
/** … and for a big one: more than `BIG_JUMP_M` off the spot, or past a car ahead, before the lights go out (s) */
export const BIG_JUMP_START_PENALTY_S = 10;
export const BIG_JUMP_M = 2.5;

/**
 * Engine speed to hold through the lights (rpm, from–to): letting the clutch out over about 0.3 s from inside it gets
 * the car to 100 m within 0.05 s of its best getaway. Measured with headless launches on flat ground with traction
 * control on (Semi-pro, 17 Nov 2026). Above the window it is as good: from the limiter the 2026 Prototype, AMG GT3,
 * LMDh, M1 Procar and Liana reached 100 m within 0.06 s of their best, so the start cue asks only for the window's
 * floor. With traction control off, a full-throttle release spins the 2026 Prototype and the MTR 496R from any revs:
 * the throttle has to come in with the clutch.
 */
export const LAUNCH_RPM: Readonly<Partial<Record<VehicleModelId, readonly [number, number]>>> = {
  'f12026-car': [9500, 11500],
  lc26: [7000, 8700],
  lc25: [7200, 8800],
  'amg-gt3': [4800, 6000],
  'mtr-496r': [4000, 5000],
  'lc-lmdh': [5500, 7500],
  'nissan-r33-jgtc': [3500, 5500],
  'nissan-r32-jtcc': [6300, 7500],
  'bmw-m1-procar': [3800, 4500],
  'vw-scirocco-gtx': [3000, 5000],
  // The turbo needs revs to make boost, and from 5500 the cold slicks spin (TC off, as on semi-pro) [est]
  'porsche-934-rsr': [3500, 4500],
  // Above about 7000 rpm its rears spin up off the line, traction control on or off [est, flat-pad launches 26 Nov 2026]
  'f1-2007': [6500, 7500],
  liana: [4500, 6500],
};

/** The launch window for a car, or 55–75 % of its limiter for one without a measured window */
export function launchWindow(vehicle: VehicleModelId | string | undefined, limiterRpm: number): readonly [number, number] {
  const measured = vehicle ? LAUNCH_RPM[vehicle as VehicleModelId] : undefined;
  if (measured) return measured;
  const top = Number.isFinite(limiterRpm) && limiterRpm > 0 ? limiterRpm : 8000;
  return [Math.round(top * 0.55), Math.round(top * 0.75)];
}

/** Clutch travel (0..1, 1 = pressed) below which a clutch held in gear has started to take the car away */
const BITE = 0.5;
/** Throttle that takes the car away on a clutch let out: below it the car's anti-stall keeps it standing */
const DRIVE_AWAY_THROTTLE = 0.2;
/** Distance the car may roll on the grid before it counts as a jump start (m): a flick of the clutch does not */
const JUMP_DISTANCE_M = 0.5;

/** Speed (m/s) above which a car that has left its grid spot is driven on: the hold never brakes a moving car */
const HOLD_BELOW_MS = 1;

/** A car held on the grid goes when its clutch is let out past the bite in gear with the throttle up */
export function pullsAway(inGear: boolean, clutch: number, throttle: number): boolean {
  return inGear && clutch < BITE && throttle > DRIVE_AWAY_THROTTLE;
}

/**
 * Whether a car held on the grid is kept on its spot this step: standing, and not being driven away. A car that has
 * gone early is the driver's from then on: a lift does not stop it dead
 */
export function keptOnGrid(speedMs: number, inGear: boolean, clutch: number, throttle: number): boolean {
  return Math.abs(speedMs) < HOLD_BELOW_MS && !pullsAway(inGear, clutch, throttle);
}

/**
 * Watches the car through the lights: moving off its spot while it should be held there is a jump start, kept until
 * the next race. Revving it with the clutch out is not one while the car has not moved, nor is a car shaking on its
 * springs: what counts is how far it is up the road from where the hold began (the lap distance, when the frames give
 * it; else its speed added up, back and forth cancelling). A jump start is +5 s, or +10 s when the car is more than
 * `BIG_JUMP_M` up the road, or ahead of a car it started behind, by the time the lights go out; race control's call
 * comes then (`update` returns "verdict" once).
 */
export class JumpStartWatch {
  private movedM = 0;
  private spotM: number | null = null;
  private jumpedNow = false;
  private bigJump = false;
  private startPosition: number | null = null;
  private judged = false;

  get jumped(): boolean {
    return this.jumpedNow;
  }

  /** The time the jump start costs, as it stands (s); 0 without one */
  get penaltyS(): number {
    return !this.jumpedNow ? 0 : this.bigJump ? BIG_JUMP_START_PENALTY_S : JUMP_START_PENALTY_S;
  }

  /** A big jump start: past `BIG_JUMP_M`, or past a car ahead */
  get big(): boolean {
    return this.bigJump;
  }

  reset(): void {
    this.movedM = 0;
    this.spotM = null;
    this.jumpedNow = false;
    this.bigJump = false;
    this.startPosition = null;
    this.judged = false;
  }

  /**
   * One frame, with the car's speed (m/s, forwards +) and, in a race, its place (1 = leading) and lap distance (m) on
   * a lap `lapLengthM` long. Returns "jump" on the frame the start becomes a jump start, "verdict" on the first frame
   * after the lights with one to call, null otherwise
   */
  update(dtS: number, held: boolean, speedMs: number, position?: number, distM?: number, lapLengthM?: number): "jump" | "verdict" | null {
    if (!held) {
      this.movedM = 0;
      this.spotM = null;
      this.startPosition = null;
      if (this.jumpedNow && !this.judged) {
        this.judged = true;
        return "verdict";
      }
      return null;
    }
    if (this.startPosition === null && position !== undefined) this.startPosition = position;
    if (distM !== undefined && Number.isFinite(distM)) {
      this.spotM ??= distM;
      const L = lapLengthM && lapLengthM > 0 ? lapLengthM : Infinity;
      const d = distM - this.spotM;
      this.movedM = Number.isFinite(L) ? ((((d + L / 2) % L) + L) % L) - L / 2 : d;
    } else if (Number.isFinite(speedMs)) {
      this.movedM += speedMs * Math.max(0, dtS);
    }
    const ahead = Math.max(0, this.movedM);
    if (this.jumpedNow) {
      if (ahead >= BIG_JUMP_M || (position !== undefined && this.startPosition !== null && position < this.startPosition)) this.bigJump = true;
      return null;
    }
    if (ahead < JUMP_DISTANCE_M) return null;
    this.jumpedNow = true;
    if (ahead >= BIG_JUMP_M) this.bigJump = true;
    return "jump";
  }
}

/** Throttle travel that counts as the foot going down (0..1): the keyboard's ramp crosses it on the press's first frame */
const REACT_THROTTLE = 0.05;
/** Clutch travel off where it was held through the lights that counts as letting it out (0..1): the key's clutch,
 * which eases out over 0.4 s, crosses it on its second frame, long before the bite */
const REACT_CLUTCH = 0.1;
/** Past this the launch did not answer the lights (s): the driver looked away, or waited on purpose */
const REACTION_WINDOW_S = 3;

/**
 * The driver's reaction to the lights going out, as the F1 games show it: from the frame the lights go out to the
 * first frame the driver acts, in an assisted start the throttle going down, in a manual one the clutch starting to
 * come out (from where it was held through the lights; the bite comes later, by the clutch's own travel). There is
 * none when the driver had already acted as the lights went out (the throttle held through them, as the assisted
 * start's cue asks; the clutch not held in), and none past `REACTION_WINDOW_S`. The reading stands until the next
 * start's lights.
 */
export class ReactionWatch {
  private lit = false;
  private manual = false;
  /** The clutch as held on the last frame of the lights */
  private heldClutch = 0;
  /** The launch control was where it should be on the last frame of the lights */
  private ready = false;
  private sinceS: number | null = null;
  private reading: number | null = null;

  /** The last start's reaction (ms), or null */
  get ms(): number | null {
    return this.reading;
  }

  reset(): void {
    this.lit = false;
    this.manual = false;
    this.heldClutch = 0;
    this.ready = false;
    this.sinceS = null;
    this.reading = null;
  }

  private acting(throttle: number, clutch: number): boolean {
    return this.manual ? clutch < this.heldClutch - REACT_CLUTCH : throttle > REACT_THROTTLE;
  }

  /**
   * One frame: whether the start lights stand (a grid waiting for them too), whether the car is held for a manual
   * start (read while they stand), and the throttle and clutch (0..1, clutch 1 = pressed)
   */
  update(dtS: number, lightsLit: boolean, manual: boolean, throttle: number, clutch: number): void {
    if (lightsLit) {
      this.lit = true;
      this.manual = manual;
      this.heldClutch = clutch;
      this.ready = manual ? clutch >= BITE : throttle <= REACT_THROTTLE;
      this.sinceS = null;
      this.reading = null;
      return;
    }
    if (this.lit) {
      // The lights went out this frame: acting on it went before them
      this.lit = false;
      this.sinceS = this.ready && !this.acting(throttle, clutch) ? 0 : null;
      return;
    }
    if (this.sinceS === null) return;
    this.sinceS += Math.max(0, dtS);
    if (this.sinceS > REACTION_WINDOW_S) {
      this.sinceS = null;
      return;
    }
    if (this.acting(throttle, clutch)) {
      this.reading = Math.round(this.sinceS * 1000);
      this.sinceS = null;
    }
  }
}

/** Seconds before P1 reaches Start/Finish when "GET READY" appears */
export const ROLLING_READY_WINDOW_S = 4.2;
/** Seconds before P1 reaches Start/Finish when the 3-2-1 countdown begins */
export const ROLLING_COUNTDOWN_S = 3;

/**
 * Rolling-start formation speed limiter (Nuzzi AC style): lets the driver hold throttle and steer cleanly at formation
 * pace (~65 km/h) without jumping the start or surging, while preserving full driver braking. Smoothly tapers throttle
 * into the speed ceiling, cuts ignition/throttle slightly past it, and applies light proportional braking on downhill
 * overspeed so every car class (100 hp road car to 1000 hp F1) holds steady right at `limitMs`.
 */
export function applySpeedLimiter(
  speedMs: number,
  limitMs: number | undefined,
  throttle: number,
  brake: number
): { throttle: number; brake: number; ignitionCut: number; active: boolean } {
  if (limitMs === undefined || !Number.isFinite(limitMs) || limitMs <= 0) {
    return { throttle, brake, ignitionCut: 1, active: false };
  }
  const v = Number.isFinite(speedMs) ? speedMs : 0;
  // Taper throttle smoothly from 100 % at (limit - 1.35 m/s) down to 0 % at (limit + 0.45 m/s)
  const throttleCap = Math.max(0, Math.min(1, (limitMs + 0.45 - v) / 1.8));
  const outThrottle = Math.min(throttle, throttleCap);
  const overspeed = v - (limitMs + 0.45);
  const ignitionCut = overspeed >= 0 ? 0 : 1;
  // Gentle downhill / overspeed braking cap so the car never coasts past formation speed without locking wheels
  const limiterBrake = overspeed > 0 ? Math.min(0.5, overspeed * 0.25) : 0;
  return {
    throttle: outThrottle,
    brake: Math.max(brake, limiterBrake),
    ignitionCut,
    active: true,
  };
}

/**
 * Advances a rolling start's Nuzzi-style countdown state monotonically as P1 approaches Start/Finish:
 *   stageOrder 0: 'formation' (hold formation speed)
 *   stageOrder 1: 'ready'     ("GET READY", ~4.2–3.0 s out)
 *   stageOrder 2: 'countdown' (3, ~3.0–2.0 s out)
 *   stageOrder 3: 'countdown' (2, ~2.0–1.0 s out)
 *   stageOrder 4: 'countdown' (1, <= 1.0 s out until P1 crosses S/F)
 *
 * Clamping the approach speed around `paceMs` and latching `stageOrder >= prevStageOrder` ensures the countdown never
 * flickers backwards due to minor speed ripples.
 */
export function rollingFormationStep(
  distanceToLineM: number,
  leaderSpeedMs: number,
  paceMs: number,
  prevStageOrder = 0
): { stageOrder: number; stage: RollingFormationStage; countdown?: 3 | 2 | 1 } {
  const distM = Math.max(0, Number.isFinite(distanceToLineM) ? distanceToLineM : 0);
  const nominalPace = Math.max(6, Number.isFinite(paceMs) && paceMs > 0 ? paceMs : 65 / 3.6);
  const effSpeed = Math.max(nominalPace * 0.85, Math.min(nominalPace * 1.08, Number.isFinite(leaderSpeedMs) && leaderSpeedMs > 1 ? leaderSpeedMs : nominalPace));
  const etaS = distM / effSpeed;
  let desired = 0;
  if (etaS <= 1.0) desired = 4;
  else if (etaS <= 2.0) desired = 3;
  else if (etaS <= ROLLING_COUNTDOWN_S) desired = 2;
  else if (etaS <= ROLLING_READY_WINDOW_S) desired = 1;
  const stageOrder = Math.max(Math.max(0, Math.min(4, prevStageOrder)), desired);
  if (stageOrder >= 2) {
    const countdown = (5 - stageOrder) as 3 | 2 | 1;
    return { stageOrder, stage: 'countdown', countdown };
  }
  return { stageOrder, stage: stageOrder === 1 ? 'ready' : 'formation' };
}
