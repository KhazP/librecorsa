/**
 * Physics surfaces named by what a circuit draws (src/lib/sim/drawn-surfaces.ts).
 *
 * 1. A straight with a 10 m road band, grass bands past it, a kerb on the left, barriers at 10 m and a drawn street
 *    12 m either side: grass under the drawn street between the barriers becomes road, grass past the barriers and
 *    under a drawn sand patch stays grass, and kerb under drawn cubes becomes a sausage only in the rule's stretch,
 *    with the kerb's texture coordinates kept. A circuit without rules is left as it is. A band renames only between
 *    its offsets on its side, and a rule over the road collider lays run-off on it, at its height, leaving it as it is.
 *    An area (a world outline) renames inside it, less an area excepted, and a later rule renames what an earlier one
 *    made.
 * 2. Norisring: the street out to the barriers is the track (s 760, the Schoeller S and the inside lane into the Grundig
 *    hairpin), the gravel inside the hairpin and the car park past its outside kerb are not; from the marked images of
 *    turns 2-6, the back straight's promenades and the apron past the start-finish straight's edge are off the track,
 *    the Schöller S's inside street and turn 6's outer lane and pit entry on it. Goodwood: the verges past the asphalt
 *    (the inside of Molecomb and Turn 2 within the lap's shifted width too) are off the track, the asphalt on
 *    Molecomb's outside on it. Red Bull Ring (and its
 *    South course): a car past the red and white kerb inside Castrol Edge and Remus is off the track, one on the kerb
 *    is not; past the white line on the pit exit and the gore island, on the anti-cut rumble and on Remus's exit
 *    astroturf it is off; the asphalt out to the white line is on; the pit exit merge is as it was. Its inner skill
 *    course: the lap's centreline is on the track all the way round, the old band past the cones is off it and the
 *    lane out to the cones past the old band on it.
 *
 *   npx tsx scripts/verify/verify-drawn-surfaces.ts
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { applyDrawnSurfaceRules, type DrawnSurfaceRule } from '../../src/lib/sim/drawn-surfaces';
import { createGroundHit, TrackColliderQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { DEFAULT_SURFACE_TABLE } from '../../src/lib/sim/track-surfaces';
import { trackColliders } from '../../src/lib/sim/track-colliders';
import { getActiveSurfaceTable, getActiveTrackData, getActiveTrackMetadata, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { createFlatTestTrack } from '../lib/flat-track';
import { loadGlbGeometry, trackModelFiles } from '../lib/glb-geometry';
import { hasFile, noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(96)} ${detail}`);
  if (!ok) failures.push(name);
};

// ---- 1. The fixture. The flat track runs along +Z; a lateral offset `lat` (+ right) is at x = -lat
/** A flat strip from lat a to lat b (m) along s 0..200 (in 2 m rows), as one mesh */
function strip(name: string, a: number, b: number, opts: { y?: number; s0?: number; s1?: number; material?: string; userData?: Record<string, unknown>; uv?: boolean } = {}): THREE.Mesh {
  const { y = 0, s0 = 0, s1 = 200 } = opts;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const rows = Math.round((s1 - s0) / 2);
  for (let i = 0; i <= rows; i++) {
    const s = s0 + ((s1 - s0) * i) / rows;
    for (const lat of [a, b]) {
      pos.push(-lat, y, s);
      uv.push(s / 6, lat === a ? 0 : 1);
    }
  }
  for (let i = 0; i < rows; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (opts.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ name: opts.material ?? '' }));
  m.name = name;
  m.userData = opts.userData ?? {};
  return m;
}

function fixture(): THREE.Group {
  const root = new THREE.Group();
  root.add(strip('Track_Collider_Road', -20, 20, { userData: { collider: 'road', hidden: true } }));
  root.add(strip('Track_Surface_Road', -5, 5, { userData: { surface: 'road', grip: 1, hidden: true } }));
  root.add(strip('Track_Surface_Kerb', -6.5, -5, { userData: { surface: 'kerb', uvScaleM: 6, hidden: true }, uv: true }));
  const grass = strip('Track_Surface_Grass', 5, 20, { userData: { surface: 'grass', hidden: true } });
  const left = strip('', -20, -6.5);
  grass.geometry = mergeTwo(grass.geometry as THREE.BufferGeometry, left.geometry as THREE.BufferGeometry);
  root.add(grass);
  // What is drawn: the street 12 m either side, a sand patch on it (right, s 50-80) and kerb cubes on the left kerb at
  // s 100-120 and 150-160
  const model = new THREE.Group();
  model.name = 'Track_Model';
  model.add(strip('street', -12, 12, { y: 0.005, material: 'road2' }));
  model.add(strip('sand', 7, 12, { y: 0.006, s0: 50, s1: 80, material: 'sanda' }));
  model.add(strip('cubes1', -6.4, -5.6, { y: 0.02, s0: 100, s1: 120, material: 'cubes' }));
  model.add(strip('cubes2', -6.4, -5.6, { y: 0.02, s0: 150, s1: 160, material: 'cubes' }));
  root.add(model);
  root.updateMatrixWorld(true);
  return root;
}
function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const pa = a.getAttribute('position').array as Float32Array, pb = b.getAttribute('position').array as Float32Array;
  const ia = Array.from(a.getIndex()!.array), ib = Array.from(b.getIndex()!.array).map((i) => i + pa.length / 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...pa, ...pb], 3));
  g.setIndex([...ia, ...ib]);
  return g;
}

{
  const track = createFlatTestTrack(200, 10, 100);
  // Barriers 10 m either side
  for (const q of track.samples) Object.assign(q, { wallLeftM: 10, wallRightM: 10 });
  const RULES: DrawnSurfaceRule[] = [
    { materials: 'roadMaterials', surface: 'road', from: ['runoff', 'gravel', 'grass'], within: 'barriers', covers: ['sanda'], pieceM: 0.5, note: 'street' },
    { materials: ['cubes'], surface: 'sausage', within: { stretches: [[95, 125, -1]] }, note: 'cubes' },
  ];
  const hit = createGroundHit();
  const at = (q: TrackColliderQuery, s: number, lat: number) => (q.query(-lat, s, 1, hit) ? hit.surface : 'none');
  const plain = TrackColliderQuery.fromTrackRoot(fixture(), DEFAULT_SURFACE_TABLE, { conformSurfaces: true });
  const root = fixture();
  let renamed: Record<string, number> = {};
  const q = TrackColliderQuery.fromTrackRoot(root, DEFAULT_SURFACE_TABLE, { conformSurfaces: true, prepare: (r) => (renamed = applyDrawnSurfaceRules(r, track, ['road2'], RULES)) });

  check('without the rules, the drawn street past the road band is grass', at(plain, 30, 8) === 'grass' && at(plain, 30, -8) === 'grass', `${at(plain, 30, 8)} ${at(plain, 30, -8)}`);
  check('with them, it is road between the barriers on both sides', [7, 8, 9.6].every((l) => at(q, 30, l) === 'road') && [-7, -9.6].every((l) => at(q, 30, l) === 'road'),
    [7, 8, 9.6, -7, -9.6].map((l) => at(q, 30, l)).join(' '));
  check('past the barriers it stays grass, drawn street or not', at(q, 30, 10.6) === 'grass' && at(q, 30, -11) === 'grass', `${at(q, 30, 10.6)} ${at(q, 30, -11)}`);
  check('under the drawn sand patch it stays grass', at(q, 65, 9) === 'grass' && at(q, 65, 8) === 'grass', `${at(q, 65, 9)} ${at(q, 65, 8)}`);
  check('the road band and the kerb are as they were', at(q, 30, 0) === 'road' && at(q, 30, -5.8) === 'kerb', `${at(q, 30, 0)} ${at(q, 30, -5.8)}`);
  check('kerb under the drawn cubes is a sausage within the rule stretch, off the track', at(q, 110, -6) === 'sausage' && !hit.props.validTrack, at(q, 110, -6));
  check('and a kerb outside it, cubes or not', at(q, 155, -6) === 'kerb', at(q, 155, -6));
  const kerb = root.getObjectByName('Track_Surface_Kerb') as THREE.Mesh;
  check('the split kerb keeps its texture coordinates (its ripple)', !!(kerb.geometry as THREE.BufferGeometry).getAttribute('uv'));
  check('the renamed areas: about 2 × 4.5 × 200 m of street and 0.8 × 20 m of cubes', Math.abs((renamed.road ?? 0) - 1600) < 60 && Math.abs((renamed.sausage ?? 0) - 16) < 3,
    JSON.stringify(Object.fromEntries(Object.entries(renamed).map(([k, v]) => [k, Math.round(v)]))));
  const other = fixture();
  const geo = (other.getObjectByName('Track_Surface_Grass') as THREE.Mesh).geometry;
  check('a circuit without rules is left as it is', Object.keys(applyDrawnSurfaceRules(other, { ...track, id: 'no_rules_here' }, ['road2'])).length === 0 && (other.getObjectByName('Track_Surface_Grass') as THREE.Mesh).geometry === geo);
}

// A band (a stretch's side between two offsets) and a rule laid over the road collider, on a road collider 20 m either
// side with a road surface 5 m either side, grass on the left and the street drawn 12 m either side
{
  const track = createFlatTestTrack(200, 10, 100);
  const root = new THREE.Group();
  root.add(strip('Track_Collider_Road', -20, 20, { userData: { collider: 'road', hidden: true } }));
  root.add(strip('Track_Surface_Road', -5, 5, { userData: { surface: 'road', grip: 1, hidden: true } }));
  root.add(strip('Track_Surface_Grass', -20, -5, { userData: { surface: 'grass', hidden: true } }));
  root.add(strip('street', -12, 12, { y: 0.005, material: 'road2' }));
  root.updateMatrixWorld(true);
  const collider = root.getObjectByName('Track_Collider_Road') as THREE.Mesh;
  const colliderGeo = collider.geometry;
  const RULES: DrawnSurfaceRule[] = [
    { materials: ['road2'], surface: 'road', from: ['grass'], within: { bands: [[20, 60, -1, 5, 8]] }, note: 'band' },
    { materials: null, surface: 'runoff', from: ['road'], overRoadCollider: true, within: { bands: [[100, 140, 1, 8, 14]] }, note: 'over the road collider' },
  ];
  const hit = createGroundHit();
  const at = (q: TrackColliderQuery, s: number, lat: number) => (q.query(-lat, s, 1, hit) ? hit.surface : 'none');
  const q = TrackColliderQuery.fromTrackRoot(root, DEFAULT_SURFACE_TABLE, { conformSurfaces: true, prepare: (r) => applyDrawnSurfaceRules(r, track, [], RULES) });
  check('a band: drawn street over grass is road between its offsets, on its side, along its stretch', at(q, 40, -6.5) === 'road' && at(q, 40, -9) === 'grass' && at(q, 80, -6.5) === 'grass',
    [at(q, 40, -6.5), at(q, 40, -9), at(q, 80, -6.5)].join(' '));
  const off = at(q, 120, 10);
  check("over the road collider: run-off within the band, off the track, at the collider's height", off === 'runoff' && !hit.props.validTrack && Math.abs(hit.height) < 1e-3, `${off} ${hit.height}`);
  check('the road collider is left as it is, and road past the band', collider.geometry === colliderGeo && [at(q, 120, 6), at(q, 120, 15), at(q, 160, 10)].every((s) => s === 'road'),
    [at(q, 120, 6), at(q, 120, 15), at(q, 160, 10)].join(' '));
}

// Areas (world outlines, x = -lat, z = s here): grass inside one becomes road; road inside another becomes run-off, except
// inside an area excepted, and a later rule renames what an earlier one made
{
  const track = createFlatTestTrack(200, 10, 100);
  const root = new THREE.Group();
  root.add(strip('Track_Collider_Road', -20, 20, { userData: { collider: 'road', hidden: true } }));
  root.add(strip('Track_Surface_Road', -5, 5, { userData: { surface: 'road', grip: 1, hidden: true } }));
  const grass = strip('Track_Surface_Grass', 5, 20, { userData: { surface: 'grass', hidden: true } });
  grass.geometry = mergeTwo(grass.geometry as THREE.BufferGeometry, strip('', -20, -5).geometry as THREE.BufferGeometry);
  root.add(grass);
  root.updateMatrixWorld(true);
  const rect = (lat0: number, lat1: number, s0: number, s1: number) => [-lat0, s0, -lat1, s0, -lat1, s1, -lat0, s1];
  const RULES: DrawnSurfaceRule[] = [
    { materials: null, surface: 'road', from: ['grass'], within: { areas: [rect(7, 12, 30, 60)] }, note: 'track' },
    { materials: null, surface: 'runoff', from: ['road'], within: { areas: [rect(-11, 11, 100, 120), rect(7, 12, 40, 50)], except: [rect(-2, 2, 100, 120)] }, note: 'off' },
  ];
  const hit = createGroundHit();
  const at = (q: TrackColliderQuery, s: number, lat: number) => (q.query(-lat, s, 1, hit) ? hit.surface : 'none');
  const q = TrackColliderQuery.fromTrackRoot(root, DEFAULT_SURFACE_TABLE, { conformSurfaces: true, prepare: (r) => applyDrawnSurfaceRules(r, track, [], RULES) });
  const inA = [at(q, 35, 9), at(q, 35, 13), at(q, 70, 9)];
  check('an area: grass inside it is road, grass outside it stays grass', inA.join() === 'road,grass,grass', inA.join(' '));
  const inB = [at(q, 110, 4), at(q, 110, 0), at(q, 130, 4)];
  check('an area less the area excepted: road inside it is run-off, road in the excepted area and outside stays road', inB.join() === 'runoff,road,road', inB.join(' '));
  check('a later rule renames what an earlier one made (road made from grass, then run-off)', at(q, 45, 9) === 'runoff' && at(q, 55, 9) === 'road', `${at(q, 45, 9)} ${at(q, 55, 9)}`);
}

// ---- 2. The hosted circuits
/** All four wheels (±1.8 m along, ±0.8 m across) of a car centred at lap distance s, lateral lat: off the track? */
function carOff(ground: TrackColliderQuery, s: number, lat: number): boolean {
  const track = getActiveTrackData(1200);
  const hit = createGroundHit();
  return [-1.8, 1.8].every((dl) => [-0.8, 0.8].every((dw) => {
    const q = track.getSampleAtDistance(s + dl);
    const b = q.binormal, bl = Math.hypot(b.x, b.z) || 1;
    const x = q.position.x + (b.x / bl) * (lat + dw), z = q.position.z + (b.z / bl) * (lat + dw);
    return !(ground.query(x, z, q.position.y + 2, hit) && hit.props.validTrack);
  }));
}
/** The ground at lap distance s, lateral lat: on the track? */
function pointOn(ground: TrackColliderQuery, s: number, lat: number): boolean {
  const q = getActiveTrackData(1200).getSampleAtDistance(s);
  const b = q.binormal, bl = Math.hypot(b.x, b.z) || 1;
  const hit = createGroundHit();
  return ground.query(q.position.x + (b.x / bl) * lat, q.position.z + (b.z / bl) * lat, q.position.y + 2, hit) && hit.props.validTrack;
}
function load(id: string): { before: TrackColliderQuery; after: TrackColliderQuery } | null {
  const path = `public/tracks/${id}/track_data.json`;
  if (!hasFile(path)) {
    noteSkip(id, path);
    return null;
  }
  setActiveTrack(id, JSON.parse(readFileSync(path, 'utf8')) as RawTrackJson);
  const files = trackModelFiles(getActiveTrackData(1200));
  if (!hasFile(files.path) || (files.shared && !hasFile(files.shared))) {
    noteSkip(id, files.path);
    return null;
  }
  const before = TrackColliderQuery.fromTrackRoot(loadGlbGeometry(files.path, files.shared), getActiveSurfaceTable(), { conformSurfaces: getActiveTrackMetadata().mesh?.conformSurfaces === true });
  return { before, after: trackColliders(loadGlbGeometry(files.path, files.shared)).ground! };
}

const nori = load('norisring');
if (nori) {
  const street: [number, number][] = [[760, 9], [760, -9], [900, -10.5], [940, 8.5], [1600, 9.5]];
  check('Norisring: a car on the street between the barriers was off the track before', street.every(([s, l]) => carOff(nori.before, s, l)));
  check('and is on it now', street.every(([s, l]) => !carOff(nori.after, s, l)), street.filter(([s, l]) => carOff(nori.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  check('Norisring: a car in the gravel inside the Grundig hairpin is still off the track', carOff(nori.after, 485, -15) && carOff(nori.after, 430, -10));
  check('Norisring: the inside lane into the Grundig hairpin is on the track now (off before)', carOff(nori.before, 440, -8) && !carOff(nori.after, 440, -8));
  // (the hairpin's outside kerb ends 11.1 m out; the barrier opens to 35 m round the car park behind it)
  check("Norisring: the car park past the Grundig hairpin's outside kerb is still off the track", carOff(nori.after, 480, 16) && carOff(nori.after, 480, 20));
  // The marked corner images of turns 2-6
  const promenades: [number, number][] = [[1150, 10.5], [1150, -10.5], [1250, -10.5]];
  check("Norisring: on the back straight's promenades a car was on the track (they were kerb), and is off it now",
    promenades.every(([s, l]) => !carOff(nori.before, s, l) && carOff(nori.after, s, l)), promenades.filter(([s, l]) => !carOff(nori.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  const marked: [number, number][] = [[935, -12], [1900, 13]];
  check("Norisring: the Schöller S's inside street past the lap's barrier distance and turn 6's outer lane and pit entry are on the track now",
    marked.every(([s, l]) => carOff(nori.before, s, l) && !carOff(nori.after, s, l)), marked.filter(([s, l]) => carOff(nori.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  check("Norisring: past the start-finish straight's edge, where road faces jut onto the apron, is off the track now; its road stays on it",
    !carOff(nori.before, 2030, -11) && carOff(nori.after, 2030, -11) && !carOff(nori.after, 2029, -8.4));
}
const rbr = load('spielberg');
if (rbr) {
  // (the car's centre 9 m inside Castrol Edge and 7.5 m inside Remus: its outer wheels past the red and white kerb)
  check('Red Bull Ring: past the red and white kerb inside Castrol Edge and Remus, on the track before', !carOff(rbr.before, 330, 9) && !carOff(rbr.before, 1270, 7.5));
  check('and off it now', carOff(rbr.after, 330, 9) && carOff(rbr.after, 1270, 7.5));
  check('Red Bull Ring: a car with its wheels on the kerb, and on the road, is on the track', !carOff(rbr.after, 330, 7.5) && !carOff(rbr.after, 1267.5, 6) && !carOff(rbr.after, 1267.5, 2));
  // The corner images' marks: the pit exit past the white line before Castrol Edge (9 m out) and the gore island past
  // its apex, the anti-cut rumble outside its exit, the astroturf behind Remus's outside exit kerb
  const cuts: [number, number][] = [[270, 9], [358, 9.5], [380, -12.5], [1300, -9.5]];
  check('Red Bull Ring: on the pit exit and gore island past the white line, the anti-cut rumble and the astroturf, on the track before',
    cuts.every(([s, l]) => !carOff(rbr.before, s, l)), cuts.filter(([s, l]) => carOff(rbr.before, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  check('and off it now', cuts.every(([s, l]) => carOff(rbr.after, s, l)), cuts.filter(([s, l]) => !carOff(rbr.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  // The asphalt out to the white line round the outside of Castrol Edge and Remus and inside Remus, called run-off
  const asphalt: [number, number][] = [[330, -9], [1268, -8.25], [1250, 7.5], [1290, 7.4]];
  check('Red Bull Ring: the racing asphalt out to the white line at Castrol Edge and Remus is the track now (off before)',
    asphalt.every(([s, l]) => !pointOn(rbr.before, s, l) && pointOn(rbr.after, s, l)), asphalt.filter(([s, l]) => !pointOn(rbr.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  // Where the pit exit lane merges after Castrol Edge (its right side, s 375-415), as it was
  const merge: [number, number][] = [];
  for (let s = 375; s <= 415; s += 5) for (let l = 0; l <= 12; l += 1) merge.push([s, l]);
  check('Red Bull Ring: the pit exit merge after Castrol Edge is as it was', merge.every(([s, l]) => pointOn(rbr.before, s, l) === pointOn(rbr.after, s, l)),
    merge.filter(([s, l]) => pointOn(rbr.before, s, l) !== pointOn(rbr.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
}
const south = load('spielberg_south');
if (south) {
  check('Red Bull Ring South: past the red and white kerb inside Castrol Edge is off the track (on before)', !carOff(south.before, 330, 9) && carOff(south.after, 330, 9));
  check('and on the kerb it is on the track', !carOff(south.after, 330, 7.5));
  check('Red Bull Ring South: on the pit exit past the white line and the anti-cut rumble off the track (on before)',
    !carOff(south.before, 270, 9) && !carOff(south.before, 380, -12.5) && carOff(south.after, 270, 9) && carOff(south.after, 380, -12.5));
}
const inner = load('spielberg_inner');
if (inner) {
  // The inner skill course, laid out in cones: the lane between them is the track, the old 10.5 m band past them is not
  const lapOff: number[] = [];
  for (let s = 0; s < 931; s += 1) if (!pointOn(inner.after, s, 0)) lapOff.push(s);
  check('Red Bull Ring inner: the lap centreline is on the track all the way round', lapOff.length === 0, lapOff.slice(0, 12).join(' '));
  const band: [number, number][] = [[100, 4], [330, 4.2], [615, -4]];
  check('Red Bull Ring inner: in the old band past the cones a car was on the track, and is off it now',
    band.every(([s, l]) => !carOff(inner.before, s, l) && carOff(inner.after, s, l)), band.filter(([s, l]) => !carOff(inner.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  // (on the long diagonal the cones on the left stand 5 m out, past the old band)
  check('Red Bull Ring inner: the lane out to the cones past the old band is the track now (off before)', !pointOn(inner.before, 215, -5.5) && pointOn(inner.after, 215, -5.5));
}
const goodwood = load('goodwood');
if (goodwood) {
  // The marked corner images: the verges past the asphalt before the MMS Bridge (both sides), the inside verge of
  // Molecomb and of Turn 2 (within the lap's track-data width, which is shifted off the road there)
  const verges: [number, number][] = [[150, -4.75], [150, 4.75], [905, -2.5], [355, 3]];
  check('Goodwood: on the verges past the asphalt a car was on the track, and is off it now',
    verges.every(([s, l]) => !carOff(goodwood.before, s, l) && carOff(goodwood.after, s, l)), verges.filter(([s, l]) => !carOff(goodwood.after, s, l)).map(([s, l]) => `${s}/${l}`).join(' '));
  check("Goodwood: the asphalt on Molecomb's outside is on the track now (off before), the road's middle stays on it",
    carOff(goodwood.before, 905, 3.75) && !carOff(goodwood.after, 905, 3.75) && !carOff(goodwood.after, 905, 0) && !carOff(goodwood.after, 150, 0));
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll drawn-surface checks passed');
process.exit(0);
