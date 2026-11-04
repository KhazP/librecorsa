import * as THREE from "three";

/**
 * Shading clean-up for ported Sketchfab cars (`ported-car-model.ts`).
 *
 * The exports carry values from their sim-mod origins that look wrong under real PBR: the R25 and RB8 bodies are
 * metalness 0.5-0.8 at roughness 0 (chrome), the BMW's tyres are 75% metallic, and any material without an explicit
 * metalness falls back to the glTF default of 1.0, so plastics, belts and details render as polished metal.
 *
 * Classes by material name (the exports keep descriptive names: `sf25_paints`, `mercedes_paint`, `WCCARBODY`,
 * `Carpaint`, `Body`, `*_tread`, `*carbon*`); a channel with its own texture keeps its authored values:
 * - paint: dielectric base under a glossy clearcoat, like a race car's lacquer, at full Fresnel reflectance (the
 *   exports' KHR_materials_specular values of 0.17-0.4 left the paint reflecting a third of what lacquer does);
 * - tyres: rubber, never metallic, rough;
 * - carbon: dielectric weave under a lighter clearcoat;
 * - real metal (chrome, alloy, rims, discs, exhaust, mirrors): keeps its metalness, roughness at least 0.15
 *   except mirrors;
 * - everything else: dielectric, roughness at least 0.3.
 */

const PAINT = /paint|carbody|body|livery|skin/i;
const INTERIOR = /int_|interior|_in\b|cockpit|seat|belt|cinture/i;
const TYRE = /tyre|tire|tread|sidewall|rubber/i;
const CARBON = /carbon|carb|_cf\b|cockpit_cf/i;
const MIRROR = /mirror/i;
const METAL = /chrome|metal|allu|alu\b|alloy|exhaust|rim|hub|disc|disk|brake|caliper|calliper|spoke|titanium|steel/i;
const GLASS = /glass|windshield|windscreen|visor|clearled|led|lcd|light/i;

const upgraded = new WeakMap<THREE.Material, THREE.Material>();
const flatChannels = new WeakMap<THREE.Texture, { rough: boolean; metal: boolean }>();

/**
 * Whether a metal / roughness map is a flat placeholder per channel (G roughness, B metal at ~1 everywhere): the
 * BMW's interior and exterior-detail maps are solid white, which makes the whole cockpit polished metal.
 */
function placeholderChannels(tex: THREE.Texture): { rough: boolean; metal: boolean } {
  const cached = flatChannels.get(tex);
  if (cached) return cached;
  let out = { rough: false, metal: false };
  const image = tex.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (typeof document !== "undefined" && image && image.width && image.height) {
    try {
      const size = 32;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(image, 0, 0, size, size);
        const px = ctx.getImageData(0, 0, size, size).data;
        let gMin = 255;
        let bMin = 255;
        for (let i = 0; i < px.length; i += 4) {
          gMin = Math.min(gMin, px[i + 1]);
          bMin = Math.min(bMin, px[i + 2]);
        }
        out = { rough: gMin > 240, metal: bMin > 240 };
      }
    } catch {
      // unreadable image: keep it
    }
  }
  flatChannels.set(tex, out);
  return out;
}

function toPhysical(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  if ((src as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return src as THREE.MeshPhysicalMaterial;
  const dst = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(dst, src);
  // MeshStandardMaterial.copy() resets the defines to STANDARD only
  dst.defines = { STANDARD: "", PHYSICAL: "" };
  return dst;
}

/** Dielectric F0 of 4 % (specular 1, white): what lacquer and resin reflect, unless a map says otherwise */
export function fullReflectance(p: THREE.MeshPhysicalMaterial): void {
  if (!p.specularIntensityMap) p.specularIntensity = 1;
  if (!p.specularColorMap) p.specularColor.setRGB(1, 1, 1);
}

/** Anisotropic filtering on every map of a material, not only the colour map: normal and roughness detail stays sharp at grazing angles */
export function sharpenCarMaps(mat: THREE.Material, anisotropy = 8): void {
  for (const v of Object.values(mat)) {
    if (v instanceof THREE.Texture && v.anisotropy < anisotropy) {
      v.anisotropy = anisotropy;
      v.needsUpdate = true;
    }
  }
}

/** The cleaned-up material (shared: a source material used by several meshes maps to one result) */
export function cleanPortedCarMaterial(mat: THREE.Material): THREE.Material {
  const done = upgraded.get(mat);
  if (done) return done;
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return mat;
  const name = mat.name ?? "";
  // a solid-white placeholder map says nothing: drop it and fall back to the rules below
  const mr = std.metalnessMap ?? std.roughnessMap;
  if (mr) {
    const flat = placeholderChannels(mr);
    if (flat.metal && std.metalnessMap) {
      std.metalnessMap = null;
      std.metalness = 1;
    }
    if (flat.rough && std.roughnessMap) std.roughnessMap = null;
  }
  const ownMetal = !!std.metalnessMap;
  const ownRough = !!std.roughnessMap;
  let out: THREE.Material = mat;

  if (GLASS.test(name)) {
    // lights, screens and glass keep their look; only the metal default goes
    if (!ownMetal && std.metalness > 0.99) std.metalness = 0;
  } else if (TYRE.test(name)) {
    if (!ownMetal) std.metalness = 0;
    if (!ownRough) std.roughness = Math.max(std.roughness, 0.75);
  } else if (PAINT.test(name) && !INTERIOR.test(name)) {
    const p = toPhysical(std);
    if (!ownMetal) p.metalness = Math.min(p.metalness, 0.15);
    if (!ownRough) p.roughness = Math.min(Math.max(p.roughness, 0.3), 0.45);
    fullReflectance(p);
    p.clearcoat = 1;
    p.clearcoatRoughness = 0.04;
    out = p;
  } else if (CARBON.test(name)) {
    const p = toPhysical(std);
    if (!ownMetal) p.metalness = 0;
    if (!ownRough) p.roughness = Math.max(p.roughness, 0.35);
    fullReflectance(p);
    p.clearcoat = INTERIOR.test(name) ? 0.2 : 0.6;
    p.clearcoatRoughness = 0.12;
    out = p;
  } else if (MIRROR.test(name)) {
    // a mirror face stays a mirror
  } else if (METAL.test(name)) {
    if (!ownRough) std.roughness = Math.max(std.roughness, 0.15);
  } else {
    if (!ownMetal) std.metalness = std.metalness > 0.99 ? 0 : Math.min(std.metalness, 0.2);
    if (!ownRough) std.roughness = Math.max(std.roughness, 0.3);
  }
  // The exports' KHR_materials_specular dims every dielectric part to a fraction of a real F0; glass keeps its own
  if ((out as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial && !GLASS.test(name)) fullReflectance(out as THREE.MeshPhysicalMaterial);
  out.needsUpdate = true;
  upgraded.set(mat, out);
  return out;
}

/**
 * The stock AMG GT3 model's materials, which skip the name rules above (they would flatten its metal grilles): every
 * part but the glass at full reflectance, and the paint under a glossy clearcoat
 */
export function cleanGt3Material(mat: THREE.Material): void {
  const p = mat as THREE.MeshPhysicalMaterial;
  if (!p.isMeshPhysicalMaterial) return;
  const name = mat.name ?? "";
  if (GLASS.test(name) || /glass|glaaass|glss|window/i.test(name)) return;
  fullReflectance(p);
  if (/Paint_/i.test(name)) {
    p.clearcoat = 1;
    p.clearcoatRoughness = 0.04;
  }
  p.needsUpdate = true;
}
