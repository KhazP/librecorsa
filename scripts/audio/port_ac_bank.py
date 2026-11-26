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
  uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 python -P scripts/audio/port_ac_bank.py --car bmw-m4-gt3
  uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 python -P scripts/audio/port_ac_bank.py --all
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
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
BANKS_ROOT = Path(os.environ.get("AC_BANKS_DIR") or (Path.home() / "Downloads"))


def resolve_bank_path(raw: str | Path, banks_root: Path = BANKS_ROOT) -> Path:
    p = Path(raw).expanduser()
    return p if p.is_absolute() else banks_root / p


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
    fsb: fsb5.FSB5, sample: Any, target_sr: int = RATE, ffmpeg: str = FFMPEG_DEFAULT, raw_pcm16: bool = False
) -> tuple[np.ndarray, int]:
    """Decode a single FSB5 subsound (PCM16 WAV or rebuilt Ogg Vorbis) to float32 (frames, channels) at target_sr.

    raw_pcm16 reads a PCM16 subsound's own bytes (frames x channels x 2) instead of fsb5's rebuilt WAV, whose data
    chunk holds only frames x 2 bytes: half of a stereo sample (opt-in per car, `rawPcm16`)."""
    ch = int(sample.channels)
    sr = int(sample.frequency)
    if raw_pcm16 and int(fsb.header.mode) == 2:  # FSB5 PCM16
        rebuilt = b"data" + struct.pack("<I", int(sample.samples) * ch * 2) + bytes(sample.data)
    else:
        rebuilt = bytes(fsb.rebuild_sample(sample))

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

    # Newer banks link an interval to a waveform instrument (WAIB: its GUID, then the waveform's) and the waveform
    # resource (WAV , 30 bytes: its GUID, then the subsound index at byte 22)
    wav_index = {d[:16]: struct.unpack("<H", d[22:24])[0] for _, d in riff_chunks.get("WAV ", []) if len(d) >= 24}
    waib_sample = {d[:16]: wav_index.get(d[16:32]) for _, d in riff_chunks.get("WAIB", []) if len(d) >= 32}

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
            # The instrument's place on the parameter: where it starts, then its length
            start, length = struct.unpack("<ff", p[base + 16 : base + 24])
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
            if not wav_names and waib_sample.get(iguid) is not None and waib_sample[iguid] < len(names):
                sidx = waib_sample[iguid]
                wav_names.append(f"{names[sidx]}#{sidx}")
            entries.append(
                {
                    "start": round(start, 1),
                    "end": round(start + length, 1),
                    "rootRpm": round(root_rpm, 1),
                    "samples": wav_names,
                }
            )
        if entries and entries[0]["end"] > 500:
            results.append({"pmlbGuid": p[0:4].hex(), "entries": entries})
    return results


# ---------------------------------------------------------------------------------------------------------------------
# An engine event as its bank plays it (`engineFromBank`), read from the tables of an FMOD Studio 1.x bank (format 0x50,
# what Assetto Corsa's sound projects build). An event mixes tracks (buses into its master track), each track's volume
# automated by the event's parameters (throttle, the cone angle). On the rpm parameter sheet each instrument covers
# [start, start + length), loops one recording from its start offset, pitched by autopitch (rate = rpm / root), and
# fades in and out by its own curves on rpm. Curves, maps and the curve shape were checked against the FMOD runtime
# playing the bank: pitch, start offset, fades and throttle gains agree within 0.2 dB
# ---------------------------------------------------------------------------------------------------------------------

# A curve segment with shape s runs y0 + (y1 - y0) * (e^(k u) - 1) / (e^k - 1), k = FMOD_SHAPE_K * s, over u = 0..1
# (measured: FMOD's throttle volume curves of shape -0.76 and +0.64 fit k = 6.95 s within 0.1 dB)
FMOD_SHAPE_K = 6.95
# An instrument's own volume counts twice: the FMOD runtime playing these banks turns each dB stored on an instrument into
# 2 dB of output (measured: 0, -2 and -6 dB stored give 0, -4 and -12 dB)
FMOD_INST_VOLUME_TIMES = 2.0
# The part of a recording its loop is cut from: FMOD starts an instrument from its start offset each time the revs
# enter its range, so the opening seconds are what is heard most (a long recording's later stretches can sound apart)
BANK_LOOP_FROM_S = 3.0


def fmod_segment(u: float, shape: float) -> float:
    if abs(shape) < 1e-6:
        return u
    k = FMOD_SHAPE_K * shape
    return float(np.expm1(k * u) / np.expm1(k))


def fmod_curve(points: list[tuple[float, float, float]], x: float) -> float:
    """An automation curve's value at x: its points (x, y, shape of the segment after it), held flat past both ends"""
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0, s0), (x1, y1, _s1) in zip(points, points[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * fmod_segment((x - x0) / max(1e-9, x1 - x0), s0)
    return points[-1][1]


# An S-curve segment (a point of kind 1): two halves of the exponential shape, the second the first turned about the
# middle, k = FMOD_S_SHAPE_K * shape (fitted to the runtime's stock wind and tyre-rolling speed curves within 0.3 dB)
FMOD_S_SHAPE_K = 4.42


def fmod_curve_at(points: list[tuple[float, float, float]], kinds: list[int], x: float) -> float:
    """fmod_curve, with the segments whose first point is of kind 1 as S-curves"""
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0, s0), (x1, y1, _s1), kind in zip(points, points[1:], kinds):
        if x <= x1:
            u = (x - x0) / max(1e-9, x1 - x0)
            if kind == 1:
                k = FMOD_S_SHAPE_K * s0

                def half(v: float) -> float:
                    return v if abs(k) < 1e-6 else float(np.expm1(k * v) / np.expm1(k))

                f = 0.5 * half(2 * u) if u < 0.5 else 1.0 - 0.5 * half(2 - 2 * u)
            else:
                f = fmod_segment(u, s0)
            return y0 + (y1 - y0) * f
    return points[-1][1]


def fmod_map(points: list[tuple[float, float]], x: float) -> float:
    """A property's mapping (a fader's curve value to dB, an EQ's to Hz), linear between its points"""
    return float(np.interp(x, [p[0] for p in points], [p[1] for p in points]))


def _fmod_list(d: bytes, o: int) -> tuple[int, int, int]:
    """An FMOD list: a u16 count * 2 + 1, then the u16 item size when there are items. (count, size, first item)"""
    n = struct.unpack_from("<H", d, o)[0] >> 1
    return (n, struct.unpack_from("<H", d, o + 2)[0], o + 4) if n else (0, 0, o + 2)


def _fmod_guids(d: bytes, o: int) -> tuple[list[bytes], int]:
    n, size, o = _fmod_list(d, o)
    return [d[o + i * size : o + i * size + 16] for i in range(n)], o + n * size


def _fmod_playlist(d: bytes) -> list[bytes]:
    """A multi instrument's playlist (PLST: two u32, then a list of instrument guid + weight): its instruments' guids"""
    guids, _ = _fmod_guids(d, 8)
    return guids


class FmodEventTables:
    """The tables an engine event is built from: events, parameters, tracks, instruments, automation, curves, maps"""

    def __init__(self, bank_path: str | Path) -> None:
        self.raw = Path(bank_path).read_bytes()
        self.event_paths: dict[bytes, str] = {}
        guids_txt = Path(bank_path).parent / "GUIDs.txt"
        if guids_txt.exists():
            for line in guids_txt.read_text(encoding="latin1").splitlines():
                m = re.match(r"\{([0-9a-fA-F-]{36})\}\s+(event:\S+)", line.strip())
                if m:
                    self.event_paths[_uuid_bytes(m.group(1))] = m.group(2)
        self.params: dict[bytes, dict[str, Any]] = {}
        self.sheets: list[dict[str, Any]] = []
        self.insts: dict[bytes, dict[str, Any]] = {}
        self.wav_index: dict[bytes, int] = {}
        self.ctrls: dict[bytes, dict[str, Any]] = {}
        self.curves: dict[bytes, list[tuple[float, float, float]]] = {}
        self.curve_kinds: dict[bytes, list[int]] = {}
        self.maps: dict[bytes, list[tuple[float, float]]] = {}
        self.buses: dict[bytes, dict[str, Any]] = {}
        self.effects: dict[bytes, dict[str, Any]] = {}
        self.events: dict[bytes, dict[str, Any]] = {}
        # Modulators (MODU): what follows the guid and the target, by guid
        self.mods: dict[bytes, bytes] = {}
        self._walk(0, len(self.raw), None)

    def _walk(self, p: int, end: int, parent: dict[str, Any] | None) -> None:
        raw = self.raw
        while p + 8 <= end:
            cid = raw[p : p + 4].decode("latin1")
            size = struct.unpack_from("<I", raw, p + 4)[0]
            if cid in ("RIFF", "LIST"):
                node: dict[str, Any] = {"type": raw[p + 8 : p + 12].decode("latin1"), "chunks": {}, "lists": []}
                if node["type"] != "SND ":
                    self._walk(p + 12, p + 8 + size, node)
                self._take(node)
                if parent is not None:
                    parent["lists"].append(node)
            elif parent is not None and cid != "SND ":
                parent["chunks"].setdefault(cid, []).append(raw[p + 8 : p + 8 + size])
            p += 8 + size + (size & 1)

    @staticmethod
    def _props(node: dict[str, Any]) -> list[dict[str, Any]]:
        """A PRPS list: per automated property, its id, its mapping and its automation (controller guids)"""
        out = []
        for pr in (n for n in node["lists"] if n["type"] == "PRPS"):
            for d in pr["chunks"].get("PROP", []):
                ctrls, o = _fmod_guids(d, 24)
                mods, _ = _fmod_guids(d, o)
                out.append({"prop": struct.unpack_from("<I", d, 0)[0], "map": d[8:24], "ctrls": ctrls, "mods": mods})
        return out

    def _take(self, node: dict[str, Any]) -> None:
        t, ch = node["type"], node["chunks"]
        if t == "WAVS":
            for d in ch.get("WAV ", []):
                self.wav_index[d[:16]] = struct.unpack_from("<H", d, 22)[0]
        elif t == "PARM":
            d = ch["PRMB"][0]
            n = struct.unpack_from("<H", d, 21)[0]
            self.params[d[:16]] = {
                "name": d[23 : 23 + n].decode("latin1"),
                "min": struct.unpack_from("<f", d, 23 + n)[0],
                "max": struct.unpack_from("<f", d, 27 + n)[0],
            }
        elif t == "PMLO":
            d = ch["PMLB"][0]
            n, size, o = _fmod_list(d, 48)
            entries = [(d[o + i * size : o + i * size + 16],) + struct.unpack_from("<ff", d, o + i * size + 16) for i in range(n)]
            self.sheets.append({"param": d[16:32], "event": d[32:48], "entries": entries})
        elif t in ("WAIT", "MUIT"):
            d = ch["INST"][0]
            head = ch["WAIB" if t == "WAIT" else "MUIB"][0]
            self.insts[head[:16]] = {
                "wav": head[16:32] if t == "WAIT" else None,
                # A multi instrument plays one of its playlist's instruments each time it is triggered
                "playlist": _fmod_playlist(ch["PLST"][0]) if t == "MUIT" else [],
                "volumeDb": struct.unpack_from("<f", d, 16)[0],
                "pitch": struct.unpack_from("<f", d, 20)[0],
                # -1: loops until stopped; 0: plays once
                "loop": struct.unpack_from("<i", d, 24)[0],
                # The chance (%) that a trigger plays it
                "probability": struct.unpack_from("<f", d, 33)[0],
                "autopitchParam": d[53:69],
                "root": struct.unpack_from("<f", d, 69)[0],
                "bus": d[83:99],
                "startOffsetPct": struct.unpack_from("<f", d, 115)[0] if len(d) >= 119 else 0.0,
                "props": self._props(node),
            }
        elif t == "CTRS":
            for d in ch.get("CTRL", []):
                self.ctrls[d[:16]] = {"target": d[16:32], "param": d[32:48], "curve": d[48:64], "prop": struct.unpack_from("<I", d, 64)[0]}
        elif t == "MODS":
            for d in ch.get("MODU", []):
                self.mods[d[:16]] = d[32:]
        elif t == "CRVS":
            for d in ch.get("CURV", []):
                n, size, o = _fmod_list(d, 32)
                self.curves[d[:16]] = [struct.unpack_from("<fff", d, o + i * size) for i in range(n)]
                # Each point's segment kind: 0 the exponential shape, 1 an S-curve (fmod_curve_at)
                self.curve_kinds[d[:16]] = [struct.unpack_from("<I", d, o + i * size + 12)[0] for i in range(n)]
        elif t == "MPGS":
            for d in ch.get("MAP ", []):
                n, size, o = _fmod_list(d, 16)
                self.maps[d[:16]] = [struct.unpack_from("<ff", d, o + i * size) for i in range(n)]
        elif t in ("IBUS", "GBUS", "MBUS"):
            d, body = ch[t[0] + "BSB"][0], ch["BUS "][0]
            # The bus body: two lists (its effects), a u16, then its volume (dB)
            o, effects = 5, []
            for _ in range(2):
                listed, o = _fmod_guids(body, o)
                effects += listed
            self.buses[d[:16]] = {
                "out": d[18:34],
                "volumeDb": struct.unpack_from("<f", body, o + 2)[0],
                "effects": effects,
                "props": self._props(node),
            }
        elif t in ("BEFF", "PEFF"):
            d = ch[t[0] + "EFB"][0]
            self.effects[d[:16]] = {"dsp": struct.unpack_from("<I", d, 20)[0], "props": self._props(node)}
        elif t == "EVNT":
            d = ch["EVTB"][0]
            params, _ = _fmod_guids(d, 93)
            self.events[d[:16]] = {"master": d[64:80], "params": params}

    def event(self, name: str) -> bytes:
        """An event's guid by the end of its path ("engine_int"), from the GUIDs.txt beside the bank"""
        found = [g for g, path in self.event_paths.items() if path.rsplit("/", 1)[-1] == name and g in self.events]
        if len(found) != 1:
            raise ValueError(f"{len(found)} events named {name!r} in the bank's GUIDs.txt")
        return found[0]

    def param_name(self, guid: bytes) -> str:
        return self.params[guid]["name"] if guid in self.params else "?"

    def volume_db(self, obj: dict[str, Any], values: dict[str, float], vary: str | None = None) -> float:
        """A track's or instrument's volume (prop 0, dB) at these parameter values: its automation curves, each mapped to
        dB and summed, replace its own volume. `vary`: only the curves on that parameter (the rest held at 0 dB)"""
        auto = [pr for pr in obj["props"] if pr["prop"] == 0 and pr["ctrls"]]
        if not auto:
            return 0.0 if vary else obj.get("volumeDb", 0.0)
        db = 0.0
        for pr in auto:
            for c in pr["ctrls"]:
                ct = self.ctrls[c]
                pname = self.param_name(ct["param"])
                if vary is not None and pname != vary:
                    continue
                if pname not in values:
                    raise ValueError(f"a volume curve on parameter {pname!r}, which the config does not set")
                db += fmod_map(self.maps[pr["map"]], fmod_curve(self.curves[ct["curve"]], values[pname]))
        return db

    def fade(self, inst: dict[str, Any], param: str, x: float) -> float:
        """An instrument's fade-in and fade-out (prop 4: a gain, 0..1) at this value of its sheet's parameter"""
        g = 1.0
        for pr in inst["props"]:
            if pr["prop"] != 4:
                continue
            for c in pr["ctrls"]:
                ct = self.ctrls[c]
                if self.param_name(ct["param"]) != param:
                    raise ValueError(f"an instrument fade on {self.param_name(ct['param'])!r}, not on its sheet's {param!r}")
                g *= fmod_map(self.maps[pr["map"]], fmod_curve(self.curves[ct["curve"]], x))
        return g

    def fade_breaks(self, inst: dict[str, Any]) -> list[tuple[float, float, float]]:
        """Every point of an instrument's fade curves"""
        return [p for pr in inst["props"] if pr["prop"] == 4 for c in pr["ctrls"] for p in self.curves[self.ctrls[c]["curve"]]]


def _uuid_bytes(text: str) -> bytes:
    import uuid

    return uuid.UUID(text).bytes_le


def _curve_grid(lo: float, hi: float, points: list[tuple[float, float, float]]) -> list[float]:
    """Where to sample curves on [lo, hi]: both ends, every point, and steps along each bent segment (finer the more it
    bends) so that a linear table follows the curve within 1 % of full gain"""
    xs = {lo, hi}
    for (x0, _y0, s0), (x1, _y1, _s1) in zip(points, points[1:]):
        n = 1 if abs(s0) < 1e-6 else int(np.ceil(4 + 16 * abs(s0)))
        xs.update(float(v) for v in np.linspace(x0, x1, n + 1))
    xs.update(p[0] for p in points)
    return sorted(x for x in xs if lo <= x <= hi)


def bank_engine_view(tables: FmodEventTables, event: str, fixed: dict[str, float]) -> dict[str, Any]:
    """One view's engine (an engine_int or engine_ext event) as the bank mixes it, with the parameters other than rpm
    and throttle held at `fixed` (the cone angle a view is heard from). Per layer ("on": the tracks the throttle opens,
    "off": the ones it closes): the throttle's gain on it, and its recordings, each with its root (the rpm at which it
    plays at its own pitch) and its gain over rpm: the fades, the instrument's and track's volume at `fixed` and the
    event's master volume. Tracks `fixed` silences are left out. One recording played by several instruments of a layer
    is one loop: instruments with the same range and start offset play in step (their gains add), the others add as
    unrelated sounds (in power)"""
    ev_guid = tables.event(event)
    ev = tables.events[ev_guid]
    master = tables.buses[ev["master"]]
    master_db = master["volumeDb"]
    for pr in master["props"]:
        if pr["prop"] == 0 and pr["ctrls"]:
            raise ValueError(f"{event}: its master volume is automated, which this port does not follow")
    # The master's effects (a panner, a distance filter, an EQ or low-pass) are not applied: report what their automation
    # on the held parameters sets them to, so a view held where one closes (engine_ext's cone-angle low-pass, ~5.4 kHz at
    # 180 degrees, open at 30 and below) is seen
    effects_note = []
    for fx_guid in master["effects"]:
        fx = tables.effects.get(fx_guid)
        for pr in fx["props"] if fx else []:
            for c in pr["ctrls"]:
                pname = tables.param_name(tables.ctrls[c]["param"])
                if pname in fixed:
                    value = fmod_map(tables.maps[pr["map"]], fmod_curve(tables.curves[tables.ctrls[c]["curve"]], fixed[pname]))
                    effects_note.append(f"DSP type {fx['dsp']} parameter {pr['prop'] - 1000 if pr['prop'] >= 1000 else pr['prop']} = {value:g} at {pname} {fixed[pname]:g}")
    sheets = [s for s in tables.sheets if s["event"] == ev_guid and s["entries"]]
    if len(sheets) != 1 or tables.param_name(sheets[0]["param"]) != "rpms":
        raise ValueError(f"{event}: instruments on sheets other than one 'rpms' sheet")
    rpm_param = tables.params[sheets[0]["param"]]
    rpm_max = rpm_param["max"]
    # Tracks: the throttle's part of each volume and the rest (at `fixed`); on or off by which end of the pedal is louder
    tracks: dict[bytes, dict[str, Any]] = {}
    for g, bus in tables.buses.items():
        if bus["out"] != ev["master"]:
            continue
        def at(t: float, bus: dict[str, Any] = bus) -> float:
            return tables.volume_db(bus, {"throttle": t, **fixed}, vary="throttle")

        if abs(at(1.0) - at(0.0)) < 1.0:
            raise ValueError(f"{event}: a track the throttle does not open or close")
        static_db = tables.volume_db(bus, {"throttle": 0.0, **fixed}) - at(0.0)
        tracks[g] = {"layer": "on" if at(1.0) > at(0.0) else "off", "throttleDb": at, "staticDb": static_db, "bus": bus}
    layers: dict[str, dict[str, Any]] = {"on": {"recordings": {}, "throttle": None}, "off": {"recordings": {}, "throttle": None}}
    silent: list[str] = []
    for inst_guid, start, length in sheets[0]["entries"]:
        inst = tables.insts.get(inst_guid)
        if inst is None or inst["wav"] is None:
            raise ValueError(f"{event}: an instrument on the rpm sheet that is no single recording (a multi instrument)")
        if tables.param_name(inst["autopitchParam"]) != "rpms" or inst["root"] <= 0:
            raise ValueError(f"{event}: an instrument without autopitch on rpm")
        if abs(inst["pitch"]) > 1e-6:
            raise ValueError(f"{event}: an instrument with a pitch offset")
        track = tracks.get(inst["bus"])
        if track is None:
            raise ValueError(f"{event}: an instrument on a bus that is no track of the event")
        level_db = track["staticDb"] + FMOD_INST_VOLUME_TIMES * inst["volumeDb"] + master_db
        if level_db < -60:
            silent.append(f"{tables.wav_index[inst['wav']]}@{start:.0f}")
            continue
        layer = layers[track["layer"]]
        # One throttle curve per layer: the player has one on-load and one overrun gain
        curve = [round(track["throttleDb"](t), 3) for t in np.linspace(0, 1, 41)]
        if layer["throttle"] is None:
            layer["throttle"] = (curve, track["throttleDb"])
        elif layer["throttle"][0] != curve:
            raise ValueError(f"{event}: two {track['layer']} tracks with different throttle curves")
        sample = tables.wav_index[inst["wav"]]
        rec = layer["recordings"].setdefault((sample, round(inst["root"], 1)), {"sample": sample, "root": inst["root"], "instances": []})
        rec["instances"].append({"start": start, "end": start + length, "offset": inst["startOffsetPct"], "levelDb": level_db, "inst": inst})
    out: dict[str, Any] = {"masterDb": master_db, "silent": silent, "layers": {}, "effectsNotApplied": effects_note}
    for name, layer in layers.items():
        if layer["throttle"] is None:
            raise ValueError(f"{event}: no {name} track at {fixed}")
        at = layer["throttle"][1]
        ts = _curve_grid(0.0, 1.0, [p for tr in tracks.values() if tr["layer"] == name for p in _throttle_points(tables, tr["bus"])])
        # A fader at its floor (-80 dB) is silence: 0, so the player stops the layer's loops instead of running them
        throttle_gain = [(t, 0.0 if at(t) <= -79.9 else 10 ** (at(t) / 20)) for t in ts]
        recordings = []
        for rec in layer["recordings"].values():
            xs: set[float] = set()
            for inst in rec["instances"]:
                # A range that runs to the parameter's end (stored as 20000.0005 for 20000) is open there
                if inst["end"] >= rpm_max - 0.01:
                    inst["end"] = float("inf")
                lo, hi = inst["start"], min(inst["end"], rpm_max)
                xs.update(_curve_grid(lo, hi, tables.fade_breaks(inst["inst"]) or [(lo, 0, 0), (hi, 0, 0)]))
                # Silent outside its range: a step where the range ends on a sounding instrument
                if lo > rpm_param["min"]:
                    xs.add(lo - 0.5)
                if hi < rpm_max:
                    xs.add(hi + 0.5)
                    xs.add(hi - 0.5)

            def gain(x: float, rec: dict[str, Any] = rec) -> float:
                groups: dict[tuple[float, float, float], float] = {}
                for inst in rec["instances"]:
                    if inst["start"] <= x < inst["end"]:
                        k = (inst["start"], inst["end"], inst["offset"])
                        groups[k] = groups.get(k, 0.0) + 10 ** (inst["levelDb"] / 20) * tables.fade(inst["inst"], "rpms", x)
                return float(np.sqrt(sum(v * v for v in groups.values())))

            table = [(x, gain(x)) for x in sorted(xs)]
            # Only the points that shape it: drop runs of zeros inside, keep their edges
            kept = [p for i, p in enumerate(table) if p[1] > 1e-6 or (i > 0 and table[i - 1][1] > 1e-6) or (i + 1 < len(table) and table[i + 1][1] > 1e-6)]
            recordings.append({
                "sample": rec["sample"], "root": rec["root"], "gain": kept, "instances": len(rec["instances"]),
                "offsetPct": min(inst["offset"] for inst in rec["instances"]),
            })
        recordings.sort(key=lambda r: r["root"])
        roots = [round(r["root"]) for r in recordings]
        if len(set(roots)) != len(roots):
            raise ValueError(f"{event} {name}: two recordings share a root rpm (the player keys loops by it)")
        out["layers"][name] = {"throttleGain": throttle_gain, "recordings": recordings}
    return out


def _throttle_points(tables: FmodEventTables, bus: dict[str, Any]) -> list[tuple[float, float, float]]:
    return [
        p
        for pr in bus["props"]
        if pr["prop"] == 0
        for c in pr["ctrls"]
        if tables.param_name(tables.ctrls[c]["param"]) == "throttle"
        for p in tables.curves[tables.ctrls[c]["curve"]]
    ]


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


def pitch_resample(
    x: np.ndarray, anchor_rpm: float, root_rpm: float, ratio_range: tuple[float, float] = (0.58, 1.65)
) -> np.ndarray:
    """
    Resample audio captured at root_rpm so that playing it at 1.0x corresponds to anchor_rpm.
    When LoopGrid plays at rate = rpm / anchor_rpm, the resulting pitch is rpm / root_rpm.
    """
    if root_rpm <= 0 or anchor_rpm <= 0 or abs(anchor_rpm - root_rpm) / root_rpm < 0.005:
        return x
    # Clamp extreme pitch shifts during offline bake to [0.58, 1.65] so formants stay natural, unless the car's config
    # widens it (`resampleRange`: a bank whose FMOD autopitch roots sit far from where it plays a recording)
    ratio = float(np.clip(anchor_rpm / root_rpm, ratio_range[0], ratio_range[1]))
    new_len = max(64, int(round(len(x) / ratio)))
    old_idx = np.linspace(0.0, len(x) - 1, new_len, dtype=np.float64)
    i0 = np.floor(old_idx).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(x) - 1)
    frac = (old_idx - i0)[:, None].astype(np.float32)
    return (x[i0] * (1.0 - frac) + x[i1] * frac).astype(np.float32)


def biquad_coeffs(stage: dict[str, Any], sr: int = RATE) -> tuple[np.ndarray, np.ndarray]:
    """
    One EQ stage as biquad coefficients, by the Audio EQ Cookbook formulas Web Audio's BiquadFilterNode uses:
    {"type": "lowshelf" | "highshelf", "hz", "db"} (shelf slope 1) or {"type": "peaking", "hz", "db"} with "q" or
    "octaves" (an FMOD ParamEQ's bandwidth)
    """
    kind = stage["type"]
    w0 = 2.0 * np.pi * float(stage["hz"]) / sr
    cw, sw = np.cos(w0), np.sin(w0)
    a = 10.0 ** (float(stage["db"]) / 40.0)
    if kind == "peaking":
        if "octaves" in stage:
            alpha = sw * np.sinh(np.log(2.0) / 2.0 * float(stage["octaves"]) * w0 / sw)
        else:
            alpha = sw / (2.0 * float(stage.get("q", 1.0)))
        b = [1 + alpha * a, -2 * cw, 1 - alpha * a]
        den = [1 + alpha / a, -2 * cw, 1 - alpha / a]
    elif kind in ("lowshelf", "highshelf"):
        alpha = sw / 2.0 * np.sqrt(2.0)
        k = 2.0 * np.sqrt(a) * alpha
        if kind == "lowshelf":
            b = [a * ((a + 1) - (a - 1) * cw + k), 2 * a * ((a - 1) - (a + 1) * cw), a * ((a + 1) - (a - 1) * cw - k)]
            den = [(a + 1) + (a - 1) * cw + k, -2 * ((a - 1) + (a + 1) * cw), (a + 1) + (a - 1) * cw - k]
        else:
            b = [a * ((a + 1) + (a - 1) * cw + k), -2 * a * ((a - 1) + (a + 1) * cw), a * ((a + 1) + (a - 1) * cw - k)]
            den = [(a + 1) - (a - 1) * cw + k, 2 * ((a - 1) - (a + 1) * cw), (a + 1) - (a - 1) * cw - k]
    else:
        raise ValueError(f"Unknown EQ stage type '{kind}'")
    return np.array(b) / den[0], np.array(den) / den[0]


def apply_eq(x: np.ndarray, stages: list[dict[str, Any]], sr: int = RATE) -> np.ndarray:
    """Runs a recording through EQ stages in order (`viewEq`: the EQ an FMOD event's mixer puts on one view)."""
    y = ensure_2d(x).astype(np.float64)
    for stage in stages:
        b, a = biquad_coeffs(stage, sr)
        y = signal.lfilter(b, a, y, axis=0)
    return y.astype(np.float32)


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
    g_out, g_in = np.cos(t * np.pi * 0.5), np.sin(t * np.pi * 0.5)
    # Equal-power weights keep the level of two unrelated signals, but the tail and head were just lined up to be in
    # phase: partly the same steady tone, they swelled by up to 3 dB mid-fade, once every loop (a pulse in the engine
    # every 2.4 s). Their correlation over the fade, per channel, sets how much of that to take back, as
    # build_custom_soundbank.make_cycle_loop does
    tc = tail - tail.mean(axis=0, keepdims=True)
    hc = head - head.mean(axis=0, keepdims=True)
    corr = np.sum(tc * hc, axis=0) / (np.linalg.norm(tc, axis=0) * np.linalg.norm(hc, axis=0) + 1e-12)
    comp = 1.0 / np.sqrt(1.0 + 2.0 * np.clip(corr, 0.0, 1.0)[None, :] * g_out * g_in)
    z[:xf_n] = (tail * g_out + head * g_in) * comp

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

    def __init__(self, bank_path: str | Path, ffmpeg: str = FFMPEG_DEFAULT, raw_pcm16: bool = False) -> None:
        self.bank_path = Path(bank_path)
        self.ffmpeg = ffmpeg
        self.raw_pcm16 = raw_pcm16
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
            arr, _ = decode_sample(fsb, s, RATE, self.ffmpeg, self.raw_pcm16)
            self._cache[idx] = arr
        return self.items[idx][1].name, self._cache[idx]


# A loop file's level when its gain table carries the bank's own level, and the on-load mix's average level at full
# throttle (both the middle of the repository's level curve, 0.165 to 0.22)
BANK_MIX_FILE_RMS = 0.2
BANK_MIX_RMS = 0.2


def fold_stereo(x: np.ndarray) -> np.ndarray:
    """A stereo recording folded to the centre, (L + R) / sqrt 2: what FMOD's spatialiser makes of it as a point source"""
    x = ensure_2d(x)
    return x if x.shape[1] == 1 else ((x[:, :1] + x[:, 1:2]) / np.sqrt(2.0)).astype(np.float32)


def _table_at(table: list[tuple[float, float]] | list[list[float]], x: float) -> float:
    return float(np.interp(x, [p[0] for p in table], [p[1] for p in table]))


def port_engine_from_bank(
    cfg: dict[str, Any], out_dir: Path, int_bank: LazyBank, ext_bank: LazyBank, ffmpeg: str, manifest: dict[str, Any],
    used_samples: set[str],
) -> dict[str, Any]:
    """
    The engine as the bank's own FMOD events play it (`engineFromBank`: per view, the event and the parameters held
    fixed, e.g. {"int": {"event": "engine_int"}, "ext": {"event": "engine_ext", "fixed": {"Event Cone Angle": 0}}}).

    Each recording an event plays becomes one loop at its own pitch, keyed by its autopitch root, with a `gain` table
    over rpm: its fades and volumes as the event mixes them (bank_engine_view). The player sounds every loop of a layer
    at once, each at its gain and at rate rpm / root, as FMOD does: no anchor crossfade, so no recording ever plays
    against a copy of itself. The throttle's gain on each layer is `throttleGain`; `throttleCurve` is fitted to it for
    what follows the on/off blend elsewhere (the transmission). Levels: a loop file sits at BANK_MIX_FILE_RMS and its
    table carries the recording's own level, the event's volumes, and one scale per view that puts the on-load mix at
    full throttle, averaged from idle (`idleRpm`, else the lowest root) to the limiter, at BANK_MIX_RMS: the bank's balance across
    rpm and between on and off load is kept, while every bank still plays at the same loudness
    """
    spec = cfg["engineFromBank"]
    limiter = float(cfg["limiterRpm"])
    manifest["throttleGain"] = {}
    manifest["throttleCurve"] = {}
    manifest["flatEngine"] = True
    specs: dict[str, dict[str, list[str]]] = {}
    # Per view, what a recording's level in the bank is multiplied by in the manifest: the bank's other events
    # (`eventsFromBank`) play on the same scale, so they keep their level against the engine
    scales: dict[str, float] = {}
    max_jump = 0.0
    for view, bank in (("int", int_bank), ("ext", ext_bank)):
        vs = spec[view]
        mix = bank_engine_view(FmodEventTables(bank.bank_path), vs["event"], vs.get("fixed", {}))
        made: dict[str, list[tuple[dict[str, Any], str, np.ndarray, float]]] = {}
        for layer in ("on", "off"):
            made[layer] = []
            for rec in mix["layers"][layer]["recordings"]:
                sname, raw_x = bank.get(int(rec["sample"]))
                # `foldStereo`: the events' spatialiser plays the engine as a point source, its recordings folded to
                # the centre (the FMOD runtime's cockpit engine comes out with L = R)
                if spec.get("foldStereo"):
                    raw_x = fold_stereo(raw_x)
                used_samples.add(f"{view}:{sname}")
                # The loop from the opening seconds after the start offset (BANK_LOOP_FROM_S); its level the whole
                # recording's, as FMOD loops all of it
                first = int(len(raw_x) * rec["offsetPct"] / 100.0)
                part = raw_x[first : first + int(BANK_LOOP_FROM_S * RATE)]
                part = part if len(part) >= int((LOOP_S + XFADE_S + 0.05) * RATE) else raw_x
                made[layer].append((rec, sname, make_seamless_loop(part, LOOP_S, XFADE_S, RATE), rms(raw_x)))
        # The on-load mix at full throttle, its power averaged from idle to the limiter (the recordings are unrelated
        # sounds: their powers add)
        on_full = _table_at(mix["layers"]["on"]["throttleGain"], 1.0)
        idle = float(cfg.get("idleRpm") or min(rec["root"] for rec, *_ in made["on"]))
        grid = np.arange(idle, limiter + 1.0, 250.0)
        power = [sum((native * _table_at(rec["gain"], r) * on_full) ** 2 for rec, _n, _l, native in made["on"]) for r in grid]
        scale = BANK_MIX_RMS / max(1e-9, float(np.sqrt(np.mean(power))))
        scales[view] = scale
        specs[view] = {}
        for layer in ("on", "off"):
            specs[view][layer] = []
            for rec, sname, loop, native in made[layer]:
                loop = level_signal(loop, BANK_MIX_FILE_RMS)
                k = scale * native / max(1e-9, rms(loop))
                max_jump = max(max_jump, float(np.max(np.abs(loop[0] - loop[-1]))))
                root = round(float(rec["root"]), 1)
                fn = f"engine_{view}_{layer}_{int(round(root))}.ogg"
                ch = encode_ogg(ffmpeg, loop, out_dir / fn, quality=4)
                manifest["engine"][view].append(
                    {
                        "file": fn,
                        "fsbName": sname,
                        "layer": layer,
                        "rpm": int(root) if root == int(root) else root,
                        "channels": ch,
                        "rms": round(rms(loop), 4),
                        "gain": [[round(x, 1), round(g * k, 5)] for x, g in rec["gain"]],
                    }
                )
                specs[view][layer].append(f"{sname}#{rec['sample']}")
        # The highest recording last (the derived one-shots take it)
        for layer in ("on", "off"):
            pairs = sorted(zip([r["root"] for r, *_ in made[layer]], specs[view][layer]))
            specs[view][layer] = [s for _, s in pairs]
        tg = {layer: [[round(t, 4), round(g, 5)] for t, g in mix["layers"][layer]["throttleGain"]] for layer in ("on", "off")}
        manifest["throttleGain"][view] = tg
        # The blend that one sin/cos pair would give: atan2 of the two gains, rising from [0, 0] to [1, 1]
        ts = sorted({p[0] for layer in tg.values() for p in layer})
        onness = [float(np.arctan2(_table_at(tg["on"], t), _table_at(tg["off"], t)) / (np.pi / 2)) for t in ts]
        onness = list(np.maximum.accumulate(np.clip(onness, 0.0, 1.0)))
        onness[0], onness[-1] = 0.0, 1.0
        curve = [[0.0, 0.0]] + [[round(t, 4), round(o, 4)] for t, o in zip(ts[1:-1], onness[1:-1])] + [[1.0, 1.0]]
        manifest["throttleCurve"][view] = curve
        print(
            f"[port_ac_bank] {view}: {vs['event']} at {vs.get('fixed', {})}: master {mix['masterDb']:+.1f} dB, "
            f"{sum(len(m) for m in made.values())} recordings, {len(mix['silent'])} instruments silent there, scale {scale:.3f}"
            + "".join(f"\n  master effect not applied: {n}" for n in mix["effectsNotApplied"]),
            file=sys.stderr,
        )
    # `ext.front`: the outside heard from ahead of the car as well. engine_ext's tracks are a rear set, full at the cone
    # angle the view is held at (0: behind the car), and a front set, full at 120 degrees and over; at `front` (the
    # front's own angle) the front set's recordings are ported on the outside scale as `engineFront`, and `cone` gives
    # each set's gain over the cone angle (its tracks' cone curves, against the angle it was ported at) and the master's
    # cone low-pass (Hz), so a listener anywhere round the car hears the two sets as the event mixes them
    front = spec["ext"].get("front")
    if front:
        bank = ext_bank
        tables = FmodEventTables(bank.bank_path)
        mix = bank_engine_view(tables, spec["ext"]["event"], front)
        angle_param = "Event Cone Angle"
        manifest["engineFront"] = []
        for layer in ("on", "off"):
            for rec in mix["layers"][layer]["recordings"]:
                sname, raw_x = bank.get(int(rec["sample"]))
                if spec.get("foldStereo"):
                    raw_x = fold_stereo(raw_x)
                used_samples.add(f"extFront:{sname}")
                first = int(len(raw_x) * rec["offsetPct"] / 100.0)
                part = raw_x[first : first + int(BANK_LOOP_FROM_S * RATE)]
                part = part if len(part) >= int((LOOP_S + XFADE_S + 0.05) * RATE) else raw_x
                loop = level_signal(make_seamless_loop(part, LOOP_S, XFADE_S, RATE), BANK_MIX_FILE_RMS)
                k = scales["ext"] * rms(raw_x) / max(1e-9, rms(loop))
                root = round(float(rec["root"]), 1)
                fn = f"engine_extFront_{layer}_{int(round(root))}.ogg"
                ch = encode_ogg(ffmpeg, loop, out_dir / fn, quality=4)
                manifest["engineFront"].append({
                    "file": fn, "fsbName": sname, "layer": layer, "rpm": int(root) if root == int(root) else root, "channels": ch,
                    "rms": round(rms(loop), 4), "gain": [[round(x, 1), round(g * k, 5)] for x, g in rec["gain"]],
                })
        ev_master = tables.events[tables.event(spec["ext"]["event"])]["master"]
        sets: dict[str, list[tuple[float, float, float]]] = {}
        curve_of: dict[str, tuple[bytes, bytes]] = {}
        for bus in tables.buses.values():
            if bus["out"] != ev_master:
                continue
            for pr in bus["props"]:
                for c in pr["ctrls"]:
                    ct = tables.ctrls[c]
                    if pr["prop"] == 0 and tables.param_name(ct["param"]) == angle_param:
                        pts = tables.curves[ct["curve"]]
                        name = "rear" if pts[0][1] > pts[-1][1] else "front"
                        sets.setdefault(name, pts)
                        curve_of[name] = (pr["map"], ct["curve"])
        if set(sets) != {"rear", "front"}:
            raise ValueError(f"{spec['ext']['event']}: no rear and front track sets on the cone angle")
        ref = {"rear": float(spec["ext"].get("fixed", {}).get(angle_param, 0.0)), "front": float(front[angle_param])}

        def set_db(name: str, a: float) -> float:
            mp, cv = curve_of[name]
            return fmod_map(tables.maps[mp], fmod_curve_at(tables.curves[cv], tables.curve_kinds[cv], a))

        angles = _curve_grid(0.0, 180.0, [p for pts in sets.values() for p in pts])
        manifest["cone"] = {
            name: [[round(a, 2), round(_db_to_gain(set_db(name, a) - set_db(name, ref[name])), 5)] for a in angles] for name in ("rear", "front")
        }
        manifest["throttleGainFront"] = {
            layer: [[round(t, 4), round(g, 5)] for t, g in mix["layers"][layer]["throttleGain"]] for layer in ("on", "off")
        }
        # The master's cone low-pass (a DSP of type 3, its parameter 0 the cutoff through its Hz map)
        lp = []
        for fx_guid in tables.buses[ev_master]["effects"]:
            fx = tables.effects.get(fx_guid)
            for pr in fx["props"] if fx and fx["dsp"] == 3 else []:
                for c in pr["ctrls"]:
                    ct = tables.ctrls[c]
                    if tables.param_name(ct["param"]) == angle_param:
                        pts = tables.curves[ct["curve"]]
                        a_grid = _curve_grid(0.0, 180.0, pts)
                        lp = [[round(a, 2), round(fmod_map(tables.maps[pr["map"]], fmod_curve_at(pts, tables.curve_kinds[ct["curve"]], a)), 1)] for a in a_grid]
        if lp:
            manifest["cone"]["lowpassHz"] = lp
        print(f"[port_ac_bank] extFront: {spec['ext']['event']} at {front}: {len(manifest['engineFront'])} recordings", file=sys.stderr)
    roots = {e["fsbName"]: float(e["rpm"]) for e in manifest["engine"]["int"]}
    return {"specs": specs, "maxBoundaryJump": max_jump, "roots": roots, "scales": scales}


# ---------------------------------------------------------------------------------------------------------------------
# The bank's other events (`eventsFromBank`), read from the same tables as its engine: the transmission, the gear
# changes, the backfires, the skids, the traction control's cut, the wind, the tyres rolling and the bodywork, each at
# its own pitch and curves and at its own level against the engine (on the view's engine scale). An instrument's level is
# its own volume (counted twice, as on the engine's sheet) and its volume curves, plus every bus's from its track up to
# the event's master, a bus's curves replacing its own volume. A stereo recording is heard folded to the centre
# ((L + R) / sqrt 2: the events' spatialiser plays a point source), and what each event's spatialiser does beyond that
# at the reference listener is `spatialDb` (measured with the FMOD runtime). Pitches are in semitones
# ---------------------------------------------------------------------------------------------------------------------


def _db_to_gain(db: float) -> float:
    return 0.0 if db <= -79.9 else float(10.0 ** (db / 20.0))


def event_instruments(tables: FmodEventTables, name: str) -> list[dict[str, Any]]:
    """An event's instruments (single recordings and multi instruments, on its timeline or on a parameter sheet), each
    with its buses from its track up to the event's master (`chain`) and its sheet (parameter, start, end) or None"""
    ev_guid = tables.event(name)
    master = tables.events[ev_guid]["master"]

    def chain(bus: bytes) -> list[dict[str, Any]] | None:
        out, g = [], bus
        for _ in range(8):
            if g not in tables.buses:
                return None
            out.append(tables.buses[g])
            if g == master:
                return out
            g = tables.buses[g]["out"]
        return None

    sheet_of: dict[bytes, tuple[str, float, float]] = {}
    for sh in tables.sheets:
        if sh["event"] == ev_guid:
            pmax = tables.params[sh["param"]]["max"]
            for inst_guid, start, length in sh["entries"]:
                end = start + length
                # A range that runs to the parameter's end is open there
                sheet_of[inst_guid] = (tables.param_name(sh["param"]), start, float("inf") if end >= pmax - 0.01 else end)
    in_playlists = {g for inst in tables.insts.values() for g in inst["playlist"]}
    out = []
    for g, inst in tables.insts.items():
        c = chain(inst["bus"])
        if c is None or g in in_playlists:
            continue
        out.append({**inst, "guid": g, "chain": c, "sheet": sheet_of.get(g)})
    return out


def _auto_db(tables: FmodEventTables, obj: dict[str, Any], values: dict[str, float]) -> float | None:
    """An object's volume automation (prop 0) at these values, its curves mapped to dB and summed; None when it has
    none. Curves on the event's timeline (no parameter: the stock backfire track has one) are left out, as the runtime
    playing the bank does"""
    db, found = 0.0, False
    for pr in obj["props"]:
        if pr["prop"] != 0:
            continue
        for c in pr["ctrls"]:
            ct = tables.ctrls[c]
            if ct["param"] not in tables.params:
                continue
            pname = tables.param_name(ct["param"])
            if pname not in values:
                raise ValueError(f"a volume curve on parameter {pname!r}, which the config does not set")
            db += fmod_map(tables.maps[pr["map"]], fmod_curve_at(tables.curves[ct["curve"]], tables.curve_kinds[ct["curve"]], values[pname]))
            found = True
    return db if found else None


def instrument_level_db(tables: FmodEventTables, inst: dict[str, Any], values: dict[str, float]) -> float:
    """An instrument's level as its event plays it at these parameter values (dB), its fades included. Its own volume
    counts twice and its volume curves add to it (measured: the transmission's -6 dB instrument under a 0 dB curve
    plays at -12 dB); a bus's curves replace its own volume"""
    own = _auto_db(tables, inst, values)
    db = FMOD_INST_VOLUME_TIMES * inst["volumeDb"] + (own or 0.0)
    for bus in inst["chain"]:
        auto = _auto_db(tables, bus, values)
        db += auto if auto is not None else bus["volumeDb"]
    if inst["sheet"] and any(pr["prop"] == 4 and pr["ctrls"] for pr in inst["props"]):
        fade = tables.fade(inst, inst["sheet"][0], values[inst["sheet"][0]])
        db += 20.0 * np.log10(fade) if fade > 1e-6 else -80.0
    return max(-80.0, db)


def instrument_pitch_st(tables: FmodEventTables, inst: dict[str, Any], values: dict[str, float]) -> float:
    """An instrument's pitch (semitones): its own, and the pitch curves (prop 1) on it and its buses"""
    st = inst["pitch"]
    for obj in [inst] + inst["chain"]:
        for pr in obj["props"]:
            if pr["prop"] != 1:
                continue
            for c in pr["ctrls"]:
                ct = tables.ctrls[c]
                st += fmod_map(tables.maps[pr["map"]], fmod_curve_at(tables.curves[ct["curve"]], tables.curve_kinds[ct["curve"]], values[tables.param_name(ct["param"])]))
    return st


def instrument_pitch_jitter_st(tables: FmodEventTables, inst: dict[str, Any]) -> float:
    """The widest random pitch modulator (prop 1) on an instrument or its buses (semitones either way), 0 for none. A
    random modulator's body: u32 1, u32 1, u16 8, then its lowest and highest offset (f32)"""
    jitter = 0.0
    for obj in [inst] + inst["chain"]:
        for pr in obj["props"]:
            if pr["prop"] != 1:
                continue
            for m in pr["mods"]:
                d = tables.mods.get(m, b"")
                if len(d) >= 18 and struct.unpack_from("<I", d, 0)[0] == 1:
                    lo, hi = struct.unpack_from("<ff", d, 10)
                    jitter = max(jitter, abs(lo), abs(hi))
    return jitter


def instrument_attack(tables: FmodEventTables, inst: dict[str, Any]) -> tuple[float, float] | None:
    """An AHDSR modulator on the volume (prop 0) of an instrument or its buses: (its starting level in dB, its attack in
    s), None for none. Its body: u32 0, u32 0, u16, then f32 starting level, two f32, f32 attack, f32 hold, f32 decay,
    f32 release (the stock outside backfire: -42 dB over 0.05 s, which the runtime's output fits best)"""
    for obj in [inst] + inst["chain"]:
        for pr in obj["props"]:
            if pr["prop"] != 0:
                continue
            for m in pr["mods"]:
                d = tables.mods.get(m, b"")
                if len(d) >= 26 and struct.unpack_from("<I", d, 0)[0] == 0:
                    start_db, attack = struct.unpack_from("<f", d, 10)[0], struct.unpack_from("<f", d, 22)[0]
                    if attack > 0:
                        return float(start_db), float(attack)
    return None


def _on_sheet(inst: dict[str, Any], values: dict[str, float]) -> bool:
    if inst["sheet"] is None:
        return True
    pname, start, end = inst["sheet"]
    return start <= values[pname] < end


def _curve_points(tables: FmodEventTables, inst: dict[str, Any], param: str) -> list[tuple[float, float, float]]:
    """Every point of the curves on `param`, on the instrument and its buses, volume and pitch alike"""
    return [
        p
        for obj in [inst] + inst["chain"]
        for pr in obj["props"]
        for c in pr["ctrls"]
        if tables.ctrls[c]["param"] in tables.params and tables.param_name(tables.ctrls[c]["param"]) == param
        for p in tables.curves[tables.ctrls[c]["curve"]]
    ]


def port_events_from_bank(
    cfg: dict[str, Any], out_dir: Path, bank: LazyBank, ffmpeg: str, manifest: dict[str, Any], scales: dict[str, float],
    used_samples: set[str],
) -> None:
    """
    The bank's other events as it plays them (`eventsFromBank`), on the engine's scale per view (`scales`, from
    port_engine_from_bank): a level x in the bank plays at scales[view] * x, as the engine's recordings do. Each section
    names its event(s); "ext" levels also take the event's loss at the chase camera's distance (`outsideDb`, measured
    with the runtime: the engine loses nothing there). The car's sounds.ini values come in `soundsIni`.

    - transmission: its one recording, pitched by road speed (`drivetrainSpeed` its root), a `gain` table over speed and
      `transmissionMix` (the throttle's gain on it, the view's scale)
    - gear: per view an up-shift and a down-shift one-shot (the event's `state` parameter: 1 up, 0 down) at their own
      pitch (`rate`) and level (`gain`)
    - backfire: the multi instruments' recordings per view, with `backfire` (the sounds.ini trigger, the throttle's gain
      on the event, the chance it plays, the random pitch)
    - skid, tractionControl: loops per view at their pitch and level (sounds.ini MIX_VOLUME on the skid), the cut's
      release from the event's `decay` curve
    - wind, tyreRolling, bodywork: one loop each, with `gain` and `rate` tables over road speed (the suspension's travel
      speed for the bodywork)
    - silent: events that must play nothing (the port stops if one does), listed as `silentEvents`
    """
    spec = cfg["eventsFromBank"]
    ini = cfg.get("soundsIni", {})
    tables = FmodEventTables(bank.bank_path)
    outside_db = spec.get("outsideDb", {})
    spatial_db = spec.get("spatialDb", {})
    engine_events = {v: cfg["engineFromBank"][v]["event"] for v in ("int", "ext")}
    lin = _db_to_gain
    raw_bank = bank

    class Folded:
        """The bank's recordings folded to the centre (fold_stereo), as the events' spatialiser plays them"""

        bank_path = raw_bank.bank_path

        @staticmethod
        def get(idx: int) -> tuple[str, np.ndarray]:
            name, x = raw_bank.get(idx)
            return name, fold_stereo(x)

    bank = Folded()

    def at_view(view: str, event: str, db: float) -> float:
        # Against the view's engine: what each one's spatialiser adds at the reference listener, and outside the loss
        # at the chase camera's distance
        rel = spatial_db.get(event, 0.0) - spatial_db.get(engine_events[view], 0.0)
        return scales[view] * lin(db + rel + (outside_db.get(event, 0.0) if view == "ext" else 0.0))

    def wav_of(inst: dict[str, Any]) -> int:
        return int(tables.wav_index[inst["wav"]])

    def sounding(insts: list[dict[str, Any]], values: dict[str, float]) -> list[dict[str, Any]]:
        return [i for i in insts if _on_sheet(i, values) and instrument_level_db(tables, i, values) > -60.0]

    def loop_file(fn: str, x: np.ndarray) -> tuple[np.ndarray, int]:
        loop = level_signal(make_seamless_loop(x, LOOP_S, XFADE_S, RATE), BANK_MIX_FILE_RMS)
        return loop, encode_ogg(ffmpeg, loop, out_dir / fn, quality=4)

    def oneshot(role: str, idx: int, gain_at_raw: float, rate: float, n: int | None = None, attack: tuple[float, float] | None = None) -> dict[str, Any]:
        """A one-shot cut from recording `idx`, its `gain` what plays the recording at `gain_at_raw` of its own level;
        `attack` (instrument_attack) shapes its start as the event does, from the recording's first sample"""
        sname, raw = bank.get(idx)
        used_samples.add(f"oneshot:{sname}")
        if attack:
            start_db, attack_s = attack
            t = np.arange(len(raw), dtype=np.float32) / RATE
            raw = raw * (10.0 ** (np.minimum(0.0, start_db * (1.0 - t / attack_s)) / 20.0)).astype(np.float32)[:, None]
        clip = prepare_oneshot(raw)
        # prepare_oneshot trims and scales to its peak: playing the clip at `gain` is the raw recording at gain_at_raw
        c = float(np.abs(clip).max()) / max(1e-9, float(np.abs(ensure_2d(raw)).max()))
        fn = f"oneshot_{role}{'' if n is None else f'_{n}'}.ogg"
        ch = encode_ogg(ffmpeg, clip, out_dir / fn, quality=4)
        return {
            "file": fn, "fsbName": sname, "role": role, "channels": ch, "seconds": round(len(clip) / RATE, 3),
            "peak": round(float(np.abs(clip).max()), 3), "gain": round(gain_at_raw / c, 6), "rate": round(rate, 5),
        }

    # Transmission: one recording on the speed sheet, pitched by it; the throttle's curve on its track
    tr = spec.get("transmission")
    if tr:
        speed = tr.get("speedParam", "drivetrain_speed")
        insts = [i for i in event_instruments(tables, tr["event"]) if i["wav"] is not None]
        if len(insts) != 1 or not insts[0]["sheet"] or insts[0]["sheet"][0] != speed or tables.param_name(insts[0]["autopitchParam"]) != speed:
            raise ValueError(f"{tr['event']}: not one recording on the {speed!r} sheet, pitched by it")
        inst = insts[0]
        speed_max = next(p["max"] for p in tables.params.values() if p["name"] == speed)
        xs = _curve_grid(0.0, speed_max, _curve_points(tables, inst, speed) or [(0.0, 0, 0), (speed_max, 0, 0)])
        ts = _curve_grid(0.0, 1.0, _curve_points(tables, inst, "throttle") or [(0.0, 0, 0), (1.0, 0, 0)])
        full = {"throttle": 1.0}
        sname, raw = bank.get(wav_of(inst))
        used_samples.add(f"trans:{sname}")
        # Keyed a little above its root so that 20 to 320 km/h stay within the player's 0.25 to 4 playback rates
        root = float(inst["root"])
        key = float(tr.get("key", root))
        loop, ch = loop_file("transmission.ogg", pitch_resample(raw, key, root, (0.25, 4.0)))
        k = rms(raw) / max(1e-9, rms(loop))
        manifest["transmission"] = [{
            "file": "transmission.ogg", "fsbName": sname, "layer": "on", "drivetrainSpeed": round(key, 1), "channels": ch,
            "rms": round(rms(loop), 4),
            "gain": [[round(x, 1), round(lin(instrument_level_db(tables, inst, {speed: x, **full})) * k, 6)] for x in xs],
        }]
        x0 = 100.0
        manifest["transmissionMix"] = {
            "throttleGain": [[round(t, 4), round(lin(instrument_level_db(tables, inst, {speed: x0, "throttle": t}) - instrument_level_db(tables, inst, {speed: x0, **full})), 5)] for t in ts],
            "view": {v: round(at_view(v, tr["event"], 0.0), 6) for v in ("int", "ext")},
            "maxSpeed": speed_max,
        }

    # Gear changes: the `state` sheet's upper half is an up-shift, its lower half a down-shift
    gear = spec.get("gear")
    if gear:
        for view in ("int", "ext"):
            insts = event_instruments(tables, gear[view])
            for role, state in (("gear_up", 1.0), ("gear_down", 0.0)):
                values = {"state": state, "Distance": float(spec.get("distanceM", 1.0))}
                active = [i for i in sounding(insts, values) if i["wav"] is not None]
                if len(active) != 1:
                    raise ValueError(f"{gear[view]}: {len(active)} recordings at state {state}")
                inst = active[0]
                db = instrument_level_db(tables, inst, values)
                manifest["oneshots"].append(oneshot(f"{role}_{view}", wav_of(inst), at_view(view, gear[view], db), 2.0 ** (instrument_pitch_st(tables, inst, values) / 12.0)))

    # Backfires: one multi instrument per view, played on a lift (sounds.ini [BACKFIRE]); its level at a shut throttle,
    # the throttle's curve on it kept for while it plays
    bf = spec.get("backfire")
    if bf:
        bini = ini.get("backfire", {})
        section: dict[str, Any] = {
            "triggerGas": bini.get("triggerGas", 0.8), "maxGas": bini.get("maxGas", 0.4),
            "minRpm": bini.get("minRpm", 0), "maxRpm": bini.get("maxRpm", 1e9),
            "throttleGain": {}, "chance": {}, "pitchJitterSt": {},
        }
        for view in ("int", "ext"):
            insts = [i for i in event_instruments(tables, bf[view]) if i["playlist"]]
            if len(insts) != 1:
                raise ValueError(f"{bf[view]}: not one multi instrument")
            mu = insts[0]
            values = {"throttle": 0.0, "Event Cone Angle": 0.0}
            db0 = instrument_level_db(tables, mu, values)
            ts = _curve_grid(0.0, 1.0, _curve_points(tables, mu, "throttle") or [(0.0, 0, 0), (1.0, 0, 0)])
            section["throttleGain"][view] = [[round(t, 4), round(lin(instrument_level_db(tables, mu, {**values, "throttle": t}) - db0), 5)] for t in ts]
            section["chance"][view] = round(mu["probability"] / 100.0, 4)
            section["pitchJitterSt"][view] = round(instrument_pitch_jitter_st(tables, mu), 4)
            # sounds.ini VOLUME_IN / VOLUME_OUT: the event's volume inside and outside
            volume = float(bini.get("volumeIn" if view == "int" else "volumeOut", 1.0))
            for n, g in enumerate(mu["playlist"], start=1):
                sub = tables.insts[g]
                sub_db = db0 + FMOD_INST_VOLUME_TIMES * sub["volumeDb"]
                rate = 2.0 ** ((mu["pitch"] + sub["pitch"]) / 12.0)
                manifest["oneshots"].append(oneshot(f"backfire_{view}", int(tables.wav_index[sub["wav"]]), at_view(view, bf[view], sub_db) * volume, rate, n, instrument_attack(tables, mu)))
        manifest["backfire"] = section

    # Skids: a recording per view on the event's timeline, at the sounds.ini mix volume
    sk = spec.get("skid")
    if sk:
        manifest["skid"] = {}
        for view in ("int", "ext"):
            insts = [i for i in event_instruments(tables, sk[view]) if i["wav"] is not None]
            if len(insts) != 1:
                raise ValueError(f"{sk[view]}: not one recording")
            inst = insts[0]
            db = instrument_level_db(tables, inst, {})
            sname, raw = bank.get(wav_of(inst))
            used_samples.add(f"skid:{sname}")
            fn = f"skid_{view}.ogg"
            loop, ch = loop_file(fn, raw)
            manifest["skid"][view] = {
                "file": fn, "fsbName": sname, "channels": ch, "rms": round(rms(loop), 4),
                "gain": round(at_view(view, sk[view], db) * float(ini.get("skidMixVolume", 1.0)) * rms(raw) / rms(loop), 6),
                "rate": round(2.0 ** (instrument_pitch_st(tables, inst, {}) / 12.0), 5),
            }

    # Traction control: its recording looped while the cut is on, per view at its level and pitch; its `decay` curve
    # (the time since the cut, s) is the release
    tc = spec.get("tractionControl")
    if tc:
        entry: dict[str, Any] = {"gain": {}, "rate": {}}
        for view in ("int", "ext"):
            insts = [i for i in event_instruments(tables, tc[view]) if i["wav"] is not None]
            if len(insts) != 1:
                raise ValueError(f"{tc[view]}: not one recording")
            inst = insts[0]
            db = instrument_level_db(tables, inst, {"decay": 0.0})
            sname, raw = bank.get(wav_of(inst))
            if "file" not in entry:
                used_samples.add(f"tc:{sname}")
                loop, ch = loop_file("tc.ogg", raw)
                entry.update(file="tc.ogg", fsbName=sname, channels=ch, rms=round(rms(loop), 4))
                native = rms(raw) / rms(loop)
                ds = _curve_grid(0.0, 1.0, _curve_points(tables, inst, "decay"))
                entry["release"] = [[round(d, 4), round(lin(instrument_level_db(tables, inst, {"decay": d}) - db), 5)] for d in ds if d <= 0.5]
            entry["gain"][view] = round(at_view(view, tc[view], db) * native, 6)
            entry["rate"][view] = round(2.0 ** (instrument_pitch_st(tables, inst, {"decay": 0.0}) / 12.0), 5)
        manifest["tractionControl"] = entry

    # Wind, tyres rolling, bodywork: the recordings that sound at the held parameters, mixed into one loop (they share
    # their track's curves), with gain and rate tables over the driving parameter and, from sounds.ini, the volume AC's
    # SPEED_GAIN / VOLUME_GAIN give the event (min(VOLUME_GAIN, a v + b v^2), v in km/h)
    for key, tag in (("wind", "wind"), ("tyreRolling", "tyre_rolling"), ("bodywork", "bodywork")):
        es = spec.get(key)
        if not es:
            continue
        param = es["param"]
        held = {**es.get("fixed", {})}
        pmax = next(p["max"] for p in tables.params.values() if p["name"] == param)
        insts = [i for i in sounding(event_instruments(tables, es["event"]), {**held, param: pmax * 0.8}) if i["wav"] is not None]
        if not insts:
            raise ValueError(f"{es['event']}: nothing sounds at {held}")
        xs = _curve_grid(0.0, pmax, [p for i in insts for p in _curve_points(tables, i, param)] or [(0.0, 0, 0), (pmax, 0, 0)])
        ref = {**held, param: pmax * 0.8}
        parts = []
        for inst in insts:
            sname, raw = bank.get(wav_of(inst))
            used_samples.add(f"{tag}:{sname}")
            part = level_signal(make_seamless_loop(raw, LOOP_S, XFADE_S, RATE), rms(raw))
            parts.append(ensure_2d(part) * lin(instrument_level_db(tables, inst, ref)))
        width = max(p.shape[1] for p in parts)
        mix = sum(np.repeat(p, width // p.shape[1], axis=1) for p in parts)
        fn = f"{tag}.ogg"
        loop = level_signal(mix, BANK_MIX_FILE_RMS)
        ch = encode_ogg(ffmpeg, loop, out_dir / fn, quality=4)
        k = rms(mix) / rms(loop) / lin(instrument_level_db(tables, insts[0], ref))
        vol = ini.get(key, {})

        def ini_volume(v: float, vol: dict[str, Any] = vol) -> float:
            if not vol:
                return 1.0
            return min(float(vol["volumeGain"]), float(vol.get("speedGain0", 0.0)) * v + float(vol.get("speedGain1", 0.0)) * v * v)

        manifest[key] = {
            "file": fn, "fsbName": "+".join(bank.get(wav_of(i))[0] for i in insts), "channels": ch, "rms": round(rms(loop), 4),
            "param": "bodywork" if key == "bodywork" else "speedKmh",
            # The first recording's curves stand for all: they share the track that carries them
            "gain": [[round(x, 3), round(lin(instrument_level_db(tables, insts[0], {**held, param: x})) * k * ini_volume(x), 6)] for x in xs],
            "rate": [[round(x, 3), round(2.0 ** (instrument_pitch_st(tables, insts[0], {**held, param: x}) / 12.0), 5)] for x in xs],
            "view": {v: round(at_view(v, es["event"], 0.0), 6) for v in ("int", "ext")},
        }

    # Events that must stay silent at the parameters the car gives them
    silent = []
    for name, values in spec.get("silent", {}).items():
        loud = [i for i in event_instruments(tables, name) if _on_sheet(i, values) and instrument_level_db(tables, i, values) > -60.0]
        if loud:
            raise ValueError(f"{name}: {len(loud)} instruments sound at {values}")
        silent.append(name)
    manifest["silentEvents"] = silent


def port_car(car_id: str, cfg: dict[str, Any], ffmpeg: str, banks_root: Path = BANKS_ROOT) -> dict[str, Any]:
    out_dir = REPO_ROOT / cfg["outDir"]
    out_dir.mkdir(parents=True, exist_ok=True)

    int_bank_path = resolve_bank_path(cfg["intBank"], banks_root)
    ext_bank_path = resolve_bank_path(cfg.get("extBank", cfg["intBank"]), banks_root)

    raw_pcm16 = bool(cfg.get("rawPcm16", False))
    int_bank = LazyBank(int_bank_path, ffmpeg, raw_pcm16)
    ext_bank = int_bank if ext_bank_path == int_bank_path else LazyBank(ext_bank_path, ffmpeg, raw_pcm16)

    manifest: dict[str, Any] = {
        "source": cfg["sourceDescription"],
        "sampleRate": RATE,
        "loopSeconds": LOOP_S,
        "engine": {"ext": [], "int": []},
        "turbo": [],
        "transmission": [],
        "oneshots": [],
        "throttleCurve": cfg.get("throttleCurve"),
        # The player's generic lift-off pops; a bank whose backfires come from its own events (`eventsFromBank`) has none
        **({"lift": cfg["lift"]} if "lift" in cfg else {}),
        "limiterRetriggerS": cfg.get("limiterRetriggerS", 0.85),
    }
    if "shift" in cfg:
        manifest["shift"] = cfg["shift"]

    used_samples: set[str] = set()
    max_boundary_jump = 0.0
    lo_hi = cfg.get("resampleRange", [0.58, 1.65])
    resample_range = (float(lo_hi[0]), float(lo_hi[1]))

    # 1. Engine loops (ext and int, on and off). `viewEq`: the EQ the bank's own mixer puts on a view (an outside sound
    # made from the cockpit recordings), run over each loop as heard at its anchor, before it is looped and levelled
    view_eq: dict[str, list[dict[str, Any]]] = cfg.get("viewEq", {})
    # `engineFromBank`: the engine events' own mix instead of hand-picked anchors (port_engine_from_bank)
    from_bank = port_engine_from_bank(cfg, out_dir, int_bank, ext_bank, ffmpeg, manifest, used_samples) if "engineFromBank" in cfg else None
    if from_bank:
        max_boundary_jump = from_bank["maxBoundaryJump"]
    # `eventsFromBank`: the transmission, gears, backfires, skids, traction control and ambient loops from the bank's own
    # events (port_events_from_bank); none of them is then derived or taken by sample name below
    events_port = "eventsFromBank" in cfg
    if events_port:
        if from_bank is None:
            raise SystemExit(f"{car_id}: eventsFromBank needs engineFromBank (its levels are on the engine's scale)")
        port_events_from_bank(cfg, out_dir, int_bank, ffmpeg, manifest, from_bank["scales"], used_samples)
    for view, bank in (("int", int_bank), ("ext", ext_bank)) if from_bank is None else ():
        for layer in ("on", "off"):
            items = cfg["engine"][view][layer]
            n_items = len(items)
            for idx_item, item in enumerate(items):
                anchor_rpm = int(item["rpm"])
                root_rpm = float(item.get("rootRpm", anchor_rpm))
                spec = item["sample"]
                sname, raw_x = bank.get(spec)
                used_samples.add(f"{view}:{sname}")

                resampled = pitch_resample(raw_x, anchor_rpm, root_rpm, resample_range)
                if view_eq.get(view):
                    resampled = apply_eq(resampled, view_eq[view])
                loop = make_seamless_loop(resampled, LOOP_S, XFADE_S, RATE)

                # Consistent RMS curve across RPM: rises smoothly from idle to limiter, unless the anchor sets its own
                # level (a bank whose overrun fades out with rpm, as the 496R's does)
                frac = idx_item / max(1, n_items - 1)
                if "rms" in item:
                    target_rms = float(item["rms"])
                elif layer == "on":
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
                        "fsbName": sname,
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
    if events_port:
        pass
    elif trans_cfg:
        for tr_item in trans_cfg:
            layer = tr_item["layer"]
            speed = int(tr_item["drivetrainSpeed"])
            sname, raw_x = int_bank.get(tr_item["sample"])
            used_samples.add(f"trans:{sname}")
            if "pitchRatio" in tr_item:
                raw_x = pitch_resample(raw_x, float(tr_item["pitchRatio"]), 1.0)
            loop = make_seamless_loop(raw_x, LOOP_S, XFADE_S, RATE)
            # whine sits well under the engine, at the level of the original F1 2026 and GT3 banks
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
        int_on = from_bank["specs"]["int"]["on"] if from_bank else [e["sample"] for e in cfg["engine"]["int"]["on"]]
        mid_spec = int_on[len(int_on) // 2]
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

    # 5b. Ambient raw loops (optional): wind, tyre rolling and bodywork, played by speed and suspension activity in
    # place of CarAudio's procedural layers
    for key, (tag, level) in {"wind": ("wind", 0.16), "tyreRolling": ("tyre_rolling", 0.16), "bodywork": ("bodywork", 0.16)}.items():
        spec = cfg.get("ambient", {}).get(key)
        if spec is None:
            continue
        sname, raw_x = int_bank.get(spec)
        used_samples.add(f"{tag}:{sname}")
        loop = make_seamless_loop(raw_x, LOOP_S, XFADE_S, RATE)
        loop = level_signal(loop, level)
        fn = f"{tag}.ogg"
        ch = encode_ogg(ffmpeg, loop, out_dir / fn, force_mono=True, quality=4)
        manifest[key] = {"file": fn, "channels": ch, "rms": round(rms(loop), 4)}

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
    # A bank ported from its events makes no one-shot of its own: its gear, backfire and limiter events are what they are
    if events_port:
        existing_roles |= {"gear_up", "gear_down", "shift_cut", "limiter", "backfire_int", "backfire_ext", "blowoff"}
    # The highest recordings (the bank's own, by root, with `engineFromBank`): sources of the derived one-shots
    specs = from_bank["specs"] if from_bank else {v: {lay: [e["sample"] for e in cfg["engine"][v][lay]] for lay in ("on", "off")} for v in ("int", "ext")}
    high_on_spec = specs["int"]["on"][-1]
    _, high_on_x = int_bank.get(high_on_spec)
    high_off_spec = specs["int"]["off"][-1]
    _, high_off_x = int_bank.get(high_off_spec)
    ext_off_spec = specs["ext"]["off"][-1]
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
        # The source's FMOD autopitch root (the bank's own, for a recording its engine plays): pitch it to the car's
        # limiter like the engine loops around it
        lim_root = cfg.get("limiterRootRpm") or (from_bank["roots"].get(lim_name) if from_bank else None)
        if lim_root:
            lim_x = pitch_resample(lim_x, float(cfg["limiterRpm"]), float(lim_root), resample_range)
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

    # Sections this bank lacks, taken from another LibreCorsa bank (`reuse`: its folder, the loops named in `sections`
    # copied with their manifest entries, and its one-shots of the `oneshotRoles` this port did not make), and manifest
    # sections passed through as they are (`manifestExtras`)
    reuse = cfg.get("reuse")
    if reuse:
        src_dir = REPO_ROOT / reuse["dir"]
        src_manifest = json.loads((src_dir / "manifest.json").read_text(encoding="utf-8"))
        for section in reuse.get("sections", []):
            entry = src_manifest.get(section)
            if entry is None:
                continue
            manifest[section] = entry
            if isinstance(entry, dict) and "file" in entry:
                shutil.copyfile(src_dir / entry["file"], out_dir / entry["file"])
        made = {o["role"] for o in manifest["oneshots"]}
        for o in src_manifest.get("oneshots", []):
            if o["role"] in reuse.get("oneshotRoles", []) and o["role"] not in made:
                shutil.copyfile(src_dir / o["file"], out_dir / o["file"])
                manifest["oneshots"].append(o)
    for key, value in cfg.get("manifestExtras", {}).items():
        manifest[key] = value
    # Sample names stay out of the published manifest when they name a team or a car (`hideSampleNames`)
    if cfg.get("hideSampleNames"):
        for view in ("ext", "int"):
            for e in manifest["engine"][view]:
                e.pop("fsbName", None)
        for group in ("turbo", "transmission", "oneshots"):
            for e in manifest[group]:
                e.pop("fsbName", None)

    # Remove any stale .ogg files in out_dir not referenced by this manifest
    referenced_files = {"manifest.json"}
    for view in ("ext", "int"):
        for e in manifest["engine"][view]:
            referenced_files.add(e["file"])
    for e in manifest.get("engineFront", []):
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
    for key in ("wind", "tyreRolling", "bodywork", "mgu"):
        if isinstance(manifest.get(key), dict) and "file" in manifest[key]:
            referenced_files.add(manifest[key]["file"])

    for existing in out_dir.glob("*.ogg"):
        if existing.name not in referenced_files:
            existing.unlink()

    manifest_path = out_dir / "manifest.json"
    text = json.dumps(manifest, indent=2)
    if "engineFromBank" in cfg:
        # A table's [x, y] points one to a line (its gain tables run to hundreds of them)
        text = re.sub(r"\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]", r"[\1, \2]", text)
    manifest_path.write_text(text + "\n", encoding="utf-8")

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


# ---------------------------------------------------------------------------------------------------------------------
# An automatic config: a car whose bank has no entry in car_configs.json (scripts/mods/importers/ac-car.ts). AC banks
# name their samples by what they are: inside or outside the car ("int", "ext", "aft", "rear"), on or off the throttle,
# and the engine speed, as an rpm ("int_on_6000") or a word ("onlow", "offmedhigh", "idle"). The engine loops are those
# samples, their anchors spread over the car's own idle-to-limiter range; the one-shots, turbo, skid, traction-control
# and gearbox sounds are found by their names too, and what isn't there is derived as for the hand-made configs.
# ---------------------------------------------------------------------------------------------------------------------

# Engine speed words, as a share of the range from idle to the limiter
_LEVELS = (
    ("veryhigh", 0.95), ("vhigh", 0.95), ("medhigh", 0.65), ("midhigh", 0.65), ("highmed", 0.65), ("highmid", 0.65),
    ("lowmed", 0.38), ("medlow", 0.38), ("lowmid", 0.38), ("midlow", 0.38), ("verylow", 0.12), ("vlow", 0.12),
    ("medium", 0.5), ("med", 0.5), ("mid", 0.5), ("high", 0.8), ("low", 0.25), ("max", 1.0), ("redline", 1.0),
)
# Words that make a sample no engine loop, each a whole word of its name (a plural, or a number after it, too): "wind"
# is no part of "windsor", nor "trans" of "trans_am"
_NOT_ENGINE = (
    "shift", "gear", "gearbox", "backfire", "bov", "blowoff", "blow_off", "flutter", "turbo", "skid", "tyre", "tire",
    "wind", "door", "horn", "limit", "limiter", "brake", "body", "traction", "transmission", "whine", "crash", "scrape",
    "explosion", "unused", "gravel", "dirt", "bump", "kerb", "curb", "rolling", "pop", "crackle", "starter", "start",
    "pit", "click", "rain",
)
_NOT_ENGINE_RE = re.compile(r"(?<![a-z0-9])(?:" + "|".join(map(re.escape, _NOT_ENGINE)) + r")(?:e?s)?\d*(?![a-z0-9])")
# The throttle's layer, at the start of a word ("on", "offmedhigh", "power", "on6000"): what follows must be nothing, a
# number or a speed word, so "onboard" is no "on"
_LAYERS = (("off", "off"), ("on", "on"), ("coast", "off"), ("decel", "off"), ("power", "on"), ("accel", "on"), ("acc", "on"))


def _tokens(name: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", name.lower()) if t]


def _level(word: str) -> float | None:
    """An engine speed word's share of the idle-to-limiter range ("low", "medhigh", "high2"), or None"""
    for key, share in _LEVELS:
        if word == key or word.startswith(key) and len(word) <= len(key) + 1:
            return share
    return None


def classify_engine_sample(name: str) -> dict[str, Any] | None:
    """What an engine loop's name says: {view: int / ext / None, layer: on / off / idle, share or rpm, rear: an
    exhaust-side recording}; None for a sample that isn't an engine loop"""
    low = name.lower()
    if _NOT_ENGINE_RE.search(low) or re.search(r"(^|[^a-z])bf\d*($|[^a-z])", low):
        return None
    toks = _tokens(name)
    view = None
    # "int" a word of its own, or with a number ("int2"): "integra" is a car's name
    if any(t in ("int", "interior", "internal", "inside", "cockpit", "onboard", "incar") or re.fullmatch(r"int\d+", t) for t in toks):
        view = "int"
    elif any(t in ("ext", "exterior", "outside", "aft", "rear", "front", "exhaust") or t.endswith("ext") for t in toks):
        view = "ext"
    rear = any(t in ("aft", "rear", "exhaust") for t in toks)
    layer, rest = None, []
    for t in toks:
        for prefix, lay in _LAYERS:
            after = t[len(prefix):]
            if t.startswith(prefix) and (not after or after.isdigit() or _level(after) is not None):
                layer = layer or lay
                rest.append(after)
                break
        else:
            rest.append(t)
    # "idol": a spelling AC banks use
    if any(t.endswith(("idle", "idol")) for t in toks):
        return {"view": view, "layer": "idle", "share": 0.0, "rear": rear}
    if layer is None:
        return None
    for word in rest:
        share = _level(word)
        if share is not None:
            return {"view": view, "layer": layer, "share": share, "rear": rear}
    rpms = [int(t) for t in rest if t.isdigit() and 800 <= int(t) <= 20000]
    if rpms:
        return {"view": view, "layer": layer, "rpm": rpms[0], "rear": rear}
    return None


def auto_config(samples: list[dict[str, Any]], limiter_rpm: float, idle_rpm: float, boost: float = 0.0,
                source: str = "") -> dict[str, Any]:
    """A car_configs.json entry for a bank (`samples`: list_bank_samples' list) and the car's limiter and idle rpm.
    Raises ValueError when the bank names no engine loops"""
    span = max(1000.0, limiter_rpm - idle_rpm)
    # view, layer -> speed band (250 rpm) -> (the recording's rpm, sample, its score)
    found: dict[tuple[str, str], dict[int, tuple[int, str, tuple[bool, bool, float]]]] = {}
    # view -> the idle loop (sample, its score)
    idles: dict[str, tuple[str, tuple[bool, bool, float]]] = {}
    for s in samples:
        if s["seconds"] < 0.6:
            continue
        c = classify_engine_sample(s["name"])
        if c is None:
            continue
        rpm = int(round(c["rpm"] if "rpm" in c else idle_rpm + c["share"] * span))
        spec = f"{s['name']}#{s['index']}"
        for view in ((c["view"],) if c["view"] else ("int", "ext")):
            if c["layer"] == "idle":
                score = (c["view"] == view, c["rear"] if view == "ext" else False, s["seconds"])
                if view not in idles or score > idles[view][1]:
                    idles[view] = (spec, score)
                continue
            for layer in (c["layer"],):
                slot = found.setdefault((view, layer), {})
                # One per 250 rpm: one named for this view, then an exhaust-side recording outside, then the longest
                score = (c["view"] == view, c["rear"] if view == "ext" else False, s["seconds"])
                band = int(round(rpm / 250))
                if band not in slot or score > slot[band][2]:
                    slot[band] = (rpm, spec, score)
    if not found:
        raise ValueError("the bank names no engine loops (no int/ext on/off samples)")
    other_view = {"int": "ext", "ext": "int"}

    def anchors(view: str, layer: str) -> list[dict[str, Any]]:
        # A layer the bank has no loops for borrows the other layer's (a bank without overrun recordings), then the
        # other view's
        slot = found.get((view, layer)) or found.get((view, "off" if layer == "on" else "on")) or \
            found.get((other_view[view], layer)) or next(iter(found.values()))
        rows = sorted(slot.values())
        out = [{"rpm": rpm, "rootRpm": rpm, "sample": spec} for rpm, spec, _score in rows]
        # The idle loop under them, where none of them is down there already
        idle = idles.get(view) or idles.get(other_view[view])
        if idle and out[0]["rpm"] > idle_rpm + 250:
            out.insert(0, {"rpm": int(idle_rpm), "rootRpm": int(idle_rpm), "sample": idle[0]})
        # The highest loop plays at the limiter, the lowest no higher than idle: the bank sweeps the car's own range,
        # each recording pitched from the speed it was made at (`rootRpm`)
        if len(out) == 1:
            out = [dict(out[0], rpm=int(idle_rpm)), dict(out[0], rpm=int(limiter_rpm))]
        out[-1]["rpm"] = max(out[-1]["rpm"], int(limiter_rpm))
        out[0]["rpm"] = min(out[0]["rpm"], int(idle_rpm))
        return out

    def named(pattern: str, exclude: str = r"^$") -> list[dict[str, Any]]:
        return [s for s in samples if re.search(pattern, s["name"], re.I) and not re.search(exclude, s["name"], re.I)]

    spec = lambda s: f"{s['name']}#{s['index']}"  # noqa: E731
    is_int = lambda s: any(t.startswith("int") for t in _tokens(s["name"]))  # noqa: E731
    cfg: dict[str, Any] = {
        "sourceDescription": source,
        "rawPcm16": True,
        "engine": {v: {lay: anchors(v, lay) for lay in ("on", "off")} for v in ("int", "ext")},
        "throttleCurve": {
            "ext": [[0.0, 0.0], [0.1, 0.25], [0.25, 0.55], [0.5, 0.8], [0.75, 0.94], [1.0, 1.0]],
            "int": [[0.0, 0.0], [0.1, 0.28], [0.25, 0.58], [0.5, 0.82], [0.75, 0.95], [1.0, 1.0]],
        },
        "lift": {"popMinRpm": int(idle_rpm + 0.7 * span), "crackleMinRpm": int(idle_rpm + 0.8 * span), "downshiftPopChance": 0.3},
    }
    oneshots: dict[str, list[str]] = {}
    shifts = named(r"shift|gear.?(up|dn|down)|(up|down)shift", r"miss")
    ups = [s for s in shifts if re.search(r"up", s["name"], re.I)] or shifts
    downs = [s for s in shifts if re.search(r"d(ow)?n", s["name"], re.I)] or shifts
    if ups:
        oneshots["gear_up"] = [spec(s) for s in ups[:4]]
    if downs:
        oneshots["gear_down"] = [spec(s) for s in downs[:4]]
    fires = [s for s in named(r"backfire|(^|[^a-z])bf\d*($|[^a-z])|_bf|crackle|pop", r"loop") if s["seconds"] < 3]
    if [s for s in fires if is_int(s)]:
        oneshots["backfire_int"] = [spec(s) for s in fires if is_int(s)][:6]
    if [s for s in fires if not is_int(s)]:
        oneshots["backfire_ext"] = [spec(s) for s in fires if not is_int(s)][:8]
        cfg["shiftFallbackSample"] = oneshots["backfire_ext"][0]
    bov = named(r"bov|blow.?off|flutter")
    if bov:
        oneshots["blowoff"] = [spec(bov[0])]
    if oneshots:
        cfg["oneshots"] = oneshots
    limiter = [s for s in named(r"limit") if s["seconds"] >= 0.5]
    if limiter:
        cfg["limiterFallbackSample"] = spec(max(limiter, key=lambda s: s["seconds"]))
    turbo = [s for s in named(r"turbo", r"bov|blow|flutter") if s["seconds"] >= 0.6]
    if turbo and boost > 0:
        t = spec(max(turbo, key=lambda s: s["seconds"]))
        cfg["turbo"] = [{"layer": "on", "boost": round(boost, 2), "sample": t}, {"layer": "off", "boost": round(boost, 2), "sample": t}]
    trans = [s for s in named(r"trans|whine|gearbox", r"traction") if s["seconds"] >= 0.6]
    if trans:
        t = spec(trans[0])
        cfg["transmission"] = [{"layer": "on", "drivetrainSpeed": 160, "sample": t, "rms": 0.03},
                               {"layer": "off", "drivetrainSpeed": 160, "sample": t, "rms": 0.022}]
    skid = [s for s in named(r"skid") if s["seconds"] >= 0.6]
    if skid:
        cfg["skid"] = {"int": spec(skid[0]), "ext": spec(skid[-1])}
    tc = [s for s in named(r"traction") if s["seconds"] >= 0.6]
    if tc:
        cfg["tractionControl"] = spec(tc[0])
    return cfg


def expand_variants(car_id: str, cfg: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """A config with `variants` (one car, a bank per team: F1 2007) is one port per variant, each the config with the
    variant's keys over it and its sound in a folder of its own (`outDir`/<variant>)"""
    if "variants" not in cfg:
        return [(car_id, cfg)]
    base = {k: v for k, v in cfg.items() if k != "variants"}
    return [
        (f"{car_id}/{name}", {**base, **over, "outDir": f"{cfg['outDir']}/{name}"})
        for name, over in cfg["variants"].items()
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", metavar="BANK", help="List all FSB5 samples inside an FMOD .bank file")
    ap.add_argument("--auto", metavar="BANK", help="Port a bank with no car_configs.json entry, by its sample names "
                    "(with --out, --limiter and --idle)")
    ap.add_argument("--out", type=Path, help="--auto: the folder to write the sound bank into")
    ap.add_argument("--limiter", type=float, help="--auto: the car's limiter (rpm)")
    ap.add_argument("--idle", type=float, default=1000.0, help="--auto: the car's idle (rpm, default 1000)")
    ap.add_argument("--boost", type=float, default=0.0, help="--auto: the turbo's full boost (bar), 0 for none")
    ap.add_argument("--source", default="", help="--auto: where the sound came from, for the manifest")
    ap.add_argument("--auto-plan", metavar="SAMPLES.json", help="Print the config --auto would make from a sample list "
                    "(as --list prints it), with --limiter and --idle, without porting anything")
    ap.add_argument("--inspect", metavar="BANK", help="Inspect FMOD PMLB RPM intervals and autopitch roots")
    ap.add_argument("--car", help="Port a single car ID from car_configs.json")
    ap.add_argument("--all", action="store_true", help="Port all configured cars in car_configs.json")
    ap.add_argument("--ffmpeg", default=FFMPEG_DEFAULT, help="Path to ffmpeg binary")
    ap.add_argument("--banks-dir", type=Path, default=BANKS_ROOT, help="Base folder for relative bank paths (default: $AC_BANKS_DIR or ~/Downloads)")
    args = ap.parse_args()

    if args.list:
        meta = list_bank_samples(args.list)
        print(json.dumps(meta, indent=2))
        return

    if args.inspect:
        pmlb = inspect_fmod_pmlb(args.inspect)
        print(json.dumps(pmlb, indent=2))
        return

    if args.auto_plan:
        samples = json.loads(Path(args.auto_plan).read_text(encoding="utf-8"))
        print(json.dumps(auto_config(samples, args.limiter or 8000, args.idle, args.boost), indent=1))
        return

    if args.auto:
        if not args.out or not args.limiter:
            raise SystemExit("--auto needs --out <folder> and --limiter <rpm>")
        bank = Path(args.auto).resolve()
        try:
            cfg = auto_config(list_bank_samples(bank), args.limiter, args.idle, args.boost, args.source or bank.name)
        except ValueError as err:
            raise SystemExit(f"{bank.name}: {err}")
        cfg.update(outDir=str(args.out.resolve()), intBank=str(bank))
        print(f"[port_ac_bank] automatic config for {bank.name}:", file=sys.stderr)
        for view in ("int", "ext"):
            for layer in ("on", "off"):
                rows = ", ".join(f"{a['rpm']} {a['sample']}" for a in cfg["engine"][view][layer])
                print(f"  {view} {layer}: {rows}", file=sys.stderr)
        summary = port_car("auto", cfg, args.ffmpeg, args.banks_dir)
        print(json.dumps(summary, indent=2))
        return

    configs: dict[str, Any] = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if args.car:
        if args.car not in configs:
            raise SystemExit(f"Unknown car '{args.car}'. Available: {', '.join(configs.keys())}")
        summaries = [port_car(vid, vcfg, args.ffmpeg, args.banks_dir) for vid, vcfg in expand_variants(args.car, configs[args.car])]
        print(json.dumps(summaries[0] if len(summaries) == 1 else summaries, indent=2))
        return

    if args.all:
        summaries = []
        for cid, cfg in ((vid, vcfg) for car, car_cfg in configs.items() for vid, vcfg in expand_variants(car, car_cfg)):
            print(f"[port_ac_bank] Porting {cid} -> {cfg['outDir']} ...", file=sys.stderr)
            s = port_car(cid, cfg, args.ffmpeg, args.banks_dir)
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
