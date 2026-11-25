// SPDX-License-Identifier: GPL-3.0-only
// Adapted 2026-11-25 from Kn5Decrypt by SeizureSaladd; see THIRD_PARTY_NOTICES.md.
import { cspKey } from './kn5-csp-keys';
import { ProtectedKn5Error, type readCspKn5Footer } from './kn5-protection';

const MAX_MODEL_BYTES = 256 * 1024 * 1024;
const POSITION_DELTA_V1 = Math.fround(0.03);
const decoder = new TextDecoder();
type Footer = NonNullable<ReturnType<typeof readCspKn5Footer>>;
type Fail = (detail: string) => never;

class Reader {
  private readonly view: DataView;
  offset = 0;

  constructor(private readonly bytes: Uint8Array, private readonly fail: Fail) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  take(size: number): Uint8Array {
    const start = this.offset;
    this.offset += size;
    if (this.offset > this.bytes.length) this.fail('Los datos del modelo están truncados o dañados.');
    return this.bytes.subarray(start, this.offset);
  }

  u32(): number {
    const start = this.offset;
    this.take(4);
    return this.view.getUint32(start, true);
  }

  string(): string {
    return decoder.decode(this.take(this.u32()));
  }

  skipString(): void {
    this.take(this.u32());
  }
}

interface TextureSlot {
  name: string;
  offset: number;
  size: number;
}

interface MeshSlot {
  name: string;
  offset: number;
  count: number;
  stride: number;
}

// Read the body without allocating any Three.js objects or trusting lengths
// that could point into the sidecar instead of the ordinary KN5 sections.
function scanBody(body: Uint8Array, fail: Fail) {
  const r = new Reader(body, fail);
  if (decoder.decode(r.take(6)) !== 'sc6969') fail('La cabecera KN5 no es válida.');
  if (r.u32() > 5) r.take(4); // KN5 version, distinct from the CSP encoding version.
  const textures: TextureSlot[] = [];
  const textureCount = r.u32();
  for (let i = 0; i < textureCount; i++) {
    if (r.u32() === 0) continue;
    const name = r.string();
    const size = r.u32();
    textures.push({ name, offset: r.offset, size });
    r.take(size);
  }
  const texturesEnd = r.offset;

  const materialCount = r.u32();
  for (let i = 0; i < materialCount; i++) {
    r.skipString(); // Material name
    r.skipString(); // Shader name
    r.take(6); // Blend, alpha test, depth mode
    const propCount = r.u32();
    for (let p = 0; p < propCount; p++) {
      r.skipString();
      r.take(40);
    }
    const mapCount = r.u32();
    for (let m = 0; m < mapCount; m++) {
      r.skipString();
      r.take(4);
      r.skipString();
    }
  }

  const meshes: MeshSlot[] = [];
  // Preorder node layout only needs a count of nodes still to be visited.
  let pending = 1;
  while (pending > 0) {
    const kind = r.u32();
    const name = r.string();
    pending += r.u32() - 1;
    r.take(1); // Active
    if (kind === 0) continue;
    if (kind === 1) {
      r.take(64); // Transform
      continue;
    }
    if (kind !== 2 && kind !== 3) fail('El modelo contiene un tipo de nodo KN5 desconocido.');
    r.take(3); // Shadow, visibility, transparency
    if (kind === 3) {
      const boneCount = r.u32();
      for (let b = 0; b < boneCount; b++) {
        r.skipString();
        r.take(64);
      }
    }
    const stride = kind === 3 ? 76 : 44;
    const count = r.u32();
    meshes.push({ name, offset: r.offset, count, stride });
    r.take(count * stride);
    r.take(r.u32() * 2); // Indices
    r.take(kind === 3 ? 16 : 33); // Material, layer, LOD/bounds/renderability
  }
  return { textures, texturesEnd, meshes, end: r.offset };
}

function readSidecar(data: Uint8Array, fail: Fail) {
  const r = new Reader(data, fail);
  const fields = new Map<string, Uint8Array>();
  const textures = new Set<string>();
  const masks = new Set<string>();
  while (r.offset < data.length) {
    const key = r.string();
    const payload = r.take(r.u32());
    const match = /^(tex|ver)\.(.+)\.([kixd])$/s.exec(key);
    if (!match || (match[1] === 'ver' && match[3] === 'd')) continue;
    if (fields.has(key)) fail('Los datos de recuperación del modelo contienen entradas duplicadas.');
    fields.set(key, payload);
    (match[1] === 'tex' ? textures : masks).add(match[2]);
  }

  const entry = (prefix: string) => {
    const key = fields.get(`${prefix}.k`);
    const iv = fields.get(`${prefix}.i`);
    const ciphertext = fields.get(`${prefix}.x`);
    if (key?.length !== 4 || iv?.length !== 16 || !ciphertext?.length || ciphertext.length % 16 !== 0) {
      return fail('Faltan datos de recuperación o están dañados.');
    }
    const word = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    const keyId = (word(key) ^ word(iv)) >>> 0;
    const rawKey = cspKey(keyId);
    if (!rawKey) return fail('La clave de este modelo CSP no es compatible.');
    return { rawKey, iv: new Uint8Array(iv), ciphertext: new Uint8Array(ciphertext) };
  };

  return {
    textures: Array.from(textures, (name) => {
      const compressed = fields.get(`tex.${name}.d`);
      if (!compressed?.length) return fail('Faltan datos de recuperación de una textura.');
      return { name, ...entry(`tex.${name}`), compressed };
    }),
    masks: Array.from(masks, (name) => ({ name, ...entry(`ver.${name}`) })),
  };
}

type EncryptedEntry = ReturnType<typeof readSidecar>['masks'][number];
type EncryptedTexture = ReturnType<typeof readSidecar>['textures'][number];

async function decrypt(subtle: SubtleCrypto, entry: EncryptedEntry, salt: string) {
  const key = entry.rawKey.slice();
  for (let i = 0; i < salt.length; i++) key[i % key.length] ^= salt.charCodeAt(i) & 0xff;
  const cryptoKey = await subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: entry.iv }, cryptoKey, entry.ciphertext));
  if (plain.length === 0) throw new Error('Empty CSP payload');
  return plain;
}

async function decodeTexture(subtle: SubtleCrypto, entry: EncryptedTexture, salt: string, remaining: number, fail: Fail) {
  const mask = await decrypt(subtle, entry, salt);
  const data = new Uint8Array(entry.compressed);
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % mask.length];
  // Native zlib verifies the checksum; read in chunks to cap inflated size.
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > remaining) {
      await reader.cancel().catch(() => {});
      fail('La copia reconstruida supera el límite de 256 MiB por modelo.');
    }
    chunks.push(value);
  }
  if (size < 4) throw new Error('Invalid CSP texture');
  return new Blob(chunks);
}

function applyMask(view: DataView, start: number, mesh: MeshSlot, mask: Uint8Array, fail: Fail): void {
  for (let i = 0; i < mesh.count; i++) {
    const flags = mask[i % mask.length];
    const offset = start + i * mesh.stride;
    for (let component = 0; component < 8; component++) {
      const at = offset + component * 4;
      const value = view.getFloat32(at, true);
      if (!Number.isFinite(value)) fail('El modelo contiene vértices dañados.');
      const set = (flags & (1 << component)) !== 0;
      if (component < 3) view.setFloat32(at, value + (set ? -POSITION_DELTA_V1 : POSITION_DELTA_V1), true);
      else if (set) view.setFloat32(at, component < 6 ? -value : 1 - value, true);
    }
  }
}

/** Rebuild only CSP v1, whose vertex format can be fully restored. Never
 * return a body-only preview or modify any of the source arrays. */
export async function rebuildCspKn5(
  bytes: Uint8Array,
  footer: Footer,
  fileName: string,
  folderName: string,
  dataAcd?: Uint8Array,
): Promise<Blob> {
  const fail: Fail = (detail) => { throw new ProtectedKn5Error(fileName, detail); };
  if (footer.version !== 1) fail(`La versión ${footer.version} de la protección CSP no es compatible.`);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof DecompressionStream === 'undefined') {
    return fail('Abre LibreCorsa en un navegador actualizado, por HTTPS o desde localhost.');
  }
  if (footer.sidecarOffset < 6 || footer.sidecarOffset >= footer.start) {
    fail('Los datos de recuperación del modelo están vacíos o dañados.');
  }

  const body = bytes.subarray(0, footer.sidecarOffset);
  const layout = scanBody(body, fail);
  const { textures, masks } = readSidecar(bytes.subarray(footer.sidecarOffset, footer.start), fail);
  const [probe, ...otherTextures] = textures;
  if (!probe) return fail('No hay una textura cifrada con la que verificar la clave del modelo.');
  const textureSlots = new Map<string, number>();
  for (const { name } of layout.textures) textureSlots.set(name, (textureSlots.get(name) ?? 0) + 1);
  const meshSlots = new Set(layout.meshes.map(({ name }) => name));
  if (textures.some(({ name }) => !textureSlots.has(name)) || masks.some(({ name }) => !meshSlots.has(name))) {
    fail('Los datos de recuperación no coinciden con el modelo 3D.');
  }
  const restoredNames = new Set(textures.map(({ name }) => name));
  let remaining = MAX_MODEL_BYTES - layout.end;
  for (const slot of layout.textures) if (restoredNames.has(slot.name)) remaining += slot.size;
  if (remaining <= 0) fail('La copia reconstruida supera el límite de 256 MiB por modelo.');
  const recoverTexture = async (entry: EncryptedTexture, salt: string) => {
    const slots = textureSlots.get(entry.name)!;
    const texture = await decodeTexture(subtle, entry, salt, Math.floor(remaining / slots), fail);
    remaining -= texture.size * slots;
    return texture;
  };

  const baseSalt = `car model/${folderName}`;
  const salts = [baseSalt];
  if (dataAcd) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(dataAcd)));
    salts.unshift(`${baseSalt}:${btoa(String.fromCharCode(...digest)).replace(/=+$/, '')}`);
  }
  let salt: string | undefined;
  const restoredTextures = new Map<string, Blob>();
  for (const candidate of salts) {
    try {
      const texture = await recoverTexture(probe, candidate);
      salt = candidate;
      restoredTextures.set(probe.name, texture);
      break;
    } catch (error) {
      if (error instanceof ProtectedKn5Error) throw error;
    }
  }
  if (!salt) return fail('Importa el paquete completo con el nombre original de la carpeta y su data.acd original, si lo incluye.');

  const restoredMasks = new Map<string, Uint8Array>();
  try {
    for (const entry of otherTextures) {
      restoredTextures.set(entry.name, await recoverTexture(entry, salt));
    }
    for (const entry of masks) restoredMasks.set(entry.name, await decrypt(subtle, entry, salt));
  } catch (error) {
    if (error instanceof ProtectedKn5Error) throw error;
    fail('No se pudieron recuperar todas las texturas y vértices cifrados.');
  }

  const tail = new Uint8Array(body.subarray(layout.texturesEnd, layout.end));
  const view = new DataView(tail.buffer);
  for (const mesh of layout.meshes) {
    const mask = restoredMasks.get(mesh.name);
    if (mask) applyMask(view, mesh.offset - layout.texturesEnd, mesh, mask, fail);
  }

  // Keep untouched records byte-for-byte and reuse the inflated texture Blobs
  // as parts, avoiding an extra full-size array before the normal KN5 parse.
  const parts: BlobPart[] = [];
  let position = 0;
  for (const slot of layout.textures) {
    const texture = restoredTextures.get(slot.name);
    if (!texture) continue;
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, texture.size, true);
    parts.push(new Uint8Array(body.subarray(position, slot.offset - 4)), length, texture);
    position = slot.offset + slot.size;
  }
  parts.push(new Uint8Array(body.subarray(position, layout.texturesEnd)), tail);
  return new Blob(parts, { type: 'application/octet-stream' });
}
