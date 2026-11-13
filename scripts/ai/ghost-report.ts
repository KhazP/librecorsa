/**
 * Where players are quicker than the AI, corner by corner: the online boards' fastest laps (scripts/ai/fetch-ghosts.ts)
 * against the AI car's own flying lap on the full physics, on its drive plan along the stored line.
 *
 *   npx tsx scripts/ai/ghost-report.ts [--track spielberg] [--car vf26|f12026-car|amg-gt3|liana|mtr-496r] [--grip 0.97]
 *
 * Per corner segment (from the fastest point before a corner to the fastest point before the next): the AI's time and
 * the quickest player's, both minimum speeds, and how far the player's line sits from the AI's around the corner. A
 * segment where a player is quicker on much the same line is speed (the plan's limits, the tracker); one where the
 * lines part is the line. Writes $REALISM_REF/reports/race-ai/ghosts/<track>-<car>.json (local only, like the ghosts).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor } from '../../src/lib/sim/ai/ai-track';
import type { VehicleModelId } from '../../src/types/f1';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { physicsLap } from './lib/physics-lap';
import { cornerMinima, cornerSegments, ghostIndex, loadGhostLines, segmentTime } from './lib/ghosts';
import { REALISM_REF } from './lib/references';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const onlyTrack = opt('track', '');
const onlyCar = opt('car', '');
const grip = Number(opt('grip', '0.97'));
/** Lines this far apart around a corner (rms, m) count as different lines */
const LINE_APART_M = 1;

const lineOf = (car: string): 'f1' | 'gt3' => (car === 'vf26' || car === 'f12026-car' ? 'f1' : 'gt3');
const tracks = (JSON.parse(readFileSync('public/tracks/index.json', 'utf8')) as { id: string }[])
  .map((e) => e.id)
  .filter((id) => !onlyTrack || id === onlyTrack);
const index = ghostIndex();
const outDir = join(REALISM_REF, 'reports/race-ai/ghosts');
mkdirSync(outDir, { recursive: true });
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const summary: Record<string, unknown>[] = [];

for (const trackId of tracks) {
  const cars = [...new Set(index.filter((r) => r.track === trackId && r.surface !== 'wet').map((r) => r.vehicle))].filter(
    (c) => !onlyCar || c === onlyCar
  );
  if (!cars.length) continue;
  const raw = JSON.parse(readFileSync(`public/tracks/${trackId}/track_data.json`, 'utf8')) as RawTrackJson;
  setActiveTrack(trackId, raw);
  const track = getActiveTrackData(1200);
  const t = aiTrackFor(track);
  const root = loadGlbGeometry(`public${track.meshUrl}`);
  const N = t.n;
  for (const car of cars) {
    const ghosts = loadGhostLines(track, trackId, { vehicles: [car], n: N, ds: t.ds });
    const dropped = index.filter((r) => r.track === trackId && r.vehicle === car && r.surface !== 'wet').length - ghosts.length;
    if (!ghosts.length) {
      console.log(`\n${trackId} · ${car}: no usable ghost (${dropped} left out: off the road or incomplete)`);
      continue;
    }
    const line = lineOf(car);
    const current = new Float64Array(N);
    for (let i = 0; i < N; i++) current[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), line);
    const ai = physicsLap(track, root, car as VehicleModelId, current, grip);
    const corners = cornerMinima(ai.v, t.ds);
    const segs = cornerSegments(ai.v, corners);
    const best = ghosts[0];
    console.log(
      `\n${trackId} · ${car} (${line} line) · AI ${f(ai.lapS, 3)} s at grip ${grip} (${ai.offTrackFrames} off-track frames, ${ai.wallHits} barrier hits)` +
        ` · fastest player ${f(best.lapS, 3)} s · ${ghosts.length} laps${dropped ? `, ${dropped} left out` : ''}`
    );
    console.log(`  ${'corner s'.padStart(8)} ${'AI'.padStart(6)} ${'best'.padStart(6)} ${'Δ'.padStart(6)}  ${'min AI'.padStart(6)} ${'player'.padStart(6)}  ${'line Δ'.padStart(6)}  kind`);
    const rows = [];
    let lineGain = 0, speedGain = 0, aiFaster = 0, ideal = 0, missing = 0;
    for (let c = 0; c < segs.length; c++) {
      const [a, b] = segs[c];
      // Segment c runs from the straight after corner c to the straight after corner c + 1: it holds corner c + 1
      const apex = corners.length ? corners[(c + 1) % corners.length] : a;
      const aiT = segmentTime(ai.t, ai.lapS, a, b);
      let bestT = Infinity, who = -1;
      ghosts.forEach((g, k) => {
        let off = false;
        for (let i = a; i !== b; i = (i + 1) % N) if (g.out[i]) off = true;
        const dt = segmentTime(g.t, g.lapS, a, b);
        if (!off && dt < bestT) {
          bestT = dt;
          who = k;
        }
      });
      if (who < 0) {
        // Every lap left the road somewhere in this segment: no reference for it, and no ideal lap
        missing++;
        continue;
      }
      const g = ghosts[who];
      ideal += bestT;
      let minAi = Infinity, minG = Infinity, e2 = 0, ne = 0;
      for (let i = a; i !== b; i = (i + 1) % N) {
        if (Number.isFinite(ai.v[i])) minAi = Math.min(minAi, ai.v[i]);
        if (Number.isFinite(g.v[i])) minG = Math.min(minG, g.v[i]);
      }
      // The lines around the corner: 60 m before its slowest point to 40 m after
      for (let k = -30; k <= 20; k++) {
        const i = (apex + k + N) % N;
        if (Number.isFinite(g.n[i])) {
          e2 += (g.n[i] - current[i]) ** 2;
          ne++;
        }
      }
      const lineRms = ne ? Math.sqrt(e2 / ne) : NaN;
      const gain = aiT - bestT;
      const kind = gain <= 0 ? 'AI quicker' : lineRms > LINE_APART_M ? 'line' : 'speed';
      if (gain <= 0) aiFaster++;
      else if (kind === 'line') lineGain += gain;
      else speedGain += gain;
      rows.push({ fromM: a * t.ds, toM: b * t.ds, apexM: apex * t.ds, aiS: aiT, bestS: bestT, ghost: g.id, ghostLapS: g.lapS, minAiKmh: minAi * 3.6, minPlayerKmh: minG * 3.6, lineRmsM: lineRms, kind });
      console.log(
        `  ${f(apex * t.ds, 0).padStart(8)} ${f(aiT, 2).padStart(6)} ${f(bestT, 2).padStart(6)} ${f(gain, 2).padStart(6)}  ${f(minAi * 3.6, 0).padStart(6)} ${f(minG * 3.6, 0).padStart(6)}  ${f(lineRms).padStart(6)}  ${kind}`
      );
    }
    console.log(
      `  players' ideal lap ${missing ? `- (${missing} segments without a lap on the road)` : `${f(ideal, 3)} s`} · AI quicker in ${aiFaster}/${rows.length} corners · players gain ${f(lineGain, 2)} s where the lines part, ${f(speedGain, 2)} s on much the same line`
    );
    const out = {
      track: trackId,
      car,
      line,
      grip,
      ai: { lapS: ai.lapS, planLapS: ai.plan.lapS, offTrackFrames: ai.offTrackFrames, wallHits: ai.wallHits },
      players: ghosts.map((g) => ({ id: g.id, lapS: g.lapS, assists: g.assists, physics: g.physics, offRoadShare: g.offRoadShare, worstOutM: g.worstOutM, aligned: g.aligned })),
      left: dropped,
      idealS: missing ? null : ideal,
      lineGainS: lineGain,
      speedGainS: speedGain,
      rows,
    };
    writeFileSync(join(outDir, `${trackId}-${car}.json`), JSON.stringify(out, null, 1));
    summary.push({ track: trackId, car, aiS: ai.lapS, bestS: best.lapS, idealS: missing ? NaN : ideal, lineGainS: lineGain, speedGainS: speedGain, laps: ghosts.length });
  }
}
console.log('\ntrack · car: AI / fastest player / players\' ideal · gain where lines part / on the same line (s)');
for (const s of summary as { track: string; car: string; aiS: number; bestS: number; idealS: number; lineGainS: number; speedGainS: number; laps: number }[]) {
  console.log(`  ${`${s.track} · ${s.car}`.padEnd(34)} ${f(s.aiS, 2)} / ${f(s.bestS, 2)} / ${f(s.idealS, 2)} · ${f(s.lineGainS, 2)} / ${f(s.speedGainS, 2)}  (${s.laps} laps)`);
}
if (!onlyTrack && !onlyCar) writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
process.exit(0);
