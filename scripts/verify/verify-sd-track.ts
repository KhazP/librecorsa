/**
 * The Speed Dreams circuit importer (scripts/mods/importers/sd-track.ts, scripts/tracks/extract_sd_track.py):
 *
 * - geometry, from a synthetic trackdef: two 200 m straights and two 180° left turns of 50 m radius, with banking, a
 *   grade, a raised kerb, sides of grass, sand and a pit lane, a wall and a fence; its lap, the loader's offset, the
 *   centreline, start line and pit lane, the banking and kerb in the GLB, and a small AC3D model whose road object is
 *   left out and whose scenery is kept where it stands;
 * - surface mapping: Speed Dreams' surface names and a circuit's own surfaces by their grip, to the builder's;
 * - the licence gate: every statement file and the trackdef's header read, the asset database's word only for a copy
 *   fetched at the archive it pins, refusals, and --personal;
 * - with Speed Dreams circuits in the cache (`npm run mod -- import sd-track --fetch <circuit>`), each one: its road
 *   generated where the circuit's own model has it, and its licence.
 *
 * The geometry checks run the Python extractor through uv and are skipped without it; the real circuits are skipped when
 * the cache has none.
 *
 *   npx tsx scripts/verify/verify-sd-track.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogue, circuitLicence, SD_CACHE, trackdefOf, type CircuitSource } from "../mods/importers/sd-track";
import { PERSONAL_USE_NOTE } from "../mods/lib/licences";
import { REPO_ROOT } from "../mods/lib/toolchain";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(84)} ${detail}`);
  if (!ok) failed++;
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const tmp = mkdtempSync(join(tmpdir(), "sd-track-"));

// --- The licence gate (the reader itself: verify-licences.ts) ---------------------------------------------------------

const FAL_README = `Brno
------------------------------------------------------------------------------------
Copyright © 2015 Simon Schäler

Copyleft: this work of art is free, you can redistribute
it and/or modify it according to terms of the Free Art license.
You will find a specimen of this license on the site
Copyleft Attitude http://artlibre.org as well as on other sites.
`;
const GPL_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!--
copyright           : (C) 2005 by Charalampos Alexopoulos
-->
<!--
This program is free software; you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
-->
<params name="x" type="param" mode="mw"/>
`;
const folder = (name: string, files: Record<string, string>) => {
  const dir = join(tmp, "lic", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
};
const refusal = (f: () => unknown): string => {
  try {
    f();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
};
const withReadme = folder("brno", { "readme.txt": FAL_README, "brno.xml": "<params/>" });
const ok = circuitLicence(withReadme, { title: "Brno", source: null, personal: false });
check("a circuit with a FAL readme is credited to its author under the FAL", ok.credit.license === "Free Art License 1.3" && ok.credit.author === "Simon Schäler" && ok.credit.licenseUrl === "https://artlibre.org/licence/lal/en/", JSON.stringify(ok.credit));
check("its package carries the readme and the licence's text (LICENSE-<id>.txt)", ok.files.map((f) => f.name).join() === "speed-dreams-readme.txt,LICENSE-FAL-1.3.txt" && ok.files.every((f) => existsSync(f.from)), ok.files.map((f) => f.name).join());
const withHeader = folder("brno-gpl", { "readme.txt": FAL_README, "brno-gpl.xml": GPL_HEADER });
const both = circuitLicence(withHeader, { title: "Brno", source: null, personal: false, trackdef: join(withHeader, "brno-gpl.xml") });
check("the trackdef's GPL header: the data's licence, and its text, beside the FAL", both.credit.license === "Free Art License 1.3, GNU GPL 2.0 or later" && both.files.map((f) => f.name).join() === "speed-dreams-readme.txt,LICENSE-FAL-1.3.txt,LICENSE-GPL-2.0-or-later.txt", both.credit.license ?? "");
const restrictedHeader = folder("hdr", { "readme.txt": FAL_README, "hdr.xml": GPL_HEADER.replace("(at your option) any later version.", "(at your option) any later version. Do not redistribute the logos.") });
check("a restriction in the trackdef's header is refused", /forbids/.test(refusal(() => circuitLicence(restrictedHeader, { title: "Hdr", source: null, personal: false, trackdef: join(restrictedHeader, "hdr.xml") }))));
const twoFiles = folder("two", { "LICENSE.txt": "Free Art License 1.3", "README.txt": "Copyright 2019 J. Doe. All Rights Reserved." });
check("every statement file is read: a FAL LICENSE beside an all-rights-reserved README is refused", /rights reserved/.test(refusal(() => circuitLicence(twoFiles, { title: "Two", source: null, personal: false }))));
const bare = folder("corkscrew", { "corkscrew.xml": "<params/>" });
const refused = refusal(() => circuitLicence(bare, { title: "Corkscrew", source: null, personal: false }));
check("a circuit with no licence statement is refused, with a message that says so", /no readme or licence file/.test(refused) && /--personal/.test(refused), refused.split("\n")[0]);

// The asset database's word: only for a copy fetched at the archive it pins
const pinned = catalogue().find((e) => e.directory === "e-track-4")!;
const fetched = (over: Partial<CircuitSource> = {}): CircuitSource => ({ from: "asset-database", directory: pinned.directory, archive: pinned.archive, sha256: pinned.sha256, revision: pinned.revision, page: pinned.page, license: pinned.license, author: pinned.author, ...over });
const eTrack = folder("e-track-4", { "e-track-4.xml": "<params/>" });
const viaDb = circuitLicence(eTrack, { title: "E-Track 4", source: fetched(), personal: false });
check("a fetched circuit without a readme takes the pinned database's licence and authors", viaDb.credit.license === "Free Art License 1.3" && viaDb.credit.author === pinned.author && /asset database/.test(viaDb.summary), viaDb.summary);
check("…not when its record doesn't match the pin (another archive)", /no readme or licence file/.test(refusal(() => circuitLicence(eTrack, { title: "E-Track 4", source: fetched({ sha256: "0".repeat(64) }), personal: false }))));
check("…nor its record's own licence and author, which the pin's replace", circuitLicence(eTrack, { title: "E", source: fetched({ license: "CC0 1.0", author: "Someone Else" }), personal: false }).credit.author === pinned.author);
check("…nor a local folder of that name with no record", /no readme or licence file/.test(refusal(() => circuitLicence(eTrack, { title: "E-Track 4", source: null, personal: false }))));
const renamed = folder("my-copy", { "my-copy.xml": "<params/>" });
check("…nor a fetched record moved to a folder of another name", /no readme or licence file/.test(refusal(() => circuitLicence(renamed, { title: "X", source: fetched(), personal: false }))));
const ownStatement = folder("e-track-4", { "e-track-4.xml": "<params/>", "readme.txt": "Have fun!" });
check("…nor when the folder has a statement file of its own, whatever it says", /names no licence/.test(refusal(() => circuitLicence(ownStatement, { title: "E", source: fetched(), personal: false }))));
const cork = catalogue().find((e) => e.directory === "corkscrew")!;
check("…nor when the database names no author for it (Corkscrew)", /names no author/.test(refusal(() => circuitLicence(bare, { title: "Corkscrew", source: { from: "asset-database", directory: "corkscrew", archive: cork.archive, sha256: cork.sha256, page: cork.page }, personal: false }))));

const personal = circuitLicence(folder("nc", { "readme.txt": "Licensed CC BY-NC 4.0 by A. Person" }), { title: "NC", source: null, personal: true });
check(
  `--personal: "unknown", the note word for word, no licence text or link`,
  personal.personal && personal.credit.license === "unknown" && personal.credit.note === PERSONAL_USE_NOTE && !personal.credit.licenseUrl && !personal.files.some((f) => /^LICEN[CS]E-/.test(f.name)),
  JSON.stringify(personal.credit),
);
check("…and the circuit's own readme still in it, for its credit", personal.files.map((f) => f.name).join() === "speed-dreams-readme.txt");

// --- Geometry and surfaces, from a synthetic circuit ------------------------------------------------------------------

const TRACK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE params SYSTEM "../../../src/libs/tgf/params.dtd" [
<!ENTITY default-surfaces SYSTEM "../../../data/tracks/surfaces.xml">
]>
<params name="oval" type="param" mode="mw">
  <section name="Surfaces">&default-surfaces;
    <section name="test-road"><attnum name="friction" val="1.2"/><attstr name="texture name" val="road.png"/><attnum name="texture size" unit="m" val="10"/></section>
    <section name="curb-5cm-l"><attnum name="friction" val="1.1"/></section>
    <section name="grass"><attnum name="friction" val="0.4"/><attnum name="rolling resistance" val="0.08"/></section>
    <section name="sand"><attnum name="friction" val="0.6"/><attnum name="rolling resistance" val="0.12"/></section>
    <section name="asphalt-pits"><attnum name="friction" val="1.2"/></section>
    <section name="b-road1-grass6-l2"><attnum name="friction" val="0.7"/><attnum name="rolling resistance" val="0.03"/></section>
    <section name="b-asphalt-grass6-l1"><attnum name="friction" val="0.8"/><attnum name="rolling resistance" val="0.05"/></section>
    <section name="xyz-grippy"><attnum name="friction" val="1.1"/><attnum name="rolling resistance" val="0.01"/></section>
    <section name="xyz-slow"><attnum name="friction" val="0.4"/><attnum name="rolling resistance" val="0.05"/></section>
    <section name="xyz-trap"><attnum name="friction" val="0.6"/><attnum name="rolling resistance" val="0.15"/></section>
  </section>
  <section name="Header">
    <attstr name="name" val="Test Oval"/><attstr name="category" val="road"/><attnum name="version" val="4"/>
    <attstr name="author" val="J. Doe"/><attstr name="description" val="Two straights and two hairpins"/>
  </section>
  <section name="Local Info"><attnum name="altitude" unit="m" val="250"/><attstr name="station" val="LFLL"/></section>
  <section name="Graphic"><attstr name="3d description" val="oval.ac"/></section>
  <section name="Main Track">
    <attnum name="width" unit="m" val="12"/>
    <attnum name="profil steps length" unit="m" val="4"/>
    <attstr name="surface" val="test-road"/>
    <section name="Right Side"><attnum name="width" unit="m" val="5"/><attstr name="surface" val="sand"/></section>
    <section name="Left Side"><attnum name="width" unit="m" val="5"/><attstr name="surface" val="grass"/></section>
    <section name="Right Border"><attnum name="width" unit="m" val="1"/><attstr name="surface" val="b-road1-grass6-l2"/><attstr name="style" val="plan"/></section>
    <section name="Left Border"><attnum name="width" unit="m" val="1"/><attnum name="height" unit="m" val="0.05"/><attstr name="surface" val="curb-5cm-l"/><attstr name="style" val="curb"/></section>
    <section name="Right Barrier"><attnum name="width" unit="m" val="0.5"/><attnum name="height" unit="m" val="1"/><attstr name="surface" val="barrier"/><attstr name="style" val="wall"/></section>
    <section name="Left Barrier"><attnum name="height" unit="m" val="1"/><attstr name="style" val="fence"/></section>
    <section name="Pits">
      <attstr name="side" val="right"/><attstr name="entry" val="front"/><attstr name="start" val="front"/>
      <attstr name="end" val="front"/><attstr name="exit" val="front"/>
      <attnum name="length" unit="m" val="10"/><attnum name="width" unit="m" val="4"/>
    </section>
    <section name="Track Segments">
      <section name="front">
        <attstr name="type" val="str"/><attnum name="lg" unit="m" val="200"/><attnum name="z start" unit="m" val="10"/><attnum name="z end" unit="m" val="10"/>
        <section name="Right Side"><attnum name="width" unit="m" val="12"/><attstr name="surface" val="asphalt-pits"/></section>
      </section>
      <section name="turn 1">
        <attstr name="type" val="lft"/><attnum name="arc" unit="deg" val="180"/><attnum name="radius" unit="m" val="50"/>
        <attnum name="banking start" unit="deg" val="5"/><attnum name="banking end" unit="deg" val="5"/>
        <section name="Right Side"><attnum name="width" unit="m" val="5"/><attstr name="surface" val="sand"/></section>
      </section>
      <section name="back">
        <attstr name="type" val="str"/><attnum name="lg" unit="m" val="200"/><attnum name="grade" unit="%" val="5"/>
        <attnum name="banking start" unit="deg" val="0"/><attnum name="banking end" unit="deg" val="0"/>
      </section>
      <section name="turn 2">
        <attstr name="type" val="lft"/><attnum name="arc" unit="deg" val="180"/><attnum name="radius" unit="m" val="50"/><attnum name="z end" unit="m" val="10"/>
      </section>
    </section>
  </section>
</params>
`;
// The loader puts its smallest x, y and z at 0. Here: x at the outside of turn 2 (its centre is at x 0, its right
// edge 56 m out, then a 1 m border and the 5 m side), y at the outside of the front straight (the 1 m border and the
// 12 m pit side), z at 0 (the loader starts its bounds there). trackgen writes the model in those coordinates as
// (x, z, -y), so the front straight's road lies from (62, 10, -13) to (262, 10, -25).
const AC_MODEL = `AC3Db
MATERIAL "" rgb 1 1 1  amb 0.2 0.2 0.2  emis 0 0 0  spec 0 0 0  shi 0  trans 0
MATERIAL "green" rgb 0.1 0.6 0.1  amb 0.2 0.2 0.2  emis 0 0 0  spec 0 0 0  shi 0  trans 0
OBJECT world
kids 2
OBJECT group
name "TKMN0"
kids 1
OBJECT poly
name "tkMn0"
numvert 4
62 10 -13
262 10 -13
262 10 -25
62 10 -25
numsurf 1
SURF 0x10
mat 0
refs 4
0 0 0
1 1 0
2 1 1
3 0 1
kids 0
OBJECT poly
name "tree"
loc 100 0 -100
numvert 3
0 0 0
1 0 0
0 5 0
numsurf 1
SURF 0x20
mat 1
refs 3
0 0 0
1 1 0
2 0 1
kids 0
`;

/** A GLB's JSON, and its float or index accessors */
function readGlb(path: string) {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8")) as {
    nodes: { name?: string; mesh?: number; matrix?: number[] }[];
    meshes: { name: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
    accessors: { bufferView: number; count: number; type: string; componentType: number; min?: number[]; max?: number[] }[];
    bufferViews: { byteOffset?: number; byteLength: number }[];
  };
  const bin = buf.subarray(20 + jsonLen + 8);
  const acc = (i: number): number[][] => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type] ?? 1;
    const arr = a.componentType === 5126 ? new Float32Array(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0), a.count * n) : new Uint32Array(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0), a.count * n);
    return Array.from({ length: a.count }, (_, k) => Array.from(arr.subarray(k * n, k * n + n)));
  };
  const meshNode = (re: RegExp) => json.nodes.filter((n) => n.mesh !== undefined && re.test(n.name ?? ""));
  const positions = (re: RegExp) => meshNode(re).flatMap((n) => acc(json.meshes[n.mesh!].primitives[0].attributes.POSITION));
  return { json, acc, meshNode, positions };
}

function python(args: string[]): { ok: boolean; out: string } | null {
  const r = spawnSync("uv", ["run", "-q", "--python", "3.14", "--no-project", "--with-requirements", "scripts/tracks/requirements.txt", "python", "-P", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.error) return null;
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

const oval = join(tmp, "oval");
mkdirSync(oval, { recursive: true });
writeFileSync(join(oval, "oval.xml"), TRACK_XML);
writeFileSync(join(oval, "oval.ac"), AC_MODEL);
const ran = python(["scripts/tracks/extract_sd_track.py", oval, "--out-glb", join(tmp, "oval.glb"), "--out-settings", join(tmp, "oval.json"), "--geometry-json", join(tmp, "oval.geom.json")]);
if (!ran) {
  console.log("SKIP  the extractor's checks: uv is not installed (docs/PORTING-TRACKS.md, What you need)");
} else {
  check("the extractor converts the synthetic circuit", ran.ok, ran.ok ? "" : ran.out.slice(-1500));
  if (ran.ok) {
    const g = JSON.parse(readFileSync(join(tmp, "oval.geom.json"), "utf8")) as {
      lengthM: number;
      closureM: number;
      offset: number[];
      centreline: number[][];
      start: number[];
      forward: number[];
      roles: Record<string, string>;
      pits: { side: number; boxes: number };
      pitLane: number[][];
      settings: Record<string, unknown>;
      acRoadOffsetM: { median: number; p95: number };
      scenery: { objects: number; dropped: number };
    };
    const lap = 400 + 2 * Math.PI * 50;
    check("the lap is the segments' length: 2 × 200 m + 2 × π × 50 m", near(g.lengthM, lap, 1e-6), `${g.lengthM.toFixed(6)} m`);
    check("the lap closes on itself", g.closureM < 1e-3, `${(g.closureM * 1000).toFixed(3)} mm`);
    check("coordinates move as the loader's do: smallest x, y and z to 0", near(g.offset[0], -62, 1e-6) && near(g.offset[1], -13, 1e-6) && near(g.offset[2], 0, 1e-9), g.offset.map((v) => v.toFixed(3)).join(", "));
    const c = g.centreline;
    let poly = 0;
    for (let i = 0; i < c.length; i++) poly += Math.hypot(...[0, 1, 2].map((k) => c[(i + 1) % c.length][k] - c[i][k]));
    check("the centreline runs the lap", near(poly, lap, 1.0), `${poly.toFixed(2)} m of ${lap.toFixed(2)}`);
    const ys = c.map((p) => p[1]);
    check("elevation: the front straight at z 10, the back straight's 5% grade up to 20", near(Math.min(...ys), 10, 1e-6) && near(Math.max(...ys), 20, 0.01), `${Math.min(...ys).toFixed(3)}..${Math.max(...ys).toFixed(3)} m`);
    check("the start line is where the first segment begins, mid-road, facing along it", near(g.start[0], 62, 1e-6) && near(g.start[1], 10, 1e-6) && near(g.start[2], -19, 1e-6) && near(g.forward[0], 1, 1e-9), g.start.map((v) => v.toFixed(2)).join(", "));
    const expectRoles: Record<string, string> = { "test-road": "Road", "curb-5cm-l": "Kerb", grass: "Grass", sand: "Gravel", "asphalt-pits": "PitLane", "b-road1-grass6-l2": "Grass", barrier: "Wall" };
    const wrong = Object.entries(expectRoles).filter(([s, r]) => g.roles[s] !== r);
    check("surfaces map to the builder's: road, curb → Kerb, grass, sand → Gravel, pits → PitLane, barrier → Wall", !wrong.length, wrong.map(([s]) => `${s}: ${g.roles[s]}`).join(", "));
    check("pits on the right, 20 boxes of 10 m along the 200 m straight", g.pits.side === 0 && g.pits.boxes === 20, JSON.stringify(g.pits));
    const lane = g.pitLane ?? [];
    check("the pit lane runs down the pit side, 5 m off the road (border 1 m + half of the 8 m before the boxes)", lane.length >= 4 && lane.every((p) => near(p[2], -8, 0.01) && p[0] >= 62 - 1e-6 && p[0] <= 262 + 1e-6), `${lane.length} points`);
    const s = g.settings;
    check("settings: name, country by the weather station, a city (a package needs one), altitude, pit boxes, author", s.name === "Test Oval" && s.country === "France" && s.city === "Speed Dreams" && s.baseAltitudeM === 250 && s.pitboxes === 20 && (s.credit as { author: string }).author === "J. Doe");
    const needs = python(["scripts/tracks/extract_sd_track.py", oval, "--out-glb", join(tmp, "x.glb"), "--out-settings", join(tmp, "x.json"), "--needs-json", join(tmp, "needs.json")]);
    const needed = needs?.ok ? (JSON.parse(readFileSync(join(tmp, "needs.json"), "utf8")) as { textures: string[] }).textures : null;
    check("--needs-json lists the textures the circuit's folder lacks, and writes nothing else", needed?.join() === "road.png" && !existsSync(join(tmp, "x.glb")), JSON.stringify(needed));
    check("the model's road object is left out and lies on the generated road", g.scenery.dropped === 1 && g.acRoadOffsetM.median < 0.005, `median ${g.acRoadOffsetM.median.toFixed(4)} m`);

    const glb = readGlb(join(tmp, "oval.glb"));
    const SURFACE = /^(road|kerb|runoff|gravel|grass|wall|pitlane)(?=$|[._\- 0-9])/i;
    const odd = glb.json.nodes.filter((n) => n.mesh !== undefined && !SURFACE.test(n.name ?? "") && !/^Scenery_/.test(n.name ?? "") && !/^Track_/.test(n.name ?? ""));
    check("every mesh is a surface the builder reads, scenery, or one of its helpers", !odd.length, odd.map((n) => n.name).join(", "));
    const line = (name: string) => {
      const n = glb.json.nodes.find((x) => x.name === name);
      const p = n?.mesh !== undefined ? glb.json.meshes[n.mesh].primitives[0] : undefined;
      return p && p.mode === 1 ? { points: glb.acc(p.attributes.POSITION).length, edges: glb.acc(p.indices!).length / 2 } : null;
    };
    const cl = line("Track_Centreline");
    const pl = line("Track_PitLane");
    check("Track_Centreline is a closed loop of loose edges, Track_PitLane an open one", !!cl && cl.edges === cl.points && !!pl && pl.edges === pl.points - 1);
    const start = glb.json.nodes.find((n) => n.name === "Track_Start");
    check("Track_Start's local Y points the way the cars go", !!start?.matrix && near(start.matrix[4], 1, 1e-6) && near(start.matrix[6], 0, 1e-6));
    // Turn 1 is banked 5°, its middle 10 m up: the road's right edge (outside, at x 256 m from the turn's centre) and
    // its left edge differ by 12 m × tan 5°
    const road = glb.positions(/^Road_/);
    const nearest = (x: number, z: number) => road.reduce((b, p) => (Math.hypot(p[0] - x, p[2] - z) < Math.hypot(b[0] - x, b[2] - z) ? p : b));
    const outside = nearest(256 + 62, -(56 + 13));
    const inside = nearest(244 + 62, -(56 + 13));
    check("turn 1's banking: the edges 12 m × tan 5° apart in height", near(inside[1] - outside[1], 12 * Math.tan((5 * Math.PI) / 180), 0.002), `${(inside[1] - outside[1]).toFixed(4)} m`);
    // the front straight's left kerb: 1 m beyond its left edge (z -25), 10 m up
    const kerbTop = Math.max(...glb.positions(/^Kerb_/).filter((p) => p[0] > 70 && p[0] < 250 && p[2] < -25 && p[2] > -26.5).map((p) => p[1]));
    check("the curb rises 5 cm to its outer edge", near(kerbTop, 10.05, 1e-4), `${kerbTop.toFixed(4)} m`);
    const wall = glb.positions(/^Wall_/).filter((p) => p[0] > 70 && p[0] < 250 && p[2] > -1);
    check("the right barrier: a 1 m wall, 0.5 m thick, at the pit side's outer edge", wall.length > 0 && near(Math.max(...wall.map((p) => p[1])), 11, 1e-4) && near(Math.min(...wall.map((p) => p[2])), 0, 1e-4) && near(Math.max(...wall.map((p) => p[2])), 0.5, 1e-4));
    const tree = glb.positions(/^Scenery_\d/);
    check("the model's scenery is kept where it stands (its loc applied)", tree.length === 3 && near(Math.min(...tree.map((p) => p[0])), 100, 1e-5) && near(Math.max(...tree.map((p) => p[1])), 5, 1e-5) && near(tree[0][2], -100, 1e-5));
  }

  // --- Speed Dreams' own circuits, when the cache has them ----------------------------------------------------------
  const circuitsDir = join(SD_CACHE, "circuits");
  const cached = existsSync(circuitsDir) ? readdirSync(circuitsDir).filter((d) => existsSync(join(circuitsDir, d, ".source.json"))) : [];
  const baseDir = join(SD_CACHE, "speed-dreams-data", "data");
  if (!cached.length) console.log("SKIP  Speed Dreams' own circuits: none in scripts/mods/.cache/speed-dreams (npm run mod -- import sd-track --fetch <circuit>)");
  for (const d of cached) {
    const dir = join(circuitsDir, d);
    const source = JSON.parse(readFileSync(join(dir, ".source.json"), "utf8")) as CircuitSource;
    const out = join(tmp, d);
    const r = python(["scripts/tracks/extract_sd_track.py", dir, "--out-glb", `${out}.glb`, "--out-settings", `${out}.json`, "--geometry-json", `${out}.geom.json`, ...(existsSync(baseDir) ? ["--sd-data", baseDir] : [])])!;
    check(`${d}: converts`, r.ok, r.ok ? "" : r.out.slice(-800));
    if (!r.ok) continue;
    const g = JSON.parse(readFileSync(`${out}.geom.json`, "utf8")) as { lengthM: number; closureM: number; acRoadOffsetM?: { median: number; p95: number }; scenery?: { triangles: number } };
    check(`${d}: a closed lap`, g.lengthM > 500 && g.closureM < 0.5, `${g.lengthM.toFixed(1)} m, closes within ${(g.closureM * 100).toFixed(1)} cm`);
    check(`${d}: the generated road lies where the circuit's own model has it`, !!g.acRoadOffsetM && g.acRoadOffsetM.median < 0.05 && g.acRoadOffsetM.p95 < 0.25, g.acRoadOffsetM ? `median ${(g.acRoadOffsetM.median * 1000).toFixed(1)} mm, 95% ${(g.acRoadOffsetM.p95 * 1000).toFixed(1)} mm` : "no road in the model");
    check(`${d}: its scenery is kept`, (g.scenery?.triangles ?? 0) > 0, `${g.scenery?.triangles ?? 0} triangles`);
    let lic = "";
    try {
      lic = circuitLicence(dir, { title: d, source, personal: false, trackdef: trackdefOf(dir) }).summary;
    } catch (err) {
      lic = `refused: ${(err as Error).message.split("\n")[0]}`;
    }
    console.log(`INFO  ${d}: licence ${lic}`);
    // Speed Dreams' own circuits under the Free Art License stay shareable; Corkscrew has no readme and no author listed
    if (d === "corkscrew") check(`${d}: refused, no statement and no author listed`, lic.startsWith("refused"), lic);
    else if (existsSync(join(dir, "readme.txt"))) check(`${d}: shareable under its readme's Free Art License`, /^Free Art License 1\.3/.test(lic), lic);
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Speed Dreams importer checks passed.");
