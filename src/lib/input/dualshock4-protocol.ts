/**
 * Sony DualShock 4: what gyro steering reads from it over WebHID, the motion sensors and their calibration, and a
 * standard pad from its Bluetooth report. Layouts as the Linux driver hid-playstation documents them (input report
 * 0x01 over USB and the wireless adapter, 0x11 over Bluetooth with two lead bytes, calibration feature report 0x02
 * over USB and 0x05 over Bluetooth, with the gyro numbers in another order). Offsets are into the report data
 * WITHOUT the report id byte, as WebHID hands it over. Pure byte work, no browser APIs.
 *
 * The axes are the DualSense's (x right, y up out of the face, z toward the player): the same family, read the same
 * way by the Linux and SDL drivers.
 */
import {
  buttonsFrom,
  SONY_VENDOR_ID,
  sonyImuCalibration,
  stick,
  type ImuCalibration,
  type Vec3,
} from "./dualsense-protocol";

export const DS4_PRODUCT_ID = 0x05c4;
export const DS4_V2_PRODUCT_ID = 0x09cc;
/** Sony's USB wireless adapter: the pad behind it reads as a USB pad */
export const DS4_ADAPTER_PRODUCT_ID = 0x0ba0;
export const DS4_PRODUCT_IDS = [DS4_PRODUCT_ID, DS4_V2_PRODUCT_ID, DS4_ADAPTER_PRODUCT_ID] as const;

export function isDualShock4Ids(vendorId: number, productId: number): boolean {
  return vendorId === SONY_VENDOR_ID && (DS4_PRODUCT_IDS as readonly number[]).includes(productId);
}

/**
 * A Gamepad API id that names a DualShock 4: Chrome appends "(… Vendor: 054c Product: 09cc)", Firefox starts with
 * "054c-09cc-", Safari and macOS give a name ("DUALSHOCK 4 Wireless Controller", or the pad's own "Wireless
 * Controller", which an Xbox pad's "Xbox Wireless Controller" does not start with)
 */
export function isDualShock4PadId(id: string): boolean {
  const m = /vendor:\s*([0-9a-f]{4})\b.*?product:\s*([0-9a-f]{4})\b/i.exec(id) ?? /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
  if (m) return isDualShock4Ids(parseInt(m[1] as string, 16), parseInt(m[2] as string, 16));
  return /dualshock/i.test(id) || /^wireless controller\b/i.test(id.trim());
}

export const DS4_USB_INPUT_REPORT_ID = 0x01;
export const DS4_BT_INPUT_REPORT_ID = 0x11;
export const DS4_USB_CALIBRATION_REPORT_ID = 0x02;
export const DS4_BT_CALIBRATION_REPORT_ID = 0x05;
/** Bluetooth output report: listed in the pad's report descriptor only over Bluetooth */
export const DS4_BT_OUTPUT_REPORT_ID = 0x11;
/** The sensor clock counts in 16/3 µs steps and wraps at 2^16 (about every 0.35 s) */
export const DS4_SENSOR_TICKS_PER_S = 187_500;

/** Where the shared block starts: right away over USB, after two lead bytes over Bluetooth */
const USB_BASE = 0;
const BT_BASE = 2;
const C_BUTTONS = 4;
const C_L2 = 7;
const C_R2 = 8;
const C_TIMESTAMP = 9;
const C_GYRO = 12;
const C_ACCEL = 18;
/** The shared block's length */
const COMMON_BYTES = 32;

/** Start of the shared block in a full report, or null for the short Bluetooth report and anything else */
function commonBase(reportId: number, data: DataView): number | null {
  if (reportId === DS4_USB_INPUT_REPORT_ID && data.byteLength >= USB_BASE + COMMON_BYTES) return USB_BASE;
  if (reportId === DS4_BT_INPUT_REPORT_ID && data.byteLength >= BT_BASE + COMMON_BYTES) return BT_BASE;
  return null;
}

/**
 * The IMU calibration from feature report 0x02 (USB, 37 bytes with the id) or 0x05 (Bluetooth, 41 with the id and a
 * CRC). The gyro's plus and minus counts sit pitch+, pitch−, yaw+, yaw−, roll+, roll− over USB and pitch+, yaw+,
 * roll+, pitch−, yaw−, roll− over Bluetooth. With or without the id byte first; null when short or implausible.
 */
export function parseDs4Calibration(reportId: number, view: DataView): ImuCalibration | null {
  const bluetooth = reportId === DS4_BT_CALIBRATION_REPORT_ID;
  if (!bluetooth && reportId !== DS4_USB_CALIBRATION_REPORT_ID) return null;
  const withId = view.byteLength >= (bluetooth ? 41 : 37) && view.getUint8(0) === reportId;
  const o = withId ? 1 : 0;
  if (view.byteLength < o + 34) return null;
  const s16 = (i: number) => view.getInt16(o + i, true);
  return sonyImuCalibration({
    gyroBias: [s16(0), s16(2), s16(4)],
    gyroPlus: bluetooth ? [s16(6), s16(8), s16(10)] : [s16(6), s16(10), s16(14)],
    gyroMinus: bluetooth ? [s16(12), s16(14), s16(16)] : [s16(8), s16(12), s16(16)],
    speed2x: s16(18) + s16(20),
    accelPlus: [s16(22), s16(26), s16(30)],
    accelMinus: [s16(24), s16(28), s16(32)],
  });
}

/** One motion sample of a full DualShock 4 report */
export interface Ds4Motion {
  gyroDps: Vec3;
  accelG: Vec3;
  /** Sensor clock, in {@link DS4_SENSOR_TICKS_PER_S} ticks, 16 bits */
  ticks: number;
  /** Touchpad clicked down */
  touchpad: boolean;
}

/** The motion sensors of a full report (USB 0x01, Bluetooth 0x11), calibrated; null for the short Bluetooth report */
export function parseDs4Motion(reportId: number, data: DataView, calibration: ImuCalibration): Ds4Motion | null {
  const base = commonBase(reportId, data);
  if (base === null) return null;
  const c = calibration;
  const s16 = (o: number) => data.getInt16(base + o, true);
  return {
    gyroDps: [s16(C_GYRO) * c.gyroDpsPerCount[0], s16(C_GYRO + 2) * c.gyroDpsPerCount[1], s16(C_GYRO + 4) * c.gyroDpsPerCount[2]],
    accelG: [
      (s16(C_ACCEL) - c.accelBias[0]) * c.accelGPerCount[0],
      (s16(C_ACCEL + 2) - c.accelBias[1]) * c.accelGPerCount[1],
      (s16(C_ACCEL + 4) - c.accelBias[2]) * c.accelGPerCount[2],
    ],
    ticks: data.getUint16(base + C_TIMESTAMP, true),
    touchpad: (data.getUint8(base + C_BUTTONS + 2) & 0x02) !== 0,
  };
}

/** Sticks, triggers and buttons of a full report, in the Gamepad API's standard order */
export interface Ds4Controls {
  axes: [number, number, number, number];
  l2: number;
  r2: number;
  buttons: boolean[];
}

/** The controls of a full report: the Bluetooth report stands in for the browser's pad once the pad switches to it */
export function parseDs4Controls(reportId: number, data: DataView): Ds4Controls | null {
  const base = commonBase(reportId, data);
  if (base === null) return null;
  const u8 = (o: number) => data.getUint8(base + o);
  const l2 = u8(C_L2) / 255;
  const r2 = u8(C_R2) / 255;
  return {
    axes: [stick(u8(0)), stick(u8(1)), stick(u8(2)), stick(u8(3))],
    l2,
    r2,
    buttons: buttonsFrom(u8(C_BUTTONS), u8(C_BUTTONS + 1), u8(C_BUTTONS + 2), l2, r2),
  };
}
