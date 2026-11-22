import * as THREE from "three";
import { LIVERY_FINISH_PROFILES } from "@/lib/render/f1-livery-painter";
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

const PORTED_VERTEX_PATCH = /* glsl */ `#include <common>
uniform mat4 uProcFrame;
varying vec3 vProcPos;
varying vec3 vProcNrm;`;

const PORTED_VERTEX_BODY = /* glsl */ `#include <begin_vertex>
vProcPos = ( uProcFrame * vec4( position, 1.0 ) ).xyz;
vProcNrm = normalize( mat3( uProcFrame ) * normal );`;

const PORTED_FRAGMENT_PATCH = /* glsl */ `#include <common>
uniform sampler2D uProcAtlas;
uniform float uProcEnabled;
uniform float uProcCarbonStrength;
uniform vec3 uProcMin;
uniform vec3 uProcMax;
uniform float uProcWingRearZ;
uniform float uProcWingMinY;
uniform float uProcHoodStartZ;
uniform float uProcHoodMinY;
uniform float uProcSplitterMaxY;
uniform float uProcSplitterMinZ;
varying vec3 vProcPos;
varying vec3 vProcNrm;

vec2 procAtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
	vec2 pad = vec2( 2.0 / 2048.0 );
	vec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
	return rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float procCarbonTwill( vec2 p ) {
	vec2 c = floor( p );
	float warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
	return 2.0 * warp - 1.0;
}`;

const PORTED_FRAGMENT_MAP = /* glsl */ `#include <map_fragment>
float procCarbonMask = 0.0;
if ( uProcEnabled > 0.5 ) {
	vec3 lp = vProcPos;
	vec3 ln = normalize( vProcNrm );
	vec3 span = max( uProcMax - uProcMin, vec3( 0.001 ) );

	// 1) TOP panel: rect (0, 0, 1.0, 832/2048 = 0.40625)
	vec2 uvTop = vec2( ( lp.z - uProcMin.z ) / span.z, ( uProcMax.x - lp.x ) / span.x );
	vec3 colTop = texture2D( uProcAtlas, procAtlasClamp( uvTop, vec2( 0.0, 0.0 ), vec2( 1.0, 0.40625 ) ) ).rgb;

	// 2) LEFT (+X) and RIGHT (-X) SIDE panels
	vec3 colSide;
	float sideV = ( uProcMax.y - lp.y ) / span.y;
	if ( ln.x >= 0.0 ) {
		float leftU = ( uProcMax.z - lp.z ) / span.z;
		colSide = texture2D( uProcAtlas, procAtlasClamp( vec2( leftU, sideV ), vec2( 0.0, 0.40625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
	} else {
		float rightU = ( lp.z - uProcMin.z ) / span.z;
		colSide = texture2D( uProcAtlas, procAtlasClamp( vec2( rightU, sideV ), vec2( 0.0, 0.625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
	}

	// 3) REAR (-Z) and FRONT (+Z) panels
	vec3 colEnd;
	if ( ln.z < 0.0 ) {
		vec2 uvRear = vec2( ( uProcMax.x - lp.x ) / span.x, sideV );
		colEnd = texture2D( uProcAtlas, procAtlasClamp( uvRear, vec2( 0.0, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
	} else {
		vec2 uvFront = vec2( ( lp.x - uProcMin.x ) / span.x, sideV );
		colEnd = texture2D( uProcAtlas, procAtlasClamp( uvFront, vec2( 0.5, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
	}

	float wx = pow( abs( ln.x ), 4.0 );
	float wy = pow( max( ln.y, 0.0 ) + 0.30 * max( -ln.y, 0.0 ), 4.0 );
	float wz = pow( abs( ln.z ), 5.0 );

	// Keep sloped hoods / prototype noses sharp on the TOP projection
	if ( lp.z > uProcHoodStartZ && lp.y > uProcHoodMinY && ln.y > 0.42 ) {
		wy *= 2.6;
	}
	// Rear wing mainplane top/rear crispness & wing endplate side crispness
	if ( lp.z < uProcWingRearZ && lp.y > uProcWingMinY ) {
		if ( abs( lp.x ) < 0.86 ) {
			if ( ln.z < -0.35 ) wz = max( wz, 3.5 );
			else wy = max( wy, 3.5 );
		} else {
			wx = max( wx, 4.0 );
		}
	}

	vec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );

	// Keep the protruding AMG GT3 Evo front aero splitter tray exposed dark carbon fiber
	if ( uProcSplitterMaxY > 0.0 && lp.y < uProcSplitterMaxY && lp.z > uProcSplitterMinZ ) {
		livCol = vec3( 0.011, 0.012, 0.015 );
	}

	diffuseColor.rgb = livCol;

	float maxC = max( livCol.r, max( livCol.g, livCol.b ) );
	procCarbonMask = ( 1.0 - smoothstep( 0.014, 0.028, maxC ) ) * uProcCarbonStrength;
}`;

const PORTED_FRAGMENT_ROUGHNESS = /* glsl */ `#include <roughnessmap_fragment>
if ( procCarbonMask > 0.01 ) {
	vec3 cn = abs( normalize( vProcNrm ) );
	vec2 cp = cn.y > 0.6 ? vProcPos.xz : ( cn.x > 0.6 ? vProcPos.zy : vProcPos.xy );
	float invPitch = 190.0;
	vec3 dP = fwidth( vProcPos );
	float towsPerPx = max( dP.x, max( dP.y, dP.z ) ) * invPitch;
	float fade = ( 1.0 - smoothstep( 0.15, 0.32, towsPerPx ) ) * ( 1.0 - smoothstep( 8.0, 24.0, length( vViewPosition ) ) );
	float twill = procCarbonTwill( cp * invPitch ) * fade * procCarbonMask;
	roughnessFactor = mix( roughnessFactor, 0.36, procCarbonMask * 0.72 ) + 0.055 * twill;
	diffuseColor.rgb *= 1.0 + 0.14 * twill;
}`;

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
