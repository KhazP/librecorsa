/**
 * The player's own car damage where the page judges it: an online race (the room's rules) and practice or a time trial
 * driven alone (the Practice damage setting). An AI race judges every car's, the player's too, in its field
 * (ai-opponents.ts).
 *
 * The car reports each barrier impact in its telemetry, with where on the car it landed; a car the sim worker drives
 * reports it the same way, its telemetry reaching the page. The damage is handed to the car's physics once per change,
 * so the worker is sent one message per hit, not one a frame.
 */
import type { CarTelemetry, PlayerDamageStatus } from "@/types/f1";
import type { SimulatorCar } from "./simulator-car";
import type { CarDamage, CarDamageSnapshot, DamageReport } from "./car-damage";

/** Half length and half width (m) the player's car is judged with outside an AI race */
export const PLAYER_HALF_LENGTH_M = 2.75;
export const PLAYER_HALF_WIDTH_M = 1.0;

/** Replay time (s) a Flashback can reach back: the replay buffer's 20 minutes, with a margin */
const HISTORY_S = 1260;

/** The damage for the HUD once something is broken; undefined while the car is as new or barely scratched */
export function damageStatusOf(d: CarDamage | null): PlayerDamageStatus | undefined {
  if (!d || d.pristine || !(d.overall >= 0.03 || d.terminal || d.punctured.some(Boolean))) return undefined;
  return {
    front: d.front,
    rear: d.rear,
    left: d.left,
    right: d.right,
    suspension: [...d.suspension],
    punctured: [...d.punctured],
    overall: d.overall,
    terminal: d.terminal,
  };
}

type DamagedCar = Pick<SimulatorCar, "setDamageEffects"> & { readonly telemetry: Pick<CarTelemetry, "f12026"> };

/** Feeds one car's barrier impacts into the player's damage and hands the damage to the car's physics */
export class PlayerDamageFeed {
  /** The car's newest barrier impact already counted (its own clock, which a grid start sets back to 0) */
  private lastWallAtMs: number | null = null;
  /** The damage, and its version, last handed to the car; null: hand it over on the next update */
  private appliedTo: CarDamage | null = null;
  private appliedVersion = -1;
  /** The practice damage at each replay time it changed, for Flashback */
  private readonly history: { timeS: number; version: number; snap: CarDamageSnapshot }[] = [];

  /** A new run or a new car: impacts the car reported before now are not counted, the damage is handed over again */
  restart(telemetry: Pick<CarTelemetry, "f12026">): void {
    this.lastWallAtMs = telemetry.f12026?.wallImpact?.atMs ?? null;
    this.appliedTo = null;
    this.appliedVersion = -1;
    this.history.length = 0;
  }

  /**
   * A frame no damage is judged in (Practice damage off, a room, qualifying): the car's impacts so far are passed over,
   * so damage switched on later does not count a hit from before
   */
  skip(telemetry: Pick<CarTelemetry, "f12026">): void {
    this.lastWallAtMs = telemetry.f12026?.wallImpact?.atMs ?? null;
  }

  /** One frame of driving: the car's newest barrier impact, once, into `damage`; the damage to the car when it changed */
  update(damage: CarDamage, car: DamagedCar): DamageReport | null {
    const wall = car.telemetry.f12026?.wallImpact;
    let report: DamageReport | null = null;
    // Not "newer than": the car's clock starts over with every grid start, so a hit after a restart can read earlier
    if (wall && wall.atMs !== this.lastWallAtMs) {
      this.lastWallAtMs = wall.atMs;
      report = damage.registerImpact({
        localX: wall.localX ?? 0,
        localZ: wall.localZ ?? PLAYER_HALF_LENGTH_M,
        speedMs: wall.speedMs,
        source: "wall",
      });
    }
    this.apply(damage, car);
    return report;
  }

  /** Hands the damage to the car if it changed since it last was (or is another car's damage) */
  apply(damage: CarDamage, car: Pick<SimulatorCar, "setDamageEffects">): void {
    if (damage === this.appliedTo && damage.version === this.appliedVersion) return;
    this.appliedTo = damage;
    this.appliedVersion = damage.version;
    car.setDamageEffects?.(damage.pristine ? null : damage.effects());
  }

  /** Keeps the damage as it is at this replay time when it changed, for Flashback */
  record(damage: CarDamage, timeS: number): void {
    const last = this.history[this.history.length - 1];
    if (last && last.version === damage.version) return;
    this.history.push({ timeS, version: damage.version, snap: damage.snapshot() });
    while (this.history.length > 2 && this.history[1].timeS < timeS - HISTORY_S) this.history.shift();
  }

  /** Flashback to this replay time: the damage as it was then (as new before anything was recorded) */
  rewind(damage: CarDamage, timeS: number): void {
    while (this.history.length > 0 && this.history[this.history.length - 1].timeS > timeS) this.history.pop();
    const at = this.history[this.history.length - 1];
    if (at) damage.restore(at.snap);
    else damage.reset();
    // The restored state is this replay time's entry: the next record adds only what changes after it
    if (at) at.version = damage.version;
  }
}
