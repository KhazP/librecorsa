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
import { aiLineOffsetM, brakingGuideFor, computeSpeedProfile, sampleProfile } from '../src/lib/sim/speed-profile';
import { aiTrackFor } from '../src/lib/sim/ai/ai-track';
import { carLimitsFor } from '../src/lib/sim/ai/ggv';
import { makeDrivePlan } from '../src/lib/sim/ai/drive-plan';
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

// Reference 2 m-grid full GGV AI plan on the same line (invariant across line re-optimisations)
const aiTrack = aiTrackFor(leMans);
const gt3Offsets = new Float64Array(aiTrack.n);
for (let i = 0; i < aiTrack.n; i++) gt3Offsets[i] = aiLineOffsetM(leMans.getSampleAtDistance(i * aiTrack.ds), 'gt3');
const refPlan = makeDrivePlan(aiTrack, gt3Offsets, carLimitsFor('lc-lmdh', 1.0));

const minKmhIn = (sLo: number, sHi: number): number => {
  let minMs = Infinity;
  for (let s = sLo; s <= sHi; s += 2) {
    const v = sampleProfile(guide.speedMs, s, leMans.totalLengthM);
    if (v < minMs) minMs = v;
  }
  return minMs * 3.6;
};
const refMinKmhIn = (sLo: number, sHi: number): number => {
  let minMs = Infinity;
  for (let s = sLo; s <= sHi; s += 2) {
    const i = Math.min(aiTrack.n - 1, Math.max(0, Math.floor(s / aiTrack.ds)));
    if (refPlan.v[i] < minMs) minMs = refPlan.v[i];
  }
  return minMs * 3.6;
};

const fordMinKmh = minKmhIn(13320, 13415);
const racc16MinKmh = minKmhIn(13460, 13515);
const racc17MinKmh = minKmhIn(13515, 13565);
const mulsanneMinKmh = minKmhIn(7720, 7780);

const refFordKmh = refMinKmhIn(13320, 13415);
const refRacc16Kmh = refMinKmhIn(13460, 13515);
const refRacc17Kmh = refMinKmhIn(13515, 13565);
const refMulsanneKmh = refMinKmhIn(7720, 7780);

check(
  'Sarthe 1982 T14/15 Virage Ford target speed tracks 2 m GGV plan (< 135 km/h)',
  fordMinKmh > 65 && fordMinKmh < 135 && fordMinKmh <= refFordKmh + 25,
  `guide=${fordMinKmh.toFixed(1)} km/h vs 2m-plan=${refFordKmh.toFixed(1)} km/h (was ~165 before subdivision)`
);
check(
  'Sarthe 1982 T16 Virage du Raccordement tracks 2 m GGV plan (< 130 km/h)',
  racc16MinKmh > 60 && racc16MinKmh < 130 && racc16MinKmh <= refRacc16Kmh + 25,
  `guide=${racc16MinKmh.toFixed(1)} km/h vs 2m-plan=${refRacc16Kmh.toFixed(1)} km/h (was ~158 before)`
);
check(
  'Sarthe 1982 T17 Virage du Raccordement tracks 2 m GGV plan (< 125 km/h)',
  racc17MinKmh > 55 && racc17MinKmh < 125 && racc17MinKmh <= refRacc17Kmh + 28,
  `guide=${racc17MinKmh.toFixed(1)} km/h vs 2m-plan=${refRacc17Kmh.toFixed(1)} km/h`
);
check(
  'Sarthe 1982 T4 Mulsanne hairpin resolves true curvature vs 2 m plan',
  mulsanneMinKmh > 30 && mulsanneMinKmh < 75 && mulsanneMinKmh <= refMulsanneKmh + 15,
  `guide=${mulsanneMinKmh.toFixed(1)} km/h vs 2m-plan=${refMulsanneKmh.toFixed(1)} km/h`
);

// Dynamic urgency exiting T15 Ford (+20 km/h over T17 apex) and approaching T16 (+30 km/h over T16 apex)
const exitSpeedKmh = Math.max(115, racc17MinKmh + 20);
let maxUrgExit = 0;
for (let s = 13440; s <= 13540; s += 5) {
  maxUrgExit = Math.max(maxUrgExit, evaluateDynamicBrakingUrgency(leMans, 13395, exitSpeedKmh / 3.6, s, guide));
}
check(
  'Exiting T15 Ford above T17 apex speed shows clear braking cue',
  maxUrgExit >= 0.5,
  `at ${exitSpeedKmh.toFixed(0)} km/h, max urgency = ${maxUrgExit.toFixed(2)}`
);

const approachSpeedKmh = Math.max(145, racc16MinKmh + 30);
const urgApproach16 = evaluateDynamicBrakingUrgency(leMans, 13430, approachSpeedKmh / 3.6, 13445, guide);
check(
  'Approaching T16 Raccordement above apex speed goes red well before apex',
  urgApproach16 >= 0.99,
  `at ${approachSpeedKmh.toFixed(0)} km/h, urgency at s=13445 (41 m before T16) = ${urgApproach16.toFixed(2)}`
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
const pFlat = computeSpeedProfile(flatSamples, LC_LMDH_PROFILE_CAR, 'gt3', { crests: true });
const pDown = computeSpeedProfile(downSamples, LC_LMDH_PROFILE_CAR, 'gt3', { crests: true });
const pUp = computeSpeedProfile(upSamples, LC_LMDH_PROFILE_CAR, 'gt3', { crests: true });
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
