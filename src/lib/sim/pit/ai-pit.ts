/**
 * An AI car's pit stop, driven by its field (ai-opponents.ts) on the page or in the simulation worker alike.
 *
 * The AI's own driver cannot leave the road (its line is clamped to the track width), so a stop is a path the field
 * drives the car along with no forces (`SimulatorCar.driveInPitLane`): from where it turns off the road, down the lane at
 * the limit, sideways into its box, stopped while the crew works, back out to the lane and up to speed at the end of the
 * speed-limit zone, then handed back to its physics on the road past the rejoin point (`leavePitLane`). While it is in
 * the lane it neither touches other cars nor counts as a hazard: the field leaves it out of traffic, contacts and flags.
 *
 * When to stop (`AiPitStrategy`): the race's required stops spread through the race with a spread of its own per
 * driver; and a stop of its own when the tyres are worn out with laps to go, when the car is damaged but still running,
 * or when the weather calls for other tyres.
 *
 * Pure, no three.js.
 */
import type { TireCompound } from "@/types/f1";
import type { PitBox, PitLaneModel } from "./pit-lane";
import { tyreChangeS } from "./pit-stop";

/** The field turns the car off the road this far before the lane leaves it (m along the lap) */
export const AI_PIT_TAKEOVER_BEFORE_M = 35;
/** From this far before the turn-off the car moves over to the pit side of the road (m) */
export const AI_PIT_MOVE_OVER_M = 400;
/** Its offset from the lane at the turn-off eases out over this distance (m) */
const BLEND_IN_M = 45;
/** Sideways into the box over the last metres before it, and back out after it (m) */
const INTO_BOX_M = 22;
const OUT_OF_BOX_M = 20;
/** Braking into the box, pulling away, and accelerating out of the zone (m/s²) */
const BOX_DECEL = 4.5;
const PULL_AWAY = 4;
const EXIT_ACCEL = 7;
/** Braking from road speed down to the limit: at least, and at most (m/s²) */
const ENTRY_DECEL_MIN = 2;
const ENTRY_DECEL_MAX = 16;
/** Handed back to its physics this far past the rejoin point (m along the lane) */
const RELEASE_PAST_M = 25;
/** Speed it rejoins at, at most (m/s) */
const EXIT_SPEED_MS = 33;
/** Held at the end of the zone for traffic, at most (s) */
const MAX_HOLD_S = 8;
/** Worn tyres call a stop from this wear (share of the tread) with this many laps still to go */
const WEAR_STOP = 0.7;
const WEAR_STOP_LAPS_LEFT = 3;
/** Damage that calls a stop for repairs: from, and the damage the car retires at (ai-opponents.ts) */
const DAMAGE_STOP = 0.35;
const DAMAGE_STOP_LAPS_LEFT = 2;

export type AiPitPhase = "in" | "service" | "out";

export interface AiPitOrder {
  compound: TireCompound;
  /** Repair time on top of the tyres (s; 0: no repairs) */
  repairS: number;
}

export interface AiPitPose {
  x: number;
  z: number;
  yawRad: number;
  speedMs: number;
  laneM: number;
  offsetM: number;
}

const smooth = (t: number) => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

/** One car's way down the lane, from the turn-off to the release */
export class AiPitRun {
  phase: AiPitPhase = "in";
  laneM: number;
  speedMs: number;
  serviceLeftS = 0;
  serviceTotalS = 0;
  holdS = 0;
  readonly order: AiPitOrder;
  private readonly startLaneM: number;
  private readonly startOffsetM: number;
  private readonly entryDecel: number;
  private readonly limitMs: number;
  private readonly releaseM: number;
  private readonly pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  private readonly pt2 = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

  constructor(
    readonly lane: PitLaneModel,
    readonly box: PitBox | null,
    start: { x: number; z: number; speedMs: number },
    order: AiPitOrder,
    private readonly rng: () => number
  ) {
    this.order = order;
    // Only the lane's first stretch: further down it may pass close to the lap elsewhere (Monaco)
    const near = lane.nearestLaneM(start.x, start.z, lane.leaveM + 60);
    this.startLaneM = near.laneM;
    this.startOffsetM = near.offsetM;
    this.laneM = near.laneM;
    this.speedMs = Math.max(0, start.speedMs);
    this.limitMs = (lane.limitKmh / 3.6) * 0.97;
    const room = Math.max(8, lane.limitStartM - this.startLaneM - 5);
    this.entryDecel = Math.min(
      ENTRY_DECEL_MAX,
      Math.max(ENTRY_DECEL_MIN, (this.speedMs * this.speedMs - this.limitMs * this.limitMs) / (2 * room))
    );
    this.releaseM = Math.min(lane.lengthM - 1, lane.rejoinM + RELEASE_PAST_M);
  }

  /** Sideways offset from the lane's centreline at `m` (m, + right) */
  private offsetAt(m: number): number {
    let o = this.startOffsetM * (1 - smooth((m - this.startLaneM) / BLEND_IN_M));
    const b = this.box;
    if (b) {
      // A box far off the lane (Chang's are 16 m) is driven into over a longer run, so the car turns in, not sideways
      const into = Math.max(INTO_BOX_M, Math.abs(b.offsetM) * 2.4);
      const out = Math.max(OUT_OF_BOX_M, Math.abs(b.offsetM) * 2.2);
      if (this.phase === "out") {
        if (m >= b.laneM - 1) o += b.offsetM * (1 - smooth((m - b.laneM) / out));
      } else if (m >= b.laneM - into) {
        o += b.offsetM * smooth((m - (b.laneM - into)) / into);
      }
    }
    return o;
  }

  /** The pose at `m` along the lane: its point, offset sideways, facing the way the path goes */
  poseAt(m: number): AiPitPose {
    const off = this.offsetAt(m);
    const p = this.lane.pointAt(m, this.pt);
    const x = p.x - p.tz * off;
    const z = p.z + p.tx * off;
    const ahead = Math.min(this.lane.lengthM, m + 1.5);
    const back = ahead - 1.5;
    const q = this.lane.pointAt(ahead, this.pt2);
    const offA = this.offsetAt(ahead);
    const xa = q.x - q.tz * offA;
    const za = q.z + q.tx * offA;
    const pb = this.lane.pointAt(back, this.pt);
    const offB = this.offsetAt(back);
    const xb = pb.x - pb.tz * offB;
    const zb = pb.z + pb.tx * offB;
    return { x, z, yawRad: Math.atan2(xa - xb, za - zb), speedMs: this.speedMs, laneM: m, offsetM: off };
  }

  /**
   * One step down the lane. `exitClear`: no traffic close behind at the rejoin point (else the car waits at the end of
   * the zone). Returns the pose, `service` the frame the crew finishes (fit the tyres, repair), or `release` once the car
   * is back on the road
   */
  step(dt: number, exitClear: boolean): { pose: AiPitPose; serviced: boolean; release: boolean } {
    const lane = this.lane;
    let serviced = false;
    if (this.phase === "service") {
      this.serviceLeftS = Math.max(0, this.serviceLeftS - dt);
      if (this.serviceLeftS <= 0) {
        this.phase = "out";
        serviced = true;
      }
      return { pose: this.poseAt(this.laneM), serviced, release: false };
    }
    let v = this.speedMs;
    const m = this.laneM;
    if (this.phase === "in") {
      if (m < lane.limitStartM) v = Math.max(this.limitMs, v - this.entryDecel * dt);
      else v = Math.min(v, this.limitMs);
      const stopAt = this.box ? this.box.laneM : (lane.limitStartM + lane.limitEndM) / 2;
      const toStop = stopAt - m;
      v = Math.min(v, Math.sqrt(2 * BOX_DECEL * Math.max(0, toStop)));
      if (toStop <= 0.3 && v < 0.6) {
        this.laneM = stopAt;
        this.speedMs = 0;
        this.phase = "service";
        this.serviceTotalS = this.serviceLeftS = Math.max(tyreChangeS(this.rng), this.order.repairS);
        return { pose: this.poseAt(this.laneM), serviced, release: false };
      }
    } else {
      // Out: up to the limit in the zone, a wait for traffic at its end, then up to speed
      const zoneEnd = lane.limitEndM;
      if (m < zoneEnd - 5) v = Math.min(this.limitMs, v + PULL_AWAY * dt);
      else if (!exitClear && this.holdS < MAX_HOLD_S && m < zoneEnd) {
        this.holdS += dt;
        v = Math.max(0, Math.min(v, Math.sqrt(2 * BOX_DECEL * Math.max(0, zoneEnd - m))));
      } else v = Math.min(EXIT_SPEED_MS, v + EXIT_ACCEL * dt);
    }
    this.speedMs = v;
    this.laneM = Math.min(lane.lengthM, m + v * dt);
    const release = this.phase === "out" && this.laneM >= this.releaseM;
    return { pose: this.poseAt(this.laneM), serviced, release };
  }
}

/** Laps the race's required stops are planned for, spread through the race, with a spread of the driver's own */
export function plannedStopLaps(raceLaps: number, required: number, rng: () => number): number[] {
  if (required <= 0 || raceLaps < 3) return [];
  const out: number[] = [];
  const stint = raceLaps / (required + 1);
  for (let i = 1; i <= required; i++) {
    const jitter = Math.round((rng() - 0.5) * 0.5 * stint);
    let lap = Math.round(i * stint) + jitter;
    lap = Math.max(2, Math.min(raceLaps - 1, lap));
    while (out.includes(lap) && lap < raceLaps - 1) lap++;
    out.push(lap);
  }
  return out.sort((a, b) => a - b);
}

/**
 * A stop of its own, and why: damage to repair, or worn tyres, with laps still to go (`wear` the most worn tyre's
 * share of its tread, `damage` 0..1)
 */
export function ownStopWanted(wear: number, damage: number, lapsLeft: number, damageOn: boolean): "damage" | "tyres" | null {
  if (damageOn && damage >= DAMAGE_STOP && lapsLeft >= DAMAGE_STOP_LAPS_LEFT) return "damage";
  if (wear >= WEAR_STOP && lapsLeft >= WEAR_STOP_LAPS_LEFT) return "tyres";
  return null;
}

/**
 * Which box each car uses: the player (slot 0) one near the middle of the lane, the field's cars spread over the rest,
 * each its own while there are boxes enough (then they share, as team-mates do)
 */
export function pitBoxIndex(lane: PitLaneModel, slot: number, cars: number): number {
  const n = lane.boxes.length;
  if (n === 0) return 0;
  const count = Math.max(1, cars);
  const spots: number[] = [];
  for (let j = 0; j < count; j++) spots.push(count > 1 ? Math.round((j * (n - 1)) / (count - 1)) : Math.floor(n / 2));
  const mid = Math.floor(count / 2);
  const mine = spots[mid];
  if (slot === 0) return mine;
  // Never the player's box: with more cars than boxes the field shares the others
  const rest = spots.filter((v, j) => j !== mid && v !== mine);
  if (!rest.length) return n > 1 ? (mine + 1) % n : 0;
  return rest[(slot - 1) % rest.length];
}
