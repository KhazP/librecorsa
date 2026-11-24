/**
 * Checks the input layer and saved settings without a browser:
 *   npx tsx scripts/verify-input.ts
 */
import assert from 'node:assert/strict';
import { ScreenWakeLock, shouldHoldWakeLock, type WakeLockSentinelLike } from '../src/lib/screen-wake-lock';
import { FlashTimer, HeadlightButton, LIGHTS_HOLD_MS, MIN_FLASH_MS } from '../src/lib/input/headlight-button';
import { HELD_KEYS, heldActionsOf, PhysicalKeys } from '../src/lib/input/held-keys';
import {
  buildKeyLookup,
  clearKey,
  DEFAULT_KEY_BINDINGS,
  BUMPER_SHIFT_BUTTONS,
  DEFAULT_PAD_BUTTONS,
  DEFAULT_PAD_PEDAL_SOURCES,
  freePedalButtons,
  KEY_ACTIONS,
  matchPadLayout,
  matchPedalSet,
  PAD_ACTIONS,
  PAD_LAYOUT_IDS,
  PAD_LAYOUTS,
  PAD_PEDAL_SETS,
  PAD_RIGHT_STICK_BUTTON,
  pedalOnButton,
  pedalsOnTriggers,
  pedalStickClicks,
  pressPedalText,
  rebindKey,
  withPedalSet,
  type PadPedalSources,
  rebindPadButton,
  RETIRED_GT_STYLE_BUTTONS,
} from '../src/lib/input/bindings';
import {
  autoConfigureWheel,
  CAR_WHEEL_LOCK_DEG,
  carWheelLockDeg,
  DEFAULT_WHEEL_SETTINGS,
  DeviceInputReader,
  PAD_TRIGGER_PRESS,
  PAD_TRIGGER_RELEASE,
  padTriggerDown,
  PAD_SENSITIVITY,
  padPedals,
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
  AUTO_QUALITY_MIN_SCALES,
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
import { RENDER_SCALE_FLOOR } from '../src/lib/render/adaptive-quality';
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
import { tiltSteer, touchLayout } from '../src/components/settings/defs';
import { resetTouchInput, touchInput } from '../src/lib/input/touch-input';
import { drivingInputOf } from '../src/lib/sim/lap-types';
import type { SettingsEnv } from '../src/components/settings/env';
import {
  enterFullscreenOnTouch,
  installedFrom,
  installStore,
  isAppleTouch,
  isAppleTouchAgent,
  isInstalledApp,
} from '../src/lib/install-app';

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
check('Half brake sits on G beside Half throttle; a save that already uses G keeps it and leaves Half brake unbound', () => {
  const lookup = buildKeyLookup(DEFAULT_KEY_BINDINGS);
  assert.equal(lookup.get('KeyF'), 'throttleHalf');
  assert.equal(lookup.get('KeyG'), 'brakeHalf');
  const { brakeHalf: _unsaved, ...older } = { ...DEFAULT_KEY_BINDINGS, camera: ['KeyC', 'KeyG'] };
  const keys = parsePlayerSettings({ keys: older }).keys;
  assert.deepEqual(keys.camera, ['KeyC', 'KeyG']);
  assert.deepEqual(keys.brakeHalf, []);
});
check('the Half brake amount defaults to 50 % and stays within 20-90 %', () => {
  assert.equal(parsePlayerSettings({}).keyboardTuning.halfBrake, 0.5);
  assert.equal(parsePlayerSettings({ keyboardTuning: { halfBrake: 0.35 } }).keyboardTuning.halfBrake, 0.35);
  assert.equal(parsePlayerSettings({ keyboardTuning: { halfBrake: 2 } }).keyboardTuning.halfBrake, 0.9);
  assert.equal(parsePlayerSettings({ keyboardTuning: { halfBrake: 0 } }).keyboardTuning.halfBrake, 0.2);
  assert.ok((KEYBOARD_FEEL_FIELDS as readonly string[]).includes('halfBrake'), 'the keyboard feel card resets it');
});
check('a pad button moves between actions', () => {
  const next = rebindPadButton(DEFAULT_PAD_BUTTONS, 'racingLine', 0); // A was gear up
  assert.equal(next.racingLine, 0);
  assert.equal(next.shiftUp, null);
});
check('a new player gets GT style; a saved map keeps its buttons, and an action it lacks takes Bumper shift\'s', () => {
  assert.equal(DEFAULT_PAD_BUTTONS, PAD_LAYOUTS.gt.buttons);
  assert.equal(DEFAULT_PLAYER_SETTINGS.padButtons, DEFAULT_PAD_BUTTONS);
  assert.deepEqual(parsePlayerSettings({}).padButtons, PAD_LAYOUTS.gt.buttons);
  // A save from before the switch: the whole Bumper shift map
  const old = { ...PAD_LAYOUTS.bumper.buttons };
  const reloaded = parsePlayerSettings(JSON.parse(JSON.stringify({ ...DEFAULT_PLAYER_SETTINGS, padButtons: old }))).padButtons;
  assert.deepEqual(reloaded, old);
  assert.equal(matchPadLayout(reloaded), 'bumper');
  // An older save without the HUD action: Bumper shift's R3, not GT style's LB (gear down there)
  const { hud: _hud, ...noHud } = old;
  assert.equal(parsePlayerSettings({ padButtons: noHud }).padButtons.hud, PAD_LAYOUTS.bumper.buttons.hud);
  // Headlights are on L3 by default (GT7's button), can move, and survive save/load
  assert.equal(DEFAULT_PAD_BUTTONS.headlights, 10);
  const withHeadlights = rebindPadButton(DEFAULT_PAD_BUTTONS, 'headlights', 3);
  assert.equal(withHeadlights.headlights, 3);
  assert.equal(parsePlayerSettings({ padButtons: withHeadlights }).padButtons.headlights, 3);
  const withFlash = rebindPadButton(BUMPER_SHIFT_BUTTONS, 'headlightFlash', 1);
  assert.equal(parsePlayerSettings({ padButtons: withFlash }).padButtons.headlightFlash, 1);
});
check('GT style as saved before the headlights (L3 the MFD) moves on to GT style as it is now', () => {
  const { headlightFlash: _flash, ...oldGt } = RETIRED_GT_STYLE_BUTTONS;
  const saved = JSON.parse(JSON.stringify({ ...DEFAULT_PLAYER_SETTINGS, padButtons: oldGt }));
  const reloaded = parsePlayerSettings(saved).padButtons;
  assert.deepEqual(reloaded, PAD_LAYOUTS.gt.buttons);
  assert.equal(matchPadLayout(reloaded), 'gt');
  // A player who changed one button of it keeps their own map
  const custom = parsePlayerSettings({ padButtons: { ...oldGt, racingLine: 4, hud: null } }).padButtons;
  assert.equal(custom.racingLine, 4);
  assert.equal(custom.mfd, 10);
  assert.equal(custom.headlights, null);
});
check('flash headlights: Y on the keyboard by default, beside the headlights key, and no other action shares it', () => {
  assert.deepEqual(DEFAULT_KEY_BINDINGS.headlightFlash, ['KeyY']);
  assert.deepEqual(DEFAULT_KEY_BINDINGS.headlights, ['KeyU']);
  const owners = KEY_ACTIONS.filter(({ id }) => DEFAULT_KEY_BINDINGS[id].includes('KeyY'));
  assert.deepEqual(owners.map((a) => a.id), ['headlightFlash']);
  // An older save without it gets Y unless the player put Y on something else
  assert.deepEqual(parsePlayerSettings({ keys: { ...DEFAULT_KEY_BINDINGS, headlightFlash: undefined } }).keys.headlightFlash, ['KeyY']);
  assert.deepEqual(parsePlayerSettings({ keys: { ...DEFAULT_KEY_BINDINGS, headlightFlash: undefined, racingLine: ['KeyY'] } }).keys.headlightFlash, []);
});
check('#171 keys held as the pause menu closes: held controls hold again, menu presses and one-shots do not', () => {
  const lookup = buildKeyLookup(DEFAULT_KEY_BINDINGS);
  const press = (code: string, mods: { repeat?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => ({
    code,
    repeat: mods.repeat ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
  });
  const resume = (keys: PhysicalKeys, l = lookup) => heldActionsOf(keys.restorable(l), l);

  // Throttle and steering pressed in the pause menu, before Flying lap was clicked: they drive at once
  const keys = new PhysicalKeys();
  keys.keyDown(press('KeyW'), 'menu');
  keys.keyDown(press('ArrowLeft'), 'menu');
  keys.keyDown(press('KeyW', { repeat: true }), 'menu');
  assert.deepEqual(resume(keys), { actions: ['throttle', 'steerLeft'], gearUpHeld: false });
  // One let go while the menu was open does not
  keys.keyUp('ArrowLeft');
  assert.deepEqual(resume(keys).actions, ['throttle']);
  // Held from before the pause, through it: still held
  const through = new PhysicalKeys();
  through.keyDown(press('KeyS'), 'drive');
  through.keyDown(press('Space'), 'drive');
  assert.deepEqual(resume(through).actions, ['brake', 'boostHold']);

  // One-shot keys never fire: the camera, a gear, a restart need a new press. Gear up held keeps only its hold (the
  // clutch at a manual start)
  const oneShots = new PhysicalKeys();
  for (const code of ['KeyC', 'KeyQ', 'KeyL', 'KeyR', 'KeyE']) oneShots.keyDown(press(code), 'drive');
  assert.deepEqual(resume(oneShots), { actions: [], gearUpHeld: true });

  // Enter / Space / Backspace pressed in the menu picked the item that resumed: not a driving input, even bound to
  // one, until the drive takes its repeat or it is pressed again
  const rebound = buildKeyLookup({ ...DEFAULT_KEY_BINDINGS, throttle: ['Enter'], boostHold: ['Space'], clutch: ['Backspace'] });
  const confirm = new PhysicalKeys();
  for (const code of ['Enter', 'Space', 'Backspace']) confirm.keyDown(press(code), 'menu');
  confirm.keyDown(press('Enter', { repeat: true }), 'menu');
  assert.deepEqual(resume(confirm, rebound).actions, []);
  confirm.keyDown(press('Enter', { repeat: true }), 'drive');
  assert.deepEqual(resume(confirm, rebound).actions, ['throttle']);
  confirm.keyUp('Space');
  confirm.keyDown(press('Space'), 'drive');
  assert.deepEqual(resume(confirm, rebound).actions, ['throttle', 'boostHold']);
  // ...but held from before the pause they still drive
  const heldEnter = new PhysicalKeys();
  heldEnter.keyDown(press('Enter'), 'drive');
  assert.deepEqual(resume(heldEnter, rebound).actions, ['throttle']);

  // The seat panel's own keys (arrows, Enter, R) stay the panel's; W held through it drives
  const seat = new PhysicalKeys();
  seat.keyDown(press('KeyW'), 'drive');
  seat.keyDown(press('ArrowRight'), 'seatPanel');
  assert.deepEqual(resume(seat).actions, ['throttle']);

  // A rebound key follows the bindings
  const moved = new PhysicalKeys();
  moved.keyDown(press('KeyK'), 'menu');
  assert.deepEqual(resume(moved, buildKeyLookup({ ...DEFAULT_KEY_BINDINGS, throttle: ['KeyK'], nextTrack: [] })).actions, ['throttle']);

  // Focus lost or the tab hidden: nothing is down any more
  keys.clear();
  assert.deepEqual(resume(keys).actions, []);
  // A Cmd shortcut is never noted (macOS sends no keyup for it), and letting go of Cmd forgets every key
  const cmd = new PhysicalKeys();
  cmd.keyDown(press('KeyD'), 'drive');
  cmd.keyDown(press('KeyW', { metaKey: true }), 'menu');
  assert.deepEqual(resume(cmd).actions, ['steerRight']);
  cmd.keyUp('MetaLeft');
  assert.deepEqual(resume(cmd).actions, []);
  // A key pressed with Alt is a view nudge, unless an Alt key bound to a control is down
  const alt = new PhysicalKeys();
  alt.keyDown(press('AltLeft', { altKey: true }), 'drive');
  alt.keyDown(press('ArrowUp', { altKey: true }), 'drive');
  assert.deepEqual(resume(alt).actions, []);
  assert.deepEqual(resume(alt, buildKeyLookup({ ...DEFAULT_KEY_BINDINGS, clutch: ['AltLeft'] })).actions, ['clutch', 'throttle']);
  // Every held control is one HELD_KEYS knows, and every one of them is a key action
  for (const action of Object.keys(HELD_KEYS)) assert.ok(KEY_ACTIONS.some(({ id }) => id === action), action);
});
check('the headlight button: a tap flashes, a hold switches the lights once, nothing in the menus', () => {
  // Frames 16 ms apart; `pressed` is the rising edge the device reader gives
  const run = (heldMs: number, active = true) => {
    const button = new HeadlightButton();
    let flashFrames = 0;
    let toggles = 0;
    for (let t = 0, wasDown = false; t <= heldMs + 200; t += 16) {
      const down = t < heldMs;
      const step = button.update(down && !wasDown, down, t, active);
      if (step.flash) flashFrames++;
      if (step.toggle) toggles++;
      wasDown = down;
    }
    return { flashFrames, toggles };
  };
  const tap = run(150);
  assert.ok(tap.flashFrames > 0 && tap.toggles === 0, `a tap flashes (${JSON.stringify(tap)})`);
  const hold = run(LIGHTS_HOLD_MS + 300);
  assert.equal(hold.toggles, 1, 'a hold switches the lights once');
  assert.ok(hold.flashFrames <= Math.ceil(LIGHTS_HOLD_MS / 16) + 1, 'and the flash stops when it switches');
  assert.deepEqual(run(LIGHTS_HOLD_MS + 300, false), { flashFrames: 0, toggles: 0 }, 'in the menus it does nothing');
  // A hold interrupted by the menus starts over
  const b = new HeadlightButton();
  b.update(true, true, 0, true);
  b.update(false, true, 300, false);
  assert.equal(b.update(false, true, 600, true).toggle, false);
});
check('a flash lasts at least MIN_FLASH_MS, and as long as it is held', () => {
  const timer = new FlashTimer();
  assert.equal(timer.update(true, 0, true), true);
  assert.equal(timer.update(false, 16, true), true, 'a one-frame tap keeps flashing');
  assert.equal(timer.update(false, MIN_FLASH_MS + 1, true), false);
  assert.equal(timer.update(true, 1000, true), true);
  assert.equal(timer.update(true, 1600, true), true, 'held: still on');
  assert.equal(timer.update(false, 1616, true), false, 'released after the least length: off at once');
  assert.equal(new FlashTimer().update(true, 0, false), false, 'not driving: no flash');
});
check('controller layouts: every action set, no shared button, pedal buttons / D-pad / thumb-restart left alone', () => {
  assert.equal(PAD_LAYOUTS.gt.buttons, DEFAULT_PAD_BUTTONS);
  assert.equal(PAD_LAYOUTS.gt.pedals, 'triggers');
  assert.deepEqual([PAD_LAYOUTS.bumper.buttons.shiftUp, PAD_LAYOUTS.bumper.buttons.shiftDown, PAD_LAYOUTS.bumper.buttons.boost], [5, 4, 0]);
  for (const id of PAD_LAYOUT_IDS) {
    const { buttons: b, pedals } = PAD_LAYOUTS[id];
    const sources = withPedalSet(DEFAULT_PAD_PEDAL_SOURCES, pedals);
    const used: number[] = [];
    for (const { id: action } of PAD_ACTIONS) {
      assert.notEqual(b[action], undefined, `${id}.${action} unset`);
      if (b[action] !== null) used.push(b[action] as number);
    }
    assert.equal(new Set(used).size, used.length, `${id}: a button does two things`);
    for (const button of used) assert.ok(button <= 11, `${id}: button ${button} is the D-pad or Home`);
    // Trigger pedals leave RT / LT alone; stick pedals leave R3 alone (the pedal thumb clicks it)
    if (pedals === 'triggers') for (const button of used) assert.ok(button !== 6 && button !== 7, `${id}: button ${button} is a pedal`);
    else assert.ok(!used.includes(PAD_RIGHT_STICK_BUTTON), `${id}: R3 under the pedal stick`);
    assert.equal(freePedalButtons(b, sources), b, `${id}: binds its own pedal buttons`);
    assert.equal(b.pause, 9, `${id}: pause off Menu`);
    assert.equal(b.restart, 8, `${id}: restart off View`);
  }
  // What each layout takes from its game
  assert.deepEqual([PAD_LAYOUTS.gt.buttons.shiftUp, PAD_LAYOUTS.gt.buttons.shiftDown, PAD_LAYOUTS.gt.buttons.boost], [0, 2, 11]);
  assert.equal(PAD_LAYOUTS.gtClassic.pedals, 'stick');
  assert.deepEqual([PAD_LAYOUTS.gtClassic.buttons.shiftUp, PAD_LAYOUTS.gtClassic.buttons.shiftDown], [7, 6]);
  // LB stays free in GT classic (and the left stick's up / down is no button): room for a clutch or a starter
  assert.ok(!Object.values(PAD_LAYOUTS.gtClassic.buttons).includes(4), 'GT classic leaves LB free');
  assert.deepEqual([PAD_LAYOUTS.f1.buttons.boost, PAD_LAYOUTS.f1.buttons.aero, PAD_LAYOUTS.f1.buttons.camera], [1, 3, 5]);
  assert.deepEqual([PAD_LAYOUTS.forza.buttons.shiftUp, PAD_LAYOUTS.forza.buttons.shiftDown, PAD_LAYOUTS.forza.buttons.camera], [1, 2, 5]);
  // Headlights where the game has them: GT7 on L3 (a tap flashes, a hold switches); classic GT, the F1 games and
  // Forza Motorsport have no headlight button, so those layouts leave them for the player to place
  assert.equal(PAD_LAYOUTS.gt.buttons.headlights, 10);
  // The MFD loses its own button there (a D-pad press opens it); the HUD keeps L1
  assert.equal(PAD_LAYOUTS.gt.buttons.mfd, null);
  assert.equal(PAD_LAYOUTS.gt.buttons.hud, 4);
  for (const id of ['gtClassic', 'f1', 'forza', 'bumper'] as const) assert.equal(PAD_LAYOUTS[id].buttons.headlights, null, `${id} has no headlight button`);
  for (const id of PAD_LAYOUT_IDS) assert.equal(PAD_LAYOUTS[id].buttons.headlightFlash, null, `${id}: the flash is the headlight button's tap`);
});
const STICK_SOURCES: PadPedalSources = withPedalSet(DEFAULT_PAD_PEDAL_SOURCES, 'stick');
check('the picked layout is read back from the bindings and pedal sources, through a save, and lost on a rebind', () => {
  for (const id of PAD_LAYOUT_IDS) {
    const pedalSources = withPedalSet(DEFAULT_PAD_PEDAL_SOURCES, PAD_LAYOUTS[id].pedals);
    const buttons = { ...PAD_LAYOUTS[id].buttons };
    assert.equal(matchPadLayout(buttons, pedalSources), id);
    const saved = parsePlayerSettings(
      JSON.parse(JSON.stringify({ ...DEFAULT_PLAYER_SETTINGS, padButtons: buttons, padTuning: { ...DEFAULT_PAD_TUNING, pedalSources } })),
    );
    assert.deepEqual(saved.padTuning.pedalSources, pedalSources, `${id} pedal sources after a reload`);
    assert.equal(matchPadLayout(saved.padButtons, saved.padTuning.pedalSources), id, `${id} after a reload`);
    assert.equal(matchPadLayout(rebindPadButton(buttons, 'racingLine', 4), pedalSources), null, `${id} rebound`);
    const other = withPedalSet(pedalSources, PAD_LAYOUTS[id].pedals === 'stick' ? 'triggers' : 'stick');
    assert.equal(matchPadLayout(buttons, other), null, `${id} with the other pedals`);
  }
});
check('pedal sources: sets, the buttons they take, the stick clicks under them, triggers for trigger feedback', () => {
  assert.equal(matchPedalSet(DEFAULT_PAD_PEDAL_SOURCES), 'triggers');
  assert.equal(matchPedalSet(STICK_SOURCES), 'stick');
  assert.equal(matchPedalSet({ ...STICK_SOURCES, brake: PAD_PEDAL_SETS.triggers.brake }), null, 'a mix is no set');
  assert.equal(pedalOnButton(DEFAULT_PAD_PEDAL_SOURCES, 7), 'throttle');
  assert.equal(pedalOnButton(STICK_SOURCES, 7), null);
  assert.deepEqual(pedalStickClicks(DEFAULT_PAD_PEDAL_SOURCES), []);
  assert.deepEqual(pedalStickClicks(STICK_SOURCES), [PAD_RIGHT_STICK_BUTTON]);
  assert.ok(pedalsOnTriggers(DEFAULT_PAD_PEDAL_SOURCES));
  assert.ok(!pedalsOnTriggers(STICK_SOURCES));
  assert.ok(!pedalsOnTriggers({ throttle: { kind: 'button', button: 6 }, brake: { kind: 'button', button: 7 }, clutch: null }), 'swapped is not the usual');
  assert.equal(pressPedalText(DEFAULT_PAD_PEDAL_SOURCES.throttle), 'Hold RT');
  assert.equal(pressPedalText(STICK_SOURCES.throttle), 'Push the right stick up');
});
check('trigger pedals free RT / LT; stick pedals leave the bindings as they are', () => {
  const classic = PAD_LAYOUTS.gtClassic.buttons;
  const freed = freePedalButtons(classic, DEFAULT_PAD_PEDAL_SOURCES);
  assert.equal(freed.shiftUp, null);
  assert.equal(freed.shiftDown, null);
  assert.equal(freed.boost, classic.boost);
  assert.equal(freePedalButtons(BUMPER_SHIFT_BUTTONS, DEFAULT_PAD_PEDAL_SOURCES), BUMPER_SHIFT_BUTTONS, 'nothing on the triggers: the same object');
  assert.equal(freePedalButtons(classic, STICK_SOURCES), classic);
  // A pedal on another button (a clutch on LB, say) frees that button's action too
  const lbPedal = { ...STICK_SOURCES, brake: { kind: 'button' as const, button: 4 } };
  assert.equal(freePedalButtons(PAD_LAYOUTS.gt.buttons, lbPedal).hud, null);
});
check('pedal settings: old saves keep the triggers, bad sources fall back, the dead zone is clamped', () => {
  const old = parsePlayerSettings({ padTuning: { throttleGamma: 1.5 } });
  assert.deepEqual(old.padTuning.pedalSources, DEFAULT_PAD_PEDAL_SOURCES);
  assert.equal(old.padTuning.stickPedalDeadzone, DEFAULT_PAD_TUNING.stickPedalDeadzone);
  assert.equal(old.padTuning.throttleGamma, 1.5);
  assert.deepEqual(parsePlayerSettings({ padSensitivity: 'sharp' }).padTuning.pedalSources, DEFAULT_PAD_PEDAL_SOURCES, 'a save from before padTuning');
  const broken = parsePlayerSettings({
    padTuning: { pedalSources: { throttle: { kind: 'axis', axis: 3, sign: 2 }, brake: null }, stickPedalDeadzone: 5 },
  }).padTuning;
  assert.deepEqual(broken.pedalSources, DEFAULT_PAD_PEDAL_SOURCES, 'a bad sign, and a throttle / brake saved off the pad');
  assert.equal(broken.stickPedalDeadzone, 0.3);
  const mixed = parsePlayerSettings({ padTuning: { pedalSources: { throttle: STICK_SOURCES.throttle } } }).padTuning.pedalSources;
  assert.deepEqual(mixed, { throttle: STICK_SOURCES.throttle, brake: DEFAULT_PAD_PEDAL_SOURCES.brake, clutch: null }, 'each pedal on its own');
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
  const settings = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: BUMPER_SHIFT_BUTTONS };
  const f1 = reader.read([pad('Xbox', 'standard', [0.4, 0], [0, 5], { 7: 0.8, 6: 0.1 })], settings, 1 / 60);
  assert.equal(f1.source, 'controller');
  near(f1.padSteer!, 0.4);
  near(f1.throttle, 0.8);
  assert.ok(f1.boostHeld);
  assert.ok(f1.pressed.has('shiftUp'));
  const f2 = reader.read([pad('Xbox', 'standard', [0, 0], [0, 5])], settings, 1 / 60);
  assert.ok(!f2.pressed.has('shiftUp'), 'a held button fires once');
});
check('controller button bound to headlights emits headlights on rising edge only', () => {
  const reader = new DeviceInputReader();
  const padButtons = rebindPadButton(DEFAULT_PAD_BUTTONS, 'headlights', 3);
  const settings = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons };
  const press1 = reader.read([pad('Xbox', 'standard', [0, 0], [3])], settings, 1 / 60);
  assert.ok(press1.pressed.has('headlights'), 'first press triggers headlights');
  const held = reader.read([pad('Xbox', 'standard', [0, 0], [3])], settings, 1 / 60);
  assert.ok(!held.pressed.has('headlights'), 'holding headlights button does not re-trigger');
  reader.read([pad('Xbox', 'standard', [0, 0], [])], settings, 1 / 60);
  const press2 = reader.read([pad('Xbox', 'standard', [0, 0], [3])], settings, 1 / 60);
  assert.ok(press2.pressed.has('headlights'), 'second press triggers headlights again');
});
check('a wheel not set up yet shifts on its paddles under the GT style default; a pad on A', () => {
  const settings = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: DEFAULT_PLAYER_SETTINGS.padButtons };
  const wheel = new DeviceInputReader().read([pad('G920 Driving Force Racing Wheel', 'standard', [0], [5])], settings, 1 / 60);
  assert.ok(wheel.pressed.has('shiftUp'), 'right paddle');
  assert.ok(!wheel.pressed.has('camera'));
  const pad1 = new DeviceInputReader().read([pad('Xbox', 'standard', [0, 0], [0])], settings, 1 / 60);
  assert.ok(pad1.pressed.has('shiftUp'), 'A');
});
check('stick pedals: right stick up throttle, down brake, dead zone at rest, full a little before the stop', () => {
  const stick = { pedalSources: STICK_SOURCES, stickPedalDeadzone: 0.1 };
  const at = (y: number) => padPedals(pad('Xbox', 'standard', [0, 0, 0, y], [], { 7: 0.9, 6: 0.9 }), stick);
  assert.deepEqual(at(0.08), { throttle: 0, brake: 0, clutch: 0 }, 'resting drift');
  assert.deepEqual(at(-0.08), { throttle: 0, brake: 0, clutch: 0 });
  near(at(-1).throttle, 1);
  near(at(-0.96).throttle, 1, 1e-9);
  near(at(-0.525).throttle, 0.5);
  assert.equal(at(-0.6).brake, 0, 'never both');
  near(at(1).brake, 1);
  assert.equal(at(1).throttle, 0);
  assert.equal(padPedals(pad('Xbox', 'standard', [0, 0], [], { 7: 0.9 }), stick).throttle, 0, 'a pad without axis 3');
  // Without stick pedals the triggers, whatever the stick does
  const triggers = padPedals(pad('Xbox', 'standard', [0, 0, 0, -1], [], { 7: 0.4, 6: 0.2 }), undefined);
  near(triggers.throttle, 0.4);
  near(triggers.brake, 0.2);
  // Each pedal reads its own source: the brake on the left stick's down half, the throttle still on RT
  const mixed = { pedalSources: { ...DEFAULT_PAD_PEDAL_SOURCES, brake: { kind: 'axis' as const, axis: 1, sign: 1 as const } }, stickPedalDeadzone: 0.1 };
  const m = padPedals(pad('Xbox', 'standard', [0, 1, 0, 0], [], { 7: 0.4, 6: 0.9 }), mixed);
  near(m.throttle, 0.4);
  near(m.brake, 1);
});
const LB_CLUTCH: PadPedalSources = { ...DEFAULT_PAD_PEDAL_SOURCES, clutch: { kind: 'button', button: 4 } };
check('clutch on a controller: none by default, its own button when given one, kept by a layout, never on a pedal', () => {
  assert.equal(DEFAULT_PAD_PEDAL_SOURCES.clutch, null);
  assert.equal(padPedals(pad('Xbox', 'standard', [0, 0, 0, 0], [4], { 7: 0.5 }), undefined).clutch, 0, 'no source reads 0');
  near(padPedals(pad('Xbox', 'standard', [0, 0, 0, 0], [4]), { pedalSources: LB_CLUTCH, stickPedalDeadzone: 0.1 }).clutch, 1);
  assert.equal(pedalOnButton(LB_CLUTCH, 4), 'clutch');
  const picked = withPedalSet(LB_CLUTCH, 'stick');
  assert.deepEqual(picked.clutch, LB_CLUTCH.clutch, 'a pedal set leaves the clutch where it is');
  assert.equal(matchPedalSet(picked), 'stick', 'the clutch is not part of a set');
  assert.equal(freePedalButtons(BUMPER_SHIFT_BUTTONS, LB_CLUTCH).shiftDown, null, 'LB lets go of gear down');
  // Saves: an old one has no clutch, one on the throttle's own trigger is dropped, one on a button of its own stays
  assert.equal(parsePlayerSettings({ padTuning: {} }).padTuning.pedalSources.clutch, null);
  const onRt = parsePlayerSettings({ padTuning: { pedalSources: { clutch: { kind: 'button', button: 7 } } } });
  assert.equal(onRt.padTuning.pedalSources.clutch, null, 'on RT, the throttle');
  const onLb = parsePlayerSettings({ padTuning: { pedalSources: { clutch: { kind: 'button', button: 4 } } } });
  assert.deepEqual(onLb.padTuning.pedalSources.clutch, { kind: 'button', button: 4 });
  // The keyboard's clutch has no key until the player gives it one
  assert.deepEqual(DEFAULT_KEY_BINDINGS.clutch, []);
  assert.equal(buildKeyLookup(rebindKey(DEFAULT_KEY_BINDINGS, 'clutch', 0, 'KeyZ')).get('KeyZ'), 'clutch');
});
check('neutral: N on the keyboard, no button of its own on a pad, gear up + gear down together on a pad and a wheel', () => {
  assert.deepEqual(DEFAULT_KEY_BINDINGS.neutral, ['KeyN']);
  assert.equal(buildKeyLookup(DEFAULT_KEY_BINDINGS).get('KeyN'), 'neutral');
  assert.equal(BUMPER_SHIFT_BUTTONS.neutral, null);
  for (const id of PAD_LAYOUT_IDS) assert.equal(PAD_LAYOUTS[id].buttons.neutral, null, `${id} leaves neutral to the paddles`);
  // A save from before neutral still reads as its layout
  const { neutral: _n, ...oldDefault } = BUMPER_SHIFT_BUTTONS;
  const old = parsePlayerSettings({ padButtons: oldDefault });
  assert.equal(old.padButtons.neutral, null);
  assert.equal(matchPadLayout(old.padButtons, old.padTuning.pedalSources), 'bumper');
  // LB then RB on a pad: gear down, then neutral as RB joins it, once
  const settings = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: BUMPER_SHIFT_BUTTONS };
  const r = new DeviceInputReader();
  const f1 = r.read([pad('Xbox', 'standard', [0, 0], [4])], settings, 1 / 60);
  assert.ok(f1.pressed.has('shiftDown') && !f1.pressed.has('neutral'));
  const f2 = r.read([pad('Xbox', 'standard', [0, 0], [4, 5])], settings, 1 / 60);
  assert.ok(f2.pressed.has('neutral'), 'the second paddle down');
  const f3 = r.read([pad('Xbox', 'standard', [0, 0], [4, 5])], settings, 1 / 60);
  assert.ok(!f3.pressed.has('neutral'), 'held, it fires once');
  // Both in one frame: both shifts and neutral (the car lets neutral win)
  const f4 = new DeviceInputReader().read([pad('Xbox', 'standard', [0, 0], [4, 5])], settings, 1 / 60);
  assert.ok(f4.pressed.has('neutral') && f4.pressed.has('shiftUp') && f4.pressed.has('shiftDown'));
  // A wheel's paddles, with its own neutral button too
  const wheel = {
    ...DEFAULT_WHEEL_SETTINGS,
    steer: { padId: 'G29', axis: 0, center: 0, invert: false },
    buttons: { ...DEFAULT_WHEEL_SETTINGS.buttons, shiftUp: { padId: 'G29', button: 4 }, shiftDown: { padId: 'G29', button: 5 }, neutral: { padId: 'G29', button: 9 } },
  };
  const w = new DeviceInputReader();
  w.read([pad('G29', '', [0])], { wheel, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60);
  assert.ok(w.read([pad('G29', '', [0], [4, 5])], { wheel, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60).pressed.has('neutral'), 'both paddles');
  w.read([pad('G29', '', [0])], { wheel, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60);
  assert.ok(w.read([pad('G29', '', [0], [9])], { wheel, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60).pressed.has('neutral'), 'its N button');
});
check('clutch in the device frame: the controller button, the calibrated clutch of a wheel pedal set, 0 with none', () => {
  const padSettings = {
    wheel: DEFAULT_WHEEL_SETTINGS,
    padButtons: freePedalButtons(BUMPER_SHIFT_BUTTONS, LB_CLUTCH),
    padTuning: { pedalSources: LB_CLUTCH, stickPedalDeadzone: 0.1 },
  };
  const f = new DeviceInputReader().read([pad('Xbox', 'standard', [0, 0], [4])], padSettings, 1 / 60);
  near(f.clutch, 1);
  assert.ok(!f.pressed.has('shiftDown'), 'the clutch button shifts nothing');
  const plain = new DeviceInputReader().read([pad('Xbox', 'standard', [0, 0], [4])], { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60);
  assert.equal(plain.clutch, 0);
  // A clutch pedal on axis 3 of a separate pedal set, idle at 1 and fully pressed at −1, half way down
  const wheel = {
    ...DEFAULT_WHEEL_SETTINGS,
    steer: { padId: 'G29', axis: 0, center: 0, invert: false },
    clutch: { padId: 'Pedals', axis: 3, idle: 1, full: -1 },
  };
  const reader = new DeviceInputReader();
  const w = reader.read([pad('G29', '', [0]), pad('Pedals', '', [0, 0, 0, 0])], { wheel, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60);
  assert.equal(w.source, 'wheel');
  near(w.clutch, (0.5 - 0.02) / 0.98);
  // The pedal set unplugged mid-drive: the wheel is lost, as with the throttle's or the brake's device
  const gone = reader.read([pad('G29', '', [0])], { wheel, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60);
  assert.ok(gone.wheelLost);
  assert.equal(gone.clutch, 0);
  assert.equal(DEFAULT_WHEEL_SETTINGS.clutch, null);
  assert.deepEqual(parsePlayerSettings({ wheel: { clutch: wheel.clutch } }).wheel.clutch, wheel.clutch, 'a saved clutch pedal');
  assert.equal(parsePlayerSettings({ wheel: { clutch: { padId: 'Pedals' } } }).wheel.clutch, null, 'a broken one is none');
});
check('GT classic: right stick drives, RT / LT shift, R3 does nothing', () => {
  const reader = new DeviceInputReader();
  const settings = {
    wheel: DEFAULT_WHEEL_SETTINGS,
    padButtons: PAD_LAYOUTS.gtClassic.buttons,
    padTuning: { pedalSources: STICK_SOURCES, stickPedalDeadzone: 0.1 },
  };
  const f1 = reader.read([pad('Xbox', 'standard', [0.2, 0, 0, -1], [7], { 7: 1 })], settings, 1 / 60);
  assert.equal(f1.source, 'controller');
  near(f1.throttle, 1);
  assert.equal(f1.brake, 0);
  assert.ok(f1.pressed.has('shiftUp'));
  const f2 = reader.read([pad('Xbox', 'standard', [0, 0, 0, 0.5], [6, 11], { 6: 0.7 })], settings, 1 / 60);
  assert.equal(f2.throttle, 0);
  near(f2.brake, 0.4 / 0.85);
  assert.ok(f2.pressed.has('shiftDown'));
  assert.deepEqual([...f2.pressed], ['shiftDown'], 'R3 is unbound');
  // A light touch on a shift trigger (a browser already calls it pressed) shifts nothing; half its travel does
  const r = new DeviceInputReader();
  const touch = (v: number, pressed: boolean) => r.read([pad('Xbox', 'standard', [0, 0, 0, 0], pressed ? [7] : [], { 7: v })], settings, 1 / 60);
  assert.equal(touch(0.2, true).pressed.size, 0, 'resting finger');
  assert.ok(touch(0.6, true).pressed.has('shiftUp'), 'well past the press point');
  touch(0, false);
  assert.ok(touch(0, true).pressed.has('shiftUp'), 'a digital trigger, pressed with no travel');
  // The same pad on trigger pedals and the default buttons: RT is the throttle and shifts nothing
  const f3 = new DeviceInputReader().read(
    [pad('Xbox', 'standard', [0, 0, 0, -1], [7], { 7: 1 })],
    { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: BUMPER_SHIFT_BUTTONS, padTuning: { pedalSources: DEFAULT_PAD_PEDAL_SOURCES, stickPedalDeadzone: 0.1 } },
    1 / 60,
  );
  near(f3.throttle, 1);
  assert.equal(f3.pressed.size, 0);
});
check('DualSense L2 / R2 shifts: down at 0.22, held to 0.12, one shift per pull', () => {
  assert.equal(PAD_TRIGGER_PRESS, 0.22);
  assert.equal(PAD_TRIGGER_RELEASE, 0.12);
  // The pure rule
  assert.equal(padTriggerDown({ pressed: true, value: 0.15 }, false), false, '0.15 is a resting finger');
  assert.equal(padTriggerDown({ pressed: true, value: 0.22 }, false), true, '0.22 presses');
  assert.equal(padTriggerDown({ pressed: true, value: 0.2199999 }, false), true, '8-bit rounding of 0.22 presses');
  assert.equal(padTriggerDown({ pressed: true, value: 0.18 }, true), true, '0.18 stays down once down');
  assert.equal(padTriggerDown({ pressed: true, value: 0.18 }, false), false, '0.18 does not press from up');
  assert.equal(padTriggerDown({ pressed: false, value: 0.12 }, true), false, 'at 0.12 it lets go');
  assert.equal(padTriggerDown({ pressed: true, value: 0 }, false), true, 'a digital trigger');
  assert.equal(padTriggerDown(undefined, true), false);
  // Through the reader, on a DualSense with the GT classic layout (R2 up, L2 down)
  const settings = {
    wheel: DEFAULT_WHEEL_SETTINGS,
    padButtons: PAD_LAYOUTS.gtClassic.buttons,
    padTuning: { pedalSources: STICK_SOURCES, stickPedalDeadzone: 0.1 },
  };
  const ds = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
  const r = new DeviceInputReader();
  const at = (r2: number, l2 = 0) =>
    r.read([pad(ds, 'standard', [0, 0, 0, 0], [...(r2 > 0 ? [7] : []), ...(l2 > 0 ? [6] : [])], { 7: r2, 6: l2 })], settings, 1 / 60);
  assert.equal(at(0.15).pressed.size, 0, 'no shift at 0.15');
  assert.ok(at(0.22).pressed.has('shiftUp'), 'R2 at 0.22 shifts up promptly');
  assert.equal(at(0.18).pressed.size, 0, 'held at 0.18: no second shift');
  assert.ok(at(0.18).held!.has('shiftUp'), 'held at 0.18 stays held');
  assert.equal(at(0.25).pressed.size, 0, 'back over 0.22 while held: still one shift');
  assert.equal(at(0.13).pressed.size, 0, 'just over the release point');
  assert.ok(!at(0.11).held!.has('shiftUp'), 'under 0.12 lets go');
  assert.ok(at(0.22).pressed.has('shiftUp'), 'released, so the next pull shifts again');
  at(0);
  // Each trigger keeps its own state: R2 held at 0.18 does not hold L2 down at 0.18
  assert.ok(at(0.3).pressed.has('shiftUp'));
  const both = at(0.18, 0.18);
  assert.ok(both.held!.has('shiftUp') && !both.held!.has('shiftDown'), 'L2 at 0.18 from up stays up');
  assert.ok(at(0.18, 0.22).pressed.has('shiftDown'), 'L2 at 0.22 shifts down');
});
check('uncalibrated non-standard device keeps the original raw path', () => {
  const reader = new DeviceInputReader();
  const f = reader.read([pad('Generic wheel', '', [0.3, 0], [], { 7: 0.5 })], { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60);
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
  const f = reader.read(pads, { wheel, padButtons: BUMPER_SHIFT_BUTTONS }, 1 / 60);
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
  const settings = { wheel, padButtons: BUMPER_SHIFT_BUTTONS };
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
    padButtons: BUMPER_SHIFT_BUTTONS,
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
check('#189: Thrustmaster TMX / T150 / T500RS are recognised by USB id (e.g. Windows "B67F") as belt wheels on the bridge', () => {
  for (const id of [
    'B67F (Vendor: 044f Product: b67f)',
    '044f-b67f-B67F',
    'Thrustmaster TMX Racing Wheel',
    'Thrustmaster T150 (Vendor: 044f Product: b677)',
    'Thrustmaster T500RS (Vendor: 044f Product: b65e)',
    'Thrustmaster FFB Wheel (Vendor: 044f Product: b65d)',
  ]) {
    const patch = autoConfigureWheel([pad(id, '', [0])], DEFAULT_WHEEL_SETTINGS);
    assert.ok(patch, id);
    assert.equal(patch.steer?.padId, id, id);
    assert.equal(patch.type, 'belt_gear', id);
    assert.equal(patch.rotationDeg, 900, id);
    assert.equal(patch.hidFfb, false, `${id} starts on the bridge`);
  }
  const t300 = autoConfigureWheel([pad('B66E (Vendor: 044f Product: b66e)', '', [0])], DEFAULT_WHEEL_SETTINGS);
  assert.equal(t300?.type, 'belt_gear');
  assert.equal(t300?.hidFfb, true, 'a WebHID-supported Thrustmaster base (T300RS) still starts on WebHID');
  assert.equal(autoConfigureWheel([pad('T-LCM Pedals (Vendor: 044f Product: b371)', '', [0])], DEFAULT_WHEEL_SETTINGS), null, 'pedals are not a wheel');
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
    assert.equal(defaultGraphicsSettings().autoQuality, true, 'automatic quality is on for touch screens');
    assert.equal(defaultGraphicsSettings().fpsCap, 0, 'the frame rate is the screen\'s on touch screens too');
    assert.equal(parsePlayerSettings({ graphics: { quality: 'high' } }).graphics.autoQuality, true, 'a save from before it takes the device default');
    assert.equal(parsePlayerSettings({ graphics: { autoQuality: false, fpsCap: 30 } }).graphics.autoQuality, false, 'a saved off is kept');
    assert.equal(parsePlayerSettings({ graphics: { fpsCap: 30 } }).graphics.fpsCap, 30, 'a saved 30 fps is kept');
    assert.equal(parsePlayerSettings({ graphics: { fpsCap: 45 } }).graphics.fpsCap, 0, 'an unknown cap is none');
  } finally {
    delete g.window;
    if (prevStorage === undefined) delete g.localStorage;
    else g.localStorage = prevStorage;
  }
  assert.equal(defaultGraphicsSettings().quality, 'high', 'no touch screen (or no window): High');
  assert.equal(defaultGraphicsSettings().autoQuality, false, 'no touch screen: automatic quality off');
});
check('automatic quality\'s Lowest resolution: 60% by default (the old floor), saved choices kept, odd values snapped', () => {
  const g = globalThis as unknown as { window?: unknown };
  g.window = { matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }) };
  try {
    assert.equal(defaultGraphicsSettings().autoQualityMinScale, RENDER_SCALE_FLOOR, 'touch screens: the old floor');
    assert.equal(parsePlayerSettings({ graphics: { quality: 'medium' } }).graphics.autoQualityMinScale, 0.6, 'a touch save from before it');
  } finally {
    delete g.window;
  }
  assert.equal(RENDER_SCALE_FLOOR, 0.6);
  assert.equal(DEFAULT_PLAYER_SETTINGS.graphics.autoQualityMinScale, 0.6, 'the prerendered default');
  assert.equal(defaultGraphicsSettings().autoQualityMinScale, 0.6, 'desktops: the old floor');
  assert.equal(parsePlayerSettings({}).graphics.autoQualityMinScale, 0.6, 'a save without graphics');
  assert.equal(parsePlayerSettings({ graphics: { quality: 'high', autoQuality: true } }).graphics.autoQualityMinScale, 0.6, 'a save from before it');
  for (const v of AUTO_QUALITY_MIN_SCALES) {
    const kept = parsePlayerSettings(JSON.parse(JSON.stringify({ graphics: { autoQualityMinScale: v } }))).graphics.autoQualityMinScale;
    assert.equal(kept, v, `a saved ${v * 100}% is kept`);
  }
  assert.equal(parsePlayerSettings({ graphics: { autoQualityMinScale: 0.72 } }).graphics.autoQualityMinScale, 0.7, '72% snaps to 70%');
  assert.equal(parsePlayerSettings({ graphics: { autoQualityMinScale: 0.3 } }).graphics.autoQualityMinScale, 0.6, 'under the range: 60%');
  assert.equal(parsePlayerSettings({ graphics: { autoQualityMinScale: 4 } }).graphics.autoQualityMinScale, 1, 'over the range: 100%');
  assert.equal(parsePlayerSettings({ graphics: { autoQualityMinScale: '0.8' } }).graphics.autoQualityMinScale, 0.6, 'not a number: the default');
  assert.equal(parsePlayerSettings({ graphics: { autoQualityMinScale: Number.NaN } }).graphics.autoQualityMinScale, 0.6, 'NaN: the default');
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
  const bound = { wheel: { ...DEFAULT_WHEEL_SETTINGS, steer }, padButtons: BUMPER_SHIFT_BUTTONS };
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
  const settings = { wheel: { ...DEFAULT_WHEEL_SETTINGS, steer: { padId: 'DD base', axis: 0, center: 0, invert: false } }, padButtons: BUMPER_SHIFT_BUTTONS };
  const xboxHeld = pad('Xbox', 'standard', [0, 0], [5]);
  assert.equal(reader.read([pad('DD base', '', [0]), xboxHeld], settings, 1 / 60).source, 'wheel');
  const switched = reader.read([xboxHeld], settings, 1 / 60);
  assert.equal(switched.source, 'controller');
  assert.ok(!switched.pressed.has('shiftUp'), 'held across the switch: no press');
  reader.read([pad('Xbox', 'standard', [0, 0])], settings, 1 / 60);
  assert.ok(reader.read([xboxHeld], settings, 1 / 60).pressed.has('shiftUp'), 'pressed again: a press');
  // A pad that only appears with a press (the browser hides it until then) still counts from no device at all
  const fresh = new DeviceInputReader();
  const pads = { wheel: DEFAULT_WHEEL_SETTINGS, padButtons: BUMPER_SHIFT_BUTTONS };
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

check('forces go to the bridge only while force feedback is on, and never while WebHID drives the wheel', () => {
  const sent: string[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {}
    send(m: string) {
      sent.push(m);
    }
    close() {
      this.readyState = 3;
    }
  }
  const g = globalThis as unknown as { WebSocket?: unknown };
  const prevWs = g.WebSocket;
  g.WebSocket = FakeSocket;
  try {
    const c = new WheelFfbClient();
    const forces = () => sent.filter((m) => JSON.parse(m).t === 'f').length;
    const t = { speedKmh: 0, ffbTorqueNorm: 0 } as never;
    const telemetry = { ...DEFAULT_WHEEL_SETTINGS, ffbEnabled: false, telemetryOut: true, hidFfb: false };
    c.update(t, telemetry, [], 1000, false);
    c.update(t, telemetry, [], 1016, false);
    assert.equal(forces(), 0, 'a bridge kept for telemetry is sent no force, so it never opens the wheel');
    c.update(t, { ...telemetry, ffbEnabled: true }, [], 1032, false);
    assert.equal(forces(), 1, 'force feedback on, through the bridge: it gets the force');
    c.hidSink = () => {};
    c.update(t, { ...telemetry, ffbEnabled: true, hidFfb: true }, [], 1048, false);
    assert.equal(forces(), 1, 'WebHID drives the wheel: nothing for the bridge');
  } finally {
    g.WebSocket = prevWs;
  }
});

console.log('Install app');
check('an install is the Home Screen app or an app display mode; fullscreen counts only without a fullscreen element', () => {
  const facts = (modes: string[], extra: { standalone?: boolean; elementFullscreen?: boolean } = {}) => ({
    standalone: extra.standalone,
    displayMode: (mode: string) => modes.includes(mode),
    elementFullscreen: extra.elementFullscreen ?? false,
  });
  assert.equal(installedFrom(facts(['browser'])), false, 'a tab');
  assert.equal(installedFrom(facts(['browser'], { standalone: true })), true, 'iOS Home Screen app');
  assert.equal(installedFrom(facts(['browser'], { standalone: false })), false, 'iOS Safari tab');
  assert.equal(installedFrom(facts(['standalone'])), true);
  assert.equal(installedFrom(facts(['minimal-ui'])), true);
  assert.equal(installedFrom(facts(['fullscreen'])), true, 'Android fullscreen app');
  // The loading screen's tap takes a tab full screen, and Chrome then reports display-mode fullscreen
  assert.equal(installedFrom(facts(['fullscreen'], { elementFullscreen: true })), false, 'a tab the Fullscreen API made full screen');
  assert.equal(installedFrom(facts(['standalone'], { elementFullscreen: true })), true, 'an installed app with a fullscreen element');
});
check('Apple touch devices: iPhone, iPad, iPod, and iPadOS with its Mac user agent; never a Mac or an Android', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
  const ipadOld = 'Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  assert.equal(isAppleTouchAgent(iphone, 5), true);
  assert.equal(isAppleTouchAgent(iphoneChrome, 5), true, 'Chrome on iOS installs through Share too');
  assert.equal(isAppleTouchAgent(ipadOld, 5), true);
  assert.equal(isAppleTouchAgent('Mozilla/5.0 (iPod touch; CPU iPhone OS 12_0 like Mac OS X)', 5), true);
  assert.equal(isAppleTouchAgent(mac, 5), true, 'iPadOS asks for the desktop site with a Mac user agent');
  assert.equal(isAppleTouchAgent(mac, 0), false, 'a Mac');
  assert.equal(isAppleTouchAgent(mac, 1), false, 'a Mac reporting one touch point');
  assert.equal(isAppleTouchAgent(android, 5), false);
});
check('without a window: not installed, not Apple, no prompt, and going full screen does nothing', () => {
  assert.equal(isInstalledApp(), false);
  assert.equal(isAppleTouch(), false);
  assert.deepEqual(installStore.getSnapshot(), { canPrompt: false, installed: false });
  assert.equal(installStore.getSnapshot(), installStore.getServerSnapshot(), 'one snapshot object until something changes');
  enterFullscreenOnTouch();
});
check('Settings > Touch: turning Tilt to steer on asks iOS for motion access in the same tap; turning it off does not', () => {
  const g = globalThis as unknown as { window?: unknown; DeviceOrientationEvent?: unknown };
  let asked = 0;
  g.window = {};
  g.DeviceOrientationEvent = { requestPermission: () => (asked++, Promise.resolve('granted')) };
  try {
    let settings = DEFAULT_PLAYER_SETTINGS;
    const env = { settings, update: (fn: (s: typeof settings) => typeof settings) => void (settings = fn(settings)) } as unknown as SettingsEnv;
    tiltSteer.write(env, true);
    assert.equal(asked, 1, 'asked before the tap handler returns (iOS prompts only inside the gesture)');
    assert.equal(settings.touch.tiltSteer, true);
    tiltSteer.write(env, false);
    assert.equal(asked, 1, 'turning tilt off asks nothing');
    assert.equal(settings.touch.tiltSteer, false);
  } finally {
    delete g.window;
    delete g.DeviceOrientationEvent;
  }
});
check('Settings > Touch: touch style toggles between sliders and buttons, persists, and falls back on bad saves', () => {
  let settings = DEFAULT_PLAYER_SETTINGS;
  assert.equal(settings.touch.layout, 'sliders', 'default layout is sliders');
  const env = {
    get settings() { return settings; },
    update: (fn: (s: typeof settings) => typeof settings) => void (settings = fn(settings)),
  } as unknown as SettingsEnv;
  touchLayout.write(env, 'buttons');
  assert.equal(settings.touch.layout, 'buttons');
  const roundTripped = parsePlayerSettings(JSON.parse(JSON.stringify(settings)));
  assert.equal(roundTripped.touch.layout, 'buttons');
  const bad = parsePlayerSettings({ touch: { mode: 'on', layout: 'joystick' } });
  assert.equal(bad.touch.layout, 'sliders', 'unknown touch layout falls back to sliders');
  const legacy = parsePlayerSettings({ touch: { mode: 'on', tiltSteer: false, tiltRangeDeg: 30 } });
  assert.equal(legacy.touch.layout, 'sliders', 'older save without layout keeps sliders');
  settings = { ...settings, touch: { ...settings.touch, mode: 'off' } };
  assert.ok(touchLayout.off?.(env), 'touch style is disabled when touch controls are off');
});
check('Touch buttons: digital flags and analogSteerActive reset cleanly and tag laps as touch input', () => {
  touchInput.active = true;
  touchInput.analogSteerActive = true;
  touchInput.steerLeft = true;
  touchInput.throttleBtn = true;
  assert.equal(
    drivingInputOf({
      touch: touchInput,
      source: null,
      mouseSteer: false,
      keys: false,
      pad: { throttle: 0, brake: 0, steer: 0 },
      setting: 'keyboard',
    }),
    'touch',
    'holding a digital touch button records touch input',
  );
  resetTouchInput();
  assert.equal(touchInput.active, false);
  assert.equal(touchInput.analogSteerActive, false);
  assert.equal(touchInput.steerLeft, false);
  assert.equal(touchInput.steerRight, false);
  assert.equal(touchInput.throttleBtn, false);
  assert.equal(touchInput.brakeBtn, false);
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

  // ScreenWakeLock: acquires while driving & visible, releases in menus/pause/hidden, re-acquires on visibility, and cancels in-flight on dispose
  {
    assert.equal(shouldHoldWakeLock({ driving: true, visible: true }), true);
    assert.equal(shouldHoldWakeLock({ driving: false, visible: true }), false);
    assert.equal(shouldHoldWakeLock({ driving: true, visible: false }), false);
    let requests = 0;
    let releases = 0;
    let visState = 'visible';
    const docState: { visCb: (() => void) | null } = { visCb: null };
    const makeSentinel = (): WakeLockSentinelLike => {
      let released = false;
      let onRel: (() => void) | null = null;
      return {
        get released() {
          return released;
        },
        async release() {
          if (!released) {
            released = true;
            releases++;
            onRel?.();
          }
        },
        addEventListener(_t, fn) {
          onRel = fn;
        },
        removeEventListener(_t, fn) {
          if (onRel === fn) onRel = null;
        },
      };
    };
    const api = {
      async request() {
        requests++;
        return makeSentinel();
      },
    };
    const doc = {
      get visibilityState() {
        return visState;
      },
      addEventListener(_t: 'visibilitychange', fn: () => void) {
        docState.visCb = fn;
      },
      removeEventListener(_t: 'visibilitychange', fn: () => void) {
        if (docState.visCb === fn) docState.visCb = null;
      },
    };
    const lock = new ScreenWakeLock(api, doc);
    lock.setDesired(true);
    await Promise.resolve();
    assert.equal(requests, 1);
    assert.equal(lock.active, true);
    // Tab hidden releases lock; returning visible re-acquires it
    visState = 'hidden';
    docState.visCb?.();
    assert.equal(releases, 1);
    assert.equal(lock.active, false);
    visState = 'visible';
    docState.visCb?.();
    await Promise.resolve();
    assert.equal(requests, 2);
    assert.equal(lock.active, true);
    // Pause / menu releases lock; dispose detaches visibility listener
    lock.setDesired(false);
    assert.equal(releases, 2);
    assert.equal(lock.active, false);
    lock.dispose();
    assert.equal(docState.visCb, null);

    // Transient rejection and OS-initiated revocation recover cleanly after retry cooldown, and dispose cancels in-flight request
    let tNow = 10_000;
    let attempt = 0;
    const flakyState: {
      inFlightResolve: ((s: WakeLockSentinelLike) => void) | null;
      lastRevoke: (() => void) | null;
    } = { inFlightResolve: null, lastRevoke: null };
    let inFlightReleased = 0;
    const flakyApi = {
      request() {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error('NotAllowedError'));
        if (attempt === 3) {
          return new Promise<WakeLockSentinelLike>((res) => {
            flakyState.inFlightResolve = res;
          });
        }
        let rel = false;
        let onRel: (() => void) | null = null;
        flakyState.lastRevoke = () => {
          rel = true;
          onRel?.();
        };
        return Promise.resolve({
          get released() {
            return rel;
          },
          async release() {
            rel = true;
            onRel?.();
          },
          addEventListener(_t: 'release', fn: () => void) {
            onRel = fn;
          },
        });
      },
    };
    const lock2 = new ScreenWakeLock(flakyApi, doc, () => tNow);
    lock2.setDesired(true); // attempt 1 rejects
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lock2.active, false);
    lock2.setDesired(true); // inside 2 s cooldown -> throttled
    assert.equal(attempt, 1);
    tNow += 2500;
    lock2.setDesired(true); // attempt 2 succeeds
    await Promise.resolve();
    assert.equal(attempt, 2);
    assert.equal(lock2.active, true);
    // OS revokes sentinel while visible & driving; cooldown expires and setDesired(true) starts attempt 3 (in-flight)
    flakyState.lastRevoke?.();
    assert.equal(lock2.active, false);
    tNow += 2500;
    lock2.setDesired(true);
    assert.equal(attempt, 3);
    // Dispose while attempt 3 is still in-flight -> late sentinel is immediately released
    lock2.dispose();
    flakyState.inFlightResolve?.({
      async release() {
        inFlightReleased++;
      },
      addEventListener() {},
    });
    await Promise.resolve();
    assert.equal(inFlightReleased, 1);

    passed++;
    console.log('  ok  ScreenWakeLock: holds screen awake while driving, recovers after rejection/revocation and cancels in-flight on dispose');
  }
  console.log(`\n${passed} checks passed`);
}
asyncChecks().catch((e) => {
  console.error(e);
  process.exit(1);
});
