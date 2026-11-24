/**
 * Headless verification suite for Multiplayer car-class/spec enforcement and default car-to-car collisions.
 *
 *   npx tsx scripts/verify/verify-multiplayer-class-and-contact.ts
 *   node scripts/verify/run-verify.mjs multiplayer-class-and-contact
 *
 * Covers:
 *  1. Wire vehicle->class mapping parity with VEHICLE_MODELS and rule checks (spec LC-LMDH vs class vs any)
 *  2. Open scheduled LC-LMDH race server (cloudflare/api/race.ts): rejects F1 on connect, hello, state relay, grid
 *  3. Private/public room server (cloudflare/api/room.ts): default collisions='on', rejects F1 in proto/LC-LMDH room
 *  4. P2P host/guest sync (multiplayer-sync.ts): refuses wrong-class hello/ready/state/quali, fires onRoomCarRule
 *  5. Car-to-car collisions ON by default (practice + race + protected after 3s launch) + Ghost toggle + safety guards
 *     (spawn protection with overlap latch, pitlane, paused/AFK, heavy lag/desync) + live physical OBB impulse test
 */
import * as THREE from 'three';
import { RaceServer, RACE_SERVER_ID } from '../../cloudflare/api/race';
import { RoomServer } from '../../cloudflare/api/room';
import type { Env } from '../../cloudflare/api/types';
import { VEHICLE_MODELS, vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { raceRules, raceSlot, RACE_COUNTDOWN_MS } from '../../src/lib/net/race-schedule';
import {
  decodeState,
  encodeState,
  isVehicleAllowed,
  isVehicleRestricted,
  PROTOCOL_VERSION,
  sanitizeControl,
  stateInfoJson,
  StateInfoMemory,
  VEHICLE_CLASS_BY_MODEL,
  vehicleClassOf,
  type LobbyState,
  type NetworkVehiclePacket,
  type RaceStartInfo,
  type VehicleRule,
} from '../../src/lib/net/wire';
import type { StatePacketFields } from '../../src/lib/net/state-codec';
import { carPhysicsVersion } from '../../src/lib/sim/lap-types';
import { MultiplayerSyncManager } from '../../src/lib/sim/multiplayer-sync';
import {
  evaluatePeerContact,
  LocalContactSafety,
  MP_AFK_GHOST_S,
  MP_CLEAR_SEPARATION_M,
  MP_PROTECTED_LAUNCH_GHOST_S,
  MP_SPAWN_GHOST_MS,
} from '../../src/lib/sim/mp-contact';
import { MultiplayerRace } from '../../src/lib/sim/race-session';
import { resolvePlayerVsRemoteCar } from '../../src/lib/sim/ai-opponents';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import { createLcLmdhSim } from '../../src/lib/sim/proto/LcLmdhSim';
import { getActiveTrackData } from '../../src/lib/track-data';
import type { VehicleModelId } from '../../src/types/f1';
import { FakeSocket, fakeState } from '../lib/fake-cloudflare';

// Worker runtime stub required by RoomServer constructor
Object.assign(globalThis, {
  WebSocketRequestResponsePair: class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  },
});

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

const VERSIONS = { proto: PROTOCOL_VERSION, sim: carPhysicsVersion('lc26') };
const V = String(PROTOCOL_VERSION);
const token = (c: string) => c.repeat(16);

let pktClock = 1000;
const makePacket = (peerId: string, over: Partial<NetworkVehiclePacket> = {}): NetworkVehiclePacket => ({
  peerId,
  driverCode: 'DRV',
  teamColorHex: '#112233',
  timestampMs: (pktClock += 20),
  pos: [10, 0.5, -20],
  quat: [0, 0, 0, 1],
  linVel: [0, 0, 50],
  angVel: [0, 0, 0],
  steerAngle: 0,
  wheelRPMs: [1000, 1000, 1000, 1000],
  throttle: 1,
  brake: 0,
  trackS: 100,
  speedKmh: 180,
  ...over,
});
const toBinary = (p: NetworkVehiclePacket) =>
  encodeState(p as unknown as StatePacketFields, stateInfoJson(p as unknown as StatePacketFields));

async function main() {
  // ---------------------------------------------------------------------------
  // 1. Wire car-class parity & validation helpers
  // ---------------------------------------------------------------------------
  console.log('\n== 1. Wire car-class parity & rules');
  {
    const ids = Object.keys(VEHICLE_MODELS) as VehicleModelId[];
    const parity = ids.every((id) => VEHICLE_CLASS_BY_MODEL[id] === vehicleModelSpec(id).classId);
    check('VEHICLE_CLASS_BY_MODEL matches VEHICLE_MODELS for every model', parity, `${ids.length} models`);
    check('lc-lmdh is proto, lc26 is f1', vehicleClassOf('lc-lmdh') === 'proto' && vehicleClassOf('lc26') === 'f1');

    const specLmdh: VehicleRule = { carClass: 'proto', vehicle: 'lc-lmdh' };
    check(
      'spec LC-LMDH lobby allows only lc-lmdh (rejects F1, GT3, and even other proto mtr-496r)',
      isVehicleRestricted(specLmdh) &&
        isVehicleAllowed('lc-lmdh', specLmdh) &&
        !isVehicleAllowed('lc26', specLmdh) &&
        !isVehicleAllowed('f12026-car', specLmdh) &&
        !isVehicleAllowed('amg-gt3', specLmdh) &&
        !isVehicleAllowed('mtr-496r', specLmdh),
    );
    const classProto: VehicleRule = { carClass: 'proto' };
    check(
      'proto class lobby allows lc-lmdh and mtr-496r, rejects F1 and GT3',
      isVehicleRestricted(classProto) &&
        isVehicleAllowed('lc-lmdh', classProto) &&
        isVehicleAllowed('mtr-496r', classProto) &&
        !isVehicleAllowed('lc26', classProto) &&
        !isVehicleAllowed('amg-gt3', classProto),
    );
    const unrestricted: VehicleRule = { carClass: 'any' };
    check(
      'unrestricted lobby allows every vehicle',
      !isVehicleRestricted(unrestricted) && isVehicleAllowed('lc26', unrestricted) && isVehicleAllowed('lc-lmdh', unrestricted),
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Open scheduled LC-LMDH race server (cloudflare/api/race.ts)
  // ---------------------------------------------------------------------------
  console.log('\n== 2. Open LC-LMDH RaceServer enforcement');
  {
    // Week of 16 Nov 2026 is ["le_mans_82", "lc-lmdh"]
    const SLOT_S = 1200;
    const lmdhSlot = raceSlot(Math.ceil(Date.UTC(2026, 10, 18, 12) / (SLOT_S * 1000)), SLOT_S);
    const rules = raceRules(lmdhSlot);
    check('selected open race slot is Le Mans LC-LMDH', rules.race.trackId === 'le_mans_82' && rules.race.vehicle === 'lc-lmdh');

    let nowMs = lmdhSlot.startsMs - 5 * 60_000;
    const state = fakeState();
    const server = new RaceServer(state, {} as Env, () => nowMs);

    // Direct connect with ?vehicle=lc26 is refused immediately
    const f1Direct = new FakeSocket();
    await server.connect(f1Direct, 'peer_f1_direct', token('x'), lmdhSlot, V, 'lc26');
    check(
      'connect with ?vehicle=lc26 in LC-LMDH open race is refused immediately',
      f1Direct.last()?.t === 'car_class_mismatch' && f1Direct.last()?.requiredVehicle === 'lc-lmdh' && f1Direct.closed === 4000,
    );

    // Valid LC-LMDH entrant + F1 entrant attempting to sneak in via hello
    const lmdhWs = new FakeSocket();
    const f1Ws = new FakeSocket();
    await server.connect(lmdhWs, 'peer_lmdh', token('a'), lmdhSlot, V);
    await server.connect(f1Ws, 'peer_f1', token('b'), lmdhSlot, V);
    await server.webSocketMessage(
      lmdhWs,
      JSON.stringify({ ctl: { type: 'hello', name: 'Proto', code: 'PRO', color: '#00ff00', vehicle: 'lc-lmdh', trackId: 'le_mans_82' }, from: 'peer_lmdh' }),
    );
    await server.webSocketMessage(
      f1Ws,
      JSON.stringify({ ctl: { type: 'hello', name: 'F1Cheater', code: 'F1C', color: '#ff0000', vehicle: 'lc26', trackId: 'le_mans_82' }, from: 'peer_f1' }),
    );
    const lastLobby = [...lmdhWs.sent].reverse().map((m) => sanitizeControl(m.ctl)).find((c) => c?.type === 'lobby')?.lobby as LobbyState | undefined;
    check(
      'open LC-LMDH lobby advertises carClass=proto and vehicle=lc-lmdh',
      lastLobby?.settings.carClass === 'proto' && lastLobby?.settings.vehicle === 'lc-lmdh',
      JSON.stringify(lastLobby?.settings),
    );
    check(
      'F1 hello in LC-LMDH race receives car_class_mismatch + refuse and is NOT admitted to lobby',
      f1Ws.sent.some((m) => m.t === 'error' && m.code === 'car_class_mismatch') &&
        f1Ws.sent.some((m) => sanitizeControl(m.ctl)?.type === 'refuse') &&
        lastLobby?.players.length === 1 &&
        lastLobby.players[0].peerId === 'peer_lmdh',
    );

    // Second valid LC-LMDH player joins; F1 player stays excluded from grid when race starts
    const lmdh2Ws = new FakeSocket();
    await server.connect(lmdh2Ws, 'peer_lmdh2', token('c'), lmdhSlot, V);
    await server.webSocketMessage(
      lmdh2Ws,
      JSON.stringify({ ctl: { type: 'hello', name: 'Proto2', code: 'PR2', color: '#0000ff', vehicle: 'lc-lmdh', trackId: 'le_mans_82' }, from: 'peer_lmdh2' }),
    );
    nowMs = lmdhSlot.startsMs - RACE_COUNTDOWN_MS;
    // Heartbeat pings so entrants are considered present when the grid alarm fires
    await server.webSocketMessage(lmdhWs, JSON.stringify({ ctl: { type: 'ping', t0: 1 }, from: 'peer_lmdh' }));
    await server.webSocketMessage(lmdh2Ws, JSON.stringify({ ctl: { type: 'ping', t0: 1 }, from: 'peer_lmdh2' }));
    await server.webSocketMessage(f1Ws, JSON.stringify({ ctl: { type: 'ping', t0: 1 }, from: 'peer_f1' }));
    await server.alarm();
    const start = [...lmdhWs.sent].reverse().map((m) => sanitizeControl(m.ctl)).find((c) => c?.type === 'start')?.start as RaceStartInfo | undefined;
    check(
      'starting grid includes only LC-LMDH entrants and excludes mismatched F1 entrant',
      !!start && start.vehicle === 'lc-lmdh' && start.carClass === 'proto' && start.grid.includes('peer_lmdh') && start.grid.includes('peer_lmdh2') && !start.grid.includes('peer_f1'),
      JSON.stringify(start?.grid),
    );

    // Mid-race state packet spoofing vehicle='lc26' is dropped and never relayed
    lmdh2Ws.sent.length = 0;
    await server.webSocketMessage(lmdhWs, toBinary(makePacket('peer_lmdh', { vehicle: 'lc26' })));
    const relayedAfterF1 = lmdh2Ws.sent.filter((m) => typeof m.peerId === 'string');
    await server.webSocketMessage(lmdhWs, toBinary(makePacket('peer_lmdh', { vehicle: 'lc-lmdh' })));
    const relayedAfterLmdh = lmdh2Ws.sent.filter((m) => typeof m.peerId === 'string');
    check(
      'RaceServer drops spoofed F1 state packets and relays valid LC-LMDH state packets',
      relayedAfterF1.length === 0 && relayedAfterLmdh.length === 1 && relayedAfterLmdh[0].vehicle === 'lc-lmdh',
    );
  }

  // ---------------------------------------------------------------------------
  // 3. RoomServer (cloudflare/api/room.ts) class enforcement + default collisions
  // ---------------------------------------------------------------------------
  console.log('\n== 3. RoomServer class enforcement & default collisions');
  {
    let clockMs = 5_000_000;
    const state = fakeState();
    const room = new RoomServer(state, {} as Env, async () => [], () => clockMs);
    const host = new FakeSocket();
    const guestF1 = new FakeSocket();
    const guestProto = new FakeSocket();

    await room.connect('host', token('h'), host, 'private');
    const initial = await room.getRoomState();
    check('RoomServer defaults collisions to "on" (not ghost_lap1)', initial.settings.collisions === 'on', initial.settings.collisions);

    await room.webSocketMessage(host, JSON.stringify({ t: 'join', peerId: 'peer_h', vehicle: 'lc-lmdh' }));
    await room.webSocketMessage(host, JSON.stringify({ t: 'settings', settings: { carClass: 'proto', qualifyingMinutes: 3 } }));

    await room.connect('guest', token('1'), guestF1);
    await room.connect('guest', token('2'), guestProto);
    check(
      'RoomServer welcome carries room settings so guests know carClass immediately',
      (guestF1.sent[0]?.settings as { carClass?: string } | undefined)?.carClass === 'proto',
    );

    await room.webSocketMessage(guestF1, JSON.stringify({ t: 'join', peerId: 'peer_f1', vehicle: 'lc26' }));
    await room.webSocketMessage(guestProto, JSON.stringify({ t: 'join', peerId: 'peer_proto', vehicle: 'lc-lmdh' }));
    const afterJoin = await room.getRoomState();
    check(
      'RoomServer rejects F1 join in proto room and excludes from participants',
      guestF1.last()?.t === 'error' &&
        guestF1.last()?.code === 'car_class_mismatch' &&
        !afterJoin.participants.includes('peer_f1') &&
        afterJoin.participants.includes('peer_proto'),
      JSON.stringify(afterJoin.participants),
    );

    // Start qualifying: F1 cannot submit laps or enter grid
    await room.webSocketMessage(host, JSON.stringify({ t: 'start_session' }));
    const qState = await room.getRoomState();
    await room.webSocketMessage(guestF1, JSON.stringify({ t: 'lap', sessionId: qState.sessionId, bestLapMs: 72_000 }));
    await room.webSocketMessage(guestProto, JSON.stringify({ t: 'lap', sessionId: qState.sessionId, bestLapMs: 88_000 }));
    const afterQualiLaps = await room.getRoomState();
    check(
      'RoomServer rejects qualifying laps from mismatched F1 peer',
      afterQualiLaps.qualifyingLaps['peer_f1'] === undefined && afterQualiLaps.qualifyingLaps['peer_proto'] === 88_000,
    );

    // Guest auto-switches to lc-lmdh -> now admitted and allowed to qualify
    await room.webSocketMessage(guestF1, JSON.stringify({ t: 'vehicle', vehicle: 'lc-lmdh' }));
    await room.webSocketMessage(guestF1, JSON.stringify({ t: 'lap', sessionId: qState.sessionId, bestLapMs: 86_500 }));
    const afterSwitch = await room.getRoomState();
    check(
      'after switching to lc-lmdh, guest is admitted and its qualifying lap counts',
      afterSwitch.participants.includes('peer_f1') && afterSwitch.qualifyingLaps['peer_f1'] === 86_500,
    );
  }

  // ---------------------------------------------------------------------------
  // 4. P2P MultiplayerSyncManager host/guest enforcement + onRoomCarRule
  // ---------------------------------------------------------------------------
  console.log('\n== 4. P2P MultiplayerSyncManager class lock & state filtering');
  {
    interface FakeChan {
      label: string;
      readyState: 'open';
      sent: (string | ArrayBuffer)[];
      send(s: string | ArrayBuffer): void;
      close(): void;
      onopen: (() => void) | null;
      onclose: (() => void) | null;
      onmessage: ((ev: { data: unknown }) => void) | null;
    }
    const chan = (label: string): FakeChan => ({
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
    const host = new MultiplayerSyncManager();
    host.hostLocal();
    check('MultiplayerSyncManager defaults collisions to "on"', host.lobby?.settings.collisions === 'on', host.lobby?.settings.collisions);

    host.setIdentity({ name: 'Host', code: 'HST', color: '#ffffff' }, 'lc-lmdh', 'le_mans_82');
    host.setLobbySettings({ trackId: 'le_mans_82', carClass: 'proto', vehicle: 'lc-lmdh' });

    const hi = host as unknown as {
      rtcPeers: Map<string, { remoteId: string; pc: { close(): void; onconnectionstatechange: null }; dc: FakeChan; ctl: FakeChan }>;
      peers: Map<string, unknown>;
      members: Map<string, { ready: boolean; vehicle?: VehicleModelId }>;
      bindControlChannel(e: unknown, c: FakeChan): void;
      bindDataChannel(id: string, c: FakeChan): void;
    };
    const attach = (remoteId: string) => {
      const entry = { remoteId, pc: { close() {}, onconnectionstatechange: null }, dc: chan('f1-telemetry'), ctl: chan('f1-control') };
      hi.rtcPeers.set(remoteId, entry);
      hi.bindDataChannel(remoteId, entry.dc);
      hi.bindControlChannel(entry, entry.ctl);
      return entry;
    };
    const gF1 = attach('remote_f1');
    const gOk = attach('remote_ok');

    gF1.ctl.onmessage?.({ data: JSON.stringify({ ctl: { type: 'hello', name: 'F1', code: 'F1X', color: '#ff0000', vehicle: 'lc26', trackId: 'le_mans_82', ...VERSIONS }, from: 'peer_f1' }) });
    gOk.ctl.onmessage?.({ data: JSON.stringify({ ctl: { type: 'hello', name: 'LMDH', code: 'LMD', color: '#00ff00', vehicle: 'lc-lmdh', trackId: 'le_mans_82', ...VERSIONS }, from: 'peer_ok' }) });
    gF1.ctl.onmessage?.({ data: JSON.stringify({ ctl: { type: 'ready', ready: true }, from: 'peer_f1' }) });
    gOk.ctl.onmessage?.({ data: JSON.stringify({ ctl: { type: 'ready', ready: true }, from: 'peer_ok' }) });

    const refusedCarClass = gF1.ctl.sent.some(
      (s) => typeof s === 'string' && sanitizeControl(JSON.parse(s).ctl)?.type === 'refuse' && (JSON.parse(s).ctl as { reason?: string }).reason === 'car_class',
    );
    check(
      'host sends refuse(car_class) to F1 guest and blocks ready=true',
      refusedCarClass && hi.members.get('peer_f1')?.ready === false && hi.members.get('peer_ok')?.ready === true,
    );

    // State packet from F1 guest is dropped and NOT relayed to gOk
    gOk.dc.sent.length = 0;
    gF1.dc.onmessage?.({ data: toBinary(makePacket('peer_f1', { vehicle: 'lc26' })) });
    const relayedF1 = gOk.dc.sent.length;
    check('host drops and does not relay F1 state packets in LC-LMDH room', !hi.peers.has('peer_f1') && relayedF1 === 0);

    // Start race excludes mismatched F1 guest from grid
    const started = host.startRace();
    check(
      'host startRace excludes mismatched F1 guest from race grid',
      !!started && started.grid.includes(host.localPeerId) && started.grid.includes('peer_ok') && !started.grid.includes('peer_f1'),
      JSON.stringify(started?.grid),
    );
    host.abortRace();

    // Guest switches to lc-lmdh -> now ready works, state is ingested & relayed
    gF1.ctl.onmessage?.({ data: JSON.stringify({ ctl: { type: 'hello', name: 'F1', code: 'F1X', color: '#ff0000', vehicle: 'lc-lmdh', trackId: 'le_mans_82', ...VERSIONS }, from: 'peer_f1' }) });
    gF1.ctl.onmessage?.({ data: JSON.stringify({ ctl: { type: 'ready', ready: true }, from: 'peer_f1' }) });
    gOk.dc.sent.length = 0;
    gF1.dc.onmessage?.({ data: toBinary(makePacket('peer_f1', { vehicle: 'lc-lmdh' })) });
    const decodedRelayed = gOk.dc.sent[0] instanceof ArrayBuffer ? decodeState(gOk.dc.sent[0], new StateInfoMemory()) : null;
    check(
      'once guest switches to lc-lmdh, ready works and state packets are ingested & relayed',
      hi.members.get('peer_f1')?.ready === true &&
        hi.peers.has('peer_f1') &&
        decodedRelayed?.ok === true &&
        decodedRelayed.packet.vehicle === 'lc-lmdh',
    );

    // Guest-side: onRoomCarRule fires on refuse(car_class) and outbound F1 packets are suppressed
    const guest = new MultiplayerSyncManager();
    const gi = guest as unknown as {
      becomeGuest(): void;
      rtcPeers: Map<string, { remoteId: string; pc: { close(): void; onconnectionstatechange: null }; dc: FakeChan; ctl: FakeChan }>;
      bindControlChannel(e: unknown, c: FakeChan): void;
      bindDataChannel(id: string, c: FakeChan): void;
    };
    gi.becomeGuest();
    const toHost = { remoteId: 'host', pc: { close() {}, onconnectionstatechange: null }, dc: chan('f1-telemetry'), ctl: chan('f1-control') };
    gi.rtcPeers.set('host', toHost);
    gi.bindDataChannel('host', toHost.dc);
    gi.bindControlChannel(toHost, toHost.ctl);
    let ruleReceived: VehicleRule | null = null;
    guest.onRoomCarRule = (r) => {
      ruleReceived = r;
    };
    guest.setIdentity({ name: 'Guest', code: 'GST', color: '#00ffff' }, 'lc26', 'le_mans_82');
    toHost.ctl.onmessage?.({
      data: JSON.stringify({
        ctl: {
          type: 'lobby',
          lobby: {
            ...VERSIONS,
            hostId: 'peer_host',
            settings: { trackId: 'le_mans_82', laps: 3, collisions: 'on', carClass: 'proto', vehicle: 'lc-lmdh' },
            players: [{ peerId: 'peer_host', name: 'Host', code: 'HST', color: '#ffffff', vehicle: 'lc-lmdh', ready: true, isHost: true }],
            race: null,
          },
        },
        from: 'peer_host',
      }),
    });
    toHost.ctl.onmessage?.({
      data: JSON.stringify({
        ctl: { type: 'refuse', reason: 'car_class', carClass: 'proto', vehicle: 'lc-lmdh' },
        from: 'peer_host',
        to: guest.localPeerId,
      }),
    });
    toHost.dc.sent.length = 0;
    guest.update(5000, { ...makePacket(guest.localPeerId, { vehicle: 'lc26' }) });
    const sentWhileF1 = toHost.dc.sent.length;
    guest.setIdentity({ name: 'Guest', code: 'GST', color: '#00ffff' }, 'lc-lmdh', 'le_mans_82');
    guest.update(5100, { ...makePacket(guest.localPeerId, { vehicle: 'lc-lmdh' }) });
    const sentWhileLmdh = toHost.dc.sent.length;
    check(
      'guest receives onRoomCarRule and suppresses outbound F1 packets until switched to lc-lmdh',
      ruleReceived !== null && (ruleReceived as VehicleRule).vehicle === 'lc-lmdh' && sentWhileF1 === 0 && sentWhileLmdh === 1,
    );

    host.dispose();
    guest.dispose();
  }

  // ---------------------------------------------------------------------------
  // 5. Car-to-car collisions ON by default + safety guards + Ghost toggle
  // ---------------------------------------------------------------------------
  console.log('\n== 5. Car-to-car collisions, Ghost toggle & safety guards');
  {
    const basePeer = { isAiPeer: false, contactReady: true, stale: false, desync: false, hazard: false, ghost: false, inPitlane: false };

    // Lobby practice/qualifying (race === null) with collisions ON
    const practiceSolid = evaluatePeerContact({ collisionMode: 'on', localSafetyGhost: false, peer: basePeer, race: null });
    check('lobby practice/qualifying with collisions=on is SOLID (not ghosted)', practiceSolid.solid === true && practiceSolid.passThrough === false);

    // Private room Ghost toggle (collisions === 'off')
    const ghostMode = evaluatePeerContact({ collisionMode: 'off', localSafetyGhost: false, peer: basePeer, race: null });
    check('Ghost mode toggle (collisions=off) ghosts cars cleanly', ghostMode.solid === false && ghostMode.passThrough === true && ghostMode.reason === 'ghost_mode');

    // Pitlane, heavy lag/desync, hazard/paused remote peers
    const peerPit = evaluatePeerContact({ collisionMode: 'on', localSafetyGhost: false, peer: { ...basePeer, inPitlane: true }, race: null });
    const peerDesync = evaluatePeerContact({ collisionMode: 'on', localSafetyGhost: false, peer: { ...basePeer, desync: true }, race: null });
    const peerPaused = evaluatePeerContact({ collisionMode: 'on', localSafetyGhost: false, peer: { ...basePeer, hazard: true }, race: null });
    check(
      'remote pitlane, desync/heavy-lag, and paused/hazard peers ghost cleanly',
      !peerPit.solid && peerPit.passThrough && !peerDesync.solid && peerDesync.passThrough && !peerPaused.solid && peerPaused.passThrough,
    );

    // LocalContactSafety: spawn protection + overlap hold, pitlane, paused, AFK
    const safety = new LocalContactSafety();
    safety.armSpawnProtection(1000, MP_SPAWN_GHOST_MS);
    const s1 = safety.update({ nowMs: 2500, dtS: 0.016, paused: false, inMenu: false, inPitlane: false, speedMs: 40, hasInput: true, gridHeld: false, nearestPeerDistM: 20 });
    const s2 = safety.update({ nowMs: 4500, dtS: 0.016, paused: false, inMenu: false, inPitlane: false, speedMs: 40, hasInput: true, gridHeld: false, nearestPeerDistM: MP_CLEAR_SEPARATION_M - 2 });
    const s3 = safety.update({ nowMs: 4600, dtS: 0.016, paused: false, inMenu: false, inPitlane: false, speedMs: 40, hasInput: true, gridHeld: false, nearestPeerDistM: MP_CLEAR_SEPARATION_M + 2 });
    check(
      'spawn protection holds through timer AND overlap until cars are > 6 m apart',
      s1.ghost && s1.reason === 'spawn' && s2.ghost && s2.reason === 'spawn' && !s3.ghost,
    );

    const sPit = safety.update({ nowMs: 5000, dtS: 0.016, paused: false, inMenu: false, inPitlane: true, speedMs: 15, hasInput: true, gridHeld: false, nearestPeerDistM: 30 });
    const sPause = safety.update({ nowMs: 5100, dtS: 0.016, paused: true, inMenu: false, inPitlane: false, speedMs: 0, hasInput: false, gridHeld: false, nearestPeerDistM: 30 });
    check('local pitlane and pause immediately ghost the car', sPit.ghost && sPit.reason === 'pitlane' && sPause.ghost && sPause.reason === 'paused');

    // AFK detection (does NOT trigger on grid hold; triggers after MP_AFK_GHOST_S stationary with no input; clears on input)
    let stGrid = safety.update({ nowMs: 6000, dtS: MP_AFK_GHOST_S + 2, paused: false, inMenu: false, inPitlane: false, speedMs: 0, hasInput: false, gridHeld: true, nearestPeerDistM: 30 });
    let stAfk = safety.update({ nowMs: 15000, dtS: MP_AFK_GHOST_S + 0.5, paused: false, inMenu: false, inPitlane: false, speedMs: 0, hasInput: false, gridHeld: false, nearestPeerDistM: 30 });
    let stBack = safety.update({ nowMs: 15100, dtS: 0.016, paused: false, inMenu: false, inPitlane: false, speedMs: 2, hasInput: true, gridHeld: false, nearestPeerDistM: 30 });
    check(
      'AFK ghosting skips grid hold, triggers after stationary timeout, and clears on driver input',
      !stGrid.ghost && stAfk.ghost && stAfk.reason === 'afk' && !stBack.ghost,
    );

    // Open race (`protected`) activates collisions after brief 3s launch window even on Lap 1 of a 13.6 km circuit
    const leMansLen = 13_626;
    const startInfo: RaceStartInfo = {
      id: 'open-lmdh',
      lightsStartHostMs: 10_000,
      holdMs: 500,
      laps: 3,
      collisions: 'protected',
      carClass: 'proto',
      vehicle: 'lc-lmdh',
      trackId: 'le_mans_82',
      grid: ['me', 'other'],
    };
    const lightsOut = 15_500;
    const mpRace = new MultiplayerRace(startInfo, leMansLen, 'me', { name: 'Me', code: 'MEE', color: '#00ff00' }, [
      { peerId: 'me', name: 'Me', code: 'MEE', color: '#00ff00' },
      { peerId: 'other', name: 'Other', code: 'OTH', color: '#ff0000' },
    ]);
    mpRace.lapClock.reset(leMansLen - 10);
    mpRace.ingestPeers(
      [{ peerId: 'other', driverCode: 'OTH', teamColorHex: '#ff0000', speedKmh: 200, position: new THREE.Vector3(), race: { id: 'open-lmdh', dist: 250, fin: null, best: null } } as never],
      MP_PROTECTED_LAUNCH_GHOST_S + 0.5,
    );
    const earlyLaunch = mpRace.collisionsActiveWith(mpRace.frame(lightsOut + 1000), 'other');
    const lap1Racing = mpRace.collisionsActiveWith(mpRace.frame(lightsOut + (MP_PROTECTED_LAUNCH_GHOST_S + 0.5) * 1000), 'other');
    check(
      'open race (protected) ghosts only brief launch window, then collides on Lap 1 (not ghosted for 13.6 km)',
      !earlyLaunch && lap1Racing,
    );

    // Heavy packet loss/jitter in MultiplayerSyncManager sets peer.desync=true & contactReady=false
    const syncLag = new MultiplayerSyncManager({ clock: () => lagClock });
    let lagClock = 1000;
    for (let i = 0; i < 110; i++) {
      lagClock += 50;
      // Drop 50% of sequence numbers (seq increments by 2 every packet) across > 5 s seqWindow
      syncLag.ingestPacket(makePacket('laggy', { timestampMs: lagClock, seq: i * 2 }), false, lagClock);
    }
    const lagPeer = syncLag.update(lagClock, null).find((p) => p.peerId === 'laggy');
    check(
      'heavy packet loss (50%) marks peer desync=true and contactReady=false',
      lagPeer !== undefined && lagPeer.desync === true && lagPeer.contactReady === false,
      `desync=${lagPeer?.desync} contactReady=${lagPeer?.contactReady}`,
    );
    syncLag.dispose();

    // Physical car-to-car collision resolution with two LC-LMDH cars (and F1 car) using resolvePlayerVsRemoteCar
    const track = getActiveTrackData(1200);
    const playerLmdh = createLcLmdhSim(track, null);
    const remoteLmdh = createLcLmdhSim(track, null);
    playerLmdh.teleportToDistance(300, 45, 0);
    remoteLmdh.teleportToDistance(304.2, 30, 0); // overlapping nose-to-tail (4.2 m < 5.0 m car length)
    const beforeVx = playerLmdh.vxMs;
    const remoteVel = new THREE.Vector3(remoteLmdh.vyMs, 0, remoteLmdh.vxMs).applyQuaternion(remoteLmdh.worldQuaternion);
    const hitLmdh = resolvePlayerVsRemoteCar(
      playerLmdh,
      {
        peerId: 'remote_lmdh',
        driverCode: 'RMT',
        teamColorHex: '#ff0000',
        vehicle: 'lc-lmdh',
        position: remoteLmdh.worldPosition.clone(),
        quaternion: remoteLmdh.worldQuaternion.clone(),
        linearVelocity: remoteVel,
        steerAngle: 0,
        wheelRPMs: [0, 0, 0, 0],
        throttle: 0,
        brake: 0,
        trackS: remoteLmdh.sMeters,
        speedKmh: 30 * 3.6,
        isAiPeer: false,
        contactReady: true,
      },
      1 / 60,
    );
    check(
      'physical LC-LMDH vs remote LC-LMDH collision resolves impulse & slows striker (no ghosting)',
      hitLmdh === true && playerLmdh.vxMs < beforeVx - 1,
      `hit=${hitLmdh}, vx ${beforeVx.toFixed(1)} -> ${playerLmdh.vxMs.toFixed(1)} m/s`,
    );

    const playerF1 = new F1Physics2026(track);
    playerF1.teleportToDistance(300, 50, -0.8);
    const remoteF1 = new F1Physics2026(track);
    remoteF1.teleportToDistance(300, 50, 0.8); // side-by-side overlap (1.6 m < 1.95 m width)
    const beforeLat = playerF1.lateralOffsetM;
    const hitF1 = resolvePlayerVsRemoteCar(
      playerF1,
      {
        peerId: 'remote_f1',
        driverCode: 'RF1',
        teamColorHex: '#00ffff',
        vehicle: 'lc26',
        position: remoteF1.worldPosition.clone(),
        quaternion: remoteF1.worldQuaternion.clone(),
        linearVelocity: new THREE.Vector3(0, 0, 50).applyQuaternion(remoteF1.worldQuaternion),
        steerAngle: 0,
        wheelRPMs: [0, 0, 0, 0],
        throttle: 1,
        brake: 0,
        trackS: remoteF1.sMeters,
        speedKmh: 180,
        isAiPeer: false,
        contactReady: true,
      },
      1 / 60,
    );
    const pushedM = Math.abs(playerF1.lateralOffsetM - beforeLat);
    check(
      'physical F1 vs remote F1 side-by-side contact separates cars without snapping',
      hitF1 === true && pushedM > 0.005 && pushedM <= 1.5 / 60 + 1e-4,
      `hit=${hitF1}, pushed=${(pushedM * 100).toFixed(2)} cm`,
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll multiplayer class-lock & collision checks passed.');
}

void main();
