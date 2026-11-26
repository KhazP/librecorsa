/**
 * Checks a package folder as the game's importer will (mod.json, every file it names, the paths, file types, sizes
 * and links, track data and physics files), and works out its content hash, the one online rooms compare
 * (src/lib/mods/mod-manifest.ts `packageHash`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isSafeModPath, manifestFiles, modSkinDir, packageHash, sha256Hex, validateModManifest } from "../../../src/lib/mods/mod-manifest";
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
  warnings?: string[];
}

const ATLAS_MIN_PX = 1024;
const ATLAS_MAX_PX = 4096;
const ATLAS_RECOMMENDED_PX = 2048;

/** Reads image width and height directly from PNG, WebP or JPEG headers; returns null for unrecognised/corrupt data */
export function readImageDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature + IHDR chunk (length 4, "IHDR" 4, width 4 BE, height 4 BE)
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a &&
    buf.toString("ascii", 12, 16) === "IHDR"
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // WebP: RIFF....WEBP followed by VP8X, VP8L or VP8 chunk
  if (buf.length >= 26 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
    if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    if (chunk === "VP8 " && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
  }

  // JPEG: SOI (FF D8), then walk segments until a SOF frame header
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 3 < buf.length) {
      while (i < buf.length && buf[i] !== 0xff) i++;
      while (i < buf.length && buf[i] === 0xff) i++;
      if (i >= buf.length) break;
      const marker = buf[i++];
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // standalone markers
      if (i + 1 >= buf.length) break;
      const len = buf.readUInt16BE(i);
      if (len < 2 || i + len > buf.length) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && len >= 7) {
        const height = buf.readUInt16BE(i + 3);
        const width = buf.readUInt16BE(i + 5);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += len;
    }
  }
  return null;
}

/** Every problem the game's importer would find in the package folder, its files, and its id */
export function checkPackage(folder: string): Checked {
  const problems: string[] = [];
  const warnings: string[] = [];
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
  // Atlas livery images: must be valid square PNG/WebP/JPEG between 1024 and 4096 px (warn if not 2048)
  for (const s of result.manifest.skins ?? []) {
    if (!s.atlas) continue;
    const rel = `${modSkinDir(s)}/${s.atlas}`;
    if (!present.has(rel)) continue;
    const dims = readImageDimensions(readFileSync(join(folder, rel)));
    if (!dims) {
      problems.push(`${rel}: not a readable PNG, WebP or JPEG image`);
    } else if (dims.width !== dims.height) {
      problems.push(`${rel}: livery atlas image must be square (got ${dims.width}x${dims.height})`);
    } else if (dims.width < ATLAS_MIN_PX || dims.width > ATLAS_MAX_PX) {
      problems.push(`${rel}: livery atlas image must be ${ATLAS_MIN_PX}..${ATLAS_MAX_PX} px square (got ${dims.width}x${dims.height})`);
    } else if (dims.width !== ATLAS_RECOMMENDED_PX) {
      warnings.push(`${rel}: livery atlas image is ${dims.width}x${dims.height}; ${ATLAS_RECOMMENDED_PX}x${ATLAS_RECOMMENDED_PX} is recommended`);
    }
  }
  return { ok: problems.length === 0, id: result.manifest.id, files, problems, ...(warnings.length ? { warnings } : {}) };
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
  for (const w of c.warnings ?? []) console.log(`WARN  ${w}`);
}
