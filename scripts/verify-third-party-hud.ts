/**
 * Headless checks of the readings the third-party HUD layouts share (src/components/hud/third-party-data.ts and the
 * rev lights in styles/third-party-parts.tsx): the cars around the player on the road and their gaps across the start
 * line, a short leaderboard that keeps the leader and the player, the session best, ideal and predicted laps, the fuel's
 * laps, a completed lap's sectors, the session clock's spelling, and rev lights that match the wheel's.
 *
 *   npx tsx scripts/verify-third-party-hud.ts
 */
import type { CarTelemetry, RaceStandingEntry } from '../src/types/f1';
import {
  completedLap,
  dayClock,
  driverLabel,
  evaluateRadar,
  formatClock,
  fuelLapsLeft,
  idealLapMs,
  leaderboardWindow,
  predictedLapMs,
  referenceLapS,
  relativeCars,
  sessionBestLapMs,
  SURFACE_WORD,
  trackSurfaceState,
  headlightState,
  wrapLap,
} from '../src/components/hud/third-party-data';
import { revLights } from '../src/components/hud/styles/third-party-parts';
import { sessionWord } from '../src/components/hud/hud-format';
import { revLedBand, revLeds } from '../src/lib/sim/rev-range';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- A small race: a 5 km lap, the player 4th of six

const L = 5000;
const entry = (code: string, s: number, raceDist: number, extra: Partial<RaceStandingEntry> = {}): RaceStandingEntry => ({
  driverCode: code,
  teamColorHex: '#ffffff',
  isPlayer: false,
  lap: Math.floor(raceDist / L) + 1,
  gapToLeaderS: 0,
  trackS: s,
  raceDistM: raceDist,
  ...extra,
});
const standings: RaceStandingEntry[] = [
  entry('AAA', 4900, 4 * L + 4900, { gapToLeaderS: 0, bestLapMs: 92_000 }),
  // 300 m ahead of the player, across the start line from them
  entry('BBB', 100, 4 * L + 5100, { gapToLeaderS: 3, bestLapMs: 91_500 }),
  entry('CCC', 4950, 3 * L + 4950, { gapToLeaderS: 6 }),
  entry('YOU', 4800, 3 * L + 4800, { isPlayer: true, gapToLeaderS: 8, bestLapMs: 93_000 }),
  // 100 m behind the player on the road, a lap down
  entry('DDD', 4700, 2 * L + 4700, { gapToLeaderS: 40 }),
  entry('EEE', 2000, 3 * L + 2000, { gapToLeaderS: 50, retired: true }),
];
const t = {
  bestLapTimeMs: 100_000,
  lastLapTimeMs: 101_000,
  race: { standings },
} as unknown as CarTelemetry;

check(
  'headlights: the flash first, then on, then switched off by hand; nothing on a day on automatic',
  headlightState({ headlightsOn: true, headlightFlash: true, headlightMode: 'auto' }) === 'flash' &&
    headlightState({ headlightsOn: false, headlightFlash: true, headlightMode: 'off' }) === 'flash' &&
    headlightState({ headlightsOn: true, headlightMode: 'auto' }) === 'on' &&
    headlightState({ headlightsOn: false, headlightMode: 'off' }) === 'off' &&
    headlightState({ headlightsOn: false, headlightMode: 'auto' }) === null &&
    headlightState({}) === null,
);
check('the reference lap is the best lap', referenceLapS(t) === 100);
check('...a typical lap without a time yet', referenceLapS({ bestLapTimeMs: null, lastLapTimeMs: null }) === 95);
check('wrapLap takes the short way across the line', wrapLap(4900, L) === -100 && wrapLap(-4900, L) === 100 && wrapLap(200, L) === 200);

const rel = relativeCars(t, L, 3);
const codes = rel.map((r) => r.entry.driverCode);
check('relative: ahead first, the player between, behind last', codes.indexOf('YOU') > 0 && codes.indexOf('YOU') < codes.length - 1, codes.join(' '));
check('relative: a retired car is left out', !codes.includes('EEE'));
const bbb = rel.find((r) => r.entry.driverCode === 'BBB');
check('relative: a car across the start line is 300 m ahead', Boolean(bbb && near(bbb.gapS, (300 / L) * 100)), bbb?.gapS.toFixed(2));
check('relative: ...and a lap up on the player', bbb?.lapsAhead === 1, String(bbb?.lapsAhead));
const ddd = rel.find((r) => r.entry.driverCode === 'DDD');
check('relative: a car 100 m behind is behind, a lap down', Boolean(ddd && near(ddd.gapS, (-100 / L) * 100) && ddd.lapsAhead === -1), `${ddd?.gapS.toFixed(2)} / ${ddd?.lapsAhead}`);
check('relative: gaps fall from ahead to behind', rel.every((r, i) => i === 0 || r.gapS <= rel[i - 1].gapS));
check('relative: the player reads 0', rel.find((r) => r.entry.isPlayer)?.gapS === 0);
check('relative: at most perSide each way', relativeCars(t, L, 1).length === 3);
check('relative: nothing outside a race', relativeCars({ ...t, race: undefined } as CarTelemetry, L).length === 0);
// Without track positions, the running order's gaps
const noTrack = { ...t, race: { standings: standings.map(({ trackS: _s, raceDistM: _d, ...e }) => e) } } as unknown as CarTelemetry;
const relOrder = relativeCars(noTrack, L, 2);
check('relative: falls back to the running order', relOrder.find((r) => r.entry.driverCode === 'CCC')?.gapS === 2);

// ---- Short leaderboards

const field = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, isPlayer: i === 13 }));
const win = leaderboardWindow(field, 8);
check('leaderboard: as many rows as asked', win.length === 8);
check('leaderboard: the leader stays on top', win[0].id === 1);
check('leaderboard: the player stays in view', win.some((e) => e.isPlayer));
check('leaderboard: the rows run in order', win.slice(1).every((e, i, a) => i === 0 || e.id === a[i - 1].id + 1));
const last = leaderboardWindow(field.map((e, i) => ({ ...e, isPlayer: i === 19 })), 8);
check('leaderboard: the last car shows at the bottom', last[last.length - 1].id === 20 && last.length === 8);
const first = leaderboardWindow(field.map((e, i) => ({ ...e, isPlayer: i === 0 })), 8);
check('leaderboard: the leader as player shows the top eight', first.map((e) => e.id).join() === '1,2,3,4,5,6,7,8');
check('leaderboard: a field that fits shows whole', leaderboardWindow(field.slice(0, 6), 8).length === 6);

// ---- Laps

check('session best: the fastest anyone set', sessionBestLapMs(t) === 91_500);
check('session best: the player\'s own outside a race', sessionBestLapMs({ bestLapTimeMs: 99_000 }) === 99_000);
check('session best: none before a lap', sessionBestLapMs({ bestLapTimeMs: null }) === null);
check('ideal lap: the best sectors added', idealLapMs({ bestSectorTimesMs: [30_000, 31_000, 32_000] }) === 93_000);
check('ideal lap: none until every sector has a best', idealLapMs({ bestSectorTimesMs: [30_000, null, 32_000] }) === null);
check('predicted lap: best plus the delta', predictedLapMs(90_000, -0.25) === 89_750);
check('predicted lap: none without a best or a delta', predictedLapMs(null, 0.1) === null && predictedLapMs(90_000, null) === null);
const lap = completedLap(3, 95_000, [30_000, 32_000, 0], true);
check('a completed lap: sector 3 is what the lap leaves', lap.sectorsMs[2] === 33_000 && lap.lap === 3 && lap.valid);
check('a completed lap: an untimed sector stays empty', completedLap(1, 95_000, [0, 32_000, 0], false).sectorsMs.join() === ',32000,');

// ---- Fuel, names, clock

check('fuel: laps the tank lasts', fuelLapsLeft(30, 2.5) === 12);
check('fuel: unknown before a lap is measured', fuelLapsLeft(30, null) === null && fuelLapsLeft(30, 0) === null);
check('names: the player is You online', driverLabel({ isPlayer: true, driverCode: 'TST', name: 'Tester' }) === 'You');
check('names: the player goes by their code against the AI', driverLabel({ isPlayer: true, driverCode: 'TST' }) === 'TST');
check('names: an online name before the code', driverLabel({ isPlayer: false, driverCode: 'ABC', name: ' Sam ' }) === 'Sam');
check('names: the code otherwise', driverLabel({ isPlayer: false, driverCode: 'ABC' }) === 'ABC');
check('clock: minutes and seconds', formatClock(754.9) === '12:34');
check('clock: hours from an hour on', formatClock(3 * 3600 + 62) === '3:01:02');
check('clock: never negative or NaN', formatClock(-5) === '00:00' && formatClock(Number.NaN) === '00:00');

// ---- Rev lights: the third-party layouts light the same lights as the wheel

let same = true;
for (const range of [[10_800, 14_600], [6200, 7500], [5200, 6500]] as [number, number][]) {
  for (const count of [10, 12, 15, 18]) {
    for (let rpm = range[0] - 500; rpm <= range[1] + 200; rpm += 37) {
      const ours = revLights(rpm, range, count);
      const wheel = revLeds(rpm, range, count);
      if (ours.lit !== wheel.lit || ours.atShift !== wheel.atShift) same = false;
      for (let i = 0; i < count; i++) if (ours.on(i) !== (wheel.atShift || i < wheel.lit)) same = false;
    }
  }
}
check('rev lights: lit and shift exactly as the wheel', same);
const bands = revLights(13_000, [10_800, 14_600], 15);
check('rev lights: each light in its band\'s colour', bands.color(0).includes('green') && bands.color(14).includes('cyan') && revLedBand(14, 15) === 'shift');
check('rev lights: every light the shift colour at the shift point', Array.from({ length: 10 }, (_, i) => revLights(15_000, [10_800, 14_600], 10).color(i)).every((c) => c.includes('cyan')));

// ---- Weather & radar helpers

check('surface: wetness thresholds', trackSurfaceState(0.01) === 'dry' && trackSurfaceState(0.05) === 'damp' && trackSurfaceState(0.5) === 'wet' && trackSurfaceState(1.2) === 'flooded');
check('surface: words cover every state', SURFACE_WORD.dry === 'Dry' && SURFACE_WORD.damp === 'Damp' && SURFACE_WORD.wet === 'Wet' && SURFACE_WORD.flooded === 'Flooded');
check('dayClock: wraps 24h cleanly', dayClock(9.5) === '09:30' && dayClock(24.25) === '00:15' && dayClock(-1) === '23:00');
const radarEmpty = evaluateRadar([]);
check('radar: empty field stays invisible', radarEmpty.blips.length === 0 && radarEmpty.opacity === 0 && !radarEmpty.leftCar && !radarEmpty.rightCar);
const radarTraffic = evaluateRadar([
  { x: 0, z: 18, yaw: 0, color: '#ffffff' },
  { x: -3.2, z: 1.5, yaw: 0, color: '#ff0000' },
  { x: 4.8, z: 5.0, yaw: 0, color: '#00ff00' },
  { x: 0, z: -35, yaw: 0, color: '#0000ff' },
]);
check('radar: car far dead ahead fades out', radarTraffic.blips.every((b) => Math.abs(b.blip.x) > 0));
check('radar: front-cone & out-of-range blips filtered', radarTraffic.blips.length === 2);
check('radar: closer side overlap level 2 on left', radarTraffic.leftCar?.overlapLevel === 2 && radarTraffic.leftCar.side === -1);
check('radar: outer overlap level 1 on right', radarTraffic.rightCar?.overlapLevel === 1 && radarTraffic.rightCar.side === 1);
check('radar: active traffic raises opacity to 1', near(radarTraffic.opacity, 1));

// Every layout names the session alike: the weekly challenge's time trial is not practice
check('session word: practice', sessionWord({}) === 'Practice');
check('session word: the weekly challenge reads Time trial', sessionWord({ timeTrial: true }) === 'Time trial');
check('session word: qualifying wins', sessionWord({ qualifying: { remainingS: 60, lastLap: false, lapCounts: true, bestMs: null }, timeTrial: true }) === 'Qualifying');

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll third-party HUD checks passed.');
