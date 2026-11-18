/**
 * Venue models (src/lib/venue-models.ts, scripts/split-venue-model.mjs): every layout of a venue with a split model
 * must load into the same scene from its pair (the layout file and the venue's shared file) as from its own full GLB.
 *
 * 1. The pair names this build: the layout file's `extras.lcVenueLayout` and the shared file's `extras.lcVenueShared`.
 * 2. The game's loader (three's GLTFLoader with render/venue-model.ts's plugin and merge) on both: the same node tree
 *    (names, order, userData, transforms), the same geometry bytes and bounds, the same materials and textures, and
 *    the same sharing (which meshes share a material object, which slots share a texture object or an image).
 *    Images are stand-ins that carry their bytes' hash (there is no image decoder here).
 * 3. The Node scripts' loader (scripts/lib/glb-geometry.ts) on both: the same tree and geometry.
 * 4. The game's colliders (trackColliders) from both: byte-identical buffers, identical ground and wall queries.
 * 5. The visual road fit (fitVisualRoad) and scene-builder's shadow rule for Track_Model meshes: the same fitted
 *    vertices and the same casters.
 * 6. The TV director's occlusion pass (camera-rig.ts): the same stations moved to the same dollies.
 * A control run swaps two of a layout's children and must be caught by 2.
 *
 * A venue's KTX2 build for phones (`ktx2Build`) is the same pair with its textures converted to KTX2: it is compared with the
 * layout's own WebP GLB in everything but the image bytes and type and the converter's `alphaKind` material extras
 * (scripts/verify-ktx2-models.ts checks its textures).
 *
 * Layouts whose files this copy doesn't have (hosted on librecorsa.org only) are skipped.
 *
 * Usage: npx tsx scripts/verify-venue-models.ts [layout ...]
 */
import { resolveObjectURL } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { createGltfLoader } from '../src/lib/render/gltf-loader';
import { fitVisualRoad } from '../src/lib/render/fit-visual-road';
import { createVenueLoaders, mergeVenueLayout } from '../src/lib/render/venue-model';
import { createGroundHit } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { trackColliders } from '../src/lib/sim/track-colliders';
import { getActiveTrackData, getActiveTrackMetadata, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { VENUE_MODELS, venueModelFiles, type VenuePair } from '../src/lib/venue-models';
import { TracksideBroadcastDirector } from '../src/lib/render/camera-rig';
import { loadGlbGeometry, readTrackGltfJson } from './lib/glb-geometry';
import { noteSkip } from './lib/hosted-files';

const only = new Set(process.argv.slice(2));
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures++;
};
const sha = (data: ArrayBufferView | string) =>
  createHash('sha256')
    .update(typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex')
    .slice(0, 16);
const readArrayBuffer = (path: string) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const glbJson = (path: string) => {
  const b = readFileSync(path);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
};
const mb = (n: number) => (n / 1e6).toFixed(2);

// ---------------------------------------------------------------------------------------------------------------
// GLTFLoader in Node: images become stand-ins carrying their bytes' hash

(globalThis as unknown as { self?: unknown }).self ??= globalThis;
const standInImages = (parser: GLTFParser) => {
  (parser as unknown as { textureLoader: unknown }).textureLoader = {
    isImageBitmapLoader: false,
    load(url: string, onLoad: (t: THREE.Texture) => void, _p: unknown, onError: (e: unknown) => void) {
      const blob = resolveObjectURL(url);
      if (!blob) return onError(new Error(`no blob ${url}`));
      blob.arrayBuffer().then((buf) => {
        const tex = new THREE.Texture();
        tex.image = { width: 4, height: 4, hash: sha(new Uint8Array(buf)) };
        onLoad(tex);
      }, onError);
    },
  };
  return { name: 'verify_stand_in_images' };
};
/** KTX2 images (KHR_texture_basisu) become the same stand-ins, without a transcoder */
const standInKtx2 = {
  isKTX2Loader: true,
  parse(buf: ArrayBuffer, onLoad: (t: THREE.Texture) => void) {
    const tex = new THREE.Texture();
    tex.image = { width: 4, height: 4, hash: sha(new Uint8Array(buf)) };
    onLoad(tex);
  },
} as unknown as KTX2Loader;
const withStandIns = (loader: GLTFLoader) => loader.register(standInImages).setKTX2Loader(standInKtx2);

async function loadFull(path: string): Promise<THREE.Group> {
  return (await withStandIns(createGltfLoader()).parseAsync(readArrayBuffer(path), '')).scene;
}

async function loadSplitParts(layout: string, shared: string): Promise<{ l: GLTF; s: GLTF }> {
  const loaders = createVenueLoaders();
  withStandIns(loaders.shared);
  withStandIns(loaders.layout);
  const [s, l] = await Promise.all([loaders.sharedLoaded(loaders.shared.parseAsync(readArrayBuffer(shared), '')), loaders.layout.parseAsync(readArrayBuffer(layout), '')]);
  return { l, s };
}

const TEXTURE_SLOTS = ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'lightMap', 'bumpMap', 'clearcoatMap', 'specularIntensityMap', 'sheenColorMap'] as const;

/**
 * The scene, one line per object in depth-first order; objects, materials, textures and images numbered by first use.
 * `ktx2`: leave out image bytes and type and the converter's extras (a KTX2 build against the WebP GLB).
 */
function describeLoaded(root: THREE.Object3D, ktx2 = false): string[] {
  const ids = new Map<object, number>();
  const id = (kind: string, o: object) => {
    if (!ids.has(o)) ids.set(o, ids.size);
    return `${kind}#${ids.get(o)}`;
  };
  const vec = (v: { toArray(): number[] }) => v.toArray().join(',');
  const lines: string[] = [];
  const texture = (t: THREE.Texture | null | undefined) => {
    if (!t) return null;
    return {
      id: id('tex', t),
      source: id('src', t.source),
      image: ktx2 ? undefined : (t.image as { hash?: string })?.hash,
      props: [t.name, vec(t.offset), vec(t.repeat), t.rotation, vec(t.center), t.channel, t.colorSpace, t.wrapS, t.wrapT, t.magFilter, t.minFilter, t.flipY, t.generateMipmaps, JSON.stringify(ktx2 ? { ...t.userData, mimeType: undefined } : t.userData)].join('|'),
    };
  };
  const walk = (o: THREE.Object3D, depth: number) => {
    const parts = [depth, o.type, o.name, JSON.stringify(o.userData), vec(o.position), vec(o.quaternion), vec(o.scale), o.visible, o.children.length];
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const g = mesh.geometry;
      const attrs = Object.keys(g.attributes)
        .sort()
        .map((k) => {
          const a = g.attributes[k] as THREE.BufferAttribute;
          return `${k}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}:${a.count}:${sha(a.array as ArrayBufferView)}`;
        });
      const bounds = [g.boundingBox && `${vec(g.boundingBox.min)}/${vec(g.boundingBox.max)}`, g.boundingSphere && `${vec(g.boundingSphere.center)}/${g.boundingSphere.radius}`];
      parts.push(attrs.join(' '), g.index ? sha(g.index.array as ArrayBufferView) : 'no-index', bounds.join(' '), id('geo', g));
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const std = m as THREE.MeshStandardMaterial;
        const userData = ktx2 ? Object.fromEntries(Object.entries(m.userData).filter(([k]) => k !== 'alphaKind')) : m.userData;
        const props = [m.type, m.name, m.side, m.transparent, m.opacity, m.alphaTest, m.depthWrite, m.vertexColors, std.flatShading, std.color?.getHexString(), std.emissive?.getHexString(), std.emissiveIntensity, std.roughness, std.metalness, std.normalScale && vec(std.normalScale), JSON.stringify(userData)];
        const slots = TEXTURE_SLOTS.map((s) => [s, texture((std as unknown as Record<string, THREE.Texture | null>)[s])] as const).filter(([, t]) => t);
        parts.push(id('mat', m), props.join('|'), JSON.stringify(slots));
      }
    }
    lines.push(parts.join(' ; '));
    for (const c of o.children) walk(c, depth + 1);
  };
  for (const c of root.children) walk(c, 0);
  return lines;
}

/** The Node loader's tree, one line per object */
function describeGeometry(root: THREE.Object3D): string[] {
  const lines: string[] = [];
  const walk = (o: THREE.Object3D, depth: number) => {
    const parts = [depth, o.name, JSON.stringify(o.userData), o.position.toArray().join(','), o.quaternion.toArray().join(','), o.scale.toArray().join(','), o.children.length];
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const g = mesh.geometry;
      for (const k of Object.keys(g.attributes).sort()) parts.push(`${k}:${sha(g.attributes[k].array as ArrayBufferView)}`);
      parts.push(g.index ? sha(g.index.array as ArrayBufferView) : 'no-index');
    }
    lines.push(parts.join(' ; '));
    for (const c of o.children) walk(c, depth + 1);
  };
  for (const c of root.children) walk(c, 0);
  return lines;
}

function firstDifference(a: string[], b: string[]): string {
  if (a.length !== b.length) return `${a.length} vs ${b.length} objects`;
  const i = a.findIndex((x, k) => x !== b[k]);
  if (i < 0) return '';
  // From just before the first character that differs: the start of a long line is usually the same in both
  let c = 0;
  while (c < a[i].length && a[i][c] === b[i][c]) c++;
  const from = Math.max(0, c - 60);
  return `object ${i}, at ${c}: …${a[i].slice(from, c + 100)} | …${b[i].slice(from, c + 100)}`;
}

const sameBuffers = (a: object, b: object) => {
  const ka = Object.keys(a);
  if (ka.join() !== Object.keys(b).join()) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (ArrayBuffer.isView(va) && ArrayBuffer.isView(vb)) {
      if (!Buffer.from(va.buffer, va.byteOffset, va.byteLength).equals(Buffer.from(vb.buffer, vb.byteOffset, vb.byteLength))) return false;
    } else if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
  }
  return true;
};

/** scene-builder's shadow rule for a Track_Model mesh: a non-decal whose world bounding box is over 1.2 m tall */
function shadowCasters(root: THREE.Object3D): string[] {
  const out: string[] = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    let node: THREE.Object3D | null = obj;
    let topName = obj.name;
    let isDecal = false;
    while (node && node !== root) {
      if (node.userData?.decal) isDecal = true;
      topName = node.name;
      node = node.parent;
    }
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || topName !== 'Track_Model') return;
    mesh.geometry.computeBoundingBox();
    box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld).getSize(size);
    out.push(`${mesh.name}:${!isDecal && size.y > 1.2}`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

/** A layout's own full GLB */
const fullGlb = (id: string) => `public/tracks/${id}/${id}.glb`;

/** Checks one pair against the layout's own GLB; false when this copy lacks one of their files (skipped) */
async function verifyLayout(id: string, files: VenuePair, ktx2: boolean): Promise<boolean> {
  const build = files.build;
  const fullPath = fullGlb(id);
  const layoutPath = `public${files.layoutUrl}`;
  const sharedPath = `public${files.sharedUrl}`;
  const missing = [`public/tracks/${id}/track_data.json`, fullPath, layoutPath, sharedPath].find((f) => !existsSync(f));
  if (missing) {
    noteSkip(id, missing);
    return false;
  }
  console.log(`\n${id} (build ${build}${ktx2 ? ', KTX2' : ''})`);
  const full = statSync(fullPath).size;
  const layoutBytes = statSync(layoutPath).size;
  const sharedBytes = statSync(sharedPath).size;
  console.log(`  bytes: own GLB ${mb(full)} MB; first layout of the venue ${mb(layoutBytes + sharedBytes)} MB; after another layout ${mb(layoutBytes)} MB`);

  // 1. The pair
  const lx = glbJson(layoutPath).extras?.lcVenueLayout;
  const sx = glbJson(sharedPath).extras?.lcVenueShared;
  const venue = VENUE_MODELS.find((v) => v.layouts.includes(id))!;
  check('the layout file names this venue and build', lx?.venue === venue.venue && lx?.shared === build, `${lx?.venue} ${lx?.shared}`);
  check("the shared file is this venue's, for these layouts", sx?.venue === venue.venue && JSON.stringify(sx?.layouts) === JSON.stringify(venue.layouts));

  // 2. The game's loader
  const a = describeLoaded(await loadFull(fullPath), ktx2);
  const { l, s } = await loadSplitParts(layoutPath, sharedPath);
  const b = describeLoaded(mergeVenueLayout(l, s), ktx2);
  const diff = firstDifference(a, b);
  check('GLTFLoader: same tree, geometry, materials, textures and sharing', !diff, diff || `${a.length} objects`);

  // 3-5. The Node loader, the colliders, the road fit and the shadow rule
  setActiveTrack(id, JSON.parse(readFileSync(`public/tracks/${id}/track_data.json`, 'utf8')) as RawTrackJson);
  const track = getActiveTrackData(1200);
  const rootA = loadGlbGeometry(fullPath);
  const rootB = loadGlbGeometry(layoutPath, sharedPath);
  const gdiff = firstDifference(describeGeometry(rootA), describeGeometry(rootB));
  check('glb-geometry: same tree and geometry', !gdiff, gdiff);
  const A = trackColliders(rootA);
  const B = trackColliders(rootB);
  check('colliders: ground buffers byte-identical', !!A.ground && !!B.ground && sameBuffers(A.ground.toBuffers(), B.ground.toBuffers()), `${A.ground?.triangleCount} triangles`);
  check('colliders: wall buffers byte-identical', sameBuffers(A.walls.toBuffers(), B.walls.toBuffers()), `${A.walls.segmentCount} segments`);
  let same = 0;
  let hits = 0;
  const ha = createGroundHit();
  const hb = createGroundHit();
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const smp = track.getSampleAtDistance((i / N) * track.totalLengthM);
    const lat = ((i * 37) % 61) - 30;
    const x = smp.position.x + smp.binormal.x * lat;
    const z = smp.position.z + smp.binormal.z * lat;
    const qa = A.ground!.query(x, z, smp.position.y + 2, ha);
    const qb = B.ground!.query(x, z, smp.position.y + 2, hb);
    if (qa) hits++;
    if (qa === qb && (!qa || (ha.height === hb.height && ha.nx === hb.nx && ha.ny === hb.ny && ha.nz === hb.nz && ha.surface === hb.surface && ha.grip === hb.grip))) same++;
  }
  check(`colliders: ${N} ground queries identical`, same === N && hits > N / 2, `${same} / ${N}, ${hits} hits`);
  let wallSame = 0;
  const wa = new Int32Array(64);
  const wb = new Int32Array(64);
  for (let i = 0; i < 1500; i++) {
    const smp = track.getSampleAtDistance((i / 1500) * track.totalLengthM);
    const lat = (i % 2 ? 1 : -1) * (smp.width / 2 + 3);
    const na = A.walls.near(smp.position.x + smp.binormal.x * lat, smp.position.z + smp.binormal.z * lat, 8, wa);
    const nb = B.walls.near(smp.position.x + smp.binormal.x * lat, smp.position.z + smp.binormal.z * lat, 8, wb);
    if (na === nb && wa.subarray(0, na).every((v, k) => v === wb[k])) wallSame++;
  }
  check('colliders: 1500 wall queries identical', wallSame === 1500, `${wallSame} / 1500`);
  if (A.conformSurfaces && A.ground && B.ground) {
    // As the game fits it: the layers keep their order by the layout's road materials
    const roadMaterials = getActiveTrackMetadata().mesh?.roadMaterials;
    fitVisualRoad(rootA, A.ground, roadMaterials);
    fitVisualRoad(rootB, B.ground, roadMaterials);
  }
  const fdiff = firstDifference(describeGeometry(rootA), describeGeometry(rootB));
  check('fitVisualRoad: same fitted vertices', !fdiff, fdiff);
  const ca = shadowCasters(rootA);
  const cb = shadowCasters(rootB);
  check('shadow rule: same casters', firstDifference(ca, cb) === '', `${ca.filter((c) => c.endsWith('true')).length} of ${ca.length} Track_Model meshes cast`);

  // 6. The TV director's occlusion pass (camera-rig.ts) on both, physics hidden as scene-builder hides it
  const tvA = tvStations(track, rootA, readTrackGltfJson(fullPath));
  const tvB = tvStations(track, rootB, readTrackGltfJson(layoutPath, sharedPath));
  check('TV director: same stations moved, same dollies', tvA.moved === tvB.moved && firstDifference(tvA.points, tvB.points) === '', `${tvA.moved} moved, ${tvA.points.length} dollies`);
  return true;
}

/** The TV director's dollies after its occlusion pass, with each mesh's side from its glTF material */
function tvStations(track: ReturnType<typeof getActiveTrackData>, root: THREE.Object3D, json: ReturnType<typeof readTrackGltfJson>) {
  const doubleSided = new Map((json.materials ?? []).map((m) => [m.name ?? '', Boolean(m.doubleSided)]));
  root.traverse((o) => {
    let hidden = false;
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (p.userData?.collider || p.userData?.hidden) hidden = true;
    if (hidden) o.visible = false;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ side: doubleSided.get(mesh.userData.materialName) ? THREE.DoubleSide : THREE.FrontSide });
  });
  root.updateMatrixWorld(true);
  const director = new TracksideBroadcastDirector(track);
  let moved = 0;
  for (const m of director.occlusionSteps(root)) moved = m;
  const curves = (director as unknown as { curves: THREE.CatmullRomCurve3[] }).curves;
  return { moved, points: curves.map((c) => c.points.map((p) => p.toArray().join(',')).join(';')) };
}

async function main() {
  const layouts = VENUE_MODELS.flatMap((v) => v.layouts).filter((id) => !only.size || only.has(id));
  // Each layout's WebP pair, and its KTX2 pair for phones where the venue has one
  const pairs = layouts.flatMap((id) => {
    const files = venueModelFiles(id)!;
    return [{ id, files: files as VenuePair, ktx2: false }, ...(files.ktx2 ? [{ id, files: files.ktx2, ktx2: true }] : [])];
  });
  const verified: typeof pairs = [];
  for (const pair of pairs) if (await verifyLayout(pair.id, pair.files, pair.ktx2)) verified.push(pair);

  // Control: a pair merged with two children swapped must not pass as the same scene. It runs on a pair checked above,
  // so this copy has the layout's full GLB and both files of the pair
  const control = verified[0];
  console.log('\ncontrol');
  if (control) {
    const { l, s } = await loadSplitParts(`public${control.files.layoutUrl}`, `public${control.files.sharedUrl}`);
    const order = (l.userData.lcVenueLayout as { order: number[] }).order;
    [order[0], order[1]] = [order[1], order[0]];
    const swapped = describeLoaded(mergeVenueLayout(l, s), control.ktx2);
    const a = describeLoaded(await loadFull(fullGlb(control.id)), control.ktx2);
    check(`${control.id} with two Track_Model children swapped is caught`, firstDifference(a, swapped) !== '');
  } else console.log('  SKIP  control: no layout above had its full GLB and both files of its pair in this copy');

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll venue model checks passed');
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
