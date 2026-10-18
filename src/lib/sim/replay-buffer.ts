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
