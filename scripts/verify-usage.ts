/**
 * Headless checks of the anonymous usage counter (cloudflare/api/usage.ts on an in-memory SQLite): every field is
 * checked, the minutes are capped, reports add up per day, circuit, car, mode and country, and the switch turns it off.
 * The owner's numbers (cloudflare/api/admin.ts) answer only to the admin key, and as an unknown path otherwise.
 *
 *   npx tsx scripts/verify-usage.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi, onlineConfig } from '../cloudflare/api/index';
import { recordUsage, requestCountry, utcDay, type UsageDeps } from '../cloudflare/api/usage';
import { adminKeyMatches, adminStats, statsDays, type AdminStats } from '../cloudflare/api/admin';
import type { Env, RateLimit } from '../cloudflare/api/types';
import { parseOnlineConfig } from '../src/lib/net/online-config';
import { isUsageMode, sendUsage, USAGE_MODES, UsageClock, type UsageLine } from '../src/lib/net/usage';
import { onChallenge, usageModeOf } from '../src/lib/net/use-usage-counter';
import { challengeAt } from '../src/lib/net/weekly-challenge';
import { fakeD1 } from './lib/fake-cloudflare';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};

const migrations = join(__dirname, '..', 'cloudflare', 'migrations');
const schema = ['0001_lap_boards.sql', '0003_usage.sql'].map((f) => readFileSync(join(migrations, f), 'utf8')).join('\n');

const DAY_MS = 24 * 3_600_000;
// Wednesday 11 November 2026, midday UTC
const NOON = Date.UTC(2026, 10, 11, 12);

/** A request as Cloudflare hands it over, with the country it puts on it */
function report(body: unknown, country?: string, ip = '10.0.0.1'): Request {
  const request = new Request('https://librecorsa.org/api/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (country !== undefined) Object.defineProperty(request, 'cf', { value: { country } });
  return request;
}

type Row = { day: string; track_id: string; vehicle: string; mode: string; country: string; sessions: number; minutes: number };

async function main() {
  // 1. The counter on its own ------------------------------------------------------------------------------------------
  const db = fakeD1(schema);
  let nowMs = NOON;
  const deps: UsageDeps = { db, now: () => nowMs };
  const rows = async () => (await db.prepare('SELECT * FROM usage_daily ORDER BY day, track_id, vehicle, mode, country').all<Row>()).results;
  const good = { trackId: 'rwanda_official_short', vehicle: 'vf26', mode: 'practice', minutes: 12.34 };

  {
    const res = await recordUsage(deps, report(good, 'RW'));
    const [row] = await rows();
    check('a report is counted', res.status === 200 && row?.sessions === 1, JSON.stringify(row));
    check('its minutes to a tenth, its day, its country', row?.minutes === 12.3 && row.day === '2026-11-11' && row.country === 'RW');
  }
  {
    await recordUsage(deps, report({ ...good, minutes: 5 }, 'RW'));
    const [row] = await rows();
    check('a second report on the same day adds to the same row', row?.sessions === 2 && Math.abs(row.minutes - 17.3) < 1e-9, JSON.stringify(row));
  }
  {
    await recordUsage(deps, report({ ...good, mode: 'time_trial' }, 'RW'));
    await recordUsage(deps, report(good, 'DE'));
    await recordUsage(deps, report({ ...good, vehicle: 'amg-gt3' }, 'RW'));
    nowMs += DAY_MS;
    await recordUsage(deps, report(good, 'RW'));
    const all = await rows();
    check('another mode, country, car or day is a row of its own', all.length === 5, all.map((r) => `${r.day}/${r.vehicle}/${r.mode}/${r.country}`).join(' '));
    check('the next day starts its own totals', all.some((r) => r.day === '2026-11-12' && r.sessions === 1));
  }
  {
    nowMs = NOON + 2 * DAY_MS;
    const res = await recordUsage(deps, report({ ...good, minutes: 10_000 }));
    const row = (await rows()).find((r) => r.day === '2026-11-13');
    check('minutes are capped at 240', res.status === 200 && row?.minutes === 240, JSON.stringify(row));
    check('no country on the request: XX', row?.country === 'XX');
    check('a country that is not two letters: XX', requestCountry(report(good, 'nowhere')) === 'XX' && requestCountry(report(good, 'T1')) === 'XX');
    check('the day is the UTC day', utcDay(Date.UTC(2026, 10, 11, 23, 59)) === '2026-11-11' && utcDay(Date.UTC(2026, 10, 12, 0, 0)) === '2026-11-12');
  }
  {
    const before = (await rows()).length;
    const refused: [string, unknown][] = [
      ['not JSON', 'circuit=rwanda'],
      ['not an object', '42'],
      ['a circuit id with a slash', { ...good, trackId: '../etc' }],
      ['a circuit id too long', { ...good, trackId: 'x'.repeat(65) }],
      ['no circuit', { ...good, trackId: undefined }],
      ['an unknown car', { ...good, vehicle: 'sf26' }],
      ['an unknown mode', { ...good, mode: 'drift' }],
      ['minutes as text', { ...good, minutes: '12' }],
      ['minutes not a number', { ...good, minutes: null }],
      ['under half a minute', { ...good, minutes: 0.4 }],
      ['negative minutes', { ...good, minutes: -5 }],
      ['a body over 1 KB', { ...good, pad: 'x'.repeat(2000) }],
    ];
    for (const [what, body] of refused) {
      const res = await recordUsage(deps, report(body));
      check(`refused: ${what}`, res.status === 400 || res.status === 413, String(res.status));
    }
    check('nothing refused was counted', (await rows()).length === before);
    const stored = JSON.stringify(await rows());
    check('no address is stored', !stored.includes('10.0.0.1'));
  }

  // 2. Through the API: the switch, the limit, the config ------------------------------------------------------------
  {
    // A database of its own: the API counts on the real clock, and section 3 totals the shared one on this test's clock
    const apiDb = fakeD1(schema);
    const env = { ONLINE_USAGE: 'on', BOARD_DB: apiDb } as unknown as Env;
    const post = (e: Env, body: unknown = good, ip?: string) => {
      const request = report(body, 'FR', ip);
      return handleApi(request, e, new URL(request.url));
    };
    const res = await post(env);
    check('api: POST /api/usage counts, never cached', res.status === 200 && res.headers.get('Cache-Control') === 'no-store');
    const apiRows = (await apiDb.prepare('SELECT * FROM usage_daily').all<Row>()).results;
    check('api: the request keeps its country through the API', apiRows.some((r) => r.country === 'FR'));
    check('api: switched off it answers 404', (await post({ ...env, ONLINE_USAGE: 'off' })).status === 404);
    check('api: no database: 404', (await post({ ONLINE_USAGE: 'on' } as unknown as Env)).status === 404);
    check('api: a bad report is 400', (await post(env, { ...good, mode: 'drift' })).status === 400);
    check('api: GET is not a route', (await handleApi(new Request('https://librecorsa.org/api/usage'), env, new URL('https://librecorsa.org/api/usage'))).status === 404);

    // The rate limit is keyed by address (the binding counts; only the key is checked here)
    const seen: string[] = [];
    const limit: RateLimit = { limit: async ({ key }) => (seen.push(key), { success: seen.filter((k) => k === key).length <= 2 }) };
    const limited = { ...env, USAGE_LIMIT: limit } as Env;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(limited, good, '10.1.1.1')).status);
    statuses.push((await post(limited, good, '10.2.2.2')).status);
    check('api: the third report in the limit from one address is 429', statuses.join() === '200,200,429,200', statuses.join());

    check('config: usage on with the switch and the database', onlineConfig(env).usage && !onlineConfig({ ...env, ONLINE_USAGE: 'off' }).usage && !onlineConfig({ ONLINE_USAGE: 'on' } as Env).usage);
    check('config: usage needs no lap board switch', onlineConfig({ ...env, ONLINE_BOARD: 'off' }).usage);
    check('config from the network: usage only when true', parseOnlineConfig({ usage: true }).usage && !parseOnlineConfig({ usage: 'yes' }).usage && !parseOnlineConfig(null).usage);
    const served = await handleApi(new Request('https://librecorsa.org/api/config'), env, new URL('https://librecorsa.org/api/config'));
    check('config: GET /api/config says usage', ((await served.json()) as { usage?: boolean }).usage === true);
  }

  // 3. The owner's numbers -------------------------------------------------------------------------------------------
  {
    const KEY = 'a-test-key-not-a-real-one';
    const env = { ONLINE_USAGE: 'on', BOARD_DB: db, ADMIN_KEY: KEY } as unknown as Env;
    const stats = (e: Env, key?: string, query = '') => {
      const url = new URL(`https://librecorsa.org/api/admin/stats${query}`);
      return handleApi(new Request(url, { headers: key === undefined ? {} : { 'X-Admin-Key': key } }), e, url);
    };
    const notFound = await (await handleApi(new Request('https://librecorsa.org/api/nothing'), env, new URL('https://librecorsa.org/api/nothing'))).text();
    const hidden = async (what: string, res: Promise<Response>) => {
      const r = await res;
      check(`admin: ${what}: 404 as any unknown path`, r.status === 404 && (await r.text()) === notFound, String(r.status));
    };
    await hidden('no key', stats(env));
    await hidden('a wrong key', stats(env, 'a-test-key-not-a-real-onE'));
    await hidden('a key one character short', stats(env, KEY.slice(0, -1)));
    await hidden('no secret set', stats({ ...env, ADMIN_KEY: undefined }, KEY));
    await hidden('an empty secret and an empty key', stats({ ...env, ADMIN_KEY: '' }, ''));
    await hidden('the key in the URL instead of the header', stats(env, undefined, `?key=${KEY}`));
    check('admin: equal keys match, others do not', (await adminKeyMatches(KEY, KEY)) && !(await adminKeyMatches(`${KEY} `, KEY)) && !(await adminKeyMatches(null, KEY)));
    check('admin: days 1 to 90, else 30', statsDays('7') === 7 && statsDays('90') === 90 && statsDays('91') === 30 && statsDays('0') === 30 && statsDays('2.5') === 30 && statsDays(null) === 30);

    // A preflight from a development page may send the key
    const preflight = await handleApi(
      new Request('https://librecorsa.org/api/admin/stats', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:3315' } }),
      { ...env, DEV_ORIGINS: 'http://127.0.0.1:3315' } as Env,
      new URL('https://librecorsa.org/api/admin/stats'),
    );
    check('admin: the preflight allows the X-Admin-Key header', preflight.status === 204 && /X-Admin-Key/.test(preflight.headers.get('Access-Control-Allow-Headers') ?? ''));

    // Some board rows to count
    await db.prepare("INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES ('a', 'x', 0, ?), ('b', 'y', 0, 0)").bind(NOON).run();
    const lap = "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, 'vf26', 3, '', 'pro', 'full', 'dry', 'soft', 'a', 'A', 'AAA', 90000, 30000, 30000, 30000, 0, ?)";
    await db.prepare(lap).bind('l1', 'rwanda_official_short', NOON).run();
    await db.prepare(lap).bind('l2', 'rwanda_official', NOON - 200 * DAY_MS).run();

    // Through the API on the real clock; the numbers themselves on this test's clock
    const res = await stats(env, KEY, '?days=7');
    const served = (await res.json()) as AdminStats;
    check('admin: the right key gets the numbers, never cached', res.status === 200 && served.ok && served.days === 7 && Array.isArray(served.perDay) && res.headers.get('Cache-Control') === 'no-store');
    nowMs = NOON + 2 * DAY_MS;
    const read = async (query: string) => (await adminStats({ db, now: () => nowMs }, new URL(`https://librecorsa.org/api/admin/stats${query}`))).body as AdminStats;
    const body = await read('?days=7');
    check('admin: the range is the last 7 UTC days', body.days === 7 && body.from === '2026-11-07' && body.to === '2026-11-13', `${body.from}..${body.to}`);
    const all = await rows();
    const sessions = all.reduce((n, r) => n + r.sessions, 0);
    const minutes = all.reduce((n, r) => n + r.minutes, 0);
    check('admin: the totals are every session and minute in the range', body.totals.sessions === sessions && Math.abs(body.totals.minutes - minutes) < 0.05, JSON.stringify(body.totals));
    check('admin: one row per day, in order', body.perDay.map((d) => d.day).join() === '2026-11-11,2026-11-12,2026-11-13' && body.perDay.reduce((n, d) => n + d.sessions, 0) === sessions);
    check('admin: by circuit, car, mode and country, most minutes first', body.byCircuit[0]?.id === 'rwanda_official_short' && body.byCar.some((c) => c.id === 'amg-gt3') && body.byMode.map((m) => m.id).includes('time_trial') && body.byCountry.map((c) => c.id).includes('XX') && body.byCountry.every((c, i, a) => i === 0 || a[i - 1].minutes >= c.minutes));
    check('admin: board counts (names, active names, laps, laps in range)', body.board.drivers === 2 && body.board.driversActive === 1 && body.board.laps === 2 && body.board.lapsInRange === 1, JSON.stringify({ ...body.board, boards: undefined }));
    check('admin: laps per board', body.board.boards.length === 2 && body.board.boards.every((b) => b.laps === 1 && b.vehicle === 'vf26' && b.physics === 3));
    check('admin: no race results table: races is null', body.races === null);
    const old = await read('?days=1');
    check('admin: a shorter range leaves the older days out', old.perDay.length === 1 && old.perDay[0].day === '2026-11-13');

    // With the race results stored (as 0002_race_results.sql keeps them): finished races in the range, by kind
    await db.prepare('CREATE TABLE races (id TEXT PRIMARY KEY, week TEXT, kind TEXT, track_id TEXT, vehicle TEXT, laps INTEGER, finished_ms INTEGER)').run();
    await db.prepare('CREATE TABLE race_cars (race_id TEXT, position INTEGER, name_key TEXT, name TEXT, time_s REAL, penalty_s REAL, laps INTEGER, best_lap_ms REAL, dnf INTEGER, grid INTEGER)').run();
    const race = "INSERT INTO races (id, week, kind, track_id, vehicle, laps, finished_ms) VALUES (?, '2026-W46', ?, 'rwanda_official_short', 'vf26', 5, ?)";
    await db.prepare(race).bind('r1', 'open', NOON).run();
    await db.prepare(race).bind('r2', 'room', NOON + DAY_MS).run();
    await db.prepare(race).bind('r3', 'open', NOON - 100 * DAY_MS).run();
    for (const [id, cars] of [['r1', 3], ['r2', 2], ['r3', 4]] as const) {
      for (let p = 1; p <= cars; p++) await db.prepare("INSERT INTO race_cars (race_id, position, name, laps, dnf, grid) VALUES (?, ?, 'X', 5, 0, ?)").bind(id, p, p).run();
    }
    const withRaces = await read('?days=30');
    check('admin: races in the range by kind, and their cars', withRaces.races?.open === 1 && withRaces.races.room === 1 && withRaces.races.cars === 5, JSON.stringify(withRaces.races));
  }

  // 4. The game's side: stretches, their mode, the request -----------------------------------------------------------
  {
    let t = 0;
    const sent: UsageLine[] = [];
    const clock = new UsageClock((line) => sent.push(line), () => t);
    const at = { trackId: 'rwanda_official_short', vehicle: 'vf26' as const, mode: 'practice' as const };
    const MIN = 60_000;
    clock.set(at, true);
    t += 20_000;
    clock.set(null, false);
    check('game: a stretch under 30 seconds is not sent', sent.length === 0);
    clock.set(at, true);
    t += 5 * MIN;
    clock.set(at, false);
    t += 30 * MIN;
    clock.set(at, true);
    t += 2 * MIN;
    clock.set({ ...at, vehicle: 'amg-gt3' }, true);
    check('game: a change of car ends the stretch, paused time left out', sent.length === 1 && sent[0].minutes === 7 && sent[0].vehicle === 'vf26', JSON.stringify(sent));
    t += MIN;
    clock.set({ ...at, vehicle: 'amg-gt3' }, true, 'flag');
    check('game: taking the flag ends the stretch', sent.length === 2 && sent[1].minutes === 1 && sent[1].vehicle === 'amg-gt3');
    t += 300 * MIN;
    clock.end();
    check('game: a stretch is sent with at most 240 minutes', sent.length === 3 && sent[2].minutes === 240);
    clock.end();
    check('game: ending twice sends once', sent.length === 3);
    check('game: modes', usageModeOf('practice', false, false) === 'practice' && usageModeOf('practice', true, true) === 'time_trial' && usageModeOf('ai', false, true) === 'ai_race' && usageModeOf('mp', true, false) === 'open_race' && usageModeOf('mp', false, false) === 'room_race');
    const week = challengeAt(Date.now());
    const toRules = { trackId: week.trackId, vehicle: week.vehicle, assists: week.assists, realism: week.realism, wet: false };
    check('game: practice to the week\'s rules is its time trial', onChallenge(toRules));
    check('game: not on a wet track, other assists or another circuit', !onChallenge({ ...toRules, wet: true }) && !onChallenge({ ...toRules, assists: week.assists === 'pro' ? 'assisted' : 'pro' }) && !onChallenge({ ...toRules, trackId: `${week.trackId}_x` }));
    check('game: every mode the game sends is one the server takes', USAGE_MODES.every((m) => isUsageMode(m)) && USAGE_MODES.length === 5);

    // The request: to the API, surviving the page, without cookies, a plain-text body (no preflight)
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{}'))) as typeof fetch;
    try {
      sendUsage({ ...at, minutes: 3 }, 'https://librecorsa.test/api/usage');
      sendUsage({ ...at, minutes: 3 }, null);
    } finally {
      globalThis.fetch = realFetch;
    }
    const call = calls[0];
    check('game: one request, keepalive, no cookies, a string body', calls.length === 1 && call.init.keepalive === true && call.init.credentials === 'omit' && typeof call.init.body === 'string' && JSON.parse(call.init.body).minutes === 3, JSON.stringify(call));
    check('game: nothing but circuit, car, mode and minutes', Object.keys(JSON.parse(String(call?.init.body))).sort().join() === 'minutes,mode,trackId,vehicle');
    check('game: no online side, nothing sent', calls.length === 1);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll usage checks passed.');
}

void main();
