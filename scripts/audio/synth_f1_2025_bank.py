#!/usr/bin/env python3
"""
Procedural 2025 Formula 1 1.6L 90-degree V6 Turbo-Hybrid + MGU-H sound bank synthesizer
for the LC25 Prototype (`public/cars/lc25/audio/`).

Clean-room synthesis (zero third-party recordings or mod assets), producing LibreCorsa's
multi-grid Web Audio format (`manifest.json` + mono Ogg Vorbis loops and one-shots):

- Engine (`ext` & `int`, `on` & `off`, 5 RPM anchors: 4000, 6000, 8000, 10500, 13000 RPM):
  - Split-pin 90° V6 asymmetric exhaust-valve-opening (EVO) blowdown pulse trains on exact
    integer 720° 4-stroke cycles (zero seam step, zero pitch drift).
  - Left/right 3-into-1 bank delay asymmetry (authentic 1.5x / 4.5x / 7.5x V6 half-orders
    and 1.0x / 2.0x crank orders alongside the dominant 3.0x / 6.0x / 9.0x firing series).
  - Per-firing stochastic combustion energy and crank-angle micro-dispersion wrapped
    circularly so loops sound organic rather than buzzing or oscillating.
  - Parallel turbine-muffled low-pass path + wastegate screamer bypass + circular-FFT
    broadband exhaust gas turbulence modulated by the firing pressure envelope.
  - Distinct off-throttle overrun cylinder-cut burble/rasp (`off`) and carbon-monocoque +
    overhead airbox induction resonance (`int`) vs open tailpipe projection (`ext`).
- Turbo + MGU-H coaxial shaft (`turbo_on/off` across 0.6, 1.5, 2.5 bar gauge):
  - MGU-H stabilized turbine/compressor whine and air rush, including off-throttle anti-lag
    hold whistle.
- Crank-coupled 120 kW MGU-K electric machine (`mgu.ogg`, `baseRpm: 10000`, `fullKw: 120`).
- Straight-cut 8-speed sequential gearbox (`trans_on_160.ogg`, `trans_off_160.ogg`) driven
  by driveshaft speed and torque (`driveline` manifest section).
- Procedural sequential shift, overrun backfire/pop, wastegate blowoff and rev-limiter
  stutter one-shots.

Usage:
  uv run --python 3.14 --no-project --with numpy --with scipy \
    python3 scripts/audio/synth_f1_2025_bank.py
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Any

import numpy as np
from scipy import signal

RATE = 48000
TARGET_LOOP_S = 2.2
OGG_QUALITY = 4
FFMPEG_DEFAULT = "/opt/homebrew/bin/ffmpeg"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO_ROOT / "public" / "cars" / "lc25" / "audio"

# Level curves matching LibreCorsa's shared bank loudness (`port_ac_bank.py` / `build_custom_soundbank.py`)
ON_RMS = (0.165, 0.220)
OFF_RMS = (0.125, 0.175)

# Anchors chosen so each RPM has an exact integer number of 720-degree 4-stroke cycles in ~2.2 s:
#   5,760,000 / rpm samples per 720° cycle
#   4000 -> 1440 smp/cyc (73 cyc = 105,120 smp = 2.190 s)
#   6000 ->  960 smp/cyc (110 cyc = 105,600 smp = 2.200 s)
#   8000 ->  720 smp/cyc (147 cyc = 105,840 smp = 2.205 s)
#  10500 -> 3840 smp / 7 cyc (196 cyc = 107,520 smp = 2.240 s)
#  13000 -> 5760 smp / 13 cyc (234 cyc = 103,680 smp = 2.160 s)
ENGINE_ANCHORS: list[tuple[int, int]] = [
    (4000, 73),
    (6000, 110),
    (8000, 147),
    (10500, 196),
    (13000, 234),
]

TURBO_BOOSTS: list[float] = [0.6, 1.5, 2.5]


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0


def circular_roll_zero(x: np.ndarray) -> np.ndarray:
    """Circularly rotate a strictly periodic signal so index 0 sits on a minimum-slope zero-crossing."""
    prev = np.roll(x, 1)
    nxt = np.roll(x, -1)
    score = np.abs(x) + 2.0 * np.abs(x - prev) + 2.0 * np.abs(nxt - x)
    k = int(np.argmin(score))
    return np.roll(x, -k)


def level_loop(x: np.ndarray, target_rms: float, peak_ceiling: float = 0.90) -> np.ndarray:
    y = x.astype(np.float64) - float(np.mean(x))
    cur = rms(y)
    if cur < 1e-8:
        return np.zeros_like(x, dtype=np.float32)
    y *= target_rms / cur
    pk = float(np.max(np.abs(y)))
    if pk > peak_ceiling:
        knee = 0.72
        above = np.maximum(0.0, np.abs(y) - knee)
        y = np.sign(y) * np.minimum(np.abs(y), knee + (peak_ceiling - knee) * np.tanh(above / (peak_ceiling - knee)))
        # Re-trim RMS gently after soft clipping
        y *= target_rms / max(1e-8, rms(y))
    y = circular_roll_zero(y)
    # 16-sample gentle edge micro-bridge only if residual step > 1e-3 (preserves spectral purity)
    if abs(float(y[0]) - float(y[-1])) > 1e-3:
        bridge = 16
        ramp = np.sin(np.linspace(0.0, math.pi * 0.5, bridge))
        y[:bridge] *= ramp
        y[-bridge:] *= ramp[::-1]
    return np.clip(y, -0.98, 0.98).astype(np.float32)


def circular_filter(x: np.ndarray, gain_fn) -> np.ndarray:
    """Apply a zero-phase frequency-domain transfer function circularly so periodicity is exact."""
    n = len(x)
    spec = np.fft.rfft(x.astype(np.float64))
    freqs = np.fft.rfftfreq(n, 1.0 / RATE)
    spec *= gain_fn(freqs)
    return np.fft.irfft(spec, n)


def resonant_formants(freqs: np.ndarray, formants: list[tuple[float, float, float]], base: float = 0.16) -> np.ndarray:
    """Parallel acoustic resonator magnitude response (f0 Hz, Q, amplitude)."""
    g = np.full_like(freqs, base, dtype=np.float64)
    for f0, q, amp in formants:
        r = freqs / f0
        denom = np.sqrt((1.0 - r * r) ** 2 + (r / q) ** 2)
        g += (amp / q) / np.maximum(0.10, denom)
    return g


def encode_ogg(ffmpeg: str, x: np.ndarray, out_path: Path, quality: int = OGG_QUALITY) -> None:
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tmp = tf.name
    try:
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm.tobytes())
        subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                tmp,
                "-c:a",
                "libvorbis",
                "-q:a",
                str(quality),
                str(out_path),
            ],
            check=True,
        )
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# --------------------------------------------------------------------------------------------------------------------
# 1. 2025 1.6L 90-degree V6 Turbo-Hybrid Engine Loops
# --------------------------------------------------------------------------------------------------------------------


def _add_evo_pulse(
    buf: np.ndarray,
    center_sample: float,
    amp: float,
    width_samples: float,
    asymmetry: float,
    ring_hz: float,
    ring_amp: float,
) -> None:
    """Add an asymmetric exhaust-valve-opening (EVO) pressure pulse circularly into `buf`."""
    n = len(buf)
    half = int(math.ceil(width_samples * 5.0))
    c0 = int(math.floor(center_sample))
    offsets = np.arange(-half, half + 1, dtype=np.float64)
    dt = (c0 + offsets - center_sample) / max(1.0, width_samples)

    # Sharp rise (valve cracking open against 6-8 bar residual cylinder pressure), smooth exponential tail
    rise = np.exp(-0.5 * (dt / max(0.18, asymmetry)) ** 2)
    fall = np.exp(-dt * 1.15) * (1.0 - np.exp(-np.maximum(0.0, dt + 0.35) * 6.5))
    pulse = np.where(dt < 0.0, rise, fall)

    # Primary runner quarter-wave damped reflection ring
    t_sec = np.maximum(0.0, (c0 + offsets - center_sample)) / RATE
    ring = ring_amp * np.sin(2.0 * math.pi * ring_hz * t_sec) * np.exp(-t_sec * (ring_hz * 0.42))
    wavelet = amp * (pulse + np.where(dt >= 0.0, ring, 0.0))

    # Remove DC per pulse so mean pressure stays strictly zero
    wavelet -= np.mean(wavelet)
    idx = (c0 + offsets.astype(np.int64)) % n
    buf[idx] += wavelet


def synth_v6_engine_loop(rpm: int, n_cycles: int, view: str, layer: str, seed: int) -> np.ndarray:
    """
    Synthesize a seamless 2025 F1 1.6L 90° V6 turbo-hybrid engine loop.

    `view`: "ext" (open tailpipe + wastegate) or "int" (carbon monocoque + overhead airbox)
    `layer`: "on" (full combustion load) or "off" (overrun / cylinder-cut engine braking)
    """
    rng = np.random.default_rng(seed)
    cyc_samples = (RATE * 120.0) / rpm
    n = int(round(n_cycles * cyc_samples))
    rpm_norm = np.clip((rpm - 4000.0) / 9000.0, 0.0, 1.0)
    is_on = layer == "on"
    is_int = view == "int"

    # Firing order of a 90° F1 V6: 1-4-3-6-2-5 alternating Left (0, 2, 4) and Right (1, 3, 5) banks every 120° crank
    bank_l = np.zeros(n, dtype=np.float64)
    bank_r = np.zeros(n, dtype=np.float64)
    env_mod = np.zeros(n, dtype=np.float64)

    fire_interval = cyc_samples / 6.0
    # Pulse sharpness tightens with RPM and load; overrun has broader, hollower blowdown pulses
    pulse_width = fire_interval * (0.21 - 0.045 * rpm_norm if is_on else 0.27 - 0.03 * rpm_norm)
    asymmetry = 0.26 if is_on else 0.36
    # Runner acoustic ring frequency scales slightly with gas temperature/RPM
    runner_ring_hz = (580.0 + 360.0 * rpm_norm) if is_on else (460.0 + 220.0 * rpm_norm)
    ring_amp = 0.26 if is_on else 0.16

    # Per-cylinder manufacturing/plenum trim (slight static differences between the 6 cylinders create realistic 0.5x/1.0x/1.5x texture)
    cyl_gain = np.array([1.06, 0.94, 1.02, 0.96, 1.08, 0.93], dtype=np.float64)
    cyl_phase_deg = np.array([0.0, 2.4, -1.5, 2.9, -1.2, 1.9], dtype=np.float64)

    # Off-throttle F1 ECU cylinder-cut map: certain cylinders fire weak/late or skip intermittently on overrun
    # producing the signature Mercedes/Honda/Ferrari 2025 off-throttle growl & burble
    overrun_cut_prob = (0.38 - 0.12 * rpm_norm) if not is_on else 0.0

    # Slow organic per-cycle combustion pressure wander (log-normal-like cycle dispersion -> realistic crest factor 3.0-3.8)
    # Filtered to stay strictly smooth & periodic over the loop so there is no audible LFO pulsing
    cyc_energy = 1.0 + 0.24 * rng.standard_normal(n_cycles)
    cyc_energy = np.clip(cyc_energy, 0.55, 1.65)

    for cyc in range(n_cycles):
        base_c = cyc * cyc_samples
        ce = cyc_energy[cyc]
        for cyl in range(6):
            # Nominal 120° crank spacing (720° / 6) + slight cylinder runner phase + micro combustion jitter
            jitter_deg = rng.normal(0.0, 1.15 if is_on else 2.10)
            pos = base_c + ((cyl * 120.0 + cyl_phase_deg[cyl] + jitter_deg) / 720.0) * cyc_samples

            if is_on:
                # Occasional hot combustion surge mimics real turbulent flame-front variance
                surge = rng.uniform(1.18, 1.48) if rng.random() < 0.12 else 1.0
                amp = ce * cyl_gain[cyl] * surge * (1.0 + rng.normal(0.0, 0.14))
            else:
                # Overrun: alternating strong/weak cylinder-cut cadence (excites 0.5x, 1.0x, 1.5x sub-orders!)
                if rng.random() < overrun_cut_prob:
                    amp = ce * cyl_gain[cyl] * rng.uniform(0.12, 0.36)
                else:
                    pop = rng.uniform(1.35, 1.85) if rng.random() < 0.10 else 1.0
                    amp = ce * cyl_gain[cyl] * pop * rng.uniform(0.70, 1.22)

            target_bank = bank_l if (cyl % 2 == 0) else bank_r
            _add_evo_pulse(target_bank, pos, amp, pulse_width, asymmetry, runner_ring_hz, ring_amp)

            # Positive envelope impulse for modulating broadband exhaust gas turbulence
            idx0 = int(round(pos)) % n
            env_mod[idx0] += abs(amp)

    # Bank-to-bank acoustic merge: slight exhaust collector path difference (~5.5 cm -> ~0.11 ms at hot exhaust sound speed ~520 m/s)
    # plus subtle level difference gives the iconic V6 1.5x / 4.5x harmonic rasp without turning hollow
    delay_samples = max(2, int(round(0.00014 * RATE)))
    bank_r_delayed = np.roll(bank_r, delay_samples) * 0.90
    # Add short collector reflection comb (~0.44 ms)
    raw_exhaust = bank_l + bank_r_delayed + 0.20 * np.roll(bank_l + bank_r_delayed, int(round(0.00044 * RATE)))

    # Smooth the firing envelope circularly to gate exhaust gas rush & turbo/wastegate turbulence
    env_smooth = circular_filter(
        env_mod,
        lambda f: np.exp(-0.5 * (f / max(90.0, (rpm / 20.0) * 2.0)) ** 2),
    )
    env_smooth = env_smooth / (np.mean(env_smooth) + 1e-9)
    env_gate = 0.35 + 0.65 * np.clip(env_smooth, 0.0, 2.8)

    # 1b. Reinforce exact V6 harmonic skeleton cleanly (keeps pitch tracking rock-solid across crossfades)
    #     while preserving the organic pulse-train transient bite
    f_cyc = rpm / 120.0
    t = np.arange(n, dtype=np.float64) / RATE
    harmonic_bed = np.zeros(n, dtype=np.float64)
    max_k = min(96, int(7200.0 / f_cyc))
    for k in range(1, max_k + 1):
        freq = k * f_cyc
        if freq < 45.0 or freq > 7200.0:
            continue
        if k % 6 == 0:
            # 3x, 6x, 9x, 12x... primary V6 firing series
            h = k // 6
            w = (1.0 / (h ** (0.90 if is_on else 1.15))) * (1.12 if h % 2 == 1 else 0.90)
        elif k % 3 == 0:
            # 1.5x, 4.5x, 7.5x... 90° V6 bank half-orders
            h = k // 3
            w = (0.58 if is_on else 0.80) / (h ** 0.95)
        elif k % 2 == 0:
            # 1x, 2x, 4x... crank orders (stronger in cockpit for structural monocoque punch)
            h = k // 2
            w = ((0.42 if is_int else 0.28) if is_on else 0.52) / (h ** 1.00)
        else:
            # 0.5x cycle-to-cycle texture (stronger on overrun cylinder-cut)
            w = (0.14 if is_on else 0.34) / (k ** 0.85)
        if w < 0.012:
            continue
        ph = rng.uniform(0.0, 2.0 * math.pi)
        harmonic_bed += w * np.sin(2.0 * math.pi * freq * t + ph)

    # Balance organic pulse train (80%) with stationary harmonic bed (20%) for dynamic, non-buzzy F1 roar
    raw_exhaust /= rms(raw_exhaust) + 1e-12
    harmonic_bed /= rms(harmonic_bed) + 1e-12
    core = 0.80 * raw_exhaust + 0.20 * harmonic_bed

    # 2. Split acoustic path: (a) hot-side turbine muffled main flow + (b) wastegate bypass + (c) intake plenum (int)
    if is_int:
        # Cockpit / T-cam: warm carbon monocoque structural modes (140-260 Hz) + overhead airbox roar (520-1100 Hz)
        formants_main = [
            (145.0 + 45.0 * rpm_norm, 1.9, 2.35),
            (280.0 + 75.0 * rpm_norm, 2.4, 1.85),
            (620.0 + 220.0 * rpm_norm, 2.4, 1.35 if is_on else 0.85),
            (1320.0 + 380.0 * rpm_norm, 2.5, 0.65 if is_on else 0.42),
        ]
        lp_main = (2100.0 + 2100.0 * rpm_norm) if is_on else (1500.0 + 1150.0 * rpm_norm)
        wastegate_share = (0.10 + 0.12 * rpm_norm) if is_on else 0.07
    else:
        # Exterior trackside / chase: punchy Inconel tailpipe bark + upper firing harmonics + crisp wastegate
        formants_main = [
            (185.0 + 55.0 * rpm_norm, 1.9, 1.45),
            (430.0 + 130.0 * rpm_norm, 2.8, 1.75),
            (940.0 + 380.0 * rpm_norm, 2.6, 1.45 if is_on else 0.90),
            (2050.0 + 850.0 * rpm_norm, 2.4, 0.92 if is_on else 0.50),
        ]
        lp_main = (3400.0 + 3600.0 * rpm_norm) if is_on else (2200.0 + 1700.0 * rpm_norm)
        wastegate_share = (0.18 + 0.20 * rpm_norm) if is_on else 0.12

    def main_tf(freqs: np.ndarray) -> np.ndarray:
        hp = (freqs / 42.0) ** 2 / (1.0 + (freqs / 42.0) ** 2)
        lp = 1.0 / (1.0 + (freqs / lp_main) ** 2.4)
        return resonant_formants(freqs, formants_main) * hp * lp

    def wastegate_tf(freqs: np.ndarray) -> np.ndarray:
        # Screamer bypass pipe: narrow resonant metallic edge around 1.6 - 5.0 kHz
        bp = ((freqs / 1100.0) ** 2 / (1.0 + (freqs / 1100.0) ** 2)) / (1.0 + (freqs / (5200.0 if not is_int else 3600.0)) ** 2.5)
        pk = resonant_formants(freqs, [(1850.0 + 700.0 * rpm_norm, 3.0, 1.35), (3400.0 + 850.0 * rpm_norm, 2.5, 0.75)], base=0.2)
        return bp * pk

    turbine_branch = circular_filter(core, main_tf)
    wastegate_branch = circular_filter(raw_exhaust, wastegate_tf)

    # 3. Circular-FFT broadband exhaust gas rush & combustion roar turbulence (100% seamless wrap)
    #    Strong enough to give authentic F1 exhaust "air & fire" (+26-33 dB fire-order prominence, not pure organ tone)
    white = rng.standard_normal(n)
    rush_center = (760.0 + 1150.0 * rpm_norm) if not is_int else (520.0 + 680.0 * rpm_norm)
    rush_bw = rush_center * 0.85

    def rush_tf(freqs: np.ndarray) -> np.ndarray:
        env = np.exp(-0.5 * ((freqs - rush_center) / rush_bw) ** 2)
        lo_body = (0.65 if is_int else 0.35) * np.exp(-0.5 * ((freqs - 210.0) / 130.0) ** 2)
        hi_hiss = 0.28 * np.exp(-0.5 * ((freqs - (3200.0 if not is_int else 2200.0)) / 1300.0) ** 2)
        hp = (freqs / 80.0) ** 2 / (1.0 + (freqs / 80.0) ** 2)
        return (env + lo_body + hi_hiss) * hp

    gas_rush = circular_filter(white, rush_tf)
    gas_rush /= rms(gas_rush) + 1e-12
    gas_rush *= env_gate

    # 4. Carbon monocoque bulkhead sub-body (cockpit) + overhead airbox intake induction resonance
    intake_branch = np.zeros(n, dtype=np.float64)
    tub_rumble = np.zeros(n, dtype=np.float64)
    if is_int:
        tub_rumble = circular_filter(
            raw_exhaust + 0.55 * gas_rush,
            lambda f: np.exp(-0.5 * ((f - (155.0 + 45.0 * rpm_norm)) / 75.0) ** 2) * ((f / 55.0) ** 2 / (1.0 + (f / 55.0) ** 2)),
        )
        tub_rumble /= rms(tub_rumble) + 1e-12
        if is_on:
            intake_formants = [(490.0 + 170.0 * rpm_norm, 3.0, 1.3), (980.0 + 290.0 * rpm_norm, 2.6, 0.85)]
            intake_branch = circular_filter(
                harmonic_bed + 0.55 * gas_rush,
                lambda f: resonant_formants(f, intake_formants, base=0.05) * ((f / 220.0) ** 2 / (1.0 + (f / 220.0) ** 2)) / (1.0 + (f / 2400.0) ** 2.6),
            )
            intake_branch /= rms(intake_branch) + 1e-12

    # 5. Subtle mechanical valve-train / pneumatic valve return sheen at high RPM (int only)
    mech_sheen = np.zeros(n, dtype=np.float64)
    if is_int:
        mech_noise = circular_filter(
            rng.standard_normal(n),
            lambda f: np.exp(-0.5 * ((f - (2200.0 + 850.0 * rpm_norm)) / 700.0) ** 2),
        )
        mech_sheen = (0.04 + 0.05 * rpm_norm) * mech_noise / (rms(mech_noise) + 1e-12) * (0.65 + 0.35 * env_gate)

    # Normalize branches before mixing so tonal balance is predictable across all 5 RPM anchors
    turbine_branch /= rms(turbine_branch) + 1e-12
    wastegate_branch /= rms(wastegate_branch) + 1e-12

    rush_share = (0.48 + 0.10 * rpm_norm) if is_on else (0.58 + 0.14 * (1.0 - rpm_norm))
    if is_int:
        rush_share *= 0.85

    mix = (
        turbine_branch
        + wastegate_share * wastegate_branch
        + rush_share * gas_rush
        + ((0.34 if is_on else 0.18) * tub_rumble if is_int else 0.0)
        + (0.24 * intake_branch if (is_int and is_on) else 0.0)
        + mech_sheen
    )

    # Gentle Inconel collector warmth — keep drive < 0.7 so combustion peaks breathe (crest factor ~3.1-3.8)
    mix /= rms(mix) + 1e-12
    drive = (0.48 + 0.12 * rpm_norm) if is_on else 0.38
    mix = np.tanh((mix + 0.03 * (mix * mix)) * drive)

    # Final sub-35 Hz DC/infrasonic cleanup
    mix = circular_filter(mix, lambda f: (f / 34.0) ** 2 / (1.0 + (f / 34.0) ** 2))

    # Target RMS curve matching LibreCorsa's shared bank loudness
    lo, hi = ON_RMS if is_on else OFF_RMS
    target_rms = lo + (hi - lo) * rpm_norm
    return level_loop(mix, target_rms, peak_ceiling=0.92)


# --------------------------------------------------------------------------------------------------------------------
# 2. Turbocharger + MGU-H Coaxial Shaft Loops (unpitched boost grid)
# --------------------------------------------------------------------------------------------------------------------


def synth_turbo_mguh_loop(boost_bar: float, layer: str, seed: int) -> np.ndarray:
    """
    Synthesize a 2025 F1 MGU-H-stabilized turbocharger shaft & compressor loop at `boost_bar` gauge.
    `Lc26SoundBank` plays the turbo grid unpitched across boost anchors, so each anchor encodes
    its own shaft turbine/MGU-H whine pitch and compressor air rush spectrum.
    """
    rng = np.random.default_rng(seed)
    is_on = layer == "on"
    boost_norm = np.clip((boost_bar - 0.5) / 2.2, 0.0, 1.0)

    # 2025 F1 turbo shaft spins 85,000 - 115,000 RPM (MGU-H holds it spun up on overrun too);
    # audible compressor blade-pass / MGU-H coaxial sub-whine sits cleanly in 1.45 - 2.35 kHz
    f0 = (1520.0 + 820.0 * boost_norm) if is_on else (1420.0 + 620.0 * boost_norm)
    n = int(round(round(TARGET_LOOP_S * f0) / f0 * RATE))
    t = np.arange(n, dtype=np.float64) / RATE
    dur = n / RATE

    # Gentle whole-cycle micro-flutter (organic air turbulence across compressor impeller)
    wob_hz = round(4.5 * dur) / dur
    ph_wob = 0.45 * np.sin(2.0 * math.pi * wob_hz * t)

    # Tonal turbine + MGU-H shaft carrier (kept smooth and non-piercing)
    tonal = (
        1.00 * np.sin(2.0 * math.pi * f0 * t + ph_wob + rng.uniform(0, 2 * math.pi))
        + 0.34 * np.sin(2.0 * math.pi * (2.0 * f0) * t + 2.0 * ph_wob + rng.uniform(0, 2 * math.pi))
        + 0.14 * np.sin(2.0 * math.pi * (1.5 * f0) * t + 1.5 * ph_wob + rng.uniform(0, 2 * math.pi))
        + 0.09 * np.sin(2.0 * math.pi * (3.0 * f0) * t + 3.0 * ph_wob + rng.uniform(0, 2 * math.pi))
    )
    tonal /= rms(tonal) + 1e-12

    # Broadband pressurized compressor air whoosh (circular FFT -> 100% seamless)
    white = rng.standard_normal(n)
    air_center = (2900.0 + 1900.0 * boost_norm) if is_on else (2300.0 + 1400.0 * boost_norm)
    air_bw = 1350.0 + 500.0 * boost_norm
    air = circular_filter(
        white,
        lambda f: (
            np.exp(-0.5 * ((f - air_center) / air_bw) ** 2)
            + 0.45 * np.exp(-0.5 * ((f - f0) / (0.12 * f0)) ** 2)
        )
        * ((f / 450.0) ** 2 / (1.0 + (f / 450.0) ** 2)),
    )
    air /= rms(air) + 1e-12

    # Off-throttle MGU-H anti-lag keeps a clear electric-turbine whistle with softer air rush
    mix = (0.48 * tonal + 0.88 * air) if is_on else (0.62 * tonal + 0.72 * air)
    target_rms = (0.068 + 0.026 * boost_norm) if is_on else (0.048 + 0.018 * boost_norm)
    return level_loop(mix, target_rms, peak_ceiling=0.72)


# --------------------------------------------------------------------------------------------------------------------
# 3. Crank-Coupled 120 kW MGU-K Electric Machine Loop
# --------------------------------------------------------------------------------------------------------------------


def synth_mguk_loop(seed: int) -> np.ndarray:
    """
    Crank-coupled 2025 F1 120 kW MGU-K whine (`baseRpm: 10000`, `fullKw: 120`).
    Clean inverter / permanent-magnet stator pole-pass whine with exact integer cycles.
    """
    rng = np.random.default_rng(seed)
    f0 = 1480.0  # Hz at 10,000 crank RPM (~38k MGU-K RPM -> warm musical electric whine, tracks 0.4x..1.3x)
    n = int(round(round(TARGET_LOOP_S * f0) / f0 * RATE))
    t = np.arange(n, dtype=np.float64) / RATE
    dur = n / RATE

    wob_hz = round(6.0 * dur) / dur
    phase_wob = 0.35 * np.sin(2.0 * math.pi * wob_hz * t)

    y = np.zeros(n, dtype=np.float64)
    # Fundamental stator order + harmonics + slight inverter PWM sideband sheen
    for mult, gain in [(1.0, 1.0), (2.0, 0.38), (3.0, 0.14), (0.5, 0.16), (4.0, 0.06)]:
        y += gain * np.sin(2.0 * math.pi * (f0 * mult) * t + mult * phase_wob + rng.uniform(0, 2 * math.pi))

    # Narrow halo band noise around carrier so it sits naturally inside the cockpit
    halo = circular_filter(
        rng.standard_normal(n),
        lambda f: np.exp(-0.5 * ((f - f0) / (0.09 * f0)) ** 2)
        + 0.35 * np.exp(-0.5 * ((f - 2.0 * f0) / (0.10 * f0)) ** 2),
    )
    halo /= rms(halo) + 1e-12
    y /= rms(y) + 1e-12

    mix = 0.84 * y + 0.24 * halo
    return level_loop(mix, target_rms=0.085, peak_ceiling=0.70)


# --------------------------------------------------------------------------------------------------------------------
# 4. 8-Speed Straight-Cut Seamless Gearbox Loops (`driveline` driven)
# --------------------------------------------------------------------------------------------------------------------


def synth_transmission_loop(layer: str, seed: int) -> np.ndarray:
    """
    Straight-cut F1 gearbox & final-drive whine at `drivetrainSpeed = 160` km/h.
    `on` = loaded drive flank, `off` = slightly brighter coast/overrun flank.
    """
    rng = np.random.default_rng(seed)
    is_on = layer == "on"
    # Primary mesh + final-drive mesh frequencies at 160 km/h (pitch-tracked by driveshaftRadS * 1.296)
    f_mesh = 1040.0 if is_on else 1120.0
    n = int(round(round(TARGET_LOOP_S * f_mesh) / f_mesh * RATE))
    t = np.arange(n, dtype=np.float64) / RATE
    dur = n / RATE

    # Slight gear-tooth eccentricity sidebands (exact whole cycles in loop)
    shaft_hz = round(34.3 * dur) / dur  # ~160 km/h / (3.6 * 0.36 m) / (2*pi) ≈ 19.7 Hz -> 2nd harmonic
    mod = 0.32 * np.sin(2.0 * math.pi * shaft_hz * t)

    partials = (
        [(1.0, 1.00), (2.0, 0.42), (3.0, 0.18), (1.375, 0.36), (2.75, 0.14)]
        if is_on
        else [(1.0, 0.90), (2.0, 0.54), (3.0, 0.24), (1.375, 0.30), (2.75, 0.18)]
    )
    tonal = np.zeros(n, dtype=np.float64)
    for mult, gain in partials:
        f_cur = round((f_mesh * mult) * dur) / dur
        tonal += gain * np.sin(2.0 * math.pi * f_cur * t + mult * mod + rng.uniform(0, 2 * math.pi))
    tonal /= rms(tonal) + 1e-12

    # Carbon gearbox casing mechanical hiss/rattle band
    mech = circular_filter(
        rng.standard_normal(n),
        lambda f: (
            np.exp(-0.5 * ((f - 1850.0) / 850.0) ** 2)
            + 0.4 * np.exp(-0.5 * ((f - 3400.0) / 1000.0) ** 2)
        )
        * ((f / 500.0) ** 2 / (1.0 + (f / 500.0) ** 2)),
    )
    mech /= rms(mech) + 1e-12

    mix = (0.78 * tonal + 0.38 * mech) if is_on else (0.74 * tonal + 0.42 * mech)
    return level_loop(mix, target_rms=(0.044 if is_on else 0.030), peak_ceiling=0.55)


# --------------------------------------------------------------------------------------------------------------------
# 5. Procedural Oneshots (shifts, backfires, pops, blowoff, limiter)
# --------------------------------------------------------------------------------------------------------------------


def prepare_oneshot(x: np.ndarray, target_peak: float = 0.78, fade_in_s: float = 0.003, fade_out_s: float = 0.025) -> np.ndarray:
    y = x.astype(np.float64) - float(np.mean(x))
    n = len(y)
    fi = min(int(fade_in_s * RATE), n // 5)
    fo = min(int(fade_out_s * RATE), n // 3)
    if fi > 0:
        y[:fi] *= np.linspace(0.0, 1.0, fi)
    if fo > 0:
        y[-fo:] *= np.linspace(1.0, 0.0, fo)
    pk = float(np.max(np.abs(y)))
    if pk > 1e-6:
        y *= target_peak / pk
    return np.clip(y, -0.98, 0.98).astype(np.float32)


def _bandpass(x: np.ndarray, lo: float, hi: float, order: int = 3) -> np.ndarray:
    sos = signal.butter(order, [lo, hi], btype="band", fs=RATE, output="sos")
    return signal.sosfilt(sos, x)


def synth_oneshots(engine_loops: dict[str, np.ndarray]) -> list[tuple[str, str, np.ndarray]]:
    """Synthesize all required and optional oneshot roles cleanly."""
    out: list[tuple[str, str, np.ndarray]] = []
    rng = np.random.default_rng(202509)

    # 1) gear_up: crisp seamless-shift ignition-cut exhaust bark + pneumatic actuator click
    dur = 0.145
    n = int(dur * RATE)
    t = np.arange(n, dtype=np.float64) / RATE
    thump = np.sin(2.0 * math.pi * (165.0 * np.exp(-t * 9.0) + 65.0) * t) * np.exp(-t * 28.0)
    bark = _bandpass(rng.standard_normal(n), 280.0, 3200.0) * np.exp(-t * 24.0)
    act = _bandpass(rng.standard_normal(n), 1800.0, 5600.0) * np.exp(-((t - 0.006) / 0.006) ** 2)
    gear_up = np.tanh((1.1 * thump + 1.4 * bark + 0.55 * act) * 1.5)
    out.append(("gear_up", "oneshot_gear_up.ogg", prepare_oneshot(gear_up, 0.76, 0.002, 0.03)))

    # 2) shift_cut: sharp 25 ms seamless-shift torque-cut snap in carbon bulkhead
    dur = 0.11
    n = int(dur * RATE)
    t = np.arange(n, dtype=np.float64) / RATE
    snap = _bandpass(rng.standard_normal(n), 450.0, 3800.0) * np.exp(-t * 36.0)
    knock = np.sin(2.0 * math.pi * 125.0 * t) * np.exp(-t * 38.0)
    shift_cut = np.tanh((1.2 * snap + 0.9 * knock) * 1.4)
    out.append(("shift_cut", "oneshot_shift_cut.ogg", prepare_oneshot(shift_cut, 0.74, 0.002, 0.025)))

    # 3) gear_down: ECU auto-blip punch + dog-ring mechanical engagement
    dur = 0.185
    n = int(dur * RATE)
    t = np.arange(n, dtype=np.float64) / RATE
    blip_f = 420.0 + 180.0 * np.sin(np.minimum(1.0, t / 0.065) * math.pi)
    blip_ph = 2.0 * math.pi * np.cumsum(blip_f) / RATE
    blip = (np.sin(blip_ph) + 0.55 * np.sin(2.0 * blip_ph) + 0.35 * np.sin(1.5 * blip_ph)) * np.sin(
        np.minimum(1.0, t / 0.015) * math.pi * 0.5
    ) * np.exp(-t * 17.0)
    clack = _bandpass(rng.standard_normal(n), 320.0, 2600.0) * np.exp(-t * 22.0)
    gear_down = np.tanh((0.95 * blip + 1.15 * clack) * 1.4)
    out.append(("gear_down", "oneshot_gear_down.ogg", prepare_oneshot(gear_down, 0.75, 0.003, 0.035)))

    # 4) backfire_int (3 variants): muffled cockpit overrun pops/burbles through carbon tub
    for i, (dur, f_lo, f_hi, decay, double_t) in enumerate(
        [
            (0.22, 95.0, 1450.0, 19.0, None),
            (0.27, 85.0, 1300.0, 15.5, 0.085),
            (0.19, 110.0, 1650.0, 23.0, None),
        ],
        start=1,
    ):
        n = int(dur * RATE)
        t = np.arange(n, dtype=np.float64) / RATE
        env = np.exp(-t * decay)
        if double_t is not None:
            env += 0.62 * np.where(t >= double_t, np.exp(-(t - double_t) * (decay * 1.15)), 0.0)
        body = np.sin(2.0 * math.pi * (120.0 * np.exp(-t * 8.0) + 52.0) * t) * env
        burst = _bandpass(rng.standard_normal(n), f_lo, f_hi) * env
        sig = np.tanh((0.9 * body + 1.35 * burst) * 1.6)
        out.append(("backfire_int", f"oneshot_backfire_int_{i}.ogg", prepare_oneshot(sig, 0.78, 0.003, 0.03)))

    # 5) backfire_ext (3 variants): crisp open-air tailpipe overrun bang + crackle decay
    for i, (dur, crackle_n, decay) in enumerate([(0.34, 2, 14.0), (0.46, 4, 11.5), (0.28, 1, 17.5)], start=1):
        n = int(dur * RATE)
        t = np.arange(n, dtype=np.float64) / RATE
        env = np.exp(-t * decay)
        for c in range(crackle_n):
            t0 = 0.05 + c * 0.065 + rng.uniform(0.0, 0.025)
            if t0 < dur - 0.04:
                env += rng.uniform(0.35, 0.65) * np.where(t >= t0, np.exp(-(t - t0) * 32.0), 0.0)
        crack = _bandpass(rng.standard_normal(n), 180.0, 4800.0) * env
        punch = np.sin(2.0 * math.pi * (170.0 * np.exp(-t * 10.0) + 60.0) * t) * np.exp(-t * 22.0)
        sig = np.tanh((1.35 * crack + 0.75 * punch) * 1.7)
        out.append(("backfire_ext", f"oneshot_backfire_ext_{i}.ogg", prepare_oneshot(sig, 0.78, 0.002, 0.04)))

    # 6) pop_ext (2 variants): short sharp exterior exhaust overrun pops
    for i, (dur, decay) in enumerate([(0.17, 26.0), (0.21, 21.0)], start=1):
        n = int(dur * RATE)
        t = np.arange(n, dtype=np.float64) / RATE
        pop = _bandpass(rng.standard_normal(n), 240.0, 4200.0) * np.exp(-t * decay)
        th = np.sin(2.0 * math.pi * (190.0 * np.exp(-t * 14.0) + 75.0) * t) * np.exp(-t * 30.0)
        sig = np.tanh((1.3 * pop + 0.7 * th) * 1.6)
        out.append(("pop_ext", f"oneshot_pop_ext_{i}.ogg", prepare_oneshot(sig, 0.76, 0.002, 0.025)))

    # 7) blowoff: tight 2025 F1 MGU-H-damped wastegate / compressor flutter puff on lift
    dur = 0.28
    n = int(dur * RATE)
    t = np.arange(n, dtype=np.float64) / RATE
    flutter = 0.60 + 0.40 * np.cos(2.0 * math.pi * 24.0 * t)
    air = _bandpass(rng.standard_normal(n), 1400.0, 6200.0)
    whistle = np.sin(2.0 * math.pi * (2150.0 - 480.0 * t / dur) * t) * 0.25
    env = np.sin(np.minimum(1.0, t / 0.018) * math.pi * 0.5) * np.exp(-t * 11.5) * flutter
    blowoff = (air + whistle) * env
    out.append(("blowoff", "oneshot_blowoff.ogg", prepare_oneshot(blowoff, 0.66, 0.004, 0.04)))

    # 8) limiter: 18 Hz ignition/fuel-flow cut bounce derived directly from the top interior engine loop
    top_loop = engine_loops["engine_int_on_13000.ogg"].astype(np.float64)
    dur = 0.78
    n = int(dur * RATE)
    seg = np.resize(top_loop, n).copy()
    t = np.arange(n, dtype=np.float64) / RATE
    gate = 0.14 + 0.86 * np.power(0.5 + 0.5 * np.cos(2.0 * math.pi * 17.5 * t), 2.2)
    limiter = seg * gate
    out.append(("limiter", "oneshot_limiter.ogg", prepare_oneshot(limiter, 0.78, 0.006, 0.035)))

    return out


# --------------------------------------------------------------------------------------------------------------------
# Build orchestrator
# --------------------------------------------------------------------------------------------------------------------


def build_bank(out_dir: Path, ffmpeg: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "source": "LibreCorsa procedural 2025 1.6L V6 Turbo-Hybrid + MGU-H synthesis (scripts/audio/synth_f1_2025_bank.py)",
        "sampleRate": RATE,
        "loopSeconds": TARGET_LOOP_S,
        "engine": {"ext": [], "int": []},
        "turbo": [],
        "transmission": [],
        "oneshots": [],
        "throttleCurve": {
            "ext": [[0.0, 0.0], [0.1, 0.24], [0.25, 0.54], [0.5, 0.81], [0.75, 0.94], [1.0, 1.0]],
            "int": [[0.0, 0.0], [0.1, 0.27], [0.25, 0.57], [0.5, 0.83], [0.75, 0.95], [1.0, 1.0]],
        },
        "driveline": {
            # 3.6 * 0.360 m rear tyre radius = 1.296 km/h per rad/s
            "kmhPerRadS": 1.296,
            "torqueRefNm": 2600,
            "coastTorqueRefNm": 950,
            "floor": 0.14,
            "gain": {"int": 0.85, "ext": 0.30},
        },
        "loadFilter": {
            "coastHz": 2400,
            "loadHz": 15500,
            "tauS": 0.022,
        },
        "viewTone": {
            "int": {"peakHz": 240, "peakDb": 3.0, "peakQ": 1.4, "shelfHz": 4200, "shelfDb": -2.5},
            "ext": {"peakHz": 880, "peakDb": 1.8, "peakQ": 1.1, "shelfHz": 5200, "shelfDb": 1.5},
        },
        "shift": {"style": "sequential", "cutS": 0.025},
        "lift": {"popMinRpm": 8000, "crackleMinRpm": 8800, "downshiftPopChance": 0.55},
        "limiterRetriggerS": 0.80,
    }

    written: set[str] = {"manifest.json"}
    engine_loops: dict[str, np.ndarray] = {}

    print("1. Synthesizing 2025 V6 Turbo-Hybrid engine loops...")
    seed_i = 202500
    for view in ("ext", "int"):
        for layer in ("on", "off"):
            for rpm, n_cycles in ENGINE_ANCHORS:
                seed_i += 1
                fn = f"engine_{view}_{layer}_{rpm}.ogg"
                wav = synth_v6_engine_loop(rpm, n_cycles, view, layer, seed_i)
                engine_loops[fn] = wav
                encode_ogg(ffmpeg, wav, out_dir / fn)
                written.add(fn)
                seam = abs(float(wav[0]) - float(wav[-1]))
                r = round(rms(wav), 4)
                manifest["engine"][view].append(
                    {"file": fn, "layer": layer, "rpm": rpm, "channels": 1, "rms": r}
                )
                print(
                    f"  {fn:<28} {len(wav)/RATE:5.3f}s  rms={r:.4f}  peak={np.max(np.abs(wav)):.3f}  seam={seam:.5f}"
                )

    print("\n2. Synthesizing Turbo + MGU-H coaxial shaft loops...")
    for layer in ("on", "off"):
        for boost in TURBO_BOOSTS:
            seed_i += 1
            tag = int(round(boost * 10))
            fn = f"turbo_{layer}_{tag:02d}.ogg"
            wav = synth_turbo_mguh_loop(boost, layer, seed_i)
            encode_ogg(ffmpeg, wav, out_dir / fn)
            written.add(fn)
            r = round(rms(wav), 4)
            manifest["turbo"].append(
                {"file": fn, "layer": layer, "boost": boost, "channels": 1, "rms": r}
            )
            print(f"  {fn:<28} {len(wav)/RATE:5.3f}s  boost={boost:.1f} bar  rms={r:.4f}")

    print("\n3. Synthesizing 8-speed straight-cut transmission & 120 kW MGU-K loops...")
    for layer in ("on", "off"):
        seed_i += 1
        fn = f"trans_{layer}_160.ogg"
        wav = synth_transmission_loop(layer, seed_i)
        encode_ogg(ffmpeg, wav, out_dir / fn)
        written.add(fn)
        r = round(rms(wav), 4)
        manifest["transmission"].append(
            {"file": fn, "layer": layer, "drivetrainSpeed": 160, "channels": 1, "rms": r}
        )
        print(f"  {fn:<28} {len(wav)/RATE:5.3f}s  rms={r:.4f}")

    seed_i += 1
    mgu_wav = synth_mguk_loop(seed_i)
    encode_ogg(ffmpeg, mgu_wav, out_dir / "mgu.ogg")
    written.add("mgu.ogg")
    manifest["mgu"] = {
        "file": "mgu.ogg",
        "channels": 1,
        "rms": round(rms(mgu_wav), 4),
        "baseRpm": 10000,
        "fullKw": 120,
        "gain": {"int": 0.36, "ext": 0.14},
    }
    print(f"  {'mgu.ogg':<28} {len(mgu_wav)/RATE:5.3f}s  rms={manifest['mgu']['rms']:.4f}")

    print("\n4. Synthesizing shift, backfire, blowoff and limiter one-shots...")
    for role, fn, wav in synth_oneshots(engine_loops):
        encode_ogg(ffmpeg, wav, out_dir / fn)
        written.add(fn)
        pk = round(float(np.max(np.abs(wav))), 3)
        sec = round(len(wav) / RATE, 3)
        manifest["oneshots"].append(
            {"file": fn, "role": role, "channels": 1, "seconds": sec, "peak": pk}
        )
        print(f"  {fn:<28} {sec:5.3f}s  role={role:<13}  peak={pk:.3f}")

    # Remove any stale .ogg files from earlier runs
    for p in out_dir.glob("*.ogg"):
        if p.name not in written:
            p.unlink()

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    total_bytes = sum(p.stat().st_size for p in out_dir.iterdir() if p.is_file())
    print(
        f"\nBuilt LC25 Prototype sound bank: {len(written) - 1} Ogg files, "
        f"{total_bytes / (1024 * 1024):.2f} MB -> {out_dir}"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Synthesize LC25 Prototype 2025 F1 V6 Hybrid sound bank.")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR, help="Output directory (default: public/cars/lc25/audio)")
    ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", FFMPEG_DEFAULT), help="Path to ffmpeg binary")
    args = ap.parse_args()
    build_bank(args.out, args.ffmpeg)


if __name__ == "__main__":
    main()
