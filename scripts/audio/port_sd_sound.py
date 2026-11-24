#!/usr/bin/env python3
"""
A Speed Dreams car's engine sound as a LibreCorsa sound bank (manifest.json and Ogg loops, the format port_ac_bank.py
writes and src/lib/sim/lc26-audio.ts plays).

Speed Dreams plays one looping engine sample (`Sound/engine sample`), at a rate that follows the engine linearly:
rate = rpm_scale × ω / 600 with ω in rad/s (snddefault's CarSoundData), so the sample sounds at its own pitch at
600·30/π / rpm_scale ≈ 5729.6 / rpm_scale rpm. Its loudness is exp(1.3·(lp − 1)), lp = 0.75·r² + 0.25 on full throttle
and 0.25·r² lifted (r = rpm / limiter); nothing else changes between the two. The game's bank plays a loop recorded at
`rpm` at rate engine rpm / `rpm`, so a loop made of the sample resampled to Speed Dreams' rate at that rpm sounds as
Speed Dreams sounds at every rpm. This writes such loops at a few rpm from idle to the limiter, on and off throttle at
Speed Dreams' two loudness curves (scaled so full throttle at the limiter sits at the bank format's top level), the same
loops for the cockpit and outside (Speed Dreams has one), and a limiter stutter made from the top loop.

Usage (numpy, scipy and fsb5 for port_ac_bank.py's helpers; ffmpeg for the Ogg encode, found on PATH unless --ffmpeg
names it):

  uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 python -P scripts/audio/port_sd_sound.py \
    <sample.wav> <out folder> --rpm-scale 0.71 --limiter 9500 --idle 1000 --source "Speed Dreams: ls2-cavallo-360r"
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from scipy import signal

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from port_ac_bank import FFMPEG_DEFAULT, RATE, derive_limiter_from_high_rpm, encode_ogg, level_signal, rms  # noqa: E402

# Speed Dreams' engine pitch: rate = rpm_scale × rpm / this
SD_PITCH_RPM = 600 * 30 / math.pi
# The bank format's loudest on-throttle loop (port_ac_bank.py's level curve tops out here)
TOP_RMS = 0.22
THROTTLE_CURVE = {
    "ext": [[0.0, 0.0], [0.1, 0.25], [0.25, 0.55], [0.5, 0.82], [0.75, 0.94], [1.0, 1.0]],
    "int": [[0.0, 0.0], [0.1, 0.28], [0.25, 0.58], [0.5, 0.84], [0.75, 0.95], [1.0, 1.0]],
}


def read_wav(path: Path) -> np.ndarray:
    """The sample as mono float32 at RATE (Speed Dreams takes mono 8- or 16-bit PCM at any rate)"""
    try:
        with wave.open(str(path), "rb") as w:
            ch, width, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
    except (wave.Error, EOFError) as e:
        raise SystemExit(f"{path}: not a PCM WAV file Speed Dreams plays ({e})")
    if n <= 0 or sr <= 0 or ch <= 0 or len(raw) < width * ch:
        raise SystemExit(f"{path}: no sound in it ({n} frames at {sr} Hz)")
    if width == 1:
        x = (np.frombuffer(raw, np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
    else:
        raise SystemExit(f"{path}: {8 * width}-bit samples (Speed Dreams reads 8 and 16 bit)")
    x = x.reshape(-1, ch).mean(axis=1)
    if sr != RATE:
        g = math.gcd(sr, RATE)
        x = signal.resample_poly(x, RATE // g, sr // g).astype(np.float32)
    return x - float(np.mean(x))


def circular_resample(x: np.ndarray, ratio: float) -> np.ndarray:
    """`x` played `ratio` times as fast, as a loop: it wraps round, so the result loops as seamlessly as the sample"""
    n = len(x)
    m = max(64, int(round(n / ratio)))
    pos = np.arange(m, dtype=np.float64) * (n / m)
    i0 = np.floor(pos).astype(np.int64) % n
    i1 = (i0 + 1) % n
    f = (pos - np.floor(pos)).astype(np.float32)
    return x[i0] * (1.0 - f) + x[i1] * f


def loop_of(x: np.ndarray, min_s: float = 2.0) -> np.ndarray:
    """Whole repeats of a loop, at least `min_s` long"""
    reps = max(1, math.ceil(min_s * RATE / len(x)))
    return np.tile(x, reps)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n")[0])
    ap.add_argument("wav", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--rpm-scale", type=float, required=True, help="Sound/rpm scale")
    ap.add_argument("--limiter", type=float, required=True, help="Engine/revs limiter (rpm)")
    ap.add_argument("--idle", type=float, required=True, help="Engine/tickover (rpm)")
    ap.add_argument("--source", default="Speed Dreams")
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or FFMPEG_DEFAULT, help="ffmpeg (default: the one on PATH)")
    a = ap.parse_args()
    for what, v, ok in (("--rpm-scale", a.rpm_scale, a.rpm_scale > 0), ("--limiter", a.limiter, a.limiter > 0),
                        ("--idle", a.idle, a.idle >= 0)):
        if not (math.isfinite(v) and ok):
            raise SystemExit(f"{what} {v}: it must be a finite number, {'0 or more' if what == '--idle' else 'more than 0'}")
    try:
        subprocess.run([a.ffmpeg, "-version"], check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise SystemExit(f"ffmpeg ({a.ffmpeg}) doesn't run ({e}): install it, or name it with --ffmpeg")

    x = read_wav(a.wav)
    if rms(x) < 1e-4:
        raise SystemExit(f"{a.wav}: silent")
    a.out.mkdir(parents=True, exist_ok=True)
    for old in a.out.glob("*.ogg"):
        old.unlink()
    lim = a.limiter
    lo = max(a.idle, 0.25 * lim)
    anchors = sorted({int(round(r / 100.0) * 100) for r in np.linspace(lo, lim, 5)})
    g_top = math.exp(1.3 * (0.75 + 0.25 - 1.0))
    entries = []
    top_on = None
    for rpm in anchors:
        ratio = a.rpm_scale * rpm / SD_PITCH_RPM
        y = loop_of(circular_resample(x, ratio))
        r = rpm / lim
        for layer, lp in (("on", 0.75 * r * r + 0.25), ("off", 0.25 * r * r)):
            target = TOP_RMS * math.exp(1.3 * (lp - 1.0)) / g_top
            z = level_signal(y[:, None], target)
            name = f"engine_ext_{layer}_{rpm}.ogg"
            ch = encode_ogg(a.ffmpeg, z, a.out / name, force_mono=True)
            entries.append({"file": name, "layer": layer, "rpm": rpm, "channels": ch, "rms": round(target, 4)})
            if layer == "on":
                top_on = z
    oneshots = []
    if top_on is not None:
        lim_shot = derive_limiter_from_high_rpm(top_on)
        encode_ogg(a.ffmpeg, lim_shot, a.out / "oneshot_limiter.ogg", force_mono=True)
        oneshots.append({"file": "oneshot_limiter.ogg", "role": "limiter", "channels": 1, "seconds": round(len(lim_shot) / RATE, 3),
                         "peak": round(float(np.max(np.abs(lim_shot))), 3)})
    manifest = {
        "source": a.source,
        "sampleRate": RATE,
        "loopSeconds": 2.0,
        # One sample in Speed Dreams, heard alike from the cockpit and outside
        "engine": {"ext": entries, "int": entries},
        "turbo": [],
        "transmission": [],
        "oneshots": oneshots,
        "throttleCurve": THROTTLE_CURVE,
    }
    (a.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    native = SD_PITCH_RPM / a.rpm_scale
    print(f"wrote {a.out}: loops at {anchors} rpm (the sample's own pitch at {native:.0f} rpm), {len(oneshots)} one-shot(s)")


if __name__ == "__main__":
    main()
