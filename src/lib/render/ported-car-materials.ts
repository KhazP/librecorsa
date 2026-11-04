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
 * - paint: dielectric base under a glossy clearcoat, like a race car's lacquer;
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

function toPhysical(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  if ((src as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return src as THREE.MeshPhysicalMaterial;
  const dst = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(dst, src);
  // MeshStandardMaterial.copy() resets the defines to STANDARD only
  dst.defines = { STANDARD: "", PHYSICAL: "" };
  return dst;
}

/** The cleaned-up material (shared: a source material used by several meshes maps to one result) */
export function cleanPortedCarMaterial(mat: THREE.Material): THREE.Material {
  const done = upgraded.get(mat);
  if (done) return done;
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return mat;
  const name = mat.name ?? "";
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
    p.clearcoat = 1;
    p.clearcoatRoughness = 0.06;
    out = p;
  } else if (CARBON.test(name)) {
    const p = toPhysical(std);
    if (!ownMetal) p.metalness = 0;
    if (!ownRough) p.roughness = Math.max(p.roughness, 0.35);
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
  out.needsUpdate = true;
  upgraded.set(mat, out);
  return out;
}
