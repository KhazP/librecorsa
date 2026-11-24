/**
 * The Assetto Corsa circuit importer (scripts/mods/importers/ac-track.ts) and the entry it reads from a mod with no
 * hand-written one (scripts/tracks/ac_mod_entry.py, through `port_ac_track.py --entry-only`): made-up mods for
 * ui_track.json, layouts, models, surfaces, licences and overrides; then, for the mods this machine has
 * (scripts/tracks/sources.local.json), the entry read from each against its hand-written AC_TRACKS entry. The parts
 * that run Python are skipped without uv, the real mods' part without sources.local.json. Nothing is built here: an
 * import of a real mod takes minutes (docs/importing-mods.md).
 *
 *   npx tsx scripts/verify/verify-ac-track.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { circuitIdFrom, licenceNotice, packageVersion, type AutoEntry } from "../mods/importers/ac-track";
import { f1Settings, PERSONAL_USE_NOTE } from "../mods/importers/f1-track";
import { packageCredit, packageIdFrom } from "../mods/lib/manifest-file";
import { REPO_ROOT } from "../mods/lib/toolchain";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(84)} ${detail}`);
  if (!ok) failed++;
}
const skip = (name: string, why: string) => console.log(`SKIP  ${name.padEnd(84)} ${why}`);

/** The entry as port_ac_track.py writes it, with the porter's keys the checks read */
type Entry = AutoEntry & {
  country: string;
  city: string;
  pitboxes: number;
  baseAltitudeM: number;
  type?: string;
  pointToPoint?: boolean;
  markersKn5?: string;
  laneMinWidthM?: number;
  kn5_files: string[] | null;
  models_ini?: string | null;
  physicsNodeOverrides?: [string, string][];
  physicsOverridesFirst?: boolean;
  _auto: AutoEntry["_auto"] & { facts: { key: string; value: unknown; from: string }[]; models: string[] };
};

const tmp = mkdtempSync(join(tmpdir(), "ac-track-"));
const write = (path: string, data: string | Uint8Array) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
};

// --- The importer's own helpers (no Python) ---
check("a mod's version as a package's", packageVersion("v1.8.5") === "1.8.5" && packageVersion("3.23") === "3.23" && packageVersion(null) === undefined);
check("the circuit's id: its layout's folder, else the track folder", circuitIdFrom({ folder: "vir", layout_dir: "full course" }) === "full-course" && circuitIdFrom({ folder: "grobnik", layout_dir: "" }) === "grobnik");
check("a package id from the mod's author and name", packageIdFrom("Enver Bozkaya (SRTR), ACU & OSRW", "Intercity Istanbul Park") === "enver-bozkaya-sr.intercity-istanbul-park");
const personal = {
  name: "Test Ring",
  credit: { author: "J. Doe", license: "unknown", note: PERSONAL_USE_NOTE },
  _auto: { personalUse: true, licenceFrom: null, terms: ["Do not upload it."], gameCircuit: { id: "ring", author: "J. Doe" } },
} as unknown as AutoEntry;
const notice = licenceNotice(personal).join("\n");
check("a mod with no licence: the import says personal use only, with its readme's terms", /FOR PERSONAL USE ONLY/.test(notice) && /Do not upload it/.test(notice) && /hosts this circuit as "ring"/.test(notice));
check("its package credit carries the note", packageCredit(personal.credit).note === PERSONAL_USE_NOTE);
const f1 = f1Settings(
  { name: "Qiddiya Speed Park", credit: { author: "Maxim555", license: "Used with permission", note: "Used with permission." } },
  { layout: "Short", credit: { license: "CC BY-NC 4.0" } },
);
check("an F1 25 mod: the modder's settings over the extractor's", f1.name === "Qiddiya Speed Park" && f1.layout === "Short" && f1.credit?.author === "Maxim555");
check("an F1 25 mod is always for personal use, whatever its licence", f1.credit?.note === PERSONAL_USE_NOTE && f1.credit?.license === "CC BY-NC 4.0");
check("the game's permission for Qiddiya is never the package's licence", f1Settings({ credit: { author: "A", license: "Used with permission" } }, {}).credit?.license === "unknown");

// --- The entry read from made-up mods (Python) ---
const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });
const hasUv = !uv.error && uv.status === 0;

/** Runs port_ac_track.py <id> --entry-only on a mod folder: the entry, or the porter's message when it refuses */
function entryOf(id: string, args: string[]): { entry?: Entry; error: string } {
  const out = join(tmp, `${id}-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(
    "uv",
    ["run", "--python", "3.14", "--no-project", "--with-requirements", "scripts/tracks/requirements.txt", "python", "-P", "scripts/tracks/port_ac_track.py", id, ...args, "--entry-only", out],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (r.status !== 0 || !existsSync(out)) return { error: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() };
  return { entry: JSON.parse(readFileSync(out, "utf8")) as Entry, error: "" };
}
const guessed = (e: Entry, key: string) => e._auto.facts.some((f) => f.key === key && f.from.startsWith("guessed"));
const override = (e: Entry, key: string) => e.physicsNodeOverrides?.find(([rx]) => rx.includes(key))?.[1];

if (!hasUv) {
  skip("the entry read from a mod", "no uv on this machine (docs/PORTING-TRACKS.md)");
} else {
  // A street circuit with one layout, a ui_track.json as mods write them, its own surface keys and a readme's terms
  const ring = join(tmp, "testring");
  write(join(ring, "testring.kn5"), "sc6969");
  write(join(ring, "other.kn5"), "sc6969");
  write(join(ring, "ai", "fast_lane.ai"), "lane");
  write(
    join(ring, "data", "surfaces.ini"),
    `2.0
[SURFACE_0]
KEY=ROAD
FRICTION=0.99
IS_VALID_TRACK=1
[SURFACE_1]
KEY=SHLDR
FRICTION=0.94 ; paved shoulder
IS_VALID_TRACK=1
[SURFACE_2]
KEY=OFFTRACK
FRICTION=0.97
IS_VALID_TRACK=0
[SURFACE_3]
KEY=CARPET
FRICTION=0.72
IS_VALID_TRACK=1
WAV=extraturf.wav
[SURFACE_4]
KEY=PEN-GRS
FRICTION=0.6
IS_VALID_TRACK=0
WAV=grass.wav
[SURFACE_5]
KEY=BOX
FRICTION=0.95
IS_PITLANE=1
`,
  );
  write(
    join(ring, "ui", "ui_track.json"),
    `﻿{
	"name": "Test Ring",
	"description": "Test Ring",
	"tags" : ["circuit", "Street", "USA"],
	"country": "U.S.A.",
	"city": "Springfield",
	"length": "3.210 m",
	"pitboxes": "18",
	"run": "clockwise",
	"author": "J. Doe",
	"version": "v2.1",
	"url": "https://example.org/ring",
}`,
  );
  write(join(ring, "readme.txt"), "Test Ring v2.1\r\n\r\nPlease do not upload this track anywhere without my permission.\r\n");

  const { entry: r, error: rErr } = entryOf("autotest_ring", ["--src", ring]);
  check("a mod with one layout: its entry is read", !!r, rErr.slice(-300));
  if (r) {
    check("ui_track.json (a byte-order mark, a trailing comma): name, city, pitboxes", r.name === "Test Ring" && r.city === "Springfield" && r.pitboxes === 18);
    check("its country as the game's region filter knows it", r.country === "United States", r.country);
    check("its length, in metres, from \"3.210 m\"", r._auto.uiLengthM === 3210, String(r._auto.uiLengthM));
    check("tagged street: a street circuit", r.type === "street");
    check("no models INI: the folder's own model, as Assetto Corsa loads it", JSON.stringify(r.kn5_files) === '["testring.kn5"]', JSON.stringify(r.kn5_files));
    check("the layout name and the altitude are guessed, and say so", r.layout === "Full circuit" && guessed(r, "layout") && r.baseAltitudeM === 0 && guessed(r, "baseAltitudeM"));
    check("its own surface keys: a paved shoulder is road, OFFTRACK run-off", override(r, "SHLDR") === "road" && override(r, "OFFTRACK") === "runoff");
    check("... grass by its sound, a pit box by its flag", override(r, "PEN") === "grass" && override(r, "BOX") === "pit");
    check("... CARPET, a kerb by the shared names, is run-off by its own values, read first", override(r, "CARPET") === "runoff" && r.physicsOverridesFirst === true);
    check("ROAD, which the shared names know, gets no override", override(r, "ROAD") === undefined);
    check("the credit: its author, version and link", r.credit.author === "J. Doe" && r._auto.version === "v2.1" && r.credit.url === "https://example.org/ring");
    check("no licence named: unknown, personal use only, in the credit", r.credit.license === "unknown" && r._auto.personalUse && r.credit.note === PERSONAL_USE_NOTE);
    check("the readme's terms are kept, to print", r._auto.terms.some((t) => /do not upload/i.test(t)), JSON.stringify(r._auto.terms));
  }

  // Overrides merged over it: a licence the modder names is their record of the author's permission
  const overrides = join(tmp, "ring-overrides.json");
  write(overrides, JSON.stringify({ baseAltitudeM: 120, layout: "Grand Prix", credit: { license: "Used with permission" } }));
  const { entry: ro } = entryOf("autotest_ring", ["--src", ring, "--settings", overrides]);
  check("--settings: merged over the entry, the credit key by key", ro?.baseAltitudeM === 120 && ro.layout === "Grand Prix" && ro.credit.author === "J. Doe" && ro.credit.license === "Used with permission");
  check("... a licence in the settings lifts the personal-use note", !!ro && !ro._auto.personalUse && !ro.credit.note && ro._auto.licenceFrom === "settings");

  // Several layouts, models INI files, an open licence
  const park = join(tmp, "testpark");
  for (const f of ["testpark.kn5", "park_gp.kn5", "heli.kn5", "balloon.kn5"]) write(join(park, f), "sc6969");
  write(join(park, "gp", "ai", "fast_lane.ai"), "lane");
  write(join(park, "short", "ai", "fast_lane.ai"), "lane");
  write(join(park, "nolane", "data", "surfaces.ini"), "");
  write(
    join(park, "models_gp.ini"),
    "[MODEL_0]\nFILE=testpark.kn5\nPOSITION=0,0,0\nROTATION=0,0,0\n\n[MODEL_1]\nFILE=park_gp.kn5\n\n[MODEL_2]\nFILE=heli.kn5\nPOSITION=10,50,0\nROTATION=0,0,0\n\n" +
      "[MODEL_3]\nFILE=missing.kn5\n\n[DYNAMIC_OBJECT_0]\nFILE=balloon.kn5\nPOS_MODE=RANDOM\n",
  );
  write(join(park, "models_short.ini"), "[MODEL_0]\nFILE=testpark.kn5\n");
  write(join(park, "ui", "gp", "ui_track.json"), JSON.stringify({ name: "Test Park Grand Prix", country: "UK", city: "Somewhere", pitboxes: "30", length: "4.2km", tags: ["circuit"] }));
  write(join(park, "ui", "short", "ui_track.json"), JSON.stringify({ name: "Test Park Short Course", country: "UK", city: "Somewhere", pitboxes: "20", length: "1850" }));
  write(join(park, "LICENSE.txt"), "Test Park, made by A. Modder.\nThis track is licensed under CC BY-SA 4.0.\n");

  const several = entryOf("autotest_park", ["--src", park]);
  check("several layouts and none chosen: refused, with the layouts listed", !several.entry && /gp/.test(several.error) && /short/.test(several.error) && /Test Park Short Course/.test(several.error) && !/nolane/.test(several.error), several.error.split("\n").slice(-4).join(" | "));
  const { entry: gp, error: gpErr } = entryOf("autotest_park", ["--src", park, "--layout", "gp"]);
  check("--layout by folder: the words every layout's name starts with are the circuit's name", gp?.name === "Test Park" && gp.layout === "Grand Prix" && gp.layout_dir === "gp", gpErr.slice(-200));
  check("its models: the INI's, without a model it moves, a moving object or a missing file", JSON.stringify(gp?.kn5_files) === '["testpark.kn5","park_gp.kn5"]', JSON.stringify(gp?.kn5_files));
  check("... and says which it left out", !!gp && ["heli.kn5", "balloon.kn5", "missing.kn5"].every((f) => gp._auto.models.some((n) => n.startsWith(f))));
  check("its length from \"4.2km\", its country from \"UK\"", gp?._auto.uiLengthM === 4200 && gp.country === "United Kingdom");
  check("an open licence in the mod: shared under it, no personal-use note", gp?.credit.license === "CC BY-SA 4.0" && !gp._auto.personalUse && !gp.credit.note, gp?.credit.license ?? "");
  check("... and an author from the licence file, guessed", gp?.credit.author === "A. Modder" && guessed(gp, "credit.author"), gp?.credit.author ?? "");
  const { entry: short } = entryOf("autotest_park", ["--src", park, "--layout", "Test Park Short Course"]);
  check("--layout by its name in the game", short?.layout_dir === "short" && short.layout === "Short Course" && short.pitboxes === 20);
  const missing = entryOf("autotest_park", ["--src", park, "--layout", "reverse"]);
  check("a layout the mod hasn't got: refused, with the layouts listed", !missing.entry && /no layout "reverse"/.test(missing.error));

  // A models INI naming files outside the mod (an absolute path, '..', a link out of it): never read
  const outside = join(tmp, "outside.kn5");
  write(outside, "sc6969");
  const trav = join(tmp, "testtrav");
  for (const f of ["testtrav.kn5", join("sub", "ok.kn5"), join("extension", "heli.kn5")]) write(join(trav, f), "sc6969");
  write(join(trav, "ai", "fast_lane.ai"), "lane");
  symlinkSync(outside, join(trav, "linked.kn5"));
  const named = ["../outside.kn5", outside, "sub/../../outside.kn5", "linked.kn5", "testtrav.kn5", "./extension/heli.kn5", ".\\sub\\ok.kn5"];
  write(join(trav, "models.ini"), named.map((f, i) => `[MODEL_${i}]\nFILE=${f}\n`).join("\n"));
  const { entry: tr, error: trErr } = entryOf("autotest_trav", ["--src", trav]);
  check("a models INI's files outside the track folder are left out, and said", JSON.stringify(tr?.kn5_files) === '["testtrav.kn5","sub/ok.kn5"]' && named.slice(0, 4).every((f) => tr?._auto.models.includes(`${f}: outside the track folder, left out`)), JSON.stringify(tr?.kn5_files) + trErr.slice(-200));
  check("... and ./extension/ is Custom Shaders Patch's, however it is written", !!tr?._auto.models.some((n) => /^extension\/heli\.kn5: animated/.test(n)));
  const porter = spawnSync(
    "uv",
    ["run", "--python", "3.14", "--no-project", "--with-requirements", "scripts/tracks/requirements.txt", "python", "-P", "-c",
      "import json, sys; sys.path.insert(0, 'scripts/tracks'); import port_ac_track as p; print(json.dumps(p.get_kn5_list({'base_dir': sys.argv[1], 'models_ini': 'models.ini'})))", trav],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  check("a hand-written entry's models INI: the folder's own models alone", porter.stdout.trim().split("\n").at(-1) === '["testtrav.kn5", "extension/heli.kn5", "sub/ok.kn5"]', porter.stdout.trim().split("\n").at(-1) ?? porter.stderr.slice(-200));

  // NoDerivatives: a conversion is an adaptation, so it can't be shared
  write(join(park, "LICENSE.txt"), "Licensed CC BY-NC-ND 4.0.\n");
  const { entry: nd } = entryOf("autotest_park", ["--src", park, "--layout", "gp"]);
  check("a NoDerivatives licence: personal use only", !!nd && nd._auto.personalUse && nd.credit.license === "unknown");

  // A hill climb: its start and finish gates
  const hill = join(tmp, "testhill");
  write(join(hill, "testhill.kn5"), "sc6969");
  write(join(hill, "AC.kn5"), "sc6969 ... AC_AB_START_L ... AC_AB_FINISH_L ...");
  write(join(hill, "ai", "fast_lane.ai"), "lane");
  write(join(hill, "ui", "ui_track.json"), JSON.stringify({ name: "Test Hill", tags: ["A2B", "Hillclimb"], run: "Hill Climb" }));
  const { entry: hc } = entryOf("autotest_hill", ["--src", hill]);
  check("tagged a hill climb: one run between the gates of the model that has them", hc?.type === "hillclimb" && hc.pointToPoint === true && hc.markersKn5 === "AC.kn5" && hc.laneMinWidthM === 3);

  // Not a track folder
  const empty = join(tmp, "notatrack");
  write(join(empty, "readme.txt"), "nothing here");
  check("a folder without an AI lane: refused, saying what it needs", /fast_lane\.ai/.test(entryOf("autotest_none", ["--src", empty]).error));
  check("an id the game uses: refused", /taken|game/.test(entryOf("rwanda_official", ["--src", ring]).error));

  // Kunos's own circuits, and mods made of them: refused before anything is read or built
  const kunosMod = (folder: string, files: Record<string, string>, ui: Record<string, string> = {}) => {
    const dir = join(tmp, "kunos", folder);
    write(join(dir, "ai", "fast_lane.ai"), "lane");
    write(join(dir, "ui", "ui_track.json"), JSON.stringify({ name: "A Circuit", ...ui }));
    for (const [f, data] of Object.entries(files)) write(join(dir, f), data);
    return entryOf("autotest_kunos", ["--src", dir]);
  };
  const refusedAs = (r: { entry?: Entry; error: string }, why: RegExp) => !r.entry && /refused: /.test(r.error) && why.test(r.error);
  const ksFolder = kunosMod("ks_test_circuit", { "ks_test_circuit.kn5": "sc6969" });
  check('a "ks_" circuit is refused', refusedAs(ksFolder, /"ks_test_circuit" is one of Kunos's own circuits/), ksFolder.error.split("\n").at(-1));
  const baseGame = kunosMod("imola", { "imola.kn5": "sc6969" });
  check("one of the base game's circuits is refused", refusedAs(baseGame, /base game's own circuits/), baseGame.error.split("\n").at(-1));
  const ksModel = kunosMod("my_circuit", { "my_circuit.kn5": "sc6969", "ks_props.kn5": "sc6969" });
  check('a renamed mod holding a "ks_" model is refused', refusedAs(ksModel, /"ks_props\.kn5" is one of Kunos's own/), ksModel.error.split("\n").at(-1));
  const byKunos = kunosMod("my_circuit2", { "my_circuit2.kn5": "sc6969" }, { author: "Kunos Simulazioni", url: "https://www.assettocorsa.net" });
  check("a ui_track.json naming Kunos is refused", refusedAs(byKunos, /names Kunos/), byKunos.error.split("\n").at(-1));
  const encrypted = kunosMod("my_circuit3", { "my_circuit3.kn5": "ENCRYPTEDxxxx" });
  check("an encrypted model is refused", refusedAs(encrypted, /"my_circuit3\.kn5" is encrypted/), encrypted.error.split("\n").at(-1));
  const modders = kunosMod("my_circuit4", { "my_circuit4.kn5": "sc6969" }, { author: "J. Doe" });
  check("a modder's circuit is not Kunos's", !!modders.entry, modders.error.slice(-200));
  check("no country or city in ui_track.json: \"Unknown\", guessed, and left out of the description", modders.entry?.country === "Unknown" && modders.entry.city === "Unknown" && guessed(modders.entry, "country") && guessed(modders.entry, "city") && !/Unknown/.test(modders.entry.description ?? ""), `${modders.entry?.country}/${modders.entry?.city}: ${modders.entry?.description}`);

  // --- The mods on this machine, against their hand-written entries ---
  const sourcesPath = join(REPO_ROOT, "scripts", "tracks", "sources.local.json");
  const sources = existsSync(sourcesPath) ? (JSON.parse(readFileSync(sourcesPath, "utf8")) as Record<string, string>) : {};
  // Hand-written ids by their folder in sources.local.json: the first two whose folders are here
  const candidates = ["oschersleben", "grobnik", "barbagallo", "chang", "norisring", "vir", "istanbul_park"];
  let compared = 0;
  for (const id of candidates) {
    if (compared >= 2) break;
    const hand = entryOf(id, []).entry;
    const folder = hand && (sources[id] ?? sources[hand.folder]);
    if (!hand || !folder || !existsSync(folder)) continue;
    compared++;
    const { entry: auto, error } = entryOf(`autotest_${id}`, ["--src", folder, ...(hand.layout_dir ? ["--layout", hand.layout_dir] : [])]);
    check(`${id}: the entry read from the mod`, !!auto, error.slice(-200));
    if (!auto) continue;
    const handModels = hand.kn5_files ?? [];
    check(`${id}: the hand-written models are among the ones read from the mod`, handModels.every((f) => auto.kn5_files?.includes(f)), `${handModels.join(",")} | ${auto.kn5_files?.join(",")}`);
    check(`${id}: the same country and pitboxes`, auto.country === hand.country && auto.pitboxes === hand.pitboxes, `${auto.country}/${auto.pitboxes} vs ${hand.country}/${hand.pitboxes}`);
    // Not checked, said: each of the mod's own surface keys as read, against the hand-written override for a mesh
    // named after it (none: the shared names read it), and the names, which a modder may want to override
    const keyOf = (rx: string) => rx.replace(/^\^\\d\+_\?/, "").replace(/\\(.)/g, "$1");
    const handSays = (node: string) => hand.physicsNodeOverrides?.find(([rx]) => new RegExp(rx, "i").test(node))?.[1];
    const surfaces = (auto.physicsNodeOverrides ?? [])
      .slice(0, -1)
      .map(([rx, c]) => {
        const h = handSays(`1${keyOf(rx)}`);
        return `${keyOf(rx)} ${c}${h === c ? "" : ` (hand-written: ${h ?? "the shared names"})`}`;
      });
    console.log(`      ${id}: surfaces ${surfaces.join(", ") || "(none of its own)"}`);
    console.log(`      ${id}: "${auto.name}, ${auto.layout}" (hand-written "${hand.name}, ${hand.layout}"), ${auto.city} (hand-written ${hand.city})`);
  }
  if (!compared) skip("the entry read from a real mod, against its hand-written one", "no mod of a hand-written circuit in scripts/tracks/sources.local.json");
}

rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Assetto Corsa circuit import checks passed.");
