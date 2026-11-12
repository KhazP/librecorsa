/**
 * The car state packet in binary: about 90 bytes with a race's distance, where the JSON was about 800.
 *
 *   0  u8   protocol version (PROTOCOL_VERSION): any other is refused
 *   1  u8   flags: 1 hazard, 2 race distance follows, 4 the slow fields follow
 *   2  u32  sequence number
 *   6  f64  sender's stamp (ms, its own clock): the moment the pose is from, the frame's time
 *  14  u16  how long after the stamp the packet left (0.1 ms)
 *  16  f32  position x, y, z (m)
 *  28  u32  orientation, "smallest three" (2 bits: the largest component, 3 × 10 bits: the others)
 *  32  f16  velocity x, y, z (m/s)
 *  38  f16  angular velocity x, y, z (rad/s)
 *  44  i8   steering (-1..1), u8 throttle, u8 brake (0..1)
 *  47  u8   (unused)
 *  48  f16  wheel speeds ×4 (rpm)
 *  56  f32  lap position (m)
 *  60  u16  speed (0.01 km/h)
 *  62  u8   peer id length n, then n bytes of the peer id (ASCII)
 *      f32  race distance (m), when flag 2
 *      u16  length m, then m bytes of UTF-8 JSON: driverCode, teamColorHex, name, vehicle, trackId and the race
 *           progress without its distance, when flag 4. They change rarely, so the sender adds them every so often
 *           and when they change; a receiver keeps the last it had from each car (`StateInfoMemory`).
 *
 * No acceleration: at 60 packets a second a receiver's difference of two packets' velocities measured the same in the
 * netcode bench (scripts/bench-netcode.ts) as one the sender worked out.
 *
 * Decoding gives a plain object shaped like the JSON packet, which then goes through `sanitizePacket` (wire.ts) as
 * every packet from the network does. No three.js and no DOM: the race server imports this too.
 */

/** Bumped on every change to what goes over the wire; a room's host and the race server refuse any other */
export const PROTOCOL_VERSION = 2;

const FLAG_HAZARD = 1;
const FLAG_RACE = 2;
const FLAG_INFO = 4;
const FIXED_BYTES = 63;
/** Longest packet accepted (bytes): a peer id and the slow fields are short */
export const MAX_STATE_BYTES = 1024;

// ---------------------------------------------------------------------------------------------------------------------
// Half floats
// ---------------------------------------------------------------------------------------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE 754 half precision bits of `v` (rounded to nearest; overflow to ±infinity, NaN kept) */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    if ((mant >>> (shift - 1)) & 1) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >>> 13);
  if (mant & 0x1000) h++; // round half up into the exponent if need be
  return h;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

// ---------------------------------------------------------------------------------------------------------------------
// Smallest-three quaternion
// ---------------------------------------------------------------------------------------------------------------------

const Q_SCALE = 511 / Math.SQRT1_2;

/** A unit quaternion [x, y, z, w] in 32 bits: the largest component's index, and the other three in 10 bits each */
export function packQuat(q: readonly number[]): number {
  let big = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[big])) big = i;
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  // q and -q are the same orientation: the largest component is made positive, so it can be left out
  const s = q[big] < 0 ? -1 / len : 1 / len;
  let bits = big;
  for (let i = 0; i < 4; i++) {
    if (i === big) continue;
    const c = Math.max(-511, Math.min(511, Math.round(q[i] * s * Q_SCALE)));
    bits = (bits << 10) | (c + 511);
  }
  return bits >>> 0;
}

export function unpackQuat(bits: number): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  const big = bits >>> 30;
  let sum = 0;
  let shift = 20;
  for (let i = 0; i < 4; i++) {
    if (i === big) continue;
    const c = (((bits >>> shift) & 0x3ff) - 511) / Q_SCALE;
    out[i] = c;
    sum += c * c;
    shift -= 10;
  }
  out[big] = Math.sqrt(Math.max(0, 1 - sum));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The packet
// ---------------------------------------------------------------------------------------------------------------------

/** What encodeState reads: the car state packet (wire.ts NetworkVehiclePacket), loosely */
export interface StatePacketFields {
  peerId: string;
  timestampMs: number;
  sendDelayMs?: number;
  seq?: number;
  pos: readonly number[];
  quat: readonly number[];
  linVel: readonly number[];
  angVel: readonly number[];
  steerAngle: number;
  throttle: number;
  brake: number;
  wheelRPMs: readonly number[];
  trackS: number;
  speedKmh: number;
  hz?: boolean;
  driverCode: string;
  teamColorHex: string;
  name?: string;
  vehicle?: string;
  trackId?: string;
  race?: { dist: number };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The slow fields, as they go in the packet's tail (and as a receiver remembers them) */
export function stateInfoJson(p: StatePacketFields): string {
  const race = p.race ? { ...p.race, dist: undefined } : undefined;
  return JSON.stringify({ driverCode: p.driverCode, teamColorHex: p.teamColorHex, name: p.name, vehicle: p.vehicle, trackId: p.trackId, race });
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/** The packet in binary. `infoJson` (stateInfoJson) is added when given */
export function encodeState(p: StatePacketFields, infoJson?: string): ArrayBuffer {
  const id = p.peerId.length <= 64 && /^[\x20-\x7e]*$/.test(p.peerId) ? p.peerId : '';
  const info = infoJson !== undefined ? encoder.encode(infoJson) : null;
  const hasRace = p.race !== undefined && Number.isFinite(p.race.dist);
  const size = FIXED_BYTES + id.length + (hasRace ? 4 : 0) + (info ? 2 + info.length : 0);
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint8(0, PROTOCOL_VERSION);
  v.setUint8(1, (p.hz ? FLAG_HAZARD : 0) | (hasRace ? FLAG_RACE : 0) | (info ? FLAG_INFO : 0));
  v.setUint32(2, (p.seq ?? 0) >>> 0, true);
  v.setFloat64(6, p.timestampMs, true);
  v.setUint16(14, Math.round(clamp(p.sendDelayMs ?? 0, 0, 6553.5) * 10), true);
  for (let i = 0; i < 3; i++) v.setFloat32(16 + 4 * i, p.pos[i], true);
  v.setUint32(28, packQuat(p.quat), true);
  for (let i = 0; i < 3; i++) {
    v.setUint16(32 + 2 * i, toHalf(p.linVel[i]), true);
    v.setUint16(38 + 2 * i, toHalf(p.angVel[i]), true);
  }
  v.setInt8(44, Math.round(clamp(p.steerAngle, -1, 1) * 127));
  v.setUint8(45, Math.round(clamp(p.throttle, 0, 1) * 255));
  v.setUint8(46, Math.round(clamp(p.brake, 0, 1) * 255));
  for (let i = 0; i < 4; i++) v.setUint16(48 + 2 * i, toHalf(p.wheelRPMs[i]), true);
  v.setFloat32(56, p.trackS, true);
  v.setUint16(60, Math.round(clamp(p.speedKmh, 0, 655.35) * 100), true);
  v.setUint8(62, id.length);
  let o = FIXED_BYTES;
  for (let i = 0; i < id.length; i++) v.setUint8(o++, id.charCodeAt(i));
  if (hasRace) {
    v.setFloat32(o, p.race!.dist, true);
    o += 4;
  }
  if (info) {
    v.setUint16(o, info.length, true);
    new Uint8Array(buf, o + 2).set(info);
  }
  return buf;
}

/** The slow fields a receiver last had from each car (bounded: a flood of made-up ids can't grow it) */
export class StateInfoMemory {
  private readonly byPeer = new Map<string, Record<string, unknown>>();
  get(peerId: string): Record<string, unknown> | undefined {
    return this.byPeer.get(peerId);
  }
  set(peerId: string, info: Record<string, unknown>): void {
    if (!this.byPeer.has(peerId) && this.byPeer.size >= 64) this.byPeer.clear();
    this.byPeer.set(peerId, info);
  }
  delete(peerId: string): void {
    this.byPeer.delete(peerId);
  }
}

export type DecodedState =
  /** `info`: the slow fields the packet carried, for the receiver to remember once it has accepted the packet */
  | { ok: true; packet: Record<string, unknown>; info?: Record<string, unknown> }
  | { ok: false; reason: 'version' | 'malformed' | 'no-info' };

/**
 * A binary state packet as a plain object shaped like the JSON packet (for sanitizePacket), with the slow fields of
 * its tail, or else the ones remembered for that car. Refused: another protocol version, a malformed packet, or a car
 * whose slow fields have not been heard yet (they come within a fraction of a second). The memory is only read: a
 * receiver remembers a packet's `info` once it has checked who sent it, so nobody can set another car's name.
 */
export function decodeState(data: ArrayBuffer | ArrayBufferView, memory: StateInfoMemory): DecodedState {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 1) return { ok: false, reason: 'malformed' };
  if (bytes[0] !== PROTOCOL_VERSION) return { ok: false, reason: 'version' };
  if (bytes.length < FIXED_BYTES || bytes.length > MAX_STATE_BYTES) return { ok: false, reason: 'malformed' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = v.getUint8(1);
  const idLen = v.getUint8(62);
  let o = FIXED_BYTES + idLen;
  if (o > bytes.length) return { ok: false, reason: 'malformed' };
  let peerId = '';
  for (let i = FIXED_BYTES; i < o; i++) peerId += String.fromCharCode(bytes[i]);
  let dist: number | undefined;
  if (flags & FLAG_RACE) {
    if (o + 4 > bytes.length) return { ok: false, reason: 'malformed' };
    dist = v.getFloat32(o, true);
    o += 4;
  }
  let info: Record<string, unknown> | undefined;
  if (flags & FLAG_INFO) {
    if (o + 2 > bytes.length) return { ok: false, reason: 'malformed' };
    const len = v.getUint16(o, true);
    o += 2;
    if (o + len > bytes.length) return { ok: false, reason: 'malformed' };
    try {
      const parsed = JSON.parse(decoder.decode(bytes.subarray(o, o + len)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' };
      info = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  } else {
    info = memory.get(peerId);
    if (!info) return { ok: false, reason: 'no-info' };
  }
  const half3 = (at: number) => [fromHalf(v.getUint16(at, true)), fromHalf(v.getUint16(at + 2, true)), fromHalf(v.getUint16(at + 4, true))];
  const race = info.race && typeof info.race === 'object' && dist !== undefined ? { ...(info.race as object), dist } : undefined;
  return {
    ok: true,
    info: (flags & FLAG_INFO) !== 0 ? info : undefined,
    packet: {
      driverCode: info.driverCode,
      teamColorHex: info.teamColorHex,
      name: info.name,
      vehicle: info.vehicle,
      trackId: info.trackId,
      race,
      peerId,
      seq: v.getUint32(2, true),
      timestampMs: v.getFloat64(6, true),
      sendDelayMs: v.getUint16(14, true) / 10,
      pos: [v.getFloat32(16, true), v.getFloat32(20, true), v.getFloat32(24, true)],
      quat: unpackQuat(v.getUint32(28, true)),
      linVel: half3(32),
      angVel: half3(38),
      steerAngle: v.getInt8(44) / 127,
      throttle: v.getUint8(45) / 255,
      brake: v.getUint8(46) / 255,
      wheelRPMs: [0, 1, 2, 3].map((i) => fromHalf(v.getUint16(48 + 2 * i, true))),
      trackS: v.getFloat32(56, true),
      speedKmh: v.getUint16(60, true) / 100,
      hz: (flags & FLAG_HAZARD) !== 0 ? true : undefined,
    },
  };
}
