/**
 * Headless checks of the online leaderboard rules: laps carry their conditions and are ranked per board, and the
 * sample-consistency checks pass real laps while refusing cheap fakes. Runs the reference Worker against an
 * in-memory KV. (scripts/leaderboard-supabase/schema.sql mirrors the same rules in SQL.)
 *
 *   npx tsx scripts/verify-leaderboard.ts
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { LapRecorder, validateLapRecording, type CompletedLap } from '../src/lib/sim/lap-recorder';
import { lapPlausibilityProblem } from '../src/lib/sim/lap-plausibility';
import { LAP_SAMPLE_STRIDE, PHYSICS_VERSION, lapBoardClass, type LapRecording } from '../src/lib/sim/lap-types';
import worker from './leaderboard-worker/worker';

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

// 3. The reference Worker ----------------------------------------------------------------------------------------------
const kv = new Map<string, string>();
const env = {
  LAPS: {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
  },
};
const post = async (body: unknown, ip: string) =>
  worker.fetch(
    new Request('https://lb.test/laps', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip } }),
    env
  );
const list = async (board: string | null) =>
  worker.fetch(new Request(`https://lb.test/laps?track=rwanda&vehicle=vf26${board === null ? '' : `&board=${board}`}`), env);
const board = lapBoardClass(real.conditions!);

async function main(): Promise<void> {

  {
    const res = await post(older, '10.0.0.1');
    const body = (await res.json()) as { ok: boolean; error?: string };
    check('worker: a lap without conditions is refused', res.status === 400 && !body.ok, body.error);
  }
  {
    const res = await post(scaled(0.95), '10.0.0.2');
    const body = (await res.json()) as { ok: boolean; error?: string };
    check('worker: a rescaled lap is refused', res.status === 400 && !body.ok, body.error);
  }
  {
    const res = await post(real, '10.0.0.3');
    const body = (await res.json()) as { ok: boolean; rank?: number; error?: string };
    check('worker: a real lap is ranked', res.status === 200 && body.ok && body.rank === 1, body.error ?? `rank ${body.rank}`);
  }
  {
    const rows = ((await (await list(board)).json()) as { laps: { conditions?: unknown }[] }).laps;
    check('worker: the lap is on its own board, with its conditions', rows.length === 1 && rows[0].conditions !== undefined);
    const other = ((await (await list(`p${PHYSICS_VERSION}-pro-full-dry`)).json()) as { laps: unknown[] }).laps;
    check('worker: and on no other board', other.length === 0);
    check('worker: listing without a board is refused', (await list(null)).status === 400);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll leaderboard checks passed.');
}

void main();
