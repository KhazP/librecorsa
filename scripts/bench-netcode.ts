/**
 * The multiplayer netcode bench (scripts/lib/netcode-bench.ts): one table row per network scenario.
 *
 *   npx tsx scripts/bench-netcode.ts              the full table (three minutes of racing per scenario)
 *   npx tsx scripts/bench-netcode.ts --quick      a shorter run of the main rows
 *   npx tsx scripts/bench-netcode.ts --json out.json
 *   npx tsx scripts/bench-netcode.ts --hz 30      every client sends at this rate (default: the game's)
 *   npx tsx scripts/bench-netcode.ts --seeds 5    runs each scenario with this many seeds (default 3, quick 1)
 *
 * Two (or three) clients race recorded F1Physics2026 drives on the default circuit through their own
 * `MultiplayerSyncManager`, on simulated links, with their own clocks and frame rates. Each row: where each client
 * drew the other car against where that car truly was at the same moment, along its direction of travel and across
 * it (m: median, 95th percentile, worst; bias + is drawn ahead), frame-to-frame jumps against the true motion (per
 * minute), the frames whose newest packet was over 300 ms old and the frames the car was not drawn, and the state
 * packets' size and rate. "Braking into the hairpin" is the 50 ms row's frames while the watched car brakes into the
 * lap's hardest stop. "true clock" reruns a row with each receiver mapping the sender's stamps to its own clock exactly
 * (no estimators): the difference to its row is what the timing estimates cost.
 */
import { writeFileSync } from 'node:fs';
import { getActiveTrackData } from '../src/lib/track-data';
import { recordDrives, runScenario, tableOf, type BenchSetup, type Scenario, type ScenarioResult } from './lib/netcode-bench';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const jsonAt = args.indexOf('--json');
const jsonPath = jsonAt >= 0 ? args[jsonAt + 1] : null;
const seedsAt = args.indexOf('--seeds');
const seeds = seedsAt >= 0 ? Math.max(1, Number(args[seedsAt + 1])) : quick ? 1 : 3;
const hzAt = args.indexOf('--hz');
const sendHz = hzAt >= 0 ? Number(args[hzAt + 1]) : undefined;

const SLOW: Partial<Scenario['b']> = { fps: 30, workMs: 26, sendAtMs: 18, hitch: { chance: 0.01, ms: 120 } };

export const SCENARIOS: Scenario[] = [
  { name: '20 ms', link: { oneWayMs: 20, jitterMs: 2 } },
  { name: '50 ms', link: { oneWayMs: 50, jitterMs: 3 } },
  { name: '100 ms', link: { oneWayMs: 100, jitterMs: 5 } },
  { name: '50 ms, long-tailed jitter', link: { oneWayMs: 50, tailMeanMs: 8, spikeChance: 0.02 } },
  { name: '50 ms, 1% loss', link: { oneWayMs: 50, jitterMs: 3, loss: 0.01 } },
  { name: '50 ms, 0.6 s stall every 15 s', link: { oneWayMs: 50, jitterMs: 3, stall: { firstS: 10, everyS: 15, ms: 600 } } },
  { name: '50 ms, 30 fps sender with hitches', link: { oneWayMs: 50, jitterMs: 3 }, b: SLOW },
  { name: '50 ms, clocks 100 ppm apart', link: { oneWayMs: 50, jitterMs: 3 }, a: { driftPpm: -50 }, b: { driftPpm: 50 } },
  { name: '30 / 70 ms asymmetric', link: { oneWayMs: 30, jitterMs: 3 }, linkBack: { oneWayMs: 70, jitterMs: 3 } },
  { name: 'guest to guest via host, 50 + 50 ms', link: { oneWayMs: 50, jitterMs: 3 }, viaHost: true },
  { name: 'true clock: 50 ms, long-tailed jitter', link: { oneWayMs: 50, tailMeanMs: 8, spikeChance: 0.02 }, trueTiming: true },
];
const QUICK = new Set(['20 ms', '50 ms', '100 ms', '50 ms, 1% loss', '50 ms, 0.6 s stall every 15 s', '50 ms, 30 fps sender with hitches']);

function main() {
  const durationS = quick ? 60 : 180;
  const started = Date.now();
  const track = getActiveTrackData();
  const drives = recordDrives(track, durationS + 2);
  const setup: BenchSetup = { track, drives, brakingZone: drives[0].hardestBrakingZone(), durationS, warmupS: 5 };
  console.log(
    `Netcode bench: ${track.id ?? 'default circuit'}, ${durationS} s per scenario and seed, hairpin braking zone ${setup.brakingZone.fromS.toFixed(0)}-${setup.brakingZone.toS.toFixed(0)} m (drives recorded in ${((Date.now() - started) / 1000).toFixed(1)} s)\n`
  );
  const results: ScenarioResult[] = [];
  const rows: Parameters<typeof tableOf>[0] = [];
  for (const sc of SCENARIOS) {
    if (quick && !QUICK.has(sc.name)) continue;
    const r = runScenario(setup, { seed: 1, sendHz, ...sc }, seeds);
    results.push(r);
    rows.push({ label: r.name, m: r.all, bytes: r.bytesPerPacket, rate: r.packetsPerS });
    if (sc.name === '50 ms') rows.push({ label: 'braking into the hairpin, 50 ms', m: r.braking });
  }
  console.log(tableOf(rows));
  console.log(`\nAlong / across / bias in metres, ${seeds} seed(s) per row. ${((Date.now() - started) / 1000).toFixed(1)} s in all.`);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(results, null, 2));
}

main();
