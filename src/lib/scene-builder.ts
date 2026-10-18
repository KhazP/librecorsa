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
import type { RacingLineId, RunoffStyle, TrackSamplePoint } from "@/types/f1";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { assetProgress } from "@/lib/loading/asset-progress";

export interface BuiltRwandaScene {
  sceneGroup: THREE.Group;
  racingLineMesh: THREE.Mesh;
  waterMesh: THREE.Mesh;
  startLightMeshes: THREE.Mesh[];
  updateEnvironment: (elapsedSeconds: number) => void;
  /** Recolours the braking line ahead of the car; `guide` = the car's own braking guide (else the circuit's) */
  updateDynamicRacingLine: (carS: number, carSpeedMs: number, guide?: BrakingGuide | null) => void;
  /** Start gantry: null = idle (green), 0..5 = number of red lights lit */
  setStartLights: (redCount: number | null) => void;
  /**
   * The authored track root once the GLB is in the scene (Track_Collider_* nodes included, hidden), e.g. for
   * `TrackColliderQuery.fromTrackRoot`. Never settles when the GLB cannot load (headless or fallback track).
   */
  trackRoot: Promise<THREE.Object3D>;
}

// Rwanda 2026 circuit: one glTF exported from the Blender rebuild (public/tracks/rwanda/rwanda_2026.glb).
// Node naming contract: Track_* (racing surfaces, barriers), Track_Collider_* (invisible physics proxies,
// extras.collider = true), Terrain, Lake, Env_* (vegetation, canopies) and Prop_* (buildings, stands, gantry).
// The other circuits (scripts/tracks/build_track.py) wrap a converted scan in `Track_Model` and append hidden
// `Track_Collider_*` / `Track_Surface_*` physics meshes (extras.hidden = true); `track.meshUrl` names the file.

// Flat overlays drawn on top of the asphalt / run-off; pulled towards the camera to avoid z-fighting.
const DECAL_NODES: Record<string, number> = {
  Track_Markings: -2,
  Track_Pit_Markings: -2,
  Track_Runoff_Decals: -2,
  Track_Kerbs: -1,
  Track_Runoff_Paint: -1,
};
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

function loadTrackGlb(
  url: string,
  glbGroup: THREE.Group,
  fallbackGroup: THREE.Group,
  onLoaded: (root: THREE.Object3D) => void,
  sheenMask: RacingLineMask
): void {
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    return;
  }

  // `?colliders=1`: draw the physics surfaces (by type) and barriers over the scan, to check them against it
  const showColliders = new URLSearchParams(window.location.search).get("colliders") === "1";
  assetProgress.begin("track");
  // Circuit scans are meshopt-compressed (scripts/compress-track-glb.mjs)
  new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync(withBasePath(url), (event) => assetProgress.progress("track", event))
    .then((gltf) => {
      const root = gltf.scene;
      root.name = "Rwanda2026Track";
      const box = new THREE.Box3();
      const size = new THREE.Vector3();
      root.updateMatrixWorld(true);
      root.traverse((obj) => {
        // Exported node extras land on the node; the mesh child inherits nothing, so walk up.
        let node: THREE.Object3D | null = obj;
        let topName = obj.name;
        let isCollider = false;
        while (node && node !== root) {
          if (node.userData?.collider || node.userData?.hidden) isCollider = true;
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

        const receiveOnly = SHADOW_RECEIVE_ONLY.has(topName);
        obj.receiveShadow = true;
        if (topName === "Track_Model") {
          // Converted scans have no naming contract: only tall things (stands, buildings, trees, barriers) cast
          obj.geometry.computeBoundingBox();
          box.copy(obj.geometry.boundingBox!).applyMatrix4(obj.matrixWorld).getSize(size);
          obj.castShadow = size.y > 1.2;
        } else {
          obj.castShadow = !receiveOnly && (topName.startsWith("Prop_") || topName.startsWith("Env_") || topName.startsWith("Track_"));
        }

        const offset = DECAL_NODES[topName];
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
          if (topName === "Track_Asphalt_Road") applyAsphaltSheen(mat, sheenMask);
          for (const tex of [mat.map, mat.roughnessMap, mat.metalnessMap, mat.normalMap]) {
            if (tex) tex.anisotropy = 8;
          }
          if (offset !== undefined) {
            mat.polygonOffset = true;
            mat.polygonOffsetFactor = offset;
            mat.polygonOffsetUnits = offset;
          }
        }
        if (offset !== undefined) obj.renderOrder = 1;
      });
      glbGroup.add(root);
      onLoaded(root);

      // Hide the procedural stand-in geometry once the authored circuit is live
      fallbackGroup.visible = false;
      assetProgress.done("track");
    })
    .catch((err) => {
      console.warn("Using fallback procedural track geometry:", err);
      assetProgress.fail("track");
    });
}

function getTrackFrameQuaternion(sample: TrackSamplePoint): THREE.Quaternion {
  const left = new THREE.Vector3()
    .crossVectors(sample.normal, sample.tangent)
    .normalize();
  const up = sample.normal.clone().normalize();
  const forward = sample.tangent.clone().normalize();
  const m = new THREE.Matrix4().makeBasis(left, up, forward);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function createGrandstandSeatsTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(0, 0, 512, 256);

    for (let row = 0; row < 18; row++) {
      const y = 8 + row * 13;
      const tierBase =
        row < 8 ? "#00a3e0" : row < 13 ? "#fad201" : "#15803d";
      ctx.fillStyle = tierBase;
      ctx.fillRect(0, y, 512, 11);

      for (let s = 0; s < 64; s++) {
        if (s % 16 === 0 || s % 16 === 1) {
          ctx.fillStyle = "#cbd5e1";
          ctx.fillRect(s * 8, y, 8, 13);
          continue;
        }
        const hasSpectator = (row * 11 + s * 7) % 3 !== 0;
        if (hasSpectator) {
          const specCols = ["#0f172a", "#1e3a8a", "#ffffff", "#dc2626", "#0284c7"];
          ctx.fillStyle = specCols[(row * 5 + s * 3) % specCols.length];
          ctx.fillRect(s * 8 + 1, y + 2, 5, 7);
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  return tex;
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

/**
 * Builds a realistic sloped stadium grandstand group facing the track.
 * In local track frame, -X is left (+binormal) and +X is right (-binormal).
 * When placed on `side` (-1 = left of track, +1 = right of track), the sloped seating bowl
 * faces inward toward the track centerline (`x = 0`).
 */
function buildSlopedGrandstandGroup(
  depth: number,
  height: number,
  length: number,
  side: -1 | 1,
  seatTex: THREE.Texture,
  canopyMat?: THREE.Material | THREE.Material[]
): THREE.Group {
  const group = new THREE.Group();
  group.userData.isTracksideStructure = true;
  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.65,
  });

  // Lower concrete podium base
  const baseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(depth, 2.2, length),
    concreteMat
  );
  baseMesh.position.y = 1.1;
  group.add(baseMesh);

  // Rear structural backwall
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, height, length),
    concreteMat
  );
  // In getTrackFrameQuaternion, local +X is `left = normal x tangent = -binormal`.
  // Wait: let's check getTrackFrameQuaternion:
  // `left = normal x tangent`. Since `binormal = tangent x normal = -left`,
  // a point shifted by `side * dist` along `binormal` has local X = `-side * dist`!
  // So toward the track centerline from `side * dist` along `binormal` is local X = `+side`!
  const frontSign = side; // local X direction pointing BACK toward the track centerline
  backWall.position.set(-frontSign * (depth * 0.5 - 0.8), height * 0.5, 0);
  group.add(backWall);

  // Explicit 4-vertex sloped stadium seating quad facing the track (immune to Euler rotation order)
  const frontX = frontSign * (depth * 0.5 - 0.2);
  const backX = -frontSign * (depth * 0.5 - 1.6);
  const halfL = length * 0.5;
  const seatGeom = new THREE.BufferGeometry();
  seatGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        frontX, 2.2, -halfL, // 0: Front bottom (-Z)
        frontX, 2.2, halfL,  // 1: Front bottom (+Z)
        backX, height, -halfL, // 2: Back top (-Z)
        backX, height, halfL,  // 3: Back top (+Z)
      ],
      3
    )
  );
  seatGeom.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)
  );
  seatGeom.setIndex([0, 1, 2, 1, 3, 2]);
  seatGeom.computeVertexNormals();

  const seatPlane = new THREE.Mesh(
    seatGeom,
    new THREE.MeshStandardMaterial({
      map: seatTex,
      roughness: 0.55,
      side: THREE.DoubleSide,
    })
  );
  group.add(seatPlane);

  // Cantilevered white stadium roof overhang + support columns
  const roofMesh = new THREE.Mesh(
    new THREE.BoxGeometry(depth + 4.5, 0.9, length + 4),
    canopyMat ??
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 })
  );
  roofMesh.position.set(frontSign * 1.5, height + 2.1, 0);
  roofMesh.rotation.z = -frontSign * 0.06;
  group.add(roofMesh);

  const numCols = Math.max(3, Math.floor(length / 36));
  for (let c = 0; c < numCols; c++) {
    const cz = -length * 0.46 + (c / Math.max(1, numCols - 1)) * (length * 0.92);
    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.34, height + 2.0, 8),
      concreteMat
    );
    strut.position.set(-frontSign * (depth * 0.42), (height + 2.0) * 0.5, cz);
    group.add(strut);
  }

  return group;
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

export function buildRwandaCircuitScene(
  track: BuiltTrackData
): BuiltRwandaScene {
  const sceneGroup = new THREE.Group();
  /** Bugesera dressing (lake, airliner) only belongs on the Rwanda circuit */
  const isRwanda = (track.id ?? "rwanda") === "rwanda";
  const glbGroup = new THREE.Group();
  glbGroup.name = "Rwanda2026GlbGroup";
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

    return [l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, l1.x, l1.y, l1.z, r1.x, r1.y, r1.z];
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
  sceneGroup.add(racingLineMesh);

  /**
   * Real-time updater for the 3D dashed braking line: dynamically transitions dashes
   * ahead of the player between Green, Yellow, and Red based on the car's live speed
   * vs the physics-derived optimal corner speed profile.
   */
  let lineGuide: BrakingGuide | null = null;
  let drawnLine: RacingLineId = 'f1';
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
  // 4. SHIMMERING LAKE BUGESERA WATER PLANE & F1 STARTING LIGHTS MAST
  // ============================================================================
  const waterGeom = new THREE.PlaneGeometry(1800, 2200, 16, 16);
  waterGeom.rotateX(-Math.PI * 0.5);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x0284c7,
    roughness: 0.14,
    metalness: 0.65,
    transparent: true,
    opacity: 0.92,
  });
  const waterMesh = new THREE.Mesh(waterGeom, waterMat);
  waterMesh.position.set(-1340, -18.0, -120);
  if (isRwanda) fallbackGroup.add(waterMesh);

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

  const startLightMeshes: THREE.Mesh[] = [];
  const podGeom = new THREE.CylinderGeometry(0.17, 0.17, 0.12, 16);
  podGeom.rotateX(Math.PI * 0.5);
  for (let i = 0; i < 5; i++) {
    const pod = new THREE.Mesh(
      podGeom,
      new THREE.MeshStandardMaterial({
        color: 0x16a34a,
        emissive: 0x22c55e,
        emissiveIntensity: 2.4,
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

  const attachStartLightsToGantry = (root: THREE.Object3D) => {
    root.updateMatrixWorld(true);
    const assembly = root.getObjectByName("Prop_StartLights_0");
    if (!assembly) return;
    const box = new THREE.Box3().setFromObject(assembly);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Four lamps per column (amber, green, red, red): sit on the first red row, 1/8 of the height below centre
    center.y -= size.y * 0.125;
    const depth = Math.abs(size.dot(startFwd));
    const width = Math.abs(size.x * startRight.x) + Math.abs(size.z * startRight.z);
    placePods(center, depth * 0.5, width / 5);
  };

  // ============================================================================
  // 5. COLLISION-VERIFIED TRACKSIDE STRUCTURES (In fallbackGroup for headless verification)
  // ============================================================================
  const isFootprintClearOfTrack = (
    centerPos: THREE.Vector3,
    quat: THREE.Quaternion,
    halfSizeX: number,
    halfSizeZ: number,
    minCenterlineClearanceM = 30.0
  ): boolean => {
    const minSq = minCenterlineClearanceM * minCenterlineClearanceM;
    const localPt = new THREE.Vector3();
    for (let ix = -2; ix <= 2; ix++) {
      for (let iz = -4; iz <= 4; iz++) {
        localPt
          .set((ix / 2) * halfSizeX, 0, (iz / 4) * halfSizeZ)
          .applyQuaternion(quat)
          .add(centerPos);
        for (let sIdx = 0; sIdx < n; sIdx++) {
          const sp = samples[sIdx].position;
          const dx = localPt.x - sp.x;
          const dz = localPt.z - sp.z;
          if (dx * dx + dz * dz < minSq) {
            return false;
          }
        }
      }
    }
    return true;
  };

  const findSafeTracksidePosition = (
    sample: TrackSamplePoint,
    preferredSide: -1 | 1,
    halfSizeX: number,
    halfSizeZ: number,
    startOffsetM = 44,
    minCenterlineClearanceM = 30.0
  ): { pos: THREE.Vector3; side: -1 | 1; quat: THREE.Quaternion } | null => {
    const quat = getTrackFrameQuaternion(sample);
    for (const side of [preferredSide, (preferredSide * -1) as -1 | 1]) {
      for (let dist = startOffsetM; dist <= 220; dist += 6) {
        const candidatePos = sample.position
          .clone()
          .addScaledVector(sample.binormal, side * dist)
          .add(new THREE.Vector3(0, -0.5, 0));
        if (
          isFootprintClearOfTrack(
            candidatePos,
            quat,
            halfSizeX,
            halfSizeZ,
            minCenterlineClearanceM
          )
        ) {
          return { pos: candidatePos, side, quat };
        }
      }
    }
    return null;
  };

  const grandstandSeatTex = createGrandstandSeatsTexture();
  grandstandSeatTex.repeat.set(6, 1);

  const sectorGrandstands: {
    sDist: number;
    side: -1 | 1;
    length: number;
  }[] = [
    { sDist: 140, side: -1, length: 68 },
    { sDist: 140, side: 1, length: 68 },
    { sDist: 455, side: -1, length: 64 },
    { sDist: 1580, side: -1, length: 64 },
    { sDist: 2940, side: 1, length: 68 },
    { sDist: 4240, side: -1, length: 64 },
    { sDist: 4920, side: -1, length: 68 },
  ];

  for (const sg of sectorGrandstands) {
    const sp = track.getSampleAtDistance(sg.sDist);
    const safeGs = findSafeTracksidePosition(
      sp,
      sg.side,
      14.0,
      sg.length * 0.5 + 4.0,
      48,
      32.0
    );
    if (safeGs) {
      const gGroup = buildSlopedGrandstandGroup(
        16,
        12,
        sg.length,
        safeGs.side,
        grandstandSeatTex
      );
      gGroup.position.copy(safeGs.pos);
      gGroup.quaternion.copy(safeGs.quat);
      fallbackGroup.add(gGroup);
    }
  }

  // Trackside TV Broadcast Camera Scaffold Towers
  for (const camDist of [410, 890, 1890, 3150, 4410]) {
    const sp = track.getSampleAtDistance(camDist);
    const safeCam = findSafeTracksidePosition(sp, -1, 4.0, 4.0, 38, 30.0);
    if (safeCam) {
      const camTower = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 7.5, 2.4),
        new THREE.MeshStandardMaterial({
          color: 0x94a3b8,
          metalness: 0.5,
          roughness: 0.4,
        })
      );
      camTower.userData.isTracksideStructure = true;
      camTower.position.copy(safeCam.pos).add(new THREE.Vector3(0, 4.0, 0));
      fallbackGroup.add(camTower);
    }
  }

  // Lakeside White Peaked Hospitality Tents & Pavilions
  const whiteTentMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.35,
  });
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.55,
  });

  for (const sDist of [4140, 4210, 4280, 4350, 4490, 4570, 4650]) {
    const sp = track.getSampleAtDistance(sDist);
    const safeTent = findSafeTracksidePosition(sp, -1, 12.0, 12.0, 46, 32.0);
    if (!safeTent) continue;

    const pavGroup = new THREE.Group();
    pavGroup.userData.isTracksideStructure = true;
    pavGroup.position
      .copy(safeTent.pos)
      .setY(Math.max(1.5, sp.position.y - 3.8));

    const tentWalls = new THREE.Mesh(
      new THREE.BoxGeometry(14, 3.6, 14),
      deckMat
    );
    tentWalls.position.y = 1.8;
    pavGroup.add(tentWalls);

    const tentPeak = new THREE.Mesh(
      new THREE.ConeGeometry(11.2, 5.2, 4),
      whiteTentMat
    );
    tentPeak.rotation.y = Math.PI * 0.25;
    tentPeak.position.y = 6.2;
    pavGroup.add(tentPeak);
    fallbackGroup.add(pavGroup);
  }

  // RwandAir Jetliner Banking in the Sky near Bugesera International Airport
  const jetGroup = new THREE.Group();
  const fuselageMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.25,
    metalness: 0.3,
  });
  const tailBlueMat = new THREE.MeshStandardMaterial({
    color: 0x00a3e0,
    roughness: 0.3,
  });
  const fuselage = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 1.6, 38, 12),
    fuselageMat
  );
  fuselage.rotation.x = Math.PI * 0.5;
  jetGroup.add(fuselage);

  const mainWings = new THREE.Mesh(
    new THREE.BoxGeometry(36, 0.4, 5.2),
    fuselageMat
  );
  mainWings.position.set(0, -0.2, 2);
  jetGroup.add(mainWings);

  const tailFin = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 7.5, 5.5),
    tailBlueMat
  );
  tailFin.position.set(0, 4.2, -16);
  jetGroup.add(tailFin);

  jetGroup.position.set(-420, 210, -380);
  if (isRwanda) sceneGroup.add(jetGroup);

  const updateEnvironment = (elapsedSeconds: number) => {
    waterMesh.position.y = -18.0 + Math.sin(elapsedSeconds * 1.4) * 0.08;
    // Gently circle the RwandAir jetliner across the sky near Bugesera Airport
    const jetAngle = elapsedSeconds * 0.045;
    jetGroup.position.set(
      -250 + Math.cos(jetAngle) * 680,
      205 + Math.sin(elapsedSeconds * 0.2) * 8,
      -200 + Math.sin(jetAngle) * 680
    );
    jetGroup.rotation.y = -jetAngle;
    jetGroup.rotation.z = 0.14;
  };

  let startLightState: number | null | undefined;
  const setStartLights = (redCount: number | null) => {
    if (redCount === startLightState) return;
    startLightState = redCount;
    startLightMeshes.forEach((pod, i) => {
      const mat = pod.material as THREE.MeshStandardMaterial;
      if (redCount === null) {
        mat.color.setHex(0x16a34a);
        mat.emissive.setHex(0x22c55e);
        mat.emissiveIntensity = 2.4;
      } else if (i < redCount) {
        mat.color.setHex(0xdc2626);
        mat.emissive.setHex(0xff1a0a);
        mat.emissiveIntensity = 3.2;
      } else {
        mat.color.setHex(0x1a0505);
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
    });
  };

  // Asynchronously load the authored Rwanda 2026 circuit (browser only)
  let resolveTrackRoot: (root: THREE.Object3D) => void = () => {};
  const trackRoot = new Promise<THREE.Object3D>((resolve) => (resolveTrackRoot = resolve));
  loadTrackGlb(
    track.meshUrl ?? "/tracks/rwanda/rwanda_2026.glb",
    glbGroup,
    fallbackGroup,
    (root) => {
      attachStartLightsToGantry(root);
      resolveTrackRoot(root);
    },
    sheenMask
  );

  return {
    sceneGroup,
    racingLineMesh,
    waterMesh,
    startLightMeshes,
    updateEnvironment,
    updateDynamicRacingLine,
    setStartLights,
    trackRoot,
  };
}

