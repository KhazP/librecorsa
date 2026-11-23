// Lists what the game needs to start without a network: its pages and Next's scripts, styles, fonts and wasm.
// public/sw.js downloads the list once per build into the shell cache (src/lib/service-worker.ts asks it to once the
// first circuit has loaded) and serves a page from there only when the server doesn't answer.
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
/**
 * Build output no page loads to run: source maps, the TypeScript of a worker Turbopack emits beside its script, the
 * images crawlers fetch for a link preview, and dotfiles a file manager leaves (.DS_Store)
 */
const NOT_SHELL = /\.map$|\.ts$|\/(opengraph|twitter)-image[^/]*$|\/\.[^/]*$/;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const toUrl = (file) => `/${relative(outDir, file).split(sep).join("/")}`;
/** `index.html` is `/`, `play.html` is `/play`: the URLs the server answers and a player's browser asks for */
const pageUrl = (name) => (name === "index.html" ? "/" : `/${name.replace(/\.html$/, "")}`);

// In name order, so the build id is the same whatever order the file system lists them in
const staticFiles = walk(join(outDir, "_next", "static"))
  .filter((f) => !NOT_SHELL.test(toUrl(f)))
  .sort((a, b) => (toUrl(a) < toUrl(b) ? -1 : toUrl(a) > toUrl(b) ? 1 : 0));
const pages = PAGES.filter((p) => existsSync(join(outDir, p)));

const hash = createHash("sha256");
for (const f of staticFiles) hash.update(`${toUrl(f)}\n`);
for (const p of pages) hash.update(readFileSync(join(outDir, p)));

const files = [...pages.map(pageUrl), ...staticFiles.map(toUrl)];
const bytes = pages.reduce((n, p) => n + statSync(join(outDir, p)).size, 0) + staticFiles.reduce((n, f) => n + statSync(f).size, 0);
const manifest = { build: hash.digest("hex").slice(0, 12), bytes, files };
writeFileSync(join(outDir, "offline-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`offline-manifest.json: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, build ${manifest.build}`);
