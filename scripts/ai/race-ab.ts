/**
 * A/B of the AI field's racecraft in headless races with a stand-in for the player (`lib/stand-in-race.ts`): the same
 * tracks, seeds and stand-in profiles for each arm, raced in parallel, then raw totals per arm and per profile.
 *
 *   npx tsx scripts/ai/race-ab.ts [--tracks spielberg,istanbul_park] [--car lc26] [--seeds 4] [--seed0 0] [--laps 3] [--ai 7]
 *       [--profiles line,slow,early,weave,autopilot,none] [--jobs 4] [--a '<racecraft json>'] [--b '<racecraft json>']
 *       [--planner on|off] [--skill 0.5] [--weather clear|light_rain|heavy_rain|...] [--json out.json]
 *
 * `--seed0 N` starts at the N-th seed: a held-out set for a final check after knobs were picked on the first ones.
 * Each arm is a set of racecraft knobs (`RacecraftParams`) over the defaults; with no `--b` only the defaults race.
 * Headless races are chaotic (one first-lap pile-up moves a total by 5-10), so read totals over 24+ races, then the
 * per-race rows for where the difference sits.
 *
 * Worker mode (one race, JSON out): --one '<StandInRaceOptions json>'
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runStandInRace, STAND_IN_PROFILES, type StandInProfile, type StandInRaceOptions, type StandInRaceResult } from './lib/stand-in-race';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

if (argv.includes('--one')) {
  const o = JSON.parse(opt('one', '{}')) as StandInRaceOptions;
  console.log(JSON.stringify(runStandInRace(o)));
  process.exit(0);
}

const tracks = opt('tracks', 'spielberg,istanbul_park').split(',');
const car = opt('car', 'lc26');
const seeds = Number(opt('seeds', '4'));
const seed0 = Number(opt('seed0', '0'));
const laps = Number(opt('laps', '3'));
const aiCars = Number(opt('ai', '7'));
const jobsN = Number(opt('jobs', '4'));
const profiles = opt('profiles', 'line,slow,early,weave,none').split(',') as StandInProfile[];
for (const p of profiles) if (!(STAND_IN_PROFILES as readonly string[]).includes(p)) throw new Error(`unknown profile ${p}`);
const arms: { name: string; racecraft: Record<string, number> }[] = [{ name: 'A', racecraft: JSON.parse(opt('a', '{}')) }];
if (argv.includes('--b')) arms.push({ name: 'B', racecraft: JSON.parse(opt('b', '{}')) });
const localPlanner = opt('planner', 'off') === 'on';
const skill = argv.includes('--skill') ? Number(opt('skill', '0.5')) : undefined;
const weather = argv.includes('--weather') ? (opt('weather', 'clear') as StandInRaceOptions['weather']) : undefined;

function runOne(o: StandInRaceOptions): Promise<StandInRaceResult | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=THREE_CJS_DEPRECATED', '--import', 'tsx', __filename, '--one', JSON.stringify(o)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try {
        resolve(JSON.parse(line) as StandInRaceResult);
      } catch {
        console.error(`race failed: ${JSON.stringify(o)}\n${err.slice(-2000)}`);
        resolve(null);
      }
    });
  });
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
        done++;
        if (done % 5 === 0 || done === jobs.length) process.stderr.write(`  ${done}/${jobs.length} races\n`);
      }
    })
  );
  return out;
}

const pad = (v: string | number, n: number) => String(v).padStart(n);
const padR = (v: string | number, n: number) => String(v).padEnd(n);

interface Totals {
  races: number;
  ok: number;
  vsEvents: number;
  vsAiFault: number;
  vsStandInFault: number;
  vsRacing: number;
  vsRearEnd: number;
  vsSide: number;
  touchS: number;
  lost: number;
  won: number;
  aaEvents: number;
  aaFault: number;
  spins: number;
  offs: number;
  walls: number;
  dnf: number;
  passes: number;
  penS: number;
  siPenS: number;
  aiLapS: number[];
  standInLapS: number[];
}

function totals(rs: (StandInRaceResult | null)[]): Totals {
  const t: Totals = {
    races: rs.length, ok: 0, vsEvents: 0, vsAiFault: 0, vsStandInFault: 0, vsRacing: 0, vsRearEnd: 0, vsSide: 0, touchS: 0, lost: 0, won: 0,
    aaEvents: 0, aaFault: 0, spins: 0, offs: 0, walls: 0, dnf: 0, passes: 0, penS: 0, siPenS: 0, aiLapS: [], standInLapS: [],
  };
  for (const r of rs) {
    if (!r) continue;
    t.ok++;
    t.vsEvents += r.vsStandIn.events;
    t.vsAiFault += r.vsStandIn.aiAtFault;
    t.vsStandInFault += r.vsStandIn.standInAtFault;
    t.vsRacing += r.vsStandIn.racingIncident;
    t.vsRearEnd += r.vsStandIn.rearEnd;
    t.vsSide += r.vsStandIn.sideswipe;
    t.touchS += r.standInTouchS;
    t.lost += r.standInPlacesLost;
    t.won += r.standInPlacesWon;
    t.aaEvents += r.aiVsAi.events;
    t.aaFault += r.aiVsAi.aiAtFault;
    t.spins += r.aiSpins;
    t.offs += r.aiOffs;
    t.walls += r.aiWalls;
    t.dnf += r.aiDnf;
    t.passes += r.aiPasses;
    t.penS += r.aiPenaltiesS;
    t.siPenS += r.standInPenaltiesS ?? 0;
    if (Number.isFinite(r.aiMeanLapS)) t.aiLapS.push(r.aiMeanLapS);
    if (Number.isFinite(r.standInMeanLapS)) t.standInLapS.push(r.standInMeanLapS);
  }
  return t;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function printTotals(label: string, t: Totals): void {
  console.log(
    `${padR(label, 16)}${pad(`${t.ok}/${t.races}`, 7)}${pad(t.vsEvents, 6)}${pad(t.vsAiFault, 6)}${pad(t.vsStandInFault, 6)}${pad(t.vsRacing, 6)}${pad(t.vsRearEnd, 5)}${pad(t.vsSide, 5)}` +
      `${pad(t.touchS.toFixed(1), 7)}${pad(t.lost, 6)}${pad(t.won, 5)}${pad(t.aaEvents, 6)}${pad(t.aaFault, 6)}${pad(t.spins, 6)}${pad(t.offs, 5)}${pad(t.walls, 5)}${pad(t.dnf, 4)}${pad(t.passes, 7)}${pad(t.penS, 5)}${pad(t.siPenS, 6)}` +
      `${pad(mean(t.aiLapS).toFixed(2), 8)}${pad(mean(t.standInLapS).toFixed(2), 8)}`
  );
}

async function main(): Promise<void> {
  const races: { arm: string; o: StandInRaceOptions }[] = [];
  for (const arm of arms)
    for (const trackId of tracks)
      for (const standIn of profiles)
        for (let k = 0; k < seeds; k++)
          races.push({ arm: arm.name, o: { trackId, car, seed: 101 + (seed0 + k) * 31, laps, aiCars, standIn, racecraft: arm.racecraft, localPlanner, skill, weather } });
  console.error(`${races.length} races (${arms.length} arm(s) × ${tracks.length} tracks × ${profiles.length} profiles × ${seeds} seeds), ${jobsN} at once`);
  const started = Date.now();
  const results = await pool(races.map((r) => () => runOne(r.o)), jobsN);
  console.error(`done in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  const rows = races.map((r, i) => ({ ...r, result: results[i] }));
  if (argv.includes('--json')) writeFileSync(opt('json', 'race-ab.json'), JSON.stringify({ arms, rows }, null, 1));

  console.log(`\n${car} · ${laps} laps · ${aiCars} AI + stand-in · seeds ${seeds} · tracks ${tracks.join(', ')}`);
  for (const arm of arms) if (Object.keys(arm.racecraft).length) console.log(`arm ${arm.name}: ${JSON.stringify(arm.racecraft)}`);
  console.log(
    `${padR('', 16)}${pad('races', 7)}${pad('vsSI', 6)}${pad('AIflt', 6)}${pad('SIflt', 6)}${pad('race', 6)}${pad('rear', 5)}${pad('side', 5)}` +
      `${pad('touch', 7)}${pad('lost', 6)}${pad('won', 5)}${pad('AvA', 6)}${pad('AvAf', 6)}${pad('spin', 6)}${pad('off', 5)}${pad('wall', 5)}${pad('dnf', 4)}${pad('passes', 7)}${pad('pen', 5)}${pad('SIpen', 6)}${pad('AI lap', 8)}${pad('SI lap', 8)}`
  );
  for (const arm of arms) {
    const mine = rows.filter((r) => r.arm === arm.name);
    printTotals(`${arm.name} all`, totals(mine.map((r) => r.result)));
    for (const p of profiles) printTotals(`${arm.name}  ${p}`, totals(mine.filter((r) => r.o.standIn === p).map((r) => r.result)));
    for (const tr of tracks) printTotals(`${arm.name}  ${tr.slice(0, 13)}`, totals(mine.filter((r) => r.o.trackId === tr).map((r) => r.result)));
  }
  console.log(
    'vsSI = contacts with the stand-in (once per pair per s) · AIflt/SIflt = race control has the AI / stand-in at fault · race = racing incident\n' +
      'rear/side = from behind / moved across · touch = s the stand-in spent touching an AI car · lost/won = places the stand-in lost/won on the road\n' +
      'AvA = AI v AI contacts, AvAf at fault · passes = AI passes (all) · pen = AI penalty s · SIpen = stand-in penalty s · AI lap / SI lap = mean flying lap (s)'
  );
}

void main();
