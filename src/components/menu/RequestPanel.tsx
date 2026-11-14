"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Button, Card, Segmented, Select, SettingRow, TextField, Toggle } from "@/components/ui";
import { Icon } from "@/components/ui/icons";

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
    intro: "Tell me how your wheel works in LibreCorsa: steering, pedals, buttons and force feedback. Every report makes more wheels work.",
    send: "Send report",
  },
  Idea: {
    title: "Share an idea",
    intro: "A feature you miss, something that could work better, or a game that does it well. Ideas shape what gets built next.",
    send: "Send idea",
  },
  Car: {
    title: "Request a car",
    intro: "Missing your favourite car? Tell me what it is and link the 3D model, so it can be checked and built.",
    send: "Send request",
  },
  Track: {
    title: "Request a track",
    intro: "Missing your favourite circuit? Tell me which one and link the 3D model or scan, so it can be checked and built.",
    send: "Send request",
  },
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
const FieldSelect: React.FC<{ label: string; value: string; onChange: (value: string) => void; options: readonly string[] }> = ({
  label,
  value,
  onChange,
  options,
}) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <span className="lc-field-label" aria-hidden>
      {label}
    </span>
    <Select aria-label={label} className="w-full" placeholder="Choose" value={value} onChange={onChange} options={options.map((o) => ({ id: o, label: o }))} />
  </div>
);

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
      if (isSketchfab(f.second) && f.askedModders) set("modders", "Yes, they said no");
      if (isOvertake(f.second) && f.modderSaidYes) set("modders", "Yes, the modder said yes");
      set("notes", f.notes);
  }
  return `${REPO_URL}/issues/new?${q.toString()}`;
}

const isUrl = (s: string) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s.trim());

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

  // Read in the browser after mount (the page is pre-rendered without these)
  useEffect(() => setSys(readSystem()), []);

  const content = kind === "Car" || kind === "Track";
  const mainOk = main.trim().length >= (content ? 2 : 6);
  const secondOk = kind === "Bug" ? second.trim().length >= 3 : content ? isUrl(second) : true;
  // A model can only be added under a known license that allows it, or with its creator's written permission
  const openLicense = license === LICENSES[0] || license === LICENSES[1] || license === LICENSES[2];
  const writtenPermission = permission === PERMISSIONS[1];
  const permitted =
    !content || writtenPermission || (license !== "Don't know" && (openLicense || permission === PERMISSIONS[0]));
  const ripped = content && !permitted && (permission !== "" || license === "Don't know");
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
  const ready = mainOk && secondOk && sketchfabLinkOk && !tagsChecking && !rippedModel && permitted && moddersOk;
  const copy = COPY[kind];

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
    const url = feedbackIssueUrl({ kind, main, second, third, license, permission, askedModders, modderSaidYes, notes }, context, sys);
    window.open(url, "_blank", "noopener,noreferrer");
    setSent(true);
  };

  const newReport = () => {
    clearFields();
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

  const added: [string, string][] =
    kind === "Bug"
      ? [
          ["Circuit", context?.circuit ?? "Not known"],
          ["Car", context?.car ?? "Not known"],
          ["Input", context?.device ?? "Not known"],
          ["Graphics", context?.graphics ?? "Not known"],
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

  const lockedReason = rippedModel
    ? "Models ripped from other games can't be added."
    : !permitted
      ? "It needs an open license or the creator's written permission first."
      : !moddersOk
        ? overtake
          ? "Ask the modder for permission first."
          : "Sketchfab is the last resort. Ask the sim modders first."
        : undefined;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-7 text-lc-chalk">
      <div className="flex min-w-0 flex-col gap-4">
        <h2 className="lc-h2">{copy.title}</h2>
        <p className="m-0 text-[16px] leading-snug text-lc-fog">{copy.intro}</p>
        {content ? (
          <p className="lc-body m-0">
            LibreCorsa can only ship models it is allowed to share: ones under an open or non-commercial license (CC BY, CC BY-SA, CC0,
            CC BY-NC, CC BY-NC-SA) or with <span className="text-lc-chalk">written permission from the creator</span>. Mods taken from
            other games can only be used if their original creator agrees.
          </p>
        ) : null}
        {added.length ? (
          <Card title="Added to your report">
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
              {added.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="text-lc-slate">{k}</dt>
                  <dd className="m-0 truncate text-lc-fog" title={v}>
                    {v}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </Card>
        ) : null}
        <p className="lc-hint m-0 mt-auto flex items-start gap-2">
          <Icon name="externalLink" className="mt-px text-lc-info" />
          Opens a pre-filled issue on GitHub (free account needed); check it and press Create. Screenshots and videos can be dragged
          in there.
        </p>
      </div>

      {sent ? (
        <div className="self-start">
          <Card title="Opened on GitHub" bodyClassName="gap-3.5">
            <p id={sentNoteId} className="lc-body m-0">
              Check the new tab and press Create there to send it. Thanks.
            </p>
            {/* The focus lands here once sent: the button reads the note with it */}
            <Button ref={newReportRef} variant="secondary" className="self-start" aria-describedby={sentNoteId} onClick={newReport}>
              Write another
            </Button>
          </Card>
        </div>
      ) : null}
      {/* Hidden, not unmounted, once sent: "Write another" clears it */}
      <form ref={formRef} onSubmit={submit} noValidate className={`${sent ? "hidden" : "flex"} min-w-0 flex-col gap-4`}>
        <Segmented aria-label="What is it about?" fill options={KINDS.map((k) => ({ id: k, label: k }))} value={kind} onChange={pickKind} />

        {kind === "Bug" ? (
          <>
            <TextField
              label="What happened? *"
              required
              multiline
              rows={3}
              maxLength={1500}
              hint="And what you expected instead."
              placeholder="The car's wheels sink into the road in the last corner…"
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? "Say what happened, in a few words at least." : undefined}
            />
            <TextField
              label="How to make it happen *"
              required
              multiline
              rows={2}
              maxLength={1500}
              hint="The steps, even rough ones, e.g. “Load the circuit in the GT3, drive out of the pits”."
              value={second}
              onChange={setSecond}
              error={tried && !secondOk ? "Add the steps, even rough ones." : undefined}
            />
            {context && context.device !== "Keyboard" ? (
              <TextField
                label="Controller or wheel model"
                hint="The make and model, as written on the box."
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
              label="Wheel base and rim *"
              required
              maxLength={120}
              autoComplete="off"
              hint="The make and model of the base and of the rim."
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? "Name the wheel base and rim." : undefined}
            />
            <TextField
              label="Firmware or driver version"
              maxLength={80}
              autoComplete="off"
              hint="Optional. The wheel maker's own app shows it."
              value={second}
              onChange={setSecond}
            />
            <TextField
              label="What worked, and what didn't?"
              multiline
              rows={3}
              maxLength={1500}
              hint="GitHub then asks which force-feedback path you used, with one click."
              value={notes}
              onChange={setNotes}
            />
          </>
        ) : null}

        {kind === "Idea" ? (
          <>
            <TextField
              label="Your idea *"
              required
              multiline
              rows={3}
              maxLength={1500}
              placeholder="A replay camera that follows the leader…"
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? "Describe the idea, in a few words at least." : undefined}
            />
            <TextField
              label="Why it matters"
              multiline
              rows={2}
              maxLength={1500}
              hint="What it would fix or make more fun. Games that do it well help too."
              value={second}
              onChange={setSecond}
            />
            <TextField
              label="Area"
              maxLength={60}
              autoComplete="off"
              hint="Menus, HUD, physics, AI, multiplayer, wheel, sound, graphics…"
              value={third}
              onChange={setThird}
            />
          </>
        ) : null}

        {content ? (
          <>
            <TextField
              label={kind === "Track" ? "Which track? *" : "Which car? *"}
              required
              maxLength={120}
              autoComplete="off"
              hint={kind === "Track" ? "The name, and the layout or year." : "Make, model and year."}
              value={main}
              onChange={setMain}
              error={tried && !mainOk ? (kind === "Track" ? "Name the track." : "Name the car.") : undefined}
            />
            <TextField
              label="Model link *"
              required
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://"
              hint={hintWith(
                "The page of the 3D model: Sketchfab, a mod site or a scan. Requests without a model can't be built.",
                sketchfab || overtake ? undefined : "A mod made for a racing sim is far better than Sketchfab: ask its modders first.",
              )}
              value={second}
              onChange={setSecond}
              error={
                (tried || second.trim() !== "") && !secondOk
                  ? "Add a link to the 3D model, starting with https://"
                  : sketchfab && !sketchfabId
                    ? "Paste the model's full page link (sketchfab.com/3d-models/…), not a short link, so its tags can be checked."
                    : undefined
              }
            />
            {/* The tag check runs while the player waits: what it finds is read out */}
            <div
              aria-live="polite"
              // Empty, it takes back the form's gap
              className={rippedModel || tagsChecking || (sketchfab && tagCheck?.state === "unknown") ? undefined : "-mt-4"}
            >
              {rippedModel ? (
                <Problem>
                  This model is tagged {rippedModel.map((t) => `“${t}”`).join(", ")} on Sketchfab: it was ripped from another game,
                  so it can&apos;t be added. Find the mod&apos;s author and ask them for permission instead.
                </Problem>
              ) : tagsChecking ? (
                <p className="lc-hint m-0">Checking the model&apos;s tags on Sketchfab…</p>
              ) : sketchfab && tagCheck?.state === "unknown" ? (
                <p className="lc-hint m-0">Sketchfab didn&apos;t answer, so the model&apos;s tags will be checked by hand.</p>
              ) : null}
            </div>
            {overtake ? (
              <SettingRow
                label={`I asked the modder who made this ${kind === "Track" ? "track" : "car"} for permission to use it in LibreCorsa, and they said yes. *`}
                hint="Mods can only be added with their author's permission. Link their answer under Anything else."
              >
                <Toggle checked={modderSaidYes} onChange={setModderSaidYes} onLabel="Yes" offLabel="No" />
              </SettingRow>
            ) : null}
            {sketchfab && !rippedModel ? (
              <SettingRow
                label={`I asked the modders who made this ${kind === "Track" ? "track" : "car"} for other sim racing games for permission, and they said no. *`}
                hint={
                  kind === "Track"
                    ? "Sketchfab tracks are made to look at, not to race on: no grip for the tarmac, no real kerbs, no racing line. A sim mod is far better, so ask its modders first."
                    : "Sketchfab cars are made to look at, not to drive: no physics comes with them. A sim mod is far better, so ask its modders first."
                }
              >
                <Toggle checked={askedModders} onChange={setAskedModders} onLabel="Yes" offLabel="No" />
              </SettingRow>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField label="Creator / modder" maxLength={80} autoComplete="off" value={third} onChange={setThird} />
              <FieldSelect label="License" value={license} onChange={setLicense} options={LICENSES} />
            </div>
            <FieldSelect label="Permission to use it *" value={permission} onChange={setPermission} options={PERMISSIONS} />
            {ripped ? (
              <p className="m-0 flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-caution">
                <Icon name="warning" size="xs" className="mt-0.5" />
                {license === "Don't know" && !writtenPermission
                  ? "Find out the model's license, or ask the creator for written permission: without either it can't be added."
                  : "Ask the creator first, and link their answer under Anything else. Without an open license or their permission it can't be added."}
              </p>
            ) : null}
            <TextField
              label="Anything else?"
              multiline
              rows={2}
              maxLength={1500}
              placeholder="Why it would be fun, a link to the creator's permission, reference photos…"
              value={notes}
              onChange={setNotes}
            />
          </>
        ) : null}

        {/* Always in the page, so the problem is read out when it appears */}
        <div role="alert" className={tried && !ready && !lockedReason ? undefined : "-mt-4"}>
          {tried && !ready && !lockedReason ? (
            <Problem>
              {content && !secondOk
                ? "Add a link to the 3D model (starting with https://)."
                : !sketchfabLinkOk
                  ? "Paste the model's full Sketchfab page link."
                  : tagsChecking
                    ? "Still checking the model's tags on Sketchfab."
                    : "Fill in the fields marked *."}
            </Problem>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {lockedReason ? <span className="lc-hint">{lockedReason}</span> : null}
          <Button type="submit" variant="primary" size="lg" disabledReason={lockedReason} icon={<Icon name="externalLink" />}>
            {copy.send}
          </Button>
        </div>
      </form>
    </div>
  );
};
