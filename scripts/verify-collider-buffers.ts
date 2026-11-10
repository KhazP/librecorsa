/**
 * A track's ground and wall colliders handed over as plain buffers (`toBuffers` / `fromBuffers`), the way a worker
 * would receive them: through a structured clone, with no track mesh on the far side. The rebuilt colliders must give
 * the same answers as the ones built from the mesh.
 *
 *   npx tsx scripts/verify-collider-buffers.ts
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { createGroundHit, TrackColliderQuery, TrackWallQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { loadGlbGeometry } from './lib/glb-geometry';
import { skipSuiteWithout } from './lib/hosted-files';

skipSuiteWithout('public/tracks/monza/track_data.json', 'public/tracks/monza/monza.glb');

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(60)} ${detail}`);
  if (!ok) failures.push(name);
};

setActiveTrack('monza', JSON.parse(readFileSync('public/tracks/monza/track_data.json', 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const root = loadGlbGeometry(`public${track.meshUrl}`);

const ground = TrackColliderQuery.fromTrackRoot(root, undefined, { conformSurfaces: true });
const walls = TrackWallQuery.fromTrackRoot(root);

const groundBuffers = structuredClone(ground.toBuffers());
const wallBuffers = structuredClone(walls.toBuffers());
const bytes = (o: object) => Object.values(o).reduce((a, v) => a + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0);
const ground2 = TrackColliderQuery.fromBuffers(groundBuffers);
const walls2 = TrackWallQuery.fromBuffers(wallBuffers);
check('The clone shares no memory with the original', groundBuffers.tris.buffer !== ground.toBuffers().tris.buffer && wallBuffers.segments.buffer !== walls.segments.buffer,
  `${(bytes(groundBuffers) / 1e6).toFixed(1)} MB of ground, ${(bytes(wallBuffers) / 1e3).toFixed(0)} kB of walls`);
check('Same triangles and wall segments', ground2.triangleCount === ground.triangleCount && walls2.segmentCount === walls.segmentCount, `${ground.triangleCount} triangles, ${walls.segmentCount} segments`);

// Ground: points across the road and well off it, all round the lap
let same = 0;
let asked = 0;
let hits = 0;
const a = createGroundHit();
const b = createGroundHit();
for (let i = 0; i < 4000; i++) {
  const smp = track.getSampleAtDistance((i / 4000) * track.totalLengthM);
  const lat = ((i * 37) % 61) - 30;
  const x = smp.position.x + smp.binormal.x * lat;
  const z = smp.position.z + smp.binormal.z * lat;
  const y = smp.position.y + 2;
  const ha = ground.query(x, z, y, a);
  const hb = ground2.query(x, z, y, b);
  asked++;
  if (ha) hits++;
  if (ha === hb && (!ha || (a.height === b.height && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz && a.surface === b.surface && a.grip === b.grip && a.source === b.source))) same++;
}
check('4000 ground queries: identical height, normal, surface and grip', same === asked && hits > 3000, `${same} / ${asked} identical, ${hits} on the mesh`);

// Walls: the segments near points along both edges
let wallSame = 0;
let wallAsked = 0;
let found = 0;
const outA = new Int32Array(64);
const outB = new Int32Array(64);
for (let i = 0; i < 1500; i++) {
  const smp = track.getSampleAtDistance((i / 1500) * track.totalLengthM);
  const lat = (i % 2 ? 1 : -1) * (smp.width / 2 + 3);
  const x = smp.position.x + smp.binormal.x * lat;
  const z = smp.position.z + smp.binormal.z * lat;
  const na = walls.near(x, z, 8, outA);
  const nb = walls2.near(x, z, 8, outB);
  wallAsked++;
  found += na;
  if (na === nb && outA.subarray(0, na).every((id, k) => id === outB[k])) wallSame++;
}
check('1500 wall queries: the same segments in the same order', wallSame === wallAsked && found > 0, `${wallSame} / ${wallAsked} identical, ${found} segments found`);

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll collider buffer checks passed.');
if (failures.length) process.exitCode = 1;
