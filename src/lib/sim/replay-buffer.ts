/**
 * Compact chunked typed-array ring of car poses for instant & full-race replays (up to 20+ min).
 * Frames are allocated lazily in 512-frame chunks (zero GC pressure, ~64 B/car/frame) and played
 * back smoothly interpolated at any session time inside the buffered window.
 */
import * as THREE from "three";
import type { ReplayCarState, ReplayFrame } from "./lap-types";
import { nlerpQuat } from "./lap-recorder";

export interface ReplayBufferOptions {
  /** Seconds of history kept (default 1200 = 20 minutes) */
  maxSeconds?: number;
  /** Frames per second stored (default 20) */
  hz?: number;
}

export interface ReplayLapMarker {
  lap: number;
  timeS: number;
}

const DEFAULT_MAX_SECONDS = 1200;
const DEFAULT_HZ = 20;
/** Tolerance so frames pushed exactly 1/hz apart are not dropped by float error (s) */
const TIME_EPS_S = 1e-6;
/** 512 frames per lazily-allocated chunk (~25.6 s at 20 Hz) */
const CHUNK_SHIFT = 9;
const CHUNK_SIZE = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_SIZE - 1;
/** Float32 fields per car: x, y, z, qx, qy, qz, qw, speedKmh, steer, throttle, brake, gear, rpm, s, lap, distM */
const CAR_STRIDE = 16;

interface ReplayChunk {
  times: Float64Array;
  carCols: number;
  data: Float32Array;
}

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
    ...((f < 0.5 ? a.outLap : b.outLap) ? { outLap: true } : {}),
    ...(a.distM !== undefined && b.distM !== undefined
      ? { distM: lerp(a.distM, b.distM, f) }
      : a.distM !== undefined
        ? { distM: a.distM }
        : b.distM !== undefined
          ? { distM: b.distM }
          : {}),
  };
}

export class ReplayBuffer {
  private readonly capacity: number;
  private readonly minIntervalS: number;
  private readonly chunks = new Map<number, ReplayChunk>();
  private readonly carIdsList: string[] = [];
  private readonly carIdToCol = new Map<string, number>();
  /** Earliest and latest sequence indices where each car column had a valid sample */
  private readonly carFirstSeq: number[] = [];
  private readonly carLastSeq: number[] = [];
  /** Monotonic sequence index of the oldest stored frame */
  private headSeq = 0;
  /** Monotonic sequence index of the next frame to write (`count = tailSeq - headSeq`) */
  private tailSeq = 0;

  constructor(opts: ReplayBufferOptions = {}) {
    const maxSeconds = opts.maxSeconds !== undefined && opts.maxSeconds > 0 ? opts.maxSeconds : DEFAULT_MAX_SECONDS;
    const hz = opts.hz !== undefined && opts.hz > 0 ? opts.hz : DEFAULT_HZ;
    this.capacity = Math.ceil(maxSeconds * hz) + 1;
    this.minIntervalS = 1 / hz;
  }

  /** Records a frame (ignored if less than 1/hz after the previous one, or if tS goes backwards — then clear() first) */
  push(tS: number, cars: readonly ReplayCarState[]): void {
    if (!Number.isFinite(tS)) return;
    if (this.count > 0) {
      const last = this.endS;
      if (tS < last) return;
      if (tS - last < this.minIntervalS - TIME_EPS_S) return;
    }

    // Register any newly seen car IDs
    for (let i = 0; i < cars.length; i++) {
      const id = cars[i].id;
      if (!this.carIdToCol.has(id)) {
        this.carIdToCol.set(id, this.carIdsList.length);
        this.carIdsList.push(id);
        this.carFirstSeq.push(Number.POSITIVE_INFINITY);
        this.carLastSeq.push(-1);
      }
    }

    const seq = this.tailSeq;
    const key = seq >>> CHUNK_SHIFT;
    const off = seq & CHUNK_MASK;
    const neededCols = Math.max(1, this.carIdsList.length);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      const data = new Float32Array(CHUNK_SIZE * neededCols * CAR_STRIDE);
      data.fill(Number.NaN);
      chunk = { times: new Float64Array(CHUNK_SIZE), carCols: neededCols, data };
      this.chunks.set(key, chunk);
    } else if (chunk.carCols < neededCols) {
      // Grow just the active tail chunk when a new car joins mid-chunk
      const oldCols = chunk.carCols;
      const nextData = new Float32Array(CHUNK_SIZE * neededCols * CAR_STRIDE);
      nextData.fill(Number.NaN);
      const oldStride = oldCols * CAR_STRIDE;
      const newStride = neededCols * CAR_STRIDE;
      for (let f = 0; f < off; f++) {
        nextData.set(chunk.data.subarray(f * oldStride, f * oldStride + oldStride), f * newStride);
      }
      chunk.data = nextData;
      chunk.carCols = neededCols;
    } else {
      // Clear this frame slot in case a previous truncateAfter left stale car entries in it
      const frameStride = chunk.carCols * CAR_STRIDE;
      const start = off * frameStride;
      chunk.data.fill(Number.NaN, start, start + frameStride);
    }

    chunk.times[off] = tS;
    const frameBase = off * chunk.carCols * CAR_STRIDE;
    const data = chunk.data;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const col = this.carIdToCol.get(c.id)!;
      if (seq < this.carFirstSeq[col]) this.carFirstSeq[col] = seq;
      this.carLastSeq[col] = seq;
      const o = frameBase + col * CAR_STRIDE;
      data[o] = c.x;
      data[o + 1] = c.y;
      data[o + 2] = c.z;
      data[o + 3] = c.qx;
      data[o + 4] = c.qy;
      data[o + 5] = c.qz;
      data[o + 6] = c.qw;
      data[o + 7] = c.speedKmh;
      data[o + 8] = c.steer;
      data[o + 9] = c.throttle;
      data[o + 10] = c.brake;
      data[o + 11] = c.gear;
      data[o + 12] = c.rpm;
      data[o + 13] = c.s ?? Number.NaN;
      data[o + 14] = c.outLap ? -1 : (c.lap ?? Number.NaN);
      data[o + 15] = c.distM ?? Number.NaN;
    }

    this.tailSeq++;
    if (this.count > this.capacity) {
      const oldHeadKey = this.headSeq >>> CHUNK_SHIFT;
      this.headSeq++;
      const newHeadKey = this.headSeq >>> CHUNK_SHIFT;
      if (newHeadKey !== oldHeadKey) this.chunks.delete(oldHeadKey);
    }
  }

  clear(): void {
    this.chunks.clear();
    this.carIdsList.length = 0;
    this.carIdToCol.clear();
    this.carFirstSeq.length = 0;
    this.carLastSeq.length = 0;
    this.headSeq = 0;
    this.tailSeq = 0;
  }

  /**
   * Drops every frame newer than tS (a flashback drives on from there: what was recorded after it never happened).
   * The frame at tS itself, or the one just before it, stays, so the replay picks up where the car was put back.
   */
  truncateAfter(tS: number): void {
    if (Number.isNaN(tS)) return;
    while (this.count > 0 && this.timeAtIndex(this.count - 1) > tS + TIME_EPS_S) {
      this.tailSeq--;
    }
    if (this.count === 0) {
      this.chunks.clear();
      this.headSeq = 0;
      this.tailSeq = 0;
      for (let col = 0; col < this.carIdsList.length; col++) {
        this.carFirstSeq[col] = Number.POSITIVE_INFINITY;
        this.carLastSeq[col] = -1;
      }
    } else {
      const maxKey = (this.tailSeq - 1) >>> CHUNK_SHIFT;
      for (const k of this.chunks.keys()) {
        if (k > maxKey) this.chunks.delete(k);
      }
      // Refresh lastSeq for any car whose last recorded frame was truncated away
      for (let col = 0; col < this.carIdsList.length; col++) {
        if (this.carLastSeq[col] < this.tailSeq) continue;
        let found = -1;
        for (let seq = this.tailSeq - 1; seq >= this.headSeq; seq--) {
          const chunk = this.chunks.get(seq >>> CHUNK_SHIFT);
          if (!chunk || col >= chunk.carCols) continue;
          const off = seq & CHUNK_MASK;
          if (!Number.isNaN(chunk.data[(off * chunk.carCols + col) * CAR_STRIDE])) {
            found = seq;
            break;
          }
        }
        this.carLastSeq[col] = found;
        if (found < 0) this.carFirstSeq[col] = Number.POSITIVE_INFINITY;
      }
    }
  }

  private get count(): number {
    return this.tailSeq - this.headSeq;
  }

  /** Session time of the oldest frame (NaN when empty) */
  get startS(): number {
    return this.count > 0 ? this.timeAtIndex(0) : Number.NaN;
  }

  /** Session time of the newest frame (NaN when empty) */
  get endS(): number {
    return this.count > 0 ? this.timeAtIndex(this.count - 1) : Number.NaN;
  }

  get durationS(): number {
    return this.count > 0 ? this.endS - this.startS : 0;
  }

  get frameCount(): number {
    return this.count;
  }

  /** Ordered list of car IDs recorded anywhere in the retained window ("player" first when present) */
  carIds(): readonly string[] {
    if (this.count === 0) return [];
    const present: string[] = [];
    for (let col = 0; col < this.carIdsList.length; col++) {
      if (this.carLastSeq[col] >= this.headSeq && this.carFirstSeq[col] < this.tailSeq) {
        present.push(this.carIdsList[col]);
      }
    }
    present.sort((a, b) => (a === "player" ? -1 : b === "player" ? 1 : a.localeCompare(b)));
    return present;
  }

  /** Lap transitions for `"player"` across the buffered window, for timeline markers */
  lapMarkers(): ReplayLapMarker[] {
    const col = this.carIdToCol.get("player");
    if (col === undefined || this.count === 0) return [];
    const out: ReplayLapMarker[] = [];
    let lastLap = -1;
    // Scan in ~0.5 s steps to stay O(duration) and instant even for 20-minute replays
    const step = Math.max(1, Math.round(0.5 / this.minIntervalS));
    for (let i = 0; i < this.count; i += step) {
      const seq = this.headSeq + i;
      const chunk = this.chunks.get(seq >>> CHUNK_SHIFT);
      if (!chunk || col >= chunk.carCols) continue;
      const off = seq & CHUNK_MASK;
      const lap = chunk.data[off * chunk.carCols * CAR_STRIDE + col * CAR_STRIDE + 14];
      if (!Number.isNaN(lap) && lap > 0 && lap !== lastLap) {
        // Refine exact transition frame backwards inside the last step (including the first detected lap when i > 0)
        let exact = i;
        while (exact > Math.max(0, i - step)) {
          const pSeq = this.headSeq + exact - 1;
          const pChunk = this.chunks.get(pSeq >>> CHUNK_SHIFT);
          if (!pChunk || col >= pChunk.carCols) break;
          const pLap = pChunk.data[(pSeq & CHUNK_MASK) * pChunk.carCols * CAR_STRIDE + col * CAR_STRIDE + 14];
          if (pLap !== lap) break;
          exact--;
        }
        out.push({ lap: Math.round(lap), timeS: this.timeAtIndex(exact) });
        lastLap = lap;
      }
    }
    return out;
  }

  /**
   * Interpolated frame at tS clamped to [startS, endS]; null when empty.
   * Cars present in both neighbouring frames are interpolated (nlerp quaternions, linear scalars,
   * gear from the earlier frame); a car present in only one of them is taken from that frame as is.
   */
  frameAt(tS: number): ReplayFrame | null {
    if (this.count === 0 || Number.isNaN(tS)) return null;
    const tc = Math.min(Math.max(tS, this.startS), this.endS);

    const { lo, hi } = this.bracket(tc);
    const tA = this.timeAtIndex(lo);
    const tB = this.timeAtIndex(hi);
    const span = tB - tA;
    const f = span > 0 ? Math.min(Math.max((tc - tA) / span, 0), 1) : 0;

    const seqA = this.headSeq + lo;
    const seqB = this.headSeq + hi;
    const chunkA = this.chunks.get(seqA >>> CHUNK_SHIFT)!;
    const chunkB = this.chunks.get(seqB >>> CHUNK_SHIFT)!;
    const offA = seqA & CHUNK_MASK;
    const offB = seqB & CHUNK_MASK;
    const maxCols = Math.min(this.carIdsList.length, Math.max(chunkA.carCols, chunkB.carCols));
    const cars: ReplayCarState[] = [];

    for (let col = 0; col < maxCols; col++) {
      const carA = col < chunkA.carCols ? this.readCar(chunkA, offA, col) : null;
      const carB = col < chunkB.carCols ? this.readCar(chunkB, offB, col) : null;
      if (f <= 0) {
        if (carA) cars.push(carA);
      } else if (f >= 1) {
        if (carB) cars.push(carB);
      } else if (carA && carB) {
        cars.push(blendCar(carA, carB, f));
      } else if (carA) {
        cars.push(carA);
      } else if (carB) {
        cars.push(carB);
      }
    }
    return { t: tc, cars };
  }

  /** Finite-difference world velocity (m/s) of `carId` around `tS`, for chase & broadcast cameras during replay */
  velocityAt(tS: number, carId: string, out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    const col = this.carIdToCol.get(carId);
    if (col === undefined || this.count < 2 || Number.isNaN(tS)) return out;
    const tc = Math.min(Math.max(tS, this.startS), this.endS);
    const { lo, hi } = this.bracket(tc);
    const i0 = lo === hi && lo > 0 ? lo - 1 : lo;
    const i1 = lo === hi ? hi : hi;
    if (i0 === i1) return out;
    const dt = this.timeAtIndex(i1) - this.timeAtIndex(i0);
    if (!(dt > 1e-5)) return out;
    const seq0 = this.headSeq + i0;
    const seq1 = this.headSeq + i1;
    const c0 = this.chunks.get(seq0 >>> CHUNK_SHIFT);
    const c1 = this.chunks.get(seq1 >>> CHUNK_SHIFT);
    if (!c0 || !c1 || col >= c0.carCols || col >= c1.carCols) return out;
    const o0 = (seq0 & CHUNK_MASK) * c0.carCols * CAR_STRIDE + col * CAR_STRIDE;
    const o1 = (seq1 & CHUNK_MASK) * c1.carCols * CAR_STRIDE + col * CAR_STRIDE;
    const x0 = c0.data[o0];
    const x1 = c1.data[o1];
    if (Number.isNaN(x0) || Number.isNaN(x1)) return out;
    out.set(
      (x1 - x0) / dt,
      (c1.data[o1 + 1] - c0.data[o0 + 1]) / dt,
      (c1.data[o1 + 2] - c0.data[o0 + 2]) / dt
    );
    return out;
  }

  private bracket(tc: number): { lo: number; hi: number } {
    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.timeAtIndex(mid) <= tc) lo = mid;
      else hi = mid;
    }
    return { lo, hi };
  }

  private timeAtIndex(i: number): number {
    const seq = this.headSeq + i;
    const chunk = this.chunks.get(seq >>> CHUNK_SHIFT);
    if (!chunk) throw new Error("ReplayBuffer: empty chunk inside stored range");
    return chunk.times[seq & CHUNK_MASK];
  }

  private readCar(chunk: ReplayChunk, off: number, col: number): ReplayCarState | null {
    const o = off * chunk.carCols * CAR_STRIDE + col * CAR_STRIDE;
    const d = chunk.data;
    const x = d[o];
    if (Number.isNaN(x)) return null;
    const s = d[o + 13];
    const lap = d[o + 14];
    const distM = d[o + 15];
    return {
      id: this.carIdsList[col],
      x,
      y: d[o + 1],
      z: d[o + 2],
      qx: d[o + 3],
      qy: d[o + 4],
      qz: d[o + 5],
      qw: d[o + 6],
      speedKmh: d[o + 7],
      steer: d[o + 8],
      throttle: d[o + 9],
      brake: d[o + 10],
      gear: Math.round(d[o + 11]),
      rpm: d[o + 12],
      ...(Number.isNaN(s) ? {} : { s }),
      ...(Number.isNaN(lap) ? {} : lap < 0 ? { lap: 0, outLap: true } : { lap: Math.round(lap) }),
      ...(Number.isNaN(distM) ? {} : { distM }),
    };
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

/** Extracts a `restorePose` target (x, z, yawRad, speedMs, s, lapCount) from a recorded replay car state */
export function poseFromReplayCar(car: ReplayCarState): {
  x: number;
  z: number;
  yawRad: number;
  speedMs: number;
  s?: number;
  lapCount?: number;
  outLap?: boolean;
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
    ...(car.lap !== undefined ? { lapCount: car.lap, outLap: Boolean(car.outLap) } : {}),
  };
}
