/**
 * The multiplayer netcode bench: real cars, the real `MultiplayerSyncManager`, a simulated network, one clock.
 *
 * Every client and every link runs on one simulated timeline (true time, ms), so a three-minute race takes about a
 * second and every run repeats exactly (seeded). Each client has its own clock (an offset, as performance.now()
 * counts from page load, and a drift), its own frame rate and a main thread that is busy for part of every frame: a
 * message that arrives while it is busy is handled when the frame's work is done, and a frame's packet leaves part way
 * through the frame, stamped with the frame's time. Only the sockets are fake: the managers' own data and control
 * channel handlers are driven, with the state channel unordered and lossy and the control channel (lobby, pings)
 * reliable and in order, a lost message held up until it is sent again.
 *
 * The cars are F1Physics2026 on the autopilot, recorded once at 60 Hz and sampled between steps on a Hermite curve,
 * so a 30 fps client and the truth it is judged against come from the same drive. Every frame, where each client
 * draws each other car is compared with where that car truly was at that frame's moment.
 */
import * as THREE from 'three';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import type { BuiltTrackData as TrackData } from '../../src/lib/track-data';
import { MultiplayerSyncManager, type InterpolatedPeerState, type NetworkVehiclePacket } from '../../src/lib/sim/multiplayer-sync';

// ---------------------------------------------------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------------------------------------------------

/** mulberry32 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Recorded drives
// ---------------------------------------------------------------------------------------------------------------------

export interface CarSample {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  yawRate: number;
  /** Lap position (m), wrapped */
  s: number;
  speedKmh: number;
  throttle: number;
  brake: number;
}

const REC_HZ = 60;

/** A car's drive at 60 Hz, sampled at any moment between the steps */
export class Trajectory {
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly vz: Float64Array;
  private readonly q: Float64Array;
  private readonly yaw: Float64Array;
  /** Unwrapped lap distance */
  private readonly su: Float64Array;
  private readonly speed: Float64Array;
  private readonly thr: Float64Array;
  private readonly brk: Float64Array;
  readonly durationS: number;
  private readonly lapLengthM: number;
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();

  constructor(
    track: TrackData,
    opts: { startS: number; startSpeedMs: number; pace: number; seconds: number }
  ) {
    const n = Math.ceil(opts.seconds * REC_HZ) + 2;
    this.durationS = (n - 2) / REC_HZ;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.q = new Float64Array(n * 4);
    this.yaw = new Float64Array(n);
    this.su = new Float64Array(n);
    this.speed = new Float64Array(n);
    this.thr = new Float64Array(n);
    this.brk = new Float64Array(n);
    const car = new F1Physics2026(track);
    car.setAssistPreset('pro');
    car.aiAutopilot = true;
    car.aiPaceScale = opts.pace;
    car.teleportToDistance(opts.startS, opts.startSpeedMs, 0);
    const v = new THREE.Vector3();
    const L = track.totalLengthM;
    let lastS = car.sMeters;
    let laps = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) car.step(1 / REC_HZ, {});
      if (car.sMeters < lastS - L / 2) laps++;
      else if (car.sMeters > lastS + L / 2) laps--;
      lastS = car.sMeters;
      v.set(car.vyMs, 0, car.vxMs).applyQuaternion(car.worldQuaternion);
      this.px[i] = car.worldPosition.x;
      this.py[i] = car.worldPosition.y;
      this.pz[i] = car.worldPosition.z;
      this.vx[i] = v.x;
      this.vy[i] = v.y;
      this.vz[i] = v.z;
      this.q[i * 4] = car.worldQuaternion.x;
      this.q[i * 4 + 1] = car.worldQuaternion.y;
      this.q[i * 4 + 2] = car.worldQuaternion.z;
      this.q[i * 4 + 3] = car.worldQuaternion.w;
      this.yaw[i] = car.yawRateRadS;
      this.su[i] = car.sMeters + laps * L;
      this.speed[i] = car.telemetry.speedKmh;
      this.thr[i] = car.telemetry.throttle;
      this.brk[i] = car.telemetry.brake;
    }
    this.lapLengthM = L;
  }

  /** The car at `tS` seconds into the drive (Hermite on position and velocity, slerp on the orientation) */
  sample(tS: number, out: CarSample): CarSample {
    const x = Math.max(0, Math.min(this.durationS, tS)) * REC_HZ;
    const i = Math.min(this.px.length - 2, Math.floor(x));
    const u = x - i;
    const j = i + 1;
    const h = 1 / REC_HZ;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = (u3 - 2 * u2 + u) * h;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = (u3 - u2) * h;
    out.pos.set(
      h00 * this.px[i] + h10 * this.vx[i] + h01 * this.px[j] + h11 * this.vx[j],
      h00 * this.py[i] + h10 * this.vy[i] + h01 * this.py[j] + h11 * this.vy[j],
      h00 * this.pz[i] + h10 * this.vz[i] + h01 * this.pz[j] + h11 * this.vz[j]
    );
    out.vel.set(
      this.vx[i] + (this.vx[j] - this.vx[i]) * u,
      this.vy[i] + (this.vy[j] - this.vy[i]) * u,
      this.vz[i] + (this.vz[j] - this.vz[i]) * u
    );
    this.qa.set(this.q[i * 4], this.q[i * 4 + 1], this.q[i * 4 + 2], this.q[i * 4 + 3]);
    this.qb.set(this.q[j * 4], this.q[j * 4 + 1], this.q[j * 4 + 2], this.q[j * 4 + 3]);
    out.quat.copy(this.qa).slerp(this.qb, u);
    const lerp = (a: Float64Array) => a[i] + (a[j] - a[i]) * u;
    out.yawRate = lerp(this.yaw);
    out.s = ((lerp(this.su) % this.lapLengthM) + this.lapLengthM) % this.lapLengthM;
    out.speedKmh = lerp(this.speed);
    out.throttle = lerp(this.thr);
    out.brake = lerp(this.brk);
    return out;
  }

  /** Steps where the car moved more than 1 m off its own velocity (a reset by the physics): the drive is not smooth */
  teleports(): number {
    let n = 0;
    const h = 1 / REC_HZ;
    for (let i = 1; i < this.px.length; i++) {
      const ex = this.px[i] - this.px[i - 1] - 0.5 * (this.vx[i] + this.vx[i - 1]) * h;
      const ez = this.pz[i] - this.pz[i - 1] - 0.5 * (this.vz[i] + this.vz[i - 1]) * h;
      if (Math.hypot(ex, ez) > 1) n++;
    }
    return n;
  }

  /** Where the hardest braking of the drive's first lap starts and ends (lap distance, m): the stop for the hairpin */
  hardestBrakingZone(): { fromS: number; toS: number } {
    const lapEnd = this.su.findIndex((s) => s - this.su[0] > this.lapLengthM);
    const end = lapEnd > 0 ? lapEnd : this.su.length;
    const v = (i: number) => Math.hypot(this.vx[i], this.vz[i]);
    let minI = 0;
    for (let i = 1; i < end; i++) if (v(i) < v(minI)) minI = i;
    // Back from the slowest point to where the car started slowing down for it
    let from = minI;
    while (from > 0 && v(from - 1) > v(from)) from--;
    const wrap = (s: number) => ((s % this.lapLengthM) + this.lapLengthM) % this.lapLengthM;
    return { fromS: wrap(this.su[from] - 20), toS: wrap(this.su[minI] + 10) };
  }
}

export const newSample = (): CarSample => ({
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  vel: new THREE.Vector3(),
  yawRate: 0,
  s: 0,
  speedKmh: 0,
  throttle: 0,
  brake: 0,
});

// ---------------------------------------------------------------------------------------------------------------------
// The simulated network
// ---------------------------------------------------------------------------------------------------------------------

export interface LinkSpec {
  /** One-way latency (ms) */
  oneWayMs: number;
  /** Jitter: uniform 0..jitterMs added to every message */
  jitterMs?: number;
  /** Long-tailed jitter: an exponential delay with this mean (ms), plus `spikeChance` of a 50-150 ms spike */
  tailMeanMs?: number;
  spikeChance?: number;
  /** Share of messages lost (0..1). A lost control message is sent again after the retransmission time */
  loss?: number;
  /** Stalls: every `everyS` seconds (from `firstS`) nothing gets through for `ms`; what was held arrives together */
  stall?: { firstS: number; everyS: number; ms: number };
}

interface QueuedEvent {
  t: number;
  seq: number;
  fn: () => void;
}

/** A min-heap of events by time, in insertion order for equal times */
class EventQueue {
  private heap: QueuedEvent[] = [];
  private seq = 0;
  get size(): number {
    return this.heap.length;
  }
  push(t: number, fn: () => void): void {
    const e = { t, seq: this.seq++, fn };
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].t < e.t || (h[p].t === e.t && h[p].seq < e.seq)) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = e;
  }
  pop(): QueuedEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const less = (a: QueuedEvent, b: QueuedEvent) => a.t < b.t || (a.t === b.t && a.seq < b.seq);
        if (l < h.length && less(h[l], m === i ? last : h[m])) m = l;
        if (r < h.length && less(h[r], m === i ? last : h[m])) m = r;
        if (m === i) break;
        h[i] = h[m];
        i = m;
      }
      h[i] = last;
    }
    return top;
  }
}

/** One end of a simulated data channel, shaped like an RTCDataChannel as far as the manager uses one */
class SimChannel {
  readyState: 'open' | 'closed' = 'open';
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  other!: SimChannel;
  /** Control channel: when its last message arrives (ms, true time), to keep the messages in order */
  lastArrivalMs = -Infinity;
  constructor(
    readonly label: string,
    readonly kind: 'state' | 'control',
    readonly owner: SimClient,
    private readonly net: SimNet
  ) {}
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.net.transmit(this, data);
  }
  close(): void {
    this.readyState = 'closed';
  }
}

export interface ClientSpec {
  fps: number;
  /** The frame's main-thread work (ms): messages that arrive meanwhile wait for it */
  workMs: number;
  /** When in the frame the multiplayer update runs and the state goes out (ms after the frame starts) */
  sendAtMs: number;
  /** This client's clock: performance.now() counts from page load, and runs `driftPpm` fast */
  clockOffsetMs: number;
  driftPpm?: number;
  /** A frame that takes `ms` instead, with this chance per frame */
  hitch?: { chance: number; ms: number };
}

export class SimClient {
  readonly mgr: MultiplayerSyncManager;
  busyUntilMs = -Infinity;
  /** State bytes and messages this client sent */
  stateBytes = 0;
  stateMessages = 0;
  constructor(
    readonly name: string,
    readonly spec: ClientSpec,
    readonly traj: Trajectory,
    private readonly net: SimNet
  ) {
    this.mgr = new MultiplayerSyncManager({ clock: () => this.local(this.net.nowMs) });
  }
  /** This client's clock at true time `t` */
  local(t: number): number {
    return this.spec.clockOffsetMs + t * (1 + (this.spec.driftPpm ?? 0) * 1e-6);
  }
  /** True time at this client's clock reading `l` */
  trueOf(l: number): number {
    return (l - this.spec.clockOffsetMs) / (1 + (this.spec.driftPpm ?? 0) * 1e-6);
  }
}

/** The manager's private surface a transport uses (as in scripts/verify-multiplayer-security.ts) */
interface ManagerInternals {
  rtcPeers: Map<string, { remoteId: string; pc: { close(): void; onconnectionstatechange: null }; dc: SimChannel; ctl: SimChannel }>;
  bindControlChannel(entry: unknown, ctl: SimChannel): void;
  bindDataChannel(remoteId: string, dc: SimChannel): void;
}

export class SimNet {
  /** The current true time (ms): the clock every client's own clock is read from */
  nowMs = 0;
  readonly queue = new EventQueue();
  private readonly links = new Map<string, LinkSpec>();
  constructor(readonly rng: () => number) {}

  /** A two-way WebRTC link between `a` and `b`: a state and a control channel each way */
  connect(a: SimClient, b: SimClient, ab: LinkSpec, ba: LinkSpec = ab): void {
    this.links.set(`${a.name}>${b.name}`, ab);
    this.links.set(`${b.name}>${a.name}`, ba);
    const pair = (kind: 'state' | 'control', label: string): [SimChannel, SimChannel] => {
      const x = new SimChannel(label, kind, a, this);
      const y = new SimChannel(label, kind, b, this);
      x.other = y;
      y.other = x;
      return [x, y];
    };
    const [dcA, dcB] = pair('state', 'f1-telemetry');
    const [ctlA, ctlB] = pair('control', 'f1-control');
    for (const [c, remote, dc, ctl] of [
      [a, b, dcA, ctlA],
      [b, a, dcB, ctlB],
    ] as const) {
      const i = c.mgr as unknown as ManagerInternals;
      const remoteId = `link_${remote.name}`;
      const entry = { remoteId, pc: { close() {}, onconnectionstatechange: null }, dc, ctl };
      i.rtcPeers.set(remoteId, entry);
      i.bindDataChannel(remoteId, dc);
      i.bindControlChannel(entry, ctl);
    }
    // Both ends open: each says hello, the host answers with its lobby
    for (const ch of [ctlA, ctlB]) this.queue.push(this.nowMs, () => ch.onopen?.());
  }

  private delay(link: LinkSpec): number {
    let d = link.oneWayMs + (link.jitterMs ?? 0) * this.rng();
    if (link.tailMeanMs) d += -Math.log(1 - this.rng()) * link.tailMeanMs;
    if (link.spikeChance && this.rng() < link.spikeChance) d += 50 + 100 * this.rng();
    return d;
  }

  /** A message on the wire `[sentMs, sentMs + d]` that meets a stall comes out when the stall ends */
  private stalled(link: LinkSpec, sentMs: number, arriveMs: number): number {
    const st = link.stall;
    if (!st) return arriveMs;
    const startMs = st.firstS * 1000;
    const k = Math.floor((sentMs - startMs) / (st.everyS * 1000));
    const s0 = startMs + Math.max(0, k) * st.everyS * 1000;
    if (sentMs >= s0 && sentMs < s0 + st.ms) return Math.max(arriveMs, s0 + st.ms + link.oneWayMs * 0.5 + this.rng() * 5);
    return arriveMs;
  }

  transmit(from: SimChannel, data: string | ArrayBuffer | ArrayBufferView): void {
    const to = from.other;
    const link = this.links.get(`${from.owner.name}>${to.owner.name}`)!;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (from.kind === 'state') {
      from.owner.stateBytes += bytes;
      from.owner.stateMessages++;
    }
    // A copy, as the network delivers its own bytes
    const payload =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const sent = this.nowMs;
    let arrive: number;
    if (from.kind === 'state') {
      if (link.loss && this.rng() < link.loss) return;
      arrive = this.stalled(link, sent, sent + this.delay(link));
    } else {
      // Reliable and ordered: a lost message is sent again (SCTP's retransmission, about two round trips), and
      // nothing overtakes it
      let at = sent;
      while (link.loss && this.rng() < link.loss) at += Math.max(200, 4 * link.oneWayMs);
      arrive = this.stalled(link, at, at + this.delay(link));
      arrive = Math.max(arrive, from.lastArrivalMs + 0.01);
      from.lastArrivalMs = arrive;
    }
    this.queue.push(arrive, () => this.deliver(to, payload));
  }

  private deliver(to: SimChannel, payload: unknown): void {
    // The receiving main thread is busy with a frame: the message waits for it
    if (to.owner.busyUntilMs > this.nowMs) {
      this.queue.push(to.owner.busyUntilMs, () => this.deliver(to, payload));
      return;
    }
    to.onmessage?.({ data: payload });
  }

  run(untilMs: number): void {
    for (;;) {
      const e = this.queue.pop();
      if (!e || e.t > untilMs) break;
      this.nowMs = e.t;
      e.fn();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios and their numbers
// ---------------------------------------------------------------------------------------------------------------------

export interface Scenario {
  name: string;
  /** Link spec both ways (or per direction) */
  link: LinkSpec;
  linkBack?: LinkSpec;
  /** Client specs (default: both 60 fps desktops) */
  a?: Partial<ClientSpec>;
  b?: Partial<ClientSpec>;
  /** Three players: two guests that reach each other through the host; the guests' view of each other is measured */
  viaHost?: boolean;
  /** The bench's ablation: each receiver maps sender stamps to its own clock exactly */
  trueTiming?: boolean;
  /** State packets per second (default: the game's) */
  sendHz?: number;
  seed?: number;
}

export interface Metrics {
  frames: number;
  alongP50: number;
  alongP95: number;
  alongMax: number;
  acrossP50: number;
  acrossP95: number;
  acrossMax: number;
  /** Mean signed along-track error (m, + drawn ahead of the true car) */
  biasM: number;
  /** Frame-to-frame jumps against the car's true motion: over 1 m, and over 0.3 m (per minute of watching) */
  jumpsPerMin: number;
  popsPerMin: number;
  /**
   * Frames the newest packet was over 300 ms old (%), frames the car was drawn see-through for want of news (%; the
   * errors and jumps leave them out, as the car is shown as a guess) and frames it was not drawn at all (%)
   */
  stalePct: number;
  ghostPct: number;
  hiddenPct: number;
}

export interface ScenarioResult {
  name: string;
  all: Metrics;
  /** The frames the watched car was braking into the hardest stop of the lap */
  braking: Metrics;
  /** State bytes per packet, and packets per second, each client sent of its own car (relays included) */
  bytesPerPacket: number;
  packetsPerS: number;
}

interface Watch {
  observer: SimClient;
  target: SimClient;
  along: number[];
  across: number[];
  braking: { along: number[]; across: number[]; frames: number; jumps: number; pops: number; stale: number; ghost: number; hidden: number; bias: number };
  bias: number;
  frames: number;
  jumps: number;
  pops: number;
  stale: number;
  ghost: number;
  hidden: number;
  prevDrawn: THREE.Vector3 | null;
  prevTrue: THREE.Vector3;
  /** True send time of the newest state from the target that reached the observer */
  newestSentMs: number;
}

const DEFAULT_CLIENT: ClientSpec = { fps: 60, workMs: 8, sendAtMs: 5, clockOffsetMs: 0 };

export interface BenchSetup {
  track: TrackData;
  /** Three recorded drives (the third only for the three-player scenarios) */
  drives: Trajectory[];
  brakingZone: { fromS: number; toS: number };
  durationS: number;
  warmupS: number;
}

/**
 * Three drives starting apart on the lap. Each must be smooth: the autopilot dropped onto the circuit at speed
 * somewhere awkward can be reset by the physics, a jump of the true car that the netcode can only snap to
 */
export function recordDrives(track: TrackData, seconds: number): Trajectory[] {
  const L = track.totalLengthM;
  const drives = [
    new Trajectory(track, { startS: 100, startSpeedMs: 70, pace: 1, seconds }),
    new Trajectory(track, { startS: L * 0.36, startSpeedMs: 60, pace: 0.97, seconds }),
    new Trajectory(track, { startS: L * 0.6, startSpeedMs: 50, pace: 0.94, seconds }),
  ];
  const jumpy = drives.findIndex((d) => d.teleports() > 0);
  if (jumpy >= 0) throw new Error(`Recorded drive ${jumpy + 1} was reset by the physics: pick another start for it`);
  return drives;
}

const inZone = (s: number, z: { fromS: number; toS: number }) => (z.fromS <= z.toS ? s >= z.fromS && s <= z.toS : s >= z.fromS || s <= z.toS);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
}

function metricsOf(
  along: number[],
  across: number[],
  o: { frames: number; jumps: number; pops: number; stale: number; ghost: number; hidden: number; bias: number },
  watchedS: number
): Metrics {
  const a = along.map(Math.abs).sort((x, y) => x - y);
  const c = across.map(Math.abs).sort((x, y) => x - y);
  const perMin = watchedS > 0 ? 60 / watchedS : 0;
  return {
    frames: o.frames,
    alongP50: percentile(a, 0.5),
    alongP95: percentile(a, 0.95),
    alongMax: a.length ? a[a.length - 1] : NaN,
    acrossP50: percentile(c, 0.5),
    acrossP95: percentile(c, 0.95),
    acrossMax: c.length ? c[c.length - 1] : NaN,
    biasM: along.length ? o.bias / along.length : NaN,
    jumpsPerMin: o.jumps * perMin,
    popsPerMin: o.pops * perMin,
    stalePct: o.frames ? (100 * o.stale) / o.frames : 0,
    ghostPct: o.frames ? (100 * o.ghost) / o.frames : 0,
    hiddenPct: o.frames ? (100 * o.hidden) / o.frames : 0,
  };
}

const JUMP_M = 1;
const POP_M = 0.3;
const STALE_MS = 300;

/** Runs one scenario with one seed and measures every watched pair */
function runSeed(setup: BenchSetup, sc: Scenario) {
  const rng = seeded(sc.seed ?? 1);
  const net = new SimNet(rng);
  const spec = (over: Partial<ClientSpec> | undefined, offset: number): ClientSpec => ({ ...DEFAULT_CLIENT, clockOffsetMs: offset, ...over });
  const host = new SimClient('A', spec(sc.a, 1_000), setup.drives[0], net);
  const guest = new SimClient('B', spec(sc.b, 123_456.7), setup.drives[1], net);
  const clients = [host, guest];
  if (sc.viaHost) clients.push(new SimClient('C', spec(sc.a, 98_765.4), setup.drives[2], net));
  if (sc.sendHz) for (const c of clients) c.mgr.stateSendHz = sc.sendHz;
  host.mgr.hostLocal();
  for (const g of clients.slice(1)) net.connect(host, g, sc.link, sc.linkBack ?? sc.link);

  const byPeer = new Map(clients.map((c) => [c.mgr.localPeerId, c]));
  if (sc.trueTiming) {
    for (const c of clients) {
      c.mgr.timingOracle = (peerId, stamp) => {
        const sender = byPeer.get(peerId);
        return sender ? c.local(sender.trueOf(stamp)) : stamp;
      };
    }
  }

  // The watched pairs: each guest and the host, or the two guests (through the host)
  const pairs: [SimClient, SimClient][] = sc.viaHost
    ? [
        [clients[1], clients[2]],
        [clients[2], clients[1]],
      ]
    : [
        [host, guest],
        [guest, host],
      ];
  const watches: Watch[] = pairs.map(([observer, target]) => ({
    observer,
    target,
    along: [],
    across: [],
    braking: { along: [], across: [], frames: 0, jumps: 0, pops: 0, stale: 0, ghost: 0, hidden: 0, bias: 0 },
    bias: 0,
    frames: 0,
    jumps: 0,
    pops: 0,
    stale: 0,
    ghost: 0,
    hidden: 0,
    prevDrawn: null,
    prevTrue: new THREE.Vector3(),
    newestSentMs: -Infinity,
  }));

  // Every state packet's true send time, by sender and sequence, so the bench knows how old the newest one is
  const sentAt = new Map<string, number>();

  const truth = newSample();
  const drawnTruth = newSample();
  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const warmupMs = setup.warmupS * 1000;
  const endMs = setup.durationS * 1000;

  // Frames: each client's own vsync, with its busy main thread
  for (const c of clients) {
    const period = 1000 / c.spec.fps;
    const frame = (tf: number) => {
      const hitch = c.spec.hitch && rng() < c.spec.hitch.chance ? c.spec.hitch.ms : 0;
      const work = Math.max(c.spec.workMs, hitch);
      c.busyUntilMs = tf + work;
      // The update runs part way into the frame; the frame's own time stamps it and its car
      net.nowMs = tf + Math.min(c.spec.sendAtMs, work);
      const st = c.traj.sample(tf / 1000, truth);
      const nowLocal = c.local(tf);
      const pkt = packetOf(st, c);
      const before = c.stateMessages;
      const drawn = c.mgr.update(nowLocal, pkt);
      if (c.stateMessages > before) sentAt.set(`${c.mgr.localPeerId}:${(c.mgr as unknown as { seq: number }).seq - 1}`, tf);
      for (const w of watches) if (w.observer === c) measure(w, drawn, tf);
      const next = tf + Math.max(1, Math.ceil(work / period)) * period;
      if (next <= endMs) net.queue.push(next, () => frame(next));
    };
    net.queue.push(c === host ? 0 : period * rng(), () => frame(net.nowMs));
  }

  function measure(w: Watch, drawn: InterpolatedPeerState[], tf: number): void {
    const peer = drawn.find((p) => p.peerId === w.target.mgr.localPeerId);
    const t = w.target.traj.sample(tf / 1000, drawnTruth);
    if (tf < warmupMs) {
      w.prevDrawn = peer ? peer.position.clone() : null;
      w.prevTrue.copy(t.pos);
      return;
    }
    const braking = inZone(t.s, setup.brakingZone);
    const b = w.braking;
    w.frames++;
    if (braking) b.frames++;
    const newest = newestSent(w);
    if (tf - newest > STALE_MS) {
      w.stale++;
      if (braking) b.stale++;
    }
    if (!peer) {
      w.hidden++;
      if (braking) b.hidden++;
      w.prevDrawn = null;
      w.prevTrue.copy(t.pos);
      return;
    }
    if (peer.stale) {
      // Shown see-through as a guess: not judged, but where it goes from here is
      w.ghost++;
      if (braking) b.ghost++;
      w.prevDrawn = w.prevDrawn ? w.prevDrawn.copy(peer.position) : peer.position.clone();
      w.prevTrue.copy(t.pos);
      return;
    }
    dir.set(t.vel.x, 0, t.vel.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1).applyQuaternion(t.quat).setY(0);
    dir.normalize();
    side.set(-dir.z, 0, dir.x);
    tmp.copy(peer.position).sub(t.pos);
    const along = tmp.dot(dir);
    const across = tmp.dot(side);
    w.along.push(along);
    w.across.push(across);
    w.bias += along;
    if (braking) {
      b.along.push(along);
      b.across.push(across);
      b.bias += along;
    }
    if (w.prevDrawn) {
      // The drawn car's step this frame, less the true car's
      const step = tmp.copy(peer.position).sub(w.prevDrawn).sub(t.pos).add(w.prevTrue).length();
      if (step > JUMP_M) {
        w.jumps++;
        if (braking) b.jumps++;
      }
      if (step > POP_M) {
        w.pops++;
        if (braking) b.pops++;
      }
    }
    w.prevDrawn = w.prevDrawn ? w.prevDrawn.copy(peer.position) : peer.position.clone();
    w.prevTrue.copy(t.pos);
  }

  /** The true send time of the newest state from the watched car that has reached the observer */
  function newestSent(w: Watch): number {
    const buf = (w.observer.mgr as unknown as { peers: Map<string, { snapshots: NetworkVehiclePacket[] }> }).peers.get(w.target.mgr.localPeerId);
    const last = buf?.snapshots[buf.snapshots.length - 1];
    if (!last || last.seq === undefined) return -Infinity;
    return sentAt.get(`${w.target.mgr.localPeerId}:${last.seq}`) ?? -Infinity;
  }

  net.run(endMs + 1000);
  for (const c of clients) c.mgr.dispose();
  return {
    watches,
    watchedS: ((endMs - warmupMs) / 1000) * watches.length,
    bytes: clients.reduce((a, c) => a + c.stateBytes, 0),
    msgs: clients.reduce((a, c) => a + c.stateMessages, 0),
    clientSeconds: (clients.length * endMs) / 1000,
  };
}

/** Runs a scenario once per seed (seed, seed + 1, …) and pools every watched frame */
export function runScenario(setup: BenchSetup, sc: Scenario, seeds = 1): ScenarioResult {
  const runs = Array.from({ length: seeds }, (_, k) => runSeed(setup, { ...sc, seed: (sc.seed ?? 1) + k }));
  const watches = runs.flatMap((r) => r.watches);
  const pool = (f: (w: Watch) => number[]) => watches.flatMap(f);
  const sum = (f: (w: Watch) => number) => watches.reduce((acc, w) => acc + f(w), 0);
  const all = metricsOf(
    pool((w) => w.along),
    pool((w) => w.across),
    { frames: sum((w) => w.frames), jumps: sum((w) => w.jumps), pops: sum((w) => w.pops), stale: sum((w) => w.stale), ghost: sum((w) => w.ghost), hidden: sum((w) => w.hidden), bias: sum((w) => w.bias) },
    runs.reduce((a, r) => a + r.watchedS, 0)
  );
  const braking = metricsOf(
    pool((w) => w.braking.along),
    pool((w) => w.braking.across),
    {
      frames: sum((w) => w.braking.frames),
      jumps: sum((w) => w.braking.jumps),
      pops: sum((w) => w.braking.pops),
      stale: sum((w) => w.braking.stale),
      ghost: sum((w) => w.braking.ghost),
      hidden: sum((w) => w.braking.hidden),
      bias: sum((w) => w.braking.bias),
    },
    // Watched time in the zone, at the observers' frame rates
    watches.reduce((acc, w) => acc + w.braking.frames / w.observer.spec.fps, 0)
  );
  const bytes = runs.reduce((a, r) => a + r.bytes, 0);
  const msgs = runs.reduce((a, r) => a + r.msgs, 0);
  return {
    name: sc.name,
    all,
    braking,
    bytesPerPacket: msgs ? bytes / msgs : 0,
    packetsPerS: msgs / runs.reduce((a, r) => a + r.clientSeconds, 0),
  };
}

/** What the game sends for its car each frame (drive-session.ts), from the recorded drive */
function packetOf(st: CarSample, c: SimClient): Omit<NetworkVehiclePacket, 'peerId' | 'timestampMs'> {
  const wheelRpm = ((st.speedKmh / 3.6) / 0.33) * (60 / (2 * Math.PI));
  return {
    driverCode: c.name.repeat(3).slice(0, 3),
    teamColorHex: '#3671c6',
    name: `Driver ${c.name}`,
    vehicle: 'lc26',
    trackId: 'rwanda_official_short',
    race: { id: 'r8k2m4x1', dist: st.s, fin: null, laps: 0, best: 91234.5, last: 92345.25, pen: 0, cmp: 'soft' },
    pos: [st.pos.x, st.pos.y, st.pos.z],
    quat: [st.quat.x, st.quat.y, st.quat.z, st.quat.w],
    linVel: [st.vel.x, st.vel.y, st.vel.z],
    angVel: [0, st.yawRate, 0],
    steerAngle: Math.max(-1, Math.min(1, st.yawRate * 0.2)),
    wheelRPMs: [wheelRpm, wheelRpm, wheelRpm, wheelRpm],
    throttle: st.throttle,
    brake: st.brake,
    trackS: st.s,
    speedKmh: st.speedKmh,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------------------------------

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');

export function tableOf(results: { label: string; m: Metrics; bytes?: number; rate?: number }[]): string {
  const head =
    '| Scenario | along p50 | along p95 | along max | across p50 | across p95 | across max | bias | jumps/min >1 m | pops/min >0.3 m | stale % | ghost % | hidden % | B/pkt | pkt/s |';
  const rule = '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|';
  const rows = results.map(
    (r) =>
      `| ${r.label} | ${f(r.m.alongP50)} | ${f(r.m.alongP95)} | ${f(r.m.alongMax)} | ${f(r.m.acrossP50)} | ${f(r.m.acrossP95)} | ${f(r.m.acrossMax)} | ${f(r.m.biasM)} | ${f(r.m.jumpsPerMin, 1)} | ${f(r.m.popsPerMin, 1)} | ${f(r.m.stalePct, 1)} | ${f(r.m.ghostPct, 1)} | ${f(r.m.hiddenPct, 1)} | ${r.bytes !== undefined ? f(r.bytes, 0) : ''} | ${r.rate !== undefined ? f(r.rate, 1) : ''} |`
  );
  return [head, rule, ...rows].join('\n');
}
