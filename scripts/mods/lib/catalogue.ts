/**
 * A catalogue of packed packages (src/lib/mods/mod-catalogue.ts), written from a folder of their zips: each zip read
 * with the game's own zip reader, unpacked aside and checked as `npm run mod -- check` checks a folder, with the zip's
 * size and SHA-256 and the package's content hash. A picture beside a zip with its name (`<name>.webp`, `.png`,
 * `.jpg`) is its preview.
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, openAsBlob, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
  CATALOGUE_FORMAT,
  CATALOGUE_MAX_BYTES,
  CATALOGUE_MAX_PACKAGES,
  CATALOGUE_MAX_ZIP_BYTES,
  parseCatalogue,
} from "../../../src/lib/mods/mod-catalogue";
import { validateModManifest } from "../../../src/lib/mods/mod-manifest";
import { modDefinitions } from "../../../src/lib/mods/mod-content";
import { packageFileProblems, packageRoot } from "../../../src/lib/mods/mod-store";
import { isArchiveJunk, readZip } from "../../../src/lib/mods/zip-reader";
import { checkPackage, hashFolder } from "./package-check";

/** An entry as the catalogue file holds it (its links as written, not yet resolved) */
export interface CatalogueFileEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author: string;
  license: string;
  licenseUrl?: string;
  url: string;
  bytes: number;
  sha256: string;
  hash: string;
  circuits?: number;
  cars?: number;
  liveries?: number;
  preview?: string;
}

export interface CatalogueFile {
  format: typeof CATALOGUE_FORMAT;
  packages: CatalogueFileEntry[];
}

/** A zip that can't go in: its file name and why */
export interface ZipFailure {
  file: string;
  problems: string[];
}

const PREVIEW_TYPES = [".webp", ".png", ".jpg", ".jpeg"];

/**
 * What a zip's link starts with: an https:// address, a path on the game's site, or a folder relative to the
 * catalogue (left out: the zip sits beside the catalogue). http:// only on this machine (the launcher), since the game
 * downloads from nowhere else over http. Throws with what to use instead.
 */
export function linkBase(base: string | undefined): string {
  if (!base) return "";
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  if (/\s|\\/.test(base) || base.startsWith("//")) throw new Error(`--base-url ${base}: not a link the game follows`);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(base)?.[1]?.toLowerCase();
  if (!scheme) return withSlash;
  if (scheme === "https") return withSlash;
  if (scheme === "http" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(withSlash)) return withSlash;
  throw new Error(`--base-url ${base}: the game downloads packages over https:// or from its own site (a path such as /mods/_catalogue/)`);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * One packed package checked as the game's importer and `npm run mod -- check` check it, and its entry. The zip is
 * unpacked into a folder of its own, which is removed after.
 */
export async function packedEntry(file: string, link: string): Promise<{ ok: true; entry: CatalogueFileEntry } | { ok: false; problems: string[] }> {
  const bytes = statSync(file).size;
  if (bytes > CATALOGUE_MAX_ZIP_BYTES) return { ok: false, problems: ["the zip is larger than 2 GB, more than the game imports"] };
  let entries;
  try {
    entries = (await readZip(await openAsBlob(file))).filter((e) => !isArchiveJunk(e.path));
  } catch (err) {
    return { ok: false, problems: [`not a zip the game reads: ${(err as Error).message}`] };
  }
  const root = packageRoot(entries.map((e) => e.path));
  if (root === null) return { ok: false, problems: ["no mod.json at the top of the archive (or in its one folder)"] };
  const files = entries.filter((e) => e.path.startsWith(root)).map((e) => ({ entry: e, path: e.path.slice(root.length) }));
  // Every path checked before anything is written: a path that could leave the folder is refused here
  const pathProblems = packageFileProblems(files.map((f) => f.path));
  if (pathProblems.length) return { ok: false, problems: pathProblems };

  const dir = mkdtempSync(join(tmpdir(), "mod-catalogue-"));
  try {
    for (const f of files) {
      const out = join(dir, ...f.path.split("/"));
      mkdirSync(dirname(out), { recursive: true });
      try {
        writeFileSync(out, await f.entry.read());
      } catch (err) {
        return { ok: false, problems: [(err as Error).message] };
      }
    }
    const checked = checkPackage(dir);
    if (!checked.ok) return { ok: false, problems: checked.problems };
    const result = validateModManifest(JSON.parse(readFileSync(join(dir, "mod.json"), "utf8")), modDefinitions());
    if (!result.ok) return { ok: false, problems: result.errors };
    const m = result.manifest;
    const entry: CatalogueFileEntry = {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.credit.author,
      license: m.credit.license,
      licenseUrl: m.credit.licenseUrl,
      url: `${link}${encodeURIComponent(basename(file))}`,
      bytes,
      sha256: await sha256File(file),
      hash: await hashFolder(dir, checked.files),
      circuits: m.tracks?.length || undefined,
      cars: m.cars?.length || undefined,
      liveries: m.skins?.length || undefined,
    };
    return { ok: true, entry: JSON.parse(JSON.stringify(entry)) as CatalogueFileEntry };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The catalogue of every zip in `folder`, in name order, each linked as `<baseUrl><file name>`. A zip that fails its
 * checks, or holds a package another zip holds too, is a failure, and the catalogue is only good when there are none.
 */
export async function buildCatalogue(
  folder: string,
  baseUrl?: string,
  onZip?: (file: string, result: { ok: true; entry: CatalogueFileEntry } | { ok: false; problems: string[] }) => void,
): Promise<{ catalogue: CatalogueFile; failures: ZipFailure[] }> {
  const link = linkBase(baseUrl);
  const names = readdirSync(folder).sort();
  const zips = names.filter((n) => extname(n).toLowerCase() === ".zip" && statSync(join(folder, n)).isFile());
  if (!zips.length) throw new Error(`no .zip files in ${folder}: pack each package with npm run mod -- pack`);
  const packages: CatalogueFileEntry[] = [];
  const failures: ZipFailure[] = [];
  const byId = new Map<string, string>();
  for (const file of zips) {
    const result = await packedEntry(join(folder, file), link);
    if (result.ok) {
      const other = byId.get(result.entry.id);
      if (other) {
        const twice = { ok: false as const, problems: [`holds ${result.entry.id}, which ${other} holds too: a catalogue lists each package once`] };
        onZip?.(file, twice);
        failures.push({ file, problems: twice.problems });
        continue;
      }
      byId.set(result.entry.id, file);
      const stem = file.slice(0, -extname(file).length);
      const preview = names.find((n) => PREVIEW_TYPES.some((t) => n === `${stem}${t}`));
      if (preview) result.entry.preview = `${link}${encodeURIComponent(preview)}`;
      packages.push(result.entry);
    } else failures.push({ file, problems: result.problems });
    onZip?.(file, result);
  }
  packages.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id));
  if (packages.length > CATALOGUE_MAX_PACKAGES) failures.push({ file: folder, problems: [`more than ${CATALOGUE_MAX_PACKAGES} packages: the game reads only the first ${CATALOGUE_MAX_PACKAGES}`] });
  const catalogue: CatalogueFile = { format: CATALOGUE_FORMAT, packages };
  if (catalogueJson(catalogue).length > CATALOGUE_MAX_BYTES) failures.push({ file: folder, problems: [`the catalogue would be larger than ${CATALOGUE_MAX_BYTES} bytes, more than the game reads`] });

  // Read back as the game reads it: every entry must be one the game keeps
  const origin = link.startsWith("http://") ? new URL(link).origin : "https://catalogue.invalid";
  const read = parseCatalogue(JSON.parse(catalogueJson(catalogue)), `${origin}/mods/_catalogue/catalogue.json`, origin);
  if (read.problems.length) failures.push({ file: folder, problems: read.problems.map((p) => `the game would drop ${p}`) });
  return { catalogue, failures };
}

export const catalogueJson = (catalogue: CatalogueFile): string => `${JSON.stringify(catalogue, null, 2)}\n`;
