# Porting wheels

Steering, pedals, and buttons reach LibreCorsa through the browser's standard Gamepad API, so almost any wheel recognized by your OS can drive. Force feedback is different: the browser has to speak the wheel base's own HID protocol over WebHID (Chrome and Edge on HTTPS or `localhost`).

This guide covers how LibreCorsa's WebHID force-feedback stack works, how to diagnose a wheel that pairs without moving, and how to implement and test a new protocol driver.

## Code architecture

All wheel input and force-feedback code lives under `src/lib/input/`:

- **`webhid-ffb.ts`:** Core WebHID driver. When a player grants a device, `pickFfbDevice` selects a backend in strict priority order:
  1. **HID PID:** Any interface whose report descriptor exposes `Set Constant Force` and `Effect Operation`. Report IDs, bit offsets, and ranges are parsed dynamically from the descriptor (`parsePidLayout`) rather than hardcoded. Hardware damper, friction, and inertia run on-device whenever `Set Effect` advertises them. Handles MOZA, Simucube, VRS, Simagic, Asetek, Cammus, OpenFFBoard, and PXN bases.
  2. **Classic Logitech (`setupLogitechClassicDevice`):** Drives the G25, G27, G29, and Driving Force GT using the command protocol documented by Linux `hid-lg4ff`, including rev LEDs on the G27 and G29.
  3. **Logitech HID++ (`webhid-logitech-hidpp.ts`):** Drives the G920 and G923 (Xbox edition) once Logitech G HUB has switched them into PC mode, following Linux `hid-logitech-hidpp`.
  4. **Thrustmaster (`webhid-thrustmaster.ts`):** Drives the T300RS, T-GT II, T248, TX, TS-XW, and TS-PC following the out-of-tree `hid-tmff2` driver.
- **`wheel-support.ts`:** Hardware tables (`LOGITECH_CLASSIC_WHEELS`, `LOGITECH_HIDPP_WHEELS`, `THRUSTMASTER_WHEELS`) containing USB VID/PIDs, names, and rotation ranges, plus `WHEEL_SUPPORT` which powers the in-game support table and mirrors the README table.
- **`wheel-ffb.ts`:** Converts steering rack torque from the physics engine into a normalized rim force in `[-1, 1]` (applying gain, response curve, minimum force, soft lock, damping, and vibration effects) and dispatches updates every `2 ms`. Nothing in this layer is vendor-specific.

## Testing on physical hardware

Wheel bases are commonly plugged into a Windows PC while your dev server runs on another machine on your LAN. Because WebHID requires a secure context and plain `http://<LAN IP>:3000` is not considered secure:

1. On the Windows PC, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<LAN IP>:3000`, set the flag to **Enabled**, and relaunch Chrome.
2. Disable the desktop centring spring in your wheel base's vendor software (MOZA Pit House, Fanatec Control Panel, etc.).
3. In LibreCorsa, open **Settings > Force feedback**, enable **Force feedback**, click **Connect wheel**, select your wheel, hold the rim firmly, and click **Test** in the **Test direction** row. The wheel should pull right, then left.
4. Switch Settings to **Advanced**, set **Damping** to `100%`, and turn the wheel by hand. If resistance increases noticeably while **Test direction** does nothing, the base is running condition effects properly and the bug is isolated to constant force.
5. Click **Copy diagnostics** and save the output: it is your baseline for debugging.

## Reading diagnostics

**Copy diagnostics** (`WebHidFfb.diagnose`) captures a complete snapshot of the WebHID session:

- **Report descriptor:** Every granted HID interface and item exactly as the browser reports it.
- **HID PID reports:** Parsed report map (`Set Effect`, `Set Constant Force`, `Effect Operation`, `Device Control`, `Block Load`, `PID Pool`, etc.) with bit offsets, value ranges, and advertised effect types. Any entry marked `MISSING` was not recognized by the parser and will never be transmitted.
- **Selector order:** Indicates whether array usages were read verbatim or re-sorted to the USB HID PID specification order (see the Windows Chromium bug below).
- **Setup and teardown traffic:** Ordered hex dump of every output and feature report sent or read during initialization and shutdown.
- **Stream writes:** Counts of force, condition, and LED reports sent after setup, failure counts and error messages, and the last 24 changed values.
- **PID State input report:** Live device status flags (effect playing, actuators enabled, safety switch, actuator power) if the base sends them. Many wheels (including the MOZA R9) never transmit PID State reports, so silence here is normal.

## Debugging HID PID wheels

Most modern direct-drive bases speak USB HID PID. `webhid-ffb.ts` already handles three subtle firmware and OS traps; check diagnostics carefully for similar quirks:

- **Chrome on Windows shuffles HID array usages:** Chrome does not have access to raw HID descriptors on Windows. Instead, Chromium reconstructs reports from Windows preparsed data (one item per usage) and orders them by bit offset using an unstable sort (`CreateReportDescriptions` in Chromium's `services/device/hid/hid_service_win.cc`). Because usages inside a single array share the same bit position, their order comes out scrambled. On the MOZA R9, effect types arrived reversed: requesting Constant Force sent Friction and requesting Damper sent Square, both silently accepted with zero motor output. On Windows, LibreCorsa now restores `Effect Type`, `Effect Operation`, `Block Load`, and `Device Control` to the canonical USB PID spec order (`UsageOrder`, `SPEC_SELECTOR_ORDER`), matching the spec's reference descriptor used by most firmware. If a base defines a non-standard usage order in firmware, inspect its raw descriptor on Linux, macOS, or via `hidapi` on Windows.
- **1-bit flags declared as `0..0`:** The MOZA R9 declares its 1-bit `X`, `Y`, `Direction Enable`, and `Device Control` flags with a logical range of `0..0`. The parser treats `0..0` as full bit-width so `1` can still be encoded.
- **Device Control exposed as bit flags:** Some wheel descriptors declare `Reset`, `Stop All`, `Enable Actuators`, etc. as individual 1-bit flags rather than a selector array. The parser supports both layouts.

By default, the generic PID profile mirrors Linux `hid-pidff`: Trigger Button `0`, Direction Enable set without axis flags, `Reset` → `Stop All` → `Enable Actuators`, and a `PID Pool` feature read before creating effects. Bases requiring different fields get an entry in `PID_QUIRKS` (`PidProfile`: trigger button, direction enable, axis flags, loop count, and inter-command delays; see the PXN V99 entry for an example).

### When diagnostics look clean but the wheel still doesn't move

Work through these three steps in order, from fastest to most conclusive:

1. **Cross-check Linux kernel drivers:** Inspect `drivers/hid/usbhid/hid-pidff.c` and `drivers/hid/hid-universal-pidff.c` in mainline Linux for vendor quirks and compare every `Set Effect` byte and init step against `pidff_set_effect_report`, `pidff_set_effect_direction`, and `pidff_reset`.
2. **Replay the exact bytes outside the browser:** On the Windows PC, copy the initialization bytes from diagnostics into a minimal Python script using `pip install hidapi` and send them via `write()`. Because `hidapi`'s `write()` uses `WriteFile` on Windows (the exact same OS path Chrome's `sendReport` calls), this isolates firmware behavior from the browser while letting you tweak one byte at a time. (On the MOZA R9, changing the effect type byte to `0x01` immediately moved the rim.)
3. **Capture a working game over USB:** Run Wireshark with USBPcap filtered strictly to the wheel's USB address (keeping keyboards out of the capture) while running a game with working FFB. Compare initialization sequence, created effect types, and whether reports travel over interrupt OUT or control `SET_REPORT`. If Wireshark lists only network interfaces, USBPcap isn't registered: reboot after installing, copy `USBPcapCMD.exe` from `C:\Program Files\USBPcap\` into `C:\Program Files\Wireshark\extcap\`, or run Wireshark as administrator.

Reference Python replay script using the MOZA R9's report IDs (swap in report IDs from your wheel's diagnostics):

```python
import time, hid

info = next(d for d in hid.enumerate(0x346E, 0x0002) if d["usage_page"] == 0x01 and d["usage"] == 0x04)
dev = hid.device()
dev.open_path(info["path"])

def out(*b):  # output report: report id first; hidapi pads to full report length
    dev.write(bytes(b))

out(0x0C, 0x08); out(0x0C, 0x04); out(0x0C, 0x01)        # Device Control: Reset, Stop All, Enable Actuators
dev.get_feature_report(19, 18)                            # PID Pool
out(0x0D, 0xFF)                                           # Device Gain
dev.send_feature_report(bytes([0x11, 0x01]))              # Create New Effect: Constant Force
print(dev.get_feature_report(18, 18))                     # Block Load: [0x12, block, 1 = success, ...]
out(0x01, 0x01, 0x01, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0, 0xFF, 0x00, 0x04, 0x28, 0x23)  # Set Effect, block 1
out(0x05, 0x01, 0x00, 0x00)                               # Set Constant Force: 0
out(0x0A, 0x01, 0x01, 0xFF)                               # Effect Operation: Start
for level in (0x1000, -0x1000, 0):                        # hold the rim
    out(0x05, 0x01, *(level & 0xFFFF).to_bytes(2, "little"))
    time.sleep(2)
out(0x0A, 0x01, 0x03, 0x00); out(0x0B, 0x01)              # Stop, free the block
out(0x0C, 0x04); out(0x0C, 0x02)                          # Stop All, Disable Actuators
```

## Adding a custom wheel protocol

Every protocol byte must be backed by a verifiable source: a mainline or out-of-tree Linux driver or USB captures from vendor software. Cite the reference function in comments (as the `lg4ff*` helpers cite `hid-lg4ff.c` and the Thrustmaster driver cites `hid-tmff2`). Do **not** copy GPL source code directly; implement the packet encoding cleanly from the documented protocol behavior.

Place the protocol implementation in a dedicated module beside `webhid-ffb.ts` (following `webhid-logitech-hidpp.ts` and `webhid-thrustmaster.ts`), then wire it into `webhid-ffb.ts`:

- Add a session variant to the `FfbSession` union and a matching case in `FfbPick`.
- Add device matching in `pickFfbDevice` **after** the HID PID check so newer firmware that adds standard PID takes the generic path automatically.
- Wire initialization in `setUp`, clean shutdown in `teardownSession`, and synchronous halt in `emergencyStopSession`.
- Implement `setRotationDeg` if the protocol supports setting steering lock.
- Add clear messaging in `unsupportedMessage` for non-FFB interfaces, and diagnostic output in `describeSession` / `describeNonPid`.

### Safety contract

Force-feedback motors can deliver dangerous torque if left holding a force after a tab closes or stalls. Every driver must satisfy four invariants:

- **Single serialized writer:** All output reports flow through a `ForceWriter` (at most one write in flight, `2 ms` pacing, latest-value coalescing). Secondary channels such as rotation range or rev LEDs must register via `addChannel` on the same writer rather than issuing independent writes.
- **Zero on stop and idle:** `stop()` zeroes motor torque immediately, and the driver automatically zeroes output if no update arrives within `IDLE_ZERO_MS`.
- **Restore power-on state on exit:** Both normal teardown and `pagehide` emergency stop must zero torque and restore the base's power-on defaults (centring spring and default range). The emergency stop path must fire every command synchronously without `await`, as the browser may terminate the page immediately.
- **Clean rollback on failure:** If initialization fails mid-sequence, undo any partial state already sent before surfacing the error. Three consecutive write failures trigger a fatal disconnect and hand off to the local bridge.

## Writing tests

`scripts/verify/verify-webhid-ffb.ts` exercises every protocol driver against `FakeHidDevice`, which records every output report and feature read. Derive expected reference bytes independently from the protocol documentation (never by copying the driver's own output) and verify:

- Exact setup report sequence and payload bytes.
- Force report encoding and sign convention (`+1` must push in the PID-defined direction; see the header comment in `webhid-ffb.ts`).
- Rotation-range commands, if supported.
- Normal teardown and synchronous emergency stop sequences.
- Strict rejection of unrecognized product IDs from the same vendor (device never opened, zero bytes written).

For HID PID additions, construct test fixtures straight from real hardware diagnostics including any quirks (for example, the R9 tests reproduce its `0..0` flags, bit-flag Device Control, and Chrome-on-Windows shuffled usage arrays). Run `npx tsc --noEmit` and `npm run verify` before committing.

## Updating the support table

Add new hardware to `WHEEL_SUPPORT` in `src/lib/input/wheel-support.ts` and the README support table marked as untested, noting the protocol reference used. A wheel only moves to **Tested** after someone physically drives it and confirms force feedback works end-to-end.

## WebHID platform limitations

- **No USB control transfers:** WebHID only exposes HID reports, and on Windows Chrome sends output reports exclusively via `WriteFile` rather than `HidD_SetOutputReport`. Wheels requiring vendor USB control transfers (such as Thrustmaster's start-up mode switch) cannot be initialized from the browser alone. The Logitech Driving Force Pro is also excluded because changing its range requires the OS driver to rescale the steering axis, which the Gamepad API cannot perform.
- **Undeclared report IDs:** Windows' HID stack can reject reports whose IDs do not appear in the hardware's own descriptor. Protocols whose Linux driver patches the HID descriptor in-kernel (such as `hid-tmff2` for the T300RS) may be blocked by Windows over WebHID.
- **Devices without HID output reports:** Wheels that appear in the Gamepad API but expose no usable HID output report cannot receive WebHID force feedback. The local Windows bridge (`npm run ffb`, backed by DirectInput) remains the fallback for all unsupported bases.
