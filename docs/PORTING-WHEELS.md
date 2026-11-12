# Porting wheels

Steering, pedals and buttons reach the game through the browser's Gamepad API, so nearly any wheel can drive. Force feedback is different: the page has to speak the wheel's own protocol over WebHID (Chrome and Edge, on https or localhost). This guide is how I add force feedback for a wheel the browser can't drive yet, and how I found out why a MOZA R9 that the page set up without a single error still never moved.

## Where the code is

Everything lives in `src/lib/input/`:

- `webhid-ffb.ts`: the WebHID driver. `pickFfbDevice` chooses how to drive a device the player picked or granted, in this order:
  1. **HID PID**: any interface whose report descriptor has a Set Constant Force and an Effect Operation report. Report ids, field offsets and ranges come from the parsed descriptor (`parsePidLayout`), never hard-coded. Damper, friction and inertia run on the wheel itself where Set Effect offers them. MOZA, Simucube, VRS, Simagic, Asetek, Cammus, OpenFFBoard and PXN bases go this way.
  2. **Classic Logitech**: the G25, G27, G29 and Driving Force GT, sent the commands Linux `hid-lg4ff` sends (`setupLogitechClassicDevice`), rev LEDs on the G27 and G29 included.
  3. **Logitech HID++**: the G920 and the G923 for Xbox, once Logitech G HUB has put them in PC mode (`webhid-logitech-hidpp.ts`, from Linux `hid-logitech-hidpp`).
  4. **Thrustmaster**: the T300RS, T-GT II, T248, TX, TS-XW and TS-PC (`webhid-thrustmaster.ts`, from the out-of-tree driver `hid-tmff2`).
- `wheel-support.ts`: the model tables (`LOGITECH_CLASSIC_WHEELS`, `LOGITECH_HIDPP_WHEELS`, `THRUSTMASTER_WHEELS`: USB ids, names, ranges) and `WHEEL_SUPPORT`, the support table the wheel setup shows. The README's "Wheels and force feedback" table mirrors it.
- `wheel-ffb.ts`: turns the physics' steering torque into the rim force (gain, curve, minimum force, soft lock, damping, vibrations) and plays it to the WebHID driver every 2 ms. A driver only receives a force from -1 to 1; nothing here changes per wheel.

## Testing on a real wheel

The wheel is usually on a Windows PC and the dev server on another machine. WebHID only exists in a secure context, and `http://<LAN address>:3000` is not one, so on the PC:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<LAN address>:3000`, set it to Enabled and relaunch Chrome.
2. Turn off the wheel's own centring spring in its software (Pit House, Fanatec control panel, …).
3. In the game: Controls → Wheel & pedals → Force feedback on → **Connect wheel**, pick the wheel, hold the rim and press **Test direction**. It should pull right, then left.
4. Set Damping to 100 % and turn the rim by hand: it should feel heavier. If it does but Test direction does nothing, the wheel runs condition effects and the problem is specific to the constant force.
5. **Copy diagnostics** and keep the text: it is the starting point for everything below.

## Reading the diagnostics

**Copy diagnostics** (`WebHidFfb.diagnose`) gives:

- **Report descriptor**: every granted interface with every item, as the browser reports it.
- **HID PID reports**: what the parser found (Set Effect, Set Constant Force, Effect Operation, Device Control, Block Load, PID Pool, …) with each field's bit offset and range, and the effect types Set Effect offers. A line reading `MISSING` means the parser could not recognise that report, and its commands never go out.
- **Selector order**: whether the array lists are taken as the browser gives them or put back into the PID spec's order (see the Windows trap below).
- **Setup and teardown traffic**: every report the setup sent, in order, with its bytes, and every feature report it read back.
- **Stream writes**: how many force, condition and LED writes went out after setup, how many failed and why, and the last 24 values that changed.
- **PID State input report**: what the wheel says about itself (effect playing, actuators enabled, safety switch, actuator power), if it sends one. Many wheels never do, the MOZA R9 included, so silence here proves nothing.

## A HID PID wheel that does not play

Most bases speak HID PID, so most problems are here. Three traps are already handled in `webhid-ffb.ts`; check the diagnostics for a fourth of the same kind.

- **Chrome on Windows shuffles array lists.** Chrome has no raw descriptor on Windows. It rebuilds each report from Windows' preparsed data, one item per usage, and sorts them by bit position with an unstable sort (`CreateReportDescriptions` in Chromium's `services/device/hid/hid_service_win.cc`). The usages of one array item share a position, so they come out in no fixed order. On the R9 the effect types arrived reversed: the page asked for Friction where it meant Constant Force and for Square where it meant Damper, the wheel accepted both, and nothing moved. On Windows the parser now puts Effect Type, Effect Operation, Block Load and Device Control back into the PID spec's order (`UsageOrder`, `SPEC_SELECTOR_ORDER`). That is the order the spec's sample descriptor uses and that PID firmwares copy. A wheel whose descriptor lists them in another order would still be wrong on Windows: its true order is in the raw descriptor (read it on Linux or macOS, or with hidapi on Windows).
- **Flags declared as 0..0.** The R9 declares its 1-bit X, Y, Direction Enable and Device Control flags with a logical range of 0..0. The parser reads 0..0 as the field's full width, so a 1 can be written.
- **Device Control as bit flags.** Some wheels list Reset, Stop All, Enable Actuators and so on as one 1-bit flag each, instead of an array that selects one. Both forms are recognised.

The generic profile sends what Linux `hid-pidff` sends every PID wheel, the values that moved the R9: Trigger Button 0, Direction Enable set with no axis flag, Reset then Stop All then Enable Actuators, and a read of the PID Pool feature report before any effect is created. A wheel that needs other values gets an entry in `PID_QUIRKS` (`PidProfile`: trigger button, direction enable, axis flags, loop count, pauses). The PXN V99 entry is the example.

### When the trace looks right and the wheel still doesn't move

This is the order that found the R9's bug, from cheapest to most decisive:

1. **Compare with Linux.** `drivers/hid/usbhid/hid-pidff.c` and `drivers/hid/hid-universal-pidff.c` in the mainline kernel drive most PID bases, with a short list of per-vendor quirks. Check each Set Effect field and the init order against `pidff_set_effect_report`, `pidff_set_effect_direction` and `pidff_reset`.
2. **Replay the page's bytes outside the browser.** On the PC, copy the setup sequence from the diagnostics into a short Python script (`pip install hidapi`), open the interface that holds the PID reports and send it with `write()`. On Windows `write()` goes through `WriteFile`, the same path Chrome's `sendReport` takes, so this removes the browser from the question while keeping everything else. Then change one value at a time. For the R9 the only change needed was the effect type: once it was `01`, the rim moved.
3. **Capture what a working game sends.** Wireshark with USBPcap, capturing only the wheel (so the keyboard stays out of the file), during a game that has working force feedback. The capture shows the game's init, the effect types it creates and whether its reports go as interrupt OUT or control `SET_REPORT`. If Wireshark lists only network adapters, USBPcap isn't loaded: reboot after installing, copy `USBPcapCMD.exe` from `C:\Program Files\USBPcap\` into `C:\Program Files\Wireshark\extcap\`, or run Wireshark as administrator.

A replay script for the R9, with its report ids (another wheel's are in its diagnostics):

```python
import time, hid

info = next(d for d in hid.enumerate(0x346E, 0x0002) if d["usage_page"] == 0x01 and d["usage"] == 0x04)
dev = hid.device()
dev.open_path(info["path"])

def out(*b):  # output report: id first, hidapi pads it to the report's length
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

## A wheel with its own protocol

Find an outside source for every byte: a Linux driver (mainline or out of tree) or USB captures of the vendor's software. Write each command from it and name the source's function in a comment, the way the `lg4ff*` helpers cite `hid-lg4ff.c` and the Thrustmaster module cites `hid-tmff2`. Don't copy GPL code; write the bytes from what the driver does.

Put the driver in its own module next to `webhid-ffb.ts`, as `webhid-logitech-hidpp.ts` and `webhid-thrustmaster.ts` do. In `webhid-ffb.ts` it needs:

- a session kind in the `FfbSession` union and a case in `FfbPick`;
- a match in `pickFfbDevice`, after the HID PID check, so a firmware that adds PID later takes that path;
- its setup in `setUp`, and its release in `teardownSession` and `emergencyStopSession`;
- `setRotationDeg`, if the protocol sets the rotation range;
- a line in `unsupportedMessage` for interfaces it can't drive, and its session in `describeSession` / `describeNonPid` for the diagnostics.

### The safety contract

These hold for every driver, because nobody may be holding the rim when the page lets go:

- **One force stream.** Every write goes through a `ForceWriter` (at most one write in flight, 2 ms apart, only the latest value kept). Extra streams such as a range or LEDs are `addChannel` streams on the same writer, never writes of their own.
- **Zero on stop and on idle.** `stop()` zeroes the force at once, and the driver zeroes it itself when no call arrives for `IDLE_ZERO_MS`.
- **Release the wheel as it powers up.** Teardown and the page-hide emergency stop put the force at zero and hand back what the wheel starts with (its centring spring, its range). The emergency stop sends everything without awaiting anything: the page may not get another turn.
- **Undo a failed setup.** A setup that fails part-way takes back what it sent, then reports the error. Three failed writes in a row are fatal, and the wheel goes back to the bridge.

## Tests

`scripts/verify-webhid-ffb.ts` drives every path through `FakeHidDevice`, which logs each report and each feature read. Write the reference bytes by hand from the protocol source, not from the driver's own output, then check:

- the setup order and bytes;
- the force bytes and their sign (+1 must push the way the PID convention says, see the header of `webhid-ffb.ts`);
- the range, if there is one;
- teardown and emergency stop;
- that an unknown product id from the same vendor is refused, never opened, and has nothing written to it.

For a PID wheel, build the fixture from its real diagnostics, quirks included: the R9 checks use its 0..0 flags, its Device Control flags and the shuffled lists Chrome on Windows gave for it. Run `npx tsc --noEmit` and `npm run verify` before committing.

## The support table

Add the wheel to `WHEEL_SUPPORT` in `wheel-support.ts` and to the README table as untested, with a note on where its commands came from. It moves to tested only after someone has driven it. I keep a new wheel's commits local until then.

## What WebHID can't do

- **USB control requests.** WebHID sends and reads HID reports only, and on Windows Chrome sends output reports with `WriteFile`, never `HidD_SetOutputReport`. A wheel that needs a vendor control request first (Thrustmaster's start-up mode switch, for example) can't be set up from the page. The Logitech Driving Force Pro is left out for a related reason: its range change needs the driver to rescale the steering axis, which the Gamepad API can't do.
- **Report ids the descriptor doesn't list.** Windows' HID stack can refuse a report whose id the wheel's own descriptor doesn't declare. A protocol whose Linux driver rewrites the descriptor first, as `hid-tmff2` does for the T300RS, may not work from the page on Windows.
- **A device with no output report.** A wheel that shows up in the Gamepad API but has no usable HID output report can't take force feedback from the browser. The local bridge (`npm run ffb`, DirectInput on Windows) stays the fallback for these.
