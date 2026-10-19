/**
 * EXPERIMENTAL force feedback straight from the browser over WebHID (Chrome / Edge, https or localhost).
 *
 * Most direct-drive bases (Simagic, Moza, Simucube, VRS, Fanatec DD in PC mode, Asetek, OpenFFBoard, …) expose USB
 * HID PID (Physical Interface Device, usage page 0x0F): the protocol DirectInput force feedback rides on in Windows.
 * WebHID can write those same reports, so no native bridge is needed. This driver keeps ONE Constant Force effect
 * alive on the wheel and streams its magnitude (the shaped rim force) with Set Constant Force reports.
 *
 * Nothing here is hard-coded per device: report ids, field order and bit sizes come from the parsed report
 * descriptor (`device.collections`), see {@link parsePidLayout}. Logitech G-series wheels do not speak HID PID
 * (proprietary protocol) and are reported as unsupported; use the native bridge (wheel-ffb.ts) for those.
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
  addEventListener(type: "disconnect", listener: (e: { device: HidDeviceLike }) => void): void;
  removeEventListener(type: "disconnect", listener: (e: { device: HidDeviceLike }) => void): void;
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
  EFFECT_TYPE: pidUsage(0x25),
  ET_CONSTANT_FORCE: pidUsage(0x26),
  DURATION: pidUsage(0x50),
  SAMPLE_PERIOD: pidUsage(0x51),
  GAIN: pidUsage(0x52),
  TRIGGER_BUTTON: pidUsage(0x53),
  TRIGGER_REPEAT_INTERVAL: pidUsage(0x54),
  AXES_ENABLE: pidUsage(0x55),
  DIRECTION_ENABLE: pidUsage(0x56),
  DIRECTION: pidUsage(0x57),
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

export interface PidReportLayout {
  /** 0 when the device uses no report ids */
  reportId: number;
  /** Total data bits including padding; sendReport needs exactly ceil(bitLength / 8) bytes */
  bitLength: number;
  /** Field per full usage ((page << 16) | id); selectors are keyed by their parent usage (PID.EFFECT_TYPE, …) */
  fields: Record<number, PidFieldLayout>;
}

export interface PidLayout {
  /** Output reports */
  constantForce: PidReportLayout;
  effectOperation: PidReportLayout;
  setEffect: PidReportLayout | null;
  deviceControl: PidReportLayout | null;
  deviceGain: PidReportLayout | null;
  blockFree: PidReportLayout | null;
  /** Feature reports */
  createNewEffect: PidReportLayout | null;
  blockLoad: PidReportLayout | null;
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
  let offset = 0;
  const add = (key: number, f: PidFieldLayout) => {
    if (!(key in fields)) fields[key] = f;
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
        if (sel) add(sel.key, { bitOffset: offset, bitSize: size, ...range, signed, usages: sel.usages });
        else if (usages.length > 0) add(usages[0] as number, { bitOffset: offset, bitSize: size, ...range, signed, usages });
      } else if (usages.length > 0) {
        // fewer usages than count: the last usage applies to the remaining fields (HID rule)
        for (let k = 0; k < count; k++) {
          const u = usages[Math.min(k, usages.length - 1)] as number;
          add(u, { bitOffset: offset + k * size, bitSize: size, ...range, signed });
        }
      }
    }
    offset += size * count;
  }
  return { reportId, bitLength: offset, fields };
}

/**
 * Reports of one kind per report id. A report may be listed on its collection and again on parent collections; the
 * most complete listing (most bits) wins, so a split report is never half-parsed when one node has it all.
 */
function gatherReports(
  collections: readonly HidCollectionLike[],
  kind: "outputReports" | "featureReports",
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
 * Effect Type selector; Create New Effect = the same selector in a feature report; Block Load = the Block Load
 * Status selector (feature). Bit offsets are summed over the items in order (size x count, constant items are
 * padding), report ids are never hard-coded. Returns null without a usable Set Constant Force + Effect Operation.
 */
export function parsePidLayout(collections: readonly HidCollectionLike[]): PidLayout | null {
  let constantForce: PidReportLayout | null = null;
  let effectOperation: PidReportLayout | null = null;
  let setEffect: PidReportLayout | null = null;
  let deviceControl: PidReportLayout | null = null;
  let deviceGain: PidReportLayout | null = null;
  let blockFree: PidReportLayout | null = null;
  let createNewEffect: PidReportLayout | null = null;
  let blockLoad: PidReportLayout | null = null;

  for (const [id, raw] of gatherReports(collections, "outputReports")) {
    const l = parseReport(id, raw.items);
    const keys = Object.keys(l.fields).length;
    if (hasField(l, PID.EFFECT_TYPE)) {
      if (!setEffect) setEffect = l;
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

  if (!constantForce || !effectOperation) return null;
  return { constantForce, effectOperation, setEffect, deviceControl, deviceGain, blockFree, createNewEffect, blockLoad };
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
    // PID Trigger Button (0xFF on 8-bit) and Duration (0xFFFF on 16-bit) use out-of-range sentinels ("no trigger" /
    // "infinite duration") on descriptors whose LogicalMax stops at 8 or 32767 (e.g. MOZA R9 Base).
    const rounded = Math.round(value);
    const raw =
      (usage === PID.TRIGGER_BUTTON && rounded === 255 && f.bitSize >= 8) ||
      (usage === PID.DURATION && rounded === 0xffff && f.bitSize >= 16)
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
 * value is ever kept (intermediate ones are dropped) and changes below 1/1000 of the field's range are skipped.
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
    if (this.lastRaw !== null && raw !== this.zeroRaw && Math.abs(raw - this.lastRaw) < this.threshold) {
      this.pending = null; // the wheel already holds (nearly) this value; drop any older queued one
      return;
    }
    if (raw === this.lastRaw) {
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
  layout: PidLayout;
  /** Effect block holding the Constant Force effect */
  blockIndex: number;
  writer: ForceWriter;
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

/** Create New Effect (feature) then read PID Block Load back for the block index; block 1 when the device has neither */
async function allocateConstantForce(device: HidDeviceLike, layout: PidLayout, deps: FfbDeps): Promise<number> {
  const create = layout.createNewEffect;
  const load = layout.blockLoad;
  if (!create || !load) return 1;
  const type = getField(create, PID.EFFECT_TYPE);
  const typeValue = type ? selectorValue(type, PID.ET_CONSTANT_FORCE) : null;
  if (typeValue === null) return 1;
  const c = buildReport(create, { [PID.EFFECT_TYPE]: typeValue, [PID.BYTE_COUNT]: 0 });
  await device.sendFeatureReport(c.reportId, c.data);

  for (let attempt = 0; attempt < 3; attempt++) {
    const view = await device.receiveFeatureReport(load.reportId);
    let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    // WebHID leaves the report id out; tolerate a stack that keeps it
    if (load.reportId !== 0 && bytes.length === Math.ceil(load.bitLength / 8) + 1 && bytes[0] === load.reportId) bytes = bytes.subarray(1);
    const got = unpackReport(load, bytes);
    const statusField = getField(load, PID.BLOCK_LOAD_STATUS);
    const status = statusField ? selectedUsage(statusField, got[PID.BLOCK_LOAD_STATUS] ?? 0) : PID.BLOCK_LOAD_SUCCESS;
    if (status === PID.BLOCK_LOAD_FULL) throw new Error("The wheel has no free effect memory");
    if (status === PID.BLOCK_LOAD_ERROR) throw new Error("The wheel refused to create a constant force effect");
    if (status === PID.BLOCK_LOAD_SUCCESS || status === null) {
      const idx = got[PID.EFFECT_BLOCK_INDEX];
      return idx !== undefined && idx > 0 ? idx : 1;
    }
    await deps.sleep(20);
  }
  throw new Error("The wheel did not confirm the effect it was asked to create");
}

/**
 * The connect-time setup for an already granted device (factored out of {@link WebHidFfb.connect} so it can be tested
 * without navigator.hid): open, parse the PID layout, reset + enable actuators, device gain 100 %, create one
 * Constant Force effect, configure it (infinite duration, full gain, along X, X axis enabled), start it at zero force.
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

  try {
    if (!device.opened) await device.open();
    if (await deviceControl(device, layout, PID.DC_DEVICE_RESET)) await deps.sleep(60);
    await deviceControl(device, layout, PID.DC_ENABLE_ACTUATORS);

    if (layout.deviceGain) {
      const g = getField(layout.deviceGain, PID.DEVICE_GAIN);
      if (g) await sendOutput(device, layout.deviceGain, { [PID.DEVICE_GAIN]: g.max });
    }

    const blockIndex = await allocateConstantForce(device, layout, deps);

    const set = layout.setEffect;
    if (set) await sendOutput(device, set, setEffectValues(set, blockIndex));

    await sendOutput(device, layout.constantForce, {
      [PID.EFFECT_BLOCK_INDEX]: blockIndex,
      [PID.MAGNITUDE]: forceToRaw(forceField, 0),
    });
    const loops = getField(layout.effectOperation, PID.LOOP_COUNT);
    await sendOutput(device, layout.effectOperation, {
      [PID.EFFECT_BLOCK_INDEX]: blockIndex,
      [PID.EFFECT_OPERATION]: start,
      [PID.LOOP_COUNT]: loops ? Math.min(255, loops.max) : 0,
    });

    const writer = new ForceWriter(
      forceField,
      (raw) => sendOutput(device, layout.constantForce, { [PID.EFFECT_BLOCK_INDEX]: blockIndex, [PID.MAGNITUDE]: raw }),
      deps,
      options.onFail
    );
    return { ok: true, session: { device, layout, blockIndex, writer } };
  } catch (e) {
    return { ok: false, unsupported: false, message: errorMessage(e) };
  }
}

/** Set Effect values for an infinite, full-gain Constant Force along +X */
function setEffectValues(set: PidReportLayout, blockIndex: number): Record<number, number> {
  const v: Record<number, number> = { [PID.EFFECT_BLOCK_INDEX]: blockIndex };
  const type = getField(set, PID.EFFECT_TYPE);
  v[PID.EFFECT_TYPE] = (type ? selectorValue(type, PID.ET_CONSTANT_FORCE) : null) ?? 1;
  const duration = getField(set, PID.DURATION);
  // infinite: 0xFFFF on 16-bit fields (even where the descriptor stops at 32767, e.g. MOZA R9 Base); otherwise field max
  if (duration) v[PID.DURATION] = duration.bitSize >= 16 ? 0xffff : duration.max;
  const gain = getField(set, PID.GAIN);
  if (gain) v[PID.GAIN] = gain.max;
  const trigger = getField(set, PID.TRIGGER_BUTTON);
  // "no trigger" is 0xFF where the field is a full byte (even when LogicalMax < 255, e.g. MOZA R9 Base); otherwise 0
  if (trigger) v[PID.TRIGGER_BUTTON] = trigger.bitSize >= 8 || trigger.max >= 255 ? 255 : 0;
  // Direction along +X (90 degrees: east) in case the firmware uses the angle...
  const dir = getField(set, ordinalUsage(1));
  if (dir) v[ordinalUsage(1)] = dir.min + (dir.max - dir.min) * DIRECTION_X_FRACTION;
  const dir2 = getField(set, ordinalUsage(2));
  if (dir2) v[ordinalUsage(2)] = dir2.min;
  const dirGeneric = getField(set, PID.DIRECTION);
  if (dirGeneric) v[PID.DIRECTION] = dirGeneric.min + (dirGeneric.max - dirGeneric.min) * DIRECTION_X_FRACTION;
  // ...and X enabled in the axes mask, with Direction Enable cleared so the mask decides (angle only when there is no mask)
  const axisX = hasField(set, AXIS_X);
  if (axisX) {
    v[AXIS_X] = 1;
    if (hasField(set, AXIS_Y)) v[AXIS_Y] = 0;
    if (hasField(set, AXIS_Z)) v[AXIS_Z] = 0;
  }
  if (hasField(set, PID.AXES_ENABLE)) v[PID.AXES_ENABLE] = 1;
  if (hasField(set, PID.DIRECTION_ENABLE)) v[PID.DIRECTION_ENABLE] = axisX || hasField(set, PID.AXES_ENABLE) ? 0 : 1;
  return v;
}

/** Best-effort shutdown: zero force, stop the effect, free it, stop all, disable actuators. Never throws. */
export async function teardownPidSession(session: PidSession): Promise<void> {
  await session.writer.close();
  const { device, layout, blockIndex } = session;
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // device may already be gone
    }
  };
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
  }
  if (layout.blockFree) {
    await attempt(() => sendOutput(device, layout.blockFree as PidReportLayout, { [PID.EFFECT_BLOCK_INDEX]: blockIndex }));
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

const REQUEST_FILTERS = [{ usagePage: 0x01, usage: 0x04 }, { usagePage: 0x01, usage: 0x05 }, { usagePage: 0x0f }];
const UNSUPPORTED_BROWSER = "WebHID needs Chrome or Edge on https or localhost";
/** Status message when the page loads with WebHID on but no wheel was granted to it yet (pairing needs a click) */
export const PAIR_MESSAGE = "Click Connect to pair your wheel";
const LOGITECH_MESSAGE =
  "Logitech G-series wheels use a proprietary force-feedback protocol, not HID PID, so the browser cannot drive them; use the native FFB bridge";

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
    let picking: Promise<{ device: HidDeviceLike | undefined } | { error: string }>;
    try {
      picking = hid.requestDevice({ filters: REQUEST_FILTERS }).then(
        (d) => ({ device: d[0] }),
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
   * Re-opens a wheel the user granted earlier, without a prompt (page load); null when there is none, with the status
   * asking for a Connect click ({@link PAIR_MESSAGE}). Never shows the picker. A running wheel is kept.
   */
  reconnect(): Promise<string | null> {
    return this.guard(async () => {
      const hid = this.hidApi();
      if (!hid) return this.fail("unsupported", null, UNSUPPORTED_BROWSER);
      if (this.session && this.device) return deviceName(this.device);
      let devices: HidDeviceLike[];
      try {
        devices = await hid.getDevices();
      } catch (e) {
        return this.fail("error", null, errorMessage(e));
      }
      const found = devices.find((d) => d.vendorId !== VENDOR_LOGITECH && parsePidLayout(d.collections) !== null);
      if (!found) {
        this.setStatus("idle", null, PAIR_MESSAGE);
        return null;
      }
      await this.release();
      this.setStatus("connecting", deviceName(found), null);
      return this.attach(hid, found);
    });
  }

  /**
   * PID magnitude −1..1 (+ pushes the rim left, − right; see the sign convention above). Cheap to call every frame:
   * writes are spaced by at least 2 ms, one in flight at a time, always carrying the latest value.
   */
  setForce(force: number): void {
    this.session?.writer.setForce(force);
  }

  /** Zero force now (pause menu) */
  stop(): void {
    this.session?.writer.setForce(0, true);
  }

  /**
   * Stops all effects, disables actuators and closes the device (after any connect in flight). An error status is
   * kept, so the reason stays on screen once the driver is switched off because of it.
   */
  async dispose(): Promise<void> {
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

  private async attach(hid: HidApiLike, device: HidDeviceLike): Promise<string | null> {
    const name = deviceName(device);
    this.setStatus("connecting", name, null);
    if (device.vendorId === VENDOR_LOGITECH) return this.fail("unsupported", name, LOGITECH_MESSAGE);
    const result = await setupPidDevice(device, {
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
      return this.fail(result.unsupported ? "unsupported" : "error", name, result.message);
    }
    this.session = result.session;
    this.device = device;
    if (this.listening !== hid) {
      hid.addEventListener("disconnect", this.onDisconnect);
      this.listening = hid;
    }
    this.setStatus("ready", name, null);
    return name;
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
