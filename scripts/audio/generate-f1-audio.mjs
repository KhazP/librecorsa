import fs from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 44100;
const DURATION_SEC = 2.0;
const NUM_SAMPLES = Math.round(SAMPLE_RATE * DURATION_SEC); // 88,200 samples (exact 0.5 Hz bin resolution)

// Deterministic PRNG so WAV builds are 100% reproducible
let rngState = 0x12345678;
function nextRand() {
  rngState = (1664525 * rngState + 1013904223) >>> 0;
  return rngState / 0x100000000;
}

/**
 * Evaluates a multi-resonator acoustic transfer function representing the
 * 2026 F1 1.6L V6 Turbo-Hybrid 3-into-1 Inconel exhaust manifold + turbine + tailpipe.
 */
function exhaustFormantGain(freqHz, formants, rolloffHz) {
  let gain = 0.15;
  for (const { f0, q, amp } of formants) {
    const r = freqHz / f0;
    const denom = Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2);
    gain += (amp / q) / Math.max(0.08, denom);
  }
  // Smooth acoustic low-pass rolloff through turbocharger turbine stages
  const lp = 1.0 / (1.0 + (freqHz / rolloffHz) ** 2.6);
  // High-pass sub-25 Hz DC/infrasonic block
  const hp = (freqHz / 28.0) ** 2 / (1.0 + (freqHz / 28.0) ** 2);
  return gain * lp * hp;
}

function writeWav16Mono(filePath, floatSamples) {
  const numSamples = floatSamples.length;
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format = 1
  buf.writeUInt16LE(1, 22); // Mono = 1 channel
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // Byte rate
  buf.writeUInt16LE(2, 32); // Block align
  buf.writeUInt16LE(16, 34); // Bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);

  // Peak normalize to -1.5 dBFS (0.84) for clean headroom
  let peak = 1e-6;
  for (let i = 0; i < numSamples; i++) {
    const a = Math.abs(floatSamples[i]);
    if (a > peak) peak = a;
  }
  const scale = 0.84 / peak;

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i] * scale));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buf);
}

function synthesizeLoopingF1Band({
  name,
  baseRpm,
  formants,
  rolloffHz,
  orderWeights,
  noiseRatio,
  turboHarmonicRatio,
  isOverrun = false,
}) {
  // Crank frequency = baseRpm / 60; 4-stroke 720-deg cycle frequency = baseRpm / 120.
  // Because baseRpm is chosen as a multiple of 60, fCycleHz is an EXACT integer,
  // guaranteeing an exact integer number of engine cycles in 2.000s (88,200 samples)!
  const fCycleHz = Math.round(baseRpm / 120);
  const fFireHz = fCycleHz * 6; // 6 cylinders fire per 720-deg 4-stroke cycle (3rd crank order)
  const samples = new Float64Array(NUM_SAMPLES);

  // 1. Synthesize exact phase-locked harmonic series of the 6-cylinder V6 firing cycle
  //    k = 1 corresponds to 0.5x crank order (fCycleHz)
  //    k = 2 corresponds to 1.0x crank order
  //    k = 3 corresponds to 1.5x crank order (V6 bank-to-bank growl)
  //    k = 6 corresponds to 3.0x crank order (primary V6 firing fundamental fFireHz)
  //    k = 12 corresponds to 6.0x crank order (2nd firing harmonic)
  const maxHarmonic = Math.min(180, Math.floor(8500 / fCycleHz));
  for (let k = 1; k <= maxHarmonic; k++) {
    const freq = k * fCycleHz;
    if (freq > 8500) break;

    // Determine engine order weight based on harmonic relationship to the 6-cylinder cycle
    let orderWeight = 0.0;
    if (k % 6 === 0) {
      // Primary 6-cylinder firing harmonics (3x, 6x, 9x, 12x, 15x... crank order)
      const fireHarmIdx = k / 6;
      orderWeight =
        (orderWeights.primary / Math.pow(fireHarmIdx, orderWeights.harmonicDecay)) *
        (fireHarmIdx % 2 === 1 ? 1.15 : 0.92);
    } else if (k % 3 === 0) {
      // 1.5x, 4.5x, 7.5x crank half-orders (90-degree V6 uneven manifold coupling)
      const halfIdx = k / 3;
      orderWeight = orderWeights.halfOrder / Math.pow(halfIdx, 0.85);
    } else if (k % 2 === 0) {
      // Integer crank orders (1x, 2x, 4x, 5x crank order from bank imbalance)
      const crankIdx = k / 2;
      orderWeight = orderWeights.crankOrder / Math.pow(crankIdx, 0.95);
    } else {
      // Cycle sub-harmonics (0.5x, 2.5x, 3.5x cycle-to-cycle combustion texture)
      orderWeight = orderWeights.subOrder / Math.pow(k, 0.8);
    }

    const envGain = exhaustFormantGain(freq, formants, rolloffHz);
    const amp = orderWeight * envGain;
    if (amp < 1e-5) continue;

    // Exact stationary phase-locked harmonic synthesis (zero slow LFO shimmer so pitch/timbre never pulses over the 2.0s loop!)
    const phase0 = nextRand() * Math.PI * 2;
    const omega = (2 * Math.PI * freq) / SAMPLE_RATE;

    for (let i = 0; i < NUM_SAMPLES; i++) {
      samples[i] += amp * Math.sin(omega * i + phase0);
    }
  }

  // 2. Synthesize strictly periodic broadband exhaust gas rush & combustion turbulence
  //    By summing Fourier bins at exact integer multiples of fCycleHz / 2,
  //    the broadband exhaust turbulence is 100% seamless and stationary across the loop boundary!
  const numBins = 2400; // Up to 1200 Hz..4200 Hz sparse periodic bins
  const noiseSignal = new Float64Array(NUM_SAMPLES);
  for (let b = 25; b <= numBins; b += 2) {
    const binMultiple = b + Math.floor(nextRand() * 2);
    const freq = binMultiple / DURATION_SEC;
    if (freq > 5200) break;
    const amp = exhaustFormantGain(freq, formants, rolloffHz * 0.9) * 0.015;
    const phase = nextRand() * Math.PI * 2;
    const omega = (2 * Math.PI * freq) / SAMPLE_RATE;
    for (let i = 0; i < NUM_SAMPLES; i++) {
      noiseSignal[i] += amp * Math.sin(omega * i + phase);
    }
  }

  // Modulate exhaust gas turbulence with the 6-cylinder blowdown pulse train (at exact fFireHz, zero slow LFO!)
  const fireOmega = (2 * Math.PI * fFireHz) / SAMPLE_RATE;
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const pulseGate = 0.55 + 0.45 * Math.sin(fireOmega * i);
    samples[i] = samples[i] + noiseSignal[i] * noiseRatio * pulseGate;
  }

  // 3. Subtle MGU-H / Turbocharger coaxial compressor harmonic sheen (exact integer cycles)
  if (turboHarmonicRatio > 0) {
    const fTurboHz = Math.round((fFireHz * 4.5) / 2) * 2;
    const omegaT1 = (2 * Math.PI * fTurboHz) / SAMPLE_RATE;
    const omegaT2 = (2 * Math.PI * (fTurboHz * 1.5)) / SAMPLE_RATE;
    for (let i = 0; i < NUM_SAMPLES; i++) {
      samples[i] +=
        turboHarmonicRatio *
        (0.7 * Math.sin(omegaT1 * i) + 0.3 * Math.sin(omegaT2 * i + 1.1));
    }
  }

  // Soft warm analog saturation (tanh) to bind harmonics like an Inconel collector
  for (let i = 0; i < NUM_SAMPLES; i++) {
    samples[i] = Math.tanh(samples[i] * 1.35);
  }

  // Circularly shift the strictly periodic buffer so index 0 lands on the minimum-slope zero-crossing.
  // Because the buffer has an exact integer number of cycles in NUM_SAMPLES, a circular shift preserves
  // 100% of the stationary harmonic spectrum while ensuring samples[0] ≈ 0 and |samples[0] - samples[N-1]| ≈ 0
  // under arbitrary WebAudio playbackRate resampling!
  let bestK = 0;
  let bestScore = Infinity;
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const prev = samples[(i + NUM_SAMPLES - 1) % NUM_SAMPLES];
    const curr = samples[i];
    const next = samples[(i + 1) % NUM_SAMPLES];
    const score = Math.abs(curr) + Math.abs(curr - prev) * 2.0 + Math.abs(next - curr) * 2.0;
    if (score < bestScore) {
      bestScore = score;
      bestK = i;
    }
  }
  const alignedSamples = new Float64Array(NUM_SAMPLES);
  for (let i = 0; i < NUM_SAMPLES; i++) {
    alignedSamples[i] = samples[(i + bestK) % NUM_SAMPLES];
  }

  const outPath = path.resolve("public/audio", name);
  writeWav16Mono(outPath, alignedSamples);

  const seamDelta = Math.abs(alignedSamples[NUM_SAMPLES - 1] - alignedSamples[0]);
  console.log(
    `Generated ${name}: baseRpm=${baseRpm}, fFire=${fFireHz}Hz, seamDelta=${seamDelta.toFixed(6)}`
  );
}

synthesizeLoopingF1Band({
  name: "f1_real_v6_low.wav",
  baseRpm: 7080,
  rolloffHz: 2100,
  noiseRatio: 0.42,
  turboHarmonicRatio: 0.012,
  orderWeights: {
    primary: 1.0,
    harmonicDecay: 0.92,
    halfOrder: 0.58,
    crankOrder: 0.38,
    subOrder: 0.22,
  },
  formants: [
    { f0: 195, q: 2.2, amp: 1.35 },
    { f0: 360, q: 3.0, amp: 1.65 },
    { f0: 740, q: 2.6, amp: 1.15 },
    { f0: 1420, q: 2.4, amp: 0.55 },
  ],
});

synthesizeLoopingF1Band({
  name: "f1_real_mid_bark.wav",
  baseRpm: 9000,
  rolloffHz: 2950,
  noiseRatio: 0.38,
  turboHarmonicRatio: 0.016,
  orderWeights: {
    primary: 1.05,
    harmonicDecay: 0.78,
    halfOrder: 0.52,
    crankOrder: 0.32,
    subOrder: 0.16,
  },
  formants: [
    { f0: 240, q: 2.0, amp: 1.1 },
    { f0: 455, q: 3.4, amp: 1.75 },
    { f0: 920, q: 3.0, amp: 1.45 },
    { f0: 1850, q: 2.8, amp: 0.85 },
  ],
});

synthesizeLoopingF1Band({
  name: "f1_real_high_roar.wav",
  baseRpm: 10920,
  rolloffHz: 3800,
  noiseRatio: 0.34,
  turboHarmonicRatio: 0.02,
  orderWeights: {
    primary: 1.1,
    harmonicDecay: 0.68,
    halfOrder: 0.44,
    crankOrder: 0.26,
    subOrder: 0.12,
  },
  formants: [
    { f0: 290, q: 2.0, amp: 0.9 },
    { f0: 550, q: 3.6, amp: 1.85 },
    { f0: 1120, q: 3.4, amp: 1.6 },
    { f0: 2240, q: 3.0, amp: 1.15 },
    { f0: 3350, q: 2.6, amp: 0.65 },
  ],
});

synthesizeLoopingF1Band({
  name: "f1_real_top_scream.wav",
  baseRpm: 12600,
  rolloffHz: 4600,
  noiseRatio: 0.3,
  turboHarmonicRatio: 0.024,
  orderWeights: {
    primary: 1.15,
    harmonicDecay: 0.62,
    halfOrder: 0.38,
    crankOrder: 0.22,
    subOrder: 0.1,
  },
  formants: [
    { f0: 330, q: 1.8, amp: 0.8 },
    { f0: 635, q: 4.0, amp: 1.95 },
    { f0: 1270, q: 3.6, amp: 1.75 },
    { f0: 2540, q: 3.2, amp: 1.35 },
    { f0: 3800, q: 2.8, amp: 0.85 },
  ],
});

synthesizeLoopingF1Band({
  name: "f1_real_overrun.wav",
  baseRpm: 8760,
  rolloffHz: 2250,
  noiseRatio: 0.52,
  turboHarmonicRatio: 0.028,
  isOverrun: true,
  orderWeights: {
    primary: 0.85,
    harmonicDecay: 0.88,
    halfOrder: 0.68,
    crankOrder: 0.48,
    subOrder: 0.32,
  },
  formants: [
    { f0: 180, q: 2.4, amp: 1.55 },
    { f0: 440, q: 2.8, amp: 1.4 },
    { f0: 880, q: 2.5, amp: 1.05 },
    { f0: 1750, q: 2.4, amp: 0.65 },
  ],
});
