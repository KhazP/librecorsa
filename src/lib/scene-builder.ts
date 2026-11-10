import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import { withBasePath } from "@/lib/base-path";
import { aiLineOffsetM, type BrakingGuide } from "@/lib/sim/speed-profile";
import { evaluateDynamicBrakingUrgency } from "@/lib/sim/track-occupancy";
import {
  applyAsphaltSheen,
  createRacingLineMask,
  type RacingLineMask,
} from "@/lib/render/asphalt-sheen";
import type { RacingLineId, RunoffStyle } from "@/types/f1";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { assetProgress } from "@/lib/loading/asset-progress";
import { applySceneryDetail, prepareTreeGeometry, sceneryKind, setSceneryTime } from "@/lib/render/scenery-detail";
import { attachSceneryInstances, loadSceneryInstances, resetSceneryInstances } from "@/lib/render/scenery-instances";
import { cleanScanMaterial } from "@/lib/render/scan-materials";
import { trackColliders } from "@/lib/sim/track-colliders";
import { fitVisualRoad, inheritedTag } from "@/lib/render/fit-visual-road";
import { createGroundHit, type GroundQuery } from "@/lib/sim/f12026-car/TrackColliderQuery";
import { OVERLAY_LAYER } from "@/lib/render/layers";
import { cutSceneryBoxes, isCutMaterialMesh, type SceneryCutBox } from "@/lib/scenery-cuts";
import { freezeStaticTransforms, singlePassTransparency } from "@/lib/render/static-scene";

/** Height of a racing-line dash over the driving surface: clear of its ripple, low enough to read as paint */
const DASH_SEAT_LIFT_M = 0.035;

/** The built scene of the active circuit */
export interface BuiltCircuitScene {
  sceneGroup: THREE.Group;
  racingLineMesh: THREE.Mesh;
  startLightMeshes: THREE.Mesh[];
  updateEnvironment: (elapsedSeconds: number) => void;
  /** Darkens a converted circuit's tyre grooves (AC `groove.ini`) with the racing line's rubber (0..1) */
  setGrooveRubber: (rubber: number) => void;
  /** Recolours the braking line ahead of the car; `guide` = the car's own braking guide (else the circuit's) */
  updateDynamicRacingLine: (carS: number, carSpeedMs: number, guide?: BrakingGuide | null) => void;
  /**
   * Sits the racing-line dashes on the real driving surface (the centreline profile misses the road's crown and
   * camber away from the centre, so off-centre dashes sank into or floated over it)
   */
  seatRacingLine: (ground: GroundQuery) => void;
  /** Start gantry: null = idle (green), 0..5 = number of red lights lit */
  setStartLights: (redCount: number | null) => void;
  /**
   * The authored track root once the GLB is in the scene (Track_Collider_* nodes included, hidden), e.g. for
   * `TrackColliderQuery.fromTrackRoot`. Never settles when the GLB cannot load (headless or fallback track).
   */
  trackRoot: Promise<THREE.Object3D>;
}

// RISE Motordrome: one glTF exported from the Blender build (public/tracks/rwanda_official/rwanda_official.glb).
// Node naming contract: Track_* (racing surfaces, barriers), Track_Collider_* (invisible physics proxies,
// extras.collider = true), Terrain, Lake, Env_* (vegetation, canopies) and Prop_* (buildings, stands, gantry).
// The other circuits (scripts/tracks/build_track.py) wrap a converted scan in `Track_Model` and append hidden
// `Track_Collider_*` / `Track_Surface_*` physics meshes (extras.hidden = true); `track.meshUrl` names the file.
// Older builds also carry `Track_Kerbs_Visual` (the physics kerbs in red / white paint over the scan): hidden, the scan
// shows its own kerbs.

// Flat overlays drawn on top of the asphalt / run-off; pulled towards the camera to avoid z-fighting.
const DECAL_NODES: Record<string, number> = {
  Track_Markings: -2,
  Track_Pit_Markings: -2,
  Track_Runoff_Decals: -2,
  Track_Kerbs: -1,
  Track_Kerbs_Visual: -1,
  Track_Runoff_Paint: -1,
};
/**
 * Diffuse roughness (EON diffuse BRDF, three r187+) for the circuits' concrete by material name. Rough surfaces
 * back-scatter: with the low golden-hour sun behind the camera sunlit concrete reads brighter, and looking into the
 * sun a little darker, where Lambert shading looks the same from every side. Only materials named per surface
 * match (Rwanda's Pit_Apron_Concrete, Motegi's *CONCRETE*); the scanned circuits share one atlas material and keep
 * plain Lambert.
 *
 * The terrain grass stays Lambert on purpose: the rough lobe flattens the shading across slopes, so the ground's
 * relief (the real elevation of the site) read differently from how it was modelled.
 */
const ROUGH_DIFFUSE: readonly (readonly [RegExp, number])[] = [[/concrete/i, 0.5]];
const roughDiffuseConversions = new WeakMap<THREE.Material, THREE.Material>();

/** The material with its rough-diffuse lobe: physical materials in place, standard ones as a shared physical copy */
function withRoughDiffuse(mat: THREE.Material): THREE.Material {
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return mat;
  const amount = ROUGH_DIFFUSE.find(([re]) => re.test(mat.name))?.[1];
  if (amount === undefined) return mat;
  const phys = mat as THREE.MeshPhysicalMaterial;
  if (phys.isMeshPhysicalMaterial) {
    phys.diffuseRoughness = amount;
    return mat;
  }
  let out = roughDiffuseConversions.get(mat);
  if (!out) {
    const copy = new THREE.MeshPhysicalMaterial();
    THREE.MeshStandardMaterial.prototype.copy.call(copy, std);
    // MeshStandardMaterial.copy() resets the defines to STANDARD only
    copy.defines = { STANDARD: "", PHYSICAL: "" };
    copy.diffuseRoughness = amount;
    roughDiffuseConversions.set(mat, copy);
    out = copy;
  }
  return out;
}

const SHADOW_RECEIVE_ONLY = new Set([
  "Terrain",
  "Lake",
  "Track_Asphalt_Road",
  "Track_Pitlane",
  "Track_Runoff_Paint",
  "Track_Markings",
  "Track_Pit_Markings",
  "Track_Runoff_Decals",
  "Track_Kerbs",
  "Track_Kerbs_Visual",
]);

const COLLIDER_DEBUG_COLOURS: Record<string, number> = {
  Track_Surface_Road: 0x3b82f6,
  Track_Surface_Kerb: 0xef4444,
  Track_Surface_Runoff: 0xfacc15,
  Track_Surface_Gravel: 0xf97316,
  Track_Surface_Grass: 0x22c55e,
  Track_Collider_Wall_Left: 0xd946ef,
  Track_Collider_Wall_Right: 0xd946ef,
};
const colliderDebugMaterials = new Map<string, THREE.MeshBasicMaterial>();

/** Translucent flat colour for a physics node in the `?colliders=1` view; null = keep it hidden */
function colliderDebugMaterial(name: string): THREE.MeshBasicMaterial | null {
  const colour = COLLIDER_DEBUG_COLOURS[name];
  if (colour === undefined) return null;
  let mat = colliderDebugMaterials.get(name);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: name.startsWith("Track_Collider_Wall") ? 0.55 : 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    colliderDebugMaterials.set(name, mat);
  }
  return mat;
}

/** Bumped by every loadTrackGlb call; only the latest call's result is used */
let trackLoadGen = 0;
class SupersededLoad extends Error {}

function loadTrackGlb(
  /** The circuit GLB; none on a synthetic test track, which keeps the procedural stand-in */
  url: string | undefined,
  glbGroup: THREE.Group,
  fallbackGroup: THREE.Group,
  onLoaded: (root: THREE.Object3D) => void,
  sheenMask: RacingLineMask,
  /** Scenery files that replace some of the circuit's own (scenery-instances.ts); loaded alongside */
  sceneryUrls: readonly string[] = [],
  /** The scan's racing-surface materials (track data `mesh.roadMaterials`): drawn with the asphalt shader */
  roadMaterials: readonly string[] = [],
  /** World boxes of the scan to leave out (track data `mesh.cutBoxes`) */
  cutBoxes: readonly SceneryCutBox[] = [],
  /** Scan materials whose meshes are left out (track data `mesh.cutMaterials`) */
  cutMaterials: readonly string[] = []
): void {
  const cutMaterialNames = new Set(cutMaterials);
  const roadMaterialNames = new Set(roadMaterials);
  if (!url || typeof window === "undefined" || typeof fetch === "undefined") {
    return;
  }
  // A newer circuit load (the simulator remounted on another track) supersedes this one: its late result must not
  // mark the new track's progress done or register its scenery instances
  const gen = ++trackLoadGen;
  const current = () => gen === trackLoadGen;
  resetSceneryInstances();
  const sceneryLoad = Promise.all(sceneryUrls.map(loadSceneryInstances));

  // `?colliders=1`: draw the physics surfaces (by type) and barriers over the scan, to check them against it
  const showColliders = new URLSearchParams(window.location.search).get("colliders") === "1";
  /** Each source material's decal clones, by polygon offset and decal flag: meshes that share a material share them */
  const decalClones = new WeakMap<THREE.Material, Map<string, THREE.Material>>();
  assetProgress.begin("track");
  // Circuit scans are meshopt-compressed (scripts/compress-track-glb.mjs)
  new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    // A superseded download keeps running: its bytes must not move the newer load's progress bar
    .loadAsync(withBasePath(url), (event) => {
      if (current()) assetProgress.progress("track", event);
    })
    .then((gltf) => {
      const root = gltf.scene;
      root.name = "CircuitTrack";
      const box = new THREE.Box3();
      const size = new THREE.Vector3();
      root.updateMatrixWorld(true);
      const colliders = trackColliders(root);
      if (colliders.conformSurfaces && colliders.ground) fitVisualRoad(root, colliders.ground);
      root.traverse((obj) => {
        // Exported node extras land on the node; the mesh child inherits nothing, so walk up.
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
        if (isCollider) {
          const debug = showColliders && obj instanceof THREE.Mesh ? colliderDebugMaterial(topName) : null;
          if (debug) {
            (obj as THREE.Mesh).material = debug;
            obj.renderOrder = 2;
          } else {
            obj.visible = false;
          }
          return;
        }
        if (!(obj instanceof THREE.Mesh)) return;
        if (topName === "Track_Model" && isCutMaterialMesh(obj, cutMaterialNames)) {
          obj.visible = false;
          return;
        }
        if (topName === "Track_Model" && cutBoxes.length) cutSceneryBoxes(obj, cutBoxes);
        // The scans show their own kerbs: the generated red / white overlay older builds drew over them stays hidden
        // (its physics twin, Track_Surface_Kerb, is a collider and unaffected)
        if (topName === "Track_Kerbs_Visual") {
          obj.visible = false;
          return;
        }

        const receiveOnly = SHADOW_RECEIVE_ONLY.has(topName) || isDecal;
        obj.receiveShadow = true;
        if (topName === "Track_Model") {
          // Converted scans have no naming contract: only tall things (stands, buildings, trees, barriers) cast
          obj.geometry.computeBoundingBox();
          box.copy(obj.geometry.boundingBox!).applyMatrix4(obj.matrixWorld).getSize(size);
          obj.castShadow = !isDecal && size.y > 1.2;
        } else {
          obj.castShadow = !receiveOnly && (topName.startsWith("Prop_") || topName.startsWith("Env_") || topName.startsWith("Track_"));
        }

        if (topName === "Track_Model") {
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) cleanScanMaterial(m);
        }
        obj.material = Array.isArray(obj.material) ? obj.material.map(withRoughDiffuse) : withRoughDiffuse(obj.material);
        const offset = DECAL_NODES[topName] ?? (isDecal ? -2 : undefined);
        if (offset !== undefined) {
          const cloneForDecal = (m: THREE.Material): THREE.Material => {
            const key = `${offset}:${isDecal ? 1 : 0}`;
            let clones = decalClones.get(m);
            if (!clones) decalClones.set(m, (clones = new Map()));
            let c = clones.get(key);
            if (!c) clones.set(key, (c = m.clone()));
            return c;
          };
          obj.material = Array.isArray(obj.material) ? obj.material.map(cloneForDecal) : cloneForDecal(obj.material);
        }
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        // Flat, untextured scenery (trees, roofs, spire, lake, paint): shader detail, and the trees'
        // normals, tint and occlusion baked into their geometry (scenery-detail.ts)
        let treeShading = false;
        let baseY = 0;
        if (mats.some((m) => sceneryKind(m) !== null)) {
          if (mats.some((m) => m.name === "Tree_Trunk" || m.name === "Tree_Canopy")) {
            treeShading = prepareTreeGeometry(obj.geometry, mats.some((m) => m.name === "Tree_Trunk") ? "trunk" : "canopy");
          }
          obj.geometry.computeBoundingBox();
          baseY = box.copy(obj.geometry.boundingBox!).applyMatrix4(obj.matrixWorld).min.y;
        }
        for (const mat of mats) {
          singlePassTransparency(mat);
          applySceneryDetail(mat, { baseY, treeShading });
          if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
          if (!isDecal && !mat.transparent && (topName === "Track_Asphalt_Road" || (topName === "Track_Model" && roadMaterialNames.has(mat.name)))) {
            applyAsphaltSheen(mat, sheenMask);
          }
          for (const tex of [mat.map, mat.roughnessMap, mat.metalnessMap, mat.normalMap]) {
            if (tex) tex.anisotropy = 8;
          }
          if (offset !== undefined) {
            mat.polygonOffset = true;
            mat.polygonOffsetFactor = offset;
            mat.polygonOffsetUnits = offset;
            if (isDecal) mat.depthWrite = false;
          }
        }
        if (offset !== undefined) obj.renderOrder = 1;
      });
      return sceneryLoad.then((files) => {
        if (!current()) throw new SupersededLoad();
        // Before onLoaded, so the camera occlusion pass and the shader warm-up see them
        for (const scenery of files) if (scenery) attachSceneryInstances(root, scenery);
        return root;
      });
    })
    .then((root) => {
      if (!current()) return;
      glbGroup.add(root);
      onLoaded(root);
      // The circuit never moves: its transforms are fixed from here (static-scene.ts)
      freezeStaticTransforms(glbGroup);

      // Hide the procedural stand-in geometry once the authored circuit is live
      fallbackGroup.visible = false;
      assetProgress.done("track");
    })
    .catch((err) => {
      if (err instanceof SupersededLoad || !current()) return;
      console.warn("Using fallback procedural track geometry:", err);
      assetProgress.fail("track");
    });
}

function createAsphaltTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#282c37";
    ctx.fillRect(0, 0, 1024, 1024);

    for (let i = 0; i < 36000; i++) {
      const x = Math.random() * 1024;
      const y = Math.random() * 1024;
      const v = 32 + Math.floor(Math.random() * 28);
      ctx.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
      ctx.fillRect(x, y, 2, 2);
    }

    const grad = ctx.createLinearGradient(180, 0, 844, 0);
    grad.addColorStop(0, "rgba(12,14,18,0)");
    grad.addColorStop(0.35, "rgba(12,14,18,0.28)");
    grad.addColorStop(0.5, "rgba(12,14,18,0.42)");
    grad.addColorStop(0.65, "rgba(12,14,18,0.28)");
    grad.addColorStop(1, "rgba(12,14,18,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(180, 0, 664, 1024);

    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(16, 0, 18, 1024);
    ctx.fillRect(990, 0, 18, 1024);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

function createRunoffPatternTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#7a0b3b";
    ctx.fillRect(0, 0, 256, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 10, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(10, 0, 34, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(44, 0, 6, 512);
    ctx.fillStyle = "#5c082c";
    ctx.fillRect(210, 0, 46, 512);

    const b1 = 256;
    ctx.fillStyle = "#00a3e0";
    ctx.fillRect(b1, 0, 256, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b1, 0, 10, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(b1 + 10, 0, 24, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b1 + 34, 0, 6, 512);

    for (let y = 0; y < 512; y += 2) {
      const phase = (y / 512) * Math.PI * 2;
      const w1 = b1 + 108 + Math.sin(phase) * 22;
      const w2 = b1 + 156 + Math.sin(phase + 0.9) * 24;
      const w3 = b1 + 202 + Math.cos(phase * 2) * 18;

      ctx.fillStyle = "#00a3e0";
      ctx.fillRect(b1 + 40, y, w1 - (b1 + 40), 2);
      ctx.fillStyle = "#fad201";
      ctx.fillRect(w1, y, w2 - w1, 2);
      ctx.fillStyle = "#16a34a";
      ctx.fillRect(w2, y, w3 - w2, 2);
      ctx.fillStyle = "#1e3a8a";
      ctx.fillRect(w3, y, b1 + 256 - w3, 2);
    }

    const b2 = 512;
    ctx.fillStyle = "#d6bc94";
    ctx.fillRect(b2, 0, 256, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b2, 0, 10, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(b2 + 10, 0, 22, 512);

    for (let y = 0; y < 512; y += 2) {
      const phase = (y / 512) * Math.PI * 2;
      const w1 = b2 + 78 + Math.sin(phase) * 16;
      const w2 = b2 + 114 + Math.sin(phase + 0.8) * 16;
      const w3 = b2 + 148 + Math.cos(phase * 2) * 14;

      ctx.fillStyle = "#00a3e0";
      ctx.fillRect(b2 + 32, y, w1 - (b2 + 32), 2);
      ctx.fillStyle = "#fad201";
      ctx.fillRect(w1, y, w2 - w1, 2);
      ctx.fillStyle = "#16a34a";
      ctx.fillRect(w2, y, w3 - w2, 2);
      ctx.fillStyle = "#d6bc94";
      ctx.fillRect(w3, y, b2 + 256 - w3, 2);
    }

    const b3 = 768;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b3, 0, 12, 512);
    ctx.fillStyle = "#00a3e0";
    ctx.fillRect(b3 + 12, 0, 96, 512);
    ctx.fillStyle = "#fad201";
    ctx.fillRect(b3 + 108, 0, 68, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(b3 + 176, 0, 80, 512);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

function getRunoffAtlasUVRange(style: RunoffStyle): [number, number] {
  switch (style) {
    case "qatar_maroon":
    case "main_straight":
      return [0.008, 0.242];
    case "visit_rwanda_blue":
    case "rwandair_blue_yellow":
      return [0.258, 0.492];
    case "hills_yellow_green":
    case "bugesera_cyan":
    default:
      return [0.508, 0.742];
  }
}

function pushQuadUpward(
  indices: number[],
  baseVert: number,
  side: number
): void {
  if (side > 0) {
    indices.push(
      baseVert,
      baseVert + 1,
      baseVert + 2,
      baseVert + 1,
      baseVert + 3,
      baseVert + 2
    );
  } else {
    indices.push(
      baseVert,
      baseVert + 2,
      baseVert + 1,
      baseVert + 1,
      baseVert + 2,
      baseVert + 3
    );
  }
}

/** Static braking-line dash colour for a braking-zone level (0 throttle, 0.5 lift, 1 braking) */
function brakingZoneColor(level: number): THREE.Color {
  if (level < 0.28) return new THREE.Color(0.05, 0.92, 0.38); // Full throttle Green
  if (level < 0.62) return new THREE.Color(0.98, 0.76, 0.08); // Lift / Transition Yellow-Amber
  return new THREE.Color(0.98, 0.12, 0.18); // Heavy Braking Zone Red
}

/** Builds the scene of the active circuit: a procedural stand-in at once, the circuit's own model once it loads */
export function buildCircuitScene(
  track: BuiltTrackData
): BuiltCircuitScene {
  const sceneGroup = new THREE.Group();
  // Never moves: its children update their own transforms, but it no longer forces all of theirs every frame
  sceneGroup.matrixAutoUpdate = false;
  const glbGroup = new THREE.Group();
  glbGroup.name = "CircuitGlbGroup";
  sceneGroup.add(glbGroup);

  const fallbackGroup = new THREE.Group();
  fallbackGroup.name = "FallbackProceduralGroup";
  sceneGroup.add(fallbackGroup);


  const samples = track.samples;
  const n = samples.length;

  // ============================================================================
  // 1. FALLBACK ASPHALT TRACK RIBBON MESH (Active before the circuit GLB finishes loading)
  // ============================================================================
  const trackGeom = new THREE.BufferGeometry();
  const trackPositions: number[] = [];
  const trackNormals: number[] = [];
  const trackUVs: number[] = [];
  const trackIndices: number[] = [];

  for (let i = 0; i <= n; i++) {
    const sample = samples[i % n];
    const halfW = sample.width * 0.5;
    const leftPt = sample.position
      .clone()
      .addScaledVector(sample.binormal, -halfW);
    const rightPt = sample.position
      .clone()
      .addScaledVector(sample.binormal, halfW);

    trackPositions.push(leftPt.x, leftPt.y, leftPt.z);
    trackPositions.push(rightPt.x, rightPt.y, rightPt.z);

    trackNormals.push(sample.normal.x, sample.normal.y, sample.normal.z);
    trackNormals.push(sample.normal.x, sample.normal.y, sample.normal.z);

    const vCoord = (i / n) * 180;
    trackUVs.push(0, vCoord);
    trackUVs.push(1, vCoord);

    if (i < n) {
      const base = i * 2;
      trackIndices.push(base, base + 1, base + 2);
      trackIndices.push(base + 1, base + 3, base + 2);
    }
  }

  trackGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(trackPositions, 3)
  );
  trackGeom.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(trackNormals, 3)
  );
  trackGeom.setAttribute("uv", new THREE.Float32BufferAttribute(trackUVs, 2));
  trackGeom.setIndex(trackIndices);

  const asphaltMat = new THREE.MeshStandardMaterial({
    map: createAsphaltTexture(),
    roughness: 0.68,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  // Rubbered-in racing line, shared by the fallback ribbon and the authored Track_Asphalt_Road
  const sheenMask = createRacingLineMask(track);
  applyAsphaltSheen(asphaltMat, sheenMask);

  const trackMesh = new THREE.Mesh(trackGeom, asphaltMat);
  trackMesh.receiveShadow = true;
  fallbackGroup.add(trackMesh);

  // ============================================================================
  // 2. FALLBACK RUNOFF APRONS & KERBS
  // ============================================================================
  const runoffGeom = new THREE.BufferGeometry();
  const runoffPositions: number[] = [];
  const runoffNormals: number[] = [];
  const runoffUVs: number[] = [];
  const runoffIndices: number[] = [];
  let runoffVertCount = 0;

  const kerbGeom = new THREE.BufferGeometry();
  const kerbPositions: number[] = [];
  const kerbNormals: number[] = [];
  const kerbColors: number[] = [];
  const kerbIndices: number[] = [];
  let kerbVertCount = 0;

  const runoffWidth = 12.5;
  const kerbWidth = 1.45;

  for (let i = 0; i < n; i++) {
    const s0 = samples[i];
    const s1 = samples[(i + 1) % n];

    const [uIn, uOut] = getRunoffAtlasUVRange(s0.runoffStyle);

    const v0 = (i / n) * 160;
    const v1 = ((i + 1) / n) * 160;

    for (const side of [-1, 1]) {
      const hw0 = s0.width * 0.5;
      const hw1 = s1.width * 0.5;

      const p0Inner = s0.position
        .clone()
        .addScaledVector(s0.binormal, side * hw0)
        .addScaledVector(s0.normal, -0.01);
      const p0Outer = s0.position
        .clone()
        .addScaledVector(s0.binormal, side * (hw0 + runoffWidth))
        .addScaledVector(s0.normal, -0.04);
      const p1Inner = s1.position
        .clone()
        .addScaledVector(s1.binormal, side * hw1)
        .addScaledVector(s1.normal, -0.01);
      const p1Outer = s1.position
        .clone()
        .addScaledVector(s1.binormal, side * (hw1 + runoffWidth))
        .addScaledVector(s1.normal, -0.04);

      runoffPositions.push(
        p0Inner.x,
        p0Inner.y,
        p0Inner.z,
        p0Outer.x,
        p0Outer.y,
        p0Outer.z,
        p1Inner.x,
        p1Inner.y,
        p1Inner.z,
        p1Outer.x,
        p1Outer.y,
        p1Outer.z
      );

      for (let k = 0; k < 4; k++) {
        runoffNormals.push(s0.normal.x, s0.normal.y, s0.normal.z);
      }

      runoffUVs.push(uIn, v0, uOut, v0, uIn, v1, uOut, v1);
      pushQuadUpward(runoffIndices, runoffVertCount, side);
      runoffVertCount += 4;

      const hasKerb = side === -1 ? s0.kerbLeft : s0.kerbRight;
      if (hasKerb) {
        const mod3 = i % 3;
        const kCol =
          mod3 === 0
            ? new THREE.Color(0x00a3e0)
            : mod3 === 1
              ? new THREE.Color(0xfad201)
              : new THREE.Color(0x16a34a);

        const k0In = s0.position
          .clone()
          .addScaledVector(s0.binormal, side * (hw0 - 0.15))
          .addScaledVector(s0.normal, 0.03);
        const k0Out = s0.position
          .clone()
          .addScaledVector(s0.binormal, side * (hw0 + kerbWidth))
          .addScaledVector(s0.normal, 0.05);
        const k1In = s1.position
          .clone()
          .addScaledVector(s1.binormal, side * (hw1 - 0.15))
          .addScaledVector(s1.normal, 0.03);
        const k1Out = s1.position
          .clone()
          .addScaledVector(s1.binormal, side * (hw1 + kerbWidth))
          .addScaledVector(s1.normal, 0.05);

        kerbPositions.push(
          k0In.x,
          k0In.y,
          k0In.z,
          k0Out.x,
          k0Out.y,
          k0Out.z,
          k1In.x,
          k1In.y,
          k1In.z,
          k1Out.x,
          k1Out.y,
          k1Out.z
        );

        for (let k = 0; k < 4; k++) {
          kerbNormals.push(s0.normal.x, s0.normal.y, s0.normal.z);
          kerbColors.push(kCol.r, kCol.g, kCol.b);
        }

        pushQuadUpward(kerbIndices, kerbVertCount, side);
        kerbVertCount += 4;
      }
    }
  }

  runoffGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(runoffPositions, 3)
  );
  runoffGeom.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(runoffNormals, 3)
  );
  runoffGeom.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(runoffUVs, 2)
  );
  runoffGeom.setIndex(runoffIndices);

  const runoffMesh = new THREE.Mesh(
    runoffGeom,
    new THREE.MeshStandardMaterial({
      map: createRunoffPatternTexture(),
      vertexColors: false,
      roughness: 0.62,
      metalness: 0.04,
    })
  );
  runoffMesh.receiveShadow = true;
  fallbackGroup.add(runoffMesh);

  kerbGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(kerbPositions, 3)
  );
  kerbGeom.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(kerbNormals, 3)
  );
  kerbGeom.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(kerbColors, 3)
  );
  kerbGeom.setIndex(kerbIndices);

  const kerbMesh = new THREE.Mesh(
    kerbGeom,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.45,
    })
  );
  fallbackGroup.add(kerbMesh);

  // ============================================================================
  // 3. DYNAMIC 3D DASHED RACING & BRAKING LINE (Along exact fast_lane.ai coordinates)
  // ============================================================================
  const rlGeom = new THREE.BufferGeometry();
  const rlPositions: number[] = [];
  const rlColors: number[] = [];
  const rlIndices: number[] = [];

  // The driving surface the dashes sit on, once the track's colliders are in
  let dashGround: GroundQuery | null = null;
  const dashHit = createGroundHit();
  // Crisp 3D dashed rectangular marker segments along a car's racing line: the four corners of dash i
  const dashCorners = (i: number, line: RacingLineId): number[] => {
    const s0 = samples[i];
    const s1 = samples[(i + 1) % n];

    // The exact line the AI drives and the speed profile / braking markers are computed on
    const p0Base = s0.position.clone().addScaledVector(s0.binormal, aiLineOffsetM(s0, line));
    const p1Base = s1.position.clone().addScaledVector(s1.binormal, aiLineOffsetM(s1, line));

    const pDashEnd = p0Base.clone().lerp(p1Base, 0.72);
    const nDashEnd = s0.normal.clone().lerp(s1.normal, 0.72).normalize();
    const bDashEnd = s0.binormal.clone().lerp(s1.binormal, 0.72).normalize();

    const halfDashW = 0.44;
    const dashLiftY = 0.048;

    const c0 = p0Base.clone().addScaledVector(s0.normal, dashLiftY);
    const c1 = pDashEnd.clone().addScaledVector(nDashEnd, dashLiftY);

    const l0 = c0.clone().addScaledVector(s0.binormal, -halfDashW);
    const r0 = c0.clone().addScaledVector(s0.binormal, halfDashW);
    const l1 = c1.clone().addScaledVector(bDashEnd, -halfDashW);
    const r1 = c1.clone().addScaledVector(bDashEnd, halfDashW);

    const out = [l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, l1.x, l1.y, l1.z, r1.x, r1.y, r1.z];
    if (dashGround) {
      for (let k = 0; k < 12; k += 3) {
        if (dashGround.query(out[k], out[k + 2], out[k + 1] + 1.5, dashHit)) out[k + 1] = dashHit.height + DASH_SEAT_LIFT_M;
      }
    }
    return out;
  };

  // Drawn on the F1 line until a car with its own line hands its braking guide over
  let rlVertBase = 0;
  for (let i = 0; i < n; i++) {
    rlPositions.push(...dashCorners(i, 'f1'));

    const c = brakingZoneColor(samples[i].brakingZone);
    for (let k = 0; k < 4; k++) {
      rlColors.push(c.r, c.g, c.b);
    }

    rlIndices.push(
      rlVertBase,
      rlVertBase + 1,
      rlVertBase + 2,
      rlVertBase + 1,
      rlVertBase + 3,
      rlVertBase + 2
    );
    rlVertBase += 4;
  }

  const rlColorAttr = new THREE.Float32BufferAttribute(rlColors, 3);
  const rlPositionAttr = new THREE.Float32BufferAttribute(rlPositions, 3);
  rlGeom.setAttribute("position", rlPositionAttr);
  rlGeom.setAttribute("color", rlColorAttr);
  rlGeom.setIndex(rlIndices);

  const racingLineMesh = new THREE.Mesh(
    rlGeom,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    })
  );
  racingLineMesh.renderOrder = 2;
  // A driving aid, not part of the world: only the view camera sees it, not the reflection probe or the mirrors
  racingLineMesh.layers.set(OVERLAY_LAYER);
  sceneGroup.add(racingLineMesh);

  /**
   * Real-time updater for the 3D dashed braking line: dynamically transitions dashes
   * ahead of the player between Green, Yellow, and Red based on the car's live speed
   * vs the physics-derived optimal corner speed profile.
   */
  let lineGuide: BrakingGuide | null = null;
  let drawnLine: RacingLineId = 'f1';
  const seatRacingLine = (ground: GroundQuery) => {
    dashGround = ground;
    for (let i = 0; i < n; i++) rlPositionAttr.array.set(dashCorners(i, drawnLine), i * 12);
    rlPositionAttr.needsUpdate = true;
    rlGeom.computeBoundingSphere();
  };
  const updateDynamicRacingLine = (carS: number, carSpeedMs: number, guide: BrakingGuide | null = null) => {
    // Another car's guidance: repaint the static braking zones from it, on its own racing line
    if (guide !== lineGuide) {
      lineGuide = guide;
      const line = guide?.line ?? 'f1';
      if (line !== drawnLine) {
        drawnLine = line;
        for (let i = 0; i < n; i++) rlPositionAttr.array.set(dashCorners(i, line), i * 12);
        rlPositionAttr.needsUpdate = true;
        rlGeom.computeBoundingSphere();
      }
      for (let i = 0; i < n; i++) {
        const c = brakingZoneColor(guide ? guide.brakingZone[i] : samples[i].brakingZone);
        for (let k = 0; k < 4; k++) rlColorAttr.setXYZ(i * 4 + k, c.r, c.g, c.b);
      }
    }
    const stepM = track.totalLengthM / n;
    const carIdx =
      Math.floor(
        (((carS % track.totalLengthM) + track.totalLengthM) %
          track.totalLengthM) /
          stepM
      ) % n;

    // Update window from 15 samples behind to 65 samples (~288m) ahead of the car
    for (let offset = -15; offset <= 65; offset++) {
      const idx = (carIdx + offset + n) % n;
      const sp = samples[idx];
      const urgency =
        offset >= -2
          ? evaluateDynamicBrakingUrgency(track, carS, carSpeedMs, sp.s, guide)
          : guide
            ? guide.brakingZone[idx]
            : sp.brakingZone;

      let r = 0.05;
      let g = 0.92;
      let b = 0.38;
      if (urgency >= 0.62) {
        const t = Math.min(1, (urgency - 0.62) / 0.38);
        r = 0.98;
        g = THREE.MathUtils.lerp(0.45, 0.08, t);
        b = THREE.MathUtils.lerp(0.08, 0.16, t);
      } else if (urgency >= 0.25) {
        const t = (urgency - 0.25) / 0.37;
        r = THREE.MathUtils.lerp(0.05, 0.98, t);
        g = THREE.MathUtils.lerp(0.92, 0.72, t);
        b = THREE.MathUtils.lerp(0.38, 0.06, t);
      }

      const vBase = idx * 4;
      for (let k = 0; k < 4; k++) {
        rlColorAttr.setXYZ(vBase + k, r, g, b);
      }
    }
    rlColorAttr.needsUpdate = true;
  };

  // ============================================================================
  // 4. F1 STARTING LIGHTS
  // ============================================================================
  // F1 start lights: five pods over the first red-lamp row of the light assembly hung in the start gantry
  // (s = 14 m, right of the centreline). Until the circuit GLB is live (and headless) they hang at the same
  // place from the track frame; once it loads they snap onto the authored assembly (Prop_StartLights_0).
  const START_LINE_S = 14;
  const startSample = track.getSampleAtDistance(START_LINE_S);
  const startFwd = startSample.tangent.clone().normalize();
  const startRight = startSample.binormal.clone().normalize();
  const startLightGroup = new THREE.Group();
  startLightGroup.name = "StartLightPods";
  sceneGroup.add(startLightGroup);

  /** Lamp states (emissive colour and intensity) shared by the LibreCorsa pods and a converted circuit's own lamps */
  const LAMP_RED = { hex: 0xff1a0a, intensity: 3.2 };
  const LAMP_GREEN = { hex: 0x22c55e, intensity: 2.4 };
  const startLightMeshes: THREE.Mesh[] = [];
  const podGeom = new THREE.CylinderGeometry(0.17, 0.17, 0.12, 16);
  podGeom.rotateX(Math.PI * 0.5);
  for (let i = 0; i < 5; i++) {
    const pod = new THREE.Mesh(
      podGeom,
      new THREE.MeshStandardMaterial({
        color: 0x16a34a,
        emissive: LAMP_GREEN.hex,
        emissiveIntensity: LAMP_GREEN.intensity,
      })
    );
    pod.name = `StartLight_${i}`;
    startLightGroup.add(pod);
    startLightMeshes.push(pod);
  }
  const placePods = (center: THREE.Vector3, halfDepth: number, spacing: number) => {
    const face = center.clone().addScaledVector(startFwd, -(halfDepth + 0.05));
    startLightMeshes.forEach((pod, i) => {
      pod.position.copy(face).addScaledVector(startRight, (i - 2) * spacing);
      pod.lookAt(pod.position.clone().sub(startFwd));
    });
  };
  placePods(
    startSample.position
      .clone()
      .addScaledVector(startSample.normal, 5.75)
      .addScaledVector(startRight, 2.2),
    0.3,
    0.59
  );

  const acRedSemaphores: THREE.MeshStandardMaterial[][] = [[], [], [], [], []];
  const acGreenSemaphores: THREE.MeshStandardMaterial[] = [];
  const grooveMeshes: { mat: THREE.MeshStandardMaterial; min: number; max: number; mult: number }[] = [];
  let startLightState: number | null | undefined;

  const applySemaphoreMaterials = (redCount: number | null) => {
    for (let i = 0; i < 5; i++) {
      const lit = redCount !== null && i < redCount;
      for (const m of acRedSemaphores[i]) {
        m.emissive.setHex(lit ? LAMP_RED.hex : 0x000000);
        m.emissiveIntensity = lit ? LAMP_RED.intensity : 0;
      }
    }
    const greenLit = redCount === null;
    for (const m of acGreenSemaphores) {
      m.emissive.setHex(greenLit ? LAMP_GREEN.hex : 0x000000);
      m.emissiveIntensity = greenLit ? LAMP_GREEN.intensity : 0;
    }
  };

  /** A converted circuit's tyre-groove meshes (AC `groove.ini`), each with its own material to fade */
  const collectGrooves = (root: THREE.Object3D) => {
    root.traverse((obj) => {
      const cfg = inheritedTag<{ min?: number; max?: number; mult?: number }>(obj, "groove", root);
      if (!cfg || !(obj instanceof THREE.Mesh)) return;
      const cloned = (Array.isArray(obj.material) ? obj.material : [obj.material]).map((m) => m.clone());
      obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
      for (const m of cloned) {
        if (!(m instanceof THREE.MeshStandardMaterial)) continue;
        m.transparent = true;
        grooveMeshes.push({ mat: m, min: Number(cfg.min ?? 0.25), max: Number(cfg.max ?? 0.9), mult: Number(cfg.mult ?? 1.0) });
      }
    });
    setGrooveRubber(0);
  };

  /**
   * The start lights on the circuit: the LibreCorsa pods on its gantry model, or a converted circuit's own lamps
   * (`AC_SEMAPHORE_RED01..05`, `AC_SEMAPHORE_GREEN*`), which then light in the pods' place
   */
  const attachStartLightsToGantry = (root: THREE.Object3D) => {
    root.updateMatrixWorld(true);
    let ownLamps = false;
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      // The glTF's own node name: the loader renames repeated names (a second `AC_SEMAPHORE_RED01` becomes `..._1`)
      const nm = inheritedTag<string>(obj, "name", root) ?? obj.name;
      const red = /^AC_SEMAPHORE_RED0?([1-5])$/i.exec(nm);
      const green = /^AC_SEMAPHORE_GREEN/i.test(nm);
      if (!red && !green) return;
      const cloned = (Array.isArray(obj.material) ? obj.material : [obj.material]).map((m) => m.clone());
      obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
      for (const m of cloned) {
        if (!(m instanceof THREE.MeshStandardMaterial)) continue;
        if (red) acRedSemaphores[Number(red[1]) - 1].push(m);
        else acGreenSemaphores.push(m);
      }
      if (red) ownLamps = true;
    });
    if (startLightState !== undefined) applySemaphoreMaterials(startLightState);

    /** The pods across the front of a gantry model, on its first red row, at least `minSpacing` apart */
    const placePodsOn = (gantry: THREE.Object3D, minSpacing: number) => {
      const box = new THREE.Box3().setFromObject(gantry);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      // Four lamps per column (amber, green, red, red): sit on the first red row, 1/8 of the height below centre
      center.y -= size.y * 0.125;
      // Extent of the model along the start direction and across it, from its own vertices: on a diagonal straight
      // the axis-aligned box of a thin panel is far deeper than the panel, and the pods would hang in front of it
      let minF = Infinity;
      let maxF = -Infinity;
      let minR = Infinity;
      let maxR = -Infinity;
      const v = new THREE.Vector3();
      gantry.traverse((obj) => {
        const pos = obj instanceof THREE.Mesh ? obj.geometry.getAttribute("position") : undefined;
        if (!pos) return;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
          const f = v.dot(startFwd);
          const r = v.dot(startRight);
          minF = Math.min(minF, f);
          maxF = Math.max(maxF, f);
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
        }
      });
      if (minF > maxF) return;
      placePods(center, (maxF - minF) * 0.5, Math.max(minSpacing, (maxR - minR) / 5));
    };
    const gantry = root.getObjectByName("Prop_StartLights_0");
    const acGantry = root.getObjectByName("startlight_SUB1");
    if (gantry) placePodsOn(gantry, 0);
    else if (acGantry) placePodsOn(acGantry, 0.28);
    else if (ownLamps) startLightGroup.visible = false;
  };

  const updateEnvironment = (elapsedSeconds: number) => {
    setSceneryTime(elapsedSeconds);
  };

  const setGrooveRubber = (rubber: number) => {
    for (const g of grooveMeshes) {
      g.mat.opacity = THREE.MathUtils.clamp(THREE.MathUtils.lerp(g.min, g.max, Math.min(1, rubber * g.mult)), 0.1, 1.0);
    }
  };

  const setStartLights = (redCount: number | null) => {
    if (redCount === startLightState) return;
    startLightState = redCount;
    startLightMeshes.forEach((pod, i) => {
      const mat = pod.material as THREE.MeshStandardMaterial;
      if (redCount === null) {
        mat.color.setHex(0x16a34a);
        mat.emissive.setHex(LAMP_GREEN.hex);
        mat.emissiveIntensity = LAMP_GREEN.intensity;
      } else if (i < redCount) {
        mat.color.setHex(0xdc2626);
        mat.emissive.setHex(LAMP_RED.hex);
        mat.emissiveIntensity = LAMP_RED.intensity;
      } else {
        mat.color.setHex(0x1a0505);
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
    });
    applySemaphoreMaterials(redCount);
  };

  // Asynchronously load the circuit's own model (browser only)
  let resolveTrackRoot: (root: THREE.Object3D) => void = () => {};
  const trackRoot = new Promise<THREE.Object3D>((resolve) => (resolveTrackRoot = resolve));
  loadTrackGlb(
    track.meshUrl,
    glbGroup,
    fallbackGroup,
    (root) => {
      attachStartLightsToGantry(root);
      collectGrooves(root);
      resolveTrackRoot(root);
    },
    sheenMask,
    track.sceneryUrls ?? [],
    track.roadMaterials ?? [],
    track.sceneryCuts ?? [],
    track.sceneryCutMaterials ?? []
  );

  // The procedural stand-in is placed once
  freezeStaticTransforms(fallbackGroup);

  return {
    sceneGroup,
    racingLineMesh,
    seatRacingLine,
    startLightMeshes,
    updateEnvironment,
    setGrooveRubber,
    updateDynamicRacingLine,
    setStartLights,
    trackRoot,
  };
}

