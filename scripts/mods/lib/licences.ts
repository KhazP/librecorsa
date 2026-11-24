/**
 * What a source's own statements say about sharing it: the one licence reader every importer uses. A package is shared
 * from player to player, converted, so the licence must allow both changing the work and passing it on, for any use,
 * and the package must carry the licence's full text. Only licences whose text is in scripts/mods/licences/ count:
 *
 *   - the Free Art License 1.3, also when named without a version (the Copyleft Attitude notice Speed Dreams uses names
 *     none and points at the current text) or as an older 1.x "or later";
 *   - CC BY and CC BY-SA, 3.0 and 4.0, and CC0 1.0;
 *   - the GNU GPL 2.0 and 3.0, "only" or "or later".
 *
 * A statement is read whole: every licence it names and every restriction in it, across line breaks. Anything that
 * takes sharing back or leaves it in doubt is a problem, and one problem anywhere blocks sharing:
 *
 *   - a licence without an explicit version ("CC-BY", "the GNU General Public License"), or a version without a text
 *     here ("CC BY 2.0", "Free Art License 1.1" without "or later");
 *   - non-commercial or no-derivatives terms (NC, ND, in any spelling or order);
 *   - a negated licence ("not under the GPL"), or one followed by "?" or "*";
 *   - a licence this tool carries no text for (LGPL, MIT, …), or "Creative Commons" without saying which;
 *   - restrictive wording (RESTRICTIONS): rights reserved, personal use, no redistribution, permission needed, parts
 *     owned by others, content taken from another game.
 *
 * A bare "GPL" or "FAL" is no licence: in a mod's readme it is as often Grand Prix Legends or a FAL mod. In a licence
 * field (`readLicenceEntry`: Speed Dreams' asset database, ui_car.json's `license`) it is one without a version.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { REPO_ROOT } from "./toolchain";

export type LicenceId =
  | "FAL-1.3"
  | "CC-BY-3.0"
  | "CC-BY-4.0"
  | "CC-BY-SA-3.0"
  | "CC-BY-SA-4.0"
  | "CC0-1.0"
  | "GPL-2.0-only"
  | "GPL-2.0-or-later"
  | "GPL-3.0-only"
  | "GPL-3.0-or-later";

/** A licence content may be shared under, with its text */
export interface Licence {
  id: LicenceId;
  /** As a package's credit names it */
  name: string;
  url: string;
  /** Its full text, in scripts/mods/licences/ */
  textFile: string;
}

export const LICENCES_DIR = join(REPO_ROOT, "scripts", "mods", "licences");
const text = (f: string) => join(LICENCES_DIR, f);
const GPL2_URL = "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html";
const GPL3_URL = "https://www.gnu.org/licenses/gpl-3.0.html";

export const LICENCES: Readonly<Record<LicenceId, Licence>> = {
  "FAL-1.3": { id: "FAL-1.3", name: "Free Art License 1.3", url: "https://artlibre.org/licence/lal/en/", textFile: text("FAL-1.3.txt") },
  "CC-BY-3.0": { id: "CC-BY-3.0", name: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/", textFile: text("CC-BY-3.0.txt") },
  "CC-BY-4.0": { id: "CC-BY-4.0", name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", textFile: text("CC-BY-4.0.txt") },
  "CC-BY-SA-3.0": { id: "CC-BY-SA-3.0", name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/", textFile: text("CC-BY-SA-3.0.txt") },
  "CC-BY-SA-4.0": { id: "CC-BY-SA-4.0", name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", textFile: text("CC-BY-SA-4.0.txt") },
  "CC0-1.0": { id: "CC0-1.0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", textFile: text("CC0-1.0.txt") },
  "GPL-2.0-only": { id: "GPL-2.0-only", name: "GNU GPL 2.0", url: GPL2_URL, textFile: text("GPL-2.0.txt") },
  "GPL-2.0-or-later": { id: "GPL-2.0-or-later", name: "GNU GPL 2.0 or later", url: GPL2_URL, textFile: text("GPL-2.0.txt") },
  "GPL-3.0-only": { id: "GPL-3.0-only", name: "GNU GPL 3.0", url: GPL3_URL, textFile: text("GPL-3.0.txt") },
  "GPL-3.0-or-later": { id: "GPL-3.0-or-later", name: "GNU GPL 3.0 or later", url: GPL3_URL, textFile: text("GPL-3.0.txt") },
};

/** What a statement (or several, merged) says */
export interface LicenceReading {
  /** The licences it names that a converted copy may be shared under */
  licences: LicenceId[];
  /** Why it is not clear enough to share under. Empty when clear */
  problems: string[];
  /** Who it says holds the copyright ("Copyright © 2002 Eric Espie"), in order */
  holders: string[];
}

/** The credit note of anything converted that may not be shared: every importer's, word for word */
export const PERSONAL_USE_NOTE = "For personal use only: the author's permission is needed to share it";

/** Whether a reading lets a converted copy be shared: a licence it names, and no problem */
export const isShareable = (r: LicenceReading): boolean => r.licences.length > 0 && r.problems.length === 0;

/** Several readings as one: every licence, every problem, every holder */
export function mergeReadings(readings: readonly LicenceReading[]): LicenceReading {
  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  return {
    licences: uniq(readings.flatMap((r) => r.licences)),
    problems: uniq(readings.flatMap((r) => r.problems)),
    holders: uniq(readings.flatMap((r) => r.holders)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Restrictions: one list for every importer
// ---------------------------------------------------------------------------------------------------------------------

/** What a restriction forbids: passing the work on or changing it (not install steps: "don't rename the folder") */
const VERBS = String.raw`(?:re-?)?(?:distribut\w*|upload\w*|shar(?:e|es|ed|ing)|publish\w*|convert\w*|port(?:s|ed|ing)?\b|sell\w*|sold|cop(?:y|ies|ied|ying)|modif\w*|reproduc\w*|post(?:s|ed|ing)?\b|host\w*|mirror\w*)`;

/** Wording that takes sharing back, or leaves it in doubt, with why it blocks sharing */
export const RESTRICTIONS: readonly (readonly [RegExp, string])[] = [
  [/\ball\s+rights\s+reserved\b/gi, "it keeps all rights reserved"],
  [/\b(?:personal|private|own|non-?public)\s+use\b|\bprivate\s+purposes?\b/gi, "it is for personal use only"],
  [new RegExp(String.raw`\b(?:do\s+not|don'?t|doesn'?t|must\s+not|mustn'?t|may\s+not|cannot|can'?t|can\s+not|shall\s+not|never|(?:is|are|it'?s)?\s*not\s+(?:allowed|permitted)\s+to)\s+(?:be\s+)?${VERBS}`, "gi"), "it forbids passing it on or changing it"],
  [/\bnot\s+(?:be\s+|to\s+be\s+)?(?:re-?)?(?:distribut|upload|shar|publish|sold|for\s+(?:re-?)?distribution|for\s+sale)\w*/gi, "it forbids passing it on"],
  [/\bno\s+(?:re-?)?(?:distribution|uploads?|uploading|sharing|reposts?|reposting|conversions?|ports?|modifications?|mirrors?)\b/gi, "it forbids passing it on or changing it"],
  [/\b(?:prohibited|forbidden|not\s+permitted|disallowed)\b/gi, "it forbids passing it on or changing it"],
  [/\bwithout\s+(?:(?:my|our|his|her|their|the\s+authors?'?s?|the\s+creators?'?s?|the\s+owners?'?s?|written|prior|express|explicit)\s+){1,3}(?:permission|consent|approval|authori[sz]ation)/gi, "it needs the author's permission"],
  [/\b(?:prior|written)\s+(?:written\s+)?(?:permission|consent|approval)\b|\bpermission\s+(?:is\s+)?(?:needed|required)\b|\bask\s+(?:me|us|the\s+authors?)\s+(?:first|before|for\s+permission)\b|\bonly\s+with\s+(?:my|our|the\s+authors?'?s?)\s+permission\b/gi, "it needs the author's permission"],
  [/\bproperty\s+of\s+(?:their|its|the(?:ir)?)\s+(?:respective\s+)?owners?\b|\b(?:logos?|brands?|trademarks?|sponsors?)\b[^.;\n]{0,60}?\b(?:belong|property|owned|copyrighted|registered)\b/gi, "parts of it belong to others, under no licence it states"],
  [/\bnon-?free\b|\bproprietary\b|\bpayware\b|\bpaid\s+(?:mod|content|version|release|car|track)s?\b/gi, "it is not free to share"],
  [/\bripped\b|\b(?:extracted|taken|converted|ported)\s+from\s+(?:the\s+(?:game\s+)?)?(?:forza|gran\s+turismo|gt\s?sport|gt[67]\b|project\s+cars|iracing|rfactor|raceroom|automobilista|assetto\s+corsa\s+competizione|f1\s?20\d\d|f1\s?2\d\b|need\s+for\s+speed|nfs|grid|dirt|codemasters|kunos)/gi, "it holds content taken from another game"],
  [/\brestricted\b|\brestrictions\s+apply\b/gi, "it says parts of it are restricted"],
];

/**
 * Non-commercial and no-derivatives terms, each of which takes sharing a converted copy back: in words, in a licence's
 * code (`by-nc-nd` in a link), and as NC or ND in capitals
 */
const NON_COMMERCIAL = [/\bnon[\s-]*commercial\w*|\bby(?:-[a-z]{2})*-nc\b/gi, /(?<![A-Za-z0-9])NC(?![A-Za-z])/g] as const;
const NO_DERIVATIVES = [/\bno[\s-]*deriv\w*|\bno\s+derivative\s+works?\b|\bby(?:-[a-z]{2})*-nd\b/gi, /(?<![A-Za-z0-9])ND(?![A-Za-z])/g] as const;
/** NC and ND as abbreviations count only beside a Creative Commons licence */
const CC_CONTEXT = /creative\s*commons|creativecommons\.org|\bCC\b|\bCC[\s-]*BY|\bBY[\s-](?:SA|NC|ND)\b|\battribution\b/i;

// ---------------------------------------------------------------------------------------------------------------------
// Licences named
// ---------------------------------------------------------------------------------------------------------------------

/** A licence named in a statement: what it is (or why it isn't one to share under), and where */
interface Mention {
  words: string;
  index: number;
  end: number;
  id?: LicenceId;
  problem?: string;
}

const quote = (s: string) => `"${s.trim().slice(0, 80)}"`;
const LATER = String.raw`(?:\s*\+|,?\s*or\s*(?:\(\s*at\s*your\s*option\s*\)\s*)?(?:any\s*)?later(?:\s*version)?|[\s-]*or[\s-]*later)`;

/** The Free Art License: by name, by its link, or as "FAL" with a version */
function freeArt(flat: string): Mention[] {
  const out: Mention[] = [];
  const version = String.raw`(?:[\s,(]*(?:v(?:ersion)?\.?\s*)?(\d\.(?:\d+|x)|\d(?![\d.]))(${LATER})?)?`;
  const named = new RegExp(String.raw`\b(?:free\s*art\s*licen[cs]e|licen[cs]e\s*art\s*libre)${version}`, "gi");
  const short = new RegExp(String.raw`(?<![A-Za-z])FAL[\s-]*(?:v(?:ersion)?\.?\s*)?(\d\.(?:\d+|x)|\d(?![\d.]))(${LATER})?`, "g");
  for (const re of [named, short]) {
    for (const m of flat.matchAll(re)) {
      const v = m[1];
      const later = !!m[2];
      const at = { words: m[0], index: m.index, end: m.index + m[0].length };
      if (!v || v === "1.3" || (later && /^1(?:\.|$)/.test(v))) out.push({ ...at, id: "FAL-1.3" });
      else out.push({ ...at, problem: `${quote(m[0])}: a Free Art License version this tool carries no text for (1.3, or an older one "or later")` });
    }
  }
  for (const m of flat.matchAll(/artlibre\.org\/licen[cs]e\/lal\b/gi)) out.push({ words: m[0], index: m.index, end: m.index + m[0].length, id: "FAL-1.3" });
  return out;
}

const CC_MODIFIER = String.raw`(?:SA|NC|ND|share[\s-]?alike|non[\s-]?commercial|no[\s-]?deriv(?:ative)?s?|no\s+derivative\s+works)`;

/** A Creative Commons licence from its parts: the shareable ones by id, anything else as a problem */
function ccLicence(words: string, index: number, end: number, modifiers: string, version: string | undefined): Mention {
  const at = { words, index, end };
  const sa = /\bSA\b|share[\s-]?alike/i.test(modifiers);
  if (/\bNC\b|non[\s-]?commercial/i.test(modifiers)) return { ...at, problem: `${quote(words)}: non-commercial only, which a shared package can't hold anyone to` };
  if (/\bND\b|no[\s-]?deriv/i.test(modifiers)) return { ...at, problem: `${quote(words)}: no derivatives, and a conversion is one` };
  if (!version) return { ...at, problem: `${quote(words)} without a version` };
  const v = version.includes(".") ? version : `${version}.0`;
  const id = `CC-BY${sa ? "-SA" : ""}-${v}` as LicenceId;
  return id in LICENCES ? { ...at, id } : { ...at, problem: `${quote(words)}: a Creative Commons version this tool carries no text for (3.0 or 4.0)` };
}

/** Creative Commons licences: their links, their short names (CC BY-SA 4.0) and their words (Attribution-ShareAlike) */
function creativeCommons(flat: string): { mentions: Mention[]; named: boolean } {
  const out: Mention[] = [];
  for (const m of flat.matchAll(/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/gi)) {
    const code = m[1].toLowerCase();
    if (!/^by(?:-(?:sa|nc|nd))*$/.test(code)) out.push({ words: m[0], index: m.index, end: m.index + m[0].length, problem: `${quote(m[0])}: a Creative Commons licence this tool doesn't know` });
    else out.push(ccLicence(m[0], m.index, m.index + m[0].length, code.slice(2).replace(/-/g, " ").toUpperCase(), m[2]));
  }
  const short = new RegExp(String.raw`(?:(?<![A-Za-z])CC|creative\s*commons)[\s-]*(?:licen[cs]es?[\s:,-]*)?(?:\(\s*)?BY\b((?:[\s-]*${CC_MODIFIER})*)(?:[\s-]*(?:v(?:ersion)?\.?\s*)?(\d(?:\.\d)?)(?![\d.]*\d))?`, "gi");
  for (const m of flat.matchAll(short)) out.push(ccLicence(m[0], m.index, m.index + m[0].length, m[1], m[2]));
  const words = new RegExp(String.raw`(?:(?<![A-Za-z])CC|creative\s*commons)[\s-]*(?:licen[cs]es?[\s:,-]*)?(?:\(\s*)?attribution((?:[\s,\-–]*(?:and\s+)?${CC_MODIFIER})*)(?:[\s,\-–]*(?:v(?:ersion)?\.?\s*)?(\d\.\d))?`, "gi");
  for (const m of flat.matchAll(words)) out.push(ccLicence(m[0], m.index, m.index + m[0].length, m[1], m[2]));
  for (const m of flat.matchAll(/(?<![A-Za-z])CC0(?![A-Za-z0-9])(?:[\s-]*(?:v\s*)?1\.0)?|\bCC[\s-]*zero\b|creativecommons\.org\/publicdomain\/zero\/1\.0/gi)) {
    out.push({ words: m[0], index: m.index, end: m.index + m[0].length, id: "CC0-1.0" });
  }
  return { mentions: out, named: /creative\s*commons|creativecommons\.org/i.test(flat) };
}

/**
 * The GNU GPL: its name or "GPL" with a version. A notice names the licence more than once and gives the version once
 * ("…the GNU General Public License…; either version 2 of the License, or (at your option) any later version"), so the
 * version is the text's: the one any of its mentions gives, near it
 */
function gnuGpl(flat: string, field: boolean): Mention[] {
  const out: Mention[] = [];
  const versioned = new RegExp(String.raw`(?<![A-Za-z])(L|A)?GPL(?:[\s-]*\(?\s*v?(\d)(?:\.\d)?(?![\d.]*\d))?(${LATER}|[\s-]*only)?`, "g");
  for (const m of flat.matchAll(versioned)) {
    const at = { words: m[0], index: m.index, end: m.index + m[0].length };
    if (m[1]) out.push({ ...at, problem: `${quote(m[0])}: a licence this tool carries no text for` });
    else if (m[2] === "2" || m[2] === "3") out.push({ ...at, id: `GPL-${m[2]}.0-${m[3] && !/only/i.test(m[3]) ? "or-later" : "only"}` as LicenceId });
    else if (m[2]) out.push({ ...at, problem: `${quote(m[0])}: a GPL version this tool carries no text for` });
    // A bare "GPL" is a licence in a licence field, or where a readme says it is under one; elsewhere in a readme it
    // may be Grand Prix Legends
    else if (field || /\b(?:licen[cs]\w*|under|terms\s+of)\s+(?:the\s+)?$/i.test(flat.slice(Math.max(0, m.index - 30), m.index))) {
      out.push({ ...at, problem: `${quote(m[0])} without a version` });
    } else out.push({ ...at });
  }
  const named = /(?:\b(lesser|library|affero)\s+(?:GNU\s+)?)?(?:\bGNU\s+(?:general\s+)?|\bgeneral\s+)public\s+licen[cs]e/gi;
  const versions = new Set<string>();
  let later = false;
  const mentions: Mention[] = [];
  for (const m of flat.matchAll(named)) {
    const at = { words: m[0], index: m.index, end: m.index + m[0].length };
    if (m[1]) {
      out.push({ ...at, problem: `${quote(m[0])}: a licence this tool carries no text for` });
      continue;
    }
    mentions.push(at);
    const after = flat.slice(at.end, at.end + 200);
    const before = flat.slice(Math.max(0, at.index - 60), at.index);
    const v = /^[\s,;:(]*(?:v(?:ersion)?\.?\s*)?(\d)(?:\.\d)?\b/i.exec(after) ?? /\bversion\s*(\d)(?:\.\d)?\b/i.exec(after) ?? /\bversion\s*(\d)(?:\.\d)?\s*of\s*(?:the\s*)?$/i.exec(before);
    if (v) {
      versions.add(v[1]);
      if (new RegExp(`^.{0,120}?${LATER}`, "i").test(after.slice(v.index))) later = true;
    }
  }
  for (const at of mentions) {
    if (!versions.size) out.push({ ...at, problem: `${quote(at.words)} without a version` });
    for (const v of versions) {
      out.push(v === "2" || v === "3" ? { ...at, id: `GPL-${v}.0-${later ? "or-later" : "only"}` as LicenceId } : { ...at, problem: `${quote(at.words)} version ${v}: a version this tool carries no text for` });
    }
  }
  return out;
}

/** Licences this tool knows of but carries no text for: content under one of them can't be shared from here */
const OTHER_LICENCES = [
  /\b(?:MIT|Apache|BSD|Mozilla\s+Public|Artistic|(?:SIL\s+)?Open\s+Font|ISC|zlib|Boost\s+Software|Eclipse\s+Public|Open\s+Game|Microsoft\s+Public)\s+licen[cs]e\b|\bunlicen[cs]e\b|\bWTFPL\b/gi,
  /(?<![A-Za-z])(?:MPL|OFL|EPL)(?:[\s-]*v?\d(?:\.\d)?)?(?![A-Za-z])|(?<![A-Za-z])MIT(?![A-Za-z])(?=\s*(?:$|[,;)]))/g,
];

/** Words just before a mention that say it is not the licence ("not under the GPL", "Not licensed under CC BY") */
function negated(flat: string, index: number): boolean {
  const clause = flat.slice(Math.max(0, index - 48), index).split(/[.;!?]\s/).pop() ?? "";
  return /\b(?:not|never|nor|neither|isn'?t|aren'?t|wasn'?t|no\s+longer)\b/i.test(clause);
}

/** A mention followed by a "?" or a "*": the statement isn't sure of it, or qualifies it somewhere */
const unsure = (flat: string, end: number): boolean => /^[\s)\]"'’”]{0,3}[?*]/.test(flat.slice(end, end + 6));

/** The full text of one of the licences this tool carries, as a source ships it (LICENSE, COPYING), by its title */
const FULL_TEXTS: readonly [RegExp, LicenceId][] = [
  [/^\s*GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991\b/i, "GPL-2.0-only"],
  [/^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007\b/i, "GPL-3.0-only"],
  [/^\s*(?:Creative Commons Legal Code\s+)?Attribution 4\.0 International\s+=+/i, "CC-BY-4.0"],
  [/^\s*(?:Creative Commons Legal Code\s+)?Attribution-ShareAlike 4\.0 International\s+=+/i, "CC-BY-SA-4.0"],
  [/^\s*Creative Commons Legal Code\s+Attribution 3\.0 Unported\b/i, "CC-BY-3.0"],
  [/^\s*Creative Commons Legal Code\s+Attribution-ShareAlike 3\.0 Unported\b/i, "CC-BY-SA-3.0"],
  [/^\s*Creative Commons Legal Code\s+CC0 1\.0 Universal\b/i, "CC0-1.0"],
  [/^\s*Free Art License 1\.3\b/i, "FAL-1.3"],
];

/** A text's words, lower case, without punctuation: the same text whatever its layout */
const wordsOf = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
/** Each run of three words in a text */
const triples = (w: string[]): string[] => w.slice(0, Math.max(0, w.length - 2)).map((_, i) => `${w[i]} ${w[i + 1]} ${w[i + 2]}`);
const ownTriples = new Map<LicenceId, Set<string>>();

/**
 * A full licence text, as a source ships it (LICENSE, COPYING): its id when the file opens with one of the texts this
 * tool carries and its sentences are that text's, and the sentences that aren't. A copy may differ from the one here
 * in its layout and in a few words (the Free Software Foundation's address, "Library" for "Lesser", the sample
 * signature), so a sentence counts as the licence's when most of its runs of three words are. The licence's own words
 * ("you may not copy … except as expressly provided", the Lesser GPL it mentions) are the licence, not restrictions;
 * what a source adds to it is read as any statement is
 */
function fullLicenceText(t: string): { id: LicenceId; rest: string } | null {
  const hit = FULL_TEXTS.find(([title]) => title.test(t));
  if (!hit) return null;
  const id = hit[1];
  if (!ownTriples.has(id)) ownTriples.set(id, new Set(triples(wordsOf(readFileSync(LICENCES[id].textFile, "utf8")))));
  const own = ownTriples.get(id)!;
  let theirs = 0;
  let total = 0;
  const rest: string[] = [];
  for (const sentence of t.replace(/\s+/g, " ").split(/(?<=[.;:!?])\s+/)) {
    const w = wordsOf(sentence);
    if (!w.length) continue;
    total += w.length;
    const runs = triples(w);
    if (runs.length && runs.filter((r) => own.has(r)).length >= 0.6 * runs.length) theirs += w.length;
    else rest.push(sentence);
  }
  // Mostly the licence: anything else is a statement that quotes one
  return theirs >= 0.9 * total ? { id, rest: rest.join(" ") } : null;
}

/** Options for reading a statement */
interface ReadOptions {
  /** A licence field (a database's entry, ui_car.json's `license`): a bare "GPL" is the licence, without a version */
  field?: boolean;
}

/** The licences a statement names, everything that makes it unclear, and who holds its copyright */
export function readLicenceText(statement: string, opts: ReadOptions = {}): LicenceReading {
  const t = statement.replace(/\r\n?/g, "\n");
  const full = fullLicenceText(t);
  if (full) {
    // The licence's own copyright lines (the Free Software Foundation's) name no author of the work
    const added = full.rest ? readLicenceText(full.rest, opts) : { licences: [], problems: [], holders: [] };
    return { licences: [...new Set([full.id, ...added.licences])], problems: added.problems, holders: [] };
  }
  // One line: a phrase broken across lines is matched whole
  const flat = t.replace(/\s+/g, " ");
  const found = new Set<LicenceId>();
  const problems: string[] = [];
  const problem = (p: string) => {
    if (!problems.includes(p)) problems.push(p);
  };

  const cc = creativeCommons(flat);
  const mentions = [...freeArt(flat), ...cc.mentions, ...gnuGpl(flat, !!opts.field)];
  for (const m of mentions) {
    if (negated(flat, m.index)) problem(`${quote(flat.slice(Math.max(0, m.index - 30), m.end).split(/[.;!?]\s/).pop() ?? m.words)}: a licence it says doesn't apply`);
    else if (unsure(flat, m.end)) problem(`${quote(flat.slice(m.index, m.end + 2))}: a licence it isn't sure of, or qualifies`);
    else if (m.problem) problem(m.problem);
    else if (m.id) found.add(m.id);
  }
  if (cc.named && !cc.mentions.length) problem('"Creative Commons" without saying which licence');
  for (const re of OTHER_LICENCES) for (const m of flat.matchAll(re)) problem(`${quote(m[0])}: a licence this tool carries no text for`);

  const ccContext = CC_CONTEXT.test(flat);
  for (const [[words, letters], why] of [
    [NON_COMMERCIAL, "non-commercial only, which a shared package can't hold anyone to"],
    [NO_DERIVATIVES, "no derivatives, and a conversion is one"],
  ] as const) {
    // NC and ND alone mean something only beside a Creative Commons licence
    const m = [...flat.matchAll(words)][0] ?? (ccContext ? [...flat.matchAll(letters)][0] : undefined);
    if (m) problem(`${quote(flat.slice(Math.max(0, m.index - 20), m.index + m[0].length + 10))}: ${why}`);
  }
  // "Public domain" is no licence this tool carries a text for: CC0 1.0 is
  const pd = [...flat.matchAll(/\bpublic\s+domain\b/gi)].find((m) => !negated(flat, m.index));
  if (pd && !found.has("CC0-1.0")) problem(`${quote(pd[0])} without CC0 1.0: no licence text to carry`);
  for (const [re, why] of RESTRICTIONS) {
    const m = [...flat.matchAll(re)][0];
    if (m) problem(`${quote(m[0])}: ${why}`);
  }
  return { licences: [...found], problems, holders: copyrightHolders(t) };
}

/**
 * A licence field (Speed Dreams' asset database "Free Art License, CC-BY 4.0", ui_car.json's `license`): read as a
 * statement, a bare "GPL" taken as the licence; unclear with a "?" or "*" in it, or when it names nothing this knows
 */
export function readLicenceEntry(entry: string): LicenceReading {
  const r = readLicenceText(entry, { field: true });
  if (/[?*]/.test(entry)) r.problems.push(`${quote(entry)}: a "?" or "*" leaves it unclear`);
  if (!r.licences.length && !r.problems.length) r.problems.push(`${quote(entry)} is no licence this tool knows`);
  return { ...r, problems: [...new Set(r.problems)] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statement files
// ---------------------------------------------------------------------------------------------------------------------

/** One statement file, read */
export interface Statement {
  /** Its name, relative to the folder it was found in */
  file: string;
  path: string;
  text: string;
  reading: LicenceReading;
}

/** Words that make a file a statement: readme, licence, copying, copyright, credits, authors, terms */
const STATEMENT_WORDS = /read[\s_-]*me|licen[cs]es?|copying|copyright|credits?|authors?|terms|eula|permissions?/i;
/** Statement files as text (none, .txt, .md…), and ones this can't read (a PDF, a Word file) */
const TEXT_EXT = /^(?:|\.txt|\.md|\.markdown|\.rtf|\.nfo|\.html?|\.1st|\.me)$/i;
const UNREADABLE_EXT = /^\.(?:pdf|docx?|odt|pages)$/i;
/** A statement this long isn't read (it is a problem): no licence notice is */
const MAX_STATEMENT_BYTES = 1 << 20;

/** Whether a file's name makes it a statement: `readme.txt`, `LICENSE`, `COPYING`, `<car>-readme.txt`, `CREDITS.md` */
export const isStatementFile = (name: string): boolean => {
  const ext = extname(name);
  return (TEXT_EXT.test(ext) || UNREADABLE_EXT.test(ext)) && STATEMENT_WORDS.test(basename(name, ext));
};

/**
 * Text as a statement's author wrote it: UTF-8 or UTF-16 (by its byte-order mark), else Windows-1252, which older
 * readmes use (© as one byte). Null for bytes that aren't text
 */
export function decodeText(raw: Buffer): string {
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString("utf16le");
  if (raw[0] === 0xfe && raw[1] === 0xff) return Buffer.from(raw.subarray(2)).swap16().toString("utf16le");
  const body = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/** A statement file read, or a problem that says why it can't be */
function readStatement(path: string, file: string): Statement {
  const unreadable = (why: string): Statement => ({ file, path, text: "", reading: { licences: [], problems: [`${file}: ${why}, so its terms can't be checked`], holders: [] } });
  if (UNREADABLE_EXT.test(extname(file))) return unreadable("a document this tool can't read");
  if (statSync(path).size > MAX_STATEMENT_BYTES) return unreadable("too long to read");
  const raw = readFileSync(path);
  const t = decodeText(raw);
  // a NUL in what decoded as UTF-8 or Windows-1252: not text
  if (t.includes("\0")) return unreadable("not text");
  return { file, path, text: t, reading: readLicenceText(t) };
}

/**
 * Every statement file at the top of a folder, each read: readme, licence, copying, copyright, credits, authors and
 * terms files (`readme.txt`, `LICENSE`, `<folder>-readme.txt`, `Cavallo_Roxfall_readme.txt`), and the files of a folder
 * so named (`licenses/`). Every one is read; one this can't read is a problem in its own reading. `anyText`: every
 * text file at the top of the folder too (an Assetto Corsa mod's terms may be in `Info.txt` or `<car>.txt`)
 */
export function statementFiles(folder: string, opts: { anyText?: boolean } = {}): Statement[] {
  const out: Statement[] = [];
  if (!existsSync(folder)) return out;
  for (const f of readdirSync(folder).sort()) {
    const path = join(folder, f);
    const st = statSync(path);
    const text = opts.anyText && /^\.(?:txt|md|rtf|nfo)$/i.test(extname(f));
    if (st.isFile() && (isStatementFile(f) || text)) out.push(readStatement(path, f));
    else if (st.isDirectory() && STATEMENT_WORDS.test(f) && !f.startsWith(".")) {
      for (const g of readdirSync(path).sort()) {
        const p = join(path, g);
        if (statSync(p).isFile() && (TEXT_EXT.test(extname(g)) || UNREADABLE_EXT.test(extname(g)))) out.push(readStatement(p, `${f}/${g}`));
      }
    }
  }
  return out;
}

/**
 * Which of a folder's parts (a car's liveries, by id) a statement file's name is about: the parts whose words its name
 * holds whole, after the owner's own name (`<car>-<livery>-readme.txt`, `Cavallo_Roxfall_readme.txt`). The part with
 * the most words wins ("red-stripe" over "red"); none, and the statement is the owner's
 */
export function statementParts(file: string, owner: string, parts: readonly string[]): string[] {
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let name = words(basename(file, extname(file)));
  const own = words(owner);
  // the owner's name first, whole (`<car>-…`) or in part (`Cavallo_Roxfall_…`)
  if (own.length && own.every((w, i) => name[i] === w)) name = name.slice(own.length);
  else while (name.length > 1 && own.includes(name[0])) name = name.slice(1);
  name = name.filter((w) => !/^(?:read|me|readme|licen[cs]es?|copying|copyright|credits?|authors?|terms|eula|permissions?)$/.test(w));
  const holds = (p: string[]) => p.length > 0 && name.some((_, i) => p.every((w, j) => name[i + j] === w));
  const hits = parts.map((p) => ({ p, w: words(p) })).filter((x) => holds(x.w));
  const most = Math.max(0, ...hits.map((x) => x.w.length));
  return hits.filter((x) => x.w.length === most).map((x) => x.p);
}

// ---------------------------------------------------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------------------------------------------------

/** Who a statement says holds the copyright: the names after "Copyright (C) <years>", in order, each once */
export function copyrightHolders(statement: string): string[] {
  const names: string[] = [];
  const line = /copyright\s*:?\s*(?:\(c\)|©|�|Â©)?\s*(?:\d{4}(?:\s*[-–,]\s*\d{4})*,?\s*)?(?:by\s+)?([^\n(<]+)/gi;
  for (const m of statement.matchAll(line)) {
    // up to the sentence's end (not an initial's full stop), a wide gap or a dash
    const said = m[1].split(/(?<=\p{L}{2,})\.\s|\s{2,}|\t|;|\s[-–]\s/u)[0];
    for (const part of said.split(/,|\band\b|&/)) {
      const name = part.replace(/\b(?:19|20)\d{2}\b/g, "").replace(/\s+/g, " ").replace(/^[\s.:]+|[\s.,;:]+$/g, "").trim();
      if (!/\p{L}/u.test(name) || name.length < 2 || name.length > 60) continue;
      if (/^(?:attitude|notice|holders?|law|owners?|inc|ltd|the\s+authors?|all\s+rights|free\s+software\s+foundation|licen[cs]e|info|information|statement)\b/i.test(name)) continue;
      if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  return names;
}

/**
 * Names from one list, then another's that aren't among them: a name counts as there when one has the same first name
 * and a surname that starts alike (Speed Dreams' asset list spells some with typos, "Olaf Sa'ick" for "Olaf Saßnick")
 */
export function mergeNames(own: readonly string[], listed: readonly string[]): string[] {
  const key = (n: string) => {
    const w = n.toLowerCase().split(/\s+/);
    return `${w[0]}|${(w[w.length - 1] ?? "").slice(0, 2)}`;
  };
  const out = [...own];
  const have = new Set(own.map(key));
  for (const n of listed) {
    if (!have.has(key(n))) {
      out.push(n);
      have.add(key(n));
    }
  }
  return out;
}

/** A credit's author: the names given, cut to what a package's credit holds (80 characters) at a name's end */
export function authorLine(names: readonly string[], max = 80): string {
  const all = names.join(", ");
  if (all.length <= max) return all;
  let out = "";
  for (const n of names) {
    if (`${out}${out ? ", " : ""}${n} and others`.length > max) break;
    out = `${out}${out ? ", " : ""}${n}`;
  }
  return `${out || names[0].slice(0, max - 14)} and others`;
}

// ---------------------------------------------------------------------------------------------------------------------
// What a package carries
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A package credit's licence fields for what it holds: its licences' names and the first one's link when it may be
 * shared; otherwise "unknown" and the personal-use note, and no link
 */
export function creditLicence(r: LicenceReading): { license: string; licenseUrl?: string; note?: string; personal: boolean } {
  if (!isShareable(r)) return { license: "unknown", note: PERSONAL_USE_NOTE, personal: true };
  return { license: r.licences.map((id) => LICENCES[id].name).join(", "), licenseUrl: LICENCES[r.licences[0]].url, personal: false };
}

/** The licence texts a package carries (`LICENSE-<id>.txt`): each of its licences' when it may be shared, else none */
export function licenceTextFiles(r: LicenceReading): { from: string; name: string }[] {
  return isShareable(r) ? r.licences.map((id) => ({ from: LICENCES[id].textFile, name: `LICENSE-${id}.txt` })) : [];
}

/**
 * An XML file's comments before its first element (Speed Dreams' trackdefs, cars and categories open with their
 * copyright and licence notice there), as one text
 */
export function xmlLeadingComments(xml: string): string {
  const first = /<(?![?!])[A-Za-z]/.exec(xml);
  const head = first ? xml.slice(0, first.index) : xml;
  return [...head.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).join("\n");
}

/** A source's statement file as a package names it: `<prefix>-<file>`, as text (`speed-dreams-readme.txt`) */
export const carriedName = (prefix: string, file: string): string =>
  `${prefix}-${file.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")}${/\.(txt|md)$/i.test(file) ? "" : ".txt"}`;
