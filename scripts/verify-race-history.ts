/**
 * Checks the race history kept in the browser (`src/lib/sim/race-history.ts`): the record from a classification,
 * the upsert as a provisional result firms up, the cap of 50, places gained, and storage that fails or holds junk.
 * Run: npx tsx scripts/verify-race-history.ts
 */
import type { RaceResultEntry } from "../src/types/f1";
import {
  RACE_HISTORY_MAX,
  loadRaceHistory,
  placesGained,
  recordFromResults,
  saveRaceRecord,
  type HistoryStorage,
  type RaceRecord,
} from "../src/lib/sim/race-history";

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

const row = (position: number, isPlayer: boolean, extra: Partial<RaceResultEntry> = {}): RaceResultEntry => ({
  position,
  driverCode: isPlayer ? "YOU" : `A0${position}`,
  name: isPlayer ? "You" : `Driver ${position}`,
  teamColorHex: "#fff",
  isPlayer,
  finishTimeS: 300 + position,
  gapS: position > 1 ? position : null,
  lapsDown: 0,
  lapsCompleted: 3,
  bestLapMs: 95_000 + position,
  dnf: false,
  ...extra,
});
const meta = { id: "race-a", atMs: 1_000, trackId: "rwanda_official_short", carId: "vf26", kind: "ai_race" as const };

console.log("The record from a classification");
{
  const results = [row(1, false, { gridPosition: 3 }), row(2, true, { gridPosition: 5, penaltyS: 3 }), row(3, false, { gridPosition: 1 })];
  const rec = recordFromResults(results, false, meta);
  check(
    "grid, finish, field, best lap, race time and penalties",
    rec !== null && rec.grid === 5 && rec.finish === 2 && rec.fieldSize === 3 && rec.bestLapMs === 95_002 && rec.raceTimeS === 302 && rec.penaltyS === 3 && !rec.final,
    JSON.stringify(rec)
  );
  check("no player row: nothing to save", recordFromResults([row(1, false)], true, meta) === null);
  const out = recordFromResults([row(1, false), row(2, true, { dnf: true, finishTimeS: null })], true, meta);
  check("a retirement keeps no place and no time", out !== null && out.finish === null && out.raceTimeS === null && out.final);
  check("places gained from the grid", placesGained(5, 2) === 3 && placesGained(1, 4) === -3 && placesGained(2, 2) === 0);
  check("places gained need both ends", placesGained(null, 2) === null && placesGained(3, null) === null && placesGained(undefined, 1) === null);
}

console.log("Saving");
{
  const store = memory();
  const base = recordFromResults([row(1, true, { gridPosition: 2 })], false, meta) as RaceRecord;
  saveRaceRecord(base, store);
  saveRaceRecord(base, store);
  check("saving the same race twice keeps one record", loadRaceHistory(store).length === 1);
  saveRaceRecord({ ...base, final: true, raceTimeS: 299 }, store);
  const firm = loadRaceHistory(store);
  check("a provisional result firming up replaces its record", firm.length === 1 && firm[0].final && firm[0].raceTimeS === 299);
  for (let i = 0; i < 60; i++) saveRaceRecord({ ...base, id: `race-${i}`, atMs: 2_000 + i }, store);
  const all = loadRaceHistory(store);
  check("the last 50 races, newest first", all.length === RACE_HISTORY_MAX && all[0].id === "race-59" && all[49].id === "race-10");
  saveRaceRecord({ ...base, id: "race-30", finish: 7 }, store);
  const again = loadRaceHistory(store);
  check("an update keeps the record where it stands", again.length === RACE_HISTORY_MAX && again[29].id === "race-30" && again[29].finish === 7);
}

console.log("Storage that fails or holds something else");
{
  const broken: HistoryStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  const rec = recordFromResults([row(1, true)], true, meta) as RaceRecord;
  check("blocked storage loads as empty", loadRaceHistory(broken).length === 0);
  check("a failed save still returns the race", saveRaceRecord(rec, broken).length === 1);
  check("no storage at all", loadRaceHistory(null).length === 0 && saveRaceRecord(rec, null).length === 1);
  const junk = memory();
  junk.data.set("librecorsa.raceHistory", "{not json");
  check("unreadable data loads as empty", loadRaceHistory(junk).length === 0);
  junk.data.set("librecorsa.raceHistory", JSON.stringify([{ id: 1 }, null, { ...rec, kind: "drag_race" }, rec]));
  const kept = loadRaceHistory(junk);
  check("malformed records are left out", kept.length === 1 && kept[0].id === rec.id);
}

console.log(`\n${passed} checks passed`);
