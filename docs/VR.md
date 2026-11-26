# VR headsets

LibreCorsa supports driving in virtual reality through **WebXR** (`immersive-vr`) directly in the browser. VR support is currently marked **Experimental** in Settings: you sit in the driver's seat with 6-DoF head tracking, in-cockpit HUD plates, and headset hand-controller support, while menus stay on the flat browser page outside the headset.

## Supported headsets and browsers

- **Standalone headsets:** **Meta Quest** (Quest 2, Quest 3, Quest 3S via Meta Quest Browser), **Pico** (Pico Browser), and **Wolvic**. LibreCorsa detects standalone headset browsers automatically (`OculusBrowser`, `Quest`, `PicoBrowser`, `Wolvic`, `Mobile VR`) and applies mobile-class GPU defaults. *(Note: Apple Vision Pro Safari reports itself as macOS rather than a standalone mobile-VR user agent.)*
- **PCVR headsets:** **Chrome**, **Edge**, **Brave**, or **Chromium** on Windows or Linux connected to an active **OpenXR** runtime (such as **SteamVR**, **Meta Quest Link / Air Link**, **Virtual Desktop**, or Windows Mixed Reality).
- **Secure context requirement:** Browsers only expose WebXR (`navigator.xr`) on HTTPS or loopback origins — `https://librecorsa.org` or `http://127.0.0.1` / `http://localhost` (including the [LibreCorsa desktop app](DOWNLOADS.md)). If your browser does not report an `immersive-vr` WebXR runtime, Settings displays `Requires WebXR headset`.

## Entering and leaving VR

1. Load your circuit and car on the flat page first (menus and setup screens are not rendered inside the headset).
2. Start a VR session from either place:
   - **Settings > Display > Graphics > VR:** click **Enter VR** (next to the **Experimental** badge).
   - **Pause menu (on track):** click **Enter VR**.
3. Because WebXR requires an explicit user gesture, LibreCorsa only requests a headset session when you click **Enter VR**.

To leave VR at any time:

- Pause the drive and press **B** on a headset hand controller or a connected standard gamepad (`B: leave VR`).
- Use your headset's system menu / home button to exit the browser's immersive session.
- Taking the headset off, opening the headset's system overlay, or ending the VR session automatically pauses the car and returns you to the page's pause menu.

## Cockpit view, controls, and HUD

In VR, LibreCorsa locks the camera to the **cockpit** view at the driver's eye point without artificial camera shake, G-force head bob, or external camera overrides (cameras that move your head independently cause motion sickness). The driver's helmet layer is hidden from your eye camera while still casting a shadow inside the cockpit.

### Recentering and seat position

- VR uses a seated (`local`) WebXR reference space. Whenever a VR session starts — or whenever your headset triggers a system recenter — LibreCorsa places your eye position at the car's driver eye point facing straight down the nose. Recentering aligns heading (yaw) only so the horizon stays level regardless of head tilt.
- While paused inside VR, press **Y** on a headset controller or connected gamepad (`Y: recentre the view`) to recenter at any time.
- Per-car cockpit seat offsets configured via **Adjust seat** (hold the camera key/button or press `Alt` + arrow keys on the flat page, or reset under **Settings > Display > Camera**) apply underneath the VR rig. Because the **Adjust seat** panel itself is an HTML overlay on the flat page, opening it while presenting in VR holds the car paused and shows the in-headset paused panel until you resume (`A` / right trigger) or leave VR (`B`).

### In-cockpit HUD plates

The standard browser HUD is HTML and cannot be drawn inside a WebXR stereo frame. Instead, LibreCorsa bolts unlit 3D HUD plates into the cockpit facing the driver's eye, updating up to 15 times per second when values change:

| Plate | Position | What it shows |
| :-- | :-- | :-- |
| **Left plate** | Left of the steering wheel | Active gear (highlighted amber when the pit or rolling-start speed limiter is active) and current speed in your chosen units |
| **Right plate** | Right of the steering wheel | Race position (in races), lap or run counter (or `Out lap`), live lap time, last lap, and best lap. For the first 10 seconds after entering VR, this plate also displays `"Hold B to pause"`. |
| **Start lights plate** | Above the nose | Standing-start red lights (`0`–`5`) or rolling-start countdown numbers |
| **Centre status plate** | Straight ahead (only when needed) | Shown when paused (`Paused` with `A or right trigger: drive on`, `Y: recentre the view`, `B: leave VR`) or when menus are open outside a drive (`The menus show outside the headset`, `B: leave VR`) |

### Driving controls and pausing in VR

- **Headset hand controllers:** Meta Quest Touch and other `xr-standard` WebXR hand controllers are mapped automatically as a standard gamepad while driving:
  - **Left thumbstick:** Steer
  - **Right trigger / Left trigger:** Throttle / Brake
  - **Face buttons (`A`, `X`, `B`, `Y`):** Follow your configured gamepad button layout (by default, `A` shifts up and `X` shifts down)
  - **Thumbstick clicks:** `L3` / `R3`
  - **Right thumbstick flicks:** D-pad directions (for MFD navigation)
  - **Grip buttons:** Ignored so holding the controllers naturally does not trigger accidental inputs
- **Pausing with headset controllers:** Because standalone headsets reserve their own Menu button for the OS, **hold B for 0.6 seconds** while driving to open the in-headset paused panel (a quick tap of `B` still fires your normal bound action).
- **Paused panel controls:** While paused in VR, both headset hand controllers and any connected standard gamepad (such as an Xbox or DualSense pad on PCVR) can press **A** or **right trigger** to resume driving, **Y** to recenter the view, or **B** to leave VR. On a steering wheel or gamepad, pressing **Menu / Pause** also toggles pause and resume inside VR.
- **Steering wheels and pedals (PCVR):** Any wheel and pedal set working in Chrome or Edge continues to work in PCVR with full WebHID force feedback (see [Controls, controllers, and wheels](CONTROLS.md)).

### Mirrors

The HTML top-centre virtual mirror and floating opponent nameplates are hidden in VR. The car's own 3D wing mirrors and cockpit rear-view monitors remain active (driven by the single `256 × 128` cabin rear-view pass) as your rear view.

## Performance and graphics on VR headsets

### Standalone headset defaults

Standalone headset browsers report themselves like desktop Linux browsers even though they run on mobile-class chips. LibreCorsa detects standalone VR user agents explicitly and applies its mobile-class graphics profile by default:

- **Quality:** `Medium`
- **Automatic quality:** `On` (steps down visual features on sustained frame drops; see [Performance and troubleshooting](PERFORMANCE.md#automatic-quality-scaling))
- **Sharpen:** `On` (applies on the flat page; bypassed inside VR stereo rendering)
- **Anti-aliasing:** Composer MSAA is off on the flat page, while the standalone headset's `xrCompatible` WebGL2 context requests hardware **4× MSAA** directly on the headset eye buffers so the tiled mobile GPU resolves it on chip
- **KTX2 circuit textures:** GPU-compressed **KTX2** (ETC2 / ASTC) circuit textures load automatically to keep circuit memory within standalone headset limits
- **Lighter reflections:** Live car reflections render at `128 × 128` with a `300 m` clip distance (instead of `256 × 256` and `350 m` on desktop)

### Refresh rate, foveation, and render resolution

- **Standalone refresh rate and foveation:** On standalone headsets, LibreCorsa requests **72 Hz** when offered by the headset (keeping frame budgets steadier than 90 Hz) and sets **medium fixed foveation (`0.5`)** — sharper at the centre than WebXR's strongest default foveation while still saving peripheral fill-rate.
- **Render resolution:** Your **Render resolution** setting (**Settings > Display > Graphics**) sets the WebXR eye-buffer scale factor, clamped between `50%` and `100%`. Lowering **Render resolution** before clicking **Enter VR** is the most effective way to gain GPU headroom on demanding circuits.

### VR rendering pipeline

Because the post-processing composer cannot draw per-eye stereo passes in WebXR, VR frames render directly into the headset's eye buffers with Three.js's built-in **AgX tone mapping** and reversed depth projection. While presenting in VR, the classic sky dome stands in for the volumetric physical sky so sky brightness and colours match AgX output without a post-processing pass.

## Known limits and rough edges

- **Menus stay outside VR:** The title screen, circuit and car browsers, garage, settings, multiplayer lobby, and full pause menu are HTML overlays on the flat page and cannot be used inside the headset. Pick your circuit, car, graphics preset, and render resolution before entering VR, or press **B** while paused to leave VR and change settings.
- **No post-processing effects in VR:** Bloom, contrast-adaptive sharpening, and windscreen/visor raindrop overlays are skipped while presenting in VR because the post-processing composer is bypassed.
- **Single view only:** Entering VR turns off [Triple screens](SCREENS.md) and hides on-screen touch controls until you leave VR.
- **Frame-rate cap ignored:** The `30 fps` cap in Graphics settings does not apply in VR; the headset always drives its own refresh rate.
- **Cockpit camera only:** Chase, TV, and free cameras are disabled in VR for motion comfort, and the title-screen aerial flyover does not run while wearing a headset.
- **Lost GPU context:** If the browser loses its WebGL context while in VR, LibreCorsa exits the headset session automatically so you can see and act on the recovery prompt on the page.
