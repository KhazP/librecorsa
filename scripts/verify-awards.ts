/**
 * Headless verification of Weekly Challenge Badges & Hall of Fame (issue #129):
 *   - Migration 0008 schema, constraints and uniqueness index
 *   - Hall of Fame ranking preserving both Physics V1 and V2 podiums, tie-breaking, archive persistence,
 *     in-progress week exclusion from medals/tally, and Most Decorated sorting
 *   - Batch badge aggregation (weekly medals, track_record on current official boards only, OG on Physics V1,
 *     manual Bulb with note, 64-name batch cap, and graceful pre-0008 fallback)
 *   - Driver rename moving awards cleanly
 *   - Admin awards endpoints (auth parity with /api/admin/*, grant/update/revoke, driver search, validation)
 *   - Client parsers, formatters and badge cache (src/lib/net/awards.ts)
 *
 *   npx tsx scripts/verify-awards.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleApi, SHARED_ANSWER_S } from "../cloudflare/api/index";
import { driverNameKey, renameDriver, type BoardDeps } from "../cloudflare/api/board";
import { checkAwardInput, hallOfFameEvents, parseBadgeNames, physicsIdOf, rankPodiums, tallyMostDecorated, type AdminAward } from "../cloudflare/api/awards";
import type { AdminAwardsBody } from "../cloudflare/api/admin";
import {
  badgeDetail,
  badgeLabel,
  badgeQueryNames,
  fetchBadges,
  forgetBadges,
  MAX_BADGE_NAMES,
  parseBadges,
  parseHallOfFame,
  type DriverBadge,
  type HallOfFameAnswer,
} from "../src/lib/net/awards";
import { challengeAt } from "../src/lib/net/weekly-challenge";
import { boardPhysicsVersion, CIRCUIT_REVISION_STEP, lapPhysicsVersion } from "../src/lib/sim/lap-types";
import type { D1Database, Env, RateLimit } from "../cloudflare/api/types";
import type { VehicleModelId } from "../src/types/f1";
import { fakeD1, fakeR2 } from "./lib/fake-cloudflare";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(68)} ${detail}`);
  if (!ok) failures.push(name);
};

const migrations = join(__dirname, "..", "cloudflare", "migrations");
const sql = (...files: string[]) => files.map((f) => readFileSync(join(migrations, f), "utf8")).join("\n");
const PRE_0008 = sql("0001_lap_boards.sql", "0002_race_results.sql", "0003_usage.sql", "0004_admin_numbers.sql", "0005_lc26.sql", "0006_lap_counts.sql", "0007_lap_input.sql");
const FULL = `${PRE_0008}\n${sql("0008_awards.sql")}`;

const KEY = "test-admin-secret-key-for-awards";
const NOW = Date.UTC(2026, 10, 25, 12); // Wednesday of 2026-W48
const CURRENT_WEEK = challengeAt(NOW).id; // 2026-W48

let seq = 0;
async function addLap(
  db: D1Database,
  o: {
    name: string;
    track: string;
    vehicle: VehicleModelId;
    physics: number;
    ms: number;
    event?: string;
    assists?: string;
    created?: number;
  },
) {
  seq++;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db
    .prepare(
      "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      o.track,
      o.vehicle,
      o.physics,
      o.event ?? "",
      o.assists ?? "pro",
      "full",
      "dry",
      "soft",
      driverNameKey(o.name),
      o.name,
      o.name.slice(0, 3).toUpperCase(),
      o.ms,
      o.ms / 3,
      o.ms / 3,
      o.ms / 3,
      NOW,
      o.created ?? NOW + seq,
    )
    .run();
  return id;
}

async function addDriver(db: D1Database, name: string, keyHash = "hash") {
  await db
    .prepare("INSERT OR IGNORE INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES (?, ?, ?, ?)")
    .bind(driverNameKey(name), keyHash, NOW - 10_000, NOW)
    .run();
}

function apiCall(env: Env, path: string, opts: { method?: string; key?: string; body?: unknown; ip?: string } = {}) {
  const url = new URL(`https://librecorsa.org${path}`);
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return handleApi(
    new Request(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    url,
  );
}

function limiter(max: number): RateLimit {
  const hits = new Map<string, number>();
  return {
    limit: async ({ key }) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= max };
    },
  };
}

async function main(): Promise<void> {
  // 1. Pure ranking & physics version mapping ------------------------------------------------------------------------
  check("physicsIdOf: maps V1, V2, LC26 offsets and restarted circuits", physicsIdOf(7) === "v1" && physicsIdOf(527) === "v1" && physicsIdOf(1007) === "v1" && physicsIdOf(8) === "v2" && physicsIdOf(528) === "v2" && physicsIdOf(2528) === "v2");

  const ranked = rankPodiums(
    [
      // 2026-W46 Physics V1 (liana physics=7) with a tie on time and duplicate class entry for Alice
      { event: "2026-W46", physics: 7, track_id: "dunsfold", vehicle: "liana", name_key: "alice", driver_name: "Alice", lap_time_ms: 80_000, created_at: 200, id: "b" },
      { event: "2026-W46", physics: 7, track_id: "dunsfold", vehicle: "liana", name_key: "alice", driver_name: "Alice", lap_time_ms: 81_500, created_at: 150, id: "a" },
      { event: "2026-W46", physics: 7, track_id: "dunsfold", vehicle: "liana", name_key: "bob", driver_name: "Bob", lap_time_ms: 80_000, created_at: 100, id: "c" },
      { event: "2026-W46", physics: 7, track_id: "dunsfold", vehicle: "liana", name_key: "carol", driver_name: "Carol", lap_time_ms: 82_000, created_at: 100, id: "d" },
      { event: "2026-W46", physics: 7, track_id: "dunsfold", vehicle: "liana", name_key: "dave", driver_name: "Dave", lap_time_ms: 83_000, created_at: 100, id: "e" },
      // 2026-W46 Physics V2 (liana physics=8): distinct podium preserved alongside V1!
      { event: "2026-W46", physics: 8, track_id: "dunsfold", vehicle: "liana", name_key: "carol", driver_name: "Carol", lap_time_ms: 78_500, created_at: 300, id: "f" },
      { event: "2026-W46", physics: 8, track_id: "dunsfold", vehicle: "liana", name_key: "alice", driver_name: "Alice", lap_time_ms: 79_000, created_at: 300, id: "g" },
      // 2026-W47 Physics V2 with a circuit restart (1008 beats 8)
      { event: "2026-W47", physics: 8, track_id: "le_mans_82", vehicle: "lc-lmdh", name_key: "old", driver_name: "Old", lap_time_ms: 190_000, created_at: 100, id: "h" },
      { event: "2026-W47", physics: 8 + CIRCUIT_REVISION_STEP, track_id: "le_mans_82", vehicle: "lc-lmdh", name_key: "alice", driver_name: "Alice", lap_time_ms: 192_000, created_at: 400, id: "i" },
      // Current week (2026-W48) — in progress
      { event: CURRENT_WEEK, physics: 8, track_id: "spielberg", vehicle: "amg-gt3", name_key: "dave", driver_name: "Dave", lap_time_ms: 85_000, created_at: 500, id: "j" },
    ],
    NOW,
  );

  check("rankPodiums: preserves V1 and V2 for the same week, newest first", ranked.map((e) => `${e.event}:${e.physics}`).join(",") === `${CURRENT_WEEK}:v2,2026-W47:v2,2026-W46:v2,2026-W46:v1`, ranked.map((e) => `${e.event}:${e.physics}`).join(","));
  const w46v1 = ranked.find((e) => e.event === "2026-W46" && e.physics === "v1")!;
  check("rankPodiums: tie breaks by earlier created_at and deduplicates driver", w46v1.podium.map((p) => `${p.place}:${p.nameKey}`).join(",") === "1:bob,2:alice,3:carol", w46v1.podium.map((p) => `${p.place}:${p.nameKey}`).join(","));
  const w47v2 = ranked.find((e) => e.event === "2026-W47" && e.physics === "v2")!;
  check("rankPodiums: newer circuit revision wins within same named version", w47v2.podium.length === 1 && w47v2.podium[0].nameKey === "alice");
  check("rankPodiums: marks current week as current=true and finished weeks false", ranked[0].current === true && ranked.slice(1).every((e) => e.current === false));

  const tally = tallyMostDecorated(ranked);
  check("tallyMostDecorated: ignores current week and sorts gold > silver > bronze", tally.map((d) => `${d.nameKey}:${d.gold}-${d.silver}-${d.bronze}`).join(",") === "alice:1-2-0,carol:1-0-1,bob:1-0-0", tally.map((d) => `${d.nameKey}:${d.gold}-${d.silver}-${d.bronze}`).join(","));

  // 2. Migration 0008 constraints ------------------------------------------------------------------------------------
  {
    const db = fakeD1(FULL);
    let badTypeRejected = false;
    try {
      await db.prepare("INSERT INTO driver_awards (name_key, badge_type, awarded_at) VALUES ('alice', 'invalid_badge', 1)").run();
    } catch {
      badTypeRejected = true;
    }
    check("migration 0008: rejects unknown badge_type via CHECK constraint", badTypeRejected);

    await db.prepare("INSERT INTO driver_awards (name_key, badge_type, event_id, physics, awarded_at) VALUES ('alice', 'weekly_gold', '2026-W46', 'v1', 1)").run();
    let dupRejected = false;
    try {
      await db.prepare("INSERT INTO driver_awards (name_key, badge_type, event_id, physics, awarded_at) VALUES ('alice', 'weekly_gold', '2026-W46', 'v1', 2)").run();
    } catch {
      dupRejected = true;
    }
    check("migration 0008: unique index prevents duplicate auto/manual awards", dupRejected);
  }

  // 3. End-to-end Hall of Fame, auto-archiving, and Badges API -------------------------------------------------------
  {
    const db = fakeD1(FULL);
    const env = { ONLINE_BOARD: "on", BOARD_DB: db, GHOSTS: fakeR2(), ADMIN_KEY: KEY } as unknown as Env;

    for (const n of ["Alice", "Bob", "Carol", "Dave", "Eve"]) await addDriver(db, n);

    const v1Liana = boardPhysicsVersion(7, "liana");
    const v2Liana = lapPhysicsVersion("liana", "dunsfold");
    const v1Lc26 = boardPhysicsVersion(7, "lc26");
    const v2Lc26 = lapPhysicsVersion("lc26", "sachsenring");
    const v2Gt3 = lapPhysicsVersion("amg-gt3", "spielberg");

    // Completed week 2026-W46: both V1 and V2 podiums
    await addLap(db, { name: "Alice", track: "dunsfold", vehicle: "liana", physics: v1Liana, ms: 80_000, event: "2026-W46" });
    await addLap(db, { name: "Bob", track: "dunsfold", vehicle: "liana", physics: v1Liana, ms: 81_000, event: "2026-W46" });
    await addLap(db, { name: "Carol", track: "dunsfold", vehicle: "liana", physics: v1Liana, ms: 82_000, event: "2026-W46" });
    await addLap(db, { name: "Dave", track: "dunsfold", vehicle: "liana", physics: v2Liana, ms: 79_000, event: "2026-W46" });
    await addLap(db, { name: "Alice", track: "dunsfold", vehicle: "liana", physics: v2Liana, ms: 79_500, event: "2026-W46" });

    // Current week (running at Date.now()): compute dynamically via challengeAt(Date.now())
    const liveWeek = challengeAt(Date.now()).id;
    await addLap(db, { name: "Eve", track: "spielberg", vehicle: "amg-gt3", physics: v2Gt3, ms: 88_000, event: liveWeek });

    // Open boards: track records + OG
    // Alice holds current track record on sachsenring lc26 (V2)
    await addLap(db, { name: "Alice", track: "sachsenring", vehicle: "lc26", physics: v2Lc26, ms: 62_000 });
    await addLap(db, { name: "Dave", track: "sachsenring", vehicle: "lc26", physics: v2Lc26, ms: 63_000 });
    // Bob holds P1 on OLD V1 board (grants OG, NOT track_record)
    await addLap(db, { name: "Bob", track: "sachsenring", vehicle: "lc26", physics: v1Lc26, ms: 61_000 });
    // Eve holds P1 on a retired/unofficial track (NOT track_record)
    await addLap(db, { name: "Eve", track: "retired_fake_circuit", vehicle: "amg-gt3", physics: v2Gt3, ms: 70_000 });

    // First Hall of Fame read archives finished week 2026-W46 (both V1 and V2)
    const hofRes = await apiCall(env, "/api/hall-of-fame");
    const hofBody = (await hofRes.json()) as HallOfFameAnswer;
    check(
      "api: GET /api/hall-of-fame returns V1 & V2 podiums with shared cache",
      hofRes.status === 200 &&
        hofRes.headers.get("Cache-Control") === `public, max-age=${SHARED_ANSWER_S.hallOfFame}` &&
        hofBody.ok &&
        hofBody.events.some((e) => e.event === "2026-W46" && e.physics === "v1" && e.podium.length === 3) &&
        hofBody.events.some((e) => e.event === "2026-W46" && e.physics === "v2" && e.podium.length === 2),
      hofBody.events.map((e) => `${e.event}:${e.physics}(${e.podium.length})`).join(", "),
    );

    const archivedCount = (await db.prepare("SELECT COUNT(*) AS n FROM driver_awards WHERE awarded_by = 'auto'").first<{ n: number }>())?.n ?? 0;
    check("hall-of-fame: auto-archives finished V1 + V2 podiums (5 rows), not current week", archivedCount === 5, `archived=${archivedCount}`);

    // Delete 2026-W46 laps and verify archived podiums survive!
    await db.prepare("DELETE FROM laps WHERE event = '2026-W46'").run();
    const hofAfterDelete = (await (await apiCall(env, "/api/hall-of-fame")).json()) as HallOfFameAnswer;
    const archivedAfter = (await db.prepare("SELECT COUNT(*) AS n FROM driver_awards WHERE awarded_by = 'auto'").first<{ n: number }>())?.n ?? 0;
    check(
      "hall-of-fame: archived V1 & V2 podiums persist after laps removed, no duplicates",
      archivedAfter === 5 &&
        hofAfterDelete.events.some((e) => e.event === "2026-W46" && e.physics === "v1" && e.podium[0].name === "Alice") &&
        hofAfterDelete.events.some((e) => e.event === "2026-W46" && e.physics === "v2" && e.podium[0].name === "Dave"),
    );

    // Grant Bulb badge via Admin API to Dave
    const grantRes = await apiCall(env, "/api/admin/awards", {
      method: "POST",
      key: KEY,
      body: { name: "Dave", note: "Suggested wet-weather spray fix" },
    });
    const grantBody = (await grantRes.json()) as { ok: boolean; award?: AdminAward };
    check("admin: POST /api/admin/awards defaults to bulb and saves note", grantRes.status === 200 && grantBody.ok && grantBody.award?.badge === "bulb" && grantBody.award.note === "Suggested wet-weather spray fix");

    // Batch GET /api/badges
    const badgesRes = await apiCall(env, "/api/badges?names=Alice,Bob,Carol,Dave,Eve");
    const badgesBody = (await badgesRes.json()) as { ok: boolean; badges: Record<string, DriverBadge[]> };
    const types = (k: string) => (badgesBody.badges[k] ?? []).map((b) => `${b.type}:${b.count}`).join(",");
    check(
      "badges: Alice has weekly_gold (V1), weekly_silver (V2), track_record",
      badgesRes.status === 200 &&
        badgesRes.headers.get("Cache-Control") === `public, max-age=${SHARED_ANSWER_S.badges}` &&
        types("alice") === "weekly_gold:1,weekly_silver:1,track_record:1",
      types("alice"),
    );
    check("badges: Bob has weekly_silver (V1) and og (V1 LC26 lap), not track_record", types("bob") === "weekly_silver:1,og:1", types("bob"));
    check("badges: Dave has weekly_gold (V2) and bulb with note, not og", types("dave") === "weekly_gold:1,bulb:1" && badgesBody.badges.dave.find((b) => b.type === "bulb")?.note === "Suggested wet-weather spray fix", types("dave"));
    check("badges: Eve (only current week + unofficial track) has no badges", (badgesBody.badges.eve ?? []).length === 0, types("eve"));

    // Batch cap (>64 names rejected)
    const tooMany = Array.from({ length: MAX_BADGE_NAMES + 1 }, (_, i) => `Driver${i}`).join(",");
    const capRes = await apiCall(env, `/api/badges?names=${tooMany}`);
    check("badges: rejects >64 unique names with 400", capRes.status === 400);

    // Driver rename moves driver_awards cleanly
    const driverKey = "a".repeat(40);
    await db.prepare("DELETE FROM drivers WHERE name_key = 'dave'").run();
    const keyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(driverKey))), (b) => b.toString(16).padStart(2, "0")).join("");
    await addDriver(db, "Dave", keyHash);
    const boardDeps: BoardDeps = { db, ghosts: fakeR2(), eventRule: () => null, now: () => NOW };
    const ren = await renameDriver(
      boardDeps,
      new Request("https://librecorsa.org/api/drivers/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Dave", to: "David", driverKey }),
      }),
    );
    const renamedBadges = (await (await apiCall(env, "/api/badges?names=Dave,David")).json()) as { ok: boolean; badges: Record<string, DriverBadge[]> };
    check(
      "rename: moves manual bulb and archived medals to new name",
      ren.status === 200 &&
        (renamedBadges.badges.dave ?? []).length === 0 &&
        (renamedBadges.badges.david ?? []).map((b) => b.type).join(",") === "weekly_gold,bulb",
      (renamedBadges.badges.david ?? []).map((b) => b.type).join(","),
    );
  }

  // 4. Admin validation, auth parity, search, update, and revoke -----------------------------------------------------
  {
    const db = fakeD1(FULL);
    const limit = limiter(10);
    const env = { ONLINE_BOARD: "on", BOARD_DB: db, GHOSTS: fakeR2(), ADMIN_KEY: KEY, ADMIN_LIMIT: limit } as unknown as Env;
    await addDriver(db, "Max_Test%1");
    await addDriver(db, "Maxine");

    // Auth guard: wrong key or missing key on GET/POST/DELETE returns plain 404
    const unauthGet = await apiCall(env, "/api/admin/awards", { ip: "1.1.1.1" });
    const unauthPost = await apiCall(env, "/api/admin/awards", { method: "POST", key: "wrong", body: { name: "Maxine" }, ip: "1.1.1.1" });
    const unauthDel = await apiCall(env, "/api/admin/awards/1", { method: "DELETE", key: "wrong", ip: "1.1.1.1" });
    check("admin awards: unauthorized GET/POST/DELETE return 404", unauthGet.status === 404 && unauthPost.status === 404 && unauthDel.status === 404);

    // Input validation unit checks
    check("checkAwardInput: rejects weekly_gold manual grant", !checkAwardInput({ name: "Alice", badge: "weekly_gold" }).ok);
    check("checkAwardInput: rejects empty name and comma in name", !checkAwardInput({ name: "   " }).ok && !checkAwardInput({ name: "a,b" }).ok);
    check("checkAwardInput: accepts name_key & badge_type aliases and cleans control chars", (() => {
      const r = checkAwardInput({ name_key: "Maxine", badge_type: "bulb", note: "Great\nidea\t!" });
      return r.ok && r.award.nameKey === "maxine" && r.award.badge === "bulb" && r.award.note === "Great idea !";
    })());

    // Grant, update note, search with LIKE wildcard escaping, revoke
    const g1 = (await (await apiCall(env, "/api/admin/awards", { method: "POST", key: KEY, body: { name: "Maxine", note: "First note" }, ip: "2.2.2.2" })).json()) as { ok: boolean; award: AdminAward };
    const g2 = (await (await apiCall(env, "/api/admin/awards", { method: "POST", key: KEY, body: { name: "Maxine", note: "Updated note" }, ip: "2.2.2.2" })).json()) as { ok: boolean; award: AdminAward };
    check("admin awards: re-granting updates note on same row without duplicating", g1.ok && g2.ok && g1.award.id === g2.award.id && g2.award.note === "Updated note");

    const listSearch = (await (await apiCall(env, "/api/admin/awards?q=%251", { key: KEY, ip: "2.2.2.2" })).json()) as AdminAwardsBody;
    check(
      "admin awards: GET ?q= escapes LIKE wildcards and lists manual awards",
      listSearch.ok && listSearch.ready && listSearch.awards.length === 1 && listSearch.drivers.length === 1 && listSearch.drivers[0].nameKey === "max_test%1",
      JSON.stringify(listSearch.drivers),
    );

    const delOk = await apiCall(env, `/api/admin/awards/${g1.award.id}`, { method: "DELETE", key: KEY, ip: "2.2.2.2" });
    const delAgain = await apiCall(env, `/api/admin/awards/${g1.award.id}`, { method: "DELETE", key: KEY, ip: "2.2.2.2" });
    check("admin awards: DELETE revokes award (200) and second delete returns 404", delOk.status === 200 && delAgain.status === 404);
  }

  // 5. Pre-migration 0008 graceful fallback --------------------------------------------------------------------------
  {
    const db = fakeD1(PRE_0008);
    const env = { ONLINE_BOARD: "on", BOARD_DB: db, GHOSTS: fakeR2(), ADMIN_KEY: KEY } as unknown as Env;
    await addLap(db, { name: "Alice", track: "dunsfold", vehicle: "liana", physics: 7, ms: 80_000, event: "2026-W46" });
    const hof = (await (await apiCall(env, "/api/hall-of-fame")).json()) as HallOfFameAnswer;
    const badges = (await (await apiCall(env, "/api/badges?names=Alice")).json()) as { ok: boolean; badges: Record<string, DriverBadge[]> };
    const adm = (await (await apiCall(env, "/api/admin/awards", { key: KEY })).json()) as AdminAwardsBody;
    check(
      "pre-0008 fallback: hall-of-fame, badges and admin awards still answer cleanly",
      hof.ok && hof.events.length === 1 && badges.ok && badges.badges.alice.some((b) => b.type === "weekly_gold") && adm.ok && adm.ready === false,
    );
  }

  // 6. Client helpers & cache (src/lib/net/awards.ts) ----------------------------------------------------------------
  {
    check("client: badgeLabel and badgeDetail format counts and notes", badgeLabel({ type: "weekly_gold", count: 2 }) === "Weekly Gold ×2" && badgeLabel({ type: "bulb", count: 1, note: "Replay bar" }) === "Idea Contributor — Replay bar" && badgeDetail({ type: "og", count: 1 }).includes("Physics V1"));
    check("client: badgeQueryNames deduplicates and drops commas", badgeQueryNames([" Alice ", "alice", "Bad,Name", "Bob"]).join(",") === "alice,bob");
    check("client: parseHallOfFame and parseBadges drop malformed items", parseHallOfFame({ ok: true, current: "2026-W48", events: [{ event: "bad", physics: "v1", podium: [] }], mostDecorated: [] })?.events.length === 0 && parseBadges({ ok: true, badges: { alice: [{ type: "bulb", count: 1, note: "Hi" }, { type: "nope", count: 1 }] } })?.alice.length === 1);

    forgetBadges();
    let calls = 0;
    const mockFetch = async (url: string) => {
      calls++;
      if (!url.includes("alice%2Cbob")) throw new Error(`Expected sorted query, got ${url}`);
      return { status: 200, body: { ok: true, badges: { alice: [{ type: "og", count: 1 }], bob: [] } } };
    };
    const first = await fetchBadges(["Bob", "Alice"], { nowMs: 1000, fetchJson: mockFetch });
    const second = await fetchBadges(["alice", "bob"], { nowMs: 2000, fetchJson: mockFetch });
    check("client: fetchBadges caches hits and sorts query keys", calls === 1 && first.alice?.[0]?.type === "og" && second.alice?.[0]?.type === "og" && second.bob === undefined);

    forgetBadges();
    const offline = await fetchBadges(["Alice"], { nowMs: 1000, fetchJson: async () => null });
    check("client: fetchBadges returns empty map gracefully when offline", Object.keys(offline).length === 0);
  }

  // 7. Admin lap deletion / driver clear refreshes archived auto weekly awards, plus /api/badges canonicalization & rate limit
  {
    const db = fakeD1(FULL);
    const ghosts = fakeR2();
    const badgeLim = limiter(2);
    const env = {
      ONLINE_BOARD: "on",
      BOARD_DB: db,
      GHOSTS: ghosts,
      ADMIN_KEY: KEY,
      BADGES_LIMIT: badgeLim,
    } as unknown as Env;

    const v1Liana = boardPhysicsVersion(7, "liana");
    const v2Liana = lapPhysicsVersion("liana", "dunsfold");
    const cheatLapId = await addLap(db, { name: "Cheater", track: "dunsfold", vehicle: "liana", physics: v1Liana, ms: 50_000, event: "2026-W46" });
    await ghosts.put(`laps/${cheatLapId}.json`, "{}");
    await addLap(db, { name: "Alice", track: "dunsfold", vehicle: "liana", physics: v1Liana, ms: 80_000, event: "2026-W46" });
    await addLap(db, { name: "Bob", track: "dunsfold", vehicle: "liana", physics: v1Liana, ms: 81_000, event: "2026-W46" });
    await addLap(db, { name: "Carol", track: "dunsfold", vehicle: "liana", physics: v1Liana, ms: 82_000, event: "2026-W46" });
    await addLap(db, { name: "Dave", track: "dunsfold", vehicle: "liana", physics: v2Liana, ms: 79_000, event: "2026-W46" });

    // Archive 2026-W46 (V1 has Cheater P1, Alice P2, Bob P3; V2 has Dave P1) and give Alice a manual bulb award
    await apiCall(env, "/api/hall-of-fame");
    await apiCall(env, "/api/admin/awards", { method: "POST", key: KEY, body: { name: "Alice", note: "Keep manual award" } });

    // Unauthorized DELETE returns 404 parity
    const unauthLapDel = await apiCall(env, `/api/admin/laps/${cheatLapId}`, { method: "DELETE", key: "wrong" });
    const unauthDriverDel = await apiCall(env, "/api/admin/drivers/Cheater/laps", { method: "DELETE" });
    check("admin lap/driver delete: unauthorized requests return 404", unauthLapDel.status === 404 && unauthDriverDel.status === 404);

    // Admin deletes the fraudulent P1 lap -> auto rows for 2026-W46:v1 invalidated, ghost removed, V2 & manual bulb untouched
    const delLapRes = await apiCall(env, `/api/admin/laps/${cheatLapId}`, { method: "DELETE", key: KEY });
    const hofAfterCheat = (await (await apiCall(env, "/api/hall-of-fame")).json()) as HallOfFameAnswer;
    const v1After = hofAfterCheat.events.find((e) => e.event === "2026-W46" && e.physics === "v1");
    const v2After = hofAfterCheat.events.find((e) => e.event === "2026-W46" && e.physics === "v2");
    check(
      "admin lap delete: refreshes archived weekly auto awards and promotes clean podium",
      delLapRes.status === 200 &&
        !ghosts.objects.has(`laps/${cheatLapId}.json`) &&
        v1After?.podium.map((p) => `${p.place}:${p.nameKey}`).join(",") === "1:alice,2:bob,3:carol" &&
        v2After?.podium[0]?.nameKey === "dave",
      v1After?.podium.map((p) => `${p.place}:${p.nameKey}`).join(","),
    );

    // Admin clears Alice's laps -> V1 podium refreshes again (Bob P1, Carol P2) while Alice's manual bulb award stays
    const clearAliceRes = await apiCall(env, "/api/admin/drivers/Alice/laps", { method: "DELETE", key: KEY });
    const hofAfterClear = (await (await apiCall(env, "/api/hall-of-fame")).json()) as HallOfFameAnswer;
    const v1Cleared = hofAfterClear.events.find((e) => e.event === "2026-W46" && e.physics === "v1");
    check(
      "admin driver clear: deletes driver laps and refreshes affected archived weekly podiums",
      clearAliceRes.status === 200 && v1Cleared?.podium.map((p) => `${p.place}:${p.nameKey}`).join(",") === "1:bob,2:carol",
      v1Cleared?.podium.map((p) => `${p.place}:${p.nameKey}`).join(","),
    );

    // Canonicalization & deduplication of names= on /api/badges + rate limiting
    check(
      "parseBadgeNames: canonicalizes, deduplicates and sorts name keys",
      parseBadgeNames("Carol, bob, BOB , Alice")?.join(",") === "alice,bob,carol",
    );
    const b1 = await apiCall(env, "/api/badges?names=Bob,alice,ALICE,Bob", { ip: "9.9.9.1" });
    const b2 = await apiCall(env, "/api/badges?names=alice,bob", { ip: "9.9.9.1" });
    const b3 = await apiCall(env, "/api/badges?names=alice,bob", { ip: "9.9.9.1" });
    const b1Text = await b1.text();
    const b2Text = await b2.text();
    check(
      "badges: unordered/duplicate names produce identical canonical JSON and enforce BADGES_LIMIT (429 no-store)",
      b1.status === 200 &&
        b2.status === 200 &&
        b1Text === b2Text &&
        b1Text.includes('"bulb"') &&
        b3.status === 429 &&
        b3.headers.get("Cache-Control") === "no-store",
      `statuses=${b1.status},${b2.status},${b3.status}`,
    );

    // /api/badges never falls back to BOARD_LIMIT (a read must never consume the lap-upload budget)
    let boardLimitHits = 0;
    const countedBoardLimit: RateLimit = {
      async limit() {
        boardLimitHits++;
        return { success: false };
      },
    };
    const noBadgesLimitEnv = { ONLINE_BOARD: "on", BOARD_DB: db, GHOSTS: ghosts, BOARD_LIMIT: countedBoardLimit } as unknown as Env;
    const nb1 = await apiCall(noBadgesLimitEnv, "/api/badges?names=bob", { ip: "9.9.9.2" });
    check("badges: never consumes BOARD_LIMIT when BADGES_LIMIT is unbound", nb1.status === 200 && boardLimitHits === 0);

    // Every env.*_LIMIT referenced in cloudflare/api/index.ts must be bound in wrangler.jsonc
    const repoRoot = join(__dirname, "..");
    const indexSrc = readFileSync(join(repoRoot, "cloudflare/api/index.ts"), "utf8");
    const wranglerSrc = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
    const limitRefs = [...new Set([...indexSrc.matchAll(/\benv\.([A-Z0-9_]+_LIMIT)\b/g)].map((m) => m[1]))];
    const missingLimits = limitRefs.filter((name) => !new RegExp(`"name"\\s*:\\s*"${name}"`).test(wranglerSrc));
    check(
      "wrangler.jsonc: binds every env.*_LIMIT used in cloudflare/api/index.ts",
      limitRefs.length >= 6 && missingLimits.length === 0,
      missingLimits.length ? `missing=${missingLimits.join(",")}` : limitRefs.join(","),
    );

    // Client fetchBadges backs off for 60s after a 429 response instead of hammering /api/badges
    {
      forgetBadges();
      let calls = 0;
      const hit429 = async () => {
        calls++;
        return { status: 429, body: { ok: false, error: "Too many badge requests" } };
      };
      await fetchBadges(["Bob"], { nowMs: 1_000_000, fetchJson: hit429 });
      await fetchBadges(["Bob"], { nowMs: 1_030_000, fetchJson: hit429 });
      await fetchBadges(["Bob"], { nowMs: 1_061_000, fetchJson: hit429 });
      check("client: fetchBadges backs off for 60s on 429 before retrying", calls === 2, `calls=${calls}`);
    }

    // Schema partial unique index prevents duplicate auto podium rows for the same (event_id, physics, badge_type)
    {
      let dupAutoRejected = false;
      try {
        await db
          .prepare(
            "INSERT INTO driver_awards (name_key, badge_type, event_id, physics, note, awarded_at, awarded_by, driver_name, track_id, vehicle, lap_time_ms) VALUES ('impostor', 'weekly_gold', '2026-W46', 'v1', '', 999999, 'auto', 'Impostor', 'rwanda_official', 'lc26', 60000)",
          )
          .run();
      } catch {
        dupAutoRejected = true;
      }
      check("migration 0008: partial unique index rejects duplicate auto gold for same week & physics", dupAutoRejected);
    }

    // Stale-reader race: reader 1 reads pre-delete laps, admin deletes P1 lap and invalidates archive,
    // then reader 1 writes its archive — atomic INSERT ... SELECT must archive the clean post-delete podium with 3 rows
    {
      const raceDb = fakeD1(FULL);
      const raceEvent = "2026-W45";
      const racePhys = lapPhysicsVersion("lc26", "rwanda_official");
      const cheatId = await addLap(raceDb, { name: "Cheater", track: "rwanda_official", vehicle: "lc26", physics: racePhys, ms: 61_000, event: raceEvent, created: 1 });
      await addLap(raceDb, { name: "Alice", track: "rwanda_official", vehicle: "lc26", physics: racePhys, ms: 70_000, event: raceEvent, created: 2 });
      await addLap(raceDb, { name: "Bob", track: "rwanda_official", vehicle: "lc26", physics: racePhys, ms: 71_000, event: raceEvent, created: 3 });
      await addLap(raceDb, { name: "Carol", track: "rwanda_official", vehicle: "lc26", physics: racePhys, ms: 72_000, event: raceEvent, created: 4 });
      let releaseReader!: () => void;
      let readerPaused!: () => void;
      const paused = new Promise<void>((r) => {
        readerPaused = r;
      });
      const gate = new Promise<void>((r) => {
        releaseReader = r;
      });
      let gatedOnce = false;
      const gatedDb: D1Database = {
        prepare(sqlText: string) {
          const stmt = raceDb.prepare(sqlText);
          if (!gatedOnce && sqlText.includes("INSERT INTO driver_awards")) {
            gatedOnce = true;
            return {
              bind(...values: unknown[]) {
                const bound = stmt.bind(...values);
                return {
                  ...bound,
                  async run() {
                    readerPaused();
                    await gate;
                    return bound.run();
                  },
                };
              },
              first: stmt.first.bind(stmt),
              all: stmt.all.bind(stmt),
              run: stmt.run.bind(stmt),
            };
          }
          return stmt;
        },
        batch: raceDb.batch.bind(raceDb),
      };
      const staleReader = hallOfFameEvents(gatedDb, NOW);
      await paused;
      // Admin deletes Cheater's lap before staleReader's archive INSERT executes
      await raceDb.prepare("DELETE FROM laps WHERE id = ?").bind(cheatId).run();
      await raceDb.prepare("DELETE FROM driver_awards WHERE awarded_by = 'auto' AND event_id = ?").bind(raceEvent).run();
      releaseReader();
      // Second concurrent reader runs alongside
      await Promise.all([staleReader, hallOfFameEvents(raceDb, NOW)]);
      const rows = (
        await raceDb
          .prepare("SELECT badge_type, name_key FROM driver_awards WHERE event_id = ? AND awarded_by = 'auto' ORDER BY id")
          .bind(raceEvent)
          .all<{ badge_type: string; name_key: string }>()
      ).results;
      const summary = rows.map((r: { badge_type: string; name_key: string }) => `${r.badge_type}:${r.name_key}`).join(",");
      check(
        "archive race: stale reader after admin delete archives clean post-delete podium with 3 rows",
        rows.length === 3 && summary === "weekly_gold:alice,weekly_silver:bob,weekly_bronze:carol",
        summary,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll awards & Hall of Fame checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
