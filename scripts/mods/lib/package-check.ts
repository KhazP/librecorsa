/**
 * Checks a package folder as the game's importer will (mod.json, every file it names, the paths, file types, sizes
 * and links, track data and physics files), and works out its content hash, the one online rooms compare
 * (src/lib/mods/mod-manifest.ts `packageHash`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isSafeModPath, manifestFiles, packageHash, sha256Hex, validateModManifest } from "../../../src/lib/mods/mod-manifest";
import { modCarProfile, modDefinitions } from "../../../src/lib/mods/mod-content";
import { packageFileProblems } from "../../../src/lib/mods/mod-store";
import { isArchiveJunk, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES } from "../../../src/lib/mods/zip-reader";
import { resolveModTrackUrls } from "../../../src/lib/mods/mod-urls";

/** The package's files, and its links: a link isn't packed as one (a zip holds it as the file, or not at all) */
export function walk(dir: string, links: string[] = []): { files: string[]; links: string[] } {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) links.push(p);
    else if (e.isDirectory()) files.push(...walk(p, links).files);
    else if (e.isFile()) files.push(p);
  }
  return { files, links };
}

/** A path relative to `root`, with forward slashes */
export const relPath = (root: string, file: string) => relative(root, file).split(sep).join("/");

export interface Checked {
  ok: boolean;
  id?: string;
  files: string[];
  problems: string[];
}

/** Every problem the game's importer would find in the package folder, its files, and its id */
export function checkPackage(folder: string): Checked {
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
  const tree = walk(folder);
  for (const link of tree.links) problems.push(`${relPath(folder, link)}: a link; put the file itself in the package`);
  const files = tree.files.map((f) => relPath(folder, f)).filter((p) => !isArchiveJunk(p));
  problems.push(...packageFileProblems(files));
  if (files.length > ZIP_MAX_ENTRIES) problems.push(`the package holds more than ${ZIP_MAX_ENTRIES} files`);
  if (files.reduce((n, p) => n + statSync(join(folder, p)).size, 0) > ZIP_MAX_TOTAL_BYTES) problems.push("the package is larger than 2 GB, more than the game imports");
  const present = new Set(files);
  for (const needed of manifestFiles(result.manifest)) if (!present.has(needed)) problems.push(`${needed}: named in mod.json but missing`);
  // A circuit's track data: parsed, with the model it names in the package
  for (const t of result.manifest.tracks ?? []) {
    if (!present.has(t.data)) continue;
    try {
      const data = JSON.parse(readFileSync(join(folder, t.data), "utf8")) as { metadata?: { mesh?: { url?: unknown; scenery?: unknown } }; samples?: unknown };
      const url = data.metadata?.mesh?.url;
      if (typeof url !== "string") problems.push(`${t.data}: metadata.mesh.url (the circuit's model) is missing`);
      try {
        // As the game reads it: every file it names is a path in the package
        resolveModTrackUrls(data, result.manifest.id);
      } catch (err) {
        problems.push(`${t.data}: ${(err as Error).message}`);
      }
      const named = [url, ...(Array.isArray(data.metadata?.mesh?.scenery) ? data.metadata.mesh.scenery : [])];
      for (const f of named) if (typeof f === "string" && isSafeModPath(f) && !present.has(f)) problems.push(`${t.data}: names ${f}, which is not in the package`);
      if (!Array.isArray(data.samples) || data.samples.length < 10) problems.push(`${t.data}: has no samples (scripts/tracks write them)`);
    } catch (err) {
      problems.push(`${t.data}: not valid JSON (${(err as Error).message})`);
    }
  }
  // A car's physics file, read as the game reads it: every value it changes checked against its base model
  for (const c of result.manifest.cars ?? []) {
    if (typeof c.physics === "string" || !present.has(c.physics.file)) continue;
    let file: unknown;
    try {
      file = JSON.parse(readFileSync(join(folder, c.physics.file), "utf8"));
    } catch (err) {
      problems.push(`${c.physics.file}: not valid JSON (${(err as Error).message})`);
      continue;
    }
    const physics = modCarProfile(result.manifest, c, file, undefined);
    if (!physics.ok) problems.push(...physics.errors);
  }
  return { ok: problems.length === 0, id: result.manifest.id, files, problems };
}

export async function hashFolder(folder: string, files: string[]): Promise<string> {
  const hashes: Record<string, string> = {};
  for (const p of files) hashes[p] = await sha256Hex(readFileSync(join(folder, p)));
  return packageHash(hashes);
}

export function report(folder: string, c: Checked): void {
  if (c.ok) console.log(`OK    ${c.id} (${c.files.length} files) in ${folder}`);
  else {
    console.log(`FAIL  ${folder}`);
    for (const p of c.problems) console.log(`      ${p}`);
  }
}
