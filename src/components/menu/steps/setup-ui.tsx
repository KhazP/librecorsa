"use client";

import React from "react";
import {
  ASSIST_PRESETS,
  deviceAssistTuning,
  evaluateSelfSteerDeg,
  type AssistPresetInfo,
  type DeviceAssistTuning,
} from "@/lib/sim/steering-assist";

/** Setup-wizard building blocks (Racing Line): frosted section cards, small pill actions, binding rows, live meters */

/** A frosted section card with the volt-dot label and an optional action on the right */
export const SetupCard: React.FC<{
  label?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** Extra classes (padding overrides go here; avoid repeating the base padding utilities) */
  className?: string;
  /** Accessible name of the section (defaults to the label when it is a string) */
  ariaLabel?: string;
}> = ({ label, action, children, className = "", ariaLabel }) => (
  <section
    aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
    className={`lc-glass flex flex-col gap-3.5 rounded-[24px] px-4 py-4 text-[#F5F7FA] sm:px-[22px] sm:py-5 short:gap-2.5 short:py-3 ${className}`}
  >
    {label || action ? (
      <div className="flex flex-wrap items-center justify-between gap-3">
        {label ? <CardLabel>{label}</CardLabel> : <span />}
        {action}
      </div>
    ) : null}
    {children}
  </section>
);

export const CardLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="flex min-w-0 items-center gap-2">
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#CCFF00]" />
    <span className="lc-lbl">{children}</span>
  </span>
);

/** Small outlined pill for secondary actions: RESET, CLEAR, TEST, CANCEL */
export const PillAction: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}> = ({ children, onClick, disabled, className = "" }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex h-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#262B3D] bg-transparent px-3 font-f1-mono text-[10px] font-extrabold tracking-[0.12em] text-[#8E96AA] uppercase transition-colors duration-200 hover:border-[#CCFF00] hover:text-[#CCFF00] disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
  >
    {children}
  </button>
);

/** Filled pill for a step's working actions: white (Recalibrate, Test direction) or volt (Calibrate all) */
export const SolidPill: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "white" | "volt";
  className?: string;
}> = ({ children, onClick, disabled, tone = "white", className = "" }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex h-[34px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 px-3.5 text-[13px] font-bold whitespace-nowrap text-[#08090D] transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-30 ${
      tone === "volt" ? "bg-[#CCFF00] hover:bg-[#d9ff33]" : "bg-[#F5F7FA] hover:bg-[#CCFF00] disabled:hover:bg-[#F5F7FA]"
    } ${className}`}
  >
    {children}
  </button>
);

/** One action of a binding list; the row lights up while it waits for an input */
export const BindRow: React.FC<{ label: string; listening?: boolean; children: React.ReactNode }> = ({
  label,
  listening,
  children,
}) => (
  <div
    className={`flex min-h-[44px] items-center justify-between gap-2.5 rounded-[14px] py-1 pr-1 pl-3 transition-colors duration-200 ${
      listening ? "bg-[#CCFF00]/[0.06] shadow-[inset_0_0_0_1px_rgba(204,255,0,0.3)]" : "hover:bg-white/[0.03]"
    }`}
  >
    <span className="lc-title min-w-0 text-[14px] text-[#F5F7FA]">{label}</span>
    {children}
  </div>
);

/** Class for a binding chip: a bound key / button, an empty slot, or the one listening */
export const bindKeyClass = (state: "bound" | "empty" | "listening", minWidth = "min-w-[56px]") =>
  `inline-flex h-[34px] ${minWidth} shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 font-f1-mono font-extrabold whitespace-nowrap transition-colors duration-200 ${
    state === "listening"
      ? "lc-listen border-0 bg-[#CCFF00] text-[12px] text-[#08090D]"
      : state === "bound"
        ? "border-0 bg-[#F5F7FA] text-[12px] text-[#08090D] hover:bg-[#CCFF00]"
        : "border border-dashed border-[#3A4157] bg-transparent text-[13px] text-[#5B6275] hover:border-[#8E96AA] hover:text-[#C5CBD8]"
  }`;

/** The mono status pill under a binding list ("Press a key · Esc cancels") */
export const StatusPill: React.FC<{ children: React.ReactNode; tone?: "live" | "info" | "idle" }> = ({
  children,
  tone = "idle",
}) => (
  <p
    role="status"
    className={`m-0 rounded-full bg-[#08090D] px-3.5 py-2.5 font-f1-mono text-[12px] font-bold ${
      tone === "live" ? "text-[#CCFF00]" : tone === "info" ? "text-[#C5CBD8]" : "text-[#8E96AA]"
    }`}
  >
    {children}
  </p>
);

/** Body copy under a control */
export const Hint: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <p className={`m-0 text-[12px] leading-[1.45] text-[#8E96AA] ${className}`}>{children}</p>
);

/** Italic uppercase sub-heading inside a card (Steering axis, Rotation, Telemetry out) */
export const SubHead: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <span className={`lc-title text-[14px] text-[#F5F7FA] ${className}`}>{children}</span>
);

/** Choice card content: title + one line */
export const ChoiceText: React.FC<{ title: React.ReactNode; detail?: React.ReactNode; size?: number }> = ({
  title,
  detail,
  size = 16,
}) => (
  <span className="flex flex-col items-start gap-0.5">
    <span className="lc-title leading-tight" style={{ fontSize: size }}>
      {title}
    </span>
    {detail ? <span className="text-[12px] leading-[1.4] opacity-75">{detail}</span> : null}
  </span>
);

/**
 * Live input bar on a dark 10 px track: 0..1 from the left, or −1..1 from the centre (steering).
 * `labelWidth` / `valueWidth` keep the label and readout columns aligned in a stack of meters.
 */
export const TrackMeter: React.FC<{
  label: string;
  value: number;
  color?: string;
  detail?: string;
  centered?: boolean;
  compact?: boolean;
}> = ({ label, value, color = "#00E676", detail, centered, compact }) => {
  const v = centered ? Math.max(-1, Math.min(1, value)) : Math.max(0, Math.min(1, value));
  const idle = Math.abs(v) < 0.005;
  return (
    <div
      className={`grid items-center gap-3 ${
        compact ? "grid-cols-[64px_minmax(0,1fr)_56px]" : "grid-cols-[72px_minmax(0,1fr)_64px] sm:grid-cols-[84px_minmax(0,1fr)_74px] sm:gap-3.5"
      }`}
    >
      <span className={`font-f1-mono font-extrabold tracking-[0.12em] text-[#8E96AA] uppercase ${compact ? "text-[10px]" : "text-[11px]"}`}>
        {label}
      </span>
      <span className="relative h-2.5 overflow-hidden rounded-full bg-[#08090D] shadow-[inset_0_0_0_1px_#262B3D]">
        {centered ? (
          <>
            <span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-[#F5F7FA]/50" />
            <span
              className={`absolute inset-y-0 ${v >= 0 ? "rounded-r-full" : "rounded-l-full"}`}
              style={{
                background: color,
                ...(v >= 0 ? { left: "50%", width: `${v * 50}%` } : { right: "50%", width: `${-v * 50}%` }),
              }}
            />
          </>
        ) : (
          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(v * 100)}%`, background: color }} />
        )}
      </span>
      <span
        className="text-right font-f1-mono text-[12px] font-extrabold tabular-nums"
        style={{ color: idle ? "#8E96AA" : centered ? color : "#F5F7FA" }}
      >
        {detail ??
          (centered ? `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}` : `${Math.round(v * 100)}%`)}
      </span>
    </div>
  );
};

/** Responsive grid of sliders / toggles (auto-fit columns of at least `min` px) */
export const AutoGrid: React.FC<{ min: number; children: React.ReactNode; className?: string }> = ({
  min,
  children,
  className = "",
}) => (
  <div className={`grid ${className}`} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))` }}>
    {children}
  </div>
);

function matchesAssistPreset(tuning: DeviceAssistTuning, preset: AssistPresetInfo): boolean {
  const t = preset.tuning;
  return (
    Math.abs(tuning.selfSteerStrength - t.selfSteerStrength) < 0.008 &&
    Math.abs(tuning.dampingStrength - t.dampingStrength) < 0.008 &&
    Math.abs(tuning.speedSensitivity - t.speedSensitivity) < 0.008 &&
    Math.abs(tuning.slipLimitMargin - t.slipLimitMargin) < 0.005 &&
    Math.abs(tuning.maxSelfSteerAngleDeg - t.maxSelfSteerAngleDeg) < 0.5
  );
}

/** One-click factory assist presets (Balanced, Stable, Loose, Drift, Calm at speed) */
export const AssistPresetBar: React.FC<{
  tuning: DeviceAssistTuning;
  onSelect: (presetTuning: DeviceAssistTuning) => void;
  compact?: boolean;
}> = ({ tuning, onSelect, compact }) => {
  const activePreset = ASSIST_PRESETS.find((p) => matchesAssistPreset(tuning, p));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Assist presets">
        <span className="mr-1 font-f1-mono text-[10px] font-extrabold tracking-[0.12em] text-[#8E96AA] uppercase">
          Presets
        </span>
        {ASSIST_PRESETS.map((preset) => {
          const active = activePreset?.id === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={active}
              title={preset.detail}
              onClick={() => onSelect({ ...preset.tuning })}
              className={`inline-flex h-[30px] cursor-pointer items-center justify-center rounded-full px-3 font-f1-mono text-[11px] font-extrabold tracking-[0.1em] uppercase transition-colors duration-200 ${
                active
                  ? "border border-[#CCFF00] bg-[#CCFF00] text-[#08090D]"
                  : "border border-[#262B3D] bg-[#08090D]/60 text-[#C5CBD8] hover:border-[#CCFF00] hover:text-[#CCFF00]"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      {!compact ? (
        <span className="text-[12px] text-[#8E96AA]">
          {activePreset ? `${activePreset.label}: ${activePreset.detail}` : "Custom tuning"}
        </span>
      ) : null}
    </div>
  );
};

/**
 * Self-steer & slip-limit curve preview: plots automatic countersteer road-wheel angle (0..25°) against rear slide
 * angle (0..45°), showing the nonlinear self-steer exponent, the soft-clamped `maxSelfSteerAngleDeg` cap, and the
 * target front peak-slip percentage (`95 % + slipLimitMargin`).
 */
export const AssistCurve: React.FC<{ tuning: DeviceAssistTuning; lockDeg?: number }> = ({ tuning, lockDeg = 25 }) => {
  const maxRearDeg = 45;
  const x0 = 12;
  const x1 = 148;
  const y0 = 86;
  const y1 = 14;
  const toX = (rearDeg: number) => x0 + (rearDeg / maxRearDeg) * (x1 - x0);
  const toY = (steerDeg: number) => y0 - (Math.min(lockDeg, Math.max(0, steerDeg)) / lockDeg) * (y0 - y1);

  const points: string[] = [];
  for (let i = 0; i <= 45; i++) {
    const rearDeg = i;
    const steerDeg = evaluateSelfSteerDeg(rearDeg, tuning, lockDeg);
    points.push(`${i === 0 ? "M" : "L"}${toX(rearDeg).toFixed(1)} ${toY(steerDeg).toFixed(1)}`);
  }

  const capDeg = Math.min(lockDeg, tuning.maxSelfSteerAngleDeg);
  const capY = toY(capDeg);
  const targetSlipPct = Math.round(deviceAssistTuning(tuning).targetSlip * 100);

  return (
    <div className="flex flex-col gap-2 rounded-[18px] border border-[#262B3D] bg-[#08090D] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="lc-lbl text-[10px]!">Self-steer curve</span>
        <span className="font-f1-mono text-[11px] font-extrabold text-[#CCFF00] tabular-nums">
          {targetSlipPct}% grip · {Math.round(capDeg)}° cap
        </span>
      </div>
      <svg viewBox="0 0 160 100" className="block h-auto w-full" role="img" aria-label="Self-steer response curve">
        <rect x="6" y="6" width="148" height="88" rx="10" fill="none" stroke="#262B3D" strokeWidth="1" />
        {/* 1:1 reference line (rear slide angle = road-wheel angle up to full lock) */}
        <line
          x1={toX(0).toFixed(1)}
          y1={toY(0).toFixed(1)}
          x2={toX(lockDeg).toFixed(1)}
          y2={toY(lockDeg).toFixed(1)}
          stroke="#5B6275"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        {/* Countersteer cap reference line */}
        <line
          x1={x0}
          y1={capY.toFixed(1)}
          x2={x1}
          y2={capY.toFixed(1)}
          stroke="#00E5FF"
          strokeOpacity="0.45"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        <path
          d={points.join(" ")}
          fill="none"
          stroke="#CCFF00"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text x="14" y="91" fill="#8E96AA" fontSize="8" fontFamily="monospace">
          0° slide
        </text>
        <text x="146" y="91" fill="#8E96AA" fontSize="8" fontFamily="monospace" textAnchor="end">
          45° slide
        </text>
      </svg>
    </div>
  );
};
