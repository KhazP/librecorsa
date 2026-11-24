/**
 * Flying-lap starts (`startPose` in src/lib/sim/simulator-car.ts): the car is handed over at speed with no yaw rate and
 * its wheel straight, so hands-off it must keep its tyres on the asphalt for its first second (`START_HANDS_OFF_S`).
 *
 *   npx tsx scripts/verify-flying-start.ts
 *
 * Every car model, on each circuit this copy has: placed for a flying lap, then that second at full throttle with no
 * steering on the full physics and the circuit's colliders, with all four tyres on road or kerb throughout. Sachsenring's
 * flying lap starts on the last corner's exit, where a car heading along the road from the same spot had its right-hand
 * tyres on the run-off within 0.4 s (printed as a note). Where heading along the road on the line already keeps them on
 * (RISE's and Monaco's straights) the car is placed exactly there, and a race's rolling start keeps every slot on its
 * line along the road.
 */
import fs from 'node:fs';
import * as THREE from 'three';
import { VEHICLE_MODELS } from '../src/lib/cars/vehicle-models';
import { createGroundHit, WALL_SEGMENT_STRIDE, type GroundQuery, type WallQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import {
  flyingStartPoint,
  flyingStartSpeedMs,
  START_HANDS_OFF_S,
  startHandsOffRunM,
  startPose,
  type SimulatorCar,
} from '../src/lib/sim/simulator-car';
import { trackColliders } from '../src/lib/sim/track-colliders';
import { type BuiltTrackData, getActiveTrackData, type RawTrackJson, setActiveTrack } from '../src/lib/track-data';
import type { VehicleModelId } from '../src/types/f1';
import { loadGlbGeometry, trackModelFiles } from './lib/glb-geometry';
import { hasFile, noteSkip } from './lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const DT = 1 / 120;
const CARS = Object.keys(VEHICLE_MODELS) as VehicleModelId[];
const ASPHALT = new Set(['road', 'kerb']);
const hit = createGroundHit();

/** Degrees the car's nose points right (+) or left of the road's tangent where it stands */
function headingOffRoadDeg(car: SimulatorCar, track: BuiltTrackData): number {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.worldQuaternion);
  const smp = track.getSampleAtDistance(car.sMeters);
  const along = f.x * smp.tangent.x + f.z * smp.tangent.z;
  const across = (f.x * smp.binormal.x + f.z * smp.binormal.z) / Math.hypot(smp.binormal.x, smp.binormal.z);
  return THREE.MathUtils.radToDeg(Math.atan2(across, along));
}

/** Runs a car hands-off at full throttle for `seconds`, tracking asphalt retention, wall contact, and lap validity */
function handsOffRun(
  car: SimulatorCar,
  ground: GroundQuery,
  seconds: number
): { onS: number; wallContactS: number; lapInvalid: boolean } {
  let onS = seconds;
  let wallContactS = 0;
  let lapInvalid = false;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    car.step(DT, { throttle: 1, brake: 0, analogSteer: 0 });
    if (onS === seconds) {
      for (const w of car.wheels) {
        if (!ground.query(w.worldPos.x, w.worldPos.z, w.worldPos.y + 1, hit) || !ASPHALT.has(hit.surface)) {
          onS = (k + 1) * DT;
          break;
        }
      }
    }
    wallContactS = Math.max(wallContactS, car.telemetry.f12026?.wallContactS ?? 0);
    if (car.telemetry.lapInvalid) lapInvalid = true;
  }
  return { onS, wallContactS, lapInvalid };
}

/** The circuit's data and colliders, or null (with a note) where this copy doesn't have it */
function load(id: string): { track: BuiltTrackData; root: THREE.Object3D; ground: GroundQuery } | null {
  const data = `public/tracks/${id}/track_data.json`;
  if (!hasFile(data)) {
    noteSkip(id, data);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(data, 'utf8')) as RawTrackJson & { metadata: { mesh: { url: string } } };
  const files = trackModelFiles({ id, meshUrl: raw.metadata.mesh.url });
  if (!hasFile(files.path)) {
    noteSkip(id, files.path);
    return null;
  }
  if (files.shared && !hasFile(files.shared)) {
    noteSkip(id, files.shared);
    return null;
  }
  setActiveTrack(id, raw);
  const track = getActiveTrackData(1200);
  const root = loadGlbGeometry(files.path, files.shared);
  return { track, root, ground: trackColliders(root).ground! };
}

// ---- Synthetic unit checks (no hosted circuit files required) ----
console.log('Flying-start placement, exit-speed cap, and barrier-clearance unit checks');
{
  const wrapS = (s: number, L: number) => ((s % L) + L) % L;

  // 1. Slow-exit final straight (Circuit de la Sarthe 1982 pattern: Ford Chicane ends at L-80 m, S/F optV = 195 km/h < 200)
  const L1 = 13646;
  const sartheLike = {
    totalLengthM: L1,
    getSampleAtDistance(s: number) {
      const w = wrapS(s, L1);
      const rel = w > L1 / 2 ? w - L1 : w; // negative before S/F
      if (rel <= -80 && rel >= -140) return { optimalSpeedKmh: 100 + Math.max(0, rel + 100) * 0.9, curvature: 0.012 };
      const speed = Math.max(100, Math.min(260, 195 + rel * 0.95));
      return { optimalSpeedKmh: speed, curvature: 0.0003 };
    },
  };
  const sp1 = flyingStartPoint(sartheLike);
  const d1 = sp1.cornerS === null ? -1 : ((((sp1.s - sp1.cornerS + L1 / 2) % L1) + L1) % L1) - L1 / 2;
  const v1Kmh = flyingStartSpeedMs(sartheLike, sp1, sp1.s, () => 75, (0.9 * sartheLike.getSampleAtDistance(sp1.cornerS ?? sp1.s).optimalSpeedKmh) / 3.6) * 3.6;
  const opt1 = sartheLike.getSampleAtDistance(sp1.s).optimalSpeedKmh;
  check(
    'unit: slow-exit straight places s past chicane with cornerS behind s',
    sp1.cornerS !== null && d1 >= 0 && sp1.s < L1 - 40 && sp1.s > L1 - 80,
    `s=L${(sp1.s - L1).toFixed(0)}m, cornerS=${sp1.cornerS === null ? 'null' : `L${(sp1.cornerS - L1).toFixed(0)}m`}, d=${d1.toFixed(0)}m`
  );
  check(
    'unit: slow-exit straight caps speed realistically (never 270 km/h wrap)',
    v1Kmh <= opt1 && v1Kmh >= 90 && v1Kmh < 160,
    `${v1Kmh.toFixed(1)} km/h (opt ${opt1.toFixed(1)} km/h)`
  );

  // 2. High-speed sweeper > 200 km/h (Riverside T9 / Watkins Glen Short pattern)
  const L2 = 5000;
  const sweeperTrack = {
    totalLengthM: L2,
    getSampleAtDistance(s: number) {
      const w = wrapS(s, L2);
      const rel = w > L2 / 2 ? w - L2 : w;
      const inSweeper = rel <= -275 && rel >= -480;
      return { optimalSpeedKmh: inSweeper ? 240 : 280, curvature: inSweeper ? 0.0075 : 0.0005 };
    },
  };
  const sp2 = flyingStartPoint(sweeperTrack);
  check(
    'unit: fast sweeper (> 200 km/h) ends straight before the corner',
    sp2.cornerS !== null && sp2.s > L2 - 275 && sp2.cornerS <= sp2.s,
    `s=L${(sp2.s - L2).toFixed(0)}m, cornerS=${sp2.cornerS === null ? 'null' : `L${(sp2.cornerS - L2).toFixed(0)}m`}`
  );

  // 3. S/F immediately after tight hairpin (Spielberg Inner / Dunsfold / VIR Patriot pattern)
  const L3 = 2000;
  const tightExitTrack = {
    totalLengthM: L3,
    getSampleAtDistance(s: number) {
      const w = wrapS(s, L3);
      const rel = w > L3 / 2 ? w - L3 : w;
      // Hairpin peaks at -40 m (curv 0.045), straightens toward S/F (-15 m curv 0.008)
      const curv = rel <= -15 ? Math.min(0.05, 0.008 + Math.max(0, -15 - rel) * 0.0015) : 0.006;
      return { optimalSpeedKmh: 120, curvature: curv };
    },
  };
  const sp3 = flyingStartPoint(tightExitTrack);
  const v3Kmh = flyingStartSpeedMs(tightExitTrack, sp3, sp3.s, () => 75, (0.9 * 120) / 3.6) * 3.6;
  check(
    'unit: tight corner at S/F picks straightest spot & caps cornering speed',
    sp3.cornerS === sp3.s && sp3.s === L3 - 15 && v3Kmh < 110,
    `s=L${(sp3.s - L3).toFixed(0)}m, v=${v3Kmh.toFixed(1)} km/h`
  );

  // 4. startPose barrier avoidance when road asphalt extends past a pit wall (Sarthe 1982 pit-wall pattern)
  const straightTrack = {
    getSampleAtDistance(s: number) {
      return {
        position: new THREE.Vector3(0, 0, s),
        tangent: new THREE.Vector3(0, 0, 1),
        binormal: new THREE.Vector3(1, 0, 0),
      };
    },
  };
  // Road collider covers lat [-4.5, +7.5] (extending into pit lane), while pit wall stands at x = +4.78 for z = 0..100
  const roadGround: GroundQuery = {
    query(x, _z, _y, out) {
      if (x >= -4.5 && x <= 7.5) {
        out.height = 0;
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
        out.surface = 'road';
        return true;
      }
      return false;
    },
  };
  const segs = new Float32Array(WALL_SEGMENT_STRIDE);
  segs[0] = 4.78; segs[1] = -20; segs[2] = 4.78; segs[3] = 120; segs[4] = -1; segs[5] = 2; segs[6] = -1; segs[7] = 0;
  const pitWall: WallQuery = {
    segments: segs,
    near(_x, _z, _r, out) {
      out[0] = 0;
      return 1;
    },
  };
  const fp = { halfWidthM: 1.0, frontM: 1.8, rearM: 1.8 };
  const poseNoWalls = startPose(straightTrack, roadGround, 0, 3.6, () => 3.6, -3.5, 3.5, fp, startHandsOffRunM(35), null);
  const poseWithWalls = startPose(straightTrack, roadGround, 0, 3.6, () => 3.6, -3.5, 3.5, fp, startHandsOffRunM(35), pitWall);
  // Car right edge along the hands-off run must stay at least 0.5 m clear of x = 4.78 (i.e. right edge <= 4.28)
  const fx = Math.sin(poseWithWalls.yawRad);
  const fz = Math.cos(poseWithWalls.yawRad);
  let maxRightEdge = -Infinity;
  for (let d = 0; d <= startHandsOffRunM(35); d += 2) {
    const cx = poseWithWalls.x + fx * d;
    for (const along of [fp.frontM, -fp.rearM]) {
      const rx = cx + fx * along + fz * fp.halfWidthM;
      if (rx > maxRightEdge) maxRightEdge = rx;
    }
  }
  check(
    'unit: startPose steers/shifts clear of pit wall inside road collider',
    poseNoWalls.lateral === 3.6 && maxRightEdge <= 4.78 - 0.5 + 1e-3,
    `no-walls lat=${poseNoWalls.lateral.toFixed(2)}m, with-walls lat=${poseWithWalls.lateral.toFixed(2)}m, maxRight=${maxRightEdge.toFixed(2)}m (wall 4.78m)`
  );
}

console.log(`\nHands-off for ${START_HANDS_OFF_S} s from a flying start, every car`);
const CIRCUITS = [
  'rwanda_official',
  'rwanda_official_short',
  'le_mans_82',
  'monaco',
  'spielberg',
  'spielberg_inner',
  'sachsenring',
  'sachsenring_short',
  'barbagallo',
  'vir',
  'vir_grand_west',
  'vir_patriot',
  'vir_patriot_reverse',
  'riverside',
  'riverside_short',
  'riverside_nascar',
  'watkins_glen_short',
  'chang',
  'speedvegas',
  'dunsfold',
];
for (const id of CIRCUITS) {
  const c = load(id);
  if (!c) continue;
  const { track, root, ground } = c;
  const L = track.totalLengthM;
  const fsp = flyingStartPoint(track);
  const signedCornerDist =
    fsp.cornerS === null
      ? null
      : fsp.s === fsp.cornerS
        ? 0
        : ((((fsp.s - fsp.cornerS + L / 2) % L) + L) % L) - L / 2;
  const optAtStartKmh = track.getSampleAtDistance(fsp.s).optimalSpeedKmh;
  check(
    `${id}: flyingStartPoint cornerS never ahead of s`,
    signedCornerDist === null || signedCornerDist >= -1e-6,
    `s=L${(fsp.s - L).toFixed(0)}m, cornerS=${fsp.cornerS === null ? 'null' : `L${(fsp.cornerS - L).toFixed(0)}m`}`
  );
  const runs = CARS.map((model) => {
    const car = VEHICLE_MODELS[model].createSim(track, root);
    car.resetToStartGrid(true);
    const at = {
      s: car.sMeters - L,
      lateral: car.lateralOffsetM,
      speedKmh: car.vxMs * 3.6,
      headDeg: headingOffRoadDeg(car, track),
    };
    return { model, ...at, ...handsOffRun(car, ground, START_HANDS_OFF_S) };
  });
  const off = runs.filter((r) => r.onS < START_HANDS_OFF_S);
  check(`${id}: all four tyres on road or kerb`, off.length === 0,
    off.length ? off.map((r) => `${r.model} off at ${r.onS.toFixed(2)} s`).join(', ') :
      `${runs[0].s.toFixed(0)} m, ${runs.map((r) => `${r.model} ${r.lateral.toFixed(1)} m / ${r.headDeg.toFixed(1)}°`).join(', ')}`);
  const badSpawn = runs.filter((r) => r.wallContactS > 0 || r.lapInvalid || r.speedKmh > optAtStartKmh * 1.05);
  check(
    `${id}: no wall contact, valid lap, realistic spawn speed`,
    badSpawn.length === 0,
    badSpawn.length
      ? badSpawn
          .map(
            (r) =>
              `${r.model}(v=${r.speedKmh.toFixed(0)} vs opt=${optAtStartKmh.toFixed(0)}${r.wallContactS > 0 ? `, wall=${r.wallContactS.toFixed(2)}s` : ''}${r.lapInvalid ? ', INV' : ''})`
          )
          .join(', ')
      : `v=${Math.min(...runs.map((r) => r.speedKmh)).toFixed(0)}..${Math.max(...runs.map((r) => r.speedKmh)).toFixed(0)} km/h (opt ${optAtStartKmh.toFixed(0)})`
  );
  if (id === 'rwanda_official' || id === 'rwanda_official_short' || id === 'monaco') {
    const turned = runs.filter((r) => Math.abs(r.headDeg) > 0.2);
    check(`${id}: on its line along the road, as before`, turned.length === 0, turned.map((r) => `${r.model} ${r.headDeg.toFixed(2)}°`).join(', ') || 'every car');
  }
  if (id === 'sachsenring' || id === 'sachsenring_short') {
    // The same spot heading along the road (`teleportToDistance` places a car that way): what the start used to do
    const along = CARS.map((model) => {
      const car = VEHICLE_MODELS[model].createSim(track, root);
      car.resetToStartGrid(true);
      car.teleportToDistance(car.sMeters, car.vxMs, car.lateralOffsetM);
      return { model, onS: handsOffRun(car, ground, START_HANDS_OFF_S).onS };
    });
    // A note, not a check: a better racing line or road data there may keep it on
    console.log(`INFO  ${`${id}: heading along the road from there, first tyre off at`.padEnd(64)} ${along.map((r) => `${r.model} ${r.onS < START_HANDS_OFF_S ? `${r.onS.toFixed(2)} s` : 'none'}`).join(', ')}`);
    // A race's rolling start: every slot on its line along the road
    const slots = [0, 1, 2, 3].map((slot) => {
      const car = VEHICLE_MODELS.lc26.createSim(track, root);
      car.resetToStartGrid(true, slot, 20);
      return headingOffRoadDeg(car, track);
    });
    check(`${id}: rolling-start slots along the road`, slots.every((d) => Math.abs(d) < 0.2), slots.map((d) => `${d.toFixed(2)}°`).join(', '));
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll flying-start checks passed.');
