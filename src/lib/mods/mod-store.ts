import { withBasePath } from "@/lib/base-path";
import { isArchiveJunk, readZip, ZipError } from "./zip-reader";
import {
  isModPackageId,
  isSafeModPath,
  manifestFiles,
  modFileUrl,
  MODS_PATH,
  packageHash,
  sha256Hex,
  validateModManifest,
  type ModManifest,
} from "./mod-manifest";

/**
 * The mod packages a player imported in the browser, kept in Cache Storage under the URLs the game loads them by
 * (`/mods/<package>/<path>`). public/sw.js answers those URLs from here, so the loaders fetch a mod's files as they
 * fetch the game's own, online or off. The service worker's own clean-up never touches this cache: a package stays
 * until the player removes it.
 *
 * Cache Storage rather than the origin-private file system: the page and the service worker both reach it in every
 * browser the game runs in, and a stored Response keeps its content type and size for the loaders' progress bars.
 */

/** public/sw.js answers `/mods/` from this cache; keep the two in step */
export const MODS_CACHE = "librecorsa-mods-v1";
/** The installed packages and their hashes (a name no package id can take: ids start with a letter or digit) */
export const INSTALLED_PATH = `${MODS_PATH}/_installed.json`;
/** A folder of packages served as files (`public/mods/`, the launcher's `mods/`) lists them here */
export const FOLDER_INDEX_PATH = `${MODS_PATH}/_index.json`;

export interface InstalledPackage {
  id: string;
  name: string;
  version: string;
  /** `packageHash` of its files */
  hash: string;
  bytes: number;
  installedAt: number;
}

export type InstallResult = { ok: true; manifest: ModManifest; replaced: boolean } | { ok: false; errors: string[] };

/** What an import reads files from: a zip's entries or a picked folder's files */
export interface PackageSource {
  paths: string[];
  read(path: string): Promise<Uint8Array>;
}

const CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  bin: "application/octet-stream",
  json: "application/json",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ktx2: "image/ktx2",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

/** The files a package may carry: assets the game loads, and its readme and licence */
const PACKAGE_FILE = new RegExp(`\\.(${Object.keys(CONTENT_TYPES).join("|")})$`, "i");

export const modsStorageAvailable = (): boolean => typeof caches !== "undefined" && typeof window !== "undefined";

const absolute = (path: string): string => new URL(withBasePath(path), window.location.origin).href;

export async function readInstalled(): Promise<InstalledPackage[]> {
  if (!modsStorageAvailable()) return [];
  try {
    const cache = await caches.open(MODS_CACHE);
    const res = await cache.match(absolute(INSTALLED_PATH));
    if (!res) return [];
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? list.filter((p): p is InstalledPackage => !!p && isModPackageId((p as InstalledPackage).id)) : [];
  } catch {
    return [];
  }
}

async function writeInstalled(cache: Cache, list: InstalledPackage[]): Promise<void> {
  await cache.put(absolute(INSTALLED_PATH), new Response(JSON.stringify(list), { headers: { "Content-Type": "application/json" } }));
}

/** A JSON file of an installed package (its `mod.json`, a car's physics), parsed but unchecked; null when absent */
export async function readInstalledJson(id: string, path = "mod.json"): Promise<unknown> {
  const cache = await caches.open(MODS_CACHE);
  const res = await cache.match(absolute(modFileUrl(id, path)));
  return res ? res.json() : null;
}

/** A zip archive's entries as a package source (junk an archiver adds is left out) */
export function zipSource(bytes: Uint8Array): PackageSource {
  const entries = new Map(readZip(bytes).filter((e) => !isArchiveJunk(e.path)).map((e) => [e.path, e]));
  return {
    paths: [...entries.keys()],
    read: (path) => {
      const entry = entries.get(path);
      if (!entry) return Promise.reject(new Error(`${path} is not in the archive`));
      return entry.read();
    },
  };
}

/** A picked folder's files (`<input webkitdirectory>`): their paths are `webkitRelativePath` */
export function filesSource(files: readonly File[]): PackageSource {
  const byPath = new Map<string, File>();
  for (const f of files) {
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
    if (!isArchiveJunk(path)) byPath.set(path, f);
  }
  return {
    paths: [...byPath.keys()],
    read: async (path) => {
      const f = byPath.get(path);
      if (!f) throw new Error(`${path} is not in the folder`);
      return new Uint8Array(await f.arrayBuffer());
    },
  };
}

/**
 * The package's root inside a source: "" when `mod.json` is at the top, or the one folder that holds it and
 * everything else (a zip of the package's folder, a picked folder). Null when there is no single root.
 */
export function packageRoot(paths: readonly string[]): string | null {
  if (paths.includes("mod.json")) return "";
  const roots = paths.filter((p) => /^[^/]+\/mod\.json$/.test(p)).map((p) => p.slice(0, -"mod.json".length));
  if (roots.length !== 1) return null;
  return paths.every((p) => p.startsWith(roots[0])) ? roots[0] : null;
}

/**
 * Checks a package and stores it, in place of an installed package with the same id. Nothing is stored unless every
 * check passes: its `mod.json`, that every file it names is there, and every path being safe to serve. `known` are the
 * game's car and vehicle model ids, which a package's liveries and cars may name.
 */
export async function installPackage(
  source: PackageSource,
  known: { cars: ReadonlySet<string>; vehicles: ReadonlySet<string> },
): Promise<InstallResult> {
  if (!modsStorageAvailable()) return { ok: false, errors: ["This browser has no storage for mods here (a private window, or the page is not served over https)"] };
  const root = packageRoot(source.paths);
  if (root === null) return { ok: false, errors: ["No mod.json at the top of the package (or in its one folder)"] };
  const files = source.paths.filter((p) => p.startsWith(root)).map((p) => ({ from: p, path: p.slice(root.length) }));

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await source.read(`${root}mod.json`)));
  } catch (err) {
    return { ok: false, errors: [`mod.json: ${err instanceof ZipError ? err.message : "is not valid JSON"}`] };
  }
  const checked = validateModManifest(raw, known);
  if (!checked.ok) return checked;
  const manifest = checked.manifest;

  const errors: string[] = [];
  const present = new Set(files.map((f) => f.path));
  for (const f of files) {
    if (!isSafeModPath(f.path)) errors.push(`${f.path}: not a path a package may use`);
    else if (!PACKAGE_FILE.test(f.path)) errors.push(`${f.path}: not a file type a package may carry (${Object.keys(CONTENT_TYPES).join(", ")})`);
  }
  for (const needed of manifestFiles(manifest)) if (!present.has(needed)) errors.push(`${needed}: named in mod.json but not in the package`);
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };

  // Asking for persistent storage keeps the browser from clearing mods when it runs short of space
  void navigator.storage?.persist?.().catch(() => false);

  const cache = await caches.open(MODS_CACHE);
  const installed = await readInstalled();
  const replaced = installed.some((p) => p.id === manifest.id);
  if (replaced) await deleteFiles(cache, manifest.id);
  const hashes: Record<string, string> = {};
  let bytes = 0;
  try {
    for (const f of files) {
      const data = await source.read(f.from);
      hashes[f.path] = await sha256Hex(data);
      bytes += data.byteLength;
      const ext = f.path.slice(f.path.lastIndexOf(".") + 1).toLowerCase();
      const headers = {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Content-Length": String(data.byteLength),
        "X-File-Size": String(data.byteLength),
      };
      await cache.put(absolute(modFileUrl(manifest.id, f.path)), new Response(data as Uint8Array<ArrayBuffer>, { headers }));
    }
  } catch (err) {
    // Half a package is worse than none
    await deleteFiles(cache, manifest.id);
    await writeInstalled(cache, installed.filter((p) => p.id !== manifest.id));
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [/quota/i.test(message) ? "Not enough storage space for this package" : message] };
  }
  const entry: InstalledPackage = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    hash: await packageHash(hashes),
    bytes,
    installedAt: Date.now(),
  };
  await writeInstalled(cache, [...installed.filter((p) => p.id !== manifest.id), entry]);
  return { ok: true, manifest, replaced };
}

async function deleteFiles(cache: Cache, id: string): Promise<void> {
  const prefix = absolute(`${MODS_PATH}/${id}/`);
  for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req);
}

export async function removePackage(id: string): Promise<void> {
  if (!modsStorageAvailable()) return;
  const cache = await caches.open(MODS_CACHE);
  await deleteFiles(cache, id);
  await writeInstalled(cache, (await readInstalled()).filter((p) => p.id !== id));
}

// --- Which packages are switched on (a per-browser choice, like the other settings) ---

const DISABLED_KEY = "librecorsa.mods.disabled";

export function disabledPackages(): Set<string> {
  try {
    const list = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(list) ? list.filter(isModPackageId) : []);
  } catch {
    return new Set();
  }
}

export function setPackageEnabled(id: string, enabled: boolean): void {
  const off = disabledPackages();
  if (enabled) off.delete(id);
  else off.add(id);
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...off]));
  } catch {
    // Storage unavailable: the choice lasts for this page only
  }
}
