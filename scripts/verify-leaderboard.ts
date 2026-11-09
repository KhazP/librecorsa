/**
 * Headless checks of the online lap boards: laps carry their conditions, the sample-consistency checks pass real laps
 * while refusing cheap fakes, and the board API (cloudflare/api/board.ts, run here on an in-memory SQLite and bucket)
 * ranks every driver once on one board per circuit and car, keeps their best lap of each class, and guards names.
 *
 *   npx tsx scripts/verify-leaderboard.ts
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { LapRecorder, validateLapRecording, type CompletedLap } from '../src/lib/sim/lap-recorder';
import { lapPlausibilityProblem } from '../src/lib/sim/lap-plausibility';
import { LAP_SAMPLE_STRIDE, PHYSICS_VERSION, lapBoardClass, type LapRecording } from '../src/lib/sim/lap-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi } from '../cloudflare/api/index';
import { boardDeps, driverNameKey, listLaps, submitLap, type BoardDeps } from '../cloudflare/api/board';
import type { Env } from '../cloudflare/api/types';
import { fakeD1, fakeR2 } from './lib/fake-cloudflare';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};

// A real lap: the VF26 on autopilot round Rwanda, recorded as the game records it (the second lap, a flying one)
const track = getActiveTrackData();
const car = new F1Physics2026(track);
car.aiAutopilot = true;
const recorder = new LapRecorder({
  trackLengthM: track.totalLengthM,
  turns: [],
  trackId: 'rwanda',
  vehicle: 'vf26',
  driverName: 'Test Driver',
  driverCode: 'TST',
});
let lap: LapRecording | null = null;
let autopilotLap: CompletedLap | null = null;
let laps = 0;
for (let f = 0; f < 60 * 600 && !autopilotLap; f++) {
  const t = car.step(1 / 60, {});
  // Lap 2 is assisted and on Casual for a moment mid-lap: the lap keeps the most-aided preset and the least
  // realistic level. Lap 3 has the autopilot report driving for a moment.
  const moment = t.currentLapTimeMs > 30_000 && t.currentLapTimeMs < 30_100;
  const done = recorder.update({
    telemetry: t,
    position: car.worldPosition,
    quaternion: car.worldQuaternion,
    conditions: {
      assists: laps === 1 && moment ? 'assisted' : 'pro',
      compound: 'medium',
      surface: 'dry',
      realism: laps === 1 && moment ? 'casual' : 'full',
      physicsVersion: PHYSICS_VERSION,
      autopilot: laps === 2 && moment,
    },
  });
  if (!done) continue;
  laps++;
  if (laps === 2) lap = done.recording;
  if (laps === 3) autopilotLap = done;
}
if (!lap) {
  console.error('No lap completed');
  process.exit(1);
}
const real = lap;

// 1. Conditions --------------------------------------------------------------------------------------------------------
check('the lap carries its conditions', real.conditions?.compound === 'medium' && real.conditions.physicsVersion === PHYSICS_VERSION);
check('a moment on assists makes it an assisted lap', real.conditions?.assists === 'assisted', real.conditions?.assists);
check('a moment on Casual makes it a Casual lap', real.conditions?.realism === 'casual', real.conditions?.realism);
check('board class', real.conditions !== undefined && lapBoardClass(real.conditions) === `p${PHYSICS_VERSION}-assisted-casual-dry`);
check('a recording without its realism level is refused', validateLapRecording({ ...real, conditions: { ...real.conditions, realism: undefined } }) === null);
check(
  'an autopilot lap is shown but never ranks',
  autopilotLap !== null && autopilotLap.summary.autopilot && !autopilotLap.summary.isPersonalBest && autopilotLap.recording.conditions?.realism === 'full',
  autopilotLap ? `valid ${autopilotLap.summary.valid}, PB ${autopilotLap.summary.isPersonalBest}` : 'no third lap'
);
check('validation keeps the conditions', validateLapRecording(JSON.parse(JSON.stringify(real)))?.conditions?.assists === 'assisted');
check('malformed conditions are refused', validateLapRecording({ ...real, conditions: { ...real.conditions, surface: 'snow' } }) === null);
const { conditions: _dropped, ...older } = real;
check('an older lap without conditions still loads', validateLapRecording(older) !== null);

// 2. Sample consistency ------------------------------------------------------------------------------------------------
const S = LAP_SAMPLE_STRIDE;
const scaled = (k: number): LapRecording => {
  const data = real.data.slice();
  for (let i = 0; i < data.length; i += S) data[i] = Math.round(data[i] * k * 1000) / 1000;
  return { ...real, lapTimeMs: Math.round(real.lapTimeMs * k), sectorTimesMs: real.sectorTimesMs.map((x) => Math.round(x * k)) as [number, number, number], data };
};
const n = real.data.length / S;
const cut: LapRecording = {
  ...real,
  data: real.data.filter((_, i) => {
    const row = Math.floor(i / S);
    return row <= n / 3 || row >= (2 * n) / 3;
  }),
};
check('a real lap is consistent', lapPlausibilityProblem(real.data) === null, String(lapPlausibilityProblem(real.data)));
check('a lap 5 % faster on a rescaled clock is refused', lapPlausibilityProblem(scaled(0.95).data) !== null, String(lapPlausibilityProblem(scaled(0.95).data)));
check('a lap with a third cut out is refused', lapPlausibilityProblem(cut.data) !== null, String(lapPlausibilityProblem(cut.data)));
const open = { ...real, data: real.data.slice(0, Math.floor(n * 0.9) * S) };
check('a lap that stops short of the line is refused', lapPlausibilityProblem(open.data) !== null, String(lapPlausibilityProblem(open.data)));

// 3. The board API -----------------------------------------------------------------------------------------------------
const schema = readFileSync(join(__dirname, '../cloudflare/migrations/0001_lap_boards.sql'), 'utf8');
const ghosts = fakeR2();
let nowMs = Date.UTC(2026, 10, 10, 12);
const deps: BoardDeps = { db: fakeD1(schema), ghosts, eventRule: () => 'Unknown event', now: () => nowMs };
const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);

type PostAnswer = { ok: boolean; rank?: number; total?: number; error?: string };
let ipCounter = 0;
const post = async (rec: unknown, driverKey: string | null = KEY_A, extra: Record<string, unknown> = {}, ip?: string) => {
  const res = await submitLap(
    deps,
    new Request('https://librecorsa.test/api/laps', {
      method: 'POST',
      body: JSON.stringify({ rec, ...(driverKey === null ? {} : { driverKey }), ...extra }),
      headers: { 'CF-Connecting-IP': ip ?? `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}` },
    })
  );
  return { status: res.status, body: res.body as PostAnswer };
};
type Row = { id: string; name: string; lapTimeMs: number; conditions: { assists: string; realism: string; surface: string; physicsVersion: number } };
type ListAnswer = { laps: Row[]; total: number; physics: number[]; me: { rank: number; lap: Row } | null };
const list = async (query = '', physics = PHYSICS_VERSION) => {
  const res = await listLaps(deps, new URL(`https://librecorsa.test/api/laps?track=rwanda&vehicle=vf26&physics=${physics}${query}`));
  return { status: res.status, body: res.body as ListAnswer };
};
/** The real lap driven by someone else, a little slower or faster, under other conditions */
const variant = (k: number, driverName: string, conditions: Partial<NonNullable<LapRecording['conditions']>> = {}): LapRecording => ({
  ...scaled(k),
  driverName,
  driverCode: driverName.slice(0, 3).toUpperCase(),
  conditions: { ...real.conditions!, ...conditions },
});

async function main(): Promise<void> {
  {
    const res = await post(older);
    check('board: a lap without conditions is refused', res.status === 400 && !res.body.ok, res.body.error);
  }
  {
    const res = await post(scaled(0.95));
    check('board: a rescaled lap is refused', res.status === 400 && !res.body.ok, res.body.error);
  }
  {
    const res = await post(real, null);
    check('board: a lap without a driver key is refused', res.status === 400 && !res.body.ok, res.body.error);
  }
  {
    const res = await post(real);
    check('board: a real lap is ranked', res.status === 200 && res.body.ok && res.body.rank === 1 && res.body.total === 1, res.body.error ?? `rank ${res.body.rank}`);
  }
  {
    const { body } = await list('&name=test%20driver');
    check('board: the lap is listed with what it was driven with', body.laps.length === 1 && body.laps[0].conditions.assists === 'assisted' && body.laps[0].conditions.realism === 'casual');
    check('board: the driver finds their own place', body.me?.rank === 1 && body.total === 1);
    const ghost = ghosts.objects.get(`laps/${body.laps[0].id}.json`);
    check('board: the ghost is kept beside the row', ghost !== undefined && validateLapRecording(JSON.parse(ghost)) !== null);
  }
  {
    // The same driver, slower, without assists: another class, so it is kept, and the board still shows them once
    const res = await post(variant(1.02, 'Test Driver', { assists: 'pro', realism: 'full' }));
    check('board: a slower lap of another class is kept, not refused', res.status === 200 && res.body.ok && res.body.rank === 1, res.body.error);
    const all = (await list()).body;
    check('board: a driver appears once, with their fastest lap', all.laps.length === 1 && all.total === 1 && all.laps[0].conditions.assists === 'assisted');
    const pro = (await list('&assists=pro')).body;
    check('board: narrowed to no assists, their no-assist lap shows', pro.laps.length === 1 && pro.laps[0].conditions.assists === 'pro' && pro.laps[0].lapTimeMs > all.laps[0].lapTimeMs);
    check('board: an unknown filter value is refused', (await list('&assists=cheats')).status === 400);
  }
  {
    const res = await post(variant(1.03, 'Test Driver', { assists: 'pro', realism: 'full' }));
    check('board: a slower lap of the same class is refused', res.status === 409 && !res.body.ok, res.body.error);
    const before = ghosts.objects.size;
    const faster = await post(variant(1.01, 'Test Driver', { assists: 'pro', realism: 'full' }));
    check('board: a faster lap of the same class replaces it, ghost included', faster.body.ok === true && ghosts.objects.size === before, `${ghosts.objects.size} ghosts`);
  }
  {
    // Someone else, faster, no assists
    const res = await post(variant(0.99, 'Quick Rival', { assists: 'pro', realism: 'full' }), KEY_B);
    check('board: a faster driver takes first', res.body.ok === true && res.body.rank === 1 && res.body.total === 2, res.body.error);
    const { body } = await list('&name=Test%20Driver');
    check('board: fastest first, everyone once', body.laps.length === 2 && body.laps[0].name === 'Quick Rival' && body.laps[1].name === 'Test Driver');
    check('board: the first driver is now second of two', body.me?.rank === 2 && body.total === 2);
    const assisted = (await list('&assists=assisted&name=Test%20Driver')).body;
    check('board: narrowed to assisted laps, only the assisted driver, first', assisted.laps.length === 1 && assisted.total === 1 && assisted.me?.rank === 1);
  }
  {
    const res = await post(variant(0.985, '  test   DRIVER ', {}), KEY_B);
    check('board: a claimed name needs its key (case and spaces ignored)', res.status === 409 && !res.body.ok, res.body.error);
    check('name key: outer spaces off, inner runs as one, lower case', driverNameKey('  Test \t Driver ') === 'test driver');
  }
  {
    const res = await post(real, KEY_A, { event: '2026-W46' });
    check('board: an unknown event is refused', res.status === 400 && !res.body.ok, res.body.error);
  }
  {
    // A lap from an older physics revision goes on that revision's board
    const res = await post(variant(0.98, 'Old Timer', { physicsVersion: 1 }), 'c'.repeat(43));
    check('board: an older-physics lap is ranked on its own board', res.body.ok === true && res.body.rank === 1 && res.body.total === 1);
    const now = (await list()).body;
    check('board: and not on the current one, which lists both revisions', now.total === 2 && now.physics.join() === `${PHYSICS_VERSION},1`, now.physics.join());
    check('board: the older board has it', (await list('', 1)).body.laps[0]?.name === 'Old Timer');
  }
  {
    let last = { status: 0, body: {} as PostAnswer };
    for (let i = 0; i < 31; i++) last = await post(older, KEY_A, {}, '10.9.9.9');
    check('board: upload 31 in an hour from one address is refused', last.status === 429, last.body.error);
  }
  {
    // Seven months later the claim has lapsed: a new key takes the name, and the old owner's laps go
    nowMs += 213 * 24 * 3600 * 1000;
    const res = await post(variant(1.028, 'Test Driver', { assists: 'pro', realism: 'full' }), KEY_B);
    check('board: a lapsed name can be claimed with a new key', res.body.ok === true, res.body.error);
    const { body } = await list('&name=Test%20Driver');
    check("board: the previous owner's laps went with the claim", body.me?.lap.lapTimeMs === variant(1.028, 'x').lapTimeMs && body.total === 2);
    check('board: no ghost is left without a row', ghosts.objects.size === 3, `${ghosts.objects.size} ghosts`);
  }
  {
    // Through the API: switched on and off, never cached
    const env = { ONLINE_BOARD: 'on', BOARD_DB: deps.db, GHOSTS: ghosts } as unknown as Env;
    const api = (path: string, e: Env) => {
      const url = new URL(`https://librecorsa.org${path}`);
      return handleApi(new Request(url), e, url);
    };
    const listed = await api(`/api/laps?track=rwanda&vehicle=vf26&physics=${PHYSICS_VERSION}`, env);
    const rows = ((await listed.json()) as ListAnswer).laps;
    check('api: GET /api/laps lists the board, never cached', listed.status === 200 && rows.length === 2 && listed.headers.get('Cache-Control') === 'no-store');
    const ghost = await api(`/api/laps/${rows[0].id}`, env);
    check('api: GET /api/laps/<id> returns the ghost', ghost.status === 200 && validateLapRecording(await ghost.json()) !== null);
    check('api: an unknown lap is 404', (await api('/api/laps/00000000-0000-4000-8000-000000000000', env)).status === 404);
    check('api: the board switched off answers 404', (await api('/api/laps?track=rwanda&vehicle=vf26&physics=2', { ...env, ONLINE_BOARD: 'off' })).status === 404);
    check('api: no database bound: off', boardDeps({} as Env, () => null) === null);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll leaderboard checks passed.');
}

void main();
