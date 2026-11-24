/**
 * A Speed Dreams car as a mod package: its folder (`…/cars/models/<car>/`: the XML, the AC3D models, textures and
 * engine sample) converted into the game's car rig, liveries, picture, sound bank and a physics patch on the closest of
 * the game's vehicle models. `--fetch <car>` downloads one of the cars the official asset database lists, at the
 * revision scripts/cars/speed-dreams-cars.json pins, into scripts/mods/.cache/speed-dreams/ (lib/sd-fetch.ts).
 *
 *   1. its parameters: the car's XML merged over its category's (scripts/lib/sd-params.ts), the category found beside
 *      the car as in the game's data folder, else taken from the pinned shared data;
 *   2. its licence (lib/licences.ts): every statement file in its folder, each a livery's when its name names one, and
 *      the headers of its XML and its category's; the official list's entry only for a car fetched at the revision it
 *      pins and with no statement file of its own. A car that isn't clearly shareable is refused, unless `--personal`;
 *      a livery whose own statement isn't is left out; a shared wheel or engine sample is checked against Speed Dreams'
 *      own terms for its data. Anything packaged that isn't shareable makes the package for personal use only;
 *   3. its physics (scripts/cars/sd-car-physics.ts) on the closest base, the aero matched by driving it
 *      (lib/aero-fit.ts), checked as the game checks a physics file, then driven headless (lib/car-sanity.ts): flat out
 *      on a straight to its top speed, braking, and a lap of the bundled circuit on the autopilot;
 *   4. its model (scripts/cars/port_sd_car.py) and sound (scripts/audio/port_sd_sound.py: Speed Dreams' one engine
 *      sample resampled to its pitch at each rpm of the bank);
 *   5. the package (lib/car-package.ts), with the licence texts (when shareable), the car's and its liveries'
 *      statements and a CONVERSION.md of what was mapped where and what was left out.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { packageCar, type CarSkinSource } from "../lib/car-package";
import { importTarget, PACKAGE_USAGE, parseImportArgs, type Importer } from "../lib/importer";
import { localIdFrom, packageCredit, packageIdFrom } from "../lib/manifest-file";
import { report } from "../lib/package-check";
import { runPython, REPO_ROOT } from "../lib/toolchain";
import { fitAero, withAero, type AeroFit } from "../lib/aero-fit";
import { driveSanity, type SanityResult } from "../lib/car-sanity";
import { SdParams } from "../../lib/sd-params";
import { sdAeroTargets, sdCarPhysics, PHYSICS_BASES, SD_KEYS_NOT_CARRIED, type SdCar, type SdPhysics } from "../../cars/sd-car-physics";
import {
  authorLine,
  carriedName,
  creditLicence,
  decodeText,
  isShareable,
  licenceTextFiles,
  mergeNames,
  mergeReadings,
  readLicenceEntry,
  readLicenceText,
  statementFiles,
  statementParts,
  xmlLeadingComments,
  type LicenceReading,
  type Statement,
} from "../lib/licences";
import { fetchedSource, fetchSdCar, plainFileName, readPins, SD_DATA_DIR, sdCategoryFile, sdSharedFile, type PinnedCar } from "../lib/sd-fetch";
import { modSimProfile, MOD_PHYSICS_FORMAT } from "../../../src/lib/mods/mod-physics";
import { VEHICLE_MODELS } from "../../../src/lib/cars/vehicle-models";
import type { CarSimProfile } from "../../../src/lib/sim/f12026-car/F12026CarSim";
import type { VehicleModelId } from "../../../src/types/f1";
import type { ModCarClass, ModCredit } from "../../../src/lib/mods/mod-manifest";
import { getActiveTrackData } from "../../../src/lib/track-data";
import { loadGlbGeometry } from "../../lib/glb-geometry";

const CLASSES: ModCarClass[] = ["f1", "gt3", "proto", "classic", "road"];

/** The game's car whose sound a class borrows when the car has no sample of its own */
const SOUND_BY_CLASS: Record<ModCarClass, string> = { f1: "lc26", gt3: "amg-gt3", proto: "mtr-496r", classic: "porsche-934-rsr", road: "vw-scirocco-gtx" };

/** The game's shared folders: in the Speed Dreams install the car sits in (`cars/models/<car>`), then in the cache */
function sharedDirs(carDir: string): { objects: string[]; textures: string[]; sound: string[] } {
  const data = [join(carDir, "..", "..", "..", "data"), join(SD_DATA_DIR, "data")];
  return {
    objects: data.map((d) => join(d, "objects")).filter(existsSync),
    textures: data.map((d) => join(d, "textures")).filter(existsSync),
    sound: data.map((d) => join(d, "sound")).filter(existsSync),
  };
}

const findIn = (dirs: string[], file: string) => dirs.map((d) => join(d, file)).find((p) => existsSync(p));

/**
 * A file name the car's XML gives (its category, its wheel models, its engine sample), checked to be a plain one before
 * it is looked for anywhere: `../../x.wav` would reach outside the car's folder and the shared data
 */
function plainName(name: string, where: string, car: string): string {
  if (!plainFileName(name)) throw new Error(`${car}: ${where} is ${JSON.stringify(name)}, which is not a plain file name`);
  return name;
}

/** The liveries a car folder has: `<car>-<id>.<image>` that is no texture of its own (the formats port_sd_car.py reads) */
function liveryCandidates(carDir: string, car: string): string[] {
  const re = new RegExp(`^${car.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(.+)\\.(png|jpe?g|rgb|bmp|tga)$`, "i");
  const ids = new Set<string>();
  for (const f of readdirSync(carDir)) {
    const m = re.exec(f);
    if (!m) continue;
    const id = m[1].replace(/-preview$/i, "");
    if (!/^(preview|int|rpm|speed|src|template)$/i.test(id)) ids.add(id);
  }
  return [...ids].sort();
}

/** "3.6 L V8 · rear-wheel drive" */
function subLine(car: SdCar, year: number): string {
  const e = car.engine;
  const layout = e.cylinders ? `${(e.shape ?? "").toLowerCase() === "v" ? "V" : (e.shape ?? "").toLowerCase() === "h" ? "flat-" : (e.shape ?? "").toLowerCase() === "w" ? "W" : "straight-"}${e.cylinders}` : "";
  const engine = [e.capacityL ? `${e.capacityL.toFixed(1)} L` : "", layout].filter(Boolean).join(" ");
  const drive = car.drive === "FWD" ? "front-wheel drive" : car.drive === "4WD" ? "four-wheel drive" : "rear-wheel drive";
  return [String(year), engine, drive].filter(Boolean).join(" · ");
}

/** The highest speed the car's power and gearing allow against its drag (km/h) */
function expectedTopSpeed(car: SdCar, drag: number): number {
  const kw = Math.max(...car.engine.torque.filter(([rpm]) => rpm <= car.engine.limiterRpm).map(([rpm, nm]) => (nm * rpm * Math.PI) / 30 / 1000));
  const byPower = Math.cbrt((kw * 1000 * car.gears.efficiency) / Math.max(0.05, drag));
  const top = car.gears.ratios[car.gears.ratios.length - 1] * car.diff.ratio;
  const byGearing = ((car.engine.limiterRpm * Math.PI) / 30 / top) * car.tyres.rear.radius;
  return Math.min(byPower, byGearing) * 3.6;
}

/**
 * Each livery's id in the package (16 characters at most): its own made into one, and where two come out alike, the
 * later one numbered
 */
export function liveryLocalIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of ids) {
    let local = localIdFrom(id);
    for (let n = 2; taken.has(local); n++) local = `${localIdFrom(id).slice(0, 16 - `-${n}`.length).replace(/[-_]+$/, "")}-${n}`;
    taken.add(local);
    out.set(id, local);
  }
  return out;
}

/** The car's id in the package: its folder's name, without its category's prefix when it is too long */
function carLocalId(car: string): string {
  if (car.length <= 16) return localIdFrom(car);
  return localIdFrom(car.replace(/^[a-z0-9]+-/i, ""));
}

/**
 * The official list's entry for a car fetched at the revision it pins: the folder is named for the car and its record
 * (.sd-source.json) names this car and the repository and commit, or zip and sha256, speed-dreams-cars.json pins. Null
 * for anything else: a folder from an install or elsewhere, a record that doesn't match its pin. The fetcher writes the
 * record; this is the check before the list's licence and authors are taken for the car's
 */
export function pinnedCar(carDir: string, car: string): PinnedCar | null {
  let recorded: ReturnType<typeof fetchedSource> = null;
  try {
    recorded = fetchedSource(carDir);
  } catch {
    return null;
  }
  const pin = readPins().cars[car];
  if (!recorded || !pin || recorded.car !== car || basename(carDir) !== car) return null;
  const same = pin.commit ? recorded.pinned.repo === pin.repo && recorded.pinned.commit === pin.commit : recorded.pinned.zip === pin.zip && recorded.pinned.sha256 === pin.sha256;
  return same ? pin : null;
}

/** A car's licence statements, read */
export interface CarLicence {
  /** The car's own statement files: those whose names name no livery */
  statements: Statement[];
  /** The car's licence came from the official list (fetched at its pin, with no statement file of its own) */
  fromList: boolean;
  /** The car's statements (or the list's entry), with the headers of its XML and its category's */
  reading: LicenceReading;
  /** Each livery with statements of its own, and what they say */
  liveries: Record<string, { files: Statement[]; reading: LicenceReading }>;
}

/** An XML file's header notice, read (its copyright holders are the file's, not the car's authors) */
function headerReading(file: string | undefined): LicenceReading | null {
  if (!file || !existsSync(file)) return null;
  const notice = xmlLeadingComments(decodeText(readFileSync(file)));
  return notice.trim() ? { ...readLicenceText(notice), holders: [] } : null;
}

/** A reading that must name a licence: one that names none gets that as its problem */
const namingOne = (r: LicenceReading, what: string): LicenceReading => (r.licences.length ? r : { ...r, problems: [...r.problems, `${what} name no licence this tool knows`] });

/**
 * The licence statements of the car in `carDir` (named `car`): every statement file in its folder, a livery's when its
 * name names one of `liveryIds` (`<car>-<livery>-readme.txt`, `Cavallo_Roxfall_readme.txt`), else the car's; the
 * official list's entry (`pin`, from pinnedCar) only when the car has none of its own; and the header notices of its
 * XML and of its category's (`category`)
 */
export function carLicence(carDir: string, car: string, liveryIds: readonly string[], opts: { pin: PinnedCar | null; category?: string }): CarLicence {
  const statements: Statement[] = [];
  const byLivery: Record<string, Statement[]> = {};
  for (const s of statementFiles(carDir)) {
    const parts = statementParts(s.file, car, liveryIds);
    if (!parts.length) statements.push(s);
    for (const id of parts) (byLivery[id] ??= []).push(s);
  }
  const liveries: CarLicence["liveries"] = {};
  for (const [id, files] of Object.entries(byLivery)) {
    liveries[id] = { files, reading: namingOne(mergeReadings(files.map((f) => f.reading)), files.map((f) => f.file).join(", ")) };
  }
  const fromList = !statements.length && !!opts.pin;
  const art = statements.length
    ? namingOne(mergeReadings(statements.map((s) => s.reading)), statements.map((s) => s.file).join(", "))
    : opts.pin
      ? readLicenceEntry(opts.pin.license)
      : { licences: [], problems: ["no readme or licence file in the car's folder, and it wasn't fetched at the revision the official list pins"], holders: [] };
  const headers = [headerReading(join(carDir, `${car}.xml`)), headerReading(opts.category)].filter((r): r is LicenceReading => !!r);
  return { statements, fromList, reading: mergeReadings([art, ...headers]), liveries };
}

/**
 * Speed Dreams' terms for its shared data (speed-dreams-data's README at the pinned commit): "non-functional data is
 * licensed under the Free Art License by default", and the folders with other terms say so in a credits file
 */
const SD_DATA_DEFAULT: LicenceReading = { licences: ["FAL-1.3"], problems: [], holders: [] };
/** The shared data's folders that carry credits of their own, at the pinned commit */
const SD_DATA_CREDITS: Record<string, { folder: "sound"; file: string }> = { sound: { folder: "sound", file: "SoundCredits.txt" } };

/**
 * The licence of one of Speed Dreams' shared files a car uses (`rel`: `objects/wheel0.acc`, `sound/engine-1.wav`, found
 * at `path`): the entry that names it in its folder's credits (data/sound/SoundCredits.txt lists each sample's), else
 * Speed Dreams' default for its data
 */
function sharedFileReading(path: string, rel: string): { reading: LicenceReading; from: string } {
  const statements = statementFiles(dirname(path));
  const credits = SD_DATA_CREDITS[rel.split("/")[0]];
  if (credits) {
    try {
      // The credits file at the pinned commit, from the cache's data (fetched and checked against the pin as needed)
      const pinned = sdSharedFile(credits.folder, credits.file);
      if (!pinned) throw new Error("not in the pinned data");
      if (!statements.some((s) => s.path === pinned)) statements.push(...statementFiles(dirname(pinned)).filter((s) => s.path === pinned));
    } catch (err) {
      const from = `${credits.folder}/${credits.file}`;
      return { reading: { licences: [], problems: [`Speed Dreams' credits for it (${from}) could not be fetched: ${(err as Error).message}`], holders: [] }, from };
    }
  }
  const stem = basename(rel).replace(/\.[^.]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const s of statements) {
    const entry = s.text.replace(/\r/g, "").split(/\n\s*\n/).find((b) => new RegExp(`(?<![a-z0-9_-])${stem}(?![a-z0-9_-])`, "i").test(b));
    if (entry) return { reading: namingOne(readLicenceText(entry), `${s.file}'s entry for ${basename(rel)}`), from: s.file };
  }
  return { reading: SD_DATA_DEFAULT, from: "Speed Dreams' default for its data" };
}

const md = (s: string) => s.replace(/\|/g, "\\|");

/** CONVERSION.md: what came from where, and what didn't */
function conversionReport(o: {
  car: string;
  title: string;
  source: string;
  phys: SdPhysics;
  fit: AeroFit;
  targets: { front: number; rear: number; drag: number };
  sanity: SanityResult | null;
  sound: string;
  licence: string;
  authors: string;
  leftOutLiveries: string[];
}): string {
  const p = o.phys;
  const lines = [
    `# ${o.title}: converted from Speed Dreams`,
    "",
    `- Source: ${o.source}`,
    `- Authors: ${o.authors}`,
    `- Licence: ${o.licence}`,
    `- Physics: a patch on the \`${p.base}\` model (${p.reason}).`,
    `- Sound: ${o.sound}`,
    "",
    "## Aero",
    "",
    `Speed Dreams' downforce at rest height (N per (m/s)²): front ${o.targets.front.toFixed(3)}, rear ${o.targets.rear.toFixed(3)}; drag ${o.targets.drag.toFixed(3)}.`,
    `Driven in the game's simulation after the fit: front ${o.fit.measured.front.toFixed(3)}, rear ${o.fit.measured.rear.toFixed(3)}; drag ${o.fit.measured.drag.toFixed(3)}.`,
    ...o.fit.notes.map((n) => `- ${n}`),
    "",
  ];
  if (o.sanity) {
    const s = o.sanity;
    lines.push(
      "## Driven headless",
      "",
      `- Top speed ${s.topSpeedKmh.toFixed(0)} km/h, 0–100 km/h in ${s.zeroTo100S?.toFixed(1) ?? "—"} s, stopping from 100 km/h in ${s.stop100M?.toFixed(1) ?? "—"} m.`,
      s.lap ? `- A lap of the bundled circuit on the autopilot: ${s.lap.timeS?.toFixed(2) ?? "unfinished"} s, ${s.lap.offTrackS.toFixed(1)} s off track.` : "",
      ""
    );
  }
  lines.push("## Mapping", "", "| Speed Dreams | Profile | Value |", "| --- | --- | --- |");
  for (const r of p.rows) lines.push(`| ${md(r.from)} | \`${r.to}\` | ${md(r.value)} |`);
  lines.push("", "## Not carried", "");
  for (const l of [...p.leftOut, ...SD_KEYS_NOT_CARRIED, ...o.leftOutLiveries]) lines.push(`- ${l}`);
  return `${lines.join("\n")}\n`;
}

const importer: Importer & { convert(argv: string[], work: string): Promise<string> } = {
  summary: "a Speed Dreams car (its folder, or --fetch <car> from the official repositories)",
  usage: `<car folder> | --fetch <car> [--base <model>] [--id <car id>] [--class <class>] [--year <year>] [--personal]
  --fetch <car>            download the car (its folder's name, e.g. ls2-cavallo-360r) at its pinned revision first
  --base <model>           the vehicle model to build its physics on (default: the closest to the car)
  --id <id>                the car's id in the package (default: its folder's name)
  --class <class>          f1, gt3, proto, classic or road (default: by its Speed Dreams category)
  --year <year>            its year in the menus (default: by its category)
  --category <file>        its category's XML, when it isn't beside the car (…/cars/categories/<category>.xml)
  --personal               convert a car whose licence doesn't let it be shared; the package says so
  --no-lap                 skip the autopilot lap of the bundled circuit (the straight-line checks still run)
  --skip-drive-check       package it even when the headless drive finds a problem
${PACKAGE_USAGE}
  Default package id: sd.<car>.`,
  async run(argv) {
    // The converters' working copy: removed after the import, failed or not, unless --keep-build keeps it
    const work = mkdtempSync(join(tmpdir(), "sd-car-"));
    try {
      return await importer.convert(argv, work);
    } finally {
      if (argv.includes("--keep-build")) console.log(`      the working copy is kept in ${work}`);
      else rmSync(work, { recursive: true, force: true });
    }
  },
  async convert(argv, work) {
    const { values, positionals } = parseImportArgs(argv, {
      fetch: { type: "string" },
      base: { type: "string" },
      id: { type: "string" },
      class: { type: "string" },
      year: { type: "string" },
      category: { type: "string" },
      personal: { type: "boolean" },
      "no-lap": { type: "boolean" },
      "skip-drive-check": { type: "boolean" },
    });
    if (values.fetch && positionals.length) throw new Error("give a car folder or --fetch <car>, not both");
    const carDir = values.fetch ? await fetchSdCar(values.fetch) : positionals[0] && resolve(positionals[0]);
    if (!carDir || !existsSync(carDir)) throw new Error("name the car's folder (…/cars/models/<car>), or --fetch <car>");
    const car = basename(carDir);
    const xml = join(carDir, `${car}.xml`);
    if (!existsSync(xml)) throw new Error(`${carDir}: no ${car}.xml (the folder must keep the car's own name)`);
    if (values.base && !PHYSICS_BASES.includes(values.base as VehicleModelId)) throw new Error(`--base must be one of ${PHYSICS_BASES.join(", ")}`);
    if (values.class && !CLASSES.includes(values.class as ModCarClass)) throw new Error(`--class must be one of ${CLASSES.join(", ")}`);
    if (values.year !== undefined && !/^\d{4}$/.test(values.year)) throw new Error(`--year must be a year (1890 to 2100), not "${values.year}"`);

    // ---- 1. Parameters: the car over its category
    const own = SdParams.read(xml);
    const ownCategory = own.str("Car", "category");
    const category = ownCategory === undefined ? undefined : plainName(ownCategory, "Car/category", car);
    let params = own;
    let categoryFile = values.category && resolve(values.category);
    if (!categoryFile && category) {
      const beside = join(carDir, "..", "..", "categories", `${category}.xml`);
      try {
        categoryFile = existsSync(beside) ? beside : sdCategoryFile(category);
      } catch (err) {
        // Its defaults and limits are part of the car (a car may take its tyres' grip from them): no guessing
        throw new Error(`${car}: its category ${category} is not beside it and could not be fetched (${(err as Error).message}); pass --category <file>`);
      }
    }
    if (categoryFile && existsSync(categoryFile)) params = own.mergeOver(SdParams.read(categoryFile));
    else if (category) throw new Error(`${car}: no category file ${categoryFile}`);

    // ---- 2. Licence
    const pinned = pinnedCar(carDir, car);
    const liveryIds = liveryCandidates(carDir, car);
    const lic: CarLicence = carLicence(carDir, car, liveryIds, { pin: pinned, category: categoryFile });
    const personal = !!values.personal;
    if (!isShareable(lic.reading) && !personal) {
      throw new Error(
        `${car}: not converted, its licence doesn't clearly let it be shared (${lic.reading.problems.join("; ")}). ` +
          `Ask its authors, or convert it for yourself with --personal (the package then says it is for personal use only).`
      );
    }
    const leftOutLiveries: string[] = [];
    const liveriesOk = liveryIds.filter((id) => {
      const own = lic.liveries[id];
      if (!own || isShareable(own.reading) || personal) return true;
      leftOutLiveries.push(`livery ${id}: its statement (${own.files.map((f) => f.file).join(", ")}) doesn't clearly let it be shared (${own.reading.problems.join("; ")})`);
      return false;
    });
    /** What the package holds besides the car and its liveries (shared wheels, a shared sample), and their terms */
    const sharedParts: { what: string; reading: LicenceReading; from: string }[] = [];

    // ---- 3. Physics
    const phys = sdCarPhysics(params, { base: values.base as VehicleModelId | undefined });
    const classId = (values.class as ModCarClass | undefined) ?? phys.classId;
    const year = values.year ? Number(values.year) : phys.year;
    if (!(year >= 1890 && year <= 2100)) throw new Error(`--year must be a year (1890 to 2100), not ${year}`);
    const baseProfile = VEHICLE_MODELS[phys.base].simProfile!;
    const pkgCarId = carLocalId(values.id ?? car);
    const profileOf = (patch: Record<string, unknown>): CarSimProfile => {
      const r = modSimProfile(baseProfile, { format: MOD_PHYSICS_FORMAT, profile: patch }, `mod:sd/${pkgCarId}`);
      if (!r.ok) throw new Error(`${car}: the physics patch breaks the game's rules (a converter bug):\n  ${r.errors.join("\n  ")}`);
      return r.profile;
    };
    profileOf(phys.patch);
    const targets = sdAeroTargets(phys.car);
    const fit = fitAero(baseProfile, phys.patch, targets, profileOf);
    const patch = withAero(phys.patch, fit.aero);
    const profile = profileOf(patch);
    console.log(`      physics: ${phys.base} (${phys.reason}); ${phys.rows.length} values from the XML, ${phys.leftOut.length} left at the base's`);

    const expected = expectedTopSpeed(phys.car, targets.drag);
    const circuit = values["no-lap"] ? undefined : bundledCircuit();
    const sanity = driveSanity(profile, { minTopSpeedKmh: 0.75 * expected, maxTopSpeedKmh: 1.1 * expected + 10, maxStop100M: 60 }, circuit);
    console.log(
      `      driven: ${sanity.topSpeedKmh.toFixed(0)} km/h top (power and gearing allow ${expected.toFixed(0)}), 0–100 in ${sanity.zeroTo100S?.toFixed(1) ?? "—"} s, ` +
        `100–0 in ${sanity.stop100M?.toFixed(1) ?? "—"} m${sanity.lap ? `, a lap in ${sanity.lap.timeS?.toFixed(2) ?? "—"} s` : ""}`
    );
    if (!sanity.ok) {
      const msg = `${car}: the converted car fails the headless drive: ${sanity.problems.join("; ")}`;
      if (!values["skip-drive-check"]) throw new Error(`${msg} (--skip-drive-check packages it anyway)`);
      console.log(`      ${msg}`);
    }

    // ---- 4. Model, liveries, picture; sound
    const paramsJson = join(work, "params.json");
    const sections: Record<string, Record<string, number | string>> = {};
    for (const [path, key, a] of params.entries()) (sections[path] ??= {})[key] = a.val;
    writeFileSync(paramsJson, JSON.stringify({ sections }));
    const shared = sharedDirs(carDir);
    const G = "Graphic Objects";
    for (const prefix of new Set([params.str(G, "3d front wheel"), params.str(G, "3d rear wheel"), params.str(G, "3d wheel") ?? "wheel"].filter(Boolean) as string[])) {
      const f = plainName(`${prefix}0.acc`, `its wheel model (${G}/3d … wheel "${prefix}")`, car);
      if (!existsSync(join(carDir, f)) && !findIn(shared.objects, f)) sdSharedFile("objects", f);
      // A wheel the car doesn't carry is Speed Dreams' shared one: its terms are the shared data's
      const sharedWheel = existsSync(join(carDir, f)) ? undefined : findIn(sharedDirs(carDir).objects, f);
      if (sharedWheel) {
        const w = sharedFileReading(sharedWheel, `objects/${f}`);
        if (!isShareable(w.reading) && !personal) throw new Error(`${car}: its wheels are Speed Dreams' shared ${f}, which can't be shared (${w.reading.problems.join("; ")}, ${w.from}); --personal converts it for you alone`);
        sharedParts.push({ what: `the shared wheel ${f}`, ...w });
      }
    }
    const glb = join(work, `${pkgCarId}.glb`);
    const skinsOut = join(work, "skins");
    const thumb = join(work, "thumb.webp");
    const info = join(work, "info.json");
    const sharedArgs = [...sharedDirs(carDir).objects, ...sharedDirs(carDir).textures].flatMap((d) => ["--shared", d]);
    runPython("scripts/cars/port_sd_car.py", [carDir, glb, "--params", paramsJson, ...sharedArgs, "--skins-out", skinsOut, "--thumb", thumb, "--info", info], {
      requirements: null,
      withPackages: ["numpy==2.4.3", "pillow==13.0.0"],
    });
    const ported = JSON.parse(readFileSync(info, "utf8")) as {
      paint: { id: string; name: string; swatch: [string, string] };
      liveries: { id: string; name: string; swatch: [string, string]; dir: string }[];
      thumb: string | null;
      bodyPlan: [number, number][] | null;
      warnings: string[];
    };

    const sample = plainName(params.str("Sound", "engine sample") ?? "engine-1.wav", "Sound/engine sample", car);
    let samplePath = existsSync(join(carDir, sample)) ? join(carDir, sample) : findIn(shared.sound, sample);
    if (!samplePath) {
      try {
        samplePath = sdSharedFile("sound", sample) ?? undefined;
      } catch (err) {
        console.log(`      its engine sample ${sample}: ${(err as Error).message}`);
      }
    }
    // A sample the car doesn't carry is Speed Dreams' shared one: one that can't be shared isn't used, unless --personal
    let sampleLeftOut = "";
    if (samplePath && !samplePath.startsWith(carDir + sep)) {
      const smp = sharedFileReading(samplePath, `sound/${sample}`);
      if (isShareable(smp.reading) || personal) sharedParts.push({ what: `the shared engine sample ${sample}`, ...smp });
      else {
        sampleLeftOut = `Speed Dreams' shared engine sample ${sample} (${smp.reading.problems.join("; ")}, ${smp.from})`;
        samplePath = undefined;
      }
    }
    let sound: { dir: string; limiterRpm: number } | { car: string } = { car: SOUND_BY_CLASS[classId] };
    let soundNote = "";
    const rpmScale = params.num("Sound", "rpm scale") ?? 1;
    // The bank's Ogg loops are encoded with ffmpeg, from PATH (`ffmpeg -version` runs on every platform)
    const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 ? "ffmpeg" : null;
    if (!samplePath) soundNote = `the game's ${SOUND_BY_CLASS[classId]} (${sampleLeftOut ? `${sampleLeftOut} can't be shared` : `the engine sample ${sample} was not found`})`;
    else if (!ffmpeg) soundNote = `the game's ${SOUND_BY_CLASS[classId]} (ffmpeg isn't installed, so its engine sample ${sample} couldn't be converted)`;
    else if (!(rpmScale > 0)) soundNote = `the game's ${SOUND_BY_CLASS[classId]} (Sound/rpm scale is ${rpmScale}, so its engine sample has no pitch)`;
    else {
      const audio = join(work, "audio");
      try {
        runPython(
          "scripts/audio/port_sd_sound.py",
          [samplePath, audio, "--rpm-scale", String(rpmScale), "--limiter", String(Math.round(phys.car.engine.limiterRpm)), "--idle", String(Math.round(phys.car.engine.idleRpm)), "--source", `Speed Dreams: ${car} (${sample})`, "--ffmpeg", ffmpeg],
          { requirements: null, withPackages: ["numpy==2.4.3", "scipy==1.18.1", "fsb5"] }
        );
        sound = { dir: audio, limiterRpm: phys.car.engine.limiterRpm };
        soundNote = `its own engine sample (${sample}), resampled to Speed Dreams' pitch at each rpm of the bank (rpm scale ${rpmScale}: the sample's own pitch at ${Math.round(5729.58 / rpmScale)} rpm), at Speed Dreams' loudness on and off throttle`;
      } catch (err) {
        soundNote = `the game's ${SOUND_BY_CLASS[classId]} (its engine sample ${sample} couldn't be converted: ${(err as Error).message})`;
      }
    }

    // ---- 5. The package
    const title = (phys.car.name || car).trim();
    const sourceUrl = pinned?.commit ? `${pinned.repo!.replace(/\.git$/, "")}/src/commit/${pinned.commit}` : pinned?.zip;
    // Everything the package holds: the car, the liveries it keeps (with statements of their own), the shared parts.
    // One part that can't be shared makes the whole package for personal use only
    const keptLiveries = ported.liveries.filter((l) => liveriesOk.includes(l.id)).map((l) => lic.liveries[l.id]).filter((l) => !!l);
    const held = mergeReadings([lic.reading, ...keptLiveries.map((l) => l.reading), ...sharedParts.map((p) => p.reading)]);
    const terms = creditLicence(held);
    // The statements name the authors best (the official list's copy has typos); the credit holds 80 characters
    const authorList = mergeNames(
      mergeReadings([...lic.statements, ...keptLiveries.flatMap((l) => l.files)].map((s) => s.reading)).holders,
      (pinned?.author ?? "").split(/\s*,\s*|\s+and\s+/).filter(Boolean),
    );
    const authors = authorLine(authorList);
    const credit: ModCredit = packageCredit(
      {
        author: authors || "Speed Dreams contributors",
        license: terms.license,
        url: sourceUrl ?? "https://www.speed-dreams.net/",
        licenseUrl: terms.licenseUrl,
        note: terms.note ?? `Speed Dreams' ${title}, converted to LibreCorsa (model, liveries, sound and physics on the ${phys.base} model).`,
      },
      { authorUrl: "https://www.speed-dreams.net/" }
    );
    const { info: pkgInfo, packageDir } = importTarget(
      { ...values, package: values.package ?? packageIdFrom("sd", car) },
      {
        author: "sd",
        name: values.name ?? `${title} (Speed Dreams)`,
        credit,
        description: `${title}, a ${phys.car.category} car from Speed Dreams, converted with its liveries and sound; physics on the ${phys.base} model.`,
      }
    );
    const kept = ported.liveries.filter((l) => liveriesOk.includes(l.id));
    const localIds = liveryLocalIds(kept.map((l) => l.id));
    const skins: CarSkinSource[] = kept.map((l) => ({ id: localIds.get(l.id)!, name: l.name, swatch: l.swatch, dir: l.dir }));
    // The licences' texts when it may be shared; the car's and its liveries' own statements, always
    const extraFiles = licenceTextFiles(held).map((f) => ({ from: f.from, to: `cars/${pkgCarId}/${f.name}` }));
    const statements = [...new Map([...lic.statements, ...keptLiveries.flatMap((l) => l.files)].map((s) => [s.path, s])).values()];
    for (const s of statements.filter((x) => x.readable)) extraFiles.push({ from: s.path, to: `cars/${pkgCarId}/${carriedName("speed-dreams", s.file)}` });
    const conversion = join(work, "CONVERSION.md");
    writeFileSync(
      conversion,
      conversionReport({
        car,
        title,
        source: sourceUrl ?? carDir,
        phys,
        fit,
        targets,
        sanity,
        sound: soundNote,
        authors: authorList.join(", ") || "Speed Dreams contributors",
        licence: [
          `${credit.license}${lic.fromList ? " (from Speed Dreams' official asset list: the car's folder has no licence file)" : ""}${terms.personal ? `. ${terms.note}: ${held.problems.join("; ")}` : ""}`,
          ...sharedParts.map((p) => `${p.what}: ${p.reading.licences.join(", ") || "no licence"} (${p.from})`),
        ].join("; "),
        leftOutLiveries: [...leftOutLiveries, ...(sampleLeftOut ? [`${sampleLeftOut}: the game's ${SOUND_BY_CLASS[classId]} sound instead`] : [])],
      })
    );
    extraFiles.push({ from: conversion, to: `cars/${pkgCarId}/CONVERSION.md` });

    const out = packageCar({
      packageDir,
      info: pkgInfo,
      car: {
        localId: pkgCarId,
        title: title.slice(0, 80),
        sub: subLine(phys.car, year).slice(0, 120),
        badge: (title.split(/\s+/).pop() ?? title).slice(0, 16),
        classId,
        year,
        base: phys.base,
        physicsPatch: patch,
        ...(ported.bodyPlan ? { bodyPlan: ported.bodyPlan } : {}),
        credit,
      },
      model: glb,
      thumb: ported.thumb ?? undefined,
      paint: ported.paint,
      skins,
      sound,
      extraFiles,
    });
    report(packageDir, out.checked);
    for (const w of ported.warnings) console.log(`      note: ${w}`);
    for (const l of leftOutLiveries) console.log(`      left out: ${l}`);
    if (out.skipped.length) console.log(`      left out: ${out.skipped.join(", ")}`);
    console.log(`      licence: ${credit.license}${lic.fromList ? " (from the official asset list)" : ""}${terms.personal ? `. ${terms.note} (${held.problems.join("; ")})` : ""}`);
    console.log(`      sound: ${soundNote}`);
    console.log(`      ${out.contentId} in ${packageDir}`);
    if (!out.checked.ok) throw new Error(`${packageDir}: the package fails the game's checks`);
    return packageDir;
  },
};

/** The bundled circuit (RISE Motordrome's short lap) for the autopilot's lap */
function bundledCircuit(): { track: ReturnType<typeof getActiveTrackData>; root: ReturnType<typeof loadGlbGeometry> } | undefined {
  const track = getActiveTrackData(1200);
  const file = track.meshUrl && join(REPO_ROOT, "public", track.meshUrl.replace(/^\//, ""));
  return file && existsSync(file) ? { track, root: loadGlbGeometry(file) } : undefined;
}

export default importer;
