/**
 * The player's pit stops, on the page (after PR #183 by adamikoo: its limiter, crew timings and box guidance, here on the
 * circuit's real lane, pit-lane.ts).
 *
 * - The car is in the lane when its physics says so (`CarTelemetry.pitLane`): only after turning in at the entry, off the
 *   racing surface. In the speed-limit zone the limiter comes on by itself and cannot be switched off; elsewhere the
 *   driver switches it with the Pit limiter key (as in iRacing, it holds the car at the limit, cutting the throttle and
 *   braking it down).
 * - Over the limit by more than `SPEEDING_MARGIN_KMH` for `SPEEDING_S` in the zone is one speeding call per visit
 *   (+5 s, race control's ledger).
 * - Stopped in the player's own box (`boxIndex`), the crew fits the chosen compound (fresh tyres) and repairs the damage
 *   when asked; the controls are held for the stop and given back when the crew is done.
 * - Stops made count towards the race's required stops (`stopsRequired`, career and long races).
 *
 * Fuel is not part of a stop: fuel use is off at every realism level (sim-realism.ts).
 */
import { TIRE_COMPOUNDS, type ControlInputs, type PitPhase, type PitStrategyState, type PitTelemetry, type TireCompound } from "@/types/f1";
import { PIT_LIMIT_KMH_DEFAULT, type PitLaneModel } from "./pit-lane";
import { applySpeedLimiter } from "../race-start";

/** Over the limit by more than this (km/h) ... */
const SPEEDING_MARGIN_KMH = 3;
/** ... for this long (s) in the zone is a speeding call */
const SPEEDING_S = 0.4;
/** Stopped means below this (km/h) */
const STOP_SPEED_KMH = 3.5;
/** In the box: along the lane and across it, within (m) */
const BOX_ALONG_M = 2.6;
const BOX_ACROSS_M = 2.0;
/** Called in: from this far before the lane leaves the road, the HUD shows the way in (m) */
const APPROACH_M = 600;
/** The released car's green light (s) */
const RELEASE_S = 2.5;

export interface PitFrame {
  dtS: number;
  /** The car's lane spot (`CarTelemetry.pitLane`) */
  lane: { laneM: number; offsetM: number; inLimitZone: boolean } | null | undefined;
  /** Lap position (m) */
  trackS: number;
  speedMs: number;
  /** Overall damage 0..1 and punctures */
  damage: number;
  punctures: number;
  /** The crew may start work: the race is on and the car is the player's */
  canService: boolean;
}

export interface PitStepResult {
  telemetry: PitTelemetry;
  /** A speeding call this frame */
  speeding: boolean;
  /** The crew finished this frame: fit `compound`, repair when `repair` */
  serviced: { compound: TireCompound; repair: boolean } | null;
}

/** A tyre change: most stops clean, some with a sticky wheel nut (s) */
export function tyreChangeS(rng: () => number = Math.random): number {
  const r = rng();
  const s = r < 0.75 ? 2.2 + rng() * 0.8 : r < 0.95 ? 3.0 + rng() * 1.0 : 4.0 + rng() * 1.2;
  return Math.round(s * 10) / 10;
}

/** Repair time for the damage (s): none below 3 % with no puncture */
export function repairS(damage: number, punctures: number): number {
  if (damage < 0.03 && punctures === 0) return 0;
  return Math.round(Math.min(14, 1.5 + damage * 9 + punctures * 1.5) * 10) / 10;
}

/** A car's compounds where none are given: every one but the super soft */
const BASE_COMPOUNDS: readonly TireCompound[] = TIRE_COMPOUNDS.filter((c) => c !== "supersoft");

export class PitStopManager {
  private phase: PitPhase = "track";
  private manualLimiter = false;
  private autoLimiter = false;
  private overS = 0;
  private calledThisVisit = false;
  private wasInLane = false;
  private releaseS = 0;
  private serviceLeftS = 0;
  private serviceTotalS = 0;
  private tyreSNow = 0;
  private repairSNow = 0;
  private speedingCount = 0;
  private stopsMade = 0;
  private servicedThisVisit = false;
  private readonly strategy: PitStrategyState;
  /** The player's box (index into `lane.boxes`) */
  boxIndex = 0;
  /** Stops the race requires */
  stopsRequired = 0;
  /** Pit stops are part of this session (an AI race or practice; not online) */
  enabled = true;

  constructor(
    readonly lane: PitLaneModel | null,
    compound: TireCompound,
    /** The compounds the crew has for the player's car now, softest first (`carTyreCompounds`) */
    private readonly compoundsNow: () => readonly TireCompound[] = () => BASE_COMPOUNDS
  ) {
    this.strategy = { nextCompound: compound, repairDamage: true, boxRequested: false };
  }

  get limitKmh(): number {
    return this.lane?.limitKmh ?? PIT_LIMIT_KMH_DEFAULT;
  }

  get box() {
    const boxes = this.lane?.boxes;
    return boxes && boxes.length ? boxes[Math.min(boxes.length - 1, Math.max(0, this.boxIndex))] : null;
  }

  get controlsLocked(): boolean {
    return this.phase === "servicing";
  }

  get limiterOn(): boolean {
    return this.autoLimiter || this.manualLimiter;
  }

  setStrategy(patch: Partial<PitStrategyState>): void {
    if (patch.nextCompound) this.strategy.nextCompound = patch.nextCompound;
    if (typeof patch.repairDamage === "boolean") this.strategy.repairDamage = patch.repairDamage;
    if (typeof patch.boxRequested === "boolean") this.strategy.boxRequested = patch.boxRequested;
  }

  /** The Pit limiter key: no effect in the zone, where it is on by itself */
  toggleLimiter(): void {
    if (!this.autoLimiter) this.manualLimiter = !this.manualLimiter;
  }

  /** Releases a manually engaged pit limiter (e.g. automatically at rolling-start green flag), leaving an active in-lane auto limiter intact */
  releaseManualLimiter(): void {
    this.manualLimiter = false;
  }

  /** A new run (restart, new race): the stops, calls and limiter start again; the crew's plan is kept */
  reset(compound?: TireCompound): void {
    this.phase = "track";
    this.manualLimiter = this.autoLimiter = false;
    this.overS = 0;
    this.calledThisVisit = this.wasInLane = this.servicedThisVisit = false;
    this.releaseS = this.serviceLeftS = this.serviceTotalS = this.tyreSNow = this.repairSNow = 0;
    this.speedingCount = 0;
    this.stopsMade = 0;
    this.strategy.boxRequested = false;
    if (compound) this.strategy.nextCompound = compound;
  }

  update(f: PitFrame): PitStepResult {
    const lane = this.lane;
    const speedKmh = Math.max(0, f.speedMs * 3.6);
    let speeding = false;
    let serviced: PitStepResult["serviced"] = null;
    if (this.releaseS > 0) this.releaseS = Math.max(0, this.releaseS - f.dtS);
    const spot = this.enabled && lane ? f.lane ?? null : null;
    if (!spot) {
      if (this.wasInLane) {
        // Out of the lane: the visit is over
        this.calledThisVisit = this.servicedThisVisit = false;
        this.wasInLane = false;
        this.manualLimiter = false;
      }
      this.autoLimiter = false;
      this.overS = 0;
      this.phase =
        this.enabled && lane && this.strategy.boxRequested && lane.besideLap(f.trackS, APPROACH_M)
          ? "approach"
          : "track";
      return { telemetry: this.telemetry(null, speedKmh, f), speeding, serviced };
    }
    this.wasInLane = true;
    this.autoLimiter = spot.inLimitZone;
    // Speeding in the zone
    if (spot.inLimitZone && speedKmh > this.limitKmh + SPEEDING_MARGIN_KMH) this.overS += f.dtS;
    else this.overS = 0;
    if (this.overS >= SPEEDING_S && !this.calledThisVisit) {
      this.calledThisVisit = true;
      this.speedingCount++;
      speeding = true;
    }
    const box = this.box;
    if (this.phase === "servicing") {
      this.serviceLeftS = Math.max(0, this.serviceLeftS - f.dtS);
      if (this.serviceLeftS <= 0) {
        serviced = { compound: this.strategy.nextCompound, repair: this.strategy.repairDamage && this.repairSNow > 0 };
        this.phase = "released";
        this.releaseS = RELEASE_S;
        this.servicedThisVisit = true;
        this.strategy.boxRequested = false;
        this.stopsMade++;
      }
    } else if (box && !this.servicedThisVisit) {
      const along = Math.abs(spot.laneM - box.laneM);
      const across = Math.abs(spot.offsetM - box.offsetM);
      const inBox = along <= BOX_ALONG_M && across <= BOX_ACROSS_M;
      if (inBox && speedKmh <= STOP_SPEED_KMH && f.canService) {
        this.tyreSNow = tyreChangeS();
        this.repairSNow = this.strategy.repairDamage ? repairS(f.damage, f.punctures) : 0;
        // Tyres and repairs go on at the same time; the longer job sets the stop
        this.serviceTotalS = Math.max(this.tyreSNow, this.repairSNow);
        this.serviceLeftS = this.serviceTotalS;
        this.phase = "servicing";
      } else {
        this.phase = inBox ? "box" : "lane";
      }
    } else {
      this.phase = this.releaseS > 0 ? "released" : "lane";
    }
    return { telemetry: this.telemetry(spot, speedKmh, f), speeding, serviced };
  }

  /**
   * The limiter on the driver's controls: at the limit the throttle is cut and the car braked down to it, below it
   * the throttle is eased so the car settles on it; held still while the crew works
   */
  filterInputs(inputs: ControlInputs, speedMs: number, overrideLimitMs?: number): void {
    if (this.phase === "servicing") {
      inputs.throttle = 0;
      inputs.brake = 1;
      inputs.steerLeft = 0;
      inputs.steerRight = 0;
      inputs.kbSteer = 0;
      inputs.analogSteer = undefined;
      inputs.padSteer = undefined;
      inputs.shiftUp = false;
      inputs.shiftDown = false;
      return;
    }
    if (!this.limiterOn) return;
    const limitMs = overrideLimitMs !== undefined && Number.isFinite(overrideLimitMs) && overrideLimitMs > 0 ? overrideLimitMs : this.limitKmh / 3.6;
    const lim = applySpeedLimiter(speedMs, limitMs, inputs.throttle, inputs.brake);
    inputs.throttle = lim.throttle;
    inputs.brake = lim.brake;
    if (speedMs >= limitMs - 1.35) inputs.manualOverride = false;
  }

  private telemetry(
    spot: { laneM: number; offsetM: number } | null,
    speedKmh: number,
    f: PitFrame
  ): PitTelemetry {
    const box = this.box;
    const toBoxM =
      spot && box && !this.servicedThisVisit && this.phase !== "servicing"
        ? Math.round((box.laneM - spot.laneM) * 10) / 10
        : null;
    return {
      phase: this.phase,
      limiterOn: this.limiterOn,
      limiterAuto: this.autoLimiter,
      limitKmh: this.limitKmh,
      overLimit: speedKmh > this.limitKmh + 0.6,
      speedingCount: this.speedingCount,
      toBoxM,
      boxSideM: spot && box ? Math.round((spot.offsetM - box.offsetM) * 100) / 100 : null,
      boxIndex: box?.index ?? 0,
      serviceLeftS: Math.round(this.serviceLeftS * 10) / 10,
      serviceTotalS: this.serviceTotalS,
      tyreS: this.phase === "servicing" ? this.tyreSNow : 0,
      repairS: this.phase === "servicing" ? this.repairSNow : this.strategy.repairDamage ? repairS(f.damage, f.punctures) : 0,
      damage: f.damage,
      strategy: { ...this.strategy },
      compounds: this.compoundsNow(),
      stopsMade: this.stopsMade,
      stopsRequired: this.stopsRequired,
    };
  }
}
