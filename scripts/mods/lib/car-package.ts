/**
 * A car the converters made (a GLB laid out as the game's rig expects, docs/PORTING-CARS.md) as a mod package: its
 * model, picture, liveries, sound bank and physics patch put where mod.json names them (`cars/<id>/…`), and the car
 * listed in mod.json. The importers (scripts/mods/importers) call this once their converter has written the files.
 * Every id and path is checked before anything is deleted or written (package-paths.ts): ids as mod.json takes them,
 * every target inside the package, every source a plain file (a link in a livery or sound folder is refused).
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { isSafeModPath } from "../../../src/lib/mods/mod-manifest";
import type { ModCar, ModCarClass, ModCredit, ModSkin } from "../../../src/lib/mods/mod-manifest";
import { PACKAGE_FILE } from "../../../src/lib/mods/mod-store";
import { MOD_PHYSICS_FORMAT } from "../../../src/lib/mods/mod-physics";
import { readOrStartManifest, withCar, writeManifest, type PackageInfo } from "./manifest-file";
import { checkPackage, relPath, walk, type Checked } from "./package-check";
import { assertLocalId, packageTarget, sourceFile } from "./package-paths";

/** Texture files a livery folder may hold (and its thumb.webp) */
const SKIN_FILE = /\.(png|jpe?g|webp|ktx2)$/i;

export interface CarSkinSource {
  id: string;
  name: string;
  swatch: ModSkin["swatch"];
  /**
   * A folder of the livery's files, named as the model's own textures (port_ac_car.py --skins-out writes them), and its
   * picture in the picker (thumb.webp)
   */
  dir: string;
  /** The files it changes, when only some of the model's livery files (each in `dir`). Absent: all of them */
  files?: string[];
  variant?: string;
}

export interface CarPackageOptions {
  packageDir: string;
  info: PackageInfo;
  car: {
    /** Its id in the package (at most 16 characters: localIdFrom) */
    localId: string;
    title: string;
    sub: string;
    badge: string;
    classId: ModCarClass;
    year: number;
    /** The vehicle model it drives as (src/lib/cars/vehicle-models.ts) */
    base: string;
    /**
     * Its own physics: the values of the base model's profile it changes (src/lib/mods/mod-physics.ts), written as
     * cars/<id>/physics.json. Absent: it drives exactly as the base
     */
    physicsPatch?: Record<string, unknown>;
    /** Its body's outline at barrier height, [x, z] metres (scripts/cars/measure-car-plans.ts) */
    bodyPlan?: [number, number][];
    credit?: ModCredit;
  };
  /** The GLB */
  model: string;
  /** Its picture in the car browser (a .webp) */
  thumb?: string;
  /** The paint the model was made in: the car's first livery */
  paint: { id: string; name: string; swatch: ModSkin["swatch"] };
  /** Liveries as files */
  skins?: CarSkinSource[];
  /** A sound bank folder (engine_ext_on/off_<rpm>.ogg and its json) with the limiter it was recorded to, or a game car's */
  sound: { dir: string; limiterRpm: number } | { car: string };
  /** Files to put in the package as they are (a licence, the source's readme): `to` is the path in the package */
  extraFiles?: { from: string; to: string }[];
}

export interface PackagedCar {
  contentId: string;
  checked: Checked;
  skipped: string[];
}

/** A file to copy into the package */
interface Copy {
  from: string;
  to: string;
}

/**
 * The files of `from` a package may carry (`accept`), each as a copy to `<packageDir>/<to>/<its path>`; the ones it may
 * not are listed in `skipped`. A symbolic link in the folder is refused
 */
function folderCopies(from: string, packageDir: string, to: string, accept: RegExp, skipped: string[], what: string): Copy[] {
  if (!existsSync(from)) throw new Error(`${what}: ${from} doesn't exist`);
  const { files, links } = walk(from);
  if (links.length) throw new Error(`${what}: ${links[0]} is a symbolic link, which is never copied into a package`);
  const out: Copy[] = [];
  for (const file of files) {
    const rel = relPath(from, file);
    if (!accept.test(rel) || !isSafeModPath(rel)) {
      skipped.push(`${from}/${rel}`);
      continue;
    }
    out.push({ from: sourceFile(file, what, from), to: packageTarget(packageDir, `${to}/${rel}`, what) });
  }
  return out;
}

export function packageCar(opts: CarPackageOptions): PackagedCar {
  const { car } = opts;
  // Every id and path checked before anything is deleted or written
  const localId = assertLocalId(car.localId, "the car's id in the package");
  assertLocalId(opts.paint.id, "the car's paint");
  const skinIds = new Set([opts.paint.id]);
  for (const s of opts.skins ?? []) {
    assertLocalId(s.id, `livery ${s.name}`);
    if (skinIds.has(s.id)) throw new Error(`livery ${s.name}: the id ${s.id} is the car's twice`);
    skinIds.add(s.id);
  }
  const folder = `cars/${localId}`;
  const target = packageTarget(opts.packageDir, folder, "the car's folder");
  const skipped: string[] = [];
  const copies: Copy[] = [{ from: sourceFile(opts.model, "the model"), to: packageTarget(opts.packageDir, `${folder}/${localId}.glb`, "the model") }];
  if (opts.thumb) {
    if (extname(opts.thumb).toLowerCase() === ".webp") copies.push({ from: sourceFile(opts.thumb, "the picture"), to: packageTarget(opts.packageDir, `${folder}/thumb.webp`, "the picture") });
    else skipped.push(`${opts.thumb} (the car browser's picture is a thumb.webp)`);
  }
  const skins: ModSkin[] = [{ id: opts.paint.id, name: opts.paint.name, swatch: opts.paint.swatch }];
  for (const s of opts.skins ?? []) {
    copies.push(...folderCopies(s.dir, opts.packageDir, `${folder}/skins/${s.id}`, SKIN_FILE, skipped, `livery ${s.id}`));
    skins.push({ id: s.id, name: s.name, swatch: s.swatch, ...(s.files ? { files: s.files } : {}), ...(s.variant ? { variant: s.variant } : {}) });
  }
  let sound: ModCar["sound"];
  if ("dir" in opts.sound) {
    copies.push(...folderCopies(opts.sound.dir, opts.packageDir, `${folder}/audio`, PACKAGE_FILE, skipped, "the sound bank"));
    sound = { dir: `${folder}/audio`, limiterRpm: Math.round(opts.sound.limiterRpm) };
  } else sound = { car: opts.sound.car };
  for (const f of opts.extraFiles ?? []) copies.push({ from: sourceFile(f.from, `extraFiles ${f.to}`), to: packageTarget(opts.packageDir, f.to, "extraFiles") });

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const c of copies) {
    mkdirSync(dirname(c.to), { recursive: true });
    copyFileSync(c.from, c.to);
  }

  let physics: ModCar["physics"] = car.base;
  if (car.physicsPatch && Object.keys(car.physicsPatch).length) {
    writeFileSync(join(target, "physics.json"), `${JSON.stringify({ format: MOD_PHYSICS_FORMAT, profile: car.physicsPatch }, null, 2)}\n`);
    physics = { base: car.base, file: `${folder}/physics.json` };
  }

  const entry: ModCar = {
    id: localId,
    title: car.title,
    sub: car.sub,
    badge: car.badge,
    classId: car.classId,
    year: car.year,
    physics,
    model: `${folder}/${localId}.glb`,
    ...(car.bodyPlan ? { bodyPlan: car.bodyPlan } : {}),
    skins,
    sound,
    ...(car.credit ? { credit: car.credit } : {}),
  };
  writeManifest(opts.packageDir, withCar(readOrStartManifest(opts.packageDir, opts.info), entry));
  return { contentId: `mod:${opts.info.id}/${localId}`, checked: checkPackage(opts.packageDir), skipped };
}
