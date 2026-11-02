/**
 * Scenery detail (src/lib/render/scenery-detail.ts): the shader patches land on three's current shader source, the
 * right materials are patched (and nothing else), the rough-diffuse conversion's defines survive, and the tree bake
 * turns the real Rwanda GLB's flat-shaded trees into rounded, tinted, occluded crowns.
 *
 *   npx tsx scripts/verify-scenery.ts
 */
import * as THREE from 'three';
import {
  applySceneryDetail,
  FRAGMENT_PATCHES,
  prepareTreeGeometry,
  sceneryKind,
  setSceneryQuality,
  VERTEX_PATCHES,
} from '../src/lib/render/scenery-detail';
import { loadGlbGeometry } from './lib/glb-geometry';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}

const count = (source: string, anchor: string) => source.split(anchor).length - 1;

console.log('Shader anchors (three r' + THREE.REVISION + ')');
for (const lib of ['standard', 'physical'] as const) {
  const { vertexShader, fragmentShader } = THREE.ShaderLib[lib];
  for (const [anchor] of VERTEX_PATCHES) check(`${lib} vertex: "${anchor}" exactly once`, count(vertexShader, anchor) === 1);
  for (const [anchor] of FRAGMENT_PATCHES) check(`${lib} fragment: "${anchor}" exactly once`, count(fragmentShader, anchor) === 1);
}
// The fragment patches read `normal`, `faceDirection`, `vViewPosition`, `diffuseColor`, `roughnessFactor` and
// `reflectedLight`: each must already be declared where its patch lands
{
  const frag = THREE.ShaderLib.physical.fragmentShader;
  const at = (s: string) => frag.indexOf(s);
  check('colour patch runs before the roughness and normal patches', at('#include <color_fragment>') < at('#include <roughnessmap_fragment>') && at('#include <roughnessmap_fragment>') < at('#include <normal_fragment_maps>'));
  check('normal patch runs after normal_fragment_begin (normal, faceDirection)', at('#include <normal_fragment_begin>') < at('#include <normal_fragment_maps>'));
  check('occlusion patch runs after the lights have filled reflectedLight', at('#include <lights_fragment_end>') < at('#include <aomap_fragment>'));
  const vert = THREE.ShaderLib.physical.vertexShader;
  check('vertex patch runs after objectNormal exists', vert.indexOf('#include <beginnormal_vertex>') < vert.indexOf('#include <begin_vertex>'));
}

console.log('Which materials');
const named = (name: string, opts: THREE.MeshStandardMaterialParameters = {}) => Object.assign(new THREE.MeshStandardMaterial(opts), { name });
check('Tree_Canopy is a tree', sceneryKind(named('Tree_Canopy')) === 'TREE');
check('Grandstand_Canopy is a roof, Building_White a building', sceneryKind(named('Grandstand_Canopy')) === 'ROOF' && sceneryKind(named('Building_White')) === 'BUILDING');
check('Lake_Water is water; Paint_White and Kerb_Yellow are paint', sceneryKind(named('Lake_Water')) === 'WATER' && sceneryKind(named('Paint_White')) === 'PAINT' && sceneryKind(named('Kerb_Yellow')) === 'PAINT');
check('a textured material of the same name is left alone', sceneryKind(named('Tree_Canopy', { map: new THREE.Texture() })) === null);
check("other circuits' names (TREE11A.002, Terrain_Grass) are left alone", sceneryKind(named('TREE11A.002')) === null && sceneryKind(named('Terrain_Grass')) === null);
check('non-PBR materials are left alone', sceneryKind(Object.assign(new THREE.MeshBasicMaterial(), { name: 'Tree_Canopy' })) === null);

console.log('Patching');
{
  // As scene-builder hands it over after the rough-diffuse conversion: a physical material with both defines
  const paint = Object.assign(new THREE.MeshPhysicalMaterial(), { name: 'Paint_White' });
  paint.defines = { STANDARD: '', PHYSICAL: '' };
  check('the first call patches', applySceneryDetail(paint, { baseY: 3 }) === true);
  check('a second call does nothing', applySceneryDetail(paint) === false);
  check('defines merged, not replaced', 'STANDARD' in paint.defines! && 'PHYSICAL' in paint.defines! && 'SCENERY_PAINT' in paint.defines!);
  check('one program key for every scenery material', paint.customProgramCacheKey() === 'scenery-detail-v1');
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  paint.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
  check('every patch applied', shader.fragmentShader.includes('scnDetail') && shader.fragmentShader.includes('vSceneryAo') && shader.vertexShader.includes('vSceneryWorldNormal'));
  check('uniforms wired, including the shared wet state', ['uSceneryDetail', 'uSceneryTime', 'uSceneryBaseY', 'uWetness', 'uRainIntensity', 'uWetTime'].every((u) => u in shader.uniforms));
  check('per-material foot height', shader.uniforms.uSceneryBaseY.value === 3);
  setSceneryQuality('low');
  check('Low quality switches the noise off', shader.uniforms.uSceneryDetail.value === 0);
  setSceneryQuality('high');
  check('High switches it back on', shader.uniforms.uSceneryDetail.value === 1);

  const canopy = named('Tree_Canopy');
  applySceneryDetail(canopy, { treeShading: false });
  check('no baked tree shading: no occlusion attribute expected, no vertex colours', !('SCENERY_AO' in canopy.defines!) && !canopy.vertexColors);
  const trunk = named('Tree_Trunk');
  applySceneryDetail(trunk, { treeShading: true });
  check('baked tree shading: occlusion and vertex colours on', 'SCENERY_AO' in trunk.defines! && trunk.vertexColors);
}

console.log('Tree bake on the Rwanda GLB');
{
  const root = loadGlbGeometry('public/tracks/rwanda/rwanda_2026.glb');
  const trees = root.getObjectByName('Env_Trees');
  check('Env_Trees is in the GLB', !!trees);
  const parts: THREE.Mesh[] = [];
  trees!.traverse((o) => {
    if (o instanceof THREE.Mesh) parts.push(o);
  });
  for (const name of ['Tree_Trunk', 'Tree_Canopy']) {
    const mesh = parts.find((m) => m.userData.materialName === name);
    check(`${name} primitive found`, !!mesh);
    const g = mesh!.geometry;
    const before = g.getAttribute('position').count;
    const part = name === 'Tree_Trunk' ? 'trunk' : 'canopy';
    check(`${name}: baked`, prepareTreeGeometry(g, part));
    const n = g.getAttribute('normal');
    const c = g.getAttribute('color');
    const ao = g.getAttribute('sceneryAo');
    check(`${name}: one piece per tree`, g.userData.sceneryTrees === 520, `${g.userData.sceneryTrees} trees`);
    check(`${name}: vertex count unchanged`, g.getAttribute('position').count === before && n.count === before && c.count === before && ao.count === before);
    let unit = 0;
    let tintLo = Infinity;
    let tintHi = -Infinity;
    let aoLo = Infinity;
    let aoHi = -Infinity;
    for (let i = 0; i < before; i++) {
      if (Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-4) unit++;
      tintLo = Math.min(tintLo, c.getX(i), c.getY(i), c.getZ(i));
      tintHi = Math.max(tintHi, c.getX(i), c.getY(i), c.getZ(i));
      aoLo = Math.min(aoLo, ao.getX(i));
      aoHi = Math.max(aoHi, ao.getX(i));
    }
    check(`${name}: unit normals`, unit === before, `${unit}/${before}`);
    // ±12 % brightness times up to ±9 % hue drift: 0.80–1.22
    check(`${name}: tint is a variation, not a recolour`, tintLo > 0.78 && tintHi < 1.24, `${tintLo.toFixed(2)}–${tintHi.toFixed(2)}`);
    check(`${name}: occlusion darker at the foot, never black`, aoLo >= 0.44 && aoHi <= 1 && aoHi - aoLo > 0.3, `${aoLo.toFixed(2)}–${aoHi.toFixed(2)}`);
    // Normals point away from the middle of their tree: out of the crown, or radially out of the trunk
    const p = g.getAttribute('position');
    const centre = new THREE.Vector3();
    const per = part === 'trunk' ? 12 : 36;
    let outward = 0;
    for (let t = 0; t < before / per; t++) {
      centre.set(0, 0, 0);
      for (let k = 0; k < per; k++) centre.add(new THREE.Vector3(p.getX(t * per + k), p.getY(t * per + k), p.getZ(t * per + k)));
      centre.divideScalar(per);
      for (let k = 0; k < per; k++) {
        const i = t * per + k;
        const dx = p.getX(i) - centre.x;
        const dz = p.getZ(i) - centre.z;
        const dy = part === 'trunk' ? 0 : p.getY(i) - centre.y;
        if (dx * n.getX(i) + dy * n.getY(i) + dz * n.getZ(i) > 0) outward++;
      }
    }
    check(`${name}: normals face out of their tree`, outward / before > 0.97, `${((outward / before) * 100).toFixed(1)} %`);
  }
  check('a non-tree mesh is refused', !prepareTreeGeometry(new THREE.PlaneGeometry(10, 10, 1, 1), 'canopy'));
}

console.log(`\nAll ${passed} scenery checks passed.`);
