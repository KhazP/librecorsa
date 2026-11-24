/**
 * A folder of packages' list (`_index.json`), as the game reads it to load packages served as files (src/lib/mods/
 * mod-loader.ts): every package folder in it that passes its checks, with its content hash. The launcher makes this
 * list itself; a clone's dev server serves the one written here (public/mods/).
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isModPackageId } from "../../../src/lib/mods/mod-manifest";
import { checkPackage, hashFolder, report } from "./package-check";

export async function writeModsIndex(modsDir: string, quiet = false): Promise<{ id: string; hash: string }[]> {
  const dir = resolve(modsDir);
  mkdirSync(dir, { recursive: true });
  const packages: { id: string; hash: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
    const folder = join(dir, e.name);
    if (!isModPackageId(e.name)) {
      console.log(`SKIP  ${e.name}: a package folder is named by its id ("author.name")`);
      continue;
    }
    const c = checkPackage(folder);
    if (!quiet || !c.ok) report(folder, c);
    if (!c.ok) continue;
    if (c.id !== e.name) {
      console.log(`      its mod.json names "${c.id}": rename the folder to match`);
      continue;
    }
    packages.push({ id: e.name, hash: await hashFolder(folder, c.files) });
  }
  writeFileSync(join(dir, "_index.json"), `${JSON.stringify({ format: 1, packages }, null, 2)}\n`);
  console.log(`wrote ${join(dir, "_index.json")}: ${packages.length} package(s)`);
  return packages;
}
