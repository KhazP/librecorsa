/**
 * Overhead player nameplates (src/lib/render/overhead-nameplates.ts):
 *   npx tsx scripts/verify-nameplates.ts
 */
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  NAMEPLATE_FADE_START_M,
  NAMEPLATE_MAX_DISTANCE_M,
  NAMEPLATE_ROOF_OFFSET_M,
  NameplateBadgeCache,
  OverheadNameplateProjector,
  formatNameplateBadges,
  nameplateLabel,
  nameplateOpacity,
  projectNameplates,
  rankNameplatePeers,
  type NameplatePeerInput,
} from "../src/lib/render/overhead-nameplates";
import type { DriverBadge } from "../src/lib/net/awards";
import { DEFAULT_HUD_SETTINGS, parsePlayerSettings } from "../src/lib/settings/player-settings";
import type { RaceStandingEntry } from "../src/types/f1";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function makeCamera(far = 5000): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.12, far);
  cam.position.set(0, 2, 0);
  cam.lookAt(0, 2, -100);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

function peer(over: Partial<NameplatePeerInput> & { peerId: string }): NameplatePeerInput {
  return {
    driverCode: "DRV",
    isAiPeer: false,
    position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -30 },
    ...over,
  };
}

function standing(over: Partial<RaceStandingEntry> & { driverCode: string }): RaceStandingEntry {
  return {
    teamColorHex: "#ffffff",
    isPlayer: false,
    lap: 1,
    gapToLeaderS: 0,
    ...over,
  };
}

const VIEW_W = 1280;
const VIEW_H = 720;

check("projects car roof (y + 1.55 m) directly ahead to viewport centre", () => {
  const cam = makeCamera();
  const res = projectNameplates(
    [peer({ peerId: "p1", driverCode: "ALP", name: "Alp", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -40 } })],
    cam,
    VIEW_W,
    VIEW_H,
  );
  assert.equal(res.length, 1);
  assert.ok(Math.abs(res[0].x - VIEW_W / 2) < 0.01, `expected x=${VIEW_W / 2}, got ${res[0].x}`);
  assert.ok(Math.abs(res[0].y - VIEW_H / 2) < 0.01, `expected y=${VIEW_H / 2}, got ${res[0].y}`);
  assert.ok(Math.abs(res[0].distanceM - 40) < 0.01);
  assert.equal(res[0].opacity, 1);
  assert.equal(res[0].label, "Alp");
});

check("projects left/right and elevated cars to the expected screen quadrants", () => {
  const cam = makeCamera();
  const res = projectNameplates(
    [
      peer({ peerId: "left", driverCode: "LFT", position: { x: -5, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -30 } }),
      peer({ peerId: "right", driverCode: "RGT", position: { x: 5, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -30 } }),
      peer({ peerId: "high", driverCode: "HI", position: { x: 0, y: 4 - NAMEPLATE_ROOF_OFFSET_M, z: -30 } }),
    ],
    cam,
    VIEW_W,
    VIEW_H,
  );
  const byId = new Map(res.map((e) => [e.peerId, e]));
  assert.ok(byId.get("left")!.x < VIEW_W / 2);
  assert.ok(byId.get("right")!.x > VIEW_W / 2);
  assert.ok(byId.get("high")!.y < VIEW_H / 2);
});

check("culls peers behind camera, beyond camera far plane (ndc.z > 1), beyond 180 m, ghosts, and NaN", () => {
  const cam = makeCamera(5000);
  const res = projectNameplates(
    [
      peer({ peerId: "behind", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: 25 } }),
      peer({ peerId: "plane", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: 0 } }),
      peer({ peerId: "at180", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -NAMEPLATE_MAX_DISTANCE_M } }),
      peer({ peerId: "far195", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -195 } }),
      peer({ peerId: "ghost", ghost: true, position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -20 } }),
      peer({ peerId: "bad", position: { x: Number.NaN, y: 0, z: -20 } }),
      peer({ peerId: "visible", driverCode: "VIS", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -50 } }),
    ],
    cam,
    VIEW_W,
    VIEW_H,
  );
  assert.deepEqual(
    res.map((e) => e.peerId),
    ["visible"],
  );

  // Also culls when camera far plane is closer than 180 m (ndc.z > 1)
  const shortFarCam = makeCamera(100);
  const resShort = projectNameplates(
    [
      peer({ peerId: "inside", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -60 } }),
      peer({ peerId: "pastFar", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -120 } }),
    ],
    shortFarCam,
    VIEW_W,
    VIEW_H,
  );
  assert.deepEqual(
    resShort.map((e) => e.peerId),
    ["inside"],
  );
});

check("fades opacity linearly from 90 m to 180 m", () => {
  assert.equal(nameplateOpacity(0), 1);
  assert.equal(nameplateOpacity(45), 1);
  assert.equal(nameplateOpacity(NAMEPLATE_FADE_START_M), 1);
  assert.ok(Math.abs(nameplateOpacity(135) - 0.5) < 1e-9);
  assert.ok(Math.abs(nameplateOpacity(162) - 0.2) < 1e-9);
  assert.equal(nameplateOpacity(NAMEPLATE_MAX_DISTANCE_M), 0);
  assert.equal(nameplateOpacity(250), 0);
  assert.equal(nameplateOpacity(Number.NaN), 0);

  const cam = makeCamera();
  const res = projectNameplates(
    [
      peer({ peerId: "d90", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -90 } }),
      peer({ peerId: "d135", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -135 } }),
      peer({ peerId: "d171", position: { x: 0, y: 2 - NAMEPLATE_ROOF_OFFSET_M, z: -171 } }),
    ],
    cam,
    VIEW_W,
    VIEW_H,
  );
  const byId = new Map(res.map((e) => [e.peerId, e]));
  assert.ok(Math.abs(byId.get("d90")!.opacity - 1) < 1e-6);
  assert.ok(Math.abs(byId.get("d135")!.opacity - 0.5) < 1e-6);
  assert.ok(Math.abs(byId.get("d171")!.opacity - 0.1) < 1e-6);
});

check("practice & qualifying ranks peers + local best valid lap into Gold/Silver/Bronze", () => {
  const peers = [
    peer({ peerId: "a", name: "Alice", driverCode: "ALI", race: { best: 80_500 } }),
    peer({ peerId: "b", name: "Bob", driverCode: "BOB", race: { best: 81_200 } }),
    peer({ peerId: "c", name: "Cara", driverCode: "CAR", race: { best: 82_000 } }),
    peer({ peerId: "unranked-null", driverCode: "NUL", race: { best: null } }),
    peer({ peerId: "unranked-none", driverCode: "NON" }),
    peer({ peerId: "unranked-zero", driverCode: "ZER", race: { best: 0 } }),
    peer({ peerId: "ghost", ghost: true, driverCode: "GHO", race: { best: 70_000 } }),
  ];

  // Local player has fastest lap -> peers take Silver (2), Bronze (3), unhighlighted 4th
  const withFastLocal = rankNameplatePeers(peers, { localBestLapMs: 79_900 });
  assert.equal(withFastLocal.has("ghost"), false);
  assert.deepEqual(withFastLocal.get("a"), { rank: 2, podium: 2, fastestLap: false });
  assert.deepEqual(withFastLocal.get("b"), { rank: 3, podium: 3, fastestLap: false });
  assert.deepEqual(withFastLocal.get("c"), { rank: 4, podium: null, fastestLap: false });
  assert.deepEqual(withFastLocal.get("unranked-null"), { rank: null, podium: null, fastestLap: false });
  assert.deepEqual(withFastLocal.get("unranked-none"), { rank: null, podium: null, fastestLap: false });
  assert.deepEqual(withFastLocal.get("unranked-zero"), { rank: null, podium: null, fastestLap: false });

  // Local player has no valid lap yet -> peers take Gold (1), Silver (2), Bronze (3)
  const withoutLocal = rankNameplatePeers(peers, { localBestLapMs: null });
  assert.deepEqual(withoutLocal.get("a"), { rank: 1, podium: 1, fastestLap: false });
  assert.deepEqual(withoutLocal.get("b"), { rank: 2, podium: 2, fastestLap: false });
  assert.deepEqual(withoutLocal.get("c"), { rank: 3, podium: 3, fastestLap: false });
});

check("practice & qualifying handles ties with standard competition ranking (1, 1, 3)", () => {
  const peers = [
    peer({ peerId: "a", race: { best: 80_000 } }),
    peer({ peerId: "b", race: { best: 80_000 } }),
    peer({ peerId: "c", race: { best: 81_000 } }),
    peer({ peerId: "d", race: { best: 82_000 } }),
  ];
  const r = rankNameplatePeers(peers, { localBestLapMs: null });
  assert.deepEqual(r.get("a"), { rank: 1, podium: 1, fastestLap: false });
  assert.deepEqual(r.get("b"), { rank: 1, podium: 1, fastestLap: false });
  assert.deepEqual(r.get("c"), { rank: 3, podium: 3, fastestLap: false });
  assert.deepEqual(r.get("d"), { rank: 4, podium: null, fastestLap: false });

  // Local player ties for 1st -> local + a + b share 1st, c is 4th (no podium)
  const rLocalTie = rankNameplatePeers(peers, { localBestLapMs: 80_000 });
  assert.deepEqual(rLocalTie.get("a"), { rank: 1, podium: 1, fastestLap: false });
  assert.deepEqual(rLocalTie.get("b"), { rank: 1, podium: 1, fastestLap: false });
  assert.deepEqual(rLocalTie.get("c"), { rank: 4, podium: null, fastestLap: false });
});

check("race mode assigns P1/P2/P3 from standings and attaches FL pill to overall fastest lap", () => {
  const peers = [
    peer({ peerId: "ai-1", driverCode: "VER", isAiPeer: true }),
    peer({ peerId: "ai-2", driverCode: "HAM", isAiPeer: true }),
    peer({ peerId: "ai-3", driverCode: "LEC", isAiPeer: true }),
    peer({ peerId: "ai-4", driverCode: "NOR", isAiPeer: true }),
  ];
  const standings: RaceStandingEntry[] = [
    standing({ driverCode: "VER", bestLapMs: 81_000 }),
    standing({ driverCode: "YOU", isPlayer: true, bestLapMs: 80_500 }),
    standing({ driverCode: "HAM", bestLapMs: 81_400 }),
    standing({ driverCode: "LEC", bestLapMs: 79_800 }), // P4 holds overall fastest lap
    standing({ driverCode: "NOR", bestLapMs: null }),
  ];

  const r = rankNameplatePeers(peers, { race: { standings } });
  assert.deepEqual(r.get("ai-1"), { rank: 1, podium: 1, fastestLap: false });
  assert.deepEqual(r.get("ai-2"), { rank: 3, podium: 3, fastestLap: false });
  assert.deepEqual(r.get("ai-3"), { rank: 4, podium: null, fastestLap: true });
  assert.deepEqual(r.get("ai-4"), { rank: 5, podium: null, fastestLap: false });

  // When the local player holds overall fastest lap, no opponent gets FL
  const standingsPlayerFl: RaceStandingEntry[] = [
    standing({ driverCode: "VER", bestLapMs: 81_000 }),
    standing({ driverCode: "YOU", isPlayer: true, bestLapMs: 78_900 }),
    standing({ driverCode: "HAM", bestLapMs: 81_400 }),
  ];
  const r2 = rankNameplatePeers(peers.slice(0, 2), { race: { standings: standingsPlayerFl } });
  assert.equal(r2.get("ai-1")?.fastestLap, false);
  assert.equal(r2.get("ai-2")?.fastestLap, false);
});

check("race mode disambiguates remote peers with identical driverCode by nickname", () => {
  const peers = [
    peer({ peerId: "u1", driverCode: "DRV", name: "Alice" }),
    peer({ peerId: "u2", driverCode: "DRV", name: "Bob" }),
  ];
  const standings: RaceStandingEntry[] = [
    standing({ driverCode: "DRV", name: "Bob", bestLapMs: 80_000 }),
    standing({ driverCode: "DRV", name: "Alice", bestLapMs: 82_000 }),
  ];
  const r = rankNameplatePeers(peers, { race: { standings } });
  assert.deepEqual(r.get("u2"), { rank: 1, podium: 1, fastestLap: true });
  assert.deepEqual(r.get("u1"), { rank: 2, podium: 2, fastestLap: false });
});

check("label fallback, optional badges slot, and stateful projector reuse", () => {
  assert.equal(nameplateLabel({ name: "  Senna  ", driverCode: "SEN" }), "Senna");
  assert.equal(nameplateLabel({ name: "   ", driverCode: "VER" }), "VER");
  assert.equal(nameplateLabel({ driverCode: "HAM" }), "HAM");

  const cam = makeCamera();
  const projector = new OverheadNameplateProjector();
  const frame1 = projector.project(
    [peer({ peerId: "p1", name: "Kai", driverCode: "KAI", badges: ["WC1", "GOLD"], race: { best: 78_000 } })],
    cam,
    VIEW_W,
    VIEW_H,
    { localBestLapMs: null },
  );
  assert.equal(frame1.length, 1);
  assert.equal(frame1[0].podium, 1);
  assert.deepEqual(frame1[0].badges, ["WC1", "GOLD"]);

  const frame2 = projector.project([], cam, VIEW_W, VIEW_H);
  assert.equal(frame2.length, 0);
});

check("showPlayerNames HUD setting defaults to true and parses safely from saves", () => {
  assert.equal(DEFAULT_HUD_SETTINGS.showPlayerNames, true);
  assert.equal(parsePlayerSettings({}).hud.showPlayerNames, true);
  assert.equal(parsePlayerSettings({ hud: {} }).hud.showPlayerNames, true);
  assert.equal(parsePlayerSettings({ hud: { showPlayerNames: false } }).hud.showPlayerNames, false);
  assert.equal(parsePlayerSettings({ hud: { showPlayerNames: "invalid" } }).hud.showPlayerNames, true);
});

check("formatNameplateBadges orders badges canonically with concise codes and counts", () => {
  assert.deepEqual(formatNameplateBadges([]), []);
  const badges: DriverBadge[] = [
    { type: "bulb", count: 1, note: "Wet tyres" },
    { type: "og", count: 1 },
    { type: "track_record", count: 3 },
    { type: "weekly_bronze", count: 1 },
    { type: "weekly_gold", count: 2 },
    { type: "weekly_silver", count: 1 },
  ];
  assert.deepEqual(formatNameplateBadges(badges), ["G×2", "S", "B", "FL×3", "OG", "IDEA"]);

  // Context-aware & class-tagged Fastest Lap formatting on nameplates
  const classBadges: DriverBadge[] = [
    {
      type: "track_record",
      count: 2,
      boards: [
        { trackId: "norisring", vehicle: "lc26", lapTimeMs: 44_800, drivers: 65 },
        { trackId: "okayama", vehicle: "lc26", lapTimeMs: 70_100, drivers: 39 },
      ],
    },
    { type: "og", count: 1 },
  ];
  assert.deepEqual(formatNameplateBadges(classBadges, { scope: "all" }), ["FL·F1×2", "OG"]);
  assert.deepEqual(formatNameplateBadges(classBadges, { scope: "vehicle", vehicle: "lc26" }), ["FL×2", "OG"]);
  assert.deepEqual(formatNameplateBadges(classBadges, { scope: "class", classId: "gt3" }), ["OG"]);
});

async function runAsyncChecks() {
  // NameplateBadgeCache batch-fetches unseen human peers once, skips AI/ghost, and serves cached codes to projector
  const calls: string[][] = [];
  const cache = new NameplateBadgeCache(async (names) => {
    calls.push([...names]);
    return {
      alice: [{ type: "weekly_gold", count: 2 }, { type: "og", count: 1 }],
      "alice v2": [
        {
          type: "track_record",
          count: 1,
          boards: [{ trackId: "norisring", vehicle: "lc26", lapTimeMs: 44_800, drivers: 65 }],
        },
      ],
    };
  });

  const batch1 = cache.syncPeers([
    peer({ peerId: "h1", name: "Alice", isAiPeer: false }),
    peer({ peerId: "h2", name: "  alice  ", isAiPeer: false }),
    peer({ peerId: "ai1", name: "AI Driver", isAiPeer: true }),
    peer({ peerId: "g1", name: "Ghost Driver", isAiPeer: false, ghost: true }),
  ]);
  assert.ok(batch1 !== null);
  await batch1;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["Alice"]);
  assert.deepEqual(cache.get("Alice"), ["G×2", "OG"]);
  assert.deepEqual(cache.get("ALICE"), ["G×2", "OG"]);
  assert.equal(cache.get("AI Driver"), undefined);

  // Calling syncPeers again with unchanged names does zero fetches
  const batchRepeat = cache.syncPeers([peer({ peerId: "h1", name: "Alice", isAiPeer: false })]);
  assert.equal(batchRepeat, null);
  assert.equal(calls.length, 1);

  // When a peer changes name, only the newly seen name is fetched
  const batchRenamed = cache.syncPeers([
    peer({ peerId: "h1", name: "Alice V2", isAiPeer: false }),
    peer({ peerId: "h2", name: "Alice", isAiPeer: false }),
  ]);
  assert.ok(batchRenamed !== null);
  await batchRenamed;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["Alice V2"]);
  assert.deepEqual(cache.get("Alice V2"), ["FL·F1"]);
  cache.setContext({ scope: "class", classId: "gt3" });
  assert.equal(cache.get("Alice V2"), undefined);
  cache.setContext({ scope: "vehicle", vehicle: "lc26" });
  assert.deepEqual(cache.get("Alice V2"), ["FL"]);
  cache.setContext({ scope: "all" });
  assert.deepEqual(cache.get("Alice V2"), ["FL·F1"]);

  // Projector attaches cached badges to remote human peers and skips AI peers even with matching names
  const cam = makeCamera();
  const projector = new OverheadNameplateProjector();
  const projected = projector.project(
    [
      peer({ peerId: "human", name: "Alice", isAiPeer: false }),
      peer({ peerId: "ai-same-name", name: "Alice", isAiPeer: true }),
      peer({ peerId: "explicit", name: "Alice", isAiPeer: false, badges: ["CUSTOM"] }),
    ],
    cam,
    VIEW_W,
    VIEW_H,
    { badgesByNameKey: cache.map },
  );
  const byId = new Map(projected.map((e) => [e.peerId, e]));
  assert.deepEqual(byId.get("human")?.badges, ["G×2", "OG"]);
  assert.equal(byId.get("ai-same-name")?.badges, undefined);
  assert.deepEqual(byId.get("explicit")?.badges, ["CUSTOM"]);
  passed++;
  console.log("  ok  NameplateBadgeCache batch-fetches once per name change, skips AI/ghost, and feeds projector");

  // Offline / rejected fetch is a graceful no-op and does not hammer on repeat syncs
  let offlineCalls = 0;
  const offlineCache = new NameplateBadgeCache(async () => {
    offlineCalls++;
    throw new Error("offline");
  });
  const off1 = offlineCache.syncPeers([peer({ peerId: "h1", name: "Bob", isAiPeer: false })]);
  assert.ok(off1 !== null);
  await off1;
  assert.equal(offlineCalls, 1);
  assert.equal(offlineCache.get("Bob"), undefined);
  assert.equal(offlineCache.syncPeers([peer({ peerId: "h1", name: "Bob", isAiPeer: false })]), null);
  assert.equal(offlineCalls, 1);
  cache.dispose();
  offlineCache.dispose();
  passed++;
  console.log("  ok  NameplateBadgeCache handles offline/failed fetches gracefully without retrying in loop");
}

runAsyncChecks()
  .then(() => {
    console.log(`verify-nameplates: ${passed} checks passed`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
