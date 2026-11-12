/**
 * EXPERIMENTAL force feedback straight from the browser over WebHID (Chrome / Edge, https or localhost).
 *
 * Most direct-drive bases (Simagic, Moza, Simucube, VRS, Fanatec DD in PC mode, Asetek, OpenFFBoard, …) expose USB
 * HID PID (Physical Interface Device, usage page 0x0F): the protocol DirectInput force feedback rides on in Windows.
 * WebHID can write those same reports, so no native bridge is needed. This driver keeps ONE Constant Force effect
 * alive on the wheel and streams its magnitude (the shaped rim force) with Set Constant Force reports.
 *
 * Report ids, field order and bit sizes come from the parsed report descriptor (`device.collections`), see
 * {@link parsePidLayout}. The few values firmwares disagree on are a {@link PidProfile}, chosen per wheel by USB id.
 *
 * Logitech wheels do not speak HID PID. The G25, G27, Driving Force GT and G29 (LOGITECH_CLASSIC_WHEELS in
 * wheel-support.ts) take the classic Logitech commands, sent as Linux hid-lg4ff sends them
 * ({@link setupLogitechClassicDevice}); the G920 and G923 for Xbox (LOGITECH_HIDPP_WHEELS) take HID++ 2.0 force
 * feedback, sent as Linux hid-logitech-hidpp sends it (webhid-logitech-hidpp.ts); any other Logitech device without a
 * PID descriptor is refused (bridge). The Thrustmaster belt bases in THRUSTMASTER_WHEELS take the commands of the
 * Linux driver hid-tmff2 (webhid-thrustmaster.ts); any other Thrustmaster device without a PID descriptor is refused
 * the same way.
 *
 * Sign convention: `WebHidFfb.setForce` takes the raw PID magnitude, −1..1 over the field's logical range. A PID /
 * DirectInput direction says where the force comes from, so + magnitude along +X (90°) pushes the rim left and − pushes
 * it right. The game's forces are + = right; `linkHidSink` in wheel-ffb.ts flips the sign between the two.
 */

import {
  describeLogitechHidppInterface,
  describeLogitechHidppSession,
  emergencyStopLogitechHidppSession,
  hidppReports,
  setupLogitechHidppDevice,
  teardownLogitechHidppSession,
  type LogitechHidppSession,
} from "./webhid-logitech-hidpp";
import {
  LG4FF_MAX_RANGE_DEG,
  LG4FF_MIN_RANGE_DEG,
  LOGITECH_HIDPP_WHEELS,
  LOGITECH_VENDOR_ID,
  LOGITECH_WEBHID_NAMES,
  logitechClassicModel,
  logitechHidppModel,
  THRUSTMASTER_NAMES,
  THRUSTMASTER_STARTUP_PRODUCT_IDS,
  THRUSTMASTER_VENDOR_ID,
  thrustmasterModel,
  type LogitechClassicModel,
  type LogitechHidppModel,
  type ThrustmasterModel,
} from "./wheel-support";
import {
  setupThrustmasterDevice,
  teardownThrustmasterSession,
  thrustmasterInterfaceFits,
  thrustmasterReleaseCommands,
  TMFF2_REPORT_ID,
  type ThrustmasterSession,
} from "./webhid-thrustmaster";

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

/** An input report as HIDInputReportEvent hands it over: the data without the report id */
export interface HidInputReportEventLike {
  reportId: number;
  data: DataView;
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
  /** Input reports: the replies of a HID++ wheel. Optional, as only that driver reads any */
  addEventListener?(type: "inputreport", listener: (e: HidInputReportEventLike) => void): void;
  removeEventListener?(type: "inputreport", listener: (e: HidInputReportEventLike) => void): void;
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
  ET_DAMPER: pidUsage(0x41),
  ET_INERTIA: pidUsage(0x42),
  ET_FRICTION: pidUsage(0x43),
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

/** The Device Control commands, for a report that lists them as one 1-bit flag each instead of an array */
const DEVICE_CONTROL_FLAGS: readonly number[] = [
  PID.DC_ENABLE_ACTUATORS,
  PID.DC_DISABLE_ACTUATORS,
  PID.DC_STOP_ALL_EFFECTS,
  PID.DC_DEVICE_RESET,
  PID.DC_DEVICE_PAUSE,
  PID.DC_DEVICE_CONTINUE,
];

/** Ordinal usage n (Direction is one Ordinal-usage field per axis: ordinal 1 = X) */
export const ordinalUsage = (n: number) => (PAGE_ORDINAL << 16) | n;

/** Array ("selector") fields: the child usages that identify which selector a field is, and the key it is stored under */
const SELECTORS: readonly { key: number; lo: number; hi: number }[] = [
  { key: PID.EFFECT_TYPE, lo: 0x26, hi: 0x43 },
  { key: PID.EFFECT_OPERATION, lo: 0x79, hi: 0x7b },
  { key: PID.DEVICE_CONTROL, lo: 0x97, hi: 0x9c },
  { key: PID.BLOCK_LOAD_STATUS, lo: 0x8c, hi: 0x8e },
];

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
}

export interface PidReportLayout {
  /** 0 when the device uses no report ids */
  reportId: number;
  /** Total data bits including padding; sendReport needs exactly ceil(bitLength / 8) bytes */
  bitLength: number;
  /** First field per full usage ((page << 16) | id); selectors are keyed by their parent usage (PID.EFFECT_TYPE, …) */
  fields: Record<number, PidFieldLayout>;
  /**
   * Every field in report order, repeated usages included: some Set Effect descriptors name Generic Desktop X / Y
   * twice, as 1-bit Axes Enable flags and again as the multi-bit Direction
   */
  fieldList: PidFieldEntry[];
}

export interface PidLayout {
  /** Output reports */
  constantForce: PidReportLayout;
  effectOperation: PidReportLayout;
  setEffect: PidReportLayout | null;
  setCondition: PidReportLayout | null;
  deviceControl: PidReportLayout | null;
  deviceGain: PidReportLayout | null;
  blockFree: PidReportLayout | null;
  /** Feature reports */
  createNewEffect: PidReportLayout | null;
  blockLoad: PidReportLayout | null;
  /** PID Pool (RAM Pool Size 0x80 / Simultaneous Effects Max 0x83), read once at setup as hid-pidff and DirectInput do */
  pool: PidReportLayout | null;
  /** Set Effect offers the Damper condition effect (0x41) and there is a Set Condition report */
  hasDamper: boolean;
  /** Every condition effect this driver can run that Set Effect offers, with a Set Condition report */
  conditions: ConditionKind[];
}

/**
 * Condition effects the wheel runs itself, from the rim's own motion at the firmware's rate: the damper (speed), the
 * friction (direction of motion) and the inertia (acceleration). The spring is left out: the game's torque centres the
 * rim, and the wheel goes limp outside the car
 */
export type ConditionKind = "damper" | "friction" | "inertia";
/** Condition effects set up only when the player asked for them (the damper always is, where the wheel offers it) */
export type OptionalConditionKind = Exclude<ConditionKind, "damper">;
const CONDITION_EFFECT: Record<ConditionKind, number> = { damper: 0x41, friction: 0x43, inertia: 0x42 };
/**
 * Saturation each condition effect is set up with (share of the wheel's range it may push with). Friction and inertia
 * stay well under full torque: a full-strength friction that flips sign as the rim stops can oscillate a direct drive
 */
export const CONDITION_SATURATION: Record<ConditionKind, number> = { damper: 1, friction: 0.3, inertia: 0.3 };

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
  // A range of 0..0 holds nothing: the MOZA R9 Base declares its 1-bit Axes Enable, Direction Enable and Device Control
  // flags so. The field takes its full width, as the HID stacks that write these bits do
  if (lo === 0 && hi === 0) hi = full;
  return { min: lo, max: hi };
}

function expandUsages(item: HidReportItemLike): number[] {
  const out = item.usages ? [...item.usages] : [];
  if (out.length === 0 && item.isRange && typeof item.usageMinimum === "number" && typeof item.usageMaximum === "number") {
    for (let u = item.usageMinimum; u <= item.usageMaximum && out.length < 512; u++) out.push(u);
  }
  return out;
}

/**
 * How the browser lists the usages of an array item, whose value is `logical minimum + index` in that list.
 * "descriptor": in report descriptor order, as Chrome gives them on macOS, Linux and ChromeOS, where it parses the raw
 * descriptor. "unordered": in no fixed order. Chrome on Windows has no raw descriptor: it rebuilds the items from
 * Windows' preparsed data, one per usage, and sorts them by report id and bit position with an unstable sort
 * (CreateReportDescriptions in services/device/hid/hid_service_win.cc), so the usages of one array item, which share a
 * position, come out shuffled (MOZA R9 Base: the effect types reversed, Effect Operation as Start, Stop, Start Solo).
 */
export type UsageOrder = "descriptor" | "unordered";

/** The usage order of the browser this runs in (Windows: "unordered") */
export function platformUsageOrder(): UsageOrder {
  const ua = typeof navigator !== "undefined" && typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  return /\bWindows\b/.test(ua) ? "unordered" : "descriptor";
}

/**
 * The PID selector usages in the order of the USB PID 1.0 sample report descriptor, which PID firmwares copy (ET Custom
 * Force Data last, after the conditions): the order an "unordered" list is put back into
 */
const SPEC_SELECTOR_ORDER: readonly number[] = [
  0x26, 0x27, 0x30, 0x31, 0x32, 0x33, 0x34, 0x40, 0x41, 0x42, 0x43, 0x28, // Effect Type
  0x79, 0x7a, 0x7b, // Effect Operation: Start, Start Solo, Stop
  0x8c, 0x8d, 0x8e, // Block Load Status: Success, Full, Error
  0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, // Device Control: Enable / Disable Actuators, Stop All, Reset, Pause, Continue
].map(pidUsage);

/** `usages` in {@link SPEC_SELECTOR_ORDER}; any usage it does not name goes last, by id */
function inSpecOrder(usages: readonly number[]): number[] {
  const rank = (u: number) => {
    const i = SPEC_SELECTOR_ORDER.indexOf(u);
    return i >= 0 ? i : SPEC_SELECTOR_ORDER.length + (u & 0xffff);
  };
  return [...usages].sort((a, b) => rank(a) - rank(b));
}

/**
 * Which selector an array item is (by the page-0x0F child usages it lists), with its list reduced to those usages; an
 * "unordered" list is put into the PID spec's order
 */
function detectSelector(usages: readonly number[], order: UsageOrder): { key: number; usages: number[] } | null {
  for (const s of SELECTORS) {
    const mine = usages.filter((u) => u >>> 16 === PAGE_PID && (u & 0xffff) >= s.lo && (u & 0xffff) <= s.hi);
    if (mine.length > 0) return { key: s.key, usages: order === "unordered" ? inSpecOrder(mine) : mine };
  }
  return null;
}

function parseReport(reportId: number, items: readonly HidReportItemLike[], order: UsageOrder = "descriptor"): PidReportLayout {
  const fields: Record<number, PidFieldLayout> = {};
  const fieldList: PidFieldEntry[] = [];
  let offset = 0;
  const add = (key: number, f: PidFieldLayout) => {
    if (!(key in fields)) fields[key] = f;
    fieldList.push({ ...f, usage: key });
  };
  for (const item of items) {
    const size = Math.max(0, Math.floor(item.reportSize ?? 0));
    const count = Math.max(0, Math.floor(item.reportCount ?? 0));
    if (!item.isConstant && size > 0 && count > 0) {
      const usages = expandUsages(item);
      const range = normaliseRange(item.logicalMinimum, item.logicalMaximum, size);
      const signed = range.min < 0;
      if (item.isArray) {
        const sel = detectSelector(usages, order);
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
  return { reportId, bitLength: offset, fields, fieldList };
}

/**
 * Reports of one kind per report id. A report may be listed on its collection and again on parent collections; the
 * most complete listing (most bits) wins, so a split report is never half-parsed when one node has it all.
 */
function gatherReports(
  collections: readonly HidCollectionLike[],
  kind: "outputReports" | "featureReports" | "inputReports",
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
 * Effect Type selector; Set Condition = output report with CP Offset and Positive Coefficient; Create New Effect =
 * the Effect Type selector in a feature report; Block Load = the Block Load Status selector (feature: it is read back
 * with receiveFeatureReport). Bit offsets are summed over the items in order (size x count, constant items are
 * padding), report ids are never hard-coded. Returns null without a usable Set Constant Force + Effect Operation.
 */
export function parsePidLayout(
  collections: readonly HidCollectionLike[],
  order: UsageOrder = platformUsageOrder()
): PidLayout | null {
  let constantForce: PidReportLayout | null = null;
  let effectOperation: PidReportLayout | null = null;
  let setEffect: PidReportLayout | null = null;
  let setCondition: PidReportLayout | null = null;
  let deviceControl: PidReportLayout | null = null;
  let deviceGain: PidReportLayout | null = null;
  let blockFree: PidReportLayout | null = null;
  let createNewEffect: PidReportLayout | null = null;
  let blockLoad: PidReportLayout | null = null;
  let pool: PidReportLayout | null = null;

  for (const [id, raw] of gatherReports(collections, "outputReports")) {
    const l = parseReport(id, raw.items, order);
    const keys = Object.keys(l.fields).length;
    if (hasField(l, PID.EFFECT_TYPE)) {
      if (!setEffect) setEffect = l;
    } else if (hasField(l, PID.CP_OFFSET) && hasField(l, PID.POSITIVE_COEFFICIENT)) {
      if (!setCondition) setCondition = l;
    } else if (hasField(l, PID.EFFECT_OPERATION)) {
      const f = getField(l, PID.EFFECT_OPERATION);
      if (!effectOperation && f?.usages?.includes(PID.OP_EFFECT_START) && hasField(l, PID.EFFECT_BLOCK_INDEX)) effectOperation = l;
    } else if (hasField(l, PID.DEVICE_CONTROL) || DEVICE_CONTROL_FLAGS.some((u) => hasField(l, u))) {
      // An array of DC_* usages, or (MOZA R9 Base) one 1-bit flag per command
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
    const l = parseReport(id, raw.items, order);
    if (hasField(l, PID.EFFECT_TYPE)) {
      if (!createNewEffect) createNewEffect = l;
    } else if (hasField(l, PID.BLOCK_LOAD_STATUS)) {
      if (!blockLoad) blockLoad = l;
    } else if (hasField(l, pidUsage(0x80)) || hasField(l, pidUsage(0x83))) {
      if (!pool) pool = l;
    }
  }

  if (!constantForce || !effectOperation) return null;
  const effectTypes = setEffect ? (getField(setEffect, PID.EFFECT_TYPE)?.usages ?? []) : [];
  const hasDamper = setCondition !== null && effectTypes.includes(PID.ET_DAMPER);
  const conditions = setCondition
    ? (Object.keys(CONDITION_EFFECT) as ConditionKind[]).filter((k) => effectTypes.includes(pidUsage(CONDITION_EFFECT[k])))
    : [];
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
    pool,
    hasDamper,
    conditions,
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
    const f = getField(layout, Number(key));
    if (!f || !Number.isFinite(value)) continue;
    writeBits(data, f.bitOffset, f.bitSize, clamp(Math.round(value), f.min, f.max));
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

/** One latest-value stream of a {@link ForceWriter} */
export interface WriterChannel {
  /** Value → raw field value; equal raws are never sent twice in a row */
  toRaw: (value: number) => number;
  /** Raw changes smaller than this are skipped, except a change to `zeroRaw` */
  threshold: number;
  zeroRaw?: number;
  send: (raw: number) => Promise<void>;
  /** What the wheel already holds when the stream starts (null: the first value always goes out) */
  initialRaw?: number | null;
  /**
   * After this long (ms) without a write on this stream, a value goes out again even if it is unchanged or inside the
   * threshold; absent: an unchanged value is never resent
   */
  keepaliveMs?: number;
}

interface ChannelState extends WriterChannel {
  lastRaw: number | null;
  /** When this stream last went out (deps.now ms) */
  lastSentMs: number;
  pending: number | null;
  urgent: boolean;
}

/**
 * Streams values to the wheel: at most one sendReport in flight for the device, at least 2 ms between writes, only the
 * latest value of each stream is kept (intermediate ones are dropped) and changes below a stream's threshold are
 * skipped (for the force: 1/1000 of the field's range). The force is the first stream; {@link addChannel} adds others
 * (the hardware damper, the Logitech range) that share the write slot, the spacing and the failure count, taking turns
 * when several are waiting. The force alone has a keepalive: once {@link FORCE_KEEPALIVE_MS} has passed since it last
 * went out, the next value is written even if unchanged, covering a write the wheel dropped without an error.
 */
export class ForceWriter {
  private readonly channels: ChannelState[] = [];
  /** Index of the stream written last; the force (0) is first when nothing was written yet */
  private lastChannel = -1;
  private current: Promise<void> | null = null;
  private lastSendMs = -Infinity;
  private timer: unknown = null;
  private failures = 0;
  private dead = false;
  private readonly force: ChannelState;

  constructor(
    field: PidFieldLayout,
    send: (raw: number) => Promise<void>,
    private readonly deps: FfbDeps,
    private readonly onFail?: (message: string, fatal: boolean) => void
  ) {
    this.force = this.add({
      toRaw: (f) => forceToRaw(field, f),
      threshold: (field.max - field.min) / 1000,
      zeroRaw: forceToRaw(field, 0),
      send,
      keepaliveMs: FORCE_KEEPALIVE_MS,
    });
  }

  /** `urgent` skips the 2 ms spacing (used to zero the wheel at once) */
  setForce(force: number, urgent = false): void {
    this.set(this.force, force, urgent);
  }

  /** Another stream on the same device; returns its setter (`urgent` as in {@link setForce}) */
  addChannel(channel: WriterChannel): (value: number, urgent?: boolean) => void {
    const state = this.add(channel);
    return (value, urgent = false) => this.set(state, value, urgent);
  }

  /** Stops writing and waits for the write in flight; nothing is sent afterwards */
  async close(): Promise<void> {
    this.kill();
    await this.current;
  }

  /** Stops writing without waiting (device vanished) */
  kill(): void {
    this.dead = true;
    for (const c of this.channels) c.pending = null;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private add(channel: WriterChannel): ChannelState {
    const state: ChannelState = { ...channel, lastRaw: channel.initialRaw ?? null, lastSentMs: -Infinity, pending: null, urgent: false };
    this.channels.push(state);
    return state;
  }

  private set(c: ChannelState, value: number, urgent: boolean): void {
    if (this.dead) return;
    const raw = c.toRaw(value);
    // Nothing written on this stream for a while: the value goes out again, whatever the threshold says
    const stale = c.keepaliveMs !== undefined && c.lastRaw !== null && this.deps.now() - c.lastSentMs >= c.keepaliveMs;
    if (!stale && (raw === c.lastRaw || (c.lastRaw !== null && raw !== c.zeroRaw && Math.abs(raw - c.lastRaw) < c.threshold))) {
      // The wheel already holds (nearly) this value; drop any older queued one, and its urgency with it
      c.pending = null;
      c.urgent = false;
      return;
    }
    // Urgency belongs to the queued value: a newer ordinary value that replaces an urgent one keeps the spacing
    c.pending = raw;
    c.urgent = urgent;
    if (urgent) {
      if (this.timer !== null) {
        this.deps.clearTimer(this.timer);
        this.timer = null;
      }
    }
    this.pump();
  }

  /** An urgent value first, else the next waiting stream after the one sent last, so a 500 Hz force cannot starve the rest */
  private next(): ChannelState | undefined {
    const urgent = this.channels.find((x) => x.pending !== null && x.urgent);
    if (urgent) return urgent;
    const n = this.channels.length;
    for (let k = 1; k <= n; k++) {
      const c = this.channels[(this.lastChannel + k) % n] as ChannelState;
      if (c.pending !== null) return c;
    }
    return undefined;
  }

  private pump(): void {
    if (this.dead || this.current !== null) return;
    const c = this.next();
    if (!c || c.pending === null) return;
    const wait = c.urgent ? 0 : this.lastSendMs + MIN_WRITE_INTERVAL_MS - this.deps.now();
    if (wait > 0) {
      if (this.timer === null) {
        this.timer = this.deps.setTimer(() => {
          this.timer = null;
          this.pump();
        }, wait);
      }
      return;
    }
    const raw = c.pending;
    c.pending = null;
    c.urgent = false;
    c.lastRaw = raw;
    this.lastChannel = this.channels.indexOf(c);
    this.lastSendMs = this.deps.now();
    c.lastSentMs = this.lastSendMs;
    this.current = c
      .send(raw)
      .then(
        () => {
          this.failures = 0;
        },
        (e: unknown) => {
          this.failures++;
          c.lastRaw = null; // resend the next value whatever it is
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

export interface SessionBase {
  device: HidDeviceLike;
  /** Every write to the wheel goes through it: the force, and any other stream the session adds */
  writer: ForceWriter;
  /** Hardware damper coefficient 0..1, a stream of `writer`; absent without a hardware damper */
  setDamper?: (coeff: number, urgent?: boolean) => void;
}

export interface PidSession extends SessionBase {
  kind: "pid";
  layout: PidLayout;
  /** Effect block holding the Constant Force effect */
  blockIndex: number;
  /** Effect block holding the hardware Damper condition effect; null when the wheel runs none */
  damperBlockIndex: number | null;
  /** Every condition effect running on the wheel (the damper included), each on its own block */
  conditionBlocks: { kind: ConditionKind; blockIndex: number }[];
  /** Coefficient 0..1 per running condition effect, each a stream of `writer` (`setDamper` is the damper's) */
  setCondition: Partial<Record<ConditionKind, (coeff: number, urgent?: boolean) => void>>;
  /** The optional condition effects this session was set up to run (whether or not the wheel took them) */
  requestedConditions: OptionalConditionKind[];
}

export interface LogitechClassicSession extends SessionBase {
  kind: "logitech-classic";
  model: LogitechClassicModel;
  /** Writes one 7-byte lg4ff command to the wheel; called directly only at setup and teardown, else through `writer` */
  send: (bytes: readonly number[]) => Promise<void>;
  /** Rotation lock to lock (deg), a stream of `writer`; values outside 40..900 are ignored, as lg4ff_range_store does */
  setRange: (deg: number) => void;
  /** A range command went out, so teardown puts the 900° that lg4ff_init starts with back */
  rangeChanged: boolean;
  /** Rev LED mask (bit 0 = RPM1 … bit 4 = RPM5), a stream of `writer`; absent on a wheel without them */
  setLeds?: (mask: number, urgent?: boolean) => void;
}

export type FfbSession = PidSession | LogitechClassicSession | LogitechHidppSession | ThrustmasterSession;

export type SetupResult<S> =
  | { ok: true; session: S }
  | { ok: false; /** the device has no force feedback this driver can use (as opposed to a transient failure) */ unsupported: boolean; message: string };
export type PidSetupResult = SetupResult<PidSession>;

export interface PidSetupOptions {
  deps?: FfbDeps;
  onFail?: (message: string, fatal: boolean) => void;
  /** The device's layout when the caller has parsed it already */
  layout?: PidLayout;
  /** Friction / inertia to set up as well, where the wheel offers them; none by default */
  conditions?: readonly OptionalConditionKind[];
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Firmware profiles                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The setup values HID PID firmwares are known to disagree on. No wheel has confirmed either choice on this code yet:
 * the generic profile sends what Linux mainline hid-pidff.c sends every PID wheel, the values that moved a MOZA R9 on
 * Windows (12 Nov 2026), and a wheel that needs otherwise gets an entry in {@link PID_QUIRKS}.
 */
export interface PidProfile {
  /**
   * Set Effect Trigger Button meaning "none". 0xFF on a byte-wide field (DirectInput's DIEB_NOTRIGGER is all-ones),
   * written past a LogicalMax of 8 (MOZA R9 Base); 0 is "no button" in USB PID numbering, where buttons are 1-based,
   * and is what hid-pidff sends (pidff_set_effect_report)
   */
  noTriggerButton: 0xff | 0;
  /**
   * Set Effect Direction Enable. "unless-axes": cleared when the report has an Axes Enable mask, so the mask (X alone)
   * picks the axis and the angle only counts without one. "always": set, as hid-pidff does (pidff_set_effect_direction)
   */
  directionEnable: "unless-axes" | "always";
  /**
   * Set Effect Axes Enable flags. "x": X alone is set. "none": every flag left clear, as hid-pidff leaves the 1-bit
   * X / Y flags of a descriptor that names no Axes Enable (0x55) for them, so Direction Enable and the direction pick
   * the axis
   */
  axisFlags: "x" | "none";
  /**
   * Effect Operation loop count on start. "max" (at most 255) keeps the effect playing for 255 x Duration should a
   * firmware read Duration 0xFFFF as 65.535 s rather than infinite; 1 stops after one Duration in that case
   */
  loopCount: "max" | 1;
  /** Pause after Device Reset (ms) */
  resetSleepMs: number;
  /** Device Control Stop All Effects between the reset and Enable Actuators, as hid-pidff's pidff_reset does */
  stopAllAfterReset: boolean;
  /** Pause between Create New Effect and the first PID Block Load read (ms) */
  createSettleMs: number;
}

/**
 * hid-pidff's values: Trigger Button 0 (pidff_set_effect_report), Direction Enable set with no axis flag
 * (pidff_set_effect_direction), Reset then Stop All before Enable Actuators (pidff_reset). Confirmed on a MOZA R9 Base,
 * on Windows, with the page's sequence replayed through hidapi (12 Nov 2026)
 */
export const GENERIC_PID_PROFILE: PidProfile = {
  noTriggerButton: 0,
  directionEnable: "always",
  axisFlags: "none",
  loopCount: "max",
  resetSleepMs: 60,
  stopAllAfterReset: true,
  createSettleMs: 0,
};

/**
 * Wheels with their own profile, by USB vendor / product id. PXN V99: the values 2ef8324 made the default for every
 * wheel while it targeted this one. The ids come from a Gamepad.id in that change's tests, not from a device; if they
 * are wrong the entry never matches and the wheel gets the generic profile.
 */
export const PID_QUIRKS: readonly { vendorId: number; productId: number; name: string; profile: PidProfile }[] = [
  {
    vendorId: 0x11ff,
    productId: 0x3245,
    name: "PXN V99",
    profile: {
      noTriggerButton: 0,
      directionEnable: "always",
      axisFlags: "x",
      loopCount: 1,
      resetSleepMs: 30,
      stopAllAfterReset: true,
      createSettleMs: 20,
    },
  },
];

function pidQuirkFor(device: Pick<HidDeviceLike, "vendorId" | "productId">) {
  return PID_QUIRKS.find((q) => q.vendorId === device.vendorId && q.productId === device.productId);
}

export function pidProfileFor(device: Pick<HidDeviceLike, "vendorId" | "productId">): PidProfile {
  return pidQuirkFor(device)?.profile ?? GENERIC_PID_PROFILE;
}

/** "generic", or the quirk's wheel name ("PXN V99"), for diagnostics */
function pidProfileName(device: Pick<HidDeviceLike, "vendorId" | "productId">): string {
  return pidQuirkFor(device)?.name ?? "generic";
}

const NO_PID_MESSAGE = "This device does not expose HID PID force feedback (no Set Constant Force / Effect Operation report)";

function sendOutput(device: HidDeviceLike, layout: PidReportLayout, values: Record<number, number>): Promise<void> {
  const r = buildReport(layout, values);
  return device.sendReport(r.reportId, r.data);
}

/**
 * Device Control command (reset, enable, …); false when the device has no such command. The report is an array that
 * selects one command, or one 1-bit flag per command, of which only this one is set. Either way the report is handed
 * over before the first await (the emergency stop relies on it).
 */
async function deviceControl(device: HidDeviceLike, layout: PidLayout, usage: number): Promise<boolean> {
  const rep = layout.deviceControl;
  if (!rep) return false;
  const f = getField(rep, PID.DEVICE_CONTROL);
  if (f) {
    const v = selectorValue(f, usage);
    if (v === null) return false;
    await sendOutput(device, rep, { [PID.DEVICE_CONTROL]: v });
    return true;
  }
  if (!hasField(rep, usage)) return false;
  await sendOutput(device, rep, { [usage]: 1 });
  return true;
}

/**
 * Create New Effect (feature) then read PID Block Load back for the block index. Null when the wheel does not
 * allocate effects this way (no Create New Effect / Block Load, or the effect type not offered) or names no block.
 */
async function allocateEffect(
  device: HidDeviceLike,
  layout: PidLayout,
  deps: FfbDeps,
  profile: PidProfile,
  effectTypeUsage: number,
  effectName: string
): Promise<number | null> {
  const create = layout.createNewEffect;
  const load = layout.blockLoad;
  if (!create || !load) return null;
  const type = getField(create, PID.EFFECT_TYPE);
  const typeValue = type ? selectorValue(type, effectTypeUsage) : null;
  if (typeValue === null) return null;
  const c = buildReport(create, { [PID.EFFECT_TYPE]: typeValue, [PID.BYTE_COUNT]: 0 });
  await device.sendFeatureReport(c.reportId, c.data);
  if (profile.createSettleMs > 0) await deps.sleep(profile.createSettleMs);

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
    if (status === PID.BLOCK_LOAD_ERROR) throw new Error(`The wheel refused to create a ${effectName} effect`);
    if (status === PID.BLOCK_LOAD_SUCCESS || status === null) {
      const idx = got[PID.EFFECT_BLOCK_INDEX];
      return idx !== undefined && idx > 0 ? idx : null;
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

/** A 1-bit Generic Desktop field (X, Y, Z…) is an Axes Enable flag; a wider one is a Direction */
const isAxisFlag = (f: PidFieldEntry) => f.usage >>> 16 === PAGE_DESKTOP && f.bitSize === 1;

/**
 * Set Effect for an infinite, full-gain effect along +X: Duration 0xFFFF (infinite on a 16-bit field even where
 * LogicalMax stops at 32767, as on the MOZA R9 Base; the field's max on a narrower one), Gain max, no trigger button,
 * X alone in the Axes Enable mask, the first Direction field at 90° (east, +X) and any further one at its minimum.
 * Walks `fieldList`, so a usage the report names twice (X as an Axes Enable flag and again as a Direction) gets both.
 */
export function buildSetEffectReport(
  set: PidReportLayout,
  blockIndex: number,
  effectTypeUsage: number = PID.ET_CONSTANT_FORCE,
  profile: PidProfile = GENERIC_PID_PROFILE
): { reportId: number; data: Uint8Array } {
  const data = new Uint8Array(Math.ceil(set.bitLength / 8));
  const put = (f: PidFieldLayout, v: number) => writeBits(data, f.bitOffset, f.bitSize, clamp(Math.round(v), f.min, f.max));
  // Duration and Trigger Button sentinels sit outside some descriptors' logical ranges, so they skip the clamp
  const putRaw = (f: PidFieldLayout, v: number) => writeBits(data, f.bitOffset, f.bitSize, v);
  const hasAxesMask = hasField(set, PID.AXES_ENABLE) || set.fieldList.some(isAxisFlag);
  let axisFlags = 0;
  let directions = 0;
  for (const f of set.fieldList) {
    const page = f.usage >>> 16;
    if (f.usage === PID.EFFECT_BLOCK_INDEX) put(f, blockIndex);
    else if (f.usage === PID.EFFECT_TYPE) put(f, selectorValue(f, effectTypeUsage) ?? 1);
    else if (f.usage === PID.DURATION) putRaw(f, f.bitSize >= 16 ? 0xffff : f.max);
    else if (f.usage === PID.GAIN) put(f, f.max);
    else if (f.usage === PID.TRIGGER_BUTTON) {
      if (profile.noTriggerButton === 0) putRaw(f, 0);
      else if (f.bitSize >= 8) putRaw(f, 0xff);
      else put(f, f.max >= 255 ? 255 : 0);
    } else if (f.usage === PID.AXES_ENABLE) put(f, 1);
    else if (f.usage === PID.DIRECTION_ENABLE) put(f, profile.directionEnable === "always" || !hasAxesMask ? 1 : 0);
    else if (isAxisFlag(f)) put(f, profile.axisFlags === "x" && axisFlags++ === 0 ? 1 : 0);
    else if (page === PAGE_ORDINAL || page === PAGE_DESKTOP || f.usage === PID.DIRECTION) {
      put(f, directions++ === 0 ? f.min + (f.max - f.min) * DIRECTION_X_FRACTION : f.min);
    }
  }
  return { reportId: set.reportId, data };
}

/** Runs a write whose failure must not stop a cleanup (the device may already be gone) */
async function bestEffort(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // device may already be gone
  }
}

/**
 * Optional hardware condition effect (damper, friction, inertia) at coefficient 0, started like the constant force.
 * Only on a wheel that hands the block out itself (Create New Effect / Block Load): a guessed block index could land on
 * one in use. Null when the wheel has none or setting it up fails; a block it did hand out is given back, unless it is
 * one already in use (`taken`).
 */
async function setupCondition(
  device: HidDeviceLike,
  layout: PidLayout,
  cond: PidReportLayout,
  deps: FfbDeps,
  profile: PidProfile,
  taken: readonly number[],
  start: number,
  loopCount: number,
  kind: ConditionKind
): Promise<number | null> {
  const effect = pidUsage(CONDITION_EFFECT[kind]);
  const forceBlock = taken[0];
  let block: number | null = null;
  try {
    block = await allocateEffect(device, layout, deps, profile, effect, kind);
    if (block === null || taken.includes(block)) return null;
    if (layout.setEffect) {
      const r = buildSetEffectReport(layout.setEffect, block, effect, profile);
      await device.sendReport(r.reportId, r.data);
    }
    await sendOutput(device, cond, conditionReportValues(cond, block, 0, CONDITION_SATURATION[kind]));
    await sendOutput(device, layout.effectOperation, {
      [PID.EFFECT_BLOCK_INDEX]: block,
      [PID.EFFECT_OPERATION]: start,
      [PID.LOOP_COUNT]: loopCount,
    });
    return block;
  } catch {
    // the constant force runs without it (effect memory full, the effect refused, a write failed)
    const freeBlock = block;
    if (freeBlock !== null && freeBlock !== forceBlock && !taken.includes(freeBlock) && layout.blockFree) {
      const free = layout.blockFree;
      await bestEffort(() => sendOutput(device, free, { [PID.EFFECT_BLOCK_INDEX]: freeBlock }));
    }
    return null;
  }
}

/** Effect Operation loop count on start */
function startLoopCount(layout: PidLayout, profile: PidProfile): number {
  const loops = getField(layout.effectOperation, PID.LOOP_COUNT);
  if (!loops) return 0;
  return profile.loopCount === "max" ? Math.min(255, loops.max) : clamp(1, loops.min, loops.max);
}

/**
 * The connect-time setup for an already granted device (factored out of {@link WebHidFfb.connect} so it can be tested
 * without navigator.hid): open, parse the PID layout, reset + enable actuators, device gain 100 %, create one Constant
 * Force effect, configure it (see {@link buildSetEffectReport}), start it at zero force; then the optional hardware
 * Damper condition effect. The wheel's {@link PidProfile} decides the values firmwares disagree on.
 */
export async function setupPidDevice(device: HidDeviceLike, options: PidSetupOptions = {}): Promise<PidSetupResult> {
  const deps = options.deps ?? defaultFfbDeps;
  const profile = pidProfileFor(device);
  const layout = options.layout ?? parsePidLayout(device.collections);
  if (!layout) return { ok: false, unsupported: true, message: NO_PID_MESSAGE };
  const forceField = getField(layout.constantForce, PID.MAGNITUDE);
  const startValue = getField(layout.effectOperation, PID.EFFECT_OPERATION);
  const start = startValue ? selectorValue(startValue, PID.OP_EFFECT_START) : null;
  if (!forceField || start === null) {
    return { ok: false, unsupported: true, message: "The wheel's force-feedback reports are not usable (no magnitude or start command)" };
  }

  // What a failure part-way through has to undo
  let actuatorsOn = false;
  let allocated: number | null = null;
  try {
    if (!device.opened) await device.open();
    if (await deviceControl(device, layout, PID.DC_DEVICE_RESET)) await deps.sleep(profile.resetSleepMs);
    if (profile.stopAllAfterReset) await deviceControl(device, layout, PID.DC_STOP_ALL_EFFECTS);
    actuatorsOn = true;
    await deviceControl(device, layout, PID.DC_ENABLE_ACTUATORS);
    // Read once, as hid-pidff (pidff_fetch_pool) and DirectInput do before they create effects; a wheel that refuses it
    // is set up all the same
    const pool = layout.pool;
    if (pool) await bestEffort(() => device.receiveFeatureReport(pool.reportId));

    if (layout.deviceGain) {
      const g = getField(layout.deviceGain, PID.DEVICE_GAIN);
      if (g) await sendOutput(device, layout.deviceGain, { [PID.DEVICE_GAIN]: g.max });
    }

    const blockIndex = (await allocateEffect(device, layout, deps, profile, PID.ET_CONSTANT_FORCE, "constant force")) ?? 1;
    allocated = blockIndex;

    const set = layout.setEffect;
    if (set) {
      const r = buildSetEffectReport(set, blockIndex, PID.ET_CONSTANT_FORCE, profile);
      await device.sendReport(r.reportId, r.data);
    }

    await sendOutput(device, layout.constantForce, {
      [PID.EFFECT_BLOCK_INDEX]: blockIndex,
      [PID.MAGNITUDE]: forceToRaw(forceField, 0),
    });
    const loopCount = startLoopCount(layout, profile);
    await sendOutput(device, layout.effectOperation, {
      [PID.EFFECT_BLOCK_INDEX]: blockIndex,
      [PID.EFFECT_OPERATION]: start,
      [PID.LOOP_COUNT]: loopCount,
    });

    const cond = layout.setCondition;
    const conditionBlocks: PidSession["conditionBlocks"] = [];
    const requestedConditions = [...new Set(options.conditions ?? [])];
    if (cond) {
      for (const kind of ["damper", ...requestedConditions] as ConditionKind[]) {
        if (!layout.conditions.includes(kind)) continue;
        const taken = [blockIndex, ...conditionBlocks.map((c) => c.blockIndex)];
        const block = await setupCondition(device, layout, cond, deps, profile, taken, start, loopCount, kind);
        if (block !== null) conditionBlocks.push({ kind, blockIndex: block });
      }
    }
    const damperBlockIndex = conditionBlocks.find((c) => c.kind === "damper")?.blockIndex ?? null;

    const writer = new ForceWriter(
      forceField,
      (raw) => sendOutput(device, layout.constantForce, { [PID.EFFECT_BLOCK_INDEX]: blockIndex, [PID.MAGNITUDE]: raw }),
      deps,
      options.onFail
    );
    const session: PidSession = {
      kind: "pid",
      device,
      layout,
      blockIndex,
      damperBlockIndex,
      conditionBlocks,
      setCondition: {},
      requestedConditions,
      writer,
    };
    for (const { kind, blockIndex: block } of conditionBlocks) {
      if (!cond) break;
      session.setCondition[kind] = writer.addChannel({
        toRaw: (c) => Math.round(clamp(Number.isFinite(c) ? c : 0, 0, 1) * 1000),
        threshold: 25,
        zeroRaw: 0,
        initialRaw: 0,
        // The coefficient is scaled by the same cap as the saturation, so the whole 0..1 range does something on a
        // firmware that reads friction as the coefficient clipped at the saturation (the damper's cap is 1)
        send: (raw) =>
          sendOutput(device, cond, conditionReportValues(cond, block, (raw / 1000) * CONDITION_SATURATION[kind], CONDITION_SATURATION[kind])),
      });
    }
    session.setDamper = session.setCondition.damper;
    return { ok: true, session };
  } catch (e) {
    // As in teardownPidSession: never leave the motor armed or an effect block held after a failed setup
    if (allocated !== null && layout.blockFree) {
      const block = allocated;
      await bestEffort(() => sendOutput(device, layout.blockFree as PidReportLayout, { [PID.EFFECT_BLOCK_INDEX]: block }));
    }
    if (actuatorsOn) {
      await bestEffort(() => deviceControl(device, layout, PID.DC_STOP_ALL_EFFECTS));
      await bestEffort(() => deviceControl(device, layout, PID.DC_DISABLE_ACTUATORS));
    }
    return { ok: false, unsupported: false, message: errorMessage(e) };
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Classic Logitech wheels                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/*
 * The commands are those of Linux drivers/hid/hid-lg4ff.c, the outside source for every byte below; the function
 * named on each one is the kernel function that sends the same bytes. None of it has been checked on a wheel.
 */

/** lg4ff_play, FF_CONSTANT: level 0x80 is no force and switches slot 1 off; any other level plays in slot 1 */
function lg4ffConstantForce(level: number): number[] {
  return level === 0x80 ? [0x13, 0, 0, 0, 0, 0, 0] : [0x11, 0x08, level, 0x80, 0, 0, 0];
}

/** lg4ff_set_range_g25 (G25, G27, DFGT, G29) */
function lg4ffRange(deg: number): number[] {
  return [0xf8, 0x81, deg & 0xff, (deg >> 8) & 0xff, 0, 0, 0];
}

/** lg4ff_set_leds (G27, G29): bit 0 lights RPM1 … bit 4 RPM5 */
function lg4ffLeds(mask: number): number[] {
  return [0xf8, 0x12, mask & 0x1f, 0, 0, 0, 0];
}

/** lg4ff_set_autocenter_default for a non-MOMO wheel: 0 switches the centring spring off, else its parameters then on */
function lg4ffAutocenter(magnitude: number): number[][] {
  if (magnitude === 0) return [[0xf5, 0, 0, 0, 0, 0, 0]];
  let a: number;
  let b: number;
  if (magnitude <= 0xaaaa) {
    a = 0x0c * magnitude;
    b = 0x80 * magnitude;
  } else {
    a = 0x0c * 0xaaaa + 0x06 * (magnitude - 0xaaaa);
    b = 0x80 * 0xaaaa + 0xff * (magnitude - 0xaaaa);
  }
  a >>= 1;
  const k = Math.floor(a / 0xaaaa) & 0xff;
  return [
    [0xfe, 0x0d, k, k, Math.floor(b / 0xaaaa) & 0xff, 0, 0],
    [0x14, 0, 0, 0, 0, 0, 0],
  ];
}

/**
 * Centring spring strength (FF_AUTOCENTER magnitude, 0..0xffff) put back when the page lets go of the wheel, so it is
 * not left limp. Full strength; whether that matches the spring the wheel powers up with is not known.
 */
const LG4FF_AUTOCENTER_ON_RELEASE = 0xffff;

/**
 * Force level byte: −1..1 over 0..255, 0 → 0x80. Sign: `setForce` takes a PID magnitude along +X (90°). Linux plays
 * such an effect on these wheels as + level (ml_combine_effects in ff-memless.c: sin(direction) x level, + at 0x4000)
 * and lg4ff_play adds 0x80, while hid-pidff hands the same direction to a PID wheel unchanged
 * (pidff_set_effect_direction); so + force → level above 0x80 here. Unverified on a wheel: Test direction / Invert.
 */
const LG4FF_FORCE_FIELD: PidFieldLayout = { bitOffset: 0, bitSize: 8, min: 0, max: 255, signed: false };

/**
 * The output report lg4ff writes: the device's first one, which must carry 7 values (lg4ff_init checks it with
 * hid_validate_values(hid, HID_OUTPUT_REPORT, 0, 0, 7)). Null on an interface without it.
 */
function lg4ffOutputReport(collections: readonly HidCollectionLike[]): { reportId: number; bytes: number } | null {
  const first = gatherReports(collections, "outputReports").entries().next();
  if (first.done) return null;
  const [reportId, { bits }] = first.value;
  return bits >= 7 * 8 ? { reportId, bytes: Math.ceil(bits / 8) } : null;
}

/** A range lg4ff_range_store would apply; null for anything else (the wheel keeps its own range) */
function lg4ffRangeDeg(deg: number | null | undefined): number | null {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return null;
  const r = Math.round(deg);
  return r >= LG4FF_MIN_RANGE_DEG && r <= LG4FF_MAX_RANGE_DEG ? r : null;
}

export interface LogitechClassicSetupOptions extends PidSetupOptions {
  /** Rotation to set, lock to lock (deg); null or outside 40..900 leaves the wheel's own range */
  rotationDeg?: number | null;
}

/**
 * Connect-time setup of a listed classic Logitech wheel, in lg4ff_init's order: centring spring off
 * (lg4ff_set_autocenter_default with 0), then the range. No force is sent until the game sends one.
 */
export async function setupLogitechClassicDevice(
  device: HidDeviceLike,
  model: LogitechClassicModel,
  options: LogitechClassicSetupOptions = {}
): Promise<SetupResult<LogitechClassicSession>> {
  const deps = options.deps ?? defaultFfbDeps;
  const report = lg4ffOutputReport(device.collections);
  if (!report) {
    return { ok: false, unsupported: true, message: `This ${model.name} interface has no 7-byte output report for force feedback` };
  }
  const send = (bytes: readonly number[]) => {
    const data = new Uint8Array(report.bytes);
    for (let i = 0; i < bytes.length && i < data.length; i++) data[i] = (bytes[i] as number) & 0xff;
    return device.sendReport(report.reportId, data);
  };
  let springOff = false;
  try {
    if (!device.opened) await device.open();
    for (const r of lg4ffAutocenter(0)) await send(r);
    springOff = true;
    const range = lg4ffRangeDeg(options.rotationDeg);
    if (range !== null) await send(lg4ffRange(range));
    const writer = new ForceWriter(LG4FF_FORCE_FIELD, (level) => send(lg4ffConstantForce(level)), deps, options.onFail);
    const session: LogitechClassicSession = {
      kind: "logitech-classic",
      device,
      model,
      writer,
      send,
      rangeChanged: range !== null,
      setRange: () => {},
    };
    const queueRange = writer.addChannel({
      toRaw: (deg) => deg,
      threshold: 1,
      initialRaw: range,
      send: (deg) => {
        session.rangeChanged = true;
        return send(lg4ffRange(deg));
      },
    });
    session.setRange = (deg) => {
      const r = lg4ffRangeDeg(deg);
      if (r !== null) queueRange(r);
    };
    if (model.revLeds) {
      // What the LEDs show before the first value is not known (another program may have left them lit): it always goes out
      session.setLeds = writer.addChannel({
        toRaw: (mask) => (Number.isFinite(mask) ? Math.round(mask) & 0x1f : 0),
        threshold: 1,
        zeroRaw: 0,
        initialRaw: null,
        send: (mask) => send(lg4ffLeds(mask)),
      });
    }
    return { ok: true, session };
  } catch (e) {
    if (springOff) for (const r of lg4ffAutocenter(LG4FF_AUTOCENTER_ON_RELEASE)) await bestEffort(() => send(r));
    return { ok: false, unsupported: false, message: errorMessage(e) };
  }
}

/**
 * What a classic Logitech wheel gets when the page lets go of it (teardown, emergency stop): force off, the range back
 * to 900° if it was changed, centring spring on
 */
function lg4ffReleaseCommands(session: LogitechClassicSession): number[][] {
  return [
    lg4ffConstantForce(0x80),
    ...(session.model.revLeds ? [lg4ffLeds(0)] : []),
    ...(session.rangeChanged ? [lg4ffRange(LG4FF_MAX_RANGE_DEG)] : []),
    ...lg4ffAutocenter(LG4FF_AUTOCENTER_ON_RELEASE),
  ];
}

/**
 * Best-effort shutdown: force off, rev LEDs off (G27, G29), the range back to 900° if it was changed, centring spring
 * on. Never throws.
 */
export async function teardownLogitechClassicSession(session: LogitechClassicSession): Promise<void> {
  await session.writer.close();
  for (const bytes of lg4ffReleaseCommands(session)) await bestEffort(() => session.send(bytes));
}

export function teardownSession(session: FfbSession): Promise<void> {
  if (session.kind === "pid") return teardownPidSession(session);
  if (session.kind === "logitech-hidpp") return teardownLogitechHidppSession(session);
  if (session.kind === "thrustmaster") return teardownThrustmasterSession(session);
  return teardownLogitechClassicSession(session);
}

/** Best-effort shutdown: zero force, stop the effects, free them, stop all, disable actuators. Never throws. */
export async function teardownPidSession(session: PidSession): Promise<void> {
  await session.writer.close();
  const { device, layout, blockIndex, conditionBlocks } = session;
  const attempt = bestEffort;
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
    for (const c of conditionBlocks) {
      await attempt(() =>
        sendOutput(device, layout.effectOperation, { [PID.EFFECT_BLOCK_INDEX]: c.blockIndex, [PID.EFFECT_OPERATION]: stop })
      );
    }
  }
  if (layout.blockFree) {
    await attempt(() => sendOutput(device, layout.blockFree as PidReportLayout, { [PID.EFFECT_BLOCK_INDEX]: blockIndex }));
    for (const c of conditionBlocks) {
      await attempt(() => sendOutput(device, layout.blockFree as PidReportLayout, { [PID.EFFECT_BLOCK_INDEX]: c.blockIndex }));
    }
  }
  await attempt(() => deviceControl(device, layout, PID.DC_STOP_ALL_EFFECTS));
  await attempt(() => deviceControl(device, layout, PID.DC_DISABLE_ACTUATORS));
}

/** Hands a write to the browser and forgets it: nothing is awaited, and a throw does not stop the writes after it */
function fireAndForget(send: () => Promise<unknown>): void {
  try {
    send().catch(() => {});
  } catch {
    // device already gone
  }
}

/**
 * The page is going away (pagehide): every stop command is handed to the browser at once, in order, without waiting
 * for any of them, since no later promise may get to run. The writer is killed first, so nothing it queued goes out
 * after them. A PID wheel gets zero force, the hardware damper's coefficient 0 and Stop All Effects (no block is freed:
 * the next setup resets the wheel); a classic Logitech wheel what {@link teardownLogitechClassicSession} sends; a HID++
 * wheel what teardownLogitechHidppSession sends, without waiting for the replies; a Thrustmaster base what
 * teardownThrustmasterSession sends (level 0, stop, range back, close).
 */
export function emergencyStopSession(session: FfbSession): void {
  session.writer.kill();
  if (session.kind === "logitech-classic") {
    for (const bytes of lg4ffReleaseCommands(session)) fireAndForget(() => session.send(bytes));
    return;
  }
  if (session.kind === "logitech-hidpp") {
    emergencyStopLogitechHidppSession(session);
    return;
  }
  if (session.kind === "thrustmaster") {
    for (const c of thrustmasterReleaseCommands(session)) fireAndForget(() => session.send(c));
    return;
  }
  const { device, layout, blockIndex, conditionBlocks } = session;
  const mag = getField(layout.constantForce, PID.MAGNITUDE);
  if (mag) {
    fireAndForget(() =>
      sendOutput(device, layout.constantForce, { [PID.EFFECT_BLOCK_INDEX]: blockIndex, [PID.MAGNITUDE]: forceToRaw(mag, 0) })
    );
  }
  const cond = layout.setCondition;
  for (const { kind, blockIndex: block } of cond ? conditionBlocks : []) {
    fireAndForget(() => sendOutput(device, cond as PidReportLayout, conditionReportValues(cond as PidReportLayout, block, 0, CONDITION_SATURATION[kind])));
  }
  // deviceControl sends before its first await, so the report is handed over here
  fireAndForget(() => deviceControl(device, layout, PID.DC_STOP_ALL_EFFECTS));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Diagnostics                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** Setup / teardown traffic remembered for {@link WebHidFfb.diagnose} */
export const HID_TRACE_SIZE = 60;

const hex = (n: number, width = 2) => n.toString(16).padStart(width, "0");
const hexBytes = (bytes: ArrayLike<number>, max = 64) => {
  const out: string[] = [];
  for (let i = 0; i < Math.min(bytes.length, max); i++) out.push(hex(bytes[i] as number));
  return out.join(" ") + (bytes.length > max ? ` … (${bytes.length} bytes)` : "");
};

/**
 * The last {@link HID_TRACE_SIZE} reports written to (and Block Load replies read from) the wheel while `recording`,
 * which the driver switches on for setup and teardown only: the 500 Hz force stream is never kept
 */
export class HidTrace {
  recording = false;
  private readonly lines: string[] = [];
  private readonly t0: number;

  constructor(private readonly now: () => number = defaultFfbDeps.now) {
    this.t0 = now();
  }

  /** A line of the trace, prefixed with the time since the driver started (ms) */
  note(text: string): void {
    if (this.lines.length >= HID_TRACE_SIZE) this.lines.shift();
    this.lines.push(`${(this.now() - this.t0).toFixed(0).padStart(7)} ms  ${text}`);
  }

  report(kind: string, reportId: number, bytes: ArrayLike<number>): void {
    if (this.recording) this.note(`${kind.padEnd(11)} id ${String(reportId).padStart(3)}  ${hexBytes(bytes)}`);
  }

  entries(): readonly string[] {
    return this.lines;
  }
}

/**
 * `device` with every report it sends, every feature report read back and every input report its listeners get (the
 * replies of a HID++ wheel) written to `trace` while it records
 */
export function tracedDevice(device: HidDeviceLike, trace: HidTrace): HidDeviceLike {
  const failed = (kind: string, id: number) => (e: unknown) => {
    if (trace.recording) trace.note(`${kind} id ${id} FAILED: ${errorMessage(e)}`);
    throw e;
  };
  type InputListener = (e: HidInputReportEventLike) => void;
  const wrapped = new Map<InputListener, InputListener>();
  const listen = device.addEventListener?.bind(device);
  const unlisten = device.removeEventListener?.bind(device);
  const traced: HidDeviceLike = {
    get opened() {
      return device.opened;
    },
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName,
    collections: device.collections,
    open: () => device.open(),
    close: () => device.close(),
    sendReport: (id, data) => {
      trace.report("out", id, data);
      return device.sendReport(id, data).catch(failed("out", id));
    },
    sendFeatureReport: (id, data) => {
      trace.report("feature out", id, data);
      return device.sendFeatureReport(id, data).catch(failed("feature out", id));
    },
    receiveFeatureReport: (id) =>
      device.receiveFeatureReport(id).then((view) => {
        trace.report("feature in", id, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        return view;
      }, failed("feature in", id)),
  };
  if (listen) {
    traced.addEventListener = (type, listener) => {
      const w: InputListener = (e) => {
        trace.report("in", e.reportId, new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
        listener(e);
      };
      wrapped.set(listener, w);
      listen(type, w);
    };
    traced.removeEventListener = (type, listener) => {
      const w = wrapped.get(listener);
      if (!w) return;
      wrapped.delete(listener);
      unlisten?.(type, w);
    };
  }
  return traced;
}

/** Names for the usages the driver knows; anything else is shown as page:id */
const USAGE_NAMES: ReadonlyMap<number, string> = new Map<number, string>([
  ...Object.entries(PID).map(([name, usage]) => [usage, name] as [number, string]),
  [(PAGE_DESKTOP << 16) | 0x30, "X"],
  [(PAGE_DESKTOP << 16) | 0x31, "Y"],
  [(PAGE_DESKTOP << 16) | 0x32, "Z"],
  [(PAGE_DESKTOP << 16) | 0x3b, "DESKTOP_BYTE_COUNT"],
  [pidUsage(0x01), "PID_PHYSICAL_INTERFACE"],
  [pidUsage(0x02), "PID_NORMAL"],
  [pidUsage(0x21), "SET_EFFECT_REPORT"],
  [pidUsage(0x27), "ET_RAMP"],
  [pidUsage(0x28), "ET_CUSTOM_FORCE_DATA"],
  [pidUsage(0x30), "ET_SQUARE"],
  [pidUsage(0x31), "ET_SINE"],
  [pidUsage(0x32), "ET_TRIANGLE"],
  [pidUsage(0x33), "ET_SAWTOOTH_UP"],
  [pidUsage(0x34), "ET_SAWTOOTH_DOWN"],
  [pidUsage(0x40), "ET_SPRING"],
  [pidUsage(0x42), "ET_INERTIA"],
  [pidUsage(0x43), "ET_FRICTION"],
  [pidUsage(0x6f), "OFFSET"],
  [pidUsage(0x71), "PHASE"],
  [pidUsage(0x72), "PERIOD"],
  [pidUsage(0xad), "RAM_POOL_AVAILABLE"],
]);

function usageName(usage: number): string {
  const page = usage >>> 16;
  const id = usage & 0xffff;
  const known = USAGE_NAMES.get(usage);
  if (known) return known;
  if (page === PAGE_ORDINAL) return `ORDINAL_${id}`;
  return `${hex(page, 4)}:${hex(id, 4)}`;
}

function describeItem(item: HidReportItemLike): string {
  const usages = expandUsages(item);
  const list =
    item.isRange && typeof item.usageMinimum === "number" && typeof item.usageMaximum === "number"
      ? `${usageName(item.usageMinimum)}..${usageName(item.usageMaximum)}`
      : usages.length > 6
        ? `${usages.slice(0, 6).map(usageName).join(", ")}, … (${usages.length})`
        : usages.map(usageName).join(", ") || "(no usage)";
  const kind = item.isConstant ? "constant" : item.isArray ? "array" : "variable";
  return `${item.reportSize ?? 0} bit x ${item.reportCount ?? 0}, ${kind}, logical ${item.logicalMinimum ?? "?"}..${item.logicalMaximum ?? "?"}: ${list}`;
}

function describeCollections(collections: readonly HidCollectionLike[], depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  for (const c of collections) {
    out.push(`${pad}collection ${hex(c.usagePage ?? 0, 4)}:${hex(c.usage ?? 0, 4)} type ${c.type ?? "?"}`);
    for (const [kind, reports] of [
      ["input", c.inputReports],
      ["output", c.outputReports],
      ["feature", c.featureReports],
    ] as const) {
      for (const r of reports ?? []) {
        const items = r.items ?? [];
        const bits = items.reduce((sum, i) => sum + Math.max(0, i.reportSize ?? 0) * Math.max(0, i.reportCount ?? 0), 0);
        out.push(`${pad}  ${kind} report ${r.reportId ?? 0} (${bits} bits)`);
        for (const item of items) out.push(`${pad}    ${describeItem(item)}`);
      }
    }
    describeCollections(c.children ?? [], depth + 1, out);
  }
}

const PID_REPORT_NAMES: readonly [keyof PidLayout, string][] = [
  ["setEffect", "Set Effect"],
  ["constantForce", "Set Constant Force"],
  ["effectOperation", "Effect Operation"],
  ["setCondition", "Set Condition"],
  ["blockFree", "PID Block Free"],
  ["deviceControl", "PID Device Control"],
  ["deviceGain", "Device Gain"],
  ["createNewEffect", "Create New Effect"],
  ["blockLoad", "PID Block Load"],
  ["pool", "PID Pool"],
];

function describeField(f: PidFieldEntry): string {
  const range = `${f.min}..${f.max}${f.signed ? " signed" : ""}`;
  // Only array (selector) fields carry a usage list
  const selects = f.usages ? ` selects ${f.usages.map(usageName).join(", ")}` : "";
  return `${usageName(f.usage).padEnd(24)} bit ${String(f.bitOffset).padStart(3)}, ${f.bitSize} bits, ${range}${selects}`;
}

/** Which driver path a device without a usable HID PID layout takes, for {@link describeHidDevice} */
function describeNonPid(device: HidDeviceLike): string {
  const model = logitechClassicModel(device.vendorId, device.productId);
  if (model) {
    const report = lg4ffOutputReport(device.collections);
    return report
      ? `HID PID: none. Logitech ${model.name}: driven with the hid-lg4ff commands on output report ${report.reportId} (${report.bytes} bytes)`
      : `HID PID: none. Logitech ${model.name}, but this interface has no 7-byte output report for the hid-lg4ff commands`;
  }
  const hidpp = logitechHidppModel(device.vendorId, device.productId);
  if (hidpp) return describeLogitechHidppInterface(device, hidpp);
  if (device.vendorId === LOGITECH_VENDOR_ID) return `HID PID: none. ${LOGITECH_MESSAGE}`;
  const tm = thrustmasterModel(device.vendorId, device.productId);
  if (tm) {
    return thrustmasterInterfaceFits(device.collections, tm)
      ? `HID PID: none. Thrustmaster ${tm.name}: driven with the hid-tmff2 commands as report 0x${hex(TMFF2_REPORT_ID)} (${tm.reportBytes} bytes)`
      : `HID PID: none. Thrustmaster ${tm.name}, but this interface has no ${tm.reportBytes}-byte output report for the hid-tmff2 commands`;
  }
  if (device.vendorId === THRUSTMASTER_VENDOR_ID) return `HID PID: none. ${thrustmasterRefusal(device)}`;
  return "HID PID: no usable Set Constant Force + Effect Operation report";
}

/**
 * Everything the driver knows about a device, as text for a bug report: ids and name, the raw report descriptor
 * (collections, reports, items), then the HID PID reports as {@link parsePidLayout} reads them and the firmware
 * profile, or which other path it takes (a listed classic or HID++ Logitech wheel) or why there is none
 */
export function describeHidDevice(device: HidDeviceLike): string {
  const out: string[] = [];
  out.push(`${deviceName(device)}  [${hex(device.vendorId, 4)}:${hex(device.productId, 4)}]${device.opened ? "  (open)" : ""}`);
  out.push("Report descriptor:");
  describeCollections(device.collections, 1, out);
  const layout = parsePidLayout(device.collections);
  if (!layout) {
    out.push(describeNonPid(device));
    return out.join("\n");
  }
  out.push(`PID profile: ${pidProfileName(device)}`);
  out.push(
    platformUsageOrder() === "unordered"
      ? "Selector order: the PID spec's (this browser lists array usages in no fixed order)"
      : "Selector order: the report descriptor's"
  );
  out.push("HID PID reports:");
  for (const [key, name] of PID_REPORT_NAMES) {
    const r = layout[key] as PidReportLayout | null | undefined;
    if (!r) {
      out.push(`  ${name}: MISSING`);
      continue;
    }
    out.push(`  ${name}: report ${r.reportId}, ${r.bitLength} bits`);
    for (const f of r.fieldList ?? []) out.push(`    ${describeField(f)}`);
  }
  const types = layout.setEffect ? (getField(layout.setEffect, PID.EFFECT_TYPE)?.usages ?? []) : [];
  out.push(`Effect types: ${types.length > 0 ? types.map(usageName).join(", ") : "(no Set Effect type list)"}`);
  out.push(`Hardware damper: ${layout.hasDamper ? "yes (Damper effect type and a Set Condition report)" : "no"}`);
  out.push(`Condition effects this driver can run: ${layout.conditions.length > 0 ? layout.conditions.join(", ") : "none"}`);
  return out.join("\n");
}

/** One line on the running session, either kind, for {@link WebHidFfb.diagnose} and the trace */
function describeSession(session: FfbSession): string {
  if (session.kind === "pid") {
    return (
      `pid driver, constant force on effect block ${session.blockIndex}, ` +
      `hardware damper ${session.damperBlockIndex !== null ? `on block ${session.damperBlockIndex}` : "none"}` +
      session.conditionBlocks
        .filter((c) => c.kind !== "damper")
        .map((c) => `, ${c.kind} on block ${c.blockIndex}`)
        .join("") +
      (session.requestedConditions.length > 0 ? ` (asked for: ${session.requestedConditions.join(", ")})` : "")
    );
  }
  if (session.kind === "logitech-hidpp") return describeLogitechHidppSession(session);
  const range = session.rangeChanged ? "range set from the wheel rotation setting" : "the wheel's own range";
  if (session.kind === "thrustmaster") return `thrustmaster driver (hid-tmff2 commands), ${session.model.name}, ${range}`;
  return `logitech-classic driver (hid-lg4ff), ${session.model.name}, ${range}`;
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

/**
 * The picker lists joysticks, gamepads, multi-axis controllers and PID devices, plus every interface of a listed HID++
 * wheel by its ids: its HID++ reports may sit on a vendor-defined collection no usage filter names
 */
const REQUEST_FILTERS = [
  { usagePage: 0x01, usage: 0x04 },
  { usagePage: 0x01, usage: 0x05 },
  { usagePage: 0x01, usage: 0x08 },
  { usagePage: 0x0f },
  ...LOGITECH_HIDPP_WHEELS.map((m) => ({ vendorId: LOGITECH_VENDOR_ID, productId: m.productId })),
];
const UNSUPPORTED_BROWSER = "WebHID needs Chrome or Edge on https or localhost";
/** Status message when the page loads with WebHID on but no wheel was granted to it yet (pairing needs a click) */
export const PAIR_MESSAGE = "Click Connect to pair your wheel";
const LOGITECH_MESSAGE = `Only the Logitech ${LOGITECH_WEBHID_NAMES} take force feedback from the browser; use the native FFB bridge for this wheel`;
const THRUSTMASTER_MESSAGE = `Only the Thrustmaster ${THRUSTMASTER_NAMES} take force feedback from the browser; use the native FFB bridge for this wheel`;

/** Why a Thrustmaster device that is not in THRUSTMASTER_WHEELS is refused */
function thrustmasterRefusal(device: HidDeviceLike): string {
  if (!THRUSTMASTER_STARTUP_PRODUCT_IDS.includes(device.productId)) return THRUSTMASTER_MESSAGE;
  return (
    `This Thrustmaster wheel is still in its start-up mode (044f:${device.productId.toString(16).padStart(4, "0")}), ` +
    "which a driver has to switch it out of (Thrustmaster's on Windows, hid-tminit on Linux) and the browser cannot; " +
    "use the native FFB bridge for this wheel"
  );
}

/**
 * With no setForce / setDamper call for this long (hidden tab, stalled loop, the app's own stop) the driver zeroes the
 * force and the hardware damper itself. wheel-ffb.ts zeroes the force after 150 ms (HID_WATCHDOG_MS) but cannot reach
 * the damper; this one comes after it.
 */
export const IDLE_ZERO_MS = 250;
/** Wait after a granted wheel's connect event before re-opening it (ms): a multi-interface base arrives one at a time */
export const HOTPLUG_DELAY_MS = 1500;
/** Setup attempts when a granted wheel is re-opened (page load, power-cycle): one just switched on may refuse at first */
export const SETUP_ATTEMPTS = 5;
/** Wait between those attempts (ms) */
export const SETUP_RETRY_MS = 2000;

/** A device this driver can drive, and how (the PID layout is parsed once, here) */
type FfbPick =
  | { kind: "pid"; device: HidDeviceLike; layout: PidLayout }
  | { kind: "logitech-classic"; device: HidDeviceLike; model: LogitechClassicModel }
  | { kind: "logitech-hidpp"; device: HidDeviceLike; model: LogitechHidppModel }
  | { kind: "thrustmaster"; device: HidDeviceLike; model: ThrustmasterModel };

/**
 * The interface to drive among the HIDDevices a pick or a grant returned (a wheel may list an input-only interface
 * next to its force-feedback one): the first with a HID PID layout, else the first listed classic Logitech wheel with
 * lg4ff's output report, else the first listed HID++ wheel interface with a HID++ long report, else the first listed
 * Thrustmaster base with an output report long enough for its commands. Null when there is none, e.g. only a
 * DualSense, a gamepad, an unlisted Logitech wheel or a T150.
 */
function pickFfbDevice(devices: readonly HidDeviceLike[]): FfbPick | null {
  for (const device of devices) {
    const layout = parsePidLayout(device.collections);
    if (layout) return { kind: "pid", device, layout };
  }
  for (const device of devices) {
    const model = logitechClassicModel(device.vendorId, device.productId);
    if (model && lg4ffOutputReport(device.collections)) return { kind: "logitech-classic", device, model };
  }
  for (const device of devices) {
    const model = logitechHidppModel(device.vendorId, device.productId);
    if (model && hidppReports(device.collections)) return { kind: "logitech-hidpp", device, model };
  }
  for (const device of devices) {
    const model = thrustmasterModel(device.vendorId, device.productId);
    if (model && thrustmasterInterfaceFits(device.collections, model)) return { kind: "thrustmaster", device, model };
  }
  return null;
}

/** Why a picked device cannot be driven */
function unsupportedMessage(device: HidDeviceLike): string {
  const model = logitechClassicModel(device.vendorId, device.productId);
  if (model) return `This ${model.name} interface has no 7-byte output report for force feedback`;
  const hidpp = logitechHidppModel(device.vendorId, device.productId);
  if (hidpp) return `This ${hidpp.name} interface has no HID++ long report (output report 0x11) for force feedback`;
  if (device.vendorId === LOGITECH_VENDOR_ID) return LOGITECH_MESSAGE;
  const tm = thrustmasterModel(device.vendorId, device.productId);
  if (tm) return `This ${tm.name} interface has no ${tm.reportBytes}-byte output report for force feedback`;
  if (device.vendorId === THRUSTMASTER_VENDOR_ID) return thrustmasterRefusal(device);
  return NO_PID_MESSAGE;
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

  private session: FfbSession | null = null;
  private device: HidDeviceLike | null = null;
  private busy: Promise<string | null> | null = null;
  private busyClosing = false;
  private listening: HidApiLike | null = null;
  private listeners = new Set<() => void>();
  private lastDriveMs = 0;
  private idleTimer: unknown = null;
  private rotationDeg: number | null = null;
  /** Friction / inertia the player has switched on: set up with the wheel (see {@link setWantedConditions}) */
  private wantedConditions: OptionalConditionKind[] = [];
  /**
   * Condition effects the wheel set up last offers and can allocate (Create New Effect / Block Load). Kept while that
   * wheel is set up again, so the settings that drive them stay on screen through it
   */
  private offeredConditions: ConditionKind[] = [];
  /**
   * From reconnect() (or a connect() whose picker returned a wheel) until dispose(): a granted wheel that comes back
   * is re-opened. A cancelled picker arms nothing.
   */
  private wanted = false;
  /** dispose() calls so far: a picker that resolves after one does not arm `wanted` again */
  private disposals = 0;
  /**
   * A session let go of outside any operation (a fatal write failure) while its teardown still runs: every later
   * release waits for that teardown first, so no setup reaches the device under it
   */
  private dropping: { session: FfbSession | null; done: Promise<void> } | null = null;
  private hotplugApi: HidApiLike | null = null;
  private hotplugTimer: unknown = null;
  /** Ends the wait between setup attempts early (dispose) */
  private wakeRetry: (() => void) | null = null;
  /** Setup / teardown traffic and status changes, for {@link diagnose} */
  private readonly trace: HidTrace;
  /** The device last set up (or tried), kept after a failure so diagnose() can describe it */
  private lastDevice: HidDeviceLike | null = null;

  /** `hid` and `deps` exist for tests; the app uses the defaults */
  constructor(
    private readonly hidOverride?: HidApiLike,
    private readonly deps: FfbDeps = defaultFfbDeps
  ) {
    this.status = this.hidApi()
      ? { state: "idle", device: null, message: null }
      : { state: "unsupported", device: null, message: UNSUPPORTED_BROWSER };
    this.trace = new HidTrace(deps.now);
  }

  /**
   * Must be called straight from a user gesture (the click handler itself): requestDevice is called before anything
   * is awaited, since the prompt needs the click's user activation. Opens the picked wheel and sets the effect up.
   * Resolves to the device name, or null when nothing was picked or setup failed (see `status`). Cancelling the
   * picker, or a picker that fails (a second Connect while one is open), keeps a wheel that is already running. A
   * failed setup is reported at once, not retried. Only a chosen wheel arms the re-open on hotplug (see `wanted`).
   */
  connect(): Promise<string | null> {
    const hid = this.hidApi();
    if (!hid) return Promise.resolve(this.fail("unsupported", null, UNSUPPORTED_BROWSER));
    // A dispose() while the picker is open wins: the wheel picked afterwards is set up, then let go, never re-armed
    const disposals = this.disposals;
    let picking: Promise<{ devices: HidDeviceLike[] } | { error: string }>;
    try {
      picking = hid.requestDevice({ filters: REQUEST_FILTERS }).then(
        (devices) => ({ devices }),
        (e: unknown) => ({ error: errorMessage(e) })
      );
    } catch (e) {
      picking = Promise.resolve({ error: errorMessage(e) });
    }
    // Queued behind any reconnect in flight rather than swallowed by it: the picker is already open
    return this.guard(async () => {
      const picked = await picking;
      if ("error" in picked) {
        if (this.session && this.device) return deviceName(this.device);
        await this.release();
        return this.fail("error", null, picked.error);
      }
      const first = picked.devices[0];
      if (!first) {
        if (this.session && this.device) return deviceName(this.device);
        this.setStatus("idle", null, "No wheel was selected");
        return null;
      }
      if (this.disposals === disposals) this.want(hid);
      const pick = pickFfbDevice(picked.devices);
      await this.release();
      if (!pick) return this.fail("unsupported", deviceName(first), unsupportedMessage(first));
      return this.attach(hid, pick);
    }, true);
  }

  /**
   * Re-opens a wheel the user granted earlier, without a prompt (page load, the wheel switched back on); null when
   * there is none, with the status asking for a Connect click ({@link PAIR_MESSAGE}). Only a device
   * {@link pickFfbDevice} accepts is opened: any other granted device (a DualSense, an unlisted Logitech) leaves the driver
   * idle, not failed. Never shows the picker. A running wheel is kept. A setup that fails (not an unsupported wheel) is
   * tried {@link SETUP_ATTEMPTS} times, staying "connecting" in between, since a base that was just powered on may not
   * take it yet.
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
      const pick = pickFfbDevice(devices);
      if (!pick) {
        this.setStatus("idle", null, PAIR_MESSAGE);
        return null;
      }
      await this.release();
      return this.setUpWithRetries(hid, pick);
    });
  }

  /**
   * Sets a picked wheel up, staying "connecting" between up to {@link SETUP_ATTEMPTS} tries (a base just switched on may
   * refuse at first); an unsupported wheel is not retried. Inside an operation ({@link guard})
   */
  private async setUpWithRetries(hid: HidApiLike, pick: FfbPick): Promise<string | null> {
    const name = deviceName(pick.device);
    this.setStatus("connecting", name, null);
    for (let attempt = 1; ; attempt++) {
      const result = await this.setUp(hid, pick);
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
  }

  /**
   * PID magnitude −1..1 (+ pushes the rim left, − right; see the sign convention above). Cheap to call every frame:
   * writes are spaced by at least 2 ms, one in flight at a time, always carrying the latest value.
   */
  setForce(force: number): void {
    this.session?.writer.setForce(force);
    this.noteDrive();
  }

  /** Whether the connected wheel runs a hardware PID Damper condition effect */
  hasHardwareDamper(): boolean {
    return Boolean(this.session?.setDamper);
  }

  /** Hardware damper coefficient 0..1; ignored without one. Changes under 0.025 are not sent */
  setDamper(coeff: number): void {
    this.session?.setDamper?.(coeff);
    this.noteDrive();
  }

  /**
   * Whether the wheel set up last offers this condition effect and hands out effect blocks for it (whether or not it
   * runs yet); stays true while that wheel is set up again
   */
  offersCondition(kind: ConditionKind): boolean {
    return this.offeredConditions.includes(kind);
  }

  /** Whether this condition effect runs on the connected wheel */
  hasHardwareCondition(kind: ConditionKind): boolean {
    return this.session?.kind === "pid" && Boolean(this.session.setCondition[kind]);
  }

  /** Coefficient 0..1 of a running condition effect (see {@link CONDITION_SATURATION}); ignored without it */
  setCondition(kind: ConditionKind, coeff: number): void {
    if (this.session?.kind === "pid") this.session.setCondition[kind]?.(coeff);
    this.noteDrive();
  }

  /**
   * Which optional condition effects the player has switched on (a settings change, not a per-frame call). A wheel
   * sets one up only when asked, so the setup of a wheel nobody tuned stays as it was; one switched on while the wheel
   * runs, which the wheel offers and this session was not set up with, sets the wheel up again with it.
   */
  setWantedConditions(want: Partial<Record<OptionalConditionKind, boolean>>): void {
    const next = (["friction", "inertia"] as const).filter((k) => want[k] === true);
    this.wantedConditions = next;
    const s = this.session;
    if (s?.kind !== "pid") return;
    if (next.some((k) => this.offeredConditions.includes(k) && !s.requestedConditions.includes(k))) void this.resetup();
  }

  /** Whether the connected wheel has rev LEDs this driver can set (a classic Logitech G27 or G29) */
  hasRevLeds(): boolean {
    return this.session?.kind === "logitech-classic" && Boolean(this.session.setLeds);
  }

  /** Rev LED mask, bit 0 = RPM1 … bit 4 = RPM5; ignored without them. Only a change is written */
  setRevLeds(mask: number): void {
    if (this.session?.kind === "logitech-classic") this.session.setLeds?.(mask);
    this.noteDrive();
  }

  /**
   * The wheel rotation setting, lock to lock (deg). A classic Logitech wheel is set to it when it connects and when it
   * changes (40..900°; anything else leaves the wheel's own range), a HID++ wheel too (clamped to 180..900°), and a
   * Thrustmaster base, clamped to its range as hid-tmff2 clamps it; a PID wheel ignores it.
   */
  setRotationDeg(deg: number): void {
    this.rotationDeg = Number.isFinite(deg) ? deg : null;
    const s = this.session;
    if (this.rotationDeg !== null && (s?.kind === "logitech-classic" || s?.kind === "logitech-hidpp" || s?.kind === "thrustmaster")) {
      s.setRange(this.rotationDeg);
    }
  }

  /** Zero force and the hardware condition effects, rev LEDs off, now (pause menu) */
  stop(): void {
    const s = this.session;
    s?.writer.setForce(0, true);
    if (s?.kind === "pid") for (const set of Object.values(s.setCondition)) set?.(0, true);
    if (s?.kind === "logitech-classic") s.setLeds?.(0, true);
  }

  /**
   * The page is going away (pagehide): the wheel's stop commands go out at once, without waiting for anything, since
   * no later promise may get to run ({@link emergencyStopSession}: zero force, damper 0 and Stop All on a PID wheel;
   * force off, range and centring spring back on a classic Logitech). The session is dropped (the device stays
   * referenced, so the next release closes it); {@link resume} sets the wheel up again if the page comes back from
   * the back/forward cache.
   */
  emergencyStop(): void {
    const session = this.session;
    // A session still being torn down after a fatal failure gets the stop commands too (its writer is dead already)
    const dropped = this.dropping?.session ?? null;
    if (!session && !dropped) return;
    this.session = null;
    this.clearIdle();
    this.trace.note("page hidden: emergency stop");
    this.trace.recording = true;
    try {
      if (session) emergencyStopSession(session);
      if (dropped && dropped !== session) emergencyStopSession(dropped);
    } finally {
      this.trace.recording = false;
    }
    // A fatal error stays on screen; a running wheel goes idle
    if (session) this.setStatus("idle", null, null);
  }

  /** The page came back from the back/forward cache: set the wheel up again if the driver is still wanted */
  resume(): Promise<string | null> {
    return this.wanted ? this.reconnect() : Promise.resolve(null);
  }

  /**
   * A plain-text report for a bug report about a wheel: browser, driver status and session, every granted HID device
   * described in full ({@link describeHidDevice}), and the last setup / teardown reports sent ({@link HidTrace}).
   */
  async diagnose(): Promise<string> {
    const out: string[] = ["LibreCorsa WebHID force-feedback diagnostics", `Time: ${new Date().toISOString()}`];
    if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") out.push(`Browser: ${navigator.userAgent}`);
    const hid = this.hidApi();
    out.push(`WebHID: ${hid ? "available" : `unavailable (${UNSUPPORTED_BROWSER})`}`);
    const s = this.status;
    out.push(`Status: ${s.state}${s.device ? ` | ${s.device}` : ""}${s.message ? ` | ${s.message}` : ""}`);
    const ses = this.session;
    out.push(ses ? `Session: ${describeSession(ses)}` : "Session: none");
    let devices: HidDeviceLike[] = [];
    if (hid) {
      try {
        devices = await hid.getDevices();
      } catch (e) {
        out.push(`getDevices() failed: ${errorMessage(e)}`);
      }
    }
    const current = this.device ?? this.lastDevice;
    if (current && !devices.includes(current)) devices = [current, ...devices];
    const picked = pickFfbDevice(devices)?.device ?? null;
    out.push(`Granted devices: ${devices.length}${devices.length === 0 ? " (pair the wheel with Connect first)" : ""}`);
    for (const d of devices) {
      const tags = [d === current ? (ses ? "in use" : "last tried") : "", d === picked ? "the one reconnect picks" : ""].filter(Boolean);
      out.push("", `--- ${deviceName(d)}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`, describeHidDevice(d));
    }
    const lines = this.trace.entries();
    out.push("", `Setup and teardown traffic (last ${HID_TRACE_SIZE} lines; the force stream is not recorded):`);
    out.push(...(lines.length > 0 ? lines.map((l) => `  ${l}`) : ["  (none yet)"]));
    return out.join("\n");
  }

  /**
   * Stops all effects, disables actuators and closes the device (after any connect in flight). An error status is
   * kept, so the reason stays on screen once the driver is switched off because of it. A granted wheel coming back
   * afterwards is left alone.
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

  /**
   * The running wheel set up again (an optional condition effect was switched on), retried as {@link reconnect} retries
   * a wheel that refuses its setup at first
   */
  private resetup(): Promise<string | null> {
    return this.guard(async () => {
      const hid = this.hidApi();
      const device = this.device;
      if (!hid || !device || !this.session) return null;
      const pick = pickFfbDevice([device]);
      if (!pick) return null;
      this.trace.note("setting the wheel up again for a condition effect switched on");
      await this.release();
      return this.setUpWithRetries(hid, pick);
    }, true);
  }

  /** Sets the wheel up and makes it the force output; on failure the status is "error" / "unsupported" */
  private async attach(hid: HidApiLike, pick: FfbPick): Promise<string | null> {
    const r = await this.setUp(hid, pick);
    return r.ok ? r.name : this.fail(r.unsupported ? "unsupported" : "error", r.name, r.message);
  }

  /**
   * {@link attach} without reporting a failure (the reconnect retries decide when it is one). The setup runs on the
   * device seen through the trace, so the session's own writes (teardown, emergency stop) are traced too while it
   * records.
   */
  private async setUp(
    hid: HidApiLike,
    pick: FfbPick
  ): Promise<{ ok: true; name: string } | { ok: false; name: string; unsupported: boolean; message: string }> {
    const { device } = pick;
    const name = deviceName(device);
    if (this.status.state !== "connecting" || this.status.device !== name) this.setStatus("connecting", name, null);
    this.lastDevice = device;
    const how =
      pick.kind === "pid"
        ? `the HID PID driver (${pidProfileName(device)} profile)`
        : pick.kind === "logitech-hidpp"
          ? `the Logitech HID++ driver (hid-logitech-hidpp, ${pick.model.name})`
          : pick.kind === "logitech-classic"
            ? `the Logitech classic driver (hid-lg4ff, ${pick.model.name})`
            : `the Thrustmaster driver (hid-tmff2 commands, ${pick.model.name})`;
    this.trace.note(`setup ${name} [${hex(device.vendorId, 4)}:${hex(device.productId, 4)}] with ${how}`);
    const options: LogitechClassicSetupOptions = {
      deps: this.deps,
      rotationDeg: this.rotationDeg,
      onFail: (message, fatal) => {
        if (fatal && this.device === device) {
          // The session goes at once (reconnect, hotplug and the hardware damper all see none), the error stays
          this.drop();
          this.setStatus("error", name, `Force feedback stopped: ${message}`);
        }
      },
    };
    const traced = tracedDevice(device, this.trace);
    this.trace.recording = true;
    let result: SetupResult<FfbSession>;
    try {
      result =
        pick.kind === "pid"
          ? await setupPidDevice(traced, { ...options, layout: pick.layout, conditions: this.wantedConditions })
          : pick.kind === "logitech-hidpp"
            ? await setupLogitechHidppDevice(traced, pick.model, options)
            : pick.kind === "logitech-classic"
              ? await setupLogitechClassicDevice(traced, pick.model, options)
              : await setupThrustmasterDevice(traced, pick.model, options);
    } finally {
      this.trace.recording = false;
    }
    if (!result.ok) {
      this.trace.note(`setup failed${result.unsupported ? " (unsupported)" : ""}: ${result.message}`);
      try {
        if (device.opened) await device.close();
      } catch {
        // already gone
      }
      return { ok: false, name, unsupported: result.unsupported, message: result.message };
    }
    this.trace.note(`setup ok: ${describeSession(result.session)}`);
    this.session = result.session;
    const l = result.session.kind === "pid" ? result.session.layout : null;
    this.offeredConditions = l && l.setCondition && l.createNewEffect && l.blockLoad ? l.conditions : [];
    this.device = device;
    if (this.listening !== hid) {
      hid.addEventListener("disconnect", this.onDisconnect);
      this.listening = hid;
    }
    this.setStatus("ready", name, null);
    return { ok: true, name };
  }

  /** From reconnect() (or a wheel picked in connect()) until dispose(): listen for a granted wheel coming back */
  private want(hid: HidApiLike): void {
    this.wanted = true;
    if (this.hotplugApi === hid) return;
    this.hotplugApi?.removeEventListener("connect", this.onConnect);
    hid.addEventListener("connect", this.onConnect);
    this.hotplugApi = hid;
  }

  private unwant(): void {
    this.wanted = false;
    this.disposals++;
    this.hotplugApi?.removeEventListener("connect", this.onConnect);
    this.hotplugApi = null;
    if (this.hotplugTimer !== null) {
      this.deps.clearTimer(this.hotplugTimer);
      this.hotplugTimer = null;
    }
    this.wakeRetry?.();
  }

  /**
   * A granted device appeared (the wheel switched back on): re-open it once it has settled. Only a device
   * {@link pickFfbDevice} accepts (a HID PID interface, a listed classic or HID++ Logitech wheel) schedules the re-open.
   */
  private onConnect = (e: { device: HidDeviceLike }) => {
    if (!this.wanted || this.session || !pickFfbDevice([e.device])) return;
    this.trace.note(`connect event: ${deviceName(e.device)}; re-opening in ${HOTPLUG_DELAY_MS} ms`);
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
    this.trace.note(`disconnect event: ${deviceName(e.device)}`);
    this.session?.writer.kill();
    this.session = null;
    this.device = null;
    this.clearIdle();
    this.setStatus("idle", null, "Wheel disconnected");
  };

  /** Arms the idle backstop ({@link IDLE_ZERO_MS}): one timer, re-armed from its own callback while calls keep coming */
  private noteDrive(): void {
    if (!this.session) return;
    this.lastDriveMs = this.deps.now();
    if (this.idleTimer === null) this.armIdle(IDLE_ZERO_MS);
  }

  private armIdle(ms: number): void {
    this.idleTimer = this.deps.setTimer(() => {
      this.idleTimer = null;
      if (!this.session) return;
      const idle = this.deps.now() - this.lastDriveMs;
      if (idle < IDLE_ZERO_MS) this.armIdle(IDLE_ZERO_MS - idle);
      else this.stop();
    }, ms);
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    this.deps.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  /** Shuts the current session down (best effort) and forgets it, once a dropped session's teardown has finished */
  private async release(): Promise<void> {
    const { session, device } = this.detach();
    const dropping = this.dropping;
    if (dropping) await dropping.done;
    await this.shutDown(session, device);
  }

  /**
   * A fatal write failure: the session is forgotten at once, outside any operation, and torn down in the background
   * as dispose() would (zero force, stop and free the effects, Stop All, disable actuators, close), best effort
   */
  private drop(): void {
    const { session, device } = this.detach();
    if (!session && !device) return;
    const before = this.dropping?.done;
    const done: Promise<void> = (async () => {
      await before;
      await this.shutDown(session, device);
    })()
      .catch(() => {})
      .finally(() => {
        if (this.dropping?.done === done) this.dropping = null;
      });
    this.dropping = { session, done };
  }

  /** Forgets the current session and device at once (every later call sees none) and returns them */
  private detach(): { session: FfbSession | null; device: HidDeviceLike | null } {
    const held = { session: this.session, device: this.device };
    this.session = null;
    this.device = null;
    this.clearIdle();
    if (this.listening) {
      this.listening.removeEventListener("disconnect", this.onDisconnect);
      this.listening = null;
    }
    return held;
  }

  /** Best-effort shutdown of a detached session, then its device closed */
  private async shutDown(session: FfbSession | null, device: HidDeviceLike | null): Promise<void> {
    if (session) {
      this.trace.note("teardown");
      this.trace.recording = true;
      try {
        await teardownSession(session);
      } finally {
        this.trace.recording = false;
      }
    }
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
    this.trace.note(`status ${state}${device ? ` | ${device}` : ""}${message ? ` | ${message}` : ""}`);
    this.onStatus?.(this.status);
    for (const l of this.listeners) l();
  }
}
