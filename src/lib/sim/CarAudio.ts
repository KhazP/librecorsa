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
 *      multiplied by vertical normal load `Fz` (`0.4 * s * Fz * 0.0002 - 0.1`)
 *    - Kerb rumble strip impact resonance and off-track grass/gravel skid layers.
 *
 * When a multi-grid sound bank is present (`public/vf26/audio/` or `public/gt3/audio/`, see `vf26-audio.ts`),
 * engine, turbo, transmission, shifts and backfires come from the multi-layer bank instead of the
 * base samples / oscillators above; tyre, kerb, gravel and wind layers stay procedural unless the bank
 * includes dedicated skid loops.
 */

import * as THREE from 'three';
import { CameraMode, TelemetryData } from '@/types/f1';
import { withBasePath } from '@/lib/base-path';
import { AMR26_AUDIO_DIR, VF26_AUDIO_DIR, Vf26SoundBank } from './vf26-audio';
import { VF26_ENGINE } from './vf26-data';

/** Where a car's converted sound bank lives, and its rev limiter (for the limiter bounce) */
export interface CarSoundSource {
  id: string;
  assetDir: string;
  limiterRpm: number;
}

export const AMR26_SOUND: CarSoundSource = { id: 'amr26', assetDir: AMR26_AUDIO_DIR, limiterRpm: VF26_ENGINE.limiterRpm };
export const VF26_SOUND: CarSoundSource = { id: 'vf26', assetDir: VF26_AUDIO_DIR, limiterRpm: VF26_ENGINE.limiterRpm };

/** Cameras mounted on the car use the mod's interior engine event; the rest hear the exterior one */
const INTERIOR_CAMERAS: ReadonlySet<CameraMode> = new Set<CameraMode>(['cockpit', 'cockpit_shoulder', 'nose', 'tv_pod']);


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

export class CarAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private engineExhaustFilter: BiquadFilterNode | null = null;
  private engineSampleBus: GainNode | null = null;

  // Warm low-frequency sub-harmonic reinforcement (heavily low-passed, zero harsh buzz)
  private subHarmonicOsc: OscillatorNode | null = null;
  private subHarmonicFilter: BiquadFilterNode | null = null;
  private subHarmonicGain: GainNode | null = null;

  // Turbocharger & 2026 MGU-K / Transmission Axle Whine (`CarSoundData.cpp` turbo_ilag & axle)
  private turboOsc: OscillatorNode | null = null;
  private turboGain: GainNode | null = null;
  private axleOsc: OscillatorNode | null = null;
  private axleGain: GainNode | null = null;

  // Per-wheel & aggregate tire squeal + scrub + kerb + off-track gravel/grass + aero wind
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

  // VF26 mod sound bank (null until loaded; stays null when the converted assets are absent)
  private vf26: Vf26SoundBank | null = null;
  private sound: CarSoundSource = VF26_SOUND;
  private bankDestination: AudioNode | null = null;
  private fallbackDestination: AudioNode | null = null;
  /** Bumped per bank load so a slow load for a car that has since been swapped out is dropped */
  private bankLoadId = 0;
  private cameraMode: CameraMode = 'chase';

  private isMuted = false;
  public isInitialized = false;

  // State variables ported from `CarSoundData.cpp`
  private smoothAccel = 0.01;
  private turboLag = 0.25;
  private prevGear = 1;
  private shiftCutTimer = 0;
  private smoothedRpm = 4200;

  public init(): void {
    if (this.isInitialized || typeof window === 'undefined') return;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    this.ctx = ctx;

    // Master output with gentle studio limiter (no harsh waveshaper distortion!)
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 12;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.12;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.36;
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

    // Warm low-end V6 firing cadence reinforcement (strictly low-passed below 260 Hz for chest punch)
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

    // 4. Shared Pink/White Noise Buffer for Tire Scrub, Gravel & Aero Wind
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

    this.isInitialized = true;
    this.bankDestination = compressor;
    this.fallbackDestination = engineSampleBus;
    void this.loadEngineSounds(ctx);
  }

  /** The car whose sound bank plays; swaps the bank when the car changes */
  public setCar(sound: CarSoundSource): void {
    if (sound.id === this.sound.id) return;
    this.sound = sound;
    if (!this.isInitialized || !this.ctx) return;
    this.vf26?.dispose();
    this.vf26 = null;
    void this.loadEngineSounds(this.ctx);
  }

  /** Prefer the car's converted sound bank; fall back to the bundled F1 loops when it is not available */
  private async loadEngineSounds(ctx: AudioContext): Promise<void> {
    const loadId = ++this.bankLoadId;
    const bank = new Vf26SoundBank(ctx, this.bankDestination ?? ctx.destination, this.sound.assetDir);
    const ok = await bank.load(INTERIOR_CAMERAS.has(this.cameraMode) ? 'int' : 'ext');
    if (loadId !== this.bankLoadId) {
      bank.dispose();
      return;
    }
    if (ok && this.ctx === ctx) {
      this.vf26 = bank;
      // Silence the legacy engine voices that the bank replaces
      this.subHarmonicGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      this.turboGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      this.axleGain?.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      return;
    }
    bank.dispose();
    if (!this.samplesLoaded && !this.isLoadingSamples) {
      await this.loadRealSamples(ctx, this.fallbackDestination ?? ctx.destination);
    }
  }

  /** Current camera, used to pick the interior or exterior engine sound */
  public setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
  }

  /** True when the VF26 mod sound bank is playing instead of the bundled samples */
  public get usingVf26Sounds(): boolean {
    return this.vf26?.ready === true;
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
      if (loaded.length > 0) {
        this.sampleNodes = loaded;
        this.samplesLoaded = true;
      }
    } catch {
      // Fallback to warm sub-harmonic synthesis if network sample load fails
    } finally {
      this.isLoadingSamples = false;
    }
  }

  public resume(): void {
    if (!this.isInitialized) {
      this.init();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.36, this.ctx.currentTime, 0.04);
    }
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  /**
   * Per-frame audio synthesis update
   */
  public update(telemetry: TelemetryData, dtSeconds?: number): void {
    if (!this.isInitialized || !this.ctx || this.isMuted) return;
    if (this.ctx.state === 'suspended') return;

    const now = this.ctx.currentTime;
    const tau = 0.024;

    const vf26 = this.vf26?.ready ? this.vf26 : null;
    const squeal = this.tyreSqueal(telemetry);
    // A bank with its own skid recordings plays them in place of the synthesised squeal and scrub
    const bankSkid = vf26?.hasSkid === true;
    if (vf26) {
      vf26.update(
        {
          rpm: telemetry.rpm,
          throttle: telemetry.throttle,
          gear: telemetry.gear,
          speedKmh: telemetry.speedKmh,
          boostBarGauge: Math.max(0, telemetry.turboBoostBar - 1),
          view: INTERIOR_CAMERAS.has(this.cameraMode) ? 'int' : 'ext',
          limiterRpm: this.sound.limiterRpm,
          // sqrt: the recordings are already a full skid, so a light slide comes in early
          skid: bankSkid ? 0.55 * Math.sqrt(squeal.amp) : 0,
          skidRate: 0.85 + 0.25 * squeal.pitch,
          tcActive: telemetry.f12026?.tcActive ?? false,
        },
        THREE.MathUtils.clamp(dtSeconds ?? 1 / 60, 0, 0.1)
      );
    }

    const rawRpm = THREE.MathUtils.clamp(telemetry.rpm, 4000, 15000);
    this.smoothedRpm += (rawRpm - this.smoothedRpm) * 0.28;
    const rpm = this.smoothedRpm;
    const redlineRpm = 13200;

    // 1. Port of `CarSoundData::calculateEngineSound`
    // mp = enginerpm / enginerpmRedLine
    const mp = THREE.MathUtils.clamp(rpm / redlineRpm, 0.25, 1.15);
    const revCor = mp - 0.5;

    // smooth_accel = smooth_accel * 0.5 + 0.5 * (accelCmd * 0.99 + 0.01)
    const accelCmd = THREE.MathUtils.clamp(telemetry.throttle, 0, 1);
    this.smoothAccel = this.smoothAccel * 0.82 + 0.18 * (accelCmd * 0.99 + 0.01);

    // engine.lp = (0.75 * rev_cor^2 + 0.25) * smooth_accel + (1 - smooth_accel) * 0.25 * rev_cor^2
    const engineLp =
      (0.75 * revCor * revCor + 0.25) * this.smoothAccel +
      (1.0 - this.smoothAccel) * 0.25 * revCor * revCor;

    // Gear shift detection (`gear_changing` in `CarSoundData.cpp`)
    if (telemetry.gear !== this.prevGear) {
      this.prevGear = telemetry.gear;
      this.shiftCutTimer = 0.065; // 65ms seamless shift ignition cut
    }
    if (this.shiftCutTimer > 0) {
      this.shiftCutTimer = Math.max(0, this.shiftCutTimer - 0.016);
    }
    const shiftDip = this.shiftCutTimer > 0 ? 0.52 : 1.0;

    // Map `engine.lp` to dynamic exhaust low-pass filter cutoff (950 Hz closed throttle -> 7200 Hz full load scream)
    if (this.engineExhaustFilter) {
      const cutoffHz = THREE.MathUtils.clamp(950 + engineLp * 6800 + mp * 1400, 900, 8800);
      this.engineExhaustFilter.frequency.setTargetAtTime(cutoffHz, now, tau);
    }

    // Crossfade across the 5 real F1 WAV sample loops
    if (this.samplesLoaded && this.sampleNodes.length > 0) {
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

    // Subtle low-end V6 3rd-order firing frequency reinforcement (only low-passed warmth)
    const f0 = (rpm / 60) * 3.0;
    if (!vf26 && this.subHarmonicOsc && this.subHarmonicGain && this.subHarmonicFilter) {
      this.subHarmonicOsc.frequency.setTargetAtTime(f0 * 0.5, now, tau);
      this.subHarmonicFilter.frequency.setTargetAtTime(Math.min(260, f0 * 0.85), now, tau);
      const subLevel = (this.samplesLoaded ? 0.055 : 0.16) * (0.4 + 0.6 * this.smoothAccel) * shiftDip;
      this.subHarmonicGain.gain.setTargetAtTime(subLevel, now, tau);
    }

    // Turbo lag model (`turbo_lag`, `turbo_ilag` in `CarSoundData.cpp` lines 163-168)
    this.turboLag = 0.9 * this.turboLag + 0.1 * this.smoothAccel;
    const turboIlag = Math.exp(-3.0 * this.turboLag);
    if (!vf26 && this.turboOsc && this.turboGain) {
      const turboFreq = 1650 + (1.0 - turboIlag) * 2400 + mp * 850;
      const turboAmp = THREE.MathUtils.clamp((1.0 - turboIlag) * 0.022 * mp, 0, 0.025);
      this.turboOsc.frequency.setTargetAtTime(turboFreq, now, tau);
      this.turboGain.gain.setTargetAtTime(turboAmp, now, tau);
    }

    // 2. Port of `CarSoundData::calculateAeroSound` (Axle Whine + Aero Wind)
    const speedMs = Math.max(0, telemetry.speedKmh / 3.6);
    const u2 = speedMs * speedMs;

    if (!vf26 && this.axleOsc && this.axleGain) {
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
      // From CarSoundData.cpp line 272:
      // a = max(min(0.4 * s * reaction_force * 0.0002 - 0.1, 1.0), 0.0) * min(u * 0.1, 1.0)
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
    this.vf26?.dispose();
    this.vf26 = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.isInitialized = false;
  }
}
