/**
 * A converted circuit's off-road bands lying on another stretch of its own road (`clearOffroadOverRoad`,
 * TrackColliderQuery.ts): the road reads as road there, and nothing else changes.
 *
 * 1. Two parallel straights 30 m apart, the first one's grass band running 25 m out over half of the second (as VIR's
 *    South course and Norisring were ported): the covered asphalt reads road after the fit and grass without it, while
 *    the grass between the straights, the edges, a band under a bridge and the porter's own apron keep their surfaces.
 * 2. The reported stretches on the hosted circuits (VIR South after Bitch, VIR Grand East / West on the same road,
 *    Norisring after the Grundig hairpin): every point across the road reads as the track.
 *
 *   npx tsx scripts/verify/verify-surface-overlap.ts
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  clearOffroadOverRoad,
  conformTrackSurfaceColliders,
  createGroundHit,
  TrackColliderQuery,
  type ColliderLayerSource,
} from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { DEFAULT_SURFACE_TABLE } from '../../src/lib/sim/track-surfaces';
import { getActiveSurfaceTable, getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { hasFile, noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(92)} ${detail}`);
  if (!ok) failures.push(name);
};

// ---- 1. The fixture: x along both straights (0..100 m), z across
/** Flat strips, each from z0 to z1 along x0..x1 at height y in 5 m rows of `cols` cells, as one mesh (one GLB node) */
function strips(name: string, userData: Record<string, unknown>, parts: { z0: number; z1: number; y?: number; cols?: number; x0?: number; x1?: number }[]): THREE.Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const { z0, z1, y = 0, cols = 4, x0 = 0, x1 = 100 } of parts) {
    const base = pos.length / 3;
    const rows = Math.round((x1 - x0) / 5);
    for (let i = 0; i <= rows; i++) {
      for (let c = 0; c <= cols; c++) pos.push(x0 + ((x1 - x0) * i) / rows, y, z0 + ((z1 - z0) * c) / cols);
    }
    for (let i = 0; i < rows; i++) {
      for (let c = 0; c < cols; c++) {
        const v00 = base + i * (cols + 1) + c;
        const v10 = v00 + cols + 1;
        idx.push(v00, v10, v00 + 1, v00 + 1, v10, v10 + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g);
  m.name = name;
  m.userData = { hidden: true, ...userData };
  return m;
}

function fixture(grass?: { z0: number; z1: number; y?: number; cols?: number; x0?: number; x1?: number }[]): THREE.Group {
  const root = new THREE.Group();
  root.add(strips('Track_Collider_Road', { collider: 'road' }, [{ z0: -20, z1: 50, cols: 14 }]));
  // The two straights' road bands: A at z −5..5, B at z 25..35
  root.add(strips('Track_Surface_Road', { surface: 'road', grip: 1 }, [{ z0: -5, z1: 5 }, { z0: 25, z1: 35 }]));
  // A's grass bands: the left one to −17 m, the right one 25 m out to z = 30 over half of B, in 7 columns as the porter
  // lays them; B's own bands either side of it; and a patch 4 m under A (A on a bridge over it)
  const g = strips('Track_Surface_Grass', { surface: 'grass' }, grass ?? [
    { z0: -17, z1: -5, cols: 7 },
    { z0: 5, z1: 30, cols: 7 },
    { z0: 12, z1: 25, cols: 7 },
    { z0: 35, z1: 47, cols: 7 },
    { z0: -3, z1: 3, y: -4, x0: 40, x1: 60 },
  ]);
  // Where A's far band covers B it stands 3 cm proud of B's road (a far band follows the scan's ground)
  const p = g.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) if (p.getZ(i) > 25.5 && p.getZ(i) <= 30 && p.getY(i) === 0) p.setY(i, 0.03);
  root.add(g);
  // The porter's apron (the mod's own paved ground off the lap) with run-off over it, both off the lap's road
  root.add(strips('Track_Surface_Apron', { surface: 'road', grip: 1 }, [{ z0: -17, z1: -11, cols: 2, x1: 20 }]));
  root.add(strips('Track_Surface_Runoff', { surface: 'runoff' }, [{ z0: -15, z1: -11, y: 0.01, cols: 2, x1: 20 }]));
  root.updateMatrixWorld(true);
  return root;
}

{
  const hit = createGroundHit();
  const at = (q: TrackColliderQuery, x: number, z: number, probeY = 1) => (q.query(x, z, probeY, hit) ? hit.surface : 'none');

  // The fitted collider as it was built before the clearing: fitted to the road, then every tagged node a layer
  const unclearedRoot = fixture();
  conformTrackSurfaceColliders(unclearedRoot);
  const sources: ColliderLayerSource[] = [{ object: unclearedRoot.getObjectByName('Track_Collider_Road')!, isRoadCollider: true }];
  unclearedRoot.traverse((o) => {
    if (typeof o.userData?.surface === 'string' && !o.userData?.collider) sources.push({ object: o });
  });
  const uncleared = new TrackColliderQuery(sources, DEFAULT_SURFACE_TABLE, { conformSurfaces: true });
  check('fitted without the clearing, the far grass band names the second straight\'s asphalt (the reported bug)', at(uncleared, 50, 27.5) === 'grass', at(uncleared, 50, 27.5));

  const fitted = TrackColliderQuery.fromTrackRoot(fixture(), DEFAULT_SURFACE_TABLE, { conformSurfaces: true });
  const covered = [26.5, 27.5, 29, 29.9].map((z) => at(fitted, 50, z));
  check('the covered half of the second straight reads road', covered.every((s) => s === 'road'), covered.join(' '));
  // The band's face from z 22.9 to 26.4 crosses B's edge at 25: split, its part over B goes
  check('so does its asphalt under a face that crosses its edge (split)', at(fitted, 37.5, 25.4) === 'road' && at(fitted, 52.5, 26) === 'road', `${at(fitted, 37.5, 25.4)} ${at(fitted, 52.5, 26)}`);
  check('the rest of both straights reads road', [0, 4.9, -4.9].every((z) => at(fitted, 50, z) === 'road') && [31, 34.9].every((z) => at(fitted, 50, z) === 'road'));
  check('the grass between the straights stays grass, right up to both edges', [5.2, 15, 24.8].every((z) => at(fitted, 50, z) === 'grass'), [5.2, 15, 24.8].map((z) => at(fitted, 50, z)).join(' '));
  check('the bands past the outer edges stay grass', at(fitted, 50, -5.2) === 'grass' && at(fitted, 50, 35.2) === 'grass');
  check('a band 4 m under the road (a bridge over it) is kept', at(fitted, 50, 0, -3.5) === 'grass', at(fitted, 50, 0, -3.5));
  check('run-off over the porter\'s apron, off the lap\'s road, stays run-off', at(fitted, 10, -13) === 'runoff', at(fitted, 10, -13));

  // The area taken off: the band's 5 m over the second straight, 100 m long (the face across B's edge is cut there to
  // a sixteenth of its 3.6 m width), and none of anything else
  const dropped = clearOffroadOverRoad(fixture());
  check('it takes 500 m² of grass off the road and nothing else', Object.keys(dropped).join() === 'Track_Surface_Grass' && Math.abs(dropped.Track_Surface_Grass - 500) < 12,
    JSON.stringify(Object.fromEntries(Object.entries(dropped).map(([k, v]) => [k, Math.round(v)]))));
  const clean = fixture([{ z0: -17, z1: -5, cols: 7 }, { z0: 5, z1: 25, cols: 7 }, { z0: 35, z1: 47, cols: 7 }]);
  const before = (clean.getObjectByName('Track_Surface_Grass') as THREE.Mesh).geometry;
  check('a circuit whose bands stop at the road is left as it is', Object.keys(clearOffroadOverRoad(clean)).length === 0 && (clean.getObjectByName('Track_Surface_Grass') as THREE.Mesh).geometry === before);
}

// ---- 2. The reported stretches, on the hosted circuits
const REPORTED: [string, number, number][] = [
  ['vir_south', 945, 1085],
  ['vir_grand_east', 2627, 2750],
  ['vir_grand_west', 4035, 4160],
  ['norisring', 540, 885],
];
for (const [id, from, to] of REPORTED) {
  const what = `${id} ${from}-${to} m`;
  const data = `public/tracks/${id}/track_data.json`;
  if (!hasFile(data)) {
    noteSkip(what, data);
    continue;
  }
  setActiveTrack(id, JSON.parse(readFileSync(data, 'utf8')) as RawTrackJson);
  const track = getActiveTrackData(1200);
  if (!track.meshUrl) {
    check(`${what}: the track data names a model`, false);
    continue;
  }
  // The model its track data names, which a layout can share with another
  const model = `public${track.meshUrl}`;
  if (!hasFile(model)) {
    noteSkip(what, model);
    continue;
  }
  const ground = TrackColliderQuery.fromTrackRoot(loadGlbGeometry(model), getActiveSurfaceTable(), { conformSurfaces: true });
  const hit = createGroundHit();
  let asked = 0;
  const off: string[] = [];
  for (let s = from; s <= to; s += 2.5) {
    const smp = track.getSampleAtDistance(s);
    const b = smp.binormal;
    const bl = Math.hypot(b.x, b.z) || 1;
    // Across the road, 0.3 m in from each edge
    const half = smp.width / 2 - 0.3;
    for (let lat = -half; lat <= half + 1e-6; lat += half / 8) {
      asked++;
      const ok = ground.query(smp.position.x + (b.x / bl) * lat, smp.position.z + (b.z / bl) * lat, smp.position.y + 1, hit);
      if (!ok || !hit.props.validTrack) off.push(`${s}/${lat.toFixed(1)} ${ok ? hit.surface : 'none'}`);
    }
  }
  check(`${id} ${from}-${to} m: the road reads as the track all across`, off.length === 0, `${asked - off.length}/${asked}${off.length ? `, off at ${off.slice(0, 4).join(', ')}` : ''}`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll surface overlap checks passed');
process.exit(0);
