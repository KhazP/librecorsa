/**
 * Per-car plan tracking (src/lib/sim/ai/plan-tracking.ts): the F1 cars and the GT3 keep the look-ahead their hosted
 * checks were made on; a car tracking plans its own way reads only this build's checks (`aiPlansByLine`), never the
 * hosted `aiPlans` an older build checked for it.
 *
 *   npx tsx scripts/verify/verify-plan-tracking.ts
 */
import { readFileSync } from 'node:fs';
import { planCheckFor, racingLineFor, setActiveTrack, type AiPlanCheck, type RawTrackJson } from '../../src/lib/track-data';
import { PLAN_LOOK_S, PLAN_LOOK_S_DEFAULT, planLookS, tracksOwnPlanChecks } from '../../src/lib/sim/ai/plan-tracking';
import type { VehicleModelId } from '../../src/types/f1';

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};
const pass = (lapS: number): AiPlanCheck => ({ ok: true, physicsLapS: lapS, planLapS: lapS - 1, wallHits: 0, offTrackFrames: 0, maxErrM: 1, checked: '2026-11-24', maxGrip: 1.04 });

for (const car of ['lc26', 'f12026-car', 'amg-gt3'] as const)
  check(`${car} tracks plans as its hosted checks were made (${PLAN_LOOK_S_DEFAULT} s)`, planLookS(car) === PLAN_LOOK_S_DEFAULT && !tracksOwnPlanChecks(car));
const own = Object.keys(PLAN_LOOK_S) as VehicleModelId[];
check('the Liana tracks plans its own way', own.includes('liana'));
check('every listed look-ahead is longer than the default and under a second', own.every((c) => planLookS(c) > PLAN_LOOK_S_DEFAULT && planLookS(c) < 1));

const raw = JSON.parse(readFileSync('public/tracks/rwanda_official_short/track_data.json', 'utf8')) as { metadata: Record<string, unknown> };
const meta = raw.metadata;
// (as a circuit with none of this build's checks: the file may carry some)
delete meta.aiPlansByLine;
meta.aiPlans = { ...(meta.aiPlans as object), liana: pass(177), 'amg-gt3': pass(110) };
setActiveTrack('rwanda_official_short', raw as unknown as RawTrackJson);
check('an older build\'s check of a car now tracking its own way is not used', planCheckFor('liana', 'gt3') === undefined);
check('...so that car keeps its own driver where this build has no check for it', planCheckFor('liana', racingLineFor('road', 'liana'))?.ok !== true);
check('the GT3 still reads its hosted check', planCheckFor('amg-gt3', 'gt3')?.physicsLapS === 110);

meta.aiPlansByLine = { gt3: { liana: pass(173) } };
setActiveTrack('rwanda_official_short', raw as unknown as RawTrackJson);
check('this build\'s check of the Liana on the GT3 line is used', planCheckFor('liana', 'gt3')?.physicsLapS === 173);
check('...and does not move it onto the road line', racingLineFor('road', 'liana') === 'gt3');
check('the GT3 is not affected by it', planCheckFor('amg-gt3', 'gt3')?.physicsLapS === 110);

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
