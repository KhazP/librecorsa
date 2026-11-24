/**
 * Headless checks of the online board staying reachable for a whole session (issue #122): a read of the online
 * switches (GET /api/config) that gets no answer is tried again with backoff and never read as "off"; a lap set while
 * the board was out of reach goes up exactly once when it answers again, from the failed-upload memory; a board the
 * server turned off stays off with nothing retried; and the retries stay a trickle (src/lib/net/online-config.ts,
 * src/lib/net/board-queue.ts, through the Worker's own API on an in-memory SQLite).
 *
 *   npx tsx scripts/verify/verify-board-retry.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Types only (erased): the modules themselves load below, once the API's address is set
import type { ConfigSourceEnv, OnlineState } from '../../src/lib/net/online-config';
import type { LapRecording } from '../../src/lib/sim/lap-types';
import type { Env } from '../../cloudflare/api/types';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};

// The game reads its API's address when online-config.ts loads: set before anything imports it
process.env.NEXT_PUBLIC_ONLINE_API = 'https://librecorsa.test/api';

/** Lets the promises the fakes resolved run on */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function main(): Promise<void> {
  const { configRetryDelayMs, createConfigSource, boardStateOf, CONFIG_MIN_GAP_MS, CONFIG_RETRY_MAX_MS, readOnlineConfig } = await import(
    '../../src/lib/net/online-config'
  );
  type SourceEnv = ConfigSourceEnv;
  type State = OnlineState;

  // 1. The backoff schedule ---------------------------------------------------------------------------------------------
  {
    const mid = Array.from({ length: 8 }, (_, i) => configRetryDelayMs(i + 1, () => 0.5) / 1000);
    check('backoff: 5 s, 10 s, 20 s, 40 s, then a minute', mid.join(',') === '5,10,20,40,60,60,60,60', `${mid.join(', ')} s`);
    const low = configRetryDelayMs(1, () => 0);
    const high = configRetryDelayMs(50, () => 0.999_999);
    check('backoff: spread ±20 %, never past 72 s', low === 4000 && high <= 72_000 && high > 71_000 && configRetryDelayMs(0, () => 0.5) === 5000, `${low} ms … ${high} ms`);
  }

  // 2. The config source on a fake clock ---------------------------------------------------------------------------------
  const CONFIG_ON = { rooms: true, relay: false, races: true, board: true, raceSlotS: 1200, usage: true, live: true };
  const CONFIG_OFF = { ...CONFIG_ON, board: false };
  type Answer = Error | { status: number; body: string };
  const world = (answer: () => Answer, url: string | null = 'https://lc.test/api/config') => {
    let now = 0;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const calls: number[] = [];
    const flags = { hidden: false, offline: false, watched: 0 };
    const env: SourceEnv = {
      url,
      fetch: async () => {
        calls.push(now);
        const a = answer();
        if (a instanceof Error) throw a;
        return new Response(a.body, { status: a.status, headers: { 'Content-Type': 'application/json' } });
      },
      now: () => now,
      setTimer: (fn, ms) => {
        timers.set(++seq, { at: now + ms, fn });
        return seq;
      },
      clearTimer: (id) => void timers.delete(id as number),
      random: () => 0.5,
      idle: () => flags.hidden || flags.offline,
      onWatching: (on) => void (flags.watched += on ? 1 : -1),
    };
    const source = createConfigSource(env);
    /** Runs the clock on by `ms`, firing the timers due on the way */
    const advance = async (ms: number) => {
      const end = now + ms;
      for (;;) {
        await settle();
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const t of timers) if (t[1].at <= end && (!next || t[1].at < next[1].at)) next = t;
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = end;
      await settle();
    };
    return { source, calls, flags, advance, timers, at: () => now };
  };
  const down = (): Answer => new TypeError('fetch failed');
  const ok = (body: unknown) => (): Answer => ({ status: 200, body: JSON.stringify(body) });

  {
    // Out of reach for an hour, with the page in view: retried on the schedule, about once a minute
    const w = world(down);
    const seen: State[] = [];
    const stop = w.source.watch((s) => seen.push(s));
    await w.advance(3600_000);
    const gaps = w.calls.slice(1).map((t, i) => (t - w.calls[i]) / 1000);
    check('unreachable: tried at once, then 5 s, 10 s, 20 s, 40 s, 60 s…', w.calls[0] === 0 && gaps.slice(0, 6).join(',') === '5,10,20,40,60,60', gaps.slice(0, 7).join(', '));
    check('unreachable: about one read a minute over an hour', w.calls.length >= 60 && w.calls.length <= 64, `${w.calls.length} reads in 60 min`);
    check('unreachable is said as such, never as "off"', seen.length === 1 && seen[0].reach === 'unreachable' && boardStateOf(seen[0]) === 'unreachable');
    // Hidden: nothing goes out; back in view, the retry that fell due goes out at once
    w.flags.hidden = true;
    const before = w.calls.length;
    await w.advance(30 * 60_000);
    check('hidden: no reads while the page is out of view', w.calls.length === before, `${w.calls.length - before} in 30 min`);
    w.flags.hidden = false;
    w.source.wake();
    await w.advance(0);
    check('back in view: the overdue retry goes out at once', w.calls.length === before + 1 && w.calls[before] === w.at());
    // Offline: none either; the browser's `online` goes out at once, but never twice inside the minimum gap
    w.flags.offline = true;
    await w.advance(5 * 60_000);
    const offline = w.calls.length;
    w.flags.offline = false;
    w.source.wake({ now: true });
    await w.advance(1000);
    w.source.wake({ now: true });
    await w.advance(0);
    check('back online: one read at once, a second "online" inside 3 s sends none', w.calls.length === offline + 1, `${w.calls.length - offline} read(s)`);
    // A lap about to go up asks now (past the gap), and two asking at once share one read
    await w.advance(CONFIG_MIN_GAP_MS);
    const lapAsk = w.calls.length;
    await Promise.all([w.source.read({ fresh: true }), w.source.read({ fresh: true }), w.source.read()]);
    await w.source.read({ fresh: true });
    check('a lap to post asks again now, once, then waits out the gap', w.calls.length === lapAsk + 1, `${w.calls.length - lapAsk} read(s)`);
    // The last watcher gone: no timer left
    stop();
    const idle = w.calls.length;
    await w.advance(3600_000);
    check('nothing watching: no more reads, events let go', w.calls.length === idle && w.timers.size === 0 && w.flags.watched === 0);
  }
  {
    // Out of reach, then back: the watchers hear "ok" and the retries stop
    let reachable = false;
    const w = world(() => (reachable ? ok(CONFIG_ON)() : down()));
    const seen: State[] = [];
    const stop = w.source.watch((s) => seen.push(s));
    await w.advance(20_000);
    reachable = true;
    await w.advance(30_000);
    const n = w.calls.length;
    await w.advance(3600_000);
    check('back: the next retry gets the switches and the board reads "on"', seen.length === 2 && seen[1].reach === 'ok' && boardStateOf(seen[1]) === 'on', seen.map((s) => `${s.reach}/${boardStateOf(s)}`).join(' → '));
    check('back: no more retries once it answered', w.calls.length === n, `${n} reads, then ${w.calls.length - n} in an hour`);
    // A request that later gets no answer marks it out of reach; the switches it said are kept meanwhile
    w.source.markUnreachable();
    const marked = w.source.peek();
    check('an upload with no answer: out of reach, the last switches kept', marked?.reach === 'unreachable' && marked.config.board === true && boardStateOf(marked) === 'on');
    await w.advance(6_000);
    check('…and the next retry finds it again', w.source.peek()?.reach === 'ok' && w.calls.length === n + 1);
    // Uploads that keep getting no answer while the switches do: each wait is longer, a good read doesn't reset it,
    // an answered upload does (the one marked above counts until then)
    w.source.markAnswered();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const from = w.at();
      const before = w.calls.length;
      w.source.markUnreachable();
      while (w.calls.length === before) await w.advance(500);
      waits.push((w.calls[w.calls.length - 1] - from) / 1000);
    }
    w.source.markAnswered();
    const from = w.at();
    const before = w.calls.length;
    w.source.markUnreachable();
    while (w.calls.length === before) await w.advance(500);
    check('uploads with no answer back off too: 5, 10, 20, 40, 60 s', waits.join(',') === '5,10,20,40,60', `${waits.join(', ')} s`);
    check('…and an answered upload starts the count again', (w.calls[w.calls.length - 1] - from) / 1000 === 5);
    stop();
  }
  {
    // A board the server turned off stays off: one read, no retries, kept ten minutes even when a lap asks
    const w = world(ok(CONFIG_OFF));
    const seen: State[] = [];
    const stop = w.source.watch((s) => seen.push(s));
    await w.advance(5 * 60_000);
    await w.source.read({ fresh: true });
    await w.advance(0);
    check('"board off" stays off: one read, no retries', w.calls.length === 1 && seen.length === 1 && seen[0].reach === 'ok' && boardStateOf(seen[0]) === 'off');
    stop();
  }
  {
    // An answer that is no config (an error page, the site's HTML) is no answer, not "off"
    for (const [label, answer] of [
      ['a 500', (): Answer => ({ status: 500, body: '{"ok":false}' })],
      ['an HTML page', (): Answer => ({ status: 200, body: '<!doctype html><title>LibreCorsa</title>' })],
      ['JSON without the switches', ok({ hello: 'world' })],
    ] as const) {
      const w = world(answer);
      const s = await w.source.read();
      check(`${label} reads as out of reach, not "off"`, s.reach === 'unreachable' && boardStateOf(s) === 'unreachable');
    }
    // No online side in this build: off for good, never asked
    const none = world(down, null);
    const seen: State[] = [];
    none.source.watch((s) => seen.push(s));
    await none.advance(3600_000);
    check('no online side: off at once, nothing ever sent', none.calls.length === 0 && seen.length === 1 && seen[0].reach === 'none' && boardStateOf(seen[0]) === 'off');
    check('the schedule never waits past its cap (with the spread)', configRetryDelayMs(1000, () => 1) <= CONFIG_RETRY_MAX_MS * 1.2);
  }

  // 3. Through the game's own code and the Worker's API ------------------------------------------------------------------
  const { handleApi } = await import('../../cloudflare/api/index');
  const { fakeD1, fakeR2 } = await import('../lib/fake-cloudflare');
  const lb = await import('../../src/lib/net/leaderboard');
  const bq = await import('../../src/lib/net/board-queue');
  const { getActiveTrackData } = await import('../../src/lib/track-data');
  const { F1Physics2026 } = await import('../../src/lib/f1-physics-2026');
  const { LapRecorder } = await import('../../src/lib/sim/lap-recorder');
  const { lapBoardClass, lapPhysicsVersion } = await import('../../src/lib/sim/lap-types');
  type Lap = LapRecording;

  // This browser's storage
  const kept = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
  // The clock, run on by hand where the game would wait (the server reads it too)
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;

  // The Worker on an in-memory SQLite and bucket; its config route can be made to fail, and so can uploads
  const migrations = join(__dirname, '..', '..', 'cloudflare', 'migrations');
  const schema = ['0001_lap_boards.sql', '0002_race_results.sql', '0003_usage.sql', '0004_admin_numbers.sql', '0005_lc26.sql', '0006_lap_counts.sql', '0007_lap_input.sql']
    .map((f) => readFileSync(join(migrations, f), 'utf8'))
    .join('\n');
  const workerEnv = { ONLINE_BOARD: 'on', BOARD_DB: fakeD1(schema), GHOSTS: fakeR2() } as unknown as Env;
  const net = { configDown: true, postDown: false };
  const hits = { config: 0, post: 0, rename: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/config') {
      hits.config++;
      if (net.configDown) throw new TypeError('fetch failed');
    }
    if (url.pathname === '/api/laps' && method === 'POST') {
      if (net.postDown) throw new TypeError('fetch failed');
      hits.post++;
    }
    if (url.pathname === '/api/drivers/rename') hits.rename++;
    return handleApi(new Request(url, { method, headers: init?.headers, body: init?.body }), workerEnv, url);
  }) as typeof fetch;
  const onBoard = async (lap: Lap): Promise<number> => {
    // The board narrowed to the lap's kind: a driver's entry on the open board is their fastest of any kind
    const c = lap.conditions!;
    const q = new URLSearchParams({ track: lap.trackId, vehicle: lap.vehicle, physics: String(c.physicsVersion), limit: '50', assists: c.assists, realism: c.realism, surface: c.surface });
    const url = new URL(`https://librecorsa.test/api/laps?${q.toString()}`);
    const res = await handleApi(new Request(url), workerEnv, url);
    const body = (await res.json()) as { laps?: { lapTimeMs: number }[] };
    return (body.laps ?? []).filter((l) => l.lapTimeMs === lap.lapTimeMs).length;
  };

  // A real lap: the LC26 on autopilot round RISE Motordrome, recorded as the game records it (the second, a flying one)
  const track = getActiveTrackData();
  const car = new F1Physics2026(track);
  car.aiAutopilot = true;
  const recorder = new LapRecorder({ trackLengthM: track.totalLengthM, turns: [], trackId: 'rwanda_official_short', vehicle: 'lc26', driverName: 'Retry Test', driverCode: 'RTT' });
  let lap: Lap | null = null;
  for (let f = 0, laps = 0; f < 60 * 400 && !lap; f++) {
    const t = car.step(1 / 60, {});
    const done = recorder.update({
      telemetry: t,
      position: car.worldPosition,
      quaternion: car.worldQuaternion,
      conditions: { assists: 'pro', compound: 'medium', surface: 'dry', realism: 'full', physicsVersion: lapPhysicsVersion('lc26', 'rwanda_official_short'), autopilot: false },
    });
    if (done && ++laps === 2) lap = done.recording;
  }
  if (!lap?.conditions) throw new Error('No lap completed');
  const driver = { name: 'Retry Test', code: 'RTT' };
  const flushOpts = (loadBest: (t: string, v: string, b: string) => Lap | null = () => null, autoUpload = true) => ({
    driver: () => driver,
    autoUpload: () => autoUpload,
    loadBest: async (t: string, v: string, b: string) => loadBest(t, v, b),
  });
  /** The same lap on another board (another assist level, realism or surface), so each case starts clean */
  let bumps = 0;
  const onAnother = (assists: 'pro' | 'semi_pro' | 'assisted', realism: 'casual' | 'standard' | 'full', surface: 'dry' | 'wet' = 'dry'): Lap => ({
    ...lap!,
    conditions: { ...lap!.conditions!, assists, realism, surface },
    recordedAt: lap!.recordedAt + ++bumps,
  });

  {
    // The issue: the first read at start fails (a slow connection, a busy PC while the circuit loads)
    const first = await readOnlineConfig();
    check('game: a failed first read is "unreachable", not "board off"', first.reach === 'unreachable' && boardStateOf(first) === 'unreachable' && hits.config === 1);
    // A lap ends a while later: the board is asked again first, and still doesn't answer
    skew += 10_000;
    const res = await bq.postLap(lap, driver, 'auto');
    const queued = lb.queuedBoardMisses();
    const status = lb.boardStatusOf(lb.lapToEntry(lap, 'local'));
    check('game: the lap asks the board again before giving up', hits.config === 2 && hits.post === 0, `${hits.config} config reads, ${hits.post} uploads`);
    check('game: the card says "Couldn\'t reach the online board, I\'ll keep trying"', res.ok === false && res.unreachable === true && res.error === lb.BOARD_UNREACHABLE, String(res.error));
    check('game: the lap waits in the failed-upload memory', queued.length === 1 && queued[0].retry === 'auto' && queued[0].lapTimeMs === lap.lapTimeMs && queued[0].board === lapBoardClass(lap.conditions));
    check('game: Your best laps says it isn\'t on the board, and why', status !== null && !status.posted && status.error === lb.BOARD_UNREACHABLE);
    // A rename now would leave the old name's laps where they are: refused while out of reach, nothing sent
    skew += 4_000;
    const renamed = await lb.renameOnBoard('Retry Test', 'Someone Else', 'SOM');
    check('game: no rename while the board is out of reach', !renamed.ok && hits.rename === 0, String(renamed.error));

    // The board answers again: the waiting lap goes up once, however many times the game asks
    net.configDown = false;
    skew += 4_000;
    const back = await readOnlineConfig({ fresh: true });
    const sent = await Promise.all([bq.flushQueuedLaps(flushOpts()), bq.flushQueuedLaps(flushOpts())]);
    const again = await bq.flushQueuedLaps(flushOpts());
    const key = lb.boardKeyOf(lap)!;
    check('game: back, the board reads "on"', back.reach === 'ok' && boardStateOf(back) === 'on');
    check('game: the waiting lap goes up exactly once', sent[0] === 1 && sent[1] === 1 && again === 0 && hits.post === 1 && (await onBoard(lap)) === 1, `${hits.post} upload(s)`);
    check('game: it is remembered as on the board, the miss forgotten', lb.loadBoardBest(key) === lap.lapTimeMs && lb.queuedBoardMisses().length === 0 && lb.boardStatusOf(lb.lapToEntry(lap, 'local'))?.posted === true);
  }
  {
    // After a reload the held recording is gone: a waiting lap that is its board's saved best still goes up; one that
    // isn't is left for Your best laps (Retry), never sent as some other lap
    const best = onAnother('semi_pro', 'full');
    const gone = onAnother('assisted', 'full');
    // The connection drops mid-session: the switches read earlier are still kept, the uploads get no answer
    net.configDown = true;
    net.postDown = true;
    skew += 4_000;
    await bq.postLap(best, driver, 'auto');
    skew += 4_000;
    await bq.postLap(gone, driver, 'auto');
    check('reload: both laps wait', lb.queuedBoardMisses().length === 2, `${lb.queuedBoardMisses().length} waiting`);
    bq.resetLapQueueForTests();
    net.configDown = false;
    net.postDown = false;
    skew += 4_000;
    await readOnlineConfig({ fresh: true });
    const posts = hits.post;
    const sent = await bq.flushQueuedLaps(flushOpts((_t, _v, b) => (b === lapBoardClass(best.conditions!) ? best : null)));
    const left = lb.boardStatusOf(lb.lapToEntry(gone, 'local'));
    check('reload: the saved best that was waiting goes up', sent === 1 && hits.post === posts + 1 && (await onBoard(best)) === 1);
    check('reload: a waiting lap with no copy left stops waiting, with Retry', lb.queuedBoardMisses().length === 0 && left !== null && !left.posted && left.error === lb.BOARD_UNREACHABLE_GAVE_UP);
  }
  {
    // The board answered at start, then an upload gets no answer: out of reach, the lap waits, and goes up on the
    // next answer; a lap that never gets through stops being sent after its tries
    const dropped = onAnother('semi_pro', 'standard');
    const stubborn = onAnother('assisted', 'standard');
    net.postDown = true;
    skew += 4_000;
    const res = await bq.postLap(dropped, driver, 'hand');
    check('an upload with no answer: the lap waits, the board reads out of reach', res.unreachable === true && lb.queuedBoardMisses().length === 1 && (await readOnlineConfig()).reach === 'unreachable');
    net.postDown = false;
    skew += 6_000;
    await readOnlineConfig({ fresh: true });
    const posts = hits.post;
    await bq.flushQueuedLaps(flushOpts(() => null, false));
    check('a lap sent by hand goes up even with automatic posting off', hits.post === posts + 1 && lb.queuedBoardMisses().length === 0);

    net.postDown = true;
    skew += 4_000;
    await bq.postLap(stubborn, driver, 'auto');
    let attempts = 0;
    const counted = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') attempts++;
      return counted(input, init);
    }) as typeof fetch;
    // Automatic posting turned off since: a lap it queued waits
    skew += 4_000;
    await bq.flushQueuedLaps(flushOpts(() => null, false));
    check('a lap posting queued by itself waits while posting is off', attempts === 0 && lb.queuedBoardMisses().length === 1);
    for (let i = 0; i < bq.FLUSH_MAX_TRIES + 2; i++) {
      skew += 4_000;
      await bq.flushQueuedLaps(flushOpts());
    }
    const stuck = lb.boardStatusOf(lb.lapToEntry(stubborn, 'local'));
    check(`a lap that never gets through: sent ${bq.FLUSH_MAX_TRIES} more times, then left with Retry`, attempts === bq.FLUSH_MAX_TRIES && lb.queuedBoardMisses().length === 0 && stuck !== null && !stuck.posted && stuck.error === lb.BOARD_UNREACHABLE_GAVE_UP, `${attempts} upload(s)`);
    globalThis.fetch = counted;
    net.postDown = false;
  }
  {
    // A lap left waiting from before a physics update (an older version's board is read only now): the game doesn't
    // send it again, it stops waiting with the reason, and the board would turn it down too
    const { PHYSICS_VERSION, PHYSICS_VERSIONS, boardPhysicsVersion } = await import('../../src/lib/sim/lap-types');
    const before = onAnother('pro', 'standard', 'wet');
    const stale: Lap = { ...before, conditions: { ...before.conditions!, physicsVersion: boardPhysicsVersion(PHYSICS_VERSIONS[0].physics, 'lc26') } };
    lb.saveBoardMiss(stale, lb.BOARD_UNREACHABLE, 'auto');
    check('older physics: the lap from before the update is waiting', lb.queuedBoardMisses().length === 1);
    skew += 4_000;
    await readOnlineConfig({ fresh: true });
    const posts = hits.post;
    await bq.flushQueuedLaps(flushOpts(() => stale));
    check('older physics: not sent, and it stops waiting', hits.post === posts && lb.queuedBoardMisses().length === 0, `${hits.post - posts} upload(s)`);
    const direct = await lb.submitLap({ ...stale, driverName: driver.name, driverCode: driver.code });
    check('older physics: the game says why', !direct.ok && direct.error === lb.OLDER_PHYSICS_LAP && hits.post === posts, String(direct.error));
    check('older physics: Your best laps offers no Post for it', lb.boardStatusOf(lb.lapToEntry(stale, 'local')) === null);

    // The same for a lap left waiting from before its circuit's boards started again (src/lib/circuit-board-resets.ts)
    const { CIRCUIT_BOARD_RESETS } = await import('../../src/lib/circuit-board-resets');
    const resets = CIRCUIT_BOARD_RESETS as Record<string, { physics: number; oldBoard: string; why: string }[]>;
    const waiting = onAnother('semi_pro', 'casual', 'wet');
    lb.saveBoardMiss(waiting, lb.BOARD_UNREACHABLE, 'auto');
    resets[waiting.trackId] = [{ physics: PHYSICS_VERSION, oldBoard: 'Old kerbs', why: 'a check' }];
    try {
      skew += 4_000;
      await readOnlineConfig({ fresh: true });
      const before = hits.post;
      await bq.flushQueuedLaps(flushOpts(() => waiting));
      const why = await lb.submitLap({ ...waiting, driverName: driver.name, driverCode: driver.code });
      check(
        'circuit restart: a lap from before it is not sent, stops waiting, and says why',
        hits.post === before && lb.queuedBoardMisses().length === 0 && !why.ok && why.error === lb.OLDER_PHYSICS_LAP && lb.boardStatusOf(lb.lapToEntry(waiting, 'local')) === null,
        `${hits.post - before} upload(s), ${why.error}`
      );
    } finally {
      delete resets[waiting.trackId];
    }
  }
  {
    // The server turns the board off: off, not out of reach; nothing is uploaded or queued
    (workerEnv as unknown as { ONLINE_BOARD: string }).ONLINE_BOARD = 'off';
    skew += 11 * 60_000;
    const off = await readOnlineConfig();
    const posts = hits.post;
    const res = await bq.postLap(onAnother('pro', 'casual'), driver, 'auto');
    check('"board off": read as off, the lap neither sent nor queued', off.reach === 'ok' && boardStateOf(off) === 'off' && !res.ok && !res.unreachable && hits.post === posts && lb.queuedBoardMisses().length === 0, String(res.error));
  }

  Date.now = realNow;
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll board retry checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
