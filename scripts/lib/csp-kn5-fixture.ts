import { createCipheriv, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

function field(data: string | Uint8Array): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([u32(bytes.length), bytes]);
}

function floats(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return bytes;
}

export function wrapCspKn5(body: Uint8Array, records: ReadonlyMap<string, Uint8Array>, version = 1): Buffer<ArrayBuffer> {
  const sidecar = [...records].flatMap(([name, bytes]) => [field(name), field(bytes)]);
  return Buffer.concat([body, ...sidecar, field('__AC_SHADERS_PATCH_KN5ENC_v1__'), u32(body.length), u32(version)]);
}

/** Fixtures use Node's crypto and zlib, not the browser implementation under test. */
export function createCspKn5Fixture(folder: string, dataAcd?: Uint8Array) {
  const salt = `car model/${folder}` + (dataAcd ? `:${createHash('sha256').update(dataAcd).digest('base64').slice(0, -1)}` : '');
  const records = new Map<string, Buffer>();
  const addEncrypted = (name: string, secret: Uint8Array) => {
    const iv = Buffer.from('0123456789abcdef');
    const key = Buffer.from('746ec2881d7218407caa88081eb37e9cd67907323316d16519c3ec2a63c73d31', 'hex');
    for (let i = 0; i < salt.length; i++) key[i % 32] ^= salt.charCodeAt(i);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    records.set(`${name}.i`, iv);
    records.set(`${name}.k`, u32(0x01214d1d ^ iv.readUInt32LE()));
    records.set(`${name}.x`, Buffer.concat([cipher.update(secret), cipher.final()]));
  };

  // Uncompressed 1x1 luminance DDS with a distinct pixel per texture.
  const makeDds = (light: number) => {
    const dds = Buffer.alloc(129);
    dds.write('DDS ');
    for (const [offset, value] of [[4, 124], [8, 0x100f], [12, 1], [16, 1], [20, 1],
      [76, 32], [80, 0x20000], [88, 8], [92, 0xff], [108, 0x1000]]) dds.writeUInt32LE(value, offset);
    dds[128] = light;
    return dds;
  };
  const textures = new Map([
    ['color.dds', makeDds(61)],
    ['plain.dds', makeDds(117)],
    ['badge.dds', makeDds(213)],
  ]);
  const textureSecret = [17, 240, 46];
  for (const [name, dds] of textures) {
    if (name === 'plain.dds') continue;
    addEncrypted(`tex.${name}`, Buffer.from(textureSecret));
    records.set(`tex.${name}.d`, Buffer.from(deflateSync(dds).map((byte, i) => byte ^ textureSecret[i % 3])));
  }
  records.set('acd..e', Buffer.from('unused metadata'));
  const masks = [[0xff, 0x00], [0x55, 0xaa]];
  addEncrypted('ver.BODY', Buffer.from(masks[0]));
  addEncrypted('ver.SKINNED', Buffer.from(masks[1]));

  const node = (kind: number, name: string, children: number) => [u32(kind), field(name), u32(children), Buffer.of(1)];
  const identity = floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const mesh = (skinned: boolean, protection: boolean) => {
    const vertices = [
      [0, 0.5, 0, 0.25, 0.5, 0.75, 0.25, 0.75, 1, 0, 0],
      [1, 0.5, 0, 0.25, 0.5, 0.75, 0.75, 0.5, 1, 0, 0],
      [0, 0.5, 1, 0.25, 0.5, 0.75, 0.5, 0.25, 1, 0, 0],
    ];
    if (protection) vertices.forEach((vertex, i) => {
      const flags = masks[skinned ? 1 : 0][i % 2];
      const sign = (bit: number) => flags & bit ? -1 : 1;
      const delta = Math.fround(0.03);
      for (let c = 0; c < 3; c++) {
        vertex[c] -= sign(1 << c) * delta;
        vertex[c + 3] *= sign(8 << c);
      }
      if (flags & 64) vertex[6] = 1 - vertex[6];
      if (flags & 128) vertex[7] = 1 - vertex[7];
    });
    return [
      ...node(skinned ? 3 : 2, skinned ? 'SKINNED' : 'BODY', 0), Buffer.of(1, 1, 0),
      ...(skinned ? [u32(1), field('BONE'), identity] : []),
      u32(vertices.length), ...vertices.map((v) => floats(skinned ? [...v, 1, 0, 0, 0, 0, 0, 0, 0] : v)),
      u32(3), Buffer.of(0, 0, 1, 0, 2, 0),
      ...(skinned ? [Buffer.alloc(16)] : [Buffer.alloc(32), Buffer.of(1)]),
    ];
  };
  const body = (protection: boolean) => Buffer.concat([
    Buffer.from('sc6969'), u32(6), u32(0), u32(1 + textures.size), u32(0),
    ...[...textures].flatMap(([name, bytes]) => [u32(1), field(name), field(protection && name !== 'plain.dds' ? Buffer.of(0) : bytes)]),
    u32(1), field('Material'), field('ksPerPixel'), Buffer.alloc(6), u32(0),
    u32(1), field('txDiffuse'), u32(0), field('color.dds'),
    ...node(1, 'Root', 2), identity, ...mesh(false, protection), ...mesh(true, protection),
  ]);
  return { plain: body(false), preview: body(true), records };
}
