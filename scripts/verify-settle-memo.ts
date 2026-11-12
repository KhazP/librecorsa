/**
 * Headless checks for the reuse of grid settles between identical cars (`src/lib/sim/f12026-car/settle-memo.ts`).
 *
 *   npx tsx scripts/verify-settle-memo.ts
 *
 * A car given a stored settle must be, value for value, the car a real settle makes, and must drive the same after it:
 * every check compares the whole state of the car (body, wheels, tyres, drivetrain, telemetry) between a car built with
 * the reuse off and one built with it on.
 *
 *  1. A car built on the track: the first one stores its settle, the next one is given it
 *  2. Grid slots, standing and rolling, on fresh cars
 *  3. An AI field built and started twice (a new field for each race, as the menus build them)
 *  4. It stays off where it can't be sure: the track-sample ground (it remembers where it last projected), a car that
 *     differs in one setting
 *  5. Building a car on the track settles it once
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { MTR_496R_SIM_PROFILE } from '../src/lib/sim/proto/Mtr496rSim';
import { AiOpponentField } from '../src/lib/sim/ai-opponents';
import { clearSettleMemo, setSettleMemoEnabled, settleMemoStats } from '../src/lib/sim/f12026-car/settle-memo';
import { loadGlbGeometry } from './lib/glb-geometry';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};

setActiveTrack('rwanda_official_short', JSON.parse(readFileSync('public/tracks/rwanda_official_short/track_data.json', 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const root = loadGlbGeometry(`public${track.meshUrl}`);

/** Every primitive in the car's object graph, with its path (the track and its colliders are shared, not the car's) */
function flatten(o: unknown): { vals: unknown[]; paths: string[] } {
  const vals: unknown[] = [];
  const paths: string[] = [];
  const seen = new Set<object>();
  const shared = new Set(['ground', 'walls', 'track', 'trackRoot', 'collider', 'brakingGuide']);
  const walk = (v: unknown, path: string) => {
    if (v === null || typeof v !== 'object') {
      if (typeof v !== 'function') vals.push(v), paths.push(path);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      const a = v as unknown as ArrayLike<number>;
      for (let i = 0; i < a.length; i++) vals.push(a[i]), paths.push(`${path}[${i}]`);
      return;
    }
    if (v instanceof Map) {
      for (const [k, x] of v) walk(x, `${path}<${String(k)}>`);
      return;
    }
    for (const k of Object.keys(v)) if (!shared.has(k)) walk((v as Record<string, unknown>)[k], `${path}.${k}`);
  };
  walk(o, '');
  return { vals, paths };
}
/** The first few values that differ between two cars (none: the same car) */
function differences(a: unknown, b: unknown): string[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const out: string[] = [];
  if (fa.vals.length !== fb.vals.length) out.push(`${fa.vals.length} vs ${fb.vals.length} values`);
  for (let i = 0; i < Math.min(fa.vals.length, fb.vals.length) && out.length < 3; i++) {
    if (!Object.is(fa.vals[i], fb.vals[i])) out.push(`${fa.paths[i]} ${String(fa.vals[i])} vs ${String(fb.vals[i])}`);
  }
  return out;
}
const same = (name: string, a: unknown, b: unknown) => {
  const d = differences(a, b);
  check(name, d.length === 0, d.length ? d.join('; ') : `${flatten(a).vals.length} values equal`);
};
const drive = (cars: F12026CarSim[], seconds: number) => {
  for (const c of cars) c.aiAutopilot = true;
  for (let i = 0; i < seconds * 120; i++) for (const c of cars) c.step(1 / 120, {});
};
const hits = () => settleMemoStats().hits;

// ---- 1. A car built on the track
{
  setSettleMemoEnabled(false);
  const real = new F12026CarSim(track, root, MTR_496R_SIM_PROFILE);
  setSettleMemoEnabled(true);
  clearSettleMemo();
  let t = performance.now();
  const stored = new F12026CarSim(track, root, MTR_496R_SIM_PROFILE);
  const tStored = performance.now() - t;
  const h0 = hits();
  t = performance.now();
  const copied = new F12026CarSim(track, root, MTR_496R_SIM_PROFILE);
  const tCopied = performance.now() - t;
  check('Build: the second identical car is given the first one\'s settle', hits() === h0 + 1, `${tStored.toFixed(0)} ms, then ${tCopied.toFixed(1)} ms`);
  same('Build: the car that stored its settle is the real one', real, stored);
  same('Build: the car given the settle is the real one', real, copied);
  drive([real, copied], 20);
  same('Build: ... and still the same after 20 s on the autopilot', real, copied);
}

// ---- 2. Grid slots, standing and rolling (the default F1 car)
for (const [flying, slot] of [[false, 4], [true, 3]] as const) {
  const kind = flying ? 'rolling' : 'standing';
  setSettleMemoEnabled(false);
  const real = new F12026CarSim(track, root);
  real.resetToStartGrid(flying, slot, flying ? 6 : undefined);
  setSettleMemoEnabled(true);
  new F12026CarSim(track, root).resetToStartGrid(flying, slot, flying ? 6 : undefined);
  const copied = new F12026CarSim(track, root);
  const h0 = hits();
  copied.resetToStartGrid(flying, slot, flying ? 6 : undefined);
  check(`Grid: slot ${slot} ${kind} is reused`, hits() === h0 + 1);
  same(`Grid: slot ${slot} ${kind}, given the settle = settled`, real, copied);
  drive([real, copied], 10);
  same(`Grid: slot ${slot} ${kind}, the same after 10 s on the autopilot`, real, copied);
}

// ---- 3. An AI field built and started twice
{
  const drivers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((code, i) => ({ code, teamColorHex: '#fff', pace: 0.97 - i * 0.01 }));
  const run = (memoOn: boolean) => {
    setSettleMemoEnabled(memoOn);
    clearSettleMemo();
    const player = new F12026CarSim(track, root);
    const races: { sims: unknown[]; buildMs: number; startMs: number }[] = [];
    for (let race = 0; race < 2; race++) {
      let t = performance.now();
      const field = new AiOpponentField(track, player, drivers, undefined, { learning: false, seed: 3 + race });
      field.attachTrackRoot(root as never);
      const buildMs = performance.now() - t;
      t = performance.now();
      field.startRace(true);
      const startMs = performance.now() - t;
      for (let i = 0; i < 240; i++) field.update(1 / 120);
      races.push({ sims: (field as unknown as { cars: { sim: unknown }[] }).cars.map((c) => c.sim), buildMs, startMs });
    }
    return races;
  };
  const real = run(false);
  const memo = run(true);
  const f = (r: { buildMs: number; startMs: number }[]) => r.map((x) => `${x.buildMs.toFixed(0)}+${x.startMs.toFixed(0)}`).join(', ');
  check('Field: built faster with the reuse', memo[0].buildMs < real[0].buildMs / 3, `build+start ms, off: ${f(real)}; on: ${f(memo)}`);
  check('Field: the second race starts faster', memo[1].startMs < real[1].startMs / 2);
  let diffs: string[] = [];
  for (let race = 0; race < 2; race++) {
    real[race].sims.forEach((sim, i) => {
      const d = differences(sim, memo[race].sims[i]);
      if (d.length) diffs = diffs.concat(`race ${race} car ${i}: ${d[0]}`);
    });
  }
  check('Field: every car of both races, 2 s after the start, = settled', diffs.length === 0, diffs.slice(0, 3).join('; '));
  // A refusal turns the reuse off for that settle without failing anything else: a new field in the car that the walk
  // can't read, or the settle swapping an object, would quietly bring the cost back
  check('Field: no settle was refused', settleMemoStats().refused === 0, JSON.stringify(settleMemoStats()));
}

// ---- 4. Off where it can't be sure
{
  setSettleMemoEnabled(true);
  clearSettleMemo();
  const before = { ...settleMemoStats() };
  new F12026CarSim(track, null);
  new F12026CarSim(track, null);
  const after = settleMemoStats();
  check('Off: on the track-sample ground (no track root)', after.hits === before.hits && after.misses === before.misses && after.stored === before.stored);
  const a = new F12026CarSim(track, root);
  const b = new F12026CarSim(track, root);
  const c = new F12026CarSim(track, root);
  b.tireCompound = 'hard';
  a.resetToStartGrid(false, 2);
  const h0 = hits();
  b.resetToStartGrid(false, 2);
  const h1 = hits();
  c.resetToStartGrid(false, 2);
  check('Off: a car on other tyres is not given the settle (its twin is)', h1 === h0 && hits() === h1 + 1, `hits ${h0} → ${h1} → ${hits()}`);
  // verify-step-convergence runs the engine at other step sizes: a settle at one is not one at another
  const engine = VehiclePhysics as unknown as { SUBSTEPS: number };
  const game = engine.SUBSTEPS;
  const h2 = hits();
  engine.SUBSTEPS = game * 2;
  try {
    new F12026CarSim(track, root);
  } finally {
    engine.SUBSTEPS = game;
  }
  check('Off: a car settled at another step size is not given the settle', hits() === h2, `hits ${h2} → ${hits()}`);
}

// ---- 5. One settle per build
{
  setSettleMemoEnabled(false);
  const proto = VehiclePhysics.prototype as unknown as { reset: (...a: unknown[]) => void };
  const reset = proto.reset;
  let settles = 0;
  proto.reset = function (this: unknown, ...a: unknown[]) {
    settles++;
    return reset.apply(this, a);
  };
  new F12026CarSim(track, root);
  proto.reset = reset;
  setSettleMemoEnabled(true);
  check('Build: a car built on the track settles once', settles === 1, `${settles}`);
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll settle reuse checks passed.');
