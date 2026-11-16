/**
 * The game's own error log, for bug reports: the console's errors and warnings, uncaught errors and rejections, and
 * what the game notes itself (a lost WebGL context, a stalled simulation worker), kept in memory for this page only.
 * Most players never open the console (F12), and a phone has none, so the Feedback panel fills the report's "Console
 * errors" field from here (issue #123: the pasted log was what found the bug; most reports leave it empty).
 *
 * Nothing leaves the page on its own: the log goes into a report only when the player sends one, shown to them first,
 * and a line can be left out. A message seen again is counted on its first line rather than kept twice, so a warning
 * repeated every frame takes one line. Long messages are cut, and the query part of any address is dropped (it can
 * carry a room code).
 */

export type LogLevel = "error" | "warn" | "note";

export interface LogEntry {
  /** Seconds since the page started, when it was last seen */
  t: number;
  level: LogLevel;
  text: string;
  /** Times seen */
  count: number;
}

/** Distinct lines kept; the oldest go first */
const MAX_ENTRIES = 40;
/** Characters kept of one message */
const MAX_TEXT = 300;

const entries: LogEntry[] = [];
let installed = false;

const now = () => (typeof performance === "undefined" ? 0 : performance.now() / 1000);

/** A message with its numbers taken out, to tell repeats apart from new lines */
const sameLine = (s: string) => s.replace(/\d+(\.\d+)?/g, "#");

/** An address without its query or fragment (a room code, a key) */
const stripQueries = (s: string) => s.replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"')]*/g, "$1");

/** How many of an object's keys a line shows */
const MAX_KEYS = 12;

/**
 * One console argument as text: an Error by its name and message, a plain object or array by its first keys with
 * nested values named, not walked, and anything else by its class. three.js hands its own warnings whole geometries
 * and scene objects, which a full JSON.stringify would serialise on the main thread
 */
export function describeArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === "string") return arg;
  if (arg === undefined || arg === null || typeof arg !== "object") return String(arg);
  const proto = Object.getPrototypeOf(arg);
  if (!Array.isArray(arg) && proto !== Object.prototype && proto !== null) return `[${arg.constructor?.name || "object"}]`;
  const shallow = (v: unknown): unknown =>
    v === null || typeof v !== "object" ? v : Array.isArray(v) ? `[array ${v.length}]` : `[${(v as object).constructor?.name || "object"}]`;
  try {
    if (Array.isArray(arg)) return JSON.stringify(arg.slice(0, MAX_KEYS).map(shallow));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(arg).slice(0, MAX_KEYS)) out[k] = shallow((arg as Record<string, unknown>)[k]);
    return JSON.stringify(out);
  } catch {
    return Object.prototype.toString.call(arg);
  }
}

/** Keeps a line, or counts it again when the same line is already kept */
export function logLine(level: LogLevel, text: string): void {
  const clean = stripQueries(text.replace(/\s+/g, " ").trim());
  if (!clean) return;
  const cut = clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
  const at = now();
  // The same message with other numbers in it ("long frame: 140 ms", "… 212 ms") is the same line, its latest kept
  const key = sameLine(cut);
  const seen = entries.find((e) => e.level === level && sameLine(e.text) === key);
  if (seen) {
    seen.count += 1;
    seen.t = at;
    seen.text = cut;
    return;
  }
  entries.push({ t: at, level, text: cut, count: 1 });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Something the game itself wants in a report (a lost context, a stalled worker) */
export const noteForReport = (text: string): void => logLine("note", text);

/**
 * Starts the log: the console's errors and warnings go through it (and on to the console as before), so do the
 * game's own tagged notes ("[sim] …", "[quality] …", "[gpu] …"), and uncaught errors and rejections are kept. Once per
 * page; nothing on the server. (The browser's console then names this file as where each line came from.)
 */
export function installErrorLog(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const method of ["error", "warn", "info"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      try {
        // An info line is kept only with a tag ("[sim] …", or "[sim]" as its own first argument): untagged ones are not
        // described at all
        const tagged = (a: unknown) => typeof a === "string" && /^\[[a-z-]+\]( |$)/i.test(a);
        if (method !== "info") logLine(method, args.map(describeArg).join(" "));
        else if (tagged(args[0])) logLine("note", args.map(describeArg).join(" "));
      } catch {
        // The log must never break the console
      }
      original(...args);
    };
  }
  window.addEventListener("error", (e) => {
    const where = e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : "";
    logLine("error", `Uncaught ${e.error instanceof Error ? describeArg(e.error) : e.message}${where}`);
  });
  window.addEventListener("unhandledrejection", (e) => logLine("error", `Unhandled rejection: ${describeArg(e.reason)}`));
}

/** The kept lines, oldest first */
export const errorLog = (): readonly LogEntry[] => entries;

/** One line of the log as it reads in a report: `[  64.2 s] error ×3  message` */
export function formatLogLine(e: LogEntry): string {
  const count = e.count > 1 ? ` ×${e.count}` : "";
  return `[${e.t.toFixed(1).padStart(6)} s] ${e.level}${count}  ${e.text}`;
}

/** A copy of the log as it is now (a report keeps what was there when it opened) */
export const errorLogCopy = (): LogEntry[] => entries.map((e) => ({ ...e }));

/** The log as text for a report, newest kept when it must be cut to `maxChars` */
export function errorLogText(maxChars = 2500, from: readonly LogEntry[] = entries): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = from.length - 1; i >= 0; i--) {
    const line = formatLogLine(from[i]);
    if (used + line.length + 1 > maxChars) {
      lines.unshift(`(${i + 1} older ${i === 0 ? "line" : "lines"} left out)`);
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
