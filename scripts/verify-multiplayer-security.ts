/**
 * Headless checks that a multiplayer guest can't take over a room or another player's car, and that bad state packets
 * never reach the game.
 *
 *   npx tsx scripts/verify-multiplayer-security.ts
 *
 * The WebRTC channels are stood in for by plain objects; the manager's channel handlers are driven directly.
 */
import { MultiplayerSyncManager, sanitizePacket, type LobbyState, type NetworkVehiclePacket } from '../src/lib/sim/multiplayer-sync';
import { MAX_STATE_PACKETS_PER_S } from '../src/lib/net/wire';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

interface FakeChannel {
  label: string;
  readyState: 'open';
  sent: string[];
  send(s: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
const channel = (label: string): FakeChannel => ({
  label,
  readyState: 'open',
  sent: [],
  send(s) {
    this.sent.push(s);
  },
  close() {},
  onopen: null,
  onclose: null,
  onmessage: null,
});

interface Entry {
  remoteId: string;
  pc: { close(): void; onconnectionstatechange: null };
  dc: FakeChannel;
  ctl: FakeChannel;
  gamePeerId?: string;
}

/** The manager's private surface the transports use */
interface Internals {
  rtcPeers: Map<string, Entry>;
  peers: Map<string, unknown>;
  members: Map<string, { name: string }>;
  hostId: string | null;
  bindControlChannel(entry: Entry, ctl: FakeChannel): void;
  bindDataChannel(remoteId: string, dc: FakeChannel): void;
  becomeGuest(): void;
}
const internals = (m: MultiplayerSyncManager) => m as unknown as Internals;

function connect(m: MultiplayerSyncManager, remoteId: string): Entry {
  const entry: Entry = {
    remoteId,
    pc: { close() {}, onconnectionstatechange: null },
    dc: channel('f1-telemetry'),
    ctl: channel('f1-control'),
  };
  const i = internals(m);
  i.rtcPeers.set(remoteId, entry);
  i.bindDataChannel(remoteId, entry.dc);
  i.bindControlChannel(entry, entry.ctl);
  return entry;
}
const sendCtl = (entry: Entry, from: string, ctl: unknown, to?: string) =>
  entry.ctl.onmessage?.({ data: JSON.stringify(to ? { ctl, from, to } : { ctl, from }) });
const sendState = (entry: Entry, pkt: unknown) => entry.dc.onmessage?.({ data: JSON.stringify(pkt) });

let clock = 1000;
const packet = (peerId: string, over: Partial<Record<keyof NetworkVehiclePacket, unknown>> = {}) => ({
  peerId,
  driverCode: 'ABC',
  teamColorHex: '#112233',
  timestampMs: (clock += 40),
  pos: [10, 0.5, -20],
  quat: [0, 0, 0, 1],
  linVel: [0, 0, 50],
  angVel: [0, 0.1, 0],
  steerAngle: 0.05,
  wheelRPMs: [1000, 1000, 1000, 1000],
  throttle: 1,
  brake: 0,
  trackS: 120,
  speedKmh: 180,
  ...over,
});

const lobbyOf = (hostId: string, trackId: string): LobbyState => ({
  hostId,
  settings: { trackId, laps: 3, collisions: 'on', carClass: 'any' },
  players: [{ peerId: hostId, name: 'Host', code: 'HST', color: '#ffffff', ready: true, isHost: true }],
  race: null,
});
const startOf = (trackId: string) => ({
  id: 'race1',
  lightsStartHostMs: 5000,
  holdMs: 500,
  laps: 3,
  collisions: 'on',
  carClass: 'any',
  trackId,
  grid: ['peer_host'],
});

// 1. Packet validation ------------------------------------------------------------------------------------------------
{
  const ok = sanitizePacket(packet('peer_ok', { quat: [0, 0, 0, 2], throttle: 7, speedKmh: -5 }));
  check('a well-formed packet is kept', ok !== null);
  check('the quaternion is normalised', ok !== null && Math.abs(ok.quat[3] - 1) < 1e-12, `w ${ok?.quat[3]}`);
  check('throttle and speed are clamped', ok !== null && ok.throttle === 1 && ok.speedKmh === 0);
  const bad: [string, unknown][] = [
    ['NaN position', packet('p_a', { pos: [NaN, 0, 0] })],
    ['Infinity velocity', packet('p_a', { linVel: [Infinity, 0, 0] })],
    ['string in an array', packet('p_a', { wheelRPMs: [1, 2, '3', 4] })],
    ['missing wheel speeds', packet('p_a', { wheelRPMs: undefined })],
    ['short quaternion', packet('p_a', { quat: [0, 0, 1] })],
    ['zero quaternion', packet('p_a', { quat: [0, 0, 0, 0] })],
    ['position far off any circuit', packet('p_a', { pos: [1e9, 0, 0] })],
    ['non-finite timestamp', packet('p_a', { timestampMs: Infinity })],
    ['peer id with markup', packet('<img src=x>')],
    ['not an object', 'hello'],
  ];
  for (const [name, p] of bad) check(`refused: ${name}`, sanitizePacket(p) === null);
  // JSON turns NaN into null: the packet is refused rather than reaching the prediction
  check('refused: NaN after a JSON round trip', sanitizePacket(JSON.parse(JSON.stringify(packet('p_a', { pos: [NaN, 0, 0] })))) === null);
}

// 2. Host: guests are bound to their own id ---------------------------------------------------------------------------
{
  const host = new MultiplayerSyncManager();
  host.hostLocal();
  const i = internals(host);
  const a = connect(host, 'remote_a');
  const b = connect(host, 'remote_b');
  sendCtl(a, 'peer_a', { type: 'hello', name: 'Alice', code: 'ALI', color: '#ff0000' });
  sendCtl(b, 'peer_b', { type: 'hello', name: 'Bob', code: 'BOB', color: '#00ff00' });
  check('two guests join the lobby', i.members.size === 2, `${i.members.size} members`);

  sendCtl(a, 'peer_b', { type: 'hello', name: 'Mallory', code: 'MAL', color: '#000000' });
  check("a guest can't rename another guest", i.members.get('peer_b')?.name === 'Bob', i.members.get('peer_b')?.name);

  const c = connect(host, 'remote_c');
  sendCtl(c, 'peer_a', { type: 'hello', name: 'Clone', code: 'CLN', color: '#000000' });
  check("a new connection can't claim a taken id", c.gamePeerId === undefined && i.members.get('peer_a')?.name === 'Alice');
  sendCtl(c, host.localPeerId, { type: 'hello', name: 'Fake', code: 'FAK', color: '#000000' });
  check("a guest can't claim the host's id", c.gamePeerId === undefined);

  // Lobby / start / abort are the host's alone: never passed on
  b.ctl.sent.length = 0;
  sendCtl(a, 'peer_a', { type: 'lobby', lobby: lobbyOf('peer_a', 'chang') });
  sendCtl(a, 'peer_a', { type: 'start', start: startOf('chang') });
  sendCtl(a, 'peer_a', { type: 'abort', id: 'race1' });
  const relayedTypes = b.ctl.sent.map((s) => (JSON.parse(s) as { ctl: { type: string } }).ctl.type);
  check('a forged lobby / start / abort is not relayed', !relayedTypes.some((t) => ['lobby', 'start', 'abort'].includes(t)), relayedTypes.join(','));
  check('the host keeps its room', host.isHost && host.lobby?.hostId === host.localPeerId);
  sendCtl(a, 'peer_a', { type: 'ready', ready: true });
  check("a guest's ready is still relayed", b.ctl.sent.some((s) => (JSON.parse(s) as { ctl: { type: string } }).ctl.type === 'ready'));

  // State packets: own car only, cleaned before relay
  sendState(a, packet('peer_a'));
  sendState(a, packet('peer_b', { pos: [999, 0, 999] }));
  check("a guest can't move another guest's car", i.peers.has('peer_a') && !i.peers.has('peer_b'));
  b.dc.sent.length = 0;
  sendState(a, { ...packet('peer_a'), extra: 'x'.repeat(100) });
  const relayed = b.dc.sent.length === 1 ? (JSON.parse(b.dc.sent[0]) as Record<string, unknown>) : null;
  check('the relayed packet is the cleaned one', relayed !== null && !('extra' in relayed));
  b.dc.sent.length = 0;
  sendState(a, packet('peer_a', { pos: [NaN, 0, 0] }));
  check('a bad packet is not relayed', b.dc.sent.length === 0);

  // Flooding: the excess is dropped
  b.dc.sent.length = 0;
  for (let k = 0; k < 200; k++) sendState(a, packet('peer_a'));
  check('a flood is cut to the per-second budget', b.dc.sent.length <= MAX_STATE_PACKETS_PER_S, `${b.dc.sent.length} of 200 relayed`);
}

// 3. Guest: only the host it dialled runs the room ---------------------------------------------------------------------
{
  const guest = new MultiplayerSyncManager();
  const i = internals(guest);
  i.becomeGuest();
  const toHost = connect(guest, 'remote_host');
  let started: string | null = null;
  guest.onRaceStart = (s) => (started = s.trackId);

  sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyOf('peer_host', 'rwanda_official_short') });
  check('the guest follows its host', guest.hostId === 'peer_host' && guest.lobby?.settings.trackId === 'rwanda_official_short');

  // A forged lobby that reached the guest anyway (e.g. an old host build that relays it)
  sendCtl(toHost, 'peer_x', { type: 'lobby', lobby: lobbyOf('peer_x', 'chang') });
  check('a lobby naming another host is ignored', guest.hostId === 'peer_host' && guest.lobby?.settings.trackId === 'rwanda_official_short');
  sendCtl(toHost, 'peer_x', { type: 'lobby', lobby: lobbyOf('peer_host', 'chang') });
  check("a lobby sent under the host's id by someone else is ignored", guest.lobby?.settings.trackId === 'rwanda_official_short');
  sendCtl(toHost, 'peer_x', { type: 'start', start: startOf('chang') });
  check('a start from a guest is ignored', started === null);
  sendCtl(toHost, 'peer_host', { type: 'start', start: startOf('rwanda_official_short') });
  check("the host's start goes through", started === 'rwanda_official_short');

  // A same-browser tab can't redirect a guest that is connected to a host over WebRTC
  (guest as unknown as { handleEnvelope(env: unknown, via: null): void }).handleEnvelope(
    { ctl: { type: 'lobby', lobby: lobbyOf('peer_tab', 'chang') }, from: 'peer_tab' },
    null
  );
  check('a lobby from another tab is ignored while connected', guest.hostId === 'peer_host');
}

// 4. Race lifecycle, presence and connection status ------------------------------------------------------------------
/** The checks that wait on a promise; the result below waits for them */
let manualChecks: Promise<void> = Promise.resolve();
{
  interface More {
    lastHostLobbyMs: number;
    memberSeenMs: Map<string, number>;
    manualPendingPc: unknown;
    tickControl(nowMs: number): void;
    handleEnvelope(env: unknown, via: null): void;
  }
  const more = (m: MultiplayerSyncManager) => m as unknown as More & Internals;
  const raceOf = (id: string) => ({ ...startOf('rwanda_official_short'), id });
  const lobbyWith = (hostId: string, race: ReturnType<typeof raceOf> | null) => ({ ...lobbyOf(hostId, 'rwanda_official_short'), race });
  const pong = (entry: Entry, from: string) => sendCtl(entry, from, { type: 'pong', t0: performance.now() - 20, now: 50_000 });

  // Guest: the race follows the host's lobby, a left race stays left
  {
    const guest = new MultiplayerSyncManager();
    const i = more(guest);
    i.becomeGuest();
    const toHost = connect(guest, 'remote_host');
    const events: string[] = [];
    guest.onRaceStart = (s) => events.push(`start ${s.id}`);
    guest.onRaceAbort = (id) => events.push(`abort ${id}`);

    sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyWith('peer_host', raceOf('r1')) });
    check('a race in the lobby waits for the host clock', events.length === 0, events.join());
    pong(toHost, 'peer_host');
    check('a guest that missed the start joins from the lobby once the clock is measured', events.join() === 'start r1', events.join());
    sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyWith('peer_host', raceOf('r1')) });
    check('the repeating lobby starts it only once', events.length === 1, events.join());

    guest.leaveRace();
    sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyWith('peer_host', raceOf('r1')) });
    sendCtl(toHost, 'peer_host', { type: 'start', start: raceOf('r1') });
    pong(toHost, 'peer_host');
    check('a race the guest left is not joined again', events.length === 1, events.join());

    sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyWith('peer_host', raceOf('r2')) });
    check("the host's next race is joined", events.join() === 'start r1,start r2', events.join());
    sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyWith('peer_host', raceOf('r3')) });
    check('a missed restart: the old race ends and the new one starts', events.join() === 'start r1,start r2,abort r2,start r3', events.join());
    sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyWith('peer_host', null) });
    check('a missed abort: the race ends once the lobby has none', events[events.length - 1] === 'abort r3', events.join());
    sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyWith('peer_host', raceOf('r3')) });
    check('an ended race is not joined again from a stale lobby', events[events.length - 1] === 'abort r3', events.join());

    i.handleEnvelope({ ctl: { type: 'start', start: raceOf('r4') }, from: 'peer_host' }, null);
    check("another tab's copy of the start waits for the host connection's own", !events.includes('start r4'), events.join());
    sendCtl(toHost, 'peer_host', { type: 'start', start: raceOf('r4') });
    check('the start on the host connection goes through', events[events.length - 1] === 'start r4', events.join());

    // A new host: its clock is measured afresh and the old host's race is over here
    i.lastHostLobbyMs = -1e12;
    sendCtl(toHost, 'peer_h2', { type: 'lobby', lobby: lobbyWith('peer_h2', null) });
    check('a host change ends the race and the clock sync', events[events.length - 1] === 'abort r4' && !guest.clockSynced && guest.hostNowMs(1000) === 1000, events.join());
  }

  // Host: any traffic keeps a guest in the lobby, and brings back one dropped for silence
  {
    const host = new MultiplayerSyncManager();
    host.hostLocal();
    const i = more(host);
    const a = connect(host, 'remote_a');
    sendCtl(a, 'peer_a', { type: 'hello', name: 'Alice', code: 'ALI', color: '#ff0000' });
    i.memberSeenMs.set('peer_a', performance.now() - 7000);
    sendCtl(a, 'peer_a', { type: 'ready', ready: true });
    i.tickControl(performance.now() + 2000);
    check("a guest's ready keeps it in the lobby", i.members.has('peer_a'));
    i.tickControl(performance.now() + 9000);
    check('a guest silent for 8 s leaves the lobby', !i.members.has('peer_a') && !host.lobby?.players.some((p) => p.peerId === 'peer_a'));
    sendState(a, packet('peer_a'));
    check('its next packet brings it back, as it was', i.members.get('peer_a')?.name === 'Alice' && host.lobby?.players.some((p) => p.peerId === 'peer_a' && p.ready) === true);
  }

  // Connection status: one way out per peer, whichever event comes first
  {
    const host = new MultiplayerSyncManager();
    host.hostLocal();
    const i = more(host);
    const a = connect(host, 'remote_a');
    const b = connect(host, 'remote_b');
    let closedA = 0;
    a.pc.close = () => void closedA++;
    sendCtl(a, 'peer_a', { type: 'hello', name: 'Alice', code: 'ALI', color: '#ff0000' });
    host.status = { ...host.status, mode: 'room_host', roomCode: 'ABCDEF' };
    a.dc.onclose?.();
    check('a closed channel closes the whole connection and drops the member', closedA === 1 && !i.rtcPeers.has('remote_a') && !i.members.has('peer_a'));
    check('another player still connected: still connected', host.status.state === 'connected' && host.status.connectedWebRtcPeers === 1, JSON.stringify(host.status));
    check("the lost connection can't report itself a second time", a.pc.onconnectionstatechange === null);
    b.dc.onclose?.();
    check('the last player gone: the room host waits for players again', host.status.state === 'signaling' && host.status.statusText.includes('ABCDEF'), JSON.stringify(host.status));

    const guest = new MultiplayerSyncManager();
    more(guest).becomeGuest();
    const toHost = connect(guest, 'remote_host');
    guest.status = { ...guest.status, mode: 'room_guest', state: 'connected' };
    toHost.dc.onclose?.();
    check('a guest that lost its host says so, and stops waiting', guest.status.state === 'error' && /host/i.test(guest.status.statusText), JSON.stringify(guest.status));
  }

  // Manual connection: an answered offer is no longer the pending one, and not connected until its channel opens
  manualChecks = (async () => {
    const g = globalThis as unknown as { RTCSessionDescription?: unknown };
    const hadDesc = g.RTCSessionDescription;
    g.RTCSessionDescription = class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    };
    const host = new MultiplayerSyncManager();
    host.hostLocal();
    const i = more(host);
    i.manualPendingPc = { setRemoteDescription: async () => {}, close() {} };
    await host.acceptManualAnswer(btoa(JSON.stringify({ type: 'answer', sdp: 'v=0' })));
    check('an answered offer is no longer the pending one (a second guest can be offered)', i.manualPendingPc === null);
    check('answered is not yet connected', host.status.state === 'signaling', JSON.stringify(host.status));
    g.RTCSessionDescription = hadDesc;
  })();
}

void manualChecks.then(() => {
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll multiplayer security checks passed.');
});
