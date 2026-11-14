#!/usr/bin/env python3
"""
Custom sound bank builder: turns raw onboard / trackside recordings of a car into the multi-grid bank the game's
bank player reads (`public/cars/<id>/audio/manifest.json` + Ogg loops and one-shots, the same format
`port_ac_bank.py` writes).

A recording of a car being driven never holds the revs still, so a loop cannot be cut from it directly. This tool:

  1. tracks the engine speed through the recording from its strongest engine-order line (`engine.rpmPerHz`: the rpm
     per Hz of that line, 30 for the per-bank line of a V8, 15 for its firing line),
  2. picks, for every band of the recipe (a view, on or off load, a target rpm), the cleanest stretches whose revs
     pass close to the target,
  3. "de-sweeps" each stretch: resamples it along the integral of its tracked frequency so the rising or falling
     note becomes a steady one at the target rpm (the same resampling a pitch-tracking player does, so harmonics and
     formants move together by at most the band's tolerance),
  4. optionally notches stationary lines that are not engine orders (gear whine, above `notch.minHz`),
  5. closes the result into a loop of a whole number of engine cycles with an equal-power crossfade,
  6. levels it on the repository's RMS curve and encodes it as Ogg Vorbis.

Gear changes found in the rpm track give the shift one-shots; broadband transients on the overrun give the pops.

Usage (a Python with numpy, scipy and soundfile; ffmpeg for the Ogg encode):

  python -I scripts/audio/build_custom_soundbank.py --recipe <recipe.json> --analyze     # rpm track of every source
  python -I scripts/audio/build_custom_soundbank.py --recipe <recipe.json>               # build the bank
  python -I scripts/audio/build_custom_soundbank.py --recipe <recipe.json> --only int_on_6800

See scripts/audio/README.md for the recipe format.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from scipy import signal

RATE = 48000
FFMPEG_DEFAULT = "/opt/homebrew/bin/ffmpeg"
REPO_ROOT = Path(__file__).resolve().parents[2]

# Level curve shared with port_ac_bank.py: the player mixes every bank at the same bus gains, so a bank built here
# sits at the same loudness as a ported one. (An integrated-loudness target would level each loop on its own
# spectrum and break that match; the report still lists each loop's LUFS.)
ON_RMS = (0.165, 0.220)
OFF_RMS = (0.125, 0.175)
OGG_QUALITY = 4

TRACK_FS = 6000  # the rpm tracker works on a decimated copy
TRACK_HOP_S = 0.01


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0


def db(x: float) -> float:
    return 20.0 * math.log10(max(1e-12, x))


# --------------------------------------------------------------------------------------------------------------------
# Engine-speed tracking
# --------------------------------------------------------------------------------------------------------------------


@dataclass
class Track:
    """The tracked engine line of one source, on a 10 ms grid"""

    t: np.ndarray  # frame times (s, from the start of the file)
    hz: np.ndarray  # frequency of the tracked line (Hz), refined below the bin spacing
    hnr: np.ndarray  # share of the 80-2900 Hz energy that sits on the line's harmonics (0..1)
    level: np.ndarray  # frame RMS (linear)
    hf: np.ndarray  # RMS above 2.2 kHz relative to its running median (kerb strikes, pops, clicks)
    shift: np.ndarray  # +1 on an upshift frame, -1 on a downshift frame, 0 elsewhere
    slope: np.ndarray  # d(ln f)/dt (1/s), shifts excluded
    jump: np.ndarray  # ln of the step in f across each frame, trends removed (meaningful at shift frames)
    rpm_per_hz: float

    @property
    def rpm(self) -> np.ndarray:
        return self.hz * self.rpm_per_hz


def _stft_mag(y: np.ndarray, fs: float, win_s: float, nfft: int, hop_s: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    nper = int(round(win_s * fs))
    hop = int(round(hop_s * fs))
    f, t, z = signal.stft(y, fs, nperseg=nper, noverlap=nper - hop, nfft=nfft, window="hann", boundary=None, padded=False)
    return f, t + 0.0, np.abs(z).astype(np.float32)


def _rolling_fit(v: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean and per-frame slope of the least-squares line through every window of `n` frames (indexed by its last
    frame; the first n-1 entries are NaN)"""
    k = np.arange(n) - (n - 1) / 2.0
    mean = np.full(len(v), np.nan)
    slope = np.full(len(v), np.nan)
    if len(v) >= n:
        mean[n - 1 :] = np.convolve(v, np.ones(n) / n, mode="valid")
        slope[n - 1 :] = np.convolve(v, (k / float(np.sum(k * k)))[::-1], mode="valid")
    return mean, slope


def track_engine_line(
    x: np.ndarray,
    sr: int,
    rpm_per_hz: float,
    rpm_min: float,
    rpm_max: float,
    t_offset: float = 0.0,
    win_s: float = 0.085,
    jump_cost: float = 9.0,
) -> Track:
    """
    Follows the strongest engine-order line with a harmonic-sum salience and a Viterbi path.

    The salience of a candidate frequency is its own (compressed) magnitude plus smaller shares of its 2nd to 4th
    multiples: the line itself must be there, so neither the octave below (whose own bin is weak) nor the octave
    above (which loses the multiples) wins. The path may slide a few cents per frame for free-ish and jump anywhere
    for a fixed cost, which is what a gear change is.
    """
    dec = max(1, sr // TRACK_FS)
    y = signal.resample_poly(x.astype(np.float64), 1, dec) if dec > 1 else x.astype(np.float64)
    fs = sr / dec
    nfft = 8192
    f, t, mag = _stft_mag(y, fs, win_s, nfft, TRACK_HOP_S)
    t = t + t_offset
    comp = np.sqrt(mag)  # compressed magnitude: a loud line does not drown its harmonics in the sum

    fmin, fmax = rpm_min / rpm_per_hz, rpm_max / rpm_per_hz
    n_cand = int(math.ceil(math.log2(fmax / fmin) * 150)) + 1  # 8 cent steps
    cand = fmin * np.power(2.0, np.arange(n_cand) / 150.0)
    df = f[1] - f[0]
    weights = [(1.0, 1.0), (2.0, 0.45), (3.0, 0.3), (4.0, 0.22)]
    sal = np.zeros((n_cand, comp.shape[1]), dtype=np.float32)
    for h, w in weights:
        pos = cand * h / df
        ok = pos < comp.shape[0] - 2
        i0 = np.floor(pos[ok]).astype(int)
        fr = (pos[ok] - i0)[:, None].astype(np.float32)
        # the wider of the two neighbouring bins on either side keeps a sweeping line inside the lobe
        sal[ok] += w * (comp[i0] * (1 - fr) + comp[i0 + 1] * fr)
    # Half-frequency guard: energy an octave below the candidate means the candidate is that line's 2nd multiple
    pos = cand * 0.5 / df
    i0 = np.floor(pos).astype(int)
    fr = (pos - i0)[:, None].astype(np.float32)
    sal -= 0.35 * (comp[i0] * (1 - fr) + comp[i0 + 1] * fr)
    norm = np.percentile(sal, 95, axis=0, keepdims=True) + 1e-9
    sal = sal / norm

    # Viterbi: cost = -salience + slide cost per step, capped at the jump cost
    n_t = sal.shape[1]
    idx = np.arange(n_cand)
    trans = np.minimum(np.abs(idx[:, None] - idx[None, :]).astype(np.float32) * 0.22, jump_cost)
    cost = -sal[:, 0].astype(np.float32)
    back = np.zeros((n_t, n_cand), dtype=np.int32)
    for k in range(1, n_t):
        total = cost[None, :] + trans
        back[k] = np.argmin(total, axis=1)
        cost = total[idx, back[k]] - sal[:, k]
    path = np.zeros(n_t, dtype=np.int32)
    path[-1] = int(np.argmin(cost))
    for k in range(n_t - 1, 0, -1):
        path[k - 1] = back[k, path[k]]
    coarse = cand[path]

    # Refine each frame: parabolic peak of the line and of its 2nd multiple, magnitude-weighted
    hz = coarse.copy()
    hnr = np.zeros(n_t, dtype=np.float32)
    band = (f >= 80) & (f <= min(2900, fs * 0.48))
    logm = np.log(mag + 1e-9)
    for k in range(n_t):
        est, wsum = 0.0, 0.0
        for h in (1.0, 2.0):
            c = coarse[k] * h
            lo = max(1, int((c * 0.97) / df))
            hi = min(len(f) - 2, int(math.ceil((c * 1.03) / df)))
            if hi <= lo:
                continue
            p = lo + int(np.argmax(mag[lo : hi + 1, k]))
            a, b, cc = logm[p - 1, k], logm[p, k], logm[p + 1, k]
            den = a - 2 * b + cc
            off = 0.5 * (a - cc) / den if abs(den) > 1e-9 else 0.0
            w = float(mag[p, k])
            est += w * (p + float(np.clip(off, -0.5, 0.5))) * df / h
            wsum += w
        if wsum > 0:
            hz[k] = est / wsum
        # harmonic share: energy within 2.5 % of every half-multiple of the line (engine orders 0.5 apart)
        base = hz[k] * rpm_per_hz / 120.0  # the half-order spacing: rpm / 120
        e = np.square(mag[:, k].astype(np.float64))
        r = (f / base) - np.round(f / base)
        teeth = band & (np.abs(r) * base <= np.maximum(2.5, 0.006 * f))
        tot = float(e[band].sum()) + 1e-12
        hnr[k] = float(e[teeth].sum()) / tot

    # Frame level and high-frequency transient measure from the full-rate signal
    hop = int(round(TRACK_HOP_S * sr))
    n_hop = len(x) // hop
    frames = x[: n_hop * hop].reshape(n_hop, hop).astype(np.float64)
    lvl_full = np.sqrt(np.mean(frames**2, axis=1))
    sos = signal.butter(4, 2200, btype="high", fs=sr, output="sos")
    xh = signal.sosfilt(sos, x.astype(np.float64))
    hf_full = np.sqrt(np.mean(xh[: n_hop * hop].reshape(n_hop, hop) ** 2, axis=1))
    t_full = (np.arange(n_hop) + 0.5) * TRACK_HOP_S + t_offset
    level = np.interp(t, t_full, lvl_full)
    hf_raw = np.interp(t, t_full, hf_full)
    med = signal.medfilt(hf_raw, 101) + 1e-9
    hf = hf_raw / med

    # Gear changes: a step in the line that the trends either side of it do not explain. Straight lines are fitted
    # to ln f over 90 ms before and after a 100 ms gap (the analysis window smears a step over about that much) and
    # both are carried to the middle: their difference is the jump. Hard braking alone drops the revs by 40-60 % a
    # second, which a plain before/after difference would read as a string of upshifts
    ln = np.log(hz)
    n_fit, gap = 9, 5
    mean_w, slope_w = _rolling_fit(ln, n_fit)  # of the window ending at each frame
    reach = gap + (n_fit - 1) / 2.0
    left = np.full(n_t, np.nan)
    right = np.full(n_t, np.nan)
    left[gap + n_fit - 1 :] = (mean_w + slope_w * reach)[n_fit - 1 : n_t - gap]
    right[: n_t - gap - n_fit + 1] = (mean_w - slope_w * reach)[gap + n_fit - 1 :]
    jump = np.nan_to_num(right - left, nan=0.0)
    shift = np.zeros(n_t, dtype=np.int8)
    thr_up, thr_dn, thr_max = math.log(1.07), math.log(1.07), math.log(1.5)
    mag_j = np.abs(jump)
    peaks, _ = signal.find_peaks(mag_j, height=min(thr_up, thr_dn), distance=12)
    for p in peaks:
        if mag_j[p] > thr_max:
            continue  # a tracking slip, not a gear
        if jump[p] < -thr_up:
            shift[p] = 1
        elif jump[p] > thr_dn:
            shift[p] = -1

    # Slope of ln f over 250 ms, blanked around shifts
    n_s = 25
    _, sl = _rolling_fit(ln, n_s)
    slope = np.full(n_t, np.nan)
    slope[n_s // 2 : n_t - n_s // 2] = sl[n_s - 1 :] / TRACK_HOP_S
    near = np.convolve((shift != 0).astype(float), np.ones(2 * (n_s // 2) + 9), mode="same") > 0
    slope[near] = np.nan
    return Track(t=t, hz=hz, hnr=hnr, level=level, hf=hf, shift=shift, slope=slope, jump=jump, rpm_per_hz=rpm_per_hz)


def shift_ratios(track: Track) -> tuple[list[float], list[float]]:
    """rpm before / after of every upshift, and after / before of every downshift (both > 1)"""
    ups = [float(math.exp(-track.jump[k])) for k in np.nonzero(track.shift > 0)[0]]
    downs = [float(math.exp(track.jump[k])) for k in np.nonzero(track.shift < 0)[0]]
    return ups, downs


def _ratio_hist(ratios: list[float]) -> dict[str, int]:
    hist, edges = np.histogram(ratios, bins=np.arange(1.04, 1.5001, 0.02)) if ratios else ([], [])
    return {f"{edges[i]:.2f}": int(hist[i]) for i in range(len(hist)) if hist[i]}


def analyze_report(name: str, track: Track) -> dict[str, Any]:
    rpm = track.rpm
    good = track.hnr > np.percentile(track.hnr, 35)
    ups, downs = shift_ratios(track)
    hist, edges = np.histogram(rpm[good], bins=np.arange(1000, 9601, 400))
    out = {
        "source": name,
        "seconds": [round(float(track.t[0]), 2), round(float(track.t[-1]), 2)],
        "rpmPercentiles": {str(p): int(np.percentile(rpm[good], p)) for p in (1, 5, 25, 50, 75, 95, 99, 99.9)},
        "rpmHistogram": {f"{int(edges[i])}": int(hist[i]) for i in range(len(hist)) if hist[i]},
        "upshifts": len(ups),
        "upshiftRatioMedian": round(float(np.median(ups)), 3) if ups else None,
        "upshiftRatioHistogram": _ratio_hist(ups),
        "downshifts": len(downs),
        "downshiftRatioMedian": round(float(np.median(downs)), 3) if downs else None,
        "downshiftRatioHistogram": _ratio_hist(downs),
        "meanHarmonicShare": round(float(track.hnr.mean()), 3),
    }
    return out


# --------------------------------------------------------------------------------------------------------------------
# Window selection
# --------------------------------------------------------------------------------------------------------------------


@dataclass
class Piece:
    source: str
    t0: float
    t1: float
    rpm0: float
    rpm1: float
    score: float
    hnr: float
    audio: np.ndarray | None = None
    info: dict[str, Any] = field(default_factory=dict)


def classify_layer(track: Track, on_slope: float, off_slope: float) -> np.ndarray:
    """+1 on load (revs holding or rising), -1 on the overrun (revs falling), 0 unclear or next to a shift"""
    s = track.slope
    out = np.zeros(len(s), dtype=np.int8)
    out[np.nan_to_num(s, nan=-99.0) >= on_slope] = 1
    out[np.nan_to_num(s, nan=99.0) <= off_slope] = -1
    return out


def find_pieces(
    name: str,
    track: Track,
    layer: str,
    target_rpm: float,
    tol: float,
    min_s: float,
    on_slope: float,
    off_slope: float,
    max_hf: float,
) -> list[Piece]:
    want = 1 if layer == "on" else -1
    cls = classify_layer(track, on_slope, off_slope)
    rpm = track.rpm
    near = np.abs(np.log(rpm / target_rpm)) <= math.log(1 + tol)
    ok = (cls == want) & near & (track.hf < max_hf)
    pieces: list[Piece] = []
    k, n = 0, len(ok)
    min_frames = int(round(min_s / TRACK_HOP_S))
    while k < n:
        if not ok[k]:
            k += 1
            continue
        j = k
        while j < n and ok[j]:
            j += 1
        if j - k >= min_frames:
            sl = slice(k, j)
            hnr = float(track.hnr[sl].mean())
            # steadiness of the level inside the piece and distance from the target both cost a little
            lv = track.level[sl]
            wobble = float(np.std(lv) / (np.mean(lv) + 1e-9))
            dist = abs(math.log(float(np.median(rpm[sl])) / target_rpm))
            length_bonus = min(1.0, (j - k) * TRACK_HOP_S / 2.4)
            score = hnr - 0.25 * wobble - 0.6 * dist + 0.12 * length_bonus
            pieces.append(
                Piece(name, float(track.t[k]), float(track.t[j - 1]), float(rpm[k]), float(rpm[j - 1]), score, hnr)
            )
        k = j
    pieces.sort(key=lambda p: -p.score)
    return pieces


# --------------------------------------------------------------------------------------------------------------------
# De-sweep, notch, loop
# --------------------------------------------------------------------------------------------------------------------


def desweep(x: np.ndarray, sr: int, t0: float, track: Track, target_hz: float) -> np.ndarray:
    """
    Resamples `x` (which starts at `t0` in the track's time) so the tracked line sits still at `target_hz`: the output
    is read at the input times where the line's phase (the integral of its frequency) has advanced by equal steps.
    """
    n = len(x)
    ts = t0 + np.arange(n) / sr
    # the tracked frequency, lightly smoothed (it is refined per frame, so frame noise is a few cents)
    k0 = max(0, int(np.searchsorted(track.t, ts[0])) - 12)
    k1 = min(len(track.t), int(np.searchsorted(track.t, ts[-1])) + 12)
    tt, ff = track.t[k0:k1], track.hz[k0:k1].copy()
    if len(ff) >= 11:
        # a frame the tracker put on another line (more than 5 % off the half-second median) is bridged
        med = signal.medfilt(ff, min(len(ff) // 2 * 2 - 1, 51))
        bad = np.abs(np.log(ff / med)) > 0.05
        if bad.any() and not bad.all():
            ff[bad] = np.interp(tt[bad], tt[~bad], ff[~bad])
        ff = np.exp(signal.savgol_filter(np.log(ff), 11, 2))
    f_inst = np.interp(ts, tt, ff)
    phase = np.cumsum(f_inst) / sr  # in cycles of the line
    phase -= phase[0]
    n_out = int(math.floor(phase[-1] / target_hz * sr))
    want = np.arange(n_out) * (target_hz / sr)
    src_pos = np.interp(want, phase, np.arange(n, dtype=np.float64))
    # 4x oversampled linear read: flat to 16 kHz without a windowed-sinc per sample
    up = 4
    xu = signal.resample_poly(x.astype(np.float64), up, 1)
    p = src_pos * up
    i0 = np.clip(np.floor(p).astype(np.int64), 0, len(xu) - 2)
    fr = p - i0
    return (xu[i0] * (1 - fr) + xu[i0 + 1] * fr).astype(np.float32)


def flatten_envelope(y: np.ndarray, sr: int, max_db: float = 5.0) -> np.ndarray:
    """Evens out the slow level change through a sweep (a loop whose head is louder than its tail pulses)"""
    blk = int(0.12 * sr)
    if len(y) < 3 * blk:
        return y
    n_b = len(y) // blk
    env = np.sqrt(np.mean(y[: n_b * blk].reshape(n_b, blk).astype(np.float64) ** 2, axis=1)) + 1e-9
    centers = (np.arange(n_b) + 0.5) * blk
    env_s = np.interp(np.arange(len(y)), centers, env)
    g = np.clip(np.median(env) / env_s, 10 ** (-max_db / 20), 10 ** (max_db / 20))
    return (y * g).astype(np.float32)


def find_whine_lines(y: np.ndarray, sr: int, base_hz: float, min_hz: float, max_lines: int, min_db: float) -> list[tuple[float, float]]:
    """Stationary narrow lines above `min_hz` that are not multiples of `base_hz` (the engine's half-order spacing)"""
    nper = min(len(y), 16384)
    f, pxx = signal.welch(y.astype(np.float64), sr, nperseg=nper, noverlap=nper // 2)
    ldb = 10 * np.log10(pxx + 1e-20)
    width = max(5, int(260 / (f[1] - f[0])) | 1)
    floor = signal.medfilt(ldb, width)
    prom = ldb - floor
    band = (f >= min_hz) & (f <= 9000)
    peaks, _ = signal.find_peaks(np.where(band, prom, 0), height=min_db, distance=max(2, int(25 / (f[1] - f[0]))))
    out = []
    for p in peaks:
        r = f[p] / base_hz
        if abs(r - round(r)) * base_hz <= max(4.0, 0.003 * f[p]):
            continue  # an engine order
        out.append((float(f[p]), float(prom[p])))
    out.sort(key=lambda a: -a[1])
    return out[:max_lines]


def notch_lines(y: np.ndarray, sr: int, lines: list[tuple[float, float]], q: float) -> np.ndarray:
    out = y.astype(np.float64)
    for hz, _ in lines:
        b, a = signal.iirnotch(hz, q, fs=sr)
        out = signal.filtfilt(b, a, out)
    return out.astype(np.float32)


def align_and_join(a: np.ndarray, b: np.ndarray, sr: int, cycle_n: int, xf_s: float = 0.08) -> np.ndarray:
    """Appends `b` to `a` with an equal-power crossfade, `b` slid by up to one engine cycle to line its phase up"""
    xf = min(int(xf_s * sr), len(a) // 3, (len(b) - cycle_n) // 3)
    if xf < 64:
        return np.concatenate([a, b])
    ref = a[-xf:].astype(np.float64)
    ref = ref - ref.mean()
    best, best_c = 0, -2.0
    for lag in range(0, cycle_n, 2):
        c = b[lag : lag + xf].astype(np.float64)
        c = c - c.mean()
        v = float(np.dot(ref, c)) / (float(np.linalg.norm(ref)) * float(np.linalg.norm(c)) + 1e-12)
        if v > best_c:
            best_c, best = v, lag
    b = b[best:]
    t = np.linspace(0.0, 1.0, xf, dtype=np.float32)
    cross = a[-xf:] * np.cos(t * np.pi * 0.5) + b[:xf] * np.sin(t * np.pi * 0.5)
    return np.concatenate([a[:-xf], cross, b[xf:]])


def steadiest_start(y: np.ndarray, need: int, sr: int) -> int:
    """Start of the `need`-sample window with the most even level and the lowest crest (as pick_steady_window)"""
    if len(y) <= need:
        return 0
    best, best_s = 0, float("inf")
    step = max(1, (len(y) - need) // 32)
    for pos in range(0, len(y) - need + 1, step):
        seg = y[pos : pos + need]
        r = rms(seg)
        if r < 1e-5:
            continue
        b = np.array([rms(c) for c in np.array_split(seg, 8)])
        s = float(np.std(b) / (np.mean(b) + 1e-9)) * 3.0 + float(np.max(np.abs(seg)) / r) * 0.08
        if s < best_s:
            best_s, best = s, pos
    return best


def make_cycle_loop(y: np.ndarray, sr: int, loop_s: float, xfade_s: float, cycle_s: float) -> tuple[np.ndarray, dict[str, float]]:
    """
    Closes a steady signal into a loop: a whole number of engine cycles long, the tail crossfaded into the head with
    equal-power weights at the lag (within a cycle) where the two correlate best, DC removed, and a 32-sample bridge
    to zero at the wrap (the same closing as port_ac_bank.make_seamless_loop).
    """
    cycle_n = cycle_s * sr
    cycles = max(1, int(round(loop_s / cycle_s)))
    loop_n = int(round(cycles * cycle_n))
    xf_n = int(round(xfade_s * sr))
    search = int(math.ceil(cycle_n)) + 8
    need = loop_n + xf_n + search
    if len(y) < need:
        # too short: shorten the loop by whole cycles, never below 60 % of the asked length
        cycles = int(math.floor((len(y) - xf_n - search) / cycle_n))
        if cycles * cycle_s < 0.6 * loop_s:
            raise ValueError(f"only {len(y) / sr:.2f} s of steady material, need {need / sr:.2f} s")
        loop_n = int(round(cycles * cycle_n))
        need = loop_n + xf_n + search
    start = steadiest_start(y, need, sr)
    y = y[start : start + need].astype(np.float32)
    corr_n = min(4096, xf_n)
    ref = y[:corr_n].astype(np.float64)
    ref = ref - ref.mean()
    half = search // 2
    best, best_c = 0, -2.0
    for d in range(-half, half + 1):
        a = loop_n + half + d
        c = y[a : a + corr_n].astype(np.float64)
        if len(c) < corr_n:
            break
        c = c - c.mean()
        v = float(np.dot(ref, c)) / (float(np.linalg.norm(ref)) * float(np.linalg.norm(c)) + 1e-12)
        if v > best_c:
            best_c, best = v, d
    cut = loop_n + half + best
    # the loop is y[0:cut] with y[cut:cut+xf] folded into its head; its length stays within half a cycle of whole cycles
    z = y[:cut].copy()
    tail = y[cut : cut + xf_n]
    xf_n = min(xf_n, len(tail))
    t = np.linspace(0.0, 1.0, xf_n, dtype=np.float32)
    g_out, g_in = np.cos(t * np.pi * 0.5), np.sin(t * np.pi * 0.5)
    # equal-power weights keep the level of two unrelated signals; tail and head here are partly the same steady
    # tone, in phase, and would swell by up to 3 dB mid-fade. The measured correlation sets how much to take back
    c = max(0.0, min(1.0, best_c))
    comp = 1.0 / np.sqrt(1.0 + 2.0 * c * g_out * g_in)
    z[:xf_n] = (tail[:xf_n] * g_out + z[:xf_n] * g_in) * comp
    z = z - float(np.mean(z))
    # seam measure before the bridge: the step across the wrap against the loop's own sample-to-sample movement
    step = abs(float(z[0]) - float(z[-1]))
    typical = float(np.sqrt(np.mean(np.diff(z.astype(np.float64)) ** 2))) + 1e-12
    bridge = 32
    ramp = np.sin(np.linspace(0.0, np.pi * 0.5, bridge, dtype=np.float32))
    z[:bridge] *= ramp
    z[-bridge:] *= ramp[::-1]
    return z, {"seamCorrelation": round(best_c, 4), "seamStepVsTypical": round(step / typical, 3), "cycles": cycles}


def level_signal(x: np.ndarray, target_rms: float, peak_ceiling: float = 0.92) -> np.ndarray:
    cur = rms(x)
    if cur < 1e-7:
        return x
    y = x * (target_rms / cur)
    if float(np.max(np.abs(y))) > peak_ceiling:
        knee = 0.75
        above = np.maximum(0.0, np.abs(y) - knee)
        y = np.sign(y) * np.minimum(np.abs(y), knee + (peak_ceiling - knee) * np.tanh(above / (peak_ceiling - knee)))
    y[0] = 0.0
    y[-1] = 0.0
    return y.astype(np.float32)


def lufs(x: np.ndarray, sr: int) -> float | None:
    try:
        import pyloudnorm  # optional: only for the report

        return round(float(pyloudnorm.Meter(sr).integrated_loudness(x.astype(np.float64))), 2)
    except Exception:
        return None


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
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-c:a", "libvorbis", "-q:a", str(quality), str(out_path)],
            check=True,
        )
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def residual_drift(y: np.ndarray, sr: int, target_hz: float, rpm_per_hz: float) -> dict[str, float]:
    """Re-tracks a finished loop around its target with a long window: mean offset and spread, in cents"""
    dec = max(1, sr // TRACK_FS)
    yy = signal.resample_poly(y.astype(np.float64), 1, dec)
    fs = sr / dec
    f, t, mag = _stft_mag(yy, fs, 0.25, 32768, 0.05)
    df = f[1] - f[0]
    cents = []
    for h in (1.0, 2.0):
        lo, hi = int(target_hz * h * 0.96 / df), int(math.ceil(target_hz * h * 1.04 / df))
        for k in range(mag.shape[1]):
            p = lo + int(np.argmax(mag[lo : hi + 1, k]))
            a, b, c = (math.log(float(mag[q, k]) + 1e-12) for q in (p - 1, p, p + 1))
            den = a - 2 * b + c
            off = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
            cents.append(1200 * math.log2(((p + max(-0.5, min(0.5, off))) * df / h) / target_hz))
        if h == 1.0:
            first = list(cents)
    arr = np.array(first)
    return {
        "meanCents": round(float(arr.mean()), 2),
        "spreadCents": round(float(arr.std()), 2),
        "measuredRpm": round(target_hz * rpm_per_hz * 2 ** (float(arr.mean()) / 1200), 1),
    }


def line_prominence_db(y: np.ndarray, sr: int, line_hz: float) -> float:
    """How far the flattened engine line stands above the spectrum around it (dB): a sweep left in smears the line"""
    nper = min(len(y), 32768)
    f, pxx = signal.welch(y.astype(np.float64), sr, nperseg=nper, noverlap=nper // 2)
    half = max(line_hz * 0.01, 1.5 * (f[1] - f[0]))
    near = (f >= line_hz - half) & (f <= line_hz + half)
    around = (f >= line_hz * 0.55) & (f <= line_hz * 3.6)
    return round(10 * math.log10(float(pxx[near].max()) / (float(np.median(pxx[around])) + 1e-30)), 1)


def off_order_lines(y: np.ndarray, sr: int, line_hz: float, line_order: float, min_db: float = 9.0) -> tuple[int, float]:
    """
    Order check on a flattened stretch. Every line of an engine sits on a half order, so with the tracked line taken
    as order `line_order`, the strong lines between about half and twice it must fall on multiples of
    line_hz / (2 * line_order). Lines that do not mean the tracker followed another order (the firing line of an
    engine turning half as fast, a half order next to the intended line) and the stretch would be labelled with the
    wrong rpm. Returns how many such lines stand out and the level of the strongest against the tracked line (dB).
    """
    nper = min(len(y), 32768)
    f, pxx = signal.welch(y.astype(np.float64), sr, nperseg=nper, noverlap=nper // 2)
    ldb = 10 * np.log10(pxx + 1e-30)
    df = f[1] - f[0]
    band = (f >= line_hz * 0.55) & (f <= line_hz * 1.95)
    floor = float(np.median(ldb[band]))
    half = max(line_hz * 0.01, 1.5 * df)
    line_db = float(ldb[(f >= line_hz - half) & (f <= line_hz + half)].max())
    peaks, _ = signal.find_peaks(np.where(band, ldb, -300.0), height=floor + min_db, distance=max(2, int(line_hz * 0.03 / df)))
    step = line_hz / (2.0 * line_order)
    count, worst = 0, -99.0
    for k in peaks:
        r = f[k] / step
        if abs(r - round(r)) > 0.12 and ldb[k] >= line_db - 14.0:
            count += 1
            worst = max(worst, float(ldb[k]) - line_db)
    return count, worst


# --------------------------------------------------------------------------------------------------------------------
# Builder
# --------------------------------------------------------------------------------------------------------------------


class Builder:
    def __init__(self, recipe: dict[str, Any], recipe_dir: Path, ffmpeg: str) -> None:
        self.r = recipe
        self.ffmpeg = ffmpeg
        self.src_dir = self._path(recipe.get("sourceDir", "."), recipe_dir)
        self.out_dir = self._path(recipe["outDir"], REPO_ROOT)
        self.eng = recipe["engine"]
        self.rpm_per_hz = float(self.eng["rpmPerHz"])
        # engine cycle (two revolutions) in periods of the tracked line
        self.loop_s = float(recipe.get("loopSeconds", 2.0))
        self.xfade_s = float(recipe.get("xfadeSeconds", 0.35))
        self.audio: dict[str, tuple[np.ndarray, float]] = {}
        self.tracks: dict[str, Track] = {}
        self.cache_dir = self._path(recipe.get("cacheDir", "artifacts/soundbank_cache"), REPO_ROOT)

    @staticmethod
    def _path(p: str, base: Path) -> Path:
        q = Path(p).expanduser()
        return q if q.is_absolute() else (base / q)

    def cycle_s(self, rpm: float) -> float:
        return 120.0 / rpm

    def source_cfg(self, name: str) -> dict[str, Any]:
        return self.r["sources"][name]

    def load(self, name: str) -> tuple[np.ndarray, float]:
        """The source's analysed range as mono float32 at 48 kHz, and the time its first sample has in the file"""
        if name not in self.audio:
            cfg = self.source_cfg(name)
            path = self.src_dir / cfg["file"]
            info = sf.info(str(path))
            t0, t1 = cfg.get("range", [0.0, info.duration])
            x, sr = sf.read(str(path), start=int(t0 * info.samplerate), stop=int(min(t1, info.duration) * info.samplerate), dtype="float32")
            if x.ndim > 1:
                x = x.mean(axis=1)
            if sr != RATE:
                x = signal.resample_poly(x, RATE, sr).astype(np.float32)
            self.audio[name] = (x, float(t0))
        return self.audio[name]

    def track(self, name: str) -> Track:
        if name not in self.tracks:
            cfg = self.source_cfg(name)
            x, t0 = self.load(name)
            rpm_min = float(cfg.get("rpmMin", self.eng["rpmMin"]))
            rpm_max = float(cfg.get("rpmMax", self.eng["rpmMax"]))
            per_hz = float(cfg.get("rpmPerHz", self.rpm_per_hz))
            key = f"{name}_{cfg['file']}_{t0:.2f}_{len(x)}_{rpm_min:.0f}_{rpm_max:.0f}_{per_hz:.0f}.npz".replace("/", "_")
            cache = self.cache_dir / key
            if cache.exists():
                d = np.load(cache)
                self.tracks[name] = Track(d["t"], d["hz"], d["hnr"], d["level"], d["hf"], d["shift"], d["slope"], d["jump"], per_hz)
            else:
                print(f"  tracking {name} ({len(x) / RATE:.0f} s)...", flush=True)
                tr = track_engine_line(x, RATE, per_hz, rpm_min, rpm_max, t_offset=t0)
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                np.savez(cache, t=tr.t, hz=tr.hz, hnr=tr.hnr, level=tr.level, hf=tr.hf, shift=tr.shift, slope=tr.slope, jump=tr.jump)
                self.tracks[name] = tr
        return self.tracks[name]

    def cut(self, name: str, t0: float, t1: float) -> np.ndarray:
        x, off = self.load(name)
        return x[max(0, int((t0 - off) * RATE)) : max(0, int((t1 - off) * RATE))]

    # -- engine bands ---------------------------------------------------------------------------------------------

    def build_band(self, band: dict[str, Any]) -> tuple[np.ndarray, dict[str, Any]]:
        sel = self.r.get("selection", {})
        target = float(band["rpm"])
        target_hz = target / self.rpm_per_hz
        tol = float(band.get("tolerance", sel.get("tolerance", 0.12)))
        layer = band["layer"]
        cycle_n = int(round(self.cycle_s(target) * RATE))
        need_s = self.loop_s + self.xfade_s + self.cycle_s(target) + 0.05
        pieces: list[Piece] = []
        if "windows" in band:
            for w in band["windows"]:
                tr = self.track(w["source"])
                k0, k1 = np.searchsorted(tr.t, w["t"][0]), np.searchsorted(tr.t, w["t"][1]) - 1
                pieces.append(Piece(w["source"], w["t"][0], w["t"][1], float(tr.rpm[k0]), float(tr.rpm[k1]), 1.0, float(tr.hnr[k0:k1].mean())))
        else:
            for name in band["sources"]:
                pieces += find_pieces(
                    name,
                    self.track(name),
                    layer,
                    float(band.get("pickRpm", target)),
                    tol,
                    float(band.get("minPieceS", sel.get("minPieceS", 0.4))),
                    float(sel.get("onSlope", -0.01)),
                    float(sel.get("offSlope", -0.035)),
                    float(sel.get("maxHfBurst", 2.6)),
                )
            pieces.sort(key=lambda p: -p.score)
        if not pieces:
            raise ValueError(f"no stretch of {layer}-load running within {tol:.0%} of {target:.0f} rpm")

        notch_cfg = self.r.get("notch", {})
        use_notch = bool(band.get("notch", notch_cfg.get("enabled", False)))
        base_hz = target / 120.0  # half-order spacing
        # Every candidate is flattened first and judged by what the flattening gives: a stretch whose line was tracked
        # right and holds little else comes out with a tall narrow line; one tracked wrong, or buried in other noise,
        # does not, whatever it looked like before
        min_line_db = float(band.get("minLineDb", sel.get("minLineDb", 14)))
        flats: list[tuple[float, Piece, np.ndarray]] = []
        rejected_off_order = 0
        for p in pieces[: int(band.get("maxCandidates", sel.get("maxCandidates", 24)))]:
            raw = self.cut(p.source, p.t0, p.t1)
            if len(raw) < int(0.3 * RATE):
                continue
            tr = self.track(p.source)
            flat = flatten_envelope(desweep(raw, RATE, p.t0, tr, target / tr.rpm_per_hz), RATE)
            edge = int(0.03 * RATE)
            flat = flat[edge:-edge] if len(flat) > 4 * edge else flat
            prom = line_prominence_db(flat, RATE, target / tr.rpm_per_hz)
            if "windows" not in band and band.get("orderCheck", sel.get("orderCheck", True)):
                n_off, worst = off_order_lines(flat, RATE, target / tr.rpm_per_hz, 60.0 / tr.rpm_per_hz)
                if n_off >= 2 or worst > -6.0:
                    rejected_off_order += 1
                    continue
            if prom >= min_line_db or "windows" in band:
                flats.append((prom + 3.0 * min(1.0, len(flat) / RATE / need_s), p, flat))
        if not flats:
            raise ValueError(f"no stretch near {target:.0f} rpm ({layer}) flattens to a clear line (>= {min_line_db:.0f} dB)")
        flats.sort(key=lambda a: -a[0])
        joined: np.ndarray | None = None
        used: list[dict[str, Any]] = []
        notched: list[float] = []
        for score, p, flat in flats[: int(band.get("maxPieces", sel.get("maxPieces", 6)))]:
            if use_notch:
                lines = find_whine_lines(flat, RATE, base_hz, float(notch_cfg.get("minHz", 1600)), int(notch_cfg.get("maxLines", 3)), float(notch_cfg.get("minDb", 10)))
                if lines:
                    flat = notch_lines(flat, RATE, lines, float(notch_cfg.get("q", 18)))
                    notched += [round(hz) for hz, _ in lines]
            if joined is None:
                joined = flat
            else:
                # each piece at the level of the first, so the joins do not step
                flat = flat * (rms(joined) / (rms(flat) + 1e-9))
                joined = align_and_join(joined, flat, RATE, cycle_n)
            used.append({"source": p.source, "t": [round(p.t0, 2), round(p.t1, 2)], "rpm": [round(p.rpm0), round(p.rpm1)], "harmonicShare": round(p.hnr, 3), "lineDb": round(score - 3.0 * min(1.0, len(flat) / RATE / need_s), 1)})
            if len(joined) / RATE >= need_s:
                break
        assert joined is not None
        eq = band.get("eq")
        if eq:
            joined = apply_eq(joined, eq)
        loop, seam = make_cycle_loop(joined, RATE, self.loop_s, self.xfade_s, self.cycle_s(target))
        lo, hi = ON_RMS if layer == "on" else OFF_RMS
        span = max(1.0, float(self.eng["rpmMax"]) - float(self.eng["rpmMin"]))
        frac = min(1.0, max(0.0, (target - float(self.eng["rpmMin"])) / span))
        target_rms = float(band.get("rms", lo + (hi - lo) * frac))
        loop = level_signal(loop, target_rms)
        line_per_hz = self.track(used[0]["source"]).rpm_per_hz
        drift = residual_drift(loop, RATE, target / line_per_hz, line_per_hz)
        info = {
            "id": band["id"],
            "view": band["view"],
            "layer": layer,
            "targetRpm": target,
            "pieces": used,
            "sourceRpmSpan": [min(min(u["rpm"]) for u in used), max(max(u["rpm"]) for u in used)],
            "flattened": drift,
            "lineProminenceDb": line_prominence_db(loop, RATE, target / line_per_hz),
            "seam": seam,
            "seconds": round(len(loop) / RATE, 3),
            "rms": round(rms(loop), 4),
            "lufs": lufs(loop, RATE),
            "notchedHz": sorted(set(notched)),
            "candidatesRejectedOffOrder": rejected_off_order,
            "harmonicShare": round(float(np.mean([u["harmonicShare"] for u in used])), 3),
        }
        return loop, info


def apply_eq(y: np.ndarray, eq: dict[str, Any]) -> np.ndarray:
    out = y.astype(np.float64)
    if "highpassHz" in eq:
        out = signal.sosfiltfilt(signal.butter(2, eq["highpassHz"], btype="high", fs=RATE, output="sos"), out)
    if "lowpassHz" in eq:
        out = signal.sosfiltfilt(signal.butter(2, eq["lowpassHz"], btype="low", fs=RATE, output="sos"), out)
    return out.astype(np.float32)


def prepare_oneshot(x: np.ndarray, max_s: float, target_peak: float = 0.78, fade_in_s: float = 0.004, fade_out_s: float = 0.03) -> np.ndarray:
    x = x[: int(max_s * RATE)].astype(np.float32).copy()
    fi, fo = min(int(fade_in_s * RATE), len(x) // 4), min(int(fade_out_s * RATE), len(x) // 3)
    if fi:
        x[:fi] *= np.linspace(0.0, 1.0, fi, dtype=np.float32)
    if fo:
        x[-fo:] *= np.linspace(1.0, 0.0, fo, dtype=np.float32)
    pk = float(np.max(np.abs(x))) if len(x) else 0.0
    return (x * (target_peak / pk)).astype(np.float32) if pk > 1e-6 else x


def build_oneshots(b: Builder, loops: dict[str, np.ndarray]) -> tuple[list[tuple[str, str, np.ndarray]], list[dict[str, Any]]]:
    """
    One-shots named by the recipe: cut around tracked gear changes (`from: "upshift" | "downshift"`), around
    broadband bursts on the overrun (`from: "burst"`), at a given time (`from: "time"`), or derived from a finished
    loop (`from: "loop"`: a gated stutter for the limiter, enveloped slices for pops).
    """
    out: list[tuple[str, str, np.ndarray]] = []
    report: list[dict[str, Any]] = []
    for spec in b.r.get("oneshots", []):
        role, kind = spec["role"], spec["from"]
        count = int(spec.get("count", 1))
        length = float(spec.get("seconds", 0.18))
        pre = float(spec.get("preS", 0.03))
        made: list[tuple[np.ndarray, dict[str, Any]]] = []
        if kind in ("upshift", "downshift"):
            cands = []
            for name in spec["sources"]:
                tr = b.track(name)
                want = 1 if kind == "upshift" else -1
                ratio_lo, ratio_hi = spec.get("ratio", [1.09, 1.3])
                for k in np.nonzero(tr.shift == want)[0]:
                    lo, hi = max(0, k - 30), min(len(tr.t), k + 30)
                    rpm_before = float(np.median(tr.rpm[max(0, k - 12) : max(1, k - 5)]))
                    if rpm_before < float(spec.get("minRpm", 0)):
                        continue
                    # a real change: a step the size of a gear, and no opposite step within 0.4 s (a pair of
                    # opposite steps is the tracker leaving the line and coming back)
                    if not (ratio_lo <= math.exp(abs(float(tr.jump[k]))) <= ratio_hi):
                        continue
                    if np.any(tr.shift[max(0, k - 40) : k + 40] == -want):
                        continue
                    # a clean change: strong harmonics either side, no other burst around it
                    q = float(tr.hnr[lo:hi].mean()) - 0.05 * float(np.max(tr.hf[lo:hi]))
                    cands.append((q, name, float(tr.t[k]), rpm_before))
            cands.sort(key=lambda c: -c[0])
            for q, name, t, rpm_before in cands[:count]:
                seg = b.cut(name, t - pre, t - pre + length)
                made.append((seg, {"source": name, "t": round(t, 2), "rpmBefore": round(rpm_before)}))
        elif kind == "burst":
            cands = []
            for name in spec["sources"]:
                tr = b.track(name)
                peaks, props = signal.find_peaks(tr.hf, height=float(spec.get("minBurst", 3.0)), distance=20)
                for p, h in zip(peaks, props["peak_heights"]):
                    sl = tr.slope[max(0, p - 15) : p + 1]
                    falling = np.nanmean(sl) < -0.02 if np.isfinite(sl).any() else False
                    if spec.get("overrunOnly", True) and not falling:
                        continue
                    if tr.level[p] < float(np.percentile(tr.level, 30)):
                        continue
                    cands.append((float(h), name, float(tr.t[p])))
            cands.sort(key=lambda c: -c[0])
            for h, name, t in cands[:count]:
                seg = b.cut(name, t - pre, t - pre + length)
                made.append((seg, {"source": name, "t": round(t, 2), "burst": round(h, 2)}))
        elif kind == "time":
            for w in spec["at"]:
                seg = b.cut(w["source"], w["t"], w["t"] + length)
                made.append((seg, {"source": w["source"], "t": w["t"]}))
        elif kind == "loop":
            src = loops.get(spec["loop"])
            if src is None:
                report.append({"role": role, "skipped": f"loop {spec['loop']} was not built"})
                continue
            for i in range(count):
                n = int(length * RATE)
                pos = (i * 7919 * 13) % max(1, len(src) - n)
                seg = np.resize(src[pos:], n).astype(np.float32).copy()
                t = np.arange(n, dtype=np.float32) / RATE
                if spec.get("shape") == "stutter":
                    hz = float(spec.get("stutterHz", 14.0))
                    seg *= 0.12 + 0.88 * np.power(0.5 + 0.5 * np.cos(2 * np.pi * hz * t), 1.8)
                else:
                    seg *= np.sin(np.minimum(1.0, t / 0.012) * np.pi * 0.5) * np.exp(-t * float(spec.get("decay", 22.0)))
                made.append((seg, {"derivedFromLoop": spec["loop"], "shape": spec.get("shape", "pop")}))
        for i, (seg, meta) in enumerate(made):
            if len(seg) < int(0.03 * RATE):
                continue
            if "eq" in spec:
                seg = apply_eq(seg, spec["eq"])
            if spec.get("decayEnvelope"):
                t = np.arange(len(seg), dtype=np.float32) / RATE
                seg = seg * np.exp(-np.maximum(0.0, t - pre) * float(spec["decayEnvelope"]))
            shot = prepare_oneshot(seg, length, float(spec.get("peak", 0.78)))
            fn = f"oneshot_{role}{'' if count == 1 else f'_{i + 1}'}.ogg"
            out.append((role, fn, shot))
            report.append({"role": role, "file": fn, "from": kind, **meta, "seconds": round(len(shot) / RATE, 3)})
        if not made:
            report.append({"role": role, "skipped": f"nothing found ({kind})"})
    return out, report


def synth_whine(spec: dict[str, Any], seconds: float) -> np.ndarray:
    """
    A placeholder electric-machine whine where no recording isolates one: a carrier and its partials (`partials`:
    [[multiple, gain], ...]) with a slow shallow wobble and a little band noise around the carrier, an exact number
    of carrier cycles long so it loops as it is. Marked as synthetic in the report.
    """
    f0 = float(spec["carrierHz"])
    n = int(round(round(seconds * f0) / f0 * RATE))
    t = np.arange(n) / RATE
    rng = np.random.default_rng(int(spec.get("seed", 7)))
    wob_hz = round(float(spec.get("wobbleHz", 5.0)) * n / RATE) / (n / RATE)  # whole cycles in the loop
    phase_wob = float(spec.get("wobbleDepth", 0.6)) * np.sin(2 * np.pi * wob_hz * t)
    y = np.zeros(n)
    for mult, gain in spec.get("partials", [[1, 1.0], [2, 0.35], [3, 0.12]]):
        y += gain * np.sin(2 * np.pi * f0 * mult * t + mult * phase_wob + rng.uniform(0, 2 * np.pi))
    noise = rng.standard_normal(n)
    spec_n = np.fft.rfft(noise)
    fr = np.fft.rfftfreq(n, 1 / RATE)
    spec_n *= np.exp(-0.5 * ((fr - f0) / (0.08 * f0)) ** 2)  # circular in the FFT, so the noise loops too
    noise = np.fft.irfft(spec_n, n)
    y += float(spec.get("noise", 0.25)) * noise / (np.std(noise) + 1e-12)
    return y.astype(np.float32)


def build_aux_loop(b: Builder, spec: dict[str, Any], loops_raw: dict[str, np.ndarray]) -> tuple[np.ndarray, dict[str, Any]]:
    """
    A whine loop (gearbox or electric machine): a window of a source (or the flattened material of an engine band,
    `fromBand`) band-passed to where the whine lives, optionally de-swept along its own line (`line: {minHz, maxHz}`),
    closed into a loop and levelled to `rms`.
    """
    info: dict[str, Any] = {"id": spec["id"]}
    if "synth" in spec:
        loop = level_signal(synth_whine(spec["synth"], float(spec.get("loopSeconds", b.loop_s))), float(spec["rms"]))
        info.update({"synthetic": True, "carrierHz": spec["synth"]["carrierHz"], "seconds": round(len(loop) / RATE, 3), "rms": round(rms(loop), 4), "seam": {"seamCorrelation": 1.0}})
        return loop, info
    if "fromBand" in spec:
        y = loops_raw[spec["fromBand"]]
        info["fromBand"] = spec["fromBand"]
        cyc = 120.0 / float(spec["bandRpm"])
    else:
        t0, t1 = spec["t"]
        y = b.cut(spec["source"], t0, t1)
        info.update({"source": spec["source"], "t": [t0, t1]})
        cyc = 0.02
        if spec.get("engineLine"):
            # whine in one gear follows the revs: flatten the stretch along the engine line to its median
            tr = b.track(spec["source"])
            k0, k1 = np.searchsorted(tr.t, t0), np.searchsorted(tr.t, t1)
            med = float(np.median(tr.hz[k0:k1]))
            info["engineRpm"] = round(med * tr.rpm_per_hz)
            y = flatten_envelope(desweep(y, RATE, t0, tr, med), RATE)
            cyc = 120.0 / (med * tr.rpm_per_hz)
        if "line" in spec:
            ln = spec["line"]
            tr = track_engine_line(y, RATE, 1.0, ln["minHz"], ln["maxHz"], t_offset=t0, win_s=0.06, jump_cost=30.0)
            target = float(ln.get("targetHz", np.median(tr.hz)))
            info["lineHz"] = [round(float(np.percentile(tr.hz, 5))), round(float(np.percentile(tr.hz, 95)))]
            info["targetHz"] = round(target, 1)
            y = desweep(y, RATE, t0, tr, target)
            y = flatten_envelope(y, RATE, 8.0)
            cyc = 8.0 / target
    lo, hi = spec["bandHz"]
    sos = signal.butter(3, [lo, hi], btype="band", fs=RATE, output="sos")
    broad = signal.sosfiltfilt(sos, y.astype(np.float64))
    if spec.get("whineLines") and cyc != 0.02:
        # the stationary lines in the band that are not engine orders are the gear mesh: keep those narrow bands and
        # only a share of the hiss between them
        lines = [ln for ln in find_whine_lines(y, RATE, 1.0 / cyc, lo, int(spec["whineLines"]), float(spec.get("minDb", 6))) if ln[0] <= hi]
        info["whineHz"] = [round(hz) for hz, _ in lines]
        tonal = np.zeros(len(y))
        for hz, _ in lines:
            band = signal.butter(2, [hz * 0.985, hz * 1.015], btype="band", fs=RATE, output="sos")
            tonal += signal.sosfiltfilt(band, y.astype(np.float64))
        if lines:
            broad = tonal + float(spec.get("hissShare", 0.3)) * broad * (rms(tonal) / (rms(broad) + 1e-12))
    y = broad.astype(np.float32)
    loop, seam = make_cycle_loop(y, RATE, float(spec.get("loopSeconds", b.loop_s)), min(b.xfade_s, 0.25), cyc)
    loop = level_signal(loop, float(spec["rms"]))
    info.update({"seam": seam, "seconds": round(len(loop) / RATE, 3), "rms": round(rms(loop), 4)})
    return loop, info


def run_build(b: Builder, only: str | None) -> dict[str, Any]:
    r = b.r
    manifest: dict[str, Any] = {
        "source": r.get("sourceLabel", "custom recordings"),
        "sampleRate": RATE,
        "loopSeconds": b.loop_s,
        "engine": {"ext": [], "int": []},
        "turbo": [],
        "transmission": [],
        "oneshots": [],
    }
    for key in ("throttleCurve", "lift", "limiterRetriggerS", "shift", "driveline", "loadFilter", "viewTone"):
        if key in r.get("manifest", {}):
            manifest[key] = r["manifest"][key]
    report: dict[str, Any] = {"bank": r.get("bankId"), "engine": [], "skipped": [], "auxiliary": [], "oneshots": []}
    report["sources"] = {name: analyze_report(name, b.track(name)) for name in r["sources"] if r["sources"][name].get("engine", True)}
    b.out_dir.mkdir(parents=True, exist_ok=True)
    loops: dict[str, np.ndarray] = {}
    for band in r["bands"]:
        if only and band["id"] != only:
            continue
        try:
            loop, info = b.build_band(band)
        except (ValueError, AssertionError) as e:
            print(f"  SKIP {band['id']}: {e}")
            report["skipped"].append({"id": band["id"], "reason": str(e)})
            continue
        loops[band["id"]] = loop
        for view in band.get("views", [band["view"]]):
            fn = f"engine_{view}_{band['layer']}_{int(band['rpm'])}.ogg"
            # a band recorded for one view can stand in for the other through an EQ (a trackside idle, low-passed,
            # for the cockpit) where no recording of that view holds those revs
            heard = loop if view == band["view"] else level_signal(apply_eq(loop, band.get("otherViewEq", {})), rms(loop))
            encode_ogg(b.ffmpeg, heard, b.out_dir / fn)
            manifest["engine"][view].append({"file": fn, "layer": band["layer"], "rpm": int(band["rpm"]), "channels": 1, "rms": round(rms(heard), 4)})
        report["engine"].append(info)
        d = info["flattened"]
        print(
            f"  {band['id']:<16} {len(info['pieces'])} piece(s) {info['sourceRpmSpan'][0]}-{info['sourceRpmSpan'][1]} rpm -> "
            f"{d['measuredRpm']:.0f} rpm ({d['meanCents']:+.1f} c, spread {d['spreadCents']:.1f} c), seam corr {info['seam']['seamCorrelation']:.3f}, "
            f"line +{info['lineProminenceDb']:.0f} dB, {info['candidatesRejectedOffOrder']} off-order rejected"
        )
    if only:
        return report
    for view in ("ext", "int"):
        manifest["engine"][view].sort(key=lambda e: (e["layer"], e["rpm"]))

    for spec in r.get("transmission", []):
        try:
            loop, info = build_aux_loop(b, spec, loops)
        except (ValueError, KeyError) as e:
            report["skipped"].append({"id": spec["id"], "reason": str(e)})
            print(f"  SKIP {spec['id']}: {e}")
            continue
        fn = f"trans_{spec['layer']}_{int(spec['drivetrainSpeed'])}.ogg"
        encode_ogg(b.ffmpeg, loop, b.out_dir / fn)
        manifest["transmission"].append({"file": fn, "layer": spec["layer"], "drivetrainSpeed": spec["drivetrainSpeed"], "channels": 1, "rms": round(rms(loop), 4)})
        report["auxiliary"].append(info)
        print(f"  {spec['id']:<16} seam corr {info['seam']['seamCorrelation']:.3f}")
    if "mgu" in r:
        spec = r["mgu"]
        try:
            loop, info = build_aux_loop(b, spec, loops)
            encode_ogg(b.ffmpeg, loop, b.out_dir / "mgu.ogg")
            manifest["mgu"] = {"file": "mgu.ogg", "channels": 1, "rms": round(rms(loop), 4), **spec["manifest"]}
            report["auxiliary"].append(info)
            what = "synthetic" if info.get("synthetic") else f"line {info.get('lineHz')} Hz"
            print(f"  {spec['id']:<16} {what}, seam corr {info['seam']['seamCorrelation']:.3f}")
        except (ValueError, KeyError) as e:
            report["skipped"].append({"id": spec["id"], "reason": str(e)})
            print(f"  SKIP {spec['id']}: {e}")

    shots, shot_report = build_oneshots(b, loops)
    for role, fn, shot in shots:
        encode_ogg(b.ffmpeg, shot, b.out_dir / fn)
        manifest["oneshots"].append({"file": fn, "role": role, "channels": 1, "seconds": round(len(shot) / RATE, 3), "peak": round(float(np.max(np.abs(shot))), 3)})
    report["oneshots"] = shot_report

    # files of an earlier build that this one no longer writes
    keep = {"manifest.json"} | {e["file"] for v in manifest["engine"].values() for e in v} | {e["file"] for e in manifest["transmission"]} | {e["file"] for e in manifest["oneshots"]}
    if "mgu" in manifest:
        keep.add(manifest["mgu"]["file"])
    for p in b.out_dir.glob("*.ogg"):
        if p.name not in keep:
            p.unlink()
    (b.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    total = sum(p.stat().st_size for p in b.out_dir.iterdir() if p.is_file())
    report["bankBytes"] = total
    print(f"  bank: {len(keep) - 1} files, {total / 1048576:.2f} MB -> {b.out_dir}")
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recipe", required=True, help="recipe JSON (sources, engine line, bands, one-shots)")
    ap.add_argument("--analyze", action="store_true", help="track every source and print its rpm statistics and gear-change ratios")
    ap.add_argument("--dump", metavar="SOURCE:T0:T1", help="print the tracked rpm of a source between two times (every 0.1 s)")
    ap.add_argument("--only", help="build one engine band and stop (no manifest written)")
    ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", FFMPEG_DEFAULT))
    args = ap.parse_args()

    recipe_path = Path(args.recipe).resolve()
    recipe = json.loads(recipe_path.read_text())
    b = Builder(recipe, recipe_path.parent, args.ffmpeg)

    if args.dump:
        name, t0, t1 = args.dump.split(":")
        tr = b.track(name)
        for k in range(int(np.searchsorted(tr.t, float(t0))), int(np.searchsorted(tr.t, float(t1))), 10):
            flag = {1: " UP", -1: " DOWN", 0: ""}[int(np.sign(tr.shift[max(0, k - 5) : k + 5].sum()))]
            print(f"{tr.t[k]:8.2f}s {tr.rpm[k]:7.0f} rpm  harm {tr.hnr[k]:.2f}  slope {tr.slope[k]:+.3f}  hf {tr.hf[k]:.1f}  lvl {db(tr.level[k]):6.1f} dB{flag}")
        return
    if args.analyze:
        for name, cfg in recipe["sources"].items():
            if not cfg.get("engine", True):
                continue
            print(json.dumps(analyze_report(name, b.track(name)), indent=1))
        return

    report = run_build(b, args.only)
    if not args.only and recipe.get("reportPath"):
        rp = b._path(recipe["reportPath"], REPO_ROOT)
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text(json.dumps(report, indent=1) + "\n")
        print(f"  report -> {rp}")


if __name__ == "__main__":
    sys.exit(main())
