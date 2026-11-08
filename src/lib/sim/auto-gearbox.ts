/**
 * The automatic gearbox's decisions, shared by both gearbox models (F1Physics2026's and VehiclePhysics'): when it
 * shifts by itself, and how a paddle shift overrides it. A manual shift with the auto box on holds the driver's gear
 * against the auto shift that would undo it — no auto downshift after a manual upshift while the driver keeps
 * accelerating, no auto upshift for a second after a manual downshift — and never against a shift the engine needs:
 * the rev limiter, lugging under the box's floor, or the brakes.
 */

/** Where and how a gearbox shifts by itself (engine rpm) */
export interface AutoShiftSchedule {
  upshiftRpm: number;
  /** The rev limiter: an upshift there is one the engine needs */
  limiterRpm: number;
  /** Under this road rpm, the brakes or a lift shift down */
  downshiftRpm: number;
  /** Under this road rpm the box shifts down whatever the pedals: the engine is lugging */
  lugRpm: number;
  /** A downshift only when the lower gear stays this far under the upshift point */
  downshiftMarginRpm: number;
  /** A brake pedal past this holds off upshifts */
  upshiftMaxBrake: number;
  /** Off the brakes, a throttle under this lets the box shift down (0: only the brakes or `downshiftHoldS` do) */
  liftThrottle: number;
  /** Off the brakes and on the throttle, the box shifts down this long after an upshift (absent: never by time) */
  downshiftHoldS?: number;
  /** Braking into a corner: down one gear at a time, the brake past `pedal`, `gapS` apart, while the lower gear's rpm stays under `rpm` */
  brakeDownshift?: { rpm: number; pedal: number; gapS: number };
}

/** The car as the auto box reads it this step (rpm are engine rpm) */
export interface AutoShiftInput {
  /** Current gear (the box only shifts forward gears, 1 and up) */
  gear: number;
  topGear: number;
  /** What the upshift goes by */
  engineRpm: number;
  /** Road speed in this gear */
  roadRpm: number;
  /** In the gear below, as the downshift goes by */
  lowerGearRpm: number;
  /** An upshift waits for the clutch to close */
  clutchClosed: boolean;
  throttle: number;
  brake: number;
  /** Since the last upshift / downshift (s; only read where the schedule asks for them) */
  sinceUpshiftS: number;
  sinceDownshiftS: number;
  /** At least one driven wheel carries load */
  drivenGrounded: boolean;
  /** The driven tyres spin up past their grip */
  drivenSpinning: boolean;
}

export const createAutoShiftInput = (): AutoShiftInput => ({
  gear: 1,
  topGear: 1,
  engineRpm: 0,
  roadRpm: 0,
  lowerGearRpm: 0,
  clutchClosed: true,
  throttle: 0,
  brake: 0,
  sinceUpshiftS: Infinity,
  sinceDownshiftS: Infinity,
  drivenGrounded: true,
  drivenSpinning: false,
});

/** How long a manual downshift holds off auto upshifts, and a manual upshift any auto downshift whatever the throttle (s) */
export const MANUAL_OVERRIDE_S = 1;
/** Under this the driver has lifted: past its second, a manual upshift's hold ends */
const LIFT_THROTTLE = 0.02;
/** Past this the driver brakes: a manual upshift's hold ends */
const BRAKING = 0.05;
/** On the limiter: the engine cuts there, so its revs bounce up to this far under it */
const LIMITER_BAND_RPM = 200;

/** The driver's last paddle shift with the auto box on, while it still holds the gear */
export class ManualShiftOverride {
  private dir: -1 | 0 | 1 = 0;
  private gear = 0;
  private timerS = 0;

  /** A manual shift in `dir` landed in `gear` */
  shifted(dir: -1 | 1, gear: number): void {
    this.dir = dir;
    this.gear = gear;
    this.timerS = MANUAL_OVERRIDE_S;
  }

  tick(dt: number): void {
    this.timerS = Math.max(0, this.timerS - dt);
  }

  /** Placement, teleport, restart: no shift to honour */
  clear(): void {
    this.dir = 0;
    this.gear = 0;
    this.timerS = 0;
  }

  /** Whether it holds back an auto shift in `dir` this step (`needed`: one the engine needs, never held) */
  holds(dir: -1 | 1, car: AutoShiftInput, needed: boolean): boolean {
    this.settle(car);
    if (needed || this.dir === 0 || dir === this.dir) return false;
    return dir < 0 || this.timerS > 0;
  }

  /** Ends once the gear has moved since, and for an upshift once the driver brakes or (past its second) lifts */
  private settle(car: AutoShiftInput): void {
    if (this.dir === 0) return;
    const ended =
      car.gear !== this.gear ||
      (this.dir > 0 ? car.brake > BRAKING || (this.timerS <= 0 && car.throttle < LIFT_THROTTLE) : this.timerS <= 0);
    if (ended) this.clear();
  }
}

/** The auto box's shift this step: +1 up, −1 down, 0 none */
export function autoShift(car: AutoShiftInput, schedule: AutoShiftSchedule, override: ManualShiftOverride): -1 | 0 | 1 {
  if (car.gear < 1) return 0;
  if (wantsUpshift(car, schedule)) {
    return override.holds(1, car, car.engineRpm >= schedule.limiterRpm - LIMITER_BAND_RPM) ? 0 : 1;
  }
  const down = downshiftWanted(car, schedule);
  if (down === null) return 0;
  return override.holds(-1, car, down.needed) ? 0 : -1;
}

function wantsUpshift(car: AutoShiftInput, s: AutoShiftSchedule): boolean {
  return (
    car.gear < car.topGear &&
    car.engineRpm >= s.upshiftRpm &&
    car.clutchClosed &&
    car.brake < s.upshiftMaxBrake &&
    // Not with the driven wheels in the air or spinning up, unless the road speed itself is at the upshift point
    car.drivenGrounded &&
    (!car.drivenSpinning || car.roadRpm >= s.upshiftRpm)
  );
}

/** A downshift the schedule asks for, and whether the engine needs it (braking or lugging); null for none */
function downshiftWanted(car: AutoShiftInput, s: AutoShiftSchedule): { needed: boolean } | null {
  if (car.gear <= 1) return null;
  const bd = s.brakeDownshift;
  if (bd && car.brake > bd.pedal && car.sinceDownshiftS > bd.gapS && car.lowerGearRpm < bd.rpm) return { needed: true };
  const braking = car.brake > BRAKING;
  const lugging = car.roadRpm < s.lugRpm;
  const offPower =
    braking ||
    car.throttle < s.liftThrottle ||
    (s.downshiftHoldS !== undefined && car.sinceUpshiftS > s.downshiftHoldS);
  if (!(lugging || (car.roadRpm < s.downshiftRpm && offPower))) return null;
  if (car.lowerGearRpm >= s.upshiftRpm - s.downshiftMarginRpm) return null;
  return { needed: braking || lugging };
}
