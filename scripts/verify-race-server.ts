/**
 * Headless checks of the race server (cloudflare/api/race.ts), which stands in for the host of a scheduled race:
 * it takes entrants until shortly before the lights, makes the grid, answers clock pings, passes each car's state
 * and pings on to the others, and lets nobody speak as another car or as the server.
 *
 *   npx tsx scripts/verify-race-server.ts
 *
 * The Durable Object's state and sockets are stood in for by plain objects, and its clock is the test's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi, onlineConfig, raceSlotSeconds } from '../cloudflare/api/index';
import { MAX_RACERS, RACE_SERVER_ID, RaceServer } from '../cloudflare/api/race';
import type { Env } from '../cloudflare/api/types';
import { countdownLabel, nextRaceSlot, RACE_COUNTDOWN_MS, RACE_JOIN_CUTOFF_MS, raceRules, raceSlot } from '../src/lib/net/race-schedule';
import { MAX_STATE_PACKETS_PER_S, sanitizeControl, type ControlMessage, type LobbyState, type RaceStartInfo } from '../src/lib/net/wire';
import { sha256Hex } from '../cloudflare/api/board';
import { parseDriverRecord, parseWeekRaceResults } from '../src/lib/net/race-results';
import { FakeSocket, fakeD1, fakeState } from './lib/fake-cloudflare';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

const SLOT_S = 1200;
const slot = raceSlot(Math.ceil(Date.UTC(2026, 10, 11, 12) / (SLOT_S * 1000)) + 1, SLOT_S);
const rules = raceRules(slot);
let nowMs = slot.startsMs - 10 * 60_000;
const token = (c: string) => c.repeat(16);

const packet = (peerId: string, over: Record<string, unknown> = {}) => ({
  peerId,
  driverCode: 'ABC',
  teamColorHex: '#112233',
  timestampMs: 1000,
  pos: [1, 2, 3],
  quat: [0, 0, 0, 1],
  linVel: [10, 0, 0],
  angVel: [0, 0, 0],
  steerAngle: 0,
  wheelRPMs: [100, 100, 100, 100],
  throttle: 1,
  brake: 0,
  trackS: 50,
  speedKmh: 36,
  ...over,
});
const lobbyOf = (ws: FakeSocket): LobbyState | undefined =>
  [...ws.sent].reverse().map((m) => sanitizeControl(m.ctl)).find((c) => c?.type === 'lobby')?.lobby as LobbyState | undefined;
const startOf = (ws: FakeSocket): RaceStartInfo | undefined =>
  [...ws.sent].reverse().map((m) => sanitizeControl(m.ctl)).find((c) => c?.type === 'start')?.start as RaceStartInfo | undefined;
const states = (ws: FakeSocket) => ws.sent.filter((m) => typeof m.peerId === 'string');

async function main() {
  // The schedule
  check('schedule: races start on the slot, every slot', nextRaceSlot(slot.startsMs - 5 * 60_000, SLOT_S).startsMs === slot.startsMs && raceSlot(slot.index + 1, SLOT_S).startsMs - slot.startsMs === SLOT_S * 1000);
  check('schedule: too close to the lights, the next race is the one after', nextRaceSlot(slot.startsMs - RACE_JOIN_CUTOFF_MS + 1, SLOT_S).index === slot.index + 1 && nextRaceSlot(slot.startsMs - RACE_JOIN_CUTOFF_MS, SLOT_S).index === slot.index);
  check('schedule: this week has a time trial that is not raced on, so its races are on another circuit and car', rules.trackId === 'dunsfold' && rules.race.trackId !== rules.trackId && rules.race.vehicle !== rules.vehicle);
  check('schedule: a race is run to the rules of its week', rules.trackId.length > 0 && rules.race.laps >= 1 && rules.startsMs <= slot.startsMs && slot.startsMs < rules.endsMs);
  check('schedule: the countdown reads minutes and seconds', countdownLabel(slot.startsMs, slot.startsMs - 754_000) === '12:34' && countdownLabel(slot.startsMs, slot.startsMs + 5000) === '0:00');

  const state = fakeState();
  // The week's challenge times: Bea has one, so she starts ahead of Al, who joined first
  const db = fakeD1(['0001_lap_boards.sql', '0002_race_results.sql'].map((f) => readFileSync(join(__dirname, '../cloudflare/migrations', f), 'utf8')).join('\n'));
  await db
    .prepare("INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES ('x', ?, ?, 2, ?, 'pro', 'full', 'dry', 'soft', 'bea', 'Bea', 'BEA', 90000, 1, 1, 1, 1, 1)")
    .bind(rules.trackId, rules.vehicle, rules.id)
    .run();
  let server = new RaceServer(state, { BOARD_DB: db } as unknown as Env, () => nowMs);
  const join_ = async (peer: string, tok: string, name?: string) => {
    const ws = new FakeSocket();
    await server.connect(ws, peer, tok, slot);
    if (name && ws.closed === null) {
      await server.webSocketMessage(ws, JSON.stringify({ ctl: { type: 'hello', name, code: name.slice(0, 3), color: '#00FF00', vehicle: rules.race.vehicle }, from: peer }));
    }
    return ws;
  };

  const before = await (await server.fetch(new Request('https://librecorsa.test/api/races/waiting?peek=1'))).json() as { waiting: number; names: string[] };
  check('a look at the race before anyone joins: nobody waiting, and nothing set up', before.waiting === 0 && before.names.length === 0 && state.alarmMs === null, JSON.stringify(before));
  const al = await join_('peer_al', token('a'), 'Al');
  check('an entrant is welcomed with the start time, then the lobby', al.sent[0].t === 'welcome' && al.sent[0].startsMs === slot.startsMs && sanitizeControl(al.sent[1].ctl)?.type === 'lobby' && al.sent[1].from === RACE_SERVER_ID);
  check('the grid alarm is set for shortly before the lights', state.alarmMs === slot.startsMs - RACE_COUNTDOWN_MS);
  const lobby = lobbyOf(al);
  check('the lobby names the server as host and the week\'s circuit, car and laps', lobby?.hostId === RACE_SERVER_ID && lobby.settings.trackId === rules.race.trackId && lobby.settings.vehicle === rules.race.vehicle && lobby.settings.laps === rules.race.laps && lobby.race === null);
  check('an entrant is in the lobby once it has said hello', lobby?.players.length === 1 && lobby.players[0].name === 'Al' && lobby.players[0].isHost === false);

  nowMs += 1000;
  const bea = await join_('peer_bea', token('b'), 'Bea');
  check('everyone sees a new entrant', lobbyOf(al)?.players.length === 2 && lobbyOf(bea)?.players.length === 2);
  const look = await (await server.fetch(new Request('https://librecorsa.test/api/races/waiting?peek=1'))).json() as { waiting: number; names: string[] };
  check('someone not in the race sees how many are waiting, and their names', look.waiting === 2 && look.names.join() === 'Al,Bea', JSON.stringify(look));
  check('a bad id or token is refused', (await join_('peer bad!', token('c'))).last()?.t === 'bad' && (await join_(RACE_SERVER_ID, token('c'))).last()?.t === 'bad' && (await join_('peer_c', 'short')).last()?.t === 'bad');
  check("someone else can't take an entrant's id", (await join_('peer_al', token('z'))).last()?.t === 'taken' && al.closed === null);

  // Clock and delays
  al.sent.length = 0;
  bea.sent.length = 0;
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'ping', t0: 5 }, from: 'peer_al' }));
  const pong = al.sent.find((m) => sanitizeControl(m.ctl)?.type === 'pong');
  check('a ping is answered with the server\'s clock, to the sender only', pong?.from === RACE_SERVER_ID && (pong.ctl as { now: number }).now === nowMs && (pong.ctl as { t0: number }).t0 === 5 && !bea.sent.some((m) => m.from === RACE_SERVER_ID));
  check('and passed on, so cars can measure their delay to each other', bea.sent.length === 1 && bea.sent[0].from === 'peer_al' && sanitizeControl(bea.sent[0].ctl)?.type === 'ping');
  await server.webSocketMessage(bea, JSON.stringify({ ctl: { type: 'pong', t0: 5, now: 77 }, from: 'peer_bea', to: 'peer_al' }));
  check("a car's pong reaches the car it answers", al.sent[al.sent.length - 1].from === 'peer_bea' && al.sent[al.sent.length - 1].to === 'peer_al');

  // Nobody speaks as another car or as the server
  const n = bea.sent.length;
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'hello', name: 'Fake', code: 'FAK', color: '#000000' }, from: 'peer_bea' }));
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'lobby', lobby: { hostId: 'peer_al', settings: {}, players: [] } }, from: 'peer_al' }));
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'start', start: { id: 'x', lightsStartHostMs: 1, holdMs: 1, laps: 1, grid: [] } }, from: 'peer_al' }));
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'abort', id: 'x' }, from: 'peer_al' }));
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'ping', t0: 1 }, from: RACE_SERVER_ID }));
  await server.webSocketMessage(al, 'not json');
  check("a car can't speak as another, nor send a lobby, a start or an abort", bea.sent.length === n);

  // Before the race, cars are not passed on
  await server.webSocketMessage(al, JSON.stringify(packet('peer_al')));
  check('before the race, car state is not passed on', states(bea).length === 0);

  // A late entrant, and one who left
  const cy = await join_('peer_cy', token('c'), 'Cy');
  check("and the names in the lobby are still their own", lobbyOf(cy)?.players.find((p) => p.peerId === 'peer_bea')?.name === 'Bea');
  // As the runtime does it: the socket is still listed while its close is handled
  cy.closing = true;
  await server.webSocketClose(cy, 1001);
  cy.closing = false;
  check('an entrant who leaves is gone from the lobby at once', lobbyOf(al)?.players.length === 2);
  const dee = await join_('peer_dee', token('d'));
  nowMs = slot.startsMs - RACE_JOIN_CUTOFF_MS + 1;
  check('too close to the lights nobody new is taken', (await join_('peer_late', token('e'), 'Late')).last()?.t === 'closed');

  // Driver keys: Al's owns his name on the board, Bea's is not the key her name was claimed with
  const keyAl = 'k'.repeat(40);
  const keyBea = 'b'.repeat(40);
  await db.prepare("INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES ('al', ?, 1, 1), ('bea', ?, 1, 1)").bind(await sha256Hex(keyAl), await sha256Hex('x'.repeat(40))).run();
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'identify', driverKey: keyAl }, from: 'peer_al' }));
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'identify', driverKey: 'z'.repeat(40) }, from: 'peer_al' }));
  await server.webSocketMessage(bea, JSON.stringify({ ctl: { type: 'identify', driverKey: keyBea }, from: 'peer_bea' }));
  const keys = state.store.get('keys') as Record<string, string> | undefined;
  check('a driver key is kept as its SHA-256 only, and once per socket', keys?.peer_al === (await sha256Hex(keyAl)) && !JSON.stringify([...state.store.values()]).includes(keyAl));

  // The grid
  nowMs = slot.startsMs - RACE_COUNTDOWN_MS;
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'ping', t0: 9 }, from: 'peer_al' }));
  await server.webSocketMessage(bea, JSON.stringify({ ctl: { type: 'ping', t0: 9 }, from: 'peer_bea' }));
  await server.alarm();
  const start = startOf(al);
  check('at the alarm everyone gets the same start', start !== undefined && JSON.stringify(start) === JSON.stringify(startOf(bea)));
  check('the lights are on the server\'s clock at the slot time', start?.lightsStartHostMs === slot.startsMs && start.trackId === rules.race.trackId && start.vehicle === rules.race.vehicle && start.laps === rules.race.laps);
  check('the grid: this week\'s fastest first, then the order they joined; no one who never said hello', start?.grid.join() === 'peer_bea,peer_al', start?.grid.join());
  check('every lobby from now on carries the race', lobbyOf(al)?.race?.id === start?.id);
  check('the room is set to close well after the race', (state.alarmMs ?? 0) > slot.startsMs + rules.race.laps * 60_000);
  void dee;

  // The race: state is passed on, cleaned, to the others
  check("the race has an open race's contact rule", start?.collisions === 'protected' && lobbyOf(bea)?.settings.collisions === 'protected', String(start?.collisions));
  bea.sent.length = 0;
  await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { extra: 'x', quat: [0, 0, 0, 2], hz: true })));
  const relayed = states(bea)[0];
  check("a car's state reaches the others, cleaned", relayed?.peerId === 'peer_al' && relayed.extra === undefined && (relayed.quat as number[])[3] === 1);
  check('with its hazard flag', relayed?.hz === true);
  check('and never comes back to its sender', states(al).length === 0);
  await server.webSocketMessage(al, JSON.stringify(packet('peer_bea')));
  await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { pos: [1, 2, Infinity] })));
  await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { pos: [1e9, 0, 0] })));
  check("another car's state, or an impossible one, is dropped", states(bea).length === 1);
  for (let i = 0; i < 200; i++) await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { seq: i })));
  check('a flooding car is cut off', states(bea).length <= MAX_STATE_PACKETS_PER_S + 1, `${states(bea).length} passed of 201`);

  // The official result: Al finishes, Bea never does
  const laps = rules.race.laps;
  const lightsOut = (start?.lightsStartHostMs ?? 0) + 5000 + (start?.holdMs ?? 0);
  const raceId = start?.id ?? '';
  const finish = (ws: FakeSocket, from: string, over: Record<string, unknown> = {}) =>
    server.webSocketMessage(ws, JSON.stringify({ ctl: { type: 'finish', id: raceId, timeS: laps * 80, penaltyS: 5, laps, bestLapMs: 78_000, ...over }, from }));
  const results = (ws: FakeSocket) => ws.sent.map((m) => sanitizeControl(m.ctl)).filter((c) => c?.type === 'result') as Extract<ControlMessage, { type: 'result' }>[];
  nowMs = lightsOut + (laps * 80 + 5) * 1000;
  al.sent.length = 0;
  bea.sent.length = 0;
  await finish(bea, 'peer_bea');
  check('a finish from a car that sent no state in the race is refused', results(al).length === 0 && results(bea).length === 0);
  await server.webSocketMessage(bea, JSON.stringify(packet('peer_bea', { race: { id: raceId, dist: 900, fin: null, best: null } })));
  await finish(al, 'peer_al', { timeS: laps * 20 });
  await finish(al, 'peer_al', { timeS: laps * 80 + 60 });
  await finish(al, 'peer_al', { laps: laps + 1 });
  await finish(al, 'peer_al', { id: 'race0' });
  await finish(al, 'peer_al', { laps: laps - 1, timeS: (laps - 1) * 80 });
  check('a finish sooner than laps of a believable lap, in the future, over the distance, short of it as the first car home or of another race is refused', results(al).length === 0);
  const alarmBefore = state.alarmMs;
  await finish(al, 'peer_al');
  const provisional = results(bea)[0];
  check('a finish goes to everyone as a result that is not final yet', provisional !== undefined && !provisional.final && results(al).length === 1);
  check(
    'the result: finishers by time with the penalty in, the others after them, with their grid places',
    provisional?.rows[0].peer === 'peer_al' && provisional.rows[0].timeS === laps * 80 + 5 && provisional.rows[0].grid === 2 && provisional.rows[1].peer === 'peer_bea' && !provisional.rows[1].dnf && provisional.rows[1].grid === 1,
    JSON.stringify(provisional?.rows),
  );
  check('the alarm now closes the result 90 s after the first finish, before the room', state.alarmMs === nowMs + 90_000 && (alarmBefore ?? 0) > nowMs + 90_000, `${state.alarmMs} vs ${nowMs + 90_000}`);
  await finish(al, 'peer_al', { timeS: laps * 79 });
  check('the first report stands: a repeat only hears the result again', results(al).length === 2 && results(al)[1].rows[0].timeS === laps * 80 + 5);
  // Evicted meanwhile: a new instance on the same storage
  const revived = new RaceServer(state, { BOARD_DB: db } as unknown as Env, () => nowMs);
  nowMs += 90_000;
  await revived.alarm();
  const final = results(bea).find((r) => r.final);
  check('90 s after the first finish the result is final, the car still out DNF (after an eviction too)', final !== undefined && final.rows[0].peer === 'peer_al' && final.rows[1].dnf && final.rows[1].timeS === null, JSON.stringify(final?.rows));
  check('then the alarm is back on the room close', state.alarmMs === slot.startsMs + (rules.race.laps * 4 + 10) * 60_000, String(state.alarmMs));
  const stored = await db.prepare('SELECT position, name_key, name, time_s, dnf, grid FROM race_cars ORDER BY position').all<{ position: number; name_key: string | null; name: string; time_s: number | null; dnf: number; grid: number }>();
  const storedRace = await db.prepare('SELECT week, kind, laps FROM races').first<{ week: string; kind: string; laps: number }>();
  check('the final result is stored: the race and a row per car', storedRace?.week === rules.id && storedRace.kind === 'open' && stored.results.length === 2 && stored.results[1].dnf === 1 && stored.results[0].time_s === laps * 80 + 5, JSON.stringify(stored.results));
  check('a name is credited only when its driver key proved it', stored.results[0].name_key === 'al' && stored.results[1].name_key === null && stored.results[1].name === 'Bea');
  await revived.alarm();
  check('a second alarm stores nothing twice', ((await db.prepare('SELECT COUNT(*) AS n FROM race_cars').first<{ n: number }>())?.n ?? 0) === 2 && results(bea).filter((r) => r.final).length === 1);
  server = revived;

  // Getting back in
  const back = await join_('peer_al', token('a'));
  check('a car on the grid gets back in on a new socket, and hears the race', back.sent[0].t === 'welcome' && lobbyOf(back)?.race?.id === start?.id && al.closed === 4001);
  check('and the result as it stands', results(back).some((r) => r.final));
  check('with the wrong token it does not', (await join_('peer_bea', token('q'))).last()?.t === 'taken');
  // A car whose socket dropped: out of the lobby, then back in it under its own name when it reconnects
  bea.closing = true;
  await server.webSocketClose(bea, 1006);
  bea.closing = false;
  check('a car whose socket dropped leaves the lobby', !lobbyOf(back)?.players.some((p) => p.peerId === 'peer_bea'));
  const beaBack = await join_('peer_bea', token('b'));
  check(
    'back on a new socket it is in everyone\'s lobby again, under the name it raced with',
    lobbyOf(back)?.players.find((p) => p.peerId === 'peer_bea')?.name === 'Bea' && lobbyOf(beaBack)?.players.some((p) => p.peerId === 'peer_bea') === true,
    JSON.stringify(lobbyOf(back)?.players.map((p) => p.name)),
  );
  check('nobody joins a race under way', (await join_('peer_new', token('n'), 'New')).last()?.t === 'started');

  // The end
  nowMs = slot.startsMs + (rules.race.laps * 4 + 10) * 60_000;
  await server.alarm();
  check('long after the race the room closes and forgets everything', state.sockets.every((s) => s.closed !== null) && state.store.size === 0 && state.alarmMs === null);

  // Nobody came
  const empty = fakeState();
  const quiet = new RaceServer(empty, {} as Env, () => nowMs);
  nowMs = slot.startsMs - 60_000;
  const lone = new FakeSocket();
  await quiet.connect(lone, 'peer_lone', token('l'), slot);
  await quiet.webSocketClose(lone, 1001);
  lone.close();
  nowMs = slot.startsMs - RACE_COUNTDOWN_MS;
  await quiet.alarm();
  check('a race nobody is in at the alarm just closes', empty.store.size === 0);

  // Full
  const packed = fakeState();
  const busy = new RaceServer(packed, {} as Env, () => slot.startsMs - 60_000);
  for (let i = 0; i < MAX_RACERS; i++) await busy.connect(new FakeSocket(), `peer_${i}`, token('p'), slot);
  const extra = new FakeSocket();
  await busy.connect(extra, 'peer_extra', token('p'), slot);
  check(`entrant ${MAX_RACERS + 1} is told the race is full`, extra.last()?.t === 'full');

  // Through the API
  let routed = '';
  const races = { idFromName: (name: string) => ({ toString: () => name }), get: (id: { toString(): string }) => ({ fetch: async (r: Request) => ((routed = `${id.toString()} ${new URL(r.url).search}`), new Response('race')) }) };
  const live = { ONLINE_RACES: 'on', RACES: races } as unknown as Env;
  const api = (path: string, e: Env) => {
    const url = new URL(`https://librecorsa.org${path}`);
    return handleApi(new Request(url), e, url);
  };
  check('config: races on with the switch and the binding, every 20 minutes', onlineConfig(live).races && onlineConfig(live).raceSlotS === 1200 && !onlineConfig({ ...live, ONLINE_RACES: 'off' }).races);
  check('config: the slot length can be set, within reason', raceSlotSeconds({ RACE_SLOT_S: '60' } as Env) === 60 && raceSlotSeconds({ RACE_SLOT_S: '1' } as Env) === 1200);
  const next = await api('/api/races/next?peer=peer_x&token=aaaaaaaaaaaaaaaa&slot=1&slotS=1', live);
  const wanted = nextRaceSlot(Date.now(), 1200).index;
  check('GET /api/races/next goes to the next race by the server\'s clock, whatever the caller says', (await next.text()) === 'race' && routed.startsWith(`race-1200-${wanted} `) && routed.includes(`slot=${wanted}`) && routed.includes('slotS=1200'), routed);
  check('a race far in the past or the future is not found', (await api('/api/races/5', live)).status === 404 && (await api(`/api/races/${wanted + 50}`, live)).status === 404);
  check('races switched off: no race socket', (await api('/api/races/next', { ...live, ONLINE_RACES: 'off' })).status === 404);

  // A race everyone finishes: final at the last finish, no wait
  {
    const st = fakeState();
    let t = slot.startsMs - 60_000;
    const srv = new RaceServer(st, { BOARD_DB: db } as unknown as Env, () => t);
    const a = new FakeSocket();
    const b = new FakeSocket();
    const slot2 = raceSlot(slot.index + 1, SLOT_S);
    t = slot2.startsMs - 20_000;
    await srv.connect(a, 'peer_x', token('x'), slot2);
    await srv.connect(b, 'peer_y', token('y'), slot2);
    for (const [ws, peer, name] of [[a, 'peer_x', 'Xan'], [b, 'peer_y', 'Yul']] as const) {
      await srv.webSocketMessage(ws, JSON.stringify({ ctl: { type: 'hello', name, code: name.toUpperCase(), color: '#00FF00' }, from: peer }));
    }
    t = slot2.startsMs - RACE_COUNTDOWN_MS;
    await srv.alarm();
    const s0 = startOf(a);
    t = (s0?.lightsStartHostMs ?? 0) + 5000 + (s0?.holdMs ?? 0) + (laps * 90 + 10) * 1000;
    for (const [ws, peer, time] of [[a, 'peer_x', laps * 90], [b, 'peer_y', laps * 85]] as const) {
      await srv.webSocketMessage(ws, JSON.stringify(packet(peer)));
      await srv.webSocketMessage(ws, JSON.stringify({ ctl: { type: 'finish', id: s0?.id, timeS: time, penaltyS: 0, laps, bestLapMs: null }, from: peer }));
    }
    const last = results(a)[results(a).length - 1];
    check('everyone in: the result is final at once, and stored', last?.final === true && last.rows[0].peer === 'peer_y' && (st.alarmMs ?? 0) > t + 90_000, JSON.stringify(last));
  }

  // The results routes
  const withDb = { ...live, BOARD_DB: db } as unknown as Env;
  const weekRes = await api(`/api/races/results?week=${rules.id}`, withDb);
  const week = (await weekRes.json()) as { races: { podium: { name: string; position: number }[] }[]; standings: { name: string; starts: number; wins: number; podiums: number }[] };
  check('GET /api/races/results: the week\'s latest races with their podium, never cached', weekRes.status === 200 && weekRes.headers.get('Cache-Control') === 'no-store' && week.races.length === 2 && week.races.some((r) => r.podium[0]?.name === 'Al'), JSON.stringify(week.races));
  check('and the standings of proven drivers only', week.standings.length === 1 && week.standings[0].name === 'Al' && week.standings[0].wins === 1 && week.standings[0].podiums === 1 && week.standings[0].starts === 1, JSON.stringify(week.standings));
  const rec = (await (await api('/api/drivers/record?name=%20AL%20', withDb)).json()) as { starts: number; wins: number; podiums: number; bestFinish: number | null; name: string };
  check('GET /api/drivers/record: starts, wins, podiums and best finish, by the name\'s claim', rec.name === 'Al' && rec.starts === 1 && rec.wins === 1 && rec.podiums === 1 && rec.bestFinish === 1, JSON.stringify(rec));
  const parsedWeek = parseWeekRaceResults(week);
  const parsedRec = parseDriverRecord(rec);
  check("the game's client reads both answers", parsedWeek?.standings[0]?.name === 'Al' && parsedWeek.races.length === 2 && parsedRec?.wins === 1 && parsedRec.bestFinish === 1 && parseWeekRaceResults({ races: 'x' }) === null);
  const none = (await (await api('/api/drivers/record?name=Bea', withDb)).json()) as { starts: number; bestFinish: number | null };
  check('an unproven name has no record', none.starts === 0 && none.bestFinish === null, JSON.stringify(none));
  check('a bad week or no name is refused; without races or the database, no results', (await api('/api/races/results?week=x', withDb)).status === 400 && (await api('/api/drivers/record', withDb)).status === 400 && (await api(`/api/races/results?week=${rules.id}`, live)).status === 404 && (await api(`/api/races/results?week=${rules.id}`, { ...withDb, ONLINE_RACES: 'off' })).status === 404);

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll race server checks passed');
}

void main();
