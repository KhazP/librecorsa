/**
 * Which wheels are known to work, and how. Steering, pedals and buttons come through the browser's Gamepad API for
 * every wheel; force feedback has two paths: WebHID in Chrome/Edge (bases that speak USB HID PID, and the classic
 * Logitech wheels and Thrustmaster belt bases listed below; see webhid-ffb.ts) and the local bridge on Windows
 * (`npm run ffb`, any DirectInput force-feedback wheel).
 *
 * Only what the maintainer has driven is marked tested. Reports from other wheels move rows up (README:
 * "Wheels and force feedback", issue template "Wheel report").
 */

export const LOGITECH_VENDOR_ID = 0x046d;

export interface LogitechClassicModel {
  productId: number;
  name: string;
  /** Five rev LEDs on the rim, set with lg4ff_set_leds (hid-lg4ff registers them for the G27 and G29 only) */
  revLeds?: boolean;
}

/**
 * Logitech wheels driven over WebHID with the classic Logitech commands, as Linux drivers/hid/hid-lg4ff.c drives them
 * (its lg4ff_devices table). All four take lg4ff_set_range_g25, from 40 to 900°.
 *
 * Left out, so they stay on the bridge: the Driving Force Pro (c298), whose firmware keeps reporting the steering axis
 * over its full range after a range change (hid-lg4ff rescales it in the driver, lg4ff_adjust_dfp_x_axis, which the
 * Gamepad API cannot); a wheel in a compatibility mode (c294 "Driving Force EX", which a G29 can enumerate as);
 * the G920 (c262) and the G923 for Xbox (c26e), which speak HID++ (hid-logitech-hidpp); the PlayStation G923 and the
 * G PRO, which hid-lg4ff does not list.
 */
export const LOGITECH_CLASSIC_WHEELS: readonly LogitechClassicModel[] = [
  { productId: 0xc299, name: "G25" },
  { productId: 0xc29b, name: "G27", revLeds: true },
  { productId: 0xc29a, name: "Driving Force GT" },
  { productId: 0xc24f, name: "G29", revLeds: true },
];
export const LG4FF_MIN_RANGE_DEG = 40;
export const LG4FF_MAX_RANGE_DEG = 900;

export function logitechClassicModel(vendorId: number, productId: number): LogitechClassicModel | null {
  if (vendorId !== LOGITECH_VENDOR_ID) return null;
  return LOGITECH_CLASSIC_WHEELS.find((m) => m.productId === productId) ?? null;
}

/** "G25, G27, Driving Force GT and G29": the listed wheels, for copy */
export const LOGITECH_CLASSIC_NAMES = (() => {
  const names = LOGITECH_CLASSIC_WHEELS.map((m) => m.name);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
})();

export const THRUSTMASTER_VENDOR_ID = 0x044f;

/**
 * Start-up ids: a Thrustmaster wheel first shows itself as a generic "Thrustmaster FFB Wheel" without force feedback,
 * until a driver sends it a USB control request that switches it to its own id (Thrustmaster's driver on Windows; on
 * Linux hid-tminit, github.com/Kimplul/hid-tminit, whose HID id table these are, or the tmdrv tool for some wheels).
 * WebHID cannot send that request, so a wheel still on one of these stays on the bridge.
 */
export const THRUSTMASTER_STARTUP_PRODUCT_IDS: readonly number[] = [0xb65d, 0xb664, 0xb69c];

export interface ThrustmasterModel {
  productId: number;
  name: string;
  /** Rotation lock to lock (deg) the base takes, as hid-tmff2 clamps it (t300rs_set_range, t248_set_range, …) */
  minRangeDeg: number;
  maxRangeDeg: number;
  /**
   * Which hid-tmff2 backend drives it. "t300rs" (hid-tmt300rs.c): open is one command, close one. "t248"
   * (hid-tmt248.c, hid-tmtx.c, hid-tmtsxw.c, hid-tmtspc.c): a burst of setup packets at init, open and close are two
   * commands each. Both use the same effect commands (t300rs_upload_effect and the rest)
   */
  backend: "t300rs" | "t248";
  /** Data bytes of the command report: 63, or 31 for the T300RS in PS4 mode (T300RS_PS4_BUFFER_LENGTH) */
  reportBytes: 63 | 31;
}

/**
 * Thrustmaster belt bases driven over WebHID with the commands of the out-of-tree Linux driver hid-tmff2
 * (github.com/Kimplul/hid-tmff2), by the product ids in its tmff2_devices table. The T-GT II reuses the T300RS id
 * and the T128 the T248's, so they get the same driver.
 *
 * Left out, so they stay on the bridge: the T150 and TMX (0xb677, 0xb67f), which take a different command set (the
 * Linux driver for them is scarburato's t150_driver: no 0x60 command report, an effect loaded in three packets, an
 * 8-bit force); the T500RS and any Thrustmaster id hid-tmff2 does not list; a wheel still on a start-up id
 * ({@link THRUSTMASTER_STARTUP_PRODUCT_IDS}).
 */
export const THRUSTMASTER_WHEELS: readonly ThrustmasterModel[] = [
  { productId: 0xb66e, name: "T300RS or T-GT II", minRangeDeg: 40, maxRangeDeg: 1080, backend: "t300rs", reportBytes: 63 },
  { productId: 0xb66f, name: "T300RS (F1 mode)", minRangeDeg: 40, maxRangeDeg: 1080, backend: "t300rs", reportBytes: 63 },
  { productId: 0xb66d, name: "T300RS (PS4 mode)", minRangeDeg: 40, maxRangeDeg: 1080, backend: "t300rs", reportBytes: 31 },
  { productId: 0xb696, name: "T248 or T128", minRangeDeg: 140, maxRangeDeg: 900, backend: "t248", reportBytes: 63 },
  { productId: 0xb669, name: "TX", minRangeDeg: 140, maxRangeDeg: 900, backend: "t248", reportBytes: 63 },
  { productId: 0xb692, name: "TS-XW", minRangeDeg: 140, maxRangeDeg: 1080, backend: "t248", reportBytes: 63 },
  { productId: 0xb689, name: "TS-PC Racer", minRangeDeg: 140, maxRangeDeg: 1080, backend: "t248", reportBytes: 63 },
];

export function thrustmasterModel(vendorId: number, productId: number): ThrustmasterModel | null {
  if (vendorId !== THRUSTMASTER_VENDOR_ID) return null;
  return THRUSTMASTER_WHEELS.find((m) => m.productId === productId) ?? null;
}

/** "T300RS, T-GT II, T248, TX, TS-XW and TS-PC": the wheels the Thrustmaster driver is written for, for copy */
export const THRUSTMASTER_NAMES = "T300RS, T-GT II, T248, TX, TS-XW and TS-PC";

/** tested: driven by the maintainer; expected: the code path fits, untested; unknown: may not work; no: refused */
export type SupportLevel = "tested" | "expected" | "unknown" | "no";

export interface WheelSupportRow {
  wheel: string;
  /** Force feedback in the browser over WebHID (Chrome / Edge) */
  webHid: SupportLevel;
  /** Force feedback through the local bridge (Windows, `npm run ffb`) */
  bridge: SupportLevel;
  /** One line on what has been checked or why it may not work */
  note: string;
}

export const WHEEL_SUPPORT: readonly WheelSupportRow[] = [
  {
    wheel: "MOZA R9 V2 + KS",
    webHid: "tested",
    bridge: "expected",
    note: "Connects and steers over WebHID; force feedback not yet confirmed",
  },
  {
    wheel: "Other MOZA, Simucube 2, VRS, OpenFFBoard and other HID PID bases",
    webHid: "expected",
    bridge: "expected",
    note: "Untested; uses the same standard force-feedback reports",
  },
  {
    wheel: "Simagic, Cammus, Asetek, Fanatec DD (PC mode), Thrustmaster DD",
    webHid: "unknown",
    bridge: "expected",
    note: "Untested; without HID PID force feedback the page switches to the bridge",
  },
  {
    wheel: "PXN V99",
    webHid: "unknown",
    bridge: "expected",
    note: "Untested; HID PID with Set Effect values of its own, which no PXN wheel has confirmed",
  },
  {
    wheel: `Logitech ${LOGITECH_CLASSIC_NAMES}`,
    webHid: "expected",
    bridge: "expected",
    note: "Untested; starts on WebHID with the classic Logitech commands as Linux hid-lg4ff sends them, rev LEDs on the G27 and G29 included",
  },
  {
    wheel: "Logitech G920, G923, G PRO, Driving Force Pro",
    webHid: "no",
    bridge: "expected",
    note: "Untested; bridge only: the browser speaks only the classic Logitech protocol and cannot rescale the DFP's steering axis",
  },
  {
    wheel: "Thrustmaster T150, T248, T300, TMX; Fanatec CSL Elite",
    webHid: "unknown",
    bridge: "expected",
    note: "Untested; belt / gear bases likely need the bridge",
  },
];

/** The line the wheel setup shows above the list, built from the table so it follows the rows as they change */
export const WHEEL_SUPPORT_SUMMARY = (() => {
  const tested = WHEEL_SUPPORT.filter((r) => r.webHid === "tested" || r.bridge === "tested");
  if (tested.length === 0) return "No wheel has been tested yet.";
  return `Tested: ${tested.map((r) => `${r.wheel} (${r.note.charAt(0).toLowerCase()}${r.note.slice(1)})`).join("; ")}. Other wheels are untested.`;
})();

export const SUPPORT_LABEL: Record<SupportLevel, string> = {
  tested: "Tested",
  expected: "Expected",
  unknown: "Unknown",
  no: "No",
};
