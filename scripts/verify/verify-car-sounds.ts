/**
 * Verification suite for all registered car sound banks (`src/lib/sim/CarAudio.ts`,
 * `src/lib/cars/car-registry.ts`, `public/cars/<id>/audio/manifest.json`, `public/gt3/audio/manifest.json`).
 *
 * Run with: npx tsx scripts/verify/verify-car-sounds.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CARS, carById, type CarId } from "../../src/lib/cars/car-registry";
import {
  LC26_SOUND,
  BMW_M4_GT3_SOUND,
  F1_2026_SOUND,
  type CarSoundSource,
} from "../../src/lib/sim/CarAudio";
import { AMG_GT3_SOUND } from "../../src/lib/sim/gt3/AmgGt3Sim";
import { LC25_SOUND } from "../../src/lib/sim/f12025-car/Lc25Sim";
import { SUZUKI_LIANA_SOUND } from "../../src/lib/sim/road/SuzukiLianaSim";
import { MTR_496R_SOUND } from "../../src/lib/sim/proto/Mtr496rSim";
import { LC_LMDH_SOUND } from "../../src/lib/sim/proto/LcLmdhSim";
import { NISSAN_R33_SOUND } from "../../src/lib/sim/classic/NissanR33Sim";
import { NISSAN_R32_SOUND } from "../../src/lib/sim/classic/NissanR32Sim";
import { BMW_M1_PROCAR_SOUND } from "../../src/lib/sim/classic/BmwM1ProcarSim";
import { CHAPARRAL_2D_67_SOUND, CHAPARRAL_2D_SOUND } from "../../src/lib/sim/classic/Chaparral2dSim";
import { PORSCHE_934_RSR_SOUND } from "../../src/lib/sim/classic/Porsche934RsrSim";
import { F12007_SOUND } from "../../src/lib/sim/f1-2007/F12007Sim";
import { VW_SCIROCCO_SOUND } from "../../src/lib/sim/road/VwSciroccoSim";
import { lerpTable, type Lc26AudioManifest } from "../../src/lib/sim/lc26-audio";
import { noteSkip, REPO_CAR_IDS } from "../lib/hosted-files";
import { HOSTED_CONTENT } from "../../src/lib/hosted-content";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
}

/**
 * `authorLevels`: a bank its author levelled and mixed to their own design instead of the repository's level curve
 * (port_ac_bank.py's): the LC-LMDH's Engine Lab engine gets much quieter towards idle, in the cockpit most, and its
 * shift and lift-off one-shots sit far under the loops, as its README says. Its loops and one-shots are only checked
 * to be within full scale; the files themselves are left as their author made them
 */
interface ExpectedSound {
  sound: CarSoundSource;
  maxIdleRpm: number;
  authorLevels?: true;
}

const EXPECTED_SOUNDS: Record<CarId, ExpectedSound> = {
  lc26: { sound: F1_2026_SOUND, maxIdleRpm: 4200 },
  lc25: { sound: LC25_SOUND, maxIdleRpm: 4200 },
  "amg-gt3": { sound: AMG_GT3_SOUND, maxIdleRpm: 1600 },
  "bmw-m4-gt3": { sound: BMW_M4_GT3_SOUND, maxIdleRpm: 1600 },
  liana: { sound: SUZUKI_LIANA_SOUND, maxIdleRpm: 1000 },
  "mtr-496r": { sound: MTR_496R_SOUND, maxIdleRpm: 2200 },
  "lc-lmdh": { sound: LC_LMDH_SOUND, maxIdleRpm: 2200, authorLevels: true },
  // [spec engine.ini MINIMUM]
  "nissan-r33-jgtc": { sound: NISSAN_R33_SOUND, maxIdleRpm: 1400 },
  "nissan-r32-jtcc": { sound: NISSAN_R32_SOUND, maxIdleRpm: 2200 },
  "bmw-m1-procar": { sound: BMW_M1_PROCAR_SOUND, maxIdleRpm: 1400 },
  "vw-scirocco-gtx": { sound: VW_SCIROCCO_SOUND, maxIdleRpm: 1000 },
  "chaparral-2d": { sound: CHAPARRAL_2D_SOUND, maxIdleRpm: 1400 },
  "chaparral-2d-67": { sound: CHAPARRAL_2D_67_SOUND, maxIdleRpm: 1400 },
  "porsche-934-rsr": { sound: PORSCHE_934_RSR_SOUND, maxIdleRpm: 1400 },
  // A 2007 V8 idles at 4000 rpm [spec engine.ini MINIMUM]
  "f1-2007": { sound: F12007_SOUND, maxIdleRpm: 4500 },
};

const MAX_BANK_BYTES = Math.round(3.4 * 1024 * 1024);

console.log("1. Registry CarSoundSource wiring & legacy LC26 preservation");
check(
  "Legacy public/lc26/audio/manifest.json remains in place",
  existsSync(join("public", "lc26", "audio", "manifest.json")) && LC26_SOUND.assetDir === "/lc26/audio/"
);

for (const car of CARS) {
  const exp = EXPECTED_SOUNDS[car.id];
  check(`${car.id}: mapped in EXPECTED_SOUNDS`, !!exp);
  const def = carById(car.id);
  check(
    `${car.id}: wired to sound '${exp.sound.id}' (${exp.sound.assetDir}, limiter ${exp.sound.limiterRpm} RPM)`,
    def.sound === exp.sound &&
      def.sound.id === exp.sound.id &&
      def.sound.assetDir === exp.sound.assetDir &&
      def.sound.limiterRpm === exp.sound.limiterRpm
  );
}

console.log("\n2. Manifest schema, anchor coverage, RMS consistency & Ogg file checks");
const seenBanks = new Map<string, ExpectedSound>();
for (const exp of Object.values(EXPECTED_SOUNDS)) {
  if (!seenBanks.has(exp.sound.id)) {
    seenBanks.set(exp.sound.id, exp);
  }
}

// The repository carries only the banks of its own cars; the others are skipped where a clone lacks them. A repository
// car can still play a hosted bank (the LC25's RB21 bank in /cars/lc25-v6/, its synthesised one in git being the
// fallback), so a bank in a git-ignored folder is hosted however its car is listed
const repoBanks = new Set([...REPO_CAR_IDS].map((id) => carById(id as CarId).sound.id));
const gitIgnored = (path: string): boolean => spawnSync("git", ["check-ignore", "-q", path]).status === 0;
for (const [bankId, { sound, maxIdleRpm, authorLevels }] of seenBanks) {
  const relDir = join("public", sound.assetDir.replace(/^\/+|\/+$/g, ""));
  const manifestPath = join(relDir, "manifest.json");
  if (!existsSync(manifestPath) && (!repoBanks.has(bankId) || gitIgnored(manifestPath))) {
    noteSkip(bankId, manifestPath);
    continue;
  }
  check(`${bankId}: manifest exists at ${manifestPath}`, existsSync(manifestPath));

  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Lc26AudioManifest;
  check(
    `${bankId}: sampleRate=48000 and valid loopSeconds`,
    m.sampleRate === 48000 && typeof m.loopSeconds === "number" && m.loopSeconds >= 1.5 && m.loopSeconds <= 3.5,
    `sr=${m.sampleRate}, loopSeconds=${m.loopSeconds}`
  );

  const referencedFiles = new Set<string>();

  for (const view of ["ext", "int"] as const) {
    const entries = m.engine?.[view] ?? [];
    for (const layer of ["on", "off"] as const) {
      const layerEntries = entries.filter((e) => e.layer === layer);
      const rpms = layerEntries.map((e) => e.rpm);
      const sorted = [...rpms].sort((a, b) => a - b);
      const strictlyIncreasing = rpms.every((r, i) => r === sorted[i] && (i === 0 || r >= sorted[i - 1]));
      const minRpm = sorted[0] ?? Infinity;
      const maxRpm = sorted[sorted.length - 1] ?? 0;

      // A bank with a full set of recordings has 4+ anchors to the limiter; a road car's (the Liana's: an idle, an
      // on-load and an overrun loop) may have only two, the top one pitched up to the limiter. Never the same
      // recording at two anchors: two copies of one loop at the same pitch comb-filter into a doubled engine
      const sources = layerEntries.map((e) => (e as { fsbName?: string }).fsbName).filter((n): n is string => !!n);
      const pitchToLimiter = sound.limiterRpm / Math.max(1, maxRpm);
      check(
        `${bankId} engine.${view}.${layer}: idle (<= ${maxIdleRpm}) to limiter (${sound.limiterRpm}), one recording per anchor`,
        layerEntries.length >= 2 &&
          strictlyIncreasing &&
          minRpm <= maxIdleRpm &&
          (layerEntries.length >= 4 ? maxRpm >= sound.limiterRpm : pitchToLimiter <= 2.2) &&
          new Set(sources).size === sources.length,
        `anchors=[${rpms.join(", ")}]${sources.length ? `, ${new Set(sources).size} recordings` : ""}`
      );

      for (const e of layerEntries) {
        referencedFiles.add(e.file);
        check(
          `${bankId} ${e.file}: valid channels (1|2) and ${authorLevels ? "an RMS within full scale (its author's levels)" : "consistent RMS"}`,
          (e.channels === 1 || e.channels === 2) && (authorLevels ? e.rms > 0 && e.rms <= 1 : e.rms >= 0.05 && e.rms <= 0.35),
          `ch=${e.channels}, rms=${e.rms}`
        );
      }
    }

    const curve = m.throttleCurve?.[view] ?? [];
    check(
      `${bankId} throttleCurve.${view}: monotonic [0,0]..[1,1] table`,
      curve.length >= 2 &&
        curve[0][0] === 0 &&
        curve[0][1] === 0 &&
        curve[curve.length - 1][0] === 1 &&
        curve[curve.length - 1][1] === 1 &&
        curve.every((pt, i) => i === 0 || (pt[0] > curve[i - 1][0] && pt[1] >= curve[i - 1][1]))
    );
  }

  // Turbo & transmission
  for (const t of m.turbo ?? []) {
    referencedFiles.add(t.file);
    check(
      `${bankId} turbo (${t.file}): valid layer, boost, channels & rms`,
      (t.layer === "on" || t.layer === "off") && t.boost > 0 && (t.channels === 1 || t.channels === 2) && t.rms > 0.01
    );
  }

  const transOn = (m.transmission ?? []).filter((t) => t.layer === "on");
  const transOff = (m.transmission ?? []).filter((t) => t.layer === "off");
  check(
    `${bankId} transmission: has on and off layers`,
    transOn.length >= 1 && transOff.length >= 1,
    `on=${transOn.length}, off=${transOff.length}`
  );
  for (const t of m.transmission ?? []) {
    referencedFiles.add(t.file);
    check(
      `${bankId} transmission (${t.file}): valid drivetrainSpeed, channels & rms`,
      t.drivetrainSpeed > 0 && (t.channels === 1 || t.channels === 2) && t.rms > 0.01
    );
  }

  // Skid & tractionControl (optional in schema)
  if (m.skid) {
    for (const v of ["int", "ext"] as const) {
      const sk = m.skid[v];
      if (sk) {
        referencedFiles.add(sk.file);
        check(`${bankId} skid.${v} (${sk.file}): valid channels & rms`, (sk.channels === 1 || sk.channels === 2) && sk.rms > 0.02);
      }
    }
  }
  if (m.tractionControl) {
    referencedFiles.add(m.tractionControl.file);
    check(
      `${bankId} tractionControl (${m.tractionControl.file}): valid channels & rms`,
      (m.tractionControl.channels === 1 || m.tractionControl.channels === 2) && m.tractionControl.rms > 0.02
    );
  }

  // Oneshots
  const roles = new Set<string>();
  for (const o of m.oneshots ?? []) {
    referencedFiles.add(o.file);
    roles.add(o.role);
    check(
      `${bankId} oneshot ${o.file} (${o.role}): valid duration & peak${authorLevels ? " (its author's levels)" : ""}`,
      o.seconds > 0.02 && o.seconds <= 4.0 && o.peak > (authorLevels ? 0 : 0.05) && o.peak <= 1.0 && (o.channels === 1 || o.channels === 2)
    );
  }
  // AC's "missgear" is the missed-gear grind: a shift built from it sounds like a crunched gearbox on every change
  const grind = (m.oneshots ?? []).filter((o) => /missgear/i.test(o.fsbName ?? ""));
  check(`${bankId} no one-shot is cut from the missed-gear grind`, grind.length === 0, grind.map((o) => o.role).join(", "));
  const requiredRoles = ["gear_up", "gear_down", "backfire_int", "backfire_ext", "limiter"];
  if ((m.turbo ?? []).length > 0) requiredRoles.push("blowoff");
  check(
    `${bankId} oneshots cover required roles (${requiredRoles.join(", ")})`,
    requiredRoles.every((r) => roles.has(r)),
    `present=[${[...roles].join(", ")}]`
  );

  // Verify every referenced file exists and has OggS header
  for (const fn of referencedFiles) {
    const fpath = join(relDir, fn);
    const exists = existsSync(fpath);
    const magic = exists ? readFileSync(fpath).subarray(0, 4).toString("ascii") : "";
    const sz = exists ? statSync(fpath).size : 0;
    check(`${bankId} file ${fn}: exists and valid OggS stream`, exists && magic === "OggS" && sz > 512, `${sz} B`);
  }

  // Verify total directory size <= 3.4 MB
  const totalBytes = readdirSync(relDir)
    .map((f) => join(relDir, f))
    .filter((p) => statSync(p).isFile())
    .reduce((sum, p) => sum + statSync(p).size, 0);
  const totalMB = totalBytes / (1024 * 1024);
  check(
    `${bankId}: total bank size <= 3.40 MB`,
    totalBytes <= MAX_BANK_BYTES,
    `${totalMB.toFixed(2)} MB (${referencedFiles.size} audio files)`
  );
}

console.log("\n3. CREDITS.md Car sounds section check");
const credits = readFileSync("CREDITS.md", "utf8");
check("CREDITS.md has 'Car sounds' section", /###\s+Car sounds/i.test(credits));
for (const dirId of ["f12026", "lc25", "bmw-m4-gt3"]) {
  check(
    `CREDITS.md documents public/cars/${dirId}/audio/`,
    credits.includes(`public/cars/${dirId}/audio/`),
    dirId
  );
}
check("CREDITS.md credits corsamode for BMW M4 GT3 sound mod", credits.includes("corsamode"));

// The LC-LMDH's engine sound is free for LibreCorsa on the terms of its README: this credit, in these words, with its
// link, in CREDITS.md and in the game (the car card)
const ENGINE_LAB_CREDIT = "Engine sound: Engine Lab by bimbalanch, https://ko-fi.com/bimbalanch";
check(
  "CREDITS.md credits the LC-LMDH's engine sound in its author's words",
  credits.includes("Engine sound: Engine Lab by bimbalanch, [https://ko-fi.com/bimbalanch](https://ko-fi.com/bimbalanch)")
);
// The LC25's hosted RB21 (Honda RBPT) sound is used with hahmad's permission: credited by name with their OverTake
// link in the game, on the site, and in CREDITS.md, and explicitly excluded from AGPL-3.0
const RB21_SOUND_CREDIT = "Engine sound: RB21 (Honda RBPT) by hahmad, https://www.overtake.gg/members/hahmad.2388716/";
check(
  "CREDITS.md credits hahmad with their OverTake link and excludes the RB21 sound from AGPL-3.0",
  credits.includes("hahmad") &&
    credits.includes("https://www.overtake.gg/members/hahmad.2388716/") &&
    credits.includes("not covered by AGPL-3.0 or any other licence")
);
if (HOSTED_CONTENT) {
  const card = (JSON.parse(readFileSync("src/i18n/messages/en/menu.json", "utf8")) as { carBrowser: Record<string, string> })
    .carBrowser.creditEngineSound;
  for (const [id, expected] of [
    ["lc-lmdh", ENGINE_LAB_CREDIT],
    ["lc25", RB21_SOUND_CREDIT],
  ] as const) {
    const s = carById(id).soundCredit;
    const shown = card
      .replace("{work}", s?.engineSound ?? "?")
      .replace("{author}", s?.author ?? "?")
      .replace("{url}", s?.url ?? "?")
      .replace(/<\/?link>/g, "");
    check(`The ${id} car card shows the required sound credit, its address a link`, shown === expected && card.includes("<link>{url}</link>"), shown);
  }
} else {
  noteSkip("the LC-LMDH and LC25 engine sound credits on their car cards", "NEXT_PUBLIC_HOSTED_CONTENT=1");
}

// hahmad's RB21 bank as its own FMOD events play it (scripts/audio/car_configs.json "lc25-v6"): its wind, skid and
// limiter events are silent stubs, so it brings no wind or tyre loop of its own (CarAudio's procedural wind and the
// full road roar play, as with the LC26); its outside sound is the cockpit loops through the engine_ext mixer's EQ,
// baked into the outside loops, with no tone stage on top; and its overrun fades out between 10 and 40 % throttle
console.log("\n4. The LC25's hosted RB21 bank against its own FMOD design");
const RB21_MANIFEST = join("public", "cars", "lc25-v6", "audio", "manifest.json");
if (existsSync(RB21_MANIFEST)) {
  const m = JSON.parse(readFileSync(RB21_MANIFEST, "utf8")) as Lc26AudioManifest;
  check("no wind or tyre-rolling loop: the bank has none (a drivetrain rumble is no wind)", !m.wind && !m.tyreRolling && !m.bodywork);
  check("no tone stage on top: the outside EQ of the bank's own mixer is in its outside loops", !m.viewTone);
  for (const view of ["int", "ext"] as const) {
    const curve = m.throttleCurve[view];
    const at = (x: number) => lerpTable(curve, x);
    check(
      `throttleCurve.${view}: the overrun alone at a closed throttle, half gone by 20 %, gone by 40 %`,
      at(0.05) === 0 && at(0.2) > 0.35 && at(0.2) < 0.5 && at(0.4) >= 0.99,
      `${at(0.05).toFixed(2)} / ${at(0.2).toFixed(2)} / ${at(0.4).toFixed(2)}`
    );
  }
} else {
  noteSkip("the LC25's hosted RB21 bank", RB21_MANIFEST);
}

console.log(`\nCar sounds verification: all ${passed} checks passed.`);
