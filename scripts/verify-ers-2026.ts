/**
 * The 2026 F1 rules on the electrical energy (`src/lib/sim/f12026-car/ers-2026.ts`), as the FIA's 2026 Section C
 * (Issue 21) and Section B (Issue 09) have them, and the 2026 Prototype's energy management inside them:
 *
 * - the ERS-K's power against road speed (C5.2.8), with and without Overtake;
 * - the cuts with the driver flat out: 150 kW at once, then 100 kW a second while over 100 kW, none below 210 km/h,
 *   none given back in the period except by the Boost (C5.12.4 to C5.12.7);
 * - superclipping within the lap's recharge limit, 8.5 MJ (C5.2.10), and the store never run empty under power;
 * - no deployment from a standing start below 50 km/h (C5.2.12);
 * - on the car: 500 Nm at the crank (C5.2.11), the fixed 0.97 between the DC bus and the shaft (C5.2.21), the curve
 *   held on a straight, Overtake's curve in practice and in a race only with it earned, and no deploy limit a lap;
 * - issue #180: on Qiddiya the car deploys again out of the last corner (skipped without the circuit's files).
 *
 *   npx tsx scripts/verify-ers-2026.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { cutEnergyJ, Ers2026Control, ersKDeployLimitW, ersValueSPerMJ, F1_2026_ERS, type ErsStepInput } from '../src/lib/sim/f12026-car/ers-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { LC26_SIM_PROFILE } from '../src/lib/sim/f12026-car/Lc26Sim';
import { LC26_TUNED_CONFIG } from '../src/lib/sim/f12026-car/Lc26Tune';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { overtakingRulesForSeason } from '../src/lib/sim/overtaking-rules';
import { createFlatTestTrack } from './lib/flat-track';
import { loadGlbGeometry } from './lib/glb-geometry';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failures.push(name);
};
const f = (v: number, d = 1) => v.toFixed(d);
const kW = (w: number) => `${f(w / 1000)} kW`;

// ---------------------------------------------------------------------------
console.log('== The ERS-K\'s power against road speed (C5.2.8)');
{
  const n = (v: number) => ersKDeployLimitW(v, false);
  const o = (v: number) => ersKDeployLimitW(v, true);
  check('350 kW up to 290 km/h', n(0) === 350_000 && n(150) === 350_000 && n(290) === 350_000);
  check('1800 − 5v kW from 290 to 340 km/h (300 at 300, 100 at 340)', Math.abs(n(300) - 300_000) < 1e-6 && Math.abs(n(339.999) - 100_005) < 1);
  check('6900 − 20v kW from 340 to 345, nothing from 345', Math.abs(n(340) - 100_000) < 1e-6 && Math.abs(n(342.5) - 50_000) < 1e-6 && n(345) === 0 && n(360) === 0);
  check('Overtake: 350 kW up to 337.5 km/h', o(300) === 350_000 && o(337.5) === 350_000);
  check('Overtake: 7100 − 20v kW to nothing at 355 km/h', Math.abs(o(346) - 180_000) < 1e-6 && o(355) === 0 && o(400) === 0);
  let mono = true;
  for (let v = 0; v < 360; v += 0.5) mono &&= n(v + 0.5) <= n(v) && o(v + 0.5) <= o(v) && n(v) <= o(v);
  check('Both fall with speed, the normal curve never over Overtake\'s', mono);
}

// ---------------------------------------------------------------------------
console.log('\n== The control unit\'s cuts flat out (C5.12.4 to C5.12.7)');
const H = 1 / 500;
const base = (over: Partial<ErsStepInput> = {}): ErsStepInput => ({
  h: H,
  speedKmh: 250,
  throttle: 1,
  shifting: false,
  soc: 0.6,
  overtake: false,
  boost: false,
  share: 1,
  fillShare: 1,
  valueSPerMJ: 10,
  deployAboveSPerMJ: 1,
  superclipBelowSPerMJ: 0,
  superclipRoomJ: 0,
  ...over,
});
/** Run the control, feeding back the power it asked for as the store would give it */
function run(c: Ers2026Control, steps: number, over: Partial<ErsStepInput> | ((k: number) => Partial<ErsStepInput>)): number[] {
  const out: number[] = [];
  for (let k = 0; k < steps; k++) {
    const p = c.step(base(typeof over === 'function' ? over(k) : over));
    c.lastDcW = Math.max(0, p);
    out.push(p);
  }
  return out;
}
{
  const c = new Ers2026Control();
  const on = run(c, 50, {});
  check('Flat out and worth it: the whole of the curve', on.every((p) => Math.abs(p - 350_000) < 1e-6), kW(on[on.length - 1]));
  // The value drops under the bar at 250 km/h: the cut
  const cut = run(c, 1500, { valueSPerMJ: 0.5 });
  check('The cut: 150 kW at once', Math.abs(cut[0] - 200_000) < 1, `${kW(cut[0])} in the first step`);
  const at = (t: number) => cut[Math.round(t / H) - 1];
  check('... then 100 kW a second', Math.abs(at(0.5) - 150_000) < 500, `${kW(at(0.5))} 0.5 s on`);
  const zeroAt = cut.findIndex((p) => p <= 0) * H;
  check('... and the rest at once under 100 kW (≈ 1 s on)', Math.abs(zeroAt - 1.0) < 0.01, `${f(zeroAt, 3)} s`);
  let worstRate = 0;
  for (let k = 2; k < cut.length; k++) if (cut[k - 1] > F1_2026_ERS.limitFreeBelowW) worstRate = Math.max(worstRate, (cut[k - 1] - cut[k]) / H);
  check('Never faster than 100 kW a second while over 100 kW', worstRate <= 100_000 + 1, `${f(worstRate / 1000)} kW/s`);
  check('A power-limited period is under way', c.clipping);
  // Worth it again inside the same period: nothing given back (C5.12.5)
  const held = run(c, 200, { valueSPerMJ: 10 });
  check('Nothing given back inside the period (C5.12.5)', held.every((p) => p <= 0), kW(Math.max(...held)));
  // The Boost gives it back
  const boost = run(c, 5, { boost: true });
  check('... except by the Boost', Math.abs(boost[4] - 350_000) < 1e-6, kW(boost[4]));
  // Off the throttle the period ends; back flat out the deployment is there again
  run(c, 5, { throttle: 0.5, valueSPerMJ: 10 });
  const again = run(c, 5, { valueSPerMJ: 10 });
  check('A lift ends the period: on the throttle again it deploys', Math.abs(again[4] - 350_000) < 1e-6 && !c.clipping, kW(again[4]));

  const slow = new Ers2026Control();
  run(slow, 20, { speedKmh: 180 });
  const slowCut = run(slow, 3, { speedKmh: 180, valueSPerMJ: 0.5 });
  check('Below 210 km/h the cut is at once', slowCut[0] === 0, kW(slowCut[0]));
  const shift = new Ers2026Control();
  run(shift, 20, {});
  const shiftCut = run(shift, 3, { shifting: true, valueSPerMJ: 0.5 });
  check('In a gearshift the cut is at once', shiftCut[0] === 0, kW(shiftCut[0]));
  // The speed curve's own fall is not a cut of the control unit's: it follows the curve at once
  const curve = new Ers2026Control();
  run(curve, 20, { speedKmh: 300 });
  const up = run(curve, 3, { speedKmh: 330 });
  check('The speed curve\'s fall takes effect at once (C5.12.7)', Math.abs(up[0] - ersKDeployLimitW(330, false)) < 1e-6 && !curve.clipping, kW(up[0]));
}

// ---------------------------------------------------------------------------
console.log('\n== Superclipping, the store, the start');
{
  const c = new Ers2026Control();
  run(c, 20, {});
  // Worth little and the room there: the cut, then the harvest
  const sc = run(c, 1500, { valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 1e9 });
  const firstHarvest = sc.findIndex((p) => p < 0);
  check('Superclipping starts only once the cut is done', firstHarvest > 0 && sc.slice(0, firstHarvest).every((p) => p >= 0), `${f(firstHarvest * H, 3)} s`);
  check('... at 350 kW of DC power (the Miami 2026 figure)', Math.abs(sc[sc.length - 1] + 350_000) < 1e-6, kW(sc[sc.length - 1]));
  const capped = run(c, 2, { valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 100 });
  check('... never past the room the recharge limit leaves', Math.abs(capped[0] * H + 100) < 1e-6, `${f(-capped[0] * H, 0)} J in the step`);
  const none = run(c, 2, { valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 0 });
  check('... and none with no room left', none.every((p) => p === 0));

  const low = new Ers2026Control();
  const empty = run(low, 3, { soc: (cutEnergyJ(350_000) - 1) / F1_2026_ERS.storeJ });
  check('Never deploys from a store too low to cut at the rules\' rates', empty.every((p) => p === 0), `under ${f(cutEnergyJ(350_000) / 1000, 0)} kJ`);
  const ok = run(new Ers2026Control(), 3, { soc: (cutEnergyJ(350_000) + 1000) / F1_2026_ERS.storeJ });
  check('... and does with that much', ok[0] > 0, kW(ok[0]));

  const st = new Ers2026Control();
  st.armStandingStart();
  const slow = run(st, 5, { speedKmh: 40, throttle: 1 });
  const fast = run(st, 5, { speedKmh: 55, throttle: 1 });
  check('From a standing start, no deployment below 50 km/h (C5.2.12)', slow.every((p) => p === 0) && fast[4] > 0, `${kW(slow[4])} at 40, ${kW(fast[4])} at 55`);
  check('What a joule buys falls with speed and with the brakes near', ersValueSPerMJ(40, 800, 800) > ersValueSPerMJ(80, 800, 800) && ersValueSPerMJ(80, 800, 800) > ersValueSPerMJ(80, 100, 800) && ersValueSPerMJ(80, Infinity, 800) === Infinity);
}

// ---------------------------------------------------------------------------
console.log('\n== On the 2026 Prototype');
const ers = LC26_TUNED_CONFIG.ers;
{
  check('Under the 2026 rules', ers.regulations === 'f1-2026');
  check('4 MJ store, 8.5 MJ recharge a lap, no deploy limit a lap', ers.ERS_MAX_CHARGE === 4e6 && ers.harvestPerLapJ === 8.5e6 && ers.deployPerLapJ === Number.POSITIVE_INFINITY);
  check('0.97 between the DC bus and the shaft (C5.2.21)', ers.deployEfficiency === 0.97 && ers.harvestEfficiency === 0.97);
  const maxNm = Math.max(...ers.torqueLut.map(([, nm]) => nm), ...ers.coastLut.map(([, nm]) => nm));
  check('500 Nm at the crank, both ways (C5.2.11)', maxNm <= 500 + 1e-9, `${f(maxNm)} Nm`);
}
const pad = createFlatTestTrack(60_000, 3000);
function flatOut(opts: { mode: string; racing: boolean; fromKmh: number; toKmh: number }) {
  const sim = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
  sim.assistPreset = 'pro';
  sim.autoGearbox = true;
  sim.raceControl = opts.racing ? { racing: true, earnedAtDetection: () => false } : null;
  sim.teleportToDistance(2000, opts.fromKmh / 3.6);
  sim.setLiveTuner({ ersMode: opts.mode });
  const v = sim.vehicle;
  let worstOver = -Infinity;
  let worstNm = 0;
  const samples: { kmh: number; dc: number; cap: number }[] = [];
  for (let t = 0; t < 40 && sim.vxMs * 3.6 < opts.toKmh; t += 1 / 240) {
    sim.step(1 / 240, { throttle: 1 });
    v.ersEnergyJ = 3e6; // a store kept up: the curve, not the charge, is under test
    const kmh = sim.vxMs * 3.6;
    const dc = Math.max(0, v.telemetry.MGUK_POWER) / ers.deployEfficiency;
    const cap = ersKDeployLimitW(kmh, v.ersOvertake);
    worstOver = Math.max(worstOver, dc - cap);
    worstNm = Math.max(worstNm, Math.abs(v.telemetry.MGUK_POWER) / Math.max(1, v.engineOmega));
    samples.push({ kmh, dc, cap });
  }
  return { worstOver, worstNm, samples, overtake: v.ersOvertake, topKmh: sim.vxMs * 3.6 };
}
{
  // Practice: Overtake's curve all the time (B7.2.3 b)
  const p = flatOut({ mode: 'PSH', racing: false, fromKmh: 150, toKmh: 336 });
  check('Practice: Overtake\'s curve all the time (B7.2.3 b)', p.overtake);
  // Within 0.1 kW: the motor's torque is set at the start of each 2 ms step, sized on the engine speed it will end at
  check('... the deployment never over it, the motor never over 500 Nm', p.worstOver <= 100 && p.worstNm <= 500 + 1e-6, `${f(p.worstOver / 1000, 2)} kW over at worst, ${f(p.worstNm)} Nm`);
  const near = p.samples.filter((s) => s.kmh > 200 && s.kmh < 330);
  const held = near.filter((s) => s.dc >= 0.97 * s.cap).length / Math.max(1, near.length);
  check('... and held at it, 200 to 330 km/h in Attack', held > 0.9, `${f(held * 100, 0)} % of the time`);
  // A race without Overtake earned: the normal curve
  const r = flatOut({ mode: 'PSH', racing: true, fromKmh: 250, toKmh: 345 });
  const over300 = r.samples.filter((s) => s.kmh > 300);
  check('A race, Overtake not earned: the normal curve (300 kW at 300 km/h)', !r.overtake && r.worstOver <= 100 && over300.length > 0 && over300.every((s) => s.dc <= ersKDeployLimitW(s.kmh, false) + 100), `${f(r.worstOver / 1000, 2)} kW over at worst, top ${f(r.topKmh, 0)} km/h`);
}
{
  // A lap's deployment is not capped: flat out on the pad with the store kept up, well past the old 9 MJ
  const sim = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
  sim.assistPreset = 'pro';
  sim.teleportToDistance(2000, 150 / 3.6);
  sim.setLiveTuner({ ersMode: 'PSH' });
  sim.vehicle.ersEnergyJ = 4e6;
  let deployed = 0;
  for (let t = 0; t < 40; t += 1 / 240) {
    sim.step(1 / 240, { throttle: 1 });
    deployed += (Math.max(0, sim.vehicle.telemetry.MGUK_POWER) / ers.deployEfficiency) * (1 / 240);
    sim.vehicle.ersEnergyJ = 4e6;
  }
  check('No deploy limit a lap (only the store and the recharge limit)', deployed > 9.5e6, `${f(deployed / 1e6, 2)} MJ deployed in 40 s without a lap line`);
}

// ---------------------------------------------------------------------------
console.log('\n== Issue #180: Qiddiya, out of the last corner');
{
  const dataPath = 'public/tracks/qiddiya/track_data.json';
  if (!existsSync(dataPath)) {
    console.log(`SKIP  Qiddiya laps (${dataPath} not in this checkout)`);
  } else {
    setActiveTrack('qiddiya', JSON.parse(readFileSync(dataPath, 'utf8')) as RawTrackJson);
    const track = getActiveTrackData(1200);
    const L = track.totalLengthM;
    const car = vehicleModelSpec('lc26').createSim(track, loadGlbGeometry(`public${track.meshUrl}`)) as F12026CarSim;
    car.setOvertakingRules?.(overtakingRulesForSeason(2026));
    car.resetToStartGrid(true);
    car.aiAutopilot = true;
    car.aiPaceScale = 1;
    const v = car.vehicle;
    const H2 = 1 / 120;
    let lap = 0;
    let prevS = car.sMeters;
    let deployAfterHairpinJ = 0;
    let harvestJ = 0;
    let lapHarvestPeak = 0;
    let superclipS = 0;
    let emptyFlatS = 0;
    for (let t = 0; t < 900 && lap < 3; t += H2) {
      car.step(H2, { throttle: 0, brake: 0 });
      const s = car.sMeters;
      if (s < prevS - L / 2) lap++;
      prevS = s;
      lapHarvestPeak = Math.max(lapHarvestPeak, v.lapHarvestJ);
      if (lap < 2) continue;
      const p = v.telemetry.MGUK_POWER;
      // The final hairpin's exit onto the main straight (≈ 7.5 to 8.1 km)
      if (s > 7500 && s < 8100 && p > 0) deployAfterHairpinJ += (p / ers.deployEfficiency) * H2;
      if (p < 0) harvestJ -= p * ers.harvestEfficiency * H2;
      if (p < 0 && (car.telemetry.throttle ?? 0) > 0.9) superclipS += H2;
      if (v.ersEnergyJ < 1 && (car.telemetry.throttle ?? 0) > 0.95 && car.vxMs > 60) emptyFlatS += H2;
    }
    check('The car deploys out of the last corner (#180)', deployAfterHairpinJ > 0.8e6, `${f(deployAfterHairpinJ / 1e6, 2)} MJ from 7.5 to 8.1 km`);
    check('The lap\'s recharge never over 8.5 MJ (C5.2.10)', lapHarvestPeak <= 8.5e6 + 1, `${f(lapHarvestPeak / 1e6, 3)} MJ at most`);
    check('Superclipping a few seconds a lap, not whole straights', superclipS > 1 && superclipS < 10, `${f(superclipS)} s on the third lap`);
    check('The store never runs empty under power', emptyFlatS < 0.05, `${f(emptyFlatS, 2)} s`);
    void harvestJ;
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll 2026 ERS checks passed.');
