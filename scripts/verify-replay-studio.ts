/**
 * Verification suite for LibreCorsa Race Replay Studio:
 * - Recording round-trip & multi-car interpolation
 * - IndexedDB persistence, rename, delete, bookmark update, & quota/unavailable fallback
 * - Portable .lcr format compression, validation, & compatibility checks
 * - Corrupt, oversized, non-finite, & unsupported-version file rejection
 * - Grounded event extraction (laps, PBs, fastest lap, overtakes, collisions, DNFs, race control)
 * - 20-minute (24,000-frame) large recording performance & round-trip
 */
import assert from "node:assert/strict";
import { ReplayBuffer } from "../src/lib/sim/replay-buffer";
import { extractReplayEvents } from "../src/lib/sim/replay-events";
import {
  checkReplayCompatibility,
  decodeLcrReplay,
  encodeLcrReplay,
  ReplayFormatError,
} from "../src/lib/sim/replay-format";
import {
  deleteSavedReplay,
  importLcrFileToStore,
  listSavedReplays,
  loadSavedReplay,
  renameSavedReplay,
  resetReplayDbForTest,
  saveReplayRecording,
  updateSavedReplayBookmarks,
} from "../src/lib/sim/replay-store";
import {
  MAX_REPLAY_FRAMES,
  MAX_REPLAY_IMPORT_BYTES,
  REPLAY_MAGIC,
  type ReplayMetadata,
  type ReplayRecordingPayload,
} from "../src/lib/sim/replay-types";
import { PHYSICS_VERSION } from "../src/lib/sim/lap-types";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

function makeMeta(overrides: Partial<ReplayMetadata> = {}): ReplayMetadata {
  return {
    id: "rec-test-1",
    name: "Test Session",
    recordedAt: 1_700_000_000_000,
    trackId: "rwanda_official",
    trackName: "RISE Motordrome",
    vehicle: "lc26",
    vehicleClass: "open-wheel",
    raceKind: "ai",
    durationS: 30,
    frameCount: 600,
    hz: 20,
    participantCount: 2,
    participants: [
      { id: "player", label: "YOU", color: "#CCFF00", isPlayer: true, vehicle: "lc26" },
      { id: "ai-1", label: "VER", color: "#00E5FF", isPlayer: false, vehicle: "lc26" },
    ],
    weather: { condition: "clear", trackWetness: 0, rainIntensity: 0, ambientTempC: 24, trackTempC: 34 },
    physicsVersion: PHYSICS_VERSION,
    lapPhysicsVersion: PHYSICS_VERSION,
    trackPreview: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    ...overrides,
  };
}

/** Minimal in-memory IDBFactory for testing IndexedDB store + QuotaExceededError in Node */
function installMockIndexedDb(opts: { quotaError?: boolean } = {}): () => void {
  const prev = (globalThis as { indexedDB?: unknown }).indexedDB;
  const stores = new Map<string, Map<string, unknown>>([
    ["summaries", new Map()],
    ["payloads", new Map()],
  ]);

  const makeReq = <T>(resultFn: () => T) => {
    const req: Record<string, unknown> = { result: resultFn(), error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        if (typeof req.onsuccess === "function") (req.onsuccess as () => void)();
      } catch (e) {
        req.error = e;
        if (typeof req.onerror === "function") (req.onerror as () => void)();
      }
    });
    return req;
  };

  const mockDb = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => {
      if (!stores.has(n)) stores.set(n, new Map());
      return {};
    },
    close: () => {},
    onversionchange: null as (() => void) | null,
    transaction: (_names: string | string[], mode: string) => {
      const tx: Record<string, unknown> = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore: (name: string) => {
          const map = stores.get(name)!;
          return {
            put: (val: { id: string }) => {
              if (mode === "readwrite" && opts.quotaError) {
                const err = new Error("QuotaExceededError");
                err.name = "QuotaExceededError";
                tx.error = err;
                queueMicrotask(() => {
                  if (typeof tx.onabort === "function") (tx.onabort as () => void)();
                });
                return {};
              }
              map.set(val.id, val);
              return {};
            },
            get: (id: string) => makeReq(() => map.get(id)),
            getAll: () => makeReq(() => Array.from(map.values())),
            delete: (id: string) => {
              map.delete(id);
              return {};
            },
          };
        },
      };
      if (!opts.quotaError) {
        queueMicrotask(() => {
          if (typeof tx.oncomplete === "function") (tx.oncomplete as () => void)();
        });
      }
      return tx;
    },
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: Record<string, unknown> = {
        result: mockDb,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (typeof req.onupgradeneeded === "function") (req.onupgradeneeded as () => void)();
        if (typeof req.onsuccess === "function") (req.onsuccess as () => void)();
      });
      return req;
    },
  };

  return () => {
    if (prev === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
    else (globalThis as { indexedDB?: unknown }).indexedDB = prev;
  };
}

async function main() {
await test("1. Recording round-trip & multi-car interpolation", () => {
  const buf = new ReplayBuffer({ maxSeconds: 120, hz: 20 });
  for (let i = 0; i <= 40; i++) {
    const t = i * 0.05;
    buf.push(t, [
      { id: "player", x: t * 50, y: 0.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 180, steer: 0.1, throttle: 0.9, brake: 0, gear: 5, rpm: 11200, s: t * 50, lap: 1, distM: t * 50 },
      { id: "ai-1", x: t * 48 + 5, y: 0.2, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 172, steer: -0.05, throttle: 0.85, brake: 0, gear: 5, rpm: 10800, s: t * 48 + 5, lap: 1, distM: t * 48 + 5 },
    ]);
  }
  const serialized = buf.exportSerialized();
  const restored = ReplayBuffer.fromSerialized(serialized);
  assert.equal(restored.frameCount, buf.frameCount);
  assert.deepEqual(restored.carIds(), ["player", "ai-1"]);

  // Midpoint seek & interpolation
  const f = restored.frameAt(1.025);
  assert.ok(f);
  const p = f.cars.find((c) => c.id === "player")!;
  assert.ok(Math.abs(p.x - 51.25) < 0.05);
  assert.equal(p.gear, 5);
  assert.equal(restored.sampleCarSeries("ai-1", 0, 2, 10).length, 10);
});

await test("2. Grounded event marker accuracy (laps, PBs, fastest lap, overtakes, collisions, control)", () => {
  const buf = new ReplayBuffer({ maxSeconds: 120, hz: 10 });
  // Record 25 s: lap 1 (0..10s), lap 2 (10..19s, faster PB!), plus overtake at ~5s and collision at ~15s
  for (let i = 0; i <= 250; i++) {
    const t = i * 0.1;
    const playerLap = t < 10 ? 1 : t < 19 ? 2 : 3;
    const aiLap = t < 11 ? 1 : 2;
    // Player starts behind ai-1 (0 vs 10m), overtakes around t=5s and pulls away
    const pDist = t * 50;
    const aDist = t < 15 ? 10 + t * 46 : 10 + 15 * 46 + (t - 15) * 40;
    // Around t=15s, put cars within 2m and drop player speed sharply from 220 -> 140
    const nearCollision = Math.abs(t - 15) < 0.25;
    const pSpeed = t >= 15 && t < 15.6 ? 140 : 220;
    const pz = nearCollision ? 0.5 : 0;
    const px = nearCollision ? 100 : pDist;
    const ax = nearCollision ? 101.5 : aDist;
    const az = nearCollision ? 0.5 : 3;

    buf.push(t, [
      { id: "player", x: px, y: 0, z: pz, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: pSpeed, steer: 0, throttle: 1, brake: 0, gear: 6, rpm: 11500, s: pDist % 500, lap: playerLap, distM: pDist },
      { id: "ai-1", x: ax, y: 0, z: az, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 200, steer: 0, throttle: 1, brake: 0, gear: 6, rpm: 11000, s: aDist % 500, lap: aiLap, distM: aDist },
    ]);
  }

  const events = extractReplayEvents(
    buf,
    [
      { id: "player", label: "YOU", color: "#CCFF00", isPlayer: true },
      { id: "ai-1", label: "VER", color: "#00E5FF", isPlayer: false },
    ],
    [{ id: "yellow-0", kind: "yellow", timeS: 16.0 }]
  );

  assert.ok(events.some((e) => e.kind === "lap_finish" && e.carId === "player" && e.lap === 1));
  assert.ok(events.some((e) => e.kind === "personal_best" && e.carId === "player" && e.lap === 2));
  assert.ok(events.some((e) => e.kind === "fastest_lap" && e.carId === "player" && e.lap === 2));
  assert.ok(events.some((e) => e.kind === "overtake" && e.carId === "player" && e.otherCarId === "ai-1"));
  assert.ok(events.some((e) => e.kind === "collision"));
  assert.ok(events.some((e) => e.kind === "yellow" && e.timeS === 16.0));
});

await test("3. Portable .lcr encode/decode round-trip with gzip compression", async () => {
  const buf = new ReplayBuffer({ maxSeconds: 60, hz: 20 });
  for (let i = 0; i < 200; i++) {
    const t = i * 0.05;
    buf.push(t, [
      { id: "player", x: t * 30, y: 0.1, z: -t * 5, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 110, steer: 0, throttle: 0.8, brake: 0, gear: 3, rpm: 9000, s: t * 30, lap: 1, distM: t * 30 },
    ]);
  }
  const payload: ReplayRecordingPayload = {
    metadata: makeMeta({ frameCount: buf.frameCount, durationS: buf.durationS, participantCount: 1 }),
    frames: buf.exportSerialized(),
    events: [{ id: "ev-1", kind: "lap_start", timeS: 0.5, carId: "player", lap: 1 }],
    bookmarks: [{ id: "bm-1", timeS: 4.2, label: "Apex Clip", createdAt: 1_700_000_000_000 }],
  };
  const encoded = await encodeLcrReplay(payload);
  assert.equal(String.fromCharCode(encoded[0], encoded[1], encoded[2], encoded[3]), REPLAY_MAGIC);
  const decoded = await decodeLcrReplay(encoded);
  assert.equal(decoded.metadata.name, "Test Session");
  assert.equal(decoded.frames.times.length, buf.frameCount);
  assert.equal(decoded.bookmarks[0]?.label, "Apex Clip");
  assert.equal(decoded.events[0]?.kind, "lap_start");
});

await test("4. Corrupt, malicious, oversized, & unsupported-version .lcr rejection", async () => {
  // Oversized
  await assert.rejects(
    () => decodeLcrReplay(new Uint8Array(MAX_REPLAY_IMPORT_BYTES + 1)),
    (e: unknown) => e instanceof ReplayFormatError && e.code === "oversized"
  );

  // Bad magic
  const badMagic = new Uint8Array(32);
  badMagic.set([66, 65, 68, 48], 0);
  await assert.rejects(
    () => decodeLcrReplay(badMagic),
    (e: unknown) => e instanceof ReplayFormatError && e.code === "invalid_magic"
  );

  // Unsupported version
  const badVer = new Uint8Array(32);
  for (let i = 0; i < 4; i++) badVer[i] = REPLAY_MAGIC.charCodeAt(i);
  new DataView(badVer.buffer).setUint16(4, 99, true);
  await assert.rejects(
    () => decodeLcrReplay(badVer),
    (e: unknown) => e instanceof ReplayFormatError && e.code === "unsupported_version"
  );

  // Unreasonable frame count in header
  const fakeHeader = new TextEncoder().encode(
    JSON.stringify({
      formatVersion: 1,
      metadata: makeMeta(),
      carIds: ["player"],
      frameCount: MAX_REPLAY_FRAMES + 1,
      hz: 20,
      events: [],
      bookmarks: [],
    })
  );
  const tooManyFrames = new Uint8Array(12 + fakeHeader.byteLength);
  for (let i = 0; i < 4; i++) tooManyFrames[i] = REPLAY_MAGIC.charCodeAt(i);
  const dv = new DataView(tooManyFrames.buffer);
  dv.setUint16(4, 1, true);
  dv.setUint32(8, fakeHeader.byteLength, true);
  tooManyFrames.set(fakeHeader, 12);
  await assert.rejects(
    () => decodeLcrReplay(tooManyFrames),
    (e: unknown) => e instanceof ReplayFormatError && e.code === "too_many_frames"
  );

  // Non-finite telemetry inside valid container
  const buf = new ReplayBuffer({ maxSeconds: 10, hz: 10 });
  buf.push(0, [{ id: "player", x: 1, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: Number.POSITIVE_INFINITY, steer: 0, throttle: 0, brake: 0, gear: 1, rpm: 3000 }]);
  const badPayload = await encodeLcrReplay({
    metadata: makeMeta({ frameCount: 1, participantCount: 1 }),
    frames: buf.exportSerialized(),
    events: [],
    bookmarks: [],
  });
  await assert.rejects(
    () => decodeLcrReplay(badPayload),
    (e: unknown) => e instanceof ReplayFormatError && e.code === "invalid_frames"
  );
});

await test("5. Missing track/car compatibility checks remain playable", () => {
  const compat = checkReplayCompatibility({
    trackId: "missing_mod_circuit",
    vehicle: "unknown_mod_car",
    physicsVersion: PHYSICS_VERSION - 1,
  });
  assert.equal(compat.trackKnown, false);
  assert.equal(compat.vehicleKnown, false);
  assert.equal(compat.physicsMatch, false);
  assert.equal(compat.warnings.length, 3);
});

await test("6. Large 20-minute (24,000-frame, 4-car) recording encode/decode & event scan", async () => {
  const buf = new ReplayBuffer({ maxSeconds: 1200, hz: 20 });
  for (let i = 0; i < 24_000; i++) {
    const t = i * 0.05;
    buf.push(t, [
      { id: "player", x: t, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 200, steer: 0, throttle: 1, brake: 0, gear: 6, rpm: 11000, s: (t * 50) % 5000, lap: Math.floor(t / 90) + 1, distM: t * 50 },
      { id: "ai-1", x: t, y: 0, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 198, steer: 0, throttle: 1, brake: 0, gear: 6, rpm: 10900, s: (t * 49) % 5000, lap: Math.floor(t / 91) + 1, distM: t * 49 },
      { id: "ai-2", x: t, y: 0, z: 4, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 196, steer: 0, throttle: 1, brake: 0, gear: 6, rpm: 10800, s: (t * 48) % 5000, lap: Math.floor(t / 92) + 1, distM: t * 48 },
      { id: "ai-3", x: t, y: 0, z: 6, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 194, steer: 0, throttle: 1, brake: 0, gear: 6, rpm: 10700, s: (t * 47) % 5000, lap: Math.floor(t / 93) + 1, distM: t * 47 },
    ]);
  }
  const t0 = Date.now();
  const payload: ReplayRecordingPayload = {
    metadata: makeMeta({ id: "rec-20min", frameCount: buf.frameCount, durationS: buf.durationS, participantCount: 4 }),
    frames: buf.exportSerialized(),
    events: [],
    bookmarks: [],
  };
  const encoded = await encodeLcrReplay(payload);
  const decoded = await decodeLcrReplay(encoded);
  assert.equal(decoded.frames.times.length, 24_000);
  assert.ok(encoded.byteLength < 2 * 1024 * 1024, `Expected <2MB compressed, got ${encoded.byteLength}`);
  console.log(`      20-min 4-car .lcr: ${(encoded.byteLength / 1024).toFixed(0)} KB in ${Date.now() - t0} ms`);
});

await test("7. IndexedDB store save/list/load/rename/bookmark/delete & storage failure/quota handling", async () => {
  // Unavailable storage (SSR / private window)
  assert.deepEqual(await listSavedReplays(), []);
  const buf = new ReplayBuffer({ maxSeconds: 30, hz: 10 });
  buf.push(0, [{ id: "player", x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 100, steer: 0, throttle: 1, brake: 0, gear: 3, rpm: 8000 }]);
  buf.push(0.1, [{ id: "player", x: 3, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, speedKmh: 105, steer: 0, throttle: 1, brake: 0, gear: 3, rpm: 8200 }]);
  const payload: ReplayRecordingPayload = {
    metadata: makeMeta({ id: "rec-idb-1", frameCount: 2, durationS: 0.1, participantCount: 1 }),
    frames: buf.exportSerialized(),
    events: [],
    bookmarks: [],
  };
  const unavail = await saveReplayRecording(payload);
  assert.equal(unavail.ok, false);
  assert.equal(unavail.error, "unavailable");

  // Working mock IndexedDB
  let restore = installMockIndexedDb();
  try {
    const saved = await saveReplayRecording(payload);
    assert.equal(saved.ok, true);
    const list = await listSavedReplays();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "rec-idb-1");

    assert.equal(await renameSavedReplay("rec-idb-1", "Renamed GP"), true);
    assert.equal(await updateSavedReplayBookmarks("rec-idb-1", [{ id: "b1", timeS: 0.05, label: "Start", createdAt: 1 }]), true);
    const loaded = await loadSavedReplay("rec-idb-1");
    assert.equal(loaded?.metadata.name, "Renamed GP");
    assert.equal(loaded?.bookmarks.length, 1);

    // Import .lcr into store (duplicates get unique ID)
    const bytes = await encodeLcrReplay(payload);
    const imported = await importLcrFileToStore(bytes);
    assert.equal(imported.ok, true);
    assert.notEqual(imported.summary?.id, "rec-idb-1");

    assert.equal(await deleteSavedReplay("rec-idb-1"), true);
  } finally {
    restore();
  }

  // QuotaExceededError handling
  resetReplayDbForTest();
  restore = installMockIndexedDb({ quotaError: true });
  try {
    const quotaRes = await saveReplayRecording(payload);
    assert.equal(quotaRes.ok, false);
    assert.equal(quotaRes.error, "quota");
  } finally {
    restore();
  }
});

console.log(`\nAll ${passed} Replay Studio checks passed.`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
