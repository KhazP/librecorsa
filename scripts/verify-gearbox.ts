/**
 * The automatic gearbox and its manual override (src/lib/sim/auto-gearbox.ts), on both gearbox models: the VF26's
 * (F1Physics2026) and VehiclePhysics' (F1 2026 Rigid-Body, AMG GT3).
 *
 * 1. The schedule and the override on their own: an auto shift the driver's paddle shift would undo is held, one the
 *    engine needs (limiter, lugging, the brakes) never is, and a shift the same way as the driver's goes through.
 * 2. Short-shift: after a manual upshift into a gear the box would shift back down from, the gear holds while the
 *    driver stays on the throttle, and the box shifts down once they lift or brake.
 * 3. Braking straight after a manual upshift: the box shifts down well inside the override's second.
 * 4. A manual downshift that runs the engine into the limiter: the box shifts back up well inside the override's second
 *    (on the VehiclePhysics cars only once past their normal upshift point).
 * 5. Placement: a manual shift made just before a teleport does not hold the box afterwards.
 * 6. A paddle press during a shift is made once that shift is done: not dropped, and not before it.
 * 7. No neutral in the sequence: down from first stays in first while rolling and is reverse at a standstill, and up
 *    from reverse is first.
 *
 * Usage: npx tsx scripts/verify-gearbox.ts
 */
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import {
  type AutoShiftInput,
  type AutoShiftSchedule,
  autoShift,
  createAutoShiftInput,
  ManualShiftOverride,
} from '../src/lib/sim/auto-gearbox';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { VF26_DRIVETRAIN, VF26_ENGINE } from '../src/lib/sim/vf26-data';
import type { ControlInputs } from '../src/types/f1';
import { createFlatTestTrack } from './lib/flat-track';

const DT = 1 / 120;
const pad = createFlatTestTrack(30_000, 3000);

let failed = 0;
const check = (ok: boolean, line: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
};

// ---- 1. The policy on its own ---------------------------------------------------------------------------------------

const SCHEDULE: AutoShiftSchedule = {
  upshiftRpm: 11000,
  limiterRpm: 12000,
  downshiftRpm: 8000,
  lugRpm: 6000,
  downshiftMarginRpm: 500,
  upshiftMaxBrake: 0.1,
  liftThrottle: 0.6,
};
const car = (patch: Partial<AutoShiftInput>): AutoShiftInput => ({
  ...createAutoShiftInput(),
  gear: 4,
  topGear: 8,
  engineRpm: 9000,
  roadRpm: 9000,
  lowerGearRpm: 10000,
  throttle: 0.5,
  ...patch,
});
{
  const o = new ManualShiftOverride();
  const offPower = car({ roadRpm: 7500, engineRpm: 7500, throttle: 0.3 });
  const free = autoShift(offPower, SCHEDULE, o);
  o.shifted(1, 4);
  const held = autoShift(offPower, SCHEDULE, o);
  o.tick(1.5);
  const heldOnThrottle = autoShift(offPower, SCHEDULE, o);
  const lugging = autoShift(car({ roadRpm: 5900, engineRpm: 5900, throttle: 0.3, lowerGearRpm: 7000 }), SCHEDULE, o);
  const braking = autoShift({ ...offPower, brake: 0.5 }, SCHEDULE, o);
  const afterBrake = autoShift(offPower, SCHEDULE, o);
  check(
    free === -1 && held === 0 && heldOnThrottle === 0 && lugging === -1 && braking === -1 && afterBrake === -1,
    `policy, after a manual upshift: lift downshift ${free} → held ${held}, still held on the throttle after 1.5 s ` +
      `(${heldOnThrottle}); lugging ${lugging}, braking ${braking}, and the hold is over after the brakes (${afterBrake})`
  );
}
{
  const o = new ManualShiftOverride();
  o.shifted(1, 4);
  o.tick(1.5);
  const lift = autoShift(car({ roadRpm: 7500, engineRpm: 7500, throttle: 0 }), SCHEDULE, o);
  const o2 = new ManualShiftOverride();
  o2.shifted(1, 4);
  const up = autoShift(car({ engineRpm: 11200 }), SCHEDULE, o2);
  check(
    lift === -1 && up === 1,
    `policy: a lift past the hold's second shifts down (${lift}); an upshift after a manual upshift goes through (${up})`
  );
}
{
  const o = new ManualShiftOverride();
  o.shifted(-1, 4);
  const pastPoint = autoShift(car({ engineRpm: 11300 }), SCHEDULE, o);
  const limiter = autoShift(car({ engineRpm: 11900 }), SCHEDULE, o);
  const down = autoShift(car({ roadRpm: 7500, engineRpm: 7500, throttle: 0.3 }), SCHEDULE, o);
  o.tick(1.01);
  const later = autoShift(car({ engineRpm: 11300 }), SCHEDULE, o);
  check(
    pastPoint === 0 && limiter === 1 && down === -1 && later === 1,
    `policy, after a manual downshift: upshift past the point held (${pastPoint}), at the limiter taken (${limiter}), ` +
      `a further downshift taken (${down}), the upshift taken once the second is up (${later})`
  );
}
{
  const o = new ManualShiftOverride();
  const air = autoShift(car({ engineRpm: 11200, drivenGrounded: false }), SCHEDULE, o);
  const spin = autoShift(car({ engineRpm: 11200, roadRpm: 9500, drivenSpinning: true }), SCHEDULE, o);
  const spinAtPoint = autoShift(car({ engineRpm: 11200, roadRpm: 11100, drivenSpinning: true }), SCHEDULE, o);
  check(
    air === 0 && spin === 0 && spinAtPoint === 1,
    `policy: no upshift with the rears in the air (${air}) or spinning (${spin}) unless road speed is at the point (${spinAtPoint})`
  );
}

// ---- 2.–5. On the cars ----------------------------------------------------------------------------------------------

interface Model {
  name: string;
  make: () => SimulatorCar;
  upshiftRpm: number;
  limiterRpm: number;
  /** Short-shift: teleport speed (km/h) whose gear, one up, sits where the box would shift back down */
  shortShiftKmh: number;
  /** Limiter: teleport speed (km/h) whose gear, one down, runs the engine into the limiter */
  limiterKmh: number;
  /** Placement: a manual shift (up or down) from the first speed, then a teleport to the second, landing in the shifted gear */
  placement: { dir: 1 | -1; fromKmh: number; toKmh: number };
  /** How long an upshift takes (s): a second paddle press inside it waits for it */
  upshiftS: number;
}

const MODELS: Model[] = [
  {
    name: 'F1 2026 Prototype (F1Physics2026)',
    make: () => new F1Physics2026(pad),
    upshiftRpm: VF26_DRIVETRAIN.autoUpshiftRpm,
    limiterRpm: VF26_ENGINE.limiterRpm,
    shortShiftKmh: 110,
    limiterKmh: 190,
    placement: { dir: 1, fromKmh: 110, toKmh: 150 },
    upshiftS: VF26_DRIVETRAIN.upshiftTimeS,
  },
  {
    name: 'F1 2026 Rigid-Body (VehiclePhysics)',
    make: () => new F12026CarSim(pad),
    upshiftRpm: F12026_CAR_CONFIG.gearbox.gears.upshift_rpm,
    limiterRpm: F12026_CAR_CONFIG.gearbox.gears.redline_rpm,
    shortShiftKmh: 100,
    limiterKmh: 180,
    placement: { dir: -1, fromKmh: 180, toKmh: 175 },
    upshiftS: F12026_CAR_CONFIG.gearbox.shiftTimeS,
  },
  {
    name: 'AMG GT3 (VehiclePhysics)',
    make: () => createAmgGt3Sim(pad),
    upshiftRpm: AMG_GT3_CONFIG.gearbox.gears.upshift_rpm,
    limiterRpm: AMG_GT3_CONFIG.gearbox.gears.redline_rpm,
    shortShiftKmh: 70,
    limiterKmh: 190,
    placement: { dir: -1, fromKmh: 190, toKmh: 185 },
    upshiftS: AMG_GT3_CONFIG.gearbox.shiftTimeS,
  },
];

/** A car on the pad at `kmh` with the auto box on */
function placed(m: Model, kmh: number): SimulatorCar {
  const c = m.make();
  c.autoGearbox = true;
  c.teleportToDistance(1000, kmh / 3.6);
  return c;
}

const step = (c: SimulatorCar, inputs: Partial<ControlInputs>) => c.step(DT, { analogSteer: 0, ...inputs });

/** One frame with the paddle pressed, then three released (the VF26's seamless shift takes 15–20 ms) */
function paddle(c: SimulatorCar, dir: 1 | -1, inputs: Partial<ControlInputs>): void {
  step(c, { ...inputs, shiftUp: dir > 0, shiftDown: dir < 0 });
  for (let i = 0; i < 3; i++) step(c, inputs);
}

/** Throttle that holds `kmh` (a crude cruise control, never under `min`) */
const cruise = (c: SimulatorCar, kmh: number, thr: number, min = 0.03) =>
  Math.max(min, Math.min(0.55, thr + (kmh / 3.6 - c.vxMs) * 0.4 * DT));

for (const m of MODELS) {
  const name = m.name.padEnd(34);

  // 2. Short-shift held on the throttle, released by a lift
  {
    const c = placed(m, m.shortShiftKmh);
    let thr = 0.1;
    for (let t = 0; t < 0.3; t += DT) step(c, { throttle: (thr = cruise(c, m.shortShiftKmh, thr)) });
    const before = c.telemetry.gear;
    paddle(c, 1, { throttle: thr });
    const shifted = c.telemetry.gear;
    let lowest = shifted;
    for (let t = 0; t < 2; t += DT) {
      step(c, { throttle: (thr = cruise(c, m.shortShiftKmh, thr)) });
      lowest = Math.min(lowest, c.telemetry.gear);
    }
    let liftS = Infinity;
    for (let t = 0; t < 1.5 && liftS === Infinity; t += DT) {
      step(c, { throttle: 0 });
      if (c.telemetry.gear < shifted) liftS = t;
    }
    check(
      shifted === before + 1 && lowest === shifted && liftS < 0.4,
      `${name} short-shift ${before} → ${shifted} at ${m.shortShiftKmh} km/h held 2 s on the throttle (lowest gear ` +
        `${lowest}), down again ${liftS === Infinity ? 'never' : `${liftS.toFixed(2)} s`} after a lift`
    );
  }

  // 3. Braking straight after a manual upshift
  {
    const c = placed(m, 250);
    for (let t = 0; t < 0.3; t += DT) step(c, { throttle: 1 });
    paddle(c, 1, { throttle: 1 });
    const shifted = c.telemetry.gear;
    let firstDownS = Infinity;
    for (let t = 0; t < 1 && firstDownS === Infinity; t += DT) {
      step(c, { throttle: 0, brake: 1 });
      if (c.telemetry.gear < shifted) firstDownS = t;
    }
    check(
      firstDownS < 0.8,
      `${name} manual upshift to ${shifted} at 250 km/h, then the brakes: first auto downshift after ` +
        `${firstDownS === Infinity ? 'over 1 s' : `${firstDownS.toFixed(2)} s`}`
    );
  }

  // 4. Manual downshift into the limiter
  {
    const c = placed(m, m.limiterKmh);
    for (let t = 0; t < 0.2; t += DT) step(c, { throttle: 1 });
    const before = c.telemetry.gear;
    paddle(c, -1, { throttle: 1 });
    const shifted = c.telemetry.gear;
    let maxRpm = 0;
    let backUpS = Infinity;
    for (let t = 0; t < 1.2 && backUpS === Infinity; t += DT) {
      step(c, { throttle: 1 });
      if (c.telemetry.gear > shifted) backUpS = t;
      else maxRpm = Math.max(maxRpm, c.telemetry.rpm);
    }
    // The VF26 shifts up 300 rpm under its limiter: its hold past the upshift point is too short to see
    const heldPastPoint = m.limiterRpm - m.upshiftRpm < 500 || maxRpm > (m.upshiftRpm + m.limiterRpm) / 2;
    check(
      shifted === before - 1 && backUpS < 0.8 && heldPastPoint,
      `${name} manual downshift ${before} → ${shifted} at ${m.limiterKmh} km/h, full throttle: back up after ` +
        `${backUpS === Infinity ? 'over 1.2 s' : `${backUpS.toFixed(2)} s`} at ${Math.round(maxRpm)} rpm ` +
        `(upshift point ${m.upshiftRpm}, limiter ${m.limiterRpm})`
    );
  }

  // 5. Placement clears the override: after a teleport into the shifted gear the box shifts where a fresh car's does
  {
    const p = m.placement;
    const shiftedAt = (pre: boolean): { gear: number; atKmh: number; rpm: number } => {
      const c = placed(m, p.fromKmh);
      for (let t = 0; t < 0.2; t += DT) step(c, { throttle: 0.2 });
      if (pre) paddle(c, p.dir, { throttle: 0.2 });
      c.teleportToDistance(2000, p.toKmh / 3.6);
      const gear = c.telemetry.gear;
      let maxRpm = 0;
      // Upshift case: full throttle to the upshift; downshift case: coasting just on the throttle to the downshift
      const throttle = p.dir < 0 ? 1 : 0.05;
      for (let t = 0; t < 8; t += DT) {
        step(c, { throttle });
        if (c.telemetry.gear !== gear) return { gear, atKmh: c.telemetry.speedKmh, rpm: maxRpm };
        maxRpm = Math.max(maxRpm, c.telemetry.rpm);
      }
      return { gear, atKmh: Number.NaN, rpm: maxRpm };
    };
    const fresh = shiftedAt(false);
    const after = shiftedAt(true);
    const same = p.dir < 0 ? Math.abs(after.rpm - fresh.rpm) < 150 : Math.abs(after.atKmh - fresh.atKmh) < 3;
    check(
      after.gear === fresh.gear && Number.isFinite(after.atKmh) && same,
      `${name} manual ${p.dir > 0 ? 'upshift' : 'downshift'} then a teleport into gear ${after.gear}: the box shifts ` +
        (p.dir < 0
          ? `up at ${Math.round(after.rpm)} rpm (a fresh car: ${Math.round(fresh.rpm)})`
          : `down at ${after.atKmh.toFixed(1)} km/h (a fresh car: ${fresh.atKmh.toFixed(1)})`)
    );
  }

  // 6. Two upshift presses 8 ms apart with the manual box: the second, inside the first shift, lands once it is done
  {
    const fine = 1 / 240;
    const c = m.make();
    c.autoGearbox = false;
    c.teleportToDistance(1000, 120 / 3.6);
    const g0 = c.telemetry.gear;
    const presses: Partial<ControlInputs>[] = [{ shiftUp: true }, {}, { shiftUp: true }];
    let firstS = Infinity;
    let secondS = Infinity;
    let t = 0;
    for (let i = 0; t < 0.5; i++) {
      c.step(fine, { analogSteer: 0, throttle: 0.3, ...(presses[i] ?? {}) });
      t += fine;
      if (firstS === Infinity && c.telemetry.gear > g0) firstS = t;
      if (secondS === Infinity && c.telemetry.gear >= g0 + 2) secondS = t;
    }
    const gap = secondS - firstS;
    check(
      c.telemetry.gear === g0 + 2 && gap >= m.upshiftS - fine - 1e-9,
      `${name} two upshift presses 8 ms apart (the shift takes ${Math.round(m.upshiftS * 1000)} ms): gear ${g0} → ` +
        `${c.telemetry.gear}, the second ${Number.isFinite(gap) ? `${Math.round(gap * 1000)} ms after the first` : 'never made'}`
    );
  }

  // 7. No neutral: down from first while rolling stays in first; at a standstill it is reverse, and up again is first
  {
    const c = m.make();
    c.autoGearbox = false;
    c.teleportToDistance(1000, 40 / 3.6);
    let thr = 0.1;
    let lowest = c.telemetry.gear;
    for (let n = 0; n < 8; n++) {
      step(c, { throttle: thr, shiftDown: true });
      for (let i = 0; i < 15; i++) {
        step(c, { throttle: (thr = cruise(c, 40, thr)) });
        lowest = Math.min(lowest, c.telemetry.gear);
      }
    }
    const rolling = c.telemetry.gear;
    const rollingKmh = c.telemetry.speedKmh;
    const s = m.make();
    s.autoGearbox = false;
    s.teleportToDistance(1000, 0);
    for (let i = 0; i < 30; i++) step(s, {});
    paddle(s, -1, {});
    for (let i = 0; i < 12; i++) step(s, {});
    const stopped = s.telemetry.gear;
    paddle(s, 1, {});
    for (let i = 0; i < 12; i++) step(s, {});
    const backUp = s.telemetry.gear;
    check(
      rolling === 1 && lowest === 1 && stopped === -1 && backUp === 1,
      `${name} manual box, down from first at ${Math.round(rollingKmh)} km/h: gear ${rolling} (lowest ${lowest}); ` +
        `at a standstill down → ${stopped}, then up → ${backUp}`
    );
  }
}

console.log(failed ? `${failed} case(s) failed.` : 'The auto box honours the driver and never fights the engine.');
process.exit(failed ? 1 : 0);
