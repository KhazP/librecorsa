/**
 * The DualShock 4 over WebHID, for gyro steering only (Chrome / Edge, https or localhost): the browser's Gamepad API
 * has no motion, so the pad's own reports are read. Nothing is written to the pad; rumble stays with the Gamepad API.
 *
 * Over Bluetooth, reading the calibration switches the pad to its full report, which a browser reading the short one
 * may no longer see: {@link DualShock4Hid.bluetoothPad} hands device-input a standard pad parsed from the HID
 * reports instead, as the DualSense driver does. The pad is first opened when the player connects it in the gyro
 * card; a pad granted then is reopened on every visit and replug, like the DualSense, so a pad left in its full
 * report always has its stand-in.
 */
import type { HidApiLike, HidDeviceLike, HidInputReportEventLike } from "./webhid-ffb";
import type { PadLike } from "./device-input";
import { NOMINAL_IMU_CALIBRATION, outputReportLength, SONY_VENDOR_ID, type DualSenseTransport, type ImuCalibration } from "./dualsense-protocol";
import {
  DS4_ADAPTER_PRODUCT_ID,
  DS4_BT_CALIBRATION_REPORT_ID,
  DS4_BT_OUTPUT_REPORT_ID,
  DS4_PRODUCT_IDS,
  DS4_SENSOR_TICKS_PER_S,
  DS4_USB_CALIBRATION_REPORT_ID,
  isDualShock4Ids,
  parseDs4Calibration,
  parseDs4Controls,
  parseDs4Motion,
  type Ds4Controls,
} from "./dualshock4-protocol";
import { PadTilt, SensorClock } from "./gyro-steer";

export interface DualShock4Status {
  state: "unsupported" | "idle" | "connecting" | "connected" | "error";
  transport: DualSenseTransport | null;
  message: string | null;
}

const FILTERS = DS4_PRODUCT_IDS.map((productId) => ({ vendorId: SONY_VENDOR_ID, productId }));
const FEATURE_READ_TIMEOUT_MS = 600;
/** Motion older than this no longer steers (ms) */
const MOTION_FRESH_MS = 300;
/** Bluetooth input older than this no longer stands in for the Gamepad API pad (ms) */
const BT_INPUT_FRESH_MS = 300;
const UNSUPPORTED = "Gyro steering needs Chrome or Edge (WebHID) on https or localhost";

/** The page's WebHID, on https or localhost */
function browserHid(): HidApiLike | null {
  if (typeof navigator === "undefined" || typeof window === "undefined" || !window.isSecureContext) return null;
  return (navigator as { hid?: HidApiLike }).hid ?? null;
}

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

export class DualShock4Hid {
  private status: DualShock4Status = { state: "idle", transport: null, message: null };
  private readonly listeners = new Set<() => void>();
  private device: HidDeviceLike | null = null;
  private transport: DualSenseTransport | null = null;
  private calibration: ImuCalibration = NOMINAL_IMU_CALIBRATION;
  private readonly tilt = new PadTilt();
  private readonly clock = new SensorClock(DS4_SENSOR_TICKS_PER_S, 16);
  private motionFromSettings = false;
  private motionHolders = 0;
  private motionMs = -Infinity;
  private controls: Ds4Controls | null = null;
  private controlsMs = -Infinity;
  private padCache: { controls: Ds4Controls; pad: PadLike } | null = null;
  private listening = false;
  private opening: Promise<void> | null = null;

  /** `hidApi` is the browser's WebHID by default; the verify suite hands it a fake */
  constructor(private readonly hidApi: () => HidApiLike | null = browserHid) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getStatus = (): DualShock4Status => this.status;

  private setStatus(patch: Partial<DualShock4Status>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }

  private hid(): HidApiLike | null {
    return this.hidApi();
  }

  supported(): boolean {
    return this.hid() !== null;
  }

  connected(): boolean {
    return this.device !== null && this.status.state === "connected";
  }

  /** Opens the browser's device picker; must run straight from a click (requestDevice needs its user activation) */
  connect(): Promise<void> {
    const hid = this.hid();
    if (!hid) {
      this.setStatus({ state: "unsupported", message: UNSUPPORTED });
      return Promise.resolve();
    }
    let picking: Promise<HidDeviceLike[]>;
    try {
      picking = hid.requestDevice({ filters: FILTERS });
    } catch (e) {
      this.setStatus({ state: "error", message: errorMessage(e) });
      return Promise.resolve();
    }
    this.listen(hid);
    return picking.then(
      (devices) => {
        const device = devices.find((d) => isDualShock4Ids(d.vendorId, d.productId));
        if (device) return this.open(device);
        if (!this.device) this.setStatus({ state: "idle", message: null });
      },
      (e: unknown) => this.setStatus({ state: this.device ? "connected" : "error", message: errorMessage(e) })
    );
  }

  /** Reopens a pad this site was already given (no prompt), and keeps watching for it being plugged in */
  async restore(): Promise<void> {
    const hid = this.hid();
    if (!hid) return;
    this.listen(hid);
    if (this.device) return;
    try {
      const devices = await hid.getDevices();
      const device = devices.find((d) => isDualShock4Ids(d.vendorId, d.productId));
      if (device) await this.open(device);
    } catch (e) {
      this.setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  private listen(hid: HidApiLike) {
    if (this.listening) return;
    this.listening = true;
    hid.addEventListener("connect", ({ device }) => {
      if (!this.device && isDualShock4Ids(device.vendorId, device.productId)) void this.open(device);
    });
    hid.addEventListener("disconnect", ({ device }) => {
      if (device !== this.device) return;
      this.drop();
      this.setStatus({ state: "idle", transport: null, message: "DualShock 4 disconnected" });
    });
  }

  private open(device: HidDeviceLike): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.doOpen(device).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(device: HidDeviceLike): Promise<void> {
    this.setStatus({ state: "connecting", message: null });
    try {
      if (!device.opened) await device.open();
    } catch (e) {
      this.setStatus({ state: "error", message: `Could not open the DualShock 4: ${errorMessage(e)}` });
      return;
    }
    // Only the Bluetooth descriptor lists output report 0x11; the wireless adapter is a USB pad
    const bluetooth = device.productId !== DS4_ADAPTER_PRODUCT_ID && outputReportLength(device.collections, DS4_BT_OUTPUT_REPORT_ID) !== null;
    this.transport = bluetooth ? "bluetooth" : "usb";
    // The calibration; over Bluetooth this read also turns on the full report. The other transport's report is
    // tried too, in case the descriptor misled
    const ids = bluetooth ? [DS4_BT_CALIBRATION_REPORT_ID, DS4_USB_CALIBRATION_REPORT_ID] : [DS4_USB_CALIBRATION_REPORT_ID, DS4_BT_CALIBRATION_REPORT_ID];
    let calibration: ImuCalibration | null = null;
    for (const id of ids) {
      try {
        calibration = parseDs4Calibration(id, await withTimeout(device.receiveFeatureReport(id), FEATURE_READ_TIMEOUT_MS));
      } catch {
        calibration = null;
      }
      if (calibration) break;
    }
    // Nominal scales when the pad has none (some licensed and clone pads): within a few percent of a real one's
    this.calibration = calibration ?? NOMINAL_IMU_CALIBRATION;
    this.device = device;
    this.tilt.reset();
    this.clock.reset();
    this.motionMs = -Infinity;
    this.controls = null;
    this.padCache = null;
    device.addEventListener?.("inputreport", this.onInput);
    this.setStatus({ state: "connected", transport: this.transport, message: null });
  }

  private drop() {
    this.device?.removeEventListener?.("inputreport", this.onInput);
    this.device = null;
    this.transport = null;
    this.controls = null;
    this.padCache = null;
    this.tilt.reset();
    this.clock.reset();
    this.motionMs = -Infinity;
  }

  private readonly onInput = (e: HidInputReportEventLike) => {
    const t = nowMs();
    if (this.motionWanted()) {
      const motion = parseDs4Motion(e.reportId, e.data, this.calibration);
      if (motion) {
        const dtS = this.clock.step(motion.ticks, t);
        this.tilt.update({ gyroDps: motion.gyroDps, accelG: motion.accelG, dtS, recentreHeld: motion.touchpad });
        this.motionMs = t;
      }
    }
    if (this.transport === "bluetooth") {
      const controls = parseDs4Controls(e.reportId, e.data);
      if (controls) {
        this.controls = controls;
        this.controlsMs = t;
      }
    }
  };

  /**
   * Over Bluetooth, once the pad sends its full report: a standard pad read from it, to stand in for the Gamepad API
   * one (which may stop updating). Null over USB, or with no fresh full report.
   */
  bluetoothPad(): PadLike | null {
    const device = this.device;
    if (this.transport !== "bluetooth" || !device || !this.controls || nowMs() - this.controlsMs > BT_INPUT_FRESH_MS) return null;
    if (this.padCache?.controls === this.controls) return this.padCache.pad;
    const c = this.controls;
    const product = device.productId.toString(16).padStart(4, "0");
    const pad: PadLike = {
      id: `Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: ${product})`,
      index: 0,
      mapping: "standard",
      connected: true,
      axes: c.axes,
      buttons: c.buttons.map((pressed, i) => ({ pressed, value: i === 6 ? c.l2 : i === 7 ? c.r2 : pressed ? 1 : 0 })),
    };
    this.padCache = { controls: c, pad };
    return pad;
  }

  private motionWanted(): boolean {
    return this.motionFromSettings || this.motionHolders > 0;
  }

  /** Gyro steering on or off, from the settings (the frame loop sets it every frame) */
  setMotionWanted(on: boolean): void {
    if (on && !this.motionWanted()) {
      this.tilt.reset();
      this.clock.reset();
    }
    this.motionFromSettings = on;
  }

  /** Keeps the motion tracked while a settings screen shows it; call the returned function to let go */
  holdMotion(): () => void {
    if (!this.motionWanted()) {
      this.tilt.reset();
      this.clock.reset();
    }
    this.motionHolders++;
    let held = true;
    return () => {
      if (held) this.motionHolders--;
      held = false;
    };
  }

  /** The pad's lean from its centre (deg, + = right), or null with no DualShock 4 streaming its motion */
  gyroSteerDeg(): number | null {
    if (!this.connected() || nowMs() - this.motionMs > MOTION_FRESH_MS) return null;
    return this.tilt.steerDeg();
  }

  recentreGyro(): void {
    this.tilt.recentre();
  }
}

/** The one DualShock 4 driver of the page */
export const dualShock4Hid = new DualShock4Hid();
