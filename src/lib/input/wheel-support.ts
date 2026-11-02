/**
 * Which wheels are known to work, and how. Steering, pedals and buttons come through the browser's Gamepad API for
 * every wheel; force feedback has two paths: WebHID in Chrome/Edge (bases that speak USB HID PID, see
 * webhid-ffb.ts) and the local bridge on Windows (`npm run ffb`, any DirectInput force-feedback wheel).
 *
 * Only what the maintainer has driven is marked tested. Reports from other wheels move rows up (README:
 * "Wheels and force feedback", issue template "Wheel report").
 */

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
    wheel: "Logitech G29, G920, G923, G PRO",
    webHid: "no",
    bridge: "expected",
    note: "Untested; Logitech's force feedback is proprietary, bridge only",
  },
  {
    wheel: "Thrustmaster T150, T248, T300, TMX; Fanatec CSL Elite",
    webHid: "unknown",
    bridge: "expected",
    note: "Untested; belt / gear bases likely need the bridge",
  },
];

/** The line the wheel setup shows above the list */
export const WHEEL_SUPPORT_SUMMARY =
  "Tested: MOZA R9 V2 + KS connects over WebHID; its force feedback is not confirmed yet. Other wheels are untested.";

export const SUPPORT_LABEL: Record<SupportLevel, string> = {
  tested: "Tested",
  expected: "Expected",
  unknown: "Unknown",
  no: "No",
};
