/**
 * What's new patch notes (`src/lib/home/whats-new.json`, `HomeHub.tsx`):
 * validates ordering, entry schema, historical git alignment (when full history is checked out),
 * UI tab order, and unread pulse wiring.
 *
 *   npx tsx scripts/verify-whats-new.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WhatsNewDay } from "../src/components/home/home-data";

const ROOT = process.cwd();
const DATA_PATH = join(ROOT, "src/lib/home/whats-new.json");
const HOME_HUB_PATH = join(ROOT, "src/components/home/HomeHub.tsx");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failed++;
}

function isValidCalendarDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

const raw = readFileSync(DATA_PATH, "utf8");
const parsed: unknown = JSON.parse(raw);
// Covers every active day from project start (17 Oct 2026) through 14 Nov 2026
check("whats-new.json is an array with at least 20 days", Array.isArray(parsed) && parsed.length >= 20, `${Array.isArray(parsed) ? parsed.length : 0} days`);

const entries = (Array.isArray(parsed) ? parsed : []) as WhatsNewDay[];
const seenDates = new Set<string>();
let prevDate: string | null = null;

for (const entry of entries) {
  const label = entry?.date || "(missing date)";
  const dateOk = typeof entry?.date === "string" && isValidCalendarDate(entry.date) && !seenDates.has(entry.date);
  if (typeof entry?.date === "string") seenDates.add(entry.date);
  const orderOk = prevDate === null || (typeof entry?.date === "string" && entry.date < prevDate);
  if (typeof entry?.date === "string") prevDate = entry.date;

  const titleOk =
    typeof entry?.title === "string" &&
    entry.title.length > 0 &&
    entry.title.trim() === entry.title &&
    !entry.title.endsWith(".") &&
    !EMOJI_RE.test(entry.title);
  const itemsOk =
    Array.isArray(entry?.items) &&
    entry.items.length >= 1 &&
    entry.items.length <= 12 &&
    entry.items.every((it) => typeof it === "string" && it.length > 0 && it.trim() === it && it.endsWith(".") && !EMOJI_RE.test(it));
  const commitsOk = Number.isInteger(entry?.commits) && entry.commits >= 1;
  const shaOk = typeof entry?.lastSha === "string" && /^[0-9a-f]{40}$/.test(entry.lastSha);

  check(`${label}: valid schema, descending date, clean prose`, dateOk && orderOk && titleOk && itemsOk && commitsOk && shaOk, `${entry?.commits ?? "?"} commits`);
}

// Shallow clones (e.g. CI default checkout) skip full git history verification safely
const hasFullHistory = spawnSync("git", ["cat-file", "-e", "b57d085^{commit}"], { cwd: ROOT, stdio: "ignore" }).status === 0;
if (hasFullHistory) {
  for (const entry of entries) {
    const exists = spawnSync("git", ["cat-file", "-e", `${entry.lastSha}^{commit}`], { cwd: ROOT, stdio: "ignore" }).status === 0;
    check(`${entry.date}: lastSha resolves in git`, exists, entry.lastSha.slice(0, 7));
  }

  const gitLog = spawnSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "log",
      "--no-merges",
      "--date=format-local:%Y-%m-%d",
      "--format=%cd\x1f%H",
      "HEAD",
      "--",
      ".",
      ":(exclude)src/lib/home/whats-new.json",
    ],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, TZ: "Europe/Istanbul" }, maxBuffer: 8 * 1024 * 1024 }
  );
  check("git log in Europe/Istanbul succeeded", gitLog.status === 0);

  if (gitLog.status === 0) {
    const gitDays = new Map<string, { commits: number; lastSha: string }>();
    for (const line of gitLog.stdout.trim().split("\n")) {
      if (!line) continue;
      const [d, sha] = line.split("\x1f");
      const cur = gitDays.get(d);
      if (cur) cur.commits++;
      else gitDays.set(d, { commits: 1, lastSha: sha });
    }
    for (const entry of entries) {
      const g = gitDays.get(entry.date);
      if (entry.date <= "2026-11-14") {
        check(
          `${entry.date}: historical count & lastSha match git`,
          !!g && g.commits === entry.commits && g.lastSha === entry.lastSha,
          g ? `${g.commits} commits, ${g.lastSha.slice(0, 7)}` : "missing"
        );
      } else {
        check(
          `${entry.date}: commit count fits day's git log`,
          !!g && entry.commits <= g.commits,
          g ? `${entry.commits}/${g.commits} commits` : "missing"
        );
      }
    }
  }
} else {
  console.log("SKIP  full git history checks (shallow checkout)");
}

const hub = readFileSync(HOME_HUB_PATH, "utf8");
const tabOrderMatch = /id:\s*"cars"[\s\S]*?id:\s*"whats-new"[\s\S]*?id:\s*"about"/.test(hub);
check("HomeHub places What's new between Cars and About", tabOrderMatch);
check("HomeHub uses cyan (lc-cyan, #00E5FF) for unread dot", (hub.includes("bg-lc-cyan") || hub.includes("#00E5FF")) && hub.includes("UNREAD_DOT"));
check("HomeHub persists seen state in librecorsa.whatsNewSeen", hub.includes("librecorsa.whatsNewSeen"));

console.log(failed ? `\n${failed} What's new check(s) failed.` : "\nAll What's new checks passed.");
if (failed) process.exit(1);
