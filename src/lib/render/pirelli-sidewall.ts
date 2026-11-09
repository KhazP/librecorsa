/**
 * The 2026 Pirelli sidewall on the 2018+ cars' tyres, from Cxjovich's 2026 Pirelli Tire Pack (used with permission,
 * CC BY-NC-SA 4.0, see CREDITS.md; texture ported by `scripts/cars/port_cxjovich_sidewall.py`).
 *
 * The texture is a planar disc centred on the axle: R = rubber albedo (sRGB), G = slick branding (P ZERO, chequers,
 * PIRELLI), B = wet branding (Cinturato), both masks tinted with the compound colour. It is drawn from the tyre's own
 * mesh-local position, so it fits every model whatever its tyre UVs are, and spins with the rubber:
 *  - radius: the mesh's shoulder lands on the texture's sidewall edge (TEX_SHOULDER of the half-width) and the bead
 *    on its rim seat (TEX_RIM), unless that would stretch the lettering: a tall sidewall (the 13" tyres before 2022)
 *    keeps the texture's proportions instead, the logos near the shoulder and plain rubber down to the bead;
 *  - side: u is mirrored on the −X face, so the lettering reads correctly from outside on both faces;
 *  - faces only: weighted by the rest normal's axle component, so the tread and the shoulder keep the model's map.
 */
import * as THREE from "three";
import type { TireCompound } from "@/types/f1";
import { withBasePath } from "@/lib/base-path";
import { HOSTED_CONTENT } from "@/lib/hosted-content";

export const PIRELLI_SIDEWALL_URL = "/cars/shared/tyres/pirelli-2026-sidewall-cx.webp";

/** Pirelli's compound colours (sRGB) */
export const PIRELLI_COMPOUND_COLORS: Readonly<Record<TireCompound, number>> = {
  soft: 0xe10600, // red
  medium: 0xffd700, // yellow
  hard: 0xf8fafc, // white
  intermediate: 0x3ccb4a, // green
  wet: 0x2e7bff, // blue
};

/** Where the rim seat and the sidewall's outer edge sit in the texture (fractions of its half-width) */
const TEX_RIM = 0.69;
const TEX_SHOULDER = 0.89;

// One texture for every tyre; the shaders read it through these shared uniforms, so a late load reaches them all
const sharedMap: THREE.IUniform<THREE.Texture | null> = { value: null };
const sharedReady: THREE.IUniform<number> = { value: 0 };
let loadStarted = false;

function loadSidewallTexture(): void {
  // The artwork is hosted on librecorsa.org only (`hosted-content.ts`); a clone keeps the tyres' own sidewall
  if (loadStarted || typeof window === "undefined" || !HOSTED_CONTENT) return;
  loadStarted = true;
  new THREE.TextureLoader().load(
    withBasePath(PIRELLI_SIDEWALL_URL),
    (tex) => {
      // Packed data: the shader linearises the rubber channel itself
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 8;
      sharedMap.value = tex;
      sharedReady.value = 1;
    },
    undefined,
    () => {
      // Without the texture the tyres keep their own sidewall
      loadStarted = false;
    }
  );
}

/** The tyre mesh's bead (innermost) and shoulder (outermost axle-facing) radii, in mesh-local metres */
export function sidewallBand(geometry: THREE.BufferGeometry): { beadM: number; shoulderM: number } {
  const pos = geometry.getAttribute("position");
  const nrm = geometry.getAttribute("normal");
  let bead = Infinity;
  let shoulder = 0;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getY(i), pos.getZ(i));
    bead = Math.min(bead, r);
    if (nrm && Math.abs(nrm.getX(i)) > 0.7) shoulder = Math.max(shoulder, r);
  }
  if (!Number.isFinite(bead) || shoulder <= bead) {
    // No axle-facing faces found: fall back to the usual F1 18" proportions of the outer radius
    let outer = 0;
    for (let i = 0; i < pos.count; i++) outer = Math.max(outer, Math.hypot(pos.getY(i), pos.getZ(i)));
    return { beadM: 0.67 * outer, shoulderM: 0.95 * outer };
  }
  return { beadM: bead, shoulderM: shoulder };
}

const VERTEX_DECL = /* glsl */ `
varying vec3 vSidewallRest;
varying float vSidewallAxleN;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec3 vSidewallRest;
varying float vSidewallAxleN;
uniform sampler2D uSidewallMap;
uniform float uSidewallReady;
uniform vec3 uSidewallTint;
uniform float uSidewallWet;
uniform vec3 uSidewallFit;
`;

const FRAGMENT_BODY = /* glsl */ `
{
  // Radius in the texture: shoulder -> TEX_SHOULDER, inwards at dt/dr (uSidewallFit = shoulder m, TEX_SHOULDER, dt/dr)
  float swR = length(vSidewallRest.yz);
  float swT = uSidewallFit.y + (swR - uSidewallFit.x) * uSidewallFit.z;
  vec2 swDir = vSidewallRest.yz / max(swR, 1e-5);
  float swSide = vSidewallRest.x >= 0.0 ? 1.0 : -1.0;
  vec2 swUv = 0.5 + 0.5 * swT * vec2(-swSide * swDir.y, swDir.x);
  vec3 sw = texture2D(uSidewallMap, swUv).rgb;
  float swRubber = pow(sw.r, 2.2);
  float swLogo = mix(sw.g, sw.b, uSidewallWet);
  vec3 swColor = mix(vec3(swRubber), uSidewallTint, swLogo);
  float swFace = smoothstep(0.55, 0.8, abs(vSidewallAxleN)) * uSidewallReady;
  diffuseColor.rgb = mix(diffuseColor.rgb, swColor, swFace);
}
`;

export interface PirelliSidewallPatch {
  uniforms: Record<string, THREE.IUniform>;
  /** Adds the sidewall to a tyre material's shaders (call from its onBeforeCompile) */
  patch(shader: THREE.WebGLProgramParametersWithUniforms): void;
  setCompound(compound: TireCompound): void;
}

/** The sidewall for one tyre mesh: its own fit and compound, the shared texture */
export function createPirelliSidewall(
  geometry: THREE.BufferGeometry,
  compound: TireCompound = "medium"
): PirelliSidewallPatch {
  loadSidewallTexture();
  const { beadM, shoulderM } = sidewallBand(geometry);
  // Texture half-widths per metre: the bead-to-shoulder fit, or at least the uniform scale that keeps the lettering's
  // proportions (on a tall sidewall the fit would stretch it radially)
  const texPerM = Math.max((TEX_SHOULDER - TEX_RIM) / (shoulderM - beadM), TEX_SHOULDER / shoulderM);
  const tint = new THREE.Color();
  const uniforms: Record<string, THREE.IUniform> = {
    uSidewallMap: sharedMap,
    uSidewallReady: sharedReady,
    uSidewallTint: { value: tint },
    uSidewallWet: { value: 0 },
    uSidewallFit: { value: new THREE.Vector3(shoulderM, TEX_SHOULDER, texPerM) },
  };
  const setCompound = (c: TireCompound) => {
    tint.setHex(PIRELLI_COMPOUND_COLORS[c]);
    uniforms.uSidewallWet.value = c === "intermediate" || c === "wet" ? 1 : 0;
  };
  setCompound(compound);
  return {
    uniforms,
    setCompound,
    patch(shader) {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_DECL}`)
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n\tvSidewallRest = position;\n\tvSidewallAxleN = normal.x;"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAGMENT_DECL}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_BODY}`);
    },
  };
}
