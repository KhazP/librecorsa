/**
 * Headless checks of the owner's numbers and what guards them (cloudflare/api/admin.ts and index.ts, on an in-memory
 * SQLite, through the API as the Worker serves it):
 *   - the admin routes answer exactly as an unknown path does, before the limit and past it, to every address; the
 *     limit counts a right key too, and a fault while reading is the same "Not found"; nothing of the key is logged
 *   - lap uploads and name changes are turned away by their limit before the database is written to, and a name
 *     change sent without a length is still measured
 *   - a race entrant's name that the boards would refuse races as "Driver"
 *   - the numbers: countries past the top list, laps per day (and none before migration 0006), circuits the game no
 *     longer has, builds per day with the day each was first seen, names that came back, board times by class, races
 *     per day with their grids
 *   - which builds a day ran on: a deploy day splits between the build before and the new one and none of it is behind;
 *     a build counts as replaced only on the days after a newer one was first seen
 *   - the page: not in the sitemap or robots.txt, not indexed, and a title that says nothing about it
 *
 *   npx tsx scripts/verify/verify-admin.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bearerKey, handleApi } from '../../cloudflare/api/index';
import { adminKeyMatches, adminStats, CIRCUIT_IDS, type AdminStats } from '../../cloudflare/api/admin';
import { RaceServer } from '../../cloudflare/api/race';
import type { D1Database, Env, RateLimit } from '../../cloudflare/api/types';
import { buildDays } from '../../src/app/admin/build-days';
import { raceSlot } from '../../src/lib/net/race-schedule';
import { PROTOCOL_VERSION } from '../../src/lib/net/wire';
import { FakeSocket, fakeD1, fakeR2, fakeState } from '../lib/fake-cloudflare';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};

const migrations = join(__dirname, '..', '..', 'cloudflare', 'migrations');
const sql = (...files: string[]) => files.map((f) => readFileSync(join(migrations, f), 'utf8')).join('\n');
const FULL = sql('0001_lap_boards.sql', '0002_race_results.sql', '0003_usage.sql', '0004_admin_numbers.sql', '0005_lc26.sql', '0006_lap_counts.sql', '0007_lap_input.sql');

const KEY = 'a-test-key-not-a-real-one';
const DAY_MS = 86_400_000;
// Saturday 14 November 2026, midday UTC: a 7-day range is 8 to 14 November
const NOW = Date.UTC(2026, 10, 14, 12);

/** A rate limit as the binding behaves: `n` calls per key, then refusals */
function limiter(n: number): RateLimit & { calls: number } {
  const seen = new Map<string, number>();
  const out = {
    calls: 0,
    limit: async ({ key }: { key: string }) => {
      out.calls++;
      const c = (seen.get(key) ?? 0) + 1;
      seen.set(key, c);
      return { success: c <= n };
    },
  };
  return out;
}

/** Everything a caller can see of an answer */
async function seen(res: Response): Promise<string> {
  const headers = [...res.headers].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`);
  return `${res.status}\n${headers.join('\n')}\n${await res.text()}`;
}

function call(env: Env, path: string, o: { ip?: string; key?: string; method?: string; headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
  const url = new URL(`https://librecorsa.org${path}`);
  const headers: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? '10.0.0.1', ...o.headers };
  if (o.key !== undefined) headers.Authorization = `Bearer ${o.key}`;
  return handleApi(new Request(url, { method: o.method ?? 'GET', headers, body: o.body, ...(o.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit), env, url);
}

async function main(): Promise<void> {
  // 1. The admin routes answer as an unknown path, and the limit counts every try ----------------------------------------
  {
    const db = fakeD1(FULL);
    const limit = limiter(3);
    const env = { BOARD_DB: db, ADMIN_KEY: KEY, ADMIN_LIMIT: limit } as unknown as Env;

    const wrong: string[] = [];
    const unknown: string[] = [];
    for (let i = 0; i < 4; i++) wrong.push(await seen(await call(env, '/api/admin/stats', { ip: '10.1.1.1', key: 'guess' })));
    for (let i = 0; i < 4; i++) unknown.push(await seen(await call(env, '/api/nothing-here', { ip: '10.2.2.2' })));
    check('admin: a wrong key is a 404 in every detail an unknown path is', wrong.slice(0, 3).every((w) => w === unknown[0]) && wrong[0].startsWith('404'), wrong[0].split('\n')[0]);
    check('admin: past the limit both are the same 429', wrong[3] === unknown[3] && wrong[3].startsWith('429'), wrong[3].split('\n')[0]);
    check('admin: the 429 is never cached', /cache-control: no-store/.test(wrong[3]));
    check('admin: the right key past the limit is the same 429 (a guesser learns nothing)', (await seen(await call(env, '/api/admin/stats', { ip: '10.1.1.1', key: KEY }))) === wrong[3]);
    const fresh = await call(env, '/api/admin/stats?days=7', { ip: '10.3.3.3', key: KEY });
    check('admin: another address with the right key gets the numbers, never cached', fresh.status === 200 && fresh.headers.get('Cache-Control') === 'no-store' && ((await fresh.json()) as AdminStats).ok === true);
    const sub = await seen(await call(env, '/api/admin/whatever', { ip: '10.4.4.4', key: KEY }));
    const post = await seen(await call(env, '/api/admin/stats', { ip: '10.5.5.5', key: KEY, method: 'POST' }));
    const none = await seen(await call(env, '/api/admin', { ip: '10.6.6.6' }));
    check('admin: an unknown admin path, a POST and the bare prefix are the plain 404', [sub, post, none].every((s) => s === unknown[0]));

    // Without the secret, the database or the token, the limit still counts and the answer is the same
    const bare = limiter(1);
    const bareEnv = { ADMIN_LIMIT: bare } as unknown as Env;
    const a = await seen(await call(bareEnv, '/api/admin/stats', { ip: '10.7.7.7', key: KEY }));
    const b = await seen(await call(bareEnv, '/api/admin/cloudflare', { ip: '10.7.7.7', key: KEY }));
    check('admin: with no secret or database set, still limited, still a plain 404 then 429', a === unknown[0] && b === unknown[3] && bare.calls === 2);

    // A fault after the right key: the same 404, and the log carries the fault, not the request
    const broken: D1Database = {
      prepare: () => {
        throw new Error('D1 is down');
      },
      batch: async () => {
        throw new Error('D1 is down');
      },
    };
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    let faulty: string;
    try {
      faulty = await seen(await call({ BOARD_DB: broken, ADMIN_KEY: KEY } as unknown as Env, '/api/admin/stats', { key: KEY }));
    } finally {
      console.error = realError;
    }
    check('admin: a fault while reading is the plain 404', faulty === unknown[0], faulty.split('\n')[0]);
    check('admin: the fault is logged without the key', logged.length === 1 && logged[0].includes('D1 is down') && !logged.join().includes(KEY), logged.join(' | '));

    check('admin: the key goes as "Authorization: Bearer"', bearerKey(new Request('https://x.test', { headers: { Authorization: `Bearer ${KEY}` } })) === KEY && bearerKey(new Request('https://x.test', { headers: { Authorization: KEY } })) === null && bearerKey(new Request('https://x.test')) === null);
    check(
      'admin: keys compare by hash, so any length is checked in full',
      (await adminKeyMatches(KEY, KEY)) && !(await adminKeyMatches(KEY.slice(0, -1), KEY)) && !(await adminKeyMatches(`${KEY}x`.repeat(50), KEY)) && !(await adminKeyMatches('', KEY)) && !(await adminKeyMatches(KEY, '')),
    );
    const preflight = await handleApi(
      new Request('https://librecorsa.org/api/admin/stats', { method: 'OPTIONS', headers: { Origin: 'https://librecorsa.org' } }),
      env,
      new URL('https://librecorsa.org/api/admin/stats'),
    );
    const otherPreflight = await handleApi(
      new Request('https://librecorsa.org/api/nothing', { method: 'OPTIONS', headers: { Origin: 'https://librecorsa.org' } }),
      env,
      new URL('https://librecorsa.org/api/nothing'),
    );
    check('admin: its preflight is any path\'s preflight', (await seen(preflight)) === (await seen(otherPreflight)) && !/x-admin-key/i.test(await seen(preflight)));
  }

  // 2. Lap uploads and name changes: their limit comes before the database ---------------------------------------------
  {
    const db = fakeD1(FULL);
    const limit = limiter(2);
    const env = { ONLINE_BOARD: 'on', BOARD_DB: db, GHOSTS: fakeR2(), BOARD_LIMIT: limit } as unknown as Env;
    const posts = async () => (await db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM lap_posts').first<{ n: number }>())?.n ?? 0;
    const lapStatuses = [];
    for (let i = 0; i < 3; i++) lapStatuses.push((await call(env, '/api/laps', { method: 'POST', ip: '10.8.8.8', body: '{}' })).status);
    check('board: the third upload in the limit is 429, and it never reached the database', lapStatuses.join() === '400,400,429' && (await posts()) === 2, `${lapStatuses.join()} with ${await posts()} counted`);
    const rename = await call(env, '/api/drivers/rename', { method: 'POST', ip: '10.8.8.8', body: '{}' });
    check('board: a name change shares that limit', rename.status === 429 && (await posts()) === 2);
    check('board: another address is not held up', (await call(env, '/api/laps', { method: 'POST', ip: '10.9.9.9', body: '{}' })).status === 400);

    const big = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ to: 'x'.repeat(6000) })));
        c.close();
      },
    });
    const chunked = await call({ ONLINE_BOARD: 'on', BOARD_DB: db, GHOSTS: fakeR2() } as unknown as Env, '/api/drivers/rename', { method: 'POST', ip: '10.10.10.10', body: big });
    check('board: a name change sent without a length is measured once read', chunked.status === 413, String(chunked.status));
  }

  // 3. A race entrant's name ---------------------------------------------------------------------------------------------
  {
    const slot = raceSlot(Math.ceil(NOW / 1_200_000) + 1, 1200);
    const server = new RaceServer(fakeState(), {} as Env, () => slot.startsMs - 10 * 60_000);
    const names: string[] = [];
    for (const [peer, name] of [['peer_a', 'Admin'], ['peer_b', 'Bea']] as const) {
      const ws = new FakeSocket();
      await server.connect(ws, peer, peer.slice(-1).repeat(16), slot, String(PROTOCOL_VERSION));
      await server.webSocketMessage(ws, JSON.stringify({ ctl: { type: 'hello', name, code: 'XXX', color: '#00FF00' }, from: peer }));
    }
    const look = (await (await server.fetch(new Request('https://librecorsa.test/api/races/waiting?peek=1'))).json()) as { names: string[] };
    names.push(...look.names);
    check('race: a name the boards refuse races as "Driver"; others as written', names.join() === 'Driver,Bea', names.join());
  }

  // 4. The numbers ---------------------------------------------------------------------------------------------------------
  {
    const db = fakeD1(FULL);
    const read = async (d: D1Database = db, query = '?days=7') => (await adminStats({ db: d, now: () => NOW }, new URL(`https://librecorsa.org/api/admin/stats${query}`))).body as AdminStats;
    const use = (day: string, track: string, country: string, sessions: number, minutes: number, laps = 0, mode = 'practice', vehicle = 'lc26') =>
      db
        .prepare('INSERT INTO usage_daily (day, track_id, vehicle, mode, country, sessions, minutes, laps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(day, track, vehicle, mode, country, sessions, minutes, laps)
        .run();
    // Sixty countries on 13 Nov (more than the top list holds), and some without one
    const codes = Array.from({ length: 60 }, (_, i) => String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)));
    for (const c of codes) await use('2026-11-13', 'spielberg', c, 2, 6, 3);
    await use('2026-11-13', 'spielberg', 'XX', 1, 2, 1);
    // Circuits the game no longer has, from old clients, and an id that never was one
    await use('2026-11-12', 'monza', 'IT', 5, 15, 4);
    await use('2026-11-13', 'monza', 'IT', 2, 4, 0);
    await use('2026-11-13', 'not_a_track', 'US', 1, 1, 0);
    // Before the range
    await use('2026-11-01', 'monza', 'IT', 50, 100, 0);

    const body = await read();
    // The sixty, Italy and the US (the rows below); 12 Nov has Italy alone
    const perDayCountries = body.perDay.map((d) => `${d.day}:${d.countries}`).join();
    check(
      'numbers: every country counted, past the top 50, "XX" left out',
      body.countries === 62 && body.byCountry.length === 50 && perDayCountries === '2026-11-12:1,2026-11-13:62',
      `${body.countries} countries, ${body.byCountry.length} listed, ${perDayCountries}`,
    );
    check('numbers: laps counted, per day and in all', body.lapsCounted && body.totals.laps === 60 * 3 + 1 + 4 && body.perDay.find((d) => d.day === '2026-11-12')?.laps === 4, `${body.totals.laps}`);
    check('numbers: groups carry their laps', body.byCircuit.find((c) => c.id === 'spielberg')?.laps === 181 && body.byCar[0]?.laps === 185);
    check('numbers: the circuit list is the game\'s', CIRCUIT_IDS.has('spielberg') && CIRCUIT_IDS.has('rwanda_official_short') && !CIRCUIT_IDS.has('monza'));
    check(
      'numbers: circuits the game no longer has, most sessions first, with the last day seen',
      body.retired.map((r) => `${r.id}:${r.sessions}:${r.lastDay}`).join() === 'monza:7:2026-11-13,not_a_track:1:2026-11-13',
      body.retired.map((r) => `${r.id}:${r.sessions}:${r.lastDay}`).join(),
    );
    check('numbers: sessions a day on them', body.retiredPerDay.map((d) => `${d.day}:${d.sessions}`).join() === '2026-11-12:5,2026-11-13:3', JSON.stringify(body.retiredPerDay));

    // Before migration 0006: no laps column, the rest answers and every lap count is 0
    const older = fakeD1(sql('0001_lap_boards.sql', '0003_usage.sql', '0004_admin_numbers.sql'));
    await older.prepare("INSERT INTO usage_daily (day, track_id, vehicle, mode, country, sessions, minutes) VALUES ('2026-11-13', 'spielberg', 'lc26', 'practice', 'DE', 3, 9)").run();
    const old = await read(older);
    check('numbers: before migration 0006 laps are not counted, the rest answers', old.ok && !old.lapsCounted && old.totals.laps === 0 && old.totals.sessions === 3 && old.perDay[0]?.laps === 0 && old.races === null && old.builds !== null);
    const oldest = await read(fakeD1(sql('0001_lap_boards.sql', '0003_usage.sql')));
    check('numbers: before migration 0004 there are no builds or extras', oldest.ok && oldest.builds === null && oldest.extras === null);

    // Builds: one seen before the range keeps its first day
    const build = (day: string, value: string, sessions: number) =>
      db.prepare("INSERT INTO usage_extra (day, name, value, sessions, minutes) VALUES (?, 'build', ?, ?, ?)").bind(day, value, sessions, sessions * 3).run();
    await build('2026-10-30', 'aaaaaaa', 3);
    await build('2026-10-30', 'eeeeeee', 297);
    await build('2026-11-13', 'aaaaaaa', 6);
    await build('2026-11-13', 'bbbbbbb', 4);
    await build('2026-10-01', 'ccccccc', 9);
    const b = (await read()).builds;
    check('builds: per day, most sessions first', b?.perDay.map((r) => `${r.day}:${r.build}:${r.sessions}`).join() === '2026-11-13:aaaaaaa:6,2026-11-13:bbbbbbb:4', JSON.stringify(b?.perDay));
    check(
      'builds: first seen over all time, for the builds in the range only',
      b?.firstSeen
        .map((r) => `${r.build}:${r.day}`)
        .sort()
        .join() === 'aaaaaaa:2026-10-30,bbbbbbb:2026-11-13',
      JSON.stringify(b?.firstSeen),
    );
    // With its share of that first day, out of the range or not, so a stray report is told from a deploy either way
    check(
      'builds: each with its sessions on its first day, of all the builds reported that day',
      b?.firstSeen
        .map((r) => `${r.build}:${r.sessions}/${r.dayTotal}`)
        .sort()
        .join() === 'aaaaaaa:3/300,bbbbbbb:4/10',
      JSON.stringify(b?.firstSeen),
    );

    // Names: one uploaded again nine days on, one only within the hour, one claimed two hours ago
    await db
      .prepare("INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES ('back', 'k', ?, ?), ('once', 'k', ?, ?), ('new', 'k', ?, ?)")
      .bind(NOW - 10 * DAY_MS, NOW - DAY_MS, NOW - 10 * DAY_MS, NOW - 10 * DAY_MS + 3_600_000, NOW - 7_200_000, NOW - 3_600_000)
      .run();
    const names = (await read()).board;
    check('drivers: came back a day or more after the claim, of those claimed a day ago', names.cameBack === 1 && names.cameBackOf === 2, `${names.cameBack} of ${names.cameBackOf}`);

    // Board times by class
    const lap = "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, 'spielberg', 'lc26', 3, '', ?, ?, ?, 'soft', ?, 'X', 'XXX', 90000, 1, 1, 1, 0, ?)";
    await db.prepare(lap).bind('l1', 'semi_pro', 'full', 'dry', 'a', NOW).run();
    await db.prepare(lap).bind('l2', 'semi_pro', 'full', 'dry', 'b', NOW).run();
    await db.prepare(lap).bind('l3', 'pro', 'full', 'wet', 'c', NOW).run();
    await db.prepare(lap).bind('l4', 'pro', 'full', 'wet', 'd', NOW - 30 * DAY_MS).run();
    const cls = (await read()).board.lapsByClass;
    check('boards: times in the range by class, most first', cls.map((c) => `${c.assists}/${c.realism}/${c.surface}:${c.n}`).join() === 'semi_pro/full/dry:2,pro/full/wet:1', JSON.stringify(cls));

    // Races: two in the range on two days, one long before
    const race = "INSERT INTO races (id, week, kind, track_id, vehicle, laps, finished_ms) VALUES (?, '2026-W46', 'open', 'dunsfold', 'lc26', 5, ?)";
    await db.prepare(race).bind('r1', NOW - DAY_MS).run();
    await db.prepare(race).bind('r2', NOW).run();
    await db.prepare(race).bind('r3', NOW - 60 * DAY_MS).run();
    const car = "INSERT INTO race_cars (race_id, position, name_key, name, code, laps, dnf, grid) VALUES (?, ?, ?, ?, 'XXX', 5, ?, ?)";
    for (const [id, p, key, name, dnf] of [['r1', 1, 'ana', 'Ana', 0], ['r1', 2, 'bo', 'Bo', 0], ['r1', 3, null, 'Driver', 1], ['r2', 1, 'ana', 'Ana', 0], ['r2', 2, null, 'Cy', 1], ['r3', 1, 'ana', 'Ana', 0]] as const) {
      await db.prepare(car).bind(id, p, key, name, dnf, p).run();
    }
    const r = (await read()).races;
    check('races: cars, finishes, proven names and how many drivers', r?.cars === 5 && r.dnf === 2 && r.proven === 3 && r.drivers === 2, JSON.stringify({ cars: r?.cars, dnf: r?.dnf, proven: r?.proven, drivers: r?.drivers }));
    check('races: the smallest and largest grid', r?.fieldMin === 2 && r.fieldMax === 3);
    check('races: per day, with cars and DNFs', r?.perDay.map((d) => `${d.day}:${d.races}/${d.cars}/${d.dnf}`).join() === '2026-11-13:1/3/1,2026-11-14:1/2/1', JSON.stringify(r?.perDay));
    check('races: cars with no name of their own are not one "Driver" in the table', r?.topDrivers.map((d) => d.name).sort().join() === 'Ana,Bo,Cy', r?.topDrivers.map((d) => d.name).join());

    // The 7, 30 and 90 day ranges all read
    const ranges = await Promise.all(['?days=7', '?days=30', '?days=90'].map((q) => read(db, q)));
    check('numbers: every range reads', ranges.map((x) => `${x.days}:${x.from}`).join() === '7:2026-11-08,30:2026-10-16,90:2026-08-17', ranges.map((x) => `${x.days}:${x.from}`).join());
    check('numbers: a longer range takes in the build first seen before the shorter one', ranges[1].builds?.perDay.some((p) => p.day === '2026-10-30') === true);
  }

  // 5. Which builds a day ran on (src/app/admin/build-days.ts) -----------------------------------------------------------
  {
    // Production's 12 to 14 Nov: 22c31fc was live until the deploys of 14 Nov (8e2edf9 at 14:09, ec04521 at 14:42,
    // c31ac20 at 15:30), and usage is counted per UTC day. Then a day after, with a stray report of a made-up build
    const use = [
      { day: '2026-11-12', build: '22c31fc', sessions: 487 },
      { day: '2026-11-12', build: '2493bd3', sessions: 48 },
      { day: '2026-11-13', build: '22c31fc', sessions: 1839 },
      { day: '2026-11-14', build: 'c31ac20', sessions: 5312 },
      { day: '2026-11-14', build: '22c31fc', sessions: 5056 },
      { day: '2026-11-14', build: 'ec04521', sessions: 609 },
      { day: '2026-11-14', build: '8e2edf9', sessions: 477 },
      { day: '2026-11-15', build: 'c31ac20', sessions: 600 },
      { day: '2026-11-15', build: '22c31fc', sessions: 100 },
      { day: '2026-11-15', build: 'ec04521', sessions: 20 },
      { day: '2026-11-15', build: 'deadbee', sessions: 1 },
      { day: '2026-11-16', build: 'c31ac20', sessions: 500 },
      { day: '2026-11-16', build: '22c31fc', sessions: 40 },
    ];
    const first = [
      { build: '2493bd3', day: '2026-11-12' },
      { build: '22c31fc', day: '2026-11-12' },
      { build: '8e2edf9', day: '2026-11-14' },
      { build: 'ec04521', day: '2026-11-14' },
      { build: 'c31ac20', day: '2026-11-14' },
      { build: 'deadbee', day: '2026-11-15' },
    ];
    const days = buildDays(use, first, ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
    const on = (day: string) => days.find((d) => d.day === day)!;
    const replacedOn = (day: string) => on(day).builds.filter((b) => b.replaced).map((b) => b.build).join();
    check('builds: a day with no reports has nothing to split', on('2026-11-11').total === 0 && on('2026-11-11').builds.length === 0);
    check('builds: with no deploy that day, every session is on a current build', on('2026-11-13').replaced === 0 && on('2026-11-13').total === 1839);
    check(
      'builds: a deploy day splits between the build before and the new ones, and none of it is behind',
      on('2026-11-14').replaced === 0 && on('2026-11-14').fresh.join() === 'c31ac20,ec04521,8e2edf9' && on('2026-11-14').builds.find((b) => b.build === '22c31fc')?.firstSeen === '2026-11-12',
      JSON.stringify(on('2026-11-14')),
    );
    check('builds: the day after a deploy, the build it replaced is behind', replacedOn('2026-11-15') === '22c31fc' && on('2026-11-15').replaced === 100, replacedOn('2026-11-15'));
    check('builds: builds first seen on the same day never count as replacing each other', !on('2026-11-15').builds.find((b) => b.build === 'ec04521')?.replaced);
    check('builds: a stray report under 1% of its day is not a deploy', replacedOn('2026-11-16') === '22c31fc' && !on('2026-11-16').builds.find((b) => b.build === 'c31ac20')?.replaced, replacedOn('2026-11-16'));

    // A stray build first seen before the range (1 session of 1001 on 5 Nov) that reports again in it: the API gives its
    // first day's share, so it is no deploy there either, and the current build is not "replaced" by it. The 30-day view,
    // which sees 5 Nov itself, says the same
    const strayFirst = [
      { build: 'aaaaaaa', day: '2026-11-02', sessions: 900, dayTotal: 900 },
      { build: 'fffffff', day: '2026-11-05', sessions: 1, dayTotal: 1001 },
    ];
    const strayInRange = [
      { day: '2026-11-12', build: 'aaaaaaa', sessions: 800 },
      { day: '2026-11-12', build: 'fffffff', sessions: 1 },
      { day: '2026-11-13', build: 'aaaaaaa', sessions: 700 },
    ];
    const week = buildDays(strayInRange, strayFirst, ['2026-11-12', '2026-11-13']);
    const month = buildDays(
      [{ day: '2026-11-02', build: 'aaaaaaa', sessions: 900 }, { day: '2026-11-05', build: 'aaaaaaa', sessions: 1000 }, { day: '2026-11-05', build: 'fffffff', sessions: 1 }, ...strayInRange],
      strayFirst,
      ['2026-11-02', '2026-11-05', '2026-11-12', '2026-11-13'],
    );
    const replacedIn = (v: typeof week) => v.filter((d) => d.day >= '2026-11-12').map((d) => `${d.day}:${d.replaced}`).join();
    check('builds: a stray first seen before the range is not a deploy either', replacedIn(week) === '2026-11-12:0,2026-11-13:0', replacedIn(week));
    check('builds: and the 7- and 30-day views agree on it', replacedIn(week) === replacedIn(month), `${replacedIn(week)} | ${replacedIn(month)}`);
    // A real deploy first seen before the range still is one: what was live before it is behind in the range
    const deployFirst = [...strayFirst, { build: 'bbbbbbb', day: '2026-11-08', sessions: 400, dayTotal: 1400 }];
    const deployUse = [...strayInRange, { day: '2026-11-12', build: 'bbbbbbb', sessions: 900 }];
    const withDeploy = buildDays(deployUse, deployFirst, ['2026-11-12', '2026-11-13']);
    check('builds: a deploy first seen before the range still counts', withDeploy[0].builds.filter((x) => x.replaced).map((x) => x.build).join() === 'aaaaaaa,fffffff', JSON.stringify(withDeploy[0].builds));
    const dashboard = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'admin', 'Dashboard.tsx'), 'utf8');
    check('builds: the page no longer calls a deploy day\'s build older', !/on an older build|older build than|newest build/i.test(dashboard));
  }

  // 6. The page --------------------------------------------------------------------------------------------------------------
  {
    const { default: sitemap } = await import('../../src/app/sitemap');
    const { default: robots } = await import('../../src/app/robots');
    check('page: not in the sitemap', sitemap().every((e) => !/admin/.test(e.url)), sitemap().map((e) => e.url).join(' '));
    check('page: not named in robots.txt either (that would publish it)', !JSON.stringify(robots()).includes('admin'));
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'admin', 'page.tsx'), 'utf8');
    const meta = /export const metadata[^=]*=\s*(\{[\s\S]*?\n\});/.exec(source)?.[1] ?? '';
    check('page: noindex, nofollow, Googlebot included', /index: false/.test(meta) && /follow: false/.test(meta) && /googleBot: \{ index: false, follow: false/.test(meta), meta.replace(/\s+/g, ' '));
    check('page: the title says nothing about the page', /title: \{ absolute: "LibreCorsa" \}/.test(meta) && !/numbers|admin|stats/i.test(meta.replace(/robots[\s\S]*/, '')));
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll admin checks passed.');
}

void main();
