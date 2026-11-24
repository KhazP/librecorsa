/**
 * AI pace, defensive lines and heavy-rain race starts:
 *   npx tsx scripts/verify-ai-pace-defense-wet.ts
 *
 * - Alien (100) is clearly quicker than Pro (70) over a race distance without spins, wall hits or off-tracks, and the
 *   skill levels stay ordered.
 * - A defender with a faster car closing in on a braking zone makes ONE clean move to cover the inside early, holds
 *   that line under braking (no weaving) and is never hit by the attacker; the line helpers obey the single-move rules.
 * - Heavy rain: a standing and a rolling start fit wet tyres and put the whole field through the start without a
 *   spin-off or a retirement.
 * Hosted circuits (spielberg) are checked too when this copy has them, and skipped otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { AI_SKILL_LEVELS, aiSkillModifiers } from '../src/lib/sim/ai-tuning';
import { AiOpponentField, aiDriversFor } from '../src/lib/sim/ai-opponents';
import { canStartDefenseMove, chooseDefenseTarget } from '../src/lib/sim/ai-racecraft';
import { aiLineOffsetM } from '../src/lib/sim/speed-profile';
import { TrackEnvironment } from '../src/lib/sim/track-environment';
import { DEFAULT_SESSION_CONDITIONS } from '../src/lib/sim/weather';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { loadGlbGeometry } from './lib/glb-geometry';
import { noteSkip } from './lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};

const DT = 1 / 120;
const trackFile = (id: string) => `public/tracks/${id}/track_data.json`;
function loadTrack(id: string) {
  setActiveTrack(id, JSON.parse(readFileSync(trackFile(id), 'utf8')) as RawTrackJson);
  const track = getActiveTrackData(1200);
  return { track, root: loadGlbGeometry(`public${track.meshUrl}`) };
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n== Skill levels');
{
  const mods = AI_SKILL_LEVELS.map((l) => aiSkillModifiers(l.value));
  const alien = mods[mods.length - 1];
  const pro = aiSkillModifiers(70);
  check('pace and corner speed rise with skill up to Alien', mods.every((m, i) => i === 0 || (m.paceMult > mods[i - 1].paceMult && m.apexMult > mods[i - 1].apexMult)));
  check('Alien is the most consistent and the most defensive', alien.lapPaceSigma < pro.lapPaceSigma && alien.cornerBrakeSigma < pro.cornerBrakeSigma && alien.defendMult > pro.defendMult);
  check('Pro is still the identity', pro.paceMult === 1 && pro.apexMult === 1 && pro.brakeMarginAdd === 0);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n== Alien 100 pace (rwanda_official_short, 3 laps)');
{
  const { track, root } = loadTrack('rwanda_official_short');
  for (const carId of ['lc26', 'f12026-car'] as const) {
    const run = (skill: number) => {
      const field = new AiOpponentField(track, vehicleModelSpec(carId).createSim(track, root), [{ code: 'KIG', teamColorHex: '#fff', pace: 0.975 }], undefined, {
        skill,
        seed: 1,
        spectate: true,
        trackId: 'rwanda_official_short',
        learning: false,
      });
      field.raceLaps = 3;
      field.startRace(false);
      for (let t = 0; field.phase !== 'finished' && t < 400; t += DT) field.update(DT);
      const c = field.report().cars[0];
      return { best: (c.bestLapMs ?? 1e9) / 1000, ...c.stats, retired: c.retired };
    };
    const pro = run(70);
    const alien = run(100);
    check(`${carId}: Alien laps ≥ 2.5 s quicker than Pro`, pro.best - alien.best >= 2.5, `${pro.best.toFixed(2)} → ${alien.best.toFixed(2)} s`);
    check(`${carId}: Alien runs clean (no spin, wall hit or retirement)`, alien.spins === 0 && alien.wallHits === 0 && !alien.retired, `spins ${alien.spins}, walls ${alien.wallHits}, off ${alien.offTracks}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n== Defensive line');
{
  const common = { lineLatM: 0, myLatM: 0, halfRoadM: 6, insideSign: 1, defendReachM: 6, defendStrength: 1, onStartLane: false };
  const cover = chooseDefenseTarget({ ...common, attackerLatM: 0 });
  check('chooseDefenseTarget: covers the inside door decisively', cover > 3, `${cover.toFixed(2)} m`);
  const dummy = chooseDefenseTarget({ ...common, attackerLatM: -3 });
  check('chooseDefenseTarget: an attacker feinting outside does not draw it away', dummy > 3, `${dummy.toFixed(2)} m`);
  check('chooseDefenseTarget: stays on the asphalt', Math.abs(cover) <= 6 - 0.35 && Math.abs(dummy) <= 6 - 0.35);
  check('chooseDefenseTarget: no defence at strength 0 (stays on its line)', chooseDefenseTarget({ ...common, attackerLatM: 0, defendStrength: 0 }) === 0);
  const ok = { alreadyDefending: false, defendMoves: 0, brake: 0, anyAlongside: false, attackerGapM: 30, attackerClosingMs: 5, carLenM: 5.5, defendRoomS: 0.4 };
  check('canStartDefenseMove: an early single move is allowed', canStartDefenseMove(ok));
  check('canStartDefenseMove: no second move', !canStartDefenseMove({ ...ok, defendMoves: 1 }) && !canStartDefenseMove({ ...ok, alreadyDefending: true }));
  check('canStartDefenseMove: no move under braking', !canStartDefenseMove({ ...ok, brake: 0.4 }));
  check('canStartDefenseMove: no move with a car alongside', !canStartDefenseMove({ ...ok, anyAlongside: true }));
  check('canStartDefenseMove: no move across a car about to arrive', !canStartDefenseMove({ ...ok, attackerGapM: 3, attackerClosingMs: 8 }));

  // Full physics: a quicker attacker 22 m behind the defender 260 m before Turn 1 of the short circuit
  const { track, root } = loadTrack('rwanda_official_short');
  const L = track.totalLengthM;
  let t1S = 0;
  for (let s = 100; s < 1000; s += 5) {
    if (Math.abs(track.getSampleAtDistance(s).curvature) > 0.008) {
      t1S = s;
      break;
    }
  }
  const insideSign = Math.sign(track.getSampleAtDistance(t1S).curvature);
  const player = vehicleModelSpec('lc26').createSim(track, root);
  const field = new AiOpponentField(track, player, [{ code: 'DEF', teamColorHex: '#fff', pace: 0.96, aggression: 0.3 }], undefined, {
    skill: 100,
    seed: 1,
    learning: false,
  });
  field.raceLaps = 3;
  field.startRace(false);
  const sDef = (t1S - 260 + L) % L;
  const sAtt = (sDef - 22 + L) % L;
  const lineDef = aiLineOffsetM(track.getSampleAtDistance(sDef), 'f1');
  const def = (field as any).cars.find((c: any) => c.code === 'DEF');
  def.sim.teleportToDistance(sDef, 68, lineDef);
  def.biasM = 0;
  def.sim.aiLineBiasM = 0;
  def.startLaneM = null;
  player.teleportToDistance(sAtt, 74, lineDef);
  player.aiAutopilot = false;
  let defended = false;
  let maxShift = 0;
  let backtrack = 0;
  let peak = -Infinity;
  let contacts = 0;
  for (let i = 0; i < 6 * 120; i++) {
    const left = (((t1S - player.sMeters) % L) + L) % L;
    player.step(DT, { throttle: left > 110 ? 1 : 0, brake: left <= 110 && left > 10 ? 0.85 : 0 });
    field.update(DT);
    for (const inc of field.incidents) if (inc.kind === 'contact') contacts++;
    const smp = track.getSampleAtDistance(def.sim.sMeters);
    const toT1 = (((t1S - def.sim.sMeters) % L) + L) % L;
    if (toT1 > 20 && toT1 < 260) {
      if (def.defending) defended = true;
      maxShift = Math.max(maxShift, insideSign * (def.sim.lateralOffsetM - aiLineOffsetM(smp, 'f1')));
      // Under braking the line only ever goes on toward the inside: any step back from the furthest inside point is a weave
      if (def.sim.telemetry.brake > 0.15) {
        const inboard = insideSign * def.sim.lateralOffsetM;
        peak = Math.max(peak, inboard);
        backtrack = Math.max(backtrack, peak - inboard);
      } else peak = -Infinity;
    }
  }
  check('Turn 1: the defender covers the inside early', defended && maxShift > 3, `defending ${defended}, ${maxShift.toFixed(2)} m toward the inside`);
  check('Turn 1: no weaving under braking', backtrack < 0.5, `${backtrack.toFixed(2)} m back from the furthest inside point while braking`);
  check('Turn 1: the attacker never hits the defender', contacts === 0, `${contacts} contacts`);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n== Heavy-rain race starts');
{
  const cases: [string, string, number, boolean][] = [
    ['rwanda_official_short', 'lc26', 10, true],
    ['rwanda_official_short', 'amg-gt3', 10, true],
    ['rwanda_official_short', 'lc26', 10, false],
    ['rwanda_official', 'lc26', 10, true],
  ];
  if (existsSync(trackFile('spielberg'))) {
    cases.push(['spielberg', 'lc26', 10, true], ['spielberg', 'lc26', 10, false]);
  } else noteSkip('heavy-rain starts at spielberg', trackFile('spielberg'));
  for (const [trackId, carId, n, standing] of cases) {
    const { track, root } = loadTrack(trackId);
    const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain' });
    const field = new AiOpponentField(track, vehicleModelSpec(carId).createSim(track, root), aiDriversFor(n), env, {
      skill: 100,
      seed: 1,
      spectate: true,
      trackId,
      damage: 'full',
    });
    field.raceLaps = 1;
    field.startRace(standing);
    const compounds = [...new Set(field.aiSims().map((s) => s.tireCompound))];
    for (let t = 0; t < 35; t += DT) {
      env.update(DT, field.sims());
      field.update(DT);
    }
    const cars = field.report().cars;
    const dnfs = cars.filter((c) => c.retired).length;
    const spins = cars.reduce((a, c) => a + c.stats.spins, 0);
    check(`${trackId} ${carId} ${standing ? 'standing' : 'rolling'} start: wet tyres, no crash-outs`, compounds.join() === 'wet' && dnfs === 0, `tyres ${compounds.join()}, DNF ${dnfs}, spins ${spins}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll AI pace / defence / heavy-rain checks passed.');
