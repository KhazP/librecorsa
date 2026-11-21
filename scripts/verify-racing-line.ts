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
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
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

// 1. Circuit de la Sarthe 1982 (hosted R2 asset — SKIP gracefully in clean CI checkouts)
const LE_MANS_PATH = 'public/tracks/le_mans_82/track_data.json';
if (fs.existsSync(LE_MANS_PATH)) {
  const rawLeMans = JSON.parse(fs.readFileSync(LE_MANS_PATH, 'utf8'));
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
} else {
  console.log(`SKIP  Sarthe 1982 hosted checks (${LE_MANS_PATH} not present in clean checkout)`);
}

// 2. Always-available bundled circuit checks (CI-safe): slope, wet grip, F1 2026 wet fallback, and wet hysteresis
const rawRwanda = JSON.parse(fs.readFileSync('public/tracks/rwanda_official/track_data.json', 'utf8'));
setActiveTrack('rwanda_official', rawRwanda);
const rwanda: BuiltTrackData = getActiveTrackData(1200);

// Downhill slope lowers braking envelope vs flat vs uphill
const flatSamples = rwanda.samples.map((s) => ({ ...s, slopeSin: 0 }));
const downSamples = rwanda.samples.map((s) => ({ ...s, slopeSin: -0.1 }));
const upSamples = rwanda.samples.map((s) => ({ ...s, slopeSin: 0.1 }));
const pFlat = computeSpeedProfile(flatSamples, LC_LMDH_PROFILE_CAR, 'gt3', { crests: true });
const pDown = computeSpeedProfile(downSamples, LC_LMDH_PROFILE_CAR, 'gt3', { crests: true });
const pUp = computeSpeedProfile(upSamples, LC_LMDH_PROFILE_CAR, 'gt3', { crests: true });
// Pick the strongest braking point on Rwanda
let brakeIdx = 0;
let maxSpread = -1;
for (let i = 0; i < rwanda.samples.length; i++) {
  const spread = pUp.brakeEnvelopeMs[i] - pDown.brakeEnvelopeMs[i];
  if (pFlat.brakeEnvelopeMs[i] > 25 && spread > maxSpread) {
    maxSpread = spread;
    brakeIdx = i;
  }
}
check(
  'Downhill slope lowers braking envelope vs flat vs uphill',
  pDown.brakeEnvelopeMs[brakeIdx] < pFlat.brakeEnvelopeMs[brakeIdx] - 1 && pFlat.brakeEnvelopeMs[brakeIdx] < pUp.brakeEnvelopeMs[brakeIdx] - 1,
  `down=${(pDown.brakeEnvelopeMs[brakeIdx] * 3.6).toFixed(1)} < flat=${(pFlat.brakeEnvelopeMs[brakeIdx] * 3.6).toFixed(1)} < up=${(pUp.brakeEnvelopeMs[brakeIdx] * 3.6).toFixed(1)} km/h`
);

// Wet weather shifts brakingGuide slower for BOTH profile-backed cars (LC-LMDH) AND F1 2026 fallback
const lmdh = createLcLmdhSim(rwanda, null);
const dryLmdhMin = Math.min(...lmdh.brakingGuide.speedMs) * 3.6;
lmdh.setWeatherSample({ waterMm: 1.5, lineWaterMm: 1.5, wetness: 0.9, ambientC: 18, rain: 0.7 });
const wetLmdhMin = Math.min(...lmdh.brakingGuide.speedMs) * 3.6;
check(
  'Wet track lowers LC-LMDH brakingGuide corner speed automatically',
  wetLmdhMin < dryLmdhMin - 5,
  `dry=${dryLmdhMin.toFixed(1)} km/h -> wet=${wetLmdhMin.toFixed(1)} km/h`
);

// Hysteresis prevents rapid guide thrashing when water depth oscillates slightly across a drying line
const guideBeforeOsc = lmdh.brakingGuide;
let swaps = 0;
let prevGuide = guideBeforeOsc;
for (let i = 0; i < 40; i++) {
  // Car crosses wet/drier spot while lap-wide lineWaterMm barely varies
  lmdh.setWeatherSample({ waterMm: i % 2 === 0 ? 1.8 : 0.4, lineWaterMm: 1.5 + (i % 2 === 0 ? 0.02 : -0.02), wetness: 0.85, ambientC: 18, rain: 0.5 });
  if (lmdh.brakingGuide !== prevGuide) {
    swaps++;
    prevGuide = lmdh.brakingGuide;
  }
}
check('Wet brakingGuide uses lap-wide water + hysteresis (zero thrashing)', swaps === 0, `swaps=${swaps}`);

const f1 = new F12026CarSim(rwanda, null);
const dryF1Min = Math.min(...f1.brakingGuide.speedMs) * 3.6;
f1.setWeatherSample({ waterMm: 2.0, lineWaterMm: 2.0, wetness: 0.95, ambientC: 18, rain: 0.9 });
const wetF1Min = Math.min(...f1.brakingGuide.speedMs) * 3.6;
check(
  'Wet track lowers F1 2026 brakingGuide corner speed automatically',
  wetF1Min < dryF1Min - 5,
  `dry=${dryF1Min.toFixed(1)} km/h -> wet=${wetF1Min.toFixed(1)} km/h`
);

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll racing-line checks passed.');
process.exit(failures.length ? 1 : 0);
