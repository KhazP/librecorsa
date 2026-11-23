import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import type {
  ControlInputs,
  PitPhase,
  PitStrategyState,
  PitTelemetry,
  PlayerDamageStatus,
  TireCompound,
} from "@/types/f1";

export interface PitBoxPose {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  pitS: number;
  lateralOffsetM: number;
  boxIndex: number;
  boxCount: number;
}

export interface PitSample {
  x: number;
  y: number;
  z: number;
  s: number;
  tx: number;
  tz: number;
  rx: number;
  rz: number;
  yawRad: number;
}

export interface PitLaneLayout {
  samples: PitSample[];
  totalLenM: number;
  widthM: number;
  detectS: number;
  exitLineS: number;
  entryS: number;
  exitS: number;
  trackLenM: number;
  box: PitBoxPose;
  synthetic: boolean;
}

export interface PitUpdateContext {
  worldX: number;
  worldZ: number;
  trackS: number;
  trackLateralOffsetM: number;
  speedMs: number;
  damage: PlayerDamageStatus | undefined | null;
  canService: boolean;
  simTimeS?: number;
}

export interface PitUpdateResult {
  telemetry: PitTelemetry;
  speedingPenalty: boolean;
  serviceComplete: boolean;
}

const DEFAULT_SPEED_LIMIT_KMH = 60;
const MIN_SPEED_LIMIT_KMH = 40;
const MAX_SPEED_LIMIT_KMH = 100;
const SPEEDING_TOLERANCE_KMH = 2;
const WARNING_LOOKAHEAD_M = 110;
const TRACK_ENTRY_LOOKAHEAD_M = 180;
const BOX_STOP_TOLERANCE_LONG_M = 2.8;
const BOX_STOP_TOLERANCE_LAT_M = 2.2;
const BOX_STOP_SPEED_KMH = 3.5;
/** Slot sits on the garage side of the pit lane (driver's left), not on the fast lane's centreline. */
const BOX_LATERAL_OFFSET_M = -1.2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function forwardWrapDelta(fromS: number, toS: number, loopLen: number): number {
  if (loopLen <= 0) return toS - fromS;
  return (((toS - fromS) % loopLen) + loopLen) % loopLen;
}

/**
 * Builds pit-lane centerline samples, detection point, and assigned pit box pose from track data
 * (or synthesizes a parallel pit lane beside S/F when a circuit omits `pitLane`).
 */
export function buildPitLaneLayout(track: BuiltTrackData, preferredBoxIndex = 4): PitLaneLayout {
  const trackLenM = track.totalLengthM;
  const rawPit = track.pitLane;
  const rawPts: [number, number, number][] = [];
  let synthetic = false;
  let widthM = 5.5;
  let entryS = trackLenM - 250;
  let exitS = 340;
  let boxCount = 20;

  if (rawPit && rawPit.centerline.length >= 6) {
    for (const pt of rawPit.centerline) rawPts.push([pt[0], pt[1], pt[2]]);
    widthM = Math.max(4.0, rawPit.widthM || 5.5);
    entryS = rawPit.entryS;
    exitS = rawPit.exitS;
    boxCount = Math.max(8, Math.min(26, rawPit.pitboxes ?? 20));
  } else {
    synthetic = true;
    const preLen = Math.min(180, Math.floor(trackLenM * 0.08));
    const postLen = Math.min(200, Math.floor(trackLenM * 0.09));
    entryS = Math.max(0, trackLenM - preLen);
    exitS = postLen;
    const step = 6;
    for (let d = -preLen; d <= postLen; d += step) {
      const s = ((d % trackLenM) + trackLenM) % trackLenM;
      const sample = track.getSampleAtDistance(s);
      const lat = sample.width * 0.5 + 4.8;
      const x = sample.position.x + sample.binormal.x * lat;
      const z = sample.position.z + sample.binormal.z * lat;
      const y = sample.position.y;
      rawPts.push([x, y, z]);
    }
  }

  const samples: PitSample[] = [];
  let accumS = 0;
  for (let i = 0; i < rawPts.length; i++) {
    const p = rawPts[i];
    if (i > 0) {
      const prev = rawPts[i - 1];
      accumS += Math.hypot(p[0] - prev[0], p[2] - prev[2]);
    }
    const prev = rawPts[Math.max(0, i - 1)];
    const next = rawPts[Math.min(rawPts.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dz = next[2] - prev[2];
    const len = Math.hypot(dx, dz) || 1;
    const tx = dx / len;
    const tz = dz / len;
    // Right-hand horizontal perpendicular in +X/+Z with forward = (tx, tz) and up = +Y
    const rx = -tz;
    const rz = tx;
    const yawRad = Math.atan2(tx, tz);
    samples.push({ x: p[0], y: p[1], z: p[2], s: accumS, tx, tz, rx, rz, yawRad });
  }

  const totalLenM = Math.max(40, accumS);
  const detectS = clamp(Math.round(totalLenM * 0.18), 45, Math.min(115, totalLenM * 0.35));
  const exitLineS = clamp(Math.round(totalLenM * 0.85), detectS + 40, totalLenM - 30);

  const clampedBoxIdx = Math.max(0, Math.min(boxCount - 1, Math.floor(preferredBoxIndex)));
  const boxSpanStart = Math.min(detectS + 32, totalLenM * 0.35);
  const boxSpanEnd = Math.max(boxSpanStart + 20, Math.min(exitLineS - 36, totalLenM * 0.78));
  const frac = boxCount > 1 ? clampedBoxIdx / (boxCount - 1) : 0.5;
  const boxPitS = boxSpanStart + (boxSpanEnd - boxSpanStart) * frac;
  const boxSample = samplePitAtS(samples, boxPitS);
  // Slight offset toward the garage apron (driver's left) while staying inside the pit lane corridor
  const lateralOffsetM = BOX_LATERAL_OFFSET_M;

  return {
    samples,
    totalLenM,
    widthM,
    detectS,
    exitLineS,
    entryS,
    exitS,
    trackLenM,
    box: {
      x: boxSample.x + boxSample.rx * lateralOffsetM,
      y: boxSample.y,
      z: boxSample.z + boxSample.rz * lateralOffsetM,
      yawRad: boxSample.yawRad,
      pitS: boxPitS,
      lateralOffsetM,
      boxIndex: clampedBoxIdx,
      boxCount,
    },
    synthetic,
  };
}

function samplePitAtS(samples: readonly PitSample[], targetS: number): PitSample {
  if (samples.length === 0) {
    return { x: 0, y: 0, z: 0, s: 0, tx: 0, tz: 1, rx: -1, rz: 0, yawRad: 0 };
  }
  if (targetS <= samples[0].s) return samples[0];
  const last = samples[samples.length - 1];
  if (targetS >= last.s) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s <= targetS) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.s - a.s;
  const t = span > 1e-6 ? (targetS - a.s) / span : 0;
  const tx = a.tx + (b.tx - a.tx) * t;
  const tz = a.tz + (b.tz - a.tz) * t;
  const tLen = Math.hypot(tx, tz) || 1;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    s: targetS,
    tx: tx / tLen,
    tz: tz / tLen,
    rx: -tz / tLen,
    rz: tx / tLen,
    yawRad: Math.atan2(tx / tLen, tz / tLen),
  };
}

function projectToPitLane(
  samples: readonly PitSample[],
  worldX: number,
  worldZ: number
): { s: number; lateralM: number; absDistM: number } {
  let bestDistSq = Infinity;
  let bestS = 0;
  let bestLat = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const abLenSq = abx * abx + abz * abz;
    if (abLenSq < 1e-8) continue;
    const apx = worldX - a.x;
    const apz = worldZ - a.z;
    const u = clamp((apx * abx + apz * abz) / abLenSq, 0, 1);
    const cx = a.x + abx * u;
    const cz = a.z + abz * u;
    const dx = worldX - cx;
    const dz = worldZ - cz;
    const dSq = dx * dx + dz * dz;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      const segLen = Math.sqrt(abLenSq);
      bestS = a.s + u * segLen;
      const tx = abx / segLen;
      const tz = abz / segLen;
      const rx = -tz;
      const rz = tx;
      bestLat = dx * rx + dz * rz;
    }
  }
  return { s: bestS, lateralM: bestLat, absDistM: Math.sqrt(bestDistSq) };
}

/** Realistic F1 / motorsport tyre swap duration: strictly 1.8 s .. 5.0 s, sped slightly by HQ pit crew upgrade */
export function rollRealisticTyreDurationS(crewBonusPct = 0, rng: () => number = Math.random): number {
  const r = rng();
  let raw: number;
  if (r < 0.72) {
    // Clean quick stop: 1.85 .. 2.75 s
    raw = 1.85 + rng() * 0.9;
  } else if (r < 0.93) {
    // Slightly sticky wheel gun / front jack: 2.75 .. 3.85 s
    raw = 2.75 + rng() * 1.1;
  } else {
    // Slow wheel nut: 3.85 .. 5.00 s
    raw = 3.85 + rng() * 1.15;
  }
  const bonus = clamp(crewBonusPct, 0, 0.35);
  const adjusted = 1.8 + (raw - 1.8) * (1 - bonus);
  return Math.round(clamp(adjusted, 1.8, 5.0) * 100) / 100;
}

/** Realistic proportional damage repair duration (0 s when disabled or undamaged) */
export function computeRepairDurationS(
  damage: PlayerDamageStatus | undefined | null,
  repairRequested: boolean,
  crewBonusPct = 0
): number {
  if (!repairRequested || !damage) return 0;
  const punctures = damage.punctured.filter(Boolean).length;
  if (damage.overall < 0.03 && punctures === 0) return 0;
  const raw = 1.4 + damage.overall * 7.8 + punctures * 1.25;
  const bonus = clamp(crewBonusPct, 0, 0.35);
  const adjusted = raw * (1 - bonus * 0.35);
  return Math.round(clamp(adjusted, 1.2, 11.5) * 100) / 100;
}

export class PitStopManager {
  public readonly layout: PitLaneLayout;
  private speedLimitKmh = DEFAULT_SPEED_LIMIT_KMH;
  private manualLimiter = false;
  private autoLimiter = false;
  private phase: PitPhase = "track";
  private prevPitS: number | null = null;
  private prevInLaneCorridor = false;
  private penalizedThisVisit = false;
  private servicedThisVisit = false;
  private speedingPenaltyCount = 0;

  private serviceTotalS = 0;
  private serviceRemainingS = 0;
  private lastTyreDurationS = 0;
  private lastRepairDurationS = 0;
  private crewBonusPct = 0;
  private releaseFlashS = 0;
  private speedingBannerS = 0;

  private strategy: PitStrategyState;

  constructor(track: BuiltTrackData, initialCompound: TireCompound = "soft", preferredBoxIndex = 4) {
    this.layout = buildPitLaneLayout(track, preferredBoxIndex);
    this.strategy = {
      nextCompound: initialCompound,
      repairDamage: true,
      boxRequested: false,
    };
  }

  public get boxPose(): PitBoxPose {
    return this.layout.box;
  }

  public setSpeedLimitKmh(kmh: number): void {
    if (!Number.isFinite(kmh)) return;
    this.speedLimitKmh = Math.round(clamp(kmh, MIN_SPEED_LIMIT_KMH, MAX_SPEED_LIMIT_KMH));
  }

  public getSpeedLimitKmh(): number {
    return this.speedLimitKmh;
  }

  public setCrewBonusPct(bonus: number): void {
    this.crewBonusPct = Number.isFinite(bonus) ? clamp(bonus, 0, 0.35) : 0;
  }

  public setStrategy(patch: Partial<PitStrategyState>): void {
    if (patch.nextCompound) this.strategy.nextCompound = patch.nextCompound;
    if (typeof patch.repairDamage === "boolean") this.strategy.repairDamage = patch.repairDamage;
    if (typeof patch.boxRequested === "boolean") this.strategy.boxRequested = patch.boxRequested;
  }

  public getStrategy(): PitStrategyState {
    return { ...this.strategy };
  }

  public toggleLimiter(): boolean {
    if (this.autoLimiter) {
      // Cannot switch off the automatic pit limiter inside the mandatory pit speed zone
      return true;
    }
    this.manualLimiter = !this.manualLimiter;
    return this.manualLimiter;
  }

  public setManualLimiter(on: boolean): void {
    this.manualLimiter = on;
  }

  public isLimiterActive(): boolean {
    return this.autoLimiter || this.manualLimiter;
  }

  public isControlsLocked(): boolean {
    return this.phase === "servicing";
  }

  public reset(keepStrategy = true, initialCompound?: TireCompound): void {
    this.manualLimiter = false;
    this.autoLimiter = false;
    this.phase = "track";
    this.prevPitS = null;
    this.prevInLaneCorridor = false;
    this.penalizedThisVisit = false;
    this.servicedThisVisit = false;
    this.speedingPenaltyCount = 0;
    this.serviceTotalS = 0;
    this.serviceRemainingS = 0;
    this.lastTyreDurationS = 0;
    this.lastRepairDurationS = 0;
    this.releaseFlashS = 0;
    this.speedingBannerS = 0;
    if (!keepStrategy) {
      this.strategy = {
        nextCompound: initialCompound ?? this.strategy.nextCompound,
        repairDamage: true,
        boxRequested: false,
      };
    } else if (initialCompound) {
      this.strategy.nextCompound = initialCompound;
      this.strategy.boxRequested = false;
    }
  }

  /**
   * Advances pit lane zones, detection line speed checks, automatic pit limiter activation,
   * pit box alignment, and realistic tyre/repair servicing countdown.
   */
  public update(dtS: number, ctx: PitUpdateContext): PitUpdateResult {
    const dt = Math.max(0, Math.min(0.1, dtS));
    const speedKmh = Math.max(0, ctx.speedMs * 3.6);
    if (this.releaseFlashS > 0) this.releaseFlashS = Math.max(0, this.releaseFlashS - dt);
    if (this.speedingBannerS > 0) this.speedingBannerS = Math.max(0, this.speedingBannerS - dt);

    const proj = projectToPitLane(this.layout.samples, ctx.worldX, ctx.worldZ);
    const pitHalf = this.layout.widthM * 0.5;
    const laneTol = pitHalf + 1.5;
    // Prevent main-straight overlaps right near entryS/exitS when car is clearly on main track centerline
    const nearMainTrackLine = Math.abs(ctx.trackLateralOffsetM) <= 7.2 && (proj.s < 28 || proj.s > this.layout.totalLenM - 28);
    const inCorridor = Math.abs(proj.lateralM) <= laneTol && !nearMainTrackLine;

    let speedingPenalty = false;
    let serviceComplete = false;

    const damagePct = ctx.damage ? Math.round(clamp(ctx.damage.overall, 0, 1) * 100) : 0;
    const hasDamage = Boolean(
      ctx.damage && (ctx.damage.overall >= 0.03 || ctx.damage.punctured.some(Boolean))
    );

    if (this.phase === "servicing") {
      this.autoLimiter = true;
      this.serviceRemainingS = Math.max(0, this.serviceRemainingS - dt);
      if (this.serviceRemainingS <= 0) {
        this.phase = "released";
        this.servicedThisVisit = true;
        this.strategy.boxRequested = false;
        this.releaseFlashS = 2.6;
        serviceComplete = true;
      }
      this.prevPitS = proj.s;
      this.prevInLaneCorridor = true;
      return {
        telemetry: this.buildTelemetry(ctx.damage, speedKmh, proj.s, proj.lateralM, true, hasDamage, damagePct),
        speedingPenalty: false,
        serviceComplete,
      };
    }

    if (!inCorridor) {
      // Outside pit corridor: check whether the driver is approaching pit entry with Box Requested or in early pit entry
      this.autoLimiter = false;
      if (this.prevInLaneCorridor && proj.s > this.layout.exitLineS * 0.65) {
        // Clean exit back to track
        this.penalizedThisVisit = false;
        this.servicedThisVisit = false;
      } else if (this.prevInLaneCorridor) {
        this.penalizedThisVisit = false;
        this.servicedThisVisit = false;
      }
      this.prevInLaneCorridor = false;
      this.prevPitS = null;

      const deltaToEntry = forwardWrapDelta(ctx.trackS, this.layout.entryS, this.layout.trackLenM);
      const approachingEntry =
        this.strategy.boxRequested && deltaToEntry > 0 && deltaToEntry <= TRACK_ENTRY_LOOKAHEAD_M;
      this.phase = approachingEntry ? "entry_warning" : "track";

      return {
        telemetry: this.buildTelemetry(
          ctx.damage,
          speedKmh,
          approachingEntry ? -deltaToEntry : null,
          null,
          false,
          hasDamage,
          damagePct
        ),
        speedingPenalty: false,
        serviceComplete: false,
      };
    }

    // Car is inside the pit lane corridor
    const detectS = this.layout.detectS;
    const exitLineS = this.layout.exitLineS;

    // Detect crossing pit speed detection line from entry side -> speed limit penalty check
    if (
      this.prevPitS !== null &&
      this.prevPitS < detectS &&
      proj.s >= detectS &&
      !this.penalizedThisVisit
    ) {
      if (speedKmh > this.speedLimitKmh + SPEEDING_TOLERANCE_KMH) {
        this.penalizedThisVisit = true;
        this.speedingPenaltyCount += 1;
        this.speedingBannerS = 4.0;
        speedingPenalty = true;
      }
    }

    if (proj.s < detectS) {
      // Pit entry lane BEFORE speed-limit detection point: warn driver to slow down!
      this.autoLimiter = false;
      this.phase = "entry_warning";
      this.prevPitS = proj.s;
      this.prevInLaneCorridor = true;
      return {
        telemetry: this.buildTelemetry(ctx.damage, speedKmh, proj.s, proj.lateralM, false, hasDamage, damagePct),
        speedingPenalty,
        serviceComplete: false,
      };
    }

    if (proj.s <= exitLineS) {
      // Inside active speed-limited pit lane
      this.autoLimiter = true;

      const longErrM = this.layout.box.pitS - proj.s;
      const latErrM = proj.lateralM - this.layout.box.lateralOffsetM;
      const aligned =
        !this.servicedThisVisit &&
        Math.abs(longErrM) <= BOX_STOP_TOLERANCE_LONG_M &&
        Math.abs(latErrM) <= BOX_STOP_TOLERANCE_LAT_M;

      if (aligned && ctx.canService && speedKmh <= BOX_STOP_SPEED_KMH) {
        // Begin tyre change + repair servicing and lock car controls
        this.lastTyreDurationS = rollRealisticTyreDurationS(this.crewBonusPct);
        this.lastRepairDurationS = computeRepairDurationS(
          ctx.damage,
          this.strategy.repairDamage,
          this.crewBonusPct
        );
        this.serviceTotalS = Math.round((this.lastTyreDurationS + this.lastRepairDurationS) * 100) / 100;
        this.serviceRemainingS = this.serviceTotalS;
        this.phase = "servicing";
      } else if (aligned) {
        this.phase = "in_box";
      } else if (this.releaseFlashS > 0 && this.servicedThisVisit) {
        this.phase = "released";
      } else {
        this.phase = "lane";
      }

      this.prevPitS = proj.s;
      this.prevInLaneCorridor = true;
      return {
        telemetry: this.buildTelemetry(ctx.damage, speedKmh, proj.s, proj.lateralM, aligned, hasDamage, damagePct),
        speedingPenalty,
        serviceComplete: false,
      };
    }

    // Pit exit stretch past speed-limit line (acceleration back to circuit)
    this.autoLimiter = false;
    this.phase = this.releaseFlashS > 0 ? "released" : "track";
    this.prevPitS = proj.s;
    this.prevInLaneCorridor = true;
    return {
      telemetry: this.buildTelemetry(ctx.damage, speedKmh, proj.s, proj.lateralM, false, hasDamage, damagePct),
      speedingPenalty,
      serviceComplete: false,
    };
  }

  /**
   * Applies control-level locking during pit service and closed-loop throttle cut + auto-braking
   * whenever the pit limiter is active and speed approaches or exceeds the pit limit.
   */
  public filterInputs(inputs: ControlInputs, speedMs: number): void {
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
      inputs.neutral = false;
      inputs.manualOverride = false;
      inputs.toggleXMode = false;
      return;
    }

    if (!this.isLimiterActive()) return;

    const limitMs = this.speedLimitKmh / 3.6;
    const errMs = speedMs - limitMs;

    if (errMs > 0.05) {
      // Actively brake the car down to the limiter speed and block throttle + boost
      const autoBrake = clamp(0.28 + errMs * 0.22, 0.28, 1.0);
      inputs.throttle = 0;
      inputs.brake = Math.max(inputs.brake, autoBrake);
      inputs.manualOverride = false;
    } else if (errMs > -1.0) {
      // Feather throttle smoothly as we sit right on the limiter target
      const windowFrac = clamp((-errMs) / 1.05, 0, 1);
      inputs.throttle = Math.min(inputs.throttle, 0.35 * windowFrac);
      inputs.manualOverride = false;
    }
  }

  private buildTelemetry(
    damage: PlayerDamageStatus | undefined | null,
    speedKmh: number,
    pitSOrNegEntryDist: number | null,
    pitLatM: number | null,
    alignedInBox: boolean,
    hasDamage: boolean,
    damagePct: number
  ): PitTelemetry {
    let distToDetectM: number | null = null;
    let distToBoxM: number | null = null;
    let lateralErrM: number | null = null;

    if (pitSOrNegEntryDist !== null) {
      if (pitSOrNegEntryDist < 0) {
        // Track entry warning: total distance to detection line
        distToDetectM = Math.round((-pitSOrNegEntryDist + this.layout.detectS) * 10) / 10;
      } else {
        if (pitSOrNegEntryDist <= this.layout.detectS + 5) {
          distToDetectM = Math.max(0, Math.round((this.layout.detectS - pitSOrNegEntryDist) * 10) / 10);
        }
        if (!this.servicedThisVisit && pitSOrNegEntryDist <= this.layout.box.pitS + 25) {
          distToBoxM = Math.round((this.layout.box.pitS - pitSOrNegEntryDist) * 10) / 10;
        }
        if (pitLatM !== null) {
          lateralErrM = Math.round((pitLatM - this.layout.box.lateralOffsetM) * 100) / 100;
        }
      }
    }

    const limiterActive = this.isLimiterActive();
    const overLimit = speedKmh > this.speedLimitKmh + 0.6;
    const speedWarning =
      (this.phase === "entry_warning" &&
        distToDetectM !== null &&
        distToDetectM <= WARNING_LOOKAHEAD_M + this.layout.detectS &&
        speedKmh > this.speedLimitKmh) ||
      this.speedingBannerS > 0;

    const previewRepairS =
      this.phase === "servicing"
        ? this.lastRepairDurationS
        : computeRepairDurationS(damage, this.strategy.repairDamage, this.crewBonusPct);

    return {
      phase: this.phase,
      limiterActive,
      limiterAuto: this.autoLimiter,
      speedLimitKmh: this.speedLimitKmh,
      overLimit,
      speedWarning,
      speedingPenaltyCount: this.speedingPenaltyCount,
      distToDetectM,
      distToBoxM,
      lateralErrM,
      alignedInBox,
      controlsLocked: this.phase === "servicing",
      serviceRemainingS: Math.round(this.serviceRemainingS * 100) / 100,
      serviceTotalS: Math.round(this.serviceTotalS * 100) / 100,
      tyreDurationS: this.phase === "servicing" ? this.lastTyreDurationS : 0,
      repairDurationS: previewRepairS,
      hasDamage,
      damagePct,
      strategy: { ...this.strategy },
      assignedBoxIndex: this.layout.box.boxIndex,
    };
  }
}

export function createPitBoxAnchorVector(pose: PitBoxPose): THREE.Vector3 {
  return new THREE.Vector3(pose.x, pose.y, pose.z);
}
