/**
 * Side lanes (src/lib/sim/ai/side-lanes.ts) driven on their own: for each circuit, both lanes of the F1 line and the
 * GT3's, each driven as a line by its class's car on the full physics (scripts/ai/lib/physics-lap.ts). Reports how
 * much of the lap has a lane, the lap time against the line's, frames off the road, barrier hits and the worst
 * distance from the lane, and how long building the lanes took.
 *
 *   npx tsx scripts/ai/check-lanes.ts [--tracks spielberg,monaco | --all] [--grip 0.95]
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor } from '../../src/lib/sim/ai/ai-track';
import { carLimitsFor } from '../../src/lib/sim/ai/ggv';
import { buildSideLanes } from '../../src/lib/sim/ai/side-lanes';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { physicsLap, type PhysicsLap } from './lib/physics-lap';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const grip = Number(opt('grip', '0.95'));
const index = JSON.parse(readFileSync('public/tracks/index.json', 'utf8')) as { id: string }[];
const ids = argv.includes('--all') ? index.map((e) => e.id) : opt('tracks', 'spielberg').split(',');
const f = (l: PhysicsLap) => `${Number.isFinite(l.lapS) ? l.lapS.toFixed(2) : 'DNF'} s, ${l.offTrackFrames} off, ${l.wallHits} hits, worst ${l.maxErrM.toFixed(2)} m`;
const clean = (l: PhysicsLap) => Number.isFinite(l.lapS) && l.offTrackFrames <= 12 && l.wallHits === 0 && l.maxErrM < 2.5;
let bad = 0;
for (const id of ids) {
  let raw: RawTrackJson;
  try {
    raw = JSON.parse(readFileSync(`public/tracks/${id}/track_data.json`, 'utf8')) as RawTrackJson;
  } catch {
    console.log(`${id}: no track data here`);
    continue;
  }
  setActiveTrack(id, raw);
  const track = getActiveTrackData(1200);
  if (track.pointToPoint) {
    console.log(`${id}: point to point, no lanes`);
    continue;
  }
  const t = aiTrackFor(track);
  const root = loadGlbGeometry(`public${track.meshUrl}`);
  for (const cls of ['f1', 'gt3'] as const) {
    const sim = cls === 'gt3' ? createAmgGt3Sim(track, root) : new F12026CarSim(track, root);
    const vehicle = cls === 'gt3' ? 'amg-gt3' : 'f12026-car';
    const line = new Float64Array(t.n);
    for (let i = 0; i < t.n; i++) line[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), cls);
    const t0 = performance.now();
    const lanes = buildSideLanes(t, line, (s) => sim.lateralRangeAt(s), carLimitsFor(vehicle, grip), carLimitsFor(vehicle, grip * 0.95));
    const buildMs = performance.now() - t0;
    const base = physicsLap(track, root, cls, line, grip);
    const row = [`${id} ${cls}: build ${buildMs.toFixed(0)} ms · line ${f(base)}`];
    for (const [name, lane] of [['left', lanes.left], ['right', lanes.right]] as const) {
      const cover = lane.ok.reduce((a, v) => a + v, 0) / t.n;
      const lap = physicsLap(track, root, cls, lane.n, grip);
      let minRatio = 1;
      for (let i = 0; i < t.n; i++) if (lane.ok[i]) minRatio = Math.min(minRatio, lane.ratio[i]);
      const ok = clean(lap);
      if (!ok) bad++;
      row.push(`${name} ${(100 * cover).toFixed(0)} % of the lap, ${f(lap)}, slowest ratio ${minRatio.toFixed(2)}${ok ? '' : ' · NOT CLEAN'}`);
    }
    console.log(row.join(' · '));
  }
}
console.log(bad ? `\n${bad} lane(s) not clean` : '\nAll lanes clean');
