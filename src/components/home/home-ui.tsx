"use client";

import React from "react";
import type { LapOutline } from "@/lib/home/lap-outline";
import { GRADE_BADGES, GRADE_NOTES, type HomeGrade } from "./home-data";

const PAD = 70;

/** A circuit's outline, still: for cards, where a lapping dot on every one would be noise */
export const OutlineThumb: React.FC<{ outline: LapOutline | null; className?: string }> = ({ outline: o, className }) =>
  o ? (
    <svg viewBox={`${-PAD} ${-PAD} ${o.w + PAD * 2} ${o.h + PAD * 2}`} preserveAspectRatio="xMidYMid meet" className={className} aria-hidden>
      <path d={o.d} fill="none" stroke="currentColor" strokeOpacity={0.16} strokeWidth={64} strokeLinejoin="round" />
      <path d={o.d} fill="none" stroke="currentColor" strokeWidth={20} strokeLinejoin="round" />
    </svg>
  ) : (
    <span aria-hidden className={className} />
  );

/** A car's picture. A copy of the game without that car's files has none: the space stays empty, with no broken-image mark */
export const CarThumb: React.FC<{ src: string | null; className?: string }> = ({ src, className }) =>
  src === null ? null : (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={className}
      onError={(e) => {
        e.currentTarget.style.visibility = "hidden";
      }}
    />
  );

/** A key prompt, as the game's menus draw it (docs/DESIGN.md §6): a 22 px round cap, void with a keyline */
export const KeyCap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="font-f1-mono inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full border border-[#3A4157] bg-[#08090D] px-[7px] text-[10px] leading-none font-extrabold text-[#F5F7FA]">
    {children}
  </span>
);

/** The prompt bar's entry: caps, then what they do */
export const Prompt: React.FC<{ keys: readonly string[]; children: React.ReactNode }> = ({ keys, children }) => (
  <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#C5CBD8]">
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <KeyCap key={k}>{k}</KeyCap>
      ))}
    </span>
    {children}
  </span>
);

/** The prompt bar's entry for a controller: the pad's own buttons (PadGlyph), then what they do */
export const PadPrompt: React.FC<{ glyphs: readonly React.ReactNode[]; children: React.ReactNode }> = ({ glyphs, children }) => (
  <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#C5CBD8]">
    <span className="inline-flex items-center gap-1">{glyphs}</span>
    {children}
  </span>
);

/**
 * Sim grade or 3D model, drawn like the game's own quality chips (menu-ui `Chip`, soft): tinted, with a dot. It sits on
 * pictures, so its tint is laid over void rather than left see-through.
 */
export const GradeBadge: React.FC<{ grade: HomeGrade; title?: string; className?: string }> = ({ grade, title, className = "" }) => {
  const { label, color } = GRADE_BADGES[grade];
  return (
    <span
      title={title}
      className={`font-f1-mono inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[10px] font-extrabold tracking-[0.06em] whitespace-nowrap uppercase ${className}`}
      style={{ background: `linear-gradient(${color}26, ${color}26), #08090D`, color }}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
};

/** What the two badges mean, above a wall of cards */
export const GradeLegend: React.FC<{ of: keyof typeof GRADE_NOTES }> = ({ of }) => (
  <dl className="m-0 mb-4 flex flex-wrap gap-x-7 gap-y-2.5">
    {(["sim", "model"] as const).map((grade) => (
      <div key={grade} className="flex min-w-0 items-start gap-2.5">
        {/* Stacked on a phone: the same width for both, so the two notes start in line */}
        <dt className="shrink-0 max-sm:min-w-[88px]">
          <GradeBadge grade={grade} />
        </dt>
        <dd className="m-0 pt-[3px] text-[13px] leading-snug text-[#C5CBD8]">{GRADE_NOTES[of][grade]}</dd>
      </div>
    ))}
  </dl>
);
