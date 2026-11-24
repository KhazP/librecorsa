/**
 * Checks the AI field's tyre calls as the weather changes (`src/lib/sim/pit/ai-weather-tyres.ts`): the thresholds on
 * the racing line's water and their hysteresis against the wet-tyre model's own crossovers, each driver's spread, the
 * calls told in running order (the leader first), no weather stop for a while after a stop nor on the last lap, a line
 * hovering inside the band calling no stops, the pit entry one car at a time (and none turned away twice), the stop's
 * tyres, a flashback, and the same calls for the same seed.
 * Run: npx tsx scripts/verify-ai-weather-tyres.ts
 */
import {
  AiWeatherTyres,
  CALL_CONFIRM_S,
  CALL_JITTER_S,
  ENTRY_GAP_S,
  ENTRY_MIN_S,
  INTER_OFF_MM,
  INTER_ON_MM,
  MIN_STINT_S,
  pitEntryOpen,
  POSITION_STAGGER_S,
  stintLongEnough,
  tyreKind,
  weatherCallDelayS,
  weatherTyreKind,
  weatherTyreThresholds,
  WET_OFF_MM,
  WET_ON_MM,
  type WeatherTyreCar,
} from "../src/lib/sim/pit/ai-weather-tyres";
import { LOW_GRIP_DECLARED_MM, recommendedCompound, WET_TYRE_TRAITS, wetGripFactor } from "../src/lib/sim/wet-tyres";
import type { TireCompound } from "../src/types/f1";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
}
const f3 = (v: number) => v.toFixed(3);

// --- Thresholds ------------------------------------------------------------------------------------------------
console.log("thresholds");
{
  const base = weatherTyreThresholds(0);
  check(
    "the field's own thresholds are the player's auto compound's (recommendedCompound) going in",
    base.interOnMm === LOW_GRIP_DECLARED_MM &&
      INTER_ON_MM === LOW_GRIP_DECLARED_MM &&
      base.wetOnMm === WET_ON_MM &&
      recommendedCompound(WET_ON_MM + 0.01) === "wet" &&
      recommendedCompound(WET_ON_MM - 0.01) === "intermediate" &&
      recommendedCompound(INTER_ON_MM + 0.001) === "intermediate" &&
      recommendedCompound(INTER_ON_MM - 0.001) === "medium",
    `${base.interOnMm} / ${base.wetOnMm} mm`
  );
  const bold = weatherTyreThresholds(1);
  const cautious = weatherTyreThresholds(-1);
  check(
    "every driver keeps a hysteresis band: coming off waits for less water than going on, whatever their nerve",
    bold.interOffMm < cautious.interOnMm && bold.wetOffMm < cautious.wetOnMm && INTER_OFF_MM < INTER_ON_MM && WET_OFF_MM < WET_ON_MM,
    `slick ⇄ inter ${f3(cautious.interOnMm)}–${f3(bold.interOnMm)} on, ${f3(cautious.interOffMm)}–${f3(bold.interOffMm)} off`
  );
  check(
    "a bold driver goes onto rain tyres later and comes off them sooner",
    bold.interOnMm > base.interOnMm && cautious.interOnMm < base.interOnMm && bold.interOffMm > cautious.interOffMm,
    `${f3(cautious.interOnMm)} < ${f3(base.interOnMm)} < ${f3(bold.interOnMm)}`
  );
  const grip = (c: TireCompound, mm: number, v: number) => WET_TYRE_TRAITS[c].dryGrip * wetGripFactor(WET_TYRE_TRAITS[c], mm, v);
  let crossover = NaN;
  for (let mm = 0.001; mm < 1; mm += 0.001) {
    if (grip("intermediate", mm, 40) > grip("medium", mm, 40)) {
      crossover = mm;
      break;
    }
  }
  check(
    "the slick ⇄ intermediate crossover of the wet-tyre model lies inside every driver's band",
    crossover > bold.interOffMm && crossover < cautious.interOnMm,
    `crossover ${f3(crossover)} mm in (${f3(bold.interOffMm)}, ${f3(cautious.interOnMm)})`
  );
  check(
    "intermediates are the better tyre below every driver's way off full wets, at cornering speeds (to 216 km/h)",
    [25, 40, 60].every((v) => grip("intermediate", bold.wetOffMm, v) > grip("wet", bold.wetOffMm, v)),
    `at ${f3(bold.wetOffMm)} mm`
  );
  check(
    "full wets go on where intermediates fall behind at speed (aquaplaning); a cautious driver a little before",
    grip("wet", WET_ON_MM, 60) > grip("intermediate", WET_ON_MM, 60) &&
      grip("wet", cautious.wetOnMm, 75) > grip("intermediate", cautious.wetOnMm, 75) &&
      grip("wet", cautious.wetOnMm, 60) > grip("intermediate", cautious.wetOnMm, 60) * 0.95,
    `${WET_ON_MM} mm at 216 km/h; ${f3(cautious.wetOnMm)} mm at 270 km/h`
  );
}

console.log("hysteresis");
{
  const th = weatherTyreThresholds(0);
  const k = (mm: number, from: Parameters<typeof weatherTyreKind>[1]) => weatherTyreKind(mm, from, th);
  check("slicks stay on just under the call, intermediates go on past it", k(0.13, "slick") === "slick" && k(0.15, "slick") === "intermediate");
  check("intermediates stay on inside the band, slicks go back on under it", k(0.11, "intermediate") === "intermediate" && k(0.1, "intermediate") === "intermediate" && k(0.08, "intermediate") === "slick");
  check("standing water calls full wets from either", k(1.2, "slick") === "wet" && k(1.2, "intermediate") === "wet");
  check("full wets stay on down to 0.8 mm, then intermediates, then slicks", k(0.9, "wet") === "wet" && k(0.7, "wet") === "intermediate" && k(0.05, "wet") === "slick");
  check("no water, or none known, is dry", k(0, "intermediate") === "slick" && k(NaN, "wet") === "slick" && k(-1, "slick") === "slick");
  check("every compound has its kind", tyreKind("soft") === "slick" && tyreKind("hard") === "slick" && tyreKind("intermediate") === "intermediate" && tyreKind("wet") === "wet");
}

// --- Timing ----------------------------------------------------------------------------------------------------
console.log("timing");
{
  check(
    "the leader is told first, each place after the one ahead whatever their own spread",
    weatherCallDelayS(0, 1) < weatherCallDelayS(1, 0) && weatherCallDelayS(4, 1) < weatherCallDelayS(5, 0) && CALL_JITTER_S < POSITION_STAGGER_S,
    `leader ${weatherCallDelayS(0, 0)}–${weatherCallDelayS(0, 1)} s, P2 ${weatherCallDelayS(1, 0)} s`
  );
  check("a call stands a few seconds before anyone is told", weatherCallDelayS(0, 0) === CALL_CONFIRM_S && CALL_CONFIRM_S >= 3);
  check("a stint is long enough after two laps or the time", !stintLongEnough(60, 1) && stintLongEnough(60, 2) && stintLongEnough(MIN_STINT_S, 0) && stintLongEnough(Infinity, -Infinity));
}

/** Steps a field of `n` cars (ids P1…, rank = index) through `waterAt(t)`; returns the time each car was first due */
function firstDue(
  wt: AiWeatherTyres,
  n: number,
  waterAt: (t: number) => number,
  untilS: number,
  over: Partial<WeatherTyreCar> = {},
  compound: TireCompound = "medium"
): (number | null)[] {
  const due: (number | null)[] = new Array(n).fill(null);
  for (let t = 0; t <= untilS; t += 0.25) {
    for (let i = 0; i < n; i++) {
      const call = wt.update(t, waterAt(t), { id: `P${i + 1}`, compound, rank: i, lapsDone: 3, lapsLeft: 10, racing: true, ...over });
      if (call.due && due[i] === null) due[i] = t;
    }
  }
  return due;
}

console.log("calls");
{
  // A shower that sets in at once: the calls go out in running order, a few seconds apart
  const wt = new AiWeatherTyres();
  wt.reset(42);
  const due = firstDue(wt, 10, (t) => (t < 5 ? 0 : 0.4), 120) as number[];
  const ordered = due.every((d, i) => d !== null && (i === 0 || d > due[i - 1]));
  const gaps = due.slice(1).map((d, i) => d - due[i]);
  check("a sudden shower: every car called, in running order, the leader first", ordered, due.map((d) => d.toFixed(2)).join(" "));
  check(
    "...each place at least a second after the one ahead, the field over more than 20 s",
    Math.min(...gaps) >= POSITION_STAGGER_S - CALL_JITTER_S - 0.25 && due[9] - due[0] > 20,
    `gaps ${Math.min(...gaps).toFixed(2)}–${Math.max(...gaps).toFixed(2)} s`
  );
  check("...told no sooner than the call has stood its time", due[0] >= 5 + CALL_CONFIRM_S - 0.25, `${due[0]} s`);

  // A slow shower: the drivers' own thresholds spread the calls further
  const slow = new AiWeatherTyres();
  slow.reset(42);
  const ramp = firstDue(slow, 10, (t) => 0.0003 * t, 1000) as number[];
  check(
    "a slow drizzle: every car called, spread over more than a lap by the drivers' own thresholds",
    ramp.every((d) => d !== null) && Math.max(...ramp) - Math.min(...ramp) > 60,
    `${Math.min(...ramp).toFixed(0)}–${Math.max(...ramp).toFixed(0)} s`
  );

  // Inside the band nothing happens, however long the line hovers there
  const hover = new AiWeatherTyres();
  hover.reset(7);
  const dueOnSlicks = firstDue(hover, 8, (t) => 0.112 + 0.009 * Math.sin(t / 7), 900);
  hover.reset(7);
  const dueOnInters = firstDue(hover, 8, (t) => 0.112 + 0.009 * Math.sin(t / 7), 900, {}, "intermediate");
  check("a line hovering between the thresholds calls no stop, on slicks or intermediates", dueOnSlicks.every((d) => d === null) && dueOnInters.every((d) => d === null));

  // Wrong tyre on, conditions turn back before its turn: the call goes, no stop
  const back = new AiWeatherTyres();
  back.reset(1);
  let changeInShower = false;
  let changeAfter = false;
  let sawDue = false;
  for (let t = 0; t < 120; t += 0.25) {
    const water = t < 20 ? 0.2 : 0.05;
    const call = back.update(t, water, { id: "P9", compound: "soft", rank: 8, lapsDone: 2, lapsLeft: 10, racing: true });
    if (t < 20 && call.change) changeInShower = true;
    if (t > 30 && call.change) changeAfter = true;
    if (call.due) sawDue = true;
  }
  check("a short shower that clears before the car's turn calls it off", changeInShower && !changeAfter && !sawDue);

  // Not on the last lap, not off the road, not again straight after a stop
  const last = new AiWeatherTyres();
  last.reset(3);
  check("no weather stop on the last lap", firstDue(last, 3, () => 0.4, 120, { lapsLeft: 1 }).every((d) => d === null));
  last.reset(3);
  check("no call is due while the car is not out racing (in the lane, spun)", firstDue(last, 3, () => 0.4, 120, { racing: false }).every((d) => d === null));
  const stint = new AiWeatherTyres();
  stint.reset(3);
  stint.update(0, 0, { id: "P1", compound: "medium", rank: 0, lapsDone: 4, lapsLeft: 10, racing: true });
  stint.noteStop("P1", 10, 4, "medium");
  let stintDue: number | null = null;
  for (let t = 10; t < 400 && stintDue === null; t += 0.25) {
    if (stint.update(t, 0.4, { id: "P1", compound: "medium", rank: 0, lapsDone: 4, lapsLeft: 10, racing: true }).due) stintDue = t;
  }
  check("a car that just stopped stays out until its stint is long enough", stintDue !== null && stintDue >= 10 + MIN_STINT_S, `due ${stintDue} s`);
  stint.reset(3);
  stint.update(0, 0, { id: "P1", compound: "medium", rank: 0, lapsDone: 4, lapsLeft: 10, racing: true });
  stint.noteStop("P1", 10, 4, "medium");
  const twoLaps = stint.update(30, 0.4, { id: "P1", compound: "medium", rank: 0, lapsDone: 6, lapsLeft: 8, racing: true });
  const later = stint.update(40, 0.4, { id: "P1", compound: "medium", rank: 0, lapsDone: 6, lapsLeft: 8, racing: true });
  check("...or two laps on (once the new call has stood its time)", !twoLaps.due && later.due && later.compound === "intermediate", `${40 - 10} s after the stop`);
}

console.log("tyres");
{
  const wt = new AiWeatherTyres();
  wt.reset(9);
  const car = (compound: TireCompound, t: number, water: number) => wt.update(t, water, { id: "HAM", compound, rank: 0, lapsDone: 3, lapsLeft: 10, racing: true });
  car("hard", 0, 0);
  check("dry, on its slick: no change, no stop tyres of the weather's", !car("hard", 1, 0).change && wt.stopCompound("HAM", "hard") === null);
  const wet = car("hard", 2, 0.3);
  check("wet on slicks: intermediates called; any stop fits them", wet.change && wet.compound === "intermediate" && wt.stopCompound("HAM", "hard") === "intermediate");
  wt.noteStop("HAM", 30, 3, "intermediate");
  car("intermediate", 31, 0.3);
  const dry = car("intermediate", 400, 0.02);
  check("dry again: back onto the slick it had", dry.change && dry.compound === "hard" && wt.stopCompound("HAM", "intermediate") === "hard");
  const flood = car("intermediate", 401, 1.6);
  check("standing water on intermediates: full wets", flood.change && flood.compound === "wet");
}

// --- Pit entry -------------------------------------------------------------------------------------------------
console.log("pit entry");
{
  check("cars into the lane one at a time, a few seconds apart", !pitEntryOpen(10 + ENTRY_GAP_S - 0.1, 10) && pitEntryOpen(10 + ENTRY_GAP_S, 10) && pitEntryOpen(0, -Infinity));
  check("one turned away before goes in unless side by side", pitEntryOpen(10 + ENTRY_MIN_S + 0.01, 10, true) && !pitEntryOpen(10 + ENTRY_MIN_S - 0.1, 10, true));
  check("a stop it cannot make later goes in regardless", pitEntryOpen(10.2, 10, false, true));
  const wt = new AiWeatherTyres();
  wt.reset(1);
  wt.noteEntry("A", 100);
  check("the class keeps the last car in", !wt.entryOpen("B", 101) && wt.entryOpen("B", 100 + ENTRY_GAP_S));
  wt.turnedAway("B", 101);
  check("turned away counts from the next time round, not the same pass", !wt.entryOpen("B", 101.6));
  wt.noteEntry("C", 200);
  check("...and then lets it in unless side by side", wt.entryOpen("B", 200 + ENTRY_MIN_S + 0.01) && !wt.entryOpen("B", 200 + ENTRY_MIN_S / 2));
  wt.noteEntry("B", 201);
  wt.noteEntry("D", 400);
  check("once in, it waits its turn again the next time", !wt.entryOpen("B", 401));

  // A pack nose to tail, all wanting in: arrivals at the turn-off each lap, the gate deciding
  const lapS = 90;
  // (a train in the tow, nose to tail: no two closer than ENTRY_MIN_S, as two cars are never side by side into the lane)
  const offsets = [0, 0.8, 1.7, 2.4, 3.1, 4.6, 5.2, 9, 9.6, 30, 31.1, 31.7];
  const gate = new AiWeatherTyres();
  gate.reset(5);
  const entered = new Map<number, number>();
  const passes = new Map<number, number>();
  const entryTimes: number[] = [];
  for (let lap = 0; lap < 6; lap++) {
    for (let i = 0; i < offsets.length; i++) {
      if (entered.has(i)) continue;
      const t = lap * lapS + offsets[i];
      passes.set(i, (passes.get(i) ?? 0) + 1);
      if (gate.entryOpen(`C${i}`, t)) {
        gate.noteEntry(`C${i}`, t);
        entered.set(i, t);
        entryTimes.push(t);
      } else gate.turnedAway(`C${i}`, t);
    }
  }
  entryTimes.sort((a, b) => a - b);
  const gaps = entryTimes.slice(1).map((t, i) => t - entryTimes[i]);
  check(
    "a pack nose to tail: every car in within two laps (none turned away twice), none side by side",
    entered.size === offsets.length && Math.max(...passes.values()) <= 2 && Math.min(...gaps) >= ENTRY_MIN_S,
    `passes ${[...passes.values()].join("")}, closest ${Math.min(...gaps).toFixed(1)} s`
  );
  check(
    "...the first time round each car in is the gap clear of the last",
    entryTimes.filter((t) => t < lapS).every((t, i, a) => i === 0 || t - a[i - 1] >= ENTRY_GAP_S),
    `${entryTimes.filter((t) => t < lapS).length} in on the first lap`
  );
}

// --- Determinism and flashbacks --------------------------------------------------------------------------------
console.log("seed and flashback");
{
  const a = new AiWeatherTyres();
  const b = new AiWeatherTyres();
  a.reset(1234);
  b.reset(1234);
  const ids = ["VER", "NOR", "LEC", "PIA", "HAM", "RUS"];
  const same = ids.every((id) => a.nerveOf(id) === b.nerveOf(id));
  b.reset(1235);
  const differs = ids.some((id) => a.nerveOf(id) !== b.nerveOf(id));
  check("the same seed gives every driver the same spread; another seed another", same && differs);
  const nerves = ids.map((id) => a.nerveOf(id));
  check("spreads cover bold and cautious", Math.min(...nerves) < -0.2 && Math.max(...nerves) > 0.2, nerves.map((v) => v.toFixed(2)).join(" "));
  const runA = new AiWeatherTyres();
  const runB = new AiWeatherTyres();
  runA.reset(77);
  runB.reset(77);
  const water = (t: number) => 0.25 * Math.max(0, Math.sin(t / 60));
  const dueA = firstDue(runA, 8, water, 400);
  const dueB = firstDue(runB, 8, water, 400);
  check("the same seed and conditions give the same calls", dueA.every((d, i) => d === dueB[i]), dueA.map((d) => d ?? "-").join(" "));

  const fb = new AiWeatherTyres();
  fb.reset(2);
  fb.update(0, 0, { id: "X", compound: "medium", rank: 0, lapsDone: 3, lapsLeft: 10, racing: true });
  fb.noteStop("X", 100, 3, "medium");
  fb.noteEntry("X", 95);
  fb.rewind(50);
  let dueAfter: number | null = null;
  for (let t = 50; t < 80 && dueAfter === null; t += 0.25) {
    if (fb.update(t, 0.4, { id: "X", compound: "medium", rank: 0, lapsDone: 3, lapsLeft: 10, racing: true }).due) dueAfter = t;
  }
  check("a flashback to before a stop forgets it (and the car in after it)", dueAfter !== null && fb.entryOpen("Y", 51), `due ${dueAfter} s`);
}

console.log(`\n${passed} checks passed`);
