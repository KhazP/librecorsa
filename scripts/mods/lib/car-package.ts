/**
 * A car the converters made (a GLB laid out as the game's rig expects, docs/PORTING-CARS.md) as a mod package: its
 * model, picture, liveries, sound bank and physics patch put where mod.json names them (`cars/<id>/…`), and the car
 * listed in mod.json. The importers (scripts/mods/importers) call this once their converter has written the files.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ModCar, ModCarClass, ModCredit, ModSkin } from "../../../src/lib/mods/mod-manifest";
import { PACKAGE_FILE } from "../../../src/lib/mods/mod-store";
import { MOD_PHYSICS_FORMAT } from "../../../src/lib/mods/mod-physics";
import { readOrStartManifest, withCar, writeManifest, type PackageInfo } from "./manifest-file";
import { checkPackage, relPath, walk, type Checked } from "./package-check";

/** Texture files a livery folder may hold (and its thumb.webp) */
const SKIN_FILE = /\.(png|jpe?g|webp|ktx2)$/i;

export interface CarSkinSource {
  id: string;
  name: string;
  swatch: ModSkin["swatch"];
  /** A folder of the livery's files, named as the model's own textures (port_ac_car.py --skins-out writes them) */
  dir: string;
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
}

export interface PackagedCar {
  contentId: string;
  checked: Checked;
  skipped: string[];
}

/** Copies the files of `from` a package may carry (`accept`) into `to`, and lists the ones it may not */
function copyFolder(from: string, to: string, accept: RegExp, skipped: string[]): void {
  for (const file of walk(from).files) {
    const rel = relPath(from, file);
    if (!accept.test(rel)) {
      skipped.push(`${from}/${rel}`);
      continue;
    }
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    copyFileSync(file, join(to, rel));
  }
}

export function packageCar(opts: CarPackageOptions): PackagedCar {
  const { car } = opts;
  if (!existsSync(opts.model)) throw new Error(`${opts.model}: no such model`);
  const folder = `cars/${car.localId}`;
  const target = join(opts.packageDir, folder);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const skipped: string[] = [];

  copyFileSync(opts.model, join(target, `${car.localId}.glb`));
  if (opts.thumb) {
    if (extname(opts.thumb).toLowerCase() === ".webp") copyFileSync(opts.thumb, join(target, "thumb.webp"));
    else skipped.push(`${opts.thumb} (the car browser's picture is a thumb.webp)`);
  }
  const skins: ModSkin[] = [{ id: opts.paint.id, name: opts.paint.name, swatch: opts.paint.swatch }];
  for (const s of opts.skins ?? []) {
    copyFolder(s.dir, join(target, "skins", s.id), SKIN_FILE, skipped);
    skins.push({ id: s.id, name: s.name, swatch: s.swatch, ...(s.variant ? { variant: s.variant } : {}) });
  }
  let sound: ModCar["sound"];
  if ("dir" in opts.sound) {
    copyFolder(opts.sound.dir, join(target, "audio"), PACKAGE_FILE, skipped);
    sound = { dir: `${folder}/audio`, limiterRpm: Math.round(opts.sound.limiterRpm) };
  } else sound = { car: opts.sound.car };

  let physics: ModCar["physics"] = car.base;
  if (car.physicsPatch && Object.keys(car.physicsPatch).length) {
    writeFileSync(join(target, "physics.json"), `${JSON.stringify({ format: MOD_PHYSICS_FORMAT, profile: car.physicsPatch }, null, 2)}\n`);
    physics = { base: car.base, file: `${folder}/physics.json` };
  }

  const entry: ModCar = {
    id: car.localId,
    title: car.title,
    sub: car.sub,
    badge: car.badge,
    classId: car.classId,
    year: car.year,
    physics,
    model: `${folder}/${car.localId}.glb`,
    ...(car.bodyPlan ? { bodyPlan: car.bodyPlan } : {}),
    skins,
    sound,
    ...(car.credit ? { credit: car.credit } : {}),
  };
  writeManifest(opts.packageDir, withCar(readOrStartManifest(opts.packageDir, opts.info), entry));
  return { contentId: `mod:${opts.info.id}/${car.localId}`, checked: checkPackage(opts.packageDir), skipped };
}
