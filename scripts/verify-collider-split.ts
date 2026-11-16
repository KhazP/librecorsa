/**
 * The ground collider's crowded grid cells split into finer ones (`splitDenseCells` in TrackColliderQuery.ts) must
 * answer exactly as the whole cells did: the same height, normal, surface, grip and source for every point, through
 * `query` and through a tyre's five-point `queryMany`, on the edges of the cells and of the finer cells included. The
 * split is only there to make a query in a crowded cell cheaper; this also times that.
 *
 *   npx tsx scripts/verify-collider-split.ts [trackId ...]
 */
import { existsSync, readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { createGroundHit, TrackColliderQuery, type GroundHit } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { loadGlbGeometry } from './lib/glb-geometry';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const sameHit = (a: GroundHit, b: GroundHit) =>
  Object.is(a.height, b.height) &&
  Object.is(a.nx, b.nx) &&
  Object.is(a.ny, b.ny) &&
  Object.is(a.nz, b.nz) &&
  a.surface === b.surface &&
  Object.is(a.grip, b.grip) &&
  a.props === b.props &&
  a.source === b.source;

/** A small deterministic generator, so a failure replays */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tracks = process.argv.slice(2).length ? process.argv.slice(2) : ['spielberg', 'monaco', 'rwanda_official'];
for (const id of tracks) {
  const dataPath = `public/tracks/${id}/track_data.json`;
  if (!existsSync(dataPath)) {
    console.log(`SKIP  ${id}: no track data here (a hosted circuit not downloaded)`);
    continue;
  }
  setActiveTrack(id, JSON.parse(readFileSync(dataPath, 'utf8')) as RawTrackJson);
  const track = getActiveTrackData(1200);
  if (!existsSync(`public${track.meshUrl}`)) {
    console.log(`SKIP  ${id}: no model here (a hosted circuit not downloaded)`);
    continue;
  }
  // Each collider from its own copy of the model: fitting the surfaces changes the model it is built from
  const whole = TrackColliderQuery.fromTrackRoot(loadGlbGeometry(`public${track.meshUrl}`), undefined, { conformSurfaces: true, splitDenseCells: false });
  const split = TrackColliderQuery.fromTrackRoot(loadGlbGeometry(`public${track.meshUrl}`), undefined, { conformSurfaces: true });
  const wb = whole.toBuffers();
  const sb = split.toBuffers();
  const cells = wb.nx * wb.nz;
  const dense: number[] = [];
  let densest = 0;
  for (let c = 0; c < cells; c++) {
    const n = wb.cellStart[c + 1] - wb.cellStart[c];
    densest = Math.max(densest, n);
    if (sb.cellSplit[c] >= 0) dense.push(c);
  }
  check(`${id}: the crowded cells are split`, dense.length > 0 || densest <= 48, `${dense.length} of ${cells} cells split, the most crowded held ${densest} triangles`);

  // Points: round the lap across the road and off it, and in every split cell on a lattice through the edges of its
  // finer cells (and the cell's own), with a jitter of a few microns either side of each edge
  const r = rng(17);
  const pts: [number, number][] = [];
  for (let i = 0; i < 6000; i++) {
    const smp = track.getSampleAtDistance((i / 6000) * track.totalLengthM);
    const lat = (r() * 2 - 1) * (smp.width / 2 + 12);
    pts.push([smp.position.x + smp.binormal.x * lat, smp.position.z + smp.binormal.z * lat]);
  }
  const CELL = 4;
  for (const c of dense) {
    const k = sb.cellSplitK[c];
    const x0 = wb.minX + (c % wb.nx) * CELL;
    const z0 = wb.minZ + Math.floor(c / wb.nx) * CELL;
    for (let i = 0; i <= k; i++) {
      for (let j = 0; j <= k; j++) {
        const x = x0 + (i * CELL) / k;
        const z = z0 + (j * CELL) / k;
        pts.push([x, z], [x + 2e-6, z - 2e-6], [x - 2e-6, z + 2e-6]);
      }
    }
    for (let n = 0; n < 40; n++) pts.push([x0 + r() * CELL, z0 + r() * CELL]);
  }

  const a = createGroundHit();
  const b = createGroundHit();
  let asked = 0;
  let same = 0;
  let hits = 0;
  for (const [x, z] of pts) {
    for (const probe of [1e4, NaN]) {
      // The second probe sits just under the first hit: a layer below (a bridge's road, the ground under a kerb)
      const y = Number.isNaN(probe) ? (whole.query(x, z, 1e4, a) ? a.height - 0.05 : -1e4) : probe;
      const ha = whole.query(x, z, y, a);
      const hb = split.query(x, z, y, b);
      asked++;
      if (ha) hits++;
      if (ha === hb && (!ha || sameHit(a, b))) same++;
      else if (failures.length < 5) console.log(`  differs at (${x}, ${z}) probe ${y}`);
    }
  }
  check(`${id}: query answers the same`, same === asked && hits > asked / 3, `${same} / ${asked} identical, ${hits} on the mesh`);

  // A tyre's patch, as ContactPatch asks it: five points round a centre, the centre in full and the rest height only
  const outsA = Array.from({ length: 5 }, createGroundHit);
  const outsB = Array.from({ length: 5 }, createGroundHit);
  const xs = new Float64Array(5);
  const zs = new Float64Array(5);
  let patches = 0;
  let patchSame = 0;
  for (const [x, z] of pts) {
    const yaw = r() * Math.PI * 2;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const offs = [[0, 0], [0.16, 0], [-0.16, 0], [0, 0.2], [0, -0.2]];
    for (let i = 0; i < 5; i++) {
      xs[i] = x + offs[i][0] * c - offs[i][1] * s;
      zs[i] = z + offs[i][0] * s + offs[i][1] * c;
    }
    for (const full of [1, 5]) {
      const fa = whole.queryMany(xs, zs, 5, 1e4, outsA, full);
      const fb = split.queryMany(xs, zs, 5, 1e4, outsB, full);
      patches++;
      let ok = fa === fb;
      for (let i = 0; ok && i < 5; i++) {
        if (!((fa >> i) & 1)) continue;
        ok = i < full ? sameHit(outsA[i], outsB[i]) : Object.is(outsA[i].height, outsB[i].height);
      }
      if (ok) patchSame++;
    }
  }
  check(`${id}: a tyre's five-point queryMany answers the same`, patchSame === patches, `${patchSame} / ${patches} identical`);

  // Time: patches in the ten most crowded cells, where a car lost a frame (the best of a few rounds each)
  const crowded = [...Array(cells).keys()].sort((p, q) => wb.cellStart[q + 1] - wb.cellStart[q] - (wb.cellStart[p + 1] - wb.cellStart[p])).slice(0, 10);
  const at: [number, number][] = [];
  for (const c of crowded) {
    const x0 = wb.minX + (c % wb.nx) * CELL;
    const z0 = wb.minZ + Math.floor(c / wb.nx) * CELL;
    for (let n = 0; n < 200; n++) at.push([x0 + 0.2 + r() * (CELL - 0.4), z0 + 0.2 + r() * (CELL - 0.4)]);
  }
  const time = (q: TrackColliderQuery) => {
    const t0 = performance.now();
    for (let rep = 0; rep < 10; rep++) {
      for (const [x, z] of at) {
        for (let i = 0; i < 5; i++) {
          xs[i] = x + (i - 2) * 0.08;
          zs[i] = z + (((i * 3) % 5) - 2) * 0.08;
        }
        q.queryMany(xs, zs, 5, 1e4, outsA, 1);
      }
    }
    return ((performance.now() - t0) * 1000) / (10 * at.length);
  };
  let tw = Infinity;
  let ts = Infinity;
  for (let round = 0; round < 6; round++) {
    tw = Math.min(tw, time(whole));
    ts = Math.min(ts, time(split));
  }
  console.log(`      ${id}: a tyre's patch in the ten most crowded cells takes ${ts.toFixed(2)} µs, against ${tw.toFixed(2)} µs unsplit`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll collider split checks passed.');
if (failures.length) process.exitCode = 1;
