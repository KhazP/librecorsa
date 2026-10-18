"use client";

import React, { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Card, SectionLabel } from "./menu-ui";

/** Requests become GitHub issues from the form in .github/ISSUE_TEMPLATE/content-request.yml */
const REPO_URL = "https://github.com/KhazP/rwanda-f1-2026-sim";
const TEMPLATE = "content-request.yml";

// Dropdown values must match the issue form's options exactly to pre-fill
const KINDS = ["Track", "Car"] as const;
const LICENSES = ["CC BY / CC BY-SA", "CC0 / public domain", "CC BY-NC / CC BY-NC-SA", "Other license", "Don't know"] as const;
const PERMISSIONS = [
  "The license allows it",
  "The creator gave written permission",
  "Not asked yet",
  "Don't know",
] as const;

type Kind = (typeof KINDS)[number];

const inputClass =
  "w-full rounded border border-[#262B3D] bg-[#08090D] px-2.5 py-1.5 font-f1-mono text-[12px] text-[#F5F7FA] placeholder:text-[#8E96AA]/50 focus:border-[#CCFF00] focus:outline-none";

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="flex flex-col gap-1">
    <span className="font-f1-mono text-[10px] font-bold tracking-[0.14em] text-[#8E96AA] uppercase">{label}</span>
    {children}
    {hint ? <span className="font-f1-mono text-[10px] leading-snug text-[#8E96AA]/80">{hint}</span> : null}
  </label>
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
    <Card className="max-w-xl">
      <SectionLabel>Request a car or track</SectionLabel>
      <div className="flex flex-col gap-2 font-f1-mono text-[12px] leading-relaxed text-[#8E96AA]">
        <p className="text-[#F5F7FA]">
          Missing your favourite circuit or car? Tell us what it is and where the 3D model comes from.
        </p>
        <p>
          LibreCorsa can only ship models it is allowed to share: ones under an open license (CC BY, CC BY-SA, CC0) or
          with <span className="text-[#F5F7FA]">written permission from the creator</span>. Mods taken from other games
          (Assetto Corsa, ACC, iRacing, F1 games…) can only be used if their original creator agrees.
        </p>
      </div>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <div className="flex gap-1.5" role="radiogroup" aria-label="Car or track">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={`cursor-pointer rounded border px-4 py-1.5 font-f1-italic text-sm uppercase transition-colors ${
                kind === k
                  ? "border-[#CCFF00] bg-[#CCFF00]/15 text-[#CCFF00]"
                  : "border-[#262B3D] bg-[#08090D] text-[#8E96AA] hover:border-[#8E96AA]/40"
              }`}
            >
              {k}
            </button>
          ))}
        </div>

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
            className={`${inputClass} ${linkOk ? "" : "!border-[#FF2A3C]"}`}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Creator / modder">
            <input value={creator} onChange={(e) => setCreator(e.target.value)} maxLength={80} className={inputClass} />
          </Field>
          <Field label="License">
            <select value={license} onChange={(e) => setLicense(e.target.value)} className={inputClass}>
              <option value="">Choose…</option>
              {LICENSES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Do we have permission to use it?">
          <select value={permission} onChange={(e) => setPermission(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {PERMISSIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        {ripped ? (
          <p className="-mt-1 rounded border border-[#FFD400]/30 bg-[#FFD400]/5 px-2.5 py-1.5 font-f1-mono text-[11px] leading-snug text-[#FFD400]">
            Feel free to send it anyway. Asking the creator first (and linking their answer) makes it much more likely
            to be added.
          </p>
        ) : null}

        <Field label="Anything else?">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={1500}
            placeholder="Why it would be fun, a link to the creator's permission, reference photos…"
            className={`${inputClass} resize-y`}
          />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D] pt-3">
          <span className="max-w-xs font-f1-mono text-[10px] leading-snug text-[#8E96AA]">
            Opens a pre-filled request on GitHub (free account needed). Accepted requests are added in a pull request.
          </span>
          <button
            type="submit"
            disabled={!ready}
            className="hud-slant inline-flex cursor-pointer items-center gap-2 bg-[#CCFF00] px-5 py-2 font-f1-italic text-sm uppercase tracking-wider text-[#08090D] transition-colors hover:bg-[#E2FF4D] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send request <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </Card>
  );
};
