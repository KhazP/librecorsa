/**
 * Every circuit's pit lane (src/lib/sim/pit/pit-lane.ts), against its own lap:
 *   - the layouts with no pit lane have none (hill climbs, Dunsfold's teardrop, Spielberg's inner loop);
 *   - a car driven down the lane joins it at the entry, is in the speed-limit zone for most of it, reaches every pit box,
 *     and its lap position only goes forward, crossing the line at most once;
 *   - a car running wide on either side of the lap, 1 to 6 m past the road edge, is never in the lane except where the
 *     lane leaves that side of the road (the entry).
 * Circuits are read from public/tracks/<id>/track_data.json; a clone has only the RISE layouts, the rest SKIP.
 *
 *   npx tsx scripts/verify/verify-pit-lanes.ts [id ...] [--verbose] [--dir <folder of <id>/track_data.json>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from "../../src/lib/track-data";
import { PitLaneTracker } from "../../src/lib/sim/pit/pit-lane";

const NO_PIT_LANE = new Set(["borgloh", "goodwood", "dunsfold", "spielberg_inner"]);
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? args[dirAt + 1] : "public/tracks";
const only = args.filter((a, i) => !a.startsWith("--") && i !== dirAt + 1);
const dataOf = (id: string) => `${dir}/${id}/track_data.json`;
const ids = (only.length ? only : existsSync(dir) ? readdirSync(dir) : [])
  .filter((id) => existsSync(dataOf(id)))
  .sort();

let failures = 0;
const fail = (id: string, msg: string) => {
  failures++;
  console.log(`FAIL  ${id}: ${msg}`);
};
const wrap = (s: number, L: number) => ((s % L) + L) % L;
const wrapHalf = (d: number, L: number) => {
  const w = wrap(d, L);
  return w > L / 2 ? w - L : w;
};

for (const id of ids) {
  setActiveTrack(id, JSON.parse(readFileSync(dataOf(id), "utf8")) as RawTrackJson);
  const track = getActiveTrackData(1200);
  const L = track.totalLengthM;
  const lane = track.pitLane;
  if (NO_PIT_LANE.has(id)) {
    if (lane) fail(id, `expected no pit lane, got one of ${lane.rejoinM - lane.leaveM} m`);
    else console.log(`ok    ${id}: no pit lane`);
    continue;
  }
  if (!lane) {
    fail(id, "no pit lane");
    continue;
  }
  const offRoadAt = (x: number, z: number, hintS?: number) => {
    const p = track.projectWorldToTrack(x, z, hintS);
    return { off: Math.abs(p.lateralOffset) - p.sample.width / 2, s: p.s };
  };

  // 1. Down the lane
  const tracker = new PitLaneTracker(lane);
  let joinedAt: number | null = null;
  let leftAt: number | null = null;
  let inZoneM = 0;
  let prevS: number | null = null;
  let back = 0;
  let crossings = 0;
  let hint: number | undefined;
  let maxProjGap = 0;
  for (let m = 0; m <= lane.lengthM; m += 1) {
    const pt = lane.pointAt(m);
    const o = offRoadAt(pt.x, pt.z, hint);
    hint = o.s;
    const spot = tracker.update(pt.x, pt.z, o.off, o.s);
    const s = spot ? spot.trackS : o.s;
    if (spot) {
      if (joinedAt === null) joinedAt = m;
      if (spot.inLimitZone) inZoneM += 1;
      maxProjGap = Math.max(maxProjGap, Math.abs(wrapHalf(spot.trackS - o.s, L)));
    } else if (joinedAt !== null && leftAt === null) leftAt = m;
    if (prevS !== null) {
      const ds = wrapHalf(s - prevS, L);
      if (ds < -0.5) back++;
      if (prevS > L * 0.85 && s < L * 0.15) crossings++;
    }
    prevS = s;
  }
  if (joinedAt === null) fail(id, "a car driven down the lane never joins it");
  else if (joinedAt > lane.leaveM + 60) fail(id, `joins the lane ${Math.round(joinedAt - lane.leaveM)} m after it leaves the road`);
  const zoneLen = lane.limitEndM - lane.limitStartM;
  if (inZoneM < zoneLen * 0.9) fail(id, `in the limit zone for ${inZoneM} of its ${Math.round(zoneLen)} m`);
  if (back > 0) fail(id, `lap position went back ${back} times down the lane`);
  if (crossings > 1) fail(id, `crossed the line ${crossings} times down the lane`);
  // Every box reachable: a car parked in it is in the lane
  let unreachable = 0;
  for (const b of lane.boxes) {
    const t = new PitLaneTracker(lane);
    // come down the lane to it, then step across to the box
    for (let m = lane.leaveM; m <= b.laneM; m += 2) {
      const pt = lane.pointAt(m);
      const o = offRoadAt(pt.x, pt.z);
      t.update(pt.x, pt.z, o.off, o.s);
    }
    const ob = offRoadAt(b.x, b.z);
    const spot = t.update(b.x, b.z, ob.off, ob.s);
    if (!spot) unreachable++;
  }
  if (unreachable) fail(id, `${unreachable} of ${lane.boxes.length} pit boxes are outside the lane`);

  // 2. Running wide, either side
  let strays = 0;
  let strayWhere = "";
  for (const side of [-1, 1]) {
    for (let k = 1; k <= 6; k++) {
      const t = new PitLaneTracker(lane);
      for (let s = 0; s < L * 2; s += 2) {
        const smp = track.getSampleAtDistance(wrap(s, L));
        const lat = side * (smp.width / 2 + k);
        const x = smp.position.x + smp.binormal.x * lat;
        const z = smp.position.z + smp.binormal.z * lat;
        const spot = t.update(x, z, k, wrap(s, L));
        if (spot && !lane.besideLap(wrap(s, L), 80)) {
          strays++;
          if (!strayWhere) strayWhere = `s=${Math.round(wrap(s, L))} side ${side > 0 ? "right" : "left"} +${k} m`;
        }
      }
    }
  }
  if (strays) fail(id, `a car running wide is in the lane away from the pits (${strays} steps, first at ${strayWhere})`);

  const ok = joinedAt !== null && !back && crossings <= 1 && !unreachable && !strays;
  if (ok || verbose) {
    console.log(
      `${ok ? "ok   " : "     "} ${id}: lane ${Math.round(lane.rejoinM - lane.leaveM)} m off the road (s ${Math.round(
        lane.leaveTrackS
      )} -> ${Math.round(lane.rejoinTrackS)}), ${lane.boxes.length} ${lane.realBoxes ? "real" : "laid-out"} boxes, ${
        lane.side > 0 ? "right" : "left"
      } side, limit ${lane.limitKmh} km/h, lane vs projection ${maxProjGap.toFixed(1)} m${
        leftAt !== null ? `, rejoins at lane ${leftAt} m` : ""
      }`
    );
  }
}
if (!ids.length) console.log("SKIP  pit lanes (no circuits under public/tracks)");
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\npit lanes: ${ids.length} circuits checked`);
