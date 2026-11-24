/**
 * An Assetto Corsa circuit mod as a mod package, with no setup: the converter reads the circuit's settings from the
 * mod itself (scripts/tracks/ac_mod_entry.py: its layouts, models, ui_track.json, surfaces.ini and readme) where a
 * circuit the game hosts has a hand-written entry, builds it into public/tracks/<working id> with --no-register, and
 * the packager puts it in a package.
 *
 * Most Assetto Corsa mods don't allow sharing. The package is always made, but unless the mod names a licence that
 * lets a converted copy be shared (or the modder's settings name one, their record of the author's permission), its
 * credit says it is for personal use only, and the import says so.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageCircuit, readCircuitEntry } from "../lib/circuit-package";
import { localIdFrom, packageCredit, type SourceCredit } from "../lib/manifest-file";
import { importTarget, PACKAGE_USAGE, parseImportArgs, workingTrackId, type Importer } from "../lib/importer";
import { report } from "../lib/package-check";
import { BUILT_TRACKS_DIR, runPython } from "../lib/toolchain";

const PORTER = "scripts/tracks/port_ac_track.py";

/** The entry port_ac_track.py reads from a mod (`--entry-only`): what the importer needs of it */
export interface AutoEntry {
  folder: string;
  layout_dir: string;
  name: string;
  layout: string;
  description?: string;
  credit: SourceCredit;
  _auto: {
    layouts: string[];
    uiLengthM: number | null;
    version: string | null;
    personalUse: boolean;
    licenceFrom: "settings" | "mod" | null;
    terms: string[];
    /** The game's own circuit built from this layout of the mod, if it has one */
    gameCircuit?: { id: string; author: string };
  };
}

/** The porter's options for the mod: its folder, the layout, the modder's overrides */
const sourceArgs = (folder: string, values: { layout?: string; settings?: string }): string[] => [
  "--src",
  folder,
  ...(values.layout !== undefined ? ["--layout", values.layout] : []),
  ...(values.settings ? ["--settings", resolve(values.settings)] : []),
];

/** The entry the porter reads from the mod, with the modder's overrides merged over it */
export function readAutoEntry(folder: string, values: { layout?: string; settings?: string }): AutoEntry {
  const tmp = mkdtempSync(join(tmpdir(), "ac-track-"));
  try {
    const out = join(tmp, "entry.json");
    runPython(PORTER, ["modimport_entry", ...sourceArgs(folder, values), "--entry-only", out]);
    return JSON.parse(readFileSync(out, "utf8")) as AutoEntry;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A mod's version as a package's ("v1.8.5" → "1.8.5"), or nothing */
export const packageVersion = (v: string | null | undefined): string | undefined => {
  const m = /\d+(?:\.\d+){0,3}(?:[-+][\w.]+)?/.exec(v ?? "");
  return m ? m[0].slice(0, 32) : undefined;
};

/** The circuit's id in the package: its layout's folder, or the track folder's for a mod with one layout */
export const circuitIdFrom = (entry: Pick<AutoEntry, "folder" | "layout_dir">): string => localIdFrom(entry.layout_dir || entry.folder);

/** What the import tells the modder about sharing what it made */
export function licenceNotice(entry: AutoEntry): string[] {
  const c = entry.credit;
  const lines: string[] = [];
  if (entry._auto.gameCircuit) {
    lines.push(
      `LibreCorsa hosts this circuit as "${entry._auto.gameCircuit.id}", with ${entry._auto.gameCircuit.author}'s permission for the game. ` +
        "That permission is the game's: it doesn't cover your copy.",
    );
  }
  if (entry._auto.personalUse) {
    lines.push(
      `FOR PERSONAL USE ONLY. ${entry.name} by ${c.author ?? "an unknown author"} names no licence that lets it be shared ` +
        `(licence: ${c.license ?? "unknown"}), and the package's credit says so.`,
      "Keep it on your own machine: don't upload, host or share it without the author's permission. With it, add the",
      'licence to your settings and import again: --settings <file> with {"credit": {"license": "Used with permission"}}.',
    );
  } else if (entry._auto.licenceFrom === "settings") {
    lines.push(`Licence from your settings: ${c.license}. Keep a record of the author's permission with the package.`);
  } else {
    lines.push(`Licence named by the mod: ${c.license}. Keep its terms with the package (credit it as they ask).`);
  }
  for (const t of entry._auto.terms) lines.push(`  The mod's readme: "${t}"`);
  return lines;
}

const importer: Importer = {
  summary: "an Assetto Corsa circuit mod (its track folder), set up from the mod itself",
  usage: `<track folder> [--layout <name>] [--settings <overrides.json>] [--id <circuit id>]
  <track folder>           the mod's folder in content/tracks: the one holding the .kn5 models, ui/ and data/ or the layout folders
  --layout <name>          the layout to convert (its folder, or its name in the game): needed when the mod has several,
                           which the import lists
  --settings <file>        values to use over the ones read from the mod (the keys AC_TRACKS entries take in
                           scripts/tracks/port_ac_track.py: name, layout, country, city, baseAltitudeM, credit…)
  --id <id>                the circuit's id in the package (default: made from the layout's folder)
  --no-line-opt            skip the racing-line optimiser (a few minutes): the circuit keeps the minimum-curvature line
${PACKAGE_USAGE}`,
  async run(argv) {
    const { values, positionals } = parseImportArgs(argv, {
      layout: { type: "string" },
      settings: { type: "string" },
      id: { type: "string" },
      "no-line-opt": { type: "boolean" },
    });
    const folder = positionals[0] && resolve(positionals[0]);
    if (!folder || !existsSync(folder)) throw new Error("name the mod's track folder (Assetto Corsa's content/tracks/<circuit>)");
    if (values.settings && !existsSync(resolve(values.settings))) throw new Error(`${values.settings}: no such settings file`);

    // 1. The circuit's settings, read from the mod: what the package is called and credited
    const entry = readAutoEntry(folder, values);
    const credit = packageCredit(entry.credit);
    const localId = localIdFrom(values.id ?? circuitIdFrom(entry));
    const { info, packageDir } = importTarget(
      { ...values, version: values.version ?? packageVersion(entry._auto.version) },
      { author: credit.author, name: entry.name, credit, description: entry.description },
    );

    // 2. Built under a working id, off the game's lists
    const builtId = workingTrackId(info.id, localId);
    runPython(PORTER, [builtId, ...sourceArgs(folder, values), "--no-register", ...(values["no-line-opt"] ? ["--no-line-opt"] : [])]);
    const built = readCircuitEntry(join(BUILT_TRACKS_DIR, builtId), builtId);

    // 3. Packaged
    const out = packageCircuit({ builtId, packageDir, info, localId, credit, removeBuild: !values["keep-build"] });
    report(packageDir, out.checked);
    if (out.skipped.length) console.log(`      left out (the track data doesn't name them): ${out.skipped.join(", ")}`);
    const said = entry._auto.uiLengthM;
    console.log(
      `      ${out.contentId} in ${packageDir}\n      ${entry.name}, ${entry.layout}: ${(built.lengthM / 1000).toFixed(3)} km` +
        `${said ? ` (the mod says ${(said / 1000).toFixed(3)} km)` : ""}, ${built.turns} turns, ${built.direction}`,
    );
    console.log(`\n${licenceNotice(entry).join("\n")}`);
    if (!out.checked.ok) throw new Error(`${packageDir}: the package fails the game's checks (above)`);
  },
};

export default importer;
