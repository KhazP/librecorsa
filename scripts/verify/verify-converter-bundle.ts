/**
 * The offline launcher's converter (launcher/converter/build.mjs): it builds, holds every importer and every script an
 * import runs as a bundle where its source is, carries no native module, and its tools find the converter's own
 * folders rather than the repository's. No conversion runs here (that needs Python); the launcher's Go tests and a
 * real conversion in a release cover the rest (launcher/README.md).
 *
 *   npx tsx scripts/verify/verify-converter-bundle.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failed++;
}

const repo = join(__dirname, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "converter-"));
const out = join(tmp, "converter");
// Only PATH from this environment, as the launcher gives its converter
const node = (args: string[]) =>
  spawnSync(process.execPath, args, { cwd: tmp, encoding: "utf8", env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "" } });
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [relative(out, join(dir, e.name)).split("\\").join("/")]));

// The simplify step needs a GLB written first (asynchronously)
async function main(): Promise<void> {
  try {
    const built = node([join(repo, "launcher", "converter", "build.mjs"), "--out", out]);
    check("the converter builds", built.status === 0, (built.stderr || built.stdout).trim().split("\n").pop());
    if (built.status !== 0) throw new Error("no converter to check");

    const manifest = JSON.parse(readFileSync(join(out, "converter.json"), "utf8")) as {
      modTool: string;
      importers: string[];
      python: { version: string; requirements: string[] };
      work: string[];
    };
    const importers = readdirSync(join(repo, "scripts", "mods", "importers"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .map((f) => f.slice(0, -3))
      .sort();
    check("converter.json names every importer", JSON.stringify(manifest.importers) === JSON.stringify(importers), manifest.importers.join(", "));
    check("the mod tool is bundled where converter.json says", existsSync(join(out, manifest.modTool)), manifest.modTool);
    check(
      "each importer is bundled beside it",
      importers.every((n) => existsSync(join(out, "scripts", "mods", "importers", `${n}.mjs`))),
    );
    check("Python's requirements files are in it", manifest.python.requirements.every((r) => existsSync(join(out, r))), manifest.python.requirements.join(", "));
    check("the working folder starts with an empty circuit list", manifest.work.every((w) => readFileSync(join(out, w, "index.json"), "utf8").trim() === "[]"));

    const all = files(out);
    check("no TypeScript source (runTsx and build_track.py then run the bundles)", !all.some((f) => /\.(ts|tsx)$/.test(f)), all.filter((f) => /\.tsx?$/.test(f)).join(", "));
    check("nothing from a hidden folder (an importer's download cache)", !all.some((f) => f.split("/").some((part) => part.startsWith("."))), all.filter((f) => f.includes("/.")).slice(0, 3).join(", "));
    check("no native module and no node_modules", !all.some((f) => f.endsWith(".node") || f.includes("node_modules/")));
    check("no Python cache", !all.some((f) => f.includes("__pycache__")));
    const size = all.reduce((n, f) => n + statSync(join(out, f)).size, 0);
    check("it stays small (under 16 MB)", size < 16 * 1024 * 1024, `${(size / 1024 / 1024).toFixed(1)} MB`);

    const listed = node([join(out, manifest.modTool), "import"]);
    check("the bundled mod tool loads every importer", listed.status === 0 && importers.every((n) => listed.stdout.includes(n)), listed.stderr.trim());

    // The optimiser reads the circuit from the converter's own public/tracks, not the repository's
    const optimiser = node([join(out, "scripts", "tracks", "optimize-racing-line.mjs"), "--track", "no_such_circuit", "--dry-run"]);
    const wanted = join(out, "public", "tracks", "no_such_circuit", "track_data.json");
    check("a bundled tool finds the converter's folders, not the repository's", optimiser.stderr.includes(wanted), optimiser.stderr.split("\n").find((l) => l.includes("ENOENT")) ?? "");
    const compressor = node([join(out, "scripts", "tracks", "compress-track-glb.mjs")]);
    check("the GLB compressor runs from its bundle", /usage/i.test(compressor.stdout + compressor.stderr), (compressor.stdout + compressor.stderr).trim().slice(0, 80));

    const pythonFiles = all.filter((f) => f.endsWith(".py"));
    const evals = pythonFiles.filter((f) => /["']node["'][^\n\]]*["'](-e|--eval|-p|--print)["']/.test(readFileSync(join(out, f), "utf8")));
    check("no Python converter hands Node code to run (node -e): a script of its own is bundled", evals.length === 0, evals.join(", "));
  } catch (err) {
    check("the converter could be checked", false, err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} converter bundle check(s) failed` : "\nAll converter bundle checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
