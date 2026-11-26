# Performance and troubleshooting

Because LibreCorsa runs directly in your browser, frame pacing and visual quality depend on your hardware, browser, and graphics configuration. This page covers requirements, graphics settings, automatic quality scaling, offline caching, and solutions for common problems.

## System requirements

- **WebGL2 with hardware acceleration:** Required by every browser. If disabled, the game displays `"3D graphics are off in your browser"`.
- **No installation required:** Play directly at `librecorsa.org`, or use the optional desktop and Android apps (see [Verifying downloads](DOWNLOADS.md)). The desktop app runs the game in Chrome, Edge, Brave or Chromium, so the browser's GPU and background settings apply to it too.
- **Chrome or Edge for WebHID:** Required for direct browser wheel force feedback, DualSense adaptive triggers/haptics/lightbar, and gyro steering. See [Controls, controllers, and wheels](CONTROLS.md).
- **Mobile devices and standalone VR headsets:** Touch-primary phones and tablets (and standalone WebXR headsets) default to **Medium** graphics with **Automatic quality** and **Sharpen** enabled, disable MSAA anti-aliasing, and load GPU-compressed KTX2 circuit textures to stay within mobile memory budgets.
- **Installing on mobile:** Adding the site to your home screen unlocks full-screen play. On iPhone and iPad, tap **Share > Add to Home Screen** (note that iOS isolates Home Screen app storage from Safari, so it maintains separate saves). The Android app requires Android 7 or later and Chrome.

## Graphics settings

Configure visual quality under **Settings > Display > Graphics**.

| Quality preset | Features enabled |
| :-- | :-- |
| **Low** | No sun shadows, bloom, anti-aliasing, or live car reflections; simplified sky, reduced foliage density, lighter surface detail, lower internal resolution |
| **Medium** | Sun shadows, live car reflections, full atmospheric sky with clouds, slightly reduced foliage, no bloom |
| **High** | All effects enabled, including bloom |

On desktop browsers, **Medium** and **High** enable MSAA anti-aliasing; on phones and tablets, MSAA stays off.

- **Quality:** `Low`, `Medium`, or `High` (defaults to `High` on desktop, `Medium` on mobile).
- **Sharp Low:** Available when **Quality** is set to `Low`. Renders Low effects at Medium internal resolution (`"Draws Low at Medium resolution"`).
- **Render resolution:** Scales internal rendering from `50%` to `150%` in `5%` increments (`100%` default), multiplied on top of the active preset.
- **Driver body:** Shows drivers' bodies and arms inside cars that have them (`Off` by default; helmets always render).
- **Sharpen:** Post-scaling edge and tarmac sharpening (`"Crisps edges and tarmac after scaling"`). Enabled by default on phones and tablets.
- **Frame rate:** `Full` or `30 fps` (`"30 fps lowers heat on mobile"`). Caps rendering only: input polling, 500 Hz vehicle physics, multiplayer networking, and lap timing continue running at full rate.
- **Automatic quality:** Dynamically trims visual load on sustained slowdowns (`"Steps down on sustained frame drops"`). Enabled by default on mobile; off by default on desktop.
- **Lowest resolution (Advanced):** Sets the floor for **Automatic quality** between `60%` and `100%` (`60%` default). Setting it to `100%` limits automatic scaling to visual effects only.

To restore your device's default graphics configuration, use **Reset all settings** under **Settings > Profile and data > Data**.

## Automatic quality scaling

Phones and thin laptops often throttle after a few minutes as heat builds up. **Automatic quality** monitors frame times while driving and steps visual features down incrementally to keep frame pacing smooth.

- **Trigger behavior:** Monitors frame times only while on track. Three consecutive slow seconds trigger one step down. It waits 20 seconds after entering the track for shader warm-up, and pauses briefly after menus, replays, pauses, or tab switches.
- **Desktop step-down order:** Render resolution to `85%`, then `70%` of your configured scale → live car reflections → anti-aliasing and bloom → lighter shadows → **Sharp Low**.
- **Mobile step-down order:** Live car reflections → bloom (if on High) → lighter shadows → render resolution to `85%`, then `70%` → **Sharp Low** (prioritizing image crispness for as long as possible).
- **Hard floors:** Sun shadows are never disabled completely, and resolution never drops below your **Lowest resolution** setting.
- **HUD feedback:** Each reduction shows a `"Graphics scaled down"` notice (throttled to at most once per minute), and the **Automatic quality** row in Settings lists what has been lowered. If frame rate remains low after all steps while **Frame rate** is set to `Full`, the HUD prompts `"Low FPS · 30 fps cap available in Settings"`.
- **Session behavior:** Automatic quality never steps back up mid-session and never overwrites your saved settings. Reloading the page restores your configured baseline; switching circuits within 10 minutes starts one step higher than where the previous session ended. Manually changing any graphics setting resets the scaler.
- **Zero simulation impact:** Physics accuracy, lap validity, and multiplayer behavior remain identical at every quality step.

## Asset caching and updates

- **On-demand downloads:** Circuits and cars download only when you select them. The loading screen reports each file name and size, followed by `"Compiling shaders"`.
- **Offline cache:** A service worker caches downloaded assets in your browser so repeat visits load instantly without re-downloading.
- **Background freshness checks:** The first time a session requests a cached file, LibreCorsa asks the server if a newer copy exists, reusing your cached copy if unchanged or updating it in place if modified. When offline, or if the server doesn't respond within 6 seconds, it falls back seamlessly to the cached copy.
- **Incremental game updates:** New releases keep your cached circuits and cars intact and only download files that actually changed.
- **Automatic cleanup:** Assets unused for 45 days, or removed from the server, are pruned automatically. Total cache usage is capped at `1 GB` or half of the storage quota your browser grants the site (whichever is smaller), evicting least-recently-used files first.
- **Clearing downloaded assets:** Wipe site data for `librecorsa.org` in your browser's privacy settings. Note that the in-game **Clear saved data** button leaves cached circuits/cars intact, whereas browser site-data clearing deletes everything including your driver key, so export your **Identity key** first.
- **In-session updates:** When a new build becomes available while the game is open, the title and pause menus display `"Update ready"` with a **Reload** button (prompting for confirmation if reloading would end an active race or room).

## Saved data

- **Stored per browser:** Settings, lap history, ghosts, and car setups live in your current browser's storage. Separate browsers (and an iOS Home Screen install) do not share saves.
- **Ghosts:** Export individual laps with **Save ghost file** on the lap summary card, or use **Export my best** and **Import ghost file** in the pause menu's **Lap times** tab.
- **Driver identity key:** Signs your online leaderboard laps. Back it up or transfer it via **Settings > Profile and data > Data > Identity key** (**Save** / **Load**).
- **Reset all settings:** `"Restores default controls, assists, display and audio"` while preserving your driver profile, setups, and lap times.
- **Clear saved data:** `"Deletes local settings, driver key, laps, ghosts and setups"` and reloads the page.
- **Blocked storage:** If your browser blocks site storage (common in strict private-browsing modes), the game still runs normally but cannot persist settings or laps between sessions.

## Common problems

### Black or blank screen

A blank viewport usually indicates a lost WebGL context (the browser disconnected from the GPU). LibreCorsa identifies the cause with one of these messages:

- **`"Your graphics driver stopped responding"`:** Click **Switch to Low and reload** or **Try again**. If you are already on Low, confirm hardware acceleration is enabled.
- **`"The graphics were reset"`:** Often occurs after backgrounding a tab or waking from sleep. Click **Try again**.
- **`"Your browser turned off 3D graphics for this page"`:** Click **Reload page**, or restart your browser if the screen stays blank.
- **`"3D graphics are off in your browser"`:** Enable hardware acceleration in your browser's system settings and reload.

After a visible GPU driver reset, LibreCorsa enters a gentle-start mode for two weeks: using a simpler sky and compiling only shaders currently in view at startup. Software renderers and older Intel HD / UHD GPUs always use this mode automatically. If you closed the tab on the GPU reset dialog, your next launch drops to **Low** once with the notice `"Graphics set to Low after GPU reset."`

If you encounter `"The simulator stopped"`, update your browser or GPU driver, ensure hardware acceleration is active, and click **Restart simulator**.

### Low frame rate or stutter

- Drop **Quality** or lower **Render resolution**.
- Enable the `30 fps` **Frame rate** cap for consistent pacing.
- On desktop, turn on **Automatic quality** (disabled by default on desktop).
- Brief hitches during the first few seconds on a newly loaded circuit are caused by shader and texture warm-up; lowering resolution won't eliminate first-load compilation.
- If performance issues persist, capture a [Performance report](#performance-report) and attach it to a bug report.

### Phone overheating

- Keep **Automatic quality** enabled; it is specifically designed to manage thermal throttling.
- Switch **Frame rate** to `30 fps` for longer sessions.

### Loading bar stalls

- The status line beneath the progress bar shows the active file name and megabytes downloaded.
- If a file transfer makes no progress for 25 seconds, LibreCorsa aborts that asset and displays `"Some assets failed to load. Using fallback geometry."` Reload the page to retry. Shader compilation is granted a longer timeout than file downloads.
- If switching to another circuit fails from the menu, you stay on your current circuit (`"Track load failed. Staying on ..."`).

### No audio

- Browsers require a user gesture before unlocking Web Audio: clicking or pressing a key on `"Press any key to continue"` (or `"Tap to continue"`) at the end of loading satisfies this requirement.
- Verify **Mute** (default `M` key) and **Master volume** under **Settings > Audio**. Your mute state persists across visits.
- On-track music and the voice spotter are turned off by default; enable either under **Settings > Audio**.

### Controller or wheel not detected

See the troubleshooting section in [Controls, controllers, and wheels](CONTROLS.md).

## Performance report

To record detailed frame-timing telemetry for a bug report:

1. Open [librecorsa.org/play?perf=1](https://librecorsa.org/play?perf=1) and drive normally.
2. Open the pause menu's **Session** tab and use **Copy** or **Save file** on the **Performance report** card (works on mobile as well as desktop).

The report logs an entry every 10 seconds throughout your session, recording FPS, frame times, frames exceeding 50 ms, JavaScript/simulation work share, Chrome memory usage, canvas resolution, and the active automatic quality step, plus every quality step-down event and a second-by-second breakdown of the first 30 seconds on track.

## URL parameters

You can append query parameters to `https://librecorsa.org/play` (or `http://localhost:3000/play`) to jump straight to a specific car, circuit, or diagnostic mode. Legacy links to `/` carrying game parameters automatically redirect to `/play` with all parameters intact.

| Parameter | Values / example | Effect |
| :-- | :-- | :-- |
| `car` | `?car=amg-gt3` | Loads directly into the specified car ID |
| `track` | `?track=rwanda_official` | Loads directly onto the specified circuit ID (also opens `"unlisted": true` circuits) |
| `room` | `?room=ABCDEF` | Joins a private multiplayer room code automatically once loaded |
| `lang` | `?lang=tr`, `?lang=en-XA` | Overrides UI language (`en-XA` enables bracketed pseudo-localization for translation checks) |
| `perf` | `?perf=1` | Enables the 10-second session **Performance report** recorder in Pause > Session |
| `mods` | `?mods=off` | Safe mode (desktop app and dev server): lists installed mod packages in the Mods panel without loading their content |
| `colliders` | `?colliders=1` | Renders physics collider surfaces overlaid on the 3D circuit |
| `profile` | `?profile` | Enables the on-screen render profiler overlay |
| `sim` | `?sim=main` / `?sim=worker` | Forces physics onto the main thread or back into the simulation Web Worker (persisted in `localStorage`) |
| `f1physics` | `?f1physics=lc26` / `f12026-car` | Selects which open-wheel physics model drives ported F1 cars |
| `lc26engine` | `?lc26engine=classic` / `rigid` | Switches the LC26 between its legacy engine and the shipping rigid-body engine (persisted in `localStorage`) |
| `sky` | `?sky=classic` | Disables the volumetric physical sky and uses the classic skybox |
| `depth` | `?depth=standard` | Disables reversed depth buffer rendering (useful for isolating WebGL depth bugs) |
| `ktx2` | `?ktx2=off` / `on` / `etc` / `astc` | Overrides GPU-compressed KTX2 circuit textures (auto-enabled on phones/tablets; `off` forces WebP) |
| `cloudseed` | `?cloudseed=42` | Seeds volumetric cloud generation deterministically and logs cloud recipes |
| `tyres` | `?tyres=<brand>` | Overrides GT sidewall tyre branding for visual testing |

## Reporting a bug

- **In-game feedback:** Open **Feedback** from the title menu or the pause menu's **Feedback** tab, choose **Bug**, and fill in **"What happened?"** and **"How to make it happen"**.
- **Attached diagnostics:** The **Included details** list previews everything appended to the public issue (circuit, car, input device, graphics settings, browser, GPU, build version, recent FPS, and error log). Click any unlocked item to omit it; locked fields are always included.
- **Submitting:** Clicking submit opens a pre-filled GitHub issue in a new tab (requires a free GitHub account; click **Create** on GitHub to post it). If the panel captured a screenshot, copy or save it and drag it into the issue description.
- **Directly on GitHub:** Open a **Bug report** at [github.com/librecorsa/librecorsa/issues/new/choose](https://github.com/librecorsa/librecorsa/issues/new/choose). Include your OS and browser, graphics preset and render resolution, and any red errors from the browser console (`F12`).
- **What helps most:** Concrete reproduction steps (even rough ones), the circuit and car involved, and a performance report if you are reporting stutter or low FPS.
