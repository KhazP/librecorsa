/**
 * Sony DualSense / DualSense Edge HID protocol: the output report that drives the rumble, the adaptive triggers, the
 * lightbar and the LEDs, and the input report the pad sends back. Pure byte work, no browser APIs, so the verify
 * suite checks it without a pad.
 *
 * The report layout is the one the Linux driver hid-playstation documents (USB output report 0x02, Bluetooth output
 * report 0x31 with its CRC-32, input report 0x01 / 0x31, feature report 0x20 for the firmware). The adaptive-trigger
 * effect encodings follow John "Nielk1" Klein's DualSense trigger effect generator (MIT License, see CREDITS.md).
 *
 * Offsets below are into the report data WITHOUT the report id byte, as WebHID's sendReport and inputreport events
 * hand it over.
 */

export const SONY_VENDOR_ID = 0x054c;
export const DUALSENSE_PRODUCT_ID = 0x0ce6;
export const DUALSENSE_EDGE_PRODUCT_ID = 0x0df2;

export type DualSenseTransport = "usb" | "bluetooth";

export function isDualSenseIds(vendorId: number, productId: number): boolean {
  return vendorId === SONY_VENDOR_ID && (productId === DUALSENSE_PRODUCT_ID || productId === DUALSENSE_EDGE_PRODUCT_ID);
}

/**
 * A Gamepad API id that names a DualSense: Chrome appends "(… Vendor: 054c Product: 0ce6)", Firefox starts with
 * "054c-0ce6-", Safari only gives the name
 */
export function isDualSensePadId(id: string): boolean {
  const m = /vendor:\s*([0-9a-f]{4})\b.*?product:\s*([0-9a-f]{4})\b/i.exec(id) ?? /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
  if (m) return isDualSenseIds(parseInt(m[1] as string, 16), parseInt(m[2] as string, 16));
  return /dualsense/i.test(id);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Output report                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

export const DS_USB_OUTPUT_REPORT_ID = 0x02;
export const DS_BT_OUTPUT_REPORT_ID = 0x31;
/** Data bytes of each output report as the pad's report descriptor gives them (report id not counted) */
export const DS_USB_OUTPUT_BYTES = 47;
export const DS_BT_OUTPUT_BYTES = 77;
/** The block both transports share: flags, motors, audio, triggers, LEDs */
export const DS_COMMON_BYTES = 47;
/** Where the common block starts in the Bluetooth report (after the sequence and tag bytes) */
const BT_COMMON_OFFSET = 2;
const BT_TAG = 0x10;
const BT_OUTPUT_CRC_SEED = 0xa2;

// valid_flag0
const FLAG0_COMPATIBLE_VIBRATION = 1 << 0;
const FLAG0_HAPTICS_SELECT = 1 << 1;
const FLAG0_RIGHT_TRIGGER = 1 << 2;
const FLAG0_LEFT_TRIGGER = 1 << 3;
// valid_flag1
const FLAG1_MIC_MUTE_LED = 1 << 0;
const FLAG1_LIGHTBAR = 1 << 2;
const FLAG1_PLAYER_LEDS = 1 << 4;
// valid_flag2
const FLAG2_LIGHTBAR_SETUP = 1 << 1;
const FLAG2_COMPATIBLE_VIBRATION2 = 1 << 2;
/** lightbar_setup: fade the start-up light out, so the lightbar takes the colours sent after it */
const LIGHTBAR_SETUP_LIGHT_OUT = 1 << 1;

/** Common-block offsets */
const C_FLAG0 = 0;
const C_FLAG1 = 1;
const C_MOTOR_RIGHT = 2;
const C_MOTOR_LEFT = 3;
const C_MUTE_LED = 8;
const C_RIGHT_TRIGGER = 10;
const C_LEFT_TRIGGER = 21;
const C_FLAG2 = 38;
const C_LIGHTBAR_SETUP = 41;
const C_PLAYER_LEDS = 43;
const C_RGB = 44;

/** Bytes of one trigger effect: mode, then ten parameters */
export const TRIGGER_EFFECT_BYTES = 11;

/** Adaptive-trigger effect. Positions are the trigger's ten travel zones (0 = released end, 9 = fully in) */
export type TriggerEffect =
  | { mode: "off" }
  /** Resistance from `position` to the end of the travel, strength 1..8 */
  | { mode: "feedback"; position: number; strength: number }
  /** Resistance per zone, 0 (none) .. 8 */
  | { mode: "zones"; strengths: readonly number[] }
  /** The trigger buzzes from `position` on: amplitude 1..8, frequency in Hz (1..255) */
  | { mode: "vibration"; position: number; amplitude: number; frequencyHz: number };

export const TRIGGER_OFF: TriggerEffect = { mode: "off" };

const MODE_OFF = 0x05;
const MODE_FEEDBACK = 0x21;
const MODE_VIBRATION = 0x26;

const clampInt = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo);

/** Packs 10 zone levels (0 = zone off, 1..8) into the active-zone mask and the 3-bit-per-zone values */
function packZones(levels: readonly number[], out: Uint8Array, offset: number): boolean {
  let active = 0;
  let values = 0;
  for (let i = 0; i < 10; i++) {
    const level = clampInt(levels[i] ?? 0, 0, 8);
    if (level === 0) continue;
    active |= 1 << i;
    // 30 bits: past bit 31 the JS shift wraps, so the top zone's bits go in with a multiply
    values += ((level - 1) & 7) * 2 ** (3 * i);
  }
  if (active === 0) return false;
  out[offset + 1] = active & 0xff;
  out[offset + 2] = (active >> 8) & 0xff;
  out[offset + 3] = values & 0xff;
  out[offset + 4] = Math.floor(values / 2 ** 8) & 0xff;
  out[offset + 5] = Math.floor(values / 2 ** 16) & 0xff;
  out[offset + 6] = Math.floor(values / 2 ** 24) & 0xff;
  return true;
}

/**
 * Writes one trigger effect's 11 bytes at `offset`. An effect that would do nothing (strength 0, an empty zone list)
 * is written as Off, as Sony's own encoder does.
 */
export function encodeTriggerEffect(effect: TriggerEffect, out: Uint8Array, offset: number): void {
  out.fill(0, offset, offset + TRIGGER_EFFECT_BYTES);
  switch (effect.mode) {
    case "feedback": {
      const position = clampInt(effect.position, 0, 9);
      const strength = clampInt(effect.strength, 0, 8);
      const levels = Array.from({ length: 10 }, (_, i) => (i >= position ? strength : 0));
      if (packZones(levels, out, offset)) out[offset] = MODE_FEEDBACK;
      else out[offset] = MODE_OFF;
      return;
    }
    case "zones":
      out[offset] = packZones(effect.strengths, out, offset) ? MODE_FEEDBACK : MODE_OFF;
      return;
    case "vibration": {
      const position = clampInt(effect.position, 0, 9);
      const amplitude = clampInt(effect.amplitude, 0, 8);
      const frequency = clampInt(effect.frequencyHz, 0, 255);
      const levels = Array.from({ length: 10 }, (_, i) => (i >= position ? amplitude : 0));
      if (frequency > 0 && packZones(levels, out, offset)) {
        out[offset] = MODE_VIBRATION;
        out[offset + 9] = frequency;
      } else {
        out.fill(0, offset, offset + TRIGGER_EFFECT_BYTES);
        out[offset] = MODE_OFF;
      }
      return;
    }
    default:
      out[offset] = MODE_OFF;
  }
}

/**
 * Zone strengths for a resistance that ramps from `startStrength` at `startZone` to `endStrength` at `endZone` and
 * holds there to the end of the travel (Sony's slope feedback); zones before the start are free
 */
export function slopeZones(startZone: number, endZone: number, startStrength: number, endStrength: number): number[] {
  const s0 = clampInt(startZone, 0, 8);
  const s1 = clampInt(endZone, s0 + 1, 9);
  const out: number[] = [];
  for (let i = 0; i < 10; i++) {
    if (i < s0) out.push(0);
    else if (i >= s1) out.push(clampInt(endStrength, 0, 8));
    else out.push(clampInt(startStrength + ((endStrength - startStrength) * (i - s0)) / (s1 - s0), 0, 8));
  }
  return out;
}

/** Whether two trigger effects encode to the same bytes (so an unchanged effect is not re-sent) */
export function sameTriggerEffect(a: TriggerEffect, b: TriggerEffect): boolean {
  const x = new Uint8Array(TRIGGER_EFFECT_BYTES);
  const y = new Uint8Array(TRIGGER_EFFECT_BYTES);
  encodeTriggerEffect(a, x, 0);
  encodeTriggerEffect(b, y, 0);
  return x.every((v, i) => v === y[i]);
}

/** Mic-mute LED: off, lit, or slowly pulsing */
export type MicLed = "off" | "on" | "pulse";

/** Everything the output report sets. Fields left null are not touched on the pad (their valid flag stays clear) */
export interface DualSenseOutput {
  /**
   * Rumble emulation, 0..1: `low` is the heavy left motor of a classic pad, `high` the light right one. Null leaves
   * the actuators to the audio haptics (USB), which the rumble emulation would otherwise take over.
   */
  rumble: { low: number; high: number } | null;
  rightTrigger: TriggerEffect | null;
  leftTrigger: TriggerEffect | null;
  /** Lightbar colour, 0..255 each */
  lightbar: readonly [number, number, number] | null;
  /** Player-indicator LEDs, bit 0 the leftmost of five */
  playerLeds: number | null;
  micLed: MicLed | null;
}

export const EMPTY_OUTPUT: DualSenseOutput = {
  rumble: null,
  rightTrigger: null,
  leftTrigger: null,
  lightbar: null,
  playerLeds: null,
  micLed: null,
};

export interface CommonBlockOptions {
  /**
   * Firmware with the revised rumble emulation (feature version 2.21 and later, and every DualSense Edge): it feels
   * like a classic pad's motors. Older firmware takes the original mode
   */
  vibrationV2: boolean;
  /** Also release the start-up lightbar animation (sent once after opening, before the first colour) */
  lightbarSetup?: boolean;
}

const byte01 = (v: number) => clampInt((Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0) * 255, 0, 255);

/** The 47-byte block the USB and Bluetooth reports share */
export function buildCommonBlock(output: DualSenseOutput, options: CommonBlockOptions): Uint8Array {
  const c = new Uint8Array(DS_COMMON_BYTES);
  let f0 = 0;
  let f1 = 0;
  let f2 = 0;
  if (output.rumble) {
    f0 |= FLAG0_HAPTICS_SELECT;
    if (options.vibrationV2) f2 |= FLAG2_COMPATIBLE_VIBRATION2;
    else f0 |= FLAG0_COMPATIBLE_VIBRATION;
    c[C_MOTOR_LEFT] = byte01(output.rumble.low);
    c[C_MOTOR_RIGHT] = byte01(output.rumble.high);
  }
  if (output.rightTrigger) {
    f0 |= FLAG0_RIGHT_TRIGGER;
    encodeTriggerEffect(output.rightTrigger, c, C_RIGHT_TRIGGER);
  }
  if (output.leftTrigger) {
    f0 |= FLAG0_LEFT_TRIGGER;
    encodeTriggerEffect(output.leftTrigger, c, C_LEFT_TRIGGER);
  }
  if (output.micLed) {
    f1 |= FLAG1_MIC_MUTE_LED;
    c[C_MUTE_LED] = output.micLed === "on" ? 1 : output.micLed === "pulse" ? 2 : 0;
  }
  if (output.lightbar) {
    f1 |= FLAG1_LIGHTBAR;
    c[C_RGB] = clampInt(output.lightbar[0], 0, 255);
    c[C_RGB + 1] = clampInt(output.lightbar[1], 0, 255);
    c[C_RGB + 2] = clampInt(output.lightbar[2], 0, 255);
  }
  if (output.playerLeds !== null) {
    f1 |= FLAG1_PLAYER_LEDS;
    c[C_PLAYER_LEDS] = output.playerLeds & 0x1f;
  }
  if (options.lightbarSetup) {
    f2 |= FLAG2_LIGHTBAR_SETUP;
    c[C_LIGHTBAR_SETUP] = LIGHTBAR_SETUP_LIGHT_OUT;
  }
  c[C_FLAG0] = f0;
  c[C_FLAG1] = f1;
  c[C_FLAG2] = f2;
  return c;
}

/* CRC-32 (IEEE, reflected), as the Bluetooth reports carry it */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Iterable<number>, crc = 0xffffffff): number {
  let c = crc;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return c >>> 0;
}

/**
 * The output report for a transport: `{ reportId, data }` for WebHID's sendReport. `seq` (0..15) numbers Bluetooth
 * reports; `length` is the data length the pad's descriptor gives (the defaults when unknown).
 */
export function buildOutputReport(
  common: Uint8Array,
  transport: DualSenseTransport,
  seq: number,
  length?: number
): { reportId: number; data: Uint8Array } {
  if (transport === "usb") {
    const data = new Uint8Array(Math.max(DS_COMMON_BYTES, length ?? DS_USB_OUTPUT_BYTES));
    data.set(common, 0);
    return { reportId: DS_USB_OUTPUT_REPORT_ID, data };
  }
  const data = new Uint8Array(Math.max(BT_COMMON_OFFSET + DS_COMMON_BYTES + 4, length ?? DS_BT_OUTPUT_BYTES));
  data[0] = (seq & 0x0f) << 4;
  data[1] = BT_TAG;
  data.set(common, BT_COMMON_OFFSET);
  // The CRC covers a seed byte, the report id and every data byte before it, and sits little-endian at the end
  const body = data.subarray(0, data.length - 4);
  let c = crc32([BT_OUTPUT_CRC_SEED, DS_BT_OUTPUT_REPORT_ID]);
  c = crc32(body, c);
  const crc = ~c >>> 0;
  data[data.length - 4] = crc & 0xff;
  data[data.length - 3] = (crc >>> 8) & 0xff;
  data[data.length - 2] = (crc >>> 16) & 0xff;
  data[data.length - 1] = (crc >>> 24) & 0xff;
  return { reportId: DS_BT_OUTPUT_REPORT_ID, data };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Input report                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

export const DS_USB_INPUT_REPORT_ID = 0x01;
export const DS_BT_INPUT_REPORT_ID = 0x31;

export interface DualSenseInput {
  /** Sticks, −1..1 (+ = right / down, as the Gamepad API reads them) */
  axes: [number, number, number, number];
  /** L2 / R2 travel, 0..1 */
  l2: number;
  r2: number;
  /** Standard-mapping button states (Gamepad API order, 0 Cross … 16 PS, 17 touchpad click) */
  buttons: boolean[];
  /** Battery 0..1 and whether it is charging; null in the short Bluetooth report */
  battery: { level: number; charging: boolean } | null;
  /** Whether this was the full report (USB, or Bluetooth once the pad sends its extended report) */
  full: boolean;
}

const stick = (v: number) => Math.max(-1, Math.min(1, (v - 127.5) / 127.5));

/** D-pad hat (0 = up, clockwise, 8 = none) to up / down / left / right */
function hatToDpad(hat: number): [boolean, boolean, boolean, boolean] {
  if (hat > 7) return [false, false, false, false];
  return [hat === 7 || hat <= 1, hat >= 3 && hat <= 5, hat >= 5 && hat <= 7, hat >= 1 && hat <= 3];
}

function buttonsFrom(b0: number, b1: number, b2: number, l2: number, r2: number): boolean[] {
  const [up, down, left, right] = hatToDpad(b0 & 0x0f);
  return [
    (b0 & 0x20) !== 0, // 0 Cross
    (b0 & 0x40) !== 0, // 1 Circle
    (b0 & 0x10) !== 0, // 2 Square
    (b0 & 0x80) !== 0, // 3 Triangle
    (b1 & 0x01) !== 0, // 4 L1
    (b1 & 0x02) !== 0, // 5 R1
    (b1 & 0x04) !== 0 || l2 > 0.5, // 6 L2
    (b1 & 0x08) !== 0 || r2 > 0.5, // 7 R2
    (b1 & 0x10) !== 0, // 8 Create
    (b1 & 0x20) !== 0, // 9 Options
    (b1 & 0x40) !== 0, // 10 L3
    (b1 & 0x80) !== 0, // 11 R3
    up, // 12
    down, // 13
    left, // 14
    right, // 15
    (b2 & 0x01) !== 0, // 16 PS
    (b2 & 0x02) !== 0, // 17 touchpad click
  ];
}

/** Battery from the status byte: capacity in tenths (low nibble), charging state (high nibble: 1 charging, 2 full) */
function batteryFrom(status: number): { level: number; charging: boolean } {
  const state = status >> 4;
  const level = state === 2 ? 1 : Math.min(1, ((status & 0x0f) * 10 + 5) / 100);
  return { level, charging: state === 1 };
}

/**
 * Parses an input report (data without the report id): USB 0x01 (63 bytes), the Bluetooth extended report 0x31
 * (77 bytes, one byte further in) and the short Bluetooth report 0x01 (9 bytes) the pad sends until it is first
 * written to. Null for anything else.
 */
export function parseInputReport(reportId: number, data: DataView): DualSenseInput | null {
  const n = data.byteLength;
  let base: number;
  if (reportId === DS_USB_INPUT_REPORT_ID && n >= 55) base = 0;
  else if (reportId === DS_BT_INPUT_REPORT_ID && n >= 56) base = 1;
  else if (reportId === DS_USB_INPUT_REPORT_ID && n >= 9) {
    // Short Bluetooth report: sticks, three button bytes, then the triggers
    const l2 = data.getUint8(7) / 255;
    const r2 = data.getUint8(8) / 255;
    return {
      axes: [stick(data.getUint8(0)), stick(data.getUint8(1)), stick(data.getUint8(2)), stick(data.getUint8(3))],
      l2,
      r2,
      buttons: buttonsFrom(data.getUint8(4), data.getUint8(5), data.getUint8(6), l2, r2),
      battery: null,
      full: false,
    };
  } else return null;
  const u8 = (o: number) => data.getUint8(base + o);
  const l2 = u8(4) / 255;
  const r2 = u8(5) / 255;
  return {
    axes: [stick(u8(0)), stick(u8(1)), stick(u8(2)), stick(u8(3))],
    l2,
    r2,
    buttons: buttonsFrom(u8(7), u8(8), u8(9), l2, r2),
    battery: batteryFrom(u8(52)),
    full: true,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Firmware                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

export const DS_FIRMWARE_FEATURE_REPORT_ID = 0x20;
/** Feature version 2.21: the first with the revised rumble emulation */
export const DS_VIBRATION_V2_FEATURE_VERSION = 0x0215;

/**
 * The feature version (major << 8 | minor) from feature report 0x20, or null. Chrome hands the report over with its
 * id as the first byte; without it everything sits one byte earlier.
 */
export function parseFeatureVersion(view: DataView): number | null {
  const withId = view.byteLength >= 46 && view.getUint8(0) === DS_FIRMWARE_FEATURE_REPORT_ID;
  const offset = withId ? 44 : 43;
  if (view.byteLength < offset + 2) return null;
  const v = view.getUint16(offset, true);
  return v > 0 && v < 0xffff ? v : null;
}

/** Revised rumble: feature version 2.21 or later, and every DualSense Edge; unknown firmware gets it too */
export function usesVibrationV2(productId: number, featureVersion: number | null): boolean {
  if (productId === DUALSENSE_EDGE_PRODUCT_ID) return true;
  return featureVersion === null || featureVersion >= DS_VIBRATION_V2_FEATURE_VERSION;
}

/** Data length of an output report from the pad's report descriptor, or null when it does not list it */
export function outputReportLength(
  collections: readonly { outputReports?: readonly { reportId?: number; items?: readonly { reportSize?: number; reportCount?: number }[] }[]; children?: readonly unknown[] }[],
  reportId: number
): number | null {
  const visit = (list: readonly unknown[]): number | null => {
    for (const raw of list) {
      const c = raw as { outputReports?: readonly { reportId?: number; items?: readonly { reportSize?: number; reportCount?: number }[] }[]; children?: readonly unknown[] };
      for (const r of c.outputReports ?? []) {
        if (r.reportId !== reportId) continue;
        const bits = (r.items ?? []).reduce((s, it) => s + (it.reportSize ?? 0) * (it.reportCount ?? 0), 0);
        if (bits > 0) return Math.ceil(bits / 8);
      }
      const inner = visit(c.children ?? []);
      if (inner !== null) return inner;
    }
    return null;
  };
  return visit(collections);
}
