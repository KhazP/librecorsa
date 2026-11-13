/**
 * Keyboard steering (#64) and the keyboard / controller steering assist, as the game runs them: the assist settings
 * are built from the player's settings by `steeringAssistSettings`, as LibreCorsaSimulator builds them, and the keys
 * reach the cars the way the game sends them (`kbSteer`, with `padSteer` only when a controller is connected).
 *
 * On every vehicle model (AMG GT3, F1 2026 Rigid-Body, F1 2026 Prototype), on a flat pad:
 *
 * 1. D held for 3 s at a steady speed: the fronts stay near their peak slip on turn-in (first second) and when settled
 *    (last second), the car does not spin, and it corners at least as hard as the old open-loop keyboard steering did
 *    (d13b06a; the GT3 to within 1 %, the F1 cars, whose old steering scrubbed their fronts at 1.3–2.3× their peak, to
 *    within 7 %).
 * 2. Trail-braked turn-in: D and the brake held together: the fronts stay near their peak.
 * 3. A 90 ms tap on D at 200 km/h: a gentle nudge, and the car runs straight.
 * 4. D held, then let go: the car straightens itself (yaw rate and body slip back near zero).
 * 5. A D → A flick at 180 km/h: no spin.
 * 6. The tuning of the device that steers: a keyboard-only player is steered by the keyboard tuning with the keys
 *    released as much as held (whatever the controller's), a pad player by the controller's (whatever the keyboard's),
 *    and a keyboard player with a pad plugged in keeps the keyboard's until the stick moves.
 * 7. The self-steer the assist applies is the curve the setup screens draw (`selfSteerDeg`), capped at the car's lock.
 * 8. The keyboard pedal help (ABS / traction control off) follows the tyres only while its key is held; the controller's
 *    brake trigger cue backs off at the same slip margin.
 *
 * Usage: npx tsx scripts/verify-keyboard-steer.ts
 */
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { KeyboardPedalAssist } from '../src/lib/input/keyboard-pedals';
import { DEFAULT_PLAYER_SETTINGS, type KeyboardTuning, type PadTuning } from '../src/lib/settings/player-settings';
import { compoundData, F12026_CAR_CONFIG, type CarPhysicsConfig } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import {
  deviceAssistTuning,
  SteeringAssist,
  type SteeringAssistCarState,
  steeringAssistSettings,
  type SteeringAssistSettings,
  selfSteerDeg,
} from '../src/lib/sim/steering-assist';
import { LC26_TYRES } from '../src/lib/sim/lc26-data';
import type { ControlInputs } from '../src/types/f1';
import { createFlatTestTrack } from './lib/flat-track';

const DT = 1 / 120;
const G = 9.81;
const RAD2DEG = 180 / Math.PI;
const pad = createFlatTestTrack(30_000, 3000);

/**
 * Throttle that holds a speed, P + I as `lib/handling-tests.ts` holds it. Integral alone (as it was) wound the pedal
 * up while the car slowed through the turn-in and was still near 0.9 when the speed came back: on the merged tyre and
 * drivetrain model that is a power slide in the F1 at 70 km/h, and the assist then steered the fronts off their peak
 */
function speedHold(vT: number) {
  let integ = 0.3;
  return (vx: number) => {
    const e = vT - vx;
    integ = Math.max(0, Math.min(1, integ + 0.4 * e * DT));
    return Math.max(0, Math.min(1, integ + 0.6 * e));
  };
}

/** The assist as the game sets it up for the player's settings */
const gameAssist = (padTuning: PadTuning = DEFAULT_PLAYER_SETTINGS.padTuning, keyboardTuning: KeyboardTuning = DEFAULT_PLAYER_SETTINGS.keyboardTuning) =>
  steeringAssistSettings(padTuning, keyboardTuning);

interface CarCase {
  name: string;
  make: () => SimulatorCar;
  /** Front peak slip angle from the tyre data (deg) */
  peakDeg: (c: SimulatorCar) => number;
  /** Least the fronts' settled slip may be, as a share of their peak, with a key held */
  minSettledSlip: number;
}

const rigidBodyPeak = (config: CarPhysicsConfig) => (c: SimulatorCar) =>
  compoundData(config, config.compoundSlots[c.tireCompound]).modelData.friction_limit_angle || 7;

const CARS: CarCase[] = [
  {
    name: 'AMG GT3',
    make: () => createAmgGt3Sim(pad),
    peakDeg: rigidBodyPeak(AMG_GT3_CONFIG),
    minSettledSlip: 0.9,
  },
  {
    name: 'F1 2026 Rigid-Body',
    make: () => new F12026CarSim(pad),
    peakDeg: rigidBodyPeak(F12026_CAR_CONFIG),
    minSettledSlip: 0.84,
  },
  {
    name: 'F1 2026 Prototype',
    make: () => new F1Physics2026(pad),
    peakDeg: (c) => LC26_TYRES[c.tireCompound].front.frictionLimitAngleDeg,
    minSettledSlip: 0.84,
  },
];

/** The keys as a driver presses them: −1 left, 0 none, +1 right, and the brake key */
type Keys = (t: number) => { dir: number; brake?: number };

interface Run {
  /** Fronts' slip over their peak: the largest in the first second, the mean of the last second */
  turnInSlip: number;
  settledSlip: number;
  /** Mean lateral g over the last second, largest lateral g of the run */
  latG: number;
  peakLatG: number;
  maxBetaDeg: number;
  /** Final yaw rate (rad/s) and body slip (deg) */
  endYaw: number;
  endBetaDeg: number;
  /** Steering every frame (−1..1) */
  steer: number[];
}

/** A car on the pad at `kmh` with the game's assist settings (or `assist`) and TC / ABS at Semi-pro */
function placed(cc: CarCase, kmh: number, assist: SteeringAssistSettings = gameAssist()): SimulatorCar {
  const c = cc.make();
  c.assistPreset = 'semi_pro';
  c.steeringAssist.settings = assist;
  c.teleportToDistance(1500, kmh / 3.6);
  // Settle driving straight
  for (let t = 0; t < 1.5; t += DT) c.step(DT, { throttle: 0.3, analogSteer: 0 });
  return c;
}

/**
 * Drive `seconds` with `keys`, holding the speed unless braking. `steering` turns the keys into the car's steering
 * inputs (default: a keyboard-only player's)
 */
function drive(
  cc: CarCase,
  kmh: number,
  seconds: number,
  keys: Keys,
  opts: { holdSpeed?: boolean; assist?: SteeringAssistSettings; steering?: (dir: number) => Partial<ControlInputs> } = {}
): Run {
  const { holdSpeed = true, steering = (dir) => ({ kbSteer: dir }) } = opts;
  const c = placed(cc, kmh, opts.assist);
  const peakRad = cc.peakDeg(c) / RAD2DEG;
  const hold = speedHold(kmh / 3.6);
  let thr = 0.3;
  let turnIn = 0, settled = 0, nSettled = 0, ay = 0, peakAy = 0, maxBeta = 0;
  const steer: number[] = [];
  for (let t = 0; t < seconds; t += DT) {
    const k = keys(t);
    const brake = k.brake ?? 0;
    if (holdSpeed && brake === 0) thr = hold(c.vxMs);
    const throttle = brake > 0 ? 0 : holdSpeed ? thr : 0.3;
    c.step(DT, { throttle, brake, ...steering(k.dir) });
    steer.push(c.steerAngleNorm);
    const sa = c.telemetry.wheelSlipAnglesDeg;
    const front = Math.max(Math.abs(sa[0]), Math.abs(sa[1])) / RAD2DEG / peakRad;
    const lat = Math.abs(c.vxMs * c.yawRateRadS) / G;
    peakAy = Math.max(peakAy, lat);
    maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(c.vyMs, Math.max(1, c.vxMs))) * RAD2DEG);
    if (t < 1) turnIn = Math.max(turnIn, front);
    if (t > seconds - 1) {
      settled += front;
      ay += lat;
      nSettled++;
    }
  }
  return {
    turnInSlip: turnIn,
    settledSlip: settled / nSettled,
    latG: ay / nSettled,
    peakLatG: peakAy,
    maxBetaDeg: maxBeta,
    endYaw: c.yawRateRadS,
    endBetaDeg: Math.atan2(c.vyMs, Math.max(1, c.vxMs)) * RAD2DEG,
    steer,
  };
}

/**
 * Lateral g with the fronts held near their peak slip by a wheel (`analogSteer`, an integral loop on the slip):
 * what the car itself corners at, so the keyboard case is measured against the car rather than fixed numbers
 */
function wheelLatG(cc: CarCase, kmh: number, seconds = 4): number {
  const c = placed(cc, kmh);
  const peakRad = cc.peakDeg(c) / RAD2DEG;
  const vT = kmh / 3.6;
  const hold = speedHold(vT);
  let thr = 0.3;
  let steer = 0;
  let ay = 0;
  let n = 0;
  for (let t = 0; t < seconds; t += DT) {
    thr = hold(c.vxMs);
    c.step(DT, { throttle: thr, brake: 0, analogSteer: steer });
    const sa = c.telemetry.wheelSlipAnglesDeg;
    const front = Math.max(Math.abs(sa[0]), Math.abs(sa[1])) / RAD2DEG / peakRad;
    steer = Math.max(0, Math.min(1, steer + (0.95 - front) * 0.6 * DT));
    if (t > seconds - 1) {
      ay += Math.abs(c.vxMs * c.yawRateRadS) / G;
      n++;
    }
  }
  return ay / n;
}

/** Largest frame-by-frame difference of two steering traces */
const traceDiff = (a: readonly number[], b: readonly number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

let failed = 0;
const check = (ok: boolean, line: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
};
const f2 = (v: number) => v.toFixed(2);

/** Keyboard and controller tunings far apart, so each device's shows in the steering */
const SOFT = { selfSteerStrength: 0, dampingStrength: 0, speedSensitivity: 0, slipLimitMargin: -0.2, maxSelfSteerAngleDeg: 5 };
const FIRM = { selfSteerStrength: 1, dampingStrength: 1, speedSensitivity: 1, slipLimitMargin: 0.1, maxSelfSteerAngleDeg: 30 };
const padTuning = (t: typeof SOFT): PadTuning => ({ ...DEFAULT_PLAYER_SETTINGS.padTuning, ...t });
const kbTuning = (t: typeof SOFT): KeyboardTuning => ({ ...DEFAULT_PLAYER_SETTINGS.keyboardTuning, ...t });

for (const cc of CARS) {
  const name = cc.name.padEnd(17);
  // 1. Held key
  [70, 110, 150, 190].forEach((kmh) => {
    const n = drive(cc, kmh, 3, () => ({ dir: 1 }));
    const minG = 0.9 * wheelLatG(cc, kmh);
    check(
      n.turnInSlip <= 1.1 && n.settledSlip >= cc.minSettledSlip && n.settledSlip <= 1.05 && n.maxBetaDeg < 8 && n.latG >= minG,
      `${name} D held at ${String(kmh).padStart(3)} km/h: fronts ${f2(n.turnInSlip)}× their peak slip on turn-in, ` +
        `${f2(n.settledSlip)}× settled; ${f2(n.latG)} g (at least ${f2(minG)}); body slip ${n.maxBetaDeg.toFixed(1)}°`
    );
  });
  // 2. Trail-braked turn-in
  for (const kmh of [120, 180]) {
    const n = drive(cc, kmh, 1.2, (t) => ({ dir: 1, brake: t < 1.2 ? 0.6 : 0 }), { holdSpeed: false });
    check(
      n.turnInSlip <= 1.1 && n.maxBetaDeg < 8,
      `${name} D + brake from ${kmh} km/h: fronts at ${f2(n.turnInSlip)}× their peak slip, body slip ${n.maxBetaDeg.toFixed(1)}°`
    );
  }
  // 3. Tap
  {
    const n = drive(cc, 200, 2.5, (t) => ({ dir: t < 0.09 ? 1 : 0 }));
    check(
      n.peakLatG <= 0.9 && Math.abs(n.endYaw) < 0.03,
      `${name} 90 ms tap at 200 km/h: peak ${f2(n.peakLatG)} g, final yaw ${(n.endYaw * RAD2DEG).toFixed(2)}°/s`
    );
  }
  // 4. Release
  {
    const n = drive(cc, 150, 4, (t) => ({ dir: t < 1.5 ? 1 : 0 }));
    check(
      Math.abs(n.endYaw) < 0.05 && Math.abs(n.endBetaDeg) < 2,
      `${name} D held 1.5 s at 150 km/h then let go: straightens (yaw ${(n.endYaw * RAD2DEG).toFixed(2)}°/s, body slip ${n.endBetaDeg.toFixed(2)}°)`
    );
  }
  // 5. Flick
  {
    const n = drive(cc, 180, 3, (t) => ({ dir: t < 0.4 ? 1 : t < 0.8 ? -1 : 0 }));
    check(
      n.maxBetaDeg < 8 && Math.abs(n.endYaw) < 0.05,
      `${name} D → A flick at 180 km/h: max body slip ${n.maxBetaDeg.toFixed(1)}°, final yaw ${(n.endYaw * RAD2DEG).toFixed(2)}°/s`
    );
  }
  // 6. The tuning of the device that steers. A held key, then 2.5 s with it released: the run's steering must not
  // depend on the other device's tuning at all
  {
    const keys: Keys = (t) => ({ dir: t < 1.5 ? 1 : 0 });
    const run = (pad: typeof SOFT, kb: typeof SOFT, steering: (dir: number) => Partial<ControlInputs>) =>
      drive(cc, 150, 4, keys, { assist: gameAssist(padTuning(pad), kbTuning(kb)), steering }).steer;
    const keyboardOnly = (dir: number) => ({ kbSteer: dir });
    const keysWithPad = (dir: number) => ({ kbSteer: dir, padSteer: 0 });
    const kbOnly = traceDiff(run(SOFT, FIRM, keyboardOnly), run(FIRM, FIRM, keyboardOnly));
    const kbWithPad = traceDiff(run(SOFT, FIRM, keysWithPad), run(FIRM, FIRM, keysWithPad));
    // The keyboard's own tuning does show: the same run with a soft keyboard tuning steers differently
    const kbMatters = traceDiff(run(FIRM, SOFT, keyboardOnly), run(FIRM, FIRM, keyboardOnly));
    // A pad player's stick (held right, then centred) under the controller's tuning, whatever the keyboard's
    const stick = (dir: number) => ({ kbSteer: 0, padSteer: dir });
    const padOnly = traceDiff(run(FIRM, SOFT, stick), run(FIRM, FIRM, stick));
    check(
      kbOnly < 1e-9 && kbWithPad < 1e-9 && kbMatters > 0.01 && padOnly < 1e-9,
      `${name} each device steers with its own tuning: keyboard-only ${kbOnly.toExponential(1)}, keys with a pad ` +
        `plugged in ${kbWithPad.toExponential(1)}, pad ${padOnly.toExponential(1)} off from the run with the other ` +
        `device's tuning changed (the keyboard's own tuning moves it by ${f2(kbMatters)})`
    );
  }
  // 7. The assist's self-steer in a slide is the setup screens' curve, at this car's lock
  {
    const c = cc.make();
    const lockDeg = c.maxSteerAngleRad * RAD2DEG;
    const settledSelfSteer = (maxSelfSteerAngleDeg: number, rearDeg: number) => {
      const tuning = { ...kbTuning(FIRM), maxSelfSteerAngleDeg };
      const a = new SteeringAssist(gameAssist(DEFAULT_PLAYER_SETTINGS.padTuning, tuning));
      const vx = 30;
      // Sliding with no yaw rate (no yaw damping), the rear axle travelling `rearDeg` to the right
      const state: SteeringAssistCarState = {
        vxMs: vx,
        vyMs: -vx * Math.tan(rearDeg / RAD2DEG),
        yawRateRadS: 0,
        cgToFrontAxleM: c.wheelbaseM / 2,
        cgToRearAxleM: c.wheelbaseM / 2,
        wheelbaseM: c.wheelbaseM,
        maxSteerAngleRad: c.maxSteerAngleRad,
        frontPeakSlipRad: 0.1,
        brake: 0,
        maxLateralAccel: 15,
      };
      let out = 0;
      for (let i = 0; i < 600; i++) out = a.steer({ kbSteer: 0, steerLeft: 0, steerRight: 0, brake: 0 }, true, () => state, DT);
      const curve = selfSteerDeg(rearDeg, deviceAssistTuning(tuning, 'keyboard'), lockDeg);
      return { appliedDeg: out * lockDeg, curveDeg: curve };
    };
    const capped = settledSelfSteer(8, 60);
    const full = settledSelfSteer(30, 60);
    const small = settledSelfSteer(30, 6);
    check(
      Math.abs(capped.appliedDeg - capped.curveDeg) < 0.05 &&
        Math.abs(capped.curveDeg - 8) < 0.05 &&
        Math.abs(full.appliedDeg - full.curveDeg) < 0.05 &&
        full.curveDeg <= lockDeg + 1e-9 &&
        full.curveDeg > lockDeg - 0.05 &&
        Math.abs(small.appliedDeg - small.curveDeg) < 0.05,
      `${name} self-steer in a 60° slide: ${capped.appliedDeg.toFixed(2)}° with an 8° cap (curve ${capped.curveDeg.toFixed(2)}°), ` +
        `${full.appliedDeg.toFixed(2)}° with a 30° cap = the car's ${lockDeg.toFixed(1)}° lock (curve ` +
        `${full.curveDeg.toFixed(2)}°); a 6° slide ${small.appliedDeg.toFixed(2)}° (curve ${small.curveDeg.toFixed(2)}°)`
    );
  }
}

// 8. Keyboard pedal help (ABS / traction control off), as the game calls it: the key's held flag and pedal, the tyres'
// slip, the player's strength
{
  const strength = DEFAULT_PLAYER_SETTINGS.keyboardTuning.pedalAssistStrength;
  const help = new KeyboardPedalAssist();
  // A second of cornering at 0.95 slip with the brake key up, then the first press
  for (let t = 0; t < 1; t += DT) help.brakeScale(false, 0, 0.95, DT, true, strength);
  const firstPress = help.brakeScale(true, 0.05, 0.95, DT, true, strength);
  // Held past the grip: eased; back under it: recovers
  let minBrake = 1;
  for (let t = 0; t < 0.5; t += DT) minBrake = Math.min(minBrake, help.brakeScale(true, 1, Math.min(1.3, 0.6 + t * 2), DT, true, strength));
  // Let go while eased: the scale holds while the pedal falls back, then is 1 once it is up
  const onRelease = help.brakeScale(false, 0.6, 1.3, DT, true, strength);
  const released = help.brakeScale(false, 0, 1.3, DT, true, strength);
  let recovered = 0;
  for (let t = 0; t < 1; t += DT) recovered = help.brakeScale(true, 1, 0.4, DT, true, strength);
  const absOn = help.brakeScale(true, 1, 1.5, DT, false, strength);
  // Throttle: a second of wheelspin with the key up, then the first press; then held in wheelspin
  for (let t = 0; t < 1; t += DT) help.throttleScale(false, 0, 1.6, 30, DT, true, strength);
  const firstThrottle = help.throttleScale(true, 0.05, 1.6, 30, DT, true, strength);
  let minThrottle = 1;
  for (let t = 0; t < 0.5; t += DT) minThrottle = Math.min(minThrottle, help.throttleScale(true, 1, 1.6, 30, DT, true, strength));
  check(
    firstPress > 0.95 &&
      minBrake < 0.6 &&
      minBrake >= 0.3 &&
      Math.abs(onRelease - minBrake) < 0.2 &&
      onRelease < 1 &&
      released === 1 &&
      recovered > 0.99 &&
      absOn === 1 &&
      firstThrottle > 0.9 &&
      minThrottle < 0.9 &&
      minThrottle >= 0.6,
    `Keyboard pedal help: first brake press after a second of cornering with the key up ${f2(firstPress)}; held past ` +
      `the grip eased to ${f2(minBrake)}, ${f2(onRelease)} while the released pedal falls, ${released} once it is up, ` +
      `${f2(recovered)} back under the grip; ${absOn} with ABS on; throttle ${f2(firstThrottle)} on the first press ` +
      `after wheelspin with the key up, eased to ${f2(minThrottle)} held in wheelspin`
  );
}

console.log(failed ? `${failed} case(s) failed.` : 'Keyboard steering holds every car at its grip, gently, and lets it straighten.');
process.exit(failed ? 1 : 0);
