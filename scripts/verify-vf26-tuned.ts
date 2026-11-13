/**
 * The VF26 a driver gets on the rigid-body engine: the car data with the tune of `Vf26Tune.ts`. Holds it where it was
 * set: on flat ground, against 2026 qualifying laps on the straights, on its ride heights at speed, and over laps of
 * Rwanda (on the road, off its plank, tyres in their window).
 *
 *   npx tsx scripts/verify-vf26-tuned.ts
 *
 * `verify-vf26-fold.ts` compares the two engines on the untouched data; this is the tuned car on its own bands.
 */
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createVf26Sim, VF26_SIM_PROFILE, vf26TunedProfileCar } from '../src/lib/sim/f12026-car/Vf26Sim';
import { plannedDownforceCoef, plannedMu } from '../src/lib/sim/speed-profile';
import { VF26_TUNED_CONFIG } from '../src/lib/sim/f12026-car/Vf26Tune';
import { VF26_CAR_CONFIG } from '../src/lib/sim/f12026-car/Vf26Config';
import { VF26_AI_REFERENCE } from '../src/lib/sim/vf26-data';
import { createFlatTestTrack } from './lib/flat-track';
import { measureVf26, VF26_TUNED } from './lib/vf26-measure';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};
const f = (v: number, d = 2) => v.toFixed(d);
const between = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

const C = VF26_TUNED_CONFIG;
const pad = createFlatTestTrack(60_000, 3000);
const H = 1 / 240;
function fresh(kmh: number, config = C): F12026CarSim {
  const sim = new F12026CarSim(pad, null, { ...VF26_SIM_PROFILE, config });
  sim.assistPreset = 'pro';
  sim.autoGearbox = true;
  sim.teleportToDistance(2000, kmh / 3.6);
  return sim;
}

console.log('== What the tune is');
{
  const ch = C.chassis;
  const soft = C.tyreCompounds.PhysicsTyreCompound_F1_Soft;
  const tyreRate = (rear: boolean) => {
    const p = (rear ? soft.rearOverride?.pressureData?.pressureSpringCurve : undefined) ?? soft.pressureData.pressureSpringCurve;
    return p[Math.floor(p.length / 2)][1];
  };
  const sprung = ch.totalMassKg - 2 * ch.unsprungMassFront - 2 * ch.unsprungMassRear;
  const axle = (rear: boolean) => {
    const s = rear ? C.suspensions.rear : C.suspensions.front;
    const d = C.suspensions.dampers_controller[rear ? 'rear' : 'front'];
    const unsprung = rear ? ch.unsprungMassRear : ch.unsprungMassFront;
    const corner = (sprung * (rear ? 1 - ch.frontWeightFraction : ch.frontWeightFraction)) / 2;
    const heaveRate = s.springs.wheel_rate + (s.heave?.rate ?? 0) / 2;
    return {
      hopHz: Math.sqrt((heaveRate + tyreRate(rear)) / unsprung) / (2 * Math.PI),
      // Roll: the corner dampers alone on the spring and the bar
      rollBump: d.base.slow_bump / (2 * Math.sqrt((s.springs.wheel_rate + 2 * s.arb) * corner)),
      digressive: d.base.fast_bump < d.base.slow_bump && d.base.fast_rebound < d.base.slow_rebound,
    };
  };
  const fr = axle(false);
  const rr = axle(true);
  check('Wheels of 28 to 36 kg', between(ch.unsprungMassFront, 28, 36) && between(ch.unsprungMassRear, 28, 36), `${ch.unsprungMassFront} / ${ch.unsprungMassRear} kg (the data's car: ${VF26_CAR_CONFIG.chassis.unsprungMassFront} / ${VF26_CAR_CONFIG.chassis.unsprungMassRear})`);
  check('... that hop at 17 to 23 Hz', between(fr.hopHz, 17, 23) && between(rr.hopHz, 17, 23), `${f(fr.hopHz, 1)} / ${f(rr.hopHz, 1)} Hz`);
  check('Corner dampers 0.35 to 0.5 of critical in slow bump, softer past the knee', between(fr.rollBump, 0.35, 0.5) && between(rr.rollBump, 0.35, 0.5) && fr.digressive && rr.digressive, `${f(fr.rollBump)} / ${f(rr.rollBump)}`);
  // Eighth gear against the laps: engine speed per km/h
  const r = soft.rear.radius;
  const rpmPerKmh = (C.gearbox.ratios[7] * C.gearbox.finalDrive * 60) / (2 * Math.PI * r * 3.6);
  check('Eighth gear turns the engine as the 2026 laps show (34.4 rpm per km/h, ± 1.5 %)', Math.abs(rpmPerKmh / 34.4 - 1) < 0.015, `${f(rpmPerKmh, 1)} rpm per km/h`);
}

console.log('\n== On flat ground');
const m = measureVf26(VF26_TUNED.make);
{
  // From rest the car is a little slow against a real one (some 2.6 s to 100 km/h): first gear runs to 110 km/h and the
  // MGU-K is held back under 100 km/h; the auto-clutch holds the engine at 7000 rpm off the line, where it has its
  // torque. From 100 to 200 km/h it takes 2.4 s, as they do
  check('0–100 km/h in 2.7 to 3.3 s, 0–200 in 5.0 to 5.8 s', between(m.accelS[100], 2.7, 3.3) && between(m.accelS[200], 5.0, 5.8), `${f(m.accelS[100])} s, ${f(m.accelS[200])} s`);
  check('Top speed with the wings closed 288 to 303 km/h', between(m.topSpeedKmh, 288, 303), `${f(m.topSpeedKmh, 0)} km/h`);
  // From a restart: the discs at the 250 °C they start with (hot and cold discs: "Carbon brakes" below)
  check('300–100 km/h in 80 to 92 m, peaking at 4.5 to 5.0 g on discs at 250 °C', between(m.brakeM, 80, 92) && between(m.brakePeakG, 4.5, 5.0), `${f(m.brakeM, 1)} m, ${f(m.brakePeakG)} g`);
  // Cornering: where the tune put it, ± 4 %
  const set = [2.05, 2.66, 3.21, 3.75, 4.18];
  VF26_AI_REFERENCE.lateral.forEach(([v], i) => {
    check(`Lateral g at ${f(v * 3.6, 0)} km/h within 4 % of ${f(set[i])}`, Math.abs(m.lateralG[i] / set[i] - 1) < 0.04, `${f(m.lateralG[i])} g`);
  });
  check('Steering for 1.5 g at 180 km/h 0.07 to 0.09 of lock', between(m.steerFor15G, 0.07, 0.09), f(m.steerFor15G, 3));
  check('A step of steering overshoots by under 10 %', m.stepOvershoot < 0.1, `${f(m.stepOvershoot * 100, 0)} %`);
  check('A lift in a 2.5 g corner: under 3° of slide', m.liftOffSlipDeg < 3, `${f(m.liftOffSlipDeg, 1)}°`);
}

console.log('\n== The braking line and target speed plan this car');
{
  // The planning model in the pad's sea-level air
  const pm = vf26TunedProfileCar(1.225);
  const G = 9.81;
  const plannedStop = (fromMs: number, toMs: number) => {
    let d = 0;
    for (let v = fromMs; v > toMs; v -= 0.05) {
      const grip = plannedMu(pm, pm.muLong, v) * (G + (plannedDownforceCoef(pm, v) * v * v) / pm.massKg);
      d += (v * 0.05) / (Math.min(grip, pm.maxBrakeForceN / pm.massKg) + (pm.dragCoef * v * v) / pm.massKg);
    }
    return d;
  };
  for (const [from, to] of [
    [300, 100],
    [200, 60],
  ]) {
    // A threshold stop: the pedal held where the most-slipping wheel sits at 7 %
    const sim = fresh(from);
    for (let t = 0; t < 0.5; t += H) sim.step(H, { throttle: 0.6 });
    const s0 = sim.sMeters;
    const v0 = sim.vxMs;
    let pedal = 1;
    for (let t = 0; t < 8 && sim.vxMs * 3.6 > to; t += H) {
      const slip = Math.max(...sim.telemetry.wheelSlipRatios.map((r) => Math.abs(r)));
      pedal = THREE.MathUtils.clamp(pedal + THREE.MathUtils.clamp((0.07 - slip) * 0.6, -0.02, 0.01), 0.2, 1);
      sim.step(H, { brake: pedal });
    }
    const driven = sim.sMeters - s0;
    const planned = plannedStop(v0, to / 3.6);
    check(`${f(v0 * 3.6, 0)}→${to} km/h is planned 0–15 % longer than the car stops`, planned >= driven && planned < driven * 1.15, `${f(planned, 1)} m planned, ${f(driven, 1)} m driven`);
  }
  const margins = VF26_AI_REFERENCE.lateral.map(([v], i) => {
    const planned = (plannedMu(pm, pm.muLat, v) * (G + (plannedDownforceCoef(pm, v) * v * v) / pm.massKg)) / G;
    return 1 - planned / m.lateralG[i];
  });
  check('Corners are planned 1 to 9 % under the g the car holds', margins.every((x) => x > 0.01 && x < 0.09), margins.map((x) => `${f(x * 100, 0)} %`).join(' / '));
}

console.log('\n== The other compounds, and steering from the keyboard');
{
  // Every compound's grip rises with temperature up to its peak: the cold side joins each compound's own curve
  const dips = Object.entries(C.tyreCompounds).filter(([, t]) => {
    const curve = t.thermalData.thermalPerformanceCurve;
    const peak = Math.max(...curve.map(([, g]) => g));
    const upTo = curve.findIndex(([, g]) => g === peak);
    return !curve.slice(0, upTo + 1).every(([, g], i, a) => i === 0 || g >= a[i - 1][1]);
  });
  check('Every compound gains grip with temperature up to its peak', dips.length === 0, dips.map(([k]) => k).join(', ') || `${Object.keys(C.tyreCompounds).length} compounds`);
  const lateral = (compound: 'soft' | 'medium' | 'hard', kmh: number) => {
    const sim = fresh(kmh);
    sim.tireCompound = compound;
    sim.teleportToDistance(2000, kmh / 3.6);
    const v = kmh / 3.6;
    const hist: number[] = [];
    let best = 0;
    const T = 12;
    for (let t = 0; t < T; t += 1 / 120) {
      sim.step(1 / 120, { throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (v - sim.vxMs), 0, 1), analogSteer: Math.min(1, t / T) * Math.min(1, (24 / v) ** 1.5) });
      hist.push(Math.abs(sim.telemetry.lateralG));
      if (hist.length > 120) hist.shift();
      if (hist.length === 120) best = Math.max(best, hist.reduce((a, b) => a + b, 0) / 120);
      if (Math.abs(Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs)))) > 0.35) break;
    }
    return best;
  };
  const g = (['soft', 'medium', 'hard'] as const).map((c) => [lateral(c, 86), lateral(c, 216)]);
  check('Medium and hard hold 2 to 5 % less than the compound above, slow and fast', [1, 2].every((i) => [0, 1].every((k) => between(g[i][k] / g[i - 1][k], 0.95, 0.98))), g.map((x) => x.map((y) => f(y)).join(' / ')).join('   '));

  // The keyboard's steering assist asks for what the car can hold: the key held down at 250 km/h
  const sim = fresh(250);
  const v = 250 / 3.6;
  let sum = 0;
  let n = 0;
  let bodySlipDeg = 0;
  for (let t = 0; t < 5; t += H) {
    sim.step(H, { throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (v - sim.vxMs), 0, 1), kbSteer: 1 });
    if (t > 3) {
      sum += Math.abs(sim.telemetry.lateralG);
      n++;
    }
    bodySlipDeg = Math.max(bodySlipDeg, (Math.abs(Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs)))) * 180) / Math.PI);
  }
  check('A steering key held at 250 km/h: the car at its limit, under 5° of slide', sum / n > 0.95 * m.lateralG[4] && bodySlipDeg < 5, `${f(sum / n)} g, ${f(bodySlipDeg, 1)}° of body slip`);

  // A mouse or pad turns the rack no faster than hands turn the 270° of rim lock on its 14:1 rack (900°/s)
  const steer = fresh(50);
  let tLock = NaN;
  for (let t = 0; t < 1 && Number.isNaN(tLock); t += H) {
    steer.step(H, { analogSteer: 1 });
    if (steer.steerAngleNorm >= 0.999) tLock = t + H;
  }
  check('Full lock from centre in 0.29–0.31 s (270° at 900°/s)', between(tLock, 0.29, 0.31), `${f(tLock, 3)} s`);
}

console.log('\n== Against 2026 qualifying laps, flat out');
{
  // Full deployment, the wings in their straight-line setting: flat out from 40 km/h under each speed, the mean g within
  // 5 km/h of it, leaving out the fifth of a second after a gear change. The laps: the best tenth of the full-throttle
  // seconds of eight pole-lap traces
  const straight = structuredClone(C) as typeof C;
  for (const w of straight.aero.wings ?? []) {
    if (!w.drs) continue;
    w.lutAOA_CL = w.lutAOA_CL.map(([x, y]) => [x, y * w.drs!.clMult]);
    w.lutAOA_CD = w.lutAOA_CD.map(([x, y]) => [x, y * w.drs!.cdMult]);
  }
  const laps: [number, number][] = [
    [160, 1.5],
    [200, 1.25],
    [240, 0.86],
    [280, 0.53],
  ];
  for (const [kmh, real] of laps) {
    const sim = fresh(kmh - 40, straight);
    sim.setLiveTuner({ ersMode: 'BAL' });
    let sum = 0;
    let n = 0;
    let gear = sim.telemetry.gear;
    let sinceShiftS = 0;
    for (let t = 0; t < 6 && sim.vxMs * 3.6 < kmh + 5; t += H) {
      sim.step(H, { throttle: 1 });
      sinceShiftS = sim.telemetry.gear === gear ? sinceShiftS + H : 0;
      gear = sim.telemetry.gear;
      if (Math.abs(sim.vxMs * 3.6 - kmh) <= 5 && sinceShiftS > 0.2) {
        sum += sim.telemetry.longitudinalG;
        n++;
      }
    }
    const g = sum / n;
    check(`${kmh} km/h: within 20 % of the laps' ${f(real)} g`, Math.abs(g / real - 1) < 0.2, `${f(g)} g`);
  }
}

console.log('\n== Up-shifts, and the throttle out of a corner');
{
  const rearSlip = (sim: F12026CarSim) => Math.max(sim.telemetry.wheelSlipRatios[2], sim.telemetry.wheelSlipRatios[3]);
  // One up-shift on a light pedal, well under the tyres' limit
  {
    const sim = fresh(100);
    sim.autoGearbox = false;
    for (let t = 0; t < 1.4; t += H) sim.step(H, { throttle: 0.3 });
    const slipBefore = rearSlip(sim);
    let gBefore = 0;
    let n = 0;
    for (let t = 0; t < 0.2; t += H, n++) {
      sim.step(H, { throttle: 0.3 });
      gBefore += sim.telemetry.longitudinalG;
    }
    gBefore /= n;
    let slipPeak = 0;
    let gPeak = -9;
    for (let t = 0, first = true; t < 0.5; t += H, first = false) {
      sim.step(H, { throttle: 0.3, shiftUp: first });
      slipPeak = Math.max(slipPeak, rearSlip(sim));
      gPeak = Math.max(gPeak, sim.telemetry.longitudinalG);
    }
    check('An up-shift on a light pedal: the rear wheels gain under 3 % of slip', sim.telemetry.gear === 2 && slipPeak - slipBefore < 0.03, `${f(slipBefore * 100, 1)} % → ${f(slipPeak * 100, 1)} %`);
    check('... and the car is pushed under 0.3 g harder than before it', gPeak - gBefore < 0.3, `${f(gBefore)} g → ${f(gPeak)} g at most`);
  }
  // Flat out through the gears from 95 km/h, no traction control: the slip from just before each change to its worst
  // in the eighth of a second after
  {
    const sim = fresh(95);
    for (let t = 0; t < 1; t += H) sim.step(H, { throttle: 0.2 });
    let gear = sim.telemetry.gear;
    let watchS = 0;
    let base = 0;
    let worst = 0;
    let rise = 0;
    let shifts = 0;
    for (let t = 0; t < 3; t += H) {
      const before = rearSlip(sim);
      sim.step(H, { throttle: 1 });
      if (sim.telemetry.gear !== gear) {
        gear = sim.telemetry.gear;
        watchS = 0.125;
        base = before;
        worst = before;
        shifts++;
      }
      if (watchS > 0) {
        watchS -= H;
        worst = Math.max(worst, rearSlip(sim));
        rise = Math.max(rise, worst - base);
      }
    }
    check('Flat out through the gears: no up-shift adds 6 % of slip', shifts >= 3 && rise < 0.06, `${shifts} shifts, ${f(rise * 100, 1)} % at most`);
  }
  // A 1.6 g corner at 100 km/h, then a pedal step, lifted to 15 % after; the box left to shift or held in second (where
  // the full pedal is more than the rear tyres carry); the steering held, or a driver steering against the slide and
  // its rate, 0.12 s late
  const exit = (throttle: number, holdS: number, driver: boolean, second = false) => {
    const sim = fresh(100);
    sim.autoGearbox = !second;
    const v = 100 / 3.6;
    let steer = 0;
    let shifted = false;
    for (let t = 0; t < 7; t += H) {
      if (Math.abs(sim.telemetry.lateralG) < 1.6) steer += 0.03 * H;
      const shiftUp: boolean = second && !shifted && t > 0.5;
      shifted = shifted || shiftUp;
      sim.step(H, { throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (v - sim.vxMs), 0, 1), analogSteer: steer, shiftUp });
    }
    const slide = () => (Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs))) * 180) / Math.PI;
    const b0 = slide();
    const late: number[] = [];
    let prev = b0;
    let peak = 0;
    for (let t = 0; t < holdS + 2; t += H) {
      const b = slide();
      late.push((b - b0) * 0.05 + ((b - prev) / H) * 0.004);
      prev = b;
      const against = driver ? late[Math.max(0, late.length - 1 - Math.round(0.12 / H))] : 0;
      sim.step(H, { throttle: t < holdS ? throttle : 0.15, analogSteer: THREE.MathUtils.clamp(steer - against, -1, 1) });
      peak = Math.max(peak, Math.abs(slide() - b0));
    }
    return { peak, end: Math.abs(slide() - b0) };
  };
  const part = exit(0.6, 0.5, false);
  check('60 % throttle out of a 1.6 g corner, the steering held: under 3° of slide', part.peak < 3, `${f(part.peak, 1)}°`);
  const full = exit(1, 0.4, true, true);
  check('Full throttle for 0.4 s there in second, then a lift and opposite lock: a slide of 2 to 15°, caught', between(full.peak, 2, 15) && full.end < 2, `${f(full.peak, 1)}° at most, ${f(full.end, 1)}° two seconds on`);
  const held = exit(1, 0.4, false, true);
  check('... and with the steering held it is a spin: the slide is the driver\'s to catch', held.peak > 25, `${f(held.peak, 0)}°`);
}

console.log('\n== A lift, in every gear');
{
  // Held at a speed in a gear, the store half full, then the pedals set: the mean deceleration and MGU-K power from
  // 0.3 s on, over 0.4 s
  const pedals = (mode: 'RAC' | 'LIC', kmh: number, gear: number, throttle: number, brake: number) => {
    const sim = fresh(kmh);
    sim.autoGearbox = false;
    sim.setLiveTuner({ ersMode: mode });
    const v = kmh / 3.6;
    const hold = () => THREE.MathUtils.clamp(0.3 + 0.6 * (v - sim.vxMs), 0.06, 1);
    for (let tries = 0; tries < 16 && sim.telemetry.gear !== gear; tries++) {
      const up = sim.telemetry.gear < gear;
      sim.step(H, { throttle: hold(), shiftUp: up, shiftDown: !up });
      for (let t = 0; t < 0.25; t += H) sim.step(H, { throttle: hold() });
    }
    for (let t = 0; t < 1.5; t += H) sim.step(H, { throttle: hold() });
    sim.vehicle.ersEnergyJ = 0.5 * C.ers.ERS_MAX_CHARGE;
    for (let t = 0; t < 0.3; t += H) sim.step(H, { throttle, brake });
    let g = 0;
    let kW = 0;
    let n = 0;
    for (let t = 0; t < 0.4; t += H, n++) {
      sim.step(H, { throttle, brake });
      g -= sim.telemetry.longitudinalG;
      kW -= sim.vehicle.telemetry.MGUK_POWER / 1000;
    }
    return { g: g / n, kW: kW / n, inGear: sim.telemetry.gear === gear };
  };
  // The lift-and-coast map recovers the most on a lift (90 kW), so a gear that recovered none would show there
  const gears = [5, 6, 7, 8].map((gear) => pedals('LIC', 200, gear, 0, 0));
  const kW = gears.map((x) => x.kW);
  const g = gears.map((x) => x.g);
  check('A lift at 200 km/h recovers the same power in fifth to eighth', gears.every((x) => x.inGear) && Math.max(...kW) - Math.min(...kW) < 2 && Math.min(...kW) > 80, kW.map((x) => `${f(x, 0)} kW`).join(' / '));
  check('... and slows the car alike in each, within 0.02 g', Math.max(...g) - Math.min(...g) < 0.02, g.map((x) => `${f(x, 3)} g`).join(' / '));
  const race = [5, 6, 7, 8].map((gear) => pedals('RAC', 200, gear, 0, 0).g);
  check('In the race map each gear up slows it a little less, eighth as the others', race.every((x, i) => i === 0 || (x < race[i - 1] && race[i - 1] - x < 0.03)), race.map((x) => `${f(x, 3)} g`).join(' / '));
  // The data's 900 Nm at the rear axle: at 80 km/h that is 53 kW, in whichever gear
  const slow = [1, 2, 3].map((gear) => pedals('LIC', 80, gear, 0, 0));
  check('At 80 km/h the rear axle is held back by 900 Nm, 53 kW, in first to third', slow.every((x) => x.inGear && between(x.kW, 50, 56)), slow.map((x) => `${f(x.kW, 0)} kW, ${f(x.g, 3)} g`).join(' / '));
  // From a part throttle through nothing to the brake, the car only ever slows more
  const sweep: [number, number][] = [
    [0.08, 0],
    [0.04, 0],
    [0.02, 0],
    [0, 0],
    [0, 0.04],
    [0, 0.06],
    [0, 0.1],
    [0, 0.2],
  ];
  const decel = sweep.map(([throttle, brake]) => pedals('LIC', 120, 3, throttle, brake).g);
  check('From 8 % throttle to 20 % brake in third at 120 km/h the car slows more at every step', decel.every((x, i) => i === 0 || x > decel[i - 1]), decel.map((x) => f(x)).join(' / '));
}

console.log('\n== Carbon brakes, by their temperature');
{
  // 300→100 km/h at the threshold (as the stop on flat ground above), the four discs set to one temperature first
  const stop = (discC: number) => {
    const sim = fresh(300);
    for (const w of sim.vehicle.wheels) w.brakeDisc.surfaceTempC = w.brakeDisc.coreTempC = discC;
    for (let t = 0; t < 0.5; t += H) sim.step(H, { throttle: 0.6 });
    const s0 = sim.sMeters;
    let pedal = 1;
    let peak = 0;
    for (let t = 0; t < 8 && sim.vxMs * 3.6 > 100; t += H) {
      const slip = Math.max(...sim.telemetry.wheelSlipRatios.map((r) => Math.abs(r)));
      pedal = THREE.MathUtils.clamp(pedal + THREE.MathUtils.clamp((0.07 - slip) * 0.6, -0.02, 0.01), 0.2, 1);
      sim.step(H, { brake: pedal });
      peak = Math.max(peak, -sim.telemetry.longitudinalG);
    }
    return { m: sim.sMeters - s0, peak };
  };
  const [cold, start, hot] = [100, 250, 450].map(stop);
  const row = (x: { m: number; peak: number }) => `${f(x.m, 1)} m, ${f(x.peak)} g`;
  check('300–100 km/h on discs at 450 °C peaks at 5.0 to 5.6 g', between(hot.peak, 5.0, 5.6), row(hot));
  check('... at the 250 °C the car starts with, 6 to 12 % under that', between(1 - start.peak / hot.peak, 0.06, 0.12), row(start));
  check('... and at 100 °C 15 to 25 % under it, over 4 to 9 m more road', between(1 - cold.peak / hot.peak, 0.15, 0.25) && between(cold.m - hot.m, 4, 9), row(cold));
}

console.log('\n== Fuel on board');
{
  // At rest on flat ground, the springs set for the load: the front axle's share of the weight on the four tyres
  const frontShare = (kg: number) => {
    const sim = fresh(0);
    sim.vehicle.setFuelMass(kg);
    sim.vehicle.refreshStaticGeometry();
    sim.teleportToDistance(2000, 0);
    for (let t = 0; t < 4; t += H) sim.step(H, { brake: 1 });
    const W = sim.vehicle.wheels;
    return (100 * (W[0].fz + W[1].fz)) / (W[0].fz + W[1].fz + W[2].fz + W[3].fz);
  };
  const share = [0, 40, 110].map(frontShare);
  check(
    'A full tank takes 0.4 to 0.8 point off the front axle\'s share of the weight',
    between(share[0] - share[2], 0.4, 0.8) && share[1] < share[0] && share[1] > share[2],
    share.map((x, i) => `${f(x)} % with ${[0, 40, 110][i]} kg`).join(', ')
  );
}

console.log('\n== Ride heights and downforce against speed');
{
  const at = (kmh: number) => {
    const sim = fresh(kmh);
    const v = kmh / 3.6;
    const acc = { front: 0, rear: 0, cla: 0 };
    let n = 0;
    for (let t = 0; t < 5; t += H) {
      sim.step(H, { throttle: THREE.MathUtils.clamp(0.5 + 0.6 * (v - sim.vxMs), 0, 1) });
      if (t > 3) {
        const tl = sim.telemetry;
        acc.front += (tl.wheelRideHeightsMm[0] + tl.wheelRideHeightsMm[1]) / 2;
        acc.rear += (tl.wheelRideHeightsMm[2] + tl.wheelRideHeightsMm[3]) / 2;
        acc.cla += tl.downforceN / (0.5 * tl.airDensityKgM3 * sim.vxMs * sim.vxMs);
        n++;
      }
    }
    return { front: acc.front / n, rear: acc.rear / n, cla: acc.cla / n };
  };
  const p = [150, 200, 250, 300].map((kmh) => ({ kmh, ...at(kmh) }));
  const row = p.map((x) => `${x.kmh}: ${f(x.front, 0)} / ${f(x.rear, 0)} mm, CL·A ${f(x.cla)}`).join('   ');
  console.log(`INFO  ${row}`);
  check('CL·A 5.0 or more from 150 to 250 km/h', p.slice(0, 3).every((x) => x.cla >= 5.0), p.slice(0, 3).map((x) => f(x.cla)).join(' / '));
  check('... and at 300 km/h still 88 % of its value at 200', p[3].cla >= 0.88 * p[1].cla, `${f(p[3].cla)} against ${f(p[1].cla)}`);
  check('At 300 km/h the front axle rides 18 mm or more off the road', p[3].front >= 18, `${f(p[3].front, 1)} mm`);
}

console.log('\n== Laps of Rwanda (autopilot)');
{
  const track = getActiveTrackData();
  const sim = createVf26Sim(track);
  sim.resetToStartGrid(true);
  sim.aiAutopilot = true;
  sim.aiPaceScale = 1;
  const lap0 = sim.telemetry.lapCount;
  let last = lap0;
  let maxSlipDeg = 0;
  let pastEdgeM = 0;
  let minFront = Infinity;
  let lapS = NaN;
  let grain = 0;
  let blister = 0;
  let coreSum = [0, 0, 0, 0];
  let psiSum = [0, 0, 0, 0];
  let lapCoreC = coreSum;
  let lapPsi = psiSum;
  let samples = 0;
  // The discs each time the pedal goes down on the last lap: the coolest and hottest front and rear (°C)
  const discC = { front: [Infinity, 0], rear: [Infinity, 0] };
  let offPedalS = 9;
  const LAPS = 4;
  for (let t = 0; t < 600 && sim.telemetry.lapCount < lap0 + LAPS + 1; t += 1 / 60) {
    sim.step(1 / 60, {});
    const onPedal = sim.vehicle.telemetry.brake > 0.3;
    if (onPedal && offPedalS > 1 && sim.telemetry.lapCount === lap0 + LAPS) {
      const W = sim.vehicle.wheels;
      for (const [axle, c] of [
        ['front', W[0].brakeDisc.surfaceTempC],
        ['rear', W[2].brakeDisc.surfaceTempC],
      ] as const) {
        discC[axle][0] = Math.min(discC[axle][0], c);
        discC[axle][1] = Math.max(discC[axle][1], c);
      }
    }
    offPedalS = onPedal ? 0 : offPedalS + 1 / 60;
    if (sim.telemetry.lapCount >= lap0 + 1) {
      maxSlipDeg = Math.max(maxSlipDeg, (Math.abs(Math.atan2(sim.vyMs, Math.max(5, Math.abs(sim.vxMs)))) * 180) / Math.PI);
      pastEdgeM = Math.max(pastEdgeM, Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
      minFront = Math.min(minFront, sim.telemetry.wheelRideHeightsMm[0], sim.telemetry.wheelRideHeightsMm[1]);
    }
    sim.vehicle.wheels.forEach((w, i) => {
      grain = Math.max(grain, w.grainLevel);
      blister = Math.max(blister, w.blisterLevel);
      coreSum[i] += w.coreTempC;
      psiSum[i] += w.pressurePsi;
    });
    samples++;
    if (sim.telemetry.lapCount !== last) {
      last = sim.telemetry.lapCount;
      lapS = (sim.telemetry.lastLapTimeMs ?? 0) / 1000;
      lapCoreC = coreSum.map((x) => x / samples);
      lapPsi = psiSum.map((x) => x / samples);
      coreSum = [0, 0, 0, 0];
      psiSum = [0, 0, 0, 0];
      samples = 0;
    }
  }
  const done = sim.telemetry.lapCount >= lap0 + LAPS + 1;
  console.log(`INFO  flying lap ${f(lapS)} s`);
  check('Four flying laps on the road, under 8° of body slip', done && pastEdgeM < 0.2 && maxSlipDeg < 8, `CG ${f(Math.max(0, pastEdgeM))} m past the edge, ${f(maxSlipDeg, 1)}° of slip`);
  check('The front axle never under 10 mm off the road', minFront >= 10, `${f(minFront, 1)} mm`);
  const soft = C.tyreCompounds.PhysicsTyreCompound_F1_Soft;
  const [lo, hi] = soft.thermalData.optimalTempC;
  const optF = soft.pressureData.optimalPsi;
  const optR = soft.rearOverride?.pressureData?.optimalPsi ?? optF;
  check(`Carcasses within 5 °C of the ${lo}–${hi} °C window over lap ${LAPS}`, lapCoreC.every((c) => c >= lo - 5 && c <= hi + 5), lapCoreC.map((c) => f(c, 0)).join(' / '));
  check(`Pressures within 1.5 psi of ${optF} / ${optR}`, lapPsi.every((p, i) => Math.abs(p - (i < 2 ? optF : optR)) <= 1.5), lapPsi.map((p) => f(p, 1)).join(' / '));
  check('No graining or blistering', grain < 0.1 && blister === 0, `grain ${f(grain)}, blister ${f(blister)}`);
  // At 200 °C the pads have 80 % of their grip; the rear discs, which the MGU-K leaves little to do, are the test
  check(
    `Every disc at 200 to 600 °C when the pedal goes down over lap ${LAPS}`,
    [discC.front, discC.rear].every(([coolest, hottest]) => coolest >= 200 && hottest <= 600),
    `front ${f(discC.front[0], 0)} to ${f(discC.front[1], 0)} °C, rear ${f(discC.rear[0], 0)} to ${f(discC.rear[1], 0)} °C`
  );
}

console.log('\n== Flat out from rest, by driver-aid preset');
{
  const flatOut = (preset: 'pro' | 'semi_pro' | 'assisted') => {
    const sim = fresh(0);
    sim.assistPreset = preset;
    let spunAtS = NaN;
    let to200S = NaN;
    for (let t = 0; t < 10; t += H) {
      sim.step(H, { throttle: 1 });
      const slipDeg = (Math.abs(Math.atan2(sim.vyMs, Math.max(3, Math.abs(sim.vxMs)))) * 180) / Math.PI;
      if (Number.isNaN(spunAtS) && (slipDeg > 25 || sim.vxMs < -1)) spunAtS = t;
      if (Number.isNaN(to200S) && sim.vxMs * 3.6 >= 200) to200S = t;
    }
    return { spunAtS, to200S };
  };
  for (const preset of ['assisted', 'semi_pro'] as const) {
    const r = flatOut(preset);
    check(`${preset}: runs straight to 200 km/h in under 7 s`, Number.isNaN(r.spunAtS) && r.to200S < 7, `${f(r.to200S)} s`);
  }
  // No traction control: the rears spin up and the car still runs straight
  const pro = flatOut('pro');
  check('pro (no traction control): runs straight to 200 km/h in under 7 s', Number.isNaN(pro.spunAtS) && pro.to200S < 7, Number.isNaN(pro.spunAtS) ? `${f(pro.to200S)} s` : `spins at ${f(pro.spunAtS, 1)} s`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll tuned VF26 checks passed.');
process.exit(failures.length ? 1 : 0);
