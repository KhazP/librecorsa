/**
 * How realistic is a racing line? Corner by corner against the references: the real pole lap (OpenF1, where there is
 * one) and the AC track author's recorded line (`fast_lane.ai`, the sim-grade circuits).
 *
 *   npx tsx scripts/ai/line-report.ts --track spielberg [--car f1|gt3] [--physics] [--label baseline] [--file <track_data.json>]
 *
 * Per corner (found from the reference's speed minima): the lateral error of our stored line and (with --physics)
 * of the path the AI car actually drives, the apex position (closest approach to the inside), and the minimum speed
 * of the reference, our planning model and the physics car. The summary and per-corner rows are written as JSON to
 * $REALISM_REF/reports/race-ai/lines/ (local only, like the reference data).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveTrackData, setActiveTrack, type BuiltTrackData, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM, computeSpeedProfile, createVf26ProfileCarModel } from '../../src/lib/sim/speed-profile';
import { AMG_GT3_PROFILE_CAR, createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { loadFastLane, loadOpenF1, REALISM_REF, type RefLine } from './lib/references';
import { aiTrackFor } from '../../src/lib/sim/ai/ai-track';
import { carLimitsFor } from '../../src/lib/sim/ai/ggv';
import { makeDrivePlan } from '../../src/lib/sim/ai/drive-plan';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'spielberg');
const line = opt('car', 'f1') as 'f1' | 'gt3';
const label = opt('label', 'current');
const tracker = argv.includes('--tracker');
const physics = argv.includes('--physics') || tracker;
const gripScale = Number(opt('grip', '0.97'));
const DS = 2;

// --file: another copy of the track data (e.g. the committed line, from `git show HEAD:...`)
const raw = JSON.parse(readFileSync(opt('file', `public/tracks/${trackId}/track_data.json`), 'utf8')) as RawTrackJson & { metadata: { modelOffset?: number[] } };
if (trackId !== 'rwanda') setActiveTrack(trackId, raw);
const track: BuiltTrackData = getActiveTrackData(1200);
const L = track.totalLengthM;
const N = Math.round(L / DS);
const at = (arr: ArrayLike<number>, s: number) => arr[((Math.round(s / DS) % N) + N) % N];

// ---- Our line, planning-model speed and centreline curvature on the grid
const ourN = new Float64Array(N);
const centreK = new Float64Array(N);
const pos: { x: number; z: number }[] = [];
for (let i = 0; i < N; i++) {
  const smp = track.getSampleAtDistance(i * DS);
  ourN[i] = aiLineOffsetM(smp, line);
  pos.push({ x: smp.position.x, z: smp.position.z });
}
for (let i = 0; i < N; i++) {
  const a = pos[(i - 3 + N) % N], b = pos[i], c = pos[(i + 3) % N];
  const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
  let d = h2 - h1;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  // + right-hander (heading turning toward −x in this frame: see the sign check below)
  centreK[i] = d / (3 * DS);
}
// Orient the curvature sign so + means the inside is the + (right) side: check against the stored samples' sign
{
  let agree = 0;
  for (let i = 0; i < N; i += 5) agree += Math.sign(centreK[i]) * Math.sign(track.getSampleAtDistance(i * DS).curvature);
  if (agree < 0) for (let i = 0; i < N; i++) centreK[i] = -centreK[i];
}
const carModel = line === 'gt3' ? AMG_GT3_PROFILE_CAR : createVf26ProfileCarModel('balanced');
const prof = computeSpeedProfile(track.samples, carModel, line);
const modelV = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const s = i * DS;
  const k = (s / L) * prof.speedMs.length;
  const i0 = Math.floor(k) % prof.speedMs.length, i1 = (i0 + 1) % prof.speedMs.length, t = k - Math.floor(k);
  modelV[i] = prof.speedMs[i0] * (1 - t) + prof.speedMs[i1] * t;
}

// ---- The AI car's own flying lap on the full physics (lap 2 from a flying start)
let phys: { n: Float64Array; v: Float64Array; lapS: number; offTrackFrames: number; planLapS?: number; maxTrackErrM?: number } | null = null;
if (physics) {
  const root = loadGlbGeometry(`public${track.meshUrl ?? '/tracks/rwanda/rwanda_2026.glb'}`);
  const car: SimulatorCar = line === 'gt3' ? createAmgGt3Sim(track, root) : new F12026CarSim(track, root);
  car.assistPreset = 'pro';
  car.aiAutopilot = true;
  car.aiPaceScale = 1;
  let plan: ReturnType<typeof makeDrivePlan> | null = null;
  if (tracker) {
    const at = aiTrackFor(track);
    const offs = new Float64Array(at.n);
    for (let i = 0; i < at.n; i++) offs[i] = aiLineOffsetM(track.getSampleAtDistance(i * at.ds), line);
    plan = makeDrivePlan(at, offs, carLimitsFor(line === 'gt3' ? 'amg-gt3' : 'f12026-car', gripScale));
    car.aiPlan = plan;
  }
  car.resetToStartGrid(true, 0);
  let maxErr = 0;
  const pn = new Float64Array(N).fill(NaN), pv = new Float64Array(N).fill(NaN);
  let laps = 0, prev = car.sMeters, lapStart = 0, t = 0, off = 0;
  const dt = 1 / 120;
  while (laps < 2 && t < 600) {
    car.step(dt, {});
    t += dt;
    const s = car.sMeters;
    if (s < prev - L / 2) {
      laps++;
      if (laps === 1) lapStart = t;
    }
    prev = s;
    if (laps === 1) {
      const i = ((Math.round(s / DS) % N) + N) % N;
      pn[i] = car.lateralOffsetM;
      pv[i] = car.vxMs;
      if (car.telemetry.offTrack) off++;
      if (plan) maxErr = Math.max(maxErr, Math.abs(car.lateralOffsetM - plan.n[((Math.round(s / plan.track.ds) % plan.track.n) + plan.track.n) % plan.track.n]));
    }
  }
  phys = { n: pn, v: pv, lapS: t - lapStart, offTrackFrames: off, planLapS: plan?.lapS, maxTrackErrM: plan ? maxErr : undefined };
}

// ---- References
const refs: RefLine[] = [];
const f1Ref = line === 'f1' ? loadOpenF1(track, trackId, DS) : null;
if (f1Ref) refs.push(f1Ref);
const fl = loadFastLane(track, trackId, raw.metadata.modelOffset ?? [0, 0, 0], DS);
if (fl) refs.push(fl);

// ---- Corners from the first reference's speed (else our model's): speed minima well under the speeds around them
function corners(v: ArrayLike<number>): number[] {
  const out: number[] = [];
  const win = Math.round(60 / DS), wide = Math.round(250 / DS);
  for (let i = 0; i < N; i++) {
    const vi = v[i];
    if (!Number.isFinite(vi)) continue;
    let isMin = true, maxAround = vi;
    for (let k = -wide; k <= wide; k++) {
      const vk = v[(i + k + N) % N];
      if (!Number.isFinite(vk)) continue;
      if (Math.abs(k) <= win && vk < vi) isMin = false;
      if (vk > maxAround) maxAround = vk;
    }
    if (isMin && vi < 0.9 * maxAround && (!out.length || i - out[out.length - 1] > win)) out.push(i);
  }
  return out;
}
const cornerSource = refs[0] ?? null;
const apexIdx = corners(cornerSource ? cornerSource.v : modelV);

interface Row {
  s: number;
  refVKmh: number;
  modelVKmh: number;
  physVKmh: number | null;
  lineErrM: number;
  physErrM: number | null;
  apexDsLine: number;
  apexDsPhys: number | null;
}

function cornerRow(ref: RefLine, a: number): Row {
  const from = a - Math.round(80 / DS), to = a + Math.round(40 / DS);
  let kSum = 0;
  for (let k = a - 15; k <= a + 15; k++) kSum += centreK[(k + N) % N];
  const inside = Math.sign(kSum) || 1;
  let e2 = 0, ne = 0, p2 = 0, np = 0;
  let minRef = Infinity, minModel = Infinity, minPhys = Infinity;
  let apexRef = a, apexLine = a, apexPhys = a, bestRef = -Infinity, bestLine = -Infinity, bestPhys = -Infinity;
  for (let k = from; k <= to; k++) {
    const i = (k + N) % N;
    const rn = ref.n[i];
    if (Number.isFinite(rn)) {
      e2 += (ourN[i] - rn) ** 2;
      ne++;
      if (inside * rn > bestRef) { bestRef = inside * rn; apexRef = k; }
    }
    if (inside * ourN[i] > bestLine) { bestLine = inside * ourN[i]; apexLine = k; }
    if (Number.isFinite(ref.v[i])) minRef = Math.min(minRef, ref.v[i]);
    minModel = Math.min(minModel, modelV[i]);
    if (phys && Number.isFinite(phys.n[i])) {
      if (Number.isFinite(rn)) { p2 += (phys.n[i] - rn) ** 2; np++; }
      if (inside * phys.n[i] > bestPhys) { bestPhys = inside * phys.n[i]; apexPhys = k; }
      minPhys = Math.min(minPhys, phys.v[i]);
    }
  }
  return {
    s: ((a * DS) % L + L) % L,
    refVKmh: minRef * 3.6,
    modelVKmh: minModel * 3.6,
    physVKmh: phys ? minPhys * 3.6 : null,
    lineErrM: ne ? Math.sqrt(e2 / ne) : NaN,
    physErrM: phys && np ? Math.sqrt(p2 / np) : null,
    apexDsLine: (apexLine - apexRef) * DS,
    apexDsPhys: phys ? (apexPhys - apexRef) * DS : null,
  };
}

const f = (v: number | null, d = 1) => (v === null || !Number.isFinite(v) ? '   -' : v.toFixed(d));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const out: Record<string, unknown> = { track: trackId, line, label, lengthM: L, physicsLapS: phys?.lapS ?? null, physicsOffTrackFrames: phys?.offTrackFrames ?? null, refs: {} };
console.log(
  `\n${trackId} · ${line} line · ${label}${phys ? ` · physics AI lap ${phys.lapS.toFixed(3)} s (${phys.offTrackFrames} off-track frames)` : ''}` +
    (phys?.planLapS ? ` · tracker: plan ${phys.planLapS.toFixed(3)} s, worst path error ${phys.maxTrackErrM?.toFixed(2)} m` : '')
);
if (!refs.length) console.log('  no reference data for this track');
for (const ref of refs) {
  const rows = apexIdx.map((a) => cornerRow(ref, a));
  const extra = 'fitRmsM' in ref ? ` (registration fit ${(ref as unknown as { fitRmsM: number }).fitRmsM.toFixed(2)} m rms, real lap ${(ref as unknown as { lapS: number }).lapS.toFixed(3)} s)` : '';
  console.log(`\n  vs ${ref.source}${extra}`);
  console.log(`  ${'s (m)'.padStart(7)} ${'ref'.padStart(6)} ${'model'.padStart(6)} ${'phys'.padStart(6)}  ${'line err'.padStart(8)} ${'phys err'.padStart(8)}  ${'apex Δ line'.padStart(11)} ${'apex Δ phys'.padStart(11)}   (km/h, m)`);
  for (const r of rows) {
    console.log(
      `  ${f(r.s, 0).padStart(7)} ${f(r.refVKmh, 0).padStart(6)} ${f(r.modelVKmh, 0).padStart(6)} ${f(r.physVKmh, 0).padStart(6)}  ${f(r.lineErrM).padStart(8)} ${f(r.physErrM).padStart(8)}  ${f(r.apexDsLine, 0).padStart(11)} ${f(r.apexDsPhys, 0).padStart(11)}`
    );
  }
  const finite = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null && Number.isFinite(x));
  const summary = {
    corners: rows.length,
    lineErrM: mean(finite(rows.map((r) => r.lineErrM))),
    physErrM: mean(finite(rows.map((r) => r.physErrM))),
    apexAbsDsLine: mean(finite(rows.map((r) => Math.abs(r.apexDsLine)))),
    apexAbsDsPhys: mean(finite(rows.map((r) => (r.apexDsPhys === null ? null : Math.abs(r.apexDsPhys))))),
    modelVErrPct: mean(finite(rows.map((r) => (100 * (r.modelVKmh - r.refVKmh)) / r.refVKmh))),
    physVErrPct: mean(finite(rows.map((r) => (r.physVKmh === null ? null : (100 * (r.physVKmh - r.refVKmh)) / r.refVKmh)))),
  };
  console.log(
    `  mean: line err ${f(summary.lineErrM, 2)} m · phys err ${f(summary.physErrM, 2)} m · |apex Δ| line ${f(summary.apexAbsDsLine, 0)} m, phys ${f(summary.apexAbsDsPhys, 0)} m · corner speed model ${f(summary.modelVErrPct)} %, phys ${f(summary.physVErrPct)} %`
  );
  (out.refs as Record<string, unknown>)[ref.source] = { summary, rows, ...('fitRmsM' in ref ? { fitRmsM: (ref as unknown as { fitRmsM: number }).fitRmsM, realLapS: (ref as unknown as { lapS: number }).lapS } : {}) };
}
const dir = join(REALISM_REF, 'reports/race-ai/lines');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${trackId}-${line}-${label}.json`), JSON.stringify(out, null, 1));
