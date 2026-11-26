import * as THREE from "three";
import { withBasePath } from "@/lib/base-path";
import { chooseAtlasResolution, LIVERY_FINISH_PROFILES } from "@/lib/render/f1-livery-painter";
import { PORTED_LIVERY_SHADERS } from "@/lib/render/livery-projection";
import {
  clearGt3LiveryCache,
  getGt3LiveryAtlasTexture,
  GT3_BODY_PROFILES,
  gt3LiveryById,
} from "@/lib/render/gt3-livery-painter";
import {
  clearLmdhLiveryCache,
  getLmdhLiveryAtlasTexture,
  lmdhLiveryById,
} from "@/lib/render/lmdh-livery-painter";
import {
  clearLianaLiveryCache,
  getLianaLiveryAtlasTexture,
  lianaLiveryById,
} from "@/lib/render/liana-livery-painter";
import type { LiveryFinish } from "@/types/f1";

/**
 * Unified object-space tri-orthographic procedural bodywork shader for ported GLB cars that carry
 * procedural liveries (`amg-gt3`, `bmw-m4-gt3`, `lc-lmdh`, `liana`).
 *
 * Uses one shared zero-recompile shader across all 4 cars and dispatches atlas texture + PBR finish
 * resolution by livery ID, while cleanly restoring every GLB material's original paint on `set(null)`.
 */

export type ProceduralPortedCar = "amg-gt3" | "bmw-m4-gt3" | "lc-lmdh" | "liana";

export interface ProceduralBodyProfile {
  car: ProceduralPortedCar;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  wingRearZ: number;
  wingMinY: number;
  hoodStartZ: number;
  hoodMinY: number;
  splitterMaxY: number;
  splitterMinZ: number;
  flipBackfacing?: boolean;
}

export const PROCEDURAL_BODY_PROFILES: Readonly<Record<ProceduralPortedCar, ProceduralBodyProfile>> = {
  "amg-gt3": {
    car: "amg-gt3",
    min: GT3_BODY_PROFILES["amg-gt3"].min,
    max: GT3_BODY_PROFILES["amg-gt3"].max,
    wingRearZ: GT3_BODY_PROFILES["amg-gt3"].wingRearZ,
    wingMinY: 1.00,
    hoodStartZ: GT3_BODY_PROFILES["amg-gt3"].hoodStartZ,
    hoodMinY: 0.50,
    splitterMaxY: GT3_BODY_PROFILES["amg-gt3"].splitterMaxY,
    splitterMinZ: GT3_BODY_PROFILES["amg-gt3"].splitterMinZ,
  },
  "bmw-m4-gt3": {
    car: "bmw-m4-gt3",
    min: GT3_BODY_PROFILES["bmw-m4-gt3"].min,
    max: GT3_BODY_PROFILES["bmw-m4-gt3"].max,
    wingRearZ: GT3_BODY_PROFILES["bmw-m4-gt3"].wingRearZ,
    wingMinY: 1.00,
    hoodStartZ: GT3_BODY_PROFILES["bmw-m4-gt3"].hoodStartZ,
    hoodMinY: 0.50,
    splitterMaxY: 0.0,
    splitterMinZ: 99.0,
  },
  "lc-lmdh": {
    car: "lc-lmdh",
    min: [-1.01, 0.20, -2.41],
    max: [1.01, 1.16, 2.69],
    wingRearZ: -1.94,
    wingMinY: 0.85,
    hoodStartZ: 1.25,
    hoodMinY: 0.40,
    splitterMaxY: 0.0,
    splitterMinZ: 99.0,
    flipBackfacing: true,
  },
  liana: {
    car: "liana",
    min: [-0.97, 0.16, -2.17],
    max: [0.96, 1.52, 2.17],
    wingRearZ: -99.0,
    wingMinY: 99.0,
    hoodStartZ: 1.10,
    hoodMinY: 0.70,
    splitterMaxY: 0.0,
    splitterMinZ: 99.0,
  },
};

/** Maps each ported GLB's exterior paint material name(s) to its procedural projection profile */
export const PROCEDURAL_PROFILE_BY_MATERIAL: Readonly<Record<string, ProceduralBodyProfile>> = {
  MI_Mercedes_AMG_GT3_Evo_Livery: PROCEDURAL_BODY_PROFILES["amg-gt3"],
  BMWMAT_GT3_EVO_car_paint1: PROCEDURAL_BODY_PROFILES["bmw-m4-gt3"],
  paint_primary: PROCEDURAL_BODY_PROFILES["lc-lmdh"],
  paint_accent: PROCEDURAL_BODY_PROFILES["lc-lmdh"],
  paint_secondary: PROCEDURAL_BODY_PROFILES["lc-lmdh"],
  liana_body_paint: PROCEDURAL_BODY_PROFILES.liana,
};

/**
 * BMW M4 GT3 interior chassis tub, roll cage (`D_Body_*`), interior shell (`SM_Interior_*`), and origin cube
 * (`SM_Root_*`) share `BMWMAT_GT3_EVO_car_paint1` with the exterior panels. Match both raw glTF (`BMW:...`) and
 * Three.js-sanitized (`BMW...`) node/mesh names so runtime and template generator exclude the exact same geometry.
 */
const BMW_INTERIOR_PAINT_MESH_RE = /^BMW:?(?:D_Body_|SM_Interior_|SM_Root_)/;

/** Returns whether a mesh carrying a ported car's paint material belongs to exterior bodywork (not an interior/roll cage) */
export function isProceduralPaintMesh(car: ProceduralPortedCar, meshName: string): boolean {
  if (car === "bmw-m4-gt3" && BMW_INTERIOR_PAINT_MESH_RE.test(meshName)) return false;
  return true;
}

interface ResolvedProceduralAtlas {
  atlas: THREE.CanvasTexture;
  finish: LiveryFinish;
  carbonExposure: number;
}

function resolveProceduralAtlas(id: string): ResolvedProceduralAtlas | null {
  const gt3 = gt3LiveryById(id);
  if (gt3) {
    const atlas = getGt3LiveryAtlasTexture(id);
    return atlas ? { atlas, finish: gt3.finish, carbonExposure: gt3.carbonExposure } : null;
  }
  const lmdh = lmdhLiveryById(id);
  if (lmdh) {
    const atlas = getLmdhLiveryAtlasTexture(id);
    return atlas ? { atlas, finish: lmdh.finish, carbonExposure: lmdh.carbonExposure } : null;
  }
  const liana = lianaLiveryById(id);
  if (liana) {
    const atlas = getLianaLiveryAtlasTexture(id);
    return atlas ? { atlas, finish: liana.finish, carbonExposure: liana.carbonExposure } : null;
  }
  return null;
}

const MAX_CACHED_IMAGE_ATLASES = 12;
const portedImageAtlasCache = new Map<string, THREE.Texture>();
const portedImageAtlasInflight = new Map<string, Promise<THREE.Texture | null>>();
const warnedFailedPortedImageAtlases = new Set<string>();

function portedImageAtlasKey(url: string, resolution: number): string {
  return `${url}|${resolution}`;
}

function configurePortedAtlasTexture(tex: THREE.Texture, name: string): void {
  tex.name = name;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
}

/** Synchronously returns a previously loaded painted ported-car image atlas texture if cached, touching LRU order */
export function getCachedPortedImageAtlas(url: string, resolution = chooseAtlasResolution()): THREE.Texture | null {
  const key = portedImageAtlasKey(url, resolution);
  const hit = portedImageAtlasCache.get(key);
  if (!hit) return null;
  portedImageAtlasCache.delete(key);
  portedImageAtlasCache.set(key, hit);
  return hit;
}

/**
 * Loads a painted 5-panel ported-car atlas image (PNG/WebP/JPEG) asynchronously with sRGB, flipY=false,
 * ClampToEdge and 8x anisotropy, downscaling to `resolution` (1024 px on phone viewports) when larger.
 * Returns null on error and logs once per failing URL.
 */
export function loadPortedImageAtlasTexture(
  url: string,
  resolution = chooseAtlasResolution()
): Promise<THREE.Texture | null> {
  const hit = getCachedPortedImageAtlas(url, resolution);
  if (hit) return Promise.resolve(hit);
  const key = portedImageAtlasKey(url, resolution);
  const inflight = portedImageAtlasInflight.get(key);
  if (inflight) return inflight;
  if (typeof document === "undefined" || typeof Image === "undefined") return Promise.resolve(null);

  const fullUrl = withBasePath(url);
  const promise = new Promise<THREE.Texture | null>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    const fail = () => {
      if (!warnedFailedPortedImageAtlases.has(url)) {
        warnedFailedPortedImageAtlases.add(url);
        console.warn(`Ported car livery atlas image "${url}" failed to load; falling back to model paint`);
      }
      resolve(null);
    };
    img.onerror = fail;
    img.onload = () => {
      const finalize = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          fail();
          return;
        }
        let tex: THREE.Texture;
        if (w > resolution || h > resolution) {
          const canvas = document.createElement("canvas");
          const scale = Math.min(resolution / w, resolution / h);
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext("2d");
          if (ctx && typeof ctx.drawImage === "function") {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            tex = new THREE.CanvasTexture(canvas);
          } else {
            tex = new THREE.Texture(img);
          }
        } else {
          tex = new THREE.Texture(img);
        }
        configurePortedAtlasTexture(tex, `ported_livery_atlas_img_${url}`);
        portedImageAtlasCache.set(key, tex);
        while (portedImageAtlasCache.size > MAX_CACHED_IMAGE_ATLASES) {
          const oldest = portedImageAtlasCache.keys().next().value;
          if (oldest === undefined) break;
          const stale = portedImageAtlasCache.get(oldest);
          portedImageAtlasCache.delete(oldest);
          stale?.dispose();
        }
        resolve(tex);
      };
      if (typeof img.decode === "function") img.decode().then(finalize, finalize);
      else finalize();
    };
    img.src = fullUrl;
  }).finally(() => {
    portedImageAtlasInflight.delete(key);
  });

  portedImageAtlasInflight.set(key, promise);
  return promise;
}

/** Resolves once all currently in-flight ported-car image atlas loads finish */
export function waitForPortedImageAtlases(): Promise<void> {
  if (portedImageAtlasInflight.size === 0) return Promise.resolve();
  return Promise.all([...portedImageAtlasInflight.values()]).then(() => undefined);
}

/** Disposes and clears cached painted ported-car image atlases */
export function clearPortedImageAtlasCache(): void {
  for (const tex of portedImageAtlasCache.values()) tex.dispose();
  portedImageAtlasCache.clear();
  warnedFailedPortedImageAtlases.clear();
}

/** Disposes all cached procedural & painted image bodywork livery atlases (called alongside `clearSkinTextureCache`) */
export function clearAllProceduralLiveryCaches(): void {
  clearGt3LiveryCache();
  clearLmdhLiveryCache();
  clearLianaLiveryCache();
  clearPortedImageAtlasCache();
}

// ---------------------------------------------------------------------------
// Shared Tri-Orthographic Projection Shader
// ---------------------------------------------------------------------------

const BLANK_ATLAS = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
BLANK_ATLAS.colorSpace = THREE.SRGBColorSpace;
BLANK_ATLAS.needsUpdate = true;

const {
  vertexPatch: PORTED_VERTEX_PATCH,
  vertexBody: PORTED_VERTEX_BODY,
  fragmentPatch: PORTED_FRAGMENT_PATCH,
  fragmentMap: PORTED_FRAGMENT_MAP,
  fragmentRoughness: PORTED_FRAGMENT_ROUGHNESS,
} = PORTED_LIVERY_SHADERS;

export interface ProceduralLiverySurface {
  material: THREE.MeshStandardMaterial;
  frameMatrix?: THREE.Matrix4;
}

export interface ProceduralLiveryController {
  set: (liveryId: string | null) => boolean;
  setAtlas: (url: string | null, finish?: LiveryFinish) => Promise<boolean>;
  dispose: () => void;
}

export function installPortedProceduralLivery(
  surfaces: readonly ProceduralLiverySurface[],
  profile: ProceduralBodyProfile
): ProceduralLiveryController {
  const sharedUniforms = {
    uProcAtlas: { value: BLANK_ATLAS as THREE.Texture },
    uProcEnabled: { value: 0.0 },
    uProcCarbonStrength: { value: 0.0 },
    uProcMin: { value: new THREE.Vector3(...profile.min) },
    uProcMax: { value: new THREE.Vector3(...profile.max) },
    uProcWingRearZ: { value: profile.wingRearZ },
    uProcWingMinY: { value: profile.wingMinY },
    uProcHoodStartZ: { value: profile.hoodStartZ },
    uProcHoodMinY: { value: profile.hoodMinY },
    uProcSplitterMaxY: { value: profile.splitterMaxY },
    uProcSplitterMinZ: { value: profile.splitterMinZ },
    uProcFlipBackfacing: { value: profile.flipBackfacing ? 1.0 : 0.0 },
  };
  const identity = new THREE.Matrix4();

  const originals = surfaces.map(({ material: m }) => {
    const phys = m as THREE.MeshPhysicalMaterial;
    return {
      color: m.color.clone(),
      roughness: m.roughness,
      metalness: m.metalness,
      clearcoat: phys.isMeshPhysicalMaterial ? phys.clearcoat : 0,
      clearcoatRoughness: phys.isMeshPhysicalMaterial ? phys.clearcoatRoughness : 0,
      specularIntensity: phys.isMeshPhysicalMaterial ? phys.specularIntensity : 1,
      normalScale: m.normalScale ? m.normalScale.clone() : null,
    };
  });

  for (const s of surfaces) {
    const m = s.material;
    const frameUniform = { value: (s.frameMatrix ?? identity).clone() };
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      prev?.call(m, shader, renderer);
      Object.assign(shader.uniforms, sharedUniforms, { uProcFrame: frameUniform });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", PORTED_VERTEX_PATCH)
        .replace("#include <begin_vertex>", PORTED_VERTEX_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", PORTED_FRAGMENT_PATCH)
        .replace("#include <map_fragment>", PORTED_FRAGMENT_MAP)
        .replace("#include <roughnessmap_fragment>", PORTED_FRAGMENT_ROUGHNESS);
    };
    const prevKey = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${prevKey()}|ported-procedural-livery-v1`;
    m.needsUpdate = true;
  }

  const restoreOriginals = () => {
    for (let i = 0; i < surfaces.length; i++) {
      const m = surfaces[i].material;
      const orig = originals[i];
      const phys = m as THREE.MeshPhysicalMaterial;
      m.color.copy(orig.color);
      m.roughness = orig.roughness;
      m.metalness = orig.metalness;
      if (phys.isMeshPhysicalMaterial) {
        phys.clearcoat = orig.clearcoat;
        phys.clearcoatRoughness = orig.clearcoatRoughness;
        phys.specularIntensity = orig.specularIntensity;
      }
      if (orig.normalScale && m.normalScale) {
        m.normalScale.copy(orig.normalScale);
      }
    }
  };

  const disableAtlas = () => {
    sharedUniforms.uProcEnabled.value = 0.0;
    sharedUniforms.uProcCarbonStrength.value = 0.0;
    restoreOriginals();
  };

  const applyAtlas = (atlas: THREE.Texture, finishName: LiveryFinish, carbonExposure: number) => {
    const finish = LIVERY_FINISH_PROFILES[finishName] ?? LIVERY_FINISH_PROFILES.gloss;
    sharedUniforms.uProcAtlas.value = atlas;
    sharedUniforms.uProcEnabled.value = 1.0;
    sharedUniforms.uProcCarbonStrength.value = carbonExposure;

    for (let i = 0; i < surfaces.length; i++) {
      const m = surfaces[i].material;
      const orig = originals[i];
      const phys = m as THREE.MeshPhysicalMaterial;
      m.color.setHex(0xffffff);
      m.roughness = finish.roughness;
      m.metalness = finish.metalness;
      if (phys.isMeshPhysicalMaterial) {
        phys.clearcoat = finish.clearcoat;
        phys.clearcoatRoughness = finish.clearcoatRoughness;
        phys.specularIntensity = finish.specularIntensity;
      }
      if (orig.normalScale && m.normalScale) {
        const factor = finishName === "matte" ? 0.35 : 0.85;
        m.normalScale.copy(orig.normalScale).multiplyScalar(factor);
      }
    }
  };

  let loadSeq = 0;
  let disposed = false;

  return {
    set: (liveryId) => {
      loadSeq++;
      if (disposed || !liveryId) {
        disableAtlas();
        return false;
      }
      const resolved = resolveProceduralAtlas(liveryId);
      if (!resolved) {
        disableAtlas();
        return false;
      }
      applyAtlas(resolved.atlas, resolved.finish, resolved.carbonExposure);
      return true;
    },
    setAtlas: (url, finishName = "gloss") => {
      const seq = ++loadSeq;
      if (disposed || !url) {
        disableAtlas();
        return Promise.resolve(false);
      }
      const cached = getCachedPortedImageAtlas(url);
      if (cached) {
        applyAtlas(cached, finishName, 0.7);
        return Promise.resolve(true);
      }
      disableAtlas();
      return loadPortedImageAtlasTexture(url).then((tex) => {
        if (disposed || seq !== loadSeq) return false;
        if (!tex) {
          disableAtlas();
          return false;
        }
        applyAtlas(tex, finishName, 0.7);
        return true;
      });
    },
    dispose: () => {
      disposed = true;
      loadSeq++;
      for (const s of surfaces) s.material.dispose();
    },
  };
}
