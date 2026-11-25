import type { LibarchiveWasm } from './libarchiveWasm';

import { ArchiveReaderEntry } from './ArchiveReaderEntry';

function toTimeFromTimeT(timeT: number): number {
  return timeT * 1000;
}

const CHUNK_BYTES = 2 * 1024 * 1024;

export class ArchiveReader {
  libarchive: LibarchiveWasm;

  archive: number;

  pointer: number;

  /* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-unnecessary-template-expression, @typescript-eslint/restrict-template-expressions */
  static FileTypes = {
    [`${0o170000}`]: 'Mount',
    [`${0o100000}`]: 'File',
    [`${0o120000}`]: 'SymbolicLink',
    [`${0o140000}`]: 'Socket',
    [`${0o020000}`]: 'CharacterDevice',
    [`${0o060000}`]: 'BlockDevice',
    [`${0o040000}`]: 'Directory',
    [`${0o010000}`]: 'NamedPipe',
  };
  /* eslint-enable perfectionist/sort-objects, @typescript-eslint/no-unnecessary-template-expression, @typescript-eslint/restrict-template-expressions */

  private constructor(libarchive: LibarchiveWasm, archive: number, pointer: number) {
    this.libarchive = libarchive;
    this.archive = archive;
    this.pointer = pointer;
  }

  static async open(libarchive: LibarchiveWasm, data: Blob | Uint8Array): Promise<ArchiveReader> {
    const { module } = libarchive;
    const size = data instanceof Blob ? data.size : data.byteLength;
    // This libarchive build uses a 32-bit address space and an in-memory, seekable 7z input.
    if (!size || size > 0x7fffffff) throw new Error('El archivo 7Z está vacío o es demasiado grande para abrirlo aquí.');
    const ptr = module._malloc(size);
    if (!ptr) throw new RangeError('No se pudo reservar memoria para el archivo 7Z.');
    try {
      if (data instanceof Blob) {
        for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
          const chunk = await data.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
          module.HEAP8.set(new Int8Array(chunk), ptr + offset);
        }
      } else {
        module.HEAP8.set(data, ptr);
      }
      return new ArchiveReader(libarchive, libarchive.read_new_memory(ptr, size), ptr);
    } catch (error) {
      module._free(ptr);
      throw error;
    }
  }

  free(): void {
    try {
      this.libarchive.read_free(this.archive);
    } finally {
      this.libarchive.module._free(this.pointer);
      this.libarchive = null as unknown as LibarchiveWasm;
      this.archive = null as unknown as number;
      this.pointer = null as unknown as number;
    }
  }

  hasEncryptedData(): boolean | null {
    const code = this.libarchive.read_has_encrypted_entries(this.archive);
    return code < 0 ? null : !!code;
  }

  /** Each chunk borrows WASM memory; consume or snapshot it before advancing. */
  *readChunks(size: number): Generator<Int8Array<ArrayBuffer>, void, unknown> {
    if (size <= 0) return;
    const { module } = this.libarchive;
    const capacity = Math.min(size, CHUNK_BYTES);
    const ptr = module._malloc(capacity);
    if (!ptr) throw new RangeError('No se pudo reservar memoria para descomprimir el mod.');
    try {
      for (let remaining = size; remaining > 0;) {
        const read = this.libarchive.read_data(this.archive, ptr, Math.min(remaining, capacity));
        if (!read) throw new Error('Un archivo del mod 7Z está incompleto.');
        // The decoder can grow the heap while reading, so take the view afterwards.
        const heap = module.HEAP8;
        yield new Int8Array(heap.buffer as ArrayBuffer, heap.byteOffset + ptr, read);
        remaining -= read;
      }
    } finally {
      module._free(ptr);
    }
  }

  skipData(): void {
    this.libarchive.read_data_skip(this.archive);
  }

  nextEntryPointer(): number {
    return this.libarchive.read_next_entry(this.archive);
  }

  getEntryFiletype(ptr: number): string {
    const fileType = String(this.libarchive.entry_filetype(ptr));
    return fileType in ArchiveReader.FileTypes
      ? ArchiveReader.FileTypes[fileType as keyof typeof ArchiveReader.FileTypes]
      : 'Invalid';
  }

  getEntryPathname(ptr: number): string {
    return this.libarchive.entry_pathname(ptr);
  }

  getEntrySize(ptr: number): number {
    return this.libarchive.entry_size(ptr);
  }

  getEntryAccessTime(ptr: number): number {
    return toTimeFromTimeT(this.libarchive.entry_atime(ptr));
  }

  getEntryBirthTime(ptr: number): number {
    return toTimeFromTimeT(this.libarchive.entry_birthtime(ptr));
  }

  getEntryCreationTime(ptr: number): number {
    return toTimeFromTimeT(this.libarchive.entry_ctime(ptr));
  }

  getEntryModificationTime(ptr: number): number {
    return toTimeFromTimeT(this.libarchive.entry_mtime(ptr));
  }

  isEntryEncrypted(ptr: number): boolean {
    return !!this.libarchive.entry_is_encrypted(ptr);
  }

  getSymlinkTarget(ptr: number): string {
    return this.libarchive.entry_symlink(ptr);
  }

  getHardlinkTarget(ptr: number): string {
    return this.libarchive.entry_hardlink(ptr);
  }

  nextEntry(): ArchiveReaderEntry | null {
    const entryPtr = this.nextEntryPointer();
    if (entryPtr === 0) return null;
    return new ArchiveReaderEntry(this, entryPtr);
  }

  forEach(fn: (entry: ArchiveReaderEntry) => unknown): void {
    for (;;) {
      const entry = this.nextEntry();
      if (!entry) break;
      fn(entry);
      entry.free();
    }
  }

  *entries(): Generator<ArchiveReaderEntry, void, unknown> {
    for (;;) {
      const entry = this.nextEntry();
      if (!entry) break;
      yield entry;
      entry.free();
    }
  }
}
