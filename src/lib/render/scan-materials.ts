import * as THREE from "three";
import { applyGroundDetail } from "./ground-detail";
import { leafShading } from "./leaf-shading";

/**
 * Material clean-up for the scanned circuits (`Track_Model`, Sketchfab exports converted by build_track.py).
 *
 * The scans' materials come out of a sim-mod → 3ds Max → Sketchfab → glTF chain and often carry values no real
 * surface has: Monza's main asphalt is roughness 0.0 (a mirror that reflects the sky as a pale blue glare), its
 * darker asphalt metalness 0.5, and Yas Marina's merged atlas leaves metalness unset (glTF default 1.0). Almost
 * every alpha card is exported as BLEND, so thousands of overlapping leaves are depth-sorted per mesh rather than
 * per leaf and far ones show through near ones, and some fully opaque billboards are blended for no reason.
 *
 * Rules (a channel with its own texture keeps its authored values):
 * - metalness 0, except names that say metal (barriers, fences, posts), capped at 0.6;
 * - roughness at least 0.65; named ground (asphalt, grass, kerbs, gravel, concrete, paint) at least 0.8;
 * - a blended material whose own opacity is 1 is classified by its texture's alpha (most names are generic, e.g.
 *   `Sepang691Mtl_4`): an opaque texture → opaque; mostly hard-edged alpha (foliage, crowds, signs) → alpha-tested
 *   cut-out that writes depth; soft alpha (baked shadows, gradients, glass) stays blended.
 * - an alpha-tested, double-sided card (the converted circuits' trees, bushes, crowds and railings) gets the leaf
 *   shading (leaf-shading.ts): its own normal from both sides, matte, and its coverage kept at a distance.
 * - a converted circuit's ground with `extras.groundDetail` gets its detail texture as a world-tiled layer
 *   (ground-detail.ts).
 */

const METAL = /metal|steel|chrome|armco|rail|guard|post|pole|truss/i;
const GROUND = /asph|apsh|road|tarmac|grass|gras|terrain|ground|curb|kerb|cord|gravel|sand|concrete|runoff/i;

/** Blended texels (alpha between these) that make a texture "soft" rather than a cut-out */
const SOFT_LO = 0.15;
const SOFT_HI = 0.85;
/** At most this share of the transparent texels may be soft for a cut-out */
const MAX_SOFT_SHARE = 0.45;
/** At least this share of the visible texels must survive a 0.5 cut for a cut-out (else it would vanish) */
const MIN_KEPT_SHARE = 0.5;
const SAMPLE_PX = 128;

type AlphaKind = "opaque" | "cutout" | "soft";

const cleaned = new WeakSet<THREE.Material>();
const alphaKinds = new WeakMap<THREE.Texture, AlphaKind>();

function alphaKind(tex: THREE.Texture): AlphaKind {
  const cached = alphaKinds.get(tex);
  if (cached) return cached;
  let kind: AlphaKind = "soft";
  const image = tex.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (typeof document !== "undefined" && image && image.width && image.height) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SAMPLE_PX;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(image, 0, 0, SAMPLE_PX, SAMPLE_PX);
        const px = ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data;
        let transparent = 0;
        let soft = 0;
        let visible = 0;
        let kept = 0;
        for (let i = 3; i < px.length; i += 4) {
          const a = px[i] / 255;
          if (a < 0.95) transparent++;
          if (a > SOFT_LO && a < SOFT_HI) soft++;
          if (a > 0.02) visible++;
          if (a >= 0.5) kept++;
        }
        if (transparent === 0) kind = "opaque";
        else if (soft / transparent <= MAX_SOFT_SHARE && kept / Math.max(visible, 1) >= MIN_KEPT_SHARE) kind = "cutout";
      }
    } catch {
      // unreadable image (tainted canvas): leave it blended
    }
  }
  alphaKinds.set(tex, kind);
  return kind;
}

export function cleanScanMaterial(mat: THREE.Material): void {
  if (cleaned.has(mat)) return;
  cleaned.add(mat);
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return;
  const name = mat.name ?? "";

  if (!std.metalnessMap) std.metalness = METAL.test(name) ? Math.min(std.metalness, 0.6) : 0;
  if (!std.roughnessMap) std.roughness = Math.max(std.roughness, GROUND.test(name) ? 0.8 : 0.65);

  if (std.transparent && std.map && std.opacity >= 0.99) {
    const kind = alphaKind(std.map);
    if (kind === "opaque") {
      std.transparent = false;
      std.depthWrite = true;
    } else if (kind === "cutout") {
      std.transparent = false;
      std.alphaTest = Math.max(std.alphaTest, 0.5);
      std.depthWrite = true;
    }
  }
  if (std.alphaTest > 0 && std.side === THREE.DoubleSide) leafShading(std);
  applyGroundDetail(std);
  std.needsUpdate = true;
}
