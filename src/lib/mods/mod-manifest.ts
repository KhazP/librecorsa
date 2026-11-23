/**
 * The mod package format: a folder (or a zip of one) with a `mod.json` at its root and the files it names beside it.
 * A package is data only, never code: the game's origin holds a player's driver key and saves, so nothing a package
 * carries is ever run. docs/modding.md describes the format for modders; this file is its one definition.
 *
 * A package adds circuits, liveries for existing cars, and cars (a new body and sound on one of the game's vehicle
 * models). Everything it adds is named `mod:<package>/<id>`, so it can never take the place of the game's own content,
 * and every list, board and room can tell it apart (`isModContentId`).
 *
 * Its files are served at `/mods/<package>/<path>`: from the browser's own storage after an import (mod-store.ts,
 * answered by public/sw.js), from `public/mods/<package>/` in a clone of the repository, or from the launcher's
 * `mods/` folder.
 */

/** The manifest format this build reads */
export const MOD_FORMAT_VERSION = 1;

/** Every id a package's content takes starts with this */
export const MOD_ID_PREFIX = "mod:";

/** Where a package's files are served */
export const MODS_PATH = "/mods";

/**
 * `author.name`: lowercase, the author's name first so two modders' packages never share an id. With a local id, a
 * content id (`mod:` + package + `/` + local) stays within 62 characters: the room protocol carries ids of up to 64
 * (net/wire.ts). Its `:` and `/` are outside the lap board's id grammar (`[A-Za-z0-9_-]`, cloudflare/api/lap-check.ts),
 * so the board refuses a mod circuit's laps on its own as well.
 */
const PACKAGE_ID = /^[a-z0-9][a-z0-9_-]{0,15}\.[a-z0-9][a-z0-9_-]{0,23}$/;
/** A circuit, car or livery id within a package */
const LOCAL_ID = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ModDirection = "clockwise" | "anticlockwise";
export type ModCircuitType = "permanent" | "street" | "oval" | "hillclimb";
export type ModCarClass = "f1" | "gt3" | "proto" | "classic" | "road";
const DIRECTIONS: readonly ModDirection[] = ["clockwise", "anticlockwise"];
const CIRCUIT_TYPES: readonly ModCircuitType[] = ["permanent", "street", "oval", "hillclimb"];
const CAR_CLASSES: readonly ModCarClass[] = ["f1", "gt3", "proto", "classic", "road"];
const TIMES_OF_DAY = ["dawn", "morning", "noon", "afternoon", "golden_hour", "dusk", "night"] as const;

export interface ModCredit {
  author: string;
  /** The mod's page */
  url?: string;
  /** The author's own page */
  authorUrl?: string;
  license: string;
  licenseUrl?: string;
  note?: string;
}

/** A circuit: the fields of a `public/tracks/index.json` entry, and its track data file in the package */
export interface ModTrack {
  id: string;
  name: string;
  layout: string;
  country: string;
  city: string;
  lengthM: number;
  turns: number;
  direction: ModDirection;
  type?: ModCircuitType;
  /** Its `track_data.json` (scripts/tracks write one); the model and scenery it names are paths in the package too */
  data: string;
  defaultTimeOfDay?: (typeof TIMES_OF_DAY)[number];
  /** Who made it, when not the package's author */
  credit?: ModCredit;
}

/** A livery: its files' folder in the package, swapped onto the car's model by material name as the game's own are */
export interface ModSkin {
  id: string;
  name: string;
  swatch: [string, string] | [string, string, string];
  /** The folder of its files (absent: `skins/<id>`) */
  dir?: string;
  /** The files it has, when it changes only some of what a livery can */
  files?: string[];
  /** The model's part variant it wears (absent: "base") */
  variant?: string;
}

/** A livery for one of the game's cars */
export interface ModCarSkin extends ModSkin {
  /** The game's car it is for (`CarId`) */
  car: string;
}

/** A car's engine sound: a sound bank folder in the package, or the sound of one of the game's cars */
export type ModCarSound = { dir: string; limiterRpm: number } | { car: string };

/** A car: a body and sound on one of the game's vehicle models, or on a physics file in the package */
export interface ModCar {
  id: string;
  title: string;
  sub: string;
  badge: string;
  classId: ModCarClass;
  year: number;
  /**
   * What drives it: one of the game's vehicle models (`VehicleModelId`), whose setups, tyres and AI it takes, or a
   * physics file in the package (mod-physics.ts), for a car with physics of its own
   */
  physics: string | { file: string };
  /** Its body: a GLB in the package, built as scripts/cars/port_ac_car.py builds the game's own */
  model: string;
  /** Its outline at barrier height (`[x, z]` points, half the car, nose first), when the body differs from the model's own */
  bodyPlan?: [number, number][];
  skins?: ModSkin[];
  sound: ModCarSound;
  /** Who made it, when not the package's author */
  credit?: ModCredit;
}

export interface ModManifest {
  format: typeof MOD_FORMAT_VERSION;
  id: string;
  name: string;
  version: string;
  description?: string;
  credit: ModCredit;
  tracks?: ModTrack[];
  cars?: ModCar[];
  skins?: ModCarSkin[];
}

export type ManifestResult = { ok: true; manifest: ModManifest } | { ok: false; errors: string[] };

// --- Ids and paths ---

export const isModPackageId = (value: unknown): value is string => typeof value === "string" && PACKAGE_ID.test(value);

/** Whether an id names a package's content rather than the game's own */
export const isModContentId = (id: unknown): id is string => typeof id === "string" && id.startsWith(MOD_ID_PREFIX);

/** `mod:<package>/<id>` */
export const modContentId = (packageId: string, localId: string): string => `${MOD_ID_PREFIX}${packageId}/${localId}`;

/** The package and local id of a `mod:` id; null for anything else */
export function parseModContentId(id: string): { packageId: string; localId: string } | null {
  if (!isModContentId(id)) return null;
  const rest = id.slice(MOD_ID_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const packageId = rest.slice(0, slash);
  const localId = rest.slice(slash + 1);
  return PACKAGE_ID.test(packageId) && LOCAL_ID.test(localId) ? { packageId, localId } : null;
}

/**
 * Whether a path in a package is safe to serve: relative, forward slashes, no `.`/`..` segment, no scheme, nothing a
 * server or the zip reader could resolve outside the package's folder
 */
export function isSafeModPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 240) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes("?") || path.includes("#")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** A package file's URL (relative to the base path) */
export const modFileUrl = (packageId: string, path: string): string =>
  `${MODS_PATH}/${packageId}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** A package folder's URL, with its trailing slash */
export const modDirUrl = (packageId: string, dir: string): string => `${modFileUrl(packageId, dir.replace(/\/+$/, ""))}/`;

// --- Validation ---

class Problems {
  readonly list: string[] = [];
  add(where: string, what: string): void {
    if (this.list.length < 50) this.list.push(`${where}: ${what}`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(p: Problems, where: string, v: unknown, opts: { max?: number; optional?: boolean } = {}): string | undefined {
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    p.add(where, "must be a non-empty string");
    return undefined;
  }
  if (v.length > (opts.max ?? 200)) p.add(where, `must be at most ${opts.max ?? 200} characters`);
  return v;
}

function num(p: Problems, where: string, v: unknown, min: number, max: number, opts: { optional?: boolean; integer?: boolean } = {}): number | undefined {
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (opts.integer && !Number.isInteger(v))) {
    p.add(where, `must be ${opts.integer ? "an integer" : "a number"} from ${min} to ${max}`);
    return undefined;
  }
  return v;
}

function oneOf<T extends string>(p: Problems, where: string, v: unknown, options: readonly T[], optional = false): T | undefined {
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
    p.add(where, `must be one of ${options.join(", ")}`);
    return undefined;
  }
  return v as T;
}

function path(p: Problems, where: string, v: unknown, ext?: RegExp, optional = false): string | undefined {
  if (v === undefined && optional) return undefined;
  if (!isSafeModPath(v)) {
    p.add(where, "must be a relative path inside the package (no leading /, no .., no backslashes)");
    return undefined;
  }
  if (ext && !ext.test(v)) p.add(where, `must end in ${ext.source.replace(/[\\$]/g, "")}`);
  return v;
}

function localId(p: Problems, where: string, v: unknown, seen: Set<string>): string | undefined {
  if (typeof v !== "string" || !LOCAL_ID.test(v)) {
    p.add(where, "must be lowercase letters, digits, - or _ (at most 16)");
    return undefined;
  }
  if (seen.has(v)) p.add(where, `"${v}" is used twice`);
  seen.add(v);
  return v;
}

function credit(p: Problems, where: string, v: unknown, optional: boolean): ModCredit | undefined {
  if (v === undefined && optional) return undefined;
  if (!isRecord(v)) {
    p.add(where, "must be an object with author and license");
    return undefined;
  }
  return {
    author: str(p, `${where}.author`, v.author, { max: 80 }) ?? "",
    url: httpsUrl(p, `${where}.url`, v.url),
    authorUrl: httpsUrl(p, `${where}.authorUrl`, v.authorUrl),
    license: str(p, `${where}.license`, v.license, { max: 120 }) ?? "",
    licenseUrl: httpsUrl(p, `${where}.licenseUrl`, v.licenseUrl),
    note: str(p, `${where}.note`, v.note, { max: 500, optional: true }),
  };
}

function httpsUrl(p: Problems, where: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^https:\/\/[^\s]+$/.test(v) || v.length > 500) {
    p.add(where, "must be an https:// address");
    return undefined;
  }
  return v;
}

function swatch(p: Problems, where: string, v: unknown): ModSkin["swatch"] {
  if (!Array.isArray(v) || (v.length !== 2 && v.length !== 3) || !v.every((c) => typeof c === "string" && HEX_COLOUR.test(c))) {
    p.add(where, 'must be two or three "#rrggbb" colours');
    return ["#808080", "#404040"];
  }
  return v as ModSkin["swatch"];
}

function skin(p: Problems, where: string, v: unknown, seen: Set<string>): ModSkin | undefined {
  if (!isRecord(v)) {
    p.add(where, "must be an object");
    return undefined;
  }
  const id = localId(p, `${where}.id`, v.id, seen);
  const files = v.files === undefined ? undefined : Array.isArray(v.files) ? v.files : (p.add(`${where}.files`, "must be a list"), undefined);
  const out: ModSkin = {
    id: id ?? "",
    name: str(p, `${where}.name`, v.name, { max: 80 }) ?? "",
    swatch: swatch(p, `${where}.swatch`, v.swatch),
    dir: path(p, `${where}.dir`, v.dir, undefined, true),
    files: files?.map((f, i) => path(p, `${where}.files[${i}]`, f, /\.(png|jpe?g|webp|ktx2)$/i) ?? ""),
    variant: str(p, `${where}.variant`, v.variant, { max: 64, optional: true }),
  };
  return out;
}

function list<T>(p: Problems, where: string, v: unknown, max: number, item: (v: unknown, where: string) => T | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    p.add(where, "must be a list");
    return undefined;
  }
  if (v.length > max) p.add(where, `may hold at most ${max}`);
  return v.slice(0, max).map((x, i) => item(x, `${where}[${i}]`)).filter((x): x is T => x !== undefined);
}

/**
 * Checks a parsed `mod.json` and returns it typed, or every problem found (up to 50), each naming where it is.
 * `knownCars` and `knownVehicles` are the game's car and vehicle model ids, which liveries and cars may name.
 */
export function validateModManifest(
  raw: unknown,
  known: { cars: ReadonlySet<string>; vehicles: ReadonlySet<string> },
): ManifestResult {
  const p = new Problems();
  if (!isRecord(raw)) return { ok: false, errors: ["mod.json: must be a JSON object"] };
  if (raw.format !== MOD_FORMAT_VERSION) {
    p.add("format", `must be ${MOD_FORMAT_VERSION} (this game reads mod format ${MOD_FORMAT_VERSION})`);
    return { ok: false, errors: p.list };
  }
  if (!isModPackageId(raw.id)) p.add("id", 'must be "author.name": lowercase letters, digits, - or _, one dot (author at most 16, name at most 24)');
  const manifest: ModManifest = {
    format: MOD_FORMAT_VERSION,
    id: typeof raw.id === "string" ? raw.id : "",
    name: str(p, "name", raw.name, { max: 80 }) ?? "",
    version: str(p, "version", raw.version, { max: 32 }) ?? "",
    description: str(p, "description", raw.description, { max: 1000, optional: true }),
    credit: credit(p, "credit", raw.credit, false) ?? { author: "", license: "" },
  };

  const trackIds = new Set<string>();
  manifest.tracks = list(p, "tracks", raw.tracks, 32, (v, where) => {
    if (!isRecord(v)) return void p.add(where, "must be an object");
    return {
      id: localId(p, `${where}.id`, v.id, trackIds) ?? "",
      name: str(p, `${where}.name`, v.name, { max: 80 }) ?? "",
      layout: str(p, `${where}.layout`, v.layout, { max: 80 }) ?? "",
      country: str(p, `${where}.country`, v.country, { max: 60 }) ?? "",
      city: str(p, `${where}.city`, v.city, { max: 60 }) ?? "",
      lengthM: num(p, `${where}.lengthM`, v.lengthM, 100, 100_000) ?? 0,
      turns: num(p, `${where}.turns`, v.turns, 0, 500, { integer: true }) ?? 0,
      direction: oneOf(p, `${where}.direction`, v.direction, DIRECTIONS) ?? "clockwise",
      type: oneOf(p, `${where}.type`, v.type, CIRCUIT_TYPES, true),
      data: path(p, `${where}.data`, v.data, /\.json$/i) ?? "",
      defaultTimeOfDay: oneOf(p, `${where}.defaultTimeOfDay`, v.defaultTimeOfDay, TIMES_OF_DAY, true),
      credit: credit(p, `${where}.credit`, v.credit, true),
    } satisfies ModTrack;
  });

  const skinIds = new Set<string>();
  manifest.skins = list(p, "skins", raw.skins, 256, (v, where) => {
    const s = skin(p, where, v, skinIds);
    if (!s || !isRecord(v)) return undefined;
    if (typeof v.car !== "string" || !known.cars.has(v.car)) {
      p.add(`${where}.car`, `must be one of the game's cars (${[...known.cars].join(", ")})`);
      return undefined;
    }
    return { ...s, car: v.car } satisfies ModCarSkin;
  });

  const carIds = new Set<string>();
  manifest.cars = list(p, "cars", raw.cars, 16, (v, where) => {
    if (!isRecord(v)) return void p.add(where, "must be an object");
    let physics: ModCar["physics"] = "";
    if (typeof v.physics === "string") {
      if (known.vehicles.has(v.physics)) physics = v.physics;
      else p.add(`${where}.physics`, `must be one of the game's vehicle models (${[...known.vehicles].join(", ")}) or { "file": "<physics.json>" }`);
    } else if (isRecord(v.physics)) {
      physics = { file: path(p, `${where}.physics.file`, v.physics.file, /\.json$/i) ?? "" };
    } else p.add(`${where}.physics`, "must name a vehicle model or a physics file");
    let sound: ModCarSound = { car: "" };
    if (isRecord(v.sound) && v.sound.dir !== undefined) {
      sound = { dir: path(p, `${where}.sound.dir`, v.sound.dir) ?? "", limiterRpm: num(p, `${where}.sound.limiterRpm`, v.sound.limiterRpm, 1000, 25_000) ?? 0 };
    } else if (isRecord(v.sound) && typeof v.sound.car === "string" && known.cars.has(v.sound.car)) {
      sound = { car: v.sound.car };
    } else p.add(`${where}.sound`, 'must be { "dir": "<folder>", "limiterRpm": <rpm> } or { "car": "<a game car id>" }');
    const plan = v.bodyPlan;
    let bodyPlan: [number, number][] | undefined;
    if (plan !== undefined) {
      const okPlan = Array.isArray(plan) && plan.length >= 3 && plan.length <= 64 &&
        plan.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 10));
      if (okPlan) bodyPlan = plan as [number, number][];
      else p.add(`${where}.bodyPlan`, "must be 3 to 64 [x, z] points in metres");
    }
    const carSkinIds = new Set<string>();
    return {
      id: localId(p, `${where}.id`, v.id, carIds) ?? "",
      title: str(p, `${where}.title`, v.title, { max: 80 }) ?? "",
      sub: str(p, `${where}.sub`, v.sub, { max: 120 }) ?? "",
      badge: str(p, `${where}.badge`, v.badge, { max: 16 }) ?? "",
      classId: oneOf(p, `${where}.classId`, v.classId, CAR_CLASSES) ?? "road",
      year: num(p, `${where}.year`, v.year, 1890, 2100, { integer: true }) ?? 2000,
      physics,
      model: path(p, `${where}.model`, v.model, /\.glb$/i) ?? "",
      bodyPlan,
      skins: list(p, `${where}.skins`, v.skins, 64, (s, w) => skin(p, w, s, carSkinIds)),
      sound,
      credit: credit(p, `${where}.credit`, v.credit, true),
    } satisfies ModCar;
  });

  if (!manifest.tracks?.length && !manifest.cars?.length && !manifest.skins?.length) {
    p.add("mod.json", "adds nothing: list at least one of tracks, cars or skins");
  }
  return p.list.length ? { ok: false, errors: p.list } : { ok: true, manifest };
}

/** Every file a manifest names directly (track data files, models, livery files when listed, physics files) */
export function manifestFiles(m: ModManifest): string[] {
  const files = new Set<string>(["mod.json"]);
  for (const t of m.tracks ?? []) files.add(t.data);
  for (const c of m.cars ?? []) {
    files.add(c.model);
    if (typeof c.physics === "object") files.add(c.physics.file);
  }
  return [...files];
}

// --- Content hash ---

/** A file's SHA-256 as lowercase hex */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A package's content hash: the SHA-256 of its files' paths and hashes, sorted by path. Two copies of a package are the
 * same content exactly when this matches, whatever order their files were zipped or listed in. Online rooms compare it.
 */
export async function packageHash(fileHashes: Readonly<Record<string, string>>): Promise<string> {
  const lines = Object.keys(fileHashes)
    .sort()
    .map((p) => `${p}\t${fileHashes[p]}\n`)
    .join("");
  return sha256Hex(new TextEncoder().encode(lines));
}

export const isSha256Hex = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v);
