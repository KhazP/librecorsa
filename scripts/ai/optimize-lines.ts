/**
 * Racing lines from the car's own limits: lap-time optimisation of the line on the AI grid (scripts/ai/lib/line-opt.ts),
 * validated by a full-physics AI lap tracking it (scripts/ai/lib/physics-lap.ts).
 *
 *   npx tsx scripts/ai/optimize-lines.ts --track spielberg [--car f1|gt3] [--iters 4 (sweeps per step size)] [--write] [--grip 0.95]
 *
 * Two starts (the current line, and a minimum-curvature line from the centre), each refined; the faster plan is
 * driven on the physics against the current line, and written (--write) only if its physics lap is clean and quicker.
 * The written line keeps the track data's own sample spacing (`ro` / `roGt3` in metres, `r` its world position).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor, sampleGrid } from '../../src/lib/sim/ai/ai-track';
import { carLimitsFor } from '../../src/lib/sim/ai/ggv';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { lineBoundsFromCar, LineParam, minCurvatureLine, optimiseLapTime, wallPenalty, type WallClearance } from './lib/line-opt';
import { TrackWallQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { physicsLap } from './lib/physics-lap';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'spielberg');
const line = opt('car', 'f1') as 'f1' | 'gt3';
const iters = Number(opt('iters', '3'));
const grip = Number(opt('grip', '0.95'));
const write = argv.includes('--write');
const path = `public/tracks/${trackId}/track_data.json`;

interface RawSample {
  s: number;
  p: number[];
  ro: number;
  roGt3?: number;
  r: number[];
  w: number;
  b: number;
}
const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown as RawTrackJson & { samples: RawSample[]; metadata: Record<string, unknown> };
if (trackId !== 'rwanda') setActiveTrack(trackId, raw);
const track = getActiveTrackData(1200);
const t = aiTrackFor(track);
const limits = carLimitsFor(line === 'gt3' ? 'amg-gt3' : 'f12026-car', grip);
const root = loadGlbGeometry(`public${track.meshUrl ?? '/tracks/rwanda/rwanda_2026.glb'}`);
// The line stays where this car's tracker can follow it: its usable road, lips and kerbs included
const boundsCar = line === 'gt3' ? createAmgGt3Sim(track, root) : new F12026CarSim(track, root);
const bounds = lineBoundsFromCar(t, (s) => boundsCar.lateralRangeAt(s));
const param = new LineParam(t, 6);
// The barriers each side, found by stepping out from the centreline, and the car's own barrier probes
const wallQ = root ? TrackWallQuery.fromTrackRoot(root) : null;
const walls: WallClearance | undefined = wallQ && wallQ.segmentCount > 0 ? (() => {
  const ids = new Int32Array(8);
  const scan = (i: number, side: number) => {
    for (let d = 0; d <= 12; d += 0.05) if (wallQ.near(t.x[i] + t.rx[i] * d * side, t.z[i] + t.rz[i] * d * side, 0.05, ids) > 0) return d;
    return Infinity;
  };
  const left = new Float64Array(t.n), right = new Float64Array(t.n);
  for (let i = 0; i < t.n; i++) {
    left[i] = scan(i, -1);
    right[i] = scan(i, 1);
  }
  const probes = (boundsCar as unknown as { vehicle: { wallProbePoints: { x: number; z: number }[] } }).vehicle.wallProbePoints.map((p) => ({ x: p.x, z: p.z }));
  return { left, right, probes, marginM: 0.4 };
})() : undefined;
const log = (m: string) => console.log(m);

const current = new Float64Array(t.n);
for (let i = 0; i < t.n; i++) current[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), line);

console.log(`${trackId} · ${line} · ${t.n} grid points · ${param.m} controls · grip ${grip}`);
const started = Date.now();
if (walls) console.log(`barriers: ${walls.probes.length} probes, current line ${wallPenalty(t, current, walls).toFixed(3)} m³ into the ${walls.marginM} m margin`);
const fromCurrent = optimiseLapTime(param, bounds, limits, param.fromGrid(current), { iters, log, walls });
console.log(`from the current line: plan ${fromCurrent.lapS.toFixed(3)} s (${fromCurrent.iters} iterations, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
const mc = minCurvatureLine(param, bounds, new Float64Array(param.m));
const fromMc = optimiseLapTime(param, bounds, limits, mc, { iters, log, walls });
console.log(`from minimum curvature: plan ${fromMc.lapS.toFixed(3)} s (${fromMc.iters} iterations, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
const best = fromMc.cost < fromCurrent.cost ? fromMc : fromCurrent;

const oldLap = physicsLap(track, root, line, current, grip);
const newLap = physicsLap(track, root, line, best.n, grip);
const fmt = (l: ReturnType<typeof physicsLap>) =>
  `${l.lapS.toFixed(3)} s physics (plan ${l.plan.lapS.toFixed(3)} s), ${l.offTrackFrames} off-track frames, ${l.wallHits} barrier hits, path error mean ${l.meanErrM.toFixed(2)} / worst ${l.maxErrM.toFixed(2)} m`;
console.log(`current line:   ${fmt(oldLap)}`);
console.log(`optimised line: ${fmt(newLap)}${walls ? `, ${wallPenalty(t, best.n, walls).toFixed(3)} m³ into the barrier margin` : ''}`);
const clean = newLap.offTrackFrames <= 12 && newLap.wallHits === 0 && newLap.maxErrM < 2.5 && Number.isFinite(newLap.lapS);
if (opt('dump', '')) writeFileSync(opt('dump', ''), JSON.stringify({ n: Array.from(best.n), ds: t.ds }));
const better = newLap.lapS < oldLap.lapS - 0.05 || ((oldLap.offTrackFrames > 12 || oldLap.wallHits > 0) && clean);
console.log(clean && better ? 'Using the optimised line.' : `Keeping the current line (${clean ? 'not quicker' : 'not clean'}).`);

if (write && clean && better) {
  const scale = t.lengthM / (raw.samples[raw.samples.length - 1].s + (raw.samples[1].s - raw.samples[0].s));
  for (const smp of raw.samples) {
    const s = smp.s * scale;
    const nOff = Math.round(sampleGrid(best.n, s, t.ds) * 1000) / 1000;
    if (line === 'gt3') smp.roGt3 = nOff;
    else {
      smp.ro = nOff;
      // World position of the line: the centreline moved along the flattened right vector, banking lifting it
      const i = Math.round(s / t.ds) % t.n;
      smp.r = [smp.p[0] + t.rx[i] * nOff, smp.p[1] - Math.tan(smp.b) * nOff, smp.p[2] + t.rz[i] * nOff].map((v) => Math.round(v * 1000) / 1000);
    }
  }
  const key = line === 'gt3' ? 'racingLineGt3' : 'racingLine';
  (raw.metadata as Record<string, unknown>)[key] = {
    ...((raw.metadata[key] as object) ?? {}),
    method: 'lap-time optimised on the car\'s measured limits (scripts/ai/optimize-lines.ts)',
    modelLapS: Math.round(best.lapS * 1000) / 1000,
    physicsAiLapS: Math.round(newLap.lapS * 1000) / 1000,
    planGrip: grip,
  };
  writeFileSync(path, JSON.stringify(raw));
  console.log(`Wrote ${path}`);
}
