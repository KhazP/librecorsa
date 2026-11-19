/**
 * Minimal GLB reader for Node scripts: rebuilds the node graph (names, TRS, node extras → userData) with
 * position / index geometry (and the first UV set, which the kerb serration ripple reads) only, plus each primitive's
 * material name in `userData.materialName`. No materials, textures or DOM, so it runs headless. Reads quantized
 * (KHR_mesh_quantization) positions, and meshopt-compressed circuits via a decoded copy in the temp dir.
 *
 * A layout of a venue with a shared model (src/lib/venue-models.ts) is two files: `loadTrackGeometry` reads the pair
 * the way the game does (src/lib/render/venue-model.ts), the shared scenery under the layout's own `Track_Model`.
 */
import * as THREE from 'three';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { venueModelFiles } from '../../src/lib/venue-models';

type Extensions = Record<string, { material?: number; texture?: number } | undefined>;

interface GltfJson {
  extensionsUsed?: string[];
  extras?: { lcVenueLayout?: { venue: string; shared: string; order: number[] } };
  scenes: { nodes: number[] }[];
  nodes: { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[]; extras?: Record<string, unknown> }[];
  meshes: { primitives: { attributes: { POSITION: number; TEXCOORD_0?: number }; indices?: number; material?: number }[] }[];
  materials?: { name?: string; alphaMode?: string; doubleSided?: boolean; extensions?: Extensions; [key: string]: unknown }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
}

/** The glTF extension a venue layout file uses to point at the shared file's materials and textures */
const VENUE_EXTENSION = 'LC_venue_shared';
/** A venue layout file's meshes whose material is the shared file's: that material's number there */
const sharedMaterialOf = new WeakMap<THREE.Object3D, number>();

const parseJson = (buf: Buffer): GltfJson => JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as GltfJson;

/** The GLB's bytes; a meshopt-compressed file is decoded once (scripts/compress-track-glb.mjs) and cached by mtime */
function readGlb(path: string): Buffer {
  const buf = readFileSync(path);
  if (!parseJson(buf).extensionsUsed?.includes('EXT_meshopt_compression')) return buf;
  const { mtimeMs, size } = statSync(path);
  const decoded = join(tmpdir(), `glb-geometry-${basename(path, '.glb')}-${Math.round(mtimeMs)}-${size}.glb`);
  if (!existsSync(decoded)) {
    // The meshopt decoder's WASM only starts asynchronously, so decode in a child process to keep this sync.
    // The verify suites run side by side (scripts/run-verify.mjs), so the copy is written under this process's own
    // name and renamed into place: another suite never reads a half-written file.
    const partial = `${decoded}.${process.pid}.partial`;
    execFileSync(process.execPath, [join(__dirname, 'decode-meshopt-glb.mjs'), path, partial], { stdio: 'inherit' });
    renameSync(partial, decoded);
  }
  return readFileSync(decoded);
}

/** Byte size, reader and normalization divisor for each glTF component type */
const COMPONENTS: Record<number, { size: number; read: (b: Buffer, o: number) => number; norm: number }> = {
  5120: { size: 1, read: (b, o) => b.readInt8(o), norm: 127 },
  5121: { size: 1, read: (b, o) => b.readUInt8(o), norm: 255 },
  5122: { size: 2, read: (b, o) => b.readInt16LE(o), norm: 32767 },
  5123: { size: 2, read: (b, o) => b.readUInt16LE(o), norm: 65535 },
  5125: { size: 4, read: (b, o) => b.readUInt32LE(o), norm: 1 },
  5126: { size: 4, read: (b, o) => b.readFloatLE(o), norm: 1 },
};

/**
 * A GLB's node graph. With `sharedPath`, `path` is a venue layout file and the shared file's scenery goes under its
 * `Track_Model`, in the layout's original order (src/lib/render/venue-model.ts does the same in the game).
 */
export function loadGlbGeometry(path: string, sharedPath?: string): THREE.Group {
  const layout = buildGlbGeometry(path);
  if (sharedPath) {
    const order = layout.json.extras?.lcVenueLayout?.order;
    if (!order) throw new Error(`${path}: not a venue layout file`);
    const shared = buildGlbGeometry(sharedPath);
    const tm = layout.root.children.find((o) => o.name === 'Track_Model');
    const sharedTm = shared.root.children.find((o) => o.name === 'Track_Model');
    if (!tm || !sharedTm) throw new Error(`${path}: Track_Model missing`);
    const own = [...tm.children];
    const common = [...sharedTm.children];
    for (const k of order) {
      const child = k >= 0 ? common[k] : own[~k];
      if (!child) throw new Error(`${path}: its order does not fit ${sharedPath}`);
      tm.add(child);
    }
    if (tm.children.length !== own.length + common.length) throw new Error(`${path}: its order leaves children out`);
    layout.root.traverse((o) => {
      const ref = sharedMaterialOf.get(o);
      if (ref !== undefined) o.userData.alphaMode = shared.json.materials?.[ref]?.alphaMode ?? 'OPAQUE';
    });
    layout.root.updateMatrixWorld(true);
  }
  return layout.root;
}

/** The files the game loads for a circuit: its venue's split pair when this copy has both, else its own GLB */
export function trackModelFiles(track: { id?: string; meshUrl?: string }): { path: string; shared?: string } {
  const split = venueModelFiles(track.id);
  if (split && existsSync(`public${split.layoutUrl}`) && existsSync(`public${split.sharedUrl}`)) {
    return { path: `public${split.layoutUrl}`, shared: `public${split.sharedUrl}` };
  }
  if (!track.meshUrl) throw new Error(`circuit ${track.id ?? '?'} has no mesh url`);
  return { path: `public${track.meshUrl}` };
}

/** A circuit's model as the game loads it (`trackModelFiles`); paths are relative to the repository root */
export function loadTrackGeometry(track: { id?: string; meshUrl?: string }): THREE.Group {
  const files = trackModelFiles(track);
  return loadGlbGeometry(files.path, files.shared);
}

/**
 * A GLB's JSON (nodes, meshes, materials) for checks that read it directly. For a venue layout file with its shared
 * file, one document as the full GLB would have it: the shared file's nodes, meshes and materials appended, its
 * scenery listed under `Track_Model` in the original order, and every material reference resolved to the shared
 * material's definition. Accessors and textures are not merged.
 */
export function readTrackGltfJson(path: string, sharedPath?: string): Pick<GltfJson, 'scenes' | 'nodes' | 'meshes' | 'materials'> {
  const json = parseJson(readFileSync(path));
  if (!sharedPath) return json;
  const shared = parseJson(readFileSync(sharedPath));
  const order = json.extras?.lcVenueLayout?.order;
  if (!order) throw new Error(`${path}: not a venue layout file`);
  const nodeBase = json.nodes.length;
  const meshBase = json.meshes.length;
  const ownMaterials = json.materials ?? [];
  const sharedMaterials = shared.materials ?? [];
  const materials = [
    ...ownMaterials.map((m) => {
      const ref = m.extensions?.[VENUE_EXTENSION]?.material;
      return ref === undefined ? m : sharedMaterials[ref];
    }),
    ...sharedMaterials,
  ];
  const meshes = [
    ...json.meshes,
    ...shared.meshes.map((m) => ({ ...m, primitives: m.primitives.map((p) => ({ ...p, ...(p.material !== undefined ? { material: p.material + ownMaterials.length } : {}) })) })),
  ];
  const nodes = [
    ...json.nodes.map((n) => ({ ...n })),
    ...shared.nodes.map((n) => ({ ...n, ...(n.mesh !== undefined ? { mesh: n.mesh + meshBase } : {}), ...(n.children ? { children: n.children.map((c) => c + nodeBase) } : {}) })),
  ];
  const tm = json.nodes.findIndex((n) => n.name === 'Track_Model');
  const sharedTm = shared.scenes[0].nodes[0];
  const sharedKids = (shared.nodes[sharedTm].children ?? []).map((c) => c + nodeBase);
  const ownKids = json.nodes[tm].children ?? [];
  nodes[tm].children = order.map((k) => (k >= 0 ? sharedKids[k] : ownKids[~k]));
  return { scenes: json.scenes, nodes, meshes, materials };
}

function buildGlbGeometry(path: string): { root: THREE.Group; json: GltfJson } {
  const buf = readGlb(path);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = parseJson(buf);
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart);

  const readAccessor = (idx: number, asFloat: boolean): Float32Array | Uint32Array => {
    const acc = gltf.accessors[idx];
    const view = gltf.bufferViews[acc.bufferView];
    const comps = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
    const comp = COMPONENTS[acc.componentType];
    const stride = view.byteStride ?? comps * comp.size;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out = asFloat ? new Float32Array(acc.count * comps) : new Uint32Array(acc.count * comps);
    // Normalized integers map to [-1, 1] / [0, 1], clamped as the glTF spec requires
    const norm = acc.normalized ? comp.norm : 1;
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const v = comp.read(bin, base + i * stride + c * comp.size);
        out[i * comps + c] = norm === 1 ? v : Math.max(v / norm, -1);
      }
    }
    return out;
  };

  const build = (ni: number): THREE.Object3D => {
    const n = gltf.nodes[ni];
    let obj: THREE.Object3D;
    if (n.mesh !== undefined) {
      const prims = gltf.meshes[n.mesh].primitives.map((p) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(readAccessor(p.attributes.POSITION, true), 3));
        if (p.attributes.TEXCOORD_0 !== undefined) g.setAttribute('uv', new THREE.BufferAttribute(readAccessor(p.attributes.TEXCOORD_0, true), 2));
        if (p.indices !== undefined) g.setIndex(new THREE.BufferAttribute(readAccessor(p.indices, false), 1));
        const mesh = new THREE.Mesh(g);
        // The material's name and alpha mode only (no material is built), for tests that pick primitives by it. A venue
        // layout file's material points at the shared file's for its alpha mode (`loadGlbGeometry` reads it there)
        if (p.material !== undefined) {
          const mat = gltf.materials?.[p.material];
          mesh.userData.materialName = mat?.name ?? '';
          mesh.userData.alphaMode = mat?.alphaMode ?? 'OPAQUE';
          const shared = mat?.extensions?.[VENUE_EXTENSION]?.material;
          if (shared !== undefined) sharedMaterialOf.set(mesh, shared);
        }
        return mesh;
      });
      if (prims.length === 1) obj = prims[0];
      else {
        obj = new THREE.Group();
        for (const m of prims) obj.add(m);
      }
    } else obj = new THREE.Object3D();
    obj.name = n.name ?? '';
    // Node extras next to a single primitive's material name (the node is that primitive's mesh)
    obj.userData = { ...obj.userData, ...(n.extras ?? {}) };
    if (n.translation) obj.position.fromArray(n.translation);
    if (n.rotation) obj.quaternion.fromArray(n.rotation);
    if (n.scale) obj.scale.fromArray(n.scale);
    if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(obj.position, obj.quaternion, obj.scale);
    for (const c of n.children ?? []) obj.add(build(c));
    return obj;
  };

  const root = new THREE.Group();
  for (const ni of gltf.scenes[0].nodes) root.add(build(ni));
  root.updateMatrixWorld(true);
  return { root, json: gltf };
}
