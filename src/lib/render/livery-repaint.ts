import * as THREE from "three";
import type { LiveryConfig } from "@/types/f1";

/**
 * Livery repaint for car models that ship an authored colour texture (no livery mask).
 *
 * The model's paint texture is classified once against its factory colours (`PaintKeys`): every texel near the
 * segment between two key colours (an anti-aliased edge or a flat area, where both ends are the same key) is
 * stored as (key a, key b, blend t, residual). A livery then repaints those texels with its own colours, keeping
 * the residual so subtle shading in the artwork (embossed flags, gradients) survives. Texels far from every key
 * (white roundels, sponsor logos, small colour blocks) keep their authored colour.
 *
 * Repainted textures and materials are cached per source and livery colours, so a grid of cars shares at most
 * one material per livery.
 */

/** Factory colours of a paint texture (sRGB CSS colours), mapped to the livery slot that replaces each one */
export interface PaintKeys {
  primary: string[];
  secondary?: string[];
  accent?: string[];
}

/** Largest distance (0..255 sRGB) from a key segment that still counts as paint */
const PAINT_TOLERANCE = 34;
const KEEP = 255;

interface PaintAnalysis {
  width: number;
  height: number;
  /** Original RGBA pixels */
  pixels: Uint8ClampedArray;
  /** Per texel: livery slot of each segment end (0 primary, 1 secondary, 2 accent, KEEP = authored colour) */
  slotA: Uint8Array;
  slotB: Uint8Array;
  /** Blend from end a to end b, 0..255 */
  blend: Uint8Array;
  /** Texel minus its projection on the key segment, per channel */
  residual: Int16Array;
}

const analyses = new WeakMap<THREE.Texture, PaintAnalysis | null>();
const repainted = new WeakMap<THREE.Texture, Map<string, THREE.Texture>>();
const materials = new WeakMap<THREE.Material, Map<string, THREE.Material>>();

function hexBytes(css: string): [number, number, number] {
  // getHex() is sRGB (the Color itself holds linear components)
  const hex = new THREE.Color(css).getHex();
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function readPixels(image: unknown): { width: number; height: number; pixels: Uint8ClampedArray } | null {
  if (typeof document === "undefined" || !image) return null;
  const src = image as CanvasImageSource & { width: number; height: number };
  if (!src.width || !src.height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0);
    return { width: src.width, height: src.height, pixels: ctx.getImageData(0, 0, src.width, src.height).data };
  } catch {
    return null;
  }
}

function analyse(texture: THREE.Texture, keys: PaintKeys): PaintAnalysis | null {
  if (analyses.has(texture)) return analyses.get(texture) ?? null;
  const read = readPixels(texture.image);
  if (!read) {
    analyses.set(texture, null);
    return null;
  }
  const keyColours: { rgb: [number, number, number]; slot: number }[] = [];
  (["primary", "secondary", "accent"] as const).forEach((name, slot) => {
    for (const css of keys[name] ?? []) keyColours.push({ rgb: hexBytes(css), slot });
  });
  // Segments between every pair of keys, plus each key on its own
  const segments: { a: number; b: number }[] = [];
  for (let i = 0; i < keyColours.length; i++) {
    for (let j = i; j < keyColours.length; j++) segments.push({ a: i, b: j });
  }

  const { width, height, pixels } = read;
  const n = width * height;
  const slotA = new Uint8Array(n).fill(KEEP);
  const slotB = new Uint8Array(n).fill(KEEP);
  const blend = new Uint8Array(n);
  const residual = new Int16Array(n * 3);
  const tol2 = PAINT_TOLERANCE * PAINT_TOLERANCE;

  for (let p = 0; p < n; p++) {
    const r = pixels[p * 4], g = pixels[p * 4 + 1], b = pixels[p * 4 + 2];
    let best = tol2;
    let bestSeg = -1;
    let bestT = 0;
    for (let s = 0; s < segments.length; s++) {
      const ka = keyColours[segments[s].a].rgb;
      const kb = keyColours[segments[s].b].rgb;
      const dr = kb[0] - ka[0], dg = kb[1] - ka[1], db = kb[2] - ka[2];
      const len2 = dr * dr + dg * dg + db * db;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((r - ka[0]) * dr + (g - ka[1]) * dg + (b - ka[2]) * db) / len2)) : 0;
      const er = r - (ka[0] + dr * t), eg = g - (ka[1] + dg * t), eb = b - (ka[2] + db * t);
      const d2 = er * er + eg * eg + eb * eb;
      if (d2 < best) {
        best = d2;
        bestSeg = s;
        bestT = t;
      }
    }
    if (bestSeg < 0) continue;
    const ka = keyColours[segments[bestSeg].a];
    const kb = keyColours[segments[bestSeg].b];
    slotA[p] = ka.slot;
    slotB[p] = kb.slot;
    blend[p] = Math.round(bestT * 255);
    residual[p * 3] = r - Math.round(ka.rgb[0] + (kb.rgb[0] - ka.rgb[0]) * bestT);
    residual[p * 3 + 1] = g - Math.round(ka.rgb[1] + (kb.rgb[1] - ka.rgb[1]) * bestT);
    residual[p * 3 + 2] = b - Math.round(ka.rgb[2] + (kb.rgb[2] - ka.rgb[2]) * bestT);
  }
  const out: PaintAnalysis = { width, height, pixels, slotA, slotB, blend, residual };
  analyses.set(texture, out);
  return out;
}

function liveryKey(livery: LiveryConfig): string {
  return `${livery.primary}|${livery.secondary}|${livery.accent}`;
}

/** The paint texture repainted in the livery's colours, or null when the texture cannot be read (no DOM, CORS) */
export function repaintTexture(texture: THREE.Texture, keys: PaintKeys, livery: LiveryConfig): THREE.Texture | null {
  const key = liveryKey(livery);
  let cache = repainted.get(texture);
  const cached = cache?.get(key);
  if (cached) return cached;
  const a = analyse(texture, keys);
  if (!a) return null;

  const slots = [hexBytes(livery.primary), hexBytes(livery.secondary), hexBytes(livery.accent)];
  const canvas = document.createElement("canvas");
  canvas.width = a.width;
  canvas.height = a.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(a.width, a.height);
  const px = img.data;
  px.set(a.pixels);
  for (let p = 0, n = a.width * a.height; p < n; p++) {
    if (a.slotA[p] === KEEP) continue;
    const ca = slots[a.slotA[p]];
    const cb = slots[a.slotB[p]];
    const t = a.blend[p] / 255;
    for (let c = 0; c < 3; c++) px[p * 4 + c] = ca[c] + (cb[c] - ca[c]) * t + a.residual[p * 3 + c];
  }
  ctx.putImageData(img, 0, 0);

  const out = new THREE.CanvasTexture(canvas);
  out.name = `${texture.name || "paint"}_${livery.id}`;
  out.flipY = texture.flipY;
  out.colorSpace = texture.colorSpace;
  out.wrapS = texture.wrapS;
  out.wrapT = texture.wrapT;
  out.magFilter = texture.magFilter;
  out.minFilter = texture.minFilter;
  out.anisotropy = texture.anisotropy;
  out.channel = texture.channel;
  out.offset.copy(texture.offset);
  out.repeat.copy(texture.repeat);
  out.rotation = texture.rotation;
  out.center.copy(texture.center);
  out.matrixAutoUpdate = texture.matrixAutoUpdate;
  out.matrix.copy(texture.matrix);
  if (!cache) {
    cache = new Map();
    repainted.set(texture, cache);
  }
  cache.set(key, out);
  return out;
}

/**
 * A copy of `base` whose colour map is repainted in the livery, shared by every mesh and car that asks for the
 * same base and colours. Shader hooks (`onBeforeCompile`, program cache key) carry over. Returns `base` itself
 * when it has no map or the map cannot be repainted.
 */
export function liveryMaterial<M extends THREE.Material & { map: THREE.Texture | null }>(
  base: M,
  keys: PaintKeys,
  livery: LiveryConfig
): M {
  if (!base.map) return base;
  const key = liveryKey(livery);
  let cache = materials.get(base);
  const cached = cache?.get(key);
  if (cached) return cached as M;
  const map = repaintTexture(base.map, keys, livery);
  if (!map) return base;
  const out = base.clone() as M;
  out.onBeforeCompile = base.onBeforeCompile;
  out.customProgramCacheKey = base.customProgramCacheKey;
  out.map = map;
  if (!cache) {
    cache = new Map();
    materials.set(base, cache);
  }
  cache.set(key, out);
  return out;
}

/** Paint meshes of a car instance: each slot remembers its factory material so liveries never stack */
export interface PaintSlot {
  mesh: THREE.Mesh;
  index: number | null;
  base: THREE.Material & { map: THREE.Texture | null };
}

/** Collects every mesh slot in `root` whose material passes `isPaint` */
export function collectPaintSlots(root: THREE.Object3D, isPaint: (m: THREE.Material) => boolean): PaintSlot[] {
  const slots: PaintSlot[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m, index) => {
        if (isPaint(m)) slots.push({ mesh, index, base: m as PaintSlot["base"] });
      });
    } else if (isPaint(mesh.material)) {
      slots.push({ mesh, index: null, base: mesh.material as PaintSlot["base"] });
    }
  });
  return slots;
}

/** Repaints every slot in the livery's colours */
export function applyLivery(slots: readonly PaintSlot[], keys: PaintKeys, livery: LiveryConfig): void {
  for (const slot of slots) {
    const m = liveryMaterial(slot.base, keys, livery);
    if (slot.index === null) slot.mesh.material = m;
    else (slot.mesh.material as THREE.Material[])[slot.index] = m;
  }
}
