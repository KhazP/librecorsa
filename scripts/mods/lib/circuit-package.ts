/**
 * A circuit the converters built (public/tracks/<id>/: track_data.json, its model, its scenery) as a mod package: the
 * track data and the files it names copied into the package under the circuit's own folder (what else the build
 * holds, a hosted site's texture variants and pictures, the game never loads from a package), the model and scenery
 * renamed from the game's `/tracks/<id>/…` URLs to paths in the package, and the circuit listed in mod.json. The converters write the listing
 * beside the files (`circuit.json`) when run with `--no-register`; a circuit already in the game's list
 * (public/tracks/index.json) is read from there. Every path is checked before anything is written or deleted
 * (package-paths.ts): a file the track data names must be a plain file inside the build, and lands inside the package.
 * The track data's own credit (`metadata.credit`, what the builder was given) is set to the circuit's in the package,
 * so the two never disagree on its licence.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isSafeModPath, type ModCircuitType, type ModCredit, type ModTrack } from "../../../src/lib/mods/mod-manifest";
import { PACKAGE_FILE } from "../../../src/lib/mods/mod-store";
import { packageCredit, readOrStartManifest, withTrack, writeManifest, type PackageInfo, type SourceCredit } from "./manifest-file";
import { checkPackage, relPath, walk, type Checked } from "./package-check";
import { assertLocalId, isInside, packageTarget, sourceFile } from "./package-paths";
import { BUILT_TRACKS_DIR } from "./toolchain";

/** A circuit's listing as the converters write it (port_ac_track.py `index_entry`) */
export interface CircuitEntry {
  id: string;
  name: string;
  layout: string;
  country: string;
  city: string;
  lengthM: number;
  turns: number;
  direction: "clockwise" | "anticlockwise";
  credit?: SourceCredit;
  type?: string;
  defaultTimeOfDay?: string;
}

export interface CircuitPackageOptions {
  /** The built circuit's id (its folder in public/tracks/, the `/tracks/<id>/` its track data names) */
  builtId: string;
  /** Its folder, when not public/tracks/<builtId> */
  buildDir?: string;
  /** The package folder to write into (made if missing; a package already there keeps its other content) */
  packageDir: string;
  info: PackageInfo;
  /** The circuit's id in the package (default: made from the built id) */
  localId: string;
  /** What the listing should say instead of the converter's */
  listing?: Partial<Pick<ModTrack, "name" | "layout" | "country" | "city" | "type" | "defaultTimeOfDay">>;
  /** The circuit's own credit, when it differs from the package's (default: the converter's, if it names an author) */
  credit?: ModCredit;
  /** Files to put in the package as they are (a licence): `to` is the path in the package */
  extraFiles?: { from: string; to: string }[];
  /** Delete the built folder afterwards (never one the game lists) */
  removeBuild?: boolean;
}

export interface PackagedCircuit {
  /** Its content id in the game (`mod:<package>/<circuit>`) */
  contentId: string;
  checked: Checked;
  /** Files of the build the track data doesn't name, left out */
  skipped: string[];
}

const CIRCUIT_TYPES: readonly ModCircuitType[] = ["permanent", "street", "oval", "hillclimb"];

/** The circuit's listing: circuit.json beside its files, else its entry in the game's list */
export function readCircuitEntry(buildDir: string, builtId: string): CircuitEntry {
  const own = join(buildDir, "circuit.json");
  if (existsSync(own)) return JSON.parse(readFileSync(own, "utf8")) as CircuitEntry;
  const index = join(BUILT_TRACKS_DIR, "index.json");
  const listed = existsSync(index) ? (JSON.parse(readFileSync(index, "utf8")) as CircuitEntry[]).find((e) => e.id === builtId) : undefined;
  if (!listed) throw new Error(`${buildDir}: no circuit.json (build it with --no-register) and ${builtId} is not in public/tracks/index.json`);
  return listed;
}

/** Whether the game lists this circuit as its own (its folder is never deleted) */
const gameListsCircuit = (builtId: string): boolean => {
  const index = join(BUILT_TRACKS_DIR, "index.json");
  return existsSync(index) && (JSON.parse(readFileSync(index, "utf8")) as { id: string }[]).some((e) => e.id === builtId);
};

/**
 * A built circuit's URL for one of its files as the file's path in the build (`rel`), checked: one of the circuit's
 * own files (`/tracks/<built id>/…`), a path a package may use (no `..`), a plain file inside the build. Anything
 * else is refused
 */
function packagePath(value: unknown, builtId: string, buildDir: string, what: string): string {
  const prefix = `/tracks/${builtId}/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${what}: ${JSON.stringify(value)} is not one of the circuit's own files (${prefix}…); a package carries only its own`);
  }
  const rel = value.slice(prefix.length);
  if (!isSafeModPath(rel) || !isInside(buildDir, resolve(buildDir, rel))) throw new Error(`${what}: ${JSON.stringify(value)} is not a path a package may use`);
  return rel;
}

export function packageCircuit(opts: CircuitPackageOptions): PackagedCircuit {
  // Every path checked before anything is deleted or written
  const localId = assertLocalId(opts.localId, "the circuit's id in the package");
  if (!opts.buildDir && !/^[A-Za-z0-9_-]+$/.test(opts.builtId)) throw new Error(`${JSON.stringify(opts.builtId)} is not a built circuit's id (its folder in public/tracks/)`);
  const buildDir = resolve(opts.buildDir ?? join(BUILT_TRACKS_DIR, opts.builtId));
  const dataPath = join(buildDir, "track_data.json");
  if (!existsSync(dataPath)) throw new Error(`${buildDir}: no track_data.json (has the circuit been built?)`);
  const entry = readCircuitEntry(buildDir, opts.builtId);
  const target = packageTarget(opts.packageDir, localId, "the circuit's folder");

  // The track data, naming its model and scenery by their paths in the package
  const text = readFileSync(dataPath, "utf8");
  const data = JSON.parse(text) as { metadata?: { mesh?: { url?: unknown; scenery?: unknown }; credit?: unknown; author?: unknown } };
  const mesh = data.metadata?.mesh;
  const named: string[] = [];
  const rename = (value: unknown, what: string): string => {
    const rel = packagePath(value, opts.builtId, buildDir, what);
    named.push(rel);
    return `${localId}/${rel}`;
  };
  if (mesh) {
    if (mesh.url !== undefined) mesh.url = rename(mesh.url, "metadata.mesh.url");
    if (Array.isArray(mesh.scenery)) mesh.scenery = mesh.scenery.map((s, i) => rename(s, `metadata.mesh.scenery[${i}]`));
  }
  const copies = named.map((rel) => {
    const from = join(buildDir, rel);
    if (!existsSync(from)) throw new Error(`${dataPath} names ${rel}, which the build hasn't got`);
    if (!PACKAGE_FILE.test(rel)) throw new Error(`${rel}: not a file type a package may carry`);
    return { from: sourceFile(from, `${dataPath} names ${rel}`, buildDir), to: packageTarget(opts.packageDir, `${localId}/${rel}`, rel) };
  });
  const extras = (opts.extraFiles ?? []).map((f) => ({ from: sourceFile(f.from, `extraFiles ${f.to}`), to: packageTarget(opts.packageDir, f.to, "extraFiles") }));

  // The circuit's own credit, when it isn't the package's; the track data says the same
  const own = opts.credit ?? (entry.credit?.author ? packageCredit(entry.credit) : undefined);
  const credit = own && JSON.stringify(own) !== JSON.stringify(opts.info.credit) ? own : undefined;
  if (data.metadata) {
    const said = own ?? opts.info.credit;
    data.metadata.credit = said;
    data.metadata.author = `${said.author} (${said.license})`;
  }

  // Those files, and only those
  rmSync(target, { recursive: true, force: true });
  for (const c of [...copies, ...extras]) {
    mkdirSync(dirname(c.to), { recursive: true });
    copyFileSync(c.from, c.to);
  }
  const skipped = walk(buildDir)
    .files.map((f) => relPath(buildDir, f))
    .filter((rel) => rel !== "circuit.json" && rel !== "track_data.json" && !named.includes(rel));
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "track_data.json"), text.includes("\n  ") ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data));

  // Its listing in mod.json
  const type = opts.listing?.type ?? (CIRCUIT_TYPES.includes(entry.type as ModCircuitType) ? (entry.type as ModCircuitType) : undefined);
  const track: ModTrack = {
    id: localId,
    name: opts.listing?.name ?? entry.name,
    layout: opts.listing?.layout ?? entry.layout,
    country: opts.listing?.country ?? entry.country,
    city: opts.listing?.city ?? entry.city,
    lengthM: Math.round(entry.lengthM),
    turns: entry.turns,
    direction: entry.direction,
    data: `${localId}/track_data.json`,
    ...(type ? { type } : {}),
    ...((opts.listing?.defaultTimeOfDay ?? entry.defaultTimeOfDay) ? { defaultTimeOfDay: opts.listing?.defaultTimeOfDay ?? entry.defaultTimeOfDay } : {}),
    ...(credit ? { credit } : {}),
  } as ModTrack;
  writeManifest(opts.packageDir, withTrack(readOrStartManifest(opts.packageDir, opts.info), track));

  // Only a working copy in public/tracks/ (never the folder itself, never one the game lists)
  if (opts.removeBuild && !gameListsCircuit(opts.builtId) && buildDir.startsWith(BUILT_TRACKS_DIR + sep) && isInside(BUILT_TRACKS_DIR, buildDir)) {
    rmSync(buildDir, { recursive: true, force: true });
  }
  return { contentId: `mod:${opts.info.id}/${localId}`, checked: checkPackage(opts.packageDir), skipped };
}
