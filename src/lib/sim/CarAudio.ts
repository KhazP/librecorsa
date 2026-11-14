/**
 * Web Audio Multi-Sample & Procedural Vehicle Sound Engine (`CarAudio.ts`)
 *
 * 1. `calculateEngineSound`:
 *    - Equal-power RPM + throttle-load crossfading across 5 F1 audio loops
 *      (`idle/low`, `mid_bark`, `high_roar`, `top_scream`, and off-throttle `overrun`).
 *    - Dynamic low-pass exhaust resonance filter:
 *      `engine.lp = (0.75 * rev_cor^2 + 0.25) * smooth_accel + (1 - smooth_accel) * 0.25 * rev_cor^2`
 *    - First-order turbo lag model:
 *      `turbo_lag = 0.9 * turbo_lag + 0.1 * smooth_accel; turbo_ilag = exp(-3.0 * turbo_lag)`
 *    - Gear change ignition cut (`gear_changing` envelope dip + overrun pop).
 * 2. `calculateAeroSound`:
 *    - Transmission / axle whine (`axle.a = 0.2 * sqrt(v * 0.05)`, `axle.f = v * 0.06`)
 *    - Velocity-squared aerodynamic wind noise (`aero.a = min(u2 * 0.0001 + 0.1, 1.0) * 0.6`)
 * 3. `calculateTyreSound`:
 *    - Per-wheel (`i = 0..3`) tire squeal & scrub driven by combined slip `s = hypot(sx, sy)`
 *      multiplied by vertical normal load `Fz` (AC's `0.4 * s * Fz * 0.0002 - 0.1`, here with s × 4.5 and −0.12)
 *    - Kerb rumble strip impact resonance and off-track grass/gravel skid layers.
 * 4. `ContactAcousticsRig` (`contact-acoustics.ts`) adds road roar, damper thump and chassis rattle, brake squeal
 *    and debris clicks.
 *
 * When a multi-grid sound bank is present (`public/lc26/audio/` or `public/gt3/audio/`, see `lc26-audio.ts`),
 * engine, turbo, transmission, shifts and backfires come from the multi-layer bank instead of the
 * base samples / oscillators above; tyre, kerb, gravel and wind layers stay procedural unless the bank
 * includes dedicated skid loops.
 */

import * as THREE from 'three';
import { CameraMode, TelemetryData } from '@/types/f1';
import { withBasePath } from '@/lib/base-path';
import { CAMERA_MODES } from '@/lib/render/camera-modes';
import { ContactAcousticsRig } from './contact-acoustics';
import { LC26_AUDIO_DIR, Lc26SoundBank } from './lc26-audio';
import { LC26_ENGINE } from './lc26-data';
import { AMG_GT3_CONFIG } from './gt3/AmgGt3Config';

/** Where a car's converted sound bank lives, and its rev limiter (for the limiter bounce) */
export interface CarSoundSource {
  id: string;
  assetDir: string;
  limiterRpm: number;
  /**
   * The limiter of the vehicle model driving this sound, when it differs from the recording's: the engine rpm is
   * scaled by limiterRpm / physicsLimiterRpm so a bank sweeps its whole range (and hits its limiter) on the physics'
   * limiter, e.g. the BMW's 7 000 rpm bank on the AMG GT3 model's 7 900
   */
  physicsLimiterRpm?: number;
}

export const LC26_SOUND: CarSoundSource = { id: 'lc26', assetDir: LC26_AUDIO_DIR, limiterRpm: LC26_ENGINE.limiterRpm };
export const F1_2026_SOUND: CarSoundSource = { id: 'f12026', assetDir: '/cars/f12026/audio/', limiterRpm: 12500 };
/** The AMG GT3 vehicle model's limiter (its gearbox redline) */
const AMG_GT3_LIMITER_RPM = AMG_GT3_CONFIG.gearbox.gears.redline_rpm;
export const BMW_M4_GT3_SOUND: CarSoundSource = { id: 'bmw-m4-gt3', assetDir: '/cars/bmw-m4-gt3/audio/', limiterRpm: 7000, physicsLimiterRpm: AMG_GT3_LIMITER_RPM };



interface SampleLayerDef {
  id: 'low' | 'mid' | 'high' | 'top' | 'overrun';
  url: string;
  baseRpm: number;
  centerRpm: number;
  widthRpm: number;
  isOverrun?: boolean;
}

const F1_SAMPLE_LAYERS: SampleLayerDef[] = [
  {
    id: 'low',
    url: '/audio/f1_real_v6_low.wav',
    baseRpm: 7080,
    centerRpm: 5600,
    widthRpm: 3400,
  },
  {
    id: 'mid',
    url: '/audio/f1_real_mid_bark.wav',
    baseRpm: 9000,
    centerRpm: 8600,
    widthRpm: 3200,
  },
  {
    id: 'high',
    url: '/audio/f1_real_high_roar.wav',
    baseRpm: 10920,
    centerRpm: 11000,
    widthRpm: 2800,
  },
  {
    id: 'top',
    url: '/audio/f1_real_top_scream.wav',
    baseRpm: 12600,
    centerRpm: 13200,
    widthRpm: 3000,
  },
  {
    id: 'overrun',
    url: '/audio/f1_real_overrun.wav',
    baseRpm: 8760,
    centerRpm: 9500,
    widthRpm: 5500,
    isOverrun: true,
  },
];

interface ActiveSampleNode {
  def: SampleLayerDef;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * What plays the engine, one at a time: the car's sound bank; the bundled WAV loops (the synthesised sub-harmonic,
 * turbo and axle voices under them); those synthesised voices alone (no bank, no loops); or nothing while the car's
 * bank is loading (at the start, and after a car change)
 */
type EngineVoice = 'loading' | 'bank' | 'samples' | 'synth';

export class CarAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private engineExhaustFilter: BiquadFilterNode | null = null;
  private engineSampleBus: GainNode | null = null;

  private subHarmonicOsc: OscillatorNode | null = null;
  private subHarmonicFilter: BiquadFilterNode | null = null;
  private subHarmonicGain: GainNode | null = null;

  // Turbocharger & 2026 MGU-K / Transmission Axle Whine (`CarSoundData.cpp` turbo_ilag & axle)
  private turboOsc: OscillatorNode | null = null;
  private turboGain: GainNode | null = null;
  private axleOsc: OscillatorNode | null = null;
  private axleGain: GainNode | null = null;

  private tyreSquealOsc: OscillatorNode | null = null;
  private tyreSquealFilter: BiquadFilterNode | null = null;
  private tyreSquealGain: GainNode | null = null;

  private tyreScrubFilter: BiquadFilterNode | null = null;
  private tyreScrubGain: GainNode | null = null;

  private kerbOsc: OscillatorNode | null = null;
  private kerbFilter: BiquadFilterNode | null = null;
  private kerbGain: GainNode | null = null;

  private gravelFilter: BiquadFilterNode | null = null;
  private gravelGain: GainNode | null = null;

  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private sampleNodes: ActiveSampleNode[] = [];
  private samplesLoaded = false;
  private isLoadingSamples = false;
  /** Bumped by dispose(): a sample load still in flight from the closed context is then thrown away */
  private sampleGen = 0;
  /** What plays the engine; set only by `setEngineVoice` (see `EngineVoice`) */
  private engineVoice: EngineVoice = 'loading';

  // Multi-grid sound bank (null until loaded; stays null when the assets are absent)
  private lc26: Lc26SoundBank | null = null;
  private contactAcoustics: ContactAcousticsRig | null = null;
  private sound: CarSoundSource = LC26_SOUND;
  private bankDestination: AudioNode | null = null;
  private fallbackDestination: AudioNode | null = null;
  /** Bumped per bank load so a slow load for a car that has since been swapped out is dropped */
  private bankLoadId = 0;
  private cameraMode: CameraMode = 'chase';

  private isMuted = false;
  private isPaused = false;

  /** The audio graph is built: true exactly while there is a context (init() assigns it last, dispose() clears it) */
  public get isInitialized(): boolean {
    return this.ctx !== null;
  }

  // State variables ported from `CarSoundData.cpp`
  private smoothAccel = 0.01;
  private turboLag = 0.25;
  private prevGear = 0;
  private shiftCutTimer = 0;
  private smoothedRpm = 4200;
  /**
   * Set whenever a frame goes unheard (muted, paused, the context not running), on a car change and before the first
   * frame: the next frame heard only takes the gear and pedal as they are, so a shift, a restart or a lift made in the
   * gap fires no shift cut, gear sound, blip or pop
   */
  private edgesStale = true;

  public init(): void {
    if (this.isInitialized || typeof window === 'undefined') return;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    try {
      this.buildGraph(ctx);
    } catch (err) {
      // Half built: close this context, so the next init() starts clean instead of opening a second one beside it
      try {
        void Promise.resolve(ctx.close()).catch(() => {});
      } catch {
        // Ignore
      }
      throw err;
    }
    this.ctx = ctx;
    this.edgesStale = true;
    // A context can start suspended (the autoplay rules): resumed at once, while the press that made it still counts
    this.resumeContext();
    void this.loadEngineSounds(ctx);
  }

  /** Resumes a suspended context; a refusal (no user gesture yet) leaves it for the next press */
  private resumeContext(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'suspended') return;
    try {
      void Promise.resolve(ctx.resume()).catch(() => {});
    } catch {
      // Ignore: the next press tries again
    }
  }

  /** Builds the voices and buses on `ctx` (init() only takes the context once this has finished) */
  private buildGraph(ctx: AudioContext): void {
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 12;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.12;

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.outputLevel();
    compressor.connect(masterGain);
    masterGain.connect(ctx.destination);
    this.masterGain = masterGain;

    // 1. Engine Exhaust Low-Pass Resonance Filter (`engine.lp` from `CarSoundData.cpp`)
    const engineExhaustFilter = ctx.createBiquadFilter();
    engineExhaustFilter.type = 'lowpass';
    engineExhaustFilter.frequency.value = 2400;
    engineExhaustFilter.Q.value = 0.85;
    engineExhaustFilter.connect(compressor);
    this.engineExhaustFilter = engineExhaustFilter;

    const engineSampleBus = ctx.createGain();
    engineSampleBus.gain.value = 0.92;
    engineSampleBus.connect(engineExhaustFilter);
    this.engineSampleBus = engineSampleBus;

    // Half the V6's firing frequency under the engine samples, low-passed
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = 105;
    const subFilter = ctx.createBiquadFilter();
    subFilter.type = 'lowpass';
    subFilter.frequency.value = 240;
    subFilter.Q.value = 0.7;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.0;
    subOsc.connect(subFilter);
    subFilter.connect(subGain);
    subGain.connect(compressor);
    subOsc.start();
    this.subHarmonicOsc = subOsc;
    this.subHarmonicFilter = subFilter;
    this.subHarmonicGain = subGain;

    // 2. Turbocharger Spool (`turbo_ilag` in `CarSoundData.cpp`)
    const turboOsc = ctx.createOscillator();
    turboOsc.type = 'sine';
    turboOsc.frequency.value = 1800;
    const turboFilter = ctx.createBiquadFilter();
    turboFilter.type = 'bandpass';
    turboFilter.frequency.value = 2200;
    turboFilter.Q.value = 3.2;
    const turboGain = ctx.createGain();
    turboGain.gain.value = 0;
    turboOsc.connect(turboFilter);
    turboFilter.connect(turboGain);
    turboGain.connect(compressor);
    turboOsc.start();
    this.turboOsc = turboOsc;
    this.turboGain = turboGain;

    // 3. Transmission / Straight-Cut Gear Whine (`axle.a`, `axle.f` in `CarSoundData.cpp`)
    const axleOsc = ctx.createOscillator();
    axleOsc.type = 'sine';
    axleOsc.frequency.value = 650;
    const axleFilter = ctx.createBiquadFilter();
    axleFilter.type = 'bandpass';
    axleFilter.frequency.value = 1100;
    axleFilter.Q.value = 2.5;
    const axleGain = ctx.createGain();
    axleGain.gain.value = 0;
    axleOsc.connect(axleFilter);
    axleFilter.connect(axleGain);
    axleGain.connect(compressor);
    axleOsc.start();
    this.axleOsc = axleOsc;
    this.axleGain = axleGain;

    // 4. Shared Pink/White Noise Buffer for Tire Scrub, Gravel, Aero Wind and the contact rig
    const noiseBuffer = this.createPinkNoiseBuffer(ctx, 2.5);

    // Tire tonal squeal + bandpass scrub (`calculateTyreSound` in `CarSoundData.cpp`)
    const squealOsc = ctx.createOscillator();
    squealOsc.type = 'sine';
    squealOsc.frequency.value = 920;
    const squealFilter = ctx.createBiquadFilter();
    squealFilter.type = 'bandpass';
    squealFilter.frequency.value = 980;
    squealFilter.Q.value = 5.5;
    const squealGain = ctx.createGain();
    squealGain.gain.value = 0;
    squealOsc.connect(squealFilter);
    squealFilter.connect(squealGain);
    squealGain.connect(compressor);
    squealOsc.start();
    this.tyreSquealOsc = squealOsc;
    this.tyreSquealFilter = squealFilter;
    this.tyreSquealGain = squealGain;

    const scrubSource = ctx.createBufferSource();
    scrubSource.buffer = noiseBuffer;
    scrubSource.loop = true;
    const scrubFilter = ctx.createBiquadFilter();
    scrubFilter.type = 'bandpass';
    scrubFilter.frequency.value = 840;
    scrubFilter.Q.value = 2.4;
    const scrubGain = ctx.createGain();
    scrubGain.gain.value = 0;
    scrubSource.connect(scrubFilter);
    scrubFilter.connect(scrubGain);
    scrubGain.connect(compressor);
    scrubSource.start();
    this.tyreScrubFilter = scrubFilter;
    this.tyreScrubGain = scrubGain;

    // Kerb serrated rumble strip oscillator (`SURF_KERB` in `CarSoundData.cpp`)
    const kerbOsc = ctx.createOscillator();
    kerbOsc.type = 'triangle';
    kerbOsc.frequency.value = 58;
    const kerbFilter = ctx.createBiquadFilter();
    kerbFilter.type = 'lowpass';
    kerbFilter.frequency.value = 155;
    const kerbGain = ctx.createGain();
    kerbGain.gain.value = 0;
    kerbOsc.connect(kerbFilter);
    kerbFilter.connect(kerbGain);
    kerbGain.connect(compressor);
    kerbOsc.start();
    this.kerbOsc = kerbOsc;
    this.kerbFilter = kerbFilter;
    this.kerbGain = kerbGain;

    // Off-track Grass / Gravel noise (`SURF_GRASS` / `SURF_SAND` in `CarSoundData.cpp`)
    const gravelSource = ctx.createBufferSource();
    gravelSource.buffer = noiseBuffer;
    gravelSource.loop = true;
    const gravelFilter = ctx.createBiquadFilter();
    gravelFilter.type = 'bandpass';
    gravelFilter.frequency.value = 1450;
    gravelFilter.Q.value = 1.4;
    const gravelGain = ctx.createGain();
    gravelGain.gain.value = 0;
    gravelSource.connect(gravelFilter);
    gravelFilter.connect(gravelGain);
    gravelGain.connect(compressor);
    gravelSource.start();
    this.gravelFilter = gravelFilter;
    this.gravelGain = gravelGain;

    // Aerodynamic Wind Rush (`calculateAeroSound` in `CarSoundData.cpp`)
    const windSource = ctx.createBufferSource();
    windSource.buffer = noiseBuffer;
    windSource.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 380;
    windFilter.Q.value = 0.9;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSource.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(compressor);
    windSource.start();
    this.windFilter = windFilter;
    this.windGain = windGain;

    this.contactAcoustics = new ContactAcousticsRig(ctx, compressor, noiseBuffer);

    this.bankDestination = compressor;
    this.fallbackDestination = engineSampleBus;
  }

  /** The car whose sound bank plays; swaps the bank when the car changes */
  public setCar(sound: CarSoundSource): void {
    // Also when the sound stays: the lc26 and f12026-car physics share one
    this.contactAcoustics?.reset();
    // Another car: its gear and pedal are not the last car's
    this.edgesStale = true;
    if (sound.id === this.sound.id) return;
    this.sound = sound;
    if (!this.ctx) return;
    this.lc26?.dispose();
    this.lc26 = null;
    void this.loadEngineSounds(this.ctx);
  }

  /**
   * The one place the engine's voice changes: the sources not in use are faded out. The synthesised sub-harmonic,
   * turbo and axle voices play under the WAV loops ('samples') and alone ('synth'), never beside the bank
   */
  private setEngineVoice(voice: EngineVoice): void {
    this.engineVoice = voice;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (voice !== 'samples') {
      for (const l of this.sampleNodes) l.gain.gain.setTargetAtTime(0, now, 0.05);
    }
    if (voice === 'bank' || voice === 'loading') {
      this.subHarmonicGain?.gain.setTargetAtTime(0, now, 0.05);
      this.turboGain?.gain.setTargetAtTime(0, now, 0.05);
      this.axleGain?.gain.setTargetAtTime(0, now, 0.05);
    }
  }

  /** Prefer the car's converted sound bank; fall back to the bundled F1 loops when it is not available */
  private async loadEngineSounds(ctx: AudioContext): Promise<void> {
    const loadId = ++this.bankLoadId;
    this.setEngineVoice('loading');
    const bank = new Lc26SoundBank(ctx, this.bankDestination ?? this.masterGain ?? ctx.destination, this.sound.assetDir);
    const ok = await bank.load(CAMERA_MODES[this.cameraMode].interiorAudio ? 'int' : 'ext');
    // A later car, or dispose() (a closed context): this load is not wanted any more
    if (loadId !== this.bankLoadId || this.ctx !== ctx) {
      bank.dispose();
      return;
    }
    if (ok) {
      this.lc26 = bank;
      this.setEngineVoice('bank');
      return;
    }
    bank.dispose();
    if (this.samplesLoaded) {
      this.setEngineVoice('samples');
      return;
    }
    // The synthesised voices until the WAV loops are in (loadRealSamples switches to them)
    this.setEngineVoice('synth');
    await this.loadRealSamples(ctx, this.fallbackDestination ?? this.masterGain ?? ctx.destination);
  }

  /** Current camera, used to pick the interior or exterior engine sound */
  public setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
  }

  /** The audio context, once `init` has run (other sound sources, e.g. the opponent cars, share it) */
  public get context(): AudioContext | null {
    return this.ctx;
  }

  /** The master gain (mute and pause): other sound sources connect here so the same switches apply to them */
  public get output(): AudioNode | null {
    return this.masterGain;
  }

  /** True when the LC26 mod sound bank is playing instead of the bundled samples */
  public get usingLc26Sounds(): boolean {
    return this.engineVoice === 'bank';
  }

  private createPinkNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  private async loadRealSamples(ctx: AudioContext, destination: AudioNode): Promise<void> {
    if (this.samplesLoaded || this.isLoadingSamples) return;
    this.isLoadingSamples = true;
    const gen = this.sampleGen;

    try {
      const loaded: ActiveSampleNode[] = [];
      for (const def of F1_SAMPLE_LAYERS) {
        const res = await fetch(withBasePath(def.url));
        if (!res.ok) continue;

        const ab = await res.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(ab);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = true;

        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(destination);
        source.start(0, 0);
        loaded.push({ def, source, gain });
      }
      if (gen !== this.sampleGen) {
        // Disposed meanwhile: these nodes belong to a closed context
        for (const l of loaded) {
          try {
            l.source.stop();
          } catch {
            // Ignore
          }
        }
        return;
      }
      if (loaded.length > 0) {
        this.sampleNodes = loaded;
        this.samplesLoaded = true;
        // They take over from the synthesised voices they were loaded to replace (not from a bank loaded since)
        if (this.engineVoice === 'synth') this.setEngineVoice('samples');
      }
    } catch {
      // Fallback to warm sub-harmonic synthesis if network sample load fails
    } finally {
      if (gen === this.sampleGen) this.isLoadingSamples = false;
    }
  }

  public resume(): void {
    if (!this.isInitialized) {
      this.init();
    }
    this.resumeContext();
  }

  /** Master volume, 0 to 1 (Settings > Audio): every sound reaches the speakers through the master gain */
  private volume = 1;

  /** The master gain's level: silent while muted or paused, else the mix level times the master volume */
  private outputLevel(): number {
    return this.isMuted || this.isPaused ? 0 : 0.36 * this.volume;
  }

  public setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (v === this.volume) return;
    this.volume = v;
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.outputLevel(), this.ctx.currentTime, 0.04);
    }
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.outputLevel(), this.ctx.currentTime, 0.04);
    }
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public setPaused(paused: boolean): void {
    if (this.isPaused === paused) return;
    this.isPaused = paused;
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.outputLevel(), this.ctx.currentTime, 0.025);
    }
  }

  public getPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Short cockpit tones over the engine, through the master gain (so mute and pause apply): a rising two-tone
   * when DRS becomes available, a bright chime when the flap opens, and a short shift beep.
   */
  public cue(kind: 'drs_available' | 'drs_open' | 'shift'): void {
    const ctx = this.ctx;
    const out = this.masterGain;
    if (!ctx || !out || this.isMuted || this.isPaused || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + 0.005;
    const tone = (freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const a = t0 + start;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(gain, a + 0.006);
      g.gain.setTargetAtTime(0, a + dur * 0.55, dur * 0.22);
      osc.connect(g).connect(out);
      osc.start(a);
      osc.stop(a + dur + 0.25);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    };
    switch (kind) {
      case 'drs_available':
        // Low-high pair (B5, E6)
        tone(988, 0, 0.09, 0.42, 'triangle');
        tone(1319, 0.11, 0.12, 0.42, 'triangle');
        break;
      case 'drs_open':
        // Bell-like: fundamental, a fifth over it and a soft octave
        tone(1568, 0, 0.42, 0.34);
        tone(2349, 0, 0.32, 0.16);
        tone(3136, 0, 0.22, 0.08);
        break;
      case 'shift':
        tone(2600, 0, 0.055, 0.32, 'square');
        break;
    }
  }

  /** One frame of the player's car; `dtSeconds` is the frame time */
  public update(telemetry: TelemetryData, dtSeconds?: number): void {
    if (!this.ctx) return;
    // The same test as cue() and the opponents': nothing is heard unless the context runs
    const running = this.ctx.state === 'running';
    if (this.isMuted || this.isPaused || !running) {
      this.edgesStale = true;
      // A context that is not running has its audio clock standing still, so the rig cannot see this gap itself
      if (!running) this.contactAcoustics?.reset();
      return;
    }
    // A physics blow-up must neither throw from an AudioParam inside the frame loop nor stick in the smoothed state
    const t = telemetry;
    if (!(Number.isFinite(t.speedKmh) && Number.isFinite(t.rpm) && Number.isFinite(t.throttle) && Number.isFinite(t.brake))) {
      return;
    }
    // First frame heard after a gap: take the gear (here and in the bank) as it is now
    if (this.edgesStale) {
      this.edgesStale = false;
      this.prevGear = telemetry.gear;
      this.shiftCutTimer = 0;
      this.lc26?.resync();
    }

    const now = this.ctx.currentTime;
    const tau = 0.024;
    const legacyDt = THREE.MathUtils.clamp(Number.isFinite(dtSeconds) ? (dtSeconds as number) : 1 / 60, 0, 0.1);

    const lc26 = this.engineVoice === 'bank' ? this.lc26 : null;
    const squeal = this.tyreSqueal(telemetry);
    // A bank with its own skid recordings plays them in place of the synthesised squeal and scrub
    const bankSkid = lc26?.hasSkid === true;
    if (lc26) {
      const rpmScale = this.sound.physicsLimiterRpm ? this.sound.limiterRpm / this.sound.physicsLimiterRpm : 1;
      lc26.update(
        {
          rpm: telemetry.rpm * rpmScale,
          // The load the engine delivers: the pedal less the traction control's cut, so the cut is heard
          throttle: telemetry.throttle * (1 - THREE.MathUtils.clamp(telemetry.liveTuner?.tcCutFraction ?? 0, 0, 1)),
          pedal: telemetry.throttle,
          gear: telemetry.gear,
          speedKmh: telemetry.speedKmh,
          boostBarGauge: Math.max(0, telemetry.turboBoostBar - 1),
          view: CAMERA_MODES[this.cameraMode].interiorAudio ? 'int' : 'ext',
          limiterRpm: this.sound.limiterRpm,
          // sqrt: the recordings are already a full skid, so a light slide comes in early
          skid: bankSkid ? 0.55 * Math.sqrt(squeal.amp) : 0,
          skidRate: 0.85 + 0.25 * squeal.pitch,
          tcActive: telemetry.f12026?.tcActive ?? false,
        },
        legacyDt
      );
    }

    // The smoothing constants below were tuned per 60 Hz frame; scale them to the real frame time
    const per60 = (k: number) => 1 - Math.pow(1 - k, legacyDt * 60);
    const rawRpm = THREE.MathUtils.clamp(telemetry.rpm, 4000, 15000);
    this.smoothedRpm += (rawRpm - this.smoothedRpm) * per60(0.28);
    const rpm = this.smoothedRpm;
    const redlineRpm = 13200;

    // 1. Port of `CarSoundData::calculateEngineSound`
    // mp = enginerpm / enginerpmRedLine
    const mp = THREE.MathUtils.clamp(rpm / redlineRpm, 0.25, 1.15);
    const revCor = mp - 0.5;

    // smooth_accel = smooth_accel * 0.5 + 0.5 * (accelCmd * 0.99 + 0.01)
    const accelCmd = THREE.MathUtils.clamp(telemetry.throttle, 0, 1);
    this.smoothAccel += (accelCmd * 0.99 + 0.01 - this.smoothAccel) * per60(0.18);

    // engine.lp = (0.75 * rev_cor^2 + 0.25) * smooth_accel + (1 - smooth_accel) * 0.25 * rev_cor^2
    const engineLp =
      (0.75 * revCor * revCor + 0.25) * this.smoothAccel +
      (1.0 - this.smoothAccel) * 0.25 * revCor * revCor;

    // Gear shift detection (`gear_changing` in `CarSoundData.cpp`): between forward gears only (0 is neutral, -1
    // reverse), the same rule as the bank's shift sounds
    if (telemetry.gear !== this.prevGear) {
      if (this.prevGear > 0 && telemetry.gear > 0) this.shiftCutTimer = 0.065; // 65ms seamless shift ignition cut
      this.prevGear = telemetry.gear;
    }
    if (this.shiftCutTimer > 0) {
      this.shiftCutTimer = Math.max(0, this.shiftCutTimer - legacyDt);
    }
    const shiftDip = this.shiftCutTimer > 0 ? 0.52 : 1.0;

    // Map `engine.lp` to dynamic exhaust low-pass filter cutoff (950 Hz closed throttle -> 7200 Hz full load scream)
    if (this.engineExhaustFilter) {
      const cutoffHz = THREE.MathUtils.clamp(950 + engineLp * 6800 + mp * 1400, 900, 8800);
      this.engineExhaustFilter.frequency.setTargetAtTime(cutoffHz, now, tau);
    }

    // Crossfade across the 5 real F1 WAV sample loops
    if (this.engineVoice === 'samples') {
      const onThrottleWeight = 0.35 + 0.65 * this.smoothAccel;
      const overrunWeight =
        (1.0 - this.smoothAccel) * THREE.MathUtils.clamp((rpm - 5000) / 7000, 0.15, 1.0);

      for (const layer of this.sampleNodes) {
        const rate = THREE.MathUtils.clamp(rpm / layer.def.baseRpm, 0.30, 2.50);
        layer.source.playbackRate.setTargetAtTime(rate, now, 0.018);

        const dist = Math.abs(rpm - layer.def.centerRpm);
        const normDist = dist / layer.def.widthRpm;
        // Raised-cosine equal-power window
        const rpmWindow =
          normDist < 1.0 ? Math.cos(normDist * Math.PI * 0.5) ** 1.35 : 0.0;

        let targetGain = 0;
        if (layer.def.isOverrun) {
          targetGain = rpmWindow * overrunWeight * 0.34;
        } else {
          targetGain = rpmWindow * onThrottleWeight * 0.42 * shiftDip;
        }
        layer.gain.gain.setTargetAtTime(targetGain, now, tau);
      }
    }

    // A four-stroke V6 fires three times per revolution
    const f0 = (rpm / 60) * 3.0;
    // The synthesised engine voices: under the WAV loops, or alone
    const synthVoices = this.engineVoice === 'samples' || this.engineVoice === 'synth';
    if (synthVoices && this.subHarmonicOsc && this.subHarmonicGain && this.subHarmonicFilter) {
      this.subHarmonicOsc.frequency.setTargetAtTime(f0 * 0.5, now, tau);
      this.subHarmonicFilter.frequency.setTargetAtTime(Math.min(260, f0 * 0.85), now, tau);
      const subLevel = (this.engineVoice === 'samples' ? 0.055 : 0.16) * (0.4 + 0.6 * this.smoothAccel) * shiftDip;
      this.subHarmonicGain.gain.setTargetAtTime(subLevel, now, tau);
    }

    // Turbo lag model (`turbo_lag`, `turbo_ilag` in `CarSoundData.cpp` lines 163-168)
    this.turboLag += (this.smoothAccel - this.turboLag) * per60(0.1);
    const turboIlag = Math.exp(-3.0 * this.turboLag);
    if (synthVoices && this.turboOsc && this.turboGain) {
      const turboFreq = 1650 + (1.0 - turboIlag) * 2400 + mp * 850;
      const turboAmp = THREE.MathUtils.clamp((1.0 - turboIlag) * 0.022 * mp, 0, 0.025);
      this.turboOsc.frequency.setTargetAtTime(turboFreq, now, tau);
      this.turboGain.gain.setTargetAtTime(turboAmp, now, tau);
    }

    // 2. Port of `CarSoundData::calculateAeroSound` (Axle Whine + Aero Wind)
    const speedMs = Math.max(0, telemetry.speedKmh / 3.6);
    const u2 = speedMs * speedMs;

    if (synthVoices && this.axleOsc && this.axleGain) {
      // axle.a = 0.2 * sqrt(sqrt(u2) * 0.05), axle.f = sqrt(u2) * 0.06
      const axleFreq = 320 + speedMs * 16.5 + Math.abs(telemetry.mgukPowerKw) * 1.1;
      const axleAmp = THREE.MathUtils.clamp(
        0.022 * Math.sqrt(speedMs * 0.05) * (0.45 + 0.55 * Math.abs(telemetry.throttle - telemetry.brake)),
        0,
        0.028
      );
      this.axleOsc.frequency.setTargetAtTime(axleFreq, now, tau);
      this.axleGain.gain.setTargetAtTime(axleAmp, now, tau);
    }

    if (this.windFilter && this.windGain) {
      // aero.a = min(u2 * 0.0001 + 0.1, 1.0) * 0.6
      const aeroGain = THREE.MathUtils.clamp(u2 * 0.000012, 0, 0.075);
      const aeroCutoff = 260 + speedMs * 14;
      this.windFilter.frequency.setTargetAtTime(aeroCutoff, now, 0.04);
      this.windGain.gain.setTargetAtTime(aeroGain, now, 0.04);
    }

    // 3. Port of `CarSoundData::calculateTyreSound` (see `tyreSqueal`)
    const maxSquealA = bankSkid ? 0 : squeal.amp;
    const avgSquealF = squeal.pitch;

    if (this.tyreSquealOsc && this.tyreSquealFilter && this.tyreSquealGain) {
      const pitchHz = 860 * avgSquealF;
      this.tyreSquealOsc.frequency.setTargetAtTime(pitchHz, now, tau);
      this.tyreSquealFilter.frequency.setTargetAtTime(pitchHz, now, tau);
      this.tyreSquealGain.gain.setTargetAtTime(maxSquealA * 0.032, now, tau);
    }

    if (this.tyreScrubFilter && this.tyreScrubGain) {
      this.tyreScrubFilter.frequency.setTargetAtTime(720 + maxSquealA * 480, now, tau);
      this.tyreScrubGain.gain.setTargetAtTime(maxSquealA * 0.065, now, tau);
    }

    // Kerb serrated rumble (`SURF_KERB` in `CarSoundData.cpp` lines 290-296)
    if (this.kerbOsc && this.kerbFilter && this.kerbGain) {
      const isKerb = telemetry.surface === 'kerb' && speedMs > 4;
      const kerbFreq = THREE.MathUtils.clamp(28 + speedMs * 1.35, 30, 145);
      const kerbAmp = isKerb ? THREE.MathUtils.clamp(speedMs * 0.0018, 0.02, 0.085) : 0;
      this.kerbOsc.frequency.setTargetAtTime(kerbFreq, now, 0.015);
      this.kerbFilter.frequency.setTargetAtTime(kerbFreq * 2.2, now, 0.015);
      this.kerbGain.gain.setTargetAtTime(kerbAmp, now, 0.015);
    }

    // Off-track Grass / Gravel skids (`SURF_GRASS` / `SURF_SAND` in `CarSoundData.cpp`)
    if (this.gravelFilter && this.gravelGain) {
      const isOffTrack =
        (telemetry.surface === 'grass' || telemetry.surface === 'runoff') && speedMs > 3;
      const gravelAmp = isOffTrack
        ? THREE.MathUtils.clamp((0.05 * speedMs + maxSquealA) * 0.028, 0, 0.075)
        : 0;
      this.gravelGain.gain.setTargetAtTime(gravelAmp, now, 0.025);
    }

    this.contactAcoustics?.update(telemetry, legacyDt, CAMERA_MODES[this.cameraMode].interiorAudio);
  }

  /**
   * Port of `CarSoundData::calculateTyreSound`: the loudest wheel's squeal amplitude (0..1) from its combined slip
   * × normal load, and its pitch factor
   */
  private tyreSqueal(telemetry: TelemetryData): { amp: number; pitch: number } {
    const speedMs = Math.max(0, telemetry.speedKmh / 3.6);
    const degToRad = Math.PI / 180;
    const wheelSlipNorms = telemetry.wheelSlipRatios
      ? [
          Math.hypot(telemetry.wheelSlipRatios[0], (telemetry.wheelSlipAnglesDeg?.[0] ?? 0) * degToRad),
          Math.hypot(telemetry.wheelSlipRatios[1], (telemetry.wheelSlipAnglesDeg?.[1] ?? 0) * degToRad),
          Math.hypot(telemetry.wheelSlipRatios[2], (telemetry.wheelSlipAnglesDeg?.[2] ?? 0) * degToRad),
          Math.hypot(telemetry.wheelSlipRatios[3], (telemetry.wheelSlipAnglesDeg?.[3] ?? 0) * degToRad),
        ]
      : telemetry.tireSlipRatio;

    const wheelLoads = telemetry.wheelLoadsN ?? [3200, 3200, 3800, 3800];
    let amp = 0;
    let pitch = 0.85;
    for (let i = 0; i < 4; i++) {
      const s = wheelSlipNorms[i];
      const fz = wheelLoads[i];
      // After CarSoundData.cpp line 272, a = max(min(0.4 * s * reaction_force * 0.0002 - 0.1, 1.0), 0.0) * min(u * 0.1,
      // 1.0), retuned here: s is scaled ×4.5 (our normalised slip peaks lower), the offset is −0.12 and the speed ramp 0.08
      const squealRaw =
        Math.max(0, Math.min(1.0, 0.4 * (s * 4.5) * fz * 0.0002 - 0.12)) *
        Math.min(1.0, speedMs * 0.08);
      if (squealRaw > amp) {
        amp = squealRaw;
        pitch = THREE.MathUtils.clamp(1.2 - 0.3 * s - fz * 0.00002, 0.55, 1.15);
      }
    }
    return { amp, pitch };
  }

  public dispose(): void {
    for (const s of this.sampleNodes) {
      try {
        s.source.stop();
      } catch {
        // Ignore
      }
    }
    this.sampleNodes = [];
    // The next init() builds a new context: the loops have to be fetched and decoded into it again
    this.samplesLoaded = false;
    this.isLoadingSamples = false;
    this.sampleGen++;
    // A bank load still in flight belongs to the closed context: it is dropped when it lands, not played or fallen
    // back from
    this.bankLoadId++;
    this.setEngineVoice('loading');
    this.edgesStale = true;
    // Closing the context below stops the rig's voices with everything else
    this.contactAcoustics = null;
    this.lc26?.dispose();
    this.lc26 = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
