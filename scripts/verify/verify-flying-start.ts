/**
 * Flying-lap starts (`startPose` in src/lib/sim/simulator-car.ts): the car is handed over at speed with no yaw rate and
 * its wheel straight, so hands-off it must keep its tyres on the asphalt for its first second (`START_HANDS_OFF_S`).
 *
 *   npx tsx scripts/verify/verify-flying-start.ts
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
import { VEHICLE_MODELS } from '../../src/lib/cars/vehicle-models';
import { createGroundHit, type GroundQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { START_HANDS_OFF_S, type SimulatorCar } from '../../src/lib/sim/simulator-car';
import { trackColliders } from '../../src/lib/sim/track-colliders';
import { type BuiltTrackData, getActiveTrackData, type RawTrackJson, setActiveTrack } from '../../src/lib/track-data';
import type { VehicleModelId } from '../../src/types/f1';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { hasFile, noteSkip } from '../lib/hosted-files';

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

/** Seconds a car runs at full throttle with no steering before a tyre leaves road or kerb (`seconds` if none does) */
function handsOffS(car: SimulatorCar, ground: GroundQuery, seconds: number): number {
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    car.step(DT, { throttle: 1, brake: 0, analogSteer: 0 });
    for (const w of car.wheels) {
      if (!ground.query(w.worldPos.x, w.worldPos.z, w.worldPos.y + 1, hit) || !ASPHALT.has(hit.surface)) return (k + 1) * DT;
    }
  }
  return seconds;
}

/** The circuit's data and colliders, or null (with a note) where this copy doesn't have it */
function load(id: string): { track: BuiltTrackData; root: THREE.Object3D; ground: GroundQuery } | null {
  const data = `public/tracks/${id}/track_data.json`;
  if (!hasFile(data)) {
    noteSkip(id, data);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(data, 'utf8')) as RawTrackJson & { metadata: { mesh: { url: string } } };
  const glb = `public${raw.metadata.mesh.url}`;
  if (!hasFile(glb)) {
    noteSkip(id, glb);
    return null;
  }
  setActiveTrack(id, raw);
  const track = getActiveTrackData(1200);
  const root = loadGlbGeometry(glb);
  return { track, root, ground: trackColliders(root).ground! };
}

console.log(`Hands-off for ${START_HANDS_OFF_S} s from a flying start, every car`);
for (const id of ['rwanda_official', 'rwanda_official_short', 'monaco', 'spielberg', 'sachsenring', 'sachsenring_short', 'barbagallo', 'vir']) {
  const c = load(id);
  if (!c) continue;
  const { track, root, ground } = c;
  const L = track.totalLengthM;
  const runs = CARS.map((model) => {
    const car = VEHICLE_MODELS[model].createSim(track, root);
    car.resetToStartGrid(true);
    const at = { s: car.sMeters - L, lateral: car.lateralOffsetM, headDeg: headingOffRoadDeg(car, track) };
    return { model, ...at, onS: handsOffS(car, ground, START_HANDS_OFF_S) };
  });
  const off = runs.filter((r) => r.onS < START_HANDS_OFF_S);
  check(`${id}: all four tyres on road or kerb`, off.length === 0,
    off.length ? off.map((r) => `${r.model} off at ${r.onS.toFixed(2)} s`).join(', ') :
      `${runs[0].s.toFixed(0)} m, ${runs.map((r) => `${r.model} ${r.lateral.toFixed(1)} m / ${r.headDeg.toFixed(1)}°`).join(', ')}`);
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
      return { model, onS: handsOffS(car, ground, START_HANDS_OFF_S) };
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
