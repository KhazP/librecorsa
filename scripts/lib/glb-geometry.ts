/**
 * Minimal GLB reader for Node scripts: rebuilds the node graph (names, TRS, node extras → userData) with
 * position / index geometry (and the first UV set, which the kerb serration ripple reads) only. No materials, textures or DOM, so it runs headless. Reads quantized
 * (KHR_mesh_quantization) positions, and meshopt-compressed circuits via a decoded copy in the temp dir.
 */
import * as THREE from 'three';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';


interface GltfJson {
  extensionsUsed?: string[];
  scenes: { nodes: number[] }[];
  nodes: { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[]; extras?: Record<string, unknown> }[];
  meshes: { primitives: { attributes: { POSITION: number; TEXCOORD_0?: number }; indices?: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
}

const parseJson = (buf: Buffer): GltfJson => JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as GltfJson;

/** The GLB's bytes; a meshopt-compressed file is decoded once (scripts/compress-track-glb.mjs) and cached by mtime */
function readGlb(path: string): Buffer {
  const buf = readFileSync(path);
  if (!parseJson(buf).extensionsUsed?.includes('EXT_meshopt_compression')) return buf;
  const { mtimeMs, size } = statSync(path);
  const decoded = join(tmpdir(), `glb-geometry-${basename(path, '.glb')}-${Math.round(mtimeMs)}-${size}.glb`);
  if (!existsSync(decoded)) {
    // The meshopt decoder's WASM only starts asynchronously, so decode in a child process to keep this sync
    execFileSync(process.execPath, [join(__dirname, 'decode-meshopt-glb.mjs'), path, decoded], { stdio: 'inherit' });
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

export function loadGlbGeometry(path: string): THREE.Group {
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
        return new THREE.Mesh(g);
      });
      if (prims.length === 1) obj = prims[0];
      else {
        obj = new THREE.Group();
        for (const m of prims) obj.add(m);
      }
    } else obj = new THREE.Object3D();
    obj.name = n.name ?? '';
    obj.userData = { ...(n.extras ?? {}) };
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
  return root;
}
