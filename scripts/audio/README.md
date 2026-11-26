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
   - Each AC engine event (`event:/cars/<car>/engine_int` and `engine_ext`) places its instruments on an rpm parameter sheet (a `PMLB` chunk: per instrument, its guid, then its start and its length on the parameter), so each covers `[start, start + length)`; `--inspect` prints those as `start` and `end`.
   - Each `INST` chunk stores an FMOD **Autopitch Reference (`rootRpm`)** — the exact RPM at which the raw sample plays at `1.0x` pitch.
   - During porting, `port_ac_bank.py` resamples each loop by `anchorRpm / rootRpm` so that when `Lc26SoundBank` (`LoopGrid`) plays the loop at `playbackRate = rpm / anchorRpm`, the effective pitch is `rpm / rootRpm`, matching FMOD Studio's exact pitch curve across the entire rev range.
2. **Click-Free Seamless Loops (`make_seamless_loop`)**:
   - For long recordings (10–85 s), `pick_steady_window` scans the middle 84% of the sample to pick the window with the lowest sub-block RMS variance and lowest crest factor, avoiding fade-ins or clicks.
   - For short recordings (`< 2.65 s`), the inner steady core is crossfade-tiled seamlessly before loop extraction.
   - The 2.4 s loop is phase-aligned by maximizing normalized cross-correlation over the 0.25 s equal-power crossfade window (`tail * cos(t) + head * sin(t)`), DC-centered, and micro-bridged (32 samples = 0.67 ms) to `0.0` at the wrap-around boundary so the loop boundary jump is `0.0`. Lined up in phase, tail and head are partly the same tone and an equal-power fade would swell by up to 3 dB once every loop: their correlation over the fade (per channel) sets how much of that is taken back, as in `build_custom_soundbank.py`.
3. **The bank's own view EQ (`viewEq`)**:
   - A bank whose outside sound is its cockpit recordings run through EQ on the FMOD event's mixer (hahmad's RB21: `engine_ext` cuts 10 dB below 120 Hz, 2.5 dB at 220 Hz and lifts 2.5 dB at 600 Hz) lists those stages per view: `"viewEq": { "ext": [{ "type": "lowshelf", "hz": 120, "db": -10 }, { "type": "peaking", "hz": 220, "db": -2.5, "octaves": 1.2 }, { "type": "peaking", "hz": 600, "db": 2.5, "octaves": 1.2 }, { "type": "highshelf", "hz": 5000, "db": -1.5 }] }` (`peaking` takes `q` or an FMOD ParamEQ's `octaves`; shelves have slope 1). Each of that view's engine loops goes through them as heard at its anchor, before it is looped and levelled, so the player needs no tone stage for it (opponents, which play the outside loops, hear it too).
4. **Channel & Level Optimization**:
   - Stereo samples whose L-R difference RMS is `< 3%` of signal RMS are automatically downmixed to mono, alongside interior/auxiliary loops (`turbo`, `transmission`, `skid`, `tc`, `oneshots`).
   - Engine loops are RMS-leveled along a smooth curve from idle to limiter (`0.165 → 0.220` on-throttle, `0.125 → 0.175` off-throttle) with soft-knee peak limiting at `0.92`, then encoded with `ffmpeg -c:a libvorbis -q:a 4`. An anchor with its own `"rms"` keeps that level instead (the 496R's overrun, which its bank fades out as the revs rise).
5. **The bank's own mix (`engineFromBank`)**:
   - Instead of hand-picked anchors, the engine is read from the bank's FMOD tables (`FmodEventTables`, `bank_engine_view`): per view, `{ "event": "engine_int" }` or `{ "event": "engine_ext", "fixed": { "Event Cone Angle": 0 } }` (parameters other than rpm and throttle held where the view hears them; the event names come from the `GUIDs.txt` beside the bank). An event's tracks are on or off load by which end of the throttle opens them; tracks the fixed parameters silence are left out.
   - Each recording the event plays becomes one loop at its own pitch, keyed by its autopitch root, with a `gain` table over rpm in the manifest: its fade-in and fade-out curves, the instrument's, track's and event master's volumes. A recording on several instruments of a layer is one loop (instruments with the same range and start offset add in step, the others in power). The player sounds all of a layer's loops at once at those gains, at `rpm / root`, as FMOD does, so no recording plays against a copy of itself.
   - The throttle's own volume curves become `throttleGain` (an on and an overrun gain per view, in place of the sin/cos blend); `throttleCurve` is fitted to them for the transmission. `flatEngine` turns off the player's rpm/load low-pass and presence shelf: the loops are the bank's sound as it is.
   - FMOD curve segments run `y0 + (y1 - y0) * (e^(k u) - 1) / (e^k - 1)` with `k = 6.95 * shape`, the fades as gains and the track volumes as dB through the property's mapping. An instrument's own volume counts twice (the runtime turns each stored dB into 2 dB of output). Measured against the FMOD runtime playing the bank, pitch, start offset, fades and throttle gains agree within 0.2 dB.
   - A loop is cut from the first 3 s after the instrument's start offset: FMOD restarts an instrument there each time the revs enter its range, so that is the part heard most.
   - Levels: each loop file sits at 0.2 RMS and its table carries the recording's own level; one scale per view puts the on-load mix at full throttle, averaged from idle (`idleRpm`, else the lowest root) to the limiter, at 0.2, so the bank keeps its balance across rpm and between on and off load while playing as loud as the others.
   - Not followed: the event master's effects (panner, distance filter, EQ or low-pass). The port prints what their automation sets them to at the held parameters; `engine_ext`'s cone-angle low-pass is open at 30 degrees and below (22 kHz) and closes to about 5.4 kHz at 180, so hold the cone angle at the open end.
   - `ext.front` (e.g. `{ "Event Cone Angle": 180 }`): the outside from ahead of the car as well, `engineFront` (the front microphones' set at that angle, on the outside scale) with `throttleGainFront`, and `cone`: each set's gain over the cone angle from its tracks' cone curves (0: the listener behind the car) and the master's cone low-pass in Hz. Opponents play it; the player's own car stays on the rear set.
   - `foldStereo`: each recording folded to the centre, (L + R) / sqrt 2, as the events' spatialiser plays a point source (the FMOD runtime's cockpit engine comes out with L = R, the outside within 21 dB of it).
   - `variants` (one car, a bank per team: F1 2007) ports the config once per variant, each with its keys over the base config, into `outDir/<variant>/`.
6. **The bank's other events (`eventsFromBank`)**, read from the same tables, every level on the engine's scale per view (a level x in the bank plays at the view's engine scale times x):
   - `transmission`: its one recording, pitched by road speed from its autopitch root (`key` re-keys the file so 20 to 350 km/h stay within the player's 0.25 to 4 playback rates), a `gain` table over speed and `transmissionMix` (the throttle's curve on it, the view's level, the parameter's top).
   - `gear`: per view an up-shift and a down-shift one-shot, `gear_up_int` ... `gear_down_ext` (the `state` parameter's upper half is an up-shift, its lower half a down-shift, as in every AC bank's gear events), each with its own `gain` and `rate` (the instrument's pitch, in semitones).
   - `backfire`: the multi instrument's recordings per view, and a `backfire` section: sounds.ini's trigger (`soundsIni.backfire`), the throttle's curve on the event (kept on the one-shot while it plays), the instrument's chance and its random pitch modulator. An AHDSR attack on the instrument is baked into the one-shots (the stock outside backfire fades in from -42 dB over 50 ms).
   - `skid`, `tractionControl`: a loop per view at its event's level and pitch (sounds.ini MIX_VOLUME on the skid, `soundsIni.skidMixVolume`), the cut's release from its `decay` curve.
   - `wind`, `tyreRolling`, `bodywork`: the recordings that sound at the held parameters (`fixed`) mixed into one loop, with `gain` and `rate` tables over `param` and sounds.ini's SPEED_GAIN / VOLUME_GAIN (`soundsIni.wind`, `tyreRolling`: min(VOLUME_GAIN, a v + b v^2)).
   - `silent`: events that must play nothing at the parameters the car gives them (a muted limiter, a turbo the car has not got): the port stops if one sounds, and lists them as `silentEvents`.
   - The level rules, measured against the FMOD runtime: an instrument's own volume counts twice and its volume curves add to it; a bus's curves replace its own volume; points of kind 1 are S-curves (`fmod_curve_at`, two mirrored halves of the exponential shape, k = 4.42 s). What the runtime plays beyond those rules at the reference listener (1 m) is `spatialDb`, measured per event (+0.65 dB on the engines, -3.9 dB on the cockpit gear click, whose panner is a 2-D one, +4.1 dB on the stereo cockpit backfire, whose panner has a 240-degree extent; the causes are not isolated), and `outsideDb` is each outside event's loss at the default chase camera (3.25 m), measured (the events' panners roll off linear-squared from their own minimum distance, the engine's inverse-tapered from 6 m). With them each event measured within 0.35 dB of the runtime against its view's engine (Ferrari, McLaren, Honda), apart from what sounds.ini adds and the runtime does not (MIX_VOLUME on the skids, VOLUME_OUT on the outside backfire); the outside backfire was measured with its random pitch modulator zeroed in a scratch copy of the bank.
   - The player (`src/lib/sim/lc26-audio.ts`) takes these sections as they are; with `shift.throttleCut` the engine hears the gearbox through its throttle alone (the cut and the blip from drivetrain.ini, the pedal unsmoothed, a ~6 ms glide as FMOD ramps a volume change over its mix block), with no dip or one-shot of its own.

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

`manifest` passes sections through to `manifest.json` as they are, including the player's optional ones: `shift.cutS`, `driveline` (transmission loops pitched by driveshaft speed and levelled by driveshaft torque), `loadFilter`, `viewTone` (`src/lib/sim/lc26-audio.ts`; `scripts/verify/verify-bank-layers.ts` checks them). Recordings and recipes stay out of the repository (`/reference_data/` is ignored).
