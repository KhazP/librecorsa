// Runs the scripts/verify/verify-*.ts suites and reports every failure, not just the first.
// Usage: node scripts/verify/run-verify.mjs            (every suite except the slow verify-driver-laps, several at once)
//        node scripts/verify/run-verify.mjs --record   (the same, then writes each suite's time to verify-timings.json)
//        node scripts/verify/run-verify.mjs driver-laps [args...]   (one named suite on its own, extra args passed through)
//
// A full run starts several suites at once: as many as it takes for the longest one to set the run's length, and no
// more than the machine has cores (VERIFY_JOBS sets the number; VERIFY_JOBS=1 runs them one after another). They
// start longest first, by the times in verify-timings.json, so the slowest suite never starts last; a suite with no
// recorded time starts first. The two that check real timers (ALONE) run one at a time after the rest, on an idle
// machine. Each suite's output is held back and printed whole when it ends. A failing suite doesn't
// stop the others: the run ends with a list of every suite that failed and the command that reruns each one.
// In GitHub Actions a passing suite's output folds into a group and a failure is also an error annotation.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const SLOW = new Set(["verify-driver-laps.ts"]);
// Suites whose checks have tight windows on real timers: gpu-health gives up on a fence at a 60 ms timeout and wants
// the wait under a second, and input measures the WebHID kerb buzz's frequency from 16 ms timers. A busy machine can
// fail either, so they run one at a time after the rest (about 2 s together). The other timed checks keep a wide
// margin under load and stay in the pool: f12026-car's query cost (1.2 µs against 5 µs) and tv-occlusion's index
// against the Raycaster (about 390× faster against the 20× it needs), both measured with the machine fully loaded.
const ALONE = new Set(["verify-gpu-health.ts", "verify-input.ts"]);
const TIMINGS = join(scriptsDir, "verify-timings.json");

const args = process.argv.slice(2);
const record = args[0] === "--record";
const [only, ...passArgs] = record ? [] : args;

// tsx runs these as CommonJS, so three.js prints its require("three") deprecation notice
// on every run; it says nothing about the sim, so hide just that warning.
const nodeOptions = [process.env.NODE_OPTIONS, "--disable-warning=THREE_CJS_DEPRECATED"]
  .filter(Boolean)
  .join(" ");
// The suites check the whole car and circuit registry; ones that load a hosted-only file skip it when a clone
// doesn't have it (scripts/lib/hosted-files.ts, src/lib/hosted-content.ts)
const env = { NEXT_PUBLIC_HOSTED_CONTENT: "1", ...process.env, NODE_OPTIONS: nodeOptions };
const inActions = process.env.GITHUB_ACTIONS === "true";
const suiteArgs = (suite) => ["--import", "tsx", join(scriptsDir, suite)];
const secondsSince = (started) => ((Date.now() - started) / 1000).toFixed(1);
const shortName = (suite) => suite.replace(/^verify-|\.ts$/g, "");

if (only) {
  const suite = `verify-${only}.ts`;
  console.log(`\n=== ${suite} ===`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [...suiteArgs(suite), ...passArgs], { stdio: "inherit", env });
  const seconds = secondsSince(started);
  if (result.status !== 0) {
    console.error(`\n${suite} failed (exit ${result.status ?? result.signal}) after ${seconds}s`);
    process.exit(result.status || 1);
  }
  console.log(`--- ${suite} passed in ${seconds}s`);
  console.log(`\nAll 1 verify suite(s) passed.`);
} else {
  await runAll();
}

async function runAll() {
  let timings = {};
  try {
    timings = JSON.parse(readFileSync(TIMINGS, "utf8"));
  } catch {
    // No times recorded: the suites start in name order
  }
  const recorded = (suite) => (typeof timings[suite] === "number" ? timings[suite] : Infinity);
  const suites = readdirSync(scriptsDir)
    .filter((f) => /^verify-.*\.ts$/.test(f) && !SLOW.has(f))
    .sort((a, b) => recorded(b) - recorded(a) || a.localeCompare(b));
  const together = suites.filter((s) => !ALONE.has(s));
  const alone = suites.filter((s) => ALONE.has(s));

  // Once the longest suite is what sets the run's length, more at once only slows every suite down (on a 14-core
  // Mac, 14 at once took 411 s and 4 at once 323 s), so by default stop at the first count where that happens
  const known = together.map(recorded).filter(Number.isFinite);
  const runLength = (count) => {
    const lanes = new Array(count).fill(0);
    for (const t of known) lanes[lanes.indexOf(Math.min(...lanes))] += t;
    return Math.max(...lanes);
  };
  const cores = availableParallelism();
  let enough = known.length ? 1 : cores;
  while (enough < cores && runLength(enough) > Math.max(...known)) enough++;
  const wanted = Number.parseInt(process.env.VERIFY_JOBS ?? "", 10);
  const jobs = Math.max(1, Math.min(together.length, wanted > 0 ? wanted : enough));
  const then = alone.length ? `, then ${alone.map(shortName).join(" and ")} on their own` : "";
  console.log(`Running ${suites.length} verify suites, ${jobs} at a time, longest first${then}.`);

  const startedAll = Date.now();
  let started = 0;
  let finished = false;
  // A run that ends before every suite has reported back (a child that never closed) is a failure
  process.on("exit", () => {
    if (!finished) {
      console.error(`\nThe verify run stopped with ${started} of ${suites.length} suites started.`);
      process.exitCode = 1;
    }
  });

  /** Runs one suite with its output held back, prints that output in one block when it ends */
  const runSuite = (suite) =>
    new Promise((resolve) => {
      started++;
      const startedAt = Date.now();
      const output = [];
      // A suite's output only shows when it ends, so this line is what shows one that never does
      console.log(`started ${suite}`);
      const child = spawn(process.execPath, suiteArgs(suite), { stdio: ["ignore", "pipe", "pipe"], env });
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
      child.on("error", (error) => output.push(Buffer.from(`${error.stack ?? error}\n`)));
      child.on("close", (code, signal) => {
        const seconds = secondsSince(startedAt);
        const why = code === 0 ? null : `exit ${code ?? signal}`;
        let text = Buffer.concat(output).toString();
        if (text && !text.endsWith("\n")) text += "\n";
        if (!why && inActions) {
          console.log(`::group::${suite} passed in ${seconds}s`);
          process.stdout.write(text);
          console.log("::endgroup::");
        } else {
          process.stdout.write(`\n=== ${suite} ===\n${text}`);
          if (!why) console.log(`--- ${suite} passed in ${seconds}s`);
          else {
            if (inActions) console.log(`::error title=${suite} failed::${why} after ${seconds}s`);
            console.error(`--- ${suite} FAILED (${why}) after ${seconds}s`);
          }
        }
        resolve({ suite, why, seconds: Number(seconds) });
      });
    });

  /** Runs the suites at most `limit` at a time, in the order given */
  const runPool = async (list, limit) => {
    const results = [];
    let next = 0;
    const lane = async () => {
      while (next < list.length) results.push(await runSuite(list[next++]));
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, lane));
    return results;
  };

  const results = [...(await runPool(together, jobs)), ...(await runPool(alone, 1))];
  finished = true;
  const failed = results.filter((r) => r.why);
  if (failed.length) {
    console.error(`\n${failed.length} of ${results.length} verify suite(s) failed after ${secondsSince(startedAll)}s:`);
    for (const r of failed) console.error(`  ${r.suite} (${r.why}): node scripts/verify/run-verify.mjs ${shortName(r.suite)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${results.length} verify suite(s) passed in ${secondsSince(startedAll)}s, ${jobs} at a time.`);
  if (record) {
    const times = Object.fromEntries(results.map((r) => [r.suite, r.seconds]));
    const sorted = Object.fromEntries(Object.entries(times).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
    writeFileSync(TIMINGS, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Wrote the times to ${TIMINGS}`);
  }
}
