/**
 * Checks the in-race broadcast's pure logic (`src/lib/broadcast/`): the event cards read off successive race standings
 * (winner, new leader after the first lap and held a moment, a new fastest lap from a car's second lap on, a pit stop
 * with its stationary time and tyres, a retirement; nothing from the first frame, the lights or a rewind), their queue
 * (one at a time, the most important first, a newer one of the same news replacing the waiting one, held while race
 * control speaks, old news dropped), the battle forecast (two laps of history, attacking, closing with the laps to
 * catch, pulling away, stable), the battle picked (the player's own first, else the closest in the top ten, on and off,
 * another one next, over when the two part), the player's pit stop on their own line, and the towers' pit clock.
 * Run: npx tsx scripts/verify-race-broadcast.ts
 */
import type { PitTelemetry, RaceStandingEntry, RaceStatus } from "../src/types/f1";
import {
  BroadcastCardQueue,
  CARD_GAP_MS,
  CARD_MS,
  CARD_STALE_MS,
  LEAD_HOLD_MS,
  RaceEventDetector,
  type RaceEvent,
} from "../src/lib/broadcast/race-events";
import {
  ATTACK_GAP_S,
  BATTLE_OFF_MS,
  BATTLE_ON_MS,
  BATTLE_SETTLE_MS,
  BattleTracker,
  battleForecast,
} from "../src/lib/broadcast/battle";
import { withPlayerPit } from "../src/lib/broadcast/player-pit";
import { pitGapText } from "../src/components/hud/pit-clock";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const LAP_M = 4000;
type Car = Partial<RaceStandingEntry> & { driverCode: string };
const car = (c: Car): RaceStandingEntry => ({
  teamColorHex: "#336699",
  isPlayer: false,
  lap: 1,
  gapToLeaderS: 0,
  ...c,
});
/** A frame: the cars in running order, with their race distance from the lap they are on unless given */
function frame(cars: Car[], extra: Partial<RaceStatus> = {}): RaceStatus {
  const standings = cars.map((c) => car({ raceDistM: (c.lap ?? 1) * LAP_M - LAP_M / 2, ...c }));
  return { phase: "racing", lightsOn: 0, position: 1, fieldSize: standings.length, lap: standings[0]?.lap ?? 1, totalLaps: 10, standings, ...extra };
}
const kinds = (es: RaceEvent[]) => es.map((e) => e.kind).join(",");

// --- Event detector -------------------------------------------------------------------------------------------
console.log("events");
{
  const d = new RaceEventDetector();
  const base: Car[] = [
    { driverCode: "AAA", lap: 1 },
    { driverCode: "BBB", lap: 1 },
    { driverCode: "CCC", lap: 1, isPlayer: true },
  ];
  check("the lights: nothing", d.update(frame(base, { phase: "lights" }), 0).length === 0);
  check("the first frame read: nothing (a baseline)", d.update(frame(base), 0).length === 0);
  // Lead change on lap 1: unannounced
  check(
    "a lead change on the first lap: no card",
    d.update(frame([{ driverCode: "BBB", lap: 1 }, { driverCode: "AAA", lap: 1 }, base[2]]), 100).length === 0
  );
  check(
    "…nor once it has been held",
    d.update(frame([{ driverCode: "BBB", lap: 1 }, { driverCode: "AAA", lap: 1 }, base[2]]), 100 + LEAD_HOLD_MS + 10).length === 0
  );
  // Lap 2: AAA takes it back
  const lap2 = (lead: string, other: string): Car[] => [
    { driverCode: lead, lap: 2 },
    { driverCode: other, lap: 2 },
    { driverCode: "CCC", lap: 2, isPlayer: true },
  ];
  check("a new leader on lap 2: not at once", d.update(frame(lap2("AAA", "BBB")), 5000).length === 0);
  check("…nor if the lead swaps straight back", d.update(frame(lap2("BBB", "AAA")), 5200).length === 0);
  check("…the same leader again: nothing", d.update(frame(lap2("BBB", "AAA")), 5200 + LEAD_HOLD_MS + 10).length === 0);
  d.update(frame(lap2("AAA", "BBB")), 8000);
  const lead = d.update(frame(lap2("AAA", "BBB")), 8000 + LEAD_HOLD_MS);
  check("a new leader held a moment: the card, with the lap", kinds(lead) === "newLeader" && lead[0].code === "AAA" && lead[0].lap === 2, JSON.stringify(lead));
  check("…once", d.update(frame(lap2("AAA", "BBB")), 8000 + LEAD_HOLD_MS + 500).length === 0);
}
{
  // Fastest laps
  const d = new RaceEventDetector();
  const f = (a: number | null, b: number | null, lapA = 2, lapB = 2) =>
    frame([
      { driverCode: "AAA", lap: lapA, bestLapMs: a },
      { driverCode: "BBB", lap: lapB, bestLapMs: b },
    ]);
  d.update(f(null, null, 1, 1), 0);
  check("the race's first lap time: no card", d.update(f(95000, null), 100).length === 0);
  check("a quicker lap on a car's first lap: no card", d.update(f(95000, 94500), 200).length === 0);
  const fl = d.update(f(94000, 94500, 3, 2), 300);
  check("a new fastest lap from a car's second lap on: the card with the time", kinds(fl) === "fastestLap" && fl[0].code === "AAA" && fl[0].lapMs === 94000);
  check("…not again for the same lap", d.update(f(94000, 94500, 3, 3), 400).length === 0);
  check("a lap slower than the fastest: nothing", d.update(f(94000, 94200, 3, 3), 500).length === 0);
  const fl2 = d.update(f(94000, 93800, 4, 4), 600);
  check("beaten: the new holder's card", kinds(fl2) === "fastestLap" && fl2[0].code === "BBB");
}
{
  // Pit stops and retirements
  const d = new RaceEventDetector();
  const f = (b: Partial<RaceStandingEntry>) =>
    frame([
      { driverCode: "AAA", lap: 4 },
      { driverCode: "BBB", lap: 4, compound: "medium", ...b },
    ]);
  d.update(f({}), 0);
  check("into the lane: nothing", d.update(f({ inPit: true }), 100).length === 0);
  check("in the box: nothing yet", d.update(f({ inPit: true, pitBox: { elapsedS: 1.1, totalS: 2.6 } }), 200).length === 0);
  d.update(f({ inPit: true, pitBox: { elapsedS: 2.5, totalS: 2.6 } }), 300);
  const pit = d.update(f({ inPit: true, pitStops: 1, compound: "hard" }), 400);
  check(
    "the crew done: the pit stop's card with its stationary time and the new tyres",
    kinds(pit) === "pitStop" && pit[0].code === "BBB" && pit[0].stationaryS === 2.6 && pit[0].compound === "hard",
    JSON.stringify(pit)
  );
  check("…once", d.update(f({ inPit: true, pitStops: 1, compound: "hard" }), 500).length === 0);
  const second = d.update(f({ pitStops: 2, compound: "soft" }), 600);
  check("a stop not seen in the box: the card without a time", kinds(second) === "pitStop" && second[0].stationaryS === undefined);
  const out = d.update(f({ pitStops: 2, retired: true }), 700);
  check("a car out of the race: the retirement's card", kinds(out) === "retired" && out[0].code === "BBB");
  check("…once", d.update(f({ pitStops: 2, retired: true }), 800).length === 0);
  const dq = new RaceEventDetector();
  dq.update(frame([{ driverCode: "AAA", lap: 3 }, { driverCode: "ME", lap: 3, isPlayer: true }]), 0);
  check(
    "a disqualification: race control's call, no card",
    dq.update(frame([{ driverCode: "AAA", lap: 3 }, { driverCode: "ME", lap: 3, isPlayer: true, retired: true, dq: true }]), 100).length === 0
  );
}
{
  // The winner, and nothing after the flag
  const d = new RaceEventDetector();
  d.update(frame([{ driverCode: "AAA", lap: 10 }, { driverCode: "BBB", lap: 10 }]), 0);
  const win = d.update(frame([{ driverCode: "AAA", lap: 10, finished: true }, { driverCode: "BBB", lap: 10 }]), 100);
  check("the first car over the line: the winner's card", kinds(win) === "winner" && win[0].code === "AAA");
  check("the second over the line: no other winner", d.update(frame([{ driverCode: "AAA", lap: 10, finished: true }, { driverCode: "BBB", lap: 10, finished: true }]), 200).length === 0);
  d.update(frame([{ driverCode: "BBB", lap: 10, finished: true }, { driverCode: "AAA", lap: 10, finished: true }]), 300);
  check(
    "after the flag the order changing is no new leader",
    d.update(frame([{ driverCode: "BBB", lap: 10, finished: true }, { driverCode: "AAA", lap: 10, finished: true }]), 300 + LEAD_HOLD_MS + 10).length === 0
  );
  const late = new RaceEventDetector();
  check("read first after the flag: no winner's card", late.update(frame([{ driverCode: "AAA", lap: 10, finished: true }]), 0).length === 0);
}
{
  // A rewind (Flashback) starts the reading over
  const d = new RaceEventDetector();
  d.update(frame([{ driverCode: "AAA", lap: 5, raceDistM: 18000 }, { driverCode: "BBB", lap: 5, raceDistM: 17950 }]), 0);
  const back = d.update(
    frame([
      { driverCode: "BBB", lap: 5, raceDistM: 17500, pitStops: 1 },
      { driverCode: "AAA", lap: 5, raceDistM: 17490, retired: true },
    ]),
    100
  );
  check("a rewind: nothing from the jump", back.length === 0, kinds(back));
  check(
    "…and the leader it rewound to is not new",
    d.update(frame([{ driverCode: "BBB", lap: 5, raceDistM: 17520, pitStops: 1 }, { driverCode: "AAA", lap: 5, raceDistM: 17500, retired: true }]), 100 + LEAD_HOLD_MS + 10).length === 0
  );
}

// --- Card queue -----------------------------------------------------------------------------------------------
console.log("queue");
{
  const ev = (kind: RaceEvent["kind"], code: string, extra: Partial<RaceEvent> = {}): RaceEvent => ({ kind, code, color: "#123456", isPlayer: false, ...extra });
  const q = new BroadcastCardQueue();
  check("nothing waiting: no card", q.current(0) === null);
  q.push([ev("pitStop", "AAA"), ev("fastestLap", "BBB", { lapMs: 90000 }), ev("retired", "CCC")], 0);
  const first = q.current(0);
  check("the most important first (a retirement over a fastest lap over a pit stop)", first?.event.kind === "retired");
  q.push([ev("winner", "DDD")], 100);
  check("one at a time: the card on screen plays out", q.current(CARD_MS - 1)?.event.kind === "retired");
  check("…then a pause", q.current(CARD_MS) === null && q.current(CARD_MS + CARD_GAP_MS - 1) === null);
  check("…then the next most important (the winner jumps the queue)", q.current(CARD_MS + CARD_GAP_MS)?.event.kind === "winner");
  const t = 2 * CARD_MS + 2 * CARD_GAP_MS;
  q.current(2 * CARD_MS + CARD_GAP_MS);
  q.push([ev("fastestLap", "EEE", { lapMs: 89000 })], t - 50);
  check("a newer fastest lap replaces the one waiting", q.pending === 2 && q.current(t)?.event.code === "EEE");
  const h = new BroadcastCardQueue();
  h.push([ev("newLeader", "AAA")], 0);
  check("race control speaking: no new card", h.current(0, true) === null);
  check("…it shows once race control is done", h.current(1000, false)?.event.code === "AAA");
  h.push([ev("pitStop", "BBB")], 1500);
  check("a card already up plays out under race control", h.current(2000, true)?.event.code === "AAA");
  const stale = new BroadcastCardQueue();
  stale.push([ev("pitStop", "AAA"), ev("winner", "BBB")], 0);
  check("old news is dropped, a winner never", stale.current(CARD_STALE_MS + 1, true) === null && stale.pending === 1);
  check("…the winner still shows", stale.current(CARD_STALE_MS + 2)?.event.kind === "winner");
  const many = new BroadcastCardQueue();
  many.push(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((c) => ev("pitStop", c)), 0);
  many.push([ev("retired", "GGG")], 10);
  check("too many waiting: the least important go", many.pending === 6 && many.current(20)?.event.kind === "retired");
}

// --- Battle forecast ------------------------------------------------------------------------------------------
console.log("forecast");
{
  check("one lap of history: no forecast (the gap only)", battleForecast([1.2, 0.9], 0.9, 10) === null);
  check("within the attack gap: attacking", battleForecast([0.6, 0.45, 0.32], ATTACK_GAP_S - 0.05, 10)?.kind === "attacking");
  const closing = battleForecast([1.64, 1.32, 1.0], 1.0, 10);
  check(
    "closing 0.32 s a lap from 1.0 s: catch in 3 laps",
    closing?.kind === "closing" && near(closing.rateS, 0.32, 1e-9) && closing.catchLaps === 3,
    JSON.stringify(closing)
  );
  const late = battleForecast([1.64, 1.32, 1.0], 1.0, 2);
  check("…with 2 laps left: closing, no catch promised", late?.kind === "closing" && late.catchLaps === null);
  check("opening: pulling away", battleForecast([0.4, 0.6, 0.85], 0.85, 10)?.kind === "pullingAway");
  check("moving under 0.05 s a lap: stable", battleForecast([0.7, 0.72, 0.69], 0.7, 10)?.kind === "stable");
  const noisy = battleForecast([1.2, 0.9, 1.05, 0.7], 0.7, 10);
  check("the trend over the last laps, not one lap's noise", noisy?.kind === "closing" && noisy.rateS > 0.1 && noisy.rateS < 0.2, JSON.stringify(noisy));
}

// --- Battle picked ---------------------------------------------------------------------------------------------
console.log("battle");
{
  // Five cars: P2-P3 within 0.4 s, the player (P5) 0.8 s behind P4
  const field = (lap: number, gaps: number[], playerAt = 4, extra: Record<number, Partial<RaceStandingEntry>> = {}): RaceStatus =>
    frame(
      gaps.map((g, i) => ({
        driverCode: ["AAA", "BBB", "CCC", "DDD", "ME"][i],
        isPlayer: i === playerAt,
        lap,
        intervalS: i === 0 ? undefined : g,
        gapToLeaderS: gaps.slice(1, i + 1).reduce((a, b) => a + b, 0),
        ...extra[i],
      }))
    );
  const b = new BattleTracker();
  check("the first lap: no battle (the start is everyone's)", b.update(field(1, [0, 2, 0.4, 3, 0.8]), 0) === null);
  check("close, but not for long enough yet", b.update(field(2, [0, 2, 0.4, 3, 0.8]), 1000) === null);
  const v = b.update(field(2, [0, 2, 0.4, 3, 0.8]), 1000 + BATTLE_SETTLE_MS);
  check("the player's own battle first (for P4), not the closer one ahead", v?.position === 4 && v.behind.isPlayer && near(v.gapS, 0.8), JSON.stringify(v && { p: v.position, g: v.gapS }));
  check("…the gap only, no forecast yet", v?.forecast === null);
  const on = 1000 + BATTLE_SETTLE_MS;
  check("on for its time", b.update(field(2, [0, 2, 0.4, 3, 0.75]), on + BATTLE_ON_MS - 1)?.position === 4);
  check("…then off", b.update(field(2, [0, 2, 0.4, 3, 0.75]), on + BATTLE_ON_MS) === null);
  check("…for its pause", b.update(field(2, [0, 2, 0.4, 3, 0.75]), on + BATTLE_ON_MS + BATTLE_OFF_MS - 1) === null);
  const again = b.update(field(2, [0, 2, 0.4, 3, 0.75]), on + BATTLE_ON_MS + BATTLE_OFF_MS);
  check("…and the player's own again while it lasts", again?.position === 4 && again.id === 2);

  // Without the player in one: the closest in the top ten, then another
  const c = new BattleTracker();
  const noPlayer = (t: number, lap: number, g: number[]) => c.update(field(lap, g, 4), t);
  noPlayer(0, 2, [0, 0.9, 0.4, 3, 5]);
  const p = noPlayer(BATTLE_SETTLE_MS, 2, [0, 0.9, 0.4, 3, 5]);
  check("no battle of the player's: the closest (for P2)", p?.position === 2 && p.ahead.driverCode === "BBB", JSON.stringify(p && p.position));
  noPlayer(BATTLE_SETTLE_MS + BATTLE_ON_MS, 2, [0, 0.9, 0.4, 3, 5]);
  const next = noPlayer(BATTLE_SETTLE_MS + BATTLE_ON_MS + BATTLE_OFF_MS, 2, [0, 0.9, 0.4, 3, 5]);
  check("…then another battle (for P1)", next?.position === 1, JSON.stringify(next && next.position));
  const t0 = BATTLE_SETTLE_MS + BATTLE_ON_MS + BATTLE_OFF_MS;
  check("a battle whose cars part is over early", noPlayer(t0 + 1000, 2, [0, 2.5, 0.4, 3, 5]) === null);

  // The forecast from the lap lines while the pair stays together
  const f = new BattleTracker();
  const gapsAt = [1.64, 1.32, 1.0];
  let shown = null as ReturnType<BattleTracker["update"]>;
  for (let lap = 2, t = 0; lap <= 5; lap++) {
    const g = gapsAt[Math.min(lap - 3, 2)] ?? 1.9;
    // Mid-lap frames, then the lap line
    for (let k = 0; k < 4; k++, t += 1000) shown = f.update(field(lap, [0, 5, 6, 7, g], 4), t);
  }
  check("two laps of history: the forecast (closing, catch in 3)", shown?.forecast?.kind === "closing" && shown.forecast.catchLaps === 3, JSON.stringify(shown?.forecast));
  const pitted = f.update(field(5, [0, 5, 6, 7, 1.0], 4, { 3: { inPit: true } }), 20000);
  check("a car of the battle into the pits: it ends", pitted === null);
}

// --- The player's pit stop ------------------------------------------------------------------------------------
console.log("player pit");
{
  const race = frame([{ driverCode: "AAA", lap: 4 }, { driverCode: "ME", lap: 4, isPlayer: true, compound: "medium" }]);
  const pit = (p: Partial<PitTelemetry>): PitTelemetry => ({
    phase: "lane",
    limiterOn: true,
    limiterAuto: true,
    limitKmh: 60,
    overLimit: false,
    speedingCount: 0,
    toBoxM: null,
    boxSideM: null,
    boxIndex: 0,
    serviceLeftS: 0,
    serviceTotalS: 0,
    tyreS: 0,
    repairS: 0,
    damage: 0,
    strategy: { nextCompound: "hard", repairDamage: true, boxRequested: false },
    stopsMade: 0,
    stopsRequired: 1,
    ...p,
  });
  check("no stop yet: the standing as it was", withPlayerPit(race, pit({})) === race);
  const box = withPlayerPit(race, pit({ phase: "servicing", serviceTotalS: 2.8, serviceLeftS: 1.0 }))!;
  const me = box.standings[1];
  check("the crew at work: the clock on the player's line", me.pitBox !== undefined && near(me.pitBox.elapsedS, 1.8) && me.pitBox.totalS === 2.8);
  check("…the race's own standing untouched", race.standings[1].pitBox === undefined);
  const done = withPlayerPit(race, pit({ phase: "released", stopsMade: 1, serviceTotalS: 2.8 }))!.standings[1];
  check("released: the stop counted, the fitted tyres shown", done.pitStops === 1 && done.pitBox === undefined && done.compound === "hard");
  check("online: never", withPlayerPit({ ...race, multiplayer: true }, pit({ phase: "servicing", serviceTotalS: 2 })) !== undefined && withPlayerPit({ ...race, multiplayer: true }, pit({ phase: "servicing", serviceTotalS: 2 }))!.standings[1].pitBox === undefined);
  // Through the detector: the player's own stop is a card too
  const d = new RaceEventDetector();
  d.update(withPlayerPit(race, pit({}))!, 0);
  d.update(withPlayerPit(race, pit({ phase: "servicing", serviceTotalS: 2.8, serviceLeftS: 0.4 }))!, 100);
  const ev = d.update(withPlayerPit(race, pit({ phase: "released", stopsMade: 1, serviceTotalS: 2.8 }))!, 200);
  check("the player's stop: its card, with the crew's time and the tyres fitted", kinds(ev) === "pitStop" && ev[0].isPlayer && ev[0].stationaryS === 2.8 && ev[0].compound === "hard", JSON.stringify(ev));
}

// --- The towers' pit clock ------------------------------------------------------------------------------------
console.log("pit clock");
{
  const clock = (seconds: string) => `PIT ${seconds}`;
  const row = (e: Partial<RaceStandingEntry>) => pitGapText(car({ driverCode: "AAA", ...e }), "PIT", clock);
  check("in the box: the crew's live clock", row({ inPit: true, pitBox: { elapsedS: 2.34, totalS: 3 } }) === "PIT 2.3");
  check("in the lane: the word alone", row({ inPit: true }) === "PIT");
  check("on the track: the gap as ever", row({}) === null);
  check("out of the race or past the flag: their own words", row({ inPit: true, retired: true }) === null && row({ inPit: true, finished: true }) === null);
}

console.log(`\n${passed} checks passed`);
