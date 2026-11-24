/**
 * Racing lines from the car's own limits: lap-time optimisation of the line on the AI grid (scripts/ai/lib/line-opt.ts),
 * validated by a full-physics AI lap tracking it (scripts/ai/lib/physics-lap.ts).
 *
 *   npx tsx scripts/ai/optimize-lines.ts --track spielberg [--car f1|gt3] [--iters 4 (sweeps per step size)] [--write] [--grip 0.95]
 *       [--margin 0.4 (m kept between the car and a barrier)] [--robust-grip 1] [--ghosts] [--ac-line] [--straighten 2 [--slack 0.1]]
 *       [--prefer-ac 2 (% the AC author's line may lose)] [--verbose]
 *       [--replace (write the quickest clean line even if it is not quicker: the current one breaks a new limit)]
 *       [--edge 1.4 (m the car's centre keeps from the road's edges: a narrow road lined with barriers)]
 *       [--seed line-seed.json [--lock 650:900,2100:2400]] (scripts/line-from-lap.ts: a lap you drove as a start)
 *       [--no-mintime (skip the optimal-control start, scripts/ai/mintime/solve.py)]
 *   npx tsx scripts/ai/optimize-lines.ts --all [--write] (every circuit, both lines, one process each)
 *
 * A new circuit's lines come from here: the track converters (scripts/tracks) run it with `--write` for the F1 line
 * and the GT3's once the circuit is built, on its geometric (minimum-curvature) line.
 *
 * Starts: the minimum-lap-time line of an optimal-control solve on a single-track car (scripts/ai/mintime/solve.py, as
 * solved: a car that has to rotate, where the point-mass plan turns for free), the current line and a
 * minimum-curvature line from the centre; with `--ghosts`, also the players' lines from
 * the online boards' fastest laps of this line's cars (scripts/ai/fetch-ghosts.ts): each car's fastest lap, and a line
 * stitched from whichever lap was quickest through each corner, each driven as it is (smoothed, inside the road) and
 * refined. On Rwanda's short lap (GT3) and Spielberg (F1) in Nov 2026 they finished 0.4-1.6 s behind the other two
 * starts, so they are not run by default. Every candidate is driven on the full physics: by the f12026-car and the
 * LC26 for the F1 line, the AMG for the GT3's. The quickest clean one is written (--write) if it beats the current
 * line by more than 0.05 s (on the F1 line, the two cars' laps summed) and, driven again at `--robust-grip` (1: about
 * the most a race field plans with), stays clean for every car that is clean there on the current line: a line quick
 * at the check's grip but over the edge just above it crashed cars on Rwanda's short lap.
 * The written line keeps the track data's own sample spacing (`ro` / `roGt3` in metres, `r` its world position).
 * `--write` also refreshes what is read off the line, whether it changed or not: the braking zones of its plan
 * (`metadata.racingLine[Gt3].brakingZones`), the physics laps, and for the F1 line each turn's apex speed and gear and
 * the samples' plan speed / pedal reference (`v`, `gas`, `brk`).
 *
 * `--seed FILE`: a line to start from, one lateral offset per track sample (m, + = right; scripts/line-from-lap.ts
 * makes one from a lap saved in the game), driven as it is and refined. With `--lock s0:s1[,…]` (m along the lap) the
 * refinement leaves those stretches as seeded, and the seeded line is written whenever it is clean, quicker or not:
 * the planner's optimum can be a line no driver takes (a hairpin hugged from turn-in), so lock the driven shape there.
 *
 * On a point-to-point course (a hill climb, `metadata.pointToPoint`) the time is the run's, from rest at the start
 * line to the finish, the line keeps to the centre on the stretch with no road, and each physics check is one run
 * from the grid.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getActiveTrackData, getActiveTrackMetadata, inDeadZone, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor, sampleGrid } from '../../src/lib/sim/ai/ai-track';
import { carLimitsFor } from '../../src/lib/sim/ai/ggv';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { lineBoundsFromCar, lineCost, LineParam, minCurvatureLine, optimiseLapTime, wallPenalty, type RunSpec, type WallClearance } from './lib/line-opt';
import { TrackWallQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { physicsLap, type PhysicsLap, type PhysicsLapCar } from './lib/physics-lap';
import { cornerMinima, cornerSegments, filled, loadGhostLines, smoothLine, stitchFastest } from './lib/ghosts';
import { mintimeLine, type MintimeChassis } from './lib/mintime';
import { loadFastLane } from './lib/references';
import { roadFacing } from '../../src/lib/sim/track-colliders';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
if (argv.includes('--all')) {
  // One process per circuit and line: the track module holds one active circuit
  const pass = argv.filter((a, i) => a !== '--all' && !['--track', '--car'].includes(a) && !['--track', '--car'].includes(argv[i - 1]));
  const ids = (JSON.parse(readFileSync('public/tracks/index.json', 'utf8')) as { id: string }[]).map((e) => e.id);
  const failed: string[] = [];
  for (const id of ids) {
    for (const car of ['f1', 'gt3']) {
      console.log(`\n===== ${id} / ${car} =====`);
      const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], '--track', id, '--car', car, ...pass], { stdio: 'inherit' });
      if (r.status !== 0) failed.push(`${id}/${car}`);
    }
  }
  console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : '\nAll circuits done.');
  process.exit(failed.length ? 1 : 0);
}
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
// `--edge M`: the car's centre at least M from the road's edges (the converters' `lineMarginM`)
const edgeM = Number(opt('edge', '0'));
if (edgeM > 0) {
  for (let i = 0; i < t.n; i++) {
    const half = Math.max(0, t.width[i] / 2 - edgeM);
    bounds.lo[i] = Math.max(bounds.lo[i], -half);
    bounds.hi[i] = Math.min(bounds.hi[i], half);
    if (bounds.lo[i] > bounds.hi[i]) bounds.lo[i] = bounds.hi[i] = 0.5 * (bounds.lo[i] + bounds.hi[i]);
  }
}
// A hill climb: timed from rest at the start line to the finish, and on the stretch with no road the line keeps to
// the centre
const p2p = track.pointToPoint;
const run: RunSpec | undefined = p2p ? { finishI: Math.min(t.n - 1, Math.round(p2p.finishS / t.ds)) } : undefined;
if (p2p) for (let i = 0; i < t.n; i++) if (inDeadZone(p2p, i * t.ds)) bounds.lo[i] = bounds.hi[i] = 0;
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
const refine = (name: string, startC: Float64Array, locked?: Uint8Array) => {
  const r = optimiseLapTime(param, bounds, limits, startC, { iters, log: verbose ? log : undefined, walls, straightW, run, locked });
  console.log(`${name}: plan ${r.lapS.toFixed(3)} s (${r.iters} sweeps, ${secs()} s)`);
  candidates.push({ name, n: r.n, planS: r.lapS });
};
/** A start line driven as it is (smoothed, inside the road), then refined */
const asDrivenAndRefined = (name: string, n: ArrayLike<number>, locked?: Uint8Array) => {
  const c = param.fromGrid(smoothLine(filled(n, current), t.ds));
  const asIs = param.toGrid(c, bounds);
  const plan = lineCost(t, asIs, limits, 40, walls, 0, run);
  console.log(`${name}, as driven: plan ${plan.lapS.toFixed(3)} s`);
  candidates.push({ name: `${name}, as driven`, n: asIs, planS: plan.lapS });
  refine(`${name}, refined`, c, locked);
};

// `--seed FILE` (+ `--lock`): a driven line, one offset per track sample, onto the AI grid
const seedPath = opt('seed', '');
const lockRanges = opt('lock', '').split(',').filter(Boolean).map((r) => r.split(':').map(Number));
if (lockRanges.length && !seedPath) throw new Error('--lock keeps a seeded shape: give the line with --seed');
const seedName = 'seed';
if (seedPath) {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as number[];
  const ns = seed.length, Ls = track.totalLengthM;
  const onGrid = new Float64Array(t.n);
  for (let i = 0; i < t.n; i++) {
    const x = (((i * t.ds) % Ls) / Ls) * ns;
    const k = Math.floor(x) % ns, f = x - Math.floor(x);
    onGrid[i] = seed[k] * (1 - f) + seed[(k + 1) % ns] * f;
  }
  const locked = new Uint8Array(param.m);
  for (let k = 0; k < param.m; k++) {
    const sk = (k * t.lengthM) / param.m;
    locked[k] = lockRanges.some(([a, b]) => sk >= a && sk <= b) ? 1 : 0;
  }
  if (lockRanges.length) console.log(`Locked to the seed: ${lockRanges.map(([a, b]) => `${a}-${b} m`).join(', ')} (${locked.reduce((x, y) => x + y, 0)} of ${param.m} controls)`);
  asDrivenAndRefined(`${seedName} (${seedPath.split('/').pop()})`, onGrid, lockRanges.length ? locked : undefined);
}
// The minimum-lap-time line of a single-track car (scripts/ai/mintime/solve.py: yaw inertia, load transfer, a grip
// ellipse per axle, calibrated on the car's measured limits), as solved: a car that has to rotate, where the
// point-mass plan turns for free. On Qiddiya in Nov 2026 it tied with the refined starts (same shape, within 0.3 s on
// the physics) and was not kept. `--no-mintime` skips it (it needs uv on PATH)
const mintimeOn = !argv.includes('--no-mintime') && !(preferAcPct > 0) && !lockRanges.length;
if (mintimeOn) {
  const chassis = (boundsCar as unknown as { config?: { chassis?: MintimeChassis } }).config?.chassis;
  const vehicle = line === 'gt3' ? 'amg-gt3' : 'f12026-car';
  const startV = lineCost(t, current, limits, 0, undefined, 0, run).plan.v;
  const mt = chassis
    ? mintimeLine(t, bounds, current, startV, vehicle, chassis, { grip, run, step: Math.max(1, Math.round(4 / t.ds)), verbose, log })
    : null;
  if (!chassis) console.log('mintime: no chassis data for this car');
  else if (mt?.solved) {
    const plan = lineCost(t, mt.n, limits, 40, walls, 0, run);
    console.log(`minimum lap time (single-track car): solver ${mt.lapS.toFixed(3)} s, plan ${plan.lapS.toFixed(3)} s (${secs()} s)`);
    candidates.push({ name: 'minimum lap time (single-track car), as solved', n: mt.n, planS: plan.lapS });
  } else if (mt) console.log(`mintime: ${mt.status}; not a candidate`);
}
if (!(preferAcPct > 0) && !lockRanges.length) {
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
    const plan = lineCost(t, asIs, limits, 40, walls, 0, run);
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
  // Include all closed-wheel classes (GT3, Prototype, Classic, Road) when seeding the closed-wheel ('gt3') line
  const vehicles =
    line === 'gt3'
      ? ['lc-lmdh', 'amg-gt3', 'mtr-496r', 'bmw-m1-procar', 'porsche-934-rsr', 'nissan-r33-jgtc', 'nissan-r32-jtcc', 'chaparral-2d', 'chaparral-2d-67', 'vw-scirocco-gtx', 'liana']
      : ['lc26', 'f12026-car'];
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
    for (const [name, n] of starts) asDrivenAndRefined(name, n);
  }
}

// A hill climb's drive plan times the whole loop, not the run: no plan time beside its runs
const fmt = (l: PhysicsLap) =>
  `${l.lapS.toFixed(3)} s (${p2p ? '' : `plan ${l.plan.lapS.toFixed(3)} s, `}${l.offTrackFrames} off, ${l.wallHits} hits, worst ${l.maxErrM.toFixed(2)} m)`;
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
// `--lock`: the seeded shape is wanted on purpose, so the seeded candidates are the only ones, quicker or not
const pool = lockRanges.length ? quick.filter((c) => c.name.startsWith(seedName)) : preferAcPct > 0 ? quick.filter(acWithin) : quick;
if (preferAcPct > 0) console.log(`AC author's lines within ${preferAcPct} % of the current line (${timed(oldLaps).toFixed(3)} s): ${pool.length}`);
for (const cand of pool.sort((a, b) => timed(a.laps) - timed(b.laps))) {
  // Only a quicker line (or any clean one, when the current line is not) is worth the check
  if (!(preferAcPct > 0) && !lockRanges.length && !replace && currentClean && timed(cand.laps) >= timed(oldLaps) - 0.05 + slackS) {
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
const better = !!best && (preferAcPct > 0 || lockRanges.length > 0 || replace || timed(best.laps) < timed(oldLaps) - 0.05 + slackS || !currentClean);
if (opt('dump', '') && best) writeFileSync(opt('dump', ''), JSON.stringify({ n: Array.from(best.n), ds: t.ds, name: best.name }));
console.log(
  best && better
    ? `Using: ${best.name} (${timed(oldLaps).toFixed(3)} → ${timed(best.laps).toFixed(3)} s${judges.length > 1 ? ', laps summed' : ''}).`
    : `Keeping the current line (${!pool.length ? (lockRanges.length ? 'no clean seeded line' : preferAcPct > 0 ? `no clean AC line within ${preferAcPct} %` : 'nothing clean') : notQuicker ? 'nothing quicker' : `nothing clean at grip ${robustGrip}`}).`
);
const changed = !!best && better;
const chosen = changed && best ? best : { name: 'current line', n: current, laps: oldLaps };

if (write) {
  const L = raw.samples[raw.samples.length - 1].s + (raw.samples[1].s - raw.samples[0].s);
  const scale = t.lengthM / L;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const fin = (x: number) => (Number.isFinite(x) ? r3(x) : null);
  // The chosen line's plan: its speeds, braking zones and model time
  const final = lineCost(t, chosen.n, limits, 0, undefined, 0, run);
  const v = final.plan.v;
  const seg = final.plan.geometry.seg;
  const N = t.n;
  const accel = (i: number) => (v[(i + 1) % N] ** 2 - v[i] ** 2) / (2 * Math.max(1e-3, seg[i]));
  // Braking zones: where the plan slows faster than drag alone explains, by more than 30 km/h; stops a short coast
  // apart are one zone (one set of boards)
  const zones: { startS: number; endS: number; entryKmh: number; minKmh: number }[] = [];
  {
    const brakingAt = (i: number) => accel(i) < -6;
    let first = -1;
    for (let k = 0; k < N; k++) if (!brakingAt(k) && brakingAt((k + 1) % N)) { first = (k + 1) % N; break; }
    if (first >= 0) {
      for (let cnt = 0, i = first; cnt < N; ) {
        if (!brakingAt(i)) { i = (i + 1) % N; cnt++; continue; }
        const i0 = i;
        while (brakingAt(i) && cnt < N) { i = (i + 1) % N; cnt++; }
        if (v[i0] - v[i] > 30 / 3.6) zones.push({ startS: (i0 * t.ds) / scale, endS: (i * t.ds) / scale, entryKmh: v[i0] * 3.6, minKmh: v[i] * 3.6 });
      }
    }
    zones.sort((a, b) => a.startS - b.startS);
    for (let k = zones.length - 1; k > 0; k--) {
      const a = zones[k - 1], b = zones[k];
      if (b.startS - a.endS < 40) {
        a.endS = b.endS;
        a.entryKmh = Math.max(a.entryKmh, b.entryKmh);
        a.minKmh = b.minKmh;
        zones.splice(k, 1);
      }
    }
    // A hill climb's are the run's
    if (p2p) for (let k = zones.length - 1; k >= 0; k--) if (zones[k].startS > p2p.finishS) zones.splice(k, 1);
  }
  for (const smp of raw.samples) {
    const s = smp.s * scale;
    if (changed) {
      const nOff = r3(sampleGrid(chosen.n, s, t.ds));
      if (line === 'gt3') smp.roGt3 = nOff;
      else {
        smp.ro = nOff;
        // World position of the line: the centreline moved along the flattened right vector, banking lifting it
        const i = Math.round(s / t.ds) % t.n;
        smp.r = [smp.p[0] + t.rx[i] * nOff, smp.p[1] - Math.tan(smp.b) * nOff, smp.p[2] + t.rz[i] * nOff].map(r3);
      }
    }
    if (line === 'f1') {
      // The plan's speed and a pedal reference from its acceleration, for tools reading the samples
      const i = ((Math.round(s / t.ds) % N) + N) % N;
      const a = accel(i);
      smp.v = r1(sampleGrid(v, s, t.ds) * 3.6);
      smp.gas = a > 0.5 ? 1 : a > -6 ? 0.35 : 0;
      smp.brk = a < -6 ? Math.round(Math.min(1, -a / 40) * 100) / 100 : 0;
    }
  }
  if (line === 'f1') {
    // Each turn's apex: the plan's slowest point within 60 m of it, in the gear the first judge used at its own slowest
    const lap = chosen.laps[0];
    const reach = Math.round(60 / t.ds);
    for (const turn of (raw as unknown as { turns?: { sApprox: number; apexSpeedKmh?: number; gear?: number; description?: string }[] }).turns ?? []) {
      const c = Math.round((turn.sApprox * scale) / t.ds);
      let minV = Infinity, minPhys = Infinity, gear: number | undefined;
      for (let d = -reach; d <= reach; d++) {
        const i = (((c + d) % N) + N) % N;
        minV = Math.min(minV, v[i]);
        if (Number.isFinite(lap.v[i]) && lap.v[i] < minPhys && Number.isFinite(lap.gear[i])) {
          minPhys = lap.v[i];
          gear = lap.gear[i];
        }
      }
      turn.apexSpeedKmh = Math.round(minV * 3.6);
      if (gear !== undefined && gear > 0) turn.gear = gear;
      turn.description = turn.description?.replace(/apex \d+ km\/h in gear \d+/, `apex ${turn.apexSpeedKmh} km/h in gear ${turn.gear}`);
    }
  }
  const key = line === 'gt3' ? 'racingLineGt3' : 'racingLine';
  const meta = { ...((raw.metadata[key] as Record<string, unknown>) ?? {}) };
  if (changed) {
    meta.method = 'lap-time optimised on the car\'s measured limits (scripts/ai/optimize-lines.ts)';
    meta.start = chosen.name.replace(/ \(.*?\)/g, '');
    meta.planGrip = grip;
    if (straightW > 0) meta.straightW = straightW;
    else delete meta.straightW;
  }
  meta.modelLapS = fin(final.lapS);
  if (line === 'gt3') {
    meta.physicsLapS = fin(chosen.laps[0].lapS);
    delete meta.physicsAiLapS;
  } else {
    meta.physicsAiLapS = fin(chosen.laps[0].lapS);
    if (judges.includes('lc26')) meta.physicsLc26LapS = fin(chosen.laps[1].lapS);
  }
  meta.brakingZones = zones.map((z) => ({ startS: r1(z.startS), endS: r1(z.endS), entryKmh: Math.round(z.entryKmh), minKmh: Math.round(z.minKmh) }));
  (raw.metadata as Record<string, unknown>)[key] = meta;
  writeFileSync(path, JSON.stringify(raw));
  console.log(`Wrote ${path} (${changed ? 'new line' : 'line kept'}; ${zones.length} braking zones, model ${final.lapS.toFixed(3)} s)`);
}
