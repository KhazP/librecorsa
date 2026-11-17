/**
 * Manual race starts, as the F1 games run them: through the lights the player's car is held on the grid with its
 * engine live, the driver holds the clutch and the revs, and lets the clutch out when the lights go out. Let out
 * earlier, the car goes, and moving off its spot before the lights go out is a jump start, served as time at the flag.
 * Assisted starts keep the car frozen until the lights go out, as before.
 */
import type { VehicleModelId } from '@/types/f1';

export type RaceStartMode = 'assisted' | 'manual';
export const RACE_START_MODES: readonly RaceStartMode[] = ['assisted', 'manual'];
export const RACE_START_MODE_LABELS: Record<RaceStartMode, string> = { assisted: 'Assisted', manual: 'Manual' };
/** What each launch asks of the player, for the rows that set it */
export const RACE_START_MODE_HINTS: Record<RaceStartMode, string> = {
  assisted: 'The car waits on the grid and pulls away on the throttle at lights out',
  manual: 'Hold the clutch and the revs through the lights, let it go at lights out. Moving early is a jump start: +5 s',
};

/** Time added at the flag for a jump start (s) */
export const JUMP_START_PENALTY_S = 5;

/**
 * Engine speed to hold through the lights (rpm, from–to): letting the clutch out over about 0.3 s from inside it gets
 * the car to 100 m within 0.05 s of its best getaway. Measured with headless launches on flat ground with traction
 * control on (Semi-pro, 17 Nov 2026). With it off, a full-throttle release spins the 2026 Prototype and the MTR 496R
 * from any revs: the throttle has to come in with the clutch.
 */
export const LAUNCH_RPM: Readonly<Partial<Record<VehicleModelId, readonly [number, number]>>> = {
  'f12026-car': [9500, 11500],
  lc26: [7000, 8700],
  'amg-gt3': [4800, 6000],
  'mtr-496r': [4000, 5000],
  'lc-lmdh': [5500, 7500],
  'nissan-r33-jgtc': [3500, 5500],
  'nissan-r32-jtcc': [6300, 7500],
  'bmw-m1-procar': [3800, 4500],
  'vw-scirocco-gtx': [3000, 5000],
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

/** A car held on the grid goes when its clutch is let out past the bite in gear with the throttle up */
export function pullsAway(inGear: boolean, clutch: number, throttle: number): boolean {
  return inGear && clutch < BITE && throttle > DRIVE_AWAY_THROTTLE;
}

/**
 * Watches the car through the lights: moving off its spot while it should be held there is a jump start, kept until
 * the next race. Revving it with the clutch out is not one while the car has not moved.
 */
export class JumpStartWatch {
  private rolledM = 0;
  private jumpedNow = false;

  get jumped(): boolean {
    return this.jumpedNow;
  }

  reset(): void {
    this.rolledM = 0;
    this.jumpedNow = false;
  }

  /** One frame, with the car's speed (m/s). Returns true on the frame the start becomes a jump start */
  update(dtS: number, held: boolean, speedMs: number): boolean {
    if (this.jumpedNow || !held) {
      this.rolledM = 0;
      return false;
    }
    if (Number.isFinite(speedMs)) this.rolledM += Math.abs(speedMs) * Math.max(0, dtS);
    if (this.rolledM < JUMP_DISTANCE_M) return false;
    this.jumpedNow = true;
    return true;
  }
}
