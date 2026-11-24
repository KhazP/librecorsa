import { withBasePath } from "@/lib/base-path";
import { isArchiveJunk, readZip, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES, ZipError } from "./zip-reader";
import {
  isModPackageId,
  isSafeModPath,
  manifestFiles,
  modFileUrl,
  MODS_PATH,
  packageHash,
  sha256Hex,
  validateModManifest,
  type ModKnownIds,
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
/** Where an import's files wait until all of them are in (a name no package id can take), so a failed update keeps the last */
const STAGING_PATH = `${MODS_PATH}/_staging`;

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

/** What a package downloaded from a catalogue must turn out to be: the id and content hash the catalogue lists */
export interface ExpectedPackage {
  id: string;
  hash: string;
}

/** What an import reads files from: a zip's entries or a picked folder's files */
export interface PackageSource {
  paths: string[];
  /** A file's size (bytes) before it is read */
  size(path: string): number;
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
export const PACKAGE_FILE = new RegExp(`\\.(${Object.keys(CONTENT_TYPES).join("|")})$`, "i");

/**
 * What is wrong with a package's file list (paths within the package): an unsafe path, a type it may not carry, or two
 * names only a letter's case apart, which are one file on Windows and macOS and two in a zip (the hash would differ)
 */
export function packageFileProblems(paths: readonly string[]): string[] {
  const errors: string[] = [];
  const folded = new Map<string, string>();
  for (const p of paths) {
    if (!isSafeModPath(p)) errors.push(`${p}: not a path a package may use`);
    else if (!PACKAGE_FILE.test(p)) errors.push(`${p}: not a file type a package may carry (${Object.keys(CONTENT_TYPES).join(", ")})`);
    const other = folded.get(p.toLowerCase());
    if (other !== undefined && other !== p) errors.push(`${p} and ${other}: names that differ only in case`);
    folded.set(p.toLowerCase(), p);
  }
  return errors;
}

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

/** A zip archive's entries as a package source (junk an archiver adds is left out), read from the file as needed */
export async function zipSource(archive: Blob): Promise<PackageSource> {
  const entries = new Map((await readZip(archive)).filter((e) => !isArchiveJunk(e.path)).map((e) => [e.path, e]));
  return {
    paths: [...entries.keys()],
    size: (path) => entries.get(path)?.size ?? 0,
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
    size: (path) => byPath.get(path)?.size ?? 0,
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
  const roots = paths
    .filter((p) => /^[^/]+\/mod\.json$/.test(p))
    .map((p) => p.slice(0, -"mod.json".length))
    // A folder's name, never `.` or `..`
    .filter((r) => isSafeModPath(r.slice(0, -1)));
  if (roots.length !== 1) return null;
  return paths.every((p) => p.startsWith(roots[0])) ? roots[0] : null;
}

// --- One change to the stored packages at a time ---

/**
 * An install or a removal reads `_installed.json`, changes the cache and writes the list back: two at once would lose
 * one's change to the list, and two installs of one id would mix their files in `_staging/<id>/`. So they run one
 * after another, whoever calls them (the Mods panel, its catalogue, a panel closed and opened again mid-install).
 */
let storeQueue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = storeQueue.then(task, task);
  storeQueue = run.catch(() => {});
  return run;
}

/**
 * What holds the panel's one job at a time (an import, a removal, a catalogue's download and install), kept here
 * rather than in the panel, so a panel closed and opened again while one runs knows and keeps its buttons off.
 */
let held = 0;
const holdListeners = new Set<() => void>();

const tellHolders = () => holdListeners.forEach((listener) => listener());

/**
 * Takes the hold for an import, a removal or a download: hands back what lets it go (once), or null while another
 * has it. Taken in the click, before anything is awaited, so a quick second click finds it taken.
 */
export function holdModsStore(): (() => void) | null {
  if (held > 0) return null;
  held++;
  tellHolders();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held--;
    tellHolders();
  };
}

/** Whether an import, a removal or a download holds the stored packages */
export const modsStoreHeld = (): boolean => held > 0;

/** Hears the hold being taken and let go (for useSyncExternalStore); returns what stops it */
export function onModsStoreHold(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => void holdListeners.delete(listener);
}

/**
 * Checks a package and stores it, in place of an installed package with the same id. Nothing is stored unless every
 * check passes: its `mod.json`, that every file it names is there, every path being safe to serve, and its size. The
 * files wait aside until all of them are read and stored, so an update that fails (a damaged file, no space) leaves
 * the installed version as it was. `known` are the game's ids a package may name (mod-content.ts `modDefinitions`).
 * `expected`, for a download from a catalogue (mod-catalogue.ts): anything but that package with that content is
 * refused, before the installed version is touched.
 */
export function installPackage(source: PackageSource, known: ModKnownIds, expected?: ExpectedPackage): Promise<InstallResult> {
  return oneAtATime(() => installNow(source, known, expected));
}

async function installNow(source: PackageSource, known: ModKnownIds, expected?: ExpectedPackage): Promise<InstallResult> {
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
  if (expected && manifest.id !== expected.id) return { ok: false, errors: [`the download holds the package "${manifest.id}", not "${expected.id}" as the catalogue lists`] };

  const errors = packageFileProblems(files.map((f) => f.path));
  const present = new Set(files.map((f) => f.path));
  for (const needed of manifestFiles(manifest)) if (!present.has(needed)) errors.push(`${needed}: named in mod.json but not in the package`);
  if (files.length > ZIP_MAX_ENTRIES) errors.push(`the package holds more than ${ZIP_MAX_ENTRIES} files`);
  if (files.reduce((n, f) => n + source.size(f.from), 0) > ZIP_MAX_TOTAL_BYTES) errors.push("the package is larger than 2 GB");
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };

  // Asking for persistent storage keeps the browser from clearing mods when it runs short of space
  void navigator.storage?.persist?.().catch(() => false);

  const cache = await caches.open(MODS_CACHE);
  const installed = await readInstalled();
  const replaced = installed.some((p) => p.id === manifest.id);
  const staging = `${STAGING_PATH}/${manifest.id}/`;
  // The file's own URL, moved aside: its path encoded as `modFileUrl` encodes it
  const staged = (path: string) => absolute(modFileUrl(manifest.id, path).replace(`${MODS_PATH}/`, `${STAGING_PATH}/`));
  await deletePrefix(cache, staging);
  const hashes: Record<string, string> = {};
  let bytes = 0;
  // Set once the installed version's files start to go: from then on a failure leaves no package rather than half of one
  let replacing = false;
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
      await cache.put(staged(f.path), new Response(data as Uint8Array<ArrayBuffer>, { headers }));
    }
    const entry: InstalledPackage = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      hash: await packageHash(hashes),
      bytes,
      installedAt: Date.now(),
    };
    if (expected && entry.hash !== expected.hash) throw new Error("the download's content is not what the catalogue lists (its content hash differs)");
    // Every file is in: the new version takes the old one's place
    replacing = true;
    await deleteFiles(cache, manifest.id);
    for (const f of files) {
      const res = await cache.match(staged(f.path));
      if (!res) throw new Error(`${f.path}: lost while installing`);
      await cache.put(absolute(modFileUrl(manifest.id, f.path)), res);
      await cache.delete(staged(f.path));
    }
    await writeInstalled(cache, [...installed.filter((p) => p.id !== manifest.id), entry]);
  } catch (err) {
    // A clean-up that fails too mustn't hide why the import did
    await deletePrefix(cache, staging).catch(() => {});
    if (replacing) {
      await deleteFiles(cache, manifest.id).catch(() => {});
      await writeInstalled(cache, installed.filter((p) => p.id !== manifest.id)).catch(() => {});
    }
    const quota = (err instanceof DOMException && err.name === "QuotaExceededError") || /quota/i.test(String(err));
    return { ok: false, errors: [quota ? "Not enough storage space for this package" : err instanceof Error ? err.message : String(err)] };
  }
  return { ok: true, manifest, replaced };
}

async function deletePrefix(cache: Cache, path: string): Promise<void> {
  const prefix = absolute(path);
  for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req);
}

const deleteFiles = (cache: Cache, id: string): Promise<void> => deletePrefix(cache, `${MODS_PATH}/${id}/`);

/** Removes an installed package, after any install or removal under way */
export function removePackage(id: string): Promise<void> {
  return oneAtATime(() => removeNow(id));
}

async function removeNow(id: string): Promise<void> {
  if (!modsStorageAvailable()) return;
  const cache = await caches.open(MODS_CACHE);
  await deleteFiles(cache, id);
  await writeInstalled(cache, (await readInstalled()).filter((p) => p.id !== id));
  // Imported again later, it starts switched on, as any new package does
  setPackageEnabled(id, true);
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
