/**
 * Career drive-plan audit: each (series, car, circuit) raced as the career races it (the series' grid with a stand-in
 * in the player's slot, its full race length in laps, its AI skill at each level) on the car's drive plan and on its
 * own driver, the same seeds and stand-in profiles for both arms. One JSON line per race goes to `--out`; a run that
 * stops resumes where it left off (races already in the file are skipped). `--report` reads the file back: totals per
 * combo, level and arm, and the verdict of the gate below.
 *
 *   npx tsx scripts/ai/career-plan-audit.ts --combos combos.json --levels medium,high --races 8 --jobs 9 --out audit.jsonl
 *       [--only 'clubCup_europe|liana|grobnik,...'] [--length full|long|medium|short]
 *   npx tsx scripts/ai/career-plan-audit.ts --report audit.jsonl [--md] [--json verdicts.json]
 *
 * `touch <out>.stop` drains a run: no new races start, those running finish and are written.
 *
 * combos.json: `[{ "series": "clubCup_europe", "car": "liana", "track": "grobnik", "check": { "ok": true, ... } }]`, the
 * check being the car's plan check on the GT3 line (`metadata.aiPlansByLine.gt3[car]`, as the hosted file has it or a
 * candidate's). The plan arm races with it, the own-driver arm with the same check marked failed, whatever the circuit's
 * own file says: both arms are given explicitly.
 *
 * Stand-in profiles rotate line / early / weave / slow over the races (race i: seed 101 + 31 i), so 8 races give each two.
 *
 * Gate, per level (the plan must pass it at every level raced):
 *  - quicker: the leader's mean flying lap (the leading AI car at the flag), averaged over the races, is lower on the plan;
 *  - not clearly worse, with n races per arm: the AI's own mistakes (spins + offs + wall hits) and the AI-v-AI contacts
 *    each at most 1.5 × the own driver's + n / 2 (+4 in 8 races); AI-at-fault contacts with the stand-in and DNFs each at
 *    most the own driver's + max(2, n / 8).
 * A plan fails early (before 8 races) where its mistakes so far are already past what the gate could allow in 8: more
 * than 1.5 × (the own driver's so far scaled to 8 races, + 4) + 4, so it fails even if the own driver made 4 more
 * mistakes than its rate in the races not yet run. Headless races at full career length run at 1.5-3 × real time with ten
 * at once on a shared machine, so combos are raced in rounds (`--races 2`, then 4, 8) and stop on that.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { aiSkillFor, lapsFor, seriesById, type AiLevel, type RaceLength } from '../../src/lib/career/ladder';
import type { AiPlanCheck } from '../../src/lib/track-data';
import type { StandInProfile, StandInRaceOptions, StandInRaceResult } from './lib/stand-in-race';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

interface Combo {
  series: string;
  car: string;
  track: string;
  check: AiPlanCheck;
}
type Arm = 'plan' | 'own';
interface Row {
  key: string;
  series: string;
  car: string;
  track: string;
  level: AiLevel;
  skill: number;
  arm: Arm;
  i: number;
  laps: number;
  /** Wall time the race took (s) */
  wallS?: number;
  result: StandInRaceResult | null;
}

const PROFILES: StandInProfile[] = ['line', 'early', 'weave', 'slow'];
const comboId = (c: { series: string; car: string; track: string }) => `${c.series}|${c.car}|${c.track}`;
const rowKey = (c: Combo, level: AiLevel, arm: Arm, i: number) => `${comboId(c)}|${level}|${arm}|${i}`;

const trackLengths = new Map<string, number>(
  (JSON.parse(readFileSync('public/tracks/index.json', 'utf8')) as { id: string; lengthM: number }[]).map((t) => [t.id, t.lengthM])
);

function runOne(o: StandInRaceOptions): Promise<StandInRaceResult | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=THREE_CJS_DEPRECATED', '--import', 'tsx', 'scripts/ai/race-ab.ts', '--one', JSON.stringify(o)], {
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
        console.error(`race failed: ${JSON.stringify(o).slice(0, 400)}\n${err.slice(-1500)}`);
        resolve(null);
      }
    });
  });
}

async function audit(): Promise<void> {
  const out = opt('out', 'career-plan-audit.jsonl');
  const combos = (JSON.parse(readFileSync(opt('combos', 'combos.json'), 'utf8')) as Combo[]).filter(
    (c) => !argv.includes('--only') || opt('only', '').split(',').includes(comboId(c))
  );
  const levels = opt('levels', 'medium,high').split(',') as AiLevel[];
  const races = Number(opt('races', '8'));
  const jobsN = Number(opt('jobs', '8'));
  const length = opt('length', 'full') as RaceLength;
  const done = new Set<string>();
  if (existsSync(out))
    for (const line of readFileSync(out, 'utf8').split('\n'))
      if (line.trim()) done.add((JSON.parse(line) as Row).key);

  const todo: { row: Omit<Row, 'result'>; o: StandInRaceOptions }[] = [];
  for (const level of levels)
    for (const c of combos) {
      const series = seriesById(c.series);
      if (!series) throw new Error(`unknown series ${c.series}`);
      const lapM = trackLengths.get(c.track);
      if (!lapM) throw new Error(`no length for ${c.track}`);
      const laps = lapsFor(series, length, lapM);
      const skill = aiSkillFor(series, level);
      for (let i = 0; i < races; i++)
        for (const arm of ['plan', 'own'] as const) {
          const key = rowKey(c, level, arm, i);
          if (done.has(key)) continue;
          const plans = { gt3: { [c.car]: { ...c.check, ok: arm === 'plan' } } };
          todo.push({
            row: { key, series: c.series, car: c.car, track: c.track, level, skill, arm, i, laps },
            o: { trackId: c.track, car: c.car, seed: 101 + i * 31, laps, aiCars: series.grid - 1, standIn: PROFILES[i % PROFILES.length], skill, plans },
          });
        }
    }
  console.error(`${todo.length} races to run (${done.size} already in ${out}), ${jobsN} at once`);
  const started = Date.now();
  let next = 0;
  let finished = 0;
  await Promise.all(
    Array.from({ length: jobsN }, async () => {
      while (next < todo.length) {
        // A stop file next to the output: start no more races, let those running finish
        if (existsSync(`${out}.stop`)) break;
        const job = todo[next++];
        const t0 = Date.now();
        const result = await runOne(job.o);
        appendFileSync(out, JSON.stringify({ ...job.row, wallS: Math.round((Date.now() - t0) / 1000), result }) + '\n');
        finished++;
        if (finished % 10 === 0 || finished === todo.length)
          console.error(`  ${finished}/${todo.length} races, ${((Date.now() - started) / 60000).toFixed(1)} min`);
      }
    })
  );
}

// ---- Report

interface Totals {
  n: number;
  unfinished: number;
  spins: number;
  offs: number;
  walls: number;
  mistakes: number;
  ava: number;
  vsSi: number;
  vsSiAi: number;
  dnf: number;
  leaderLapS: number;
  aiLapS: number;
  bestLapS: number;
  /** The most spins one car had in a race, over the races */
  worstCarSpins: number;
}

const mean = (a: number[]) => {
  const f = a.filter(Number.isFinite);
  return f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN;
};

function totals(rows: Row[]): Totals {
  const rs = rows.map((r) => r.result).filter((r): r is StandInRaceResult => r !== null);
  const sum = (f: (r: StandInRaceResult) => number) => rs.reduce((a, r) => a + f(r), 0);
  const spins = sum((r) => r.aiSpins);
  const offs = sum((r) => r.aiOffs);
  const walls = sum((r) => r.aiWalls);
  return {
    n: rs.length,
    unfinished: rows.length - rs.filter((r) => r.finished).length,
    spins,
    offs,
    walls,
    mistakes: spins + offs + walls,
    ava: sum((r) => r.aiVsAi.events),
    vsSi: sum((r) => r.vsStandIn.events),
    vsSiAi: sum((r) => r.vsStandIn.aiAtFault),
    dnf: sum((r) => r.aiDnf),
    leaderLapS: mean(rs.map((r) => r.leaderMeanLapS)),
    aiLapS: mean(rs.map((r) => r.aiMeanLapS)),
    bestLapS: Math.min(...rs.map((r) => r.aiBestLapS).filter(Number.isFinite)),
    worstCarSpins: Math.max(0, ...rs.map((r) => Math.max(0, ...(r.aiSpinsByCar ?? [])))),
  };
}

/** The gate's verdict for a plan against the own driver at one level: '' when it passes, else the reasons */
export function gateFails(plan: Totals, own: Totals): string[] {
  const n = Math.min(plan.n, own.n);
  const why: string[] = [];
  const worse = (p: number, o: number) => p > 1.5 * o + n / 2;
  if (!(plan.leaderLapS < own.leaderLapS)) why.push(`not quicker (${plan.leaderLapS.toFixed(2)} vs ${own.leaderLapS.toFixed(2)} s)`);
  if (worse(plan.mistakes, own.mistakes)) why.push(`mistakes ${own.mistakes} → ${plan.mistakes}`);
  if (worse(plan.ava, own.ava)) why.push(`AI-v-AI ${own.ava} → ${plan.ava}`);
  if (plan.vsSiAi > own.vsSiAi + Math.max(2, n / 8)) why.push(`AI-fault vs stand-in ${own.vsSiAi} → ${plan.vsSiAi}`);
  if (plan.dnf > own.dnf + Math.max(2, n / 8)) why.push(`DNF ${own.dnf} → ${plan.dnf}`);
  if (plan.unfinished > own.unfinished) why.push(`unfinished races ${own.unfinished} → ${plan.unfinished}`);
  return why;
}

/** The early fail (see the header): '' when the plan could still pass in 8 races */
function decisiveFail(rows: Row[]): string {
  const mistakes = (r: Row) => (r.result ? r.result.aiSpins + r.result.aiOffs + r.result.aiWalls : NaN);
  let plan = 0;
  let own = 0;
  let n = 0;
  for (const p of rows.filter((r) => r.arm === 'plan')) {
    const o = rows.find((r) => r.arm === 'own' && r.i === p.i);
    if (!o?.result || !p.result) continue;
    plan += mistakes(p);
    own += mistakes(o);
    n++;
  }
  if (n < 2 || n >= 8) return '';
  const ownAt8 = (own * 8) / n + 4;
  return plan > 1.5 * ownAt8 + 4 ? `past the gate in ${n}: mistakes ${own} → ${plan} (8 races allow ${(1.5 * ownAt8 + 4).toFixed(0)} at most)` : '';
}

function report(): void {
  const rows = readFileSync(opt('report', 'career-plan-audit.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
  const md = argv.includes('--md');
  const ids = [...new Set(rows.map((r) => comboId(r)))];
  const head = ['series', 'car', 'circuit', 'level', 'skill', 'laps', 'arm', 'races', 'spins', 'offs', 'walls', 'AvA', 'vsSI', 'SI AI-flt', 'DNF', 'leader lap', 'AI lap', 'best', 'verdict'];
  const lines: string[][] = [];
  const verdicts = new Map<string, string>();
  const json: { series: string; car: string; track: string; pass: boolean; status: string; levels: Record<string, { plan: Totals; own: Totals; fails: string[]; status: string }> }[] = [];
  for (const id of ids) {
    const mine = rows.filter((r) => comboId(r) === id);
    const levels = [...new Set(mine.map((r) => r.level))];
    const fails: string[] = [];
    const open: string[] = [];
    const entry = { series: mine[0].series, car: mine[0].car, track: mine[0].track, pass: true, status: '', levels: {} as Record<string, { plan: Totals; own: Totals; fails: string[]; status: string }> };
    json.push(entry);
    for (const level of levels) {
      const at = mine.filter((r) => r.level === level);
      const p = totals(at.filter((r) => r.arm === 'plan'));
      const o = totals(at.filter((r) => r.arm === 'own'));
      const n = Math.min(p.n, o.n);
      const decisive = decisiveFail(at);
      // Under 8 races a level is decided only by the early fail; else it is open
      const why = decisive ? [decisive, ...gateFails(p, o)] : n >= 8 ? gateFails(p, o) : [];
      const status = why.length ? 'FAIL' : n >= 8 ? 'pass' : `open (${n})`;
      entry.levels[level] = { plan: p, own: o, fails: why, status };
      if (status !== 'pass') entry.pass = false;
      if (why.length) fails.push(`${level}: ${why.join(', ')}`);
      else if (status !== 'pass') open.push(`${level} ${status}`);
      for (const [arm, t] of [['plan', p], ['own', o]] as const)
        lines.push([
          at[0].series, at[0].car, at[0].track, level, String(at[0].skill), String(at[0].laps), arm, String(t.n), String(t.spins), String(t.offs), String(t.walls),
          String(t.ava), String(t.vsSi), String(t.vsSiAi), String(t.dnf), t.leaderLapS.toFixed(2), t.aiLapS.toFixed(2), t.bestLapS.toFixed(2),
          arm === 'plan' ? (why.length ? `FAIL ${why.join('; ')}` : status) : '',
        ]);
    }
    entry.status = fails.length ? 'FAIL' : open.length ? 'open' : 'pass';
    verdicts.set(id, fails.length ? `FAIL (${fails.join(' | ')})` : open.length ? `open (${open.join(', ')})` : `pass (${levels.join(', ')})`);
  }
  if (md) {
    console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
    for (const l of lines) console.log(`| ${l.join(' | ')} |`);
  } else {
    const w = head.map((h, k) => Math.max(h.length, ...lines.map((l) => (k === head.length - 1 ? 0 : l[k].length))));
    console.log(head.map((h, k) => h.padEnd(w[k])).join(' '));
    for (const l of lines) console.log(l.map((v, k) => (k === head.length - 1 ? v : v.padEnd(w[k]))).join(' '));
  }
  console.log('');
  for (const [id, v] of verdicts) console.log(`${id}: ${v}`);
  if (argv.includes('--json')) writeFileSync(opt('json', 'career-plan-audit.json'), JSON.stringify(json, null, 1));
}

if (argv.includes('--report')) report();
else void audit();
