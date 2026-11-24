"use client";

import { getActivePointToPoint } from "@/lib/track-data";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "use-intl/react";
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
  formatLapTime,
  formatSectorTime,
  lapMark,
  type LapMark,
} from "./hud-format";
import { SkinBanner, SkinButton, skinCss, SkinPanel, skinRootClass, SkinTag, type SkinTone, useHudSkin } from "./styles/third-party-skin";
import { useHudMode } from "./hud-mode";
import { claimSignInHint } from "@/lib/account/sign-in-hint";

const EMPTY = "-";
const MINUS = "−";
/** Bar colour for a corner with no change (or no reference yet) */
const SAME = "var(--color-lc-keyline)";

/**
 * Corner delta vs the best minimum speed, in the player's unit: green faster, amber slower, dash with no reference.
 * `state` picks the words the bar's spoken name ends with.
 */
function cornerDelta(c: CornerStat, u: UnitSettings): { text: string; color: string; bar: string; state: "none" | "same" | "faster" | "slower" } {
  if (c.bestMinSpeedKmh === null) return { text: EMPTY, color: "var(--color-lc-slate)", bar: SAME, state: "none" };
  const d = speedIn(c.minSpeedKmh, u.speed) - speedIn(c.bestMinSpeedKmh, u.speed);
  if (Math.abs(d) < 0.05) return { text: "0.0", color: "var(--color-lc-slate)", bar: SAME, state: "same" };
  return d > 0
    ? { text: `+${d.toFixed(1)}`, color: HUD_GAIN, bar: HUD_GAIN, state: "faster" }
    : { text: `${MINUS}${Math.abs(d).toFixed(1)}`, color: HUD_CAUTION, bar: HUD_CAUTION, state: "slower" };
}

/** A speed in km/h as a whole number in the player's unit */
const speed = (kmh: number, u: UnitSettings) => Math.round(speedIn(kmh, u.speed));

interface LapSummaryProps {
  summary: LapSummaryData;
  onClose: () => void;
  onSaveGhost?: () => void;
  /** Opens this lap in the lap board's Analysis view (pausing the drive) */
  onAnalyze?: () => void;
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
  /**
   * Opens Settings > Profile and data > Account. Given only while accounts are on and this device is signed out; the
   * card says what an account is for once, on the first lap that goes up to an online board
   */
  onSignIn?: () => void;
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
const TOAST_MS = 6_000;

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
  const [signInHint, setSignInHint] = useState(false);
  useEffect(() => {
    setExpanded(false);
    setHovered(false);
    setSignInHint(false);
  }, [s.lapNumber]);
  // The first lap on a board while signed out says once that an account keeps it on every device
  const canSignIn = Boolean(props.onSignIn);
  useEffect(() => {
    if (canSignIn && submitState === "sent" && claimSignInHint(`${s.lapNumber}:${s.lapTimeMs}`)) setSignInHint(true);
  }, [canSignIn, submitState, s.lapNumber, s.lapTimeMs]);
  // The pause menu or a replay covers the toast: the pointer is no longer on it
  useEffect(() => {
    if (hidden) setHovered(false);
  }, [hidden]);

  // Hidden, the clock stops: the toast gets its full time again once the HUD is back
  useEffect(() => {
    if (expanded || hovered || hidden || submitState === "sending") return;
    // The one-time sign-in note gets the time to be read as well
    const id = window.setTimeout(() => closeRef.current(), signInHint ? TOAST_MS * 2 : TOAST_MS);
    return () => window.clearTimeout(id);
  }, [expanded, hovered, hidden, submitState, s.lapNumber, signInHint]);

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
      className={`lc-ui-zoom lc-panel-in pointer-events-auto fixed right-[calc(env(safe-area-inset-right,0px)+0.75rem)] bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] z-(--z-lc-toast) w-[min(440px,calc(100vw-1.5rem))] sm:right-[calc(env(safe-area-inset-right,0px)+1rem)] pointer-coarse:top-[calc(env(safe-area-inset-top,0px)+104px)] pointer-coarse:portrait:top-[calc(env(safe-area-inset-top,0px)+216px)] pointer-coarse:end-auto pointer-coarse:bottom-auto pointer-coarse:left-1/2 pointer-coarse:w-[min(400px,calc(100vw-1.5rem))] pointer-coarse:-translate-x-1/2 ${hidden ? "invisible" : ""} ${skinRootClass(skin) ?? ""}`}
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
        <LapCard {...props} signInHint={signInHint} onCollapse={() => setExpanded(false)} />
      ) : (
        <>
          <LapToast summary={s} onOpen={() => setExpanded(true)} onClose={onClose} />
          {submitState === "waiting" && props.submitError ? <ToastNote text={props.submitError} /> : null}
          {signInHint && props.onSignIn ? <SignInNote place="toast" onSignIn={props.onSignIn} /> : null}
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
function statusBadge(s: LapSummaryData, words: { invalid: string; pb: string }, skinned = false): React.ReactNode {
  if (skinned) {
    if (!s.valid) {
      return (
        <SkinTag tone="loss" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
          <Icon name="trackLimits" size="xs" />
          {words.invalid}
        </SkinTag>
      );
    }
    if (s.isPersonalBest) {
      return (
        <SkinTag tone={PB_TONE === "best" ? "best" : "gain"} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
          <Icon name="success" size="xs" />
          {words.pb}
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
        {words.invalid}
      </Badge>
    );
  if (s.isPersonalBest)
    return (
      <Badge tone={PB_TONE} size="sm" icon="success">
        {words.pb}
      </Badge>
    );
  if (s.deltaToBestMs === null) return null;
  return <DeltaBadge seconds={s.deltaToBestMs / 1000} size="sm" />;
}

/** Colour and mark of a sector against the best (no time: neither) */
function sectorMark(
  ms: number | null | undefined,
  best: number | null | undefined,
): { color: string; mark: LapMark | null } {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return { color: "var(--color-lc-slate)", mark: null };
  const mark = lapMark(ms, best);
  return { color: LAP_MARK_COLOR[mark], mark };
}

/** The lap's name ("Lap 3", or "Run 3" on a hill climb) as the message's `kind` */
const lapKind = () => (getActivePointToPoint() ? "run" : "lap");

/** Collapsed toast: lap time, status and the three sector colours; the whole card opens the details */
const LapToast: React.FC<{ summary: LapSummaryData; onOpen: () => void; onClose: () => void }> = ({
  summary: s,
  onOpen,
  onClose,
}) => {
  const skin = useHudSkin();
  const tx = useTranslations("hud.lapSummary");
  // The HUD re-renders every frame: the toast's words are read once per lap and language
  const kind = lapKind();
  const words = useMemo(
    () => ({
      title: tx("title", { kind, lap: s.lapNumber }),
      open: tx("open", { kind, lap: s.lapNumber }),
      dismiss: tx("dismiss"),
      invalid: tx("invalid"),
      pb: tx("pb"),
    }),
    [tx, kind, s.lapNumber]
  );
  if (skin !== null) {
    return (
      <SkinPanel
        cut="sm"
        className="ms-auto w-fit max-w-full pointer-coarse:mx-auto"
        innerClassName="flex items-center gap-2 py-1.5 pe-1.5 ps-3.5"
      >
        <button
          type="button"
          onClick={onOpen}
          aria-label={words.open}
          className={`flex min-h-9 min-w-0 cursor-pointer items-center gap-3 text-start transition-opacity duration-200 hover:opacity-85 pointer-coarse:min-h-11 sm:gap-3.5 ${skinCss.ink}`}
        >
          <span className={`lc-mono shrink-0 text-[12px] font-bold uppercase ${skinCss.inkDim}`}>
            {words.title}
          </span>
          <span className={`lc-mono text-[22px] leading-none font-bold sm:text-[24px] ${skinCss.readout}`}>{formatLapTime(s.lapTimeMs)}</span>
          {statusBadge(s, words, true)}
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
        <SkinButton onClick={onClose} aria-label={words.dismiss} className="size-8 shrink-0">
          <Icon name="close" size="xs" />
        </SkinButton>
      </SkinPanel>
    );
  }
  return (
    <div className="ms-auto flex w-fit max-w-full items-center gap-2 rounded-lc-row border border-white/10 bg-lc-void/84 py-1.5 pe-1.5 ps-3.5 text-lc-chalk shadow-lc-pop backdrop-blur-[8px] in-data-[phone-hud]:backdrop-blur-none pointer-coarse:mx-auto">
      <button
        type="button"
        onClick={onOpen}
        aria-label={words.open}
        className="flex min-h-9 min-w-0 pointer-coarse:min-h-11 cursor-pointer items-center gap-3 rounded-lc-nub text-start transition-opacity duration-150 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lc-volt sm:gap-3.5"
      >
        <span className="lc-mono shrink-0 text-[12px] font-bold text-lc-slate">
          {words.title}
        </span>
        <span className="lc-mono text-[22px] leading-none font-bold sm:text-[24px]">{formatLapTime(s.lapTimeMs)}</span>
        {statusBadge(s, words)}
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
      <IconButton size="sm" variant="ghost" aria-label={words.dismiss} icon={<Icon name="close" />} onClick={onClose} />
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
        className="mt-1.5 ms-auto flex w-fit max-w-full items-center gap-1.5 px-3 py-1 text-[12px] leading-snug font-medium pointer-coarse:mx-auto"
      >
        <Icon name="offline" size="xs" className="shrink-0" />
        {text}
      </SkinBanner>
    );
  }
  return (
    <p
      role="status"
      className="mt-1.5 ms-auto flex w-fit max-w-full items-center gap-1.5 rounded-lc-row border border-white/10 bg-lc-void/84 px-3 py-1 text-[12px] leading-snug font-medium text-lc-amber shadow-lc-pop backdrop-blur-[8px] in-data-[phone-hud]:backdrop-blur-none pointer-coarse:mx-auto"
    >
      <Icon name="offline" size="xs" className="shrink-0" />
      {text}
    </p>
  );
};

/**
 * The one-time note that an account keeps best laps and driver names on every device, with a way to sign in: under
 * the toast (it clears itself like the toast) or as a line at the foot of the card
 */
const SignInNote: React.FC<{ place: "toast" | "card"; onSignIn: () => void }> = ({ place, onSignIn }) => {
  const skin = useHudSkin();
  const tx = useTranslations("hud.lapSummary");
  // Drawn under the HUD, which re-renders every frame: the words are read once per language
  const words = useMemo(() => ({ hint: tx("signInHint"), signIn: tx("signIn") }), [tx]);
  // One row: the words wrap beside the button, which stays in view at the row's end
  const row = "flex items-center gap-2 text-[12px] leading-snug";
  const text = <span className="min-w-0 text-balance">{words.hint}</span>;
  if (skin !== null) {
    const button = (
      <SkinButton onClick={onSignIn} className="h-7 shrink-0 px-2.5 text-[12px] font-semibold">
        {words.signIn}
      </SkinButton>
    );
    return place === "toast" ? (
      <SkinBanner role="status" cut="sm" className={`mt-1.5 ms-auto w-fit max-w-full py-1 ps-3 pe-1.5 font-medium pointer-coarse:mx-auto ${row}`}>
        <Icon name="profile" size="xs" className="shrink-0" />
        {text}
        {button}
      </SkinBanner>
    ) : (
      <p className={`-mt-1 justify-end text-end ${row} ${skinCss.inkDim}`}>
        {text}
        {button}
      </p>
    );
  }
  const button = (
    <Button size="sm" variant={place === "toast" ? "secondary" : "ghost"} className="shrink-0" onClick={onSignIn}>
      {words.signIn}
    </Button>
  );
  return place === "toast" ? (
    <p
      role="status"
      className={`mt-1.5 ms-auto w-fit max-w-full rounded-lc-row border border-white/10 bg-lc-void/84 py-1 ps-3 pe-1.5 font-medium text-lc-chalk shadow-lc-pop backdrop-blur-[8px] in-data-[phone-hud]:backdrop-blur-none pointer-coarse:mx-auto ${row}`}
    >
      <Icon name="profile" size="xs" className="shrink-0" />
      {text}
      {button}
    </p>
  ) : (
    <p className={`-mt-1 justify-end text-end text-lc-slate ${row}`}>
      {text}
      {button}
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
    /** This lap's card carries the one-time note on signing in */
    signInHint?: boolean;
  }
> = ({
  summary: s,
  onClose,
  onCollapse,
  onSaveGhost,
  onAnalyze,
  onSubmit,
  submitState = "idle",
  submitRank = null,
  submitError = null,
  driverName,
  onRename,
  onSignIn,
  signInHint = false,
}) => {
  const skin = useHudSkin();
  const units = useUnits();
  const unit = SPEED_LABEL[units.speed];
  const tx = useTranslations("hud.lapSummary");
  // The HUD re-renders every frame: the card's words are read once per lap, upload result and language
  const kind = lapKind();
  const rank = submitRank?.rank;
  const rankTotal = submitRank?.total;
  const rankWeek = submitRank?.challengeRank;
  const words = useMemo(
    () => ({
      title: tx("title", { kind, lap: s.lapNumber }),
      cardLabel: tx("cardLabel", { lap: s.lapNumber }),
      collapse: tx("collapse"),
      invalidWall: tx("invalidWall"),
      invalidLimits: tx("invalidLimits"),
      autopilot: tx("autopilot"),
      personalBest: tx("personalBest"),
      sent:
        rank != null
          ? rankTotal
            ? rankWeek
              ? tx("onlineRankOfWeek", { rank, total: rankTotal, week: rankWeek })
              : tx("onlineRankOf", { rank, total: rankTotal })
            : rankWeek
              ? tx("onlineRankWeek", { rank, week: rankWeek })
              : tx("onlineRank", { rank })
          : tx("online"),
      invalidUnranked: tx("invalidUnranked"),
      autopilotUnranked: tx("autopilotUnranked"),
      topSpeed: tx("topSpeed", { unit }),
      avgSpeed: tx("avgSpeed", { unit }),
      fullThrottle: tx("fullThrottle"),
      braking: tx("braking"),
      theoreticalBest: tx("theoreticalBest"),
      posting: tx("posting"),
      postingNow: tx("postingNow"),
      retry: tx("retry"),
      post: tx("post"),
      queued: tx("queued"),
      close: tx("close"),
      saveGhost: tx("saveGhost"),
      analyse: tx("analyse"),
      sectors: s.sectorTimesMs.map((ms, idx) => tx("sector", { n: idx + 1, mark: sectorMark(ms, s.bestSectorTimesMs[idx]).mark ?? "none" })),
    }),
    [tx, kind, s.lapNumber, s.sectorTimesMs, s.bestSectorTimesMs, rank, rankTotal, rankWeek, unit]
  );

  let badge: React.ReactNode = null;
  let skinnedBadge: React.ReactNode = null;
  if (!s.valid) {
    badge = (
      <Badge tone="bad" icon="trackLimits">
        {s.wallContact ? words.invalidWall : words.invalidLimits}
      </Badge>
    );
    skinnedBadge = (
      <SkinTag tone="loss" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
        <Icon name="trackLimits" size="xs" />
        {s.wallContact ? words.invalidWall : words.invalidLimits}
      </SkinTag>
    );
  } else if (s.autopilot) {
    badge = (
      <Badge tone="warn" icon="warning">
        {words.autopilot}
      </Badge>
    );
    skinnedBadge = (
      <SkinTag tone="caution" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
        <Icon name="warning" size="xs" />
        {words.autopilot}
      </SkinTag>
    );
  } else if (s.isPersonalBest) {
    badge = (
      <Badge tone={PB_TONE} icon="success">
        {words.personalBest}
      </Badge>
    );
    skinnedBadge = (
      <SkinTag tone={PB_TONE === "best" ? "best" : "gain"} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
        <Icon name="success" size="xs" />
        {words.personalBest}
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

  const sentLabel = words.sent;
  const notRanked = !s.valid ? words.invalidUnranked : s.autopilot ? words.autopilotUnranked : undefined;

  const stats: { id: string; label: string; value: string }[] = [
    { id: "top", label: words.topSpeed, value: `${speed(s.topSpeedKmh, units)}` },
    { id: "avg", label: words.avgSpeed, value: `${speed(s.avgSpeedKmh, units)}` },
    { id: "throttle", label: words.fullThrottle, value: `${s.fullThrottlePct.toFixed(0)}%` },
    { id: "braking", label: words.braking, value: `${s.brakingPct.toFixed(0)}%` },
  ];

  if (skin !== null) {
    return (
      <SkinPanel
        cut="lg"
        role="dialog"
        aria-label={words.cardLabel}
        className="w-full"
        innerClassName="flex max-h-[min(calc(100dvh-9rem),var(--lc-room,100dvh))] flex-col gap-3.5 overflow-y-auto p-5 pointer-coarse:max-h-[calc(100dvh-12rem)] short:gap-2.5 short:p-4"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[18px] leading-none font-bold uppercase">
              {words.title}
            </h2>
            <div className="flex min-w-0 items-center gap-1.5">
              {skinnedBadge}
              <SkinButton onClick={onCollapse} aria-label={words.collapse} className="size-8 shrink-0">
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
                <span className={`truncate text-[11px] ${skinCss.inkDim}`}>{words.sectors[idx]}</span>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {stats.map((st) => (
            <Stat key={st.id} value={st.value} label={st.label} />
          ))}
        </div>

        <div className={`flex items-center justify-between gap-2 px-3.5 py-2.5 ${skinCss.deepBox}`}>
          <span className={`text-[13px] font-semibold ${skinCss.inkSoft}`}>{words.theoreticalBest}</span>
          <span className={`lc-mono text-[18px] font-bold ${skinCss.ink}`}>
            {s.theoreticalBestMs === null ? EMPTY : formatLapTime(s.theoreticalBestMs)}
          </span>
        </div>

        <CornerChart corners={s.corners} units={units} />

        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="sr-only" aria-live="polite">
            {submitState === "sent" ? sentLabel : submitState === "sending" ? words.posting : submitState === "waiting" ? (submitError ?? "") : ""}
          </span>
          {onSubmit && notRanked && submitState !== "sent" ? <span className={`me-auto text-[12px] ${skinCss.inkDim}`}>{notRanked}</span> : null}
          {onAnalyze ? (
            <SkinButton onClick={onAnalyze} className="h-8 px-3 text-[12px] font-semibold">
              {words.analyse}
            </SkinButton>
          ) : null}
          {onSaveGhost ? (
            <SkinButton onClick={onSaveGhost} className="h-8 px-3 text-[12px] font-semibold">
              {words.saveGhost}
            </SkinButton>
          ) : null}
          {submitState === "sent" ? (
            <SkinTag tone="gain" className="px-2.5 py-1 text-[12px] font-semibold">
              <Icon name="online" size="xs" />
              {sentLabel}
            </SkinTag>
          ) : !onSubmit && submitState === "sending" ? (
            <SkinTag className="px-2.5 py-1 text-[12px] font-semibold">{words.posting}</SkinTag>
          ) : onSubmit ? (
            <SkinButton
              active={submitState !== "error" && submitState !== "waiting"}
              disabled={Boolean(notRanked) || submitState === "sending"}
              title={notRanked}
              onClick={onSubmit}
              className="h-8 px-3 text-[12px] font-semibold"
            >
              {submitState === "sending" ? words.postingNow : submitState === "error" || submitState === "waiting" ? words.retry : words.post}
            </SkinButton>
          ) : submitState === "waiting" ? (
            <SkinTag tone="caution" className="px-2.5 py-1 text-[12px] font-semibold">
              <Icon name="offline" size="xs" />
              {words.queued}
            </SkinTag>
          ) : null}
          <SkinButton onClick={onClose} className="h-8 px-3 text-[12px] font-semibold">
            {words.close}
          </SkinButton>
        </div>

        {submitState === "error" && submitError ? (
          <p role="alert" className={`-mt-1.5 flex items-start justify-end gap-1.5 text-end text-[12px] leading-snug font-medium ${skinCss.inkLoss}`}>
            <Icon name="error" size="xs" className="mt-px" />
            {submitError}
          </p>
        ) : submitState === "waiting" && submitError ? (
          <p className={`-mt-1.5 flex items-start justify-end gap-1.5 text-end text-[12px] leading-snug font-medium ${skinCss.inkCaution}`}>
            <Icon name="offline" size="xs" className="mt-px" />
            {submitError}
          </p>
        ) : null}
        {onRename && driverName && (submitState === "sent" || submitState === "error") ? (
          <DriverNameLine name={driverName} onBoard={submitState === "sent"} onRename={onRename} />
        ) : null}
        {signInHint && onSignIn ? <SignInNote place="card" onSignIn={onSignIn} /> : null}
      </SkinPanel>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={words.cardLabel}
      className="lc-glass flex max-h-[min(calc(100dvh-9rem),var(--lc-room,100dvh))] w-full flex-col gap-3.5 overflow-y-auto rounded-lc-sheet p-5 text-lc-chalk shadow-lc-sheet pointer-coarse:max-h-[calc(100dvh-12rem)] short:gap-2.5 short:p-4"
    >
      {/* The lap and its status, then the lap time on a row of its own (a long badge left it too little room beside it) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="lc-h3">{words.title}</h2>
          <div className="flex min-w-0 items-center gap-1.5">
            {badge}
            <IconButton size="sm" variant="ghost" aria-label={words.collapse} icon={<Icon name="expand" />} onClick={onCollapse} />
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
              <span className="lc-hint truncate">{words.sectors[idx]}</span>
            </Well>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {stats.map((st) => (
          <Stat key={st.id} value={st.value} label={st.label} />
        ))}
      </div>

      <Well className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <span className="text-[13px] font-semibold text-lc-fog">{words.theoreticalBest}</span>
        <span className="lc-mono text-[18px] font-bold">{s.theoreticalBestMs === null ? EMPTY : formatLapTime(s.theoreticalBestMs)}</span>
      </Well>

      {/* Minimum speed per corner */}
      <CornerChart corners={s.corners} units={units} />

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Where posting the lap went, said once it changes (the badges below come and go) */}
        <span className="sr-only" aria-live="polite">
          {submitState === "sent" ? sentLabel : submitState === "sending" ? words.posting : submitState === "waiting" ? (submitError ?? "") : ""}
        </span>
        {/* Why the lap cannot go online, in words beside the greyed button */}
        {onSubmit && notRanked && submitState !== "sent" ? <span className="lc-hint me-auto">{notRanked}</span> : null}
        {onAnalyze ? (
          <Button size="sm" variant="secondary" onClick={onAnalyze}>
            {words.analyse}
          </Button>
        ) : null}
        {onSaveGhost ? (
          <Button size="sm" variant="ghost" onClick={onSaveGhost}>
            {words.saveGhost}
          </Button>
        ) : null}
        {submitState === "sent" ? (
          <Badge tone="good" icon="online">
            {sentLabel}
          </Badge>
        ) : !onSubmit && submitState === "sending" ? (
          // Posted by itself: where the lap went, nothing to press
          <Badge>{words.posting}</Badge>
        ) : onSubmit ? (
          <Button
            size="sm"
            variant={submitState === "error" || submitState === "waiting" ? "secondary" : "primary"}
            loading={submitState === "sending"}
            disabledReason={notRanked}
            onClick={onSubmit}
          >
            {submitState === "error" || submitState === "waiting" ? words.retry : words.post}
          </Button>
        ) : submitState === "waiting" ? (
          // Waiting for the board, nothing to press: the line below says so
          <Badge tone="warn" icon="offline">
            {words.queued}
          </Badge>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onClose}>
          {words.close}
        </Button>
      </div>
      {submitState === "error" && submitError ? (
        <p role="alert" className="-mt-1.5 flex items-start justify-end gap-1.5 text-end text-[12px] leading-snug font-medium text-lc-loss">
          <Icon name="error" size="xs" className="mt-px" />
          {submitError}
        </p>
      ) : submitState === "waiting" && submitError ? (
        // Not a refusal: the board didn't answer, and the lap goes up by itself once it does
        <p className="-mt-1.5 flex items-start justify-end gap-1.5 text-end text-[12px] leading-snug font-medium text-lc-amber">
          <Icon name="offline" size="xs" className="mt-px" />
          {submitError}
        </p>
      ) : null}
      {onRename && driverName && (submitState === "sent" || submitState === "error") ? (
        <DriverNameLine name={driverName} onBoard={submitState === "sent"} onRename={onRename} />
      ) : null}
      {signInHint && onSignIn ? <SignInNote place="card" onSignIn={onSignIn} /> : null}
    </div>
  );
};

/**
 * The name the lap went up under, and a way to change it right here: the game picks a name for new drivers, and the
 * board keeps one entry per driver, so the laps under the old name move to the new one
 */
const DriverNameLine: React.FC<{ name: string; onBoard: boolean; onRename: (name: string) => Promise<string | null> }> = ({ name, onBoard, onRename }) => {
  const skin = useHudSkin();
  const tx = useTranslations("hud.lapSummary");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drawn inside the card, which re-renders every frame: the words are read once per name, skin and language
  const words = useMemo(
    () => ({
      driver: tx.rich("driver", { name, b: (chunks) => <span className={`font-semibold ${skin !== null ? skinCss.ink : "text-lc-chalk"}`}>{chunks}</span> }),
      rename: tx("rename"),
      driverName: tx("driverName"),
      cancel: tx("cancel"),
      saving: tx("saving"),
      saveName: tx("saveName"),
    }),
    [tx, name, skin]
  );

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
        <p className={`-mt-1 flex flex-wrap items-center justify-end gap-x-1.5 text-end text-[12px] leading-snug ${skinCss.inkDim}`}>
          {words.driver}
          <SkinButton
            onClick={() => {
              setDraft(name);
              setError(null);
              setEditing(true);
            }}
            className="h-7 px-2.5 text-[12px] font-semibold"
          >
            {words.rename}
          </SkinButton>
        </p>
      );
    }
    return (
      <p className="-mt-1 flex flex-wrap items-center justify-end gap-x-1.5 text-end text-[12px] leading-snug text-lc-slate">
        {words.driver}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(name);
            setError(null);
            setEditing(true);
          }}
        >
          {words.rename}
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
        label={words.driverName}
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
              {words.cancel}
            </SkinButton>
            <SkinButton
              type="submit"
              active
              disabled={busy || draft.trim() === ""}
              className="h-8 px-3 text-[12px] font-semibold"
            >
              {busy ? words.saving : words.saveName}
            </SkinButton>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {words.cancel}
            </Button>
            <Button size="sm" variant="secondary" type="submit" loading={busy} disabled={draft.trim() === ""}>
              {words.saveName}
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
  const tx = useTranslations("hud.lapSummary.chart");
  // The HUD re-renders every frame: the chart's words, and each bar's spoken name, are read once per lap and language
  const words = useMemo(
    () => ({
      title: tx("title"),
      empty: tx("empty"),
      turns: corners.map((c) => tx("turn", { turn: c.turnNumber })),
      bars: corners.map((c) => {
        const d = cornerDelta(c, units);
        return tx("bar", { turn: c.turnNumber, name: cornerName(c.name), speed: speed(c.minSpeedKmh, units), unit, delta: d.text, state: d.state });
      }),
      key: [
        { id: "faster", label: tx("faster"), color: HUD_GAIN },
        { id: "slower", label: tx("slower"), color: HUD_CAUTION },
        { id: "same", label: tx("same"), color: SAME },
      ],
    }),
    [tx, corners, units, unit]
  );

  const chartBody = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span id={titleId} className={`shrink-0 text-[13px] font-semibold ${skin !== null ? skinCss.inkSoft : "text-lc-fog"}`}>
          {words.title}
        </span>
        {cur && curDelta ? (
          <span className="lc-mono flex min-w-0 items-baseline gap-1.5 text-[12px] font-bold">
            <span className={skin !== null ? skinCss.ink : "text-lc-chalk"}>{words.turns[sel]}</span>
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
        <p className={`m-0 py-2 ${skin !== null ? `text-[12px] ${skinCss.inkDim}` : "lc-hint"}`}>{words.empty}</p>
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
                  aria-label={words.bars[i]}
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
            {words.key.map((k) => (
              <span key={k.id} className={`inline-flex items-center gap-1.5 ${skin !== null ? `text-[11px] ${skinCss.inkDim}` : "lc-hint"}`}>
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
