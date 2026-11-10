/**
 * Serverless Peer-to-Peer WebRTC + BroadcastChannel Multiplayer & Dead-Reckoning Engine
 *
 * Implements:
 * - Compact network state packet:
 *   `[timestamp, pos, quat, linVel, angVel, steerAngle, wheelRPMs, throttle, brake]`
 * - 3 P2P Transports (the first two free forever on a static host):
 *   1. Room Code P2P Mode: WebRTC `RTCPeerConnection` + unreliable/unordered `RTCDataChannel`
 *      (`ordered: false, maxRetransmits: 0`) using Google Public STUN (`stun:stun.l.google.com:19302`) with a
 *      6-character Room Code. The players of a code are introduced by this site's room server when it has one
 *      switched on (cloudflare/api/room.ts, which also hands out relay servers for networks that block a direct
 *      link), else by the public PeerJS Cloud Signaling Broker (`wss://0.peerjs.com/peerjs`).
 *   2. Manual Copy-Paste SDP Offer/Answer Mode: 100% brokerless WebRTC P2P connection via base64 SDP tokens.
 *   3. Local Same-Machine Mode: Zero-config `BroadcastChannel` across browser tabs/windows.
 * - Dead-reckoning state buffer with Cubic Hermite position/velocity spline interpolation
 *   and Quaternion `slerp` orientation interpolation at variable render frame rate (`requestAnimationFrame`).
 * - Autonomous AI grid peers that publish 25 Hz state packets into the same dead-reckoning pipeline.
 */

import * as THREE from 'three';
import { DEFAULT_TRACK_ID } from '@/lib/track-data';
import type { VehicleModelId } from '@/types/f1';
import type { WeatherSyncState } from './weather';
import type { TyreVisualState } from './simulator-car';
import type { GroundQuery } from './f12026-car/TrackColliderQuery';
import { getOnlineConfig, onlineApiBase, onlineSocketUrl } from '@/lib/net/online-config';
import {
  PEER_ID_RE,
  sanitizeControl,
  sanitizePacket,
  type CarClassRule,
  type CollisionMode,
  type ControlEnvelope,
  type ControlMessage,
  type LobbyPlayer,
  type LobbySettings,
  type LobbyState,
  type NetworkVehiclePacket,
  type PeerRaceProgress,
  type RaceStartInfo,
} from '@/lib/net/wire';

// What goes over the wire, and the checks on it, live in a module of their own (the race server reads them too)
export { sanitizePacket };
export type { CarClassRule, CollisionMode, LobbyPlayer, LobbySettings, LobbyState, NetworkVehiclePacket, PeerRaceProgress, RaceStartInfo };

export interface InterpolatedPeerState {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  /** Car model to render (undefined: the AMR / F1Physics2026 car, as the AI field drives) */
  vehicle?: VehicleModelId;
  /** Sender's circuit, when it reports one */
  trackId?: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  linearVelocity: THREE.Vector3;
  steerAngle: number;
  wheelRPMs: [number, number, number, number];
  throttle: number;
  brake: number;
  trackS: number;
  speedKmh: number;
  isAiPeer: boolean;
  /** Remote player's name */
  name?: string;
  race?: PeerRaceProgress;
  /** Drawn translucent and never collides (the personal-best ghost) */
  ghost?: boolean;
  /** Yaw rate (rad/s, + turning right), for car-to-car contact */
  yawRateRadS?: number;
  /** False while the pose is a guess (packets stale, just appeared, just jumped): no contact then */
  contactReady?: boolean;
  /** The car reports itself a hazard (an open race's fair-play rule, contact-guard.ts) */
  hazard?: boolean;
  /** Passing through the player's car for now (a hazard, or a ram): drawn translucent, still a car in every other way */
  passThrough?: boolean;
  /** Engine rpm and gear, when the car reports them (the AI field; remote players' are estimated from wheel speed) */
  rpm?: number;
  gear?: number;
  /** Touched another car this frame (the AI field's contact solver) */
  contact?: boolean;
  /**
   * The car's track collider and, from the AI field, its own tyres: the rig seats its wheels per corner at the drawn
   * pose as it does the player's, so the body keeps its heave (a replayed AI car, without tyres, rests its wheels on
   * the road). Absent (remote players, the ghost): the wheels stay on the car frame's origin plane.
   */
  wheels?: { tyres?: readonly TyreVisualState[]; ground: GroundQuery | null };
}

export interface PeerNetStats {
  peerId: string;
  name: string;
  code: string;
  /** Round trip (ms); null before the first pong */
  rttMs: number | null;
  /** Lost state packets over the last ~5 s (%) */
  lossPct: number;
  /** Packet arrival jitter (ms) */
  jitterMs: number;
  /** Reaches us through the host rather than directly */
  relayed: boolean;
}

export interface DriverIdentity {
  name: string;
  code: string;
  color: string;
}

const TURN_STORAGE_KEY = 'bugesera.turn';

/** A TURN server the player entered (multiplayer → advanced), or null */
export function loadUserTurnServer(): RTCIceServer | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TURN_STORAGE_KEY) : null;
    if (!raw) return null;
    const v = JSON.parse(raw) as { urls?: unknown; username?: unknown; credential?: unknown };
    if (typeof v.urls !== 'string' || !/^turns?:/i.test(v.urls)) return null;
    return {
      urls: v.urls.slice(0, 256),
      username: typeof v.username === 'string' ? v.username.slice(0, 128) : undefined,
      credential: typeof v.credential === 'string' ? v.credential.slice(0, 256) : undefined,
    };
  } catch {
    return null;
  }
}

/** Saves (or with null clears) the player's TURN server; used by connections made after this */
export function saveUserTurnServer(server: { urls: string; username?: string; credential?: string } | null): void {
  try {
    if (server && /^turns?:/i.test(server.urls.trim())) {
      localStorage.setItem(TURN_STORAGE_KEY, JSON.stringify({ ...server, urls: server.urls.trim() }));
    } else {
      localStorage.removeItem(TURN_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable: no TURN server
  }
}

/** Connection servers a room server sent: only well-formed stun / turn entries are kept */
export function sanitizeIceServers(raw: unknown): RTCIceServer[] {
  if (!Array.isArray(raw)) return [];
  const out: RTCIceServer[] = [];
  for (const entry of raw.slice(0, 8)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const urls = (Array.isArray(e.urls) ? e.urls : [e.urls]).filter(
      (u): u is string => typeof u === 'string' && u.length <= 256 && /^(stun|turns?):/i.test(u)
    );
    if (urls.length === 0) continue;
    const server: RTCIceServer = { urls };
    if (typeof e.username === 'string') server.username = e.username.slice(0, 512);
    if (typeof e.credential === 'string') server.credential = e.credential.slice(0, 512);
    out.push(server);
  }
  return out;
}

/**
 * STUN, plus relays for networks that block a direct link: the room server's (`room`), one from the build
 * (NEXT_PUBLIC_TURN_*) and / or the player's own
 */
function iceServers(room: readonly RTCIceServer[] = []): RTCIceServer[] {
  const servers: RTCIceServer[] = [...GOOGLE_STUN_SERVERS, ...room];
  const envUrls = process.env.NEXT_PUBLIC_TURN_URLS;
  if (envUrls) {
    const urls = envUrls.split(',').map((u) => u.trim()).filter((u) => /^turns?:/i.test(u));
    if (urls.length > 0) {
      servers.push({
        urls,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
      });
    }
  }
  const user = loadUserTurnServer();
  if (user) servers.push(user);
  return servers;
}

const hasRelay = (servers: readonly RTCIceServer[]): boolean =>
  servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));

/** True when a TURN relay is configured in the build or by the player */
export function hasTurnServer(): boolean {
  return hasRelay(iceServers());
}

export interface P2PConnectionStatus {
  mode: 'local' | 'room_host' | 'room_guest' | 'manual_sdp' | 'race_server';
  roomCode: string;
  state: 'idle' | 'signaling' | 'connected' | 'error';
  connectedWebRtcPeers: number;
  statusText: string;
}

/** Where this player stands with the scheduled races (the race server, cloudflare/api/race.ts) */
export interface ScheduledRaceStatus {
  /** idle: not entered. joining: asking the server. joined: in the next race's lobby, or racing it */
  state: 'idle' | 'joining' | 'joined' | 'error';
  /** When the entered race's lights start, on this device's clock (epoch ms) */
  startsMs: number | null;
  /** Why entering failed, or the entry was lost */
  text: string;
}

interface PeerSnapshotBuffer {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  isAiPeer: boolean;
  /** Packet statistics: sequence numbers seen, arrivals and jitter */
  lastSeq: number;
  seqWindow: { received: number; expected: number; startMs: number };
  lossPct: number;
  lastArrivalMs: number;
  jitterMs: number;
  snapshots: NetworkVehiclePacket[];
  lastReceivedMs: number;
  /** Filtered offset (localNowMs - senderTimestampMs) so sender dt is preserved without arrival jitter */
  clockOffsetMs: number | null;
  /** Newest sender timestamp accepted (ms, the sender's clock): older packets arrived out of order */
  lastSenderTimestampMs: number;
  renderedState: InterpolatedPeerState;
  /** Present-time prediction (human peers): the blended-out correction, the newest snapshot used, the last frame */
  predict: {
    corrPos: THREE.Vector3;
    corrQuat: THREE.Quaternion;
    newestTs: number;
    lastMs: number;
    graceUntilMs: number;
    primed: boolean;
  };
}

interface WebRtcPeerEntry {
  remoteId: string;
  pc: RTCPeerConnection;
  /** Unreliable, unordered state channel */
  dc: RTCDataChannel | null;
  /** Reliable, ordered control channel (lobby, start, pings); absent with older clients */
  ctl?: RTCDataChannel | null;
  /**
   * Game peer id behind this connection. On the host: bound by the guest's first message, and every later message on
   * the connection must carry it. On a guest (whose one connection is the host): the host's id, once its lobby arrives.
   */
  gamePeerId?: string;
  /** Host: messages accepted from this guest in the current one-second window (flood limit) */
  rate?: { windowStartMs: number; state: number; control: number };
}

/** Host: a guest sending more than this per second is flooding; the excess is dropped, not ingested or relayed */
const MAX_STATE_PACKETS_PER_S = 60;
const MAX_CONTROL_MESSAGES_PER_S = 20;
/** Only these control messages are passed between guests; the lobby, start and abort come from the host alone */
const RELAYED_CONTROL: ReadonlySet<ControlMessage['type']> = new Set(['hello', 'ready', 'ping', 'pong']);
/** A guest follows a different host only after its own has sent no lobby for this long (ms) */
const HOST_SILENT_MS = 8000;
/** How long a WebRTC connection may sit in `disconnected` (often a brief ICE blip) before the peer is dropped */
const DISCONNECT_GRACE_MS = 5000;

const STATE_CHANNEL = 'f1-telemetry';
const CONTROL_CHANNEL = 'f1-control';

/** The public PeerJS broker that pairs room codes (it only passes the connection offers; races run peer to peer) */
const BROKER_URL = 'wss://0.peerjs.com/peerjs?key=peerjs';
/**
 * The broker drops a socket that sends nothing for about 90 s (measured: 99 s), and says nothing to the players: a
 * host waiting for a friend vanished from it while the panel still read "ready". PeerJS's own client pings every 5 s.
 */
const BROKER_HEARTBEAT_MS = 5000;
const BROKER_HEARTBEAT = JSON.stringify({ type: 'HEARTBEAT' });
/** Host: waits before putting the room back on the broker after losing it (ms, then the last one each time) */
const BROKER_RETRY_MS = [1000, 3000, 5000, 10000];
/** Guest: an offer with no answer in this long means no host is there (the broker doesn't reliably say so) */
const JOIN_TIMEOUT_MS = 15000;

/** How often a lost race-server socket is reopened during a race before giving up, and the pauses between (ms) */
const RACE_RECONNECT_MS = [500, 1500, 3000, 5000];
const RACE_REFUSALS: Record<string, string> = {
  closed: 'That race is about to start. You are in time for the next one.',
  full: 'That race is full. Join the next one.',
  started: 'That race has started without you. Join the next one.',
  taken: 'You are already in this race in another window.',
  bad: "Couldn't join the race. Reload the game and try again.",
};

/** The room server answers a literal "ping" without waking up; sent this often to keep the socket alive (ms) */
const ROOM_SERVER_PING_MS = 30000;
/** Connection ids of a room server's players: the host as seen by a guest, a guest (with its server id) by the host */
const ROOM_HOST_ID = 'room_host';
const ROOM_GUEST_PREFIX = 'room_guest_';
const HOST_TOKEN_KEY = 'lc.roomHostToken';

const BROKER_UNREACHABLE =
  "Couldn't reach the room server. Check your connection and try again, or use a manual connection under Advanced.";

const GOOGLE_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

/** A raw clock offset this far (ms) from the filtered one is a clock step, not jitter: snap to it */
const CLOCK_OFFSET_SNAP_MS = 250;
/** A sender timestamp this far (ms) behind the newest accepted one is a restarted clock, not an out-of-order packet */
const SENDER_CLOCK_RESTART_MS = 1000;
/**
 * Remote players are drawn and collided where they are now: the newest packet carried forward by its age plus the
 * one-way latency, at most this far (s). Past it the packets are stale and the car can't be touched.
 */
const PREDICT_MAX_S = 0.3;
/** A new packet's correction to the prediction blends out over this time constant (s) */
const PREDICT_SMOOTH_S = 0.1;
/** A correction this large (m) is a reset or teleport: snap to it, and hold contact off for PREDICT_GRACE_MS */
const PREDICT_SNAP_M = 3;
const PREDICT_GRACE_MS = 400;
/** The acceleration the prediction carries forward is clamped to this (m/s²) */
const PREDICT_MAX_ACCEL_MS2 = 60;
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export class MultiplayerSyncManager {
  public readonly localPeerId: string;
  private channel: BroadcastChannel | null = null;
  private ws: WebSocket | null = null;
  private signalingWs: WebSocket | null = null;
  private brokerHeartbeat: ReturnType<typeof setInterval> | null = null;
  private brokerRetry: ReturnType<typeof setTimeout> | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  /** The socket to a scheduled race's server, which stands in for a host and passes every car's state on */
  private raceWs: WebSocket | null = null;
  /** The entered race's number (to get back into it after a lost socket) and this page's secret for it */
  private raceIndex: number | null = null;
  private raceToken = '';
  private raceRetry: ReturnType<typeof setTimeout> | null = null;
  /**
   * Car state from the race server waiting for the next frame, newest per car. Its socket delivers in order, so after
   * a network stall a second of packets lands at once: ingesting them all would read the first as a clock jump and
   * throw the car's history away. Only the newest matters to a car drawn where it is now.
   */
  private raceInbox = new Map<string, { pkt: NetworkVehiclePacket; atMs: number }>();
  public raceStatus: ScheduledRaceStatus = { state: 'idle', startsMs: null, text: '' };
  public onRaceStatusChange?: (status: ScheduledRaceStatus) => void;
  /** Who introduces this room's players: this site's room server, or the public PeerJS broker */
  private signalVia: 'server' | 'broker' = 'broker';
  /** Counts every closed signalling socket: a room opened after an await checks it is still the one wanted */
  private signalGen = 0;
  /** Connection servers the room server sent for this room (relays for networks that block a direct link) */
  private roomIce: RTCIceServer[] = [];
  private rtcPeers = new Map<string, WebRtcPeerEntry>();
  private manualPendingPc: RTCPeerConnection | null = null;

  private peers = new Map<string, PeerSnapshotBuffer>();
  private lastBroadcastMs = 0;
  private readonly broadcastIntervalMs = 40; // 25 Hz (within 20-30 Hz spec)
  private readonly interpolationDelayMs = 65; // 65ms jitter buffer for cubic Hermite interpolation

  public status: P2PConnectionStatus = {
    mode: 'local',
    roomCode: '',
    state: 'idle',
    connectedWebRtcPeers: 0,
    statusText: "Host a room and send the link, or join with a friend's code.",
  };
  public onStatusChange?: (status: P2PConnectionStatus) => void;

  /** This client runs the lobby and times the races (room host, manual-offer host, or a local-tab host) */
  public isHost = false;
  /** The host's peer id, once known */
  public hostId: string | null = null;
  public lobby: LobbyState | null = null;
  public onLobbyChange?: (lobby: LobbyState | null) => void;
  /** Host: the session's weather, sent with every lobby update so the guests drive in the same conditions */
  public weatherProvider?: () => WeatherSyncState | null;
  public onRaceStart?: (start: RaceStartInfo) => void;
  public onRaceAbort?: (id: string) => void;
  private identity: DriverIdentity = { name: 'Driver', code: 'DRV', color: '#E10600' };
  private localVehicle: VehicleModelId | undefined;
  private localTrackId: string | undefined;
  private localReady = false;
  /** Host-side lobby members (not including the host) */
  private members = new Map<string, LobbyPlayer>();
  /** Host: when each member was last heard from (any message or state packet; performance.now ms) */
  private memberSeenMs = new Map<string, number>();
  /** Host: members dropped for silence, kept so their next packet puts them back (a guest only says hello once) */
  private lapsedMembers = new Map<string, LobbyPlayer>();
  private lobbySettings: LobbySettings = { trackId: DEFAULT_TRACK_ID, laps: 5, collisions: 'ghost_lap1', carClass: 'any' };
  private activeRace: RaceStartInfo | null = null;
  /**
   * Guest: the race this client is done with (left with leaveRace, or ended by the host); neither a repeated start
   * nor a lobby still showing it puts this player back in it
   */
  private doneRaceId: string | null = null;
  /** hostClock − localClock (ms); 0 on the host */
  private clockOffsetMs = 0;
  private bestClockRttMs = Infinity;
  private rtts = new Map<string, number>();
  private seq = 0;
  private lastPingMs = 0;
  private lastLobbyMs = 0;
  /** Guest: when the host's last lobby arrived (performance.now ms) */
  private lastHostLobbyMs = 0;

  // Reusable math temporaries
  private tempQuat0 = new THREE.Quaternion();
  private tempQuat1 = new THREE.Quaternion();
  private tempQuat2 = new THREE.Quaternion();
  private tempVec0 = new THREE.Vector3();
  private tempVec1 = new THREE.Vector3();
  /**
   * Human peers drawn where they are now (`predictPeer`) rather than interpolated 65 ms + latency in the past: at
   * racing speed that is 5 m or more, so cars touched where the other car no longer was and missed where it was.
   */
  public predictRemotePlayers = true;
  private tempUp = new THREE.Vector3(0, 1, 0);
  private tempRight = new THREE.Vector3();
  private tempForward = new THREE.Vector3();
  private tempMatrix = new THREE.Matrix4();

  constructor() {
    this.localPeerId = `peer_${Math.random().toString(36).slice(2, 9)}`;
    this.initTransports();
  }

  /** WebRTC peers whose state channel is open */
  private openPeerCount(): number {
    let openCount = 0;
    for (const entry of this.rtcPeers.values()) {
      if (entry.dc && entry.dc.readyState === 'open') {
        openCount++;
      }
    }
    return openCount;
  }

  private emitStatus(patch: Partial<P2PConnectionStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      connectedWebRtcPeers: this.openPeerCount(),
    };
    this.onStatusChange?.({ ...this.status });
  }

  private initTransports(): void {
    if (typeof window === 'undefined') return;

    if ('BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('kigali_f1_sim_net_v1');
        this.channel.onmessage = (ev: MessageEvent<NetworkVehiclePacket | ControlEnvelope>) => {
          const data = ev.data as Partial<ControlEnvelope> & Partial<NetworkVehiclePacket>;
          // In a scheduled race only its server counts: another tab's lobby or cars would read as a second host
          if (!data || typeof data !== 'object' || this.inScheduledRace) return;
          if (data.ctl) {
            this.handleEnvelope(data as ControlEnvelope, null);
          } else {
            const pkt = sanitizePacket(data);
            if (pkt && pkt.peerId !== this.localPeerId) this.ingestPacket(pkt, false);
          }
        };
      } catch {
        // BroadcastChannel unavailable in restricted context
      }
    }

    const wsUrl = process.env.NEXT_PUBLIC_SIM_WS_URL;
    if (wsUrl) {
      try {
        this.ws = new WebSocket(wsUrl);
        this.ws.onmessage = (ev) => {
          try {
            if (typeof ev.data !== 'string' || ev.data.length > 16384) return;
            const pkt = sanitizePacket(JSON.parse(ev.data));
            if (pkt && pkt.peerId !== this.localPeerId) {
              this.ingestPacket(pkt, false);
            }
          } catch {
            // Ignore malformed WS message
          }
        };
      } catch {
        // Ignore WS connection error
      }
    }
  }

  /**
   * Generates a random 6-character alphanumeric room code.
   */
  public static generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  /**
   * Hosts a serverless WebRTC P2P Room using the public PeerJS Cloud Broker (`0.peerjs.com`)
   * and Google Public STUN (`stun:stun.l.google.com:19302`).
   */
  public hostRoom(customCode?: string): string {
    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      return '';
    }
    this.closeSignaling();
    this.becomeHost();
    const roomCode = (customCode || MultiplayerSyncManager.generateRoomCode())
      .trim()
      .toUpperCase()
      .slice(0, 6);

    this.emitStatus({
      mode: 'room_host',
      roomCode,
      state: 'signaling',
      statusText: `Opening room ${roomCode}…`,
    });
    this.viaRoomServer((server) => (server ? this.connectHostServer(roomCode, 0) : this.connectHostBroker(roomCode, 0)));
    return roomCode;
  }

  /**
   * Runs `open` with whether this site's room server pairs room codes (asked at run time; without an online side it
   * is the public broker, at once). Dropped when another room was opened or this one left meanwhile.
   */
  private viaRoomServer(open: (server: boolean) => void): void {
    this.roomIce = [];
    if (!onlineApiBase) {
      this.signalVia = 'broker';
      open(false);
      return;
    }
    const gen = this.signalGen;
    void getOnlineConfig().then((config) => {
      if (gen !== this.signalGen) return;
      this.signalVia = config.rooms ? 'server' : 'broker';
      open(config.rooms);
    });
  }

  /** Host: after losing the room's signalling socket, opens it again after a pause (longer each time) */
  private putRoomBack(ws: WebSocket, roomCode: string, attempt: number, connect: (roomCode: string, attempt: number) => void): void {
    if (this.signalingWs !== ws) return;
    this.closeSignaling();
    this.brokerRetry = setTimeout(() => {
      this.brokerRetry = null;
      connect(roomCode, attempt + 1);
    }, BROKER_RETRY_MS[Math.min(attempt, BROKER_RETRY_MS.length - 1)]);
    if (this.openPeerCount() === 0) {
      this.emitStatus({ state: 'signaling', statusText: `Reconnecting room ${roomCode}…` });
    }
  }

  /** This browser's secret for the rooms it hosts: the room server lets the same host take its room back */
  private hostToken(): string {
    try {
      const saved = sessionStorage.getItem(HOST_TOKEN_KEY);
      if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
    } catch {
      // Storage blocked: a token for this page only
    }
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      sessionStorage.setItem(HOST_TOKEN_KEY, token);
    } catch {
      // Storage blocked
    }
    return token;
  }

  /** Opens a socket on this site's room server, pinging it so it stays open */
  private openRoomServer(path: string): WebSocket {
    this.closeSignaling();
    const url = onlineSocketUrl(path);
    if (!url) throw new Error('No room server');
    const ws = new WebSocket(url);
    this.signalingWs = ws;
    this.brokerHeartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, ROOM_SERVER_PING_MS);
    return ws;
  }

  /**
   * Host: opens the room on this site's room server, and opens it again whenever the socket is lost (a phone's
   * network change, the page in the background), so guests can still find it. `attempt` > 0 is such a reconnect.
   */
  private connectHostServer(roomCode: string, attempt: number): void {
    let ws: WebSocket;
    try {
      ws = this.openRoomServer(`/rooms/${encodeURIComponent(roomCode)}?role=host&token=${this.hostToken()}`);
    } catch {
      this.emitStatus({ state: 'error', roomCode: '', statusText: BROKER_UNREACHABLE });
      return;
    }
    let opened = false;
    const reconnect = (code: string, next: number) => this.connectHostServer(code, next);

    ws.onmessage = async (ev) => {
      if (this.signalingWs !== ws || typeof ev.data !== 'string' || ev.data === 'pong') return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'welcome') {
          opened = true;
          attempt = 0;
          this.roomIce = sanitizeIceServers(msg.iceServers);
          if (this.openPeerCount() === 0) {
            this.emitStatus({ state: 'signaling', statusText: `Room ${roomCode} is open • waiting for players` });
          }
        } else if (msg.t === 'taken') {
          this.closeSignaling();
          this.emitStatus({
            state: 'error',
            roomCode: '',
            statusText: `Room ${roomCode} is already open on another device. Press Join to race in it, or host a new room.`,
          });
        } else if (msg.t === 'signal' && typeof msg.from === 'string' && /^[a-f0-9]{12}$/.test(msg.from)) {
          const remoteId = `${ROOM_GUEST_PREFIX}${msg.from}`;
          if (msg.data?.sdp) {
            const answer = await this.answerOffer(remoteId, msg.data.sdp, remoteId);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'signal', to: msg.from, data: { sdp: answer } }));
          } else if (msg.data?.candidate) {
            const entry = this.rtcPeers.get(remoteId);
            if (entry) await entry.pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate));
          }
        }
      } catch {
        // Ignore a malformed message
      }
    };

    ws.onclose = () => {
      if (this.signalingWs !== ws) return; // Closed on purpose: another room, left, or the code was taken
      if (!opened && attempt === 0) {
        this.signalingWs = null;
        this.clearBrokerTimers();
        this.emitStatus({ state: 'error', roomCode: '', statusText: BROKER_UNREACHABLE });
        return;
      }
      this.putRoomBack(ws, roomCode, attempt, reconnect);
    };
  }

  /**
   * Host: puts the room on the broker, and puts it back whenever the broker drops it (a phone's network change, the
   * page in the background), so guests can still find it. `attempt` > 0 is such a reconnect.
   */
  private connectHostBroker(roomCode: string, attempt: number): void {
    let ws: WebSocket;
    try {
      ws = this.openBroker(`rwanda2026_room_${roomCode}_host`);
    } catch {
      this.emitStatus({ state: 'error', roomCode: '', statusText: BROKER_UNREACHABLE });
      return;
    }
    let opened = false;
    /**
     * The broker dropped or refused the room after it had been up (or on a reconnect): put it back after a pause. The
     * socket is closed here, not left to the broker: a refused socket it keeps open would be held up by the heartbeat
     * and never retried. The players already in race on peer to peer meanwhile, and keep their status.
     */
    const putBack = () => this.putRoomBack(ws, roomCode, attempt, (code, next) => this.connectHostBroker(code, next));

    ws.onmessage = async (ev) => {
      if (this.signalingWs !== ws) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'OPEN') {
          opened = true;
          attempt = 0;
          if (this.openPeerCount() === 0) {
            this.emitStatus({ state: 'signaling', statusText: `Room ${roomCode} is open • waiting for players` });
          }
        } else if (msg.type === 'ID-TAKEN') {
          // On a reconnect it is this room's own old socket, which the broker hasn't cleared yet: try again shortly
          if (attempt > 0) {
            putBack();
            return;
          }
          this.closeSignaling();
          this.emitStatus({
            state: 'error',
            roomCode: '',
            statusText: `Room ${roomCode} is already open on another device. Press Join to race in it, or host a new room.`,
          });
        } else if (msg.type === 'ERROR' || msg.type === 'INVALID-KEY') {
          // Refused before the room ever opened: say so. Refused once it had been up: put it back, as after a drop
          if (opened || attempt > 0) {
            putBack();
            return;
          }
          this.closeSignaling();
          this.emitStatus({ state: 'error', roomCode: '', statusText: BROKER_UNREACHABLE });
        } else if (msg.type === 'OFFER' && msg.src && msg.payload?.sdp) {
          await this.handleBrokerOffer(msg.src, msg.payload.sdp, msg.payload.connectionId);
        } else if (msg.type === 'CANDIDATE' && msg.src && msg.payload?.candidate) {
          const entry = this.rtcPeers.get(msg.src);
          if (entry) {
            await entry.pc.addIceCandidate(new RTCIceCandidate(msg.payload.candidate));
          }
        }
      } catch {
        // Ignore malformed broker message
      }
    };

    ws.onclose = () => {
      if (this.signalingWs !== ws) return; // Closed on purpose: another room, left, or the code was taken
      if (!opened && attempt === 0) {
        this.signalingWs = null;
        this.clearBrokerTimers();
        this.emitStatus({ state: 'error', roomCode: '', statusText: BROKER_UNREACHABLE });
        return;
      }
      putBack();
    };
  }

  /**
   * Joins an existing 6-character WebRTC P2P Room via the public PeerJS Cloud Broker.
   */
  public joinRoom(rawCode: string): void {
    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      return;
    }
    const roomCode = rawCode.trim().toUpperCase().slice(0, 6);
    if (!roomCode) return;

    this.closeSignaling();
    this.becomeGuest();
    this.emitStatus({
      mode: 'room_guest',
      roomCode,
      state: 'signaling',
      statusText: `Joining room ${roomCode}…`,
    });
    this.viaRoomServer((server) => (server ? this.joinRoomServer(roomCode) : this.joinRoomBroker(roomCode)));
  }

  /** Guest: makes the connection to the host with both channels and returns the offer to send it */
  private async offerToHost(hostRemoteId: string, connId: string): Promise<RTCSessionDescription | null> {
    const pc = this.createPeerConnection(hostRemoteId, connId);
    const dc = pc.createDataChannel(STATE_CHANNEL, {
      ordered: false,
      maxRetransmits: 0,
    });
    const ctl = pc.createDataChannel(CONTROL_CHANNEL, { ordered: true });
    const entry: WebRtcPeerEntry = { remoteId: hostRemoteId, pc, dc, ctl };
    this.rtcPeers.set(hostRemoteId, entry);
    this.bindDataChannel(hostRemoteId, dc);
    this.bindControlChannel(entry, ctl);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return pc.localDescription;
  }

  /** Guest: joins a room through this site's room server, which says at once when nobody hosts the code */
  private joinRoomServer(roomCode: string): void {
    let ws: WebSocket;
    try {
      ws = this.openRoomServer(`/rooms/${encodeURIComponent(roomCode)}?role=guest`);
    } catch {
      this.emitStatus({ state: 'error', roomCode: '', statusText: BROKER_UNREACHABLE });
      return;
    }
    /** The host answered: from here the connection is peer to peer, and losing the room server no longer matters */
    let answered = false;
    const fail = (statusText: string) => {
      this.closeSignaling();
      this.dropUnansweredPeer(ROOM_HOST_ID);
      this.emitStatus({ state: 'error', roomCode: '', statusText });
    };
    const notFound = () => fail(`Couldn't find room ${roomCode}. Check the code, and ask the host to keep the game open on screen.`);

    ws.onmessage = async (ev) => {
      if (this.signalingWs !== ws || typeof ev.data !== 'string' || ev.data === 'pong') return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'welcome') {
          this.roomIce = sanitizeIceServers(msg.iceServers);
          const sdp = await this.offerToHost(ROOM_HOST_ID, ROOM_HOST_ID);
          if (this.signalingWs !== ws) return;
          ws.send(JSON.stringify({ t: 'signal', data: { sdp } }));
          this.joinTimer = setTimeout(() => {
            this.joinTimer = null;
            if (!answered) notFound();
          }, JOIN_TIMEOUT_MS);
        } else if (msg.t === 'nohost') {
          notFound();
        } else if (msg.t === 'full') {
          fail(`Room ${roomCode} is full.`);
        } else if (msg.t === 'signal' && msg.data?.sdp) {
          const entry = this.rtcPeers.get(ROOM_HOST_ID);
          if (entry) {
            answered = true;
            if (this.joinTimer !== null) clearTimeout(this.joinTimer);
            this.joinTimer = null;
            await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp));
          }
        } else if (msg.t === 'signal' && msg.data?.candidate) {
          const entry = this.rtcPeers.get(ROOM_HOST_ID);
          if (entry) await entry.pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate));
        }
      } catch {
        // Ignore a malformed message
      }
    };

    ws.onclose = () => {
      if (this.signalingWs !== ws) return; // Closed on purpose
      this.signalingWs = null;
      this.clearBrokerTimers();
      if (!answered) fail(BROKER_UNREACHABLE);
    };
  }

  /** Guest: joins a room through the public PeerJS broker */
  private joinRoomBroker(roomCode: string): void {
    const guestBrokerId = `rwanda2026_room_${roomCode}_guest_${Math.random().toString(36).slice(2, 7)}`;
    const hostBrokerId = `rwanda2026_room_${roomCode}_host`;
    const connId = `dc_${Math.random().toString(36).slice(2, 9)}`;

    let ws: WebSocket;
    try {
      ws = this.openBroker(guestBrokerId);
    } catch {
      this.emitStatus({ state: 'error', roomCode: '', statusText: BROKER_UNREACHABLE });
      return;
    }
    /** The host answered: from here the connection is peer to peer, and losing the broker no longer matters */
    let answered = false;
    const fail = (statusText: string) => {
      this.closeSignaling();
      this.dropUnansweredPeer(hostBrokerId);
      this.emitStatus({ state: 'error', roomCode: '', statusText });
    };
    const notFound = () =>
      fail(`Couldn't find room ${roomCode}. Check the code, and ask the host to keep the game open on screen.`);

    ws.onmessage = async (ev) => {
      if (this.signalingWs !== ws) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'OPEN') {
          const sdp = await this.offerToHost(hostBrokerId, connId);
          if (this.signalingWs !== ws) return;

          ws.send(
            JSON.stringify({
              type: 'OFFER',
              dst: hostBrokerId,
              payload: {
                sdp,
                type: 'data',
                connectionId: connId,
                // The broker now drops an offer without the PeerJS client's `label` and `serialization`, and hangs up
                // on the sender (seen 2026-11-08): with them it is passed on. The host ignores them.
                label: connId,
                reliable: false,
                serialization: 'binary',
              },
            })
          );
          this.joinTimer = setTimeout(() => {
            this.joinTimer = null;
            if (!answered) notFound();
          }, JOIN_TIMEOUT_MS);
        } else if (msg.type === 'EXPIRE' && msg.src === hostBrokerId) {
          // The broker couldn't deliver the offer: no host with this code
          if (!answered) notFound();
        } else if (msg.type === 'ID-TAKEN' || msg.type === 'ERROR' || msg.type === 'INVALID-KEY') {
          // Once the host has answered the broker no longer matters: a late error must not close the working link
          if (!answered) fail(BROKER_UNREACHABLE);
        } else if (msg.type === 'ANSWER' && msg.src && msg.payload?.sdp) {
          const entry = this.rtcPeers.get(msg.src);
          if (entry) {
            answered = true;
            if (this.joinTimer !== null) clearTimeout(this.joinTimer);
            this.joinTimer = null;
            await entry.pc.setRemoteDescription(
              new RTCSessionDescription(msg.payload.sdp)
            );
          }
        } else if (msg.type === 'CANDIDATE' && msg.src && msg.payload?.candidate) {
          const entry = this.rtcPeers.get(msg.src);
          if (entry) {
            await entry.pc.addIceCandidate(
              new RTCIceCandidate(msg.payload.candidate)
            );
          }
        }
      } catch {
        // Ignore signaling parse error
      }
    };

    ws.onclose = () => {
      if (this.signalingWs !== ws) return; // Closed on purpose
      this.signalingWs = null;
      this.clearBrokerTimers();
      if (!answered) fail(BROKER_UNREACHABLE);
    };
  }

  /** Opens this client's socket on the public broker as `brokerId`, pinging it so the broker keeps it */
  private openBroker(brokerId: string): WebSocket {
    this.closeSignaling();
    const token = Math.random().toString(36).slice(2, 10);
    const ws = new WebSocket(`${BROKER_URL}&id=${encodeURIComponent(brokerId)}&token=${encodeURIComponent(token)}`);
    this.signalingWs = ws;
    this.brokerHeartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(BROKER_HEARTBEAT);
    }, BROKER_HEARTBEAT_MS);
    return ws;
  }

  private clearBrokerTimers(): void {
    if (this.brokerHeartbeat !== null) clearInterval(this.brokerHeartbeat);
    if (this.brokerRetry !== null) clearTimeout(this.brokerRetry);
    if (this.joinTimer !== null) clearTimeout(this.joinTimer);
    this.brokerHeartbeat = null;
    this.brokerRetry = null;
    this.joinTimer = null;
  }

  /** Guest: closes the connection it offered to a host that never answered */
  private dropUnansweredPeer(remoteId: string): void {
    const entry = this.rtcPeers.get(remoteId);
    if (!entry) return;
    this.rtcPeers.delete(remoteId);
    entry.pc.onconnectionstatechange = null;
    if (entry.dc) entry.dc.onclose = null;
    if (entry.ctl) entry.ctl.onclose = null;
    try {
      entry.dc?.close();
      entry.ctl?.close();
      entry.pc.close();
    } catch {
      // Ignore close error
    }
  }

  /** Host: takes a guest's offer and returns the answer to send back */
  private async answerOffer(
    remoteId: string,
    sdp: RTCSessionDescriptionInit,
    connectionId: string
  ): Promise<RTCSessionDescription | null> {
    const pc = this.createPeerConnection(remoteId, connectionId);
    const entry: WebRtcPeerEntry = { remoteId, pc, dc: null };
    this.rtcPeers.set(remoteId, entry);
    pc.ondatachannel = (ev) => this.acceptChannel(entry, ev.channel);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription;
  }

  private async handleBrokerOffer(
    remoteId: string,
    sdp: RTCSessionDescriptionInit,
    connectionId: string
  ): Promise<void> {
    const localDescription = await this.answerOffer(remoteId, sdp, connectionId);

    if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
      this.signalingWs.send(
        JSON.stringify({
          type: 'ANSWER',
          dst: remoteId,
          payload: {
            sdp: localDescription,
            type: 'data',
            connectionId,
          },
        })
      );
    }
  }

  private createPeerConnection(
    remoteId: string,
    connectionId: string
  ): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers(this.roomIce) });

    pc.onicecandidate = (ev) => {
      const ws = this.signalingWs;
      if (!ev.candidate || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.signalVia === 'server') {
        // The host names the guest; a guest's only peer is the host
        const guest = remoteId.startsWith(ROOM_GUEST_PREFIX) ? remoteId.slice(ROOM_GUEST_PREFIX.length) : undefined;
        const data = { candidate: ev.candidate };
        ws.send(JSON.stringify(guest ? { t: 'signal', to: guest, data } : { t: 'signal', data }));
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'CANDIDATE',
          dst: remoteId,
          payload: {
            candidate: ev.candidate,
            type: 'data',
            connectionId,
          },
        })
      );
    };

    // `disconnected` is often a short ICE blip that recovers by itself (same pc, same channels): give it a grace
    // period before giving up on the peer, rather than dropping it on the first wobble
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearGrace = () => {
      if (graceTimer !== null) clearTimeout(graceTimer);
      graceTimer = null;
    };
    const lose = () => {
      clearGrace();
      const entry = this.rtcPeers.get(remoteId);
      if (!entry || entry.pc !== pc) return;
      const neverOpened = !entry.dc || entry.dc.readyState !== 'open';
      this.losePeer(entry, pc.connectionState === 'failed' && neverOpened);
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') clearGrace();
      else if (state === 'failed' || state === 'closed') lose();
      else if (state === 'disconnected' && graceTimer === null) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (pc.connectionState === 'disconnected') lose();
        }, DISCONNECT_GRACE_MS);
      }
    };

    return pc;
  }

  /**
   * The one way a WebRTC peer goes, whichever noticed first: its state channel closing, or the connection failing or
   * staying disconnected past the grace period (they come in either order). Forgets it, closes the whole connection,
   * drops its lobby member, then says what that leaves. `strictNat`: it failed without ever opening.
   */
  private losePeer(entry: WebRtcPeerEntry, strictNat = false): void {
    if (this.rtcPeers.get(entry.remoteId) !== entry) return;
    this.rtcPeers.delete(entry.remoteId);
    if (this.manualPendingPc === entry.pc) this.manualPendingPc = null;
    // Silenced first: the closes below must not report the loss a second time
    entry.pc.onconnectionstatechange = null;
    if (entry.dc) entry.dc.onclose = null;
    if (entry.ctl) entry.ctl.onclose = null;
    try {
      entry.dc?.close();
      entry.ctl?.close();
      entry.pc.close();
    } catch {
      // Ignore close error
    }
    if (entry.gamePeerId) this.dropMember(entry.gamePeerId);
    this.emitPeersStatus(strictNat);
  }

  /** The connection status once a peer has gone, from what is still open */
  private emitPeersStatus(strictNat: boolean): void {
    const open = this.openPeerCount();
    if (open > 0) {
      this.emitStatus({ state: 'connected', statusText: open === 1 ? 'Connected to 1 player' : `Connected to ${open} players` });
    } else if (strictNat) {
      this.emitStatus({
        state: 'error',
        statusText: hasRelay(iceServers(this.roomIce))
          ? "Couldn't connect to the other player. Try again, or use the same Wi-Fi."
          : "Couldn't connect: one of your networks blocks direct links. Use the same Wi-Fi, or try another network.",
      });
    } else if (!this.isHost) {
      // A guest's one connection is to its host, and nothing dials it again: say so rather than wait forever
      this.emitStatus({ state: 'error', statusText: 'Lost the host. Join again.' });
    } else if (this.status.mode === 'room_host') {
      const code = this.status.roomCode;
      const up = this.signalingWs !== null && this.signalingWs.readyState === WebSocket.OPEN;
      this.emitStatus({ state: 'signaling', statusText: up ? `Room ${code} is open • waiting for players` : `Reconnecting room ${code}…` });
    } else if (this.status.mode === 'local') {
      this.emitStatus({ state: 'connected', statusText: 'Hosting a race for the tabs of this browser' });
    } else {
      this.emitStatus({ state: 'signaling', statusText: 'Player left. Make a new offer to connect again.' });
    }
  }

  /** Host side: a guest opened a channel (state or control, by label) */
  private acceptChannel(entry: WebRtcPeerEntry, channel: RTCDataChannel): void {
    if (channel.label === CONTROL_CHANNEL) {
      entry.ctl = channel;
      this.bindControlChannel(entry, channel);
    } else {
      entry.dc = channel;
      this.bindDataChannel(entry.remoteId, channel);
    }
  }

  private bindControlChannel(entry: WebRtcPeerEntry, ctl: RTCDataChannel): void {
    ctl.onopen = () => {
      // Introduce ourselves; the host answers with the lobby, a guest starts pinging
      this.sendControl({ type: 'hello', ...this.identity, vehicle: this.localVehicle, trackId: this.localTrackId });
      if (this.isHost) this.broadcastLobby();
    };
    ctl.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > 65536) return;
      try {
        const env = JSON.parse(ev.data) as ControlEnvelope;
        if (!env || typeof env.from !== 'string') return;
        // The host holds each guest to the id it first spoke with, so no guest can speak as another (or as the host)
        if (this.isHost && (!this.bindGuest(entry, env.from) || !this.withinRate(entry, 'control'))) return;
        this.handleEnvelope(env, entry);
      } catch {
        // Ignore malformed control message
      }
    };
  }

  /**
   * Host: ties a guest connection to the game peer id it claims. The first claim binds it, unless the id is the host's
   * own or another connection's; later messages must repeat it. False: drop the message.
   */
  private bindGuest(entry: WebRtcPeerEntry, claimedId: string): boolean {
    if (entry.gamePeerId !== undefined) return entry.gamePeerId === claimedId;
    if (!PEER_ID_RE.test(claimedId) || claimedId === this.localPeerId) return false;
    for (const other of this.rtcPeers.values()) {
      if (other !== entry && other.gamePeerId === claimedId) return false;
    }
    entry.gamePeerId = claimedId;
    return true;
  }

  /** Host: counts a guest's message against its per-second budget; false once the guest is flooding */
  private withinRate(entry: WebRtcPeerEntry, kind: 'state' | 'control'): boolean {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const r = (entry.rate ??= { windowStartMs: now, state: 0, control: 0 });
    if (now - r.windowStartMs >= 1000) {
      r.windowStartMs = now;
      r.state = 0;
      r.control = 0;
    }
    r[kind]++;
    return r[kind] <= (kind === 'state' ? MAX_STATE_PACKETS_PER_S : MAX_CONTROL_MESSAGES_PER_S);
  }

  private bindDataChannel(remoteId: string, dc: RTCDataChannel): void {
    dc.onopen = () => {
      this.emitStatus({
        state: 'connected',
        statusText: 'Connected',
      });
    };
    dc.onclose = () => {
      const entry = this.rtcPeers.get(remoteId);
      if (entry && entry.dc === dc) this.losePeer(entry);
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > 16384) return;
      try {
        const pkt = sanitizePacket(JSON.parse(ev.data));
        if (!pkt || pkt.peerId === this.localPeerId) return;
        if (this.isHost) {
          // A guest may only send its own car, and not too often
          const entry = this.rtcPeers.get(remoteId);
          if (!entry || !this.bindGuest(entry, pkt.peerId) || !this.withinRate(entry, 'state')) return;
        }
        this.ingestPacket(pkt, false);
        // The host relays every guest's state to the other guests (star topology: guests only connect to it). The
        // cleaned packet goes on, never the raw text
        if (this.isHost) this.relay(JSON.stringify(pkt), remoteId, 'state');
      } catch {
        // Ignore malformed packet
      }
    };
  }

  /** Host: forwards a guest's message to every other guest (only to `toPeerId` when it is addressed) */
  private relay(serialized: string, fromRemoteId: string, channel: 'state' | 'control', toPeerId?: string): void {
    for (const entry of this.rtcPeers.values()) {
      if (entry.remoteId === fromRemoteId) continue;
      if (toPeerId !== undefined && entry.gamePeerId !== toPeerId) continue;
      const ch = channel === 'state' ? entry.dc : entry.ctl;
      if (ch && ch.readyState === 'open') {
        try {
          ch.send(serialized);
        } catch {
          // Ignore relay send failure
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Lobby, race start and clock sync (control channel + BroadcastChannel for same-browser tabs)
  // ---------------------------------------------------------------------------------------------

  /** Name, code and colour shown to other players; car and circuit for the lobby */
  public setIdentity(identity: DriverIdentity, vehicle?: VehicleModelId, trackId?: string): void {
    const changed =
      identity.name !== this.identity.name ||
      identity.code !== this.identity.code ||
      identity.color !== this.identity.color ||
      vehicle !== this.localVehicle ||
      trackId !== this.localTrackId;
    this.identity = { ...identity };
    this.localVehicle = vehicle;
    this.localTrackId = trackId;
    if (!changed) return;
    if (this.isHost) {
      if (trackId) this.lobbySettings = { ...this.lobbySettings, trackId };
      this.broadcastLobby();
    } else if (this.hostId) {
      this.sendControl({ type: 'hello', ...this.identity, vehicle, trackId });
    }
  }

  private becomeHost(): void {
    // A guest turning host drops the race it followed: that race ran on the old host's clock and is not its to run
    // (or to advertise and abort). A host hosting again (another manual offer) keeps its race
    const dropped = this.isHost ? null : this.activeRace;
    if (!this.isHost) {
      this.activeRace = null;
      this.doneRaceId = null;
    }
    this.isHost = true;
    this.hostId = this.localPeerId;
    this.clockOffsetMs = 0;
    this.bestClockRttMs = 0;
    if (this.localTrackId) this.lobbySettings = { ...this.lobbySettings, trackId: this.localTrackId };
    this.broadcastLobby();
    if (dropped) this.onRaceAbort?.(dropped.id);
  }

  private becomeGuest(): void {
    // A guest has one connection, to its host: close any left from hosting or from an earlier room
    this.closePeers();
    // Whatever race ran here (our own as host, or an old host's) is not the new host's
    const dropped = this.activeRace;
    this.activeRace = null;
    this.doneRaceId = null;
    this.isHost = false;
    this.hostId = null;
    this.lastHostLobbyMs = 0;
    this.members.clear();
    this.memberSeenMs.clear();
    this.lapsedMembers.clear();
    this.clockOffsetMs = 0;
    this.bestClockRttMs = Infinity;
    this.setLobby(null);
    if (dropped) this.onRaceAbort?.(dropped.id);
  }

  /** Hosts a race for the other tabs of this browser (no network needed) */
  public hostLocal(): void {
    // A room left on the broker would keep retrying and write its own status over this one
    this.closeSignaling();
    this.emitStatus({ mode: 'local', state: 'connected', statusText: 'Hosting a race for the tabs of this browser' });
    this.becomeHost();
  }

  /** Host: change the race settings */
  public setLobbySettings(patch: Partial<LobbySettings>): void {
    if (!this.isHost) return;
    this.lobbySettings = { ...this.lobbySettings, ...patch };
    this.broadcastLobby();
  }

  public setReady(ready: boolean): void {
    this.localReady = ready;
    if (this.isHost) this.broadcastLobby();
    else this.sendControl({ type: 'ready', ready });
  }

  /** Host: lines everyone up and starts the lights `countdownMs` from now. Returns the start, or null when not hosting */
  public startRace(countdownMs = 4000): RaceStartInfo | null {
    if (!this.isHost) return null;
    const players = this.lobbyPlayers();
    const start: RaceStartInfo = {
      id: Math.random().toString(36).slice(2, 10),
      lightsStartHostMs: this.hostNowMs() + countdownMs,
      holdMs: 200 + Math.random() * 2800,
      laps: this.lobbySettings.laps,
      collisions: this.lobbySettings.collisions,
      carClass: this.lobbySettings.carClass,
      trackId: this.lobbySettings.trackId,
      // Host on pole, then the others in the order they joined
      grid: players.map((p) => p.peerId),
    };
    this.activeRace = start;
    this.sendControl({ type: 'start', start });
    this.broadcastLobby();
    this.onRaceStart?.(start);
    return start;
  }

  /** Host: ends the race for everyone (back to the lobby) */
  public abortRace(): void {
    if (!this.isHost || !this.activeRace) return;
    const id = this.activeRace.id;
    this.activeRace = null;
    this.sendControl({ type: 'abort', id });
    this.broadcastLobby();
    this.onRaceAbort?.(id);
  }

  /**
   * Leaves the race in progress. The host ends it for everyone (abortRace). A guest drops out alone: the race is
   * forgotten here, and neither the host repeating its start nor its lobby puts this player back in it.
   */
  public leaveRace(): void {
    // A scheduled race is left for good: there is no lobby to go back to, the next race is another entry
    if (this.inScheduledRace) {
      this.leaveScheduledRace();
      return;
    }
    if (this.isHost) {
      this.abortRace();
      return;
    }
    // Only the race actually followed: leaveRace also runs from onRaceAbort, after the race was already dropped here
    // (and the lobby may by then show the host's next race, which this player has not left)
    if (this.activeRace) this.doneRaceId = this.activeRace.id;
    this.activeRace = null;
  }

  /** The host's clock now (ms): the race timeline every client shares */
  public hostNowMs(localNowMs: number = performance.now()): number {
    return localNowMs + this.clockOffsetMs;
  }

  /** True once this guest has measured the host's clock (the host always has) */
  public get clockSynced(): boolean {
    return this.isHost || Number.isFinite(this.bestClockRttMs);
  }

  /** Connection quality of every remote human player */
  public getPeerStats(): PeerNetStats[] {
    const direct = new Set<string>();
    for (const e of this.rtcPeers.values()) if (e.gamePeerId) direct.add(e.gamePeerId);
    const out: PeerNetStats[] = [];
    for (const buf of this.peers.values()) {
      if (buf.isAiPeer) continue;
      out.push({
        peerId: buf.peerId,
        name: buf.renderedState.name ?? buf.driverCode,
        code: buf.driverCode,
        rttMs: this.rtts.get(buf.peerId) ?? null,
        lossPct: buf.lossPct,
        jitterMs: buf.jitterMs,
        relayed: this.rtcPeers.size > 0 && !direct.has(buf.peerId) && !this.isHost,
      });
    }
    return out;
  }

  private lobbyPlayers(): LobbyPlayer[] {
    const me: LobbyPlayer = {
      peerId: this.localPeerId,
      ...this.identity,
      vehicle: this.localVehicle,
      trackId: this.localTrackId,
      ready: true,
      isHost: true,
    };
    return [me, ...this.members.values()];
  }

  private broadcastLobby(): void {
    if (!this.isHost) return;
    this.lastLobbyMs = performance.now();
    const lobby: LobbyState = {
      hostId: this.localPeerId,
      settings: { ...this.lobbySettings },
      players: this.lobbyPlayers(),
      race: this.activeRace,
      weather: this.weatherProvider?.() ?? undefined,
    };
    this.setLobby(lobby);
    this.sendControl({ type: 'lobby', lobby });
  }

  private setLobby(lobby: LobbyState | null): void {
    this.lobby = lobby;
    this.onLobbyChange?.(lobby);
  }

  private dropMember(peerId: string): void {
    this.lapsedMembers.delete(peerId);
    this.memberSeenMs.delete(peerId);
    if (this.members.delete(peerId)) this.broadcastLobby();
  }

  /** Host: a member silent too long leaves the lobby, remembered so that its next message or packet brings it back */
  private lapseMember(peerId: string): void {
    const member = this.members.get(peerId);
    this.dropMember(peerId);
    if (member) this.lapsedMembers.set(peerId, member);
  }

  /** Host: a guest was heard from (any control message or state packet): it stays in the lobby, or is back in it */
  private memberHeard(peerId: string, nowMs: number): void {
    if (!this.isHost) return;
    if (this.members.has(peerId)) {
      this.memberSeenMs.set(peerId, nowMs);
      return;
    }
    const lapsed = this.lapsedMembers.get(peerId);
    if (!lapsed) return;
    this.lapsedMembers.delete(peerId);
    this.members.set(peerId, lapsed);
    this.memberSeenMs.set(peerId, nowMs);
    this.broadcastLobby();
  }

  /** Sends a control message over every transport (reliable channels + same-browser BroadcastChannel) */
  private sendControl(msg: ControlMessage, to?: string): void {
    const env: ControlEnvelope = to ? { ctl: msg, from: this.localPeerId, to } : { ctl: msg, from: this.localPeerId };
    if (this.inScheduledRace) {
      // A scheduled race: everything goes through its server, and nothing to the other tabs
      if (this.raceWs?.readyState === WebSocket.OPEN) {
        try {
          this.raceWs.send(JSON.stringify(env));
        } catch {
          // Ignore send failure
        }
      }
      return;
    }
    if (this.channel) {
      try {
        this.channel.postMessage(env);
      } catch {
        // Ignore postMessage failure
      }
    }
    const serialized = JSON.stringify(env);
    for (const entry of this.rtcPeers.values()) {
      if (entry.ctl && entry.ctl.readyState === 'open') {
        try {
          entry.ctl.send(serialized);
        } catch {
          // Ignore send failure
        }
      }
    }
  }

  private handleEnvelope(env: ControlEnvelope, via: WebRtcPeerEntry | null): void {
    if (typeof env.from !== 'string' || env.from === this.localPeerId) return;
    const from = env.from.slice(0, 64);
    const msg = sanitizeControl(env.ctl);
    if (!msg) return;
    const to = typeof env.to === 'string' ? env.to.slice(0, 64) : undefined;
    // The host passes guests' messages on to the other guests: never one only a host may send
    if (this.isHost && via && RELAYED_CONTROL.has(msg.type)) {
      this.relay(JSON.stringify(to ? { ctl: msg, from, to } : { ctl: msg, from }), via.remoteId, 'control', to);
    }
    // Any message is a sign of life, also one passed on to another guest (a hello is taken in below)
    if (msg.type !== 'hello') this.memberHeard(from, performance.now());
    if (to && to !== this.localPeerId) return;

    switch (msg.type) {
      case 'hello':
        if (this.isHost) {
          this.lapsedMembers.delete(from);
          this.members.set(from, {
            peerId: from,
            name: msg.name,
            code: msg.code,
            color: msg.color,
            vehicle: msg.vehicle,
            trackId: msg.trackId,
            ready: this.members.get(from)?.ready ?? false,
            isHost: false,
          });
          this.memberSeenMs.set(from, performance.now());
          this.broadcastLobby();
        }
        break;
      case 'ready':
        if (this.isHost) {
          const m = this.members.get(from);
          if (m) {
            m.ready = msg.ready;
            this.broadcastLobby();
          }
        }
        break;
      case 'ping':
        this.sendControl({ type: 'pong', t0: msg.t0, now: performance.now() + this.clockOffsetMs }, from);
        break;
      case 'pong': {
        const t1 = performance.now();
        const rtt = Math.max(0, t1 - msg.t0);
        const prev = this.rtts.get(from);
        this.rtts.set(from, prev === undefined ? rtt : prev + (rtt - prev) * 0.25);
        // Clock sync against the host (NTP-style, keeping the lowest-latency measurement; slowly forgets it)
        if (!this.isHost && from === this.hostId) {
          // Slowly forget the best sample, so a route that got slower is eventually re-measured
          this.bestClockRttMs = this.bestClockRttMs * 1.02 + 0.5;
          if (rtt <= this.bestClockRttMs) {
            this.bestClockRttMs = rtt;
            this.clockOffsetMs = msg.now + rtt / 2 - t1;
          }
          // The host's clock is known now: a race waiting for it in the lobby can start
          this.reconcileRace(false);
        }
        break;
      }
      case 'lobby': {
        if (this.isHost) break;
        // Only a host sends the lobby, under its own id. Connected to a host over WebRTC, a guest takes the lobby from
        // that connection alone (the host never relays one), not from another tab; and it sticks with its host while
        // that host keeps sending
        if (from !== msg.lobby.hostId) break;
        if (!via && this.rtcPeers.size > 0) break;
        const nowMs = performance.now();
        if (this.hostId !== null && from !== this.hostId && nowMs - this.lastHostLobbyMs < HOST_SILENT_MS) break;
        this.lastHostLobbyMs = nowMs;
        if (via) via.gamePeerId = from;
        let dropped: RaceStartInfo | null = null;
        if (this.hostId !== msg.lobby.hostId) {
          this.hostId = msg.lobby.hostId;
          // A new host keeps its own clock: measure it afresh (the old offset means nothing against it), and a race
          // timed on the old host's clock is over here
          this.clockOffsetMs = 0;
          this.bestClockRttMs = Infinity;
          dropped = this.activeRace;
          this.activeRace = null;
          this.doneRaceId = null;
          this.sendControl({ type: 'hello', ...this.identity, vehicle: this.localVehicle, trackId: this.localTrackId });
          if (this.localReady) this.sendControl({ type: 'ready', ready: true });
        }
        this.setLobby(msg.lobby);
        if (dropped) this.onRaceAbort?.(dropped.id);
        this.reconcileRace(true);
        break;
      }
      case 'start':
        if (this.isHost || from !== this.hostId) break;
        // As the lobby: connected over WebRTC, the start and the abort count from that connection alone, so they stay
        // in order with the lobby (another tab's copy can overtake it)
        if (!via && this.rtcPeers.size > 0) break;
        if (this.activeRace?.id === msg.start.id || this.doneRaceId === msg.start.id) break;
        this.activeRace = msg.start;
        this.onRaceStart?.(msg.start);
        break;
      case 'abort':
        if (from !== this.hostId) break;
        if (!via && this.rtcPeers.size > 0) break;
        this.doneRaceId = msg.id;
        if (this.activeRace?.id !== msg.id) break;
        this.activeRace = null;
        this.onRaceAbort?.(msg.id);
        break;
    }
  }

  /**
   * Guest: follows the host's race from its lobby as well as from the one-off start and abort messages, which a guest
   * that connected after the start, or missed a message, never got. Only a lobby that just arrived ends a race (it
   * comes on the same ordered channel as the start, so it always shows a race started before it); a race this client
   * is done with stays done; and a race starts only on the host's measured clock (on a guessed one its lights would
   * run at the wrong time).
   */
  private reconcileRace(lobbyArrived: boolean): void {
    if (this.isHost) return;
    const race = this.lobby?.race ?? null;
    const active = this.activeRace;
    if (active) {
      if (!lobbyArrived || race?.id === active.id) return;
      this.activeRace = null;
      this.doneRaceId = active.id;
      this.onRaceAbort?.(active.id);
    }
    if (race && race.id !== this.doneRaceId && this.clockSynced) {
      // Set before the call: the lobby repeats, and the handler may switch circuits before it is back
      this.activeRace = race;
      this.onRaceStart?.(race);
    }
  }

  /** Pings, lobby heartbeats and member time-outs; called from update() */
  private tickControl(nowMs: number): void {
    if (nowMs - this.lastPingMs > (this.clockSynced ? 2000 : 400)) {
      this.lastPingMs = nowMs;
      // Stamped at send time on the same clock as the pong's arrival (nowMs is the frame's start, earlier than this)
      if (this.hostId || this.peers.size > 0) this.sendControl({ type: 'ping', t0: performance.now() });
    }
    if (this.isHost) {
      // memberSeenMs is kept current by every message and packet (memberHeard), so it alone says who is still here
      for (const [id, seen] of this.memberSeenMs) {
        if (nowMs - seen > 8000) this.lapseMember(id);
      }
      if (nowMs - this.lastLobbyMs > 3000) this.broadcastLobby();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduled races: the race server stands in for a host (cloudflare/api/race.ts)
  // ---------------------------------------------------------------------------------------------

  /** True while entered in a scheduled race (its lobby, or the race itself), also while its socket is being reopened */
  public get inScheduledRace(): boolean {
    return this.raceStatus.state === 'joining' || this.raceStatus.state === 'joined';
  }

  private emitRaceStatus(patch: Partial<ScheduledRaceStatus>): void {
    this.raceStatus = { ...this.raceStatus, ...patch };
    this.onRaceStatusChange?.({ ...this.raceStatus });
  }

  /**
   * Enters the next scheduled race: leaves any room, and follows the race server as a guest follows a host. Its lobby
   * names the circuit and car, its start comes shortly before the lights, and the cars' state goes through it.
   */
  public joinScheduledRace(): void {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
    this.closeSignaling();
    this.becomeGuest();
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    this.raceToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    this.raceIndex = null;
    this.emitStatus({ mode: 'race_server', roomCode: '', state: 'signaling', statusText: 'Joining the next race…' });
    this.emitRaceStatus({ state: 'joining', startsMs: null, text: '' });
    this.openRaceServer('next', 0);
  }

  /** Leaves the scheduled race (or its lobby); a race under way ends here */
  public leaveScheduledRace(): void {
    if (!this.raceWs && this.raceStatus.state === 'idle') return;
    this.closeRaceServer();
    this.becomeGuest();
    this.emitStatus({ mode: 'local', state: 'idle', statusText: "Host a room and send the link, or join with a friend's code." });
  }

  /** Closes the race server's socket without telling the game anything (the caller says what happens next) */
  private closeRaceServer(): void {
    if (this.raceRetry !== null) clearTimeout(this.raceRetry);
    this.raceRetry = null;
    this.raceInbox.clear();
    const ws = this.raceWs;
    this.raceWs = null;
    this.raceIndex = null;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Ignore close error
      }
    }
    if (this.raceStatus.state !== 'idle') this.emitRaceStatus({ state: 'idle', startsMs: null, text: '' });
  }

  /** The entry failed or was lost: back to no race, with the reason */
  private failRace(text: string): void {
    this.closeRaceServer();
    this.becomeGuest();
    this.emitStatus({ mode: 'local', state: 'idle', statusText: text });
    this.emitRaceStatus({ state: 'error', startsMs: null, text });
  }

  /** Opens the socket to a race ("next", or the number of the one to get back into) */
  private openRaceServer(which: 'next' | number, attempt: number): void {
    void getOnlineConfig().then((config) => {
      // Left, or another race or room chosen, while the config was read
      if (this.raceStatus.state === 'idle' || this.raceStatus.state === 'error' || this.raceWs) return;
      const url = config.races
        ? onlineSocketUrl(`/races/${which}?peer=${encodeURIComponent(this.localPeerId)}&token=${this.raceToken}`)
        : null;
      if (!url) {
        this.failRace('Scheduled races are not running right now.');
        return;
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        this.failRace("Couldn't reach the race server. Check your connection and try again.");
        return;
      }
      this.raceWs = ws;
      let welcomed = false;

      ws.onmessage = (ev) => {
        if (this.raceWs !== ws || typeof ev.data !== 'string' || ev.data.length > 65536) return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!data || typeof data !== 'object') return;
        if (typeof data.t === 'string') {
          if (data.t === 'welcome' && typeof data.startsMs === 'number' && typeof data.now === 'number' && typeof data.index === 'number') {
            welcomed = true;
            attempt = 0;
            this.raceIndex = data.index;
            // The server's start time on this device's clock (off by the trip here, which a countdown doesn't show)
            this.emitRaceStatus({ state: 'joined', startsMs: data.startsMs - data.now + Date.now(), text: '' });
            this.emitStatus({ mode: 'race_server', state: 'connected', statusText: 'In the next race' });
          } else if (data.t !== 'welcome') {
            this.failRace(RACE_REFUSALS[data.t] ?? RACE_REFUSALS.bad);
          }
          return;
        }
        if (data.ctl !== undefined) {
          this.handleEnvelope(data as unknown as ControlEnvelope, null);
          return;
        }
        const pkt = sanitizePacket(data);
        if (!pkt || pkt.peerId === this.localPeerId) return;
        const waiting = this.raceInbox.get(pkt.peerId);
        if (!waiting || pkt.timestampMs >= waiting.pkt.timestampMs) this.raceInbox.set(pkt.peerId, { pkt, atMs: performance.now() });
      };

      ws.onclose = () => {
        if (this.raceWs !== ws) return; // Closed on purpose
        this.raceWs = null;
        // Lost during the race (or its lobby): get back in, a few times. Never got in at all: say so
        const index = this.raceIndex;
        if (welcomed && index !== null && attempt < RACE_RECONNECT_MS.length) {
          this.raceRetry = setTimeout(() => {
            this.raceRetry = null;
            this.openRaceServer(index, attempt + 1);
          }, RACE_RECONNECT_MS[attempt]);
          return;
        }
        this.failRace(welcomed ? 'Lost the connection to the race.' : "Couldn't reach the race server. Check your connection and try again.");
      };
    });
  }

  /**
   * 100% Brokerless Manual SDP Offer Generator (works forever with zero servers).
   */
  public async createManualOffer(): Promise<string> {
    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      return '';
    }
    const remoteId = `manual_${Math.random().toString(36).slice(2, 7)}`;
    // A room left on the broker would keep retrying and write its own status over this mode's
    this.closeSignaling();
    this.becomeHost();
    // A new offer replaces one still waiting for its answer: close that one rather than leave it in rtcPeers forever
    if (this.manualPendingPc) this.closeManualPeer(this.manualPendingPc);
    // The same failure and grace handling as a room's connections (there is no broker here to send candidates to)
    const pc = this.createPeerConnection(remoteId, remoteId);
    this.manualPendingPc = pc;

    const dc = pc.createDataChannel(STATE_CHANNEL, {
      ordered: false,
      maxRetransmits: 0,
    });
    const ctl = pc.createDataChannel(CONTROL_CHANNEL, { ordered: true });
    const entry: WebRtcPeerEntry = { remoteId, pc, dc, ctl };
    this.rtcPeers.set(remoteId, entry);
    this.bindDataChannel(remoteId, dc);
    this.bindControlChannel(entry, ctl);

    this.emitStatus({
      mode: 'manual_sdp',
      state: 'signaling',
      statusText: 'Making an offer…',
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc, 1800);

    const token = btoa(JSON.stringify(pc.localDescription));
    this.emitStatus({
      mode: 'manual_sdp',
      state: 'signaling',
      statusText: 'Offer ready. Send it to the other player, then paste their answer.',
    });
    return token;
  }

  /**
   * Accepts a base64 Manual SDP Offer and returns a base64 SDP Answer token.
   */
  public async acceptManualOfferAndCreateAnswer(offerToken: string): Promise<string> {
    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      return '';
    }
    const remoteId = `manual_host_${Math.random().toString(36).slice(2, 7)}`;
    // Parsed before anything is set up: a mangled token throws here without leaving a half-built peer behind
    const offerDesc = JSON.parse(atob(offerToken.trim()));
    this.closeSignaling();
    this.becomeGuest();
    const pc = this.createPeerConnection(remoteId, remoteId);
    const entry: WebRtcPeerEntry = { remoteId, pc, dc: null };
    this.rtcPeers.set(remoteId, entry);
    pc.ondatachannel = (ev) => this.acceptChannel(entry, ev.channel);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerDesc));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIceGathering(pc, 1800);
    } catch (err) {
      // A dead entry would keep rtcPeers non-empty, which makes this tab ignore same-browser lobbies
      this.closeManualPeer(pc);
      throw err;
    }

    const answerToken = btoa(JSON.stringify(pc.localDescription));
    this.emitStatus({
      mode: 'manual_sdp',
      state: 'signaling',
      statusText: 'Answer ready. Send it back to the host.',
    });
    return answerToken;
  }

  /**
   * Completes the manual WebRTC P2P handshake on the host using the guest's Answer token.
   */
  public async acceptManualAnswer(answerToken: string): Promise<void> {
    const pc = this.manualPendingPc;
    if (!pc) return;
    const answerDesc = JSON.parse(atob(answerToken.trim()));
    await pc.setRemoteDescription(new RTCSessionDescription(answerDesc));
    // Answered: no longer the offer waiting, so the next offer (for another player) leaves this connection alone
    if (this.manualPendingPc === pc) this.manualPendingPc = null;
    // Connected only once its channel opens (bindDataChannel); until then it is still being set up
    if (this.openPeerCount() === 0) {
      this.emitStatus({ mode: 'manual_sdp', state: 'signaling', statusText: 'Answer accepted • connecting…' });
    }
  }

  private waitForIceGathering(
    pc: RTCPeerConnection,
    timeoutMs: number
  ): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }, timeoutMs);
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', checkState);
    });
  }

  private closeSignaling(): void {
    this.signalGen++;
    this.closeRaceServer();
    this.clearBrokerTimers();
    const ws = this.signalingWs;
    this.signalingWs = null;
    if (ws) {
      // Silenced first: closing on purpose is not the broker dropping us
      ws.onmessage = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Ignore close error
      }
    }
  }

  /**
   * Ingests a 20-30 Hz network state packet into the peer's ring buffer.
   * Uses an EWMA clock-offset estimator (`localClockMs - pkt.timestampMs`) so the sender's
   * physics timestamps (`dt`) are preserved for Cubic Hermite spline tangents without network arrival jitter.
   * `receiveClockMs` is the arrival time on the clock `update()` is given (default `performance.now()`, the clock of
   * requestAnimationFrame's timestamp); pass it when driving `update()` from another clock.
   */
  /** `pkt` must come from sanitizePacket (or be built by trusted code, like the AI field's): it is not re-checked */
  public ingestPacket(pkt: NetworkVehiclePacket, isAiPeer = false, receiveClockMs?: number): void {
    const now =
      receiveClockMs !== undefined && Number.isFinite(receiveClockMs)
        ? receiveClockMs
        : typeof performance !== 'undefined'
          ? performance.now()
          : Date.now();
    if (!isAiPeer) this.memberHeard(pkt.peerId, now);
    let buffer = this.peers.get(pkt.peerId);
    if (!buffer) {
      buffer = {
        peerId: pkt.peerId,
        driverCode: pkt.driverCode,
        teamColorHex: pkt.teamColorHex,
        isAiPeer,
        lastSeq: -1,
        seqWindow: { received: 0, expected: 0, startMs: now },
        lossPct: 0,
        lastArrivalMs: now,
        jitterMs: 0,
        snapshots: [],
        lastReceivedMs: now,
        clockOffsetMs: null,
        lastSenderTimestampMs: -Infinity,
        renderedState: {
          peerId: pkt.peerId,
          driverCode: pkt.driverCode,
          teamColorHex: pkt.teamColorHex,
          position: new THREE.Vector3(...pkt.pos),
          quaternion: new THREE.Quaternion(...pkt.quat),
          linearVelocity: new THREE.Vector3(...pkt.linVel),
          steerAngle: pkt.steerAngle,
          wheelRPMs: [...pkt.wheelRPMs],
          throttle: pkt.throttle,
          brake: pkt.brake,
          trackS: pkt.trackS,
          speedKmh: pkt.speedKmh,
          isAiPeer,
        },
        predict: {
          corrPos: new THREE.Vector3(),
          corrQuat: new THREE.Quaternion(),
          newestTs: -Infinity,
          lastMs: 0,
          graceUntilMs: 0,
          primed: false,
        },
      };
      this.peers.set(pkt.peerId, buffer);
    }

    let syncedTimestampMs = now;
    if (Number.isFinite(pkt.timestampMs)) {
      // Drop out-of-order UDP packets: judged on the sender's own clock, which the offset filter cannot reorder. A
      // jump back by more than a second is the sender's clock restarting (page reload), not a late packet
      const senderBackMs = buffer.lastSenderTimestampMs - pkt.timestampMs;
      if (senderBackMs >= 0 && senderBackMs < SENDER_CLOCK_RESTART_MS) return;
      buffer.lastSenderTimestampMs = pkt.timestampMs;
      const rawOffset = now - pkt.timestampMs;
      if (buffer.clockOffsetMs === null || Math.abs(rawOffset - buffer.clockOffsetMs) > CLOCK_OFFSET_SNAP_MS) {
        // First packet, or the sender's clock jumped (reload, reconnect): take the offset as measured, and drop
        // the snapshots stamped against the old one
        if (buffer.clockOffsetMs !== null) buffer.snapshots.length = 0;
        buffer.clockOffsetMs = rawOffset;
      } else {
        // Soft EWMA clock-offset slew (5%) rejects per-packet network jitter while tracking clock drift
        buffer.clockOffsetMs += (rawOffset - buffer.clockOffsetMs) * 0.05;
      }
      syncedTimestampMs = pkt.timestampMs + buffer.clockOffsetMs;
      // Keep the local stamps strictly increasing while the offset slews
      const lastSnap = buffer.snapshots[buffer.snapshots.length - 1];
      if (lastSnap && syncedTimestampMs <= lastSnap.timestampMs) syncedTimestampMs = lastSnap.timestampMs + 1;
    }
    // Loss from gaps in the sender's counter (5 s windows), jitter from the spread of arrival intervals
    if (typeof pkt.seq === 'number' && Number.isFinite(pkt.seq)) {
      const w = buffer.seqWindow;
      w.received++;
      w.expected += buffer.lastSeq >= 0 && pkt.seq > buffer.lastSeq ? Math.min(100, pkt.seq - buffer.lastSeq) : 1;
      buffer.lastSeq = pkt.seq;
      if (now - w.startMs > 5000) {
        buffer.lossPct = w.expected > 0 ? Math.max(0, Math.round((1 - w.received / w.expected) * 1000) / 10) : 0;
        w.received = 0;
        w.expected = 0;
        w.startMs = now;
      }
    }
    const interval = now - buffer.lastArrivalMs;
    buffer.jitterMs += (Math.abs(interval - this.broadcastIntervalMs) - buffer.jitterMs) * 0.1;
    buffer.lastArrivalMs = now;
    buffer.lastReceivedMs = now;
    // Every caller passes a packet sanitizePacket already cleaned, so its fields are used as they are (checking them
    // again here was a second copy of the rules that could drift from the first)
    // Identity can change mid-session (profile edit)
    buffer.driverCode = pkt.driverCode;
    buffer.teamColorHex = pkt.teamColorHex;
    buffer.renderedState.driverCode = buffer.driverCode;
    buffer.renderedState.teamColorHex = buffer.teamColorHex;
    buffer.renderedState.name = pkt.name;
    buffer.renderedState.race = pkt.race;
    buffer.renderedState.hazard = pkt.hz === true;
    // The sender may switch car or circuit mid-session
    buffer.renderedState.vehicle = pkt.vehicle;
    buffer.renderedState.trackId = pkt.trackId;

    const localPacket: NetworkVehiclePacket = {
      ...pkt,
      timestampMs: syncedTimestampMs,
    };
    buffer.snapshots.push(localPacket);
    if (buffer.snapshots.length > 12) {
      buffer.snapshots.shift();
    }
  }

  /**
   * Publishes local player vehicle state at 25 Hz (every 40ms) across BroadcastChannel + WebRTC DataChannels
   * and returns the interpolated remote peers.
   */
  public update(
    nowMs: number,
    localPacket: Omit<NetworkVehiclePacket, 'peerId' | 'timestampMs'>
  ): InterpolatedPeerState[] {
    if (nowMs - this.lastBroadcastMs >= this.broadcastIntervalMs) {
      this.lastBroadcastMs = nowMs;
      const fullPacket: NetworkVehiclePacket = {
        ...localPacket,
        peerId: this.localPeerId,
        timestampMs: nowMs,
        seq: this.seq++,
      };
      const serialized = JSON.stringify(fullPacket);

      if (this.inScheduledRace) {
        // The race server passes cars on only once the race is made, so nothing is sent while waiting in its lobby
        if (this.activeRace && this.raceWs?.readyState === WebSocket.OPEN) {
          try {
            this.raceWs.send(serialized);
          } catch {
            // Ignore send failure
          }
        }
      } else if (this.channel) {
        try {
          this.channel.postMessage(fullPacket);
        } catch {
          // Ignore postMessage failure
        }
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(serialized);
        } catch {
          // Ignore send failure
        }
      }
      for (const entry of this.rtcPeers.values()) {
        if (entry.dc && entry.dc.readyState === 'open') {
          try {
            entry.dc.send(serialized);
          } catch {
            // Ignore DataChannel send failure
          }
        }
      }
    }

    // The race server's cars: the newest packet of each since the last frame, at the time it arrived
    if (this.raceInbox.size > 0) {
      for (const { pkt, atMs } of this.raceInbox.values()) this.ingestPacket(pkt, false, atMs);
      this.raceInbox.clear();
    }

    this.tickControl(nowMs);

    const renderTimeMs = nowMs - this.interpolationDelayMs;
    const activeStates: InterpolatedPeerState[] = [];

    for (const [peerId, buf] of this.peers.entries()) {
      if (!buf.isAiPeer && nowMs - buf.lastReceivedMs > 5000) {
        this.peers.delete(peerId);
        continue;
      }
      if (this.predictRemotePlayers && !buf.isAiPeer) this.predictPeer(buf, nowMs);
      else this.interpolatePeer(buf, renderTimeMs);
      activeStates.push(buf.renderedState);
    }

    return activeStates;
  }

  /** Round-trip time to a peer (ms), for transports that don't ping (and tests); the pings overwrite it */
  public setPeerRttMs(peerId: string, rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs >= 0) this.rtts.set(peerId, rttMs);
  }

  /**
   * A human peer where it is now: the newest snapshot carried forward by its age plus the one-way latency (half the
   * measured round trip), at the acceleration between the last two snapshots, the heading turned at the yaw rate.
   * What you see is then what you can touch. The jump a new packet makes in the prediction blends out over
   * PREDICT_SMOOTH_S; a big one (a reset) snaps and holds contact off for a moment.
   */
  private predictPeer(buf: PeerSnapshotBuffer, nowMs: number): void {
    const snaps = buf.snapshots;
    const out = buf.renderedState;
    const p = buf.predict;
    if (snaps.length === 0) {
      out.contactReady = false;
      return;
    }
    const s1 = snaps[snaps.length - 1];
    const s0 = snaps.length > 1 ? snaps[snaps.length - 2] : null;
    const oneWayMs = (this.rtts.get(buf.peerId) ?? 0) / 2;
    const ageS = (nowMs - s1.timestampMs + oneWayMs) / 1000;
    const h = Math.min(PREDICT_MAX_S, Math.max(0, ageS));
    let ax = 0;
    let ay = 0;
    let az = 0;
    if (s0) {
      const d = (s1.timestampMs - s0.timestampMs) / 1000;
      if (d > 0.005 && d < 0.25) {
        ax = (s1.linVel[0] - s0.linVel[0]) / d;
        ay = (s1.linVel[1] - s0.linVel[1]) / d;
        az = (s1.linVel[2] - s0.linVel[2]) / d;
        const a = Math.hypot(ax, ay, az);
        if (a > PREDICT_MAX_ACCEL_MS2) {
          const k = PREDICT_MAX_ACCEL_MS2 / a;
          ax *= k;
          ay *= k;
          az *= k;
        }
      }
    }
    const yawRate = Number.isFinite(s1.angVel?.[1]) ? s1.angVel[1] : 0;
    // Raw prediction (a yaw rate + is turning right: clockwise about +Y)
    const rawPos = this.tempVec0.set(
      s1.pos[0] + s1.linVel[0] * h + 0.5 * ax * h * h,
      s1.pos[1] + s1.linVel[1] * h + 0.5 * ay * h * h,
      s1.pos[2] + s1.linVel[2] * h + 0.5 * az * h * h
    );
    const rawQuat = this.tempQuat0.setFromAxisAngle(AXIS_Y, -yawRate * h).multiply(this.tempQuat1.set(...s1.quat));

    const frameS = p.lastMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - p.lastMs) / 1000)) : 0;
    if (!p.primed) {
      p.corrPos.set(0, 0, 0);
      p.corrQuat.identity();
      p.graceUntilMs = nowMs + PREDICT_GRACE_MS;
      p.primed = true;
    } else if (s1.timestampMs !== p.newestTs) {
      // A new packet: carry on from where the car was shown, moved on over this frame
      const shown = this.tempVec1.copy(out.position).addScaledVector(out.linearVelocity, frameS);
      p.corrPos.copy(shown).sub(rawPos);
      if (p.corrPos.length() > PREDICT_SNAP_M) {
        p.corrPos.set(0, 0, 0);
        p.corrQuat.identity();
        p.graceUntilMs = nowMs + PREDICT_GRACE_MS;
      } else {
        const shownQuat = this.tempQuat1.setFromAxisAngle(AXIS_Y, -(out.yawRateRadS ?? 0) * frameS).multiply(out.quaternion);
        p.corrQuat.copy(shownQuat).multiply(this.tempQuat2.copy(rawQuat).invert());
      }
    } else {
      const keep = Math.exp(-frameS / PREDICT_SMOOTH_S);
      p.corrPos.multiplyScalar(keep);
      p.corrQuat.slerp(this.tempQuat1.identity(), 1 - keep);
    }
    p.newestTs = s1.timestampMs;
    p.lastMs = nowMs;

    out.position.copy(rawPos).add(p.corrPos);
    out.quaternion.copy(p.corrQuat).multiply(rawQuat);
    out.linearVelocity.set(s1.linVel[0] + ax * h, s1.linVel[1] + ay * h, s1.linVel[2] + az * h);
    out.yawRateRadS = yawRate;
    out.steerAngle = s1.steerAngle;
    out.wheelRPMs = [...s1.wheelRPMs];
    out.throttle = s1.throttle;
    out.brake = s1.brake;
    out.trackS = s1.trackS;
    out.speedKmh = s1.speedKmh;
    out.contactReady = s0 !== null && ageS <= PREDICT_MAX_S && nowMs >= p.graceUntilMs;
  }

  /**
   * Cubic Hermite position/velocity spline interpolation + Quaternion slerp
   * or dead-reckoning extrapolation when renderTimeMs > latest snapshot.
   */
  private interpolatePeer(buf: PeerSnapshotBuffer, renderTimeMs: number): void {
    const snaps = buf.snapshots;
    const out = buf.renderedState;
    if (snaps.length === 0) return;

    if (snaps.length === 1) {
      const s = snaps[0];
      out.position.set(...s.pos);
      out.quaternion.set(...s.quat);
      out.linearVelocity.set(...s.linVel);
      out.steerAngle = s.steerAngle;
      out.wheelRPMs = [...s.wheelRPMs];
      out.throttle = s.throttle;
      out.brake = s.brake;
      out.trackS = s.trackS;
      out.speedKmh = s.speedKmh;
      return;
    }

    let idx0 = snaps.length - 2;
    for (let i = 0; i < snaps.length - 1; i++) {
      if (renderTimeMs >= snaps[i].timestampMs && renderTimeMs <= snaps[i + 1].timestampMs) {
        idx0 = i;
        break;
      }
    }

    const s0 = snaps[idx0];
    const s1 = snaps[idx0 + 1];
    const dtMs = Math.max(1, s1.timestampMs - s0.timestampMs);
    const dtSec = dtMs * 0.001;
    const rawT = (renderTimeMs - s0.timestampMs) / dtMs;

    if (rawT <= 1.0) {
      const t = Math.max(0, rawT);
      const t2 = t * t;
      const t3 = t2 * t;

      // Cubic Hermite basis functions
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = (t3 - 2 * t2 + t) * dtSec;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = (t3 - t2) * dtSec;

      out.position.set(
        h00 * s0.pos[0] + h10 * s0.linVel[0] + h01 * s1.pos[0] + h11 * s1.linVel[0],
        h00 * s0.pos[1] + h10 * s0.linVel[1] + h01 * s1.pos[1] + h11 * s1.linVel[1],
        h00 * s0.pos[2] + h10 * s0.linVel[2] + h01 * s1.pos[2] + h11 * s1.linVel[2]
      );

      this.tempQuat0.set(...s0.quat);
      this.tempQuat1.set(...s1.quat);
      out.quaternion.copy(this.tempQuat0).slerp(this.tempQuat1, t);

      out.linearVelocity.set(
        s0.linVel[0] + (s1.linVel[0] - s0.linVel[0]) * t,
        s0.linVel[1] + (s1.linVel[1] - s0.linVel[1]) * t,
        s0.linVel[2] + (s1.linVel[2] - s0.linVel[2]) * t
      );
      out.steerAngle = s0.steerAngle + (s1.steerAngle - s0.steerAngle) * t;
      out.throttle = s0.throttle + (s1.throttle - s0.throttle) * t;
      out.brake = s0.brake + (s1.brake - s0.brake) * t;
      out.trackS = s1.trackS;
      out.speedKmh = Math.round(s0.speedKmh + (s1.speedKmh - s0.speedKmh) * t);
      out.wheelRPMs = [
        s0.wheelRPMs[0] + (s1.wheelRPMs[0] - s0.wheelRPMs[0]) * t,
        s0.wheelRPMs[1] + (s1.wheelRPMs[1] - s0.wheelRPMs[1]) * t,
        s0.wheelRPMs[2] + (s1.wheelRPMs[2] - s0.wheelRPMs[2]) * t,
        s0.wheelRPMs[3] + (s1.wheelRPMs[3] - s0.wheelRPMs[3]) * t,
      ];
    } else {
      const extrapSec = Math.min(0.12, (renderTimeMs - s1.timestampMs) * 0.001);
      out.position.set(
        s1.pos[0] + s1.linVel[0] * extrapSec,
        s1.pos[1] + s1.linVel[1] * extrapSec,
        s1.pos[2] + s1.linVel[2] * extrapSec
      );
      out.quaternion.set(...s1.quat);
      out.linearVelocity.set(...s1.linVel);
      out.steerAngle = s1.steerAngle;
      out.wheelRPMs = [...s1.wheelRPMs];
      out.throttle = s1.throttle;
      out.brake = s1.brake;
      out.trackS = s1.trackS;
      out.speedKmh = s1.speedKmh;
    }
  }

  /** Closes one manual-SDP connection and forgets its entry */
  private closeManualPeer(pc: RTCPeerConnection): void {
    // Silenced first: closing on purpose is not a lost player
    pc.onconnectionstatechange = null;
    for (const [id, entry] of this.rtcPeers) {
      if (entry.pc !== pc) continue;
      this.rtcPeers.delete(id);
      if (entry.dc) entry.dc.onclose = null;
      if (entry.ctl) entry.ctl.onclose = null;
      entry.dc?.close();
      entry.ctl?.close();
    }
    if (this.manualPendingPc === pc) this.manualPendingPc = null;
    try {
      pc.close();
    } catch {
      // Ignore close error
    }
  }

  private closePeers(): void {
    const entries = [...this.rtcPeers.values()];
    this.rtcPeers.clear();
    for (const entry of entries) {
      // Silenced first: a late close event must not report the new connection's status as lost
      entry.pc.onconnectionstatechange = null;
      if (entry.dc) entry.dc.onclose = null;
      if (entry.ctl) entry.ctl.onclose = null;
      try {
        entry.dc?.close();
        entry.ctl?.close();
        entry.pc.close();
      } catch {
        // Ignore close error
      }
    }
    this.manualPendingPc = null;
  }

  public dispose(): void {
    this.closeSignaling();
    this.closePeers();
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

let sharedManager: MultiplayerSyncManager | null = null;

/**
 * The page's one multiplayer connection. It outlives the simulator component, so a guest who switches to the
 * host's circuit (which remounts the simulator) stays in the room.
 */
export function getMultiplayerManager(): MultiplayerSyncManager {
  sharedManager ??= new MultiplayerSyncManager();
  return sharedManager;
}
