/**
 * Checks the multiplayer race timing: host-clock start procedure, lap counting from race distance,
 * contact rules, running order and the final classification.
 * Run: npx tsx scripts/verify-race-session.ts
 */
import * as THREE from "three";
import { GapTimer, LapClock, MultiplayerRace, classificationClosed, classify, raceOrder, type RacerProgress } from "../src/lib/sim/race-session";
import type { InterpolatedPeerState, RaceStartInfo } from "../src/lib/sim/multiplayer-sync";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}`);
}

const L = 4000;
const start: RaceStartInfo = {
  id: "race-1",
  lightsStartHostMs: 10_000,
  holdMs: 500,
  laps: 2,
  collisions: "ghost_lap1",
  carClass: "any",
  trackId: "rwanda",
  grid: ["host", "me", "other"],
};
const roster = [
  { peerId: "host", name: "Host", code: "HST", color: "#ff0000" },
  { peerId: "me", name: "Me", code: "ME_", color: "#00ff00" },
  { peerId: "other", name: "Other", code: "OTH", color: "#0000ff" },
];

console.log("Start procedure");
const race = new MultiplayerRace(start, L, "me", { name: "Me", code: "MEE", color: "#00ff00" }, roster);
check("grid slot from the host's grid order", race.gridSlot === 1);
const pre = race.frame(8_000);
check("countdown before the lights", pre.phase === "countdown" && Math.abs(pre.countdownS - 2) < 1e-9);
check("one light per second", race.frame(10_000).lightsOn === 1 && race.frame(13_999).lightsOn === 4 && race.frame(14_200).lightsOn === 5);
check("lights stay on through the hold", race.frame(15_499).phase === "lights");
const go = race.frame(16_500);
check("race time counts from lights out", go.phase === "racing" && Math.abs(go.raceTimeS - 1) < 1e-9);
check("no contact on the grid", !race.collisionsActive(race.frame(12_000)));

console.log("Lap clock");
const clock = new LapClock(L);
clock.reset(L - 30); // 30 m behind the line on the grid
check("grid spot behind the line is negative distance", Math.abs(clock.distM + 30) < 1e-9);
let finished = false;
let s = L - 30;
let t = 0;
for (let i = 0; i < 2000 && !finished; i++) {
  s = (s + 5) % L;
  t += 0.1;
  finished = clock.update(s, t, 2);
}
check("finishes after the race distance", finished && clock.finishTimeS !== null && clock.distM >= 2 * L);
check("best lap recorded", clock.bestLapMs !== null && clock.bestLapMs > 0);
check("no more laps after the flag", clock.update((s + 5) % L, t + 0.1, 2) === false);

console.log("Contact rules");
race.lapClock.reset(L - 20);
check("ghosted on the opening lap", !race.collisionsActive(go));
for (let d = 0; d < L + 40; d += 10) race.lapClock.update((L - 20 + d) % L, 1, 5);
check("contact from lap 2", race.collisionsActive(go));

console.log("Standings and classification");
const peer = (id: string, dist: number, fin: number | null): InterpolatedPeerState => ({
  peerId: id,
  driverCode: id.toUpperCase().slice(0, 3),
  teamColorHex: "#fff",
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  linearVelocity: new THREE.Vector3(),
  steerAngle: 0,
  wheelRPMs: [0, 0, 0, 0],
  throttle: 0,
  brake: 0,
  trackS: 0,
  speedKmh: 200,
  isAiPeer: false,
  race: { id: "race-1", dist, fin, best: null },
});
race.ingestPeers([peer("host", 2 * L + 5, 100), peer("other", L * 0.5, null), { ...peer("x", 9e9, 1), race: { id: "old", dist: 9e9, fin: 1, best: null } }]);
const st = race.status(race.frame(200_000), 50);
check("finisher leads, then by distance", st.standings[0].driverCode === "HOS" && st.position === 2 && st.fieldSize === 3);
check("other races are ignored", !st.standings.some((r) => r.driverCode === "X"));
check("multiplayer flag and lap count", st.multiplayer === true && st.totalLaps === 2);

const racers: RacerProgress[] = [
  { id: "a", code: "AAA", name: "A", color: "", isPlayer: false, distM: 8000, speedMs: 0, finishTimeS: 100, bestLapMs: null },
  { id: "b", code: "BBB", name: "B", color: "", isPlayer: true, distM: 7000, speedMs: 50, finishTimeS: null, bestLapMs: null },
];
const ordered = raceOrder(racers);
check("classification stays open while someone races", !classificationClosed(ordered, 150));
check("closes 90 s after the winner", classificationClosed(ordered, 191));

console.log("Lapped cars at the flag");
{
  // Short lap, 3 laps: A wins at 150 s; C, a lap down, crosses the line 20 s later and takes the flag there; B, on
  // the lead lap, finishes 30 s after A
  const lap = 1000;
  const c = new LapClock(lap);
  c.reset(0);
  // 20 m/s; the winner is in at 75 s (C at 1.5 laps): C's next crossing, at 2 laps, is its finish
  for (let i = 1; i < 400 && c.finishTimeS === null; i++) c.update((i * 10) % lap, i * 0.5, 3, i * 0.5 >= 75);
  check("a lapped car finishes at its next crossing once the flag is out", c.finishTimeS !== null && c.finishLaps === 2, `laps ${c.finishLaps}`);
  const field: RacerProgress[] = [
    { id: "a", code: "AAA", name: "A", color: "", isPlayer: false, distM: 3050, speedMs: 0, finishTimeS: 150, finishLaps: 3, bestLapMs: null },
    { id: "c", code: "CCC", name: "C", color: "", isPlayer: true, distM: 2100, speedMs: 0, finishTimeS: 170, finishLaps: 2, bestLapMs: null },
    { id: "b", code: "BBB", name: "B", color: "", isPlayer: false, distM: 3020, speedMs: 0, finishTimeS: 180, finishLaps: 3, bestLapMs: null },
  ];
  const order = raceOrder(field);
  check("finishers on the lead lap rank ahead of a lapped one that finished sooner", order.map((r) => r.id).join("") === "abc", order.map((r) => r.id).join(""));
  const res = classify(order, lap, 3, true);
  check("the lapped finisher is +1 LAP, not a time gap", res[2].lapsDown === 1 && res[2].lapsCompleted === 2, JSON.stringify(res[2]));
  check("the lead-lap finisher has a time gap", res[1].lapsDown === 0 && Math.abs((res[1].gapS ?? 0) - 30) < 1e-9);
  // An older client that doesn't report its laps at the flag is taken to have run the full distance
  const legacy = classify(raceOrder([field[0], { ...field[2], finishLaps: undefined }]), lap, 3, true);
  check("a finisher without lap count counts as on the lead lap", legacy[1].lapsDown === 0);
}

console.log("Running order, retirements and ties");
{
  const car = (id: string, o: Partial<RacerProgress>): RacerProgress => ({
    id, code: id.toUpperCase(), name: id, color: "", isPlayer: false, distM: 0, speedMs: 0, finishTimeS: null, bestLapMs: null, ...o,
  });
  // 5 laps; the winner finishes at 500 s, a lapped car takes the flag on its next crossing 95 s later (4 laps)
  const winner = car("win", { distM: 5 * L + 50, finishTimeS: 500, grid: 1 });
  const lapped = car("lap", { distM: 4 * L + 10, finishTimeS: 595, finishLaps: 4, grid: 0 });
  const onLead = car("run", { distM: 4 * L + 3000, speedMs: 80, grid: 2 });
  const order = raceOrder([lapped, onLead, winner], L);
  check("a lead-lap car on its last lap is ahead of a lapped finisher", order.map((r) => r.id).join() === "win,run,lap", order.map((r) => r.id).join());
  const res = classify(order, L, 5, false);
  const lappedRes = res.find((r) => r.name === "lap");
  check("a lapped finisher is +1 LAP, not a time gap", lappedRes?.lapsDown === 1 && lappedRes.gapS === null && lappedRes.lapsCompleted === 4, JSON.stringify(lappedRes));

  const clock = new LapClock(L);
  clock.reset(0);
  let fin = false;
  let s = 0;
  for (let i = 0; i < 900 && !fin; i++) {
    s = (s + 10) % L;
    fin = clock.update(s, i * 0.1, 5, true);
  }
  check("once the flag is out, a car finishes on its next crossing", fin && clock.finishLaps === 1, `${clock.finishLaps}`);

  const dnf = car("dnf", { distM: 5 * L - 100, dnf: true, grid: 3 });
  const res2 = classify(raceOrder([dnf, winner, lapped], L), L, 5, true);
  check("a retired car is classified DNF, behind the finishers", res2[2].name === "dnf" && res2[2].dnf && res2[2].finishTimeS === null);
  check("the classification closes when every car has finished or retired", classificationClosed(raceOrder([winner, lapped, dnf], L), 600));

  const tieA = car("ta", { distM: 1000, grid: 4 });
  const tieB = car("tb", { distM: 1000, grid: 2 });
  check("a tie goes to the better grid slot", raceOrder([tieA, tieB], L)[0].id === "tb");
  const deadHeat = raceOrder([car("x", { distM: 5 * L, finishTimeS: 300, grid: 5 }), car("y", { distM: 5 * L, finishTimeS: 300, grid: 1 })], L);
  check("a dead heat at the flag goes to the better grid slot", deadHeat[0].id === "y");
}

console.log("Multiplayer: late joiners and dropped players");
{
  const late = new MultiplayerRace(start, L, "late", { name: "Late", code: "LAT", color: "#fff" }, roster);
  check("a player missing from the grid starts at the back, not on pole", late.gridSlot === start.grid.length);

  const mp = new MultiplayerRace(start, L, "me", { name: "Me", code: "MEE", color: "#00ff00" }, roster);
  const lightsOut = 10_000 + 5_000 + 500;
  const at = (s: number) => mp.frame(lightsOut + s * 1000);
  const pkt = (id: string, dist: number, fin: number | null, laps?: number): InterpolatedPeerState =>
    ({ peerId: id, driverCode: id.toUpperCase(), teamColorHex: "#000", speedKmh: 100, position: new THREE.Vector3(), race: { id: "race-1", dist, fin, best: null, laps } }) as unknown as InterpolatedPeerState;
  mp.ingestPeers([pkt("host", 100, null), pkt("other", 90, null)], 5);
  check("everyone reporting: nobody out", !mp.status(at(20), 50).standings.some((r) => r.name === "other" && r.finished));
  mp.ingestPeers([pkt("host", 4000, null)], 40);
  const later = mp.status(at(40), 50);
  check("a player silent for 30 s drops to the back", later.standings[later.standings.length - 1].name === "Other", later.standings.map((r) => r.name).join());
  mp.ingestPeers([pkt("host", 2 * L + 5, 300, 2)], 300);
  check("the flag is out once anyone finishes", mp.flagOut);
  const p = mp.progress();
  check("the player's progress carries no lap count before their flag", p.laps === undefined);
}

const gaps = new GapTimer();
gaps.record(10, [100]);
gaps.record(12, [150, 100]);
check("gap is the time since the leader passed", Math.abs(gaps.gapS(12, 100, 50) - 2) < 1e-9);

console.log(`\n${passed} checks passed`);
