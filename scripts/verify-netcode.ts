/**
 * Guard rails for the multiplayer netcode: a short run of the netcode bench (scripts/bench-netcode.ts) with loose
 * limits, so a change that makes other cars drawn far from where they are, jumpy, or the packets fat fails here.
 *
 *   npx tsx scripts/verify-netcode.ts
 *
 * The limits are loose, two to three times what the bench measures today, except the 50 ms row's, which is held close
 * enough to catch the clock mapping slipping (an averaged one drew the car 0.35 m behind); the full table is the
 * bench's to show.
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { recordDrives, runScenario, type BenchSetup, type Scenario } from './lib/netcode-bench';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const m = (v: number) => `${v.toFixed(2)} m`;

const track = getActiveTrackData();
const durationS = 60;
const drives = recordDrives(track, durationS + 2);
const setup: BenchSetup = { track, drives, brakingZone: drives[0].hardestBrakingZone(), durationS, warmupS: 5 };
const run = (sc: Omit<Scenario, 'name'>) => runScenario(setup, { name: '', seed: 1, ...sc });

const plain = run({ link: { oneWayMs: 50, jitterMs: 3 } });
check('50 ms: drawn within half a metre along the track (p95)', plain.all.alongP95 < 0.5, m(plain.all.alongP95));
check('50 ms: neither behind nor ahead on average (the clock mapping)', Math.abs(plain.all.biasM) < 0.15, m(plain.all.biasM));
check('50 ms: and on its line across it (p95)', plain.all.acrossP95 < 0.3, m(plain.all.acrossP95));
check('50 ms: no jumps', plain.all.jumpsPerMin < 1, `${plain.all.jumpsPerMin.toFixed(1)} a minute`);
check('50 ms: braking into the hairpin too (p95)', plain.braking.alongP95 < 1.5, m(plain.braking.alongP95));
check('60 states a second, small ones', plain.packetsPerS > 55 && plain.bytesPerPacket < 150, `${plain.packetsPerS.toFixed(1)} a second, ${plain.bytesPerPacket.toFixed(0)} bytes`);

const loss = run({ link: { oneWayMs: 50, jitterMs: 3, loss: 0.01 } });
check('1% loss: still within a car length (p95)', loss.all.alongP95 < 1.5, m(loss.all.alongP95));

const stall = run({ link: { oneWayMs: 50, jitterMs: 3, stall: { firstS: 10, everyS: 15, ms: 600 } } });
check('a 0.6 s stall: the car carries on, nothing far off', stall.all.alongMax < 5 && stall.all.jumpsPerMin < 2, `worst ${m(stall.all.alongMax)}, ${stall.all.jumpsPerMin.toFixed(1)} jumps a minute`);

const outage = run({ link: { oneWayMs: 50, jitterMs: 3, stall: { firstS: 12, everyS: 30, ms: 2500 } } });
check('a 2.5 s outage: drawn see-through, then hidden, then back', outage.all.ghostPct > 0 && outage.all.hiddenPct > 0 && outage.all.alongP95 < 1.5 && outage.all.jumpsPerMin < 3, `see-through ${outage.all.ghostPct.toFixed(1)} %, hidden ${outage.all.hiddenPct.toFixed(1)} %, ${outage.all.jumpsPerMin.toFixed(1)} jumps a minute`);

const slow = run({ link: { oneWayMs: 50, jitterMs: 3 }, b: { fps: 30, workMs: 26, sendAtMs: 18, hitch: { chance: 0.01, ms: 120 } } });
check('a 30 fps sender with hitches: within a car length (p95)', slow.all.alongP95 < 1.5 && slow.all.jumpsPerMin < 3, `${m(slow.all.alongP95)}, ${slow.all.jumpsPerMin.toFixed(1)} jumps a minute`);

const relayed = run({ link: { oneWayMs: 50, jitterMs: 3 }, viaHost: true });
check('guest to guest through the host: within a car length (p95)', relayed.all.alongP95 < 2, m(relayed.all.alongP95));

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll netcode checks passed.');
if (failures.length) process.exit(1);
