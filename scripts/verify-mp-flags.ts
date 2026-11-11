/**
 * Headless checks for the yellow flags of a race between people (src/lib/sim/mp-flags.ts).
 *
 *   npx tsx scripts/verify-mp-flags.ts
 *
 *  1. What makes a car an incident: stopped, slow, the wrong way, off the track by the road, its own hazard flag at
 *     low speed; racing speeds, a car far out in a run-off, a finished car and a car off the start do not
 *  2. The player's flag: up for an incident up to 300 m ahead (across the lap line too), never for one behind; one
 *     message when it goes up and one when it comes down, never a green without a yellow
 *  3. No flicker: a one-frame cause raises nothing, a cause that comes and goes keeps one steady flag
 *  4. The start: a whole grid crawling away from the lights raises no flag; nor does a player who has finished
 *  5. The remote cars placed from their pose (a straight test track): along-track speed from the velocity
 */
import {
  CAR_OFF_S,
  CAR_ON_S,
  causeOf,
  flagCarsOf,
  flagMultiplayerRace,
  MultiplayerFlags,
  NEAR_ROAD_M,
  START_GRACE_S,
  YELLOW_AHEAD_M,
  YELLOW_HOLD_S,
  type FlagCar,
  type FlagTrack,
} from '../src/lib/sim/mp-flags';
import type { InterpolatedPeerState } from '../src/lib/sim/multiplayer-sync';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};

const DT = 1 / 60;
const LAP = 5000;
const HALF = 6;

const car = (o: Partial<FlagCar> = {}): FlagCar => ({
  id: 'b',
  s: 1000,
  latM: 0,
  halfWidthM: HALF,
  speedMs: 60,
  alongMs: 60,
  hazard: false,
  racing: true,
  distM: 6000,
  ...o,
});

/** Runs `seconds` of race from `t0` with the player at `playerS(t)` and the cars `cars(t)`; returns the flag's history */
const run = (
  f: MultiplayerFlags,
  t0: number,
  seconds: number,
  playerS: (t: number) => number,
  cars: (t: number) => FlagCar[],
  active = true
) => {
  let upAt: number | null = null;
  let downAt: number | null = null;
  let changes = 0;
  let was = f.yellow;
  let t = t0;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    t += DT;
    f.update(DT, t, playerS(t), LAP, cars(t), active);
    if (f.yellow !== was) {
      changes++;
      if (f.yellow && upAt === null) upAt = t - t0;
      if (!f.yellow && downAt === null) downAt = t - t0;
      was = f.yellow;
    }
  }
  return { t, upAt, downAt, changes };
};
const kinds = (f: MultiplayerFlags, t: number) => (f.feed(t) ?? []).map((m) => m.kind).join(',');

// ---- 1. What makes a car an incident ---------------------------------------------------------------------------------
{
  check('a car at racing speed is no incident', causeOf(car()) === null);
  check('a stopped car', causeOf(car({ speedMs: 0.5, alongMs: 0.5 })) === 'stopped');
  check('a crawling car', causeOf(car({ speedMs: 6, alongMs: 6 })) === 'slow');
  check('a car going the wrong way', causeOf(car({ speedMs: 20, alongMs: -20 })) === 'wrong_way');
  check('a car off the track by the road', causeOf(car({ latM: HALF + 3, speedMs: 25, alongMs: 25 })) === 'off_track');
  check('a car on a kerb is not off the track', causeOf(car({ latM: HALF + 0.5 })) === null);
  check('a car far out in a run-off is in nobody\'s way', causeOf(car({ latM: -(HALF + NEAR_ROAD_M + 2), speedMs: 0, alongMs: 0 })) === null);
  check('its own hazard flag at low speed', causeOf(car({ hazard: true, speedMs: 15, alongMs: 15 })) === 'hazard');
  check('its own hazard flag at racing speed (the flag\'s tail)', causeOf(car({ hazard: true })) === null);
  check('a finished car is no incident', causeOf(car({ racing: false, speedMs: 0, alongMs: 0 })) === null);
}

// ---- 2. The player's flag ------------------------------------------------------------------------------------------------
{
  // A room race (no hazard flags): a car stops 200 m ahead of the player
  const f = new MultiplayerFlags();
  check('no message before anything happened', f.feed(20) === undefined);
  let r = run(f, 20, 2, () => 800, () => [car({ s: 1000 })]);
  check('racing cars: no flag and no green', !f.yellow && f.feed(r.t) === undefined);
  r = run(f, r.t, 2, () => 800, () => [car({ s: 1000, speedMs: 0, alongMs: 0 })]);
  check('a stopped car 200 m ahead: yellow after the debounce', r.upAt !== null && Math.abs(r.upAt - CAR_ON_S) < 0.05, `up after ${r.upAt?.toFixed(2)} s`);
  const msg = f.feed(r.t)?.[0];
  check('the message: "Yellow flag" · car stopped ahead', msg?.kind === 'yellow' && msg.text === 'Yellow flag' && msg.detail === 'Car stopped ahead');
  // It gets going again
  r = run(f, r.t, 4, () => 800, () => [car({ s: 1000 })]);
  const want = CAR_OFF_S + YELLOW_HOLD_S;
  check('cleared: green once the car and the hold are past', r.downAt !== null && Math.abs(r.downAt - want) < 0.05 && r.changes === 1, `down after ${r.downAt?.toFixed(2)} s`);
  check('the feed: green on top of the yellow', kinds(f, r.t) === 'green,yellow' && f.feed(r.t)?.[0].text === 'Track clear');
  check('the messages leave the feed after a while', f.feed(r.t + 10) === undefined);
}
{
  const stopped = (s: number) => [car({ s, speedMs: 0, alongMs: 0 })];
  let f = new MultiplayerFlags();
  run(f, 20, 2, () => 900, () => stopped(900 - 100));
  check('a stopped car 100 m behind: no flag', !f.yellow);
  f = new MultiplayerFlags();
  run(f, 20, 2, () => 1000 - YELLOW_AHEAD_M - 60, () => stopped(1000));
  check('a stopped car 360 m ahead: no flag yet', !f.yellow);
  // The player drives up to it at 50 m/s
  const r = run(f, 22, 3, (t) => 1000 - YELLOW_AHEAD_M - 60 + 50 * (t - 22), () => stopped(1000));
  check('...and yellow on entering the zone', r.upAt !== null && Math.abs(r.upAt - 60 / 50) < 0.05, `up after ${r.upAt?.toFixed(2)} s`);
  f = new MultiplayerFlags();
  run(f, 20, 2, () => LAP - 100, () => stopped(100));
  check('across the lap line: 200 m ahead is ahead', f.yellow);
  f = new MultiplayerFlags();
  run(f, 20, 2, () => 100, () => stopped(LAP - 100));
  check('across the lap line: 200 m behind is behind', !f.yellow);
  f = new MultiplayerFlags();
  run(f, 20, 2, () => 1020, () => stopped(1000));
  check('just past the car: still yellow', f.yellow);
}
{
  // The wrong way, off the track, and a car's own flag in an open race, each with its own words
  const cases: [string, FlagCar, string][] = [
    ['wrong way', car({ s: 1100, speedMs: 20, alongMs: -20 }), 'Car going the wrong way'],
    ['rejoining from off the track', car({ s: 1100, latM: HALF + 3, speedMs: 20, alongMs: 20 }), 'Car off the track ahead'],
    ['its own hazard flag', car({ s: 1100, hazard: true, speedMs: 15, alongMs: 15 }), 'Incident ahead'],
  ];
  for (const [name, c, detail] of cases) {
    const f = new MultiplayerFlags();
    const r = run(f, 20, 1, () => 1000, () => [c]);
    check(`${name}: yellow`, f.yellow && f.feed(r.t)?.[0].detail === detail, f.feed(r.t)?.[0].detail ?? '');
  }
  const f = new MultiplayerFlags();
  run(f, 20, 2, () => 1000, () => [car({ s: 1100, racing: false, speedMs: 0, alongMs: 0 })]);
  check('a finished car stopped ahead: no flag', !f.yellow);
}

// ---- 3. No flicker -------------------------------------------------------------------------------------------------------
{
  let f = new MultiplayerFlags();
  // A car dips under the slow line for a frame now and then (one frame in 30)
  let frame = 0;
  run(f, 20, 5, () => 1000, () => [car({ s: 1100, speedMs: frame++ % 30 === 0 ? 5 : 40, alongMs: 40 })]);
  check('one-frame causes raise no flag', !f.yellow && f.feed(25) === undefined);
  f = new MultiplayerFlags();
  // A car limping on, its speed around the slow line: 0.6 s under, 0.4 s over, for 8 s
  const r = run(f, 20, 8, () => 1000, (t) => [car({ s: 1100, speedMs: (t - 20) % 1 < 0.6 ? 7 : 11, alongMs: 9 })]);
  check('a cause that comes and goes: one steady flag', f.yellow && r.changes === 1, `${r.changes} change(s)`);
  // The player at the zone's edge, a stopped car's distance swinging 295..305 m
  f = new MultiplayerFlags();
  const r2 = run(f, 20, 6, (t) => 1100 - YELLOW_AHEAD_M + 5 * Math.sin(2 * Math.PI * (t - 20)), () => [car({ s: 1100, speedMs: 0, alongMs: 0 })]);
  check('at the zone\'s edge the flag does not flicker', r2.changes === 1, `${r2.changes} change(s)`);
}

// ---- 4. The start, and the player's own flag -------------------------------------------------------------------------
{
  let f = new MultiplayerFlags();
  // Lights out: eight cars pull away from standstill at 6 m/s², the player at the back
  const grid = (t: number) =>
    Array.from({ length: 7 }, (_, i) => {
      const v = Math.min(70, 6 * t);
      const dist = -i * 8 + 3 * t * t;
      return car({ id: `c${i}`, s: (LAP + dist) % LAP, speedMs: v, alongMs: v, distM: dist });
    });
  run(f, 0, 12, (t) => (LAP - 64 + 3 * t * t) % LAP, grid);
  check('the start raises no flag', !f.yellow && f.feed(12) === undefined);
  // A car stalls on the grid, the player stuck just behind it: nothing off the start ...
  f = new MultiplayerFlags();
  const stalled = () => [car({ s: LAP - 8, speedMs: 0, alongMs: 0, distM: -8 })];
  let r = run(f, 0, START_GRACE_S - 1, () => LAP - 100, stalled);
  check('a car stalled on the grid raises no flag off the start', !f.yellow && r.changes === 0);
  // ... but once the field is long gone it is a car stopped on the track, for the player coming round to it
  r = run(f, r.t, 2, () => LAP - 100, stalled);
  check('...and a car still on the grid later is a stopped car', f.yellow && f.feed(r.t)?.[0].detail === 'Car stopped ahead');
  // The player under yellow takes the flag: the flag is down and no green is posted
  f = new MultiplayerFlags();
  r = run(f, 20, 1, () => 1000, () => [car({ s: 1100, speedMs: 0, alongMs: 0 })]);
  r = run(f, r.t, 1, () => 1000, () => [car({ s: 1100, speedMs: 0, alongMs: 0 })], false);
  check('a player who has finished: no flag, no green', !f.yellow && kinds(f, r.t) === 'yellow');
  // The stopped car's packets stop (it left): the flag comes down after the hold
  f = new MultiplayerFlags();
  r = run(f, 20, 1, () => 1000, () => [car({ s: 1100, speedMs: 0, alongMs: 0 })]);
  r = run(f, r.t, 2, () => 1000, () => []);
  check('a car that left takes its flag with it', !f.yellow && r.downAt !== null && Math.abs(r.downAt - YELLOW_HOLD_S) < 0.05);
}

// ---- 5. The remote cars placed from their pose --------------------------------------------------------------------------
{
  // A straight track along +z: s = z, lateral = x, 12 m wide
  const track: FlagTrack = {
    totalLengthM: LAP,
    projectWorldToTrack: (x, z) => ({ s: ((z % LAP) + LAP) % LAP, lateralOffset: x, sample: { width: 2 * HALF, tangent: { x: 0, z: 1 } } }),
  };
  const peer = (id: string, o: { x?: number; z: number; vz: number; race?: InterpolatedPeerState['race']; ai?: boolean; hz?: boolean }) =>
    ({
      peerId: id,
      position: { x: o.x ?? 0, y: 0, z: o.z },
      linearVelocity: { x: 0, y: 0, z: o.vz },
      trackS: o.z,
      speedKmh: Math.abs(o.vz) * 3.6,
      isAiPeer: o.ai === true,
      race: o.race,
      hazard: o.hz,
    }) as unknown as InterpolatedPeerState;
  const race = (dist: number, fin: number | null = null) => ({ id: 'race7', dist, fin, best: null });
  const cars = flagCarsOf(track, [
    peer('back', { z: 1200, vz: -15, race: race(3000) }),
    peer('off', { x: HALF + 3, z: 1300, vz: 30, race: race(3100), hz: true }),
    peer('done', { z: 1400, vz: 0, race: race(10000, 300) }),
    peer('other', { z: 1500, vz: 0, race: { ...race(3000), id: 'race6' } }),
    peer('ai', { z: 1600, vz: 0, race: race(3000), ai: true }),
    peer('lobby', { z: 1700, vz: 0 }),
  ], 'race7');
  const byId = new Map(cars.map((c) => [c.id, c]));
  check('only this race\'s players are judged', [...byId.keys()].join(',') === 'back,off,done', [...byId.keys()].join(','));
  check('backwards along the track from the velocity', byId.get('back')?.alongMs === -15 && causeOf(byId.get('back')!) === 'wrong_way');
  check('off the track from the pose, its hazard flag carried', byId.get('off')?.latM === HALF + 3 && byId.get('off')?.hazard === true && causeOf(byId.get('off')!) === 'off_track');
  check('a finished car is not racing', byId.get('done')?.racing === false);

  // Through the game's call: the flag and its message land on the race's status, kept per race
  const raceA = { start: { id: 'race7' } };
  const status = (phase: 'racing' | 'finished') => ({ phase, lightsOn: 0, position: 1, fieldSize: 2, lap: 2, standings: [] }) as Parameters<typeof flagMultiplayerRace>[1];
  const stoppedPeer = [peer('x', { z: 1100, vz: 0, race: race(6100) })];
  let st = status('racing');
  for (let t = 20; t < 21; t += DT) {
    st = status('racing');
    flagMultiplayerRace(raceA, st, track, stoppedPeer, DT, t, 1000);
  }
  check('the status carries the yellow and its message', st.yellow === true && st.raceControl?.[0]?.kind === 'yellow');
  const fresh = status('racing');
  flagMultiplayerRace({ start: { id: 'race7' } }, fresh, track, stoppedPeer, DT, 21, 1000);
  check('a new race starts with its own flags', fresh.yellow === undefined && fresh.raceControl === undefined);
  const done = status('finished');
  flagMultiplayerRace(raceA, done, track, stoppedPeer, DT, 21, 1000);
  check('the player\'s flag: no yellow on the status', done.yellow === undefined);
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nAll mp-flags checks passed.');
process.exit(failures.length ? 1 : 0);
