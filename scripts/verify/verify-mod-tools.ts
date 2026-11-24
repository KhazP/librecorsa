/**
 * The modder's tools (scripts/mods): packaging a built circuit and a converted car, the mod.json they write, the paths
 * they refuse before writing or deleting anything, the zip `pack` writes read back by the game's importer, and every
 * importer's shape. No converter runs here (those need Python and a source mod); each importer's own checks are its
 * suite.
 *
 *   npx tsx scripts/verify/verify-mod-tools.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageCircuit } from "../mods/lib/circuit-package";
import { packageCar } from "../mods/lib/car-package";
import { localIdFrom, packageCredit, packageIdFrom } from "../mods/lib/manifest-file";
import { checkPackage, hashFolder } from "../mods/lib/package-check";
import { zipPackage } from "../mods/lib/zip-writer";
import type { Importer } from "../mods/lib/importer";
import { readZip } from "../../src/lib/mods/zip-reader";
import { packageHash, sha256Hex } from "../../src/lib/mods/mod-manifest";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failed++;
}

const tmp = mkdtempSync(join(tmpdir(), "mod-tools-"));
const write = (path: string, text: string | Uint8Array) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const info = { id: "jdoe.test-pack", name: "Test pack", version: "1.0.0", credit: { author: "J. Doe", license: "CC BY 4.0" } };

// --- Ids and credits ---
check("a local id is made from any name", localIdFrom("Monza 1966 (Full Course)!") === "monza-1966-full", localIdFrom("Monza 1966 (Full Course)!"));
check("a package id from an author and a name", packageIdFrom("J. Doe", "Monza '66") === "j-doe.monza-66", packageIdFrom("J. Doe", "Monza '66"));
const credit = packageCredit({ author: "A", license: "GPL-2.0", url: "http://insecure.example", licenseUrl: "https://licence.example" });
check("a credit keeps https links only, and needs an author and a licence", !credit.url && credit.licenseUrl === "https://licence.example" && packageCredit({}).author === "Unknown");

// --- A built circuit as a package ---
const build = join(tmp, "build", "modimport_ring");
const trackData = {
  metadata: { name: "Ring", mesh: { url: "/tracks/modimport_ring/modimport_ring.glb", scenery: ["/tracks/modimport_ring/scenery/trees.glb"], road: "Road" } },
  samples: Array.from({ length: 12 }, (_, i) => ({ s: i })),
};
write(join(build, "track_data.json"), JSON.stringify(trackData));
write(join(build, "modimport_ring.glb"), "glb");
write(join(build, "scenery", "trees.glb"), "trees");
write(join(build, "modimport_ring.ktx2.abc.glb"), "hosted variant");
write(
  join(build, "circuit.json"),
  JSON.stringify({ id: "modimport_ring", name: "Test Ring", layout: "Full", country: "Nowhere", city: "Somewhere", lengthM: 3210.4, turns: 12, direction: "clockwise", credit: { author: "J. Doe", license: "CC BY 4.0" } }),
);
const pkgDir = join(tmp, "mods", info.id);
const circuit = packageCircuit({ builtId: "modimport_ring", buildDir: build, packageDir: pkgDir, info, localId: "ring" });
check("a built circuit becomes a package that passes the game's checks", circuit.checked.ok, circuit.checked.problems.join("; "));
check("it is named mod:<package>/<circuit>", circuit.contentId === "mod:jdoe.test-pack/ring");
const packaged = JSON.parse(readFileSync(join(pkgDir, "ring", "track_data.json"), "utf8"));
check("its model and scenery are named by their paths in the package", packaged.metadata.mesh.url === "ring/modimport_ring.glb" && packaged.metadata.mesh.scenery[0] === "ring/scenery/trees.glb");
check("only the files the track data names are copied", circuit.skipped.join() === "modimport_ring.ktx2.abc.glb" && !readdirSync(join(pkgDir, "ring")).some((f) => f.includes("ktx2")));
const manifest = JSON.parse(readFileSync(join(pkgDir, "mod.json"), "utf8"));
check("mod.json lists it, its length rounded, its credit the package's", manifest.tracks?.[0]?.lengthM === 3210 && manifest.tracks[0].credit === undefined);
let refused = false;
try {
  write(join(build, "track_data.json"), JSON.stringify({ ...trackData, metadata: { mesh: { url: "/tracks/another/another.glb" } } }));
  packageCircuit({ builtId: "modimport_ring", buildDir: build, packageDir: join(tmp, "mods", "jdoe.other"), info: { ...info, id: "jdoe.other" }, localId: "ring" });
} catch {
  refused = true;
}
check("a circuit naming another circuit's files is refused", refused);

// --- Paths the packagers refuse, before anything is written or deleted ---
const refuses = (f: () => unknown, re: RegExp): string | true => {
  try {
    f();
    return "not refused";
  } catch (err) {
    return re.test((err as Error).message) || (err as Error).message;
  }
};
write(join(build, "track_data.json"), JSON.stringify(trackData));
const ringOpts = { builtId: "modimport_ring", buildDir: build, packageDir: pkgDir, info, localId: "ring" };
const intact = () => existsSync(join(pkgDir, "mod.json")) && existsSync(join(pkgDir, "ring", "track_data.json"));
const asCheck = (name: string, r: string | true, extra = true) => check(name, r === true && extra, r === true ? "" : r);
asCheck("a circuit id that is no id (..) is refused, and nothing is deleted", refuses(() => packageCircuit({ ...ringOpts, localId: ".." }), /not an id/), intact());
write(join(build, "track_data.json"), JSON.stringify({ ...trackData, metadata: { mesh: { url: "/tracks/modimport_ring/../../secret.glb" } } }));
asCheck("track data naming a file outside the build (..) is refused", refuses(() => packageCircuit(ringOpts), /not a path a package may use/), intact());
write(join(tmp, "outside.glb"), "someone else's");
write(join(build, "track_data.json"), JSON.stringify({ ...trackData, metadata: { mesh: { url: "/tracks/modimport_ring/linked.glb" } } }));
symlinkSync(join(tmp, "outside.glb"), join(build, "linked.glb"));
asCheck("a file the track data names that is a symbolic link is refused", refuses(() => packageCircuit(ringOpts), /symbolic link/), intact());
write(join(build, "track_data.json"), JSON.stringify(trackData));
write(join(tmp, "LICENSE.txt"), "CC BY 4.0");
asCheck("an extra file going outside the package is refused", refuses(() => packageCircuit({ ...ringOpts, extraFiles: [{ from: join(tmp, "LICENSE.txt"), to: "../escape.txt" }] }), /not a path a package may use/), intact() && !existsSync(join(tmp, "mods", "escape.txt")));
symlinkSync(join(tmp, "LICENSE.txt"), join(tmp, "linked-licence.txt"));
asCheck("an extra file that is a symbolic link is refused", refuses(() => packageCircuit({ ...ringOpts, extraFiles: [{ from: join(tmp, "linked-licence.txt"), to: "ring/LICENSE.txt" }] }), /symbolic link/));
const ok2 = packageCircuit({ ...ringOpts, removeBuild: true, credit: { author: "J. Doe", license: "unknown", note: "For personal use only: the author's permission is needed to share it" } });
const ownData = JSON.parse(readFileSync(join(pkgDir, "ring", "track_data.json"), "utf8"));
check("the track data's own credit is the circuit's in the package", ok2.checked.ok && ownData.metadata.credit.license === "unknown" && ownData.metadata.author === "J. Doe (unknown)");
check("a build outside public/tracks/ is never removed", existsSync(join(build, "track_data.json")));
packageCircuit(ringOpts);

// --- A converted car as a package, in the same package ---
const carSrc = join(tmp, "car");
write(join(carSrc, "gt-x.glb"), "glb");
write(join(carSrc, "thumb.webp"), "webp");
write(join(carSrc, "skins", "red", "paint.png"), "png");
write(join(carSrc, "skins", "red", "notes.psd"), "photoshop");
write(join(carSrc, "audio", "engine_ext_on_4000.ogg"), "ogg");
const car = packageCar({
  packageDir: pkgDir,
  info,
  car: { localId: "gt-x", title: "GT X", sub: "A test GT", badge: "GT X", classId: "gt3", year: 2024, base: "amg-gt3", physicsPatch: { config: { chassis: { totalMassKg: 1300 } } } },
  model: join(carSrc, "gt-x.glb"),
  thumb: join(carSrc, "thumb.webp"),
  paint: { id: "factory", name: "Factory", swatch: ["#111111", "#eeeeee"] },
  skins: [{ id: "red", name: "Red", swatch: ["#cc0000", "#111111"], dir: join(carSrc, "skins", "red") }],
  sound: { dir: join(carSrc, "audio"), limiterRpm: 7400 },
});
check("a converted car joins the package, which still passes the checks", car.checked.ok, car.checked.problems.join("; "));
const withCar = JSON.parse(readFileSync(join(pkgDir, "mod.json"), "utf8"));
check("the package now holds the circuit and the car", withCar.tracks?.length === 1 && withCar.cars?.length === 1);
check("its physics patch is a physics file on its base model", withCar.cars[0].physics?.base === "amg-gt3" && withCar.cars[0].physics.file === "cars/gt-x/physics.json");
check("a livery file a package can't carry is left out", car.skipped.some((s) => s.endsWith("notes.psd")));
const bad = packageCar({
  packageDir: join(tmp, "mods", "jdoe.bad-car"),
  info: { ...info, id: "jdoe.bad-car" },
  car: { localId: "bad", title: "Bad", sub: "A bad car", badge: "B", classId: "gt3", year: 2024, base: "amg-gt3", physicsPatch: { config: { chassis: { totalMassKg: -5 } } } },
  model: join(carSrc, "gt-x.glb"),
  paint: { id: "factory", name: "Factory", swatch: ["#111111", "#eeeeee"] },
  sound: { car: "amg-gt3" },
});
check("a car whose physics patch the game refuses fails the checks, by its path", !bad.checked.ok && bad.checked.problems.some((p) => /totalMassKg/.test(p)), bad.checked.problems.join("; "));
const carOpts = {
  packageDir: pkgDir,
  info,
  car: { localId: "gt-x", title: "GT X", sub: "A test GT", badge: "GT X", classId: "gt3" as const, year: 2024, base: "amg-gt3" },
  model: join(carSrc, "gt-x.glb"),
  paint: { id: "factory", name: "Factory", swatch: ["#111111", "#eeeeee"] as [string, string] },
  sound: { car: "amg-gt3" },
};
const carIntact = () => existsSync(join(pkgDir, "cars", "gt-x", "gt-x.glb"));
asCheck("a car id that is no id (../..) is refused, and nothing is deleted", refuses(() => packageCar({ ...carOpts, car: { ...carOpts.car, localId: "../.." } }), /not an id/), carIntact());
asCheck("a livery id that is no id is refused", refuses(() => packageCar({ ...carOpts, skins: [{ id: "../red", name: "Red", swatch: ["#cc0000", "#111111"], dir: join(carSrc, "skins", "red") }] }), /not an id/), carIntact());
asCheck("an extra file going outside the package is refused", refuses(() => packageCar({ ...carOpts, extraFiles: [{ from: join(tmp, "LICENSE.txt"), to: "cars/../../escape.txt" }] }), /not a path a package may use/), carIntact());
write(join(carSrc, "skins", "blue", "paint.png"), "png");
symlinkSync(join(tmp, "outside.glb"), join(carSrc, "skins", "blue", "linked.png"));
asCheck("a livery folder holding a symbolic link is refused", refuses(() => packageCar({ ...carOpts, skins: [{ id: "blue", name: "Blue", swatch: ["#0000cc", "#111111"], dir: join(carSrc, "skins", "blue") }] }), /symbolic link/), carIntact());

// --- pack: the zip the game's importer reads ---
void (async () => {
  const c = checkPackage(pkgDir);
  const zip = zipPackage(pkgDir, c.files);
  const entries = await readZip(zip);
  const hashes: Record<string, string> = {};
  for (const e of entries) hashes[e.path] = await sha256Hex(await e.read());
  check("the packed zip reads back whole, with the folder's content hash", (await packageHash(hashes)) === (await hashFolder(pkgDir, c.files)) && entries.length === c.files.length);

  // --- Importers: each file one, with what `npm run mod -- import` shows ---
  const dir = join(__dirname, "..", "mods", "importers");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const imp = ((await import(join(dir, f))) as { default?: Importer }).default;
    check(`importer ${f}: a summary, a usage and a run`, !!imp && typeof imp.summary === "string" && imp.summary.length > 10 && typeof imp.usage === "string" && typeof imp.run === "function");
  }

  rmSync(tmp, { recursive: true, force: true });
  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll mod tool checks passed");
})();
