/**
 * Headless checks of the room server (cloudflare/api/room.ts): it pairs a room code's host with its guests, passes
 * their connection offers between them and nobody else, and says at once when a code has no host, is taken or full.
 * Also: the API's switches and origin rules (cloudflare/api/index.ts).
 *
 *   npx tsx scripts/verify-room-server.ts
 *
 * The Durable Object's state and sockets are stood in for by plain objects.
 */
import { handleApi, onlineConfig } from '../cloudflare/api/index';
import { MAX_GUESTS, RoomServer } from '../cloudflare/api/room';
import { cleanIceServers, generateIceServers } from '../cloudflare/api/turn';
import type { Env } from '../cloudflare/api/types';
import { FakeSocket, fakeState } from './lib/fake-cloudflare';
import { parseApiBase, parseOnlineConfig } from '../src/lib/net/online-config';
import { sanitizeIceServers } from '../src/lib/sim/multiplayer-sync';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};

// The two globals the room server takes from the Workers runtime
Object.assign(globalThis, {
  WebSocketRequestResponsePair: class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  },
});

const ICE = [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' }];
const env = {} as Env;

async function main() {
  const state = fakeState();
  const room = new RoomServer(state, env, async () => ICE);
  const TOKEN_A = 'aaaaaaaaaaaaaaaa';
  const TOKEN_B = 'bbbbbbbbbbbbbbbb';

  // A guest before any host
  const early = new FakeSocket();
  await room.connect('guest', '', early);
  check('a guest of a code nobody hosts is told so and closed', early.last()?.t === 'nohost' && early.closed !== null);

  // The host opens the room
  const host = new FakeSocket();
  await room.connect('host', TOKEN_A, host);
  check('the host is welcomed with the connection servers', host.last()?.t === 'welcome' && JSON.stringify(host.last()?.iceServers) === JSON.stringify(ICE));

  // Another device asks for the same code
  const thief = new FakeSocket();
  await room.connect('host', TOKEN_B, thief);
  check('another device asking for a code in use is told it is taken', thief.last()?.t === 'taken' && thief.closed !== null && host.closed === null);

  // Two guests
  const g1 = new FakeSocket();
  const g2 = new FakeSocket();
  await room.connect('guest', '', g1);
  await room.connect('guest', '', g2);
  const id1 = g1.last()?.id as string;
  const id2 = g2.last()?.id as string;
  check('guests are welcomed with their own ids', g1.last()?.t === 'welcome' && /^[a-f0-9]{12}$/.test(id1) && id1 !== id2);
  check('guests get the connection servers too', JSON.stringify(g1.last()?.iceServers) === JSON.stringify(ICE));

  // Offer, answer
  await room.webSocketMessage(g1, JSON.stringify({ t: 'signal', data: { sdp: { type: 'offer', sdp: 'o1' } } }));
  const offer = host.last();
  check("a guest's offer reaches the host under the guest's id", offer?.t === 'signal' && offer.from === id1 && JSON.stringify(offer.data) === '{"sdp":{"type":"offer","sdp":"o1"}}');
  check("a guest's offer reaches no other guest", g2.sent.length === 1);
  await room.webSocketMessage(host, JSON.stringify({ t: 'signal', to: id1, data: { sdp: { type: 'answer', sdp: 'a1' } } }));
  check("the host's answer reaches that guest only", g1.last()?.t === 'signal' && g1.last()?.from === undefined && g2.sent.length === 1);

  // A guest can't address anyone, or speak as the host
  const hostCount = host.sent.length;
  await room.webSocketMessage(g2, JSON.stringify({ t: 'signal', to: id1, from: id1, data: { candidate: {} } }));
  check("a guest's message goes to the host only, under its own id", g1.sent.length === 2 && host.sent.length === hostCount + 1 && host.last()?.from === id2);

  // Junk is dropped
  const before = host.sent.length;
  await room.webSocketMessage(g1, 'not json');
  await room.webSocketMessage(g1, JSON.stringify({ t: 'lobby', data: {} }));
  await room.webSocketMessage(g1, JSON.stringify({ t: 'signal', data: 'x' }));
  await room.webSocketMessage(g1, JSON.stringify({ t: 'signal', data: { sdp: 'x'.repeat(40000) } }));
  await room.webSocketMessage(host, JSON.stringify({ t: 'signal', to: 'nobody', data: {} }));
  check('malformed, unknown and oversized messages are dropped', host.sent.length === before && g1.sent.length === 2);

  // Flood
  for (let i = 0; i < 400; i++) await room.webSocketMessage(g2, JSON.stringify({ t: 'signal', data: { candidate: { i } } }));
  check('a flooding socket is cut off', host.sent.length - before <= 200, `${host.sent.length - before} passed of 400`);

  // A guest leaves
  await room.webSocketClose(g1, 1001);
  check('the host hears a guest leave', host.last()?.t === 'left' && host.last()?.id === id1);

  // The same host comes back on a new socket
  const hostAgain = new FakeSocket();
  await room.connect('host', TOKEN_A, hostAgain);
  check('the same host takes its room back; its old socket goes', hostAgain.last()?.t === 'welcome' && host.closed === 4001);
  await room.webSocketMessage(g2, JSON.stringify({ t: 'signal', data: { candidate: {} } }));

  // The host gone: the code is free for another device
  await room.webSocketClose(hostAgain, 1001);
  const next = new FakeSocket();
  await room.connect('host', TOKEN_B, next);
  check('a code whose host left can be hosted by another device', next.last()?.t === 'welcome');

  // Full
  const full = fakeState();
  const fullRoom = new RoomServer(full, env, async () => []);
  await fullRoom.connect('host', TOKEN_A, new FakeSocket());
  for (let i = 0; i < MAX_GUESTS; i++) await fullRoom.connect('guest', '', new FakeSocket());
  const extra = new FakeSocket();
  await fullRoom.connect('guest', '', extra);
  check(`guest ${MAX_GUESTS + 1} is told the room is full`, extra.last()?.t === 'full' && extra.closed !== null);

  // Connection servers
  const cleaned = cleanIceServers([
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'javascript:x'], username: 'u', credential: 'c' },
    { urls: 'http://evil.example' },
    'junk',
  ]);
  check('connection servers: only stun / turn URLs, none on port 53', cleaned.length === 2 && (cleaned[0].urls as string[]).length === 1 && (cleaned[1].urls as string[]).length === 1 && cleaned[1].username === 'u');
  check('no TURN key: no relay servers, and no request made', (await generateIceServers(env, async () => { throw new Error('called'); })).length === 0);
  const keyed = { TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' } as Env;
  let asked = '';
  const got = await generateIceServers(keyed, (async (url: string, init: RequestInit) => {
    asked = `${url} ${(init.headers as Record<string, string>).Authorization}`;
    return new Response(JSON.stringify({ iceServers: ICE }), { status: 201 });
  }) as typeof fetch);
  check('with a TURN key the servers come from Cloudflare', got.length === 1 && asked.includes('/turn/keys/k/credentials/generate-ice-servers') && asked.endsWith('Bearer t'));
  check('TURN service down: players connect directly', (await generateIceServers(keyed, (async () => new Response('no', { status: 500 })) as typeof fetch)).length === 0);
  check('the game keeps only well-formed servers from a room', sanitizeIceServers([...ICE, { urls: 'ftp://x' }, null]).length === 1 && sanitizeIceServers('x').length === 0);

  // Switches and origins
  const rooms = { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async () => new Response('room') }) };
  const live = { ONLINE_ROOMS: 'on', ROOMS: rooms } as unknown as Env;
  check('config: rooms on with the switch and the binding', onlineConfig(live).rooms && !onlineConfig(live).relay && !onlineConfig(live).board && !onlineConfig(live).races);
  check('config: the switch off turns rooms off', !onlineConfig({ ...live, ONLINE_ROOMS: 'off' }).rooms);
  check('config: relay needs the TURN key', onlineConfig({ ...live, ...keyed }).relay);
  const api = (path: string, e: Env, headers: Record<string, string> = {}) => {
    const url = new URL(`https://librecorsa.org${path}`);
    return handleApi(new Request(url, { headers }), e, url);
  };
  const cfg = await api('/api/config', live);
  check('GET /api/config answers the switches, never cached', cfg.status === 200 && cfg.headers.get('Cache-Control') === 'no-store' && (await cfg.json() as { rooms: boolean }).rooms === true);
  check('another site is refused', (await api('/api/config', live, { Origin: 'https://evil.example' })).status === 403);
  check('the site itself is allowed', (await api('/api/config', live, { Origin: 'https://librecorsa.org' })).status === 200);
  const dev = await api('/api/config', { ...live, DEV_ORIGINS: 'http://127.0.0.1:3000' }, { Origin: 'http://127.0.0.1:3000' });
  check('a development origin is allowed when listed', dev.status === 200 && dev.headers.get('Access-Control-Allow-Origin') === 'http://127.0.0.1:3000');
  check('rooms switched off: no room socket', (await api('/api/rooms/ABC123', { ...live, ONLINE_ROOMS: 'off' })).status === 404);
  check('a bad room code is refused', (await api('/api/rooms/a-b', live)).status === 400);
  check('a room code reaches its room', (await (await api('/api/rooms/abc123', live)).text()) === 'room');
  const limited = { ...live, ROOM_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
  check('too many room connections from one address are refused', (await api('/api/rooms/ABC123', limited)).status === 429);
  check('unknown paths are 404, never cached', (await api('/api/nope', live)).status === 404);

  // The game's side of the config
  check('no online side configured: no base', parseApiBase(undefined) === null && parseApiBase('') === null && parseApiBase('ftp://x') === null);
  check('online side: "/api" and full URLs, trailing slash dropped', parseApiBase('/api/') === '/api' && parseApiBase('https://x.example/api') === 'https://x.example/api');
  const parsed = parseOnlineConfig({ rooms: true, relay: 'yes', board: 1 });
  check('config from the network: only real booleans count', parsed.rooms && !parsed.relay && !parsed.board && !parseOnlineConfig(null).rooms);

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll room server checks passed');
}

void main();
