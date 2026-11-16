// Runs the scripts/verify-*.ts suites and reports every failure, not just the first.
// Usage: node scripts/run-verify.mjs            (every suite except the slow verify-driver-laps)
//        node scripts/run-verify.mjs driver-laps [args...]   (one named suite, extra args passed through)
//
// The full run spreads the suites over the CPU cores (VERIFY_JOBS=n sets how many at once; VERIFY_JOBS=1 runs them
// one after another), prints each suite's output in one piece as it finishes, then a summary of the failures.
// The suites that time themselves run alone after the others, so a busy machine can't fail them.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const SLOW = new Set(["verify-driver-laps.ts"]);
/**
 * Suites whose checks run on real timers: a fence given up on at its timeout (gpu-health), the WebHID kerb buzz's
 * frequency from 16 ms timers (input). Both take seconds. (f12026-car's query cost limit has ~10× headroom, and
 * fit-visual-road only prints its timings, so they share the CPU with the rest.)
 */
const TIMED = new Set(["verify-gpu-health.ts", "verify-input.ts"]);
/**
 * The longest suites (several minutes each, the rest mostly seconds) start first, so the run isn't left waiting on
 * one that began last. Only the order: a suite missing from here still runs, and a stale name does nothing
 */
const HEAVY = ["verify-setup-sheet.ts", "verify-f12026-car.ts", "verify-tyre-thermal.ts", "verify-lc26-tuned.ts"];
const heavyRank = (suite) => (HEAVY.includes(suite) ? HEAVY.indexOf(suite) : HEAVY.length);

// tsx runs these as CommonJS, so three.js prints its require("three") deprecation notice
// on every run; it says nothing about the sim, so hide just that warning.
const nodeOptions = [process.env.NODE_OPTIONS, "--disable-warning=THREE_CJS_DEPRECATED"]
  .filter(Boolean)
  .join(" ");
// The suites check the whole car and circuit registry; ones that load a hosted-only file skip it when a clone
// doesn't have it (scripts/lib/hosted-files.ts, src/lib/hosted-content.ts)
const env = { NEXT_PUBLIC_HOSTED_CONTENT: "1", ...process.env, NODE_OPTIONS: nodeOptions };
const suiteArgs = (suite, extra = []) => ["--import", "tsx", join(scriptsDir, suite), ...extra];
const secondsSince = (started) => ((Date.now() - started) / 1000).toFixed(1);

const [only, ...passArgs] = process.argv.slice(2);

if (only) {
  // One named suite: its output straight to the terminal, as it runs (verify-driver-laps prints its progress)
  const suite = `verify-${only}.ts`;
  console.log(`\n=== ${suite} ===`);
  const started = Date.now();
  const result = spawnSync(process.execPath, suiteArgs(suite, passArgs), { stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`\n${suite} failed (exit ${result.status ?? result.signal}) after ${secondsSince(started)}s`);
    process.exit(result.status || 1);
  }
  console.log(`--- ${suite} passed in ${secondsSince(started)}s`);
  process.exit(0);
}

const suites = readdirSync(scriptsDir)
  .filter((f) => /^verify-.*\.ts$/.test(f) && !SLOW.has(f))
  .sort();
const requestedJobs = Number.parseInt(process.env.VERIFY_JOBS ?? "", 10);
const jobs = requestedJobs > 0 ? requestedJobs : Math.max(1, availableParallelism() - 1);
const inActions = process.env.GITHUB_ACTIONS === "true";

/** Runs one suite with its output collected, and prints that output in one block when it ends */
function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, suiteArgs(suite), { env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    const finish = (code, signal, error) => {
      const seconds = secondsSince(started);
      const passed = code === 0 && !error;
      const output = Buffer.concat(chunks).toString().trimEnd();
      // In GitHub Actions a passing suite's output folds away; a failing one stays open
      if (inActions && passed) console.log(`::group::${suite} passed in ${seconds}s`);
      else console.log(`\n=== ${suite} ===`);
      if (output) console.log(output);
      if (error) console.error(String(error));
      if (passed) {
        if (inActions) console.log("::endgroup::");
        else console.log(`--- ${suite} passed in ${seconds}s`);
      } else {
        const why = error ? "could not start" : `exit ${code ?? signal}`;
        if (inActions) console.log(`::error title=${suite} failed::${why} after ${seconds}s`);
        console.error(`--- ${suite} FAILED (${why}) after ${seconds}s`);
      }
      resolve({ suite, passed, seconds });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

/** Runs the suites at most `limit` at a time; the results come back in the suites' order */
async function runPool(list, limit) {
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await runSuite(list[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

const started = Date.now();
const parallel = suites.filter((s) => !TIMED.has(s)).sort((a, b) => heavyRank(a) - heavyRank(b));
const alone = suites.filter((s) => TIMED.has(s));
console.log(`Running ${suites.length} verify suites: ${parallel.length} over ${jobs} job(s), then ${alone.length} timed one(s) alone.`);
const results = [...(await runPool(parallel, jobs)), ...(await runPool(alone, 1))];

const failed = results.filter((r) => !r.passed);
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5);
console.log(`\nSlowest: ${slowest.map((r) => `${r.suite.replace(/^verify-|\.ts$/g, "")} ${r.seconds}s`).join(", ")}`);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} verify suite(s) failed after ${secondsSince(started)}s:`);
  for (const r of failed) console.error(`  - ${r.suite}  (node scripts/run-verify.mjs ${r.suite.replace(/^verify-|\.ts$/g, "")})`);
  process.exit(1);
}
console.log(`\nAll ${results.length} verify suite(s) passed in ${secondsSince(started)}s.`);
