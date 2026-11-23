/**
 * AI pit stops (src/lib/sim/pit/ai-pit.ts) in a headless AI race on the page-side field: a race that requires one stop,
 * on circuits with different lanes. Every car makes its stop, comes out again within a sane time, finishes every lap,
 * and none is penalised for a stop it did not make; the stop costs time but no car is lost in the lane.
 *
 *   npx tsx scripts/verify-ai-pit-stops.ts [--track id[,id]] [--laps 4] [--cars 5] [--car amg-gt3] [--verbose]
 *
 * A circuit whose files are not in this checkout (a clone has only the RISE layouts) is skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from "../src/lib/track-data";
import { vehicleModelSpec } from "../src/lib/cars/vehicle-models";
import { aiDriversFor, AiOpponentField } from "../src/lib/sim/ai-opponents";
import { TrackEnvironment } from "../src/lib/sim/track-environment";
import { DEFAULT_SESSION_CONDITIONS } from "../src/lib/sim/weather";
import type { VehicleModelId } from "../src/types/f1";
import { loadGlbGeometry } from "./lib/glb-geometry";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const verbose = argv.includes("--verbose");
const tracks = opt("track", "rwanda_official_short,chang,vir").split(",");
const laps = Number(opt("laps", "4"));
const nCars = Number(opt("cars", "5"));
const carKind = opt("car", "amg-gt3") as VehicleModelId;
const DT = 1 / 120;

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`FAIL  ${msg}`);
};

for (const id of tracks) {
  const dataPath = `public/tracks/${id}/track_data.json`;
  if (!existsSync(dataPath)) {
    console.log(`SKIP  ${id} (${dataPath} not in this checkout)`);
    continue;
  }
  setActiveTrack(id, JSON.parse(readFileSync(dataPath, "utf8")) as RawTrackJson);
  const track = getActiveTrackData(1200);
  if (!track.meshUrl || !existsSync(`public${track.meshUrl}`)) {
    console.log(`SKIP  ${id} (circuit model not in this checkout)`);
    continue;
  }
  const lane = track.pitLane;
  if (!lane) {
    fail(`${id}: no pit lane`);
    continue;
  }
  const root = loadGlbGeometry(`public${track.meshUrl}`);
  const template = vehicleModelSpec(carKind).createSim(track, root);
  const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS });
  const field = new AiOpponentField(track, template, aiDriversFor(nCars), env, {
    skill: 80,
    seed: 7,
    learning: false,
    spectate: true,
    trackId: id,
    damage: "off",
  });
  field.raceLaps = laps;
  field.pitStopsRequired = 1;
  field.startRace(true);
  const started = Date.now();
  let t = 0;
  const limitS = 60 + laps * 240;
  const inPitSince = new Map<string, number>();
  const longestStopS = new Map<string, number>();
  const stopsSeen = new Map<string, number>();
  while (field.phase !== "finished" && t < limitS) {
    env.update(DT, field.sims());
    field.update(DT);
    t += DT;
    const st = field.status();
    for (const row of st.standings) {
      if (row.isPlayer) continue;
      if (row.inPit) {
        if (!inPitSince.has(row.driverCode)) {
          inPitSince.set(row.driverCode, t);
          if (verbose) console.log(`      ${id} ${t.toFixed(1)} s: ${row.driverCode} into the pits (lap ${row.lap})`);
        }
      } else if (inPitSince.has(row.driverCode)) {
        const dur = t - (inPitSince.get(row.driverCode) as number);
        longestStopS.set(row.driverCode, Math.max(longestStopS.get(row.driverCode) ?? 0, dur));
        inPitSince.delete(row.driverCode);
        if (verbose) console.log(`      ${id} ${t.toFixed(1)} s: ${row.driverCode} out after ${dur.toFixed(1)} s on ${row.compound}`);
      }
      stopsSeen.set(row.driverCode, row.pitStops ?? 0);
    }
  }
  const st = field.status();
  if (field.phase !== "finished") fail(`${id}: race not finished after ${limitS} s`);
  const results = st.results ?? [];
  for (const row of st.standings) {
    if (row.isPlayer) continue;
    const stops = stopsSeen.get(row.driverCode) ?? 0;
    if (stops < 1) fail(`${id}: ${row.driverCode} made no stop`);
    if (inPitSince.has(row.driverCode)) fail(`${id}: ${row.driverCode} still in the pit lane at the end`);
    const longest = longestStopS.get(row.driverCode) ?? 0;
    if (longest > 90) fail(`${id}: ${row.driverCode} spent ${longest.toFixed(0)} s in the pit lane`);
    const res = results.find((r) => r.driverCode === row.driverCode);
    if (res && !res.dnf && res.lapsCompleted !== undefined && res.lapsCompleted < laps - 1) {
      fail(`${id}: ${row.driverCode} finished ${res.lapsCompleted} of ${laps} laps`);
    }
    if ((row.penaltyS ?? 0) >= 30) fail(`${id}: ${row.driverCode} penalised ${row.penaltyS} s (missed stop?)`);
  }
  const stopTimes = [...longestStopS.values()];
  console.log(
    `${failures ? "     " : "ok   "} ${id}: ${laps} laps, ${nCars} cars, stops ${[...stopsSeen.values()].join("/")}, lane time ${stopTimes
      .map((s) => s.toFixed(0))
      .join("/")} s, ${t.toFixed(0)} s raced in ${((Date.now() - started) / 1000).toFixed(0)} s`
  );
}
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAI pit stops: ok");
