/**
 * Reads a zip archive in the browser, for a mod package a player imports: stored and deflated entries (what every zip
 * tool writes), each checked against its CRC-32. Deflate is undone by the platform's `DecompressionStream`, so this
 * adds no library. Zip64, encrypted and multi-disk archives are refused with a reason.
 *
 * The archive is read from its Blob (the picked File) a piece at a time: the directory first, then each entry when it
 * is asked for, so a package up to its 2 GB never sits in memory whole, compressed or not.
 */

export interface ZipEntry {
  /** Its path in the archive, forward slashes */
  path: string;
  /** Uncompressed size (bytes), as the archive states it; `read` checks it */
  size: number;
  /**
   * Whether the archive marks it as a symbolic link (a Unix zip tool keeps the file's mode in the entry): its bytes are
   * then the link's target, which a tool unpacking to a disk must not make a link
   */
  symlink: boolean;
  read(): Promise<Uint8Array>;
}

/** The most a package may hold, uncompressed (an import from a folder, and `npm run mod`, keep to it as well) */
export const ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
/** The most files a package may hold */
export const ZIP_MAX_ENTRIES = 20_000;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

export class ZipError extends Error {}

let crcTable: Uint32Array | null = null;
/** CRC-32 (the zip polynomial) of `data`, continued from `crc` when given */
export function crc32(data: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Undoes deflate, gathering what comes out until the stated size: memory follows what the entry really holds, so an
 * archive that states a size it doesn't hold (2 GB in a few bytes) never gets it set aside
 */
async function inflateRaw(data: Blob, expected: number): Promise<Uint8Array> {
  const reader = data.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      throw new ZipError("damaged compressed data");
    }
    if (step.done) break;
    // More than the archive said: a damaged or hostile entry, stopped before it can fill memory
    if (at + step.value.byteLength > expected) {
      await reader.cancel().catch(() => {});
      throw new ZipError("an entry inflates past its stated size");
    }
    chunks.push(step.value);
    at += step.value.byteLength;
  }
  if (at !== expected) throw new ZipError("an entry is shorter than its stated size");
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(at);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Whether a path is something an archiver adds that no package means to carry (macOS resource forks, Finder files), at
 * any depth: a zip of the package's folder has them inside that folder
 */
export const isArchiveJunk = (path: string): boolean =>
  /(^|\/)__MACOSX\//.test(path) || /(^|\/)\.DS_Store$/.test(path) || /(^|\/)Thumbs\.db$/i.test(path);

const bytesOf = async (blob: Blob, start: number, end: number): Promise<Uint8Array> => new Uint8Array(await blob.slice(start, end).arrayBuffer());

/** The entries of a zip archive (directories left out), in archive order */
export async function readZip(archive: Blob | Uint8Array): Promise<ZipEntry[]> {
  const blob = archive instanceof Blob ? archive : new Blob([archive as Uint8Array<ArrayBuffer>]);
  const length = blob.size;
  if (length < EOCD_SIZE) throw new ZipError("not a zip archive");
  // The end record sits in the last 22 bytes plus a comment of up to 65 535. The one whose comment runs to the end
  // is the archive's (a comment may hold the signature too); an archive with bytes after it is read from the last one
  const tailStart = Math.max(0, length - EOCD_SIZE - 0xffff);
  const tail = await bytesOf(blob, tailStart, length);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tailView.getUint32(i, true) !== EOCD_SIG) continue;
    if (eocd < 0) eocd = i;
    if (tailView.getUint16(i + 20, true) === tail.length - (i + EOCD_SIZE)) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip archive");
  const disk = tailView.getUint16(eocd + 4, true);
  const cdDisk = tailView.getUint16(eocd + 6, true);
  const diskEntries = tailView.getUint16(eocd + 8, true);
  const count = tailView.getUint16(eocd + 10, true);
  const cdSize = tailView.getUint32(eocd + 12, true);
  const cdOffset = tailView.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count) throw new ZipError("multi-part archives are not supported");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 archives are not supported: zip the package without zip64");
  if (count > ZIP_MAX_ENTRIES) throw new ZipError(`the archive holds more than ${ZIP_MAX_ENTRIES} entries`);
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > tailStart + eocd) throw new ZipError("the archive's directory is damaged");

  const cd = await bytesOf(blob, cdOffset, cdEnd);
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + CENTRAL_SIZE > cd.length || view.getUint32(at, true) !== CENTRAL_SIG) throw new ZipError("the archive's directory is damaged");
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const externalAttrs = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + CENTRAL_SIZE + nameLen + extraLen + commentLen;
    if (next > cd.length) throw new ZipError("the archive's directory is damaged");
    const path = decoder.decode(cd.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLen));
    at = next;
    if (path.endsWith("/")) continue;
    if (flags & 1) throw new ZipError(`${path} is encrypted`);
    if (method !== 0 && method !== 8) throw new ZipError(`${path} uses compression method ${method}: only stored and deflated entries are read`);
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("zip64 archives are not supported: zip the package without zip64");
    }
    if (method === 0 && compressed !== size) throw new ZipError(`${path}: damaged entry (stored, yet its sizes differ)`);
    // Two entries under one name: which one a tool unpacks differs from tool to tool, so neither is taken
    if (seen.has(path)) throw new ZipError(`${path} is in the archive twice`);
    seen.add(path);
    total += size;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new ZipError("the package is larger than 2 GB uncompressed");
    // Made on Unix (host 3): the upper half of the external attributes is the file's mode
    const symlink = madeBy >>> 8 === 3 && ((externalAttrs >>> 16) & 0o170000) === 0o120000;
    entries.push({
      path,
      size,
      symlink,
      read: async () => {
        if (localOffset + LOCAL_SIZE > cdOffset) throw new ZipError(`${path}: damaged entry`);
        const local = await bytesOf(blob, localOffset, localOffset + LOCAL_SIZE);
        const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
        if (localView.getUint32(0, true) !== LOCAL_SIG) throw new ZipError(`${path}: damaged entry`);
        const start = localOffset + LOCAL_SIZE + localView.getUint16(26, true) + localView.getUint16(28, true);
        if (start + compressed > cdOffset) throw new ZipError(`${path}: the archive is cut short`);
        const raw = blob.slice(start, start + compressed);
        let data: Uint8Array;
        try {
          data = method === 0 ? new Uint8Array(await raw.arrayBuffer()) : await inflateRaw(raw, size);
        } catch (err) {
          throw new ZipError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (data.length !== size) throw new ZipError(`${path}: size does not match the archive's directory`);
        if (crc32(data) !== crc) throw new ZipError(`${path}: checksum mismatch (the archive is damaged)`);
        return data;
      },
    });
  }
  return entries;
}
