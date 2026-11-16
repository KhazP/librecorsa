/**
 * The barriers of RISE Motordrome's Assetto Corsa release in both laps' track data: where the release set Tecpro in
 * front of the armco, its barrier colliders stand up to 0.75 m nearer the road (ac_merge.mjs puts them in the game's
 * model). This measures the first barrier to each side of every sample in the model before and after, and moves the
 * sample's wall distance (`wL` / `wR`) and the boundary's wall point by the difference, wherever it is over 5 cm.
 * Nothing else in the track data changes: not the lap, its length, its kerbs or its racing lines.
 *
 *   npx tsx scripts/rwanda-official/ac_walls.ts [--base <glb>] [--check]
 *
 * --check only prints what would change. The base defaults to ac_merge.mjs's base, data/rwanda_official_blender.glb.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrackWallQuery, WALL_SEGMENT_STRIDE } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { loadGlbGeometry } from '../lib/glb-geometry';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('--base', join(HERE, 'data/rwanda_official_blender.glb'));
const MODEL = join(ROOT, 'public/tracks/rwanda_official/rwanda_official.glb');
const CHECK = process.argv.includes('--check');
const MOVED_M = 0.05;

interface Sample {
  s: number;
  p: number[];
  t: number[];
  wL: number;
  wR: number;
}

const before = TrackWallQuery.fromTrackRoot(loadGlbGeometry(BASE));
const after = TrackWallQuery.fromTrackRoot(loadGlbGeometry(MODEL));
const ids = new Int32Array(4096);

/** Metres from the sample to the first barrier on one side (-1 left, 1 right), as verify-rwanda-official.ts measures it */
function firstWall(walls: TrackWallQuery, s: Sample, side: -1 | 1, reach: number): number {
  const l = Math.hypot(s.t[0], s.t[2]);
  const dx = (-s.t[2] / l) * side;
  const dz = (s.t[0] / l) * side;
  let first = Infinity;
  const count = walls.near(s.p[0], s.p[2], reach, ids);
  for (let k = 0; k < count; k++) {
    const o = ids[k] * WALL_SEGMENT_STRIDE;
    const ax = walls.segments[o] - s.p[0];
    const az = walls.segments[o + 1] - s.p[2];
    const ex = walls.segments[o + 2] - walls.segments[o];
    const ez = walls.segments[o + 3] - walls.segments[o + 1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const along = (ax * ez - az * ex) / den;
    const on = (ax * dz - az * dx) / den;
    if (along > 0 && on >= -0.02 && on <= 1.02) first = Math.min(first, along);
  }
  return first;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

for (const id of ['rwanda_official', 'rwanda_official_short']) {
  const path = join(ROOT, `public/tracks/${id}/track_data.json`);
  const text = readFileSync(path, 'utf8');
  const data = JSON.parse(text) as { samples: Sample[]; boundaries: { spacingM: number; wallLeft: number[][]; wallRight: number[][] } };
  const { samples, boundaries } = data;
  const step = Math.round(boundaries.spacingM / (samples[1].s - samples[0].s));
  let moved = 0;
  let most = 0;
  const spots: number[] = [];
  samples.forEach((s, i) => {
    for (const side of [-1, 1] as const) {
      const key = side < 0 ? 'wL' : 'wR';
      const reach = s[key] + 30;
      const was = firstWall(before, s, side, reach);
      const now = firstWall(after, s, side, reach);
      const d = now - was;
      if (!Number.isFinite(d) || Math.abs(d) <= MOVED_M) continue;
      // Already moved (a second run): the data is nearer the merged model's barrier than the Blender build's
      if (Math.abs(s[key] - now) < Math.abs(s[key] - was)) continue;
      s[key] = round(s[key] + d, 1);
      moved++;
      most = Math.max(most, Math.abs(d));
      if (!spots.length || s.s - spots[spots.length - 1] > 50) spots.push(Math.round(s.s));
      if (i % step === 0 && i / step < boundaries.wallLeft.length) {
        const l = Math.hypot(s.t[0], s.t[2]);
        const rx = -s.t[2] / l;
        const rz = s.t[0] / l;
        const pt = (side < 0 ? boundaries.wallLeft : boundaries.wallRight)[i / step];
        pt[0] = round(pt[0] + rx * side * d, 2);
        pt[2] = round(pt[2] + rz * side * d, 2);
      }
    }
  });
  console.log(`${id}: ${moved} wall distances moved (most ${most.toFixed(2)} m), around ${spots.map((x) => `${x} m`).join(', ') || 'nowhere'}`);
  // The track data is one line of JSON, which reads back to the same bytes, so only the moved values change
  if (!CHECK && moved) writeFileSync(path, JSON.stringify(data));
}
