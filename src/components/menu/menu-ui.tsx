"use client";

import React from "react";
import type { LucideIcon } from "lucide-react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { useInputMode, type PadFamily } from "./input-mode";
import { focusOnHover } from "./useFocusNav";

/** Shared building blocks of the LibreCorsa loading screen, title menu and setup wizard */

export const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = "",
}) => (
  <div
    className={`mb-2.5 flex items-center gap-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA] uppercase ${className}`}
  >
    <span className="h-2.5 w-1 rounded-full bg-[#CCFF00]" />
    <span>{children}</span>
  </div>
);

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = "",
}) => (
  <div
    className={`f1-panel f1-corner-tr rounded-lg border border-[#262B3D] bg-[#11131A]/95 p-4 text-[#F5F7FA] ${className}`}
  >
    {children}
  </div>
);

export const KeyCap: React.FC<{ children: React.ReactNode; dim?: boolean }> = ({ children, dim }) => (
  <span
    className={`inline-flex min-w-[1.6rem] items-center justify-center rounded px-1.5 py-0.5 font-f1-mono text-[11px] font-extrabold ${
      dim
        ? "border border-[#262B3D] bg-[#08090D] text-[#8E96AA]"
        : "bg-[#CCFF00] text-[#08090D]"
    }`}
  >
    {children}
  </span>
);

/**
 * One entry of a menu rail. The highlight follows the focus (a controller, the arrow keys or the
 * mouse, which focuses what it hovers); an open panel keeps a cyan edge on its entry.
 */
export const RailItem: React.FC<{
  label: string;
  detail?: string;
  icon?: LucideIcon;
  /** Its panel is showing */
  open?: boolean;
  /** The screen's main action: taller, and where the focus starts */
  primary?: boolean;
  /** Small tag after the label (e.g. "2 online") */
  badge?: string;
  onClick: () => void;
  /** Lets the screen focus this entry (data-rail-id) */
  navId?: string;
}> = ({ label, detail, icon: Icon, open, primary, badge, onClick, navId }) => (
  <button
    type="button"
    data-rail-id={navId}
    onPointerEnter={focusOnHover}
    onClick={onClick}
    aria-expanded={open}
    data-nav-default={primary ? "" : undefined}
    className={`group relative flex w-full cursor-pointer items-center gap-3 rounded-md border px-3.5 text-left outline-none transition-[background-color,border-color,box-shadow,transform] duration-150 focus:translate-x-1 focus:border-[#CCFF00] focus:bg-[#CCFF00] focus:text-[#08090D] focus:shadow-[0_0_24px_rgba(204,255,0,0.25)] ${
      primary ? "min-h-[64px] py-3" : "min-h-[52px] py-2"
    } ${
      open ? "border-[#00E5FF]/60 bg-[#00E5FF]/10 text-[#F5F7FA]" : "border-[#262B3D] bg-[#11131A]/90 text-[#F5F7FA]"
    }`}
  >
    <span
      aria-hidden
      className={`absolute inset-y-2 left-0 w-1 rounded-r ${open ? "bg-[#00E5FF]" : "bg-transparent"} group-focus:bg-[#08090D]`}
    />
    {Icon ? (
      <Icon
        aria-hidden
        className={`shrink-0 ${primary ? "h-6 w-6" : "h-5 w-5"} ${open ? "text-[#00E5FF]" : "text-[#8E96AA]"} group-focus:text-[#08090D]`}
        strokeWidth={2.25}
      />
    ) : null}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className={`flex items-center gap-2 font-f1-italic tracking-wide uppercase ${primary ? "text-xl" : "text-base"}`}>
        {label}
        {badge ? (
          <span className="rounded-sm bg-[#00E5FF] px-1.5 py-px font-f1-mono text-[9px] font-black text-[#08090D] not-italic group-focus:bg-[#08090D] group-focus:text-[#CCFF00]">
            {badge}
          </span>
        ) : null}
      </span>
      {detail ? (
        <span className="truncate font-f1-mono text-[11px] text-[#8E96AA] group-focus:font-bold group-focus:text-[#08090D]/80">
          {detail}
        </span>
      ) : null}
    </span>
    <span aria-hidden className="font-f1-mono text-base font-black opacity-0 group-focus:opacity-100">
      ›
    </span>
  </button>
);

/** Horizontal tabs switched with LB / RB (or Q / E), by moving the focus onto one, or by clicking */
export function TabStrip<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { id: T; label: string; icon?: LucideIcon }[];
  value: T;
  onChange: (id: T) => void;
}) {
  const { mode, family } = useInputMode();
  return (
    <div className="flex items-center gap-2" data-nav-zone="tabs">
      <span className="hidden sm:inline-flex">
        {mode === "pad" ? <PadGlyph button="lb" family={family} /> : <KeyCap dim>Q</KeyCap>}
      </span>
      <div
        role="tablist"
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-lg border border-[#262B3D] bg-[#08090D]/80 p-1 [scrollbar-width:none]"
      >
        {tabs.map((t) => {
          const active = t.id === value;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.id)}
              onFocus={() => {
                if (!active) onChange(t.id);
              }}
              className={`flex min-h-[40px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 font-f1-italic text-[13px] tracking-wide uppercase outline-none transition-colors ${
                active
                  ? "bg-[#CCFF00] text-[#08090D] shadow-[0_0_14px_rgba(204,255,0,0.25)]"
                  : "text-[#8E96AA] hover:bg-white/5 hover:text-[#F5F7FA]"
              }`}
            >
              {Icon ? <Icon aria-hidden className="h-4 w-4" strokeWidth={2.4} /> : null}
              {t.label}
            </button>
          );
        })}
      </div>
      <span className="hidden sm:inline-flex">
        {mode === "pad" ? <PadGlyph button="rb" family={family} /> : <KeyCap dim>E</KeyCap>}
      </span>
    </div>
  );
}

export type PadButtonName = "a" | "b" | "x" | "y" | "lb" | "rb" | "menu" | "view" | "dpad";

const XBOX_FACE: Record<"a" | "b" | "x" | "y", { label: string; color: string }> = {
  a: { label: "A", color: "#5DC21E" },
  b: { label: "B", color: "#E5413A" },
  x: { label: "X", color: "#2F8BE5" },
  y: { label: "Y", color: "#F4C21B" },
};
const PS_FACE: Record<"a" | "b" | "x" | "y", { label: string; color: string }> = {
  a: { label: "✕", color: "#7EA6E6" },
  b: { label: "○", color: "#EE6A6A" },
  x: { label: "□", color: "#D78DD6" },
  y: { label: "△", color: "#45C9A6" },
};

/** A controller button as printed on the pad (Xbox or PlayStation layout) */
export const PadGlyph: React.FC<{ button: PadButtonName; family?: PadFamily }> = ({ button, family = "xbox" }) => {
  if (button === "a" || button === "b" || button === "x" || button === "y") {
    const face = (family === "playstation" ? PS_FACE : XBOX_FACE)[button];
    return (
      <span
        className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 bg-[#08090D] font-f1-mono text-[11px] leading-none font-black"
        style={{ borderColor: face.color, color: face.color }}
      >
        {face.label}
      </span>
    );
  }
  if (button === "dpad") {
    return (
      <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] shrink-0" aria-hidden>
        <path
          d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"
          fill="#08090D"
          stroke="#F5F7FA"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M12 4.5l1.6 2.2h-3.2zM12 19.5l1.6-2.2h-3.2zM4.5 12l2.2-1.6v3.2zM19.5 12l-2.2-1.6v3.2z" fill="#F5F7FA" />
      </svg>
    );
  }
  const ps = family === "playstation";
  const text =
    button === "lb" ? (ps ? "L1" : "LB") : button === "rb" ? (ps ? "R1" : "RB") : button === "menu" ? (ps ? "OPT" : "☰") : ps ? "SHR" : "⧉";
  return (
    <span className="inline-flex h-[22px] min-w-[30px] shrink-0 items-center justify-center rounded-md border-2 border-[#F5F7FA]/80 bg-[#08090D] px-1 font-f1-mono text-[10px] leading-none font-black text-[#F5F7FA]">
      {text}
    </span>
  );
};

export type PromptAction = "move" | "select" | "back" | "tabs" | "start" | "adjust";
export interface Prompt {
  action: PromptAction;
  label: string;
  /** Key shown for the keyboard (defaults per action) */
  key?: string;
}

const KEY_FOR: Record<PromptAction, string> = {
  move: "↑↓←→",
  select: "Enter",
  back: "Esc",
  tabs: "Q / E",
  start: "Enter",
  adjust: "← →",
};

/** Button prompts for the input in use: controller glyphs on a pad, else the keys */
export const PromptBar: React.FC<{ prompts: readonly Prompt[]; className?: string }> = ({ prompts, className = "" }) => {
  const { mode, family } = useInputMode();
  const pad = mode === "pad";
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${className}`}>
      {prompts.map((p) => (
        <span
          key={p.action + p.label}
          className="flex items-center gap-1.5 font-f1-mono text-[11px] font-bold tracking-wide text-[#C5CBD8] uppercase"
        >
          {pad ? (
            p.action === "select" ? (
              <PadGlyph button="a" family={family} />
            ) : p.action === "back" ? (
              <PadGlyph button="b" family={family} />
            ) : p.action === "start" ? (
              <PadGlyph button="menu" family={family} />
            ) : p.action === "tabs" ? (
              <>
                <PadGlyph button="lb" family={family} />
                <PadGlyph button="rb" family={family} />
              </>
            ) : (
              <PadGlyph button="dpad" />
            )
          ) : (
            <KeyCap dim>{p.key ?? KEY_FOR[p.action]}</KeyCap>
          )}
          {p.label}
        </span>
      ))}
    </div>
  );
};

export const PrimaryButton: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "red" | "dark";
  /** Controller / key prompt shown inside the button */
  prompt?: React.ReactNode;
}> = ({ children, onClick, disabled, tone = "red", prompt }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    onPointerEnter={focusOnHover}
    className={`lc-primary-button hud-slant inline-flex min-h-[44px] cursor-pointer items-center gap-2 px-6 py-2.5 font-f1-italic text-sm tracking-wider uppercase transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
      tone === "red"
        ? "bg-[#CCFF00] text-[#08090D] hover:bg-[#d9ff33] shadow-[0_0_18px_rgba(204,255,0,0.25)]"
        : "border border-[#262B3D] bg-[#1B1F2B] text-[#F5F7FA] hover:border-[#8E96AA] hover:bg-[#262B3D]"
    }`}
  >
    {prompt}
    {children}
  </button>
);

/** 0..1 bar */
export const Meter: React.FC<{ label: string; value: number; color?: string; detail?: string }> = ({
  label,
  value,
  color = "#00E676",
  detail,
}) => (
  <div className="flex items-center gap-3">
    <span className="w-20 shrink-0 font-f1-mono text-[11px] font-bold text-[#8E96AA] uppercase">{label}</span>
    <span className="relative h-2.5 flex-1 overflow-hidden rounded border border-[#262B3D] bg-[#08090D]">
      <span
        className="absolute inset-y-0 left-0 rounded"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, background: color }}
      />
    </span>
    <span className="w-14 shrink-0 text-right font-f1-mono text-[11px] font-bold text-[#F5F7FA] tabular-nums">
      {detail ?? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`}
    </span>
  </div>
);

/** −1..1 centred bar (steering) */
export const CenterMeter: React.FC<{ label: string; value: number; detail?: string }> = ({
  label,
  value,
  detail,
}) => {
  const v = Math.max(-1, Math.min(1, value));
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 font-f1-mono text-[11px] font-bold text-[#8E96AA] uppercase">{label}</span>
      <span className="relative h-2.5 flex-1 overflow-hidden rounded border border-[#262B3D] bg-[#08090D]">
        <span className="absolute inset-y-0 left-1/2 w-px bg-white/40" />
        <span
          className="absolute inset-y-0 rounded bg-[#00E5FF]"
          style={v >= 0 ? { left: "50%", width: `${v * 50}%` } : { right: "50%", width: `${-v * 50}%` }}
        />
      </span>
      <span className="w-14 shrink-0 text-right font-f1-mono text-[11px] font-bold text-[#F5F7FA] tabular-nums">
        {detail ?? `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}`}
      </span>
    </div>
  );
};

/** The LibreCorsa title block shared by the loading screen and title menu */
export const GameTitle: React.FC<{ kicker: string; size?: "lg" | "xl" }> = ({ kicker, size = "xl" }) => (
  <div className="flex flex-col items-start gap-3">
    <LibreCorsaLogo variant="full" size={size === "xl" ? "lg" : "md"} />
    <div className="inline-flex items-center gap-2 rounded-md border border-[#262B3D] bg-[#11131A]/85 px-2.5 py-1 font-f1-mono text-[11px] font-bold tracking-[0.18em] text-[#CCFF00] uppercase backdrop-blur">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#CCFF00] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#CCFF00]" />
      </span>
      {kicker}
    </div>
  </div>
);
