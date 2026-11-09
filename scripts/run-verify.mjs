// Runs the scripts/verify-*.ts suites one after another and stops at the first failure.
// Usage: node scripts/run-verify.mjs            (every suite except the slow verify-driver-laps)
//        node scripts/run-verify.mjs driver-laps [args...]   (named suites, extra args passed through)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const SLOW = new Set(["verify-driver-laps.ts"]);

const [only, ...passArgs] = process.argv.slice(2);
const suites = only
  ? [`verify-${only}.ts`]
  : readdirSync(scriptsDir)
      .filter((f) => /^verify-.*\.ts$/.test(f) && !SLOW.has(f))
      .sort();

// tsx runs these as CommonJS, so three.js prints its require("three") deprecation notice
// on every run; it says nothing about the sim, so hide just that warning.
const nodeOptions = [process.env.NODE_OPTIONS, "--disable-warning=THREE_CJS_DEPRECATED"]
  .filter(Boolean)
  .join(" ");

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--import", "tsx", join(scriptsDir, suite), ...passArgs], {
    stdio: "inherit",
    // The suites check the whole car and circuit registry; ones that load a hosted-only file skip it when a clone
    // doesn't have it (scripts/lib/hosted-files.ts, src/lib/hosted-content.ts)
    env: { NEXT_PUBLIC_HOSTED_CONTENT: "1", ...process.env, NODE_OPTIONS: nodeOptions },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`\n${suite} failed (exit ${result.status ?? result.signal}) after ${seconds}s`);
    process.exit(result.status || 1);
  }
  console.log(`--- ${suite} passed in ${seconds}s`);
}
console.log(`\nAll ${suites.length} verify suite(s) passed.`);
