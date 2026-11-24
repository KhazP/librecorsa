/**
 * Adds an `X-File-Size` header rule to the static export's `_headers` (Cloudflare's asset store) for every GLB the
 * export serves itself, so the loading screen knows each model's full size.
 *
 * A Cloudflare compression rule sends GLBs brotli-encoded, with no Content-Length, and the game counts the decoded
 * bytes as they arrive. three's FileLoader reads `X-File-Size` before Content-Length. The bigger files CI moves to R2
 * get the same header from cloudflare/worker.js.
 *
 *   node scripts/site/glb-size-headers.mjs out
 *
 * Run after the files over 25 MiB have gone to R2 (.github/workflows/deploy-pages.yml).
 */
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "out");
const headersFile = path.join(dir, "_headers");
// Cloudflare's limit on `_headers` rules
const MAX_RULES = 100;

const glbs = [];
const walk = (p) => {
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".glb")) glbs.push(full);
  }
};
walk(dir);
glbs.sort();

// A rule starts on an unindented line (its path); its headers follow indented
const existing = readFileSync(headersFile, "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#") && !/^\s/.test(l)).length;
if (existing + glbs.length > MAX_RULES) {
  console.error(`_headers would have ${existing + glbs.length} rules (Cloudflare takes ${MAX_RULES})`);
  process.exit(1);
}

const rules = glbs.map((f) => {
  const url = "/" + path.relative(dir, f).split(path.sep).map(encodeURIComponent).join("/");
  return `${url}\n  X-File-Size: ${statSync(f).size}\n`;
});
if (rules.length) appendFileSync(headersFile, `\n# Full size of each GLB for the loading screen (scripts/site/glb-size-headers.mjs)\n${rules.join("")}`);
for (const r of rules) console.log(r.trim().replace(/\n\s+/, "  "));
