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
import { createVf26Sim, VF26_SIM_PROFILE } from '../src/lib/sim/f12026-car/Vf26Sim';
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
  check('0–100 km/h in 3.2 to 3.9 s, 0–200 in 5.3 to 6.2 s', between(m.accelS[100], 3.2, 3.9) && between(m.accelS[200], 5.3, 6.2), `${f(m.accelS[100])} s, ${f(m.accelS[200])} s`);
  check('Top speed with the wings closed 295 to 310 km/h', between(m.topSpeedKmh, 295, 310), `${f(m.topSpeedKmh, 0)} km/h`);
  check('300–100 km/h in 80 to 92 m, peaking at 5.0 to 5.6 g', between(m.brakeM, 80, 92) && between(m.brakePeakG, 5.0, 5.6), `${f(m.brakeM, 1)} m, ${f(m.brakePeakG)} g`);
  // Cornering: where the tune put it, ± 4 %
  const set = [2.05, 2.66, 3.21, 3.75, 4.18];
  VF26_AI_REFERENCE.lateral.forEach(([v], i) => {
    check(`Lateral g at ${f(v * 3.6, 0)} km/h within 4 % of ${f(set[i])}`, Math.abs(m.lateralG[i] / set[i] - 1) < 0.04, `${f(m.lateralG[i])} g`);
  });
  check('Steering for 1.5 g at 180 km/h 0.07 to 0.09 of lock', between(m.steerFor15G, 0.07, 0.09), f(m.steerFor15G, 3));
  check('A step of steering overshoots by under 10 %', m.stepOvershoot < 0.1, `${f(m.stepOvershoot * 100, 0)} %`);
  check('A lift in a 2.5 g corner: under 3° of slide', m.liftOffSlipDeg < 3, `${f(m.liftOffSlipDeg, 1)}°`);
}

console.log('\n== Against 2026 qualifying laps, flat out');
{
  // Full deployment, the wings in their straight-line setting: the car a little under each speed, 0.6 s to settle,
  // then the mean over 0.4 s. The laps: the best tenth of the full-throttle seconds of eight pole-lap traces
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
    const sim = fresh(kmh - 8, straight);
    sim.setLiveTuner({ ersMode: 'BAL' });
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 1; t += H) {
      sim.step(H, { throttle: 1 });
      if (t >= 0.6) {
        sum += sim.telemetry.longitudinalG;
        n++;
      }
    }
    const g = sum / n;
    check(`${kmh} km/h: within 20 % of the laps' ${f(real)} g`, Math.abs(g / real - 1) < 0.2, `${f(g)} g`);
  }
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
  const LAPS = 4;
  for (let t = 0; t < 600 && sim.telemetry.lapCount < lap0 + LAPS + 1; t += 1 / 60) {
    sim.step(1 / 60, {});
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
  // No traction control: the pedal flat from rest holds the rears past their peak. Reported, not asserted
  const pro = flatOut('pro');
  console.log(`INFO  pro (no traction control), pedal flat from rest: ${Number.isNaN(pro.spunAtS) ? `runs straight, 200 km/h in ${f(pro.to200S)} s` : `spins at ${f(pro.spunAtS, 1)} s`}`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll tuned VF26 checks passed.');
process.exit(failures.length ? 1 : 0);
