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
 *    - A kerb roar swelling at the rate the tyres cross the kerb's ridges, its tone and level rising with speed,
 *      panned to its side, over a low kerb rumble,
 *      and the off-track grass/gravel skid layers.
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
import { getActiveSurfaceTable } from '@/lib/track-data';

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

/** Kerb ridge spacing (m) for a circuit whose kerbs have no ripple length of their own */
const KERB_RIDGE_FALLBACK_M = 0.65;
/** The fastest the kerb's ridges come (Hz), about 330 km/h over the default ones */
const KERB_MAX_RIDGE_HZ = 140;
/** A wheel carrying less than this (N) is in the air: its surface is still the one it left, so it strikes nothing */
const KERB_MIN_LOAD_N = 150;
/** A side back on the kerbs within this long (s) carries straight on; after longer it strikes the kerb's edge first */
const KERB_REENTRY_S = 0.12;
/** How long (s) after a side's edge strike its roar eases back to its own level */
const KERB_EDGE_S = 0.05;
/**
 * The kerb roar's level, one side's wheels both on the kerb, at speed: in the browser about 14 dB under the whole mix
 * between 400 and 2500 Hz, the compressor barely moving
 */
const KERB_ROAR_LEVEL = 0.57;
/**
 * The part of the kerb roar that rises and falls with each ridge at the reference ridge rate; the rest rolls on between
 * them (see `kerbRidgeDepth`)
 */
const KERB_RIDGE_DEPTH = 0.4;
/**
 * The speed (m/s) the kerb roar's tone is voiced at, 120 km/h. Faster over the kerb the whole roar rises in pitch and
 * slower it falls, as a recorded kerb run played faster or slower would
 */
const KERB_TONE_REF_MS = 120 / 3.6;
/** How closely the roar's tone follows the speed: its filters move by (speed / reference) to this power */
const KERB_TONE_EXP = 0.75;
/** The roar's tone at its lowest and highest, as factors of its voiced tone (about 54 and 340 km/h) */
const KERB_TONE_MIN = 0.55;
const KERB_TONE_MAX = 2.2;
/** The roar's low-pass and the centre of its rattle at the voiced speed (Hz) */
const KERB_ROAR_LOWPASS_HZ = 700;
const KERB_ROAR_RATTLE_HZ = 1600;
/** The ridge rate (Hz) above which the swell starts to flatten: 120 km/h over the most common, 0.65 m ridges */
const KERB_DEPTH_FLATTEN_HZ = 51;

/**
 * How far the kerb roar swells with each ridge at a ridge rate (Hz): as voiced up to 51 ridges a second, then
 * shallower as the ridges come faster and blur into a buzz
 */
function kerbRidgeDepth(ridgeHz: number): number {
  return KERB_RIDGE_DEPTH - 0.08 * THREE.MathUtils.clamp((ridgeHz - KERB_DEPTH_FLATTEN_HZ) / 49, 0, 1);
}

/**
 * The kerb roar's loudness at a speed (m/s), as a factor of KERB_ROAR_LEVEL: 0.7 at a crawl rising to 1 at 144 km/h
 * as voiced, then still rising, to 1.5 (+3.5 dB) by 250 km/h
 */
function kerbSpeedLevel(speedMs: number): number {
  const clamp = THREE.MathUtils.clamp;
  return (0.7 + 0.3 * clamp((speedMs - 4) / 36, 0, 1)) * (1 + 0.5 * clamp((speedMs - 40) / 30, 0, 1));
}

/**
 * One ridge of the kerb roar's swell as harmonics for a PeriodicWave: a strike rising over 2 % of the cycle, then
 * dying away with a time constant of 18 % of it (the Fourier series of that decay, through the rise's one-pole
 * low-pass), in few enough harmonics to stay a swell rather than a click
 */
function kerbRidgeWave(ctx: BaseAudioContext): PeriodicWave {
  const harmonics = 24;
  const decay = 0.18;
  const rise = 0.02;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const k = 1 - Math.exp(-1 / decay);
  for (let h = 1; h <= harmonics; h++) {
    const w = 2 * Math.PI * h;
    const den = 1 / (decay * decay) + w * w;
    const dr = k / decay / den;
    const di = (-k * w) / den;
    const rden = 1 + (w * rise) ** 2;
    const lr = 1 / rden;
    const li = (-w * rise) / rden;
    real[h] = 2 * (dr * lr - di * li);
    imag[h] = -2 * (dr * li + di * lr);
  }
  return ctx.createPeriodicWave(real, imag);
}



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

  /** The kerb roar's low-pass and rattle band, both sides' */
  private kerbRoarLow: BiquadFilterNode | null = null;
  private kerbRoarRattle: BiquadFilterNode | null = null;
  /** Per side (left, right): the kerb roar's ridge-rate swell oscillator, its swell and depth, and its level */
  private kerbRidgeOsc: OscillatorNode[] = [];
  private kerbSwell: GainNode[] = [];
  private kerbSwellDepth: GainNode[] = [];
  private kerbRoarLevel: GainNode[] = [];
  /** Per side: how long it has been on the kerbs, and off them (s) */
  private readonly kerbOnS = [0, 0];
  private readonly kerbOffS = [Infinity, Infinity];

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

    // Kerb rumble: a low triangle at the ridge rate under the kerb roar, heard on headphones and larger speakers
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

    // Kerb roar: what a tyre rolling over a kerb sounds like, a rough low roar (at 120 km/h noise under ~700 Hz with a
    // little ~1.6 kHz rattle, all where laptop and phone speakers still reach) that never stops while a side is on the
    // kerb, swelling with each ridge it crosses: per side, a wave at the ridge rate sways the roar between 60 % and full
    // (shallower when the ridges come very fast). Its tone and level rise with the speed over the kerb. Each side is
    // panned to its own side
    const ridgeWave = kerbRidgeWave(ctx);
    const roar = ctx.createBufferSource();
    roar.buffer = noiseBuffer;
    roar.loop = true;
    const roarLow = ctx.createBiquadFilter();
    roarLow.type = 'lowpass';
    roarLow.frequency.value = KERB_ROAR_LOWPASS_HZ;
    roarLow.Q.value = 0.7;
    const roarRattle = ctx.createBiquadFilter();
    roarRattle.type = 'bandpass';
    roarRattle.frequency.value = KERB_ROAR_RATTLE_HZ;
    roarRattle.Q.value = 1.2;
    const roarBed = ctx.createGain();
    roarBed.gain.value = 10;
    const rattleMix = ctx.createGain();
    rattleMix.gain.value = 7.5;
    roar.connect(roarLow).connect(roarBed);
    roar.connect(roarRattle).connect(rattleMix);
    const ridgeOsc: OscillatorNode[] = [];
    const swells: GainNode[] = [];
    const depths: GainNode[] = [];
    const roarLevel: GainNode[] = [];
    for (const pan of [-0.7, 0.7]) {
      // The swell: the gain sits at 1 − depth and the ridge wave (peak ±1) adds ±depth to it
      const swell = ctx.createGain();
      swell.gain.value = 1 - KERB_RIDGE_DEPTH;
      roarBed.connect(swell);
      rattleMix.connect(swell);
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(ridgeWave);
      osc.frequency.value = 40;
      const depth = ctx.createGain();
      depth.gain.value = KERB_RIDGE_DEPTH;
      osc.connect(depth);
      depth.connect(swell.gain);
      const level = ctx.createGain();
      level.gain.value = 0;
      swell.connect(level);
      // Every current browser has the stereo panner; without one the roar plays in the middle
      if (typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        level.connect(panner).connect(compressor);
      } else {
        level.connect(compressor);
      }
      osc.start();
      ridgeOsc.push(osc);
      swells.push(swell);
      depths.push(depth);
      roarLevel.push(level);
    }
    // An eighth into the shared buffer, where no other loop of it starts (they start at 0, ¼, ½ and ¾)
    roar.start(0, 0.125 * noiseBuffer.duration);
    this.kerbRoarLow = roarLow;
    this.kerbRoarRattle = roarRattle;
    this.kerbRidgeOsc = ridgeOsc;
    this.kerbSwell = swells;
    this.kerbSwellDepth = depths;
    this.kerbRoarLevel = roarLevel;

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
  /** The kerb roar and rumble's level, 0 to 1.5 (Settings > Audio > Kerbs) */
  private kerbVolume = 1;

  public setKerbVolume(volume: number): void {
    this.kerbVolume = Math.min(1.5, Math.max(0, volume));
  }

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
      this.resetKerbRoar(this.ctx.currentTime);
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
          stalled: telemetry.engineStalled === true,
          // Heard only by banks that carry a driveline section or an electric machine loop
          driveshaftRadS: telemetry.driveshaftRadS,
          driveshaftTorqueNm: telemetry.driveshaftTorqueNm,
          mguPowerKw: telemetry.mgukPowerKw,
          mguRpm: telemetry.mguRpm,
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

    const engineAlive = telemetry.engineStalled ? 0 : 1;

    // Crossfade across the 5 real F1 WAV sample loops
    if (this.engineVoice === 'samples') {
      const onThrottleWeight = (0.35 + 0.65 * this.smoothAccel) * engineAlive;
      const overrunWeight =
        (1.0 - this.smoothAccel) * THREE.MathUtils.clamp((rpm - 5000) / 7000, 0.15, 1.0) * engineAlive;

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
      const subLevel = (this.engineVoice === 'samples' ? 0.055 : 0.16) * (0.4 + 0.6 * this.smoothAccel) * shiftDip * engineAlive;
      this.subHarmonicGain.gain.setTargetAtTime(subLevel, now, tau);
    }

    // Turbo lag model (`turbo_lag`, `turbo_ilag` in `CarSoundData.cpp` lines 163-168)
    this.turboLag += (this.smoothAccel - this.turboLag) * per60(0.1);
    const turboIlag = Math.exp(-3.0 * this.turboLag);
    if (synthVoices && this.turboOsc && this.turboGain) {
      const turboFreq = 1650 + (1.0 - turboIlag) * 2400 + mp * 850;
      const turboAmp = THREE.MathUtils.clamp((1.0 - turboIlag) * 0.022 * mp, 0, 0.025) * engineAlive;
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

    // Kerbs: a roar swelling with each ridge the tyres cross, on the side they are on, and the low rumble under it
    const kerbSides = speedMs > 4 ? this.kerbSides(telemetry) : ([0, 0] as const);
    const ridgeHz = this.updateKerbRoar(kerbSides, speedMs, legacyDt, now, CAMERA_MODES[this.cameraMode].interiorAudio);
    if (this.kerbOsc && this.kerbFilter && this.kerbGain) {
      const isKerb = kerbSides[0] > 0 || kerbSides[1] > 0;
      const kerbFreq = THREE.MathUtils.clamp(ridgeHz, 30, 145);
      const kerbAmp = isKerb ? THREE.MathUtils.clamp(speedMs * 0.00227, 0.025, 0.107) * this.kerbVolume : 0;
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
   * How far each side (left, right) is on the kerbs, 0..1: 0.8 for one of its wheels on one, 1 for both. A wheel
   * counts while it carries load, since an airborne wheel still reports the surface it left
   */
  private kerbSides(t: TelemetryData): [number, number] {
    const on = (i: number) => t.wheelSurfaces?.[i] === 'kerb' && !((t.wheelLoadsN?.[i] ?? Infinity) < KERB_MIN_LOAD_N);
    const side = (front: number, rear: number) => {
      const f = on(front);
      const r = on(rear);
      return f && r ? 1 : f || r ? 0.8 : 0;
    };
    // FL, FR, RL, RR
    return [side(0, 2), side(1, 3)];
  }

  /**
   * One frame of the kerb roar; returns the ridge rate (Hz). Each side's roar comes in while it is on the kerbs and
   * goes as it leaves them; a side coming onto the kerbs strikes the edge first, a short burst over the roar
   */
  private updateKerbRoar(
    sides: readonly [number, number],
    speedMs: number,
    dt: number,
    now: number,
    interior: boolean
  ): number {
    const ridgeM = getActiveSurfaceTable().kerb.bumpLengthM;
    const rateHz = speedMs / (ridgeM > 0.2 ? ridgeM : KERB_RIDGE_FALLBACK_M);
    const ridgeHz = Math.min(KERB_MAX_RIDGE_HZ, rateHz);
    // The roar's tone follows the speed over the kerb: low and dull when slow, bright and rasping flat out
    const tone = THREE.MathUtils.clamp((speedMs / KERB_TONE_REF_MS) ** KERB_TONE_EXP, KERB_TONE_MIN, KERB_TONE_MAX);
    this.kerbRoarLow?.frequency.setTargetAtTime(KERB_ROAR_LOWPASS_HZ * tone, now, 0.03);
    this.kerbRoarRattle?.frequency.setTargetAtTime(KERB_ROAR_RATTLE_HZ * tone, now, 0.03);
    const depth = kerbRidgeDepth(rateHz);
    // Louder with speed, and a little quieter from outside the car
    const strength = KERB_ROAR_LEVEL * this.kerbVolume * kerbSpeedLevel(speedMs) * (interior ? 1 : 0.8);
    for (let side = 0; side < 2; side++) {
      const osc = this.kerbRidgeOsc[side];
      const gain = this.kerbRoarLevel[side]?.gain;
      if (!osc || !gain) continue;
      // Slightly apart, so two sides on kerbs beat against each other rather than stacking into one tone
      osc.frequency.setTargetAtTime(Math.max(5, ridgeHz) * (side === 1 ? 1.015 : 1), now, 0.03);
      this.kerbSwell[side]?.gain.setTargetAtTime(1 - depth, now, 0.03);
      this.kerbSwellDepth[side]?.gain.setTargetAtTime(depth, now, 0.03);
      const on = sides[side];
      if (on > 0) {
        const level = on * strength;
        if (this.kerbOffS[side] > KERB_REENTRY_S) {
          this.kerbOnS[side] = 0;
          // The edge strike stops at full level, so the louder roar at high speed does not slam the compressor
          gain.setTargetAtTime(Math.min(level * 1.8, Math.max(level, 1)), now, 0.003);
        } else {
          gain.setTargetAtTime(level, now, this.kerbOnS[side] < KERB_EDGE_S ? 0.025 : 0.012);
        }
        this.kerbOnS[side] += dt;
        this.kerbOffS[side] = 0;
      } else {
        gain.setTargetAtTime(0, now, 0.03);
        this.kerbOffS[side] += dt;
      }
    }
    return ridgeHz;
  }

  /** Silences the kerb roar and drops its history: the next frame heard starts from its own kerbs */
  private resetKerbRoar(now: number): void {
    for (let side = 0; side < 2; side++) {
      this.kerbOnS[side] = 0;
      this.kerbOffS[side] = Infinity;
      const gain = this.kerbRoarLevel[side]?.gain;
      gain?.cancelScheduledValues(now);
      gain?.setValueAtTime(0, now);
    }
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
