/**
 * Lap-time optimal racing line of a car class on a circuit: the fastest line for that car, not the geometric
 * (minimum-curvature) one. The F1 cars (VF26, f12026-car) share one line (`ro`); the GT3, with far less grip and
 * downforce, gets its own (`roGt3`).
 *
 * 1. Start from the track's current line of that class (for the GT3, the F1 line where it has none yet). A track
 *    fresh from the pipelines starts from their minimum-curvature line.
 * 2. Parameterise the lateral offset as a periodic cubic B-spline (one control point every K samples)
 *    and minimise the quasi-steady lap time of the car's planning model (`computeSpeedProfile`: the VF26's or the
 *    GT3's) with a shrinking-step pattern search, inside the usable width (kerbs may take two wheels).
 * 3. Validate both lines with the full physics on a flying lap (the VF26 AI / the GT3 autopilot); keep the
 *    faster clean one. The GT3's optimised line only has to stay clean and within `GT3_LAP_TOL` (0.5 s) of the
 *    starting line's physics lap. A line the physics car runs off is re-optimised with wider edge margins (twice
 *    at most) before the starting line is kept.
 * 4. Write back to the track's track_data.json:
 *    - F1: `ro`, `r`, `v`, `gas`, `brk`, the turn apex speeds / gears and the braking-board distances
 *      (`metadata.racingLine`).
 *    - GT3: `roGt3` and `metadata.racingLineGt3`.
 *
 *   npx tsx scripts/optimize-racing-line.ts                       # Rwanda, F1 line: optimise + validate + write
 *   npx tsx scripts/optimize-racing-line.ts --track suzuka --car gt3
 *   npx tsx scripts/optimize-racing-line.ts --all                 # every circuit, both lines
 *   ... --dry-run                                                 # optimise + validate only
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getRwandaTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { AMG_GT3_PROFILE_CAR, AMG_GT3_SIM_PROFILE } from '../src/lib/sim/gt3/AmgGt3Sim';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { loadGlbGeometry } from './lib/glb-geometry';
import {
  aiLineOffsetM,
  AI_LINE_WIDTH_SCALE,
  computeSpeedProfile,
  createVf26ProfileCarModel,
  type SpeedProfile,
} from '../src/lib/sim/speed-profile';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const TRACK_INDEX: { id: string; dataUrl: string }[] = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'tracks', 'index.json'), 'utf8')
);

if (process.argv.includes('--all')) {
  // One process per circuit and line: the track module holds one active circuit
  const pass = process.argv.slice(2).filter((a) => a !== '--all');
  const failed: string[] = [];
  for (const id of ['rwanda', ...TRACK_INDEX.map((e) => e.id)]) {
    for (const line of ['f1', 'gt3']) {
      console.log(`\n===== ${id} / ${line} =====`);
      const r = spawnSync(process.execPath, [...process.execArgv, __filename, '--track', id, '--car', line, ...pass], {
        stdio: 'inherit',
      });
      if (r.status !== 0) failed.push(`${id}/${line}`);
    }
  }
  console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : '\nAll circuits done.');
  process.exit(failed.length ? 1 : 0);
}

const TRACK_ID = arg('--track') ?? 'rwanda';
const LINE = (arg('--car') ?? 'f1') as 'f1' | 'gt3';
if (LINE !== 'f1' && LINE !== 'gt3') throw new Error(`--car must be f1 or gt3, not ${LINE}`);
const dataUrl = TRACK_INDEX.find((e) => e.id === TRACK_ID)?.dataUrl ?? `/tracks/${TRACK_ID}/track_data.json`;
const JSON_PATH = path.join(ROOT, 'public', dataUrl.replace(/^\//, ''));
setActiveTrack(TRACK_ID, JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) as RawTrackJson);
console.log(`${TRACK_ID}: ${LINE === 'f1' ? 'F1 line (VF26 / f12026-car)' : 'GT3 line'}`);

/** Car-centre margin to the asphalt edge (m): plain edge / kerb side (two wheels on the kerb) */
const EDGE_MARGIN_M = Number(process.env.EDGE_M ?? 1.25);
const KERB_MARGIN_M = Number(process.env.KERB_M ?? 0.7);
/** Samples per B-spline control point (~26 m) */
const K = 6;
/** Curvature-smoothness weight on the control-point second difference (s/m²) */
const SMOOTH_W = Number(process.env.SMOOTH_W ?? 0.0015);
/**
 * Grip margin of the optimisation model. The physics AI drives the shared profile at the limit,
 * so a line tuned to the model's exact grip is not one it can hold; optimise with a little less.
 */
const OPT_MU_SCALE = Number(process.env.OPT_MU ?? 0.95);

const track = getRwandaTrackData(1200);
const samples = track.samples;
const n = samples.length;
const car = LINE === 'gt3' ? AMG_GT3_PROFILE_CAR : createVf26ProfileCarModel('balanced');
const optCar = { ...car, muLat: car.muLat * OPT_MU_SCALE, muLong: car.muLong * OPT_MU_SCALE };

// ---------- bounds ----------
const lo = new Float64Array(n);
const hi = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const half = samples[i].width / 2;
  // A kerb flag a few samples away still counts (kerbs start before the turn-in point)
  let kL = false;
  let kR = false;
  for (let k = -3; k <= 3; k++) {
    const sp = samples[(i + k + n) % n];
    kL ||= sp.kerbLeft;
    kR ||= sp.kerbRight;
  }
  lo[i] = -(half - (kL ? KERB_MARGIN_M : EDGE_MARGIN_M));
  hi[i] = half - (kR ? KERB_MARGIN_M : EDGE_MARGIN_M);
}

// ---------- lap time of a line ----------
function applyLine(e: Float64Array): void {
  for (let i = 0; i < n; i++) {
    const norm = e[i] / (samples[i].width * AI_LINE_WIDTH_SCALE);
    if (LINE === 'gt3') samples[i].racingLineOffsetGt3 = norm;
    else samples[i].racingLineOffset = norm;
  }
}
function lapTimeOf(profile: SpeedProfile): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    t += (2 * profile.segLenM[i]) / Math.max(1, profile.speedMs[i] + profile.speedMs[j]);
  }
  return t;
}
function evalLine(e: Float64Array, model = car): { lap: number; profile: SpeedProfile } {
  applyLine(e);
  const profile = computeSpeedProfile(samples, model, LINE);
  return { lap: lapTimeOf(profile), profile };
}

// ---------- periodic cubic B-spline ----------
const m = Math.floor(n / K);
const kSpan = n / m;
const bIdx = new Int32Array(n * 4);
const bW = new Float64Array(n * 4);
for (let i = 0; i < n; i++) {
  const x = i / kSpan;
  const j = Math.floor(x);
  const u = x - j;
  const w = [
    (1 - u) ** 3 / 6,
    (3 * u ** 3 - 6 * u ** 2 + 4) / 6,
    (-3 * u ** 3 + 3 * u ** 2 + 3 * u + 1) / 6,
    u ** 3 / 6,
  ];
  for (let q = 0; q < 4; q++) {
    bIdx[i * 4 + q] = (j - 1 + q + m) % m;
    bW[i * 4 + q] = w[q];
  }
}
function splineToLine(c: Float64Array, out: Float64Array): Float64Array {
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let q = 0; q < 4; q++) v += bW[i * 4 + q] * c[bIdx[i * 4 + q]];
    out[i] = Math.min(hi[i], Math.max(lo[i], v));
  }
  return out;
}
function boundViolation(c: Float64Array): number {
  let p = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let q = 0; q < 4; q++) v += bW[i * 4 + q] * c[bIdx[i * 4 + q]];
    const over = Math.max(0, v - hi[i], lo[i] - v);
    p += over * over;
  }
  return p;
}
function smoothness(c: Float64Array): number {
  let p = 0;
  for (let j = 0; j < m; j++) {
    const d = c[(j - 1 + m) % m] - 2 * c[j] + c[(j + 1) % m];
    p += d * d;
  }
  return p;
}

const lineBuf = new Float64Array(n);
function cost(c: Float64Array): number {
  return evalLine(splineToLine(c, lineBuf), optCar).lap + 20 * boundViolation(c) + SMOOTH_W * smoothness(c);
}

// ---------- initial line: the track's current line of this class, fitted to the spline ----------
const e0 = new Float64Array(n);
for (let i = 0; i < n; i++) e0[i] = Math.min(hi[i], Math.max(lo[i], aiLineOffsetM(samples[i], LINE)));
const c = new Float64Array(m);
for (let j = 0; j < m; j++) c[j] = e0[Math.round(j * kSpan) % n];
for (let it = 0; it < 30; it++) {
  const cur = splineToLine(c, new Float64Array(n));
  for (let j = 0; j < m; j++) {
    const i = Math.round(j * kSpan) % n;
    c[j] += 0.8 * (e0[i] - cur[i]);
  }
}

const base = evalLine(e0);
const lapStart = base.lap;
console.log(`Starting line (track_data.json ${LINE === 'gt3' ? 'roGt3' : 'ro'}): model lap ${lapStart.toFixed(3)} s`);

// ---------- pattern search ----------
const t0 = Date.now();
let best = cost(c);
let evals = 0;
for (const delta of [0.8, 0.5, 0.3, 0.18, 0.1, 0.05]) {
  for (let sweep = 0; sweep < 4; sweep++) {
    let improved = 0;
    for (let j = 0; j < m; j++) {
      const orig = c[j];
      let accepted = false;
      for (const dir of [1, -1]) {
        c[j] = orig + dir * delta;
        const v = cost(c);
        evals++;
        if (v < best - 1e-5) {
          best = v;
          accepted = true;
          improved++;
          // keep moving in the same direction while it pays
          for (let step = 0; step < 8; step++) {
            const keep = c[j];
            c[j] += dir * delta;
            const v2 = cost(c);
            evals++;
            if (v2 < best - 1e-5) best = v2;
            else {
              c[j] = keep;
              break;
            }
          }
          break;
        }
      }
      if (!accepted) c[j] = orig;
    }
    if (improved === 0) break;
  }
  const lapNow = evalLine(splineToLine(c, lineBuf)).lap;
  console.log(`  δ=${delta.toFixed(2)} m  model lap ${lapNow.toFixed(3)} s  (${evals} evals, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

const eOpt = splineToLine(c, new Float64Array(n));
const opt = evalLine(eOpt);
console.log(`Optimised line: model lap ${opt.lap.toFixed(3)} s (${(lapStart - opt.lap).toFixed(3)} s faster)`);

// ---------- physics validation: flying lap with the full AI ----------
interface PhysicsLap {
  lapS: number | null;
  offTrack: number;
  brakeOnsets: number[];
  trace: { s: number; kmh: number; gear: number }[];
}
const glbRoot = LINE === 'gt3' ? loadGlbGeometry(path.join(ROOT, 'public', track.meshUrl ?? '/tracks/rwanda/rwanda_2026.glb')) : null;
/** GT3 autopilot pace: a share of its own limit speed, as a driver after a clean lap */
const GT3_PACE = Number(process.env.GT3_PACE ?? 0.95);
let gt3Runs = 0;
function physicsLap(e: Float64Array): PhysicsLap {
  applyLine(e);
  let sim: F1Physics2026 | F12026CarSim;
  if (LINE === 'gt3') {
    // A fresh profile id per run: the autopilot's own speed plan and the braking guide are cached per car id
    const gt3 = new F12026CarSim(track, glbRoot, { ...AMG_GT3_SIM_PROFILE, id: `amg-gt3-opt${gt3Runs++}` });
    gt3.assistPreset = 'pro';
    gt3.aiPaceScale = GT3_PACE;
    sim = gt3;
  } else {
    const vf26 = new F1Physics2026(track);
    vf26.setAssistPreset('pro');
    sim = vf26;
  }
  // From the grid, not a flying start: that drops the car 450 m before the line at 270 km/h, which on circuits
  // whose last corner lies within those 450 m (Red Bull Ring, Suzuka) throws a GT3 into the run-off. The first lap
  // is the out-lap; the second, flying, lap is the one timed
  sim.resetToStartGrid(false);
  sim.aiAutopilot = true;
  let laps = 0;
  let offTrack = 0;
  let lapS: number | null = null;
  let braking = false;
  const brakeOnsets: number[] = [];
  const trace: PhysicsLap['trace'] = [];
  let dbg = 0;
  let lastDbg = -1000;
  for (let i = 0; i < 60 * 420; i++) {
    const prev = sim.telemetry.lastLapTimeMs;
    sim.step(1 / 60, {});
    if (process.env.DEBUG_LINE && dbg < 12 && (sim.telemetry.offTrack || sim.telemetry.speedKmh < 40) && i - lastDbg > 120) {
      dbg++;
      lastDbg = i;
      console.log(`    [debug] t=${(i / 60).toFixed(1)} s=${sim.sMeters.toFixed(0)} v=${sim.telemetry.speedKmh.toFixed(0)} lat=${sim.lateralOffsetM.toFixed(2)} off=${sim.telemetry.offTrack}`);
    }
    if (laps === 1) {
      // the F1 AI's off-track flag; for the GT3 its CG past the asphalt edge (as verify-gt3 checks it)
      const off =
        LINE === 'gt3'
          ? Math.abs(sim.lateralOffsetM) > track.getSampleAtDistance(sim.sMeters).width / 2
          : sim.telemetry.offTrack;
      if (off) offTrack++;
      trace.push({ s: sim.sMeters, kmh: sim.telemetry.speedKmh, gear: sim.telemetry.gear });
      const b = sim.telemetry.brake > 0.3;
      if (b && !braking) brakeOnsets.push(sim.sMeters);
      braking = b;
    }
    if (sim.telemetry.lastLapTimeMs !== null && sim.telemetry.lastLapTimeMs !== prev) {
      laps++;
      if (laps === 2) {
        lapS = sim.telemetry.lastLapTimeMs / 1000;
        break;
      }
    }
  }
  if (lapS === null && process.env.DEBUG_LINE) {
    console.log(`    [debug] no lap: laps=${laps} s=${sim.sMeters.toFixed(0)} v=${sim.telemetry.speedKmh.toFixed(0)} lat=${sim.lateralOffsetM.toFixed(2)}`);
  }
  return { lapS, offTrack, brakeOnsets, trace };
}

const physStart = physicsLap(e0);
const physOpt = physicsLap(eOpt);
console.log(
  `Physics ${LINE === 'gt3' ? `GT3 autopilot (pace ${GT3_PACE})` : 'AI'} flying lap: starting line ${physStart.lapS?.toFixed(3)} s (offTrack ${physStart.offTrack}), ` +
    `optimised ${physOpt.lapS?.toFixed(3)} s (offTrack ${physOpt.offTrack})`
);

// The GT3 autopilot laps at 95 % pace from its own plan, so a few tenths either way over a 1.5-2.5 min lap say little
// about the line; for it the physics lap only has to stay on the road and in that window, and the model lap decides
const physTolS = LINE === 'gt3' ? Number(process.env.GT3_LAP_TOL ?? 0.5) : 0.05;
const optWins =
  physOpt.lapS !== null && physOpt.offTrack === 0 && (physStart.lapS === null || physOpt.lapS < physStart.lapS + physTolS);
// An optimised line the physics car could not hold (off the asphalt, or no lap) is re-optimised further from the
// edges, up to twice, before falling back to the starting line
const RETRY = Number(process.env.LINE_RETRY ?? 0);
if (!optWins && (physOpt.lapS === null || physOpt.offTrack > 0) && RETRY < 2) {
  const edge = EDGE_MARGIN_M + 0.4;
  const kerb = KERB_MARGIN_M + 0.3;
  console.log(`Optimised line not held: retrying with edge / kerb margins ${edge.toFixed(2)} / ${kerb.toFixed(2)} m.`);
  const r = spawnSync(process.execPath, [...process.execArgv, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, LINE_RETRY: String(RETRY + 1), EDGE_M: String(edge), KERB_M: String(kerb) },
  });
  process.exit(r.status ?? 1);
}
const eFinal = optWins ? eOpt : e0;
const final = evalLine(eFinal);
const phys = optWins ? physOpt : physStart;
console.log(`Using the ${optWins ? 'optimised' : 'starting'} line.`);

// ---------- braking zones (profile) vs physics brake onsets ----------
const L = track.totalLengthM;
const v = final.profile.speedMs;
interface Zone {
  startS: number;
  endS: number;
  entryKmh: number;
  minKmh: number;
}
const zones: Zone[] = [];
{
  // A sample brakes when the profile speed falls towards the next one faster than drag alone explains
  const isBrk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const decel = (v[i] * v[i] - v[j] * v[j]) / (2 * final.profile.segLenM[i]);
    isBrk[i] = decel > 6 ? 1 : 0;
  }
  let start = -1;
  for (let k = 0; k < n; k++) if (!isBrk[k] && isBrk[(k + 1) % n]) { start = (k + 1) % n; break; }
  if (start >= 0) {
    let i = start;
    for (let cnt = 0; cnt < n; ) {
      if (isBrk[i]) {
        const s0 = i;
        let len = 0;
        while (isBrk[i] && len < n) { i = (i + 1) % n; len++; cnt++; }
        const entry = v[s0];
        const minV = v[i];
        if (entry - minV > 30 / 3.6) zones.push({ startS: samples[s0].s, endS: samples[i].s, entryKmh: entry * 3.6, minKmh: minV * 3.6 });
      } else { i = (i + 1) % n; cnt++; }
    }
  }
  zones.sort((a, b) => a.startS - b.startS);
  // Stops separated by a short coast are one braking zone (one set of boards)
  for (let k = zones.length - 1; k > 0; k--) {
    const a = zones[k - 1];
    const b = zones[k];
    if (b.startS - a.endS < 40) {
      a.endS = b.endS;
      a.entryKmh = Math.max(a.entryKmh, b.entryKmh);
      a.minKmh = b.minKmh;
      zones.splice(k, 1);
    }
  }
}
console.log('\nBraking zones (profile brake point -> nearest physics AI brake onset):');
for (const z of zones) {
  let nearest = Number.NaN;
  for (const s of phys.brakeOnsets) {
    const d = ((s - z.startS + L * 1.5) % L) - L / 2;
    if (Number.isNaN(nearest) || Math.abs(d) < Math.abs(nearest)) nearest = d;
  }
  console.log(
    `  s=${z.startS.toFixed(0).padStart(5)} m  ${z.entryKmh.toFixed(0)} -> ${z.minKmh.toFixed(0)} km/h over ${(((z.endS - z.startS + L) % L)).toFixed(0)} m` +
      `  physics onset ${Number.isNaN(nearest) ? 'n/a' : `${nearest >= 0 ? '+' : ''}${nearest.toFixed(1)} m`}`
  );
}

if (DRY_RUN) {
  console.log('\n--dry-run: track_data.json not written.');
  process.exit(0);
}

// ---------- write back ----------
const raw = fs.readFileSync(JSON_PATH, 'utf8');
const json = JSON.parse(raw);
function atS(arr: ArrayLike<number>, s: number): number {
  const x = (((s % L) + L) % L) / L * n;
  const i0 = Math.floor(x) % n;
  const t = x - Math.floor(x);
  return arr[i0] + (arr[(i0 + 1) % n] - arr[i0]) * t;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const zoneJson = zones.map((z) => ({
  startS: Math.round(z.startS * 10) / 10,
  endS: Math.round(z.endS * 10) / 10,
  entryKmh: Math.round(z.entryKmh),
  minKmh: Math.round(z.minKmh),
}));

if (LINE === 'gt3') {
  // The GT3's own line beside the F1 one; the samples' speeds and the turn data stay the F1 line's
  for (const js of json.samples) js.roGt3 = r3(atS(eFinal, js.s));
  json.metadata.racingLineGt3 = {
    method: 'lap-time optimised (quasi-steady AMG GT3 model, B-spline pattern search), GT3-autopilot validated',
    modelLapS: Math.round(final.lap * 1000) / 1000,
    physicsLapS: phys.lapS !== null ? Math.round(phys.lapS * 1000) / 1000 : null,
    brakingZones: zoneJson,
  };
} else {
  // Throttle / brake reference from the profile's longitudinal acceleration
  const gas = new Float64Array(n);
  const brk = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = (v[j] * v[j] - v[i] * v[i]) / (2 * final.profile.segLenM[i]);
    brk[i] = a < -6 ? Math.min(1, -a / 40) : 0;
    gas[i] = a > 0.5 ? 1 : a > -6 ? 0.35 : 0;
  }

  for (const js of json.samples) {
    const ro = atS(eFinal, js.s);
    const tx = js.t[0];
    const tz = js.t[2];
    const tl = Math.hypot(tx, tz) || 1;
    js.ro = r3(ro);
    js.r = [r3(js.p[0] + (-tz / tl) * ro), r3(js.p[1] - Math.tan(js.b) * ro), r3(js.p[2] + (tx / tl) * ro)];
    js.v = Math.round(atS(v, js.s) * 3.6 * 10) / 10;
    js.gas = Math.round(atS(gas, js.s) * 100) / 100;
    js.brk = Math.round(atS(brk, js.s) * 100) / 100;
  }

  // Turn apex speeds from the profile minimum around each turn, gears from the physics AI there
  for (const turn of json.turns) {
    let minV = Infinity;
    for (let ds = -60; ds <= 60; ds += 2) minV = Math.min(minV, atS(v, turn.sApprox + ds));
    const kmh = Math.round(minV * 3.6);
    turn.apexSpeedKmh = kmh;
    let apex: PhysicsLap['trace'][number] | null = null;
    for (const f of phys.trace) {
      const d = Math.abs(((f.s - turn.sApprox + L * 1.5) % L) - L / 2);
      if (d <= 60 && (!apex || f.kmh < apex.kmh)) apex = f;
    }
    if (apex) turn.gear = apex.gear;
    turn.description = turn.description?.replace(/apex \d+ km\/h in gear \d+/, `apex ${kmh} km/h in gear ${turn.gear}`);
  }

  json.metadata.racingLine = {
    method: 'lap-time optimised (quasi-steady VF26 model, B-spline pattern search), physics-AI validated',
    modelLapS: Math.round(final.lap * 1000) / 1000,
    physicsAiLapS: phys.lapS !== null ? Math.round(phys.lapS * 1000) / 1000 : null,
    brakingZones: zoneJson,
  };
}

const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const indent = /^\{\s*\n(\s+)"/.exec(raw)?.[1] ?? '';
const out = indent ? JSON.stringify(json, null, indent.length) : JSON.stringify(json);
fs.writeFileSync(JSON_PATH, (indent ? out.replace(/\n/g, eol) : out) + (raw.endsWith('\n') ? eol : ''), 'utf8');
console.log(`\nWrote ${path.relative(process.cwd(), JSON_PATH)}`);
