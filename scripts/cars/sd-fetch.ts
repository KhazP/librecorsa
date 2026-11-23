/**
 * Speed Dreams cars from the project's own public repositories, at pinned revisions (speed-dreams-cars.json). Speed
 * Dreams moved from SourceForge's Subversion to forge.a-lec.org, where each car now has a git repository of its own
 * and the shared data (the car categories among it) lives in speed-dreams-data; the official asset database
 * (speed-dreams.net/assets.json) lists the cars the game offers. A few cars are only in that database, as a zip.
 *
 * A fetched car lands in the cache laid out as in the game's data folder, so the importer finds its category beside it:
 *
 *   scripts/mods/.cache/speed-dreams/cars/models/<car>/      the car's files, and .sd-source.json (where they came from)
 *   scripts/mods/.cache/speed-dreams/cars/categories/<cat>.xml
 *
 * The forge refuses bursts of requests (HTTP 429): a refused download waits and tries again.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../mods/lib/toolchain";
import { readZip } from "../../src/lib/mods/zip-reader";
import { SdParams } from "../lib/sd-params";

export const SD_CACHE_DIR = join(REPO_ROOT, "scripts", "mods", ".cache", "speed-dreams");

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
  data: { repo: string; commit: string };
  code: { repo: string; commit: string };
  cars: Record<string, PinnedCar>;
}

export const PINS_FILE = join(__dirname, "speed-dreams-cars.json");
export const readPins = (): Pins => JSON.parse(readFileSync(PINS_FILE, "utf8")) as Pins;

/** Where a fetched car records its source */
export const SOURCE_FILE = ".sd-source.json";

export interface FetchedSource {
  car: string;
  pinned: PinnedCar;
  /** A link to the exact files: the commit's tree, or the zip */
  url: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A GET that waits and retries while the forge says it is busy (429, 5xx) */
async function download(url: string, what: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": "librecorsa-mod-tool" } });
    } catch (err) {
      if (attempt >= 4) throw new Error(`${what}: ${url} could not be fetched (${(err as Error).message})`);
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 20_000 * (attempt + 1);
      console.log(`      ${what}: the server is busy (HTTP ${res.status}), trying again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${what}: ${url} answered HTTP ${res.status}`);
  }
}

const git = (args: string[]) => spawnSync("git", args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });

/** The car's repository at `commit` into `into` (no .git kept): git when there is one, else the forge's archive */
async function fetchCommit(repo: string, commit: string, into: string, what: string): Promise<void> {
  if (git(["--version"]).status === 0) {
    mkdirSync(into, { recursive: true });
    const steps = [["init", "-q", into], ["-C", into, "fetch", "-q", "--depth", "1", repo, commit], ["-C", into, "checkout", "-q", "FETCH_HEAD"]];
    let ok = true;
    for (const s of steps) {
      const r = git(s);
      if (r.status !== 0) {
        console.log(`      git ${s.slice(s[0] === "-C" ? 2 : 0, 3).join(" ")} failed (${(r.stderr || "").trim().split("\n").pop()}); fetching the archive instead`);
        ok = false;
        break;
      }
    }
    rmSync(join(into, ".git"), { recursive: true, force: true });
    if (ok) return;
    rmSync(into, { recursive: true, force: true });
  }
  // The forge's archive of the commit: a .tar.gz with the repository's files under one folder
  const tgz = await download(`${repo.replace(/\.git$/, "")}/archive/${commit}.tar.gz`, what);
  const tmp = mkdtempSync(join(dirname(into), ".tar-"));
  try {
    writeFileSync(join(tmp, "a.tar.gz"), tgz);
    const r = spawnSync("tar", ["-xzf", "a.tar.gz", "--strip-components", "1", "-C", tmp], { cwd: tmp, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${what}: the archive could not be unpacked (${r.stderr})`);
    rmSync(join(tmp, "a.tar.gz"));
    renameSync(tmp, into);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** The database's zip of a car, checked against its sha256, into `into` (its one top folder's contents) */
async function fetchZip(pin: PinnedCar, car: string, into: string): Promise<void> {
  const bytes = await download(pin.zip!, car);
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== pin.sha256) throw new Error(`${car}: the downloaded zip's sha256 is ${sum}, not the pinned ${pin.sha256}`);
  for (const entry of await readZip(bytes)) {
    if (entry.path.endsWith("/")) continue;
    // Its files sit in `<car>/` (the database's asset layout); anything beside that folder is ignored, as the game does
    const rel = entry.path.startsWith(`${car}/`) ? entry.path.slice(car.length + 1) : null;
    if (!rel || rel.split("/").some((p) => p === ".." || p === "")) continue;
    mkdirSync(dirname(join(into, rel)), { recursive: true });
    writeFileSync(join(into, rel), await entry.read());
  }
}

/** A car category's XML from the pinned speed-dreams-data, into the cache (once) */
export async function fetchCategory(category: string, cacheDir = SD_CACHE_DIR): Promise<string> {
  const out = join(cacheDir, "cars", "categories", `${category}.xml`);
  if (existsSync(out)) return out;
  const { data } = readPins();
  const base = data.repo.replace(/\.git$/, "");
  const bytes = await download(`${base}/raw/commit/${data.commit}/data/cars/categories/${encodeURIComponent(category)}.xml`, `category ${category}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  return out;
}

/**
 * A file of the game's shared data from the pinned speed-dreams-data, into the cache (once): `objects/wheel0.acc` (the
 * default wheels), `sound/<sample>.wav` (an engine sample several cars share). Laid out as the game's data folder,
 * `<cache>/data/<file>`, beside the cars
 */
export async function fetchShared(file: string, cacheDir = SD_CACHE_DIR): Promise<string> {
  const out = join(cacheDir, "data", ...file.split("/"));
  if (existsSync(out)) return out;
  const { data } = readPins();
  const base = data.repo.replace(/\.git$/, "");
  const bytes = await download(`${base}/raw/commit/${data.commit}/data/data/${file.split("/").map(encodeURIComponent).join("/")}`, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  return out;
}

/**
 * Downloads `car` at its pinned revision into the cache, and its category beside it; returns the car's folder. A car
 * already there at the same revision is kept
 */
export async function fetchSdCar(car: string, cacheDir = SD_CACHE_DIR): Promise<string> {
  const pins = readPins();
  const pin = pins.cars[car];
  if (!pin) {
    const near = Object.keys(pins.cars).filter((c) => c.includes(car) || car.includes(c.split("-").pop() ?? "\0"));
    throw new Error(`"${car}" is not among the Speed Dreams cars pinned in ${PINS_FILE}${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
  }
  const dir = join(cacheDir, "cars", "models", car);
  const source: FetchedSource = {
    car,
    pinned: pin,
    url: pin.commit ? `${pin.repo!.replace(/\.git$/, "")}/src/commit/${pin.commit}` : pin.zip!,
  };
  const recorded = existsSync(join(dir, SOURCE_FILE)) ? (JSON.parse(readFileSync(join(dir, SOURCE_FILE), "utf8")) as FetchedSource) : null;
  if (recorded && recorded.url === source.url) {
    console.log(`      ${car}: already in the cache at ${pin.commit ?? pin.sha256}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    console.log(`      fetching ${car} (${pin.commit ? `${pin.repo} at ${pin.commit}` : pin.zip})`);
    if (pin.commit) await fetchCommit(pin.repo!, pin.commit, dir, car);
    else {
      mkdirSync(dir, { recursive: true });
      await fetchZip(pin, car, dir);
    }
    writeFileSync(join(dir, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  }
  // Its category, as its XML names it (the database's category is a display name)
  const xml = join(dir, `${car}.xml`);
  const category = existsSync(xml) ? SdParams.read(xml).str("Car", "category") : undefined;
  if (category) await fetchCategory(category, cacheDir).catch((err) => console.log(`      its category: ${(err as Error).message}`));
  return dir;
}

/** What a car folder records of where it came from (a fetched one), or null */
export function fetchedSource(carDir: string): FetchedSource | null {
  const p = join(carDir, SOURCE_FILE);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as FetchedSource) : null;
}
