/**
 * Headless checks for the overtaking aids by era (`src/lib/sim/overtaking-rules.ts`): the 1 s and lap rules, the car
 * ahead on the road (lapped cars included), Overtake Mode's grant, and the flaps (2026 Straight Mode in every zone,
 * rear-flap DRS by the detection point before).
 *
 *   npx tsx scripts/verify-overtaking-rules.ts
 */
import {
  carAheadOnRoad,
  crossedForward,
  DETECTION_GAP_S,
  earnedAtDetection,
  OVERTAKE_EXTRA_DEPLOY_J,
  OvertakeGrant,
  overtakeDetectionZone,
  overtakingRulesForSeason,
  type OvertakingRaceControl,
} from '../src/lib/sim/overtaking-rules';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { CARS } from '../src/lib/cars/car-registry';
import { getActiveTrackData } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);

// ---------------------------------------------------------------------------
console.log('== Rules by season');
check('2026 cars: Straight Mode + Overtake', overtakingRulesForSeason(2026) === 'straight-mode-2026');
check('2011 to 2025: rear-flap DRS', overtakingRulesForSeason(2025) === 'drs-rear' && overtakingRulesForSeason(2011) === 'drs-rear');
check('Before 2011: no DRS', overtakingRulesForSeason(2010) === 'none' && overtakingRulesForSeason(2004) === 'none');
const f1Cars = CARS.filter((c) => c.classId === 'f1-2026');
check(
  'Every F1 car has a season, no GT3 does',
  f1Cars.every((c) => c.season !== undefined) && CARS.filter((c) => c.classId === 'gt3').every((c) => c.season === undefined),
  f1Cars.map((c) => `${c.id}:${c.season}`).join(' ')
);

// ---------------------------------------------------------------------------
console.log('\n== Detection rule');
const at = (rules: 'straight-mode-2026' | 'drs-rear', gapAheadS: number | null, leaderLapsCompleted: number) =>
  earnedAtDetection({ rules, gapAheadS, leaderLapsCompleted });
check('Within 1 s earns it, over 1 s does not', at('straight-mode-2026', 0.8, 0) && at('straight-mode-2026', DETECTION_GAP_S, 0) && !at('straight-mode-2026', 1.2, 5));
check('No car ahead: nothing earned', !at('straight-mode-2026', null, 3) && !at('drs-rear', null, 3));
check('DRS waits for the leader to complete two laps', !at('drs-rear', 0.5, 0) && !at('drs-rear', 0.5, 1) && at('drs-rear', 0.5, 2));
check('Overtake Mode has no lap wait', at('straight-mode-2026', 0.5, 0));

// ---------------------------------------------------------------------------
console.log('\n== Car ahead on the road (1 km lap)');
{
  const L = 1000;
  // Me on lap 3 at 500 m; a car 200 m up the road on my lap, a lapped car 50 m up the road, the leader 980 m up the road
  const field = [
    { id: 'same', distM: 2700 },
    { id: 'lapped', distM: 1550 },
    { id: 'leader', distM: 3480 },
  ];
  const a = carAheadOnRoad(2500, field, L);
  check(
    'Lapped car directly ahead counts, timed a lap back',
    a?.car.id === 'lapped' && Math.abs(a.roadGapM - 50) < 1e-9 && Math.abs(a.passedHereAtDistM - 1500) < 1e-9,
    JSON.stringify(a && { id: a.car.id, gap: a.roadGapM, at: a.passedHereAtDistM })
  );
  const b = carAheadOnRoad(2500, [{ id: 'leader', distM: 3480 }], L);
  check(
    'A car a lap up is timed where it passed this point a lap later',
    b?.car.id === 'leader' && Math.abs(b.roadGapM - 980) < 1e-9 && Math.abs(b.passedHereAtDistM - 3480 + 980) < 1e-9,
    JSON.stringify(b && { gap: b.roadGapM, at: b.passedHereAtDistM })
  );
  check('Alone on track: none', carAheadOnRoad(2500, [], L) === null);
}

// ---------------------------------------------------------------------------
console.log('\n== Overtake Mode grant');
{
  const zones = [
    { id: 'A', detection: 0.3, start: 0.32, end: 0.4 },
    { id: 'B', detection: 0.9, start: 0.0, end: 0.1 },
  ];
  check('Detection point: the last one before the line', overtakeDetectionZone(zones)?.id === 'B');
  check('Crossing is forward and short (no teleports)', crossedForward(0.88, 0.91, 0.9) && !crossedForward(0.91, 0.88, 0.9) && !crossedForward(0.5, 0.95, 0.9));
  check('Crossing wraps at the line', crossedForward(0.99, 0.01, 0.0) && crossedForward(0.98, 0.02, 0.995));
  let earn = true;
  const race: OvertakingRaceControl = { racing: true, earnedAtDetection: () => earn };
  const g = new OvertakeGrant();
  check('Practice: free, no extra energy', g.available(null) && g.extraDeployJ(null) === 0);
  check('Race: not before the detection point', !g.available(race) && g.extraDeployJ(race) === 0);
  g.observe(0.5, 0.52, zones, race);
  check('Other zones\' detection points do not grant it', !g.available(race));
  g.observe(0.88, 0.91, zones, race);
  check('Earned within 1 s: override + 0.5 MJ for the lap', g.available(race) && g.extraDeployJ(race) === OVERTAKE_EXTRA_DEPLOY_J);
  g.observe(0.3, 0.33, zones, race);
  check('Kept around the lap', g.available(race));
  earn = false;
  g.observe(0.895, 0.905, zones, race);
  check('Judged afresh next lap: lost when over 1 s', !g.available(race) && g.extraDeployJ(race) === 0);
  g.observe(0.895, 0.905, zones, { racing: false, earnedAtDetection: () => true });
  check('After the flag: free again', g.available({ racing: false, earnedAtDetection: () => false }));
}

// ---------------------------------------------------------------------------
console.log('\n== Flaps (f12026-car model, flat ground)');
const DT = 1 / 120;
const full: VehicleInputs = { throttle: 1, brake: 0, steer: 0 };
/** A car on a flat "lap" inside one long zone (detection at 0.05), DRS pressed at full throttle */
const flapRun = (opts: { flaps: 'front-rear' | 'rear'; gated: boolean; eligible: boolean; press: boolean; fitted?: boolean }) => {
  const car = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    airDensity: 1.06,
    drsZones: [{ id: 'Z', detection: 0.05, start: 0.06, end: 0.99 }],
    // Detection 50 m down the road, the zone from 100 m: inside it by the time DRS is pressed (~110 m)
    locateProgress: (_x, z) => 0.04 + z / 5000,
    drsEligibleAtDetection: () => opts.eligible,
  });
  car.drsFlaps = opts.flaps;
  car.drsGatedByDetection = opts.gated;
  car.drsFitted = opts.fitted ?? true;
  car.reset(0, 0, 0, 260 / 3.6);
  for (let t = 0; t < 1.5; t += DT) car.step(DT, full);
  if (opts.press) {
    car.step(DT, { ...full, drs: true });
  }
  for (let t = 0; t < 1.5; t += DT) car.step(DT, full);
  const v = car.speedMs;
  const front = (car.telemetry.downforceN * car.telemetry.AERO_BALANCE) / 100;
  return { open: car.drsOpen, cd: car.telemetry.dragN / (v * v), clFront: front / (v * v), clRear: (car.telemetry.downforceN - front) / (v * v) };
};
const shut = flapRun({ flaps: 'front-rear', gated: true, eligible: false, press: false });
const gatedNo = flapRun({ flaps: 'rear', gated: true, eligible: false, press: true });
const gatedYes = flapRun({ flaps: 'rear', gated: true, eligible: true, press: true });
const straight = flapRun({ flaps: 'front-rear', gated: false, eligible: false, press: true });
check('DRS (gated): shut when not earned at detection', !gatedNo.open);
check('DRS (gated): opens when earned', gatedYes.open);
check('Straight Mode (ungated): opens in the zone without the gap', straight.open);
check('No DRS fitted (pre-2011): never opens', !flapRun({ flaps: 'rear', gated: false, eligible: true, press: true, fitted: false }).open);
const fullDrop = shut.cd - straight.cd;
const rearDrop = shut.cd - gatedYes.cd;
check(
  'Rear flap alone cuts less drag than both flaps',
  fullDrop > 0 && rearDrop > 0.3 * fullDrop && rearDrop < 0.9 * fullDrop,
  `CdA·q/v² drop: both ${fmt(fullDrop, 4)}, rear ${fmt(rearDrop, 4)} (${fmt((100 * rearDrop) / fullDrop, 0)} %)`
);
const frontFull = Math.abs(shut.clFront - straight.clFront);
const frontRear = Math.abs(shut.clFront - gatedYes.clFront);
check(
  'Rear flap alone leaves the front downforce (nearly) as it was',
  frontFull > 0 && frontRear < 0.4 * frontFull,
  `front ClA·q/v² change: both ${fmt(frontFull, 4)}, rear ${fmt(frontRear, 4)}`
);
check('Both drop the rear downforce', gatedYes.clRear < shut.clRear && straight.clRear < shut.clRear);

// ---------------------------------------------------------------------------
console.log('\n== Car adapters (override = Overtake Mode on a 2026 car)');
{
  const track = getActiveTrackData();
  const notEarned: OvertakingRaceControl = { racing: true, earnedAtDetection: () => false };
  const sim = new F12026CarSim(track, null);
  sim.setOvertakingRules('straight-mode-2026');
  sim.raceControl = notEarned;
  sim.step(1 / 60, { throttle: 1 });
  check('2026 in a race, not earned: override locked', !sim.activateBoostOverride() && sim.telemetry.overtakeAvailable === false);
  sim.step(1 / 60, { throttle: 1, manualOverride: true });
  check('2026: holding the override does nothing until earned', !sim.telemetry.manualOverrideActive);
  sim.raceControl = null;
  sim.step(1 / 60, { throttle: 1 });
  check('2026 in practice: override free', sim.activateBoostOverride() && sim.telemetry.overtakeAvailable === true);
  const old = new F12026CarSim(track, null);
  old.setOvertakingRules('drs-rear');
  old.raceControl = notEarned;
  check('Pre-2026 car: its boost is not Overtake Mode, stays free', old.activateBoostOverride());
  const vintage = new F12026CarSim(track, null);
  vintage.setOvertakingRules('none');
  vintage.step(1 / 60, { throttle: 1, toggleXMode: true });
  check(
    'Pre-2011 car: no DRS at all, no race rules',
    vintage.overtakingRules === undefined && vintage.telemetry.f12026?.hasDrs === false && vintage.telemetry.overtakingRules === 'none' && vintage.createAiPeerCar().telemetry.f12026?.hasDrs === false
  );
  const peer = old.createAiPeerCar();
  check('AI cars get the player car\'s era', peer.overtakingRules === 'drs-rear' && old.overtakingRules === 'drs-rear');
  const legacy = new F1Physics2026(track);
  legacy.raceControl = notEarned;
  legacy.step(1 / 60, { throttle: 1 });
  check('F1 2026 Prototype in a race, not earned: override locked', !legacy.activateBoostOverride() && legacy.telemetry.overtakeAvailable === false);
  legacy.raceControl = null;
  check('F1 2026 Prototype in practice: override free', legacy.activateBoostOverride());
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll overtaking-rules checks passed.');
process.exit(failures.length ? 1 : 0);
