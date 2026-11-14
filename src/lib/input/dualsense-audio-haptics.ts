/**
 * DualSense HD haptics over USB: the pad is also a 4-channel, 48 kHz USB sound card whose third and fourth channels
 * drive its left and right voice-coil actuators. A Web Audio context routed to it (`AudioContext({ sinkId })`,
 * Chrome / Edge 110+) plays waveforms synthesised from the car on those two channels, so kerbs, lock-ups, wheelspin
 * and the engine are felt as textures, on the side they happen, rather than as the rumble emulation's two motors.
 *
 * The browser lists audio outputs by name only once the site may use a microphone, so finding the pad asks for that
 * once; the microphone stream is stopped at once and nothing is recorded. Over Bluetooth the pad has no audio device:
 * the rumble emulation stays.
 */

/** What the synth plays, all 0..1 unless noted; L / R are the pad's two grips */
export interface HapticParams {
  /** Master level (the player's strength setting), 0..1.5 */
  gain: number;
  /** Kerb strikes under the left / right wheels, and their rate (Hz) */
  kerbL: number;
  kerbR: number;
  kerbHz: number;
  /** Rough ground and surface texture per side */
  roughL: number;
  roughR: number;
  /** A front wheel locking, per side */
  lockL: number;
  lockR: number;
  /** A rear wheel spinning, per side */
  spinL: number;
  spinR: number;
  /** Front tyres scrubbing (understeer) and the rear sliding, both grips */
  scrub: number;
  slide: number;
  /** Hits: landings, kerb strikes, walls, other cars */
  impact: number;
  /** Engine vibration level and frequency (Hz) */
  engine: number;
  engineHz: number;
}

export const SILENT_HAPTICS: HapticParams = {
  gain: 0,
  kerbL: 0,
  kerbR: 0,
  kerbHz: 10,
  roughL: 0,
  roughR: 0,
  lockL: 0,
  lockR: 0,
  spinL: 0,
  spinR: 0,
  scrub: 0,
  slide: 0,
  impact: 0,
  engine: 0,
  engineHz: 40,
};

export interface AudioHapticsStatus {
  state: "unsupported" | "off" | "starting" | "on" | "error";
  message: string | null;
}

/**
 * The synth, run on the audio thread. Each side mixes: kerb strikes (a short decaying 95 Hz knock per stripe), rough
 * ground (low-passed noise), lock-up judder (a 55 Hz square), wheelspin buzz (an 85 Hz saw), scrub and slide (band
 * noise), the impact thump (40 Hz) and the engine (a sine and its octave). Parameters glide over ~15 ms so a 60 Hz
 * update never steps. Output goes to channels 3 and 4 of the pad; 1 and 2 (its speaker / headset) stay silent.
 */
export const WORKLET_SOURCE = String.raw`
const KEYS = ["gain","kerbL","kerbR","kerbHz","roughL","roughR","lockL","lockR","spinL","spinR","scrub","slide","impact","engine","engineHz"];
class DualSenseHaptics extends AudioWorkletProcessor {
  constructor() {
    super();
    this.target = {};
    this.cur = {};
    for (const k of KEYS) { this.target[k] = 0; this.cur[k] = 0; }
    this.target.kerbHz = this.cur.kerbHz = 10;
    this.target.engineHz = this.cur.engineHz = 40;
    this.ph = { kerbL: 0, kerbR: 0.37, knock: 0, lock: 0, spin: 0, thump: 0, eng: 0 };
    this.knockL = 0; this.knockR = 0;
    this.lp = [0, 0, 0, 0, 0, 0];
    this.pulses = [];
    this.seed = 22222;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === "params") Object.assign(this.target, d.params);
      else if (d && d.type === "pulse") this.pulses.push({ side: d.side, left: Math.round(sampleRate * d.seconds), hz: d.hz, amp: d.amp, ph: 0 });
    };
  }
  noise() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 2147483648 - 1;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0] ? out[0].length : 128;
    const L = out[2], R = out[3];
    const dt = 1 / sampleRate;
    const glide = 1 - Math.exp(-dt / 0.015);
    const t = this.target, c = this.cur, ph = this.ph;
    const TAU = Math.PI * 2;
    for (let i = 0; i < n; i++) {
      for (const k of KEYS) c[k] += (t[k] - c[k]) * glide;
      // Kerb stripes: each wrap of the stripe phase starts a decaying knock on that side
      const kr = Math.max(1, c.kerbHz) * dt;
      ph.kerbL += kr; if (ph.kerbL >= 1) { ph.kerbL -= 1; if (c.kerbL > 0.01) this.knockL = 1; }
      ph.kerbR += kr; if (ph.kerbR >= 1) { ph.kerbR -= 1; if (c.kerbR > 0.01) this.knockR = 1; }
      const knockDecay = Math.exp(-dt / 0.024);
      this.knockL *= knockDecay; this.knockR *= knockDecay;
      ph.knock = (ph.knock + 95 * dt) % 1;
      const knock = Math.sin(TAU * ph.knock) * 2.2;
      // Noise bands: rough ground (~60 Hz), scrub / slide (~180 Hz), one pole pair per side
      const wn1 = this.noise(), wn2 = this.noise();
      const aLow = 1 - Math.exp(-TAU * 60 * dt), aMid = 1 - Math.exp(-TAU * 180 * dt);
      this.lp[0] += (wn1 - this.lp[0]) * aLow; this.lp[1] += (this.lp[0] - this.lp[1]) * aLow;
      this.lp[2] += (wn2 - this.lp[2]) * aLow; this.lp[3] += (this.lp[2] - this.lp[3]) * aLow;
      this.lp[4] += (wn1 - this.lp[4]) * aMid; this.lp[5] += (wn2 - this.lp[5]) * aMid;
      const roughNL = this.lp[1] * 12, roughNR = this.lp[3] * 12;
      const bandL = (this.lp[4] - this.lp[1]) * 7, bandR = (this.lp[5] - this.lp[3]) * 7;
      ph.lock = (ph.lock + 55 * dt) % 1;
      const lockW = ph.lock < 0.5 ? 0.5 : -0.5;
      ph.spin = (ph.spin + 85 * dt) % 1;
      const spinW = (2 * ph.spin - 1) * 0.8;
      ph.thump = (ph.thump + 40 * dt) % 1;
      const thump = Math.sin(TAU * ph.thump);
      ph.eng = (ph.eng + Math.max(10, c.engineHz) * dt) % 1;
      const eng = Math.sin(TAU * ph.eng) * 0.7 + Math.sin(TAU * 2 * ph.eng) * 0.3;
      const common = c.impact * thump + c.engine * eng;
      const g = c.gain;
      let l = g * (common + c.kerbL * this.knockL * knock + c.roughL * roughNL + c.lockL * lockW + c.spinL * spinW
        + (c.scrub * 0.6 + c.slide) * bandL);
      let r = g * (common + c.kerbR * this.knockR * knock + c.roughR * roughNR + c.lockR * lockW + c.spinR * spinW
        + (c.scrub * 0.6 + c.slide) * bandR);
      // One-off pulses carry their own level, so a Test plays out of the car too (where the gain is 0)
      for (let p = this.pulses.length - 1; p >= 0; p--) {
        const pu = this.pulses[p];
        pu.ph = (pu.ph + pu.hz * dt) % 1;
        const v = Math.sin(TAU * pu.ph) * pu.amp;
        if (pu.side !== "right") l += v;
        if (pu.side !== "left") r += v;
        if (--pu.left <= 0) this.pulses.splice(p, 1);
      }
      // Soft clip: stacked cues stay inside the actuators' range without a hard edge
      if (L) L[i] = Math.tanh(l * 1.2) * 0.95;
      if (R) R[i] = Math.tanh(r * 1.2) * 0.95;
    }
    return true;
  }
}
registerProcessor("dualsense-haptics", DualSenseHaptics);
`;

const DEVICE_LABEL = /dualsense|wireless controller/i;
const UPDATE_EPS = 0.01;

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export class DualSenseAudioHaptics {
  private status: AudioHapticsStatus = { state: "off", message: null };
  private readonly listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private last: HapticParams = { ...SILENT_HAPTICS };
  private starting: Promise<boolean> | null = null;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getStatus = (): AudioHapticsStatus => this.status;

  private setStatus(state: AudioHapticsStatus["state"], message: string | null = null) {
    this.status = { state, message };
    for (const fn of this.listeners) fn();
  }

  supported(): boolean {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return false;
    return (
      "setSinkId" in AudioContext.prototype &&
      typeof AudioWorkletNode !== "undefined" &&
      typeof navigator.mediaDevices?.enumerateDevices === "function"
    );
  }

  running(): boolean {
    return this.status.state === "on";
  }

  /**
   * The pad's audio output id. With `ask`, a browser that hides device names asks for the microphone once (the stream
   * is stopped straight away); without it, null until that was allowed on an earlier visit.
   */
  private async findDevice(ask: boolean): Promise<string | null> {
    const pick = async () => {
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput" && d.deviceId);
      // "DualSense" first: a DualShock 4's audio is also called "Wireless Controller"
      const pad = outputs.find((d) => /dualsense/i.test(d.label)) ?? outputs.find((d) => DEVICE_LABEL.test(d.label));
      return pad?.deviceId ?? null;
    };
    const found = await pick();
    if (found || !ask) return found;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      return null;
    }
    return pick();
  }

  /**
   * Starts the synth on the pad's USB audio output. `ask` allows the one-time microphone prompt (call it from a click);
   * without it, starting only works when the browser already lists the pad. Resolves true when running.
   */
  start(ask: boolean): Promise<boolean> {
    if (this.running()) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = this.doStart(ask).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(ask: boolean): Promise<boolean> {
    if (!this.supported()) {
      this.setStatus("unsupported", "HD haptics need Chrome or Edge 110 or later");
      return false;
    }
    this.setStatus("starting");
    let deviceId: string | null;
    try {
      deviceId = await this.findDevice(ask);
    } catch (e) {
      this.setStatus("error", e instanceof Error ? e.message : String(e));
      return false;
    }
    if (!deviceId) {
      this.setStatus(
        ask ? "error" : "off",
        ask ? "The DualSense's audio output was not found: connect it with a USB cable, and allow the browser to list audio devices" : null
      );
      return false;
    }
    let ctx: SinkAudioContext | null = null;
    try {
      ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 }) as SinkAudioContext;
      await ctx.setSinkId?.(deviceId);
      const dest = ctx.destination;
      if (dest.maxChannelCount < 4) {
        void ctx.close();
        this.setStatus("error", `The browser opened the DualSense with ${dest.maxChannelCount} channels; HD haptics need its 4`);
        return false;
      }
      dest.channelCount = 4;
      dest.channelCountMode = "explicit";
      dest.channelInterpretation = "discrete";
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, "dualsense-haptics", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [4],
        channelCount: 4,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
      });
      node.connect(dest);
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      this.ctx = ctx;
      this.node = node;
      this.last = { ...SILENT_HAPTICS };
      this.setStatus("on");
      return true;
    } catch (e) {
      if (ctx) void ctx.close().catch(() => {});
      this.setStatus("error", e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /** Sends the synth new levels (only when something moved) */
  update(params: HapticParams): void {
    const node = this.node;
    if (!node) return;
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
    let changed = false;
    for (const k of Object.keys(params) as (keyof HapticParams)[]) {
      const eps = k === "kerbHz" || k === "engineHz" ? 0.5 : UPDATE_EPS;
      if (Math.abs(params[k] - this.last[k]) > eps) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.last = { ...params };
    node.port.postMessage({ type: "params", params });
  }

  /** A one-off tone on one side or both (the shift knock, the settings' Test) */
  pulse(side: "left" | "right" | "both", seconds: number, hz: number, amp: number): void {
    this.node?.port.postMessage({ type: "pulse", side, seconds, hz, amp });
  }

  silence(): void {
    this.update({ ...SILENT_HAPTICS });
  }

  async stop(): Promise<void> {
    const ctx = this.ctx;
    this.node?.disconnect();
    this.node = null;
    this.ctx = null;
    if (ctx) await ctx.close().catch(() => {});
    this.setStatus("off");
  }
}

/** The page's one haptics synth */
export const dualSenseAudioHaptics = new DualSenseAudioHaptics();
