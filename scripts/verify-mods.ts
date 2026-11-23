/**
 * Mod packages (src/lib/mods): the manifest's checks, the ids and paths a package may use, its track data's URLs, the
 * zip reader (stored and deflated entries, damaged and hostile archives), finding a package's root, the content hash,
 * and how the track and car registries take a package's circuits, cars and liveries without letting one stand in for
 * the game's own.
 *
 *   npx tsx scripts/verify-mods.ts
 */
import { deflateRawSync } from "node:zlib";
import {
  isModContentId,
  isSafeModPath,
  manifestFiles,
  modContentId,
  modFileUrl,
  packageHash,
  parseModContentId,
  validateModManifest,
  type ModManifest,
} from "../src/lib/mods/mod-manifest";
import { resolveModTrackUrls } from "../src/lib/mods/mod-urls";
import { readZip, ZipError, isArchiveJunk } from "../src/lib/mods/zip-reader";
import { packageRoot } from "../src/lib/mods/mod-store";
import { modTrackInfos } from "../src/lib/mods/mod-loader";
import { modDefinitions, registerModContent } from "../src/lib/mods/mod-content";
import { CARS, carById, portedSkinFor, carSkinThumbUrl, carThumbUrl, type CarId } from "../src/lib/cars/car-registry";
import { CIRCUIT_VENUES, LISTED_TRACKS, registerModTracks, TRACKS, getTrackInfo } from "../src/lib/track-registry";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failed++;
}

const known = modDefinitions();

const baseManifest = (): Record<string, unknown> => ({
  format: 1,
  id: "jdoe.test-pack",
  name: "Test pack",
  version: "1.0.0",
  credit: { author: "J. Doe", license: "CC BY 4.0", url: "https://example.org/pack" },
  tracks: [
    { id: "ring", name: "Test Ring", layout: "Full", country: "Nowhere", city: "Somewhere", lengthM: 3200, turns: 12, direction: "clockwise", data: "ring/track_data.json" },
  ],
  skins: [{ car: "amg-gt3", id: "blue", name: "#7 Blue", swatch: ["#0000ff", "#ffffff"] }],
  cars: [
    {
      id: "gt-x",
      title: "GT X",
      sub: "A test GT",
      badge: "GT X",
      classId: "gt3",
      year: 2024,
      physics: "amg-gt3",
      model: "cars/gt-x/gt-x.glb",
      skins: [{ id: "base", name: "Factory", swatch: ["#111111", "#222222"] }, { id: "red", name: "Red", swatch: ["#ff0000", "#000000"] }],
      sound: { dir: "cars/gt-x/audio", limiterRpm: 7500 },
    },
  ],
});

// --- Manifest ---
{
  const ok = validateModManifest(baseManifest(), known);
  check("a complete manifest passes", ok.ok, ok.ok ? "" : ok.errors.join("; "));
  if (ok.ok) {
    const files = manifestFiles(ok.manifest);
    check("manifestFiles names mod.json, the track data and the model", ["mod.json", "ring/track_data.json", "cars/gt-x/gt-x.glb"].every((f) => files.includes(f)), files.join(", "));
  }

  const bad = (mutate: (m: Record<string, unknown>) => void, expect: RegExp, name: string) => {
    const m = baseManifest();
    mutate(m);
    const r = validateModManifest(m, known);
    check(name, !r.ok && r.errors.some((e) => expect.test(e)), r.ok ? "passed" : r.errors.join("; "));
  };
  bad((m) => (m.format = 2), /^format/, "another format version is refused");
  bad((m) => (m.id = "NoDot"), /^id/, "a package id without author.name is refused");
  bad((m) => (m.id = "an-author-name-far-too-long.pack"), /^id/, "a package id past 16 characters of author is refused");
  bad((m) => ((m.tracks as Record<string, unknown>[])[0].data = "../escape.json"), /tracks\[0\]\.data/, "a path out of the package is refused");
  bad((m) => ((m.tracks as Record<string, unknown>[])[0].data = "/abs/track_data.json"), /tracks\[0\]\.data/, "an absolute path is refused");
  bad((m) => ((m.tracks as Record<string, unknown>[])[0].lengthM = -5), /lengthM/, "a negative lap length is refused");
  bad((m) => ((m.tracks as Record<string, unknown>[]).push({ ...(m.tracks as Record<string, unknown>[])[0] })), /used twice/, "two circuits with one id are refused");
  bad((m) => ((m.skins as Record<string, unknown>[])[0].car = "no-such-car"), /skins\[0\]\.car/, "a livery for a car the game hasn't got is refused");
  bad((m) => ((m.skins as Record<string, unknown>[])[0].swatch = ["red", "blue"]), /swatch/, "a swatch that isn't #rrggbb is refused");
  bad((m) => ((m.cars as Record<string, unknown>[])[0].physics = "warp-drive"), /physics/, "a car on a vehicle model the game hasn't got is refused");
  bad((m) => ((m.cars as Record<string, unknown>[])[0].sound = { dir: "x" }), /limiterRpm/, "a sound bank without its limiter is refused");
  bad((m) => (m.credit = { author: "x", license: "y", url: "javascript:alert(1)" }), /credit\.url/, "a credit link that isn't https is refused");
  bad((m) => {
    delete m.tracks;
    delete m.cars;
    delete m.skins;
  }, /adds nothing/, "a package that adds nothing is refused");
  check("a non-object is refused", !validateModManifest("nope", known).ok);
}

// --- Ids and paths ---
{
  const id = modContentId("jdoe.test-pack", "ring");
  check("content ids are mod:<package>/<id>", id === "mod:jdoe.test-pack/ring", id);
  check("isModContentId tells them apart", isModContentId(id) && !isModContentId("spielberg"));
  const parsed = parseModContentId(id);
  check("parseModContentId reads one back", parsed?.packageId === "jdoe.test-pack" && parsed.localId === "ring");
  check("parseModContentId refuses a malformed one", parseModContentId("mod:nope") === null && parseModContentId("mod:a.b/../x") === null);
  const longest = modContentId(`${"a".repeat(16)}.${"b".repeat(24)}`, "c".repeat(16));
  check("the longest content id fits the room protocol's 64 characters", longest.length <= 64, `${longest.length}`);
  check("content ids fall outside the lap board's id grammar", !/^[A-Za-z0-9_-]{1,64}$/.test(id));
  for (const [p, ok] of [
    ["track.glb", true],
    ["a/b/c.json", true],
    ["../x", false],
    ["a/../x", false],
    ["./x", false],
    ["/x", false],
    ["a\\b", false],
    ["c:/x", false],
    ["https://evil/x", false],
    ["a//b", false],
    ["", false],
    ["a?b", false],
  ] as const) {
    check(`isSafeModPath(${JSON.stringify(p)}) is ${ok}`, isSafeModPath(p) === ok);
  }
  check("modFileUrl encodes each segment", modFileUrl("a.b", "dir name/f#1.glb") === "/mods/a.b/dir%20name/f%231.glb", modFileUrl("a.b", "dir name/f#1.glb"));
}

// --- Track data URLs ---
{
  const raw = {
    metadata: { name: "x", mesh: { url: "ring/ring.glb", scenery: ["ring/trees.glb", "/tracks/shared/x.glb", "https://cdn.example/x.glb"] } },
    samples: [1, 2, 3],
  };
  const out = resolveModTrackUrls(raw, "jdoe.test-pack");
  check("the model's path becomes its package URL", out.metadata.mesh.url === "/mods/jdoe.test-pack/ring/ring.glb", out.metadata.mesh.url);
  check("scenery paths become package URLs", out.metadata.mesh.scenery[0] === "/mods/jdoe.test-pack/ring/trees.glb");
  check("absolute paths and URLs are left as they are", out.metadata.mesh.scenery[1] === "/tracks/shared/x.glb" && out.metadata.mesh.scenery[2] === "https://cdn.example/x.glb");
  check("the input is not changed, and the samples are not copied", raw.metadata.mesh.url === "ring/ring.glb" && out.samples === raw.samples);
}

// --- Zip reader ---
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: { path: string; data: Uint8Array; deflate?: boolean; crcOverride?: number; sizeOverride?: number }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const crc = f.crcOverride ?? crc32(f.data);
    const size = f.sizeOverride ?? f.data.length;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, f.deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, f.deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function zipChecks(): Promise<void> {
  const text = new TextEncoder().encode("hello ".repeat(5000));
  const small = new TextEncoder().encode('{"a":1}');
  const zip = makeZip([
    { path: "pack/", data: new Uint8Array() },
    { path: "pack/mod.json", data: small },
    { path: "pack/big.txt", data: text, deflate: true },
  ]);
  const entries = readZip(zip);
  check("directories are left out of the entries", entries.length === 2 && entries.every((e) => !e.path.endsWith("/")), entries.map((e) => e.path).join(", "));
  const stored = await entries[0].read();
  check("a stored entry reads back byte for byte", new TextDecoder().decode(stored) === '{"a":1}');
  const inflated = await entries[1].read();
  check("a deflated entry inflates back byte for byte", inflated.length === text.length && inflated.every((b, i) => b === text[i]), `${inflated.length} bytes`);

  const rejects = async (name: string, zipBytes: Uint8Array, expect: RegExp) => {
    try {
      for (const e of readZip(zipBytes)) await e.read();
      check(name, false, "read without complaint");
    } catch (err) {
      check(name, err instanceof ZipError && expect.test(err.message), (err as Error).message);
    }
  };
  await rejects("a damaged entry fails its checksum", makeZip([{ path: "x.json", data: small, crcOverride: 1234 }]), /checksum/);
  await rejects("an entry that inflates past its stated size is stopped", makeZip([{ path: "x.txt", data: text, deflate: true, sizeOverride: 100 }]), /past its stated size/);
  await rejects("something that isn't a zip is refused", new TextEncoder().encode("not a zip at all, just some text that goes on for a while"), /not a zip/);
  check("archive junk is recognised", isArchiveJunk("__MACOSX/pack/._mod.json") && isArchiveJunk("pack/.DS_Store") && !isArchiveJunk("pack/mod.json"));
}

// --- Package root and hash ---
async function rootAndHash(): Promise<void> {
  check("mod.json at the top is the root", packageRoot(["mod.json", "a.glb"]) === "");
  check("one folder holding mod.json is the root", packageRoot(["pack/mod.json", "pack/a.glb"]) === "pack/");
  check("files outside that folder mean no single root", packageRoot(["pack/mod.json", "other/a.glb"]) === null);
  check("no mod.json means no root", packageRoot(["a/b.glb"]) === null);
  const a = await packageHash({ "mod.json": "1".repeat(64), "a.glb": "2".repeat(64) });
  const b = await packageHash({ "a.glb": "2".repeat(64), "mod.json": "1".repeat(64) });
  const c = await packageHash({ "a.glb": "3".repeat(64), "mod.json": "1".repeat(64) });
  check("the package hash doesn't depend on file order", a === b);
  check("the package hash changes with any file", a !== c);
}

// --- Registries ---
function registryChecks(): void {
  const r = validateModManifest(baseManifest(), known);
  if (!r.ok) return check("registry checks need a valid manifest", false);
  const m: ModManifest = r.manifest;
  const origin = { packageId: m.id, packageName: m.name, version: m.version, hash: "f".repeat(64) };
  const builtInCount = TRACKS.length;
  const tracks = modTrackInfos(m, origin);
  registerModTracks(tracks);
  const id = "mod:jdoe.test-pack/ring";
  check("a package circuit joins TRACKS after the game's own", TRACKS.length === builtInCount + 1 && TRACKS[TRACKS.length - 1].id === id);
  check("it is listed, in its own venue", LISTED_TRACKS.some((t) => t.id === id) && CIRCUIT_VENUES.some((v) => v.layouts.some((l) => l.id === id)));
  const info = getTrackInfo(id);
  check("its data URL is in the package, its grade is mod", info.dataUrl === "/mods/jdoe.test-pack/ring/track_data.json" && info.quality === "mod", `${info.dataUrl} ${info.quality}`);
  registerModTracks([{ ...tracks[0], id: TRACKS[0].id }]);
  check("a package circuit can't take a game circuit's id", TRACKS.length === builtInCount && !TRACKS.some((t) => t.mod));
  registerModTracks([]);
  check("registering none removes them again", TRACKS.length === builtInCount && !LISTED_TRACKS.some((t) => t.mod));

  const before = CARS.length;
  const gt3SkinsBefore = carById("amg-gt3").skins?.length ?? 0;
  registerModContent([{ manifest: m, origin }]);
  const carId = "mod:jdoe.test-pack/gt-x" as CarId;
  const car = CARS.find((c) => c.id === carId);
  check("a package car joins CARS", CARS.length === before + 1 && !!car);
  check("it drives on the vehicle model it names, graded mod", car?.physics === "amg-gt3" && car.quality === "mod");
  check("its model and sound are in the package", car?.modelUrl === "/mods/jdoe.test-pack/cars/gt-x/gt-x.glb" && car.sound.assetDir === "/mods/jdoe.test-pack/cars/gt-x/audio/", `${car?.modelUrl} ${car?.sound.assetDir}`);
  check("its thumbnail sits beside its model", carThumbUrl(carId) === "/mods/jdoe.test-pack/cars/gt-x/thumb.webp", carThumbUrl(carId));
  const skins = car?.skins ?? [];
  check("its first livery keeps the model's paint", skins.length === 2 && portedSkinFor(carId, skins[0]) === null);
  const red = portedSkinFor(carId, skins[1]);
  check("its other liveries load from the package", red?.baseUrl === "/mods/jdoe.test-pack/cars/gt-x/skins/red", red?.baseUrl);
  const gt3Skins = carById("amg-gt3").skins ?? [];
  const added = gt3Skins.find((s) => s.id === "mod:jdoe.test-pack/blue");
  check("a package livery joins the game car's liveries after its own", gt3Skins.length === gt3SkinsBefore + 1 && gt3Skins[gt3Skins.length - 1] === added);
  check("it loads from the package and shows its picture from there", portedSkinFor("amg-gt3", added)?.baseUrl === "/mods/jdoe.test-pack/skins/blue" && carSkinThumbUrl("amg-gt3", added!.id) === "/mods/jdoe.test-pack/skins/blue/thumb.webp");
  registerModContent([]);
  check("registering none removes the cars and liveries again", CARS.length === before && (carById("amg-gt3").skins?.length ?? 0) === gt3SkinsBefore);
}

void (async () => {
  await zipChecks();
  await rootAndHash();
  registryChecks();
  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll mod package checks passed");
})();
