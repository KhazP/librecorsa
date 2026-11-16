import type { FrameSummary } from "@/lib/render/frame-stats";

/**
 * What a bug report adds by itself, as rows the player sees (and can leave out) before it goes to GitHub, and the
 * text of the issue's "Game details" field. The facts are read once, when the report opens (the telemetry keeps
 * moving under the pause menu), by the game; this module only words them, so scripts/verify-report-details.ts can
 * check it without a browser.
 *
 * Each row answers a question a report had to be asked back: which build (#111), the frame rate (#111, #116), the
 * input actually driven (#124 said "Controller" and "keyboard"), whether laps were waiting to post (#122), and where
 * on the circuit it happened (#113, #124 described it in words).
 */

/** The issue form field a row fills */
export type ReportField = "circuit" | "car" | "input" | "hardware" | "quality" | "system" | "details" | "console";

export interface ReportRow {
  id: string;
  label: string;
  value: string;
  field: ReportField;
  /** The form needs it (GitHub refuses the issue without it): always sent */
  locked?: boolean;
  /** Left out until the player puts it in (their driver name) */
  offByDefault?: boolean;
}

/** Where the car was when the report opened from the pause menu */
export interface DriveFacts {
  /** "Practice", "Race against AI"… */
  mode: string;
  lap: number;
  totalLaps: number | null;
  distanceM: number;
  lengthM: number;
  /** "Turn 4, Remus", or null away from the corners */
  turn: string | null;
  speedKmh: number;
  /** "dry", "damp", "wet", "flooded" */
  surface: string;
  replay: boolean;
}

/** What the game knows when a report opens, beside the circuit, car and system the form already had */
export interface ReportFacts {
  /** The deployed build ("" in a local build) */
  build: string;
  physicsVersion: number;
  /** Browser tab, installed web app, Android app or desktop app */
  app: string;
  /** "8 cores, 8 GB" (the memory where the browser tells it) */
  device: string | null;
  /** The input the last lap was driven with, else the one set up */
  input: string;
  /** Controllers and wheels the browser sees, with the force-feedback device */
  devices: string | null;
  frames: FrameSummary | null;
  /** Assists, realism, frame cap… */
  settings: string;
  /** The online board and laps waiting to post */
  board: string;
  /** Opened from the pause menu: where the car was */
  drive: DriveFacts | null;
  /** The player's driver name and code, for a board problem */
  driver: string | null;
}

/** Thousands with a comma, as the game writes distances */
const metres = (m: number) => `${Math.round(m).toLocaleString("en-US")} m`;

/** The frame rate line: "57 fps over 60 s of driving, frames 16.8 ms typical and 24.1 ms at worst 5 %, 2 over 50 ms" */
export function frameLine(f: FrameSummary | null): string | null {
  if (!f || f.seconds < 2) return null;
  const parts = [
    `${f.fps.toFixed(0)} fps over the last ${Math.round(f.seconds)} s of driving`,
    `${f.p50Ms.toFixed(1)} ms typical, ${f.p95Ms.toFixed(1)} ms slowest 5 %`,
    `${f.longFrames} ${f.longFrames === 1 ? "frame" : "frames"} over 50 ms`,
  ];
  if (f.agoS >= 60) parts.push(`${Math.round(f.agoS / 60)} min before the report`);
  return parts.join(", ");
}

/** "Lap 3 of 5, 1,302 m of 5,340 m (24 %), Turn 4, Remus, 182 km/h, AI race, damp" */
export function whereLine(d: DriveFacts): string {
  const share = d.lengthM > 0 ? Math.round((d.distanceM / d.lengthM) * 100) : null;
  return [
    d.replay ? "In a replay" : null,
    `lap ${d.lap}${d.totalLaps ? ` of ${d.totalLaps}` : ""}`,
    `${metres(d.distanceM)}${d.lengthM > 0 ? ` of ${metres(d.lengthM)}` : ""}${share !== null ? ` (${share} %)` : ""}`,
    d.turn,
    `${Math.round(d.speedKmh)} km/h`,
    d.mode,
    `${d.surface} track`,
  ]
    .filter(Boolean)
    .join(", ")
    .replace(/^lap/, "Lap");
}

/** The nearest corner to a distance along the lap, both ways round the start line */
export function nearestTurn(
  turns: readonly { number: number; name: string; sApprox: number }[],
  distanceM: number,
  lengthM: number,
  withinM = 250
): { number: number; name: string } | null {
  let best: { number: number; name: string } | null = null;
  let bestGap = Infinity;
  for (const t of turns) {
    let gap = Math.abs(t.sApprox - distanceM);
    if (lengthM > 0) {
      // Both ways round the start line, for a distance past the lap's length too (a run on past a hill climb's finish)
      const d = (((t.sApprox - distanceM) % lengthM) + lengthM) % lengthM;
      gap = Math.min(d, lengthM - d);
    }
    if (gap < bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return best && bestGap <= withinM ? { number: best.number, name: best.name } : null;
}

/** "Turn 4, Remus" ("Turn 4 — Remus" in the data), or "Turn 7" when the corner has no name of its own */
export function turnLabel(t: { number: number; name: string }): string {
  const own = t.name.replace(/^turn\s*\d+\s*[—–-]?\s*/i, "").trim();
  return own ? `Turn ${t.number}, ${own}` : `Turn ${t.number}`;
}

/** Desktop app, Android app, installed web app or browser tab, from what the page can see */
export function appChannel(o: { userAgent: string; storeBuild: boolean; installed: boolean }): string {
  const electron = o.userAgent.match(/Electron\/(\d+)/)?.[1];
  if (electron) return `Desktop app (Electron ${electron})`;
  if (o.storeBuild) return "Android app";
  return o.installed ? "Installed web app" : "Browser tab";
}

/** "8 cores, 8 GB" (Chrome rounds the memory and stops at 8) */
export function deviceLine(cores: number | undefined, memoryGb: number | undefined): string | null {
  const parts = [cores ? `${cores} cores` : null, memoryGb ? `${memoryGb} GB memory${memoryGb >= 8 ? " or more" : ""}` : null];
  const line = parts.filter(Boolean).join(", ");
  return line || null;
}

/** The online board: "on, 2 laps waiting to post", "couldn't be reached", "off" */
export function boardLine(state: "on" | "off" | "unreachable" | null, waiting: number): string {
  const head = state === "on" ? "reachable" : state === "unreachable" ? "couldn't be reached" : state === "off" ? "off" : "not checked yet";
  return waiting > 0 ? `${head}, ${waiting} ${waiting === 1 ? "lap" : "laps"} waiting to post` : head;
}

/**
 * The rows a bug report adds, in the order they show. `base` is what the form had before (circuit, car, graphics,
 * browser, screen, GPU); the order of the details rows is also their worth: a report too long for GitHub's address
 * loses them from the end.
 */
export function bugReportRows(
  base: { circuit: string; car: string; input: string; graphics: string; browser: string; screen: string; gpu: string },
  facts: ReportFacts | null
): ReportRow[] {
  const rows: ReportRow[] = [
    { id: "circuit", label: "Circuit", value: base.circuit, field: "circuit" },
    { id: "car", label: "Car", value: base.car, field: "car" },
    { id: "input", label: "Input", value: facts?.input ?? base.input, field: "input" },
  ];
  if (facts?.devices) rows.push({ id: "devices", label: "Devices", value: facts.devices, field: "hardware" });
  rows.push(
    { id: "graphics", label: "Graphics", value: base.graphics, field: "quality" },
    { id: "browser", label: "Browser", value: base.browser, field: "system", locked: true },
    { id: "screen", label: "Screen", value: base.screen, field: "system" },
    { id: "gpu", label: "GPU", value: base.gpu, field: "system" }
  );
  if (!facts) return rows;
  if (facts.drive) rows.push({ id: "where", label: "Where", value: whereLine(facts.drive), field: "details" });
  rows.push({
    id: "build",
    label: "Build",
    value: `${facts.build || "local"} · physics ${facts.physicsVersion}`,
    field: "details",
  });
  const frames = frameLine(facts.frames);
  if (frames) rows.push({ id: "frames", label: "Frame rate", value: frames, field: "details" });
  if (facts.frames?.graphics) rows.push({ id: "drawn", label: "Drawn with", value: facts.frames.graphics, field: "details" });
  rows.push({ id: "app", label: "App", value: facts.app, field: "details" });
  rows.push({ id: "settings", label: "Settings", value: facts.settings, field: "details" });
  if (facts.device) rows.push({ id: "device", label: "Device", value: facts.device, field: "details" });
  rows.push({ id: "board", label: "Online laps", value: facts.board, field: "details" });
  if (facts.driver) rows.push({ id: "driver", label: "Driver", value: facts.driver, field: "details", offByDefault: true });
  return rows;
}

/** The rows a wheel report adds: all on its one "Browser and system" line */
export function wheelReportRows(base: { browser: string; screen: string; gpu: string }, facts: ReportFacts | null): ReportRow[] {
  const rows: ReportRow[] = [
    { id: "browser", label: "Browser", value: base.browser, field: "system", locked: true },
    { id: "screen", label: "Screen", value: base.screen, field: "system" },
    { id: "gpu", label: "GPU", value: base.gpu, field: "system" },
  ];
  if (!facts) return rows;
  if (facts.devices) rows.push({ id: "devices", label: "Devices", value: facts.devices, field: "system" });
  rows.push(
    { id: "build", label: "Build", value: `${facts.build || "local"} · physics ${facts.physicsVersion}`, field: "system" },
    { id: "app", label: "App", value: facts.app, field: "system" }
  );
  return rows;
}

/** The "Game details" field: one "Label: value" line per row it holds */
export function detailsText(rows: readonly ReportRow[]): string {
  return rows
    .filter((r) => r.field === "details")
    .map((r) => `${r.label}: ${r.value}`)
    .join("\n");
}

/** A field's text from its rows, joined with " · " (the system line: browser · screen · GPU) */
export function fieldText(rows: readonly ReportRow[], field: Exclude<ReportField, "details" | "console">): string {
  return rows
    .filter((r) => r.field === field)
    // The system line names what isn't plain from the value: "Chrome 141 on Windows · 1920×1080 … · GPU: … · Build: …"
    .map((r) => (field === "system" && r.id !== "browser" && r.id !== "screen" ? `${r.label}: ${r.value}` : r.value))
    .join(" · ");
}

/**
 * Longest pre-filled issue address that survives GitHub's sign-in (measured 16 Nov 2026 on a public repository):
 * signed out, the "new issue" page sends the player to sign in with the whole address as the way back, and dropped
 * it from about 5,000 characters on (the player then lands on an empty form); signed in, the page failed from about
 * 7,000. Most players who report are signed out.
 */
export const ISSUE_URL_BUDGET = 4500;

/**
 * The issue address within the budget: the error log is cut first (to its newest lines, then away), then the details
 * rows from the end. The player's own words are never cut (the form limits them instead).
 */
export function fitIssueUrl(
  build: (o: { logChars: number; detailRows: number }) => string,
  detailRowCount: number,
  budget = ISSUE_URL_BUDGET
): { url: string; logChars: number; detailRows: number } {
  let url = "";
  for (const logChars of LOG_STEPS) {
    url = build({ logChars, detailRows: detailRowCount });
    if (url.length <= budget) return { url, logChars, detailRows: detailRowCount };
  }
  for (let keep = detailRowCount - 1; keep >= 0; keep--) {
    url = build({ logChars: 0, detailRows: keep });
    if (url.length <= budget) return { url, logChars: 0, detailRows: keep };
  }
  return { url, logChars: 0, detailRows: 0 };
}

/** The error log's lengths tried, longest first (characters of text) */
export const LOG_STEPS = [2500, 1200, 600, 0] as const;
