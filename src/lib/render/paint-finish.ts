import * as THREE from "three";

/**
 * Car paint finishes. Race liveries are mostly satin: a matte base under a thin, low-gloss coat that only shows a
 * soft sheen at grazing angles, not the mirror clearcoat of a road car. A metallic paint (the RB22's blue) is the
 * exception: metal flake under a fuller coat.
 */
export interface PaintFinish {
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
}

export const SATIN_PAINT: PaintFinish = { metalness: 0, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.3 };

/** Satin carbon: the weave reads through a light coat */
export const SATIN_CARBON: PaintFinish = { metalness: 0, roughness: 0.45, clearcoat: 0.2, clearcoatRoughness: 0.3 };

export const METALLIC_PAINT: PaintFinish = { metalness: 0.5, roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.2 };

/** Sets a finish on a physical material, keeping any channel the material has its own map for */
export function applyPaintFinish(p: THREE.MeshPhysicalMaterial, finish: PaintFinish): void {
  if (!p.metalnessMap) p.metalness = finish.metalness;
  if (!p.roughnessMap) p.roughness = finish.roughness;
  p.clearcoat = finish.clearcoat;
  p.clearcoatRoughness = finish.clearcoatRoughness;
  p.clearcoatMap = null;
  p.clearcoatRoughnessMap = null;
}

/**
 * A livery whose one colour texture mixes a metallic paint with satin ones (the RB22: metallic navy blue beside
 * matte red, yellow and black). Builds a map from the colour texture that is `metal` where `isMetal` weighs a pixel
 * (0-1, sRGB 0-255 input) and satin elsewhere: R clearcoat, G roughness, B metalness (glTF's channels; three reads
 * clearcoat from R). Returns false when the texture cannot be read; the material is then left satin.
 */
export function applyMaskedMetallicFinish(
  p: THREE.MeshPhysicalMaterial,
  isMetal: (r: number, g: number, b: number) => number,
  metal: PaintFinish = METALLIC_PAINT,
  satin: PaintFinish = SATIN_PAINT
): boolean {
  const map = p.map;
  const image = map?.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (!map || typeof document === "undefined" || !image?.width || !image.height) return false;
  const w = Math.min(image.width, 1024);
  const h = Math.min(image.height, 1024);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  let px: Uint8ClampedArray;
  try {
    ctx.drawImage(image, 0, 0, w, h);
    px = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return false;
  }
  const out = ctx.createImageData(w, h);
  const o = out.data;
  const lerp = (a: number, b: number, t: number) => Math.round(255 * (a + (b - a) * t));
  for (let i = 0; i < px.length; i += 4) {
    const t = isMetal(px[i], px[i + 1], px[i + 2]);
    o[i] = lerp(satin.clearcoat, metal.clearcoat, t);
    o[i + 1] = lerp(satin.roughness, metal.roughness, t);
    o[i + 2] = lerp(satin.metalness, metal.metalness, t);
    o[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // Same sampling as the colour map it was read from (glTF textures are not flipped)
  tex.flipY = map.flipY;
  tex.wrapS = map.wrapS;
  tex.wrapT = map.wrapT;
  tex.channel = map.channel;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  p.metalnessMap = tex;
  p.roughnessMap = tex;
  p.clearcoatMap = tex;
  p.metalness = 1;
  p.roughness = 1;
  p.clearcoat = 1;
  // One coat roughness for both: the map has no spare channel three reads it from
  p.clearcoatRoughness = metal.clearcoatRoughness;
  p.clearcoatRoughnessMap = null;
  p.needsUpdate = true;
  return true;
}

/** Weight of a navy / royal blue pixel (sRGB 0-255): blue above red and green (the RB22's navy is about 0, 0, 40) */
export function blueWeight(r: number, g: number, b: number): number {
  return THREE.MathUtils.smoothstep((b - Math.max(r, g)) / 255, 0.03, 0.09);
}
