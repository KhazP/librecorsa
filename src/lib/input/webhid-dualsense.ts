/**
 * The DualSense over WebHID (Chrome / Edge, https or localhost): adaptive triggers, rumble straight to the pad, the
 * lightbar and the LEDs. The Gamepad API still reads the pad's input over USB; over Bluetooth the pad switches to its
 * extended input report once it is written to, which a browser reading the short report would no longer see, so
 * {@link DualSenseHid.bluetoothPad} hands device-input a standard pad parsed from the HID reports instead.
 *
 * Pairing needs a click (requestDevice); after that the browser remembers the grant and the pad is reopened on every
 * visit and every replug without asking ({@link DualSenseHid.restore}).
 */
import type { HidApiLike, HidDeviceLike, HidInputReportEventLike } from "./webhid-ffb";
import type { PadLike } from "./device-input";
import {
  buildCommonBlock,
  buildOutputReport,
  DS_BT_OUTPUT_REPORT_ID,
  DS_FIRMWARE_FEATURE_REPORT_ID,
  DS_USB_OUTPUT_REPORT_ID,
  DUALSENSE_EDGE_PRODUCT_ID,
  DUALSENSE_PRODUCT_ID,
  EMPTY_OUTPUT,
  isDualSenseIds,
  isDualSensePadId,
  outputReportLength,
  parseFeatureVersion,
  parseInputReport,
  SONY_VENDOR_ID,
  TRIGGER_OFF,
  usesVibrationV2,
  type DualSenseInput,
  type DualSenseOutput,
  type DualSenseTransport,
} from "./dualsense-protocol";

export interface DualSenseStatus {
  state: "unsupported" | "idle" | "connecting" | "connected" | "error";
  transport: DualSenseTransport | null;
  /** "DualSense" or "DualSense Edge" while one is open */
  name: string | null;
  battery: { level: number; charging: boolean } | null;
  message: string | null;
}

const FILTERS = [
  { vendorId: SONY_VENDOR_ID, productId: DUALSENSE_PRODUCT_ID },
  { vendorId: SONY_VENDOR_ID, productId: DUALSENSE_EDGE_PRODUCT_ID },
];
/** Shortest gap between output reports (ms): the pad takes them at its 250 Hz report rate at most */
const MIN_WRITE_GAP_MS = 8;
/** An unchanged state is sent again this often, in case another program wrote to the pad in between */
const KEEPALIVE_MS = 1000;
/** No new output for this long while something is moving (a stalled frame loop, a hidden tab): stop it */
const WATCHDOG_MS = 300;
/** Bluetooth input older than this no longer stands in for the Gamepad API pad */
const BT_INPUT_FRESH_MS = 300;
const BATTERY_EMIT_MS = 5000;
const FEATURE_READ_TIMEOUT_MS = 600;
const UNSUPPORTED = "Adaptive triggers and haptics need Chrome or Edge (WebHID) on https or localhost";

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

const sameBytes = (a: Uint8Array | null, b: Uint8Array) => a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

const DEFAULT_PAD_ID = "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)";

export class DualSenseHid {
  private status: DualSenseStatus = { state: "idle", transport: null, name: null, battery: null, message: null };
  private readonly listeners = new Set<() => void>();
  private device: HidDeviceLike | null = null;
  private transport: DualSenseTransport | null = null;
  private reportLength: number | undefined = undefined;
  private vibrationV2 = true;
  private seq = 0;
  private desired: DualSenseOutput = { ...EMPTY_OUTPUT };
  private sentBlock: Uint8Array | null = null;
  /** The rumble emulation was last sent running: the next report without it stops the motors first */
  private sentRumble = false;
  private lightbarSetupPending = false;
  private writing = false;
  private dirty = false;
  private lastWriteMs = -Infinity;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private input: DualSenseInput | null = null;
  private inputMs = -Infinity;
  private padCache: { input: DualSenseInput; pad: PadLike } | null = null;
  private batteryEmitMs = -Infinity;
  private listening = false;
  private opening: Promise<void> | null = null;
  /** A settings-screen test: shown in place of the game's output until it runs out */
  private test: { output: Partial<DualSenseOutput>; untilMs: number } | null = null;
  private testTimer: ReturnType<typeof setTimeout> | null = null;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getStatus = (): DualSenseStatus => this.status;

  private setStatus(patch: Partial<DualSenseStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }

  private hid(): HidApiLike | null {
    if (typeof navigator === "undefined" || typeof window === "undefined" || !window.isSecureContext) return null;
    return (navigator as { hid?: HidApiLike }).hid ?? null;
  }

  supported(): boolean {
    return this.hid() !== null;
  }

  connected(): boolean {
    return this.device !== null && this.status.state === "connected";
  }

  /** True when this driver writes to that Gamepad API pad, so the Gamepad API rumble must leave it alone */
  ownsPad(padId: string): boolean {
    return this.connected() && isDualSensePadId(padId);
  }

  transportNow(): DualSenseTransport | null {
    return this.connected() ? this.transport : null;
  }

  /**
   * Opens the browser's device picker. Must run straight from a click handler: requestDevice needs the click's user
   * activation, so it is called before anything is awaited.
   */
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
        const device = devices.find((d) => isDualSenseIds(d.vendorId, d.productId));
        if (device) return this.open(device);
        if (!this.device) this.setStatus({ state: "idle", message: null });
      },
      (e: unknown) => this.setStatus({ state: this.device ? "connected" : "error", message: errorMessage(e) })
    );
  }

  /** Reopens a pad this site was already given (no prompt), and keeps watching for it being plugged in */
  async restore(): Promise<void> {
    const hid = this.hid();
    if (!hid) {
      this.setStatus({ state: "unsupported", message: UNSUPPORTED });
      return;
    }
    this.listen(hid);
    if (this.device) return;
    try {
      const devices = await hid.getDevices();
      const device = devices.find((d) => isDualSenseIds(d.vendorId, d.productId));
      if (device) await this.open(device);
    } catch (e) {
      this.setStatus({ state: "error", message: errorMessage(e) });
    }
  }

  private listen(hid: HidApiLike) {
    if (this.listening) return;
    this.listening = true;
    hid.addEventListener("connect", ({ device }) => {
      if (!this.device && isDualSenseIds(device.vendorId, device.productId)) void this.open(device);
    });
    hid.addEventListener("disconnect", ({ device }) => {
      if (device !== this.device) return;
      this.drop();
      this.setStatus({ state: "idle", transport: null, name: null, battery: null, message: "DualSense disconnected" });
    });
    if (typeof window !== "undefined") {
      // Best effort: leave the triggers free and the motors still when the tab goes away
      window.addEventListener("pagehide", () => this.release());
    }
  }

  private open(device: HidDeviceLike): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.doOpen(device).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async doOpen(device: HidDeviceLike): Promise<void> {
    const name = device.productId === DUALSENSE_EDGE_PRODUCT_ID ? "DualSense Edge" : "DualSense";
    this.setStatus({ state: "connecting", name, message: null });
    try {
      if (!device.opened) await device.open();
    } catch (e) {
      this.setStatus({ state: "error", name, message: `Could not open the ${name}: ${errorMessage(e)}` });
      return;
    }
    const btLength = outputReportLength(device.collections, DS_BT_OUTPUT_REPORT_ID);
    const usbLength = outputReportLength(device.collections, DS_USB_OUTPUT_REPORT_ID);
    this.transport = btLength !== null ? "bluetooth" : "usb";
    this.reportLength = (btLength ?? usbLength) ?? undefined;
    let featureVersion: number | null = null;
    try {
      featureVersion = parseFeatureVersion(await withTimeout(device.receiveFeatureReport(DS_FIRMWARE_FEATURE_REPORT_ID), FEATURE_READ_TIMEOUT_MS));
    } catch {
      // Unknown firmware: the revised rumble, which every pad updated since 2021 has
    }
    this.vibrationV2 = usesVibrationV2(device.productId, featureVersion);
    this.device = device;
    this.seq = 0;
    this.sentBlock = null;
    this.sentRumble = false;
    this.lightbarSetupPending = true;
    this.input = null;
    this.padCache = null;
    device.addEventListener?.("inputreport", this.onInput);
    if (this.keepaliveTimer === null) this.keepaliveTimer = setInterval(() => this.flush(), KEEPALIVE_MS);
    this.setStatus({ state: "connected", transport: this.transport, name, message: null });
    this.flush();
  }

  private drop() {
    this.device?.removeEventListener?.("inputreport", this.onInput);
    this.device = null;
    this.transport = null;
    this.input = null;
    this.padCache = null;
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private readonly onInput = (e: HidInputReportEventLike) => {
    const t = nowMs();
    // Over USB the Gamepad API reads the sticks; only the battery is wanted from the HID reports, now and then
    if (this.transport === "usb" && t - this.batteryEmitMs < BATTERY_EMIT_MS) return;
    const input = parseInputReport(e.reportId, e.data);
    if (!input) return;
    this.input = input;
    this.inputMs = t;
    if (input.battery && t - this.batteryEmitMs >= BATTERY_EMIT_MS) {
      this.batteryEmitMs = t;
      const b = this.status.battery;
      if (!b || Math.abs(b.level - input.battery.level) > 0.01 || b.charging !== input.battery.charging) {
        this.setStatus({ battery: input.battery });
      }
    }
  };

  /**
   * Over Bluetooth, once the pad sends its extended report: a standard pad read from it, to stand in for the
   * Gamepad API one (which may stop updating). Null over USB, or with no fresh extended report.
   */
  bluetoothPad(): PadLike | null {
    if (this.transport !== "bluetooth" || !this.input?.full || nowMs() - this.inputMs > BT_INPUT_FRESH_MS) return null;
    if (this.padCache?.input === this.input) return this.padCache.pad;
    const input = this.input;
    const pad: PadLike = {
      id: DEFAULT_PAD_ID,
      index: 0,
      mapping: "standard",
      connected: true,
      axes: input.axes,
      buttons: input.buttons.map((pressed, i) => ({
        pressed,
        value: i === 6 ? input.l2 : i === 7 ? input.r2 : pressed ? 1 : 0,
      })),
    };
    this.padCache = { input, pad };
    return pad;
  }

  /** Sets part of the pad's output; it goes out with the next report (at most one every 8 ms) */
  setOutput(patch: Partial<DualSenseOutput>): void {
    this.desired = { ...this.desired, ...patch };
    const moving =
      (this.desired.rumble !== null && (this.desired.rumble.low > 0 || this.desired.rumble.high > 0)) ||
      (this.desired.leftTrigger !== null && this.desired.leftTrigger.mode !== "off") ||
      (this.desired.rightTrigger !== null && this.desired.rightTrigger.mode !== "off");
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = moving ? setTimeout(() => this.quiet(), WATCHDOG_MS) : null;
    this.flush();
  }

  /**
   * Plays `steps` one after another (the settings screen's Test), each laid over the game's output for its time: the
   * frame loop keeps setting the triggers free in the menus, which would cancel a test straight away
   */
  playTest(steps: readonly { output: Partial<DualSenseOutput>; ms: number }[]): void {
    if (this.testTimer !== null) clearTimeout(this.testTimer);
    this.testTimer = null;
    const run = (i: number) => {
      const step = steps[i];
      if (!step) {
        this.test = null;
        this.flush();
        return;
      }
      // A little past the step's end, so a frame that lands before the next step's timer does not flash the game's output
      this.test = { output: step.output, untilMs: nowMs() + step.ms + 250 };
      this.flush();
      this.testTimer = setTimeout(() => run(i + 1), step.ms);
    };
    run(0);
  }

  /** Motors still and triggers free; the lights stay as they are */
  quiet(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.desired = {
      ...this.desired,
      rumble: this.desired.rumble ? { low: 0, high: 0 } : null,
      leftTrigger: TRIGGER_OFF,
      rightTrigger: TRIGGER_OFF,
    };
    this.flush();
  }

  /** Everything back to rest, the player LEDs and mic LED off (leaving the car, closing the tab) */
  release(): void {
    this.desired = { ...this.desired, rumble: { low: 0, high: 0 }, leftTrigger: TRIGGER_OFF, rightTrigger: TRIGGER_OFF, playerLeds: 0, micLed: "off" };
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.flush(true);
  }

  private flush(force = false): void {
    const device = this.device;
    if (!device || !this.transport) return;
    if (this.writing) {
      this.dirty = true;
      return;
    }
    const t = nowMs();
    const wait = MIN_WRITE_GAP_MS - (t - this.lastWriteMs);
    if (wait > 0 && !force) {
      if (this.flushTimer === null) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this.flush();
        }, wait);
      }
      return;
    }
    const base = this.test && t < this.test.untilMs ? { ...this.desired, ...this.test.output } : this.desired;
    // The rumble emulation is claimed only while a motor runs, then released with one report at rest: its flags would
    // otherwise hold the actuators for it, ahead of the audio haptics
    const motors = base.rumble !== null && (base.rumble.low > 0 || base.rumble.high > 0);
    const out = motors ? base : { ...base, rumble: this.sentRumble ? { low: 0, high: 0 } : null };
    const block = buildCommonBlock(out, { vibrationV2: this.vibrationV2, lightbarSetup: this.lightbarSetupPending });
    if (!force && sameBytes(this.sentBlock, block) && t - this.lastWriteMs < KEEPALIVE_MS * 0.9) return;
    const { reportId, data } = buildOutputReport(block, this.transport, this.seq, this.reportLength);
    this.seq = (this.seq + 1) & 0x0f;
    this.writing = true;
    this.dirty = false;
    this.lastWriteMs = t;
    this.sentBlock = block;
    const rumbleBefore = this.sentRumble;
    this.sentRumble = motors;
    const hadSetup = this.lightbarSetupPending;
    this.lightbarSetupPending = false;
    device
      .sendReport(reportId, data)
      .catch((e: unknown) => {
        if (hadSetup) this.lightbarSetupPending = true;
        this.sentRumble = rumbleBefore;
        this.sentBlock = null;
        if (this.status.state === "connected") this.setStatus({ message: `Write failed: ${errorMessage(e)}` });
      })
      .finally(() => {
        this.writing = false;
        if (this.dirty) this.flush();
      });
  }
}

/** The one DualSense driver of the page */
export const dualSenseHid = new DualSenseHid();
