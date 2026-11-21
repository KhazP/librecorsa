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
import { sanitizeControl, sanitizeLobby, sanitizeLobbySettings, sanitizeStart, withLobbyDefaults } from '../src/lib/net/wire';

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

  // Backwards-compatible LobbySettings & RaceStartInfo sanitization
  {
    const legacyLobby = sanitizeLobby({
      hostId: 'peer_h',
      settings: { trackId: 'monza', laps: 4, collisions: 'on', carClass: 'gt3' },
      players: [{ peerId: 'peer_h', name: 'Host', code: 'HST', color: '#ffffff', ready: true, isHost: true }],
      race: null,
    });
    const defaulted = legacyLobby ? withLobbyDefaults(legacyLobby.settings) : null;
    check(
      'legacy lobby without new SP fields sanitizes with safe defaults',
      defaulted !== null &&
        defaulted.startType === 'standing' &&
        defaulted.manualStart === false &&
        defaulted.gridOrder === 'qualifying' &&
        defaulted.qualifyingMinutes === 0 &&
        defaulted.rules.preset === 'classic' &&
        defaulted.rules.damage === 'off',
    );
    const fullSettings = sanitizeLobbySettings(
      {
        trackId: 'spa',
        laps: 8,
        collisions: 'ghost_lap1',
        carClass: 'f1',
        weather: 'dynamic',
        timeOfDay: 'night',
        timeScale: 15,
        startType: 'rolling',
        manualStart: true,
        gridOrder: 'reverse',
        rules: { preset: 'open_wheel', trackLimits: 'auto', penalties: false, damage: 'full' },
        qualifyingMinutes: 5,
      },
      'private',
    );
    check(
      'private room LobbySettings keeps weather, night, rolling, rules, and qualifying',
      fullSettings.weather === 'dynamic' &&
        fullSettings.timeOfDay === 'night' &&
        fullSettings.timeScale === 15 &&
        fullSettings.startType === 'rolling' &&
        fullSettings.manualStart === true &&
        fullSettings.gridOrder === 'reverse' &&
        fullSettings.rules?.preset === 'open_wheel' &&
        fullSettings.rules?.penalties === false &&
        fullSettings.rules?.damage === 'full' &&
        fullSettings.qualifyingMinutes === 5,
    );
    const pubSettings = sanitizeLobbySettings({ ...fullSettings, qualifyingMinutes: 10 }, 'public');
    check('sanitizeLobbySettings forces qualifyingMinutes = 0 on public rooms', pubSettings.qualifyingMinutes === 0);
    const sanitizedStart = sanitizeStart({
      id: 'r99',
      lightsStartHostMs: 1000,
      holdMs: 0,
      laps: 5,
      collisions: 'on',
      carClass: 'any',
      trackId: 'spa',
      grid: ['p1', 'p2'],
      weather: 'light_rain',
      timeOfDay: 'night',
      timeScale: 5,
      startType: 'rolling',
      manualStart: false,
      gridOrder: 'qualifying',
      rules: { preset: 'endurance_sprint', trackLimits: 'off', penalties: true, damage: 'reduced' },
      qualifying: [
        { peer: 'p1', ms: 88_400 },
        { peer: 'p2', ms: null },
      ],
    });
    check(
      'sanitizeStart preserves new SP settings and qualifying rows',
      sanitizedStart !== null &&
        sanitizedStart.timeOfDay === 'night' &&
        sanitizedStart.startType === 'rolling' &&
        sanitizedStart.rules?.damage === 'reduced' &&
        sanitizedStart.qualifying?.length === 2 &&
        sanitizedStart.qualifying[0].ms === 88_400 &&
        sanitizedStart.qualifying[1].ms === null,
    );
  }

  // Public room: server-side qualifying rejection
  {
    let clockMs = 1_000_000;
    const pubState = fakeState();
    const pubRoom = new RoomServer(pubState, env, async () => ICE, () => clockMs);
    const pubHost = new FakeSocket();
    const pubGuest = new FakeSocket();
    await pubRoom.connect('host', TOKEN_A, pubHost, 'public');
    await pubRoom.connect('guest', '', pubGuest);
    await pubRoom.webSocketMessage(pubHost, JSON.stringify({ t: 'join', peerId: 'peer_pub_h' }));
    await pubRoom.webSocketMessage(pubGuest, JSON.stringify({ t: 'join', peerId: 'peer_pub_g' }));
    await pubRoom.webSocketMessage(pubHost, JSON.stringify({ t: 'settings', settings: { qualifyingMinutes: 5, timeOfDay: 'night' } }));
    const errMsg = pubHost.sent.find((m) => m.t === 'error');
    const stAfter = await pubRoom.getRoomState();
    check(
      'public room rejects qualifyingMinutes > 0 and enforces qualifyingMinutes = 0',
      errMsg?.code === 'qualifying_private_only' && stAfter.settings.qualifyingMinutes === 0 && stAfter.settings.timeOfDay === 'night',
    );
    await pubRoom.webSocketMessage(pubHost, JSON.stringify({ t: 'start_qualifying' }));
    const stQualiTry = await pubRoom.getRoomState();
    check(
      'public room refuses start_qualifying and stays in lobby',
      pubHost.last()?.t === 'error' && pubHost.last()?.code === 'qualifying_private_only' && stQualiTry.phase === 'lobby',
    );
    await pubRoom.webSocketMessage(pubHost, JSON.stringify({ t: 'start_session' }));
    const stStart = await pubRoom.getRoomState();
    check('public room start_session skips qualifying and goes straight to racing', stStart.phase === 'racing' && pubState.alarmMs === null);
  }

  // Private room Qualifying: timer expiration via DO alarm + grid sorting (valid ascending, no-lap behind)
  {
    let clockMs = 2_000_000;
    const qState = fakeState();
    const qRoom = new RoomServer(qState, env, async () => ICE, () => clockMs);
    const h = new FakeSocket();
    const p1 = new FakeSocket();
    const p2 = new FakeSocket();
    const p3 = new FakeSocket();
    await qRoom.connect('host', TOKEN_A, h, 'private');
    await qRoom.connect('guest', '', p1);
    await qRoom.connect('guest', '', p2);
    await qRoom.connect('guest', '', p3);
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'join', peerId: 'peer_host' }));
    await qRoom.webSocketMessage(p1, JSON.stringify({ t: 'join', peerId: 'peer_g1' }));
    await qRoom.webSocketMessage(p2, JSON.stringify({ t: 'join', peerId: 'peer_g2' }));
    await qRoom.webSocketMessage(p3, JSON.stringify({ t: 'join', peerId: 'peer_g3' }));

    // Guest cannot change settings or start qualifying
    await qRoom.webSocketMessage(p1, JSON.stringify({ t: 'settings', settings: { qualifyingMinutes: 10, laps: 99 } }));
    await qRoom.webSocketMessage(p1, JSON.stringify({ t: 'start_session' }));
    check('guest cannot modify room settings or start session', (await qRoom.getRoomState()).phase === 'lobby' && (await qRoom.getRoomState()).settings.laps === 5);

    // Host configures private room with 3 min qualifying + SP features and starts session
    await qRoom.webSocketMessage(
      h,
      JSON.stringify({
        t: 'settings',
        settings: {
          laps: 6,
          weather: 'light_rain',
          timeOfDay: 'night',
          timeScale: 5,
          startType: 'standing',
          manualStart: true,
          gridOrder: 'qualifying',
          rules: { preset: 'open_wheel', trackLimits: 'auto', penalties: true, damage: 'reduced' },
          qualifyingMinutes: 3,
        },
      }),
    );
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'start_session' }));
    const qRunning = await qRoom.getRoomState();
    const expectedEnd = clockMs + 3 * 60_000;
    check(
      'private room transitions to qualifying with qualifyingEndsAt and DO alarm',
      qRunning.phase === 'qualifying' &&
        qRunning.qualifyingEndsAt === expectedEnd &&
        qState.alarmMs === expectedEnd &&
        h.last()?.t === 'phase' &&
        h.last()?.phase === 'qualifying' &&
        p1.last()?.phase === 'qualifying',
    );

    const sessionId = qRunning.sessionId!;
    // Peers report valid bestLapMs via PeerRaceProgress and lap messages
    await qRoom.webSocketMessage(p2, JSON.stringify({ t: 'progress', race: { id: sessionId, dist: 4200, fin: null, best: 91_500 } }));
    await qRoom.webSocketMessage(p2, JSON.stringify({ t: 'progress', race: { id: sessionId, dist: 8400, fin: null, best: 89_200 } }));
    await qRoom.webSocketMessage(p2, JSON.stringify({ t: 'progress', race: { id: sessionId, dist: 12600, fin: null, best: 92_000 } })); // slower, ignored
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'progress', race: { id: sessionId, dist: 4200, fin: null, best: 90_100 } }));
    await qRoom.webSocketMessage(p3, JSON.stringify({ t: 'lap', sessionId, bestLapMs: 88_400 }));
    await qRoom.webSocketMessage(p1, JSON.stringify({ t: 'progress', race: { id: sessionId, dist: 4200, fin: null, best: null } })); // no valid lap
    await qRoom.webSocketMessage(p1, JSON.stringify({ t: 'lap', sessionId, bestLapMs: 500 })); // implausibly short, ignored
    await qRoom.webSocketMessage(p1, JSON.stringify({ t: 'progress', race: { id: 'wrong_id', dist: 4200, fin: null, best: 70_000 } })); // wrong session, ignored

    // Timer expires -> DO alarm fires
    clockMs = expectedEnd;
    await qRoom.alarm();
    const raced = await qRoom.getRoomState();
    const phaseMsg = p3.last();
    check(
      'qualifying timer expiry sorts race grid by valid bestLapMs ascending, no-lap behind',
      raced.phase === 'racing' &&
        qState.alarmMs === null &&
        raced.grid.join(',') === 'peer_g3,peer_g2,peer_host,peer_g1' &&
        phaseMsg?.t === 'phase' &&
        phaseMsg?.phase === 'racing' &&
        (phaseMsg?.grid as string[]).join(',') === 'peer_g3,peer_g2,peer_host,peer_g1',
      raced.grid.join(','),
    );
    check(
      'qualifying keeps fastest valid lap per driver and null for no-lap driver',
      raced.qualifying.map((x) => `${x.peer}:${x.ms}`).join(',') === 'peer_g3:88400,peer_g2:89200,peer_host:90100,peer_g1:null',
      raced.qualifying.map((x) => `${x.peer}:${x.ms}`).join(','),
    );

    // Host early-start during qualifying
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'abort' }));
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'settings', settings: { qualifyingMinutes: 5 } }));
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'start_session' }));
    const q2 = await qRoom.getRoomState();
    await qRoom.webSocketMessage(p1, JSON.stringify({ t: 'lap', sessionId: q2.sessionId, bestLapMs: 87_000 }));
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'lap', sessionId: q2.sessionId, bestLapMs: 89_500 }));
    // Host clicks "Start Race" early (before timer expires)
    clockMs += 30_000;
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'start_race' }));
    const earlyRace = await qRoom.getRoomState();
    check(
      'host early Start Race during qualifying sorts grid by laps set so far and clears alarm',
      earlyRace.phase === 'racing' &&
        qState.alarmMs === null &&
        earlyRace.grid.join(',') === 'peer_g1,peer_host,peer_g2,peer_g3',
      earlyRace.grid.join(','),
    );

    // Direct race gridOrder = reverse (no qualifying)
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'abort' }));
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'settings', settings: { qualifyingMinutes: 0, gridOrder: 'reverse' } }));
    await qRoom.webSocketMessage(h, JSON.stringify({ t: 'start_session' }));
    const revRace = await qRoom.getRoomState();
    check(
      'direct race with gridOrder reverse reverses participant order',
      revRace.phase === 'racing' && revRace.grid.join(',') === 'peer_g3,peer_g2,peer_g1,peer_host',
      revRace.grid.join(','),
    );
  }

  // Security hardening: peerId ownership, 10s lap floor, connected-only activeParticipants, and host disconnect cleanup
  {
    let clockMs = 3_000_000;
    const sState = fakeState();
    const sRoom = new RoomServer(sState, env, async () => ICE, () => clockMs);
    const h = new FakeSocket();
    const victim = new FakeSocket();
    const impostor = new FakeSocket();
    await sRoom.connect('host', TOKEN_A, h, 'private');
    await sRoom.connect('guest', '', victim);
    await sRoom.connect('guest', '', impostor);
    const impostorConnId = impostor.last()?.id as string;

    await sRoom.webSocketMessage(h, JSON.stringify({ t: 'join', peerId: 'peer_h' }));
    await sRoom.webSocketMessage(victim, JSON.stringify({ t: 'join', peerId: 'peer_victim' }));

    // Guest cannot hijack an open socket's peerId or claim default "host"
    await sRoom.webSocketMessage(impostor, JSON.stringify({ t: 'join', peerId: 'peer_victim' }));
    const takenVictim = impostor.last();
    await sRoom.webSocketMessage(impostor, JSON.stringify({ t: 'join', peerId: 'peer_h' }));
    const takenHost = impostor.last();
    await sRoom.webSocketMessage(impostor, JSON.stringify({ t: 'join', peerId: 'host' }));
    const takenDefaultHost = impostor.last();
    check(
      'guest join cannot hijack an existing open socket peerId or default host id',
      takenVictim?.t === 'error' &&
        takenVictim?.code === 'peer_id_taken' &&
        takenHost?.code === 'peer_id_taken' &&
        takenDefaultHost?.code === 'peer_id_taken',
    );

    // Once bound, a socket cannot change its peerId mid-connection (idempotent re-send is ok)
    await sRoom.webSocketMessage(victim, JSON.stringify({ t: 'join', peerId: 'peer_victim' }));
    const sentAfterIdem = victim.sent.length;
    await sRoom.webSocketMessage(victim, JSON.stringify({ t: 'join', peerId: 'peer_renamed' }));
    check(
      'bound socket cannot switch peerId mid-connection',
      victim.sent.length === sentAfterIdem + 1 && victim.last()?.t === 'error' && victim.last()?.code === 'peer_id_locked',
    );

    // Start qualifying with host-supplied peers containing a bogus disconnected peer -> filtered to connected sockets only
    await sRoom.webSocketMessage(h, JSON.stringify({ t: 'settings', settings: { qualifyingMinutes: 3 } }));
    await sRoom.webSocketMessage(
      h,
      JSON.stringify({ t: 'start_session', peers: ['peer_victim', 'ghost_offline_peer', 'peer_h'] }),
    );
    const qState = await sRoom.getRoomState();
    check(
      'activeParticipants filters host-supplied peers to connected sockets only',
      qState.participants.join(',') === 'peer_victim,peer_h' && !qState.participants.includes('ghost_offline_peer'),
      qState.participants.join(','),
    );

    // Impostor submits lap (still under its own connection id, NOT victim) and sub-10s laps are rejected
    const sid = qState.sessionId!;
    await sRoom.webSocketMessage(victim, JSON.stringify({ t: 'lap', sessionId: sid, bestLapMs: 85_000 }));
    await sRoom.webSocketMessage(impostor, JSON.stringify({ t: 'lap', sessionId: sid, bestLapMs: 60_000 }));
    await sRoom.webSocketMessage(victim, JSON.stringify({ t: 'lap', sessionId: sid, bestLapMs: 9_999 }));
    await sRoom.webSocketMessage(
      victim,
      JSON.stringify({ t: 'progress', race: { id: sid, dist: 2000, fin: null, best: 1_000 } }),
    );
    const afterLaps = await sRoom.getRoomState();
    check(
      'qualifying enforces >= 10s lap floor and isolates impostor laps from victim',
      afterLaps.qualifyingLaps['peer_victim'] === 85_000 && afterLaps.qualifyingLaps[impostorConnId] === 60_000,
      JSON.stringify(afterLaps.qualifyingLaps),
    );

    // Closing impostor does NOT evict victim; closing host removes host from participants
    await sRoom.webSocketClose(impostor, 1001);
    const afterImpostorClose = await sRoom.getRoomState();
    await sRoom.webSocketClose(h, 1001);
    const afterHostClose = await sRoom.getRoomState();
    check(
      'impostor disconnect leaves victim in participants, and host disconnect removes host',
      afterImpostorClose.participants.includes('peer_victim') &&
        !afterImpostorClose.participants.includes(impostorConnId) &&
        !afterHostClose.participants.includes('peer_h') &&
        afterHostClose.participants.includes('peer_victim'),
      `afterImpostor=${afterImpostorClose.participants.join(',')} afterHost=${afterHostClose.participants.join(',')}`,
    );

    // Regression (#11b): fresh host taking over a code evicts lingering guests from the prior room, and `lap` requires sessionId
    const hNew = new FakeSocket();
    await sRoom.connect('host', TOKEN_B, hNew, 'private');
    await sRoom.webSocketMessage(hNew, JSON.stringify({ t: 'join', peerId: 'peer_new_host' }));
    await sRoom.webSocketMessage(hNew, JSON.stringify({ t: 'settings', settings: { qualifyingMinutes: 3 } }));
    await sRoom.webSocketMessage(hNew, JSON.stringify({ t: 'start_session' }));
    const newQ = await sRoom.getRoomState();
    // Missing sessionId on `lap` is rejected even from the active host
    await sRoom.webSocketMessage(hNew, JSON.stringify({ t: 'lap', bestLapMs: 75_000 }));
    const afterNoSid = await sRoom.getRoomState();
    check(
      'freshHost evicts prior room guests and `lap` requires matching sessionId',
      victim.closed === 4001 &&
        !newQ.participants.includes('peer_victim') &&
        afterNoSid.qualifyingLaps['peer_new_host'] === undefined,
      `victimClosed=${victim.closed}, parts=${newQ.participants.join(',')}`,
    );

    // Regression (#11c): same host reconnecting while old socket is still closing does NOT hit peer_id_taken
    const hReconnect = new FakeSocket();
    await sRoom.connect('host', TOKEN_B, hReconnect, 'private');
    await sRoom.webSocketMessage(hReconnect, JSON.stringify({ t: 'join', peerId: 'peer_new_host' }));
    check(
      'host reconnect demotes replaced socket before close so join succeeds without peer_id_taken',
      hNew.closed === 4001 && !hReconnect.sent.some((m) => m.t === 'error' && m.code === 'peer_id_taken'),
    );

    // Regression (#7): wire sanitizers enforce the shared 10 s qualifying lap floor
    const badCtl = sanitizeControl({ type: 'quali_lap', id: 'q1', bestLapMs: 9_999 });
    const goodCtl = sanitizeControl({ type: 'quali_lap', id: 'q1', bestLapMs: 10_000 });
    const startWithShort = sanitizeStart({
      id: 'r100',
      lightsStartHostMs: 1000,
      holdMs: 0,
      laps: 3,
      collisions: 'on',
      carClass: 'any',
      trackId: 'spa',
      grid: ['p1', 'p2'],
      qualifying: [
        { peer: 'p1', ms: 5_000 },
        { peer: 'p2', ms: 85_000 },
      ],
    });
    check(
      'wire sanitizers share the 10 s qualifying lap floor (sub-floor becomes null in qualifying table)',
      badCtl === null &&
        goodCtl?.type === 'quali_lap' &&
        goodCtl.bestLapMs === 10_000 &&
        startWithShort?.qualifying?.length === 2 &&
        startWithShort.qualifying[0].ms === null &&
        startWithShort.qualifying[1].ms === 85_000,
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll room server checks passed');
}

void main();
