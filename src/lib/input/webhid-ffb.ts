/**
 * EXPERIMENTAL force feedback straight from the browser over WebHID (Chrome / Edge, https or localhost).
 *
 * Most direct-drive bases (Simagic, Moza, Simucube, VRS, Fanatec DD in PC mode, Asetek, OpenFFBoard, …) expose USB
 * HID PID (Physical Interface Device, usage page 0x0F): the protocol DirectInput force feedback rides on in Windows.
 * WebHID can write those same reports, so no native bridge is needed. This driver keeps ONE Constant Force effect
 * alive on the wheel and streams its magnitude (the shaped rim force) with Set Constant Force reports.
 *
 * Nothing here is hard-coded per device for PID wheels: report ids, field order and bit sizes come from the parsed
 * report descriptor (`device.collections`), see {@link parsePidLayout}. Classic Logitech G-series wheels (G25, G27,
 * G29, Driving Force GT/Pro) that do not expose HID PID are driven via the classic 7-byte Logitech HID protocol
 * ({@link setupLogitechDevice}), while PID-capable Logitech wheels (such as G923 in PID mode) use the standard PID path.
 *
 * Sign convention: `WebHidFfb.setForce` takes the raw PID magnitude, −1..1 over the field's logical range. A PID /
 * DirectInput direction says where the force comes from, so + magnitude along +X (90°) pushes the rim left and − pushes
 * it right. The game's forces are + = right; `linkHidSink` in wheel-ffb.ts flips the sign between the two.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Minimal WebHID types (the @types package is not installed)                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** One field group of a report descriptor (HIDReportItem) */
export interface HidReportItemLike {
  /** Each usage is (usagePage << 16) | usageId */
  usages?: readonly number[];
  usageMinimum?: number;
  usageMaximum?: number;
  isRange?: boolean;
  reportSize?: number;
  reportCount?: number;
  logicalMinimum?: number;
  logicalMaximum?: number;
  isArray?: boolean;
  isConstant?: boolean;
}

export interface HidReportInfoLike {
  reportId?: number;
  items?: readonly HidReportItemLike[];
}

export interface HidCollectionLike {
  usagePage?: number;
  usage?: number;
  type?: number;
  children?: readonly HidCollectionLike[];
  inputReports?: readonly HidReportInfoLike[];
  outputReports?: readonly HidReportInfoLike[];
  featureReports?: readonly HidReportInfoLike[];
}

/** The slice of HIDDevice this driver uses */
export interface HidDeviceLike {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections: readonly HidCollectionLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}

/** The slice of navigator.hid this driver uses */
export interface HidApiLike {
  requestDevice(options: { filters: { vendorId?: number; productId?: number; usagePage?: number; usage?: number }[] }): Promise<HidDeviceLike[]>;
  getDevices(): Promise<HidDeviceLike[]>;
  addEventListener(type: "connect" | "disconnect", listener: (e: { device: HidDeviceLike }) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (e: { device: HidDeviceLike }) => void): void;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* PID usages                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

const PAGE_PID = 0x0f;
const PAGE_DESKTOP = 0x01;
const PAGE_ORDINAL = 0x0a;
const pidUsage = (id: number) => (PAGE_PID << 16) | id;

/** Full usages ((page << 16) | id) used as field keys in {@link PidReportLayout.fields} and buildReport values */
export const PID = {
  EFFECT_BLOCK_INDEX: pidUsage(0x22),
  PARAMETER_BLOCK_OFFSET: pidUsage(0x23),
  EFFECT_TYPE: pidUsage(0x25),
  ET_CONSTANT_FORCE: pidUsage(0x26),
  POOL_BYTE_COUNT: pidUsage(0x2b),
  ET_SPRING: pidUsage(0x40),
  ET_DAMPER: pidUsage(0x41),
  DURATION: pidUsage(0x50),
  SAMPLE_PERIOD: pidUsage(0x51),
  GAIN: pidUsage(0x52),
  TRIGGER_BUTTON: pidUsage(0x53),
  TRIGGER_REPEAT_INTERVAL: pidUsage(0x54),
  AXES_ENABLE: pidUsage(0x55),
  DIRECTION_ENABLE: pidUsage(0x56),
  DIRECTION: pidUsage(0x57),
  CP_OFFSET: pidUsage(0x60),
  POSITIVE_COEFFICIENT: pidUsage(0x61),
  NEGATIVE_COEFFICIENT: pidUsage(0x62),
  POSITIVE_SATURATION: pidUsage(0x63),
  NEGATIVE_SATURATION: pidUsage(0x64),
  DEAD_BAND: pidUsage(0x65),
  MAGNITUDE: pidUsage(0x70),
  EFFECT_OPERATION: pidUsage(0x78),
  OP_EFFECT_START: pidUsage(0x79),
  OP_EFFECT_START_SOLO: pidUsage(0x7a),
  OP_EFFECT_STOP: pidUsage(0x7b),
  LOOP_COUNT: pidUsage(0x7c),
  DEVICE_GAIN: pidUsage(0x7e),
  BLOCK_LOAD_STATUS: pidUsage(0x8b),
  BLOCK_LOAD_SUCCESS: pidUsage(0x8c),
  BLOCK_LOAD_FULL: pidUsage(0x8d),
  BLOCK_LOAD_ERROR: pidUsage(0x8e),
  DEVICE_CONTROL: pidUsage(0x96),
  DC_ENABLE_ACTUATORS: pidUsage(0x97),
  DC_DISABLE_ACTUATORS: pidUsage(0x98),
  DC_STOP_ALL_EFFECTS: pidUsage(0x99),
  DC_DEVICE_RESET: pidUsage(0x9a),
  DC_DEVICE_PAUSE: pidUsage(0x9b),
  DC_DEVICE_CONTINUE: pidUsage(0x9c),
  START_DELAY: pidUsage(0xa7),
  BYTE_COUNT: pidUsage(0xac),
} as const;

/** Generic Desktop X, the steering axis */
const AXIS_X = (PAGE_DESKTOP << 16) | 0x30;
const AXIS_Y = (PAGE_DESKTOP << 16) | 0x31;
const AXIS_Z = (PAGE_DESKTOP << 16) | 0x32;
/** Generic Desktop Byte Count (0x01:0x3b), used by some PID descriptors in Create New Effect */
const DESKTOP_BYTE_COUNT = (PAGE_DESKTOP << 16) | 0x3b;
/** Ordinal usage n (Direction is one Ordinal-usage field per axis: ordinal 1 = X) */
export const ordinalUsage = (n: number) => (PAGE_ORDINAL << 16) | n;

/** Array ("selector") fields: the child usages that identify which selector a field is, and the key it is stored under */
const SELECTORS: readonly { key: number; lo: number; hi: number }[] = [
  { key: PID.EFFECT_TYPE, lo: 0x26, hi: 0x43 },
  { key: PID.EFFECT_OPERATION, lo: 0x79, hi: 0x7b },
  { key: PID.DEVICE_CONTROL, lo: 0x97, hi: 0x9c },
  { key: PID.BLOCK_LOAD_STATUS, lo: 0x8c, hi: 0x8e },
];

const VENDOR_LOGITECH = 0x046d;
const MIN_WRITE_INTERVAL_MS = 2;
/** Consecutive failed writes after which the driver gives up and reports an error */
const MAX_WRITE_FAILURES = 3;
/** An unchanged force is written again after this long (ms): covers a write the wheel dropped without an error */
export const FORCE_KEEPALIVE_MS = 200;
/** Direction value for "along +X" (90 degrees, east) as a fraction of the direction field's range */
const DIRECTION_X_FRACTION = 0.25;

/* ------------------------------------------------------------------------------------------------------------ */
/* Layout                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/** Where one field sits in a report's data (the report id byte is not counted) */
export interface PidFieldLayout {
  /** Bit offset from the start of the report data, little-endian bit packing */
  bitOffset: number;
  bitSize: number;
  /** Normalised logical range (an unsigned field described with a sign-extended maximum is repaired) */
  min: number;
  max: number;
  signed: boolean;
  /** Array / selector fields: the usages the field can select; the value is `min + index` */
  usages?: number[];
}

export interface PidFieldEntry extends PidFieldLayout {
  usage: number;
  isArray?: boolean;
}

export interface PidReportLayout {
  /** 0 when the device uses no report ids */
  reportId: number;
  /** Total data bits including padding; sendReport needs exactly ceil(bitLength / 8) bytes */
  bitLength: number;
  /** Field per full usage ((page << 16) | id); selectors are keyed by their parent usage (PID.EFFECT_TYPE, …) */
  fields: Record<number, PidFieldLayout>;
  /** Ordered list of all non-constant fields in the report (preserves duplicate usages such as X in Axes Enable and Direction) */
  fieldList?: PidFieldEntry[];
}

export interface PidLayout {
  /** Output reports */
  constantForce: PidReportLayout;
  effectOperation: PidReportLayout;
  setEffect: PidReportLayout | null;
  setCondition?: PidReportLayout | null;
  deviceControl: PidReportLayout | null;
  deviceGain: PidReportLayout | null;
  blockFree: PidReportLayout | null;
  /** Feature / input reports */
  createNewEffect: PidReportLayout | null;
  blockLoad: PidReportLayout | null;
  /** Whether the wheel's descriptor supports a hardware PID Spring (0x40) or Damper (0x41) condition effect */
  hasSpring?: boolean;
  hasDamper?: boolean;
}

const hasField = (l: PidReportLayout, key: number) => key in l.fields;
const getField = (l: PidReportLayout, key: number): PidFieldLayout | undefined => l.fields[key] as PidFieldLayout | undefined;

/** Logical range of a field: repairs `0..-1` style maxima of unsigned fields and fills a missing range */
function normaliseRange(min: number | undefined, max: number | undefined, bitSize: number): { min: number; max: number } {
  const full = 2 ** Math.min(bitSize, 32) - 1;
  let lo = typeof min === "number" && Number.isFinite(min) ? min : 0;
  let hi = typeof max === "number" && Number.isFinite(max) ? max : lo < 0 ? 2 ** (Math.min(bitSize, 32) - 1) - 1 : full;
  if (hi < lo) {
    // "Logical Maximum (255)" written as a one-byte item is read back as -1: the field is unsigned
    if (lo >= 0) hi = full;
    else [lo, hi] = [hi, lo];
  }
  return { min: lo, max: hi };
}

function expandUsages(item: HidReportItemLike): number[] {
  const out = item.usages ? [...item.usages] : [];
  if (out.length === 0 && item.isRange && typeof item.usageMinimum === "number" && typeof item.usageMaximum === "number") {
    for (let u = item.usageMinimum; u <= item.usageMaximum && out.length < 512; u++) out.push(u);
  }
  return out;
}

/** Which selector an array item is (by the page-0x0F child usages it lists), with its list reduced to those usages */
function detectSelector(usages: readonly number[]): { key: number; usages: number[] } | null {
  for (const s of SELECTORS) {
    const mine = usages.filter((u) => u >>> 16 === PAGE_PID && (u & 0xffff) >= s.lo && (u & 0xffff) <= s.hi);
    if (mine.length > 0) return { key: s.key, usages: mine };
  }
  return null;
}

function parseReport(reportId: number, items: readonly HidReportItemLike[]): PidReportLayout {
  const fields: Record<number, PidFieldLayout> = {};
  const fieldList: PidFieldEntry[] = [];
  let offset = 0;
  const add = (key: number, f: PidFieldLayout, isArray = false) => {
    if (!(key in fields)) fields[key] = f;
    fieldList.push({ ...f, usage: key, isArray });
  };
  for (const item of items) {
    const size = Math.max(0, Math.floor(item.reportSize ?? 0));
    const count = Math.max(0, Math.floor(item.reportCount ?? 0));
    if (!item.isConstant && size > 0 && count > 0) {
      const usages = expandUsages(item);
      const range = normaliseRange(item.logicalMinimum, item.logicalMaximum, size);
      const signed = range.min < 0;
      if (item.isArray) {
        const sel = detectSelector(usages);
        if (sel) add(sel.key, { bitOffset: offset, bitSize: size, ...range, signed, usages: sel.usages }, true);
        else if (usages.length > 0) add(usages[0] as number, { bitOffset: offset, bitSize: size, ...range, signed, usages }, true);
      } else if (usages.length > 0) {
        // fewer usages than count: the last usage applies to the remaining fields (HID rule)
        for (let k = 0; k < count; k++) {
          const u = usages[Math.min(k, usages.length - 1)] as number;
          add(u, { bitOffset: offset + k * size, bitSize: size, ...range, signed }, false);
        }
      }
    }
    offset += size * count;
  }
  return { reportId, bitLength: offset, fields, fieldList };
}

/**
 * Reports of one kind per report id. A report may be listed on its collection and again on parent collections; the
 * most complete listing (most bits) wins, so a split report is never half-parsed when one node has it all.
 */
function gatherReports(
  collections: readonly HidCollectionLike[],
  kind: "inputReports" | "outputReports" | "featureReports",
  out = new Map<number, { items: readonly HidReportItemLike[]; bits: number }>()
) {
  for (const c of collections) {
    for (const r of c[kind] ?? []) {
      const items = r.items ?? [];
      const bits = items.reduce((s, i) => s + Math.max(0, i.reportSize ?? 0) * Math.max(0, i.reportCount ?? 0), 0);
      const id = r.reportId ?? 0;
      const prev = out.get(id);
      if (!prev || bits > prev.bits) out.set(id, { items, bits });
    }
    gatherReports(c.children ?? [], kind, out);
  }
  return out;
}

/**
 * Finds the PID reports in a device's parsed report descriptor and computes every field's bit position.
 *
 * Reports are recognised by their contents (the descriptor does not carry the usage of the logical collection that
 * names them): Set Constant Force = block index + Magnitude without the periodic/condition fields; Effect Operation
 * = the Op Effect Start/Solo/Stop selector; Device Control = the DC_* selector; Set Effect = output report with the
 * Effect Type selector and Duration/Gain; Set Condition = output report with CP Offset and Positive Coefficient;
 * Create New Effect = the Effect Type selector in a feature report; Block Load = the Block Load Status selector
 * (feature or input). Bit offsets are summed over the items in order (size x count, constant items are padding),
 * report ids are never hard-coded. Returns null without a usable Set Constant Force + Effect Operation.
 */
export function parsePidLayout(collections: readonly HidCollectionLike[]): PidLayout | null {
  let constantForce: PidReportLayout | null = null;
  let effectOperation: PidReportLayout | null = null;
  let setEffect: PidReportLayout | null = null;
  let setCondition: PidReportLayout | null = null;
  let deviceControl: PidReportLayout | null = null;
  let deviceGain: PidReportLayout | null = null;
  let blockFree: PidReportLayout | null = null;
  let createNewEffect: PidReportLayout | null = null;
  let blockLoad: PidReportLayout | null = null;

  for (const [id, raw] of gatherReports(collections, "outputReports")) {
    const l = parseReport(id, raw.items);
    const keys = Object.keys(l.fields).length;
    if (hasField(l, PID.EFFECT_TYPE) && (hasField(l, PID.DURATION) || hasField(l, PID.GAIN))) {
      if (!setEffect) setEffect = l;
    } else if (hasField(l, PID.CP_OFFSET) && hasField(l, PID.POSITIVE_COEFFICIENT)) {
      if (!setCondition) setCondition = l;
    } else if (hasField(l, PID.EFFECT_OPERATION)) {
      const f = getField(l, PID.EFFECT_OPERATION);
      if (!effectOperation && f?.usages?.includes(PID.OP_EFFECT_START) && hasField(l, PID.EFFECT_BLOCK_INDEX)) effectOperation = l;
    } else if (hasField(l, PID.DEVICE_CONTROL)) {
      if (!deviceControl) deviceControl = l;
    } else if (hasField(l, PID.DEVICE_GAIN)) {
      if (!deviceGain) deviceGain = l;
    } else if (hasField(l, PID.MAGNITUDE) && hasField(l, PID.EFFECT_BLOCK_INDEX)) {
      // Set Periodic (offset 0x6F / phase 0x71 / period 0x72) also carries a Magnitude; Constant Force has none of those
      const periodicLike = hasField(l, pidUsage(0x72)) || hasField(l, pidUsage(0x6f)) || hasField(l, pidUsage(0x71));
      if (!periodicLike && (!constantForce || keys < Object.keys(constantForce.fields).length)) constantForce = l;
    } else if (keys === 1 && hasField(l, PID.EFFECT_BLOCK_INDEX)) {
      if (!blockFree) blockFree = l;
    }
  }
  for (const [id, raw] of gatherReports(collections, "featureReports")) {
    const l = parseReport(id, raw.items);
    if (hasField(l, PID.EFFECT_TYPE)) {
      if (!createNewEffect) createNewEffect = l;
    } else if (hasField(l, PID.BLOCK_LOAD_STATUS)) {
      if (!blockLoad) blockLoad = l;
    }
  }
  if (!blockLoad) {
    for (const [id, raw] of gatherReports(collections, "inputReports")) {
      const l = parseReport(id, raw.items);
      if (hasField(l, PID.BLOCK_LOAD_STATUS)) {
        blockLoad = l;
        break;
      }
    }
  }

  if (!constantForce || !effectOperation) return null;
  const effectTypes = setEffect ? (getField(setEffect, PID.EFFECT_TYPE)?.usages ?? []) : [];
  const hasSpring = setCondition !== null && effectTypes.includes(PID.ET_SPRING);
  const hasDamper = setCondition !== null && effectTypes.includes(PID.ET_DAMPER);
  return {
    constantForce,
    effectOperation,
    setEffect,
    setCondition,
    deviceControl,
    deviceGain,
    blockFree,
    createNewEffect,
    blockLoad,
    hasSpring,
    hasDamper,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Bit packing                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

function writeBits(data: Uint8Array, bitOffset: number, bitSize: number, value: number) {
  const u = value < 0 ? value + 2 ** bitSize : value;
  for (let i = 0; i < bitSize; i++) {
    const pos = bitOffset + i;
    const byte = pos >> 3;
    if (byte >= data.length) break;
    const mask = 1 << (pos & 7);
    if (Math.floor(u / 2 ** i) % 2 === 1) data[byte] = (data[byte] as number) | mask;
    else data[byte] = (data[byte] as number) & ~mask;
  }
}

function readBits(data: Uint8Array, bitOffset: number, bitSize: number, signed: boolean): number {
  let u = 0;
  for (let i = 0; i < bitSize; i++) {
    const pos = bitOffset + i;
    const byte = data[pos >> 3];
    if (byte !== undefined && (byte >> (pos & 7)) & 1) u += 2 ** i;
  }
  return signed && bitSize > 0 && u >= 2 ** (bitSize - 1) ? u - 2 ** bitSize : u;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Builds a report's data bytes (without the report id) from `values` keyed by full usage. Each value is rounded and
 * clamped to its field's logical range; fields not named stay zero; unknown keys are ignored.
 */
export function buildReport(layout: PidReportLayout, values: Record<number, number>): { reportId: number; data: Uint8Array } {
  const data = new Uint8Array(Math.ceil(layout.bitLength / 8));
  for (const [key, value] of Object.entries(values)) {
    const usage = Number(key);
    const f = getField(layout, usage);
    if (!f || !Number.isFinite(value)) continue;
    // PID Trigger Button (0 = no trigger button in USB HID PID, even when LogicalMin = 1) and Duration (all-1s =
    // infinite duration, e.g. 0xFFFF on 16-bit even when LogicalMax = 32767) use out-of-range sentinels.
    const rounded = Math.round(value);
    const allOnes = f.bitSize >= 32 ? 0xffffffff : (1 << f.bitSize) - 1;
    const raw =
      (usage === PID.TRIGGER_BUTTON && (rounded === 0 || (rounded === 255 && f.bitSize >= 8))) ||
      (usage === PID.DURATION && rounded === allOnes)
        ? rounded
        : clamp(rounded, f.min, f.max);
    writeBits(data, f.bitOffset, f.bitSize, raw);
  }
  return { reportId: layout.reportId, data };
}

/** Reads every field of a report back (used for the PID Block Load feature report); selectors give their raw value */
export function unpackReport(layout: PidReportLayout, bytes: Uint8Array): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [key, f] of Object.entries(layout.fields)) out[Number(key)] = readBits(bytes, f.bitOffset, f.bitSize, f.signed);
  return out;
}

/** Raw value that selects `usage` in an array field (`min + index`), or null when the field cannot select it */
export function selectorValue(field: PidFieldLayout, usage: number): number | null {
  const i = field.usages?.indexOf(usage) ?? -1;
  return i < 0 ? null : field.min + i;
}

/** The usage a raw selector value stands for, or null */
export function selectedUsage(field: PidFieldLayout, raw: number): number | null {
  return field.usages?.[raw - field.min] ?? null;
}

/**
 * Force −1..1 (+ = right) → raw magnitude. A signed range (−10000..10000, −32768..32767) maps 0 to 0 exactly and each
 * side to its own end. An unsigned range (0..255) has no zero, so the midpoint stands for it: −1 → min, +1 → max,
 * 0 → the (rounded) middle, 128 for 0..255. Most 8-bit PID firmwares read the field that way.
 */
export function forceToRaw(field: PidFieldLayout, force: number): number {
  const f = Number.isFinite(force) ? clamp(force, -1, 1) : 0;
  if (field.min < 0 && field.max > 0) return (f >= 0 ? Math.round(f * field.max) : Math.round(f * -field.min)) + 0;
  const mid = (field.min + field.max) / 2;
  return Math.round(mid + (f * (field.max - field.min)) / 2) + 0;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Rate-limited writer                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** Clock and timers, injectable so the rate limiting can be tested without waiting */
export interface FfbDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  sleep: (ms: number) => Promise<void>;
}

export const defaultFfbDeps: FfbDeps = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Streams force values to the wheel: at most one sendReport in flight, at least 2 ms between writes, only the latest
 * value is ever kept (intermediate ones are dropped) and changes below 1/1000 of the field's range are skipped, unless
 * {@link FORCE_KEEPALIVE_MS} has passed since the last write: then the value goes out again even if unchanged.
 */
export class ForceWriter {
  private lastRaw: number | null = null;
  private pending: number | null = null;
  private urgent = false;
  private current: Promise<void> | null = null;
  private lastSendMs = -Infinity;
  private timer: unknown = null;
  private failures = 0;
  private dead = false;
  private readonly zeroRaw: number;
  private readonly threshold: number;

  constructor(
    private readonly field: PidFieldLayout,
    private readonly send: (raw: number) => Promise<void>,
    private readonly deps: FfbDeps,
    private readonly onFail?: (message: string, fatal: boolean) => void
  ) {
    this.zeroRaw = forceToRaw(field, 0);
    this.threshold = (field.max - field.min) / 1000;
  }

  /** `urgent` skips the 2 ms spacing (used to zero the wheel at once) */
  setForce(force: number, urgent = false): void {
    if (this.dead) return;
    const raw = forceToRaw(this.field, force);
    // Nothing (or nothing new) written for a while: the value goes out again, whatever the dead band says
    const stale = this.deps.now() - this.lastSendMs >= FORCE_KEEPALIVE_MS;
    if (!stale && this.lastRaw !== null && raw !== this.zeroRaw && Math.abs(raw - this.lastRaw) < this.threshold) {
      this.pending = null; // the wheel already holds (nearly) this value; drop any older queued one
      return;
    }
    if (!stale && raw === this.lastRaw) {
      this.pending = null;
      return;
    }
    this.pending = raw;
    if (urgent) {
      this.urgent = true;
      if (this.timer !== null) {
        this.deps.clearTimer(this.timer);
        this.timer = null;
      }
    }
    this.pump();
  }

  /** Stops writing and waits for the write in flight; nothing is sent afterwards */
  async close(): Promise<void> {
    this.dead = true;
    this.pending = null;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    await this.current;
  }

  /** Stops writing without waiting (device vanished) */
  kill(): void {
    this.dead = true;
    this.pending = null;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private pump(): void {
    if (this.dead || this.current !== null || this.pending === null) return;
    const wait = this.urgent ? 0 : this.lastSendMs + MIN_WRITE_INTERVAL_MS - this.deps.now();
    if (wait > 0) {
      if (this.timer === null) {
        this.timer = this.deps.setTimer(() => {
          this.timer = null;
          this.pump();
        }, wait);
      }
      return;
    }
    const raw = this.pending;
    this.pending = null;
    this.urgent = false;
    this.lastRaw = raw;
    this.lastSendMs = this.deps.now();
    this.current = this.send(raw)
      .then(
        () => {
          this.failures = 0;
        },
        (e: unknown) => {
          this.failures++;
          this.lastRaw = null; // resend the next value whatever it is
          const fatal = this.failures >= MAX_WRITE_FAILURES;
          if (fatal) this.dead = true;
          this.onFail?.(errorMessage(e), fatal);
        }
      )
      .then(() => {
        this.current = null;
        this.lastSendMs = this.deps.now();
        this.pump();
      });
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Device setup                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface PidSession {
  device: HidDeviceLike;
  driver?: "pid" | "logitech";
  layout: PidLayout;
  /** Effect block holding the Constant Force effect */
  blockIndex: number;
  /** Effect block holding the hardware Damper condition effect, when supported */
  damperBlockIndex?: number | null;
  /** Whether the wheel is running a hardware PID Damper effect */
  hasHardwareDamper: boolean;
  writer: ForceWriter;
  /** Updates the hardware PID Damper coefficient (0..1) when it changes by >= 0.025 */
  setDamper: (coeff: number) => void;
}

export type PidSetupResult =
  | { ok: true; session: PidSession }
  | { ok: false; /** the device has no usable HID PID force feedback (as opposed to a transient failure) */ unsupported: boolean; message: string };

export interface PidSetupOptions {
  deps?: FfbDeps;
  onFail?: (message: string, fatal: boolean) => void;
}

function sendOutput(device: HidDeviceLike, layout: PidReportLayout, values: Record<number, number>): Promise<void> {
  const r = buildReport(layout, values);
  return device.sendReport(r.reportId, r.data);
}

/** Device Control command (reset, enable, …); false when the device has no such command */
async function deviceControl(device: HidDeviceLike, layout: PidLayout, usage: number): Promise<boolean> {
  const rep = layout.deviceControl;
  const f = rep ? getField(rep, PID.DEVICE_CONTROL) : undefined;
  const v = f ? selectorValue(f, usage) : null;
  if (!rep || v === null) return false;
  await sendOutput(device, rep, { [PID.DEVICE_CONTROL]: v });
  return true;
}

/** Create New Effect (feature) then read PID Block Load back for the block index; fallbackBlock when the device has neither */
async function allocateEffect(
  device: HidDeviceLike,
  layout: PidLayout,
  deps: FfbDeps,
  effectTypeUsage: number = PID.ET_CONSTANT_FORCE,
  fallbackBlock = 1
): Promise<number> {
  const create = layout.createNewEffect;
  const load = layout.blockLoad;
  if (!create || !load) return fallbackBlock;
  const type = getField(create, PID.EFFECT_TYPE);
  const typeValue = type ? selectorValue(type, effectTypeUsage) : null;
  if (typeValue === null) return fallbackBlock;
  const c = buildReport(create, {
    [PID.EFFECT_TYPE]: typeValue,
    [PID.BYTE_COUNT]: 0,
    [PID.POOL_BYTE_COUNT]: 0,
    [DESKTOP_BYTE_COUNT]: 0,
  });
  await device.sendFeatureReport(c.reportId, c.data);
  await deps.sleep(20);

  for (let attempt = 0; attempt < 3; attempt++) {
    const view = await device.receiveFeatureReport(load.reportId);
    let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    // Chrome hands a numbered feature report back with its id in byte 0, in a buffer sized to the interface's largest
    // feature report (so often longer than this one); a stack that leaves the id out returns just the report's bytes.
    // Read by bit offset, the padding after the report does not matter
    if (load.reportId !== 0 && bytes.length > Math.ceil(load.bitLength / 8) && bytes[0] === load.reportId) bytes = bytes.subarray(1);
    const got = unpackReport(load, bytes);
    const statusField = getField(load, PID.BLOCK_LOAD_STATUS);
    const status = statusField ? selectedUsage(statusField, got[PID.BLOCK_LOAD_STATUS] ?? 0) : PID.BLOCK_LOAD_SUCCESS;
    if (status === PID.BLOCK_LOAD_FULL) throw new Error("The wheel has no free effect memory");
    if (status === PID.BLOCK_LOAD_ERROR) throw new Error("The wheel refused to create a constant force effect");
    if (status === PID.BLOCK_LOAD_SUCCESS || status === null) {
      const idx = got[PID.EFFECT_BLOCK_INDEX];
      return idx !== undefined && idx > 0 ? idx : fallbackBlock;
    }
    await deps.sleep(20);
  }
  throw new Error("The wheel did not confirm the effect it was asked to create");
}

/** Set Condition report values for a symmetric spring/damper condition (coeff in -1..1, saturation in 0..1) */
export function conditionReportValues(
  cond: PidReportLayout,
  blockIndex: number,
  coeff: number,
  saturation = 1
): Record<number, number> {
  const v: Record<number, number> = { [PID.EFFECT_BLOCK_INDEX]: blockIndex };
  const pbo = getField(cond, PID.PARAMETER_BLOCK_OFFSET);
  if (pbo) v[PID.PARAMETER_BLOCK_OFFSET] = pbo.min;
  const cp = getField(cond, PID.CP_OFFSET);
  if (cp) v[PID.CP_OFFSET] = forceToRaw(cp, 0);
  const c = clamp(Number.isFinite(coeff) ? coeff : 0, -1, 1);
  // A signed coefficient keeps 0 at 0; an unsigned one (0..10000) has no negative side, so 0 is its minimum, not the
  // midpoint forceToRaw would give it (a damper that starts at half strength)
  const coeffRaw = (f: PidFieldLayout) => (f.min < 0 ? forceToRaw(f, c) : Math.round(f.min + (f.max - f.min) * Math.abs(c)));
  const posCoeff = getField(cond, PID.POSITIVE_COEFFICIENT);
  if (posCoeff) v[PID.POSITIVE_COEFFICIENT] = coeffRaw(posCoeff);
  const negCoeff = getField(cond, PID.NEGATIVE_COEFFICIENT);
  if (negCoeff) v[PID.NEGATIVE_COEFFICIENT] = coeffRaw(negCoeff);
  const sat = clamp(Number.isFinite(saturation) ? saturation : 1, 0, 1);
  const posSat = getField(cond, PID.POSITIVE_SATURATION);
  if (posSat) v[PID.POSITIVE_SATURATION] = Math.round(posSat.min + (posSat.max - posSat.min) * sat);
  const negSat = getField(cond, PID.NEGATIVE_SATURATION);
  if (negSat) v[PID.NEGATIVE_SATURATION] = Math.round(negSat.min + (negSat.max - negSat.min) * sat);
  const deadBand = getField(cond, PID.DEAD_BAND);
  if (deadBand) v[PID.DEAD_BAND] = deadBand.min;
  return v;
}

/**
 * Builds the `Set Effect` output report for an infinite, full-gain effect along +X (90 degrees).
 * Iterates over `set.fieldList` so descriptors that reuse `Generic Desktop X` (once as 1-bit in Axes Enable and again
 * as multi-bit in Direction) or repeat `PID.DIRECTION` for X and Y pack every field without usage collisions.
 */
export function buildSetEffectReport(
  set: PidReportLayout,
  blockIndex: number,
  effectTypeUsage: number = PID.ET_CONSTANT_FORCE
): { reportId: number; data: Uint8Array } {
  const r = buildReport(set, setEffectValues(set, blockIndex, effectTypeUsage));
  if (set.fieldList && set.fieldList.length > 0) {
    let axes = 0;
    let dirs = 0;
    for (const f of set.fieldList) {
      if (f.isArray) continue;
      const page = f.usage >>> 16;
      const id = f.usage & 0xffff;
      if (page === PAGE_DESKTOP && f.bitSize === 1) {
        writeBits(r.data, f.bitOffset, 1, axes === 0 ? 1 : 0);
        axes++;
        continue;
      }
      const isDirection =
        page === PAGE_ORDINAL ||
        (page === PAGE_PID && (id === 0x01 || id === 0x02 || id === 0x57)) ||
        (page === PAGE_DESKTOP && f.bitSize > 1);
      if (isDirection) {
        const val = dirs === 0 ? Math.round(f.min + (f.max - f.min) * DIRECTION_X_FRACTION) : f.min;
        writeBits(r.data, f.bitOffset, f.bitSize, clamp(val, f.min, f.max));
        dirs++;
        continue;
      }
      if (f.usage === PID.DIRECTION_ENABLE) {
        writeBits(r.data, f.bitOffset, f.bitSize, 1);
      }
    }
  }
  return r;
}

/**
 * The connect-time setup for an already granted device (factored out of {@link WebHidFfb.connect} so it can be tested
 * without navigator.hid): open, parse the PID layout, reset + stop all + enable actuators, device gain 100 %, create
 * Constant Force effect (and optional hardware Damper condition effect), configure and start them.
 */
export async function setupPidDevice(device: HidDeviceLike, options: PidSetupOptions = {}): Promise<PidSetupResult> {
  const deps = options.deps ?? defaultFfbDeps;
  const layout = parsePidLayout(device.collections);
  if (!layout) {
    return {
      ok: false,
      unsupported: true,
      message: "This device does not expose HID PID force feedback (no Set Constant Force / Effect Operation report)",
    };
  }
  const forceField = getField(layout.constantForce, PID.MAGNITUDE);
  const startValue = getField(layout.effectOperation, PID.EFFECT_OPERATION);
  const start = startValue ? selectorValue(startValue, PID.OP_EFFECT_START) : null;
  if (!forceField || start === null) {
    return { ok: false, unsupported: true, message: "The wheel's force-feedback reports are not usable (no magnitude or start command)" };
  }

  // What a failure part-way through has to undo
  let actuatorsOn = false;
  let allocated: number | null = null;
  let damperBlockIndex: number | null = null;
  try {
    if (!device.opened) await device.open();
    if (await deviceControl(device, layout, PID.DC_DEVICE_RESET)) await deps.sleep(30);
    await deviceControl(device, layout, PID.DC_STOP_ALL_EFFECTS);
    actuatorsOn = true;
    await deviceControl(device, layout, PID.DC_ENABLE_ACTUATORS);

    if (layout.deviceGain) {
      const g = getField(layout.deviceGain, PID.DEVICE_GAIN);
      if (g) await sendOutput(device, layout.deviceGain, { [PID.DEVICE_GAIN]: g.max });
    }

    const blockIndex = await allocateEffect(device, layout, deps, PID.ET_CONSTANT_FORCE, 1);
    allocated = blockIndex;

    const set = layout.setEffect;
    if (set) {
      const setRep = buildSetEffectReport(set, blockIndex, PID.ET_CONSTANT_FORCE);
      await device.sendReport(setRep.reportId, setRep.data);
    }

    await sendOutput(device, layout.constantForce, {
      [PID.EFFECT_BLOCK_INDEX]: blockIndex,
      [PID.MAGNITUDE]: forceToRaw(forceField, 0),
    });
    const loops = getField(layout.effectOperation, PID.LOOP_COUNT);
    const loopCount = loops ? clamp(1, loops.min, Math.max(1, loops.max)) : 1;
    await sendOutput(device, layout.effectOperation, {
      [PID.EFFECT_BLOCK_INDEX]: blockIndex,
      [PID.EFFECT_OPERATION]: start,
      [PID.LOOP_COUNT]: loopCount,
    });

    if (layout.hasDamper && layout.setCondition) {
      try {
        const dBlock = await allocateEffect(device, layout, deps, PID.ET_DAMPER, blockIndex + 1);
        if (set) {
          const setDamperRep = buildSetEffectReport(set, dBlock, PID.ET_DAMPER);
          await device.sendReport(setDamperRep.reportId, setDamperRep.data);
        }
        await sendOutput(device, layout.setCondition, conditionReportValues(layout.setCondition, dBlock, 0, 1));
        await sendOutput(device, layout.effectOperation, {
          [PID.EFFECT_BLOCK_INDEX]: dBlock,
          [PID.EFFECT_OPERATION]: start,
          [PID.LOOP_COUNT]: loopCount,
        });
        damperBlockIndex = dBlock;
      } catch {
        // Hardware damper is optional; continue with Constant Force if effect memory is full or damper creation fails
        damperBlockIndex = null;
      }
    }

    const writer = new ForceWriter(
      forceField,
      (raw) => sendOutput(device, layout.constantForce, { [PID.EFFECT_BLOCK_INDEX]: blockIndex, [PID.MAGNITUDE]: raw }),
      deps,
      options.onFail
    );
    const hasHardwareDamper = damperBlockIndex !== null && Boolean(layout.setCondition);
    let lastDamper = 0;
    const setDamper = (coeff: number) => {
      if (!hasHardwareDamper || damperBlockIndex === null || !layout.setCondition) return;
      const c = clamp(Number.isFinite(coeff) ? coeff : 0, 0, 1);
      if (c === lastDamper || (c !== 0 && Math.abs(c - lastDamper) < 0.025)) return;
      lastDamper = c;
      void sendOutput(device, layout.setCondition, conditionReportValues(layout.setCondition, damperBlockIndex, c, 1)).catch(() => {});
    };
    return {
      ok: true,
      session: {
        device,
        driver: "pid",
        layout,
        blockIndex,
        damperBlockIndex,
        hasHardwareDamper,
        writer,
        setDamper,
      },
    };
  } catch (e) {
    // Best effort, as in teardownPidSession: never leave the motor armed or an effect block held after a failed setup
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        // device may already be gone
      }
    };
    if (allocated !== null && layout.blockFree) {
      const block = allocated;
      await attempt(() => sendOutput(device, layout.blockFree as PidReportLayout, { [PID.EFFECT_BLOCK_INDEX]: block }));
    }
    if (actuatorsOn) {
      await attempt(() => deviceControl(device, layout, PID.DC_STOP_ALL_EFFECTS));
      await attempt(() => deviceControl(device, layout, PID.DC_DISABLE_ACTUATORS));
    }
    return { ok: false, unsupported: false, message: errorMessage(e) };
  }
}

/** Set Effect values for an infinite, full-gain effect along +X */
function setEffectValues(
  set: PidReportLayout,
  blockIndex: number,
  effectTypeUsage: number = PID.ET_CONSTANT_FORCE
): Record<number, number> {
  const v: Record<number, number> = { [PID.EFFECT_BLOCK_INDEX]: blockIndex };
  const type = getField(set, PID.EFFECT_TYPE);
  v[PID.EFFECT_TYPE] = (type ? selectorValue(type, effectTypeUsage) : null) ?? 1;
  const duration = getField(set, PID.DURATION);
  // infinite: all-1s (0xFFFF on 16-bit fields, even where LogicalMax stops at 32767)
  if (duration) v[PID.DURATION] = duration.bitSize >= 32 ? 0xffffffff : (1 << duration.bitSize) - 1;
  if (hasField(set, PID.TRIGGER_REPEAT_INTERVAL)) v[PID.TRIGGER_REPEAT_INTERVAL] = 0;
  if (hasField(set, PID.SAMPLE_PERIOD)) v[PID.SAMPLE_PERIOD] = 0;
  const gain = getField(set, PID.GAIN);
  if (gain) v[PID.GAIN] = gain.max;
  // In USB HID PID, buttons are 1..N and 0 means "no trigger button"
  if (hasField(set, PID.TRIGGER_BUTTON)) v[PID.TRIGGER_BUTTON] = 0;
  if (hasField(set, PID.START_DELAY)) v[PID.START_DELAY] = 0;
  // Direction along +X (90 degrees: east)
  const dir = getField(set, ordinalUsage(1));
  if (dir) v[ordinalUsage(1)] = dir.min + (dir.max - dir.min) * DIRECTION_X_FRACTION;
  const dir2 = getField(set, ordinalUsage(2));
  if (dir2) v[ordinalUsage(2)] = dir2.min;
  const dirGeneric = getField(set, PID.DIRECTION);
  if (dirGeneric) v[PID.DIRECTION] = dirGeneric.min + (dirGeneric.max - dirGeneric.min) * DIRECTION_X_FRACTION;
  // Enable X in the axes mask AND always set Direction Enable to 1 (required by PXN V99 and other PID firmwares)
  if (hasField(set, AXIS_X)) {
    const fX = getField(set, AXIS_X);
    if (fX && fX.bitSize === 1) {
      v[AXIS_X] = 1;
      if (hasField(set, AXIS_Y)) v[AXIS_Y] = 0;
      if (hasField(set, AXIS_Z)) v[AXIS_Z] = 0;
    }
  }
  if (hasField(set, PID.AXES_ENABLE)) v[PID.AXES_ENABLE] = 1;
  if (hasField(set, PID.DIRECTION_ENABLE)) v[PID.DIRECTION_ENABLE] = 1;
  return v;
}

const LOGITECH_FORCE_FIELD: PidFieldLayout = { bitOffset: 16, bitSize: 8, min: 0, max: 255, signed: false };
const LOGITECH_REPORT_LAYOUT: PidReportLayout = {
  reportId: 0,
  bitLength: 56,
  fields: { [PID.MAGNITUDE]: LOGITECH_FORCE_FIELD },
  fieldList: [{ ...LOGITECH_FORCE_FIELD, usage: PID.MAGNITUDE, isArray: false }],
};

function sendLogitechReport(device: HidDeviceLike, bytes: readonly number[]): Promise<void> {
  const data = new Uint8Array(7);
  for (let i = 0; i < bytes.length && i < 7; i++) data[i] = bytes[i] & 0xff;
  return device.sendReport(0, data);
}

/**
 * Classic Logitech 7-byte WebHID session (G25, G27, G29, Driving Force GT/Pro):
 * disables the autocenter spring, switches to native 900° mode, and streams slot-1 constant force on reportId 0.
 */
export async function setupLogitechDevice(device: HidDeviceLike, options: PidSetupOptions = {}): Promise<PidSetupResult> {
  const deps = options.deps ?? defaultFfbDeps;
  try {
    if (!device.opened) await device.open();
    await sendLogitechReport(device, [0xf5, 0, 0, 0, 0, 0, 0]);
    await sendLogitechReport(device, [0xf8, 0x81, 900 & 0xff, (900 >> 8) & 0xff, 0, 0, 0]);
    await sendLogitechReport(device, [0x11, 0x00, 0x80, 0, 0, 0, 0]);
    const writer = new ForceWriter(
      LOGITECH_FORCE_FIELD,
      (raw) => sendLogitechReport(device, [0x11, 0x00, raw & 0xff, 0, 0, 0, 0]),
      deps,
      options.onFail
    );
    const layout: PidLayout = {
      constantForce: LOGITECH_REPORT_LAYOUT,
      effectOperation: LOGITECH_REPORT_LAYOUT,
      setEffect: null,
      setCondition: null,
      deviceControl: null,
      deviceGain: null,
      blockFree: null,
      createNewEffect: null,
      blockLoad: null,
      hasSpring: false,
      hasDamper: false,
    };
    return {
      ok: true,
      session: {
        device,
        driver: "logitech",
        layout,
        blockIndex: 1,
        damperBlockIndex: null,
        hasHardwareDamper: false,
        writer,
        setDamper: () => {},
      },
    };
  } catch (e) {
    return { ok: false, unsupported: false, message: errorMessage(e) };
  }
}

/** Best-effort shutdown: zero force, stop the effect, free it, stop all, disable actuators. Never throws. */
export async function teardownPidSession(session: PidSession): Promise<void> {
  await session.writer.close();
  const { device, layout, blockIndex, damperBlockIndex } = session;
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // device may already be gone
    }
  };
  if (session.driver === "logitech") {
    await attempt(() => sendLogitechReport(device, [0xf3, 0, 0, 0, 0, 0, 0]));
    await attempt(() => sendLogitechReport(device, [0xf5, 0, 0, 0, 0, 0, 0]));
    return;
  }
  const mag = getField(layout.constantForce, PID.MAGNITUDE);
  if (mag) {
    await attempt(() =>
      sendOutput(device, layout.constantForce, { [PID.EFFECT_BLOCK_INDEX]: blockIndex, [PID.MAGNITUDE]: forceToRaw(mag, 0) })
    );
  }
  const op = getField(layout.effectOperation, PID.EFFECT_OPERATION);
  const stop = op ? selectorValue(op, PID.OP_EFFECT_STOP) : null;
  if (stop !== null) {
    await attempt(() => sendOutput(device, layout.effectOperation, { [PID.EFFECT_BLOCK_INDEX]: blockIndex, [PID.EFFECT_OPERATION]: stop }));
    if (damperBlockIndex) {
      await attempt(() =>
        sendOutput(device, layout.effectOperation, { [PID.EFFECT_BLOCK_INDEX]: damperBlockIndex, [PID.EFFECT_OPERATION]: stop })
      );
    }
  }
  if (layout.blockFree) {
    await attempt(() => sendOutput(device, layout.blockFree as PidReportLayout, { [PID.EFFECT_BLOCK_INDEX]: blockIndex }));
    if (damperBlockIndex) {
      await attempt(() => sendOutput(device, layout.blockFree as PidReportLayout, { [PID.EFFECT_BLOCK_INDEX]: damperBlockIndex }));
    }
  }
  await attempt(() => deviceControl(device, layout, PID.DC_STOP_ALL_EFFECTS));
  await attempt(() => deviceControl(device, layout, PID.DC_DISABLE_ACTUATORS));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Public driver                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

export type WebHidFfbState = "unsupported" | "idle" | "connecting" | "ready" | "error";
export interface WebHidFfbStatus {
  state: WebHidFfbState;
  device: string | null;
  message: string | null;
}

/** A failure the driver will not recover from by itself: the force goes back to the bridge until the user reconnects */
export function isFatalHidStatus(s: WebHidFfbStatus): boolean {
  return s.state === "error" || s.state === "unsupported";
}

const REQUEST_FILTERS = [
  { usagePage: 0x01, usage: 0x04 },
  { usagePage: 0x01, usage: 0x05 },
  { usagePage: 0x01, usage: 0x08 },
  { usagePage: 0x0f },
];
const UNSUPPORTED_BROWSER = "WebHID needs Chrome or Edge on https or localhost";
/** Status message when the page loads with WebHID on but no wheel was granted to it yet (pairing needs a click) */
export const PAIR_MESSAGE = "Click Connect to pair your wheel";
/** Wait after a granted wheel's connect event before re-opening it (ms): a multi-interface base arrives one at a time */
export const HOTPLUG_DELAY_MS = 1500;
/** Setup attempts when a granted wheel is re-opened (page load, power-cycle): one just switched on may refuse at first */
export const SETUP_ATTEMPTS = 5;
/** Wait between those attempts (ms) */
export const SETUP_RETRY_MS = 2000;

function hasOutputReports(collections: readonly HidCollectionLike[]): boolean {
  for (const c of collections) {
    if ((c.outputReports && c.outputReports.length > 0) || hasOutputReports(c.children ?? [])) return true;
  }
  return false;
}

/**
 * Multi-interface wheels (e.g. PXN V99) return an input/button HIDDevice alongside a separate FFB output HIDDevice.
 * Pick: 1) first interface with a valid PID layout, 2) first interface with outputReports (or Logitech vendorId),
 * 3) `devices[0]` when `allowFallback` is true (so connect() reports unsupported on a non-FFB pick).
 */
function pickFfbDevice(devices: readonly HidDeviceLike[], allowFallback: boolean): HidDeviceLike | undefined {
  return (
    devices.find((d) => parsePidLayout(d.collections) !== null) ??
    devices.find((d) => hasOutputReports(d.collections)) ??
    devices.find((d) => d.vendorId === VENDOR_LOGITECH) ??
    (allowFallback ? devices[0] : undefined)
  );
}

function deviceName(d: HidDeviceLike): string {
  return d.productName?.trim() || `HID device ${d.vendorId.toString(16).padStart(4, "0")}:${d.productId.toString(16).padStart(4, "0")}`;
}

function nativeHid(): HidApiLike | null {
  if (typeof navigator === "undefined" || !("hid" in navigator)) return null;
  if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) return null;
  return (navigator as unknown as { hid: HidApiLike }).hid;
}

export class WebHidFfb {
  /** WebHID exists and the page is a secure context */
  static isSupported(): boolean {
    return nativeHid() !== null;
  }

  status: WebHidFfbStatus;
  onStatus?: (s: WebHidFfbStatus) => void;

  private session: PidSession | null = null;
  private device: HidDeviceLike | null = null;
  private busy: Promise<string | null> | null = null;
  private busyClosing = false;
  private listening: HidApiLike | null = null;
  private listeners = new Set<() => void>();
  /** Between connect()/reconnect() and dispose(): a granted wheel that comes back is re-opened */
  private wanted = false;
  private hotplugApi: HidApiLike | null = null;
  private hotplugTimer: unknown = null;
  /** Ends the wait between setup attempts early (dispose) */
  private wakeRetry: (() => void) | null = null;

  /** `hid` and `deps` exist for tests; the app uses the defaults */
  constructor(
    private readonly hidOverride?: HidApiLike,
    private readonly deps: FfbDeps = defaultFfbDeps
  ) {
    this.status = this.hidApi()
      ? { state: "idle", device: null, message: null }
      : { state: "unsupported", device: null, message: UNSUPPORTED_BROWSER };
  }

  /**
   * Must be called straight from a user gesture (the click handler itself): requestDevice is called before anything
   * is awaited, since the prompt needs the click's user activation. Opens the picked wheel and sets the effect up.
   * Resolves to the device name, or null when nothing was picked or setup failed (see `status`). Cancelling the
   * picker keeps a wheel that is already running.
   */
  connect(): Promise<string | null> {
    const hid = this.hidApi();
    if (!hid) return Promise.resolve(this.fail("unsupported", null, UNSUPPORTED_BROWSER));
    this.want(hid);
    let picking: Promise<{ device: HidDeviceLike | undefined } | { error: string }>;
    try {
      picking = hid.requestDevice({ filters: REQUEST_FILTERS }).then(
        (d) => ({ device: pickFfbDevice(d, true) }),
        (e: unknown) => ({ error: errorMessage(e) })
      );
    } catch (e) {
      picking = Promise.resolve({ error: errorMessage(e) });
    }
    // Queued behind any reconnect in flight rather than swallowed by it: the picker is already open
    return this.guard(async () => {
      const picked = await picking;
      if ("error" in picked) {
        await this.release();
        return this.fail("error", null, picked.error);
      }
      if (!picked.device) {
        if (this.session && this.device) return deviceName(this.device);
        this.setStatus("idle", null, "No wheel was selected");
        return null;
      }
      await this.release();
      return this.attach(hid, picked.device);
    }, true);
  }

  /**
   * Re-opens a wheel the user granted earlier, without a prompt (page load, the wheel switched back on); null when
   * there is none, with the status asking for a Connect click ({@link PAIR_MESSAGE}). Never shows the picker. A running
   * wheel is kept. A setup that fails (not an unsupported wheel) is tried {@link SETUP_ATTEMPTS} times, staying
   * "connecting" in between, since a base that was just powered on may not take it yet.
   */
  reconnect(): Promise<string | null> {
    const api = this.hidApi();
    if (api) this.want(api);
    return this.guard(async () => {
      const hid = this.hidApi();
      if (!hid) return this.fail("unsupported", null, UNSUPPORTED_BROWSER);
      if (!this.wanted) return null;
      if (this.session && this.device) return deviceName(this.device);
      let devices: HidDeviceLike[];
      try {
        devices = await hid.getDevices();
      } catch (e) {
        return this.fail("error", null, errorMessage(e));
      }
      const found = pickFfbDevice(devices, false);
      if (!found) {
        this.setStatus("idle", null, PAIR_MESSAGE);
        return null;
      }
      await this.release();
      const name = deviceName(found);
      this.setStatus("connecting", name, null);
      for (let attempt = 1; ; attempt++) {
        const result = await this.setUp(hid, found);
        if (result.ok) return name;
        if (!this.wanted) {
          this.setStatus("idle", null, null);
          return null;
        }
        if (result.unsupported || attempt >= SETUP_ATTEMPTS) {
          return this.fail(result.unsupported ? "unsupported" : "error", name, result.message);
        }
        this.setStatus("connecting", name, `${result.message}; trying again (${attempt + 1}/${SETUP_ATTEMPTS})`);
        await this.waitForRetry(SETUP_RETRY_MS);
        if (!this.wanted) {
          this.setStatus("idle", null, null);
          return null;
        }
      }
    });
  }

  /**
   * PID magnitude −1..1 (+ pushes the rim left, − right; see the sign convention above). Cheap to call every frame:
   * writes are spaced by at least 2 ms, one in flight at a time, always carrying the latest value.
   */
  setForce(force: number): void {
    this.session?.writer.setForce(force);
  }

  /** Whether the connected wheel has an active hardware PID Damper condition effect */
  hasHardwareDamper(): boolean {
    return Boolean(this.session?.hasHardwareDamper);
  }

  /** Updates the wheel's hardware PID Damper coefficient (0..1) when supported */
  setDamper(coeff: number): void {
    this.session?.setDamper(coeff);
  }

  /** Zero force now (pause menu) */
  stop(): void {
    this.session?.writer.setForce(0, true);
  }

  /**
   * The page is going away (pagehide): zero the force and stop every effect at once, without waiting for anything,
   * since no later promise may get to run. The session is dropped (the device stays referenced, so the next release
   * closes it); {@link resume} sets the wheel up again if the page comes back from the back/forward cache.
   */
  emergencyStop(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.writer.kill();
    const { device, layout, blockIndex } = session;
    const fire = (send: () => Promise<void>) => {
      try {
        send().catch(() => {});
      } catch {
        // device already gone
      }
    };
    if (session.driver === "logitech") {
      fire(() => sendLogitechReport(device, [0x11, 0x00, 0x80, 0, 0, 0, 0]));
      fire(() => sendLogitechReport(device, [0xf3, 0, 0, 0, 0, 0, 0]));
    } else {
      const mag = getField(layout.constantForce, PID.MAGNITUDE);
      if (mag) {
        fire(() =>
          sendOutput(device, layout.constantForce, { [PID.EFFECT_BLOCK_INDEX]: blockIndex, [PID.MAGNITUDE]: forceToRaw(mag, 0) })
        );
      }
      const dc = layout.deviceControl;
      const dcField = dc ? getField(dc, PID.DEVICE_CONTROL) : undefined;
      const stopAll = dcField ? selectorValue(dcField, PID.DC_STOP_ALL_EFFECTS) : null;
      if (dc && stopAll !== null) fire(() => sendOutput(device, dc, { [PID.DEVICE_CONTROL]: stopAll }));
    }
    this.setStatus("idle", null, null);
  }

  /** The page came back from the back/forward cache: set the wheel up again if the driver is still wanted */
  resume(): Promise<string | null> {
    return this.wanted ? this.reconnect() : Promise.resolve(null);
  }

  /**
   * Stops all effects, disables actuators and closes the device (after any connect in flight). An error status is
   * kept, so the reason stays on screen once the driver is switched off because of it.
   */
  async dispose(): Promise<void> {
    this.unwant();
    await this.guard(async () => {
      await this.release();
      if (!isFatalHidStatus(this.status)) this.setStatus("idle", null, null);
      return null;
    }, true, true);
  }

  /** useSyncExternalStore pair (bound, so they can be passed as they are) */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getStatus = (): WebHidFfbStatus => this.status;

  private hidApi(): HidApiLike | null {
    return this.hidOverride ?? nativeHid();
  }

  /** One operation at a time; `queue` runs after the one in flight, otherwise the one in flight is the answer */
  private guard(fn: () => Promise<string | null>, queue = false, closing = false): Promise<string | null> {
    // A shutdown in flight never answers for a (re)connect: that queues behind it
    if (this.busy && !queue && !this.busyClosing) return this.busy;
    const prev = this.busy;
    const p = (prev ? prev.then(fn, fn) : fn()).finally(() => {
      if (this.busy === p) {
        this.busy = null;
        this.busyClosing = false;
      }
    });
    this.busy = p;
    this.busyClosing = closing;
    return p;
  }

  /** Sets the wheel up and makes it the force output; on failure the status is "error" / "unsupported" */
  private async attach(hid: HidApiLike, device: HidDeviceLike): Promise<string | null> {
    const r = await this.setUp(hid, device);
    return r.ok ? r.name : this.fail(r.unsupported ? "unsupported" : "error", r.name, r.message);
  }

  /** {@link attach} without reporting a failure (the reconnect retries decide when it is one) */
  private async setUp(
    hid: HidApiLike,
    device: HidDeviceLike
  ): Promise<{ ok: true; name: string } | { ok: false; name: string; unsupported: boolean; message: string }> {
    const name = deviceName(device);
    if (this.status.state !== "connecting" || this.status.device !== name) this.setStatus("connecting", name, null);
    const isClassicLogitech = device.vendorId === VENDOR_LOGITECH && parsePidLayout(device.collections) === null;
    const setupFn = isClassicLogitech ? setupLogitechDevice : setupPidDevice;
    const result = await setupFn(device, {
      deps: this.deps,
      onFail: (message, fatal) => {
        if (fatal && this.device === device) {
          this.session?.writer.kill();
          this.setStatus("error", name, `Force feedback stopped: ${message}`);
        }
      },
    });
    if (!result.ok) {
      try {
        if (device.opened) await device.close();
      } catch {
        // already gone
      }
      return { ok: false, name, unsupported: result.unsupported, message: result.message };
    }
    this.session = result.session;
    this.device = device;
    if (this.listening !== hid) {
      hid.addEventListener("disconnect", this.onDisconnect);
      this.listening = hid;
    }
    this.setStatus("ready", name, null);
    return { ok: true, name };
  }

  /** From connect()/reconnect() until dispose(): listen for a granted wheel coming back */
  private want(hid: HidApiLike): void {
    this.wanted = true;
    if (this.hotplugApi === hid) return;
    this.hotplugApi?.removeEventListener("connect", this.onConnect);
    hid.addEventListener("connect", this.onConnect);
    this.hotplugApi = hid;
  }

  private unwant(): void {
    this.wanted = false;
    this.hotplugApi?.removeEventListener("connect", this.onConnect);
    this.hotplugApi = null;
    if (this.hotplugTimer !== null) {
      this.deps.clearTimer(this.hotplugTimer);
      this.hotplugTimer = null;
    }
    this.wakeRetry?.();
  }

  /** A granted force-feedback device appeared (the wheel switched back on): re-open it once it has settled */
  private onConnect = (e: { device: HidDeviceLike }) => {
    if (!this.wanted || this.session || !pickFfbDevice([e.device], false)) return;
    if (this.hotplugTimer !== null) this.deps.clearTimer(this.hotplugTimer);
    this.hotplugTimer = this.deps.setTimer(() => {
      this.hotplugTimer = null;
      if (this.wanted && !this.session) void this.reconnect();
    }, HOTPLUG_DELAY_MS);
  };

  private waitForRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.wakeRetry === done) this.wakeRetry = null;
        this.deps.clearTimer(timer);
        resolve();
      };
      const timer = this.deps.setTimer(done, ms);
      this.wakeRetry = done;
    });
  }

  private onDisconnect = (e: { device: HidDeviceLike }) => {
    const d = this.device;
    if (!d) return;
    const same = e.device === d || (e.device.vendorId === d.vendorId && e.device.productId === d.productId);
    if (!same) return;
    this.session?.writer.kill();
    this.session = null;
    this.device = null;
    this.setStatus("idle", null, "Wheel disconnected");
  };

  /** Shuts the current session down (best effort) and forgets it */
  private async release(): Promise<void> {
    const session = this.session;
    const device = this.device;
    this.session = null;
    this.device = null;
    if (this.listening) {
      this.listening.removeEventListener("disconnect", this.onDisconnect);
      this.listening = null;
    }
    if (session) await teardownPidSession(session);
    if (device) {
      try {
        if (device.opened) await device.close();
      } catch {
        // already gone
      }
    }
  }

  private fail(state: WebHidFfbState, device: string | null, message: string): null {
    this.setStatus(state, device, message);
    return null;
  }

  private setStatus(state: WebHidFfbState, device: string | null, message: string | null): void {
    const s = this.status;
    if (s.state === state && s.device === device && s.message === message) return;
    this.status = { state, device, message };
    this.onStatus?.(this.status);
    for (const l of this.listeners) l();
  }
}
