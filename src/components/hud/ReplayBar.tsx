"use client";

import React, { useEffect } from "react";
import { Camera, Pause, Play, RotateCcw } from "lucide-react";

const SPEEDS = [0.25, 0.5, 1, 2] as const;
/** Arrow-key seek step (s) */
const SEEK_STEP_S = 5;

/**
 * Bottom-centre transport bar for replays. Keys: Space play / pause, ArrowLeft / ArrowRight seek,
 * F flashback (resume driving from current replay point), and the replay key (handled by the simulator) exits.
 * Keys are ignored while an input (e.g. the slider) has focus.
 */
export const ReplayBar: React.FC<{
  timeS: number;
  startS: number;
  endS: number;
  playing: boolean;
  speed: number;
  cameraLabel: string;
  onTogglePlay: () => void;
  onSeek: (tS: number) => void;
  onSpeed: (speed: number) => void;
  onCycleCamera: () => void;
  onExit: () => void;
  /** Resumes live driving from the scrubbed replay timestamp (Instant Flashback) */
  onFlashback?: () => void;
  /** Label of the key that leaves the replay */
  exitKeyLabel?: string;
}> = ({
  timeS,
  startS,
  endS,
  playing,
  speed,
  cameraLabel,
  onTogglePlay,
  onSeek,
  onSpeed,
  onCycleCamera,
  onExit,
  onFlashback,
  exitKeyLabel = "T",
}) => {
  const shown = Math.min(endS, Math.max(startS, timeS));

  useEffect(() => {
    const clamp = (t: number) => Math.min(endS, Math.max(startS, t));
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        onTogglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onSeek(clamp(timeS - SEEK_STEP_S));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onSeek(clamp(timeS + SEEK_STEP_S));
      } else if (onFlashback && (e.code === "KeyF" || e.key === "f" || e.key === "F")) {
        e.preventDefault();
        onFlashback();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [timeS, startS, endS, onTogglePlay, onSeek, onFlashback]);

  const rel = shown - endS;
  const relText = Math.abs(rel) < 0.05 ? "0.0" : `−${Math.abs(rel).toFixed(1)}`;
  const fill = endS > startS ? ((shown - startS) / (endS - startS)) * 100 : 100;
  const ctrlClass =
    "inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-[#262B3D] bg-[#11131A] px-3.5 text-[13px] font-bold whitespace-nowrap text-[#F5F7FA] transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00]";

  return (
    <>
      {/* Cinema letterbox while the replay runs */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[-1] h-10 bg-black sm:h-14 short:h-6" />
      <div aria-hidden className="pointer-events-none fixed inset-x-0 bottom-0 z-[-1] h-10 bg-black sm:h-14 short:h-6" />

      <section
        aria-label="Replay controls"
        className="pointer-events-auto fixed bottom-14 left-1/2 z-40 flex w-[min(820px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2.5 rounded-[28px] border border-white/8 bg-[#08090D]/80 px-4 py-3.5 text-[#F5F7FA] shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-[16px] sm:bottom-[76px] short:bottom-3 short:gap-2 short:py-2.5"
      >
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={playing ? "Pause replay" : "Play replay"}
            title="Play / pause (Space)"
            className="inline-flex h-[52px] w-[52px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#CCFF00] text-[#08090D] shadow-[0_0_0_5px_rgba(204,255,0,0.12)] transition-colors hover:bg-[#d9ff33] short:h-11 short:w-11"
          >
            {playing ? <Pause size={20} fill="currentColor" strokeWidth={0} /> : <Play size={20} fill="currentColor" strokeWidth={0} />}
          </button>

          <label className="flex min-w-[120px] flex-1 flex-col gap-2">
            <span className="flex justify-between font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA]">
              <span>BUFFER</span>
              <span>LIVE</span>
            </span>
            <input
              type="range"
              aria-label="Replay position"
              min={startS}
              max={endS}
              step={0.01}
              value={shown}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="lc-range !h-2"
              style={{ "--lc-fill": `${fill.toFixed(2)}%` } as React.CSSProperties}
            />
          </label>

          <span className="lc-data w-20 shrink-0 text-right text-[20px] short:w-16 short:text-[16px]">{relText} s</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div
            role="group"
            aria-label="Playback speed"
            className="flex rounded-full border border-[#262B3D] bg-[#08090D] p-1"
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSpeed(s)}
                aria-pressed={speed === s}
                className="h-8 min-w-[46px] cursor-pointer rounded-full px-2.5 font-f1-mono text-[12px] font-extrabold transition-colors"
                style={{
                  backgroundColor: speed === s ? "#CCFF00" : "transparent",
                  color: speed === s ? "#08090D" : "#8E96AA",
                }}
              >
                {s}×
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onCycleCamera} title="Cycle replay camera" className={ctrlClass}>
              <Camera size={16} aria-hidden />
              {cameraLabel}
            </button>

            {onFlashback ? (
              <button
                type="button"
                onClick={onFlashback}
                title="Flashback — resume driving from this moment (F)"
                className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-[#CCFF00]/60 bg-[#CCFF00]/15 px-3.5 text-[13px] font-bold whitespace-nowrap text-[#CCFF00] transition-colors hover:bg-[#CCFF00] hover:text-[#08090D]"
              >
                <RotateCcw size={15} aria-hidden />
                Flashback
                <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border border-current/40 bg-[#08090D]/60 px-1.5 font-f1-mono text-[10px] font-extrabold">
                  F
                </span>
              </button>
            ) : null}

            <button type="button" onClick={onExit} className={ctrlClass}>
              Exit
              <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border border-[#3A4157] bg-[#08090D] px-1.5 font-f1-mono text-[10px] font-extrabold">
                {exitKeyLabel}
              </span>
            </button>
          </div>
        </div>
      </section>

      <div
        aria-hidden
        className="pointer-events-none fixed bottom-[18px] left-1/2 z-40 hidden -translate-x-1/2 gap-[18px] font-f1-mono text-[11px] font-bold tracking-[0.1em] whitespace-nowrap text-[#8E96AA] sm:flex pointer-coarse:hidden short:hidden"
      >
        <span>SPACE PLAY / PAUSE</span>
        <span>← → SEEK {SEEK_STEP_S} S</span>
        {onFlashback ? <span>F FLASHBACK</span> : null}
      </div>
    </>
  );
};
