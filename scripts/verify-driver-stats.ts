/**
 * Checks the driver's totals (`src/lib/sim/driver-stats.ts`): the first read from the race history, a race counted
 * once however often its record is saved, a result that firms up replacing what it counted, retirements, time and
 * distance, and storage that fails or holds junk.
 * Run: npx tsx scripts/verify-driver-stats.ts
 */
import {
  DRIVER_STATS_KEY,
  averageFinish,
  loadDriverStats,
  mostDriven,
  recordDrivingTime,
  recordLapDistance,
  recordRaceResult,
} from "../src/lib/sim/driver-stats";
import { saveRaceRecord, type HistoryStorage, type RaceRecord } from "../src/lib/sim/race-history";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}`);
}

const memory = (): HistoryStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

const race = (id: string, finish: number | null, extra: Partial<RaceRecord> = {}): RaceRecord => ({
  id,
  atMs: 1,
  trackId: "monza",
  carId: "lc26",
  kind: "ai_race",
  grid: 5,
  finish,
  fieldSize: 10,
  bestLapMs: 90_000,
  raceTimeS: finish === null ? null : 600,
  penaltyS: 0,
  final: true,
  ...extra,
});

// Nothing yet
{
  const s = loadDriverStats(memory());
  check("empty storage: no races, no time", s.races === 0 && s.drivingS === 0 && s.distanceM === 0);
  check("no average before a finish", averageFinish(s) === null);
  check("no most driven car", mostDriven(s.carS) === null);
  check("no storage at all: empty", loadDriverStats(null).races === 0);
}

// The first read counts the races already in the history, without writing anything
{
  const st = memory();
  saveRaceRecord(race("a", 1), st);
  saveRaceRecord(race("b", 3, { trackId: "spa", raceTimeS: 1200 }), st);
  saveRaceRecord(race("c", null), st);
  const s = loadDriverStats(st);
  check("seeded: three races", s.races === 3, String(s.races));
  check("seeded: two finishes, one win, two podiums", s.finishes === 2 && s.wins === 1 && s.podiums === 2);
  check("seeded: average of the finishes only", averageFinish(s) === 2, String(averageFinish(s)));
  check("seeded: time from the race times", s.drivingS === 1800 && s.trackS.spa === 1200 && s.trackS.monza === 600);
  check("seeded: no distance", s.distanceM === 0);
  check("seeded: most driven circuit", mostDriven(s.trackS) === "spa");
  check("reading writes nothing", !st.data.has(DRIVER_STATS_KEY));

  // The race on track is saved to the history first, then counted: once
  saveRaceRecord(race("d", 2), st);
  recordRaceResult(race("d", 2), true, st);
  const t = loadDriverStats(st);
  check("the race just saved counts once", t.races === 4, String(t.races));
  check("its fastest lap counts", t.fastestLaps === 1);
  check("now written", st.data.has(DRIVER_STATS_KEY));
}

// One race, saved again as its result firms up
{
  const st = memory();
  recordRaceResult(race("r", 4), false, st);
  recordRaceResult(race("r", 4), false, st);
  recordRaceResult(race("r", 3), false, st);
  let s = loadDriverStats(st);
  check("saved three times: one race", s.races === 1 && s.finishes === 1, String(s.races));
  check("the firmer result replaces the first (P4 to P3)", s.podiums === 1 && s.finishSum === 3);
  recordRaceResult(race("r", 3), true, st);
  s = loadDriverStats(st);
  check("a fastest lap found later counts once", s.fastestLaps === 1 && s.races === 1);
  recordRaceResult(race("r", 1), false, st);
  s = loadDriverStats(st);
  check("…and goes if it was not", s.fastestLaps === 0 && s.wins === 1 && s.podiums === 1);
  recordRaceResult(race("r", null), false, st);
  s = loadDriverStats(st);
  check("a retirement: a race, no finish, no win", s.races === 1 && s.finishes === 0 && s.wins === 0 && s.podiums === 0);
  check("no average with no finish", averageFinish(s) === null);
  recordRaceResult(race("next", 7), false, st);
  s = loadDriverStats(st);
  check("another race adds", s.races === 2 && s.finishes === 1 && averageFinish(s) === 7);
}

// Time and distance
{
  const st = memory();
  recordDrivingTime(120, "lc26", "monza", st);
  recordDrivingTime(300, "gt3", "monza", st);
  recordDrivingTime(0.4, "gt3", "spa", st);
  recordDrivingTime(Number.NaN, "gt3", "spa", st);
  recordLapDistance(5793, st);
  recordLapDistance(0, st);
  recordLapDistance(-1, st);
  const s = loadDriverStats(st);
  check("time adds up", s.drivingS === 420, String(s.drivingS));
  check("a moment under a second is not driving", !("spa" in s.trackS));
  check("most driven car by time", mostDriven(s.carS) === "gt3");
  check("distance from completed laps only", s.distanceM === 5793, String(s.distanceM));
}

// Junk and failures
{
  const st = memory();
  st.data.set(DRIVER_STATS_KEY, "{not json");
  check("junk reads as the race history (empty)", loadDriverStats(st).races === 0);
  st.data.set(DRIVER_STATS_KEY, JSON.stringify({ version: 1, races: -3, wins: "x", carS: { a: -1, b: 5 }, counted: [{ id: 1 }, { id: "ok", finish: 2 }] }));
  const s = loadDriverStats(st);
  check("bad numbers read as 0", s.races === 0 && s.wins === 0);
  check("bad times dropped", !("a" in s.carS) && s.carS.b === 5);
  check("bad counted races dropped", s.counted.length === 1 && s.counted[0].id === "ok");
  const full: HistoryStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  recordDrivingTime(60, "lc26", "monza", full);
  check("a full storage does not throw", recordRaceResult(race("q", 1), false, full).races === 1);
}

console.log(`\nAll ${passed} driver stats checks passed.`);
