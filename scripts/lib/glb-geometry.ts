/**
 * Minimal GLB reader for Node scripts: rebuilds the node graph (names, TRS, node extras → userData) with
 * position / index geometry only. No materials, textures or DOM, so it runs headless.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';


interface GltfJson {
  scenes: { nodes: number[] }[];
  nodes: { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; extras?: Record<string, unknown> }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
}

export function loadGlbGeometry(path: string): THREE.Group {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as GltfJson;
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart);

  const readAccessor = (idx: number): Float32Array | Uint32Array => {
    const acc = gltf.accessors[idx];
    const view = gltf.bufferViews[acc.bufferView];
    const comps = acc.type === 'VEC3' ? 3 : 1;
    const elemSize = acc.componentType === 5126 || acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1;
    const stride = view.byteStride ?? comps * elemSize;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const out = acc.componentType === 5126 ? new Float32Array(acc.count * comps) : new Uint32Array(acc.count * comps);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * elemSize;
        out[i * comps + c] =
          acc.componentType === 5126
            ? bin.readFloatLE(o)
            : acc.componentType === 5125
              ? bin.readUInt32LE(o)
              : acc.componentType === 5123
                ? bin.readUInt16LE(o)
                : bin.readUInt8(o);
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
        g.setAttribute('position', new THREE.BufferAttribute(readAccessor(p.attributes.POSITION) as Float32Array, 3));
        if (p.indices !== undefined) g.setIndex(new THREE.BufferAttribute(readAccessor(p.indices), 1));
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
    for (const c of n.children ?? []) obj.add(build(c));
    return obj;
  };

  const root = new THREE.Group();
  for (const ni of gltf.scenes[0].nodes) root.add(build(ni));
  root.updateMatrixWorld(true);
  return root;
}
