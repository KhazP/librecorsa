/**
 * A circuit modelled in Blender (docs/PORTING-TRACKS.md, "Your own circuit") as a mod package: the shared circuit
 * builder makes the game's circuit from the GLB and its settings, and the packager puts it in a package. The smallest
 * importer, and the pattern the others follow: convert into public/tracks/<working id> with --no-register, package,
 * remove the working copy.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { packageCircuit } from "../lib/circuit-package";
import { localIdFrom, packageCredit, type SourceCredit } from "../lib/manifest-file";
import { importTarget, PACKAGE_USAGE, parseImportArgs, workingTrackId, type Importer } from "../lib/importer";
import { report } from "../lib/package-check";
import { runPython } from "../lib/toolchain";

const importer: Importer = {
  summary: "a circuit you modelled in Blender (its glTF export and settings JSON)",
  usage: `<circuit.glb> [--settings <circuit.json>] [--id <circuit id>]
  --settings <file>        the circuit's settings (default: the GLB's name with .json), as build_blender_track.py reads them
  --id <id>                the circuit's id in the package (default: made from the GLB's name)
${PACKAGE_USAGE}`,
  async run(argv) {
    const { values, positionals } = parseImportArgs(argv, { settings: { type: "string" }, id: { type: "string" } });
    const glb = positionals[0] && resolve(positionals[0]);
    if (!glb || !existsSync(glb)) throw new Error("name the circuit's .glb (Blender: File > Export > glTF 2.0, .glb)");
    const settingsPath = resolve(values.settings ?? glb.replace(/\.glb$/i, ".json"));
    if (!existsSync(settingsPath)) throw new Error(`${settingsPath}: no settings file (name, layout, country, city, credit…)`);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { name?: string; credit?: SourceCredit; description?: string };
    const credit = packageCredit(settings.credit ?? {});
    const localId = localIdFrom(values.id ?? basename(glb, ".glb"));
    const { info, packageDir } = importTarget(values, {
      author: credit.author,
      name: settings.name ?? localId,
      credit,
      description: settings.description,
    });

    const builtId = workingTrackId(info.id, localId);
    runPython("scripts/tracks/build_blender_track.py", [builtId, "--glb", glb, "--settings", settingsPath, "--no-register"]);
    const out = packageCircuit({ builtId, packageDir, info, localId, removeBuild: !values["keep-build"] });
    report(packageDir, out.checked);
    if (out.skipped.length) console.log(`      left out (the track data doesn't name them): ${out.skipped.join(", ")}`);
    console.log(`      ${out.contentId} in ${packageDir}`);
  },
};

export default importer;
