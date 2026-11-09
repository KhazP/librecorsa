/**
 * Uploads hosted-only files (cars and circuits that live on librecorsa.org, not in the repository; see
 * src/lib/hosted-content.ts) to the librecorsa-assets R2 bucket, at the path the site serves them from.
 * cloudflare/worker.js answers any path with no static file from that bucket.
 *
 *   node scripts/upload-hosted.mjs public/cars/sf26 public/tracks/monza/track_data.json [more files or folders ...]
 *   node scripts/upload-hosted.mjs --dry-run public/cars/sf26
 *
 * Car and cockpit GLBs (any .glb outside public/tracks) go up meshopt-compressed, the copy the site has always served
 * (scripts/compress-car-glb.mjs, run on a temporary copy so the raw file the car tools edit stays as it is). Circuit
 * GLBs go up as they are: they are committed compressed (`npm run compress-tracks`).
 *
 * Needs `wrangler login` (or CLOUDFLARE_API_TOKEN). Cloudflare keeps these files at the edge until the next deploy,
 * so push to main (or re-run the deploy) after replacing a file the site already served.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const BUCKET = "librecorsa-assets";
const TYPES = { ".glb": "model/gltf-binary", ".json": "application/json", ".ogg": "audio/ogg", ".wav": "audio/wav", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".ktx2": "image/ktx2", ".mp4": "video/mp4" };

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targets = args.filter((a) => a !== "--dry-run");
if (!targets.length) {
  console.error("Usage: node scripts/upload-hosted.mjs [--dry-run] <file or folder under public/> ...");
  process.exit(1);
}

const files = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
  else if (!path.basename(p).startsWith(".")) files.push(p);
};
for (const t of targets) {
  const abs = path.resolve(t);
  if (!abs.startsWith(PUBLIC + path.sep)) {
    console.error(`${t}: not under public/`);
    process.exit(1);
  }
  walk(abs);
}

const work = mkdtempSync(path.join(tmpdir(), "lc-upload-"));
let failed = 0;
try {
  for (const file of files) {
    const key = path.relative(PUBLIC, file).split(path.sep).join("/");
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] ?? "application/octet-stream";
    let source = file;
    if (ext === ".glb" && !key.startsWith("tracks/")) {
      source = path.join(work, path.basename(file));
      copyFileSync(file, source);
      const c = spawnSync(process.execPath, [path.join(ROOT, "scripts/compress-car-glb.mjs"), source], { encoding: "utf8" });
      if (c.status !== 0) {
        console.error(`FAIL ${key}: compression failed\n${c.stderr || c.stdout}`);
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
    else failed++;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${files.length - failed} of ${files.length} file(s) ${dryRun ? "checked" : "uploaded"}`);
process.exit(failed ? 1 : 0);
