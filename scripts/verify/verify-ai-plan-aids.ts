/**
 * The Assisted TC and ABS for AI cars on their plans (`RacecraftParams.planAids`): with it on, the field gives them to
 * an AI Liana on its plan and to no other car; off (the default), to none. The player's car is never given them.
 *
 * Grobnik is hosted on librecorsa.org only: skipped where this copy has no track file or mesh.
 *
 * Usage: NEXT_PUBLIC_HOSTED_CONTENT=1 npx tsx scripts/verify/verify-ai-plan-aids.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { AiOpponentField, type RacecraftParams } from '../../src/lib/sim/ai-opponents';
import { getActiveTrackData, setActiveTrack, type AiPlanCheck, type RawTrackJson, type TrackMetaExtras } from '../../src/lib/track-data';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const TRACK = 'grobnik';
const CAR = 'liana';
const file = `public/tracks/${TRACK}/track_data.json`;

/** 20 s of a race from the grid: whether the AI cars and the player's car ended with the Assisted aids; null: skipped */
function race(onPlan: boolean, racecraft: Partial<RacecraftParams>): { ai: boolean[]; player: boolean; planned: boolean } | null {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawTrackJson;
  const meta = raw.metadata as RawTrackJson['metadata'] & TrackMetaExtras;
  const byLine = (meta.aiPlansByLine ??= {}) as Record<string, Record<string, AiPlanCheck>>;
  const known = byLine.gt3?.[CAR];
  if (!known) return null;
  byLine.gt3 = { ...byLine.gt3, [CAR]: { ...known, ok: onPlan } };
  setActiveTrack(TRACK, raw);
  const track = getActiveTrackData(1200);
  if (!existsSync(`public${track.meshUrl}`)) return null;
  const player = vehicleModelSpec(CAR).createSim(track, loadGlbGeometry(`public${track.meshUrl}`));
  const drivers = [
    { code: 'AAA', teamColorHex: '#fff', pace: 0.97 },
    { code: 'BBB', teamColorHex: '#f00', pace: 0.96 },
  ];
  // (lap 1 on its own driver would hide the plan: the check is on lap 1)
  const field = new AiOpponentField(track, player, drivers, undefined, { seed: 1, learning: false, trackId: TRACK, racecraft: { planLap1Own: 0, ...racecraft } });
  field.raceLaps = 2;
  field.startRace(true);
  // The player's car on the autopilot: the one way the field could reach its aids
  player.aiAutopilot = true;
  for (let t = 0; t < 20; t += 1 / 120) {
    player.step(1 / 120, {});
    field.update(1 / 120);
  }
  const flag = (s: unknown) => (s as { aiAssistedAids?: boolean }).aiAssistedAids === true;
  const ai = field.aiSims();
  return { ai: ai.map(flag), player: flag(player), planned: ai.every((s) => !!s.aiPlan) };
}

if (!existsSync(file)) {
  noteSkip('plan aids', file);
} else {
  const on = race(true, { planAids: 1 });
  if (!on) noteSkip('plan aids', `the ${CAR} plan check or the mesh of ${TRACK}`);
  else {
    const off = race(true, {})!;
    const own = race(false, { planAids: 1 })!;
    const f = (r: { ai: boolean[]; player: boolean; planned: boolean }) => `AI ${r.ai.join('/')}, player ${r.player}, on plans ${r.planned}`;
    check('planAids 1: every AI car on its plan has the Assisted aids', on.planned && on.ai.every(Boolean), f(on));
    check('planAids 1: the player\'s car does not', !on.player, f(on));
    check('default (planAids 0): no car has them', !off.ai.some(Boolean) && !off.player, f(off));
    check('planAids 1, own driver (no plan): no car has them', !own.planned && !own.ai.some(Boolean) && !own.player, f(own));
  }
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log('\nall passed');
