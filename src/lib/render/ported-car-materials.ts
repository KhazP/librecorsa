import * as THREE from "three";
import { toPhysical } from "./to-physical";
import { applyMaskedMetallicFinish, applyPaintFinish, blueWeight, SATIN_CARBON, SATIN_PAINT } from "./paint-finish";

/**
 * Shading clean-up for ported Sketchfab cars (`ported-car-model.ts`).
 *
 * The exports carry values from their sim-mod origins that look wrong under real PBR: the R25 and RB8 bodies are
 * metalness 0.5-0.8 at roughness 0 (chrome), the BMW's tyres are 75% metallic, and any material without an explicit
 * metalness falls back to the glTF default of 1.0, so plastics, belts and details render as polished metal.
 *
 * Classes by material name (the exports keep descriptive names: `sf25_paints`, `mercedes_paint`, `WCCARBODY`,
 * `Carpaint`, `Body`, `*_tread`, `*carbon*`); a channel with its own texture keeps its authored values:
 * - paint: satin (paint-finish.ts), a matte dielectric base under a thin low-gloss coat, at full Fresnel reflectance
 *   (the exports' KHR_materials_specular values of 0.17-0.4 left the paint reflecting a third of what lacquer
 *   does). Any other material the export gave a clearcoat is a painted panel too (the SF71H's sides and wings).
 *   The RB22's blue is metallic, masked from its paint texture (the red, yellow and black on it stay satin);
 * - decals, numbers and colour layers: the paint's matte base;
 * - tyres: rubber, never metallic, rough;
 * - carbon: dielectric weave under a light satin coat;
 * - real metal (chrome, alloy, rims, discs, exhaust, mirrors): keeps its metalness, roughness at least 0.15
 *   except mirrors;
 * - everything else: dielectric (metalness 0), roughness at least 0.3.
 */

const PAINT = /paint|carbody|body|livery|skin/i;
const INTERIOR = /int_|interior|_in\b|cockpit|seat|belt|cinture/i;
const TYRE = /tyre|tire|tread|sidewall|rubber/i;
const CARBON = /carbon|carb|_cf\b|cockpit_cf/i;
const MIRROR = /mirror/i;
const METAL = /chrome|metal|allu|alu\b|alloy|exhaust|rim|hub|disc|disk|brake|caliper|calliper|spoke|titanium|steel/i;
const GLASS = /glass|windshield|windscreen|visor|clearled|led|lcd|light/i;
const DECAL = /decal|sticker|stiker|number|logo|colou?r/i;
/** Paints with metal flake, and which pixels of their colour texture carry it */
const METALLIC_PAINTS: readonly { name: RegExp; isMetal: (r: number, g: number, b: number) => number }[] = [
  { name: /^redbull_paint\b/i, isMetal: blueWeight },
];

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
  // Each map judged on its own channel (B for metal, G for roughness): glTF shares one texture between the two
  // slots, but a model with separate maps must not have its roughness decided by the metal map
  if (std.metalnessMap && placeholderChannels(std.metalnessMap).metal) {
    std.metalnessMap = null;
    std.metalness = 1;
  }
  if (std.roughnessMap && placeholderChannels(std.roughnessMap).rough) std.roughnessMap = null;
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
    // The exports' metallic paint tinted reflections with the base colour and darkened the diffuse, a silver cast
    // over the livery (issues #53, #54); their mirror clearcoat read as a road car's, not a race car's satin
    const p = toPhysical(std);
    const metallic = METALLIC_PAINTS.find((m) => m.name.test(name));
    if (!metallic || !applyMaskedMetallicFinish(p, metallic.isMetal)) applyPaintFinish(p, SATIN_PAINT);
    fullReflectance(p);
    out = p;
  } else if (CARBON.test(name)) {
    const p = toPhysical(std);
    applyPaintFinish(p, SATIN_CARBON);
    if (INTERIOR.test(name)) p.clearcoat = 0.1;
    fullReflectance(p);
    out = p;
  } else if ((std as THREE.MeshPhysicalMaterial).clearcoat > 0) {
    // Painted panels the names do not call paint (the SF71H's Sides, Front_Wing, Rear_Wing): the export's clearcoat
    // says lacquer, and its mirror finish made the car a chrome toy
    const p = std as THREE.MeshPhysicalMaterial;
    applyPaintFinish(p, SATIN_PAINT);
    fullReflectance(p);
  } else if (DECAL.test(name)) {
    if (!ownMetal) std.metalness = 0;
    if (!ownRough) std.roughness = Math.max(std.roughness, SATIN_PAINT.roughness);
  } else if (MIRROR.test(name)) {
    // a mirror face stays a mirror
  } else if (METAL.test(name)) {
    if (!ownRough) std.roughness = Math.max(std.roughness, 0.15);
  } else {
    // Not named as metal: decals, colour layers, plastics and fabric are dielectrics (the exports' 0.5-0.8 left the
    // sponsor colours greyed and silvery)
    if (!ownMetal) std.metalness = 0;
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
  if (/Paint_/i.test(name)) applyPaintFinish(p, SATIN_PAINT);
  p.needsUpdate = true;
}
