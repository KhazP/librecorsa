/**
 * Binary parser and Three.js scene builder for Assetto Corsa `.kn5` 3D car models.
 * Reconstructs the hierarchy into LibreCorsa's required rig:
 *   CAR (extras: wheelCentres, tyreRadius, tyreHalfWidth, wheelbaseM, trackWidthM, cameras)
 *     BODY (sprung body, cockpit, glass, brake calipers)
 *     STEER (steering wheel pivot and meshes)
 *     WHEEL_LF, WHEEL_RF, WHEEL_LR, WHEEL_RR (wheel hubs with RIM and TYRE sub-meshes)
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { cleanPortedCarMaterial, sharpenCarMaps } from '@/lib/render/ported-car-materials';
import { rgbaTexture } from './ac-albedo';
import type { AcCameraLayout, AcCameraPose } from './ac-cameras';
import { decodeBC7 } from './codecs/bc7-wasm';
import { decodeDdsPixels, isDds, readDdsSurface } from './codecs/dds-format';
import {
  isGlassMaterial,
  loadBaseTextures,
  loadBaseTexturesAsync,
  planKn5Appearance,
  type Kn5Appearance,
  type Kn5AppearanceOptions,
} from './kn5-appearance';
import { hasCspKn5Footer, ProtectedKn5Error } from './kn5-protection';

export interface Kn5Texture {
  type: number;
  name: string;
  data: Uint8Array;
}

export interface Kn5Material {
  name: string;
  shader: string;
  blend: number;
  alphaTested: boolean;
  props: Record<string, number>;
  maps: Record<string, string>;
}

export interface Kn5Mesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  materialIndex: number;
  visible: boolean;
  transparent: boolean;
  renderable: boolean;
  castShadow: boolean;
}

export interface Kn5Node {
  name: string;
  kind: number; // 1 = transform dummy, 2 = static mesh, 3 = skinned mesh
  active: boolean;
  matrix: THREE.Matrix4; // local transform
  worldMatrix: THREE.Matrix4; // accumulated world transform
  parent: number | null;
  mesh?: Kn5Mesh;
  children: number[];
}

export interface Kn5Model {
  version: number;
  textures: Map<string, Kn5Texture>;
  materials: Kn5Material[];
  nodes: Kn5Node[];
}

class ByteReader {
  private view: DataView;
  private dataBytes: Uint8Array;
  public offset = 0;

  constructor(buffer: ArrayBuffer | ArrayBufferView) {
    if (ArrayBuffer.isView(buffer)) {
      this.dataBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      this.dataBytes = new Uint8Array(buffer);
      this.view = new DataView(buffer);
    }
  }

  take(n: number): Uint8Array {
    const slice = this.dataBytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  f32(n = 1): Float32Array {
    const bytes = 4 * n;
    const slice = this.dataBytes.buffer.slice(
      this.dataBytes.byteOffset + this.offset,
      this.dataBytes.byteOffset + this.offset + bytes
    );
    this.offset += bytes;
    return new Float32Array(slice);
  }

  str(): string {
    const len = this.i32();
    if (len <= 0) return '';
    const slice = this.take(len);
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  }
}

/**
 * Parses a raw .kn5 binary file into structured textures, materials and nodes.
 */
export function parseKn5(data: ArrayBuffer | Uint8Array, fileName?: string): Kn5Model {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const r = new ByteReader(bytes);

  const magic = String.fromCharCode(...r.take(6));
  if (magic !== 'sc6969') {
    throw new Error('Invalid KN5 file: magic header sc6969 missing');
  }
  if (hasCspKn5Footer(bytes)) throw new ProtectedKn5Error(fileName);

  const version = r.i32();
  if (version > 5) {
    r.i32(); // Extra header word in newer KN5 versions
  }

  // 1. Textures
  const textureCount = r.i32();
  const textures = new Map<string, Kn5Texture>();
  for (let i = 0; i < textureCount; i++) {
    const type = r.i32();
    if (type === 0) {
      // Type 0 is an empty / unassigned texture slot in KN5
      continue;
    }
    const name = r.str();
    const byteLen = r.i32();
    const bytes = r.take(byteLen);
    textures.set(name.toLowerCase(), { type, name, data: bytes });
  }

  // 2. Materials
  const materialCount = r.i32();
  const materials: Kn5Material[] = [];
  for (let i = 0; i < materialCount; i++) {
    const name = r.str();
    const shader = r.str();
    const blend = r.readU8();
    const alphaTested = Boolean(r.readU8());
    r.i32(); // skip

    const propCount = r.i32();
    const props: Record<string, number> = {};
    for (let p = 0; p < propCount; p++) {
      const pname = r.str();
      const val = r.f32(1)[0];
      r.f32(9); // skip 9 floats
      props[pname] = val;
    }

    const mapCount = r.i32();
    const maps: Record<string, string> = {};
    for (let m = 0; m < mapCount; m++) {
      const slot = r.str();
      r.i32(); // skip
      const texName = r.str();
      maps[slot] = texName;
    }

    materials.push({ name, shader, blend, alphaTested, props, maps });
  }

  // 3. Node Hierarchy
  const nodes: Kn5Node[] = [];

  function parseNode(parentMatrix: THREE.Matrix4, parentActive: boolean, parentIdx: number | null): number {
    const kind = r.i32();
    const name = r.str();
    const nchild = r.i32();
    const active = Boolean(r.readU8()) && parentActive;

    let localMatrix = new THREE.Matrix4().identity();
    let worldMatrix = parentMatrix.clone();
    let mesh: Kn5Mesh | undefined;

    if (kind === 1) {
      const f = r.f32(16);
      localMatrix.fromArray(f);
      worldMatrix.multiply(localMatrix);
    } else if (kind === 2 || kind === 3) {
      const castShadow = Boolean(r.readU8());
      const visible = Boolean(r.readU8());
      const transparent = Boolean(r.readU8());

      if (kind === 3) {
        const boneCount = r.i32();
        for (let b = 0; b < boneCount; b++) {
          r.str();
          r.take(64);
        }
      }

      const vertCount = r.i32();
      const stride = kind === 2 ? 44 : 76;
      const rawVerts = r.f32((vertCount * stride) / 4);

      const positions = new Float32Array(vertCount * 3);
      const normals = new Float32Array(vertCount * 3);
      const uvs = new Float32Array(vertCount * 2);

      const floatsPerVert = stride / 4;
      for (let v = 0; v < vertCount; v++) {
        const base = v * floatsPerVert;
        positions[v * 3] = rawVerts[base];
        positions[v * 3 + 1] = rawVerts[base + 1];
        positions[v * 3 + 2] = rawVerts[base + 2];

        normals[v * 3] = rawVerts[base + 3];
        normals[v * 3 + 1] = rawVerts[base + 4];
        normals[v * 3 + 2] = rawVerts[base + 5];

        uvs[v * 2] = rawVerts[base + 6];
        uvs[v * 2 + 1] = rawVerts[base + 7];
      }

      const indexCount = r.i32();
      const rawIndices = r.take(indexCount * 2);
      const indices = new Uint16Array(
        rawIndices.buffer.slice(rawIndices.byteOffset, rawIndices.byteOffset + indexCount * 2)
      );

      const materialIndex = r.i32();
      r.i32(); // lod
      r.take(8);

      let renderable = true;
      if (kind === 2) {
        r.take(16);
        renderable = Boolean(r.readU8());
      }

      mesh = {
        positions,
        normals,
        uvs,
        indices,
        materialIndex,
        visible,
        transparent,
        renderable,
        castShadow,
      };
    }

    const currentIdx = nodes.length;
    const node: Kn5Node = {
      name,
      kind,
      active,
      matrix: localMatrix,
      worldMatrix,
      parent: parentIdx,
      mesh,
      children: [],
    };
    nodes.push(node);

    for (let c = 0; c < nchild; c++) {
      const childIdx = parseNode(worldMatrix, active, currentIdx);
      node.children.push(childIdx);
    }

    return currentIdx;
  }

  parseNode(new THREE.Matrix4().identity(), true, null);

  return { version, textures, materials, nodes };
}

// ---------------------------------------------------------------------------
// Software BC / DXT Decoders for 100% Universal WebGL Compatibility
// ---------------------------------------------------------------------------

function decodeBC1(src: Uint8Array, offset: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcPos = offset;
  const c = new Uint8Array(16);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (srcPos + 8 > src.length) break;
      const c0 = src[srcPos] | (src[srcPos + 1] << 8);
      const c1 = src[srcPos + 2] | (src[srcPos + 3] << 8);

      c[0] = (((c0 >> 11) & 31) * 255 / 31) | 0;
      c[1] = (((c0 >> 5) & 63) * 255 / 63) | 0;
      c[2] = ((c0 & 31) * 255 / 31) | 0;
      c[3] = 255;

      c[4] = (((c1 >> 11) & 31) * 255 / 31) | 0;
      c[5] = (((c1 >> 5) & 63) * 255 / 63) | 0;
      c[6] = ((c1 & 31) * 255 / 31) | 0;
      c[7] = 255;

      if (c0 > c1) {
        c[8] = ((2 * c[0] + c[4]) / 3) | 0;
        c[9] = ((2 * c[1] + c[5]) / 3) | 0;
        c[10] = ((2 * c[2] + c[6]) / 3) | 0;
        c[11] = 255;

        c[12] = ((c[0] + 2 * c[4]) / 3) | 0;
        c[13] = ((c[1] + 2 * c[5]) / 3) | 0;
        c[14] = ((c[2] + 2 * c[6]) / 3) | 0;
        c[15] = 255;
      } else {
        c[8] = ((c[0] + c[4]) / 2) | 0;
        c[9] = ((c[1] + c[5]) / 2) | 0;
        c[10] = ((c[2] + c[6]) / 2) | 0;
        c[11] = 255;

        c[12] = 0;
        c[13] = 0;
        c[14] = 0;
        c[15] = 0;
      }

      const cBits = src[srcPos + 4] | (src[srcPos + 5] << 8) | (src[srcPos + 6] << 16) | (src[srcPos + 7] << 24);
      srcPos += 8;

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) break;
          const pIdx = py * 4 + px;
          const cIdx = (cBits >> (pIdx * 2)) & 3;
          const dstIdx = (y * width + x) * 4;
          out[dstIdx] = c[cIdx * 4];
          out[dstIdx + 1] = c[cIdx * 4 + 1];
          out[dstIdx + 2] = c[cIdx * 4 + 2];
          out[dstIdx + 3] = c[cIdx * 4 + 3];
        }
      }
    }
  }
  return out;
}

function decodeBC2(src: Uint8Array, offset: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcPos = offset;
  const c = new Uint8Array(16);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (srcPos + 16 > src.length) break;
      const a0 = src[srcPos] | (src[srcPos + 1] << 8);
      const a1 = src[srcPos + 2] | (src[srcPos + 3] << 8);
      const a2 = src[srcPos + 4] | (src[srcPos + 5] << 8);
      const a3 = src[srcPos + 6] | (src[srcPos + 7] << 8);

      const c0 = src[srcPos + 8] | (src[srcPos + 9] << 8);
      const c1 = src[srcPos + 10] | (src[srcPos + 11] << 8);

      c[0] = (((c0 >> 11) & 31) * 255 / 31) | 0;
      c[1] = (((c0 >> 5) & 63) * 255 / 63) | 0;
      c[2] = ((c0 & 31) * 255 / 31) | 0;

      c[4] = (((c1 >> 11) & 31) * 255 / 31) | 0;
      c[5] = (((c1 >> 5) & 63) * 255 / 63) | 0;
      c[6] = ((c1 & 31) * 255 / 31) | 0;

      c[8] = ((2 * c[0] + c[4]) / 3) | 0;
      c[9] = ((2 * c[1] + c[5]) / 3) | 0;
      c[10] = ((2 * c[2] + c[6]) / 3) | 0;

      c[12] = ((c[0] + 2 * c[4]) / 3) | 0;
      c[13] = ((c[1] + 2 * c[5]) / 3) | 0;
      c[14] = ((c[2] + 2 * c[6]) / 3) | 0;

      const cBits = src[srcPos + 12] | (src[srcPos + 13] << 8) | (src[srcPos + 14] << 16) | (src[srcPos + 15] << 24);
      srcPos += 16;

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        const aRow = py === 0 ? a0 : py === 1 ? a1 : py === 2 ? a2 : a3;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) break;
          const pIdx = py * 4 + px;
          const cIdx = (cBits >> (pIdx * 2)) & 3;
          const aVal = (((aRow >> (px * 4)) & 15) * 255 / 15) | 0;
          const dstIdx = (y * width + x) * 4;
          out[dstIdx] = c[cIdx * 4];
          out[dstIdx + 1] = c[cIdx * 4 + 1];
          out[dstIdx + 2] = c[cIdx * 4 + 2];
          out[dstIdx + 3] = aVal;
        }
      }
    }
  }
  return out;
}

function decodeBC3(src: Uint8Array, offset: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcPos = offset;
  const c = new Uint8Array(16);
  const a = new Uint8Array(8);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (srcPos + 16 > src.length) break;
      const a0 = src[srcPos];
      const a1 = src[srcPos + 1];
      a[0] = a0;
      a[1] = a1;

      if (a0 > a1) {
        a[2] = ((6 * a0 + 1 * a1) / 7) | 0;
        a[3] = ((5 * a0 + 2 * a1) / 7) | 0;
        a[4] = ((4 * a0 + 3 * a1) / 7) | 0;
        a[5] = ((3 * a0 + 4 * a1) / 7) | 0;
        a[6] = ((2 * a0 + 5 * a1) / 7) | 0;
        a[7] = ((1 * a0 + 6 * a1) / 7) | 0;
      } else {
        a[2] = ((4 * a0 + 1 * a1) / 5) | 0;
        a[3] = ((3 * a0 + 2 * a1) / 5) | 0;
        a[4] = ((2 * a0 + 3 * a1) / 5) | 0;
        a[5] = ((1 * a0 + 4 * a1) / 5) | 0;
        a[6] = 0;
        a[7] = 255;
      }
      const aBits0 = src[srcPos + 2] | (src[srcPos + 3] << 8) | (src[srcPos + 4] << 16);
      const aBits1 = src[srcPos + 5] | (src[srcPos + 6] << 8) | (src[srcPos + 7] << 16);

      const c0 = src[srcPos + 8] | (src[srcPos + 9] << 8);
      const c1 = src[srcPos + 10] | (src[srcPos + 11] << 8);

      c[0] = (((c0 >> 11) & 31) * 255 / 31) | 0;
      c[1] = (((c0 >> 5) & 63) * 255 / 63) | 0;
      c[2] = ((c0 & 31) * 255 / 31) | 0;

      c[4] = (((c1 >> 11) & 31) * 255 / 31) | 0;
      c[5] = (((c1 >> 5) & 63) * 255 / 63) | 0;
      c[6] = ((c1 & 31) * 255 / 31) | 0;

      c[8] = ((2 * c[0] + c[4]) / 3) | 0;
      c[9] = ((2 * c[1] + c[5]) / 3) | 0;
      c[10] = ((2 * c[2] + c[6]) / 3) | 0;

      c[12] = ((c[0] + 2 * c[4]) / 3) | 0;
      c[13] = ((c[1] + 2 * c[5]) / 3) | 0;
      c[14] = ((c[2] + 2 * c[6]) / 3) | 0;

      const cBits = src[srcPos + 12] | (src[srcPos + 13] << 8) | (src[srcPos + 14] << 16) | (src[srcPos + 15] << 24);
      srcPos += 16;

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) break;
          const pIdx = py * 4 + px;
          const cIdx = (cBits >> (pIdx * 2)) & 3;
          const aIdx = pIdx < 8 ? (aBits0 >> (pIdx * 3)) & 7 : (aBits1 >> ((pIdx - 8) * 3)) & 7;
          const dstIdx = (y * width + x) * 4;
          out[dstIdx] = c[cIdx * 4];
          out[dstIdx + 1] = c[cIdx * 4 + 1];
          out[dstIdx + 2] = c[cIdx * 4 + 2];
          out[dstIdx + 3] = a[aIdx];
        }
      }
    }
  }

  return out;
}

function fillBcChannelTable(table: Uint8Array, v0: number, v1: number): void {
  table[0] = v0;
  table[1] = v1;
  if (v0 > v1) {
    table[2] = ((6 * v0 + 1 * v1) / 7) | 0;
    table[3] = ((5 * v0 + 2 * v1) / 7) | 0;
    table[4] = ((4 * v0 + 3 * v1) / 7) | 0;
    table[5] = ((3 * v0 + 4 * v1) / 7) | 0;
    table[6] = ((2 * v0 + 5 * v1) / 7) | 0;
    table[7] = ((1 * v0 + 6 * v1) / 7) | 0;
  } else {
    table[2] = ((4 * v0 + 1 * v1) / 5) | 0;
    table[3] = ((3 * v0 + 2 * v1) / 5) | 0;
    table[4] = ((2 * v0 + 3 * v1) / 5) | 0;
    table[5] = ((1 * v0 + 4 * v1) / 5) | 0;
    table[6] = 0;
    table[7] = 255;
  }
}

function decodeBC4(src: Uint8Array, offset: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcPos = offset;
  const r = new Uint8Array(8);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (srcPos + 8 > src.length) break;
      fillBcChannelTable(r, src[srcPos], src[srcPos + 1]);
      const rBits0 = src[srcPos + 2] | (src[srcPos + 3] << 8) | (src[srcPos + 4] << 16);
      const rBits1 = src[srcPos + 5] | (src[srcPos + 6] << 8) | (src[srcPos + 7] << 16);
      srcPos += 8;

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) break;
          const pIdx = py * 4 + px;
          const rIdx = pIdx < 8 ? (rBits0 >> (pIdx * 3)) & 7 : (rBits1 >> ((pIdx - 8) * 3)) & 7;
          const dstIdx = (y * width + x) * 4;
          const val = r[rIdx];
          out[dstIdx] = val;
          out[dstIdx + 1] = val;
          out[dstIdx + 2] = val;
          out[dstIdx + 3] = 255;
        }
      }
    }
  }
  return out;
}

function decodeBC5(src: Uint8Array, offset: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  let srcPos = offset;
  const r = new Uint8Array(8);
  const g = new Uint8Array(8);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (srcPos + 16 > src.length) break;
      fillBcChannelTable(r, src[srcPos], src[srcPos + 1]);
      const rBits0 = src[srcPos + 2] | (src[srcPos + 3] << 8) | (src[srcPos + 4] << 16);
      const rBits1 = src[srcPos + 5] | (src[srcPos + 6] << 8) | (src[srcPos + 7] << 16);

      fillBcChannelTable(g, src[srcPos + 8], src[srcPos + 9]);
      const gBits0 = src[srcPos + 10] | (src[srcPos + 11] << 8) | (src[srcPos + 12] << 16);
      const gBits1 = src[srcPos + 13] | (src[srcPos + 14] << 8) | (src[srcPos + 15] << 16);
      srcPos += 16;

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) break;
          const pIdx = py * 4 + px;
          const rIdx = pIdx < 8 ? (rBits0 >> (pIdx * 3)) & 7 : (rBits1 >> ((pIdx - 8) * 3)) & 7;
          const gIdx = pIdx < 8 ? (gBits0 >> (pIdx * 3)) & 7 : (gBits1 >> ((pIdx - 8) * 3)) & 7;
          const dstIdx = (y * width + x) * 4;
          const redVal = r[rIdx];
          const grnVal = g[gIdx];
          // Normal map: reconstruct Z from X and Y
          const nx = (redVal / 127.5) - 1.0;
          const ny = (grnVal / 127.5) - 1.0;
          const nzSq = Math.max(0, 1.0 - nx * nx - ny * ny);
          const bluVal = Math.round((Math.sqrt(nzSq) + 1.0) * 127.5);
          out[dstIdx] = redVal;
          out[dstIdx + 1] = grnVal;
          out[dstIdx + 2] = bluVal;
          out[dstIdx + 3] = 255;
        }
      }
    }
  }
  return out;
}

const blockDecoders = { bc1: decodeBC1, bc2: decodeBC2, bc3: decodeBC3, bc4: decodeBC4, bc5: decodeBC5, bc7: decodeBC7 };

function parseDdsTexture(name: string, data: Uint8Array): THREE.Texture | null {
  const surface = readDdsSurface(data);
  if (!surface) return null;
  const { format, offset, width, height } = surface;
  const pixels = format === 'pixels'
    ? decodeDdsPixels(data, surface)
    : blockDecoders[format](data, offset, width, height);
  if (!pixels) return null;
  const texture = rgbaTexture(name, pixels, width, height);
  if (format === 'bc5' || /_nm\b|normal|_n\b/i.test(name)) texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/**
 * Creates a Three.js texture from a browser Blob URL.
 */
function createImageTexture(name: string, data: Uint8Array, mime: string): THREE.Texture | null {
  if (typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  const image = new Image();
  const texture = imageTexture(name, image);
  image.onload = () => {
    texture.needsUpdate = true;
    URL.revokeObjectURL(url);
  };
  image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
  return texture;
}

function imageTexture(name: string, image: HTMLImageElement | ImageBitmap): THREE.Texture {
  const texture = new THREE.Texture(image);
  texture.name = name;
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** AC loose textures sometimes contain a differently named file format. */
function imageMime(data: Uint8Array): string | null {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/** Await real image decoding so a corrupt loose override can fall back to KN5. */
export async function createTextureAsync(name: string, data: Uint8Array): Promise<THREE.Texture | null> {
  if (isDds(data)) return parseDdsTexture(name, data);
  const mime = imageMime(data);
  if (!mime) return null;
  const blob = new Blob([data as BlobPart], { type: mime });
  if (typeof createImageBitmap !== 'undefined') {
    try {
      return imageTexture(name, await createImageBitmap(blob, { premultiplyAlpha: 'none' }));
    } catch {
      // Older browsers can still decode via an HTML image.
    }
  }
  if (typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(imageTexture(name, image));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

/** The synchronous path is used for DDS and simple tools; use the async scene builder for browser images. */
export function createTexture(name: string, data: Uint8Array): THREE.Texture | null {
  if (isDds(data)) return parseDdsTexture(name, data);
  const mime = imageMime(data);
  return mime ? createImageTexture(name, data, mime) : null;
}

const CORNER_NAMES = ['LF', 'RF', 'LR', 'RR'] as const;
type CornerName = (typeof CORNER_NAMES)[number];

interface ClassifiedMesh {
  kind: 'body' | 'steer' | 'tyre' | 'rim' | 'skip';
  corner?: CornerName;
  nodeIndex: number;
  materialIndex: number;
  positions: Float32Array; // in world coordinates
  normals: Float32Array;   // in world coordinates
  uvs: Float32Array;
  indices: Uint16Array;
}

/** Some bike-shaped AC mods use a four-corner physics setup, but only two
 * visible, untagged wheels. Their dummy names can put both on the rear axle. */
function findCenterlineWheels(nodes: Kn5Node[], meshes: ClassifiedMesh[]) {
  // Trust the actual pivot ancestry, not the part's label: the front wheel
  // can have LF-named parts beneath the dummy named WHEEL_RR.
  const partsByPivot = new Map<number, ClassifiedMesh[]>();
  for (const mesh of meshes) {
    if (!mesh.corner) continue;
    let parent = nodes[mesh.nodeIndex].parent;
    while (parent !== null && !(nodes[parent].kind === 1 && /^WHEEL_[LR][FR]$/i.test(nodes[parent].name))) {
      parent = nodes[parent].parent;
    }
    if (parent === null) return undefined;
    const parts = partsByPivot.get(parent);
    if (parts) parts.push(mesh);
    else partsByPivot.set(parent, [mesh]);
  }
  if (partsByPivot.size !== 2) return undefined;

  const wheels = [...partsByPivot].flatMap(([index, parts]) => {
    const pivot = nodes[index];
    const centre = new THREE.Vector3().setFromMatrixPosition(pivot.worldMatrix);
    if (!centre.toArray().every(Number.isFinite) || Math.abs(centre.x) > 0.2) return [];
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const { positions } of parts) {
      for (let i = 0; i < positions.length; i += 3) bounds.expandByPoint(point.fromArray(positions, i));
    }
    if (!bounds.containsPoint(centre)) return [];
    const radius = centre.y - bounds.min.y;
    const halfWidth = (bounds.max.x - bounds.min.x) / 2;
    if (!(radius >= 0.15 && radius <= 0.6 && halfWidth > 0 && halfWidth <= 0.2)) return [];
    return [{ centre, radius, halfWidth, parts, groundY: bounds.min.y }];
  }).sort((a, b) => b.centre.z - a.centre.z);

  const [front, rear] = wheels;
  if (!front || !rear || front.centre.z - rear.centre.z < 0.7 ||
    Math.abs(front.centre.x - rear.centre.x) > 0.15) return undefined;
  return { front, rear };
}

/**
 * Traverses parent nodes to inspect ancestry.
 */
function getAncestors(nodes: Kn5Node[], idx: number): string[] {
  const result: string[] = [];
  let curr = nodes[idx].parent;
  while (curr !== null) {
    result.push(nodes[curr].name);
    curr = nodes[curr].parent;
  }
  return result;
}

export interface BuildKn5SceneOptions extends Kn5AppearanceOptions {
  revLeds?: unknown;
  cameras?: AcCameraLayout;
  appearance?: Kn5Appearance;
  skinMaps?: Record<string, string>;
  baseSkinIndex?: number;
}

/** Decode the initial livery and its material slots before assembling the rig. */
export async function buildKn5SceneAsync(
  kn5: Kn5Model,
  options?: BuildKn5SceneOptions
): Promise<THREE.Group> {
  const appearance = options?.appearance ?? planKn5Appearance(kn5, options);
  const textures = await loadBaseTexturesAsync(appearance, createTextureAsync, options?.baseSkinIndex);
  return assembleKn5Scene(kn5, appearance, textures, options);
}

/** Synchronous rig construction for tools that use embedded DDS textures. */
export function buildKn5Scene(
  kn5: Kn5Model,
  options?: BuildKn5SceneOptions
): THREE.Group {
  const appearance = options?.appearance ?? planKn5Appearance(kn5, options);
  return assembleKn5Scene(kn5, appearance, loadBaseTextures(appearance, createTexture), options);
}

function assembleKn5Scene(
  kn5: Kn5Model,
  appearance: Kn5Appearance,
  textures: ReturnType<typeof loadBaseTextures>,
  options?: BuildKn5SceneOptions,
): THREE.Group {

  const threeMaterials = appearance.surfaces.map(({ name, material: m, looks: [look] }, index) => {
    const { map, normal } = textures[index];
    const diffName = m.maps['txDiffuse'] || m.maps['txDiffuse0'];
    const isPaintOrBody = /paint|carbody|body|livery|skin|chassis|hood|wing|plate/i.test(m.name);
    const isGlass = isGlassMaterial(m);
    const isTyre = m.shader.toLowerCase().includes('tyre') || /tyre|tire/i.test(m.name);
    const roughnessExp = m.props['ksSpecularEXP'] ?? 20;
    const rough = Math.min(0.95, Math.max(0.08, (2.0 / (roughnessExp + 2.0)) ** 0.25));
    const isMetalName = /chrome|metal|allu|alu\b|alloy|exhaust|rim|hub|disc|disk|brake|caliper|spoke|titanium|steel/i.test(m.name);
    const isMetal = isMetalName && !isPaintOrBody && !isTyre && !isGlass;
    const isWingOrDecal = /wing|flap|decal|banner|plate|mesh|foil/i.test(m.name);
    const alphaTested = look.alphaMode === 'test';
    const transparent = look.alphaMode === 'blend';
    const isDecalMat = alphaTested || /decal|banner|badge|logo|sponsor|overlay/i.test(m.name);
    const isTopDecal = /add_decal|number|driver|badge|logo|sponsor/i.test(m.name);
    const isCarbon =
      !isDecalMat &&
      (/carbon|carb\b|_cf\b/i.test(m.name) || /carbon/i.test(diffName || ''));
    const isDetailMat = /detail/i.test(m.name) && !isPaintOrBody && !isCarbon;
    const isGeneric = /generic/i.test(m.name);

    // Legacy KN5s often use 0 or 1 as an enable flag. Explicit fractional/byte cutoffs are honoured.
    let alphaTest = 0;
    if (alphaTested) {
      alphaTest = look.alphaRef > 1 ? Math.min(1, look.alphaRef / 255)
        : look.alphaRef > 0 && look.alphaRef < 1 ? look.alphaRef : 0.1;
    }

    let color = 0xffffff;
    if (!map) {
      if (isCarbon) color = 0x141416;
      else if (isDetailMat || isGeneric) color = 0x22252a;
      else if (isPaintOrBody) color = 0x242831;
      else if (isTyre) color = 0x1a1a1a;
      else if (isGlass) color = 0x111111;
    }
    // A map-less alpha-tested material may be a deliberately absent overlay in the first livery.
    const emptyDecal = !map && alphaTested && options?.skinMaps?.[name]
      ? rgbaTexture('empty-decal', new Uint8Array([255, 255, 255, 0]), 1, 1) : null;
    const mat = new THREE.MeshStandardMaterial({
      name,
      roughness: isCarbon ? 0.35 : isDetailMat ? 0.25 : isGeneric ? 0.35 : isPaintOrBody ? 0.25 : rough,
      metalness: isMetal ? 0.9 : isCarbon ? 0.04 : isDetailMat ? 0.25 : isGeneric ? 0.6 : 0.0,
      map: map ?? emptyDecal,
      normalMap: normal.texture,
      normalScale: new THREE.Vector2(normal.scale, normal.scale),
      color,
      transparent,
      opacity: transparent && isGlass ? 0.35 : 1.0,
      depthWrite: !transparent,
      alphaTest,
      side: isGlass || isWingOrDecal || isDecalMat ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: isDecalMat,
      polygonOffsetFactor: isTopDecal ? -4 : isDecalMat ? -2 : 0,
      polygonOffsetUnits: isTopDecal ? -4 : isDecalMat ? -2 : 0,
    });

    const upgraded = cleanPortedCarMaterial(mat) as THREE.MeshPhysicalMaterial;
    if (isGeneric) {
      upgraded.metalness = 0.6;
      upgraded.roughness = 0.35;
    }
    if (look.roughness !== undefined) upgraded.roughness = look.roughness;
    if (look.clearcoat !== undefined && upgraded.isMeshPhysicalMaterial) upgraded.clearcoat = look.clearcoat;
    sharpenCarMaps(upgraded);
    return upgraded;
  });

  // 2. Classify and Transform Mesh Vertices to World Coordinates
  const classified: ClassifiedMesh[] = [];

  for (let i = 0; i < kn5.nodes.length; i++) {
    const node = kn5.nodes[i];
    if (!node.active || !node.mesh || !node.mesh.renderable || !node.mesh.visible) continue;

    const anc = getAncestors(kn5.nodes, i);
    const nodeUpper = node.name.toUpperCase();
    const ancUpper = anc.map((a) => a.toUpperCase());

    // Skip blurred rims, colliders, and crash damage replacement meshes (preserve active floor and undertray)
    const isDamageReplacementMesh = (name: string) => {
      const u = name.toUpperCase();
      if (u.includes('FLOOR') || u.includes('DIFFUSER') || u.includes('UNDERTRAY')) return false;
      return (
        u.endsWith('_DMG') ||
        u.endsWith('_DAMAGED') ||
        u.startsWith('DAMAGE_') ||
        u.startsWith('DMG_') ||
        u.includes('_DMG_') ||
        u.includes('_DAMAGED_')
      );
    };

    if (
      ancUpper.some((a) => a.startsWith('RIM_BLUR_') || a.includes('COLLIDER') || isDamageReplacementMesh(a)) ||
      nodeUpper.startsWith('RIM_BLUR_') ||
      nodeUpper.includes('COLLIDER') ||
      isDamageReplacementMesh(nodeUpper)
    ) {
      continue;
    }

    let kind: ClassifiedMesh['kind'] = 'body';
    let corner: CornerName | undefined;

    // Check wheel ancestry & wheel/disc nodes
    for (const c of CORNER_NAMES) {
      if (
        nodeUpper.includes(`WHEEL_${c}`) ||
        ancUpper.some((a) => a.includes(`WHEEL_${c}`)) ||
        nodeUpper.startsWith(`DISC_${c}`) ||
        nodeUpper.includes(`_DISC_${c}`) ||
        nodeUpper.startsWith(`TIRE_${c}`) ||
        nodeUpper.startsWith(`RIM_${c}`)
      ) {
        corner = c;
        const mat = kn5.materials[node.mesh.materialIndex];
        const isTyreMesh =
          nodeUpper.includes('TYRE') ||
          nodeUpper.includes('TIRE') ||
          mat?.name.toUpperCase().includes('TYRE') ||
          mat?.name.toUpperCase().includes('TIRE') ||
          mat?.shader.toUpperCase().includes('TYRE');
        kind = isTyreMesh ? 'tyre' : 'rim';
        break;
      }
    }

    // Check steering wheel ancestry (exclude suspension tie rods, arms, steering column linkages)
    if (kind === 'body') {
      const isSuspLink =
        nodeUpper.includes('ARM') ||
        nodeUpper.includes('ROD') ||
        nodeUpper.includes('LINK') ||
        nodeUpper.includes('SUSP') ||
        nodeUpper.includes('TIE') ||
        nodeUpper.includes('RACK') ||
        nodeUpper.includes('STEER_ARM') ||
        nodeUpper.includes('STEERARM') ||
        nodeUpper.includes('UPRIGHT') ||
        nodeUpper.includes('SHAFT') ||
        ancUpper.some((a) =>
          a.includes('HUB_') ||
          a.includes('SUSP') ||
          a.includes('ARM') ||
          a.includes('TIE') ||
          CORNER_NAMES.some((c) => a.includes(`WHEEL_${c}`) || a.includes(`HUB_${c}`))
        );

      const isSteerWheel =
        !isSuspLink &&
        (ancUpper.some((a) => a === 'STEER_HR' || a === 'STEERING_WHEEL' || a === 'STEER' || a.startsWith('STEER_HR')) ||
          nodeUpper === 'STEER_HR' ||
          nodeUpper === 'STEERING_WHEEL');

      if (isSteerWheel) {
        kind = 'steer';
      }
    }

    // World-transform vertices
    const count = node.mesh.positions.length / 3;
    const worldPos = new Float32Array(count * 3);
    const worldNrm = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(node.worldMatrix);

    for (let k = 0; k < count; k++) {
      v.set(node.mesh.positions[k * 3], node.mesh.positions[k * 3 + 1], node.mesh.positions[k * 3 + 2]);
      v.applyMatrix4(node.worldMatrix);
      worldPos[k * 3] = v.x;
      worldPos[k * 3 + 1] = v.y;
      worldPos[k * 3 + 2] = v.z;

      n.set(node.mesh.normals[k * 3], node.mesh.normals[k * 3 + 1], node.mesh.normals[k * 3 + 2]);
      n.applyMatrix3(normalMatrix).normalize();
      worldNrm[k * 3] = n.x;
      worldNrm[k * 3 + 1] = n.y;
      worldNrm[k * 3 + 2] = n.z;
    }

    classified.push({
      kind,
      corner,
      nodeIndex: i,
      materialIndex: node.mesh.materialIndex,
      positions: worldPos,
      normals: worldNrm,
      uvs: node.mesh.uvs,
      indices: node.mesh.indices,
    });
  }

  // 3. Compute Shift (Ground Alignment & Symmetry)
  const tyreMeshes = classified.filter((m) => m.kind === 'tyre' && m.corner);
  const centerline = tyreMeshes.length === 0 ? findCenterlineWheels(kn5.nodes, classified) : undefined;
  let minY = Infinity;
  let tyreCenterXSum = 0;
  let tyreCount = 0;

  for (const tm of tyreMeshes) {
    for (let k = 1; k < tm.positions.length; k += 3) {
      const y = tm.positions[k];
      if (y < minY) minY = y;
    }
    for (let k = 0; k < tm.positions.length; k += 3) {
      tyreCenterXSum += tm.positions[k];
      tyreCount++;
    }
  }

  const shiftY = centerline ? -centerline.front.groundY : Number.isFinite(minY) ? -minY : 0;
  const shiftX = centerline ? -(centerline.front.centre.x + centerline.rear.centre.x) / 2
    : tyreCount > 0 ? -(tyreCenterXSum / tyreCount) : 0;
  const shift = new THREE.Vector3(shiftX, shiftY, 0);

  // Apply shift to all world positions
  for (const cm of classified) {
    for (let k = 0; k < cm.positions.length; k += 3) {
      cm.positions[k] += shift.x;
      cm.positions[k + 1] += shift.y;
      cm.positions[k + 2] += shift.z;
    }
  }

  // 4. Measure Wheel Centres and Symmetrize
  const wheelCentres: Record<string, [number, number, number]> = {};
  const tyreRadius: Record<string, number> = {};
  const tyreHalfWidth: Record<string, number> = {};

  for (const c of CORNER_NAMES) {
    if (centerline) {
      const wheel = c.endsWith('F') ? centerline.front : centerline.rear;
      wheelCentres[`WHEEL_${c}`] = wheel.centre.clone().add(shift).toArray();
      tyreRadius[c] = wheel.radius;
      tyreHalfWidth[c] = wheel.halfWidth;
      // Put one visual wheel on the left-side channel of each axle. Keep the
      // matching (empty) right slots so the render rig's indices don't move.
      if (c.startsWith('L')) for (const part of wheel.parts) part.corner = c;
      continue;
    }

    const cornerTyres = tyreMeshes.filter((m) => m.corner === c);
    let minX = Infinity,
      maxX = -Infinity;
    let minCornerY = Infinity,
      maxCornerY = -Infinity;
    let minZ = Infinity,
      maxZ = -Infinity;

    for (const ct of cornerTyres) {
      for (let k = 0; k < ct.positions.length; k += 3) {
        const x = ct.positions[k];
        const y = ct.positions[k + 1];
        const z = ct.positions[k + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minCornerY) minCornerY = y;
        if (y > maxCornerY) maxCornerY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }

    if ([minX, maxX, minCornerY, maxCornerY, minZ, maxZ].every(Number.isFinite)) {
      wheelCentres[`WHEEL_${c}`] = [(minX + maxX) / 2, (minCornerY + maxCornerY) / 2, (minZ + maxZ) / 2];
      tyreRadius[c] = (maxCornerY - minCornerY) / 2 || 0.32;
      tyreHalfWidth[c] = (maxX - minX) / 2 || 0.12;
    } else {
      // Some mods have no visible tyre on this corner. Empty bounds must not
      // reach the rig as an infinite radius and translate the entire model.
      wheelCentres[`WHEEL_${c}`] = [c.startsWith('L') ? 0.8 : -0.8, 0.32, c.endsWith('F') ? 1.3 : -1.3];
      tyreRadius[c] = 0.32;
      tyreHalfWidth[c] = 0.12;
    }
  }

  // Symmetrize axle pairs
  for (const axle of centerline ? [] : ['F', 'R'] as const) {
    const lKey = `WHEEL_L${axle}`;
    const rKey = `WHEEL_R${axle}`;
    const lPos = wheelCentres[lKey];
    const rPos = wheelCentres[rKey];
    const halfTrack = Math.abs(lPos[0] - rPos[0]) / 2;
    const avgY = (lPos[1] + rPos[1]) / 2;
    const avgZ = (lPos[2] + rPos[2]) / 2;

    wheelCentres[lKey] = [halfTrack, avgY, avgZ];
    wheelCentres[rKey] = [-halfTrack, avgY, avgZ];

    const avgRadius = (tyreRadius[`L${axle}`] + tyreRadius[`R${axle}`]) / 2;
    const avgHw = (tyreHalfWidth[`L${axle}`] + tyreHalfWidth[`R${axle}`]) / 2;
    tyreRadius[`L${axle}`] = tyreRadius[`R${axle}`] = avgRadius;
    tyreHalfWidth[`L${axle}`] = tyreHalfWidth[`R${axle}`] = avgHw;
  }

  // 5. Construct Groups and Rig Hierarchy
  const carGroup = new THREE.Group();
  carGroup.name = 'CAR';

  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'BODY';
  carGroup.add(bodyGroup);

  // Steering frame
  const steerNode = kn5.nodes.find((n) => n.name === 'STEER_HR' && n.kind === 1);
  const steerPivot = steerNode
    ? new THREE.Vector3(
        steerNode.worldMatrix.elements[12] + shift.x,
        steerNode.worldMatrix.elements[13] + shift.y,
        steerNode.worldMatrix.elements[14] + shift.z
      )
    : new THREE.Vector3(0.35, 0.65, 0.3);

  const steerGroup = new THREE.Group();
  steerGroup.name = 'STEER';
  steerGroup.position.copy(steerPivot);
  carGroup.add(steerGroup);

  // Wheel hubs
  const wheelGroups: Record<string, THREE.Group> = {};
  for (const c of CORNER_NAMES) {
    const wg = new THREE.Group();
    wg.name = `WHEEL_${c}`;
    const hub = wheelCentres[`WHEEL_${c}`];
    wg.position.set(hub[0], hub[1], hub[2]);
    carGroup.add(wg);
    wheelGroups[c] = wg;
  }

  // Helper to create Mesh from ClassifiedMesh
  function createMesh(cm: ClassifiedMesh, originOffset: THREE.Vector3): THREE.Mesh {
    const geom = new THREE.BufferGeometry();
    const count = cm.positions.length / 3;
    const localPos = new Float32Array(cm.positions.length);

    for (let k = 0; k < count; k++) {
      localPos[k * 3] = cm.positions[k * 3] - originOffset.x;
      localPos[k * 3 + 1] = cm.positions[k * 3 + 1] - originOffset.y;
      localPos[k * 3 + 2] = cm.positions[k * 3 + 2] - originOffset.z;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(localPos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(cm.normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(cm.uvs, 2));
    geom.setIndex(new THREE.BufferAttribute(cm.indices, 1));

    const surfaceIndex = appearance.meshSurfaces.get(cm.nodeIndex);
    const material = (surfaceIndex === undefined ? undefined : threeMaterials[surfaceIndex]) ??
      new THREE.MeshStandardMaterial({ color: 0x888888 });
    const mesh = new THREE.Mesh(geom, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Decal overlay ordering: ensure decal meshes draw over the base body
    const nodeName = kn5.nodes[cm.nodeIndex].name;
    const nodeUpper = nodeName.toUpperCase();
    const matName = (material.name || '').toUpperCase();
    const isDecalMesh =
      matName.includes('DECAL') ||
      nodeUpper.includes('DECAL') ||
      nodeUpper.includes('3DSIMED') ||
      nodeUpper.startsWith('A_') ||
      nodeUpper.startsWith('BODY_A_');

    if (isDecalMesh) {
      const isTop =
        /add_decal|number|driver|badge|logo|sponsor/i.test(nodeName) ||
        /add_decal|number|driver|badge|logo|sponsor/i.test(material.name || '');
      mesh.renderOrder = isTop ? 3 : 2;
    }

    return mesh;
  }

  // Populate Groups with Meshes
  const zeroOffset = new THREE.Vector3(0, 0, 0);

  for (const cm of classified) {
    if (cm.kind === 'body') {
      const mesh = createMesh(cm, zeroOffset);
      mesh.name = `BODY_${kn5.nodes[cm.nodeIndex].name}`;
      bodyGroup.add(mesh);
    } else if (cm.kind === 'steer') {
      const mesh = createMesh(cm, steerPivot);
      mesh.name = `STEER_${kn5.nodes[cm.nodeIndex].name}`;
      steerGroup.add(mesh);
    } else if (cm.corner && (cm.kind === 'rim' || cm.kind === 'tyre')) {
      const hubPos = wheelCentres[`WHEEL_${cm.corner}`];
      const hubVec = new THREE.Vector3(hubPos[0], hubPos[1], hubPos[2]);
      const mesh = createMesh(cm, hubVec);
      mesh.name = `WHEEL_${cm.corner}_${cm.kind === 'tyre' ? 'TYRE' : 'RIM'}`;
      wheelGroups[cm.corner].add(mesh);
    }
  }

  // 6. Set UserData extras on CAR
  const wheelbaseM = Math.abs(wheelCentres.WHEEL_LF[2] - wheelCentres.WHEEL_LR[2]) || 2.6;
  const trackWidthFront = 2 * Math.abs(wheelCentres.WHEEL_LF[0]) || 1.5;
  const trackWidthRear = 2 * Math.abs(wheelCentres.WHEEL_LR[0]) || 1.5;

  // Authored positions are in the original KN5 frame; fallback anchors already use the shifted rig.
  const cameras = options?.cameras;
  const hasPosition = (pose: AcCameraPose | undefined): pose is AcCameraPose =>
    Array.isArray(pose?.pos) && pose.pos.length === 3 && pose.pos.every(Number.isFinite);
  const cameraInModel = (pose: AcCameraPose | undefined, fallback: AcCameraPose): AcCameraPose =>
    hasPosition(pose)
      ? {
          ...pose,
          pos: [pose.pos[0] + shift.x, pose.pos[1] + shift.y, pose.pos[2] + shift.z],
          pitchDeg: pose.pitchDeg ?? fallback.pitchDeg,
          fov: pose.fov ?? fallback.fov,
        }
      : fallback;

  carGroup.userData = {
    customMod: true,
    revLeds: options?.revLeds,
    wheelCentres,
    tyreRadius,
    tyreHalfWidth,
    wheelbaseM,
    trackWidthM: {
      front: trackWidthFront,
      rear: trackWidthRear,
    },
    steer: {
      pivot: [steerPivot.x, steerPivot.y, steerPivot.z],
      column: [0, 0.4, 0.9],
    },
    authoredDash: hasPosition(cameras?.dash),
    cameras: {
      cockpit: cameraInModel(cameras?.cockpit, {
        pos: [steerPivot.x, steerPivot.y + 0.38, steerPivot.z - 0.78],
        pitchDeg: -4,
        fov: 55,
      }),
      dash: cameraInModel(cameras?.dash, {
        pos: [steerPivot.x, steerPivot.y + 0.22, steerPivot.z - 0.45],
        pitchDeg: -4,
        fov: 62,
      }),
      tcam: cameraInModel(cameras?.tcam, {
        pos: [0, steerPivot.y + 0.48, steerPivot.z - 0.35],
        pitchDeg: -6,
        fov: 58,
      }),
      bumper: cameraInModel(cameras?.bumper, {
        pos: [0, wheelCentres.WHEEL_LF[1] + 0.25, wheelCentres.WHEEL_LF[2] + 1.2],
        pitchDeg: -5,
        fov: 58,
      }),
      nearChase: {
        pos: [0, wheelCentres.WHEEL_LR[1] + 1.2, wheelCentres.WHEEL_LR[2] - 4.5],
        pitchDeg: -6,
        fov: 55,
      },
      farChase: {
        pos: [0, wheelCentres.WHEEL_LR[1] + 1.8, wheelCentres.WHEEL_LR[2] - 6.5],
        pitchDeg: -8,
        fov: 50,
      },
    },
    skinMaps: options?.skinMaps,
  };

  return carGroup;
}

/**
 * Converts a Three.js scene group into a GLB binary blob.
 */
export async function exportGroupToGlb(group: THREE.Group): Promise<Blob> {
  const exporter = new GLTFExporter();
  return new Promise<Blob>((resolve, reject) => {
    exporter.parse(
      group,
      (gltf) => {
        if (gltf instanceof ArrayBuffer) {
          resolve(new Blob([gltf], { type: 'model/gltf-binary' }));
        } else {
          resolve(new Blob([JSON.stringify(gltf)], { type: 'model/gltf+json' }));
        }
      },
      (error) => reject(error),
      { binary: true }
    );
  });
}
