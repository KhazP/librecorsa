"use client";

import React from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { useInputMode, type PadFamily } from "./input-mode";
import { focusOnHover } from "./useFocusNav";

/** Shared building blocks of the LibreCorsa loading screen, title menu and setup wizard */

export const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = "",
}) => (
  <div className={`mb-3 flex items-center gap-2.5 ${className}`}>
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#CCFF00]" />
    <span className="lc-lbl">{children}</span>
  </div>
);

/** A rounded sheet: the surface every panel sits on */
export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = "",
}) => <div className={`lc-glass rounded-[26px] p-5 text-[#F5F7FA] ${className}`}>{children}</div>;

/**
 * Keyboard key prompt: the outlined pitboard cap. `tone="volt"` fills it, `tone="ink"` is the dark
 * chip that sits inside a volt button. (`dim` is kept for older call sites; it is the default look.)
 */
export const KeyCap: React.FC<{ children: React.ReactNode; dim?: boolean; tone?: "volt" | "ink" }> = ({
  children,
  tone,
}) => (
  <span
    className={`inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full px-[7px] font-f1-mono text-[10px] leading-none font-extrabold ${
      tone === "volt"
        ? "bg-[#CCFF00] text-[#08090D]"
        : tone === "ink"
          ? "bg-[#08090D] text-[#CCFF00]"
          : "border border-[#3A4157] bg-[#08090D] text-[#F5F7FA]"
    }`}
  >
    {children}
  </span>
);

/** Small status pill: FINAL, PB, 2 CONNECTED, 42 ms… */
export const Chip: React.FC<{
  children: React.ReactNode;
  /** Text / dot colour */
  color?: string;
  /** solid: filled with the colour; soft: tinted; outline: hairline in the colour */
  variant?: "solid" | "soft" | "outline";
  /** Leading status dot */
  dot?: boolean;
  className?: string;
}> = ({ children, color = "#8E96AA", variant = "outline", dot, className = "" }) => {
  const style: React.CSSProperties =
    variant === "solid"
      ? { background: color, color: color === "#B845FF" || color === "#FF2A3C" ? "#F5F7FA" : "#08090D" }
      : variant === "soft"
        ? { background: `${color}1F`, color }
        : { boxShadow: `inset 0 0 0 1px ${color === "#8E96AA" ? "#262B3D" : color}`, color };
  return (
    <span
      className={`inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full px-3 font-f1-mono text-[11px] font-extrabold tracking-[0.08em] whitespace-nowrap uppercase ${className}`}
      style={style}
    >
      {dot ? <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} /> : null}
      {children}
    </span>
  );
};

/** Pill segmented control (Off / TC + ABS / Full) */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = "",
  label,
}: {
  options: readonly { id: T; label: React.ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** Accessible name of the group */
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex rounded-full border border-[#262B3D] bg-[#08090D] p-1 ${className}`}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            onClick={() => onChange(o.id)}
            onPointerEnter={focusOnHover}
            className={`min-h-[40px] flex-1 cursor-pointer rounded-full px-3 text-sm font-bold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
              active ? "bg-[#CCFF00] text-[#08090D]" : "text-[#8E96AA] hover:text-[#F5F7FA]"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

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
    className={`group relative flex w-full cursor-pointer items-center gap-3.5 border-0 px-[18px] text-left text-[#F5F7FA] outline-none transition-[background-color,box-shadow,color] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] focus:bg-[#CCFF00] focus:text-[#08090D] focus:shadow-[0_0_0_5px_rgba(204,255,0,0.12)] focus-visible:outline-none ${
      primary ? "min-h-[64px] rounded-[22px] py-2.5" : "min-h-[58px] rounded-[20px] py-1.5"
    } ${open ? "bg-[#00E5FF]/[0.08] shadow-[inset_0_0_0_1px_rgba(0,229,255,0.4)]" : "bg-transparent hover:bg-white/[0.04]"}`}
  >
    {Icon ? (
      <Icon
        aria-hidden
        className={`shrink-0 ${primary ? "h-6 w-6" : "h-5 w-5"} ${open ? "text-[#00E5FF]" : "text-[#8E96AA]"} group-focus:text-[#08090D]`}
        strokeWidth={2}
      />
    ) : null}
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className={`lc-disp flex items-center gap-2.5 ${primary ? "text-[26px]" : "text-[18px] leading-[1.05]"}`}>
        {label}
        {badge ? (
          <span className="inline-flex h-5 items-center rounded-full bg-[#00E5FF] px-2 font-f1-mono text-[10px] font-extrabold tracking-[0.06em] text-[#08090D] not-italic group-focus:bg-[#08090D] group-focus:text-[#CCFF00]">
            {badge}
          </span>
        ) : null}
      </span>
      {detail ? (
        <span className="truncate text-[12px] text-[#8E96AA] group-focus:font-semibold group-focus:text-[#08090D]/75">
          {detail}
        </span>
      ) : null}
    </span>
    {open ? (
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full bg-[#00E5FF] shadow-[0_0_10px_#00E5FF] group-focus:hidden"
      />
    ) : null}
    <ChevronRight
      aria-hidden
      className="hidden h-[18px] w-[18px] shrink-0 group-focus:block"
      strokeWidth={2.6}
    />
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
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-full border border-[#262B3D] bg-[#08090D]/80 p-1 [scrollbar-width:none]"
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
              className={`lc-title inline-flex min-h-[40px] shrink-0 cursor-pointer items-center gap-2 rounded-full px-3.5 text-[14px] whitespace-nowrap outline-none transition-colors duration-200 ${
                active
                  ? "bg-[#CCFF00] text-[#08090D]"
                  : "text-[#8E96AA] hover:bg-white/5 hover:text-[#F5F7FA]"
              }`}
            >
              {/* Every tab carries its icon, so the strip keeps its widths as the selection moves */}
              {Icon ? <Icon aria-hidden className={`h-[15px] w-[15px] shrink-0 ${active ? "" : "opacity-70"}`} strokeWidth={2.4} /> : null}
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
        className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 bg-[#08090D] font-f1-mono text-[11px] leading-none font-extrabold"
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
    <span className="inline-flex h-[22px] min-w-[30px] shrink-0 items-center justify-center rounded-full border-2 border-[#F5F7FA]/80 bg-[#08090D] px-[7px] font-f1-mono text-[10px] leading-none font-extrabold text-[#F5F7FA]">
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
    <div className={`flex flex-wrap items-center gap-x-[22px] gap-y-2 ${className}`}>
      {prompts.map((p) => (
        <span
          key={p.action + p.label}
          className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#C5CBD8]"
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
          ) : p.action === "tabs" && !p.key ? (
            // Two keys, two chips, like the pad's LB / RB
            <>
              <KeyCap>Q</KeyCap>
              <KeyCap>E</KeyCap>
            </>
          ) : (
            <KeyCap>{(p.key ?? KEY_FOR[p.action]).toUpperCase()}</KeyCap>
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
  /** Prompt inside the button: a key name ("ENTER") draws the key chip; a node (a PadGlyph) is shown as is */
  prompt?: React.ReactNode;
}> = ({ children, onClick, disabled, tone = "red", prompt }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    onPointerEnter={focusOnHover}
    className={`lc-primary-button inline-flex h-[52px] cursor-pointer items-center rounded-full transition-[background-color,box-shadow,border-color] duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
      tone === "red"
        ? "gap-3 border-0 bg-[#CCFF00] text-[#08090D] shadow-[0_0_0_5px_rgba(204,255,0,0.12),0_12px_30px_rgba(204,255,0,0.22)] hover:bg-[#d9ff33]"
        : "gap-2.5 border border-[#262B3D] bg-[#1B1F2B]/80 text-[#F5F7FA] hover:border-[#3A4157] hover:bg-[#262B3D]"
    } ${prompt ? (tone === "red" ? "pr-[26px] pl-2.5" : "pr-[22px] pl-2.5") : "px-[26px]"}`}
  >
    {typeof prompt === "string" ? (
      <span
        className={`inline-flex h-8 items-center rounded-full px-2.5 font-f1-mono text-[11px] font-extrabold ${
          tone === "red" ? "bg-[#08090D] text-[#CCFF00]" : "border border-[#262B3D] text-[#8E96AA]"
        }`}
      >
        {prompt}
      </span>
    ) : prompt ? (
      <span className="inline-flex h-8 min-w-8 items-center justify-center">{prompt}</span>
    ) : null}
    <span className={tone === "red" ? "lc-disp text-[20px]" : "lc-title text-[16px]"}>{children}</span>
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
    <span className="lc-lbl w-20 shrink-0">{label}</span>
    <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-[#1B1F2B]">
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, background: color }}
      />
    </span>
    <span className="w-14 shrink-0 text-right font-f1-mono text-[12px] font-extrabold text-[#F5F7FA] tabular-nums">
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
      <span className="lc-lbl w-20 shrink-0">{label}</span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-[#1B1F2B]">
        <span className="absolute inset-y-0 left-1/2 w-px bg-white/40" />
        <span
          className="absolute inset-y-0 rounded-full bg-[#00E5FF]"
          style={v >= 0 ? { left: "50%", width: `${v * 50}%` } : { right: "50%", width: `${-v * 50}%` }}
        />
      </span>
      <span className="w-14 shrink-0 text-right font-f1-mono text-[12px] font-extrabold text-[#F5F7FA] tabular-nums">
        {detail ?? `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}`}
      </span>
    </div>
  );
};

/** The LibreCorsa title block shared by the loading screen and title menu */
export const GameTitle: React.FC<{ kicker: string; size?: "lg" | "xl" }> = ({ kicker, size = "xl" }) => (
  <div className="flex flex-col items-start gap-3">
    <LibreCorsaLogo variant="full" size={size === "xl" ? "lg" : "md"} />
    <div className="inline-flex h-8 items-center gap-2.5 rounded-full border border-[#262B3D] bg-[#11131A]/70 px-3.5 font-f1-mono text-[11px] font-bold tracking-[0.14em] text-[#CCFF00] uppercase backdrop-blur">
      <span className="relative flex h-2 w-2">
        <span className="lc-ping absolute inline-flex h-full w-full rounded-full bg-[#CCFF00]" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[#CCFF00]" />
      </span>
      {kicker}
    </div>
  </div>
);
