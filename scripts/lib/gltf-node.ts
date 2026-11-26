/**
 * A GLB through three's GLTFLoader in Node, as the browser loads it but without its images (Node has no image
 * decoder): the node graph, meshes, skins and animations, materials without their maps.
 */
import { readFileSync } from 'node:fs';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** The GLB with its images, textures and samplers dropped; geometry, skins, animations and extras unchanged */
export function texturelessGlb(buf: Buffer): ArrayBuffer {
  const n = buf.readUInt32LE(12);
  const j = JSON.parse(buf.subarray(20, 20 + n).toString('utf8'));
  delete j.images;
  delete j.textures;
  delete j.samplers;
  for (const m of j.materials ?? []) {
    const p = m.pbrMetallicRoughness ?? {};
    delete p.baseColorTexture;
    delete p.metallicRoughnessTexture;
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    for (const e of Object.values(m.extensions ?? {}) as Record<string, unknown>[]) {
      for (const k of Object.keys(e)) if (k.endsWith('Texture')) delete e[k];
    }
  }
  let json = Buffer.from(JSON.stringify(j));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + n);
  const out = Buffer.alloc(20 + json.length + rest.length);
  out.write('glTF', 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  rest.copy(out, 20 + json.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

export const loadGltfTextureless = (path: string): Promise<GLTF> =>
  new Promise((resolve, reject) => new GLTFLoader().parse(texturelessGlb(readFileSync(path)), '', resolve, reject));
