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
import * as THREE from "three";
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from "../../src/lib/track-data";
import { PitLaneTracker } from "../../src/lib/sim/pit/pit-lane";
import { pitLaneWallExcluder, TrackWallQuery, WALL_SEGMENT_STRIDE } from "../../src/lib/sim/f12026-car/TrackColliderQuery";
import { trackColliders } from "../../src/lib/sim/track-colliders";
import { createAmgGt3Sim } from "../../src/lib/sim/gt3/AmgGt3Sim";
import { loadGlbGeometry } from "../lib/glb-geometry";

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

  // 3. Wall colliders: if the circuit's layout/full GLB is present, verify zero wall collider segments block the pit lane
  const dirFiles = existsSync(`${dir}/${id}`) ? readdirSync(`${dir}/${id}`) : [];
  const glbFile = dirFiles.find((f) => f.endsWith(".glb") && f.includes(".layout.")) ?? (dirFiles.includes(`${id}.glb`) ? `${id}.glb` : undefined);
  let blockedWalls = 0;
  if (glbFile) {
    const root = loadGlbGeometry(`${dir}/${id}/${glbFile}`);
    const { walls } = trackColliders(root);
    const nearBuf = new Int32Array(256);
    const segs = walls.segments;
    const cross2 = (ux: number, uz: number, vx: number, vz: number) => ux * vz - uz * vx;
    for (let m = Math.max(0, lane.leaveM - 5); m <= Math.min(lane.lengthM, lane.rejoinM + 5); m += 1) {
      const p0 = lane.pointAt(m);
      const p1 = lane.pointAt(Math.min(lane.lengthM, m + 1));
      const n = walls.near(p0.x, p0.z, 2.5, nearBuf);
      for (let k = 0; k < n; k++) {
        const o = nearBuf[k] * WALL_SEGMENT_STRIDE;
        const ax = segs[o], az = segs[o + 1], bx = segs[o + 2], bz = segs[o + 3];
        const rx = p1.x - p0.x, rz = p1.z - p0.z;
        const dx = bx - ax, dz = bz - az;
        const den = cross2(rx, rz, dx, dz);
        if (Math.abs(den) > 1e-9) {
          const qpx = ax - p0.x, qpz = az - p0.z;
          const tt = cross2(qpx, qpz, dx, dz) / den;
          const uu = cross2(qpx, qpz, rx, rz) / den;
          if (tt >= 0 && tt <= 1 && uu >= 0 && uu <= 1) blockedWalls++;
        }
      }
    }
    if (blockedWalls > 0) fail(id, `${blockedWalls} wall collider segment(s) cross the pit lane centerline`);

    // Drive an actual car into Watkins Glen pit entry, all the way down the pit lane, and out the pit exit
    if (id === "watkins_glen" || id === "watkins_glen_short") {
      const car = createAmgGt3Sim(track, root);
      car.autoGearbox = true;
      const startM = Math.max(0, lane.leaveM - 25);
      const targetM = Math.min(lane.lengthM - 5, lane.rejoinM + 35);
      const startPt = lane.pointAt(startM);
      const startProj = track.projectWorldToTrack(startPt.x, startPt.z);
      const startYaw = Math.atan2(startPt.tx, startPt.tz);
      car.restorePose!({ x: startPt.x, z: startPt.z, yawRad: startYaw, speedMs: 14, s: startProj.s });
      let wallHits = 0;
      let lastWallAtMs = car.telemetry.f12026?.wallImpact?.atMs ?? -1;
      let reachedM = startM;
      const dt = 1 / 60;
      for (let step = 0; step < 60 * 65; step++) {
        // Pure pursuit toward a point 12 m ahead along the pit centerline
        const pos = car.worldPosition;
        let bestM = reachedM;
        let bestD2 = Infinity;
        for (let m = Math.max(0, reachedM - 10); m <= Math.min(lane.lengthM, reachedM + 40); m += 2) {
          const q = lane.pointAt(m);
          const d2 = (q.x - pos.x) ** 2 + (q.z - pos.z) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestM = m;
          }
        }
        reachedM = Math.max(reachedM, bestM);
        const aim = lane.pointAt(Math.min(lane.lengthM, bestM + 12));
        const q = car.worldQuaternion;
        const yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
        const desiredYaw = Math.atan2(aim.x - pos.x, aim.z - pos.z);
        let err = desiredYaw - yaw;
        while (err > Math.PI) err -= 2 * Math.PI;
        while (err < -Math.PI) err += 2 * Math.PI;
        const steer = Math.max(-1, Math.min(1, -err * 2.2));
        const throttle = car.vxMs < 15 ? 0.35 : 0;
        const brake = car.vxMs > 18 ? 0.25 : 0;
        car.step(dt, { throttle, brake, analogSteer: steer });
        const wi = car.telemetry.f12026?.wallImpact;
        if (wi && wi.atMs !== lastWallAtMs) {
          lastWallAtMs = wi.atMs;
          if (wi.speedMs > 1.5) wallHits++;
        }
        if (reachedM >= targetM) break;
      }
      if (wallHits > 0 || reachedM < targetM) {
        fail(id, `car pit-lane drive hit wall (${wallHits} hits, reached lane ${reachedM.toFixed(0)} m vs target ${targetM.toFixed(0)} m)`);
      } else {
        console.log(`ok    ${id}: car drove pit entry -> pit lane -> pit exit unobstructed to lane ${reachedM.toFixed(0)} m (0 wall hits)`);
      }
    }
  }

  const ok = joinedAt !== null && !back && crossings <= 1 && !unreachable && !strays && blockedWalls === 0;
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
// Synthetic unit check for pitLaneWallExcluder (always runs even without hosted GLBs)
{
  const px: number[] = [];
  const pz: number[] = [];
  const cum: number[] = [];
  for (let m = 0; m <= 200; m += 2) {
    px.push(0);
    pz.push(m);
    cum.push(m);
  }
  const excluder = pitLaneWallExcluder({ px, pz, cum, leaveM: 40, rejoinM: 160 });
  const makeWall = (ax: number, az: number, bx: number, bz: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([ax, 0, az, bx, 0, bz, bx, 3, bz, ax, 0, az, bx, 3, bz, ax, 3, az], 3));
    const mesh = new THREE.Mesh(g);
    mesh.name = "Track_Collider_Wall_Right";
    return mesh;
  };
  const root = new THREE.Group();
  // Return panel crossing straight across pit entry at z = 50
  root.add(makeWall(-4, 50, 4, 50));
  // Legitimate parallel pit wall 4 m to the side of the pit centerline
  root.add(makeWall(4, 40, 4, 160));
  const unfiltered = TrackWallQuery.fromTrackRoot(root);
  const filtered = TrackWallQuery.fromTrackRoot(root, [], undefined, excluder);
  if (unfiltered.segmentCount !== 2 || filtered.segmentCount !== 1) {
    fail("pitLaneWallExcluder", `expected return panel stripped (2 -> 1), got ${unfiltered.segmentCount} -> ${filtered.segmentCount}`);
  } else {
    console.log("ok    pitLaneWallExcluder: strips return panel across pit entry while keeping parallel pit wall");
  }
}

if (!ids.length) console.log("SKIP  pit lanes (no circuits under public/tracks)");
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\npit lanes: ${ids.length} circuits checked`);
