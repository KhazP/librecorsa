/**
 * What a Speed Dreams car may be shared under. Speed Dreams' artwork is under the Free Art License by default and its
 * data and code under the GPL (version 2 or later), but each car states its own terms in a readme beside its files,
 * some name more than one licence, and a livery may come with a readme of its own. This reads those statements:
 *
 *   - the car's licence: its own readme (`readme.txt`, `README.md`, `LICENSE`, `COPYING`…), else the official asset
 *     database's entry for it (scripts/cars/speed-dreams-cars.json), else none;
 *   - its data's: the GPL header its XML carries, when it has one;
 *   - each livery's: a readme named after the livery (`<car>-<livery>-readme.txt`, `Cavallo_Roxfall_readme.txt`).
 *
 * A statement is clear when every licence it names is one this file knows, all of them let anyone share a converted
 * copy, and nothing in it takes that back ("all rights reserved", "personal use", "property of their owners"). A
 * database entry with a "?" or "*" in it is unclear.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type LicenceId = "FAL-1.3" | "GPL-2.0-or-later" | "GPL-2.0-only" | "CC-BY-4.0" | "CC-BY-SA-4.0" | "CC-BY-3.0" | "CC-BY-SA-3.0" | "CC0-1.0";

export interface Licence {
  id: LicenceId;
  /** As a credit names it */
  name: string;
  url: string;
  /** Its text, in scripts/mods/licences/ */
  textFile: string;
}

const LICENCE_DIR = join(__dirname, "..", "mods", "licences");

export const LICENCES: Readonly<Record<LicenceId, Licence>> = {
  "FAL-1.3": { id: "FAL-1.3", name: "Free Art License 1.3", url: "https://artlibre.org/licence/lal/en/", textFile: join(LICENCE_DIR, "FAL-1.3.txt") },
  "GPL-2.0-or-later": {
    id: "GPL-2.0-or-later",
    name: "GPL-2.0-or-later",
    url: "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html",
    textFile: join(LICENCE_DIR, "GPL-2.0.txt"),
  },
  "GPL-2.0-only": { id: "GPL-2.0-only", name: "GPL-2.0-only", url: "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html", textFile: join(LICENCE_DIR, "GPL-2.0.txt") },
  "CC-BY-4.0": { id: "CC-BY-4.0", name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", textFile: join(LICENCE_DIR, "CC-BY-4.0.txt") },
  "CC-BY-SA-4.0": { id: "CC-BY-SA-4.0", name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", textFile: join(LICENCE_DIR, "CC-BY-SA-4.0.txt") },
  "CC-BY-3.0": { id: "CC-BY-3.0", name: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/", textFile: join(LICENCE_DIR, "CC-BY-3.0.txt") },
  "CC-BY-SA-3.0": { id: "CC-BY-SA-3.0", name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/", textFile: join(LICENCE_DIR, "CC-BY-SA-3.0.txt") },
  "CC0-1.0": { id: "CC0-1.0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", textFile: join(LICENCE_DIR, "CC0-1.0.txt") },
};

/** What one statement (a readme, a database entry) says */
export interface LicenceReading {
  licences: LicenceId[];
  /** Why it is not clear enough to share under: an unknown or partial licence, a restriction. Empty when clear */
  problems: string[];
}

/** Phrases that take sharing back, or make a statement too vague to share under */
const RESTRICTIONS: [RegExp, string][] = [
  [/all rights reserved/i, '"all rights reserved"'],
  [/personal use|private use|own use only/i, "personal use only"],
  [/(not|never) (be )?(re)?distribut|do not (re)?distribute|no (re)?distribution|may not be (re)?distributed/i, "no redistribution"],
  [/without (my |the author'?s? |prior |written )*permission/i, "needs the author's permission"],
  [/property of (their|its) (respective )?owners/i, '"property of their owners": parts under no stated licence'],
  [/\bnon[- ]?free\b|proprietary/i, "non-free"],
];

const CC_VARIANT = /\bCC[ -]?(BY(?:[ -](?:NC|SA|ND))*)(?:[ -]?(\d\.\d))?\b|creative\s*commons\s+(attribution(?:[ -](?:non-?commercial|share-?alike|no-?deriv\w*))*)(?:[^.\n]*?(\d\.\d))?/gi;

/** The licences a piece of text states, and anything that makes it unclear */
export function readLicenceText(text: string): LicenceReading {
  const found = new Set<LicenceId>();
  const problems: string[] = [];
  if (/free\s*art\s*licen[cs]e|licence\s*art\s*libre|artlibre\.org|copyleft attitude/i.test(text)) {
    if (/free\s*art\s*licen[cs]e\s*(v(ersion)?\s*)?1\.[0-2]\b|licence\s*art\s*libre\s*1\.[0-2]\b/i.test(text) && !/or (any )?later/i.test(text)) {
      problems.push("an older Free Art License version without “or later”");
    }
    found.add("FAL-1.3");
  }
  const gpl = /\bGNU\s+(General\s+)?Public\s+Licen[cs]e|\bGPL\s*-?\s*v?\s*\d|\bGPLv?\d|\bGPL\b/i;
  if (gpl.test(text)) {
    const version = /(version|v)\s*2\b|GPL\s*-?\s*v?\s*2|GPLv2/i.test(text) ? 2 : /(version|v)\s*3\b|GPL\s*-?\s*v?\s*3|GPLv3/i.test(text) ? 3 : 0;
    const later = /or\s*\(at\s*your\s*option\)\s*any\s*later|or[ -]later|\bv?2\s*\+|GPLv2\+/i.test(text);
    if (version === 2) found.add(later ? "GPL-2.0-or-later" : "GPL-2.0-only");
    else problems.push(version === 3 ? "GPL version 3, which this tool doesn't carry" : "the GPL, version not stated");
  }
  for (const m of text.matchAll(CC_VARIANT)) {
    const raw = (m[1] ?? m[3] ?? "").toUpperCase();
    const version = m[2] ?? m[4];
    const nd = /ND|NO-?DERIV/.test(raw);
    const nc = /NC|NON-?COMMERCIAL/.test(raw);
    const sa = /SA|SHARE-?ALIKE/.test(raw);
    if (nd) {
      problems.push(`${m[0].trim()}: no derivatives, so a converted copy can't be shared`);
      continue;
    }
    if (nc) {
      problems.push(`${m[0].trim()}: non-commercial, which this tool doesn't carry`);
      continue;
    }
    if (!version) {
      problems.push(`${m[0].trim()} without a version`);
      continue;
    }
    const id = `CC-BY${sa ? "-SA" : ""}-${version}` as LicenceId;
    if (id in LICENCES) found.add(id);
    else problems.push(`${m[0].trim()}: a Creative Commons version this tool doesn't carry`);
  }
  if (/creative\s*commons/i.test(text) && !new RegExp(CC_VARIANT.source, "i").test(text)) problems.push('"Creative Commons" without saying which licence');
  if (/\bCC0\b|public\s*domain/i.test(text)) found.add("CC0-1.0");
  for (const [re, why] of RESTRICTIONS) if (re.test(text)) problems.push(why);
  return { licences: [...found], problems };
}

/** A database entry's licence ("Free Art License, CC-BY 4.0"): as a readme's, and unclear with a "?" or "*" in it */
export function readLicenceEntry(entry: string): LicenceReading {
  const r = readLicenceText(entry);
  if (/[?*]/.test(entry)) r.problems.push(`the official list gives "${entry}"`);
  if (!r.licences.length && !r.problems.length) r.problems.push(`"${entry}" is no licence this tool knows`);
  return r;
}

/** A car folder's licence statements */
export interface CarLicence {
  /** Where the car's licence came from: its own files, the official list, or nowhere */
  source: "readme" | "database" | "none";
  /** The car's readme(s), as found (copied into the package) */
  readmes: string[];
  reading: LicenceReading;
  /** The GPL header of the car's XML (the physics data), when it has one */
  data: LicenceReading | null;
  /** Liveries (by id) with their own readme, and what each says */
  liveries: Record<string, { readme: string; reading: LicenceReading }>;
}

const README = /^(readme|licen[cs]e|copying|copyright)([._-].*)?(\.(txt|md))?$/i;
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The licence statements of the car in `carDir` (named `car`): its readme(s), its XML's header, its liveries' readmes
 * (`liveryIds`: the liveries the folder has), and the official list's entry when it has no readme of its own
 */
export function findCarLicence(carDir: string, car: string, liveryIds: readonly string[], databaseEntry?: string): CarLicence {
  const files = readdirSync(carDir).filter((f) => isFile(join(carDir, f)));
  const liveries: CarLicence["liveries"] = {};
  const readmes: string[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (!/readme|licen[cs]e|copying/.test(lower) || !/\.(txt|md)$|^[^.]+$/.test(lower)) continue;
    // A livery's readme names the livery: `<car>-<livery>-readme.txt`, `Cavallo_Roxfall_readme.txt`
    const livery = liveryIds.find((id) => squash(f).includes(squash(id)) && !squash(car).includes(squash(id)));
    if (livery) {
      liveries[livery] = { readme: f, reading: readLicenceText(readFileSync(join(carDir, f), "utf8")) };
      continue;
    }
    if (README.test(f)) readmes.push(f);
  }
  readmes.sort();
  const xml = join(carDir, `${car}.xml`);
  // Its header comment, one line per comment: read as one text, so "or" and "(at your option) any later" meet
  const header = isFile(xml) ? (/^[\s\S]*?<params/.exec(readFileSync(xml, "utf8"))?.[0] ?? "").replace(/<!--|-->/g, " ") : "";
  const data = /General\s+Public\s+Licen[cs]e/i.test(header) ? readLicenceText(header) : null;
  if (readmes.length) {
    const texts = readmes.map((f) => readFileSync(join(carDir, f), "utf8"));
    const readings = texts.map(readLicenceText).filter((r) => r.licences.length || r.problems.length);
    if (readings.length) {
      return {
        source: "readme",
        readmes,
        reading: { licences: [...new Set(readings.flatMap((r) => r.licences))], problems: readings.flatMap((r) => r.problems) },
        data,
        liveries,
      };
    }
  }
  if (databaseEntry) return { source: "database", readmes, reading: readLicenceEntry(databaseEntry), data, liveries };
  return { source: "none", readmes, reading: { licences: [], problems: ["no licence in the car's folder, and it isn't in the official list"] }, data, liveries };
}

/** Whether a reading lets a converted copy be shared */
export const shareable = (r: LicenceReading): boolean => r.licences.length > 0 && r.problems.length === 0;
