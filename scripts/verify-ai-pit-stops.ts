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
// A restart while a car is mid-stop puts it on its grid slot facing down the road (it was left facing world yaw 0)
{
  const id = tracks.find((t) => existsSync(`public/tracks/${t}/track_data.json`));
  if (id) {
    setActiveTrack(id, JSON.parse(readFileSync(`public/tracks/${id}/track_data.json`, "utf8")) as RawTrackJson);
    const track = getActiveTrackData(1200);
    if (track.meshUrl && existsSync(`public${track.meshUrl}`) && track.pitLane) {
      const root = loadGlbGeometry(`public${track.meshUrl}`);
      const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS });
      const field = new AiOpponentField(track, vehicleModelSpec(carKind).createSim(track, root), aiDriversFor(3), env, { skill: 80, seed: 3, learning: false, spectate: true, trackId: id, damage: "off" });
      field.raceLaps = 4;
      field.pitStopsRequired = 1;
      field.startRace(true);
      let t = 0;
      while (t < 600 && !field.status().standings.some((r) => !r.isPlayer && r.inPit)) {
        env.update(DT, field.sims());
        field.update(DT);
        t += DT;
      }
      const pitting = field.status().standings.some((r) => !r.isPlayer && r.inPit);
      field.startRace(true);
      let worst = 0;
      for (const sim of field.sims()) {
        const smp = track.getSampleAtDistance(sim.sMeters);
        const q = sim.worldQuaternion;
        // The car's nose (+z) in the world, against the road's direction there
        const fx = 2 * (q.x * q.z + q.w * q.y);
        const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
        const cos = (fx * smp.tangent.x + fz * smp.tangent.z) / (Math.hypot(fx, fz) * Math.hypot(smp.tangent.x, smp.tangent.z) || 1);
        worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI));
      }
      if (!pitting) console.log(`SKIP  restart mid-stop (no car pitted in ${t.toFixed(0)} s)`);
      else if (worst > 30) fail(`${id}: after a restart mid-stop a car faces ${worst.toFixed(0)}° off the road`);
      else console.log(`ok    ${id}: a restart mid-stop lines every car up facing the road (worst ${worst.toFixed(0)}°)`);
    }
  }
}

// A flashback while a car pulls away from its box: the stop was made and counted, so the car does not stop again
{
  const id = tracks.find((t) => existsSync(`public/tracks/${t}/track_data.json`));
  if (id) {
    setActiveTrack(id, JSON.parse(readFileSync(`public/tracks/${id}/track_data.json`, "utf8")) as RawTrackJson);
    const track = getActiveTrackData(1200);
    if (track.meshUrl && existsSync(`public${track.meshUrl}`) && track.pitLane) {
      const root = loadGlbGeometry(`public${track.meshUrl}`);
      const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS });
      const field = new AiOpponentField(track, vehicleModelSpec(carKind).createSim(track, root), aiDriversFor(3), env, { skill: 80, seed: 5, learning: false, spectate: true, trackId: id, damage: "off" });
      field.raceLaps = 3;
      field.pitStopsRequired = 1;
      field.startRace(true);
      // The field's own cars (private): the one on its way out of a stop
      type Car = { id: string; isPlayer: boolean; pitRun: { phase: string } | null; sim: { worldPosition: { x: number; y: number; z: number }; worldQuaternion: { x: number; y: number; z: number; w: number }; vxMs: number; sMeters: number } };
      const cars = (field as unknown as { cars: Car[] }).cars;
      let t = 0;
      let leaving: Car | undefined;
      while (t < 900 && !(leaving = cars.find((c) => !c.isPlayer && c.pitRun?.phase === "out"))) {
        env.update(DT, field.sims());
        field.update(DT);
        t += DT;
      }
      if (!leaving) console.log(`SKIP  flashback on the way out (no car left its box in ${t.toFixed(0)} s)`);
      else {
        const code = field.status().standings.find((r) => r.inPit && !r.isPlayer)?.driverCode;
        field.restoreField(
          cars.map((c) => {
            const q = c.sim.worldQuaternion;
            const p = c.sim.worldPosition;
            return { id: c.isPlayer ? "player" : c.id, x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, yawRad: Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)), speedMs: Math.max(0, c.sim.vxMs), s: c.sim.sMeters, pitLane: c.pitRun !== null };
          }),
          0.5
        );
        const stops = new Map<string, number>();
        while (field.phase !== "finished" && t < 1800) {
          env.update(DT, field.sims());
          field.update(DT);
          t += DT;
          for (const r of field.status().standings) if (!r.isPlayer) stops.set(r.driverCode, Math.max(stops.get(r.driverCode) ?? 0, r.pitStops ?? 0));
        }
        const most = Math.max(...stops.values());
        if (most > 1) fail(`${id}: a flashback on the way out of a stop made a car stop again (${[...stops].map(([c, n]) => `${c} ${n}`).join(", ")}; it was ${code})`);
        else console.log(`ok    ${id}: a flashback on the way out of a stop leaves it made once (stops ${[...stops.values()].join("/")})`);
      }

      // Put down in the lane: only a car put back in it (a flashback to a moment there) is in it; one put down at the same
      // spot without that (a car off the road beside the lane) is not
      const lane = track.pitLane;
      const sim = vehicleModelSpec(carKind).createSim(track, root);
      const at = lane.pointAt((lane.leaveM + lane.rejoinM) / 2);
      const yawRad = Math.atan2(at.tx, at.tz);
      sim.restorePose?.({ x: at.x, z: at.z, yawRad, speedMs: 0, pitLane: false });
      sim.step(DT, {});
      const outside = sim.telemetry.pitLane ?? null;
      sim.restorePose?.({ x: at.x, z: at.z, yawRad, speedMs: 0, pitLane: true });
      sim.step(DT, {});
      const inside = sim.telemetry.pitLane ?? null;
      if (outside) fail(`${id}: a car put down beside the road in the lane's corridor, not put back in the lane, was taken into it`);
      else if (!inside) fail(`${id}: a car put back in the pit lane was not found in it`);
      else console.log(`ok    ${id}: only a car put back in the lane is in it (at ${inside.laneM.toFixed(0)} m)`);
    }
  }
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAI pit stops: ok");
