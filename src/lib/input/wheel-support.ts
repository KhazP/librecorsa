/**
 * Which wheels are known to work, and how. Steering, pedals and buttons come through the browser's Gamepad API for
 * every wheel; force feedback has two paths: WebHID in Chrome/Edge (bases that speak USB HID PID, and the classic
 * Logitech wheels listed below; see webhid-ffb.ts) and the local bridge on Windows (`npm run ffb`, any DirectInput
 * force-feedback wheel).
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
    webHid: "unknown",
    bridge: "expected",
    note: "Untested; starts on the bridge. WebHID is opt-in and sends the classic Logitech commands as Linux hid-lg4ff does",
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
