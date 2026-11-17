/**
 * Racing lines from the car's own limits: lap-time optimisation of the line on the AI grid (scripts/ai/lib/line-opt.ts),
 * validated by a full-physics AI lap tracking it (scripts/ai/lib/physics-lap.ts).
 *
 *   npx tsx scripts/ai/optimize-lines.ts --track spielberg [--car f1|gt3] [--iters 4 (sweeps per step size)] [--write] [--grip 0.95]
 *       [--margin 0.4 (m kept between the car and a barrier)] [--robust-grip 1] [--ghosts] [--ac-line] [--straighten 2 [--slack 0.1]]
 *       [--prefer-ac 2 (% the AC author's line may lose)] [--verbose]
 *       [--replace (write the quickest clean line even if it is not quicker: the current one breaks a new limit)]
 *
 * Starts: the current line and a minimum-curvature line from the centre; with `--ghosts`, also the players' lines from
 * the online boards' fastest laps of this line's cars (scripts/ai/fetch-ghosts.ts): each car's fastest lap, and a line
 * stitched from whichever lap was quickest through each corner, each driven as it is (smoothed, inside the road) and
 * refined. On Rwanda's short lap (GT3) and Spielberg (F1) in Nov 2026 they finished 0.4-1.6 s behind the other two
 * starts, so they are not run by default. Every candidate is driven on the full physics: by the f12026-car and the
 * LC26 for the F1 line, the AMG for the GT3's. The quickest clean one is written (--write) if it beats the current
 * line by more than 0.05 s (on the F1 line, the two cars' laps summed) and, driven again at `--robust-grip` (1: about
 * the most a race field plans with), stays clean for every car that is clean there on the current line: a line quick
 * at the check's grip but over the edge just above it crashed cars on Rwanda's short lap.
 * The written line keeps the track data's own sample spacing (`ro` / `roGt3` in metres, `r` its world position).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getActiveTrackData, getActiveTrackMetadata, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor, sampleGrid } from '../../src/lib/sim/ai/ai-track';
import { carLimitsFor } from '../../src/lib/sim/ai/ggv';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { lineBoundsFromCar, lineCost, LineParam, minCurvatureLine, optimiseLapTime, wallPenalty, type WallClearance } from './lib/line-opt';
import { TrackWallQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { physicsLap, type PhysicsLap, type PhysicsLapCar } from './lib/physics-lap';
import { cornerMinima, cornerSegments, filled, loadGhostLines, smoothLine, stitchFastest } from './lib/ghosts';
import { loadFastLane } from './lib/references';
import { roadFacing } from '../../src/lib/sim/track-colliders';

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
const ghostsOn = argv.includes('--ghosts');
// `--prefer-ac PCT`: write the AC author's line (refined) whenever its physics laps are within PCT % of the current
// line's (laps summed), even when slower: a line a driver took, which uses the road's width through the fast kinks
// where our planner, with grip to spare at top speed, takes the shorter inside path. The current line is taken as the
// quickest one already (from an earlier run), so the geometric starts are not run again
const preferAcPct = Number(opt('prefer-ac', '0'));
const acLineOn = argv.includes('--ac-line') || preferAcPct > 0;
// `--straighten W`: the minimum-curvature tie-break (line-opt.ts `straightW`, s·m; 2 trades a few hundredths of a
// second at most). A straightened line may then be written up to `--slack` s (0.1 with it) slower than the current one,
// laps summed: the current line is often the same optimum without the tie-break
const straightW = Number(opt('straighten', '0'));
const slackS = Number(opt('slack', straightW > 0 ? '0.1' : '0'));
const verbose = argv.includes('--verbose');
const replace = argv.includes('--replace');
const robustGrip = Number(opt('robust-grip', '1'));
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
setActiveTrack(trackId, raw);
const track = getActiveTrackData(1200);
const t = aiTrackFor(track);
const limits = carLimitsFor(line === 'gt3' ? 'amg-gt3' : 'f12026-car', grip);
const root = loadGlbGeometry(`public${track.meshUrl}`);
// The line stays where this car's tracker can follow it: its usable road, lips and kerbs included. The F1 line is the
// LC26's too: inside both cars' roads, so neither is asked onto a kerb too tall for it (the LC26 takes lower kerbs)
const boundsCar = line === 'gt3' ? createAmgGt3Sim(track, root) : new F12026CarSim(track, root);
const lc26Bounds = line === 'gt3' ? null : (vehicleModelSpec('lc26').createSim(track, root) as unknown as { lateralRangeAt?: (s: number) => [number, number] });
const bounds = lineBoundsFromCar(t, (s) => {
  const [lo, hi] = boundsCar.lateralRangeAt(s);
  const other = lc26Bounds?.lateralRangeAt?.(s);
  if (!other) return [lo, hi];
  const a = Math.max(lo, other[0]);
  const b = Math.min(hi, other[1]);
  return a <= b ? [a, b] : [0.5 * (a + b), 0.5 * (a + b)];
});
const param = new LineParam(t, 6);
// The barriers each side, found by stepping out from the centreline, and the car's own barrier probes
const wallQ = root ? TrackWallQuery.fromTrackRoot(root, getActiveTrackMetadata().mesh?.barrierMeshes, roadFacing) : null;
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
  return { left, right, probes, marginM: Number(opt('margin', '0.4')) };
})() : undefined;
const log = (m: string) => console.log(m);

const current = new Float64Array(t.n);
for (let i = 0; i < t.n; i++) current[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), line);

console.log(`${trackId} · ${line} · ${t.n} grid points · ${param.m} controls · grip ${grip}`);
const started = Date.now();
const secs = () => ((Date.now() - started) / 1000).toFixed(0);
if (walls) console.log(`barriers: ${walls.probes.length} probes, current line ${wallPenalty(t, current, walls).toFixed(3)} m³ into the ${walls.marginM} m margin`);

interface Candidate {
  name: string;
  n: Float64Array;
  planS: number;
}
const candidates: Candidate[] = [];
const refine = (name: string, startC: Float64Array) => {
  const r = optimiseLapTime(param, bounds, limits, startC, { iters, log: verbose ? log : undefined, walls, straightW });
  console.log(`${name}: plan ${r.lapS.toFixed(3)} s (${r.iters} sweeps, ${secs()} s)`);
  candidates.push({ name, n: r.n, planS: r.lapS });
};
if (!(preferAcPct > 0)) {
  refine('from the current line', param.fromGrid(current));
  refine('from minimum curvature', minCurvatureLine(param, bounds, new Float64Array(param.m)));
}

// `--ac-line`: the AC track author's own driven line (`fast_lane.ai`, a sim-grade circuit's mod) as a start too,
// as driven and refined: a line a driver took, out-in-out, where the geometric starts can settle on a line that keeps
// to the inside through a long corner
if (acLineOn) {
  const ref = loadFastLane(track, trackId, (raw.metadata.modelOffset as number[] | undefined) ?? [0, 0, 0], t.ds);
  if (!ref || ref.n.length !== t.n) console.log('--ac-line: no fast_lane.ai for this circuit on this machine');
  else {
    const known = ref.n.reduce((a, v) => a + (Number.isFinite(v) ? 1 : 0), 0);
    const c = param.fromGrid(smoothLine(filled(ref.n, current), t.ds));
    const asIs = param.toGrid(c, bounds);
    const plan = lineCost(t, asIs, limits, 40, walls);
    console.log(`AC author's line (${((100 * known) / t.n).toFixed(0)} % of the lap), as driven: plan ${plan.lapS.toFixed(3)} s`);
    candidates.push({ name: "AC author's line, as driven", n: asIs, planS: plan.lapS });
    refine("AC author's line, refined", c);
  }
}

// Who drives the candidates: the cars that run this line on drive plans
const judges: PhysicsLapCar[] = line === 'gt3' ? ['gt3'] : ['f1', 'lc26'];
const drive = (n: ArrayLike<number>) => judges.map((car) => physicsLap(track, root, car, n, grip));
const isClean = (l: PhysicsLap) => l.offTrackFrames <= 12 && l.wallHits === 0 && l.maxErrM < 2.5 && Number.isFinite(l.lapS);
const oldLaps = drive(current);

if (ghostsOn) {
  const vehicles = line === 'gt3' ? ['amg-gt3', 'mtr-496r'] : ['lc26', 'f12026-car'];
  // Corner segments from the current line's own lap (the first judge's), for stitching
  const segs = cornerSegments(oldLaps[0].v, cornerMinima(oldLaps[0].v, t.ds));
  for (const vehicle of vehicles) {
    const laps = loadGhostLines(track, trackId, { vehicles: [vehicle], n: t.n, ds: t.ds });
    if (!laps.length) continue;
    const starts: [string, Float64Array][] = [[`${vehicle} fastest player (${laps[0].lapS.toFixed(3)} s)`, laps[0].n]];
    if (laps.length > 1) {
      const st = stitchFastest(laps, segs, current);
      starts.push([`${vehicle} players stitched (${laps.length} laps, ideal ${st.idealS.toFixed(3)} s)`, st.n]);
    }
    for (const [name, n] of starts) {
      const c = param.fromGrid(smoothLine(filled(n, current), t.ds));
      const asIs = param.toGrid(c, bounds);
      const plan = lineCost(t, asIs, limits, 40, walls);
      console.log(`${name}, as driven: plan ${plan.lapS.toFixed(3)} s`);
      candidates.push({ name: `${name}, as driven`, n: asIs, planS: plan.lapS });
      refine(`${name}, refined`, c);
    }
  }
}

const fmt = (l: PhysicsLap) =>
  `${l.lapS.toFixed(3)} s (plan ${l.plan.lapS.toFixed(3)} s, ${l.offTrackFrames} off, ${l.wallHits} hits, worst ${l.maxErrM.toFixed(2)} m)`;
const sum = (ls: PhysicsLap[]) => ls.reduce((a, l) => a + l.lapS, 0);
// A judge already off the current line (the LC26 through Monaco's barriers) does not hold the others back
const mustBeClean = oldLaps.map((l) => isClean(l));
const anyClean = mustBeClean.some(Boolean);
const currentClean = oldLaps.every((l, k) => isClean(l) || (anyClean && !mustBeClean[k]));
console.log(`current line: ${oldLaps.map(fmt).join(' · ')}`);
// Robustness: the race field plans up to about this grip (fast drivers on good laps). A line that is clean at `grip`
// but leaves the road a little above it crashes cars in a race, so a judge clean on the current line here must stay
// clean on the new one
const oldRobust = judges.map((car) => physicsLap(track, root, car, current, robustGrip));
console.log(`current line at grip ${robustGrip}: ${oldRobust.map(fmt).join(' · ')}`);
const quick: { name: string; n: Float64Array; laps: PhysicsLap[] }[] = [];
for (const cand of candidates) {
  const laps = drive(cand.n);
  const clean = laps.every((l, k) => isClean(l) || (anyClean && !mustBeClean[k]));
  const wp = walls ? `, ${wallPenalty(t, cand.n, walls).toFixed(3)} m³ into the barrier margin` : '';
  console.log(`${cand.name}: ${laps.map(fmt).join(' · ')}${wp}${clean ? '' : ' · NOT CLEAN'}`);
  if (clean) quick.push({ name: cand.name, n: cand.n, laps });
}
/**
 * A line is timed by the judges clean on the current line: one excused for being off it may not finish the lap at all
 * (an infinite time), which would make every sum infinite and stop the search at the first candidate
 */
const timed = (ls: PhysicsLap[]) => ls.reduce((a, l, k) => a + (anyClean && !mustBeClean[k] ? 0 : l.lapS), 0);
let best: { name: string; n: Float64Array; laps: PhysicsLap[] } | null = null;
let notQuicker = false;
const acWithin = (cand: { name: string; laps: PhysicsLap[] }) =>
  cand.name.startsWith("AC author's line") && timed(cand.laps) <= timed(oldLaps) * (1 + preferAcPct / 100);
const pool = preferAcPct > 0 ? quick.filter(acWithin) : quick;
if (preferAcPct > 0) console.log(`AC author's lines within ${preferAcPct} % of the current line (${timed(oldLaps).toFixed(3)} s): ${pool.length}`);
for (const cand of pool.sort((a, b) => timed(a.laps) - timed(b.laps))) {
  // Only a quicker line (or any clean one, when the current line is not) is worth the check
  if (!(preferAcPct > 0) && !replace && currentClean && timed(cand.laps) >= timed(oldLaps) - 0.05 + slackS) {
    notQuicker = true;
    break;
  }
  const robust = judges.map((car) => physicsLap(track, root, car, cand.n, robustGrip));
  const holds = robust.every((l, k) => isClean(l) || !isClean(oldRobust[k]));
  console.log(`${cand.name} at grip ${robustGrip}: ${robust.map(fmt).join(' · ')}${holds ? '' : ' · NOT CLEAN'}`);
  if (holds) {
    best = cand;
    break;
  }
}
const better = !!best && (preferAcPct > 0 || replace || timed(best.laps) < timed(oldLaps) - 0.05 + slackS || !currentClean);
if (opt('dump', '') && best) writeFileSync(opt('dump', ''), JSON.stringify({ n: Array.from(best.n), ds: t.ds, name: best.name }));
console.log(
  best && better
    ? `Using: ${best.name} (${timed(oldLaps).toFixed(3)} → ${timed(best.laps).toFixed(3)} s${judges.length > 1 ? ', laps summed' : ''}).`
    : `Keeping the current line (${!pool.length ? (preferAcPct > 0 ? `no clean AC line within ${preferAcPct} %` : 'nothing clean') : notQuicker ? 'nothing quicker' : `nothing clean at grip ${robustGrip}`}).`
);
const newLap = best?.laps[0];

if (write && best && better && newLap) {
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
    modelLapS: Math.round(newLap.plan.lapS * 1000) / 1000,
    physicsAiLapS: Math.round(newLap.lapS * 1000) / 1000,
    ...(judges.includes('lc26') ? { physicsLc26LapS: Math.round(best.laps[1].lapS * 1000) / 1000 } : {}),
    start: best.name.replace(/ \(.*?\)/g, ''),
    planGrip: grip,
    ...(straightW > 0 ? { straightW } : {}),
  };
  writeFileSync(path, JSON.stringify(raw));
  console.log(`Wrote ${path}`);
}
