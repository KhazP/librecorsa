/**
 * Racing-line speed profile and dynamic braking-zone verification (#150):
 *   npx tsx scripts/verify-racing-line.ts
 *
 * Verifies:
 *  - Long circuits (Circuit de la Sarthe 1982, 13.6 km at 1200 samples / 11.4 m spacing) resolve tight
 *    alternating chicanes (Virage Ford & Virage du Raccordement) and hairpins (Mulsanne) without smearing
 *    curvature flat.
 *  - Dynamic braking urgency exiting Virage Ford toward Virage du Raccordement highlights braking well before
 *    Turn 16/17 rather than showing full-throttle green until too late.
 *  - Downhill braking zones start earlier than flat/uphill ones of equal geometry.
 *  - Wet-track conditions shift a car's brakingGuide earlier automatically.
 */
import fs from 'node:fs';
import { setActiveTrack, getActiveTrackData, type BuiltTrackData } from '../src/lib/track-data';
import { createLcLmdhSim, LC_LMDH_PROFILE_CAR } from '../src/lib/sim/proto/LcLmdhSim';
import { brakingGuideFor, computeSpeedProfile, sampleProfile } from '../src/lib/sim/speed-profile';
import { evaluateDynamicBrakingUrgency } from '../src/lib/sim/track-occupancy';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(68)} ${detail}`);
  if (!ok) failures.push(name);
};

// 1. Circuit de la Sarthe 1982 (13,646 m) with LC-LMDH
const rawLeMans = JSON.parse(fs.readFileSync('public/tracks/le_mans_82/track_data.json', 'utf8'));
setActiveTrack('le_mans_82', rawLeMans);
const leMans: BuiltTrackData = getActiveTrackData(1200);
const guide = brakingGuideFor(leMans.samples, 'lc-lmdh', LC_LMDH_PROFILE_CAR, 'gt3');

const minKmhIn = (sLo: number, sHi: number): number => {
  let minMs = Infinity;
  for (let s = sLo; s <= sHi; s += 2) {
    const v = sampleProfile(guide.speedMs, s, leMans.totalLengthM);
    if (v < minMs) minMs = v;
  }
  return minMs * 3.6;
};

const fordMinKmh = minKmhIn(13320, 13415);
const racc16MinKmh = minKmhIn(13460, 13515);
const racc17MinKmh = minKmhIn(13515, 13565);
const mulsanneMinKmh = minKmhIn(7720, 7780);

check(
  'Sarthe 1982 T14/15 Virage Ford target speed stays realistic (< 115 km/h)',
  fordMinKmh > 65 && fordMinKmh < 115,
  `${fordMinKmh.toFixed(1)} km/h (was ~165 km/h before subdivision)`
);
check(
  'Sarthe 1982 T16 Virage du Raccordement target speed realistic (< 110 km/h)',
  racc16MinKmh > 60 && racc16MinKmh < 110,
  `${racc16MinKmh.toFixed(1)} km/h (was ~158 km/h)`
);
check(
  'Sarthe 1982 T17 Virage du Raccordement target speed realistic (< 100 km/h)',
  racc17MinKmh > 55 && racc17MinKmh < 100,
  `${racc17MinKmh.toFixed(1)} km/h (was ~116 km/h)`
);
check(
  'Sarthe 1982 T4 Mulsanne hairpin resolves true curvature (< 55 km/h)',
  mulsanneMinKmh > 30 && mulsanneMinKmh < 55,
  `${mulsanneMinKmh.toFixed(1)} km/h (was ~63 km/h)`
);

// Dynamic urgency exiting T15 Ford (s=13395 @ 115 km/h) and approaching T16 (s=13430 @ 145 km/h)
let maxUrgExit = 0;
for (let s = 13440; s <= 13540; s += 5) {
  maxUrgExit = Math.max(maxUrgExit, evaluateDynamicBrakingUrgency(leMans, 13395, 115 / 3.6, s, guide));
}
check(
  'Exiting T15 Ford at 115 km/h shows clear braking cue for T16/17',
  maxUrgExit >= 0.5,
  `max urgency = ${maxUrgExit.toFixed(2)}`
);

const urgApproach16 = evaluateDynamicBrakingUrgency(leMans, 13430, 145 / 3.6, 13445, guide);
check(
  'Approaching T16 Raccordement at 145 km/h goes red well before apex',
  urgApproach16 >= 0.99,
  `urgency at s=13445 (41 m before T16) = ${urgApproach16.toFixed(2)}`
);

// Static braking zones on Sarthe 1982 must cover a reasonable fraction of the lap
const redCount = Array.from(guide.brakingZone).filter((z) => z >= 1).length;
check(
  'Sarthe 1982 static braking zones populated across corners',
  redCount >= 60 && redCount <= 450,
  `${redCount} red samples`
);

// 2. Road slope affects braking envelope (downhill requires earlier braking than uphill)
const flatSamples = leMans.samples.map((s) => ({ ...s, slopeSin: 0 }));
const downSamples = leMans.samples.map((s) => ({ ...s, slopeSin: -0.1 }));
const upSamples = leMans.samples.map((s) => ({ ...s, slopeSin: 0.1 }));
const pFlat = computeSpeedProfile(flatSamples, LC_LMDH_PROFILE_CAR, 'gt3');
const pDown = computeSpeedProfile(downSamples, LC_LMDH_PROFILE_CAR, 'gt3');
const pUp = computeSpeedProfile(upSamples, LC_LMDH_PROFILE_CAR, 'gt3');
// At s = 7620 m (mid Mulsanne braking zone), downhill envelope must be slower than flat, uphill faster
const mIdx = Math.floor((7620 / leMans.totalLengthM) * leMans.samples.length);
check(
  'Downhill slope lowers braking envelope vs flat vs uphill',
  pDown.brakeEnvelopeMs[mIdx] < pFlat.brakeEnvelopeMs[mIdx] - 2 && pFlat.brakeEnvelopeMs[mIdx] < pUp.brakeEnvelopeMs[mIdx] - 2,
  `down=${(pDown.brakeEnvelopeMs[mIdx] * 3.6).toFixed(1)} < flat=${(pFlat.brakeEnvelopeMs[mIdx] * 3.6).toFixed(1)} < up=${(pUp.brakeEnvelopeMs[mIdx] * 3.6).toFixed(1)} km/h`
);

// 3. Wet weather automatically shifts F12026CarSim.brakingGuide slower / earlier
const car = createLcLmdhSim(leMans, null);
const dryApexMs = sampleProfile(car.brakingGuide.speedMs, 13486, leMans.totalLengthM);
car.setWeatherSample({
  waterMm: 1.5,
  wetness: 0.9,
  ambientC: 18,
  rain: 0.7,
});
const wetApexMs = sampleProfile(car.brakingGuide.speedMs, 13486, leMans.totalLengthM);
check(
  'Wet track lowers car brakingGuide corner speed automatically',
  wetApexMs < dryApexMs - 2,
  `dry=${(dryApexMs * 3.6).toFixed(1)} km/h -> wet=${(wetApexMs * 3.6).toFixed(1)} km/h`
);

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll racing-line checks passed.');
process.exit(failures.length ? 1 : 0);
