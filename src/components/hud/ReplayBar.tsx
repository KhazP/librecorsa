"use client";

import React, { useEffect } from "react";
import { Camera, Pause, Play } from "lucide-react";
import { HUD_RED, HUD_VOLT } from "./hud-format";

const SPEEDS = [0.25, 0.5, 1, 2] as const;
/** Arrow-key seek step (s) */
const SEEK_STEP_S = 5;

/**
 * Bottom-centre transport bar for replays. Keys: Space play / pause, ArrowLeft / ArrowRight seek,
 * the replay key (handled by the simulator) exits. Keys are ignored while an input (e.g. the slider) has focus.
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [timeS, startS, endS, onTogglePlay, onSeek]);

  const rel = shown - endS;
  const relText = Math.abs(rel) < 0.05 ? "0.0" : `−${Math.abs(rel).toFixed(1)}`;
  const ctrlClass =
    "rounded border border-[#262B3D] bg-[#08090D] text-[#F5F7FA] transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00]";

  return (
    <div className="hud-panel pointer-events-auto fixed bottom-4 left-1/2 z-40 flex w-[min(720px,92vw)] -translate-x-1/2 items-center gap-3 rounded-lg px-3 py-2">
      <span
        className="shrink-0 rounded-sm px-1.5 py-0.5 font-f1-mono text-[11px] font-black text-white"
        style={{ backgroundColor: HUD_RED }}
      >
        REPLAY
      </span>

      <button
        type="button"
        onClick={onTogglePlay}
        aria-label={playing ? "Pause replay" : "Play replay"}
        title="Play / pause (Space)"
        className={`flex h-8 w-8 shrink-0 items-center justify-center ${ctrlClass}`}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>

      <input
        type="range"
        aria-label="Replay position"
        min={startS}
        max={endS}
        step={0.01}
        value={shown}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="min-w-[120px] flex-1"
        style={{ accentColor: HUD_VOLT }}
      />

      <span className="hud-num w-[64px] shrink-0 text-right text-[14px] tabular-nums text-[#F5F7FA]">
        {relText} s
      </span>

      <div className="flex shrink-0 overflow-hidden rounded border border-[#262B3D]">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSpeed(s)}
            aria-pressed={speed === s}
            className="px-1.5 py-1 font-f1-mono text-[11px] font-bold transition-colors"
            style={{
              backgroundColor: speed === s ? HUD_VOLT : "#08090D",
              color: speed === s ? "#08090D" : "#8E96AA",
            }}
          >
            {s}×
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onCycleCamera}
        title="Cycle replay camera"
        className={`flex shrink-0 items-center gap-1.5 px-2 py-1 font-f1-mono text-[11px] font-bold ${ctrlClass}`}
      >
        <Camera size={14} />
        {cameraLabel}
      </button>

      <button
        type="button"
        onClick={onExit}
        className={`shrink-0 px-2 py-1 font-f1-mono text-[11px] font-bold ${ctrlClass}`}
      >
        Exit ({exitKeyLabel})
      </button>
    </div>
  );
};
