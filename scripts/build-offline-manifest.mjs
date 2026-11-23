// Lists what the game needs to start without a network: its pages, Next's scripts, styles and fonts, and the icons the
// pages name. public/sw.js downloads the list once per build into the shell cache (src/lib/service-worker.ts asks it
// to on every load) and serves a page from there only when the server doesn't answer.
//
// Runs after `next build` (npm's postbuild) and writes out/offline-manifest.json. The build id is a hash of the files'
// names and the pages' contents, so a deploy that changes nothing keeps the shell the players have.
//
// Usage: node scripts/build-offline-manifest.mjs [outDir]
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const outDir = process.argv[2] ?? "out";
if (!existsSync(join(outDir, "index.html"))) {
  console.error(`${outDir}/index.html not found: run next build first`);
  process.exit(1);
}

/** Pages a player can open the game from; the others (press kit, admin) need the network anyway */
const PAGES = ["index.html", "play.html", "download.html", "privacy.html"];
/** Small files the pages name directly */
const EXTRA = ["manifest.webmanifest", "favicon.ico"];

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const toUrl = (file) => `/${relative(outDir, file).split(sep).join("/")}`;
/** `index.html` is `/`, `play.html` is `/play`: the URLs the server answers and a player's browser asks for */
const pageUrl = (name) => (name === "index.html" ? "/" : `/${name.replace(/\.html$/, "")}`);

const staticFiles = walk(join(outDir, "_next", "static")).filter((f) => !f.endsWith(".map"));
const pages = PAGES.filter((p) => existsSync(join(outDir, p)));
const extra = EXTRA.filter((p) => existsSync(join(outDir, p)));

const hash = createHash("sha256");
for (const f of staticFiles) hash.update(`${toUrl(f)}\n`);
for (const p of pages) hash.update(readFileSync(join(outDir, p)));
for (const p of extra) hash.update(readFileSync(join(outDir, p)));

const files = [...pages.map(pageUrl), ...extra.map((p) => `/${p}`), ...staticFiles.map(toUrl)];
const bytes = [...pages, ...extra].reduce((n, p) => n + statSync(join(outDir, p)).size, 0) + staticFiles.reduce((n, f) => n + statSync(f).size, 0);
const manifest = { build: hash.digest("hex").slice(0, 12), bytes, files };
writeFileSync(join(outDir, "offline-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`offline-manifest.json: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, build ${manifest.build}`);
