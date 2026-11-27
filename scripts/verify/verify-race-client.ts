/**
 * Headless checks of the game's side of a scheduled race (MultiplayerSyncManager on the race server): it follows the
 * server as a guest follows a host, sends its car only once the race is made, takes nobody else as host meanwhile,
 * and a network stall (the socket delivers in order, so a second of packets lands at once) doesn't throw a car's
 * history away.
 *
 *   npx tsx scripts/verify/verify-race-client.ts
 *
 * The WebSocket, the clock and the config request are stood in for.
 */
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

class FakeWebSocket {
  static OPEN = 1;
  static last: FakeWebSocket | null = null;
  readyState = 1;
  binaryType = 'blob';
  sent: (string | ArrayBuffer)[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  /** A message from the server */
  get(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** Another car's state from the server: binary, as the server passes it on */
  getState(data: ArrayBuffer): void {
    this.onmessage?.({ data });
  }
  controls(): { type: string }[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s)).filter((m) => m.ctl).map((m) => m.ctl);
  }
  /** Car states this game sent (binary) */
  states(): ArrayBuffer[] {
    return this.sent.filter((s): s is ArrayBuffer => s instanceof ArrayBuffer);
  }
}

let clock = 10_000;
process.env.NEXT_PUBLIC_ONLINE_API = 'https://librecorsa.test/api';
Object.assign(globalThis, {
  window: globalThis,
  WebSocket: FakeWebSocket,
  fetch: async () => new Response(JSON.stringify({ rooms: true, relay: false, races: true, board: true, raceSlotS: 1200 })),
  // This browser's driver key (src/lib/net/driver-key.ts)
  localStorage: { getItem: (k: string) => (k === 'bugesera.driverKey' ? DRIVER_KEY : null), setItem() {} },
});
Object.defineProperty(globalThis.performance, 'now', { value: () => clock });

const SERVER = 'race_server';
const DRIVER_KEY = 'd'.repeat(43);
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // After the environment above is in place: the config module reads it as it loads
  const { MultiplayerSyncManager } = await import('../../src/lib/sim/multiplayer-sync');
  const { encodeState, stateInfoJson, PROTOCOL_VERSION, RACE_SERVER_STATE_SEND_HZ } = await import('../../src/lib/net/wire');
  const binary = (p: Record<string, unknown>) => encodeState(p as never, stateInfoJson(p as never));
  type Internals = {
    peers: Map<string, { mapMs: number | null; snapshots: unknown[]; adaptiveDelayMs: number; jitterMs: number }>;
    hostId: string | null;
    clockSynced: boolean;
  };

  const m = new MultiplayerSyncManager();
  const inner = m as unknown as Internals;
  const me = m.localPeerId;
  m.setIdentity({ name: 'Tester', code: 'TST', color: '#00FF00' }, 'mtr-496r', 'chang');
  const local = { driverCode: 'TST', teamColorHex: '#00FF00', pos: [0, 0, 0], quat: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], steerAngle: 0, wheelRPMs: [0, 0, 0, 0], throttle: 0, brake: 0, trackS: 0, speedKmh: 0 } as Parameters<typeof m.update>[1];
  const starts: string[] = [];
  const aborts: string[] = [];
  let startRule = '';
  m.onRaceStart = (s) => {
    starts.push(s.id);
    startRule = s.collisions;
  };
  m.onRaceAbort = (id) => aborts.push(id);

  m.joinScheduledRace();
  check('joining: the entry is under way', m.inScheduledRace && m.raceStatus.state === 'joining');
  await tick();
  await tick();
  const ws = FakeWebSocket.last!;
  check(
    'the socket goes to the next race, as this car, with a secret and its version',
    /\/api\/races\/next\?peer=peer_\w+&token=[a-f0-9]{36}&v=\d+$/.test(ws.url) && ws.url.endsWith(`&v=${PROTOCOL_VERSION}`) && ws.binaryType === 'arraybuffer',
    ws.url.replace(/token=[a-f0-9]*/, 'token=…')
  );

  const startsAt = Date.now() + 60_000;
  ws.get({ t: 'welcome', now: Date.now(), startsMs: startsAt, index: 7 });
  check('welcomed: entered, with the start time', m.raceStatus.state === 'joined' && Math.abs((m.raceStatus.startsMs ?? 0) - startsAt) < 50);
  const lobby = (race: unknown, players: unknown[] = []) => ({
    ctl: { type: 'lobby', lobby: { hostId: SERVER, settings: { trackId: 'chang', laps: 5, collisions: 'ghost_lap1', carClass: 'any', vehicle: 'mtr-496r' }, players, race, proto: PROTOCOL_VERSION } },
    from: SERVER,
  });
  ws.get(lobby(null));
  check('the lobby makes the server the host, and names the race\'s car', inner.hostId === SERVER && m.lobby?.settings.vehicle === 'mtr-496r');
  check('this car introduces itself to it', ws.controls().some((c) => c.type === 'hello'));
  const hello = ws.controls().findIndex((c) => c.type === 'hello');
  const identify = ws.controls().findIndex((c) => c.type === 'identify');
  check('then sends its driver key once, after the hello and never in the address', identify > hello && (ws.controls()[identify] as { driverKey?: string }).driverKey === DRIVER_KEY && !ws.url.includes(DRIVER_KEY));

  // The clock: only the server's pongs set it
  m.update(clock, local);
  const ping = ws.controls().find((c) => c.type === 'ping') as { t0: number } | undefined;
  check('it pings for the clock', ping !== undefined);
  ws.get({ ctl: { type: 'pong', t0: ping?.t0 ?? 0, now: 5_000_000 }, from: 'peer_other', to: me });
  check("another car's pong does not set the race clock", !inner.clockSynced);
  ws.get({ ctl: { type: 'pong', t0: ping?.t0 ?? 0, now: 5_000_000 }, from: SERVER, to: me });
  check("the server's pong does", inner.clockSynced && Math.abs(m.hostNowMs() - 5_000_000) < 5);

  // Waiting in the lobby: no car state goes out
  for (let i = 0; i < 10; i++) {
    clock += 40;
    m.update(clock, local);
  }
  check('waiting for the race, no car state is sent', ws.states().length === 0);

  // A lobby or a start from anyone but the server is nothing
  ws.get({ ctl: { type: 'lobby', lobby: { hostId: 'peer_evil', settings: {}, players: [], race: null } }, from: 'peer_evil' });
  ws.get({ ctl: { type: 'start', start: { id: 'fake', lightsStartHostMs: 1, holdMs: 1, laps: 1, grid: [me] } }, from: 'peer_evil' });
  check('a lobby or a start from another car is ignored', inner.hostId === SERVER && starts.length === 0);

  // The start
  const race = { id: 'race7', lightsStartHostMs: 5_010_000, holdMs: 1000, laps: 5, collisions: 'protected', carClass: 'any', trackId: 'chang', grid: ['peer_other', me], vehicle: 'mtr-496r' };
  ws.get({ ctl: { type: 'start', start: race }, from: SERVER });
  ws.get(lobby(race));
  check('the server\'s start begins the race, once', starts.join() === 'race7');
  check("and carries an open race's contact rule", startRule === 'protected', startRule);
  clock += 40;
  m.update(clock, local);
  check('racing, this car\'s state goes to the server', ws.states().length === 1);

  // Scheduled-race WebSocket send rate is capped to 20 Hz (50 ms) even at 60 fps, cutting DO message load 3x
  const beforeRateCount = ws.states().length;
  for (let i = 0; i < 60; i++) {
    clock += 1000 / 60;
    m.update(clock, local);
  }
  const sentInOneSec = ws.states().length - beforeRateCount;
  check(
    `scheduled-race WebSocket sends at ${RACE_SERVER_STATE_SEND_HZ} Hz (not 60 Hz)`,
    sentInOneSec >= RACE_SERVER_STATE_SEND_HZ - 2 && sentInOneSec <= RACE_SERVER_STATE_SEND_HZ + 2,
    `${sentInOneSec} states/s`,
  );

  // Plain-text "pong" keepalive from edge auto-response is ignored cleanly without disturbing control state
  ws.onmessage?.({ data: 'pong' });
  check('plain-text keepalive "pong" is ignored cleanly', inner.hostId === SERVER && m.inScheduledRace);

  // Another car, at 50 m/s along x, a packet every 40 ms
  const SPEED = 50;
  const t0 = clock;
  const carAt = (t: number) => ({ peerId: 'peer_other', driverCode: 'OTH', teamColorHex: '#FF0000', timestampMs: 900_000 + (t - t0), pos: [(SPEED * (t - t0)) / 1000, 0, 0], quat: [0, 0, 0, 1], linVel: [SPEED, 0, 0], angVel: [0, 0, 0], steerAngle: 0, wheelRPMs: [0, 0, 0, 0], throttle: 1, brake: 0, trackS: 0, speedKmh: 180, seq: Math.round((t - t0) / 40) });
  let x = 0;
  const frame = () => {
    const peer = m.update(clock, local).find((p) => p.peerId === 'peer_other');
    if (peer) x = peer.position.x;
    return peer;
  };
  for (let i = 0; i < 50; i++) {
    clock += 20;
    if (i % 2 === 0) ws.getState(binary(carAt(clock)));
    frame();
  }
  const steady = inner.peers.get('peer_other');
  const offsetBefore = steady?.mapMs ?? NaN;
  check('the other car is drawn about where it is', Math.abs(x - (SPEED * (clock - t0)) / 1000) < 2, `${x.toFixed(1)} m of ${((SPEED * (clock - t0)) / 1000).toFixed(1)}`);

  // The network stalls for 320 ms, then everything it held back lands at once
  const stalledFrom = clock;
  let wentBack = false;
  for (let i = 0; i < 16; i++) {
    clock += 20;
    const before = x;
    frame();
    if (x < before - 0.01) wentBack = true;
  }
  for (let t = stalledFrom + 40; t <= clock; t += 40) ws.getState(binary(carAt(t)));
  const before = x;
  frame();
  const after = inner.peers.get('peer_other');
  check('after a stall and a burst, the car\'s clock is not read as having jumped', Math.abs((after?.mapMs ?? NaN) - offsetBefore) < 60, `${((after?.mapMs ?? NaN) - offsetBefore).toFixed(0)} ms`);
  check('its history is kept', (after?.snapshots.length ?? 0) >= 4, `${after?.snapshots.length} snapshots`);
  for (let i = 0; i < 10; i++) {
    clock += 20;
    if (i % 2 === 0) ws.getState(binary(carAt(clock)));
    const was = x;
    frame();
    if (x < was - 0.01) wentBack = true;
  }
  check('the car never goes backwards through it', !wentBack && x >= before);
  check('and is back where it is', Math.abs(x - (SPEED * (clock - t0)) / 1000) < 2, `${x.toFixed(1)} m of ${((SPEED * (clock - t0)) / 1000).toFixed(1)}`);
  ws.getState(binary({ ...carAt(clock), peerId: me }));
  check("a packet claiming to be this car is not taken for another's", !inner.peers.has(me));

  // Adaptive per-peer jitter buffer expands under arrival jitter spikes (~60..180 ms) and stays bounded
  const baseDelay = inner.peers.get('peer_other')?.adaptiveDelayMs ?? 0;
  let senderT = clock;
  for (let i = 0; i < 40; i++) {
    senderT += 50;
    // Alternate early/late arrivals (+/- 40 ms jitter spike) while sender timestamps stay steady at 20 Hz
    clock += i % 2 === 0 ? 90 : 10;
    ws.getState(binary({ ...carAt(senderT), seq: 100 + i }));
    m.update(clock, local);
  }
  const highJitterPeer = inner.peers.get('peer_other');
  const peakDelay = highJitterPeer?.adaptiveDelayMs ?? 0;
  check(
    'adaptive jitter buffer widens under arrival jitter spikes and stays within 60..180 ms',
    peakDelay > baseDelay + 25 && peakDelay >= 60 && peakDelay <= 180,
    `${baseDelay.toFixed(1)} ms -> ${peakDelay.toFixed(1)} ms (jitter ${(highJitterPeer?.jitterMs ?? 0).toFixed(1)} ms)`,
  );

  // The flag: the finish goes to the server, and only the server's result is taken
  const results: { final: boolean }[] = [];
  m.onRaceResult = (r) => results.push(r);
  m.sendRaceFinish({ type: 'finish', id: 'race7', timeS: 400, penaltyS: 0, laps: 5, bestLapMs: 79_000 });
  check('the finish goes to the race server', ws.controls().some((c) => c.type === 'finish'));
  const row = { peer: me, position: 1, timeS: 400, penaltyS: 0, laps: 5, bestLapMs: 79_000, dnf: false, grid: 2 };
  ws.get({ ctl: { type: 'result', id: 'race7', final: false, rows: [row] }, from: 'peer_other' });
  ws.get({ ctl: { type: 'result', id: 'race7', final: true, rows: [row] }, from: SERVER });
  check("a result from another car is nothing; the server's is taken", results.length === 1 && results[0].final);

  // Leaving
  m.leaveRace();
  check('leaving the race closes the socket and ends the race here', ws.closed && !m.inScheduledRace && m.lobby === null && aborts.join() === 'race7');

  // Refused
  m.joinScheduledRace();
  await tick();
  await tick();
  const again = FakeWebSocket.last!;
  again.get({ t: 'full' });
  check('a full race: told so, and not entered', again.closed && m.raceStatus.state === 'error' && /full/i.test(m.raceStatus.text));

  // A server of another version: told to reload (an older game is refused before it gets this far)
  m.joinScheduledRace();
  await tick();
  await tick();
  const updated = FakeWebSocket.last!;
  updated.get({ t: 'update' });
  check('a server that wants another version: told to reload', updated.closed && m.raceStatus.state === 'error' && /reload/i.test(m.raceStatus.text), m.raceStatus.text);
  m.joinScheduledRace();
  await tick();
  await tick();
  const mismatched = FakeWebSocket.last!;
  mismatched.get({ t: 'welcome', now: Date.now(), startsMs: startsAt, index: 9 });
  mismatched.get({ ctl: { type: 'lobby', lobby: { hostId: SERVER, settings: { trackId: 'chang', laps: 5 }, players: [], race: null, proto: PROTOCOL_VERSION + 1 } }, from: SERVER });
  check("a lobby of another version ends the entry, and says why", mismatched.closed && m.raceStatus.state === 'error' && /reload/i.test(m.raceStatus.text), m.raceStatus.text);

  // Hosting a room leaves the race
  m.joinScheduledRace();
  await tick();
  await tick();
  const third = FakeWebSocket.last!;
  third.get({ t: 'welcome', now: Date.now(), startsMs: startsAt, index: 8 });
  m.hostLocal();
  check('hosting something else leaves the race', third.closed && !m.inScheduledRace && m.raceStatus.state === 'idle');

  // Lost more than 10 min into a race (the config is read again then) and being got back in, then left and joined
  // again before that read heard back: the new entry goes to the next race, not back into the old one
  m.joinScheduledRace();
  await tick();
  await tick();
  const lost = FakeWebSocket.last!;
  lost.get({ t: 'welcome', now: Date.now(), startsMs: startsAt, index: 8 });
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
    await gate;
    return realFetch(...a);
  }) as typeof fetch;
  lost.readyState = 3;
  lost.onclose?.();
  // The retry's config read under way
  await new Promise((r) => setTimeout(r, 600));
  const retryWaiting = FakeWebSocket.last === lost;
  m.leaveScheduledRace();
  m.joinScheduledRace();
  release();
  await new Promise((r) => setTimeout(r, 20));
  globalThis.fetch = realFetch;
  Date.now = realNow;
  const rejoined = FakeWebSocket.last!;
  check(
    'left and joined again while getting back in: the new entry is for the next race',
    retryWaiting && rejoined !== lost && /\/races\/next\?/.test(rejoined.url),
    `${retryWaiting ? '' : 'the retry did not wait for its read; '}${rejoined.url.replace(/token=[a-f0-9]*/, 'token=…')}`
  );
  m.leaveScheduledRace();

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll race client checks passed');
  process.exit(0);
}

void main();
