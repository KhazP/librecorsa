/**
 * Headless checks of Driver Profiles (GitHub #170):
 *   - Rating math: midpoint percentile, 1-driver neutral board, per-circuit opponent weighting, Bayesian shrinkage
 *   - GET /api/drivers/profile?name= via handleApi on in-memory SQLite (all migrations through 0010):
 *     * Best lap per (circuit, car) on current shipping revision across default filters
 *     * Position tie-breaking (lap_time_ms, created_at, id) and distinct-driver board size
 *     * Excludes older physics (V1), hidden classic LC26 engine, weekly challenge rows, and non-official tracks
 *     * Follows CIRCUIT_BOARD_RESETS
 *     * Handles case/whitespace normalization, prototype-key names, empty drivers, validation errors, rate limit,
 *       foreign Origin, ONLINE_BOARD=off, edge cache headers, and privacy (no private fields)
 *     * Bounded to 1 D1 statement per request, and uses covering index laps_board_driver (and laps_board pre-0010)
 *
 *   NEXT_PUBLIC_HOSTED_CONTENT=1 npx tsx scripts/verify-driver-profile.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardTable } from "../src/components/board/board-table";
import { DriverProfileBody } from "../src/components/board/DriverProfileModal";
import { handleApi, SHARED_ANSWER_S } from "../cloudflare/api/index";
import { driverNameKey } from "../cloudflare/api/board";
import {
  boardPercentile,
  computeDriverRating,
  driverProfileQuery,
  RATING_PRIOR_CIRCUITS,
  RATING_PRIOR_MEAN,
  type DriverProfileAnswer,
} from "../cloudflare/api/profile";
import type { D1Database, Env, RateLimit } from "../cloudflare/api/types";
import { CIRCUIT_BOARD_RESETS, type CircuitBoardReset } from "../src/lib/circuit-board-resets";
import { fetchDriverProfile, lapBoardPercentile, parseDriverProfile } from "../src/lib/net/driver-profile";
import { boardPhysicsVersion, lapPhysicsVersion, PHYSICS_VERSION, PHYSICS_VERSIONS, shippingLapPhysicsVersion } from "../src/lib/sim/lap-types";
import type { VehicleModelId } from "../src/types/f1";
import { fakeD1, fakeR2 } from "./lib/fake-cloudflare";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

const migrations = join(__dirname, "..", "cloudflare", "migrations");
const sql = (...files: string[]) => files.map((f) => readFileSync(join(migrations, f), "utf8")).join("\n");
const PRE_0010 = sql(
  "0001_lap_boards.sql",
  "0002_race_results.sql",
  "0003_usage.sql",
  "0004_admin_numbers.sql",
  "0005_lc26.sql",
  "0006_lap_counts.sql",
  "0007_lap_input.sql",
  "0008_awards.sql",
  "0009_lap_setup.sql",
);
const FULL = `${PRE_0010}\n${sql("0010_driver_profile_index.sql")}`;
const NOW = Date.UTC(2026, 10, 23, 12);

let seq = 0;
async function addLap(
  db: D1Database,
  o: {
    name: string;
    code?: string;
    track: string;
    vehicle: VehicleModelId;
    physics?: number;
    ms: number;
    event?: string;
    assists?: string;
    realism?: string;
    surface?: string;
    input?: string | null;
    created?: number;
    id?: string;
  },
) {
  seq++;
  const id = o.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db
    .prepare(
      "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, input, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      o.track,
      o.vehicle,
      o.physics ?? shippingLapPhysicsVersion(o.vehicle, o.track),
      o.event ?? "",
      o.assists ?? "pro",
      o.realism ?? "full",
      o.surface ?? "dry",
      "soft",
      o.input ?? "wheel",
      driverNameKey(o.name),
      o.name,
      o.code ?? o.name.slice(0, 3).toUpperCase(),
      o.ms,
      o.ms / 3,
      o.ms / 3,
      o.ms / 3,
      NOW + seq,
      o.created ?? NOW + seq,
    )
    .run();
  return id;
}

function apiCall(env: Env, path: string, opts: { headers?: Record<string, string> } = {}) {
  const url = new URL(`https://librecorsa.org${path}`);
  return handleApi(new Request(url, { method: "GET", headers: opts.headers }), env, url);
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

/** Counts every D1 statement executed through prepare() or batch() */
function countingDb(inner: D1Database): { db: D1Database; count: () => number; reset: () => void } {
  let statements = 0;
  const db: D1Database = {
    prepare(query: string) {
      const wrap = (stmt: ReturnType<D1Database["prepare"]>): ReturnType<D1Database["prepare"]> => ({
        bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
        first: async <T>() => {
          statements++;
          return stmt.first<T>();
        },
        all: async <T>() => {
          statements++;
          return stmt.all<T>();
        },
        run: async () => {
          statements++;
          return stmt.run();
        },
      });
      return wrap(inner.prepare(query));
    },
    batch: async (list) => {
      statements += list.length;
      return inner.batch(list);
    },
  };
  return { db, count: () => statements, reset: () => void (statements = 0) };
}

async function main(): Promise<void> {
  // 1. Pure rating math ----------------------------------------------------------------------------------------------
  {
    check("rating: empty list yields null", computeDriverRating([]) === null);
    check(
      "percentile: 1 of 1 is 50 (neutral); 1 of 10 is 95; 10 of 10 is 5; 1 of 100 is 99.5",
      boardPercentile(1, 1) === 50 &&
        boardPercentile(1, 10) === 95 &&
        boardPercentile(10, 10) === 5 &&
        boardPercentile(1, 100) === 99.5,
      `${boardPercentile(1, 1)}, ${boardPercentile(1, 10)}, ${boardPercentile(10, 10)}, ${boardPercentile(1, 100)}`,
    );
    const soloOne = computeDriverRating([{ trackId: "spielberg", position: 1, boardSize: 1 }]);
    check("rating: solo 1-driver board stays neutral at 50.0", soloOne === 50, String(soloOne));

    const oneP1 = computeDriverRating([{ trackId: "spielberg", position: 1, boardSize: 100 }]);
    const fiveTop10 = computeDriverRating([
      { trackId: "spielberg", position: 10, boardSize: 100 },
      { trackId: "sachsenring", position: 10, boardSize: 100 },
      { trackId: "okayama", position: 10, boardSize: 100 },
      { trackId: "dunsfold", position: 10, boardSize: 100 },
      { trackId: "grobnik", position: 10, boardSize: 100 },
    ]);
    const expectedOneP1 = Math.round(((99.5 + RATING_PRIOR_CIRCUITS * RATING_PRIOR_MEAN) / (1 + RATING_PRIOR_CIRCUITS)) * 10) / 10;
    check(
      "rating: shrinks 1-circuit P1 toward 50 so 5-circuit top-10 driver ranks higher",
      oneP1 === expectedOneP1 && fiveTop10 !== null && fiveTop10 > oneP1,
      `1-circuit P1=${oneP1}, 5-circuit P10=${fiveTop10}`,
    );

    // Multiple cars on the SAME circuit still count as 1 circuit, and a 1-driver car doesn't drag down a contested one
    const multiCarSameCircuit = computeDriverRating([
      { trackId: "spielberg", position: 1, boardSize: 100 },
      { trackId: "spielberg", position: 1, boardSize: 1 },
    ]);
    const tenCarsSameCircuit = computeDriverRating(
      Array.from({ length: 10 }, () => ({ trackId: "spielberg", position: 1, boardSize: 100 })),
    );
    check(
      "rating: multiple cars on one circuit count as 1 circuit and solo car has 0 opponent weight",
      multiCarSameCircuit === oneP1 && tenCarsSameCircuit === oneP1,
      `multi=${multiCarSameCircuit}, ten=${tenCarsSameCircuit}, one=${oneP1}`,
    );

    // Lower position on same circuit yields lower rating (monotonic)
    const p1 = computeDriverRating([{ trackId: "spielberg", position: 1, boardSize: 20 }])!;
    const p5 = computeDriverRating([{ trackId: "spielberg", position: 5, boardSize: 20 }])!;
    const p20 = computeDriverRating([{ trackId: "spielberg", position: 20, boardSize: 20 }])!;
    check("rating: strictly monotonic with board position", p1 > p5 && p5 > p20 && p20 < 50, `${p1} > ${p5} > ${p20}`);
  }

  // 2. Endpoint behaviour, filtering, ties, board sizes & bounded D1 queries -----------------------------------------
  {
    const rawDb = fakeD1(FULL);
    const tracked = countingDb(rawDb);
    const env = {
      ONLINE_BOARD: "on",
      BOARD_DB: tracked.db,
      GHOSTS: fakeR2(),
      PROFILE_LIMIT: limiter(2),
    } as unknown as Env;

    // Seed drivers on spielberg (lc26 and amg-gt3) and sachsenring (lc26)
    // Spielberg LC26: Bob 70s, Alice 71s (assisted beats her 72s pro!), Carol 71s (earlier created_at -> beats Alice on tie!), Dave 73s (2 classes -> still 1 driver!)
    await addLap(rawDb, { name: "Bob", track: "spielberg", vehicle: "lc26", ms: 70_000, created: NOW + 10 });
    await addLap(rawDb, { name: "Carol", track: "spielberg", vehicle: "lc26", ms: 71_000, created: NOW + 20 });
    await addLap(rawDb, { name: "Alice", code: "ALI", track: "spielberg", vehicle: "lc26", ms: 72_000, assists: "pro", created: NOW + 30 });
    await addLap(rawDb, { name: "Alice", code: "ALI", track: "spielberg", vehicle: "lc26", ms: 71_000, assists: "assisted", input: "controller", created: NOW + 40 });
    await addLap(rawDb, { name: "Dave", track: "spielberg", vehicle: "lc26", ms: 73_000, assists: "pro", created: NOW + 50 });
    await addLap(rawDb, { name: "Dave", track: "spielberg", vehicle: "lc26", ms: 74_000, assists: "assisted", created: NOW + 60 });

    // Spielberg GT3: Alice P1 of 2 (85s vs Bob 86s)
    await addLap(rawDb, { name: "Alice", code: "ALI", track: "spielberg", vehicle: "amg-gt3", ms: 85_000, created: NOW + 70 });
    await addLap(rawDb, { name: "Bob", track: "spielberg", vehicle: "amg-gt3", ms: 86_000, created: NOW + 80 });

    // Sachsenring LC26: Alice P1 of 3 (with latest driver_code "ALC")
    await addLap(rawDb, { name: "Alice", code: "ALC", track: "sachsenring", vehicle: "lc26", ms: 68_000, created: NOW + 90 });
    await addLap(rawDb, { name: "Bob", track: "sachsenring", vehicle: "lc26", ms: 69_000, created: NOW + 91 });
    await addLap(rawDb, { name: "Carol", track: "sachsenring", vehicle: "lc26", ms: 70_000, created: NOW + 92 });

    // Rows that MUST be excluded from Alice's profile:
    //   - Physics V1 lap (dunsfold, liana, physics 7)
    //   - Hidden classic LC26 engine (dunsfold, lc26, physics 8 instead of 528)
    //   - Weekly challenge row (event = '2026-W47')
    //   - Non-official circuit id ('made_up_track')
    const v1 = PHYSICS_VERSIONS[0].physics;
    await addLap(rawDb, { name: "Alice", track: "dunsfold", vehicle: "liana", physics: boardPhysicsVersion(v1, "liana"), ms: 79_000 });
    await addLap(rawDb, { name: "Alice", track: "dunsfold", vehicle: "lc26", physics: PHYSICS_VERSION, ms: 60_000 });
    await addLap(rawDb, { name: "Alice", track: "okayama", vehicle: "lc26", event: "2026-W47", ms: 70_000 });
    await addLap(rawDb, { name: "Alice", track: "made_up_track", vehicle: "lc26", ms: 50_000 });
    // Store a private driver key hash in `drivers` to verify nothing private ever leaks
    await rawDb
      .prepare("INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES (?, ?, ?, ?)")
      .bind("alice", "super-secret-sha256-hash", NOW, NOW)
      .run();

    tracked.reset();
    const res = await apiCall(env, "/api/drivers/profile?name=%20%20ALICE%20%20", { headers: { "CF-Connecting-IP": "1.2.3.4" } });
    const queriesUsed = tracked.count();
    const text = await res.text();
    const body = JSON.parse(text) as DriverProfileAnswer;

    check(
      "api: returns 200, edge-cached for SHARED_ANSWER_S.profile with Vary: Origin",
      res.status === 200 &&
        res.headers.get("Cache-Control") === `public, max-age=${SHARED_ANSWER_S.profile}` &&
        res.headers.get("Vary") === "Origin",
      `${res.status} ${res.headers.get("Cache-Control")}`,
    );
    check("api: bounded to 1 D1 statement per profile request", queriesUsed === 1, `queries=${queriesUsed}`);
    check(
      "api: returns canonical name, latest code, circuitsDriven=2, boardsEntered=3",
      body.ok === true &&
        body.name === "Alice" &&
        body.nameKey === "alice" &&
        body.code === "ALC" &&
        body.circuitsDriven === 2 &&
        body.boardsEntered === 3 &&
        body.laps.length === 3,
      JSON.stringify({ name: body.name, code: body.code, circuits: body.circuitsDriven, boards: body.boardsEntered }),
    );

    const spLc = body.laps.find((l) => l.trackId === "spielberg" && l.vehicle === "lc26");
    const spGt = body.laps.find((l) => l.trackId === "spielberg" && l.vehicle === "amg-gt3");
    const saLc = body.laps.find((l) => l.trackId === "sachsenring" && l.vehicle === "lc26");
    check(
      "api: spielberg lc26 picks fastest class (71s assisted), breaks tie after Carol (P3 of 4 distinct drivers)",
      spLc !== undefined &&
        spLc.lapTimeMs === 71_000 &&
        spLc.conditions.assists === "assisted" &&
        spLc.conditions.input === "controller" &&
        spLc.position === 3 &&
        spLc.boardSize === 4,
      JSON.stringify(spLc && { ms: spLc.lapTimeMs, pos: spLc.position, size: spLc.boardSize, assists: spLc.conditions.assists }),
    );
    check(
      "api: spielberg gt3 is P1 of 2 and sachsenring lc26 is P1 of 3",
      spGt?.position === 1 && spGt?.boardSize === 2 && saLc?.position === 1 && saLc?.boardSize === 3,
      `gt3=${spGt?.position}/${spGt?.boardSize}, sa=${saLc?.position}/${saLc?.boardSize}`,
    );
    check(
      "api: excludes V1, classic LC26, weekly challenge and non-official tracks",
      body.laps.every((l) => l.trackId !== "dunsfold" && l.trackId !== "okayama" && l.trackId !== "made_up_track"),
    );
    check(
      "api: sorts strongest relative board first (sachsenring 1/3 -> 83.3%, spielberg gt3 1/2 -> 75%, spielberg lc26 3/4 -> 37.5%)",
      body.laps.map((l) => `${l.trackId}:${l.vehicle}`).join(",") === "sachsenring:lc26,spielberg:amg-gt3,spielberg:lc26",
      body.laps.map((l) => `${l.trackId}:${l.vehicle}`).join(","),
    );
    const expectedRating = computeDriverRating([
      { trackId: "sachsenring", position: 1, boardSize: 3 },
      { trackId: "spielberg", position: 1, boardSize: 2 },
      { trackId: "spielberg", position: 3, boardSize: 4 },
    ]);
    check("api: rating matches pure formula", body.rating === expectedRating, `got=${body.rating}, expected=${expectedRating}`);
    check(
      "api: returns nothing private (no key_hash, driverKey, claimed_at or last_seen)",
      !text.includes("super-secret") && !text.includes("key_hash") && !text.includes("driverKey") && !text.includes("claimed_at"),
    );

    // Unknown / empty driver returns 200 with null rating and empty laps (and counts toward rate limit)
    const emptyRes = await apiCall(env, "/api/drivers/profile?name=Nobody%20Here", { headers: { "CF-Connecting-IP": "1.2.3.4" } });
    const emptyBody = (await emptyRes.json()) as DriverProfileAnswer;
    check(
      "api: unknown driver returns 200 with rating=null and laps=[]",
      emptyRes.status === 200 &&
        emptyBody.ok === true &&
        emptyBody.name === "Nobody Here" &&
        emptyBody.code === null &&
        emptyBody.rating === null &&
        emptyBody.circuitsDriven === 0 &&
        emptyBody.boardsEntered === 0 &&
        emptyBody.laps.length === 0,
      JSON.stringify(emptyBody),
    );

    // 3rd call from same IP hits PROFILE_LIMIT -> 429 no-store
    const limited = await apiCall(env, "/api/drivers/profile?name=Alice", { headers: { "CF-Connecting-IP": "1.2.3.4" } });
    check(
      "api: enforces PROFILE_LIMIT (429 with Cache-Control: no-store)",
      limited.status === 429 && limited.headers.get("Cache-Control") === "no-store",
      `${limited.status} ${limited.headers.get("Cache-Control")}`,
    );

    // Validation errors, board off, foreign origin (different IP so rate limit doesn't mask them)
    const freshEnv = { ...env, PROFILE_LIMIT: undefined } as Env;
    const missing = await apiCall(freshEnv, "/api/drivers/profile");
    const blank = await apiCall(freshEnv, "/api/drivers/profile?name=%20%20");
    const tooLong = await apiCall(freshEnv, `/api/drivers/profile?name=${"a".repeat(65)}`);
    const off = await apiCall({ ...freshEnv, ONLINE_BOARD: "off" } as Env, "/api/drivers/profile?name=Alice");
    const foreign = await apiCall(freshEnv, "/api/drivers/profile?name=Alice", { headers: { Origin: "https://evil.example" } });
    check(
      "api: refuses missing/blank/long name (400 no-store), board off (404), foreign origin (403)",
      missing.status === 400 &&
        missing.headers.get("Cache-Control") === "no-store" &&
        blank.status === 400 &&
        tooLong.status === 400 &&
        off.status === 404 &&
        foreign.status === 403,
      `${missing.status},${blank.status},${tooLong.status},${off.status},${foreign.status}`,
    );

    // Prototype-key driver name works cleanly
    await addLap(rawDb, { name: "Constructor", track: "okayama", vehicle: "amg-gt3", ms: 82_000 });
    const protoRes = await apiCall(freshEnv, "/api/drivers/profile?name=Constructor");
    const protoBody = (await protoRes.json()) as DriverProfileAnswer;
    check(
      "api: prototype-key driver name works safely",
      protoRes.status === 200 && protoBody.nameKey === "constructor" && protoBody.boardsEntered === 1,
      JSON.stringify({ name: protoBody.name, boards: protoBody.boardsEntered }),
    );
  }

  // 3. Circuit board resets ------------------------------------------------------------------------------------------
  {
    const db = fakeD1(FULL);
    const env = { ONLINE_BOARD: "on", BOARD_DB: db, GHOSTS: fakeR2() } as unknown as Env;
    const ON = "oschersleben";
    const RESETS = CIRCUIT_BOARD_RESETS as Record<string, CircuitBoardReset[]>;
    // Pre-reset lap (revision 528)
    await addLap(db, { name: "Alice", track: ON, vehicle: "lc26", physics: lapPhysicsVersion("lc26", ON), ms: 70_000 });
    RESETS[ON] = [{ physics: PHYSICS_VERSION, oldBoard: "Old kerbs", why: "profile test" }];
    try {
      // Post-reset laps (revision 1528)
      await addLap(db, { name: "Alice", track: ON, vehicle: "lc26", ms: 72_000 });
      await addLap(db, { name: "Bob", track: ON, vehicle: "lc26", ms: 71_000 });
      const res = await apiCall(env, "/api/drivers/profile?name=Alice");
      const body = (await res.json()) as DriverProfileAnswer;
      check(
        "resets: includes only post-reset revision on a restarted circuit",
        res.status === 200 &&
          body.boardsEntered === 1 &&
          body.laps[0]?.lapTimeMs === 72_000 &&
          body.laps[0]?.position === 2 &&
          body.laps[0]?.boardSize === 2,
        JSON.stringify(body.laps[0]),
      );
    } finally {
      delete RESETS[ON];
    }
  }

  // 4. SQLite EXPLAIN QUERY PLAN: index use with migration 0010 and pre-0010 fallback --------------------------------
  {
    const { DatabaseSync } = await import("node:sqlite");
    const { sql: qSql, binds } = driverProfileQuery("alice");

    const with0010 = new DatabaseSync(":memory:");
    with0010.exec(FULL);
    const plan0010 = (with0010.prepare(`EXPLAIN QUERY PLAN ${qSql}`).all(...(binds as (string | number)[])) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");
    check(
      "index (0010): seeks laps_driver then covering index laps_board_driver with no full laps scan",
      /SEARCH laps USING INDEX laps_driver/.test(plan0010) &&
        /SEARCH l USING COVERING INDEX laps_board_driver/.test(plan0010) &&
        !/SCAN (?:laps|l)\b/.test(plan0010),
      plan0010,
    );

    const pre0010 = new DatabaseSync(":memory:");
    pre0010.exec(PRE_0010);
    const planPre = (pre0010.prepare(`EXPLAIN QUERY PLAN ${qSql}`).all(...(binds as (string | number)[])) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");
    check(
      "index (pre-0010): still seeks laps_driver and laps_board with no full laps scan",
      /SEARCH laps USING INDEX laps_driver/.test(planPre) &&
        /SEARCH l USING INDEX laps_board/.test(planPre) &&
        !/SCAN (?:laps|l)\b/.test(planPre),
      planPre,
    );
  }

  // 5. Client parser & fetch (src/lib/net/driver-profile.ts) ---------------------------------------------------------
  {
    const db = fakeD1(FULL);
    const env = { ONLINE_BOARD: "on", BOARD_DB: db, GHOSTS: fakeR2() } as unknown as Env;
    await addLap(db, { name: "Max Pace", code: "MAX", track: "spielberg", vehicle: "lc26", ms: 69_500 });
    await addLap(db, { name: "Other Driver", track: "spielberg", vehicle: "lc26", ms: 71_000 });
    const raw = await (await apiCall(env, "/api/drivers/profile?name=Max%20Pace")).json();
    const parsed = parseDriverProfile(raw);
    check(
      "client: parseDriverProfile validates server response",
      parsed !== null &&
        parsed.name === "Max Pace" &&
        parsed.code === "MAX" &&
        parsed.circuitsDriven === 1 &&
        parsed.boardsEntered === 1 &&
        parsed.laps[0]?.position === 1 &&
        parsed.laps[0]?.boardSize === 2,
      JSON.stringify(parsed && { name: parsed.name, rating: parsed.rating, laps: parsed.laps.length }),
    );
    check(
      "client: parseDriverProfile rejects malformed payloads and drops invalid lap rows",
      parseDriverProfile(null) === null &&
        parseDriverProfile({ ok: false, error: "bad" }) === null &&
        parseDriverProfile({ ...(raw as object), rating: 120 }) === null &&
        parseDriverProfile({ ...(raw as object), laps: [...(raw as DriverProfileAnswer).laps, { id: "bad", position: 5, boardSize: 2 }] })?.laps.length === 1,
    );
    check(
      "client: lapBoardPercentile matches server boardPercentile",
      lapBoardPercentile(1, 1) === boardPercentile(1, 1) && lapBoardPercentile(3, 10) === boardPercentile(3, 10),
    );

    let seenUrl = "";
    const fetched = await fetchDriverProfile("  Max   Pace  ", {
      fetchJson: async (u) => {
        seenUrl = u;
        return { status: 200, body: raw };
      },
    });
    const failed = await fetchDriverProfile("Max Pace", { fetchJson: async () => ({ status: 500, body: { ok: false } }) });
    const blank = await fetchDriverProfile("   ", { fetchJson: async () => ({ status: 200, body: raw }) });
    check(
      "client: fetchDriverProfile canonicalizes name query and returns null on failure or blank name",
      seenUrl.endsWith("?name=max+pace") && fetched?.name === "Max Pace" && failed === null && blank === null,
      seenUrl,
    );
  }

  // 6. UI rendering checks: clickable names & loading/error/empty/populated profile states ----------------------------
  {
    const clickableHtml = renderToStaticMarkup(
      React.createElement(BoardTable, {
        label: "Online times",
        showBadges: false,
        onSelectDriver: () => {},
        rows: [{ key: "r1", rank: 1, code: "ALC", title: "Alice", lapMs: 70_000, fastest: true }],
      }),
    );
    const plainCarHtml = renderToStaticMarkup(
      React.createElement(BoardTable, {
        label: "Best laps",
        nameHeader: "Car",
        showBadges: false,
        rows: [{ key: "r1", rank: 1, title: "Proto 26", lapMs: 70_000 }],
      }),
    );
    check(
      "ui: BoardTable renders driver name as dialog button when onSelectDriver is set, plain span otherwise",
      clickableHtml.includes("<button") &&
        clickableHtml.includes('aria-haspopup="dialog"') &&
        clickableHtml.includes("Alice") &&
        !plainCarHtml.includes("<button"),
    );

    const common = {
      circuitName: (id: string) => (id === "spielberg" ? "Red Bull Ring" : "Sachsenring"),
      carTag: (v: VehicleModelId) =>
        v === "lc26" ? { label: "Proto 26", color: "pink" as const } : { label: "GT3", color: "cyan" as const },
      onRetry: () => {},
    };
    const loadingHtml = renderToStaticMarkup(
      React.createElement(DriverProfileBody, { ...common, profile: null, record: null, loading: true, error: false }),
    );
    const errorHtml = renderToStaticMarkup(
      React.createElement(DriverProfileBody, { ...common, profile: null, record: null, loading: false, error: true }),
    );
    const emptyHtml = renderToStaticMarkup(
      React.createElement(DriverProfileBody, {
        ...common,
        profile: { ok: true, name: "New Driver", nameKey: "new driver", code: null, rating: null, circuitsDriven: 0, boardsEntered: 0, laps: [] },
        record: { name: "New Driver", starts: 0, wins: 0, podiums: 0, bestFinish: null },
        loading: false,
        error: false,
      }),
    );
    const loadedHtml = renderToStaticMarkup(
      React.createElement(DriverProfileBody, {
        ...common,
        profile: {
          ok: true,
          name: "Alice",
          nameKey: "alice",
          code: "ALC",
          rating: 78.4,
          circuitsDriven: 2,
          boardsEntered: 2,
          laps: [
            {
              id: "lap-1",
              trackId: "spielberg",
              vehicle: "lc26",
              lapTimeMs: 71_234,
              sectorTimesMs: [23_000, 24_000, 24_234],
              recordedAt: NOW,
              position: 1,
              boardSize: 42,
              conditions: { assists: "pro", realism: "full", surface: "dry", compound: "soft", physicsVersion: 528, input: "wheel" },
            },
            {
              id: "lap-2",
              trackId: "sachsenring",
              vehicle: "amg-gt3",
              lapTimeMs: 85_500,
              sectorTimesMs: [28_000, 29_000, 28_500],
              recordedAt: NOW - 1000,
              position: 4,
              boardSize: 20,
              conditions: { assists: "semi_pro", realism: "standard", surface: "wet", compound: "wet", physicsVersion: 8 },
            },
          ],
        },
        record: { name: "Alice", starts: 6, wins: 2, podiums: 4, bestFinish: 1 },
        loading: false,
        error: false,
      }),
    );
    check(
      "ui: DriverProfileBody renders loading, error and empty states cleanly",
      loadingHtml.includes('aria-busy="true"') &&
        errorHtml.includes('role="alert"') &&
        errorHtml.includes("Try again") &&
        emptyHtml.includes("No laps on the current boards yet.") &&
        emptyHtml.includes("No finished open races yet."),
    );
    check(
      "ui: DriverProfileBody renders rating, circuit/board counts, race record and per-circuit laps",
      loadedHtml.includes("78.4") &&
        loadedHtml.includes("Red Bull Ring") &&
        loadedHtml.includes("Proto 26") &&
        loadedHtml.includes("of 42") &&
        loadedHtml.includes("Sachsenring") &&
        loadedHtml.includes("GT3") &&
        loadedHtml.includes("of 20") &&
        loadedHtml.includes("Open races") &&
        loadedHtml.includes("P1") &&
        loadedHtml.includes("Best finish"),
    );
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll driver profile checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
