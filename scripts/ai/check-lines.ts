/**
 * Checks that each car can drive the stored racing lines on its drive plan: a flying AI lap on the full physics
 * (scripts/ai/lib/physics-lap.ts) per car, written to the track's `metadata.aiPlans`. The field puts a car on plans only
 * where its check passed; elsewhere that car keeps its own driver.
 *
 *   npx tsx scripts/ai/check-lines.ts --track monaco [--cars vf26,f12026-car,amg-gt3] [--grip 0.95]
 *       [--ceiling 1,1.04,1.08] [--write]
 *
 * With --ceiling, a car that passes is driven again at each grip in turn until one fails, held to a tighter 2.5 m off
 * the line (a race adds traffic, dirty air and worn tyres to the flying lap): the last clean one is its `maxGrip`, the
 * plan grip the fastest AI level may use here.
 *
 * Passes: a finished lap with no barrier hit, at most 12 frames off the road and never 3 m off the line. The time against
 * the plan's is recorded, not judged: the VF26's own driver runs 2–4 % under its plan and is still safe on it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type AiPlanCheck, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor } from '../../src/lib/sim/ai/ai-track';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { physicsLap } from './lib/physics-lap';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'spielberg');
const cars = opt('cars', 'vf26,f12026-car,amg-gt3').split(',');
const grip = Number(opt('grip', '0.95'));
const ceiling = opt('ceiling', '').split(',').filter(Boolean).map(Number).filter((g) => g > grip).sort((a, b) => a - b);
const path = `public/tracks/${trackId}/track_data.json`;
const raw = JSON.parse(readFileSync(path, 'utf8')) as RawTrackJson & { metadata: Record<string, unknown> };
if (trackId !== 'rwanda') setActiveTrack(trackId, raw);
const track = getActiveTrackData(1200);
const t = aiTrackFor(track);
const root = loadGlbGeometry(`public${track.meshUrl ?? '/tracks/rwanda/rwanda_2026.glb'}`);

const checks: Record<string, AiPlanCheck> = { ...((raw.metadata.aiPlans as Record<string, AiPlanCheck>) ?? {}) };
for (const car of cars) {
  const kind = car === 'amg-gt3' ? 'gt3' : car === 'vf26' ? 'vf26' : 'f1';
  const offsets = new Float64Array(t.n);
  for (let i = 0; i < t.n; i++) offsets[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), kind === 'gt3' ? 'gt3' : 'f1');
  const lap = physicsLap(track, kind === 'vf26' ? null : root, kind, offsets, grip);
  const ok =
    Number.isFinite(lap.lapS) && lap.wallHits === 0 && lap.offTrackFrames <= 12 && lap.maxErrM < 3;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  checks[car] = {
    ok,
    physicsLapS: r3(lap.lapS),
    planLapS: r3(lap.plan.lapS),
    wallHits: lap.wallHits,
    offTrackFrames: lap.offTrackFrames,
    maxErrM: r3(lap.maxErrM),
    checked: new Date().toISOString().slice(0, 10),
  };
  console.log(
    `${trackId} · ${car}: ${ok ? 'PASS' : 'FAIL'} ${lap.lapS.toFixed(3)} s (plan ${lap.plan.lapS.toFixed(3)} s), ${lap.wallHits} barrier hits, ${lap.offTrackFrames} off-track frames, worst ${lap.maxErrM.toFixed(2)} m off the line`
  );
  if (ok && ceiling.length) {
    let best = grip;
    for (const g of ceiling) {
      const l = physicsLap(track, kind === 'vf26' ? null : root, kind, offsets, g);
      const clean = Number.isFinite(l.lapS) && l.wallHits === 0 && l.offTrackFrames <= 12 && l.maxErrM < 2.5 && l.lapS < lap.lapS;
      console.log(`  grip ${g}: ${clean ? 'clean' : 'not clean'} ${l.lapS.toFixed(3)} s, ${l.wallHits} barrier hits, ${l.offTrackFrames} off-track frames, worst ${l.maxErrM.toFixed(2)} m`);
      if (!clean) break;
      best = g;
    }
    checks[car].maxGrip = best;
  } else if (!ok) delete checks[car].maxGrip;
}
if (argv.includes('--write')) {
  (raw.metadata as Record<string, unknown>).aiPlans = checks;
  writeFileSync(path, JSON.stringify(raw));
  console.log(`Wrote ${path}`);
}
process.exit(0);
