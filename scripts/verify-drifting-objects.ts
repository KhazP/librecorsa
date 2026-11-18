/**
 * Objects drifting over a converted circuit, and props grafted in from another of a mod's models
 * (scripts/tracks/port_ac_track.py `driftingObjects` / `extraModels` / `--extras-only`, scripts/lib/graft-glb.mjs,
 * src/lib/render/drifting-objects.ts):
 *
 * 1. the graft, on a synthetic pair: the circuit's binary chunk is the result's first bytes, unchanged; both models'
 *    meshes load where they were; an add-on image with the same bytes as one of the circuit's is mapped to it; a second
 *    graft and an add-on placed elsewhere are refused;
 * 2. the motion, on synthetic meshes under a scaled node: each slot starts within ±range of its centre and moves at
 *    velBase ± velRange, the offset handed to the shader is that world offset in the mesh's own space, every load
 *    starts the same, the patched vertex shader reads `_drift` and the offsets, and a material another mesh also draws
 *    with is copied (defines kept) rather than patched;
 * 3. Willow Springs' GLB, when this copy has it: 32 objects (31 balloons on one mesh over an atlas, the blimp), every
 *    vertex's slot listed on its node and every listed slot drawn, no shadows, and no grafted prop is physics.
 *
 *   npx tsx scripts/verify-drifting-objects.ts
 */
import { resolveObjectURL } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import * as THREE from 'three';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { attachDriftingObjects, DRIFT_SLOTS } from '../src/lib/render/drifting-objects';
import { createGltfLoader } from '../src/lib/render/gltf-loader';
import { graftGlb } from './lib/graft-glb.mjs';
import { parseGlb } from './lib/ktx2-textures.mjs';
import { hasFile, noteSkip } from './lib/hosted-files';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(78)} ${detail}`);
  if (!ok) failures++;
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

// ---------------------------------------------------------------------------------------------------------------
// 1. Graft

/** A meshopt-compressed GLB: Track_Model at `place`, one triangle at `at` with a texture per image */
async function synthetic(place: number[], at: number[], images: string[], extras: Record<string, unknown> = {}, prefix = 'part'): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const tm = doc.createNode('Track_Model').setTranslation(place as [number, number, number]);
  doc.createScene().addChild(tm);
  images.forEach((bytes, i) => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1].map((v, k) => v + at[k % 3] + i * 10));
    const tex = doc.createTexture(`img${i}`).setImage(new TextEncoder().encode(bytes)).setMimeType('image/png');
    const mat = doc.createMaterial(`mat${i}`).setBaseColorTexture(tex);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer))
      .setMaterial(mat);
    tm.addChild(doc.createNode(`${prefix}${i}`).setMesh(doc.createMesh(`${prefix}${i}`).addPrimitive(prim)).setExtras(extras));
  });
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return io.writeBinary(doc);
}

/** World-space vertices of each mesh node, by name */
async function worldVerts(glb: Uint8Array): Promise<Map<string, number[]>> {
  const doc = await io.readBinary(glb);
  const out = new Map<string, number[]>();
  for (const node of doc.getRoot().listNodes()) {
    const prim = node.getMesh()?.listPrimitives()[0];
    if (!prim) continue;
    const m = node.getWorldMatrix();
    const pos = prim.getAttribute('POSITION')!;
    const v: number[] = [];
    const el = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      v.push(m[0] * el[0] + m[12], m[5] * el[1] + m[13], m[10] * el[2] + m[14]);
    }
    out.set(node.getName(), v);
  }
  return out;
}

async function main(): Promise<void> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  console.log('1. Graft');
  {
    const place = [391.6, 52.7, 388.8];
    const circuit = Buffer.from(await synthetic(place, [0, 0, 0], ['shared-bytes', 'circuit-only']));
    const addon = Buffer.from(await synthetic(place, [500, 200, -300], ['shared-bytes', 'addon-only'], { fromModel: 'event.kn5' }, 'extra'));
    const out = graftGlb(circuit, addon, 'synthetic');
    const before = parseGlb(circuit, 'circuit');
    const after = parseGlb(out.glb, 'result');
    check("the circuit's binary chunk comes first, unchanged", after.bin.subarray(0, before.bin.length).equals(before.bin));
    check("the circuit's JSON objects are unchanged", ['accessors', 'bufferViews', 'meshes', 'materials'].every(
      (k) => JSON.stringify((after.json[k] as unknown[]).slice(0, (before.json[k] as unknown[]).length)) === JSON.stringify(before.json[k])
    ));
    const a = await worldVerts(circuit);
    const b = await worldVerts(addon);
    const c = await worldVerts(out.glb);
    const close = (x: number[] | undefined, y: number[] | undefined) => !!x && !!y && x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-3);
    check('the circuit keeps its meshes where they were', close(c.get('part0'), a.get('part0')) && close(c.get('part1'), a.get('part1')));
    const grafted = [...(await io.readBinary(out.glb)).getRoot().listNodes()].filter((n) => (n.getExtras() as { fromModel?: string }).fromModel);
    check('the add-on meshes join Track_Model where the add-on had them', grafted.length === 2 && grafted.every((n) => n.getParentNode()?.getName() === 'Track_Model'));
    check('the grafted meshes land where the add-on had them', close(c.get('extra0'), b.get('extra0')) && close(c.get('extra1'), b.get('extra1')));
    check('an add-on image with the circuit\'s bytes maps to the circuit\'s', after.json.images.length === 3 && out.shared === 1, `${after.json.images.length} images`);
    let refused = false;
    try {
      graftGlb(out.glb, addon, 'twice');
    } catch {
      refused = true;
    }
    check('a second graft is refused', refused);
    refused = false;
    try {
      graftGlb(circuit, Buffer.from(await synthetic([0, 0, 0], [0, 0, 0], ['x'])), 'moved');
    } catch {
      refused = true;
    }
    check('an add-on whose Track_Model sits elsewhere is refused', refused);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 2. Motion and shader
  console.log('2. Motion');

  const SCALE = 250;
  function driftScene(shareMaterial: boolean) {
    const root = new THREE.Group();
    const node = new THREE.Group();
    node.position.set(10, 20, 30);
    node.scale.setScalar(SCALE);
    root.add(node);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 1, 1, 1, 1.1, 1, 1, 1, 1.1, 1], 3));
    geom.setAttribute('_drift', new THREE.Float32BufferAttribute([0, 0, 0, 5, 5, 5].map((s) => (s + 0.5) / DRIFT_SLOTS), 1));
    const mat = new THREE.MeshStandardMaterial();
    mat.defines = { STANDARD: '', PHYSICAL: '' };
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.drift = [
      { slot: 0, range: [100, 50, 100], velBase: [0.2, 0.2, 0.2], velRange: [0.1, 0, 0.1] },
      { slot: 5, range: [10, 0, 10], velBase: [0, 0, 0], velRange: [0, 0, 0] },
    ];
    node.add(mesh);
    if (shareMaterial) root.add(new THREE.Mesh(new THREE.BufferGeometry(), mat));
    return { root, mesh, mat };
  }
  const compile = (mat: THREE.Material) => {
    const shader = {
      uniforms: {} as Record<string, { value: THREE.Vector3[] }>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    return shader;
  };
  {
    const { root, mesh, mat } = driftScene(false);
    const drift = attachDriftingObjects(root);
    check('two objects found', drift?.count === 2, String(drift?.count));
    check('the material is patched in place when only this mesh draws with it', mesh.material === mat);
    check('never culled, no shadow', mesh.frustumCulled === false && mesh.castShadow === false);
    const shader = compile(mesh.material as THREE.Material);
    const offsets = shader.uniforms.uDriftOffset?.value;
    check('the vertex shader reads _drift and adds its slot\'s offset',
      /attribute float _drift;/.test(shader.vertexShader) && /uniform vec3 uDriftOffset\[32\]/.test(shader.vertexShader) &&
        /transformed \+= uDriftOffset\[int\(clamp\(_drift \* 32\.0/.test(shader.vertexShader));
    check('its program has its own cache key', (mesh.material as THREE.Material).customProgramCacheKey() !== new THREE.MeshStandardMaterial().customProgramCacheKey());
    drift!.update(1000);
    const start = offsets!.map((v) => v.clone().multiplyScalar(SCALE));
    drift!.update(1100);
    const vel = offsets!.map((v, i) => v.clone().multiplyScalar(SCALE).sub(start[i]).divideScalar(100));
    const within = (v: THREE.Vector3, lo: number[], hi: number[]) => v.toArray().every((x, k) => x >= lo[k] - 1e-6 && x <= hi[k] + 1e-6);
    check('slot 0 starts within ±range of its centre', within(start[0], [-100, -50, -100], [100, 50, 100]), start[0].toArray().map((x) => x.toFixed(1)).join(', '));
    check('slot 0 moves at velBase ± velRange', within(vel[0], [0.1, 0.2, 0.1], [0.3, 0.2, 0.3]), vel[0].toArray().map((x) => x.toFixed(3)).join(', '));
    check('slot 5 stays at its start (no velocity), within ±10 m', vel[5].length() < 1e-6 && within(start[5], [-10, 0, -10], [10, 0, 10]));
    check('unused slots stay at rest', offsets!.every((v, i) => i === 0 || i === 5 || v.lengthSq() === 0));
    const again = driftScene(false);
    const drift2 = attachDriftingObjects(again.root);
    const offsets2 = compile(again.mesh.material as THREE.Material).uniforms.uDriftOffset!.value;
    drift2!.update(5);
    check('every load starts the same', offsets2.every((v, i) => v.clone().multiplyScalar(SCALE).distanceTo(start[i]) < 1e-6));
    const shared = driftScene(true);
    attachDriftingObjects(shared.root);
    const copy = shared.mesh.material as THREE.MeshStandardMaterial;
    check('a material another mesh draws with is copied, defines kept', copy !== shared.mat && JSON.stringify(copy.defines) === JSON.stringify(shared.mat.defines));
    check('and the other mesh keeps the stock material', shared.mat.customProgramCacheKey() === new THREE.MeshStandardMaterial().customProgramCacheKey());
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 3. Willow Springs
  console.log('3. Willow Springs');
  const WILLOW = 'public/tracks/willow_springs/willow_springs.glb';
  if (!hasFile(WILLOW)) noteSkip('Willow Springs drifting objects', WILLOW);
  else {
    (globalThis as unknown as { self?: unknown }).self ??= globalThis;
    const standInImages = (parser: GLTFParser) => {
      (parser as unknown as { textureLoader: unknown }).textureLoader = {
        isImageBitmapLoader: false,
        load(url: string, onLoad: (t: THREE.Texture) => void, _p: unknown, onError: (e: unknown) => void) {
          if (!resolveObjectURL(url)) return onError(new Error(`no blob ${url}`));
          const tex = new THREE.Texture();
          tex.image = { width: 4, height: 4 };
          onLoad(tex);
        },
      };
      return { name: 'verify_stand_in_images' };
    };
    const b = readFileSync(WILLOW);
    const gltf = await createGltfLoader().register(standInImages).parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, '');
    const root = gltf.scene;
    const nodes: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (Array.isArray(o.userData?.drift)) nodes.push(o);
    });
    const listed = nodes.flatMap((n) => (n.userData.drift as { slot: number }[]).map((s) => s.slot));
    check('32 objects, each slot listed once', listed.length === 32 && new Set(listed).size === 32, `${listed.length} listed`);
    check('31 of them on one mesh (the balloons over one atlas)', nodes.some((n) => n.userData.drift.length === 31));
    let slotsOk = true;
    for (const n of nodes) {
      const own = new Set((n.userData.drift as { slot: number }[]).map((s) => s.slot));
      const seen = new Set<number>();
      n.traverse((m) => {
        const attr = (m as THREE.Mesh).geometry?.getAttribute('_drift');
        if (!attr) return;
        for (let i = 0; i < attr.count; i++) {
          const s = Math.floor(attr.getX(i) * DRIFT_SLOTS);
          if (!own.has(s) || Math.abs(attr.getX(i) * DRIFT_SLOTS - s - 0.5) > 0.05) slotsOk = false;
          seen.add(s);
        }
      });
      if (seen.size !== own.size) slotsOk = false;
    }
    check("every vertex's slot is its node's, and every listed slot is drawn", slotsOk);
    check('none casts a shadow', nodes.every((n) => n.userData.castShadow === false));
    const props: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (o.userData?.fromModel) props.push(o);
    });
    check('the grafted props are drawn, never physics', props.length > 0 && props.every((p) => !p.userData.hidden && !p.userData.collider && !p.userData.surface), `${props.length} nodes`);
    check('the animator takes all 32', attachDriftingObjects(root)?.count === 32);
  }


}

main().then(
  () => {
    if (failures) {
      console.log(`\n${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log('\nAll checks passed');
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
