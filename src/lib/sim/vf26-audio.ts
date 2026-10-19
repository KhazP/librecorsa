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
}

export type Vf26View = 'ext' | 'int';

export interface Vf26AudioInputs {
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

/** One looping grid point (buffer + lazily created voice) */
class LoopVoice {
  public buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly gain: GainNode;
  private silentFor = 0;
  private wasActive = false;

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
  public set(target: number, rate: number, now: number, dt: number, tau: number): void {
    if (!this.buffer) return;
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
      this.source.playbackRate.setTargetAtTime(rate, now, 0.007);
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
}

/** A 1-D grid of loops (rpm, boost or speed) crossfaded between neighbours with equal-power weights */
class LoopGrid {
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
   */
  public update(x: number, level: number, pitched: boolean, now: number, dt: number, tau: number): void {
    const vs = this.voices;
    if (vs.length === 0) return;
    let i = 0;
    while (i < vs.length - 2 && x >= vs[i + 1].key) i++;
    const lo = vs[i];
    const hi = vs[Math.min(i + 1, vs.length - 1)];
    const rawF = hi === lo ? 0 : Math.min(1, Math.max(0, (x - lo.key) / (hi.key - lo.key)));
    // For wide-anchor pitched engine grids (e.g. the 4-anchor AMR26 bank), keep each anchor playing solo
    // outside the transition window [0.18..0.52] so continuous RPM climbs and gear shifts stay on a single voice.
    const f =
      pitched && vs.length > 1 && vs.length <= 6
        ? Math.min(1, Math.max(0, (rawF - 0.18) / 0.34))
        : rawF;
    for (const v of vs) {
      let w = 0;
      if (v === lo) w = Math.cos(f * Math.PI * 0.5);
      else if (v === hi) w = Math.sin(f * Math.PI * 0.5);
      const rate = pitched ? Math.min(4, Math.max(0.25, x / v.key)) : 1;
      v.set(w * level, rate, now, dt, tau);
    }
  }

  public stopAll(): void {
    for (const v of this.voices) v.stop();
  }
}

const lerpTable = (table: [number, number][], x: number): number => {
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
  private prevThrottle = 0;
  private prevGear = 0;
  private audioRpm = 0;
  private upshiftTimer = 0;
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
  public async load(initialView: Vf26View = 'ext'): Promise<boolean> {
    let manifest: Vf26AudioManifest;
    try {
      const res = await fetch(withBasePath(`${this.assetDir}manifest.json`));
      if (!res.ok) return false;
      manifest = (await res.json()) as Vf26AudioManifest;
    } catch {
      return false;
    }
    if (!manifest.engine?.ext?.length || !manifest.engine?.int?.length) return false;
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
        const res = await fetch(withBasePath(this.assetDir + job.file));
        if (!res.ok) return false;
        job.assign(await ctx.decodeAudioData(await res.arrayBuffer()));
        return true;
      } catch {
        return false;
      }
    };

    const runPool = async (list: Job[], concurrency: number): Promise<number> => {
      let next = 0;
      let failed = 0;
      const worker = async () => {
        while (next < list.length) {
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

    // Gear change: upshift ignition cut + pitch drop, or downshift ECU throttle blip + overrun bark
    if (inp.gear !== this.prevGear) {
      if (this.prevGear !== 0 && inp.gear > 0) {
        const up = inp.gear > this.prevGear;
        if (up) {
          this.upshiftTimer = 0.075;
          this.downshiftTimer = 0;
          this.playOneshot('gear_up', 0.58);
          this.playOneshot('shift_cut', inp.view === 'int' ? 0.42 : 0.28);
        } else {
          this.downshiftTimer = 0.085;
          this.upshiftTimer = 0;
          this.playOneshot('gear_down', 0.55);
          // Downshift blip on the overrun: unburnt fuel bangs in the exhaust and overrun crackle carries on
          const blipPop = m.lift?.downshiftPopChance ?? 0.5;
          if (blipPop > 0 && inp.throttle < 0.2 && inp.rpm > (m.lift?.popMinRpm ?? 8200)) {
            this.liftTimer = Math.max(this.liftTimer, 0.65);
            if (Math.random() < blipPop) {
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

    // Continuous audio RPM tracking: slews across gear shifts over ~50ms so the ear hears the physical pitch drop/blip
    const targetRpm = Math.min(this.rpmRange[1], Math.max(this.rpmRange[0], inp.rpm));
    if (this.audioRpm === 0) {
      this.audioRpm = targetRpm;
    } else if (this.upshiftTimer > 0 || this.downshiftTimer > 0) {
      const span = Math.max(4000, this.rpmRange[1] - this.rpmRange[0]);
      const maxSlew = (this.upshiftTimer > 0 ? span * 4.2 : span * 4.8) * dt;
      const diff = targetRpm - this.audioRpm;
      this.audioRpm += Math.sign(diff) * Math.min(Math.abs(diff), maxSlew);
    } else {
      this.audioRpm += (targetRpm - this.audioRpm) * Math.min(1, dt / 0.008);
    }
    const rpm = this.audioRpm;

    // Upshift cut & engagement envelope + downshift ECU auto-blip
    let shiftOnScale = 1.0;
    let shiftOffScale = 1.0;
    if (this.upshiftTimer > 0) {
      const p = 1 - this.upshiftTimer / 0.075; // 0 -> 1 across the 75ms shift
      if (p < 0.45) {
        shiftOnScale = 0.18;
        shiftOffScale = 0.55;
      } else {
        const reg = (p - 0.45) / 0.55;
        // Punch back into the next gear with a subtle 1.08x transient peak
        shiftOnScale = 0.18 + 0.90 * Math.sin(reg * Math.PI * 0.5);
        shiftOffScale = 0.55 + 0.45 * reg;
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
      this.engine[view].on.update(rpm, active ? wOn : 0, true, now, dt, engineTau);
      this.engine[view].off.update(rpm, active ? wOff : 0, true, now, dt, engineTau);
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
    const lifted = this.prevThrottle > 0.55 && thr < 0.15;
    if (lifted) {
      this.liftTimer = 0.9;
      if (boost > 0.8) this.playOneshot('blowoff', 0.35 * Math.min(1, boost / 2));
      if (rpm > (m.lift?.popMinRpm ?? 8500)) {
        const role = inp.view === 'int' ? 'backfire_int' : Math.random() < 0.5 ? 'backfire_ext' : 'pop_ext';
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) this.playOneshot(role, 0.4, i * (0.06 + Math.random() * 0.09));
        this.popCooldown = 0.25;
      }
    }
    this.liftTimer = Math.max(0, this.liftTimer - dt);
    const crackleMinRpm = m.lift?.crackleMinRpm ?? 9000;
    if (this.liftTimer > 0 && thr < 0.1 && rpm > crackleMinRpm && this.popCooldown === 0 && Math.random() < dt * 3.5) {
      this.playOneshot(inp.view === 'int' ? 'backfire_int' : 'pop_ext', 0.28);
      this.popCooldown = 0.12;
    }
    this.prevThrottle = thr;

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
  }
}
