/**
 * Reads a zip archive in the browser, for a mod package a player imports: stored and deflated entries (what every zip
 * tool writes), each checked against its CRC-32. Deflate is undone by the platform's `DecompressionStream`, so this
 * adds no library. Zip64, encrypted and multi-disk archives are refused with a reason.
 *
 * Entries are read one at a time, when asked for, so an archive's files never all sit in memory decompressed at once.
 */

export interface ZipEntry {
  /** Its path in the archive, forward slashes */
  path: string;
  /** Uncompressed size (bytes), as the archive states it; `read` checks it */
  size: number;
  read(): Promise<Uint8Array>;
}

/** The most a package may hold, uncompressed */
export const ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipError extends Error {}

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // More than the archive said: a damaged or hostile entry, stopped before it can fill memory
    if (at + value.byteLength > expected) {
      await reader.cancel().catch(() => {});
      throw new ZipError("an entry inflates past its stated size");
    }
    out.set(value, at);
    at += value.byteLength;
  }
  if (at !== expected) throw new ZipError("an entry is shorter than its stated size");
  return out;
}

/** Whether a path is something an archiver adds that no package means to carry (macOS resource forks, Finder files) */
export const isArchiveJunk = (path: string): boolean =>
  path.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(path) || /(^|\/)Thumbs\.db$/i.test(path);

/** The entries of a zip archive (directories left out), in archive order */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits in the last 22 bytes plus a comment of up to 65 535
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip archive");
  const disk = view.getUint16(eocd + 4, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0) throw new ZipError("multi-part archives are not supported");
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("zip64 archives are not supported: zip the package without zip64");
  if (count > MAX_ENTRIES) throw new ZipError(`the archive holds more than ${MAX_ENTRIES} entries`);
  if (cdOffset + cdSize > eocd) throw new ZipError("the archive's directory is damaged");

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let total = 0;
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIG) throw new ZipError("the archive's directory is damaged");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue;
    if (flags & 1) throw new ZipError(`${path} is encrypted`);
    if (method !== 0 && method !== 8) throw new ZipError(`${path} uses compression method ${method}: only stored and deflated entries are read`);
    if (compressed === 0xffffffff || size === 0xffffffff) throw new ZipError("zip64 archives are not supported: zip the package without zip64");
    total += size;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new ZipError("the package is larger than 2 GB uncompressed");
    entries.push({
      path,
      size,
      read: async () => {
        if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIG) throw new ZipError(`${path}: damaged entry`);
        const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        if (start + compressed > bytes.length) throw new ZipError(`${path}: the archive is cut short`);
        const raw = bytes.subarray(start, start + compressed);
        const data = method === 0 ? raw.slice() : await inflateRaw(raw, size);
        if (data.length !== size) throw new ZipError(`${path}: size does not match the archive's directory`);
        if (crc32(data) !== crc) throw new ZipError(`${path}: checksum mismatch (the archive is damaged)`);
        return data;
      },
    });
  }
  return entries;
}
