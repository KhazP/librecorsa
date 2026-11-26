/**
 * The defensive move of a car on a drive plan that tracks plans its own way (`RacecraftParams.planDefendReachM`): a
 * Liana covering the inside before Grobnik's left-hander at the end of the back straight, a quicker car 22 m behind it.
 *
 * 1. On its own driver the Liana covers the inside as it always did (more than 3 m toward it): unchanged.
 * 2. On its plan with no reach limit (the old rule) it makes a bigger move still: what the limit changes.
 * 3. On its plan with the shipped rules it still defends, within `planDefendReachM` of its line all the way to the
 *    corner, and the attacker never touches it.
 *
 * Grobnik is hosted on librecorsa.org only: skipped where this copy has no track file or mesh.
 *
 * Usage: NEXT_PUBLIC_HOSTED_CONTENT=1 npx tsx scripts/verify/verify-ai-plan-defence.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { AiOpponentField, DEFAULT_RACECRAFT, type RacecraftParams } from '../../src/lib/sim/ai-opponents';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { getActiveTrackData, setActiveTrack, type AiPlanCheck, type RawTrackJson, type TrackMetaExtras } from '../../src/lib/track-data';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 120;
const TRACK = 'grobnik';
const CAR = 'liana';
const file = `public/tracks/${TRACK}/track_data.json`;

interface Run {
  defended: boolean;
  /** The furthest the defender went toward the corner's inside, off its line (m) */
  maxShift: number;
  contacts: number;
}

/**
 * One defence: the Liana on its plan (`onPlan`) or its own driver, with these racecraft knobs on top; null where this
 * copy has no plan check for it or no mesh
 */
function defend(onPlan: boolean, racecraft: Partial<RacecraftParams>): Run | null {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawTrackJson;
  const meta = raw.metadata as RawTrackJson['metadata'] & TrackMetaExtras;
  const byLine = (meta.aiPlansByLine ??= {}) as Record<string, Record<string, AiPlanCheck>>;
  const known = byLine.gt3?.[CAR];
  if (!known) return null;
  byLine.gt3 = { ...byLine.gt3, [CAR]: { ...known, ok: onPlan } };
  setActiveTrack(TRACK, raw);
  const track = getActiveTrackData(1200);
  if (!existsSync(`public${track.meshUrl}`)) return null;
  const root = loadGlbGeometry(`public${track.meshUrl}`);
  const L = track.totalLengthM;
  // The left-hander at the end of the long back straight (~3260 m): the defence is set up on the straight before it
  let cornerS = 0;
  for (let ss = 2950; ss < 3600; ss += 5) {
    if (Math.abs(track.getSampleAtDistance(ss).curvature) > 0.008) {
      cornerS = ss;
      break;
    }
  }
  const insideSign = Math.sign(track.getSampleAtDistance(cornerS).curvature);
  const template = vehicleModelSpec(CAR).createSim(track, root);
  // A quicker, bolder car 22 m behind on the straight: the defender's attacker
  const drivers = [
    { code: 'DEF', teamColorHex: '#fff', pace: 0.96, aggression: 0.3 },
    { code: 'ATT', teamColorHex: '#f00', pace: 1, aggression: 0.8 },
  ];
  const field = new AiOpponentField(track, template, drivers, undefined, {
    skill: 100,
    seed: 1,
    learning: false,
    spectate: true,
    trackId: TRACK,
    // (lap 1 on its own driver would hide the plan: the test is on lap 1)
    racecraft: { planLap1Own: 0, ...racecraft },
  });
  field.raceLaps = 3;
  field.startRace(false);
  const sDef = (cornerS - 260 + L) % L;
  const sAtt = (sDef - 22 + L) % L;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cars = (field as any).cars as any[];
  const def = cars.find((c) => c.code === 'DEF');
  const att = cars.find((c) => c.code === 'ATT');
  for (const [c, s, v] of [[def, sDef, 44], [att, sAtt, 48]] as const) {
    c.sim.teleportToDistance(s, v, aiLineOffsetM(track.getSampleAtDistance(s), 'gt3'));
    c.biasM = 0;
    c.sim.aiLineBiasM = 0;
    c.startLaneM = null;
  }
  let defended = false;
  let maxShift = 0;
  let contacts = 0;
  for (let i = 0; i < 8 * 120; i++) {
    field.update(DT);
    for (const inc of field.incidents) if (inc.kind === 'contact') contacts++;
    const toCorner = (((cornerS - def.sim.sMeters) % L) + L) % L;
    if (toCorner > 5 && toCorner < 260) {
      if (def.defending) defended = true;
      const smp = track.getSampleAtDistance(def.sim.sMeters);
      maxShift = Math.max(maxShift, insideSign * (def.sim.lateralOffsetM - aiLineOffsetM(smp, 'gt3')));
    }
  }
  return { defended, maxShift, contacts };
}

if (!existsSync(file)) {
  noteSkip('plan defence', file);
} else {
  const own = defend(false, {});
  if (!own) noteSkip('plan defence', `the ${CAR} plan check or the mesh of ${TRACK}`);
  else {
    const old = defend(true, { planDefendReachM: 0 })!;
    const now = defend(true, {})!;
    const f = (r: Run) => `defending ${r.defended}, ${r.maxShift.toFixed(2)} m toward the inside, ${r.contacts} contacts`;
    check('own driver: covers the inside as before (> 3 m)', own.defended && own.maxShift > 3, f(own));
    check('plan, no reach limit: the big move (> 3 m)', old.defended && old.maxShift > 3, f(old));
    const cap = DEFAULT_RACECRAFT.planDefendReachM;
    check(`plan, shipped rules: defends within ${cap} m of its line (+0.6 m tracking)`, cap > 0 && now.defended && now.maxShift <= cap + 0.6, f(now));
    check('no contact in any of the three', own.contacts + old.contacts + now.contacts === 0, `${own.contacts} / ${old.contacts} / ${now.contacts}`);
  }
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall passed');
