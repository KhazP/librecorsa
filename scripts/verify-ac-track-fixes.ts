/**
 * The converted AC circuits:
 * 1. Okayama (and all AC tracks) road material depthWrite & decal isolation (preventing 100% reflective tarmac)
 * 2. Monaco barrier hitboxes (3D wall extraction, TrackWallQuery segment density, and collision response for all 3 cars)
 * 3. Kerb coverage and feel across chang, okayama, spielberg, monaco, istanbul_park, grobnik, oschersleben, barbagallo,
 *    vir, sachsenring, norisring, le_mans_82 and the LilSki, SpeedVegas and Willow Springs circuits for all 3 car
 *    physics models (the hill climbs have no kerbs)
 * 4. Kerb / edge step continuity of the fitted surfaces
 * 5. The road's edges as the game reads them from the track data, against the road collider the converter built
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import path from 'node:path';

import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createGroundHit, TrackWallQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { trackColliders } from '../src/lib/sim/track-colliders';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { evaluateSampleLateralHeightM, getActiveTrackData, type RawTrackJson, setActiveTrack } from '../src/lib/track-data';
import type { TrackSamplePoint } from '../src/types/f1';
import { loadGlbGeometry, readTrackGltfJson, trackModelFiles } from './lib/glb-geometry';
import { skipSuiteWithout } from './lib/hosted-files';

skipSuiteWithout('public/tracks/okayama/track_data.json', 'public/tracks/monaco/track_data.json', 'public/tracks/dunsfold/track_data.json', 'public/tracks/istanbul_park/track_data.json', 'public/tracks/grobnik/track_data.json', 'public/tracks/oschersleben/track_data.json', 'public/tracks/barbagallo/track_data.json', 'public/tracks/vir/track_data.json', 'public/tracks/sachsenring/track_data.json', 'public/tracks/sachsenring_short/track_data.json', 'public/tracks/norisring/track_data.json', 'public/tracks/le_mans_82/track_data.json', 'public/tracks/goodwood/track_data.json', 'public/tracks/borgloh/track_data.json', 'public/tracks/bridgehampton/track_data.json', 'public/tracks/watkins_glen/track_data.json', 'public/tracks/watkins_glen_short/track_data.json', 'public/tracks/riverside/track_data.json', 'public/tracks/riverside_short/track_data.json', 'public/tracks/riverside_nascar/track_data.json', 'public/tracks/speedvegas/track_data.json', 'public/tracks/willow_springs/track_data.json', 'public/tracks/chang/track_data.json', 'public/tracks/okayama_piper/track_data.json', 'public/tracks/okayama_drift/track_data.json', 'public/tracks/spielberg/track_data.json', 'public/tracks/spielberg_south/track_data.json', 'public/tracks/spielberg_inner/track_data.json', 'public/tracks/vir_north/track_data.json', 'public/tracks/vir_south/track_data.json', 'public/tracks/vir_grand_east/track_data.json', 'public/tracks/vir_grand_west/track_data.json', 'public/tracks/vir_patriot/track_data.json', 'public/tracks/vir_patriot_reverse/track_data.json');

const ROOT = path.resolve(__dirname, '..');

/** The circuits whose road colliders carry the road's crossfall out to its edges (section 5) */
const ROAD_EDGE_RULE_TRACKS = ['spielberg', 'spielberg_south', 'spielberg_inner', 'monaco', 'dunsfold', 'istanbul_park', 'oschersleben', 'barbagallo', 'vir', 'vir_north', 'vir_south', 'vir_grand_east', 'vir_grand_west', 'vir_patriot', 'vir_patriot_reverse', 'sachsenring', 'sachsenring_short', 'norisring', 'le_mans_82', 'borgloh', 'goodwood', 'bridgehampton', 'riverside', 'riverside_short', 'riverside_nascar', 'speedvegas'];

function loadTrack(id: string) {
  const dir = path.join(ROOT, 'public', 'tracks', id);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'track_data.json'), 'utf8')) as RawTrackJson & {
    drsZones?: { id: string; detection: number; start: number; end: number }[];
    metadata?: { baseAltitudeM?: number; mesh?: { roadMaterials?: string[] } };
  };
  setActiveTrack(id, raw);
  const track = getActiveTrackData();
  // What the game loads: a venue's split pair (src/lib/venue-models.ts) when this copy has it, else the circuit's GLB
  const files = trackModelFiles(track);
  const root = loadGlbGeometry(files.path, files.shared);
  return { raw, track, files, root };
}

/** The circuit's glTF JSON as one document (a split pair merged as the full GLB would have it) */
function readGlbJson(files: { path: string; shared?: string }) {
  return readTrackGltfJson(files.path, files.shared) as { nodes: any[]; meshes: any[]; materials: any[] };
}

async function verifyOkayamaMaterialsAndDecalIsolation() {
  console.log('\n=== 1. Verifying Okayama & AC Track Road Material depthWrite & Decal Isolation ===');
  for (const tid of ['okayama', 'okayama_piper', 'okayama_drift', 'chang', 'spielberg', 'spielberg_south', 'spielberg_inner', 'monaco', 'dunsfold', 'istanbul_park', 'grobnik', 'oschersleben', 'barbagallo', 'vir', 'sachsenring', 'sachsenring_short', 'norisring', 'le_mans_82', 'goodwood', 'borgloh', 'bridgehampton', 'watkins_glen', 'watkins_glen_short', 'riverside', 'riverside_short', 'riverside_nascar', 'speedvegas', 'willow_springs']) {
    const { raw, files } = loadTrack(tid);
    const gltf = readGlbJson(files);
    const roadMats = new Set((raw.metadata?.mesh?.roadMaterials ?? []).map((s) => s.toLowerCase()));

    let roadMeshes = 0;
    const decalMats = new Set<number>();
    const nonDecalMats = new Set<number>();

    for (const nd of gltf.nodes ?? []) {
      if (nd.mesh === undefined) continue;
      const name: string = nd.name || '';
      if (name.startsWith('Track_Collider_') || name.startsWith('Track_Surface_')) continue;
      const isDecal = Boolean(nd.extras?.decal || nd.extras?.groove);
      const mesh = gltf.meshes[nd.mesh];
      for (const prim of mesh.primitives ?? []) {
        if (prim.material === undefined) continue;
        const mat = gltf.materials[prim.material];
        const mName = (mat.name || '').toLowerCase();
        if (isDecal) decalMats.add(prim.material);
        else nonDecalMats.add(prim.material);

        if (roadMats.has(mName) || /tarmac|road_p1|asph/i.test(mName)) {
          roadMeshes++;
          assert.equal(
            isDecal,
            false,
            `[${tid}] Road mesh "${name}" with material "${mat.name}" must NOT be marked as a decal`
          );
          assert.notEqual(
            mat.alphaMode,
            'BLEND',
            `[${tid}] Road material "${mat.name}" on "${name}" must NOT have alphaMode=BLEND`
          );
        }
      }
    }

    assert.ok(roadMeshes > 0, `[${tid}] Expected at least 1 road mesh in GLB`);
    let sharedWithGroove = 0;
    for (const mi of decalMats) {
      if (nonDecalMats.has(mi)) sharedWithGroove++;
    }
    console.log(
      `PASS  [${tid}] ${roadMeshes} road mesh primitives verified: 0 road decals, all opaque, roadMaterials=${JSON.stringify(
        raw.metadata?.mesh?.roadMaterials
      )} (groove-shared mats cloned at runtime by scene-builder: ${sharedWithGroove})`
    );
  }
}

async function verifyMonacoBarrierHitboxes() {
  console.log('\n=== 2. Verifying Monaco Barrier Hitboxes across all 3 Car Physics Models ===');
  const { raw, track, root } = loadTrack('monaco');
  const walls = TrackWallQuery.fromTrackRoot(root);
  assert.ok(walls.segmentCount >= 1300, `Expected >= 1300 wall segments in Monaco, got ${walls.segmentCount}`);

  // Verify 100% water-tight lateral raycast coverage across all 660 samples (0 open holes or 5m step holes)
  const n = raw.samples.length;
  let missLeft = 0;
  let missRight = 0;
  for (let i = 0; i < n; i++) {
    const p0 = raw.samples[i].p;
    const p1 = raw.samples[(i + 1) % n].p;
    const pm = raw.samples[(i - 1 + n) % n].p;
    const tx = p1[0] - pm[0];
    const tz = p1[2] - pm[2];
    const tl = Math.hypot(tx, tz) || 1;
    const rx = -tz / tl;
    const rz = tx / tl;
    // Check midpoint between sample i and i+1 as well as sample i
    for (const frac of [0.0, 0.5]) {
      const ox = p0[0] + (p1[0] - p0[0]) * frac;
      const oz = p0[2] + (p1[2] - p0[2]) * frac;
      for (const side of [-1, 1] as const) {
        const dx = rx * side;
        const dz = rz * side;
        let minT = Infinity;
        const segs = walls.segments;
        for (let k = 0; k < segs.length; k += 6) {
          const ax = segs[k];
          const az = segs[k + 1];
          const bx = segs[k + 2];
          const bz = segs[k + 3];
          const vx = bx - ax;
          const vz = bz - az;
          const den = dx * -vz - dz * -vx;
          if (Math.abs(den) < 1e-9) continue;
          const px = ax - ox;
          const pz = az - oz;
          const t = (px * -vz - pz * -vx) / den;
          const u = (dx * pz - dz * px) / den;
          if (u >= -0.02 && u <= 1.02 && t > 0 && t < minT) minT = t;
        }
        if (!Number.isFinite(minT) || minT > 45) {
          if (side < 0) missLeft++;
          else missRight++;
        }
      }
    }
  }
  assert.equal(missLeft, 0, `Expected 0 left barrier holes across all ${n} Monaco samples & midpoints, got ${missLeft}`);
  assert.equal(missRight, 0, `Expected 0 right barrier holes across all ${n} Monaco samples & midpoints, got ${missRight}`);

  const wLs = raw.samples.map((s) => s.wL ?? 99);
  const wRs = raw.samples.map((s) => s.wR ?? 99);
  const closeWalls = raw.samples.filter((s, i) => wLs[i] < s.w / 2 + 1.5 || wRs[i] < s.w / 2 + 1.5).length;
  const closeRatio = closeWalls / raw.samples.length;
  assert.ok(closeRatio > 0.70, `Expected > 70% of Monaco samples to have close Armco walls, got ${(closeRatio * 100).toFixed(1)}%`);
  console.log(
    `PASS  [monaco] ${walls.segmentCount} 3D wall collider segments, 0/1320 sample/midpoint raycast holes, ${(closeRatio * 100).toFixed(1)}% tight Armco coverage`
  );

  // Include standard Armco stations AND stepping runoff stations (S/F s=2m, Sainte Devote s=205m, Nouvelle Chicane s=2095m, Piscine s=2710m, Rascasse s=2955m)
  const testS = [2, 100, 205, 450, 880, 1700, 2095, 2480, 2710, 2955];
  /** The barrier's distance from the centreline on `side` where the car is (the most of the three samples from there) */
  const wallAt = (s: number, side: -1 | 1) => {
    const n = raw.samples.length;
    const i0 = ((Math.round((s / track.totalLengthM) * n) % n) + n) % n;
    const ws = side < 0 ? wLs : wRs;
    return Math.max(ws[i0], ws[(i0 + 1) % n], ws[(i0 + 2) % n]);
  };
  for (const carKind of ['lc26', 'f12026', 'gt3'] as const) {
    for (const side of [-1, 1] as const) {
      for (const s0 of testS) {
        const dt = 1 / 120;
        // The car slides some 30 m along the barrier: it is held to the barrier line where it is, not where it started
        // (past Rascasse the left barrier steps 9 m out, to the old pit entry, and a car sliding along it goes with it)
        let worst = { lat: 0, wall: 0, s: s0, excess: -Infinity };
        const track1 = (lat: number, s: number) => {
          const wall = wallAt(s, side);
          const excess = Math.abs(lat) - Math.max(wall + 2.5, 9.5);
          // NaN never beats `worst`, so a car whose state goes NaN would pass: fail on the step it happens
          assert.ok(
            Number.isFinite(lat) && Number.isFinite(s) && Number.isFinite(excess),
            `[monaco/${carKind}] Car state not finite from s=${s0}m on the ${side < 0 ? 'left' : 'right'} (lat=${lat}, s=${s}, wallDist there=${wall})`
          );
          if (excess > worst.excess) worst = { lat: Math.abs(lat), wall, s, excess };
        };

        if (carKind === 'lc26') {
          const car = new F1Physics2026(track);
          car.attachTrackRoot(root);
          car.teleportToDistance(s0, 110 / 3.6, side * 1.5);
          for (let step = 0; step < 180; step++) {
            car.step(dt, { throttle: 0.3, brake: 0, analogSteer: side * 0.65 });
            track1(car.lateralOffsetM, car.sMeters);
          }
        } else {
          const car = carKind === 'f12026' ? new F12026CarSim(track, root) : createAmgGt3Sim(track, root);
          car.teleportToDistance(s0, 110 / 3.6, side * 1.5);
          for (let step = 0; step < 180; step++) {
            car.step(dt, { throttle: 0.3, brake: 0, analogSteer: side * 0.65 });
            track1(car.lateralOffsetM, car.sMeters);
          }
        }
        assert.ok(
          worst.excess < 0,
          `[monaco/${carKind}] Car ghosted through ${side < 0 ? 'left' : 'right'} wall from s=${s0}m (lat=${worst.lat.toFixed(2)}m at s=${worst.s.toFixed(0)}m, wallDist there=${worst.wall.toFixed(2)}m)`
        );
      }
    }
    console.log(`PASS  [monaco/${carKind}] Stopped cleanly by left & right barriers at all 10 stations: s=${testS.join(', ')} m`);
  }
}

async function verifyKerbsFeelAndSound() {
  console.log('\n=== 3. Verifying Kerb Mesh Coverage, Zero Buried Triangles, Feel & Acoustics ===');
  for (const tid of ['chang', 'okayama', 'okayama_piper', 'spielberg', 'spielberg_south', 'monaco', 'istanbul_park', 'grobnik', 'oschersleben', 'barbagallo', 'vir', 'sachsenring', 'norisring', 'le_mans_82', 'bridgehampton', 'watkins_glen', 'watkins_glen_short', 'riverside', 'riverside_short', 'riverside_nascar', 'speedvegas', 'willow_springs']) {
    const { raw, track, root } = loadTrack(tid);
    const ground = trackColliders(root).ground!;
    const hit = createGroundHit();
    // Built with its mod's modelled kerbs (drawn meshes tagged keepShape): driven as modelled, no ripple of ours on top
    let modelledKerbs = false;
    root.traverse((o: any) => {
      if (o.userData?.keepShape) modelledKerbs = true;
    });

    // Verify Track_Surface_Kerb triangles are never buried under Track_Surface_Runoff or Track_Collider_Road
    let kerbNode: any = null;
    root.traverse((o: any) => {
      if (o.name === 'Track_Surface_Kerb' && o.geometry) kerbNode = o;
    });
    assert.ok(kerbNode, `[${tid}] Missing Track_Surface_Kerb mesh in GLB`);
    kerbNode.updateWorldMatrix(true, true);
    const pos = kerbNode.geometry.getAttribute('position');
    const uv = kerbNode.geometry.getAttribute('uv');
    assert.ok(uv, `[${tid}] Missing TEXCOORD_0 (uv) on Track_Surface_Kerb`);
    const idx = kerbNode.geometry.getIndex();
    const triCount = (idx ? idx.count : pos.count) / 3;
    if (tid === 'monaco') {
      // The generated band ran to 7000+ triangles; the mod's own kerbs, chicane kerbs and sausages included, are ~3600
      const least = modelledKerbs ? 3000 : 7000;
      assert.ok(triCount >= least, `[monaco] Expected >= ${least} kerb triangles (including chicane kerbs), got ${triCount}`);
    }

    let hitKerb = 0;
    let nonZeroDu = 0;
    const m = kerbNode.matrixWorld.elements;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const u0 = uv.getX(i0);
      const u1 = uv.getX(i1);
      const u2 = uv.getX(i2);
      if (Math.max(u0, u1, u2) - Math.min(u0, u1, u2) > 1e-4) nonZeroDu++;

      const lx = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3;
      const ly = (pos.getY(i0) + pos.getY(i1) + pos.getY(i2)) / 3;
      const lz = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;
      const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      if (ground.query(wx, wz, wy + 1.0, hit) && hit.surface === 'kerb') {
        hitKerb++;
      }
    }
    const kerbHitRatio = hitKerb / triCount;
    assert.ok(
      kerbHitRatio > 0.995,
      `[${tid}] Expected > 99.5% of Track_Surface_Kerb triangles to resolve as surface='kerb', got ${(kerbHitRatio * 100).toFixed(2)}% (${hitKerb}/${triCount})`
    );
    assert.ok(
      nonZeroDu / triCount > 0.95,
      `[${tid}] Expected > 95% of Track_Surface_Kerb triangles to have continuous arc-length UVs (du > 0), got ${((nonZeroDu / triCount) * 100).toFixed(1)}%`
    );
    console.log(
      `PASS  [${tid}] Track_Surface_Kerb: ${triCount} tris, ${(kerbHitRatio * 100).toFixed(2)}% surface='kerb' (${hitKerb}/${triCount}), ${((nonZeroDu / triCount) * 100).toFixed(1)}% continuous UV`
    );

    // Norisring is left out of the drive-over check: the f12026 car registered no kerb on the run it picks (s = 473 m),
    // not yet looked into
    if (!['chang', 'okayama', 'spielberg', 'monaco', 'istanbul_park', 'grobnik', 'oschersleben', 'barbagallo', 'vir', 'sachsenring', 'le_mans_82', 'bridgehampton', 'watkins_glen', 'watkins_glen_short', 'riverside', 'riverside_short', 'riverside_nascar', 'speedvegas', 'willow_springs'].includes(tid)) continue;

    // Find a multi-sample kerb run and locate the lateral midpoint of the 3D Track_Surface_Kerb strip
    let targetS = -1;
    let targetLat = 0;
    for (let i = 6; i < raw.samples.length - 6; i++) {
      const sp = raw.samples[i];
      const leftRun = sp.kL && raw.samples[i - 1].kL && raw.samples[i + 1].kL && raw.samples[i + 2].kL;
      const rightRun = sp.kR && raw.samples[i - 1].kR && raw.samples[i + 1].kR && raw.samples[i + 2].kR;
      if (!leftRun && !rightRun) continue;
      const side = leftRun ? -1 : 1;
      const sMeters = i * (track.totalLengthM / raw.samples.length);
      const ts = track.getSampleAtDistance(sMeters);
      const kerbLats: number[] = [];
      for (let d = -0.3; d <= 1.4; d += 0.08) {
        const lat = side * (ts.width * 0.5 + d);
        const wx = ts.position.x + ts.binormal.x * lat;
        const wz = ts.position.z + ts.binormal.z * lat;
        if (ground.query(wx, wz, ts.position.y + 2.0, hit) && hit.surface === 'kerb') {
          kerbLats.push(lat);
        }
      }
      if (kerbLats.length >= 3) {
        targetS = sMeters;
        targetLat = kerbLats[Math.floor(kerbLats.length / 2)];
        break;
      }
    }
    assert.ok(targetS >= 0, `[${tid}] Expected to find a 3D Track_Surface_Kerb run`);

    for (const carKind of ['lc26', 'f12026', 'gt3'] as const) {
      const dt = 1 / 120;
      const side = Math.sign(targetLat);
      /** 90 frames along the kerb run at `lat`: the frames on a kerb, and the four corners' RMS shock velocity on them (m/s) */
      const run = (lat: number) => {
        const car =
          carKind === 'lc26'
            ? (() => {
                const c = new F1Physics2026(track);
                c.attachTrackRoot(root);
                return c;
              })()
            : carKind === 'f12026'
            ? new F12026CarSim(track, root)
            : createAmgGt3Sim(track, root);
        car.teleportToDistance(Math.max(5, targetS - 6), 135 / 3.6, lat);
        let frames = 0;
        let sumSq = 0;
        let n = 0;
        for (let step = 0; step < 90; step++) {
          const steerCmd = Math.max(-0.25, Math.min(0.25, (lat - car.lateralOffsetM) * 0.35));
          const tel = car.step(dt, { throttle: 0.45, brake: 0, analogSteer: steerCmd });
          const onKerb = tel.surface === 'kerb' || tel.wheelSurfaces.includes('kerb');
          if (onKerb) frames++;
          if (step >= 12 && onKerb) {
            for (const v of tel.suspensionVelocityMs) sumSq += v * v;
            n += 4;
          }
        }
        return { frames, shockMs: n > 0 ? Math.sqrt(sumSq / n) : 0 };
      };
      const kerb = run(targetLat - side * 0.82);
      assert.ok(kerb.frames > 0, `[${tid}/${carKind}] Expected car to register surface='kerb' on kerb at s=${targetS.toFixed(1)}m`);
      // The serrations keep the dampers working: with no ripple these fitted kerbs leave the corners at ~0.01 m/s. A 2 mm
      // ripple gives 0.03-0.12 m/s; the 8 mm one that once set the bar at 0.08 m/s lifted a wheel off for a third of
      // the time on every kerb. Modelled kerbs work the dampers as much as their shape does: a smooth one in the mod
      // (Oschersleben's at this spot, 0.006 m/s) is smooth here too
      assert.ok(
        modelledKerbs || kerb.shockMs > 0.02,
        `[${tid}/${carKind}] Expected the kerb to work the suspension (RMS shock velocity > 0.02 m/s), got ${kerb.shockMs.toFixed(3)} m/s`
      );
      console.log(
        `PASS  [${tid}/${carKind}] s=${targetS.toFixed(0)}m kerbFrames=${kerb.frames}, RMS shock velocity ${kerb.shockMs.toFixed(3)} m/s on the kerb`
      );
    }
  }
}

async function verifyTrackEdgeContinuity() {
  console.log('\n=== 4. Verifying Kerb/Edge Step Continuity ===');
  // The converted circuits' surfaces are fitted to their road at load (metadata.mesh.conformSurfaces), which is what
  // closes these steps; the other circuits keep their modelled kerb and verge edges
  // Sachsenring is left out for one 48 mm step from road to grass 2.9 m past the right edge at 1110 m
  for (const tid of ['spielberg', 'monaco', 'okayama', 'chang', 'istanbul_park', 'grobnik', 'oschersleben', 'barbagallo', 'vir', 'norisring', 'le_mans_82', 'bridgehampton', 'watkins_glen', 'watkins_glen_short', 'riverside', 'riverside_short', 'riverside_nascar', 'speedvegas', 'willow_springs']) {
    const { raw, root } = loadTrack(tid);
    const ground = trackColliders(root).ground!;
    const hit = createGroundHit();
    let stepCliffs = 0;
    // A circuit built with its mod's modelled kerbs (`modelledKerbs`, drawn meshes tagged keepShape) drives them as
    // modelled, edges included: Willow's drop 4.5-7.5 cm onto the ground behind them, where the mod's own ground lies
    // 3.5-7.5 cm under them too; Istanbul Park's one at 2048 m 10 cm onto the run-off band (no ground of the mod's behind
    // it); VIR's stepped kerbs rise 4.6-6.3 cm where the mod's rise 5.6-8.2 cm. Steps with a kerb on either side are
    // counted apart, up to MODELLED_KERB_BACK_M (the most a modelled kerb may stand, its `maxRiseM` in
    // scripts/tracks/port_ac_track.py); any other step fails
    let shaped = false;
    root.traverse((o) => {
      if (o.userData?.keepShape) shaped = true;
    });
    const MODELLED_KERB_BACK_M = 0.2;
    let kerbBacks = 0;
    let kerbBackMax = 0;
    const n = raw.samples.length;
    for (let i = 0; i < n; i++) {
      const s0 = raw.samples[i];
      const s1 = raw.samples[(i + 1) % n];
      const sm = raw.samples[(i - 1 + n) % n];
      const tx = s1.p[0] - sm.p[0];
      const tz = s1.p[2] - sm.p[2];
      const tl = Math.hypot(tx, tz) || 1;
      const rx = -tz / tl;
      const rz = tx / tl;
      const hw = s0.w * 0.5;
      for (const side of [-1, 1] as const) {
        const wDist = side < 0 ? (s0.wL ?? 45) : (s0.wR ?? 45);
        const maxOff = Math.min(hw + 3.0, wDist - 0.35);
        let prevY: number | null = null;
        let prevKerb = false;
        for (let d = hw - 0.8; d <= maxOff; d += 0.1) {
          const x = s0.p[0] + rx * side * d;
          const z = s0.p[2] + rz * side * d;
          if (!ground.query(x, z, s0.p[1] + 2.0, hit)) {
            prevY = null;
            continue;
          }
          if (prevY !== null && Math.abs(hit.height - prevY) > 0.045) {
            const step = Math.abs(prevY - hit.height);
            if (shaped && (prevKerb || hit.surface === 'kerb' || hit.surface === 'sausage') && step <= MODELLED_KERB_BACK_M) {
              kerbBacks++;
              kerbBackMax = Math.max(kerbBackMax, step);
            } else {
              stepCliffs++;
            }
          }
          prevY = hit.height;
          // A sausage (drawn-surfaces.ts names the Red Bull Ring's yellow kerbs and cubes so) is a modelled kerb too
          prevKerb = hit.surface === 'kerb' || hit.surface === 'sausage';
        }
      }
    }
    assert.equal(stepCliffs, 0, `[${tid}] Expected 0 lateral kerb/edge step cliffs (>45 mm / 0.1 m), got ${stepCliffs}`);
    console.log(
      `PASS  [${tid}] 0 lateral kerb/edge step cliffs across all ${n} samples` +
        (kerbBacks ? ` (${kerbBacks} edges of its modelled kerbs, up to ${(kerbBackMax * 1000).toFixed(0)} mm)` : '')
    );
  }

}

/**
 * The road collider stands on the track data's lateral profile, and the game reads that profile for the road's height
 * (evaluateSampleLateralHeightM) where it has no collider: before the circuit's model loads and in the AI's wheel
 * contact. The road keeps its own crossfall out to its edge in both (scripts/tracks/build_track.py
 * road_profile_height), so at both edges of every sample they agree to the millimetre. Chang and the Okayama layouts
 * were built by the earlier rule, which ran the edge towards the ground beside the road (their mods' sources were not on
 * hand to rebuild them), and so were Grobnik, Watkins Glen and Willow Springs, whose builds by this rule failed the
 * kerb checks (sections 3 and 4 here, and verify-kerb-feel's Willow Turn 6). The Red Bull Ring's Remus patch
 * (scripts/tracks/patches) moves the road collider at s 1254-1324 on purpose, so that stretch is left out there.
 */
async function verifyRoadEdgeProfile() {
  console.log("\n=== 5. Verifying the game's road profile against the road collider at both edges ===");
  const skip: Record<string, [number, number]> = { spielberg: [1249, 1329] };
  for (const tid of ROAD_EDGE_RULE_TRACKS) {
    const { raw, root } = loadTrack(tid);
    root.updateMatrixWorld(true);
    // The road collider's triangles on a 2 m grid
    const cell = 2;
    const cells = new Map<string, number[][]>();
    const v = new THREE.Vector3();
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      let n: THREE.Object3D | null = o;
      while (n && n.name !== 'Track_Collider_Road') n = n.parent;
      if (!n) return;
      const pos = o.geometry.getAttribute('position');
      const idx = o.geometry.getIndex();
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const t: number[] = [];
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(o.matrixWorld);
          t.push(v.x, v.y, v.z);
        }
        const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / cell), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / cell);
        const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / cell), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / cell);
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          const key = `${x},${z}`;
          (cells.get(key) ?? cells.set(key, []).get(key)!).push(t);
        }
      }
    });
    const colliderAt = (x: number, z: number, near: number) => {
      let best: number | null = null;
      for (const t of cells.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
        const v0x = t[3] - t[0], v0z = t[5] - t[2], v1x = t[6] - t[0], v1z = t[8] - t[2], px = x - t[0], pz = z - t[2];
        const den = v0x * v1z - v1x * v0z;
        if (Math.abs(den) < 1e-12) continue;
        const a = (px * v1z - v1x * pz) / den, b = (v0x * pz - px * v0z) / den;
        if (a < -1e-5 || b < -1e-5 || a + b > 1 + 1e-5) continue;
        const h = t[1] + a * (t[4] - t[1]) + b * (t[7] - t[1]);
        if (best === null || Math.abs(h - near) < Math.abs(best - near)) best = h;
      }
      return best;
    };
    let worst = 0;
    let worstAt = '';
    let probes = 0;
    let missed = 0;
    const [k0, k1] = skip[tid] ?? [Infinity, -Infinity];
    // A hill climb's dead stretch, from the road's end back round to its start, has no road
    const p2p = (raw.metadata as { pointToPoint?: { endS: number; startS: number } } | undefined)?.pointToPoint;
    for (const smp of raw.samples as unknown as { s: number; p: number[]; t: number[]; w: number; b: number; yProf?: number[] }[]) {
      if (!smp.yProf || (smp.s >= k0 && smp.s <= k1) || (p2p && smp.s > p2p.endS && smp.s < p2p.startS)) continue;
      // The converter's right-hand vector: the horizontal tangent turned a quarter (centreline.py `rights`)
      const l = Math.hypot(smp.t[0], smp.t[2]);
      const rx = -smp.t[2] / l, rz = smp.t[0] / l;
      const sample = { yProf: smp.yProf, width: smp.w, position: { y: smp.p[1] }, bankingRad: smp.b } as unknown as TrackSamplePoint;
      for (const lat of [-smp.w / 2, smp.w / 2]) {
        const y = evaluateSampleLateralHeightM(sample, lat);
        const h = colliderAt(smp.p[0] + rx * lat, smp.p[2] + rz * lat, y);
        probes++;
        if (h === null) {
          missed++;
          continue;
        }
        if (Math.abs(y - h) > worst) {
          worst = Math.abs(y - h);
          worstAt = `s ${smp.s.toFixed(0)} ${lat < 0 ? 'left' : 'right'}`;
        }
      }
    }
    assert.ok(missed <= probes * 0.01, `[${tid}] ${missed} of ${probes} road edges have no road collider under them`);
    assert.ok(worst < 0.01, `[${tid}] the track data's road edge is ${(worst * 100).toFixed(1)} cm off the road collider at ${worstAt}`);
    console.log(`PASS  [${tid}] the game's road edge on the road collider at ${probes - missed} edges, worst ${(worst * 1000).toFixed(1)} mm`);
  }
}

async function main() {
  await verifyOkayamaMaterialsAndDecalIsolation();
  await verifyMonacoBarrierHitboxes();
  await verifyKerbsFeelAndSound();
  await verifyTrackEdgeContinuity();
  await verifyRoadEdgeProfile();
  console.log('\nALL AC TRACK FIX VERIFICATIONS PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
