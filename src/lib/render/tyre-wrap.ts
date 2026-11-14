/**
 * The 2026 car's tyres: Purple Sector's "2025 Pirelli tyres" wrapped round the whole tyre, both sidewalls and the
 * tread (used with permission, see CREDITS.md; textures ported by `scripts/cars/port_purple_sector_tyres.py`).
 *
 * The textures are strips: u runs once round the tyre, v crosses it from the outer bead over the outer sidewall, the
 * tread and the inner sidewall to the inner bead. The car's tyre mesh has no UVs, so the strip is laid on from the
 * mesh itself:
 *  - round the tyre: the angle of the rest position about the axle, mirrored on the right-hand wheels so the
 *    lettering reads from outside on both sides of the car;
 *  - across it: each vertex's distance along the tyre's cross-section (`tyreAcross`, worked out once per geometry),
 *    with the mesh's tread edges on the strip's.
 * The rubber comes from one texture (the slicks' and the wet's, or the intermediate's with its tread), the printed
 * art (stripe, PIRELLI, P ZERO or Cinturato) from a second one as coverage, printed in the compound's colour.
 *
 * The textures are hosted on librecorsa.org only (`hosted-content.ts`). Without them the tyre keeps what it had: a
 * clone its plain rubber, and a copy that cannot fetch them the older sidewall (`pirelli-sidewall.ts`).
 */
import * as THREE from "three";
import type { TireCompound } from "@/types/f1";
import { withBasePath } from "@/lib/base-path";
import { HOSTED_CONTENT } from "@/lib/hosted-content";

const TYRE_DIR = "/cars/shared/tyres/";
type Rubber = "slick" | "intermediate";
const RUBBER_URL: Readonly<Record<Rubber, string>> = {
  slick: `${TYRE_DIR}pirelli-2025-ps-slick.webp`,
  intermediate: `${TYRE_DIR}pirelli-2025-ps-intermediate.webp`,
};
const ART_URL = `${TYRE_DIR}pirelli-2025-ps-art.webp`;

/** The pack's wet has the slick's tread; only the intermediate has its own */
const rubberOf = (c: TireCompound): Rubber => (c === "intermediate" ? "intermediate" : "slick");

/** The art's colours as the pack prints them (sRGB) */
const ART_COLORS: Readonly<Record<TireCompound, number>> = {
  soft: 0xb20006,
  medium: 0xffd600,
  hard: 0xffffff,
  intermediate: 0x64ad00,
  wet: 0x0066b7,
};

/** The strip's tread edges, outer and inner (v), and the rows the art texture covers (the port script's ART_BAND) */
const V_TREAD_OUTER = 193 / 1024;
const V_TREAD_INNER = 834 / 1024;
const ART_V0 = 64 / 1024;
const ART_V1 = 192 / 1024;

/** A tyre's surface counts as tread where its normal leans this far from the axle, or further */
const TREAD_EDGE_AXLE_N = 0.6;

const textures = new Map<string, Promise<THREE.Texture | null>>();

function loadTexture(url: string, colorSpace: THREE.ColorSpace): Promise<THREE.Texture | null> {
  let p = textures.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      new THREE.TextureLoader().load(
        withBasePath(url),
        (tex) => {
          tex.colorSpace = colorSpace;
          // v is the strip's row as drawn, and the strip closes on itself round the tyre
          tex.flipY = false;
          tex.wrapS = THREE.RepeatWrapping;
          tex.anisotropy = 8;
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        () => {
          textures.delete(url);
          resolve(null);
        }
      );
    });
    textures.set(url, p);
  }
  return p;
}

/**
 * Adds `tyreAcross` to a tyre geometry: each vertex's place across the tyre, 0 at the −X bead, 1/3 and 2/3 at the −X
 * and +X tread edges, 1 at the +X bead, by distance along the cross-section in between. The cross-section is read off
 * the mesh: its distinct (x, radius) points, in order of their angle about the bead line.
 */
export function addTyreAcross(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute("tyreAcross")) return;
  const pos = geometry.getAttribute("position");
  const nrm = geometry.getAttribute("normal");
  const n = pos.count;
  const radius = new Float32Array(n);
  let bead = Infinity;
  for (let i = 0; i < n; i++) {
    radius[i] = Math.hypot(pos.getY(i), pos.getZ(i));
    bead = Math.min(bead, radius[i]);
  }
  // Distinct cross-section points (0.1 mm), each with the strongest axle lean of the normals at it
  const keyOf = (i: number) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(radius[i] * 1e4)}`;
  const points = new Map<string, { x: number; r: number; lean: number; angle: number; t: number }>();
  for (let i = 0; i < n; i++) {
    const key = keyOf(i);
    const lean = nrm ? Math.abs(nrm.getX(i)) : 0;
    const p = points.get(key);
    if (p) p.lean = Math.max(p.lean, lean);
    else points.set(key, { x: pos.getX(i), r: radius[i], lean, angle: Math.atan2(pos.getX(i), radius[i] - bead), t: 0 });
  }
  const profile = [...points.values()].sort((a, b) => a.angle - b.angle);
  const along = new Float32Array(profile.length);
  for (let k = 1; k < profile.length; k++) {
    along[k] = along[k - 1] + Math.hypot(profile[k].x - profile[k - 1].x, profile[k].r - profile[k - 1].r);
  }
  // The tread: the run of points round the middle whose normals lean less than the edge's
  const mid = profile.reduce((best, p, k) => (Math.abs(p.x) < Math.abs(profile[best].x) ? k : best), 0);
  let lo = mid;
  let hi = mid;
  while (lo > 0 && profile[lo - 1].lean < TREAD_EDGE_AXLE_N) lo--;
  while (hi < profile.length - 1 && profile[hi + 1].lean < TREAD_EDGE_AXLE_N) hi++;
  const total = along[profile.length - 1];
  const part = (k: number, from: number, to: number) => (along[k] - from) / Math.max(to - from, 1e-6);
  profile.forEach((p, k) => {
    if (k < lo) p.t = part(k, 0, along[lo]) / 3;
    else if (k <= hi) p.t = (1 + part(k, along[lo], along[hi])) / 3;
    else p.t = (2 + part(k, along[hi], total)) / 3;
  });
  const across = new Float32Array(n);
  for (let i = 0; i < n; i++) across[i] = points.get(keyOf(i))!.t;
  geometry.setAttribute("tyreAcross", new THREE.BufferAttribute(across, 1));
}

const VERTEX_DECL = /* glsl */ `
attribute float tyreAcross;
varying vec3 vTyreWrapRest;
varying float vTyreWrapAcross;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec3 vTyreWrapRest;
varying float vTyreWrapAcross;
uniform sampler2D uTyreWrapRubber;
uniform sampler2D uTyreWrapArt;
uniform float uTyreWrapReady;
uniform vec3 uTyreWrapTint;
uniform float uTyreWrapCinturato;
uniform float uTyreWrapOuter;
`;

const FRAGMENT_BODY = /* glsl */ `
{
  // Across: 0 at the outer bead. The tread edges of the mesh (1/3, 2/3) land on the strip's
  float twT = uTyreWrapOuter > 0.0 ? 1.0 - vTyreWrapAcross : vTyreWrapAcross;
  float twV = twT < 1.0 / 3.0
    ? twT * 3.0 * ${V_TREAD_OUTER.toFixed(5)}
    : twT < 2.0 / 3.0
      ? mix(${V_TREAD_OUTER.toFixed(5)}, ${V_TREAD_INNER.toFixed(5)}, twT * 3.0 - 1.0)
      : mix(${V_TREAD_INNER.toFixed(5)}, 1.0, twT * 3.0 - 2.0);
  // Round: the angle about the axle. Its own derivative is used, since the angle jumps where it wraps
  vec2 twP = vTyreWrapRest.yz;
  float twTurn = uTyreWrapOuter * 0.15915494;
  float twU = twTurn * atan(twP.y, twP.x);
  vec2 twDx = dFdx(twP);
  vec2 twDy = dFdy(twP);
  float twR2 = max(dot(twP, twP), 1e-8);
  vec2 twGradX = vec2(twTurn * (twP.x * twDx.y - twP.y * twDx.x) / twR2, dFdx(twV));
  vec2 twGradY = vec2(twTurn * (twP.x * twDy.y - twP.y * twDy.x) / twR2, dFdy(twV));
  vec3 twRubber = textureGrad(uTyreWrapRubber, vec2(twU, twV), twGradX, twGradY).rgb;
  float twArtScale = 1.0 / ${(ART_V1 - ART_V0).toFixed(5)};
  float twArtV = (twV - ${ART_V0.toFixed(5)}) * twArtScale;
  vec2 twArt = textureGrad(
    uTyreWrapArt,
    vec2(twU, twArtV),
    vec2(twGradX.x, twGradX.y * twArtScale),
    vec2(twGradY.x, twGradY.y * twArtScale)
  ).rg;
  float twPrint = mix(twArt.r, twArt.g, uTyreWrapCinturato) * step(0.0, twArtV) * step(twArtV, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(twRubber, uTyreWrapTint, twPrint), uTyreWrapReady);
}
`;

export interface TyreWrapPatch {
  uniforms: Record<string, THREE.IUniform>;
  /** Adds the wrap to a tyre material's shaders (call from its onBeforeCompile, before the sidewall's patch) */
  patch(shader: THREE.WebGLProgramParametersWithUniforms): void;
  setCompound(compound: TireCompound): void;
}

/**
 * The wrap for one tyre mesh. `outerSide` is the mesh-local X the car's outside is on (+1 or −1). `onUnavailable`
 * runs once if the textures cannot be fetched.
 */
export function createTyreWrap(
  geometry: THREE.BufferGeometry,
  outerSide: 1 | -1,
  compound: TireCompound = "medium",
  onUnavailable?: () => void
): TyreWrapPatch {
  addTyreAcross(geometry);
  const tint = new THREE.Color();
  const uniforms: Record<string, THREE.IUniform> = {
    uTyreWrapRubber: { value: null },
    uTyreWrapArt: { value: null },
    uTyreWrapReady: { value: 0 },
    uTyreWrapTint: { value: tint },
    uTyreWrapCinturato: { value: 0 },
    uTyreWrapOuter: { value: outerSide },
  };
  let wanted: Rubber | null = null;
  let told = false;
  const setCompound = (c: TireCompound) => {
    tint.setHex(ART_COLORS[c]);
    uniforms.uTyreWrapCinturato.value = c === "intermediate" || c === "wet" ? 1 : 0;
    const rubber = rubberOf(c);
    // Once the textures could not be fetched the tyre has gone over to the sidewall for good: no fetch on every change
    if (told || rubber === wanted || typeof window === "undefined" || !HOSTED_CONTENT) return;
    wanted = rubber;
    // The tyre keeps the rubber it has until the new one is in
    void Promise.all([loadTexture(RUBBER_URL[rubber], THREE.SRGBColorSpace), loadTexture(ART_URL, THREE.NoColorSpace)]).then(
      ([rubberTex, artTex]) => {
        if (wanted !== rubber) return;
        if (!rubberTex || !artTex) {
          wanted = null;
          if (!told) onUnavailable?.();
          told = true;
          return;
        }
        uniforms.uTyreWrapRubber.value = rubberTex;
        uniforms.uTyreWrapArt.value = artTex;
        uniforms.uTyreWrapReady.value = 1;
      }
    );
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
          "#include <begin_vertex>\n\tvTyreWrapRest = position;\n\tvTyreWrapAcross = tyreAcross;"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAGMENT_DECL}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_BODY}`);
    },
  };
}
