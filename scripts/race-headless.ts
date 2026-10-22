/**
 * Headless AI race for tuning: the full-physics AI field on a circuit, faster than real time and without rendering,
 * then a results table (laps, gaps, incidents, position changes) and what each car learnt.
 *
 *   npx tsx scripts/race-headless.ts [--track rwanda] [--car vf26|f12026-car|amg-gt3] [--laps 5] [--cars 5]
 *       [--skill 70] [--seed 1] [--no-learn] [--laps-table] [--sweep skill | learn | <param>=v1,v2,...]
 *       [--weather clear|overcast|light_rain|heavy_rain|drying|dynamic]
 *   npm run race:headless -- --track suzuka --car amg-gt3 --sweep skill
 *
 * `--sweep skill` races Rookie / Amateur / Pro / Alien, `--sweep learn` learning off and on, and
 * `--sweep brakeMargin=0,0.05,0.1` (any AiTuningParams key) the class parameter at each value.
 * The same seed replays the same race.
 */
import { readFileSync } from 'node:fs';
import { getRwandaTrackData, setActiveTrack, type BuiltTrackData, type RawTrackJson } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { AI_DRIVERS, AiOpponentField, type AiDriverDef, type AiFieldReport } from '../src/lib/sim/ai-opponents';
import { AI_PARAM_RANGES, AI_SKILL_LEVELS, aiSkillLabel, type AiTuningLibrary, type AiTuningParams } from '../src/lib/sim/ai-tuning';
import { AI_TUNING_LIBRARY } from '../src/lib/sim/ai-tuning-data';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { TrackEnvironment } from '../src/lib/sim/track-environment';
import { DEFAULT_SESSION_CONDITIONS, WEATHER_PRESETS, type WeatherPresetId } from '../src/lib/sim/weather';
import { loadGlbGeometry } from './lib/glb-geometry';

type CarKind = 'vf26' | 'f12026-car' | 'amg-gt3';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const trackId = opt('track', 'rwanda');
const carKind = opt('car', 'vf26') as CarKind;
const laps = Math.max(1, Number(opt('laps', '5')));
const nCars = Math.max(1, Math.min(12, Number(opt('cars', '5'))));
const skill = Number(opt('skill', '70'));
const seed = Number(opt('seed', '1'));
const learning = !flag('no-learn');
const sweep = opt('sweep', '');
const weather = opt('weather', 'clear') as WeatherPresetId;
const DT = 1 / 120;

if (!WEATHER_PRESETS.includes(weather)) {
  console.error(`unknown --weather ${weather}`);
  process.exit(2);
}
if (!['vf26', 'f12026-car', 'amg-gt3'].includes(carKind)) {
  console.error(`unknown --car ${carKind}`);
  process.exit(2);
}

// ---- Track and colliders
if (trackId !== 'rwanda') setActiveTrack(trackId, JSON.parse(readFileSync(`public/tracks/${trackId}/track_data.json`, 'utf8')) as RawTrackJson);
const track: BuiltTrackData = getRwandaTrackData(1200);
const root = carKind === 'vf26' ? null : loadGlbGeometry(`public${track.meshUrl ?? '/tracks/rwanda/rwanda_2026.glb'}`);

function makeTemplate(): SimulatorCar {
  if (carKind === 'amg-gt3') return createAmgGt3Sim(track, root);
  if (carKind === 'f12026-car') return new F12026CarSim(track, root);
  return new F1Physics2026(track);
}

/** The five named drivers, then made-up ones further down the order */
function drivers(n: number): AiDriverDef[] {
  const out = AI_DRIVERS.slice(0, n);
  const palette = ['#52e252', '#ff87bc', '#6692ff', '#ffd700', '#c0c0c0', '#00a19c', '#9b0000'];
  for (let i = out.length; i < n; i++) {
    out.push({ code: `A${String(i + 1).padStart(2, '0')}`, teamColorHex: palette[i % palette.length], pace: 0.947 - 0.007 * (i - 4), aggression: ((i * 37) % 10) / 10 - 0.5 });
  }
  return out;
}

interface RaceRun {
  label: string;
  report: AiFieldReport;
  simS: number;
  wallS: number;
}

function race(label: string, opts: { skill: number; learning: boolean; library?: AiTuningLibrary }): RaceRun {
  const template = makeTemplate();
  // The field is handed the environment (and so no longer updates it): the loop below does, as the simulator does
  const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather });
  const field = new AiOpponentField(track, template, drivers(nCars), env, {
    skill: opts.skill,
    seed,
    learning: opts.learning,
    spectate: true,
    trackId,
    library: opts.library,
  });
  field.raceLaps = laps;
  field.startRace(true);
  const started = Date.now();
  let t = 0;
  // Time limit: ~3 min a lap plus the start
  const limitS = 30 + laps * 180;
  while (field.phase !== 'finished' && t < limitS) {
    env.update(DT, field.sims());
    field.update(DT);
    t += DT;
  }
  return { label, report: field.report(), simS: t, wallS: (Date.now() - started) / 1000 };
}

const fmtLap = (ms: number | null | undefined) => {
  if (!ms) return '-:--.---';
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const pad = (v: string | number, n: number) => String(v).padStart(n);
const padR = (v: string | number, n: number) => String(v).padEnd(n);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};

/** Flying laps only (the first lap starts from the grid) */
const flying = (laps: number[]) => laps.slice(1);

function printRace(run: RaceRun): void {
  const r = run.report;
  const L = track.totalLengthM;
  const byPos = [...r.cars].sort((a, b) => a.position - b.position);
  const winner = byPos[0];
  console.log(
    `\n${run.label}: ${trackId} · ${carKind} · ${laps} laps · ${r.cars.length} cars · skill ${r.skill} (${aiSkillLabel(r.skill)}) · seed ${r.seed} · learning ${learning ? 'on' : 'off'}`
  );
  console.log(`tuning: ${r.tuningSources.join(' → ')}`);
  console.log(`simulated ${run.simS.toFixed(1)} s in ${run.wallS.toFixed(1)} s (${(run.simS / Math.max(0.01, run.wallS)).toFixed(1)}× real time)`);
  console.log(
    `${padR('Pos', 4)}${padR('Car', 5)}${pad('Grid', 5)}${pad('Pace', 7)}${pad('Time / gap', 13)}${pad('Best', 10)}${pad('Avg', 10)}${pad('σ lap', 7)}` +
      `${pad('Off', 5)}${pad('Wall', 5)}${pad('Stuck', 6)}${pad('Cont', 5)}${pad('Mist', 5)}${pad('±Pos', 5)}  Learnt (corners: brake+ / apex)`
  );
  for (const c of byPos) {
    const fl = flying(c.stats.lapTimesMs);
    const lapsDone = Math.floor(c.distM / L);
    const time =
      c === winner
        ? c.finishTimeS !== null
          ? fmtLap(c.finishTimeS * 1000)
          : `${lapsDone} laps`
        : c.finishTimeS !== null && winner.finishTimeS !== null
          ? `+${(c.finishTimeS - winner.finishTimeS).toFixed(3)}`
          : `${lapsDone}/${laps} laps`;
    const positions = [c.gridPos, ...c.stats.lapPositions];
    let moves = 0;
    for (let i = 1; i < positions.length; i++) moves += Math.abs(positions[i] - positions[i - 1]);
    const learnt = c.learnt.filter((k) => k.brakeMargin > 0.001 || Math.abs(k.apex) > 0.001);
    const learntStr = learnt.length
      ? learnt
          .slice(0, 5)
          .map((k) => `${k.label} +${k.brakeMargin.toFixed(2)}/${k.apex >= 0 ? '+' : ''}${(k.apex * 100).toFixed(1)}%`)
          .join(' ') + (learnt.length > 5 ? ` …(${learnt.length})` : '')
      : '-';
    console.log(
      `${padR(c.position, 4)}${padR(c.code, 5)}${pad(c.gridPos, 5)}${pad(c.pace.toFixed(3), 7)}${pad(time, 13)}${pad(fmtLap(c.bestLapMs), 10)}` +
        `${pad(fmtLap(mean(fl)), 10)}${pad(fl.length > 1 ? (sd(fl) / 1000).toFixed(2) : '-', 7)}` +
        `${pad(c.stats.offTracks, 5)}${pad(c.stats.wallHits, 5)}${pad(c.stats.stuckRecoveries, 6)}${pad(c.stats.contacts, 5)}${pad(c.stats.mistakes, 5)}${pad(moves, 5)}  ${learntStr}`
    );
  }
  if (flag('laps-table')) {
    console.log('\nLap times (lap 1 from the grid):');
    for (const c of byPos) console.log(`  ${padR(c.code, 4)} ${c.stats.lapTimesMs.map((ms) => fmtLap(ms)).join('  ')}`);
  }
}

function summary(run: RaceRun) {
  const r = run.report;
  const best = r.cars.map((c) => c.bestLapMs ?? NaN).filter(Number.isFinite);
  const allFlying = r.cars.flatMap((c) => flying(c.stats.lapTimesMs));
  const finished = r.cars.filter((c) => c.finishTimeS !== null).map((c) => c.finishTimeS as number);
  const sum = (k: keyof AiFieldReport['cars'][number]['stats']) => r.cars.reduce((a, c) => a + (c.stats[k] as number), 0);
  return {
    label: run.label,
    fastest: Math.min(...best),
    meanBest: mean(best),
    spreadS: (Math.max(...best) - Math.min(...best)) / 1000,
    lapSd: mean(r.cars.map((c) => sd(flying(c.stats.lapTimesMs)) / 1000)),
    lastGapS: finished.length > 1 ? Math.max(...finished) - Math.min(...finished) : NaN,
    off: sum('offTracks'),
    wall: sum('wallHits'),
    stuck: sum('stuckRecoveries'),
    contacts: sum('contacts') / 2,
    mistakes: sum('mistakes'),
    flyingLaps: allFlying.length,
  };
}

function printSummary(runs: RaceRun[]): void {
  console.log(`\nSweep summary (${trackId} · ${carKind} · ${laps} laps · ${nCars} cars · seed ${seed})`);
  console.log(
    `${padR('Run', 22)}${pad('Fastest', 10)}${pad('Mean best', 11)}${pad('Spread', 8)}${pad('σ lap', 7)}${pad('Field', 8)}${pad('Off', 5)}${pad('Wall', 5)}${pad('Stuck', 6)}${pad('Cont', 5)}${pad('Mist', 5)}`
  );
  for (const run of runs) {
    const s = summary(run);
    console.log(
      `${padR(s.label, 22)}${pad(fmtLap(s.fastest), 10)}${pad(fmtLap(s.meanBest), 11)}${pad(s.spreadS.toFixed(2), 8)}${pad(s.lapSd.toFixed(2), 7)}` +
        `${pad(Number.isFinite(s.lastGapS) ? s.lastGapS.toFixed(1) : '-', 8)}${pad(s.off, 5)}${pad(s.wall, 5)}${pad(s.stuck, 6)}${pad(s.contacts, 5)}${pad(s.mistakes, 5)}`
    );
  }
  console.log('Spread = slowest − fastest best lap (s); σ lap = mean per-car σ of flying laps (s); Field = first to last at the flag (s)');
}

/** The tuning library with one class parameter replaced */
function libraryWith(key: keyof AiTuningParams, value: number): AiTuningLibrary {
  const classId = carKind === 'amg-gt3' ? 'gt3' : 'f1-2026';
  const base = AI_TUNING_LIBRARY[classId] ?? {};
  return { ...AI_TUNING_LIBRARY, [classId]: { ...base, params: { ...base.params, [key]: value } } };
}

const runs: RaceRun[] = [];
if (!sweep) {
  runs.push(race('Race', { skill, learning }));
} else if (sweep === 'skill') {
  for (const l of AI_SKILL_LEVELS) runs.push(race(`${l.label} (${l.value})`, { skill: l.value, learning }));
} else if (sweep === 'learn') {
  runs.push(race('learning off', { skill, learning: false }));
  runs.push(race('learning on', { skill, learning: true }));
} else {
  const [key, list] = sweep.split('=');
  if (!(key in AI_PARAM_RANGES) || !list) {
    console.error(`--sweep skill | learn | <param>=v1,v2 (params: ${Object.keys(AI_PARAM_RANGES).join(', ')})`);
    process.exit(2);
  }
  for (const v of list.split(',').map(Number)) {
    runs.push(race(`${key}=${v}`, { skill, learning, library: libraryWith(key as keyof AiTuningParams, v) }));
  }
}
for (const run of runs) printRace(run);
if (runs.length > 1) printSummary(runs);
