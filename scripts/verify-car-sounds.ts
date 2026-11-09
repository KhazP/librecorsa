/**
 * Verification suite for all registered car sound banks (`src/lib/sim/CarAudio.ts`,
 * `src/lib/cars/car-registry.ts`, `public/cars/<id>/audio/manifest.json`, `public/gt3/audio/manifest.json`).
 *
 * Run with: npx tsx scripts/verify-car-sounds.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CARS, carById, type CarId } from "../src/lib/cars/car-registry";
import {
  AMR26_SOUND,
  BMW_M4_GT3_SOUND,
  F2004_SOUND,
  F1_2026_SOUND,
  R25_SOUND,
  RB8_SOUND,
  RB22_SOUND,
  SF26_SOUND,
  SF71H_SOUND,
  W17_SOUND,
  type CarSoundSource,
} from "../src/lib/sim/CarAudio";
import { AMG_GT3_SOUND } from "../src/lib/sim/gt3/AmgGt3Sim";
import { SUZUKI_LIANA_SOUND } from "../src/lib/sim/road/SuzukiLianaSim";
import { MTR_496R_SOUND } from "../src/lib/sim/proto/Mtr496rSim";
import type { Vf26AudioManifest } from "../src/lib/sim/vf26-audio";
import { noteSkip, REPO_CAR_IDS } from "./lib/hosted-files";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
}

const EXPECTED_SOUNDS: Record<CarId, { sound: CarSoundSource; maxIdleRpm: number }> = {
  vf26: { sound: F1_2026_SOUND, maxIdleRpm: 4200 },
  "f12026-car": { sound: F1_2026_SOUND, maxIdleRpm: 4200 },
  sf26: { sound: SF26_SOUND, maxIdleRpm: 4200 },
  w17: { sound: W17_SOUND, maxIdleRpm: 4200 },
  rb22: { sound: RB22_SOUND, maxIdleRpm: 4200 },
  sf71h: { sound: SF71H_SOUND, maxIdleRpm: 4200 },
  rb8: { sound: RB8_SOUND, maxIdleRpm: 4600 },
  r25: { sound: R25_SOUND, maxIdleRpm: 4000 },
  f2004: { sound: F2004_SOUND, maxIdleRpm: 4000 },
  "amg-gt3": { sound: AMG_GT3_SOUND, maxIdleRpm: 1600 },
  "amg-gt3-evo": { sound: AMG_GT3_SOUND, maxIdleRpm: 1600 },
  "bmw-m4-gt3": { sound: BMW_M4_GT3_SOUND, maxIdleRpm: 1600 },
  liana: { sound: SUZUKI_LIANA_SOUND, maxIdleRpm: 1000 },
  "mtr-496r": { sound: MTR_496R_SOUND, maxIdleRpm: 2200 },
};

const MAX_BANK_BYTES = Math.round(3.4 * 1024 * 1024);

console.log("1. Registry CarSoundSource wiring & legacy AMR26 preservation");
check(
  "Legacy public/amr26/audio/manifest.json remains in place",
  existsSync(join("public", "amr26", "audio", "manifest.json")) && AMR26_SOUND.assetDir === "/amr26/audio/"
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
const seenBanks = new Map<string, { sound: CarSoundSource; maxIdleRpm: number }>();
for (const exp of Object.values(EXPECTED_SOUNDS)) {
  if (!seenBanks.has(exp.sound.id)) {
    seenBanks.set(exp.sound.id, exp);
  }
}

// The repository carries only the 2026 prototype's bank; the others are skipped where a clone lacks them
const repoBanks = new Set([...REPO_CAR_IDS].map((id) => carById(id as CarId).sound.id));
for (const [bankId, { sound, maxIdleRpm }] of seenBanks) {
  const relDir = join("public", sound.assetDir.replace(/^\/+|\/+$/g, ""));
  const manifestPath = join(relDir, "manifest.json");
  if (!existsSync(manifestPath) && !repoBanks.has(bankId)) {
    noteSkip(bankId, manifestPath);
    continue;
  }
  check(`${bankId}: manifest exists at ${manifestPath}`, existsSync(manifestPath));

  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Vf26AudioManifest;
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
          `${bankId} ${e.file}: valid channels (1|2) and consistent RMS`,
          (e.channels === 1 || e.channels === 2) && e.rms >= 0.05 && e.rms <= 0.35,
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
      `${bankId} oneshot ${o.file} (${o.role}): valid duration & peak`,
      o.seconds > 0.02 && o.seconds <= 4.0 && o.peak > 0.05 && o.peak <= 1.0 && (o.channels === 1 || o.channels === 2)
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
for (const dirId of ["f12026", "sf26", "w17", "rb22", "sf71h", "rb8", "r25", "f2004", "bmw-m4-gt3"]) {
  check(
    `CREDITS.md documents public/cars/${dirId}/audio/`,
    credits.includes(`public/cars/${dirId}/audio/`),
    dirId
  );
}
check("CREDITS.md credits corsamode for BMW M4 GT3 sound mod", credits.includes("corsamode"));

console.log(`\nCar sounds verification: all ${passed} checks passed.`);
