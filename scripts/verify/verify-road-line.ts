/**
 * The road cars' line (`roRoad`): read from a circuit's samples where it has one, the GT3's line elsewhere, and driven
 * by a road car only where its plan check on it passed (`aiPlansByLine.road`, a key older builds ignore). The F1 and
 * GT3 lines and `aiPlans` read as before.
 *
 *   npx tsx scripts/verify/verify-road-line.ts
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, planCheckFor, racingLineFor, setActiveTrack, type AiPlanCheck, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { createSuzukiLianaSim } from '../../src/lib/sim/road/SuzukiLianaSim';
import { createNissanR33Sim } from '../../src/lib/sim/classic/NissanR33Sim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { ownPaceFor, ownSpeedAt, racingLineOfVehicle, vehicleOwnSpeedMs } from '../../src/lib/sim/own-pace';
import type { RacingLineId, VehicleModelId } from '../../src/types/f1';
import { makers } from '../lib/setup-cars';

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};
const TRACK = 'rwanda_official_short';
interface Raw {
  samples: { ro: number; roGt3?: number; roRoad?: number }[];
  metadata: Record<string, unknown>;
}
const base = JSON.parse(readFileSync(`public/tracks/${TRACK}/track_data.json`, 'utf8')) as Raw;
const activate = (raw: Raw) => setActiveTrack(TRACK, raw as unknown as RawTrackJson);
const pass = (lapS: number): AiPlanCheck => ({ ok: true, physicsLapS: lapS, planLapS: lapS - 1, wallHits: 0, offTrackFrames: 0, maxErrM: 1, checked: '2026-11-24', maxGrip: 1.04 });
const fail = (lapS: number): AiPlanCheck => ({ ...pass(lapS), ok: false, wallHits: 2 });

// A circuit with no road line, the Liana's check on the GT3's line made on this build's plan tracking (plan-tracking.ts)
const plain = structuredClone(base);
plain.metadata.aiPlansByLine = { gt3: { liana: pass(177) } };
activate(plain);
let track = getActiveTrackData(1200);
const gt3At = track.samples.map((smp) => aiLineOffsetM(smp, 'gt3'));
check('no road line: the samples carry none', track.samples.every((smp) => smp.racingLineOffsetRoad === undefined));
check('no road line: the road line is the GT3\'s', track.samples.every((smp, i) => aiLineOffsetM(smp, 'road') === gt3At[i]));
check('no road line: a road car drives the GT3\'s line', racingLineFor('road', 'liana') === 'gt3');
check('...with its check there', planCheckFor('liana', racingLineFor('road', 'liana'))?.physicsLapS === 177);
check('the F1 and GT3 lines are untouched', racingLineFor('f1', 'lc26') === 'f1' && racingLineFor('gt3', 'amg-gt3') === 'gt3');
check('a Liana built here drives the GT3\'s line', createSuzukiLianaSim(track, null).racingLineId === 'gt3');

// The same circuit with a road line 2 m right of the GT3's and the Liana's check on it
const withRoad = structuredClone(plain);
withRoad.samples.forEach((smp) => (smp.roRoad = (smp.roGt3 ?? smp.ro) + 2));
withRoad.metadata.aiPlansByLine = { gt3: { liana: pass(177) }, road: { liana: pass(172), 'vw-scirocco-gtx': fail(160) } };
activate(withRoad);
track = getActiveTrackData(1200);
check('road line: every sample carries it', track.samples.every((smp) => typeof smp.racingLineOffsetRoad === 'number'));
const gt3Now = track.samples.map((smp) => aiLineOffsetM(smp, 'gt3'));
check('road line: the GT3\'s line is read as before', gt3Now.every((g, i) => Math.abs(g - gt3At[i]) < 1e-9));
const apart = track.samples.map((smp, i) => aiLineOffsetM(smp, 'road') - gt3Now[i]);
check('road line: 2 m right of the GT3\'s, as written', apart.every((d) => Math.abs(d - 2) < 1e-6));
const mid = track.getSampleAtDistance(track.totalLengthM * 0.377);
check('road line: interpolated between samples too', Math.abs(aiLineOffsetM(mid, 'road') - aiLineOffsetM(mid, 'gt3') - 2) < 1e-6);
check('a road car whose check on it passed drives it', racingLineFor('road', 'liana') === 'road');
check('...with that check', planCheckFor('liana', 'road')?.physicsLapS === 172);
check('a road car whose check failed keeps the GT3\'s line', racingLineFor('road', 'vw-scirocco-gtx') === 'gt3');
check('a road car never checked keeps the GT3\'s line', racingLineFor('road', 'bmw-m1-procar') === 'gt3');
check('the road line\'s checks never answer for the GT3\'s line', planCheckFor('vw-scirocco-gtx', 'gt3') === undefined);
check('the Liana\'s GT3-line check is still there for circuits it drives the GT3\'s line on', planCheckFor('liana', 'gt3')?.physicsLapS === 177);
const liana = createSuzukiLianaSim(track, null);
check('a Liana built here drives the road line', liana.racingLineId === 'road');
check('...and its braking guide (the drawn line) is the road line\'s', liana.brakingGuide.line === 'road');
check('the R33 stays on the GT3\'s line', createNissanR33Sim(track, null).racingLineId === 'gt3');
check('the AMG stays on the GT3\'s line', createAmgGt3Sim(track, null).racingLineId === 'gt3');

// A car's own pace for the online flags (own-pace.ts) is judged on the line that car drives here, not the GT3's
const ownOn = (v: VehicleModelId, line: RacingLineId, s: number) => ownSpeedAt(ownPaceFor(track, v, line)!, s, true);
const sAt = [0.12, 0.31, 0.47, 0.66, 0.83].map((f) => f * track.totalLengthM);
check('a Liana\'s own pace online is its road line\'s', racingLineOfVehicle('liana') === 'road' && sAt.every((s) => vehicleOwnSpeedMs(track, 'liana', s) === ownOn('liana', 'road', s)));
check('a Scirocco whose road-line check failed is judged on the GT3\'s line', racingLineOfVehicle('vw-scirocco-gtx') === 'gt3' && sAt.every((s) => vehicleOwnSpeedMs(track, 'vw-scirocco-gtx', s) === ownOn('vw-scirocco-gtx', 'gt3', s)));
// The table own-pace.ts keeps is each car's own profile line: with every model's road-line check passing (so a road
// line in the table shows), every model built here drives the line it names
const models = Object.keys(makers) as VehicleModelId[];
const allRoad = structuredClone(withRoad);
allRoad.metadata.aiPlansByLine = { road: Object.fromEntries(models.map((v) => [v, pass(170)])) };
activate(allRoad);
track = getActiveTrackData(1200);
const lineTableOk = models.filter((v) => makers[v](track).racingLineId !== racingLineOfVehicle(v));
check('every model\'s own-pace line is the line its car drives', lineTableOk.length === 0);
if (lineTableOk.length) console.log(`  differ: ${lineTableOk.join(', ')}`);

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
