/**
 * Checks the cool-down lap after the player's flag (`src/lib/sim/cool-down.ts`): the hand-over to the autopilot, the
 * player's inputs ignored, the gentle stop where the autopilot cannot drive, and that the autopilot really brings each
 * engine's car round at the slow pace on the Rwanda colliders.
 * Run: npx tsx scripts/verify-cool-down.ts
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createVf26Sim } from '../src/lib/sim/f12026-car/Vf26Sim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { createMtr496rSim } from '../src/lib/sim/proto/Mtr496rSim';
import { createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';
import { COOL_DOWN_PACE, CoolDown, type CoolDownState } from '../src/lib/sim/cool-down';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import type { ControlInputs } from '../src/types/f1';
import { loadGlbGeometry } from './lib/glb-geometry';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}

console.log('Hand-over');
{
  const car = { aiAutopilot: false, vxMs: 60, lateralOffsetM: 0 };
  const cd = new CoolDown();
  const racing: CoolDownState = { finished: false, retired: false, roadHalfWidthM: 6 };
  const flag: CoolDownState = { ...racing, finished: true };
  cd.update(car, racing, 0.016);
  check('racing: the player drives', !cd.active && !car.aiAutopilot && cd.paceScale === 1);
  cd.update(car, flag, 0.016);
  check('the flag hands the car to the autopilot', cd.mode === 'drive' && car.aiAutopilot);
  check('at a gentle pace', cd.paceScale === COOL_DOWN_PACE && COOL_DOWN_PACE < 1);
  check("the player's inputs are ignored", Object.keys(cd.inputs()).length === 0);
  car.aiAutopilot = false;
  cd.update(car, flag, 0.016);
  check('a run reset or car swap clearing the flag on the car is undone while the race is over', car.aiAutopilot);
  cd.update(car, racing, 0.016);
  check('the race gone from track (restart, leave) hands the car back', !cd.active && !car.aiAutopilot);

  const wreck = { aiAutopilot: false, vxMs: 20, lateralOffsetM: 0 };
  const w = new CoolDown();
  w.update(wreck, { ...flag, retired: true }, 0.016);
  check('a retired car brakes gently to a stop', w.mode === 'stop' && !wreck.aiAutopilot && (w.inputs().brake ?? 0) > 0 && (w.inputs().throttle ?? 1) === 0);

  const stuck = { aiAutopilot: false, vxMs: 0.5, lateralOffsetM: 0 };
  const s = new CoolDown();
  for (let t = 0; t < 5; t += 0.1) s.update(stuck, flag, 0.1);
  check('a car crawling for a few seconds is still given time', s.mode === 'drive');
  for (let t = 0; t < 2; t += 0.1) s.update(stuck, flag, 0.1);
  check('a car the autopilot cannot get going stops instead', s.mode === 'stop' && !stuck.aiAutopilot);

  const lost = { aiAutopilot: false, vxMs: 30, lateralOffsetM: 12 };
  const l = new CoolDown();
  for (let t = 0; t < 4.5; t += 0.1) l.update(lost, flag, 0.1);
  check('a car the autopilot has lost off the road stops', l.mode === 'stop');
  const nan = { aiAutopilot: false, vxMs: NaN, lateralOffsetM: 0 };
  const n = new CoolDown();
  n.update(nan, flag, 0.016);
  check('a car whose state has blown up stops', n.mode === 'stop');
}

console.log('The autopilot brings each engine round at the slow pace (Rwanda colliders)');
{
  const track = getActiveTrackData();
  const root = loadGlbGeometry('public/tracks/rwanda_official/rwanda_official.glb');
  const cars: [string, () => SimulatorCar][] = [
    ['VF26 (older engine)', () => new F1Physics2026(track)],
    ['VF26 (rigid-body engine)', () => createVf26Sim(track, root)],
    ['f12026-car', () => new F12026CarSim(track, root)],
    ['AMG GT3', () => createAmgGt3Sim(track, root)],
    ['MTR 496R', () => createMtr496rSim(track, root)],
    ['Suzuki Liana', () => createSuzukiLianaSim(track, root)],
  ];
  /** The player floors it and steers into the wall: none of it may reach the car once the cool-down has it */
  const player: Partial<ControlInputs> = { throttle: 1, brake: 0, kbSteer: 1 };
  const DT = 1 / 60;
  const RUN_S = 25;
  const run = (make: () => SimulatorCar, cool: boolean) => {
    const sim = make();
    const s0 = 900;
    const startMs = Math.min(55, (track.getSampleAtDistance(s0).optimalSpeedKmh / 3.6) * 0.8);
    sim.teleportToDistance(s0, startMs, 1.5);
    const base = sim.aiPaceScale ?? 1;
    const cd = new CoolDown();
    let dist = 0;
    let beyond = -Infinity;
    let prevS = sim.sMeters;
    const L = track.totalLengthM;
    for (let t = 0; t < RUN_S; t += DT) {
      const half = track.getSampleAtDistance(sim.sMeters).width / 2;
      if (cool) cd.update(sim, { finished: true, retired: false, roadHalfWidthM: half }, DT);
      else sim.aiAutopilot = true;
      sim.aiPaceScale = base * cd.paceScale;
      sim.step(DT, cd.active ? cd.inputs() : player);
      let ds = sim.sMeters - prevS;
      if (ds < -L / 2) ds += L;
      if (ds > L / 2) ds -= L;
      dist += ds;
      prevS = sim.sMeters;
      beyond = Math.max(beyond, Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
    }
    return { dist, beyond, mode: cd.mode };
  };
  for (const [name, make] of cars) {
    const racing = run(make, false);
    const cool = run(make, true);
    const detail = `${cool.dist.toFixed(0)} m vs ${racing.dist.toFixed(0)} m racing in ${RUN_S} s, ${cool.beyond.toFixed(1)} m past the edge at most`;
    check(
      `${name}: drives the cool-down lap, on the road, slower than racing`,
      cool.mode === 'drive' && cool.dist > 250 && cool.beyond < 1.5 && cool.dist < racing.dist * 0.9,
      detail
    );
  }
}

console.log(`\n${passed} checks passed`);
