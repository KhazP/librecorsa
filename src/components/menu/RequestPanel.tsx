"use client";

import React, { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Segmented } from "./menu-ui";

/** Requests become GitHub issues from the form in .github/ISSUE_TEMPLATE/content-request.yml */
const REPO_URL = "https://github.com/KhazP/librecorsa";
const TEMPLATE = "content-request.yml";

// Sent as plain text: the issue form takes these in text fields, the only kind GitHub pre-fills
const KINDS = ["Track", "Car"] as const;
const LICENSES = ["CC BY / CC BY-SA", "CC0 / public domain", "CC BY-NC / CC BY-NC-SA", "Other license", "Don't know"] as const;
const PERMISSIONS = [
  "The license allows it",
  "The creator gave written permission",
  "Not asked yet",
  "Don't know",
] as const;

type Kind = (typeof KINDS)[number];

const fieldClass =
  "w-full min-w-0 rounded-[14px] border border-[#262B3D] bg-[#08090D] px-3.5 text-[15px] text-[#F5F7FA] placeholder:text-[#8E96AA]/60 focus:border-[#CCFF00] focus:shadow-[0_0_0_4px_rgba(204,255,0,0.12)] focus:outline-none";
const inputClass = `${fieldClass} h-11`;

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="flex min-w-0 flex-col gap-1.5">
    <span className="lc-lbl text-[10px]">{label}</span>
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
    <ChevronDown
      aria-hidden
      className="pointer-events-none absolute top-3.5 right-3.5 h-4 w-4 text-[#8E96AA]"
      strokeWidth={2.4}
    />
  </span>
);

/** The GitHub "new issue" URL with the request form filled in */
export function requestIssueUrl(r: {
  kind: Kind;
  name: string;
  link: string;
  creator: string;
  license: string;
  permission: string;
  notes: string;
}): string {
  const q = new URLSearchParams({ template: TEMPLATE, title: `[${r.kind} request] ${r.name.trim()}`, kind: r.kind });
  for (const key of ["name", "link", "creator", "license", "permission", "notes"] as const) {
    const v = r[key].trim();
    if (v) q.set(key, v);
  }
  return `${REPO_URL}/issues/new?${q.toString()}`;
}

/**
 * Title-menu panel for asking for a new car or circuit. It explains what can be shipped (open license or the
 * creator's permission), collects the details and opens them as a pre-filled GitHub issue.
 */
export const RequestPanel: React.FC = () => {
  const [kind, setKind] = useState<Kind>("Track");
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [creator, setCreator] = useState("");
  const [license, setLicense] = useState<string>("");
  const [permission, setPermission] = useState<string>("");
  const [notes, setNotes] = useState("");

  const linkOk = link.trim() === "" || /^https?:\/\/\S+$/i.test(link.trim());
  const ready = name.trim().length > 1 && linkOk;
  // An open license needs no asking; anything else is worth a word with the creator first
  const openLicense = license === LICENSES[0] || license === LICENSES[1];
  const ripped = !openLicense && (permission === "Not asked yet" || permission === "Don't know");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    window.open(requestIssueUrl({ kind, name, link, creator, license, permission, notes }), "_blank", "noopener,noreferrer");
  };

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-7 text-[#F5F7FA]">
      <div className="flex min-w-0 flex-col gap-[18px]">
        <div className="flex flex-col gap-2">
          <span className="lc-lbl text-[#00E5FF]">Suggest new content</span>
          <h2 className="lc-disp m-0 text-[34px] sm:text-[44px]">
            Request a car
            <br />
            or track
          </h2>
        </div>
        <p className="m-0 text-[17px] leading-snug font-semibold sm:text-[18px]">
          Missing your favourite circuit or car? Tell us what it is and where the 3D model comes from.
        </p>
        <p className="m-0 text-[14px] leading-relaxed text-[#8E96AA]">
          LibreCorsa can only ship models it is allowed to share: ones under an open license (CC BY, CC BY-SA, CC0) or with{" "}
          <span className="text-[#F5F7FA]">written permission from the creator</span>. Mods taken from other games can only
          be used if their original creator agrees.
        </p>
        <div className="mt-auto flex items-start gap-3 rounded-[18px] border border-[#262B3D] bg-[#08090D]/60 px-4 py-3.5">
          <ExternalLink aria-hidden className="mt-0.5 h-[18px] w-[18px] shrink-0 text-[#00E5FF]" strokeWidth={2} />
          <span className="text-[13px] leading-normal text-[#C5CBD8]">
            Opens a pre-filled request on GitHub (free account needed). Accepted requests are added in a pull request.
          </span>
        </div>
      </div>

      <form onSubmit={submit} className="flex min-w-0 flex-col gap-3.5">
        <Segmented
          label="Car or track"
          className="self-start [&_button]:min-w-[96px]"
          options={KINDS.map((k) => ({ id: k, label: k }))}
          value={kind}
          onChange={setKind}
        />

        <Field
          label={kind === "Track" ? "Which track?" : "Which car?"}
          hint={kind === "Track" ? "Name and layout or year, e.g. Spa-Francorchamps, 2022 layout" : "Make, model and year, e.g. Porsche 911 GT3 R 2023"}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className={inputClass} />
        </Field>

        <Field label="Model link" hint="Sketchfab page, mod page or similar. Leave empty if you don't have one.">
          <input
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://"
            aria-invalid={!linkOk}
            className={`${inputClass} ${linkOk ? "" : "!border-[#FF2A3C] focus:!shadow-[0_0_0_4px_rgba(255,42,60,0.14)]"}`}
          />
        </Field>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="Creator / modder">
            <input value={creator} onChange={(e) => setCreator(e.target.value)} maxLength={80} className={inputClass} />
          </Field>
          <Field label="License">
            <Select value={license} onChange={setLicense} options={LICENSES} />
          </Field>
        </div>

        <Field label="Do we have permission to use it?">
          <Select value={permission} onChange={setPermission} options={PERMISSIONS} />
        </Field>
        {ripped ? (
          <p className="m-0 rounded-[14px] border border-[#FFD400]/35 bg-[#FFD400]/[0.08] px-3.5 py-3 text-[13px] leading-normal text-[#FFD400]">
            Feel free to send it anyway. Asking the creator first (and linking their answer) makes it much more likely to be
            added.
          </p>
        ) : null}

        <Field label="Anything else?">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={1500}
            placeholder="Why it would be fun, a link to the creator's permission, reference photos…"
            className={`${fieldClass} resize-y py-3`}
          />
        </Field>

        <button
          type="submit"
          disabled={!ready}
          className="inline-flex h-[52px] cursor-pointer items-center gap-2.5 self-end rounded-full border-0 bg-[#CCFF00] px-6 text-[#08090D] shadow-[0_0_0_5px_rgba(204,255,0,0.12)] transition-colors hover:bg-[#d9ff33] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          <span className="lc-disp text-[18px]">Send request</span>
          <ExternalLink aria-hidden className="h-4 w-4" strokeWidth={2.4} />
        </button>
      </form>
    </div>
  );
};
