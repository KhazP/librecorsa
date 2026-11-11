/**
 * Checks the multiplayer race timing: host-clock start procedure, lap counting from race distance,
 * contact rules, running order and the final classification.
 * Run: npx tsx scripts/verify-race-session.ts
 */
import * as THREE from "three";
import { GapTimer, LapClock, MultiplayerRace, classificationClosed, classify, raceOrder, type RacerProgress } from "../src/lib/sim/race-session";
import type { InterpolatedPeerState, RaceStartInfo } from "../src/lib/sim/multiplayer-sync";
import { sanitizePacket, type ControlMessage, type NetworkVehiclePacket } from "../src/lib/net/wire";

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
  trackId: "rwanda_official_short",
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
  const silent = mp.status(at(40), 50);
  check("a player silent for 30 s but still in the lobby keeps its place", silent.standings[0].name === "Host" && silent.standings[1].name === "Other", silent.standings.map((r) => r.name).join());
  mp.setPresent(["host", "me"]);
  const later = mp.status(at(41), 50);
  check("a player gone from the lobby drops to the back", later.standings[later.standings.length - 1].name === "Other", later.standings.map((r) => r.name).join());
  mp.ingestPeers([pkt("host", 2 * L + 5, 300, 2)], 300);
  check("the flag is out once anyone finishes", mp.flagOut);
  const p = mp.progress();
  check("the player's progress carries no lap count before their flag", p.laps === undefined);
}

{
  const me = { name: "Me", code: "MEE", color: "#00ff00" };
  const lightsOut = 10_000 + 5_000 + 500;
  const pkt = (id: string, dist: number, fin: number | null, laps?: number): InterpolatedPeerState =>
    ({ peerId: id, driverCode: id.toUpperCase(), teamColorHex: "#000", speedKmh: 100, position: new THREE.Vector3(), race: { id: "race-1", dist, fin, best: null, laps } }) as unknown as InterpolatedPeerState;

  console.log("Multiplayer: a host clock that steps back");
  {
    const r = new MultiplayerRace(start, L, "me", me, roster);
    r.frame(lightsOut + 2000);
    const back = r.frame(lightsOut - 300);
    check("racing stays racing when the clock steps back", back.phase === "racing" && back.raceTimeS === 2, JSON.stringify(back));
    check("the race time holds until the clock catches up", r.frame(lightsOut + 1500).raceTimeS === 2 && Math.abs(r.frame(lightsOut + 2500).raceTimeS - 2.5) < 1e-9);
    const lights = new MultiplayerRace(start, L, "me", me, roster);
    lights.frame(13_500);
    const lb = lights.frame(9_000);
    check("the lights never go back to the countdown", lb.phase === "lights" && lb.lightsOn === 4, JSON.stringify(lb));
  }

  console.log("Multiplayer: race rules for the overtaking aids");
  {
    const r = new MultiplayerRace(start, L, "me", me, roster);
    check("no race rules before any frame", !r.raceRulesActive);
    r.frame(8_000);
    check("no race rules in the countdown", !r.raceRulesActive);
    r.frame(11_000);
    check("race rules through the lights", r.raceRulesActive);
    r.frame(lightsOut + 1000);
    check("race rules while racing", r.raceRulesActive);
    r.lapClock.finishTimeS = 300;
    check("free again after the player's flag", !r.raceRulesActive);

    const d = new MultiplayerRace({ ...start, laps: 10, collisions: "on" }, L, "me", me, roster);
    const f = d.frame(lightsOut + 100_000);
    d.lapClock.distM = 3 * L + 1000;
    d.ingestPeers([pkt("host", 3 * L + 1040, null), pkt("other", 3 * L + 500, null)], 100);
    d.status(f, 50);
    check(
      "earned within 1 s of the car ahead",
      d.detectionEarnedFor({ overtakingRules: "straight-mode-2026" }) && d.detectionEarnedFor({ overtakingRules: "drs-rear" })
    );
    check("a car without overtaking aids earns nothing", !d.detectionEarnedFor({}));
    d.ingestPeers([pkt("host", 3 * L + 1200, null)], 100);
    d.status(f, 50);
    check("not earned 4 s behind", !d.detectionEarnedFor({ overtakingRules: "straight-mode-2026" }));
    d.ingestPeers([pkt("host", 3 * L + 1040, 99, 3)], 100);
    d.status(f, 50);
    check("a finished car ahead doesn't count", !d.detectionEarnedFor({ overtakingRules: "straight-mode-2026" }));
    const silent = new MultiplayerRace({ ...start, laps: 10, collisions: "on" }, L, "me", me, roster);
    silent.ingestPeers([pkt("host", 3 * L + 1040, null)], 50);
    const sf = silent.frame(lightsOut + 100_000);
    silent.lapClock.distM = 3 * L + 1000;
    silent.status(sf, 50);
    check("a player silent for 30 s is no car ahead", !silent.detectionEarnedFor({ overtakingRules: "straight-mode-2026" }));

    const early = new MultiplayerRace({ ...start, laps: 10, collisions: "on" }, L, "me", me, roster);
    const ef = early.frame(lightsOut + 20_000);
    early.lapClock.distM = 1000;
    early.ingestPeers([pkt("host", 1040, null)], 20);
    early.status(ef, 50);
    check(
      "DRS waits for the leader's second lap; Overtake Mode doesn't",
      !early.detectionEarnedFor({ overtakingRules: "drs-rear" }) && early.detectionEarnedFor({ overtakingRules: "straight-mode-2026" })
    );
  }

  console.log("Multiplayer: contact per player with ghosting on the opening lap");
  {
    const r = new MultiplayerRace(start, L, "me", me, roster);
    const racing = r.frame(lightsOut + 1000);
    r.lapClock.reset(L - 20);
    for (let d = 0; d < L + 40; d += 10) r.lapClock.update((L - 20 + d) % L, 1, 5);
    r.ingestPeers([pkt("host", L + 50, null), pkt("other", 500, null)], 1);
    check("solid with a player who is past lap 1 as well", r.collisionsActiveWith(racing, "host"));
    check("still a ghost to a player on the opening lap", !r.collisionsActiveWith(racing, "other"));
    check("a player not in this race is a ghost", !r.collisionsActiveWith(racing, "nobody"));
    const mine = new MultiplayerRace(start, L, "me", me, roster);
    const mf = mine.frame(lightsOut + 1000);
    mine.ingestPeers([pkt("host", L + 50, null)], 1);
    check("a ghost while this car is on its opening lap", !mine.collisionsActiveWith(mf, "host"));

    const on = new MultiplayerRace({ ...start, collisions: "on" }, L, "me", me, roster);
    check("on: never on the grid", !on.collisionsActiveWith(on.frame(12_000), "other"));
    check("on: solid with everyone once racing", on.collisionsActiveWith(on.frame(lightsOut + 1000), "other"));
    const fair = new MultiplayerRace({ ...start, collisions: "protected" }, L, "me", me, roster);
    fair.ingestPeers([pkt("host", L + 50, null)], 1);
    check("protected: a ghost on the opening lap", !fair.collisionsActiveWith(fair.frame(lightsOut + 1000), "host"));
    fair.lapClock.reset(L - 20);
    for (let d = 0; d < L + 40; d += 10) fair.lapClock.update((L - 20 + d) % L, 1, 5);
    check("protected: contact from lap 2, under the fair-play rule", fair.collisionsActiveWith(fair.frame(lightsOut + 1000), "host") && fair.guard !== null);
    check("the other rules have no fair-play rule", r.guard === null && on.guard === null);
    const off = new MultiplayerRace({ ...start, collisions: "off" }, L, "me", me, roster);
    off.ingestPeers([pkt("host", 3 * L, null)], 1);
    off.lapClock.distM = 3 * L;
    check("off: never", !off.collisionsActiveWith(off.frame(lightsOut + 100_000), "host"));
  }

  console.log("Multiplayer: the classification stands once it closes");
  {
    const r = new MultiplayerRace({ ...start, laps: 1, collisions: "on" }, L, "me", me, roster);
    const at = (s: number) => r.frame(lightsOut + s * 1000);
    r.ingestPeers([pkt("host", 100, null), pkt("other", 90, null)], 1);
    r.ingestPeers([pkt("host", L + 5, 60, 1)], 60);
    r.lapClock.distM = L + 3;
    r.lapClock.finishTimeS = 70;
    r.lapClock.finishLaps = 1;
    r.setPresent(["host", "me"]);
    const st = r.status(at(70), 50);
    const other = (s: typeof st) => s.results?.find((e) => e.name === "Other");
    check("closes with the player who left out", st.resultsFinal === true && other(st)?.dnf === true, JSON.stringify(other(st)));
    r.ingestPeers([pkt("other", L + 10, 75, 1)], 75);
    r.setPresent(["host", "me", "other"]);
    const st2 = r.status(at(75), 50);
    check("stays final when that player comes back", st2.resultsFinal === true && other(st2)?.dnf === true, JSON.stringify(other(st2)));
    check("and the classification no longer changes", JSON.stringify(st2.results) === JSON.stringify(st.results));

    const open = new MultiplayerRace(start, L, "me", me, roster);
    const at2 = (s: number) => open.frame(lightsOut + s * 1000);
    open.ingestPeers([pkt("host", 100, null), pkt("other", 90, null)], 1);
    open.ingestPeers([pkt("host", 3000, null)], 40);
    open.setPresent(["host", "me"]);
    const s1 = open.status(at2(40), 50);
    open.ingestPeers([pkt("other", 3500, null)], 41);
    open.setPresent(["host", "me", "other"]);
    const s2 = open.status(at2(41), 50);
    check(
      "before it closes, a player who left comes back with the lobby",
      s1.standings[s1.standings.length - 1]?.name === "Other" && s2.standings[0]?.name === "Other",
      `${s1.standings.map((x) => x.name).join()} then ${s2.standings.map((x) => x.name).join()}`
    );
  }
}

console.log("Multiplayer: two screens agree on the running order");
{
  // As the open-race test: car A drives off, then stops and pulls away again and again; car B stays on the grid. Each
  // screen runs its own MultiplayerRace, and the cars' progress goes between them as packets through sanitizePacket
  const duo: RaceStartInfo = { ...start, laps: 5, collisions: "protected", grid: ["peer_b", "peer_a"] };
  const ids = [
    { peerId: "peer_a", name: "Was", code: "WAS", color: "#ff0000" },
    { peerId: "peer_b", name: "Rac", code: "RAC", color: "#0000ff" },
  ];
  const lightsOut = duo.lightsStartHostMs + 5000 + duo.holdMs;
  const run = (silentFromS: number, silentToS: number) => {
    const screens = ids.map((me) => ({ me, race: new MultiplayerRace(duo, L, me.peerId, me, ids), s: 0 }));
    screens[0].s = L - 20; // A starts second, B on pole
    screens[1].s = L - 12;
    for (const sc of screens) sc.race.lapClock.reset(sc.s);
    const heard = new Map<string, NetworkVehiclePacket>();
    // Disagreements that last: a packet's trip makes the screens differ for a frame or two at a pass, no more
    const disagreements: string[] = [];
    let apart = 0;
    let speed = 0;
    for (let f = 0; f <= 60 * 30; f++) {
      const t = f / 30;
      // A: off the line for 13 s, then four stops and four getaways of 4.5 s each
      if (t > 0) {
        const phase = t < 13 ? 0 : Math.floor((t - 13) / 4.5);
        speed = t < 13 ? Math.min(60, speed + 0.4) : phase % 2 === 0 ? Math.max(0, speed - 0.6) : Math.min(60, speed + 0.4);
        screens[0].s = (screens[0].s + speed / 30) % L;
      }
      const leaders: string[] = [];
      for (const sc of screens) {
        const frame = sc.race.frame(lightsOut + t * 1000);
        sc.race.lapClock.update(sc.s, frame.raceTimeS, duo.laps, sc.race.flagOut);
        leaders.push(sc.race.status(frame, sc === screens[0] ? speed : 0).standings[0]?.driverCode ?? "");
      }
      apart = leaders[0] !== leaders[1] ? apart + 1 : 0;
      if (apart === 1 && f === 0) disagreements.push(`${t.toFixed(1)} s: ${leaders.join(" / ")} on the grid`);
      if (apart === 6) disagreements.push(`${t.toFixed(1)} s: ${leaders.join(" / ")}`);
      // Packets at 15 Hz; B's screen hears nothing from A in the silent window (A's page and socket stay up)
      for (const sc of screens) {
        if (f % 2 === 0) {
          const pkt = sanitizePacket({ peerId: sc.me.peerId, driverCode: sc.me.code, teamColorHex: sc.me.color, timestampMs: t * 1000, pos: [0, 0, 0], quat: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], wheelRPMs: [0, 0, 0, 0], trackS: sc.s, speedKmh: 0, name: sc.me.name, race: sc.race.progress() });
          if (pkt && !(sc === screens[0] && t >= silentFromS && t < silentToS)) heard.set(`${sc.me.peerId}>`, pkt);
        }
      }
      for (const sc of screens) {
        const other = ids.find((i) => i.peerId !== sc.me.peerId)!;
        const pkt = heard.get(`${other.peerId}>`);
        // A buffer dropped after 5 s without packets is no longer handed to the race (multiplayer-sync update())
        if (pkt && t * 1000 - pkt.timestampMs <= 5000) {
          sc.race.ingestPeers([{ ...pkt, position: new THREE.Vector3() } as unknown as InterpolatedPeerState], sc.race.frame(lightsOut + t * 1000).raceTimeS);
        }
      }
    }
    return disagreements;
  };
  const clean = run(Infinity, Infinity);
  check("with every packet through, both screens show the same leader all race", clean.length === 0, clean.join("; "));
  const gap = run(20, 60);
  check("one screen not hearing a car that is still in the race: the leader stays the same", gap.length === 0, `${gap.length} frames apart, first ${gap[0]}`);
}

console.log("Multiplayer: the official result");
{
  type Result = Extract<ControlMessage, { type: "result" }>;
  type Finish = Extract<ControlMessage, { type: "finish" }>;
  const lightsOut = start.lightsStartHostMs + 5000 + start.holdMs;
  const pkt = (id: string, dist: number): InterpolatedPeerState =>
    ({ peerId: id, driverCode: id.toUpperCase().slice(0, 3), teamColorHex: "#000", speedKmh: 100, position: new THREE.Vector3(), name: id, race: { id: "race-1", dist, fin: null, best: null } }) as unknown as InterpolatedPeerState;

  // A guest: its own classification until the result comes, then the official one
  const g = new MultiplayerRace(start, L, "me", { name: "Me", code: "MEE", color: "#00ff00" }, roster);
  const sent: Finish[] = [];
  g.onFinish = (f) => sent.push(f);
  g.lapClock.reset(L - 20);
  g.ingestPeers([pkt("host", 2 * L + 10), pkt("other", L)], 1);
  g.lapClock.distM = 2 * L + 1;
  g.lapClock.finishTimeS = 200;
  g.lapClock.finishLaps = 2;
  g.penaltyS = 5;
  const own = g.status(g.frame(lightsOut + 200_000), 50);
  check("at the flag the finish is sent, race time without the penalty", sent.length === 1 && sent[0].timeS === 200 && sent[0].penaltyS === 5 && sent[0].laps === 2 && sent[0].id === "race-1");
  check("until a result comes, the game's own classification, with grid places", own.resultsOfficial === false && own.results?.find((r) => r.isPlayer)?.gridPosition === 2, JSON.stringify(own.results?.map((r) => r.gridPosition)));
  g.status(g.frame(lightsOut + 202_000), 50);
  g.status(g.frame(lightsOut + 206_000), 50);
  check("sent again every few seconds while no result has it", sent.length === 2);
  const rows = (final: boolean): Result["rows"] => [
    { peer: "host", position: 1, timeS: 190, penaltyS: 0, laps: 2, bestLapMs: 90_000, dnf: false, grid: 1 },
    { peer: "me", position: 2, timeS: 205, penaltyS: 5, laps: 2, bestLapMs: null, dnf: false, grid: 2 },
    { peer: "other", position: 3, timeS: null, penaltyS: 0, laps: 1, bestLapMs: null, dnf: final, grid: 3 },
  ];
  g.applyResult({ type: "result", id: "race-1", final: false, rows: rows(false) });
  const prov = g.status(g.frame(lightsOut + 212_000), 50);
  check("then the official result, not yet final", prov.resultsOfficial === true && prov.resultsFinal === false && prov.results?.[0].name === "host" && prov.position === 2);
  check("its times and gaps with the penalty in, names from the field, grid places from it", prov.results?.[1].finishTimeS === 205 && prov.results[1].gapS === 15 && prov.results[1].gridPosition === 2 && prov.results[0].gridPosition === 1, JSON.stringify(prov.results?.[1]));
  check("and the finish is not sent again once the result has it", sent.length === 2);
  g.applyResult({ type: "result", id: "race-1", final: true, rows: rows(true) });
  g.applyResult({ type: "result", id: "race-1", final: false, rows: rows(false).reverse() });
  g.applyResult({ type: "result", id: "race-9", final: true, rows: [] });
  const fin = g.status(g.frame(lightsOut + 300_000), 50);
  check("a final result stands: not replaced by a provisional one or another race's", fin.resultsFinal === true && fin.results?.[0].name === "host" && fin.results[2].dnf === true);

  // A room: the host keeps the book; a guest's finish reaches it, the result reaches the guest
  const hostRace = new MultiplayerRace(start, L, "host", { name: "Host", code: "HST", color: "#f00" }, roster);
  const guest = new MultiplayerRace(start, L, "me", { name: "Me", code: "MEE", color: "#0f0" }, roster);
  const out: Result[] = [];
  hostRace.collectResults((r) => {
    out.push(r);
    guest.applyResult(r);
  });
  guest.onFinish = (f) => hostRace.takeFinish("me", f);
  hostRace.frame(lightsOut + 150_000);
  hostRace.takeFinish("me", { type: "finish", id: "race-1", timeS: 140, penaltyS: 0, laps: 2, bestLapMs: null });
  check("the host refuses a finish from a car it never heard in the race", out.length === 0);
  hostRace.ingestPeers([pkt("me", L), pkt("other", L)], 10);
  hostRace.takeFinish("me", { type: "finish", id: "race-1", timeS: 20, penaltyS: 0, laps: 2, bestLapMs: null });
  check("and one faster than a lap can be driven", out.length === 0);
  hostRace.lapClock.reset(L - 10);
  hostRace.lapClock.distM = 2 * L + 5;
  hostRace.lapClock.finishTimeS = 145;
  hostRace.lapClock.finishLaps = 2;
  hostRace.status(hostRace.frame(lightsOut + 146_000), 50);
  check("the host's own finish goes in its book, the result to everyone", out.length === 1 && !out[0].final && out[0].rows[0].peer === "host");
  guest.lapClock.reset(L - 20);
  guest.lapClock.distM = 2 * L + 2;
  guest.lapClock.finishTimeS = 150;
  guest.lapClock.finishLaps = 2;
  guest.status(guest.frame(lightsOut + 150_000), 50);
  check("a guest's finish reaches the host", out.length === 2 && out[1].rows[1].peer === "me" && out[1].rows[1].timeS === 150);
  hostRace.status(hostRace.frame(lightsOut + 200_000), 50);
  check("not final while a car is still out and 90 s have not passed", out.every((r) => !r.final));
  const closed = hostRace.status(hostRace.frame(lightsOut + 241_000), 50);
  const last = out[out.length - 1];
  check("final 90 s after the first finish, the car still out DNF", last.final && last.rows[2].peer === "other" && last.rows[2].dnf && last.rows[2].laps === 1, JSON.stringify({ n: out.length, final: last.final, rows: last.rows }));
  check("the host shows it too, and the guest has it", closed.resultsOfficial === true && closed.resultsFinal === true && guest.status(guest.frame(lightsOut + 241_000), 50).resultsFinal === true);
}

const gaps = new GapTimer();
gaps.record(10, [100]);
gaps.record(12, [150, 100]);
check("gap is the time since the leader passed", Math.abs(gaps.gapS(12, 100, 50) - 2) < 1e-9);

console.log(`\n${passed} checks passed`);
