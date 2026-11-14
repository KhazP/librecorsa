/**
 * Checks the DualSense support without a pad: output report bytes (flags, motors, trigger effects, LEDs, the Bluetooth
 * sequence, tag and CRC), input report parsing over USB and Bluetooth, the firmware version, and what the car's state
 * turns into on the triggers, the rumble, the HD haptics and the lights:
 *   npx tsx scripts/verify-dualsense.ts
 */
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import type { CarTelemetry } from '../src/types/f1';
import {
  buildCommonBlock,
  buildOutputReport,
  crc32,
  EMPTY_OUTPUT,
  encodeTriggerEffect,
  isDualSensePadId,
  outputReportLength,
  parseFeatureVersion,
  parseInputReport,
  slopeZones,
  usesVibrationV2,
  type DualSenseOutput,
} from '../src/lib/input/dualsense-protocol';
import { DualSenseFeedback, hexColor, revLightbar, revPlayerLeds, type DualSenseFrameInput } from '../src/lib/sim/dualsense-feedback';
import { DEFAULT_DUALSENSE_SETTINGS } from '../src/lib/settings/player-settings';
import { SILENT_HAPTICS, WORKLET_SOURCE, type HapticParams } from '../src/lib/input/dualsense-audio-haptics';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const bytes = (a: Uint8Array, from: number, to: number) => Array.from(a.subarray(from, to));
const tel = (o: Record<string, unknown>) => o as unknown as CarTelemetry;
const four = (v: number) => [v, v, v, v];
const cruise = (o: Record<string, unknown> = {}) =>
  tel({
    speedKmh: 150,
    rpm: 9000,
    gear: 5,
    throttle: 0.5,
    brake: 0,
    steering: 0,
    lateralG: 0,
    longitudinalG: 0,
    verticalG: 1,
    wheelSlipRatios: four(0),
    tireSlipRatio: four(0),
    wheelLoadsN: four(2000),
    suspensionVelocityMs: four(0),
    wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
    surface: 'asphalt',
    onKerbLeft: false,
    onKerbRight: false,
    manualOverrideActive: false,
    ...o,
  });

console.log('Trigger effects');
check('feedback: zones from the position to the end, strength − 1 in three bits each', () => {
  const out = new Uint8Array(11);
  encodeTriggerEffect({ mode: 'feedback', position: 3, strength: 5 }, out, 0);
  assert.equal(out[0], 0x21);
  // Zones 3..9 active: 0b11_1111_1000
  assert.deepEqual(bytes(out, 1, 3), [0xf8, 0x03]);
  let zones = 0;
  for (let i = 3; i < 10; i++) zones += 4 * 2 ** (3 * i);
  assert.deepEqual(bytes(out, 3, 7), [zones & 0xff, Math.floor(zones / 256) & 0xff, Math.floor(zones / 65536) & 0xff, Math.floor(zones / 2 ** 24) & 0xff]);
  assert.deepEqual(bytes(out, 7, 11), [0, 0, 0, 0]);
});
check('the top zone keeps its bits (past JavaScript\'s 32-bit shift)', () => {
  const out = new Uint8Array(11);
  encodeTriggerEffect({ mode: 'zones', strengths: [0, 0, 0, 0, 0, 0, 0, 0, 0, 8] }, out, 0);
  assert.equal(out[0], 0x21);
  assert.deepEqual(bytes(out, 1, 3), [0x00, 0x02]);
  // Zone 9, value 7: bits 27..29 → 0x38 in the fourth byte
  assert.deepEqual(bytes(out, 3, 7), [0, 0, 0, 0x38]);
});
check('vibration: amplitude zones and the frequency in byte 9', () => {
  const out = new Uint8Array(11);
  encodeTriggerEffect({ mode: 'vibration', position: 0, amplitude: 8, frequencyHz: 35 }, out, 0);
  assert.equal(out[0], 0x26);
  assert.deepEqual(bytes(out, 1, 3), [0xff, 0x03]);
  assert.deepEqual(bytes(out, 3, 7), [0xff, 0xff, 0xff, 0x3f]);
  assert.equal(out[9], 35);
});
check('an effect that would do nothing is Off, and Off clears the parameters', () => {
  const out = new Uint8Array(11).fill(0xaa);
  encodeTriggerEffect({ mode: 'feedback', position: 2, strength: 0 }, out, 0);
  assert.deepEqual(Array.from(out), [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  encodeTriggerEffect({ mode: 'vibration', position: 2, amplitude: 4, frequencyHz: 0 }, out, 0);
  assert.equal(out[0], 0x05);
  encodeTriggerEffect({ mode: 'zones', strengths: [] }, out, 0);
  assert.equal(out[0], 0x05);
});
check('slope: free before the start, ramping, then held to the end of the travel', () => {
  assert.deepEqual(slopeZones(1, 7, 2, 8), [0, 2, 3, 4, 5, 6, 7, 8, 8, 8]);
  assert.deepEqual(slopeZones(0, 9, 1, 1), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

console.log('Output report');
const full: DualSenseOutput = {
  rumble: { low: 1, high: 0.5 },
  rightTrigger: { mode: 'feedback', position: 2, strength: 3 },
  leftTrigger: { mode: 'vibration', position: 1, amplitude: 6, frequencyHz: 20 },
  lightbar: [10, 20, 30],
  playerLeds: 0b10101,
  micLed: 'pulse',
};
check('flags, motors, triggers and LEDs at the Linux driver\'s offsets', () => {
  const c = buildCommonBlock(full, { vibrationV2: true });
  assert.equal(c.length, 47);
  assert.equal(c[0], 0b0000_1110, 'haptics select, right and left trigger');
  assert.equal(c[1], 0b0001_0101, 'mic LED, lightbar, player LEDs');
  assert.equal(c[38], 0b0000_0100, 'revised rumble');
  assert.equal(c[2], 128, 'motor right (high) 0.5');
  assert.equal(c[3], 255, 'motor left (low) 1');
  assert.equal(c[8], 2, 'mic LED pulsing');
  assert.equal(c[10], 0x21, 'right trigger at 10');
  assert.equal(c[21], 0x26, 'left trigger at 21');
  assert.equal(c[30], 20, 'left trigger frequency');
  assert.equal(c[43], 0b10101);
  assert.deepEqual(bytes(c, 44, 47), [10, 20, 30]);
});
check('older firmware: the original rumble mode in flag 0; nothing set touches nothing', () => {
  const c = buildCommonBlock({ ...EMPTY_OUTPUT, rumble: { low: 0.2, high: 0 } }, { vibrationV2: false });
  assert.equal(c[0], 0b11);
  assert.equal(c[38], 0);
  const none = buildCommonBlock(EMPTY_OUTPUT, { vibrationV2: true });
  assert.ok(none.every((b) => b === 0));
  const setup = buildCommonBlock(EMPTY_OUTPUT, { vibrationV2: true, lightbarSetup: true });
  assert.equal(setup[38], 0b10);
  assert.equal(setup[41], 0b10);
});
check('USB report 0x02 is the common block, padded to the descriptor length', () => {
  const c = buildCommonBlock(full, { vibrationV2: true });
  const r = buildOutputReport(c, 'usb', 0);
  assert.equal(r.reportId, 0x02);
  assert.equal(r.data.length, 47);
  assert.deepEqual(Array.from(r.data), Array.from(c));
  assert.equal(buildOutputReport(c, 'usb', 0, 62).data.length, 62);
});
check('Bluetooth report 0x31: sequence, tag 0x10, common block at 2, CRC-32 of seed + id + data', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')) ^ 0xffffffff, 0xcbf43926 | 0, 'CRC-32 check value');
  const c = buildCommonBlock(full, { vibrationV2: true });
  const r = buildOutputReport(c, 'bluetooth', 7);
  assert.equal(r.reportId, 0x31);
  assert.equal(r.data.length, 77);
  assert.equal(r.data[0], 0x70);
  assert.equal(r.data[1], 0x10);
  assert.deepEqual(bytes(r.data, 2, 49), Array.from(c));
  const crc = zlibCrc32(Buffer.from([0xa2, 0x31, ...r.data.subarray(0, 73)]));
  assert.equal(new DataView(r.data.buffer).getUint32(73, true), crc);
  assert.equal(buildOutputReport(c, 'bluetooth', 18).data[0], 0x20, 'sequence wraps at 16');
});
check('report length from the descriptor', () => {
  const collections = [
    { children: [{ outputReports: [{ reportId: 0x31, items: [{ reportSize: 8, reportCount: 77 }] }] }] },
    { outputReports: [{ reportId: 0x32, items: [{ reportSize: 8, reportCount: 141 }] }] },
  ];
  assert.equal(outputReportLength(collections, 0x31), 77);
  assert.equal(outputReportLength(collections, 0x02), null);
});

console.log('Input report and firmware');
function usbReport(): DataView {
  const d = new Uint8Array(63);
  d.set([128, 0, 255, 128, 0, 255], 0); // LX centre, LY up, RX right, RY centre, L2 free, R2 full
  d[7] = 0x20 | 0x06; // Cross, hat 6 (left)
  d[8] = 0x01 | 0x20; // L1, Options
  d[9] = 0x01 | 0x02; // PS, touchpad
  d[52] = 0x15; // charging, 5 → 55 %
  return new DataView(d.buffer);
}
check('USB 0x01: sticks, triggers, buttons in standard order, battery', () => {
  const p = parseInputReport(0x01, usbReport());
  assert.ok(p);
  assert.ok(Math.abs(p.axes[0]) < 0.01 && p.axes[1] === -1 && p.axes[2] === 1);
  assert.equal(p.l2, 0);
  assert.equal(p.r2, 1);
  assert.equal(p.buttons[0], true, 'Cross');
  assert.equal(p.buttons[1], false);
  assert.equal(p.buttons[4], true, 'L1');
  assert.equal(p.buttons[7], true, 'R2 pressed by its travel');
  assert.equal(p.buttons[9], true, 'Options');
  assert.deepEqual(p.buttons.slice(12, 16), [false, false, true, false], 'd-pad left');
  assert.equal(p.buttons[16], true, 'PS');
  assert.equal(p.buttons[17], true, 'touchpad');
  assert.deepEqual(p.battery, { level: 0.55, charging: true });
  assert.equal(p.full, true);
});
check('Bluetooth 0x31 is the same one byte in; the short 0x01 has no battery', () => {
  const usb = new Uint8Array(usbReport().buffer);
  const bt = new Uint8Array(77);
  bt.set(usb.subarray(0, 63), 1);
  const p = parseInputReport(0x31, new DataView(bt.buffer));
  assert.ok(p && p.buttons[0] && p.r2 === 1 && p.full);
  const short = new Uint8Array([128, 128, 128, 128, 0x80 | 0x08, 0x02, 0x00, 255, 0]);
  const s = parseInputReport(0x01, new DataView(short.buffer));
  assert.ok(s);
  assert.equal(s.buttons[3], true, 'Triangle');
  assert.equal(s.buttons[5], true, 'R1');
  assert.equal(s.l2, 1);
  assert.equal(s.battery, null);
  assert.equal(s.full, false);
  assert.equal(parseInputReport(0x05, new DataView(new ArrayBuffer(63))), null);
});
check('feature version 2.21 with or without the report id byte; v2 rumble from it', () => {
  const withId = new Uint8Array(64);
  withId[0] = 0x20;
  withId[44] = 0x15;
  withId[45] = 0x02;
  assert.equal(parseFeatureVersion(new DataView(withId.buffer)), 0x0215);
  const noId = withId.slice(1);
  assert.equal(parseFeatureVersion(new DataView(noId.buffer)), 0x0215);
  assert.equal(usesVibrationV2(0x0ce6, 0x0214), false);
  assert.equal(usesVibrationV2(0x0ce6, 0x0215), true);
  assert.equal(usesVibrationV2(0x0df2, 0x0100), true, 'Edge');
  assert.equal(usesVibrationV2(0x0ce6, null), true, 'unknown firmware');
});
check('DualSense ids from Chrome, Firefox and Safari; not an Xbox pad or a DualShock 4', () => {
  assert.ok(isDualSensePadId('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'));
  assert.ok(isDualSensePadId('054c-0df2-DualSense Edge Wireless Controller'));
  assert.ok(isDualSensePadId('DualSense Wireless Controller'));
  assert.ok(!isDualSensePadId('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'));
  assert.ok(!isDualSensePadId('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'));
});

console.log('Car to pad');
const settings = { ...DEFAULT_DUALSENSE_SETTINGS };
const frame = (t: CarTelemetry, o: Partial<DualSenseFrameInput> = {}, fb = new DualSenseFeedback()) =>
  fb.frame({ telemetry: t, dtS: 1 / 60, driving: true, rumbleOn: true, settings, triggerSlipAlwaysOn: false, driverColor: '#00FF80', hdHaptics: false, ...o });
check('out of the car: triggers free, motors still, driver colour, player 1 LED', () => {
  const f = frame(cruise(), { driving: false });
  assert.deepEqual(f.output.leftTrigger, { mode: 'off' });
  assert.deepEqual(f.output.rightTrigger, { mode: 'off' });
  assert.deepEqual(f.output.rumble, { low: 0, high: 0 });
  assert.deepEqual(f.output.lightbar, [0, 255, 128]);
  assert.equal(f.output.playerLeds, 0b00100);
});
check('cruising: brake pedal resistance in L2, light resistance in R2', () => {
  const f = frame(cruise());
  assert.equal(f.output.leftTrigger?.mode, 'zones');
  const r = f.output.rightTrigger;
  const l = f.output.leftTrigger;
  assert.ok(r?.mode === 'zones' && l?.mode === 'zones');
  // The throttle is free over its first 30 % and stays lighter than the brake
  assert.deepEqual(r.strengths.slice(0, 3), [0, 0, 0]);
  assert.ok(Math.max(...r.strengths) < Math.max(...l.strengths));
});
check('kerbs reach the low motor as well as the high one', () => {
  const fb = new DualSenseFeedback();
  let low = 0;
  let high = 0;
  for (let i = 0; i < 12; i++) {
    const f = frame(cruise({ onKerbLeft: true }), {}, fb);
    low = Math.max(low, f.output.rumble?.low ?? 0);
    high = Math.max(high, f.output.rumble?.high ?? 0);
  }
  assert.ok(low > 0.3 && high > 0.3, `low ${low.toFixed(2)} high ${high.toFixed(2)}`);
});
check('ABS braking: L2 vibrates at the ABS rate; a lock-up without ABS judders slower', () => {
  const abs = frame(cruise({ brake: 0.9, throttle: 0, wheelSlipRatios: [-0.2, -0.2, -0.1, -0.1], f12026: { absActive: true } }));
  assert.equal(abs.output.leftTrigger?.mode, 'vibration');
  assert.equal(abs.output.leftTrigger?.mode === 'vibration' && abs.output.leftTrigger.frequencyHz, 20);
  const lock = frame(cruise({ brake: 0.9, throttle: 0, wheelSlipRatios: [-0.5, -0.5, -0.1, -0.1] }));
  assert.equal(lock.output.leftTrigger?.mode === 'vibration' && lock.output.leftTrigger.frequencyHz, 12);
});
check('wheelspin buzzes R2; traction control cutting is slower', () => {
  const spin = frame(cruise({ throttle: 1, wheelSlipRatios: [0, 0, 0.4, 0.4] }));
  assert.equal(spin.output.rightTrigger?.mode === 'vibration' && spin.output.rightTrigger.frequencyHz, 35);
  const tc = frame(cruise({ throttle: 1, wheelSlipRatios: [0, 0, 0.05, 0.05], f12026: { tcActive: true } }));
  assert.equal(tc.output.rightTrigger?.mode === 'vibration' && tc.output.rightTrigger.frequencyHz, 18);
});
check('adaptive triggers off: both free while driving', () => {
  const f = frame(cruise({ brake: 0.9 }), { settings: { ...settings, adaptiveTriggers: false } });
  assert.deepEqual(f.output.leftTrigger, { mode: 'off' });
  assert.deepEqual(f.output.rightTrigger, { mode: 'off' });
});
check('rumble follows the motors and its strength; off with the rumble switch', () => {
  const t = cruise({ wheelSlipRatios: [-0.45, -0.45, 0, 0] });
  const on = frame(t);
  assert.ok(on.output.rumble && on.output.rumble.low > 0.5);
  const half = frame(t, { settings: { ...settings, rumbleStrength: 0.5 } });
  assert.ok(half.output.rumble && Math.abs(half.output.rumble.low - on.output.rumble.low / 2) < 1e-9);
  const off = frame(t, { rumbleOn: false });
  assert.deepEqual(off.output.rumble, { low: 0, high: 0 });
});
check('HD haptics: rumble emulation released; a left-side kerb is felt in the left grip only', () => {
  const f = frame(cruise({ onKerbLeft: true, wheelSurfaces: ['kerb', 'asphalt', 'kerb', 'asphalt'] }), { hdHaptics: true });
  assert.equal(f.output.rumble, null);
  assert.ok(f.haptics.kerbL > 0.5);
  assert.equal(f.haptics.kerbR, 0);
  assert.ok(f.haptics.kerbHz > 20 && f.haptics.kerbHz <= 40);
  assert.ok(f.haptics.engine > 0, 'engine on');
  const right = frame(cruise({ wheelSlipRatios: [0, -0.4, 0, 0] }), { hdHaptics: true });
  assert.ok(right.haptics.lockR > 0 && right.haptics.lockL === 0, 'front-right lock on the right');
});
check('a gear change knocks once, with HD haptics only', () => {
  const fb = new DualSenseFeedback();
  frame(cruise({ gear: 4 }), { hdHaptics: true }, fb);
  assert.equal(frame(cruise({ gear: 5 }), { hdHaptics: true }, fb).shift, true);
  assert.equal(frame(cruise({ gear: 5 }), { hdHaptics: true }, fb).shift, false);
  const plain = new DualSenseFeedback();
  frame(cruise({ gear: 4 }), {}, plain);
  assert.equal(frame(cruise({ gear: 5 }), {}, plain).shift, false);
});
check('rev lights fill across the range and blink at the shift; the lightbar goes green to red', () => {
  const range: [number, number] = [10_000, 15_000];
  assert.equal(revPlayerLeds(9_000, range, 0), 0);
  assert.equal(revPlayerLeds(10_000, range, 0), 0b1);
  assert.equal(revPlayerLeds(14_999, range, 0), 0b11111);
  assert.equal(revPlayerLeds(15_000, range, 0), 0b11111);
  assert.equal(revPlayerLeds(15_000, range, 130), 0);
  assert.deepEqual(revLightbar(10_000, range, 0), [0, 220, 0]);
  assert.deepEqual(revLightbar(14_999, range, 0)[0], 255);
  assert.deepEqual(revLightbar(15_000, range, 0), [0, 60, 255]);
  assert.deepEqual(hexColor('#E10600'), [225, 6, 0]);
});

console.log('HD haptics synth');
interface Synth {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}
/** The worklet's own source, run with the three globals an AudioWorkletGlobalScope gives it */
function makeSynth(): Synth {
  let Processor: (new () => Synth) | null = null;
  class AudioWorkletProcessor {
    port: Synth['port'] = { onmessage: null };
  }
  const registerProcessor = (_name: string, cls: new () => Synth) => {
    Processor = cls;
  };
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET_SOURCE)(AudioWorkletProcessor, registerProcessor, 48000);
  assert.ok(Processor, 'the worklet registers its processor');
  return new (Processor as new () => Synth)();
}
/** RMS and peak per channel over `seconds`, after `settleS` for the parameter glide */
function render(synth: Synth, seconds: number, settleS = 0.1) {
  const blocks = Math.round((48000 * (seconds + settleS)) / 128);
  const skip = Math.round((48000 * settleS) / 128);
  const sq = [0, 0, 0, 0];
  const peak = [0, 0, 0, 0];
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    const out = [0, 1, 2, 3].map(() => new Float32Array(128));
    synth.process([], [out]);
    if (b < skip) continue;
    for (let c = 0; c < 4; c++) {
      for (const v of out[c] as Float32Array) {
        assert.ok(Number.isFinite(v), 'finite');
        sq[c] += v * v;
        peak[c] = Math.max(peak[c] as number, Math.abs(v));
      }
    }
    n += 128;
  }
  return { rms: sq.map((v) => Math.sqrt(v / n)), peak };
}
const params = (p: Partial<HapticParams>) => ({ type: 'params', params: { ...SILENT_HAPTICS, kerbHz: 20, engineHz: 60, ...p } });
check('silent at rest; the pad\'s speaker channels 1 and 2 stay silent always', () => {
  const synth = makeSynth();
  const quiet = render(synth, 0.2);
  assert.ok(quiet.rms.every((v) => v === 0));
  synth.port.onmessage?.({ data: params({ gain: 1.5, kerbL: 1, kerbR: 1, roughL: 1, roughR: 1, lockL: 1, lockR: 1, spinL: 1, spinR: 1, scrub: 1, slide: 1, impact: 1, engine: 1 }) });
  const loud = render(synth, 0.5);
  assert.equal(loud.peak[0], 0);
  assert.equal(loud.peak[1], 0);
  assert.ok((loud.peak[2] as number) < 1 && (loud.peak[3] as number) < 1, 'soft-clipped below full scale');
});
check('a left kerb plays in the left actuator (channel 3) only', () => {
  const synth = makeSynth();
  synth.port.onmessage?.({ data: params({ gain: 1, kerbL: 1 }) });
  const r = render(synth, 0.5);
  assert.ok((r.rms[2] as number) > 0.05, `left ${r.rms[2]}`);
  assert.equal(r.peak[3], 0);
});
check('a Test pulse plays with the gain at 0 (out of the car)', () => {
  const synth = makeSynth();
  synth.port.onmessage?.({ data: { type: 'pulse', side: 'right', seconds: 0.2, hz: 70, amp: 0.6 } });
  const r = render(synth, 0.2, 0);
  assert.equal(r.peak[2], 0);
  assert.ok((r.rms[3] as number) > 0.2, `right ${r.rms[3]}`);
});
check('each cue alone at full scale is felt within a 2.5:1 range of the others', () => {
  // The engine is left out: its level is a small share by design (the Engine vibration slider)
  const cues: (keyof HapticParams)[] = ['kerbL', 'roughL', 'lockL', 'spinL', 'scrub', 'slide', 'impact'];
  const levels: Record<string, number> = {};
  for (const cue of cues) {
    const synth = makeSynth();
    synth.port.onmessage?.({ data: params({ gain: 1, [cue]: 1 }) });
    levels[cue] = render(synth, 1).rms[2] as number;
  }
  console.log('      RMS at full scale:', Object.entries(levels).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', '));
  const values = Object.values(levels);
  assert.ok(Math.max(...values) / Math.min(...values) < 2.5, 'cues balanced');
});

console.log(`\n${passed} checks passed`);
