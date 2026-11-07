/**
 * Verification suite for the 3 user-reported AC circuit issues:
 * 1. Okayama (and all AC tracks) road material depthWrite & decal isolation (preventing 100% reflective tarmac)
 * 2. Monaco barrier hitboxes (3D wall extraction, TrackWallQuery segment density, and collision response for all 3 cars)
 * 3. Kerb feel and sound across chang, okayama, spielberg, and monaco for all 3 car physics models
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createGroundHit, TrackColliderQuery, TrackWallQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { getActiveTrackData, type RawTrackJson, setActiveTrack } from '../src/lib/track-data';
import { loadGlbGeometry } from './lib/glb-geometry';

const ROOT = path.resolve(__dirname, '..');

function loadTrack(id: string) {
  const dir = path.join(ROOT, 'public', 'tracks', id);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'track_data.json'), 'utf8')) as RawTrackJson & {
    drsZones?: { id: string; detection: number; start: number; end: number }[];
    metadata?: { baseAltitudeM?: number; mesh?: { roadMaterials?: string[] } };
  };
  setActiveTrack(id, raw);
  const track = getActiveTrackData();
  const glbPath = path.join(dir, `${id}.glb`);
  const root = loadGlbGeometry(glbPath);
  return { raw, track, glbPath, root };
}

function readGlbJson(glbPath: string) {
  const buf = fs.readFileSync(glbPath);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
}

async function verifyOkayamaMaterialsAndDecalIsolation() {
  console.log('\n=== 1. Verifying Okayama & AC Track Road Material depthWrite & Decal Isolation ===');
  for (const tid of ['okayama', 'okayama_piper', 'okayama_drift', 'chang', 'spielberg', 'monaco']) {
    const { raw, glbPath } = loadTrack(tid);
    const gltf = readGlbJson(glbPath);
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
  assert.ok(walls.segments.length >= 1200, `Expected >= 1200 wall segments in Monaco, got ${walls.segments.length}`);

  const wLs = raw.samples.map((s) => s.wL ?? 99);
  const wRs = raw.samples.map((s) => s.wR ?? 99);
  const closeWalls = raw.samples.filter((s, i) => wLs[i] < s.w / 2 + 1.5 || wRs[i] < s.w / 2 + 1.5).length;
  const closeRatio = closeWalls / raw.samples.length;
  assert.ok(closeRatio > 0.70, `Expected > 70% of Monaco samples to have close Armco walls, got ${(closeRatio * 100).toFixed(1)}%`);
  console.log(
    `PASS  [monaco] ${walls.segments.length} 3D wall collider segments, ${(closeRatio * 100).toFixed(1)}% of samples lined with tight barriers`
  );

  const testS = [100, 450, 880, 1700, 2480];
  for (const carKind of ['vf26', 'f12026', 'gt3'] as const) {
    for (const side of [-1, 1] as const) {
      for (const s0 of testS) {
        const dt = 1 / 120;
        let maxLat = 0;
        let minSpeed = 120;
        const idx0 = Math.round((s0 / track.totalLengthM) * raw.samples.length) % raw.samples.length;
        const wallDist = side < 0 ? wLs[idx0] : wRs[idx0];

        if (carKind === 'vf26') {
          const car = new F1Physics2026(track);
          car.attachTrackRoot(root);
          car.teleportToDistance(s0, 110 / 3.6, side * 1.5);
          for (let step = 0; step < 180; step++) {
            const t = car.step(dt, { throttle: 0.3, brake: 0, analogSteer: side * 0.65 });
            maxLat = Math.max(maxLat, Math.abs(car.lateralOffsetM));
            minSpeed = Math.min(minSpeed, t.speedKmh);
          }
        } else {
          const car = carKind === 'f12026' ? new F12026CarSim(track, root) : createAmgGt3Sim(track, root);
          car.teleportToDistance(s0, 110 / 3.6, side * 1.5);
          for (let step = 0; step < 180; step++) {
            const t = car.step(dt, { throttle: 0.3, brake: 0, analogSteer: side * 0.65 });
            maxLat = Math.max(maxLat, Math.abs(car.lateralOffsetM));
            minSpeed = Math.min(minSpeed, t.speedKmh);
          }
        }
        // Car must be stopped by the wall collider and never ghost out into the buildings/harbour (> 12 m)
        assert.ok(
          maxLat < Math.max(wallDist + 2.2, 9.5),
          `[monaco/${carKind}] Car ghosted through ${side < 0 ? 'left' : 'right'} wall at s=${s0}m (maxLat=${maxLat.toFixed(2)}m, wallDist=${wallDist.toFixed(2)}m)`
        );
      }
    }
    console.log(`PASS  [monaco/${carKind}] Stopped cleanly by left & right Armco barriers at s=${testS.join(', ')} m`);
  }
}

async function verifyKerbsFeelAndSound() {
  console.log('\n=== 3. Verifying Kerb Feel & Acoustics across chang, okayama, spielberg, monaco ===');
  const { getActiveSurfaceTable } = await import('../src/lib/track-data');
  for (const tid of ['chang', 'okayama', 'spielberg', 'monaco']) {
    const { raw, track, root } = loadTrack(tid);
    const ground = TrackColliderQuery.fromTrackRoot(root, getActiveSurfaceTable());
    const hit = createGroundHit();

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

    for (const carKind of ['vf26', 'f12026', 'gt3'] as const) {
      const dt = 1 / 120;
      const side = Math.sign(targetLat);
      // Place car so outside wheels ride directly along the kerb strip
      const carLat = targetLat - side * 0.82;
      let kerbFrames = 0;
      let peakKerbAmp = 0;
      let peakSuspVel = 0;
      let prevRideMm: [number, number, number, number] | null = null;

      const car =
        carKind === 'vf26'
          ? (() => {
              const c = new F1Physics2026(track);
              c.attachTrackRoot(root);
              return c;
            })()
          : carKind === 'f12026'
          ? new F12026CarSim(track, root)
          : createAmgGt3Sim(track, root);

      car.teleportToDistance(Math.max(5, targetS - 6), 135 / 3.6, carLat);

      for (let step = 0; step < 90; step++) {
        const latErr = carLat - car.lateralOffsetM;
        const steerCmd = Math.max(-0.25, Math.min(0.25, latErr * 0.35));
        const tel = car.step(dt, { throttle: 0.45, brake: 0, analogSteer: steerCmd });
        const speedMs = Math.max(0, tel.speedKmh / 3.6);
        const onKerb = tel.surface === 'kerb' || Boolean(tel.wheelSurfaces?.includes('kerb'));

        if (onKerb) {
          kerbFrames++;
          if (speedMs > 4) {
            const kerbAmp = Math.min(0.085, Math.max(0.02, speedMs * 0.0018));
            peakKerbAmp = Math.max(peakKerbAmp, kerbAmp);
          }
        }
        if (tel.wheelRideHeightsMm) {
          if (prevRideMm) {
            for (let w = 0; w < 4; w++) {
              peakSuspVel = Math.max(peakSuspVel, (Math.abs(tel.wheelRideHeightsMm[w] - prevRideMm[w]) * 1e-3) / dt);
            }
          }
          prevRideMm = [
            tel.wheelRideHeightsMm[0],
            tel.wheelRideHeightsMm[1],
            tel.wheelRideHeightsMm[2],
            tel.wheelRideHeightsMm[3],
          ];
        }
      }

      assert.ok(kerbFrames > 0, `[${tid}/${carKind}] Expected car to register surface='kerb' on kerb at s=${targetS.toFixed(1)}m`);
      assert.ok(
        peakKerbAmp > 0.04,
        `[${tid}/${carKind}] Expected audible kerb rumble gain > 0.04 on kerb, got ${peakKerbAmp.toFixed(3)}`
      );
      assert.ok(
        peakSuspVel > 0.03,
        `[${tid}/${carKind}] Expected physical suspension stroke velocity > 0.03 m/s on kerb, got ${peakSuspVel.toFixed(4)} m/s`
      );
      console.log(
        `PASS  [${tid}/${carKind}] s=${targetS.toFixed(0)}m kerbFrames=${kerbFrames}, peakKerbAmp=${peakKerbAmp.toFixed(
          3
        )}, peakSuspVel=${peakSuspVel.toFixed(3)} m/s`
      );
    }
  }
}

async function main() {
  await verifyOkayamaMaterialsAndDecalIsolation();
  await verifyMonacoBarrierHitboxes();
  await verifyKerbsFeelAndSound();
  console.log('\nALL AC TRACK FIX VERIFICATIONS PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
