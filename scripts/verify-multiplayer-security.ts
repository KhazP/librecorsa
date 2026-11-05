/**
 * Headless checks that a multiplayer guest can't take over a room or another player's car, and that bad state packets
 * never reach the game.
 *
 *   npx tsx scripts/verify-multiplayer-security.ts
 *
 * The WebRTC channels are stood in for by plain objects; the manager's channel handlers are driven directly.
 */
import { MultiplayerSyncManager, sanitizePacket, type LobbyState, type NetworkVehiclePacket } from '../src/lib/sim/multiplayer-sync';

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
  sendCtl(a, 'peer_a', { type: 'lobby', lobby: lobbyOf('peer_a', 'monza') });
  sendCtl(a, 'peer_a', { type: 'start', start: startOf('monza') });
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
  check('a flood is cut to the per-second budget', b.dc.sent.length <= 60, `${b.dc.sent.length} of 200 relayed`);
}

// 3. Guest: only the host it dialled runs the room ---------------------------------------------------------------------
{
  const guest = new MultiplayerSyncManager();
  const i = internals(guest);
  i.becomeGuest();
  const toHost = connect(guest, 'remote_host');
  let started: string | null = null;
  guest.onRaceStart = (s) => (started = s.trackId);

  sendCtl(toHost, 'peer_host', { type: 'lobby', lobby: lobbyOf('peer_host', 'rwanda') });
  check('the guest follows its host', guest.hostId === 'peer_host' && guest.lobby?.settings.trackId === 'rwanda');

  // A forged lobby that reached the guest anyway (e.g. an old host build that relays it)
  sendCtl(toHost, 'peer_x', { type: 'lobby', lobby: lobbyOf('peer_x', 'monza') });
  check('a lobby naming another host is ignored', guest.hostId === 'peer_host' && guest.lobby?.settings.trackId === 'rwanda');
  sendCtl(toHost, 'peer_x', { type: 'lobby', lobby: lobbyOf('peer_host', 'monza') });
  check("a lobby sent under the host's id by someone else is ignored", guest.lobby?.settings.trackId === 'rwanda');
  sendCtl(toHost, 'peer_x', { type: 'start', start: startOf('monza') });
  check('a start from a guest is ignored', started === null);
  sendCtl(toHost, 'peer_host', { type: 'start', start: startOf('rwanda') });
  check("the host's start goes through", started === 'rwanda');

  // A same-browser tab can't redirect a guest that is connected to a host over WebRTC
  (guest as unknown as { handleEnvelope(env: unknown, via: null): void }).handleEnvelope(
    { ctl: { type: 'lobby', lobby: lobbyOf('peer_tab', 'monza') }, from: 'peer_tab' },
    null
  );
  check('a lobby from another tab is ignored while connected', guest.hostId === 'peer_host');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll multiplayer security checks passed.');
