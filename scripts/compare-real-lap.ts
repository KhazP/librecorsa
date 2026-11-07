/**
 * Compares an autopilot flying lap against a real car's lap telemetry: lap time, top speed and the minimum speed at
 * every corner, aligned on distance. The real lap is read from a local file and never bundled; the format is the
 * OpenF1 JSON (`car_data` samples with `date` / `speed` km/h / `throttle` / `brake`, and the `lap` entry), as written by
 * a local fetch script.
 *
 *   npx tsx scripts/compare-real-lap.ts --track suzuka --ref <path/to/suzuka_2026_Q.json> [--car vf26|f12026-car|amg-gt3]
 *       [--pace 1]
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { loadGlbGeometry } from './lib/glb-geometry';

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'suzuka')!;
const refPath = opt('ref');
const carKind = opt('car', 'vf26')!;
const pace = Number(opt('pace', '1'));
if (!refPath) throw new Error('--ref <telemetry json> is required');

setActiveTrack(trackId, JSON.parse(readFileSync(`public/tracks/${trackId}/track_data.json`, 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const L = track.totalLengthM;

// ---- Real lap: integrate speed over time for distance
interface RefJson {
  lap: { lap_duration: number; date_start: string };
  car_data: { date: string; speed: number; throttle: number; brake: number; n_gear: number }[];
}
const ref = JSON.parse(readFileSync(refPath, 'utf8')) as RefJson;
const t0 = Date.parse(ref.lap.date_start);
const real = ref.car_data
  .map((c) => ({ t: (Date.parse(c.date) - t0) / 1000, v: c.speed, thr: c.throttle, brk: c.brake }))
  .filter((c) => c.t >= 0 && c.t <= ref.lap.lap_duration)
  .sort((a, b) => a.t - b.t);
let d = 0;
const realD = real.map((c, i) => {
  if (i > 0) d += ((c.v + real[i - 1].v) / 2 / 3.6) * (c.t - real[i - 1].t);
  return d;
});
const realLen = d;

// ---- Simulated lap: autopilot from a flying start, second lap recorded
const root = carKind === 'vf26' ? null : loadGlbGeometry(`public${track.meshUrl}`);
const car: SimulatorCar =
  carKind === 'amg-gt3' ? createAmgGt3Sim(track, root) : carKind === 'f12026-car' ? new F12026CarSim(track, root) : new F1Physics2026(track);
car.resetToStartGrid(true);
car.aiAutopilot = true;
car.aiPaceScale = pace;
const DT = 1 / 120;
const sim: { t: number; s: number; v: number }[] = [];
let lap = 0;
let prevS = car.sMeters;
let lapT = 0;
let simLapTime = NaN;
for (let t = 0; t < 600 && lap < 2; t += DT) {
  car.step(DT, { throttle: 0, brake: 0 });
  const s = car.sMeters;
  if (s < prevS - L / 2) {
    if (lap === 1) simLapTime = lapT;
    lap++;
    lapT = 0;
  }
  prevS = s;
  lapT += DT;
  if (lap === 1) sim.push({ t: lapT, s, v: car.vxMs * 3.6 });
}

// ---- Resample both on lap fraction
const N = 1000;
const resample = (xs: number[], vs: number[], len: number) => {
  const out = new Float64Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const x = (i / N) * len;
    while (j < xs.length - 2 && xs[j + 1] < x) j++;
    const a = xs[j], b = xs[j + 1] ?? a;
    const f = b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : 0;
    out[i] = vs[j] + (vs[Math.min(j + 1, vs.length - 1)] - vs[j]) * f;
  }
  return out;
};
const rv = resample(realD, real.map((c) => c.v), realLen);
const sv = resample(sim.map((x) => x.s), sim.map((x) => x.v), L);

// Align: the timing line and the track's s = 0 need not coincide; pick the shift with the best match
let bestShift = 0;
let bestErr = Infinity;
for (let k = -N / 10; k <= N / 10; k++) {
  let e = 0;
  for (let i = 0; i < N; i++) e += (rv[i] - sv[(i + k + N) % N]) ** 2;
  if (e < bestErr) {
    bestErr = e;
    bestShift = k;
  }
}
const svA = Float64Array.from({ length: N }, (_, i) => sv[(i + bestShift + N) % N]);

// Corners: local minima of the real speed (±3 % of the lap), at least 25 km/h below the surrounding maxima
const corners: number[] = [];
const W = Math.round(N * 0.03);
for (let i = 0; i < N; i++) {
  let isMin = true;
  let hi = 0;
  for (let k = -W; k <= W; k++) {
    const v = rv[(i + k + N) % N];
    if (v < rv[i]) isMin = false;
    hi = Math.max(hi, v);
  }
  if (isMin && hi - rv[i] > 25 && (corners.length === 0 || i - corners[corners.length - 1] > W)) corners.push(i);
}
const minNear = (arr: Float64Array, i: number) => {
  let m = Infinity;
  for (let k = -W; k <= W; k++) m = Math.min(m, arr[(i + k + N) % N]);
  return m;
};

const f = (v: number, dd = 1) => v.toFixed(dd);
console.log(`\n${carKind} vs real lap on ${trackId} (track ${f(L, 0)} m, real lap distance ${f(realLen, 0)} m, alignment ${f((bestShift / N) * L, 0)} m)`);
console.log(`  lap time      sim ${f(simLapTime, 3)} s   real ${f(ref.lap.lap_duration, 3)} s   ${f(((simLapTime - ref.lap.lap_duration) / ref.lap.lap_duration) * 100)} %`);
console.log(`  top speed     sim ${f(Math.max(...svA))}   real ${f(Math.max(...rv))} km/h`);
console.log(`  mean speed    sim ${f(svA.reduce((a, b) => a + b, 0) / N)}   real ${f(rv.reduce((a, b) => a + b, 0) / N)} km/h`);
console.log('\n  corner  at lap %   real min   sim min   diff');
let sumPct = 0;
corners.forEach((i, n) => {
  const r = minNear(rv, i);
  const s = minNear(svA, i);
  sumPct += (s - r) / r;
  console.log(`  ${String(n + 1).padStart(6)}  ${f((i / N) * 100).padStart(8)}   ${f(r).padStart(8)}  ${f(s).padStart(8)}   ${((s - r) / r * 100 >= 0 ? '+' : '') + f(((s - r) / r) * 100)} %`);
});
console.log(`  mean corner-speed difference: ${f((sumPct / Math.max(1, corners.length)) * 100)} %`);
