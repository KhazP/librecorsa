# Performance and troubleshooting

LibreCorsa runs in the browser, so how smooth it is depends on your device, your browser and a few settings. This page covers what the game needs, what the graphics settings do, how downloads are kept, and what to try when something goes wrong. If none of it helps, send me a bug report (last section).

## What the game needs

- **A browser with WebGL2** and hardware acceleration turned on. Without it the game says "3D graphics are off in your browser".
- **Nothing to install.** The desktop and Android apps open the same site (see [Checking a download](DOWNLOADS.md)). On a laptop with two graphics chips, the desktop app asks for the faster one, and it isn't slowed down while in the background.
- **Chrome or Edge for the WebHID features**: force feedback straight from the browser, DualSense triggers, haptics and lightbar, and gyro steering. See [Controls](CONTROLS.md).
- **Phones and tablets** (any device whose main pointer is a finger) start on Medium graphics with Automatic quality and Sharpen on. They never use MSAA anti-aliasing, and they load circuit textures that stay compressed on the GPU, which saves memory.
- **Installing on a phone** gives you full screen. On iPhone and iPad: Share, then Add to Home Screen. The Home Screen copy keeps its own saves, apart from Safari's. The Android app needs Android 7 or later and Chrome.

## Graphics settings

They're in Settings > Display > Graphics.

| Quality | What it draws |
|---|---|
| Low | No sun shadows, bloom, anti-aliasing or live car reflections, a simpler sky, fewer trees and shrubs, less surface detail, lower resolution |
| Medium | Sun shadows, live car reflections, the full sky with clouds, slightly fewer trees and shrubs, no bloom |
| High | Everything, including bloom |

On a desktop, Medium and High also have MSAA anti-aliasing. On a phone or tablet they don't.

- **Quality**: Low, Medium or High. Desktops start on High.
- **Sharp Low**: only with Quality on Low. "Draws Low at Medium resolution".
- **Render resolution**: 50% to 150% in 5% steps, 100% by default. It scales on top of the preset.
- **Sharpen**: "Crisps edges and tarmac after scaling". On by default on phones and tablets.
- **Frame rate**: Full or 30 fps. "30 fps lowers heat on mobile". Only the drawing is capped: input, physics, the network and lap timing still run every frame.
- **Automatic quality**: "Steps down on sustained frame drops". On by default on phones and tablets, off on desktops.
- **Lowest resolution** (shown in Advanced): how far Automatic quality may lower Render resolution, 60% to 100%, 60% by default. At 100% only the effects step down.

Reset all settings (Settings > Profile and data > Data) puts the graphics back to your device's defaults.

## Automatic quality

Phones slow their chips down as they heat up, so a drive that starts smooth can stutter a few minutes in. Automatic quality lowers the graphics a step at a time when that happens.

- **When it steps**: it only watches the frames while you drive. Three slow seconds in a row lower one thing. It waits 20 seconds after you go on track, while the game warms up, and a few seconds after a pause, a menu, a replay or switching tabs.
- **What goes first on a desktop**: resolution to 85%, then 70% of yours, car reflections, anti-aliasing and bloom, lighter shadows, then Sharp Low.
- **What goes first on a phone or tablet**: car reflections, bloom (on High), lighter shadows, then resolution 85% and 70%, then Sharp Low. The picture stays sharp for as long as possible.
- **Shadows never switch off fully**, and the resolution never goes under your Lowest resolution.
- **What you see**: a "Graphics scaled down" note on the HUD (at most once a minute), and the Automatic quality row in Settings says what it lowered. If the frames stay slow with every step taken and Frame rate on Full, the HUD says "Low FPS · 30 fps cap available in Settings".
- **It never steps back up** during a session and never changes your saved settings. A reload starts on your own settings. Switching circuits from the menu within 10 minutes starts one step better than the last session ended. Changing the graphics yourself starts it over.
- **It doesn't touch the simulation**: physics, lap validity and online races are the same at every step.

## Downloads and the cache

- **Circuits and cars download when you pick them.** The loading screen names each file and its size, then shows "Compiling shaders".
- **The browser keeps them** (a service worker), so the next visit doesn't download them again.
- **A kept file is checked the first time a page needs it.** The game asks the server whether the file changed. If not, it uses your copy. If it did, it downloads the new one in its place. Offline, or with no answer within 6 seconds, it uses your copy.
- **A new version of the game keeps your downloads.** Only files that changed are downloaded again.
- **Old files go by themselves**: a file you haven't used for 45 days, or one the server no longer has. The kept files take at most 1 GB, or half of the storage the browser gives the site if that's less. Past that, the ones used longest ago go first.
- **To free space or start fresh**, clear the site data for librecorsa.org in your browser's settings. The game's own Clear saved data doesn't remove downloads. Clearing site data removes your settings, ghosts and driver key too, so save your Identity key first (next section).
- **Updates while the game is open**: the title and pause menus show "Update ready" with a Reload button. If a reload would end your session, race or room, it asks first.

## Saved data

- **Everything stays in this browser.** Settings, lap history, ghosts and setups are saved in the browser you play in. Another browser, or the iPhone Home Screen copy, keeps its own.
- **Ghosts**: Save ghost file on the lap summary, and Export my best or Import ghost file in the pause menu's Lap times tab.
- **Driver key**: the key that signs your online laps. Settings > Profile and data > Data > Identity key, with Save and Load. Save it to use the same identity in another browser.
- **Reset all settings** "Restores default controls, assists, display and audio". Your profile, setups and lap times stay.
- **Clear saved data** "Deletes local settings, driver key, laps, ghosts and setups", then reloads the page.
- **Blocked site data**: if your browser blocks site storage (some private windows do), the game still runs but can't keep anything.

## Common problems

### Black or blank screen

This usually means the browser lost its connection to the GPU (a lost WebGL context). The game shows one of these:

- **"Your graphics driver stopped responding"**: press Switch to Low and reload, or Try again. If you're already on Low, check that hardware acceleration is on.
- **"The graphics were reset"**: this can happen while the game is in the background. Press Try again.
- **"Your browser turned off 3D graphics for this page"**: press Reload page. If it stays blank, restart your browser.
- **"3D graphics are off in your browser"**: turn on hardware acceleration in your browser settings, then reload.

After a driver reset with the game in view, the next starts are gentle for two weeks: a simpler sky, and a loading screen that prepares only what the camera sees. Software renderers and older Intel HD and UHD graphics always start that way. If you closed the page on the notice, the next start switches to Low once and says "Graphics set to Low after GPU reset."

If you see "The simulator stopped", update your browser or graphics driver, or turn on hardware acceleration, then press Restart simulator.

### Low frame rate or stutter

- Lower Quality or Render resolution.
- Set Frame rate to 30 fps.
- On a desktop, turn on Automatic quality. It's off there by default.
- A hitch in the first seconds on a new circuit is the game still preparing shaders and textures. A lower resolution won't fix that kind.
- Run the performance report below and send it with a bug report.

### Phone running hot

- Leave Automatic quality on. It's made for this.
- Set Frame rate to 30 fps for long sessions.

### Loading bar stops

- The line under the bar says which file is arriving and how many MB of it are in.
- If a download makes no progress for 25 seconds, the game gives up on it and says "Some assets failed to load. Using fallback geometry." Reload the page to try again. Shader compiling gets more time than a download.
- If another circuit fails to load from the menu, you stay on the one you had ("Track load failed. Staying on ...").

### No sound

- Browsers start sound only after you press something. "Press any key to continue" (or "Tap to continue") at the end of loading is that press.
- Check Mute in Settings > Audio (the M key by default) and Master volume. Mute is saved between visits.
- Music while driving is off by default. Turn it on in Settings > Audio.

### Controller or wheel not detected

See [Controls](CONTROLS.md).

## Performance report

- Open [librecorsa.org/play?perf=1](https://librecorsa.org/play?perf=1) and play as usual.
- In the pause menu's Session tab, the Performance report card has Copy and Save file, so you can send it from a phone too.
- It has a line every 10 seconds for the whole session: frames per second, frame times, frames over 50 ms, how much of each frame was the game's own work, memory use (Chrome only), the drawing size and the automatic quality step. It also lists each step down and has a second-by-second record of the first 30 seconds on track.

## Reporting a bug

- **From the game**: Feedback on the title menu, or the Feedback tab in the pause menu. Choose Bug, then fill in "What happened?" and "How to make it happen".
- **What it adds**: the "Included details" list shows everything the report will carry, such as the circuit, car, input, graphics, browser, GPU, build, the frame rate of your last minute of driving and the game's error log. The issue is public. Click a line to leave it out. Lines with a lock are always sent.
- **Sending it** opens a pre-filled GitHub issue in a new tab. You need a free GitHub account, and you press Create there. If the panel took a screenshot, copy it or save it, then paste or drag it into the issue.
- **From GitHub**: open a new issue on [github.com/librecorsa/librecorsa](https://github.com/librecorsa/librecorsa/issues/new/choose) and pick Bug report. Add your browser and system, your graphics (Low, Medium or High, plus render resolution), and any red errors from the browser console (F12).
- **What helps most**: exact steps, even rough ones, the circuit and car, and for stutter or low frame rate the performance report above.
