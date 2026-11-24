/**
 * What a bug report adds by itself (`src/lib/diagnostics/`, `src/components/menu/RequestPanel.tsx`): the lines it
 * shows and their wording, where on the lap the car was, the frame rate of the last minute of driving, the game's
 * error log, and the GitHub address kept short enough to survive GitHub's sign-in (the log is cut first, then the
 * details from the end, never the player's own words).
 *
 *   npx tsx scripts/verify-report-details.ts
 */
import { feedbackIssueUrl, type FeedbackForm } from "../src/components/menu/RequestPanel";
import { describeArg, errorLog, errorLogCopy, errorLogText, logLine } from "../src/lib/diagnostics/error-log";
import {
  appChannel,
  boardLine,
  bugReportRows,
  detailsText,
  fieldText,
  fitIssueUrl,
  frameLine,
  ISSUE_URL_BUDGET,
  nearestTurn,
  turnLabel,
  whereLine,
  wheelReportRows,
  type ReportFacts,
} from "../src/lib/diagnostics/report-details";
import { drivingFrameSummary, drivingInputUsed, noteDrivingFrame, noteDrivingInput, noteFrameGraphics, resetFrameStats } from "../src/lib/render/frame-stats";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failed++;
}

// --- Frame rate of the last minute of driving
resetFrameStats();
check("No driving yet: no frame rate", drivingFrameSummary(0) === null && frameLine(null) === null);
let t = 0;
// 90 s at 60 fps, then 30 s at 30 fps: the last minute is the 30 s at 30 fps and 30 s at 60 fps
for (let i = 0; i < 90 * 60; i++) noteDrivingFrame(1000 / 60, (t += 1000 / 60));
for (let i = 0; i < 30 * 30; i++) noteDrivingFrame(1000 / 30, (t += 1000 / 30));
noteDrivingFrame(30_000, t + 30_000); // a hidden tab: not a frame
noteFrameGraphics("High · render 100%");
const fs = drivingFrameSummary(t);
check("The window is a minute of driving", fs !== null && Math.abs(fs.seconds - 60) < 0.1, `${fs?.seconds.toFixed(2)} s`);
check("Its frame rate counts frames over driving time", fs !== null && Math.abs(fs.fps - 45) < 0.5, `${fs?.fps.toFixed(2)} fps`);
check("Its 95th percentile is the slow half's frame", fs !== null && Math.abs(fs.p95Ms - 33.33) < 0.1, `${fs?.p95Ms.toFixed(2)} ms`);
check("A 30 s gap (a hidden tab) is not a long frame", fs?.longFrames === 0);
check("The graphics they were drawn with go along", fs?.graphics === "High · render 100%");
check("Two minutes later the line says so", /2 min before the report/.test(frameLine(drivingFrameSummary(t + 120_000)) ?? ""), frameLine(drivingFrameSummary(t + 120_000)) ?? "");
check("Under two seconds of driving says nothing", frameLine({ ...fs!, seconds: 1.5 }) === null);

// --- The input that drove the car
check("No driving yet: no input", drivingInputUsed() === null);
for (let i = 0; i < 3000; i++) noteDrivingInput("controller");
for (let i = 0; i < 500; i++) noteDrivingInput("keyboard");
check("Most of the last minute decides", drivingInputUsed() === "controller");
for (let i = 0; i < 3000; i++) noteDrivingInput("keyboard");
check("Older frames drop out of the minute", drivingInputUsed() === "keyboard");

// --- Where on the lap
const turns = [
  { number: 1, name: "Turn 1 — Castle", sApprox: 120 },
  { number: 2, name: "Turn 2", sApprox: 900 },
  { number: 3, name: "Turn 3 — Remus", sApprox: 4900 },
];
check("Nearest corner, plainly", nearestTurn(turns, 950, 5000)?.number === 2);
check("Nearest corner across the start line", nearestTurn(turns, 4990, 5000)?.number === 3 && nearestTurn(turns, 30, 5000)?.number === 1);
check("Wrapping round: 4,950 m is nearer turn 1 at 120 m than turn 3 at 4,700", nearestTurn([turns[0], { ...turns[2], sApprox: 4700 }], 4950, 5000)?.number === 1);
check("Far from every corner: none", nearestTurn(turns, 2500, 5000) === null);
check("A distance past the lap's length still finds its corner (a run past a finish)", nearestTurn(turns, 5000 + 950, 5000)?.number === 2 && nearestTurn(turns, 12000, 5000) === null);
check("A named corner reads 'Turn 1, Castle'", turnLabel(turns[0]) === "Turn 1, Castle");
check("An unnamed one reads 'Turn 2'", turnLabel(turns[1]) === "Turn 2");
const where = whereLine({ mode: "Race against AI", lap: 3, totalLaps: 5, distanceM: 1302.4, lengthM: 5340, turn: "Turn 4, Remus", speedKmh: 182.4, surface: "damp", replay: false });
check("Where: lap, distance, share, corner, speed, mode, surface", where === "Lap 3 of 5, 1,302 m of 5,340 m (24 %), Turn 4, Remus, 182 km/h, Race against AI, damp track", where);
check("In a replay it says so first", whereLine({ mode: "Practice", lap: 1, totalLaps: null, distanceM: 0, lengthM: 0, turn: null, speedKmh: 0, surface: "dry", replay: true }).startsWith("In a replay, lap 1"));

// --- App, board
check("Electron is the desktop app", appChannel({ userAgent: "Mozilla/5.0 Chrome/140.0 Electron/38.1.0 Safari/537.36", storeBuild: false, installed: true }) === "Desktop app (Electron 38)");
check("The Android app before an installed web app", appChannel({ userAgent: "Chrome/140", storeBuild: true, installed: true }) === "Android app");
check("A browser tab", appChannel({ userAgent: "Chrome/140", storeBuild: false, installed: false }) === "Browser tab");
check("Board with laps waiting", boardLine("unreachable", 2) === "couldn't be reached, 2 laps waiting to post");
check("Board on, nothing waiting", boardLine("on", 0) === "reachable");

// --- Rows
const facts: ReportFacts = {
  build: "a1b2c3d",
  physicsVersion: 7,
  app: "Browser tab",
  device: "8 cores, 8 GB memory or more",
  input: "Controller (last lap), Keyboard set up",
  devices: "Wireless Controller",
  frames: fs,
  settings: "assists tc_abs, realism full",
  board: "reachable",
  drive: { mode: "Practice", lap: 2, totalLaps: null, distanceM: 950, lengthM: 5000, turn: "Turn 2", speedKmh: 140, surface: "dry", replay: false },
  driver: "Misk (MSK)",
};
const base = { circuit: "Red Bull Ring, Grand Prix layout", car: "LC26 Prototype", input: "Keyboard", graphics: "Low · render 50%", browser: "Chrome 148 on Windows", screen: "1366×768 @1x", gpu: "Intel HD 520" };
const rows = bugReportRows(base, facts);
const ids = rows.map((r) => r.id).join(",");
check("Bug rows, in order", ids === "circuit,car,input,devices,graphics,browser,screen,gpu,where,build,frames,drawn,app,settings,device,board,driver", ids);
check("The browser line can't be left out (the form needs it)", rows.find((r) => r.id === "browser")?.locked === true && rows.filter((r) => r.locked).length === 1);
check("The driver name starts left out", rows.find((r) => r.id === "driver")?.offByDefault === true);
check("Without facts the input is the one set up", bugReportRows(base, null).find((r) => r.id === "input")?.value === "Keyboard");
check("Details read 'Label: value' a line", detailsText(rows).split("\n")[0] === `Where: ${whereLine(facts.drive!)}`);
check("The system line: browser · screen · GPU", fieldText(rows, "system") === "Chrome 148 on Windows · 1366×768 @1x · GPU: Intel HD 520", fieldText(rows, "system"));
const wheel = wheelReportRows(base, facts);
check("A wheel report's system line carries the devices, build and app", fieldText(wheel, "system").endsWith("Devices: Wireless Controller · Build: a1b2c3d · physics 7 · App: Browser tab"), fieldText(wheel, "system"));

// --- The issue address
const form: FeedbackForm = {
  kind: "Bug",
  main: "The car jumps at turn 2",
  second: "Drive out of the pits",
  third: "",
  license: "",
  permission: "",
  askedModders: false,
  modderSaidYes: false,
  notes: "",
};
const params = (url: string) => new URL(url).searchParams;
const plain = params(feedbackIssueUrl(form, { circuit: "C", car: "K", device: "Keyboard", graphics: "Low" }, null));
check("Without added lines the old fields only", plain.get("circuit") === "C" && plain.get("details") === null && plain.get("console") === null);
const full = params(feedbackIssueUrl(form, undefined, null, { rows, log: "[   1.0 s] error  boom" }));
check("Added lines fill circuit, input, devices, system, quality", full.get("circuit") === base.circuit && full.get("input") === facts.input && full.get("hardware") === "Wireless Controller" && full.get("quality") === base.graphics);
check("Details and the log go to their fields", (full.get("details") ?? "").includes("Build: a1b2c3d · physics 7") && full.get("console") === "[   1.0 s] error  boom");
check("What the player wrote about their device wins", params(feedbackIssueUrl({ ...form, third: "Moza R9" }, undefined, null, { rows, log: "" })).get("hardware") === "Moza R9");

// A long report: the log goes first, then the details from the end; the player's words stay whole
const long = { ...form, main: "Ü".repeat(300), second: "x ".repeat(300) };
const bigLog = Array.from({ length: 60 }, (_, i) => `[ ${i}.0 s] warn  something went wrong in frame ${i} ${"y".repeat(40)}`).join("\n");
const details = rows.filter((r) => r.field === "details");
const others = rows.filter((r) => r.field !== "details");
const fit = fitIssueUrl(
  ({ logChars, detailRows }) => feedbackIssueUrl(long, undefined, null, { rows: [...others, ...details.slice(0, detailRows)], log: bigLog.slice(-logChars || bigLog.length).slice(0, logChars) }),
  details.length
);
const fp = params(fit.url);
check("The fitted address is within the budget", fit.url.length <= ISSUE_URL_BUDGET, `${fit.url.length} chars`);
check("The player's words are whole", fp.get("what") === long.main && fp.get("steps") === long.second.trim());
check("The log went before any detail line", fit.logChars === 0 || fit.detailRows === details.length, `log ${fit.logChars}, details ${fit.detailRows}/${details.length}`);
check("Details are cut from the end (the first kept)", fit.detailRows === 0 || (fp.get("details") ?? "").startsWith("Where:"));

// Longer still: the log is gone and the details lose lines from the end
const longer = { ...form, main: "Ü".repeat(470), second: "x ".repeat(300) };
const fit2 = fitIssueUrl(
  ({ logChars, detailRows }) => feedbackIssueUrl(longer, undefined, null, { rows: [...others, ...details.slice(0, detailRows)], log: bigLog.slice(0, logChars) }),
  details.length
);
const fp2 = params(fit2.url);
check("Longer: within the budget, no log, details cut from the end", fit2.url.length <= ISSUE_URL_BUDGET && fit2.logChars === 0 && fit2.detailRows > 0 && fit2.detailRows < details.length, `${fit2.url.length} chars, details ${fit2.detailRows}/${details.length}`);
check("Longer: the kept details are the first ones", (fp2.get("details") ?? "").split("\n").length === fit2.detailRows && (fp2.get("details") ?? "").startsWith("Where:"));
check("Longer: the player's words are whole", fp2.get("what") === longer.main);

// --- The error log
class HeavyMesh {
  geometry = { attributes: { position: new Array(100000).fill(0) } };
}
check("A class instance in a console line is named, not serialised", describeArg(new HeavyMesh()) === "[HeavyMesh]");
check("A plain object shows its keys, nested values named", describeArg({ code: 4, detail: { deep: { deeper: 1 } }, list: [1, 2] }) === '{"code":4,"detail":"[Object]","list":"[array 2]"}');
logLine("warn", "[load] long frame: 140 ms");
logLine("warn", "[load] long frame: 212 ms");
const copy = errorLogCopy();
const frame = copy.find((e) => e.text.startsWith("[load] long frame"));
check("The same message with other numbers is one line, counted", frame?.count === 2 && frame.text.endsWith("212 ms"), frame ? `${frame.count}× ${frame.text}` : "missing");
logLine("error", "fetch failed https://librecorsa.org/api/room?code=ABCD&key=secret");
check("An address loses its query (a room code)", errorLog().some((e) => e.text === "fetch failed https://librecorsa.org/api/room"));
check("A copy keeps the count it had", errorLogCopy().find((e) => e.text.startsWith("[load]"))?.count === 2);
for (let i = 0; i < 60; i++) logLine("error", `distinct failure ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
check("At most 40 lines kept", errorLog().length === 40, `${errorLog().length}`);
const cutLog = errorLogText(300);
check("Cut to length, the newest kept and the cut said", cutLog.length <= 360 && cutLog.startsWith("(") && cutLog.includes("distinct failure HC"), cutLog.split("\n")[0]);

console.log(failed ? `\n${failed} report detail check(s) failed.` : "\nAll report detail checks passed.");
process.exit(failed ? 1 : 0);
