/**
 * Checks DualSense gyro steering without a pad: the IMU offsets and calibration against report bytes captured from a
 * real DualSense over Bluetooth (CRC-checked), the tilt tracking on that capture's motion, and on simulated runs at
 * 66 Hz (the capture's Bluetooth rate on macOS) and 250 Hz: no drift over a lap with a gyro bias, steady under the
 * rumble's shake, the timestamp wrap, dropped reports, re-centring, the steering curve and the stick summed with it.
 * The DualShock 4's reports are built from the Linux driver's layout (hid-playstation): no DualShock 4 was at hand.
 *
 *   npx tsx scripts/verify-gyro-steering.ts
 */
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import {
  NOMINAL_IMU_CALIBRATION,
  parseImuCalibration,
  parseMotionReport,
  SENSOR_TICKS_PER_S,
  sensorDtS,
  type DualSenseMotion,
  type ImuCalibration,
  type Vec3,
} from '../src/lib/input/dualsense-protocol';
import {
  combineStickAndGyro,
  GYRO_DEADZONE_DEG,
  GYRO_LOCK_MAX_DEG,
  gyroSteerValue,
  PadTilt,
  SensorClock,
  type MotionSample,
} from '../src/lib/input/gyro-steer';
import { DeviceInputReader, DEFAULT_WHEEL_SETTINGS, type PadLike } from '../src/lib/input/device-input';
import {
  DS4_SENSOR_TICKS_PER_S,
  isDualShock4PadId,
  parseDs4Calibration,
  parseDs4Controls,
  parseDs4Motion,
} from '../src/lib/input/dualshock4-protocol';
import { isGyroPadId } from '../src/lib/input/gyro-source';
import { DualSenseHid } from '../src/lib/input/webhid-dualsense';
import { DualShock4Hid } from '../src/lib/input/webhid-dualshock4';
import type { HidApiLike, HidDeviceLike, HidInputReportEventLike } from '../src/lib/input/webhid-ffb';
import { DEFAULT_PLAYER_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (±${tol})`);
const DEG = Math.PI / 180;

/* Captured 18 Nov 2026 from a DualSense on Bluetooth (macOS, node-hid): the calibration feature report 0x05 and input
 * reports 0x31, report id first, CRC-32 last */
const CALIBRATION_0x05 = '05000000000000bc2243dd3d22c1ddcd2233dd1c021c02582056e0ae1fcfdf29200be00600e74e5371';
/** Three reports in a row with the pad lying still, face up, on a desk */
const STILL_0x31 = [
  '31418184807d00000108000000055ea2630000ffff00005ffe4f2060022b64fda60f80000000800000000009090000000000c4c4fda6060000f188db2aed694fd00000000000000000005295ad72',
  '31518184807d00000108000000065ea26304000000feff84fe09204c02486cfea60f800000008000000000090900000000005424ffa6060000d8a036655558b63d0000000000000000009b36dfd8',
  '31618184807d00000108000000075ea263fcff0000f9ff59fed81f4c02b965ffa60f8000000080000000000909000000000008b1ffa606000025c41813aaad7022000000000000000000c5ec9da6',
];
/** 120 reports in a row with the pad picked up and turned (about 60° of lean): the IMU block of each (gyro, accel,
 * timestamp: report data offsets 15..30) */
const MOTION_IMU = [
  "d000100060ff2cfc2420e8fc5bb4766a", "9d00100089ff1afc2120a4fc6e64776a", "82001b00adffc4fba420c2fc8114786a", "c5001700c1ffc2fcdd1fd4fc94c4786a",
  "fd002300a6ff18fc061f3cfca774796a", "d300300079ff2efcd91e74fcba247a6a", "a9002b007cffadfb951f60fccdd47a6a", "8f0023009bff7ffb8f1f55fce0847b6a",
  "6a001b00b9ff91fb7c1f3afc47317c6a", "47001200c9ffaafb6e1f47fcafdd7c6a", "2a000e00cbffd5fb591f38fcc28d7d6a", "18000a00c5ffd8fb3b1f3dfcd53d7e6a",
  "28000800bdffc4fbaa1f45fce8ed7e6a", "41000800b7ffebfbd51f54fcfb9d7f6a", "63000900a8ffdefbf91f48fc0e4e806a", "69000c00a8ffcbfb991f03fc21fe806a",
  "49000b00b3ffbdfb821fddfb34ae816a", "2a000c00c5ffa7fbc61fe3fb475e826a", "2f000b00d5ffc3fb5b200bfc5a0e836a", "4f000c00dbff89fb1620f1fb6dbe836a",
  "52000b00e0ff94fbae1fa9fb806e846a", "48000b00e0ff9ffb7f1fbefb931e856a", "3c000900deffb2fb091fd2fba6ce856a", "16000400e7ffaffbe81ebcfbb87e866a",
  "f4fffeffe8ff96fb201fc3fbcb2e876a", "0c00feffe5ff83fb242003fcdede876a", "3e00fbffe0ff69fb1920f1fbf18e886a", "6000ffffd6ff99fb8720b7fb043f896a",
  "9c000700bfffb3fb8120d2fb17ef896a", "b5000d00aaffadfbd31fa5fb2a9f8a6a", "b2001000a4ff84fb641f92fb3d4f8b6a", "d0000d009cff20fb9f1f84fbb8ab8c6a",
  "74011c0039fff3fa222045fb33088e6a", "11022800dffe43fb862063fb46b88e6a", "b602330084fe87fb432027fb59688f6a", "1b033f0039fe6cfbaf1f8afa6b18906a",
  "2d03450021fe35fb701f0bfa7ec8906a", "0a03390036fedffae41ed4f99178916a", "da02280056fe5efa4d1e85f9a428926a", "b1020e0087fee3f91d1e1bf9b7d8926a",
  "9c02ffffb3fe74f97f1e84f8ca88936a", "c202f1ffd7fe73f9471f7ff8dd38946a", "0e03e1fff4fea7f93c1f81f8f0e8946a", "4003d4fffffe89f9cc1e77f70399956a",
  "2f03d4fffffea4f9011ea2f61649966a", "0503d6ffecfe70f93e1d69f629f9966a", "d302d3ffdffe0ef9381d34f63ca9976a", "a702c6fff2feb1f8091d0ef64f59986a",
  "6a02b9ff12ff6ff8031dcef56209996a", "2d02a6ff43ff52f8111d9cf575b9996a", "0a0299ff79ff17f8621d4ef588699a6a", "00029dff9afff2f7221d6cf49b199b6a",
  "f101b5ffa9ffd0f7dd1c8af3aec99b6a", "e601d2ffa0ff0cf8841c76f3c0799c6a", "d801e0ff84ff0df80d1cb9f3d3299d6a", "ca01e4ff6fffeff7271cd4f3e6d99d6a",
  "c301deff79ffa3f7271cd4f34e869e6a", "9301cdff8cffa1f70d1cc8f3b6329f6a", "7601beffaaffacf7da1cc7f3c9e29f6a", "8f01c2ffc4ff98f77e1c0df3dc92a06a",
  "ab01d5ffbaffc0f7631cadf2ef42a16a", "d201e7ffacffc4f77c1cd7f202f3a16a", "e401f7ffa4ffe9f7381c9ef215a3a26a", "e801ffffa0ff01f82c1ca9f22853a36a",
  "e50102009ffff6f75e1ca7f23b03a46a", "f2010e009bffeef7651c83f24eb3a46a", "e20116007bff6bf7731bb0f16163a56a", "8a013f0043ffebf6881af3ef7413a66a",
  "30016900f8fefef6bf1adbef86c3a66a", "ad007400d7fe29f74e1a17f19973a76a", "91ff6800e7fe12f74b1a42f1ac23a86a", "c2fe690022ff61f7d01ab5f1bfd3a86a",
  "d5fe65005bffadf7a11acdf1d183a96a", "e7fe6f008dff3df8c8194af2e433aa6a", "c3fe700097ff75f86a1a35f2f7e3aa6a", "42ff75006bff1df73d1d80f20994ab6a",
  "7e00960050ffaef5791eb3f11c44ac6a", "5b01840085ff7ff4d61c4cf02ef4ac6a", "b6011900430022f2531b12ef41a4ad6a", "cc012eff2d012ef09318d4ee5454ae6a",
  "bd0176fd4b01abec1517e8ed6704af6a", "a3001afc930184e798130aefceb0af6a", "8efe6cfbae02d9e8db152df1365db06a", "6cfd42fa4a039ae9781605f1490db16a",
  "4efd5ef953049deb39186bf35cbdb16a", "2afc0cf8ef0556e67b1107ef6f6db26a", "c1f88ef7f00445ea07169dea821db36a", "42f637f8ba0410eed819acec95cdb36a",
  "caf4c5f83d065eefbd1c3ff0a87db46a", "09f591f9c907f3eefb20e4f5bb2db56a", "95f69ffa0609e5ef1e22bafdceddb56a", "47f86efbf5097af0a8225503e18db66a",
  "4ffaf2fb110a0df03a21fc03f43db76a", "f9fba9fd1f08eaf3de1a510206eeb76a", "c0fe80ff160576fbec1aadfe199eb86a", "61002900b1023cfd1915cffb2c4eb96a",
  "d60085000d0125f9ac1131f93ffeb96a", "f500cb0155ff22f6dc0ec0f852aeba6a", "fcff3c03a5fdbaf7ab0df9fa655ebb6a", "d2fd690457fc6df83c0bf9fc780ebc6a",
  "21fbdc059dfba1f8170e7cfd8bbebc6a", "b8f8b70733fcc5fa91121b009e6ebd6a", "73f6220968fdadfe8d148705b11ebe6a", "1ef49e095efe1b029014580ac4cebe6a",
  "12f23f09a0fe95063d196b0fd77ebf6a", "eaf1a30758fe940a1922e313ea2ec06a", "20f45e0504fe550bb62bc11752dbc06a", "c1f73e03a3fe570a0331c917ba87c16a",
  "0efc1302a9ff23076c309b11cd37c26a", "0f0064023700d202442ab008dfe7c26a", "0c029003380094ffeb236d02f297c36a", "4502ca04c6ff25fe312010000548c46a",
  "c00124062fff78fd0c1fa70018f8c46a", "af001f07f9fe0ffc911f7d032ba8c56a", "9effc9071fff74f89420ea053e58c66a", "03ff550837ffb6f6bb1fab065108c76a",
  "32fe9a083dffbcf72a21340764b8c76a", "8bfc2d08cf0082f9ee29ad0a7768c86a", "21fe4207d702b0fa6532850b8a18c96a", "db036c06140323fca42fc50a9dc8c96a",
];

/** The CRC-32 a Bluetooth report carries in its last four bytes: over a seed byte, the report id and the data */
function btCrcOk(report: Uint8Array, seed: number): boolean {
  const body = report.subarray(0, report.length - 4);
  const want = view(report).getUint32(report.length - 4, true);
  return zlibCrc32(Buffer.concat([Buffer.from([seed]), Buffer.from(body)])) === want;
}

/** A USB-shaped 0x01 report (63 data bytes) around one IMU block, touchpad up or down */
function usbAround(imu: Uint8Array, touchpad = false): Uint8Array {
  const d = new Uint8Array(63);
  d.set([128, 128, 128, 128], 0);
  d[7] = 0x08;
  d[9] = touchpad ? 0x02 : 0;
  d.set(imu, 15);
  return d;
}

console.log('Captured report bytes');
const calibration = parseImuCalibration(view(hex(CALIBRATION_0x05)));
check('calibration 0x05: CRC (seed 0xa3), the pad\'s own scales, with or without the report id byte', () => {
  assert.ok(btCrcOk(hex(CALIBRATION_0x05), 0xa3), 'a genuine report');
  assert.ok(calibration?.fromPad);
  // 540 + 540 deg/s over 8892 + 8893 counts (pitch), 8765 + 8767 (yaw), 8909 + 8909 (roll)
  near(calibration.gyroDpsPerCount[0], 1080 / 17785, 1e-9, 'pitch');
  near(calibration.gyroDpsPerCount[1], 1080 / 17532, 1e-9, 'yaw');
  near(calibration.gyroDpsPerCount[2], 1080 / 17818, 1e-9, 'roll');
  // ±1 g at 8280 / −8106 counts (x): 2 g over 16386, centred at 87
  near(calibration.accelGPerCount[0], 2 / 16386, 1e-12, 'accel x');
  near(calibration.accelBias[0], 87, 1e-9, 'accel x bias');
  const noId = parseImuCalibration(view(hex(CALIBRATION_0x05).subarray(1, 41)));
  assert.deepEqual(noId, calibration);
});
check('a blank or short calibration is refused (the driver falls back to the nominal scales)', () => {
  assert.equal(parseImuCalibration(view(new Uint8Array(41))), null);
  assert.equal(parseImuCalibration(view(hex(CALIBRATION_0x05).subarray(0, 20))), null);
  // Nominal: within 3 % of this pad's
  near(NOMINAL_IMU_CALIBRATION.gyroDpsPerCount[0] / calibration!.gyroDpsPerCount[0], 1, 0.03, 'gyro');
  near(NOMINAL_IMU_CALIBRATION.accelGPerCount[1] / calibration!.accelGPerCount[1], 1, 0.03, 'accel');
});
check('still pad: every report passes its CRC; 1 g up out of the face, the gyro at rest', () => {
  let lastTicks: number | null = null;
  for (const h of STILL_0x31) {
    const r = hex(h);
    assert.ok(btCrcOk(r, 0xa1), 'input CRC, seed 0xa1');
    const m = parseMotionReport(r[0] as number, view(r.subarray(1)), calibration!);
    assert.ok(m);
    near(Math.hypot(...m.accelG), 1, 0.03, '|a|');
    near(m.accelG[1], 1, 0.03, 'y is up out of the face');
    assert.ok(Math.hypot(...m.gyroDps) < 1, `gyro ${m.gyroDps}`);
    assert.equal(m.touchpad, false);
    // 15 to 23 ms apart on the sensor clock (thirds of a microsecond): the capture's 66 reports a second. Over the
    // whole capture the sensor clock and the wall clock agreed within 0.5 %
    if (lastTicks !== null) {
      const gap = sensorDtS(lastTicks, m.ticks);
      assert.ok(gap > 0.012 && gap < 0.025, `report gap ${gap}`);
    }
    lastTicks = m.ticks;
  }
});
check('USB 0x01 is the same block one byte earlier (derived from the Bluetooth bytes: no USB capture)', () => {
  const bt = hex(STILL_0x31[0] as string);
  const viaBt = parseMotionReport(0x31, view(bt.subarray(1)), calibration!);
  const usb = bt.subarray(2, 2 + 63);
  assert.deepEqual(parseMotionReport(0x01, view(usb), calibration!), viaBt);
  assert.equal(parseMotionReport(0x01, view(new Uint8Array(9)), calibration!), null, 'the short Bluetooth report has no IMU');
  assert.equal(parseMotionReport(0x05, view(new Uint8Array(63)), calibration!), null);
  assert.equal(parseMotionReport(0x01, view(usbAround(new Uint8Array(16), true)))?.touchpad, true, 'touchpad click');
});
check('sensor clock: seconds across the 32-bit wrap', () => {
  near(sensorDtS(0xfffff000, 0x00001000), 0x2000 / SENSOR_TICKS_PER_S, 1e-12);
  near(sensorDtS(100, 45175), 45075 / 3e6, 1e-12);
});

/** The captured motion run, parsed as the driver parses it */
const motion = MOTION_IMU.map((h) => parseMotionReport(0x01, view(usbAround(hex(h))), calibration!) as DualSenseMotion);
/** A DualSense reading as the driver hands it to the tracker, through the pad's 32-bit clock */
const asSample = (m: DualSenseMotion, clock: SensorClock): MotionSample => ({
  gyroDps: m.gyroDps,
  accelG: m.accelG,
  dtS: clock.step(m.ticks),
  recentreHeld: m.touchpad,
});
const accelRoll = (m: Pick<DualSenseMotion, 'accelG'>) => Math.atan2(-m.accelG[0], Math.hypot(m.accelG[1], m.accelG[2])) / DEG;

check('captured motion: the gyro turns gravity the way the accelerometer then measures it (axes agree, no flip)', () => {
  // Gyro alone (no accelerometer pull), from the first reading's gravity: RMS of its lean against the accelerometer's
  const gyroOnly = (flip: Vec3) => {
    let up: Vec3 = (() => {
      const a = motion[0]!.accelG;
      const n = Math.hypot(...a);
      return [a[0] / n, a[1] / n, a[2] / n];
    })();
    let e2 = 0;
    for (let i = 1; i < motion.length; i++) {
      const m = motion[i]!;
      const dt = sensorDtS(motion[i - 1]!.ticks, m.ticks);
      const w = m.gyroDps.map((v, k) => v * flip[k]! * DEG) as Vec3;
      for (let s = 0; s < 8; s++) {
        const d: Vec3 = [up[1] * w[2] - up[2] * w[1], up[2] * w[0] - up[0] * w[2], up[0] * w[1] - up[1] * w[0]];
        up = up.map((v, k) => v + (d[k]! * dt) / 8) as Vec3;
        const n = Math.hypot(...up);
        up = [up[0] / n, up[1] / n, up[2] / n];
      }
      e2 += (Math.atan2(-up[0], Math.hypot(up[1], up[2])) / DEG - accelRoll(m)) ** 2;
    }
    return Math.sqrt(e2 / (motion.length - 1));
  };
  const own = gyroOnly([1, 1, 1]);
  const score = (flip: Vec3) => ({ flip: flip.join(','), rms: gyroOnly(flip) });
  const flips: Vec3[] = [[-1, 1, 1], [1, -1, 1], [1, 1, -1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1]];
  const scored = flips.map(score);
  const msg = `own axes ${own.toFixed(2)}°; ${scored.map((f) => `${f.flip} ${f.rms.toFixed(2)}°`).join(', ')}`;
  // The pad's own axes track best of all eight sign sets
  assert.ok(scored.every((f) => own < f.rms), msg);
  // z turns a flat pad like a wheel: any set that flips it is far off. A single flipped axis (the other hand) is too.
  // x and y flipped together (a half turn about z) stay close on this run, which is mostly a turn about z
  for (const f of scored) {
    const flips = f.flip.split(',').filter((v) => v === '-1').length;
    if (f.flip.endsWith('-1')) assert.ok(own * 1.5 < f.rms, msg);
    else if (flips === 1) assert.ok(own * 1.2 < f.rms, msg);
  }
  const span = Math.max(...motion.map(accelRoll)) - Math.min(...motion.map(accelRoll));
  assert.ok(span > 45, `the run leans ${span.toFixed(0)}°`);
});
check('captured motion: where the accelerometer reads gravity alone, the tracked lean agrees with it', () => {
  // Calm reports: within 0.05 g of 1 g and turning under 30 deg/s. Elsewhere the accelerometer also reads the
  // hands' movement (about 0.15 g on this run), so it is no reference there
  const tilt = new PadTilt();
  const clock = new SensorClock(SENSOR_TICKS_PER_S, 32);
  let e2 = 0;
  let n = 0;
  let worst = 0;
  for (const m of motion) {
    tilt.update(asSample(m, clock));
    if (Math.abs(Math.hypot(...m.accelG) - 1) >= 0.05 || Math.hypot(...m.gyroDps) >= 30) continue;
    const e = tilt.rollDeg()! - accelRoll(m);
    e2 += e * e;
    n++;
    worst = Math.max(worst, Math.abs(e));
  }
  const rms = Math.sqrt(e2 / n);
  assert.ok(n > 30, `${n} calm reports`);
  assert.ok(rms < 1 && worst < 3, `RMS ${rms.toFixed(2)}°, worst ${worst.toFixed(2)}° over ${n} calm reports`);
});

console.log('Simulated pad');
/** 3x3 rotation as rows */
type M3 = [Vec3, Vec3, Vec3];
const rx = (a: number): M3 => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const ry = (a: number): M3 => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rz = (a: number): M3 => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const mul = (a: M3, b: M3): M3 => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j]! + row[1] * b[1][j]! + row[2] * b[2][j]!)) as M3;
const tmul = (a: M3, v: Vec3): Vec3 => [0, 1, 2].map((j) => a[0][j]! * v[0] + a[1][j]! * v[1] + a[2][j]! * v[2]) as Vec3;

interface PadPose {
  /** Turned like a wheel, deg (+ = clockwise as the player sees it, to the right) */
  roll: number;
  /** Tipped toward the player, deg */
  pitch?: number;
  /** Turned flat (about the vertical), deg */
  yaw?: number;
}
/** Pad axes in the room (x right, y up, z toward the player): yaw, then the wheel turn, then the tip toward the player */
const orientation = (p: PadPose): M3 => mul(mul(ry((p.yaw ?? 0) * DEG), rz(-p.roll * DEG)), rx(-(p.pitch ?? 0) * DEG));

interface RunOptions {
  hz: number;
  seconds: number;
  pose: (t: number) => PadPose;
  gyroBiasDps?: number;
  gyroNoiseDps?: number;
  accelNoiseG?: number;
  /** Extra acceleration (g) on every axis at time t: the rumble motors' shake */
  shake?: (t: number) => number;
  /** Reports lost: every n-th one is skipped */
  dropEvery?: number;
  startTicks?: number;
  touchpad?: (t: number) => boolean;
  /** The DualShock 4's 16-bit clock (16/3 µs steps, wrapping every 0.35 s) instead of the DualSense's */
  ds4Clock?: boolean;
}
/** Feeds `tilt` a simulated run; calls `each` after every report with the time and the true roll */
function simulate(tilt: PadTilt, o: RunOptions, each?: (t: number, trueRoll: number) => void) {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const dt = 1 / o.hz;
  const n = Math.round(o.seconds * o.hz);
  const clock = o.ds4Clock ? new SensorClock(DS4_SENSOR_TICKS_PER_S, 16) : new SensorClock(SENSOR_TICKS_PER_S, 32);
  let prev = orientation(o.pose(0));
  for (let i = 1; i <= n; i++) {
    const t = i * dt;
    const pose = o.pose(t);
    const R = orientation(pose);
    // Body rate from the change of orientation over the step: Rᵀ·R' ≈ I + [ω]× dt
    const d = mul(prev.map((_, r) => [prev[0][r]!, prev[1][r]!, prev[2][r]!]) as M3, R);
    const w: Vec3 = [(d[2][1] - d[1][2]) / (2 * dt), (d[0][2] - d[2][0]) / (2 * dt), (d[1][0] - d[0][1]) / (2 * dt)];
    prev = R;
    if (o.dropEvery && i % o.dropEvery === 0) continue;
    const up = tmul(R, [0, 1, 0]);
    const shake = o.shake?.(t) ?? 0;
    const m: DualSenseMotion = {
      gyroDps: w.map((v) => v / DEG + (o.gyroBiasDps ?? 0) + rand() * (o.gyroNoiseDps ?? 0)) as Vec3,
      accelG: up.map((v) => v + shake + rand() * (o.accelNoiseG ?? 0)) as Vec3,
      ticks: o.ds4Clock
        ? Math.round(t * DS4_SENSOR_TICKS_PER_S) & 0xffff
        : ((o.startTicks ?? 0) + Math.round(t * SENSOR_TICKS_PER_S)) >>> 0,
      touchpad: o.touchpad?.(t) ?? false,
    };
    tilt.update(asSample(m, clock));
    each?.(t, pose.roll);
  }
}

for (const hz of [66, 250]) {
  check(`no drift over a 120 s lap at ${hz} Hz: held at 10°, 2 deg/s gyro bias on every axis, sensor noise`, () => {
    const tilt = new PadTilt();
    let worst = 0;
    simulate(tilt, { hz, seconds: 120, pose: () => ({ roll: 10, pitch: 30 }), gyroBiasDps: 2, gyroNoiseDps: 0.3, accelNoiseG: 0.01 }, (t) => {
      if (t > 2) worst = Math.max(worst, Math.abs(tilt.rollDeg()! - 10));
    });
    assert.ok(worst < 1, `worst ${worst.toFixed(2)}°`);
  });
  check(`a lap of corners at ${hz} Hz follows the hands (1 deg/s bias, one report in 20 lost)`, () => {
    const tilt = new PadTilt();
    let e2 = 0;
    let n = 0;
    let worst = 0;
    const pose = (t: number): PadPose => ({ roll: 25 * Math.sin((2 * Math.PI * t) / 6) + 8 * Math.sin((2 * Math.PI * t) / 1.7), pitch: 35 });
    simulate(tilt, { hz, seconds: 120, pose, gyroBiasDps: 1, gyroNoiseDps: 0.3, accelNoiseG: 0.01, dropEvery: 20 }, (t, truth) => {
      if (t < 1) return;
      const e = tilt.rollDeg()! - truth;
      e2 += e * e;
      n++;
      worst = Math.max(worst, Math.abs(e));
    });
    const rms = Math.sqrt(e2 / n);
    assert.ok(rms < 0.8 && worst < 2, `RMS ${rms.toFixed(2)}°, worst ${worst.toFixed(2)}°`);
  });
}
for (const [hz, amp] of [[250, 0.5], [66, 0.5], [250, 0.15], [66, 0.15]] as const) {
  check(`the rumble's shake (±${amp} g at 100 Hz on every axis, ${hz} Hz reports, 0.5 deg/s bias) barely moves the steering`, () => {
    const tilt = new PadTilt();
    let worst = 0;
    const shake = (t: number) => amp * Math.sin(2 * Math.PI * 100 * t + 0.3);
    simulate(tilt, { hz, seconds: 30, pose: () => ({ roll: 15, pitch: 30 }), gyroBiasDps: 0.5, gyroNoiseDps: 1, shake }, (t) => {
      if (t > 2) worst = Math.max(worst, Math.abs(tilt.rollDeg()! - 15));
    });
    assert.ok(worst < 1, `worst ${worst.toFixed(2)}°`);
  });
}
check('turning flat on the table or tipping the pad steers nothing; it reads the same flat, tipped or upright', () => {
  const tilt = new PadTilt();
  let worst = 0;
  simulate(tilt, { hz: 250, seconds: 6, pose: (t) => ({ roll: 0, yaw: 60 * Math.sin(t), pitch: 45 + 40 * Math.sin(1.3 * t) }) }, () => {
    worst = Math.max(worst, Math.abs(tilt.steerDeg()!));
  });
  assert.ok(worst < 0.5, `worst ${worst.toFixed(2)}°`);
  for (const pitch of [0, 45, 90]) {
    const t2 = new PadTilt();
    simulate(t2, { hz: 250, seconds: 1, pose: () => ({ roll: 20, pitch }) });
    near(t2.rollDeg()!, 20, 0.2, `pitch ${pitch}`);
  }
});
check('the sensor clock wrapping mid-turn is a normal step, not a restart', () => {
  // The same turn started at 0 and just before the wrap reads the same at every report
  const run = (startTicks: number) => {
    const tilt = new PadTilt();
    const out: number[] = [];
    simulate(tilt, { hz: 250, seconds: 2, startTicks, pose: (t) => ({ roll: 30 * Math.sin(2 * t), pitch: 30 }), gyroBiasDps: 1 }, () => out.push(tilt.rollDeg()!));
    return out;
  };
  const plain = run(0);
  const wrapped = run(0xffffffff - SENSOR_TICKS_PER_S);
  assert.equal(wrapped.length, plain.length);
  plain.forEach((v, i) => near(wrapped[i]!, v, 1e-9, `report ${i}`));
});
check('a lost stretch of reports: a short gap is integrated, a long one starts over from gravity', () => {
  const tilt = new PadTilt();
  const clock = new SensorClock(SENSOR_TICKS_PER_S, 32);
  const feed = (gyroDps: Vec3, accelG: Vec3, ticks: number) =>
    tilt.update({ gyroDps, accelG, dtS: clock.step(ticks), recentreHeld: false });
  // A second at rest, flat: the quick settling after the start is over
  for (let i = 0; i <= 250; i++) feed([0, 0, 0], [0, 1, 0], i * 12000);
  // 45 ms gap (two reports lost at 66 Hz) turning at 30 deg/s clockwise (−z), the accelerometer still reading flat:
  // the gyro's 1.35°, less the accelerometer's pull over 45 ms. A restart would read 0°
  const ticks = 250 * 12000 + 0.045 * SENSOR_TICKS_PER_S;
  feed([0, 0, -30], [0, 1, 0], ticks);
  near(tilt.rollDeg()!, 1.35 * Math.exp(-0.045 / 0.4), 0.02, 'integrated');
  // A second without reports: the next one starts from its own gravity (leaning 30° right)
  const s = Math.sin(30 * DEG);
  feed([0, 0, 0], [-s, Math.cos(30 * DEG), 0], ticks + SENSOR_TICKS_PER_S);
  near(tilt.rollDeg()!, 30, 1e-6, 're-seeded');
});

console.log('Centre and steering');
check('the first reading is the centre; Re-centre takes the lean as it is now', () => {
  const tilt = new PadTilt();
  simulate(tilt, { hz: 250, seconds: 1, pose: () => ({ roll: 12, pitch: 30 }) });
  near(tilt.steerDeg()!, 0, 0.05, 'first reading');
  simulate(tilt, { hz: 250, seconds: 1, pose: (t) => ({ roll: 12 + 20 * Math.min(1, t * 2), pitch: 30 }) });
  near(tilt.steerDeg()!, 20, 0.3, 'turned 20° more');
  tilt.recentre();
  near(tilt.steerDeg()!, 0, 1e-9, 're-centred');
  tilt.reset();
  assert.equal(tilt.steerDeg(), null, 'nothing before a reading');
});
check('holding the touchpad moves the centre with the pad; it stays where the touchpad is let go', () => {
  const tilt = new PadTilt();
  simulate(tilt, { hz: 250, seconds: 0.5, pose: () => ({ roll: 0 }) });
  // Held from 0.1 s to 0.6 s while the pad turns from 0° to 40°; then 10° more with it let go
  const pose = (t: number): PadPose => ({ roll: t < 0.6 ? 40 * Math.min(1, t / 0.5) : 40 + 10 * Math.min(1, (t - 0.6) / 0.2) });
  let worstHeld = 0;
  simulate(tilt, { hz: 250, seconds: 1, pose, touchpad: (t) => t >= 0.1 && t < 0.6 }, (t) => {
    if (t >= 0.1 && t < 0.6) worstHeld = Math.max(worstHeld, Math.abs(tilt.steerDeg()!));
  });
  assert.ok(worstHeld < 1e-9, 'no steering while held');
  near(tilt.steerDeg()!, 10, 0.3, '10° past the new centre');
});
check('lean to steering: dead zone, full lock at the lock angle, sensitivity shapes the middle', () => {
  assert.equal(gyroSteerValue(GYRO_DEADZONE_DEG * 0.9, 35), 0);
  near(gyroSteerValue(35, 35), 1, 1e-12, 'full lock');
  near(gyroSteerValue(80, 35), 1, 1e-12, 'held there');
  near(gyroSteerValue(-35, 35), -1, 1e-12, 'left');
  const half = 0.5 * (35 - GYRO_DEADZONE_DEG) + GYRO_DEADZONE_DEG;
  near(gyroSteerValue(half, 35), 0.5, 1e-12, 'linear');
  near(gyroSteerValue(half, 35, 0.5), 0.25, 1e-12, 'calmer');
  near(gyroSteerValue(half, 35, 1.5), Math.pow(0.5, 1 / 1.5), 1e-12, 'sharper');
  near(gyroSteerValue(200, 500), 1, 1e-12, 'lock held to its range');
  assert.ok(gyroSteerValue(GYRO_LOCK_MAX_DEG / 2, GYRO_LOCK_MAX_DEG) < 0.51);
  assert.equal(gyroSteerValue(Number.NaN, 35), 0);
});
check('the stick and the gyro add up, held to full lock', () => {
  near(combineStickAndGyro(0.5, 0.7), 1, 1e-12);
  near(combineStickAndGyro(-0.2, 0.1), -0.1, 1e-12);
  near(combineStickAndGyro(-0.9, -0.4), -1, 1e-12);
  assert.equal(combineStickAndGyro(0.3, undefined), 0.3);
});

console.log('DualShock 4 (reports built from hid-playstation\'s layout)');
/** A calibration report: pitch ±8900/8890, yaw ±8600/8610, roll ±8300/8310 counts at ±540 deg/s, accel ±1 g */
function ds4CalibrationReport(bluetooth: boolean): Uint8Array {
  const r = new Uint8Array(bluetooth ? 41 : 37);
  const v = new DataView(r.buffer);
  r[0] = bluetooth ? 0x05 : 0x02;
  const gyro = bluetooth ? [8900, 8600, 8300, -8890, -8610, -8310] : [8900, -8890, 8600, -8610, 8300, -8310];
  const fields = [0, 0, 0, ...gyro, 540, 540, 8200, -8180, 8190, -8200, 8210, -8170];
  fields.forEach((f, i) => v.setInt16(1 + 2 * i, f, true));
  return r;
}
const ds4Cal = parseDs4Calibration(0x02, view(ds4CalibrationReport(false)))!;
check('calibration: USB 0x02 and Bluetooth 0x05 orders give the same scales; the wrong order does not', () => {
  assert.ok(ds4Cal.fromPad);
  near(ds4Cal.gyroDpsPerCount[0], 1080 / 17790, 1e-12, 'pitch');
  near(ds4Cal.gyroDpsPerCount[1], 1080 / 17210, 1e-12, 'yaw');
  near(ds4Cal.gyroDpsPerCount[2], 1080 / 16610, 1e-12, 'roll');
  near(ds4Cal.accelGPerCount[0], 2 / 16380, 1e-12, 'accel x');
  assert.deepEqual(parseDs4Calibration(0x05, view(ds4CalibrationReport(true))), ds4Cal);
  assert.deepEqual(parseDs4Calibration(0x02, view(ds4CalibrationReport(false).subarray(1))), ds4Cal, 'without the id byte');
  const misread = parseDs4Calibration(0x02, view(Uint8Array.from([0x02, ...ds4CalibrationReport(true).subarray(1, 37)])));
  assert.notDeepEqual(misread, ds4Cal, 'Bluetooth bytes read in the USB order');
  assert.equal(parseDs4Calibration(0x02, view(new Uint8Array(37))), null, 'blank');
  assert.equal(parseDs4Calibration(0x01, view(ds4CalibrationReport(false))), null, 'not a calibration report');
});
/** The 32-byte block both transports share: sticks, buttons, triggers, the clock, gyro and accel counts */
function ds4Common(o: { gyro: Vec3; accelG: Vec3; ticks: number; touchpad?: boolean }): Uint8Array {
  const c = new Uint8Array(32);
  const v = new DataView(c.buffer);
  c.set([255, 0, 128, 128], 0); // left stick right and up
  c[4] = 0x20 | 0x06; // Cross, hat left
  c[5] = 0x01 | 0x04; // L1, L2 button
  c[6] = 0x01 | (o.touchpad ? 0x02 : 0); // PS, touchpad
  c[7] = 255; // L2 full
  c[8] = 0;
  v.setUint16(9, o.ticks, true);
  o.gyro.forEach((g, k) => v.setInt16(12 + 2 * k, Math.round(g / ds4Cal.gyroDpsPerCount[k]!), true));
  o.accelG.forEach((a, k) => v.setInt16(18 + 2 * k, Math.round(a / ds4Cal.accelGPerCount[k]! + ds4Cal.accelBias[k]!), true));
  return c;
}
const ds4Usb = (c: Uint8Array) => {
  const d = new Uint8Array(63);
  d.set(c, 0);
  return d;
};
const ds4Bt = (c: Uint8Array) => {
  const d = new Uint8Array(77);
  d[0] = 0xc0; // the two lead bytes
  d.set(c, 2);
  return d;
};
check('motion: USB 0x01 at the start, Bluetooth 0x11 two bytes in; the short Bluetooth 0x01 has none', () => {
  const c = ds4Common({ gyro: [12, -30, 45], accelG: [-0.5, 0.866, 0], ticks: 0xfff0, touchpad: true });
  for (const [id, data] of [[0x01, ds4Usb(c)], [0x11, ds4Bt(c)]] as const) {
    const m = parseDs4Motion(id, view(data), ds4Cal);
    assert.ok(m, `report ${id}`);
    m.gyroDps.forEach((g, k) => near(g, [12, -30, 45][k]!, 0.07, `gyro ${k}`));
    m.accelG.forEach((a, k) => near(a, [-0.5, 0.866, 0][k]!, 0.001, `accel ${k}`));
    assert.equal(m.ticks, 0xfff0);
    assert.equal(m.touchpad, true);
  }
  assert.equal(parseDs4Motion(0x01, view(new Uint8Array(9)), ds4Cal), null, 'short Bluetooth report');
  assert.equal(parseDs4Motion(0x31, view(new Uint8Array(77)), ds4Cal), null, 'a DualSense report id');
});
check('Bluetooth controls: sticks, buttons and triggers in the standard order, as the stand-in pad', () => {
  const p = parseDs4Controls(0x11, view(ds4Bt(ds4Common({ gyro: [0, 0, 0], accelG: [0, 1, 0], ticks: 0 }))))!;
  assert.equal(p.axes[0], 1);
  assert.equal(p.axes[1], -1);
  assert.equal(p.buttons[0], true, 'Cross');
  assert.equal(p.buttons[4], true, 'L1');
  assert.equal(p.buttons[6], true, 'L2');
  assert.deepEqual(p.buttons.slice(12, 16), [false, false, true, false], 'd-pad left');
  assert.equal(p.buttons[16], true, 'PS');
  assert.equal(p.l2, 1);
  assert.equal(p.r2, 0);
  assert.equal(parseDs4Controls(0x01, view(new Uint8Array(9))), null);
});
check('16-bit clock: steps across its wrap; a silence longer than the wrap is a gap by the wall clock', () => {
  const clock = new SensorClock(DS4_SENSOR_TICKS_PER_S, 16);
  assert.equal(clock.step(0xfff0, 0), -1, 'first reading');
  near(clock.step(0x0010, 4), 0x20 / DS4_SENSOR_TICKS_PER_S, 1e-12, 'across the wrap');
  // 0.4 s later by the wall clock: the counter went round more than once, and only looks like a short step
  assert.equal(clock.step(0x0100, 404), -1);
  near(clock.step(0x0100 + 750, 408), 0.004, 1e-9, 'tracking again');
  // The page stalled 0.3 s (under one wrap) with the reports queued behind it: the counter's 4 ms step is the true one
  near(clock.step(0x0100 + 1500, 708), 0.004, 1e-9, 'a stall is no gap');
  // The DualSense's 32-bit clock wraps every 24 minutes: no stall of the page is taken for a gap
  const ds = new SensorClock(SENSOR_TICKS_PER_S, 32);
  ds.step(0, 0);
  near(ds.step(12000, 2000), 0.004, 1e-12, 'a 2 s stall');
});
check('a lap of corners on the DualShock 4\'s clock (wrapping every 0.35 s) follows the hands', () => {
  const tilt = new PadTilt();
  let e2 = 0;
  let n = 0;
  const pose = (t: number): PadPose => ({ roll: 25 * Math.sin((2 * Math.PI * t) / 6), pitch: 35 });
  simulate(tilt, { hz: 250, seconds: 60, pose, ds4Clock: true, gyroBiasDps: 1, gyroNoiseDps: 0.3, accelNoiseG: 0.01 }, (t, truth) => {
    if (t < 1) return;
    e2 += (tilt.rollDeg()! - truth) ** 2;
    n++;
  });
  const rms = Math.sqrt(e2 / n);
  assert.ok(rms < 0.8, `RMS ${rms.toFixed(2)}°`);
});
check('DualShock 4 ids: Chrome, Firefox and name-only ids; not the DualSense, not an Xbox pad', () => {
  for (const id of [
    'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
    'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)',
    'DUALSHOCK 4 USB Wireless Adaptor (Vendor: 054c Product: 0ba0)',
    '054c-09cc-Wireless Controller',
    'DUALSHOCK 4 Wireless Controller',
    'Wireless Controller',
  ])
    assert.ok(isDualShock4PadId(id) && isGyroPadId(id), id);
  for (const id of ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'Xbox Wireless Controller', 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'])
    assert.ok(!isDualShock4PadId(id), id);
  assert.ok(isGyroPadId('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'));
  assert.ok(!isGyroPadId('Xbox Wireless Controller'));
});

console.log('Device reader and settings');
const pad = (id: string, axes: number[]): PadLike => ({
  id,
  index: 0,
  mapping: 'standard',
  axes,
  buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })),
});
check('the gyro reaches the frame only from the DualSense or DualShock 4 that steers', () => {
  const settings = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: DEFAULT_PLAYER_SETTINGS.padButtons };
  const any = (v: number) => () => v;
  const ds = new DeviceInputReader().read([pad('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', [0.2, 0])], settings, 1 / 60, undefined, any(0.4));
  assert.equal(ds.gyroSteer, 0.4);
  near(ds.padSteer!, 0.2, 1e-12);
  const xbox = new DeviceInputReader().read([pad('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', [0.2, 0])], settings, 1 / 60, undefined, any(0.4));
  assert.equal(xbox.gyroSteer, undefined, 'a paired DualSense on the desk never steers for the Xbox pad');
  const ds4Id = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
  const ds4 = new DeviceInputReader().read([pad(ds4Id, [0, 0])], settings, 1 / 60, undefined, any(-0.3));
  assert.equal(ds4.gyroSteer, -0.3, 'a DualShock 4 steers with its gyro too');
  // A DualSense streams its lean, the DualShock 4 (not on WebHID) steers: the DualSense's lean is not its own
  const onlyDualSense = (id: string) => (isDualShock4PadId(id) ? undefined : 0.4);
  const mixed = new DeviceInputReader().read([pad(ds4Id, [0, 0])], settings, 1 / 60, undefined, onlyDualSense);
  assert.equal(mixed.gyroSteer, undefined, 'a DualSense on the desk never steers for the DualShock 4');
  const asked: string[] = [];
  new DeviceInputReader().read([pad(ds4Id, [0, 0])], settings, 1 / 60, undefined, (id) => (asked.push(id), 0.1));
  assert.deepEqual(asked, [ds4Id], 'asked for the pad that steers');
  const off = new DeviceInputReader().read([pad('DualSense Wireless Controller', [0, 0])], settings, 1 / 60);
  assert.equal(off.gyroSteer, undefined);
});
check('settings: off by default, 35° lock, linear; old saves get the defaults; values held to range', () => {
  const d = DEFAULT_PLAYER_SETTINGS.dualSense;
  assert.equal(d.gyroSteer, false);
  assert.equal(d.gyroLockDeg, 35);
  assert.equal(d.gyroSensitivity, 1);
  const old = parsePlayerSettings({ dualSense: { adaptiveTriggers: false } }).dualSense;
  assert.equal(old.gyroSteer, false);
  assert.equal(old.gyroLockDeg, 35);
  const wild = parsePlayerSettings({ dualSense: { gyroSteer: true, gyroLockDeg: 400, gyroSensitivity: 0.01 } }).dualSense;
  assert.equal(wild.gyroSteer, true);
  assert.ok(wild.gyroLockDeg <= GYRO_LOCK_MAX_DEG && wild.gyroSensitivity >= 0.5);
});

console.log('Drivers (a fake WebHID device)');
interface FakeDevice extends HidDeviceLike {
  featureReads: number[];
  send(reportId: number, data: Uint8Array): void;
}
function fakeDevice(productId: number, outputReportId: number, outputBytes: number, features: Record<number, Uint8Array>): FakeDevice {
  let listener: ((e: HidInputReportEventLike) => void) | null = null;
  const d: FakeDevice = {
    opened: false,
    vendorId: 0x054c,
    productId,
    productName: 'fake',
    collections: [{ outputReports: [{ reportId: outputReportId, items: [{ reportSize: 8, reportCount: outputBytes }] }] }] as unknown as HidDeviceLike['collections'],
    featureReads: [],
    open: async () => {
      d.opened = true;
    },
    close: async () => {},
    sendReport: async () => {},
    sendFeatureReport: async () => {},
    receiveFeatureReport: async (id: number) => {
      d.featureReads.push(id);
      const f = features[id];
      if (!f) throw new Error(`no feature report ${id}`);
      return view(f);
    },
    addEventListener: (_type, fn) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
    send: (reportId, data) => listener?.({ reportId, data: view(data) }),
  };
  return d;
}
function fakeApi(device: FakeDevice): { api: HidApiLike; unplug(): void } {
  const off: ((e: { device: HidDeviceLike }) => void)[] = [];
  return {
    api: {
      requestDevice: async () => [device],
      getDevices: async () => [device],
      addEventListener: (type, fn) => {
        if (type === 'disconnect') off.push(fn);
      },
      removeEventListener: () => {},
    },
    unplug: () => off.forEach((fn) => fn({ device })),
  };
}

async function driverChecks() {
  {
    // The DualSense on Bluetooth: the captured run through the driver, the frame loop asking for the motion every frame,
    // reads exactly as the tracker fed the same reports directly
    const device = fakeDevice(0x0ce6, 0x31, 77, { 0x05: hex(CALIBRATION_0x05) });
    const { api, unplug } = fakeApi(device);
    const driver = new DualSenseHid(() => api);
    await driver.connect();
    assert.equal(driver.connected(), true);
    assert.ok(device.featureReads.includes(0x05), 'calibration read');
    assert.equal(driver.imuCalibrated(), true);
    const tilt = new PadTilt();
    const clock = new SensorClock(SENSOR_TICKS_PER_S, 32);
    let worst = 0;
    for (const h of MOTION_IMU) {
      driver.setMotionWanted(true);
      const data = new Uint8Array(77);
      data.set(hex(h), 1 + 15);
      device.send(0x31, data);
      tilt.update(asSample(parseMotionReport(0x31, view(data), calibration!)!, clock));
      worst = Math.max(worst, Math.abs(driver.gyroSteerDeg()! - tilt.steerDeg()!));
    }
    assert.ok(worst < 1e-9, `driver against the tracker: ${worst}`);
    assert.ok(Math.abs(driver.gyroSteerDeg()!) > 5, 'the run turned the pad');
    unplug();
    assert.equal(driver.gyroSteerDeg(), null, 'unplugged');
    passed++;
    console.log('  ok  DualSense driver: every report reaches the tracker, read as the tracker reads it alone');
  }
  {
    // The DualShock 4 on Bluetooth: the Bluetooth calibration read first, the lean follows a turn, the stand-in pad
    const btCal = ds4CalibrationReport(true);
    const device = fakeDevice(0x09cc, 0x11, 77, { 0x05: btCal });
    const { api, unplug } = fakeApi(device);
    const driver = new DualShock4Hid(() => api);
    await driver.connect();
    assert.equal(driver.connected(), true);
    assert.equal(driver.getStatus().transport, 'bluetooth');
    assert.equal(device.featureReads[0], 0x05, 'Bluetooth calibration first');
    // One second at 250 Hz turning from level to 20° right (clockwise as the player sees it: −z), flat on its back
    for (let i = 0; i <= 250; i++) {
      driver.setMotionWanted(true);
      const t = i / 250;
      const roll = 20 * Math.min(1, t / 0.6) * DEG;
      const rate = t < 0.6 ? 20 / 0.6 : 0;
      device.send(0x11, ds4Bt(ds4Common({ gyro: [0, 0, -rate], accelG: [-Math.sin(roll), Math.cos(roll), 0], ticks: Math.round(t * DS4_SENSOR_TICKS_PER_S) & 0xffff })));
    }
    near(driver.gyroSteerDeg()!, 20, 0.5, 'lean');
    const pad = driver.bluetoothPad();
    assert.ok(pad && pad.id.includes('09cc') && pad.buttons[0]?.pressed, 'stand-in pad with Cross held');
    unplug();
    assert.equal(driver.connected(), false);
    assert.equal(driver.bluetoothPad(), null);
    passed++;
    console.log('  ok  DualShock 4 driver: Bluetooth calibration, the lean through a turn, the stand-in pad, unplugged');
  }
}

driverChecks().then(
  () => {
    const _types: ImuCalibration | null = calibration;
    void _types;
    console.log(`\n${passed} gyro steering checks passed`);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
