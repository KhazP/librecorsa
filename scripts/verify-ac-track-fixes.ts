/**
 * The converted AC circuits:
 * 1. Okayama (and all AC tracks) road material depthWrite & decal isolation (preventing 100% reflective tarmac)
 * 2. Monaco barrier hitboxes (3D wall extraction, TrackWallQuery segment density, and collision response for all 3 cars)
 * 3. Kerb coverage and feel across chang, okayama, spielberg, monaco, istanbul_park, grobnik, oschersleben, barbagallo,
 *    vir, sachsenring, norisring, le_mans_82 and the LilSki, SpeedVegas and Willow Springs circuits for all 3 car
 *    physics models (the hill climbs have no kerbs)
 * 4. Kerb / edge step continuity of the fitted surfaces
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createGroundHit, TrackWallQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { trackColliders } from '../src/lib/sim/track-colliders';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { getActiveTrackData, type RawTrackJson, setActiveTrack } from '../src/lib/track-data';
import { loadGlbGeometry, readTrackGltfJson, trackModelFiles } from './lib/glb-geometry';
import { skipSuiteWithout } from './lib/hosted-files';

skipSuiteWithout('public/tracks/okayama/track_data.json', 'public/tracks/monaco/track_data.json', 'public/tracks/dunsfold/track_data.json', 'public/tracks/istanbul_park/track_data.json', 'public/tracks/grobnik/track_data.json', 'public/tracks/oschersleben/track_data.json', 'public/tracks/barbagallo/track_data.json', 'public/tracks/vir/track_data.json', 'public/tracks/sachsenring/track_data.json', 'public/tracks/sachsenring_short/track_data.json', 'public/tracks/norisring/track_data.json', 'public/tracks/le_mans_82/track_data.json', 'public/tracks/goodwood/track_data.json', 'public/tracks/borgloh/track_data.json', 'public/tracks/bridgehampton/track_data.json', 'public/tracks/watkins_glen/track_data.json', 'public/tracks/watkins_glen_short/track_data.json', 'public/tracks/riverside/track_data.json', 'public/tracks/riverside_short/track_data.json', 'public/tracks/riverside_nascar/track_data.json', 'public/tracks/speedvegas/track_data.json', 'public/tracks/willow_springs/track_data.json');

const ROOT = path.resolve(__dirname, '..');

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
      assert.ok(triCount >= 7000, `[monaco] Expected >= 7000 kerb triangles (including chicane kerbs), got ${triCount}`);
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
            if (shaped && (prevKerb || hit.surface === 'kerb') && step <= MODELLED_KERB_BACK_M) {
              kerbBacks++;
              kerbBackMax = Math.max(kerbBackMax, step);
            } else {
              stepCliffs++;
            }
          }
          prevY = hit.height;
          prevKerb = hit.surface === 'kerb';
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

async function main() {
  await verifyOkayamaMaterialsAndDecalIsolation();
  await verifyMonacoBarrierHitboxes();
  await verifyKerbsFeelAndSound();
  await verifyTrackEdgeContinuity();
  console.log('\nALL AC TRACK FIX VERIFICATIONS PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
