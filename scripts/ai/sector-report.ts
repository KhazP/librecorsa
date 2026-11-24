/**
 * A car's sector times on the stored line: its own driver (what the field races with where the car has no checked
 * plan), a drive plan at each grip asked for, and the online boards' fastest lap in that car (scripts/ai/fetch-ghosts.ts).
 *
 *   npx tsx scripts/ai/sector-report.ts --track rwanda_official_short --car liana [--grips 0.95,1] [--line gt3]
 *
 * Per sector: the time, the slowest and exit speed, and the worst distance from the line; then where in the first
 * sector each run loses to the quickest, 100 m at a time. Runs are flying laps on the full physics
 * (scripts/ai/lib/physics-lap.ts), on the line the game gives the car unless `--line` names another.
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor } from '../../src/lib/sim/ai/ai-track';
import type { RacingLineId } from '../../src/types/f1';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { physicsLap, physicsLapLine, physicsLapVehicle, type PhysicsLapCar } from './lib/physics-lap';
import { loadGhostLines } from './lib/ghosts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'rwanda_official_short');
const car = physicsLapVehicle(opt('car', 'liana') as PhysicsLapCar);
const grips = opt('grips', '0.95,1').split(',').map(Number);
const raw = JSON.parse(readFileSync(`public/tracks/${trackId}/track_data.json`, 'utf8')) as RawTrackJson & {
  sectors?: { id: number; startS: number; endS: number }[];
};
setActiveTrack(trackId, raw);
const track = getActiveTrackData(1200);
const t = aiTrackFor(track);
const root = loadGlbGeometry(`public${track.meshUrl}`);
const line = (opt('line', '') || physicsLapLine(car, track)) as RacingLineId;
const N = t.n;
const offsets = new Float64Array(N);
for (let i = 0; i < N; i++) offsets[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), line);
const scale = t.lengthM / raw.metadata.lengthMeters;
const sectors = (raw.sectors ?? [{ id: 1, startS: 0, endS: raw.metadata.lengthMeters }]).map((s) => ({
  id: s.id,
  i0: Math.round((s.startS * scale) / t.ds) % N,
  i1: Math.round((s.endS * scale) / t.ds) % N,
}));

interface Run {
  name: string;
  lapS: number;
  t: ArrayLike<number>;
  v: ArrayLike<number>;
  note: string;
}
const runs: Run[] = [];
const own = physicsLap(track, root, car, offsets, grips[0], undefined, { plan: false });
runs.push({ name: 'own driver', lapS: own.lapS, t: own.t, v: own.v, note: `${own.offTrackFrames} off, ${own.wallHits} hits, worst ${own.maxErrM.toFixed(2)} m` });
for (const g of grips) {
  const lap = physicsLap(track, root, car, offsets, g);
  runs.push({ name: `plan ${g}`, lapS: lap.lapS, t: lap.t, v: lap.v, note: `plan ${lap.plan.lapS.toFixed(3)} s, ${lap.offTrackFrames} off, ${lap.wallHits} hits, worst ${lap.maxErrM.toFixed(2)} m` });
}
const ghosts = loadGhostLines(track, trackId, { vehicles: [car], n: N, ds: t.ds });
if (ghosts.length) runs.push({ name: `player ${ghosts[0].id.slice(0, 6)}`, lapS: ghosts[0].lapS, t: ghosts[0].t, v: ghosts[0].v, note: `fastest of ${ghosts.length} on the boards` });

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
/** Time from grid point a to b on a run (its lap clock wraps at the line) */
const between = (r: Run, a: number, b: number) => {
  const ta = a === 0 ? 0 : r.t[a];
  const tb = b === 0 ? r.lapS : r.t[b];
  return tb - ta;
};
const minV = (r: Run, a: number, b: number) => {
  let m = Infinity;
  for (let i = a; i !== b; i = (i + 1) % N) if (Number.isFinite(r.v[i])) m = Math.min(m, r.v[i]);
  return m * 3.6;
};
console.log(`${trackId} · ${car} on the ${line} line`);
console.log(`${'run'.padEnd(16)}${'lap'.padStart(9)}${sectors.map((s) => `${`S${s.id}`.padStart(9)}${'min'.padStart(6)}${'exit'.padStart(6)}`).join('')}  notes`);
for (const r of runs) {
  const cells = sectors.map((s) => `${f(between(r, s.i0, s.i1)).padStart(9)}${f(minV(r, s.i0, s.i1), 0).padStart(6)}${f(r.v[s.i1] * 3.6, 0).padStart(6)}`);
  console.log(`${r.name.padEnd(16)}${f(r.lapS, 3).padStart(9)}${cells.join('')}  ${r.note}`);
}
// The first sector 100 m at a time: each run's time over the stretch and its speed at its end
const s1 = sectors[0];
const step = Math.max(1, Math.round(100 / t.ds));
console.log(`\nSector ${s1.id}, 100 m at a time (s · km/h at the end)`);
console.log(`${'to m'.padStart(6)}${runs.map((r) => r.name.padStart(16)).join('')}`);
for (let a = s1.i0; a < (s1.i1 || N); a += step) {
  const b = Math.min(a + step, s1.i1 || N) % N;
  console.log(`${f((b || N) * t.ds, 0).padStart(6)}${runs.map((r) => `${f(between(r, a, b))} · ${f(r.v[b] * 3.6, 0)}`.padStart(16)).join('')}`);
}
process.exit(0);
