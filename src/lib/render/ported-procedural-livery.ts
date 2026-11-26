import * as THREE from "three";
import { LIVERY_FINISH_PROFILES } from "@/lib/render/f1-livery-painter";
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

/** Disposes all cached procedural bodywork livery atlases (called alongside `clearSkinTextureCache`) */
export function clearAllProceduralLiveryCaches(): void {
  clearGt3LiveryCache();
  clearLmdhLiveryCache();
  clearLianaLiveryCache();
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

  return {
    set: (liveryId) => {
      if (!liveryId) {
        sharedUniforms.uProcEnabled.value = 0.0;
        sharedUniforms.uProcCarbonStrength.value = 0.0;
        restoreOriginals();
        return false;
      }
      const resolved = resolveProceduralAtlas(liveryId);
      if (!resolved) {
        sharedUniforms.uProcEnabled.value = 0.0;
        sharedUniforms.uProcCarbonStrength.value = 0.0;
        restoreOriginals();
        return false;
      }
      const finish = LIVERY_FINISH_PROFILES[resolved.finish] ?? LIVERY_FINISH_PROFILES.gloss;
      sharedUniforms.uProcAtlas.value = resolved.atlas;
      sharedUniforms.uProcEnabled.value = 1.0;
      sharedUniforms.uProcCarbonStrength.value = resolved.carbonExposure;

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
          const factor = resolved.finish === "matte" ? 0.35 : 0.85;
          m.normalScale.copy(orig.normalScale).multiplyScalar(factor);
        }
      }
      return true;
    },
    dispose: () => {
      for (const s of surfaces) s.material.dispose();
    },
  };
}
