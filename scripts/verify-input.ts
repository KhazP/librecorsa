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
  carWheelLockDeg,
  DEFAULT_WHEEL_SETTINGS,
  DeviceInputReader,
  pedalValue,
  snapshotAxes,
  strongestAxisChange,
  wheelSteerValue,
  type PadLike,
} from '../src/lib/input/device-input';
import {
  DIRECTION_TEST_S,
  directionTestForce,
  HID_WATCHDOG_MS,
  linkHidSink,
  shapeFfbForce,
  softLockForce,
  WheelFfbClient,
} from '../src/lib/input/wheel-ffb';
import { PAIR_MESSAGE, WebHidFfb, type HidApiLike } from '../src/lib/input/webhid-ffb';
import {
  DEFAULT_PLAYER_SETTINGS,
  FFB_POLARITY_V2_KEY,
  loadPlayerSettings,
  LIBRARY_FAVORITES_MAX,
  LIBRARY_RECENT_MAX,
  parsePlayerSettings,
  pushLibraryRecent,
  savePlayerSettings,
  SETTINGS_STORAGE_KEY,
  toggleLibraryFavorite,
} from '../src/lib/settings/player-settings';

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
check('an unplugged wheel is reported once (the game pauses), not silently handed to a pad', () => {
  const reader = new DeviceInputReader();
  const wheel = { ...DEFAULT_WHEEL_SETTINGS, steer: { padId: 'DD base', axis: 0, center: 0, invert: false } };
  const xbox = pad('Xbox', 'standard', [0.5, 0], [0, 5], { 7: 0.9 });
  const settings = { wheel, padButtons: DEFAULT_PAD_BUTTONS };
  assert.equal(reader.read([pad('DD base', '', [0.1]), xbox], settings, 1 / 60).wheelLost, undefined);
  const lost = reader.read([xbox], settings, 1 / 60);
  assert.equal(lost.wheelLost, true);
  assert.equal(reader.read([xbox], settings, 1 / 60).wheelLost, undefined, 'only on the frame it went');
  assert.equal(new DeviceInputReader().read([xbox], settings, 1 / 60).wheelLost, undefined, 'no wheel to begin with: nothing lost');
  // Separate pedals unplugged while the base stays: also lost
  const pedalled = {
    wheel: {
      ...wheel,
      throttle: { padId: 'Pedals', axis: 1, idle: -1, full: 1 },
      brake: { padId: 'Pedals', axis: 2, idle: 1, full: -1 },
    },
    padButtons: DEFAULT_PAD_BUTTONS,
  };
  const r2 = new DeviceInputReader();
  assert.equal(r2.read([pad('DD base', '', [0.1]), pad('Pedals', '', [0, 1, 1])], pedalled, 1 / 60).wheelLost, undefined);
  assert.equal(r2.read([pad('DD base', '', [0.1])], pedalled, 1 / 60).wheelLost, true, 'pedals unplugged');
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
check('auto-setup: all wheels (including Logitech and PXN) start on WebHID; CSL Elite is belt-driven, CSL DD direct', () => {
  const g923 = autoConfigureWheel([pad('G923 Racing Wheel for Xbox One and PC (Vendor: 046d Product: c26e)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(g923?.hidFfb, true, 'WebHID drives both PID and classic Logitech wheels');
  assert.equal(g923?.ffbEnabled, true);
  const pxn = autoConfigureWheel([pad('PXN-V99 Wheel (Vendor: 11ff Product: 3245)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(pxn?.hidFfb, true);
  assert.equal(pxn?.type, 'belt_gear');
  assert.equal(autoConfigureWheel([pad(MOZA_BASE, '', [0])], DEFAULT_WHEEL_SETTINGS)?.hidFfb, true);
  assert.equal(autoConfigureWheel([pad('FANATEC CSL Elite Wheel Base', '', [0])], DEFAULT_WHEEL_SETTINGS)?.type, 'belt_gear');
  assert.equal(autoConfigureWheel([pad('FANATEC CSL DD', '', [0])], DEFAULT_WHEEL_SETTINGS)?.type, 'direct_drive');
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
check('per-car steering lock: 360° for Formula cars, 640° for AMG GT3 (steering & soft lock)', () => {
  assert.equal(carWheelLockDeg('vf26'), 360);
  assert.equal(carWheelLockDeg('f12026-car'), 360);
  assert.equal(carWheelLockDeg('amg-gt3'), 640);
  const binding = { padId: 'Simucube 2 Pro', axis: 0, center: 0, invert: false };
  // On a 900° wheel turned 180° right (raw = +0.4): full lock (+1.0) in F1, 180/320 = 0.5625 in AMG GT3
  near(wheelSteerValue(0.4, binding, 900, 0, carWheelLockDeg('vf26')), 1);
  near(wheelSteerValue(0.4, binding, 900, 0, carWheelLockDeg('amg-gt3')), 180 / 320);
  // On a 540° wheel driving the 640° AMG GT3, full physical lock (raw = ±1) still reaches full rack travel (±1)
  near(wheelSteerValue(1.0, binding, 540, 0, carWheelLockDeg('amg-gt3')), 1);
  near(wheelSteerValue(-1.0, binding, 540, 0, carWheelLockDeg('amg-gt3')), -1);
  // Soft lock at 250° right: past lock in F1 (< 0), still inside the 320° half-lock in AMG GT3 (0)
  assert.ok(softLockForce(250, carWheelLockDeg('vf26')) < 0);
  assert.equal(softLockForce(250, carWheelLockDeg('amg-gt3')), 0);
  assert.ok(softLockForce(330, carWheelLockDeg('amg-gt3')) < 0);
});
check("a player's steering lock quickens the rack, never slows it, and loads from saved settings", () => {
  const binding = { padId: 'Simucube 2 Pro', axis: 0, center: 0, invert: false };
  const locks = { 'amg-gt3': 400 };
  assert.equal(carWheelLockDeg('amg-gt3', locks), 400);
  assert.equal(carWheelLockDeg('vf26', locks), 360);
  assert.equal(carWheelLockDeg('amg-gt3', { 'amg-gt3': 800 }), 640, 'slower than the real car: ignored');
  assert.equal(carWheelLockDeg('amg-gt3', { 'amg-gt3': 90 }), 640, 'below the minimum: ignored');
  // 200° right on a 900° wheel (raw 0.4444): full lock on the 400° GT3 rack, 200/320 on the real one
  near(wheelSteerValue(200 / 450, binding, 900, 0, carWheelLockDeg('amg-gt3', locks)), 1);
  near(wheelSteerValue(100 / 450, binding, 900, 0, carWheelLockDeg('amg-gt3', locks)), 0.5);
  const parsed = parsePlayerSettings({ wheel: { steerLockPerCar: { 'amg-gt3': 401, bogus: 'x' } } });
  assert.deepEqual(parsed.wheel.steerLockPerCar, { 'amg-gt3': 401 });
  assert.deepEqual(parsePlayerSettings({ wheel: {} }).wheel.steerLockPerCar, {});
});
check('speed-gated minimum force: zero at standstill (<= 1 km/h), full by 6 km/h', () => {
  const w = { ffbGain: 1, ffbMinForce: 0.2 };
  near(shapeFfbForce(0.05, w, 0), 0.05, 1e-6);
  near(shapeFfbForce(0.05, w, 1), 0.05, 1e-6);
  near(shapeFfbForce(0.05, w, 6), shapeFfbForce(0.05, w), 1e-6);
});
check('multi-device calibration prefers physical wheel over vJoy mirror, but binds vJoy-only axes when physical is at rest', () => {
  const vjoy: PadLike = { id: 'vJoy - Virtual Joystick', index: 0, mapping: '', axes: [0], buttons: [] };
  const sc2: PadLike = { id: 'Simucube 2 Pro', index: 1, mapping: '', axes: [0], buttons: [] };
  const base = snapshotAxes([vjoy, sc2]);
  // Both move together (vJoy mirroring physical wheel): physical wins
  const movedVjoy: PadLike = { ...vjoy, axes: [0.6] };
  const movedSc2: PadLike = { ...sc2, axes: [0.45] };
  assert.equal(strongestAxisChange(base, [movedVjoy, movedSc2])?.padId, 'Simucube 2 Pro');
  // vJoy-only pedal moves 0.8 while physical wheel has 0.01 resting noise: vJoy wins
  const vjoyPedal: PadLike = { ...vjoy, axes: [0.8] };
  const noisyWheel: PadLike = { ...sc2, axes: [0.01] };
  const picked = strongestAxisChange(base, [vjoyPedal, noisyWheel]);
  assert.equal(picked?.padId, 'vJoy - Virtual Joystick');
  near(picked!.delta, 0.8);
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
check('browser library: favourites / recents validated, de-duplicated and capped; older saves get empty lists', () => {
  assert.deepEqual(parsePlayerSettings({}).library, { favorites: { cars: [], circuits: [] }, recent: { cars: [], circuits: [] } });
  assert.deepEqual(parsePlayerSettings({ library: 'x' }).library, DEFAULT_PLAYER_SETTINGS.library);
  const lib = parsePlayerSettings({
    library: {
      favorites: { cars: ['w17', 'w17', 7, '', 'bad id', '<x>', 'a'.repeat(65), 'sf26'], circuits: 'spa' },
      recent: { cars: Array.from({ length: 40 }, (_, i) => `car${i}`), circuits: ['daytona_oval', null] },
    },
  }).library;
  assert.deepEqual(lib.favorites, { cars: ['w17', 'sf26'], circuits: [] });
  assert.equal(lib.recent.cars.length, LIBRARY_RECENT_MAX);
  assert.deepEqual(lib.recent.circuits, ['daytona_oval']);
  const many = parsePlayerSettings({ library: { favorites: { cars: Array.from({ length: 999 }, (_, i) => `c${i}`) } } }).library;
  assert.equal(many.favorites.cars.length, LIBRARY_FAVORITES_MAX);
  // A venue starred through one layout comes off through any of them
  let l = toggleLibraryFavorite(DEFAULT_PLAYER_SETTINGS.library, 'circuits', ['daytona_road', 'daytona_oval']);
  assert.deepEqual(l.favorites.circuits, ['daytona_road']);
  l = toggleLibraryFavorite(l, 'circuits', ['daytona_oval', 'daytona_road']);
  assert.deepEqual(l.favorites.circuits, []);
  // Recents: newest first, no repeats, same object when nothing changes
  let r = pushLibraryRecent(DEFAULT_PLAYER_SETTINGS.library, 'cars', 'w17');
  r = pushLibraryRecent(r, 'cars', 'sf26');
  r = pushLibraryRecent(r, 'cars', 'w17');
  assert.deepEqual(r.recent.cars, ['w17', 'sf26']);
  assert.equal(pushLibraryRecent(r, 'cars', 'w17'), r);
  const s = { ...DEFAULT_PLAYER_SETTINGS, library: r };
  assert.deepEqual(parsePlayerSettings(JSON.parse(JSON.stringify(s))), s);
});
check('pre-fix ffbInvert: true save is reset once on load; post-v2 ffbInvert: true is preserved', () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: Storage };
  const prevStorage = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  try {
    const legacy = {
      ...DEFAULT_PLAYER_SETTINGS,
      wheel: { ...DEFAULT_WHEEL_SETTINGS, ffbInvert: true },
    };
    store.set(SETTINGS_STORAGE_KEY, JSON.stringify(legacy));
    const migrated = loadPlayerSettings();
    assert.equal(migrated.wheel.ffbInvert, false, 'pre-v2 ffbInvert reset to false');
    assert.equal(store.get(FFB_POLARITY_V2_KEY), '1', 'polarity v2 flag stamped');
    savePlayerSettings({ ...migrated, wheel: { ...migrated.wheel, ffbInvert: true } });
    assert.equal(loadPlayerSettings().wheel.ffbInvert, true, 'post-v2 ffbInvert kept');
  } finally {
    if (prevStorage === undefined) delete g.localStorage;
    else g.localStorage = prevStorage;
  }
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
  client.stop();
});
check('linkHidSink flips sign from WheelFfbClient (+ = right) to WebHidFfb.setForce (- = right in USB PID)', () => {
  const api: HidApiLike = {
    requestDevice: async () => [],
    getDevices: async () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const hid = new WebHidFfb(api);
  const hidForces: number[] = [];
  hid.setForce = (f: number) => {
    hidForces.push(f);
  };
  hid.status = { state: 'ready', device: 'MOZA R9 Base', message: null };
  const client = new WheelFfbClient();
  const unlink = linkHidSink(client, hid);
  assert.ok(client.hidSink, 'hidSink wired when ready');
  client.hidSink!(0.5);
  near(hidForces.at(-1) as number, -0.5, 1e-6);
  unlink();
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

  // WebHID 150ms watchdog zeroes force when updates stop arriving (e.g. hidden tab or stalled loop)
  const watchdogClient = new WheelFfbClient();
  const watchdogSent: number[] = [];
  watchdogClient.hidSink = (f) => watchdogSent.push(f);
  const wheel = { ...DEFAULT_WHEEL_SETTINGS, ffbEnabled: true, hidFfb: true, ffbMinForce: 0, ffbFilterS: 0 };
  watchdogClient.update({ speedKmh: 50, ffbTorqueNorm: 0.6 } as never, wheel, [], 1000, true);
  assert.ok((watchdogSent.at(-1) ?? 0) > 0, 'non-zero force sent');
  await new Promise((r) => setTimeout(r, HID_WATCHDOG_MS + 40));
  assert.equal(watchdogSent.at(-1), 0, 'watchdog zeroed WebHID force after updates stopped');
  assert.equal(watchdogClient.force, 0);
  passed++;
  console.log('  ok  WebHID 150 ms watchdog zeroes force when frame updates stop');

  // WebHID plays the frame's 500 Hz physics samples out over the next frame, not one value per frame
  {
    const c = new WheelFfbClient();
    const out: number[] = [];
    c.hidSink = (f) => out.push(f);
    const w = { ...wheel, ffbGain: 1, ffbDamping: 0 };
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    c.update({ speedKmh: 50, ffbTorqueNorm: 0.8, ffbSubframeSamples: samples } as never, w, [], 1000, true);
    near(out[0], 0.1, 1e-4);
    await new Promise((r) => setTimeout(r, 30));
    c.stop();
    const played = out.slice(0, -1); // the stop's zero last
    assert.ok(played.length >= 4, `samples played out over time (${played.length} writes)`);
    near(played.at(-1) as number, 0.8, 1e-4);
    for (let i = 1; i < played.length; i++) assert.ok(played[i] >= played[i - 1] - 1e-9, 'played in order');
    passed++;
    console.log(`  ok  WebHID plays the 500 Hz samples out over the frame (${played.length} writes in 30 ms)`);
  }

  // The kerb buzz is made on the playback clock: 40 Hz on the wheel, not aliased by the 60 Hz frame rate
  {
    const c = new WheelFfbClient();
    const out: { t: number; f: number }[] = [];
    c.hidSink = (f) => out.push({ t: performance.now(), f });
    const w = { ...wheel, ffbGain: 1, ffbDamping: 0, ffbKerb: 1 };
    const t0 = performance.now();
    while (performance.now() - t0 < 600) {
      c.update({ speedKmh: 100, ffbTorqueNorm: 0.3, wheelSurfaces: ['kerb', 'kerb', 'asphalt', 'asphalt'] } as never, w, [], performance.now(), true);
      await new Promise((r) => setTimeout(r, 16));
    }
    c.stop();
    const v = out.slice(0, -1).filter((s) => s.t - t0 > 100);
    let crossings = 0;
    for (let i = 1; i < v.length; i++) if ((v[i].f - 0.3) * (v[i - 1].f - 0.3) < 0) crossings++;
    const hz = crossings / 2 / ((v.at(-1)!.t - v[0].t) / 1000);
    assert.ok(hz > 30 && hz < 50, `kerb buzz at ${hz.toFixed(1)} Hz`);
    passed++;
    console.log(`  ok  WebHID kerb buzz plays at ${hz.toFixed(1)} Hz (40 Hz synthesised), not aliased to the frame rate`);
  }

  // The grass rumble plays on a straight, with no steering torque to carry it
  {
    const c = new WheelFfbClient();
    const out: number[] = [];
    c.hidSink = (f) => out.push(f);
    const w = { ...wheel, ffbGain: 1, ffbDamping: 0, ffbKerb: 0.5, ffbAbs: 0.5 };
    c.update(
      {
        speedKmh: 80,
        ffbTorqueNorm: 0,
        wheelSurfaces: ['grass', 'asphalt', 'asphalt', 'asphalt'],
        tireSlipRatio: [1.6, 1.5, 0.2, 0.2],
        suspensionTravelMm: [10, 10, 15, 15],
      } as never,
      w,
      [],
      1000,
      true
    );
    await new Promise((r) => setTimeout(r, 20));
    c.update(
      {
        speedKmh: 80,
        ffbTorqueNorm: 0,
        wheelSurfaces: ['grass', 'asphalt', 'asphalt', 'asphalt'],
        tireSlipRatio: [1.6, 1.5, 0.2, 0.2],
        suspensionTravelMm: [25, 10, 15, 15],
      } as never,
      w,
      [],
      1020,
      true
    );
    await new Promise((r) => setTimeout(r, 20));
    c.stop();
    const nonZero = out.slice(0, -1).some((v) => Math.abs(v) > 0.005);
    assert.ok(nonZero, 'the grass rumble plays with no steering torque');
    passed++;
    console.log('  ok  WebHID grass rumble plays on a straight (no steering torque)');
  }

  // Hardware damper integration forwards speed-scaled damper and reduces software damping by 70%
  {
    const fakeApi: HidApiLike = {
      requestDevice: async () => [],
      getDevices: async () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const hwHid = new WebHidFfb(fakeApi);
    let lastHwDamper = -1;
    hwHid.hasHardwareDamper = () => true;
    hwHid.setDamper = (coeff: number) => {
      lastHwDamper = coeff;
    };
    hwHid.status = { state: 'ready', device: 'PID Wheel', message: null };

    const cHw = new WheelFfbClient();
    const unlink = linkHidSink(cHw, hwHid);
    const cSoft = new WheelFfbClient();
    cSoft.hidSink = () => {};

    const wDamp = {
      ...wheel,
      ffbGain: 1,
      ffbDamping: 0.5,
      rotationDeg: 900,
      steer: { padId: 'Wheel', axis: 0, center: 0, invert: false },
    };
    cHw.update({ speedKmh: 100, ffbTorqueNorm: 0 } as never, wDamp, [pad('Wheel', '', [0])], 1000, true);
    cSoft.update({ speedKmh: 100, ffbTorqueNorm: 0 } as never, wDamp, [pad('Wheel', '', [0])], 1000, true);
    cHw.update({ speedKmh: 100, ffbTorqueNorm: 0 } as never, wDamp, [pad('Wheel', '', [0.1])], 1020, true);
    cSoft.update({ speedKmh: 100, ffbTorqueNorm: 0 } as never, wDamp, [pad('Wheel', '', [0.1])], 1020, true);

    // At 100 km/h, gyroFactor = (100 - 10) / 180 = 0.5 -> damper = 0.5 * (0.4 + 0.6 * 0.5) = 0.35
    near(lastHwDamper, 0.35, 1e-6);
    near(Math.abs(cHw.force), Math.abs(cSoft.force) * 0.3, 1e-6);
    cHw.stop();
    cSoft.stop();
    unlink();
    passed++;
    console.log('  ok  WebHID hardware damper forwards speed-scaled coefficient and reduces software damping by 70%');
  }
  console.log(`\n${passed} checks passed`);
}
asyncChecks().catch((e) => {
  console.error(e);
  process.exit(1);
});
