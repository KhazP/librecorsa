/**
 * Headless checks of the anonymous usage counter (cloudflare/api/usage.ts on an in-memory SQLite): every field is
 * checked, the minutes are capped, reports add up per day, circuit, car, mode and country, and the switch turns it off.
 *
 *   npx tsx scripts/verify-usage.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi, onlineConfig } from '../cloudflare/api/index';
import { recordUsage, requestCountry, utcDay, type UsageDeps } from '../cloudflare/api/usage';
import type { Env, RateLimit } from '../cloudflare/api/types';
import { parseOnlineConfig } from '../src/lib/net/online-config';
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
    const env = { ONLINE_USAGE: 'on', BOARD_DB: db } as unknown as Env;
    const post = (e: Env, body: unknown = good, ip?: string) => {
      const request = report(body, 'FR', ip);
      return handleApi(request, e, new URL(request.url));
    };
    const res = await post(env);
    check('api: POST /api/usage counts, never cached', res.status === 200 && res.headers.get('Cache-Control') === 'no-store');
    check('api: the request keeps its country through the API', (await rows()).some((r) => r.country === 'FR'));
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

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll usage checks passed.');
}

void main();
