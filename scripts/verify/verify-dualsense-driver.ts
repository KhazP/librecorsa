/**
 * verify-dualsense-driver.ts: the DualSense driver's silent HD-haptics tries (src/lib/input/dualsense-driver.ts).
 *
 * The pad's audio and HID singletons are replaced with stand-ins, so the retry latch is checked without a browser:
 * a silent try that fails with a reason stops the tries, an error left by a start the player asked for keeps its
 * message, and haptics going unwanted and wanted again while a start is still in flight gets a fresh try once that
 * start fails, instead of latching on the old failure (and once that start succeeds, nothing is owed a fresh try).
 */
import assert from "node:assert/strict";
import type { CarTelemetry } from "../../src/types/f1";
import { DEFAULT_DUALSENSE_SETTINGS } from "../../src/lib/settings/player-settings";
import { dualSenseAudioHaptics } from "../../src/lib/input/dualsense-audio-haptics";
import { dualSenseHid } from "../../src/lib/input/webhid-dualsense";
import { DualSenseDriver, type DualSenseDriveOptions } from "../../src/lib/input/dualsense-driver";

type HapticsState = ReturnType<typeof dualSenseAudioHaptics.getStatus>["state"];

/** The stand-in pad: its USB link, the haptics state, and the starts the driver asked for */
const pad = {
  usb: true,
  state: "off" as HapticsState,
  starts: [] as { ask: boolean; settle: (ok: boolean, state: HapticsState) => void }[],
};

const haptics = dualSenseAudioHaptics as unknown as Record<string, unknown>;
haptics.running = () => pad.state === "on";
haptics.getStatus = () => ({ state: pad.state });
haptics.start = (ask: boolean) => {
  pad.state = "starting";
  return new Promise<boolean>((resolve) => {
    pad.starts.push({
      ask,
      settle: (ok, state) => {
        pad.state = state;
        resolve(ok);
      },
    });
  });
};
haptics.stop = async () => {
  pad.state = "off";
};
haptics.update = () => {};
haptics.pulse = () => {};
haptics.silence = () => {};
const hid = dualSenseHid as unknown as Record<string, unknown>;
hid.transportNow = () => (pad.usb ? "usb" : "bluetooth");
hid.connected = () => false;
hid.quiet = () => {};

const telemetry = {} as CarTelemetry;
const options = (hdHaptics: boolean): DualSenseDriveOptions => ({
  driving: true,
  rumbleOn: true,
  settings: { ...DEFAULT_DUALSENSE_SETTINGS, hdHaptics },
  triggerSlipAlwaysOn: false,
  driverColor: "#ffffff",
});
/** Lets a settled start's `.then` run before the next frame */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  pad.usb = true;
  pad.state = "off";
  pad.starts = [];
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

async function main() {
  await check("a silent try that fails with a reason stops the tries", async () => {
    const driver = new DualSenseDriver();
    driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.starts.length, 1);
    pad.starts[0].settle(false, "error");
    await tick();
    for (let i = 0; i < 5; i++) driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.starts.length, 1, "no more silent tries over the error");
  });

  await check("haptics wanted again while a start is in flight get a fresh try once it fails", async () => {
    const driver = new DualSenseDriver();
    driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.starts.length, 1);
    // The pad leaves USB and comes back while that start is still in flight
    pad.usb = false;
    driver.update(telemetry, 1 / 60, options(true));
    pad.usb = true;
    driver.update(telemetry, 1 / 60, options(true));
    pad.starts[0].settle(false, "error");
    await tick();
    driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.starts.length, 2, "a fresh try right away, not a latched give-up");
    pad.starts[1].settle(true, "on");
    await tick();
    driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.state, "on");
  });

  await check("a start that succeeds after a cycle leaves no fresh try behind for a later error", async () => {
    const driver = new DualSenseDriver();
    driver.update(telemetry, 1 / 60, options(true));
    // Off and on again while that start is in flight, and then it succeeds
    pad.usb = false;
    driver.update(telemetry, 1 / 60, options(true));
    pad.usb = true;
    driver.update(telemetry, 1 / 60, options(true));
    pad.starts[0].settle(true, "on");
    await tick();
    for (let i = 0; i < 3; i++) driver.update(telemetry, 1 / 60, options(true));
    // Later, still wanted, the player starts haptics from Settings and that start fails with its message
    void dualSenseAudioHaptics.start(true);
    driver.update(telemetry, 1 / 60, options(true));
    pad.starts[1].settle(false, "error");
    await tick();
    for (let i = 0; i < 5; i++) driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.starts.length, 2, "no silent try over the player's error");
  });

  await check("an error from a start the player asked for keeps its message", async () => {
    const driver = new DualSenseDriver();
    // Settings starts haptics (ask: true) the same frame the setting comes on
    void dualSenseAudioHaptics.start(true);
    driver.update(telemetry, 1 / 60, options(true));
    pad.starts[0].settle(false, "error");
    await tick();
    for (let i = 0; i < 5; i++) driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.starts.length, 1, "no silent try over the player's error");
  });

  await check("switching the setting off and on again tries once more, even over an old error", async () => {
    const driver = new DualSenseDriver();
    driver.update(telemetry, 1 / 60, options(true));
    pad.starts[0].settle(false, "error");
    await tick();
    driver.update(telemetry, 1 / 60, options(false));
    driver.update(telemetry, 1 / 60, options(true));
    assert.equal(pad.starts.length, 2);
  });

  if (failed) {
    console.log(`\n${failed} DualSense driver check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll DualSense driver checks passed.");
}

void main();
