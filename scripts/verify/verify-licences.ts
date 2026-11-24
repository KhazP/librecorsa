/**
 * The licence reader every importer uses (scripts/mods/lib/licences.ts), on statements as sources write them: each
 * vector is a statement, whether a converted copy may be shared under it, and the licences it names or why it can't
 * be shared. Then the statement files a folder holds, which of a car's liveries a readme is about, the authors a
 * statement names, and what a package carries for shareable and for personal content.
 *
 *   npx tsx scripts/verify/verify-licences.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorLine,
  copyrightHolders,
  creditLicence,
  decodeText,
  isShareable,
  LICENCES,
  licenceTextFiles,
  mergeNames,
  mergeReadings,
  PERSONAL_USE_NOTE,
  readLicenceEntry,
  readLicenceText,
  statementFiles,
  statementParts,
  type LicenceId,
} from "../mods/lib/licences";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(84)} ${detail}`);
  if (!ok) failed++;
}

/** A statement and what it allows: the licences it names when it may be shared, else a pattern of why not */
type Vector = { text: string; field?: boolean; shareable: true; licences: LicenceId[] } | { text: string; field?: boolean; shareable: false; why: RegExp };

const SD_FAL = `Copyright © 2002 Eric Espie
Copyleft: this work of art is free, you can redistribute
it and/or modify it according to terms of the Free Art license.
You will find a specimen of this license on the site
Copyleft Attitude http://artlibre.org as well as on other sites.`;
const GPL_NOTICE = `This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.`;

const VECTORS: Vector[] = [
  // What may be shared
  { text: SD_FAL, shareable: true, licences: ["FAL-1.3"] },
  { text: "Free Art License 1.3 (FAL 1.3)", shareable: true, licences: ["FAL-1.3"] },
  { text: "Released under the Free Art License 1.1 or any later version.", shareable: true, licences: ["FAL-1.3"] },
  { text: "Licence: FAL 1.x or later", shareable: true, licences: ["FAL-1.3"] },
  { text: "Creative Commons Attribution 4.0 International", shareable: true, licences: ["CC-BY-4.0"] },
  { text: "Licensed under https://creativecommons.org/licenses/by-sa/3.0/", shareable: true, licences: ["CC-BY-SA-3.0"] },
  { text: "CC-BY-SA 4.0", shareable: true, licences: ["CC-BY-SA-4.0"] },
  { text: "Creative Commons Attribution-ShareAlike 3.0 Unported", shareable: true, licences: ["CC-BY-SA-3.0"] },
  { text: "Dedicated to the public domain under CC0 1.0 Universal.", shareable: true, licences: ["CC0-1.0"] },
  { text: GPL_NOTICE, shareable: true, licences: ["GPL-2.0-or-later"] },
  { text: "Licence: GPL-3.0-or-later", shareable: true, licences: ["GPL-3.0-or-later"] },
  { text: "This car is licensed under the GNU GPL v3.", shareable: true, licences: ["GPL-3.0-only"] },
  { text: "Model: GPLv2+. Textures: CC BY 4.0.", shareable: true, licences: ["GPL-2.0-or-later", "CC-BY-4.0"] },
  { text: "Free Art License, CC-BY 4.0", field: true, shareable: true, licences: ["FAL-1.3", "CC-BY-4.0"] },
  { text: "Free Art License", field: true, shareable: true, licences: ["FAL-1.3"] },
  { text: "Converted from GPL (Grand Prix Legends) by A. Modder. Released under CC BY 4.0.", shareable: true, licences: ["CC-BY-4.0"] },

  // Missing versions are not invented
  { text: "Released under CC-BY.", shareable: false, why: /without a version/ },
  { text: "Licensed under the GPL", shareable: false, why: /no licence|without a version/ },
  { text: "GPL", field: true, shareable: false, why: /without a version/ },
  { text: "GNU Public License (v2?)", field: true, shareable: false, why: /isn't sure|"\?"/ },
  { text: "Model under the GPL (v2?)", shareable: false, why: /isn't sure/ },
  { text: "Free Art License 1.1", shareable: false, why: /version this tool carries no text for/ },
  { text: "CC BY 2.0", shareable: false, why: /version this tool carries no text for/ },
  { text: "Licensed under the GNU General Public License.", shareable: false, why: /without a version/ },
  { text: "GPL 2.0, CC-BY-SA 3.0, Free Art License*", field: true, shareable: false, why: /isn't sure|"\*"/ },

  // Bare names are not licences
  { text: "Converted from GPL. Have fun!", shareable: false, why: /^$/ },
  { text: "Converted from FAL mod by the community.", shareable: false, why: /^$/ },
  { text: "Original track from Grand Prix Legends (GPL), converted by J. Doe.", shareable: false, why: /^$/ },

  // Non-commercial and no-derivatives, in any spelling
  { text: "CC BY-NC-SA 4.0", shareable: false, why: /non-commercial/ },
  { text: "CC BY-SA-NC 4.0", shareable: false, why: /non-commercial/ },
  { text: "CC BY-NoDerivs 4.0", shareable: false, why: /no derivatives/ },
  { text: "CC BY-NonCommercial 4.0", shareable: false, why: /non-commercial/ },
  { text: "Creative Commons Attribution, NonCommercial, NoDerivatives 4.0", shareable: false, why: /non-commercial|no derivatives/ },
  { text: "Creative Commons Attribution-NoDerivatives 4.0", shareable: false, why: /no derivatives/ },
  { text: "CC BY-ND4.0", shareable: false, why: /no derivatives/ },
  { text: "Licensed CC BY 4.0\nNoDerivatives", shareable: false, why: /no derivatives/ },
  { text: "Released CC BY 4.0. Textures: CC BY-NC-ND 4.0.", shareable: false, why: /non-commercial|no derivatives/ },
  { text: "https://creativecommons.org/licenses/by-nc-nd/4.0/", shareable: false, why: /non-commercial|no derivatives/ },
  { text: "Non-commercial use only.", shareable: false, why: /non-commercial/ },

  // Negations
  { text: "This mod is NOT under the GPL.", shareable: false, why: /doesn't apply/ },
  { text: "Not in the public domain.", shareable: false, why: /^$/ },
  { text: "Not licensed under CC BY 4.0", shareable: false, why: /doesn't apply/ },
  { text: "These textures are not under the Free Art License.", shareable: false, why: /doesn't apply/ },

  // Restrictive wording, wherever it is
  { text: "Logos are property of their respective owners. CC BY 4.0", shareable: false, why: /belong to others/ },
  { text: "Ripped from Forza. Do not upload anywhere.", shareable: false, why: /another game|forbids/ },
  { text: "CC BY 4.0. Do not reupload this mod.", shareable: false, why: /forbids/ },
  { text: "Feel free to modify for your own personal use.", shareable: false, why: /personal use/ },
  { text: "You may redistribute skins, but the 3D model is restricted.", shareable: false, why: /restricted/ },
  { text: "(C) 2020 Someone. All rights reserved.", shareable: false, why: /rights reserved/ },
  { text: "Free for personal use, do not redistribute.", shareable: false, why: /personal use|forbids/ },
  { text: "Free Art License. Please do not upload it without my permission.", shareable: false, why: /forbids|permission/ },
  { text: "Everything is available through Creative Commons license. The logos are property of their owners.", shareable: false, why: /which licence|belong to others/ },
  { text: "CC BY 4.0, but ask me first before sharing.", shareable: false, why: /permission/ },
  { text: "Released into the public domain.", shareable: false, why: /without CC0/ },

  // Licences this tool carries no text for
  { text: "Released under the MIT License.", shareable: false, why: /no text for/ },
  { text: "GNU Lesser General Public License v2.1", shareable: false, why: /no text for/ },
  { text: "Licence: LGPL-3.0", shareable: false, why: /no text for/ },
  { text: "Track made by me in 2010. Have fun!", shareable: false, why: /^$/ },
  { text: "Freeware", field: true, shareable: false, why: /no licence this tool knows/ },
];

console.log("== Statements");
for (const v of VECTORS) {
  const r = v.field ? readLicenceEntry(v.text) : readLicenceText(v.text);
  const label = JSON.stringify(v.text.split("\n")[0].slice(0, 60)) + (v.field ? " (a licence field)" : "");
  if (v.shareable) {
    const same = r.licences.length === v.licences.length && v.licences.every((l) => r.licences.includes(l));
    check(`shareable: ${label}`, isShareable(r) && same, `${r.licences.join(", ")} ${r.problems.join("; ")}`);
  } else {
    check(`not shareable: ${label}`, !isShareable(r) && (v.why.source === "^$" ? !r.licences.length : r.problems.some((p) => v.why.test(p))), `${r.licences.join(", ") || "no licence"}${r.problems.length ? `: ${r.problems.join("; ")}` : ""}`);
  }
}

console.log("\n== Full licence texts, as a source ships them");
for (const id of Object.keys(LICENCES) as LicenceId[]) {
  if (id.endsWith("-or-later")) continue;
  const r = readLicenceText(readFileSync(LICENCES[id].textFile, "utf8"));
  check(`${id}'s own text reads as ${id}`, isShareable(r) && r.licences.join() === id, `${r.licences.join()} ${r.problems.join("; ")}`);
}
// Speed Dreams' own copy: the Free Software Foundation's old address, "Library" for "Lesser", another sample signature
const olderGpl = readFileSync(LICENCES["GPL-2.0-only"].textFile, "utf8")
  .replace("<https://fsf.org/>", "51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA")
  .replace(/Lesser General/g, "Library General")
  .replace(/Moe Ghoul/g, "Ty Coon");
check("an older copy of the GPL 2.0 text reads as the GPL 2.0, its wording no restriction", JSON.stringify(readLicenceText(olderGpl)) === JSON.stringify({ licences: ["GPL-2.0-only"], problems: [], holders: [] }), JSON.stringify(readLicenceText(olderGpl).problems));
const appended = `${readFileSync(LICENCES["CC-BY-4.0"].textFile, "utf8")}\n\nThe car's logos: all rights reserved.`;
check("a licence text with terms of the source's own added is read whole", !isShareable(readLicenceText(appended)));

console.log("\n== Authors");
check(
  "copyright holders: each name once, initials kept, the years and notes left out",
  copyrightHolders("Copyright © 2002 Eric Espie, Jean-Christophe Durieu\nCopyright � 2012 Bernhard Wymann (totally reworked)\nCopyright 2020 A. Modeller. All rights reserved.\nCopyright (C) 2011 by Vicente Marti").join("|") ===
    "Eric Espie|Jean-Christophe Durieu|Bernhard Wymann|A. Modeller|Vicente Marti",
  copyrightHolders("Copyright © 2002 Eric Espie, Jean-Christophe Durieu\nCopyright � 2012 Bernhard Wymann (totally reworked)\nCopyright 2020 A. Modeller. All rights reserved.\nCopyright (C) 2011 by Vicente Marti").join("|"),
);
check("a Latin-1 readme's © decodes, so its author is found", copyrightHolders(decodeText(Buffer.from("Copyright \xa9 2002 Eric Espie\n", "latin1"))).join() === "Eric Espie");
check("a UTF-16 readme (its byte-order mark) decodes", decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("CC BY 4.0", "utf16le")])) === "CC BY 4.0");
check("the official list's typos don't add a name twice", mergeNames(["Olaf Saßnick", "Eric Espie"], ["Olaf Sa'ick", "Andrew Sumner"]).join("|") === "Olaf Saßnick|Eric Espie|Andrew Sumner");
check("an author line holds 80 characters, cut at a name's end", authorLine(Array.from({ length: 12 }, (_, i) => `Author Number${i}`)).length <= 80 && authorLine(["A", "B"]) === "A, B");

console.log("\n== Statement files");
const tmp = mkdtempSync(join(tmpdir(), "licences-"));
try {
  const car = join(tmp, "ls2-cavallo-360r");
  mkdirSync(join(car, "licenses"), { recursive: true });
  const files: Record<string, string> = {
    "readme.txt": SD_FAL,
    "ls2-cavallo-360r-readme.txt": "Copyright 2010 Andrew Sumner\nFree Art License 1.3",
    CREDITS: "Thanks to everyone.",
    "AUTHORS.md": "Copyright 2006 Bernhard Wymann",
    "Cavallo_Roxfall_readme.txt": "Creative Commons license. You can freely modify, redistribute or use.",
    "ls2-cavallo-360r-red-stripe-readme.txt": "CC BY 4.0",
    "ls2-cavallo-360r-red-readme.txt": "CC BY-NC 4.0",
    "licenses/textures.txt": "Textures: CC0 1.0",
    "License.pdf": "%PDF-1.4",
    "notes.txt": "not a statement",
    "ls2-cavallo-360r.xml": "<params/>",
  };
  for (const [f, t] of Object.entries(files)) writeFileSync(join(car, f), t);
  writeFileSync(join(car, "latin1-readme.txt"), Buffer.from("Copyright \xa9 2015 Simon Sch\xe4ler\nFree Art License\n", "latin1"));
  const found = statementFiles(car);
  const names = found.map((s) => s.file);
  check(
    "readme, <car>-readme, CREDITS, AUTHORS, a licences folder and an unreadable PDF: all of them",
    ["readme.txt", "ls2-cavallo-360r-readme.txt", "CREDITS", "AUTHORS.md", "Cavallo_Roxfall_readme.txt", "licenses/textures.txt", "License.pdf"].every((f) => names.includes(f)) && !names.includes("notes.txt") && !names.includes("ls2-cavallo-360r.xml"),
    names.join(", "),
  );
  check("a PDF statement can't be read: a problem", !isShareable(found.find((s) => s.file === "License.pdf")!.reading));
  check("a Latin-1 statement is read with its ©", found.find((s) => s.file === "latin1-readme.txt")?.reading.holders.join() === "Simon Schäler");
  check("one problem in any file blocks sharing", !isShareable(mergeReadings(found.map((s) => s.reading))));

  const liveries = ["red", "red-stripe", "roxfall", "cavallo"];
  const parts = (f: string) => statementParts(f, "ls2-cavallo-360r", liveries).join();
  check("<car>-readme is the car's, not a livery's whose id is part of the car's", parts("ls2-cavallo-360r-readme.txt") === "" && parts("readme.txt") === "");
  check("<car>-<livery>-readme and <Livery>_readme name their livery", parts("ls2-cavallo-360r-roxfall-readme.txt") === "roxfall" && parts("Cavallo_Roxfall_readme.txt") === "roxfall");
  check('"red-stripe" is not "red", and "red" is not "red-stripe"', parts("ls2-cavallo-360r-red-stripe-readme.txt") === "red-stripe" && parts("ls2-cavallo-360r-red-readme.txt") === "red");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n== What a package carries");
const fal = readLicenceText(SD_FAL);
const shared = creditLicence(fal);
check("shareable: the licence's name and link, no note, its text", shared.license === "Free Art License 1.3" && shared.licenseUrl === LICENCES["FAL-1.3"].url && !shared.note && !shared.personal && licenceTextFiles(fal).map((f) => f.name).join() === "LICENSE-FAL-1.3.txt");
const nc = readLicenceText("CC BY-NC 4.0");
const personal = creditLicence(nc);
check(
  `not shareable: "unknown", no link, the note word for word, no licence text`,
  personal.license === "unknown" && !personal.licenseUrl && personal.note === PERSONAL_USE_NOTE && personal.personal && licenceTextFiles(nc).length === 0,
);
check("the note", PERSONAL_USE_NOTE === "For personal use only: the author's permission is needed to share it");

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll licence checks passed.");
