/**
 * Single-source-of-truth manual-clutch bite-point curve and engine stall / starter-crank / bump-start state machine,
 * shared by both `VehiclePhysics` (f12026-car / GT3 / road / classic / proto) and `F1Physics2026` (LC26).
 */

const RPM2RADS = Math.PI / 30;

/** Clutch pedal travel above which the clutch is fully open (free play near the floor) */
export const CLUTCH_BITE_START = 0.85;
/** Clutch pedal travel below which the clutch is fully locked (free play near the top) */
export const CLUTCH_BITE_LOCK = 0.18;
/** Seconds below stall speed before a manual-clutch engine stalls (s) */
export const ENGINE_STALL_DELAY_S = 0.12;
/** Seconds of starter crank (clutch held or in neutral) to restart a stalled engine (s) */
export const ENGINE_RESTART_CRANK_S = 0.45;

/**
 * Maps clutch pedal travel `pedal` (0 = released/engaged, 1 = floor/open) to normalized torque capacity (0..1)
 * with free play at both ends and a progressive friction bite zone between `CLUTCH_BITE_START` and `CLUTCH_BITE_LOCK`.
 */
export function clutchPedalEngagement(pedal: number): number {
  if (pedal >= CLUTCH_BITE_START) return 0;
  if (pedal <= CLUTCH_BITE_LOCK) return 1;
  const u = (CLUTCH_BITE_START - pedal) / (CLUTCH_BITE_START - CLUTCH_BITE_LOCK);
  // Progressive clamping curve: gentle, featherable torque in the lower bite zone, clamping firmly near lock
  return Math.pow(u, 2.2);
}

/** Stall threshold in rpm for an engine with the given idle rpm */
export function stallSpeedRpm(idleRpm: number): number {
  return Math.max(350, idleRpm * 0.42);
}

/** Stall threshold in rad/s for an engine with the given idle rpm */
export function stallSpeedRadS(idleRpm: number): number {
  return stallSpeedRpm(idleRpm) * RPM2RADS;
}

/**
 * Stateful manual-clutch stall, starter-crank and bump-start controller.
 * Designed for zero-allocation calls inside 500 Hz drivetrain substeps.
 */
export class StallController {
  private _stalled = false;
  private lowRpmTimerS = 0;
  private restartTimerS = 0;

  get stalled(): boolean {
    return this._stalled;
  }

  reset(): void {
    this._stalled = false;
    this.lowRpmTimerS = 0;
    this.restartTimerS = 0;
  }

  /**
   * Immediately recovers a stalled engine (e.g. when Auto clutch or Auto gearbox is switched back on)
   * and returns the updated `engineOmega` (rad/s).
   */
  recoverIfAuto(engineOmega: number, idleOmega: number): number {
    if (this._stalled) {
      this.reset();
      return Math.max(engineOmega, idleOmega);
    }
    this.lowRpmTimerS = 0;
    this.restartTimerS = 0;
    return engineOmega;
  }

  /**
   * Steps the manual-clutch stall / starter-crank / bump-start state machine by `dt` seconds.
   * All angular speeds are in rad/s. Returns the updated `engineOmega` (rad/s).
   */
  step(
    dt: number,
    inGear: boolean,
    engage: number,
    clutchPedal: number,
    throttle: number,
    engineOmega: number,
    wheelSideForwardOmega: number,
    idleOmega: number,
    stallOmega: number,
  ): number {
    if (this._stalled) {
      const disengaged = !inGear || clutchPedal >= CLUTCH_BITE_START;
      const bumpStart =
        inGear && engage > 0.4 && wheelSideForwardOmega >= idleOmega * 0.7 && engineOmega >= stallOmega * 1.1;
      if (bumpStart) {
        this.reset();
        return engineOmega;
      }
      if (disengaged) {
        const crankRate = throttle > 0.05 ? 2.0 : 1.0;
        this.restartTimerS += dt * crankRate;
        const crankTarget = idleOmega * 0.5;
        let nextOmega = engineOmega;
        if (nextOmega < crankTarget) {
          nextOmega = Math.min(crankTarget, nextOmega + (crankTarget / ENGINE_RESTART_CRANK_S) * dt * 1.5);
        }
        if (this.restartTimerS >= ENGINE_RESTART_CRANK_S) {
          this.reset();
          return Math.max(nextOmega, idleOmega);
        }
        return nextOmega;
      }
      this.restartTimerS = Math.max(0, this.restartTimerS - dt * 2);
      return engineOmega;
    }

    if (inGear && engage > 0.1 && engineOmega < stallOmega) {
      this.lowRpmTimerS += dt;
      if (this.lowRpmTimerS >= ENGINE_STALL_DELAY_S) {
        this._stalled = true;
        this.restartTimerS = 0;
      }
    } else {
      this.lowRpmTimerS = Math.max(0, this.lowRpmTimerS - dt * 2);
    }
    return engineOmega;
  }
}
