"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button, Card, Disclosure, Segmented, Select, SettingRow, TextField, Toggle } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { CURSOR_ROW, cx, MOTION } from "@/components/ui/styles";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { errorLogCopy, errorLogText, type LogEntry } from "@/lib/diagnostics/error-log";
import {
  bugReportRows,
  detailsText,
  fieldText,
  fitIssueUrl,
  LOG_STEPS,
  wheelReportRows,
  type ReportFacts,
  type ReportRow,
} from "@/lib/diagnostics/report-details";
import { gpuReportLine, liveSessionRenderer, probeRenderer } from "@/lib/render/gpu-health";
import {
  blockedCreatorMatch,
  classifyModelLink,
  evaluateContentPermission,
  isLowEffortText,
  PERMISSION_WRITTEN,
  REQUEST_LIMITS,
} from "@/lib/feedback/request-rules";

/**
 * Feedback goes to GitHub as a pre-filled issue form (.github/ISSUE_TEMPLATE): bug-report.yml, wheel-report.yml,
 * idea.yml and content-request.yml. The query keys below are those forms' field ids. GitHub only pre-fills text
 * fields from the URL, so every value is sent as plain text.
 */
const REPO_URL = "https://github.com/librecorsa/librecorsa";

const KINDS = ["Bug", "Wheel", "Idea", "Car", "Track"] as const;
export type FeedbackKind = (typeof KINDS)[number];

const TEMPLATES: Record<FeedbackKind, string> = {
  Bug: "bug-report.yml",
  Wheel: "wheel-report.yml",
  Idea: "idea.yml",
  Car: "content-request.yml",
  Track: "content-request.yml",
};

const LICENSES = ["CC BY / CC BY-SA", "CC0 / public domain", "CC BY-NC / CC BY-NC-SA", "Other license", "Don't know"] as const;
const PERMISSIONS = ["The license allows it", "The creator gave written permission", "Not asked yet", "Don't know"] as const;

/** What the game knows about the session, added to bug reports so the player doesn't have to look it up */
export interface FeedbackContext {
  circuit: string;
  car: string;
  /** Input device in use (Keyboard, Controller, Wheel…) */
  device: string;
  /** Graphics quality and render resolution */
  graphics: string;
}

/** The context of a report from the circuit, the car and the player's settings (the title and the pause menu) */
export function feedbackContextOf(
  track: { name: string; layout?: string | null },
  carTitle: string,
  settings: { device: "keyboard" | "controller" | "wheel"; graphics: { quality: string; renderScale: number } } | undefined
): FeedbackContext {
  return {
    circuit: `${track.name}${track.layout ? `, ${track.layout}` : ""}`,
    car: carTitle,
    device: settings ? { keyboard: "Keyboard", controller: "Controller", wheel: "Wheel" }[settings.device] : "Unknown",
    graphics: settings
      ? `${settings.graphics.quality[0].toUpperCase()}${settings.graphics.quality.slice(1)} · render ${Math.round(settings.graphics.renderScale * 100)}%`
      : "Unknown",
  };
}

type FeedbackTranslator = ReturnType<typeof useTranslations<"menu.feedback">>;

/**
 * The panel is called Feedback wherever it opens (the title menu's entry, the pause menu's tab); what each kind is for
 * is said under that heading
 */
const copyOf = (tx: FeedbackTranslator, kind: FeedbackKind): { label: string; intro: string; send: string } =>
  ({
    Bug: { label: tx("kindBug"), intro: tx("introBug"), send: tx("sendReport") },
    Wheel: { label: tx("kindWheel"), intro: tx("introWheel"), send: tx("sendReport") },
    Idea: { label: tx("kindIdea"), intro: tx("introIdea"), send: tx("sendIdea") },
    Car: { label: tx("kindCar"), intro: tx("introCar"), send: tx("sendRequest") },
    Track: { label: tx("kindTrack"), intro: tx("introTrack"), send: tx("sendRequest") },
  })[kind];

/**
 * The licence and permission choices as the player reads them. Their values, which the issue gets and the form
 * compares, stay as they are; the licences' own names are shown as they are too
 */
const licenseOptions = (tx: FeedbackTranslator) => {
  const labels: Partial<Record<(typeof LICENSES)[number], string>> = {
    [LICENSES[1]]: tx("licenseCc0"),
    [LICENSES[3]]: tx("licenseOther"),
    [LICENSES[4]]: tx("licenseUnknown"),
  };
  return LICENSES.map((id) => ({ id, label: labels[id] ?? id }));
};
const permissionOptions = (tx: FeedbackTranslator) => {
  const labels: Record<(typeof PERMISSIONS)[number], string> = {
    [PERMISSIONS[0]]: tx("permissionLicense"),
    [PERMISSIONS[1]]: tx("permissionWritten"),
    [PERMISSIONS[2]]: tx("permissionNotAsked"),
    [PERMISSIONS[3]]: tx("permissionUnknown"),
  };
  return PERMISSIONS.map((id) => ({ id, label: labels[id] }));
};

/** A line the report adds, named for the player (the issue gets the line's own English name) */
const rowLabel = (tx: FeedbackTranslator, row: ReportRow): string => {
  const keys: Record<string, Parameters<FeedbackTranslator>[0]> = {
    circuit: "rowCircuit",
    car: "rowCar",
    input: "rowInput",
    devices: "rowDevices",
    graphics: "rowGraphics",
    browser: "rowBrowser",
    screen: "rowScreen",
    gpu: "rowGpu",
    where: "rowWhere",
    build: "rowBuild",
    frames: "rowFrames",
    drawn: "rowDrawn",
    app: "rowApp",
    settings: "rowSettings",
    device: "rowDevice",
    board: "rowBoard",
    driver: "rowDriver",
  };
  const key = keys[row.id];
  return key ? tx(key) : row.label;
};

/** A field's hint, with a caution line under it when there is one */
const hintWith = (hint?: string, caution?: string): React.ReactNode =>
  caution ? (
    <>
      {hint ? <span className="block">{hint}</span> : null}
      <span className="mt-0.5 flex items-start gap-1.5 text-lc-caution">
        <Icon name="warning" size="xs" className="mt-px" />
        {caution}
      </span>
    </>
  ) : (
    hint
  );

/** A labelled drop-down in the form: the field label above, the kit's select at full width */
const FieldSelect: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { id: string; label: string }[];
}> = ({ label, value, onChange, options }) => {
  const tx = useTranslations("menu.feedback");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="lc-field-label" aria-hidden>
        {label}
      </span>
      <Select aria-label={label} className="w-full" placeholder={tx("choose")} value={value} onChange={onChange} options={options} />
    </div>
  );
};

/** A problem with the request, said in the loss colour on the form itself */
const Problem: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="m-0 flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-loss">
    <Icon name="error" size="xs" className="mt-0.5" />
    <span>{children}</span>
  </p>
);

/** Browser and OS from the user agent, e.g. "Chrome 141 on Windows" */
function browserName(ua: string): string {
  const pick = (re: RegExp) => ua.match(re)?.[1];
  const browser = pick(/Edg\/(\d+)/)
    ? `Edge ${pick(/Edg\/(\d+)/)}`
    : pick(/OPR\/(\d+)/)
      ? `Opera ${pick(/OPR\/(\d+)/)}`
      : pick(/Firefox\/(\d+)/)
        ? `Firefox ${pick(/Firefox\/(\d+)/)}`
        : pick(/Chrome\/(\d+)/)
          ? `Chrome ${pick(/Chrome\/(\d+)/)}`
          : pick(/Version\/(\d+).*Safari/)
            ? `Safari ${pick(/Version\/(\d+).*Safari/)}`
            : "Unknown browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "unknown OS";
  return `${browser} on ${os}`;
}

/**
 * The GPU the game started on (unmasked when allowed), and whether its WebGL context was lost: read when the session
 * started, as a fresh probe after a loss may only find "no WebGL" (issue #123). With the session drawing, no probe.
 */
function gpuName(): string {
  const live = liveSessionRenderer();
  return gpuReportLine(live ? () => live : probeRenderer);
}

export interface SystemInfo {
  browser: string;
  screen: string;
  gpu: string;
}

function readSystem(): SystemInfo {
  const dpr = Math.round(window.devicePixelRatio * 100) / 100;
  return {
    browser: browserName(navigator.userAgent),
    screen: `${screen.width}×${screen.height} @${dpr}x, window ${innerWidth}×${innerHeight}`,
    gpu: gpuName(),
  };
}

export interface FeedbackForm {
  kind: FeedbackKind;
  /** Bug: what happened · Wheel: base and rim · Idea: the idea · Car / Track: which one */
  main: string;
  /** Bug: steps · Wheel: firmware · Idea: why · Car / Track: model link */
  second: string;
  /** Bug: controller / wheel model · Idea: area · Car / Track: creator */
  third: string;
  license: string;
  permission: string;
  /** Car / Track with a Sketchfab link: the sim modders were asked first and said no */
  askedModders: boolean;
  /** Car / Track with an OverTake link: its modder was asked and said yes */
  modderSaidYes: boolean;
  notes: string;
}

const firstLine = (s: string, max = 70) => {
  const line = s.trim().split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What the game adds to a report, as the player left it: the rows still in (`ReportRow`, report-details.ts) and the
 * error log's text. Without it a report carries the circuit, car, input, graphics and system line only.
 */
export interface ReportAdded {
  rows: readonly ReportRow[];
  log: string;
}

/** The GitHub "new issue" URL with the matching form filled in */
export function feedbackIssueUrl(f: FeedbackForm, ctx: FeedbackContext | undefined, sys: SystemInfo | null, added?: ReportAdded): string {
  const q = new URLSearchParams({ template: TEMPLATES[f.kind] });
  const set = (key: string, value: string | undefined) => {
    const v = value?.trim();
    if (v) q.set(key, v);
  };
  const system = sys ? `${sys.browser} · ${sys.screen} · GPU: ${sys.gpu}` : "";
  switch (f.kind) {
    case "Bug":
      q.set("title", `[Bug] ${firstLine(f.main)}`);
      set("what", f.main);
      set("steps", f.second);
      if (added) {
        set("circuit", fieldText(added.rows, "circuit"));
        set("car", fieldText(added.rows, "car"));
        set("input", fieldText(added.rows, "input"));
        // What the player wrote about their device, else what the browser sees
        set("hardware", f.third.trim() || fieldText(added.rows, "hardware"));
        set("browser", fieldText(added.rows, "system"));
        set("quality", fieldText(added.rows, "quality"));
        set("details", detailsText(added.rows));
        set("console", added.log);
      } else {
        set("circuit", ctx?.circuit);
        set("car", ctx?.car);
        set("input", ctx?.device);
        set("hardware", f.third);
        set("browser", system);
        set("quality", ctx?.graphics);
      }
      break;
    case "Wheel":
      q.set("title", `[Wheel] ${firstLine(f.main)}`);
      set("wheel", f.main);
      set("firmware", f.second);
      set("system", added ? fieldText(added.rows, "system") : system);
      set("notes", f.notes);
      break;
    case "Idea": {
      const dq = new URLSearchParams({ category: "ideas", title: firstLine(f.main, 100) });
      const parts: string[] = [];
      if (f.third.trim()) parts.push(`**Area:** ${f.third.trim()}`);
      if (f.main.trim()) parts.push(`### Your idea\n\n${f.main.trim()}`);
      if (f.second.trim()) parts.push(`### Why it matters\n\n${f.second.trim()}`);
      if (parts.length) dq.set("body", parts.join("\n\n"));
      return `${REPO_URL}/discussions/new?${dq.toString()}`;
    }
    default:
      q.set("title", `[${f.kind} request] ${firstLine(f.main, 100)}`);
      q.set("kind", f.kind);
      set("name", f.main);
      set("link", f.second);
      set("creator", f.third);
      set("license", f.license);
      set("permission", f.permission);
      if (isSketchfab(f.second) && f.askedModders) set("modders", "Yes, they said no");
      if (isOvertake(f.second) && f.modderSaidYes) set("modders", "Yes, the modder said yes");
      set("notes", f.notes);
  }
  return `${REPO_URL}/issues/new?${q.toString()}`;
}

/** A Sketchfab page or short link: only requested once the sim modders have said no */
function isSketchfab(s: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*(sketchfab\.com|skfb\.ly)(\/|$)/i.test(s.trim());
}

/**
 * A Sketchfab model's id from its page or embed link (`sketchfab.com/3d-models/<name>-<id>`, `/models/<id>`); null
 * for a short skfb.ly link, which the browser can't follow to the model (no CORS), or any other page
 */
export function sketchfabModelId(s: string): string | null {
  const m = s.trim().match(/^https?:\/\/(?:www\.)?sketchfab\.com\/(?:3d-models\/(?:[^/?#]*-)?|models\/)([0-9a-f]{32})(?:[/?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/** A Sketchfab tag saying the model was ripped, or taken from Assetto Corsa ("Ripped", "ripped-model", "asseto-corsa") */
export const isRippedTag = (tag: string): boolean =>
  /(^|[^a-z])rip(ped)?([^a-z]|$)|(^|[^a-z])as+et+o[-_\s]?corsa/.test(tag.toLowerCase());

/** An OverTake (formerly RaceDepartment) mod page: only requested with its modder's permission */
export function isOvertake(s: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*(overtake\.gg|racedepartment\.com)(\/|$)/i.test(s.trim());
}

/** What Sketchfab's tags say about a linked model */
type TagCheck =
  | { id: string; state: "checking" }
  | { id: string; state: "clear" }
  | { id: string; state: "ripped"; tags: string[] }
  /** Sketchfab didn't answer (offline, a removed model): the request is checked by hand */
  | { id: string; state: "unknown" };

/** Reads a Sketchfab model's tags (the API allows browser requests) and flags one marked as ripped */
function useSketchfabTagCheck(modelId: string | null): TagCheck | null {
  const [check, setCheck] = useState<TagCheck | null>(null);
  useEffect(() => {
    if (!modelId) return;
    const abort = new AbortController();
    setCheck({ id: modelId, state: "checking" });
    // Wait for the link to stop changing before asking
    const timer = setTimeout(() => {
      fetch(`https://api.sketchfab.com/v3/models/${modelId}`, { signal: abort.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((model: { tags?: { name?: string; slug?: string }[] }) => {
          const tags = (model.tags ?? []).map((t) => t.name ?? t.slug ?? "").filter(Boolean);
          const flagged = tags.filter(isRippedTag);
          setCheck(flagged.length ? { id: modelId, state: "ripped", tags: flagged } : { id: modelId, state: "clear" });
        })
        .catch(() => {
          if (!abort.signal.aborted) setCheck({ id: modelId, state: "unknown" });
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [modelId]);
  return modelId && check?.id === modelId ? check : null;
}

/** Copies a picture to the clipboard where the browser can (a click must start it); false where it can't */
async function copyPicture(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** Saves a picture as a file (a phone, or a browser that won't copy pictures) */
function savePicture(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = `librecorsa-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * One line the report adds. A click (A / Enter) leaves it out or puts it back; a line the form needs stays in.
 */
const AddedRow: React.FC<{ label: string; value: string; locked?: boolean; on: boolean; onToggle: () => void }> = ({
  label,
  value,
  locked,
  on,
  onToggle,
}) => {
  const cells = (
    <>
      <span className="text-lc-slate">{label}</span>
      <span className={cx("line-clamp-2 min-w-0 break-words", on ? "text-lc-fog" : "text-lc-dim line-through")} title={value}>
        {value}
      </span>
    </>
  );
  const tx = useTranslations("menu.feedback");
  const grid = "grid grid-cols-[84px_minmax(0,1fr)_16px] items-start gap-x-3 py-1 text-start text-[13px] leading-snug";
  if (locked)
    // Sent like a ticked line, but it can't be left out: a lock where the others have their tick or dash
    return (
      <li className={cx(grid, "px-2")} title={tx("alwaysSentTitle")}>
        {cells}
        <Icon name="locked" size="sm" label={tx("alwaysSent")} className="mt-px text-lc-slate" />
      </li>
    );
  return (
    <li>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={onToggle}
        onPointerEnter={focusOnHover}
        className={cx(grid, "w-full cursor-pointer rounded-lc-row px-2 hover:bg-white/4", MOTION, CURSOR_ROW)}
      >
        {cells}
        <Icon name={on ? "check" : "remove"} size="sm" className={cx("mt-px", on ? "text-lc-chalk" : "text-lc-dim")} />
      </button>
    </li>
  );
};

/**
 * The feedback panel (the title menu's Feedback, and its tab in the pause menu): bug and wheel reports, ideas, and car
 * or circuit requests. It collects the details, adds what the game knows (the session, the build, the frame rate,
 * recent errors, where the car was), each line shown and switchable, and opens it all as a pre-filled GitHub issue.
 */
export const RequestPanel: React.FC<{
  context?: FeedbackContext;
  /** What the game knows, read once when the panel opens (report-facts.ts) */
  facts?: () => ReportFacts;
  /** A picture of the scene, taken once when the panel opens (from the pause menu) */
  screenshot?: () => Promise<Blob | null>;
  /**
   * Its own "Feedback" heading over the kind's description (the pause menu). False where the host's frame already
   * names the panel (the title menu's, with Close beside it): the description then opens the panel
   */
  heading?: boolean;
}> = ({ context, facts, screenshot, heading = true }) => {
  const tx = useTranslations("menu.feedback");
  const [kind, setKind] = useState<FeedbackKind>("Bug");
  const [main, setMain] = useState("");
  const [second, setSecond] = useState("");
  const [third, setThird] = useState("");
  const [license, setLicense] = useState<string>("");
  const [permission, setPermission] = useState<string>("");
  const [askedModders, setAskedModders] = useState(false);
  const [modderSaidYes, setModderSaidYes] = useState(false);
  const [notes, setNotes] = useState("");
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [tried, setTried] = useState(false);
  // sent: the issue has been opened on GitHub; the form waits for "Write another" so a second press opens no second one
  const [sent, setSent] = useState(false);
  const newReportRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const sentNoteId = useId();
  /** "Write another" was pressed: the form's first control takes the focus once it is back */
  const refocusForm = useRef(false);

  /** The game's facts and its error log as they were when the panel opened (the telemetry moves on under it) */
  const [factsNow, setFactsNow] = useState<ReportFacts | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  /** Lines the player left out (ids); the driver name starts out */
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(() => new Set(["driver"]));
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [shotState, setShotState] = useState<"none" | "taking" | "ready">(screenshot ? "taking" : "none");
  const [pictureNote, setPictureNote] = useState<"copied" | "saved" | "failed" | null>(null);
  /** What GitHub's address had no room for, said once the report is open */
  const [trimmed, setTrimmed] = useState<{ log: boolean; details: number } | null>(null);

  // Read in the browser after mount (the page is pre-rendered without these), once: the report keeps the moment it
  // was opened. The props' functions are new each render, so they are not dependencies.
  useEffect(() => {
    setSys(readSystem());
    setFactsNow(facts?.() ?? null);
    setLog(errorLogCopy());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!screenshot) return;
    let live = true;
    let url: string | null = null;
    screenshot()
      .then((blob) => {
        if (!live) return;
        if (!blob) return setShotState("none");
        url = URL.createObjectURL(blob);
        setShot({ blob, url });
        setShotState("ready");
      })
      .catch(() => live && setShotState("none"));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const content = kind === "Car" || kind === "Track";
  const mainOk =
    kind === "Bug"
      ? !isLowEffortText(main, REQUEST_LIMITS.bugWhatMin)
      : kind === "Idea"
        ? !isLowEffortText(main, REQUEST_LIMITS.ideaMin)
        : kind === "Wheel"
          ? main.trim().length >= 4
          : main.trim().length >= 2;
  const linkVerdict = content ? classifyModelLink(second) : { kind: "ok" as const, host: "" };
  const blockedLink =
    content && (linkVerdict.kind === "piracy" || linkVerdict.kind === "file-host" || linkVerdict.kind === "commercial-store")
      ? linkVerdict
      : null;
  const secondOk =
    kind === "Bug"
      ? !isLowEffortText(second, REQUEST_LIMITS.bugStepsMin, main)
      : content
        ? linkVerdict.kind === "ok"
        : true;
  const blockedCreator = content ? blockedCreatorMatch(third) : null;
  const creatorOk = !content || (third.trim().length >= REQUEST_LIMITS.creatorMin && !blockedCreator);
  // A model can only be added under an explicit open license (when "The license allows it" is selected) or with
  // written permission from the creator backed by a link/note in Anything else.
  const permCheck = content ? evaluateContentPermission(license, permission, notes) : ({ ok: true } as const);
  const permitted = permCheck.ok;
  const needsProof = content && permission === PERMISSION_WRITTEN;
  const showPermCaution = content && !permitted && (permission !== "" || license === "Don't know" || license === "Other license");
  // Sketchfab models are a last resort (no physics, tarmac grip, kerbs or racing line): the sim modders come first
  const sketchfab = content && isSketchfab(second);
  // A Sketchfab model tagged as ripped, or as taken from Assetto Corsa, can't be used at all. Its tags are read from
  // its full link: a short skfb.ly link can't be followed from the browser
  const sketchfabId = sketchfab ? sketchfabModelId(second) : null;
  const tagCheck = useSketchfabTagCheck(sketchfabId);
  const sketchfabLinkOk = !sketchfab || sketchfabId !== null;
  const tagsChecking = sketchfab && tagCheck?.state === "checking";
  const rippedModel = sketchfab && tagCheck?.state === "ripped" ? tagCheck.tags : null;
  // An OverTake mod is only requested once its modder has said yes
  const overtake = content && isOvertake(second);
  const moddersOk = (!sketchfab || askedModders) && (!overtake || modderSaidYes);
  const ready = mainOk && secondOk && creatorOk && sketchfabLinkOk && !tagsChecking && !rippedModel && permitted && moddersOk;
  const copy = copyOf(tx, kind);

  const clearFields = () => {
    setMain("");
    setSecond("");
    setThird("");
    setAskedModders(false);
    setModderSaidYes(false);
    setNotes("");
    setTried(false);
  };

  const pickKind = (k: FeedbackKind) => {
    // The shared fields mean different things per kind: start them empty
    if (k !== kind) clearFields();
    setKind(k);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (sent) return;
    setTried(true);
    if (!ready) {
      // The first field that says what is wrong takes the focus (its error is read with it)
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    const form: FeedbackForm = { kind, main, second, third, license, permission, askedModders, modderSaidYes, notes };
    if (!rows.length) {
      window.open(feedbackIssueUrl(form, context, sys), "_blank", "noopener,noreferrer");
      setSent(true);
      return;
    }
    // The lines still in; the details last, as the address loses them from the end when it runs long
    const kept = rows.filter((r) => r.locked || !leftOut.has(r.id));
    const details = kept.filter((r) => r.field === "details");
    const others = kept.filter((r) => r.field !== "details");
    const withLog = logShown && !leftOut.has("errors");
    const fit = fitIssueUrl(
      ({ logChars, detailRows }) =>
        feedbackIssueUrl(form, context, sys, {
          rows: [...others, ...details.slice(0, detailRows)],
          log: withLog && logChars > 0 ? errorLogText(logChars, log) : "",
        }),
      details.length
    );
    window.open(fit.url, "_blank", "noopener,noreferrer");
    const logLost = withLog && errorLogText(fit.logChars, log) !== errorLogText(LOG_STEPS[0], log);
    setTrimmed(logLost || fit.detailRows < details.length ? { log: logLost, details: details.length - fit.detailRows } : null);
    setSent(true);
  };

  const newReport = () => {
    clearFields();
    setTrimmed(null);
    setPictureNote(null);
    setLicense("");
    setPermission("");
    refocusForm.current = true;
    setSent(false);
  };

  // The send button is gone once sent: keep the focus (a controller's) on the way to a new report
  useEffect(() => {
    if (sent) newReportRef.current?.focus({ preventScroll: true });
    else if (refocusForm.current) {
      // "Write another" is gone with the card it sat on: the focus goes to the form, not to the page
      refocusForm.current = false;
      formRef.current?.querySelector<HTMLElement>('button:not([tabindex="-1"]), input, textarea')?.focus({ preventScroll: true });
    }
  }, [sent]);

  // What the report adds, line by line (bug and wheel reports)
  const rows: ReportRow[] = useMemo(() => {
    const base = {
      circuit: context?.circuit ?? "Not known",
      car: context?.car ?? "Not known",
      input: context?.device ?? "Not known",
      graphics: context?.graphics ?? "Not known",
      browser: sys?.browser ?? "…",
      screen: sys?.screen ?? "…",
      gpu: sys?.gpu ?? "…",
    };
    return kind === "Bug" ? bugReportRows(base, factsNow) : kind === "Wheel" ? wheelReportRows(base, factsNow) : [];
  }, [kind, context, sys, factsNow]);
  const logShown = kind === "Bug" && log.length > 0;
  const toggleLine = (id: string) =>
    setLeftOut((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const picture = async (how: "copy" | "save") => {
    if (!shot) return;
    if (how === "copy" && (await copyPicture(shot.blob))) return setPictureNote("copied");
    if (how === "copy") return setPictureNote("failed");
    savePicture(shot.url);
    setPictureNote("saved");
  };
  const pictureNoteText =
    pictureNote === "copied"
      ? tx("pictureCopied")
      : pictureNote === "saved"
        ? tx("pictureSaved")
        : pictureNote === "failed"
          ? tx("pictureFailed")
          : null;
  const pictureCopyable = typeof window !== "undefined" && typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);

  const lockedReason =
    blockedLink?.kind === "piracy"
      ? tx("lockedPiracy")
      : blockedLink?.kind === "file-host"
        ? tx("lockedFileHost")
        : blockedLink?.kind === "commercial-store"
          ? tx("lockedCommercialStore")
          : blockedCreator
            ? tx("lockedBlockedCreator")
            : rippedModel
              ? tx("lockedRipped")
              : !permCheck.ok && permCheck.problem === "proof"
                ? tx("lockedProof")
                : !permitted
                  ? tx("lockedLicense")
                  : !moddersOk
                    ? overtake
                      ? tx("lockedModder")
                      : tx("lockedSketchfab")
                    : undefined;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-7 text-lc-chalk">
      <div className="flex min-w-0 flex-col gap-4">
        {heading ? <h2 className="lc-h2">{tx("heading")}</h2> : null}
        <p className="m-0 text-[16px] leading-snug text-lc-fog">{copy.intro}</p>
        {content ? (
          <p className="lc-body m-0">{tx.rich("contentRules", { em: (chunks) => <span className="text-lc-chalk">{chunks}</span> })}</p>
        ) : null}
        {rows.length ? (
          <Card
            title={tx("included")}
            description={tx("includedHint")}
          >
            <ul className="m-0 -mx-2 flex list-none flex-col p-0">
              {rows.map((r) => (
                <AddedRow key={r.id} label={rowLabel(tx, r)} value={r.value} locked={r.locked} on={r.locked || !leftOut.has(r.id)} onToggle={() => toggleLine(r.id)} />
              ))}
              {logShown ? (
                <AddedRow
                  label={tx("gameLog")}
                  value={tx("gameLogValue", { count: log.length, latest: log[log.length - 1].text })}
                  on={!leftOut.has("errors")}
                  onToggle={() => toggleLine("errors")}
                />
              ) : null}
            </ul>
            {logShown ? (
              <Disclosure moreLabel={tx("showLog")} lessLabel={tx("hideLog")}>
                <pre className="lc-mono m-0 max-h-48 overflow-auto rounded-lc-row bg-lc-well p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-lc-fog">
                  {errorLogText(LOG_STEPS[0], log)}
                </pre>
              </Disclosure>
            ) : null}
          </Card>
        ) : null}
        <p className="lc-hint m-0 mt-auto flex items-start gap-2">
          <Icon name="externalLink" className="mt-px text-lc-info" />
          {kind === "Idea" ? tx("opensDiscussion") : tx("opensIssue")}
        </p>
      </div>

      {sent ? (
        <div className="self-start">
          <Card title={tx("opened")} bodyClassName="gap-3.5">
            <p id={sentNoteId} className="lc-body m-0">
              {shot ? tx("sentNoteShot") : tx("sentNote")}
            </p>
            {trimmed && (trimmed.details || trimmed.log) ? (
              <p className="lc-hint m-0">
                {trimmed.details
                  ? trimmed.log
                    ? tx("trimmedBoth", { count: trimmed.details })
                    : tx("trimmedDetails", { count: trimmed.details })
                  : tx("trimmedLog")}
              </p>
            ) : null}
            {shot ? (
              <div className="flex flex-wrap items-center gap-2">
                {pictureCopyable ? (
                  <Button size="sm" variant="secondary" icon={<Icon name="copy" />} onClick={() => picture("copy")}>
                    {tx("copyPicture")}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" icon={<Icon name="download" />} onClick={() => picture("save")}>
                  {tx("savePicture")}
                </Button>
              </div>
            ) : null}
            {shot ? (
              <p aria-live="polite" className="lc-hint m-0">
                {pictureNoteText}
              </p>
            ) : null}
            {/* The focus lands here once sent: the button reads the note with it */}
            <Button ref={newReportRef} variant="secondary" className="self-start" aria-describedby={sentNoteId} onClick={newReport}>
              {tx("writeAnother")}
            </Button>
          </Card>
        </div>
      ) : null}
      {/* Hidden, not unmounted, once sent: "Write another" clears it */}
      <form ref={formRef} onSubmit={submit} noValidate className={`${sent ? "hidden" : "flex"} min-w-0 flex-col gap-4`}>
        <Segmented aria-label={tx("kinds")} fill options={KINDS.map((k) => ({ id: k, label: copyOf(tx, k).label }))} value={kind} onChange={pickKind} />

        {kind === "Bug" ? (
          <>
            <TextField
              label={tx("bugWhat")}
              required
              multiline
              rows={3}
              maxLength={1500}
              hint={main.length > 1200 ? tx("bugWhatCount", { count: main.length.toLocaleString("en-US") }) : tx("bugWhatHint")}
              placeholder={tx("bugWhatPlaceholder")}
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? tx("bugWhatError") : undefined}
            />
            <TextField
              label={tx("bugSteps")}
              required
              multiline
              rows={2}
              maxLength={1500}
              hint={tx("bugStepsHint")}
              value={second}
              onChange={setSecond}
              error={tried && !secondOk ? tx("bugStepsError") : undefined}
            />
            {context && context.device !== "Keyboard" ? (
              <TextField
                label={tx("bugDevice")}
                hint={tx("bugDeviceHint")}
                maxLength={80}
                autoComplete="off"
                value={third}
                onChange={setThird}
              />
            ) : null}
          </>
        ) : null}

        {kind === "Wheel" ? (
          <>
            <TextField
              label={tx("wheelModel")}
              required
              maxLength={120}
              autoComplete="off"
              hint={tx("wheelModelHint")}
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? tx("wheelModelError") : undefined}
            />
            <TextField
              label={tx("wheelFirmware")}
              maxLength={80}
              autoComplete="off"
              hint={tx("wheelFirmwareHint")}
              value={second}
              onChange={setSecond}
            />
            <TextField
              label={tx("wheelNotes")}
              multiline
              rows={3}
              maxLength={1500}
              hint={tx("wheelNotesHint")}
              value={notes}
              onChange={setNotes}
            />
          </>
        ) : null}

        {kind === "Idea" ? (
          <>
            <TextField
              label={tx("ideaMain")}
              required
              multiline
              rows={3}
              maxLength={1500}
              placeholder={tx("ideaPlaceholder")}
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? tx("ideaError") : undefined}
            />
            <TextField
              label={tx("ideaWhy")}
              multiline
              rows={2}
              maxLength={1500}
              hint={tx("ideaWhyHint")}
              value={second}
              onChange={setSecond}
            />
            <TextField
              label={tx("ideaArea")}
              maxLength={60}
              autoComplete="off"
              hint={tx("ideaAreaHint")}
              value={third}
              onChange={setThird}
            />
          </>
        ) : null}

        {content ? (
          <>
            <TextField
              label={kind === "Track" ? tx("whichTrack") : tx("whichCar")}
              required
              maxLength={120}
              autoComplete="off"
              hint={kind === "Track" ? tx("whichTrackHint") : tx("whichCarHint")}
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? (kind === "Track" ? tx("nameTrack") : tx("nameCar")) : undefined}
            />
            <TextField
              label={tx("modelLink")}
              required
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://"
              hint={hintWith(tx("modelLinkHint"), sketchfab || overtake ? undefined : tx("modelLinkCaution"))}
              value={second}
              onChange={setSecond}
              error={
                (tried || second.trim() !== "") && linkVerdict.kind === "invalid"
                  ? tx("modelLinkError")
                  : sketchfab && !sketchfabId
                    ? tx("modelLinkShort")
                    : undefined
              }
            />
            {/* Blocked link / Sketchfab tag check runs live: what it finds is read out */}
            <div
              aria-live="polite"
              // Empty, it takes back the form's gap
              className={blockedLink || rippedModel || tagsChecking || (sketchfab && tagCheck?.state === "unknown") ? undefined : "-mt-4"}
            >
              {blockedLink?.kind === "piracy" ? (
                <Problem>{tx("blockedPiracy", { host: blockedLink.host })}</Problem>
              ) : blockedLink?.kind === "file-host" ? (
                <Problem>{tx("blockedFileHost", { host: blockedLink.host })}</Problem>
              ) : blockedLink?.kind === "commercial-store" ? (
                <Problem>{tx("blockedCommercialStore", { host: blockedLink.host })}</Problem>
              ) : rippedModel ? (
                <Problem>{tx("rippedTags", { tags: rippedModel.map((t) => `“${t}”`).join(", ") })}</Problem>
              ) : tagsChecking ? (
                <p className="lc-hint m-0">{tx("checkingTags")}</p>
              ) : sketchfab && tagCheck?.state === "unknown" ? (
                <p className="lc-hint m-0">{tx("tagsUnknown")}</p>
              ) : null}
            </div>
            {overtake ? (
              <SettingRow
                label={kind === "Track" ? tx("modderSaidYesTrack") : tx("modderSaidYesCar")}
                hint={tx("modderSaidYesHint")}
              >
                <Toggle checked={modderSaidYes} onChange={setModderSaidYes} onLabel={tx("yes")} offLabel={tx("no")} />
              </SettingRow>
            ) : null}
            {sketchfab && !rippedModel ? (
              <SettingRow
                label={kind === "Track" ? tx("askedModdersTrack") : tx("askedModdersCar")}
                hint={kind === "Track" ? tx("askedModdersTrackHint") : tx("askedModdersCarHint")}
              >
                <Toggle checked={askedModders} onChange={setAskedModders} onLabel={tx("yes")} offLabel={tx("no")} />
              </SettingRow>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label={tx("creatorRequired")}
                required
                maxLength={80}
                autoComplete="off"
                value={third}
                onChange={setThird}
                error={
                  blockedCreator
                    ? tx("creatorBlockedError")
                    : tried && !creatorOk
                      ? tx("creatorError")
                      : undefined
                }
              />
              <FieldSelect
                label={tx("license")}
                value={license}
                onChange={setLicense}
                options={licenseOptions(tx)}
              />
            </div>
            <FieldSelect
              label={tx("permission")}
              value={permission}
              onChange={setPermission}
              options={permissionOptions(tx)}
            />
            {showPermCaution && !permCheck.ok ? (
              <p className="m-0 flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-caution">
                <Icon name="warning" size="xs" className="mt-0.5" />
                {permCheck.problem === "proof"
                  ? tx("rippedNeedProof")
                  : permCheck.problem === "license"
                    ? tx("rippedNeedOpenLicense")
                    : license === "Don't know"
                      ? tx("rippedUnknownLicense")
                      : tx("rippedAskCreator")}
              </p>
            ) : null}
            <TextField
              label={needsProof ? tx("notesProof") : tx("notes")}
              required={needsProof}
              multiline
              rows={2}
              maxLength={1500}
              placeholder={needsProof ? tx("notesProofPlaceholder") : tx("notesPlaceholder")}
              value={notes}
              onChange={setNotes}
              error={tried && needsProof && !permCheck.ok && permCheck.problem === "proof" ? tx("notesProofError") : undefined}
            />
          </>
        ) : null}

        {/* Always in the page, so the problem is read out when it appears */}
        <div role="alert" className={tried && !ready && !lockedReason ? undefined : "-mt-4"}>
          {tried && !ready && !lockedReason ? (
            <Problem>
              {content && !secondOk
                ? tx("problemLink")
                : !sketchfabLinkOk
                  ? tx("problemShortLink")
                  : tagsChecking
                    ? tx("problemChecking")
                    : tx("problemRequired")}
            </Problem>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {lockedReason ? <span className="lc-hint">{lockedReason}</span> : null}
          <Button type="submit" variant="primary" size="lg" disabledReason={lockedReason} icon={<Icon name="externalLink" />}>
            {copy.send}
          </Button>
        </div>
        {kind === "Bug" && shotState !== "none" ? (
          <Card title={tx("screenshot")}>
            {shot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shot.url} alt={tx("screenshotAlt")} className="aspect-video w-full rounded-lc-row object-cover" />
            ) : (
              <div className="lc-skeleton aspect-video w-full rounded-lc-row bg-lc-well" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {pictureCopyable ? (
                <Button size="sm" variant="secondary" icon={<Icon name="copy" />} disabled={!shot} onClick={() => picture("copy")}>
                  {tx("copyPicture")}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" icon={<Icon name="download" />} disabled={!shot} onClick={() => picture("save")}>
                {tx("savePicture")}
              </Button>
            </div>
            <p aria-live="polite" className="lc-hint m-0">
              {pictureNoteText}
            </p>
          </Card>
        ) : null}
      </form>
    </div>
  );
};
