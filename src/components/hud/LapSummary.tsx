"use client";

import { activeLapWord } from "@/lib/track-data";
import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUiZoom } from "@/lib/ui-zoom";
import { useUnits } from "@/lib/settings/ui-prefs";
import { SPEED_LABEL, speedIn } from "@/lib/settings/units";
import type { UnitSettings } from "@/lib/settings/player-settings";
import type { CornerStat, LapSummaryData } from "@/lib/sim/lap-types";
import { Button, IconButton, TextField, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { DeltaBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import {
  HUD_CAUTION,
  HUD_GAIN,
  LAP_MARK_COLOR,
  LAP_MARK_WORD,
  formatLapTime,
  formatSectorTime,
  lapMark,
  type LapMark,
} from "./hud-format";
import { SkinBanner, SkinButton, skinCss, SkinPanel, skinRootClass, SkinTag, type SkinTone, useHudSkin } from "./styles/third-party-skin";
import { useHudMode } from "./hud-mode";

const EMPTY = "-";
const MINUS = "−";
/** Bar colour for a corner with no change (or no reference yet) */
const SAME = "var(--color-lc-keyline)";

/** Corner delta vs the best minimum speed, in the player's unit: green faster, amber slower, dash with no reference */
function cornerDelta(c: CornerStat, u: UnitSettings): { text: string; color: string; bar: string; word: string } {
  if (c.bestMinSpeedKmh === null) return { text: EMPTY, color: "var(--color-lc-slate)", bar: SAME, word: "no reference yet" };
  const d = speedIn(c.minSpeedKmh, u.speed) - speedIn(c.bestMinSpeedKmh, u.speed);
  if (Math.abs(d) < 0.05) return { text: "0.0", color: "var(--color-lc-slate)", bar: SAME, word: "same as best" };
  return d > 0
    ? { text: `+${d.toFixed(1)}`, color: HUD_GAIN, bar: HUD_GAIN, word: "faster than best" }
    : { text: `${MINUS}${Math.abs(d).toFixed(1)}`, color: HUD_CAUTION, bar: HUD_CAUTION, word: "slower than best" };
}

/** A speed in km/h as a whole number in the player's unit */
const speed = (kmh: number, u: UnitSettings) => Math.round(speedIn(kmh, u.speed));

interface LapSummaryProps {
  summary: LapSummaryData;
  onClose: () => void;
  onSaveGhost?: () => void;
  /** Uploads the lap by hand (automatic posting off, or a retry); without it the card only shows how the upload went */
  onSubmit?: () => void;
  /** `waiting`: the board couldn't be reached, and the lap goes up by itself once it can */
  submitState?: "idle" | "sending" | "sent" | "error" | "waiting";
  /** Place of the uploaded lap on its online board, and how many drivers that board has */
  submitRank?: { rank: number; total: number | null; challengeRank?: number | null } | null;
  /** Why the board refused the last upload (e.g. the name is taken), or that it couldn't be reached, shown under the buttons */
  submitError?: string | null;
  /** The name the driver's laps go up under, shown once one went up (or was turned down) */
  driverName?: string;
  /** Changes the driver's name on the board (their laps move with it): null once it has taken, else why not */
  onRename?: (name: string) => Promise<string | null>;
}

/** Gap between the toast and the HUD block it clears (px) */
const LIFT_GAP = 10;

/**
 * Bottom offset (px) that puts the toast above every HUD block under it, the elements marked
 * `data-hud-avoid` (the Live Tuner MFD, a speed cluster, a style's pod), re-checked while it is up
 * since the MFD opens and closes. Null on touch screens, where the toast sits at the top instead.
 */
function useLiftOverHud(boxRef: React.RefObject<HTMLDivElement | null>): number | null {
  const [lift, setLift] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      if (!box || window.matchMedia("(pointer: coarse)").matches) {
        setLift(null);
        return;
      }
      const { left, right } = box.getBoundingClientRect();
      const vh = window.innerHeight;
      let clear = 16;
      for (const el of document.querySelectorAll<HTMLElement>("[data-hud-avoid]")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right <= left || r.left >= right) continue;
        clear = Math.max(clear, vh - r.top + LIFT_GAP);
      }
      // Never push the toast off the top of a short window
      const next = Math.round(Math.min(clear, vh * 0.6));
      setLift((prev) => (prev === next ? prev : next));
    };
    measure();
    const id = window.setInterval(measure, 400);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", measure);
    };
  }, [boxRef]);
  return lift;
}

/** How long the collapsed toast stays up before it clears itself */
const TOAST_MS = 12_000;

/**
 * Post-lap toast, bottom right above the MFD and dash (top centre on touch screens, clear of the on-screen pedals): lap time, status
 * badge and sector colours, out of the way while driving. It clears itself after a few seconds unless the
 * pointer is on it or a submit is in flight. Clicking it opens the full card with sector splits vs the
 * session best, stats and per-corner speeds, which stays until it is collapsed or closed.
 */
export const LapSummary: React.FC<LapSummaryProps> = (props) => {
  const skin = useHudSkin();
  const { summary: s, onClose, submitState = "idle" } = props;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Portalled out of the HUD, so it hides itself while the HUD is hidden (pause menu, replay)
  const hidden = useHudMode() === "hidden";
  // The HUD re-renders every frame with a fresh onClose; the timer must not restart for that
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // A new lap starts collapsed and un-hovered again (the box is re-keyed under a still pointer, which sends no
  // pointerleave)
  useEffect(() => {
    setExpanded(false);
    setHovered(false);
  }, [s.lapNumber]);
  // The pause menu or a replay covers the toast: the pointer is no longer on it
  useEffect(() => {
    if (hidden) setHovered(false);
  }, [hidden]);

  // Hidden, the clock stops: the toast gets its full time again once the HUD is back
  useEffect(() => {
    if (expanded || hovered || hidden || submitState === "sending") return;
    const id = window.setTimeout(() => closeRef.current(), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [expanded, hovered, hidden, submitState, s.lapNumber]);

  // Escape folds the open card back into the toast (not while it is hidden: there Esc resumes the game)
  useEffect(() => {
    if (!expanded || hidden) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc in the card's name field closes the field, not the card
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) setExpanded(false);
    };
    // Capture: ahead of the shell's pause on the same press, which would otherwise hide the HUD (and drop this
    // listener) before it ran
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [expanded, hidden]);

  const boxRef = useRef<HTMLDivElement>(null);
  const lift = useLiftOverHud(boxRef);
  // The box is zoomed on big screens; the lift is in window pixels
  const zoom = useUiZoom();

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      key={s.lapNumber}
      ref={boxRef}
      inert={hidden}
      className={`lc-ui-zoom lc-panel-in pointer-events-auto fixed right-[calc(env(safe-area-inset-right,0px)+0.75rem)] bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] z-(--z-lc-toast) w-[min(440px,calc(100vw-1.5rem))] sm:right-[calc(env(safe-area-inset-right,0px)+1rem)] pointer-coarse:top-[calc(env(safe-area-inset-top,0px)+104px)] pointer-coarse:portrait:top-[calc(env(safe-area-inset-top,0px)+216px)] pointer-coarse:right-auto pointer-coarse:bottom-auto pointer-coarse:left-1/2 pointer-coarse:w-[min(400px,calc(100vw-1.5rem))] pointer-coarse:-translate-x-1/2 ${hidden ? "invisible" : ""} ${skinRootClass(skin) ?? ""}`}
      style={
        lift === null
          ? undefined
          : ({ bottom: lift / zoom, "--lc-room": `calc((100dvh - ${lift + 16}px) / ${zoom})` } as React.CSSProperties)
      }
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        // A button the pointer focused must not take the driver's Space or Enter once the pointer has gone
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement && boxRef.current?.contains(active)) active.blur();
      }}
    >
      {expanded ? (
        <LapCard {...props} onCollapse={() => setExpanded(false)} />
      ) : (
        <>
          <LapToast summary={s} onOpen={() => setExpanded(true)} onClose={onClose} />
          {submitState === "waiting" && props.submitError ? <ToastNote text={props.submitError} /> : null}
        </>
      )}
    </div>,
    document.body
  );
};

/**
 * A personal best wears the colour the HUD gives it (`lapMark`): on your own the session is yours, so it is the
 * session's best (purple), the same as its sectors
 */
const PB_TONE = lapMark(1, null) === "best" ? "best" : "good";

/** The lap's status in the toast: invalid, a personal best, or the gap to the best */
function statusBadge(s: LapSummaryData, skinned = false): React.ReactNode {
  if (skinned) {
    if (!s.valid) {
      return (
        <SkinTag tone="loss" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
          <Icon name="trackLimits" size="xs" />
          Invalid
        </SkinTag>
      );
    }
    if (s.isPersonalBest) {
      return (
        <SkinTag tone={PB_TONE === "best" ? "best" : "gain"} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
          <Icon name="success" size="xs" />
          PB
        </SkinTag>
      );
    }
    if (s.deltaToBestMs === null) return null;
    const d = s.deltaToBestMs / 1000;
    const tone: SkinTone = d <= 0 ? "gain" : "caution";
    return (
      <SkinTag tone={tone} className="px-2 py-0.5 text-[11px] font-bold">
        {d <= 0 ? `${MINUS}${Math.abs(d).toFixed(3)}` : `+${d.toFixed(3)}`}
      </SkinTag>
    );
  }
  if (!s.valid)
    return (
      <Badge tone="bad" size="sm" icon="trackLimits">
        Invalid
      </Badge>
    );
  if (s.isPersonalBest)
    return (
      <Badge tone={PB_TONE} size="sm" icon="success">
        PB
      </Badge>
    );
  if (s.deltaToBestMs === null) return null;
  return <DeltaBadge seconds={s.deltaToBestMs / 1000} size="sm" />;
}

/** Colour and word of a sector against the best (no time: neither) */
function sectorMark(
  ms: number | null | undefined,
  best: number | null | undefined,
): { color: string; word: string; mark: LapMark | null } {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return { color: "var(--color-lc-slate)", word: "", mark: null };
  const mark = lapMark(ms, best);
  return { color: LAP_MARK_COLOR[mark], word: LAP_MARK_WORD[mark], mark };
}

/** Collapsed toast: lap time, status and the three sector colours; the whole card opens the details */
const LapToast: React.FC<{ summary: LapSummaryData; onOpen: () => void; onClose: () => void }> = ({
  summary: s,
  onOpen,
  onClose,
}) => {
  const skin = useHudSkin();
  if (skin !== null) {
    return (
      <SkinPanel
        cut="sm"
        className="ml-auto w-fit max-w-full pointer-coarse:mx-auto"
        innerClassName="flex items-center gap-2 py-1.5 pr-1.5 pl-3.5"
      >
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${activeLapWord()} ${s.lapNumber}: show sector data`}
          className={`flex min-h-9 min-w-0 cursor-pointer items-center gap-3 text-left transition-opacity duration-200 hover:opacity-85 pointer-coarse:min-h-11 sm:gap-3.5 ${skinCss.ink}`}
        >
          <span className={`lc-mono shrink-0 text-[12px] font-bold uppercase ${skinCss.inkDim}`}>
            {activeLapWord()} {s.lapNumber}
          </span>
          <span className={`lc-mono text-[22px] leading-none font-bold sm:text-[24px] ${skinCss.readout}`}>{formatLapTime(s.lapTimeMs)}</span>
          {statusBadge(s, true)}
          <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
            {s.sectorTimesMs.map((t, idx) => {
              const m = sectorMark(t, s.bestSectorTimesMs[idx]);
              return (
                <span
                  key={idx}
                  className={`w-5.5 ${skinCss.radiusSm} ${m.mark === "slower" ? "h-1.5" : "h-2"}`}
                  style={
                    m.mark === "slower"
                      ? { boxShadow: `inset 0 0 0 1.5px ${m.color}` }
                      : { backgroundColor: m.color }
                  }
                />
              );
            })}
          </span>
          <Icon name="next" size="xs" className={`${skinCss.inkDim} max-sm:hidden`} />
        </button>
        <SkinButton onClick={onClose} aria-label="Dismiss lap summary" className="size-8 shrink-0">
          <Icon name="close" size="xs" />
        </SkinButton>
      </SkinPanel>
    );
  }
  return (
    <div className="ml-auto flex w-fit max-w-full items-center gap-2 rounded-full border border-white/7 bg-lc-void/75 py-1.5 pr-1.5 pl-4.5 text-lc-chalk shadow-lc-pop backdrop-blur-[14px] in-data-[phone-hud]:backdrop-blur-none pointer-coarse:mx-auto">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${activeLapWord()} ${s.lapNumber}: show sector data`}
        className="flex min-h-9 min-w-0 pointer-coarse:min-h-11 cursor-pointer items-center gap-3 rounded-full text-left transition-opacity duration-200 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lc-volt sm:gap-3.5"
      >
        <span className="lc-mono shrink-0 text-[12px] font-bold text-lc-slate">
          {activeLapWord()} {s.lapNumber}
        </span>
        <span className="lc-mono text-[22px] leading-none font-bold sm:text-[24px]">{formatLapTime(s.lapTimeMs)}</span>
        {statusBadge(s)}
        {/* Shape as well as colour: a best sector is a solid bar, a slower one an outline */}
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
          {s.sectorTimesMs.map((t, idx) => {
            const m = sectorMark(t, s.bestSectorTimesMs[idx]);
            return (
              <span
                key={idx}
                className={`w-5.5 rounded-full ${m.mark === "slower" ? "h-1.5" : "h-2"}`}
                style={
                  m.mark === "slower"
                    ? { boxShadow: `inset 0 0 0 1.5px ${m.color}` }
                    : { backgroundColor: m.color }
                }
              />
            );
          })}
        </span>
        <Icon name="next" size="xs" className="text-lc-slate max-sm:hidden" />
      </button>
      <IconButton size="sm" variant="ghost" aria-label="Dismiss lap summary" icon={<Icon name="close" />} onClick={onClose} />
    </div>
  );
};

/**
 * Under the toast, in the toast's glass: the lap couldn't reach the online board and goes up once it can. Said here as
 * well as in the card, which is seldom opened
 */
const ToastNote: React.FC<{ text: string }> = ({ text }) => {
  const skin = useHudSkin();
  if (skin !== null) {
    return (
      <SkinBanner
        role="status"
        tone="caution"
        cut="sm"
        className="mt-1.5 ml-auto flex w-fit max-w-full items-center gap-1.5 px-3 py-1 text-[12px] leading-snug font-medium pointer-coarse:mx-auto"
      >
        <Icon name="offline" size="xs" className="shrink-0" />
        {text}
      </SkinBanner>
    );
  }
  return (
    <p
      role="status"
      className="mt-1.5 ml-auto flex w-fit max-w-full items-center gap-1.5 rounded-full border border-white/7 bg-lc-void/75 px-3 py-1 text-[12px] leading-snug font-medium text-lc-amber shadow-lc-pop backdrop-blur-[14px] in-data-[phone-hud]:backdrop-blur-none pointer-coarse:mx-auto"
    >
      <Icon name="offline" size="xs" className="shrink-0" />
      {text}
    </p>
  );
};

/** A read-out inside the card: the value, then the words that say what it is (no label above) */
const Stat: React.FC<{ value: React.ReactNode; label: string; className?: string }> = ({ value, label, className = "" }) => {
  const skin = useHudSkin();
  if (skin !== null) {
    return (
      <div className={`flex min-w-0 flex-col gap-0.5 px-3 py-2.5 short:py-2 ${skinCss.deepBox} ${className}`}>
        <span className={`lc-mono truncate text-[18px] leading-tight font-bold ${skinCss.readout} ${skinCss.ink}`}>{value}</span>
        <span className={`text-[12px] leading-tight text-balance ${skinCss.inkDim}`}>{label}</span>
      </div>
    );
  }
  return (
    <Well className={`flex min-w-0 flex-col gap-0.5 px-3 py-2.5 short:py-2 ${className}`}>
      <span className="lc-mono truncate text-[18px] leading-tight font-bold text-lc-chalk">{value}</span>
      {/* Wraps rather than cuts: "Average km/h" is wider than a quarter of the card */}
      <span className="lc-hint leading-tight text-balance">{label}</span>
    </Well>
  );
};

/** Open card: lap time with status badge, sector splits vs session best, stats, and per-corner speeds */
const LapCard: React.FC<
  LapSummaryProps & {
    onCollapse: () => void;
  }
> = ({
  summary: s,
  onClose,
  onCollapse,
  onSaveGhost,
  onSubmit,
  submitState = "idle",
  submitRank = null,
  submitError = null,
  driverName,
  onRename,
}) => {
  const skin = useHudSkin();
  const units = useUnits();
  const unit = SPEED_LABEL[units.speed];

  let badge: React.ReactNode = null;
  let skinnedBadge: React.ReactNode = null;
  if (!s.valid) {
    badge = (
      <Badge tone="bad" icon="trackLimits">
        {s.wallContact ? "Invalid: wall contact" : "Invalid: track limits"}
      </Badge>
    );
    skinnedBadge = (
      <SkinTag tone="loss" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
        <Icon name="trackLimits" size="xs" />
        {s.wallContact ? "Invalid: wall contact" : "Invalid: track limits"}
      </SkinTag>
    );
  } else if (s.autopilot) {
    badge = (
      <Badge tone="warn" icon="warning">
        Autopilot: not ranked
      </Badge>
    );
    skinnedBadge = (
      <SkinTag tone="caution" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
        <Icon name="warning" size="xs" />
        Autopilot: not ranked
      </SkinTag>
    );
  } else if (s.isPersonalBest) {
    badge = (
      <Badge tone={PB_TONE} icon="success">
        Personal best
      </Badge>
    );
    skinnedBadge = (
      <SkinTag tone={PB_TONE === "best" ? "best" : "gain"} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
        <Icon name="success" size="xs" />
        Personal best
      </SkinTag>
    );
  } else if (s.deltaToBestMs !== null) {
    badge = <DeltaBadge seconds={s.deltaToBestMs / 1000} />;
    const d = s.deltaToBestMs / 1000;
    skinnedBadge = (
      <SkinTag tone={d <= 0 ? "gain" : "caution"} className="px-2 py-0.5 text-[11px] font-bold">
        {d <= 0 ? `${MINUS}${Math.abs(d).toFixed(3)} s` : `+${d.toFixed(3)} s`}
      </SkinTag>
    );
  }

  const sentLabel =
    submitRank != null
      ? `Online: P${submitRank.rank}${submitRank.total ? ` of ${submitRank.total}` : ""}${submitRank.challengeRank ? `, P${submitRank.challengeRank} this week` : ""}`
      : "Online";
  const notRanked = !s.valid ? "Invalid laps don't go online" : s.autopilot ? "Laps on autopilot aren't ranked" : undefined;

  const stats: { label: string; value: string }[] = [
    { label: `Top ${unit}`, value: `${speed(s.topSpeedKmh, units)}` },
    { label: `Avg ${unit}`, value: `${speed(s.avgSpeedKmh, units)}` },
    { label: "Full throttle", value: `${s.fullThrottlePct.toFixed(0)}%` },
    { label: "Braking", value: `${s.brakingPct.toFixed(0)}%` },
  ];

  if (skin !== null) {
    return (
      <SkinPanel
        cut="lg"
        role="dialog"
        aria-label={`Lap ${s.lapNumber} summary`}
        className="w-full"
        innerClassName="flex max-h-[min(calc(100dvh-9rem),var(--lc-room,100dvh))] flex-col gap-3.5 overflow-y-auto p-5 pointer-coarse:max-h-[calc(100dvh-12rem)] short:gap-2.5 short:p-4"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[18px] leading-none font-bold uppercase">
              {activeLapWord()} {s.lapNumber}
            </h2>
            <div className="flex min-w-0 items-center gap-1.5">
              {skinnedBadge}
              <SkinButton onClick={onCollapse} aria-label="Collapse lap summary" className="size-8 shrink-0">
                <Icon name="expand" size="xs" />
              </SkinButton>
            </div>
          </div>
          <span className={`lc-mono text-[40px] leading-none font-bold tracking-[-0.02em] sm:text-[46px] short:text-[34px] ${skinCss.readout}`}>
            {formatLapTime(s.lapTimeMs)}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {s.sectorTimesMs.map((t, idx) => {
            const mark = sectorMark(t, s.bestSectorTimesMs[idx]);
            return (
              <div key={idx} className={`flex min-w-0 flex-col gap-0.5 px-3 py-2.5 short:py-2 ${skinCss.deepBox}`}>
                <span className={`lc-mono text-[18px] leading-tight font-bold ${skinCss.readout}`} style={{ color: mark.color }}>
                  {formatSectorTime(t)}
                </span>
                <span className={`truncate text-[11px] ${skinCss.inkDim}`}>
                  Sector {idx + 1}
                  {mark.word ? `: ${mark.word.toLowerCase()}` : ""}
                </span>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {stats.map((st) => (
            <Stat key={st.label} value={st.value} label={st.label} />
          ))}
        </div>

        <div className={`flex items-center justify-between gap-2 px-3.5 py-2.5 ${skinCss.deepBox}`}>
          <span className={`text-[13px] font-semibold ${skinCss.inkSoft}`}>Theoretical best</span>
          <span className={`lc-mono text-[18px] font-bold ${skinCss.ink}`}>
            {s.theoreticalBestMs === null ? EMPTY : formatLapTime(s.theoreticalBestMs)}
          </span>
        </div>

        <CornerChart corners={s.corners} units={units} />

        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="sr-only" aria-live="polite">
            {submitState === "sent" ? sentLabel : submitState === "sending" ? "Posting" : submitState === "waiting" ? (submitError ?? "") : ""}
          </span>
          {onSubmit && notRanked && submitState !== "sent" ? <span className={`mr-auto text-[12px] ${skinCss.inkDim}`}>{notRanked}</span> : null}
          {onSaveGhost ? (
            <SkinButton onClick={onSaveGhost} className="h-8 px-3 text-[12px] font-semibold">
              Save ghost file
            </SkinButton>
          ) : null}
          {submitState === "sent" ? (
            <SkinTag tone="gain" className="px-2.5 py-1 text-[12px] font-semibold">
              <Icon name="online" size="xs" />
              {sentLabel}
            </SkinTag>
          ) : !onSubmit && submitState === "sending" ? (
            <SkinTag className="px-2.5 py-1 text-[12px] font-semibold">Posting</SkinTag>
          ) : onSubmit ? (
            <SkinButton
              active={submitState !== "error" && submitState !== "waiting"}
              disabled={Boolean(notRanked) || submitState === "sending"}
              title={notRanked}
              onClick={onSubmit}
              className="h-8 px-3 text-[12px] font-semibold"
            >
              {submitState === "sending" ? "Posting…" : submitState === "error" || submitState === "waiting" ? "Retry upload" : "Post online"}
            </SkinButton>
          ) : submitState === "waiting" ? (
            <SkinTag tone="caution" className="px-2.5 py-1 text-[12px] font-semibold">
              <Icon name="offline" size="xs" />
              Not posted yet
            </SkinTag>
          ) : null}
          <SkinButton onClick={onClose} className="h-8 px-3 text-[12px] font-semibold">
            Close
          </SkinButton>
        </div>

        {submitState === "error" && submitError ? (
          <p role="alert" className={`-mt-1.5 flex items-start justify-end gap-1.5 text-right text-[12px] leading-snug font-medium ${skinCss.inkLoss}`}>
            <Icon name="error" size="xs" className="mt-px" />
            {submitError}
          </p>
        ) : submitState === "waiting" && submitError ? (
          <p className={`-mt-1.5 flex items-start justify-end gap-1.5 text-right text-[12px] leading-snug font-medium ${skinCss.inkCaution}`}>
            <Icon name="offline" size="xs" className="mt-px" />
            {submitError}
          </p>
        ) : null}
        {onRename && driverName && (submitState === "sent" || submitState === "error") ? (
          <DriverNameLine name={driverName} onBoard={submitState === "sent"} onRename={onRename} />
        ) : null}
      </SkinPanel>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={`Lap ${s.lapNumber} summary`}
      className="lc-glass flex max-h-[min(calc(100dvh-9rem),var(--lc-room,100dvh))] w-full flex-col gap-3.5 overflow-y-auto rounded-lc-sheet p-5 text-lc-chalk shadow-lc-sheet pointer-coarse:max-h-[calc(100dvh-12rem)] short:gap-2.5 short:p-4"
    >
      {/* The lap and its status, then the lap time on a row of its own (a long badge left it too little room beside it) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="lc-h3">
            {activeLapWord()} {s.lapNumber}
          </h2>
          <div className="flex min-w-0 items-center gap-1.5">
            {badge}
            <IconButton size="sm" variant="ghost" aria-label="Collapse lap summary" icon={<Icon name="expand" />} onClick={onCollapse} />
          </div>
        </div>
        <span className="lc-mono text-[40px] leading-none font-bold tracking-[-0.02em] sm:text-[46px] short:text-[34px]">
          {formatLapTime(s.lapTimeMs)}
        </span>
      </div>

      {/* Sector splits against the session best: the colour and its word */}
      <div className="grid grid-cols-3 gap-1.5">
        {s.sectorTimesMs.map((t, idx) => {
          const mark = sectorMark(t, s.bestSectorTimesMs[idx]);
          return (
            <Well key={idx} className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5 short:py-2">
              <span className="lc-mono text-[18px] leading-tight font-bold" style={{ color: mark.color }}>
                {formatSectorTime(t)}
              </span>
              <span className="lc-hint truncate">
                Sector {idx + 1}
                {mark.word ? `: ${mark.word.toLowerCase()}` : ""}
              </span>
            </Well>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {stats.map((st) => (
          <Stat key={st.label} value={st.value} label={st.label} />
        ))}
      </div>

      <Well className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <span className="text-[13px] font-semibold text-lc-fog">Theoretical best</span>
        <span className="lc-mono text-[18px] font-bold">{s.theoreticalBestMs === null ? EMPTY : formatLapTime(s.theoreticalBestMs)}</span>
      </Well>

      {/* Minimum speed per corner */}
      <CornerChart corners={s.corners} units={units} />

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Where posting the lap went, said once it changes (the badges below come and go) */}
        <span className="sr-only" aria-live="polite">
          {submitState === "sent" ? sentLabel : submitState === "sending" ? "Posting" : submitState === "waiting" ? (submitError ?? "") : ""}
        </span>
        {/* Why the lap cannot go online, in words beside the greyed button */}
        {onSubmit && notRanked && submitState !== "sent" ? <span className="lc-hint mr-auto">{notRanked}</span> : null}
        {onSaveGhost ? (
          <Button size="sm" variant="ghost" onClick={onSaveGhost}>
            Save ghost file
          </Button>
        ) : null}
        {submitState === "sent" ? (
          <Badge tone="good" icon="online">
            {sentLabel}
          </Badge>
        ) : !onSubmit && submitState === "sending" ? (
          // Posted by itself: where the lap went, nothing to press
          <Badge>Posting</Badge>
        ) : onSubmit ? (
          <Button
            size="sm"
            variant={submitState === "error" || submitState === "waiting" ? "secondary" : "primary"}
            loading={submitState === "sending"}
            disabledReason={notRanked}
            onClick={onSubmit}
          >
            {submitState === "error" || submitState === "waiting" ? "Retry upload" : "Post online"}
          </Button>
        ) : submitState === "waiting" ? (
          // Waiting for the board, nothing to press: the line below says so
          <Badge tone="warn" icon="offline">
            Not posted yet
          </Badge>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      {submitState === "error" && submitError ? (
        <p role="alert" className="-mt-1.5 flex items-start justify-end gap-1.5 text-right text-[12px] leading-snug font-medium text-lc-loss">
          <Icon name="error" size="xs" className="mt-px" />
          {submitError}
        </p>
      ) : submitState === "waiting" && submitError ? (
        // Not a refusal: the board didn't answer, and the lap goes up by itself once it does
        <p className="-mt-1.5 flex items-start justify-end gap-1.5 text-right text-[12px] leading-snug font-medium text-lc-amber">
          <Icon name="offline" size="xs" className="mt-px" />
          {submitError}
        </p>
      ) : null}
      {onRename && driverName && (submitState === "sent" || submitState === "error") ? (
        <DriverNameLine name={driverName} onBoard={submitState === "sent"} onRename={onRename} />
      ) : null}
    </div>
  );
};

/**
 * The name the lap went up under, and a way to change it right here: the game picks a name for new drivers, and the
 * board keeps one entry per driver, so the laps under the old name move to the new one
 */
const DriverNameLine: React.FC<{ name: string; onBoard: boolean; onRename: (name: string) => Promise<string | null> }> = ({ name, onBoard, onRename }) => {
  const skin = useHudSkin();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    const problem = await onRename(draft);
    setBusy(false);
    setError(problem);
    if (problem === null) setEditing(false);
  };

  if (!editing) {
    if (skin !== null) {
      return (
        <p className={`-mt-1 flex flex-wrap items-center justify-end gap-x-1.5 text-right text-[12px] leading-snug ${skinCss.inkDim}`}>
          {onBoard ? "On the board as" : "Racing as"} <span className={`font-semibold ${skinCss.ink}`}>{name}</span>
          <SkinButton
            onClick={() => {
              setDraft(name);
              setError(null);
              setEditing(true);
            }}
            className="h-7 px-2.5 text-[12px] font-semibold"
          >
            Change name
          </SkinButton>
        </p>
      );
    }
    return (
      <p className="-mt-1 flex flex-wrap items-center justify-end gap-x-1.5 text-right text-[12px] leading-snug text-lc-slate">
        {onBoard ? "On the board as" : "Racing as"} <span className="font-semibold text-lc-chalk">{name}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(name);
            setError(null);
            setEditing(true);
          }}
        >
          Change name
        </Button>
      </p>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-2"
    >
      <TextField
        label="Driver name"
        autoFocus
        maxLength={16}
        autoComplete="nickname"
        spellCheck={false}
        value={draft}
        error={error ?? undefined}
        onChange={(v) => {
          setDraft(v);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <div className="flex justify-end gap-2">
        {skin !== null ? (
          <>
            <SkinButton onClick={() => setEditing(false)} className="h-8 px-3 text-[12px] font-semibold">
              Cancel
            </SkinButton>
            <SkinButton
              type="submit"
              active
              disabled={busy || draft.trim() === ""}
              className="h-8 px-3 text-[12px] font-semibold"
            >
              {busy ? "Saving…" : "Save name"}
            </SkinButton>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="secondary" type="submit" loading={busy} disabled={draft.trim() === ""}>
              Save name
            </Button>
          </>
        )}
      </div>
    </form>
  );
};

/** Index of the corner shown in the readout by default: the biggest change against the best */
function defaultCorner(corners: CornerStat[]): number {
  let pick = 0;
  let most = -1;
  corners.forEach((c, i) => {
    if (c.bestMinSpeedKmh === null) return;
    const d = Math.abs(c.minSpeedKmh - c.bestMinSpeedKmh);
    if (d > most) {
      most = d;
      pick = i;
    }
  });
  return pick;
}

/** A corner's own name, without the "Turn 3 -" its data starts with (the T number is shown beside it) */
const cornerName = (name: string) => name.replace(/^Turn \d+\s*[\u2014-]\s*/, "");

/**
 * Per-corner minimum speed as bars, coloured faster green / slower amber / same keyline against the best
 * earlier lap. Hovering, tapping or focusing a bar shows that corner's numbers in the readout; the bars are one radio
 * group, so Tab enters it once and left / right (Home / End) walk the corners.
 */
const CornerChart: React.FC<{ corners: CornerStat[]; units: UnitSettings }> = ({ corners, units }) => {
  const skin = useHudSkin();
  const [picked, setPicked] = useState<number | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const sel = picked !== null && picked < corners.length ? picked : defaultCorner(corners);
  const maxSpeed = corners.reduce((m, c) => Math.max(m, c.minSpeedKmh), 1);
  const cols = { gridTemplateColumns: `repeat(${Math.max(1, corners.length)}, minmax(0, 1fr))` };
  const cur = corners[sel];
  const curDelta = cur ? cornerDelta(cur, units) : null;
  const unit = SPEED_LABEL[units.speed];

  const chartBody = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span id={titleId} className={`shrink-0 text-[13px] font-semibold ${skin !== null ? skinCss.inkSoft : "text-lc-fog"}`}>
          Slowest speed per corner
        </span>
        {cur && curDelta ? (
          <span className="lc-mono flex min-w-0 items-baseline gap-1.5 text-[12px] font-bold">
            <span className={skin !== null ? skinCss.ink : "text-lc-chalk"}>T{cur.turnNumber}</span>
            <span className={`min-w-0 truncate ${skin !== null ? skinCss.inkDim : "text-lc-slate"}`} title={cornerName(cur.name)}>
              {cornerName(cur.name)}
            </span>
            <span className={`shrink-0 ${skin !== null ? skinCss.inkSoft : "text-lc-fog"}`}>
              {speed(cur.minSpeedKmh, units)} {unit}
            </span>
            <span className="shrink-0" style={{ color: curDelta.color }}>
              {curDelta.text}
            </span>
          </span>
        ) : null}
      </div>

      {corners.length === 0 ? (
        <p className={`m-0 py-2 ${skin !== null ? `text-[12px] ${skinCss.inkDim}` : "lc-hint"}`}>No corner data for this lap.</p>
      ) : (
        <>
          <div
            ref={groupRef}
            role="radiogroup"
            aria-labelledby={titleId}
            className="grid h-[84px] items-end gap-[3px] short:h-[60px]"
            style={cols}
            onPointerLeave={() => {
              // The pointer leaving puts the readout back, unless the keys are walking the bars
              if (!groupRef.current?.contains(document.activeElement)) setPicked(null);
            }}
            onKeyDown={(e) => {
              const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
              const d = step[e.key];
              if (d === undefined) return;
              // The bars' own keys: they never reach the car or a menu behind
              e.preventDefault();
              e.stopPropagation();
              const next = d === -Infinity ? 0 : d === Infinity ? corners.length - 1 : Math.min(corners.length - 1, Math.max(0, sel + d));
              setPicked(next);
              groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
            }}
          >
            {corners.map((c, i) => {
              const d = cornerDelta(c, units);
              const pct = 17 + (c.minSpeedKmh / maxSpeed) * 83;
              return (
                // The whole column is the target, not only the bar drawn in it
                <button
                  key={c.turnNumber}
                  type="button"
                  role="radio"
                  aria-checked={i === sel}
                  aria-label={`T${c.turnNumber} ${cornerName(c.name)}: ${speed(c.minSpeedKmh, units)} ${unit}, ${d.text === EMPTY ? d.word : `${d.text}, ${d.word}`}`}
                  tabIndex={i === sel ? 0 : -1}
                  className={`flex h-full min-w-0 cursor-pointer items-end ${skin !== null ? skinCss.radiusSm : "rounded-full"}`}
                  onPointerEnter={() => setPicked(i)}
                  onPointerDown={() => setPicked(i)}
                  onFocus={() => setPicked(i)}
                >
                  <span
                    className={`block w-full ${skin !== null ? skinCss.radiusSm : "rounded-full"} ${i === sel ? "ring-2 ring-lc-chalk" : ""}`}
                    style={{ height: `${pct}%`, background: d.bar }}
                  />
                </button>
              );
            })}
          </div>
          <div aria-hidden className="lc-mono grid gap-[3px] text-center text-[11px] font-bold" style={cols}>
            {corners.map((c, i) => (
              <span key={c.turnNumber} className={i === sel ? (skin !== null ? skinCss.ink : "text-lc-chalk") : (skin !== null ? skinCss.inkDim : "text-lc-slate")}>
                {c.turnNumber}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1" aria-hidden>
            {[
              { label: "Faster", color: HUD_GAIN },
              { label: "Slower", color: HUD_CAUTION },
              { label: "Same", color: SAME },
            ].map((k) => (
              <span key={k.label} className={`inline-flex items-center gap-1.5 ${skin !== null ? `text-[11px] ${skinCss.inkDim}` : "lc-hint"}`}>
                <span className={`size-2 ${skin !== null ? skinCss.radiusSm : "rounded-full"}`} style={{ background: k.color }} />
                {k.label}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );

  if (skin !== null) {
    return <div className={`flex flex-col gap-2 px-3 pt-3 pb-2.5 ${skinCss.deepBox}`}>{chartBody}</div>;
  }

  return (
    <Well className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
      {chartBody}
    </Well>
  );
};
