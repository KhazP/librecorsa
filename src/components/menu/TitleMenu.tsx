"use client";

import React, { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PauseMenuProps } from "@/components/hud/PauseMenu";
import { carById, carClass } from "@/lib/cars/car-registry";
import { EngineersGarage } from "./EngineersGarage";
import { MultiplayerPanel } from "@/components/hud/MultiplayerPanel";
import { DisplayPanel } from "@/components/hud/DisplayPanel";
import { LeaderboardPanel } from "@/components/hud/LeaderboardPanel";
import { buildHudMap, mapPoint, SECTOR_COLORS, type HudMap } from "@/components/hud/styles/hud-style-parts";
import { ACTIVE_TRACK_ID, BASE_ALTITUDE_M, getTrackData, TRACK_TOTAL_LENGTH_M, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo, RWANDA_TRACK_ID, TRACKS, type TrackInfo } from "@/lib/track-registry";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import type { HudPreset } from "@/lib/settings/player-settings";
import { useGamepads, type PadState } from "./useMenuNav";
import { focusInZone, focusOnHover, useFocusNav } from "./useFocusNav";
import { useInputMode } from "./input-mode";
import { KeyCap, PadGlyph, PromptBar } from "./menu-ui";
import { RequestPanel } from "./RequestPanel";
import { ConditionsPanel, type ConditionsPanelProps } from "./ConditionsPanel";
import { TIME_OF_DAY_LABELS, WEATHER_LABELS } from "@/lib/sim/weather";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { AI_SKILL_DEFAULT, aiSkillLabel } from "@/lib/sim/ai-tuning";
import {
  CloudSun,
  ExternalLink,
  Flag,
  Gamepad2,
  Info,
  Keyboard,
  MessageSquarePlus,
  MonitorCog,
  Play,
  Route,
  Timer,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

type TitlePanel = "circuit" | "conditions" | "garage" | "multiplayer" | "leaderboard" | "display" | "credits" | "request";

export interface TitleMenuProps extends PauseMenuProps {
  firstRun: boolean;
  onDrive: () => void;
  onRaceAi: () => void;
  onControls: () => void;
  initialPanel?: TitlePanel | null;
  /** Active circuit id */
  trackId?: string;
  /** Switches circuit (reloads the scene) */
  onSelectTrack?: (id: string) => void;
  /** Weather, time of day and simulation realism */
  conditionsPanel?: ConditionsPanelProps;
}

const linkClass = "underline decoration-[#00E5FF]/40 underline-offset-2 text-[#00E5FF] hover:text-[#CCFF00]";

const ASSIST_LABELS: Record<PauseMenuProps["assistPreset"], string> = {
  pro: "No assists",
  semi_pro: "TC + ABS",
  assisted: "Full assists",
};

const HUD_LABELS: Record<HudPreset, string> = {
  broadcast: "Broadcast",
  dash: "Wheel Dash",
  telemetry: "Telemetry",
  classic: "Classic",
  minimal: "Minimal",
};

const km = (t: TrackInfo) => (t.lengthM / 1000).toFixed(2);

/** Circuit outline from the active track's centreline: a volt thumbnail, or coloured by sector with the flow dashes */
const TrackOutline: React.FC<{ map: HudMap; sectors?: boolean; className?: string; label?: string }> = ({
  map,
  sectors = false,
  className,
  label,
}) => {
  const pad = 60;
  const [sx, sy] = mapPoint(map, 0);
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${map.w + pad * 2} ${map.h + pad * 2}`}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={map.path} fill="none" stroke={sectors ? "#141822" : "#1B1F2B"} strokeWidth={sectors ? 52 : 56} strokeLinejoin="round" />
      {sectors ? (
        map.sectorPaths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={SECTOR_COLORS[i]} strokeWidth={16} strokeLinejoin="round" strokeLinecap="round" />
        ))
      ) : (
        <path d={map.path} fill="none" stroke="#CCFF00" strokeWidth={22} strokeLinejoin="round" />
      )}
      {sectors ? (
        <path
          d={map.path}
          fill="none"
          stroke="#F5F7FA"
          strokeOpacity={0.7}
          strokeWidth={4}
          strokeDasharray="3 37"
          className="lc-flow"
        />
      ) : null}
      <rect x={sx - 6} y={sy - 28} width={12} height={56} rx={3} fill="#F5F7FA" />
    </svg>
  );
};

const CircuitPanel: React.FC<{ trackId: string; onSelect?: (id: string) => void; map: HudMap | null }> = ({
  trackId,
  onSelect,
  map,
}) => {
  const active = getTrackInfo(trackId);
  const stats: [string, string][] = [
    ["Length", `${km(active)} km`],
    ["Turns", String(active.turns)],
    ["Direction", /counter|anti/i.test(active.direction) ? "CCW" : /clock/i.test(active.direction) ? "CW" : active.direction],
    ...(map && BASE_ALTITUDE_M > 0 ? [["Altitude", `${Math.round(BASE_ALTITUDE_M).toLocaleString("en-US")} m`] as [string, string]] : []),
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-5">
      <div className="flex min-w-0 flex-col gap-2.5">
        {TRACKS.map((t) => {
          const isActive = t.id === trackId;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={isActive}
              disabled={!onSelect}
              onClick={() => !isActive && onSelect?.(t.id)}
              onPointerEnter={focusOnHover}
              className={`flex cursor-pointer items-center gap-4 rounded-[20px] px-4 py-3.5 text-left transition-[background-color,border-color] duration-200 disabled:cursor-not-allowed ${
                isActive
                  ? "border-[1.5px] border-[#CCFF00] bg-[#CCFF00]/[0.07] shadow-[0_0_0_5px_rgba(204,255,0,0.08)]"
                  : "border border-[#262B3D] bg-[#08090D]/55 hover:border-[#3A4157] hover:bg-[#1B1F2B]"
              }`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="lc-title text-[18px] leading-[1.1] text-[#F5F7FA]">{t.name}</span>
                  {t.id === RWANDA_TRACK_ID ? (
                    <span className="rounded-full bg-[#CCFF00] px-[7px] py-0.5 font-f1-mono text-[9px] font-extrabold tracking-[0.08em] text-[#08090D]">
                      ORIGINAL
                    </span>
                  ) : null}
                </span>
                <span className="text-[13px] text-[#8E96AA]">
                  {t.layout} · {t.city}, {t.country}
                </span>
                <span className={`font-f1-mono text-[11px] font-extrabold ${isActive ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}>
                  {km(t)} KM · {t.turns} TURNS{isActive ? " · ACTIVE" : ""}
                </span>
              </span>
            </button>
          );
        })}
        <p className="m-0 mx-1 mt-1.5 text-[13px] leading-relaxed text-[#8E96AA]">
          Real-world circuits are converted from community scans (see Credits). Corners, kerbs, run-off and barriers are
          detected automatically, so details can differ from the real venue.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3.5 self-start rounded-[22px] border border-[#262B3D] bg-[#08090D]/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="lc-lbl">Preview</span>
          {map ? (
            <span className="flex gap-3">
              {SECTOR_COLORS.map((c, i) => (
                <span key={c} className="inline-flex items-center gap-1.5 font-f1-mono text-[10px] font-extrabold" style={{ color: c }}>
                  <span className="h-1 w-2.5 rounded-full" style={{ background: c }} />S{i + 1}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {map ? (
          <TrackOutline map={map} sectors className="h-auto max-h-[340px] w-full" label={`${active.name} layout by sector`} />
        ) : (
          <span className="lc-title text-[18px] leading-tight">{active.name}</span>
        )}
        <dl className="m-0 grid grid-cols-2 gap-3 min-[420px]:grid-cols-4">
          {stats.map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-col gap-1">
              <dt className="lc-lbl text-[10px]">{k}</dt>
              <dd className="lc-data m-0 truncate text-[18px] text-[#F5F7FA]">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 flex items-start gap-2.5 text-[13px] leading-normal text-[#C5CBD8]">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[#00E5FF]" strokeWidth={2} />
          Switching reloads the scene; multiplayer peers must pick the same circuit.
        </p>
      </div>
    </div>
  );
};

const TAKEDOWN_URL = "https://github.com/KhazP/librecorsa/issues/new?template=takedown-request.yml";

const CreditRow: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-2 border-t border-[#262B3D] py-4">
    <span className="lc-title text-[16px] text-[#F5F7FA]">{title}</span>
    <p className="m-0 text-[14px] leading-relaxed text-[#C5CBD8]">{children}</p>
  </div>
);

const Credits: React.FC = () => (
  <div className="flex flex-col gap-[18px]">
    <p className="m-0 max-w-[760px] text-[18px] leading-snug font-semibold text-[#F5F7FA] sm:text-[22px]">
      <span className="text-[#CCFF00]">LibreCorsa</span> is an open-source, multi-class browser racing simulator built for
      everyone — featuring Formula prototypes, GT3 machinery, and an open circuit pipeline.
    </p>

    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-x-8">
      <div>
        <CreditRow title="Physics & dynamics">
          500 Hz 6-DOF rigid-body solver, Pacejka Magic Formula &amp; normalized-slip tyre models with 9-node thermal
          dynamics, active aerodynamics, and hybrid ERS.
        </CreditRow>
        <CreditRow title="Graphics & audio">
          WebGL2 PBR rendering with GPU tyre deformation, golden-hour lighting and multi-layer Web Audio synthesis.
        </CreditRow>
      </div>
      <div>
        <CreditRow title="3D car models">
          2026 Formula car model (
          <a href="https://skfb.ly/pKNCK" target="_blank" rel="noreferrer" className={linkClass}>
            skfb.ly/pKNCK
          </a>
          ) by DeX ·{" "}
          <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={linkClass}>
            CC BY 4.0
          </a>
          <br />
          &ldquo;2020 Mercedes-Benz AMG GT3&rdquo; (
          <a href="https://skfb.ly/pOTPL" target="_blank" rel="noreferrer" className={linkClass}>
            skfb.ly/pOTPL
          </a>
          ) by Ddiaz Design · CC BY-NC-SA 4.0
        </CreditRow>
        {TRACKS.some((t) => t.credit) ? (
          <CreditRow title="Circuits">
            {TRACKS.filter((t) => t.credit).map((t) => (
              <React.Fragment key={t.id}>
                &ldquo;{t.credit!.title}&rdquo; (
                <a href={t.credit!.short ?? t.credit!.url} target="_blank" rel="noreferrer" className={linkClass}>
                  {(t.credit!.short ?? t.credit!.url).replace(/^https?:\/\//, "")}
                </a>
                ) by {t.credit!.author} ·{" "}
                <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={linkClass}>
                  CC BY 4.0
                </a>
                <br />
              </React.Fragment>
            ))}
            Converted for the simulator (rescaled, recentred, textures re-encoded, physics colliders added).
          </CreditRow>
        ) : null}
      </div>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] border border-[#262B3D] bg-[#08090D]/60 px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex max-w-[600px] min-w-0 flex-col gap-1">
        <span className="lc-title text-[16px] text-[#F5F7FA]">Rights holders &amp; takedown</span>
        <p className="m-0 text-[13px] leading-relaxed text-[#C5CBD8]">
          If you made a model, texture, sound or other asset used here and it is uncredited, credited wrongly, under the
          wrong license, or not meant to be in LibreCorsa, let us know — it will be fixed or removed, usually within 7 days.
        </p>
      </div>
      <a
        href={TAKEDOWN_URL}
        target="_blank"
        rel="noopener noreferrer"
        onPointerEnter={focusOnHover}
        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-[#00E5FF]/45 bg-[#00E5FF]/10 px-4 text-[14px] font-bold text-[#F5F7FA] no-underline outline-none transition-[background-color,border-color,box-shadow,color] duration-200 hover:border-[#CCFF00] hover:bg-[#CCFF00] hover:text-[#08090D] focus:border-[#CCFF00] focus:bg-[#CCFF00] focus:text-[#08090D] focus:shadow-[0_0_0_5px_rgba(204,255,0,0.12)]"
      >
        <span>Rights / takedown request</span>
        <ExternalLink aria-hidden className="h-4 w-4 shrink-0" strokeWidth={2.2} />
      </a>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D] pt-3.5">
      <p className="m-0 max-w-[620px] text-[13px] leading-relaxed text-[#8E96AA]">
        Built with Next.js, React, Three.js and Tailwind CSS. Source code licensed under MIT; 3D and audio assets are for
        non-commercial educational use only.
      </p>
      <span className="flex gap-[3px]" aria-hidden>
        <span className="h-[5px] w-[18px] rounded-full bg-[#CCFF00]" />
        <span className="h-[5px] w-[18px] rounded-full bg-[#00E5FF]" />
        <span className="h-[5px] w-[18px] rounded-full bg-[#FF2A3C]" />
      </span>
    </div>
  </div>
);

/**
 * The frosted sheet an open panel sits on, with its heading and a Close button. `.lc-title-frame` lets the
 * shared panels (also shown in the pause menu) switch their cards to the inset look of this sheet.
 */
const PanelFrame: React.FC<{
  kicker?: string;
  kickerColor?: string;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ kicker, kickerColor = "#00E5FF", title, onClose, children }) => {
  const { mode, family } = useInputMode();
  return (
    <div className="lc-title-frame lc-glass flex min-w-0 flex-col gap-[18px] rounded-[28px] p-5 text-[#F5F7FA] sm:px-7 sm:pt-6 sm:pb-[26px]">
      {title ? (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            {kicker ? (
              <span className="lc-lbl" style={{ color: kickerColor }}>
                {kicker}
              </span>
            ) : null}
            <h2 className="lc-disp m-0 text-[34px] sm:text-[44px]">{title}</h2>
          </div>
          {/* A pointer / touch affordance: a controller steps back with Ⓑ, so the focus skips it */}
          <button
            type="button"
            data-nav-skip
            onClick={onClose}
            className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-[#262B3D] bg-[#08090D]/60 pr-3.5 pl-2 text-[13px] font-bold text-[#C5CBD8] transition-colors hover:border-[#3A4157] hover:text-[#F5F7FA]"
          >
            {mode === "pad" ? <PadGlyph button="b" family={family} /> : <KeyCap>ESC</KeyCap>}
            Close
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
};

interface MenuItem {
  id: string;
  label: string;
  detail: string;
  icon: LucideIcon;
  run: () => void;
  panel?: TitlePanel;
  primary?: boolean;
  badge?: string;
}

/** Shared by every menu entry: the highlight follows the focus (controller, arrows, or the hovering mouse) */
const ENTRY_FOCUS =
  "group cursor-pointer border-0 text-left text-[#F5F7FA] outline-none transition-[background-color,box-shadow,color] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] focus:bg-[#CCFF00] focus:text-[#08090D] focus:shadow-[0_0_0_5px_rgba(204,255,0,0.12)] focus-visible:outline-none";
const ENTRY_ICON = "shrink-0 text-[#8E96AA] group-focus:text-[#08090D]";
const ENTRY_DETAIL = "truncate text-[#8E96AA] group-focus:font-semibold group-focus:text-[#08090D]/75";

const Badge: React.FC<{ children: React.ReactNode; small?: boolean }> = ({ children, small }) => (
  <span
    className={`inline-flex shrink-0 items-center rounded-full bg-[#00E5FF] font-f1-mono font-extrabold tracking-[0.06em] text-[#08090D] uppercase not-italic group-focus:bg-[#08090D] group-focus:text-[#CCFF00] ${
      small ? "h-5 px-[7px] text-[9px]" : "h-5 px-2 text-[10px]"
    }`}
  >
    {children}
  </span>
);

/** Drive, the screen's main action: the big volt card of the title screen */
const DriveHero: React.FC<{ item: MenuItem; pad: boolean; family: "xbox" | "playstation" }> = ({ item, pad, family }) => (
  <button
    type="button"
    data-rail-id={item.id}
    data-nav-default=""
    onPointerEnter={focusOnHover}
    onClick={item.run}
    className={`${ENTRY_FOCUS} relative flex min-h-[92px] w-full items-center gap-[18px] rounded-[28px] bg-[#CCFF00]/[0.06] py-3.5 pr-6 pl-4 shadow-[inset_0_0_0_1.5px_rgba(204,255,0,0.35)] hover:bg-[#CCFF00]/[0.1] focus:shadow-[0_0_0_6px_rgba(204,255,0,0.12),0_18px_48px_rgba(204,255,0,0.22)] compact:min-h-[76px] compact:gap-4 compact:rounded-[24px] compact:pr-5 short:min-h-[64px]`}
  >
    <span className="inline-flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full bg-[#CCFF00] text-[#08090D] transition-colors group-focus:bg-[#08090D] group-focus:text-[#CCFF00] compact:h-12 compact:w-12 short:h-10 short:w-10">
      <Play aria-hidden className="ml-0.5 h-6 w-6 compact:h-5 compact:w-5" fill="currentColor" strokeWidth={0} />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="lc-disp text-[50px] compact:text-[38px] short:text-[30px]">{item.label}</span>
      <span className={`${ENTRY_DETAIL} text-[15px] font-semibold compact:text-[14px]`}>{item.detail}</span>
    </span>
    <span className="hidden shrink-0 sm:inline-flex">
      {pad ? (
        <PadGlyph button="a" family={family} />
      ) : (
        <span className="inline-flex h-7 items-center rounded-full px-2.5 font-f1-mono text-[11px] font-extrabold tracking-[0.08em] text-[#CCFF00] shadow-[inset_0_0_0_1px_rgba(204,255,0,0.4)] group-focus:bg-[#08090D] group-focus:shadow-none">
          ENTER
        </span>
      )}
    </span>
  </button>
);

/** Race AI / Multiplayer on the title screen */
const MainEntry: React.FC<{ item: MenuItem }> = ({ item }) => {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-rail-id={item.id}
      onPointerEnter={focusOnHover}
      onClick={item.run}
      aria-expanded={item.panel ? false : undefined}
      className={`${ENTRY_FOCUS} flex min-h-[64px] w-full items-center gap-4 rounded-[22px] bg-transparent py-2 pr-5 pl-[22px] hover:bg-white/[0.04] compact:min-h-[56px] short:min-h-[48px]`}
    >
      <Icon aria-hidden className={`${ENTRY_ICON} h-6 w-6`} strokeWidth={2} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2.5">
          <span className="lc-disp text-[30px] compact:text-[24px]">{item.label}</span>
          {item.badge ? <Badge>{item.badge}</Badge> : null}
        </span>
        <span className={`${ENTRY_DETAIL} text-[14px]`}>{item.detail}</span>
      </span>
    </button>
  );
};

/** The two-column setup grid of the title screen (circuit, garage, controls, display) */
const GridEntry: React.FC<{ item: MenuItem }> = ({ item }) => {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-rail-id={item.id}
      onPointerEnter={focusOnHover}
      onClick={item.run}
      aria-expanded={item.panel ? false : undefined}
      className={`${ENTRY_FOCUS} flex min-h-[56px] min-w-0 items-center gap-3 rounded-[18px] bg-transparent py-1.5 pr-3.5 pl-[22px] hover:bg-white/[0.04] compact:pl-4`}
    >
      <Icon aria-hidden className={`${ENTRY_ICON} h-5 w-5`} strokeWidth={2} />
      <span className="flex min-w-0 flex-col">
        <span className="lc-title text-[18px] leading-[1.1]">{item.label}</span>
        <span className={`${ENTRY_DETAIL} text-[12px]`}>{item.detail}</span>
      </span>
    </button>
  );
};

/** Lap times / Credits / Request: the quiet text links under the grid */
const LinkEntry: React.FC<{ item: MenuItem }> = ({ item }) => {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-rail-id={item.id}
      onPointerEnter={focusOnHover}
      onClick={item.run}
      aria-expanded={item.panel ? false : undefined}
      className={`${ENTRY_FOCUS} inline-flex min-h-[44px] items-center gap-2 rounded-full bg-transparent px-3 text-[14px] font-semibold text-[#C5CBD8] hover:bg-white/[0.04] hover:text-[#F5F7FA]`}
    >
      <Icon aria-hidden className={`${ENTRY_ICON} h-4 w-4`} strokeWidth={2} />
      {item.label}
    </button>
  );
};

/** The slim rail beside an open panel: the open entry keeps a cyan edge */
const CompactEntry: React.FC<{ item: MenuItem; open: boolean; quiet?: boolean }> = ({ item, open, quiet }) => {
  const Icon = item.icon;
  if (item.primary) {
    return (
      <button
        type="button"
        data-rail-id={item.id}
        data-nav-default=""
        onPointerEnter={focusOnHover}
        onClick={item.run}
        className={`${ENTRY_FOCUS} mb-1.5 flex min-h-[54px] w-full items-center gap-3 rounded-[16px] bg-transparent px-3.5 hover:bg-white/[0.04]`}
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#CCFF00] text-[#08090D] group-focus:bg-[#08090D] group-focus:text-[#CCFF00]">
          <Play aria-hidden className="ml-px h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
        </span>
        <span className="lc-disp text-[26px]">{item.label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-rail-id={item.id}
      onPointerEnter={focusOnHover}
      onClick={item.run}
      aria-expanded={item.panel ? open : undefined}
      className={`${ENTRY_FOCUS} flex min-h-[44px] w-full items-center gap-3 rounded-[14px] px-3.5 ${
        open ? "bg-[#00E5FF]/[0.08] shadow-[inset_0_0_0_1px_rgba(0,229,255,0.4)]" : "bg-transparent hover:bg-white/[0.04]"
      }`}
    >
      <Icon
        aria-hidden
        className={`h-[18px] w-[18px] shrink-0 group-focus:text-[#08090D] ${open ? "text-[#00E5FF]" : "text-[#8E96AA]"}`}
        strokeWidth={2}
      />
      <span
        className={`lc-title min-w-0 flex-1 truncate text-[15px] tracking-[0.02em] ${quiet && !open ? "text-[#C5CBD8] group-focus:text-[#08090D]" : ""}`}
      >
        {item.label}
      </span>
      {item.badge ? <Badge small>{item.badge}</Badge> : null}
      {open ? (
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[#00E5FF] shadow-[0_0_10px_#00E5FF] group-focus:hidden" />
      ) : null}
    </button>
  );
};

/** Controller / wheel / keyboard status pill */
const DevicePill: React.FC<{ pad: PadState | undefined; slim?: boolean }> = ({ pad, slim }) => {
  const kind = pad ? (isLikelyWheel(pad) ? "Wheel" : "Controller") : "Keyboard";
  const name = pad ? padDisplayName(pad.id).slice(0, 40) : "Press any button on a controller or wheel";
  if (slim) {
    return (
      <div className="inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full border border-[#262B3D] bg-[#11131A]/70 px-3.5 font-f1-mono text-[11px] font-bold tracking-[0.12em] text-[#C5CBD8] uppercase backdrop-blur">
        <span className={`h-2 w-2 shrink-0 rounded-full ${pad ? "bg-[#CCFF00]" : "bg-[#8E96AA]"}`} />
        <span className="truncate">
          {kind}
          <span className="hidden sm:inline"> · {name}</span>
        </span>
      </div>
    );
  }
  const Icon = pad ? Gamepad2 : Keyboard;
  return (
    <div className="inline-flex h-9 max-w-full min-w-0 items-center gap-2 rounded-full border border-[#262B3D] bg-[#11131A]/70 py-0 pr-3.5 pl-1.5 font-f1-mono text-[11px] font-bold tracking-[0.12em] text-[#C5CBD8] uppercase backdrop-blur">
      <span
        className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-extrabold ${
          pad ? "bg-[#CCFF00] text-[#08090D]" : "bg-[#1B1F2B] text-[#F5F7FA]"
        }`}
      >
        <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={2.4} />
        {kind}
      </span>
      <span className="hidden truncate sm:inline">{name}</span>
    </div>
  );
};

/**
 * Title menu shown on every launch, over the live 3D grid (attract camera). The rail sits left so the car
 * stays in shot on the right; panels open beside it. A controller moves through every control
 * (rail, panel, sliders), LB / RB switch panels and Ⓑ steps back out.
 */
export const TitleMenu: React.FC<TitleMenuProps> = (props) => {
  const { firstRun, onDrive, onRaceAi, onControls, trackId = RWANDA_TRACK_ID, onSelectTrack } = props;
  const track = getTrackInfo(trackId);
  const [panel, setPanel] = useState<TitlePanel | null>(props.initialPanel ?? null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const { mode, family } = useInputMode();

  const focusRail = (id: string) => {
    rootRef.current?.querySelector<HTMLElement>(`[data-rail-id="${id}"]`)?.focus({ preventScroll: true });
  };

  // The title screen and the panel view draw the rail differently: keep the focus on its entry across the switch
  const keepFocus = (id: string) => {
    if (!rootRef.current?.contains(document.activeElement)) focusRail(id);
  };

  // Below lg the panel opens under the rail, usually off-screen: render it now and bring it into view
  const openPanel = (next: TitlePanel) => {
    flushSync(() => setPanel(next));
    keepFocus(next);
    if (window.matchMedia("(min-width: 64rem)").matches) return;
    // Instant: the tap's own touch gesture would cancel a smooth scroll
    panelRef.current?.scrollIntoView({ block: "start" });
  };

  const closePanel = () => {
    const from = document.activeElement?.closest("[data-rail-id]")?.getAttribute("data-rail-id") ?? panel;
    flushSync(() => setPanel(null));
    if (from) focusRail(from);
  };

  const pads = useGamepads();
  const pad = pads[0];
  const lobbyPlayers = props.lobby?.players.length ?? 0;

  // Outline of the active circuit (the scene's): only once its data is the loaded track
  const activeTrackId = ACTIVE_TRACK_ID;
  const map = useMemo(() => (activeTrackId === trackId ? buildHudMap(getTrackData()) : null), [activeTrackId, trackId]);

  const items: MenuItem[] = [
    {
      id: "drive",
      label: "Drive",
      detail: firstRun ? "Quick setup, then out on track" : "Practice from the grid",
      icon: Play,
      run: onDrive,
      primary: true,
    },
    { id: "race", label: "Race AI", detail: `5 AI cars · ${aiSkillLabel(props.aiSkill ?? AI_SKILL_DEFAULT)} · standing start`, icon: Flag, run: onRaceAi },
    {
      id: "multiplayer",
      label: "Multiplayer",
      detail: "Race friends peer-to-peer",
      icon: Users,
      panel: "multiplayer",
      run: () => openPanel("multiplayer"),
      badge: lobbyPlayers > 1 ? `${lobbyPlayers} in lobby` : undefined,
    },
    {
      id: "circuit",
      label: "Circuit",
      detail: `${track.name} · ${km(track)} km`,
      icon: Route,
      panel: "circuit",
      run: () => openPanel("circuit"),
    },
    ...(props.conditionsPanel
      ? [
          {
            id: "conditions",
            label: "Conditions",
            detail: `${WEATHER_LABELS[props.conditionsPanel.conditions.weather].label} · ${TIME_OF_DAY_LABELS[props.conditionsPanel.conditions.timeOfDay]}`,
            icon: CloudSun,
            panel: "conditions" as const,
            run: () => openPanel("conditions"),
          },
        ]
      : []),
    { id: "garage", label: "Garage", detail: "Engineer's garage: car, setup and presets", icon: Wrench, panel: "garage", run: () => openPanel("garage") },
    ...(props.leaderboardPanel
      ? [{ id: "leaderboard", label: "Lap times", detail: "Leaderboard and ghosts", icon: Timer, panel: "leaderboard" as const, run: () => openPanel("leaderboard") }]
      : []),
    ...(props.displayPanel
      ? [{ id: "display", label: "Display", detail: "HUD, graphics, touch, VR", icon: MonitorCog, panel: "display" as const, run: () => openPanel("display") }]
      : []),
    { id: "controls", label: "Controls", detail: "Keyboard, controller or wheel", icon: Gamepad2, run: onControls },
    { id: "credits", label: "Credits", detail: "Open-source sim · asset sources", icon: Info, panel: "credits", run: () => openPanel("credits") },
    {
      id: "request",
      label: "Request a car or track",
      detail: "Suggest new content",
      icon: MessageSquarePlus,
      panel: "request",
      run: () => openPanel("request"),
    },
  ];
  const panelItems = items.filter((i) => i.panel);
  const byId = (ids: readonly string[]) => ids.flatMap((id) => items.filter((i) => i.id === id));

  // Ⓑ: out of the panel to its rail entry, then close the panel
  const back = () => {
    if (panel && focusInZone(rootRef.current, "panel")) return focusRail(panel);
    if (panel) closePanel();
  };
  // LB / RB: the neighbouring panel, with the focus on its rail entry
  const cycle = (step: number) => {
    const i = panelItems.findIndex((p) => p.panel === panel);
    const next = panelItems[(i + step + panelItems.length) % panelItems.length] ?? panelItems[0];
    if (!next?.panel) return;
    flushSync(() => setPanel(next.panel!));
    focusRail(next.id);
  };
  useFocusNav(rootRef, { onBack: back, onPrevTab: () => cycle(-1), onNextTab: () => cycle(1) });

  const panelTitle = items.find((i) => i.panel === panel)?.label;
  const frameHeading: Record<TitlePanel, { kicker: string; color?: string }> = {
    circuit: { kicker: "Circuit selection" },
    conditions: { kicker: "Weather, time of day and realism", color: "#00E5FF" },
    garage: { kicker: "Engineer's garage · setup, presets and livery" },
    multiplayer: { kicker: "WebRTC peer-to-peer" },
    leaderboard: { kicker: `Leaderboard · ${props.leaderboardPanel?.trackName ?? track.name}`, color: "#CCFF00" },
    display: { kicker: "HUD, graphics, touch, VR" },
    credits: { kicker: "About LibreCorsa & credits" },
    request: { kicker: "Suggest new content" },
  };

  const vehicle = carById(props.carId);
  const vehicleColor = carClass(vehicle.classId).color;
  const livery = props.selectedLivery;
  const hudPreset = props.displayPanel?.settings.hud.preset;
  const kicker = `${track.name} · ${track.country} · ${km(track)} KM`;

  return (
    <div
      ref={rootRef}
      className={`pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-10 ${
        panel
          ? "bg-[linear-gradient(90deg,rgba(8,9,13,0.97)_0%,rgba(8,9,13,0.9)_60%,rgba(8,9,13,0.4)_85%)] pt-7 short:pt-4"
          : "bg-[linear-gradient(90deg,rgba(8,9,13,0.97)_0%,rgba(8,9,13,0.86)_30%,rgba(8,9,13,0.2)_58%,rgba(8,9,13,0)_70%)] pt-[clamp(1.5rem,3.6vh,2.5rem)] max-lg:bg-[#08090D]/80 short:pt-4"
      }`}
    >
      <div className={`flex w-full flex-1 flex-col ${panel ? "gap-[22px]" : "gap-[clamp(20px,3vh,32px)]"} short:gap-4`}>
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          {panel ? (
            <>
              <LibreCorsaLogo variant="compact" size="sm" />
              <DevicePill pad={pad} slim />
            </>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-x-[22px] gap-y-3">
                <LibreCorsaLogo variant="compact" size="md" />
                <div className="inline-flex h-8 max-w-full min-w-0 items-center gap-2.5 rounded-full border border-[#262B3D] bg-[#11131A]/70 px-3.5 font-f1-mono text-[11px] font-bold tracking-[0.14em] text-[#CCFF00] uppercase backdrop-blur">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="lc-ping absolute inline-flex h-full w-full rounded-full bg-[#CCFF00]" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-[#CCFF00]" />
                  </span>
                  <span className="truncate">{kicker}</span>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <DevicePill pad={pad} />
                {props.profile ? (
                  props.displayPanel ? (
                    <button
                      type="button"
                      aria-label="Edit driver profile"
                      onClick={() => openPanel("display")}
                      className="inline-flex h-9 cursor-pointer items-center gap-2.5 rounded-full border border-[#262B3D] bg-[#11131A]/70 py-0 pr-3.5 pl-2 text-[#F5F7FA] backdrop-blur transition-colors hover:border-[#3A4157]"
                    >
                      <span
                        className="h-[22px] w-[22px] shrink-0 rounded-full shadow-[inset_0_0_0_2px_rgba(255,255,255,0.25)]"
                        style={{ background: props.profile.color }}
                      />
                      <span className="font-f1-mono text-[12px] font-extrabold tracking-[0.12em]">{props.profile.code}</span>
                      <span className="hidden max-w-[10rem] truncate text-[14px] font-semibold text-[#C5CBD8] sm:inline">
                        {props.profile.name}
                      </span>
                    </button>
                  ) : (
                    <span className="inline-flex h-9 items-center gap-2.5 rounded-full border border-[#262B3D] bg-[#11131A]/70 py-0 pr-3.5 pl-2 backdrop-blur">
                      <span className="h-[22px] w-[22px] shrink-0 rounded-full" style={{ background: props.profile.color }} />
                      <span className="font-f1-mono text-[12px] font-extrabold tracking-[0.12em]">{props.profile.code}</span>
                    </span>
                  )
                ) : null}
              </div>
            </>
          )}
        </header>

        {panel ? (
          /* Panel view: slim rail + the panel's sheet */
          <div className="grid flex-1 grid-cols-1 items-start gap-5 lg:grid-cols-[250px_minmax(0,1000px)] lg:gap-7">
            <nav className="flex flex-col gap-0.5" data-nav-zone="rail" aria-label="Main menu">
              {byId(["drive", "race", "multiplayer"]).map((item) => (
                <CompactEntry key={item.id} item={item} open={item.panel === panel} />
              ))}
              <div aria-hidden className="mx-3.5 my-2 h-px bg-[#262B3D]" />
              {byId(["circuit", "conditions", "garage", "leaderboard", "display", "controls"]).map((item) => (
                <CompactEntry key={item.id} item={item} open={item.panel === panel} />
              ))}
              <div aria-hidden className="mx-3.5 my-2 h-px bg-[#262B3D]" />
              {byId(["credits", "request"]).map((item) => (
                <CompactEntry key={item.id} item={item} open={item.panel === panel} quiet />
              ))}
            </nav>

            <section ref={panelRef} className="min-h-0 min-w-0 scroll-mt-4" data-nav-zone="panel" aria-label={panelTitle}>
              <div key={panel} className="lc-panel-in">
                <PanelFrame
                  kicker={frameHeading[panel].kicker}
                  kickerColor={frameHeading[panel].color}
                  title={panel === "request" ? undefined : panelTitle}
                  onClose={closePanel}
                >
                  {panel === "circuit" ? <CircuitPanel trackId={trackId} onSelect={onSelectTrack} map={map} /> : null}
                  {panel === "conditions" && props.conditionsPanel ? <ConditionsPanel {...props.conditionsPanel} /> : null}
                  {panel === "garage" ? <EngineersGarage {...props} /> : null}
                  {panel === "multiplayer" ? <MultiplayerPanel {...props} /> : null}
                  {panel === "leaderboard" && props.leaderboardPanel ? <LeaderboardPanel {...props.leaderboardPanel} /> : null}
                  {panel === "display" && props.displayPanel ? <DisplayPanel {...props.displayPanel} /> : null}
                  {panel === "credits" ? <Credits /> : null}
                  {panel === "request" ? <RequestPanel /> : null}
                </PanelFrame>
              </div>
            </section>
          </div>
        ) : (
          /* Title screen: the menu bottom-left, what Drive launches bottom-right */
          <main className="flex flex-1 flex-wrap items-end justify-between gap-8 compact:items-start short:gap-5">
            <nav className="flex w-full max-w-[460px] flex-col gap-1.5" data-nav-zone="rail" aria-label="Main menu">
              {byId(["drive"]).map((item) => (
                <DriveHero key={item.id} item={item} pad={mode === "pad"} family={family} />
              ))}
              {byId(["race", "multiplayer"]).map((item) => (
                <MainEntry key={item.id} item={item} />
              ))}
              <div className="mt-[18px] mb-1 ml-[22px] flex items-center gap-2.5 compact:mt-3 short:mt-2">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#CCFF00]" />
                <span className="lc-lbl">Setup</span>
              </div>
              <div className="grid grid-cols-1 gap-1 min-[400px]:grid-cols-2">
                {byId(["circuit", "conditions", "garage", "controls", "display"]).map((item) => (
                  <GridEntry key={item.id} item={item} />
                ))}
              </div>
              <div className="mt-3.5 ml-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 short:mt-2">
                {byId(["leaderboard", "credits", "request"]).map((item) => (
                  <LinkEntry key={item.id} item={item} />
                ))}
              </div>
            </nav>

            <section
              aria-label="Up next"
              className="lc-glass lc-drift flex w-full max-w-[340px] flex-col gap-4 rounded-[26px] p-5 text-[#F5F7FA] short:hidden"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="lc-lbl">Up next · Practice</span>
                <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.12em] text-[#CCFF00] uppercase">
                  {track.direction}
                </span>
              </div>
              <div className="flex items-center gap-4">
                {map ? <TrackOutline map={map} className="h-[92px] w-[112px] shrink-0" /> : null}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="lc-title text-[18px] leading-[1.05]">{track.name}</span>
                  <span className="text-[13px] text-[#8E96AA]">
                    {track.layout} · {track.city}
                  </span>
                  <span className="font-f1-mono text-[12px] font-bold text-[#C5CBD8]">
                    {km(track)} KM · {track.turns} TURNS
                  </span>
                </div>
              </div>
              <div className="h-px bg-[#262B3D]" />
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">
                {vehicle ? (
                  <>
                    <dt className="lc-lbl text-[10px]">Car</dt>
                    <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-[14px] font-semibold">
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 font-f1-mono text-[9px] font-extrabold text-[#08090D]"
                        style={{ background: vehicleColor }}
                      >
                        {vehicle.badge}
                      </span>
                      <span className="truncate">{vehicle.title}</span>
                    </dd>
                  </>
                ) : null}
                {livery ? (
                  <>
                    <dt className="lc-lbl text-[10px]">Livery</dt>
                    <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-[14px] font-semibold">
                      <span
                        aria-hidden
                        className="h-3 w-7 shrink-0 rounded-full"
                        style={{
                          background: `linear-gradient(135deg, ${livery.primary} 0 50%, ${livery.secondary} 50% 62%, ${livery.accent} 62% 100%)`,
                        }}
                      />
                      <span className="truncate">{livery.name}</span>
                    </dd>
                  </>
                ) : null}
                <dt className="lc-lbl text-[10px]">Assists</dt>
                <dd className="m-0 truncate text-right text-[14px] font-semibold">
                  {ASSIST_LABELS[props.assistPreset] ?? props.assistPreset}
                  {props.showRacingLine ? " · racing line" : ""}
                </dd>
                {hudPreset ? (
                  <>
                    <dt className="lc-lbl text-[10px]">HUD</dt>
                    <dd className="m-0 truncate text-right text-[14px] font-semibold">{HUD_LABELS[hudPreset] ?? hudPreset}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          </main>
        )}

        {/* Prompts */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D]/70 pt-3">
          <PromptBar
            prompts={[
              { action: "move", label: "Move" },
              { action: "select", label: "Select" },
              ...(panel ? [{ action: "back" as const, label: panelTitle ? `Close ${panelTitle}` : "Back" }] : []),
              { action: "tabs", label: "Switch panel" },
            ]}
          />
          <span className="font-f1-mono text-[11px] font-bold tracking-[0.12em] text-[#8E96AA]">
            {(TRACK_TOTAL_LENGTH_M / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS
            {panel ? null : <span className="hidden text-[#CCFF00]/80 xl:inline"> · 500 HZ VEHICLE DYNAMICS</span>}
          </span>
        </footer>
      </div>
    </div>
  );
};
