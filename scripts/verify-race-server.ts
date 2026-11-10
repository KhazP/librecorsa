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
import { sanitizeControl, type LobbyState, type RaceStartInfo } from '../src/lib/net/wire';
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
  check('schedule: a race is run to the rules of its week', rules.trackId.length > 0 && rules.raceLaps >= 1 && rules.startsMs <= slot.startsMs && slot.startsMs < rules.endsMs);
  check('schedule: the countdown reads minutes and seconds', countdownLabel(slot.startsMs, slot.startsMs - 754_000) === '12:34' && countdownLabel(slot.startsMs, slot.startsMs + 5000) === '0:00');

  const state = fakeState();
  // The week's challenge times: Bea has one, so she starts ahead of Al, who joined first
  const db = fakeD1(readFileSync(join(__dirname, '../cloudflare/migrations/0001_lap_boards.sql'), 'utf8'));
  await db
    .prepare("INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES ('x', ?, ?, 2, ?, 'pro', 'full', 'dry', 'soft', 'bea', 'Bea', 'BEA', 90000, 1, 1, 1, 1, 1)")
    .bind(rules.trackId, rules.vehicle, rules.id)
    .run();
  const server = new RaceServer(state, { BOARD_DB: db } as unknown as Env, () => nowMs);
  const join_ = async (peer: string, tok: string, name?: string) => {
    const ws = new FakeSocket();
    await server.connect(ws, peer, tok, slot);
    if (name && ws.closed === null) {
      await server.webSocketMessage(ws, JSON.stringify({ ctl: { type: 'hello', name, code: name.slice(0, 3), color: '#00FF00', vehicle: rules.vehicle }, from: peer }));
    }
    return ws;
  };

  const al = await join_('peer_al', token('a'), 'Al');
  check('an entrant is welcomed with the start time, then the lobby', al.sent[0].t === 'welcome' && al.sent[0].startsMs === slot.startsMs && sanitizeControl(al.sent[1].ctl)?.type === 'lobby' && al.sent[1].from === RACE_SERVER_ID);
  check('the grid alarm is set for shortly before the lights', state.alarmMs === slot.startsMs - RACE_COUNTDOWN_MS);
  const lobby = lobbyOf(al);
  check('the lobby names the server as host and the week\'s circuit, car and laps', lobby?.hostId === RACE_SERVER_ID && lobby.settings.trackId === rules.trackId && lobby.settings.vehicle === rules.vehicle && lobby.settings.laps === rules.raceLaps && lobby.race === null);
  check('an entrant is in the lobby once it has said hello', lobby?.players.length === 1 && lobby.players[0].name === 'Al' && lobby.players[0].isHost === false);

  nowMs += 1000;
  const bea = await join_('peer_bea', token('b'), 'Bea');
  check('everyone sees a new entrant', lobbyOf(al)?.players.length === 2 && lobbyOf(bea)?.players.length === 2);
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

  // The grid
  nowMs = slot.startsMs - RACE_COUNTDOWN_MS;
  await server.webSocketMessage(al, JSON.stringify({ ctl: { type: 'ping', t0: 9 }, from: 'peer_al' }));
  await server.webSocketMessage(bea, JSON.stringify({ ctl: { type: 'ping', t0: 9 }, from: 'peer_bea' }));
  await server.alarm();
  const start = startOf(al);
  check('at the alarm everyone gets the same start', start !== undefined && JSON.stringify(start) === JSON.stringify(startOf(bea)));
  check('the lights are on the server\'s clock at the slot time', start?.lightsStartHostMs === slot.startsMs && start.trackId === rules.trackId && start.vehicle === rules.vehicle && start.laps === rules.raceLaps);
  check('the grid: this week\'s fastest first, then the order they joined; no one who never said hello', start?.grid.join() === 'peer_bea,peer_al', start?.grid.join());
  check('every lobby from now on carries the race', lobbyOf(al)?.race?.id === start?.id);
  check('the room is set to close well after the race', (state.alarmMs ?? 0) > slot.startsMs + rules.raceLaps * 60_000);
  void dee;

  // The race: state is passed on, cleaned, to the others
  bea.sent.length = 0;
  await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { extra: 'x', quat: [0, 0, 0, 2] })));
  const relayed = states(bea)[0];
  check("a car's state reaches the others, cleaned", relayed?.peerId === 'peer_al' && relayed.extra === undefined && (relayed.quat as number[])[3] === 1);
  check('and never comes back to its sender', states(al).length === 0);
  await server.webSocketMessage(al, JSON.stringify(packet('peer_bea')));
  await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { pos: [1, 2, Infinity] })));
  await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { pos: [1e9, 0, 0] })));
  check("another car's state, or an impossible one, is dropped", states(bea).length === 1);
  for (let i = 0; i < 200; i++) await server.webSocketMessage(al, JSON.stringify(packet('peer_al', { seq: i })));
  check('a flooding car is cut off', states(bea).length <= 61, `${states(bea).length} passed of 201`);

  // Getting back in
  const back = await join_('peer_al', token('a'));
  check('a car on the grid gets back in on a new socket, and hears the race', back.sent[0].t === 'welcome' && lobbyOf(back)?.race?.id === start?.id && al.closed === 4001);
  check('with the wrong token it does not', (await join_('peer_bea', token('q'))).last()?.t === 'taken');
  check('nobody joins a race under way', (await join_('peer_new', token('n'), 'New')).last()?.t === 'started');

  // The end
  nowMs = slot.startsMs + (rules.raceLaps * 4 + 10) * 60_000;
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

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll race server checks passed');
}

void main();
