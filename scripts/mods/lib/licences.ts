/**
 * The licence a source states in its own files (a readme's "Copyleft: … Free Art license", a LICENSE file), as an
 * importer needs it: which licence it is, whether a player may share what is converted from it, and its full text for
 * the package. The texts are in scripts/mods/licences/.
 *
 * A package is shared from player to player, converted, so a source's licence must allow both changing it and passing
 * it on, for any use: a licence without derivatives (ND) or for non-commercial use only (NC) doesn't, nor does a
 * statement that keeps the rights or forbids passing the work on. Anything this doesn't recognise counts as no clear
 * licence: the importer refuses it unless the modder converts it for personal use only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./toolchain";

/** A licence the importers recognise and may share content under */
export interface Licence {
  /** SPDX-style id: the name of its text in scripts/mods/licences/ (`<id>.txt`), when there is one */
  id: string;
  /** As a package's credit names it */
  name: string;
  url: string;
}

export const LICENCES_DIR = join(REPO_ROOT, "scripts", "mods", "licences");

/** The licence's full text in scripts/mods/licences/, or null for a version whose text isn't kept there */
export function licenceText(l: Licence): string | null {
  const path = join(LICENCES_DIR, `${l.id}.txt`);
  return existsSync(path) ? path : null;
}

/** What a statement says: a licence that lets players share, one that doesn't (and why), or nothing this recognises */
export type LicenceFinding =
  | { kind: "shareable"; licence: Licence }
  | { kind: "restricted"; licence?: Licence; reason: string }
  | { kind: "unrecognised"; reason: string };

const FAL: Licence = { id: "FAL-1.3", name: "Free Art License 1.3", url: "https://artlibre.org/licence/lal/en/" };
const CC0: Licence = { id: "CC0-1.0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };

const CC_NAMES: Record<string, string> = { by: "BY", "by-sa": "BY-SA", "by-nd": "BY-ND", "by-nc": "BY-NC", "by-nc-sa": "BY-NC-SA", "by-nc-nd": "BY-NC-ND" };

function ccLicence(kind: string, version: string): Licence {
  const v = /^\d\.\d$/.test(version) ? version : "4.0";
  return { id: `CC-${CC_NAMES[kind]}-${v}`, name: `CC ${CC_NAMES[kind]} ${v}`, url: `https://creativecommons.org/licenses/${kind}/${v}/` };
}

/** The Creative Commons licence a statement names (by its link, its short name or its words), if any */
function creativeCommons(t: string): Licence | null {
  const link = /creativecommons\.org\/licenses\/(by(?:-nc)?(?:-sa|-nd)?)\/(\d\.\d)/.exec(t);
  if (link) return ccLicence(link[1], link[2]);
  const short = /\bcc[ -](by(?:[ -]nc)?(?:[ -](?:sa|nd))?)(?:[ -](\d\.\d))?\b/.exec(t);
  if (short) return ccLicence(short[1].replace(/ /g, "-"), short[2] ?? "4.0");
  if (!/creative ?commons/.test(t)) return null;
  const words = /creative ?commons attribution((?:[ -]+non-?commercial)?(?:[ -]+share-?alike|[ -]+no-?deriv(?:ative)?s?)?)(?:[ -]+(\d\.\d))?/.exec(t);
  if (!words) return null;
  const rest = words[1];
  const kind = `by${/non-?commercial/.test(rest) ? "-nc" : ""}${/share-?alike/.test(rest) ? "-sa" : /no-?deriv/.test(rest) ? "-nd" : ""}`;
  return ccLicence(kind, words[2] ?? "4.0");
}

/**
 * The licence a source's statement (a readme, a LICENSE file, a licence field) names, and whether it lets a player
 * share what is converted from it
 */
export function recogniseLicence(statement: string): LicenceFinding {
  const t = statement.toLowerCase().replace(/\s+/g, " ");
  if (/all rights reserved|do not (?:re)?distribute|not for (?:re)?distribution|may not be (?:re)?distributed|personal use only|without (?:my |the author'?s? |prior |written )?permission/.test(t)) {
    return { kind: "restricted", reason: "it keeps its rights or forbids passing it on" };
  }
  const cc = creativeCommons(t);
  if (cc) {
    if (cc.id.includes("-ND-")) return { kind: "restricted", licence: cc, reason: `${cc.name} allows no changed copies, and a conversion is one` };
    if (cc.id.includes("-NC-")) return { kind: "restricted", licence: cc, reason: `${cc.name} allows non-commercial use only, which a package can't hold anyone to` };
    return { kind: "shareable", licence: cc };
  }
  if (/free art licen[cs]e|licence art libre|artlibre\.org|\bfal\b/.test(t)) return { kind: "shareable", licence: FAL };
  if (/\bcc0\b|creativecommons\.org\/publicdomain\/zero/.test(t)) return { kind: "shareable", licence: CC0 };
  if (/public domain/.test(t)) return { kind: "shareable", licence: { ...CC0, name: "Public domain (CC0 1.0)" } };
  if (/gnu general public licen[cs]e|\bgpl\b/.test(t) && !/lesser|library|affero/.test(t)) {
    const v3 = /version 3|gpl-?v?3|gpl 3/.test(t);
    const later = /or (?:\(at your option\) )?any later version|or later|\+/.test(t);
    return v3
      ? { kind: "shareable", licence: { id: "GPL-3.0", name: `GNU GPL 3.0${later ? " or later" : ""}`, url: "https://www.gnu.org/licenses/gpl-3.0.html" } }
      : { kind: "shareable", licence: { id: "GPL-2.0", name: `GNU GPL 2.0${later ? " or later" : ""}`, url: "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html" } };
  }
  return { kind: "unrecognised", reason: "it names no licence this importer knows" };
}

/** Files a source keeps its licence and credits in, at the top of its folder: readme, licence, copying, credits, as
 * plain text (no extension, .txt or .md) */
const STATEMENT_FILE = /^(?:read[ _-]?me|licen[cs]e|copying|copyright|credits?|authors?)(?:[_ -][^.]*)?(?:\.(?:txt|md))?$/i;

/** A source folder's licence statements: its readme, licence and credits files (text, up to 64 kB each) */
export function statementFiles(folder: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const f of readdirSync(folder).sort()) {
    const path = join(folder, f);
    if (!STATEMENT_FILE.test(f) || !statSync(path).isFile() || statSync(path).size > 65536) continue;
    const raw = readFileSync(path);
    // a statement is text: one with NUL bytes is not
    if (raw.includes(0)) continue;
    out.push({ file: f, text: decodeText(raw) });
  }
  return out;
}

/** Text in UTF-8, else Latin-1 (older readmes write © as one byte) */
export function decodeText(raw: Buffer): string {
  const utf8 = raw.toString("utf8");
  return utf8.includes("�") ? raw.toString("latin1") : utf8;
}

/** Who a statement says holds the copyright: the names after "Copyright (C) <years>", in order, without repeats */
export function copyrightHolders(statement: string): string[] {
  const names: string[] = [];
  for (const m of statement.matchAll(/copyright\s*(?:\(c\)|©|�)?\s*(?:\d{4}(?:\s*[-–,]\s*\d{4})*,?\s*)?(?:by\s+)?([^\n(<]+)/gi)) {
    const name = m[1].replace(/\s+/g, " ").replace(/[.,;:\s]+$/, "").trim();
    if (name && !/^(?:attitude|notice|holder|law|\d)/i.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}
