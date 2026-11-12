/**
 * Which wheels are known to work, and how. Steering, pedals and buttons come through the browser's Gamepad API for
 * every wheel; force feedback has two paths: WebHID in Chrome/Edge (bases that speak USB HID PID, and the classic and
 * HID++ Logitech wheels listed below; see webhid-ffb.ts) and the local bridge on Windows (`npm run ffb`, any
 * DirectInput force-feedback wheel).
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
 * the PlayStation G923 and the G PRO, which hid-lg4ff does not list (see {@link LOGITECH_HIDPP_WHEELS} for why they
 * are not driven either). The G920 and the G923 for Xbox speak HID++ and have their own list below.
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

export interface LogitechHidppModel {
  productId: number;
  name: string;
}

/**
 * Logitech wheels driven over WebHID with HID++ 2.0 force feedback (feature 0x8123), as Linux
 * drivers/hid/hid-logitech-hidpp.c drives them (its HIDPP_QUIRK_CLASS_G920 entries); see webhid-logitech-hidpp.ts.
 * These are their PC-mode ids: in Xbox mode, how they start until Logitech G HUB switches them, they are not HID
 * devices and the browser cannot see them.
 *
 * Left out, so they stay on the bridge:
 * - the G923 for PlayStation (c266 / c267): neither mainline driver lists it. The out-of-tree new-lg4ff drives it with
 *   its own slot commands, not the hid-lg4ff bytes the classic path sends, and first switches it out of its
 *   PlayStation id (c267) with a report 0x30 command, after which it comes back as another USB device (c266) that the
 *   page would have to be granted again;
 * - the G PRO (c268 / c272): no mainline driver lists it. The out-of-tree hid-logitech-dd (mescon) drives it through
 *   the RS50's own force-feedback path, not feature 0x8123, says it is expected to work rather than tested, and c272
 *   is also the RS50's id in compatibility mode;
 * - c26d, which new-lg4ff's README names next to the G923 for Xbox: most likely its Xbox-mode id, as c261 is the
 *   G920's (not a HID device); hid-logitech-hidpp's table does not list it.
 */
export const LOGITECH_HIDPP_WHEELS: readonly LogitechHidppModel[] = [
  { productId: 0xc262, name: "G920" },
  { productId: 0xc26e, name: "G923 for Xbox" },
];
/** The rotation hidpp_ff_range_store accepts (it clamps to these) */
export const HIDPP_MIN_RANGE_DEG = 180;
export const HIDPP_MAX_RANGE_DEG = 900;

export function logitechHidppModel(vendorId: number, productId: number): LogitechHidppModel | null {
  if (vendorId !== LOGITECH_VENDOR_ID) return null;
  return LOGITECH_HIDPP_WHEELS.find((m) => m.productId === productId) ?? null;
}

const nameList = (names: readonly string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

/** "G25, G27, Driving Force GT and G29": the listed wheels, for copy */
export const LOGITECH_CLASSIC_NAMES = nameList(LOGITECH_CLASSIC_WHEELS.map((m) => m.name));
/** "G920 and G923 for Xbox" */
export const LOGITECH_HIDPP_NAMES = nameList(LOGITECH_HIDPP_WHEELS.map((m) => m.name));
/** Every Logitech wheel the browser drives, classic and HID++, for copy */
export const LOGITECH_WEBHID_NAMES = nameList([...LOGITECH_CLASSIC_WHEELS, ...LOGITECH_HIDPP_WHEELS].map((m) => m.name));

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
    wheel: `Logitech ${LOGITECH_HIDPP_NAMES}`,
    webHid: "expected",
    bridge: "expected",
    note: "Untested; starts on WebHID with HID++ force feedback as Linux hid-logitech-hidpp sends it, once Logitech G HUB has switched the wheel to PC mode",
  },
  {
    wheel: "Logitech G923 for PlayStation, G PRO, Driving Force Pro",
    webHid: "no",
    bridge: "expected",
    note: "Untested; bridge only: no mainline Linux driver drives the G923 for PlayStation or the G PRO, and the browser cannot rescale the DFP's steering axis",
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
