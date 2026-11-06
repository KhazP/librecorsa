"use client";

import React, { useEffect, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Segmented } from "./menu-ui";

/**
 * Feedback goes to GitHub as a pre-filled issue form (.github/ISSUE_TEMPLATE): bug-report.yml, wheel-report.yml,
 * idea.yml and content-request.yml. The query keys below are those forms' field ids. GitHub only pre-fills text
 * fields from the URL, so every value is sent as plain text.
 */
const REPO_URL = "https://github.com/KhazP/librecorsa";

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

const COPY: Record<FeedbackKind, { title: string; intro: string; send: string }> = {
  Bug: {
    title: "Report a bug",
    intro: "Something broken, glitching or behaving wrong? Say what happened; the game adds your circuit, car, device, browser and GPU.",
    send: "Send report",
  },
  Wheel: {
    title: "Report a wheel",
    intro: "Tell us how your wheel works in LibreCorsa: steering, pedals, buttons and force feedback. Every report makes more wheels work.",
    send: "Send report",
  },
  Idea: {
    title: "Share an idea",
    intro: "A feature you miss, something that could work better, or a game that does it well. Ideas shape what gets built next.",
    send: "Send idea",
  },
  Car: {
    title: "Request a car",
    intro: "Missing your favourite car? Tell us what it is and link the 3D model, so it can be checked and built.",
    send: "Send request",
  },
  Track: {
    title: "Request a track",
    intro: "Missing your favourite circuit? Tell us which one and link the 3D model or scan, so it can be checked and built.",
    send: "Send request",
  },
};

const fieldClass =
  "w-full min-w-0 rounded-[14px] border border-[#262B3D] bg-[#08090D] px-3.5 text-[15px] text-[#F5F7FA] placeholder:text-[#8E96AA]/60 focus:border-[#CCFF00] focus:shadow-[0_0_0_4px_rgba(204,255,0,0.12)] focus:outline-none";
const inputClass = `${fieldClass} h-11`;
const areaClass = `${fieldClass} resize-y py-3`;
const badClass = "!border-[#FF2A3C] focus:!shadow-[0_0_0_4px_rgba(255,42,60,0.14)]";

const Field: React.FC<{ label: string; hint?: string; required?: boolean; children: React.ReactNode }> = ({
  label,
  hint,
  required,
  children,
}) => (
  <label className="flex min-w-0 flex-col gap-1.5">
    <span className="lc-lbl text-[10px]">
      {label}
      {required ? <span className="text-[#CCFF00]"> *</span> : null}
    </span>
    {children}
    {hint ? <span className="text-[12px] leading-snug text-[#8E96AA]">{hint}</span> : null}
  </label>
);

/** Native drop-down drawn as a field, with its own chevron */
const Select: React.FC<{ value: string; onChange: (value: string) => void; options: readonly string[] }> = ({
  value,
  onChange,
  options,
}) => (
  <span className="relative block">
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} cursor-pointer appearance-none pr-10`}>
      <option value="">Choose…</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
    <ChevronDown aria-hidden className="pointer-events-none absolute top-3.5 right-3.5 h-4 w-4 text-[#8E96AA]" strokeWidth={2.4} />
  </span>
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

/** The GPU the browser reports (unmasked when allowed) */
function gpuName(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return "no WebGL";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name.replace(/^ANGLE \((.*)\)$/, "$1").slice(0, 120);
  } catch {
    return "unknown GPU";
  }
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
  notes: string;
}

const firstLine = (s: string, max = 70) => {
  const line = s.trim().split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The GitHub "new issue" URL with the matching form filled in */
export function feedbackIssueUrl(f: FeedbackForm, ctx: FeedbackContext | undefined, sys: SystemInfo | null): string {
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
      set("circuit", ctx?.circuit);
      set("car", ctx?.car);
      set("input", ctx?.device);
      set("hardware", f.third);
      set("browser", system);
      set("quality", ctx?.graphics);
      break;
    case "Wheel":
      q.set("title", `[Wheel] ${firstLine(f.main)}`);
      set("wheel", f.main);
      set("firmware", f.second);
      set("system", system);
      set("notes", f.notes);
      break;
    case "Idea":
      q.set("title", `[Idea] ${firstLine(f.main)}`);
      set("idea", f.main);
      set("why", f.second);
      set("area", f.third);
      break;
    default:
      q.set("title", `[${f.kind} request] ${firstLine(f.main, 100)}`);
      q.set("kind", f.kind);
      set("name", f.main);
      set("link", f.second);
      set("creator", f.third);
      set("license", f.license);
      set("permission", f.permission);
      set("notes", f.notes);
  }
  return `${REPO_URL}/issues/new?${q.toString()}`;
}

const isUrl = (s: string) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s.trim());

/**
 * Title-menu panel for feedback: bug and wheel reports, ideas, and car or circuit requests. It collects the
 * details, adds what the game knows (session, browser, GPU) and opens them as a pre-filled GitHub issue.
 */
export const RequestPanel: React.FC<{ context?: FeedbackContext }> = ({ context }) => {
  const [kind, setKind] = useState<FeedbackKind>("Bug");
  const [main, setMain] = useState("");
  const [second, setSecond] = useState("");
  const [third, setThird] = useState("");
  const [license, setLicense] = useState<string>("");
  const [permission, setPermission] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [tried, setTried] = useState(false);

  // Read in the browser after mount (the page is pre-rendered without these)
  useEffect(() => setSys(readSystem()), []);

  const content = kind === "Car" || kind === "Track";
  const mainOk = main.trim().length >= (content ? 2 : 6);
  const secondOk = kind === "Bug" ? second.trim().length >= 3 : content ? isUrl(second) : true;
  const ready = mainOk && secondOk;
  const openLicense = license === LICENSES[0] || license === LICENSES[1];
  const ripped = content && !openLicense && (permission === "Not asked yet" || permission === "Don't know");
  const copy = COPY[kind];

  const pickKind = (k: FeedbackKind) => {
    // The shared fields mean different things per kind: start them empty
    if (k !== kind) {
      setMain("");
      setSecond("");
      setThird("");
      setNotes("");
      setTried(false);
    }
    setKind(k);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!ready) return;
    const url = feedbackIssueUrl({ kind, main, second, third, license, permission, notes }, context, sys);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const added: [string, string][] =
    kind === "Bug"
      ? [
          ["Circuit", context?.circuit ?? "—"],
          ["Car", context?.car ?? "—"],
          ["Input", context?.device ?? "—"],
          ["Graphics", context?.graphics ?? "—"],
          ["Browser", sys?.browser ?? "…"],
          ["Screen", sys?.screen ?? "…"],
          ["GPU", sys?.gpu ?? "…"],
        ]
      : kind === "Wheel"
        ? [
            ["Browser", sys?.browser ?? "…"],
            ["Screen", sys?.screen ?? "…"],
            ["GPU", sys?.gpu ?? "…"],
          ]
        : [];

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-7 text-[#F5F7FA]">
      <div className="flex min-w-0 flex-col gap-[18px]">
        <div className="flex flex-col gap-2">
          <span className="lc-lbl text-[#00E5FF]">Feedback & requests</span>
          <h2 className="lc-disp m-0 text-[34px] sm:text-[44px]">{copy.title}</h2>
        </div>
        <p className="m-0 text-[17px] leading-snug font-semibold sm:text-[18px]">{copy.intro}</p>
        {content ? (
          <p className="m-0 text-[14px] leading-relaxed text-[#8E96AA]">
            LibreCorsa can only ship models it is allowed to share: ones under an open or non-commercial license (CC BY, CC BY-SA, CC0,
            CC BY-NC, CC BY-NC-SA) or with <span className="text-[#F5F7FA]">written permission from the creator</span>. Mods taken from
            other games can only be used if their original creator agrees.
          </p>
        ) : null}
        {added.length ? (
          <div className="flex flex-col gap-2 rounded-[18px] border border-[#262B3D] bg-[#08090D]/60 px-4 py-3.5">
            <span className="lc-lbl text-[10px]">Added to your report</span>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
              {added.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="text-[#8E96AA]">{k}</dt>
                  <dd className="m-0 truncate text-[#C5CBD8]" title={v}>
                    {v}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        ) : null}
        <div className="mt-auto flex items-start gap-3 rounded-[18px] border border-[#262B3D] bg-[#08090D]/60 px-4 py-3.5">
          <ExternalLink aria-hidden className="mt-0.5 h-[18px] w-[18px] shrink-0 text-[#00E5FF]" strokeWidth={2} />
          <span className="text-[13px] leading-normal text-[#C5CBD8]">
            Opens a pre-filled issue on GitHub (free account needed); check it and press Create. Screenshots and videos can be
            dragged in there.
          </span>
        </div>
      </div>

      <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-3.5">
        <Segmented
          label="What is it about?"
          className="[&_button]:min-w-0"
          options={KINDS.map((k) => ({ id: k, label: k }))}
          value={kind}
          onChange={pickKind}
        />

        {kind === "Bug" ? (
          <>
            <Field label="What happened?" required hint="And what you expected instead.">
              <textarea
                value={main}
                onChange={(e) => setMain(e.target.value)}
                rows={3}
                maxLength={1500}
                placeholder="The wheels of the GT3 sink into the road at Monza…"
                aria-invalid={tried && !mainOk}
                className={`${areaClass} ${tried && !mainOk ? badClass : ""}`}
              />
            </Field>
            <Field label="How to make it happen" required hint="The steps, even rough ones, e.g. “Load Monza in the BMW, drive out of the pits”.">
              <textarea
                value={second}
                onChange={(e) => setSecond(e.target.value)}
                rows={2}
                maxLength={1500}
                aria-invalid={tried && !secondOk}
                className={`${areaClass} ${tried && !secondOk ? badClass : ""}`}
              />
            </Field>
            {context && context.device !== "Keyboard" ? (
              <Field label="Controller or wheel model" hint="For example Xbox Series pad, Logitech G29, Moza R9.">
                <input value={third} onChange={(e) => setThird(e.target.value)} maxLength={80} className={inputClass} />
              </Field>
            ) : null}
          </>
        ) : null}

        {kind === "Wheel" ? (
          <>
            <Field label="Wheel base and rim" required hint="For example Moza R9 with ES rim, Logitech G923, Fanatec CSL DD.">
              <input
                value={main}
                onChange={(e) => setMain(e.target.value)}
                maxLength={120}
                aria-invalid={tried && !mainOk}
                className={`${inputClass} ${tried && !mainOk ? badClass : ""}`}
              />
            </Field>
            <Field label="Firmware or driver version" hint="Optional. In the maker's app (Pit House, G Hub, Fanatec app…).">
              <input value={second} onChange={(e) => setSecond(e.target.value)} maxLength={80} className={inputClass} />
            </Field>
            <Field label="What worked, and what didn't?" hint="GitHub then asks which force-feedback path you used, with one click.">
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={1500} className={areaClass} />
            </Field>
          </>
        ) : null}

        {kind === "Idea" ? (
          <>
            <Field label="Your idea" required>
              <textarea
                value={main}
                onChange={(e) => setMain(e.target.value)}
                rows={3}
                maxLength={1500}
                placeholder="A replay camera that follows the leader…"
                aria-invalid={tried && !mainOk}
                className={`${areaClass} ${tried && !mainOk ? badClass : ""}`}
              />
            </Field>
            <Field label="Why it matters" hint="What it would fix or make more fun. Games that do it well help too.">
              <textarea value={second} onChange={(e) => setSecond(e.target.value)} rows={2} maxLength={1500} className={areaClass} />
            </Field>
            <Field label="Area" hint="Menus, HUD, physics, AI, multiplayer, wheel, sound, graphics…">
              <input value={third} onChange={(e) => setThird(e.target.value)} maxLength={60} className={inputClass} />
            </Field>
          </>
        ) : null}

        {content ? (
          <>
            <Field
              label={kind === "Track" ? "Which track?" : "Which car?"}
              required
              hint={kind === "Track" ? "Name and layout or year, e.g. Spa-Francorchamps, 2022 layout" : "Make, model and year, e.g. Porsche 911 GT3 R 2023"}
            >
              <input
                value={main}
                onChange={(e) => setMain(e.target.value)}
                maxLength={120}
                aria-invalid={tried && !mainOk}
                className={`${inputClass} ${tried && !mainOk ? badClass : ""}`}
              />
            </Field>
            <Field
              label="Model link"
              required
              hint="The page of the 3D model: Sketchfab, a mod site or a scan. Requests without a model can't be built."
            >
              <input
                type="url"
                value={second}
                onChange={(e) => setSecond(e.target.value)}
                placeholder="https://"
                aria-invalid={(tried || second.trim() !== "") && !secondOk}
                className={`${inputClass} ${(tried || second.trim() !== "") && !secondOk ? badClass : ""}`}
              />
            </Field>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <Field label="Creator / modder">
                <input value={third} onChange={(e) => setThird(e.target.value)} maxLength={80} className={inputClass} />
              </Field>
              <Field label="License">
                <Select value={license} onChange={setLicense} options={LICENSES} />
              </Field>
            </div>
            <Field label="Do we have permission to use it?">
              <Select value={permission} onChange={setPermission} options={PERMISSIONS} />
            </Field>
            {ripped ? (
              <p className="m-0 rounded-[14px] border border-[#FFB300]/35 bg-[#FFB300]/[0.08] px-3.5 py-3 text-[13px] leading-normal text-[#FFB300]">
                Feel free to send it anyway. Asking the creator first (and linking their answer) makes it much more likely to be added.
              </p>
            ) : null}
            <Field label="Anything else?">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={1500}
                placeholder="Why it would be fun, a link to the creator's permission, reference photos…"
                className={areaClass}
              />
            </Field>
          </>
        ) : null}

        {tried && !ready ? (
          <p role="alert" className="m-0 text-[13px] text-[#FF2A3C]">
            {content && !secondOk ? "Add a link to the 3D model (starting with https://)." : "Fill in the fields marked *."}
          </p>
        ) : null}
        <button
          type="submit"
          className="inline-flex h-[52px] cursor-pointer items-center gap-2.5 self-end rounded-full border-0 bg-[#CCFF00] px-6 text-[#08090D] shadow-[0_0_0_5px_rgba(204,255,0,0.12)] transition-colors hover:bg-[#d9ff33]"
        >
          <span className="lc-disp text-[18px]">{copy.send}</span>
          <ExternalLink aria-hidden className="h-4 w-4" strokeWidth={2.4} />
        </button>
      </form>
    </div>
  );
};
