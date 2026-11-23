/**
 * The modder's tool for mod packages (docs/modding.md):
 *
 *   npm run mod -- check <folder>            checks a package as the game will: its mod.json, its paths, every file it names
 *   npm run mod -- pack <folder> [out.zip]   checks it, then zips it the way the game's importer reads (deflate, no zip64)
 *   npm run mod -- index [mods folder]       writes <mods folder>/_index.json (default public/mods), listing every
 *                                            package in it with its content hash, so a clone's dev server serves them
 *
 * A package's content hash is the one online rooms compare (src/lib/mods/mod-manifest.ts `packageHash`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { isModPackageId, isSafeModPath, manifestFiles, packageHash, sha256Hex, validateModManifest } from "../src/lib/mods/mod-manifest";
import { modDefinitions } from "../src/lib/mods/mod-content";
import { isArchiveJunk } from "../src/lib/mods/zip-reader";

const PACKAGE_FILE = /\.(glb|gltf|bin|json|webp|png|jpe?g|ktx2|ogg|wav|mp3|txt|md)$/i;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

const relPath = (root: string, file: string) => relative(root, file).split(sep).join("/");

interface Checked {
  ok: boolean;
  id?: string;
  files: string[];
  problems: string[];
}

function check(folder: string): Checked {
  const problems: string[] = [];
  const manifestPath = join(folder, "mod.json");
  if (!existsSync(manifestPath)) return { ok: false, files: [], problems: ["no mod.json at the top of the folder"] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ok: false, files: [], problems: [`mod.json is not valid JSON: ${(err as Error).message}`] };
  }
  const result = validateModManifest(raw, modDefinitions());
  if (!result.ok) return { ok: false, files: [], problems: result.errors };
  const files = walk(folder).map((f) => relPath(folder, f)).filter((p) => !isArchiveJunk(p));
  for (const p of files) {
    if (!isSafeModPath(p)) problems.push(`${p}: not a path a package may use`);
    else if (!PACKAGE_FILE.test(p)) problems.push(`${p}: not a file type a package may carry`);
  }
  const present = new Set(files);
  for (const needed of manifestFiles(result.manifest)) if (!present.has(needed)) problems.push(`${needed}: named in mod.json but missing`);
  // A circuit's track data: parsed, with the model it names in the package
  for (const t of result.manifest.tracks ?? []) {
    if (!present.has(t.data)) continue;
    try {
      const data = JSON.parse(readFileSync(join(folder, t.data), "utf8")) as { metadata?: { mesh?: { url?: unknown; scenery?: unknown } }; samples?: unknown };
      const url = data.metadata?.mesh?.url;
      if (typeof url !== "string") problems.push(`${t.data}: metadata.mesh.url (the circuit's model) is missing`);
      else if (isSafeModPath(url) && !present.has(url)) problems.push(`${t.data}: names ${url}, which is not in the package`);
      if (!Array.isArray(data.samples) || data.samples.length < 10) problems.push(`${t.data}: has no samples (scripts/tracks write them)`);
    } catch (err) {
      problems.push(`${t.data}: not valid JSON (${(err as Error).message})`);
    }
  }
  const tooBig = files.filter((p) => statSync(join(folder, p)).size > 0xfffffffe);
  for (const p of tooBig) problems.push(`${p}: over 4 GB, more than a package file may be`);
  return { ok: problems.length === 0, id: result.manifest.id, files, problems };
}

async function hashFolder(folder: string, files: string[]): Promise<string> {
  const hashes: Record<string, string> = {};
  for (const p of files) hashes[p] = await sha256Hex(readFileSync(join(folder, p)));
  return packageHash(hashes);
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of the files as the game's reader takes them: deflated (stored when that is no smaller), UTF-8 names */
function zip(folder: string, files: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const p of files) {
    const data = readFileSync(join(folder, p));
    const deflated = deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const name = Buffer.from(p, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xfffffffe) throw new Error("the package is over 4 GB zipped: split it in two");
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function report(folder: string, c: Checked): void {
  if (c.ok) console.log(`OK    ${c.id} (${c.files.length} files) in ${folder}`);
  else {
    console.log(`FAIL  ${folder}`);
    for (const p of c.problems) console.log(`      ${p}`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check" && args[0]) {
    const folder = resolve(args[0]);
    const c = check(folder);
    report(folder, c);
    if (c.ok) console.log(`      content hash ${await hashFolder(folder, c.files)}`);
    process.exit(c.ok ? 0 : 1);
  }
  if (command === "pack" && args[0]) {
    const folder = resolve(args[0]);
    const c = check(folder);
    report(folder, c);
    if (!c.ok) process.exit(1);
    const out = resolve(args[1] ?? `${c.id}.zip`);
    writeFileSync(out, zip(folder, c.files));
    console.log(`      wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB), content hash ${await hashFolder(folder, c.files)}`);
    return;
  }
  if (command === "index") {
    const dir = resolve(args[0] ?? "public/mods");
    mkdirSync(dir, { recursive: true });
    const packages: { id: string; hash: string }[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const folder = join(dir, e.name);
      if (!isModPackageId(e.name)) {
        console.log(`SKIP  ${e.name}: a package folder is named by its id ("author.name")`);
        continue;
      }
      const c = check(folder);
      report(folder, c);
      if (!c.ok) continue;
      if (c.id !== e.name) {
        console.log(`      its mod.json names "${c.id}": rename the folder to match`);
        continue;
      }
      packages.push({ id: e.name, hash: await hashFolder(folder, c.files) });
    }
    writeFileSync(join(dir, "_index.json"), `${JSON.stringify({ format: 1, packages }, null, 2)}\n`);
    console.log(`\nwrote ${join(dir, "_index.json")}: ${packages.length} package(s)`);
    return;
  }
  console.log(`Usage:
  npm run mod -- check <folder>
  npm run mod -- pack <folder> [out.zip]
  npm run mod -- index [mods folder, default public/mods]`);
  process.exit(command ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

