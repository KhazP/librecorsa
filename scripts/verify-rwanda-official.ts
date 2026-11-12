/**
 * The official Rwanda layout (public/tracks/rwanda_official/, built by scripts/rwanda-official/): it is listed as a
 * second layout of the Rwanda venue, its track data is a closed anticlockwise 5.86 km lap with 17 corners, and the model
 * the physics drives on agrees with that data: the road is where the samples say, to the centimetre, the barriers
 * stand where the data puts them all the way round, kerbs, run-off and pit lane carry their surfaces, the start
 * lights hang over the grid, nothing built stands on the road or hangs low over it, the TV cameras stand on their
 * towers, nothing in the file comes from the fan-made layout's source, and no tree stands on the track. Where the other
 * lap's road leaves this one, it is off the track, and a car that takes it does not get a lap out of it.
 *
 *   npx tsx scripts/verify-rwanda-official.ts
 */
import * as THREE from 'three';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { REPO_TRACK_IDS } from '../src/lib/hosted-content';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { LapClock } from '../src/lib/sim/race-session';
import { otherLayoutRoads } from './lib/layout-limits';
import { SCENERY_CREDITS, type SceneryCredit } from '../src/lib/render/scenery-credits';
import { createGroundHit, TrackColliderQuery, TrackWallQuery, WALL_SEGMENT_STRIDE } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { resolveSurfaceTable } from '../src/lib/sim/track-surfaces';
import { evaluateSampleLateralHeightM, getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { CIRCUIT_VENUES, DEFAULT_TRACK_ID, TRACKS } from '../src/lib/track-registry';
import { loadGlbGeometry } from './lib/glb-geometry';

// The circuit is one built scene with two laps: the Grand Prix layout (the default) and the short one (`short`)
const SHORT = process.argv.includes('short');
const BASE = 'rwanda_official';
const ID = SHORT ? `${BASE}_short` : BASE;
const DIR = `public/tracks/${ID}`;
const WANT = SHORT
  ? { layout: 'Short layout', lengthM: 5340, samples: 1068, turns: 14, straightM: 880, stepM: 0.035, gradeMax: 0.16, modelM: 0.075, cameras: 11 }
  : { layout: 'Grand Prix layout', lengthM: 5895, samples: 1179, turns: 17, straightM: 990, stepM: 0.02, gradeMax: 0.15, modelM: 0.06, cameras: 12 };

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}

type Sample = RawTrackJson['samples'][number];
interface Meta {
  lengthMeters: number;
  direction: string;
  baseAltitudeM?: number;
  mesh: { url: string; scenery?: string[]; colliders: string[]; startLights: string[] };
  racingLine?: { physicsAiLapS?: number };
  racingLineGt3?: { physicsLapS?: number };
  aiPlans?: Record<string, { ok: boolean; wallHits: number; offTrackFrames: number }>;
  otherLayoutRoads?: [number, number][];
}

console.log('Circuit list');
const info = TRACKS.find((t) => t.id === ID);
check('the layout is listed', !!info && info.layout === WANT.layout && info.quality === 'original');
check('it is in the repository', REPO_TRACK_IDS.has(ID));
const venue = CIRCUIT_VENUES.find((v) => v.layouts.some((l) => l.id === ID));
check('RISE Motordrome offers the short lap, then the Grand Prix lap', venue?.name === 'RISE Motordrome' && venue.layouts.map((l) => l.id).join() === `${BASE}_short,${BASE}`, `${venue?.name}: ${venue?.layouts.map((l) => l.layout).join(' | ')}`);
check('the short lap is the default circuit and heads the list', DEFAULT_TRACK_ID === `${BASE}_short` && TRACKS[0].id === DEFAULT_TRACK_ID);
check('its track data is where the list says', info?.dataUrl === `/tracks/${ID}/track_data.json` && existsSync(`public${info.dataUrl}`));

console.log('Track data');
const raw = JSON.parse(readFileSync(`${DIR}/track_data.json`, 'utf8')) as RawTrackJson;
const meta = raw.metadata as unknown as Meta;
const S = raw.samples as Sample[];
const n = S.length;
check(`${(WANT.lengthM / 1000).toFixed(2)} km in ${WANT.samples} samples`, meta.lengthMeters === WANT.lengthM && n === WANT.samples && info?.lengthM === WANT.lengthM);
{
  let area = 0;
  let worstStep = 0;
  for (let i = 0; i < n; i++) {
    const a = S[i].p;
    const b = S[(i + 1) % n].p;
    area += a[0] * -b[2] - b[0] * -a[2];
    worstStep = Math.max(worstStep, Math.abs(Math.hypot(b[0] - a[0], b[2] - a[2]) - 5));
  }
  check('a closed lap, a sample every 5 m', worstStep < WANT.stepM, `worst step off by ${(worstStep * 1000).toFixed(1)} mm`);
  check('anticlockwise', area > 0 && meta.direction === 'anticlockwise' && info?.direction === 'anticlockwise');
}
check(`${WANT.turns} corners, numbered in order`, raw.turns.length === WANT.turns && raw.turns.every((t, i) => t.number === i + 1) && info?.turns === WANT.turns);
check('every sample of a corner names a listed one', S.every((s) => s.turn >= 0 && s.turn <= WANT.turns));
check('12 to 15 m wide', S.every((s) => s.w >= 12 && s.w <= 15));
{
  let climb = 0;
  let steepest = 0;
  for (let i = 0; i < n; i++) {
    const dy = S[(i + 1) % n].p[1] - S[i].p[1];
    if (dy > 0) climb += dy;
    steepest = Math.max(steepest, Math.abs(dy) / 5);
  }
  // (the link climbs from a stretch already at 14 % to the upper road: 15.2 %)
  check(`real hills: over 150 m climbed a lap, no grade past ${(WANT.gradeMax * 100).toFixed(1)} %`, climb > 150 && steepest <= WANT.gradeMax, `${climb.toFixed(0)} m, ${(steepest * 100).toFixed(1)} %`);
}
{
  // The published back straight: over a kilometre, downhill from the upper platform into the valley, rising into the hairpin
  const head = (i: number) => Math.atan2(S[(i + 1) % n].p[2] - S[i].p[2], S[(i + 1) % n].p[0] - S[i].p[0]);
  const bend = (i: number) => {
    let d = head((i + 1) % n) - head(i);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) / 5;
  };
  let best = { from: 0, len: 0 };
  let from = -1;
  for (let i = 0; i < 2 * n; i++) {
    if (bend(i % n) < 1 / 1500) {
      if (from < 0) from = i;
      if (i - from + 1 > best.len && i - from + 1 <= n) best = { from: from % n, len: i - from + 1 };
    } else from = -1;
  }
  const ys = Array.from({ length: best.len }, (_, k) => S[(best.from + k) % n].p[1]);
  const low = Math.min(...ys);
  check(`the back straight: ${SHORT ? 'nine hundred metres' : 'a kilometre'}, down into the valley and up into the hairpin`, best.len * 5 >= WANT.straightM && ys[0] - low > 45 && ys[ys.length - 1] - low > 8,
    `${best.len * 5} m from s=${best.from * 5}, ${ys[0].toFixed(0)} m down to ${low.toFixed(0)} m, ${ys[ys.length - 1].toFixed(0)} m at its end`);
}
check('altitude of the lake for the air density', meta.baseAltitudeM === 1328);
{
  const grid = raw.spawnGrid;
  const onRoad = grid.every((g) => Math.abs(g.lateral) + 1.2 < S[Math.round(g.s / 5) % n].w / 2);
  const staggered = grid.every((g, i) => i === 0 || (Math.abs(grid[i - 1].s - g.s - 8) < 0.01 && Math.sign(g.lateral) === -Math.sign(grid[i - 1].lateral)));
  check('20 grid slots on the road, 8 m apart, pole on the right', grid.length === 20 && onRoad && staggered && grid[0].lateral > 0 && grid[0].s > WANT.lengthM - 20);
}
check('three sectors, two activation zones, a pit lane', raw.sectors.length === 3 && raw.drsZones.length === 2 && raw.pitLane.centerline.length > 100);
{
  const wide = S.filter((s) => Math.abs(s.ro) > s.w / 2 + 0.6).length;
  const gt3 = S.filter((s) => typeof (s as Sample & { roGt3?: number }).roGt3 === 'number').length;
  check('an optimised racing line for both classes, inside the road', wide === 0 && gt3 === n && S.some((s) => Math.abs(s.ro) > 3));
  const plans = meta.aiPlans ?? {};
  check('every car drives its line cleanly on the full physics', ['vf26', 'f12026-car', 'amg-gt3'].every((c) => plans[c]?.ok && plans[c].wallHits === 0 && plans[c].offTrackFrames === 0),
    Object.entries(plans).map(([c, p]) => `${c} ${p.ok ? 'ok' : 'FAILED'}`).join(', '));
}

console.log('Model');
const GLB = `public${meta.mesh.url}`;
check('the model is where the track data says: one scene for both laps', meta.mesh.url === `/tracks/${BASE}/${BASE}.glb` && existsSync(GLB));
const bytes = statSync(GLB).size;
check('it stays under 20 MB', bytes < 20e6, `${(bytes / 1e6).toFixed(1)} MB`);
const root = loadGlbGeometry(GLB);
const byName = new Map(root.children.map((c) => [c.name, c]));
const tag = (name: string, key: string) => byName.get(name)?.userData[key];
{
  const names: string[] = [];
  root.traverse((o) => {
    names.push(o.name);
    if (typeof o.userData.materialName === 'string') names.push(o.userData.materialName);
  });
  check("nothing from the fan-made layout's source file", !names.some((x) => /^KN5_/i.test(x)));
}
check('road, kerbs, run-off, pit lane, gravel and grass carry their surfaces',
  tag('Track_Asphalt_Road', 'surface') === 'road' && tag('Track_Kerbs', 'surface') === 'kerb' && tag('Track_Runoff_Paint', 'surface') === 'runoff' &&
  tag('Track_Pitlane', 'surface') === 'pitlane' && tag('Ground_Gravel', 'surface') === 'gravel' && tag('Ground_Verge', 'surface') === 'grass' && tag('Terrain', 'surface') === 'grass');
check('the far terrain is left out of the physics', byName.has('Terrain_Far') && tag('Terrain_Far', 'surface') === undefined);
check('every collider the track data names is there', meta.mesh.colliders.every((c) => byName.get(c)?.userData.collider === (c === 'Track_Collider_Road' ? 'road' : 'wall')), meta.mesh.colliders.join(', '));
check('pit building, tower, stands, canopies, lake and start gantry are there',
  ['Prop_PitBuilding', 'Env_Spire', 'Prop_Grandstand_Main', 'Env_Grandstand_Canopies', 'Prop_Paddock_Village', 'Prop_Lakeside', 'Lake', 'Prop_StartGantry', 'Prop_StartLights_0'].every((x) => byName.has(x)));

// The ground as the game builds it, with the circuit's own surface table (its kerbs' blocks), and the same ground
// without the kerbs' ripple, to tell the blocks from the hump they stand on
const surfaceTable = resolveSurfaceTable((raw.metadata as { surfaceTable?: Parameters<typeof resolveSurfaceTable>[0] }).surfaceTable);
const ground = TrackColliderQuery.fromTrackRoot(root, surfaceTable);
const humps = TrackColliderQuery.fromTrackRoot(root, { ...surfaceTable, kerb: { ...surfaceTable.kerb, bumpHeightM: 0 } });
const hit = createGroundHit();
const right = (s: Sample): [number, number] => {
  const l = Math.hypot(s.t[0], s.t[2]);
  return [-s.t[2] / l, s.t[0] / l];
};
const LAT = [-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12];
{
  let worst = 0;
  let offRoad = 0;
  let probes = 0;
  for (const s of S) {
    const [rx, rz] = right(s);
    for (let k = 2; k <= 6; k++) {
      probes++;
      if (!ground.query(s.p[0] + rx * LAT[k], s.p[2] + rz * LAT[k], s.yProf[k] + 3, hit) || hit.surface !== 'road') offRoad++;
      else worst = Math.max(worst, Math.abs(hit.height - s.yProf[k]));
    }
  }
  check('the road is under every sample, 5 m either side', offRoad === 0, `${probes} probes`);
  check('its height is the track data\'s, to 1 cm', worst < 0.01, `worst ${(worst * 1000).toFixed(1)} mm`);
}
setActiveTrack(ID, raw);
const track = getActiveTrackData(1200);
{
  // The game's own samples (resampled and lightly smoothed along the lap) against the model
  let worst = 0;
  for (let i = 0; i < track.samples.length; i += 2) {
    const smp = track.samples[i];
    const b = Math.hypot(smp.binormal.x, smp.binormal.z);
    for (const lat of [-4, 0, 4]) {
      const x = smp.position.x + (smp.binormal.x / b) * lat;
      const z = smp.position.z + (smp.binormal.z / b) * lat;
      if (ground.query(x, z, smp.position.y + 3, hit)) worst = Math.max(worst, Math.abs(hit.height - evaluateSampleLateralHeightM(smp, lat)));
    }
  }
  // (the link hairpin turns over a crest: 5 m samples follow it to 7 cm)
  check(`the game's height model follows the road within ${(WANT.modelM * 100).toFixed(1)} cm`, worst < WANT.modelM, `worst ${(worst * 100).toFixed(1)} cm`);
}
if (SHORT) {
  // Where the link leaves the main road (1,160 m) cars are flat out, and the road they leave climbs at 14 % on its
  // banking. The link gave that grade up within 25 m: 15 m/s2 of lift at the 266 km/h an F1 car has there. Lift is
  // read off the model along the centre and 4 m either side of it, at that speed
  const v = 266 / 3.6;
  const n = track.samples.length;
  const ds = WANT.lengthM / n;
  const from = Math.round(1140 / ds);
  const to = Math.round(1260 / ds);
  const lift = [0, 0, 0];
  let missed = 0;
  [-4, 0, 4].forEach((lat, c) => {
    const h: number[] = [];
    for (let i = from - 1; i <= to + 1; i++) {
      const smp = track.samples[i];
      const b = Math.hypot(smp.binormal.x, smp.binormal.z);
      const ok = ground.query(smp.position.x + (smp.binormal.x / b) * lat, smp.position.z + (smp.binormal.z / b) * lat, smp.position.y + 3, hit);
      if (!ok) missed++;
      h.push(ok ? hit.height : NaN);
    }
    for (let k = 1; k < h.length - 1; k++) lift[c] = Math.max(lift[c], (-(h[k + 1] - 2 * h[k] + h[k - 1]) / (ds * ds)) * v * v);
  });
  check('the link leaves the main road without a crest: under 4.5 m/s2 of lift along its centre, 6 m/s2 4 m either side',
    missed === 0 && lift[1] < 4.5 && lift[0] < 6 && lift[2] < 6, `${lift.map((a) => a.toFixed(1)).join(' / ')} m/s2 at 266 km/h`);
}
{
  let kerbs = 0;
  let kerbMiss = 0;
  let runoff = 0;
  let runoffMiss = 0;
  // A kerb's blocks alone (the ground less the hump they stand on) at a point, m; NaN off a kerb
  const blockAt = (x: number, z: number, y: number): number => {
    if (!ground.query(x, z, y + 3, hit) || hit.surface !== 'kerb') return NaN;
    const h = hit.height;
    return humps.query(x, z, y + 3, hit) ? h - hit.height : NaN;
  };
  let climbing = 0;
  let falling = 0;
  let tallest = 0;
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    const [rx, rz] = right(s);
    for (const side of [-1, 1]) {
      const edge = s.w / 2;
      if ((side < 0 ? s.kL : s.kR) === 1) {
        kerbs++;
        const kx = s.p[0] + rx * side * (edge + 0.7);
        const kz = s.p[2] + rz * side * (edge + 0.7);
        if (!ground.query(kx, kz, s.p[1] + 3, hit) || hit.surface !== 'kerb') kerbMiss++;
        // Along the lap from here, 2 m in 5 cm steps: is a block climbed or come down from?
        const next = S[(i + 1) % S.length];
        const fl = Math.hypot(next.p[0] - s.p[0], next.p[2] - s.p[2]) || 1;
        const [fx, fz] = [(next.p[0] - s.p[0]) / fl, (next.p[2] - s.p[2]) / fl];
        let last = NaN;
        for (let d = 0; d <= 2; d += 0.05) {
          const b = blockAt(kx + fx * d, kz + fz * d, s.p[1]);
          if (b > tallest) tallest = b;
          if (b - last > 2e-4) climbing++;
          else if (last - b > 2e-4) falling++;
          last = b;
        }
      } else if ((side < 0 ? s.rL : s.rR) > 4) {
        runoff++;
        // (where the other route runs alongside, its asphalt or kerb is the paving)
        if (!ground.query(s.p[0] + rx * side * (edge + 2.5), s.p[2] + rz * side * (edge + 2.5), s.p[1] + 3, hit) || (hit.surface !== 'runoff' && hit.surface !== 'road' && hit.surface !== 'kerb')) runoffMiss++;
      }
    }
  }
  check('a kerb wherever the data flags one', kerbs > 400 && kerbMiss === 0, `${kerbs} probes`);
  // The kerbs' blocks under the wheels (the surface table's `bumpRise` ripple on the kerbs' humps): 0.8 m long, 16 mm
  // high in the kerb's middle, climbed over 0.65 m in the direction of the lap and come down from over 0.15 m
  const kerb = surfaceTable.kerb;
  check("a wheel feels the kerbs' blocks: 0.8 m long and 16 mm high, climbed along the lap over four fifths of their length",
    kerb.bumpLengthM === 0.8 && kerb.bumpHeightM === 0.016 && kerb.bumpRise === 0.8125 && tallest > 0.014 && tallest <= 0.0161 &&
      climbing / (climbing + falling) > 0.72 && climbing / (climbing + falling) < 0.9,
    `tallest ${(tallest * 1000).toFixed(1)} mm, climbing on ${((100 * climbing) / (climbing + falling)).toFixed(0)} % of the way`);
  // The blocks one sees (scripts/rwanda-official/bl_kerbs.py) carry no surface: they are the ones under the wheels,
  // drawn 5 mm higher, block for block
  const blocks = byName.get('Track_Kerb_Blocks');
  let onKerb = 0;
  let under = 0;
  let over = 0;
  const v = new THREE.Vector3();
  blocks?.updateWorldMatrix(true, true);
  blocks?.traverse((o) => {
    const pos = (o as THREE.Mesh).geometry?.getAttribute('position');
    for (let i = 0; pos && i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (!ground.query(v.x, v.z, v.y + 0.3, hit) || hit.surface !== 'kerb') continue;
      onKerb++;
      if (v.y - hit.height < 0.003) under++;
      if (v.y - hit.height > 0.007) over++;
    }
  });
  check("the kerbs' blocks one sees are the ones under the wheels, 5 mm higher and no surface themselves",
    tag('Track_Kerb_Blocks', 'surface') === undefined && tag('Track_Kerbs_Alt', 'surface') === 'kerb' && onKerb > 80000 && under === 0 && over === 0,
    `${onKerb} corners of blocks, ${under} less than 3 mm over the ground there, ${over} more than 7 mm over`);
  check('painted run-off wherever the data gives one', runoff > 400 && runoffMiss === 0, `${runoff} probes`);
  const pit = raw.pitLane.centerline;
  const lane = pit.slice(12, pit.length - 12).filter((p) => ground.query(p[0], p[2], p[1] + 3, hit) && hit.surface === 'pitlane').length;
  check('the pit lane drives as pit lane', lane === pit.length - 24, `${lane} of ${pit.length - 24} points`);
}
{
  // No ledge anywhere a car can get to: every metre of the lap, from the centre out to the first barrier in 25 cm
  // steps. Where the three extra road sections join the built lap two sets of ground lie over each other, and the
  // game drives on the higher paved one: one left low or high there is a step under a wheel
  const walls = TrackWallQuery.fromTrackRoot(root);
  const nearWalls = new Int32Array(64);
  let steps = 0;
  let worst = 0;
  let worstAt = '';
  let probes = 0;
  for (let s = 0; s < track.totalLengthM; s += 1) {
    const smp = track.getSampleAtDistance(s);
    const b = Math.hypot(smp.binormal.x, smp.binormal.z);
    for (const side of [-1, 1]) {
      let prev = NaN;
      for (let lat = 0; lat <= 40; lat += 0.25) {
        const x = smp.position.x + (smp.binormal.x / b) * lat * side;
        const z = smp.position.z + (smp.binormal.z / b) * lat * side;
        if (walls.near(x, z, 0.3, nearWalls) > 0 || !ground.query(x, z, smp.position.y + 5, hit)) break;
        probes++;
        const step = Math.abs(hit.height - prev);
        if (step > 0.06) {
          steps++;
          if (step > worst) {
            worst = step;
            worstAt = `, worst ${(step * 100).toFixed(0)} cm at ${s} m, ${(lat * side).toFixed(2)} m to the side`;
          }
        }
        prev = hit.height;
      }
    }
  }
  check('no step over 6 cm between the barriers', steps === 0, `${probes} probes, ${steps} steps${worstAt}`);
}
{
  // Barriers: from every sample, the first wall to each side is where the data puts it
  const walls = TrackWallQuery.fromTrackRoot(root);
  const ids = new Int32Array(4096);
  let worst = 0;
  let open = 0;
  for (const s of S) {
    const [rx, rz] = right(s);
    for (const side of [-1, 1]) {
      const want = side < 0 ? s.wL : s.wR;
      const dx = rx * side;
      const dz = rz * side;
      let first = Infinity;
      const count = walls.near(s.p[0], s.p[2], want + 30, ids);
      for (let k = 0; k < count; k++) {
        const o = ids[k] * WALL_SEGMENT_STRIDE;
        const ax = walls.segments[o] - s.p[0];
        const az = walls.segments[o + 1] - s.p[2];
        const ex = walls.segments[o + 2] - walls.segments[o];
        const ez = walls.segments[o + 3] - walls.segments[o + 1];
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const along = (ax * ez - az * ex) / den;
        const on = (ax * dz - az * dx) / den;
        if (along > 0 && on >= -0.02 && on <= 1.02) first = Math.min(first, along);
      }
      if (!Number.isFinite(first)) open++;
      else worst = Math.max(worst, Math.abs(first - want));
    }
  }
  check('a barrier on both sides of every sample', open === 0, `${walls.segmentCount} wall segments`);
  check('each one where the track data puts it', worst < 0.8, `worst ${worst.toFixed(2)} m`);
}
{
  const start = track.getSampleAtDistance(0);
  const fwd = start.tangent.clone().normalize();
  const across = start.binormal.clone().normalize();
  const v = new THREE.Vector3();
  const f: number[] = [];
  const r: number[] = [];
  const y: number[] = [];
  byName.get(meta.mesh.startLights[0])!.traverse((o) => {
    const pos = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry.getAttribute('position') : undefined;
    for (let i = 0; pos && i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).sub(start.position);
      f.push(v.dot(fwd));
      r.push(v.dot(across));
      y.push(v.y);
    }
  });
  const span = (a: number[]) => Math.max(...a) - Math.min(...a);
  check('the start lights: a thin panel across the road, ahead of the grid and above it',
    span(f) < 0.5 && span(r) > 2 && span(r) < 4 && Math.min(...f) > 0 && Math.max(...f) < 25 && Math.min(...y) > 4.5 && Math.max(...y) < 8 && Math.abs(Math.max(...r) + Math.min(...r)) < 0.5,
    `${span(f).toFixed(2)} m deep, ${span(r).toFixed(2)} m wide, ${Math.min(...f).toFixed(1)} m past the line, ${Math.min(...y).toFixed(1)} m up`);
}

console.log("The other lap's road");
{
  const OTHER = SHORT ? BASE : `${BASE}_short`;
  const otherRaw = JSON.parse(readFileSync(`public/tracks/${OTHER}/track_data.json`, 'utf8')) as RawTrackJson;
  const O = otherRaw.samples as Sample[];
  const stretches = meta.otherLayoutRoads ?? [];
  const want = otherLayoutRoads(ID, raw, otherRaw);
  setActiveTrack(ID, raw);
  check(`where the ${SHORT ? 'Grand Prix' : 'short'} lap's road leaves this one is in the track data, as the two laps give it`,
    stretches.length === (SHORT ? 3 : 4) && JSON.stringify(stretches) === JSON.stringify(want), stretches.map(([a, b]) => `${a}-${b} m`).join(', '));

  const L = track.totalLengthM;
  const dt = 1 / 60;
  const wrapHalf = (d: number) => ((((d + L / 2) % L) + L) % L) - L / 2;
  // Steers along the other lap's samples from `k` on: a few samples ahead, at 80 % of that lap's line speed
  const follow = (car: F12026CarSim, k: number): { k: number; inputs: Record<string, number> } => {
    const x = car.worldPosition.x;
    const z = car.worldPosition.z;
    const d = (i: number) => Math.hypot(O[i].p[0] - x, O[i].p[2] - z);
    while (k + 1 < O.length && d(k + 1) < d(k)) k++;
    const v = car.telemetry.speedKmh / 3.6;
    const aim = O[Math.min(O.length - 1, k + Math.round(Math.max(3, Math.min(8, (v * 0.55) / 5))))].p;
    const q = car.worldQuaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const dl = Math.hypot(aim[0] - x, aim[2] - z) || 1;
    const right = ((aim[0] - x) * -fz + (aim[2] - z) * fx) / dl;
    const want = (Math.min(...O.slice(k, k + 30).map((o) => o.v)) / 3.6) * 0.8;
    return { k, inputs: { throttle: v < want ? 1 : 0, brake: v > want + 4 ? 0.8 : 0, analogSteer: THREE.MathUtils.clamp(right * 2.5, -1, 1), steerLeft: 0, steerRight: 0 } };
  };

  // A car stopped on the other lap's asphalt past this lap's edge, in every stretch (where it is under 34 m out, so the
  // lap position still follows it): off the track; on this lap's road at the same point it is not
  const car = new F12026CarSim(track, root);
  const parked = (s: number, lat: number) => {
    car.teleportToDistance(s, 0, lat);
    for (let i = 0; i < 30; i++) car.step(dt, {});
    return car.telemetry.offTrack;
  };
  const spots: string[] = [];
  let wrong = 0;
  let hint: number | undefined;
  const far = stretches.map(() => ({ s: 0, lat: 0 }));
  for (const o of O) {
    const p = track.projectWorldToTrack(o.p[0], o.p[2], hint);
    hint = p.s;
    const i = stretches.findIndex(([a, b]) => p.s >= a && p.s <= b);
    if (i >= 0 && Math.abs(p.lateralOffset) < 34 && Math.abs(p.lateralOffset) > Math.abs(far[i].lat)) far[i] = { s: p.s, lat: p.lateralOffset };
  }
  far.forEach(({ s, lat }, i) => {
    const onAsphalt = ground.query(...((): [number, number, number] => {
      const sm = track.getSampleAtDistance(s);
      const b = Math.hypot(sm.binormal.x, sm.binormal.z);
      return [sm.position.x + (sm.binormal.x / b) * lat, sm.position.z + (sm.binormal.z / b) * lat, sm.position.y + 5];
    })(), hit) && (hit.surface === 'road' || hit.surface === 'kerb');
    const off = parked(s, lat);
    const own = parked(s, 0);
    if (!onAsphalt || !off || own) wrong++;
    spots.push(`${stretches[i][0]}-${stretches[i][1]} m: ${lat.toFixed(0)} m out at ${s.toFixed(0)} m ${off ? 'off' : 'ON'}${onAsphalt ? '' : ' (not asphalt)'}${own ? ', own road OFF' : ''}`);
  });
  check("parked on the other lap's asphalt it is off the track, on this lap's road it is not", wrong === 0, spots.join('; '));

  // Driving: the autopilot on this lap's line from a flying start to `untilS`; from `cut` on, the other lap's road.
  // Race-style (judged) limits, so only a cut deletes the lap; the race clock follows the car
  const drive = (untilS: number, cut?: { fromS: number; k: number; toK: number }) => {
    const c = new F12026CarSim(track, root);
    c.trackLimitsMode = 'judged';
    c.resetToStartGrid(true);
    c.aiAutopilot = true;
    const clock = new LapClock(L);
    clock.reset(c.sMeters);
    let t = 0;
    let k = -1;
    let crossed = false;
    let prevS = c.sMeters;
    const out = { hopAt: null as null | number, hops: 0, offFrames: 0, invalidBeforeHop: false, invalidAfter: false, clockDropped: false, sector1: null as number | null, onLink: false };
    for (let i = 0; i < 60 * 90; i++) {
      if (cut && crossed && k < 0 && c.sMeters > cut.fromS && c.sMeters < cut.fromS + 100) {
        c.aiAutopilot = false;
        k = cut.k;
      }
      let inputs = {};
      if (k >= 0 && k < cut!.toK) {
        const f = follow(c, k);
        k = f.k;
        inputs = f.inputs;
        if (k >= cut!.toK) c.aiAutopilot = true;
      }
      c.step(dt, inputs);
      clock.update(c.sMeters, (t += dt), 10);
      const ds = wrapHalf(c.sMeters - prevS);
      prevS = c.sMeters;
      if (!crossed) {
        crossed = !c.telemetry.lapInvalid && c.sMeters < 200 && c.sMeters > 0 && c.telemetry.currentLapTimeMs > 0;
        continue;
      }
      if (c.telemetry.offTrack) out.offFrames++;
      if (Math.abs(ds) > 100) {
        out.hops++;
        out.hopAt ??= c.sMeters;
        out.clockDropped = clock.distM < 0;
      }
      if (out.hopAt === null && c.telemetry.lapInvalid) out.invalidBeforeHop = true;
      if (out.hopAt !== null) out.invalidAfter = c.telemetry.lapInvalid === true;
      if (c.sMeters > untilS && c.sMeters < untilS + 200 && (!cut || k >= cut.toK)) break;
    }
    out.sector1 = c.telemetry.bestSectorTimesMs[0];
    return out;
  };
  if (!SHORT) {
    // The short lap's link: its samples from 1,080 to 1,460 m
    const cut = drive(2000, { fromS: 1000, k: 216, toK: 292 });
    check("taking the short lap's link: off the track on it, and the lap jumps the loop",
      cut.offFrames > 60 && cut.hops === 1 && cut.hopAt !== null && cut.hopAt > 1800, `${cut.offFrames} frames off, ${cut.hops} jump(s), to ${cut.hopAt?.toFixed(0)} m`);
    check('the lap is cut, and its first sector is no best', !cut.invalidBeforeHop && cut.invalidAfter && cut.sector1 === null, `sector 1 ${cut.sector1}`);
    check('the race clock does not count it: a lap back from where the car is', cut.clockDropped);
  }
  const own = drive(SHORT ? 1500 : 2000);
  check(`the ${SHORT ? 'link' : 'loop'} on this lap's own line: on the track all the way, the lap counts`,
    own.offFrames === 0 && own.hops === 0 && !own.invalidBeforeHop && !own.invalidAfter, `${own.offFrames} frames off, ${own.hops} jump(s)`);
}

console.log('Around the track');
check('road bridge, roads, causeway, screens, TV towers, open stands and service vehicles are there',
  ['Prop_RoadBridge', 'Ground_Roads', 'Ground_Causeway', 'Ground_ServiceRoad', 'Prop_Screens', 'Prop_TVTowers', 'Prop_Stands_Open', 'Prop_Vehicles'].every((x) => byName.has(x)));
check('kart circuit, fan zones and the far woodland\'s canopy are there', ['Prop_Kart', 'Prop_FanZones', 'Env_ForestCanopy'].every((x) => byName.has(x)));
check('the roads, their lines and the causeway lie on the ground as decals',
  ['Ground_Roads', 'Ground_Road_Lines', 'Ground_Causeway', 'Ground_Helipad'].every((x) => tag(x, 'decal') === true));
{
  // Every triangle of the buildings and props, sampled every 2 m: none of it may stand on the road or hang low over it
  const CELL = 25;
  const cells = new Set<string>();
  for (const sm of S) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cells.add(`${Math.floor(sm.p[0] / CELL) + dx},${Math.floor(sm.p[2] / CELL) + dz}`);
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const q = new THREE.Vector3();
  const lowest = new Map<string, number>();
  let probes = 0;
  for (const node of root.children) {
    if (!/^(Prop_|Env_)/.test(node.name)) continue;
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      const index = mesh.geometry.getIndex();
      const count = index ? index.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        const [ia, ib, ic] = index ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)] : [i, i + 1, i + 2];
        a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
        const steps = Math.min(40, Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / 2)));
        for (let u = 0; u <= steps; u++) {
          for (let v = 0; u + v <= steps; v++) {
            q.copy(a).multiplyScalar(1 - (u + v) / steps).addScaledVector(b, u / steps).addScaledVector(c, v / steps);
            if (!cells.has(`${Math.floor(q.x / CELL)},${Math.floor(q.z / CELL)}`)) continue;
            probes++;
            if (!ground.query(q.x, q.z, q.y + 0.5, hit) || (hit.surface !== 'road' && hit.surface !== 'kerb')) continue;
            lowest.set(node.name, Math.min(lowest.get(node.name) ?? Infinity, q.y - hit.height));
          }
        }
      }
    });
  }
  const over = [...lowest].sort((x, y) => x[1] - y[1]);
  check('nothing built stands on the road or hangs under 4.5 m over it', over.every(([, h]) => h > 4.5),
    `${probes} probes; lowest: ${over.slice(0, 3).map(([name, h]) => `${name} ${h.toFixed(1)} m`).join(', ')}`);
  const deck = lowest.get('Prop_RoadBridge');
  check('the road bridge crosses the track with over 5 m to spare', deck !== undefined && deck > 5 && deck < 8, `${deck?.toFixed(2)} m`);
}
{
  // Each trackside TV camera stands on its scaffold tower: the tower's top is just under the lens
  const cams = raw.cameras as { position: number[] }[];
  const tops = cams.map(() => -Infinity);
  const v = new THREE.Vector3();
  byName.get('Prop_TVTowers')!.traverse((o) => {
    const pos = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry.getAttribute('position') : undefined;
    for (let i = 0; pos && i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      cams.forEach((cam, k) => {
        if (Math.hypot(v.x - cam.position[0], v.z - cam.position[2]) < 1.8) tops[k] = Math.max(tops[k], v.y - cam.position[1]);
      });
    }
  });
  const under = tops.slice(1);
  check('a scaffold tower under every trackside TV camera, its top just below the lens', cams.length === WANT.cameras && under.every((t) => t > -0.7 && t < -0.1),
    `${under.map((t) => t.toFixed(2)).join(' ')}`);
}

console.log('Trees and shrubs');
void (async () => {
  const FOLIAGE = `public${meta.mesh.scenery?.[0] ?? ''}`;
  check('the track data names its scenery file', meta.mesh.scenery?.length === 1 && existsSync(FOLIAGE), FOLIAGE);
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(FOLIAGE);
  const sceneryRoot = doc.getRoot().listScenes()[0]?.listChildren()[0];
  const extras = (sceneryRoot?.getExtras() ?? {}) as { replaces?: string[]; credits?: SceneryCredit[]; counts?: Record<string, number> };
  check('it hides nothing of the circuit', Array.isArray(extras.replaces) && extras.replaces.length === 0);
  check('its credits are the in-app credits of the two models', JSON.stringify(extras.credits) === JSON.stringify(SCENERY_CREDITS.filter((c) => c.id === 'acacia' || c.id === 'shrub')) && extras.credits?.length === 2);
  check('the copyright line names both authors', SCENERY_CREDITS.filter((c) => c.id === 'acacia' || c.id === 'shrub').every((c) => (doc.getRoot().getAsset().copyright ?? '').includes(c.author)));
  check('the credits file beside it says the same', JSON.stringify(JSON.parse(readFileSync(`public/tracks/${BASE}/scenery/credits.json`, 'utf8'))) === JSON.stringify(extras.credits));
  const perModel: Record<string, number> = {};
  let onTrack = 0;
  let floating = 0;
  let buried = 0;
  const t = [0, 0, 0];
  const sc = [0, 0, 0];
  for (const node of sceneryRoot?.listChildren() ?? []) {
    const level = node.getExtras() as { tile?: string; level?: number };
    const batch = node.getExtension('EXT_mesh_gpu_instancing') as { getAttribute(s: string): { getCount(): number; getElement(i: number, o: number[]): number[] } | null } | null;
    if (!batch || level.level !== 0 || typeof level.tile !== 'string') continue;
    const tr = batch.getAttribute('TRANSLATION')!;
    const scale = batch.getAttribute('SCALE')!;
    const model = level.tile.split(':')[0];
    perModel[model] = (perModel[model] ?? 0) + tr.getCount();
    for (let i = 0; i < tr.getCount(); i++) {
      tr.getElement(i, t);
      scale.getElement(i, sc);
      if (!ground.query(t[0], t[2], t[1] + 5, hit)) continue;
      if (hit.surface !== 'grass') onTrack++;
      if (t[1] > hit.height + 0.05) floating++;
      if (t[1] < hit.height - 0.2 * sc[1] - 0.05) buried++;
    }
  }
  check('as many trees and shrubs as it says', perModel.acacia === extras.counts?.acacia && perModel.shrub === extras.counts?.shrub && perModel.acacia > 5000, JSON.stringify(perModel));
  check('none on the road, kerbs, run-off, gravel or pit lane', onTrack === 0, `${onTrack}`);
  check('none floating or buried', floating === 0 && buried === 0, `${floating} floating, ${buried} buried`);
  console.log(`\nAll ${passed} checks of RISE Motordrome passed.`);
})();
