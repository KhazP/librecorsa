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
 * The licence (lib/licences.ts): every statement file in the circuit's folder (readme, licence, credits…) is read, and
 * its trackdef's header, and together they must name a licence that lets players share a converted copy, with nothing
 * that takes it back. A circuit with no statement file takes the asset database's word for it only when it was fetched
 * at the archive the database pins and the database names its author. Anything else is refused, unless --personal
 * converts it, marked for personal use only.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isArchiveJunk, readZip } from "../../../src/lib/mods/zip-reader";
import { packageCircuit } from "../lib/circuit-package";
import { importTarget, PACKAGE_USAGE, parseImportArgs, workingTrackId, type Importer } from "../lib/importer";
import {
  authorLine,
  carriedName,
  creditLicence,
  decodeText,
  isShareable,
  licenceTextFiles,
  mergeReadings,
  PERSONAL_USE_NOTE,
  readLicenceEntry,
  readLicenceText,
  statementFiles,
  xmlLeadingComments,
  type LicenceReading,
} from "../lib/licences";
import { localIdFrom, packageCredit, packageIdFrom, type SourceCredit } from "../lib/manifest-file";
import { report } from "../lib/package-check";
import { REPO_ROOT, runPython } from "../lib/toolchain";

/** Where fetched circuits and the base data are kept (gitignored) */
export const SD_CACHE = join(REPO_ROOT, "scripts", "mods", ".cache", "speed-dreams");
/** Speed Dreams' base data (default surfaces and textures, and the Jarama circuit): its repository and the pinned commit */
export const SD_DATA_REPO = "https://forge.a-lec.org/speed-dreams/speed-dreams-data.git";
export const SD_DATA_COMMIT = "ca89759acffc34ed457a587e94bd85ec17e25772";

/** A circuit as Speed Dreams' asset database lists it (sd-track.circuits.json) */
export interface CatalogueEntry {
  directory: string;
  name: string;
  category: string;
  author: string;
  license: string;
  revision: number;
  archive: string;
  sha256: string;
  bytes: number;
  page: string;
}

/** Where a fetched circuit came from, kept beside it (.source.json) */
export interface CircuitSource {
  from: "asset-database" | "speed-dreams-data";
  directory: string;
  /** The archive and its sha256, or the repository and its commit */
  archive?: string;
  sha256?: string;
  revision?: number;
  repository?: string;
  commit?: string;
  /** The circuit's page (its repository) */
  page: string;
  /** What the asset database says of it */
  license?: string;
  author?: string;
}

export const catalogue = (): CatalogueEntry[] =>
  (JSON.parse(readFileSync(join(__dirname, "sd-track.circuits.json"), "utf8")) as { circuits: CatalogueEntry[] }).circuits;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (r.error) throw new Error(`git could not start (${r.error.message}): fetching from Speed Dreams' repository needs git`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.status})`);
  return r.stdout;
}

/** The base data repository at the pinned commit, its trees only (no file is downloaded until checked out) */
function baseRepo(): string {
  const repo = join(SD_CACHE, "speed-dreams-data");
  const has = existsSync(join(repo, ".git")) && spawnSync("git", ["cat-file", "-e", `${SD_DATA_COMMIT}^{commit}`], { cwd: repo }).status === 0;
  if (has) return repo;
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["remote", "add", "origin", SD_DATA_REPO], repo);
  git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", SD_DATA_COMMIT], repo);
  return repo;
}

/**
 * Speed Dreams' base data (its data/ folder) in the cache, with its default surfaces (data/tracks/surfaces.xml);
 * its textures are fetched as circuits need them (`baseTextures`): the repository serves them slowly, and a circuit
 * uses a few dozen of its 400
 */
export function baseData(): string {
  const repo = baseRepo();
  if (!existsSync(join(repo, "data", "data", "tracks", "surfaces.xml"))) {
    console.log(`      fetching Speed Dreams' default surfaces from ${SD_DATA_REPO} at ${SD_DATA_COMMIT.slice(0, 12)}…`);
    git(["-c", "advice.detachedHead=false", "checkout", "-q", SD_DATA_COMMIT, "--", "data/data/tracks", "LICENSE", "README.md"], repo);
  }
  return join(repo, "data");
}

/** The base data's textures by these names (in whichever of Speed Dreams' formats it has them), fetched if missing */
export function baseTextures(names: string[]): void {
  const repo = baseRepo();
  const stem = (n: string) => n.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const formats = [".png", ".rgb", ".jpg", ".jpeg", ".sgi", ".bmp", ".tga"];
  const listing = git(["ls-tree", "--name-only", SD_DATA_COMMIT, "data/data/textures/"], repo).split("\n").filter(Boolean);
  // each name as it is named, else in the first of the formats Speed Dreams reads that the base data has it in
  const paths = [
    ...new Set(
      names.flatMap((n) => {
        const exact = listing.find((p) => basename(p).toLowerCase() === n.toLowerCase());
        const other = formats.map((f) => listing.find((p) => basename(p).toLowerCase() === stem(n) + f)).find(Boolean);
        return exact ?? other ?? [];
      }),
    ),
  ].filter((p) => !existsSync(join(repo, p)));
  if (!paths.length) return;
  console.log(`      fetching ${paths.length} of Speed Dreams' shared textures…`);
  git(["-c", "advice.detachedHead=false", "checkout", "-q", SD_DATA_COMMIT, "--", ...paths], repo);
}

/** A path in an archive as a safe relative path, or null (absolute, `..`, a drive) */
const safeRelative = (p: string): string | null =>
  p.startsWith("/") || p.includes("\\") || /^[a-z]:/i.test(p) || p.split("/").some((s) => s === ".." || s === "") ? null : p;

/** The folder under `root` that holds a trackdef named <directory>.xml, or the only folder with a trackdef */
function findCircuitFolder(root: string, directory: string): string | null {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.toLowerCase() === `${directory.toLowerCase()}.xml`) hits.unshift(dir);
      else if (f.toLowerCase().endsWith(".xml") && !f.toLowerCase().endsWith(".prj.xml") && /Track Segments/.test(readFileSync(p, "latin1"))) hits.push(dir);
    }
  };
  walk(root);
  return hits[0] ?? null;
}

/** A file's bytes, tried three times: Speed Dreams' servers drop out now and then for a minute or two */
async function download(url: string): Promise<Uint8Array> {
  let last = "";
  for (const wait of [0, 10, 30]) {
    if (wait) {
      console.log(`      ${last}; trying again in ${wait} s…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    try {
      const res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      last = `${res.status} ${res.statusText}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      last = cause?.code ?? (err as Error).message;
    }
  }
  throw new Error(`${url}: ${last}. Speed Dreams' server may be down for a while: try again later`);
}

/** One of Speed Dreams' circuits, by its folder name, in the cache: downloaded and checked when it isn't there yet */
export async function fetchCircuit(name: string): Promise<string> {
  const entry = catalogue().find((e) => e.directory.toLowerCase() === name.toLowerCase());
  const dir = join(SD_CACHE, "circuits", entry?.directory ?? name);
  const sourcePath = join(dir, ".source.json");
  const cached = existsSync(sourcePath) ? (JSON.parse(readFileSync(sourcePath, "utf8")) as CircuitSource) : null;

  if (!entry) {
    // The base data's own circuits
    if (cached?.commit === SD_DATA_COMMIT) return dir;
    const repo = baseRepo();
    const trees = git(["ls-tree", "-r", "-d", "--name-only", SD_DATA_COMMIT, "data/tracks"], repo).split("\n");
    const path = trees.find((t) => t.split("/").length === 4 && t.split("/")[3].toLowerCase() === name.toLowerCase());
    if (!path) {
      const names = catalogue().map((e) => e.directory);
      throw new Error(`no Speed Dreams circuit "${name}": the circuits are ${names.join(", ")}, and jarama`);
    }
    console.log(`      fetching ${path} from ${SD_DATA_REPO} at ${SD_DATA_COMMIT.slice(0, 12)}…`);
    git(["-c", "advice.detachedHead=false", "checkout", "-q", SD_DATA_COMMIT, "--", path], repo);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(join(repo, path), dir);
    const source: CircuitSource = {
      from: "speed-dreams-data",
      directory: basename(path),
      repository: SD_DATA_REPO,
      commit: SD_DATA_COMMIT,
      page: `https://forge.a-lec.org/speed-dreams/speed-dreams-data/src/commit/${SD_DATA_COMMIT}/${path}`,
    };
    writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    return dir;
  }

  if (cached?.sha256 === entry.sha256 && existsSync(dir)) return dir;
  console.log(`      fetching ${entry.name} (revision ${entry.revision}, ${(entry.bytes / 1e6).toFixed(1)} MB) from ${entry.archive}…`);
  const data = await download(entry.archive);
  const sha = createHash("sha256").update(data).digest("hex");
  if (sha !== entry.sha256) {
    throw new Error(
      `${entry.archive} is not the archive this importer pins (sha256 ${sha}, not ${entry.sha256}): Speed Dreams may have published a new revision. Update scripts/mods/importers/sd-track.circuits.json from https://www.speed-dreams.net/assets.json`,
    );
  }
  const part = `${dir}.part`;
  rmSync(part, { recursive: true, force: true });
  for (const e of await readZip(data)) {
    if (isArchiveJunk(e.path)) continue;
    const rel = safeRelative(e.path);
    if (!rel) throw new Error(`${entry.archive}: unsafe path in the archive: ${e.path}`);
    const out = join(part, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, await e.read());
  }
  const folder = findCircuitFolder(part, entry.directory);
  if (!folder) throw new Error(`${entry.archive}: no trackdef XML in the archive`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  renameSync(folder, dir);
  rmSync(part, { recursive: true, force: true });
  const source: CircuitSource = {
    from: "asset-database",
    directory: entry.directory,
    archive: entry.archive,
    sha256: entry.sha256,
    revision: entry.revision,
    page: entry.page,
    license: entry.license,
    author: entry.author,
  };
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  return dir;
}

/** The circuit's trackdef: <folder>.xml, else the folder's one XML with track segments */
export function trackdefOf(folder: string): string {
  const own = join(folder, `${basename(folder)}.xml`);
  if (existsSync(own)) return own;
  const xml = readdirSync(folder).filter((f) => /\.xml$/i.test(f) && !/\.prj\.xml$/i.test(f) && /Track Segments/.test(readFileSync(join(folder, f), "latin1")));
  if (xml.length !== 1) throw new Error(`${folder}: ${xml.length ? `several trackdef XMLs (${xml.join(", ")})` : "no Speed Dreams trackdef (<name>.xml with Track Segments)"}`);
  return join(folder, xml[0]);
}

/** Whether the trackdef's included files (Speed Dreams' default surfaces) are where it says, as in an install */
function includesResolve(xml: string): boolean {
  const text = readFileSync(xml, "latin1");
  const files = [...text.matchAll(/<!ENTITY\s+[\w.-]+\s+SYSTEM\s+"([^"]+)"/g)].map((m) => m[1]);
  return files.every((f) => existsSync(resolve(dirname(xml), f)));
}

/** The trackdef's Header: the circuit's name, author and description */
export function trackHeader(xml: string): { name?: string; author?: string; description?: string } {
  const text = decodeText(readFileSync(xml));
  const header = /<section\s+name="Header"\s*>([\s\S]*?)<\/section>/.exec(text)?.[1] ?? "";
  const attr = (n: string) => new RegExp(`<attstr\\s+name="${n}"[^>]*\\bval="([^"]*)"`).exec(header)?.[1]?.trim() || undefined;
  return { name: attr("name"), author: attr("author"), description: attr("description") };
}

export interface CircuitLicence {
  credit: SourceCredit;
  /** Files to put beside the circuit in the package: its own statements, and the licences' full texts when shareable */
  files: { from: string; name: string }[];
  /** Converted for personal use only */
  personal: boolean;
  /** One line on how the licence was settled, for the log */
  summary: string;
}

/**
 * The asset database's entry for a fetched circuit, when the folder is the copy the database pins: its record
 * (.source.json) names this folder's circuit, and the archive and sha256 sd-track.circuits.json pins for it. The
 * licence and author are then the pinned list's, never the record's own. Null for anything else: a folder from an
 * install or elsewhere, Speed Dreams' base data (the database doesn't list it), a record that doesn't match its pin
 */
export function pinnedCircuit(folder: string, source: CircuitSource | null): CatalogueEntry | null {
  if (source?.from !== "asset-database" || source.directory !== basename(folder)) return null;
  return catalogue().find((e) => e.directory === source.directory && e.sha256 === source.sha256 && e.archive === source.archive) ?? null;
}

/**
 * The circuit's licence and credit, or an error that says why it can't be shared: every statement file in its folder,
 * else (for a circuit fetched at the archive the asset database pins) the database's entry when it names the author;
 * and its trackdef's header (`trackdef`), the licence of the data the circuit is built from
 */
export function circuitLicence(folder: string, opts: { title: string; source: CircuitSource | null; headerAuthor?: string; personal: boolean; trackdef?: string }): CircuitLicence {
  const statements = statementFiles(folder);
  const pinned = statements.length ? null : pinnedCircuit(folder, opts.source);
  const dbAuthors = pinned && !pinned.author.startsWith("(") ? pinned.author.split(/\s*,\s*/) : null;
  // The circuit's own licence: its statements', or the database's, which must name the author too
  let art: LicenceReading;
  let via: string;
  if (statements.length) {
    art = mergeReadings(statements.map((s) => s.reading));
    via = statements.map((s) => s.file).join(", ");
    if (!art.licences.length) art.problems.push(`${via} name${statements.length === 1 ? "s" : ""} no licence this tool knows`);
  } else if (pinned && dbAuthors) {
    art = readLicenceEntry(pinned.license);
    via = "Speed Dreams' asset database";
  } else {
    art = { licences: [], problems: [pinned ? `it has no readme or licence file, and Speed Dreams' asset database names no author for it ("${pinned.author}")` : "it has no readme or licence file that names one"], holders: [] };
    via = "";
  }
  // The trackdef's own header (the GPL notice most carry): the data's licence, and anything there that takes it back
  const header = opts.trackdef && existsSync(opts.trackdef) ? xmlLeadingComments(decodeText(readFileSync(opts.trackdef))) : "";
  const data = header ? readLicenceText(header) : null;
  // (art names a licence or has a problem, so the header's licence alone never makes the circuit shareable)
  const reading = mergeReadings(data ? [art, { ...data, holders: [] }] : [art]);
  const shareable = isShareable(reading);

  const source = opts.source;
  const page = source?.page;
  const author = authorLine(art.holders.length ? art.holders : dbAuthors ?? [opts.headerAuthor || "Unknown"]);
  const from = source?.from === "asset-database"
    ? `From Speed Dreams' asset database (revision ${source.revision}, sha256 ${source.sha256!.slice(0, 12)}…).`
    : source?.from === "speed-dreams-data"
      ? `From Speed Dreams' base data (speed-dreams-data ${source.commit!.slice(0, 12)}).`
      : "From Speed Dreams.";
  const statementCopies = statements.map((s) => ({ from: s.path, name: carriedName("speed-dreams", s.file) }));
  const terms = creditLicence(reading);

  if (shareable) {
    return {
      credit: {
        title: opts.title,
        author,
        url: page,
        license: terms.license,
        licenseUrl: terms.licenseUrl,
        note: `${from} Converted to LibreCorsa; the circuit's licence statements and the licences' texts are in its folder.`,
      },
      files: [...statementCopies, ...licenceTextFiles(reading)],
      personal: false,
      summary: `${terms.license}, as ${[via, data?.licences.length ? "its trackdef's header" : ""].filter(Boolean).join(" and ")} state${statements.length === 1 && !data?.licences.length ? "s" : ""}`,
    };
  }

  const why = `${opts.title}'s licence doesn't let a converted copy be shared: ${reading.problems.join("; ")}`;
  if (!opts.personal) {
    throw new Error(`${why}.\nIt is not converted. With --personal it is, for you alone: the package's credit then says "${PERSONAL_USE_NOTE}".`);
  }
  return {
    credit: { title: opts.title, author, url: page, license: terms.license, note: terms.note },
    files: statementCopies,
    personal: true,
    summary: `for personal use only (${reading.problems.join("; ")})`,
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
  --personal               convert a circuit whose licence doesn't allow sharing, its credit marked "${PERSONAL_USE_NOTE}"
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
    const folder = values.fetch ? await fetchCircuit(values.fetch) : positionals[0] && resolve(positionals[0]);
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error("name a Speed Dreams circuit's folder, or --fetch <circuit>");
    const xml = trackdefOf(folder);
    const sourcePath = join(folder, ".source.json");
    const source = existsSync(sourcePath) ? (JSON.parse(readFileSync(sourcePath, "utf8")) as CircuitSource) : null;
    const header = trackHeader(xml);
    const directory = basename(folder);
    const listed = catalogue().find((e) => e.directory === directory && source?.sha256 === e.sha256);
    const title = displayName(listed?.name ?? header.name ?? directory);

    // The licence decides first: nothing is converted that can't be packaged
    const licence = circuitLicence(folder, { title, source, headerAuthor: header.author, personal: !!values.personal, trackdef: xml });
    console.log(`      licence: ${licence.summary}`);
    const credit = packageCredit(licence.credit);
    const localId = localIdFrom(values.id ?? directory);
    const { info, packageDir } = importTarget(
      { ...values, package: values.package ?? packageIdFrom("sd", directory) },
      { author: credit.author, name: title, credit, description: header.description },
    );

    const fetchBase = !values["sd-data"] && !includesResolve(xml);
    const sdData = values["sd-data"] ? resolve(values["sd-data"]) : fetchBase ? baseData() : null;
    const work = mkdtempSync(join(tmpdir(), "sd-track-"));
    try {
      const glb = join(work, `${localId}.glb`);
      const settingsPath = join(work, `${localId}.json`);
      const extract = [folder, "--out-glb", glb, "--out-settings", settingsPath, ...(sdData ? ["--sd-data", sdData] : [])];
      if (fetchBase) {
        // the shared textures the circuit draws on and doesn't carry
        const needs = join(work, "needs.json");
        runPython("scripts/tracks/extract_sd_track.py", [...extract, "--needs-json", needs]);
        baseTextures((JSON.parse(readFileSync(needs, "utf8")) as { textures: string[] }).textures);
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
      console.log(`      ${out.contentId} in ${packageDir}${licence.personal ? ` (${PERSONAL_USE_NOTE})` : ""}`);
      if (!out.checked.ok) throw new Error("the package doesn't pass the game's checks");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};

export default importer;
