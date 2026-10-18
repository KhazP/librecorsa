/**
 * Checks the telemetry packet mapping and the impulse-trigger haptics without a browser:
 *   npx tsx scripts/verify-telemetry-out.ts
 */
import assert from 'node:assert/strict';
import type { CarTelemetry } from '../src/types/f1';
import { buildTelemetryPacket, type TelemetryOutPacket } from '../src/lib/input/telemetry-out';
import { GamepadHaptics, triggerMagnitudes } from '../src/lib/sim/gamepad-haptics';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
/** Partial telemetry cast through unknown: only the fields a check reads are filled */
const tel = (o: Record<string, unknown>) => o as unknown as CarTelemetry;
/** JSON round trip: what a dashboard receives (also turns -0 into 0) */
const onWire = (p: TelemetryOutPacket): TelemetryOutPacket => JSON.parse(JSON.stringify(p)) as TelemetryOutPacket;

const extra = { car: 'f12026-car', track: 'rwanda_2026', maxRpm: 12000, yawRateRadS: 0.123456, pitchRad: -0.0421, rollRad: 0, nowMs: 12345.6 };

const full = tel({
  speedKmh: 287.44,
  rpm: 11873.6,
  gear: 7,
  throttle: 1.2,
  brake: 0,
  steering: -0.25,
  clutch: 1,
  lateralG: 2.3456,
  longitudinalG: -0.1234,
  verticalG: 1.0004,
  ersBatteryPercent: 63.27,
  manualOverrideActive: true,
  fuelKg: 84.567,
  activeAeroMode: 'X_MODE',
  tireTempsC: [98.44, 99.96, 101.2, 97],
  tirePressuresPsi: [23.456, 23.4, 21.1, 21],
  tireWearPct: [12.34, 12.5, 30, 31.9999],
  brakeTempsC: [612.04, 610, 300.5, 301],
  wheelSlipRatios: [0.0123456, 0.01, -0.0001, 0],
  suspensionTravelMm: [22.26, 22.34, 30.04, 30],
  wheelSurfaces: ['asphalt', 'kerb', 'runoff', 'grass'],
  lapCount: 3,
  currentLapTimeMs: 61234.7,
  lastLapTimeMs: 90111.2,
  bestLapTimeMs: null,
  race: { position: 4 },
  trackProgress: 0.4567891,
  onKerbLeft: false,
  onKerbRight: true,
  offTrack: false,
  ffbTorqueNorm: -0.123456,
  f12026: { CHANGED_DRS_OPEN: true, absActive: false, tcActive: true },
});

const expected: TelemetryOutPacket = {
  v: 1,
  car: 'f12026-car',
  track: 'rwanda_2026',
  t: 12346,
  speedKmh: 287.4,
  rpm: 11874,
  maxRpm: 12000,
  gear: 7,
  throttle: 1,
  brake: 0,
  steer: -0.25,
  clutch: 1,
  gLat: 2.346,
  gLon: -0.123,
  gVert: 1,
  yawRate: 0.123,
  pitch: -0.042,
  roll: 0,
  ersPct: 63.3,
  boost: true,
  drs: true,
  aeroMode: 'X_MODE',
  fuelKg: 84.6,
  tyreTempC: [98.4, 100, 101.2, 97],
  tyrePsi: [23.5, 23.4, 21.1, 21],
  tyreWearPct: [12.3, 12.5, 30, 32],
  brakeTempC: [612, 610, 300.5, 301],
  wheelSlip: [0.012, 0.01, 0, 0],
  suspTravelMm: [22.3, 22.3, 30, 30],
  surface: ['asphalt', 'kerb', 'runoff', 'grass'],
  lap: 3,
  lapTimeMs: 61235,
  lastLapMs: 90111,
  bestLapMs: 0,
  position: 4,
  trackPos: 0.457,
  kerb: true,
  offTrack: false,
  abs: false,
  tc: true,
  ffb: -0.123,
};

console.log('Packet mapping');
check('every field maps from CarTelemetry with its unit and rounding', () => {
  assert.deepEqual(onWire(buildTelemetryPacket(full, extra)), expected);
});
check('the packet stays well under 2 KB on the wire', () => {
  const bytes = Buffer.byteLength(JSON.stringify(buildTelemetryPacket(full, extra)));
  console.log(`        packet size: ${bytes} bytes`);
  assert.ok(bytes < 2048, `${bytes} bytes`);
});
check('non-finite values and missing optional channels read as 0 / false / empty', () => {
  const sparse = tel({
    speedKmh: undefined,
    rpm: NaN,
    throttle: NaN,
    lateralG: Infinity,
    ffbTorqueNorm: NaN,
    wheelSlipRatios: [NaN, 0, 0, 0],
    lastLapTimeMs: null,
    bestLapTimeMs: null,
    lapCount: 1,
    trackProgress: 0.5,
  });
  const p = onWire(buildTelemetryPacket(sparse, extra));
  assert.equal(p.speedKmh, 0);
  assert.equal(p.rpm, 0);
  assert.equal(p.throttle, 0);
  assert.equal(p.gLat, 0);
  assert.equal(p.ffb, 0);
  assert.deepEqual(p.wheelSlip, [0, 0, 0, 0]);
  assert.deepEqual(p.tyrePsi, [0, 0, 0, 0]);
  assert.equal(p.position, 0);
  assert.equal(p.lastLapMs, 0);
  assert.equal(p.drs, false);
  assert.equal(p.abs, false);
  assert.equal(p.tc, false);
  assert.equal(p.aeroMode, '');
  assert.deepEqual(p.surface, ['', '', '', '']);
  assert.equal(p.trackPos, 0.5);
  for (const v of Object.values(p)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v));
  }
});
check('normalised channels are clamped to their range', () => {
  const p = buildTelemetryPacket(tel({ throttle: 1.5, brake: -0.2, steering: -3, clutch: 2, trackProgress: 1.2, ffbTorqueNorm: 9 }), extra);
  assert.equal(p.throttle, 1);
  assert.equal(p.brake, 0);
  assert.equal(p.steer, -1);
  assert.equal(p.clutch, 1);
  assert.equal(p.trackPos, 1);
  assert.equal(p.ffb, 1);
});

console.log('Impulse triggers');
/** Hard braking into a lock-up: front wheels locked at −0.30, rear wheels rolling */
const braking = tel({
  speedKmh: 150,
  throttle: 0,
  brake: 0.8,
  steering: 0,
  wheelSlipRatios: [-0.3, -0.25, 0.05, 0.04],
  tireSlipRatio: [0.3, 0.25, 0.05, 0.04],
  wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
  onKerbLeft: false,
  onKerbRight: false,
});
check('ABS: left trigger pulses at 20 Hz, scaled by the lock-up', () => {
  near(triggerMagnitudes(braking, 0).left, 0.35 + 0.45 * (0.3 / 0.45)); // 0.65 on the pulse
  assert.equal(triggerMagnitudes(braking, 0.03).left, 0, 'off half of the 20 Hz cycle');
  assert.equal(triggerMagnitudes(braking, 0).right, 0, 'no throttle, no right trigger');
});
check('ABS: TC off, absActive from the f12026 channels also counts', () => {
  const abs = tel({ ...braking, speedKmh: 20, wheelSlipRatios: [-0.05, 0, 0, 0], f12026: { absActive: true, tcActive: false } });
  assert.ok(triggerMagnitudes(abs, 0).left >= 0.35, 'absActive drives the trigger even at low speed');
});
check('wheelspin: right trigger steady, scaled by rear slip', () => {
  const spin = tel({ speedKmh: 80, throttle: 0.8, brake: 0, wheelSlipRatios: [0.02, 0.02, 0.4, 0.35] });
  near(triggerMagnitudes(spin, 0).right, 0.25 + 0.45 * 0.8); // 0.61, no pulse without TC
  near(triggerMagnitudes(spin, 0.03).right, 0.25 + 0.45 * 0.8, 1e-6);
  assert.equal(triggerMagnitudes(spin, 0).left, 0, 'not braking');
});
check('traction control: right trigger pulses at 25 Hz', () => {
  const tc = tel({ speedKmh: 80, throttle: 0.8, brake: 0, wheelSlipRatios: [0, 0, 0.1, 0.1], f12026: { tcActive: true, absActive: false } });
  near(triggerMagnitudes(tc, 0.01).right, 0.25 + 0.45 * 0.2); // 0.34 on the pulse
  assert.equal(triggerMagnitudes(tc, 0.03).right, 0, 'off half of the 25 Hz cycle');
});
check('idle: both triggers are 0', () => {
  assert.deepEqual(triggerMagnitudes(tel({ speedKmh: 0, throttle: 0, brake: 0, wheelSlipRatios: [0, 0, 0, 0] }), 1.234), { left: 0, right: 0 });
  assert.deepEqual(triggerMagnitudes(tel({ speedKmh: 120, throttle: 0.05, brake: 0.02, wheelSlipRatios: [0.05, 0.05, 0.05, 0.05] }), 0.5), { left: 0, right: 0 });
});

/** Replaces navigator.getGamepads for one block, then restores it */
function withPads(pads: unknown[], fn: () => void) {
  const g = globalThis as unknown as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => pads } });
  try {
    fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete g.navigator;
  }
}
type Call = { type: string; p: Record<string, number> };
const fakeActuator = (effects: string[] | undefined, calls: Call[]) => ({
  effects,
  playEffect: (type: string, p: Record<string, number>) => {
    calls.push({ type, p });
    return undefined;
  },
});

console.log('Haptics wiring');
check('trigger-capable pad gets one trigger-rumble with the body motors; others keep dual-rumble', () => {
  const trig: Call[] = [];
  const dual: Call[] = [];
  withPads([{ vibrationActuator: fakeActuator(['dual-rumble', 'trigger-rumble'], trig) }, { vibrationActuator: fakeActuator(['dual-rumble'], dual) }], () => {
    const h = new GamepadHaptics();
    h.update(braking, 0, true, { triggerRumble: true }); // timeS = 0: the ABS pulse is on
    assert.equal(trig.length, 1);
    assert.equal(trig[0].type, 'trigger-rumble');
    near(trig[0].p.leftTrigger, 0.65);
    assert.equal(trig[0].p.rightTrigger, 0);
    assert.ok(trig[0].p.strongMagnitude > 0, 'body motors still driven');
    assert.equal(dual.length, 1);
    assert.equal(dual[0].type, 'dual-rumble');
    assert.equal(dual[0].p.leftTrigger, undefined);
    h.stop();
    assert.equal(trig[trig.length - 1].type, 'trigger-rumble', 'stop zeroes the triggers on the trigger pad');
    assert.equal(trig[trig.length - 1].p.leftTrigger, 0);
    assert.equal(dual[dual.length - 1].type, 'dual-rumble');
    assert.equal(dual[dual.length - 1].p.strongMagnitude, 0);
  });
});
check('without the option the trigger pad gets the original dual-rumble call', () => {
  const trig: Call[] = [];
  withPads([{ vibrationActuator: fakeActuator(['dual-rumble', 'trigger-rumble'], trig) }], () => {
    new GamepadHaptics().update(braking, 0, true);
    assert.equal(trig.length, 1);
    assert.equal(trig[0].type, 'dual-rumble');
  });
});

console.log(`\n${passed} checks passed`);
