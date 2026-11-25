/**
 * A reference lap of a car on the circuit loaded: the pace an AI driver at full pace has there, which the AI cars'
 * laps are taken from (qualifying.ts `aiQualifyingMs`). The circuit's own AI line check for the car's vehicle model
 * where it has a clean one, else a lone autopilot lap of an AI copy of the car (the light physics the AI field drives
 * on: the same lap for about two thirds of the work), driven a slice of page time at a time, as qualifying's reference
 * in drive-session.ts. The career's test day aims at a lap taken from it.
 *
 * The copy drives on the circuit's samples alone (no barrier mesh, as the AI worker's cars before their colliders):
 * the autopilot keeps to the road. A lap not done within ten minutes of driven time is given up (null). A lap driven
 * is kept for the session: the same car on the same circuit again has it at once.
 */
import { carById, type CarId } from "@/lib/cars/car-registry";
import { carPhysics } from "@/lib/cars/f1-mod-physics";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";
import { getActiveTrackData, getActiveTrackMetadata } from "@/lib/track-data";
import { AUTOPILOT_REF_BASE, LINE_CHECK_REF_BASE } from "./qualifying";
import type { SimulatorCar } from "./simulator-car";

/** The step the copy is driven at (s) */
const DT_S = 1 / 120;
/** A lap that takes longer than this is given up (s of driven time) */
const GIVE_UP_S = 600;
/** Laps driven this session (ms), by circuit and vehicle model */
const driven = new Map<string, number>();

export class ReferenceLap {
  /** The lap (ms) once known; null until then, or for good once `done` without one */
  lapMs: number | null = null;
  /** The reference's level against an AI driver at full pace (qualifying.ts) */
  readonly base: number;
  private car: SimulatorCar | null = null;
  private readonly key: string;
  private lap0 = 0;
  private simS = 0;

  constructor(readonly carId: CarId) {
    const vehicle = carPhysics(carId);
    const track = getActiveTrackData();
    this.key = `${track.id ?? ""}|${vehicle}`;
    const check = getActiveTrackMetadata().aiPlans?.[vehicle];
    if (check?.ok && check.physicsLapS > 0) {
      this.lapMs = Math.round(check.physicsLapS * 1000);
      this.base = LINE_CHECK_REF_BASE;
      return;
    }
    this.base = AUTOPILOT_REF_BASE;
    const known = driven.get(this.key);
    if (known) {
      this.lapMs = known;
      return;
    }
    try {
      const own = vehicleModelSpec(vehicle).createSim(track, null, carById(carId).bodyPlan);
      const car = own.createAiPeerCar?.() ?? own;
      // From the fair start a test day's laps take (`fairStart`): the line check's lap starts at the car's own pace too
      car.resetToStartGrid(true, 0, undefined, false, true);
      car.aiAutopilot = true;
      if (car.aiPaceScale !== undefined) car.aiPaceScale = 1;
      this.car = car;
      this.lap0 = car.telemetry.lapCount;
    } catch {
      // A car that cannot be driven alone here: no reference
      this.car = null;
    }
  }

  /** Known, or given up */
  get done(): boolean {
    return this.car === null;
  }

  /** Drives the lap on for up to `budgetMs` of page time; true once done */
  step(budgetMs: number): boolean {
    const car = this.car;
    if (!car) return true;
    const until = performance.now() + budgetMs;
    while (performance.now() < until) {
      car.step(DT_S, {});
      this.simS += DT_S;
      if (car.telemetry.lapCount > this.lap0) {
        const ms = car.telemetry.lastLapTimeMs ?? null;
        this.lapMs = ms !== null && ms > 0 ? ms : null;
        if (this.lapMs !== null) driven.set(this.key, this.lapMs);
      } else if (this.simS < GIVE_UP_S) {
        continue;
      }
      this.car = null;
      return true;
    }
    return false;
  }
}
