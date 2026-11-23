/**
 * Headless checks of the online lap boards: laps carry their conditions, the sample-consistency checks pass real laps
 * while refusing cheap fakes, and the board API (cloudflare/api/board.ts, run here on an in-memory SQLite and bucket)
 * ranks every driver once on one board per circuit and car, keeps their best lap of each class, and guards names.
 *
 *   npx tsx scripts/verify/verify-leaderboard.ts
 */
import { getActiveTrackData } from '../../src/lib/track-data';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import { LapRecorder, validateLapRecording, type CompletedLap } from '../../src/lib/sim/lap-recorder';
import { lapPlausibilityProblem } from '../../src/lib/sim/lap-plausibility';
import { checkLap } from '../../cloudflare/api/lap-check';
import {
  LAP_SAMPLE_STRIDE,
  PHYSICS_VERSION,
  PHYSICS_VERSIONS,
  CIRCUIT_REVISION_STEP,
  boardChoiceOf,
  boardChoiceOfLap,
  boardChoices,
  boardPhysicsVersion,
  carPhysicsVersion,
  circuitRevision,
  currentBoardBase,
  drivingInputOf,
  isCurrentLapPhysics,
  lapBoardClass,
  lapConditionsNow,
  lapGoesOnBoards,
  lapPhysicsVersion,
  parseLapConditions,
  physicsVersionLabel,
  revisionOnBoard,
  type LapRecording,
} from '../../src/lib/sim/lap-types';
import { CIRCUIT_BOARD_RESETS, type CircuitBoardReset } from '../../src/lib/circuit-board-resets';
import {
  BOARD_FILTER_PREFS_KEY,
  loadBoardFilterPrefs,
  parseBoardFilterPrefs,
  saveBoardFilterPrefs,
} from '../../src/lib/net/board-client';
import { VEHICLE_MODEL_IDS } from '../../src/types/f1';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi } from '../../cloudflare/api/index';
import { boardKeyOf, loadBoardBest, parseRemoteBoard, saveBoardBest } from '../../src/lib/net/leaderboard';
import { challengePlaceLabel, challengeTarget } from '../../src/lib/net/challenge-target';
import { boardDeps, driverNameKey, listLaps, OLDER_PHYSICS, renameDriver, submitLap, type BoardDeps } from '../../cloudflare/api/board';
import { nameProblem } from '../../src/lib/net/name-filter';
import { randomDriverProfile } from '../../src/lib/settings/player-settings';
import type { Env } from '../../cloudflare/api/types';
import { fakeD1, fakeR2 } from '../lib/fake-cloudflare';
import { planImport, type SupabaseDriver, type SupabaseLap } from '../online/migrate-supabase-board';
import { carById, type CarId } from '../../src/lib/cars/car-registry';
import { CHALLENGE_ROTATION, challengeAt, challengeCompound, challengeConditionsLabel, challengeProblem, challengesSoFar, fitsChallenge, isoWeekId, timeLeftLabel } from '../../src/lib/net/weekly-challenge';

/** The circuit of the real lap */
const TRACK = 'rwanda_official_short';
/** The revision the laps here are driven under: the board of the car they are driven in (the LC26's own) */
const CURRENT = lapPhysicsVersion('lc26', TRACK);
/** Circuits' own board restarts, open for the checks that put one in (and take it out again) */
const RESETS = CIRCUIT_BOARD_RESETS as Record<string, CircuitBoardReset[]>;

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
    // Lap 2 is driven on a wheel with a moment of touch and stretches of nothing pressed: it keeps the wheel
    input: laps === 1 ? (moment ? 'touch' : t.currentLapTimeMs % 2000 < 500 ? null : 'wheel') : 'keyboard',
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
    const out = { lc26: lapPhysicsVersion('lc26', TRACK), others: lapPhysicsVersion('f12026-car', TRACK), kept: kept.get('librecorsa.lc26Engine'), restarted: inRestart() };
    delete g.window;
    delete g.localStorage;
    return out;
  };
  /** The LC26's revision on a circuit whose boards started again once (this browser's engine) */
  const inRestart = () => {
    RESETS.restarted_circuit = [{ physics: PHYSICS_VERSION, oldBoard: 'Old kerbs', why: 'a check' }];
    try {
      return lapPhysicsVersion('lc26', 'restarted_circuit');
    } finally {
      delete RESETS.restarted_circuit;
    }
  };
  const shipped = lapPhysicsVersion('lc26', TRACK);
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
  check('the other cars keep one board whichever engine the LC26 is on', fresh.others === PHYSICS_VERSION && older.others === PHYSICS_VERSION && carPhysicsVersion() === PHYSICS_VERSION);

  // The physics versions the boards are named by: the newest is the one driven now, each older one keeps its numbers
  const newest = PHYSICS_VERSIONS[PHYSICS_VERSIONS.length - 1];
  check(
    'versions: the newest named version is the one driven now, the LC26\'s offset with it',
    newest.physics === PHYSICS_VERSION && PHYSICS_VERSION + newest.lc26Offset === shipped,
    `${newest.name} p${newest.physics}+${newest.lc26Offset}`
  );
  check(
    'versions: named in order, each a number of its own',
    PHYSICS_VERSIONS.every((v, i) => v.name === `V${i + 1}` && (i === 0 || v.physics > PHYSICS_VERSIONS[i - 1].physics))
  );
  check(
    'versions: the board of the version driven now is the one laps go on, for every car',
    VEHICLE_MODEL_IDS.every((v) => boardPhysicsVersion(PHYSICS_VERSION, v) === lapPhysicsVersion(v, TRACK) && revisionOnBoard(currentBoardBase(TRACK), v) === lapPhysicsVersion(v, TRACK))
  );
  const v1 = PHYSICS_VERSIONS[0];
  check(
    'versions: Physics V1 is revision 7, the LC26\'s 527',
    v1.physics === 7 && boardPhysicsVersion(v1.physics, 'lc26') === 527 && boardPhysicsVersion(v1.physics, 'amg-gt3') === 7 && PHYSICS_VERSION === 8 && shipped === 528,
    `p${boardPhysicsVersion(v1.physics, 'lc26')}`
  );
  const classicV1 = (() => {
    g.window = { location: { search: '' } };
    g.localStorage = { getItem: (k: string) => (k === 'librecorsa.lc26Engine' ? 'classic' : null), setItem: () => {} };
    const out = boardPhysicsVersion(v1.physics, 'lc26');
    delete g.window;
    delete g.localStorage;
    return out;
  })();
  check('versions: the LC26 on its older engine reads its V1 laps on revision 7', classicV1 === 7, `p${classicV1}`);
  check('versions: named "Physics V2 (New)" and "Physics V1"', physicsVersionLabel(PHYSICS_VERSION) === 'Physics V2 (New)' && physicsVersionLabel(7) === 'Physics V1' && physicsVersionLabel(PHYSICS_VERSION, { short: true }) === 'Physics V2');
  check(
    'versions: a lap\'s revision finds its board, on either LC26 engine',
    boardChoiceOfLap(TRACK, 'lc26', 527) === '7' && boardChoiceOfLap(TRACK, 'lc26', 7) === '7' && boardChoiceOfLap(TRACK, 'lc26', 528) === '8' && boardChoiceOfLap(TRACK, 'amg-gt3', 8) === '8' &&
      boardChoiceOfLap(TRACK, 'amg-gt3', 527) === null && boardChoiceOfLap(TRACK, 'amg-gt3', 6) === null
  );
  check(
    'versions: only the version driven now takes laps, the LC26\'s on either engine',
    isCurrentLapPhysics('lc26', 528, TRACK) && isCurrentLapPhysics('lc26', 8, TRACK) && isCurrentLapPhysics('liana', 8, TRACK) &&
      !isCurrentLapPhysics('lc26', 527, TRACK) && !isCurrentLapPhysics('liana', 7, TRACK) && !isCurrentLapPhysics('liana', 528, TRACK)
  );
  check(
    'versions: a version and the LC26\'s offset stay under a circuit\'s step',
    PHYSICS_VERSIONS.every((v) => v.physics + v.lc26Offset < CIRCUIT_REVISION_STEP)
  );
  const plain = boardChoices(TRACK);
  check(
    'versions: a circuit that never started again has one board per version, the two the picker shows',
    plain.map((c) => `${c.id}:${c.base}:${c.label}`).join() === '8:8:Physics V2 (New),7:7:Physics V1' && plain[0].current && !plain[1].current
  );

  // A circuit's own restart (src/lib/circuit-board-resets.ts): every circuit is at 0 for the Physics V2 reset, so one is
  // put in for these checks and taken out again
  check(
    'circuits: none started again before Physics V2, each restart well formed',
    Object.values(CIRCUIT_BOARD_RESETS).every((list) => list.every((r) => r.physics >= 8 && PHYSICS_VERSIONS.some((v) => v.physics === r.physics) && r.oldBoard.trim().length > 0 && r.oldBoard.length <= 24))
  );
  RESETS[TRACK] = [{ physics: PHYSICS_VERSION, oldBoard: 'Old kerbs', why: 'a check' }];
  try {
    check(
      'circuits: a restart folds into every car\'s revision there, the LC26\'s offset kept',
      circuitRevision(TRACK) === 1 && lapPhysicsVersion('amg-gt3', TRACK) === 1008 && lapPhysicsVersion('lc26', TRACK) === 1528 && currentBoardBase(TRACK) === 1008,
      `p${lapPhysicsVersion('amg-gt3', TRACK)} / p${lapPhysicsVersion('lc26', TRACK)}`
    );
    check('circuits: on the LC26\'s older engine too', older.restarted === 1008 && fresh.restarted === 1528, `p${older.restarted} / p${fresh.restarted}`);
    check('circuits: the other circuits keep their boards', lapPhysicsVersion('amg-gt3', 'spielberg') === 8 && lapPhysicsVersion('lc26', 'spielberg') === 528 && circuitRevision('spielberg') === 0);
    const choices = boardChoices(TRACK);
    check(
      'circuits: the board from before the restart stays in the picker, under its version',
      choices.map((c) => `${c.id}:${c.base}:${c.label}`).join() === '8:1008:Physics V2 (New),8-0:8:Physics V2 · Old kerbs,7:7:Physics V1',
      choices.map((c) => c.id).join()
    );
    check(
      'circuits: a pick is found again on each circuit, or falls back to its version',
      boardChoiceOf(TRACK, '8-0').base === 8 && boardChoiceOf('spielberg', '8-0').id === '8' && boardChoiceOf(TRACK, null).current && boardChoiceOf(TRACK, 'junk').id === '8'
    );
    check(
      'circuits: a lap finds its board, before and after the restart',
      revisionOnBoard(8, 'lc26') === 528 && revisionOnBoard(1008, 'lc26') === 1528 && boardChoiceOfLap(TRACK, 'lc26', 528) === '8-0' && boardChoiceOfLap(TRACK, 'lc26', 1528) === '8' &&
        boardChoiceOfLap(TRACK, 'amg-gt3', 1008) === '8' && boardChoiceOfLap(TRACK, 'amg-gt3', 7) === '7' && boardChoiceOfLap(TRACK, 'amg-gt3', 1007) === null
    );
    check(
      'circuits: only the restarted board takes laps there',
      isCurrentLapPhysics('lc26', 1528, TRACK) && isCurrentLapPhysics('lc26', 1008, TRACK) && !isCurrentLapPhysics('lc26', 528, TRACK) && !isCurrentLapPhysics('amg-gt3', 8, TRACK) &&
        isCurrentLapPhysics('amg-gt3', 8, 'spielberg') && parseLapConditions({ ...real.conditions, physicsVersion: 1528 }) !== null
    );
    const recorder = new LapRecorder({ trackLengthM: 1000, turns: [], trackId: TRACK, vehicle: 'amg-gt3', driverName: 'Rec', driverCode: 'REC' });
    const recorded = () => (recorder as unknown as { physicsVersion: number }).physicsVersion;
    const gt3 = recorded();
    recorder.setContext({ vehicle: 'lc26' });
    check('circuits: the lap recorder ranks laps on the restarted board, for a car set later too', gt3 === 1008 && recorded() === 1528, `p${gt3} / p${recorded()}`);
    const now = lapConditionsNow({ assists: 'pro', compound: 'soft', lineWaterMm: 0, realism: 'full', vehicle: 'lc26', trackId: TRACK });
    check(
      'circuits: the personal best and the online board are kept per restart',
      lapBoardClass(now) === 'p1528-pro-full-dry' && boardKeyOf({ trackId: TRACK, vehicle: 'lc26', conditions: now }) === `${TRACK}|lc26|p1528-pro-full-dry`
    );
  } finally {
    delete RESETS[TRACK];
  }
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
check('a lap keeps the input that drove most of it', real.conditions?.input === 'wheel', real.conditions?.input);
{
  const idle = { throttle: 0, brake: 0, steer: 0 };
  const frame = (f: Partial<Parameters<typeof drivingInputOf>[0]>) =>
    drivingInputOf({ touch: null, source: null, mouseSteer: false, keys: false, pad: idle, setting: 'keyboard', ...f });
  const cases: [string, ReturnType<typeof drivingInputOf>, ReturnType<typeof drivingInputOf>][] = [
    ['phone, throttle on the screen', frame({ touch: { throttle: 1, brake: 0, steer: 0 } }), 'touch'],
    ['phone, coasting with nothing touched', frame({ touch: idle }), null],
    ['keys held with the on-screen controls showing', frame({ touch: idle, keys: true }), 'keyboard'],
    ['keys held with an idle pad plugged in', frame({ source: 'controller', keys: true }), 'keyboard'],
    ['an idle pad and nothing held', frame({ source: 'controller' }), null],
    ['a pad being used', frame({ source: 'controller', pad: { throttle: 0.8, brake: 0, steer: 0.2 } }), 'controller'],
    ['a bound wheel, pedals up', frame({ source: 'wheel', setting: 'wheel' }), 'wheel'],
    ['an unbound non-standard pad with the wheel setting', frame({ source: 'legacy', setting: 'wheel', pad: { throttle: 1, brake: 0, steer: 0 } }), 'wheel'],
    ['a non-standard pad with the controller setting', frame({ source: 'legacy', setting: 'controller', pad: { throttle: 1, brake: 0, steer: 0 } }), 'controller'],
    ['mouse steering', frame({ mouseSteer: true }), 'keyboard'],
  ];
  const wrong = cases.filter(([, got, want]) => got !== want).map(([name, got]) => `${name}: ${got}`);
  check('input: each frame is put down to what is being used', wrong.length === 0, wrong.join('; '));
}
check('validation keeps the input', validateLapRecording(JSON.parse(JSON.stringify(real)))?.conditions?.input === 'wheel');
check(
  'an unknown or missing input drops the icon, not the lap',
  validateLapRecording({ ...real, conditions: { ...real.conditions, input: 'joystick' } })?.conditions?.input === undefined &&
    validateLapRecording({ ...real, conditions: { ...real.conditions, input: undefined } }) !== null,
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
const schema = ['0001_lap_boards.sql', '0007_lap_input.sql', '0009_lap_setup.sql'].map((f) => readFileSync(join(__dirname, '../../cloudflare/migrations', f), 'utf8')).join('\n');
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
type Row = { id: string; name: string; lapTimeMs: number; conditions: { assists: string; realism: string; surface: string; physicsVersion: number; input?: string } };
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
      // The weeks the home page's board lists: this week first, back to the first week, never one before it
      const soFar = challengesSoFar(Date.UTC(2026, 10, 25, 12));
      check('challenge: the weeks so far run newest first back to 2026-W46', soFar.map((w) => w.id).join(',') === '2026-W48,2026-W47,2026-W46' && soFar[2].trackId === 'dunsfold', soFar.map((w) => w.id).join(','));
      check('challenge: before the first week there are none, and the list is capped', challengesSoFar(monday - 1).length === 0 && challengesSoFar(Date.UTC(2030, 0, 1), 5).length === 5);
    }
    {
      // Which circuits a week may be on, and how circuits and cars are paired
      type Listed = { id: string; quality: string };
      const listed = JSON.parse(readFileSync(join(__dirname, '../../public/tracks/index.json'), 'utf8')) as Listed[];
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
      type Kind = { id: string; type?: string };
      const climbs = CHALLENGE_ROTATION.filter((c) => (listed as Kind[]).find((x) => x.id === c.race.trackId)?.type === 'hillclimb');
      check('challenge: no week is on a hill climb', climbs.length === 0, climbs.map((c) => c.trackId).join(', '));
      // The weeks asked for by date
      const on = (y: number, m: number, d: number) => challengeAt(Date.UTC(y, m - 1, d));
      const is = (c: { trackId: string; vehicle: string }, trackId: string, vehicle: string) => c.trackId === trackId && c.vehicle === vehicle;
      check(
        'challenge: 16 Nov the LMDh at Le Mans, 23 Nov the GT3 at the Red Bull Ring, 30 Nov the 496R at Chang (no assists), 7 Dec the Liana at Monaco, 14 Dec the GT3 at RISE',
        is(on(2026, 11, 16), 'le_mans_82', 'lc-lmdh') && is(on(2026, 11, 23), 'spielberg', 'amg-gt3') && is(on(2026, 11, 30), 'chang', 'mtr-496r') && on(2026, 11, 30).assists === 'pro' && is(on(2026, 12, 7), 'monaco', 'liana') && is(on(2026, 12, 14), 'rwanda_official', 'amg-gt3')
      );
      check(
        'challenge: the weeks of the 2027 races at Monaco, Le Mans, the Red Bull Ring and Istanbul are on those circuits',
        is(on(2027, 6, 4), 'monaco', 'lc26') && is(on(2027, 6, 12), 'le_mans_82', 'lc-lmdh') && is(on(2027, 7, 9), 'spielberg', 'lc26') && is(on(2027, 10, 1), 'istanbul_park', 'lc26')
      );
      check('challenge: every fourth week has no assists, also when the list starts again', CHALLENGE_ROTATION.length % 4 === 0 && CHALLENGE_ROTATION.every((c, i) => (c.assists === 'pro') === (i % 4 === 3)), String(CHALLENGE_ROTATION.length));
      // A venue's layouts share the start of their id ("okayama", "okayama_piper")
      const venue = (id: string) => id.split('_')[0];
      const twice = CHALLENGE_ROTATION.filter((c, i) => venue(c.trackId) === venue(CHALLENGE_ROTATION[(i + 1) % CHALLENGE_ROTATION.length].trackId));
      check('challenge: no venue two weeks running', twice.length === 0, twice.map((c) => c.trackId).join(', '));
      // A week may name one car of its vehicle (the GT3 has two); its races are in the same one
      const named = CHALLENGE_ROTATION.filter((c) => c.car !== undefined);
      const wrongCar = named.filter((c) => carById(c.car as CarId).id !== c.car || carById(c.car as CarId).physics !== c.vehicle || c.race.car !== c.car);
      check('challenge: a week that names its car names one of its vehicle, 14 Dec the BMW', wrongCar.length === 0 && on(2026, 12, 14).car === 'bmw-m4-gt3' && on(2026, 11, 23).car === undefined, wrongCar.map((c) => c.car).join(', '));
      const dunsfold = CHALLENGE_ROTATION.filter((c) => c.trackId === 'dunsfold');
      check('challenge: a Dunsfold week\'s races name no car', dunsfold.every((c) => c.race.car === undefined));
      const cars = new Set(CHALLENGE_ROTATION.map((c) => c.vehicle));
      check('challenge: every car but the F1 team cars has its weeks', ['lc26', 'lc-lmdh', 'amg-gt3', 'mtr-496r', 'liana', 'nissan-r33-jgtc', 'nissan-r32-jtcc'].every((v) => cars.has(v as never)) && cars.size === 7, [...cars].join(', '));
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
    // A lap of an older physics version (a tab left open from before the update) is refused: those boards are read only
    const V1 = boardPhysicsVersion(PHYSICS_VERSIONS[0].physics, 'lc26');
    const stale = variant(0.98, 'Old Timer', { physicsVersion: V1 });
    const res = await post(stale, 'c'.repeat(43));
    check('board: a lap of an older physics version is refused, its board read only', res.status === 409 && res.body.error === OLDER_PHYSICS, res.body.error);
    const claimed = await deps.db.prepare('SELECT COUNT(*) AS n FROM drivers WHERE name_key = ?').bind('old timer').first<{ n: number }>();
    check('board: and nothing of it is kept, not even a claim on the name', claimed?.n === 0 && (await list('', V1)).body.total === 0);

    // A V1 lap stored before the update stays on its board, read as it was
    const id = '00000000-0000-4000-8000-000000000001';
    await ghosts.put(`laps/${id}.json`, JSON.stringify(stale));
    await deps.db
      .prepare(
        'INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, input, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, stale.trackId, stale.vehicle, V1, '', 'pro', 'full', 'dry', 'medium', null, 'old timer', 'Old Timer', 'OLD', stale.lapTimeMs, ...stale.sectorTimesMs, stale.recordedAt, nowMs)
      .run();
    const now = (await list()).body;
    check('board: the current one leaves it off, and lists both revisions', now.total === 3 && now.physics.join() === `${CURRENT},${V1}`, now.physics.join());
    check('board: the older board has it', (await list('', V1)).body.laps[0]?.name === 'Old Timer');
  }
  {
    // A circuit's boards start again on their own (src/lib/circuit-board-resets.ts): on a board of its own, so the counts
    // above stay as they are. Put in for these checks and taken out again
    const own: BoardDeps = { db: fakeD1(schema), ghosts: fakeR2(), eventRule: challengeProblem, now: () => nowMs };
    const send = async (rec: LapRecording, key: string, extra: Record<string, unknown> = {}) => {
      const res = await submitLap(
        own,
        new Request('https://librecorsa.test/api/laps', { method: 'POST', body: JSON.stringify({ rec, driverKey: key, ...extra }), headers: { 'CF-Connecting-IP': `10.7.0.${ipCounter++ % 250}` } })
      );
      return { status: res.status, body: res.body as PostAnswer };
    };
    const read = async (query: string) => {
      const res = await listLaps(own, new URL(`https://librecorsa.test/api/laps?track=${TRACK}${query}`));
      return { status: res.status, body: res.body as ListAnswer & { current?: Record<string, number> } };
    };
    // Before the restart: a lap on the board as it was
    const before = await send(variant(0.99, 'Before Fix', { physicsVersion: CURRENT }), 'e'.repeat(43));
    RESETS[TRACK] = [{ physics: PHYSICS_VERSION, oldBoard: 'Old kerbs', why: 'a check' }];
    try {
      const NEW = lapPhysicsVersion('lc26', TRACK);
      const stale = await send(variant(0.98, 'Before Fix', { physicsVersion: CURRENT }), 'e'.repeat(43));
      check('circuit restart: a lap from before it is refused, its board read only', before.body.ok === true && stale.status === 409 && stale.body.error === OLDER_PHYSICS, stale.body.error);
      const rules = { assists: week.assists, realism: week.realism, compound: challengeCompound(week.vehicle), surface: 'dry' as const };
      const after = await send(variant(1.0, 'After Fix', { ...rules, physicsVersion: NEW }), 'f'.repeat(43), { event: week.id });
      check('circuit restart: a lap on the restarted board goes up, to the week\'s board too', after.body.ok === true && after.body.rank === 1 && after.body.total === 1 && after.body.eventRank === 1, after.body.error ?? after.body.eventError);
      check(
        'circuit restart: the week\'s rules go by the restarted board',
        challengeProblem(variant(1.0, 'x', { ...rules, physicsVersion: NEW }), week.id, nowMs) === null && challengeProblem(variant(1.0, 'x', { ...rules, physicsVersion: CURRENT }), week.id, nowMs) !== null
      );
      const newBoard = (await read(`&vehicle=lc26&physics=${NEW}`)).body;
      const oldBoard = (await read(`&vehicle=lc26&physics=${CURRENT}`)).body;
      check(
        'circuit restart: one car\'s boards, before and after, each with its own laps',
        newBoard.laps.map((r) => r.name).join() === 'After Fix' && oldBoard.laps.map((r) => r.name).join() === 'Before Fix' && newBoard.physics.join() === `${NEW},${CURRENT}`,
        newBoard.physics.join()
      );
      const all = (await read('&vehicle=all')).body;
      const allOld = (await read('&vehicle=all&version=8')).body;
      check(
        'circuit restart: every car\'s board is the restarted one, and version=8 the one before it',
        all.laps.map((r) => r.name).join() === 'After Fix' && all.current?.lc26 === NEW && allOld.laps.map((r) => r.name).join() === 'Before Fix' && allOld.current?.lc26 === CURRENT
      );
      const asked = await Promise.all(['1008', '7', '1007', '2008'].map(async (v) => (await read(`&vehicle=all&version=${v}`)).status));
      check('circuit restart: a board the circuit never had is refused', asked.join() === '200,200,400,400', asked.join());
      const elsewhere = (await listLaps(own, new URL('https://librecorsa.test/api/laps?track=spielberg&vehicle=all&version=1008'))).status;
      check('circuit restart: and another circuit has no restarted board', elsewhere === 400);
    } finally {
      delete RESETS[TRACK];
    }
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
    // Through the API: switched on and off; a page that says where a driver stands is never cached (a page anyone
    // may read is kept half a minute: verify-board-stats.ts)
    const env = { ONLINE_BOARD: 'on', BOARD_DB: deps.db, GHOSTS: ghosts } as unknown as Env;
    const api = (path: string, e: Env) => {
      const url = new URL(`https://librecorsa.org${path}`);
      return handleApi(new Request(url), e, url);
    };
    const listed = await api(`/api/laps?track=rwanda_official_short&vehicle=lc26&physics=${CURRENT}&name=Test%20Driver`, env);
    const rows = ((await listed.json()) as ListAnswer).laps;
    check('api: GET /api/laps lists the board, never cached with a name', listed.status === 200 && rows.length === 3 && listed.headers.get('Cache-Control') === 'no-store');
    const ghost = await api(`/api/laps/${rows[0].id}`, env);
    check('api: GET /api/laps/<id> returns the ghost', ghost.status === 200 && validateLapRecording(await ghost.json()) !== null);
    check('api: an unknown lap is 404', (await api('/api/laps/00000000-0000-4000-8000-000000000000', env)).status === 404);
    check('api: the board switched off answers 404', (await api('/api/laps?track=rwanda_official_short&vehicle=lc26&physics=2', { ...env, ONLINE_BOARD: 'off' })).status === 404);
    check('api: no database bound: off', boardDeps({} as Env, () => null) === null);
  }

  {
    // Carrying the old Supabase board over (scripts/online/migrate-supabase-board.ts), onto an empty board
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
    const raceSchema = readFileSync(join(__dirname, '../../cloudflare/migrations/0002_race_results.sql'), 'utf8');
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

  {
    // What drove the lap, on a board of its own: kept with the row, never part of its class
    const own: BoardDeps = { db: fakeD1(schema), ghosts: fakeR2(), eventRule: challengeProblem, now: () => nowMs };
    const send = async (rec: LapRecording, key: string) =>
      (await submitLap(own, new Request('https://librecorsa.test/api/laps', { method: 'POST', body: JSON.stringify({ rec, driverKey: key }), headers: { 'CF-Connecting-IP': `10.9.0.${ipCounter++ % 250}` } }))).body as PostAnswer;
    const rows = async () =>
      ((await listLaps(own, new URL(`https://librecorsa.test/api/laps?track=rwanda_official_short&vehicle=lc26&physics=${CURRENT}`))).body as ListAnswer).laps;
    const wheel = await send(variant(1.02, 'Wheel Driver', { input: 'wheel' }), KEY_A);
    const bare = await send(variant(1.03, 'Old Build', { input: undefined }), KEY_B);
    let laps = await rows();
    check('input: stored and listed with the lap', wheel.ok && laps.find((l) => l.name === 'Wheel Driver')?.conditions.input === 'wheel');
    check('input: a lap without one is taken, listed without one', bare.ok && laps.some((l) => l.name === 'Old Build' && !('input' in l.conditions)));
    const pad = await send(variant(1.01, 'Wheel Driver', { input: 'controller' }), KEY_A);
    laps = await rows();
    const mine = laps.filter((l) => l.name === 'Wheel Driver');
    check('input: another device in the same class replaces the row, not a second one', pad.ok && mine.length === 1 && mine[0].conditions.input === 'controller', `${mine.length} rows`);
    const slower = await send(variant(1.03, 'Wheel Driver', { input: 'touch' }), KEY_A);
    laps = await rows();
    check('input: a slower lap on another device is refused as not faster', slower.notFaster === true && laps.find((l) => l.name === 'Wheel Driver')?.conditions.input === 'controller');
  }

  {
    // Shared setups attached to laps (#148): sanitized on upload, flagged `hasSetup` on rows, preserved in R2 ghost JSON
    const own: BoardDeps = { db: fakeD1(schema), ghosts: fakeR2(), eventRule: challengeProblem, now: () => nowMs };
    const post = async (rec: unknown, key: string) =>
      submitLap(own, new Request('https://librecorsa.test/api/laps', { method: 'POST', body: JSON.stringify({ rec, driverKey: key }), headers: { 'CF-Connecting-IP': `10.10.0.${ipCounter++ % 250}` } }));
    const withSetup: LapRecording = {
      ...variant(1.01, 'Setup Sharer'),
      setup: {
        v: 1,
        vehicle: 'lc26',
        name: 'Unmoderated Name',
        aero: 'low_downforce',
        compound: 'soft',
        chassis: { frontWingClicks: 999, rearWingClicks: -3, rideHeightFrontMm: -15 },
        tuner: { brakeBiasPct: 54.5, tcSlipAngleLevel: 12 },
      },
    };
    const posted = await post(withSetup, KEY_A);
    const listRes = (await listLaps(own, new URL(`https://librecorsa.test/api/laps?track=rwanda_official_short&vehicle=lc26&physics=${CURRENT}`))).body as { laps: Array<{ id: string; name: string; hasSetup?: boolean }> };
    const row = listRes.laps.find((l) => l.name === 'Setup Sharer');
    const storedText = row ? await (await own.ghosts.get(`laps/${row.id}.json`))?.text() : null;
    const storedLap = storedText ? validateLapRecording(JSON.parse(storedText)) : null;
    check(
      'setup: uploaded lap flags hasSetup on board row, strips server name, and clamps to car sheet in R2 JSON',
      posted.status === 200 &&
        row?.hasSetup === true &&
        storedLap?.setup?.name === undefined &&
        storedLap?.setup?.aero === 'low_downforce' &&
        storedLap?.setup?.chassis?.frontWingClicks === 25 &&
        storedLap?.setup?.chassis?.rearWingClicks === -3 &&
        storedLap?.setup?.chassis?.rideHeightFrontMm === -8 &&
        storedLap?.setup?.tuner?.tcSlipAngleLevel === undefined,
      `status=${posted.status} hasSetup=${String(row?.hasSetup)} name=${String(storedLap?.setup?.name)} fw=${String(storedLap?.setup?.chassis?.frontWingClicks)} rhF=${String(storedLap?.setup?.chassis?.rideHeightFrontMm)}`,
    );

    const mismatched = await post({ ...variant(1.02, 'Wrong Car'), setup: { v: 1, vehicle: 'amg-gt3', aero: 'balanced' } }, KEY_B);
    check('setup: setup for a different vehicle is refused on upload', mismatched.status === 400);

    // Unknown/future setup schema (e.g. v: 2) is dropped gracefully rather than refusing a valid PB lap
    const futureSetup = await post({ ...variant(1.02, 'Future Client'), setup: { v: 2, vehicle: 'lc26', aero: 'balanced' } }, KEY_B);
    check('setup: future/unrecognised setup schema is dropped without refusing a valid lap', futureSetup.status === 200);

    // Pre-0009 database (without has_setup column) still accepts uploads with setups cleanly (zero-downtime deploy)
    const pre0009 = ['0001_lap_boards.sql', '0007_lap_input.sql'].map((f) => readFileSync(join(__dirname, '../../cloudflare/migrations', f), 'utf8')).join('\n');
    const oldDeps: BoardDeps = { db: fakeD1(pre0009), ghosts: fakeR2(), eventRule: challengeProblem, now: () => nowMs };
    const oldPost = await submitLap(oldDeps, new Request('https://librecorsa.test/api/laps', { method: 'POST', body: JSON.stringify({ rec: withSetup, driverKey: KEY_A }), headers: { 'CF-Connecting-IP': '10.10.1.1' } }));
    check('setup: pre-0009 schema without has_setup column still stores lap cleanly', oldPost.status === 200);
  }

  {
    // Saved online leaderboard filter toggles (#156)
    const parsedBad = parseBoardFilterPrefs({ noAssists: 'yes', fullRealism: 1, wetOnly: true });
    check(
      'board filters: strict boolean parsing rejects non-boolean values',
      !parsedBad.noAssists && !parsedBad.fullRealism && parsedBad.wetOnly,
    );
    const parsedNull = parseBoardFilterPrefs(null);
    check(
      'board filters: malformed input defaults all toggles off',
      !parsedNull.noAssists && !parsedNull.fullRealism && !parsedNull.wetOnly,
    );
    const store = new Map<string, string>();
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    };
    try {
      const initial = loadBoardFilterPrefs();
      check('board filters: empty storage defaults to unfiltered', !initial.noAssists && !initial.fullRealism && !initial.wetOnly);
      saveBoardFilterPrefs({ noAssists: true, fullRealism: true, wetOnly: false });
      const loaded = loadBoardFilterPrefs();
      check(
        'board filters: saved toggles round-trip through localStorage',
        loaded.noAssists && loaded.fullRealism && !loaded.wetOnly && store.has(BOARD_FILTER_PREFS_KEY),
      );
      store.set(BOARD_FILTER_PREFS_KEY, '{corrupt json');
      const recovered = loadBoardFilterPrefs();
      check('board filters: corrupt storage falls back cleanly to unfiltered', !recovered.noAssists && !recovered.fullRealism && !recovered.wetOnly);
      saveBoardFilterPrefs({ noAssists: false, fullRealism: false, wetOnly: false });
      check('board filters: clearing all toggles removes the storage key', !store.has(BOARD_FILTER_PREFS_KEY));
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWindow;
    }
  }

  // --- Mod content stays off the boards (src/lib/mods) ---
  {
    const rec = lap as LapRecording;
    check('mods: a lap of the game\'s own car and circuit goes on the boards', lapGoesOnBoards(rec));
    check('mods: a lap marked mod (a mod car) does not', !lapGoesOnBoards({ ...rec, mod: true }));
    check('mods: nor one on a mod circuit, mark or not', !lapGoesOnBoards({ ...rec, trackId: 'mod:jdoe.pack/ring' }));
    check('mods: the mark survives a save and reload', validateLapRecording({ ...rec, mod: true })?.mod === true && validateLapRecording(rec)?.mod === undefined);
    const madeUp = checkLap({ ...rec, trackId: 'made_up_circuit' });
    check('mods: the server refuses a lap on a circuit the game does not ship', !madeUp.ok && /Unknown circuit/.test(madeUp.error), madeUp.ok ? 'accepted' : madeUp.error);
    const marked = checkLap({ ...rec, mod: true });
    check('mods: and a lap marked mod', !marked.ok && /mod/.test(marked.error), marked.ok ? 'accepted' : marked.error);
    check('mods: a lap on a shipped circuit still passes the server check', checkLap(rec).ok);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll leaderboard checks passed.');
}

void main();
