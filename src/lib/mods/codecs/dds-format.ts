const DDS_MAGIC = 0x20534444;
const FOURCC_DX10 = 0x30315844;
const MAX_TEXTURE_EDGE = 8192;
const MAX_TEXTURE_PIXELS = 32 * 1024 * 1024;
const DDSD_PITCH = 0x8;
const DDPF_ALPHA_PIXELS = 0x1;
const DDPF_ALPHA = 0x2;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;

type BlockFormat = 'bc1' | 'bc2' | 'bc3' | 'bc4' | 'bc5' | 'bc7';
type Masks = readonly [number, number, number, number];

const LEGACY_BLOCKS: Readonly<Partial<Record<number, BlockFormat>>> = {
  0x31545844: 'bc1', // DXT1
  0x33545844: 'bc2', // DXT3
  0x35545844: 'bc3', // DXT5
  0x31495441: 'bc4', // ATI1
  0x55344342: 'bc4', // BC4U
  0x32495441: 'bc5', // ATI2
  0x55354342: 'bc5', // BC5U
};

const DXGI_BLOCKS: Readonly<Partial<Record<number, BlockFormat>>> = {
  70: 'bc1', 71: 'bc1', 72: 'bc1',
  73: 'bc2', 74: 'bc2', 75: 'bc2',
  76: 'bc3', 77: 'bc3', 78: 'bc3',
  79: 'bc4', 80: 'bc4',
  82: 'bc5', 83: 'bc5',
  97: 'bc7', 98: 'bc7', 99: 'bc7',
};

const RGBA: Masks = [0xff, 0xff00, 0xff0000, 0xff000000];
const BGRA: Masks = [0xff0000, 0xff00, 0xff, 0xff000000];
const BGRX: Masks = [0xff0000, 0xff00, 0xff, 0];
const DXGI_PIXELS: Readonly<Partial<Record<number, Masks>>> = {
  28: RGBA, 29: RGBA, 87: BGRA, 91: BGRA, 88: BGRX, 93: BGRX,
};

interface Surface {
  width: number;
  height: number;
  offset: number;
}

interface PixelSurface extends Surface {
  format: 'pixels';
  stride: number;
  pixelBytes: number;
  masks: Masks;
}

type DdsSurface = (Surface & { format: BlockFormat }) | PixelSurface;

export function isDds(data: Uint8Array): boolean {
  return data[0] === 0x44 && data[1] === 0x44 && data[2] === 0x53 && data[3] === 0x20;
}

function channelShift(mask: number): number {
  return mask ? 31 - Math.clz32(mask & -mask) : 0;
}

function validMasks(masks: Masks, bits: number): boolean {
  for (const mask of masks) {
    const shifted = mask >>> channelShift(mask);
    if (mask >= 2 ** bits || ((shifted + 1) & shifted) !== 0) return false;
  }
  // Repeated RGB masks are intentional for luminance. Alpha never overlaps colour.
  return (masks[3] & (masks[0] | masks[1] | masks[2])) === 0;
}

function legacyMasks(view: DataView, flags: number): Masks | undefined {
  const alpha = flags & (DDPF_ALPHA_PIXELS | DDPF_ALPHA) ? view.getUint32(104, true) : 0;
  const r = view.getUint32(92, true);
  if (flags & DDPF_LUMINANCE) return r ? [r, r, r, alpha] : undefined;
  if (flags & DDPF_RGB) {
    const g = view.getUint32(96, true), b = view.getUint32(100, true);
    if (!r || !g || !b || (r & g) || (g & b) || (r & b)) return undefined;
    return [r, g, b, alpha];
  }
  if (flags & DDPF_ALPHA && alpha) return [0, 0, 0, alpha];
  return undefined;
}

/** Validate the 2D top mip before allocating output or calling any decoder. */
export function readDdsSurface(data: Uint8Array): DdsSurface | null {
  if (data.length < 128) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const uint = (offset: number) => view.getUint32(offset, true);
  if (uint(0) !== DDS_MAGIC || uint(4) !== 124 || uint(76) !== 32) return null;
  const width = uint(16), height = uint(12);
  if (!width || !height || Math.max(width, height) > MAX_TEXTURE_EDGE || width * height > MAX_TEXTURE_PIXELS) return null;
  if (uint(112) & 0x20fe00) return null; // volume/cube

  const flags = uint(80);
  const fourCC = flags & DDPF_FOURCC ? uint(84) : 0;
  let offset = 128;
  let format: BlockFormat | undefined;
  let masks: Masks | undefined;
  let bits: number;
  if (fourCC === FOURCC_DX10) {
    offset = 148;
    if (data.length < offset || uint(132) !== 3 || uint(136) & 4 || uint(140) !== 1) return null;
    format = DXGI_BLOCKS[uint(128)];
    masks = DXGI_PIXELS[uint(128)];
    bits = 32;
  } else {
    format = LEGACY_BLOCKS[fourCC];
    masks = fourCC ? undefined : legacyMasks(view, flags);
    bits = uint(88);
  }
  if (format) {
    const bytesPerBlock = format === 'bc1' || format === 'bc4' ? 8 : 16;
    if (offset + Math.ceil(width / 4) * Math.ceil(height / 4) * bytesPerBlock > data.length) return null;
    return { format, width, height, offset };
  }
  if (!masks || ![8, 16, 24, 32].includes(bits) || !validMasks(masks, bits)) return null;
  const pixelBytes = bits / 8;
  const packedRow = width * pixelBytes;
  const stride = uint(8) & DDSD_PITCH ? Math.max(packedRow, uint(20)) : packedRow;
  if (offset + stride * (height - 1) + packedRow > data.length) return null;
  return { format: 'pixels', width, height, offset, stride, pixelBytes, masks };
}

export function decodeDdsPixels(data: Uint8Array, surface: PixelSurface): Uint8Array {
  const { width, height, offset, stride, pixelBytes, masks } = surface;
  const length = width * height * 4;
  if (stride === width * 4 && masks.every((mask, i) => mask === RGBA[i])) {
    const raw = data.subarray(offset, offset + length);
    // Synthetic skins can use their own buffer directly; do not retain a whole KN5 for one texture.
    return data.byteLength === data.buffer.byteLength ? raw : new Uint8Array(raw);
  }

  const result = new Uint8Array(length);
  if (pixelBytes === 2 && masks[0] === 0xff && masks[1] === 0xff && masks[2] === 0xff && masks[3] === 0xff00) {
    // L8A8 AO atlases share one luminance byte, with a separate paint or coverage mask.
    for (let y = 0, dst = 0; y < height; y++) {
      const row = offset + y * stride;
      const end = row + width * 2;
      for (let src = row; src < end; src += 2, dst += 4) {
        result[dst] = result[dst + 1] = result[dst + 2] = data[src];
        result[dst + 3] = data[src + 1];
      }
    }
    return result;
  }
  const shifts = masks.map(channelShift);
  const scales = masks.map((mask, i) => mask ? 255 / (mask >>> shifts[i]) : 0);
  for (let y = 0, dst = 0; y < height; y++) {
    let src = offset + y * stride;
    for (let x = 0; x < width; x++, src += pixelBytes) {
      const packed = data[src]
        | (pixelBytes >= 2 ? data[src + 1] << 8 : 0)
        | (pixelBytes >= 3 ? data[src + 2] << 16 : 0)
        | (pixelBytes === 4 ? data[src + 3] << 24 : 0);
      for (let c = 0; c < 4; c++) {
        result[dst++] = masks[c] ? Math.round(((packed & masks[c]) >>> shifts[c]) * scales[c]) : 255;
      }
    }
  }
  return result;
}
