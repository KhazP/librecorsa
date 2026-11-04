# Assetto Corsa Sound Bank Porter (`scripts/audio/`)

Reusable pipeline that extracts raw `FSB5` audio streams (PCM16 or FMOD Vorbis) directly from Assetto Corsa FMOD Studio `.bank` files and compiles them into LibreCorsa's Web Audio multi-grid sample format (`manifest.json` + Ogg Vorbis loops and one-shots).

No Windows FMOD Studio runtime is required: `port_ac_bank.py` decodes the embedded `FSB5` container directly via `python-fsb5` (using Homebrew's `libvorbis` / `libogg` for Vorbis banks) and reads FMOD's `PMLB` parameter interval chunks and `INST` autopitch reference RPMs from the surrounding `RIFF`/`FEV ` metadata.

## Usage

Run with `uv` using the cached Python 3.14 environment (`numpy`, `scipy`, `fsb5`) and `/opt/homebrew/bin/ffmpeg`:

```bash
# 1. List all FSB5 subsounds in a .bank file (index, name, sample rate, channels, duration, RMS, stereo diff)
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --list "/path/to/car.bank"

# 2. Inspect FMOD Studio PMLB parameter intervals and INST autopitch reference RPMs
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --inspect "/path/to/car.bank"

# 3. Port a single configured car to public/cars/<id>/audio/
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --car w17

# 4. Port all 9 configured cars
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --all
```

## How Mapping & Loop Generation Work

1. **FMOD Parameter Intervals & Autopitch Roots (`car_configs.json`)**:
   - Each AC engine event (`event:/cars/<car>/engine_int` and `engine_ext`) uses two FMOD `PMLB` parameter tables (power/on-throttle and coast/off-throttle) mapping RPM intervals `[start, end]` to instrument `INST` chunks.
   - Each `INST` chunk stores an FMOD **Autopitch Reference (`rootRpm`)** — the exact RPM at which the raw sample plays at `1.0x` pitch.
   - During porting, `port_ac_bank.py` resamples each loop by `anchorRpm / rootRpm` so that when `Vf26SoundBank` (`LoopGrid`) plays the loop at `playbackRate = rpm / anchorRpm`, the effective pitch is `rpm / rootRpm`, matching FMOD Studio's exact pitch curve across the entire rev range.
2. **Click-Free Seamless Loops (`make_seamless_loop`)**:
   - For long recordings (10–85 s), `pick_steady_window` scans the middle 84% of the sample to pick the window with the lowest sub-block RMS variance and lowest crest factor, avoiding fade-ins or clicks.
   - For short recordings (`< 2.65 s`), the inner steady core is crossfade-tiled seamlessly before loop extraction.
   - The 2.4 s loop is phase-aligned by maximizing normalized cross-correlation over the 0.25 s equal-power crossfade window (`tail * cos(t) + head * sin(t)`), DC-centered, and micro-bridged (32 samples = 0.67 ms) to `0.0` at the wrap-around boundary so the loop boundary jump is `0.0`.
3. **Channel & Level Optimization**:
   - Stereo samples whose L-R difference RMS is `< 3%` of signal RMS are automatically downmixed to mono, alongside interior/auxiliary loops (`turbo`, `transmission`, `skid`, `tc`, `oneshots`).
   - Engine loops are RMS-leveled along a smooth curve from idle to limiter (`0.165 → 0.220` on-throttle, `0.125 → 0.175` off-throttle) with soft-knee peak limiting at `0.92`, then encoded with `ffmpeg -c:a libvorbis -q:a 4`.
