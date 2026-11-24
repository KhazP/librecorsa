/**
 * A Speed Dreams circuit as a mod package (docs/importing-mods.md, "From Speed Dreams"). scripts/tracks/extract_sd_track.py
 * turns the circuit's trackdef XML and AC3D model into a GLB of named surfaces and its settings, the shared circuit
 * builder builds that with --no-register, and the packager puts it in a package with the circuit's licence statement and
 * the licence's text.
 *
 * `--fetch <circuit>` first downloads one of Speed Dreams' own circuits into scripts/mods/.cache/speed-dreams/: the
 * archive the game's own downloader fetches, as Speed Dreams' asset database listed it (sd-track.circuits.json pins each
 * archive by its sha256), or, for the circuit the base data carries (Jarama), the speed-dreams-data repository at the
 * pinned commit. Most circuits draw on Speed Dreams' default surfaces and their textures, which are in that base data:
 * when the circuit's folder doesn't sit in a Speed Dreams install that has them, the surfaces are fetched once and the
 * textures as each circuit needs them.
 *
 * The licence (lib/licences.ts): the circuit's own readme or licence file must name one that lets players share a
 * converted copy. A circuit fetched from Speed Dreams without such a file takes the asset database's word for it, when
 * the database also names its author. Anything else is refused, unless --personal converts it marked for personal use.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { packageCircuit } from "../lib/circuit-package";
import { importTarget, PACKAGE_USAGE, parseImportArgs, workingTrackId, type Importer } from "../lib/importer";
import { copyrightHolders, decodeText, licenceText, recogniseLicence, statementFiles, type LicenceFinding } from "../lib/licences";
import { localIdFrom, packageCredit, packageIdFrom, type SourceCredit } from "../lib/manifest-file";
import { report } from "../lib/package-check";
import { circuitCatalogue, fetchSdCircuit, fetchSdTextures, readSdSource, sdBaseData, type CircuitSource } from "../lib/sd-fetch";
import { runPython } from "../lib/toolchain";

export type { CircuitSource } from "../lib/sd-fetch";

/** The circuit's trackdef: <folder>.xml, else the folder's one XML with track segments */
export function trackdefOf(folder: string): string {
  const own = join(folder, `${basename(folder)}.xml`);
  if (existsSync(own)) return own;
  const xml = readdirSync(folder).filter((f) => /\.xml$/i.test(f) && !/\.prj\.xml$/i.test(f) && /Track Segments/.test(readFileSync(join(folder, f), "latin1")));
  if (xml.length !== 1) throw new Error(`${folder}: ${xml.length ? `several trackdef XMLs (${xml.join(", ")})` : "no Speed Dreams trackdef (<name>.xml with Track Segments)"}`);
  return join(folder, xml[0]);
}

/**
 * Whether the trackdef includes files (Speed Dreams' default surfaces) and every one is where it says, as in an
 * install. A trackdef that includes none still draws on the shared textures by its surfaces' names, so the base data is
 * fetched for it too
 */
export function includesResolve(xml: string): boolean {
  const text = readFileSync(xml, "latin1");
  const files = [...text.matchAll(/<!ENTITY\s+[\w.-]+\s+SYSTEM\s+"([^"]+)"/g)].map((m) => m[1]);
  return files.length > 0 && files.every((f) => existsSync(resolve(dirname(xml), f)));
}

/** The trackdef's Header: the circuit's name, author and description */
export function trackHeader(xml: string): { name?: string; author?: string; description?: string } {
  const text = decodeText(readFileSync(xml));
  const header = /<section\s+name="Header"\s*>([\s\S]*?)<\/section>/.exec(text)?.[1] ?? "";
  const attr = (n: string) => new RegExp(`<attstr\\s+name="${n}"[^>]*\\bval="([^"]*)"`).exec(header)?.[1]?.trim() || undefined;
  return { name: attr("name"), author: attr("author"), description: attr("description") };
}

/** A credit's author: the names given, cut to what a package's credit holds (80 characters) at a name's end */
export function authorLine(names: string[]): string {
  const all = names.join(", ");
  if (all.length <= 80) return all;
  let out = "";
  for (const n of names) {
    if (`${out}${out ? ", " : ""}${n} and others`.length > 80) break;
    out = `${out}${out ? ", " : ""}${n}`;
  }
  return `${out || names[0].slice(0, 66)} and others`;
}

export interface CircuitLicence {
  credit: SourceCredit;
  /** Files to put beside the circuit in the package: its own statement, and the licence's full text */
  files: { from: string; name: string }[];
  /** Converted for personal use only */
  personal: boolean;
  /** One line on how the licence was settled, for the log */
  summary: string;
}

/**
 * The circuit's licence and credit, or an error that says why it can't be shared: from its own readme or licence
 * file, else (for a circuit fetched from Speed Dreams) from the asset database when it names the author too
 */
export function circuitLicence(folder: string, opts: { title: string; source: CircuitSource | null; headerAuthor?: string; personal: boolean }): CircuitLicence {
  const statements = statementFiles(folder);
  let finding: LicenceFinding | null = null;
  let statement: { file: string; text: string } | null = null;
  for (const s of statements) {
    const f = recogniseLicence(s.text);
    if (f.kind !== "unrecognised" || !finding) {
      finding = f;
      statement = s;
    }
    if (f.kind !== "unrecognised") break;
  }
  const source = opts.source;
  const dbAuthorKnown = !!source?.author && !source.author.startsWith("(");
  let via = statement ? statement.file : "";
  if ((!finding || finding.kind === "unrecognised") && source?.license && dbAuthorKnown) {
    const db = recogniseLicence(source.license);
    if (db.kind === "shareable") {
      finding = db;
      via = "Speed Dreams' asset database";
    }
  }
  const page = source?.page;
  const holders = statement ? copyrightHolders(statement.text) : [];
  const author = authorLine(holders.length ? holders : dbAuthorKnown ? source!.author!.split(/\s*,\s*/) : [opts.headerAuthor || "Unknown"]);
  const from = source?.from === "asset-database"
    ? `From Speed Dreams' asset database (revision ${source.revision}, sha256 ${source.sha256!.slice(0, 12)}…).`
    : source?.from === "speed-dreams-data"
      ? `From Speed Dreams' base data (speed-dreams-data ${source.commit!.slice(0, 12)}).`
      : "From Speed Dreams.";
  const statementFile = statement ? [{ from: join(folder, statement.file), name: `speed-dreams-${statement.file.replace(/[^A-Za-z0-9._-]+/g, "_")}${/\.(txt|md)$/i.test(statement.file) ? "" : ".txt"}` }] : [];

  if (finding?.kind === "shareable") {
    const text = licenceText(finding.licence);
    return {
      credit: {
        title: opts.title,
        author,
        url: page,
        license: finding.licence.name,
        licenseUrl: finding.licence.url,
        note: `${from} Converted to LibreCorsa; the circuit's licence statement and the licence's text are in its folder.`,
      },
      files: [...statementFile, ...(text ? [{ from: text, name: `LICENCE-${finding.licence.id}.txt` }] : [])],
      personal: false,
      summary: `${finding.licence.name}, as ${via} states`,
    };
  }

  const why = !finding
    ? `${opts.title} states no licence: it has no readme or licence file that names one${source && !dbAuthorKnown && source.license ? `, and Speed Dreams' asset database names no author for it ("${source.author}")` : ""}`
    : finding.kind === "restricted"
      ? `${opts.title}'s licence doesn't let a converted copy be shared: ${finding.reason} (${via})`
      : `${opts.title}'s ${via} names no licence this importer recognises as letting a converted copy be shared`;
  if (!opts.personal) {
    throw new Error(`${why}.\nIt is not converted. With --personal it is, for you alone: the package is marked "for personal use only, not for sharing".`);
  }
  return {
    credit: {
      title: opts.title,
      author,
      url: page,
      license: finding?.kind === "restricted" && finding.licence ? finding.licence.name : "No licence to share",
      ...(finding?.kind === "restricted" && finding.licence ? { licenseUrl: finding.licence.url } : {}),
      note: `for personal use only, not for sharing. ${why}. ${from}`.slice(0, 500),
    },
    files: statementFile,
    personal: true,
    summary: `for personal use only (${why})`,
  };
}

/** A circuit's name as players see it: the header's, in title case when it is the folder's lower-case name */
const displayName = (name: string): string => (name === name.toLowerCase() ? name.replace(/(^|[\s_-])(\p{L})/gu, (_, a: string, b: string) => `${a}${b.toUpperCase()}`) : name);

const importer: Importer = {
  summary: "a Speed Dreams circuit (its folder, or --fetch <circuit> from Speed Dreams' own)",
  usage: `<circuit folder> | --fetch <circuit> [--id <circuit id>] [--sd-data <folder>] [--personal]
  <circuit folder>         a circuit's folder: its trackdef XML (<name>.xml) and AC3D model, e.g. data/tracks/circuit/brno in an install
  --fetch <circuit>        download one of Speed Dreams' circuits by its folder name (brno, e-track-4, ...) into scripts/mods/.cache/speed-dreams/ first
  --sd-data <folder>       Speed Dreams' base data (data/tracks/surfaces.xml, data/textures/); default: the install the circuit sits in, else fetched once
  --id <id>                the circuit's id in the package (default: made from its folder name)
  --country <name>         where it is (default: its weather station's country, or one its description names, else Speed Dreams)
  --city <name>            (default: Speed Dreams; a trackdef names none)
  --personal              convert a circuit whose licence doesn't allow sharing, marked "for personal use only, not for sharing"
${PACKAGE_USAGE}
  The package id defaults to sd.<circuit>.`,
  async run(argv) {
    const { values, positionals } = parseImportArgs(argv, {
      fetch: { type: "string" },
      "sd-data": { type: "string" },
      id: { type: "string" },
      country: { type: "string" },
      city: { type: "string" },
      personal: { type: "boolean" },
    });
    if (values.fetch && positionals.length) throw new Error("give a circuit folder or --fetch <circuit>, not both");
    const folder = values.fetch ? await fetchSdCircuit(values.fetch) : positionals[0] && resolve(positionals[0]);
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error("name a Speed Dreams circuit's folder, or --fetch <circuit>");
    const xml = trackdefOf(folder);
    const source = readSdSource<CircuitSource>(folder);
    const header = trackHeader(xml);
    const directory = basename(folder);
    const listed = circuitCatalogue().find((e) => e.directory === directory && source?.sha256 === e.sha256);
    const title = displayName(listed?.name ?? header.name ?? directory);

    // The licence decides first: nothing is converted that can't be packaged
    const licence = circuitLicence(folder, { title, source, headerAuthor: header.author, personal: !!values.personal });
    console.log(`      licence: ${licence.summary}`);
    const credit = packageCredit(licence.credit);
    const localId = localIdFrom(values.id ?? directory);
    const { info, packageDir } = importTarget(
      { ...values, package: values.package ?? packageIdFrom("sd", directory) },
      { author: credit.author, name: title, credit, description: header.description },
    );

    const fetchBase = !values["sd-data"] && !includesResolve(xml);
    const sdData = values["sd-data"] ? resolve(values["sd-data"]) : fetchBase ? sdBaseData() : null;
    const work = mkdtempSync(join(tmpdir(), "sd-track-"));
    try {
      const glb = join(work, `${localId}.glb`);
      const settingsPath = join(work, `${localId}.json`);
      const extract = [folder, "--out-glb", glb, "--out-settings", settingsPath, ...(sdData ? ["--sd-data", sdData] : [])];
      if (fetchBase) {
        // the shared textures the circuit draws on and doesn't carry
        const needs = join(work, "needs.json");
        runPython("scripts/tracks/extract_sd_track.py", [...extract, "--needs-json", needs]);
        fetchSdTextures((JSON.parse(readFileSync(needs, "utf8")) as { textures: string[] }).textures);
      }
      runPython("scripts/tracks/extract_sd_track.py", extract);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      settings.name = title;
      settings.credit = licence.credit;
      if (values.country) settings.country = values.country;
      if (values.city) settings.city = values.city;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

      const builtId = workingTrackId(info.id, localId);
      runPython("scripts/tracks/build_blender_track.py", [builtId, "--glb", glb, "--settings", settingsPath, "--no-register"]);
      const out = packageCircuit({
        builtId,
        packageDir,
        info,
        localId,
        extraFiles: licence.files.map((f) => ({ from: f.from, to: `${localId}/${f.name}` })),
        removeBuild: !values["keep-build"],
      });
      report(packageDir, out.checked);
      if (out.skipped.length) console.log(`      left out (the track data doesn't name them): ${out.skipped.join(", ")}`);
      console.log(`      ${out.contentId} in ${packageDir}${licence.personal ? " (for personal use only, not for sharing)" : ""}`);
      if (!out.checked.ok) throw new Error("the package doesn't pass the game's checks");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};

export default importer;
