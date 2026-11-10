/**
 * Headless checks for the AI's racecraft and race control.
 *
 *   npx tsx scripts/verify-race-craft.ts
 *
 *  1. The judgements: overlap with hysteresis, who owns the corner, a pass that can't get alongside in time, the
 *     side to pass a hazard on, the yellow flag zone
 *  2. Race control: who is at fault in a contact, and what it costs (a penalty when it spun / damaged the other car,
 *     a warning when it didn't)
 *  3. Grid: reversed, the player's slot
 *  4. A quicker car gets past a slower one on Monza, cleanly
 *  5. A car stopped on the racing line: the car behind sees the yellow, goes round it, and doesn't hit it
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { AiOpponentField, launchReactionS, type FieldIncident } from '../src/lib/sim/ai-opponents';
import { hazardLine, inYellowZone, overlapNow, ownsCorner, passFeasible } from '../src/lib/sim/ai-racecraft';
import { COLLISION_PENALTY_S, judgeContact, RaceIncidents } from '../src/lib/sim/race-incidents';
import { loadGlbGeometry } from './lib/glb-geometry';
import { skipSuiteWithout } from './lib/hosted-files';

skipSuiteWithout('public/tracks/monza/track_data.json', 'public/tracks/monza/monza.glb');

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};
const f = (v: number, d = 1) => v.toFixed(d);

// ---- 1. Judgements
{
  check('Overlap: alongside within 0.85 car lengths', overlapNow(false, 4.0, 2.5, 5, 1.95) && !overlapNow(false, 4.6, 2.5, 5, 1.95));
  check('Overlap: stays alongside to 1.1 lengths (hysteresis)', overlapNow(true, 5.3, 2.5, 5, 1.95) && !overlapNow(true, 5.8, 2.5, 5, 1.95));
  // Right-hander (inside +), me on the right of the other car
  check('Corner: inside with the nose at its middle owns it', ownsCorner(2.0, 3, 0, 1, 5));
  check('Corner: inside but a car length back does not', !ownsCorner(4.0, 3, 0, 1, 5));
  check('Corner: alongside on the outside does not', !ownsCorner(0, -3, 0, 1, 5));
  check('Pass: on a long straight it can always be tried', passFeasible({ gapM: 30, closingMs: 2, speedMs: 80, distToCornerM: Infinity, brakingZoneM: 0 }));
  check(
    'Pass: 30 m back at 2 m/s closing, corner 150 m away: a lunge',
    !passFeasible({ gapM: 30, closingMs: 2, speedMs: 80, distToCornerM: 150, brakingZoneM: 120 })
  );
  check(
    'Pass: 8 m back at 6 m/s closing, corner 250 m away: on',
    passFeasible({ gapM: 8, closingMs: 6, speedMs: 80, distToCornerM: 250, brakingZoneM: 120 })
  );
  const hl = hazardLine(-2, 2.5, 6, 1.95);
  check('Hazard: passed on the side with room', hl !== null && hl.latM > 0.5, hl ? `line ${f(hl.latM)} m, room ${f(hl.roomM)} m` : 'blocked');
  check('Hazard: a road blocked across is blocked', hazardLine(0, 5.5, 6, 1.95) === null);
  const offRoad = hazardLine(-18, 3, 6, 1.95, -1);
  check('Hazard: a car stopped off the road draws no one toward it', offRoad !== null && offRoad.latM === -1, offRoad ? `line ${f(offRoad.latM)} m` : 'blocked');
  check('Yellow: 300 m before an incident, not 100 m past it', inYellowZone(1000, 1300, 5000) && !inYellowZone(1400, 1300, 5000));
  check('Yellow: across the line', inYellowZone(4900, 100, 5000));
}

// ---- 2. Race control
{
  const contact = (o: Partial<Extract<FieldIncident, { kind: 'contact' }>>): Extract<FieldIncident, { kind: 'contact' }> => ({
    kind: 'contact',
    a: 'YOU',
    b: 'MUS',
    aIsPlayer: true,
    bIsPlayer: false,
    impactMs: 5,
    dsM: 4.6,
    aLatM: 0,
    bLatM: 0.3,
    aLatSpeedMs: 0,
    bLatSpeedMs: 0,
    aBraking: true,
    bBraking: true,
    s: 500,
    ...o,
  });
  check('Fault: hit from behind, in line → the car behind', judgeContact(contact({})).atFault === 'a');
  check('Fault: alongside, one car moves across → that car', judgeContact(contact({ dsM: 1, aLatM: 0, bLatM: 2.2, bLatSpeedMs: -1.8 })).atFault === 'b');
  check('Fault: alongside, both drift together → racing incident', judgeContact(contact({ dsM: 1, aLatM: 0, bLatM: 2.2, aLatSpeedMs: 0.9, bLatSpeedMs: -0.9 })).atFault === null);

  const rc = new RaceIncidents('YOU');
  rc.update(10, [contact({})], false);
  rc.update(10.5, [{ kind: 'spin', code: 'MUS', isPlayer: false, s: 510 }], false);
  rc.update(13.5, [], false);
  check('Penalty: a rear-end that spins the other car costs 5 s', rc.penaltyOf('YOU') === COLLISION_PENALTY_S, `${rc.penaltyOf('YOU')} s`);
  check('Penalty: ... and race control says so', rc.messages.some((m) => m.kind === 'penalty' && m.player));
  const rc2 = new RaceIncidents('YOU');
  rc2.update(10, [contact({ impactMs: 4 })], false);
  rc2.update(13.5, [], false);
  check('Warning: the same contact with no consequence is a warning', rc2.penaltyOf('YOU') === 0 && rc2.playerContactWarnings === 1);
  const rc3 = new RaceIncidents('YOU');
  rc3.update(10, [contact({ a: 'RUB', b: 'MUS', aIsPlayer: false })], false);
  rc3.update(10.2, [{ kind: 'damage', code: 'MUS', isPlayer: false, source: 'car', report: { severity: 0.4, zone: 'rear', puncture: false, terminal: false } }], false);
  rc3.update(13.5, [], false);
  check('AI at fault: penalised and races with more caution', rc3.penaltyOf('RUB') === COLLISION_PENALTY_S && rc3.cautionOf('RUB', 20) > 0);
  const rc4 = new RaceIncidents('YOU');
  rc4.update(10, [], true);
  check('Yellow: shown when the player comes up on an incident', rc4.messages.some((m) => m.kind === 'yellow'));
}

// ---- Track for the driving checks
setActiveTrack('monza', JSON.parse(readFileSync('public/tracks/monza/track_data.json', 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const root = loadGlbGeometry(`public${track.meshUrl}`);
const DT = 1 / 120;

// ---- 3. Grid
{
  const player = new F12026CarSim(track, root);
  const drivers = [
    { code: 'AAA', teamColorHex: '#fff', pace: 0.97 },
    { code: 'BBB', teamColorHex: '#fff', pace: 0.96 },
    { code: 'CCC', teamColorHex: '#fff', pace: 0.95 },
  ];
  const field = new AiOpponentField(track, player, drivers, undefined, { gridOrder: 'reversed', playerGrid: 'front', learning: false, seed: 1 });
  field.startRace(true);
  const grid = field.report().cars.map((c) => [c.code, c.gridPos] as const);
  const slot = (code: string) => grid.find(([c]) => c === code)?.[1];
  check('Grid: the player on pole when asked', slot('YOU') === 1, grid.map(([c, g]) => `${c} P${g}`).join(' '));
  check('Grid: reversed puts the slowest AI first', (slot('CCC') ?? 0) < (slot('BBB') ?? 0) && (slot('BBB') ?? 0) < (slot('AAA') ?? 0));
}

// ---- 4. A quicker car gets by
// Four races from different seeds: where and when the quicker car closes up differs from one to the next, and so does
// whether its tow ends at a braking zone. It gets by in most, and a race with a hard contact is the exception: in one
// seed in eight the car behind sits a car length off the gearbox down a straight and nudges the leader when he brakes
{
  const results: string[] = [];
  let passes = 0;
  let racesWithContact = 0;
  let spins = 0;
  for (const seed of [4, 5, 6, 7]) {
    const field = new AiOpponentField(
      track,
      new F12026CarSim(track, root),
      [
        { code: 'SLO', teamColorHex: '#fff', pace: 0.945 },
        { code: 'FST', teamColorHex: '#fff', pace: 0.975, aggression: 0.2 },
      ],
      undefined,
      { seed, spectate: true, learning: false, gridOrder: 'reversed' }
    );
    field.raceLaps = 3;
    field.startRace(false);
    let passedAtS: number | null = null;
    let hardContacts = 0;
    for (let t = 0; t < 260 && passedAtS === null; t += DT) {
      field.update(DT);
      for (const i of field.incidents) if (i.kind === 'contact' && i.impactMs > 2) hardContacts++;
      if (field.status().standings[0]?.driverCode === 'FST' && t > 1) passedAtS = t;
    }
    if (passedAtS !== null) passes++;
    if (hardContacts > 0) racesWithContact++;
    spins += (field.carInfo('SLO')?.stats.spins ?? 0) + (field.carInfo('FST')?.stats.spins ?? 0);
    results.push(passedAtS !== null ? `${f(passedAtS)} s` : `no pass (${hardContacts} hard contacts)`);
  }
  check('Duel: a car 3 % quicker gets past within two laps, in 3 races of 4', passes >= 3, results.join(', '));
  check('Duel: ... a hard contact in one race at most, no spins', racesWithContact <= 1 && spins === 0, `${racesWithContact} race(s) with a hard contact, ${spins} spins`);
}

// ---- 5. A car stopped on the racing line
{
  const field = new AiOpponentField(
    track,
    new F12026CarSim(track, root),
    [
      { code: 'STP', teamColorHex: '#fff', pace: 0.95 },
      { code: 'RUN', teamColorHex: '#fff', pace: 0.95 },
    ],
    undefined,
    { seed: 2, spectate: true, learning: false, damage: 'full' }
  );
  field.raceLaps = 3;
  field.startRace(false);
  for (let t = 0; t < 12; t += DT) field.update(DT);
  const stp = field.carInfo('STP')!;
  const run = field.carInfo('RUN')!;
  // The running car on the main straight at speed, the stopped one on its line 400 m up the road, out of the race
  run.sim.teleportToDistance(80, 70, 0.5);
  stp.sim.teleportToDistance(480, 0, 0.5);
  stp.damage.registerImpact({ localX: 0, localZ: 2.5, speedMs: 60, source: 'wall' });
  let yellowSeen = false;
  let hit = false;
  let minClear = Infinity;
  let passed = false;
  const L = track.totalLengthM;
  // (carInfo is a snapshot: read the state again each time)
  const stpNow = () => field.carInfo('STP')!;
  for (let t = 0; t < 30 && !passed; t += DT) {
    field.update(DT);
    for (const i of field.incidents) if (i.kind === 'contact') hit = true;
    if (field.underYellow(run.sim.sMeters)) yellowSeen = true;
    const ds = ((stp.sim.sMeters - run.sim.sMeters + L * 1.5) % L) - L / 2;
    if (Math.abs(ds) < 5) minClear = Math.min(minClear, Math.abs(stp.sim.lateralOffsetM - run.sim.lateralOffsetM));
    if (ds < -30) passed = true;
  }
  check('Stopped car: the car behind is shown the yellow', yellowSeen);
  check('Stopped car: it goes round, not into it', passed && !hit, `${passed ? 'passed' : 'not past'}, lateral clearance ${f(minClear)} m${hit ? ', HIT' : ''}`);
  check('Stopped car: retired and classified DNF', stpNow().retired && !!field.status().standings.find((e) => e.driverCode === 'STP')?.retired);
}

// ---- Launch: reaction times like a real grid's, and off the line as quick as a flat-out launch
{
  check('Launch: an alien reacts in 0.12-0.22 s', launchReactionS(100, 0, 0.99) >= 0.119 && launchReactionS(100, 1, 0.99) <= 0.221, `${f(launchReactionS(100, 0, 0.99), 2)}-${f(launchReactionS(100, 1, 0.99), 2)} s`);
  check('Launch: a rookie reacts in 0.25-0.35 s', launchReactionS(0, 0, 0.99) >= 0.249 && launchReactionS(0, 1, 0.99) <= 0.351, `${f(launchReactionS(0, 0, 0.99), 2)}-${f(launchReactionS(0, 1, 0.99), 2)} s`);
  const bogRate = (skill: number) => {
    let n = 0;
    for (let i = 0; i < 1000; i++) if (launchReactionS(skill, 0.5, (i + 0.5) / 1000) > launchReactionS(skill, 0.5, 0.999) + 0.1) n++;
    return n / 1000;
  };
  check('Launch: bogged starts are rare for an alien, commoner for a rookie', bogRate(100) < 0.06 && bogRate(0) > 0.12, `${f(100 * bogRate(100), 0)} % / ${f(100 * bogRate(0), 0)} %`);

  // A flat-out launch from pole (the player holding the throttle down), as the yardstick
  const manual = new F12026CarSim(track, root);
  manual.resetToStartGrid(false, 0);
  const flatOut: number[] = [];
  const MAN = { throttle: 1, brake: 0, steerLeft: 0, steerRight: 0, manualOverride: false, toggleXMode: false, shiftUp: false, shiftDown: false };
  for (let t = 0; t < 3.5; t += DT) {
    manual.step(DT, MAN);
    flatOut.push(manual.telemetry.speedKmh);
  }
  const drivers = [
    { code: 'AAA', teamColorHex: '#fff', pace: 0.97 },
    { code: 'BBB', teamColorHex: '#fff', pace: 0.96 },
    { code: 'CCC', teamColorHex: '#fff', pace: 0.95 },
  ];
  const field = new AiOpponentField(track, new F12026CarSim(track, root), drivers, undefined, { spectate: true, learning: false, seed: 3, skill: 100 });
  field.attachTrackRoot(root as never);
  field.startRace(true);
  while (field.phase === 'lights') field.update(DT);
  for (let t = 0; t < 3; t += DT) field.update(DT);
  const cars = (field as unknown as { cars: { code: string; ai: F12026CarSim | null; launchReactS: number }[] }).cars.filter((c) => c.ai);
  const shares = cars.map((c) => c.ai!.telemetry.speedKmh / flatOut[Math.max(0, Math.round((3 - c.launchReactS) / DT) - 1)]);
  check(
    'Launch: 3 s after the lights, each AI car is as quick as a flat-out launch after its reaction',
    shares.every((x) => x > 0.93),
    cars.map((c, i) => `${c.code} ${f(c.ai!.telemetry.speedKmh, 0)} km/h (${f(100 * shares[i], 0)} %, react ${f(c.launchReactS, 2)} s)`).join(', ')
  );
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll racecraft checks passed.');
if (failures.length) process.exit(1);
