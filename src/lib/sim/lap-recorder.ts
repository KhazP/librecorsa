/**
 * Records the player's laps while driving: samples the car at a fixed rate, produces the lap
 * summary (deltas, sector and corner bests) and plays recorded laps back as ghosts.
 * Also validates untrusted recordings (imported files, downloads) before they are used.
 */
import type { CarTelemetry, VehicleModelId } from "@/types/f1";
import { LAP_SAMPLE_STRIDE } from "./lap-types";
import type { CornerStat, LapRecording, LapSample, LapSummaryData } from "./lap-types";

export interface LapRecorderTurn {
  number: number;
  name: string;
  /** Distance from the start/finish line along the lap (m) */
  sApprox: number;
}

export interface LapRecorderInput {
  telemetry: Pick<
    CarTelemetry,
    "lapCount" | "currentLapTimeMs" | "lastLapTimeMs" | "trackDistanceM" | "speedKmh" | "throttle" | "brake" | "steering" | "gear" | "offTrack" | "sectorTimesMs"
  >;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
}

export interface CompletedLap {
  recording: LapRecording;
  summary: LapSummaryData;
}

export interface LapRecorderOptions {
  trackLengthM: number;
  turns: LapRecorderTurn[];
  trackId: string;
  vehicle: VehicleModelId;
  /** Shown on the leaderboard: letters, 3 characters A-Z */
  driverName: string;
  driverCode: string;
  sampleHz?: number;
  personalBestMs?: number | null;
}

export interface QuatLike {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

const DEFAULT_SAMPLE_HZ = 20;
/** A lap must start within this time of the recorder being armed (ms) */
const START_GRACE_MS = 250;
/** Corner windows reach at most this far either side of the apex (m) */
const CORNER_HALF_WINDOW_M = 150;
const MIN_LAP_MS = 20_000;
const MAX_LAP_MS = 900_000;
const MAX_NUMBERS = 200_000;
const VEHICLES: readonly VehicleModelId[] = ["vf26", "f12026-car", "amg-gt3"];
const DRIVER_CODE_RE = /^[A-Z]{3}$/;

/** Rounds to `dp` decimals; non-finite input becomes 0 so stored samples are always finite */
function round(v: number, dp: number): number {
  if (!Number.isFinite(v)) return 0;
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

/** Driver names: no control characters or angle brackets, at most 16 characters */
function cleanDriverName(raw: string): string {
  return raw.replace(/[\x00-\x1f\x7f<>]/g, "").trim().slice(0, 16);
}

/** Shortest distance between two points on the closed lap (m) */
function lapDistance(a: number, b: number, lengthM: number): number {
  const d = (((a - b) % lengthM) + lengthM) % lengthM;
  return Math.min(d, lengthM - d);
}

/** Normalised lerp of two quaternions, taking the short way round */
export function nlerpQuat(a: QuatLike, b: QuatLike, f: number): QuatLike {
  let bx = b.qx;
  let by = b.qy;
  let bz = b.qz;
  let bw = b.qw;
  if (a.qx * bx + a.qy * by + a.qz * bz + a.qw * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const x = a.qx + (bx - a.qx) * f;
  const y = a.qy + (by - a.qy) * f;
  const z = a.qz + (bz - a.qz) * f;
  const w = a.qw + (bw - a.qw) * f;
  const len = Math.hypot(x, y, z, w);
  if (!(len > 1e-12)) return { qx: a.qx, qy: a.qy, qz: a.qz, qw: a.qw };
  return { qx: x / len, qy: y / len, qz: z / len, qw: w / len };
}

/** One stored sample row, in LAP_SAMPLE_FIELDS order */
function sampleRow(input: LapRecorderInput, tS: number): number[] {
  const t = input.telemetry;
  const p = input.position;
  const q = input.quaternion;
  return [
    round(tS, 3),
    round(t.trackDistanceM, 1),
    round(p.x, 2),
    round(p.y, 2),
    round(p.z, 2),
    round(q.x, 4),
    round(q.y, 4),
    round(q.z, 4),
    round(q.w, 4),
    round(t.speedKmh, 1),
    round(t.throttle, 2),
    round(t.brake, 2),
    round(t.steering, 3),
    round(t.gear, 0),
  ];
}

interface CornerWindow {
  turn: LapRecorderTurn;
  halfM: number;
}

export class LapRecorder {
  private readonly trackLengthM: number;
  private readonly trackId: string;
  private readonly sampleHz: number;
  private readonly period: number;
  /** Turns in track order, with the half-width of each corner window */
  private readonly corners: CornerWindow[];
  private vehicle: VehicleModelId;
  private driverName: string;
  private driverCode: string;
  private pb: number | null;
  /** Session bests from valid laps: sectors, and the best minimum speed per corner */
  private sessionSectorBest: [number | null, number | null, number | null] = [null, null, null];
  private sessionCornerBest: (number | null)[];
  private lastLapCount: number | null = null;
  private lastLapTimeSeen: number | null = null;
  /** True while the lap in progress was armed at its start */
  private recording = false;
  private valid = true;
  private lastSampleT = -Infinity;
  private rows: number[][] = [];

  constructor(opts: LapRecorderOptions) {
    this.trackLengthM = opts.trackLengthM;
    this.trackId = opts.trackId;
    this.sampleHz = opts.sampleHz ?? DEFAULT_SAMPLE_HZ;
    this.period = 1 / this.sampleHz;
    this.vehicle = opts.vehicle;
    this.driverName = cleanDriverName(opts.driverName);
    this.driverCode = opts.driverCode;
    this.pb = opts.personalBestMs ?? null;

    const sorted = [...opts.turns].sort((a, b) => a.sApprox - b.sApprox);
    const n = sorted.length;
    this.corners = sorted.map((turn, k) => {
      if (n < 2) return { turn, halfM: Math.min(CORNER_HALF_WINDOW_M, opts.trackLengthM / 2) };
      const prev = sorted[(k - 1 + n) % n];
      const next = sorted[(k + 1) % n];
      const nearest = Math.min(
        lapDistance(turn.sApprox, prev.sApprox, opts.trackLengthM),
        lapDistance(turn.sApprox, next.sApprox, opts.trackLengthM)
      );
      return { turn, halfM: Math.min(CORNER_HALF_WINDOW_M, nearest / 2) };
    });
    this.sessionCornerBest = this.corners.map(() => null);
  }

  /** Change car / driver / known personal best (a car change also clears session bests) */
  setContext(ctx: Partial<Pick<LapRecorderOptions, "vehicle" | "driverName" | "driverCode" | "personalBestMs">>): void {
    if (ctx.vehicle !== undefined && ctx.vehicle !== this.vehicle) {
      this.vehicle = ctx.vehicle;
      this.sessionSectorBest = [null, null, null];
      this.sessionCornerBest = this.corners.map(() => null);
    }
    if (ctx.driverName !== undefined) this.driverName = cleanDriverName(ctx.driverName);
    if (ctx.driverCode !== undefined) this.driverCode = ctx.driverCode;
    if (ctx.personalBestMs !== undefined) this.pb = ctx.personalBestMs;
  }

  /** Discard the lap in progress (restart, teleport): the next lap only counts once the line is crossed */
  reset(): void {
    this.lastLapCount = null;
    this.lastLapTimeSeen = null;
    this.abandon();
  }

  /** Call every frame while driving; returns the lap once one is completed, else null */
  update(input: LapRecorderInput): CompletedLap | null {
    const t = input.telemetry;
    const prevCount = this.lastLapCount;
    const prevLapTimeMs = this.lastLapTimeSeen;
    this.lastLapCount = t.lapCount;
    this.lastLapTimeSeen = t.lastLapTimeMs;

    // First update since construction or reset: the lap is armed only if it is near its start
    if (prevCount === null) {
      if (t.currentLapTimeMs < START_GRACE_MS) this.beginLap();
      this.collect(input);
      return null;
    }

    const step = t.lapCount - prevCount;
    if (step < 0 || step > 1) {
      // Count went backwards or jumped: treat as a reset and re-arm on the next crossing
      this.abandon();
      return null;
    }
    if (step === 0) {
      this.collect(input);
      return null;
    }

    // Line crossed: close the lap in progress, then start the next one armed
    let completed: CompletedLap | null = null;
    const lapMs = t.lastLapTimeMs;
    if (this.recording && lapMs !== null && Number.isFinite(lapMs) && lapMs > 0 && lapMs !== prevLapTimeMs) {
      completed = this.finishLap(input, lapMs, prevCount);
    }
    this.beginLap();
    this.collect(input);
    return completed;
  }

  get personalBestMs(): number | null {
    return this.pb;
  }

  private beginLap(): void {
    this.recording = true;
    this.valid = true;
    this.lastSampleT = -Infinity;
    this.rows = [];
  }

  private abandon(): void {
    this.recording = false;
    this.valid = true;
    this.lastSampleT = -Infinity;
    this.rows = [];
  }

  /** Adds this update to the lap in progress: validity and a sample when one is due */
  private collect(input: LapRecorderInput): void {
    if (!this.recording) return;
    if (input.telemetry.offTrack) this.valid = false;
    const tS = input.telemetry.currentLapTimeMs / 1000;
    if (!Number.isFinite(tS)) return;
    if (tS >= this.lastSampleT + this.period - 1e-9) {
      this.rows.push(sampleRow(input, tS));
      this.lastSampleT = tS;
    }
  }

  private finishLap(input: LapRecorderInput, lapMsRaw: number, lapNumber: number): CompletedLap | null {
    const lapMs = Math.round(lapMsRaw);
    if (lapMs < MIN_LAP_MS || lapMs > MAX_LAP_MS) return null;
    const rawSectors = input.telemetry.sectorTimesMs;
    const sectors: [number, number, number] = [Math.round(rawSectors[0]), Math.round(rawSectors[1]), Math.round(rawSectors[2])];
    if (!sectors.every((v) => Number.isFinite(v) && v > 0)) return null;
    if (this.rows.length < 1) return null;

    // Closing sample at the lap time, never before the last recorded sample
    const lastT = this.rows[this.rows.length - 1][0];
    const endT = round(Math.max(lapMs / 1000, lastT), 3);
    this.rows.push(sampleRow(input, endT));
    const rows = this.rows;
    const valid = this.valid;

    // Personal best and delta, before this lap changes them
    const pbBefore = this.pb;
    const deltaToBestMs = pbBefore === null ? null : lapMs - pbBefore;
    const isPersonalBest = valid && (pbBefore === null || lapMs < pbBefore);
    if (isPersonalBest) this.pb = lapMs;

    // Sector bests: the session best before this lap, then fold this lap in if valid
    const bestSectorTimesMs: [number | null, number | null, number | null] = [...this.sessionSectorBest];
    if (valid) {
      for (let i = 0; i < 3; i++) {
        const best = this.sessionSectorBest[i];
        if (best === null || sectors[i] < best) this.sessionSectorBest[i] = sectors[i];
      }
    }
    const [b1, b2, b3] = this.sessionSectorBest;
    const theoreticalBestMs = b1 !== null && b2 !== null && b3 !== null ? b1 + b2 + b3 : null;

    // Lap-wide statistics
    let topSpeedKmh = 0;
    let fullThrottle = 0;
    let braking = 0;
    for (const row of rows) {
      topSpeedKmh = Math.max(topSpeedKmh, row[9]);
      if (row[10] > 0.98) fullThrottle++;
      if (row[11] > 0.05) braking++;
    }
    const n = rows.length;
    const lapS = lapMs / 1000;

    // Corners: lowest speed in each window, and the best of earlier valid laps
    const corners: CornerStat[] = [];
    this.corners.forEach((w, k) => {
      let minSpeed = Infinity;
      for (const row of rows) {
        if (lapDistance(row[1], w.turn.sApprox, this.trackLengthM) <= w.halfM) minSpeed = Math.min(minSpeed, row[9]);
      }
      if (!Number.isFinite(minSpeed)) return;
      const bestBefore = this.sessionCornerBest[k];
      corners.push({
        turnNumber: w.turn.number,
        name: w.turn.name,
        minSpeedKmh: minSpeed,
        bestMinSpeedKmh: bestBefore,
      });
      if (valid && (bestBefore === null || minSpeed > bestBefore)) this.sessionCornerBest[k] = minSpeed;
    });

    const recording: LapRecording = {
      version: 1,
      trackId: this.trackId,
      vehicle: this.vehicle,
      driverName: this.driverName,
      driverCode: this.driverCode,
      lapTimeMs: lapMs,
      sectorTimesMs: sectors,
      recordedAt: Date.now(),
      sampleHz: this.sampleHz,
      data: rows.reduce<number[]>((acc, row) => {
        for (const v of row) acc.push(v);
        return acc;
      }, []),
    };

    const summary: LapSummaryData = {
      lapNumber,
      lapTimeMs: lapMs,
      valid,
      deltaToBestMs,
      isPersonalBest,
      sectorTimesMs: sectors,
      bestSectorTimesMs,
      theoreticalBestMs,
      topSpeedKmh,
      avgSpeedKmh: (this.trackLengthM / lapS) * 3.6,
      fullThrottlePct: (fullThrottle / n) * 100,
      brakingPct: (braking / n) * 100,
      corners,
    };

    return { recording, summary };
  }
}

/** Plays a recorded lap back: interpolated samples at any time within the lap */
export class GhostPlayer {
  readonly recording: LapRecording;
  private readonly count: number;

  constructor(recording: LapRecording) {
    this.recording = recording;
    this.count = Math.floor(recording.data.length / LAP_SAMPLE_STRIDE);
  }

  get lapTimeS(): number {
    return this.recording.lapTimeMs / 1000;
  }

  /** Interpolated sample at lap time tS (clamped to [0, lapTimeS]); null if the recording has < 2 samples */
  sampleAt(tS: number): LapSample | null {
    const n = this.count;
    if (n < 2 || Number.isNaN(tS)) return null;
    const tc = Math.min(Math.max(tS, 0), this.lapTimeS);
    const timeAt = (i: number) => this.recording.data[i * LAP_SAMPLE_STRIDE];
    if (tc <= timeAt(0)) return lapSampleAt(this.recording, 0);
    if (tc >= timeAt(n - 1)) return lapSampleAt(this.recording, n - 1);

    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (timeAt(mid) <= tc) lo = mid;
      else hi = mid;
    }
    const a = lapSampleAt(this.recording, lo);
    const b = lapSampleAt(this.recording, hi);
    const span = b.t - a.t;
    const f = span > 0 ? (tc - a.t) / span : 0;
    const q = nlerpQuat(a, b, f);
    const lerp = (x: number, y: number) => x + (y - x) * f;
    return {
      t: lerp(a.t, b.t),
      s: lerp(a.s, b.s),
      x: lerp(a.x, b.x),
      y: lerp(a.y, b.y),
      z: lerp(a.z, b.z),
      qx: q.qx,
      qy: q.qy,
      qz: q.qz,
      qw: q.qw,
      speedKmh: lerp(a.speedKmh, b.speedKmh),
      throttle: lerp(a.throttle, b.throttle),
      brake: lerp(a.brake, b.brake),
      steer: lerp(a.steer, b.steer),
      gear: a.gear,
    };
  }
}

/** Unpacks sample i of a recording */
export function lapSampleAt(recording: LapRecording, i: number): LapSample {
  const d = recording.data;
  const o = i * LAP_SAMPLE_STRIDE;
  return {
    t: d[o],
    s: d[o + 1],
    x: d[o + 2],
    y: d[o + 3],
    z: d[o + 4],
    qx: d[o + 5],
    qy: d[o + 6],
    qz: d[o + 7],
    qw: d[o + 8],
    speedKmh: d[o + 9],
    throttle: d[o + 10],
    brake: d[o + 11],
    steer: d[o + 12],
    gear: d[o + 13],
  };
}

/** Strict validation of untrusted JSON (imported files, downloads): returns a clean copy or null */
export function validateLapRecording(raw: unknown): LapRecording | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  if (r.version !== 1) return null;
  const { trackId, vehicle, driverName, driverCode, lapTimeMs, recordedAt, sampleHz } = r;
  if (typeof trackId !== "string" || trackId.length > 64) return null;
  if (typeof vehicle !== "string" || !VEHICLES.includes(vehicle as VehicleModelId)) return null;
  if (typeof driverName !== "string") return null;
  if (typeof driverCode !== "string") return null;
  const code = driverCode.toUpperCase();
  if (!DRIVER_CODE_RE.test(code)) return null;
  if (!finite(lapTimeMs) || lapTimeMs < MIN_LAP_MS || lapTimeMs > MAX_LAP_MS) return null;
  if (!finite(recordedAt)) return null;
  if (!finite(sampleHz) || sampleHz < 1 || sampleHz > 120) return null;

  const sectorsRaw: unknown[] = Array.isArray(r.sectorTimesMs) ? r.sectorTimesMs : [];
  if (sectorsRaw.length !== 3) return null;
  const sectors: number[] = [];
  for (const v of sectorsRaw) {
    if (!finite(v) || v <= 0) return null;
    sectors.push(v);
  }

  const src: unknown[] = Array.isArray(r.data) ? r.data : [];
  if (src.length === 0 || src.length > MAX_NUMBERS) return null;
  if (src.length % LAP_SAMPLE_STRIDE !== 0 || src.length / LAP_SAMPLE_STRIDE < 2) return null;
  const data: number[] = [];
  for (const v of src) {
    if (!finite(v)) return null;
    data.push(v);
  }

  const samples = data.length / LAP_SAMPLE_STRIDE;
  for (let i = 1; i < samples; i++) {
    if (data[i * LAP_SAMPLE_STRIDE] < data[(i - 1) * LAP_SAMPLE_STRIDE]) return null;
  }
  if (Math.abs(data[(samples - 1) * LAP_SAMPLE_STRIDE] - lapTimeMs / 1000) > 1.5) return null;

  const [sector1, sector2, sector3] = sectors;
  return {
    version: 1,
    trackId,
    vehicle: vehicle as VehicleModelId,
    driverName: cleanDriverName(driverName),
    driverCode: code,
    lapTimeMs,
    sectorTimesMs: [sector1, sector2, sector3],
    recordedAt,
    sampleHz,
    data,
  };
}
