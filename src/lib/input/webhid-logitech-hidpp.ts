/**
 * EXPERIMENTAL force feedback over WebHID for the Logitech wheels that speak HID++ 2.0: the G920 and the G923 for Xbox
 * (LOGITECH_HIDPP_WHEELS in wheel-support.ts). webhid-ffb.ts picks the wheel and runs the session; this file speaks
 * the protocol.
 *
 * Every message is the one Linux drivers/hid/hid-logitech-hidpp.c sends these wheels (they are its
 * HIDPP_QUIRK_CLASS_G920 entries), the outside source for every byte below; the kernel function that sends the same
 * message is named on each. None of it has been checked on a wheel: nobody here owns one.
 *
 * The protocol in short. A HID++ 2.0 message is an output report 0x11 ("long", 16 parameters) or 0x12 ("very long",
 * length from the report descriptor): device index (0xff for a wheel on USB), feature index, function number << 4 |
 * software id, parameters. The wheel answers each one with an input report carrying the same feature index and
 * function byte, or with an error report naming them. A feature is looked up by its number through the root feature
 * (always index 0); force feedback is feature 0x8123, at whatever index the wheel puts it.
 *
 * One constant-force effect is downloaded into an effect slot the wheel hands out and played; its level is streamed by
 * downloading it again into the same slot, which is what the kernel sends when a game updates a playing effect. Each
 * message waits for its reply before the next goes out, as the kernel's do (one command in flight).
 *
 * Sign: `setForce` takes a PID magnitude along +X (see webhid-ffb.ts). hidpp_ff_upload_effect plays a Linux constant
 * effect as level x sin(direction) (fixp_sin16), + at direction 0x4000 (+X, 90°), the direction hid-pidff hands a PID
 * wheel unchanged; so + force → + level here, as on the classic Logitech path. Unverified on a wheel: Test direction /
 * Invert.
 */

import {
  defaultFfbDeps,
  ForceWriter,
  type FfbDeps,
  type HidCollectionLike,
  type HidDeviceLike,
  type HidInputReportEventLike,
  type PidFieldLayout,
  type SessionBase,
  type SetupResult,
} from "./webhid-ffb";
import { HIDPP_MAX_RANGE_DEG, HIDPP_MIN_RANGE_DEG, type LogitechHidppModel } from "./wheel-support";

/*
 * Nothing from webhid-ffb.ts is used at module level: the two files import each other, and only calls made after both
 * have loaded may touch the other's values.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Protocol constants (hid-logitech-hidpp.c)                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** REPORT_ID_HIDPP_SHORT / _LONG / _VERY_LONG */
const REPORT_SHORT = 0x10;
export const HIDPP_LONG_REPORT = 0x11;
export const HIDPP_VERY_LONG_REPORT = 0x12;
/** Parameters a long report carries (HIDPP_REPORT_LONG_LENGTH - 4); hidpp_send_fap_command_sync sends more as very long */
const LONG_PARAMS = 16;
/** Data bytes of a long report after its id (HIDPP_REPORT_LONG_LENGTH - 1), the least hidpp_validate_device accepts */
const LONG_DATA_BYTES = 19;
/** Most data bytes of a very long report after its id (HIDPP_REPORT_VERY_LONG_MAX_LENGTH - 1) */
const VERY_LONG_MAX_DATA_BYTES = 63;
/** __hidpp_send_report: the device index of a device on USB */
const DEVICE_INDEX = 0xff;
/**
 * Software id, the low nibble of the function byte. Not the kernel's (LINUX_KERNEL_SW_ID, 1), so where
 * hid-logitech-hidpp is bound too (Linux) a reply to it is never taken for one of ours
 */
export const HIDPP_SOFTWARE_ID = 0x0a;
/** HIDPP_PAGE_ROOT_IDX: the root feature is always at index 0 */
const ROOT_INDEX = 0x00;
/** CMD_ROOT_GET_FEATURE (function 0) */
const ROOT_GET_FEATURE = 0;
/** HIDPP_PAGE_G920_FORCE_FEEDBACK */
export const HIDPP_FEATURE_FORCE_FEEDBACK = 0x8123;

/** Function numbers of feature 0x8123: HIDPP_FF_GET_INFO … HIDPP_FF_GET_GLOBAL_GAINS, without the software id */
const FN = {
  GET_INFO: 0,
  RESET_ALL: 1,
  DOWNLOAD_EFFECT: 2,
  SET_EFFECT_STATE: 3,
  DESTROY_EFFECT: 4,
  GET_APERTURE: 5,
  SET_APERTURE: 6,
  GET_GLOBAL_GAINS: 7,
} as const;
/** HIDPP_FF_EFFECT_STATE_STOP / _PLAY */
const STATE_STOP = 0x01;
const STATE_PLAY = 0x02;
/** HIDPP_FF_EFFECT_CONSTANT, HIDPP_FF_EFFECT_SPRING, HIDPP_FF_EFFECT_AUTOSTART */
const EFFECT_CONSTANT = 0x00;
const EFFECT_SPRING = 0x06;
const EFFECT_AUTOSTART = 0x80;
/** HIDPP_FF_RESERVED_SLOTS: GET_INFO counts one slot more than effects can use */
const RESERVED_SLOTS = 1;
/** HIDPP20_ERROR (feature index of a HID++ 2.0 error report) and HIDPP_ERROR (sub id of a HID++ 1.0 one) */
const ERROR_HIDPP20 = 0xff;
const ERROR_HIDPP10 = 0x8f;
/** HIDPP20_ERROR_BUSY; hidpp_send_message_sync sends a command that came back busy up to 3 times in all */
const ERROR_BUSY = 0x08;
const BUSY_ATTEMPTS = 3;

/**
 * Wait for a reply at setup and teardown (ms). The kernel waits 5 s (__do_hidpp_send_message_sync); a wheel that
 * answers at all answers in a few ms, and a reconnect tries the setup again
 */
export const HIDPP_REPLY_TIMEOUT_MS = 500;
/**
 * Wait for the reply to a streamed force level or range (ms). It bounds how long an urgent zero waits behind the
 * write in flight; a level whose reply does not come in time counts as sent (the next level, or the keepalive, follows)
 */
export const HIDPP_STREAM_REPLY_MS = 30;
/**
 * Centring spring strength (FF_AUTOCENTER magnitude, 0..0xffff) given back when the page lets go of the wheel. This
 * step is this driver's choice, not the kernel's: hid-logitech-hidpp leaves the spring as it was last set when it lets
 * go (hidpp_ff_destroy and hidpp_remove restore nothing). Full strength, as the classic Logitech path gives back;
 * whether that matches the spring the wheel has at power-up is not known.
 */
export const HIDPP_AUTOCENTRE_ON_RELEASE = 0xffff;

/**
 * The level is a signed 16-bit value (big-endian on the wire). ±0x7fff keeps both sides equal; the s16 level the
 * kernel takes would reach −0x8000 on one side only
 */
const HIDPP_FORCE_FIELD: PidFieldLayout = { bitOffset: 0, bitSize: 16, min: -0x7fff, max: 0x7fff, signed: true };

/* ------------------------------------------------------------------------------------------------------------ */
/* Messages                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const readBe16 = (b: Uint8Array, at: number) => (((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)) >>> 0;

/** hidpp_root_get_feature: the feature number, big-endian */
function getFeatureParams(feature: number): number[] {
  return be16(feature);
}

/**
 * hidpp_ff_upload_effect, FF_CONSTANT: slot (0 asks for a new one; hidpp_ff_work_handler fills in the slot of an
 * effect already on the wheel), type, length and delay (0 and 0: replay.length 0 is "until stopped" in the Linux FF API,
 * which the kernel passes to the wheel unchanged), the level, then an empty envelope. 14 parameters: a long report
 */
function constantForceParams(slot: number, level: number): number[] {
  return [slot, EFFECT_CONSTANT, 0, 0, 0, 0, ...be16(level & 0xffff), 0, 0, 0, 0, 0, 0];
}

/**
 * hidpp_ff_set_autocenter: a spring, started at once, saturation magnitude / 2 and coefficient magnitude / 8 on both
 * sides, no dead band, centred. Magnitude 0 is g920_ff_set_autocenter's spring (every parameter 0 but the type).
 * 18 parameters: a very long report
 */
function autocentreParams(slot: number, magnitude: number): number[] {
  const m = Math.max(0, Math.min(0xffff, Math.round(magnitude)));
  const saturation = be16(m >> 1);
  const coeff = be16(m >> 3);
  return [slot, EFFECT_SPRING | EFFECT_AUTOSTART, 0, 0, 0, 0, ...saturation, ...coeff, 0, 0, 0, 0, ...coeff, ...saturation];
}

/** hidpp_ff_range_store: degrees lock to lock, big-endian */
function apertureParams(deg: number): number[] {
  return be16(deg);
}

/** A rotation hidpp_ff_range_store would send (it clamps to 180..900°); null for no number */
function hidppRangeDeg(deg: number | null | undefined): number | null {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return null;
  return Math.min(HIDPP_MAX_RANGE_DEG, Math.max(HIDPP_MIN_RANGE_DEG, Math.round(deg)));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Reports                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** The HID++ output reports of an interface: data bytes after the report id */
export interface HidppReports {
  long: number;
  /** null when the interface has no very long report */
  veryLong: number | null;
}

/** Bits of each output report, by id, over the whole collection tree (the most complete listing of a report wins) */
function outputReportBits(collections: readonly HidCollectionLike[], out = new Map<number, number>()): Map<number, number> {
  for (const c of collections) {
    for (const r of c.outputReports ?? []) {
      const bits = (r.items ?? []).reduce((s, i) => s + Math.max(0, i.reportSize ?? 0) * Math.max(0, i.reportCount ?? 0), 0);
      const id = r.reportId ?? 0;
      if (bits > (out.get(id) ?? -1)) out.set(id, bits);
    }
    outputReportBits(c.children ?? [], out);
  }
  return out;
}

/**
 * The interface's HID++ reports, found by report id and size as hidpp_validate_device finds them: a long report of at
 * least 20 bytes is required (FAP commands go out on it), a very long one of 20..64 bytes is used when present. Null
 * without a usable long report. The usage page is not looked at.
 */
export function hidppReports(collections: readonly HidCollectionLike[]): HidppReports | null {
  const bits = outputReportBits(collections);
  const bytes = (id: number) => Math.ceil((bits.get(id) ?? 0) / 8);
  const long = bytes(HIDPP_LONG_REPORT);
  if (long < LONG_DATA_BYTES) return null;
  const veryLong = bytes(HIDPP_VERY_LONG_REPORT);
  return { long, veryLong: veryLong >= LONG_DATA_BYTES && veryLong <= VERY_LONG_MAX_DATA_BYTES ? veryLong : null };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Request / reply                                                                                               */
/* ------------------------------------------------------------------------------------------------------------ */

/** An error report from the wheel (HID++ 2.0 error codes: 0x05 not allowed, 0x08 busy, 0x09 unsupported, …) */
export class HidppError extends Error {
  constructor(
    readonly code: number,
    what: string
  ) {
    super(`The wheel refused ${what} (HID++ error 0x${code.toString(16).padStart(2, "0")})`);
  }
}

class HidppTimeout extends Error {
  constructor(what: string) {
    super(`The wheel did not answer ${what}`);
  }
}

interface Pending {
  featureIndex: number;
  fnByte: number;
  what: string;
  /** A streamed value: a timeout or close counts as sent, not as a failure */
  stream: boolean;
  resolve: (params: Uint8Array | null) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

const fnByte = (fn: number) => ((fn << 4) | HIDPP_SOFTWARE_ID) & 0xff;

/**
 * Messages to one wheel and the replies to them: one command in flight, as hidpp_send_message_sync holds its
 * send_mutex. A reply is matched as hidpp_match_answer and hidpp_match_error match it, by feature index and function
 * byte.
 */
export class HidppLink {
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listening = false;
  private readonly onReport = (e: HidInputReportEventLike) => {
    const v = e.data;
    this.receive(e.reportId, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  };

  constructor(
    readonly device: HidDeviceLike,
    readonly reports: HidppReports,
    private readonly deps: FfbDeps
  ) {}

  /** Starts listening for replies; false when the device cannot deliver input reports */
  open(): boolean {
    if (this.listening) return true;
    if (!this.device.addEventListener) return false;
    this.device.addEventListener("inputreport", this.onReport);
    this.listening = true;
    return true;
  }

  /** Stops listening; a command still waiting gives up (a streamed one counts as sent) */
  close(): void {
    if (this.listening) this.device.removeEventListener?.("inputreport", this.onReport);
    this.listening = false;
    const p = this.pending;
    if (p) this.settle(p, (q) => (q.stream ? q.resolve(null) : q.reject(new HidppTimeout(q.what))));
  }

  /**
   * One message as sendReport takes it (hidpp_send_fap_command_sync): the long report for up to 16 parameters, the
   * very long one past that, zero-padded to the report's length
   */
  message(featureIndex: number, fn: number, params: readonly number[]): { reportId: number; data: Uint8Array } {
    const veryLong = params.length > LONG_PARAMS;
    if (veryLong && (this.reports.veryLong === null || params.length + 3 > this.reports.veryLong)) {
      throw new Error("This wheel has no HID++ report long enough for the message");
    }
    const data = new Uint8Array(veryLong ? (this.reports.veryLong as number) : this.reports.long);
    data[0] = DEVICE_INDEX;
    data[1] = featureIndex & 0xff;
    data[2] = fnByte(fn);
    params.forEach((p, i) => (data[3 + i] = p & 0xff));
    return { reportId: veryLong ? HIDPP_VERY_LONG_REPORT : HIDPP_LONG_REPORT, data };
  }

  /** Sends a message without waiting for its reply (the page is going away); the write is handed over before this returns */
  post(featureIndex: number, fn: number, params: readonly number[]): Promise<void> {
    const m = this.message(featureIndex, fn, params);
    return this.device.sendReport(m.reportId, m.data);
  }

  /**
   * Sends a command and resolves to the reply's parameters, after the command before it has its reply. A busy wheel
   * gets the command up to {@link BUSY_ATTEMPTS} times; an error report rejects with {@link HidppError}, no reply in
   * `timeoutMs` with a timeout error
   */
  request(featureIndex: number, fn: number, params: readonly number[], what: string, timeoutMs = HIDPP_REPLY_TIMEOUT_MS): Promise<Uint8Array> {
    return this.serial(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return (await this.exchange(featureIndex, fn, params, what, timeoutMs, false)) as Uint8Array;
        } catch (e) {
          if (!(e instanceof HidppError && e.code === ERROR_BUSY) || attempt >= BUSY_ATTEMPTS) throw e;
        }
      }
    });
  }

  /**
   * A streamed value (force level, range): resolves once the wheel answers, or after {@link HIDPP_STREAM_REPLY_MS}
   * without an answer. A busy wheel gets the value again, up to {@link BUSY_ATTEMPTS} times as any command
   * (hidpp_send_message_sync), since a zero it never took would not be sent again; rejects on a failed write, a wheel
   * still busy after that, or another error report
   */
  stream(featureIndex: number, fn: number, params: readonly number[], what: string): Promise<void> {
    return this.serial(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.exchange(featureIndex, fn, params, what, HIDPP_STREAM_REPLY_MS, true);
          return;
        } catch (e) {
          if (!(e instanceof HidppError && e.code === ERROR_BUSY) || attempt >= BUSY_ATTEMPTS) throw e;
        }
      }
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** The reply is waited for from before the write, so one that comes back at once is not missed */
  private exchange(
    featureIndex: number,
    fn: number,
    params: readonly number[],
    what: string,
    timeoutMs: number,
    stream: boolean
  ): Promise<Uint8Array | null> {
    let m: { reportId: number; data: Uint8Array };
    try {
      m = this.message(featureIndex, fn, params);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const p: Pending = { featureIndex: featureIndex & 0xff, fnByte: fnByte(fn), what, stream, resolve, reject, timer: null };
      p.timer = this.deps.setTimer(() => {
        p.timer = null;
        this.settle(p, (q) => (q.stream ? q.resolve(null) : q.reject(new HidppTimeout(q.what))));
      }, timeoutMs);
      this.pending = p;
      let sent: Promise<void>;
      try {
        sent = this.device.sendReport(m.reportId, m.data);
      } catch (e) {
        sent = Promise.reject(e);
      }
      sent.catch((e: unknown) => this.settle(p, (q) => q.reject(e instanceof Error ? e : new Error(String(e)))));
    });
  }

  private settle(p: Pending, how: (p: Pending) => void): void {
    if (this.pending !== p) return;
    this.pending = null;
    if (p.timer !== null) this.deps.clearTimer(p.timer);
    p.timer = null;
    how(p);
  }

  /** hidpp_raw_event → hidpp_match_answer / hidpp_match_error, for the HID++ report ids only */
  private receive(reportId: number, b: Uint8Array): void {
    const p = this.pending;
    if (!p || reportId < REPORT_SHORT || reportId > HIDPP_VERY_LONG_REPORT) return;
    if (b[1] === p.featureIndex && b[2] === p.fnByte) {
      this.settle(p, (q) => q.resolve(b.slice(3)));
    } else if ((b[1] === ERROR_HIDPP20 || b[1] === ERROR_HIDPP10) && b[2] === p.featureIndex && b[3] === p.fnByte) {
      const code = b[4] ?? 0;
      this.settle(p, (q) => q.reject(new HidppError(code, q.what)));
    }
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Session                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export interface LogitechHidppSession extends SessionBase {
  kind: "logitech-hidpp";
  model: LogitechHidppModel;
  link: HidppLink;
  /** Index the wheel gave feature 0x8123 (hidpp_root_get_feature) */
  featureIndex: number;
  /** Effect slots the wheel offers, the reserved one not counted (g920_get_config) */
  slotCount: number;
  /** Slot of the constant-force effect */
  forceSlot: number;
  /** Slot of the centring spring g920_ff_set_autocenter set up */
  autocentreSlot: number;
  /** Rotation the wheel reported at setup (deg); null when it did not answer */
  initialRangeDeg: number | null;
  /** A rotation went out, so teardown puts the one read at setup back (900° if none was read) */
  rangeChanged: boolean;
  /** Rotation lock to lock (deg), a stream of `writer`, clamped to 180..900 as hidpp_ff_range_store clamps it */
  setRange: (deg: number) => void;
  /** Global gain the wheel reported at setup (0..0xffff), for diagnostics; null when it did not answer */
  gain: number | null;
}

export interface LogitechHidppSetupOptions {
  deps?: FfbDeps;
  onFail?: (message: string, fatal: boolean) => void;
  /** Rotation to set, lock to lock (deg); null leaves the wheel's own */
  rotationDeg?: number | null;
}

/** Runs a command whose failure must not stop a cleanup, or that the kernel only warns about */
async function tolerate<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch {
    return null;
  }
}

const unsupported = (message: string): SetupResult<LogitechHidppSession> => ({ ok: false, unsupported: true, message });

/**
 * Connect-time setup of a listed HID++ wheel, in g920_get_config's order: find feature 0x8123 (root getFeature), read
 * the slot count (GET_INFO), reset all forces (RESET_ALL), read the rotation (GET_APERTURE) and the global gain
 * (GET_GLOBAL_GAINS), then the zero centring spring (g920_ff_set_autocenter). Then the rotation setting
 * (hidpp_ff_range_store) and one constant-force effect at level 0, downloaded and played as hidpp_ff_upload_effect and
 * hidpp_ff_playback send it. A wheel that does not list the feature is unsupported; one that does not answer is a
 * failure a reconnect tries again. A setup that fails part-way gives back what it took.
 */
export async function setupLogitechHidppDevice(
  device: HidDeviceLike,
  model: LogitechHidppModel,
  options: LogitechHidppSetupOptions = {}
): Promise<SetupResult<LogitechHidppSession>> {
  const deps = options.deps ?? defaultFfbDeps;
  const reports = hidppReports(device.collections);
  if (!reports) return unsupported(`This ${model.name} interface has no HID++ long report (output report 0x11) for force feedback`);
  if (reports.veryLong === null) {
    return unsupported(`This ${model.name} interface has no HID++ very long report (output report 0x12), which the centring spring needs`);
  }
  if (!device.addEventListener) return unsupported(`The browser does not hand this ${model.name}'s replies to the page`);
  const link = new HidppLink(device, reports, deps);

  // What a failure part-way through has to undo
  let featureIndex: number | null = null;
  let autocentreSlot: number | null = null;
  let forceSlot: number | null = null;
  let initialRangeDeg: number | null = null;
  let rangeChanged = false;
  try {
    if (!device.opened) await device.open();
    link.open();

    let lookup: Uint8Array;
    try {
      lookup = await link.request(ROOT_INDEX, ROOT_GET_FEATURE, getFeatureParams(HIDPP_FEATURE_FORCE_FEEDBACK), "the feature lookup");
    } catch (e) {
      // A wheel that answers with an error does not speak HID++ 2.0 here; one that does not answer may still be starting
      if (e instanceof HidppError) {
        link.close();
        return unsupported(`This ${model.name} did not answer the HID++ feature lookup (error 0x${e.code.toString(16).padStart(2, "0")})`);
      }
      throw e;
    }
    const index = lookup[0] ?? 0;
    if (index === 0) {
      link.close();
      return unsupported(`This ${model.name} does not list HID++ force feedback (feature 0x8123)`);
    }
    featureIndex = index;

    const info = await link.request(index, FN.GET_INFO, [], "the force-feedback info request");
    const slotCount = (info[0] ?? 0) - RESERVED_SLOTS;
    if (slotCount < 1) {
      link.close();
      return unsupported(`This ${model.name} offers no effect slot for force feedback`);
    }
    // g920_get_config only warns when these fail
    await tolerate(() => link.request(index, FN.RESET_ALL, [], "the force reset"));
    const aperture = await tolerate(() => link.request(index, FN.GET_APERTURE, [], "the rotation request"));
    initialRangeDeg = aperture ? readBe16(aperture, 0) : null;
    const gains = await tolerate(() => link.request(index, FN.GET_GLOBAL_GAINS, [], "the gain request"));
    const gain = gains ? readBe16(gains, 0) : null;

    const spring = await link.request(index, FN.DOWNLOAD_EFFECT, autocentreParams(0, 0), "the centring spring");
    autocentreSlot = spring[0] ?? 0;

    const range = hidppRangeDeg(options.rotationDeg);
    if (range !== null && range !== initialRangeDeg) {
      rangeChanged = true;
      await link.request(index, FN.SET_APERTURE, apertureParams(range), "the rotation");
    }

    const created = await link.request(index, FN.DOWNLOAD_EFFECT, constantForceParams(0, 0), "the constant-force effect");
    const slot = created[0] ?? 0;
    // hidpp_ff_work_handler keeps a downloaded effect's slot only in 1..num_effects
    if (slot < 1 || slot > slotCount) throw new Error(`The wheel put the constant-force effect in slot ${slot}, outside 1..${slotCount}`);
    forceSlot = slot;
    await link.request(index, FN.SET_EFFECT_STATE, [slot, STATE_PLAY], "starting the constant-force effect");

    const writer = new ForceWriter(
      HIDPP_FORCE_FIELD,
      (level) => link.stream(index, FN.DOWNLOAD_EFFECT, constantForceParams(slot, level), "a force level"),
      deps,
      options.onFail
    );
    const session: LogitechHidppSession = {
      kind: "logitech-hidpp",
      device,
      model,
      writer,
      link,
      featureIndex: index,
      slotCount,
      forceSlot: slot,
      autocentreSlot,
      initialRangeDeg,
      rangeChanged,
      setRange: () => {},
      gain,
    };
    const queueRange = writer.addChannel({
      toRaw: (deg) => deg,
      threshold: 1,
      initialRaw: range ?? initialRangeDeg,
      send: (deg) => {
        session.rangeChanged = true;
        return link.stream(index, FN.SET_APERTURE, apertureParams(deg), "the rotation");
      },
    });
    session.setRange = (deg) => {
      const r = hidppRangeDeg(deg);
      if (r !== null) queueRange(r);
    };
    return { ok: true, session };
  } catch (e) {
    if (featureIndex !== null) {
      const index = featureIndex;
      if (forceSlot !== null) {
        const slot = forceSlot;
        await tolerate(() => link.request(index, FN.DESTROY_EFFECT, [slot], "removing the constant-force effect"));
      }
      if (rangeChanged) {
        const back = initialRangeDeg ?? HIDPP_MAX_RANGE_DEG;
        await tolerate(() => link.request(index, FN.SET_APERTURE, apertureParams(back), "the rotation"));
      }
      if (autocentreSlot !== null) {
        const a = autocentreSlot;
        await tolerate(() => link.request(index, FN.DOWNLOAD_EFFECT, autocentreParams(a, HIDPP_AUTOCENTRE_ON_RELEASE), "the centring spring"));
      }
    }
    link.close();
    return { ok: false, unsupported: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * What the wheel gets when the page lets go of it (teardown, emergency stop), most urgent first: level 0, then the
 * effect stopped and removed as ff-core's erase_effect does it (hidpp_ff_playback with 0, then hidpp_ff_erase_effect),
 * the rotation put back if it was changed, and the centring spring given back ({@link HIDPP_AUTOCENTRE_ON_RELEASE})
 */
function releaseCommands(s: LogitechHidppSession): { fn: number; params: number[]; what: string }[] {
  return [
    { fn: FN.DOWNLOAD_EFFECT, params: constantForceParams(s.forceSlot, 0), what: "a force level" },
    { fn: FN.SET_EFFECT_STATE, params: [s.forceSlot, STATE_STOP], what: "stopping the constant-force effect" },
    { fn: FN.DESTROY_EFFECT, params: [s.forceSlot], what: "removing the constant-force effect" },
    ...(s.rangeChanged
      ? [{ fn: FN.SET_APERTURE, params: apertureParams(s.initialRangeDeg ?? HIDPP_MAX_RANGE_DEG), what: "the rotation" }]
      : []),
    { fn: FN.DOWNLOAD_EFFECT, params: autocentreParams(s.autocentreSlot, HIDPP_AUTOCENTRE_ON_RELEASE), what: "the centring spring" },
  ];
}

/** Best-effort shutdown: {@link releaseCommands}, each after the reply to the one before. Never throws */
export async function teardownLogitechHidppSession(session: LogitechHidppSession): Promise<void> {
  await session.writer.close();
  for (const c of releaseCommands(session)) {
    await tolerate(() => session.link.request(session.featureIndex, c.fn, c.params, c.what));
  }
  session.link.close();
}

/**
 * The page is going away: {@link releaseCommands} all handed to the browser at once, in order, without waiting for a
 * reply (no later promise may get to run). The caller has killed the writer
 */
export function emergencyStopLogitechHidppSession(session: LogitechHidppSession): void {
  for (const c of releaseCommands(session)) {
    try {
      session.link.post(session.featureIndex, c.fn, c.params).catch(() => {});
    } catch {
      // device already gone
    }
  }
  session.link.close();
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Diagnostics                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** How a listed HID++ wheel's interface would be driven, for describeHidDevice */
export function describeLogitechHidppInterface(device: HidDeviceLike, model: LogitechHidppModel): string {
  const r = hidppReports(device.collections);
  if (!r) return `HID PID: none. Logitech ${model.name}, but this interface has no HID++ long report (output report 0x11)`;
  const veryLong = r.veryLong === null ? "no very long report (0x12), which the centring spring needs" : `very long report 0x12 (${r.veryLong + 1} bytes)`;
  return `HID PID: none. Logitech ${model.name}: driven with HID++ force feedback (feature 0x8123) on long report 0x11 (${r.long + 1} bytes), ${veryLong}`;
}

/** One line on a running HID++ session, for diagnose() */
export function describeLogitechHidppSession(s: LogitechHidppSession): string {
  const range = s.initialRangeDeg === null ? "rotation not read" : `rotation ${s.initialRangeDeg}° at setup`;
  const gain = s.gain === null ? "gain not read" : `global gain ${s.gain.toString(16).padStart(4, "0")}`;
  return (
    `logitech-hidpp driver (hid-logitech-hidpp), ${s.model.name}, feature 0x8123 at index ${hex2(s.featureIndex)}, ` +
    `constant force in slot ${s.forceSlot} of ${s.slotCount}, centring spring in slot ${s.autocentreSlot}, ${range}` +
    `${s.rangeChanged ? " (changed from the wheel rotation setting)" : ""}, ${gain}`
  );
}
