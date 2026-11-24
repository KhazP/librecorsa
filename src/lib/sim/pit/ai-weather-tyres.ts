/**
 * The AI field's tyre calls as the weather changes, in a race with a pit lane (the stop itself: ai-pit.ts). Modelled on
 * how a real field meets a passing shower, not on any code:
 *
 *  - A call reads the racing line's water (`WeatherState.lineWaterMm`), the measure the player's automatic tyre choice
 *    reads (`recommendedCompound`), and its thresholds: intermediates past `LOW_GRIP_DECLARED_MM`, full wets past
 *    1.1 mm. Coming off them waits longer, so a line hovering at a threshold does not bring the field in and out:
 *    back onto slicks under 0.09 mm, from full wets back to intermediates under 0.8 mm. The wet-tyre model's slick ⇄
 *    intermediate crossover (both grip the same at 0.113 mm) lies inside that band, so a car between the thresholds
 *    loses little on either tyre; full wets go on where intermediates start to aquaplane at speed (they fall behind
 *    from 1.0 mm at 216 km/h) and come off where intermediates grip better through the corners.
 *  - Each driver's thresholds sit a little either side (`nerve`, up to 12 %; every driver's band still holds the
 *    crossover): a bold one stays out on slicks longer into a shower and goes back onto them sooner as it dries.
 *  - A call stands a few seconds before the car is told to come in, and the cars are told in running order, the leader
 *    first and each place a few seconds after the one ahead (with a little spread of its own). Then one car at a time
 *    through the pit entry (`pitEntryOpen`): one that reaches it too soon after the last one in stays out another lap,
 *    and goes in at the next unless it is side by side with another.
 *  - No weather stop for a while after any stop (`MIN_STINT_LAPS` laps or `MIN_STINT_S`), nor on the last lap.
 *
 * Pure (no three.js) and deterministic: each driver's spread is drawn from the race's seed and their code.
 */
import type { TireCompound } from "@/types/f1";
import { hashString, seededRng } from "@/lib/sim/ai-tuning";
import { LOW_GRIP_DECLARED_MM } from "@/lib/sim/wet-tyres";

/** The line's water (mm) that calls for intermediates, and that sends a car on them back onto slicks */
export const INTER_ON_MM = LOW_GRIP_DECLARED_MM;
export const INTER_OFF_MM = 0.09;
/** ... that calls for full wets, and that sends a car on them back onto intermediates */
export const WET_ON_MM = 1.1;
export const WET_OFF_MM = 0.8;
/** A driver's thresholds sit up to this share either side of the field's (`nerve` ±1) */
export const NERVE_SPREAD = 0.12;
/** A call stands this long before the leader is told to come in (s) */
export const CALL_CONFIRM_S = 6;
/** Each place further down the running order is told this much later (s) */
export const POSITION_STAGGER_S = 3;
/** And a spread of the driver's own on top, under a place's stagger so the order holds (s) */
export const CALL_JITTER_S = 2;
/** Cars into the pit lane at least this far apart (s); one turned away before, only nose to tail, never side by side */
export const ENTRY_GAP_S = 3;
export const ENTRY_MIN_S = 0.6;
/** A car counts as turned away once this long has passed since (s): from its next time round, not the same pass */
const WAITED_AFTER_S = 10;
/** No weather stop within this many laps of a stop, or this long, whichever comes first */
export const MIN_STINT_LAPS = 2;
export const MIN_STINT_S = 150;
/** Laps still to run (the one under way included) for a weather stop to be worth making */
export const MIN_LAPS_LEFT = 2;

export type TyreKind = "slick" | "intermediate" | "wet";

/** Intermediates and full wets are their own kinds; every other compound is a slick */
export const tyreKind = (c: TireCompound): TyreKind => (c === "intermediate" || c === "wet" ? c : "slick");

export interface WeatherTyreThresholds {
  interOnMm: number;
  interOffMm: number;
  wetOnMm: number;
  wetOffMm: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** A driver's thresholds for their `nerve` (-1 cautious … 1 bold; 0 the field's own) */
export function weatherTyreThresholds(nerve = 0): WeatherTyreThresholds {
  const k = 1 + NERVE_SPREAD * clamp(Number.isFinite(nerve) ? nerve : 0, -1, 1);
  return { interOnMm: INTER_ON_MM * k, interOffMm: INTER_OFF_MM * k, wetOnMm: WET_ON_MM * k, wetOffMm: WET_OFF_MM * k };
}

/** The kind of tyre `lineWaterMm` on the racing line calls for, from the kind a car is set on (the hysteresis) */
export function weatherTyreKind(lineWaterMm: number, from: TyreKind, th: WeatherTyreThresholds = weatherTyreThresholds()): TyreKind {
  const w = lineWaterMm > 0 ? lineWaterMm : 0;
  if (from === "slick") return w > th.wetOnMm ? "wet" : w > th.interOnMm ? "intermediate" : "slick";
  if (from === "intermediate") return w > th.wetOnMm ? "wet" : w < th.interOffMm ? "slick" : "intermediate";
  return w < th.interOffMm ? "slick" : w < th.wetOffMm ? "intermediate" : "wet";
}

/** How long after a car's call it is told to come in (s): `rank` its place in the running order (0 leading) */
export function weatherCallDelayS(rank: number, jitter01: number): number {
  return CALL_CONFIRM_S + Math.max(0, rank) * POSITION_STAGGER_S + clamp(jitter01, 0, 1) * CALL_JITTER_S;
}

/** Long enough on these tyres for another weather stop: `MIN_STINT_LAPS` laps since the last stop, or `MIN_STINT_S` */
export function stintLongEnough(sinceStopS: number, lapsSinceStop: number): boolean {
  return lapsSinceStop >= MIN_STINT_LAPS || sinceStopS >= MIN_STINT_S;
}

/**
 * Whether a car may turn into the pit lane now, `lastEntryS` the race time the last car turned in: one at a time,
 * `ENTRY_GAP_S` apart. A car already turned away once (`waited`) goes in unless it would be side by side
 * (`ENTRY_MIN_S`), so none stays out more than a lap for it; `lastChance`, a stop it cannot make later (on its last
 * lap), goes in regardless
 */
export function pitEntryOpen(nowS: number, lastEntryS: number, waited = false, lastChance = false): boolean {
  return lastChance || !(nowS - lastEntryS < (waited ? ENTRY_MIN_S : ENTRY_GAP_S));
}

/** A car as the weather's tyre call sees it */
export interface WeatherTyreCar {
  /** The driver's code (the key of their spread) */
  id: string;
  /** The tyres on the car now */
  compound: TireCompound;
  /** Its place in the running order (0 leading) */
  rank: number;
  lapsDone: number;
  /** Laps still to run, the one under way included */
  lapsLeft: number;
  /** Out on the road racing: not in the pit lane, finished or out of the race */
  racing: boolean;
}

export interface WeatherTyreCall {
  /** The tyres the car has settled on for the conditions (in the dry, the slick it runs) */
  compound: TireCompound;
  /** Another kind of tyre than it has on */
  change: boolean;
  /** A stop for them is due now: the call has stood its time, its turn has come, its stint is long enough, laps remain */
  due: boolean;
}

interface CarState {
  nerve: number;
  jitter: number;
  th: WeatherTyreThresholds;
  /** The kind it has settled on (null until it is first seen), and since when (race time, s) */
  kind: TyreKind | null;
  sinceS: number;
  /** The slick it runs in the dry, to go back onto */
  slick: TireCompound;
  /** Its last stop: race time and laps done then */
  stopS: number;
  stopLaps: number;
}

/** The rain tyre a kind fits, or the car's own slick */
const compoundOf = (kind: TyreKind, slick: TireCompound): TireCompound => (kind === "slick" ? slick : kind);

/** Every AI car's tyre call through a race, and the pit entry they share */
export class AiWeatherTyres {
  private readonly cars = new Map<string, CarState>();
  private seed = 0;
  /** Race time the last car turned into the pit lane (s), and when each car turned away since was first turned away */
  private lastEntryS = -Infinity;
  private readonly waited = new Map<string, number>();

  /** A new race: every driver's spread drawn afresh from the race's seed */
  reset(seed: number): void {
    this.seed = seed >>> 0;
    this.cars.clear();
    this.lastEntryS = -Infinity;
    this.waited.clear();
  }

  private state(id: string, fitted: TireCompound): CarState {
    let s = this.cars.get(id);
    if (!s) {
      const rng = seededRng((this.seed ^ hashString(id) ^ 0x2f6b9d13) >>> 0);
      const nerve = rng() * 2 - 1;
      s = {
        nerve,
        jitter: rng(),
        th: weatherTyreThresholds(nerve),
        kind: null,
        sinceS: 0,
        slick: tyreKind(fitted) === "slick" ? fitted : "medium",
        stopS: -Infinity,
        stopLaps: -Infinity,
      };
      this.cars.set(id, s);
    }
    return s;
  }

  /** A driver's nerve (-1 cautious … 1 bold) */
  nerveOf(id: string): number {
    return this.state(id, "medium").nerve;
  }

  /** The call for one car now, `lineWaterMm` the racing line's water */
  update(nowS: number, lineWaterMm: number, car: WeatherTyreCar): WeatherTyreCall {
    const s = this.state(car.id, car.compound);
    const fitted = tyreKind(car.compound);
    if (fitted === "slick") s.slick = car.compound;
    // First seen: settled on what it has on (a session starts on the right tyres)
    if (s.kind === null) {
      s.kind = fitted;
      s.sinceS = nowS;
    }
    const next = weatherTyreKind(lineWaterMm, s.kind, s.th);
    if (next !== s.kind) {
      s.kind = next;
      s.sinceS = nowS;
    }
    const change = s.kind !== fitted;
    const due =
      change &&
      car.racing &&
      car.lapsLeft >= MIN_LAPS_LEFT &&
      nowS - s.sinceS >= weatherCallDelayS(car.rank, s.jitter) &&
      stintLongEnough(nowS - s.stopS, car.lapsDone - s.stopLaps);
    return { compound: compoundOf(s.kind, s.slick), change, due };
  }

  /**
   * The tyres a car fits at any stop: the kind it has settled on for the conditions; null while it has none (it has
   * not been seen yet, or the conditions ask for the kind it has on: the stop's own choice of slick stands)
   */
  stopCompound(id: string, fitted: TireCompound): TireCompound | null {
    const s = this.cars.get(id);
    if (!s || s.kind === null || s.kind === tyreKind(fitted)) return null;
    return compoundOf(s.kind, s.slick);
  }

  /** A car's stop was made (`fitted` the tyres it left on): no weather stop again for a while */
  noteStop(id: string, nowS: number, lapsDone: number, fitted: TireCompound): void {
    const s = this.state(id, fitted);
    s.stopS = nowS;
    s.stopLaps = lapsDone;
    // Settled on what went on: a call for another kind starts its own wait
    if (s.kind !== tyreKind(fitted)) {
      s.kind = tyreKind(fitted);
      s.sinceS = nowS;
    }
    if (tyreKind(fitted) === "slick") s.slick = fitted;
  }

  /** Whether car `id` may turn into the pit lane at `nowS` (`pitEntryOpen`) */
  entryOpen(id: string, nowS: number, lastChance = false): boolean {
    // Turned away on an earlier pass (the turn-off is a moment's driving, a lap far longer than this)
    const turnedAt = this.waited.get(id);
    const waited = turnedAt !== undefined && nowS - turnedAt > WAITED_AFTER_S;
    return pitEntryOpen(nowS, this.lastEntryS, waited, lastChance);
  }

  /** Car `id` reached the pit entry and was turned away (`entryOpen` false): next time round it goes in */
  turnedAway(id: string, nowS: number): void {
    if (!this.waited.has(id)) this.waited.set(id, nowS);
  }

  /** Car `id` turned into the pit lane */
  noteEntry(id: string, nowS: number): void {
    this.lastEntryS = nowS;
    this.waited.delete(id);
  }

  /** The race went back to `nowS` (a flashback): nothing it recorded lies after it */
  rewind(nowS: number): void {
    if (this.lastEntryS > nowS) this.lastEntryS = -Infinity;
    for (const s of this.cars.values()) {
      if (s.stopS > nowS) {
        s.stopS = -Infinity;
        s.stopLaps = -Infinity;
      }
      if (s.sinceS > nowS) s.sinceS = nowS;
    }
    for (const [id, t] of this.waited) if (t > nowS) this.waited.delete(id);
  }
}
