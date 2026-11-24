/**
 * What an importer is (scripts/mods/importers/<name>.ts, run as `npm run mod -- import <name> …`): a converter from
 * another game's content, or a modelling tool's, to a mod package. Each file default-exports one; the tool finds them
 * by their file names, so adding one is adding a file. See scripts/mods/README.md.
 */
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { ModCredit } from "../../../src/lib/mods/mod-manifest";
import { packageIdFrom, type PackageInfo } from "./manifest-file";
import { DEFAULT_MODS_DIR } from "./toolchain";

export interface Importer {
  /** One line: what it converts, for `npm run mod -- import` */
  summary: string;
  /** Its arguments after `npm run mod -- import <name>`, and a line on each option of its own */
  usage: string;
  /** Converts and packages, and returns the package's folder; throws with a message a modder can act on */
  run(argv: string[]): Promise<string>;
}

/** The options every package a tool writes takes: where it goes and what it is called */
export const PACKAGE_OPTIONS = {
  package: { type: "string" },
  name: { type: "string" },
  version: { type: "string" },
  out: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

/** The package options, as `--help` lists them (`from-circuit`'s) */
export const PACKAGE_ONLY_USAGE = `  --package <author.name>  the package's id (default: made from the source's author and name)
  --name <text>            the package's name, as players see it
  --version <text>         its version (default 1.0.0)
  --out <folder>           the mods folder to write it into (default public/mods, which the dev server and the launcher serve)`;

/** The options every importer takes, as its `--help` lists them: the package's, and keeping the converter's files */
export const PACKAGE_USAGE = `${PACKAGE_ONLY_USAGE}
  --keep-build             keep the converter's working files, for debugging (a circuit's build in public/tracks/, a
                           car's working folder)`;

/** The racing-line options every circuit importer takes */
export const LINE_OPTIONS = {
  "best-lines": { type: "boolean" },
  "no-line-opt": { type: "boolean" },
} as const satisfies ParseArgsConfig["options"];

/** Those options, as a circuit importer's `--help` lists them */
export const LINE_USAGE = `  --best-lines             the full racing-line optimiser, as the game's own circuits get: the AI a second or two a lap
                           quicker, the import about three times as long (half an hour or more for a long circuit)
  --no-line-opt            no racing-line optimiser: the AI drives the minimum-curvature line, clearly slower`;

/**
 * What a circuit builder (build_blender_track.py, port_ac_track.py) is given for the racing lines: by default a light
 * optimiser run (one sweep, no optimal-control start: build_track.py optimise_lines), the full one with --best-lines
 */
export const lineArgs = (values: { "best-lines"?: boolean; "no-line-opt"?: boolean }): string[] =>
  values["no-line-opt"] ? ["--no-line-opt"] : values["best-lines"] ? [] : ["--light-lines"];

/** Parses a tool's arguments: the package options plus its own */
export function parsePackageArgs<O extends NonNullable<ParseArgsConfig["options"]>>(argv: string[], own: O) {
  return parseArgs({ args: argv, options: { ...PACKAGE_OPTIONS, ...own }, allowPositionals: true, strict: true });
}

/** Parses an importer's arguments: the package options, --keep-build, and its own */
export function parseImportArgs<O extends NonNullable<ParseArgsConfig["options"]>>(argv: string[], own: O) {
  return parsePackageArgs(argv, { "keep-build": { type: "boolean" }, ...own });
}

/**
 * The package an import writes: its id, name, version and credit (the source's, unless the options say otherwise),
 * and its folder in the mods folder
 */
export function importTarget(
  values: { package?: string; name?: string; version?: string; out?: string },
  source: { author: string; name: string; credit: ModCredit; description?: string },
): { info: PackageInfo; packageDir: string } {
  const id = values.package ?? packageIdFrom(source.author, source.name);
  const info: PackageInfo = {
    id,
    name: values.name ?? source.name,
    version: values.version ?? "1.0.0",
    credit: source.credit,
    ...(source.description ? { description: source.description } : {}),
  };
  return { info, packageDir: resolve(values.out ?? DEFAULT_MODS_DIR, id) };
}

/** An id the converters can build under in public/tracks/ without meeting the game's own circuits */
export const workingTrackId = (packageId: string, localId: string): string => `modimport_${`${packageId}_${localId}`.replace(/[^a-z0-9]+/g, "_")}`;
