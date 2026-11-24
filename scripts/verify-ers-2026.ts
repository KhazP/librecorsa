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
 * - the race's Boost (its power when pressed, or 150 kW), Overtake's lines and the Automatic Overtake's share;
 * - Low Grip Conditions (the wet): race control's call, Overtake off, the Boost holding only, reset sectors;
 * - each circuit's rules: the FIA's 2026 Power Unit Information for Monaco and the Red Bull Ring, derived elsewhere;
 * - issue #180: on Qiddiya the car deploys again out of the last corner (skipped without the circuit's files).
 *
 *   npx tsx scripts/verify-ers-2026.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  BOOST_RAMP_WPS,
  CUT_ENERGY_MARGIN_J,
  cutEnergyJ,
  DEPLOY_THROTTLE_START,
  Ers2026Control,
  ersKDeployLimitW,
  ersValueSPerMJ,
  F1_2026_ERS,
  maxSafeDeployW,
  type ErsStepInput,
} from '../src/lib/sim/f12026-car/ers-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { LC26_SIM_PROFILE } from '../src/lib/sim/f12026-car/Lc26Sim';
import { LC26_TUNED_CONFIG } from '../src/lib/sim/f12026-car/Lc26Tune';
import { getActiveTrackData, RWANDA_DRS_ZONES, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { f1EnergyCircuit, inStretch } from '../src/lib/sim/f1-energy-circuits';
import { straightModeWindows } from '../src/lib/sim/straight-mode-zones';
import { lowGripCall, recommendedCompound } from '../src/lib/sim/wet-tyres';
import { TrackEnvironment } from '../src/lib/sim/track-environment';
import { DEFAULT_SESSION_CONDITIONS } from '../src/lib/sim/weather';
import { ersButtons } from '../src/components/hud/ers-buttons';
import type { CarTelemetry } from '../src/types/f1';
import { OvertakeGrant } from '../src/lib/sim/overtaking-rules';
import { createSimHost, loopbackTransport } from '../src/lib/sim/runtime/sim-host';
import { parsePlayerSettings } from '../src/lib/settings/player-settings';
import { DEFAULT_KEY_BINDINGS, PAD_LAYOUTS, RETIRED_FORMULA_STYLE_BUTTONS, GT_STYLE_BUTTONS } from '../src/lib/input/bindings';
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
  overtakeShare: 1,
  curves: 'base',
  alt1Sector: false,
  cutStepW: 150_000,
  cutRateWps: 100_000,
  resetSector: false,
  boost: false,
  boostCapped: false,
  boostHoldOnly: false,
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
  // Already flat out in Power Limited (PL): mid-straight cut ramps smoothly at C5.12.6's 100 kW/s (no -150 kW cliff)
  // down to 100 kW (2.5 s), then drops cleanly to 0 W (C5.12.7)
  const cut = run(c, 1500, { valueSPerMJ: 0.5 });
  check('Mid-straight PL cut: no 150 kW cliff, starts smoothly at 100 kW/s (C5.12.6)', Math.abs(cut[0] - (350_000 - 100_000 * H)) < 1, `${kW(cut[0])} in the first step`);
  const at = (t: number) => cut[Math.round(t / H) - 1];
  check('... linear 100 kW/s down to 100 kW', Math.abs(at(1.0) - 250_000) < 500 && Math.abs(at(2.0) - 150_000) < 500, `${kW(at(1.0))} at 1.0 s, ${kW(at(2.0))} at 2.0 s`);
  const zeroAt = cut.findIndex((p) => p <= 0) * H;
  check('... and the rest at once under 100 kW (≈ 2.5 s on)', Math.abs(zeroAt - 2.5) < 0.01, `${f(zeroAt, 3)} s`);
  let worstRate = 0;
  for (let k = 1; k < cut.length; k++) if (cut[k - 1] > F1_2026_ERS.limitFreeBelowW) worstRate = Math.max(worstRate, (cut[k - 1] - cut[k]) / H);
  check('Never faster than 100 kW a second while over 100 kW', worstRate <= 100_000 + 1, `${f(worstRate / 1000)} kW/s`);
  check('A power-limited period is under way', c.clipping);

  // Circuits over 3.5 km power-limited (50 kW/s C5.12.6 rate): 350 → 100 → 0 kW takes 5.0 s
  const slowRate = new Ers2026Control();
  run(slowRate, 50, { cutRateWps: 50_000 });
  const slowRamp = run(slowRate, 2600, { cutRateWps: 50_000, valueSPerMJ: 0.5 });
  const slowZeroAt = slowRamp.findIndex((p) => p <= 0) * H;
  check('50 kW/s power-limited circuit ramps 350 → 100 → 0 kW in ≈ 5.0 s (C5.12.6)', Math.abs(slowZeroAt - 5.0) < 0.02, `${f(slowZeroAt, 3)} s`);

  // Fresh full-throttle entry at >= 210 km/h (Power Limited Pending, C5.12.4): max 150 kW initial drop held fixed for 1 s, then 100 kW/s
  const plp = new Ers2026Control();
  run(plp, 20, { throttle: 0.5 });
  const plpCut = run(plp, 1200, { throttle: 1, valueSPerMJ: 0.5 });
  const plpAt = (t: number) => plpCut[Math.round(t / H) - 1];
  const plpZero = plpCut.findIndex((p) => p <= 0) * H;
  check('PLP start on fresh full throttle: 150 kW initial step held fixed 1 s, then 100 kW/s (C5.12.4)',
    Math.abs(plpCut[0] - 200_000) < 1 && Math.abs(plpAt(0.5) - 200_000) < 1 && Math.abs(plpAt(1.0) - 200_000) < 1 && Math.abs(plpAt(1.5) - 150_000) < 500 && Math.abs(plpZero - 2.0) < 0.01,
    `step0 ${kW(plpCut[0])}, 1.0 s ${kW(plpAt(1.0))}, 1.5 s ${kW(plpAt(1.5))}, zero ${f(plpZero, 3)} s`);

  // Starting PLP below 250 kW still respects C5.12.4's max 150 kW step + 1 s hold (never snaps straight to 0 on tick 0)
  const midCut = new Ers2026Control();
  run(midCut, 20, { throttle: 0.5, share: 220_000 / 350_000 });
  const sub250 = run(midCut, 600, { throttle: 1, share: 220_000 / 350_000, valueSPerMJ: 0.5 });
  check('PLP starting below 250 kW holds after 150 kW step for 1 s (C5.12.4)', Math.abs(sub250[0] - 70_000) < 1 && Math.abs(sub250[499] - 70_000) < 1 && sub250[502] === 0, `${kW(sub250[0])} → ${kW(sub250[499])} → ${kW(sub250[502])}`);

  // Worth it again inside the same period: nothing given back (C5.12.5)
  const held = run(c, 200, { valueSPerMJ: 10 });
  check('Nothing given back inside the period (C5.12.5)', held.every((p) => p <= 0), kW(Math.max(...held)));
  // The Boost gives it back smoothly at BOOST_RAMP_WPS (2000 kW/s: 0 → 350 kW in 0.175 s)
  const boost = run(c, 100, { boost: true });
  check('... except by the Boost, ramping cleanly at 2000 kW/s', Math.abs(boost[0] - BOOST_RAMP_WPS * H) < 1 && Math.abs(boost[99] - 350_000) < 1e-6, `step0 ${kW(boost[0])}, 0.2 s ${kW(boost[99])}`);
  // Off the throttle the period ends; back flat out the deployment is there again
  run(c, 5, { throttle: 0.5, valueSPerMJ: 10 });
  const again = run(c, 5, { valueSPerMJ: 10 });
  check('A lift ends the period: on the throttle again it deploys', Math.abs(again[4] - 350_000) < 1e-6 && !c.clipping, kW(again[4]));

  // Normal deploy blends in smoothly above DEPLOY_THROTTLE_START (60 % pedal); Boost deploys from any positive pedal
  const pedal = new Ers2026Control();
  const p50 = run(pedal, 5, { throttle: 0.5 })[4];
  const p80 = run(pedal, 5, { throttle: 0.8 })[4];
  const p50Boost = run(pedal, 5, { throttle: 0.5, boost: true })[4];
  const expect80 = 350_000 * ((0.8 - DEPLOY_THROTTLE_START) / (1 - DEPLOY_THROTTLE_START));
  check('Normal MGU-K deploy starts above 60 % throttle; Boost deploys from any positive throttle',
    p50 === 0 && Math.abs(p80 - expect80) < 1 && Math.abs(p50Boost - 175_000) < 1,
    `50%: ${kW(p50)}, 80%: ${kW(p80)}, 50%+Boost: ${kW(p50Boost)}`);

  const slow = new Ers2026Control();
  run(slow, 20, { speedKmh: 180 });
  const slowCut = run(slow, 3, { speedKmh: 180, valueSPerMJ: 0.5 });
  check('Below 210 km/h the cut is at once', slowCut[0] === 0, kW(slowCut[0]));
  const shift = new Ers2026Control();
  run(shift, 20, {});
  const shiftCut = run(shift, 3, { shifting: true, valueSPerMJ: 0.5 });
  const afterShift = run(shift, 5, { shifting: false, valueSPerMJ: 10 });
  check('In a gearshift the cut is at once, and keeps the limited period (C5.12.5 / C5.12.7)', shiftCut[0] === 0 && shift.clipping && afterShift.every((p) => p <= 0), kW(shiftCut[0]));
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
  // Worth little and the room there: the PL cut (2.5 s), then smooth ramp into superclipping (to 350 kW)
  const sc = run(c, 1750, { valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 1e9 });
  const firstHarvest = sc.findIndex((p) => p < 0);
  check('Superclipping starts only once the cut is done', firstHarvest > 0 && sc.slice(0, firstHarvest).every((p) => p >= 0), `${f(firstHarvest * H, 3)} s`);
  check('... ramps smoothly instead of jumping straight to −350 kW', Math.abs(sc[firstHarvest]) < 5_000 && Math.abs(sc[sc.length - 1] + 350_000) < 1e-6, `step 0: ${kW(sc[firstHarvest])}, end: ${kW(sc[sc.length - 1])}`);
  const capped = run(c, 2, { valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 100 });
  check('... never past the room the recharge limit leaves', Math.abs(capped[0] * H + 100) < 1e-6, `${f(-capped[0] * H, 0)} J in the step`);
  const none = run(c, 2, { valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 0 });
  check('... and none with no room left', none.every((p) => p === 0));

  // No 210 km/h superclipping chatter: dropping below 210 km/h while superclipping inhibits re-entry until a lift
  const ch = new Ers2026Control();
  run(ch, 20, { speedKmh: 260 });
  run(ch, 1500, { speedKmh: 260, valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 1e9 });
  const dip = run(ch, 5, { speedKmh: 209, valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 1e9 });
  const rebound = run(ch, 20, { speedKmh: 250, valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 1e9 });
  check('No 210 km/h chatter: dipping under 210 km/h inhibits superclipping until a lift', dip.every((p) => p === 0) && rebound.every((p) => p === 0), `rebound ${kW(rebound[19])}`);

  // Continuous low-SOC safe envelope (`maxSafeDeployW`): usable charge down to 20 kJ (0.5 % SOC) deploys smoothly
  // along the C5.12.6 deceleration parabola with fillCeilingW bounded to match, never snapping to 0 J
  const expect100kJ = maxSafeDeployW(100_000);
  const lbCtrl = new Ers2026Control();
  const lowBoost = run(lbCtrl, 100, { soc: 100_000 / F1_2026_ERS.storeJ, valueSPerMJ: 0.1, boost: true });
  check('Low-SOC Boost tracks maxSafeDeployW(100 kJ) with fillCeilingW also capped', Math.abs(lowBoost[99] - expect100kJ) < 1 && lbCtrl.fillCeilingW <= expect100kJ + 1, `${kW(lowBoost[99])}, fill ${kW(lbCtrl.fillCeilingW)}`);
  // Draining under full-cut reserve below 210 km/h must not block Low-SOC Boost above 210 km/h
  const sub210 = new Ers2026Control();
  run(sub210, 10, { speedKmh: 180, soc: 0.5 });
  run(sub210, 10, { speedKmh: 180, soc: 350_000 / F1_2026_ERS.storeJ });
  const sub210Boost = run(sub210, 100, { speedKmh: 240, soc: 350_000 / F1_2026_ERS.storeJ, valueSPerMJ: 0.1, boost: true });
  check('Draining below 210 km/h does not block Low-SOC Boost above 210 km/h', Math.abs(sub210Boost[99] - maxSafeDeployW(350_000)) < 1, kW(sub210Boost[99]));
  for (const [label, over] of [
    ['310 km/h normal (250 kW, 100 kW/s)', { speedKmh: 310, cutRateWps: 100_000 }],
    ['320 km/h normal (200 kW, 100 kW/s)', { speedKmh: 320, cutRateWps: 100_000 }],
    ['260 km/h Alt 1 (250 kW, 100 kW/s)', { speedKmh: 260, alt1Sector: true, cutRateWps: 100_000 }],
    ['260 km/h 50 kW/s circuit', { speedKmh: 260, cutRateWps: 50_000 }],
  ] as const) {
    const dc = new Ers2026Control();
    let eJ = 0.2 * F1_2026_ERS.storeJ;
    let minE = eJ;
    let prevP = 0;
    let prevCap = 0;
    let worstDropRate = 0;
    for (let k = 0; k < 4500; k++) {
      const p = dc.step(base({ soc: eJ / F1_2026_ERS.storeJ, boost: true, valueSPerMJ: 0.1, ...over }));
      const capNow = ersKDeployLimitW(over.speedKmh, false, 'base', Boolean('alt1Sector' in over && over.alt1Sector && (k + 1) * H >= 1));
      // C5.12.7: rate limit applies while above 100 kW and not caused by a C5.2.8 speed-curve drop (e.g. Alt 1 at 1 s)
      if (k > 0 && capNow >= prevCap && prevP > F1_2026_ERS.limitFreeBelowW + over.cutRateWps * H && p < prevP) {
        worstDropRate = Math.max(worstDropRate, (prevP - p) / H);
      }
      prevP = p;
      prevCap = capNow;
      dc.lastDcW = Math.max(0, p);
      eJ = Math.max(0, eJ - Math.max(0, p) * H);
      minE = Math.min(minE, eJ);
    }
    check(`Continuous Boost drain at ${label} stays >= 15 kJ & <= rate`, minE >= 15_000 && worstDropRate <= over.cutRateWps + 500, `min ${f(minE / 1000, 1)} kJ, max rate ${f(worstDropRate / 1000, 1)} kW/s`);
  }

  const low = new Ers2026Control();
  const empty = run(low, 3, { soc: (CUT_ENERGY_MARGIN_J - 1) / F1_2026_ERS.storeJ });
  check('Never deploys at or below the 20 kJ safety floor', empty.every((p) => p === 0), `under ${f(CUT_ENERGY_MARGIN_J / 1000, 0)} kJ`);
  const ok = run(new Ers2026Control(), 3, { soc: (cutEnergyJ(350_000) + 1000) / F1_2026_ERS.storeJ });
  check('... and deploys full 350 kW once above cutEnergyJ(350 kW)', Math.abs(ok[0] - 350_000) < 1, kW(ok[0]));

  const st = new Ers2026Control();
  st.armStandingStart();
  const slow = run(st, 5, { speedKmh: 40, throttle: 1 });
  const fast = run(st, 5, { speedKmh: 55, throttle: 1 });
  check('From a standing start, no deployment below 50 km/h (C5.2.12)', slow.every((p) => p === 0) && fast[4] > 0, `${kW(slow[4])} at 40, ${kW(fast[4])} at 55`);
  check('What a joule buys falls with speed and with the brakes near', ersValueSPerMJ(40, 800, 800) > ersValueSPerMJ(80, 800, 800) && ersValueSPerMJ(80, 800, 800) > ersValueSPerMJ(80, 100, 800) && ersValueSPerMJ(80, Infinity, 800) === Infinity);
}

// ---------------------------------------------------------------------------
console.log('\n== The other curves: Monaco\'s Rev 1, the race\'s 250 kW (C5.2.8 iii)');
{
  const r = (v: number, ot = false) => ersKDeployLimitW(v, ot, 'rev1');
  check('Rev 1: 350 kW to 200 km/h, 1050 − 3.5v, nothing from 300', r(200) === 350_000 && Math.abs(r(250) - 175_000) < 1e-6 && r(300) === 0);
  check('Rev 1 with Overtake: 750 − 2v to 150 kW at 300, nothing from 310', Math.abs(r(250, true) - 250_000) < 1e-6 && Math.abs(r(300, true) - 150_000) < 1e-6 && Math.abs(r(305, true) - 75_000) < 1e-6 && r(310, true) === 0);
  const a = (v: number) => ersKDeployLimitW(v, false, 'base', true);
  check('Alt 1: 250 kW to 310 km/h, then the normal curve', a(100) === 250_000 && a(309) === 250_000 && Math.abs(a(320) - 200_000) < 1e-6 && a(345) === 0);
  check('Overtake takes precedence over Alt 1 (C5.2.8 ii over iii)', ersKDeployLimitW(250, true, 'base', true) === 350_000 && ersKDeployLimitW(330, true, 'base', true) === 350_000);
}

console.log('\n== The Boost, Overtake\'s lines, the Automatic Overtake');
{
  const raceBoost = (fromW: number) => {
    const c = new Ers2026Control();
    // deploying fromW, then cut by the management: the Boost pressed mid-cut (allow 0.2 s for 2000 kW/s Boost ramp)
    run(c, 5, { share: fromW / 350_000 });
    const held = run(c, 100, { share: 1, valueSPerMJ: 0.1, boost: true, boostCapped: true });
    return { p: held[99], fill: c.fillCeilingW };
  };
  const rb100 = raceBoost(100_000);
  const rb280 = raceBoost(280_000);
  check('Race Boost from 100 kW: 150 kW, no more (fillCeilingW capped too)', Math.abs(rb100.p - 150_000) < 1 && rb100.fill <= 150_000 + 1, `${kW(rb100.p)}, fill ${kW(rb100.fill)}`);
  check('Race Boost from 280 kW: holds 280 kW', Math.abs(rb280.p - 280_000) < 1, kW(rb280.p));
  // Holding Race Boost from corner exit (0 kW deploy) through full deploy holds 350 kW into a managed cut (no stale 0 kW latch)
  const raceExit = new Ers2026Control();
  run(raceExit, 10, { share: 0, valueSPerMJ: 10, boost: true, boostCapped: true });
  run(raceExit, 100, { share: 1, valueSPerMJ: 10, boost: true, boostCapped: true });
  const raceHeld = run(raceExit, 20, { share: 1, valueSPerMJ: 0.1, boost: true, boostCapped: true });
  check('Race Boost held from corner exit tracks full power into a managed cut', Math.abs(raceHeld[19] - 350_000) < 1, kW(raceHeld[19]));
  const c = new Ers2026Control();
  run(c, 5, { share: 0.2 });
  const free = run(c, 100, { boost: true, boostCapped: false, valueSPerMJ: 0.1 });
  check('Boost outside a race: the whole curve', Math.abs(free[99] - 350_000) < 1e-6, kW(free[99]));
  const auto = new Ers2026Control();
  const at320 = run(auto, 5, { speedKmh: 320, overtake: true, overtakeShare: 0.75 })[4];
  const full320 = ersKDeployLimitW(320, true);
  const normal320 = ersKDeployLimitW(320, false);
  check('Automatic Overtake: 75 % of Overtake\'s extra power over the normal curve', Math.abs(at320 - (normal320 + 0.75 * (full320 - normal320))) < 1, `${kW(at320)} at 320 km/h (${kW(normal320)} normal, ${kW(full320)} pressed)`);
  // Earned at the Detection Line, active from the Activation Line to the next
  const g = new OvertakeGrant();
  const race = { racing: true, earnedAtDetection: () => true };
  const lines = { detection: 0.9, activation: 0.95 };
  g.observeLines(0.89, 0.91, lines, race);
  const before = g.available(race);
  g.observeLines(0.94, 0.96, lines, race);
  check('Overtake: earned at the Detection Line, usable from the Activation Line', !before && g.available(race) && g.extraRechargeJ(race) === 500_000 && g.activations === 1);
  const lost = { racing: true, earnedAtDetection: () => false };
  g.observeLines(0.89, 0.91, lines, lost);
  const stillOn = g.available(lost);
  g.observeLines(0.94, 0.96, lines, lost);
  check('... kept to the next Activation Line, then judged afresh', stillOn && !g.available(lost));
}

console.log('\n== Each circuit\'s rules (the FIA\'s 2026 Power Unit Information, derived elsewhere)');
{
  const load = (id: string) => {
    const path = `public/tracks/${id}/track_data.json`;
    if (!existsSync(path)) return null;
    setActiveTrack(id, JSON.parse(readFileSync(path, 'utf8')) as RawTrackJson);
    const track = getActiveTrackData(1200);
    return { track, rules: f1EnergyCircuit(id, track.samples, track.totalLengthM, straightModeWindows(track), RWANDA_DRS_ZONES) };
  };
  const rb = load('spielberg');
  if (!rb) console.log('SKIP  the Red Bull Ring (not in this checkout)');
  else {
    const c = rb.rules;
    check('Red Bull Ring: the FIA\'s figures (race 8.0 MJ, qualifying 6.0, practice 8.5)', c.source === 'fia-2026' && c.recharge.race === 8e6 && c.recharge.timeTrial === 6e6 && c.recharge.practice === 8.5e6 && c.curves === 'base');
    // T4-T7 and T9-T10 on this lap: from the braking zones the real laps brake in
    const [a, b] = c.alt1;
    check('... its 250 kW sectors T4–T7 and T9–T10 on this lap', c.alt1.length === 2 && Math.abs(a.fromM - 2018) < 40 && Math.abs(a.toM - 2747) < 40 && Math.abs(b.fromM - 3512) < 40 && Math.abs(b.toM - 3750) < 40, JSON.stringify(c.alt1));
    check('... Overtake judged in the braking for T10, active after it', c.detectionM !== null && c.activationM !== null && Math.abs(c.detectionM - 3766) < 40 && Math.abs(c.activationM - 3922) < 40, `${c.detectionM} / ${c.activationM} m`);
    // The derived rule, on the same circuit: within a braking zone of the FIA's own sectors
    const d = f1EnergyCircuit('spielberg:derived', rb.track.samples, rb.track.totalLengthM, straightModeWindows(rb.track), RWANDA_DRS_ZONES);
    const near = d.alt1.length === 2 && d.alt1.every((w, i) => Math.abs(w.fromM - c.alt1[i].fromM) < 80 && Math.abs(w.toM - c.alt1[i].toM) < 80);
    check('The rule for other circuits puts the Red Bull Ring\'s 250 kW sectors where the FIA did', near, JSON.stringify(d.alt1));
    check('... and its recharge in the same class (qualifying 6.0–6.5)', d.recharge.race === 8e6 && d.recharge.timeTrial >= 6e6 && d.recharge.timeTrial <= 6.5e6 && d.recharge.practice === 8.5e6);
  }
  const mc = load('monaco');
  if (!mc) console.log('SKIP  Monaco (not in this checkout)');
  else {
    const c = mc.rules;
    check('Monaco: Rev 1 curves, no 250 kW sectors, 8.5 / 9.0 / 9.0 MJ', c.curves === 'rev1' && c.alt1.length === 0 && c.recharge.race === 8.5e6 && c.recharge.timeTrial === 9e6 && c.recharge.practice === 9e6);
    check('... Overtake judged after the Swimming Pool, active before Anthony Noghès', c.detectionM !== null && c.activationM !== null && c.detectionM > 2700 && c.detectionM < 2850 && c.activationM > 2850 && c.activationM < 2950, `${c.detectionM} / ${c.activationM} m`);
    check('... the qualifying lap\'s launch out of the last corner (C5.12.4, C5.12.5)', c.bigCut.length === 1 && c.bigCut[0].timeTrialOnly && c.reset.length === 1 && inStretch(3100, c.reset[0]));
    check('... somewhere to spend an Overtake, with no DRS zone or straight: its longest runs', c.overtakeZones.length === 2 && inStretch(3200, c.overtakeZones[0]), JSON.stringify(c.overtakeZones));
  }
  // C5.2.10 ii: low-braking high-speed circuits reach the 4.0 MJ qualifying recharge floor
  const fastPad = createFlatTestTrack(5800, 300);
  const fastRules = f1EnergyCircuit('monza-like:derived', fastPad.samples, fastPad.totalLengthM, [], []);
  check('Low-braking circuit reaches FIA C5.2.10 ii 4.0 MJ qualifying recharge floor',
    fastRules.recharge.timeTrial === 4e6 && fastRules.recharge.race === 7e6 && fastRules.recharge.practice === 7.5e6,
    `${f(fastRules.recharge.timeTrial / 1e6, 1)} / ${f(fastRules.recharge.race / 1e6, 1)} / ${f(fastRules.recharge.practice / 1e6, 1)} MJ`);
}

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
console.log('\n== Through the car: the race\'s 250 kW, the Overtake press and its assist, the time trial');
{
  // On the flat pad, its whole lap one 250 kW sector: in a race, flat out past the pending second, the motor at 250 kW
  const flat = (racing: boolean) => {
    const sim = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
    sim.assistPreset = 'pro';
    sim.autoGearbox = true;
    sim.raceControl = racing ? { racing: true, earnedAtDetection: () => false } : null;
    sim.teleportToDistance(2000, 180 / 3.6);
    // A copy: the circuit's rules are one object for every car on it
    const c = sim.vehicle.ersCircuit;
    if (c) sim.vehicle.ersCircuit = { ...c, alt1: [{ fromM: 0, toM: 1e9 }] };
    let peakAfter = 0;
    for (let t = 0; t < 4; t += 1 / 240) {
      sim.step(1 / 240, { throttle: 1 });
      sim.vehicle.ersEnergyJ = 3e6;
      if (t > 1.5) peakAfter = Math.max(peakAfter, sim.vehicle.telemetry.MGUK_POWER / ers.deployEfficiency);
    }
    return peakAfter;
  };
  const race = flat(true);
  const practice = flat(false);
  check('A race\'s 250 kW sector: the motor held to 250 kW flat out (C5.2.8 iii)', race <= 250_100 && race > 240_000, kW(race));
  check('... practice keeps the whole 350 kW there', practice > 340_000, kW(practice));

  // One straight in a race, Overtake earned: none, the Automatic Overtake, the driver's press
  const straight = (mode: 'none' | 'auto' | 'press') => {
    const sim = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
    // The grant is the car's own; earned and active for this straight
    const grant = (sim as unknown as { overtake: OvertakeGrant }).overtake;
    sim.assistPreset = 'pro';
    sim.autoGearbox = true;
    sim.raceControl = { racing: true, earnedAtDetection: () => true };
    sim.teleportToDistance(2000, 290 / 3.6);
    sim.autoOvertake = mode === 'auto';
    const s0 = sim.sMeters;
    let t = 0;
    while (sim.sMeters - s0 < 1200 && t < 30) {
      grant.earned = grant.active = true;
      sim.vehicle.ersEnergyJ = 3e6;
      sim.step(1 / 240, { throttle: 1, overtake: mode === 'press' && t === 0 });
      t += 1 / 240;
    }
    return t;
  };
  const tNone = straight('none');
  const tAuto = straight('auto');
  const tPress = straight('press');
  check('1200 m flat out from 290 km/h: Overtake pressed beats the Automatic Overtake, which beats none', tPress < tAuto - 0.03 && tAuto < tNone - 0.1,
    `${f(tNone, 3)} / ${f(tAuto, 3)} / ${f(tPress, 3)} s`);

  // Boost telemetry honesty: below the 20 kJ cut floor (0.5 % SOC), ersBoostActive stays false so HUD never lights BOOST with 0 kW
  {
    const sim = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
    sim.teleportToDistance(2000, 220 / 3.6);
    sim.vehicle.ersEnergyJ = 10_000;
    sim.step(1 / 60, { throttle: 1, manualOverride: true });
    const lowFlag = sim.telemetry.ersBoostActive;
    sim.vehicle.ersEnergyJ = 100_000;
    let peakLowDc = 0;
    for (let k = 0; k < 15; k++) {
      sim.step(1 / 60, { throttle: 1, manualOverride: true });
      peakLowDc = Math.max(peakLowDc, sim.vehicle.telemetry.MGUK_POWER / ers.deployEfficiency);
    }
    const okFlag = sim.telemetry.ersBoostActive;
    const sustainedLowDc = sim.vehicle.telemetry.MGUK_POWER / ers.deployEfficiency;
    const safe100 = maxSafeDeployW(100_000);
    check(
      'ersBoostActive aligns with 20 kJ floor and tracks maxSafeDeployW(100 kJ) on full car',
      lowFlag === false && okFlag === true && sustainedLowDc > 110_000 && peakLowDc <= safe100 + 2_000,
      `10 kJ: ${lowFlag}, 100 kJ: ${okFlag}, sustained ${kW(sustainedLowDc)}, peak ${kW(peakLowDc)} (cap ${kW(safe100)})`
    );
    // CHR mode + Boost at part throttle (60 %): deploys positive power instead of harvesting -80 kW
    sim.setLiveTuner({ ersMode: 'CHR' });
    sim.vehicle.ersEnergyJ = 2e6;
    sim.step(1 / 60, { throttle: 0.6, manualOverride: true });
    check('CHR mode + Boost at 60 % throttle deploys instead of part-throttle harvesting', sim.vehicle.telemetry.MGUK_POWER > 50_000, kW(sim.vehicle.telemetry.MGUK_POWER));

    // Transparent 2026 ICE-to-MGU-K torque arbitration (FIA C5.2.5 / C5.2.10 i):
    // 1) Part-throttle (30 % pedal): harvests into the store while keeping wheel acceleration identical to unarbitrated full-SOC baseline
    const runPart = (socJ: number) => {
      const s = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
      s.assistPreset = 'pro';
      s.autoGearbox = true;
      s.teleportToDistance(2000, 150 / 3.6);
      s.vehicle.ersEnergyJ = socJ;
      for (let k = 0; k < 45; k++) s.step(1 / 120, { throttle: 0.3 });
      return {
        v: s.vxMs,
        pK: s.vehicle.telemetry.MGUK_POWER,
        dE: s.vehicle.ersEnergyJ - socJ,
        boost: s.vehicle.turboBoostBar,
      };
    };
    const ptArb = runPart(2e6);
    const ptFull = runPart(3.98e6);
    check(
      'Part-throttle torque arbitration harvests transparently (net speed unchanged, turbo spooled)',
      ptArb.pK < -30_000 && ptArb.dE > 15_000 && Math.abs(ptArb.v - ptFull.v) < 0.08 && ptArb.boost >= ptFull.boost,
      `MGU-K ${kW(ptArb.pK)}, +${f(ptArb.dE / 1000, 1)} kJ, Δv ${f(Math.abs(ptArb.v - ptFull.v) * 3.6, 2)} km/h, boost ${f(ptArb.boost, 2)} vs ${f(ptFull.boost, 2)} bar`
    );

    // 2) Trail braking (20 % pedal): fires ICE into unused MGU-K generator headroom without altering rear-axle braking deceleration
    const runTrail = (socJ: number) => {
      const s = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
      s.assistPreset = 'pro';
      s.autoGearbox = true;
      s.teleportToDistance(2000, 200 / 3.6);
      s.vehicle.ersEnergyJ = socJ;
      for (let k = 0; k < 30; k++) s.step(1 / 120, { throttle: 0, brake: 0.2 });
      return { v: s.vxMs, pK: s.vehicle.telemetry.MGUK_POWER, dE: s.vehicle.ersEnergyJ - socJ };
    };
    const brkArb = runTrail(2e6);
    const brkFull = runTrail(3.98e6);
    check(
      'Trail-braking torque arbitration fills generator headroom without altering braking deceleration',
      brkArb.pK < brkFull.pK - 50_000 && brkArb.dE > 40_000 && Math.abs(brkArb.v - brkFull.v) < 0.15,
      `MGU-K ${kW(brkArb.pK)} vs ${kW(brkFull.pK)}, Δv ${f(Math.abs(brkArb.v - brkFull.v) * 3.6, 2)} km/h`
    );
  }

  // The time trial's allowances, given to the car through the simulation worker's messages
  const loop = loopbackTransport();
  const host = createSimHost(loop.transport, loop.wallNowMs);
  const twin = vehicleModelSpec('lc26').createSim(pad, null);
  const car = host.adopt(twin, 'lc26');
  car.setEnergySession?.(true);
  car.resetToStartGrid(false);
  host.endFrame(true);
  car.step(1 / 60, {});
  loop.advance(1 / 60);
  host.endFrame(true);
  const workerCar = loop.runtime.simulatedCar as unknown as { vehicle: { ersSession: string } } | null;
  check('A time trial gives the car qualifying\'s allowances, through the worker too', workerCar?.vehicle.ersSession === 'timeTrial', workerCar?.vehicle.ersSession ?? 'no worker car');
}

// ---------------------------------------------------------------------------
console.log('\n== Low Grip Conditions (B1.5.11, B7.1.2 b, B7.2.1 g, B7.2.2 d, C5.12.4)');
{
  check('Race control declares Low Grip once the line calls for intermediates, Normal Grip again under damp',
    !lowGripCall(0.14, false) && lowGripCall(0.15, false) && recommendedCompound(0.15) === 'intermediate' && lowGripCall(0.1, true) && !lowGripCall(0.07, true));
  // The Boost only holds the power: no 150 kW floor in a race, nothing more in practice, nothing given back mid-cut
  const holdFrom = (fromW: number, capped: boolean) => {
    const c = new Ers2026Control();
    run(c, 5, { share: fromW / 350_000 });
    return run(c, 5, { share: 1, valueSPerMJ: 0.1, boost: true, boostCapped: capped, boostHoldOnly: true })[4];
  };
  check('Boost from 100 kW in a race: holds 100 kW (no 150 kW floor)', Math.abs(holdFrom(100_000, true) - 100_000) < 1, kW(holdFrom(100_000, true)));
  check('... in practice too: no more than its power when pressed', Math.abs(holdFrom(100_000, false) - 100_000) < 1, kW(holdFrom(100_000, false)));
  const mid = new Ers2026Control();
  run(mid, 50, {});
  const cutting = run(mid, 250, { valueSPerMJ: 0.5 });
  const held = run(mid, 250, { valueSPerMJ: 0.5, boost: true, boostHoldOnly: true });
  const at = cutting[cutting.length - 1];
  check('... mid-cut it stops the cut where it is, and gives nothing back', at > 100_000 && held.every((p) => Math.abs(p - at) < 1), `${kW(at)} held`);
  // ... and Low Grip Boost during active superclipping inhibits deeper harvest without cancelling it to 0 (B7.2.1 g i)
  const lgSc = new Ers2026Control();
  run(lgSc, 20, { speedKmh: 260 });
  const scRamp = run(lgSc, 1450, { speedKmh: 260, valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 1e9 });
  const scAt = scRamp[scRamp.length - 1];
  const scHold = run(lgSc, 200, { speedKmh: 260, valueSPerMJ: 0.1, superclipBelowSPerMJ: 0.5, superclipRoomJ: 1e9, boost: true, boostHoldOnly: true });
  check('... in active superclipping, Low Grip Boost holds harvest without increasing power', scAt < -50_000 && scHold.every((p) => Math.abs(p - scAt) < 1), `${kW(scAt)} held`);
  // Upshifting while holding Low Grip Boost must not kill held deployment
  const lgShift = new Ers2026Control();
  run(lgShift, 20, {});
  run(lgShift, 10, { valueSPerMJ: 0.5, boost: true, boostHoldOnly: true });
  run(lgShift, 5, { valueSPerMJ: 0.5, boost: true, boostHoldOnly: true, shifting: true });
  const afterLgShift = run(lgShift, 10, { valueSPerMJ: 0.5, boost: true, boostHoldOnly: true });
  check('... upshifting during Low Grip Boost preserves held deployment', Math.abs(afterLgShift[9] - 350_000) < 1, kW(afterLgShift[9]));
  // C5.12.4: a race's bigger-cut sector in Low Grip cuts at least 250 kW at once. The management's cut there takes it all
  const big = new Ers2026Control();
  run(big, 50, { cutStepW: 350_000 });
  const first = run(big, 1, { cutStepW: 350_000, valueSPerMJ: 0.5 })[0];
  check('A bigger-cut sector\'s cut takes at least 250 kW at once (all of it)', 350_000 - first >= 250_000, `${kW(first)} left`);

  // The Boost never gives less than no Boost: held from off the throttle or part throttle, then flat out where the
  // management deploys and then where it cuts. In a race, in practice, and in Low Grip
  const phases = (k: number): Partial<ErsStepInput> => (k < 40 ? { throttle: k < 20 ? 0 : 0.5 } : { valueSPerMJ: k < 400 ? 10 : 0.5 });
  const worst = (boost: Partial<ErsStepInput>) => {
    const plain = run(new Ers2026Control(), 900, phases);
    const boosted = run(new Ers2026Control(), 900, (k) => ({ ...phases(k), boost: true, ...boost }));
    return Math.min(...plain.map((p, k) => boosted[k] - p));
  };
  const wRace = worst({ boostCapped: true });
  const wPractice = worst({});
  const wLow = worst({ boostHoldOnly: true, boostCapped: true });
  check('The Boost held from off the throttle never gives less than no Boost (race, practice, Low Grip)', wRace >= -1 && wPractice >= -1 && wLow >= -1, `${kW(wRace)} / ${kW(wPractice)} / ${kW(wLow)} at worst`);
  // ... and a Low Grip Boost held from part throttle stops the management's cut, but raises nothing
  const lowHeld = run(new Ers2026Control(), 900, (k) => ({ ...phases(k), boost: true, boostHoldOnly: true }));
  check('... a Low Grip Boost keeps the power through the management\'s cut, never over it', lowHeld.slice(400).every((p) => Math.abs(p - lowHeld[399]) < 1) && Math.max(...lowHeld) <= 350_000 + 1, `${kW(lowHeld[899])} at the end`);

  // The HUD: the badge reads Low Grip in any session; the call's off is a plain false, not a missing key
  const tel = (o: Partial<CarTelemetry>) => ({ ersBoostActive: false, overtakeRace: false, overtakeInUse: false, overtakeAuto: false, overtakeAvailable: true, manualOverrideActive: false, ...o }) as CarTelemetry;
  check('HUD: Overtake reads Low Grip in practice and in a race, and nothing special without the call',
    ersButtons(tel({ lowGrip: true })).overtake === 'lowGrip' && ersButtons(tel({ lowGrip: true, overtakeRace: true })).overtake === 'lowGrip' && ersButtons(tel({ lowGrip: false })).overtake === null && ersButtons(tel({ lowGrip: false })).lowGrip === false);

  // End to end: a heavy-rain session declares Low Grip, and the car in the simulation worker takes it
  const env = new TrackEnvironment(pad, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain' });
  const loop = loopbackTransport();
  const host = createSimHost(loop.transport, loop.wallNowMs);
  const car = host.adopt(vehicleModelSpec('lc26').createSim(pad, null), 'lc26');
  car.resetToStartGrid(false);
  host.endFrame(true);
  for (let k = 0; k < 120 && !env.lowGrip; k++) env.update(0.5, [car]);
  const declaredAfterS = env.weather.lineWaterMm;
  for (let k = 0; k < 3; k++) {
    env.update(1 / 60, [car]);
    car.step(1 / 60, {});
    loop.advance(1 / 60);
    host.endFrame(true);
  }
  const worker = loop.runtime.simulatedCar as unknown as { vehicle: { flapsLowGrip: boolean | null; ersLowGrip: boolean }; telemetry: CarTelemetry } | null;
  check('Heavy rain: race control declares Low Grip, and the worker\'s car and its telemetry follow',
    env.lowGrip && worker?.vehicle.flapsLowGrip === true && worker.vehicle.ersLowGrip && car.telemetry.lowGrip === true,
    `line water ${declaredAfterS.toFixed(2)} mm, worker ${worker?.vehicle.flapsLowGrip}, telemetry ${car.telemetry.lowGrip}`);

  // Through the car: race control's call in the weather sample
  const wet = (lowGrip: boolean) => ({ waterMm: 0, wetness: 0, ambientC: 25, rain: 0, lowGrip });
  const onPad = (racing: boolean, lowGrip: boolean) => {
    const sim = new F12026CarSim(pad, null, LC26_SIM_PROFILE);
    const grant = (sim as unknown as { overtake: OvertakeGrant }).overtake;
    sim.assistPreset = 'pro';
    sim.autoGearbox = true;
    sim.raceControl = racing ? { racing: true, earnedAtDetection: () => true } : null;
    sim.teleportToDistance(2000, 250 / 3.6);
    sim.setWeatherSample(wet(lowGrip));
    for (let k = 0; k < 24; k++) {
      grant.earned = grant.active = true;
      sim.step(1 / 240, { throttle: 1, overtake: k === 0 });
    }
    return sim;
  };
  const dryPractice = onPad(false, false);
  const wetPractice = onPad(false, true);
  const wetRace = onPad(true, true);
  check('Practice: Overtake\'s curve in Normal Grip, none in Low Grip (B7.2.2 d)', dryPractice.vehicle.ersOvertake && !wetPractice.vehicle.ersOvertake);
  check('A race in Low Grip: an earned Overtake can\'t be pressed, no 0.5 MJ extra, the HUD told',
    !wetRace.vehicle.ersOvertake && wetRace.vehicle.extraRechargeJ === 0 && wetRace.telemetry.overtakeAvailable === false && wetRace.telemetry.lowGrip === true);
  check('The Boost and the flaps get the call too', wetRace.vehicle.ersLowGrip && wetRace.vehicle.flapsLowGrip === true && dryPractice.vehicle.flapsLowGrip === false);

  // C5.12.5 / B7.2.1 g ii: a reset only in the last sector before the line, and never in a race
  const v = dryPractice.vehicle;
  const resetAt = v as unknown as { ersResetSector: (c: NonNullable<typeof v.ersCircuit>, s: number) => boolean };
  const c = { ...v.ersCircuit!, reset: [{ fromM: 500, toM: 700, timeTrialOnly: false }, { fromM: 3000, toM: 3200, timeTrialOnly: false }] };
  const resets = (lowGrip: boolean, session: 'race' | 'practice') => {
    v.ersLowGrip = lowGrip;
    v.ersSession = session;
    return [resetAt.ersResetSector.call(v, c, 600), resetAt.ersResetSector.call(v, c, 3100)];
  };
  const normal = resets(false, 'practice');
  const lowPractice = resets(true, 'practice');
  const lowRace = resets(true, 'race');
  check('Reset sectors in Low Grip: only the last before the line, none in a race',
    normal[0] && normal[1] && !lowPractice[0] && lowPractice[1] && !lowRace[0] && !lowRace[1], JSON.stringify({ normal, lowPractice, lowRace }));
}

console.log('\n== Saved controls');
{
  // A save from before Overtake, with Z already the player's for something else: Overtake gets no key, never a clash
  const keys = parsePlayerSettings({ keys: { ...DEFAULT_KEY_BINDINGS, overtake: undefined, mute: ['KeyZ'] } }).keys;
  check('An older key map: Overtake on Z, unless the player already uses Z', keys.overtake.length === 0 && keys.mute[0] === 'KeyZ' && parsePlayerSettings({ keys: { ...DEFAULT_KEY_BINDINGS, overtake: undefined } }).keys.overtake[0] === 'KeyZ');
  const oldF1 = parsePlayerSettings({ padButtons: { ...RETIRED_FORMULA_STYLE_BUTTONS, overtake: undefined } }).padButtons;
  check('An older Formula style pad moves on: Overtake on LB', oldF1.overtake === 4 && oldF1.mfdPage === PAD_LAYOUTS.f1.buttons.mfdPage);
  const oldGt = parsePlayerSettings({ padButtons: { ...GT_STYLE_BUTTONS, overtake: undefined } }).padButtons;
  check('GT style keeps every button; Overtake left to the assist (or a binding)', oldGt.overtake === null && oldGt.boost === GT_STYLE_BUTTONS.boost);
}

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
    // Per whole lap (the first from the line after the flying start, then the next): what it deploys out of the last
    // corner, where its recharge reached the limit, its superclipping
    const out = [1, 2].map(() => ({ hairpinJ: 0, limitAtM: Number.NaN, superclipS: 0 }));
    let lapHarvestPeak = 0;
    let emptyFlatS = 0;
    for (let t = 0; t < 900 && lap < 3; t += H2) {
      car.step(H2, { throttle: 0, brake: 0 });
      const s = car.sMeters;
      if (s < prevS - L / 2) lap++;
      prevS = s;
      lapHarvestPeak = Math.max(lapHarvestPeak, v.lapHarvestJ);
      if (lap < 1 || lap > 2) continue;
      const o = out[lap - 1];
      const p = v.telemetry.MGUK_POWER;
      const thr = car.telemetry.throttle ?? 0;
      // The final hairpin's exit onto the main straight (≈ 7.5 to 8.1 km)
      if (s > 7500 && s < 8100 && p > 0) o.hairpinJ += (p / ers.deployEfficiency) * H2;
      if (Number.isNaN(o.limitAtM) && v.lapHarvestJ >= 8.5e6 - 1000 && s > 200) o.limitAtM = s;
      if (p < 0 && thr > 0.9) o.superclipS += H2;
      if (v.ersEnergyJ < 1 && thr > 0.95 && car.vxMs > 60) emptyFlatS += H2;
    }
    out.forEach((o, i) => {
      const name = i === 0 ? 'the first lap from the line' : 'the lap after';
      check(`The car deploys out of the last corner (#180), ${name}`, o.hairpinJ > 0.8e6, `${f(o.hairpinJ / 1e6, 2)} MJ from 7.5 to 8.1 km`);
      check(`... its recharge limit not spent before the last braking zone, ${name}`, Number.isNaN(o.limitAtM) || o.limitAtM > 7400,
        Number.isNaN(o.limitAtM) ? 'not reached' : `reached at ${f(o.limitAtM, 0)} m`);
      check(`... superclipping a few seconds, not whole straights, ${name}`, o.superclipS > 1 && o.superclipS < 10, `${f(o.superclipS)} s`);
    });
    const limit = (car.vehicle as unknown as { ersCircuit: { recharge: { practice: number } } }).ersCircuit.recharge.practice;
    check(`The lap's recharge never over the circuit's ${f(limit / 1e6, 1)} MJ in practice (C5.2.10)`, lapHarvestPeak <= limit + 1, `${f(lapHarvestPeak / 1e6, 3)} MJ at most`);
    check('The store never runs empty under power', emptyFlatS < 0.05, `${f(emptyFlatS, 2)} s`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll 2026 ERS checks passed.');
