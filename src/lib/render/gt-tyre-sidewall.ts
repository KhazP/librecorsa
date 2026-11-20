/**
 * GT / prototype / classic racing tyre sidewalls from sagatron918's six RSS GT-M Tyre Extension packs (used with
 * permission, see CREDITS.md; textures ported by `scripts/cars/port_sagatron_tyres.py`).
 *
 * Each brand is a full-colour sRGB planar disc centred on the axle (lossless WebP), with an optional wet disc where
 * the pack carries distinct wet branding (Goodyear Eagle Wet, Bridgestone Potenza Wet, Falken Wet). Projected from
 * the tyre's mesh-local position just like `pirelli-sidewall.ts`, so it fits every car regardless of its tyre UVs and
 * spins with the rubber:
 *  - radius: the mesh's shoulder lands on `GT_SIDEWALL_TEX_SHOULDER` and the bead on `GT_SIDEWALL_TEX_RIM`, keeping
 *    uniform scale on tall-sidewall classic tyres so lettering is never stretched radially;
 *  - side: u is mirrored on the −X face so lettering reads upright from outside on both sides of the car;
 *  - faces only: weighted by the rest normal's axle component, leaving the tread with the model's own map.
 *
 * Gated by both `HOSTED_CONTENT` (the WebPs live in the librecorsa-assets R2 bucket, not in the git repo) and
 * `!isStoreBuild()` (leaves third-party tyre brand logos out of the Google Play TWA). Without them the tyres keep
 * their model's own sidewall.
 */
import * as THREE from "three";
import type { TireCompound } from "@/types/f1";
import type { CarClassId, CarId } from "@/lib/cars/car-registry";
import { withBasePath } from "@/lib/base-path";
import { HOSTED_CONTENT } from "@/lib/hosted-content";
import { isStoreBuild } from "@/lib/store-mode";
import { sidewallBand } from "./pirelli-sidewall";

export type GtTyreBrand = "pirelli" | "michelin" | "goodyear" | "bridgestone" | "yokohama" | "falken";

export const GT_TYRE_BRANDS: readonly GtTyreBrand[] = [
  "pirelli",
  "michelin",
  "goodyear",
  "bridgestone",
  "yokohama",
  "falken",
];

export interface GtTyrePackInfo {
  readonly brand: GtTyreBrand;
  readonly label: string;
  readonly url: string;
  /** Distinct wet sidewall disc when the pack ships one with readable wet branding */
  readonly wetUrl?: string;
}

const GT_TYRE_DIR = "/cars/shared/tyres/gt/";

export const GT_TYRE_PACKS: Readonly<Record<GtTyreBrand, GtTyrePackInfo>> = {
  pirelli: {
    brand: "pirelli",
    label: "Pirelli P ZERO",
    url: `${GT_TYRE_DIR}pirelli-sidewall.webp`,
  },
  michelin: {
    brand: "michelin",
    label: "Michelin Pilot Sport",
    url: `${GT_TYRE_DIR}michelin-sidewall.webp`,
  },
  goodyear: {
    brand: "goodyear",
    label: "Goodyear Eagle",
    url: `${GT_TYRE_DIR}goodyear-sidewall.webp`,
    wetUrl: `${GT_TYRE_DIR}goodyear-wet-sidewall.webp`,
  },
  bridgestone: {
    brand: "bridgestone",
    label: "Bridgestone Potenza",
    url: `${GT_TYRE_DIR}bridgestone-sidewall.webp`,
    wetUrl: `${GT_TYRE_DIR}bridgestone-wet-sidewall.webp`,
  },
  yokohama: {
    brand: "yokohama",
    label: "Yokohama ADVAN",
    url: `${GT_TYRE_DIR}yokohama-sidewall.webp`,
  },
  falken: {
    brand: "falken",
    label: "Falken",
    url: `${GT_TYRE_DIR}falken-sidewall.webp`,
    wetUrl: `${GT_TYRE_DIR}falken-wet-sidewall.webp`,
  },
};

/**
 * Default GT tyre pack per non-F1 car: covers all 6 brands authentically across GT3, endurance prototypes,
 * Japanese touring/JGTC classics, and historic GT racers. Street cars keep their own plain road tyres.
 */
export const DEFAULT_CAR_GT_TYRE_BRAND: Readonly<Partial<Record<CarId, GtTyreBrand>>> = {
  "amg-gt3": "pirelli",
  "bmw-m4-gt3": "goodyear",
  "lc-lmdh": "michelin",
  "mtr-496r": "michelin",
  "nissan-r33-jgtc": "bridgestone",
  "nissan-r32-jtcc": "yokohama",
  "porsche-934-rsr": "falken",
  "bmw-m1-procar": "goodyear",
  "chaparral-2d": "goodyear",
  "chaparral-2d-67": "goodyear",
};

/** Where the rim seat and sidewall shoulder sit in every ported GT disc (mirrors `port_sagatron_tyres.py`) */
export const GT_SIDEWALL_TEX_RIM = 0.66;
export const GT_SIDEWALL_TEX_SHOULDER = 0.9;

const isWetCompound = (c: TireCompound): boolean => c === "intermediate" || c === "wet";

/** Parses a brand name (e.g. from a setting or query parameter), returning null if unrecognised */
export function resolveGtTyreBrand(value: string | null | undefined): GtTyreBrand | null {
  if (!value) return null;
  const key = value.trim().toLowerCase() as GtTyreBrand;
  return key in GT_TYRE_PACKS ? key : null;
}

/** Picks the default GT tyre sidewall brand for a car (null for F1 and street/road cars) */
export function defaultGtTyreBrand(carId: CarId | string, classId?: CarClassId): GtTyreBrand | null {
  if (classId === "f1" || classId === "road") return null;
  const mapped = DEFAULT_CAR_GT_TYRE_BRAND[carId as CarId];
  if (mapped) return mapped;
  if (classId === "gt3") return "pirelli";
  if (classId === "proto") return "michelin";
  if (classId === "classic") return "goodyear";
  return null;
}

/** Whether third-party GT tyre sidewalls may be fetched in this runtime */
export function canLoadGtTyreSidewall(): boolean {
  return typeof window !== "undefined" && HOSTED_CONTENT && !isStoreBuild();
}

interface TextureSlot {
  texture: THREE.Texture | null;
  loading: boolean;
  listeners: Set<() => void>;
}

const textureCache = new Map<string, TextureSlot>();

function getSlot(url: string): TextureSlot {
  let slot = textureCache.get(url);
  if (!slot) {
    slot = { texture: null, loading: false, listeners: new Set() };
    textureCache.set(url, slot);
  }
  return slot;
}

/** Fetches a GT sidewall disc once and notifies any subscribed tyre shaders when it arrives */
export function loadGtSidewallTexture(url: string): TextureSlot {
  const slot = getSlot(url);
  if (slot.texture || slot.loading || !canLoadGtTyreSidewall()) return slot;
  slot.loading = true;
  new THREE.TextureLoader().load(
    withBasePath(url),
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      slot.texture = tex;
      slot.loading = false;
      for (const cb of slot.listeners) cb();
    },
    undefined,
    () => {
      // Without the texture the tyre keeps the model's own sidewall
      slot.loading = false;
    }
  );
  return slot;
}

const VERTEX_DECL = /* glsl */ `
varying vec3 vGtSwRest;
varying float vGtSwAxleN;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec3 vGtSwRest;
varying float vGtSwAxleN;
uniform sampler2D uGtSwMap;
uniform float uGtSwReady;
uniform vec3 uGtSwFit;
`;

const FRAGMENT_BODY = /* glsl */ `
{
  float gtSwR = length(vGtSwRest.yz);
  float gtSwT = clamp(uGtSwFit.y + (gtSwR - uGtSwFit.x) * uGtSwFit.z, 0.0, 0.98);
  vec2 gtSwDir = vGtSwRest.yz / max(gtSwR, 1e-5);
  float gtSwSide = vGtSwRest.x >= 0.0 ? 1.0 : -1.0;
  vec2 gtSwUv = 0.5 + 0.5 * gtSwT * vec2(-gtSwSide * gtSwDir.y, gtSwDir.x);
  vec3 gtSwColor = texture2D(uGtSwMap, gtSwUv).rgb;
  float gtSwFace = smoothstep(0.55, 0.8, abs(vGtSwAxleN)) * uGtSwReady;
  diffuseColor.rgb = mix(diffuseColor.rgb, gtSwColor, gtSwFace);
}
`;

export interface GtTyreSidewallPatch {
  readonly uniforms: Record<string, THREE.IUniform>;
  /** Adds the GT sidewall to a tyre material's shaders (call from its onBeforeCompile) */
  patch(shader: THREE.WebGLProgramParametersWithUniforms): void;
  setCompound(compound: TireCompound): void;
  setBrand(brand: GtTyreBrand): void;
  dispose(): void;
}

/**
 * The GT sidewall patch for one tyre mesh: fits itself to the mesh's bead/shoulder radii and shares cached brand
 * textures across all four wheels and opponents.
 */
export function createGtTyreSidewall(
  geometry: THREE.BufferGeometry,
  initialBrand: GtTyreBrand,
  initialCompound: TireCompound = "medium"
): GtTyreSidewallPatch {
  const { beadM, shoulderM } = sidewallBand(geometry);
  const texPerM = Math.max(
    (GT_SIDEWALL_TEX_SHOULDER - GT_SIDEWALL_TEX_RIM) / (shoulderM - beadM),
    GT_SIDEWALL_TEX_SHOULDER / shoulderM
  );
  const mapUniform: THREE.IUniform<THREE.Texture | null> = { value: null };
  const readyUniform: THREE.IUniform<number> = { value: 0 };
  const uniforms: Record<string, THREE.IUniform> = {
    uGtSwMap: mapUniform,
    uGtSwReady: readyUniform,
    uGtSwFit: { value: new THREE.Vector3(shoulderM, GT_SIDEWALL_TEX_SHOULDER, texPerM) },
  };

  let brand: GtTyreBrand = initialBrand;
  let wet = isWetCompound(initialCompound);
  const subscribed = new Set<TextureSlot>();

  const sync = () => {
    const pack = GT_TYRE_PACKS[brand];
    const primaryUrl = wet && pack.wetUrl ? pack.wetUrl : pack.url;
    const primary = loadGtSidewallTexture(primaryUrl);
    if (primary.texture) {
      mapUniform.value = primary.texture;
      readyUniform.value = 1;
      return;
    }
    // While a wet disc is still loading, keep the brand's slick disc visible rather than flashing bare rubber
    if (primaryUrl !== pack.url) {
      const fallback = loadGtSidewallTexture(pack.url);
      if (fallback.texture) {
        mapUniform.value = fallback.texture;
        readyUniform.value = 1;
        return;
      }
    }
    readyUniform.value = 0;
  };

  const subscribe = (url: string) => {
    const slot = loadGtSidewallTexture(url);
    if (!subscribed.has(slot)) {
      slot.listeners.add(sync);
      subscribed.add(slot);
    }
  };

  const attachCurrent = () => {
    const pack = GT_TYRE_PACKS[brand];
    subscribe(pack.url);
    if (wet && pack.wetUrl) subscribe(pack.wetUrl);
    sync();
  };

  attachCurrent();

  return {
    uniforms,
    setCompound(compound) {
      const nextWet = isWetCompound(compound);
      if (nextWet === wet) return;
      wet = nextWet;
      attachCurrent();
    },
    setBrand(nextBrand) {
      if (nextBrand === brand) return;
      brand = nextBrand;
      attachCurrent();
    },
    patch(shader) {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_DECL}`)
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n\tvGtSwRest = position;\n\tvGtSwAxleN = normal.x;"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAGMENT_DECL}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_BODY}`);
    },
    dispose() {
      for (const slot of subscribed) slot.listeners.delete(sync);
      subscribed.clear();
    },
  };
}
