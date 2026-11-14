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
  matchPadLayout,
  PAD_ACTIONS,
  PAD_LAYOUT_IDS,
  PAD_LAYOUTS,
  rebindKey,
  rebindPadButton,
} from '../src/lib/input/bindings';
import {
  autoConfigureWheel,
  CAR_WHEEL_LOCK_DEG,
  carWheelLockDeg,
  DEFAULT_WHEEL_SETTINGS,
  DeviceInputReader,
  PAD_SENSITIVITY,
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
  applyFfbCurve,
  revLedMask,
  shapeFfbForce,
  softLockForce,
  unapplyFfbCurve,
  WheelFfbClient,
} from '../src/lib/input/wheel-ffb';
import {
  ForceWriter,
  PAIR_MESSAGE,
  WebHidFfb,
  type FfbDeps,
  type HidApiLike,
  type HidCollectionLike,
  type HidDeviceLike,
} from '../src/lib/input/webhid-ffb';
import {
  DEFAULT_KEYBOARD_TUNING,
  DEFAULT_PAD_TUNING,
  DEFAULT_PLAYER_SETTINGS,
  defaultGraphicsSettings,
  FFB_POLARITY_V2_KEY,
  KEYBOARD_FEEL_FIELDS,
  KEYBOARD_PEDAL_HELP_FIELDS,
  loadPlayerSettings,
  LIBRARY_FAVORITES_MAX,
  LIBRARY_RECENT_MAX,
  PAD_FINE_TUNING_FIELDS,
  parsePlayerSettings,
  PAUSE_KEYBOARD_FIELDS,
  PAUSE_PAD_FIELDS,
  pushLibraryRecent,
  resetKeyboardTuning,
  resetPadTuning,
  savePlayerSettings,
  SETTINGS_STORAGE_KEY,
  toggleLibraryFavorite,
} from '../src/lib/settings/player-settings';
import {
  ASSIST_PRESETS,
  ASSIST_SLIDERS,
  assistPresetDetail,
  DEFAULT_DEVICE_ASSIST_TUNING,
  DEFAULT_STEERING_ASSIST,
  deviceAssistTuning,
  matchingAssistPreset,
  sanitizeAssistTuning,
  steeringAssistSettings,
} from '../src/lib/sim/steering-assist';
import { resetAllSettings } from '../src/components/settings/storage';

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
check('controller layouts: every action set, no shared button, triggers / D-pad / thumb-restart left alone', () => {
  assert.equal(PAD_LAYOUTS.default.buttons, DEFAULT_PAD_BUTTONS);
  for (const id of PAD_LAYOUT_IDS) {
    const b = PAD_LAYOUTS[id].buttons;
    const used: number[] = [];
    for (const { id: action } of PAD_ACTIONS) {
      assert.notEqual(b[action], undefined, `${id}.${action} unset`);
      if (b[action] !== null) used.push(b[action] as number);
    }
    assert.equal(new Set(used).size, used.length, `${id}: a button does two things`);
    for (const button of used) assert.ok(button <= 11 && button !== 6 && button !== 7, `${id}: button ${button} is fixed`);
    assert.equal(b.pause, 9, `${id}: pause off Menu`);
    assert.equal(b.restart, 8, `${id}: restart off View`);
  }
  // What each layout takes from its game
  assert.deepEqual([PAD_LAYOUTS.gt.buttons.shiftUp, PAD_LAYOUTS.gt.buttons.shiftDown, PAD_LAYOUTS.gt.buttons.boost], [0, 2, 11]);
  assert.deepEqual([PAD_LAYOUTS.f1.buttons.boost, PAD_LAYOUTS.f1.buttons.aero, PAD_LAYOUTS.f1.buttons.camera], [1, 3, 5]);
  assert.deepEqual([PAD_LAYOUTS.forza.buttons.shiftUp, PAD_LAYOUTS.forza.buttons.shiftDown, PAD_LAYOUTS.forza.buttons.camera], [1, 2, 5]);
});
check('the picked layout is read back from the bindings, through a save, and lost on a rebind', () => {
  for (const id of PAD_LAYOUT_IDS) {
    const buttons = { ...PAD_LAYOUTS[id].buttons };
    assert.equal(matchPadLayout(buttons), id);
    const saved = parsePlayerSettings(JSON.parse(JSON.stringify({ ...DEFAULT_PLAYER_SETTINGS, padButtons: buttons })));
    assert.equal(matchPadLayout(saved.padButtons), id, `${id} after a reload`);
    assert.equal(matchPadLayout(rebindPadButton(buttons, 'racingLine', 4)), null, `${id} rebound`);
  }
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
check('auto-setup: a Logitech WebHID cannot drive starts on the bridge, others on WebHID; CSL Elite is belt-driven, CSL DD direct', () => {
  const g923 = autoConfigureWheel([pad('G923 Racing Wheel for Xbox One and PC (Vendor: 046d Product: c26e)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(g923?.hidFfb, true, 'a HID++ wheel the browser drives (G923 for Xbox) starts on WebHID');
  assert.equal(g923?.ffbEnabled, true);
  assert.equal(g923?.type, 'belt_gear');
  const g920 = autoConfigureWheel([pad('Logitech USB device (Vendor: 046d Product: c262)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(g920?.hidFfb, true, 'a G920 known only by its USB ids is a wheel, on WebHID');
  assert.equal(g920?.type, 'belt_gear');
  const g923ps = autoConfigureWheel([pad('G923 Racing Wheel for PlayStation and PC (Vendor: 046d Product: c267)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(g923ps?.hidFfb, false, 'the PlayStation G923 WebHID refuses: the bridge instructions show from the start');
  const gpro = autoConfigureWheel([pad('PRO Racing Wheel (Vendor: 046d Product: c272)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(gpro?.hidFfb, false, 'the G PRO WebHID refuses');
  const g29 = autoConfigureWheel([pad('Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(g29?.hidFfb, true, 'a classic Logitech starts on WebHID, with no bridge to install');
  const pxn = autoConfigureWheel([pad('PXN-V99 Wheel (Vendor: 11ff Product: 3245)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(pxn?.hidFfb, true);
  assert.equal(pxn?.type, 'belt_gear');
  assert.equal(autoConfigureWheel([pad(MOZA_BASE, '', [0])], DEFAULT_WHEEL_SETTINGS)?.hidFfb, true);
  assert.equal(autoConfigureWheel([pad('FANATEC CSL Elite Wheel Base', '', [0])], DEFAULT_WHEEL_SETTINGS)?.type, 'belt_gear');
  assert.equal(autoConfigureWheel([pad('FANATEC CSL DD', '', [0])], DEFAULT_WHEEL_SETTINGS)?.type, 'direct_drive');
});
check('a listed Logitech wheel without "wheel" in its name is recognised by its USB ids (Chrome and Firefox ids)', () => {
  for (const id of ['Driving Force GT (Vendor: 046d Product: c29a)', '046d-c29a-Driving Force GT']) {
    const dfgt = autoConfigureWheel([pad(id, '', [0])], DEFAULT_WHEEL_SETTINGS);
    assert.equal(dfgt?.steer?.padId, id);
    assert.equal(dfgt?.type, 'belt_gear');
    assert.equal(dfgt?.hidFfb, true);
  }
  assert.equal(autoConfigureWheel([pad('Logitech Dual Action (Vendor: 046d Product: c216)', '', [0])], DEFAULT_WHEEL_SETTINGS), null, 'a Logitech gamepad is not a wheel');
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
check('FFB force curve: linear at 1, lifts or holds back light forces, leaves |force| > 1 for the clip meter', () => {
  for (const f of [-1.4, -0.7, -0.05, 0, 0.3, 1, 1.6]) assert.equal(applyFfbCurve(f, 1), f);
  // No setting (an older caller) is linear too
  near(shapeFfbForce(0.4, { ffbGain: 1, ffbMinForce: 0 }), shapeFfbForce(0.4, { ffbGain: 1, ffbMinForce: 0, ffbCurve: 1 }));
  near(applyFfbCurve(0.5, 2), 0.25);
  near(applyFfbCurve(-0.5, 2), -0.25);
  near(applyFfbCurve(0.1, 0.5), 1 - 0.9 ** 2);
  near(applyFfbCurve(1.3, 0.5), 1.3);
  near(applyFfbCurve(-2, 2), -2);
  for (const g of [0.5, 0.7, 1.4, 2]) {
    near(applyFfbCurve(1, g), 1);
    // Finite slope at the centre below 1: no notch across zero
    assert.ok(Math.abs(applyFfbCurve(1e-4, g)) < 1e-3, `no notch at ${g}`);
    let prev = 0;
    for (let a = 0.001; a <= 1; a += 0.001) {
      const y = applyFfbCurve(a, g);
      assert.ok(y >= prev - 1e-12, `monotonic at ${a}, curve ${g}`);
      prev = y;
      near(unapplyFfbCurve(y, g), a, 1e-9);
    }
  }
  // Curve before minimum force: the minimum force still lifts the curved value
  near(shapeFfbForce(0.5, { ffbGain: 1, ffbMinForce: 0.1, ffbCurve: 2 }), 0.1 + 0.9 * 0.25);
});
check('rev LEDs: off below the range, one more per fifth, all five flashing from the shift point', () => {
  const r: [number, number] = [6200, 7500];
  assert.equal(revLedMask(6000, r, 0), 0);
  assert.equal(revLedMask(6200, r, 0), 0b1);
  assert.equal(revLedMask(6200 + 1300 * 0.45, r, 0), 0b111);
  assert.equal(revLedMask(7499, r, 0), 0b11111);
  assert.equal(revLedMask(7500, r, 0), 0b11111);
  assert.equal(revLedMask(7600, r, 130), 0, 'the flash is off half the time');
  assert.equal(revLedMask(Number.NaN, r, 0), 0);
  assert.equal(revLedMask(9000, [8000, 8000], 0), 0, 'an empty range lights nothing');
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
  assert.equal(carWheelLockDeg('lc26'), 360);
  assert.equal(carWheelLockDeg('f12026-car'), 360);
  assert.equal(carWheelLockDeg('amg-gt3'), 640);
  const binding = { padId: 'Simucube 2 Pro', axis: 0, center: 0, invert: false };
  // On a 900° wheel turned 180° right (raw = +0.4): full lock (+1.0) in F1, 180/320 = 0.5625 in AMG GT3
  near(wheelSteerValue(0.4, binding, 900, 0, carWheelLockDeg('lc26')), 1);
  near(wheelSteerValue(0.4, binding, 900, 0, carWheelLockDeg('amg-gt3')), 180 / 320);
  // On a 540° wheel driving the 640° AMG GT3, full physical lock (raw = ±1) still reaches full rack travel (±1)
  near(wheelSteerValue(1.0, binding, 540, 0, carWheelLockDeg('amg-gt3')), 1);
  near(wheelSteerValue(-1.0, binding, 540, 0, carWheelLockDeg('amg-gt3')), -1);
  // Soft lock at 250° right: past lock in F1 (< 0), still inside the 320° half-lock in AMG GT3 (0)
  assert.ok(softLockForce(250, carWheelLockDeg('lc26')) < 0);
  assert.equal(softLockForce(250, carWheelLockDeg('amg-gt3')), 0);
  assert.ok(softLockForce(330, carWheelLockDeg('amg-gt3')) < 0);
});
check("a player's steering lock quickens the rack, never slows it, and loads from saved settings", () => {
  const binding = { padId: 'Simucube 2 Pro', axis: 0, center: 0, invert: false };
  const locks = { 'amg-gt3': 400 };
  assert.equal(carWheelLockDeg('amg-gt3', locks), 400);
  assert.equal(carWheelLockDeg('lc26', locks), 360);
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
      favorites: { cars: ['amg-gt3', 'amg-gt3', 7, '', 'bad id', '<x>', 'a'.repeat(65), 'bmw-m4-gt3'], circuits: 'monaco' },
      recent: { cars: Array.from({ length: 40 }, (_, i) => `car${i}`), circuits: ['okayama', null] },
    },
  }).library;
  assert.deepEqual(lib.favorites, { cars: ['amg-gt3', 'bmw-m4-gt3'], circuits: [] });
  assert.equal(lib.recent.cars.length, LIBRARY_RECENT_MAX);
  assert.deepEqual(lib.recent.circuits, ['okayama']);
  const many = parsePlayerSettings({ library: { favorites: { cars: Array.from({ length: 999 }, (_, i) => `c${i}`) } } }).library;
  assert.equal(many.favorites.cars.length, LIBRARY_FAVORITES_MAX);
  // A venue starred through one layout comes off through any of them
  let l = toggleLibraryFavorite(DEFAULT_PLAYER_SETTINGS.library, 'circuits', ['okayama_piper', 'okayama']);
  assert.deepEqual(l.favorites.circuits, ['okayama_piper']);
  l = toggleLibraryFavorite(l, 'circuits', ['okayama', 'okayama_piper']);
  assert.deepEqual(l.favorites.circuits, []);
  // Recents: newest first, no repeats, same object when nothing changes
  let r = pushLibraryRecent(DEFAULT_PLAYER_SETTINGS.library, 'cars', 'amg-gt3');
  r = pushLibraryRecent(r, 'cars', 'bmw-m4-gt3');
  r = pushLibraryRecent(r, 'cars', 'amg-gt3');
  assert.deepEqual(r.recent.cars, ['amg-gt3', 'bmw-m4-gt3']);
  assert.equal(pushLibraryRecent(r, 'cars', 'amg-gt3'), r);
  const s = { ...DEFAULT_PLAYER_SETTINGS, library: r };
  assert.deepEqual(parsePlayerSettings(JSON.parse(JSON.stringify(s))), s);
});
console.log('Steering assist settings');
check('every assist slider is clamped to its range on load, and a broken value takes its default', () => {
  for (const tuningKey of ['padTuning', 'keyboardTuning'] as const) {
    const low = parsePlayerSettings({ [tuningKey]: Object.fromEntries(ASSIST_SLIDERS.map((s) => [s.key, s.min - 100])) })[tuningKey];
    const high = parsePlayerSettings({ [tuningKey]: Object.fromEntries(ASSIST_SLIDERS.map((s) => [s.key, s.max + 100])) })[tuningKey];
    const broken = parsePlayerSettings({ [tuningKey]: Object.fromEntries(ASSIST_SLIDERS.map((s) => [s.key, 'x'])) })[tuningKey];
    for (const s of ASSIST_SLIDERS) {
      assert.equal(low[s.key], s.min, `${tuningKey}.${s.key} low`);
      assert.equal(high[s.key], s.max, `${tuningKey}.${s.key} high`);
      assert.equal(broken[s.key], s.default, `${tuningKey}.${s.key} broken`);
      assert.equal(DEFAULT_DEVICE_ASSIST_TUNING[s.key], s.default);
    }
  }
  // The assist reads the same ranges: a value past a slider's end works as the end
  const past = sanitizeAssistTuning({ maxSelfSteerAngleDeg: 90, slipLimitMargin: 1 });
  assert.equal(deviceAssistTuning(past, 'controller').maxSelfSteerAngleDeg, 30);
  assert.deepEqual(deviceAssistTuning({ ...DEFAULT_DEVICE_ASSIST_TUNING, maxSelfSteerAngleDeg: 90 }, 'keyboard'), deviceAssistTuning({ ...DEFAULT_DEVICE_ASSIST_TUNING, maxSelfSteerAngleDeg: 30 }, 'keyboard'));
});
check('trigger slip buzz with ABS / TC on is off unless the player turned it on', () => {
  assert.equal(DEFAULT_PLAYER_SETTINGS.padTuning.triggerSlipAlwaysOn, false);
  assert.equal(parsePlayerSettings({ padTuning: {} }).padTuning.triggerSlipAlwaysOn, false);
  assert.equal(parsePlayerSettings({ padTuning: { triggerSlipAlwaysOn: true } }).padTuning.triggerSlipAlwaysOn, true);
});
check('steerAssistLevel is gone: a save with it loads the per-device sliders as they are, or their defaults', () => {
  const old = parsePlayerSettings({ steerAssistLevel: 0.9 });
  assert.equal('steerAssistLevel' in old, false);
  assert.deepEqual(old.padTuning, DEFAULT_PLAYER_SETTINGS.padTuning);
  assert.deepEqual(old.keyboardTuning, DEFAULT_PLAYER_SETTINGS.keyboardTuning);
  const own = parsePlayerSettings({ steerAssistLevel: 0.1, keyboardTuning: { selfSteerStrength: 0.7 } });
  assert.equal(own.keyboardTuning.selfSteerStrength, 0.7);
  assert.equal(own.keyboardTuning.dampingStrength, DEFAULT_DEVICE_ASSIST_TUNING.dampingStrength);
});
check("the cars' default assist is the game's for the default settings", () => {
  assert.deepEqual(DEFAULT_STEERING_ASSIST, steeringAssistSettings(DEFAULT_PLAYER_SETTINGS.padTuning, DEFAULT_PLAYER_SETTINGS.keyboardTuning));
  // and the keyboard's default ramp times are the assist's reference ones
  assert.equal(DEFAULT_STEERING_ASSIST.keyboard.riseScale, 1);
  assert.equal(DEFAULT_STEERING_ASSIST.keyboard.returnScale, 1);
});
check('each settings card resets exactly the fields it shows', () => {
  const assistKeys = ASSIST_SLIDERS.map((s) => s.key);
  const moved = (t: object, skip: readonly string[] = []) =>
    Object.fromEntries(Object.entries(t).map(([k, v]) => [k, skip.includes(k) ? v : typeof v === 'boolean' ? !v : v + 0.01]));
  const pad = moved(DEFAULT_PAD_TUNING) as typeof DEFAULT_PAD_TUNING;
  const fine = resetPadTuning(pad, PAD_FINE_TUNING_FIELDS, 'sharp');
  for (const k of Object.keys(pad) as (keyof typeof pad)[]) {
    const inCard = (PAD_FINE_TUNING_FIELDS as readonly string[]).includes(k);
    const want = k === 'steeringRate' || k === 'deadzone' ? PAD_SENSITIVITY.sharp[k] : inCard ? DEFAULT_PAD_TUNING[k] : pad[k];
    assert.equal(fine[k], want, `pad fine tuning ${k}`);
  }
  const pausePad = resetPadTuning(pad, PAUSE_PAD_FIELDS, 'smooth');
  assert.equal(pausePad.steeringRate, PAD_SENSITIVITY.smooth.steeringRate);
  assert.equal(pausePad.deadzone, pad.deadzone);
  for (const k of assistKeys) assert.equal(pausePad[k], pad[k]);
  const kb = moved(DEFAULT_KEYBOARD_TUNING) as typeof DEFAULT_KEYBOARD_TUNING;
  for (const fields of [KEYBOARD_FEEL_FIELDS, KEYBOARD_PEDAL_HELP_FIELDS, PAUSE_KEYBOARD_FIELDS]) {
    const r = resetKeyboardTuning(kb, fields);
    for (const k of Object.keys(kb) as (keyof typeof kb)[]) {
      assert.equal(r[k], (fields as readonly string[]).includes(k) ? DEFAULT_KEYBOARD_TUNING[k] : kb[k], `keyboard ${k}`);
    }
  }
  // No card but the assist card owns an assist slider
  for (const fields of [PAD_FINE_TUNING_FIELDS, PAUSE_PAD_FIELDS, KEYBOARD_FEEL_FIELDS, KEYBOARD_PEDAL_HELP_FIELDS, PAUSE_KEYBOARD_FIELDS]) {
    for (const k of fields) assert.ok(!(assistKeys as readonly string[]).includes(k), `${k} belongs to the assist card`);
  }
});
check('presets sit in the sliders\' ranges, match themselves only, and describe their own numbers', () => {
  for (const p of ASSIST_PRESETS) {
    assert.deepEqual(sanitizeAssistTuning(p.tuning), p.tuning, `${p.id} in range`);
    assert.equal(matchingAssistPreset(p.tuning)?.id, p.id);
    for (const s of ASSIST_SLIDERS) {
      const nudged = { ...p.tuning, [s.key]: p.tuning[s.key] + (p.tuning[s.key] + s.step <= s.max ? s.step : -s.step) };
      assert.notEqual(matchingAssistPreset(nudged)?.id, p.id, `${p.id} nudged on ${s.key}`);
    }
    const grip = Math.round(deviceAssistTuning(p.tuning, 'controller').targetSlip * 100);
    assert.ok(assistPresetDetail(p.tuning).includes(`${grip} %`), `${p.id}: ${assistPresetDetail(p.tuning)}`);
  }
  assert.ok(assistPresetDetail(ASSIST_PRESETS[0].tuning, 19.3).endsWith('full lock'));
  assert.ok(assistPresetDetail({ ...DEFAULT_DEVICE_ASSIST_TUNING, maxSelfSteerAngleDeg: 8 }, 19.3).endsWith('8°'));
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
check('a touch screen starts on Medium graphics until the player picks; a saved preset is kept', () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
  const prevStorage = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  g.window = { matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }) };
  try {
    assert.equal(defaultGraphicsSettings().quality, 'medium');
    assert.equal(loadPlayerSettings().graphics.quality, 'medium', 'first visit');
    assert.equal(parsePlayerSettings({}).graphics.quality, 'medium', 'a save without graphics');
    assert.equal(parsePlayerSettings({ graphics: { quality: 'ultra', renderScale: 0.8 } }).graphics.quality, 'medium', 'an unknown preset');
    assert.equal(parsePlayerSettings({ graphics: { quality: 'high' } }).graphics.quality, 'high', 'a saved High is kept');
    store.set(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_PLAYER_SETTINGS, graphics: { ...DEFAULT_PLAYER_SETTINGS.graphics, quality: 'low' } }));
    assert.equal(loadPlayerSettings().graphics.quality, 'low', 'a saved Low is kept');
    assert.equal(resetAllSettings(loadPlayerSettings()).graphics.quality, 'medium', 'Reset all settings');
    assert.equal(DEFAULT_PLAYER_SETTINGS.graphics.quality, 'high', 'the prerendered defaults stay as they were');
  } finally {
    delete g.window;
    if (prevStorage === undefined) delete g.localStorage;
    else g.localStorage = prevStorage;
  }
  assert.equal(defaultGraphicsSettings().quality, 'high', 'no touch screen (or no window): High');
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

check('clearing or rebinding the steering with the wheel plugged in is not an unplug', () => {
  const reader = new DeviceInputReader();
  const steer = { padId: 'DD base', axis: 0, center: 0, invert: false };
  const pads = [pad('DD base', '', [0.1, 0])];
  const bound = { wheel: { ...DEFAULT_WHEEL_SETTINGS, steer }, padButtons: DEFAULT_PAD_BUTTONS };
  const withSteer = (s: typeof steer | null) => ({ ...bound, wheel: { ...bound.wheel, steer: s } });
  assert.equal(reader.read(pads, bound, 1 / 60).wheelLost, undefined);
  assert.equal(reader.read(pads, withSteer({ ...steer, axis: 1 }), 1 / 60).wheelLost, undefined, 'rebound to another axis');
  assert.equal(reader.read(pads, withSteer(null), 1 / 60).wheelLost, undefined, 'steering cleared');
  assert.equal(reader.read(pads, withSteer({ ...steer, padId: 'Other base' }), 1 / 60).wheelLost, undefined, 'bound to an absent device');
  assert.equal(reader.read(pads, bound, 1 / 60).wheelLost, undefined, 'bound again');
  assert.equal(reader.read([], bound, 1 / 60).wheelLost, true, 'then unplugged: lost');
});
check('a button already held on the device the input switches to is not a press; pressing it again is', () => {
  const reader = new DeviceInputReader();
  const settings = { wheel: { ...DEFAULT_WHEEL_SETTINGS, steer: { padId: 'DD base', axis: 0, center: 0, invert: false } }, padButtons: DEFAULT_PAD_BUTTONS };
  const xboxHeld = pad('Xbox', 'standard', [0, 0], [5]);
  assert.equal(reader.read([pad('DD base', '', [0]), xboxHeld], settings, 1 / 60).source, 'wheel');
  const switched = reader.read([xboxHeld], settings, 1 / 60);
  assert.equal(switched.source, 'controller');
  assert.ok(!switched.pressed.has('shiftUp'), 'held across the switch: no press');
  reader.read([pad('Xbox', 'standard', [0, 0])], settings, 1 / 60);
  assert.ok(reader.read([xboxHeld], settings, 1 / 60).pressed.has('shiftUp'), 'pressed again: a press');
  // A pad that only appears with a press (the browser hides it until then) still counts from no device at all
  const fresh = new DeviceInputReader();
  const pads = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: DEFAULT_PAD_BUTTONS };
  assert.equal(fresh.read([], pads, 1 / 60).source, null);
  assert.ok(fresh.read([xboxHeld], pads, 1 / 60).pressed.has('shiftUp'), 'first press of a pad that just appeared');
});
check('the polarity reset is stored with its flag: a load that no save follows does not lose it', () => {
  const store = new Map<string, string>();
  let failSettingsWrite = false;
  const g = globalThis as unknown as { localStorage?: Storage };
  const prevStorage = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failSettingsWrite && k === SETTINGS_STORAGE_KEY) throw new Error('quota');
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  try {
    const legacy = { ...DEFAULT_PLAYER_SETTINGS, wheel: { ...DEFAULT_WHEEL_SETTINGS, ffbInvert: true } };
    store.set(SETTINGS_STORAGE_KEY, JSON.stringify(legacy));
    assert.equal(loadPlayerSettings().wheel.ffbInvert, false);
    assert.equal(loadPlayerSettings().wheel.ffbInvert, false, 'a second load, with no save between, is still reset');
    assert.equal(JSON.parse(store.get(SETTINGS_STORAGE_KEY) as string).wheel.ffbInvert, false, 'the reset is stored');
    // The settings write failing leaves the flag unstamped, so the next load resets it again
    store.clear();
    store.set(SETTINGS_STORAGE_KEY, JSON.stringify(legacy));
    failSettingsWrite = true;
    assert.equal(loadPlayerSettings().wheel.ffbInvert, false);
    assert.equal(store.get(FFB_POLARITY_V2_KEY), undefined, 'no flag without the stored reset');
  } finally {
    if (prevStorage === undefined) delete g.localStorage;
    else g.localStorage = prevStorage;
  }
});
check('stop() forgets the rim angle and filter: the first frame after it has no damper kick', () => {
  const steer = { padId: 'Wheel', axis: 0, center: 0, invert: false };
  const w = { ...DEFAULT_WHEEL_SETTINGS, ffbEnabled: true, hidFfb: true, ffbMinForce: 0, ffbFilterS: 0, ffbDamping: 0.5, rotationDeg: 900, steer };
  const c = new WheelFfbClient();
  c.hidSink = () => {};
  c.update({ speedKmh: 100, ffbTorqueNorm: 0 } as never, w, [pad('Wheel', '', [0])], 1000, true);
  c.stop(); // e.g. the tab was hidden
  c.update({ speedKmh: 100, ffbTorqueNorm: 0 } as never, w, [pad('Wheel', '', [0.1])], 1020, true);
  const fresh = new WheelFfbClient();
  fresh.hidSink = () => {};
  fresh.update({ speedKmh: 100, ffbTorqueNorm: 0 } as never, w, [pad('Wheel', '', [0.1])], 1020, true);
  near(c.force, fresh.force);
  c.stop();
  fresh.stop();
});
check('the direction test takes the route update() takes: the bridge while WebHID FFB is off, even with the driver ready', () => {
  const c = new WheelFfbClient();
  const sent: number[] = [];
  c.hidSink = (f) => sent.push(f);
  c.update({ speedKmh: 0, ffbTorqueNorm: 0 } as never, { ...DEFAULT_WHEEL_SETTINGS, hidFfb: false }, [], 1000, false);
  sent.length = 0;
  assert.equal(c.test(false), false, 'bridge route (not connected here)');
  assert.equal(sent.length, 0, 'nothing went to the WebHID wheel');
  c.update({ speedKmh: 0, ffbTorqueNorm: 0 } as never, { ...DEFAULT_WHEEL_SETTINGS, hidFfb: true }, [], 1016, false);
  assert.equal(c.test(false), true, 'WebHID route once it is on');
  c.stop();
});
check('bridge socket: replaced is final until FFB goes off and on; a retry after a failure stays "unreachable"', () => {
  const made: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      made.push(this);
    }
    send() {}
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    message(m: object) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const g = globalThis as unknown as { WebSocket?: unknown };
  const prevWs = g.WebSocket;
  g.WebSocket = FakeSocket;
  try {
    const c = new WheelFfbClient();
    const on = { ...DEFAULT_WHEEL_SETTINGS, ffbEnabled: true, hidFfb: false };
    const tick = (ms: number, w = on) => c.update({ speedKmh: 0, ffbTorqueNorm: 0 } as never, w, [], ms, false);
    tick(1000);
    assert.equal(made.length, 1);
    assert.equal(c.status.connection, 'connecting');
    made[0].open();
    assert.equal(c.status.connection, 'connected');
    made[0].message({ type: 'replaced' });
    assert.equal(c.status.connection, 'replaced');
    assert.ok(made[0].closed, 'the replaced socket is let go of');
    made[0].message({ type: 'status', ok: true, device: 'Wheel' });
    made[0].drop();
    assert.equal(c.status.connection, 'replaced', 'a late status or close from it changes nothing');
    tick(7000);
    assert.equal(made.length, 1, 'no new attempt while replaced');
    tick(7016, { ...on, ffbEnabled: false });
    assert.equal(c.status.connection, 'off');
    tick(7032);
    assert.equal(made.length, 2);
    assert.equal(c.status.connection, 'connecting');
    made[1].drop();
    assert.equal(c.status.connection, 'unreachable');
    tick(13000);
    assert.equal(made.length, 3, 'retried after 5 s');
    assert.equal(c.status.connection, 'unreachable', 'the retry keeps the how-to-start help on screen');
    made[2].open();
    assert.equal(c.status.connection, 'connected');
    c.dispose();
    assert.equal(c.status.connection, 'off');
  } finally {
    g.WebSocket = prevWs;
  }
});

/** Manual clock and timers for the WebHID driver and its writer */
function manualClock() {
  let t = 1000;
  let timers: { fn: () => void; at: number }[] = [];
  const deps: FfbDeps = {
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      timers = timers.filter((x) => x !== h);
    },
    sleep: async () => {},
  };
  return {
    deps,
    advance(ms: number) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      for (const d of due) d.fn();
    },
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 30; i++) await flush();
};

/** A Logitech G29's HID interface (lg4ff's 7-byte output report), its writes logged */
class FakeG29 implements HidDeviceLike {
  opened = false;
  vendorId = 0x046d;
  productId = 0xc24f;
  productName = 'G29';
  collections: readonly HidCollectionLike[] = [
    {
      usagePage: 0x01,
      usage: 0x04,
      outputReports: [
        {
          reportId: 0,
          items: [{ usages: [(0xff00 << 16) | 1], reportSize: 8, reportCount: 7, logicalMinimum: 0, logicalMaximum: 255, isArray: false, isConstant: false }],
        },
      ],
    },
  ];
  log: number[][] = [];
  failSends = false;
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(_id: number, data: Uint8Array) {
    this.log.push([...data]);
    if (this.failSends) throw new Error('device vanished');
  }
  async sendFeatureReport() {}
  async receiveFeatureReport(): Promise<DataView> {
    throw new Error('no feature reports');
  }
}

function fakeHidApi(picked: HidDeviceLike[], granted: HidDeviceLike[] = []) {
  let connectListeners = 0;
  const api: HidApiLike = {
    requestDevice: async () => picked,
    getDevices: async () => granted,
    addEventListener: (t) => {
      if (t === 'connect') connectListeners++;
    },
    removeEventListener: (t) => {
      if (t === 'connect') connectListeners--;
    },
  };
  return { api, connectListeners: () => connectListeners };
}

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

    const at100 = lastHwDamper;
    assert.ok(at100 > 0, 'the wheel damps while driving');
    assert.ok(Math.abs(cHw.force) < Math.abs(cSoft.force), 'with the wheel damping, the software damper backs off');
    cHw.update({ speedKmh: 220, ffbTorqueNorm: 0 } as never, wDamp, [pad('Wheel', '', [0.1])], 1040, true);
    assert.ok(lastHwDamper > at100, 'the wheel damps more at speed (gyroscopic)');
    cHw.update({ speedKmh: 220, ffbTorqueNorm: 0 } as never, wDamp, [pad('Wheel', '', [0.1])], 1060, false);
    assert.equal(lastHwDamper, 0, 'no damping out of the car');
    cHw.stop();
    cSoft.stop();
    unlink();
    passed++;
    console.log('  ok  WebHID hardware damper: on while driving, rising with speed, off out of the car, software damper backs off');
  }

  // The watchdog zeroes the meter the shell polls along with the force
  {
    const c = new WheelFfbClient();
    c.hidSink = () => {};
    c.update({ speedKmh: 50, ffbTorqueNorm: 0.6 } as never, wheel, [], 1000, true);
    assert.ok(c.meter.force > 0);
    await new Promise((r) => setTimeout(r, HID_WATCHDOG_MS + 40));
    assert.equal(c.meter.force, 0, 'meter force zeroed with the wheel');
    assert.equal(c.meter.clipping, false);
    c.stop();
    passed++;
    console.log('  ok  WebHID watchdog: the polled meter reads zero once it has let go of the wheel');
  }

  // ForceWriter: an urgent value dropped as already held takes its urgency with it
  {
    const clock = manualClock();
    const sent: number[] = [];
    let finish: () => void = () => {};
    const w = new ForceWriter(
      { bitOffset: 0, bitSize: 8, min: 0, max: 255, signed: false },
      (raw) => {
        sent.push(raw);
        return new Promise<void>((resolve) => (finish = resolve));
      },
      clock.deps
    );
    w.setForce(0.5); // out at once, held in flight
    assert.equal(sent.length, 1);
    w.setForce(0, true); // an urgent zero queued behind it
    w.setForce(0.5); // the wheel already holds 0.5: the queued zero is dropped
    finish();
    await flush();
    assert.equal(sent.length, 1, 'nothing left queued');
    w.setForce(0.8);
    assert.equal(sent.length, 1, 'an ordinary value right after a write waits out the 2 ms spacing');
    clock.advance(2);
    await flush();
    assert.equal(sent.length, 2);
    w.kill();
    passed++;
    console.log('  ok  ForceWriter: a dropped urgent value leaves no urgency behind for the next ordinary one');
  }

  // A fatal write failure lets go of the session: torn down at once, and every later call sees no session
  {
    const clock = manualClock();
    const g29 = new FakeG29();
    const hid = fakeHidApi([g29], [g29]);
    const ffb = new WebHidFfb(hid.api, clock.deps);
    assert.equal(await ffb.connect(), 'G29');
    g29.failSends = true;
    const failedAt = g29.log.length;
    for (let i = 0; i < 3; i++) {
      clock.advance(10);
      ffb.setForce(i % 2 === 0 ? 0.6 : -0.6);
      await flush();
      await flush();
    }
    assert.equal(ffb.status.state, 'error');
    await settle();
    assert.ok(g29.log.slice(failedAt).some((r) => r[0] === 0x13), 'teardown tried force off after the failure');
    assert.ok(g29.log.slice(failedAt).some((r) => r[0] === 0x14), 'and the centring spring back on');
    assert.equal(g29.opened, false, 'device closed');
    assert.equal(ffb.status.state, 'error', 'the reason stays on screen');
    // A cancelled picker no longer reports the dead wheel as connected
    hid.api.requestDevice = async () => [];
    assert.equal(await ffb.connect(), null);
    // The wheel works again: reconnect() sets it up afresh rather than answering with the old session
    g29.failSends = false;
    const before = g29.log.length;
    assert.equal(await ffb.reconnect(), 'G29');
    assert.equal(ffb.status.state, 'ready');
    assert.equal(g29.opened, true);
    assert.ok(g29.log.slice(before).some((r) => r[0] === 0xf5), 'set up again (spring off)');
    await ffb.dispose();
    passed++;
    console.log('  ok  WebHID fatal write failure: session torn down at once, error kept, reconnect sets the wheel up again');
  }

  // connect(): only a chosen wheel arms the re-open on hotplug; a dispose() while the picker is open wins
  {
    const g29 = new FakeG29();
    const cancelled = fakeHidApi([]);
    const a = new WebHidFfb(cancelled.api, manualClock().deps);
    assert.equal(await a.connect(), null);
    assert.equal(cancelled.connectListeners(), 0, 'a cancelled picker arms nothing');
    const picked = fakeHidApi([g29]);
    const b = new WebHidFfb(picked.api, manualClock().deps);
    assert.equal(await b.connect(), 'G29');
    assert.equal(picked.connectListeners(), 1, 'a chosen wheel is re-opened when it comes back');
    await b.dispose();
    assert.equal(picked.connectListeners(), 0);
    // The picker still open when the driver is switched off: the pick is let go of and nothing is armed
    const slow = fakeHidApi([]);
    let choose: (d: HidDeviceLike[]) => void = () => {};
    slow.api.requestDevice = () => new Promise((resolve) => (choose = resolve));
    const c = new WebHidFfb(slow.api, manualClock().deps);
    const connecting = c.connect();
    const disposing = c.dispose();
    choose([new FakeG29()]);
    await connecting;
    await disposing;
    assert.equal(slow.connectListeners(), 0, 'not re-armed after dispose');
    assert.equal(c.status.state, 'idle');
    passed++;
    console.log('  ok  WebHID connect(): hotplug armed only by a chosen wheel, never after a dispose');
  }

  // A second Connect whose picker fails (one is already open, no user gesture) keeps the running wheel
  {
    const g29 = new FakeG29();
    const hid = fakeHidApi([g29]);
    const ffb = new WebHidFfb(hid.api, manualClock().deps);
    assert.equal(await ffb.connect(), 'G29');
    hid.api.requestDevice = async () => {
      throw new Error('A chooser is already open');
    };
    assert.equal(await ffb.connect(), 'G29');
    assert.equal(ffb.status.state, 'ready');
    assert.equal(g29.opened, true);
    await ffb.dispose();
    passed++;
    console.log('  ok  WebHID connect(): a failing picker keeps a wheel that is already running');
  }
  console.log(`\n${passed} checks passed`);
}
asyncChecks().catch((e) => {
  console.error(e);
  process.exit(1);
});
