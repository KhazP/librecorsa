"use client";

import React, { useId } from "react";
import { COMPOUNDS, type Compound } from "@/components/ui/badges/compounds";

/**
 * Drawn parts of the pre-race show (1:1 F1 broadcast visual grammar in LibreCorsa's colours):
 * - A heroic BLACK racing-driver silhouette (helmet, recessed visor, HANS collar, race-suit shoulders — never a face)
 * - Side-on motorsport tyre with segmented compound arcs, grooved wet/inter treads, forged spokes and center-lock hub
 * - Segmented F1 broadcast telemetry lower-third bar (`InfoBar`) with crisp dividers and volt accent blade
 * - Top-left F1 broadcast bug (`SceneBug`) with volt bracket rail
 */

/** A racing driver in full-face helmet, visor, HANS device and fireproof suit, in black with team-colour rim light */
export const DriverSilhouette: React.FC<{ color: string; mirror?: boolean; className?: string }> = ({ color, mirror = false, className }) => {
  const uid = useId().replace(/:/g, "");
  const rim = `lc-show-rim-${uid}`;
  const visorSheen = `lc-show-vis-${uid}`;
  return (
    <svg viewBox="0 0 220 236" className={className} style={mirror ? { transform: "scaleX(-1)" } : undefined} aria-hidden>
      <defs>
        <linearGradient id={rim} x1="0" y1="0" x2="1" y2="0.15">
          <stop offset="0" stopColor={color} stopOpacity="1" />
          <stop offset="0.16" stopColor={color} stopOpacity="0.15" />
          <stop offset="0.8" stopColor={color} stopOpacity="0.15" />
          <stop offset="1" stopColor={color} stopOpacity="1" />
        </linearGradient>
        <linearGradient id={visorSheen} x1="0" y1="0" x2="1" y2="0.65">
          <stop offset="0" stopColor="var(--color-lc-titanium)" stopOpacity="0.9" />
          <stop offset="0.45" stopColor="var(--color-lc-carbon)" stopOpacity="0.96" />
          <stop offset="1" stopColor="var(--color-lc-void)" stopOpacity="1" />
        </linearGradient>
      </defs>

      {/* Fireproof race suit torso & broad shoulders */}
      <path
        d="M6 236C10 198 29 175 64 164L84 157H136L156 164C191 175 210 198 214 236Z"
        fill="var(--color-lc-void)"
      />
      {/* Shoulder extraction epaulettes */}
      <path d="M35 180L68 166L74 176L43 191Z" fill="var(--color-lc-carbon)" stroke={color} strokeOpacity="0.45" strokeWidth="1.3" />
      <path d="M185 180L152 166L146 176L177 191Z" fill="var(--color-lc-carbon)" stroke={color} strokeOpacity="0.45" strokeWidth="1.3" />

      {/* HANS device collar & twin carbon yokes */}
      <path
        d="M61 167C65 151 81 145 110 145C139 145 155 151 159 167L155 202L137 208L133 176C124 181 96 181 87 176L83 208L65 202Z"
        fill="var(--color-lc-void)"
        stroke="var(--color-lc-titanium)"
        strokeWidth="1.8"
      />
      <path
        d="M65 166C69 154 84 148 110 148C136 148 151 154 155 166"
        fill="none"
        stroke={color}
        strokeOpacity="0.58"
        strokeWidth="1.8"
      />
      {/* Race-suit chest piping & collar zip */}
      <line x1="110" y1="181" x2="110" y2="236" stroke="var(--color-lc-line)" strokeOpacity="0.5" strokeWidth="1.6" />

      {/* Full-face F1 helmet shell (heroic slight 3/4 turn with sculpted chin bar & crown spoiler) */}
      <path
        d="M112 16C150 16 174 43 175 82C176 103 170 123 160 137C151 149 134 157 112 158C90 158 74 151 63 140C52 128 47 109 48 85C49 46 74 16 112 16Z"
        fill="var(--color-lc-void)"
      />
      {/* Rear aero spoiler lip */}
      <path d="M50 63C43 72 42 86 47 99L53 95C51 84 52 73 55 65Z" fill="var(--color-lc-void)" stroke={color} strokeOpacity="0.62" strokeWidth="1.5" />

      {/* Recessed angular racing visor */}
      <path
        d="M71 71C94 64 131 65 166 75C171 77 173 84 171 94C169 102 164 107 155 107C128 104 98 104 73 108C66 109 62 104 62 95C62 83 65 73 71 71Z"
        fill={`url(#${visorSheen})`}
      />
      {/* Subtle dark specular glint on the visor */}
      <path d="M84 70L106 67L93 105L73 106Z" fill="var(--color-lc-chalk)" fillOpacity="0.09" />
      {/* Bold team-coloured visor brow strip */}
      <path
        d="M70 74C95 67 132 68 166 77"
        fill="none"
        stroke={color}
        strokeOpacity="0.92"
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* Lower visor seal & tear-off pivot pods */}
      <path
        d="M65 105C94 101 129 101 164 105"
        fill="none"
        stroke="var(--color-lc-keyline)"
        strokeOpacity="0.7"
        strokeWidth="1.5"
      />
      <circle cx="65" cy="91" r="4.6" fill="var(--color-lc-carbon)" stroke={color} strokeOpacity="0.78" strokeWidth="1.5" />
      <circle cx="169" cy="92" r="3.8" fill="var(--color-lc-carbon)" stroke={color} strokeOpacity="0.68" strokeWidth="1.3" />

      {/* Sculpted chin bar & front air-intake vent notches */}
      <path
        d="M103 129H137L133 140H107Z"
        fill="var(--color-lc-carbon)"
        stroke="var(--color-lc-line)"
        strokeWidth="1.3"
      />
      <line x1="114" y1="130" x2="114" y2="139" stroke="var(--color-lc-void)" strokeWidth="1.8" />
      <line x1="126" y1="130" x2="126" y2="139" stroke="var(--color-lc-void)" strokeWidth="1.8" />

      {/* Dual team-colour rim light across helmet shell and shoulders */}
      <path
        d="M112 16C150 16 174 43 175 82C176 103 170 123 160 137C151 149 134 157 112 158C90 158 74 151 63 140C52 128 47 109 48 85C49 46 74 16 112 16Z M6 236C10 198 29 175 64 164L84 157 M136 157L156 164C191 175 210 198 214 236"
        fill="none"
        stroke={`url(#${rim})`}
        strokeWidth="3"
      />
    </svg>
  );
};

/** A motorsport tyre side-on: rubber tread (grooved for wet/inter), segmented compound arc stripes, forged wheel & hub */
export const TyreArt: React.FC<{ compound: Compound; className?: string }> = ({ compound, className }) => {
  const c = COMPOUNDS[compound];
  const band = `var(--color-lc-${c.color})`;
  const grooved = compound === "intermediate" || compound === "wet";
  return (
    <svg viewBox="0 0 120 120" className={className} aria-hidden>
      <circle cx="60" cy="60" r="57" fill="var(--color-lc-void)" stroke="var(--color-lc-titanium)" strokeWidth="2.5" />
      <circle cx="60" cy="60" r="51" fill="none" stroke="var(--color-lc-carbon)" strokeWidth="4" />
      {grooved
        ? Array.from({ length: 24 }, (_, i) => {
            const a = (i / 24) * Math.PI * 2;
            return (
              <line
                key={i}
                x1={60 + Math.cos(a) * 52}
                y1={60 + Math.sin(a) * 52}
                x2={60 + Math.cos(a + 0.08) * 57}
                y2={60 + Math.sin(a + 0.08) * 57}
                stroke="var(--color-lc-keyline)"
                strokeWidth="1.8"
              />
            );
          })
        : null}
      <circle
        cx="60"
        cy="60"
        r="43"
        fill="none"
        stroke={band}
        strokeWidth="5.2"
        strokeDasharray="106 32 106 26"
        strokeDashoffset="-16"
        strokeLinecap="round"
        transform="rotate(-90 60 60)"
      />
      <circle cx="60" cy="60" r="33" fill="var(--color-lc-well)" stroke="var(--color-lc-keyline)" strokeWidth="2" />
      <circle cx="60" cy="60" r="24" fill="none" stroke="var(--color-lc-line)" strokeWidth="5" strokeDasharray="3 3" opacity="0.65" />
      {Array.from({ length: 10 }, (_, i) => {
        const a = (i / 10) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={60 + Math.cos(a) * 11}
            y1={60 + Math.sin(a) * 11}
            x2={60 + Math.cos(a) * 30.5}
            y2={60 + Math.sin(a) * 30.5}
            stroke="var(--color-lc-titanium)"
            strokeWidth="3.6"
            strokeLinecap="round"
          />
        );
      })}
      <circle cx="60" cy="60" r="10" fill="var(--color-lc-carbon)" stroke={band} strokeWidth="2.2" />
      <circle cx="60" cy="60" r="4.5" fill="var(--color-lc-void)" stroke="var(--color-lc-keyline)" strokeWidth="1.2" />
      <text
        x="60"
        y="17.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="13"
        fontWeight="800"
        fill={band}
        className="font-lc-display"
      >
        {c.letter}
      </text>
    </svg>
  );
};

export interface InfoBarEntry {
  text: string;
  tone?: "chalk" | "fog" | "volt" | "info" | "ink";
  /** Optional small colour pip (token CSS colour) */
  dot?: string;
}

export type InfoBarItem = string | InfoBarEntry | null | false | undefined;

const TONE_CLASS: Record<NonNullable<InfoBarEntry["tone"]>, string> = {
  chalk: "text-lc-chalk",
  fog: "text-lc-fog",
  volt: "text-lc-volt",
  info: "text-lc-info",
  ink: "text-lc-void",
};

/** F1-style segmented broadcast lower-third ribbon: volt lead block or slash + crisp telemetry cells */
export const InfoBar: React.FC<{
  items: readonly InfoBarItem[];
  leadVolt?: boolean;
  className?: string;
  style?: React.CSSProperties;
}> = ({ items, leadVolt = false, className = "", style }) => {
  const shown: InfoBarEntry[] = [];
  for (const item of items) {
    if (!item) continue;
    shown.push(typeof item === "string" ? { text: item } : item);
  }
  if (shown.length === 0) return null;
  return (
    <div
      className={`lc-show-wipe lc-show-chamfer-sm inline-flex max-w-full items-stretch overflow-hidden border-t-2 border-lc-volt bg-lc-void/92 shadow-lc-pop backdrop-blur-sm ${className}`}
      style={style}
    >
      {!leadVolt ? <span aria-hidden className="w-2 shrink-0 bg-lc-volt" /> : null}
      <div className="flex min-w-0 flex-wrap items-stretch">
        {shown.map((item, i) => {
          const isLead = leadVolt && i === 0;
          const tone = isLead ? "ink" : (item.tone ?? (i === 0 ? "chalk" : "fog"));
          return (
            <span
              key={i}
              className={`lc-mono inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-bold tracking-[0.04em] sm:px-3.5 sm:text-[14px] ${
                isLead
                  ? "bg-lc-volt font-extrabold"
                  : i > 0
                    ? "border-l border-lc-line/85"
                    : ""
              } ${TONE_CLASS[tone]}`}
            >
              {item.dot ? <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.dot }} /> : null}
              {item.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Compact F1-style top-left broadcast bug with volt top-right corner bracket */
export const SceneBug: React.FC<{ primary: string; secondary?: string | null; accent?: string | null }> = ({ primary, secondary, accent }) => (
  <div className="lc-show-wipe inline-flex max-w-full items-stretch self-start overflow-hidden rounded-tr-lc-row border-t-2 border-r-2 border-lc-volt bg-lc-void/90 shadow-lc-pop backdrop-blur-sm">
    <span aria-hidden className="w-1.5 shrink-0 bg-lc-volt" />
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 px-3.5 py-1.5 sm:py-2">
      <span className="lc-disp truncate text-[15px] leading-none text-lc-chalk sm:text-[18px]">{primary}</span>
      {secondary ? (
        <>
          <span aria-hidden className="h-3.5 w-px shrink-0 bg-lc-line" />
          <span className="lc-mono truncate text-[12px] font-bold text-lc-fog sm:text-[13px]">{secondary}</span>
        </>
      ) : null}
      {accent ? (
        <>
          <span aria-hidden className="h-3.5 w-px shrink-0 bg-lc-line" />
          <span className="lc-mono truncate text-[12px] font-bold text-lc-volt sm:text-[13px]">{accent}</span>
        </>
      ) : null}
    </div>
  </div>
);
