/**
 * Multi-grid car sound bank for Web Audio (`/amr26/audio/` and `/gt3/audio/`).
 *
 * Engine, turbo and transmission loops are sampled across fixed parameter grids
 * (rpm × throttle, boost, drivetrain_speed), so crossfading neighbouring grid points with
 * pitch-matched playback rates reproduces continuous layer blending and pitch tracking.
 * Throttle → on-load blend uses `manifest.throttleCurve`.
 *
 * `load()` resolves false when the manifest is absent so the caller can fall back to its
 * built-in procedural/sample layers.
 */

import { withBasePath } from '@/lib/base-path';

export const AMR26_AUDIO_DIR = '/amr26/audio/';

interface LoopEntry {
  file: string;
  layer: 'on' | 'off';
  channels: number;
  rms: number;
}
interface EngineEntry extends LoopEntry {
  rpm: number;
}
interface TurboEntry extends LoopEntry {
  boost: number;
}
interface TransmissionEntry extends LoopEntry {
  drivetrainSpeed: number;
}
/** A raw bank sample looped as is (tyre skid, traction control) */
interface RawLoopEntry {
  file: string;
  channels: number;
  rms: number;
}
interface OneshotEntry {
  file: string;
  fsbName?: string;
  role: string;
  channels: number;
  seconds: number;
  peak: number;
}

export interface Vf26AudioManifest {
  sampleRate: number;
  loopSeconds: number;
  engine: { ext: EngineEntry[]; int: EngineEntry[] };
  turbo: TurboEntry[];
  transmission: TransmissionEntry[];
  oneshots: OneshotEntry[];
  throttleCurve: { ext: [number, number][]; int: [number, number][] };
  limiterParamEffect?: { ext: number; int: number };
  /**
   * Overrun pops on a lift above `popMinRpm`, then crackle above `crackleMinRpm` (default: the VF26's 8500 / 9000);
   * `downshiftPopChance`: chance of a pop on each off-throttle downshift blip above `popMinRpm` (default 0)
   */
  lift?: { popMinRpm: number; crackleMinRpm: number; downshiftPopChance?: number };
  /** Tyre skid loops per view, played by `Vf26AudioInputs.skid` (banks without them leave the squeal to CarAudio) */
  skid?: { int?: RawLoopEntry; ext?: RawLoopEntry };
  /** Traction-control cut loop, played while `Vf26AudioInputs.tcActive` */
  tractionControl?: RawLoopEntry;
  /** Rev-limiter one-shot retrigger interval while held on the limiter (default 0.9 s) */
  limiterRetriggerS?: number;
  /**
   * How the car changes gear. "sequential" (default): a race box, an ignition-cut bark and a 60 ms dip with the revs
   * snapping to the next gear. "manual": a road car's clutch, the throttle off for `clutchS` while the revs fall with
   * the physics, and no shift one-shots or ignition-cut bark
   */
  shift?: { style: 'sequential' | 'manual'; clutchS?: number };
}

export type Vf26View = 'ext' | 'int';

export interface Vf26AudioInputs {
  /** The driver's pedal, when `throttle` is the engine's delivered load (lift-off pops follow the foot) */
  pedal?: number;
  rpm: number;
  throttle: number; // 0..1
  gear: number;
  speedKmh: number;
  boostBarGauge: number; // turbo boost above atmospheric (bar)
  view: Vf26View;
  limiterRpm: number;
  /** Tyre skid level 0..1 and playback rate (banks with skid loops) */
  skid?: number;
  skidRate?: number;
  /** Traction control is cutting the engine */
  tcActive?: boolean;
}

/** One looping grid point (buffer + lazily created voice); also used by the opponent voices (`opponent-audio.ts`) */
export class LoopVoice {
  public buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly gain: GainNode;
  private silentFor = 0;
  private wasActive = false;
  /** Detached for good: set() starts nothing any more, even if a late decode hands it a buffer */
  private disposed = false;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    public readonly key: number
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(destination);
  }

  /** Drive the voice; sources are started on demand and stopped after staying silent */
  /** `pitchTau`: time constant of the pitch glide (s); longer than a frame, so the pitch moves smoothly, not in 60 Hz steps */
  public set(target: number, rate: number, now: number, dt: number, tau: number, pitchTau = 0.02): void {
    if (!this.buffer || this.disposed) return;
    const active = target > 1e-4;
    if (active) {
      this.silentFor = 0;
      if (!this.source) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.buffer;
        src.loop = true;
        src.playbackRate.value = rate;
        src.connect(this.gain);
        // random start offset decorrelates neighbouring grid renders
        src.start(now, Math.random() * this.buffer.duration);
        this.source = src;
      } else if (!this.wasActive) {
        // Snap pitch immediately when waking a voice from silence so it never glides from a stale RPM
        this.source.playbackRate.cancelScheduledValues(now);
        this.source.playbackRate.setValueAtTime(rate, now);
      }
    } else if (this.source) {
      this.silentFor += dt;
      if (this.silentFor > 0.4) {
        this.stop();
        return;
      }
    }
    this.wasActive = active;
    if (this.source) {
      this.source.playbackRate.setTargetAtTime(rate, now, pitchTau);
      this.gain.gain.setTargetAtTime(target, now, tau);
    }
  }

  public stop(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
      this.source.disconnect();
      this.source = null;
    }
    this.gain.gain.value = 0;
    this.wasActive = false;
  }

  /** Stops the source and detaches the voice from its destination for good */
  public dispose(): void {
    this.stop();
    this.gain.disconnect();
    this.disposed = true;
    this.buffer = null;
  }
}

/** Length of the upshift's ignition-cut envelope (s) */
const UPSHIFT_S = 0.06;

/** A 1-D grid of loops (rpm, boost or speed) crossfaded between neighbours with equal-power weights */
export class LoopGrid {
  public readonly voices: LoopVoice[];

  constructor(ctx: AudioContext, destination: AudioNode, keys: number[]) {
    this.voices = [...keys].sort((a, b) => a - b).map((k) => new LoopVoice(ctx, destination, k));
  }

  public voiceFor(key: number): LoopVoice | undefined {
    return this.voices.find((v) => v.key === key);
  }

  /**
   * @param x        position on the grid axis
   * @param level    overall gain
   * @param pitched  playbackRate = x / key (pitch tracks the axis) when true, 1 otherwise
   * @param rateScale multiplies every playbackRate (the Doppler shift of a car heard from outside)
   */
  public update(
    x: number,
    level: number,
    pitched: boolean,
    now: number,
    dt: number,
    tau: number,
    pitchTau = 0.02,
    rateScale = 1
  ): void {
    const vs = this.voices;
    if (vs.length === 0) return;
    let i = 0;
    while (i < vs.length - 2 && x >= vs[i + 1].key) i++;
    const lo = vs[i];
    const hi = vs[Math.min(i + 1, vs.length - 1)];
    const rawF = hi === lo ? 0 : Math.min(1, Math.max(0, (x - lo.key) / (hi.key - lo.key)));
    // Wide-anchor pitched engine grids (the 4-6 anchor F1 banks) hold each anchor alone only near it and blend over
    // the middle 80 % of an interval: a narrow window swapped recordings within a frame or two on every upshift's
    // rpm drop, which the ear hears as a change of engine
    const f =
      pitched && vs.length > 1 && vs.length <= 6
        ? Math.min(1, Math.max(0, (rawF - 0.1) / 0.8))
        : rawF;
    for (const v of vs) {
      let w = 0;
      if (v === lo) w = Math.cos(f * Math.PI * 0.5);
      else if (v === hi) w = Math.sin(f * Math.PI * 0.5);
      const rate = (pitched ? Math.min(4, Math.max(0.25, x / v.key)) : 1) * rateScale;
      v.set(w * level, rate, now, dt, tau, pitchTau);
    }
  }

  public stopAll(): void {
    for (const v of this.voices) v.stop();
  }

  public dispose(): void {
    for (const v of this.voices) v.dispose();
  }
}

export const lerpTable = (table: [number, number][], x: number): number => {
  if (table.length === 0) return x;
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-6, x1 - x0);
    }
  }
  return table[table.length - 1][1];
};

export class Vf26SoundBank {
  public ready = false;
  private manifest: Vf26AudioManifest | null = null;
  private readonly bus: GainNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly engineShelf: BiquadFilterNode;
  private readonly viewBus: Record<Vf26View, GainNode>;
  private readonly engine: Record<Vf26View, { on: LoopGrid; off: LoopGrid }> = {
    ext: { on: null as unknown as LoopGrid, off: null as unknown as LoopGrid },
    int: { on: null as unknown as LoopGrid, off: null as unknown as LoopGrid },
  };
  private turboOn: LoopGrid | null = null;
  private turboOff: LoopGrid | null = null;
  private transOn: LoopGrid | null = null;
  private transOff: LoopGrid | null = null;
  private readonly oneshots = new Map<string, AudioBuffer[]>();
  private skidVoices: Partial<Record<Vf26View, LoopVoice>> = {};
  private tcVoice: LoopVoice | null = null;
  private tcLevel = 0;

  private smoothThrottle = 0;
  /**
   * False until the first update and again after `resync()`: that frame only takes the gear and pedal as they are
   * (no shift, blip or lift is heard from them)
   */
  private primed = false;
  private prevThrottle = 0;
  private prevGear = 0;
  private audioRpm = 0;
  private upshiftTimer = 0;
  /** Length of the upshift under way (s): the sequential cut's or the manual clutch's */
  private upshiftLen = UPSHIFT_S;
  private downshiftTimer = 0;
  private liftTimer = 0;
  private popCooldown = 0;
  private limiterCooldown = 0;
  private viewMix = 0; // 0 = ext, 1 = int
  private rpmRange: [number, number] = [3500, 15500];

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly assetDir = AMR26_AUDIO_DIR
  ) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 1.0;
    this.bus.connect(destination);

    // Dynamic exhaust lowpass + high-shelf presence stage so engine timbre opens up progressively with RPM & load
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 9000;
    this.engineFilter.Q.value = 0.65;

    this.engineShelf = ctx.createBiquadFilter();
    this.engineShelf.type = 'highshelf';
    this.engineShelf.frequency.value = 1650;
    this.engineShelf.gain.value = 0;

    this.engineFilter.connect(this.engineShelf);
    this.engineShelf.connect(this.bus);

    this.viewBus = { ext: ctx.createGain(), int: ctx.createGain() };
    this.viewBus.ext.connect(this.engineFilter);
    this.viewBus.int.connect(this.engineFilter);
    this.viewBus.int.gain.value = 0;
  }

  /** Fetch the manifest and decode every buffer; resolves false when the converted assets are absent */
  private disposed = false;

  public async load(initialView: Vf26View = 'ext'): Promise<boolean> {
    let manifest: Vf26AudioManifest;
    try {
      const res = await fetchBankFile(withBasePath(`${this.assetDir}manifest.json`));
      if (!res.ok) return false;
      manifest = (await res.json()) as Vf26AudioManifest;
    } catch {
      return false;
    }
    if (!manifest.engine?.ext?.length || !manifest.engine?.int?.length) return false;
    // Optional sections an older bank may lack: update() reads them every frame and must not throw
    manifest.throttleCurve = { ext: manifest.throttleCurve?.ext ?? [], int: manifest.throttleCurve?.int ?? [] };
    manifest.turbo ??= [];
    manifest.transmission ??= [];
    manifest.oneshots ??= [];
    this.manifest = manifest;
    const ctx = this.ctx;
    // Engine loops pitch across 0.75x of the lowest anchor up to 1.35x of the highest anchor (covers idle to limiter)
    const rpms = [...manifest.engine.ext, ...manifest.engine.int].map((e) => e.rpm);
    this.rpmRange = [Math.min(...rpms) * 0.75, Math.max(...rpms) * 1.35];

    for (const view of ['ext', 'int'] as Vf26View[]) {
      const entries = manifest.engine[view];
      this.engine[view] = {
        on: new LoopGrid(ctx, this.viewBus[view], entries.filter((e) => e.layer === 'on').map((e) => e.rpm)),
        off: new LoopGrid(ctx, this.viewBus[view], entries.filter((e) => e.layer === 'off').map((e) => e.rpm)),
      };
    }
    this.turboOn = new LoopGrid(ctx, this.bus, manifest.turbo.filter((e) => e.layer === 'on').map((e) => e.boost));
    this.turboOff = new LoopGrid(ctx, this.bus, manifest.turbo.filter((e) => e.layer === 'off').map((e) => e.boost));
    this.transOn = new LoopGrid(
      ctx,
      this.bus,
      manifest.transmission.filter((e) => e.layer === 'on').map((e) => e.drivetrainSpeed)
    );
    this.transOff = new LoopGrid(
      ctx,
      this.bus,
      manifest.transmission.filter((e) => e.layer === 'off').map((e) => e.drivetrainSpeed)
    );

    const rawLoops: { file: string; voice: LoopVoice }[] = [];
    for (const view of ['ext', 'int'] as Vf26View[]) {
      const entry = manifest.skid?.[view];
      if (!entry) continue;
      const voice = new LoopVoice(ctx, this.viewBus[view], 0);
      this.skidVoices[view] = voice;
      rawLoops.push({ file: entry.file, voice });
    }
    if (manifest.tractionControl) {
      this.tcVoice = new LoopVoice(ctx, this.bus, 0);
      rawLoops.push({ file: manifest.tractionControl.file, voice: this.tcVoice });
    }

    // Decode order: the view in use first so sound starts as early as possible
    type Job = { file: string; assign: (b: AudioBuffer) => void };
    const engineJobs = (view: Vf26View): Job[] =>
      manifest.engine[view].map((e) => ({
        file: e.file,
        assign: (b) => {
          const v = this.engine[view][e.layer].voiceFor(e.rpm);
          if (v) v.buffer = b;
        },
      }));
    const rest: Job[] = [
      ...manifest.transmission.map((e) => ({
        file: e.file,
        assign: (b: AudioBuffer) => {
          const v = (e.layer === 'on' ? this.transOn : this.transOff)?.voiceFor(e.drivetrainSpeed);
          if (v) v.buffer = b;
        },
      })),
      ...manifest.turbo.map((e) => ({
        file: e.file,
        assign: (b: AudioBuffer) => {
          const v = (e.layer === 'on' ? this.turboOn : this.turboOff)?.voiceFor(e.boost);
          if (v) v.buffer = b;
        },
      })),
      ...rawLoops.map((e) => ({
        file: e.file,
        assign: (b: AudioBuffer) => {
          e.voice.buffer = b;
        },
      })),
      ...manifest.oneshots.map((e) => ({
        file: e.file,
        assign: (b: AudioBuffer) => {
          const list = this.oneshots.get(e.role) ?? [];
          list.push(b);
          this.oneshots.set(e.role, list);
        },
      })),
      ...engineJobs(initialView === 'ext' ? 'int' : 'ext'),
    ];

    const fetchDecode = async (job: Job): Promise<boolean> => {
      try {
        const res = await fetchBankFile(withBasePath(this.assetDir + job.file));
        if (!res.ok || this.disposed) return false;
        const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        if (this.disposed) return false;
        job.assign(buffer);
        return true;
      } catch {
        return false;
      }
    };

    const runPool = async (list: Job[], concurrency: number): Promise<number> => {
      let next = 0;
      let failed = 0;
      const worker = async () => {
        // A disposed bank (the car swapped out, or CarAudio dropping a stale load) fetches and decodes no more files
        while (next < list.length && !this.disposed) {
          const job = list[next++];
          if (!(await fetchDecode(job))) failed++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
      return failed;
    };

    // Engine loops of the initial view must all decode before taking over from the fallback engine;
    // turbo, transmission, one-shots and the other view follow in the background.
    if ((await runPool(engineJobs(initialView), 6)) > 0) return false;
    // Disposed while decoding: stay down rather than start playing (and fetching) into a dead graph
    if (this.disposed) return false;
    this.ready = true;
    void runPool(rest, 4);
    return true;
  }

  /** The bank brings its own tyre skid (CarAudio then mutes its synthesised squeal) */
  public get hasSkid(): boolean {
    return Object.values(this.skidVoices).some((v) => v?.buffer);
  }

  private playOneshot(role: string, gain: number, when = 0, rate = 1): void {
    // A bank without separate exterior pops (the GT3's) uses its exterior backfires
    const list = this.oneshots.get(role) ?? (role === 'pop_ext' ? this.oneshots.get('backfire_ext') : undefined);
    if (!list || list.length === 0) return;
    const buf = list[Math.floor(Math.random() * list.length)];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.bus);
    src.start(this.ctx.currentTime + when);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  public update(inp: Vf26AudioInputs, dt: number): void {
    if (!this.ready || !this.manifest) return;
    const now = this.ctx.currentTime;
    const tau = 0.03;
    const m = this.manifest;

    // Camera perspective crossfade (interior / exterior buses)
    const targetView = inp.view === 'int' ? 1 : 0;
    this.viewMix += (targetView - this.viewMix) * Math.min(1, dt / 0.12);
    this.viewBus.ext.gain.setTargetAtTime(Math.cos(this.viewMix * Math.PI * 0.5), now, 0.02);
    this.viewBus.int.gain.setTargetAtTime(Math.sin(this.viewMix * Math.PI * 0.5), now, 0.02);

    // Pedal smoothing (fast attack, slightly slower release)
    const thr = Math.min(1, Math.max(0, inp.throttle));
    const k = thr > this.smoothThrottle ? 18 : 10;
    this.smoothThrottle += (thr - this.smoothThrottle) * Math.min(1, dt * k);

    // First frame, or the first after a gap (pause, mute, restart): the gear and pedal as they are now
    const foot = Math.min(1, Math.max(0, inp.pedal ?? thr));
    if (!this.primed) {
      this.primed = true;
      this.prevGear = inp.gear;
      this.prevThrottle = foot;
    }

    // Gear change: upshift ignition cut + pitch drop, or downshift ECU throttle blip + overrun bark (a manual road
    // car: a lift and a clutch, see `Vf26AudioManifest.shift`). Between forward gears only: into or out of neutral (0)
    // or reverse (-1) is no shift to hear
    const manual = m.shift?.style === 'manual';
    if (inp.gear !== this.prevGear) {
      if (this.prevGear > 0 && inp.gear > 0) {
        const up = inp.gear > this.prevGear;
        if (up) {
          this.upshiftLen = manual ? (m.shift?.clutchS ?? 0.25) : UPSHIFT_S;
          this.upshiftTimer = this.upshiftLen;
          this.downshiftTimer = 0;
          if (!manual) {
            this.playOneshot('gear_up', 0.58);
            this.playOneshot('shift_cut', inp.view === 'int' ? 0.42 : 0.28);
          }
        } else {
          this.downshiftTimer = 0.085;
          this.upshiftTimer = 0;
          if (!manual) this.playOneshot('gear_down', 0.55);
          // Downshift blip on the overrun: unburnt fuel bangs in the exhaust and overrun crackle carries on
          const blipPop = m.lift?.downshiftPopChance ?? 0.5;
          if (blipPop > 0 && inp.throttle < 0.2 && inp.rpm > (m.lift?.popMinRpm ?? 8200)) {
            this.liftTimer = Math.max(this.liftTimer, 0.65);
            // Every pop, like the crackle, waits out the last one's cooldown
            if (this.popCooldown === 0 && Math.random() < blipPop) {
              this.playOneshot(inp.view === 'int' ? 'backfire_int' : 'pop_ext', 0.42, 0.04 + Math.random() * 0.04);
              this.popCooldown = 0.12;
            }
          }
        }
      }
      this.prevGear = inp.gear;
    }

    this.upshiftTimer = Math.max(0, this.upshiftTimer - dt);
    this.downshiftTimer = Math.max(0, this.downshiftTimer - dt);

    // Audio RPM: a seamless upshift drops the revs in ~20 ms (a fast slew, under the cut's dip); elsewhere a ~25 ms
    // smoothing takes the physics' frame steps out of the pitch
    const targetRpm = Math.min(this.rpmRange[1], Math.max(this.rpmRange[0], inp.rpm));
    const shifting = this.upshiftTimer > 0 || this.downshiftTimer > 0;
    if (this.audioRpm === 0) {
      this.audioRpm = targetRpm;
    } else if (shifting && !manual) {
      const span = Math.max(4000, this.rpmRange[1] - this.rpmRange[0]);
      const maxSlew = span * 12 * dt;
      const diff = targetRpm - this.audioRpm;
      this.audioRpm += Math.sign(diff) * Math.min(Math.abs(diff), maxSlew);
    } else {
      this.audioRpm += (targetRpm - this.audioRpm) * Math.min(1, dt / 0.025);
    }
    const rpm = this.audioRpm;
    const pitchTau = shifting ? 0.006 : 0.02;

    // Upshift cut & engagement envelope + downshift ECU auto-blip
    let shiftOnScale = 1.0;
    let shiftOffScale = 1.0;
    if (this.upshiftTimer > 0 && manual) {
      // Foot off and clutch in: the engine falls to the overrun note, then the throttle comes back in over the last
      // third as the clutch bites
      const p = 1 - this.upshiftTimer / this.upshiftLen;
      shiftOnScale = p < 0.65 ? 0 : (p - 0.65) / 0.35;
      shiftOffScale = 0.7;
    } else if (this.upshiftTimer > 0) {
      // The ignition cut: a short dip (not a hole: the engine never stops sounding through a seamless shift), then
      // back onto the next gear with a slight punch
      const p = 1 - this.upshiftTimer / this.upshiftLen;
      if (p < 0.4) {
        shiftOnScale = 0.55;
        shiftOffScale = 0.75;
      } else {
        const reg = (p - 0.4) / 0.6;
        shiftOnScale = 0.55 + 0.5 * Math.sin(reg * Math.PI * 0.5);
        shiftOffScale = 0.75 + 0.25 * reg;
      }
    }
    const blipThrottle =
      this.downshiftTimer > 0 ? Math.sin((1 - this.downshiftTimer / 0.085) * Math.PI) * 0.78 : 0;
    const effThrottle = Math.max(this.smoothThrottle, blipThrottle);

    // Dynamic exhaust filter: opens up progressively with RPM and load so high revs scream cleanly
    const rpmNorm = Math.min(1, Math.max(0, (rpm - this.rpmRange[0]) / Math.max(1000, this.rpmRange[1] - this.rpmRange[0])));
    const cutoffHz = 3200 + rpmNorm * 6800 + effThrottle * 3800;
    const shelfDb = -1.5 + rpmNorm * 5.0 * (0.4 + 0.6 * effThrottle);
    this.engineFilter.frequency.setTargetAtTime(cutoffHz, now, 0.018);
    this.engineShelf.gain.setTargetAtTime(shelfDb, now, 0.018);

    const engineTau = this.upshiftTimer > 0 || this.downshiftTimer > 0 ? 0.012 : tau;
    for (const view of ['ext', 'int'] as Vf26View[]) {
      const onness = lerpTable(m.throttleCurve[view], effThrottle);
      const wOn = Math.sin(onness * Math.PI * 0.5) * shiftOnScale;
      const wOff = Math.cos(onness * Math.PI * 0.5) * shiftOffScale;
      const viewLevel = view === 'int' ? this.viewMix : 1 - this.viewMix;
      const active = viewLevel > 0.002;
      this.engine[view].on.update(rpm, active ? wOn : 0, true, now, dt, engineTau, pitchTau);
      this.engine[view].off.update(rpm, active ? wOff : 0, true, now, dt, engineTau, pitchTau);
    }

    // Turbo (`boost` = gauge bar; pitched subtly with boost so spool rises naturally)
    const onnessExt = lerpTable(m.throttleCurve.ext, effThrottle);
    const boost = Math.max(0, inp.boostBarGauge);
    const boostFade = Math.min(1, boost / 0.25) * (0.35 + 0.65 * Math.min(1, boost / 2.2));
    this.turboOn?.update(boost, boostFade * Math.sin(onnessExt * Math.PI * 0.5), false, now, dt, tau);
    this.turboOff?.update(boost, boostFade * Math.cos(onnessExt * Math.PI * 0.5), false, now, dt, tau);

    // Transmission whine (`drivetrain_speed`; taken as road speed in km/h, clamped to its 0..300 range)
    const ds = Math.min(300, Math.max(0, inp.speedKmh));
    const minDs = this.transOn?.voices[0]?.key ?? 20;
    const dsFade = Math.min(1, ds / Math.max(20, minDs * 0.45));
    const dsAxis = Math.max(25, ds);
    this.transOn?.update(dsAxis, dsFade * Math.sin(onnessExt * Math.PI * 0.5), true, now, dt, tau);
    this.transOff?.update(dsAxis, dsFade * Math.cos(onnessExt * Math.PI * 0.5), true, now, dt, tau);

    // Lift-off: blow-off valve + overrun backfires / pops
    this.popCooldown = Math.max(0, this.popCooldown - dt);
    const lifted = this.prevThrottle > 0.55 && foot < 0.15;
    if (lifted) {
      this.liftTimer = 0.9;
      if (boost > 0.8) this.playOneshot('blowoff', 0.35 * Math.min(1, boost / 2));
      // Not on top of a downshift's pop this frame or a moment ago
      if (rpm > (m.lift?.popMinRpm ?? 8500) && this.popCooldown === 0) {
        const role = inp.view === 'int' ? 'backfire_int' : Math.random() < 0.5 ? 'backfire_ext' : 'pop_ext';
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) this.playOneshot(role, 0.4, i * (0.06 + Math.random() * 0.09));
        this.popCooldown = 0.25;
      }
    }
    this.liftTimer = Math.max(0, this.liftTimer - dt);
    const crackleMinRpm = m.lift?.crackleMinRpm ?? 9000;
    if (this.liftTimer > 0 && foot < 0.1 && rpm > crackleMinRpm && this.popCooldown === 0 && Math.random() < dt * 3.5) {
      this.playOneshot(inp.view === 'int' ? 'backfire_int' : 'pop_ext', 0.28);
      this.popCooldown = 0.12;
    }
    this.prevThrottle = foot;

    // Tyre skid (the bank's own recordings, per view) and the traction-control cut
    for (const view of ['ext', 'int'] as Vf26View[]) {
      const viewLevel = view === 'int' ? this.viewMix : 1 - this.viewMix;
      this.skidVoices[view]?.set(viewLevel > 0.002 ? (inp.skid ?? 0) : 0, inp.skidRate ?? 1, now, dt, 0.05);
    }
    this.tcLevel += ((inp.tcActive ? 1 : 0) - this.tcLevel) * Math.min(1, dt / (inp.tcActive ? 0.03 : 0.12));
    this.tcVoice?.set(this.tcLevel * 0.35, 1, now, dt, 0.03);

    // Rev limiter bounce (interior limiter recording), retriggered while held on the limiter
    this.limiterCooldown = Math.max(0, this.limiterCooldown - dt);
    if (rpm >= inp.limiterRpm - 60 && thr > 0.9 && this.limiterCooldown === 0) {
      this.playOneshot('limiter', inp.view === 'int' ? 0.3 : 0.18);
      this.limiterCooldown = m.limiterRetriggerS ?? 0.9;
    }
  }

  /**
   * After a gap in the updates (pause, mute, a restart): the next frame re-reads the gear and pedal instead of
   * hearing a shift or a lift from the values before the gap, and the shift and lift envelopes of before it end
   */
  public resync(): void {
    this.primed = false;
    this.upshiftTimer = 0;
    this.downshiftTimer = 0;
    this.liftTimer = 0;
  }

  public setLevel(level: number): void {
    this.bus.gain.setTargetAtTime(level, this.ctx.currentTime, 0.04);
  }

  public dispose(): void {
    for (const view of ['ext', 'int'] as Vf26View[]) {
      this.engine[view].on?.stopAll();
      this.engine[view].off?.stopAll();
    }
    this.turboOn?.stopAll();
    this.turboOff?.stopAll();
    this.transOn?.stopAll();
    this.transOff?.stopAll();
    for (const v of Object.values(this.skidVoices)) v?.stop();
    this.tcVoice?.stop();
    this.engineFilter.disconnect();
    this.engineShelf.disconnect();
    this.bus.disconnect();
    this.ready = false;
    this.disposed = true;
  }
}

/** Responses fetched ahead (during loading) by `prefetchSoundBank`, each handed out once */
const prefetched = new Map<string, Promise<Response>>();
/**
 * Manifest URLs of the banks whose prefetch has started: a bank's files are fetched ahead once, so asking again for a
 * bank already handed out (a remount, swapping back to a car) does not download it all again
 */
const prefetchedBanks = new Set<string>();

function fetchBankFile(url: string): Promise<Response> {
  const early = prefetched.get(url);
  if (early) {
    prefetched.delete(url);
    return early.then((r) => r, () => fetch(url));
  }
  return fetch(url);
}

/** Most prefetched responses kept waiting at once; the oldest are dropped past this (a car never loaded) */
const MAX_PREFETCHED = 400;

function rememberPrefetch(url: string, response: Promise<Response>): void {
  // Handled here so a failed early fetch is not an unhandled rejection; fetchBankFile retries it
  response.catch(() => {});
  prefetched.set(url, response);
  while (prefetched.size > MAX_PREFETCHED) {
    const oldest = prefetched.keys().next().value;
    if (oldest === undefined) break;
    prefetched.delete(oldest);
  }
}

/**
 * Starts downloading a car's sound bank (manifest and every file) at low priority while the loading screen is up, so
 * the sound is there as soon as the audio unlocks on the first key press. Decoding still waits for the AudioContext.
 */
export function prefetchSoundBank(assetDir: string): void {
  if (typeof window === 'undefined') return;
  const manifestUrl = withBasePath(`${assetDir}manifest.json`);
  if (prefetchedBanks.has(manifestUrl)) return;
  prefetchedBanks.add(manifestUrl);
  const init = { priority: 'low' } as RequestInit;
  const manifest = fetch(manifestUrl, init);
  rememberPrefetch(manifestUrl, manifest.then((r) => r.clone()));
  // No manifest fetched: a later call may try again
  const forget = () => prefetchedBanks.delete(manifestUrl);
  void manifest
    .then((r) => (r.ok ? (r.json() as Promise<Vf26AudioManifest>) : null))
    .then((m) => {
      if (!m) {
        forget();
        return;
      }
      const files = new Set<string>([
        ...Object.values(m.engine ?? {}).flat().map((e) => e.file),
        ...(m.transmission ?? []).map((e) => e.file),
        ...(m.turbo ?? []).map((e) => e.file),
        ...(m.oneshots ?? []).map((e) => e.file),
        ...Object.values(m.skid ?? {}).filter(Boolean).map((e) => (e as { file: string }).file),
        ...(m.tractionControl ? [m.tractionControl.file] : []),
      ]);
      for (const f of files) {
        const url = withBasePath(assetDir + f);
        if (!prefetched.has(url)) rememberPrefetch(url, fetch(url, init));
      }
    })
    .catch(forget);
}
