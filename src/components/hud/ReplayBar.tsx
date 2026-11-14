"use client";

import React, { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons/Icon";
import { ArrowKeys, KeyCap } from "@/components/ui/prompts";
import { HUD_GLASS, HUD_LBL } from "./hud-format";
import { HUD_CHOSEN, HUD_CONTROL, HUD_IDLE } from "./styles/hud-style-parts";

const SPEEDS = [0.25, 0.5, 1, 2] as const;
/** Arrow-key seek step (s) */
const SEEK_STEP_S = 5;

/**
 * Bottom-centre transport bar for replays. Keys: Space play / pause, ArrowLeft / ArrowRight seek, and the replay key
 * (handled by the simulator) exits.
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
  exitKeyLabel = "T",
}) => {
  const shown = Math.min(endS, Math.max(startS, timeS));

  // The key listeners read the latest clock and callbacks from here, so they are added once: re-adding them every frame
  // (the clock moves while playing) dropped the Space latch between keydown and keyup
  const latest = useRef({ timeS, startS, endS, onTogglePlay, onSeek });
  latest.current = { timeS, startS, endS, onTogglePlay, onSeek };

  useEffect(() => {
    const clamp = (t: number) => Math.min(latest.current.endS, Math.max(latest.current.startS, t));
    const onKey = (e: KeyboardEvent) => {
      const { timeS, onTogglePlay, onSeek } = latest.current;
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
        spaceHandled = true;
        onTogglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onSeek(clamp(timeS - SEEK_STEP_S));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onSeek(clamp(timeS + SEEK_STEP_S));
      }
    };
    // A focused button clicks itself on Space's keyup: the key already toggled play, so that click must not toggle
    // it back (or press whichever other control has focus)
    let spaceHandled = false;
    const onKeyUp = (e: KeyboardEvent) => {
      if (!spaceHandled || (e.code !== "Space" && e.key !== " ")) return;
      spaceHandled = false;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);

  const rel = shown - endS;
  const relText = Math.abs(rel) < 0.05 ? "0.0" : `\u2212${Math.abs(rel).toFixed(1)}`;
  const fill = endS > startS ? ((shown - startS) / (endS - startS)) * 100 : 100;

  return (
    <>
      {/* Cinema letterbox while the replay runs */}
      <div aria-hidden className="lc-ui-zoom pointer-events-none fixed inset-x-0 top-0 z-[-1] h-10 bg-black sm:h-14 short:h-6" />
      <div aria-hidden className="lc-ui-zoom pointer-events-none fixed inset-x-0 bottom-0 z-[-1] h-10 bg-black sm:h-14 short:h-6" />

      <section
        aria-label="Replay controls"
        className={`lc-ui-zoom pointer-events-auto fixed bottom-[calc(env(safe-area-inset-bottom,0px)+3.5rem)] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] mx-auto z-40 flex max-w-205 flex-col gap-2.5 rounded-lc-sheet px-4 py-3.5 text-lc-chalk ${HUD_GLASS} sm:bottom-[calc(env(safe-area-inset-bottom,0px)+76px)] short:bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] short:gap-2 short:py-2.5`}
      >
        <div className="flex items-center gap-3.5">
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={playing ? "Pause replay" : "Play replay"}
            title="Play / pause (Space)"
            className="inline-flex size-13 shrink-0 cursor-pointer items-center justify-center rounded-full bg-lc-volt text-lc-void shadow-lc-focus transition-colors hover:bg-lc-volt-hi active:bg-lc-volt-dim short:size-11"
          >
            <Icon name={playing ? "pause" : "play"} size="md" />
          </button>

          <label className="flex min-w-30 flex-1 flex-col gap-2">
            <span className={`flex justify-between ${HUD_LBL}`}>
              <span>Buffer</span>
              <span>Live</span>
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
            className="flex rounded-full border border-lc-line bg-lc-void p-1"
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSpeed(s)}
                aria-pressed={speed === s}
                className={`lc-data h-8 min-w-11.5 rounded-full px-2.5 text-[12px] ${HUD_CONTROL} ${
                  // Chosen is chalk on line with a hairline (UI standard §4); volt stays the cursor
                  speed === s ? HUD_CHOSEN : HUD_IDLE
                }`}
              >
                {s}×
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={<Icon name="camera" />} onClick={onCycleCamera} title="Cycle replay camera">
              {cameraLabel}
            </Button>

            <Button variant="secondary" size="sm" prompt={<KeyCap>{exitKeyLabel}</KeyCap>} onClick={onExit}>
              Exit
            </Button>
          </div>
        </div>
      </section>

      <div
        aria-hidden
        className="lc-ui-zoom pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+18px)] left-1/2 z-40 hidden -translate-x-1/2 items-center gap-5.5 text-[13px] font-semibold whitespace-nowrap text-lc-fog sm:flex pointer-coarse:hidden short:hidden"
      >
        <span className="inline-flex items-center gap-2">
          <KeyCap>Space</KeyCap>
          Play / pause
        </span>
        <span className="inline-flex items-center gap-2">
          <ArrowKeys set="horizontal" />
          Seek {SEEK_STEP_S} s
        </span>
      </div>
    </>
  );
};
