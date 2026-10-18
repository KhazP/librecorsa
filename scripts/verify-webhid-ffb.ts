/**
 * Checks the WebHID force-feedback driver without a browser or a wheel:
 *   npx tsx scripts/verify-webhid-ffb.ts
 */
import assert from "node:assert/strict";
import {
  buildReport,
  forceToRaw,
  ForceWriter,
  isFatalHidStatus,
  PAIR_MESSAGE,
  ordinalUsage,
  parsePidLayout,
  PID,
  selectorValue,
  setupPidDevice,
  teardownPidSession,
  unpackReport,
  WebHidFfb,
  type FfbDeps,
  type HidApiLike,
  type HidCollectionLike,
  type HidDeviceLike,
  type HidReportItemLike,
  type PidFieldLayout,
  type PidReportLayout,
  type WebHidFfbStatus,
} from "../src/lib/input/webhid-ffb";

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
        variable([pid(0x53)], 8, 1, 0, 255),
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
  /** Block index the fake hands out; status 1 = success, 2 = full, 3 = error */
  blockIndex = 3;
  blockStatus = 1;
  /** When true sendReport stays pending until `release()` */
  hold = false;
  failSends = false;
  private waiters: (() => void)[] = [];
  constructor(
    public collections: readonly HidCollectionLike[],
    private readonly blockLoad: PidReportLayout | null = null
  ) {}
  async open() {
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
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
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
    sleep: async () => {},
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
          0xff, 0x7f, // duration = field max (32767)
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

  function fakeHid(devices: FakeHidDevice[], granted: FakeHidDevice[] = []) {
    const listeners: ((e: { device: HidDeviceLike }) => void)[] = [];
    const api: HidApiLike = {
      requestDevice: async () => devices,
      getDevices: async () => granted,
      addEventListener: (_t, l) => void listeners.push(l),
      removeEventListener: (_t, l) => void listeners.splice(listeners.indexOf(l), 1),
    };
    return { api, listeners };
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
    assert.equal(clock.timers.length, 0, "no spacing timer was needed");
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
  await check("connect(): Logitech is unsupported with a clear message and is not opened", async () => {
    const dev = wheel();
    dev.vendorId = 0x046d;
    dev.productName = "G923";
    const ffb = new WebHidFfb(fakeHid([dev]).api, new FakeClock().deps);
    assert.equal(await ffb.connect(), null);
    assert.equal(ffb.status.state, "unsupported");
    assert.equal(ffb.status.device, "G923");
    assert.match(ffb.status.message ?? "", /Logitech.*proprietary/);
    assert.equal(dev.opened, false);
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
    // a granted Logitech wheel is not reopened either (it has no PID): same pairing prompt, no error
    const g923 = wheel();
    g923.vendorId = 0x046d;
    const logi = new WebHidFfb(fakeHid([], [g923]).api, new FakeClock().deps);
    assert.equal(await logi.reconnect(), null);
    assert.equal(logi.status.message, PAIR_MESSAGE);
    assert.equal(g923.opened, false);
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
  await check("fatal statuses: Logitech / write failures are fatal, dispose() keeps the reason", async () => {
    const g923 = wheel();
    g923.vendorId = 0x046d;
    const logi = new WebHidFfb(fakeHid([g923]).api, new FakeClock().deps);
    await logi.connect();
    assert.equal(isFatalHidStatus(logi.status), true);
    await logi.dispose();
    assert.match(logi.status.message ?? "", /Logitech/);

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
  await check("isSupported(): false without navigator.hid (Node)", () => {
    assert.equal(WebHidFfb.isSupported(), false);
    const ffb = new WebHidFfb();
    assert.equal(ffb.status.state, "unsupported");
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
