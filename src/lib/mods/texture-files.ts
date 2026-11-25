export function texturePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '').toLowerCase();
}

export function isTextureFile(path: string): boolean {
  return /\.(dds|png|jpe?g|webp)$/i.test(path);
}

/** AC matches texture names case-insensitively. Loose exports can change the
 * extension or drop the directory, but an ambiguous alias must not pick a file. */
export class TextureFiles<T> {
  private readonly exact = new Map<string, T>();
  private readonly basenames = new Map<string, T | null>();
  private readonly stems = new Map<string, T | null>();

  constructor(entries: Iterable<readonly [string, T]> = []) {
    for (const [name, value] of entries) {
      const path = texturePath(name);
      if (!path) continue;
      this.exact.set(path, value);
      const base = path.slice(path.lastIndexOf('/') + 1);
      this.addAlias(this.basenames, base, value);
      this.addAlias(this.stems, base.replace(/\.[^.]+$/, ''), value);
    }
  }

  private addAlias(index: Map<string, T | null>, key: string, value: T): void {
    index.set(key, !index.has(key) || index.get(key) === value ? value : null);
  }

  find(name: string | undefined): T | undefined {
    if (!name) return undefined;
    const path = texturePath(name);
    const direct = this.exact.get(path);
    if (direct !== undefined) return direct;
    const base = path.slice(path.lastIndexOf('/') + 1);
    const alias = this.basenames.get(base);
    if (alias !== undefined) return alias ?? undefined;
    return this.stems.get(base.replace(/\.[^.]+$/, '')) ?? undefined;
  }
}
