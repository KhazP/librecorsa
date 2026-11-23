// Builds the converter the offline launcher runs to turn another game's circuit or car into a mod package
// (launcher/README.md, "Converting in the launcher"): everything `npm run mod -- import` needs except Python, Node and
// the packages they download on first use.
//
// The converter keeps the repository's layout, so the tools find each other where they do in a clone: the Python
// converters are copied as they are, and each TypeScript or JavaScript tool is bundled by esbuild into one
// self-contained .mjs file where its source is (scripts/mods/mod-tool.ts → scripts/mods/mod-tool.mjs), its npm
// dependencies inlined. scripts/mods/lib/toolchain.ts and scripts/tracks/build_track.py run that .mjs when the
// TypeScript source isn't there.
//
//   converter/
//     converter.json                what the launcher reads: the mod tool, the importers, Python's version and packages
//     scripts/mods/mod-tool.mjs     `import <kind> <folder> --out <mods folder>`
//     scripts/mods/importers/*.mjs  one per importer
//     scripts/tracks/*.py, scripts/cars/*.py, requirements.txt …
//     public/tracks/index.json      an empty circuit list: a converter builds in public/tracks/<working id>/
//     THIRD_PARTY_NOTICES.txt       the licences of the npm packages inlined in the tools
//
// Every path this takes from the repository is in the lists below.
//
// Usage: node launcher/converter/build.mjs [--out <dir>]   (default launcher/dist/converter)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The folders of Python converters, copied with the data files they read (requirements, settings, physics patches) */
const PYTHON_DIRS = ["scripts/tracks", "scripts/cars"];
/** What of those folders is copied: the scripts and their data, not the circuits' sources or a modder's local settings */
const PYTHON_FILE = /\.(py|txt|json)$/;
const PYTHON_LEFT_OUT = new Set(["sources.local.json"]);

/** The mod tool the launcher runs, and the folder of importers it loads by name */
const MOD_TOOL = "scripts/mods/mod-tool.ts";
const IMPORTERS_DIR = "scripts/mods/importers";

/**
 * The other scripts an import runs, through runTsx (scripts/mods/lib/toolchain.ts) or `node <script>` from a Python
 * converter, or as a file beside one of these (scripts/lib/glb-geometry.ts runs decode-meshopt-glb.mjs). A script an
 * importer starts to run belongs here.
 */
const TOOLS = [
  "scripts/optimize-racing-line.ts",
  "scripts/lib/decode-meshopt-glb.mjs",
  "scripts/compress-track-glb.mjs",
  "scripts/compress-car-glb.mjs",
  "scripts/graft-track-extras.mjs",
  "scripts/cars/mod-physics-import.ts",
];

/** The Python the converters run on (scripts/mods/lib/toolchain.ts runPython), and the requirements files to fetch first */
const PYTHON_VERSION = "3.14";
const PYTHON_REQUIREMENTS = ["scripts/tracks/requirements.txt"];

/** Where a converter builds a circuit before it is packaged (scripts/mods/lib/toolchain.ts BUILT_TRACKS_DIR) */
const WORK_DIR = "public/tracks";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outDir = outAt >= 0 ? args[outAt + 1] : join(repoDir, "launcher", "dist", "converter");
if (!outDir) {
  console.error("--out needs a folder");
  process.exit(1);
}

const slash = (p) => p.split(sep).join("/");
const isRepoSource = (file) => file.startsWith(repoDir + sep) && !file.includes(`${sep}node_modules${sep}`);

/**
 * sharp (image processing, a native module) is reached only through @gltf-transform/functions' texture functions
 * (ndarray-pixels), which no converter calls: the converters' textures are made in Python (Pillow). It is left out
 * rather than installed per platform, and says so if a future script does call it.
 */
const SHARP_STUB = `export default function sharp() {
  throw new Error("sharp (image processing in Node) is not part of the launcher's converter: resize or encode textures in Python, or install sharp beside the converter");
}`;

/**
 * Keeps each bundled source's idea of where it is. A tool finds its data and the scripts it runs from `__dirname`,
 * `__filename` or `import.meta.url`; once bundled, those would name the bundle or a shared chunk. So each source is
 * given its own place in the converter, which keeps the repository's layout: its folder found from the converter's
 * root (the folder holding converter.json). An entry's own file is its bundle (a tool that runs itself again runs
 * that).
 */
const placesPlugin = (entries) => ({
  name: "librecorsa-converter-places",
  setup(b) {
    b.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "librecorsa-stub" }));
    b.onLoad({ filter: /.*/, namespace: "librecorsa-stub" }, () => ({ contents: SHARP_STUB, loader: "js" }));
    b.onLoad({ filter: /\.(ts|mts|cts|js|mjs|cjs)$/ }, (a) => {
      if (!isRepoSource(a.path)) return undefined;
      let src = readFileSync(a.path, "utf8");
      const rel = slash(relative(repoDir, a.path));
      const file = JSON.stringify(entries.has(a.path) ? bundledName(rel) : rel);
      const dir = JSON.stringify(slash(dirname(rel)));
      src = src.replace(/\bimport\.meta\.(url|dirname|filename)\b/g, (_, what) =>
        what === "url" ? `__lcUrlOf(${file})` : what === "dirname" ? `__lcJoin(__lcRoot, ${dir})` : `__lcJoin(__lcRoot, ${file})`,
      );
      // A CommonJS-style source (the TypeScript tools run as CommonJS under tsx) uses __dirname and __filename, which
      // an ES module hasn't got: they are declared for it, unless it declares its own
      const declares = (v) => new RegExp(`\\b(const|let|var)\\s+${v}\\b`).test(src);
      let prelude = "";
      if (/\b__dirname\b/.test(src) && !declares("__dirname")) prelude += `const __dirname = __lcJoin(__lcRoot, ${dir});\n`;
      if (/\b__filename\b/.test(src) && !declares("__filename")) prelude += `const __filename = __lcJoin(__lcRoot, ${file});\n`;
      return { contents: prelude + src, loader: extname(a.path).endsWith("ts") ? "ts" : "js", resolveDir: dirname(a.path) };
    });
  },
});

/** A script's bundle: where its source is, as .mjs */
const bundledName = (rel) => rel.replace(/\.(ts|mts|mjs|js)$/, ".mjs");

/**
 * What every bundle and chunk starts with: `require` for the CommonJS packages it inlines, and the converter's root
 * (the folder above it that holds converter.json)
 */
const BANNER = [
  `import { createRequire as __lcCreateRequire } from "node:module";`,
  `import { existsSync as __lcExists } from "node:fs";`,
  `import { fileURLToPath as __lcFileURLToPath, pathToFileURL as __lcPathToFileURL } from "node:url";`,
  `import { dirname as __lcDirname, join as __lcJoin } from "node:path";`,
  `const require = __lcCreateRequire(import.meta.url);`,
  `const __lcRoot = (() => { let d = __lcDirname(__lcFileURLToPath(import.meta.url)); while (!__lcExists(__lcJoin(d, "converter.json")) && __lcDirname(d) !== d) d = __lcDirname(d); return d; })();`,
  `const __lcUrlOf = (rel) => __lcPathToFileURL(__lcJoin(__lcRoot, rel)).href;`,
].join("\n");

/**
 * Bundles the scripts into <out>/<each one's path, as .mjs>, the code they share in scripts/_chunks/; returns the npm
 * packages inlined
 */
async function bundleAll(rels) {
  const entries = new Set(rels.map((rel) => join(repoDir, rel)));
  const result = await build({
    entryPoints: [...entries],
    outdir: outDir,
    outbase: repoDir,
    entryNames: "[dir]/[name]",
    chunkNames: "scripts/_chunks/[name]-[hash]",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: BANNER },
    // Their licence texts go in THIRD_PARTY_NOTICES.txt; the bundles keep the comments that carry one
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
    plugins: [placesPlugin(entries)],
  });
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) packages.add(m[1]);
    if (/\.node$/.test(input)) throw new Error(`a script inlines a native module (${input}): the converter has to stay free of any platform`);
  }
  for (const rel of rels) {
    if (!existsSync(join(outDir, bundledName(rel)))) throw new Error(`${rel} wasn't bundled to ${bundledName(rel)}`);
  }
  return packages;
}

/** The licence file of an npm package, for THIRD_PARTY_NOTICES.txt */
function licenceOf(pkg) {
  const dir = join(repoDir, "node_modules", pkg);
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return { name: pkg, version: meta.version, license: meta.license ?? "see its package", text: file ? readFileSync(join(dir, file), "utf8").trim() : "" };
}

function copyPython() {
  const copied = [];
  for (const dir of PYTHON_DIRS) {
    const walk = (from) => {
      for (const e of readdirSync(from, { withFileTypes: true })) {
        const p = join(from, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__pycache__" && e.name !== "sources") walk(p);
        } else if (e.isFile() && PYTHON_FILE.test(e.name) && !PYTHON_LEFT_OUT.has(e.name) && !/\.bak/.test(e.name)) {
          const rel = slash(relative(repoDir, p));
          mkdirSync(dirname(join(outDir, rel)), { recursive: true });
          cpSync(p, join(outDir, rel));
          copied.push(rel);
        }
      }
    };
    walk(join(repoDir, dir));
  }
  return copied;
}

const sizeOf = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? sizeOf(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const importers = readdirSync(join(repoDir, IMPORTERS_DIR))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => f.slice(0, -3))
  .sort();
const missing = [MOD_TOOL, ...TOOLS].filter((rel) => !existsSync(join(repoDir, rel)));
if (missing.length) {
  console.error(`launcher/converter/build.mjs names scripts that aren't there (moved?): ${missing.join(", ")}`);
  process.exit(1);
}

// converter.json first: the bundles find the converter's root by it
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "converter.json"), "{}\n");
const inlined = await bundleAll([MOD_TOOL, ...importers.map((n) => `${IMPORTERS_DIR}/${n}.ts`), ...TOOLS]);
const python = copyPython();

// The converters build a circuit in public/tracks/<working id>/ and read the game's circuit list there
mkdirSync(join(outDir, WORK_DIR), { recursive: true });
writeFileSync(join(outDir, WORK_DIR, "index.json"), "[]\n");

const { version } = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
const manifest = {
  format: 1,
  version,
  modTool: bundledName(MOD_TOOL),
  importers,
  python: { version: PYTHON_VERSION, requirements: PYTHON_REQUIREMENTS },
  // Where the converters build before packaging: its folders are working copies the launcher removes after each
  // conversion (one that was stopped leaves its own)
  work: [WORK_DIR],
};
for (const rel of PYTHON_REQUIREMENTS) {
  if (!python.includes(rel)) throw new Error(`${rel} is a requirements file the converter needs but didn't copy`);
}
writeFileSync(join(outDir, "converter.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const notices = [...inlined]
  .filter((p) => p !== "sharp")
  .sort()
  .map(licenceOf)
  .map((l) => `${l.name} ${l.version} (${l.license})\n${"-".repeat(72)}\n${l.text}\n`);
writeFileSync(
  join(outDir, "THIRD_PARTY_NOTICES.txt"),
  `The launcher's converter bundles these npm packages into its scripts (scripts/**/*.mjs).\n\n${notices.join("\n")}`,
);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `${slash(relative(repoDir, outDir)) || outDir}: ${importers.length} importer(s) (${importers.join(", ")}), ${TOOLS.length + 1} tools, ` +
    `${python.length} Python files, ${inlined.size} npm packages inlined; ${mb(sizeOf(outDir))}`,
);
