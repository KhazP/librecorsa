#!/usr/bin/env python3
"""
Port Assetto Corsa FMOD Studio (.bank / FSB5) car sound mods into LibreCorsa's Web Audio bank format.

Decodes embedded FSB5 audio streams (PCM16 or FMOD Vorbis) directly without requiring the Windows
FMOD runtime, inspects FMOD Studio PMLB parameter layouts and INST autopitch reference RPMs when
requested, resamples each loop to match its FMOD autopitch root at the manifest anchor RPM, creates
click-free equal-power crossfaded loops, levels RMS across the RPM range, and encodes Ogg Vorbis
via /opt/homebrew/bin/ffmpeg.

Usage:
  uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 python -P scripts/audio/port_ac_bank.py --list "/path/to/car.bank"
  uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 python -P scripts/audio/port_ac_bank.py --car w17
  uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 python -P scripts/audio/port_ac_bank.py --all
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any

import fsb5
import numpy as np
from scipy import signal

RATE = 48000
LOOP_S = 2.4
XFADE_S = 0.25
FFMPEG_DEFAULT = "/opt/homebrew/bin/ffmpeg"

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).resolve().parent / "car_configs.json"


def load_fsbs_from_bank(bank_path: str | Path) -> tuple[list[tuple[fsb5.FSB5, Any]], bytes]:
    """Load all FSB5 containers embedded in an FMOD .bank file and return [(fsb, sample), ...] plus raw bytes."""
    raw = Path(bank_path).read_bytes()
    items: list[tuple[fsb5.FSB5, Any]] = []
    pos = 0
    while True:
        idx = raw.find(b"FSB5", pos)
        if idx < 0:
            break
        pos = idx + 4
        try:
            f = fsb5.FSB5(raw[idx:])
            for s in f.samples:
                items.append((f, s))
        except Exception:
            continue
    if not items:
        raise ValueError(f"No valid FSB5 container found inside {bank_path}")
    return items, raw


def decode_sample(
    fsb: fsb5.FSB5, sample: Any, target_sr: int = RATE, ffmpeg: str = FFMPEG_DEFAULT
) -> tuple[np.ndarray, int]:
    """Decode a single FSB5 subsound (PCM16 WAV or rebuilt Ogg Vorbis) to float32 (frames, channels) at target_sr."""
    rebuilt = bytes(fsb.rebuild_sample(sample))
    ch = int(sample.channels)
    sr = int(sample.frequency)

    if rebuilt[:4] == b"OggS":
        proc = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-f",
                "f32le",
                "-acodec",
                "pcm_f32le",
                "-ar",
                str(target_sr),
                "-ac",
                str(ch),
                "pipe:1",
            ],
            input=rebuilt,
            capture_output=True,
            check=True,
        )
        arr = np.frombuffer(proc.stdout, dtype="<f4").copy()
        frames = len(arr) // ch
        return arr[: frames * ch].reshape(frames, ch), target_sr

    data_idx = rebuilt.find(b"data")
    if data_idx < 0:
        raise ValueError(f"Rebuilt WAV for {sample.name} missing data chunk")
    data_size = struct.unpack("<I", rebuilt[data_idx + 4 : data_idx + 8])[0]
    pcm_offset = data_idx + 8
    pcm_bytes = rebuilt[pcm_offset : pcm_offset + data_size]
    arr = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    frames = len(arr) // ch
    x = arr[: frames * ch].reshape(frames, ch)
    if sr != target_sr and len(x) > 0:
        g = np.gcd(sr, target_sr)
        x = signal.resample_poly(x, target_sr // g, sr // g, axis=0).astype(np.float32)
        sr = target_sr
    return x, sr


def list_bank_samples(bank_path: str | Path) -> list[dict[str, Any]]:
    """List all subsounds across all FSB5 containers in a .bank file."""
    items, _ = load_fsbs_from_bank(bank_path)
    meta_list: list[dict[str, Any]] = []
    for idx, (fsb, s) in enumerate(items):
        sr = int(s.frequency)
        frames = int(s.samples)
        meta_list.append(
            {
                "index": idx,
                "name": s.name,
                "rate": sr,
                "channels": int(s.channels),
                "frames": frames,
                "seconds": round(frames / max(1, sr), 3),
                "mode": int(fsb.header.mode),
            }
        )
    return meta_list


def inspect_fmod_pmlb(bank_path: str | Path) -> list[dict[str, Any]]:
    """Extract FMOD Studio PMLB parameter intervals and INST autopitch reference RPMs from RIFF chunks."""
    items, raw = load_fsbs_from_bank(bank_path)
    names = [s.name for _, s in items]

    pos = 0
    end = len(raw)
    riff_chunks: dict[str, list[tuple[int, bytes]]] = {}

    def walk(b: bytes, e: int) -> None:
        p = b
        while p + 8 <= e:
            cid = raw[p : p + 4].decode("latin1", errors="replace")
            sz = struct.unpack("<I", raw[p + 4 : p + 8])[0]
            if cid in ("RIFF", "LIST"):
                walk(p + 12, p + 8 + sz)
            else:
                riff_chunks.setdefault(cid, []).append((p, raw[p + 8 : p + 8 + sz]))
            p += 8 + sz + (sz & 1)

    walk(pos, end)

    inst_map: dict[bytes, tuple[float, list[str]]] = {}
    for _, ldata in riff_chunks.get("LIST", []):
        pass

    # Scan raw for each PMLB entry's instrument GUID
    results: list[dict[str, Any]] = []
    for p_off, p in riff_chunks.get("PMLB", []):
        if len(p) < 52:
            continue
        cnt = struct.unpack("<H", p[48:50])[0] >> 1
        stride = struct.unpack("<H", p[50:52])[0]
        if stride != 24 or 52 + cnt * 24 > len(p):
            continue
        entries = []
        for i in range(cnt):
            base = 52 + i * 24
            iguid = p[base : base + 16]
            span, start = struct.unpack("<ff", p[base + 16 : base + 24])
            # Find instrument chunk containing iguid
            loc = 0
            root_rpm = 0.0
            wav_names: list[str] = []
            while True:
                idx = raw.find(iguid, loc)
                if idx < 0:
                    break
                loc = idx + 1
                if abs(idx - (p_off + 8 + base)) < 8:
                    continue
                # Check if inside an INST/LIST block
                window = raw[max(0, idx - 64) : min(len(raw), idx + 512)]
                pguid_pos = window.find(p[0:16])
                if pguid_pos >= 0 and pguid_pos + 20 <= len(window):
                    root_rpm = struct.unpack("<f", window[pguid_pos + 16 : pguid_pos + 20])[0]
                wpos = 0
                while True:
                    w = window.find(b"WAV ", wpos)
                    if w < 0 or w + 14 > len(window):
                        break
                    wpos = w + 4
                    wsz = struct.unpack("<I", window[w + 4 : w + 8])[0]
                    if wsz == 6:
                        sidx = struct.unpack("<H", window[w + 12 : w + 14])[0]
                        if sidx < len(names):
                            wav_names.append(f"{names[sidx]}#{sidx}")
            entries.append(
                {
                    "start": round(start, 1),
                    "end": round(start + span, 1),
                    "rootRpm": round(root_rpm, 1),
                    "samples": wav_names,
                }
            )
        if entries and entries[0]["end"] > 500:
            results.append({"pmlbGuid": p[0:4].hex(), "entries": entries})
    return results


def rms(x: np.ndarray) -> float:
    if len(x) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def is_effectively_mono(x: np.ndarray, threshold: float = 0.03) -> bool:
    if x.ndim == 1 or x.shape[1] < 2:
        return True
    diff_rms = rms(x[:, 0] - x[:, 1])
    sig_rms = max(1e-6, rms(x))
    return diff_rms < threshold * sig_rms


def ensure_2d(x: np.ndarray) -> np.ndarray:
    if x.ndim == 1:
        return x[:, None]
    return x


def pitch_resample(x: np.ndarray, anchor_rpm: float, root_rpm: float) -> np.ndarray:
    """
    Resample audio captured at root_rpm so that playing it at 1.0x corresponds to anchor_rpm.
    When LoopGrid plays at rate = rpm / anchor_rpm, the resulting pitch is rpm / root_rpm.
    """
    if root_rpm <= 0 or anchor_rpm <= 0 or abs(anchor_rpm - root_rpm) / root_rpm < 0.005:
        return x
    # Clamp extreme pitch shifts during offline bake to [0.58, 1.65] so formants stay natural
    ratio = float(np.clip(anchor_rpm / root_rpm, 0.58, 1.65))
    new_len = max(64, int(round(len(x) / ratio)))
    old_idx = np.linspace(0.0, len(x) - 1, new_len, dtype=np.float64)
    i0 = np.floor(old_idx).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(x) - 1)
    frac = (old_idx - i0)[:, None].astype(np.float32)
    return (x[i0] * (1.0 - frac) + x[i1] * frac).astype(np.float32)


def pick_steady_window(x: np.ndarray, need_frames: int) -> np.ndarray:
    """
    Select the steadiest window of length need_frames from x, avoiding start/end fade-ins or transients.
    If x is shorter than need_frames, crossfade-tile the steadiest inner region of x until >= need_frames.
    """
    x = ensure_2d(x)
    n = len(x)
    if n >= need_frames:
        # Trim 8% off start and end when enough margin exists
        margin = min(int(n * 0.08), (n - need_frames) // 2)
        avail_start = margin
        avail_end = n - margin - need_frames
        if avail_end <= avail_start:
            return x[avail_start : avail_start + need_frames].copy()
        step = max(1, (avail_end - avail_start) // 24)
        best_score = float("inf")
        best_pos = avail_start
        for pos in range(avail_start, avail_end + 1, step):
            seg = x[pos : pos + need_frames]
            seg_rms = rms(seg)
            if seg_rms < 1e-4:
                continue
            # Divide into 8 sub-blocks to measure amplitude steadiness and crest factor
            blocks = np.array_split(seg, 8, axis=0)
            b_rms = np.array([rms(b) for b in blocks])
            steadiness = float(np.std(b_rms) / (np.mean(b_rms) + 1e-6))
            crest = float(np.max(np.abs(seg)) / (seg_rms + 1e-6))
            score = steadiness * 3.0 + crest * 0.08
            if score < best_score:
                best_score = score
                best_pos = pos
        return x[best_pos : best_pos + need_frames].copy()

    # Sample is shorter than need_frames: take its middle 84% and crossfade-tile seamlessly
    trim = int(n * 0.08) if n > int(0.4 * RATE) else 0
    core = x[trim : n - trim].copy() if n - 2 * trim > 2048 else x.copy()
    xf = min(int(0.12 * RATE), len(core) // 4)
    t = np.linspace(0.0, 1.0, xf, dtype=np.float32)[:, None]
    out = core.copy()
    while len(out) < need_frames:
        head = out[:-xf]
        cross = out[-xf:] * np.cos(t * np.pi * 0.5) + core[:xf] * np.sin(t * np.pi * 0.5)
        tail = core[xf:]
        out = np.vstack([head, cross, tail])
    return out[:need_frames].copy()


def make_seamless_loop(raw_x: np.ndarray, loop_s: float = LOOP_S, xfade_s: float = XFADE_S, sr: int = RATE) -> np.ndarray:
    """
    Create a click-free loop of loop_s seconds with equal-power crossfade and phase-aligned zero-crossing wrap.
    """
    loop_n = int(round(loop_s * sr))
    xf_n = int(round(xfade_s * sr))
    search_n = min(1024, xf_n // 4)
    need_n = loop_n + xf_n + search_n
    y = pick_steady_window(raw_x, need_n)

    # Find lag offset delta in [0, search_n) that maximizes correlation between y[loop_n+delta:] and y[:xf_n]
    mono = y.mean(axis=1)
    corr_len = min(2048, xf_n)
    ref = mono[:corr_len] - np.mean(mono[:corr_len])
    ref_norm = float(np.linalg.norm(ref)) + 1e-8
    best_delta = 0
    best_corr = -2.0
    for d in range(0, search_n, 4):
        cand = mono[loop_n + d : loop_n + d + corr_len]
        cand_c = cand - np.mean(cand)
        c = float(np.dot(ref, cand_c)) / (ref_norm * (float(np.linalg.norm(cand_c)) + 1e-8))
        if c > best_corr:
            best_corr = c
            best_delta = d

    cut = loop_n + best_delta
    z = y[best_delta : best_delta + loop_n].copy()
    tail = y[cut : cut + xf_n]
    head = z[:xf_n].copy()
    t = np.linspace(0.0, 1.0, xf_n, dtype=np.float32)[:, None]
    z[:xf_n] = tail * np.cos(t * np.pi * 0.5) + head * np.sin(t * np.pi * 0.5)

    # Remove DC offset
    z = z - np.mean(z, axis=0, keepdims=True)

    # Micro-bridge (32 samples = 0.67 ms) at wrap-around to zero so both ends meet at 0.0 with zero step jump
    bridge = 32
    ramp = np.sin(np.linspace(0.0, np.pi * 0.5, bridge, dtype=np.float32))[:, None]
    z[:bridge] *= ramp
    z[-bridge:] *= ramp[::-1]
    return z


def level_signal(x: np.ndarray, target_rms: float, peak_ceiling: float = 0.92) -> np.ndarray:
    """Scale signal to target_rms with soft tanh saturation if peaks exceed peak_ceiling."""
    cur = rms(x)
    if cur < 1e-6:
        return x
    y = x * (target_rms / cur)
    pk = float(np.max(np.abs(y)))
    if pk > peak_ceiling:
        # Soft-knee limiting above 0.75 so RMS stays consistent without clipping
        knee = 0.75
        above = np.maximum(0.0, np.abs(y) - knee)
        y = np.sign(y) * np.minimum(np.abs(y), knee + (peak_ceiling - knee) * np.tanh(above / (peak_ceiling - knee)))
    # Re-pin loop endpoints to 0.0 if soft limiter touched them
    y[0] = 0.0
    y[-1] = 0.0
    return y.astype(np.float32)


def encode_ogg(ffmpeg: str, x: np.ndarray, out_path: Path, force_mono: bool | None = None, quality: int = 4) -> int:
    """Encode float32 array (frames, ch) to Ogg Vorbis at RATE Hz, returning encoded channel count."""
    x = ensure_2d(x)
    use_mono = force_mono if force_mono is not None else is_effectively_mono(x)
    if use_mono and x.shape[1] > 1:
        x = x.mean(axis=1, keepdims=True)
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tmp_wav = tf.name
    try:
        with wave.open(tmp_wav, "wb") as w:
            w.setnchannels(pcm.shape[1])
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
                tmp_wav,
                "-c:a",
                "libvorbis",
                "-q:a",
                str(quality),
                str(out_path),
            ],
            check=True,
        )
    finally:
        if os.path.exists(tmp_wav):
            os.remove(tmp_wav)
    return int(pcm.shape[1])


def prepare_oneshot(x: np.ndarray, max_s: float = 1.35, target_peak: float = 0.78) -> np.ndarray:
    """Trim leading silence and excessive tail from a one-shot sample and normalize peak."""
    x = ensure_2d(x).copy()
    env = np.abs(x).max(axis=1)
    pk = float(env.max())
    if pk < 1e-5:
        return x[: int(0.2 * RATE)]
    # Find onset (first frame exceeding 3% of peak)
    onset_idx = np.where(env > pk * 0.03)[0]
    start = max(0, int(onset_idx[0]) - int(0.008 * RATE)) if len(onset_idx) > 0 else 0
    x = x[start:]
    max_frames = int(round(max_s * RATE))
    if len(x) > max_frames:
        x = x[:max_frames].copy()
    # Apply 5ms fade-in and 25ms fade-out
    fi = min(int(0.005 * RATE), len(x) // 4)
    fo = min(int(0.025 * RATE), len(x) // 3)
    if fi > 0:
        x[:fi] *= np.linspace(0.0, 1.0, fi, dtype=np.float32)[:, None]
    if fo > 0:
        x[-fo:] *= np.linspace(1.0, 0.0, fo, dtype=np.float32)[:, None]
    cur_pk = float(np.abs(x).max())
    if cur_pk > 1e-5:
        x = x * (target_peak / cur_pk)
    return x.astype(np.float32)


def derive_limiter_from_high_rpm(high_on_x: np.ndarray, freq_hz: float = 12.5, dur_s: float = 0.88) -> np.ndarray:
    """Derive a rev-limiter fuel/ignition cut stutter one-shot from the car's highest-RPM on-throttle sample."""
    need = int(round(dur_s * RATE))
    seg = pick_steady_window(high_on_x, need).mean(axis=1, keepdims=True)
    t = np.arange(need, dtype=np.float32) / RATE
    # Sharp 12.5 Hz limiter cut envelope
    pulse = 0.14 + 0.86 * np.power(0.5 + 0.5 * np.cos(2.0 * np.pi * freq_hz * t), 1.8)
    seg = seg * pulse[:, None]
    return prepare_oneshot(seg, max_s=dur_s, target_peak=0.78)


def from_onset(x: np.ndarray, pre_s: float = 0.004) -> np.ndarray:
    """The clip from just before its first strong transient (a backfire recording starts with silence or a lead-in)."""
    a = np.abs(x[:, 0]) if x.ndim == 2 else np.abs(x)
    peak = float(a.max()) if len(a) else 0.0
    if peak <= 1e-6:
        return x
    hit = int(np.argmax(a > 0.25 * peak))
    return x[max(0, hit - int(pre_s * RATE)) :]


def derive_shift_from_bank(
    base_x: np.ndarray, high_off_x: np.ndarray, role: str
) -> np.ndarray:
    """Derive gear_up, gear_down, or shift_cut from the bank's exhaust crack (a backfire) + engine bark.

    A seamless-shift F1 upshift is an ignition cut: a short exhaust crack as the engine drops onto the next gear,
    not a gearbox noise. The base is a backfire recording, taken from its onset."""
    base_m = from_onset(ensure_2d(base_x).mean(axis=1, keepdims=True))
    off_m = pick_steady_window(high_off_x, int(0.25 * RATE)).mean(axis=1, keepdims=True)
    if role == "gear_up":
        dur = int(0.16 * RATE)
        seg = base_m[: min(len(base_m), dur)].copy()
        if len(seg) < dur:
            seg = np.pad(seg, ((0, dur - len(seg)), (0, 0)))
        seg = pitch_resample(seg, 1.08, 1.0)[:dur]
        t = np.linspace(0.0, 1.0, len(seg), dtype=np.float32)[:, None]
        seg *= np.exp(-t * 9.0)
        return prepare_oneshot(seg, max_s=0.16, target_peak=0.76)
    if role == "gear_down":
        dur = int(0.22 * RATE)
        clunk = base_m[: min(len(base_m), dur)].copy()
        if len(clunk) < dur:
            clunk = np.pad(clunk, ((0, dur - len(clunk)), (0, 0)))
        clunk = pitch_resample(clunk, 0.92, 1.0)[:dur]
        t = np.linspace(0.0, 1.0, len(clunk), dtype=np.float32)[:, None]
        bark = off_m[: len(clunk)] * np.sin(t * np.pi) * 0.65
        seg = clunk * np.exp(-t * 7.0) * 0.75 + bark
        return prepare_oneshot(seg, max_s=0.22, target_peak=0.75)
    # shift_cut: punchy low-mid ignition cut thump
    dur = int(0.13 * RATE)
    seg = base_m[: min(len(base_m), dur)].copy()
    if len(seg) < dur:
        seg = np.pad(seg, ((0, dur - len(seg)), (0, 0)))
    b, a = signal.butter(2, 950.0 / (RATE * 0.5), btype="low")
    seg = signal.lfilter(b, a, seg, axis=0).astype(np.float32)
    t = np.linspace(0.0, 1.0, len(seg), dtype=np.float32)[:, None]
    seg *= np.exp(-t * 10.0)
    return prepare_oneshot(seg, max_s=0.13, target_peak=0.75)


def derive_blowoff_from_turbo(turbo_x: np.ndarray) -> np.ndarray:
    """Derive a turbo blow-off valve flutter/release one-shot from the car's turbo sample."""
    dur = int(0.32 * RATE)
    seg = pick_steady_window(turbo_x, dur).mean(axis=1, keepdims=True)
    t = np.linspace(0.0, 1.0, dur, dtype=np.float32)
    flutter = (0.65 + 0.35 * np.cos(2.0 * np.pi * 26.0 * t)) * np.exp(-t * 6.5)
    seg = seg * flutter[:, None]
    return prepare_oneshot(seg, max_s=0.32, target_peak=0.68)


def derive_overrun_pops(high_off_x: np.ndarray, count: int = 3, is_ext: bool = False) -> list[np.ndarray]:
    """Extract distinct overrun exhaust crackle/pop transients from high-RPM off-throttle deceleration."""
    x = ensure_2d(high_off_x).mean(axis=1, keepdims=True)
    dur = int(0.20 * RATE)
    pops: list[np.ndarray] = []
    step = max(dur, (len(x) - dur) // (count + 2))
    t = np.linspace(0.0, 1.0, dur, dtype=np.float32)[:, None]
    env = np.sin(np.minimum(1.0, t * 12.0) * np.pi * 0.5) * np.exp(-t * (8.5 if is_ext else 10.5))
    b, a = signal.butter(2, [120.0 / (RATE * 0.5), (4200.0 if is_ext else 3000.0) / (RATE * 0.5)], btype="band")
    for i in range(count):
        pos = min(len(x) - dur, (i + 1) * step)
        seg = signal.lfilter(b, a, x[pos : pos + dur], axis=0).astype(np.float32) * env
        pops.append(prepare_oneshot(seg, max_s=0.20, target_peak=0.74))
    return pops


def derive_transmission_from_engine(mid_on_x: np.ndarray, is_on: bool = True) -> np.ndarray:
    """Extract high-frequency straight-cut gear whine harmonic band from interior recording when bank has none."""
    need = int((LOOP_S + XFADE_S + 0.5) * RATE)
    seg = pick_steady_window(mid_on_x, need).mean(axis=1, keepdims=True)
    band = [1650.0 / (RATE * 0.5), 4400.0 / (RATE * 0.5)] if is_on else [1400.0 / (RATE * 0.5), 3600.0 / (RATE * 0.5)]
    b, a = signal.butter(2, band, btype="band")
    whine = signal.lfilter(b, a, seg, axis=0).astype(np.float32)
    loop = make_seamless_loop(whine, LOOP_S, XFADE_S, RATE)
    return level_signal(loop, 0.042 if is_on else 0.028)


class LazyBank:
    """On-demand decoder for an FMOD .bank file's FSB5 subsounds across all embedded FSB5 containers."""

    def __init__(self, bank_path: str | Path, ffmpeg: str = FFMPEG_DEFAULT) -> None:
        self.bank_path = Path(bank_path)
        self.ffmpeg = ffmpeg
        self.items, _ = load_fsbs_from_bank(self.bank_path)
        self._cache: dict[int, np.ndarray] = {}

    def get(self, spec: str | int) -> tuple[str, np.ndarray]:
        idx: int | None = None
        if isinstance(spec, int):
            idx = spec
        elif "#" in spec:
            name_part, idx_str = spec.rsplit("#", 1)
            cand_idx = int(idx_str)
            if 0 <= cand_idx < len(self.items) and self.items[cand_idx][1].name == name_part:
                idx = cand_idx
            else:
                spec = name_part

        if idx is None:
            for i, (_, s) in enumerate(self.items):
                if s.name == spec:
                    idx = i
                    break
        if idx is None or not (0 <= idx < len(self.items)):
            raise KeyError(f"Sample '{spec}' not found in {self.bank_path.name}")

        if idx not in self._cache:
            fsb, s = self.items[idx]
            arr, _ = decode_sample(fsb, s, RATE, self.ffmpeg)
            self._cache[idx] = arr
        return self.items[idx][1].name, self._cache[idx]


def port_car(car_id: str, cfg: dict[str, Any], ffmpeg: str) -> dict[str, Any]:
    out_dir = REPO_ROOT / cfg["outDir"]
    out_dir.mkdir(parents=True, exist_ok=True)

    int_bank_path = Path(cfg["intBank"])
    ext_bank_path = Path(cfg.get("extBank", cfg["intBank"]))

    int_bank = LazyBank(int_bank_path, ffmpeg)
    ext_bank = int_bank if ext_bank_path == int_bank_path else LazyBank(ext_bank_path, ffmpeg)

    manifest: dict[str, Any] = {
        "source": cfg["sourceDescription"],
        "sampleRate": RATE,
        "loopSeconds": LOOP_S,
        "engine": {"ext": [], "int": []},
        "turbo": [],
        "transmission": [],
        "oneshots": [],
        "throttleCurve": cfg["throttleCurve"],
        "lift": cfg["lift"],
        "limiterRetriggerS": cfg.get("limiterRetriggerS", 0.85),
    }

    used_samples: set[str] = set()
    max_boundary_jump = 0.0

    # 1. Engine loops (ext and int, on and off)
    for view, bank in (("int", int_bank), ("ext", ext_bank)):
        for layer in ("on", "off"):
            items = cfg["engine"][view][layer]
            n_items = len(items)
            for idx_item, item in enumerate(items):
                anchor_rpm = int(item["rpm"])
                root_rpm = float(item.get("rootRpm", anchor_rpm))
                spec = item["sample"]
                sname, raw_x = bank.get(spec)
                used_samples.add(f"{view}:{sname}")

                resampled = pitch_resample(raw_x, anchor_rpm, root_rpm)
                loop = make_seamless_loop(resampled, LOOP_S, XFADE_S, RATE)

                # Consistent RMS curve across RPM: rises smoothly from idle to limiter
                frac = idx_item / max(1, n_items - 1)
                if layer == "on":
                    target_rms = 0.165 + 0.055 * frac
                else:
                    target_rms = 0.125 + 0.050 * frac
                loop = level_signal(loop, target_rms)

                jump = float(np.max(np.abs(loop[0] - loop[-1])))
                max_boundary_jump = max(max_boundary_jump, jump)

                fn = f"engine_{view}_{layer}_{anchor_rpm}.ogg"
                ch = encode_ogg(ffmpeg, loop, out_dir / fn, quality=4)
                manifest["engine"][view].append(
                    {
                        "file": fn,
                        "layer": layer,
                        "rpm": anchor_rpm,
                        "channels": ch,
                        "rms": round(rms(loop), 4),
                    }
                )

    # 2. Turbo loops (for turbocharged engines)
    for t_item in cfg.get("turbo", []):
        layer = t_item["layer"]
        boost = float(t_item["boost"])
        sname, raw_x = int_bank.get(t_item["sample"])
        used_samples.add(f"turbo:{sname}")
        loop = make_seamless_loop(raw_x, LOOP_S, XFADE_S, RATE)
        loop = level_signal(loop, float(t_item.get("rms", 0.085 if layer == "on" else 0.065)))
        b_tag = int(round(boost * 10))
        fn = f"turbo_{layer}_{b_tag}.ogg"
        ch = encode_ogg(ffmpeg, loop, out_dir / fn, force_mono=True, quality=4)
        manifest["turbo"].append(
            {
                "file": fn,
                "layer": layer,
                "boost": boost,
                "channels": ch,
                "rms": round(rms(loop), 4),
            }
        )

    # 3. Transmission loops
    trans_cfg = cfg.get("transmission", [])
    if trans_cfg:
        for tr_item in trans_cfg:
            layer = tr_item["layer"]
            speed = int(tr_item["drivetrainSpeed"])
            sname, raw_x = int_bank.get(tr_item["sample"])
            used_samples.add(f"trans:{sname}")
            if "pitchRatio" in tr_item:
                raw_x = pitch_resample(raw_x, float(tr_item["pitchRatio"]), 1.0)
            loop = make_seamless_loop(raw_x, LOOP_S, XFADE_S, RATE)
            # whine sits well under the engine, at the level of the original FA-26 and GT3 banks
            loop = level_signal(loop, float(tr_item.get("rms", 0.042 if layer == "on" else 0.028)))
            fn = f"trans_{layer}_{speed}.ogg"
            ch = encode_ogg(ffmpeg, loop, out_dir / fn, force_mono=True, quality=4)
            manifest["transmission"].append(
                {
                    "file": fn,
                    "layer": layer,
                    "drivetrainSpeed": speed,
                    "channels": ch,
                    "rms": round(rms(loop), 4),
                }
            )
    else:
        # Derive straight-cut gearbox whine from mid-RPM interior recording
        mid_spec = cfg["engine"]["int"]["on"][len(cfg["engine"]["int"]["on"]) // 2]["sample"]
        sname, mid_x = int_bank.get(mid_spec)
        for layer, speed in (("on", 200), ("off", 200)):
            loop = derive_transmission_from_engine(mid_x, is_on=(layer == "on"))
            fn = f"trans_{layer}_{speed}.ogg"
            ch = encode_ogg(ffmpeg, loop, out_dir / fn, force_mono=True, quality=4)
            manifest["transmission"].append(
                {
                    "file": fn,
                    "layer": layer,
                    "drivetrainSpeed": speed,
                    "channels": ch,
                    "rms": round(rms(loop), 4),
                }
            )

    # 4. Skid loops (optional per view)
    if "skid" in cfg and cfg["skid"]:
        skid_obj: dict[str, Any] = {}
        for view, spec in cfg["skid"].items():
            sname, raw_x = int_bank.get(spec)
            used_samples.add(f"skid:{sname}")
            loop = make_seamless_loop(raw_x, LOOP_S, XFADE_S, RATE)
            loop = level_signal(loop, 0.16)
            fn = f"skid_{view}.ogg"
            ch = encode_ogg(ffmpeg, loop, out_dir / fn, force_mono=True, quality=4)
            skid_obj[view] = {
                "file": fn,
                "channels": ch,
                "rms": round(rms(loop), 4),
            }
        manifest["skid"] = skid_obj

    # 5. Traction control loop
    if "tractionControl" in cfg and cfg["tractionControl"]:
        sname, raw_x = int_bank.get(cfg["tractionControl"])
        used_samples.add(f"tc:{sname}")
        loop = make_seamless_loop(raw_x, LOOP_S, XFADE_S, RATE)
        loop = level_signal(loop, 0.16)
        fn = "tc.ogg"
        ch = encode_ogg(ffmpeg, loop, out_dir / fn, force_mono=True, quality=4)
        manifest["tractionControl"] = {
            "file": fn,
            "channels": ch,
            "rms": round(rms(loop), 4),
        }

    # 6. Oneshots
    oneshot_cfg = cfg.get("oneshots", {})
    for role, specs in oneshot_cfg.items():
        for i, spec in enumerate(specs):
            try:
                sname, raw_x = int_bank.get(spec)
            except KeyError:
                sname, raw_x = ext_bank.get(spec)
            used_samples.add(f"oneshot:{sname}")
            clip = prepare_oneshot(raw_x)
            safe_tag = f"{role}_{i + 1}" if len(specs) > 1 else role
            fn = f"oneshot_{safe_tag}.ogg"
            ch = encode_ogg(ffmpeg, clip, out_dir / fn, force_mono=True, quality=4)
            manifest["oneshots"].append(
                {
                    "file": fn,
                    "fsbName": sname,
                    "role": role,
                    "channels": ch,
                    "seconds": round(len(clip) / RATE, 3),
                    "peak": round(float(np.abs(clip).max()), 3),
                }
            )

    existing_roles = {o["role"] for o in manifest["oneshots"]}
    high_on_spec = cfg["engine"]["int"]["on"][-1]["sample"]
    _, high_on_x = int_bank.get(high_on_spec)
    high_off_spec = cfg["engine"]["int"]["off"][-1]["sample"]
    _, high_off_x = int_bank.get(high_off_spec)
    ext_off_spec = cfg["engine"]["ext"]["off"][-1]["sample"]
    _, ext_off_x = ext_bank.get(ext_off_spec)

    shift_source_name = cfg.get("shiftFallbackSample")
    # AC's "missgear" is the missed-gear grind: never a shift sound
    if shift_source_name and "missgear" in shift_source_name.lower():
        raise SystemExit(f"{car_id}: shiftFallbackSample {shift_source_name!r} is the missed-gear grind; use a backfire")
    if shift_source_name:
        try:
            _, shift_base_x = int_bank.get(shift_source_name)
        except KeyError:
            _, shift_base_x = ext_bank.get(shift_source_name)
        used_samples.add(f"oneshot:{shift_source_name}")
    else:
        shift_base_x = high_off_x

    for s_role in ("gear_up", "gear_down", "shift_cut"):
        if s_role not in existing_roles:
            clip = derive_shift_from_bank(shift_base_x, high_off_x, s_role)
            fn = f"oneshot_{s_role}.ogg"
            ch = encode_ogg(ffmpeg, clip, out_dir / fn, force_mono=True, quality=4)
            manifest["oneshots"].append(
                {
                    "file": fn,
                    "fsbName": shift_source_name or str(high_off_spec),
                    "role": s_role,
                    "channels": ch,
                    "seconds": round(len(clip) / RATE, 3),
                    "peak": round(float(np.abs(clip).max()), 3),
                }
            )

    if "limiter" not in existing_roles:
        lim_spec = cfg.get("limiterFallbackSample", high_on_spec)
        lim_name, lim_x = int_bank.get(lim_spec)
        used_samples.add(f"oneshot:{lim_name}")
        clip = derive_limiter_from_high_rpm(lim_x)
        fn = "oneshot_limiter.ogg"
        ch = encode_ogg(ffmpeg, clip, out_dir / fn, force_mono=True, quality=4)
        manifest["oneshots"].append(
            {
                "file": fn,
                "fsbName": lim_name,
                "role": "limiter",
                "channels": ch,
                "seconds": round(len(clip) / RATE, 3),
                "peak": round(float(np.abs(clip).max()), 3),
            }
        )

    if "backfire_int" not in existing_roles:
        for i, clip in enumerate(derive_overrun_pops(high_off_x, count=3, is_ext=False)):
            fn = f"oneshot_backfire_int_{i + 1}.ogg"
            ch = encode_ogg(ffmpeg, clip, out_dir / fn, force_mono=True, quality=4)
            manifest["oneshots"].append(
                {
                    "file": fn,
                    "fsbName": str(high_off_spec),
                    "role": "backfire_int",
                    "channels": ch,
                    "seconds": round(len(clip) / RATE, 3),
                    "peak": round(float(np.abs(clip).max()), 3),
                }
            )

    if "backfire_ext" not in existing_roles:
        for i, clip in enumerate(derive_overrun_pops(ext_off_x, count=3, is_ext=True)):
            fn = f"oneshot_backfire_ext_{i + 1}.ogg"
            ch = encode_ogg(ffmpeg, clip, out_dir / fn, force_mono=True, quality=4)
            manifest["oneshots"].append(
                {
                    "file": fn,
                    "fsbName": str(ext_off_spec),
                    "role": "backfire_ext",
                    "channels": ch,
                    "seconds": round(len(clip) / RATE, 3),
                    "peak": round(float(np.abs(clip).max()), 3),
                }
            )

    if "blowoff" not in existing_roles and cfg.get("turbo"):
        t_spec = cfg["turbo"][0]["sample"]
        t_name, t_x = int_bank.get(t_spec)
        clip = derive_blowoff_from_turbo(t_x)
        fn = "oneshot_blowoff.ogg"
        ch = encode_ogg(ffmpeg, clip, out_dir / fn, force_mono=True, quality=4)
        manifest["oneshots"].append(
            {
                "file": fn,
                "fsbName": t_name,
                "role": "blowoff",
                "channels": ch,
                "seconds": round(len(clip) / RATE, 3),
                "peak": round(float(np.abs(clip).max()), 3),
            }
        )

    # Remove any stale .ogg files in out_dir not referenced by this manifest
    referenced_files = {"manifest.json"}
    for view in ("ext", "int"):
        for e in manifest["engine"][view]:
            referenced_files.add(e["file"])
    for e in manifest["turbo"]:
        referenced_files.add(e["file"])
    for e in manifest["transmission"]:
        referenced_files.add(e["file"])
    for e in manifest["oneshots"]:
        referenced_files.add(e["file"])
    if "skid" in manifest:
        for e in manifest["skid"].values():
            referenced_files.add(e["file"])
    if "tractionControl" in manifest:
        referenced_files.add(manifest["tractionControl"]["file"])

    for existing in out_dir.glob("*.ogg"):
        if existing.name not in referenced_files:
            existing.unlink()

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    total_bytes = sum(f.stat().st_size for f in out_dir.iterdir() if f.is_file())
    return {
        "car": car_id,
        "outDir": cfg["outDir"],
        "samplesUsed": len(used_samples),
        "filesWritten": len(referenced_files),
        "totalMB": round(total_bytes / (1024 * 1024), 3),
        "maxBoundaryJump": round(max_boundary_jump, 6),
        "intAnchors": sorted({e["rpm"] for e in manifest["engine"]["int"]}),
        "extAnchors": sorted({e["rpm"] for e in manifest["engine"]["ext"]}),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", metavar="BANK", help="List all FSB5 samples inside an FMOD .bank file")
    ap.add_argument("--inspect", metavar="BANK", help="Inspect FMOD PMLB RPM intervals and autopitch roots")
    ap.add_argument("--car", help="Port a single car ID from car_configs.json")
    ap.add_argument("--all", action="store_true", help="Port all configured cars in car_configs.json")
    ap.add_argument("--ffmpeg", default=FFMPEG_DEFAULT, help="Path to ffmpeg binary")
    args = ap.parse_args()

    if args.list:
        meta = list_bank_samples(args.list)
        print(json.dumps(meta, indent=2))
        return

    if args.inspect:
        pmlb = inspect_fmod_pmlb(args.inspect)
        print(json.dumps(pmlb, indent=2))
        return

    configs: dict[str, Any] = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if args.car:
        if args.car not in configs:
            raise SystemExit(f"Unknown car '{args.car}'. Available: {', '.join(configs.keys())}")
        summary = port_car(args.car, configs[args.car], args.ffmpeg)
        print(json.dumps(summary, indent=2))
        return

    if args.all:
        summaries = []
        for cid, cfg in configs.items():
            print(f"[port_ac_bank] Porting {cid} -> {cfg['outDir']} ...", file=sys.stderr)
            s = port_car(cid, cfg, args.ffmpeg)
            summaries.append(s)
            print(
                f"  done: {s['totalMB']:.2f} MB ({s['filesWritten']} files, {s['samplesUsed']} raw samples, max jump={s['maxBoundaryJump']})",
                file=sys.stderr,
            )
        print(json.dumps(summaries, indent=2))
        return

    ap.print_help()


if __name__ == "__main__":
    main()
