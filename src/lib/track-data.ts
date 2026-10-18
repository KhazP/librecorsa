import * as THREE from "three";
import {
  LiveryConfig,
  RunoffStyle,
  TrackControlPoint,
  TrackSamplePoint,
  TurnMetadata,
} from "@/types/f1";
import rawTrackJson from "../../public/tracks/rwanda/track_data.json";
import { AI_LINE_WIDTH_SCALE, brakingZoneLevel, computeSpeedProfile, createVf26ProfileCarModel } from "./sim/speed-profile";

/** Raw `track_data.json` layout shared by every circuit (Rwanda's file is the reference schema) */
export type RawTrackJson = typeof rawTrackJson;

/**
 * The circuit everything below describes. Rwanda by default; `setActiveTrack` swaps in another layout before
 * the simulator mounts. The exported constants are live bindings / arrays refilled in place, so modules that
 * imported them (menus, F12026CarSim's DRS zones) follow the switch without changes.
 */
let activeRaw: RawTrackJson = rawTrackJson;
export let ACTIVE_TRACK_ID = "rwanda";

export const RWANDA_BASE_ALTITUDE_M = 1385; // Bugesera baseline altitude (m ASL)
/** Altitude (m ASL) of world y = 0 on the active circuit (air density) */
export let BASE_ALTITUDE_M = RWANDA_BASE_ALTITUDE_M;

export const RWANDA_TARGET_LENGTH_M = rawTrackJson.metadata.lengthMeters;
/** Lap length of the active circuit (m) */
export let TRACK_TOTAL_LENGTH_M = rawTrackJson.metadata.lengthMeters;

export interface DrsZoneDef {
  id: string;
  detection: number;
  start: number;
  end: number;
}

export interface TracksideTvCameraDef {
  name: string;
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  minFov: number;
  maxFov: number;
  inPoint: number;
  outPoint: number;
}

export interface BuiltTrackData {
  /** Circuit id (`rwanda`, or a folder under public/tracks); absent on synthetic test tracks */
  id?: string;
  /** Circuit GLB (relative to the base path); absent on synthetic test tracks */
  meshUrl?: string;
  /** Start grid slots for this layout (behind the S/F line) */
  spawnGrid: GridSlotDef[];
  samples: TrackSamplePoint[];
  totalLengthM: number;
  totalLength: number;
  spline: THREE.CatmullRomCurve3;
  getSampleAtDistance: (s: number) => TrackSamplePoint;
  projectWorldToTrack: (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => {
    sample: TrackSamplePoint;
    s: number;
    lateralOffset: number;
    distSq: number;
  };
  /**
   * Continuous world → track mapping: segment `i0 → i1` at parameter `t` (s = (i0 + t)·ds),
   * with the signed horizontal lateral offset `lateralH` (+ right) used by the height profiles.
   */
  locateWorldPoint: (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => { i0: number; i1: number; t: number; s: number; lateralH: number };
}

export const RWANDA_TRACK_METADATA = rawTrackJson.metadata;
/** DRS zones of the active circuit (the name predates other circuits) */
export const RWANDA_DRS_ZONES: DrsZoneDef[] = [...(rawTrackJson.drsZones as DrsZoneDef[])];
/** Broadcast cameras of the active circuit */
export const RWANDA_TV_CAMERAS: TracksideTvCameraDef[] = [...(rawTrackJson.cameras as TracksideTvCameraDef[])];

export interface GridSlotDef {
  slot: number;
  /** Track distance of the car centre (behind the S/F line, so close to the lap length) */
  s: number;
  /** Signed lateral offset from the centreline (m, + right) */
  lateral: number;
  position: [number, number, number];
  yawRad: number;
  forward: [number, number, number];
}
/** Grid slots of the active circuit */
export const RWANDA_SPAWN_GRID: GridSlotDef[] = [...(rawTrackJson.spawnGrid as GridSlotDef[])];

export const LIVERIES: LiveryConfig[] = [
  {
    id: "rwanda_2026",
    name: "Visit Rwanda #26",
    team: "Kigali Apex Racing",
    primary: "#00a1de",
    secondary: "#0f172a",
    accent: "#fad201",
    number: "26",
  },
  {
    id: "scuderia_red",
    name: "Scuderia Corsa #16",
    team: "Maranello Works",
    primary: "#dc2626",
    secondary: "#18181b",
    accent: "#facc15",
    number: "16",
  },
  {
    id: "silver_arrow",
    name: "Silver Star #44",
    team: "Brackley Aero",
    primary: "#e2e8f0",
    secondary: "#0f172a",
    accent: "#06b6d4",
    number: "44",
  },
  {
    id: "papaya_apex",
    name: "Papaya Velocity #4",
    team: "Woking Motorsport",
    primary: "#f97316",
    secondary: "#1e293b",
    accent: "#38bdf8",
    number: "4",
  },
  {
    id: "carbon_stealth",
    name: "Stealth Bull #1",
    team: "Milton Keynes Racing",
    primary: "#1e1b4b",
    secondary: "#090d16",
    accent: "#ef4444",
    number: "1",
  },
];

function turnsOf(raw: RawTrackJson): TurnMetadata[] {
  return (raw.turns as TurnMetadata[]).map((t) => ({ ...t, sector: t.sector as 1 | 2 | 3 }));
}

/** Corners of the active circuit, detected from the centreline curvature and exported with the track */
export const TURN_METADATA: TurnMetadata[] = turnsOf(rawTrackJson);

export const RWANDA_TURN_METADATA = TURN_METADATA;

function isInDrsZone(t: number): boolean {
  const normT = ((t % 1) + 1) % 1;
  for (const z of RWANDA_DRS_ZONES) {
    if (z.start <= z.end) {
      if (normT >= z.start && normT <= z.end) return true;
    } else {
      if (normT >= z.start || normT <= z.end) return true;
    }
  }
  return false;
}

let LEFT_HAND_TURNS = new Set(
  TURN_METADATA.filter((t) => t.direction === "left").map((t) => t.number)
);
let TURN_NAMES = new Map(TURN_METADATA.map((t) => [t.number, t.name]));
let RAW_DS = rawTrackJson.metadata.lengthMeters / rawTrackJson.samples.length;

type RawTrackSample = (typeof rawTrackJson.samples)[number];

function rawSampleAtS(s: number): RawTrackSample {
  const n = activeRaw.samples.length;
  const i = ((Math.round(s / RAW_DS) % n) + n) % n;
  return activeRaw.samples[i];
}

/** Optional fields newer circuits add to the metadata block */
export interface TrackMetaExtras {
  shortName?: string;
  baseAltitudeM?: number;
  mesh?: { url?: string };
  credit?: { title: string; author: string; url: string; short?: string; license: string; licenseUrl: string };
}

/** Metadata of the active circuit */
export function getActiveTrackMetadata(): RawTrackJson["metadata"] & TrackMetaExtras {
  return activeRaw.metadata as RawTrackJson["metadata"] & TrackMetaExtras;
}

function refill<T>(target: T[], items: T[]): void {
  target.length = 0;
  target.push(...items);
}

/**
 * Makes `raw` (a `public/tracks/<id>/track_data.json`) the circuit every track query, menu and car uses.
 * Call before the simulator mounts: built track data, physics and scenes made earlier keep the old layout.
 */
export function setActiveTrack(id: string, raw: RawTrackJson = rawTrackJson): void {
  activeRaw = raw;
  ACTIVE_TRACK_ID = id;
  const meta = raw.metadata as RawTrackJson["metadata"] & TrackMetaExtras;
  TRACK_TOTAL_LENGTH_M = meta.lengthMeters;
  BASE_ALTITUDE_M = meta.baseAltitudeM ?? (id === "rwanda" ? RWANDA_BASE_ALTITUDE_M : 0);
  refill(RWANDA_DRS_ZONES, raw.drsZones as DrsZoneDef[]);
  refill(RWANDA_TV_CAMERAS, raw.cameras as TracksideTvCameraDef[]);
  refill(RWANDA_SPAWN_GRID, raw.spawnGrid as GridSlotDef[]);
  refill(TURN_METADATA, turnsOf(raw));
  LEFT_HAND_TURNS = new Set(TURN_METADATA.filter((t) => t.direction === "left").map((t) => t.number));
  TURN_NAMES = new Map(TURN_METADATA.map((t) => [t.number, t.name]));
  RAW_DS = meta.lengthMeters / raw.samples.length;
  cachedBuiltTrack = null;
}

function getTurnInfoAtS(
  s: number,
  totalLen: number
): {
  sector: 1 | 2 | 3;
  turnNumber: number;
  turnName: string;
  runoffStyle: RunoffStyle;
  minBankRad: number;
} {
  const wrapped = ((s % totalLen) + totalLen) % totalLen;
  const raw = rawSampleAtS(wrapped);
  const sector = raw.sec as 1 | 2 | 3;
  const turnNumber = raw.turn;
  const turnName =
    TURN_NAMES.get(turnNumber) ??
    (sector === 1
      ? "Start / Finish Straight"
      : ACTIVE_TRACK_ID !== "rwanda"
        ? `Sector ${sector}`
        : sector === 2
          ? "Thousand Hills Straight"
          : "Qatar Valley Straight");
  return {
    sector,
    turnNumber,
    turnName,
    runoffStyle: raw.zone as RunoffStyle,
    minBankRad: (LEFT_HAND_TURNS.has(turnNumber) ? -1 : 1) * Math.abs(raw.b),
  };
}

export const RWANDA_CONTROL_POINTS: TrackControlPoint[] = rawTrackJson.samples
  .filter((_, idx) => idx % 24 === 0)
  .map((raw) => {
    const totalLen = rawTrackJson.metadata.lengthMeters;
    const t = raw.s / totalLen;
    const info = getTurnInfoAtS(raw.s, totalLen);
    return {
      x: raw.p[0],
      y: raw.p[1],
      z: raw.p[2],
      bankingDeg: THREE.MathUtils.radToDeg(raw.b),
      width: raw.w,
      sector: info.sector,
      turnNumber: info.turnNumber,
      turnName: info.turnName,
      runoffStyle: info.runoffStyle,
      kerbLeft: raw.kL === 1,
      kerbRight: raw.kR === 1,
      drsZone: isInDrsZone(t),
      racingLineOffset: raw.ro / (raw.w * AI_LINE_WIDTH_SCALE),
    };
  });

let cachedBuiltTrack: BuiltTrackData | null = null;

export const LAT_PROFILE_OFFSETS = [-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12] as const;

/**
 * Evaluates the exact 3D track surface height `y` at a signed lateral offset `lateralOffsetM`
 * (`-left .. +right` along horizontal track binormal) for a `TrackSamplePoint`.
 */
export function evaluateSampleLateralHeightM(
  sample: TrackSamplePoint,
  lateralOffsetM: number
): number {
  const yp = sample.yProf;
  if (!yp || yp.length !== LAT_PROFILE_OFFSETS.length) {
    return sample.position.y - Math.sin(sample.bankingRad) * lateralOffsetM;
  }
  const n = LAT_PROFILE_OFFSETS.length;
  if (lateralOffsetM <= LAT_PROFILE_OFFSETS[0]) {
    const slopeLeft =
      (yp[1] - yp[0]) / (LAT_PROFILE_OFFSETS[1] - LAT_PROFILE_OFFSETS[0]);
    return yp[0] + slopeLeft * (lateralOffsetM - LAT_PROFILE_OFFSETS[0]);
  }
  if (lateralOffsetM >= LAT_PROFILE_OFFSETS[n - 1]) {
    const slopeRight =
      (yp[n - 1] - yp[n - 2]) /
      (LAT_PROFILE_OFFSETS[n - 1] - LAT_PROFILE_OFFSETS[n - 2]);
    return yp[n - 1] + slopeRight * (lateralOffsetM - LAT_PROFILE_OFFSETS[n - 1]);
  }
  for (let k = 0; k < n - 1; k++) {
    const l0 = LAT_PROFILE_OFFSETS[k];
    const l1 = LAT_PROFILE_OFFSETS[k + 1];
    if (lateralOffsetM >= l0 && lateralOffsetM <= l1) {
      const alpha = (lateralOffsetM - l0) / (l1 - l0);
      return yp[k] + (yp[k + 1] - yp[k]) * alpha;
    }
  }
  return sample.position.y;
}

/**
 * Uniform Catmull-Rom weights for samples [i−1, i, i+1, i+2] at parameter t ∈ [0, 1] between i and i+1.
 * Used for road heights so the surface is C1 along the track: linear interpolation between
 * profiles 4.4 m apart leaves slope kinks that hit the tyres like bumps at speed.
 */
export function catmullRomWeights(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (-t3 + 2 * t2 - t),
    0.5 * (3 * t3 - 5 * t2 + 2),
    0.5 * (-3 * t3 + 4 * t2 + t),
    0.5 * (t3 - t2),
  ];
}

/** Built data of the active circuit (Rwanda unless `setActiveTrack` chose another) */
export function getRwandaTrackData(numSamples = 1200): BuiltTrackData {
  if (cachedBuiltTrack && cachedBuiltTrack.samples.length === numSamples && cachedBuiltTrack.id === ACTIVE_TRACK_ID) {
    return cachedBuiltTrack;
  }

  const rawSamples = activeRaw.samples;
  const rawCount = rawSamples.length;
  const totalLength = activeRaw.metadata.lengthMeters;

  const splinePts = rawSamples.map(
    (s) => new THREE.Vector3(s.p[0], s.p[1], s.p[2])
  );
  const spline = new THREE.CatmullRomCurve3(splinePts, true, "centripetal", 0.5);

  const NUM_SAMPLES = numSamples;
  const ds = totalLength / NUM_SAMPLES;

  const positions: THREE.Vector3[] = [];
  const racingOffsetsM: number[] = [];
  const gt3OffsetsM: number[] = [];
  const yProfs: number[][] = [];
  const widths: number[] = [];
  const bankings: number[] = [];
  const grips: number[] = [];
  const aiSpeedsKmh: number[] = [];
  // Per-side run-off / gravel / barrier extents and kerb flags exported with the 2026 layout
  const edges: {
    rL: number; rR: number; gL: number; gR: number; wL: number; wR: number; kL: boolean; kR: boolean;
  }[] = [];

  let rawIdx = 0;
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const targetS = i * ds;
    while (
      rawIdx < rawCount - 1 &&
      rawSamples[(rawIdx + 1) % rawCount].s <= targetS
    ) {
      rawIdx++;
    }
    const r0 = rawSamples[rawIdx] as typeof rawSamples[0] & { yProf?: number[] };
    const r1 = rawSamples[(rawIdx + 1) % rawCount] as typeof rawSamples[0] & {
      yProf?: number[];
    };
    const s0 = r0.s;
    const s1 = rawIdx + 1 < rawCount ? r1.s : totalLength;
    const span = Math.max(0.001, s1 - s0);
    const alpha = THREE.MathUtils.clamp((targetS - s0) / span, 0, 1);

    // Cubic (Catmull-Rom) resampling: linear interpolation of the ~4.9 m raw samples onto the
    // 4.4 m grid leaves slope kinks that the tyres feel as a periodic road ripple
    const rm1 = rawSamples[(rawIdx - 1 + rawCount) % rawCount] as typeof r0;
    const r2 = rawSamples[(rawIdx + 2) % rawCount] as typeof r0;
    const [cw0, cw1, cw2, cw3] = catmullRomWeights(alpha);
    const cubic = (a: number, b: number, c: number, d: number) => cw0 * a + cw1 * b + cw2 * c + cw3 * d;
    const cx = cubic(rm1.p[0], r0.p[0], r1.p[0], r2.p[0]);
    const cy = cubic(rm1.p[1], r0.p[1], r1.p[1], r2.p[1]);
    const cz = cubic(rm1.p[2], r0.p[2], r1.p[2], r2.p[2]);
    positions.push(new THREE.Vector3(cx, cy, cz));
    // Racing-line offset (m, + right): the one line the AI drives, the HUD draws and the speed profile uses
    racingOffsetsM.push(cubic(rm1.ro, r0.ro, r1.ro, r2.ro));
    // The GT3's own lap-time line (`roGt3`); a track without one gives it the F1 line
    const roGt3 = (r: typeof r0) => (r as { roGt3?: number }).roGt3 ?? r.ro;
    gt3OffsetsM.push(cubic(roGt3(rm1), roGt3(r0), roGt3(r1), roGt3(r2)));
    widths.push(THREE.MathUtils.lerp(r0.w, r1.w, alpha));

    const meshBank = THREE.MathUtils.lerp(r0.b, r1.b, alpha);
    bankings.push(meshBank);

    const nLat = LAT_PROFILE_OFFSETS.length;
    if (
      rm1.yProf?.length === nLat &&
      r0.yProf?.length === nLat &&
      r1.yProf?.length === nLat &&
      r2.yProf?.length === nLat
    ) {
      const yp = new Array<number>(nLat);
      for (let k = 0; k < nLat; k++) {
        yp[k] = cubic(rm1.yProf[k], r0.yProf[k], r1.yProf[k], r2.yProf[k]);
      }
      yProfs.push(yp);
    } else {
      yProfs.push(
        LAT_PROFILE_OFFSETS.map((lat) => cy - Math.sin(meshBank) * lat)
      );
    }

    grips.push(THREE.MathUtils.lerp(r0.g ?? 1.0, r1.g ?? 1.0, alpha));
    const v0 = (r0 as { v?: number }).v ?? 315;
    const v1 = (r1 as { v?: number }).v ?? 315;
    aiSpeedsKmh.push(THREE.MathUtils.lerp(v0, v1, alpha));
    const near = alpha < 0.5 ? r0 : r1;
    edges.push({
      rL: THREE.MathUtils.lerp(r0.rL, r1.rL, alpha),
      rR: THREE.MathUtils.lerp(r0.rR, r1.rR, alpha),
      gL: THREE.MathUtils.lerp(r0.gL, r1.gL, alpha),
      gR: THREE.MathUtils.lerp(r0.gR, r1.gR, alpha),
      wL: THREE.MathUtils.lerp(r0.wL, r1.wL, alpha),
      wR: THREE.MathUtils.lerp(r0.wR, r1.wR, alpha),
      kL: near.kL === 1,
      kR: near.kR === 1,
    });
  }

  // Light [1, 2, 1] smoothing of the surface heights along the lap removes the remaining
  // mesh-triangulation noise (±1–2 mm per sample) while keeping crests and compressions
  {
    const n = NUM_SAMPLES;
    const ys = positions.map((p) => p.y);
    const yp = yProfs.map((row) => row.slice());
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      positions[i].y = 0.25 * ys[a] + 0.5 * ys[i] + 0.25 * ys[b];
      for (let k = 0; k < yp[i].length; k++) {
        yProfs[i][k] = 0.25 * yp[a][k] + 0.5 * yp[i][k] + 0.25 * yp[b][k];
      }
    }
  }

  // Snap the starting grid straight (s = 15..195 m) onto an exact horizontal XZ chord so straight-line
  // acceleration has no sub-centimetre lateral / heading noise — but only where the road really is collinear
  // there. On a layout whose main straight bends, the snap would pull the centreline metres off the road mesh
  // (on its banking that reads as a ~15 cm dip in the surface heights).
  const idxStart = Math.round(15 / ds);
  const idxEnd = Math.round(195 / ds);
  const pStart = positions[idxStart].clone();
  const pEnd = positions[idxEnd].clone();
  const straightDirX = pEnd.x - pStart.x;
  const straightDirZ = pEnd.z - pStart.z;
  const straightLen = Math.hypot(straightDirX, straightDirZ) || 1;
  const ux = straightDirX / straightLen;
  const uz = straightDirZ / straightLen;
  let chordDeviationM = 0;
  for (let i = idxStart; i <= idxEnd; i++) {
    const dx = positions[i].x - pStart.x;
    const dz = positions[i].z - pStart.z;
    chordDeviationM = Math.max(chordDeviationM, Math.abs(dx * uz - dz * ux));
  }
  const snapStraight = chordDeviationM < 0.05;

  for (let i = 0; snapStraight && i < NUM_SAMPLES; i++) {
    const s = i * ds;
    if (s <= 230) {
      const blend = s <= 195 ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(s, 195, 230);
      const dx = positions[i].x - pStart.x;
      const dz = positions[i].z - pStart.z;
      const projDist = dx * ux + dz * uz;
      const lineX = pStart.x + projDist * ux;
      const lineZ = pStart.z + projDist * uz;
      positions[i].x = THREE.MathUtils.lerp(positions[i].x, lineX, blend);
      positions[i].z = THREE.MathUtils.lerp(positions[i].z, lineZ, blend);
    }
  }

  // Racing-line points on the (banked) road surface: centreline + horizontal right · offset
  const racingPositions: THREE.Vector3[] = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const a = positions[(i - 2 + NUM_SAMPLES) % NUM_SAMPLES];
    const b = positions[(i + 2) % NUM_SAMPLES];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    const e = racingOffsetsM[i];
    racingPositions.push(
      new THREE.Vector3(
        positions[i].x + (-tz / tl) * e,
        positions[i].y - Math.tan(bankings[i]) * e,
        positions[i].z + (tx / tl) * e
      )
    );
  }

  const tangents: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  const curvatures: number[] = [];
  const verticalCurvatures: number[] = [];
  const slopeSins: number[] = [];
  const racingOffsetsNorm: number[] = [];
  const gt3OffsetsNorm: number[] = [];

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const prev2 = positions[(i - 2 + NUM_SAMPLES) % NUM_SAMPLES];
    const next2 = positions[(i + 2) % NUM_SAMPLES];
    const curr = positions[i];

    const tangentRaw = next2.clone().sub(prev2);
    const segLen = Math.max(0.01, tangentRaw.length());
    const slopeSin = THREE.MathUtils.clamp(tangentRaw.y / segLen, -0.28, 0.28);
    slopeSins.push(slopeSin);

    const tangent = tangentRaw.clone().normalize();
    // Horizontal right-hand unit vector in XZ plane: (tangent.x, 0, tangent.z) x (0, 1, 0) = (-tangent.z, 0, tangent.x)
    const rightFlat = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const upFlat = new THREE.Vector3()
      .crossVectors(rightFlat, tangent)
      .normalize();

    const bankRad = bankings[i];
    // Rotate surface normal around forward tangent by +bankRad so positive banking tilts right edge (binormal.y < 0) inward toward right-hand apex
    const normal = upFlat.clone().applyAxisAngle(tangent, bankRad).normalize();
    const binormal = new THREE.Vector3()
      .crossVectors(tangent, normal)
      .normalize();

    tangents.push(tangent);
    normals.push(normal);
    binormals.push(binormal);

    // Measure horizontal curvature blending the optimal racing line and centerline over a ±4 sample (±17.7m) chord
    const rPrev = racingPositions[(i - 4 + NUM_SAMPLES) % NUM_SAMPLES];
    const rCurr = racingPositions[i];
    const rNext = racingPositions[(i + 4) % NUM_SAMPLES];
    const vIn = new THREE.Vector2(
      rCurr.x - rPrev.x,
      rCurr.z - rPrev.z
    ).normalize();
    const vOut = new THREE.Vector2(
      rNext.x - rCurr.x,
      rNext.z - rCurr.z
    ).normalize();
    const cross = vIn.x * vOut.y - vIn.y * vOut.x;
    const dot = THREE.MathUtils.clamp(vIn.dot(vOut), -1, 1);
    const dThetaRace = Math.atan2(cross, dot);
    const chordLenRace = Math.max(
      1.0,
      Math.hypot(rNext.x - rPrev.x, rNext.z - rPrev.z)
    );
    const kRace = dThetaRace / (0.5 * chordLenRace);

    const cPrev = positions[(i - 4 + NUM_SAMPLES) % NUM_SAMPLES];
    const cNext = positions[(i + 4) % NUM_SAMPLES];
    const cIn = new THREE.Vector2(curr.x - cPrev.x, curr.z - cPrev.z).normalize();
    const cOut = new THREE.Vector2(cNext.x - curr.x, cNext.z - curr.z).normalize();
    const cCross = cIn.x * cOut.y - cIn.y * cOut.x;
    const cDot = THREE.MathUtils.clamp(cIn.dot(cOut), -1, 1);
    const dThetaCenter = Math.atan2(cCross, cDot);
    const chordLenCenter = Math.max(
      1.0,
      Math.hypot(cNext.x - cPrev.x, cNext.z - cPrev.z)
    );
    const kCenter = dThetaCenter / (0.5 * chordLenCenter);

    const kBlend =
      Math.abs(kCenter) > Math.abs(kRace)
        ? 0.55 * kCenter + 0.45 * kRace
        : 0.35 * kCenter + 0.65 * kRace;
    curvatures.push(kBlend);

    const prevSlope =
      (curr.y - prev2.y) / Math.max(0.5, prev2.distanceTo(curr));
    const nextSlope =
      (next2.y - curr.y) / Math.max(0.5, curr.distanceTo(next2));
    verticalCurvatures.push((nextSlope - prevSlope) / (4 * ds));

    // Normalised so that aiLineOffsetM(sample) returns the exported offset in metres
    racingOffsetsNorm.push(racingOffsetsM[i] / (widths[i] * AI_LINE_WIDTH_SCALE));
    gt3OffsetsNorm.push(gt3OffsetsM[i] / (widths[i] * AI_LINE_WIDTH_SCALE));
  }

  const samples: TrackSamplePoint[] = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const s = i * ds;
    const t = i / NUM_SAMPLES;
    const turnInfo = getTurnInfoAtS(s, totalLength);

    samples.push({
      index: i,
      s,
      t,
      position: positions[i],
      racingLinePos: racingPositions[i],
      yProf: yProfs[i],
      tangent: tangents[i],
      normal: normals[i],
      binormal: binormals[i],
      bankingRad: bankings[i],
      width: widths[i],
      curvature: curvatures[i],
      verticalCurvature: verticalCurvatures[i],
      slopeSin: slopeSins[i],
      sector: turnInfo.sector,
      turnNumber: turnInfo.turnNumber,
      turnName: turnInfo.turnName,
      runoffStyle: turnInfo.runoffStyle,
      kerbLeft: edges[i].kL,
      kerbRight: edges[i].kR,
      runoffLeftM: edges[i].rL,
      runoffRightM: edges[i].rR,
      gravelLeftM: edges[i].gL,
      gravelRightM: edges[i].gR,
      wallLeftM: edges[i].wL,
      wallRightM: edges[i].wR,
      drsZone: isInDrsZone(t),
      racingLineOffset: racingOffsetsNorm[i],
      racingLineOffsetGt3: gt3OffsetsNorm[i],
      optimalSpeedKmh: 0,
      brakingZone: 0,
      gripMultiplier: grips[i],
    });
  }

  // Target speeds along the AI line from the VF26 vehicle model (balanced aero package)
  const nominalProfile = computeSpeedProfile(samples, createVf26ProfileCarModel('balanced'));
  for (let i = 0; i < NUM_SAMPLES; i++) {
    samples[i].optimalSpeedKmh = nominalProfile.speedMs[i] * 3.6;
    samples[i].brakeLimitKmh = nominalProfile.brakeEnvelopeMs[i] * 3.6;
    samples[i].brakingZone = brakingZoneLevel(nominalProfile.speedMs, i);
  }

  // Horizontal centreline between samples: a periodic C2 cubic spline through the sample positions
  // (uniform parameter u = s / ds). Lateral offsets measured from straight chords kink at every
  // sample (≈5 cm sag at R = 50 m); a C1 Hermite with independently estimated tangents still made
  // ds/dt jump by up to 18 % at some samples. Either turns the road slope under a wheel into a
  // step every 4.4 m, i.e. a periodic vertical-velocity kick. The C2 spline keeps the parametric
  // speed and curvature continuous across samples.
  const splineDX = new Float64Array(NUM_SAMPLES);
  const splineDZ = new Float64Array(NUM_SAMPLES);
  {
    // D[i−1] + 4·D[i] + D[i+1] = 3·(P[i+1] − P[i−1]); diagonally dominant, so Gauss-Seidel converges fast
    const rhsX = new Float64Array(NUM_SAMPLES);
    const rhsZ = new Float64Array(NUM_SAMPLES);
    for (let i = 0; i < NUM_SAMPLES; i++) {
      const pn = positions[(i + 1) % NUM_SAMPLES];
      const pp = positions[(i - 1 + NUM_SAMPLES) % NUM_SAMPLES];
      rhsX[i] = 3 * (pn.x - pp.x);
      rhsZ[i] = 3 * (pn.z - pp.z);
      splineDX[i] = rhsX[i] / 6;
      splineDZ[i] = rhsZ[i] / 6;
    }
    for (let iter = 0; iter < 60; iter++) {
      for (let i = 0; i < NUM_SAMPLES; i++) {
        const ip = (i - 1 + NUM_SAMPLES) % NUM_SAMPLES;
        const inx = (i + 1) % NUM_SAMPLES;
        splineDX[i] = (rhsX[i] - splineDX[ip] - splineDX[inx]) / 4;
        splineDZ[i] = (rhsZ[i] - splineDZ[ip] - splineDZ[inx]) / 4;
      }
    }
  }
  const hTanX = new Float64Array(NUM_SAMPLES);
  const hTanZ = new Float64Array(NUM_SAMPLES);
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const len = Math.hypot(splineDX[i], splineDZ[i]) || 1;
    hTanX[i] = splineDX[i] / len;
    hTanZ[i] = splineDZ[i] / len;
  }
  /** Spline centreline point (x, z), first and second derivative w.r.t. t on segment i0 → i0+1 */
  const hermiteXZ = (i0: number, t: number) => {
    const i1 = (i0 + 1) % NUM_SAMPLES;
    const p0 = samples[i0].position;
    const p1 = samples[i1].position;
    const m0x = splineDX[i0];
    const m0z = splineDZ[i0];
    const m1x = splineDX[i1];
    const m1z = splineDZ[i1];
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const d00 = 6 * t2 - 6 * t;
    const d10 = 3 * t2 - 4 * t + 1;
    const d01 = -6 * t2 + 6 * t;
    const d11 = 3 * t2 - 2 * t;
    const e00 = 12 * t - 6;
    const e10 = 6 * t - 4;
    const e01 = -12 * t + 6;
    const e11 = 6 * t - 2;
    return {
      x: h00 * p0.x + h10 * m0x + h01 * p1.x + h11 * m1x,
      z: h00 * p0.z + h10 * m0z + h01 * p1.z + h11 * m1z,
      dx: d00 * p0.x + d10 * m0x + d01 * p1.x + d11 * m1x,
      dz: d00 * p0.z + d10 * m0z + d01 * p1.z + d11 * m1z,
      ddx: e00 * p0.x + e10 * m0x + e01 * p1.x + e11 * m1x,
      ddz: e00 * p0.z + e10 * m0z + e01 * p1.z + e11 * m1z,
    };
  };

  const getSampleAtDistance = (s: number): TrackSamplePoint => {
    const n = samples.length;
    // A non-finite s (a car state that already went NaN) would index samples[NaN] and throw
    const wrappedS = Number.isFinite(s) ? ((s % totalLength) + totalLength) % totalLength : 0;
    const exactIdx = (wrappedS / totalLength) * n;
    const idx0 = Math.floor(exactIdx) % n;
    const idx1 = (idx0 + 1) % n;
    const alpha = exactIdx - Math.floor(exactIdx);

    const s0 = samples[idx0];
    const s1 = samples[idx1];
    const sPrev = samples[(idx0 - 1 + n) % n];
    const sNext = samples[(idx1 + 1) % n];

    let interpYProf: number[] | undefined;
    if (s0.yProf && s1.yProf && sPrev.yProf && sNext.yProf) {
      const [w0, w1, w2, w3] = catmullRomWeights(alpha);
      interpYProf = new Array<number>(s0.yProf.length);
      for (let k = 0; k < s0.yProf.length; k++) {
        interpYProf[k] =
          w0 * sPrev.yProf[k] + w1 * s0.yProf[k] + w2 * s1.yProf[k] + w3 * sNext.yProf[k];
      }
    }

    return {
      ...s0,
      s: wrappedS,
      t: wrappedS / totalLength,
      position: (() => {
        const hp = hermiteXZ(idx0, alpha);
        const [w0, w1, w2, w3] = catmullRomWeights(alpha);
        const y = w0 * sPrev.position.y + w1 * s0.position.y + w2 * s1.position.y + w3 * sNext.position.y;
        return new THREE.Vector3(hp.x, y, hp.z);
      })(),
      racingLinePos:
        s0.racingLinePos && s1.racingLinePos
          ? s0.racingLinePos.clone().lerp(s1.racingLinePos, alpha)
          : undefined,
      yProf: interpYProf,
      tangent: s0.tangent.clone().lerp(s1.tangent, alpha).normalize(),
      normal: s0.normal.clone().lerp(s1.normal, alpha).normalize(),
      binormal: s0.binormal.clone().lerp(s1.binormal, alpha).normalize(),
      bankingRad: THREE.MathUtils.lerp(s0.bankingRad, s1.bankingRad, alpha),
      width: THREE.MathUtils.lerp(s0.width, s1.width, alpha),
      curvature: THREE.MathUtils.lerp(s0.curvature, s1.curvature, alpha),
      verticalCurvature: THREE.MathUtils.lerp(
        s0.verticalCurvature,
        s1.verticalCurvature,
        alpha
      ),
      slopeSin: THREE.MathUtils.lerp(s0.slopeSin, s1.slopeSin, alpha),
      racingLineOffset: THREE.MathUtils.lerp(
        s0.racingLineOffset,
        s1.racingLineOffset,
        alpha
      ),
      racingLineOffsetGt3: THREE.MathUtils.lerp(
        s0.racingLineOffsetGt3 ?? s0.racingLineOffset,
        s1.racingLineOffsetGt3 ?? s1.racingLineOffset,
        alpha
      ),
      optimalSpeedKmh: THREE.MathUtils.lerp(
        s0.optimalSpeedKmh,
        s1.optimalSpeedKmh,
        alpha
      ),
      brakeLimitKmh: THREE.MathUtils.lerp(
        s0.brakeLimitKmh ?? s0.optimalSpeedKmh,
        s1.brakeLimitKmh ?? s1.optimalSpeedKmh,
        alpha
      ),
      gripMultiplier: THREE.MathUtils.lerp(
        s0.gripMultiplier ?? 1.0,
        s1.gripMultiplier ?? 1.0,
        alpha
      ),
    };
  };

  // Horizontal unit tangents per sample, used by the continuous inverse mapping below
  /**
   * Solves for the parameter t on segment i0 → i0+1 at which the world point lies on the
   * normal of the spline centreline, i.e. (P − C(t)) · C'(t) = 0. Returns t and the signed
   * horizontal lateral offset (+ right).
   */
  const solveSegment = (worldX: number, worldZ: number, i0: number) => {
    const i1 = (i0 + 1) % NUM_SAMPLES;
    const a0 = samples[i0].position;
    const a1 = samples[i1].position;
    const dx = a1.x - a0.x;
    const dz = a1.z - a0.z;
    const rx = worldX - a0.x;
    const rz = worldZ - a0.z;
    const t0x = hTanX[i0];
    const t0z = hTanZ[i0];
    const ex = hTanX[i1] - t0x;
    const ez = hTanZ[i1] - t0z;
    // Initial guess from the chord with linearly interpolated normals: c + b·t + a·t² = 0
    const c = rx * t0x + rz * t0z;
    const b = rx * ex + rz * ez - (dx * t0x + dz * t0z);
    const a = -(dx * ex + dz * ez);
    let t = Math.abs(b) > 1e-9 ? -c / b : 0;
    for (let k = 0; k < 3; k++) {
      const df = b + 2 * a * t;
      if (Math.abs(df) < 1e-9) break;
      t -= (c + b * t + a * t * t) / df;
    }
    // Newton on f(t) = (P − C(t)) · C'(t) along the spline
    let hp = hermiteXZ(i0, t);
    for (let k = 0; k < 4; k++) {
      const px = worldX - hp.x;
      const pz = worldZ - hp.z;
      const f = px * hp.dx + pz * hp.dz;
      const df = -(hp.dx * hp.dx + hp.dz * hp.dz) + px * hp.ddx + pz * hp.ddz;
      if (Math.abs(df) < 1e-9) break;
      const step = THREE.MathUtils.clamp(f / df, -0.5, 0.5);
      t -= step;
      hp = hermiteXZ(i0, t);
      if (Math.abs(step) < 1e-7) break;
    }
    const tLen = Math.hypot(hp.dx, hp.dz) || 1;
    // Horizontal right = (−tz, tx)
    const lateralH = ((worldX - hp.x) * -hp.dz + (worldZ - hp.z) * hp.dx) / tLen;
    return { i0, i1, t, lateralH };
  };

  /**
   * Locates a world XZ point on the track. Segment boundaries are the lines through each
   * sample along its own normal, so (s, lateral) varies continuously with position.
   * (Projecting onto the polyline chords instead leaves dead wedges on the outside of every
   * bend where s stalls, which shows up as millimetre road-height steps at each sample.)
   */
  const locateWorldPointFn = (worldX: number, worldZ: number, hintS?: number) => {
    const n = NUM_SAMPLES;
    let bestIdx = 0;
    let bestDistSq = Infinity;

    if (hintS !== undefined && Number.isFinite(hintS)) {
      const wrappedHint = ((hintS % totalLength) + totalLength) % totalLength;
      const centerIdx = Math.floor((wrappedHint / totalLength) * n) % n;
      const searchRadius = 40;
      for (let offset = -searchRadius; offset <= searchRadius; offset++) {
        const idx = (centerIdx + offset + n) % n;
        const p = samples[idx].position;
        const dSq = (worldX - p.x) ** 2 + (worldZ - p.z) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = idx;
        }
      }
    }

    if (bestDistSq > 1225) {
      bestDistSq = Infinity;
      for (let i = 0; i < n; i++) {
        const p = samples[i].position;
        const dSq = (worldX - p.x) ** 2 + (worldZ - p.z) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = i;
        }
      }
    }

    // The containing segment touches the nearest sample except far off-line in tight bends
    let chosen: ReturnType<typeof solveSegment> | null = null;
    let fallback: ReturnType<typeof solveSegment> | null = null;
    let fallbackOut = Infinity;
    for (const off of [-1, 0, -2, 1]) {
      const seg = solveSegment(worldX, worldZ, (bestIdx + off + n) % n);
      if (seg.t >= 0 && seg.t <= 1) {
        if (!chosen || Math.abs(seg.lateralH) < Math.abs(chosen.lateralH)) chosen = seg;
      } else {
        const out = seg.t < 0 ? -seg.t : seg.t - 1;
        if (out < fallbackOut) {
          fallbackOut = out;
          fallback = seg;
        }
      }
      if (chosen && off === 0) break;
    }
    if (!chosen) {
      // No fallback only for a non-finite point (NaN t fails both tests): stay on the nearest sample
      chosen = solveSegment(worldX, worldZ, fallback?.i0 ?? bestIdx);
      chosen.t = Number.isFinite(chosen.t) ? THREE.MathUtils.clamp(chosen.t, 0, 1) : 0;
    }
    const s = ((((chosen.i0 + chosen.t) * ds) % totalLength) + totalLength) % totalLength;
    return { ...chosen, s };
  };

  const projectWorldToTrackFn = (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => {
    const loc = locateWorldPointFn(worldX, worldZ, hintS);
    const sample = getSampleAtDistance(loc.s);
    const bHorizLen = Math.hypot(sample.binormal.x, sample.binormal.z) || 1;
    // Account for binormal 3D tilt (cos(bankingRad)) so position + binormal * lateralOffset matches XZ
    const cosBank = Math.max(0.85, bHorizLen);
    return {
      sample,
      s: loc.s,
      lateralOffset: loc.lateralH / cosBank,
      distSq: loc.lateralH * loc.lateralH,
    };
  };

  cachedBuiltTrack = {
    id: ACTIVE_TRACK_ID,
    meshUrl: getActiveTrackMetadata().mesh?.url ?? "/tracks/rwanda/rwanda_2026.glb",
    spawnGrid: [...RWANDA_SPAWN_GRID],
    samples,
    totalLengthM: totalLength,
    totalLength,
    spline,
    getSampleAtDistance,
    projectWorldToTrack: projectWorldToTrackFn,
    locateWorldPoint: locateWorldPointFn,
  };

  return cachedBuiltTrack;
}

/** Same as `getRwandaTrackData`: the active circuit */
export const getActiveTrackData = getRwandaTrackData;

export function getTrackData(): BuiltTrackData {
  return getRwandaTrackData(1200);
}

export function sampleTrackAtDistance(s: number): TrackSamplePoint {
  return getRwandaTrackData(1200).getSampleAtDistance(s);
}

export function projectWorldToTrack(
  worldX: number,
  worldZ: number,
  hintS?: number
) {
  return getRwandaTrackData(1200).projectWorldToTrack(worldX, worldZ, hintS);
}

export function findClosestTrackSample(
  worldPos: THREE.Vector3,
  hintS?: number
): { sample: TrackSamplePoint; lateralOffset: number } {
  const proj = projectWorldToTrack(worldPos.x, worldPos.z, hintS);
  return {
    sample: proj.sample,
    lateralOffset: proj.lateralOffset,
  };
}

export function getTracksideTvCameras(): TracksideTvCameraDef[] {
  return RWANDA_TV_CAMERAS;
}

export function getActiveTvCamera(progress01: number): TracksideTvCameraDef {
  const p = ((progress01 % 1) + 1) % 1;
  for (const cam of RWANDA_TV_CAMERAS) {
    if (p >= cam.inPoint && p <= cam.outPoint) {
      return cam;
    }
  }
  return RWANDA_TV_CAMERAS[0];
}
