/**
 * Scenery detail (src/lib/render/scenery-detail.ts): the shader patches land on three's current shader source, the
 * right materials are patched (and nothing else) and the rough-diffuse conversion's defines survive; then RISE
 * Motordrome's instanced trees (levels of detail, leaf cards) and how the game draws them.
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { SCENERY_CREDITS, type SceneryCredit } from '../src/lib/render/scenery-credits';
import { attachSceneryInstances, resetSceneryInstances, setSceneryDensity } from '../src/lib/render/scenery-instances';
import { SHADOW_PROXY_LAYER } from '../src/lib/render/layers';

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

console.log('Tree bake');
check('a non-tree mesh is refused', !prepareTreeGeometry(new THREE.PlaneGeometry(10, 10, 1, 1), 'canopy'));

console.log('Instanced foliage (public/tracks/rwanda_official/scenery/foliage.glb)');
void (async () => {
  const FOLIAGE = 'public/tracks/rwanda_official/scenery/foliage.glb';
  check('foliage GLB is there', existsSync(FOLIAGE));
  const bytes = statSync(FOLIAGE).size;
  check('foliage GLB stays small', bytes < 3e6, `${(bytes / 1e6).toFixed(2)} MB`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(FOLIAGE);
  const rootNode = doc.getRoot().listScenes()[0]?.listChildren()[0];
  const extras = (rootNode?.getExtras() ?? {}) as { replaces?: string[]; credits?: SceneryCredit[]; counts?: Record<string, number> };
  check('it hides nothing of the circuit', JSON.stringify(extras.replaces) === '[]');
  const ownCredits = (credits: SceneryCredit[] | undefined) => JSON.stringify(credits) === JSON.stringify(SCENERY_CREDITS.filter((c) => credits?.some((x) => x.id === c.id)));
  check('its credits match the in-app credits', ownCredits(extras.credits) && (extras.credits?.length ?? 0) === 2);
  const creditsMd = readFileSync('CREDITS.md', 'utf8');
  check('CREDITS.md names every model and its source', SCENERY_CREDITS.every((c) => creditsMd.includes(c.url) && creditsMd.includes(c.author)));
  check('every model is openly licensed (CC0 or CC BY)', SCENERY_CREDITS.every((c) => /^CC (0|BY 4\.0)$/.test(c.license)));

  // Instances: count them per model and collect their base points (each tile's level 0; the other levels share them)
  const perModel: Record<string, number> = {};
  let tiles = 0;
  type LevelExtras = { tile?: string; level?: number; from?: number; until?: number; shadow?: boolean; shadowFrom?: number };
  const tileLevels = new Map<string, { level: number; extras: LevelExtras; mesh: string; translation: unknown }[]>();
  for (const node of doc.getRoot().listNodes()) {
    const inst = node.getExtension('EXT_mesh_gpu_instancing') as { getAttribute(n: string): { getCount(): number; getElement(i: number, out: number[]): number[] } | null } | null;
    if (!inst) continue;
    const ex = node.getExtras() as LevelExtras;
    if (typeof ex.tile === 'string') {
      if (!tileLevels.has(ex.tile)) tileLevels.set(ex.tile, []);
      tileLevels.get(ex.tile)!.push({ level: ex.level ?? -1, extras: ex, mesh: node.getMesh()!.getName(), translation: inst.getAttribute('TRANSLATION') });
    }
    if ((ex.level ?? 0) > 0) continue;
    tiles++;
    const t = inst.getAttribute('TRANSLATION')!;
    const model = node.getMesh()!.getName();
    perModel[model] = (perModel[model] ?? 0) + t.getCount();
  }
  check('instances split into tiles (so they cull)', tiles > 20, `${tiles} tiles`);
  check('instance counts match the file\'s own record', perModel.Acacia === extras.counts?.acacia && perModel.Shrub === extras.counts?.shrub, JSON.stringify(perModel));
  // Levels of detail: every tile has its lighter levels, sharing its instances; each lighter, with the same leaf area
  const levelsOk = [...tileLevels.entries()].every(([tile, list]) => {
    const want = tile.startsWith('acacia') ? [0, 1, 2, 3] : [0, 1];
    const got = list.map((l) => l.level).sort();
    // The acacias' furthest level stands in for 60 % of a tile's trees with its own, slightly larger instances
    const shared = list.filter((l) => l.level < 3);
    return JSON.stringify(got) === JSON.stringify(want) && shared.every((l) => l.translation === shared[0].translation);
  });
  check('every tile has its levels of detail, the nearer ones sharing its instances', tileLevels.size === tiles && levelsOk, `${tileLevels.size} tiles`);
  const countOf = (l: { translation: unknown }) => (l.translation as { getCount(): number }).getCount();
  const farShare = [...tileLevels.entries()]
    .filter(([tile]) => tile.startsWith('acacia'))
    .map(([, list]) => countOf(list.find((l) => l.level === 3)!) / countOf(list.find((l) => l.level === 0)!));
  check('the furthest acacia level draws about 60 % of a tile\'s trees, never none', farShare.every((r) => r > 0 && r <= 1) && Math.abs(farShare.reduce((x, y) => x + y, 0) / farShare.length - 0.6) < 0.08, `mean ${(farShare.reduce((x, y) => x + y, 0) / farShare.length).toFixed(2)}`);
  const byMesh = Object.fromEntries(doc.getRoot().listMeshes().map((m) => [m.getName(), m]));
  const tris = (name: string) => byMesh[name].listPrimitives().reduce((sum, p) => sum + p.getIndices()!.getCount() / 3, 0);
  const leafArea = (name: string) => {
    let area = 0;
    for (const p of byMesh[name].listPrimitives()) {
      if (p.getMaterial()?.getAlphaMode() !== 'MASK') continue;
      const pos = p.getAttribute('POSITION')!;
      const idx = p.getIndices()!;
      const a = [0, 0, 0];
      const b = [0, 0, 0];
      const c = [0, 0, 0];
      for (let t = 0; t < idx.getCount(); t += 3) {
        pos.getElement(idx.getScalar(t), a);
        pos.getElement(idx.getScalar(t + 1), b);
        pos.getElement(idx.getScalar(t + 2), c);
        const e1 = b.map((x, k) => x - a[k]);
        const e2 = c.map((x, k) => x - a[k]);
        area += 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
      }
    }
    return area;
  };
  check('acacia level 1 is at most 35 % of its triangles, level 2 at most 12 %', tris('Acacia_LOD1') <= 0.35 * tris('Acacia') && tris('Acacia_LOD2') <= 0.12 * tris('Acacia'), `${tris('Acacia')} / ${tris('Acacia_LOD1')} / ${tris('Acacia_LOD2')}`);
  check('shrub level 1 is at most 41 % of its triangles', tris('Shrub_LOD1') <= 0.41 * tris('Shrub'), `${tris('Shrub')} / ${tris('Shrub_LOD1')}`);
  const areaRatio = ['Acacia_LOD1', 'Acacia_LOD2', 'Shrub_LOD1'].map((m) => leafArea(m) / leafArea(m.replace(/_LOD\d$/, '')));
  check('the lighter levels keep the crowns\' leaf area (±25 %)', areaRatio.every((r) => r > 0.75 && r < 1.25), areaRatio.map((r) => r.toFixed(2)).join(', '));
  // Each lighter level takes over further out; the shrubs stop being drawn at all
  const ascending = [...tileLevels.values()].every((list) => {
    const from = [...list].sort((a, b) => a.level - b.level).map((l) => l.extras.from ?? NaN);
    return from[0] === 0 && from.every((f, i) => i === 0 || f > from[i - 1]);
  });
  check('each lighter level takes over further out', ascending);
  const shrubEnds = [...tileLevels.entries()].filter(([tile]) => tile.startsWith('shrub')).every(([, list]) => (list.find((l) => l.level === 1)?.extras.until ?? 0) > 0);
  check('shrubs stop being drawn beyond their last level', shrubEnds);

  // Leaf cards: alpha-masked, and their normals baked to face out of the crown (shaded as one volume)
  const leafPrims = doc
    .getRoot()
    .listMeshes()
    .filter((m) => !/_LOD\d$/.test(m.getName()))
    .flatMap((m) => m.listPrimitives())
    .filter((p) => p.getMaterial()?.getAlphaMode() === 'MASK');
  check('both models have alpha-masked leaves', leafPrims.length === 2, `${leafPrims.length}`);
  for (const prim of leafPrims) {
    const pos = prim.getAttribute('POSITION')!;
    const nor = prim.getAttribute('NORMAL')!;
    const lo = pos.getMin([0, 0, 0]);
    const hi = pos.getMax([0, 0, 0]);
    const c = lo.map((l, k) => (l + hi[k]) / 2);
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    let out = 0;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, p);
      nor.getElement(i, n);
      if (n[0] * (p[0] - c[0]) + n[1] * (p[1] - c[1]) + n[2] * (p[2] - c[2]) > 0) out++;
    }
    const share = out / pos.getCount();
    check(`${prim.getMaterial()!.getName()}: leaf normals face out of the crown`, share > 0.97, `${(share * 100).toFixed(1)} %`);
  }

  console.log('Instanced foliage at runtime (scenery-instances.ts)');
  {
    const trackRoot = new THREE.Group();
    const oldTrees = Object.assign(new THREE.Group(), { name: 'Env_Trees' });
    const oldCards = Object.assign(new THREE.Group(), { name: 'Env_Foliage' });
    trackRoot.add(oldTrees, oldCards);
    const leaves = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaTest: 0.45 });
    const bark = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const tile = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), [bark, leaves], 40);
    const scenery = new THREE.Group();
    scenery.userData.replaces = ['Env_Trees', 'Env_Foliage'];
    scenery.add(tile);
    resetSceneryInstances();
    setSceneryDensity('high');
    attachSceneryInstances(trackRoot, scenery);
    check('the replaced circuit nodes are hidden', !oldTrees.visible && !oldCards.visible);
    check('the scenery hangs under the circuit', scenery.parent === trackRoot);
    check('tiles cast and receive shadows, and cull', tile.castShadow && tile.receiveShadow && tile.frustumCulled && tile.boundingSphere !== null);
    setSceneryDensity('low');
    check('Low quality draws half of each tile', tile.count === 20, `${tile.count}`);
    setSceneryDensity('medium');
    check('Medium draws 80 %', tile.count === 32, `${tile.count}`);
    setSceneryDensity('high');
    check('High draws them all', tile.count === 40, `${tile.count}`);

    check('only the alpha-tested leaves get the leaf shader', leaves.userData.leafShading === true && !bark.userData.leafShading);
    // The patch is string replacement on three's chunks: if an upgrade renames one, these fail instead of the leaves
    // silently losing their shading
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    leaves.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    const frag = shader.fragmentShader;
    check('leaf coverage scales alpha by the mip level, before the alpha test', frag.includes('leafMip') && frag.indexOf('leafMip') < frag.indexOf('#include <alphatest_fragment>'));
    check('a card seen from behind keeps its crown normal', !frag.includes('#include <normal_fragment_begin>') && !frag.includes('normal *= faceDirection;') && frag.includes('faceDirection'));
    check('leaf specular is damped after the lighting setup', frag.indexOf('material.specularColorBlended *= 0.2;') > frag.indexOf('#include <lights_physical_fragment>'));
    check('the leaf program has its own cache key', leaves.customProgramCacheKey() === 'scenery-leaf-v3');

    // A tile with levels of detail: grouped under a LOD at the tile's centre, nothing moved
    const lodTrack = new THREE.Group();
    const lodScenery = new THREE.Group();
    const near = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), leaves, 10);
    const far = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), leaves, 10);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 10; i++) {
      m4.makeTranslation(500 + i * 10, 30, -200);
      near.setMatrixAt(i, m4);
      far.setMatrixAt(i, m4);
    }
    near.userData = { tile: 'acacia:2:-1', level: 0, from: 0, shadow: true };
    far.userData = { tile: 'acacia:2:-1', level: 1, from: 80, shadow: false, shadowFrom: 2 };
    const furthest = new THREE.Group();
    const furthestLeaves = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), leaves, 10);
    furthestLeaves.instanceMatrix.copy(near.instanceMatrix);
    furthest.add(furthestLeaves);
    furthest.userData = { tile: 'acacia:2:-1', level: 2, from: 520, shadow: false };
    lodScenery.add(near, far, furthest);
    resetSceneryInstances();
    attachSceneryInstances(lodTrack, lodScenery);
    const lodObj = lodScenery.getObjectByName('Scenery_Tile_acacia:2:-1') as THREE.LOD | undefined;
    check('a tile\'s levels go under one LOD', !!lodObj?.isLOD && near.parent === lodObj && far.parent === lodObj && lodObj.levels.map((l) => l.distance).join() === '0,80,520');
    lodTrack.updateMatrixWorld(true);
    const firstTree = new THREE.Vector3();
    near.getMatrixAt(0, m4);
    firstTree.setFromMatrixPosition(m4.premultiply(near.matrixWorld));
    check('nothing moves when the levels are regrouped', firstTree.distanceTo(new THREE.Vector3(500, 30, -200)) < 1e-3, firstTree.toArray().map((v) => v.toFixed(2)).join(','));
    check('only the levels marked so cast shadows', near.castShadow && !far.castShadow && !furthestLeaves.castShadow);
    const proxy = far.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh | undefined;
    check('the middle level casts through a shadow-only copy of level 2', !!proxy && proxy.castShadow && proxy.geometry === furthestLeaves.geometry && proxy.instanceMatrix === furthestLeaves.instanceMatrix);
    check('which only the sun\'s shadow camera draws', !!proxy && proxy.layers.mask === 1 << SHADOW_PROXY_LAYER && !proxy.layers.test(new THREE.Camera().layers));
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(545, 32, -190);
    cam.updateMatrixWorld();
    lodObj!.update(cam);
    const nearPick = near.visible && !far.visible;
    cam.position.set(545, 32, -500);
    cam.updateMatrixWorld();
    lodObj!.update(cam);
    const midPick = !near.visible && far.visible && !furthest.visible;
    cam.position.set(545, 32, -800);
    cam.updateMatrixWorld();
    lodObj!.update(cam);
    check('close to the tile\'s trees the full ones draw, 300 m out level 1, 600 m out level 2', nearPick && midPick && !near.visible && !far.visible && furthest.visible);
    // Distance is to the trees, not the tile's centre: 50 m off its far end still draws them in full
    cam.position.set(640, 32, -200);
    cam.updateMatrixWorld();
    lodObj!.update(cam);
    check('the level is picked by distance to the nearest tree, not the tile centre', near.visible && !far.visible);
    setSceneryDensity('low');
    check('density reaches every level and the shadow copy', near.count === 5 && far.count === 5 && proxy?.count === 5, `${near.count}, ${far.count}, ${proxy?.count}`);
    setSceneryDensity('high');

    // A generated stand: plain meshes; each gets its own patched copy of a flat scenery material, at its own foot
    const concrete = Object.assign(new THREE.MeshStandardMaterial(), { name: 'Building_White' });
    const seats = Object.assign(new THREE.MeshStandardMaterial({ map: new THREE.Texture() }), { name: 'Stand_Seat_Blue' });
    const standA = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), concrete);
    const standB = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), concrete);
    const seatRow = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), seats);
    standA.position.y = 21;
    standB.position.y = 91;
    const standsRoot = new THREE.Group();
    standsRoot.userData.replaces = ['Prop_Stands_Open'];
    standsRoot.add(standA, standB, seatRow);
    const oldStands = Object.assign(new THREE.Group(), { name: 'Prop_Stands_Open' });
    trackRoot.add(oldStands);
    attachSceneryInstances(trackRoot, standsRoot);
    const matA = standA.material as THREE.MeshStandardMaterial;
    const matB = standB.material as THREE.MeshStandardMaterial;
    check('a stand file hides what it replaces too', !oldStands.visible);
    check('stands cast and receive shadows', standA.castShadow && standA.receiveShadow && seatRow.castShadow);
    check('each stand gets its own copy of the concrete, the original untouched', matA !== concrete && matB !== concrete && matA !== matB && concrete.customProgramCacheKey() !== 'scenery-detail-v1');
    check('the copies get the scenery detail', matA.customProgramCacheKey() === 'scenery-detail-v1' && matB.customProgramCacheKey() === 'scenery-detail-v1');
    const footOf = (mat: THREE.MeshStandardMaterial) => {
      const sh = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
      mat.onBeforeCompile(sh, undefined as unknown as THREE.WebGLRenderer);
      return sh.uniforms.uSceneryBaseY.value as number;
    };
    check('each at its own foot height', footOf(matA) === 20 && footOf(matB) === 90, `${footOf(matA)}, ${footOf(matB)}`);
    check('textured seats are left as they are', seatRow.material === seats);
    resetSceneryInstances();
  }

  console.log(`\nAll ${passed} scenery checks passed.`);
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
