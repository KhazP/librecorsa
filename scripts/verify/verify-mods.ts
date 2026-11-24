/**
 * Mod packages (src/lib/mods): the manifest's checks, the ids and paths a package may use, its track data's URLs, the
 * zip reader (stored and deflated entries, damaged and hostile archives), finding a package's root, the content hash,
 * and how the track and car registries take a package's circuits, cars and liveries without letting one stand in for
 * the game's own.
 *
 *   npx tsx scripts/verify/verify-mods.ts
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
} from "../../src/lib/mods/mod-manifest";
import { resolveModTrackUrls } from "../../src/lib/mods/mod-urls";
import { crc32, readZip, ZipError, isArchiveJunk } from "../../src/lib/mods/zip-reader";
import { packageFileProblems, packageRoot } from "../../src/lib/mods/mod-store";
import { modTrackInfos } from "../../src/lib/mods/mod-loader";
import { modDefinitions, registerModContent } from "../../src/lib/mods/mod-content";
import { CARS, carById, portedSkinFor, carSkinThumbUrl, carThumbUrl, type CarId } from "../../src/lib/cars/car-registry";
import { CIRCUIT_VENUES, LISTED_TRACKS, registerModTracks, TRACKS, getTrackInfo } from "../../src/lib/track-registry";
import { roomModRefOf, roomTrackStatus } from "../../src/lib/mods/room-content";
import { modSimProfile } from "../../src/lib/mods/mod-physics";
import { AMG_GT3_SIM_PROFILE } from "../../src/lib/sim/gt3/AmgGt3Sim";
import { createVehicleSim, VEHICLE_MODELS } from "../../src/lib/cars/vehicle-models";
import { createSimHost, loopbackTransport } from "../../src/lib/sim/runtime/sim-host";
import { getActiveTrackData } from "../../src/lib/track-data";
import { sanitizeLobbySettings } from "../../src/lib/net/wire";

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
    const listing = baseManifest();
    (listing.skins as Record<string, unknown>[])[0].files = ["paint.png"];
    ((listing.cars as Record<string, unknown>[])[0].skins as Record<string, unknown>[])[1].files = ["decals.png"];
    const listed = validateModManifest(listing, known);
    const named = listed.ok ? manifestFiles(listed.manifest) : [];
    check("a livery's listed files are files the package must hold", named.includes("skins/blue/paint.png") && named.includes("cars/gt-x/skins/red/decals.png"), named.join(", "));
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
  bad((m) => (m.credit = { author: "x", license: "y", url: "https://:443/x" }), /credit\.url/, "a link with no host is refused");
  bad((m) => ((m.skins as Record<string, unknown>[])[0].car = "lc26"), /skins\[0\]\.car/, "a livery for a car without liveries (the prototype) is refused");
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
    metadata: { name: "x", mesh: { url: "ring/ring.glb", scenery: ["ring/trees.glb"], road: "Track_Asphalt_Road" } },
    samples: [1, 2, 3],
  };
  const out = resolveModTrackUrls(raw, "jdoe.test-pack");
  check("the model's path becomes its package URL", out.metadata.mesh.url === "/mods/jdoe.test-pack/ring/ring.glb", out.metadata.mesh.url);
  check("scenery paths become package URLs, mesh names stay names", out.metadata.mesh.scenery[0] === "/mods/jdoe.test-pack/ring/trees.glb" && out.metadata.mesh.road === "Track_Asphalt_Road");
  check("the input is not changed, and the samples are not copied", raw.metadata.mesh.url === "ring/ring.glb" && out.samples === raw.samples);
  check("track data without a mesh is read as it is", resolveModTrackUrls({ samples: [] } as { metadata?: object }, "jdoe.test-pack").metadata === undefined);
  for (const outside of [
    "/tracks/shared/x.glb",
    "https://cdn.example/x.glb",
    "../other.pack/x.glb",
    // Past an extension check that looks only at the end
    "https://cdn.example/x.glb?v=1",
    "https://cdn.example/serve-track",
    "data:model/gltf-binary;base64,AAAA",
    "ring/ring.gltf",
  ]) {
    let refused = false;
    try {
      resolveModTrackUrls({ metadata: { mesh: { url: "ring/ring.glb", scenery: [outside] } } }, "jdoe.test-pack");
    } catch {
      refused = true;
    }
    check(`a file outside the package (${outside}) is refused`, refused);
  }
}

// --- Zip reader ---
function makeZip(
  files: { path: string; data: Uint8Array; deflate?: boolean; crcOverride?: number; sizeOverride?: number }[],
  comment = new Uint8Array(),
): Uint8Array {
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
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  const out = new Uint8Array(offset + cdSize + eocd.length);
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
  const entries = await readZip(zip);
  check("directories are left out of the entries", entries.length === 2 && entries.every((e) => !e.path.endsWith("/")), entries.map((e) => e.path).join(", "));
  const stored = await entries[0].read();
  check("a stored entry reads back byte for byte", new TextDecoder().decode(stored) === '{"a":1}');
  const inflated = await entries[1].read();
  check("a deflated entry inflates back byte for byte", inflated.length === text.length && inflated.every((b, i) => b === text[i]), `${inflated.length} bytes`);

  const rejects = async (name: string, zipBytes: Uint8Array, expect: RegExp) => {
    try {
      for (const e of await readZip(zipBytes)) await e.read();
      check(name, false, "read without complaint");
    } catch (err) {
      check(name, err instanceof ZipError && expect.test(err.message), (err as Error).message);
    }
  };
  await rejects("a damaged entry fails its checksum", makeZip([{ path: "x.json", data: small, crcOverride: 1234 }]), /checksum/);
  await rejects("an entry that inflates past its stated size is stopped", makeZip([{ path: "x.txt", data: text, deflate: true, sizeOverride: 100 }]), /past its stated size/);
  await rejects("something that isn't a zip is refused", new TextEncoder().encode("not a zip at all, just some text that goes on for a while"), /not a zip/);
  check("archive junk is recognised", isArchiveJunk("__MACOSX/pack/._mod.json") && isArchiveJunk("pack/.DS_Store") && !isArchiveJunk("pack/mod.json"));
  check("so is junk inside the package's folder", isArchiveJunk("pack/__MACOSX/._mod.json"));
  await rejects("two entries under one name are refused", makeZip([{ path: "mod.json", data: small }, { path: "mod.json", data: small }]), /twice/);
  await rejects(
    "a stored entry whose sizes differ is refused",
    makeZip([{ path: "x.json", data: small, sizeOverride: small.length + 5 }]),
    /stored, yet its sizes differ/,
  );
  // A few bytes that say 1.5 GB: refused when it comes up short, with nothing set aside for the size it claimed
  await rejects("an entry far smaller than it says is refused", makeZip([{ path: "x.txt", data: small, deflate: true, sizeOverride: 1.5 * 1024 ** 3 }]), /shorter/);
  const commented = makeZip([{ path: "mod.json", data: small }], new Uint8Array([0x50, 0x4b, 0x05, 0x06, 1, 2, 3, 4]));
  const fromCommented = await readZip(commented).catch((err: Error) => err);
  check("a comment holding the end record's signature doesn't hide the archive", Array.isArray(fromCommented) && fromCommented.length === 1, Array.isArray(fromCommented) ? "" : String(fromCommented));
  const fromBlob = await readZip(new Blob([zip as Uint8Array<ArrayBuffer>]));
  check("the archive reads from a file (Blob) as from bytes", fromBlob.length === 2 && new TextDecoder().decode(await fromBlob[0].read()) === '{"a":1}');
}

// --- Package root and hash ---
async function rootAndHash(): Promise<void> {
  check("mod.json at the top is the root", packageRoot(["mod.json", "a.glb"]) === "");
  check("one folder holding mod.json is the root", packageRoot(["pack/mod.json", "pack/a.glb"]) === "pack/");
  check("files outside that folder mean no single root", packageRoot(["pack/mod.json", "other/a.glb"]) === null);
  check("no mod.json means no root", packageRoot(["a/b.glb"]) === null);
  check("`..` is no package folder", packageRoot(["../mod.json", "../a.glb"]) === null);
  check("names a letter's case apart are refused (one file on Windows and macOS)", packageFileProblems(["Track.glb", "track.glb"]).some((e) => /only in case/.test(e)));
  check("a script is refused", packageFileProblems(["mod.json", "run.js"]).some((e) => /file type/.test(e)));
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
  check("its bank sweeps its range on its model's limiter", car?.sound.physicsLimiterRpm === VEHICLE_MODELS["amg-gt3"].limiterRpm);
  const borrowing = { ...m, cars: [{ ...m.cars![0], sound: { car: "amg-gt3" } }] };
  registerModContent([{ manifest: borrowing, origin }]);
  check("a car can borrow a game car's sound bank", CARS.find((c) => c.id === carId)?.sound.assetDir === carById("amg-gt3").sound.assetDir);
  registerModContent([{ manifest: m, origin }]);
  check("its thumbnail sits beside its model", carThumbUrl(carId) === "/mods/jdoe.test-pack/cars/gt-x/thumb.webp", carThumbUrl(carId));
  const skins = car?.skins ?? [];
  check("its first livery keeps the model's paint", skins.length === 2 && portedSkinFor(carId, skins[0]) === null);
  const red = portedSkinFor(carId, skins[1]);
  check("its other liveries load from the package", red?.baseUrl === "/mods/jdoe.test-pack/cars/gt-x/skins/red", red?.baseUrl);
  check("its first livery's picture is the car's own (the model's paint has no folder)", carSkinThumbUrl(carId, skins[0].id) === carThumbUrl(carId), carSkinThumbUrl(carId, skins[0].id));
  check("another livery's picture is in its folder", carSkinThumbUrl(carId, skins[1].id) === "/mods/jdoe.test-pack/cars/gt-x/skins/red/thumb.webp");
  const gt3Skins = carById("amg-gt3").skins ?? [];
  const added = gt3Skins.find((s) => s.id === "mod:jdoe.test-pack/blue");
  check("a package livery joins the game car's liveries after its own", gt3Skins.length === gt3SkinsBefore + 1 && gt3Skins[gt3Skins.length - 1] === added);
  check("it loads from the package and shows its picture from there", portedSkinFor("amg-gt3", added)?.baseUrl === "/mods/jdoe.test-pack/skins/blue" && carSkinThumbUrl("amg-gt3", added!.id) === "/mods/jdoe.test-pack/skins/blue/thumb.webp");
  registerModContent([]);
  check("registering none removes the cars and liveries again", CARS.length === before && (carById("amg-gt3").skins?.length ?? 0) === gt3SkinsBefore);

  // --- Online rooms: the same package or none ---
  registerModTracks(tracks);
  const ref = roomModRefOf(id);
  check("a room names a mod circuit's package and hash", ref?.packageId === "jdoe.test-pack" && ref.hash === "f".repeat(64) && ref.version === "1.0.0");
  check("a game circuit names none", roomModRefOf(TRACKS[0].id) === undefined);
  check("the same package: the guest can race", roomTrackStatus(id, ref) === "ok");
  check("another version: the guest is told", roomTrackStatus(id, { ...ref!, hash: "e".repeat(64) }) === "different");
  check("no such package: the guest is told", roomTrackStatus("mod:jdoe.other/x", undefined) === "missing");
  const settings = sanitizeLobbySettings({ trackId: id, trackMod: ref, laps: 3 });
  check("the lobby settings carry the package through the room server", settings.trackMod?.hash === ref?.hash);
  const stale = sanitizeLobbySettings({ trackId: "mod:jdoe.other/oval", trackMod: ref });
  check("a reference to another package than the circuit's is dropped (left from the last circuit)", stale.trackMod === undefined);
  const forged = sanitizeLobbySettings({ trackId: id, trackMod: { ...ref, hash: "not-a-hash", packageId: "../x" } });
  const offMod = sanitizeLobbySettings({ trackId: TRACKS[0].id, trackMod: ref });
  check("a malformed package reference, or one on a game circuit, is dropped", forged.trackMod === undefined && offMod.trackMod === undefined);
  registerModTracks([]);
}

// --- A mod car's own physics ---
function physicsChecks(): void {
  const base = AMG_GT3_SIM_PROFILE;
  const heavy = modSimProfile(base, { format: 1, profile: { config: { chassis: { totalMassKg: base.config.chassis.totalMassKg * 1.6 } }, turbo: true, steerRatio: 14 } }, "mod:jdoe.test-pack/gt-x@abc");
  check("a physics patch changes only what it names", heavy.ok && heavy.profile.config.chassis.totalMassKg === base.config.chassis.totalMassKg * 1.6 && heavy.profile.config.chassis.wheelbase === base.config.chassis.wheelbase && heavy.profile.turbo === true);
  check("it takes the optional values a base leaves out", heavy.ok && heavy.profile.steerRatio === 14);
  check("it is named by the car (plans are kept per profile id), and the base is untouched", heavy.ok && heavy.profile.id === "mod:jdoe.test-pack/gt-x@abc" && base.id !== heavy.profile.id && base.turbo === AMG_GT3_SIM_PROFILE.turbo);
  const refused = (patch: unknown, expect: RegExp, name: string) => {
    const r = modSimProfile(base, { format: 1, profile: patch }, "x");
    check(name, !r.ok && r.errors.some((e) => expect.test(e)), r.ok ? "accepted" : r.errors.join("; "));
  };
  refused({ config: { chassis: { totalMasKg: 900 } } }, /totalMasKg: the base model has no such value/, "a misspelt value is refused, by its path");
  refused({ config: { chassis: { totalMassKg: "heavy" } } }, /is a number in the base model, not a string/, "a value of another kind is refused");
  refused({ config: { chassis: { totalMassKg: null } } }, /not a value a profile holds/, "null is refused");
  refused({ id: "amg-gt3" }, /set by the game/, "the profile's id can't be set");
  refused({ model: "liana" }, /set by the game/, "nor the model it drives as");
  refused({ config: { chassis: { totalMassKg: 0 } } }, /must stay above 0/, "a mass (or anything the base has above zero) can't drop to zero or below");
  check("it drives as its base model (setups, fuel, wing steps, AI), its plans its own", heavy.ok && heavy.profile.model === "amg-gt3" && createVehicleSim("amg-gt3", getActiveTrackData(1200), null, undefined, heavy.profile).vehicleId === "amg-gt3");
  refused({ bodyPlan: [[0, 1]] }, /set by the game/, "nor its body plan (mod.json has it)");
  refused({ config: { chassis: { bodyPlan: [[999999, 1]] } } }, /set by the game/, "nor the chassis' copy of it");
  refused(JSON.parse('{"config":{"__proto__":{"x":1}}}'), /no such value/, "an inherited key (__proto__) is no value of a profile");
  refused({ config: { engine: { powerCurve: [[1000]] } } }, /must hold 2 numbers/, "a curve's point stays an [x, y] pair");
  refused({ config: { engine: { powerCurve: [[5000, 300], [1000, 200]] } } }, /x rising/, "a curve's points stay in rising x");
  refused({ coldPsiRange: [20] }, /must hold 2 numbers/, "a two-value range keeps two values");
  refused({ config: { chassis: { frontWeightFraction: 1.5 } } }, /between 0 and 1/, "the weight split stays between the axles");
  refused({ config: { chassis: { unsprungMassFront: 500, unsprungMassRear: 500 } } }, /unsprung/, "the wheels can't outweigh the car");
  refused({ fuelLPerS1000Rpm: -1 }, /above 0/, "an optional rate the base leaves out must be above zero");
  const wings = base.config.aero.wings;
  const rear = wings.findIndex((w) => w.positionZ < 0 && w.name.includes("REAR"));
  if (rear >= 0) {
    const patch = wings.map((w, i) => (i === rear ? { positionZ: w.positionZ - 0.1, angleDeg: 0 } : {}));
    const r = modSimProfile(base, { format: 1, profile: { config: { aero: { wings: patch } } } }, "x");
    check("each wing is checked against its own (a rear wing behind the axle, at 0°)", r.ok, r.ok ? "" : r.errors.join("; "));
  }
  // What other models have, or a modder means: no anti-roll bar, a suspension point below the axle, a power curve from 0
  const allowed = (patch: unknown, name: string) => {
    const r = modSimProfile(base, { format: 1, profile: patch }, "x");
    check(name, r.ok, r.ok ? "" : r.errors.join("; "));
  };
  allowed({ config: { suspensions: { rear: { arb: 0 } } } }, "a part switched off (no rear anti-roll bar) is allowed");
  const hardpoints = (base.config.suspensions.front.hardpoints ?? []).map((p, i) => (i === 0 ? [p[0], -0.02, p[2]] : p));
  allowed({ config: { suspensions: { front: { hardpoints } } } }, "a position may cross zero (a suspension point below the axle)");
  allowed({ config: { engine: { powerCurve: [[0, 0], ...base.config.engine.powerCurve.slice(1)] } } }, "a curve may start at zero");
  refused({ config: { chassis: { wheelbase: -1 } } }, /must stay above 0/, "what the simulation divides by stays above zero (the wheelbase)");
  refused({ config: { engine: { inertia: 0 } } }, /engine\.inertia: must stay above 0/, "... the engine's inertia");
  const tyre = base.config.compoundSlots.soft;
  refused({ config: { tyreCompounds: { [tyre]: { modelData: { slip_ratio_limit: -0.2 } } } } }, /slip_ratio_limit: must stay above 0/, "... a tyre's peak slip ratio");
  const turboBase = VEHICLE_MODELS["porsche-934-rsr"].simProfile!;
  for (const key of ["spoolUpS", "spoolDownS", "referenceRpm"]) {
    const r = modSimProfile(turboBase, { format: 1, profile: { config: { engine: { turbo: { [key]: -1 } } } } }, "x");
    check(`... a turbo's ${key}`, !r.ok && r.errors.some((e) => new RegExp(`${key}: must stay above 0`).test(e)), r.ok ? "accepted" : r.errors.join("; "));
  }
  const f1 = VEHICLE_MODELS["f12026-car"].simProfile!;
  const heights = f1.config.aero.rhMap?.frontRh;
  if (heights) {
    const r = modSimProfile(f1, { format: 1, profile: { config: { aero: { rhMap: { frontRh: [...heights].reverse() } } } } }, "x");
    check("a ride-height map's heights must rise", !r.ok && r.errors.some((e) => /must rise/.test(e)));
  }
  const liana = VEHICLE_MODELS.liana.simProfile!;
  if (liana.config.aero.wings.length === 0) {
    const r = modSimProfile(liana, { format: 1, profile: { config: { aero: { wings: [{ angleDeg: 3 }] } } } }, "x");
    check("a list the base has empty can't be filled (nothing to check it against)", !r.ok && r.errors.some((e) => /empty in the base/.test(e)));
  }
  const plan: [number, number][] = [[0, 2], [0.9, 1.8], [0.9, -2], [0, -2.2]];
  const planned = createVehicleSim("liana", getActiveTrackData(1200), null, plan) as unknown as { profile?: { bodyPlan?: unknown } };
  check("another body's outline reaches any vehicle model, not only the GT3", planned.profile?.bodyPlan === plan);
  refused({ warpFactor: 9 }, /no such value/, "an unknown top-level value is refused");
  check("a file of another format is refused", !modSimProfile(base, { format: 2, profile: {} }, "x").ok);

  // Through the simulation worker's messages, as the game runs it: the worker builds the car on the mod's profile
  if (!heavy.ok) return;
  const loop = loopbackTransport();
  const host = createSimHost(loop.transport, loop.wallNowMs);
  const track = getActiveTrackData(1200);
  const twin = createVehicleSim("amg-gt3", track, null, undefined, heavy.profile);
  const car = host.adopt(twin, "amg-gt3", null, undefined, heavy.profile);
  host.endFrame(true);
  const sim = loop.runtime.simulatedCar as unknown as { profile?: { id: string } } | null;
  check("the simulation worker builds the car on the mod's own profile", sim?.profile?.id === heavy.profile.id, sim?.profile?.id);

  // The heavier car accelerates slower than its base, from the same grid slot, on the same throttle
  const run = (profile?: typeof base): number => {
    const c = createVehicleSim("amg-gt3", track, null, undefined, profile);
    c.aiAutopilot = false;
    c.autoGearbox = true;
    c.tireCompound = "medium";
    c.resetToStartGrid(false);
    for (let i = 0; i < 60 * 6; i++) c.step(1 / 60, { throttle: 1, brake: 0 });
    return c.telemetry.speedKmh;
  };
  const baseSpeed = run();
  const heavySpeed = run(heavy.profile);
  check("a car on a heavier patch is slower off the line than its base", heavySpeed < baseSpeed - 5, `${heavySpeed.toFixed(1)} vs ${baseSpeed.toFixed(1)} km/h after 6 s`);
  void car;
}

void (async () => {
  await zipChecks();
  await rootAndHash();
  registryChecks();
  physicsChecks();
  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll mod package checks passed");
})();
