/**
 * Checks that each car can drive the stored racing lines on its drive plan: a flying AI lap on the full physics
 * (scripts/ai/lib/physics-lap.ts) per car, written to the track's `metadata.aiPlans`. The field puts a car on plans only
 * where its check passed; elsewhere that car keeps its own driver.
 *
 *   npx tsx scripts/ai/check-lines.ts --track monaco [--cars lc26,f12026-car,amg-gt3,liana,...] [--grip 0.95]
 *       [--ceiling 1,1.04,1.08] [--line f1|gt3] [--own] [--json out.json] [--write]
 *
 * Each car is driven as itself on the line the game gives it (its profile's `racingLine`: the F1 cars on the F1 line,
 * every closed-wheel car on the GT3's), with its own limits. `--line` checks every car on that line instead, and then
 * only reports: a check on a line the car does not drive would put it on plans there.
 *
 * With --ceiling, a car that passes is driven again at each grip in turn until one fails, held to a tighter 2.5 m off
 * the line (a race adds traffic, dirty air and worn tyres to the flying lap): the last clean one is its `maxGrip`, the
 * plan grip the fastest AI level may use here.
 *
 * Passes: a finished lap with no barrier hit, at most 12 frames off the road and never 3 m off the line. The time against
 * the plan's is recorded, not judged: the LC26's own driver runs 2–4 % under its plan and is still safe on it.
 *
 * `--own` also drives each car on its own driver (what the field races with where it has no checked plan), for the
 * time a plan gains. `--json` writes this run's checks to a file of their own (with `ownLapS`), for runs in parallel
 * that must not each rewrite the circuit's file.
 *
 * `--write` writes the file, then reads it back: the lines it holds must be the lines that were checked.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type AiPlanCheck, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor } from '../../src/lib/sim/ai/ai-track';
import type { RacingLineId } from '../../src/types/f1';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { physicsLap, physicsLapLine, physicsLapVehicle, type PhysicsLapCar } from './lib/physics-lap';
import { isCleanLap } from './lib/line-judging';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'spielberg');
const cars = opt('cars', 'lc26,f12026-car,amg-gt3').split(',').map((c) => physicsLapVehicle(c as PhysicsLapCar));
const grip = Number(opt('grip', '0.95'));
const ceiling = opt('ceiling', '').split(',').filter(Boolean).map(Number).filter((g) => g > grip).sort((a, b) => a - b);
const forcedLine = opt('line', '') as RacingLineId | '';
const write = argv.includes('--write');
if (forcedLine && write) throw new Error('--line only reports: a check is written for the line each car drives (leave --line out)');
const path = `public/tracks/${trackId}/track_data.json`;
const raw = JSON.parse(readFileSync(path, 'utf8')) as RawTrackJson & { metadata: Record<string, unknown> };
setActiveTrack(trackId, raw);
const track = getActiveTrackData(1200);
const t = aiTrackFor(track);
const root = loadGlbGeometry(`public${track.meshUrl}`);

/** A line's offsets on the AI grid, as the field reads them */
const offsetsOf = (line: RacingLineId) => {
  const o = new Float64Array(t.n);
  for (let i = 0; i < t.n; i++) o[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), line);
  return o;
};
const lines = new Map<RacingLineId, Float64Array>();
const checks: Record<string, AiPlanCheck> = { ...((raw.metadata.aiPlans as Record<string, AiPlanCheck>) ?? {}) };
const checkedOn = new Map<string, RacingLineId>();
const ownLaps: Record<string, { lapS: number; offTrackFrames: number; wallHits: number; maxErrM: number }> = {};
for (const car of cars) {
  const line = forcedLine || physicsLapLine(car, track);
  checkedOn.set(car, line);
  let offsets = lines.get(line);
  if (!offsets) lines.set(line, (offsets = offsetsOf(line)));
  const lap = physicsLap(track, root, car, offsets, grip);
  const ok = isCleanLap(lap, 3);
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
    `${trackId} · ${car} (${line} line): ${ok ? 'PASS' : 'FAIL'} ${lap.lapS.toFixed(3)} s (plan ${lap.plan.lapS.toFixed(3)} s), ${lap.wallHits} barrier hits, ${lap.offTrackFrames} off-track frames, worst ${lap.maxErrM.toFixed(2)} m off the line`
  );
  if (ok && ceiling.length) {
    let best = grip;
    for (const g of ceiling) {
      const l = physicsLap(track, root, car, offsets, g);
      const clean = isCleanLap(l, 2.5) && l.lapS < lap.lapS;
      console.log(`  grip ${g}: ${clean ? 'clean' : 'not clean'} ${l.lapS.toFixed(3)} s, ${l.wallHits} barrier hits, ${l.offTrackFrames} off-track frames, worst ${l.maxErrM.toFixed(2)} m`);
      if (!clean) break;
      best = g;
    }
    checks[car].maxGrip = best;
  } else if (!ok) delete checks[car].maxGrip;
  if (argv.includes('--own')) {
    const o = physicsLap(track, root, car, offsets, grip, undefined, { plan: false });
    ownLaps[car] = { lapS: o.lapS, offTrackFrames: o.offTrackFrames, wallHits: o.wallHits, maxErrM: o.maxErrM };
    console.log(`  own driver: ${o.lapS.toFixed(3)} s, ${o.wallHits} barrier hits, ${o.offTrackFrames} off-track frames, worst ${o.maxErrM.toFixed(2)} m`);
  }
}
if (opt('json', '')) {
  const mine = Object.fromEntries(cars.map((c) => [c, { ...checks[c], line: checkedOn.get(c), ownLapS: ownLaps[c]?.lapS, own: ownLaps[c] }]));
  writeFileSync(opt('json', ''), JSON.stringify({ track: trackId, grip, ceiling, checks: mine }, null, 1));
}
if (write) {
  (raw.metadata as Record<string, unknown>).aiPlans = checks;
  const out = JSON.stringify(raw);
  // Read back: the file as the game will parse it gives every checked car the line it was checked on
  setActiveTrack(trackId, JSON.parse(out) as RawTrackJson);
  const back = getActiveTrackData(1200);
  for (const car of cars) {
    const line = physicsLapLine(car, back);
    const was = lines.get(checkedOn.get(car) as RacingLineId) as Float64Array;
    let worst = line === checkedOn.get(car) ? 0 : Infinity;
    for (let i = 0; i < t.n && worst < 1e-6; i++) worst = Math.max(worst, Math.abs(aiLineOffsetM(back.getSampleAtDistance(i * t.ds), line) - was[i]));
    if (!(worst < 1e-6)) {
      console.error(`Not written: read back, ${car} drives the ${line} line, not the ${checkedOn.get(car)} line it was checked on`);
      process.exit(1);
    }
  }
  writeFileSync(path, out);
  console.log(`Wrote ${path}`);
}
process.exit(0);
