/**
 * Every ported car GLB, loaded the way the browser loads it (three's GLTFLoader, textures left out so it runs in
 * Node), hands the rig its root extras: `portedCarRoot` finds the node with `wheelCentres`, tyre sizes and cameras.
 *
 *   npx tsx scripts/verify-ported-roots.ts
 *
 * The other ported-car suites parse GLBs with their own reader (`scripts/lib/glb-geometry.ts`), which keeps names as
 * written; GLTFLoader names the scene before its nodes, so a GLB whose scene is called "CAR" loads its root as
 * "CAR_1". The GT3 ports did, and the rig read the scene's empty userData: nominal axles, tyres and cameras.
 */
import { readFileSync } from "node:fs";
import type * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CARS } from "../src/lib/cars/car-registry";
import { portedCarRoot } from "../src/lib/ported-car-model";
import { hasFile, noteSkip } from "./lib/hosted-files";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (cond) passed++;
  else failed++;
}

/** The GLB with its images, textures and samplers dropped (Node has no image decoder); geometry and extras unchanged */
function textureless(buf: Buffer): ArrayBuffer {
  const n = buf.readUInt32LE(12);
  const j = JSON.parse(buf.subarray(20, 20 + n).toString("utf8"));
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
      for (const k of Object.keys(e)) if (k.endsWith("Texture")) delete e[k];
    }
  }
  let json = Buffer.from(JSON.stringify(j));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + n);
  const out = Buffer.alloc(20 + json.length + rest.length);
  out.write("glTF", 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  rest.copy(out, 20 + json.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

const load = (url: string) =>
  new Promise<THREE.Group>((resolve, reject) =>
    new GLTFLoader().parse(textureless(readFileSync(`public${url}`)), "", (g) => resolve(g.scene), reject)
  );

async function main(): Promise<void> {
  console.log("Ported car roots through GLTFLoader");
  for (const car of CARS) {
    if (!car.modelUrl) continue;
    if (!hasFile(`public${car.modelUrl}`)) {
      noteSkip(car.id, `public${car.modelUrl}`);
      continue;
    }
    const scene = await load(car.modelUrl);
    const root = portedCarRoot(scene);
    const extras = root.userData as { wheelCentres?: Record<string, number[]>; tyreRadius?: Record<string, number>; cameras?: object };
    check(
      `${car.id}: the rig finds the root's extras`,
      root !== scene && !!extras.wheelCentres?.WHEEL_LF && !!extras.wheelCentres?.WHEEL_LR && !!extras.tyreRadius?.LF,
      `root "${root.name}" under scene "${scene.name}"`
    );
  }
  console.log(`\nPorted car roots: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
