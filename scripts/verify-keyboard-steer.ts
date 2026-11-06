/**
 * Keyboard steering (#64). A steering key is all or nothing, so the car's steering assist shapes it: an S-curve ramp
 * to the angle that holds the front tyres at their peak slip relative to the front axle's direction of travel (on
 * turn-in and on the brakes as well as mid-corner), a self-aligning force when the key is let go and a capped
 * countersteer. Before, a held key ramped in a straight line (0.22 s) to a fixed angle worked out for steady cornering:
 * on turn-in and under braking that angle put the fronts well past their peak (they scrubbed and overheated), and a
 * short tap was a large share of the cornering limit.
 *
 * Every vehicle model (AMG GT3, FA-26 Rigid-Body, FA-26 Prototype) runs each case on a flat pad, with the keys
 * through the assist and, for comparison, with the previous open-loop ramp:
 *
 * 1. D held for 3 s at a steady speed: the fronts stay near their peak slip on turn-in (first second) and when
 *    settled (last second), the car corners at least about as hard as before and does not spin.
 * 2. Trail-braked turn-in: D and the brake held together: the fronts stay near their peak.
 * 3. A 90 ms tap on D at 200 km/h: a gentle nudge, well under the previous ramp's lateral g, and the car runs straight.
 * 4. D held, then let go: the car straightens itself (yaw rate and body slip back near zero).
 * 5. A D → A flick at 180 km/h: no spin.
 * 6. The keyboard pedal help (ABS / traction control off) eases a key's pedal past the grip and lets it back.
 *
 * Usage: npx tsx scripts/verify-keyboard-steer.ts
 */
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { KeyboardPedalAssist } from '../src/lib/input/keyboard-pedals';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { triggerMagnitudes } from '../src/lib/sim/gamepad-haptics';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { ASSIST_PRESETS, evaluateSelfSteerDeg } from '../src/lib/sim/steering-assist';
import { VF26_TYRES } from '../src/lib/sim/vf26-data';
import { createFlatTestTrack } from './lib/flat-track';

const DT = 1 / 120;
const G = 9.81;
const RAD2DEG = 180 / Math.PI;
const pad = createFlatTestTrack(30_000, 3000);

// The sims' internals (compound data, profiles) are read directly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Car = any;

interface CarCase {
  name: string;
  make: () => Car;
  /** Front peak slip angle from the tyre data (deg) */
  peakDeg: (c: Car) => number;
  /** The previous open-loop keyboard limit's grip envelope: lateral accel (m/s²) and front slip allowance (rad) */
  oldEnvelope: (c: Car) => { accel: number; slipRad: number };
}

const rigidBodyPeak = (c: Car) => (c.compoundData.modelData.friction_limit_angle as number) || 7;
const rigidBodyEnvelope = (share: number) => (c: Car) => ({
  accel: c.profile.padLateralMu * (G + c.vehicle.telemetry.downforceN / c.vehicle.totalMassKg),
  slipRad: (share * rigidBodyPeak(c)) / RAD2DEG,
});

const CARS: CarCase[] = [
  { name: 'AMG GT3', make: () => createAmgGt3Sim(pad), peakDeg: rigidBodyPeak, oldEnvelope: rigidBodyEnvelope(0.6) },
  { name: 'FA-26 Rigid-Body', make: () => new F12026CarSim(pad), peakDeg: rigidBodyPeak, oldEnvelope: rigidBodyEnvelope(0.8) },
  {
    name: 'FA-26 Prototype',
    make: () => new F1Physics2026(pad),
    peakDeg: (c) => VF26_TYRES[c.tireCompound as 'soft'].front.frictionLimitAngleDeg,
    oldEnvelope: () => ({ accel: 38, slipRad: 0.12 }),
  },
];

/** The keys as a driver presses them: −1 left, 0 none, +1 right, and the brake key */
type Keys = (t: number) => { dir: number; brake?: number };

/**
 * The previous keyboard steering: a linear ramp (0.22 s out, 0.14 s back) to the road-wheel angle for the car's
 * lateral grip at this speed plus a share of the fronts' peak slip, sent straight to the rack
 */
class OpenLoopKeys {
  steer = 0;
  step(c: Car, cc: CarCase, dir: number, dt: number): number {
    const env = cc.oldEnvelope(c);
    const v = Math.max(1, c.vxMs);
    const limit = Math.min(1, ((c.wheelbaseM * env.accel) / (v * v) + env.slipRad) / c.maxSteerAngleRad);
    const target = dir * limit;
    const back = target === 0 || target * this.steer < 0;
    const maxStep = (limit / (back ? 0.14 : 0.22)) * dt;
    this.steer += Math.max(-maxStep, Math.min(maxStep, target - this.steer));
    return this.steer;
  }
}

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
  /** Heading change over the run (deg) */
  headingDeg: number;
}

function drive(cc: CarCase, kmh: number, seconds: number, keys: Keys, openLoop: boolean, holdSpeed = true): Run {
  const c = cc.make();
  c.setAssistPreset?.('semi_pro');
  c.teleportToDistance(1500, kmh / 3.6);
  // Settle driving straight
  for (let t = 0; t < 1.5; t += DT) c.step(DT, { throttle: 0.3, analogSteer: 0 });
  const peakRad = cc.peakDeg(c) / RAD2DEG;
  const old = new OpenLoopKeys();
  const vT = kmh / 3.6;
  let thr = 0.3;
  let turnIn = 0, settled = 0, nSettled = 0, ay = 0, peakAy = 0, maxBeta = 0, heading = 0;
  for (let t = 0; t < seconds; t += DT) {
    const k = keys(t);
    const brake = k.brake ?? 0;
    if (holdSpeed && brake === 0) thr = Math.max(0, Math.min(1, thr + (vT - c.vxMs) * 0.5 * DT));
    const throttle = brake > 0 ? 0 : holdSpeed ? thr : 0.3;
    c.step(
      DT,
      openLoop ? { throttle, brake, analogSteer: old.step(c, cc, k.dir, DT) } : { throttle, brake, kbSteer: k.dir }
    );
    const sa = c.telemetry.wheelSlipAnglesDeg as number[];
    const front = Math.max(Math.abs(sa[0]), Math.abs(sa[1])) / RAD2DEG / peakRad;
    const lat = Math.abs(c.vxMs * c.yawRateRadS) / G;
    heading += c.yawRateRadS * DT * RAD2DEG;
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
    headingDeg: heading,
  };
}

let failed = 0;
const check = (ok: boolean, line: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
};
const f2 = (v: number) => v.toFixed(2);

for (const cc of CARS) {
  const name = cc.name.padEnd(17);
  // 1. Held key
  for (const kmh of [70, 110, 150, 190]) {
    const o = drive(cc, kmh, 3, () => ({ dir: 1 }), true);
    const n = drive(cc, kmh, 3, () => ({ dir: 1 }), false);
    check(
      n.turnInSlip <= 1.3 && n.settledSlip >= 0.75 && n.settledSlip <= 1.25 && n.maxBetaDeg < 8 && n.latG >= 0.93 * o.latG,
      `${name} D held at ${String(kmh).padStart(3)} km/h, old → new: fronts on turn-in ${f2(o.turnInSlip)}× → ${f2(n.turnInSlip)}×, ` +
        `settled ${f2(o.settledSlip)}× → ${f2(n.settledSlip)}× their peak slip; ${f2(o.latG)} → ${f2(n.latG)} g; ` +
        `body slip ${o.maxBetaDeg.toFixed(1)}° → ${n.maxBetaDeg.toFixed(1)}°`
    );
  }
  // 2. Trail-braked turn-in
  for (const kmh of [120, 180]) {
    const keys: Keys = (t) => ({ dir: 1, brake: t < 1.2 ? 0.6 : 0 });
    const o = drive(cc, kmh, 1.2, keys, true, false);
    const n = drive(cc, kmh, 1.2, keys, false, false);
    check(
      n.turnInSlip <= 1.35 && n.maxBetaDeg < 8,
      `${name} D + brake from ${kmh} km/h, old → new: fronts at ${f2(o.turnInSlip)}× → ${f2(n.turnInSlip)}× their peak slip, ` +
        `body slip ${o.maxBetaDeg.toFixed(1)}° → ${n.maxBetaDeg.toFixed(1)}°`
    );
  }
  // 3. Tap
  {
    const keys: Keys = (t) => ({ dir: t < 0.09 ? 1 : 0 });
    const o = drive(cc, 200, 2.5, keys, true);
    const n = drive(cc, 200, 2.5, keys, false);
    check(
      n.peakLatG <= 0.75 * o.peakLatG && Math.abs(n.endYaw) < 0.03,
      `${name} 90 ms tap at 200 km/h, old → new: peak ${f2(o.peakLatG)} → ${f2(n.peakLatG)} g, heading change ` +
        `${o.headingDeg.toFixed(2)}° → ${n.headingDeg.toFixed(2)}°, final yaw ${(n.endYaw * RAD2DEG).toFixed(2)}°/s`
    );
  }
  // 4. Release
  {
    const n = drive(cc, 150, 4, (t) => ({ dir: t < 1.5 ? 1 : 0 }), false);
    check(
      Math.abs(n.endYaw) < 0.05 && Math.abs(n.endBetaDeg) < 2,
      `${name} D held 1.5 s at 150 km/h then let go: straightens (yaw ${(n.endYaw * RAD2DEG).toFixed(2)}°/s, body slip ${n.endBetaDeg.toFixed(2)}°)`
    );
  }
  // 5. Flick
  {
    const keys: Keys = (t) => ({ dir: t < 0.4 ? 1 : t < 0.8 ? -1 : 0 });
    const o = drive(cc, 180, 3, keys, true);
    const n = drive(cc, 180, 3, keys, false);
    check(
      n.maxBetaDeg < 8 && Math.abs(n.endYaw) < 0.05,
      `${name} D → A flick at 180 km/h, old → new: max body slip ${o.maxBetaDeg.toFixed(1)}° → ${n.maxBetaDeg.toFixed(1)}°, ` +
        `final yaw ${(n.endYaw * RAD2DEG).toFixed(2)}°/s`
    );
  }
}
// Keyboard pedal help (ABS / traction control off): the key's pedal eases back as the tyres pass their grip and
// comes back as they recover; switched off (the car's aid on) it leaves the key alone
{
  const help = new KeyboardPedalAssist();
  let minBrake = 1;
  for (let t = 0; t < 0.5; t += DT) minBrake = Math.min(minBrake, help.brakeScale(Math.min(1.3, 0.6 + t * 2), DT, true));
  let recovered = minBrake;
  for (let t = 0; t < 1; t += DT) recovered = help.brakeScale(0.4, DT, true);
  const off = help.brakeScale(1.5, DT, false);
  let minThrottle = 1;
  for (let t = 0; t < 0.5; t += DT) minThrottle = Math.min(minThrottle, help.throttleScale(1.6, 30, DT, true));
  check(
    minBrake < 0.6 && minBrake >= 0.3 && recovered > 0.99 && off === 1 && minThrottle < 0.9 && minThrottle >= 0.6,
    `Keyboard pedal help: brake key eased to ${f2(minBrake)} past the grip and back to ${f2(recovered)} after; ` +
      `${off} with ABS on; throttle key eased to ${f2(minThrottle)} in wheelspin`
  );
}

// Assist presets & self-steer curve evaluator
{
  const loose = ASSIST_PRESETS.find((p) => p.id === 'loose')!;
  const drift = ASSIST_PRESETS.find((p) => p.id === 'drift')!;
  const looseAt40 = evaluateSelfSteerDeg(40, loose.tuning, 25);
  const driftAt40 = evaluateSelfSteerDeg(40, drift.tuning, 25);
  check(
    ASSIST_PRESETS.length === 5 && Math.abs(looseAt40 - 8) < 0.2 && driftAt40 > 18 && driftAt40 <= 25,
    `Assist presets (${ASSIST_PRESETS.map((p) => p.label).join(', ')}): Loose caps at ${looseAt40.toFixed(1)}°, Drift reaches ${driftAt40.toFixed(1)}° at 40° slide`
  );
}

// Always-on trigger slip feedback (works even with ABS & TC enabled)
{
  const sim = createAmgGt3Sim(pad);
  sim.assistPreset = 'semi_pro';
  const tel = {
    ...sim.telemetry,
    speedKmh: 140,
    brake: 0.7,
    throttle: 0.7,
    tireSlipRatio: [1.05, 1.05, 1.35, 1.35] as [number, number, number, number],
    wheelSlipAnglesDeg: [8, 8, 8, 8] as [number, number, number, number],
    wheelLoadsN: [3500, 3500, 4000, 4000] as [number, number, number, number],
    wheelSlipRatios: [-0.05, -0.05, 0.06, 0.06] as [number, number, number, number],
  };
  const withAlwaysOnBrake = triggerMagnitudes({ ...tel, wheelSlipRatios: [-0.05, -0.05, 0, 0] }, 0.1, { triggerSlipAlwaysOn: true });
  const withoutAlwaysOnBrake = triggerMagnitudes({ ...tel, wheelSlipRatios: [-0.05, -0.05, 0, 0] }, 0.1, { triggerSlipAlwaysOn: false });
  const withAlwaysOnThrottle = triggerMagnitudes({ ...tel, brake: 0 }, 0.1, { triggerSlipAlwaysOn: true });
  const withoutAlwaysOnThrottle = triggerMagnitudes({ ...tel, brake: 0 }, 0.1, { triggerSlipAlwaysOn: false });
  check(
    withAlwaysOnBrake.left > 0.1 &&
      withAlwaysOnThrottle.right > 0.1 &&
      withoutAlwaysOnBrake.left === 0 &&
      withoutAlwaysOnThrottle.right === 0,
    `Trigger slip always-on: LT=${f2(withAlwaysOnBrake.left)} RT=${f2(withAlwaysOnThrottle.right)} with ABS/TC on vs ${withoutAlwaysOnBrake.left}/${withoutAlwaysOnThrottle.right} when disabled`
  );
}

// Smart Auto-Gearbox: manual short-shift override (1.0 s cooldown + downshift protection while accelerating)
{
  const sim = createAmgGt3Sim(pad);
  sim.autoGearbox = true;
  sim.teleportToDistance(1500, 95 / 3.6);
  for (let t = 0; t < 0.5; t += DT) sim.step(DT, { throttle: 0.6, analogSteer: 0 });
  const gearBefore = sim.telemetry.gear as number;
  // Short-shift up manually while in Auto Gearbox
  sim.step(DT, { throttle: 0.6, shiftUp: true, analogSteer: 0 });
  const gearAfterShift = sim.telemetry.gear as number;
  // Hold throttle for 1.8 s (past the 1.0 s manual override timer): downshiftProtectedGear keeps the short-shifted gear
  for (let t = 0; t < 1.8; t += DT) sim.step(DT, { throttle: 0.6, analogSteer: 0 });
  const gearHeld = sim.telemetry.gear as number;
  check(
    gearAfterShift === gearBefore + 1 && gearHeld >= gearAfterShift,
    `Smart Auto-Gearbox: manual short-shift ${gearBefore} → ${gearAfterShift} held at gear ${gearHeld} under throttle`
  );
}

console.log(failed ? `${failed} case(s) failed.` : 'Keyboard steering holds every car at its grip, gently, and lets it straighten.');
process.exit(failed ? 1 : 0);
