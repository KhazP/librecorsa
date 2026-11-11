/**
 * 2026 MGU-H-Free Multi-Layer Procedural WebAudio Synthesizer (`src/lib/cars/lc26/audio.ts`)
 * for the VeloSoft LC-26 (`lc26-f1`).
 *
 * 100% clean-room first-principles acoustic synthesis built for FIA 2026 Section C Issue 21:
 *  1. 1.6L 90° V6 MGU-H-free exhaust & plenum induction formants (1.5th, 3rd, 4.5th, 6th engine
 *     orders through asymmetric collector waveshaping + dual Helmholtz/airbox formant filters).
 *  2. Un-damped single-turbo spool hiss + off-throttle wastegate bark & compressor surge flutter
 *     (now that MGU-H no longer absorbs exhaust turbine energy).
 *  3. Prominent 350 kW MGU-K electrical whine (SiC inverter carrier + helical gear mesh) active
 *     during BOTH positive deployment AND negative Super Clipping / BBW harvesting, with distinct
 *     pitch, harmonic ratio, and filter timbre modulation between deploy and harvest.
 *  4. Crisp 28 ms seamless upshift ignition-cut crack & electronic downshift throttle-blip bark.
 *  5. Velocity-squared aero wind layer with Straight Mode (`SM`) wind-tone frequency & drag drop.
 *  6. Tyre slip scrub squeal + Grade-5 Ti-6Al-4V plank bottoming metallic scrape & spark crackle.
 */

import {
  LC26_FIA_POWERTRAIN_LIMITS,
  type Lc26AudioController as Lc26AudioControllerContract,
  type Lc26AudioFrameInput,
} from './contract-types';

export type { Lc26AudioFrameInput };

export const LC26_SEAMLESS_UPSHIFT_CUT_MS = 28 as const;
export const LC26_DOWNSHIFT_BLIP_MS = 56 as const;

export interface Lc26AudioDiagnosticSnapshot {
  readonly initialized: boolean;
  readonly muted: boolean;
  readonly fundamentalHz: number;
  readonly engineOrderHz: readonly [o1_5: number, o3_0: number, o4_5: number, o6_0: number];
  readonly exhaustFormantHz: number;
  readonly inductionFormantHz: number;
  readonly engineDriveGain: number;
  readonly wastegateBarkGain: number;
  readonly turboSpoolGain: number;
  readonly mgukMode: 'idle' | 'deploy' | 'harvest' | 'super-clip';
  readonly mgukHelicalHz: number;
  readonly mgukInverterHz: number;
  readonly mgukGain: number;
  readonly upshiftCutRemainingMs: number;
  readonly shiftTransientGain: number;
  readonly aeroWindCutoffHz: number;
  readonly aeroWindGain: number;
  readonly tyreScrubGain: number;
  readonly plankSparkGain: number;
}

interface InternalAudioGraph {
  readonly ctx: AudioContext;
  readonly masterGain: GainNode;
  readonly perspectiveLowpass: BiquadFilterNode;

  // V6 Engine Orders (1.5, 3.0, 4.5, 6.0) + Formants
  readonly order15Osc: OscillatorNode;
  readonly order30Osc: OscillatorNode;
  readonly order45Osc: OscillatorNode;
  readonly order60Osc: OscillatorNode;
  readonly order15Gain: GainNode;
  readonly order30Gain: GainNode;
  readonly order45Gain: GainNode;
  readonly order60Gain: GainNode;
  readonly v6CollectorShaper: WaveShaperNode;
  readonly exhaustFormantFilter: BiquadFilterNode;
  readonly inductionFormantFilter: BiquadFilterNode;
  readonly inductionMixGain: GainNode;
  readonly v6BusGain: GainNode;

  // Turbocharger Spool & MGU-H-Free Wastegate Bark/Flutter
  readonly turboVaneOsc: OscillatorNode;
  readonly turboSpoolFilter: BiquadFilterNode;
  readonly turboSpoolGain: GainNode;
  readonly wastegateBarkFilter: BiquadFilterNode;
  readonly wastegateBarkGain: GainNode;

  // 350 kW MGU-K Electrical Inverter & Helical Gear Whine
  readonly mgukHelicalOsc: OscillatorNode;
  readonly mgukInverterOsc: OscillatorNode;
  readonly mgukResonantFilter: BiquadFilterNode;
  readonly mgukHelicalGain: GainNode;
  readonly mgukInverterGain: GainNode;
  readonly mgukBusGain: GainNode;

  // Seamless Shift Crack & Downshift Blip Transient
  readonly shiftCrackFilter: BiquadFilterNode;
  readonly shiftCrackGain: GainNode;

  // Aero Boundary-Layer & Straight Mode Wind-Tone
  readonly aeroWindFilter: BiquadFilterNode;
  readonly aeroWindGain: GainNode;

  // Tyre Scrub & Titanium Plank Bottoming Sparks
  readonly tyreScrubFilter: BiquadFilterNode;
  readonly tyreScrubGain: GainNode;
  readonly plankScrapeOsc: OscillatorNode;
  readonly plankSparkFilter: BiquadFilterNode;
  readonly plankSparkGain: GainNode;

  // Shared procedural broadband turbulence loop
  readonly noiseSource: AudioBufferSourceNode;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function setParamSmooth(param: AudioParam, target: number, now: number, tauS = 0.012): void {
  const safeTarget = Number.isFinite(target) ? target : 0;
  if (typeof param.setTargetAtTime === 'function') {
    param.setTargetAtTime(safeTarget, now, Math.max(0.002, tauS));
  } else {
    param.value = safeTarget;
  }
}

/** Builds an asymmetric collector saturation curve modeling un-muffled 2026 V6 exhaust pressure pulses. */
function buildCollectorWaveshaperCurve(samples = 512): Float32Array<ArrayBuffer> {
  const buf = new ArrayBuffer(samples * 4);
  const curve = new Float32Array(buf);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    // Asymmetric compression: sharper positive pressure wavefront + odd/even cross-bank harmonics
    const pos = x >= 0 ? Math.tanh(2.65 * x) : 0.86 * Math.tanh(2.05 * x);
    const rasp = 0.14 * Math.sin(Math.PI * 3 * x) * Math.exp(-1.4 * x * x);
    curve[i] = clamp(pos + rasp, -1, 1);
  }
  return curve;
}

/** Builds a deterministic 2-second procedural acoustic turbulence buffer (zero external audio files). */
function createProceduralTurbulenceBuffer(ctx: AudioContext, durationS = 2.0): AudioBuffer {
  const sr = ctx.sampleRate || 48000;
  const length = Math.max(1024, Math.floor(sr * durationS));
  const buffer = ctx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);

  // Deterministic xorshift32 PRNG + Voss-McCartney / 1st-order pinking blend
  let seed = 0x2026f1c5;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const white = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    const pink = (b0 + b1 + b2 + white * 0.1848) * 0.22;
    data[i] = clamp(pink * 0.65 + white * 0.35, -1, 1);
  }
  return buffer;
}

export class Lc26AudioController implements Lc26AudioControllerContract {
  private graph: InternalAudioGraph | null = null;
  private muted = false;

  // Dynamic envelope states
  private prevThrottle01 = 0;
  private smoothedBoostBar = 0;
  private wastegateBarkEnv = 0;
  private flutterPhaseRad = 0;
  private upshiftCutRemainingS = 0;
  private downshiftBlipRemainingS = 0;
  private shiftCrackEnv = 0;
  private limiterPhaseRad = 0;
  private sparkChatterPhaseRad = 0;

  private lastSnapshot: Lc26AudioDiagnosticSnapshot = {
    initialized: false,
    muted: false,
    fundamentalHz: 0,
    engineOrderHz: [0, 0, 0, 0],
    exhaustFormantHz: 680,
    inductionFormantHz: 1200,
    engineDriveGain: 0,
    wastegateBarkGain: 0,
    turboSpoolGain: 0,
    mgukMode: 'idle',
    mgukHelicalHz: 0,
    mgukInverterHz: 0,
    mgukGain: 0,
    upshiftCutRemainingMs: 0,
    shiftTransientGain: 0,
    aeroWindCutoffHz: 1500,
    aeroWindGain: 0,
    tyreScrubGain: 0,
    plankSparkGain: 0,
  };

  public init(ctx: AudioContext, destination?: AudioNode): void {
    if (this.graph) {
      this.dispose();
    }

    const out = destination ?? ctx.destination;

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.muted ? 0 : 0.85;

    const perspectiveLowpass = ctx.createBiquadFilter();
    perspectiveLowpass.type = 'lowpass';
    perspectiveLowpass.frequency.value = 8800;
    perspectiveLowpass.Q.value = 0.707;

    perspectiveLowpass.connect(masterGain);
    masterGain.connect(out);

    // --- 1. 1.6L 90° V6 Engine Orders & Dual Formant Network ---
    const order15Osc = ctx.createOscillator();
    order15Osc.type = 'sawtooth';
    order15Osc.frequency.value = 95;

    const order30Osc = ctx.createOscillator();
    order30Osc.type = 'sawtooth';
    order30Osc.frequency.value = 190;

    const order45Osc = ctx.createOscillator();
    order45Osc.type = 'sawtooth';
    order45Osc.frequency.value = 285;

    const order60Osc = ctx.createOscillator();
    order60Osc.type = 'triangle';
    order60Osc.frequency.value = 380;

    const order15Gain = ctx.createGain();
    order15Gain.gain.value = 0.16;
    const order30Gain = ctx.createGain();
    order30Gain.gain.value = 0.34;
    const order45Gain = ctx.createGain();
    order45Gain.gain.value = 0.22;
    const order60Gain = ctx.createGain();
    order60Gain.gain.value = 0.14;

    const v6CollectorShaper = ctx.createWaveShaper();
    v6CollectorShaper.curve = buildCollectorWaveshaperCurve(512);
    v6CollectorShaper.oversample = '2x';

    const exhaustFormantFilter = ctx.createBiquadFilter();
    exhaustFormantFilter.type = 'peaking';
    exhaustFormantFilter.frequency.value = 820;
    exhaustFormantFilter.Q.value = 2.1;
    exhaustFormantFilter.gain.value = 7.5;

    const inductionFormantFilter = ctx.createBiquadFilter();
    inductionFormantFilter.type = 'bandpass';
    inductionFormantFilter.frequency.value = 1480;
    inductionFormantFilter.Q.value = 3.4;

    const inductionMixGain = ctx.createGain();
    inductionMixGain.gain.value = 0.24;

    const v6BusGain = ctx.createGain();
    v6BusGain.gain.value = 0;

    order15Osc.connect(order15Gain);
    order30Osc.connect(order30Gain);
    order45Osc.connect(order45Gain);
    order60Osc.connect(order60Gain);

    order15Gain.connect(v6CollectorShaper);
    order30Gain.connect(v6CollectorShaper);
    order45Gain.connect(v6CollectorShaper);
    order60Gain.connect(v6CollectorShaper);

    v6CollectorShaper.connect(exhaustFormantFilter);
    exhaustFormantFilter.connect(v6BusGain);

    v6CollectorShaper.connect(inductionFormantFilter);
    inductionFormantFilter.connect(inductionMixGain);
    inductionMixGain.connect(v6BusGain);

    v6BusGain.connect(perspectiveLowpass);

    // --- Shared Procedural Turbulence Source ---
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = createProceduralTurbulenceBuffer(ctx, 2.0);
    noiseSource.loop = true;

    // --- 2. Turbocharger Spool & MGU-H-Free Wastegate Bark/Flutter ---
    const turboVaneOsc = ctx.createOscillator();
    turboVaneOsc.type = 'sine';
    turboVaneOsc.frequency.value = 3400;

    const turboSpoolFilter = ctx.createBiquadFilter();
    turboSpoolFilter.type = 'bandpass';
    turboSpoolFilter.frequency.value = 4600;
    turboSpoolFilter.Q.value = 3.2;

    const turboSpoolGain = ctx.createGain();
    turboSpoolGain.gain.value = 0;

    noiseSource.connect(turboSpoolFilter);
    turboSpoolFilter.connect(turboSpoolGain);
    turboVaneOsc.connect(turboSpoolGain);
    turboSpoolGain.connect(perspectiveLowpass);

    const wastegateBarkFilter = ctx.createBiquadFilter();
    wastegateBarkFilter.type = 'bandpass';
    wastegateBarkFilter.frequency.value = 540;
    wastegateBarkFilter.Q.value = 2.6;

    const wastegateBarkGain = ctx.createGain();
    wastegateBarkGain.gain.value = 0;

    noiseSource.connect(wastegateBarkFilter);
    wastegateBarkFilter.connect(wastegateBarkGain);
    wastegateBarkGain.connect(perspectiveLowpass);

    // --- 3. 350 kW MGU-K Inverter & Helical Gear Whine ---
    const mgukHelicalOsc = ctx.createOscillator();
    mgukHelicalOsc.type = 'triangle';
    mgukHelicalOsc.frequency.value = 1200;

    const mgukInverterOsc = ctx.createOscillator();
    mgukInverterOsc.type = 'sawtooth';
    mgukInverterOsc.frequency.value = 3200;

    const mgukHelicalGain = ctx.createGain();
    mgukHelicalGain.gain.value = 0.55;

    const mgukInverterGain = ctx.createGain();
    mgukInverterGain.gain.value = 0.45;

    const mgukResonantFilter = ctx.createBiquadFilter();
    mgukResonantFilter.type = 'bandpass';
    mgukResonantFilter.frequency.value = 2400;
    mgukResonantFilter.Q.value = 4.8;

    const mgukBusGain = ctx.createGain();
    mgukBusGain.gain.value = 0;

    mgukHelicalOsc.connect(mgukHelicalGain);
    mgukInverterOsc.connect(mgukInverterGain);
    mgukHelicalGain.connect(mgukResonantFilter);
    mgukInverterGain.connect(mgukResonantFilter);
    mgukResonantFilter.connect(mgukBusGain);
    // MGU-K couples structurally through the survival cell, bypassing exterior-only muffling
    mgukBusGain.connect(masterGain);

    // --- 4. Seamless 28 ms Upshift Crack & Downshift Blip ---
    const shiftCrackFilter = ctx.createBiquadFilter();
    shiftCrackFilter.type = 'bandpass';
    shiftCrackFilter.frequency.value = 1450;
    shiftCrackFilter.Q.value = 1.9;

    const shiftCrackGain = ctx.createGain();
    shiftCrackGain.gain.value = 0;

    noiseSource.connect(shiftCrackFilter);
    shiftCrackFilter.connect(shiftCrackGain);
    shiftCrackGain.connect(perspectiveLowpass);

    // --- 5. Aero Boundary Layer & Straight Mode Wind-Tone ---
    const aeroWindFilter = ctx.createBiquadFilter();
    aeroWindFilter.type = 'bandpass';
    aeroWindFilter.frequency.value = 1480;
    aeroWindFilter.Q.value = 1.15;

    const aeroWindGain = ctx.createGain();
    aeroWindGain.gain.value = 0;

    noiseSource.connect(aeroWindFilter);
    aeroWindFilter.connect(aeroWindGain);
    aeroWindGain.connect(masterGain);

    // --- 6. Tyre Scrub Squeal & Ti-6Al-4V Plank Bottoming Sparks ---
    const tyreScrubFilter = ctx.createBiquadFilter();
    tyreScrubFilter.type = 'bandpass';
    tyreScrubFilter.frequency.value = 1180;
    tyreScrubFilter.Q.value = 4.2;

    const tyreScrubGain = ctx.createGain();
    tyreScrubGain.gain.value = 0;

    noiseSource.connect(tyreScrubFilter);
    tyreScrubFilter.connect(tyreScrubGain);
    tyreScrubGain.connect(masterGain);

    const plankScrapeOsc = ctx.createOscillator();
    plankScrapeOsc.type = 'sawtooth';
    plankScrapeOsc.frequency.value = 3950;

    const plankSparkFilter = ctx.createBiquadFilter();
    plankSparkFilter.type = 'bandpass';
    plankSparkFilter.frequency.value = 6200;
    plankSparkFilter.Q.value = 5.4;

    const plankSparkGain = ctx.createGain();
    plankSparkGain.gain.value = 0;

    noiseSource.connect(plankSparkFilter);
    plankSparkFilter.connect(plankSparkGain);
    plankScrapeOsc.connect(plankSparkGain);
    plankSparkGain.connect(masterGain);

    // Start continuous oscillators & procedural noise loop
    const startTime = ctx.currentTime || 0;
    order15Osc.start(startTime);
    order30Osc.start(startTime);
    order45Osc.start(startTime);
    order60Osc.start(startTime);
    turboVaneOsc.start(startTime);
    mgukHelicalOsc.start(startTime);
    mgukInverterOsc.start(startTime);
    plankScrapeOsc.start(startTime);
    noiseSource.start(startTime);

    this.graph = {
      ctx,
      masterGain,
      perspectiveLowpass,
      order15Osc,
      order30Osc,
      order45Osc,
      order60Osc,
      order15Gain,
      order30Gain,
      order45Gain,
      order60Gain,
      v6CollectorShaper,
      exhaustFormantFilter,
      inductionFormantFilter,
      inductionMixGain,
      v6BusGain,
      turboVaneOsc,
      turboSpoolFilter,
      turboSpoolGain,
      wastegateBarkFilter,
      wastegateBarkGain,
      mgukHelicalOsc,
      mgukInverterOsc,
      mgukResonantFilter,
      mgukHelicalGain,
      mgukInverterGain,
      mgukBusGain,
      shiftCrackFilter,
      shiftCrackGain,
      aeroWindFilter,
      aeroWindGain,
      tyreScrubFilter,
      tyreScrubGain,
      plankScrapeOsc,
      plankSparkFilter,
      plankSparkGain,
      noiseSource,
    };

    this.lastSnapshot = {
      ...this.lastSnapshot,
      initialized: true,
      muted: this.muted,
    };
  }

  public triggerGearShift(direction: 'up' | 'down'): void {
    if (direction === 'up') {
      this.upshiftCutRemainingS = LC26_SEAMLESS_UPSHIFT_CUT_MS / 1000;
      this.shiftCrackEnv = 1.0;
      if (this.graph) {
        const now = this.graph.ctx.currentTime || 0;
        setParamSmooth(this.graph.shiftCrackFilter.frequency, 1680, now, 0.004);
        setParamSmooth(this.graph.shiftCrackGain.gain, 0.42, now, 0.003);
      }
    } else {
      this.downshiftBlipRemainingS = LC26_DOWNSHIFT_BLIP_MS / 1000;
      this.shiftCrackEnv = 0.72;
      if (this.graph) {
        const now = this.graph.ctx.currentTime || 0;
        setParamSmooth(this.graph.shiftCrackFilter.frequency, 760, now, 0.006);
        setParamSmooth(this.graph.shiftCrackGain.gain, 0.28, now, 0.005);
      }
    }
  }

  public update(frame: Lc26AudioFrameInput, dtS: number): void {
    const dt = clamp(dtS, 0.0002, 0.1);
    const revLimit = Math.max(8000, frame.revLimitRpm || LC26_FIA_POWERTRAIN_LIMITS.revLimitRpm);
    const throttle = clamp(frame.throttle01, 0, 1);
    const speedKmh = Math.max(0, frame.speedKmh);
    const boostBar = clamp(frame.boostBarGauge, 0, 4.2);
    const sm01 = clamp(frame.straightModeProgress01, 0, 1);
    const slip01 = clamp(frame.tyreSlipPeak01, 0, 1.5);
    const spark01 = clamp(frame.plankSparkIntensity01, 0, 1);

    // Advance shift & transient timers
    this.upshiftCutRemainingS = Math.max(0, this.upshiftCutRemainingS - dt);
    this.downshiftBlipRemainingS = Math.max(0, this.downshiftBlipRemainingS - dt);
    this.shiftCrackEnv = Math.max(0, this.shiftCrackEnv - dt / 0.045);

    // Downshift blip virtual RPM flare
    const blipRpmAdd = this.downshiftBlipRemainingS > 0 ? 780 * (this.downshiftBlipRemainingS / 0.056) : 0;
    const effectiveRpm = clamp(
      frame.rpm + blipRpmAdd,
      LC26_FIA_POWERTRAIN_LIMITS.idleRpm * 0.75,
      LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm,
    );
    const rpmNorm = clamp(
      (effectiveRpm - LC26_FIA_POWERTRAIN_LIMITS.idleRpm) /
        Math.max(1000, revLimit - LC26_FIA_POWERTRAIN_LIMITS.idleRpm),
      0,
      1.1,
    );

    // 1. V6 Engine Orders (1.5, 3.0, 4.5, 6.0) + Formants
    const f0 = effectiveRpm / 60;
    const o15 = f0 * 1.5;
    const o30 = f0 * 3.0;
    const o45 = f0 * 4.5;
    const o60 = f0 * 6.0;

    const exhaustFormantHz = 660 + rpmNorm * 1040 + throttle * 160;
    const inductionFormantHz = 1140 + rpmNorm * 1420 + (frame.cameraInterior ? 180 : 0);

    // Limiter chop & 28 ms seamless upshift ignition cut
    let limiterMult = 1.0;
    if (effectiveRpm >= revLimit * 0.992) {
      this.limiterPhaseRad = (this.limiterPhaseRad + 2 * Math.PI * 38 * dt) % (2 * Math.PI);
      limiterMult = Math.sin(this.limiterPhaseRad) >= 0 ? 1.0 : 0.18;
    }
    const upshiftCutMult = this.upshiftCutRemainingS > 0 ? 0.12 : 1.0;
    const baseEngineGain = (0.14 + 0.34 * throttle + 0.18 * rpmNorm) * limiterMult * upshiftCutMult;

    // 2. Turbo spool & MGU-H-Free Off-Throttle Wastegate Bark/Flutter
    const boostTau = throttle > this.prevThrottle01 ? 0.09 : 0.16;
    this.smoothedBoostBar += ((boostBar - this.smoothedBoostBar) * Math.min(1, dt / boostTau));

    const dThrottleDt = (throttle - this.prevThrottle01) / dt;
    this.prevThrottle01 = throttle;

    if (dThrottleDt < -1.8 && (this.smoothedBoostBar > 0.35 || effectiveRpm > 7200) && throttle < 0.35) {
      const barkTrigger = clamp((-dThrottleDt / 8) * (0.45 + 0.55 * (this.smoothedBoostBar / 3.5)), 0.25, 1.0);
      this.wastegateBarkEnv = Math.max(this.wastegateBarkEnv, barkTrigger);
    } else {
      this.wastegateBarkEnv = Math.max(0, this.wastegateBarkEnv - dt / 0.21);
    }
    this.flutterPhaseRad = (this.flutterPhaseRad + 2 * Math.PI * 27 * dt) % (2 * Math.PI);
    const flutterMod = 0.68 + 0.32 * Math.sin(this.flutterPhaseRad);
    const wastegateBarkGain =
      this.wastegateBarkEnv * flutterMod * (frame.cameraInterior ? 0.22 : 0.34);
    const turboSpoolGain =
      clamp(this.smoothedBoostBar / 3.8, 0, 1) * (0.04 + 0.11 * throttle) * upshiftCutMult;

    // 3. Prominent 350 kW MGU-K Whine (Deploy vs Super Clip / BBW Harvest)
    const mgukKw = clamp(
      frame.mgukPowerKw,
      -LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw,
      LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw,
    );
    const mgukAbsNorm = clamp(Math.abs(mgukKw) / LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw, 0, 1);

    let mgukMode: Lc26AudioDiagnosticSnapshot['mgukMode'] = 'idle';
    let mgukHelicalHz = f0 * 12.5;
    let mgukInverterHz = 2600 + f0 * 8.5;
    let mgukFilterHz = 2300;
    let mgukFilterQ = 4.6;
    let mgukHelicalDetune = 0;

    if (mgukKw > 2) {
      // Positive 350 kW electrical deployment: drive-flank helical whine + rising SiC carrier
      mgukMode = 'deploy';
      mgukHelicalHz = Math.max(380, f0 * 13.75);
      mgukInverterHz = 2680 + f0 * 8.4 + mgukAbsNorm * 420;
      mgukFilterHz = 2350 + rpmNorm * 1150;
      mgukFilterQ = 4.4;
      mgukHelicalDetune = 28 * mgukAbsNorm;
    } else if (mgukKw < -2) {
      // Negative regeneration: coast-flank gear mesh + hollower high-Q regenerative PWM whistle
      const isSuperClip = throttle >= 0.88 && speedKmh >= 250;
      mgukMode = isSuperClip ? 'super-clip' : 'harvest';
      mgukHelicalHz = Math.max(320, f0 * 11.25);
      mgukInverterHz = (isSuperClip ? 2120 : 1820) + f0 * 10.6 - mgukAbsNorm * 240;
      mgukFilterHz = (isSuperClip ? 1960 : 1620) + rpmNorm * 780;
      mgukFilterQ = isSuperClip ? 7.4 : 6.2;
      mgukHelicalDetune = -42 * mgukAbsNorm;
    }

    const speedWhineFactor = clamp(speedKmh / 95, 0.15, 1);
    const interiorMgukBoost = frame.cameraInterior ? 1.22 : 1.0;
    const mgukGain =
      mgukAbsNorm > 0.006
        ? (0.04 + 0.24 * Math.pow(mgukAbsNorm, 0.78)) * speedWhineFactor * interiorMgukBoost * upshiftCutMult
        : 0;

    // 4. Aero Boundary-Layer Wind & Straight Mode (`SM`) Wind-Tone Drop
    const speedRatio = clamp(speedKmh / 340, 0, 1.15);
    const aeroWindCutoffHz = (1580 + 420 * speedRatio) * (1 - 0.38 * sm01);
    const aeroWindGain = Math.min(0.28, speedRatio * speedRatio * 0.22) * (1 - 0.3 * sm01);

    // 5. Tyre Scrub & Titanium Plank Bottoming Scrape / Spark Crackle
    const tyreScrubGain = slip01 > 0.18 ? clamp((slip01 - 0.18) * 0.26, 0, 0.24) * clamp(speedKmh / 60, 0, 1) : 0;

    this.sparkChatterPhaseRad = (this.sparkChatterPhaseRad + 2 * Math.PI * 43 * dt) % (2 * Math.PI);
    const sparkChatter = 0.62 + 0.38 * Math.sin(this.sparkChatterPhaseRad * 1.7 + effectiveRpm * 0.01);
    const plankSparkGain =
      spark01 > 0.01 ? spark01 * sparkChatter * clamp(speedKmh / 140, 0.2, 1) * 0.26 : 0;

    const shiftTransientGain = this.shiftCrackEnv * 0.4;

    if (this.graph) {
      const g = this.graph;
      const now = g.ctx.currentTime || 0;

      setParamSmooth(g.masterGain.gain, this.muted ? 0 : 0.85, now, 0.015);
      setParamSmooth(g.perspectiveLowpass.frequency, frame.cameraInterior ? 4600 : 9600, now, 0.025);

      setParamSmooth(g.order15Osc.frequency, o15, now, 0.006);
      setParamSmooth(g.order30Osc.frequency, o30, now, 0.006);
      setParamSmooth(g.order45Osc.frequency, o45, now, 0.006);
      setParamSmooth(g.order60Osc.frequency, o60, now, 0.006);

      // Raspier high-order balance as RPM & un-muffled wastegate flow increase
      setParamSmooth(g.order15Gain.gain, 0.18 * (1 - 0.25 * rpmNorm), now, 0.01);
      setParamSmooth(g.order30Gain.gain, 0.34, now, 0.01);
      setParamSmooth(g.order45Gain.gain, 0.16 + 0.18 * throttle + 0.08 * rpmNorm, now, 0.01);
      setParamSmooth(g.order60Gain.gain, 0.08 + 0.18 * rpmNorm * throttle, now, 0.01);

      setParamSmooth(g.exhaustFormantFilter.frequency, exhaustFormantHz, now, 0.012);
      setParamSmooth(g.inductionFormantFilter.frequency, inductionFormantHz, now, 0.012);
      setParamSmooth(g.inductionMixGain.gain, frame.cameraInterior ? 0.36 : 0.18, now, 0.02);
      setParamSmooth(g.v6BusGain.gain, baseEngineGain, now, 0.004);

      setParamSmooth(g.turboVaneOsc.frequency, 2600 + this.smoothedBoostBar * 1150, now, 0.015);
      setParamSmooth(g.turboSpoolFilter.frequency, 3400 + this.smoothedBoostBar * 1050, now, 0.015);
      setParamSmooth(g.turboSpoolGain.gain, turboSpoolGain, now, 0.012);

      setParamSmooth(g.wastegateBarkFilter.frequency, 440 + 280 * flutterMod, now, 0.008);
      setParamSmooth(g.wastegateBarkGain.gain, wastegateBarkGain, now, 0.006);

      g.mgukHelicalOsc.type = mgukMode === 'deploy' ? 'triangle' : 'sine';
      g.mgukInverterOsc.type = mgukMode === 'deploy' ? 'sawtooth' : 'triangle';
      setParamSmooth(g.mgukHelicalOsc.frequency, mgukHelicalHz, now, 0.008);
      setParamSmooth(g.mgukHelicalOsc.detune, mgukHelicalDetune, now, 0.008);
      setParamSmooth(g.mgukInverterOsc.frequency, mgukInverterHz, now, 0.008);
      setParamSmooth(g.mgukResonantFilter.frequency, mgukFilterHz, now, 0.01);
      setParamSmooth(g.mgukResonantFilter.Q, mgukFilterQ, now, 0.01);
      setParamSmooth(g.mgukBusGain.gain, mgukGain, now, 0.008);

      setParamSmooth(g.shiftCrackGain.gain, shiftTransientGain, now, 0.005);

      setParamSmooth(g.aeroWindFilter.frequency, aeroWindCutoffHz, now, 0.02);
      setParamSmooth(g.aeroWindGain.gain, aeroWindGain, now, 0.02);

      setParamSmooth(g.tyreScrubFilter.frequency, 960 + slip01 * 540, now, 0.015);
      setParamSmooth(g.tyreScrubGain.gain, tyreScrubGain, now, 0.015);

      setParamSmooth(g.plankScrapeOsc.frequency, 3600 + speedKmh * 4.8, now, 0.008);
      setParamSmooth(g.plankSparkFilter.frequency, 5600 + 2200 * sparkChatter, now, 0.008);
      setParamSmooth(g.plankSparkGain.gain, plankSparkGain, now, 0.006);
    }

    this.lastSnapshot = {
      initialized: this.graph !== null,
      muted: this.muted,
      fundamentalHz: Number(f0.toFixed(2)),
      engineOrderHz: [
        Number(o15.toFixed(2)),
        Number(o30.toFixed(2)),
        Number(o45.toFixed(2)),
        Number(o60.toFixed(2)),
      ],
      exhaustFormantHz: Number(exhaustFormantHz.toFixed(1)),
      inductionFormantHz: Number(inductionFormantHz.toFixed(1)),
      engineDriveGain: Number(baseEngineGain.toFixed(4)),
      wastegateBarkGain: Number(wastegateBarkGain.toFixed(4)),
      turboSpoolGain: Number(turboSpoolGain.toFixed(4)),
      mgukMode,
      mgukHelicalHz: Number(mgukHelicalHz.toFixed(1)),
      mgukInverterHz: Number(mgukInverterHz.toFixed(1)),
      mgukGain: Number(mgukGain.toFixed(4)),
      upshiftCutRemainingMs: Number((this.upshiftCutRemainingS * 1000).toFixed(2)),
      shiftTransientGain: Number(shiftTransientGain.toFixed(4)),
      aeroWindCutoffHz: Number(aeroWindCutoffHz.toFixed(1)),
      aeroWindGain: Number(aeroWindGain.toFixed(4)),
      tyreScrubGain: Number(tyreScrubGain.toFixed(4)),
      plankSparkGain: Number(plankSparkGain.toFixed(4)),
    };
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.graph) {
      const now = this.graph.ctx.currentTime || 0;
      setParamSmooth(this.graph.masterGain.gain, muted ? 0 : 0.85, now, 0.01);
    }
    this.lastSnapshot = {
      ...this.lastSnapshot,
      muted,
    };
  }

  public getDiagnosticSnapshot(): Lc26AudioDiagnosticSnapshot {
    return this.lastSnapshot;
  }

  public dispose(): void {
    if (!this.graph) return;
    const g = this.graph;
    const stopSafe = (node: { stop: () => void; disconnect: () => void }) => {
      try {
        node.stop();
      } catch {
        // Already stopped
      }
      try {
        node.disconnect();
      } catch {
        // Already disconnected
      }
    };

    stopSafe(g.order15Osc);
    stopSafe(g.order30Osc);
    stopSafe(g.order45Osc);
    stopSafe(g.order60Osc);
    stopSafe(g.turboVaneOsc);
    stopSafe(g.mgukHelicalOsc);
    stopSafe(g.mgukInverterOsc);
    stopSafe(g.plankScrapeOsc);
    stopSafe(g.noiseSource);

    try {
      g.masterGain.disconnect();
    } catch {
      // Ignore disconnect errors during teardown
    }

    this.graph = null;
    this.upshiftCutRemainingS = 0;
    this.downshiftBlipRemainingS = 0;
    this.shiftCrackEnv = 0;
    this.wastegateBarkEnv = 0;
    this.lastSnapshot = {
      ...this.lastSnapshot,
      initialized: false,
      engineDriveGain: 0,
      mgukGain: 0,
      upshiftCutRemainingMs: 0,
    };
  }
}

export function createLc26AudioController(): Lc26AudioController {
  return new Lc26AudioController();
}
