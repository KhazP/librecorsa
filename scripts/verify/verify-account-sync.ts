/**
 * Checks the game's side of player accounts (src/lib/account): which stored data follows the account and which stays
 * on the device (every key and every PlayerSettings field placed), reading a save from storage and writing it back,
 * every combine rule, the first-sync decision, the sync engine against a fake server (push, pull, 409, a folded
 * account's save, ghosts by hash), the sign-in return's notice, the device label, and that nothing happens with
 * accounts off.
 * Run: node scripts/verify/run-verify.mjs account-sync
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STORAGE_KEYS, STORAGE_PREFIXES } from "../../src/components/settings/storage";
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_INTERFACE_SETTINGS,
  DEFAULT_PLAYER_SETTINGS,
  SETTINGS_STORAGE_KEY,
} from "../../src/lib/settings/player-settings";
import { GARAGE_PRESETS_MAX } from "../../src/lib/sim/car-setup";
import { RACE_HISTORY_MAX } from "../../src/lib/sim/race-history";
import { parseOnlineConfig } from "../../src/lib/net/online-config";
import { AUTH_RESULTS, type AccountInfo, type CloudBestLap, type SaveDoc } from "../../src/lib/account/api-types";
import {
  ACCOUNT_SETTINGS_FIELDS,
  AUDIO_SPLIT,
  KEY_CLASSES,
  PRESETS_MAX,
  SETTINGS_KEY,
  SETTINGS_SPLIT,
  SYNC_STATE_KEY,
  UI_SPLIT,
  apply,
  classifyKey,
  collect,
  combinePresets,
  combineRaceHistory,
  combineSaves,
  dropsOf,
  emptySave,
  emptySyncState,
  firstSyncDecision,
  isEmptySave,
  parseSyncState,
  pickSide,
  readSaveDoc,
  summarizeSave,
  type StorageLike,
  type SyncState,
} from "../../src/lib/account/save-model";
import { createAccountApi } from "../../src/lib/account/account-api";
import { BUSY, MAX_TRIES, NEWER_SAVE, createSyncEngine, sha256Hex, type LocalGhosts } from "../../src/lib/account/sync-engine";
import { AUTH_NOTICES, deviceLabelFor, readAuthReturn } from "../../src/lib/account/account-text";
import {
  PUSH_DELAY_MS,
  RELOAD_WINDOW_MS,
  accountActions,
  createAccountStore,
  getAccountState,
  safeReturnPath,
  type AccountStoreEnv,
  type FirstSyncChoice,
} from "../../src/lib/account/account-store";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs: Iterable<string>) => [...xs].sort();

/** localStorage in memory */
function memoryStorage(init: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

const settingsWith = (patch: Record<string, unknown>) => JSON.stringify({ ...structuredClone(DEFAULT_PLAYER_SETTINGS), ...patch });
const preset = (id: string, name: string, savedAt: number, aero = "medium") => ({ id, name, savedAt, vehicle: "lc26", chassis: { a: 1 }, aero });
const race = (id: string, atMs: number, final = true) => ({ id, atMs, trackId: "t", carId: "lc26", kind: "ai_race", grid: 1, finish: 1, fieldSize: 4, bestLapMs: 90_000, raceTimeS: 300, penaltyS: 0, final });
const lapRef = (lapTimeMs: number, ghost: string): CloudBestLap => ({ trackId: "t", vehicle: "lc26", lapTimeMs, recordedAt: 1, ghost });
const sha = (c: string) => c.repeat(64);
const doc = (patch: Partial<SaveDoc>): SaveDoc => ({ ...emptySave(10, "test"), ...patch });

function main1(): void {
  console.log("What is stored where");
  {
    const missing = STORAGE_KEYS.filter((k) => !(k.key in KEY_CLASSES)).map((k) => k.key);
    check("every key Settings lists (storage.ts STORAGE_KEYS) is placed", missing.length === 0, missing.join(", "));
    const sample = (k: string) => k.replace(/<[^>]+>/g, "x");
    const wrong = Object.entries(KEY_CLASSES).filter(([k, cls]) => classifyKey(sample(k)) !== cls);
    check("each placed key and family classifies as placed", wrong.length === 0, wrong.map(([k]) => k).join(", "));
    check("every placed key is under one of the game's prefixes", Object.keys(KEY_CLASSES).every((k) => STORAGE_PREFIXES.some((p) => k.startsWith(p))));

    // Every key the game's code names under its prefixes, read from the source: a new key there must be placed
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(join(__dirname, "..", "..", "src"));
    const unplaced = new Set<string>();
    let seen = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/["'`]((?:bugesera|librecorsa|lc)\.[A-Za-z0-9_.-]*)/g)) {
        const key = m[1];
        if (key === "librecorsa.org" || STORAGE_PREFIXES.includes(key as (typeof STORAGE_PREFIXES)[number])) continue;
        seen++;
        // A template literal's head ("lc.garage.presets.") stands for its family
        if (classifyKey(key.endsWith(".") ? `${key}x` : key) === null) unplaced.add(key);
      }
    }
    check(`every storage key named in src (${seen} mentions) is placed`, seen > 30 && unplaced.size === 0, [...unplaced].join(", "));

    const synced = Object.entries(KEY_CLASSES).filter(([, c]) => c === "synced").map(([k]) => k);
    check(
      "the synced keys are the plan's",
      same(sorted(synced), sorted([
        "bugesera.settings.v1",
        "bugesera.tyreSetup",
        "bugesera.tyreSetup.<car>",
        "lc.garage.chassis.<car>",
        "lc.garage.presets.<car>",
        "librecorsa.carSkins",
        "librecorsa.raceHistory",
        "librecorsa.driverStats",
        "librecorsa.f1ModPhysics",
        "bugesera.vehicle",
        "bugesera.track",
      ])),
      synced.join(", ")
    );
    const rebuilt = Object.entries(KEY_CLASSES).filter(([, c]) => c === "rebuilt").map(([k]) => k);
    check("the rebuilt keys are the plan's", same(sorted(rebuilt), sorted(["librecorsa.bestLapSummaries.v1", "librecorsa.bestLapsUpdatedAt", "lc.boardBest", "lc.challengeBest"])));
    check(
      "credentials, hardware and one-time prompts stay on the device",
      ["bugesera.driverKey", "bugesera.turn", "lc.roomHostToken", "bugesera.gpu", "bugesera.rumble", "bugesera.onboarded", "librecorsa.adminKey", SYNC_STATE_KEY, "librecorsa.ai-learn.v1.t.c.d"].every((k) => classifyKey(k) === "device")
    );
    check("a key the game doesn't know is never synced", classifyKey("librecorsa.somethingNew") === null && classifyKey("other.key") === null);
    check("the settings key and limits agree with the game's", SETTINGS_KEY === SETTINGS_STORAGE_KEY && PRESETS_MAX === GARAGE_PRESETS_MAX && RACE_HISTORY_MAX === 50);

    check("every PlayerSettings field is placed", same(sorted(Object.keys(SETTINGS_SPLIT)), sorted(Object.keys(DEFAULT_PLAYER_SETTINGS))));
    check("every audio setting is placed", same(sorted(Object.keys(AUDIO_SPLIT)), sorted(Object.keys(DEFAULT_AUDIO_SETTINGS))));
    check("every interface setting is placed", same(sorted(Object.keys(UI_SPLIT)), sorted(Object.keys(DEFAULT_INTERFACE_SETTINGS))));
    check(
      "the account's settings are the plan's",
      same(sorted(ACCOUNT_SETTINGS_FIELDS), sorted(["assistPreset", "racingLine", "autoGearbox", "autoClutch", "autoOvertake", "ghost", "profile", "liveryId", "customLivery", "camera", "aiSkill", "race", "realism", "practiceDamage", "conditions", "timeOfDayChosen", "library", "audio", "ui"]))
    );
    check(
      "music and spotter choices and units follow the account, volumes and scale stay",
      same(sorted(Object.entries(AUDIO_SPLIT).filter(([, s]) => s === "account").map(([k]) => k)), ["musicMuted", "musicOff", "raceMusicOn", "spotter", "spotterRadio", "spotterVoice"]) &&
        same(sorted(Object.entries(UI_SPLIT).filter(([, s]) => s === "account").map(([k]) => k)), ["palette", "units"])
    );
  }

  console.log("Reading a save from storage and writing it back");
  {
    const a = memoryStorage({
      [SETTINGS_KEY]: settingsWith({
        profile: { name: "Alp", code: "ALP", color: "#112233", generated: false, autoUpload: true },
        graphics: { ...DEFAULT_PLAYER_SETTINGS.graphics, quality: "low" },
        audio: { ...DEFAULT_PLAYER_SETTINGS.audio, volume: 0.3, musicOff: ["t1"] },
        ui: { ...DEFAULT_PLAYER_SETTINGS.ui, scale: 1.3, palette: "deutan" },
      }),
      "bugesera.vehicle": "amg-gt3",
      "bugesera.tyreSetup.amg-gt3": '{"camberDeg":{"front":-3,"rear":-2}}',
      "lc.garage.presets.amg-gt3": JSON.stringify([preset("p1", "Quali", 5)]),
      "librecorsa.raceHistory": JSON.stringify([race("r1", 100)]),
      "bugesera.driverKey": "secret-key-of-device-a-0123456789abcdef",
      "bugesera.gpu": "Apple M3",
      "librecorsa.ai-learn.v1.t.gt3.ALP": "{}",
      "other.app": "x",
    });
    let state = emptySyncState();
    const first = collect(a, state, { now: 1000, savedBy: "A" });
    state = first.state;
    const d = first.doc;
    check("only synced keys go in", same(sorted(Object.keys(d.keys)), ["bugesera.tyreSetup.amg-gt3", "bugesera.vehicle", "lc.garage.presets.amg-gt3", "librecorsa.raceHistory"]));
    check("the driver key, GPU and AI learning stay out", !JSON.stringify(d).includes("secret-key") && !JSON.stringify(d).includes("Apple M3"));
    check("only the account's settings go in", same(sorted(Object.keys(d.settings)), sorted(ACCOUNT_SETTINGS_FIELDS)));
    const audio = d.settings.audio?.value as Record<string, unknown>;
    const ui = d.settings.ui?.value as Record<string, unknown>;
    check("split fields hold only their synced members", audio.volume === undefined && same(audio.musicOff, ["t1"]) && ui.scale === undefined && ui.palette === "deutan");
    check("graphics and controls stay out", d.settings.graphics === undefined && d.settings.keys === undefined && d.settings.wheel === undefined);
    check("the first collect marks every time as not known", Object.values(d.keys).every((s) => s.t === 0) && Object.values(d.settings).every((s) => s.t === 0));

    a.setItem("bugesera.vehicle", "lc26");
    a.removeItem("bugesera.tyreSetup.amg-gt3");
    a.setItem("lc.garage.chassis.lc26", '{"x":1}');
    const second = collect(a, state, { now: 2000, savedBy: "A" });
    state = second.state;
    check("a changed value takes the time of the collect", second.doc.keys["bugesera.vehicle"].t === 2000);
    check("an unchanged value keeps its time", second.doc.keys["librecorsa.raceHistory"].t === 0 && second.doc.settings.profile.t === 0);
    check("a key new since tracking began is a change", second.doc.keys["lc.garage.chassis.lc26"].t === 2000);
    check("a removed key becomes a tombstone", second.doc.removed["bugesera.tyreSetup.amg-gt3"] === 2000 && !second.doc.keys["bugesera.tyreSetup.amg-gt3"]);
    const third = collect(a, state, { now: 3000, savedBy: "A" });
    check("the tombstone keeps its time", third.doc.removed["bugesera.tyreSetup.amg-gt3"] === 2000);
    check("the sync state survives storage", same(parseSyncState(JSON.stringify(third.state)), third.state) && same(parseSyncState("junk"), emptySyncState()));

    // Another device with its own graphics, volume and key takes A's save
    const b = memoryStorage({
      [SETTINGS_KEY]: settingsWith({
        graphics: { ...DEFAULT_PLAYER_SETTINGS.graphics, quality: "high" },
        audio: { ...DEFAULT_PLAYER_SETTINGS.audio, volume: 0.9 },
        ui: { ...DEFAULT_PLAYER_SETTINGS.ui, scale: 0.9 },
      }),
      "bugesera.driverKey": "device-b-key-0123456789abcdef0123456789",
      "bugesera.tyreSetup.amg-gt3": "{}",
    });
    const bState = collect(b, emptySyncState(), { now: 500, savedBy: "B" }).state;
    const applied = apply(b, third.doc, bState);
    const bSettings = JSON.parse(b.getItem(SETTINGS_KEY) as string);
    check("applying writes the synced keys", b.getItem("bugesera.vehicle") === "lc26" && b.getItem("librecorsa.raceHistory") === a.getItem("librecorsa.raceHistory"));
    check("applying removes what the save removed", b.getItem("bugesera.tyreSetup.amg-gt3") === null);
    check("applying takes the account's settings", bSettings.profile.name === "Alp" && same(bSettings.audio.musicOff, ["t1"]) && bSettings.ui.palette === "deutan");
    check("applying keeps this device's own settings", bSettings.graphics.quality === "high" && bSettings.audio.volume === 0.9 && bSettings.ui.scale === 0.9);
    check("applying keeps this device's driver key", b.getItem("bugesera.driverKey") === "device-b-key-0123456789abcdef0123456789");
    check("applying says it changed something", applied.changed);
    const again = collect(b, applied.state, { now: 9000, savedBy: "B" });
    check("the round trip gives the same values", same(Object.fromEntries(Object.entries(again.doc.keys).map(([k, s]) => [k, s.value])), Object.fromEntries(Object.entries(third.doc.keys).map(([k, s]) => [k, s.value]))));
    check("the applied values keep the save's times", again.doc.keys["bugesera.vehicle"].t === 2000 && again.doc.settings.profile.t === 0);
    check("applying the same save again changes nothing", !apply(b, third.doc, again.state).changed);

    const hostile = doc({
      keys: { "bugesera.driverKey": { value: "stolen", t: 1 }, "bugesera.gpu": { value: "x", t: 1 } },
      settings: { graphics: { value: { quality: "low" }, t: 1 }, keys: { value: {}, t: 1 } },
    });
    const c = memoryStorage({ "bugesera.driverKey": "mine", [SETTINGS_KEY]: settingsWith({}) });
    const before = c.getItem(SETTINGS_KEY);
    apply(c, hostile, emptySyncState());
    check("a save can't write a device key or a device setting", c.getItem("bugesera.driverKey") === "mine" && c.getItem("bugesera.gpu") === null && c.getItem(SETTINGS_KEY) === before);
    check("a save from the network is read entry by entry", readSaveDoc({ v: 1, keys: { a: { value: 1 }, b: { value: "x", t: 5 } }, bestLaps: { k: { ghost: "nope" } } })?.keys.b?.t === 5);
    check("a newer version's save isn't read", readSaveDoc({ v: 2, keys: {} }) === null && readSaveDoc(null) === null);
  }

  console.log("Combining two saves");
  {
    // Best laps
    const l = doc({ bestLaps: { a: lapRef(90_000, sha("1")), b: lapRef(80_000, sha("2")), c: lapRef(70_000, sha("3")) } });
    const cl = doc({ bestLaps: { a: lapRef(89_000, sha("4")), b: lapRef(81_000, sha("5")), d: lapRef(60_000, sha("6")), c: lapRef(70_000, sha("7")) } });
    const laps = combineSaves(l, cl, "combine").bestLaps;
    check("best laps: the faster one on the same key, either side", laps.a.ghost === sha("4") && laps.b.ghost === sha("2"));
    check("best laps: the union of both", Object.keys(laps).length === 4 && laps.d.ghost === sha("6"));
    check("best laps: the same time goes to the choice", combineSaves(l, cl, "local").bestLaps.c.ghost === sha("3") && combineSaves(l, cl, "cloud").bestLaps.c.ghost === sha("7"));

    // Race history
    const mine = Array.from({ length: 40 }, (_, i) => race(`m${i}`, 1000 + i * 10));
    const theirs = Array.from({ length: 30 }, (_, i) => race(`t${i}`, 1005 + i * 10));
    const both = JSON.parse(combineRaceHistory(JSON.stringify(mine), JSON.stringify([...theirs, race("m3", 1030)])));
    check("race history: the union within the game's cap", both.length === RACE_HISTORY_MAX);
    check("race history: newest first", both.every((r: { atMs: number }, i: number) => i === 0 || both[i - 1].atMs >= r.atMs) && both[0].id === "m39");
    check("race history: each race once", new Set(both.map((r: { id: string }) => r.id)).size === both.length);
    const firm = JSON.parse(combineRaceHistory(JSON.stringify([race("x", 1, false)]), JSON.stringify([race("x", 1, true)])));
    check("race history: a final result beats a provisional one", firm.length === 1 && firm[0].final === true);

    // Saved setups
    const pa = [preset("1", "Quali", 10), preset("2", "Race", 20)];
    const pb = [preset("3", "Quali", 30, "low"), preset("4", "Wet", 40), preset("5", "Race", 50)];
    const merged = JSON.parse(combinePresets(JSON.stringify(pa), JSON.stringify(pb)));
    const names = merged.map((p: { name: string }) => p.name);
    check("presets: a name clash keeps both, one renamed (2)", names.includes("Quali") && names.includes("Quali (2)") && merged.find((p: { name: string }) => p.name === "Quali (2)")?.id === "3");
    check("presets: the same setup under the same name is kept once", names.filter((n: string) => n.startsWith("Race")).length === 1);
    check("presets: newest first", merged[0].id === "4");
    const thrice = JSON.parse(combinePresets(JSON.stringify([preset("1", "Quali", 1), preset("9", "Quali (2)", 2)]), JSON.stringify([preset("3", "quali", 3, "low")])));
    check("presets: (3) when (2) is taken, names compared without case", thrice.some((p: { name: string; id: string }) => p.name === "quali (3)" && p.id === "3"));
    const byId = JSON.parse(combinePresets(JSON.stringify([preset("1", "Quali", 10)]), JSON.stringify([{ ...preset("1", "Quali", 20, "low") }])));
    check("presets: the same setup by id keeps the newer save", byId.length === 1 && byId[0].aero === "low");
    const many = JSON.parse(combinePresets(JSON.stringify(Array.from({ length: 20 }, (_, i) => preset(`a${i}`, `A${i}`, i))), JSON.stringify(Array.from({ length: 20 }, (_, i) => preset(`b${i}`, `B${i}`, 100 + i)))));
    check("presets: the garage's cap holds, the oldest go", many.length === PRESETS_MAX && many.every((p: { savedAt: number }) => p.savedAt >= 4));
    const presetsKey = "lc.garage.presets.lc26";
    const sides = combineSaves(doc({ keys: { [presetsKey]: { value: JSON.stringify(pa), t: 5 } } }), doc({ keys: { [presetsKey]: { value: JSON.stringify(pb), t: 9 } } }), "combine");
    const sideNames = JSON.parse(sides.keys[presetsKey].value);
    check("presets in a save combine per car on Combine, the cloud's keeping their names", sideNames.find((p: { id: string }) => p.id === "3")?.name === "Quali" && sideNames.find((p: { id: string }) => p.id === "1")?.name === "Quali (2)");

    // Combine, single values: the newer change; a known time over an unknown one; the cloud's on a tie
    const one = (t: number, value: string) => doc({ keys: { "bugesera.vehicle": { value, t } }, settings: { realism: { value, t } } });
    const winner = (lt: number, ct: number, choice: FirstSyncChoice) => {
      const out = combineSaves(one(lt, "local"), one(ct, "cloud"), choice);
      const k = out.keys["bugesera.vehicle"].value;
      const s = out.settings.realism.value;
      return k === s ? k : "split";
    };
    const table: [number, number, string][] = [
      [9, 5, "local"],
      [5, 9, "cloud"],
      [0, 0, "cloud"],
      [7, 0, "local"],
      [0, 7, "cloud"],
      [7, 7, "cloud"],
    ];
    const wrong = table.filter(([lt, ct, want]) => winner(lt, ct, "combine") !== want);
    check("Combine: the newer change, a known time over an unknown one, the cloud's on a tie (6 cases)", wrong.length === 0, JSON.stringify(wrong));
    check("pickSide matches the table", table.every(([lt, ct, want]) => pickSide(lt, ct) === want));
    check(
      "Use the cloud save and Keep this device's save take their side whatever the times",
      [9, 5, 0].every((lt) => [9, 5, 0].every((ct) => winner(lt, ct, "cloud") === "cloud" && winner(lt, ct, "local") === "local"))
    );

    // Use the cloud save / Keep this device's save replace the other side's save; best laps stay combined
    {
      const mineDoc = doc({
        keys: {
          [presetsKey]: { value: JSON.stringify([preset("p1", "Sibling setup", 5)]), t: 9 },
          "librecorsa.raceHistory": { value: JSON.stringify([race("r-local", 5)]), t: 9 },
          "bugesera.tyreSetup.amg-gt3": { value: '{"local":1}', t: 9 },
        },
        settings: { assistPreset: { value: "assisted", t: 9 }, ghost: { value: false, t: 9 } },
        bestLaps: { monza: lapRef(80_000, sha("a")), spa: lapRef(91_000, sha("c")) },
      });
      const theirsDoc = doc({
        keys: {
          [presetsKey]: { value: JSON.stringify([preset("p2", "Mine", 4)]), t: 1 },
          "librecorsa.raceHistory": { value: JSON.stringify([race("r-cloud", 4)]), t: 1 },
          "lc.garage.chassis.lc26": { value: '{"cloud":1}', t: 1 },
        },
        removed: { "bugesera.track": 3 },
        settings: { assistPreset: { value: "pro", t: 1 } },
        bestLaps: { spa: lapRef(90_000, sha("b")) },
      });
      const cloudWins = combineSaves(mineDoc, theirsDoc, "cloud");
      check(
        "Use the cloud save: the account's setups, races and settings as they are, newer local changes or not",
        cloudWins.keys[presetsKey].value === theirsDoc.keys[presetsKey].value &&
          cloudWins.keys["librecorsa.raceHistory"].value === theirsDoc.keys["librecorsa.raceHistory"].value &&
          cloudWins.settings.assistPreset.value === "pro" &&
          cloudWins.removed["bugesera.track"] === 3
      );
      check("Use the cloud save: a key only this device has is left out, and taken off it", !cloudWins.keys["bugesera.tyreSetup.amg-gt3"] && same(Object.keys(dropsOf(mineDoc, cloudWins)), ["bugesera.tyreSetup.amg-gt3"]));
      check("Use the cloud save: a settings field the account lacks stays", cloudWins.settings.ghost?.value === false);
      const localWins = combineSaves(mineDoc, theirsDoc, "local");
      check(
        "Keep this device's save: this device's setups, races and settings as they are, and the account's other keys go",
        localWins.keys[presetsKey].value === mineDoc.keys[presetsKey].value &&
          localWins.keys["librecorsa.raceHistory"].value === mineDoc.keys["librecorsa.raceHistory"].value &&
          localWins.settings.assistPreset.value === "assisted" &&
          !localWins.keys["lc.garage.chassis.lc26"] &&
          localWins.removed["bugesera.track"] === undefined
      );
      check(
        "both choices keep both sides' best laps, the faster one where both have one",
        [cloudWins, localWins].every((d) => d.bestLaps.monza?.ghost === sha("a") && d.bestLaps.spa?.ghost === sha("b"))
      );
    }

    const kept = combineSaves(doc({ keys: { "bugesera.track": { value: "a", t: 3 } } }), doc({ keys: { "librecorsa.carSkins": { value: "{}", t: 3 } } }), "combine");
    check("a value on one side only is kept", kept.keys["bugesera.track"]?.value === "a" && kept.keys["librecorsa.carSkins"]?.value === "{}");

    // Tombstones
    const gone = doc({ removed: { "bugesera.tyreSetup": 50 } });
    const there = (t: number) => doc({ keys: { "bugesera.tyreSetup": { value: "{}", t } } });
    const r1 = combineSaves(gone, there(40), "combine");
    check("a removal newer than the value removes it", !r1.keys["bugesera.tyreSetup"] && r1.removed["bugesera.tyreSetup"] === 50);
    const r2 = combineSaves(gone, there(60), "combine");
    check("a value newer than the removal stays", r2.keys["bugesera.tyreSetup"]?.value === "{}" && r2.removed["bugesera.tyreSetup"] === undefined);
    check("a removal beats a value of unknown time on combine", !combineSaves(gone, there(0), "combine").keys["bugesera.tyreSetup"]);
    check("a removal on the cloud side reaches this device", !combineSaves(there(10), doc({ removed: { "bugesera.tyreSetup": 20 } }), "combine").keys["bugesera.tyreSetup"]);

    // Three ways, against the base
    const oldList = JSON.stringify([preset("1", "Quali", 1), preset("2", "Race", 2)]);
    const newList = JSON.stringify([preset("2", "Race", 2)]);
    const baseOf = (value: string) => {
      const s = collect(memoryStorage({ [presetsKey]: value }), emptySyncState(), { now: 1, savedBy: "" });
      return { keys: { [presetsKey]: Object.values(s.state.keys)[0].h }, settings: {} };
    };
    const deleted = combineSaves(doc({ keys: { [presetsKey]: { value: oldList, t: 0 } } }), doc({ keys: { [presetsKey]: { value: newList, t: 0 } } }), "combine", { base: baseOf(oldList) });
    check("three ways: a setup deleted on another device stays deleted", deleted.keys[presetsKey].value === newList);
    const unioned = combineSaves(doc({ keys: { [presetsKey]: { value: oldList, t: 0 } } }), doc({ keys: { [presetsKey]: { value: newList, t: 0 } } }), "combine");
    check("without a base the two lists are combined", JSON.parse(unioned.keys[presetsKey].value).length === 2);
    const mineChanged = combineSaves(one(1, "local"), one(5, "base"), "combine", { base: { keys: { "bugesera.vehicle": baseOfValue("base") }, settings: {} } });
    check("three ways: a side still at the base takes the other's change, even an older one", mineChanged.keys["bugesera.vehicle"].value === "local");
    check("junk keys in a save are dropped", !combineSaves(doc({ keys: { "bugesera.driverKey": { value: "k", t: 1 } } }), doc({}), "combine").keys["bugesera.driverKey"]);
  }

  console.log("The first sync");
  {
    const empty = doc({ keys: { "bugesera.vehicle": { value: "lc26", t: 0 } }, settings: { realism: { value: "full", t: 0 } } });
    const full = doc({ keys: { "librecorsa.raceHistory": { value: JSON.stringify([race("r", 1)]), t: 0 }, "lc.garage.presets.lc26": { value: JSON.stringify([preset("1", "A", 1), preset("2", "B", 2)]), t: 0 } }, bestLaps: { k: lapRef(1, sha("a")) } });
    check("settings and the last car alone are an empty save", isEmptySave(empty) && !isEmptySave(full));
    check("a car setup or a livery is not empty", !isEmptySave(doc({ keys: { "lc.garage.chassis.lc26": { value: "{}", t: 0 } } })) && !isEmptySave(doc({ keys: { "librecorsa.carSkins": { value: '{"a":"b"}', t: 0 } } })));
    check("this device has a save, the cloud none: upload", firstSyncDecision(full, null) === "upload");
    check("this device empty, the cloud has one: download", firstSyncDecision(empty, full) === "download");
    check("both have one: ask", firstSyncDecision(full, full) === "ask");
    check("both empty: download (the account's settings win)", firstSyncDecision(empty, empty) === "download");
    const sum = summarizeSave({ ...full, savedAt: 77, savedBy: "Chrome on macOS" }, "cloud");
    check("the summary counts laps, setups and races", sum.bestLaps === 1 && sum.setups === 2 && sum.races === 1 && sum.savedAt === 77 && sum.savedBy === "Chrome on macOS");
    check("this device's summary has no date or writer", summarizeSave(full, "local").savedAt === null && summarizeSave(full, "local").savedBy === null);
  }

  console.log("The sign-in return, the device label, the switches");
  {
    check("#lc-account=<result> reads as that result", AUTH_RESULTS.every((r) => readAuthReturn(`#lc-account=${r}`)?.result === r));
    check("other fragment parts are kept", same(readAuthReturn("#tab=2&lc-account=linked&x=1"), { result: "linked", rest: "tab=2&x=1" }));
    check("an unknown result is stripped without a notice", same(readAuthReturn("#lc-account=hacked"), { result: null, rest: "" }));
    check("no return, nothing to do", readAuthReturn("") === null && readAuthReturn("#tab=2") === null);
    const texts = Object.values(AUTH_NOTICES).map((n) => n.text);
    check("each result has a plain sentence (no exclamation marks, no dashes)", texts.length === AUTH_RESULTS.length && texts.every((t) => /\.$/.test(t) && !/[!—–]/.test(t)));
    check("only a failure reads as an error", Object.entries(AUTH_NOTICES).every(([r, n]) => (n.kind === "error") === (r === "failed")));

    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
    const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    const electron = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) librecorsa-desktop/1.2.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36";
    check("Chrome on macOS", deviceLabelFor(mac) === "Chrome on macOS");
    check("Safari on iOS", deviceLabelFor(iphone) === "Safari on iOS");
    check("Safari on iPadOS (a Mac agent with touch)", deviceLabelFor(ipad, { maxTouchPoints: 5 }) === "Safari on iPadOS" && deviceLabelFor(ipad) === "Safari on macOS");
    check("Edge on Windows", deviceLabelFor(edge) === "Edge on Windows");
    check("Firefox on Linux", deviceLabelFor(firefox) === "Firefox on Linux");
    check("Chrome on Android", deviceLabelFor(android) === "Chrome on Android");
    check("the desktop app", deviceLabelFor(electron) === "LibreCorsa app on Windows");
    check("the store app", deviceLabelFor(android, { storeBuild: true }) === "LibreCorsa app on Android");

    check("accounts are off unless the server says true", !parseOnlineConfig({ board: true }).accounts && !parseOnlineConfig({ accounts: "yes" }).accounts && !parseOnlineConfig(null).accounts);
    const cfg = parseOnlineConfig({ board: true, accounts: true, accountProviders: ["steam", "myspace", "passkey", "steam", 3] });
    check("unknown providers are dropped, each kept once", cfg.accounts && same(cfg.accountProviders, ["steam", "passkey"]));
    check("no providers while accounts are off", same(parseOnlineConfig({ accounts: false, accountProviders: ["discord"] }).accountProviders, []));
    check("a return path the server takes", safeReturnPath("/play") === "/play" && safeReturnPath("/account/") === "/account/" && safeReturnPath("//evil.com") === "/play" && safeReturnPath("https://x") === "/play" && safeReturnPath("/a?b") === "/play");
  }
}

/** For the three-way check: the base hash of a raw stored value */
function baseOfValue(value: string): string {
  const s = collect(memoryStorage({ "bugesera.vehicle": value }), emptySyncState(), { now: 1, savedBy: "" });
  return s.state.keys["bugesera.vehicle"].h;
}

// ---------------------------------------------------------------------------------------------------------------
// The engine against a fake server

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Pending {
  id: number;
  doc: unknown;
}

function fakeServer() {
  const s = {
    rev: 0,
    doc: null as unknown,
    pending: [] as Pending[],
    ghosts: new Map<string, string>(),
    calls: [] as string[],
    savePuts: 0,
    /** Save writes sent with keepalive (the page going away) */
    keepalives: 0,
    ghostPuts: 0,
    ghostGets: 0,
    signedIn: true,
    joined: true,
    /** AccountKey.id of the key the session joined with */
    keyId: createHash("sha256").update("test-driver-key").digest("hex").slice(0, 12) as string | null,
    alwaysConflict: false,
    /** Runs once, just before the next save PUT is looked at: another device writing first */
    beforePut: null as null | (() => void),
    /** A status to refuse the nth ghost upload / download with (the rate limit, too big), or null */
    ghostPutFail: null as null | ((n: number) => number | null),
    ghostGetFail: null as null | ((n: number) => number | null),
    /** /account/device refuses with this sentence, or answers that the key is on another account */
    deviceFail: null as string | null,
    keyElsewhere: false,
    /** Holds ghost downloads until it settles (a slow connection) */
    ghostGate: null as Promise<void> | null,
    account(): AccountInfo {
      return {
        id: "acc1",
        createdAt: 1,
        driverName: "Alp",
        names: [],
        identities: [{ provider: "discord", linkedAt: 1, lastUsedAt: 1 }],
        passkeys: [{ id: "pk", label: "Passkey", createdAt: 1, lastUsedAt: null }],
        sessions: [],
        // The key the session joined with, as the server marks it (the first 12 hex of its SHA-256)
        keys: s.joined && s.keyId ? [{ id: s.keyId, label: "Test", addedAt: 1, lastUsedAt: null, current: true }] : [],
        save: s.rev ? { rev: s.rev, updatedAt: 1, bytes: 1 } : null,
        pendingMerges: s.pending.length,
      };
    },
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      const path = new URL(url).pathname.replace(/^\/api/, "");
      const method = init.method ?? "GET";
      s.calls.push(`${method} ${path}`);
      if (!s.signedIn) return json(401, { ok: false, error: "Signed out", signedOut: true });
      const body = typeof init.body === "string" && method !== "PUT" ? JSON.parse(init.body) : null;
      if (path === "/account" && method === "GET") return json(200, { ok: true, account: s.account(), thisDevice: { joined: s.joined } });
      if (path === "/account/device") {
        if (s.deviceFail) return json(400, { ok: false, error: s.deviceFail });
        s.joined = true;
        // A key on another account stays there: the session has no current key on this one
        s.keyId = s.keyElsewhere ? null : createHash("sha256").update(String(body?.driverKey)).digest("hex").slice(0, 12);
        return json(200, { ok: true, attached: s.keyElsewhere ? [] : ["alp"], elsewhere: ["other"], keyElsewhere: s.keyElsewhere });
      }
      if (path === "/auth/signout") {
        s.signedIn = false;
        return json(200, { ok: true });
      }
      if (path === "/account/save" && method === "GET") return json(200, { ok: true, rev: s.rev, updatedAt: s.rev ? 1 : null, doc: s.doc, pending: s.pending });
      if (path === "/account/save" && method === "PUT") {
        s.savePuts++;
        if (init.keepalive) s.keepalives++;
        const hook = s.beforePut;
        s.beforePut = null;
        hook?.();
        const req = JSON.parse(init.body as string);
        if (s.alwaysConflict) s.rev++;
        if (s.alwaysConflict || req.baseRev !== s.rev) return json(409, { ok: false, error: "Changed", conflict: true, rev: s.rev, doc: s.doc });
        s.rev++;
        s.doc = req.doc;
        s.pending = s.pending.filter((p) => !req.combinedPending.includes(p.id));
        return json(200, { ok: true, rev: s.rev, updatedAt: 1 });
      }
      if (path === "/account/ghosts/missing") return json(200, { ok: true, missing: body.shas.filter((x: string) => !s.ghosts.has(x)) });
      const ghost = path.match(/^\/account\/ghosts\/([0-9a-f]{64})$/);
      if (ghost && method === "PUT") {
        s.ghostPuts++;
        const refused = s.ghostPutFail?.(s.ghostPuts);
        if (refused) return json(refused, { ok: false, error: "Refused" });
        const text = init.body as string;
        if ((await sha256Hex(text)) !== ghost[1]) return json(400, { ok: false, error: "Hash" });
        s.ghosts.set(ghost[1], text);
        return json(200, { ok: true });
      }
      if (ghost && method === "GET") {
        if (s.ghostGate) await s.ghostGate;
        s.ghostGets++;
        const refused = s.ghostGetFail?.(s.ghostGets);
        if (refused) return json(refused, { ok: false, error: "Refused" });
        const text = s.ghosts.get(ghost[1]);
        return text ? new Response(text, { status: 200 }) : json(404, { ok: false, error: "Not found" });
      }
      return json(404, { ok: false, error: "Accounts are off" });
    },
  };
  return s;
}

/** Best laps in memory, keyed like ghost-store (the lap's own key), kept when new or faster */
function memoryGhosts(init: Record<string, unknown>[] = []): LocalGhosts & { laps: Map<string, string>; store: { refuse: boolean } } {
  const laps = new Map<string, string>();
  /** `refuse`: the store is full or blocked, nothing is kept */
  const store = { refuse: false };
  const keyOf = (lap: { trackId: string; vehicle: string; board: string }) => `${lap.trackId}|${lap.vehicle}|${lap.board}`;
  const put = (text: string): boolean => {
    const lap = JSON.parse(text);
    const key = keyOf(lap);
    const had = laps.get(key);
    if (had && JSON.parse(had).lapTimeMs <= lap.lapTimeMs) return false;
    laps.set(key, text);
    return true;
  };
  for (const lap of init) put(JSON.stringify(lap));
  return {
    laps,
    async list() {
      return [...laps.entries()].map(([key, text]) => {
        const l = JSON.parse(text);
        return { key, trackId: l.trackId, vehicle: l.vehicle, lapTimeMs: l.lapTimeMs, recordedAt: l.recordedAt };
      });
    },
    async text(key) {
      return laps.get(key) ?? null;
    },
    async save(text) {
      if (store.refuse) return "failed";
      return put(text) ? "kept" : "skipped";
    },
    store,
  };
}

const lap = (trackId: string, lapTimeMs: number, extra: Record<string, unknown> = {}) => ({ trackId, vehicle: "lc26", board: "p1-pro-full-dry", lapTimeMs, recordedAt: lapTimeMs, samples: [1, 2, 3], ...extra });

function device(server: ReturnType<typeof fakeServer>, name: string, storage: StorageLike, ghosts: LocalGhosts, clock: { t: number }) {
  const api = createAccountApi({ base: "http://test/api", fetch: (u, i) => server.fetch(u, i) });
  return createSyncEngine({ api, storage, ghosts, sha256: sha256Hex, now: () => clock.t, label: () => name });
}

const stateOf = (s: StorageLike): SyncState => parseSyncState(s.getItem(SYNC_STATE_KEY));
const cloudDoc = (server: ReturnType<typeof fakeServer>) => server.doc as SaveDoc;

async function main2(): Promise<void> {
  console.log("The sync engine against a fake server");
  const server = fakeServer();
  const clock = { t: 1_000 };
  const aStore = memoryStorage({
    [SETTINGS_KEY]: settingsWith({ profile: { name: "Alp", code: "ALP", color: "#112233", generated: false, autoUpload: true } }),
    "bugesera.vehicle": "amg-gt3",
    "lc.garage.presets.lc26": JSON.stringify([preset("1", "Quali", 1), preset("2", "Race", 2)]),
    "librecorsa.raceHistory": JSON.stringify([race("r1", 100)]),
    "bugesera.driverKey": "device-a-key",
  });
  const aLaps = memoryGhosts([lap("t1", 90_000)]);
  const a = device(server, "Device A", aStore, aLaps, clock);

  // Push: the first sync with an empty cloud uploads
  const up = await a.sync({ accountId: "acc1", apply: true });
  check("first sync, cloud empty: uploaded without a question", up.kind === "synced" && up.pushed && server.rev === 1, JSON.stringify(up));
  check("the cloud save holds the synced keys and not the driver key", !!cloudDoc(server).keys["lc.garage.presets.lc26"] && !JSON.stringify(server.doc).includes("device-a-key"));
  check("the lap's ghost went up once, by its hash", server.ghostPuts === 1 && server.ghosts.size === 1 && Object.values(cloudDoc(server).bestLaps)[0].ghost === [...server.ghosts.keys()][0]);
  check("this device keeps a record of the sync", stateOf(aStore).account?.rev === 1 && stateOf(aStore).account?.appliedRev === 1);

  const puts = server.savePuts;
  clock.t = 2_000;
  const idle = await a.sync({ accountId: "acc1", apply: false });
  check("nothing changed: nothing is written", idle.kind === "synced" && !idle.pushed && server.savePuts === puts && server.rev === 1);
  check("nothing changed: changedSince says so", !(await a.changedSince("acc1")));

  clock.t = 3_000;
  aStore.setItem("bugesera.vehicle", "lc26");
  check("a change: changedSince says so", await a.changedSince("acc1"));
  const pushed = await a.sync({ accountId: "acc1", apply: false });
  check("a change goes up", pushed.kind === "synced" && pushed.pushed && server.rev === 2 && cloudDoc(server).keys["bugesera.vehicle"].value === "lc26");
  check("its change time goes with it", cloudDoc(server).keys["bugesera.vehicle"].t === 3_000);

  // Pull: an empty second device downloads, settings of its own kept
  const bStore = memoryStorage({
    [SETTINGS_KEY]: settingsWith({ graphics: { ...DEFAULT_PLAYER_SETTINGS.graphics, quality: "low" } }),
    "bugesera.driverKey": "device-b-key",
  });
  const bLaps = memoryGhosts();
  const b = device(server, "Device B", bStore, bLaps, clock);
  const putsBefore = server.savePuts;
  const down = await b.sync({ accountId: "acc1", apply: true });
  const bSettings = JSON.parse(bStore.getItem(SETTINGS_KEY) as string);
  check("first sync, this device empty: downloaded without a question", down.kind === "synced" && down.changedLocal && !down.pushed && server.savePuts === putsBefore, JSON.stringify(down));
  check("the download wrote the synced keys", bStore.getItem("bugesera.vehicle") === "lc26" && bStore.getItem("lc.garage.presets.lc26") === aStore.getItem("lc.garage.presets.lc26"));
  check("the download took the account's settings and kept this device's", bSettings.profile.name === "Alp" && bSettings.graphics.quality === "low");
  check("the ghost came down through the save path", bLaps.laps.size === 1 && server.ghostGets === 1);
  const again = await b.sync({ accountId: "acc1", apply: true });
  check("a ghost already here is not fetched again", again.kind === "synced" && server.ghostGets === 1 && !again.changedLocal);

  // Ghost dedupe: a third device with the same lap and saves of its own
  const cStore = memoryStorage({ "lc.garage.presets.lc26": JSON.stringify([preset("9", "Quali", 9, "low")]), "librecorsa.raceHistory": JSON.stringify([race("r9", 900)]) });
  const cLaps = memoryGhosts([lap("t1", 90_000), lap("t2", 70_000)]);
  const c = device(server, "Device C", cStore, cLaps, clock);
  const ask = await c.sync({ accountId: "acc1", apply: true });
  check("first sync, both hold a save: the player is asked", ask.kind === "ask" && ask.local.setups === 1 && ask.cloud.setups === 2 && ask.cloud.bestLaps === 1 && ask.cloud.savedBy === "Device A", JSON.stringify(ask));
  check("nothing went up while asking", server.rev === 2);
  const ghostPutsBefore = server.ghostPuts;
  clock.t = 4_000;
  const combined = await c.sync({ accountId: "acc1", apply: true, choice: "combine" });
  check("Combine: written and applied", combined.kind === "synced" && combined.pushed && combined.changedLocal && server.rev === 3);
  check("a ghost the cloud has (same hash) is not sent again", server.ghostPuts === ghostPutsBefore + 1 && server.ghosts.size === 2);
  const cPresets = JSON.parse(cStore.getItem("lc.garage.presets.lc26") as string).map((p: { name: string }) => p.name);
  check("Combine: saved setups of both, the clash renamed", sorted(cPresets).join() === ["Quali", "Quali (2)", "Race"].join(), cPresets.join());
  check("Combine: races of both", JSON.parse(cStore.getItem("librecorsa.raceHistory") as string).length === 2);

  // 409: another device writes between this one's read and write
  clock.t = 5_000;
  await a.sync({ accountId: "acc1", apply: true });
  aStore.setItem("bugesera.track", "monza");
  server.beforePut = () => {
    const d = structuredClone(cloudDoc(server));
    d.keys["librecorsa.f1ModPhysics"] = { value: "lc26", t: 5_500 };
    server.doc = d;
    server.rev++;
  };
  const putsAt = server.savePuts;
  clock.t = 6_000;
  const raced = await a.sync({ accountId: "acc1", apply: true });
  check("409: combined with what the cloud has now and written again", raced.kind === "synced" && raced.pushed && server.savePuts === putsAt + 2, JSON.stringify(raced));
  check("409: both devices' changes are in the save", cloudDoc(server).keys["bugesera.track"]?.value === "monza" && cloudDoc(server).keys["librecorsa.f1ModPhysics"]?.value === "lc26");
  check("409: the other device's change reached this one", aStore.getItem("librecorsa.f1ModPhysics") === "lc26");

  server.alwaysConflict = true;
  aStore.setItem("bugesera.track", "spa");
  const putsBusy = server.savePuts;
  const busy = await a.sync({ accountId: "acc1", apply: false });
  check(`409 every time: gives up after ${MAX_TRIES} writes`, busy.kind === "failed" && busy.error === BUSY && server.savePuts === putsBusy + MAX_TRIES);
  server.alwaysConflict = false;

  // A folded account's save waiting to be combined
  const folded = doc({
    savedBy: "Old phone",
    keys: { "lc.garage.presets.amg-gt3": { value: JSON.stringify([preset("f1", "Old setup", 3)]), t: 0 } },
    bestLaps: {},
  });
  const foldedLap = JSON.stringify(lap("t3", 60_000));
  const foldedSha = await sha256Hex(foldedLap);
  server.ghosts.set(foldedSha, foldedLap);
  folded.bestLaps["t3|lc26|p1-pro-full-dry"] = { trackId: "t3", vehicle: "lc26", lapTimeMs: 60_000, recordedAt: 60_000, ghost: foldedSha };
  server.pending = [{ id: 7, doc: folded }];
  clock.t = 7_000;
  const merged = await a.sync({ accountId: "acc1", apply: false });
  check("a folded account's save is combined without a question", merged.kind === "synced" && merged.pushed && server.pending.length === 0, JSON.stringify(merged));
  check("its setups and laps are in the account's save", !!cloudDoc(server).keys["lc.garage.presets.amg-gt3"] && !!cloudDoc(server).bestLaps["t3|lc26|p1-pro-full-dry"]);
  check("not applied: the values wait for the next start", merged.kind === "synced" && merged.deferred && aStore.getItem("lc.garage.presets.amg-gt3") === null);
  check("not applied: the record says so", (stateOf(aStore).account?.appliedRev ?? 0) < (stateOf(aStore).account?.rev ?? 0));
  check("ghosts come in even when the values wait", aLaps.laps.has("t3|lc26|p1-pro-full-dry"));
  const periodic = await a.sync({ accountId: "acc1", apply: false });
  check("a later sync that may not apply sends nothing", periodic.kind === "synced" && !periodic.pushed);
  const start = await a.sync({ accountId: "acc1", apply: () => true });
  check("the next start applies them", start.kind === "synced" && start.changedLocal && aStore.getItem("lc.garage.presets.amg-gt3") !== null && stateOf(aStore).account?.appliedRev === stateOf(aStore).account?.rev);

  // A deletion on one device sticks on the others (three-way against the base)
  clock.t = 8_000;
  await b.sync({ accountId: "acc1", apply: true });
  const bBefore = JSON.parse(bStore.getItem("lc.garage.presets.lc26") as string);
  aStore.setItem("lc.garage.presets.lc26", JSON.stringify(JSON.parse(aStore.getItem("lc.garage.presets.lc26") as string).filter((p: { name: string }) => p.name !== "Race")));
  clock.t = 9_000;
  await a.sync({ accountId: "acc1", apply: true });
  clock.t = 10_000;
  await b.sync({ accountId: "acc1", apply: true });
  const bAfter = JSON.parse(bStore.getItem("lc.garage.presets.lc26") as string);
  check("a setup deleted on one device is deleted on the other", bBefore.some((p: { name: string }) => p.name === "Race") && !bAfter.some((p: { name: string }) => p.name === "Race"));

  // Failures
  server.doc = { v: 2, keys: {} };
  const putsNewer = server.savePuts;
  const newer = await a.sync({ accountId: "acc1", apply: true });
  check("a newer version's cloud save is never written over", newer.kind === "failed" && newer.error === NEWER_SAVE && server.savePuts === putsNewer);
  server.signedIn = false;
  const out = await a.sync({ accountId: "acc1", apply: true });
  check("a 401 reads as signed out", out.kind === "failed" && out.signedOut === true);
  const noStorage = createSyncEngine({ api: createAccountApi({ base: "http://test/api", fetch: (u, i) => server.fetch(u, i) }), storage: null, ghosts: null, sha256: null, now: () => 1, label: () => "x" });
  check("no storage: a sentence, no throw", (await noStorage.sync({ accountId: "acc1", apply: true })).kind === "failed");

  {
    // Leaving (the page hidden or going away): a read of the cloud's save first would not come back before the page
    // is gone, and the write after it would never go out. One keepalive write from the cloud's save as this page last
    // saw it, no ghosts
    const server = fakeServer();
    const clock = { t: 1_000 };
    const store = memoryStorage({ "bugesera.track": "spa", "lc.garage.presets.lc26": JSON.stringify([preset("1", "Quali", 1)]) });
    const laps = memoryGhosts();
    const leaver = device(server, "Leaver", store, laps, clock);
    await leaver.sync({ accountId: "acc1", apply: true });
    clock.t = 2_000;
    store.setItem("bugesera.track", "monza");
    await laps.save(JSON.stringify(lap("vir", 95_000)));
    const from = server.calls.length;
    const out = await leaver.sync({ accountId: "acc1", apply: false, leaving: true });
    check(
      "leaving: one keepalive write, no read of the cloud's save before it and no ghosts",
      out.kind === "synced" && out.pushed && same(server.calls.slice(from), ["PUT /account/save"]) && server.keepalives === 1,
      server.calls.slice(from).join(),
    );
    check("leaving: the change is in the cloud, the new lap's ghost waits", cloudDoc(server).keys["bugesera.track"]?.value === "monza" && Object.keys(cloudDoc(server).bestLaps).length === 0);
    check("the lap held back reads as a change, and the next sync sends it", (await leaver.changedSince("acc1")) && (await leaver.sync({ accountId: "acc1", apply: false })).kind === "synced" && Object.keys(cloudDoc(server).bestLaps).length === 1 && server.ghostPuts === 1);

    // Another device wrote since: the quick write is refused, then combined with what it wrote
    clock.t = 3_000;
    const other = structuredClone(cloudDoc(server));
    other.keys["bugesera.vehicle"] = { value: "chaparral-2d", t: 2_500 };
    server.doc = other;
    server.rev++;
    store.setItem("bugesera.track", "imola");
    const again = await leaver.sync({ accountId: "acc1", apply: false, leaving: true });
    check(
      "leaving after another device wrote: refused, then both changes are kept",
      again.kind === "synced" && cloudDoc(server).keys["bugesera.vehicle"]?.value === "chaparral-2d" && cloudDoc(server).keys["bugesera.track"]?.value === "imola",
    );

    // A new page with nothing to sync on start reads the cloud's save once (prime), so leaving still takes one request
    const page = device(server, "Leaver", store, laps, clock);
    await page.prime("acc1");
    store.setItem("bugesera.track", "suzuka");
    const at = server.calls.length;
    const left = await page.sync({ accountId: "acc1", apply: false, leaving: true });
    check(
      "a page that only primed: leaving is one write",
      left.kind === "synced" && same(server.calls.slice(at), ["PUT /account/save"]) && cloudDoc(server).keys["bugesera.track"]?.value === "suzuka",
      server.calls.slice(at).join(),
    );
  }

  {
    // A fresh device downloads the account's save as it is: settings it changed while setting up (stamped later than
    // the account's) don't win over the account's
    const server = fakeServer();
    const clock = { t: 1_000 };
    const favorites = { favorites: { cars: ["lc26", "amg-gt3"], circuits: ["spa"] }, recent: { cars: ["lc26"], circuits: ["spa"] } };
    server.doc = doc({ savedBy: "PC", settings: { assistPreset: { value: "pro", t: 500 }, library: { value: favorites, t: 500 } } });
    server.rev = 1;
    const fresh = memoryStorage({ [SETTINGS_KEY]: settingsWith({}) });
    const phone = device(server, "Phone", fresh, memoryGhosts(), clock);
    phone.track();
    clock.t = 2_000;
    fresh.setItem(SETTINGS_KEY, settingsWith({ assistPreset: "assisted", library: { favorites: { cars: [], circuits: [] }, recent: { cars: ["amg-gt3"], circuits: ["monza"] } } }));
    const got = await phone.sync({ accountId: "acc1", apply: true });
    const after = JSON.parse(fresh.getItem(SETTINGS_KEY) as string);
    check("an empty device downloads the account's settings as they are", got.kind === "synced" && after.assistPreset === "pro" && same(after.library, favorites), JSON.stringify(after.library));

    // Use the cloud save: this device's own setups go, its keys the account lacks too; nothing of them goes up
    const cloudSave = () =>
      doc({ savedBy: "PC", keys: { "lc.garage.presets.lc26": { value: JSON.stringify([preset("p2", "Mine", 4)]), t: 1 }, "librecorsa.raceHistory": { value: JSON.stringify([race("r-cloud", 4)]), t: 1 } } });
    const own = () =>
      memoryStorage({
        "lc.garage.presets.lc26": JSON.stringify([preset("p1", "Sibling setup", 5)]),
        "bugesera.tyreSetup.amg-gt3": '{"local":1}',
        "librecorsa.raceHistory": JSON.stringify([race("r-local", 5)]),
      });
    const s1 = fakeServer();
    s1.doc = cloudSave();
    s1.rev = 1;
    const st1 = own();
    const d1 = device(s1, "Phone", st1, memoryGhosts(), clock);
    const asked = await d1.sync({ accountId: "acc1", apply: true });
    const took = await d1.sync({ accountId: "acc1", apply: true, choice: "cloud" });
    check(
      "Use the cloud save: this device's setups and races are replaced, its own tyre setup goes",
      asked.kind === "ask" && took.kind === "synced" && took.changedLocal && st1.getItem("lc.garage.presets.lc26") === cloudSave().keys["lc.garage.presets.lc26"].value && st1.getItem("bugesera.tyreSetup.amg-gt3") === null && st1.getItem("librecorsa.raceHistory") === cloudSave().keys["librecorsa.raceHistory"].value
    );
    check("Use the cloud save: nothing of this device's went up", s1.savePuts === 0 && s1.rev === 1);

    // The same, chosen where the game can't reload (the values wait): later syncs send none of it, the next start takes it
    const s2 = fakeServer();
    s2.doc = cloudSave();
    s2.rev = 1;
    const st2 = own();
    const d2 = device(s2, "Phone", st2, memoryGhosts(), clock);
    const waited = await d2.sync({ accountId: "acc1", apply: false, choice: "cloud" });
    check("Use the cloud save, not applied yet: this device is untouched and the values wait", waited.kind === "synced" && waited.deferred && st2.getItem("bugesera.tyreSetup.amg-gt3") !== null);
    clock.t = 3_000;
    const between = await d2.sync({ accountId: "acc1", apply: false });
    check("in between, this device's replaced save doesn't go up", between.kind === "synced" && !between.pushed && !(s2.doc as SaveDoc).keys["bugesera.tyreSetup.amg-gt3"]);
    const next = await d2.sync({ accountId: "acc1", apply: () => true });
    check(
      "the next start takes the account's save as it is",
      next.kind === "synced" && next.changedLocal && st2.getItem("bugesera.tyreSetup.amg-gt3") === null && st2.getItem("lc.garage.presets.lc26") === cloudSave().keys["lc.garage.presets.lc26"].value
    );

    // Keep this device's save on another device: the account's keys that device lacks leave this one at its next start
    const s3 = fakeServer();
    const st3 = memoryStorage({ "lc.garage.chassis.lc26": '{"a":1}', "librecorsa.raceHistory": JSON.stringify([race("r1", 1)]) });
    const pc = device(s3, "PC", st3, memoryGhosts(), clock);
    await pc.sync({ accountId: "acc1", apply: true });
    const phoneStore = memoryStorage({ "librecorsa.raceHistory": JSON.stringify([race("r2", 2)]) });
    const keeper = device(s3, "Phone", phoneStore, memoryGhosts(), clock);
    clock.t = 4_000;
    const kept = await keeper.sync({ accountId: "acc1", apply: true, choice: "local" });
    check("Keep this device's save: the account holds this device's save as it is", kept.kind === "synced" && kept.pushed && !(s3.doc as SaveDoc).keys["lc.garage.chassis.lc26"] && (s3.doc as SaveDoc).keys["librecorsa.raceHistory"].value === phoneStore.getItem("librecorsa.raceHistory"));
    clock.t = 5_000;
    const pcLater = await pc.sync({ accountId: "acc1", apply: false });
    check("the other device doesn't send back what the account let go", pcLater.kind === "synced" && !pcLater.pushed && !(s3.doc as SaveDoc).keys["lc.garage.chassis.lc26"] && pcLater.deferred);
    const pcStart = await pc.sync({ accountId: "acc1", apply: () => true });
    check("the other device takes the account's save at its next start", pcStart.kind === "synced" && st3.getItem("lc.garage.chassis.lc26") === null && st3.getItem("librecorsa.raceHistory") === phoneStore.getItem("librecorsa.raceHistory"));
  }

  {
    // Storage full for the cloud's newer value of one key: it waits, and the next sync doesn't send the old one over it
    const server = fakeServer();
    const clock = { t: 1_000 };
    const st = memoryStorage({ "lc.garage.chassis.amg-gt3": '{"wing":1}' });
    let full = false;
    const setItem = st.setItem;
    st.setItem = (k, v) => {
      if (full && k === "lc.garage.chassis.amg-gt3") throw new Error("QuotaExceededError");
      setItem(k, v);
    };
    const engine = device(server, "This", st, memoryGhosts(), clock);
    await engine.sync({ accountId: "acc1", apply: true });
    const newer = structuredClone(cloudDoc(server));
    newer.keys["lc.garage.chassis.amg-gt3"] = { value: '{"wing":9}', t: 50_000 };
    server.doc = newer;
    server.rev++;
    clock.t = 60_000;
    full = true;
    const blocked = await engine.sync({ accountId: "acc1", apply: true });
    full = false;
    check(
      "storage full: the value that couldn't be written waits, and the sync says so",
      blocked.kind === "synced" && blocked.deferred && st.getItem("lc.garage.chassis.amg-gt3") === '{"wing":1}' && (engine.record("acc1")?.appliedRev ?? 0) < server.rev
    );
    clock.t = 70_000;
    const later = await engine.sync({ accountId: "acc1", apply: false });
    check("storage full: the next sync doesn't send this device's old value over the newer one", later.kind === "synced" && !later.pushed && cloudDoc(server).keys["lc.garage.chassis.amg-gt3"].value === '{"wing":9}');
    const retried = await engine.sync({ accountId: "acc1", apply: () => true });
    check("storage full: the next start writes it", retried.kind === "synced" && st.getItem("lc.garage.chassis.amg-gt3") === '{"wing":9}');
  }

  {
    // A save from a newer build: a synced key, a settings field and an audio member this build doesn't know
    const newerBuild = () =>
      doc({
        savedBy: "Newer build",
        keys: { "lc.garage.wheels.gt3": { value: '{"rim":18}', t: 5 }, "bugesera.track": { value: "spa", t: 5 } },
        settings: { pitStrategy: { value: { stops: 2 }, t: 5 }, audio: { value: { musicOff: [], spatial: true }, t: 5 } },
      });
    const mineNow = doc({ keys: { "bugesera.track": { value: "monza", t: 9 } }, settings: { audio: { value: { musicOff: ["t1"] }, t: 9 } } });
    const kept = (["combine", "cloud", "local"] as const).every((choice) => {
      const out = combineSaves(mineNow, readSaveDoc(newerBuild()) as SaveDoc, choice);
      const audio = out.settings.audio?.value as Record<string, unknown>;
      return out.keys["lc.garage.wheels.gt3"]?.value === '{"rim":18}' && same(out.settings.pitStrategy?.value, { stops: 2 }) && audio?.spatial === true;
    });
    check("a newer build's keys, fields and audio members are kept under every choice", kept);
    const won = combineSaves(mineNow, readSaveDoc(newerBuild()) as SaveDoc, "combine").settings.audio.value as Record<string, unknown>;
    check("this device's newer audio choice wins and the unknown member stays with it", same(won.musicOff, ["t1"]) && won.spatial === true);

    const server = fakeServer();
    server.doc = newerBuild();
    server.rev = 1;
    const clock = { t: 1_000 };
    const st = memoryStorage({ [SETTINGS_KEY]: settingsWith({}) });
    const older = device(server, "Older build", st, memoryGhosts(), clock);
    await older.sync({ accountId: "acc1", apply: true });
    const stored = JSON.parse(st.getItem(SETTINGS_KEY) as string);
    check("they are never written into this device's storage", st.getItem("lc.garage.wheels.gt3") === null && stored.pitStrategy === undefined && stored.audio.spatial === undefined);
    clock.t = 2_000;
    st.setItem("bugesera.track", "imola");
    const pushed = await older.sync({ accountId: "acc1", apply: false });
    const up = cloudDoc(server);
    check(
      "an older build's write keeps them",
      pushed.kind === "synced" && pushed.pushed && up.keys["bugesera.track"].value === "imola" && up.keys["lc.garage.wheels.gt3"]?.value === '{"rim":18}' && same(up.settings.pitStrategy?.value, { stops: 2 }) && (up.settings.audio?.value as Record<string, unknown>).spatial === true
    );
    const idle = await older.sync({ accountId: "acc1", apply: false });
    check("nothing changed: an older build doesn't rewrite the newer save", idle.kind === "synced" && !idle.pushed);
  }

  {
    // A ghost upload refused by the rate limit: the lap waits, and the sync isn't done with it
    const server = fakeServer();
    const clock = { t: 1_000 };
    const laps = memoryGhosts([lap("t0", 90_000), lap("t1", 90_001), lap("t2", 90_002)]);
    const pc = device(server, "PC", memoryStorage({ "bugesera.track": "spa" }), laps, clock);
    server.ghostPutFail = (n) => (n === 3 ? 429 : null);
    const first = await pc.sync({ accountId: "acc1", apply: true });
    check("a ghost refused by the rate limit leaves its lap out for now", first.kind === "synced" && Object.keys(cloudDoc(server).bestLaps).length === 2);
    check("the sync isn't recorded as done with it: the next check syncs again", await pc.changedSince("acc1"));
    server.ghostPutFail = null;
    const again = await pc.sync({ accountId: "acc1", apply: false });
    check("the next sync sends it", again.kind === "synced" && again.pushed && Object.keys(cloudDoc(server).bestLaps).length === 3 && !(await pc.changedSince("acc1")));

    // Refused for good (too big): left out, and not tried again and again
    const s2 = fakeServer();
    const big = device(s2, "PC", memoryStorage(), memoryGhosts([lap("t9", 80_000)]), clock);
    s2.ghostPutFail = () => 413;
    await big.sync({ accountId: "acc1", apply: true });
    check("a ghost refused for good is left out without a retry", Object.keys((s2.doc as SaveDoc).bestLaps).length === 0 && !(await big.changedSince("acc1")));

    // A download refused by the rate limit, and one the store couldn't keep: both are fetched again
    const phoneLaps = memoryGhosts();
    const phone = device(server, "Phone", memoryStorage(), phoneLaps, clock);
    server.ghostGetFail = (n) => (n === 1 ? 429 : null);
    await phone.sync({ accountId: "acc1", apply: true });
    check("a download refused by the rate limit: the sync isn't done, the next one fetches", (await phone.changedSince("acc1")) && phoneLaps.laps.size === 0);
    server.ghostGetFail = null;
    phoneLaps.store.refuse = true;
    const gets = server.ghostGets;
    await phone.sync({ accountId: "acc1", apply: true });
    check("a ghost the store couldn't keep isn't counted as fetched, and the rest wait", phoneLaps.laps.size === 0 && server.ghostGets === gets + 1 && (await phone.changedSince("acc1")));
    phoneLaps.store.refuse = false;
    await phone.sync({ accountId: "acc1", apply: true });
    check("once the store takes them, they all come down", phoneLaps.laps.size === 3 && !(await phone.changedSince("acc1")));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The store

async function settle(until: () => boolean = () => false, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !until(); i++) await new Promise((r) => setImmediate(r));
}

function fakeEnv(server: ReturnType<typeof fakeServer>, opts: { accounts: boolean; hash?: string; storage?: StorageLike; laps?: LocalGhosts; providers?: string[] }) {
  const clock = { t: 100_000 };
  const timers: { fn: () => void; ms: number }[] = [];
  const log = { hashes: [] as string[], reloads: 0, navigations: [] as string[], configWatch: 0 };
  /** What is on screen: the title menu (the default), the loading screen, or neither (the pause menu, a session) */
  const screen = { title: true, loading: false };
  /** What the store does when the page is hidden (false) or goes away (true) */
  const leave = { cb: null as ((leaving: boolean) => void) | null };
  const storage = opts.storage ?? memoryStorage();
  const api = createAccountApi({ base: "http://test/api", fetch: (u, i) => server.fetch(u, i) });
  const session = new Map<string, string>();
  const env: AccountStoreEnv = {
    api,
    sync: createSyncEngine({ api, storage, ghosts: opts.laps ?? memoryGhosts(), sha256: sha256Hex, now: () => clock.t, label: () => "Test on Device" }),
    watchConfig(cb) {
      log.configWatch++;
      cb({ accounts: opts.accounts, providers: (opts.providers ?? ["discord", "passkey"]) as never });
      return () => {};
    },
    now: () => clock.t,
    setTimer(fn, ms) {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer(id) {
      const at = timers.indexOf(id as (typeof timers)[number]);
      if (at >= 0) timers.splice(at, 1);
    },
    readHash: () => opts.hash ?? "",
    setHash: (rest) => void log.hashes.push(rest),
    navigate: (url) => void log.navigations.push(url),
    reload: () => void log.reloads++,
    session: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => void session.set(k, v) },
    deviceLabel: () => "Test on Device",
    driverKey: () => "test-driver-key",
    driverName: () => "Alp",
    returnPath: () => "/play",
    passkey: async () => ({}),
    loadingScreen: () => screen.loading,
    titleMenu: () => screen.title,
    onLeave(cb) {
      leave.cb = cb;
      return () => {
        leave.cb = null;
      };
    },
  };
  /** Runs the timers due within `ms` (the push delay) */
  const runTimers = (ms: number) => {
    for (const t of timers.splice(0).filter((x) => x.ms <= ms)) t.fn();
  };
  return { env, clock, timers, log, storage, runTimers, leave, screen };
}

async function main3(): Promise<void> {
  console.log("The account store");
  {
    accountActions.start();
    accountActions.pushSoon();
    check("on the server (no window): start does nothing, accounts stay off", getAccountState().phase === "off");

    const server = fakeServer();
    const off = fakeEnv(server, { accounts: false, hash: "#lc-account=signed-in" });
    const offStore = createAccountStore(() => off.env);
    offStore.actions.start();
    offStore.actions.pushSoon();
    await settle();
    check("accounts off: phase off, nothing asked of the server", offStore.getState().phase === "off" && server.calls.length === 0);
    check("accounts off: no timers, the address untouched", off.timers.length === 0 && off.log.hashes.length === 0);
    check("accounts off: actions say so", (await offStore.actions.syncNow()) !== null && (await offStore.actions.redeemLinkCode("ABCD-EFGH")) !== null && server.calls.length === 0);
    const none = createAccountStore(() => null);
    none.actions.start();
    check("no online side: off", none.getState().phase === "off");
  }
  {
    // Joining where the game can't reload (Settings over the pause menu): the account's save waits for the next start
    const cloudWithLap = async (server: ReturnType<typeof fakeServer>) => {
      const text = JSON.stringify(lap("spa", 90_000));
      const ghostSha = await sha256Hex(text);
      server.ghosts.set(ghostSha, text);
      server.doc = doc({
        savedBy: "PC",
        keys: { "bugesera.vehicle": { value: "chaparral-2d", t: 5 } },
        bestLaps: { "spa|lc26|p1-pro-full-dry": { trackId: "spa", vehicle: "lc26", lapTimeMs: 90_000, recordedAt: 90_000, ghost: ghostSha } },
      });
      server.rev = 1;
    };
    const server = fakeServer();
    server.joined = false;
    await cloudWithLap(server);
    const f = fakeEnv(server, { accounts: true });
    f.screen.title = false;
    const store = createAccountStore(() => f.env);
    store.actions.start();
    await settle(() => store.getState().join !== null);
    const err = await store.actions.confirmJoin();
    check(
      "a join over the pause menu doesn't reload: the account's save waits, and the player is told",
      err === null && f.log.reloads === 0 && f.storage.getItem("bugesera.vehicle") === null && /next time the game starts/.test(store.getState().notice?.text ?? ""),
      `${err} ${store.getState().notice?.text}`
    );
    const next = fakeEnv(server, { accounts: true, storage: f.storage });
    const restarted = createAccountStore(() => next.env);
    restarted.actions.start();
    await settle(() => next.log.reloads > 0);
    check("the next start on the title menu takes it", f.storage.getItem("bugesera.vehicle") === "chaparral-2d" && next.log.reloads === 1);

    // The join question stays up, busy, until its first sync is done (a slow ghost download here)
    const s2 = fakeServer();
    s2.joined = false;
    await cloudWithLap(s2);
    let release: () => void = () => {};
    s2.ghostGate = new Promise<void>((r) => (release = r));
    const g = fakeEnv(s2, { accounts: true });
    const st2 = createAccountStore(() => g.env);
    st2.actions.start();
    await settle(() => st2.getState().join !== null);
    const joining = st2.actions.confirmJoin();
    await settle(() => s2.calls.some((c) => c.startsWith("GET /account/ghosts/")));
    await settle();
    const during = st2.getState();
    check("while the first sync runs the join question stays up, busy", during.join !== null && during.joining && g.log.reloads === 0);
    release();
    await joining;
    const done = st2.getState();
    check("once it's done the question goes, and on the title menu the save is used at once", done.join === null && !done.joining && g.log.reloads === 1 && g.storage.getItem("bugesera.vehicle") === "chaparral-2d");

    // The first-sync choice made over the pause menu waits too
    const s3 = fakeServer();
    s3.doc = doc({ savedBy: "PC", keys: { "librecorsa.raceHistory": { value: JSON.stringify([race("r1", 1)]), t: 1 } } });
    s3.rev = 1;
    const h = fakeEnv(s3, { accounts: true, storage: memoryStorage({ "librecorsa.raceHistory": JSON.stringify([race("r2", 2)]) }) });
    h.screen.title = false;
    const st3 = createAccountStore(() => h.env);
    st3.actions.start();
    await settle(() => st3.getState().firstSync !== null);
    await st3.actions.chooseFirstSync("cloud");
    check("a first-sync choice over the pause menu doesn't reload; the choice waits for the next start", h.log.reloads === 0 && JSON.parse(h.storage.getItem("librecorsa.raceHistory") as string)[0].id === "r2" && st3.getState().firstSync === null);
  }
  {
    // The device's key changed under a joined session (saved data cleared, a key file imported)
    const keyIdOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);
    const server = fakeServer();
    server.keyId = keyIdOf("an-old-key");
    const f = fakeEnv(server, { accounts: true });
    const store = createAccountStore(() => f.env);
    store.actions.start();
    await settle(() => store.getState().phase === "signed-in" && server.calls.includes("POST /account/device"));
    await settle();
    check(
      "a joined session with another key: this device's key joins in its place, without the question",
      server.calls.filter((c) => c === "POST /account/device").length === 1 && store.getState().join === null && server.keyId === keyIdOf("test-driver-key"),
      server.calls.join(),
    );
  }
  {
    // A new account's join without the question fails: the question comes back with what went wrong
    const server = fakeServer();
    server.joined = false;
    server.deviceFail = "The server had a problem. Try again in a moment.";
    const f = fakeEnv(server, { accounts: true, hash: "#lc-account=created" });
    const store = createAccountStore(() => f.env);
    store.actions.start();
    await settle(() => server.calls.includes("POST /account/device"));
    await settle();
    const st = store.getState();
    check("a failed join without the question brings the question back, with the error", st.join?.driverName === "Alp" && st.notice?.kind === "error" && st.notice.text === server.deviceFail && !st.joining, JSON.stringify(st.notice));
    server.deviceFail = null;
    check("answering it then joins", (await store.actions.confirmJoin()) === null && server.joined && store.getState().join === null);
  }
  {
    // A device whose key is on another account: joined, but no key of this account is current. Settled once, it
    // isn't sent again on every start
    const server = fakeServer();
    server.keyId = null;
    server.keyElsewhere = true;
    const storage = memoryStorage();
    const posts = () => server.calls.filter((c) => c === "POST /account/device").length;
    for (let start = 0; start < 3; start++) {
      const f = fakeEnv(server, { accounts: true, storage });
      const store = createAccountStore(() => f.env);
      store.actions.start();
      await settle(() => store.getState().sync.lastSyncedAt !== null || store.getState().firstSync !== null);
      await settle();
    }
    check("a key on another account is sent once, not on every start", posts() === 1, `${posts()} joins`);
  }
  {
    // An account made just now on this device joins it without the question
    const server = fakeServer();
    server.joined = false;
    const f = fakeEnv(server, { accounts: true, hash: "#lc-account=created" });
    const store = createAccountStore(() => f.env);
    store.actions.start();
    await settle(() => server.calls.includes("POST /account/device"));
    await settle();
    const st = store.getState();
    check("a new account: no join question, this device joins it and syncs", st.join === null && server.joined && server.calls.includes("POST /account/device") && st.notice?.text === AUTH_NOTICES.created.text, server.calls.join());
  }
  {
    // A sign-in return, then the join question, then the first sync (cloud empty: upload)
    const server = fakeServer();
    server.joined = false;
    const f = fakeEnv(server, {
      accounts: true,
      hash: "#lc-account=signed-in",
      storage: memoryStorage({ "lc.garage.presets.lc26": JSON.stringify([preset("1", "Quali", 1)]) }),
    });
    const store = createAccountStore(() => f.env);
    store.actions.start();
    store.actions.start();
    await settle(() => store.getState().phase === "signed-in");
    const st = store.getState();
    check("the return's notice is shown", st.notice?.text === AUTH_NOTICES["signed-in"].text && st.notice?.kind === "ok");
    check("the return is stripped once", same(f.log.hashes, [""]) && f.log.configWatch === 1);
    check("signed in, not joined: the join question with whose account it is", st.phase === "signed-in" && st.join?.driverName === "Alp" && same(st.join?.providers, ["discord", "passkey"]));
    check("nothing went up before joining", !server.calls.some((c) => c.startsWith("PUT")));
    store.actions.pushSoon();
    f.runTimers(PUSH_DELAY_MS);
    await settle();
    check("a save point before joining sends nothing", !server.calls.some((c) => c.includes("/account/save")));
    const joined = await store.actions.confirmJoin();
    check("joining registers this device's key and label", joined === null && server.calls.includes("POST /account/device"), String(joined));
    check("joining uploads to an empty cloud", server.rev === 1 && store.getState().join === null && store.getState().sync.lastSyncedAt !== null);
    check("names elsewhere are passed on", same(store.getState().elsewhere, ["other"]));

    // A save point pushes after the delay, only when something changed
    f.storage.setItem("bugesera.track", "spa");
    store.actions.pushSoon();
    store.actions.pushSoon();
    check("a burst of save points waits once", f.timers.filter((t) => t.ms === PUSH_DELAY_MS).length === 1);
    f.runTimers(PUSH_DELAY_MS);
    await settle(() => server.rev === 2);
    check("the save point's push went up", server.rev === 2 && (server.doc as SaveDoc).keys["bugesera.track"]?.value === "spa");

    // The page is hidden, then goes away: a change since goes up in one write, with no read of the cloud's save first
    f.storage.setItem("bugesera.track", "monza");
    const before = server.calls.length;
    f.leave.cb?.(false);
    f.leave.cb?.(true);
    await settle(() => server.rev === 3);
    await settle();
    check(
      "hidden then gone: one keepalive write of the change, nothing read first",
      server.rev === 3 && (server.doc as SaveDoc).keys["bugesera.track"]?.value === "monza" && same(server.calls.slice(before), ["PUT /account/save"]) && server.keepalives === 1,
      server.calls.slice(before).join(),
    );

    const deferredMsg = await (async () => {
      const d = structuredClone(server.doc as SaveDoc);
      d.keys["bugesera.vehicle"] = { value: "chaparral-2d", t: 999_999 };
      server.doc = d;
      server.rev++;
      const err = await store.actions.syncNow();
      return { err, notice: store.getState().notice?.text ?? "" };
    })();
    check("Sync now leaves the cloud's changes for the next start, and says so", deferredMsg.err === null && /next time the game starts/.test(deferredMsg.notice) && f.storage.getItem("bugesera.vehicle") === null && f.log.reloads === 0);

    await store.actions.signOut();
    check("signing out", store.getState().phase === "signed-out" && store.getState().account === null);
  }
  {
    // Both hold a save: the first-sync question, then Combine, which reloads once to use what it wrote
    const server = fakeServer();
    const seed = fakeEnv(server, { accounts: true, storage: memoryStorage({ "librecorsa.raceHistory": JSON.stringify([race("r1", 1)]) }) });
    const seedStore = createAccountStore(() => seed.env);
    seedStore.actions.start();
    await settle(() => server.rev === 1);
    const f = fakeEnv(server, { accounts: true, storage: memoryStorage({ "librecorsa.raceHistory": JSON.stringify([race("r2", 2)]) }) });
    const store = createAccountStore(() => f.env);
    store.actions.start();
    await settle(() => store.getState().firstSync !== null);
    check("both hold a save: the store asks", store.getState().firstSync?.local.races === 1 && store.getState().firstSync?.cloud.races === 1);
    check("a sync while the question is open waits for it", (await store.actions.syncNow()) !== null && server.rev === 1);
    const err = await store.actions.chooseFirstSync("combine");
    check("the choice combines and writes", err === null && store.getState().firstSync === null && server.rev === 2);
    check("the page reloads once to use the save", f.log.reloads === 1);
    check("the reload isn't made twice for the same save", (await store.actions.syncNow()) === null && f.log.reloads === 1);

    // Another device writes a newer save, and this one starts again (a page load). Its sync on start comes back after
    // the window: past the loading screen the save waits for the next start; while the loading screen is still up (a
    // slow device still loading the circuit) it is used at once
    const newer = structuredClone(server.doc as SaveDoc);
    newer.keys["bugesera.vehicle"] = { value: "chaparral-2d", t: 999_999 };
    server.doc = newer;
    server.rev++;
    for (const loading of [false, true]) {
      const again = fakeEnv(server, { accounts: true, storage: f.storage });
      again.env.loadingScreen = () => loading;
      const restarted = createAccountStore(() => again.env);
      restarted.actions.start();
      // The answer comes back after the window
      again.clock.t += RELOAD_WINDOW_MS + 1;
      await settle();
      const applied = f.storage.getItem("bugesera.vehicle") === "chaparral-2d";
      if (loading) check("a late sync on start while the loading screen is up uses the newer save", applied && again.log.reloads === 1);
      else check("a late sync on start past the loading screen leaves the newer save for the next start", !applied && again.log.reloads === 0);
    }
    store.actions.signIn("steam", "link");
    check("sign-in goes to the provider through the API", f.log.navigations[0] === "http://test/api/auth/start/steam?intent=link&return=%2Fplay");
    check("a bad link code is caught before the server", (await store.actions.redeemLinkCode("nope")) === "A code has 8 letters and digits, like ABCD-EFGH.");
  }
}

async function main(): Promise<void> {
  main1();
  await main2();
  await main3();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
