/**
 * Speed Dreams' content at pinned revisions, for the sd-track and sd-car importers: the circuits Speed Dreams' asset
 * database lists (each archive pinned by its sha256), the cars in their own repositories on forge.a-lec.org (each at a
 * pinned commit, or for the few without one the database's zip and its sha256), and the files of the game's shared
 * data that circuits and cars draw on, from speed-dreams-data at the one commit both importers read.
 *
 * Everything lands in one cache, which git ignores:
 *
 *   scripts/mods/.cache/speed-dreams/
 *     speed-dreams-data.git/  a bare clone of speed-dreams-data at the pinned commit: its trees, and the files asked
 *                             for so far
 *     data/                   files of speed-dreams-data's data/ folder (the game's data folder), written out as the
 *                             importers ask for them (data/tracks/surfaces.xml, data/textures/…, data/objects/…,
 *                             data/sound/…, cars/categories/<category>.xml), and .sd-source.json naming the commit
 *     circuits/<circuit>/     a fetched circuit, and .sd-source.json (where it came from)
 *     cars/<car>/             a fetched car, and .sd-source.json
 *
 * The pins: speed-dreams-data's commit and the cars' in scripts/cars/speed-dreams-cars.json (which
 * scripts/cars/speed-dreams-pins.ts moves forward), the circuits' archives in scripts/mods/importers/sd-track.circuits.json.
 *
 * Nothing fetched is taken on trust:
 *
 * - An archive must match its pinned sha256, and it is unpacked here, in JavaScript: an entry that would land outside
 *   its folder (an absolute path, `..`, a drive, a backslash) or that the archive marks as a link refuses the archive.
 * - A file from git is read out of the repository by its id in the pinned commit's tree, never checked out. git checks
 *   each object against its id as it fetches it, the bytes are checked against the id again as they are written, and a
 *   file already in the cache is checked against it each time it is asked for, so a stale or changed one is fetched
 *   again. A tree holding a link or a submodule is refused.
 * - git runs over https only, with links, hooks and credential prompts off, and fsck on every object it receives.
 * - A folder's .sd-source.json is believed only inside this cache: a folder from elsewhere can't claim to be one of
 *   Speed Dreams' own.
 *
 * The forge refuses bursts of requests (HTTP 429): a refused download waits as long as it is asked to and tries again.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isArchiveJunk, readZip } from "../../../src/lib/mods/zip-reader";
import { REPO_ROOT } from "./toolchain";

export const SD_CACHE_DIR = join(REPO_ROOT, "scripts", "mods", ".cache", "speed-dreams");
/** The game's data folder as the cache keeps it: the files of speed-dreams-data's data/ fetched so far */
export const SD_DATA_DIR = join(SD_CACHE_DIR, "data");
const DATA_REPO_DIR = join(SD_CACHE_DIR, "speed-dreams-data.git");

/** Where a fetched folder (a circuit, a car, the shared data) records where it came from */
export const SOURCE_FILE = ".sd-source.json";

/**
 * The files of the shared data that a circuit's trackdef includes (`<!ENTITY default-surfaces SYSTEM
 * "../../../data/tracks/surfaces.xml">`); scripts/tracks/extract_sd_track.py takes these and no other shared file
 */
export const SHARED_TRACK_FILES = ["surfaces.xml", "objects.xml"];

// ---------------------------------------------------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------------------------------------------------

export interface PinnedCar {
  name: string;
  category: string;
  author: string;
  /** As the official asset database gives it */
  license: string;
  /** Its git repository and commit, or the database's zip and its sha256 */
  repo?: string;
  commit?: string;
  zip?: string;
  sha256?: string;
  size?: number;
}

export interface Pins {
  pinned: string;
  assetsDatabase: string;
  /** speed-dreams-data, which both importers read: the circuits' default surfaces and textures, the cars' categories */
  data: { repo: string; commit: string };
  code: { repo: string; commit: string };
  cars: Record<string, PinnedCar>;
}

export const PINS_FILE = join(__dirname, "..", "..", "cars", "speed-dreams-cars.json");
export const readPins = (): Pins => JSON.parse(readFileSync(PINS_FILE, "utf8")) as Pins;

/** A circuit as Speed Dreams' asset database lists it (sd-track.circuits.json) */
export interface CatalogueEntry {
  directory: string;
  name: string;
  category: string;
  author: string;
  license: string;
  revision: number;
  archive: string;
  sha256: string;
  bytes: number;
  page: string;
}

export const CIRCUITS_FILE = join(__dirname, "..", "importers", "sd-track.circuits.json");
export const circuitCatalogue = (): CatalogueEntry[] => (JSON.parse(readFileSync(CIRCUITS_FILE, "utf8")) as { circuits: CatalogueEntry[] }).circuits;

// ---------------------------------------------------------------------------------------------------------------------
// Where they came from
// ---------------------------------------------------------------------------------------------------------------------

/** Where a fetched circuit came from */
export interface CircuitSource {
  from: "asset-database" | "speed-dreams-data";
  directory: string;
  /** The archive and its sha256, or the repository and its commit */
  archive?: string;
  sha256?: string;
  revision?: number;
  repository?: string;
  commit?: string;
  /** The circuit's page (its repository) */
  page: string;
  /** What the asset database says of it */
  license?: string;
  author?: string;
}

/** Where a fetched car came from */
export interface FetchedSource {
  car: string;
  pinned: PinnedCar;
  /** A link to the exact files: the commit's tree, or the zip */
  url: string;
}

/** Where the cache's shared data came from */
interface DataSource {
  from: "speed-dreams-data";
  repository: string;
  commit: string;
}

/** Whether `p` lies in `root` or is it, links followed where they exist */
export function isInside(root: string, p: string): boolean {
  const real = (x: string) => {
    try {
      return realpathSync(x);
    } catch {
      return resolve(x);
    }
  };
  const rel = relative(real(root), real(p));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** What a folder in the cache records of where it came from, or null (none, or a folder outside the cache) */
export function readSdSource<T>(dir: string): T | null {
  const p = join(dir, SOURCE_FILE);
  if (!existsSync(p) || !isInside(SD_CACHE_DIR, dir)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

/** What a fetched car's folder records of where it came from, or null */
export const fetchedSource = (carDir: string): FetchedSource | null => readSdSource<FetchedSource>(carDir);

const writeSource = (dir: string, source: object) => writeFileSync(join(dir, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);

// ---------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A path from an archive, a git tree or a source's own files, as a safe relative path with forward slashes; null when
 * it is absolute, names a drive or a stream (any `:`), holds a backslash or a control character, or has an empty, `.` or
 * `..` part
 */
export function safeRelative(p: string): string | null {
  if (!p || p.startsWith("/") || /[\\:\u0000-\u001f\u007f]/.test(p)) return null;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..") ? p : null;
}

/** A plain file name: one part of a path, which safeRelative takes (a name a source's XML gives a file of its own) */
export const plainFileName = (name: string): boolean => !name.includes("/") && safeRelative(name) !== null;

/** `rel` (a safeRelative path) in `root`, checked to stay there */
function under(root: string, rel: string): string {
  const out = resolve(root, ...rel.split("/"));
  const r = relative(resolve(root), out);
  if (!r || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) throw new Error(`${rel} would land outside ${root}`);
  return out;
}

/** A new file (never one that is there, a link least of all), its folders made */
function writeNew(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx" });
}

/** A file replaced whole: written beside it, then renamed over it (a link there is replaced, not followed) */
function writeReplacing(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, bytes);
  renameSync(part, path);
}

/** A folder made in `parent` to fill before it is renamed into place, so a failed fetch leaves nothing half-written */
function workFolder(parent: string, name: string): string {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `.${name}-`));
}

function replaceFolder(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}

// ---------------------------------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------------------------------

const USER_AGENT = "librecorsa-mod-tool";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The wait a refusal asks for (Retry-After, in seconds or as a date), else `fallback`; two minutes at most */
function retryAfter(res: Response, fallback: number): number {
  const h = res.headers.get("retry-after")?.trim();
  const ms = !h ? Number.NaN : /^\d+$/.test(h) ? Number(h) * 1000 : Date.parse(h) - Date.now();
  return Math.min(120_000, Number.isFinite(ms) && ms >= 0 ? ms : fallback);
}

/**
 * A file's bytes over https, tried `tries` times while the server is busy (429, 5xx) or unreachable, waiting as long as
 * it asks between tries: the forge refuses bursts, and Speed Dreams' servers drop out now and then for a minute or two
 */
export async function download(url: string, what: string, tries = 6): Promise<Uint8Array> {
  if (!/^https:\/\//i.test(url)) throw new Error(`${what}: ${url} is not an https link`);
  let last = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    let wait = 10_000 * (attempt + 1);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      last = `HTTP ${res.status}`;
      await res.body?.cancel();
      if (res.status !== 429 && res.status < 500) break;
      wait = retryAfter(res, 20_000 * (attempt + 1));
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      last = cause?.code ?? (err as Error).message;
    }
    if (attempt < tries - 1) {
      console.log(`      ${what}: ${last}, trying again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
  throw new Error(`${what}: ${url} answered ${last}. Speed Dreams' servers may be busy or down for a while: try again later`);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * A zip's files written into `into`, a new folder: each entry's path as `pick` maps it (null leaves it out), refused
 * whole when a path isn't a safe relative one or an entry is a link. Returns how many files it wrote
 */
export async function extractZip(bytes: Uint8Array, into: string, what: string, pick: (path: string) => string | null = (p) => p): Promise<number> {
  let n = 0;
  for (const e of await readZip(bytes)) {
    if (isArchiveJunk(e.path)) continue;
    const want = pick(e.path);
    if (want === null) continue;
    const rel = safeRelative(want);
    if (!rel) throw new Error(`${what}: the archive holds an unsafe path (${JSON.stringify(e.path)}): refused`);
    if (e.symlink) throw new Error(`${what}: the archive holds a link (${e.path}): refused`);
    writeNew(under(into, rel), await e.read());
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------------------------------

/** Settings every git command here runs with, whatever the user's configuration says */
const GIT_SETTINGS = [
  // Never make a link, never run a hook or a file-system monitor
  "core.symlinks=false",
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  // https only (no file://, ssh or ext:: transports); no submodules
  "protocol.allow=never",
  "protocol.https.allow=always",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  // Every object received checked (malformed trees, `..` or `.git` in a path)
  "transfer.fsckObjects=true",
  // Nothing in the background
  "gc.auto=0",
  "maintenance.auto=false",
];

/** Variables that would point git at another repository or configuration than the one named */
const GIT_ENV_DROPPED = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

function gitEnv(noLazyFetch: boolean): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!GIT_ENV_DROPPED.test(k)) env[k] = v;
  return {
    ...(env as NodeJS.ProcessEnv),
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    ...(noLazyFetch ? { GIT_NO_LAZY_FETCH: "1" } : {}),
  };
}

/** A git command, hardened (GIT_SETTINGS); stdout as bytes */
export function git(args: string[], opts: { input?: string; noLazyFetch?: boolean } = {}): { status: number; stdout: Buffer; stderr: string } {
  const r = spawnSync("git", [...GIT_SETTINGS.flatMap((s) => ["-c", s]), ...args], {
    env: gitEnv(!!opts.noLazyFetch),
    input: opts.input,
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error) throw new Error(`git could not start (${r.error.message}): fetching from Speed Dreams' repositories needs git`);
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString() };
}

/** A git command that must succeed; its output */
function gitOk(args: string[], what: string, opts: { input?: string; noLazyFetch?: boolean } = {}): Buffer {
  const r = git(args, opts);
  if (r.status !== 0) {
    const why = r.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${r.status}`;
    throw new Error(`${what}: git ${args.filter((a) => a !== "-q").slice(args[0] === "-C" ? 2 : 0, 4).join(" ")} failed (${why})`);
  }
  return r.stdout;
}

/** A git object's id for these bytes as a blob (SHA-1, or SHA-256 for a 64-digit id) */
export function gitBlobId(bytes: Uint8Array, like = "0".repeat(40)): string {
  return createHash(like.length === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

/** `git ls-tree` of `commit` at `paths` (all of it when none), `-r` when `recursive` */
export function lsTree(repo: string, commit: string, paths: string[], what: string, opts: { recursive?: boolean; dirsOnly?: boolean } = {}): TreeEntry[] {
  const flags = [...(opts.recursive ? ["-r"] : []), ...(opts.dirsOnly ? ["-d"] : [])];
  const out = gitOk(["-C", repo, "ls-tree", "-z", "--full-tree", ...flags, commit, "--", ...paths], what, { noLazyFetch: true }).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(line);
      if (!m) throw new Error(`${what}: git ls-tree gave an unexpected line (${JSON.stringify(line.slice(0, 80))})`);
      return { mode: m[1], type: m[2], oid: m[3], path: m[4] };
    });
}

/** A regular file in a tree: a blob of mode 100644 or 100755 (not a link, 120000, nor a submodule, 160000) */
function assertRegular(e: TreeEntry, what: string): void {
  if (e.type === "blob" && (e.mode === "100644" || e.mode === "100755")) return;
  const kind = e.mode === "120000" ? "a link" : e.type === "commit" ? "a submodule" : `${e.type} of mode ${e.mode}`;
  throw new Error(`${what}: ${e.path} is ${kind} in the repository: refused`);
}

/** The blobs a partial clone hasn't got yet, fetched in as few requests as the command line allows */
function fetchBlobs(repo: string, oids: string[], what: string): void {
  if (!oids.length) return;
  const have = gitOk(["-C", repo, "cat-file", "--batch-check"], what, { input: `${oids.join("\n")}\n`, noLazyFetch: true }).toString("utf8");
  const missing = [...new Set(have.split("\n").filter((l) => / missing$/.test(l)).map((l) => l.split(" ")[0]))];
  for (let i = 0; i < missing.length; i += 400) {
    gitOk(["-C", repo, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--filter=blob:none", "origin", ...missing.slice(i, i + 400)], what);
  }
}

/** A blob's bytes, checked against its id */
function readBlob(repo: string, oid: string, what: string): Buffer {
  const bytes = gitOk(["-C", repo, "cat-file", "blob", oid], what, { noLazyFetch: true });
  if (gitBlobId(bytes, oid) !== oid) throw new Error(`${what}: object ${oid} doesn't hash to its id`);
  return bytes;
}

/**
 * The files under `prefix` (a folder's path in the tree, or "" for all of it) in `commit` of `repo`, written into
 * `into` (a new folder) without the prefix. A link or a submodule in it, or a path that isn't a safe relative one,
 * refuses the whole tree before anything is written. Returns how many files it wrote
 */
export function writeTree(repo: string, commit: string, prefix: string, into: string, what: string): number {
  const entries = lsTree(repo, commit, prefix ? [prefix] : [], what, { recursive: true });
  if (!entries.length) throw new Error(`${what}: nothing at ${prefix || "the root"} in ${commit}`);
  const files = entries.map((e) => {
    assertRegular(e, what);
    const rel = safeRelative(prefix ? e.path.slice(prefix.length + 1) : e.path);
    if (!rel || (prefix && !e.path.startsWith(`${prefix}/`))) throw new Error(`${what}: ${JSON.stringify(e.path)} is not a safe path: refused`);
    return { rel, oid: e.oid };
  });
  fetchBlobs(repo, files.map((f) => f.oid), what);
  for (const f of files) writeNew(under(into, f.rel), readBlob(repo, f.oid, what));
  return files.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// speed-dreams-data: the shared data
// ---------------------------------------------------------------------------------------------------------------------

/** The bare clone of speed-dreams-data with the pinned commit's trees (fetched once, again when the pin moves) */
function dataRepo(): { repo: string; url: string; commit: string } {
  const { repo: url, commit } = readPins().data;
  const what = "speed-dreams-data";
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${PINS_FILE}: speed-dreams-data's pin (${commit}) is not a commit id`);
  const repo = DATA_REPO_DIR;
  if (!existsSync(join(repo, "HEAD"))) {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    gitOk(["init", "-q", "--bare", repo], what);
    gitOk(["-C", repo, "remote", "add", "origin", url], what);
  } else if (gitOk(["-C", repo, "remote", "get-url", "origin"], what).toString("utf8").trim() !== url) {
    gitOk(["-C", repo, "remote", "set-url", "origin", url], what);
  }
  if (git(["-C", repo, "cat-file", "-e", `${commit}^{commit}`], { noLazyFetch: true }).status !== 0) {
    console.log(`      fetching speed-dreams-data's file list at ${commit.slice(0, 12)} from ${url}…`);
    gitOk(["-C", repo, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--depth", "1", "--filter=blob:none", "origin", commit], what);
  }
  return { repo, url, commit };
}

/** The cache's data folder, emptied when it holds another commit's files */
function dataFolder(url: string, commit: string): string {
  const recorded = readSdSource<DataSource>(SD_DATA_DIR);
  if (recorded?.commit !== commit || recorded.repository !== url) {
    rmSync(SD_DATA_DIR, { recursive: true, force: true });
    mkdirSync(SD_DATA_DIR, { recursive: true });
    writeSource(SD_DATA_DIR, { from: "speed-dreams-data", repository: url, commit } satisfies DataSource);
  }
  return SD_DATA_DIR;
}

/**
 * Files of the game's data folder (paths in speed-dreams-data's data/: `data/tracks/surfaces.xml`,
 * `cars/categories/LS-GT2.xml`) at the pinned commit, in the cache's data folder: each one there checked against its id
 * in the commit's tree, and the missing or different fetched in one go. Their paths in the cache, in order; null for a
 * file the commit hasn't got
 */
export function sdDataFiles(paths: string[], what = "Speed Dreams' shared data"): (string | null)[] {
  if (!paths.length) return [];
  const rels = paths.map((p) => {
    const rel = safeRelative(p);
    if (!rel) throw new Error(`${what}: ${JSON.stringify(p)} is not a path in the game's data folder`);
    return rel;
  });
  const { repo, url, commit } = dataRepo();
  const dir = dataFolder(url, commit);
  const listed = new Map(lsTree(repo, commit, [...new Set(rels)].map((r) => `data/${r}`), what).map((e) => [e.path, e]));
  const todo = new Map<string, string>();
  const out = rels.map((rel) => {
    const e = listed.get(`data/${rel}`);
    if (!e) return null;
    assertRegular(e, what);
    const file = under(dir, rel);
    const fresh = existsSync(file) && lstatSync(file).isFile() && gitBlobId(readFileSync(file), e.oid) === e.oid;
    if (!fresh) todo.set(file, e.oid);
    return file;
  });
  if (todo.size) {
    console.log(`      fetching ${todo.size} file(s) of Speed Dreams' shared data (speed-dreams-data at ${commit.slice(0, 12)})…`);
    fetchBlobs(repo, [...todo.values()], what);
    for (const [file, oid] of todo) writeReplacing(file, readBlob(repo, oid, what));
  }
  return out;
}

/** The names of the files in a folder of the game's data folder (`data/textures`) at the pinned commit */
export function sdDataListing(folder: string): string[] {
  const rel = safeRelative(folder);
  if (!rel) throw new Error(`${JSON.stringify(folder)} is not a folder of the game's data folder`);
  const { repo, commit } = dataRepo();
  return lsTree(repo, commit, [`data/${rel}/`], "speed-dreams-data")
    .filter((e) => e.type === "blob")
    .map((e) => e.path.slice(`data/${rel}/`.length));
}

/**
 * The shared data a circuit's trackdef includes (SHARED_TRACK_FILES, Speed Dreams' default surfaces among them), in
 * the cache; returns the cache's data folder, which scripts/tracks/extract_sd_track.py takes as --sd-data
 */
export function sdBaseData(): string {
  sdDataFiles(SHARED_TRACK_FILES.map((f) => `data/tracks/${f}`), "Speed Dreams' default surfaces");
  return SD_DATA_DIR;
}

/**
 * The shared textures by these names, in whichever of the formats Speed Dreams reads the shared data has each one in
 * (a circuit names `road.rgb`, the data may hold `road.png`), in the cache's data/textures
 */
export function fetchSdTextures(names: string[]): void {
  if (!names.length) return;
  const stem = (n: string) => n.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const formats = [".png", ".rgb", ".jpg", ".jpeg", ".sgi", ".bmp", ".tga"];
  const listing = sdDataListing("data/textures");
  const byName = new Map(listing.map((f) => [f.toLowerCase(), f]));
  const files = new Set<string>();
  for (const n of names) {
    const hit = byName.get(n.toLowerCase()) ?? formats.map((f) => byName.get(stem(n) + f)).find(Boolean);
    if (hit) files.add(hit);
  }
  if (files.size) sdDataFiles([...files].map((f) => `data/textures/${f}`), "Speed Dreams' shared textures");
}

/** A car category's file (`cars/categories/<category>.xml`) from the pinned shared data */
export function sdCategoryFile(category: string): string {
  if (!plainFileName(category)) throw new Error(`the car's category (${JSON.stringify(category)}) is not a plain name`);
  const [file] = sdDataFiles([`cars/categories/${category}.xml`], `category ${category}`);
  if (!file) throw new Error(`category ${category}: speed-dreams-data has no cars/categories/${category}.xml`);
  return file;
}

/** A file cars share (`objects/wheel0.acc`, `sound/<sample>.wav`) from the pinned shared data, or null when it has none */
export function sdSharedFile(folder: "objects" | "sound" | "textures", name: string): string | null {
  if (!plainFileName(name)) throw new Error(`${JSON.stringify(name)} is not a plain file name`);
  return sdDataFiles([`data/${folder}/${name}`], name)[0];
}

// ---------------------------------------------------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------------------------------------------------

/** The folder under `root` that holds a trackdef named <directory>.xml, or the only folder with a trackdef */
function findCircuitFolder(root: string, directory: string): string | null {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (!st.isFile()) continue;
      else if (f.toLowerCase() === `${directory.toLowerCase()}.xml`) hits.unshift(dir);
      else if (f.toLowerCase().endsWith(".xml") && !f.toLowerCase().endsWith(".prj.xml") && /Track Segments/.test(readFileSync(p, "latin1"))) hits.push(dir);
    }
  };
  walk(root);
  return hits[0] ?? null;
}

/** A circuit the shared data carries (Jarama), from the pinned commit */
function fetchDataCircuit(name: string, dir: string, cached: CircuitSource | null): string {
  const { repo, commit } = dataRepo();
  if (cached?.from === "speed-dreams-data" && cached.commit === commit) return dir;
  const what = `circuit ${name}`;
  const path = lsTree(repo, commit, ["data/tracks"], what, { recursive: true, dirsOnly: true })
    .map((e) => e.path)
    .find((t) => t.split("/").length === 4 && t.split("/")[3].toLowerCase() === name.toLowerCase());
  if (!path) {
    const names = circuitCatalogue().map((e) => e.directory);
    throw new Error(`no Speed Dreams circuit "${name}": the circuits are ${names.join(", ")}, and jarama`);
  }
  console.log(`      fetching ${path} from speed-dreams-data at ${commit.slice(0, 12)}…`);
  const part = workFolder(dirname(dir), name);
  try {
    writeTree(repo, commit, path, part, what);
    writeSource(part, {
      from: "speed-dreams-data",
      directory: path.split("/")[3],
      repository: readPins().data.repo,
      commit,
      page: `${readPins().data.repo.replace(/\.git$/, "")}/src/commit/${commit}/${path}`,
    } satisfies CircuitSource);
    replaceFolder(part, dir);
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
  return dir;
}

/**
 * One of Speed Dreams' circuits, by its folder name, in the cache: the archive its asset database lists, downloaded
 * and checked against its pinned sha256, or a circuit of the shared data (Jarama); fetched again when its pin moves
 */
export async function fetchSdCircuit(name: string): Promise<string> {
  if (!plainFileName(name)) throw new Error(`"${name}" is not a circuit's folder name`);
  const entry = circuitCatalogue().find((e) => e.directory.toLowerCase() === name.toLowerCase());
  const directory = entry?.directory ?? name;
  if (!plainFileName(directory)) throw new Error(`${CIRCUITS_FILE}: "${directory}" is not a folder name`);
  const dir = join(SD_CACHE_DIR, "circuits", directory);
  const cached = readSdSource<CircuitSource>(dir);
  if (!entry) return fetchDataCircuit(name, dir, cached);

  if (cached?.from === "asset-database" && cached.sha256 === entry.sha256 && cached.archive === entry.archive) return dir;
  console.log(`      fetching ${entry.name} (revision ${entry.revision}, ${(entry.bytes / 1e6).toFixed(1)} MB) from ${entry.archive}…`);
  const data = await download(entry.archive, entry.name);
  const sum = sha256(data);
  if (sum !== entry.sha256) {
    throw new Error(
      `${entry.archive} is not the archive this importer pins (sha256 ${sum}, not ${entry.sha256}): Speed Dreams may have published a new revision. Update ${CIRCUITS_FILE} from https://www.speed-dreams.net/assets.json`,
    );
  }
  const part = workFolder(dirname(dir), directory);
  try {
    await extractZip(data, part, entry.archive);
    const folder = findCircuitFolder(part, entry.directory);
    if (!folder) throw new Error(`${entry.archive}: no trackdef XML in the archive`);
    writeSource(folder, {
      from: "asset-database",
      directory: entry.directory,
      archive: entry.archive,
      sha256: entry.sha256,
      revision: entry.revision,
      page: entry.page,
      license: entry.license,
      author: entry.author,
    } satisfies CircuitSource);
    replaceFolder(folder, dir);
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------------------------------------------------

/** What identifies a pinned car's files: its repository and commit, or its zip and the zip's sha256 */
const pinKey = (p: PinnedCar) => (p.commit ? `git ${p.repo} ${p.commit}` : `zip ${p.zip} ${p.sha256}`);

/** A car's repository at `commit`, fetched into a scratch bare repository and written out of it into `into` */
function fetchCarCommit(repoUrl: string, commit: string, into: string, what: string): void {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${what}: its pin (${commit}) is not a commit id`);
  const scratch = workFolder(SD_CACHE_DIR, "git");
  try {
    gitOk(["init", "-q", "--bare", scratch], what);
    gitOk(["-C", scratch, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--depth", "1", repoUrl, commit], what);
    writeTree(scratch, commit, "", into, what);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The database's zip of a car, checked against its sha256, into `into` (its `<car>/` folder's files) */
async function fetchCarZip(pin: PinnedCar, car: string, into: string): Promise<void> {
  const bytes = await download(pin.zip!, car);
  const sum = sha256(bytes);
  if (sum !== pin.sha256) throw new Error(`${car}: the downloaded zip's sha256 is ${sum}, not the pinned ${pin.sha256}`);
  // Its files sit in `<car>/` (the database's asset layout); anything beside that folder is left out, as the game does
  const n = await extractZip(bytes, into, pin.zip!, (p) => (p.startsWith(`${car}/`) ? p.slice(car.length + 1) : null));
  if (!n) throw new Error(`${car}: the zip has no ${car}/ folder`);
}

/** Downloads `car` at its pinned revision into the cache; returns the car's folder. A car there at the same pin is kept */
export async function fetchSdCar(car: string): Promise<string> {
  const pins = readPins();
  const pin = Object.hasOwn(pins.cars, car) ? pins.cars[car] : undefined;
  if (!pin) {
    const near = Object.keys(pins.cars).filter((c) => c.includes(car) || car.includes(c.split("-").pop() ?? "\0"));
    throw new Error(`"${car}" is not among the Speed Dreams cars pinned in ${PINS_FILE}${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
  }
  if (!plainFileName(car)) throw new Error(`${PINS_FILE}: "${car}" is not a folder name`);
  const dir = join(SD_CACHE_DIR, "cars", car);
  const recorded = fetchedSource(dir);
  if (recorded && pinKey(recorded.pinned) === pinKey(pin)) {
    console.log(`      ${car}: already in the cache at ${pin.commit ?? pin.sha256}`);
    return dir;
  }
  console.log(`      fetching ${car} (${pin.commit ? `${pin.repo} at ${pin.commit}` : pin.zip})`);
  const part = workFolder(dirname(dir), car);
  try {
    if (pin.commit && pin.repo) fetchCarCommit(pin.repo, pin.commit, part, car);
    else if (pin.zip && pin.sha256) await fetchCarZip(pin, car, part);
    else throw new Error(`${PINS_FILE}: ${car} is pinned to neither a commit nor a zip and its sha256`);
    writeSource(part, { car, pinned: pin, url: pin.commit ? `${pin.repo!.replace(/\.git$/, "")}/src/commit/${pin.commit}` : pin.zip! } satisfies FetchedSource);
    replaceFolder(part, dir);
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
  return dir;
}
