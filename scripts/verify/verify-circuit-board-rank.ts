/**
 * Verifies #172 (board position next to each personal best in the circuit browser detail panel):
 *   - Default-board revision matches OnlineBoard (`lapPhysicsVersion === revisionOnBoard(currentBoardBase, car)`)
 *     and requests `limit: 1` with no filters.
 *   - In-memory session cache keys by track, car, board revision, and driver name; deduplicates in-flight reads;
 *     drops an entry when the player sets a new PB there (or when an upload supersedes an unposted/older online lap).
 *   - Skips requests when unnamed or offline, caches local-only PBs (`me: null`) as no-rank, and stays silent
 *     without caching on network errors.
 *   - Formats rank text (`P12 of 340`, `P1,204 of 2,332`) and caps detail PB rows at 4 while keeping the active car.
 *
 *   NEXT_PUBLIC_HOSTED_CONTENT=1 npx tsx scripts/verify/verify-circuit-board-rank.ts
 */
import assert from "node:assert/strict";
import { VEHICLE_MODEL_IDS, type VehicleModelId } from "../../src/types/f1";
import { currentBoardBase, lapPhysicsVersion, revisionOnBoard } from "../../src/lib/sim/lap-types";
import type { BoardPage } from "../../src/lib/net/board-client";
import {
  createCircuitBoardRankStore,
  formatCircuitBoardRank,
  selectDetailPbs,
  type DetailPbEntry,
} from "../../src/components/menu/circuit-board-rank";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const makePage = (
  trackId: string,
  vehicle: VehicleModelId,
  physics: number,
  me: { pos: number; rank: number; lapTimeMs: number } | null,
  total: number,
): BoardPage => ({
  entries: [],
  offset: 0,
  total,
  me: me
    ? {
        pos: me.pos,
        rank: me.rank,
        aboveMs: null,
        entry: {
          name: "Alp",
          code: "ALP",
          lapTimeMs: me.lapTimeMs,
          sectorTimesMs: [me.lapTimeMs / 3, me.lapTimeMs / 3, me.lapTimeMs / 3],
          vehicle,
          trackId,
          recordedAt: 1700000000000,
          source: "remote",
          conditions: {
            assists: "pro",
            compound: "soft",
            surface: "dry",
            realism: "full",
            physicsVersion: physics,
          },
        },
      }
    : null,
  near: null,
  physics: [physics],
});

async function main() {
  const trackA = "willow_springs";
  const trackB = "rwanda_official_short";

  await check("formatCircuitBoardRank matches OnlineBoard P<pos> of <total> wording", () => {
    assert.equal(formatCircuitBoardRank({ pos: 1, total: 1 }), "P1 of 1");
    assert.equal(formatCircuitBoardRank({ pos: 12, total: 340 }), "P12 of 340");
    assert.equal(formatCircuitBoardRank({ pos: 1204, total: 2332 }), "P1,204 of 2,332");
  });

  await check("selectDetailPbs caps at 4 and keeps the currently chosen car visible", () => {
    const pbs: DetailPbEntry[] = [
      { vehicle: "lc26", lapTimeMs: 59044, legacyPhysics: false },
      { vehicle: "lc-lmdh", lapTimeMs: 63200, legacyPhysics: false },
      { vehicle: "amg-gt3", lapTimeMs: 68100, legacyPhysics: false },
      { vehicle: "mtr-496r", lapTimeMs: 68400, legacyPhysics: false },
      { vehicle: "bmw-m1-procar", lapTimeMs: 74500, legacyPhysics: false },
    ];
    assert.deepEqual(
      selectDetailPbs(pbs, "lc26").map((e) => e.vehicle),
      ["lc26", "lc-lmdh", "amg-gt3", "mtr-496r"],
    );
    assert.deepEqual(
      selectDetailPbs(pbs, "bmw-m1-procar").map((e) => e.vehicle),
      ["lc26", "lc-lmdh", "amg-gt3", "bmw-m1-procar"],
    );
  });

  await check("query revision matches OnlineBoard default board for every car", () => {
    for (const track of [trackA, trackB]) {
      const base = currentBoardBase(track);
      for (const car of VEHICLE_MODEL_IDS) {
        assert.equal(lapPhysicsVersion(car, track), revisionOnBoard(base, car));
      }
    }
  });

  await check("fetches with limit=1 and lapPhysicsVersion, then serves subsequent reads from cache", async () => {
    const calls: { track: string; car: VehicleModelId; opts: { physics: number; name: string; limit: number } }[] = [];
    const store = createCircuitBoardRankStore({
      isOnline: () => true,
      fetchPage: async (track, car, opts) => {
        calls.push({ track, car, opts });
        return makePage(track, car, opts.physics, { pos: 12, rank: 12, lapTimeMs: 59044 }, 340);
      },
    });

    const first = await store.load(trackA, "lc26", "  Alp  ", 59044, 0);
    assert.deepEqual(first, { pos: 12, rank: 12, total: 340, lapTimeMs: 59044 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      track: trackA,
      car: "lc26",
      opts: { physics: lapPhysicsVersion("lc26", trackA), name: "Alp", limit: 1 },
    });

    // Normalized driver name hits the same session cache entry (0 extra requests)
    const peeked = store.peek(trackA, "lc26", "alp", 59044, 0);
    assert.equal(peeked.hit, true);
    if (peeked.hit) assert.deepEqual(peeked.value, first);

    const second = await store.load(trackA, "lc26", "ALP", 59044, 0);
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);
  });

  await check("keys cache by track, car, and board revision independently", async () => {
    let revision = 528;
    let calls = 0;
    const store = createCircuitBoardRankStore({
      isOnline: () => true,
      physicsOf: () => revision,
      fetchPage: async (track, car, opts) => {
        calls++;
        return makePage(track, car, opts.physics, { pos: calls, rank: calls, lapTimeMs: 59044 }, 100);
      },
    });

    const r1 = await store.load(trackA, "lc26", "Alp", 59044);
    const r2 = await store.load(trackB, "lc26", "Alp", 59044);
    const r3 = await store.load(trackA, "amg-gt3", "Alp", 68100);
    revision = 1528; // simulated circuit board reset
    const r4 = await store.load(trackA, "lc26", "Alp", 59044);

    assert.equal(calls, 4);
    assert.equal(r1?.pos, 1);
    assert.equal(r2?.pos, 2);
    assert.equal(r3?.pos, 3);
    assert.equal(r4?.pos, 4);
  });

  await check("setting a new PB drops only that track/car cache entry", async () => {
    let calls = 0;
    const store = createCircuitBoardRankStore({
      isOnline: () => true,
      fetchPage: async (track, car, opts) => {
        calls++;
        const pos = track === trackA && calls > 2 ? 7 : 12;
        const ms = track === trackA && calls > 2 ? 58500 : 59044;
        return makePage(track, car, opts.physics, { pos, rank: pos, lapTimeMs: ms }, 340);
      },
    });

    await store.load(trackA, "lc26", "Alp", 59044);
    await store.load(trackB, "lc26", "Alp", 92692);
    assert.equal(calls, 2);

    // New PB on trackA: peek misses, load refetches only trackA
    assert.equal(store.peek(trackA, "lc26", "Alp", 58500).hit, false);
    assert.equal(store.peek(trackB, "lc26", "Alp", 92692).hit, true);

    const updated = await store.load(trackA, "lc26", "Alp", 58500);
    assert.equal(updated?.pos, 7);
    await store.load(trackB, "lc26", "Alp", 92692);
    assert.equal(calls, 3);
  });

  await check("local-only PB (me: null) shows no rank and caches the miss until boardVersion bumps", async () => {
    let uploaded = false;
    let calls = 0;
    const store = createCircuitBoardRankStore({
      isOnline: () => true,
      fetchPage: async (track, car, opts) => {
        calls++;
        return makePage(track, car, opts.physics, uploaded ? { pos: 20, rank: 20, lapTimeMs: 59044 } : null, 340);
      },
    });

    const localOnly = await store.load(trackA, "lc26", "Alp", 59044, 0);
    assert.equal(localOnly, null);
    assert.equal(calls, 1);

    // Reopening the detail panel stays cached (no second D1 hit)
    const cachedAgain = await store.load(trackA, "lc26", "Alp", 59044, 0);
    assert.equal(cachedAgain, null);
    assert.equal(calls, 1);

    // Once the player manually posts that PB, boardVersion increments and refreshes it
    uploaded = true;
    const afterPost = await store.load(trackA, "lc26", "Alp", 59044, 1);
    assert.equal(afterPost?.pos, 20);
    assert.equal(calls, 2);
  });

  await check("skips fetch when driver name is missing or browser is offline", async () => {
    let online = false;
    let calls = 0;
    const store = createCircuitBoardRankStore({
      isOnline: () => online,
      fetchPage: async (track, car, opts) => {
        calls++;
        return makePage(track, car, opts.physics, { pos: 5, rank: 5, lapTimeMs: 59044 }, 50);
      },
    });

    assert.equal(await store.load(trackA, "lc26", "Alp", 59044), undefined);
    online = true;
    assert.equal(await store.load(trackA, "lc26", "", 59044), undefined);
    assert.equal(await store.load(trackA, "lc26", "   ", 59044), undefined);
    assert.equal(await store.load(trackA, "lc26", undefined, 59044), undefined);
    assert.equal(calls, 0);

    // Once online with a name, fetch succeeds
    const res = await store.load(trackA, "lc26", "Alp", 59044);
    assert.equal(res?.pos, 5);
    assert.equal(calls, 1);

    // Setting a new PB while offline still drops the stale entry instead of keeping old rank
    online = false;
    assert.equal(await store.load(trackA, "lc26", "Alp", 58000), undefined);
    assert.equal(store.peek(trackA, "lc26", "Alp", 59044).hit, false);
    assert.equal(calls, 1);
  });

  await check("network failure returns undefined quietly and is not cached", async () => {
    let failMode: "null" | "throw" | "ok" = "null";
    let calls = 0;
    const store = createCircuitBoardRankStore({
      isOnline: () => true,
      fetchPage: async (track, car, opts) => {
        calls++;
        if (failMode === "null") return null;
        if (failMode === "throw") throw new Error("network down");
        return makePage(track, car, opts.physics, { pos: 3, rank: 3, lapTimeMs: 59044 }, 80);
      },
    });

    assert.equal(await store.load(trackA, "lc26", "Alp", 59044), undefined);
    failMode = "throw";
    assert.equal(await store.load(trackA, "lc26", "Alp", 59044), undefined);
    failMode = "ok";
    const recovered = await store.load(trackA, "lc26", "Alp", 59044);
    assert.equal(recovered?.pos, 3);
    assert.equal(calls, 3);
  });

  await check("concurrent reads deduplicate and explicit invalidate blocks stale write-back", async () => {
    let calls = 0;
    let resolveFirst!: (p: BoardPage | null) => void;
    const store = createCircuitBoardRankStore({
      isOnline: () => true,
      fetchPage: (track, car, opts) => {
        calls++;
        if (calls === 1) {
          return new Promise<BoardPage | null>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(makePage(track, car, opts.physics, { pos: 4, rank: 4, lapTimeMs: 58900 }, 200));
      },
    });

    const p1 = store.load(trackA, "lc26", "Alp", 59044);
    const p2 = store.load(trackA, "lc26", "Alp", 59044);
    assert.equal(calls, 1);

    // Explicit invalidation while first request is still in flight
    store.invalidate(trackA, "lc26");
    resolveFirst(makePage(trackA, "lc26", lapPhysicsVersion("lc26", trackA), { pos: 15, rank: 15, lapTimeMs: 59044 }, 200));
    await Promise.all([p1, p2]);

    // Stale response must NOT have populated the cache
    assert.equal(store.peek(trackA, "lc26", "Alp", 59044).hit, false);
    const fresh = await store.load(trackA, "lc26", "Alp", 58900);
    assert.equal(fresh?.pos, 4);
    assert.equal(calls, 2);
  });

  console.log(`\n${passed} circuit board-rank checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
