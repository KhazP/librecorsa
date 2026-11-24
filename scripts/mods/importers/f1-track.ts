/**
 * A circuit from an F1 25 track mod (its .erp archive) as a mod package, through the pipeline Qiddiya Speed Park was
 * ported with (docs/PORTING-F1-MODS.md): extract_erp_track.py reads the mod's own meshes, textures and AI spline into a
 * GLB and a settings file, build_blender_track.py builds the circuit from them with --no-register, and the packager
 * puts it in a package.
 *
 * Always for personal use only: an .erp carries the base game's files beside the mod's, and a mod's authors' permission
 * for one copy doesn't cover another (docs/PORTING-F1-MODS.md, "Personal use only"). The package's credit says so,
 * whatever licence the settings give. The extractor's tables (surfaces, lights, branding) are Qiddiya's: another mod
 * needs them edited, as that page explains.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { packageCircuit } from "../lib/circuit-package";
import { localIdFrom, packageCredit, type SourceCredit } from "../lib/manifest-file";
import { importTarget, PACKAGE_USAGE, parseImportArgs, workingTrackId, type Importer } from "../lib/importer";
import { report } from "../lib/package-check";
import { runPython } from "../lib/toolchain";

export const PERSONAL_USE_NOTE = "For personal use only: the author's permission is needed to share it.";

/** The extractor's options the importer passes on: `--<name> <value>` */
const EXTRACTOR_VALUES = ["track", "mat-prefix", "max-road-tex", "max-scenery-tex", "foliage-dist", "scenery-max-dist", "tiny-scenery-min-tris"] as const;

interface Settings {
  name?: string;
  layout?: string;
  description?: string;
  credit?: SourceCredit;
  [key: string]: unknown;
}

/**
 * The settings the circuit is built with: the extractor's, the modder's merged over them (`credit` key by key), and
 * the credit marked for personal use. The licence is the modder's, or "unknown": the one the extractor writes for
 * Qiddiya is the game's permission, not the player's
 */
export function f1Settings(extracted: Settings, own: Settings): Settings {
  const credit: SourceCredit = {
    ...(extracted.credit ?? {}),
    license: "unknown",
    licenseUrl: null,
    ...(own.credit ?? {}),
  };
  credit.note = [PERSONAL_USE_NOTE, own.credit?.note].filter(Boolean).join(" ");
  return { ...extracted, ...own, credit };
}

const importer: Importer = {
  summary: "an F1 25 track mod (its .erp archive), for personal use only",
  usage: `<mod.erp> [--track <code>] [--mat-prefix <prefix>] [--settings <overrides.json>] [--id <circuit id>]
  --track <code>           the track's code inside the archive, its folder tracks/<code>/ (default qiddiya)
  --mat-prefix <prefix>    the start of the mod's own material names (default qdy_mat_)
  --max-road-tex <px>      largest texture for the road, kerbs and key surfaces (default 1024)
  --max-scenery-tex <px>   largest texture for scenery (default 512)
  --foliage-dist <m>       palms further than this from the track are left out (default 18)
  --scenery-max-dist <m>   small scenery further than this is left out (default 200)
  --tiny-scenery-min-tris <n>  small flat-coloured scenery under this many triangles is merged (default 120)
  --keep-fence02           keep the very heavy Qiddiya fence the extractor leaves out
  --no-simplify            keep every mesh as the mod has it (default: simplified, the road and lines exact)
  --settings <file>        values over the extractor's (name, layout, country, city, credit, and any setting
                           build_blender_track.py reads). The extractor writes Qiddiya's: set them for another mod
  --id <id>                the circuit's id in the package (default: the track code)
  --no-line-opt            skip the racing-line optimiser (a few minutes)
${PACKAGE_USAGE}`,
  async run(argv) {
    const { values, positionals } = parseImportArgs(argv, {
      track: { type: "string" },
      "mat-prefix": { type: "string" },
      "max-road-tex": { type: "string" },
      "max-scenery-tex": { type: "string" },
      "foliage-dist": { type: "string" },
      "scenery-max-dist": { type: "string" },
      "tiny-scenery-min-tris": { type: "string" },
      "keep-fence02": { type: "boolean" },
      "no-simplify": { type: "boolean" },
      settings: { type: "string" },
      id: { type: "string" },
      "no-line-opt": { type: "boolean" },
    });
    const erp = positionals[0] && resolve(positionals[0]);
    if (!erp || !existsSync(erp) || !/\.erp$/i.test(erp)) throw new Error("name the mod's .erp archive");
    const own = (values.settings ? JSON.parse(readFileSync(resolve(values.settings), "utf8")) : {}) as Settings;
    const track = values.track ?? "qiddiya";
    if (track !== "qiddiya" && !own.name) {
      console.warn("      the extractor writes Qiddiya's name, place and credit: set yours with --settings (docs/PORTING-F1-MODS.md)");
    }

    const tmp = mkdtempSync(join(tmpdir(), "f1-track-"));
    try {
      // 1. The mod's own meshes, textures and AI spline as a GLB and its settings
      const rawGlb = join(tmp, `${track}_raw.glb`);
      const rawSettings = join(tmp, `${track}_raw.json`);
      const passed = EXTRACTOR_VALUES.flatMap((k) => (values[k] !== undefined ? [`--${k}`, values[k]] : []));
      if (values["keep-fence02"]) passed.push("--no-skip-fence02");
      if (values["no-simplify"]) passed.push("--no-simplify");
      runPython("scripts/tracks/extract_erp_track.py", ["--erp", erp, "--out-glb", rawGlb, "--out-settings", rawSettings, ...passed], {
        withPackages: ["texture2ddecoder"],
      });

      // 2. Its settings with the modder's over them, the credit marked for personal use
      const settings = f1Settings(JSON.parse(readFileSync(rawSettings, "utf8")) as Settings, own);
      const settingsPath = join(tmp, `${track}.json`);
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      const credit = packageCredit(settings.credit ?? {});
      const localId = localIdFrom(values.id ?? track);
      const name = settings.name ?? basename(erp, ".erp");
      const { info, packageDir } = importTarget(values, { author: credit.author, name, credit, description: settings.description });

      // 3. Built under a working id, off the game's lists, and packaged
      const builtId = workingTrackId(info.id, localId);
      runPython("scripts/tracks/build_blender_track.py", [
        builtId,
        "--glb",
        rawGlb,
        "--settings",
        settingsPath,
        "--no-register",
        ...(values["no-line-opt"] ? ["--no-line-opt"] : []),
      ]);
      const out = packageCircuit({ builtId, packageDir, info, localId, credit, removeBuild: !values["keep-build"] });
      report(packageDir, out.checked);
      if (out.skipped.length) console.log(`      left out (the track data doesn't name them): ${out.skipped.join(", ")}`);
      console.log(`      ${out.contentId} in ${packageDir}`);
      console.log(
        `\nFOR PERSONAL USE ONLY. A circuit from an F1 25 mod stays on your own machine: don't upload, host or share it.\n` +
          "The mod's authors' permission covers their own copy, and the archive carries the base game's files too\n" +
          "(docs/PORTING-F1-MODS.md, \"Personal use only\"). The package's credit says so.",
      );
      if (!out.checked.ok) throw new Error(`${packageDir}: the package fails the game's checks (above)`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
};

export default importer;
