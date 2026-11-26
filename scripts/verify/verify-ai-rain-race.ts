/**
 * A headless AI race through a passing shower on the page-side field (the sim worker runs the same field): the cars go
 * onto intermediates as the racing line gets wet and back onto slicks as it dries, through their pit stops
 * (`src/lib/sim/pit/ai-weather-tyres.ts`, `ai-pit.ts`). Checks that every car changes both ways and no more (no flip-flop),
 * that they come into the lane one at a time and none queues in it, that the wrong tyre is the slower one, that the
 * wet brings no rash of spins and crashes, that no car is penalised, and that the same seed runs the same race.
 *
 *   npx tsx scripts/verify/verify-ai-rain-race.ts [--track rwanda_official_short] [--car amg-gt3] [--cars 8] [--laps 12] [--seed 1] [--verbose]
 *
 * A circuit whose files are not in this checkout (a clone has only the RISE layouts) is skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from "../../src/lib/track-data";
import { vehicleModelSpec } from "../../src/lib/cars/vehicle-models";
import { aiDriversFor, AiOpponentField } from "../../src/lib/sim/ai-opponents";
import { TrackEnvironment } from "../../src/lib/sim/track-environment";
import { DEFAULT_SESSION_CONDITIONS, type WeatherNode } from "../../src/lib/sim/weather";
import { ENTRY_MIN_S, INTER_OFF_MM, INTER_ON_MM, tyreKind } from "../../src/lib/sim/pit/ai-weather-tyres";
import type { TireCompound, VehicleModelId } from "../../src/types/f1";
import { loadGlbGeometry } from "../lib/glb-geometry";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const verbose = argv.includes("--verbose");
const id = opt("track", "rwanda_official_short");
const carKind = opt("car", "amg-gt3") as VehicleModelId;
const nCars = Number(opt("cars", "8"));
const laps = Number(opt("laps", "12"));
const seed = Number(opt("seed", "1"));
const DT = 1 / 120;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const dataPath = `public/tracks/${id}/track_data.json`;
if (!existsSync(dataPath)) {
  console.log(`SKIP  ${id} (${dataPath} not in this checkout)`);
  process.exit(0);
}
setActiveTrack(id, JSON.parse(readFileSync(dataPath, "utf8")) as RawTrackJson);
const track = getActiveTrackData(1200);
if (!track.meshUrl || !existsSync(`public${track.meshUrl}`) || !track.pitLane) {
  console.log(`SKIP  ${id} (circuit model or pit lane not in this checkout)`);
  process.exit(0);
}
const root = loadGlbGeometry(`public${track.meshUrl}`);

// A shower over a quarter-hour forecast: dry, cloud, a storm's rain at half way, cloud, sun; the line dries behind it.
// The storm puts about 0.44 mm on the racing line, twice the call for intermediates, as heavy rain's 0.30 mm was
// twice the old 0.14 mm call: since the call moved to 0.2 mm, heavy rain kept the line over it for about two laps,
// mostly before the field could stop, and no car had a clean lap on intermediates in the wet
const node = (sky: WeatherNode["sky"], rainChance: number): WeatherNode => ({ sky, rainChance, temperatureC: 18, humidityPct: 70, windSpeedKmh: 10, windDirectionOctant: 2 });
const SHOWER = [node("mostly_cloudy", 0), node("overcast", 0), node("overcast_storm", 100), node("overcast", 0), node("partially_cloudy", 0)];

type Car = {
  code: string;
  label: string;
  isPlayer: boolean;
  pitStops: number;
  pitRun: unknown;
  sim: { tireCompound: TireCompound };
  clock: { lapsDone: number; lastCrossingLapMs: number | null };
  stats: { spins: number; offTracks: number; wallHits: number };
};
interface Entry {
  t: number;
  code: string;
  from: TireCompound;
  to?: TireCompound;
  water: number;
  /** Race time it left the lane (s) */
  outT?: number;
}
interface Lap {
  ms: number;
  kind: string;
  water: number;
  clean: boolean;
}
interface Run {
  entries: Entry[];
  laps: Lap[];
  maxInLane: number;
  stops: Map<string, number>;
  finalKind: Map<string, string>;
  incidents: number;
  penalised: number;
  retired: number;
  finished: boolean;
  peakWater: number;
  t: number;
}

function race(untilS = Infinity): Run {
  const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: "dynamic", seed, weatherNodes: SHOWER, weatherDurationS: 900 });
  const field = new AiOpponentField(track, vehicleModelSpec(carKind).createSim(track, root), aiDriversFor(nCars), env, {
    skill: 80,
    seed,
    learning: false,
    spectate: true,
    trackId: id,
    damage: "reduced",
  });
  field.raceLaps = laps;
  field.startRace(true);
  const cars = (field as unknown as { cars: Car[] }).cars.filter((c) => !c.isPlayer);
  const st = new Map(cars.map((c) => [c.code, { inPit: false, lapsDone: 0, pit: false, kinds: new Set<string>(), water: 0, n: 0 }]));
  const run: Run = { entries: [], laps: [], maxInLane: 0, stops: new Map(), finalKind: new Map(), incidents: 0, penalised: 0, retired: 0, finished: false, peakWater: 0, t: 0 };
  let t = 0;
  while (field.phase !== "finished" && t < Math.min(untilS, 60 + laps * 240)) {
    env.update(DT, field.sims());
    field.update(DT);
    t += DT;
    const water = env.weather.lineWaterMm;
    run.peakWater = Math.max(run.peakWater, water);
    let inLane = 0;
    for (const c of cars) {
      const s = st.get(c.code)!;
      const inPit = c.pitRun !== null;
      if (inPit) inLane++;
      if (inPit && !s.inPit) run.entries.push({ t, code: c.label, from: c.sim.tireCompound, water });
      if (!inPit && s.inPit) {
        const e = [...run.entries].reverse().find((x) => x.code === c.label);
        if (e) {
          e.to = c.sim.tireCompound;
          e.outT = t;
        }
      }
      s.inPit = inPit;
      if (inPit) s.pit = true;
      s.kinds.add(tyreKind(c.sim.tireCompound));
      s.water += water;
      s.n++;
      if (c.clock.lapsDone > s.lapsDone) {
        // A clean lap: a flying one (not the first), no stop in it, one kind of tyre throughout
        run.laps.push({ ms: c.clock.lastCrossingLapMs ?? 0, kind: [...s.kinds][0], water: s.water / Math.max(1, s.n), clean: s.lapsDone > 0 && !s.pit && s.kinds.size === 1 });
        s.lapsDone = c.clock.lapsDone;
        s.pit = inPit;
        s.kinds = new Set([tyreKind(c.sim.tireCompound)]);
        s.water = 0;
        s.n = 0;
      }
    }
    run.maxInLane = Math.max(run.maxInLane, inLane);
  }
  run.t = t;
  run.finished = field.phase === "finished";
  for (const c of cars) {
    run.stops.set(c.label, c.pitStops);
    run.finalKind.set(c.label, tyreKind(c.sim.tireCompound));
    run.incidents += c.stats.spins + c.stats.offTracks + c.stats.wallHits;
  }
  const rep = field.report();
  run.penalised = rep.cars.filter((c) => (c.penaltyS ?? 0) > 0).length;
  run.retired = rep.cars.filter((c) => c.retired).length;
  return run;
}

const started = Date.now();
const r = race();
console.log(`${id} · ${carKind} · ${laps} laps · ${nCars} cars · seed ${seed}: ${r.t.toFixed(0)} s raced in ${((Date.now() - started) / 1000).toFixed(0)} s, line water peaked at ${r.peakWater.toFixed(2)} mm`);
if (verbose) {
  r.entries.forEach((e, i) =>
    console.log(`      ${e.t.toFixed(1).padStart(7)} s ${i ? `+${(e.t - r.entries[i - 1].t).toFixed(1).padStart(5)} s` : "         "}  ${e.code}  line ${e.water.toFixed(3)} mm  ${e.from} → ${e.to ?? "?"}`)
  );
}

check("the race runs to the flag, nobody retired or penalised", r.finished && r.retired === 0 && r.penalised === 0, `${r.retired} retired, ${r.penalised} penalised`);
check("the shower wets the line well past the call for intermediates", r.peakWater > INTER_ON_MM * 1.5, `peak ${r.peakWater.toFixed(2)} mm`);
const onto = new Map<string, number>();
const off = new Map<string, number>();
for (const e of r.entries) {
  if (!e.to) continue;
  if (tyreKind(e.from) === "slick" && tyreKind(e.to) !== "slick") onto.set(e.code, (onto.get(e.code) ?? 0) + 1);
  if (tyreKind(e.from) !== "slick" && tyreKind(e.to) === "slick") off.set(e.code, (off.get(e.code) ?? 0) + 1);
}
const codes = [...r.stops.keys()];
check(
  "every car went onto rain tyres in the shower, and back onto slicks as it dried",
  codes.every((c) => onto.get(c) === 1 && off.get(c) === 1 && r.finalKind.get(c) === "slick"),
  codes.map((c) => `${c} ${onto.get(c) ?? 0}/${off.get(c) ?? 0}`).join(", ")
);
check("no car in and out more than the shower asks (two stops each)", codes.every((c) => (r.stops.get(c) ?? 0) <= 2), codes.map((c) => r.stops.get(c)).join("/"));
const gaps = r.entries.slice(1).map((e, i) => e.t - r.entries[i].t);
// The lane has no contacts: a jam would show as cars waiting in it (for the box, at the exit), so as long stops
const laneS = r.entries.filter((e) => e.outT !== undefined).map((e) => (e.outT as number) - e.t);
check(
  "into the lane one at a time, never side by side, and nobody queues in it",
  Math.min(...gaps) >= ENTRY_MIN_S && Math.max(...laneS) <= Math.min(...laneS) + 12,
  `closest ${Math.min(...gaps).toFixed(1)} s apart, lane ${Math.min(...laneS).toFixed(0)}–${Math.max(...laneS).toFixed(0)} s, at most ${r.maxInLane} cars moving through it`
);

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const clean = r.laps.filter((l) => l.clean && l.ms > 0);
const wetInters = clean.filter((l) => l.water > INTER_ON_MM && l.kind === "intermediate").map((l) => l.ms / 1000);
const wetSlicks = clean.filter((l) => l.water > INTER_ON_MM && l.kind === "slick").map((l) => l.ms / 1000);
const drySlicks = clean.filter((l) => l.water < INTER_OFF_MM / 3 && l.kind === "slick").map((l) => l.ms / 1000);
console.log(
  `      clean laps: dry on slicks ${mean(drySlicks).toFixed(2)} s (${drySlicks.length}), wet on intermediates ${mean(wetInters).toFixed(2)} s (${wetInters.length}), wet on slicks ${
    wetSlicks.length ? `${mean(wetSlicks).toFixed(2)} s` : "-"
  } (${wetSlicks.length})`
);
check("on intermediates in the wet, slower than slicks in the dry", wetInters.length > 3 && drySlicks.length > 3 && mean(wetInters) > mean(drySlicks), "");
if (wetSlicks.length) check("on slicks in the wet (still out before its stop): slower than the cars on intermediates", mean(wetSlicks) > mean(wetInters));
check("the wet brings no rash of spins, offs or crashes", r.incidents <= nCars, `${r.incidents} for ${nCars} cars`);

// The same seed runs the same race: the stops, to the frame, as far as the field's last call for intermediates
const lastOnto = Math.max(...r.entries.filter((e) => tyreKind(e.from) === "slick" && e.to && tyreKind(e.to) !== "slick").map((e) => e.t));
const again = race(lastOnto + 1);
const upTo = (run: Run) => run.entries.filter((e) => e.t <= lastOnto).map((e) => `${e.code}@${e.t.toFixed(3)}`).join(" ");
check("the same seed makes the same stops", upTo(again) === upTo(r), `${again.entries.filter((e) => e.t <= lastOnto).length} stops to ${lastOnto.toFixed(0)} s`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll AI rain race checks passed.");
