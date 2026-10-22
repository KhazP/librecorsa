/**
 * AI tuning: file layering (defaults → class → vehicle → track → sections), skill scaling, the target-speed
 * builder (identity at the defaults, earlier braking with a margin), the per-corner learner's bounds, seeded
 * randomness, and the split timer behind the HUD's gaps to the cars ahead and behind.
 * Run: npx tsx scripts/verify-ai-tuning.ts
 */
import { getRwandaTrackData } from '../src/lib/track-data';
import { computeSpeedProfile, createVf26ProfileCarModel } from '../src/lib/sim/speed-profile';
import {
  AI_SKILL_DEFAULT,
  AI_SKILL_LEVELS,
  AI_TUNING_DEFAULTS,
  AiTrackTuning,
  aiSkillModifiers,
  buildTargetSpeedProfile,
  cornerSections,
  decelEnvelope,
  resolveAiTuning,
  resolveSectionRanges,
  sanitizeTuningFile,
  seededRng,
  type AiTuningLibrary,
} from '../src/lib/sim/ai-tuning';
import { AI_TUNING_LIBRARY } from '../src/lib/sim/ai-tuning-data';
import { AiSectionLearner, LEARN_BOUNDS, type CornerFrame } from '../src/lib/sim/ai-learning';
import { AI_DRIVERS, AiOpponentField } from '../src/lib/sim/ai-opponents';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { SplitTimer } from '../src/lib/sim/race-session';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

const track = getRwandaTrackData(1200);
const L = track.totalLengthM;

console.log('Resolution: defaults → class → vehicle → track → sections');
const lib: AiTuningLibrary = {
  gt3: sanitizeTuningFile({
    params: { brakeMargin: 0.05, steerGain: 1.1, pace: 7, bogus: 3 },
    vehicles: { 'amg-gt3': { steerGain: 0.9 } },
    sections: [{ label: 'class-wide', fromM: 100, toM: 200, params: { apexSpeedScale: 0.9 } }],
  }),
  'gt3.rwanda': sanitizeTuningFile({
    params: { brakeMargin: 0.08 },
    vehicles: { 'amg-gt3': { overtakeCaution: 0.9 } },
    sections: [
      { label: 'T1', turns: [1], leadInM: 100, params: { brakeMargin: 0.2, intMarginM: 1.5 } },
      { label: 'junk', params: { brakeMargin: 0.3 } },
      { label: 'range', fromM: 5200, toM: 50, params: { steerGain: 1.3 } },
    ],
  }),
};
const none = resolveAiTuning({ classId: 'f1-2026' }, lib);
check('no files: the built-in defaults', JSON.stringify(none.params) === JSON.stringify(AI_TUNING_DEFAULTS) && none.sources.join() === 'defaults');
const r = resolveAiTuning({ classId: 'gt3', vehicleId: 'amg-gt3', trackId: 'rwanda' }, lib);
check('class sets, track overrides it', near(r.params.brakeMargin, 0.08));
check('vehicle block overrides the class', near(r.params.steerGain, 0.9));
check('track vehicle block applies last', near(r.params.overtakeCaution, 0.9));
check('out-of-range values are clamped, unknown keys dropped', near(r.params.pace, 1.05) && !('bogus' in r.params));
check('a section without a range or turns is dropped', r.sections.length === 3, `${r.sections.length} sections`);
check('sources list every layer', r.sources.join(' > ') === 'defaults > gt3 > gt3:amg-gt3 > gt3.rwanda > gt3.rwanda:amg-gt3 > gt3.rwanda#sections(2)', r.sources.join(' > '));
const other = resolveAiTuning({ classId: 'gt3', vehicleId: 'amg-gt3', trackId: 'suzuka' }, lib);
check('another circuit keeps the class values', near(other.params.brakeMargin, 0.05) && other.sections.length === 1);

const ranges = resolveSectionRanges(track, r.sections);
const t1 = ranges.find((s) => s.label === 'T1');
const t1Start = track.samples.findIndex((s) => s.turnNumber === 1) * (L / track.samples.length);
check('turns resolve to the turn with its braking lead-in', Boolean(t1) && near(t1!.fromM, t1Start - 100, 1e-6), `T1 ${t1?.fromM.toFixed(0)}–${t1?.toM.toFixed(0)} m`);
const tuning = new AiTrackTuning(track, r);
check('inside a section its override applies', near(tuning.at('brakeMargin', t1Start + 5), 0.2, 1e-6) && near(tuning.at('intMarginM', t1Start + 5), 1.5, 1e-6));
check('outside it the resolved value', near(tuning.at('brakeMargin', 2600), 0.08, 1e-6) && tuning.at('intMarginM', 2600) === 0);
check('a range over the start line wraps', near(tuning.at('steerGain', 5250), 1.3, 1e-6) && near(tuning.at('steerGain', 20), 1.3, 1e-6) && near(tuning.at('steerGain', 60), 0.9, 1e-6));
check('class-wide sections still apply', near(tuning.at('apexSpeedScale', 150), 0.9, 1e-6));

console.log('Shipped files (public/ai)');
for (const [k, f] of Object.entries(AI_TUNING_LIBRARY)) check(`${k}.json parses`, Boolean(f && f.params));
const suz = resolveAiTuning({ classId: 'f1-2026', vehicleId: 'vf26', trackId: 'suzuka' }, AI_TUNING_LIBRARY);
check('Suzuka F1 has its Degner section', suz.sections.some((s) => s.label?.startsWith('Degner')));
const shipped = resolveAiTuning({ classId: 'f1-2026', vehicleId: 'vf26', trackId: 'rwanda' }, AI_TUNING_LIBRARY);
check('shipped F1 class values are the identity defaults', JSON.stringify(shipped.params) === JSON.stringify(AI_TUNING_DEFAULTS));

console.log('Skill');
const pro = aiSkillModifiers(AI_SKILL_DEFAULT);
check('Pro is the identity', pro.paceMult === 1 && pro.brakeMarginAdd === 0 && pro.apexMult === 1 && pro.mistakesPerLap === 0 && pro.cautionAdd === 0);
const mods = AI_SKILL_LEVELS.map((l) => aiSkillModifiers(l.value));
check(
  'pace and corner speed rise with skill, margins, errors and mistakes fall',
  mods.every(
    (m, i) =>
      i === 0 ||
      (m.paceMult > mods[i - 1].paceMult &&
        m.apexMult > mods[i - 1].apexMult &&
        m.brakeMarginAdd <= mods[i - 1].brakeMarginAdd &&
        m.lapPaceSigma < mods[i - 1].lapPaceSigma &&
        m.mistakesPerLap <= mods[i - 1].mistakesPerLap)
  )
);
const mid = aiSkillModifiers(52.5);
check('interpolates between the anchors', near(mid.paceMult, (mods[1].paceMult + mods[2].paceMult) / 2, 1e-9));
check('out-of-range skill clamps', aiSkillModifiers(-50).paceMult === mods[0].paceMult && aiSkillModifiers(500).paceMult === mods[3].paceMult);

const playerVf = new F1Physics2026(track);
const paceAt = (skill: number) => new AiOpponentField(track, playerVf, AI_DRIVERS, undefined, { skill, seed: 3 }).report().cars.filter((c) => !c.isPlayer).map((c) => c.pace);
const pacePro = paceAt(AI_SKILL_DEFAULT);
check('at Pro every driver keeps his written pace', pacePro.every((p, i) => near(p, AI_DRIVERS[i].pace, 1e-12)), pacePro.join(' '));
const paces = AI_SKILL_LEVELS.map((l) => paceAt(l.value));
check('the field keeps its spread at every level', paces.every((ps) => ps.every((p, i) => i === 0 || p < ps[i - 1])));
check('Rookie < Amateur < Pro < Alien for every driver', paces.every((ps, k) => k === 0 || ps.every((p, i) => p > paces[k - 1][i])), paces.map((ps) => ps[0].toFixed(3)).join(' < '));

console.log('Target speed');
for (const [name, base] of [
  ['VF26 profile', computeSpeedProfile(track.samples, createVf26ProfileCarModel('balanced')).speedMs],
  ['f12026-car autopilot profile', new F12026CarSim(track).aiBaseSpeedProfile()],
] as const) {
  const env = decelEnvelope(base, L);
  const id = buildTargetSpeedProfile(base, track, () => ({ brakeMargin: 0, apexScale: 1, bumpCaution: 0 }), env);
  let maxDiff = 0;
  for (let i = 0; i < base.length; i++) maxDiff = Math.max(maxDiff, Math.abs(id[i] - Math.max(6, base[i])));
  check(`${name}: the defaults give the profile back`, maxDiff < 1e-3, `max diff ${maxDiff.toExponential(1)} m/s`);
  const early = buildTargetSpeedProfile(base, track, () => ({ brakeMargin: 0.15, apexScale: 1, bumpCaution: 0 }), env);
  let never = true;
  let slowerM = 0;
  const ds = L / base.length;
  for (let i = 0; i < base.length; i++) {
    if (early[i] > id[i] + 1e-6) never = false;
    if (early[i] < id[i] - 0.5) slowerM += ds;
  }
  check(`${name}: a 15 % brake margin only lowers speeds, before corners`, never && slowerM > 100, `${slowerM.toFixed(0)} m of the lap slower`);
  const slow = buildTargetSpeedProfile(base, track, () => ({ brakeMargin: 0, apexScale: 0.95, bumpCaution: 0 }), env);
  let minBase = Infinity;
  let minSlow = Infinity;
  for (let i = 0; i < base.length; i++) {
    minBase = Math.min(minBase, id[i]);
    minSlow = Math.min(minSlow, slow[i]);
  }
  check(`${name}: apex scale 0.95 takes 5 % off the slowest corner`, near(minSlow / minBase, 0.95, 0.01), `${(minBase * 3.6).toFixed(0)} → ${(minSlow * 3.6).toFixed(0)} km/h`);
}

console.log('Learning');
const corners = cornerSections(track);
check('the lap is cut into corners covering it all', corners.length >= 8 && Array.from({ length: 53 }, (_, i) => i * 100).every((s) => corners.some((c) => (c.fromM <= c.toM ? s >= c.fromM && s < c.toM : s >= c.fromM || s < c.toM))), `${corners.length} corners`);
const learner = new AiSectionLearner(corners, L);
const drive = (frame: Partial<CornerFrame>, laps: number) => {
  for (let lap = 0; lap < laps; lap++) {
    for (let s = 0; s < L; s += 2) learner.observe({ s, offTrack: false, lineErrorM: 0.3, maxSlip: 0.7, lockup: false, trafficBiasM: 0, contact: false, ...frame });
  }
};
drive({ offTrack: true }, 30);
const afterOff = learner.snapshot();
check('incidents push the brake point earlier, up to the bound', afterOff.every((c) => near(c.brakeMargin, LEARN_BOUNDS.brakeMargin[1], 1e-9) && near(c.apex, LEARN_BOUNDS.apex[0], 1e-9)));
drive({}, 100);
const afterClean = learner.snapshot();
check('clean corners bring it back, never past the bounds', afterClean.every((c) => c.brakeMargin === 0 && near(c.apex, LEARN_BOUNDS.apex[1], 1e-9)));
const before = JSON.stringify(learner.snapshot().map((c) => [c.brakeMargin, c.apex]));
drive({ offTrack: true, contact: true }, 5);
drive({ offTrack: true, trafficBiasM: 2 }, 5);
check('corners in traffic teach nothing', JSON.stringify(learner.snapshot().map((c) => [c.brakeMargin, c.apex])) === before);

console.log('Seeded randomness');
const a = seededRng(42);
const b = seededRng(42);
const c = seededRng(43);
const seqA = Array.from({ length: 5 }, a);
check('a seed repeats its sequence', JSON.stringify(seqA) === JSON.stringify(Array.from({ length: 5 }, b)));
check('another seed does not', JSON.stringify(seqA) !== JSON.stringify(Array.from({ length: 5 }, c)));

console.log('Split timer');
const timer = new SplitTimer();
// A runs 60 m/s from 100 m, B 50 m/s from 0 m, sampled at 120 Hz
for (let t = 0; t <= 20; t += 1 / 120) {
  timer.record('A', t, 100 + 60 * t);
  timer.record('B', t, 50 * t);
}
const tNow = 20;
const dB = 50 * tNow;
const expected = tNow - (dB - 100) / 60;
const gap = timer.gapS(tNow, 'A', dB);
check('gap ahead = time since the car ahead passed this point', gap !== null && near(gap, expected, 2e-3), `${gap?.toFixed(4)} s vs ${expected.toFixed(4)} s`);
check('no gap where the car has not been yet', timer.gapS(tNow, 'B', 100 + 60 * tNow) === null);

console.log(`\nAll ${passed} AI tuning checks passed.`);
