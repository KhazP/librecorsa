/**
 * Checks the full-screen podium's data (`src/lib/show/podium-board.ts`): the top three and the rows down to P10 (the
 * player's own row apart when further back), each row's time or gap as the results table words it, the race's fastest
 * lap, the career's names, and the round's effect on the player's championship.
 * Run: npx tsx scripts/verify/verify-podium-board.ts
 */
import type { RaceResultEntry } from "../../src/types/f1";
import type { ShowContext, ShowDriver } from "../../src/lib/show/show-context";
import { boardChampionship, boardGap, podiumBoard } from "../../src/lib/show/podium-board";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}`);
}

const row = (position: number, code: string, extra: Partial<RaceResultEntry> = {}): RaceResultEntry => ({
  position,
  driverCode: code,
  name: code,
  teamColorHex: "#abc",
  isPlayer: code === "YOU",
  finishTimeS: 600 + position * 2,
  gapS: position === 1 ? null : position * 2 - 2,
  lapsDown: 0,
  lapsCompleted: 10,
  bestLapMs: 90_000 + position * 100,
  dnf: false,
  ...extra,
});
/** A field of n, the player at `me` */
const field = (n: number, me: number, extra: Record<number, Partial<RaceResultEntry>> = {}): RaceResultEntry[] =>
  Array.from({ length: n }, (_, i) => {
    const p = i + 1;
    return row(p, p === me ? "YOU" : `C${p}`, extra[p]);
  });

console.log("The rows");
{
  check("no result: no board", podiumBoard(undefined, false, null) === null && podiumBoard([], false, null) === null);
  check("no one in the top three finished: no board", podiumBoard([row(1, "A", { finishTimeS: null, dnf: true })], true, null) === null);
  const b = podiumBoard(field(14, 5).reverse(), false, null)!;
  check("the top three, P1 first", b.podium.map((e) => e.position).join() === "1,2,3");
  check("P4 to P10 after them", b.rest.map((e) => e.position).join() === "4,5,6,7,8,9,10" && !b.playerApart);
  check("the player marked", b.rest.find((e) => e.position === 5)?.driver.isPlayer === true);
  const far = podiumBoard(field(16, 13), false, null)!;
  check("the player further back: their own row last, apart", far.playerApart && far.rest.length === 8 && far.rest[7].position === 13 && far.rest[7].driver.isPlayer);
  const small = podiumBoard(field(3, 2), false, null)!;
  check("a field of three: no rows below the podium", small.podium.length === 3 && small.rest.length === 0);
  const names = podiumBoard([row(1, "VER", { name: "Max V" }), row(2, "YOU", { name: "" })], false, null)!;
  check("outside the career: the result's name, else its code", names.podium[0].driver.last === "Max V" && names.podium[1].driver.last === "YOU" && names.podium[0].driver.number === null);
}

console.log("Times and gaps, as the results table words them");
{
  check("the winner: the race time", JSON.stringify(boardGap(row(1, "A"), false)) === JSON.stringify({ kind: "time", s: 602 }));
  check("behind: the gap", JSON.stringify(boardGap(row(3, "A"), false)) === JSON.stringify({ kind: "gap", s: 4 }));
  check("lapped: laps down", JSON.stringify(boardGap(row(9, "A", { lapsDown: 2 }), false)) === JSON.stringify({ kind: "laps", count: 2 }));
  check("still running: running", boardGap(row(8, "A", { finishTimeS: null, gapS: null }), false).kind === "running");
  check("still running when the classification closed: DNF", boardGap(row(8, "A", { finishTimeS: null, gapS: null }), true).kind === "dnf");
  check("retired: DNF", boardGap(row(8, "A", { finishTimeS: null, dnf: true }), false).kind === "dnf");
  check("disqualified: DSQ", boardGap(row(8, "A", { dq: true }), false).kind === "dsq");
}

console.log("The fastest lap");
{
  const b = podiumBoard(field(10, 4, { 7: { bestLapMs: 88_500 }, 2: { bestLapMs: null } }), false, null)!;
  check("the quickest best lap in the field, by whoever", b.fastest?.ms === 88_500 && b.fastest.driver.code === "C7");
  const none = podiumBoard(field(4, 2).map((r) => ({ ...r, bestLapMs: null })), false, null)!;
  check("no lap timed: none", none.fastest === null);
}

console.log("A career round");
{
  const driver = (code: string, first: string, last: string, number: number | null, isPlayer = false): ShowDriver => ({
    code,
    first,
    last,
    number,
    color: isPlayer ? "#0f0" : "#f00",
    isPlayer,
  });
  const codes = ["C1", "C2", "C3", "C4", "C5", "C6"];
  const drivers: Record<string, ShowDriver> = { YOU: driver("YOU", "Alex", "Rider", null, true) };
  codes.forEach((c, i) => (drivers[c] = driver(c, `First${i + 1}`, `Last${i + 1}`, 10 + i)));
  const ctx = (roundIndex: number, standings: [string, number][]): ShowContext => ({
    seriesId: "kart",
    roundIndex,
    rounds: 6,
    laps: 10,
    pitStops: 0,
    qualifyingMin: 0,
    drivers,
    standings: standings.map(([code, points], i) => ({ position: i + 1, code, points, isPlayer: code === "YOU" })),
    weather: "clear",
    timeOfDay: "noon",
  });
  const race = [row(1, "C1"), row(2, "YOU"), row(3, "C2"), row(4, "C3"), row(5, "C4"), row(6, "C5"), row(7, "C6")];
  const round2 = ctx(1, [["C1", 25], ["C3", 17], ["C2", 14], ["YOU", 12], ["C4", 10], ["C5", 8], ["C6", 6]]);
  const b = podiumBoard(race, false, round2)!;
  check("the rivals' names and numbers", b.podium[0].driver.first === "First1" && b.podium[0].driver.last === "Last1" && b.podium[0].driver.number === 10);
  check("the player by their own name", b.podium[1].driver.last === "Rider" && b.podium[1].driver.isPlayer);
  const c = b.championship!;
  check("the round's points (P2: 18)", c.points === 18 && c.total === 30);
  check("the place after it and before", c.position === 2 && c.was === 4, JSON.stringify(c));
  const notInCareer = podiumBoard(race, false, null)!;
  check("outside the career: no championship line", notInCareer.championship === null);

  const first = boardChampionship(ctx(0, [["C1", 0], ["C2", 0], ["YOU", 0], ["C3", 0], ["C4", 0], ["C5", 0], ["C6", 0]]), race, true)!;
  check("the first round: no place before it", first.was === null && first.position === 2 && first.points === 18);

  const dnf = [row(1, "C1"), row(2, "C2"), row(3, "C3"), row(4, "YOU", { dq: true })];
  check("disqualified: no points", boardChampionship(round2, dnf, true)!.points === 0);

  const level = boardChampionship(ctx(1, [["C1", 36], ["YOU", 12]]), [row(1, "YOU"), row(2, "C2"), row(3, "C3"), row(10, "C1", { gapS: 20 })], true)!;
  check("level on points with another: no place claimed (the career breaks the tie)", level.total === 37 && level.position === null, JSON.stringify(level));

  const running = [row(1, "C1"), row(2, "YOU"), row(3, "C2"), row(4, "C3", { finishTimeS: null, gapS: null })];
  check("a car still running in the points: no place yet", boardChampionship(round2, running, false)!.position === null);
  check("… but the points are the player's already", boardChampionship(round2, running, false)!.points === 18);
  check("once the classification is final: the place", boardChampionship(round2, running, true)!.position !== null);
}

console.log(`\n${passed} checks passed`);
