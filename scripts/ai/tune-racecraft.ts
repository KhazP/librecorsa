/**
 * Overnight tuning of the racecraft knobs (`RacecraftParams`) in headless races: a cross-entropy search (a diagonal
 * Gaussian over the normalised knobs, refitted to the best candidates each generation).
 *
 *   npx tsx scripts/ai/tune-racecraft.ts [--gens 40] [--pop 12] [--workers 10] [--tracks spielberg,okayama]
 *       [--planner on|off] [--laps 3] [--cars 8] [--car vf26|f12026-car|amg-gt3] [--seeds 1] [--mode pass|defence]
 *
 * Each candidate races every track `--seeds` times (the same seeds for every candidate in a generation: common random
 * numbers; one race each is noisy, the same knobs scoring from −25 to −35 between generations), and is scored on what a
 * good race looks like, in the spirit of GT Sophy's reward terms: places won on the road, against spins, contacts,
 * offs and retirements, with a small weight on pace. Results go to $REALISM_REF/reports/race-ai/tuning/ (local): the
 * per-generation log and the best knobs found, to review before they become the defaults.
 *
 * `--mode defence` tunes the start and defence knobs instead, on a reversed grid (the quickest cars start at the back,
 * as a quick player does): places won on lap 1 and passes count against, spins, contacts (twice over: a move across a
 * car's nose is the risk) offs and retirements against. The quickest car's lap-1 gain is logged alongside.
 *
 * Worker mode (one race, JSON out): --eval '<params json>' --track <id> --seed <n> --planner on|off --car <id> [--mode]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { AI_DRIVERS, AI_RESERVE_DRIVERS, AiOpponentField, DEFAULT_RACECRAFT, type RacecraftParams } from '../../src/lib/sim/ai-opponents';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { REALISM_REF } from './lib/references';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

interface RaceScore {
  passes: number;
  spins: number;
  contacts: number;
  offs: number;
  dnf: number;
  meanLapS: number;
  score: number;
  /** Places won on lap 1 across the field, and by the quickest car (defence mode) */
  lap1Gains?: number;
  fastestGain1?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Worker: one race with given knobs
// ---------------------------------------------------------------------------------------------------------------------
if (argv.includes('--eval')) {
  const params = JSON.parse(opt('eval', '{}')) as Partial<RacecraftParams>;
  const trackId = opt('track', 'spielberg');
  const seed = Number(opt('seed', '1'));
  const laps = Number(opt('laps', '3'));
  const cars = Number(opt('cars', '8'));
  setActiveTrack(trackId, JSON.parse(readFileSync(`public/tracks/${trackId}/track_data.json`, 'utf8')) as RawTrackJson);
  const track = getActiveTrackData(1200);
  const carId = opt('car', 'f12026-car');
  const tmpl: SimulatorCar =
    carId === 'vf26'
      ? (new F1Physics2026(track) as unknown as SimulatorCar)
      : carId === 'amg-gt3'
        ? createAmgGt3Sim(track, loadGlbGeometry(`public${track.meshUrl}`))
        : new F12026CarSim(track, loadGlbGeometry(`public${track.meshUrl}`));
  const defence = opt('mode', 'pass') === 'defence';
  const field = new AiOpponentField(track, tmpl, [...AI_DRIVERS, ...AI_RESERVE_DRIVERS].slice(0, cars), undefined, {
    seed,
    spectate: true,
    learning: false,
    gridOrder: defence ? 'reversed' : 'qualifying',
    racecraft: params,
    localPlanner: opt('planner', 'off') === 'on',
  });
  field.raceLaps = laps;
  field.startRace(true);
  let t = 0;
  while (field.phase !== 'finished' && t < 60 + laps * 200) {
    field.update(1 / 120);
    t += 1 / 120;
  }
  const r = field.report();
  const sum = (k: 'passes' | 'spins' | 'contacts' | 'offTracks') => r.cars.reduce((a, c) => a + c.stats[k], 0);
  const laps2 = r.cars.flatMap((c) => c.stats.lapTimesMs.slice(1)).filter((x) => x > 0);
  const meanLapS = laps2.length ? laps2.reduce((a, b) => a + b, 0) / laps2.length / 1000 : 999;
  const s: RaceScore = {
    passes: sum('passes'),
    spins: sum('spins'),
    contacts: sum('contacts') / 2,
    offs: sum('offTracks'),
    dnf: r.cars.filter((c) => c.retired).length,
    meanLapS,
    score: 0,
  };
  s.score = s.passes * 1 - s.spins * 4 - s.contacts * 1 - s.offs * 0.5 - s.dnf * 10 - 0.3 * meanLapS;
  if (defence) {
    const gain1 = (c: (typeof r.cars)[number]) => (c.stats.lapPositions[0] ? Math.max(0, c.gridPos - c.stats.lapPositions[0]) : 0);
    s.lap1Gains = r.cars.reduce((a, c) => a + gain1(c), 0);
    s.fastestGain1 = gain1(r.cars.reduce((a, c) => (c.pace > a.pace ? c : a)));
    s.score = -s.lap1Gains - 0.25 * s.passes - s.spins * 4 - s.contacts * 2 - s.offs * 0.5 - s.dnf * 10;
  }
  console.log(JSON.stringify(s));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Master: cross-entropy search
// ---------------------------------------------------------------------------------------------------------------------
const mode = opt('mode', 'pass');
const RANGES: Partial<Record<keyof RacecraftParams, [number, number]>> = mode === 'defence' ? {
  defendLookM: [15, 60],
  defendClosingMs: [0.3, 3],
  defendReachM: [1.2, 4],
  defendRoomS: [0.3, 1.4],
  startLaneMaxM: [300, 1500],
} : {
  passSpacingM: [2.2, 3.2],
  alongsideSpacingM: [2.5, 3.6],
  reactGapS: [0.2, 0.6],
  pullOutBaseM: [1, 8],
  pullOutClosingS: [0.3, 1.8],
  attackPush: [0, 0.03],
  followRelAccel: [3, 10],
  followFadeM: [12, 40],
  dirtyAirMargin: [0.04, 0.2],
};
const planner = opt('planner', 'off');
if (planner === 'on') {
  Object.assign(RANGES, {
    plannerIntent: [1, 8],
    plannerLine: [0.03, 0.4],
    plannerProximity: [5, 60],
    plannerConsistency: [0.1, 1.0],
  } satisfies Partial<Record<keyof RacecraftParams, [number, number]>>);
}
const keys = Object.keys(RANGES) as (keyof RacecraftParams)[];
const gens = Number(opt('gens', '40'));
const pop = Number(opt('pop', '12'));
const workers = Number(opt('workers', '10'));
const tracks = opt('tracks', 'spielberg,okayama').split(',');
const laps = opt('laps', '3');
const cars = opt('cars', '8');
const carId = opt('car', 'f12026-car');
const seeds = Number(opt('seeds', '1'));
const outDir = join(REALISM_REF, 'reports/race-ai/tuning');
mkdirSync(outDir, { recursive: true });
const tag = mode === 'defence' ? 'defence' : planner;
const logPath = join(outDir, `racecraft-${tag}.log`);
writeFileSync(logPath, `tuning ${keys.join(', ')} on ${tracks.join(', ')} · ${carId} · ${seeds} seed(s) · planner ${planner}\n`);
const log = (m: string) => {
  console.log(m);
  appendFileSync(logPath, m + '\n');
};

const toParams = (u: number[]): Partial<RacecraftParams> => {
  const p: Partial<RacecraftParams> = {};
  keys.forEach((k, i) => {
    const [lo, hi] = RANGES[k] as [number, number];
    p[k] = Math.round((lo + Math.min(1, Math.max(0, u[i])) * (hi - lo)) * 1e4) / 1e4;
  });
  return p;
};
const toUnit = (p: RacecraftParams): number[] => keys.map((k) => {
  const [lo, hi] = RANGES[k] as [number, number];
  return (p[k] - lo) / (hi - lo);
});
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function runRace(params: Partial<RacecraftParams>, track: string, seed: number): Promise<RaceScore | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=THREE_CJS_DEPRECATED', '--import', 'tsx', __filename, '--eval', JSON.stringify(params), '--track', track, '--seed', String(seed), '--planner', planner, '--laps', laps, '--cars', cars, '--car', carId, '--mode', mode],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try {
        resolve(JSON.parse(line) as RaceScore);
      } catch {
        resolve(null);
      }
    });
  });
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    })
  );
  return out;
}

const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '-');

async function main(): Promise<void> {
  let mean = toUnit(DEFAULT_RACECRAFT);
  let std = keys.map(() => 0.22);
  let bestEver: { score: number; params: Partial<RacecraftParams>; detail: string } | null = null;
  for (let g = 0; g < gens; g++) {
    const seed = 1000 + g * 17;
    const cands: number[][] = [mean.slice()];
    while (cands.length < pop + 1) cands.push(mean.map((m, i) => Math.min(1, Math.max(0, m + std[i] * gauss()))));
    const jobs: (() => Promise<RaceScore | null>)[] = [];
    const per = tracks.length * seeds;
    for (const c of cands) for (const tr of tracks) for (let k = 0; k < seeds; k++) jobs.push(() => runRace(toParams(c), tr, seed + k));
    const started = Date.now();
    const results = await pool(jobs, workers);
    const scored = cands.map((c, ci) => {
      const rs = results.slice(ci * per, (ci + 1) * per);
      const ok = rs.filter((r): r is RaceScore => r !== null);
      const score = ok.length === per ? ok.reduce((a, r) => a + r.score, 0) / ok.length : -Infinity;
      const detail =
        mode === 'defence'
          ? `lap1 ${avg(ok.map((r) => r.lap1Gains ?? 0))} fastest ${avg(ok.map((r) => r.fastestGain1 ?? 0))} p ${avg(ok.map((r) => r.passes))} s ${avg(ok.map((r) => r.spins))} c ${avg(ok.map((r) => r.contacts))} o ${avg(ok.map((r) => r.offs))} d ${avg(ok.map((r) => r.dnf))}`
          : ok.map((r) => `p${r.passes} s${r.spins} c${r.contacts.toFixed(0)} o${r.offs} d${r.dnf} ${r.meanLapS.toFixed(1)}s`).join(' | ');
      return { c, score, detail };
    });
    scored.sort((a, b) => b.score - a.score);
    const elites = scored.slice(0, Math.max(3, Math.round(pop / 3))).filter((e) => Number.isFinite(e.score));
    if (elites.length) {
      const newMean = keys.map((_, i) => elites.reduce((a, e) => a + e.c[i], 0) / elites.length);
      const newStd = keys.map((_, i) => Math.sqrt(elites.reduce((a, e) => a + (e.c[i] - newMean[i]) ** 2, 0) / elites.length));
      mean = mean.map((m, i) => 0.3 * m + 0.7 * newMean[i]);
      std = std.map((s, i) => Math.max(0.04, 0.3 * s + 0.7 * newStd[i]));
    }
    const top = scored[0];
    if (!bestEver || top.score > bestEver.score) bestEver = { score: top.score, params: toParams(top.c), detail: top.detail };
    const meanEntry = scored.find((e) => e.c === cands[0]);
    log(
      `gen ${g} (${((Date.now() - started) / 1000).toFixed(0)} s): best ${top.score.toFixed(2)} [${top.detail}] · mean-candidate ${meanEntry?.score.toFixed(2)} [${meanEntry?.detail}]`
    );
    log(`  best params ${JSON.stringify(toParams(top.c))}`);
    writeFileSync(join(outDir, `best-racecraft-${tag}.json`), JSON.stringify({ generation: g, ...bestEver, mean: toParams(mean) }, null, 1));
  }
  log(`done: best ${bestEver?.score.toFixed(2)} ${JSON.stringify(bestEver?.params)}`);
}

void main();
