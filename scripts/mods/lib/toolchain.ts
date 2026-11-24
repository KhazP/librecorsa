/**
 * Running the repository's converters from the mod tools: the Python circuit and car scripts through uv (each command
 * pulls its pinned packages, docs/PORTING-TRACKS.md), and the TypeScript ones through tsx. Output streams to the
 * terminal; a failure throws with the command that failed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The repository's root folder (tsx runs the scripts as CommonJS, as the other scripts use `__dirname`) */
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** Where the game's own built circuits are, and where a converter builds one before it is packaged */
export const BUILT_TRACKS_DIR = join(REPO_ROOT, "public", "tracks");

/** Where packages go by default: the dev server and the launcher serve this folder (`npm run mod -- index`) */
export const DEFAULT_MODS_DIR = join(REPO_ROOT, "public", "mods");

function run(cmd: string, args: string[], what: string): void {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
  if (r.error) throw new Error(`${what}: ${cmd} could not start (${r.error.message})`);
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status ?? r.signal}): ${cmd} ${args.join(" ")}`);
}

/**
 * Runs a Python script of the repository with uv, on Python 3.14 and the circuit converters' pinned packages
 * (scripts/tracks/requirements.txt), plus `withPackages`
 */
export function runPython(script: string, args: string[], opts: { withPackages?: string[]; requirements?: string | null } = {}): void {
  const requirements = opts.requirements === undefined ? "scripts/tracks/requirements.txt" : opts.requirements;
  const uvArgs = ["run", "--python", "3.14", "--no-project"];
  if (requirements) uvArgs.push("--with-requirements", requirements);
  for (const p of opts.withPackages ?? []) uvArgs.push("--with", p);
  uvArgs.push("python", "-P", script, ...args);
  run("uv", uvArgs, script);
}

/**
 * Runs a TypeScript script of the repository with tsx; in the offline launcher's converter, where only its bundle is
 * (the .mjs beside where its source would be, launcher/converter/build.mjs), that with Node
 */
export function runTsx(script: string, args: string[]): void {
  const bundled = script.replace(/\.ts$/, ".mjs");
  if (!existsSync(join(REPO_ROOT, script)) && bundled !== script && existsSync(join(REPO_ROOT, bundled))) {
    run(process.execPath, [bundled, ...args], script);
    return;
  }
  run(process.execPath, ["--disable-warning=THREE_CJS_DEPRECATED", "--import", "tsx", script, ...args], script);
}
