/**
 * Uploads hosted-only files (cars and circuits that live on librecorsa.org, not in the repository; see
 * src/lib/hosted-content.ts) to the librecorsa-assets R2 bucket, at the path the site serves them from.
 * cloudflare/worker.js answers any path with no static file from that bucket.
 *
 *   node scripts/upload-hosted.mjs public/cars/bmw-m4-gt3 public/tracks/monaco/track_data.json [more files or folders ...]
 *   node scripts/upload-hosted.mjs --dry-run public/cars/bmw-m4-gt3
 *
 * Car and cockpit GLBs (any .glb outside public/tracks) go up meshopt-compressed, the copy the site has always served
 * (scripts/compress-car-glb.mjs, run on a temporary copy so the raw file the car tools edit stays as it is). Circuit
 * GLBs go up as they are: they are committed compressed (`npm run compress-tracks`).
 *
 * A venue's split model (src/lib/venue-models.ts) is one shared file and one file per layout. Uploading a layout file
 * brings its shared file along when it is here; each file goes up once however many targets name it, and shared files
 * go first, so R2 never holds a layout file without its shared file. When a shared file fails to go up, its layout
 * files stay off R2 in that run and the script exits 1.
 *
 * Needs `wrangler login` (or CLOUDFLARE_API_TOKEN). Cloudflare keeps these files at the edge until the next deploy,
 * so push to main (or re-run the deploy) after replacing a file the site already served.
 */
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const BUCKET = "librecorsa-assets";
const TYPES = { ".glb": "model/gltf-binary", ".json": "application/json", ".ogg": "audio/ogg", ".wav": "audio/wav", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".ktx2": "image/ktx2", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targets = args.filter((a) => a !== "--dry-run");
if (!targets.length) {
  console.error("Usage: node scripts/upload-hosted.mjs [--dry-run] <file or folder under public/> ...");
  process.exit(1);
}

const found = new Set();
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
  else if (!path.basename(p).startsWith(".")) found.add(p);
};
for (const t of targets) {
  const abs = path.resolve(t);
  if (!abs.startsWith(PUBLIC + path.sep)) {
    console.error(`${t}: not under public/`);
    process.exit(1);
  }
  walk(abs);
}

/** A GLB's JSON chunk (the first chunk, read without loading the whole file) */
function glbJson(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 20);
    return JSON.parse(json.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

// A venue layout file names its shared file (scripts/tracks/split-venue-model.mjs): bring it along, once
const VENUE_LAYOUT = /\.layout\.[0-9a-f]{8}\.glb$/;
/** Each venue layout file's shared file */
const sharedOf = new Map();
for (const file of [...found]) {
  if (!VENUE_LAYOUT.test(file)) continue;
  const venue = glbJson(file).extras?.lcVenueLayout;
  if (!venue) continue;
  const shared = path.join(PUBLIC, "tracks", venue.venue, `${venue.venue}.shared.${venue.shared}.glb`);
  sharedOf.set(file, shared);
  if (existsSync(shared)) found.add(shared);
  else console.warn(`note: ${path.relative(PUBLIC, file)} needs ${path.relative(PUBLIC, shared)}, which is not in this copy: make sure R2 has it`);
}
const isShared = (f) => /\.shared\.[0-9a-f]{8}\.glb$/.test(f);
const files = [...[...found].filter(isShared), ...[...found].filter((f) => !isShared(f))];

const work = mkdtempSync(path.join(tmpdir(), "lc-upload-"));
const keyOf = (file) => path.relative(PUBLIC, file).split(path.sep).join("/");
/** Files that failed to go up in this run */
const failedFiles = new Set();
/** Layout files kept off R2 because their shared file failed */
const heldBack = [];
let failed = 0;
try {
  for (const file of files) {
    const key = keyOf(file);
    // Shared files went first: a layout file whose shared file failed would be a layout R2 can't load
    const shared = sharedOf.get(file);
    if (shared && failedFiles.has(shared)) {
      console.error(`SKIP ${key}: its shared file ${keyOf(shared)} failed to upload, so it stays off R2`);
      heldBack.push(key);
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] ?? "application/octet-stream";
    let source = file;
    if (ext === ".glb" && !key.startsWith("tracks/")) {
      source = path.join(work, path.basename(file));
      copyFileSync(file, source);
      const c = spawnSync(process.execPath, [path.join(ROOT, "scripts/compress-car-glb.mjs"), source], { encoding: "utf8" });
      if (c.status !== 0) {
        console.error(`FAIL ${key}: compression failed\n${c.stderr || c.stdout}`);
        failedFiles.add(file);
        failed++;
        continue;
      }
    }
    const size = `${(statSync(source).size / 1048576).toFixed(1)} MB`;
    if (dryRun) {
      console.log(`would upload ${key} (${type}, ${size})`);
      continue;
    }
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const r = spawnSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", source, "--content-type", type, "--remote"], {
        cwd: ROOT,
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
      });
      ok = r.status === 0;
      if (!ok && attempt === 3) console.error(`FAIL ${key}: ${(r.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`);
    }
    if (ok) console.log(`ok ${key} (${size})`);
    else {
      failedFiles.add(file);
      failed++;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${files.length - failed - heldBack.length} of ${files.length} file(s) ${dryRun ? "checked" : "uploaded"}`);
if (heldBack.length) {
  console.error(`${heldBack.length} layout file(s) held back because their shared file failed; upload them again together with it:\n  ${heldBack.join("\n  ")}`);
}
process.exit(failed || heldBack.length ? 1 : 0);
