/**
 * Verifies #151 (Lap times in Circuit Select List):
 *   - Lightweight summary extraction (`extractBestLapSummary`) handles valid, legacy `vf26`, and corrupt records.
 *   - `bestLapForCircuit` prefers current physics + selected car, falls back to current physics fastest overall
 *     (flagged `forCurrentCar: false`), then older physics revisions.
 *   - `bestLapsByVehicleForCircuit` deduplicates to fastest per car, current physics ahead of legacy.
 *
 *   npx tsx scripts/verify-circuit-best-laps.ts
 */
import assert from "node:assert/strict";
import {
  bestLapForCircuit,
  bestLapsByVehicleForCircuit,
  extractBestLapSummary,
  type BestLapSummary,
} from "../src/lib/sim/ghost-store";
import { lapPhysicsVersion } from "../src/lib/sim/lap-types";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const trackA = "rwanda_official_short";
const trackB = "le_mans_82";
const curLc26 = lapPhysicsVersion("lc26", trackA);
const curGt3 = lapPhysicsVersion("amg-gt3", trackA);
const curLmdh = lapPhysicsVersion("lc-lmdh", trackB);

check("extractBestLapSummary folds legacy vf26 vehicle id and rejects invalid entries", () => {
  const s = extractBestLapSummary({
    trackId: trackA,
    vehicle: "vf26",
    lapTimeMs: 82345,
    recordedAt: 1700000000000,
    conditions: { physicsVersion: curLc26 },
  });
  assert.ok(s);
  assert.equal(s.vehicle, "lc26");
  assert.equal(s.lapTimeMs, 82345);
  assert.equal(s.physicsVersion, curLc26);

  assert.equal(extractBestLapSummary(null), null);
  assert.equal(extractBestLapSummary({ trackId: "", vehicle: "lc26", lapTimeMs: 50000 }), null);
  assert.equal(extractBestLapSummary({ trackId: trackA, vehicle: "unknown-car", lapTimeMs: 50000 }), null);
  assert.equal(extractBestLapSummary({ trackId: trackA, vehicle: "lc26", lapTimeMs: -1 }), null);
});

check("bestLapForCircuit prefers current-physics current-car lap even when another car is faster", () => {
  const list: BestLapSummary[] = [
    { trackId: trackA, vehicle: "lc26", lapTimeMs: 74000, physicsVersion: curLc26, recordedAt: 1 },
    { trackId: trackA, vehicle: "amg-gt3", lapTimeMs: 91200, physicsVersion: curGt3, recordedAt: 2 },
    { trackId: trackA, vehicle: "amg-gt3", lapTimeMs: 89500, physicsVersion: curGt3, recordedAt: 3 },
  ];
  const pick = bestLapForCircuit(list, trackA, "amg-gt3");
  assert.ok(pick);
  assert.equal(pick.vehicle, "amg-gt3");
  assert.equal(pick.lapTimeMs, 89500);
  assert.equal(pick.forCurrentCar, true);
  assert.equal(pick.legacyPhysics, false);
});

check("bestLapForCircuit falls back to overall fastest current-physics car with forCurrentCar=false", () => {
  const list: BestLapSummary[] = [
    { trackId: trackB, vehicle: "lc-lmdh", lapTimeMs: 188400, physicsVersion: curLmdh, recordedAt: 1 },
    { trackId: trackB, vehicle: "amg-gt3", lapTimeMs: 221000, physicsVersion: lapPhysicsVersion("amg-gt3", trackB), recordedAt: 2 },
  ];
  const pick = bestLapForCircuit(list, trackB, "lc26");
  assert.ok(pick);
  assert.equal(pick.vehicle, "lc-lmdh");
  assert.equal(pick.lapTimeMs, 188400);
  assert.equal(pick.forCurrentCar, false);
  assert.equal(pick.legacyPhysics, false);
});

check("bestLapForCircuit prefers current physics over faster legacy-physics laps, and falls back to legacy when none current", () => {
  const list: BestLapSummary[] = [
    { trackId: trackA, vehicle: "amg-gt3", lapTimeMs: 80000, physicsVersion: curGt3 - 1, recordedAt: 1 },
    { trackId: trackA, vehicle: "amg-gt3", lapTimeMs: 89000, physicsVersion: curGt3, recordedAt: 2 },
  ];
  const cur = bestLapForCircuit(list, trackA, "amg-gt3");
  assert.ok(cur);
  assert.equal(cur.lapTimeMs, 89000);
  assert.equal(cur.legacyPhysics, false);

  const legacyOnly: BestLapSummary[] = [
    { trackId: trackA, vehicle: "lc26", lapTimeMs: 75000, physicsVersion: 1, recordedAt: 1 },
    { trackId: trackA, vehicle: "amg-gt3", lapTimeMs: 92000, physicsVersion: 1, recordedAt: 2 },
  ];
  const leg = bestLapForCircuit(legacyOnly, trackA, "amg-gt3");
  assert.ok(leg);
  assert.equal(leg.vehicle, "amg-gt3");
  assert.equal(leg.lapTimeMs, 92000);
  assert.equal(leg.forCurrentCar, true);
  assert.equal(leg.legacyPhysics, true);
});

check("bestLapForCircuit returns null for circuits with no recorded laps", () => {
  assert.equal(bestLapForCircuit([], trackA, "lc26"), null);
});

check("bestLapsByVehicleForCircuit returns fastest per car with current physics ranked before legacy", () => {
  const list: BestLapSummary[] = [
    { trackId: trackA, vehicle: "amg-gt3", lapTimeMs: 91000, physicsVersion: curGt3, recordedAt: 1 },
    { trackId: trackA, vehicle: "amg-gt3", lapTimeMs: 89200, physicsVersion: curGt3, recordedAt: 2 },
    { trackId: trackA, vehicle: "lc26", lapTimeMs: 73500, physicsVersion: curLc26, recordedAt: 3 },
    { trackId: trackA, vehicle: "lc-lmdh", lapTimeMs: 70000, physicsVersion: 1, recordedAt: 4 },
  ];
  const rows = bestLapsByVehicleForCircuit(list, trackA);
  assert.deepEqual(
    rows.map((r) => [r.vehicle, r.lapTimeMs, r.legacyPhysics]),
    [
      ["lc26", 73500, false],
      ["amg-gt3", 89200, false],
      ["lc-lmdh", 70000, true],
    ]
  );
});

check("extractBestLapSummary round-trips compact localStorage summary entries preserving physicsVersion", () => {
  const s = extractBestLapSummary({
    trackId: trackA,
    vehicle: "lc26",
    lapTimeMs: 74123,
    physicsVersion: curLc26,
    recordedAt: 42,
  });
  assert.deepEqual(s, {
    trackId: trackA,
    vehicle: "lc26",
    lapTimeMs: 74123,
    physicsVersion: curLc26,
    recordedAt: 42,
  });
});

console.log(`\n${passed} circuit best-lap checks passed.`);
