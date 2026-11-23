/**
 * Headless checks of the boards' pages and totals (cloudflare/api/board.ts, stats.ts and usage.ts on an in-memory
 * SQLite, through the API as the Worker serves it): a board read a page at a time lists every driver once and in one
 * order; the all-cars board takes each driver's fastest lap in any car, each car on its current physics; a driver finds
 * their place and the places round it; the totals count laps and drivers as the panel and the title screen say them;
 * the answers anyone may share are kept a little while, and the rest never. The live count (cloudflare/api/presence.ts)
 * counts each tab in view once from the last minute's heartbeats, and keeps nothing else.
 *
 *   npx tsx scripts/verify-board-stats.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi, onlineConfig, SHARED_ANSWER_S } from '../cloudflare/api/index';
import { PresenceCounter } from '../cloudflare/api/presence';
import { formatCount, parseBoardPage, parsePopular, parseSiteTotals } from '../src/lib/net/board-client';
import { HEARTBEAT_MS, nextHeartbeatInMs } from '../src/lib/net/live-heartbeat';
import { towerLines } from '../src/components/hud/board-data';
import { ALL_CARS, currentPhysicsByCar, driverNameKey, listLaps, renameDriver, sha256Hex, type BoardDeps } from '../cloudflare/api/board';
import { circuitTotals, driversToDate, popularRanks, POPULAR_DAYS, POPULAR_MIN_SESSIONS, siteTotals } from '../cloudflare/api/stats';
import { CIRCUIT_IDS } from '../cloudflare/api/admin';
import { recordUsage, utcDay } from '../cloudflare/api/usage';
import { usageLapsOf, MAX_LAPS_PER_MINUTE } from '../src/lib/net/usage-modes';
import { boardPhysicsVersion, currentBoardBase, lapPhysicsVersion, PHYSICS_VERSION, PHYSICS_VERSIONS } from '../src/lib/sim/lap-types';
import { CIRCUIT_BOARD_RESETS, type CircuitBoardReset } from '../src/lib/circuit-board-resets';
import { VEHICLE_MODEL_IDS, type VehicleModelId } from '../src/types/f1';
import type { D1Database, DurableObjectNamespace, Env, RateLimit } from '../cloudflare/api/types';
import { fakeD1, fakeR2, fakeState } from './lib/fake-cloudflare';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};

const migrations = join(__dirname, '..', 'cloudflare', 'migrations');
const sql = (...files: string[]) => files.map((f) => readFileSync(join(migrations, f), 'utf8')).join('\n');
const FULL = sql('0001_lap_boards.sql', '0002_race_results.sql', '0003_usage.sql', '0004_admin_numbers.sql', '0005_lc26.sql', '0006_lap_counts.sql', '0007_lap_input.sql');

const TRACK = 'sachsenring';
const NOW = Date.UTC(2026, 10, 14, 12);
const LC26 = lapPhysicsVersion('lc26', TRACK);

type Row = { id: string; name: string; vehicle: string; lapTimeMs: number; conditions: { assists: string; physicsVersion: number } };
type ListAnswer = {
  laps: Row[];
  offset: number;
  total: number;
  physics: number[];
  current?: Record<string, number>;
  me: { rank: number; pos: number; lap: Row; aboveMs: number | null } | null;
  near?: { pos: number; laps: Row[] };
};

let seq = 0;
/** A stored lap, straight into the table: the listing is checked here, not the upload (verify-leaderboard.ts does that) */
async function lap(db: D1Database, o: { name: string; vehicle: VehicleModelId; ms: number; physics?: number; assists?: string; event?: string; track?: string; created?: number }) {
  seq++;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  await db
    .prepare(
      'INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, o.track ?? TRACK, o.vehicle, o.physics ?? lapPhysicsVersion(o.vehicle, o.track ?? TRACK), o.event ?? '', o.assists ?? 'pro', 'full', 'dry', 'soft', driverNameKey(o.name), o.name, o.name.slice(0, 3).toUpperCase(), o.ms, o.ms / 3, o.ms / 3, o.ms / 3, NOW, o.created ?? NOW + seq)
    .run();
  return id;
}

async function main(): Promise<void> {
  const db = fakeD1(FULL);
  const deps: BoardDeps = { db, ghosts: fakeR2(), eventRule: () => null, now: () => NOW };
  const env = { ONLINE_BOARD: 'on', ONLINE_USAGE: 'on', BOARD_DB: db, GHOSTS: deps.ghosts } as unknown as Env;
  const api = (path: string, e: Env = env, init?: RequestInit) => {
    const url = new URL(`https://librecorsa.org${path}`);
    return handleApi(new Request(url, init), e, url);
  };
  const list = async (query: string) => (await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${TRACK}${query}`))).body as ListAnswer;

  // A busy board: 57 drivers in the LC26 (one of them twice, in two classes), 23 of them also in the GT3, some
  // faster there; an old revision's laps; a tie on time; and the Liana's laps on another circuit
  const drivers = Array.from({ length: 57 }, (_, i) => `Driver ${String(i + 1).padStart(2, '0')}`);
  for (const [i, name] of drivers.entries()) await lap(db, { name, vehicle: 'lc26', ms: 90_000 + i * 250 });
  await lap(db, { name: 'Driver 05', vehicle: 'lc26', ms: 89_000, assists: 'assisted' });
  for (const [i, name] of drivers.slice(10, 33).entries()) await lap(db, { name, vehicle: 'amg-gt3', ms: 92_000 + i * 900 - (i % 3 === 0 ? 5_000 : 0) });
  await lap(db, { name: 'Old Timer', vehicle: 'lc26', ms: 80_000, physics: PHYSICS_VERSION === LC26 ? LC26 - 1 : PHYSICS_VERSION });
  await lap(db, { name: 'Old Gt3', vehicle: 'amg-gt3', ms: 70_000, physics: lapPhysicsVersion('amg-gt3', TRACK) - 1 });
  await lap(db, { name: 'Tied Later', vehicle: 'lc26', ms: 90_000 + 20 * 250, created: NOW + 100_000 });
  await lap(db, { name: 'Elsewhere', vehicle: 'liana', ms: 60_000, track: 'dunsfold' });
  await lap(db, { name: 'Challenger', vehicle: 'lc26', ms: 95_000, event: '2026-W46' });
  const physics = `&vehicle=lc26&physics=${LC26}`;

  // 1. Pages ----------------------------------------------------------------------------------------------------------
  {
    const first = await list(`${physics}`);
    check('pages: no offset or limit is the first 20, as before', first.laps.length === 20 && first.offset === 0 && first.total === 58, `${first.laps.length} of ${first.total}`);
    const seen: Row[] = [];
    for (let offset = 0; offset < first.total; offset += 20) seen.push(...(await list(`${physics}&limit=20&offset=${offset}`)).laps);
    const names = seen.map((r) => r.name);
    check('pages: every driver once across the pages, none twice', seen.length === 58 && new Set(names).size === 58, `${seen.length} rows, ${new Set(names).size} names`);
    check('pages: fastest first across page breaks', seen.every((r, i) => i === 0 || seen[i - 1].lapTimeMs <= r.lapTimeMs));
    check('pages: a driver shows with their fastest lap of any class', seen[0].name === 'Driver 05' && seen[0].lapTimeMs === 89_000);
    const tie = names.indexOf('Tied Later');
    check('pages: a tie on time goes to the earlier lap', tie > 0 && names[tie - 1] === 'Driver 21' && seen[tie - 1].lapTimeMs === seen[tie].lapTimeMs, `${names[tie - 1]} then ${names[tie]}`);
    const past = await list(`${physics}&offset=500`);
    check('pages: past the end is an empty page with the total', past.laps.length === 0 && past.total === 58);
    const junk = await list(`${physics}&offset=-5&limit=abc`);
    check('pages: a bad offset or limit reads as the first page of 20', junk.offset === 0 && junk.laps.length === 20);
    check('pages: an older revision stays off the current board', !names.includes('Old Timer') && !names.includes('Challenger'));
  }

  // 2. Where a driver stands --------------------------------------------------------------------------------------------
  {
    const me = await list(`${physics}&name=driver%2030&near=2`);
    const pos = me.me?.pos ?? 0;
    check('me: their place in the board\'s order, the page it is on', pos === 31 && me.me?.rank === 31 && Math.ceil(pos / 20) === 2, `pos ${pos}, rank ${me.me?.rank}`);
    const page = await list(`${physics}&limit=20&offset=${(Math.ceil(pos / 20) - 1) * 20}`);
    check('me: the page that place is on holds their row', page.laps[(pos - 1) % 20]?.name === 'Driver 30');
    check(
      'me: the places either side, in order',
      me.near?.pos === pos - 2 && me.near.laps.map((r) => r.name).join() === 'Driver 28,Driver 29,Driver 30,Driver 31,Driver 32',
      me.near?.laps.map((r) => r.name).join(),
    );
    const tied = await list(`${physics}&name=Tied%20Later&near=1`);
    check('me: a tie shares the rank, the order still places them after', tied.me !== null && tied.me.rank === tied.me.pos - 1, `rank ${tied.me?.rank} pos ${tied.me?.pos}`);
    const top = await list(`${physics}&name=Driver%2005&near=2`);
    check('me: at the top, the places below only', top.me?.pos === 1 && top.near?.pos === 1 && top.near.laps.length === 3);
    const last = await list(`${physics}&name=Driver%2057&near=5`);
    check('me: at the bottom, the places above only', last.me?.pos === 58 && last.near?.laps.length === 6 && last.near.laps[5].name === 'Driver 57');
    const none = await list(`${physics}&name=Nobody&near=2`);
    check('me: a driver with no lap here has no place and no neighbours', none.me === null && none.near === undefined);
    const plain = await list(`${physics}&name=driver%2030`);
    check('me: without near, the answer is as before plus its place', plain.near === undefined && plain.me?.pos === 31 && plain.me.aboveMs === 90_000 + 28 * 250);
  }

  // 3. The all-cars board -----------------------------------------------------------------------------------------------
  {
    const current = currentPhysicsByCar(currentBoardBase(TRACK));
    check('all cars: every car at the revision this build ships', VEHICLE_MODEL_IDS.every((v) => current[v] === lapPhysicsVersion(v, TRACK)) && current.lc26 === LC26);
    const all = await list(`&vehicle=${ALL_CARS}&limit=100&name=Driver%2011`);
    const names = all.laps.map((r) => r.name);
    check('all cars: every driver once, in any car', all.total === 58 && all.laps.length === 58 && new Set(names).size === 58, `${all.total}`);
    // Drivers 11..33 drove the GT3 too; every third of them (i % 3 === 0) is faster in it
    const gt3Faster = drivers.slice(10, 33).filter((_, i) => 92_000 + i * 900 - (i % 3 === 0 ? 5_000 : 0) < 90_000 + (10 + i) * 250);
    const inGt3 = all.laps.filter((r) => r.vehicle === 'amg-gt3').map((r) => r.name);
    check('all cars: a driver shows with their fastest car, the car on the row', inGt3.length === gt3Faster.length && inGt3.every((n) => gt3Faster.includes(n)), inGt3.join(', '));
    check('all cars: fastest first', all.laps.every((r, i) => i === 0 || all.laps[i - 1].lapTimeMs <= r.lapTimeMs));
    check('all cars: no lap of a retired physics revision', !names.includes('Old Timer') && !names.includes('Old Gt3') && all.laps.every((r) => r.conditions.physicsVersion === current[r.vehicle as VehicleModelId]));
    check('all cars: another circuit and the weekly challenge stay off', !names.includes('Elsewhere') && !names.includes('Challenger'));
    check('all cars: the answer names each car\'s revision, and lists none of its own', all.current?.lc26 === LC26 && all.physics.length === 0);
    const meAll = all.me;
    check('all cars: a driver finds their place over every car', meAll !== null && names[meAll.pos - 1] === 'Driver 11', `pos ${meAll?.pos}`);
    const assisted = await list(`&vehicle=${ALL_CARS}&assists=assisted`);
    check('all cars: the filters narrow it too', assisted.total === 1 && assisted.laps[0]?.name === 'Driver 05');
    const page2 = await list(`&vehicle=${ALL_CARS}&limit=20&offset=20`);
    check('all cars: paged like the others', page2.laps.length === 20 && page2.laps[0].name === names[20]);
    check('all cars: a physics revision is not asked for', (await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${TRACK}&vehicle=all&physics=junk`))).status === 200);
    check('all cars: an unknown car is still refused', (await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${TRACK}&vehicle=bus&physics=7`))).status === 400);
  }

  // 4. The laps a usage report carries --------------------------------------------------------------------------------
  {
    const report = (body: unknown) =>
      recordUsage({ db, now: () => NOW }, new Request('https://librecorsa.org/api/usage', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '10.0.0.1' } }));
    const good = { trackId: TRACK, vehicle: 'lc26', mode: 'practice', minutes: 10 };
    await report({ ...good, laps: 7 });
    await report({ ...good, laps: 5, minutes: 0.5 });
    await report({ ...good, laps: 1.5 });
    await report({ ...good, laps: -3 });
    await report({ ...good, laps: '9' });
    await report({ ...good, vehicle: 'amg-gt3', laps: 6 });
    await report(good);
    const rows = (await db.prepare('SELECT vehicle, SUM(sessions) AS s, SUM(laps) AS l FROM usage_daily GROUP BY vehicle ORDER BY vehicle').all<{ vehicle: string; s: number; l: number }>()).results;
    const lc = rows.find((r) => r.vehicle === 'lc26');
    // 7 counted; 5 in half a minute capped at 3 + 1 = 4; the rest none
    check('usage: laps add up with the sessions; a bad count is none, the report still counts', lc?.s === 6 && lc.l === 11, JSON.stringify(rows));
    check('usage: at most six laps a minute (plus the one under way)', usageLapsOf(5, 0.5) === 4 && usageLapsOf(10_000, 240) === 240 * MAX_LAPS_PER_MINUTE + 1 && usageLapsOf(3, 600) === 3 && usageLapsOf(Number.NaN, 5) === 0);
    const old = fakeD1(sql('0001_lap_boards.sql', '0003_usage.sql'));
    const before = await recordUsage({ db: old, now: () => NOW }, new Request('https://librecorsa.org/api/usage', { method: 'POST', body: JSON.stringify({ ...good, laps: 4 }) }));
    const kept = await old.prepare('SELECT sessions FROM usage_daily').first<{ sessions: number }>();
    check('usage: before migration 0006 a report with laps still counts', before.status === 200 && kept?.sessions === 1);
  }

  // 5. Totals ---------------------------------------------------------------------------------------------------------
  {
    // The LC26 has 60 laps stored on the circuit's open board (58 drivers, Driver 05's second class, the older
    // revision's), and 11 counted
    const stored = (await db.prepare(`SELECT COUNT(*) AS n FROM laps WHERE track_id = ? AND vehicle = 'lc26' AND event = ''`).bind(TRACK).first<{ n: number }>())?.n ?? 0;
    const lcTotals = await circuitTotals(db, TRACK, 'lc26');
    check('totals: laps are the laps stored when the counter has fewer', lcTotals.laps === stored && stored === 60, `${lcTotals.laps} laps, ${stored} stored`);
    check('totals: drivers are the current board\'s, every class', lcTotals.drivers === 58);
    await db.prepare("UPDATE usage_daily SET laps = laps + 5000 WHERE vehicle = 'lc26'").run();
    const counted = await circuitTotals(db, TRACK, 'lc26');
    check('totals: the laps counted when they are more', counted.laps === 5011, String(counted.laps));
    const all = await circuitTotals(db, TRACK, ALL_CARS);
    check('totals: the circuit\'s laps over every car, its drivers over every car', all.laps === 5011 + 6 && all.drivers === 58, `${all.laps} laps, ${all.drivers} drivers`);
    const older = await circuitTotals(db, TRACK, 'lc26', PHYSICS_VERSION === LC26 ? LC26 - 1 : PHYSICS_VERSION);
    check('totals: drivers of an older board when asked for', older.drivers === 1);
    const oldDb = fakeD1(sql('0001_lap_boards.sql', '0003_usage.sql'));
    check('totals: before migration 0006, the stored laps', (await circuitTotals(oldDb, TRACK, ALL_CARS)).laps === 0);
    const dunsfold = await circuitTotals(db, 'dunsfold', 'liana');
    check('totals: another circuit has its own', dunsfold.laps === 1 && dunsfold.drivers === 1);
  }

  // 6. Drivers to date ------------------------------------------------------------------------------------------------
  {
    const base = await driversToDate(db);
    // 57 + Old Timer + Old Gt3 + Tied Later + Elsewhere + Challenger
    check('drivers: every name with a lap on any board, once', base === 62, String(base));
    await db.prepare("INSERT INTO races (id, week, kind, track_id, vehicle, laps, finished_ms) VALUES ('r1', '2026-W46', 'open', ?, 'lc26', 5, ?)").bind(TRACK, NOW).run();
    const car = (pos: number, nameKey: string | null, name: string, laps: number) =>
      db.prepare('INSERT INTO race_cars (race_id, position, name_key, name, code, laps, dnf, grid) VALUES (?, ?, ?, ?, ?, ?, 0, ?)').bind('r1', pos, nameKey, name, 'XXX', laps, pos).run();
    await car(1, 'driver 01', 'Driver 01', 5);
    await car(2, 'racer only', 'Racer Only', 5);
    await car(3, null, 'Unproven Name', 5);
    await car(4, 'no lap racer', 'No Lap Racer', 0);
    check('drivers: a proven race name with a lap counts, once with its board laps', (await driversToDate(db)) === base + 1);

    // A driver renames: their laps and results go with them, and they still count once
    const KEY = 'k'.repeat(43);
    await db.prepare('INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES (?, ?, ?, ?)').bind('racer only', await sha256Hex(KEY), NOW, NOW).run();
    await db.prepare('INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES (?, ?, ?, ?)').bind('driver 02', await sha256Hex(KEY), NOW, NOW).run();
    const rename = (from: string, to: string) =>
      renameDriver(deps, new Request('https://librecorsa.org/api/drivers/rename', { method: 'POST', body: JSON.stringify({ from, to, driverKey: KEY }), headers: { 'CF-Connecting-IP': '10.3.3.3' } }));
    const r1 = await rename('Racer Only', 'Racer Renamed');
    const r2 = await rename('Driver 02', 'Driver Renamed');
    const moved = await db.prepare("SELECT COUNT(*) AS n FROM race_cars WHERE name_key = 'racer renamed'").first<{ n: number }>();
    check('drivers: a rename moves the name, the count stays', r1.status === 200 && r2.status === 200 && moved?.n === 1 && (await driversToDate(db)) === base + 1);
    const before = fakeD1(sql('0001_lap_boards.sql'));
    await lap(before, { name: 'Solo', vehicle: 'lc26', ms: 91_000 });
    check('drivers: before the race results\' table, the boards alone', (await driversToDate(before)) === 1);
  }

  // 7. Through the API: routes, switches, and what is kept --------------------------------------------------------------
  {
    const shared = `public, max-age=${SHARED_ANSWER_S.board}`;
    const nameless = await api(`/api/laps?track=${TRACK}&vehicle=all&offset=20`);
    const body = (await nameless.json()) as ListAnswer;
    check('api: a page without a name is kept for a short while', nameless.status === 200 && nameless.headers.get('Cache-Control') === shared && body.offset === 20, String(nameless.headers.get('Cache-Control')));
    check('api: and still varies by origin', nameless.headers.get('Vary') === 'Origin');
    const named = await api(`/api/laps?track=${TRACK}&vehicle=lc26&physics=${LC26}&name=Driver%2001`);
    check('api: a page with a name is never kept', named.status === 200 && named.headers.get('Cache-Control') === 'no-store');
    const bad = await api(`/api/laps?track=${TRACK}&vehicle=bus`);
    check('api: an error is never kept', bad.status === 400 && bad.headers.get('Cache-Control') === 'no-store');
    const circuit = await api(`/api/stats/circuit?track=${TRACK}&vehicle=lc26`);
    const totals = (await circuit.json()) as { ok: boolean; laps: number; drivers: number };
    check('api: GET /api/stats/circuit says the laps and drivers, kept a minute', circuit.status === 200 && totals.ok && totals.laps === 5011 && totals.drivers === 58 && circuit.headers.get('Cache-Control') === `public, max-age=${SHARED_ANSWER_S.circuit}`, JSON.stringify(totals));
    const allTotals = (await (await api(`/api/stats/circuit?track=${TRACK}`)).json()) as { laps: number };
    check('api: without a car, the circuit over every car', allTotals.laps === 5017);
    check('api: a bad circuit, car or revision is refused', (await api('/api/stats/circuit?track=../x')).status === 400 && (await api(`/api/stats/circuit?track=${TRACK}&vehicle=bus`)).status === 400 && (await api(`/api/stats/circuit?track=${TRACK}&vehicle=lc26&physics=0`)).status === 400);
    const site = await api('/api/stats');
    const siteBody = (await site.json()) as { ok: boolean; drivers: number };
    check('api: GET /api/stats says the drivers to date', site.status === 200 && siteBody.ok && siteBody.drivers > 60 && site.headers.get('Cache-Control') === `public, max-age=${SHARED_ANSWER_S.stats}`);
    const off = { ...env, ONLINE_BOARD: 'off' } as Env;
    check('api: with the boards off, no totals', (await api('/api/stats', off)).status === 404 && (await api(`/api/stats/circuit?track=${TRACK}`, off)).status === 404);
    const foreign = await api('/api/stats', env, { headers: { Origin: 'https://elsewhere.example' } });
    check('api: another site gets no totals', foreign.status === 403 && foreign.headers.get('Cache-Control') === 'no-store');
  }

  // 7b. The usage totals' public side: ranks with no numbers over the last month, and the totals to date ----------------
  {
    const pub = fakeD1(FULL);
    const row = (day: string, track: string, vehicle: string, country: string, sessions: number, minutes: number, laps = 0) =>
      pub
        .prepare('INSERT INTO usage_daily (day, track_id, vehicle, mode, country, sessions, minutes, laps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(day, track, vehicle, 'practice', country, sessions, minutes, laps)
        .run();
    const today = utcDay(NOW);
    const first = utcDay(NOW - (POPULAR_DAYS - 1) * 86_400_000);
    const before = utcDay(NOW - POPULAR_DAYS * 86_400_000);
    check('public: the circuits used here are in the game, monza is not', ['spielberg', 'monaco', 'okayama', 'chang', 'grobnik', 'oschersleben'].every((id) => CIRCUIT_IDS.has(id)) && !CIRCUIT_IDS.has('monza'));
    await row(today, 'spielberg', 'lc26', 'DE', 200, 2000, 300);
    await row(today, 'spielberg', 'lc26', 'XX', 100, 1000, 100);
    await row(today, 'monaco', 'amg-gt3', 'IT', 200, 5000, 400);
    await row(today, 'okayama', 'lc26', 'TR', POPULAR_MIN_SESSIONS - 1, 9000, 50);
    await row(today, 'monza', 'lc26', 'IT', 500, 20_000, 900);
    await row(today, 'junk_track', 'bus', 'DE', 100, 1_000_000);
    await row(first, 'grobnik', 'liana', 'GB', POPULAR_MIN_SESSIONS, 10, 5);
    await row(before, 'oschersleben', 'liana', 'GB', 500, 50_000, 7);
    await row('2026-10-01', 'chang', 'amg-gt3', 'BR', 1000, 99_999, 2000);
    const ranks = await popularRanks(pub, NOW);
    check('public: circuits by hours over the month, most first', JSON.stringify(ranks.circuits) === JSON.stringify(['monaco', 'spielberg', 'grobnik']), JSON.stringify(ranks.circuits));
    check('public: a circuit under the session floor, a retired one, junk and one from before the month are left out', !ranks.circuits.includes('junk_track') && !ranks.circuits.includes('okayama') && !ranks.circuits.includes('monza') && !ranks.circuits.includes('oschersleben') && !ranks.circuits.includes('chang'));
    check('public: cars by hours, only real vehicle models', JSON.stringify(ranks.cars) === JSON.stringify(['lc26', 'amg-gt3', 'liana']) && ranks.days === POPULAR_DAYS, JSON.stringify(ranks.cars));
    const totals = await siteTotals(pub, true);
    const minutes = 2000 + 1000 + 5000 + 9000 + 20_000 + 1_000_000 + 10 + 50_000 + 99_999;
    check('public: totals to date count every day and circuit', totals.since === '2026-10-01' && totals.hours === Math.floor(minutes / 60) && totals.laps === 300 + 100 + 400 + 50 + 900 + 5 + 7 + 2000, JSON.stringify(totals));
    check('public: countries leave out the unknown one', totals.countries === 5, String(totals.countries));
    check('public: drivers only when asked, and none here', totals.drivers === 0 && (await siteTotals(pub, false)).drivers === null);
    const bare = fakeD1(sql('0001_lap_boards.sql', '0002_race_results.sql', '0003_usage.sql'));
    await bare.prepare("INSERT INTO usage_daily (day, track_id, vehicle, mode, country, sessions, minutes) VALUES ('2026-11-11', 'spielberg', 'lc26', 'practice', 'DE', 3, 120)").run();
    await lap(bare, { name: 'Solo', vehicle: 'lc26', ms: 91_000 });
    const old = await siteTotals(bare, true);
    check('public: before the laps column, the boards\' laps', old.laps === 1 && old.hours === 2 && old.drivers === 1, JSON.stringify(old));
    const empty = await siteTotals(fakeD1(FULL), true);
    check('public: nothing counted yet says no first day', empty.since === null && empty.hours === 0);

    // Through the API: kept for a while, off with the usage counter, and the game's reading of the answers
    const liveDay = utcDay(Date.now());
    await row(liveDay, 'chang', 'lc26', 'DE', 80, 600, 10);
    const usageEnv = { ...env, BOARD_DB: pub } as Env;
    const popular = await api('/api/stats/popular', usageEnv);
    const popularBody = await popular.json();
    check('api: GET /api/stats/popular, kept an hour', popular.status === 200 && popular.headers.get('Cache-Control') === `public, max-age=${SHARED_ANSWER_S.popular}` && (popularBody as { circuits: string[] }).circuits.includes('chang'), JSON.stringify(popularBody));
    const totalsRes = await api('/api/stats/totals', usageEnv);
    const totalsBody = await totalsRes.json();
    check('api: GET /api/stats/totals, kept a quarter hour', totalsRes.status === 200 && totalsRes.headers.get('Cache-Control') === `public, max-age=${SHARED_ANSWER_S.totals}` && (totalsBody as { drivers: unknown }).drivers === 0, JSON.stringify(totalsBody));
    const noBoard = (await (await api('/api/stats/totals', { ...usageEnv, ONLINE_BOARD: 'off' } as Env)).json()) as { drivers: unknown; hours: number };
    check('api: with the boards off, totals without drivers', noBoard.drivers === null && noBoard.hours > 0);
    const noUsage = { ...usageEnv, ONLINE_USAGE: 'off' } as Env;
    check('api: with the usage counter off, neither', (await api('/api/stats/popular', noUsage)).status === 404 && (await api('/api/stats/totals', noUsage)).status === 404);
    check('api: a query string is refused, so the edge keeps one copy', (await api('/api/stats/popular?x=1', usageEnv)).status === 400 && (await api('/api/stats/totals?x=1', usageEnv)).status === 400);
    // Read back from the fixed-day ranks: the API's own month moves with the clock
    const parsed = parsePopular(JSON.parse(JSON.stringify({ ok: true, ...ranks })));
    check('client: the ranks read back', parsed !== null && JSON.stringify(parsed) === JSON.stringify(ranks) && parsePopular(popularBody) !== null);
    check('client: junk ids are dropped, a malformed answer is refused', JSON.stringify(parsePopular({ ok: true, days: 30, circuits: ['spielberg', '../x', 7], cars: ['lc26', 'bus'] })) === JSON.stringify({ days: 30, circuits: ['spielberg'], cars: ['lc26'] }) && parsePopular({ ok: true, days: 30, circuits: 'spielberg', cars: [] }) === null);
    const parsedTotals = parseSiteTotals(totalsBody);
    check('client: the totals read back', parsedTotals !== null && parsedTotals.since === '2026-10-01' && parsedTotals.drivers === 0);
    check('client: no first day or a broken number is refused', parseSiteTotals({ ok: true, since: null, hours: 0, laps: 0, countries: 0, drivers: null }) === null && parseSiteTotals({ ok: true, since: '2026-11-11', hours: -1, laps: 0, countries: 0, drivers: null }) === null);
  }

  // 8. The database finds these through its indexes -------------------------------------------------------------------
  {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    raw.exec(FULL);
    const plan = (s: string, ...b: (string | number)[]) => (raw.prepare(`EXPLAIN QUERY PLAN ${s}`).all(...b) as { detail: string }[]).map((r) => r.detail).join(' | ');
    const one = plan('SELECT * FROM laps WHERE track_id = ? AND vehicle = ? AND physics = ? AND event = ? ORDER BY lap_time_ms', TRACK, 'lc26', LC26, '');
    check('index: one car\'s board reads its own rows', /USING INDEX laps_board|USING COVERING INDEX laps_driver_class/.test(one), one);
    const lc = currentPhysicsByCar(currentBoardBase(TRACK));
    const ids = Object.keys(lc);
    const every = plan(`SELECT COUNT(DISTINCT name_key) FROM laps WHERE track_id = ? AND event = '' AND vehicle IN (${ids.map(() => '?').join(', ')}) AND physics = CASE vehicle ${ids.map(() => 'WHEN ? THEN ?').join(' ')} END`, TRACK, ...ids, ...Object.entries(lc).flat());
    check('index: the all-cars board reads the circuit\'s rows only', /\(track_id=\?/.test(every) && !/SCAN laps\b/.test(every), every);
    const usage = plan('SELECT SUM(laps) FROM usage_daily WHERE track_id = ? AND vehicle = ?', TRACK, 'lc26');
    check('index: a circuit\'s counted laps without reading every day', /usage_daily_track/.test(usage), usage);
  }

  // 9. The live count ---------------------------------------------------------------------------------------------------
  {
    let t = NOW;
    const counter = new PresenceCounter(fakeState(), {} as Env, () => t);
    // Three tabs out of phase, each beating once a minute; a fourth joins in the sixth minute
    const beatAt = (ms: number) => {
      t = ms;
      counter.beat();
    };
    for (let minute = 0; minute < 5; minute++) for (const phase of [0, 17_000, 41_000]) beatAt(NOW + minute * 60_000 + phase);
    t = NOW + 4 * 60_000 + 50_000;
    check('live: tabs that beat once a minute count once each', counter.count() === 3, String(counter.count()));
    for (const phase of [0, 17_000, 30_000, 41_000]) beatAt(NOW + 5 * 60_000 + phase);
    t = NOW + 5 * 60_000 + 45_000;
    check('live: a new tab counts from its first beat', counter.count() === 4, String(counter.count()));
    t = NOW + 7 * 60_000;
    check('live: tabs that stopped beating leave within the minute', counter.count() === 0, String(counter.count()));
    const res = await counter.fetch(new Request('https://librecorsa.org/api/live', { method: 'POST' }));
    const read = (await (await counter.fetch(new Request('https://librecorsa.org/api/live'))).json()) as { live: number };
    check('live: the object takes a beat and says the count', res.status === 204 && read.live === 1);
    counter.dispose();

    // Through the API, with the object behind a stand-in namespace
    const one = new PresenceCounter(fakeState(), {} as Env);
    const ns: DurableObjectNamespace = { idFromName: (name: string) => ({ toString: () => name }), get: (id) => ({ fetch: (r: Request) => (id.toString() === 'live' ? one.fetch(r) : Promise.resolve(new Response(null, { status: 500 }))) }) };
    const seen: string[] = [];
    const limit: RateLimit = { limit: async ({ key }) => (seen.push(key), { success: seen.filter((k) => k === key).length <= 6 }) };
    const liveEnv = { ...env, ONLINE_LIVE: 'on', PRESENCE: ns, LIVE_LIMIT: limit } as Env;
    const beat = (ip: string, e: Env = liveEnv) => api('/api/live', e, { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await beat('10.7.7.7')).status);
    statuses.push((await beat('10.8.8.8')).status);
    check('api: POST /api/live counts a beat, the seventh in a minute from one address is 429', statuses.join() === '204,204,204,204,204,204,429,204', statuses.join());
    const stats = await api('/api/stats', liveEnv);
    const body = (await stats.json()) as { ok: boolean; live: number | null; drivers: number | null };
    check('api: GET /api/stats says the live count beside the drivers', stats.status === 200 && body.live === 7 && typeof body.drivers === 'number', JSON.stringify(body));
    check('config: the live count on with its switch and its object', onlineConfig(liveEnv).live && !onlineConfig(env).live && !onlineConfig({ ...liveEnv, ONLINE_LIVE: 'off' }).live);
    const liveOnly = { ONLINE_LIVE: 'on', PRESENCE: ns } as unknown as Env;
    const alone = (await (await api('/api/stats', liveOnly)).json()) as { live: number | null; drivers: number | null };
    check('api: with the boards off, the live count alone', alone.live === 7 && alone.drivers === null);
    check('api: with the live count off, no heartbeats taken', (await beat('10.9.9.9', env)).status === 404);
    const broken = { ...liveEnv, PRESENCE: { idFromName: ns.idFromName, get: () => ({ fetch: () => Promise.reject(new Error('down')) }) } } as Env;
    const down = (await (await api('/api/stats', broken)).json()) as { live: number | null; drivers: number | null };
    check('api: an object that can\'t be reached says no count, not a made-up one', down.live === null && typeof down.drivers === 'number');
    one.dispose();
  }

  // 10. The game's side: reading the answers, and when a tab beats -----------------------------------------------------
  {
    const raw = (await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${TRACK}&vehicle=all&limit=20&offset=20&name=Driver%2030&near=2`))).body;
    const page = parseBoardPage(raw, TRACK, ALL_CARS, 0, {}, 20);
    check('client: an all-cars page reads every car\'s rows, its offset and the driver\'s place', page !== null && page.entries.length === 20 && page.offset === 20 && page.total === 58 && page.me?.pos !== undefined && page.near?.entries.length === 5, `${page?.entries.length} rows, offset ${page?.offset}`);
    check('client: the rows carry their cars', new Set(page?.entries.map((e) => e.vehicle)).size >= 1 && page!.entries.every((e) => e.source === 'remote'));
    // A browser on the LC26's older engine works out another revision for it: the server's list decides
    const g = globalThis as { window?: unknown; localStorage?: unknown };
    g.window = { location: { search: '' } };
    g.localStorage = { getItem: (k: string) => (k === 'librecorsa.lc26Engine' ? 'classic' : null), setItem: () => {} };
    const classic = parseBoardPage(raw, TRACK, ALL_CARS, 0, {}, 20);
    const ownRevision = lapPhysicsVersion('lc26', TRACK);
    delete g.window;
    delete g.localStorage;
    check('client: a browser on the LC26\'s older engine still reads the all-cars board', ownRevision !== LC26 && classic?.entries.length === 20, `own p${ownRevision}, ${classic?.entries.length} rows`);
    const forged = parseBoardPage({ ...(raw as object), current: { ...(raw as { current: object }).current, lc26: 1 } }, TRACK, ALL_CARS, 0, {}, 20);
    check('client: rows on a revision the answer does not name are dropped', (forged?.entries.length ?? 0) < 20);
    const one = parseBoardPage((await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${TRACK}&vehicle=lc26&physics=${LC26}`))).body, TRACK, 'amg-gt3', lapPhysicsVersion('amg-gt3', TRACK), {}, 20);
    check('client: one car\'s rows never show on another car\'s board', one !== null && one.entries.length === 0);
    check('client: junk is no page', parseBoardPage({ laps: 'x' }, TRACK, ALL_CARS, 0, {}) === null && parseBoardPage(null, TRACK, 'lc26', LC26, {}) === null);
    check(
      'heartbeat: at once when shown, then a minute after the last, none while hidden',
      nextHeartbeatInMs(true, 1_000_000, Number.NEGATIVE_INFINITY) === 0 && nextHeartbeatInMs(true, 1_000_000, 1_000_000 - 20_000) === HEARTBEAT_MS - 20_000 && nextHeartbeatInMs(false, 1_000_000, 0) === null,
    );
    check('count: thousands grouped as the panels say them', formatCount(1204) === '1,204' && formatCount(0) === '0');

    // The HUD's lap board: the top three, a gap, two either side of the player's; less where the screen has no room
    const tower = async (who: string, room?: number) => {
      const body = (await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${TRACK}&vehicle=lc26&physics=${LC26}&limit=7&near=2&name=${encodeURIComponent(who)}`))).body;
      const p = parseBoardPage(body, TRACK, 'lc26', LC26, {}, 7)!;
      return towerLines(p, who.toLowerCase(), room).map((l) => ('gap' in l ? '...' : `${l.pos}${l.mine ? '*' : ''}`)).join(' ');
    };
    check('tower: top three, a gap, the two places either side', (await tower('Driver 30')) === '1 2 3 ... 29 30 31* 32 33', await tower('Driver 30'));
    check('tower: in the top five, a plain top', (await tower('Driver 03')) === '1 2 3 4* 5 6' && (await tower('Driver 05')) === '1* 2 3 4 5', await tower('Driver 03'));
    check('tower: short of room, the player and the places next to them first', (await tower('Driver 30', 3)) === '30 31* 32' && (await tower('Driver 30', 5)) === '1 ... 30 31* 32', `${await tower('Driver 30', 3)} | ${await tower('Driver 30', 5)}`);
    check('tower: no room at all still shows the player', (await tower('Driver 30', 0)) === '31*');
    check('tower: no lap yet, the top five', (await tower('Nobody')) === '1 2 3 4 5');
  }

  // 9. Older physics versions: their boards read as they were ---------------------------------------------------------
  {
    // Another circuit, so the counts above stay as they are: Physics V1 laps (the LC26 on its rigid-body revision and
    // on its older engine's, and a GT3), and a lap of the version driven now
    const ON = 'grobnik';
    const V1 = PHYSICS_VERSIONS[0].physics;
    await lap(db, { name: 'Vee One', vehicle: 'lc26', ms: 80_000, physics: boardPhysicsVersion(V1, 'lc26'), track: ON });
    await lap(db, { name: 'Vee One Gt3', vehicle: 'amg-gt3', ms: 85_000, physics: V1, track: ON });
    await lap(db, { name: 'Vee One Classic', vehicle: 'lc26', ms: 79_000, physics: V1, track: ON });
    await lap(db, { name: 'Vee Two', vehicle: 'lc26', ms: 82_000, track: ON });
    const read = async (query: string) => listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${ON}&vehicle=all${query}`));
    const now = (await read('')).body as ListAnswer;
    check('versions: every car\'s board is the version driven now by default', now.total === 1 && now.laps[0]?.name === 'Vee Two' && now.current?.lc26 === LC26, `${now.total}`);
    const older = (await read(`&version=${V1}`)).body as ListAnswer;
    const olderNames = older.laps.map((r) => r.name);
    check(
      'versions: version=7 reads every car on its Physics V1 revision',
      older.total === 2 && olderNames.join() === 'Vee One,Vee One Gt3' && older.current?.lc26 === 527 && older.current?.['amg-gt3'] === 7,
      `${olderNames.join()} ${JSON.stringify(older.current && { lc26: older.current.lc26, gt3: older.current['amg-gt3'] })}`
    );
    check('versions: asking for the version driven now is the default board', ((await read(`&version=${PHYSICS_VERSION}`)).body as ListAnswer).total === 1);
    const refused = await Promise.all(['junk', '5', '527', '7.5'].map(async (v) => (await read(`&version=${v}`)).status));
    check('versions: a version the boards don\'t name is refused', refused.every((st) => st === 400), refused.join());
    const named = (await read(`&version=${V1}&name=Vee%20One%20Gt3`)).body as ListAnswer;
    check('versions: a driver finds their place on the older board', named.me?.pos === 2 && named.me.lap.name === 'Vee One Gt3');
    const one = (await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${ON}&vehicle=lc26&physics=${boardPhysicsVersion(V1, 'lc26')}`))).body as ListAnswer;
    check('versions: one car\'s older board as it always was', one.total === 1 && one.laps[0]?.name === 'Vee One' && one.physics.join() === `${LC26},${boardPhysicsVersion(V1, 'lc26')},${V1}`, one.physics.join());

    const page = parseBoardPage(older, ON, ALL_CARS, 0, {}, 20, V1);
    check('client: an older version\'s all-cars page reads its rows', page !== null && page.entries.map((e) => e.name).join() === 'Vee One,Vee One Gt3');
    const unsaid = parseBoardPage({ ...older, current: undefined }, ON, ALL_CARS, 0, {}, 20, V1);
    check('client: without the server\'s list, the rows are checked against that version', unsaid?.entries.length === 2);
    const mixed = parseBoardPage(older, ON, ALL_CARS, 0, {}, 20);
    check('client: read as the version driven now, the older rows are still checked by what the server said', mixed?.entries.length === 2);
    const crossed = parseBoardPage({ ...older, current: undefined }, ON, ALL_CARS, 0, {}, 20);
    check('client: older rows never pass as the version driven now', crossed?.entries.length === 0);

    const totals = await circuitTotals(db, ON, ALL_CARS, V1);
    check('versions: totals count the older board\'s drivers', totals.drivers === 2 && (await circuitTotals(db, ON, ALL_CARS)).drivers === 1, `${totals.drivers}`);
    const viaApi = (await (await api(`/api/stats/circuit?track=${ON}&vehicle=all&version=${V1}`)).json()) as { ok: boolean; drivers: number };
    check('versions: and through the API, by version', viaApi.ok && viaApi.drivers === 2, JSON.stringify(viaApi));
    check('versions: a totals version the boards don\'t name is refused', (await api(`/api/stats/circuit?track=${ON}&vehicle=all&version=99`)).status === 400);
  }

  // 10. A circuit whose boards started again on their own (src/lib/circuit-board-resets.ts): put in for these checks
  {
    const ON = 'oschersleben';
    const RESETS = CIRCUIT_BOARD_RESETS as Record<string, CircuitBoardReset[]>;
    await lap(db, { name: 'Pre Fix', vehicle: 'lc26', ms: 70_000, track: ON });
    await lap(db, { name: 'Pre Fix Two', vehicle: 'lc26', ms: 70_500, track: ON });
    await lap(db, { name: 'Pre Fix Gt3', vehicle: 'amg-gt3', ms: 75_000, track: ON });
    RESETS[ON] = [{ physics: PHYSICS_VERSION, oldBoard: 'Old kerbs', why: 'a check' }];
    try {
      // Laps after the restart, on the revision the game now gives them there
      await lap(db, { name: 'Post Fix', vehicle: 'lc26', ms: 71_000, track: ON });
      await lap(db, { name: 'Post Fix Gt3', vehicle: 'amg-gt3', ms: 76_000, track: ON });
      const read = async (query: string) => (await listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${ON}&vehicle=all${query}`))).body as ListAnswer;
      const now = await read('');
      const before = await read(`&version=${PHYSICS_VERSION}`);
      check(
        'restart: every car\'s board is the restarted one, the board before it kept',
        now.laps.map((r) => r.name).join() === 'Post Fix,Post Fix Gt3' && now.current?.lc26 === 1528 && now.current?.['amg-gt3'] === 1008 &&
          before.laps.map((r) => r.name).join() === 'Pre Fix,Pre Fix Two,Pre Fix Gt3' && before.current?.lc26 === LC26,
        `${now.laps.map((r) => r.name).join()} | ${before.laps.map((r) => r.name).join()}`
      );
      const unsaid = (b: ListAnswer) => ({ ...b, current: undefined });
      check(
        'restart: the client reads both, with or without the server\'s list',
        parseBoardPage(now, ON, ALL_CARS, 0, {}, 20)?.entries.length === 2 && parseBoardPage(unsaid(now), ON, ALL_CARS, 0, {}, 20)?.entries.length === 2 &&
          parseBoardPage(unsaid(before), ON, ALL_CARS, 0, {}, 20, PHYSICS_VERSION)?.entries.length === 3 && parseBoardPage(unsaid(before), ON, ALL_CARS, 0, {}, 20)?.entries.length === 0
      );
      const totals = [await circuitTotals(db, ON, ALL_CARS), await circuitTotals(db, ON, ALL_CARS, PHYSICS_VERSION), await circuitTotals(db, ON, 'lc26'), await circuitTotals(db, ON, 'lc26', LC26)];
      check('restart: totals count each board\'s drivers', totals.map((t) => t.drivers).join() === '2,3,1,2', totals.map((t) => t.drivers).join());
      const viaApi = (await (await api(`/api/stats/circuit?track=${ON}&vehicle=all&version=${PHYSICS_VERSION}`)).json()) as { drivers: number };
      check('restart: and through the API', viaApi.drivers === 3 && (await api(`/api/stats/circuit?track=${ON}&vehicle=all&version=1007`)).status === 400);
      // A circuit id from a request is looked up as the map's own entry: a word every object has is no circuit with restarts
      const words = await Promise.all(
        ['constructor', 'toString', 'hasOwnProperty'].flatMap((w) => [
          listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${w}&vehicle=lc26&physics=${LC26}`)),
          listLaps(deps, new URL(`https://librecorsa.org/api/laps?track=${w}&vehicle=all`)),
        ])
      ).then((rs) => rs.map((r) => r.status));
      const wordTotals = await api('/api/stats/circuit?track=constructor&vehicle=all');
      check('restart: a circuit named like an object\'s own key reads as an empty board', words.every((st) => st === 200) && wordTotals.status === 200, `${words.join()} ${wordTotals.status}`);
    } finally {
      delete RESETS[ON];
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll board page, total and live count checks passed.');
}

void main();
