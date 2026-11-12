/**
 * Checks the WebHID force-feedback driver without a browser or a wheel:
 *   npx tsx scripts/verify-webhid-ffb.ts
 */
import assert from "node:assert/strict";
import {
  buildReport,
  buildSetEffectReport,
  conditionReportValues,
  describeHidDevice,
  HID_TRACE_SIZE,
  forceToRaw,
  FORCE_KEEPALIVE_MS,
  ForceWriter,
  HOTPLUG_DELAY_MS,
  IDLE_ZERO_MS,
  isFatalHidStatus,
  PAIR_MESSAGE,
  ordinalUsage,
  parsePidLayout,
  PID,
  selectorValue,
  SETUP_ATTEMPTS,
  SETUP_RETRY_MS,
  setupPidDevice,
  teardownPidSession,
  unpackReport,
  WebHidFfb,
  type FfbDeps,
  type HidApiLike,
  type HidCollectionLike,
  type HidDeviceLike,
  type HidInputReportEventLike,
  type HidReportItemLike,
  type PidFieldLayout,
  type PidReportLayout,
  type WebHidFfbStatus,
} from "../src/lib/input/webhid-ffb";
import { HIDPP_REPLY_TIMEOUT_MS, HIDPP_STREAM_REPLY_MS } from "../src/lib/input/webhid-logitech-hidpp";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/* ---- fake descriptor (shaped like the Microsoft PID sample / OpenFFBoard) ---- */

const pid = (id: number) => (0x0f << 16) | id;
const X = (0x01 << 16) | 0x30;
const Y = (0x01 << 16) | 0x31;

const variable = (usages: number[], size: number, count: number, min: number, max: number): HidReportItemLike => ({
  usages,
  reportSize: size,
  reportCount: count,
  logicalMinimum: min,
  logicalMaximum: max,
  isArray: false,
  isConstant: false,
});
const selector = (usages: number[], size = 8): HidReportItemLike => ({
  usages,
  reportSize: size,
  reportCount: 1,
  logicalMinimum: 1,
  logicalMaximum: usages.length,
  isArray: true,
  isConstant: false,
});
const padding = (bits: number): HidReportItemLike => ({ reportSize: 1, reportCount: bits, isConstant: true, isArray: false });

const ET_LIST = [0x26, 0x27, 0x30, 0x31].map(pid); // constant, ramp, square, sine
const DC_LIST = [0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c].map(pid);
const OP_LIST = [0x79, 0x7a, 0x7b].map(pid);
const BL_LIST = [0x8c, 0x8d, 0x8e].map(pid);

interface DescriptorOptions {
  /** Set Constant Force magnitude field */
  magnitude?: HidReportItemLike;
  duration?: HidReportItemLike;
  triggerButton?: HidReportItemLike;
  /** Put the PID reports in a nested child collection instead of the top level one */
  nested?: boolean;
  noCreateNewEffect?: boolean;
}

function pidCollections(o: DescriptorOptions = {}): HidCollectionLike[] {
  const index = variable([pid(0x22)], 8, 1, 1, 40);
  const outputReports = [
    {
      reportId: 1, // Set Effect
      items: [
        index,
        selector(ET_LIST),
        o.duration ?? variable([pid(0x50)], 16, 1, 0, 32767),
        variable([pid(0x54)], 16, 1, 0, 32767),
        variable([pid(0x51)], 16, 1, 0, 32767),
        variable([pid(0x52)], 8, 1, 0, 255),
        o.triggerButton ?? variable([pid(0x53)], 8, 1, 0, 255),
        variable([X, Y], 1, 2, 0, 1), // Axes Enable: X, Y
        variable([pid(0x56)], 1, 1, 0, 1), // Direction Enable
        padding(5),
        variable([ordinalUsage(1), ordinalUsage(2)], 8, 2, 0, 255), // Direction
        variable([pid(0xa7)], 16, 1, 0, 32767),
      ],
    },
    {
      reportId: 5, // Set Constant Force
      items: [index, o.magnitude ?? variable([pid(0x70)], 16, 1, -10000, 10000)],
    },
    {
      reportId: 6, // Set Periodic: must not be mistaken for Constant Force
      items: [index, variable([pid(0x70)], 16, 1, 0, 10000), variable([pid(0x6f)], 16, 1, -10000, 10000), variable([pid(0x71)], 8, 1, 0, 255), variable([pid(0x72)], 16, 1, 0, 32767)],
    },
    { reportId: 10, items: [index, selector(OP_LIST), variable([pid(0x7c)], 8, 1, 0, 255)] }, // Effect Operation
    { reportId: 11, items: [index] }, // Block Free
    { reportId: 12, items: [selector(DC_LIST)] }, // Device Control
    { reportId: 13, items: [variable([pid(0x7e)], 8, 1, 0, 255)] }, // Device Gain
  ];
  const featureReports = o.noCreateNewEffect
    ? []
    : [
        { reportId: 17, items: [selector(ET_LIST), variable([pid(0xac)], 16, 1, 0, 511)] }, // Create New Effect
        { reportId: 18, items: [index, selector(BL_LIST), variable([pid(0xad)], 16, 1, 0, 65535)] }, // PID Block Load
      ];
  const body = { outputReports, featureReports };
  return [
    { usagePage: 0x01, usage: 0x04, inputReports: [{ reportId: 2, items: [variable([X], 16, 1, 0, 65535)] }] },
    o.nested
      ? { usagePage: 0x0f, usage: 0x92, children: [{ usagePage: 0x0f, usage: 0x21, ...body }] }
      : { usagePage: 0x0f, usage: 0x92, ...body },
  ];
}

/**
 * pidCollections plus the Damper effect type and a Set Condition report (id 3); `types` lists other effect types (by
 * default constant force, spring, damper: the damper selects as 3)
 */
function damperCollections(o: { noCreateNewEffect?: boolean; types?: number[] } = {}): HidCollectionLike[] {
  const base = pidCollections(o);
  const pidNode = base[1] as HidCollectionLike;
  const types = (o.types ?? [0x26, 0x40, 0x41]).map(pid);
  const index = variable([pid(0x22)], 8, 1, 1, 40);
  return [
    base[0] as HidCollectionLike,
    {
      ...pidNode,
      outputReports: [
        {
          reportId: 1,
          items: [
            index,
            selector(types),
            variable([pid(0x50)], 16, 1, 0, 65535),
            variable([pid(0x52)], 8, 1, 0, 255),
            variable([X, Y], 1, 2, 0, 1),
            variable([pid(0x56)], 1, 1, 0, 1),
            padding(5),
            variable([ordinalUsage(1), ordinalUsage(2)], 8, 2, 0, 255),
          ],
        },
        {
          reportId: 3, // Set Condition: block, parameter block offset, CP offset, +/- coefficient, +/- saturation, dead band
          items: [
            index,
            variable([pid(0x23)], 8, 1, 0, 1),
            variable([pid(0x60)], 16, 1, -10000, 10000),
            variable([pid(0x61)], 16, 1, -10000, 10000),
            variable([pid(0x62)], 16, 1, -10000, 10000),
            variable([pid(0x63)], 16, 1, 0, 10000),
            variable([pid(0x64)], 16, 1, 0, 10000),
            variable([pid(0x65)], 16, 1, 0, 10000),
          ],
        },
        ...(pidNode.outputReports ?? []).slice(1),
      ],
      featureReports: o.noCreateNewEffect
        ? []
        : [
            { reportId: 17, items: [selector(types), variable([pid(0xac)], 16, 1, 0, 511)] },
            { reportId: 18, items: [index, selector(BL_LIST), variable([pid(0xad)], 16, 1, 0, 65535)] },
          ],
    },
  ];
}

/* ---- fake device ---- */

interface Logged {
  kind: "out" | "feature";
  id: number;
  data: number[];
}

class FakeHidDevice implements HidDeviceLike {
  opened = false;
  vendorId = 0x1234;
  productId = 0x5678;
  productName = "Fake DD Base";
  log: Logged[] = [];
  /** Block index the fake hands out (then the next ones in `laterBlocks`); status 1 = success, 2 = full, 3 = error */
  blockIndex = 3;
  laterBlocks: number[] = [];
  blockStatus = 1;
  /**
   * How Block Load comes back: "bare" (just the report), "withId" (report id in byte 0), "withIdPadded" (id in byte 0,
   * zero-padded to 64 bytes, as Chrome sizes the buffer to the largest feature report)
   */
  blockLoadReply: "bare" | "withId" | "withIdPadded" = "bare";
  /** When true sendReport stays pending until `release()` */
  hold = false;
  failSends = false;
  /** open() throws this many more times (a base that was just switched on) */
  failOpens = 0;
  private waiters: (() => void)[] = [];
  constructor(
    public collections: readonly HidCollectionLike[],
    private readonly blockLoad: PidReportLayout | null = null
  ) {}
  async open() {
    if (this.failOpens > 0) {
      this.failOpens--;
      throw new Error("Failed to open the device");
    }
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(reportId: number, data: Uint8Array) {
    this.log.push({ kind: "out", id: reportId, data: [...data] });
    if (this.failSends) throw new Error("device vanished");
    if (this.hold) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  async sendFeatureReport(reportId: number, data: Uint8Array) {
    this.log.push({ kind: "feature", id: reportId, data: [...data] });
  }
  async receiveFeatureReport(_reportId: number) {
    const layout = this.blockLoad;
    if (!layout) throw new Error("no block load layout");
    const { data } = buildReport(layout, { [PID.EFFECT_BLOCK_INDEX]: this.blockIndex, [PID.BLOCK_LOAD_STATUS]: this.blockStatus });
    if (this.blockStatus === 1 && this.laterBlocks.length > 0) this.blockIndex = this.laterBlocks.shift() as number;
    if (this.blockLoadReply === "bare") return new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Uint8Array(this.blockLoadReply === "withIdPadded" ? 64 : data.length + 1);
    out[0] = layout.reportId;
    out.set(data, 1);
    return new DataView(out.buffer);
  }
  release() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
  get forceWrites() {
    return this.log.filter((l) => l.kind === "out" && l.id === 5);
  }
}

/** Manual clock + timers so rate limiting is tested without waiting */
class FakeClock {
  t = 1000;
  timers: { fn: () => void; at: number; ms: number }[] = [];
  /** Every sleep the driver asked for, in order */
  sleeps: number[] = [];
  deps: FfbDeps = {
    now: () => this.t,
    setTimer: (fn, ms) => {
      const h = { fn, at: this.t + ms, ms };
      this.timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      this.timers = this.timers.filter((x) => x !== h);
    },
    sleep: async (ms) => {
      this.sleeps.push(ms);
    },
  };
  /** Advances time and fires due timers */
  advance(ms: number) {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Lets a chain of awaits (getDevices, setup, …) run to its next timer */
const settle = async () => {
  for (let i = 0; i < 30; i++) await flush();
};
const asLayout = (cols: HidCollectionLike[]) => {
  const l = parsePidLayout(cols);
  assert.ok(l, "layout parses");
  return l;
};
const field = (l: PidReportLayout, key: number): PidFieldLayout => {
  const f = l.fields[key];
  assert.ok(f, `field 0x${key.toString(16)} present`);
  return f;
};

async function main() {
  console.log("Layout parser");
  await check("finds the PID reports by content, with ids from the descriptor", () => {
    const l = asLayout(pidCollections());
    assert.equal(l.setEffect?.reportId, 1);
    assert.equal(l.constantForce.reportId, 5); // not the periodic report 6
    assert.equal(l.effectOperation.reportId, 10);
    assert.equal(l.blockFree?.reportId, 11);
    assert.equal(l.deviceControl?.reportId, 12);
    assert.equal(l.deviceGain?.reportId, 13);
    assert.equal(l.createNewEffect?.reportId, 17);
    assert.equal(l.blockLoad?.reportId, 18);
  });
  await check("PID reports nested in a child collection are found too", () => {
    assert.equal(asLayout(pidCollections({ nested: true })).constantForce.reportId, 5);
  });
  await check("bit offsets: 16-bit signed magnitude after an 8-bit block index", () => {
    const l = asLayout(pidCollections());
    assert.equal(l.constantForce.bitLength, 24);
    const m = field(l.constantForce, PID.MAGNITUDE);
    assert.deepEqual([m.bitOffset, m.bitSize, m.min, m.max, m.signed], [8, 16, -10000, 10000, true]);
    assert.equal(field(l.constantForce, PID.EFFECT_BLOCK_INDEX).bitOffset, 0);
  });
  await check("Set Effect: offsets, 3 non-aligned axis bits, padding, ordinals", () => {
    const set = asLayout(pidCollections()).setEffect as PidReportLayout;
    assert.equal(set.bitLength, 120);
    assert.equal(field(set, PID.DURATION).bitOffset, 16);
    assert.equal(field(set, PID.GAIN).bitOffset, 64);
    assert.equal(field(set, X).bitOffset, 80);
    assert.equal(field(set, Y).bitOffset, 81);
    assert.equal(field(set, PID.DIRECTION_ENABLE).bitOffset, 82);
    assert.equal(field(set, ordinalUsage(1)).bitOffset, 88);
    assert.equal(field(set, ordinalUsage(2)).bitOffset, 96);
    assert.equal(field(set, PID.START_DELAY).bitOffset, 104);
  });
  await check("selectors: value = min + index of the usage", () => {
    const l = asLayout(pidCollections());
    const type = field(l.setEffect as PidReportLayout, PID.EFFECT_TYPE);
    assert.equal(selectorValue(type, PID.ET_CONSTANT_FORCE), 1);
    const dc = field(l.deviceControl as PidReportLayout, PID.DEVICE_CONTROL);
    assert.equal(selectorValue(dc, PID.DC_DEVICE_RESET), 4);
    assert.equal(selectorValue(dc, PID.DC_ENABLE_ACTUATORS), 1);
    assert.equal(selectorValue(field(l.effectOperation, PID.EFFECT_OPERATION), PID.OP_EFFECT_STOP), 3);
    assert.equal(selectorValue(dc, PID.OP_EFFECT_START), null);
  });
  await check("a sign-extended logical maximum (0..-1 on 8 bits) is repaired to 0..255", () => {
    const cols = pidCollections({ magnitude: variable([pid(0x70)], 8, 1, 0, -1) });
    const m = field(asLayout(cols).constantForce, PID.MAGNITUDE);
    assert.deepEqual([m.min, m.max, m.signed], [0, 255, false]);
  });
  await check("no usable PID: gamepad only, or Constant Force without Effect Operation", () => {
    assert.equal(parsePidLayout([{ usagePage: 0x01, usage: 0x05, inputReports: [{ reportId: 1, items: [variable([X], 16, 1, 0, 65535)] }] }]), null);
    assert.equal(parsePidLayout([]), null);
    const noOp = [{ usagePage: 0x0f, usage: 1, outputReports: [{ reportId: 5, items: [variable([pid(0x22)], 8, 1, 1, 40), variable([pid(0x70)], 16, 1, -10000, 10000)] }] }];
    assert.equal(parsePidLayout(noOp), null);
  });

  console.log("Report packing");
  await check("Set Constant Force: little-endian signed 16-bit", () => {
    const l = asLayout(pidCollections()).constantForce;
    const r = buildReport(l, { [PID.EFFECT_BLOCK_INDEX]: 3, [PID.MAGNITUDE]: -10000 });
    assert.equal(r.reportId, 5);
    assert.deepEqual([...r.data], [3, 0xf0, 0xd8]); // -10000 = 0xD8F0
    assert.deepEqual([...buildReport(l, { [PID.EFFECT_BLOCK_INDEX]: 3, [PID.MAGNITUDE]: 258 }).data], [3, 0x02, 0x01]);
    assert.equal(unpackReport(l, r.data)[PID.MAGNITUDE], -10000);
  });
  await check("values are rounded and clamped into the logical range", () => {
    const l = asLayout(pidCollections()).constantForce;
    assert.deepEqual([...buildReport(l, { [PID.EFFECT_BLOCK_INDEX]: 3, [PID.MAGNITUDE]: 99999 }).data], [3, 0x10, 0x27]); // 10000
    assert.deepEqual([...buildReport(l, { [PID.EFFECT_BLOCK_INDEX]: 99, [PID.MAGNITUDE]: 0 }).data], [40, 0, 0]); // index max 40
  });
  await check("non-byte-aligned fields: 6-bit index then 12-bit signed magnitude straddle the byte boundary", () => {
    const layout: PidReportLayout = {
      reportId: 0,
      bitLength: 20,
      fields: {
        [PID.EFFECT_BLOCK_INDEX]: { bitOffset: 0, bitSize: 6, min: 0, max: 63, signed: false },
        [PID.MAGNITUDE]: { bitOffset: 6, bitSize: 12, min: -2047, max: 2047, signed: true },
      },
      fieldList: [],
    };
    const r = buildReport(layout, { [PID.EFFECT_BLOCK_INDEX]: 0b101011, [PID.MAGNITUDE]: -3 });
    // -3 in 12 bits = 0xFFD = 1111 1111 1101; bits 6.. of the stream: low 2 bits (01) land in byte 0 bits 6-7
    assert.deepEqual([...r.data], [0b01101011, 0b11111111, 0b00000011]);
    const back = unpackReport(layout, r.data);
    assert.equal(back[PID.EFFECT_BLOCK_INDEX], 0b101011);
    assert.equal(back[PID.MAGNITUDE], -3);
  });
  await check("axes-enable bits pack at offsets 80/81/82 of Set Effect", () => {
    const set = asLayout(pidCollections()).setEffect as PidReportLayout;
    const r = buildReport(set, { [X]: 1, [PID.DIRECTION_ENABLE]: 1 });
    assert.equal(r.data[10], 0b101);
    assert.equal(r.data.length, 15);
  });
  await check("8-bit unsigned magnitude: -1 -> 0, +1 -> 255, 0 -> midpoint 128", () => {
    const l = asLayout(pidCollections({ magnitude: variable([pid(0x70)], 8, 1, 0, 255) })).constantForce;
    const m = field(l, PID.MAGNITUDE);
    assert.equal(l.bitLength, 16);
    assert.equal(forceToRaw(m, -1), 0);
    assert.equal(forceToRaw(m, 1), 255);
    assert.equal(forceToRaw(m, 0), 128);
    assert.deepEqual([...buildReport(l, { [PID.EFFECT_BLOCK_INDEX]: 1, [PID.MAGNITUDE]: forceToRaw(m, 1) }).data], [1, 255]);
  });
  await check("signed range: 0 is exactly 0 and each side reaches its own end", () => {
    const m: PidFieldLayout = { bitOffset: 0, bitSize: 16, min: -32768, max: 32767, signed: true };
    assert.equal(forceToRaw(m, 0), 0);
    assert.equal(forceToRaw(m, 1), 32767);
    assert.equal(forceToRaw(m, -1), -32768);
    assert.equal(forceToRaw(m, 5), 32767); // clamped
    assert.equal(forceToRaw(m, Number.NaN), 0);
    const ten: PidFieldLayout = { bitOffset: 0, bitSize: 16, min: -10000, max: 10000, signed: true };
    assert.equal(forceToRaw(ten, 0.25), 2500);
  });

  console.log("Setup sequence");
  await check("reset, enable, gain, create effect (block from Block Load), set effect, zero force, start", async () => {
    const cols = pidCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    const clock = new FakeClock();
    const res = await setupPidDevice(dev, { deps: clock.deps });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(dev.opened, true);
    assert.equal(res.session.blockIndex, 3);
    assert.deepEqual(dev.log, [
      { kind: "out", id: 12, data: [4] }, // device reset
      { kind: "out", id: 12, data: [1] }, // enable actuators
      { kind: "out", id: 13, data: [255] }, // device gain 100 %
      { kind: "feature", id: 17, data: [1, 0, 0] }, // create: constant force, byte count 0
      {
        kind: "out",
        id: 1,
        data: [
          3, // block index from Block Load
          1, // constant force
          0xff, 0xff, // duration = 0xFFFF (infinite on 16-bit field, even when LogicalMax = 32767)
          0, 0, // trigger repeat
          0, 0, // sample period
          255, // gain
          255, // trigger button: none
          0b001, // X enabled, Y not, Direction Enable cleared
          64, 0, // direction ordinal 1 = 90 degrees (X), ordinal 2 = 0
          0, 0, // start delay
        ],
      },
      { kind: "out", id: 5, data: [3, 0, 0] }, // zero force
      { kind: "out", id: 10, data: [3, 1, 255] }, // Op Effect Start, loop 255
    ]);
    assert.deepEqual(clock.sleeps, [60], "60 ms after the reset, no other pause");
  });
  await check("Block Load read with Chrome's report-id byte, padded or not, or without it", async () => {
    for (const reply of ["bare", "withId", "withIdPadded"] as const) {
      const cols = pidCollections();
      const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
      dev.blockLoadReply = reply;
      dev.blockIndex = 7;
      const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
      assert.ok(res.ok, `${reply}: setup ok`);
      if (!res.ok) continue;
      assert.equal(res.session.blockIndex, 7, `${reply}: block index`);
    }
  });
  await check("no Create New Effect report: block index 1", async () => {
    const cols = pidCollections({ noCreateNewEffect: true });
    const dev = new FakeHidDevice(cols);
    const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.session.blockIndex, 1);
    assert.ok(!dev.log.some((l) => l.kind === "feature"));
    assert.deepEqual(dev.log.at(-1), { kind: "out", id: 10, data: [1, 1, 255] });
  });
  await check("Block Load 'full' / 'error' fail the setup with a message", async () => {
    for (const [status, text] of [[2, /no free effect memory/], [3, /refused/]] as const) {
      const cols = pidCollections();
      const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
      dev.blockStatus = status;
      const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
      assert.ok(!res.ok);
      if (!res.ok) {
        assert.equal(res.unsupported, false);
        assert.match(res.message, text);
      }
    }
  });
  await check("a device without PID is reported unsupported and never opened", async () => {
    const dev = new FakeHidDevice([{ usagePage: 0x01, usage: 0x04 }]);
    const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
    assert.ok(!res.ok);
    if (!res.ok) assert.equal(res.unsupported, true);
    assert.equal(dev.opened, false);
    assert.equal(dev.log.length, 0);
  });
  await check("8-bit unsigned device: zero force is written as the midpoint", async () => {
    const cols = pidCollections({ magnitude: variable([pid(0x70)], 8, 1, 0, 255) });
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
    assert.ok(res.ok);
    assert.deepEqual(dev.forceWrites[0], { kind: "out", id: 5, data: [3, 128] });
  });
  await check("MOZA R9 Base descriptor (Trigger Button 1..8, Duration 0..32767) writes 0xFF (no trigger) and 0xFFFF (infinite)", async () => {
    const cols = pidCollections({
      triggerButton: variable([pid(0x53)], 8, 1, 1, 8),
      duration: variable([pid(0x50)], 16, 1, 0, 32767),
    });
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
    assert.ok(res.ok);
    const setEffect = dev.log.find((l) => l.kind === "out" && l.id === 1);
    assert.ok(setEffect, "Set Effect report sent");
    assert.equal(setEffect!.data[2], 0xff, "Duration low byte is 0xFF");
    assert.equal(setEffect!.data[3], 0xff, "Duration high byte is 0xFF (0xFFFF = infinite, not 32767 ms)");
    assert.equal(setEffect!.data[9], 255, "Trigger Button byte is 0xFF (DIEB_NOTRIGGER), not clamped to 1");
  });
  await check("PXN V99 (11ff:3245) quirk: trigger 0, Direction Enable set, Stop All, loop 1, 30 / 20 ms pauses", async () => {
    const cols = pidCollections({ triggerButton: variable([pid(0x53)], 8, 1, 1, 8) });
    const run = async (vendorId: number, productId: number) => {
      const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
      dev.vendorId = vendorId;
      dev.productId = productId;
      const clock = new FakeClock();
      assert.ok((await setupPidDevice(dev, { deps: clock.deps })).ok);
      return { log: dev.log, sleeps: clock.sleeps };
    };
    const pxn = await run(0x11ff, 0x3245);
    assert.deepEqual(pxn.log, [
      { kind: "out", id: 12, data: [4] }, // device reset
      { kind: "out", id: 12, data: [3] }, // stop all effects
      { kind: "out", id: 12, data: [1] }, // enable actuators
      { kind: "out", id: 13, data: [255] },
      { kind: "feature", id: 17, data: [1, 0, 0] },
      // trigger button 0 although its LogicalMin is 1; X enabled with Direction Enable set
      { kind: "out", id: 1, data: [3, 1, 0xff, 0xff, 0, 0, 0, 0, 255, 0, 0b101, 64, 0, 0, 0] },
      { kind: "out", id: 5, data: [3, 0, 0] },
      { kind: "out", id: 10, data: [3, 1, 1] }, // loop 1
    ]);
    assert.deepEqual(pxn.sleeps, [30, 20]);
    // another product of the same vendor gets the generic profile
    const other = await run(0x11ff, 0x1212);
    const set = other.log.find((l) => l.kind === "out" && l.id === 1);
    assert.deepEqual([set?.data[9], set?.data[10]], [0xff, 0b001]);
    assert.deepEqual(other.log.at(-1), { kind: "out", id: 10, data: [3, 1, 255] });
    assert.deepEqual(other.sleeps, [60]);
  });
  await check("duplicate Generic Desktop X/Y usages in Set Effect (1-bit Axes Enable + 8-bit Direction) do not collide", () => {
    const cols: HidCollectionLike[] = [
      {
        usagePage: 0x0f,
        usage: 0x92,
        outputReports: [
          {
            reportId: 1,
            items: [
              variable([pid(0x22)], 8, 1, 1, 40),
              selector(ET_LIST),
              variable([pid(0x50)], 16, 1, 0, 65535),
              variable([pid(0x52)], 8, 1, 0, 255),
              variable([X, Y], 1, 2, 0, 1), // 1-bit X, Y in Axes Enable
              variable([pid(0x56)], 1, 1, 0, 1), // Direction Enable
              padding(5),
              variable([X, Y], 8, 2, 0, 255), // 8-bit X, Y in Direction (same usages!)
            ],
          },
          { reportId: 5, items: [variable([pid(0x22)], 8, 1, 1, 40), variable([pid(0x70)], 16, 1, -10000, 10000)] },
          { reportId: 10, items: [variable([pid(0x22)], 8, 1, 1, 40), selector(OP_LIST), variable([pid(0x7c)], 8, 1, 0, 255)] },
        ],
      },
    ];
    const layout = asLayout(cols);
    const rep = buildSetEffectReport(layout.setEffect!, 2, PID.ET_CONSTANT_FORCE);
    // block 2, constant force, duration 0xFFFF, gain 255, Axes Enable X=1 Y=0 with Direction Enable cleared, Direction X=90° Y=0
    assert.deepEqual([...rep.data], [2, 1, 0xff, 0xff, 255, 0b001, 64, 0]);
  });
  await check("Set Condition: an unsigned coefficient (0..10000) starts at 0, not the midpoint", () => {
    const f = (bitOffset: number, min: number, max: number): PidFieldLayout => ({ bitOffset, bitSize: 16, min, max, signed: min < 0 });
    const cond: PidReportLayout = {
      reportId: 3,
      bitLength: 8 + 16 * 4,
      fields: {
        [PID.EFFECT_BLOCK_INDEX]: { bitOffset: 0, bitSize: 8, min: 1, max: 40, signed: false },
        [PID.CP_OFFSET]: f(8, 0, 10000),
        [PID.POSITIVE_COEFFICIENT]: f(24, 0, 10000),
        [PID.NEGATIVE_COEFFICIENT]: f(40, -10000, 10000),
        [PID.POSITIVE_SATURATION]: f(56, 0, 10000),
      },
      fieldList: [],
    };
    const off = conditionReportValues(cond, 2, 0, 1);
    assert.equal(off[PID.POSITIVE_COEFFICIENT], 0, "unsigned: 0 is the minimum");
    assert.equal(off[PID.NEGATIVE_COEFFICIENT], 0, "signed: 0 stays 0");
    assert.equal(off[PID.CP_OFFSET], 5000, "an unsigned centre offset keeps the midpoint");
    const half = conditionReportValues(cond, 2, 0.35, 1);
    assert.equal(half[PID.POSITIVE_COEFFICIENT], 3500);
    assert.equal(half[PID.NEGATIVE_COEFFICIENT], 3500);
  });
  await check("hardware Damper: its own block from Block Load, Set Effect + Set Condition 0 + start", async () => {
    const cols = damperCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    dev.laterBlocks = [4];
    const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.session.damperBlockIndex, 4);
    assert.ok(res.session.setDamper);
    assert.deepEqual(dev.log.slice(-4), [
      { kind: "feature", id: 17, data: [3, 0, 0] }, // create: damper
      { kind: "out", id: 1, data: [4, 3, 0xff, 0xff, 255, 0b001, 64, 0] }, // Set Effect for block 4, type damper
      { kind: "out", id: 3, data: [4, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x27, 0x10, 0x27, 0, 0] }, // coefficient 0, full saturation
      { kind: "out", id: 10, data: [4, 1, 255] }, // started like the constant force
    ]);
  });
  await check("no hardware Damper on a guessed block: none without Create New Effect, none on the constant force's block", async () => {
    for (const [cols, blocks] of [
      [damperCollections({ noCreateNewEffect: true }), []],
      [damperCollections(), []], // Block Load hands out block 3 again
    ] as const) {
      const dev = new FakeHidDevice(cols, parsePidLayout(cols)?.blockLoad ?? null);
      dev.laterBlocks = [...blocks];
      const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
      assert.ok(res.ok);
      if (!res.ok) return;
      assert.equal(res.session.setDamper, undefined);
      assert.equal(res.session.damperBlockIndex, null);
      assert.ok(!dev.log.some((l) => l.kind === "out" && (l.id === 3 || l.id === 11)), "no Set Condition, no block freed");
    }
  });
  await check("a damper setup that fails part-way frees its block and leaves the constant force running", async () => {
    const cols = damperCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    dev.laterBlocks = [4];
    const send = dev.sendReport.bind(dev);
    dev.sendReport = async (id, data) => {
      if (id === 3) throw new Error("stalled");
      return send(id, data);
    };
    const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.session.setDamper, undefined);
    assert.deepEqual(dev.log.at(-1), { kind: "out", id: 11, data: [4] });
    assert.ok(!dev.log.some((l) => l.kind === "out" && l.id === 10 && l.data[0] === 4), "damper never started");
  });

  function fakeHid(devices: FakeHidDevice[], granted: FakeHidDevice[] = []) {
    type Listener = (e: { device: HidDeviceLike }) => void;
    /** "disconnect" listeners (as `listeners`) and "connect" ones */
    const listeners: Listener[] = [];
    const connectListeners: Listener[] = [];
    /** The filters each requestDevice call was given */
    const requests: Parameters<HidApiLike["requestDevice"]>[0][] = [];
    const of = (t: "connect" | "disconnect") => (t === "connect" ? connectListeners : listeners);
    const api: HidApiLike = {
      requestDevice: async (options) => {
        requests.push(options);
        return devices;
      },
      getDevices: async () => granted,
      addEventListener: (t, l) => void of(t).push(l),
      removeEventListener: (t, l) => {
        const list = of(t);
        const i = list.indexOf(l);
        if (i >= 0) list.splice(i, 1);
      },
    };
    return { api, listeners, connectListeners, requests };
  }
  const wheel = () => {
    const cols = pidCollections();
    return new FakeHidDevice(cols, asLayout(cols).blockLoad);
  };

  console.log("setForce semantics");
  async function ready() {
    const cols = pidCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    const clock = new FakeClock();
    const res = await setupPidDevice(dev, { deps: clock.deps });
    assert.ok(res.ok);
    if (!res.ok) throw new Error("setup failed");
    dev.log.length = 0;
    clock.advance(10);
    return { dev, clock, writer: res.session.writer, session: res.session };
  }
  /** Signed 16-bit magnitude of a Set Constant Force write */
  const mag = (w: Logged | undefined) => {
    assert.ok(w);
    const v = (w.data[1] as number) | ((w.data[2] as number) << 8);
    return v >= 0x8000 ? v - 0x10000 : v;
  };

  await check("first write goes out at once, scaled to the logical range", async () => {
    const { dev, writer } = await ready();
    writer.setForce(0.5);
    await flush();
    assert.equal(dev.forceWrites.length, 1);
    assert.equal(mag(dev.forceWrites[0]), 5000);
  });
  await check("only one write in flight: intermediate values are dropped, the latest wins", async () => {
    const { dev, clock, writer } = await ready();
    dev.hold = true;
    writer.setForce(0.1);
    writer.setForce(0.2);
    writer.setForce(0.3);
    writer.setForce(0.4);
    await flush();
    assert.equal(dev.forceWrites.length, 1, "second write waits for the first");
    assert.equal(mag(dev.forceWrites[0]), 1000);
    dev.hold = false;
    dev.release();
    await flush();
    assert.equal(dev.forceWrites.length, 1, "2 ms spacing not elapsed yet");
    assert.equal(clock.timers.length, 1);
    assert.ok(clock.timers[0] && clock.timers[0].ms <= 2 && clock.timers[0].ms > 0);
    clock.advance(2);
    await flush();
    assert.equal(dev.forceWrites.length, 2);
    assert.equal(mag(dev.forceWrites[1]), 4000, "latest value, 0.2 and 0.3 never sent");
  });
  await check("at least 2 ms between writes", async () => {
    const { dev, clock, writer } = await ready();
    writer.setForce(0.1);
    await flush();
    writer.setForce(0.2); // same instant
    await flush();
    assert.equal(dev.forceWrites.length, 1);
    clock.advance(1);
    await flush();
    assert.equal(dev.forceWrites.length, 1, "1 ms is too soon");
    clock.advance(1);
    await flush();
    assert.equal(dev.forceWrites.length, 2);
    assert.equal(mag(dev.forceWrites[1]), 2000);
  });
  await check("changes below 1/1000 of the range are skipped; larger ones go out", async () => {
    const { dev, clock, writer } = await ready();
    writer.setForce(0.4);
    await flush();
    clock.advance(5);
    writer.setForce(0.4005); // +5 of 20000
    writer.setForce(0.3995);
    await flush();
    assert.equal(dev.forceWrites.length, 1);
    writer.setForce(0.401); // +10... still below 20
    await flush();
    assert.equal(dev.forceWrites.length, 1);
    writer.setForce(0.403); // +30
    await flush();
    assert.equal(dev.forceWrites.length, 2);
    assert.equal(mag(dev.forceWrites[1]), 4030);
  });
  await check("a small value dropped by the threshold cancels an older queued one", async () => {
    const { dev, clock, writer } = await ready();
    writer.setForce(0.5);
    await flush();
    writer.setForce(0.9); // queued behind the 2 ms spacing
    writer.setForce(0.5004); // back to (almost) what the wheel holds
    clock.advance(5);
    await flush();
    assert.equal(dev.forceWrites.length, 1);
  });
  await check(`an unchanged force is written again after ${FORCE_KEEPALIVE_MS} ms (keepalive), not before`, async () => {
    const { dev, clock, writer } = await ready();
    writer.setForce(0.4);
    await flush();
    const n = dev.forceWrites.length;
    for (let t = 0; t < FORCE_KEEPALIVE_MS - 20; t += 10) {
      clock.advance(10);
      writer.setForce(0.4);
      writer.setForce(0.40002); // inside the dead band
      await flush();
    }
    assert.equal(dev.forceWrites.length, n, "no resend inside the keepalive window");
    clock.advance(30);
    writer.setForce(0.4);
    await flush();
    assert.equal(dev.forceWrites.length, n + 1, "resent once the window has passed");
    assert.equal(mag(dev.forceWrites.at(-1)), 4000);
  });
  await check("going to zero is never swallowed by the threshold", async () => {
    const { dev, clock, writer } = await ready();
    writer.setForce(0.001); // raw 10, within threshold of... first write always goes
    await flush();
    clock.advance(5);
    writer.setForce(0);
    await flush();
    assert.equal(dev.forceWrites.length, 2);
    assert.equal(mag(dev.forceWrites[1]), 0);
  });
  await check("stop(): urgent zero skips the spacing and the older queued value", async () => {
    const dev = wheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([dev]).api, clock.deps);
    await ffb.connect();
    dev.log.length = 0;
    dev.hold = true;
    ffb.setForce(0.6);
    await flush();
    ffb.setForce(0.7); // queued behind the write in flight
    ffb.stop();
    dev.hold = false;
    dev.release();
    await flush();
    assert.equal(dev.forceWrites.length, 2);
    assert.equal(mag(dev.forceWrites[0]), 6000);
    assert.equal(mag(dev.forceWrites[1]), 0, "zero sent right after the write in flight, 0.7 dropped");
    assert.ok(!clock.timers.some((t) => t.ms <= 2), "no spacing timer was needed");
  });
  await check("3 failing writes in a row are fatal and stop further writing", async () => {
    const cols = pidCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    const clock = new FakeClock();
    const events: [string, boolean][] = [];
    const res = await setupPidDevice(dev, { deps: clock.deps, onFail: (m, f) => events.push([m, f]) });
    assert.ok(res.ok);
    if (!res.ok) return;
    dev.log.length = 0;
    dev.failSends = true;
    for (let i = 1; i <= 5; i++) {
      res.session.writer.setForce(i / 10);
      await flush();
      clock.advance(5);
      await flush();
    }
    assert.deepEqual(events, [
      ["device vanished", false],
      ["device vanished", false],
      ["device vanished", true],
    ]);
    assert.equal(dev.forceWrites.length, 3);
  });
  await check("ForceWriter alone: zero threshold edge, 8-bit steps always pass", async () => {
    const f: PidFieldLayout = { bitOffset: 0, bitSize: 8, min: 0, max: 255, signed: false };
    const sent: number[] = [];
    const clock = new FakeClock();
    const w = new ForceWriter(f, async (raw) => void sent.push(raw), clock.deps);
    w.setForce(0.5);
    await flush();
    clock.advance(3);
    w.setForce(0.5 + 1 / 255); // one raw step is above 255/1000
    await flush();
    assert.deepEqual(sent, [191, 192]);
  });

  console.log("Hardware damper through the driver");
  async function damperDriver() {
    const cols = damperCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    dev.laterBlocks = [4];
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([dev]).api, clock.deps);
    assert.ok(await ffb.connect());
    assert.equal(ffb.hasHardwareDamper(), true);
    dev.log.length = 0;
    clock.advance(10);
    return { dev, clock, ffb };
  }
  /** Coefficient of a Set Condition write, -10000..10000 */
  const coeff = (w: Logged | undefined) => {
    assert.ok(w);
    const v = (w.data[4] as number) | ((w.data[5] as number) << 8);
    return v >= 0x8000 ? v - 0x10000 : v;
  };
  const conditions = (dev: FakeHidDevice) => dev.log.filter((l) => l.kind === "out" && l.id === 3);

  await check("setDamper: changes under 0.025 are skipped, larger ones go out", async () => {
    const { dev, clock, ffb } = await damperDriver();
    ffb.setDamper(0.01);
    await flush();
    assert.equal(conditions(dev).length, 0);
    ffb.setDamper(0.5);
    await flush();
    clock.advance(5);
    ffb.setDamper(0.51);
    await flush();
    assert.equal(conditions(dev).length, 1);
    assert.equal(coeff(conditions(dev)[0]), 5000);
  });
  await check("damper and force share one write in flight and take turns", async () => {
    const { dev, clock, ffb } = await damperDriver();
    dev.hold = true;
    ffb.setForce(0.5);
    ffb.setDamper(0.5);
    ffb.setForce(0.6);
    await flush();
    assert.equal(dev.log.length, 1, "the damper waits for the force write in flight");
    dev.hold = false;
    dev.release();
    await flush();
    clock.advance(2);
    await flush();
    clock.advance(2);
    await flush();
    assert.deepEqual(
      dev.log.map((l) => l.id),
      [5, 3, 5],
      "force, then the damper, then the newer force"
    );
  });
  await check("stop() zeroes the hardware damper with the force", async () => {
    const { dev, clock, ffb } = await damperDriver();
    ffb.setForce(0.5);
    ffb.setDamper(0.5);
    await flush();
    clock.advance(5);
    await flush();
    ffb.stop();
    await flush();
    await flush();
    assert.equal(coeff(conditions(dev).at(-1)), 0);
    assert.equal(mag(dev.forceWrites.at(-1)), 0);
  });
  await check(`no setForce / setDamper call for ${IDLE_ZERO_MS} ms: the driver zeroes force and damper itself`, async () => {
    const { dev, clock, ffb } = await damperDriver();
    for (let i = 0; i < 5; i++) {
      ffb.setForce(0.4 + i / 100);
      ffb.setDamper(0.5);
      await flush();
      clock.advance(100); // the app still calls every 100 ms: nothing is zeroed
      await flush();
    }
    assert.ok(dev.forceWrites.every((w) => mag(w) !== 0));
    clock.advance(IDLE_ZERO_MS - 100 - 1);
    await flush();
    assert.ok(dev.forceWrites.every((w) => mag(w) !== 0), "not before the interval");
    clock.advance(1);
    await flush();
    await flush();
    assert.equal(mag(dev.forceWrites.at(-1)), 0);
    assert.equal(coeff(conditions(dev).at(-1)), 0);
  });
  await check("failed damper writes count toward the fatal limit", async () => {
    const { dev, clock, ffb } = await damperDriver();
    dev.failSends = true;
    for (let i = 0; i < 3; i++) {
      ffb.setDamper(i % 2 === 0 ? 0.6 : 0.3);
      await flush();
      clock.advance(10);
      await flush();
    }
    assert.equal(ffb.status.state, "error");
    assert.match(ffb.status.message ?? "", /Force feedback stopped/);
  });
  await check("the force keepalive counts the force's own writes: a busy damper stream does not hold it off", async () => {
    const { dev, clock, ffb } = await damperDriver();
    ffb.setForce(0.4);
    await flush();
    const n = dev.forceWrites.length;
    for (let t = 0; t < FORCE_KEEPALIVE_MS + 20; t += 10) {
      clock.advance(10);
      ffb.setDamper(t % 20 === 0 ? 0.2 : 0.8); // a damper write every 10 ms
      ffb.setForce(0.4);
      await flush();
    }
    assert.ok(conditions(dev).length > 10, "the damper kept writing");
    assert.equal(dev.forceWrites.length, n + 1, "the unchanged force went out once more");
    assert.equal(mag(dev.forceWrites.at(-1)), 4000);
  });
  await check("the keepalive is the force's alone: an unchanged damper coefficient is not resent", async () => {
    const { dev, clock, ffb } = await damperDriver();
    ffb.setDamper(0.5);
    await flush();
    assert.equal(conditions(dev).length, 1);
    clock.advance(FORCE_KEEPALIVE_MS + 20); // still inside the idle backstop
    ffb.setDamper(0.5);
    await flush();
    clock.advance(5);
    await flush();
    assert.equal(conditions(dev).length, 1);
  });
  await check("emergencyStop(): the hardware damper is zeroed with the force, before Stop All", async () => {
    const { dev, clock, ffb } = await damperDriver();
    ffb.setForce(0.5);
    ffb.setDamper(0.6);
    await flush();
    clock.advance(5);
    await flush();
    assert.equal(coeff(conditions(dev).at(-1)), 6000);
    dev.log.length = 0;
    ffb.emergencyStop();
    assert.deepEqual(dev.log, [
      { kind: "out", id: 5, data: [3, 0, 0] },
      { kind: "out", id: 3, data: [4, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x27, 0x10, 0x27, 0, 0] }, // damper block 4, coefficient 0
      { kind: "out", id: 12, data: [3] },
    ]);
  });
  await check("dispose(): the damper block is stopped and freed with the constant force", async () => {
    const { dev, ffb } = await damperDriver();
    await ffb.dispose();
    assert.deepEqual(dev.log, [
      { kind: "out", id: 5, data: [3, 0, 0] },
      { kind: "out", id: 10, data: [3, 3, 0] },
      { kind: "out", id: 10, data: [4, 3, 0] }, // damper stopped
      { kind: "out", id: 11, data: [3] },
      { kind: "out", id: 11, data: [4] }, // damper freed
      { kind: "out", id: 12, data: [3] },
      { kind: "out", id: 12, data: [2] },
    ]);
  });

  console.log("Friction and inertia (condition effects set up on request)");
  /** Constant force, spring, damper, inertia, friction: every condition type the driver knows */
  const allConditionCols = () => damperCollections({ types: [0x26, 0x40, 0x41, 0x42, 0x43] });
  const creates = (dev: FakeHidDevice) => dev.log.filter((l) => l.kind === "feature" && l.id === 17);
  /** Positive saturation of a Set Condition write, 0..10000 */
  const saturation = (w: Logged) => (w.data[8] as number) | ((w.data[9] as number) << 8);

  await check("a wheel offering friction and inertia: set up as before (constant force + damper) until they are asked for", async () => {
    const cols = allConditionCols();
    assert.deepEqual(asLayout(cols).conditions, ["damper", "friction", "inertia"]);
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    dev.laterBlocks = [4, 5, 6];
    const ffb = new WebHidFfb(fakeHid([dev]).api, new FakeClock().deps);
    await ffb.connect();
    assert.equal(creates(dev).length, 2, "Create New Effect for the constant force and the damper only");
    assert.equal(ffb.offersCondition("friction"), true);
    assert.equal(ffb.hasHardwareCondition("friction"), false);
    assert.equal(ffb.hasHardwareCondition("inertia"), false);
    // The same traffic a damper-only wheel gets
    const plainCols = damperCollections();
    const plain = new FakeHidDevice(plainCols, asLayout(plainCols).blockLoad);
    plain.laterBlocks = [4, 5, 6];
    await new WebHidFfb(fakeHid([plain]).api, new FakeClock().deps).connect();
    const strip = (d: FakeHidDevice) => d.log.map((l) => `${l.kind}:${l.id}:${l.kind === "feature" && l.id === 17 ? "" : l.data.join(",")}`);
    assert.deepEqual(strip(dev), strip(plain));
  });
  await check("friction and inertia asked for: own blocks, saturation 30 %, their own streams; stop, emergency stop and dispose cover them", async () => {
    const cols = allConditionCols();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    dev.laterBlocks = [4, 5, 6];
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([dev], [dev]).api, clock.deps);
    ffb.setWantedConditions({ friction: true, inertia: true });
    await ffb.connect();
    assert.equal(creates(dev).length, 4);
    assert.equal(ffb.hasHardwareCondition("friction"), true);
    assert.equal(ffb.hasHardwareCondition("inertia"), true);
    const setup = conditions(dev);
    assert.deepEqual(setup.map((w) => w.data[0]), [4, 5, 6], "damper, friction, inertia each on their own block");
    assert.deepEqual(setup.map(saturation), [10000, 3000, 3000]);
    assert.ok(setup.every((w) => coeff(w) === 0), "all start at coefficient 0");
    dev.log.length = 0;
    clock.advance(10);
    ffb.setCondition("friction", 0.5);
    await flush();
    clock.advance(5);
    await flush();
    ffb.setCondition("inertia", 1);
    await flush();
    clock.advance(5);
    await flush();
    const live = conditions(dev);
    // The coefficient is scaled by the 30 % cap too: 0.5 → 0.15, 1 → 0.3
    assert.deepEqual(live.map((w) => [w.data[0], coeff(w), saturation(w)]), [[5, 1500, 3000], [6, 3000, 3000]]);
    dev.log.length = 0;
    ffb.stop();
    await settle();
    clock.advance(10);
    await settle();
    const zeroed = new Set(conditions(dev).filter((w) => coeff(w) === 0).map((w) => w.data[0]));
    assert.ok(zeroed.has(5) && zeroed.has(6), "stop() zeroes friction and inertia");
    ffb.setCondition("friction", 0.5);
    await flush();
    clock.advance(5);
    await flush();
    dev.log.length = 0;
    ffb.emergencyStop();
    const em = conditions(dev);
    assert.deepEqual(em.map((w) => [w.data[0], coeff(w)]), [[4, 0], [5, 0], [6, 0]], "emergency stop zeroes every condition");
    dev.laterBlocks = [7, 8, 9, 10];
    assert.equal(await ffb.resume(), "Fake DD Base");
    assert.equal(ffb.hasHardwareCondition("inertia"), true, "set up again with what was asked for");
    dev.log.length = 0;
    await ffb.dispose();
    const ops = dev.log.filter((l) => l.kind === "out" && l.id === 10).map((l) => l.data[0]);
    const frees = dev.log.filter((l) => l.kind === "out" && l.id === 11).map((l) => l.data[0]);
    assert.equal(ops.length, 4, "stop for the constant force and each condition");
    assert.equal(frees.length, 4, "every block freed");
  });
  await check("friction switched on while the wheel runs sets it up again with friction; switching it off does not", async () => {
    const cols = allConditionCols();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    dev.laterBlocks = [4, 5, 6, 7, 8, 9];
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([dev], [dev]).api, clock.deps);
    await ffb.connect();
    assert.equal(ffb.hasHardwareCondition("friction"), false);
    const seen: boolean[] = [];
    ffb.subscribe(() => seen.push(ffb.offersCondition("friction")));
    ffb.setWantedConditions({ friction: true });
    await settle();
    assert.ok(seen.length > 0 && seen.every(Boolean), "the friction setting stays offered through the new setup");
    assert.equal(ffb.status.state, "ready");
    assert.equal(ffb.hasHardwareCondition("friction"), true);
    assert.equal(ffb.hasHardwareCondition("inertia"), false);
    const before = creates(dev).length;
    ffb.setWantedConditions({ friction: false });
    await settle();
    assert.equal(creates(dev).length, before, "no new setup to drop it: it stays at the coefficient the game sends (0)");
    ffb.setWantedConditions({ friction: true });
    await settle();
    assert.equal(creates(dev).length, before, "already running: no new setup");
  });
  await check("a wheel without friction / inertia ignores the request: no new setup, no stream", async () => {
    const cols = damperCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    dev.laterBlocks = [4];
    const ffb = new WebHidFfb(fakeHid([dev], [dev]).api, new FakeClock().deps);
    await ffb.connect();
    const before = dev.log.length;
    ffb.setWantedConditions({ friction: true, inertia: true });
    await settle();
    ffb.setCondition("friction", 1);
    await settle();
    assert.equal(dev.log.length, before);
    assert.equal(ffb.offersCondition("friction"), false);
  });

  console.log("Classic Logitech wheels (hid-lg4ff commands)");
  /**
   * Reference commands written by hand from Linux drivers/hid/hid-lg4ff.c, not from this driver's output. All 7-byte
   * writes to the first output report (report id 0 on these wheels).
   */
  const LG4FF = {
    /** lg4ff_set_autocenter_default(dev, 0): "De-activate Auto-Center" */
    springOff: [0xf5, 0, 0, 0, 0, 0, 0],
    /** lg4ff_set_range_g25: f8 81, range low byte, high byte. 540 = 0x021c, 900 = 0x0384 */
    range540: [0xf8, 0x81, 0x1c, 0x02, 0, 0, 0],
    range900: [0xf8, 0x81, 0x84, 0x03, 0, 0, 0],
    /** lg4ff_play, FF_CONSTANT: x = level + 0x80; x == 0x80 de-activates slot 1, otherwise 11 08 x 80 */
    forceOff: [0x13, 0, 0, 0, 0, 0, 0],
    forceMax: [0x11, 0x08, 0xff, 0x80, 0, 0, 0],
    forceMin: [0x11, 0x08, 0x00, 0x80, 0, 0, 0],
    /**
     * lg4ff_set_autocenter_default(dev, 0xffff) on a non-MOMO wheel: expand_a = (0x0c * 0xaaaa + 0x06 * 0x5555) >> 1
     * = 327675, / 0xaaaa = 7; expand_b = 0x80 * 0xaaaa + 0xff * 0x5555 = 11162795, / 0xaaaa = 255; then "Activate"
     */
    springParamsFull: [0xfe, 0x0d, 0x07, 0x07, 0xff, 0, 0],
    springOn: [0x14, 0, 0, 0, 0, 0, 0],
    /** lg4ff_set_leds (G27 / G29 only): f8 12, then the 5-bit mask, RPM1 = bit 0 */
    ledsOff: [0xf8, 0x12, 0, 0, 0, 0, 0],
    leds3: [0xf8, 0x12, 0x07, 0, 0, 0, 0],
    ledsAll: [0xf8, 0x12, 0x1f, 0, 0, 0, 0],
  };
  /** A wheel's HID interface with lg4ff's output report: no report id, 7 one-byte values */
  const logitech = (productId: number, name: string) => {
    const dev = new FakeHidDevice([
      {
        usagePage: 0x01,
        usage: 0x04,
        inputReports: [{ reportId: 0, items: [variable([X], 16, 1, 0, 65535)] }],
        outputReports: [{ reportId: 0, items: [variable([(0xff00 << 16) | 1], 8, 7, 0, 255)] }],
      },
    ]);
    dev.vendorId = 0x046d;
    dev.productId = productId;
    dev.productName = name;
    return dev;
  };
  const writes = (dev: FakeHidDevice) => dev.log.map((l) => (l.kind === "out" && l.id === 0 ? l.data : ["other", l.kind, l.id]));

  await check("G29: connect = spring off then the wheel rotation (lg4ff_init order); no force until the game sends one", async () => {
    const g29 = logitech(0xc24f, "Logitech G29 Driving Force Racing Wheel");
    const ffb = new WebHidFfb(fakeHid([g29]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    assert.equal(await ffb.connect(), "Logitech G29 Driving Force Racing Wheel");
    assert.equal(ffb.status.state, "ready");
    assert.deepEqual(writes(g29), [LG4FF.springOff, LG4FF.range540]);
    assert.equal(ffb.hasHardwareDamper(), false);
  });
  await check("G29: force bytes follow lg4ff_play; zero switches slot 1 off", async () => {
    const g29 = logitech(0xc24f, "G29");
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g29]).api, clock.deps);
    await ffb.connect();
    g29.log.length = 0;
    for (const f of [1, -1, 0]) {
      ffb.setForce(f);
      await flush();
      clock.advance(5);
      await flush();
    }
    assert.deepEqual(writes(g29), [LG4FF.forceMax, LG4FF.forceMin, LG4FF.forceOff]);
  });
  await check("G27: a rotation change while running is sent; dispose puts 900° and the full centring spring back", async () => {
    const g27 = logitech(0xc29b, "G27");
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g27]).api, clock.deps);
    ffb.setRotationDeg(1080); // outside 40..900: lg4ff_range_store ignores it, the wheel keeps its own range
    await ffb.connect();
    assert.deepEqual(writes(g27), [LG4FF.springOff]);
    ffb.setRotationDeg(540);
    await flush();
    assert.deepEqual(writes(g27).at(-1), LG4FF.range540);
    g27.log.length = 0;
    await ffb.dispose();
    assert.deepEqual(writes(g27), [LG4FF.forceOff, LG4FF.ledsOff, LG4FF.range900, LG4FF.springParamsFull, LG4FF.springOn]);
    assert.equal(g27.opened, false);
  });
  await check("G29 rev LEDs: lg4ff_set_leds bytes, only changes written, stop() and dispose turn them off", async () => {
    const g29 = logitech(0xc24f, "G29");
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g29]).api, clock.deps);
    await ffb.connect();
    assert.equal(ffb.hasRevLeds(), true);
    assert.deepEqual(writes(g29), [LG4FF.springOff], "no LED write at connect");
    g29.log.length = 0;
    for (const mask of [0x07, 0x07, 0x1f, 0xff]) {
      ffb.setRevLeds(mask);
      await flush();
      clock.advance(5);
      await flush();
    }
    assert.deepEqual(writes(g29), [LG4FF.leds3, LG4FF.ledsAll], "unchanged masks are not resent; bits past RPM5 are dropped");
    g29.log.length = 0;
    ffb.stop();
    await flush();
    assert.ok(writes(g29).some((w) => JSON.stringify(w) === JSON.stringify(LG4FF.ledsOff)), "stop() turns the LEDs off");
    ffb.setRevLeds(0x07);
    await flush();
    clock.advance(5);
    await flush();
    g29.log.length = 0;
    ffb.emergencyStop();
    await flush();
    assert.deepEqual(writes(g29)[1], LG4FF.ledsOff, "emergency stop: LEDs off right after the force");
  });
  await check("Driving Force GT and G25: no rev LEDs, nothing written for them", async () => {
    for (const [productId, name] of [[0xc29a, "Driving Force GT"], [0xc299, "G25"]] as const) {
      const dev = logitech(productId, name);
      const clock = new FakeClock();
      const ffb = new WebHidFfb(fakeHid([dev]).api, clock.deps);
      await ffb.connect();
      assert.equal(ffb.hasRevLeds(), false, name);
      dev.log.length = 0;
      ffb.setRevLeds(0x1f);
      await flush();
      clock.advance(5);
      await flush();
      assert.deepEqual(writes(dev), [], name);
    }
  });
  await check("Driving Force GT: the range is never restored when it was never set", async () => {
    const dfgt = logitech(0xc29a, "Driving Force GT");
    const ffb = new WebHidFfb(fakeHid([dfgt]).api, new FakeClock().deps);
    await ffb.connect();
    dfgt.log.length = 0;
    await ffb.dispose();
    assert.deepEqual(writes(dfgt), [LG4FF.forceOff, LG4FF.springParamsFull, LG4FF.springOn]);
  });
  await check("a Logitech gamepad, the DFP, the PlayStation G923 and the G PRO are refused and never opened", async () => {
    for (const [productId, name] of [
      [0xc216, "Logitech Dual Action"],
      [0xc298, "Driving Force Pro"],
      [0xc267, "G923 Racing Wheel for PlayStation and PC"],
      [0xc272, "PRO Racing Wheel"],
    ] as const) {
      const dev = logitech(productId, name);
      const ffb = new WebHidFfb(fakeHid([dev]).api, new FakeClock().deps);
      assert.equal(await ffb.connect(), null, name);
      assert.equal(ffb.status.state, "unsupported", name);
      assert.match(ffb.status.message ?? "", /bridge/, name);
      assert.equal(dev.opened, false, name);
      assert.equal(dev.log.length, 0, name);
    }
  });
  await check("a listed wheel's interface without lg4ff's 7-byte output report is refused", async () => {
    const g29 = logitech(0xc24f, "G29");
    g29.collections = [{ usagePage: 0x01, usage: 0x04, outputReports: [{ reportId: 0, items: [variable([(0xff00 << 16) | 1], 8, 2, 0, 255)] }] }];
    const ffb = new WebHidFfb(fakeHid([g29]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "unsupported");
    assert.equal(g29.opened, false);
  });
  await check("a Logitech device with a HID PID descriptor takes the PID path", async () => {
    const dev = wheel();
    dev.vendorId = 0x046d;
    dev.productName = "Logitech PID";
    const ffb = new WebHidFfb(fakeHid([dev]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), "Logitech PID");
    assert.ok(dev.forceWrites.length > 0, "PID Set Constant Force sent");
  });

  console.log("HID++ Logitech wheels (hid-logitech-hidpp, feature 0x8123)");
  /**
   * Reference messages written by hand from Linux drivers/hid/hid-logitech-hidpp.c, not from this driver's output: the
   * data bytes after the report id (0x11 long: 19 bytes, 0x12 very long: 63 here), zero-padded. Each one is device
   * index ff, feature index, function << 4 | software id a (not the kernel's 1), then the parameters. The fake wheel
   * puts feature 0x8123 at index 0b, offers 4 slots (one reserved), reports 900° and gain ffff, and hands out slot 1
   * (the centring spring) then 2 (the constant force).
   */
  const msg = (id: 0x11 | 0x12, text: string) => {
    const b = text.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
    const length = id === 0x11 ? 19 : 63;
    assert.ok(b.length <= length);
    return { id, data: [...b, ...new Array<number>(length - b.length).fill(0)] };
  };
  const HIDPP = {
    /** hidpp_root_get_feature(HIDPP_PAGE_G920_FORCE_FEEDBACK): root index 00, function 0, 81 23 */
    lookup: msg(0x11, "ff 00 0a 81 23"),
    /** g920_get_config, in order: HIDPP_FF_GET_INFO, _RESET_ALL, _GET_APERTURE, _GET_GLOBAL_GAINS */
    info: msg(0x11, "ff 0b 0a"),
    reset: msg(0x11, "ff 0b 1a"),
    getAperture: msg(0x11, "ff 0b 5a"),
    getGains: msg(0x11, "ff 0b 7a"),
    /** g920_ff_set_autocenter: download a spring (06) | autostart (80) into a new slot, every other parameter 0; 18 parameters, so a very long report */
    springZero: msg(0x12, "ff 0b 2a 00 86"),
    /** hidpp_ff_range_store: SET_APERTURE, degrees big-endian. 540 = 02 1c, 900 = 03 84 */
    aperture540: msg(0x11, "ff 0b 6a 02 1c"),
    aperture900: msg(0x11, "ff 0b 6a 03 84"),
    /**
     * hidpp_ff_upload_effect, FF_CONSTANT: slot, type 00, length 00 00, delay 00 00, level big-endian, empty envelope.
     * Slot 00 asks for a new one; 02 is the slot the fake handed out
     */
    constantNew: msg(0x11, "ff 0b 2a 00 00 00 00 00 00 00 00"),
    level: (hi: number, lo: number) => msg(0x11, `ff 0b 2a 02 00 00 00 00 00 ${hi.toString(16)} ${lo.toString(16)}`),
    /** hidpp_ff_playback: SET_EFFECT_STATE slot 02, play 02 / stop 01 */
    play: msg(0x11, "ff 0b 3a 02 02"),
    stop: msg(0x11, "ff 0b 3a 02 01"),
    /** hidpp_ff_erase_effect: DESTROY_EFFECT slot 02 */
    destroy: msg(0x11, "ff 0b 4a 02"),
    /**
     * hidpp_ff_set_autocenter(0xffff) into the spring's slot 01: saturation 0xffff >> 1 = 7f ff, coefficient
     * 0xffff >> 3 = 1f ff, left then right, no dead band, centre 0
     */
    springFull: msg(0x12, "ff 0b 2a 01 86 00 00 00 00 7f ff 1f ff 00 00 00 00 1f ff 7f ff"),
  };
  /** A G920's HID++ interface: long (0x11) and very long (0x12) reports on a vendor-defined collection */
  const hidppCollections = (o: { veryLong?: boolean } = {}): HidCollectionLike[] => [
    {
      usagePage: 0xff43,
      usage: 0x0602,
      inputReports: [{ reportId: 0x11, items: [variable([(0xff43 << 16) | 0x0602], 8, 19, 0, 255)] }],
      outputReports: [
        { reportId: 0x11, items: [variable([(0xff43 << 16) | 0x0602], 8, 19, 0, 255)] },
        ...(o.veryLong === false ? [] : [{ reportId: 0x12, items: [variable([(0xff43 << 16) | 0x0604], 8, 63, 0, 255)] }]),
      ],
    },
  ];
  class FakeHidppWheel extends FakeHidDevice {
    /** Index the wheel gives feature 0x8123 (0: it does not list it) */
    featureIndex = 0x0b;
    /** Answers nothing at all */
    silent = false;
    /** Busy replies still to give, by (feature index << 8 | function byte) */
    busy = new Map<number, number>();
    /** Error code to answer with, by (feature index << 8 | function byte) */
    errors = new Map<number, number>();
    private nextSlot = 1;
    private input: ((e: HidInputReportEventLike) => void)[] = [];
    constructor(productId = 0xc262, name = "G920 Driving Force Racing Wheel", collections = hidppCollections()) {
      super(collections);
      this.vendorId = 0x046d;
      this.productId = productId;
      this.productName = name;
    }
    addEventListener(_type: "inputreport", l: (e: HidInputReportEventLike) => void) {
      this.input.push(l);
    }
    removeEventListener(_type: "inputreport", l: (e: HidInputReportEventLike) => void) {
      this.input = this.input.filter((x) => x !== l);
    }
    get inputListeners() {
      return this.input.length;
    }
    override async sendReport(reportId: number, data: Uint8Array) {
      await super.sendReport(reportId, data);
      const reply = this.answer([...data]);
      if (!reply) return;
      setImmediate(() => {
        const view = new DataView(new Uint8Array(reply).buffer);
        for (const l of [...this.input]) l({ reportId: 0x11, data: view });
      });
    }
    /** The wheel's answer to one message, as the data of an input report 0x11 (hand-written, not the driver's builders) */
    private answer(m: number[]): number[] | null {
      if (this.silent) return null;
      const feature = m[1] as number;
      const fn = m[2] as number;
      const pad = (b: number[]) => [...b, ...new Array<number>(19 - b.length).fill(0)];
      const key = (feature << 8) | fn;
      const busy = this.busy.get(key) ?? 0;
      if (busy > 0) {
        this.busy.set(key, busy - 1);
        return pad([0xff, 0xff, feature, fn, 0x08]);
      }
      const error = this.errors.get(key);
      if (error !== undefined) return pad([0xff, 0xff, feature, fn, error]);
      const ok = (params: number[]) => pad([0xff, feature, fn, ...params]);
      if (feature === 0x00 && fn === 0x0a) return ok([this.featureIndex]);
      if (feature !== this.featureIndex) return null;
      if (fn === 0x1a) this.nextSlot = 1; // RESET_ALL frees every slot
      if (fn === 0x0a) return ok([0x04]); // GET_INFO: 4 slots
      if (fn === 0x5a) return ok([0x03, 0x84]); // GET_APERTURE: 900°
      if (fn === 0x7a) return ok([0xff, 0xff, 0x00]); // GET_GLOBAL_GAINS: ffff, no boost
      if (fn === 0x2a) return ok([(m[3] as number) || this.nextSlot++]); // DOWNLOAD_EFFECT: the effect's slot
      return ok([]);
    }
  }
  const outs = (dev: FakeHidDevice) => dev.log.filter((l) => l.kind === "out").map((l) => ({ id: l.id, data: l.data }));
  /** Lets a write go out and its reply come back, with the 2 ms spacing passed */
  const step = async (clock: FakeClock) => {
    await settle();
    clock.advance(5);
    await settle();
  };

  await check("G920: feature lookup, then g920_get_config's order, the rotation, then the constant force downloaded and played", async () => {
    const g920 = new FakeHidppWheel();
    const { api, requests } = fakeHid([g920]);
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    assert.equal(await ffb.connect(), "G920 Driving Force Racing Wheel");
    assert.equal(ffb.status.state, "ready");
    assert.deepEqual(outs(g920), [
      HIDPP.lookup,
      HIDPP.info,
      HIDPP.reset,
      HIDPP.getAperture,
      HIDPP.getGains,
      HIDPP.springZero,
      HIDPP.aperture540,
      HIDPP.constantNew,
      HIDPP.play,
    ]);
    assert.equal(ffb.hasHardwareDamper(), false);
    assert.equal(ffb.hasRevLeds(), false);
    const filters = requests[0]?.filters ?? [];
    for (const productId of [0xc262, 0xc26e]) {
      assert.ok(filters.some((f) => f.vendorId === 0x046d && f.productId === productId), "every interface of the wheel is offered");
    }
  });
  await check("the feature index is the one the lookup returns, never a fixed number", async () => {
    const g923 = new FakeHidppWheel(0xc26e, "G923 Racing Wheel for Xbox One and PC");
    g923.featureIndex = 0x05;
    const ffb = new WebHidFfb(fakeHid([g923]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), "G923 Racing Wheel for Xbox One and PC");
    const sent = outs(g923);
    assert.deepEqual(sent[0], HIDPP.lookup);
    assert.deepEqual(sent[1], msg(0x11, "ff 05 0a"));
    assert.ok(sent.slice(1).every((w) => w.data[1] === 0x05));
  });
  await check("a wheel that does not list feature 0x8123 is unsupported, gets nothing past the lookup and is closed", async () => {
    const g920 = new FakeHidppWheel();
    g920.featureIndex = 0;
    const ffb = new WebHidFfb(fakeHid([g920]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "unsupported");
    assert.match(ffb.status.message ?? "", /feature 0x8123/);
    assert.deepEqual(outs(g920), [HIDPP.lookup]);
    assert.equal(g920.opened, false);
    assert.equal(g920.inputListeners, 0, "stops listening for replies");
  });
  await check("force: the level is downloaded again into its slot, big-endian, + force a + level", async () => {
    const g920 = new FakeHidppWheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g920]).api, clock.deps);
    await ffb.connect();
    g920.log.length = 0;
    for (const f of [1, -1, 0.5, 0]) {
      ffb.setForce(f);
      await step(clock);
    }
    // 0x7fff, -0x7fff = 0x8001, round(0.5 * 0x7fff) = 0x4000, 0
    assert.deepEqual(outs(g920), [HIDPP.level(0x7f, 0xff), HIDPP.level(0x80, 0x01), HIDPP.level(0x40, 0x00), HIDPP.level(0, 0)]);
  });
  await check("a streamed level waits for the reply to the one before, at most the stream wait", async () => {
    const g920 = new FakeHidppWheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g920]).api, clock.deps);
    await ffb.connect();
    g920.log.length = 0;
    g920.silent = true;
    ffb.setForce(1);
    await step(clock);
    ffb.setForce(-1);
    await step(clock);
    assert.deepEqual(outs(g920), [HIDPP.level(0x7f, 0xff)], "the second level waits for a reply");
    clock.advance(HIDPP_STREAM_REPLY_MS);
    await step(clock);
    assert.deepEqual(outs(g920), [HIDPP.level(0x7f, 0xff), HIDPP.level(0x80, 0x01)], "no reply in time: counted as sent");
    assert.equal(ffb.status.state, "ready", "a missing reply is not a failure");
  });
  await check("stop(): the zero goes out at once, and again when the wheel answers busy", async () => {
    const g920 = new FakeHidppWheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g920]).api, clock.deps);
    await ffb.connect();
    ffb.setForce(1);
    await step(clock);
    g920.log.length = 0;
    g920.busy.set((0x0b << 8) | 0x2a, 1);
    ffb.stop();
    await settle();
    assert.deepEqual(outs(g920), [HIDPP.level(0, 0), HIDPP.level(0, 0)], "a zero the wheel was too busy to take is sent again");
    assert.equal(ffb.status.state, "ready");
  });
  await check("rotation while running, clamped as hidpp_ff_range_store clamps; dispose: zero, stop, erase, rotation back, centring spring", async () => {
    const g920 = new FakeHidppWheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g920]).api, clock.deps);
    ffb.setRotationDeg(540);
    await ffb.connect();
    g920.log.length = 0;
    ffb.setRotationDeg(1080);
    await step(clock);
    assert.deepEqual(outs(g920), [HIDPP.aperture900]);
    ffb.setRotationDeg(540);
    await step(clock);
    g920.log.length = 0;
    await ffb.dispose();
    assert.deepEqual(outs(g920), [HIDPP.level(0, 0), HIDPP.stop, HIDPP.destroy, HIDPP.aperture900, HIDPP.springFull]);
    assert.equal(g920.opened, false);
    assert.equal(g920.inputListeners, 0);
  });
  await check("no rotation setting: the wheel's own rotation is never written, at setup or teardown", async () => {
    const g920 = new FakeHidppWheel();
    const ffb = new WebHidFfb(fakeHid([g920]).api, new FakeClock().deps);
    await ffb.connect();
    await ffb.dispose();
    assert.ok(!outs(g920).some((w) => w.data[2] === 0x6a), "no SET_APERTURE");
    assert.deepEqual(outs(g920).slice(-4), [HIDPP.level(0, 0), HIDPP.stop, HIDPP.destroy, HIDPP.springFull]);
  });
  await check("emergencyStop(): the release messages all go out at once, in order, without waiting for a reply", async () => {
    const g920 = new FakeHidppWheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g920]).api, clock.deps);
    ffb.setRotationDeg(540);
    await ffb.connect();
    ffb.setForce(1);
    await step(clock);
    g920.log.length = 0;
    g920.silent = true;
    ffb.emergencyStop();
    assert.deepEqual(outs(g920), [HIDPP.level(0, 0), HIDPP.stop, HIDPP.destroy, HIDPP.aperture900, HIDPP.springFull]);
    ffb.setForce(1);
    await step(clock);
    assert.equal(outs(g920).length, 5, "nothing after them");
    assert.equal(g920.inputListeners, 0);
  });
  await check("an error reply part-way through setup: an error (not unsupported), and what was taken is given back", async () => {
    const g920 = new FakeHidppWheel();
    g920.errors.set((0x0b << 8) | 0x3a, 0x05); // SET_EFFECT_STATE: not allowed
    const ffb = new WebHidFfb(fakeHid([g920]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "error");
    assert.match(ffb.status.message ?? "", /HID\+\+ error 0x05/);
    assert.deepEqual(outs(g920).slice(-4), [HIDPP.play, HIDPP.destroy, HIDPP.aperture900, HIDPP.springFull]);
    assert.equal(g920.opened, false);
  });
  await check("a busy reply: the command is sent again, 3 times at most (hidpp_send_message_sync)", async () => {
    const g920 = new FakeHidppWheel();
    g920.busy.set((0x0b << 8) | 0x0a, 2);
    const ffb = new WebHidFfb(fakeHid([g920]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), "G920 Driving Force Racing Wheel");
    assert.deepEqual(outs(g920).slice(0, 5), [HIDPP.lookup, HIDPP.info, HIDPP.info, HIDPP.info, HIDPP.reset]);
    const stubborn = new FakeHidppWheel();
    stubborn.busy.set((0x0b << 8) | 0x0a, 3);
    const ffb2 = new WebHidFfb(fakeHid([stubborn]).api, new FakeClock().deps);
    assert.equal(await ffb2.connect(), null);
    assert.equal(ffb2.status.state, "error");
    assert.deepEqual(outs(stubborn).slice(0, 4), [HIDPP.lookup, HIDPP.info, HIDPP.info, HIDPP.info]);
  });
  await check(`a wheel that does not answer: the setup fails after ${HIDPP_REPLY_TIMEOUT_MS} ms as an error, not unsupported (reconnect retries it)`, async () => {
    const g920 = new FakeHidppWheel();
    g920.silent = true;
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([g920]).api, clock.deps);
    const connecting = ffb.connect();
    await settle();
    assert.equal(ffb.status.state, "connecting");
    clock.advance(HIDPP_REPLY_TIMEOUT_MS);
    assert.equal(await connecting, null);
    assert.equal(ffb.status.state, "error");
    assert.equal(isFatalHidStatus(ffb.status), true);
    assert.match(ffb.status.message ?? "", /did not answer/);
    assert.deepEqual(outs(g920), [HIDPP.lookup], "nothing to give back: no feature index yet");
  });
  await check("an interface of a listed HID++ wheel without the reports it needs is refused before it is opened", async () => {
    const noLong = logitech(0xc262, "G920");
    const ffb = new WebHidFfb(fakeHid([noLong]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "unsupported");
    assert.match(ffb.status.message ?? "", /no HID\+\+ long report/);
    const noVeryLong = new FakeHidppWheel(0xc262, "G920", hidppCollections({ veryLong: false }));
    const ffb2 = new WebHidFfb(fakeHid([noVeryLong]).api, new FakeClock().deps);
    assert.equal(await ffb2.connect(), null);
    assert.equal(ffb2.status.state, "unsupported");
    assert.match(ffb2.status.message ?? "", /very long report/);
    for (const d of [noLong, noVeryLong]) {
      assert.equal(d.opened, false);
      assert.equal(d.log.length, 0);
    }
  });
  await check("a G920 with an input-only interface next to its HID++ one: the HID++ interface is driven", async () => {
    const joystick = new FakeHidDevice([{ usagePage: 0x01, usage: 0x04, inputReports: [{ reportId: 1, items: [variable([X], 16, 1, 0, 65535)] }] }]);
    joystick.vendorId = 0x046d;
    joystick.productId = 0xc262;
    joystick.productName = "G920 Driving Force Racing Wheel";
    const hidpp = new FakeHidppWheel();
    const ffb = new WebHidFfb(fakeHid([joystick, hidpp]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), "G920 Driving Force Racing Wheel");
    assert.equal(joystick.opened, false);
    assert.equal(hidpp.opened, true);
  });
  await check("a granted G920 reopens on reconnect and on its connect event", async () => {
    const g920 = new FakeHidppWheel();
    const clock = new FakeClock();
    const { api, listeners, connectListeners } = fakeHid([], [g920]);
    const ffb = new WebHidFfb(api, clock.deps);
    assert.equal(await ffb.reconnect(), "G920 Driving Force Racing Wheel");
    for (const l of listeners) l({ device: g920 });
    assert.equal(ffb.status.state, "idle");
    g920.opened = false;
    for (const l of [...connectListeners]) l({ device: g920 });
    clock.advance(HOTPLUG_DELAY_MS);
    await settle();
    assert.equal(ffb.status.state, "ready");
  });

  console.log("WebHidFfb driver");

  await check("connect(): picks, sets up, reports ready with the device name", async () => {
    const dev = wheel();
    const { api, listeners } = fakeHid([dev]);
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    const seen: WebHidFfbStatus[] = [];
    ffb.onStatus = (s) => seen.push(s);
    assert.equal(ffb.status.state, "idle");
    assert.equal(await ffb.connect(), "Fake DD Base");
    assert.equal(ffb.status.state, "ready");
    assert.equal(seen[0]?.state, "connecting");
    assert.equal(seen.at(-1)?.state, "ready");
    assert.equal(seen.at(-1)?.device, "Fake DD Base");
    assert.equal(listeners.length, 1);
    ffb.setForce(0.5);
    await flush();
    assert.equal(dev.forceWrites.length, 2); // setup zero + 0.5
  });
  await check("connect(): no device chosen resolves null and stays idle", async () => {
    const ffb = new WebHidFfb(fakeHid([]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "idle");
    assert.match(ffb.status.message ?? "", /No wheel/);
  });
  await check("connect() & reconnect(): multi-interface wheel (e.g. PXN V99) skips input-only interface and picks PID interface", async () => {
    const inputOnly = new FakeHidDevice([{ usagePage: 0x01, usage: 0x04, inputReports: [{ reportId: 1, items: [variable([X], 16, 1, 0, 65535)] }] }]);
    inputOnly.productName = "PXN V99 Input";
    const pidInterface = wheel();
    pidInterface.productName = "PXN V99 FFB";
    const ffb = new WebHidFfb(fakeHid([inputOnly, pidInterface]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), "PXN V99 FFB");
    assert.equal(inputOnly.opened, false);
    assert.equal(pidInterface.opened, true);

    const reconn = new WebHidFfb(fakeHid([], [inputOnly, pidInterface]).api, new FakeClock().deps);
    assert.equal(await reconn.reconnect(), "PXN V99 FFB");
    assert.equal(reconn.status.state, "ready");
  });
  await check("connect(): a non-PID pick (plain gamepad) is unsupported", async () => {
    const dev = new FakeHidDevice([{ usagePage: 0x01, usage: 0x05 }]);
    const ffb = new WebHidFfb(fakeHid([dev]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "unsupported");
  });
  await check("connect(): requestDevice throwing (no user gesture) is an error status", async () => {
    const api = fakeHid([]).api;
    api.requestDevice = async () => {
      throw new Error("Must be handling a user gesture to show a permission request.");
    };
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "error");
    assert.match(ffb.status.message ?? "", /user gesture/);
  });
  await check("reconnect(): reuses a granted PID device without a prompt, skips others, null when none", async () => {
    const pad = new FakeHidDevice([{ usagePage: 0x01, usage: 0x05 }]);
    pad.productName = "Pad";
    const dev = wheel();
    let prompted = false;
    const { api } = fakeHid([], [pad, dev]);
    api.requestDevice = async () => {
      prompted = true;
      return [];
    };
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    assert.equal(await ffb.reconnect(), "Fake DD Base");
    assert.equal(prompted, false);
    assert.equal(ffb.status.state, "ready");
    const none = new WebHidFfb(fakeHid([], [pad]).api, new FakeClock().deps);
    assert.equal(await none.reconnect(), null);
    assert.equal(none.status.state, "idle");
  });
  await check("reconnect(): a granted DualSense-style device (output reports, no PID) or an unlisted Logitech stays idle, not fatal", async () => {
    const dualSense = new FakeHidDevice([
      {
        usagePage: 0x01,
        usage: 0x05,
        inputReports: [{ reportId: 1, items: [variable([X], 8, 1, 0, 255)] }],
        outputReports: [{ reportId: 2, items: [variable([(0xff00 << 16) | 0x22], 8, 47, 0, 255)] }],
      },
    ]);
    dualSense.vendorId = 0x054c;
    dualSense.productId = 0x0ce6;
    dualSense.productName = "DualSense Wireless Controller";
    const dfp = logitech(0xc298, "Driving Force Pro");
    const ffb = new WebHidFfb(fakeHid([], [dualSense, dfp]).api, new FakeClock().deps);
    assert.equal(await ffb.reconnect(), null);
    assert.equal(ffb.status.state, "idle");
    assert.equal(ffb.status.message, PAIR_MESSAGE);
    assert.equal(isFatalHidStatus(ffb.status), false);
    for (const d of [dualSense, dfp]) {
      assert.equal(d.opened, false);
      assert.equal(d.log.length, 0);
    }
  });
  await check("reconnect(): a granted listed Logitech wheel reopens", async () => {
    const g29 = logitech(0xc24f, "G29");
    const ffb = new WebHidFfb(fakeHid([], [g29]).api, new FakeClock().deps);
    assert.equal(await ffb.reconnect(), "G29");
    assert.equal(ffb.status.state, "ready");
  });
  await check("load without a grant: reconnect() never prompts, stays idle and asks for a Connect click", async () => {
    let prompted = 0;
    const { api } = fakeHid([wheel()], []);
    api.requestDevice = async () => {
      prompted++;
      return [];
    };
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    let notified = 0;
    const unsubscribe = ffb.subscribe(() => notified++);
    assert.equal(await ffb.reconnect(), null);
    assert.equal(prompted, 0);
    assert.equal(ffb.getStatus().state, "idle");
    assert.equal(ffb.getStatus().message, PAIR_MESSAGE);
    assert.equal(isFatalHidStatus(ffb.getStatus()), false);
    assert.equal(notified, 1);
    unsubscribe();
  });
  await check("connect(): requestDevice runs synchronously inside the call (the click's user activation)", async () => {
    let prompted = false;
    const dev = wheel();
    const { api } = fakeHid([dev]);
    api.requestDevice = async () => {
      prompted = true;
      return [dev];
    };
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    const p = ffb.connect();
    assert.equal(prompted, true, "requestDevice called before connect() yields");
    assert.equal(await p, "Fake DD Base");
  });
  await check("connect() during a load-time reconnect still opens the picked wheel", async () => {
    const dev = wheel();
    const { api } = fakeHid([dev], []);
    let releaseGetDevices: () => void = () => {};
    api.getDevices = () => new Promise((resolve) => (releaseGetDevices = () => resolve([])));
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    const loading = ffb.reconnect();
    const clicked = ffb.connect();
    releaseGetDevices();
    assert.equal(await loading, null);
    assert.equal(await clicked, "Fake DD Base");
    assert.equal(ffb.status.state, "ready");
    // the effect re-running reconnect() while ready keeps the session
    assert.equal(await ffb.reconnect(), "Fake DD Base");
    assert.equal(dev.opened, true);
  });
  await check("connect(): cancelling the picker keeps a wheel that is already running", async () => {
    const dev = wheel();
    const { api } = fakeHid([dev]);
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    await ffb.connect();
    api.requestDevice = async () => [];
    assert.equal(await ffb.connect(), "Fake DD Base");
    assert.equal(ffb.status.state, "ready");
  });
  await check("fatal statuses: unsupported / write failures are fatal, dispose() keeps the reason", async () => {
    const nonFfb = new FakeHidDevice([{ usagePage: 0x01, usage: 0x05 }]);
    nonFfb.productName = "Gamepad";
    const unsupportedFfb = new WebHidFfb(fakeHid([nonFfb]).api, new FakeClock().deps);
    await unsupportedFfb.connect();
    assert.equal(isFatalHidStatus(unsupportedFfb.status), true);
    await unsupportedFfb.dispose();
    assert.match(unsupportedFfb.status.message ?? "", /HID PID/);

    const dev = wheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([dev]).api, clock.deps);
    await ffb.connect();
    dev.failSends = true;
    for (let i = 0; i < 3; i++) {
      clock.advance(10);
      ffb.setForce(i % 2 === 0 ? 0.6 : -0.6);
      await flush();
      await flush();
    }
    assert.equal(ffb.status.state, "error");
    assert.match(ffb.status.message ?? "", /Force feedback stopped/);
    await ffb.dispose();
    assert.equal(ffb.status.state, "error");
    // a clean dispose of a ready wheel goes back to idle
    const ok = new WebHidFfb(fakeHid([wheel()]).api, new FakeClock().deps);
    await ok.connect();
    await ok.dispose();
    assert.equal(ok.status.state, "idle");
    assert.equal(isFatalHidStatus({ state: "idle", device: null, message: PAIR_MESSAGE }), false);
  });
  await check("disconnect event for the open device -> idle, writes stop", async () => {
    const dev = wheel();
    const { api, listeners } = fakeHid([dev]);
    const ffb = new WebHidFfb(api, new FakeClock().deps);
    await ffb.connect();
    const other = new FakeHidDevice([]);
    other.productId = 0x9999;
    for (const l of listeners) l({ device: other }); // another device: ignored
    assert.equal(ffb.status.state, "ready");
    for (const l of listeners) l({ device: dev });
    assert.equal(ffb.status.state, "idle");
    const before = dev.forceWrites.length;
    ffb.setForce(0.9);
    await flush();
    assert.equal(dev.forceWrites.length, before);
  });
  await check(`a power-cycled wheel is re-opened ${HOTPLUG_DELAY_MS} ms after it comes back`, async () => {
    const dev = wheel();
    const clock = new FakeClock();
    const { api, listeners, connectListeners } = fakeHid([], [dev]);
    const ffb = new WebHidFfb(api, clock.deps);
    assert.equal(await ffb.reconnect(), "Fake DD Base");
    for (const l of listeners) l({ device: dev });
    assert.equal(ffb.status.state, "idle");
    dev.opened = false;
    // A multi-interface base announces each interface: one re-open, after the last
    for (const l of [...connectListeners]) l({ device: dev });
    clock.advance(HOTPLUG_DELAY_MS - 500);
    for (const l of [...connectListeners]) l({ device: dev });
    clock.advance(HOTPLUG_DELAY_MS - 1);
    await settle();
    assert.equal(ffb.status.state, "idle", "not before the wheel has settled");
    clock.advance(1);
    await settle();
    assert.equal(ffb.status.state, "ready");
    assert.equal(clock.timers.length, 0, "one re-open, no second one queued");
    // After dispose a wheel coming back is left alone
    await ffb.dispose();
    assert.equal(connectListeners.length, 0);
  });
  await check("a connect event re-opens only what the driver can drive: a listed Logitech wheel yes, a DualSense or the DFP never", async () => {
    const g29 = logitech(0xc24f, "G29");
    const clock = new FakeClock();
    const { api, listeners, connectListeners } = fakeHid([], [g29]);
    const ffb = new WebHidFfb(api, clock.deps);
    assert.equal(await ffb.reconnect(), "G29");
    for (const l of listeners) l({ device: g29 });
    assert.equal(ffb.status.state, "idle");
    const dualSense = new FakeHidDevice([
      { usagePage: 0x01, usage: 0x05, outputReports: [{ reportId: 2, items: [variable([(0xff00 << 16) | 0x22], 8, 47, 0, 255)] }] },
    ]);
    dualSense.vendorId = 0x054c;
    const dfp = logitech(0xc298, "Driving Force Pro");
    for (const d of [dualSense, dfp]) for (const l of [...connectListeners]) l({ device: d });
    assert.equal(clock.timers.length, 0, "no re-open scheduled for a device the driver would not drive");
    g29.opened = false;
    for (const l of [...connectListeners]) l({ device: g29 });
    assert.equal(clock.timers.length, 1);
    clock.advance(HOTPLUG_DELAY_MS);
    await settle();
    assert.equal(ffb.status.state, "ready");
    assert.equal(ffb.status.device, "G29");
    for (const d of [dualSense, dfp]) assert.equal(d.opened, false);
  });
  await check(`re-opening retries a failed setup up to ${SETUP_ATTEMPTS} times without a fatal status in between`, async () => {
    const dev = wheel();
    dev.failOpens = 2;
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([], [dev]).api, clock.deps);
    const states: string[] = [];
    ffb.subscribe(() => states.push(ffb.status.state));
    const p = ffb.reconnect();
    await settle();
    assert.equal(ffb.status.state, "connecting");
    assert.match(ffb.status.message ?? "", new RegExp(`2/${SETUP_ATTEMPTS}`));
    clock.advance(SETUP_RETRY_MS);
    await settle();
    assert.match(ffb.status.message ?? "", new RegExp(`3/${SETUP_ATTEMPTS}`));
    clock.advance(SETUP_RETRY_MS);
    await settle();
    assert.equal(await p, "Fake DD Base");
    assert.equal(ffb.status.state, "ready");
    assert.ok(!states.includes("error"), `never fatal on the way (${states.join(" → ")})`);
    // Every attempt failing: fatal only after the last one
    const dead = wheel();
    dead.failOpens = 99;
    const c2 = new FakeClock();
    const f2 = new WebHidFfb(fakeHid([], [dead]).api, c2.deps);
    const p2 = f2.reconnect();
    for (let i = 1; i < SETUP_ATTEMPTS; i++) {
      await settle();
      assert.equal(f2.status.state, "connecting", `attempt ${i}`);
      c2.advance(SETUP_RETRY_MS);
    }
    assert.equal(await p2, null);
    assert.equal(f2.status.state, "error");
    // The user's own Connect click is not retried: it reports at once
    const once = wheel();
    once.failOpens = 1;
    const f3 = new WebHidFfb(fakeHid([once]).api, new FakeClock().deps);
    assert.equal(await f3.connect(), null);
    assert.equal(f3.status.state, "error");
  });
  await check("dispose() during the retries ends them at once and leaves the driver idle", async () => {
    const dev = wheel();
    dev.failOpens = 99;
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([], [dev]).api, clock.deps);
    const p = ffb.reconnect();
    await settle();
    assert.equal(ffb.status.state, "connecting");
    await ffb.dispose(); // no clock advance: the wait is cut short
    assert.equal(await p, null);
    assert.equal(ffb.status.state, "idle");
    assert.equal(clock.timers.length, 0);
  });
  await check("emergencyStop() (page unload): zero and Stop All go out synchronously, nothing after; resume() sets it up again", async () => {
    const dev = wheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([dev], [dev]).api, clock.deps);
    await ffb.connect();
    clock.advance(5);
    ffb.setForce(0.7);
    await flush();
    dev.log.length = 0;
    ffb.emergencyStop(); // no await: the page may not get another turn
    assert.deepEqual(dev.log, [
      { kind: "out", id: 5, data: [3, 0, 0] }, // zero force on the effect's block
      { kind: "out", id: 12, data: [3] }, // stop all effects
    ]);
    assert.equal(clock.timers.length, 0, "the idle backstop went with the session");
    clock.advance(5);
    ffb.setForce(0.9);
    await flush();
    assert.equal(dev.log.length, 2, "the writer is dead: nothing after the stop");
    assert.equal(ffb.status.state, "idle");
    ffb.emergencyStop(); // twice is harmless
    assert.equal(dev.log.length, 2);
    // Back from the back/forward cache
    assert.equal(await ffb.resume(), "Fake DD Base");
    assert.equal(ffb.status.state, "ready");
    // A classic Logitech wheel gets what its teardown sends (hid-lg4ff bytes): force off, rev LEDs off, 900° back,
    // centring spring on
    const g29 = logitech(0xc24f, "G29");
    const lg = new WebHidFfb(fakeHid([g29]).api, new FakeClock().deps);
    lg.setRotationDeg(540);
    await lg.connect();
    g29.log.length = 0;
    lg.emergencyStop();
    assert.deepEqual(writes(g29), [LG4FF.forceOff, LG4FF.ledsOff, LG4FF.range900, LG4FF.springParamsFull, LG4FF.springOn]);
    assert.equal(lg.status.state, "idle");
    // Disposed, a page coming back does not reopen the wheel
    await lg.dispose();
    assert.equal(await lg.resume(), null);
    assert.equal(g29.opened, false);
  });
  await check("dispose(): zero force, stop effect, free block, stop all, disable actuators, close", async () => {
    const dev = wheel();
    const ffb = new WebHidFfb(fakeHid([dev]).api, new FakeClock().deps);
    await ffb.connect();
    dev.log.length = 0;
    await ffb.dispose();
    assert.deepEqual(dev.log, [
      { kind: "out", id: 5, data: [3, 0, 0] },
      { kind: "out", id: 10, data: [3, 3, 0] }, // Op Effect Stop (loop count unset)
      { kind: "out", id: 11, data: [3] }, // block free
      { kind: "out", id: 12, data: [3] }, // stop all effects
      { kind: "out", id: 12, data: [2] }, // disable actuators
    ]);
    assert.equal(dev.opened, false);
    assert.equal(ffb.status.state, "idle");
  });
  await check("teardown tolerates a device that vanished", async () => {
    const cols = pidCollections();
    const dev = new FakeHidDevice(cols, asLayout(cols).blockLoad);
    const res = await setupPidDevice(dev, { deps: new FakeClock().deps });
    assert.ok(res.ok);
    if (!res.ok) return;
    dev.failSends = true;
    await teardownPidSession(res.session); // must not throw
  });
  console.log("Diagnostics");
  await check("describeHidDevice: ids, raw descriptor, each PID report with its fields, what is missing", () => {
    const text = describeHidDevice(wheel());
    assert.match(text, /Fake DD Base/);
    assert.match(text, /output report 5 \(24 bits\)/, "raw descriptor");
    assert.match(text, /Set Constant Force: report 5, 24 bits/);
    assert.match(text, /MAGNITUDE\s+bit\s+8, 16 bits, -10000\.\.10000 signed/);
    assert.match(text, /PID Block Load: report 18/);
    assert.match(text, /Set Condition: MISSING/);
    assert.match(text, /Effect types: ET_CONSTANT_FORCE/);
    const pad = new FakeHidDevice([{ usagePage: 0x01, usage: 0x05 }]);
    assert.match(describeHidDevice(pad), /HID PID: no usable Set Constant Force/);
  });
  await check("diagnose(): status, session, granted devices, setup traffic; the force stream stays out of it", async () => {
    const dev = wheel();
    const clock = new FakeClock();
    const pad = new FakeHidDevice([{ usagePage: 0x01, usage: 0x05 }]);
    pad.productName = "Button box";
    const ffb = new WebHidFfb(fakeHid([dev], [pad, dev]).api, clock.deps);
    await ffb.connect();
    const report = await ffb.diagnose();
    assert.match(report, /Status: ready \| Fake DD Base/);
    assert.match(report, /Session: pid driver, constant force on effect block 3/);
    assert.match(report, /Granted devices: 2/);
    assert.match(report, /--- Fake DD Base \(in use, the one reconnect picks\)/);
    assert.match(report, /--- Button box\n/);
    assert.match(report, /feature out id\s+17/, "Create New Effect");
    assert.match(report, /feature in\s+id\s+18\s+03 01/, "Block Load reply: block 3, success");
    assert.match(report, /out\s+id\s+12\s+04/, "device reset");
    assert.match(report, /setup ok: pid driver, constant force on effect block 3, hardware damper none/);
    assert.match(report, /setup Fake DD Base \[1234:5678\] with the HID PID driver \(generic profile\)/);
    const traffic = (r: string) => r.split("\n").filter((l) => /\b(out|feature (in|out))\s+id/.test(l)).length;
    const before = traffic(report);
    for (let i = 0; i < 300; i++) {
      clock.advance(3);
      ffb.setForce(Math.sin(i / 10));
      await flush();
    }
    assert.ok(dev.forceWrites.length > 100, "the stream did play");
    assert.equal(traffic(await ffb.diagnose()), before, "no force writes in the trace");
    await ffb.dispose();
    assert.match(await ffb.diagnose(), /teardown[\s\S]*out\s+id\s+12\s+02/, "teardown traffic (disable actuators)");
  });
  await check(`the trace keeps the last ${HID_TRACE_SIZE} lines, and a failed setup is still described`, async () => {
    const dev = wheel();
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([dev], [dev]).api, clock.deps);
    for (let i = 0; i < 6; i++) {
      await ffb.connect();
      await ffb.dispose();
    }
    const lines = (await ffb.diagnose()).split("\n");
    const start = lines.findIndex((l) => l.startsWith("Setup and teardown traffic"));
    assert.equal(lines.length - start - 1, HID_TRACE_SIZE);
    const broken = wheel();
    broken.blockStatus = 2; // effect memory full
    const f2 = new WebHidFfb(fakeHid([broken]).api, new FakeClock().deps);
    assert.equal(await f2.connect(), null);
    const r2 = await f2.diagnose();
    assert.match(r2, /Status: error/);
    assert.match(r2, /--- Fake DD Base \(last tried/);
    assert.match(r2, /setup failed: The wheel has no free effect memory/);
    assert.match(r2, /Set Constant Force: report 5/);
  });
  await check("describeHidDevice / diagnose(): a classic Logitech wheel, a refused Logitech device and a PID quirk are named", async () => {
    const g29 = logitech(0xc24f, "G29");
    assert.match(describeHidDevice(g29), /HID PID: none\. Logitech G29: driven with the hid-lg4ff commands on output report 0 \(7 bytes\)/);
    assert.match(describeHidDevice(logitech(0xc298, "Driving Force Pro")), /HID PID: none\. Only the Logitech .*G920 and G923 for Xbox.* bridge/);
    const pxn = wheel();
    pxn.vendorId = 0x11ff;
    pxn.productId = 0x3245;
    assert.match(describeHidDevice(pxn), /PID profile: PXN V99/);
    assert.match(describeHidDevice(wheel()), /PID profile: generic/);
    const ffb = new WebHidFfb(fakeHid([g29], [g29]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    await ffb.connect();
    const report = await ffb.diagnose();
    assert.match(report, /Session: logitech-classic driver \(hid-lg4ff\), G29, range set from the wheel rotation setting/);
    assert.match(report, /setup G29 \[046d:c24f\] with the Logitech classic driver \(hid-lg4ff, G29\)/);
    assert.match(report, /out\s+id\s+0\s+f5 00 00 00 00 00 00/, "spring off traced");
    assert.match(report, /out\s+id\s+0\s+f8 81 1c 02 00 00 00/, "range 540 traced");
    await ffb.dispose();
    assert.match(await ffb.diagnose(), /teardown[\s\S]*out\s+id\s+0\s+14 00 00 00 00 00 00/, "teardown traffic (centring spring on)");
  });
  await check("describeHidDevice / diagnose(): a HID++ wheel, its session, and the replies traced with the messages", async () => {
    const g920 = new FakeHidppWheel();
    assert.match(
      describeHidDevice(g920),
      /HID PID: none\. Logitech G920: driven with HID\+\+ force feedback \(feature 0x8123\) on long report 0x11 \(20 bytes\), very long report 0x12 \(64 bytes\)/
    );
    assert.match(describeHidDevice(new FakeHidppWheel(0xc262, "G920", hidppCollections({ veryLong: false }))), /no very long report/);
    const ffb = new WebHidFfb(fakeHid([g920], [g920]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    await ffb.connect();
    const report = await ffb.diagnose();
    assert.match(report, /setup G920 Driving Force Racing Wheel \[046d:c262\] with the Logitech HID\+\+ driver \(hid-logitech-hidpp, G920\)/);
    assert.match(
      report,
      /Session: logitech-hidpp driver \(hid-logitech-hidpp\), G920, feature 0x8123 at index 0x0b, constant force in slot 2 of 3, centring spring in slot 1, rotation 900° at setup \(changed from the wheel rotation setting\), global gain ffff/
    );
    assert.match(report, /out\s+id\s+17\s+ff 00 0a 81 23/, "the lookup traced");
    assert.match(report, /in\s+id\s+17\s+ff 00 0a 0b/, "its reply traced");
    await ffb.dispose();
    assert.match(await ffb.diagnose(), /teardown[\s\S]*out\s+id\s+18\s+ff 0b 2a 01 86 00 00 00 00 7f ff 1f ff/, "the centring spring given back");
  });
  await check("isSupported(): false without navigator.hid (Node)", () => {
    assert.equal(WebHidFfb.isSupported(), false);
    const ffb = new WebHidFfb();
    assert.equal(ffb.status.state, "unsupported");
  });

  console.log("Thrustmaster belt bases (hid-tmff2 commands)");
  /**
   * Reference commands written by hand from the Linux driver hid-tmff2 (src/tmt300rs/hid-tmt300rs.c and the T248
   * backend), not from this driver's output, and checked against the Windows captures in its docs/FFBEFFECTS.md.
   * Every command is output report 0x60 with 63 data bytes (31 in PS4 mode), zero-padded, as t300rs_send_buf fills it.
   */
  const TMFF2 = {
    /** t300rs_set_gain with hid-tmff2's default gain 40000: 02, then 40000 >> 8 = 156 = 0x9c */
    gain: [0x02, 0x9c],
    /** t300rs_set_range: 08 11, then degrees x 0x3c little-endian. 540 → 32400 = 0x7e90, 1080 → 0xfd20, 900 → 0xd2f0, 140 → 0x20d0 */
    range540: [0x08, 0x11, 0x90, 0x7e],
    range1080: [0x08, 0x11, 0x20, 0xfd],
    range900: [0x08, 0x11, 0xf0, 0xd2],
    range140: [0x08, 0x11, 0xd0, 0x20],
    /** t300rs_send_open, t300rs_send_close */
    open: [0x01, 0x05],
    close: [0x01, 0x00],
    /** t248_send_open adds 01 04 before 01 05; t248_send_close is 01 05 then 01 00 */
    open04: [0x01, 0x04],
    /**
     * t300rs_upload_constant, effect slot 0 (id byte 1), level 0, no envelope, infinite: 00 01 6a, level 00 00, eight
     * envelope bytes, 00, then 4f, duration ff ff, 00 00, offset 00 00, 00, ff ff (FFBEFFECTS.md "Initialization")
     */
    upload0: [0x00, 0x01, 0x6a, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x4f, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff],
    /** t300rs_play_effect with count 1: 00 01 89 41 01 00 */
    play: [0x00, 0x01, 0x89, 0x41, 0x01, 0x00],
    /** t300rs_stop_effect: 00 01 89 00 */
    stop: [0x00, 0x01, 0x89, 0x00],
    /**
     * t300rs_update_constant: 00 01 6a, level (little-endian, signed), eight envelope bytes, 00 45, ff ff, 00 00.
     * +16381 = 3f fd (the Windows driver's top, FFBEFFECTS.md), −16381 = c0 03, 8191 = 1f ff
     */
    update: (lo: number, hi: number) => [0x00, 0x01, 0x6a, lo, hi, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x45, 0xff, 0xff, 0x00, 0x00],
    /** t248_interrupts: seven packets written to the endpoint as they are, so the first byte is the report id */
    burst: [
      [0x42, 0x01],
      [0x0a, 0x04, 0x90, 0x03],
      [0x0a, 0x04, 0x00, 0x0c],
      [0x0a, 0x04, 0x12, 0x10],
      [0x0a, 0x04, 0x00, 0x06],
      [0x0a, 0x04, 0x00, 0x0e],
      [0x0a, 0x04, 0x00, 0x0e, 0x01],
    ],
    /** hid-tmff2's DEFAULT_TIMER_PERIOD (ms) between updates of a playing effect */
    spacingMs: 8,
  };
  /** A report as written: id, then its data zero-padded to `len` */
  const tmOut = (bytes: readonly number[], len = 63, id = 0x60) => [id, ...bytes, ...new Array<number>(len - bytes.length).fill(0)];
  const tmBurst = (packet: readonly number[]) => tmOut(packet.slice(1), 63, packet[0]);
  /**
   * A base's HID interface as its own descriptor gives it: input report 7, and the vendor output report 0x0a of 63
   * bytes (hid-tmff2's first T300RS descriptor, before it renumbered the report 0x60); PS4 mode: report 5, 31 bytes
   */
  const thrustmaster = (productId: number, name: string, outBytes = 63, outId = 0x0a) => {
    const dev = new FakeHidDevice([
      {
        usagePage: 0x01,
        usage: 0x04,
        inputReports: [{ reportId: 7, items: [variable([X], 16, 1, 0, 65535)] }],
        outputReports: [{ reportId: outId, items: [variable([(0xff00 << 16) | outId], 8, outBytes, 0, 255)] }],
      },
    ]);
    dev.vendorId = 0x044f;
    dev.productId = productId;
    dev.productName = name;
    return dev;
  };
  const tmWrites = (dev: FakeHidDevice) => dev.log.map((l) => (l.kind === "out" ? [l.id, ...l.data] : ["feature", l.id]));

  await check("T300RS: connect = gain, range, open, then the constant force loaded at 0 and started, all as report 0x60", async () => {
    const t300 = thrustmaster(0xb66e, "Thrustmaster T300RS Racing wheel");
    const ffb = new WebHidFfb(fakeHid([t300]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    assert.equal(await ffb.connect(), "Thrustmaster T300RS Racing wheel");
    assert.equal(ffb.status.state, "ready");
    assert.deepEqual(tmWrites(t300), [TMFF2.gain, TMFF2.range540, TMFF2.open, TMFF2.upload0, TMFF2.play].map((c) => tmOut(c)));
    assert.equal(ffb.hasHardwareDamper(), false);
    assert.equal(ffb.hasRevLeds(), false);
    assert.equal(ffb.hasHardwareCondition("friction"), false);
  });
  await check("T300RS: force bytes follow t300rs_update_constant, + force is + level, each write holds the writer 8 ms", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS");
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([t300]).api, clock.deps);
    await ffb.connect();
    t300.log.length = 0;
    clock.sleeps.length = 0;
    for (const f of [1, -1, 0.5, 0]) {
      ffb.setForce(f);
      await flush();
      clock.advance(10);
      await flush();
    }
    assert.deepEqual(tmWrites(t300), [
      tmOut(TMFF2.update(0xfd, 0x3f)),
      tmOut(TMFF2.update(0x03, 0xc0)),
      tmOut(TMFF2.update(0xff, 0x1f)),
      tmOut(TMFF2.update(0x00, 0x00)),
    ]);
    assert.deepEqual(clock.sleeps, [TMFF2.spacingMs, TMFF2.spacingMs, TMFF2.spacingMs, TMFF2.spacingMs]);
    ffb.setForce(1);
    await flush();
    clock.advance(10);
    await flush();
    t300.log.length = 0;
    ffb.stop();
    await flush();
    assert.deepEqual(tmWrites(t300), [tmOut(TMFF2.update(0x00, 0x00))], "stop() zeroes the level at once");
  });
  await check("T248: the setup burst (t248_interrupts), gain, range clamped to 900, the two-step open, load, start", async () => {
    const t248 = thrustmaster(0xb696, "Thrustmaster T248");
    const ffb = new WebHidFfb(fakeHid([t248]).api, new FakeClock().deps);
    ffb.setRotationDeg(1080); // past the T248's 900: t248_set_range clamps it
    assert.equal(await ffb.connect(), "Thrustmaster T248");
    assert.deepEqual(tmWrites(t248), [
      ...TMFF2.burst.map(tmBurst),
      ...[TMFF2.gain, TMFF2.range900, TMFF2.open04, TMFF2.open, TMFF2.upload0, TMFF2.play].map((c) => tmOut(c)),
    ]);
  });
  await check("TX: a range change while running is clamped (140..900) and sent; dispose puts 900° back and closes in two steps", async () => {
    const tx = thrustmaster(0xb669, "Thrustmaster TX");
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([tx]).api, clock.deps);
    await ffb.connect();
    assert.ok(!tmWrites(tx).some((w) => w[1] === 0x08), "no range at connect without a rotation setting");
    tx.log.length = 0;
    ffb.setRotationDeg(100);
    await flush();
    clock.advance(10);
    await flush();
    ffb.setRotationDeg(Number.NaN);
    await flush();
    clock.advance(10);
    await flush();
    assert.deepEqual(tmWrites(tx), [tmOut(TMFF2.range140)]);
    tx.log.length = 0;
    await ffb.dispose();
    assert.deepEqual(
      tmWrites(tx),
      [TMFF2.update(0x00, 0x00), TMFF2.stop, TMFF2.range900, TMFF2.open, TMFF2.close].map((c) => tmOut(c)),
      "level 0, stop, full range, then t248_send_close (01 05, 01 00)"
    );
    assert.equal(tx.opened, false);
  });
  await check("T300RS teardown: level 0, stop, 1080° back only when it was changed, close", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS");
    const ffb = new WebHidFfb(fakeHid([t300]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    await ffb.connect();
    t300.log.length = 0;
    await ffb.dispose();
    assert.deepEqual(tmWrites(t300), [TMFF2.update(0x00, 0x00), TMFF2.stop, TMFF2.range1080, TMFF2.close].map((c) => tmOut(c)));
    assert.equal(t300.opened, false);
    const t300b = thrustmaster(0xb66e, "T300RS");
    const plain = new WebHidFfb(fakeHid([t300b]).api, new FakeClock().deps);
    await plain.connect();
    t300b.log.length = 0;
    await plain.dispose();
    assert.deepEqual(tmWrites(t300b), [TMFF2.update(0x00, 0x00), TMFF2.stop, TMFF2.close].map((c) => tmOut(c)));
  });
  await check("T300RS emergency stop: the release commands go out at once, and a queued force never after them", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS");
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([t300]).api, clock.deps);
    ffb.setRotationDeg(540);
    await ffb.connect();
    t300.log.length = 0;
    t300.hold = true;
    ffb.setForce(1); // in flight
    ffb.setForce(-1); // queued behind it
    ffb.emergencyStop();
    assert.deepEqual(tmWrites(t300), [
      tmOut(TMFF2.update(0xfd, 0x3f)),
      ...[TMFF2.update(0x00, 0x00), TMFF2.stop, TMFF2.range1080, TMFF2.close].map((c) => tmOut(c)),
    ]);
    t300.release();
    await settle();
    clock.advance(20);
    await settle();
    t300.release();
    await settle();
    assert.equal(t300.log.length, 5, "nothing after the release commands");
    assert.equal(ffb.status.state, "idle");
  });
  await check("T300RS in PS4 mode (b66d): every command is 31 bytes", async () => {
    const ps4 = thrustmaster(0xb66d, "T300RS PS4", 31, 5);
    const ffb = new WebHidFfb(fakeHid([ps4]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), "T300RS PS4");
    assert.deepEqual(tmWrites(ps4), [TMFF2.gain, TMFF2.open, TMFF2.upload0, TMFF2.play].map((c) => tmOut(c, 31)));
  });
  await check("T150, TMX, T500RS and other Thrustmaster ids are refused for the bridge and never opened", async () => {
    for (const [productId, name] of [
      [0xb677, "T150"],
      [0xb67f, "TMX"],
      [0xb65e, "T500RS"],
      [0xb668, "Thrustmaster device"],
    ] as const) {
      const dev = thrustmaster(productId, name);
      const ffb = new WebHidFfb(fakeHid([dev]).api, new FakeClock().deps);
      assert.equal(await ffb.connect(), null, name);
      assert.equal(ffb.status.state, "unsupported", name);
      assert.match(ffb.status.message ?? "", /Only the Thrustmaster .* bridge/, name);
      assert.equal(dev.opened, false, name);
      assert.equal(dev.log.length, 0, name);
    }
  });
  await check("a wheel still on a start-up id (hid-tminit's b65d, b664, b69c) is refused with its own message", async () => {
    for (const productId of [0xb65d, 0xb664, 0xb69c]) {
      const startup = thrustmaster(productId, "Thrustmaster FFB Wheel");
      const ffb = new WebHidFfb(fakeHid([startup]).api, new FakeClock().deps);
      assert.equal(await ffb.connect(), null);
      assert.equal(ffb.status.state, "unsupported");
      assert.match(ffb.status.message ?? "", new RegExp(`start-up mode \\(044f:${productId.toString(16)}\\).*bridge`));
      assert.equal(startup.opened, false);
      assert.equal(startup.log.length, 0);
    }
  });
  await check("T300RS: with no force call for IDLE_ZERO_MS the level goes to 0 by itself", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS");
    const clock = new FakeClock();
    const ffb = new WebHidFfb(fakeHid([t300]).api, clock.deps);
    await ffb.connect();
    ffb.setForce(1);
    await flush();
    t300.log.length = 0;
    clock.advance(IDLE_ZERO_MS + 10);
    await flush();
    assert.deepEqual(tmWrites(t300), [tmOut(TMFF2.update(0x00, 0x00))]);
  });
  await check("a listed base's interface without an output report long enough for its commands is refused", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS", 8);
    const ffb = new WebHidFfb(fakeHid([t300]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "unsupported");
    assert.match(ffb.status.message ?? "", /no 63-byte output report/);
    assert.equal(t300.opened, false);
  });
  await check("a first write the system refuses: final at once, pointing to the bridge; close still tried, device closed", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS");
    t300.failSends = true;
    const ffb = new WebHidFfb(fakeHid([t300]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "unsupported");
    assert.ok(isFatalHidStatus(ffb.status), "the force goes back to the bridge");
    assert.match(ffb.status.message ?? "", /could not send the T300RS or T-GT II its force-feedback commands .*bridge/);
    assert.deepEqual(tmWrites(t300), [tmOut(TMFF2.gain), tmOut(TMFF2.close)]);
    assert.equal(t300.opened, false);
    // On page load: one attempt, not SETUP_ATTEMPTS of "connecting"
    const granted = thrustmaster(0xb66e, "T300RS");
    granted.failSends = true;
    const clock = new FakeClock();
    const again = new WebHidFfb(fakeHid([], [granted]).api, clock.deps);
    assert.equal(await again.reconnect(), null);
    assert.equal(again.status.state, "unsupported");
    assert.deepEqual(tmWrites(granted), [tmOut(TMFF2.gain), tmOut(TMFF2.close)]);
    assert.ok(!clock.timers.some((t) => t.ms === SETUP_RETRY_MS), "no retry scheduled");
  });
  await check("a setup that fails part-way undoes what it did: the range back, then close", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS");
    const send = t300.sendReport.bind(t300);
    let n = 0;
    t300.sendReport = async (id, data) => {
      await send(id, data);
      if (++n === 4) throw new Error("device vanished"); // the effect load
    };
    const ffb = new WebHidFfb(fakeHid([t300]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "error");
    assert.equal(ffb.status.message, "device vanished");
    assert.deepEqual(
      tmWrites(t300),
      [TMFF2.gain, TMFF2.range540, TMFF2.open, TMFF2.upload0, TMFF2.range1080, TMFF2.close].map((c) => tmOut(c))
    );
  });
  await check("reconnect(): a granted listed Thrustmaster base reopens; describeHidDevice and diagnose() name the driver", async () => {
    const t300 = thrustmaster(0xb66e, "T300RS");
    assert.match(describeHidDevice(t300), /HID PID: none\. Thrustmaster T300RS or T-GT II: driven with the hid-tmff2 commands as report 0x60 \(63 bytes\)/);
    assert.match(describeHidDevice(thrustmaster(0xb677, "T150")), /HID PID: none\. Only the Thrustmaster .* bridge/);
    assert.match(describeHidDevice(thrustmaster(0xb65d, "FFB Wheel")), /HID PID: none\. This Thrustmaster wheel is still in its start-up mode/);
    const ffb = new WebHidFfb(fakeHid([], [t300]).api, new FakeClock().deps);
    ffb.setRotationDeg(540);
    assert.equal(await ffb.reconnect(), "T300RS");
    assert.equal(ffb.status.state, "ready");
    const report = await ffb.diagnose();
    assert.match(report, /Session: thrustmaster driver \(hid-tmff2 commands\), T300RS or T-GT II, range set from the wheel rotation setting/);
    assert.match(report, /setup T300RS \[044f:b66e\] with the Thrustmaster driver \(hid-tmff2 commands, T300RS or T-GT II\)/);
    assert.match(report, /out\s+id\s+96\s+02 9c 00/, "gain traced");
    await ffb.dispose();
    assert.match(await ffb.diagnose(), /teardown[\s\S]*out\s+id\s+96\s+01 00 00/, "teardown traffic (close)");
  });

  console.log(`\n${passed} checks passed`);
}

// A check that awaits a promise nobody settles drains the event loop and Node exits 0 mid-run: count that as a failure
let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error(`stopped after ${passed} checks: a check awaited a promise that never settled`);
    process.exitCode = 1;
  }
});
main().then(
  () => {
    finished = true;
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
