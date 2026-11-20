/**
 * Fixed-length ring of recent car poses, for instant replay. Frames are stored as copies and
 * played back interpolated at any session time inside the buffered window.
 */
import type { ReplayCarState, ReplayFrame } from "./lap-types";
import { nlerpQuat } from "./lap-recorder";

export interface ReplayBufferOptions {
  /** Seconds of history kept (default 120) */
  maxSeconds?: number;
  /** Frames per second stored (default 30) */
  hz?: number;
}

interface StoredFrame {
  t: number;
  cars: ReplayCarState[];
}

const DEFAULT_MAX_SECONDS = 120;
const DEFAULT_HZ = 30;
/** Tolerance so frames pushed exactly 1/hz apart are not dropped by float error (s) */
const TIME_EPS_S = 1e-6;

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** Interpolates two poses of the same car: scalars linear, orientation nlerp, gear from the earlier */
function blendCar(a: ReplayCarState, b: ReplayCarState, f: number): ReplayCarState {
  const q = nlerpQuat(a, b, f);
  return {
    id: a.id,
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    z: lerp(a.z, b.z, f),
    qx: q.qx,
    qy: q.qy,
    qz: q.qz,
    qw: q.qw,
    speedKmh: lerp(a.speedKmh, b.speedKmh, f),
    steer: lerp(a.steer, b.steer, f),
    throttle: lerp(a.throttle, b.throttle, f),
    brake: lerp(a.brake, b.brake, f),
    gear: a.gear,
    rpm: lerp(a.rpm, b.rpm, f),
    // `s` interpolates cleanly within a lap, and snaps to the nearer frame when wrapping across the start/finish line
    ...(a.s !== undefined && b.s !== undefined
      ? { s: Math.abs(b.s - a.s) < 500 ? lerp(a.s, b.s, f) : f < 0.5 ? a.s : b.s }
      : a.s !== undefined
        ? { s: a.s }
        : b.s !== undefined
          ? { s: b.s }
          : {}),
    ...(a.lap !== undefined || b.lap !== undefined ? { lap: f < 0.5 ? (a.lap ?? b.lap) : (b.lap ?? a.lap) } : {}),
    ...(a.distM !== undefined && b.distM !== undefined ? { distM: lerp(a.distM, b.distM, f) } : a.distM !== undefined ? { distM: a.distM } : {}),
  };
}

export class ReplayBuffer {
  private readonly capacity: number;
  private readonly minIntervalS: number;
  private readonly slots: (StoredFrame | undefined)[];
  /** Index of the oldest stored frame */
  private head = 0;
  private count = 0;

  constructor(opts: ReplayBufferOptions = {}) {
    const maxSeconds = opts.maxSeconds !== undefined && opts.maxSeconds > 0 ? opts.maxSeconds : DEFAULT_MAX_SECONDS;
    const hz = opts.hz !== undefined && opts.hz > 0 ? opts.hz : DEFAULT_HZ;
    this.capacity = Math.ceil(maxSeconds * hz) + 1;
    this.minIntervalS = 1 / hz;
    this.slots = new Array<StoredFrame | undefined>(this.capacity);
  }

  /** Records a frame (ignored if less than 1/hz after the previous one, or if tS goes backwards — then clear() first) */
  push(tS: number, cars: readonly ReplayCarState[]): void {
    if (!Number.isFinite(tS)) return;
    if (this.count > 0) {
      const last = this.endS;
      if (tS < last) return;
      if (tS - last < this.minIntervalS - TIME_EPS_S) return;
    }
    const idx = (this.head + this.count) % this.capacity;
    this.slots[idx] = { t: tS, cars: cars.map((c) => ({ ...c })) };
    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Full: the slot just written was the oldest frame, so the next one becomes the oldest
      this.head = (this.head + 1) % this.capacity;
    }
  }

  clear(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Drops every frame newer than tS (a flashback drives on from there: what was recorded after it never happened).
   * The frame at tS itself, or the one just before it, stays, so the replay picks up where the car was put back.
   */
  truncateAfter(tS: number): void {
    if (Number.isNaN(tS)) return;
    while (this.count > 0 && this.frame(this.count - 1).t > tS + TIME_EPS_S) {
      this.slots[(this.head + this.count - 1) % this.capacity] = undefined;
      this.count--;
    }
    if (this.count === 0) this.head = 0;
  }

  /** Session time of the oldest frame (NaN when empty) */
  get startS(): number {
    return this.count > 0 ? this.frame(0).t : NaN;
  }

  /** Session time of the newest frame (NaN when empty) */
  get endS(): number {
    return this.count > 0 ? this.frame(this.count - 1).t : NaN;
  }

  get durationS(): number {
    return this.count > 0 ? this.endS - this.startS : 0;
  }

  get frameCount(): number {
    return this.count;
  }

  /** Interpolated frame at tS clamped to [startS, endS]; null when empty. Cars present in both neighbouring frames are interpolated (nlerp quaternions as above, linear scalars, gear from the earlier frame); a car present in only one of them is taken from that frame as is. */
  frameAt(tS: number): ReplayFrame | null {
    if (this.count === 0 || Number.isNaN(tS)) return null;
    const tc = Math.min(Math.max(tS, this.startS), this.endS);

    // Largest stored index whose time is <= tc
    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.frame(mid).t <= tc) lo = mid;
      else hi = mid;
    }
    const a = this.frame(lo);
    const b = this.frame(hi);
    const span = b.t - a.t;
    const f = span > 0 ? Math.min(Math.max((tc - a.t) / span, 0), 1) : 0;

    const cars: ReplayCarState[] = [];
    for (const carA of a.cars) {
      const carB = b.cars.find((c) => c.id === carA.id);
      cars.push(carB ? blendCar(carA, carB, f) : { ...carA });
    }
    for (const carB of b.cars) {
      if (!a.cars.some((c) => c.id === carB.id)) cars.push({ ...carB });
    }
    return { t: tc, cars };
  }

  private frame(i: number): StoredFrame {
    const f = this.slots[(this.head + i) % this.capacity];
    // Indices passed here are always below count, so the slot is filled
    if (!f) throw new Error("ReplayBuffer: empty slot inside the stored range");
    return f;
  }
}

/** Session flags checked before allowing a Flashback / rewind */
export interface FlashbackGate {
  raceKind: "practice" | "ai" | "mp";
  /** True when the AI race carries fixed Weekly Challenge rules */
  weeklyChallengeRace?: boolean;
  /** True when the Weekly Challenge Time Trial is active */
  timeTrialActive?: boolean;
  /** True when a Qualifying session is active */
  qualifyingActive?: boolean;
  /** True when connected to or in an online multiplayer room / lobby or other players are on track */
  inOnlineRoom?: boolean;
  /** Phase of an active AI race ("lights" | "racing" | "finished") */
  aiRacePhase?: "lights" | "racing" | "finished";
}

/**
 * Flashback / rewind is allowed ONLY in solo Practice and regular AI races (while racing).
 * Strictly disallowed in online multiplayer rooms/races, Weekly Challenge (Time Trial or AI race),
 * Qualifying, and before/after an AI race's active racing phase.
 */
export function canFlashback(gate: FlashbackGate): boolean {
  if (gate.raceKind === "mp") return false;
  if (gate.inOnlineRoom) return false;
  if (gate.timeTrialActive) return false;
  if (gate.weeklyChallengeRace) return false;
  if (gate.qualifyingActive) return false;
  if (gate.raceKind === "ai" && gate.aiRacePhase && gate.aiRacePhase !== "racing") return false;
  return gate.raceKind === "practice" || gate.raceKind === "ai";
}

/** True when the player is in any multiplayer room/lobby or sharing the circuit with remote peers */
export function isInOnlineRoom(
  status: { mode: string; roomCode: string; state: string; connectedWebRtcPeers: number } | null | undefined,
  peersOnTrack: number
): boolean {
  if (peersOnTrack > 0) return true;
  if (!status) return false;
  if (status.connectedWebRtcPeers > 0) return true;
  if (status.roomCode.length > 0) return true;
  if (status.state === "signaling" || status.state === "connected") return true;
  return false;
}

/** Extracts a `restorePose` target (x, z, yawRad, speedMs, s) from a recorded replay car state */
export function poseFromReplayCar(car: ReplayCarState): {
  x: number;
  z: number;
  yawRad: number;
  speedMs: number;
  s?: number;
} {
  const len = Math.hypot(car.qx, car.qy, car.qz, car.qw) || 1;
  const qx = car.qx / len;
  const qy = car.qy / len;
  const qz = car.qz / len;
  const qw = car.qw / len;
  const fx = 2 * (qx * qz + qw * qy);
  const fz = 1 - 2 * (qx * qx + qy * qy);
  return {
    x: car.x,
    z: car.z,
    yawRad: Math.atan2(fx, fz),
    speedMs: Math.max(0, car.speedKmh / 3.6),
    ...(car.s !== undefined ? { s: car.s } : {}),
  };
}
