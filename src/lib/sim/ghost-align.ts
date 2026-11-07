/**
 * Ghosts across versions of a circuit: each lap carries a fingerprint of the track geometry it was driven on, and a
 * ghost from another version (a re-scaled, re-centred or turned scan) is moved onto this one by the similarity
 * transform (rotation, scale, translation) that best fits its path to the racing line, matched by lap fraction. The
 * approach is GhostLab's (bilel, MIT: https://github.com/bilelky/GhostLab), a Kabsch fit in the ground plane.
 *
 * A ghost without a fingerprint (an older or downloaded lap) is aligned only when its path visibly misses the road.
 * The ghost also fades out as it nears the player's car (`ghostFade`, also GhostLab's).
 */
import * as THREE from 'three';
import type { BuiltTrackData } from '@/lib/track-data';
import { LAP_SAMPLE_STRIDE, type LapRecording } from './lap-types';

/** The ghost's see-through opacity, and its fade near the player's car (GhostLab's: gone within 4 m, over 8 m more) */
export const GHOST_OPACITY = 0.3;
const GHOST_HIDE_M = 4;
const GHOST_FADE_M = 8;

/** 1 = the full ghost, 0 = gone: a smoothstep from GHOST_HIDE_M to GHOST_HIDE_M + GHOST_FADE_M from the player's car */
export function ghostFade(distM: number): number {
  const x = THREE.MathUtils.clamp((distM - GHOST_HIDE_M) / GHOST_FADE_M, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Points of the path / line matched for the fit */
const FIT_POINTS = 96;
/** A fingerprint-less ghost is aligned when this share of its path lies further than OFF_ROAD_M off the centreline */
const OFF_ROAD_SHARE = 0.25;
const OFF_ROAD_M = 15;

/** Fingerprint of a circuit's geometry: its length and a few centreline points (FNV-1a, 8 hex digits) */
export function trackGeometryKey(track: Pick<BuiltTrackData, 'totalLengthM' | 'samples' | 'getSampleAtDistance'>): string {
  const L = track.totalLengthM;
  const parts = [L.toFixed(1), String(track.samples.length)];
  for (let k = 0; k < 8; k++) {
    const p = track.getSampleAtDistance((k * L) / 8).position;
    parts.push(p.x.toFixed(1), p.z.toFixed(1));
  }
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A 2D similarity transform in the ground plane: (x, z) → b + scale · R(theta) · ((x, z) − a) */
export interface GroundTransform {
  theta: number;
  scale: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** Least-squares rotation + uniform scale + translation taking points A onto points B (paired by index) */
export function fitGroundTransform(A: readonly { x: number; z: number }[], B: readonly { x: number; z: number }[]): GroundTransform {
  const n = Math.min(A.length, B.length);
  let ax = 0;
  let az = 0;
  let bx = 0;
  let bz = 0;
  for (let i = 0; i < n; i++) {
    ax += A[i].x;
    az += A[i].z;
    bx += B[i].x;
    bz += B[i].z;
  }
  ax /= n;
  az /= n;
  bx /= n;
  bz /= n;
  let sc = 0;
  let ss = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x1 = A[i].x - ax;
    const z1 = A[i].z - az;
    const x2 = B[i].x - bx;
    const z2 = B[i].z - bz;
    sc += x1 * x2 + z1 * z2;
    ss += x1 * z2 - z1 * x2;
    na += x1 * x1 + z1 * z1;
    nb += x2 * x2 + z2 * z2;
  }
  return { theta: Math.atan2(ss, sc), scale: na > 0 ? Math.sqrt(nb / na) : 1, ax, az, bx, bz };
}

export function applyGroundTransform(T: GroundTransform, x: number, z: number): { x: number; z: number } {
  const c = Math.cos(T.theta);
  const s = Math.sin(T.theta);
  const dx = (x - T.ax) * T.scale;
  const dz = (z - T.az) * T.scale;
  return { x: T.bx + c * dx - s * dz, z: T.bz + s * dx + c * dz };
}

/** Too small a move to be worth applying (0.2°, 0.2 %, 0.5 m) */
const isNearIdentity = (T: GroundTransform) =>
  Math.abs(T.theta) < (0.2 * Math.PI) / 180 && Math.abs(T.scale - 1) < 0.002 && Math.hypot(T.bx - T.ax, T.bz - T.az) < 0.5;

/** The ghost's path at FIT_POINTS lap fractions (by its recorded track distance, over `lapLengthM`) */
function pathAtFractions(rec: LapRecording, lapLengthM: number): { x: number; z: number }[] {
  const d = rec.data;
  const n = Math.floor(d.length / LAP_SAMPLE_STRIDE);
  const out: { x: number; z: number }[] = [];
  let j = 0;
  const S = LAP_SAMPLE_STRIDE;
  for (let k = 0; k < FIT_POINTS; k++) {
    const target = (k / FIT_POINTS) * lapLengthM;
    while (j < n - 1 && d[(j + 1) * S + 1] < target) j++;
    // Interpolated between the samples either side of that distance
    const a = j * S;
    const b = Math.min(j + 1, n - 1) * S;
    const span = d[b + 1] - d[a + 1];
    const f = span > 0 ? THREE.MathUtils.clamp((target - d[a + 1]) / span, 0, 1) : 0;
    out.push({ x: d[a + 2] + (d[b + 2] - d[a + 2]) * f, z: d[a + 4] + (d[b + 4] - d[a + 4]) * f });
  }
  return out;
}

/** Share of a ghost's samples lying further than OFF_ROAD_M from the centreline of `track` */
export function offRoadShare(rec: LapRecording, track: Pick<BuiltTrackData, 'projectWorldToTrack'>): number {
  const d = rec.data;
  const n = Math.floor(d.length / LAP_SAMPLE_STRIDE);
  if (n === 0) return 0;
  const step = Math.max(1, Math.floor(n / 64));
  let off = 0;
  let seen = 0;
  for (let i = 0; i < n; i += step) {
    const o = i * LAP_SAMPLE_STRIDE;
    const p = track.projectWorldToTrack(d[o + 2], d[o + 4], d[o + 1]);
    if (Math.abs(p.lateralOffset) > OFF_ROAD_M) off++;
    seen++;
  }
  return off / seen;
}

/**
 * The ghost on this version of the circuit. Returns the recording itself when it was driven on this geometry (or
 * fits it already), else a copy moved by the best-fit ground transform and stamped with this track's fingerprint.
 */
export function alignGhostToTrack(
  rec: LapRecording,
  track: Pick<BuiltTrackData, 'totalLengthM' | 'samples' | 'getSampleAtDistance' | 'projectWorldToTrack'>
): { recording: LapRecording; aligned: boolean } {
  const key = trackGeometryKey(track);
  if (rec.trackGeometry === key) return { recording: rec, aligned: false };
  if (rec.trackGeometry === undefined && offRoadShare(rec, track) < OFF_ROAD_SHARE) return { recording: rec, aligned: false };
  const n = Math.floor(rec.data.length / LAP_SAMPLE_STRIDE);
  if (n < FIT_POINTS / 2) return { recording: rec, aligned: false };
  const lastS = rec.data[(n - 1) * LAP_SAMPLE_STRIDE + 1];
  const L = track.totalLengthM;
  // Without a stored lap length the last sample (a few metres before the line) stands in for it, unless it is within
  // 1 % of this circuit's: then it is taken to be the same length
  const oldL = rec.trackLengthM ?? (Math.abs(lastS - L) < 0.01 * L ? L : lastS);
  const line: { x: number; z: number }[] = [];
  for (let k = 0; k < FIT_POINTS; k++) {
    const smp = track.getSampleAtDistance((k / FIT_POINTS) * L);
    const p = smp.racingLinePos ?? smp.position;
    line.push({ x: p.x, z: p.z });
  }
  const T = fitGroundTransform(pathAtFractions(rec, oldL), line);
  if (isNearIdentity(T)) return { recording: { ...rec, trackGeometry: key, trackLengthM: L }, aligned: false };
  // The heading turns by −theta about +Y (the fit turns x toward z, a +Y rotation turns z toward x)
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -T.theta);
  const q = new THREE.Quaternion();
  const data = rec.data.slice();
  const sScale = oldL > 0 ? L / oldL : 1;
  for (let i = 0; i < n; i++) {
    const o = i * LAP_SAMPLE_STRIDE;
    const p = applyGroundTransform(T, data[o + 2], data[o + 4]);
    data[o + 1] *= sScale;
    data[o + 2] = p.x;
    data[o + 4] = p.z;
    q.set(data[o + 5], data[o + 6], data[o + 7], data[o + 8]).premultiply(turn);
    data[o + 5] = q.x;
    data[o + 6] = q.y;
    data[o + 7] = q.z;
    data[o + 8] = q.w;
  }
  return { recording: { ...rec, data, trackGeometry: key, trackLengthM: L }, aligned: true };
}
