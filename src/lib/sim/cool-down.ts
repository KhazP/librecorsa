/**
 * The cool-down lap: once the player's car takes the chequered flag, an automatic driver brings it round at a gentle
 * pace and the player's inputs are ignored, until the run starts over (a restart, leaving the race, anything else).
 * Where the autopilot cannot drive the car (stuck, off the road, a retired wreck) the car brakes gently to a stop.
 */
import type { ControlInputs } from '@/types/f1';
import type { SimulatorCar } from './simulator-car';

/** The cool-down's pace, as a fraction of the autopilot's own (racing) pace */
export const COOL_DOWN_PACE = 0.6;
/** Slower than this (m/s) for `STALL_S` on the autopilot: it is not getting the car round */
const STALL_MS = 3;
const STALL_S = 6;
/** Further than this past the road's edge (m) for `OFF_ROAD_S`: the autopilot has lost the car */
const OFF_ROAD_M = 3;
const OFF_ROAD_S = 4;
/** Brake pressure of the gentle stop (0..1) */
const STOP_BRAKE = 0.2;

/** off: racing (or no race); drive: the autopilot brings the car round; stop: the car brakes to a halt */
export type CoolDownMode = 'off' | 'drive' | 'stop';

export interface CoolDownState {
  /** The player has taken the flag (or is out of the race) and the race is still on track */
  finished: boolean;
  /** The player's car is out of the race (a wreck): straight to the stop */
  retired: boolean;
  /** Half the road's width where the car is (m) */
  roadHalfWidthM: number;
}

const NO_INPUTS: Partial<ControlInputs> = {};
const STOP_INPUTS: Partial<ControlInputs> = { throttle: 0, brake: STOP_BRAKE };

export class CoolDown {
  mode: CoolDownMode = 'off';
  private stallS = 0;
  private offRoadS = 0;

  get active(): boolean {
    return this.mode !== 'off';
  }

  /**
   * Call every frame before the car is stepped. Engages on the player's flag, ends once the race is gone from track,
   * and keeps the car on the autopilot in between (a run reset or a car swap clears the flag on the car)
   */
  update(car: Pick<SimulatorCar, 'aiAutopilot' | 'vxMs' | 'lateralOffsetM'>, state: CoolDownState, dt: number): void {
    if (!state.finished) {
      if (this.active) this.end(car);
      return;
    }
    if (this.mode === 'off') {
      this.mode = state.retired ? 'stop' : 'drive';
      this.stallS = 0;
      this.offRoadS = 0;
    }
    if (this.mode === 'drive') {
      const speed = car.vxMs;
      this.stallS = Number.isFinite(speed) && Math.abs(speed) < STALL_MS ? this.stallS + dt : 0;
      const beyond = Math.abs(car.lateralOffsetM) - state.roadHalfWidthM;
      this.offRoadS = beyond > OFF_ROAD_M ? this.offRoadS + dt : 0;
      if (state.retired || !Number.isFinite(speed) || this.stallS > STALL_S || this.offRoadS > OFF_ROAD_S) this.mode = 'stop';
    }
    car.aiAutopilot = this.mode === 'drive';
  }

  /** What the car is stepped with while the cool-down has it (the player's inputs are ignored) */
  inputs(): Partial<ControlInputs> {
    return this.mode === 'stop' ? STOP_INPUTS : NO_INPUTS;
  }

  /** Factor on the autopilot's pace */
  get paceScale(): number {
    return this.mode === 'drive' ? COOL_DOWN_PACE : 1;
  }

  /** Hands the car back (the race left track, or the run started over) */
  end(car?: Pick<SimulatorCar, 'aiAutopilot'>): void {
    if (car && this.active) car.aiAutopilot = false;
    this.mode = 'off';
    this.stallS = 0;
    this.offRoadS = 0;
  }
}
