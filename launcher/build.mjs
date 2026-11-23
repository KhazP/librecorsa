// Cross-compiles the offline launcher (launcher/*.go) into launcher/dist/<os>-<arch>/.
//
// With --bundle, each build also gets the game (`out/`, from `npm run build`) as game/ beside the binary, an empty
// mods/ folder with a README, the converter (launcher/converter/build.mjs) as converter/ and an import/ folder with a
// README: a folder a player can unzip and run.
//
// Usage: npm run launcher:build [-- --bundle] [-- --only darwin-arm64,linux-amd64]
// Needs Go (launcher/go.mod names the version).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const launcherDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(launcherDir, "..");
const distDir = join(launcherDir, "dist");
const outDir = join(repoDir, "out");

const TARGETS = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "amd64" },
  { os: "windows", arch: "amd64" },
  { os: "linux", arch: "amd64" },
];

const args = process.argv.slice(2);
const bundle = args.includes("--bundle");
const onlyAt = args.findIndex((a) => a === "--only" || a.startsWith("--only="));
const only =
  onlyAt < 0 ? null : (args[onlyAt].includes("=") ? args[onlyAt].slice("--only=".length) : (args[onlyAt + 1] ?? "")).split(",").filter(Boolean);
const names = TARGETS.map((t) => `${t.os}-${t.arch}`);
const unknown = (only ?? []).filter((n) => !names.includes(n));
if (unknown.length || only?.length === 0) {
  console.error(`--only ${unknown.join(",") || "(nothing)"}: the targets are ${names.join(", ")}`);
  process.exit(1);
}
const targets = only ? TARGETS.filter((t) => only.includes(`${t.os}-${t.arch}`)) : TARGETS;

if (bundle && !existsSync(join(outDir, "index.html"))) {
  console.error("out/index.html not found: run npm run build first (--bundle copies the game's export)");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));

// The converter is the same for every platform (scripts, no programs): built once, copied beside each launcher
const converterDir = join(distDir, "converter");
if (bundle) execFileSync(process.execPath, [join(launcherDir, "converter", "build.mjs"), "--out", converterDir], { stdio: "inherit" });
const IMPORT_README = readFileSync(join(launcherDir, "import-readme.txt"), "utf8");

/**
 * What of out/ a release leaves behind: Cloudflare's `_headers` (the launcher sets its own), a clone's test packages
 * (`mods/`, which the launcher's own mods/ folder stands in for), source maps, and what a file manager leaves
 */
const leftOut = (rel) => {
  const parts = rel.split(/[\\/]/);
  const base = parts[parts.length - 1];
  return rel === "_headers" || parts[0] === "mods" || base.endsWith(".map") || base === ".DS_Store" || base.toLowerCase() === "thumbs.db";
};

const MODS_README = `Mod packages for LibreCorsa
============================

Put each package here as a folder named by its id, with its mod.json inside:

  mods/
    yourname.yourcircuit/
      mod.json
      ...the files mod.json names

A package id is <author>.<name>: lowercase letters, digits, - and _ (for example "acme.ring").
Folders named otherwise, or without a mod.json, are ignored.

The game lists these packages when it starts: restart it (or reload the page) after adding one.
`;

for (const { os, arch } of targets) {
  const dir = join(distDir, `${os}-${arch}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, os === "windows" ? "librecorsa.exe" : "librecorsa");
  // -trimpath and -buildvcs=false: the same source builds the same binary, whichever folder or checkout it is in
  execFileSync("go", ["build", "-trimpath", "-buildvcs=false", "-ldflags", `-s -w -X main.version=${version}`, "-o", binary, "."], {
    cwd: launcherDir,
    stdio: "inherit",
    env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: "0" },
  });
  if (bundle) {
    cpSync(outDir, join(dir, "game"), { recursive: true, filter: (src) => !leftOut(relative(outDir, src)) });
    mkdirSync(join(dir, "mods"), { recursive: true });
    writeFileSync(join(dir, "mods", "README.txt"), os === "windows" ? MODS_README.replace(/\n/g, "\r\n") : MODS_README);
    cpSync(converterDir, join(dir, "converter"), { recursive: true, filter: (src) => !src.split(/[\\/]/).includes("__pycache__") });
    mkdirSync(join(dir, "import"), { recursive: true });
    writeFileSync(join(dir, "import", "README.txt"), os === "windows" ? IMPORT_README.replace(/\n/g, "\r\n") : IMPORT_README);
  }
  console.log(`${relative(repoDir, binary)}${bundle ? " + game/ + mods/ + converter/ + import/" : ""}`);
}
