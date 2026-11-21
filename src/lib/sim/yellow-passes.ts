/**
 * Passing under a yellow flag: race control's call on the player's car.
 *
 * A pass is the player going from behind a car to ahead of it (race distance, laps included) while the player is
 * inside a yellow zone. Passing the car the flag is out for is no offence, nor is passing a car that has finished,
 * retired, is going the wrong way, is off the track or is crawling (`PassCar.exempt`): the field says which.
 *
 * Each offence is watched for `PASS_MONITOR_S` (a driver who lifts at once and lets the car back by is never
 * called), then the place has to be handed back within `GIVE_BACK_S`: the player back behind that car by
 * `RETURNED_GAP_M` for `RETURNED_HOLD_S`. Not handed back: +5 s, or +10 s under a double yellow or when more than one
 * place is owed. A car that drops out of the race meanwhile (retires, finishes) can no longer be given the place
 * back: no further action.
 *
 * No three.js and no DOM.
 */

export const PASS_MONITOR_S = 3;
export const GIVE_BACK_S = 15;
export const RETURNED_GAP_M = 1.5;
export const RETURNED_HOLD_S = 0.6;
export const YELLOW_PASS_PENALTY_S = 5;
export const DOUBLE_YELLOW_PASS_PENALTY_S = 10;

/** 0: green, 1: yellow, 2: double yellow */
export type YellowLevel = 0 | 1 | 2;

/** Another car, as race control sees it this frame */
export interface PassCar {
  code: string;
  /** Race distance (m, laps included) */
  distM: number;
  /** Passing it is no offence (the incident itself, finished, retired, wrong way, off, crawling) */
  exempt: boolean;
  /** Out of the race or finished: a place can no longer be handed back to it */
  gone: boolean;
}

export interface YellowPassEvent {
  kind: "order" | "returned" | "penalty" | "dropped";
  code: string;
  double: boolean;
  seconds?: number;
}

/** The place the player owes now, for the HUD */
export interface YellowGiveBack {
  code: string;
  double: boolean;
  /** Time left to hand it back (s; full while the pass is only watched) and the same as a share of the window */
  remainingS: number;
  progress: number;
}

interface Order {
  code: string;
  double: boolean;
  ageS: number;
  behindS: number;
}

export class YellowPassJudge {
  private readonly ahead = new Set<string>();
  private readonly orders: Order[] = [];
  private seeded = false;

  reset(): void {
    this.ahead.clear();
    this.orders.length = 0;
    this.seeded = false;
  }

  /**
   * Flashback rewind: drops hand-back orders triggered inside the rewound window (`ageS <= rewindS`) while keeping
   * orders that were already pending before the restored moment, and re-seeds `ahead` on the next frame so the
   * teleport itself never invents a pass.
   */
  rewind(rewindS: number): void {
    const dt = Math.max(0, rewindS);
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const o = this.orders[i];
      if (o.ageS <= dt) {
        this.orders.splice(i, 1);
      } else {
        o.ageS = Math.max(0, o.ageS - dt);
        o.behindS = 0;
      }
    }
    this.ahead.clear();
    this.seeded = false;
  }

  /** The place owed first, if any */
  get owed(): YellowGiveBack | null {
    const o = this.orders[0];
    if (!o) return null;
    const remainingS = Math.min(GIVE_BACK_S, Math.max(0, PASS_MONITOR_S + GIVE_BACK_S - o.ageS));
    return { code: o.code, double: o.double, remainingS, progress: remainingS / GIVE_BACK_S };
  }

  /**
   * One frame. `active`: the player is racing (not on the lights, the autopilot or after the flag): the cars ahead
   * are only followed meanwhile. Returns the calls made this frame
   */
  update(dtS: number, meDistM: number, cars: readonly PassCar[], level: YellowLevel, active: boolean): YellowPassEvent[] {
    const events: YellowPassEvent[] = [];
    const byCode = new Map(cars.map((c) => [c.code, c]));
    if (active && this.seeded) {
      for (const c of cars) {
        const wasAhead = this.ahead.has(c.code);
        if (wasAhead && c.distM < meDistM && level > 0 && !c.exempt && !this.orders.some((o) => o.code === c.code)) {
          this.orders.push({ code: c.code, double: level === 2, ageS: 0, behindS: 0 });
          events.push({ kind: "order", code: c.code, double: level === 2 });
        }
      }
    }
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const o = this.orders[i];
      const c = byCode.get(o.code);
      if (!c || c.gone) {
        this.orders.splice(i, 1);
        events.push({ kind: "dropped", code: o.code, double: o.double });
        continue;
      }
      if (!active) continue;
      o.ageS += dtS;
      o.behindS = c.distM >= meDistM + RETURNED_GAP_M ? o.behindS + dtS : 0;
      if (o.behindS >= RETURNED_HOLD_S) {
        this.orders.splice(i, 1);
        events.push({ kind: "returned", code: o.code, double: o.double });
      } else if (o.ageS >= PASS_MONITOR_S + GIVE_BACK_S) {
        const many = this.orders.length > 1;
        this.orders.splice(i, 1);
        const seconds = o.double || many ? DOUBLE_YELLOW_PASS_PENALTY_S : YELLOW_PASS_PENALTY_S;
        events.push({ kind: "penalty", code: o.code, double: o.double, seconds });
      }
    }
    this.ahead.clear();
    for (const c of cars) if (c.distM > meDistM) this.ahead.add(c.code);
    this.seeded = true;
    return events;
  }
}
