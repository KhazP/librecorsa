/**
 * Serverless Peer-to-Peer WebRTC + BroadcastChannel Multiplayer & Dead-Reckoning Engine
 *
 * Implements:
 * - Compact network state packet:
 *   `[timestamp, pos, quat, linVel, angVel, steerAngle, wheelRPMs, throttle, brake]`
 * - 3 Zero-Cost Serverless P2P Transports (100% Free Forever on Static GitHub Pages):
 *   1. Room Code P2P Mode: WebRTC `RTCPeerConnection` + unreliable/unordered `RTCDataChannel`
 *      (`ordered: false, maxRetransmits: 0`) using Google Public STUN (`stun:stun.l.google.com:19302`)
 *      and the public PeerJS Cloud Signaling Broker (`wss://0.peerjs.com/peerjs`) with a 6-character Room Code.
 *   2. Manual Copy-Paste SDP Offer/Answer Mode: 100% brokerless WebRTC P2P connection via base64 SDP tokens.
 *   3. Local Same-Machine Mode: Zero-config `BroadcastChannel` across browser tabs/windows.
 * - Dead-reckoning state buffer with Cubic Hermite position/velocity spline interpolation
 *   and Quaternion `slerp` orientation interpolation at variable render frame rate (`requestAnimationFrame`).
 * - Autonomous AI grid peers that publish 25 Hz state packets into the same dead-reckoning pipeline.
 */

import * as THREE from 'three';

export interface NetworkVehiclePacket {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  /** Monotonic timestamp in milliseconds (`performance.now()` / synchronized clock) */
  timestampMs: number;
  /** World position [x, y, z] (m) */
  pos: [number, number, number];
  /** World orientation quaternion [x, y, z, w] */
  quat: [number, number, number, number];
  /** World linear velocity [vx, vy, vz] (m/s) */
  linVel: [number, number, number];
  /** World angular velocity [wx, wy, wz] (rad/s) */
  angVel: [number, number, number];
  /** Front wheel steering angle (rad) */
  steerAngle: number;
  /** 4-wheel angular speeds [FR, FL, RR, RL] (RPM) */
  wheelRPMs: [number, number, number, number];
  /** Throttle pedal (0..1) */
  throttle: number;
  /** Brake pedal (0..1) */
  brake: number;
  /** Track arc-length s (m) */
  trackS: number;
  /** Speed (km/h) */
  speedKmh: number;
}

export interface InterpolatedPeerState {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
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
}

export interface P2PConnectionStatus {
  mode: 'local' | 'room_host' | 'room_guest' | 'manual_sdp';
  roomCode: string;
  state: 'idle' | 'signaling' | 'connected' | 'error';
  connectedWebRtcPeers: number;
  statusText: string;
}

interface PeerSnapshotBuffer {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  isAiPeer: boolean;
  snapshots: NetworkVehiclePacket[];
  lastReceivedMs: number;
  renderedState: InterpolatedPeerState;
}

interface WebRtcPeerEntry {
  remoteId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
}

const GOOGLE_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export class MultiplayerSyncManager {
  public readonly localPeerId: string;
  private channel: BroadcastChannel | null = null;
  private ws: WebSocket | null = null;
  private signalingWs: WebSocket | null = null;
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
    statusText: 'BroadcastChannel Active (Same-Browser) • Ready for WebRTC P2P',
  };
  public onStatusChange?: (status: P2PConnectionStatus) => void;

  // Reusable math temporaries
  private tempQuat0 = new THREE.Quaternion();
  private tempQuat1 = new THREE.Quaternion();
  private tempUp = new THREE.Vector3(0, 1, 0);
  private tempRight = new THREE.Vector3();
  private tempForward = new THREE.Vector3();
  private tempMatrix = new THREE.Matrix4();

  constructor() {
    this.localPeerId = `peer_${Math.random().toString(36).slice(2, 9)}`;
    this.initTransports();
  }

  private emitStatus(patch: Partial<P2PConnectionStatus>): void {
    let openCount = 0;
    for (const entry of this.rtcPeers.values()) {
      if (entry.dc && entry.dc.readyState === 'open') {
        openCount++;
      }
    }
    this.status = {
      ...this.status,
      ...patch,
      connectedWebRtcPeers: openCount,
    };
    this.onStatusChange?.({ ...this.status });
  }

  private initTransports(): void {
    if (typeof window === 'undefined') return;

    if ('BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('kigali_f1_sim_net_v1');
        this.channel.onmessage = (ev: MessageEvent<NetworkVehiclePacket>) => {
          if (ev.data && ev.data.peerId && ev.data.peerId !== this.localPeerId) {
            this.ingestPacket(ev.data, false);
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
            const pkt = JSON.parse(ev.data) as NetworkVehiclePacket;
            if (pkt && pkt.peerId && pkt.peerId !== this.localPeerId) {
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
    const roomCode = (customCode || MultiplayerSyncManager.generateRoomCode())
      .trim()
      .toUpperCase()
      .slice(0, 6);
    const brokerPeerId = `rwanda2026_room_${roomCode}_host`;
    const token = Math.random().toString(36).slice(2, 10);

    this.emitStatus({
      mode: 'room_host',
      roomCode,
      state: 'signaling',
      statusText: `Hosting Room ${roomCode} on Public P2P Broker...`,
    });

    try {
      const ws = new WebSocket(
        `wss://0.peerjs.com/peerjs?key=peerjs&id=${encodeURIComponent(brokerPeerId)}&token=${encodeURIComponent(token)}`
      );
      this.signalingWs = ws;

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'OPEN') {
            this.emitStatus({
              state: 'signaling',
              statusText: `Room ${roomCode} Ready • Waiting for Peers to Join`,
            });
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

      ws.onerror = () => {
        this.emitStatus({
          state: 'error',
          statusText: 'Public Broker Unreachable — Use Manual SDP Copy/Paste Below',
        });
      };
    } catch {
      this.emitStatus({
        state: 'error',
        statusText: 'Failed to Open Signaling Socket — Use Manual SDP Fallback',
      });
    }

    return roomCode;
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
    const guestBrokerId = `rwanda2026_room_${roomCode}_guest_${Math.random().toString(36).slice(2, 7)}`;
    const hostBrokerId = `rwanda2026_room_${roomCode}_host`;
    const token = Math.random().toString(36).slice(2, 10);
    const connId = `dc_${Math.random().toString(36).slice(2, 9)}`;

    this.emitStatus({
      mode: 'room_guest',
      roomCode,
      state: 'signaling',
      statusText: `Connecting to Room ${roomCode}...`,
    });

    try {
      const ws = new WebSocket(
        `wss://0.peerjs.com/peerjs?key=peerjs&id=${encodeURIComponent(guestBrokerId)}&token=${encodeURIComponent(token)}`
      );
      this.signalingWs = ws;

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'OPEN') {
            const pc = this.createPeerConnection(hostBrokerId, connId);
            const dc = pc.createDataChannel('f1-telemetry', {
              ordered: false,
              maxRetransmits: 0,
            });
            this.bindDataChannel(hostBrokerId, dc);
            this.rtcPeers.set(hostBrokerId, { remoteId: hostBrokerId, pc, dc });

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            ws.send(
              JSON.stringify({
                type: 'OFFER',
                dst: hostBrokerId,
                payload: {
                  sdp: pc.localDescription,
                  type: 'data',
                  connectionId: connId,
                },
              })
            );
          } else if (msg.type === 'ANSWER' && msg.src && msg.payload?.sdp) {
            const entry = this.rtcPeers.get(msg.src);
            if (entry) {
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

      ws.onerror = () => {
        this.emitStatus({
          state: 'error',
          statusText: 'Broker Error — Use Manual SDP Copy-Paste Fallback',
        });
      };
    } catch {
      this.emitStatus({
        state: 'error',
        statusText: 'Connection Failed — Use Manual SDP Copy-Paste Fallback',
      });
    }
  }

  private async handleBrokerOffer(
    remoteId: string,
    sdp: RTCSessionDescriptionInit,
    connectionId: string
  ): Promise<void> {
    const pc = this.createPeerConnection(remoteId, connectionId);
    const entry: WebRtcPeerEntry = { remoteId, pc, dc: null };
    this.rtcPeers.set(remoteId, entry);

    pc.ondatachannel = (ev) => {
      entry.dc = ev.channel;
      this.bindDataChannel(remoteId, ev.channel);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
      this.signalingWs.send(
        JSON.stringify({
          type: 'ANSWER',
          dst: remoteId,
          payload: {
            sdp: pc.localDescription,
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
    const pc = new RTCPeerConnection({ iceServers: GOOGLE_STUN_SERVERS });

    pc.onicecandidate = (ev) => {
      if (
        ev.candidate &&
        this.signalingWs &&
        this.signalingWs.readyState === WebSocket.OPEN
      ) {
        this.signalingWs.send(
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
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        this.rtcPeers.delete(remoteId);
        this.emitStatus({
          state: this.rtcPeers.size > 0 ? 'connected' : 'signaling',
          statusText:
            this.rtcPeers.size > 0
              ? `WebRTC P2P Connected (${this.rtcPeers.size} peer)`
              : 'Peer Disconnected • Waiting for Reconnection',
        });
      }
    };

    return pc;
  }

  private bindDataChannel(remoteId: string, dc: RTCDataChannel): void {
    dc.onopen = () => {
      this.emitStatus({
        state: 'connected',
        statusText: `WebRTC DataChannel Connected (25 Hz Unordered UDP)`,
      });
    };
    dc.onclose = () => {
      this.rtcPeers.delete(remoteId);
      this.emitStatus({
        state: this.rtcPeers.size > 0 ? 'connected' : 'idle',
      });
    };
    dc.onmessage = (ev) => {
      try {
        const pkt = JSON.parse(ev.data) as NetworkVehiclePacket;
        if (pkt && pkt.peerId && pkt.peerId !== this.localPeerId) {
          this.ingestPacket(pkt, false);
        }
      } catch {
        // Ignore malformed packet
      }
    };
  }

  /**
   * 100% Brokerless Manual SDP Offer Generator (works forever with zero servers).
   */
  public async createManualOffer(): Promise<string> {
    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      return '';
    }
    const remoteId = `manual_${Math.random().toString(36).slice(2, 7)}`;
    const pc = new RTCPeerConnection({ iceServers: GOOGLE_STUN_SERVERS });
    this.manualPendingPc = pc;

    const dc = pc.createDataChannel('f1-telemetry', {
      ordered: false,
      maxRetransmits: 0,
    });
    this.bindDataChannel(remoteId, dc);
    this.rtcPeers.set(remoteId, { remoteId, pc, dc });

    this.emitStatus({
      mode: 'manual_sdp',
      state: 'signaling',
      statusText: 'Gathering STUN ICE Candidates for Manual Offer...',
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc, 1800);

    const token = btoa(JSON.stringify(pc.localDescription));
    this.emitStatus({
      mode: 'manual_sdp',
      state: 'signaling',
      statusText: 'Offer Ready — Send to Peer & Paste Their Answer',
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
    const pc = new RTCPeerConnection({ iceServers: GOOGLE_STUN_SERVERS });
    const entry: WebRtcPeerEntry = { remoteId, pc, dc: null };
    this.rtcPeers.set(remoteId, entry);

    pc.ondatachannel = (ev) => {
      entry.dc = ev.channel;
      this.bindDataChannel(remoteId, ev.channel);
    };

    const offerDesc = JSON.parse(atob(offerToken.trim()));
    await pc.setRemoteDescription(new RTCSessionDescription(offerDesc));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIceGathering(pc, 1800);

    const answerToken = btoa(JSON.stringify(pc.localDescription));
    this.emitStatus({
      mode: 'manual_sdp',
      state: 'signaling',
      statusText: 'Answer Generated — Send Back to Host to Connect!',
    });
    return answerToken;
  }

  /**
   * Completes the manual WebRTC P2P handshake on the host using the guest's Answer token.
   */
  public async acceptManualAnswer(answerToken: string): Promise<void> {
    if (!this.manualPendingPc) return;
    const answerDesc = JSON.parse(atob(answerToken.trim()));
    await this.manualPendingPc.setRemoteDescription(
      new RTCSessionDescription(answerDesc)
    );
    this.emitStatus({
      mode: 'manual_sdp',
      state: 'connected',
      statusText: 'Manual WebRTC P2P Handshake Complete!',
    });
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
    if (this.signalingWs) {
      try {
        this.signalingWs.close();
      } catch {
        // Ignore close error
      }
      this.signalingWs = null;
    }
  }

  /**
   * Ingests a 20-30 Hz network state packet into the peer's ring buffer.
   */
  public ingestPacket(pkt: NetworkVehiclePacket, isAiPeer = false): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let buffer = this.peers.get(pkt.peerId);
    if (!buffer) {
      buffer = {
        peerId: pkt.peerId,
        driverCode: pkt.driverCode,
        teamColorHex: pkt.teamColorHex,
        isAiPeer,
        snapshots: [],
        lastReceivedMs: now,
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
      };
      this.peers.set(pkt.peerId, buffer);
    }

    buffer.lastReceivedMs = now;
    const localPacket: NetworkVehiclePacket = {
      ...pkt,
      timestampMs: now,
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
      };
      const serialized = JSON.stringify(fullPacket);

      if (this.channel) {
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

    const renderTimeMs = nowMs - this.interpolationDelayMs;
    const activeStates: InterpolatedPeerState[] = [];

    for (const [peerId, buf] of this.peers.entries()) {
      if (!buf.isAiPeer && nowMs - buf.lastReceivedMs > 5000) {
        this.peers.delete(peerId);
        continue;
      }
      this.interpolatePeer(buf, renderTimeMs);
      activeStates.push(buf.renderedState);
    }

    return activeStates;
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

  public dispose(): void {
    this.closeSignaling();
    for (const entry of this.rtcPeers.values()) {
      try {
        entry.dc?.close();
        entry.pc.close();
      } catch {
        // Ignore close error
      }
    }
    this.rtcPeers.clear();
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
