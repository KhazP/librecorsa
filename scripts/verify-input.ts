/**
 * Checks the input layer and saved settings without a browser:
 *   npx tsx scripts/verify-input.ts
 */
import assert from 'node:assert/strict';
import {
  buildKeyLookup,
  clearKey,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_PAD_BUTTONS,
  rebindKey,
  rebindPadButton,
} from '../src/lib/input/bindings';
import {
  autoConfigureWheel,
  CAR_WHEEL_LOCK_DEG,
  DEFAULT_WHEEL_SETTINGS,
  DeviceInputReader,
  pedalValue,
  wheelSteerValue,
  type PadLike,
} from '../src/lib/input/device-input';
import {
  DIRECTION_TEST_S,
  directionTestForce,
  linkHidSink,
  shapeFfbForce,
  softLockForce,
  WheelFfbClient,
} from '../src/lib/input/wheel-ffb';
import { PAIR_MESSAGE, WebHidFfb, type HidApiLike } from '../src/lib/input/webhid-ffb';
import { DEFAULT_PLAYER_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const pad = (id: string, mapping: string, axes: number[], pressed: number[] = [], values: Record<number, number> = {}): PadLike => ({
  id,
  index: 0,
  mapping,
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: values[i] ?? (pressed.includes(i) ? 1 : 0) })),
});

console.log('Keyboard bindings');
check('defaults reproduce the original layout', () => {
  const lookup = buildKeyLookup(DEFAULT_KEY_BINDINGS);
  assert.equal(lookup.get('KeyW'), 'throttle');
  assert.equal(lookup.get('ArrowLeft'), 'steerLeft');
  assert.equal(lookup.get('ShiftRight'), 'boostHold');
  assert.equal(lookup.get('Backspace'), 'restart');
});
check('taking a key from another action swaps the two', () => {
  const next = rebindKey(DEFAULT_KEY_BINDINGS, 'throttle', 0, 'KeyC'); // C was camera
  assert.equal(next.throttle[0], 'KeyC');
  assert.deepEqual(next.camera, ['KeyW']);
  assert.equal(buildKeyLookup(next).get('KeyW'), 'camera');
});
check('binding into an empty slot appends', () => {
  const next = rebindKey(DEFAULT_KEY_BINDINGS, 'camera', 1, 'KeyF');
  assert.deepEqual(next.camera, ['KeyC', 'KeyF']);
});
check('Escape and Slash are reserved', () => {
  assert.equal(rebindKey(DEFAULT_KEY_BINDINGS, 'throttle', 0, 'Escape'), DEFAULT_KEY_BINDINGS);
  assert.equal(rebindKey(DEFAULT_KEY_BINDINGS, 'throttle', 0, 'Slash'), DEFAULT_KEY_BINDINGS);
});
check('clearing a slot removes the key', () => {
  assert.deepEqual(clearKey(DEFAULT_KEY_BINDINGS, 'throttle', 1).throttle, ['KeyW']);
});
check('a pad button moves between actions', () => {
  const next = rebindPadButton(DEFAULT_PAD_BUTTONS, 'racingLine', 0); // A was boost
  assert.equal(next.racingLine, 0);
  assert.equal(next.boost, null);
});

console.log('Wheel and pedals');
check('soft lock: 900° wheel turned 180° is full lock on a 360° car', () => {
  const binding = { center: 0, invert: false };
  near(wheelSteerValue(180 / 450, binding, 900), 1);
  near(wheelSteerValue(90 / 450, binding, 900), 0.5);
  near(wheelSteerValue(1, binding, 900), 1); // clamped past the car's lock
  near(wheelSteerValue(-0.5, binding, CAR_WHEEL_LOCK_DEG), -0.5);
});
check('steering inversion and off-centre calibration', () => {
  near(wheelSteerValue(0.3, { center: 0.1, invert: true }, 360), -0.2);
});
check('dead zone rescales the rest of the travel', () => {
  near(wheelSteerValue(0.01, { center: 0, invert: false }, 360, 0.02), 0);
  near(wheelSteerValue(1, { center: 0, invert: false }, 360, 0.02), 1);
});
check('pedals: normal, inverted and combined-axis', () => {
  near(pedalValue(1, { idle: -1, full: 1 }), 1);
  near(pedalValue(-1, { idle: -1, full: 1 }), 0);
  near(pedalValue(-1, { idle: 1, full: -1 }), 1); // inverted
  near(pedalValue(0.5, { idle: 0, full: -1 }), 0); // combined axis: the other pedal's half reads 0
  near(pedalValue(-1, { idle: 0, full: -1 }), 1);
  assert.ok(pedalValue(0.5, { idle: 0, full: 1 }, 2) < pedalValue(0.5, { idle: 0, full: 1 }, 1)); // gamma
});

console.log('Device reader');
check('standard controller: stick to the assist, triggers, A boost, edges', () => {
  const reader = new DeviceInputReader();
  const settings = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: DEFAULT_PAD_BUTTONS };
  const f1 = reader.read([pad('Xbox', 'standard', [0.4, 0], [0, 5], { 7: 0.8, 6: 0.1 })], settings, 1 / 60);
  assert.equal(f1.source, 'controller');
  near(f1.padSteer!, 0.4);
  near(f1.throttle, 0.8);
  assert.ok(f1.boostHeld);
  assert.ok(f1.pressed.has('shiftUp'));
  const f2 = reader.read([pad('Xbox', 'standard', [0, 0], [0, 5])], settings, 1 / 60);
  assert.ok(!f2.pressed.has('shiftUp'), 'a held button fires once');
});
check('uncalibrated non-standard device keeps the original raw path', () => {
  const reader = new DeviceInputReader();
  const f = reader.read([pad('Generic wheel', '', [0.3, 0], [], { 7: 0.5 })], { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: DEFAULT_PAD_BUTTONS }, 1 / 60);
  assert.equal(f.source, 'legacy');
  near(f.analogSteer!, 0.3);
  near(f.throttle, 0.5);
});
check('calibrated wheel with pedals and paddles on separate devices', () => {
  const reader = new DeviceInputReader();
  const wheel = {
    ...DEFAULT_WHEEL_SETTINGS,
    rotationDeg: 1080,
    steer: { padId: 'DD base', axis: 0, center: 0, invert: false },
    throttle: { padId: 'Pedals', axis: 1, idle: -1, full: 1 },
    brake: { padId: 'Pedals', axis: 2, idle: 1, full: -1 },
    buttons: { ...DEFAULT_WHEEL_SETTINGS.buttons, shiftUp: { padId: 'DD base', button: 4 } },
  };
  const pads = [pad('DD base', '', [60 / 540], [4]), pad('Pedals', '', [0, 1, -1])];
  const f = reader.read(pads, { wheel, padButtons: DEFAULT_PAD_BUTTONS }, 1 / 60);
  assert.equal(f.source, 'wheel');
  near(f.analogSteer!, 60 / 180); // 60° of a 180° half-lock
  near(f.throttle, 1);
  near(f.brake, 1);
  assert.ok(f.pressed.has('shiftUp'));
});

console.log('Wheel detection and force feedback');
const MOZA_BASE = 'MOZA R9 Base (Vendor: 346e Product: 0002)';
const MOZA_PEDALS = 'MOZA SRP pedals (Vendor: 346e Product: 0003)';
check('auto-setup binds the wheel base, never the pedals', () => {
  const patch = autoConfigureWheel([pad(MOZA_PEDALS, '', [-1, -1, -1]), pad(MOZA_BASE, '', [0.004, 0])], DEFAULT_WHEEL_SETTINGS);
  assert.ok(patch);
  assert.equal(patch.steer?.padId, MOZA_BASE);
  assert.equal(patch.steer?.axis, 0);
  near(patch.steer!.center, 0.004);
  assert.equal(patch.type, 'direct_drive');
  assert.equal(autoConfigureWheel([pad(MOZA_PEDALS, '', [-1, -1, -1])], DEFAULT_WHEEL_SETTINGS), null, 'pedals alone are not a wheel');
  assert.equal(autoConfigureWheel([pad('Xbox Wireless Controller', 'standard', [0, 0])], DEFAULT_WHEEL_SETTINGS), null);
});
check('auto-setup leaves a bound wheel alone; belt wheels get their defaults', () => {
  const bound = { ...DEFAULT_WHEEL_SETTINGS, steer: { padId: 'x', axis: 2, center: 0, invert: true } };
  assert.equal(autoConfigureWheel([pad(MOZA_BASE, '', [0])], bound), null);
  const g29 = autoConfigureWheel([pad('Logitech G29 Driving Force Racing Wheel', '', [0.6])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(g29?.type, 'belt_gear');
  assert.equal(g29?.rotationDeg, 900);
  assert.equal(g29?.steer?.center, 0, 'a rim held off-centre is not taken as the centre');
});
check('FFB gain and minimum force: continuous through zero, monotonic, sign kept', () => {
  const w = { ffbGain: 1.5, ffbMinForce: 0.1 };
  near(shapeFfbForce(0, w), 0);
  near(shapeFfbForce(0.4, { ffbGain: 1.5, ffbMinForce: 0 }), 0.6);
  near(shapeFfbForce(-0.4, w), -(0.1 + 0.9 * 0.6));
  assert.ok(Math.abs(shapeFfbForce(1e-5, w)) < 1e-3, 'no notch at the centre');
  let prev = 0;
  for (let t = 0.001; t <= 0.7; t += 0.001) {
    const f = shapeFfbForce(t, w);
    assert.ok(f >= prev - 1e-12, `monotonic at ${t}`);
    prev = f;
  }
});
check('FFB soft lock pushes back past the car steering lock only', () => {
  const half = CAR_WHEEL_LOCK_DEG / 2;
  assert.equal(softLockForce(half - 1), 0);
  assert.equal(softLockForce(-half + 1), 0);
  assert.ok(softLockForce(half + 2) < 0, 'turned right: force to the left');
  assert.ok(softLockForce(-half - 2) > 0);
  near(softLockForce(half + 50), -1);
});

console.log('Saved settings');
check('corrupt or foreign saves fall back to the defaults', () => {
  assert.deepEqual(parsePlayerSettings(null), DEFAULT_PLAYER_SETTINGS);
  assert.deepEqual(parsePlayerSettings('nope'), DEFAULT_PLAYER_SETTINGS);
  const partial = parsePlayerSettings({ device: 'joystick', assistPreset: 'pro', wheel: { rotationDeg: 99999, steer: { padId: 'x' } } });
  assert.equal(partial.device, 'keyboard');
  assert.equal(partial.assistPreset, 'pro');
  assert.equal(partial.wheel.rotationDeg, 2520);
  assert.equal(partial.wheel.steer, null);
});
check('force feedback and FOV settings are clamped; FOV null means the car default', () => {
  const s = parsePlayerSettings({ cockpitFovDeg: 400, wheel: { ffbEnabled: true, ffbGain: 9, ffbMinForce: -1, ffbKerb: 2, ffbAbs: 'x', ffbInvert: 1 } });
  assert.equal(s.cockpitFovDeg, 90);
  assert.equal(s.wheel.ffbEnabled, true);
  assert.equal(s.wheel.ffbGain, 2);
  assert.equal(s.wheel.ffbMinForce, 0);
  assert.equal(s.wheel.ffbKerb, 1);
  assert.equal(s.wheel.ffbAbs, DEFAULT_WHEEL_SETTINGS.ffbAbs);
  assert.equal(s.wheel.ffbInvert, DEFAULT_WHEEL_SETTINGS.ffbInvert);
  assert.equal(parsePlayerSettings({ cockpitFovDeg: null }).cockpitFovDeg, null);
  assert.equal(parsePlayerSettings({ cockpitFovDeg: 'wide' }).cockpitFovDeg, null);
  assert.equal(parsePlayerSettings({ cockpitFovDeg: 54.6 }).cockpitFovDeg, 55);
});
check('round trip through JSON', () => {
  const s = {
    ...DEFAULT_PLAYER_SETTINGS,
    device: 'wheel' as const,
    keys: rebindKey(DEFAULT_KEY_BINDINGS, 'camera', 0, 'KeyF'),
    wheel: { ...DEFAULT_WHEEL_SETTINGS, steer: { padId: 'Moza R9', axis: 0, center: 0.01, invert: true } },
    liveryId: 'papaya_apex',
    camera: 'cockpit' as const,
    cockpitFovDeg: 48,
  };
  s.wheel = { ...s.wheel, ffbEnabled: true, ffbGain: 0.8, ffbMinForce: 0.05, ffbKerb: 0.6, ffbAbs: 0, ffbInvert: true };
  assert.deepEqual(parsePlayerSettings(JSON.parse(JSON.stringify(s))), s);
});

check('direction test: right then left (left first inverted), zero in the gap and after', () => {
  near(directionTestForce(0.5, false), 0.25);
  near(directionTestForce(0.5, true), -0.25);
  near(directionTestForce(1.15, false), 0);
  near(directionTestForce(1.8, false), -0.25);
  near(directionTestForce(1.8, true), 0.25);
  assert.equal(directionTestForce(DIRECTION_TEST_S, false), 0);
  assert.equal(directionTestForce(-0.1, false), 0);
  for (let t = 0; t < DIRECTION_TEST_S; t += 0.01) assert.ok(Math.abs(directionTestForce(t, false)) <= 0.25 + 1e-9);
});
check('direction test goes through the WebHID sink while it is the output, else the bridge', () => {
  const client = new WheelFfbClient();
  assert.equal(client.test(false), false); // no bridge, no WebHID
  const sent: number[] = [];
  client.hidSink = (f) => sent.push(f);
  assert.equal(client.test(false), true);
  assert.equal(sent.length, 1);
  const wheel = { ...DEFAULT_WHEEL_SETTINGS, ffbEnabled: true, hidFfb: true, ffbMinForce: 0, ffbFilterS: 0 };
  // the game force does not overwrite the test while it runs
  client.update({ speedKmh: 0, ffbTorqueNorm: 1 } as never, wheel, [], 1000, true);
  assert.equal(sent.length, 1);
  client.stop(); // cancels it and zeroes the wheel
  assert.equal(sent.at(-1), 0);
  client.update({ speedKmh: 0, ffbTorqueNorm: 0.5 } as never, wheel, [], 1016, true);
  near(sent.at(-1) as number, 0.5 * wheel.ffbGain, 1e-6);
});

async function asyncChecks() {
  // Page load with WebHID saved on and no wheel granted: no prompt, no sink, the bridge keeps the force
  let prompted = 0;
  const api: HidApiLike = {
    requestDevice: async () => {
      prompted++;
      return [];
    },
    getDevices: async () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const hid = new WebHidFfb(api);
  const client = new WheelFfbClient();
  const unlink = linkHidSink(client, hid);
  assert.equal(await hid.reconnect(), null);
  assert.equal(prompted, 0);
  assert.equal(hid.status.state, 'idle');
  assert.equal(hid.status.message, PAIR_MESSAGE);
  assert.equal(client.hidSink, null);
  assert.equal(client.test(false), false); // bridge route (not connected here)
  unlink();
  passed++;
  console.log('  ok  load without a grant: no prompt, no WebHID sink, bridge fallback');
  console.log(`\n${passed} checks passed`);
}
asyncChecks().catch((e) => {
  console.error(e);
  process.exit(1);
});
