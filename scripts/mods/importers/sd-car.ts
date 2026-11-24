/**
 * A Speed Dreams car as a mod package: its folder (`…/cars/models/<car>/`: the XML, the AC3D models, textures and
 * engine sample) converted into the game's car rig, liveries, picture, sound bank and a physics patch on the closest of
 * the game's vehicle models. `--fetch <car>` downloads one of the cars the official asset database lists, at the
 * revision scripts/cars/speed-dreams-cars.json pins, into scripts/mods/.cache/speed-dreams/ (lib/sd-fetch.ts).
 *
 *   1. its parameters: the car's XML merged over its category's (scripts/lib/sd-params.ts), the category found beside
 *      the car as in the game's data folder, else taken from the pinned shared data;
 *   2. its licence (scripts/cars/sd-licence.ts): a car whose readme, or the official list, doesn't clearly let it be
 *      shared is refused, unless `--personal` (then the package says it is for personal use only); a livery with an
 *      unclear readme of its own is left out;
 *   3. its physics (scripts/cars/sd-car-physics.ts) on the closest base, the aero matched by driving it
 *      (lib/aero-fit.ts), checked as the game checks a physics file, then driven headless (lib/car-sanity.ts): flat out
 *      on a straight to its top speed, braking, and a lap of the bundled circuit on the autopilot;
 *   4. its model (scripts/cars/port_sd_car.py) and sound (scripts/audio/port_sd_sound.py: Speed Dreams' one engine
 *      sample resampled to its pitch at each rpm of the bank);
 *   5. the package (lib/car-package.ts), with the licence texts, the car's readme and a CONVERSION.md of what was
 *      mapped where and what was left out.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { packageCar, type CarSkinSource } from "../lib/car-package";
import { importTarget, PACKAGE_USAGE, parseImportArgs, type Importer } from "../lib/importer";
import { localIdFrom, packageCredit } from "../lib/manifest-file";
import { report } from "../lib/package-check";
import { runPython, REPO_ROOT } from "../lib/toolchain";
import { fitAero, withAero, type AeroFit } from "../lib/aero-fit";
import { driveSanity, type SanityResult } from "../lib/car-sanity";
import { SdParams } from "../../lib/sd-params";
import { sdAeroTargets, sdCarPhysics, PHYSICS_BASES, SD_KEYS_NOT_CARRIED, type SdCar, type SdPhysics } from "../../cars/sd-car-physics";
import { findCarLicence, LICENCES, shareable, type CarLicence, type LicenceId } from "../../cars/sd-licence";
import { fetchedSource, fetchSdCar, readPins, SD_CACHE_DIR, SD_DATA_DIR, sdCategoryFile, sdSharedFile, type PinnedCar } from "../lib/sd-fetch";
import { modSimProfile, MOD_PHYSICS_FORMAT } from "../../../src/lib/mods/mod-physics";
import { VEHICLE_MODELS } from "../../../src/lib/cars/vehicle-models";
import type { CarSimProfile } from "../../../src/lib/sim/f12026-car/F12026CarSim";
import type { VehicleModelId } from "../../../src/types/f1";
import type { ModCarClass, ModCredit } from "../../../src/lib/mods/mod-manifest";
import { getActiveTrackData } from "../../../src/lib/track-data";
import { loadGlbGeometry } from "../../lib/glb-geometry";

const CLASSES: ModCarClass[] = ["f1", "gt3", "proto", "classic", "road"];
const PERSONAL_NOTE = "For personal use only, not for sharing.";

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

/** The liveries a car folder has: `<car>-<id>.<image>` that is no texture of its own */
function liveryCandidates(carDir: string, car: string): string[] {
  const re = new RegExp(`^${car.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(.+)\\.(png|jpe?g|rgb)$`, "i");
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

/** The car's id in the package: its folder's name, without its category's prefix when it is too long */
function carLocalId(car: string): string {
  if (car.length <= 16) return localIdFrom(car);
  return localIdFrom(car.replace(/^[a-z0-9]+-/i, ""));
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

const importer: Importer = {
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
    const carDir = values.fetch ? await fetchSdCar(values.fetch) : positionals[0] && resolve(positionals[0]);
    if (!carDir || !existsSync(carDir)) throw new Error("name the car's folder (…/cars/models/<car>), or --fetch <car>");
    const car = basename(carDir);
    const xml = join(carDir, `${car}.xml`);
    if (!existsSync(xml)) throw new Error(`${carDir}: no ${car}.xml (the folder must keep the car's own name)`);
    if (values.base && !PHYSICS_BASES.includes(values.base as VehicleModelId)) throw new Error(`--base must be one of ${PHYSICS_BASES.join(", ")}`);
    if (values.class && !CLASSES.includes(values.class as ModCarClass)) throw new Error(`--class must be one of ${CLASSES.join(", ")}`);

    // ---- 1. Parameters: the car over its category
    const own = SdParams.read(xml);
    const category = own.str("Car", "category");
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
    const pinned: PinnedCar | undefined = fetchedSource(carDir)?.pinned ?? readPins().cars[car];
    const liveryIds = liveryCandidates(carDir, car);
    const lic: CarLicence = findCarLicence(carDir, car, liveryIds, pinned?.license);
    const personal = !!values.personal;
    if (!shareable(lic.reading) && !personal) {
      throw new Error(
        `${car}: not converted, its licence doesn't clearly let it be shared (${lic.reading.problems.join("; ")}). ` +
          `Ask its authors, or convert it for yourself with --personal (the package then says it is for personal use only).`
      );
    }
    const licenceIds = new Set<LicenceId>(lic.reading.licences);
    if (lic.data && shareable(lic.data)) for (const l of lic.data.licences) licenceIds.add(l);
    const leftOutLiveries: string[] = [];
    const liveriesOk = liveryIds.filter((id) => {
      const own = lic.liveries[id];
      if (!own || shareable(own.reading) || personal) {
        if (own && shareable(own.reading)) for (const l of own.reading.licences) licenceIds.add(l);
        return true;
      }
      leftOutLiveries.push(`livery ${id}: its readme (${own.readme}) doesn't clearly let it be shared (${own.reading.problems.join("; ")})`);
      return false;
    });
    const licenceText = [...licenceIds].map((id) => LICENCES[id].name).join(", ") || (personal ? "Unknown" : "");

    // ---- 3. Physics
    const phys = sdCarPhysics(params, { base: values.base as VehicleModelId | undefined });
    const classId = (values.class as ModCarClass | undefined) ?? phys.classId;
    const year = values.year ? Number(values.year) : phys.year;
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
    const work = join(SD_CACHE_DIR, "build", car);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const paramsJson = join(work, "params.json");
    const sections: Record<string, Record<string, number | string>> = {};
    for (const [path, key, a] of params.entries()) (sections[path] ??= {})[key] = a.val;
    writeFileSync(paramsJson, JSON.stringify({ sections }));
    const shared = sharedDirs(carDir);
    const G = "Graphic Objects";
    for (const prefix of new Set([params.str(G, "3d front wheel"), params.str(G, "3d rear wheel"), params.str(G, "3d wheel") ?? "wheel"].filter(Boolean) as string[])) {
      const f = `${prefix}0.acc`;
      if (!existsSync(join(carDir, f)) && !findIn(shared.objects, f)) sdSharedFile("objects", f);
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

    const sample = params.str("Sound", "engine sample") ?? "engine-1.wav";
    let samplePath = existsSync(join(carDir, sample)) ? join(carDir, sample) : findIn(shared.sound, sample);
    if (!samplePath) {
      try {
        samplePath = sdSharedFile("sound", sample) ?? undefined;
      } catch (err) {
        console.log(`      its engine sample ${sample}: ${(err as Error).message}`);
      }
    }
    let sound: { dir: string; limiterRpm: number } | { car: string } = { car: SOUND_BY_CLASS[classId] };
    let soundNote = "";
    const rpmScale = params.num("Sound", "rpm scale") ?? 1;
    // The bank's Ogg loops are encoded with ffmpeg, from PATH (`ffmpeg -version` runs on every platform)
    const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 ? "ffmpeg" : null;
    if (!samplePath) soundNote = `the game's ${SOUND_BY_CLASS[classId]} (the engine sample ${sample} was not found)`;
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
    // The car's own readme names its authors best (the official list's copy has typos); the credit holds 80 characters
    const authorList = mergeNames(uniqueNames(lic.readmes.length ? readmeAuthors(join(carDir, lic.readmes[0])) : ""), uniqueNames(pinned?.author ?? ""));
    const authors = shortList(authorList, 80);
    const firstLicence = [...licenceIds][0];
    const credit: ModCredit = packageCredit(
      {
        author: authors || "Speed Dreams contributors",
        license: personal && !shareable(lic.reading) ? `${licenceText || "Unknown"} (personal use only)` : licenceText,
        url: sourceUrl ?? "https://www.speed-dreams.net/",
        licenseUrl: firstLicence ? LICENCES[firstLicence].url : undefined,
        note: [
          `Speed Dreams' ${title}, converted to LibreCorsa (model, liveries, sound and physics on the ${phys.base} model).`,
          personal && !shareable(lic.reading) ? PERSONAL_NOTE : "",
        ]
          .filter(Boolean)
          .join(" "),
      },
      { authorUrl: "https://www.speed-dreams.net/" }
    );
    const { info: pkgInfo, packageDir } = importTarget(
      { ...values, package: values.package ?? `sd.${car.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 24).replace(/[-_]+$/, "")}` },
      {
        author: "sd",
        name: values.name ?? `${title} (Speed Dreams)`,
        credit,
        description: `${title}, a ${phys.car.category} car from Speed Dreams, converted with its liveries and sound; physics on the ${phys.base} model.`,
      }
    );
    const skins: CarSkinSource[] = ported.liveries
      .filter((l) => liveriesOk.includes(l.id))
      .map((l) => ({ id: localIdFrom(l.id), name: l.name, swatch: l.swatch, dir: l.dir }));
    const extraFiles = [...licenceIds].map((id) => ({ from: LICENCES[id].textFile, to: `cars/${pkgCarId}/LICENSE-${id}.txt` }));
    for (const r of lic.readmes) extraFiles.push({ from: join(carDir, r), to: `cars/${pkgCarId}/speed-dreams-${r.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}${/\.(txt|md)$/i.test(r) ? "" : ".txt"}` });
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
        licence: `${credit.license}${lic.source === "database" ? " (from Speed Dreams' official asset list: the car's folder has no licence file)" : ""}`,
        leftOutLiveries,
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
    if (!values["keep-build"]) rmSync(work, { recursive: true, force: true });
    report(packageDir, out.checked);
    for (const w of ported.warnings) console.log(`      note: ${w}`);
    for (const l of leftOutLiveries) console.log(`      left out: ${l}`);
    if (out.skipped.length) console.log(`      left out: ${out.skipped.join(", ")}`);
    console.log(`      licence: ${credit.license}${lic.source === "database" ? " (from the official asset list)" : ""}`);
    console.log(`      sound: ${soundNote}`);
    console.log(`      ${out.contentId} in ${packageDir}`);
    if (!out.checked.ok) throw new Error(`${packageDir}: the package fails the game's checks`);
  },
};

/** The bundled circuit (RISE Motordrome's short lap) for the autopilot's lap */
function bundledCircuit(): { track: ReturnType<typeof getActiveTrackData>; root: ReturnType<typeof loadGlbGeometry> } | undefined {
  const track = getActiveTrackData(1200);
  const file = track.meshUrl && join(REPO_ROOT, "public", track.meshUrl.replace(/^\//, ""));
  return file && existsSync(file) ? { track, root: loadGlbGeometry(file) } : undefined;
}

/** Names once each, in order */
function uniqueNames(list: string): string[] {
  const seen = new Set<string>();
  return list
    .split(/,|\band\b/)
    .map((n) => n.trim())
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

/**
 * The readme's names, then the official list's that aren't among them: a name counts as there when one has the same
 * first name and a surname that starts alike (the list spells some with typos, "Olaf Sa'ick" for "Olaf Saßnick")
 */
function mergeNames(own: string[], listed: string[]): string[] {
  const key = (n: string) => {
    const w = n.toLowerCase().split(/\s+/);
    return `${w[0]}|${(w[w.length - 1] ?? "").slice(0, 2)}`;
  };
  const have = new Set(own.map(key));
  return [...own, ...listed.filter((n) => !have.has(key(n)))];
}

/** As many names as fit in `max` characters, then "and others" */
function shortList(names: string[], max: number): string {
  const all = names.join(", ");
  if (all.length <= max) return all;
  const out: string[] = [];
  for (const n of names) {
    if ([...out, n].join(", ").length + ", and others".length > max) break;
    out.push(n);
  }
  return `${out.join(", ")}, and others`;
}

/** The names a readme's "Copyright <year> <names>" lines give */
function readmeAuthors(file: string): string {
  const names = new Set<string>();
  for (const m of readFileSync(file, "utf8").matchAll(/copyright\s*(?:\(c\)|©)?\s*\d{4}(?:\s*[-–]\s*\d{4})?\s+([^\n(]+)/gi)) {
    for (const n of m[1].split(/,|\band\b/)) {
      const t = n.trim();
      if (t && t.length < 60) names.add(t);
    }
  }
  return [...names].join(", ");
}

export default importer;
