/**
 * Track shadow-caster filtering (src/lib/scene-builder.ts, src/lib/track-data.ts):
 * - All 7 VIR layouts share the declarative shadow-exclusion metadata (`ARMCO GREEN`, `TYRE01`, `WORKERS`,
 *   `MARSHALLS`, `3DCROWD`, fence/paddock posts, campers/parked cars, and terrain/road layers spanning hills).
 * - Tall buildings, grandstands, bridges, gantries, and trees on `Track_Model` keep casting shadows.
 * - Custom `mesh.noShadowMeshes` / `mesh.noShadowMaterials` in `track_data.json` merge cleanly, and original glTF
 *   names (`userData.name`) are matched even after duplicate renaming (`_1`).
 * - Non-VIR circuits (`rwanda_official`, `okayama`, `monaco`) are unaffected.
 * - When hosted VIR GLBs exist in `public/tracks/`, checks real triangle counts across all 7 VIR layouts.
 *
 *   npx tsx scripts/verify-shadow-casters.ts
 */
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { castShadowExtra, isShadowExcluded, SHADOW_RECEIVE_ONLY, shouldMeshCastShadow } from "../src/lib/scene-builder";
import {
  DEFAULT_TRACK_JSON,
  getActiveTrackData,
  setActiveTrack,
  trackNoShadowMaterials,
  type RawTrackJson,
} from "../src/lib/track-data";
import { fitVisualRoad, inheritedTag } from "../src/lib/render/fit-visual-road";
import { trackColliders } from "../src/lib/sim/track-colliders";
import { loadGlbGeometry, loadTrackGeometry, trackModelFiles } from "./lib/glb-geometry";
import { hasFile, noteSkip } from "./lib/hosted-files";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!cond) failed++;
}

const VIR_LAYOUTS = [
  "vir",
  "vir_grand_east",
  "vir_grand_west",
  "vir_north",
  "vir_patriot",
  "vir_patriot_reverse",
  "vir_south",
] as const;

// 1. Declarative exclusion metadata across all 7 VIR layouts + JSON merge
{
  for (const id of VIR_LAYOUTS) {
    setActiveTrack(id, DEFAULT_TRACK_JSON);
    const data = getActiveTrackData(200);
    const mats = new Set(data.noShadowMaterials ?? []);
    check(
      `${id} includes heavy VIR non-building exclusions`,
      mats.has("ARMCO GREEN") &&
        mats.has("TYRE01") &&
        mats.has("WORKERS") &&
        mats.has("MARSHALLS") &&
        mats.has("3DCROWD") &&
        mats.has("TERRAIN") &&
        !mats.has("woodstand") &&
        !mats.has("TREE01") &&
        !mats.has("BRIDGE NISSAN") &&
        !mats.has("PIT-WALL"),
      `${mats.size} excluded materials`
    );
  }

  // Custom metadata.mesh.noShadowMeshes & noShadowMaterials merge cleanly
  const customRaw = structuredClone(DEFAULT_TRACK_JSON) as RawTrackJson & {
    metadata: { mesh?: { noShadowMeshes?: string[]; noShadowMaterials?: string[] } };
  };
  customRaw.metadata.mesh = {
    ...customRaw.metadata.mesh,
    noShadowMeshes: ["Custom_Gantry_Mesh"],
    noShadowMaterials: ["Custom_Fence_Mat"],
  };
  setActiveTrack("vir_south", customRaw);
  const merged = getActiveTrackData(200);
  check(
    "JSON metadata.mesh.noShadowMeshes & noShadowMaterials merge with venue exclusions",
    (merged.noShadowMeshes ?? []).includes("Custom_Gantry_Mesh") &&
      (merged.noShadowMaterials ?? []).includes("Custom_Fence_Mat") &&
      (merged.noShadowMaterials ?? []).includes("ARMCO GREEN")
  );

  // Non-VIR circuits keep empty defaults
  setActiveTrack("rwanda_official_short", DEFAULT_TRACK_JSON);
  const rwanda = getActiveTrackData(200);
  check(
    "non-VIR default circuit has no shadow exclusions",
    (rwanda.noShadowMaterials?.length ?? 0) === 0 && (rwanda.noShadowMeshes?.length ?? 0) === 0
  );
  check(
    "trackNoShadowMaterials returns [] for unconfigured circuits",
    trackNoShadowMaterials("okayama").length === 0 && trackNoShadowMaterials("monaco").length === 0
  );
}

// 2. Synthetic Track_Model rule verification using production shouldMeshCastShadow
{
  const root = new THREE.Group();
  const trackModel = Object.assign(new THREE.Group(), { name: "Track_Model" });
  const propBuilding = Object.assign(new THREE.Group(), { name: "Prop_PitBuilding" });
  const roadNode = Object.assign(new THREE.Group(), { name: "Track_Asphalt_Road" });
  root.add(trackModel, propBuilding, roadNode);

  const makeMesh = (name: string, matName: string, extra?: Record<string, unknown>) => {
    const mat = new THREE.MeshStandardMaterial();
    mat.name = matName;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 10, 2), mat);
    mesh.name = name;
    if (extra) Object.assign(mesh.userData, extra);
    return mesh;
  };

  const virExcluded = [
    makeMesh("ARMCO GREEN_chunk2", "ARMCO GREEN"),
    makeMesh("TYRE01_chunk3", "TYRE01"),
    makeMesh("WORKERS_chunk0", "WORKERS"),
    makeMesh("MARSHALLS_chunk0", "MARSHALLS"),
    makeMesh("3DCROWD_chunk0", "3DCROWD"),
    makeMesh("05 - Default_chunk0", "05 - Default"),
    makeMesh("PARKED CARS_chunk0", "PARKED CARS"),
    makeMesh("METALPOST02_chunk0", "METALPOST02"),
    makeMesh("FENCE POST1_chunk0", "FENCE POST1"),
    makeMesh("TERRAIN_chunk0", "TERRAIN"),
  ];
  const virKept = [
    makeMesh("woodstand_chunk0", "woodstand"),
    makeMesh("GAZEEBO_chunk0", "GAZEEBO"),
    makeMesh("WATER TOWER_chunk0", "WATER TOWER"),
    makeMesh("GRANDSTANDFRAME_chunk0", "GRANDSTANDFRAME"),
    makeMesh("PORTACABIN_chunk0", "PORTACABIN"),
    makeMesh("lowresbuildings_chunk0", "lowresbuildings"),
    makeMesh("BRIDGE NISSAN_chunk0", "BRIDGE NISSAN"),
    makeMesh("BRIDGE VIR_chunk0", "BRIDGE VIR"),
    makeMesh("TUDOR LOGOS 1_chunk0", "TUDOR LOGOS 1"),
    makeMesh("TREE01_chunk0", "TREE01"),
    makeMesh("WILLOWOAK3_chunk0", "WILLOWOAK3"),
  ];
  const namedExcludedDup = makeMesh("SomeBridge_1", "BRIDGE NISSAN", { name: "SomeBridge" });
  const onGroundRoad = makeMesh("ROAD_ground", "woodstand", { onGround: true });
  const decalMesh = makeMesh("SKID_decal", "woodstand", { decal: true });
  trackModel.add(...virExcluded, ...virKept, namedExcludedDup, onGroundRoad, decalMesh);

  const propMesh = makeMesh("PitBuilding_0", "Building_White");
  propBuilding.add(propMesh);
  const roadMesh = makeMesh("Road_0", "Track_Asphalt");
  roadNode.add(roadMesh);

  const noShadowMeshes = new Set(["SomeBridge"]);
  const noShadowMaterials = new Set(trackNoShadowMaterials("vir"));

  const evalCast = (m: THREE.Mesh, topName: string, receiveOnly = false, sizeY = 10) =>
    shouldMeshCastShadow({
      obj: m,
      root,
      topName,
      isDecal: Boolean(m.userData?.decal),
      receiveOnly,
      sizeY,
      castExtra: undefined,
      noShadowMeshes,
      noShadowMaterials,
    });

  check(
    "VIR excluded meshes (ARMCO GREEN, TYRE01, WORKERS, MARSHALLS, 3DCROWD, posts, terrain) have castShadow=false",
    virExcluded.every((m) => !evalCast(m, "Track_Model"))
  );
  check(
    "VIR buildings, grandstands, bridges, gantries, and trees keep castShadow=true",
    virKept.every((m) => evalCast(m, "Track_Model"))
  );
  check(
    "noShadowMeshes matches original userData.name even after duplicate _1 renaming",
    isShadowExcluded(namedExcludedDup, root, noShadowMeshes, noShadowMaterials) && !evalCast(namedExcludedDup, "Track_Model")
  );
  check(
    "onGround and decal meshes remain castShadow=false",
    !evalCast(onGroundRoad, "Track_Model") && !evalCast(decalMesh, "Track_Model")
  );
  check(
    "Prop_* casts shadows while SHADOW_RECEIVE_ONLY does not",
    evalCast(propMesh, "Prop_PitBuilding", false) && !evalCast(roadMesh, "Track_Asphalt_Road", true)
  );
}

// 3. Repository circuit (rwanda_official.glb) regression check
if (hasFile("public/tracks/rwanda_official/rwanda_official.glb")) {
  const root = loadGlbGeometry("public/tracks/rwanda_official/rwanda_official.glb");
  root.updateMatrixWorld(true);
  let casters = 0;
  let tris = 0;
  root.traverse((obj) => {
    let node: THREE.Object3D | null = obj;
    let topName = obj.name;
    let isCollider = false;
    let isDecal = false;
    while (node && node !== root) {
      if (node.userData?.collider || node.userData?.hidden) isCollider = true;
      if (node.userData?.decal) isDecal = true;
      topName = node.name;
      node = node.parent;
    }
    if (isCollider || !(obj instanceof THREE.Mesh) || topName === "Track_Kerbs_Visual") return;
    const cast = shouldMeshCastShadow({
      obj,
      root,
      topName,
      isDecal,
      receiveOnly: SHADOW_RECEIVE_ONLY.has(topName) || isDecal,
      sizeY: 0,
      castExtra: castShadowExtra(obj, root),
    });
    if (cast) {
      casters++;
      const g = obj.geometry;
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  });
  check("rwanda_official keeps its shadow casters intact", casters > 50 && tris > 100_000, `${casters} meshes, ${tris.toLocaleString()} tris`);
}

// 4. Hosted VIR GLBs (if present in public/tracks/)
for (const id of VIR_LAYOUTS) {
  const td = `public/tracks/${id}/track_data.json`;
  const glb = `public/tracks/${id}/${id}.glb`;
  if (!hasFile(td) || !hasFile(glb)) {
    if (id === "vir") noteSkip("VIR real GLB shadow reduction", `${td} / ${glb}`);
    continue;
  }
  const raw = JSON.parse(readFileSync(td, "utf8")) as RawTrackJson;
  setActiveTrack(id, raw);
  const track = getActiveTrackData(200);
  const files = trackModelFiles(track);
  const root = loadTrackGeometry(track);
  root.updateMatrixWorld(true);
  const colliders = trackColliders(root);
  if (colliders.conformSurfaces && colliders.ground) fitVisualRoad(root, colliders.ground, track.roadMaterials ?? []);

  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const noShadowMeshes = new Set(track.noShadowMeshes ?? []);
  const noShadowMaterials = new Set(track.noShadowMaterials ?? []);

  let beforeTris = 0;
  let afterTris = 0;
  let keptBuildingsAndTrees = true;
  root.traverse((obj) => {
    let node: THREE.Object3D | null = obj;
    let topName = obj.name;
    let isCollider = false;
    let isDecal = false;
    while (node && node !== root) {
      if (node.userData?.collider || node.userData?.hidden) isCollider = true;
      if (node.userData?.decal) isDecal = true;
      topName = node.name;
      node = node.parent;
    }
    if (isCollider || !(obj instanceof THREE.Mesh) || topName === "Track_Kerbs_Visual") return;
    const g = obj.geometry;
    const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    let sizeY = 0;
    if (topName === "Track_Model") {
      g.computeBoundingBox();
      box.copy(g.boundingBox!).applyMatrix4(obj.matrixWorld).getSize(size);
      sizeY = size.y;
    }
    const baseCast = shouldMeshCastShadow({
      obj,
      root,
      topName,
      isDecal,
      receiveOnly: isDecal,
      sizeY,
      castExtra: undefined,
    });
    const newCast = shouldMeshCastShadow({
      obj,
      root,
      topName,
      isDecal,
      receiveOnly: isDecal,
      sizeY,
      castExtra: undefined,
      noShadowMeshes,
      noShadowMaterials,
    });
    if (baseCast) beforeTris += tris;
    if (newCast) afterTris += tris;
    const mat = String(obj.userData.materialName ?? "");
    if (["woodstand", "GAZEEBO", "PORTACABIN", "lowresbuildings", "TREE01", "WILLOWOAK3", "BRIDGE NISSAN"].includes(mat) && baseCast && !newCast) {
      keptBuildingsAndTrees = false;
    }
  });
  const cut = beforeTris - afterTris;
  check(
    `${id} (${files.shared ? "split" : "full"}): cuts >1.1M tris/cascade while keeping buildings & trees`,
    cut > 1_100_000 && keptBuildingsAndTrees,
    `${beforeTris.toLocaleString()} -> ${afterTris.toLocaleString()} (-${cut.toLocaleString()}, -${((100 * cut) / beforeTris).toFixed(1)}%)`
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll shadow caster checks passed.");
