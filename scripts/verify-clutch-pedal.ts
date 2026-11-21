/**
 * The driver's clutch pedal through the car adapter, on flat ground:
 *   npx tsx scripts/verify-clutch-pedal.ts
 *
 * Held, the clutch is open: the engine revs on the spot and the car stays put. Let out, the car drives off. Never
 * pressed (absent or 0), the car drives exactly as it did before the pedal existed. The autopilot drives on the car's
 * own clutch whatever the pedal says.
 */
import { createFlatTestTrack } from './lib/flat-track';
import { createBmwM1ProcarSim } from '../src/lib/sim/classic/BmwM1ProcarSim';
import { createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { CLUTCH_BITE_LOCK, CLUTCH_BITE_START, clutchPedalEngagement } from '../src/lib/sim/f12026-car/VehiclePhysics';
import {
  ENGINE_RESTART_CRANK_S,
  ENGINE_STALL_DELAY_S,
  StallController,
  stallSpeedRadS,
} from '../src/lib/sim/stall-controller';
import { DEFAULT_PLAYER_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';
import { resolveActiveClutchBinding } from '../src/lib/input/bindings';
import { autoClutch } from '../src/components/settings/defs';
import type { SettingsEnv } from '../src/components/settings/env';
import type { ControlInputs } from '../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 120;
const track = createFlatTestTrack(30_000, 3000);

const CARS: { name: string; make: () => F12026CarSim }[] = [
  { name: 'BMW M1 Procar', make: () => createBmwM1ProcarSim(track) },
  { name: 'Suzuki Liana', make: () => createSuzukiLianaSim(track) },
  { name: 'Mercedes-AMG GT3', make: () => createAmgGt3Sim(track, null) },
];

/** A car at rest on the flat, on the player's settings with no aids */
function standing(make: () => F12026CarSim): F12026CarSim {
  const sim = make();
  sim.assistPreset = 'pro';
  sim.teleportToDistance(1000, 0);
  return sim;
}

const drive = (sim: F12026CarSim, seconds: number, inputs: Partial<ControlInputs>) => {
  for (let t = 0; t < seconds; t += DT) sim.step(DT, { ...inputs });
};

for (const car of CARS) {
  console.log(`\n== ${car.name}`);

  // Clutch held with half throttle: the engine revs free of the wheels and the car stays where it is
  const held = standing(car.make);
  drive(held, 0.5, { throttle: 0.5, clutch: 1 });
  drive(held, 2, { throttle: 0.5, clutch: 1 });
  const heldKmh = held.telemetry.speedKmh;
  const heldRpm = held.telemetry.rpm;
  check('clutch held: the car stays put', heldKmh < 1, `${heldKmh.toFixed(2)} km/h`);
  check('clutch held: the engine revs on the spot', heldRpm > 2500, `${Math.round(heldRpm)} rpm, engagement ${held.telemetry.clutch.toFixed(2)}`);

  // Let out over half a second, the throttle held: it drives off
  for (let t = 0; t < 0.5; t += DT) held.step(DT, { throttle: 0.5, clutch: 1 - t / 0.5 });
  drive(held, 2, { throttle: 0.5 });
  check('clutch let out: the car drives off', held.telemetry.speedKmh > 15, `${held.telemetry.speedKmh.toFixed(1)} km/h`);

  // Never pressed: absent and 0 give the very same car, step for step
  const absent = standing(car.make);
  const zero = standing(car.make);
  let same = true;
  for (let t = 0; t < 6 && same; t += DT) {
    absent.step(DT, { throttle: 1 });
    zero.step(DT, { throttle: 1, clutch: 0 });
    same = absent.telemetry.speedKmh === zero.telemetry.speedKmh && absent.telemetry.rpm === zero.telemetry.rpm;
  }
  check('clutch at 0: the same car as without a pedal', same, `${absent.telemetry.speedKmh.toFixed(3)} / ${zero.telemetry.speedKmh.toFixed(3)} km/h`);

  // The autopilot drives on the car's own clutch, whatever the pedal says
  const auto = standing(car.make);
  auto.aiAutopilot = true;
  drive(auto, 4, { throttle: 0, clutch: 1 });
  check('autopilot: the pedal is not its clutch', auto.telemetry.speedKmh > 10, `${auto.telemetry.speedKmh.toFixed(1)} km/h`);

  // Default autoClutch keeps the engine running at standstill and under braking in gear
  const noStall = standing(car.make);
  noStall.autoGearbox = false;
  noStall.autoClutch = true;
  drive(noStall, 1.5, { throttle: 0, brake: 1, clutch: 0 });
  check('auto-clutch on: braking at rest in gear does not stall', noStall.telemetry.engineStalled === false && noStall.telemetry.rpm > 400, `${noStall.telemetry.rpm} rpm`);
}

console.log('\n== Full manual clutch: bite point, slip, stalling and restart');
check('default settings enable auto-clutch and semi-pro assists', DEFAULT_PLAYER_SETTINGS.autoClutch === true && DEFAULT_PLAYER_SETTINGS.assistPreset === 'semi_pro', `autoClutch=${DEFAULT_PLAYER_SETTINGS.autoClutch}, preset=${DEFAULT_PLAYER_SETTINGS.assistPreset}`);
check('autoClutch persists through settings save/load', parsePlayerSettings({ autoClutch: false }).autoClutch === false && parsePlayerSettings({}).autoClutch === true, '');
check(
  'bite point curve: open at floor, progressive in bite zone, locked near top',
  clutchPedalEngagement(1) === 0 &&
    clutchPedalEngagement(CLUTCH_BITE_START) === 0 &&
    clutchPedalEngagement(0.65) > 0 &&
    clutchPedalEngagement(0.65) < 0.5 &&
    clutchPedalEngagement(0.4) > clutchPedalEngagement(0.65) &&
    clutchPedalEngagement(CLUTCH_BITE_LOCK) === 1 &&
    clutchPedalEngagement(0) === 1,
  `p=0.65 -> ${clutchPedalEngagement(0.65).toFixed(2)}, p=0.40 -> ${clutchPedalEngagement(0.4).toFixed(2)}`,
);

// Suzuki Liana (manual road car): dump clutch -> stall, restart via clutch, smooth bite-point launch
const liana = standing(() => createSuzukiLianaSim(track));
liana.autoGearbox = false;
liana.autoClutch = false;
// Hold brake and dump clutch in 1st with no throttle -> stalls
drive(liana, 1.0, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: dumping clutch at standstill stalls the engine', liana.telemetry.engineStalled === true && liana.telemetry.rpm < 200, `stalled=${liana.telemetry.engineStalled}, ${liana.telemetry.rpm} rpm`);

// Hold clutch in to crank and restart
drive(liana, 0.8, { throttle: 0, brake: 1, clutch: 1 });
check('manual clutch: holding clutch restarts a stalled engine', liana.telemetry.engineStalled === false && liana.telemetry.rpm >= 600, `stalled=${liana.telemetry.engineStalled}, ${liana.telemetry.rpm} rpm`);

// Smooth bite-point launch: bring revs up slightly, slip clutch through bite zone, then release -> drives off cleanly
drive(liana, 0.25, { throttle: 0.45, brake: 0, clutch: 1 });
let peakSlip = 0;
for (let t = 0; t < 0.9; t += DT) {
  const pedal = Math.max(0, 0.78 - (t / 0.9) * 0.78);
  liana.step(DT, { throttle: 0.45, brake: 0, clutch: pedal });
  peakSlip = Math.max(peakSlip, liana.telemetry.clutchSlip ?? 0);
}
drive(liana, 2.0, { throttle: 0.5, brake: 0, clutch: 0 });
check(
  'manual clutch: bite-point slip launch accelerates without stalling',
  liana.telemetry.engineStalled === false && peakSlip > 0.05 && liana.telemetry.speedKmh > 15,
  `stalled=${liana.telemetry.engineStalled}, peakSlip=${peakSlip.toFixed(2)}, ${liana.telemetry.speedKmh.toFixed(1)} km/h`,
);

// Braking to a complete stop in gear without pressing clutch stalls
drive(liana, 2.5, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: braking to a stop in gear without clutching stalls', liana.telemetry.engineStalled === true, `stalled=${liana.telemetry.engineStalled}, ${liana.telemetry.rpm} rpm`);

// Shifting to Neutral restarts
liana.step(DT, { throttle: 0, brake: 1, neutral: true, clutch: 0 });
drive(liana, 0.8, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: shifting to neutral restarts a stalled engine', liana.telemetry.engineStalled === false && liana.telemetry.gear === 0 && liana.telemetry.rpm >= 600, `gear=${liana.telemetry.gear}, ${liana.telemetry.rpm} rpm`);

// Re-enabling autoClutch immediately recovers a stalled car
liana.step(DT, { shiftUp: true, clutch: 1 });
drive(liana, 1.0, { throttle: 0, brake: 1, clutch: 0 });
const stalledAgain = liana.telemetry.engineStalled === true;
liana.autoClutch = true;
drive(liana, 0.1, { throttle: 0, brake: 1, clutch: 0 });
check('manual clutch: turning auto-clutch back on recovers stall', stalledAgain && liana.telemetry.engineStalled === false && liana.telemetry.rpm >= 600, `${liana.telemetry.rpm} rpm`);

// Auto-clutch keeps linear (1 - clutch) curve for manual starts; progressive bite-point curve applies only to manualClutch
const autoLinear = standing(() => createSuzukiLianaSim(track));
autoLinear.autoGearbox = false;
autoLinear.autoClutch = true;
drive(autoLinear, 0.3, { throttle: 0.9, clutch: 1 });
autoLinear.step(DT, { throttle: 0.9, clutch: 0.5 });
const autoEngAtHalf = autoLinear.telemetry.clutch;
const manualCurve = standing(() => createSuzukiLianaSim(track));
manualCurve.autoGearbox = false;
manualCurve.autoClutch = false;
drive(manualCurve, 0.3, { throttle: 0.9, clutch: 1 });
manualCurve.step(DT, { throttle: 0.9, clutch: 0.5 });
const manualEngAtHalf = manualCurve.telemetry.clutch;
check(
  'auto-clutch keeps linear 1-clutch curve (0.50) while manual uses bite curve (~0.24)',
  Math.abs(autoEngAtHalf - 0.5) < 0.02 && Math.abs(manualEngAtHalf - clutchPedalEngagement(0.5)) < 0.02 && autoEngAtHalf > manualEngAtHalf + 0.2,
  `auto=${autoEngAtHalf.toFixed(2)}, manual=${manualEngAtHalf.toFixed(2)}`,
);

// No clutch bound (`clutchBound: false`): autoClutch=false must fall back to auto-clutch and never soft-lock heavy/GT3 cars
const gt3Unbound = standing(() => createAmgGt3Sim(track, null));
gt3Unbound.autoGearbox = false;
gt3Unbound.autoClutch = false;
drive(gt3Unbound, 1.0, { throttle: 0, brake: 1, clutchBound: false });
const gt3NoStall = gt3Unbound.telemetry.engineStalled === false && gt3Unbound.telemetry.rpm > 400;
drive(gt3Unbound, 2.0, { throttle: 1, brake: 0, clutchBound: false });
check(
  'no clutch bound (GT3): autoClutch off falls back to auto-clutch without stalling',
  gt3NoStall && gt3Unbound.telemetry.engineStalled === false && gt3Unbound.telemetry.speedKmh > 40,
  `stalled=${gt3Unbound.telemetry.engineStalled}, ${gt3Unbound.telemetry.speedKmh.toFixed(1)} km/h`,
);

// Legacy LC26 engine (`F1Physics2026`): stall, reset/teleport clears stall, clutch-hold restart and slip launch
const legacy = new F1Physics2026(track);
legacy.assistPreset = 'pro';
legacy.teleportToDistance(1000, 0);
legacy.autoGearbox = false;
legacy.autoClutch = false;
const driveLegacy = (seconds: number, inputs: Partial<ControlInputs>) => {
  for (let t = 0; t < seconds; t += 1 / 60) legacy.step(1 / 60, { ...inputs });
};
driveLegacy(1.0, { throttle: 0, brake: 1, clutchBound: false });
const legacyUnboundNoStall = legacy.telemetry.engineStalled === false && legacy.telemetry.rpm >= 3500;
driveLegacy(2.0, { throttle: 1, brake: 0, clutchBound: false });
check(
  'no clutch bound (legacy LC26): autoClutch off falls back to auto-clutch without stalling',
  legacyUnboundNoStall && legacy.telemetry.engineStalled === false && legacy.telemetry.speedKmh > 40,
  `stalled=${legacy.telemetry.engineStalled}, ${legacy.telemetry.speedKmh.toFixed(1)} km/h`,
);
legacy.teleportToDistance(1000, 0);
driveLegacy(1.0, { throttle: 0, brake: 1, clutch: 0 });
check('legacy LC26 manual clutch: dumping clutch stalls the engine', legacy.telemetry.engineStalled === true && legacy.telemetry.rpm < 200, `stalled=${legacy.telemetry.engineStalled}, ${Math.round(legacy.telemetry.rpm)} rpm`);
legacy.teleportToDistance(1000, 0);
check('legacy LC26 manual clutch: reset/teleport clears stalled state', legacy.telemetry.engineStalled === false && legacy.telemetry.rpm >= 3500, `stalled=${legacy.telemetry.engineStalled}, ${Math.round(legacy.telemetry.rpm)} rpm`);
driveLegacy(1.0, { throttle: 0, brake: 1, clutch: 0 });
driveLegacy(0.8, { throttle: 0, brake: 1, clutch: 1 });
check('legacy LC26 manual clutch: holding clutch restarts stalled engine', legacy.telemetry.engineStalled === false && legacy.telemetry.rpm >= 3500, `stalled=${legacy.telemetry.engineStalled}, ${Math.round(legacy.telemetry.rpm)} rpm`);
driveLegacy(0.35, { throttle: 0.75, brake: 0, clutch: 1 });
let legacySlip = 0;
for (let t = 0; t < 0.8; t += 1 / 60) {
  const pedal = Math.max(0, 0.78 - (t / 0.8) * 0.78);
  legacy.step(1 / 60, { throttle: 0.75, brake: 0, clutch: pedal });
  legacySlip = Math.max(legacySlip, legacy.telemetry.clutchSlip ?? 0);
}
driveLegacy(1.0, { throttle: 0.9, brake: 0, clutch: 0 });
legacy.step(1 / 60, { throttle: 0.9, brake: 0, clutch: 0, shiftUp: true });
driveLegacy(1.0, { throttle: 0.95, brake: 0, clutch: 0 });
legacy.step(1 / 60, { throttle: 0.95, brake: 0, clutch: 0, shiftUp: true });
driveLegacy(1.0, { throttle: 0.95, brake: 0, clutch: 0 });
check(
  'legacy LC26 manual clutch: bite-point launch locks clutch & deploys ERS',
  legacy.telemetry.engineStalled === false &&
    legacySlip > 0.05 &&
    legacy.telemetry.speedKmh > 120 &&
    legacy.telemetry.clutch === 1 &&
    legacy.telemetry.mgukPowerKw > 10,
  `slip=${legacySlip.toFixed(2)}, ${legacy.telemetry.speedKmh.toFixed(1)} km/h, clutch=${legacy.telemetry.clutch}, mguk=${legacy.telemetry.mgukPowerKw.toFixed(0)} kW`,
);

// Device-scoped clutch binding resolution & Settings > Driving > Auto clutch `off()` guard
const kbBound = resolveActiveClutchBinding({
  deviceSource: null,
  touchActive: false,
  keyClutchCodes: ['KeyC'],
  padClutchSource: null,
  wheelClutchBound: false,
});
const padUnboundWithKbKey = resolveActiveClutchBinding({
  deviceSource: 'controller',
  touchActive: false,
  keyClutchCodes: ['KeyC'],
  padClutchSource: null,
  wheelClutchBound: false,
});
const wheelUnboundWithKbKey = resolveActiveClutchBinding({
  deviceSource: 'wheel',
  touchActive: false,
  keyClutchCodes: ['KeyC'],
  padClutchSource: null,
  wheelClutchBound: false,
});
const touchWithKbKey = resolveActiveClutchBinding({
  deviceSource: null,
  touchActive: true,
  keyClutchCodes: ['KeyC'],
  padClutchSource: null,
  wheelClutchBound: false,
});
const padBoundBtn = resolveActiveClutchBinding({
  deviceSource: 'controller',
  touchActive: false,
  keyClutchCodes: [],
  padClutchSource: { kind: 'button', button: 4 },
  wheelClutchBound: false,
});
check(
  'clutch binding is scoped strictly to the active input device',
  kbBound.bound &&
    kbBound.control !== undefined &&
    'key' in kbBound.control &&
    !padUnboundWithKbKey.bound &&
    padUnboundWithKbKey.control === undefined &&
    !wheelUnboundWithKbKey.bound &&
    wheelUnboundWithKbKey.control === undefined &&
    !touchWithKbKey.bound &&
    touchWithKbKey.control === undefined &&
    padBoundBtn.bound &&
    padBoundBtn.control !== undefined &&
    'pad' in padBoundBtn.control &&
    padBoundBtn.control.pad === 4,
  `kb=${kbBound.bound}, padUnbound=${padUnboundWithKbKey.bound}, wheelUnbound=${wheelUnboundWithKbKey.bound}, touch=${touchWithKbKey.bound}`,
);

const envFor = (settings: typeof DEFAULT_PLAYER_SETTINGS): SettingsEnv =>
  ({ settings, update: () => {}, ffb: null, liveTuner: null, reset: () => {} }) as unknown as SettingsEnv;
const offReason = (patch: Partial<typeof DEFAULT_PLAYER_SETTINGS>) =>
  autoClutch.off?.(envFor({ ...DEFAULT_PLAYER_SETTINGS, autoGearbox: false, ...patch })) ?? null;
const touchOffEvenWithKey = offReason({
  device: 'keyboard',
  touch: { ...DEFAULT_PLAYER_SETTINGS.touch, mode: 'on' },
  keys: { ...DEFAULT_PLAYER_SETTINGS.keys, clutch: ['KeyC'] },
});
const kbOffNoKey = offReason({ device: 'keyboard', touch: { ...DEFAULT_PLAYER_SETTINGS.touch, mode: 'off' } });
const kbOnWithKey = offReason({
  device: 'keyboard',
  touch: { ...DEFAULT_PLAYER_SETTINGS.touch, mode: 'off' },
  keys: { ...DEFAULT_PLAYER_SETTINGS.keys, clutch: ['KeyC'] },
});
const padOffUnbound = offReason({ device: 'controller' });
const wheelOffUnbound = offReason({ device: 'wheel' });
check(
  'autoClutch.off blocks unbound keyboard/controller/wheel and touch (even if a key is bound)',
  Boolean(touchOffEvenWithKey?.toLowerCase().includes('touch')) &&
    Boolean(kbOffNoKey?.toLowerCase().includes('keyboard')) &&
    kbOnWithKey === null &&
    Boolean(padOffUnbound?.toLowerCase().includes('controller')) &&
    Boolean(wheelOffUnbound?.toLowerCase().includes('wheel')),
  `touch="${touchOffEvenWithKey}", kb="${kbOffNoKey}", pad="${padOffUnbound}", wheel="${wheelOffUnbound}"`,
);

// Direct unit tests for shared StallController state machine
{
  const idleRpm = 1000;
  const idleOmega = (idleRpm * Math.PI) / 30;
  const stallOmega = stallSpeedRadS(idleRpm);
  const ctrl = new StallController();
  // Stalls after ENGINE_STALL_DELAY_S below stallOmega with clutch engaged in gear
  let omega = stallOmega * 0.5;
  for (let t = 0; t < ENGINE_STALL_DELAY_S * 0.5; t += 0.01) {
    omega = ctrl.step(0.01, true, 1, 0, 0, omega, 0, idleOmega, stallOmega);
  }
  const notYetStalled = !ctrl.stalled;
  for (let t = 0; t < ENGINE_STALL_DELAY_S; t += 0.01) {
    omega = ctrl.step(0.01, true, 1, 0, 0, omega, 0, idleOmega, stallOmega);
  }
  const stalledAfterDelay = ctrl.stalled;
  // Starter crank with clutch in + throttle restarts in ~half ENGINE_RESTART_CRANK_S
  omega = 0;
  let crankTime = 0;
  while (ctrl.stalled && crankTime < 1.0) {
    omega = ctrl.step(0.01, true, 0, 1, 0.3, omega, 0, idleOmega, stallOmega);
    crankTime += 0.01;
  }
  const crankRestartOk = !ctrl.stalled && omega >= idleOmega && crankTime < ENGINE_RESTART_CRANK_S * 0.7;
  // Re-stall, then bump-start recovery while rolling in gear with clutch engaged
  for (let t = 0; t < ENGINE_STALL_DELAY_S + 0.02; t += 0.01) {
    ctrl.step(0.01, true, 1, 0, 0, 0, 0, idleOmega, stallOmega);
  }
  const stalledForBump = ctrl.stalled;
  ctrl.step(0.01, true, 0.8, 0, 0, stallOmega * 1.2, idleOmega * 0.8, idleOmega, stallOmega);
  const bumpStartOk = stalledForBump && !ctrl.stalled;
  // Re-stall, then recoverIfAuto immediately recovers to idleOmega
  for (let t = 0; t < ENGINE_STALL_DELAY_S + 0.02; t += 0.01) {
    ctrl.step(0.01, true, 1, 0, 0, 0, 0, idleOmega, stallOmega);
  }
  const autoRecoveredOmega = ctrl.recoverIfAuto(0, idleOmega);
  const autoRecoverOk = !ctrl.stalled && autoRecoveredOmega >= idleOmega;
  check(
    'shared StallController handles stall delay, throttled crank, bump-start and auto recovery',
    notYetStalled && stalledAfterDelay && crankRestartOk && bumpStartOk && autoRecoverOk,
    `crank=${crankTime.toFixed(2)}s, bump=${bumpStartOk}, auto=${autoRecoverOk}`,
  );
}

// Regression (#15): keyboard player with idle controller/legacy HID plugged in keeps manual clutch; legacy wheel with
// connected clutch pedal resolves bound; controller setting before pad wakes stays unbound
{
  const kbWithIdlePad = resolveActiveClutchBinding({
    deviceSource: 'controller',
    touchActive: false,
    keyClutchCodes: ['KeyC'],
    padClutchSource: null,
    wheelClutchBound: false,
    settingsDevice: 'keyboard',
    lastDrivingInput: null,
  });
  const kbWithActivePad = resolveActiveClutchBinding({
    deviceSource: 'controller',
    touchActive: false,
    keyClutchCodes: ['KeyC'],
    padClutchSource: null,
    wheelClutchBound: false,
    settingsDevice: 'keyboard',
    lastDrivingInput: 'controller',
  });
  const legacyWithClutch = resolveActiveClutchBinding({
    deviceSource: 'legacy',
    touchActive: false,
    keyClutchCodes: [],
    padClutchSource: null,
    wheelClutchBound: true,
    settingsDevice: 'keyboard',
    lastDrivingInput: null,
  });
  const padSettingBeforeWake = resolveActiveClutchBinding({
    deviceSource: null,
    touchActive: false,
    keyClutchCodes: ['KeyC'],
    padClutchSource: null,
    wheelClutchBound: false,
    settingsDevice: 'controller',
    lastDrivingInput: null,
  });
  const disconnectedPadStaleInput = resolveActiveClutchBinding({
    deviceSource: null,
    touchActive: false,
    keyClutchCodes: ['KeyC'],
    padClutchSource: null,
    wheelClutchBound: false,
    settingsDevice: 'keyboard',
    lastDrivingInput: 'controller',
  });
  const disabledTouchStaleInput = resolveActiveClutchBinding({
    deviceSource: null,
    touchActive: false,
    keyClutchCodes: ['KeyC'],
    padClutchSource: null,
    wheelClutchBound: false,
    settingsDevice: 'keyboard',
    lastDrivingInput: 'touch',
  });
  check(
    'idle pad does not disable keyboard clutch; active pad, legacy wheel clutch & unplug recovery resolve accurately',
    kbWithIdlePad.bound &&
      kbWithIdlePad.activeDevice === 'keyboard' &&
      !kbWithActivePad.bound &&
      kbWithActivePad.activeDevice === 'controller' &&
      legacyWithClutch.bound &&
      legacyWithClutch.activeDevice === 'wheel' &&
      !padSettingBeforeWake.bound &&
      padSettingBeforeWake.activeDevice === 'controller' &&
      disconnectedPadStaleInput.bound &&
      disconnectedPadStaleInput.activeDevice === 'keyboard' &&
      disabledTouchStaleInput.bound &&
      disabledTouchStaleInput.activeDevice === 'keyboard',
    `idlePad=${kbWithIdlePad.bound}/${kbWithIdlePad.activeDevice}, activePad=${kbWithActivePad.bound}, legacy=${legacyWithClutch.bound}, padWake=${padSettingBeforeWake.bound}, unplugged=${disconnectedPadStaleInput.bound}, touchOff=${disabledTouchStaleInput.bound}`,
  );
}

// Regression (#16): stalled engine must NOT get an instant ECU rev-match when shifting out of neutral while rolling
{
  const s = standing(() => createSuzukiLianaSim(track));
  s.aiAutopilot = false;
  s.autoGearbox = false;
  s.autoClutch = false;
  // Start rolling at ~20 km/h, shift up to 5th so engine RPM drops below stall threshold while still rolling (> 10 km/h)
  s.teleportToDistance(1000, 5.5);
  for (let g = 0; g < 4; g++) {
    s.step(DT, { clutch: 0, clutchBound: true, shiftUp: true });
    drive(s, 0.12, { clutch: 0, clutchBound: true });
  }
  for (let i = 0; i < 400 && !s.telemetry.engineStalled; i++) {
    s.step(DT, { clutch: 0, clutchBound: true, brake: 0.15 });
  }
  const rollingStalled = Boolean(s.telemetry.engineStalled) && s.telemetry.speedKmh > 7.5;
  // Shift to neutral with clutch on the floor, then immediately into 1st with clutch still on the floor
  s.step(DT, { clutch: 1, clutchBound: true, neutral: true });
  const rpmBeforeShift = s.telemetry.rpm;
  const speedBeforeShift = s.telemetry.speedKmh;
  s.step(DT, { clutch: 1, clutchBound: true, shiftUp: true });
  const rpmAfterShift = s.telemetry.rpm;
  const stillStalledOpenClutch = Boolean(s.telemetry.engineStalled);
  // Release clutch while rolling: physical bump-start cranks engine via wheels and costs real momentum
  drive(s, 0.6, { clutch: 0, clutchBound: true });
  const bumpStarted = !s.telemetry.engineStalled;
  const speedLossKmh = speedBeforeShift - s.telemetry.speedKmh;
  check(
    'stalled engine does not ECU rev-match out of neutral; physical bump-start still works',
    rollingStalled &&
      stillStalledOpenClutch &&
      rpmAfterShift < rpmBeforeShift + 200 &&
      bumpStarted &&
      speedLossKmh > 0.3,
    `rollingStalled=${rollingStalled} (${speedBeforeShift.toFixed(1)} km/h), rpm ${rpmBeforeShift.toFixed(0)}->${rpmAfterShift.toFixed(0)}, speedLoss=${speedLossKmh.toFixed(2)} km/h, bump=${bumpStarted}`,
  );
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll clutch pedal checks passed.');
process.exit(failures.length ? 1 : 0);
