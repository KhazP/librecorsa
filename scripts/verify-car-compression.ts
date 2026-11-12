/**
 * Headless checks that the deploy's car compression (`scripts/compress-car-glb.mjs`) leaves the geometry the car
 * rigs read in metres: positions stay float, no node's transform changes, and the AMR26's tyre (the AI cars',
 * ghosts' and online peers' model) still measures its real radius. Quantized positions moved each mesh's scale onto
 * its node, so the AMR26 read its tyre as 1 m in radius and every opponent floated about 0.65 m up on the deployed
 * site only (issue #96).
 *
 *   npx tsx scripts/verify-car-compression.ts
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { hasFile, noteSkip } from './lib/hosted-files';

interface GltfNode {
  name?: string;
  mesh?: number;
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}
interface GltfAccessor {
  componentType: number;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}
interface GltfJson {
  nodes: GltfNode[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  accessors: GltfAccessor[];
}

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};

const ROOT = path.resolve(__dirname, '..');
const FLOAT = 5126;

function gltfJson(file: string): GltfJson {
  const buf = readFileSync(file);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as GltfJson;
}

function nodeMatrix(n: GltfNode): THREE.Matrix4 {
  if (n.matrix) return new THREE.Matrix4().fromArray(n.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
    new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(n.scale ?? [1, 1, 1]))
  );
}

function tyreRadius(json: GltfJson, nodeName: string): number {
  const node = json.nodes.find((n) => n.name === nodeName);
  if (node?.mesh === undefined) return NaN;
  const acc = json.accessors[json.meshes[node.mesh].primitives[0].attributes.POSITION];
  return acc.max?.[1] ?? NaN;
}

const work = mkdtempSync(path.join(tmpdir(), 'lc-car-compression-'));
try {
  // The opponents' car and one ported car (small, so the suite stays quick)
  for (const rel of ['public/amr26/model/amr26.glb', 'public/cars/bmw-m4-gt3/model/bmw-m4-gt3.glb']) {
    if (!hasFile(rel)) {
      noteSkip(path.basename(rel), rel);
      continue;
    }
    const raw = path.join(ROOT, rel);
    const out = path.join(work, path.basename(rel));
    copyFileSync(raw, out);
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/compress-car-glb.mjs'), out], { encoding: 'utf8' });
    const label = path.basename(rel);
    check(`${label}: compresses`, run.status === 0, (run.stdout || run.stderr).trim().split('\n')[0] ?? '');
    if (run.status !== 0) continue;

    const before = gltfJson(raw);
    const after = gltfJson(out);

    const quantized = after.meshes
      .flatMap((m) => m.primitives)
      .map((p) => after.accessors[p.attributes.POSITION])
      .filter((a) => a.componentType !== FLOAT || a.normalized);
    check(`${label}: positions stay float`, quantized.length === 0, `${quantized.length} quantized`);

    const moved = before.nodes.filter((n, i) => {
      const a = nodeMatrix(n).elements;
      const b = nodeMatrix(after.nodes[i]).elements;
      return n.name !== after.nodes[i]?.name || a.some((v, k) => Math.abs(v - b[k]) > 1e-5);
    });
    check(`${label}: every node keeps its transform`, moved.length === 0, moved.slice(0, 3).map((n) => n.name).join(', '));

    const r0 = tyreRadius(before, 'WHEEL_LF_TYRE');
    const r1 = tyreRadius(after, 'WHEEL_LF_TYRE');
    check(`${label}: front-left tyre radius unchanged`, Math.abs(r1 - r0) < 1e-4, `${r0.toFixed(4)} → ${r1.toFixed(4)} m`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} car compression check(s) failed.`);
  process.exit(1);
}
console.log('\nAll car compression checks passed.');
