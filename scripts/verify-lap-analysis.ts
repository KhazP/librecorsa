/**
 * Checks lap telemetry analysis (`src/lib/sim/lap-analysis.ts`): S/F wrap unwrapping, uniform resampling,
 * real circuit sector splits, structured sector & corner insights, cross-car PB isolation, and invalid-lap handling.
 * Run: npx tsx scripts/verify-lap-analysis.ts
 */
import assert from "node:assert/strict";
import {
  analyzeLaps,
  buildLapChoices,
  resolveSectorSplits,
  sectorSplitsFromSamples,
  selectCarBestLap,
  type SessionLapEntry,
} from "../src/lib/sim/lap-analysis";
import { LAP_SAMPLE_STRIDE, lapPhysicsVersion, type LapRecording } from "../src/lib/sim/lap-types";
import { getActiveTrackData, TURN_METADATA } from "../src/lib/track-data";
import type { TurnMetadata, VehicleModelId } from "../src/types/f1";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const TRACK_M = 4000;
const SPLITS: [number, number] = [1100, 2700];
const TURNS: TurnMetadata[] = [
  { number: 1, name: "Hairpin", complexName: "Turn 1", sApprox: 800, sector: 1, direction: "right", elevationM: 0, bankingDeg: 0, apexSpeedKmh: 90, gear: 2, description: "" },
  { number: 2, name: "Chicane", complexName: "Turn 2", sApprox: 2200, sector: 2, direction: "left", elevationM: 0, bankingDeg: 0, apexSpeedKmh: 130, gear: 3, description: "" },
];

/** Builds a synthetic lap recording with controllable pace, corner apex speeds, and braking point */
function makeLap(opts: {
  trackId?: string;
  vehicle?: VehicleModelId;
  recordedAt?: number;
  physicsVersion?: number;
  sectorTimesMs?: [number, number, number];
  apexDeltaKmh?: number;
  brakeShiftM?: number;
  wrapFirstSample?: boolean;
}): LapRecording {
  const trackId = opts.trackId ?? "test-circuit";
  const vehicle = opts.vehicle ?? "lc26";
  const sectorTimesMs = opts.sectorTimesMs ?? [20_000, 22_000, 18_000];
  const lapTimeMs = sectorTimesMs[0] + sectorTimesMs[1] + sectorTimesMs[2];
  const apexDelta = opts.apexDeltaKmh ?? 0;
  const brakeShift = opts.brakeShiftM ?? 0;

  const data: number[] = [];
  const count = 200;
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    let s = frac * TRACK_M;
    const t = frac * (lapTimeMs / 1000);
    const angle = frac * Math.PI * 2;
    const x = Math.cos(angle) * 500;
    const z = Math.sin(angle) * 500;

    // Corner 1 around s = 800 m: braking zone [700 + shift, 790], apex min speed around 800
    const nearT1 = Math.exp(-(((s - 800) / 45) ** 2));
    const speedKmh = 260 - 160 * nearT1 + apexDelta * nearT1;
    const brakeStart = 700 + brakeShift;
    const braking = s >= brakeStart && s <= 795;
    const throttle = braking ? 0 : 1;
    const brake = braking ? 0.85 : 0;
    const steer = nearT1 * 0.6;
    const gear = speedKmh < 120 ? 2 : speedKmh < 190 ? 4 : 7;

    if (opts.wrapFirstSample && i === 0) s = TRACK_M - 3;
    data.push(t, s, x, 0, z, 0, 0, 0, 1, speedKmh, throttle, brake, steer, gear);
  }
  assert.equal(data.length, count * LAP_SAMPLE_STRIDE);

  return {
    version: 1,
    trackId,
    vehicle,
    driverName: "Driver",
    driverCode: "DRV",
    lapTimeMs,
    sectorTimesMs,
    recordedAt: opts.recordedAt ?? 1000,
    sampleHz: 20,
    data,
    trackLengthM: TRACK_M,
    conditions:
      opts.physicsVersion !== undefined
        ? { assists: "pro", compound: "soft", surface: "dry", realism: "full", physicsVersion: opts.physicsVersion }
        : undefined,
  };
}

console.log("Sector splits");
check("real track samples yield actual non-third sector splits", () => {
  const track = getActiveTrackData();
  const timedLen = track.pointToPoint?.finishS ?? track.totalLengthM;
  const splits = sectorSplitsFromSamples(track.samples, timedLen);
  assert.ok(splits !== null, "bundled track has valid sector splits");
  assert.ok(splits[0] > 0 && splits[1] > splits[0] && splits[1] < timedLen);
  // Bundled rwanda_official_short ends S1 around 1379 m (~25.8 %), not a fixed third (~1780 m)
  assert.ok(Math.abs(splits[0] - timedLen / 3) > 150, `expected real split away from 1/3, got ${splits[0]} / ${timedLen}`);
  assert.ok(TURN_METADATA.length > 0, "bundled track exposes turn metadata");
});

check("resolveSectorSplits keeps valid custom splits and falls back to thirds for bad input", () => {
  const custom = resolveSectorSplits(TRACK_M, SPLITS);
  assert.deepEqual(custom.splitsM, SPLITS);
  assert.ok(Math.abs(custom.fractions[0] - 1100 / 4000) < 1e-9);
  assert.ok(Math.abs(custom.fractions[1] - 2700 / 4000) < 1e-9);

  const fallbackNull = resolveSectorSplits(TRACK_M, null);
  assert.ok(Math.abs(fallbackNull.fractions[0] - 1 / 3) < 1e-9);
  assert.ok(Math.abs(fallbackNull.fractions[1] - 2 / 3) < 1e-9);

  const fallbackReversed = resolveSectorSplits(TRACK_M, [3000, 1000]);
  assert.ok(Math.abs(fallbackReversed.fractions[0] - 1 / 3) < 1e-9);
});

console.log("Lap analysis & insights");
check("analyzeLaps unwraps S/F samples, applies real sector splits, and extracts sector + corner insights", () => {
  const ref = makeLap({ sectorTimesMs: [20_000, 22_000, 18_000], recordedAt: 1000, wrapFirstSample: true });
  const cmp = makeLap({
    sectorTimesMs: [20_050, 22_380, 17_990],
    apexDeltaKmh: -12,
    brakeShiftM: -18,
    recordedAt: 2000,
  });

  const res = analyzeLaps(ref, cmp, TURNS, { sectorSplitsM: SPLITS });
  assert.equal(res.points.length, 220);
  assert.deepEqual(res.sectorSplitsM, SPLITS);
  assert.equal(res.totalDeltaMs, 420);
  assert.equal(res.sectors[1].deltaMs, 380);
  assert.ok(res.points[0].s === 0 && Math.abs(res.points[res.points.length - 1].s - TRACK_M) < 1e-6);

  const sectorInsight = res.insights.find((i) => i.kind === "sector");
  assert.ok(sectorInsight && sectorInsight.kind === "sector" && sectorInsight.sector === 2 && sectorInsight.tone === "loss");

  const apexInsight = res.insights.find((i) => i.kind === "apex");
  assert.ok(apexInsight && apexInsight.kind === "apex" && apexInsight.turnNumber === 1 && apexInsight.tone === "loss");
  assert.ok(apexInsight.speedDiffKmh <= -10);

  const brakeInsight = res.insights.find((i) => i.kind === "brake");
  assert.ok(brakeInsight && brakeInsight.kind === "brake" && brakeInsight.turnNumber === 1 && brakeInsight.diffM < -6);
});

check("identical laps produce zero delta and no spurious insights", () => {
  const lap = makeLap({});
  const res = analyzeLaps(lap, lap, TURNS, { sectorSplitsM: SPLITS });
  assert.equal(res.totalDeltaMs, 0);
  assert.equal(res.insights.length, 0);
  assert.ok(res.points.every((p) => p.deltaS === 0));
});

check("empty lap data degrades gracefully without crashing", () => {
  const empty: LapRecording = { ...makeLap({}), data: [] };
  const res = analyzeLaps(empty, empty, TURNS, { sectorSplitsM: SPLITS });
  assert.equal(res.points.length, 0);
});

console.log("Car-scoped personal best & invalid lap filtering");
check("selectCarBestLap never falls back to another car on the same circuit", () => {
  const f1Lap = makeLap({
    trackId: "spa",
    vehicle: "lc26",
    sectorTimesMs: [15_000, 15_000, 15_000],
    physicsVersion: lapPhysicsVersion("lc26", "spa"),
  });
  const gt3Old = makeLap({
    trackId: "spa",
    vehicle: "amg-gt3",
    sectorTimesMs: [25_000, 25_000, 25_000],
    physicsVersion: 1,
  });
  const gt3Cur = makeLap({
    trackId: "spa",
    vehicle: "amg-gt3",
    sectorTimesMs: [26_000, 26_000, 26_000],
    physicsVersion: lapPhysicsVersion("amg-gt3", "spa"),
  });

  // Liana has no saved best on Spa -> must return null, NOT the LC26's lap
  assert.equal(selectCarBestLap([f1Lap, gt3Old, gt3Cur], "spa", "liana"), null);
  // GT3 prefers current physics revision over an older faster revision
  assert.equal(selectCarBestLap([f1Lap, gt3Old, gt3Cur], "spa", "amg-gt3"), gt3Cur);
  // Falls back to legacy revision of the SAME car when no current-physics lap exists
  assert.equal(selectCarBestLap([f1Lap, gt3Old], "spa", "amg-gt3"), gt3Old);
});

check("buildLapChoices never promotes an invalid faster lap over a valid reference best", () => {
  const validPb = makeLap({ sectorTimesMs: [20_000, 22_000, 18_000], recordedAt: 1000 });
  const fasterInvalid = makeLap({ sectorTimesMs: [19_000, 21_000, 17_000], recordedAt: 2000 });
  const sessionLaps: SessionLapEntry[] = [{ recording: fasterInvalid, valid: false, lapNumber: 2 }];

  const built = buildLapChoices({ sessionLaps, allTimeBest: validPb, latestLap: fasterInvalid });
  assert.equal(built.choices.length, 2);
  const ref = built.choices.find((c) => c.id === built.defaultRefId);
  const cmp = built.choices.find((c) => c.id === built.defaultCmpId);
  assert.equal(ref?.recording.recordedAt, validPb.recordedAt, "valid PB stays reference");
  assert.equal(cmp?.recording.recordedAt, fasterInvalid.recordedAt, "invalid latest lap is still inspectable as comparison");
  assert.equal(cmp?.valid, false);
});

check("buildLapChoices with valid session laps picks the fastest valid lap as reference, ignoring faster invalid laps", () => {
  const slowValid = makeLap({ sectorTimesMs: [21_000, 22_000, 19_000], recordedAt: 1000 });
  const fastInvalid = makeLap({ sectorTimesMs: [18_000, 20_000, 17_000], recordedAt: 2000 });
  const sessionLaps: SessionLapEntry[] = [
    { recording: fastInvalid, valid: false, lapNumber: 2 },
    { recording: slowValid, valid: true, lapNumber: 1 },
  ];

  const built = buildLapChoices({ sessionLaps, allTimeBest: null, latestLap: fastInvalid });
  const ref = built.choices.find((c) => c.id === built.defaultRefId);
  const cmp = built.choices.find((c) => c.id === built.defaultCmpId);
  assert.equal(ref?.recording.recordedAt, slowValid.recordedAt);
  assert.equal(cmp?.recording.recordedAt, fastInvalid.recordedAt);
});

check("buildLapChoices deduplicates when all-time best and latest lap are the same recording", () => {
  const onlyLap = makeLap({ recordedAt: 5000 });
  const built = buildLapChoices({
    sessionLaps: [{ recording: onlyLap, valid: true, lapNumber: 1 }],
    allTimeBest: onlyLap,
    latestLap: onlyLap,
  });
  assert.equal(built.choices.length, 1);
  assert.equal(built.defaultRefId, built.defaultCmpId);
});

console.log(`\n${passed} checks passed`);
