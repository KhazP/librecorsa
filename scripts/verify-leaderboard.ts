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
import { LAP_SAMPLE_STRIDE, PHYSICS_VERSION, lapBoardClass, lapPhysicsVersion, parseLapConditions, type LapRecording } from '../src/lib/sim/lap-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi } from '../cloudflare/api/index';
import { boardKeyOf, loadBoardBest, parseRemoteBoard, saveBoardBest } from '../src/lib/net/leaderboard';
import { challengePlaceLabel, challengeTarget } from '../src/lib/net/challenge-target';
import { boardDeps, driverNameKey, listLaps, renameDriver, submitLap, type BoardDeps } from '../cloudflare/api/board';
import { nameProblem } from '../src/lib/net/name-filter';
import { randomDriverProfile } from '../src/lib/settings/player-settings';
import type { Env } from '../cloudflare/api/types';
import { fakeD1, fakeR2 } from './lib/fake-cloudflare';
import { planImport, type SupabaseDriver, type SupabaseLap } from './migrate-supabase-board';
import { CHALLENGE_ROTATION, challengeAt, challengeCompound, challengeConditionsLabel, challengeProblem, fitsChallenge, isoWeekId, timeLeftLabel } from '../src/lib/net/weekly-challenge';

/** The revision the laps here are driven under: the board of the car they are driven in (the LC26's own) */
const CURRENT = lapPhysicsVersion('lc26');

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};

// A real lap: the LC26 on autopilot round RISE Motordrome, recorded as the game records it (the second lap, a flying one)
const track = getActiveTrackData();
const car = new F1Physics2026(track);
car.aiAutopilot = true;
const recorder = new LapRecorder({
  trackLengthM: track.totalLengthM,
  turns: [],
  trackId: 'rwanda_official_short',
  vehicle: 'lc26',
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
      physicsVersion: CURRENT,
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
check('the lap carries its conditions', real.conditions?.compound === 'medium' && real.conditions.physicsVersion === CURRENT);
check('a moment on assists makes it an assisted lap', real.conditions?.assists === 'assisted', real.conditions?.assists);
check('a moment on Casual makes it a Casual lap', real.conditions?.realism === 'casual', real.conditions?.realism);
check('board class', real.conditions !== undefined && lapBoardClass(real.conditions) === `p${CURRENT}-assisted-casual-dry`);
{
  // The LC26 ships on the rigid-body engine, with a board of its own; on its older engine (a choice kept in the
  // browser) its laps go on the board they always went on
  const g = globalThis as { window?: unknown; localStorage?: unknown };
  const kept = new Map<string, string>();
  const inBrowser = (search: string, stored?: string) => {
    kept.clear();
    if (stored) kept.set('librecorsa.lc26Engine', stored);
    g.window = { location: { search } };
    g.localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    const out = { lc26: lapPhysicsVersion('lc26'), others: lapPhysicsVersion('f12026-car'), kept: kept.get('librecorsa.lc26Engine') };
    delete g.window;
    delete g.localStorage;
    return out;
  };
  const shipped = lapPhysicsVersion('lc26');
  const fresh = inBrowser('');
  const older = inBrowser('', 'classic');
  const asked = inBrowser('?lc26engine=classic');
  const back = inBrowser('?lc26engine=rigid', 'classic');
  check(
    'the LC26 ships on the rigid-body engine with a board of its own, in a script and in a browser that never chose',
    shipped !== PHYSICS_VERSION && fresh.lc26 === shipped && inBrowser('', 'rigid').lc26 === shipped && parseLapConditions({ ...real.conditions, physicsVersion: shipped }) !== null,
    `p${shipped}`
  );
  check(
    'on its older engine its laps keep the board they had: asked for in the address, kept for the browser, and undone the same way',
    older.lc26 === PHYSICS_VERSION && asked.lc26 === PHYSICS_VERSION && asked.kept === 'classic' && back.lc26 === shipped && back.kept === 'rigid',
    `p${older.lc26} / p${back.lc26}`
  );
  check('the other cars keep one board whichever engine the LC26 is on', fresh.others === PHYSICS_VERSION && older.others === PHYSICS_VERSION && lapPhysicsVersion() === PHYSICS_VERSION);
}
{
  // A lap posts itself when it beats this browser's lap on its online board, not its local personal best: a best set
  // before the board began never went up. Each board (circuit, car, class) keeps its own time; a slower time never
  // replaces a faster one
  const g = globalThis as { localStorage?: unknown };
  const kept = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  const key = boardKeyOf(real);
  const other = boardKeyOf({ ...real, trackId: 'dunsfold', vehicle: 'liana' });
  const before = key ? loadBoardBest(key) : -1;
  if (key) {
    saveBoardBest(key, 90_000);
    saveBoardBest(key, 95_000);
  }
  const after = key ? loadBoardBest(key) : -1;
  const elsewhere = other ? loadBoardBest(other) : -1;
  if (key) saveBoardBest(key, 88_000);
  const faster = key ? loadBoardBest(key) : -1;
  delete g.localStorage;
  check(
    'a board with no lap from this browser takes the next one; each board keeps its own best, never a slower one',
    key === `rwanda_official_short|lc26|${lapBoardClass(real.conditions!)}` && boardKeyOf({ ...real, conditions: undefined }) === null && before === null && after === 90_000 && elsewhere === null && faster === 88_000,
    `${before} → ${after} → ${faster}`
  );
}
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
// A Wednesday noon in a week whose challenge is the test lap's circuit and car (RISE Motordrome's short lap, the 2026 prototype)
let nowMs = Date.UTC(2026, 10, 11, 12);
while (challengeAt(nowMs).trackId !== 'rwanda_official_short' || challengeAt(nowMs).vehicle !== 'lc26') nowMs += 7 * 86_400_000;
const week = challengeAt(nowMs);
const deps: BoardDeps = { db: fakeD1(schema), ghosts, eventRule: challengeProblem, now: () => nowMs };
const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);

type PostAnswer = { ok: boolean; rank?: number; total?: number; eventRank?: number; eventTotal?: number; eventError?: string; error?: string; notFaster?: boolean };
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
type ListAnswer = { laps: Row[]; total: number; physics: number[]; me: { rank: number; lap: Row; aboveMs: number | null } | null };
const list = async (query = '', physics = CURRENT) => {
  const res = await listLaps(deps, new URL(`https://librecorsa.test/api/laps?track=rwanda_official_short&vehicle=lc26&physics=${physics}${query}`));
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
    check('board: a slower lap of the same class is refused, marked as only not faster', res.status === 409 && !res.body.ok && res.body.notFaster === true, res.body.error);
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
    check('board: their place says the time of the place above', body.me?.aboveMs === body.laps[0].lapTimeMs, String(body.me?.aboveMs));
    const top = (await list('&name=Quick%20Rival')).body;
    check('board: at the top there is no place above', top.me?.rank === 1 && top.me.aboveMs === null);
    const parse = (me: unknown) => parseRemoteBoard({ ...body, me }, 'rwanda_official_short', 'lc26', CURRENT, {});
    check(
      'board: the game reads the place above, and only a time faster than the player\'s own',
      parse(body.me)?.me?.aboveMs === body.laps[0].lapTimeMs &&
        parse({ ...body.me, aboveMs: undefined })?.me?.aboveMs === null &&
        parse({ ...body.me, aboveMs: body.me!.lap.lapTimeMs + 1 })?.me?.aboveMs === null &&
        parse({ ...body.me, aboveMs: 'x' })?.me?.rank === 2
    );
    const second = challengeTarget(parse(body.me)!);
    const gap = ((body.me!.lap.lapTimeMs - body.laps[0].lapTimeMs) / 1000).toFixed(3);
    check(
      'time trial: the target is your best, the fastest, and the gap to the place above',
      second.bestMs === body.me!.lap.lapTimeMs && second.leaderMs === body.laps[0].lapTimeMs && challengePlaceLabel(second) === `P2 · ${gap} to P1`,
      challengePlaceLabel(second)
    );
    const first = challengeTarget(parseRemoteBoard(top, 'rwanda_official_short', 'lc26', CURRENT, {})!);
    const none = challengeTarget({ ...parse(null)!, me: null });
    check(
      'time trial: at the top it says so, and before a lap only the fastest shows',
      challengePlaceLabel(first) === 'P1 · fastest this week' && none.bestMs === null && none.leaderMs === body.laps[0].lapTimeMs && challengePlaceLabel(none) === 'No time yet'
    );
    const assisted = (await list('&assists=assisted&name=Test%20Driver')).body;
    check('board: narrowed to assisted laps, only the assisted driver, first', assisted.laps.length === 1 && assisted.total === 1 && assisted.me?.rank === 1);
  }
  {
    const res = await post(variant(0.985, '  test   DRIVER ', {}), KEY_B);
    check('board: a claimed name needs its key (case and spaces ignored)', res.status === 409 && !res.body.ok && res.body.notFaster === undefined, res.body.error);
    check('name key: outer spaces off, inner runs as one, lower case', driverNameKey('  Test \t Driver ') === 'test driver');
  }
  {
    // The weekly challenge: this week's circuit and car, its assists and realism, a dry track
    check('challenge: weeks run Monday to Monday (UTC), named by ISO week', isoWeekId(Date.UTC(2026, 10, 9)) === '2026-W46' && isoWeekId(Date.UTC(2026, 11, 28)) === '2026-W53' && isoWeekId(Date.UTC(2027, 0, 4)) === '2027-W01');
    const monday = Date.UTC(2026, 10, 9);
    check('challenge: one challenge from Monday 00:00 to Sunday 23:59', challengeAt(monday).id === '2026-W46' && challengeAt(monday + 7 * 86_400_000 - 1).id === '2026-W46' && challengeAt(monday - 1).id === '2026-W45' && challengeAt(monday).endsMs - challengeAt(monday).startsMs === 7 * 86_400_000);
    {
      // Which circuits a week may be on, and how circuits and cars are paired
      type Listed = { id: string; quality: string };
      const listed = JSON.parse(readFileSync(join(__dirname, '../public/tracks/index.json'), 'utf8')) as Listed[];
      // Listed, and the project's own or a circuit made for a simulator: not one converted from a Sketchfab model
      const sketchfab = (id: string) => !['original', 'sim'].includes(listed.find((x) => x.id === id)?.quality ?? '');
      const offTrial = CHALLENGE_ROTATION.filter((c) => sketchfab(c.trackId));
      const offRace = CHALLENGE_ROTATION.filter((c) => sketchfab(c.race.trackId) || c.race.trackId === 'dunsfold');
      check('challenge: no week is on a circuit converted from a Sketchfab model', offTrial.length === 0, offTrial.map((c) => c.trackId).join(', '));
      check('challenge: no week\'s races are on such a circuit, or at Dunsfold', offRace.length === 0, offRace.map((c) => c.race.trackId).join(', '));
      const first = challengeAt(monday);
      check('challenge: the rotation starts the week of 9 November 2026 with the Liana at Dunsfold, a time trial only', first.trackId === 'dunsfold' && first.vehicle === 'liana' && first.race.trackId === 'rwanda_official' && first.race.vehicle === 'lc26' && challengeAt(monday - 1).trackId === CHALLENGE_ROTATION[CHALLENGE_ROTATION.length - 1].trackId);
      const elsewhere = CHALLENGE_ROTATION.filter((c) => c.race.trackId !== c.trackId || c.race.vehicle !== c.vehicle);
      check('challenge: only the Dunsfold weeks race on another circuit and car', elsewhere.length > 0 && elsewhere.every((c) => c.trackId === 'dunsfold'));
      const raced = CHALLENGE_ROTATION.filter((c) => c.trackId !== 'dunsfold');
      const circuits = new Set(raced.map((c) => c.trackId));
      const cars = new Set(raced.map((c) => c.vehicle));
      const pairs = new Set(raced.map((c) => `${c.trackId} ${c.vehicle}`));
      check('challenge: over the rotation every circuit is driven in every car, once', pairs.size === circuits.size * cars.size && pairs.size === raced.length, `${pairs.size} pairs, ${circuits.size} circuits, ${cars.size} cars, ${raced.length} weeks`);
      check('challenge: a week\'s races are 3 to 14 laps (ten minutes or so on the shortest and the longest lap)', CHALLENGE_ROTATION.every((c) => c.race.laps >= 3 && c.race.laps <= 14), CHALLENGE_ROTATION.map((c) => c.race.laps).join(' '));
    }
    check('challenge: the next week is the next entry of the rotation', challengeAt(monday + 7 * 86_400_000).trackId === CHALLENGE_ROTATION[1].trackId && challengeAt(monday + 14 * 86_400_000).trackId === CHALLENGE_ROTATION[2].trackId);
    check('challenge: time left reads in days, hours, minutes', timeLeftLabel(week.endsMs, week.endsMs - 3 * 86_400_000 - 4 * 3_600_000) === '3 d 4 h' && timeLeftLabel(week.endsMs, week.endsMs - 5 * 60_000) === '5 min');
    const fit = variant(1.015, 'Weekly Hero', { assists: week.assists, realism: week.realism, compound: challengeCompound(week.vehicle) });
    check('challenge: a lap to the rules fits, one with other assists does not', fitsChallenge(fit, week) && !fitsChallenge(variant(1.015, 'x', { assists: 'assisted', realism: week.realism, compound: challengeCompound(week.vehicle) }), week) && !fitsChallenge({ ...fit, conditions: { ...fit.conditions!, surface: 'wet' } }, week));
    check('challenge: a lap on another tyre does not fit', !fitsChallenge({ ...fit, conditions: { ...fit.conditions!, compound: 'medium' } }, week) && challengeProblem({ ...fit, conditions: { ...fit.conditions!, compound: 'medium' } }, week.id, nowMs) !== null);
    check(
      'challenge: every car runs its softest dry tyre, the rules say which',
      CHALLENGE_ROTATION.every((c) => challengeCompound(c.vehicle) === 'soft') && challengeConditionsLabel('liana') === 'Dry track · Street tyres · Low fuel' && challengeConditionsLabel('amg-gt3') === 'Dry track · Soft tyres · Low fuel'
    );

    const res = await post(fit, 'd'.repeat(43), { event: week.id });
    check('challenge: a lap to the rules goes on the week\'s board', res.body.ok === true && res.body.eventRank === 1 && res.body.eventTotal === 1 && res.body.eventError === undefined, res.body.error ?? res.body.eventError);
    const board = (await list(`&event=${week.id}&name=Weekly%20Hero`)).body;
    check('challenge: its board lists only challenge laps', board.laps.length === 1 && board.laps[0].name === 'Weekly Hero' && board.me?.rank === 1);
    check('challenge: the lap counts on the open board too', (await list('&name=Weekly%20Hero')).body.me !== null);

    const off = await post(variant(0.995, 'Weekly Hero', { assists: 'pro', realism: 'full' }), 'd'.repeat(43), { event: week.id });
    check('challenge: a lap not to the rules still counts on the open board, with the reason', off.body.ok === true && off.body.eventRank === undefined && typeof off.body.eventError === 'string', off.body.eventError);
    check('challenge: and stays off the week\'s board', (await list(`&event=${week.id}`)).body.total === 1);
    const late = await post(variant(1.01, 'Weekly Hero', { assists: week.assists, realism: week.realism, compound: challengeCompound(week.vehicle) }), 'd'.repeat(43), { event: '2020-W01' });
    check('challenge: a lap sent for a past week counts on the open board only', late.body.ok === true && late.body.eventError === 'That weekly challenge has ended', late.body.eventError);
    const junk = await post(variant(1.03, 'Weekly Hero', { assists: week.assists, realism: week.realism }), 'd'.repeat(43), { event: 'nope' });
    check('challenge: nothing to store and a bad event: refused with the reason', junk.status === 409 && junk.body.error === 'Unknown event', junk.body.error);
  }
  {
    // A lap from an older physics revision goes on that revision's board
    const res = await post(variant(0.98, 'Old Timer', { physicsVersion: 1 }), 'c'.repeat(43));
    check('board: an older-physics lap is ranked on its own board', res.body.ok === true && res.body.rank === 1 && res.body.total === 1);
    const now = (await list()).body;
    check('board: and not on the current one, which lists both revisions', now.total === 3 && now.physics.join() === `${CURRENT},1`, now.physics.join());
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
    check("board: the previous owner's laps went with the claim", body.me?.lap.lapTimeMs === variant(1.028, 'x').lapTimeMs && body.total === 3);
    const stored = (await deps.db.prepare('SELECT COUNT(*) AS n FROM laps').first<{ n: number }>())?.n;
    check('board: every row has its ghost and every ghost its row', ghosts.objects.size === stored, `${ghosts.objects.size} ghosts, ${stored} rows`);
  }
  {
    // Through the API: switched on and off, never cached
    const env = { ONLINE_BOARD: 'on', BOARD_DB: deps.db, GHOSTS: ghosts } as unknown as Env;
    const api = (path: string, e: Env) => {
      const url = new URL(`https://librecorsa.org${path}`);
      return handleApi(new Request(url), e, url);
    };
    const listed = await api(`/api/laps?track=rwanda_official_short&vehicle=lc26&physics=${CURRENT}`, env);
    const rows = ((await listed.json()) as ListAnswer).laps;
    check('api: GET /api/laps lists the board, never cached', listed.status === 200 && rows.length === 3 && listed.headers.get('Cache-Control') === 'no-store');
    const ghost = await api(`/api/laps/${rows[0].id}`, env);
    check('api: GET /api/laps/<id> returns the ghost', ghost.status === 200 && validateLapRecording(await ghost.json()) !== null);
    check('api: an unknown lap is 404', (await api('/api/laps/00000000-0000-4000-8000-000000000000', env)).status === 404);
    check('api: the board switched off answers 404', (await api('/api/laps?track=rwanda_official_short&vehicle=lc26&physics=2', { ...env, ONLINE_BOARD: 'off' })).status === 404);
    check('api: no database bound: off', boardDeps({} as Env, () => null) === null);
  }

  {
    // Carrying the old Supabase board over (scripts/migrate-supabase-board.ts), onto an empty board
    const db = fakeD1(schema);
    const run = async (sql: string[]) => {
      for (const statement of sql) await db.prepare(statement).run();
    };
    const hash = (c: string) => c.repeat(64);
    const stamp = '2026-10-01T10:00:00Z';
    const oldDrivers: SupabaseDriver[] = [
      { name_key: 'mira tanaka', key_hash: hash('a'), claimed_at: stamp, last_seen: stamp },
      { name_key: 'jonas weber', key_hash: hash('b'), claimed_at: stamp, last_seen: stamp },
      { name_key: 'bad', key_hash: 'nope', claimed_at: stamp, last_seen: stamp },
    ];
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const oldLaps: SupabaseLap[] = [
      { id: id(1), rec: variant(1.0, 'Mira Tanaka', { assists: 'pro', realism: 'full' }), created_at: stamp },
      { id: id(2), rec: variant(1.01, 'Jonas Weber', {}), created_at: stamp },
      { id: id(3), rec: older, created_at: stamp },
      { id: id(4), rec: variant(1.02, 'Nobody Claimed', {}), created_at: stamp },
      { id: id(5), rec: scaled(0.9), created_at: stamp },
    ];
    const plan = planImport(oldLaps, oldDrivers, new Map());
    check('migration: valid laps under claimed names are carried over, the rest left out with a reason', plan.laps === 2 && plan.drivers === 2 && plan.ghosts.size === 2 && Object.values(plan.skipped).reduce((a, b) => a + b, 0) === 4, JSON.stringify(plan.skipped));
    await run(plan.sql);
    await run(plan.sql);
    const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
    check('migration: running it twice writes each row once', (await count('laps')) === 2 && (await count('drivers')) === 2);
    const mira = await db.prepare("SELECT key_hash FROM drivers WHERE name_key = 'mira tanaka'").first<{ key_hash: string }>();
    check('migration: a name keeps the hash of its key', mira?.key_hash === hash('a'));
    const migrated: BoardDeps = { db, ghosts: fakeR2(), eventRule: challengeProblem, now: () => nowMs };
    const listed = (await listLaps(migrated, new URL(`https://librecorsa.test/api/laps?track=rwanda_official_short&vehicle=lc26&physics=${CURRENT}&name=Mira%20Tanaka`))).body as ListAnswer;
    check('migration: the carried-over laps show on the new board', listed.total === 2 && listed.laps[0].name === 'Mira Tanaka' && listed.me?.rank === 1);

    // Later: the driver went faster on the old board from a browser still on the old game; someone else took a name here
    const again = planImport(
      [{ id: id(6), rec: variant(0.99, 'Mira Tanaka', { assists: 'pro', realism: 'full' }), created_at: stamp }, { id: id(7), rec: variant(1.03, 'Mira Tanaka', { assists: 'pro', realism: 'full' }), created_at: stamp }, oldLaps[1]],
      oldDrivers.slice(0, 2),
      new Map([['mira tanaka', hash('a')], ['jonas weber', hash('f')]]),
    );
    await run(again.sql);
    const best = await db.prepare("SELECT id, lap_time_ms FROM laps WHERE name_key = 'mira tanaka'").all<{ id: string; lap_time_ms: number }>();
    check('migration: a second run keeps the faster lap of a driver and class', best.results.length === 1 && best.results[0].id === id(6), best.results.map((r) => r.id).join());
    check('migration: a name claimed by someone else on the new board keeps its new owner', again.drivers === 1 && again.laps === 2 && again.skipped['lap under a name claimed by someone else on the new board'] === 1, JSON.stringify(again.skipped));
  }

  // Names: the filter, and a rename that takes the driver's laps and race results along -----------------------------
  {
    const raceSchema = readFileSync(join(__dirname, '../cloudflare/migrations/0002_race_results.sql'), 'utf8');
    // Back in the week of the test lap's challenge (the checks above moved the clock on)
    const weekNow = week.startsMs + 2 * 86_400_000;
    const r: BoardDeps = { db: fakeD1(`${schema}\n${raceSchema}`), ghosts: fakeR2(), eventRule: challengeProblem, now: () => weekNow };
    let ip = 0;
    const req = (path: string, body: unknown) =>
      new Request(`https://librecorsa.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': `10.9.${Math.floor(ip / 250)}.${ip++ % 250}` } });
    const upload = async (rec: LapRecording, driverKey = KEY_A) => {
      const a = await submitLap(r, req('/api/laps', { rec, driverKey, event: week.id }));
      return { status: a.status, body: a.body as PostAnswer & { taken?: boolean } };
    };
    const rename = async (from: string, to: string, driverKey = KEY_A, code?: string) => {
      const a = await renameDriver(r, req('/api/drivers/rename', { from, to, driverKey, ...(code ? { code } : {}) }));
      return { status: a.status, body: a.body as { ok: boolean; moved?: number; error?: string; taken?: boolean } };
    };
    const rows = async () =>
      (await r.db.prepare('SELECT driver_name AS name, driver_code AS code, name_key AS k, lap_time_ms AS t, event, assists FROM laps ORDER BY event, lap_time_ms').all<{ name: string; code: string; k: string; t: number; event: string; assists: string }>()).results;
    // A lap of this week's challenge: it goes on the open board and the week's
    const fit = (k: number, name: string) => variant(k, name, { assists: week.assists, realism: week.realism, compound: challengeCompound('lc26'), surface: 'dry' });

    const bad = await upload(fit(1, 'Big Dick 9'));
    check('names: a lap under a name the filter refuses is turned down', bad.status === 400 && bad.body.error === 'Pick another name' && (await rows()).length === 0, bad.body.error);
    const first = await upload(fit(1.01, 'Apex Falcon 27'));
    await upload(variant(1.02, 'Apex Falcon 27', { assists: 'pro', realism: 'full' }));
    await r.db
      .prepare("INSERT INTO race_cars (race_id, position, name_key, name, code, laps, dnf, grid) VALUES ('race-1', 1, 'apex falcon 27', 'Apex Falcon 27', 'FAL', 5, 0, 2)")
      .run();
    check('names: a made-up name posts on both boards', first.body.ok === true && first.body.eventRank === 1 && (await rows()).length === 3, first.body.error ?? first.body.eventError);

    const moved = await rename('Apex Falcon 27', 'Mira Tanaka', KEY_A, 'MIR');
    const after = await rows();
    const race = await r.db.prepare("SELECT name, code, name_key FROM race_cars WHERE race_id = 'race-1'").first<{ name: string; code: string; name_key: string }>();
    const oldClaim = await r.db.prepare("SELECT 1 AS x FROM drivers WHERE name_key = 'apex falcon 27'").first();
    check(
      'names: a rename moves every lap (open and challenge) and race result to the new name, and frees the old one',
      moved.body.ok === true && moved.body.moved === 3 && after.every((l) => l.name === 'Mira Tanaka' && l.k === 'mira tanaka' && l.code === 'MIR') && race?.name === 'Mira Tanaka' && race.code === 'MIR' && race.name_key === 'mira tanaka' && oldClaim === null,
      `${moved.body.error ?? `${moved.body.moved} moved`}: ${after.map((l) => l.name).join(', ')}`
    );
    const list = (await listLaps(r, new URL(`https://librecorsa.test/api/laps?track=rwanda_official_short&vehicle=lc26&physics=${CURRENT}&name=Mira%20Tanaka`))).body as ListAnswer;
    check('names: the board lists the driver once, under the new name', list.total === 1 && list.laps[0].name === 'Mira Tanaka' && list.me?.rank === 1);

    const freed = await upload(fit(1.04, 'Apex Falcon 27'), KEY_B);
    const theirs = (await rows()).filter((l) => l.k === 'apex falcon 27');
    check('names: the freed name can be taken by someone else, with none of the old laps', freed.body.ok === true && theirs.length === 2 && theirs.every((l) => l.t > after[0].t), `${theirs.length} rows`);

    const taken = await rename('Mira Tanaka', 'apex  FALCON 27');
    check('names: a name someone else holds is refused, and nothing moves', taken.status === 409 && taken.body.taken === true && (await rows()).filter((l) => l.k === 'mira tanaka').length === 3, taken.body.error);
    const stranger = await rename('Mira Tanaka', 'Sneaky Name', KEY_B);
    check('names: renaming from a name another key holds claims the new one but moves nothing', stranger.body.ok === true && stranger.body.moved === 0 && (await rows()).filter((l) => l.k === 'mira tanaka').length === 3);
    const rude = await rename('Mira Tanaka', 'sh1t driver');
    check('names: a rename to a name the filter refuses is turned down', rude.status === 400 && rude.body.error === 'Pick another name');

    // The same driver had raced under a second name too: renaming back keeps the fastest lap of each class
    await upload(fit(0.98, 'Second Name'));
    const merge = await rename('Second Name', 'Mira Tanaka');
    const mine = (await rows()).filter((l) => l.k === 'mira tanaka');
    const classes = new Set(mine.map((l) => `${l.event}|${l.assists}`));
    check('names: renaming onto a name the driver already holds keeps one lap per class, the fastest', merge.body.ok === true && classes.size === mine.length && mine.length === 3 && Math.min(...mine.map((l) => l.t)) === Math.min(...(await rows()).filter((l) => l.k === 'mira tanaka').map((l) => l.t)), `${mine.length} rows, ${classes.size} classes`);
    const fastest = mine.filter((l) => l.assists === week.assists);
    check('names: the merged laps are the faster ones', fastest.every((l) => l.t === Math.round(real.lapTimeMs * 0.98) || Math.abs(l.t - real.lapTimeMs * 0.98) < 5), fastest.map((l) => l.t).join());

    const cased = await rename('Mira Tanaka', 'MIRA tanaka');
    check('names: a change of letter case only rewrites how the name shows', cased.body.ok === true && (await rows()).filter((l) => l.k === 'mira tanaka').every((l) => l.name === 'MIRA tanaka'));

    // Every name the game makes up for a new driver passes the filter, and so do real names it must not catch
    const madeUp = new Set<string>();
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++) {
        const picks = [b / 16 + 0.01, a / 16 + 0.01, 0.5];
        madeUp.add(randomDriverProfile(() => picks.shift() ?? 0).name);
      }
    const refusedMadeUp = [...madeUp].filter((n) => nameProblem(n) !== null);
    const realNames = ['Daniel Johansson', 'Gabrius78', 'Cockburn', 'Dickens', 'Hancock', 'Scunthorpe', 'Therapist Joe', 'Nazir', 'Niger Delta', 'Sikora', 'Amina', 'Titan', 'Spicer', 'Şükrü Ağaoğlu', 'İsmail'];
    const caught = realNames.filter((n) => nameProblem(n) !== null);
    check('names: every made-up name and the real names tried pass the filter', madeUp.size === 256 && refusedMadeUp.length === 0 && caught.length === 0, [...refusedMadeUp, ...caught].join(', ') || `${madeUp.size} made-up names`);
    const rudeNames = ['F.u.u.c.k', 'a$$', 'Big Dicks', 'Orospu Çocuğu', 'AMK', 'amına koyayım', 'LibreCorsa', 'Libre Corsa', 'Admin'];
    const missed = rudeNames.filter((n) => nameProblem(n) === null);
    check('names: spelled with symbols, spaces, repeats or Turkish letters, refused names are still caught', missed.length === 0, missed.join(', '));
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll leaderboard checks passed.');
}

void main();
