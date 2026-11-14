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
  python -P scripts/audio/port_ac_bank.py --car bmw-m4-gt3

# 4. Port every configured car
uv run --python 3.14 --no-project --with numpy --with scipy --with fsb5 \
  python -P scripts/audio/port_ac_bank.py --all
```

## How Mapping & Loop Generation Work

1. **FMOD Parameter Intervals & Autopitch Roots (`car_configs.json`)**:
   - Each AC engine event (`event:/cars/<car>/engine_int` and `engine_ext`) uses two FMOD `PMLB` parameter tables (power/on-throttle and coast/off-throttle) mapping RPM intervals `[start, end]` to instrument `INST` chunks.
   - Each `INST` chunk stores an FMOD **Autopitch Reference (`rootRpm`)** — the exact RPM at which the raw sample plays at `1.0x` pitch.
   - During porting, `port_ac_bank.py` resamples each loop by `anchorRpm / rootRpm` so that when `Lc26SoundBank` (`LoopGrid`) plays the loop at `playbackRate = rpm / anchorRpm`, the effective pitch is `rpm / rootRpm`, matching FMOD Studio's exact pitch curve across the entire rev range.
2. **Click-Free Seamless Loops (`make_seamless_loop`)**:
   - For long recordings (10–85 s), `pick_steady_window` scans the middle 84% of the sample to pick the window with the lowest sub-block RMS variance and lowest crest factor, avoiding fade-ins or clicks.
   - For short recordings (`< 2.65 s`), the inner steady core is crossfade-tiled seamlessly before loop extraction.
   - The 2.4 s loop is phase-aligned by maximizing normalized cross-correlation over the 0.25 s equal-power crossfade window (`tail * cos(t) + head * sin(t)`), DC-centered, and micro-bridged (32 samples = 0.67 ms) to `0.0` at the wrap-around boundary so the loop boundary jump is `0.0`.
3. **Channel & Level Optimization**:
   - Stereo samples whose L-R difference RMS is `< 3%` of signal RMS are automatically downmixed to mono, alongside interior/auxiliary loops (`turbo`, `transmission`, `skid`, `tc`, `oneshots`).
   - Engine loops are RMS-leveled along a smooth curve from idle to limiter (`0.165 → 0.220` on-throttle, `0.125 → 0.175` off-throttle) with soft-knee peak limiting at `0.92`, then encoded with `ffmpeg -c:a libvorbis -q:a 4`. An anchor with its own `"rms"` keeps that level instead (the 496R's overrun, which its bank fades out as the revs rise).

## Custom banks from raw recordings (`build_custom_soundbank.py`)

For a car with no ready-made bank: builds the same `manifest.json` + Ogg format from onboard, trackside or pit-lane recordings, driven by a recipe file. Needs a Python with `numpy`, `scipy` and `soundfile` (`pyloudnorm` adds LUFS figures to the report) and `ffmpeg`.

```bash
PY=~/.venvs/librecorsa-audio/bin/python          # python3 -m venv, then pip install numpy scipy soundfile pyloudnorm
$PY -I scripts/audio/build_custom_soundbank.py --recipe <recipe.json> --analyze          # rpm statistics and gear-change ratios per source
$PY -I scripts/audio/build_custom_soundbank.py --recipe <recipe.json> --dump onboard:40:50   # tracked rpm, every 0.1 s
$PY -I scripts/audio/build_custom_soundbank.py --recipe <recipe.json>                    # build the bank and the report
```

1. **Engine-speed tracking.** A harmonic-sum salience and a Viterbi path follow the strongest engine-order line of each source. `engine.rpmPerHz` says which line that is: 30 for the per-bank line of a V8 (order 2, the loudest one in a cockpit), 15 for its firing line (order 4, often the loudest one trackside). Getting this wrong is an octave error, so check `--analyze` before building: the top percentiles should sit at the car's shift point and the up-shift ratios should cluster on its gear steps.
2. **Stretch selection.** For each band (a view, on or off load, a target rpm) the tracker's stretches within `tolerance` of the target are candidates: revs holding or rising for on-load, falling for the overrun, nothing within a gear change or a broadband burst. Each candidate is flattened and kept only if it comes out as a clear line (`minLineDb`) with every strong neighbour on a half order of the assumed engine (the order check: a stretch tracked on the wrong order is thrown out rather than labelled with the wrong rpm). `windows` in a band names stretches by hand instead.
3. **De-sweep.** The stretch is resampled along the integral of its tracked frequency, so the sweep becomes a steady note at the target rpm. This is the resampling a pitch-tracking player does, so harmonics and formants move together, by at most the band's tolerance.
4. **Notch** (`notch.enabled`): stationary lines above `minHz` that are not engine orders (gear mesh) are notched out of engine loops, so they do not pitch with the engine in the wrong gear. The transmission loops are built from those same lines (`whineLines`).
5. **Loop.** Stretches are joined with phase-aligned crossfades, cut to a whole number of engine cycles and closed with a correlation-compensated equal-power crossfade and the same 32-sample bridge as `make_seamless_loop`.
6. **Level.** The RMS curve above (not a per-loop LUFS target: the player mixes every bank at the same bus gains, and a ported and a built bank must sit at the same loudness). Encoded with the same `-q:a 4`.

One-shots come from tracked gear changes (`from: "upshift" | "downshift"`), broadband bursts (`"burst"`), a given time (`"time"`) or a finished loop (`"loop"`: a gated stutter for the limiter, enveloped slices for pops). `mgu.synth` writes a synthetic carrier where no recording isolates the electric machine.

The report (`reportPath`) lists, per loop: the stretches used, the rpm they spanned, the flattened pitch (mean and spread in cents), the line's prominence, the seam correlation, RMS and LUFS, the notched lines and how many candidates the order check threw out.

Recipe skeleton (paths relative to the recipe file for `sourceDir`, to the repository for `outDir`):

```json
{
  "bankId": "my-car", "outDir": "public/cars/my-car/audio", "reportPath": "artifacts/my-car_soundbank_report.json",
  "sourceDir": "audio_raw", "loopSeconds": 2.0, "xfadeSeconds": 0.35,
  "engine": { "rpmPerHz": 30, "rpmMin": 1500, "rpmMax": 8700 },
  "selection": { "tolerance": 0.08, "minPieceS": 0.4, "maxPieces": 10, "minLineDb": 14 },
  "notch": { "enabled": true, "minHz": 1600, "q": 18, "maxLines": 3, "minDb": 10 },
  "sources": { "onboard": { "file": "onboard.wav", "range": [0, 137], "rpmMin": 3000 } },
  "bands": [
    { "id": "int_on_6800", "view": "int", "layer": "on", "rpm": 6800, "sources": ["onboard"] },
    { "id": "idle", "view": "ext", "views": ["ext", "int"], "otherViewEq": { "lowpassHz": 2600 }, "layer": "on", "rpm": 2000,
      "windows": [{ "source": "pit", "t": [21.7, 27.4] }] }
  ],
  "transmission": [{ "id": "trans_on", "layer": "on", "source": "onboard", "t": [31.0, 36.4], "engineLine": true,
                     "bandHz": [1650, 4400], "whineLines": 4, "rms": 0.042, "drivetrainSpeed": 262 }],
  "oneshots": [{ "role": "gear_up", "from": "upshift", "sources": ["onboard"], "seconds": 0.16, "eq": { "highpassHz": 500 } }],
  "manifest": { "throttleCurve": { "ext": [[0, 0], [1, 1]], "int": [[0, 0], [1, 1]] } }
}
```

`manifest` passes sections through to `manifest.json` as they are, including the player's optional ones: `shift.cutS`, `driveline` (transmission loops pitched by driveshaft speed and levelled by driveshaft torque), `loadFilter`, `viewTone` (`src/lib/sim/lc26-audio.ts`; `scripts/verify-bank-layers.ts` checks them). Recordings and recipes stay out of the repository (`/reference_data/` is ignored).
