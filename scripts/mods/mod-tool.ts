/**
 * The modder's tool for mod packages (docs/modding.md, docs/importing-mods.md):
 *
 *   npm run mod -- check <folder>              checks a package as the game will: its mod.json, paths, every file it names
 *   npm run mod -- pack <folder> [out.zip]     checks it, then zips it the way the game's importer reads it
 *   npm run mod -- index [mods folder]         lists the packages in a folder (default public/mods) for the dev server
 *   npm run mod -- catalogue <folder of zips>  writes a catalogue of packed packages the game's Mods panel offers
 *   npm run mod -- import                      lists the importers: content from other games and tools to packages
 *   npm run mod -- import <name> …             runs one (scripts/mods/importers/<name>.ts)
 *   npm run mod -- from-circuit <built id> …   packages a circuit the converters built in public/tracks/
 *   npm run mod -- from-car <spec.json>        packages a converted car, as the spec describes it
 *
 * A package's content hash is the one online rooms compare (src/lib/mods/mod-manifest.ts `packageHash`).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildCatalogue, catalogueJson } from "./lib/catalogue";
import { packageCar, type CarPackageOptions } from "./lib/car-package";
import { packageCircuit, readCircuitEntry } from "./lib/circuit-package";
import { importTarget, PACKAGE_USAGE, parseImportArgs, type Importer } from "./lib/importer";
import { localIdFrom, packageCredit } from "./lib/manifest-file";
import { writeModsIndex } from "./lib/mods-index";
import { checkPackage, hashFolder, report } from "./lib/package-check";
import { BUILT_TRACKS_DIR, DEFAULT_MODS_DIR } from "./lib/toolchain";
import { zipPackage } from "./lib/zip-writer";

const IMPORTERS_DIR = join(__dirname, "importers");

/** The importers there are: one file each in importers/ */
const importerNames = (): string[] =>
  readdirSync(IMPORTERS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => f.slice(0, -3))
    .sort();

async function loadImporter(name: string): Promise<Importer> {
  if (!importerNames().includes(name)) throw new Error(`no importer "${name}"; the importers are: ${importerNames().join(", ")}`);
  const mod = (await import(join(IMPORTERS_DIR, `${name}.ts`))) as { default: Importer };
  return mod.default;
}

/** After an import into the mods folder the dev server serves: its list, so the package shows up there at once */
async function reindex(packageDir: string): Promise<void> {
  if (resolve(dirname(packageDir)) === resolve(DEFAULT_MODS_DIR)) await writeModsIndex(DEFAULT_MODS_DIR, true);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "check" && args[0]) {
    const folder = resolve(args[0]);
    const c = checkPackage(folder);
    report(folder, c);
    if (c.ok) console.log(`      content hash ${await hashFolder(folder, c.files)}`);
    process.exit(c.ok ? 0 : 1);
  }

  if (command === "pack" && args[0]) {
    const folder = resolve(args[0]);
    const c = checkPackage(folder);
    report(folder, c);
    if (!c.ok) process.exit(1);
    const out = resolve(args[1] ?? `${c.id}.zip`);
    writeFileSync(out, zipPackage(folder, c.files));
    console.log(`      wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB), content hash ${await hashFolder(folder, c.files)}`);
    return;
  }

  if (command === "index") {
    await writeModsIndex(args[0] ?? DEFAULT_MODS_DIR);
    return;
  }

  if (command === "catalogue" && args[0] && !args[0].startsWith("-")) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { "base-url": { type: "string" }, out: { type: "string" } } });
    const folder = resolve(positionals[0]);
    const out = resolve(values.out ?? join(folder, "catalogue.json"));
    const { catalogue, failures } = await buildCatalogue(folder, values["base-url"], (file, r) => {
      if (r.ok) console.log(`OK    ${r.entry.id} ${r.entry.version} (${file}, ${(r.entry.bytes / 1024 / 1024).toFixed(1)} MB) content hash ${r.entry.hash}`);
      else {
        console.log(`FAIL  ${file}`);
        for (const p of r.problems) console.log(`      ${p}`);
      }
    });
    for (const f of failures.filter((f) => f.file === folder)) for (const p of f.problems) console.log(`FAIL  ${p}`);
    if (failures.length) {
      console.log(`nothing written: ${failures.length} problem(s) above. A catalogue is written only when every zip passes`);
      process.exit(1);
    }
    writeFileSync(out, catalogueJson(catalogue));
    console.log(`wrote ${out}: ${catalogue.packages.length} package(s)`);
    return;
  }

  if (command === "import") {
    const [name, ...rest] = args;
    if (!name || name === "--help") {
      console.log("Importers (npm run mod -- import <name> --help for one's options):\n");
      for (const n of importerNames()) console.log(`  ${n.padEnd(16)} ${(await loadImporter(n)).summary}`);
      return;
    }
    const importer = await loadImporter(name);
    if (rest.includes("--help")) {
      console.log(`npm run mod -- import ${name} ${importer.usage}`);
      return;
    }
    await importer.run(rest);
    // The dev server's list of packages, so what was imported shows up there at once
    await writeModsIndex(DEFAULT_MODS_DIR, true);
    return;
  }

  if (command === "from-circuit" && args[0] && !args[0].startsWith("-")) {
    const [builtId, ...rest] = args;
    const { values } = parseImportArgs(rest, { id: { type: "string" } });
    const entry = readCircuitEntry(join(BUILT_TRACKS_DIR, builtId), builtId);
    const credit = packageCredit(entry.credit ?? {});
    const localId = localIdFrom(values.id ?? builtId);
    const { info, packageDir } = importTarget(values, { author: credit.author, name: entry.name, credit });
    const out = packageCircuit({ builtId, packageDir, info, localId, removeBuild: false });
    report(packageDir, out.checked);
    if (out.skipped.length) console.log(`      left out (the track data doesn't name them): ${out.skipped.join(", ")}`);
    await reindex(packageDir);
    process.exit(out.checked.ok ? 0 : 1);
  }

  if (command === "from-car" && args[0]) {
    const specPath = resolve(args[0]);
    // Paths in the spec are relative to it
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as CarPackageOptions;
    const at = (p: string) => resolve(dirname(specPath), p);
    const out = packageCar({
      ...spec,
      packageDir: resolve(spec.packageDir ? at(spec.packageDir) : join(DEFAULT_MODS_DIR, spec.info.id)),
      model: at(spec.model),
      thumb: spec.thumb && at(spec.thumb),
      skins: spec.skins?.map((s) => ({ ...s, dir: at(s.dir) })),
      sound: "dir" in spec.sound ? { ...spec.sound, dir: at(spec.sound.dir) } : spec.sound,
    });
    report(basename(specPath), out.checked);
    if (out.skipped.length) console.log(`      left out: ${out.skipped.join(", ")}`);
    process.exit(out.checked.ok ? 0 : 1);
  }

  console.log(`Usage:
  npm run mod -- check <folder>
  npm run mod -- pack <folder> [out.zip]
  npm run mod -- index [mods folder, default public/mods]
  npm run mod -- catalogue <folder of zips> [--base-url <url>] [--out <file>]
                                           (--base-url: where the zips are served, default beside the catalogue;
                                            --out: default catalogue.json in the folder)
  npm run mod -- import [<name> …]          (no name: list the importers)
  npm run mod -- from-circuit <built id> [--id <circuit id>]
${PACKAGE_USAGE}
  npm run mod -- from-car <spec.json>      (scripts/mods/lib/car-package.ts CarPackageOptions, paths relative to it)`);
  process.exit(command ? 1 : 0);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
