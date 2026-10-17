"use client";

import React from "react";

/** Shared building blocks of the loading screen, title menu and setup wizard (pause-menu look) */

export const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`mb-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500 uppercase ${className}`}>{children}</div>
);

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`rounded-md bg-[#14141c] p-4 text-white ${className}`}>{children}</div>
);

export const KeyCap: React.FC<{ children: React.ReactNode; dim?: boolean }> = ({ children, dim }) => (
  <span
    className={`inline-flex min-w-[1.6rem] items-center justify-center rounded px-1.5 py-0.5 font-f1-mono text-[11px] font-bold ${
      dim ? "bg-white/10 text-zinc-400" : "bg-white/90 text-[#111]"
    }`}
  >
    {children}
  </span>
);

/** One entry of a vertical menu rail: white when highlighted, red edge when its panel is open */
export const RailItem: React.FC<{
  label: string;
  detail?: string;
  active: boolean;
  open?: boolean;
  onHover: () => void;
  onClick: () => void;
}> = ({ label, detail, active, open, onHover, onClick }) => (
  <button
    type="button"
    onMouseEnter={onHover}
    onFocus={onHover}
    onClick={onClick}
    className={`flex w-full cursor-pointer flex-col rounded-md border-l-4 px-3 py-2.5 text-left transition-colors ${
      active ? "bg-white text-[#111]" : "bg-[#14141c]/90 text-white hover:bg-[#1c1c26]"
    } ${open ? "border-[#E10600]" : "border-transparent"}`}
  >
    <span className="font-f1-italic text-base uppercase">{label}</span>
    {detail ? (
      <span className={`font-f1-mono text-[11px] ${active ? "text-zinc-600" : "text-zinc-500"}`}>{detail}</span>
    ) : null}
  </button>
);

export const PrimaryButton: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "red" | "dark";
}> = ({ children, onClick, disabled, tone = "red" }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`hud-slant cursor-pointer px-6 py-2.5 font-f1-italic text-sm uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      tone === "red" ? "bg-[#E10600] text-white hover:bg-[#ff1a0f]" : "bg-[#1c1c26] text-white hover:bg-[#26263a]"
    }`}
  >
    {children}
  </button>
);

/** 0..1 bar */
export const Meter: React.FC<{ label: string; value: number; color?: string; detail?: string }> = ({
  label,
  value,
  color = "#00D26A",
  detail,
}) => (
  <div className="flex items-center gap-3">
    <span className="w-20 shrink-0 font-f1-mono text-[11px] font-bold uppercase text-zinc-400">{label}</span>
    <span className="relative h-2.5 flex-1 overflow-hidden rounded bg-black/50">
      <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, background: color }} />
    </span>
    <span className="w-14 shrink-0 text-right font-f1-mono text-[11px] font-bold tabular-nums text-white">
      {detail ?? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`}
    </span>
  </div>
);

/** −1..1 centred bar (steering) */
export const CenterMeter: React.FC<{ label: string; value: number; detail?: string }> = ({ label, value, detail }) => {
  const v = Math.max(-1, Math.min(1, value));
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 font-f1-mono text-[11px] font-bold uppercase text-zinc-400">{label}</span>
      <span className="relative h-2.5 flex-1 overflow-hidden rounded bg-black/50">
        <span className="absolute inset-y-0 left-1/2 w-px bg-white/40" />
        <span
          className="absolute inset-y-0 rounded bg-[#00D2BE]"
          style={v >= 0 ? { left: "50%", width: `${v * 50}%` } : { right: "50%", width: `${-v * 50}%` }}
        />
      </span>
      <span className="w-14 shrink-0 text-right font-f1-mono text-[11px] font-bold tabular-nums text-white">
        {detail ?? `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}`}
      </span>
    </div>
  );
};

/** The game title block shared by the loading screen and title menu */
export const GameTitle: React.FC<{ kicker: string; size?: "lg" | "xl" }> = ({ kicker, size = "xl" }) => (
  <div>
    <div className="font-f1-mono text-xs font-black tracking-[0.22em] text-[#E10600] uppercase">{kicker}</div>
    <h1
      className={`mt-1 font-f1-italic uppercase leading-[0.9] tracking-wide text-white ${
        size === "xl" ? "text-5xl sm:text-7xl short:text-4xl" : "text-4xl sm:text-6xl short:text-4xl"
      }`}
    >
      Rwanda
      <br />
      Grand Prix
    </h1>
  </div>
);
