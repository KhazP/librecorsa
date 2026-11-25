import * as THREE from 'three';

interface Pixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export type Rgba = readonly [number, number, number, number];

const MAX_BAKE_EDGE = 4096;
const MIN_LOOKUP_PIXELS = 256 * 1024;
const WHITE_COAT: Rgba = [255, 255, 255, 255];
const NO_DIFFUSE = new Uint8Array([255, 255, 255, 0]);

export function texturePixels(texture: THREE.Texture | null): Pixels | null {
  const image = texture?.image as
    | (Partial<Pixels> & { naturalWidth?: number; naturalHeight?: number })
    | undefined;
  const width = image?.naturalWidth || image?.width || 0;
  const height = image?.naturalHeight || image?.height || 0;
  if (!image || !width || !height) return null;
  if (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) {
    return image.data.length === width * height * 4 ? { data: image.data, width, height } : null;
  }
  if (texture instanceof THREE.CompressedTexture) return null;
  try {
    const scale = Math.min(1, MAX_BAKE_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!canvas) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  } catch {
    return null;
  }
}

function repeatIndex(size: number, u: number): number {
  return Math.min(size - 1, Math.floor((u - Math.floor(u)) * size));
}

function meanRgba({ data }: Pixels): Rgba {
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    a += data[i + 3];
  }
  const count = data.length / 4;
  return [r / count, g / count, b / count, a / count];
}

function constantCoat(layer: Pixels | null, tile: number): Rgba | null {
  if (!layer) return WHITE_COAT;
  // A finer pattern than the bake can resolve should contribute its mean, not an aliased texel.
  if (Math.max(layer.width, layer.height) * tile > 2 * MAX_BAKE_EDGE) return meanRgba(layer);
  const { data } = layer;
  const r = data[0], g = data[1], b = data[2], a = data[3];
  if (tile !== 0) {
    for (let i = 4; i < data.length; i += 4) {
      if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a) return null;
    }
  }
  return [r, g, b, a];
}

function shadeChannel(base: number, coat: number, mask: number, inverseMask: number, gain: number): number {
  return Math.min(255, Math.round(base * (coat * inverseMask + mask) * gain));
}

/** For a flat coat, the only variables are the byte of diffuse colour and its alpha mask. */
function flatChannelTable(coat: number, gain: number): Uint8Array {
  const table = new Uint8Array(256 * 256);
  for (let a = 0; a < 256; a++) {
    const mask = a / 255;
    for (let c = 0; c < 256; c++) {
      table[(a << 8) | c] = shadeChannel(c, coat, mask, 1 - mask, gain);
    }
  }
  return table;
}

/** A small transparent white placeholder carries no AO or usable coverage. */
function isNeutralDiffuse({ data }: Pixels): boolean {
  if (data.length > 16 * 16 * 4) return false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 0) return false;
  }
  return true;
}

export function rgbaTexture(
  name: string, data: Uint8Array, width: number, height: number,
): THREE.DataTexture {
  const result = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  result.name = name;
  result.flipY = false;
  result.colorSpace = THREE.SRGBColorSpace;
  result.generateMipmaps = true;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.needsUpdate = true;
  return result;
}

interface AlbedoLayers {
  diffuse: THREE.Texture | null;
  detail?: THREE.Texture | null;
  detailUv?: number;
  /** Static approximation of the author's light-response gain. */
  brightness?: number;
  /** Diffuse alpha is coverage only on materials that actually blend or test it. */
  preserveAlpha: boolean;
}

/**
 * Bake the AC multimap equation into a regular colour map: diffuse.rgb *
 * mix(detail.rgb, 1, diffuse.a), matching scripts/cars/port_ac_car.py.
 * Alpha on an opaque multimap protects the printed graphics from the detail,
 * not the mesh from drawing. Both the built-in livery and its variants use this.
 */
export function bakeAlbedo({
  diffuse, detail = null, detailUv = 1, brightness = 1, preserveAlpha,
}: AlbedoLayers): THREE.Texture | null {
  if (!detail && brightness === 1) return diffuse;
  const pixels = texturePixels(diffuse);
  const layer = texturePixels(detail);
  if (diffuse && !pixels) return diffuse;
  if (!layer && (!pixels || brightness === 1)) return diffuse;
  const base = pixels && layer && isNeutralDiffuse(pixels) ? null : pixels;
  const tile = Number.isFinite(detailUv) && detailUv >= 0 ? detailUv : 1;
  if (!base && detail && tile === 1 && brightness === 1) return detail;

  // Uniform detail (e.g. a paint tint) does not need to grow the diffuse atlas to the tiled size.
  const flat = constantCoat(layer, tile);
  const tiled = flat ? null : layer;
  const width = Math.min(MAX_BAKE_EDGE, Math.ceil(Math.max(base?.width ?? 1, tiled ? tiled.width * tile : 1)));
  const height = Math.min(MAX_BAKE_EDGE, Math.ceil(Math.max(base?.height ?? 1, tiled ? tiled.height * tile : 1)));
  const result = new Uint8Array(width * height * 4);
  const columns = (size: number, repeat: number) => {
    const offsets = new Int32Array(width);
    for (let x = 0; x < width; x++) offsets[x] = repeatIndex(size, (x + 0.5) * repeat / width) * 4;
    return offsets;
  };
  const baseWidth = base?.width ?? 1, baseHeight = base?.height ?? 1;
  const baseX = columns(baseWidth, 1);
  const baseData = base?.data ?? NO_DIFFUSE;
  const gain = Math.max(0, brightness) ** (1 / 2.2);
  if (flat && base && width * height >= MIN_LOOKUP_PIXELS) {
    const red = flatChannelTable(flat[0] / 255, gain);
    const green = flat[1] === flat[0] ? red : flatChannelTable(flat[1] / 255, gain);
    const blue = flat[2] === flat[0] ? red : flat[2] === flat[1] ? green : flatChannelTable(flat[2] / 255, gain);
    for (let y = 0, i = 0; y < height; y++) {
      const row = repeatIndex(baseHeight, (y + 0.5) / height) * baseWidth * 4;
      for (let x = 0; x < width; x++, i += 4) {
        const b = row + baseX[x];
        const a = baseData[b + 3];
        const mask = a << 8;
        result[i] = red[mask | baseData[b]];
        result[i + 1] = green[mask | baseData[b + 1]];
        result[i + 2] = blue[mask | baseData[b + 2]];
        result[i + 3] = preserveAlpha ? a : 255;
      }
    }
  } else {
    const coat = tiled?.data ?? flat ?? WHITE_COAT;
    const detailWidth = tiled?.width ?? 1, detailHeight = tiled?.height ?? 1;
    const detailX = columns(detailWidth, tile);
    for (let y = 0, i = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const baseRow = repeatIndex(baseHeight, v) * baseWidth * 4;
      const detailRow = repeatIndex(detailHeight, v * tile) * detailWidth * 4;
      for (let x = 0; x < width; x++, i += 4) {
        const b = baseRow + baseX[x], d = detailRow + detailX[x];
        const a = baseData[b + 3];
        const mask = a / 255, inverseMask = 1 - mask;
        result[i] = shadeChannel(baseData[b], coat[d] / 255, mask, inverseMask, gain);
        result[i + 1] = shadeChannel(baseData[b + 1], coat[d + 1] / 255, mask, inverseMask, gain);
        result[i + 2] = shadeChannel(baseData[b + 2], coat[d + 2] / 255, mask, inverseMask, gain);
        result[i + 3] = preserveAlpha ? (base ? a : coat[d + 3]) : 255;
      }
    }
  }
  return rgbaTexture(`${diffuse?.name || 'paint'}_baked`, result, width, height);
}

/** Raw RGBA DDS used by the ported rig's existing texture loader for a baked skin.
 * Keeping it uncompressed avoids an encode/decode through canvas (which also loses
 * RGB under transparent pixels). It is never written to IndexedDB. */
export function albedoDds(texture: THREE.Texture): ArrayBuffer | null {
  const pixels = texturePixels(texture);
  if (!pixels) return null;
  const bytes = new Uint8Array(128 + pixels.data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x20534444, true); // "DDS "
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x100f, true);
  view.setUint32(12, pixels.height, true);
  view.setUint32(16, pixels.width, true);
  view.setUint32(20, pixels.width * 4, true);
  view.setUint32(76, 32, true); // DDS_PIXELFORMAT
  view.setUint32(80, 0x41, true); // RGB with alpha
  view.setUint32(88, 32, true);
  view.setUint32(92, 0xff, true);
  view.setUint32(96, 0xff00, true);
  view.setUint32(100, 0xff0000, true);
  view.setUint32(104, 0xff000000, true);
  view.setUint32(108, 0x1000, true);
  bytes.set(pixels.data, 128);
  return bytes.buffer;
}
