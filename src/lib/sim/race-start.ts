/**
 * Manual race starts, as the F1 games run them: through the lights the player's car is held on the grid with its
 * engine live, the driver holds the clutch and the revs, and lets the clutch out when the lights go out. Letting it out
 * in gear with the revs up before then is a jump start, served as time at the flag. Assisted starts keep the car frozen
 * until the lights go out, as before.
 */
import type { VehicleModelId } from '@/types/f1';

export type RaceStartMode = 'assisted' | 'manual';
export const RACE_START_MODES: readonly RaceStartMode[] = ['assisted', 'manual'];
export const RACE_START_MODE_LABELS: Record<RaceStartMode, string> = { assisted: 'Assisted', manual: 'Manual' };
/** What each launch asks of the player, for the rows that set it */
export const RACE_START_MODE_HINTS: Record<RaceStartMode, string> = {
  assisted: 'The car waits on the grid and pulls away on the throttle at lights out',
  manual: 'Hold the clutch and the revs through the lights, let it go at lights out. Early is a jump start: +5 s',
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
/** Throttle that counts as the revs being up */
const REVS_UP = 0.2;
/** How long the clutch may be out in gear with the revs up before it counts: a flick of the pedal does not */
const JUMP_AFTER_S = 0.2;

/**
 * Watches the clutch through the lights. In gear, with the clutch out past its bite and the throttle up for a moment
 * while the car is held, the car would have gone: a jump start, kept until the next race.
 */
export class JumpStartWatch {
  private outS = 0;
  private jumpedNow = false;

  get jumped(): boolean {
    return this.jumpedNow;
  }

  reset(): void {
    this.outS = 0;
    this.jumpedNow = false;
  }

  /** One frame. Returns true on the frame the start becomes a jump start */
  update(dtS: number, held: boolean, clutch: number, throttle: number, inGear: boolean): boolean {
    if (this.jumpedNow || !held) {
      this.outS = 0;
      return false;
    }
    const going = inGear && clutch < BITE && throttle > REVS_UP;
    this.outS = going ? this.outS + Math.max(0, dtS) : 0;
    if (this.outS < JUMP_AFTER_S) return false;
    this.jumpedNow = true;
    return true;
  }
}
