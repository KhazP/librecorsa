"use client";

import React, { useEffect, useMemo, useRef } from "react";
import type { CameraMode } from "@/types/f1";
import type { ReplayCarOption } from "@/lib/drive-session";
import type { ReplayLapMarker } from "@/lib/sim/replay-buffer";
import { ALL_CAMERA_MODES, CAMERA_MODES } from "@/lib/render/camera-modes";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Icon } from "@/components/ui/icons/Icon";
import { ArrowKeys, KeyCap } from "@/components/ui/prompts";
import { useFocusNav } from "@/components/menu/useFocusNav";
import { HUD_GLASS, HUD_LBL } from "./hud-format";
import { HUD_CHOSEN, HUD_CONTROL, HUD_IDLE } from "./styles/hud-style-parts";

const SPEEDS = [-4, -2, -1, -0.5, -0.25, 0.25, 0.5, 1, 2, 4] as const;
/** Arrow-key seek step (s) */
const SEEK_STEP_S = 5;

function formatReplayClock(sec: number): string {
  const s = Math.max(0, sec);
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  return mins > 0
    ? `${mins}:${rem < 10 ? "0" : ""}${rem.toFixed(1)}`
    : `${rem.toFixed(1)} s`;
}

export interface ReplayBarProps {
  timeS: number;
  startS: number;
  endS: number;
  playing: boolean;
  speed: number;
  cameraMode: CameraMode;
  cameraLabel: string;
  focusedCarId: string;
  cars: readonly ReplayCarOption[];
  lapMarkers?: readonly ReplayLapMarker[];
  onTogglePlay: () => void;
  onSeek: (tS: number) => void;
  onSpeed: (speed: number) => void;
  onStepFrame?: (dir: 1 | -1) => void;
  onSelectCamera?: (mode: CameraMode) => void;
  onCycleCamera: () => void;
  onCycleCar?: (dir: 1 | -1) => void;
  onExit: () => void;
  /** Resumes live driving from the scrubbed replay timestamp (Practice & AI races only; invalidates current lap) */
  onFlashback?: () => void;
  /** Label of the key that leaves the replay */
  exitKeyLabel?: string;
}

/**
 * Bottom-centre cinema transport bar for instant & full-race replays.
 * Supports reverse / slow-mo / fast-forward playback, frame stepping, lap markers,
 * car focus switching, and direct selection of every camera angle including Free camera.
 */
export const ReplayBar: React.FC<ReplayBarProps> = ({
  timeS,
  startS,
  endS,
  playing,
  speed,
  cameraMode,
  cameraLabel,
  focusedCarId,
  cars,
  lapMarkers = [],
  onTogglePlay,
  onSeek,
  onSpeed,
  onStepFrame,
  onSelectCamera,
  onCycleCamera,
  onCycleCar,
  onExit,
  onFlashback,
  exitKeyLabel = "T",
}) => {
  const shown = Math.min(endS, Math.max(startS, timeS));
  const durationS = Math.max(0, endS - startS);
  const elapsedS = Math.max(0, shown - startS);
  const inFreeCam = cameraMode === "free";

  const cameraOptions = useMemo(
    () => ALL_CAMERA_MODES.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
    []
  );

  const focusedCar = useMemo(
    () => cars.find((c) => c.id === focusedCarId) ?? cars[0] ?? null,
    [cars, focusedCarId]
  );

  const barRef = useRef<HTMLElement>(null);
  // Enable full gamepad / keyboard menu navigation inside ReplayBar (B / Back exits replay cleanly)
  useFocusNav(barRef, { onBack: onExit, enabled: !inFreeCam });

  // The key listeners read the latest clock and callbacks from here, so they are added once
  const latest = useRef({ timeS, startS, endS, inFreeCam, onTogglePlay, onSeek, onStepFrame, onCycleCar, onFlashback });
  latest.current = { timeS, startS, endS, inFreeCam, onTogglePlay, onSeek, onStepFrame, onCycleCar, onFlashback };

  useEffect(() => {
    const clamp = (t: number) => Math.min(latest.current.endS, Math.max(latest.current.startS, t));
    let spaceHandled = false;
    const onKey = (e: KeyboardEvent) => {
      const { timeS, inFreeCam, onTogglePlay, onSeek, onStepFrame, onCycleCar, onFlashback } = latest.current;
      const target = e.target as HTMLElement | null;
      const isRangeInput = target instanceof HTMLInputElement && target.type === "range";
      const inMenuPopup = Boolean(target?.closest('[role="listbox"], [role="menu"]'));
      if (
        inMenuPopup ||
        (target &&
          !isRangeInput &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable))
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // While flying Free camera, Space and Arrow keys move the camera instead of controlling playback
      if (!inFreeCam && (e.code === "Space" || e.key === " ")) {
        e.preventDefault();
        spaceHandled = true;
        onTogglePlay();
      } else if (!inFreeCam && e.key === "ArrowLeft") {
        e.preventDefault();
        onSeek(clamp(timeS - SEEK_STEP_S));
      } else if (!inFreeCam && e.key === "ArrowRight") {
        e.preventDefault();
        onSeek(clamp(timeS + SEEK_STEP_S));
      } else if (onStepFrame && (e.code === "Comma" || e.key === ",")) {
        e.preventDefault();
        onStepFrame(-1);
      } else if (onStepFrame && (e.code === "Period" || e.key === ".")) {
        e.preventDefault();
        onStepFrame(1);
      } else if (onCycleCar && e.code === "Tab") {
        e.preventDefault();
        onCycleCar(e.shiftKey ? -1 : 1);
      } else if (onFlashback && (e.code === "KeyF" || e.key === "f" || e.key === "F")) {
        e.preventDefault();
        onFlashback();
      }
    };
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

  const fill = durationS > 0 ? (elapsedS / durationS) * 100 : 100;
  const speedText = (s: number) => (s < 0 ? `\u2212${Math.abs(s)}×` : `${s}×`);

  return (
    <>
      {/* Cinema letterbox while the replay runs */}
      <div aria-hidden className="lc-ui-zoom pointer-events-none fixed inset-x-0 top-0 z-[-1] h-10 bg-black sm:h-14 short:h-6" />
      <div aria-hidden className="lc-ui-zoom pointer-events-none fixed inset-x-0 bottom-0 z-[-1] h-10 bg-black sm:h-14 short:h-6" />

      <section
        ref={barRef}
        role="toolbar"
        aria-label="Replay controls"
        className={`lc-ui-zoom pointer-events-auto fixed bottom-[calc(env(safe-area-inset-bottom,0px)+3.5rem)] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] mx-auto z-40 flex max-w-240 flex-col gap-2.5 rounded-lc-tile px-3.5 py-3 text-lc-chalk ${HUD_GLASS} sm:bottom-[calc(env(safe-area-inset-bottom,0px)+76px)] short:bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] short:gap-2 short:py-2`}
      >
        <div className="flex items-center gap-2.5 sm:gap-3">
          <div role="group" aria-label="Transport" className="flex shrink-0 items-center gap-1.5">
            {onStepFrame ? (
              <button
                type="button"
                onClick={() => onStepFrame(-1)}
                aria-label="Previous frame"
                title="Previous frame (,)"
                className={`inline-flex size-9 cursor-pointer items-center justify-center rounded-lc-row border border-lc-line bg-lc-void text-lc-fog hover:text-lc-chalk ${HUD_CONTROL}`}
              >
                <Icon name="previous" size="sm" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onTogglePlay}
              aria-label={playing ? "Pause replay" : "Play replay"}
              title={inFreeCam ? "Play / pause" : "Play / pause (Space)"}
              className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lc-row bg-lc-volt text-lc-void shadow-lc-focus transition-[background-color,transform] duration-150 hover:bg-lc-volt-hi active:scale-[0.97] active:bg-lc-volt-dim motion-reduce:active:scale-100 sm:size-11"
            >
              <Icon name={playing ? "pause" : "play"} size="md" />
            </button>
            {onStepFrame ? (
              <button
                type="button"
                onClick={() => onStepFrame(1)}
                aria-label="Next frame"
                title="Next frame (.)"
                className={`inline-flex size-9 cursor-pointer items-center justify-center rounded-lc-row border border-lc-line bg-lc-void text-lc-fog hover:text-lc-chalk ${HUD_CONTROL}`}
              >
                <Icon name="next" size="sm" />
              </button>
            ) : null}
          </div>

          <div className="flex min-w-30 flex-1 flex-col gap-1.5">
            <div className={`flex items-center justify-between gap-2 ${HUD_LBL}`}>
              <span>{formatReplayClock(elapsedS)}</span>
              {lapMarkers.length > 1 ? (
                <div className="hidden items-center gap-1 sm:flex">
                  {lapMarkers.slice(0, 8).map((m) => (
                    <button
                      key={`lap-${m.lap}-${m.timeS}`}
                      type="button"
                      onClick={() => onSeek(m.timeS)}
                      className="lc-mono cursor-pointer rounded-lc-nub border border-white/10 bg-lc-void/70 px-1.5 py-0.5 text-[10px] font-semibold text-lc-fog transition-colors hover:border-white/25 hover:text-lc-chalk"
                      title={`Jump to Lap ${m.lap}`}
                    >
                      L{m.lap}
                    </button>
                  ))}
                </div>
              ) : null}
              <span>{formatReplayClock(durationS)}</span>
            </div>
            <div className="relative flex items-center">
              <input
                type="range"
                aria-label="Replay timeline"
                aria-valuetext={`${formatReplayClock(elapsedS)} of ${formatReplayClock(durationS)}`}
                min={startS}
                max={endS}
                step={0.01}
                value={shown}
                onChange={(e) => onSeek(Number(e.target.value))}
                onPointerUp={(e) => e.currentTarget.blur()}
                className="lc-range -my-2 h-6 w-full [--lc-track:8px]"
                style={{ "--lc-fill": `${fill.toFixed(2)}%` } as React.CSSProperties}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            aria-label="Playback speed"
            className="flex rounded-lc-row border border-lc-line bg-lc-void p-1"
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSpeed(s)}
                aria-pressed={speed === s}
                className={`lc-data h-8 min-w-9.5 rounded-lc-nub px-2 text-[12px] ${HUD_CONTROL} ${
                  Math.abs(s) === 4 ? "hidden sm:inline-flex items-center justify-center" : "inline-flex items-center justify-center"
                } ${speed === s ? HUD_CHOSEN : HUD_IDLE}`}
              >
                {speedText(s)}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {cars.length > 1 && focusedCar && onCycleCar ? (
              <div
                role="group"
                aria-label="Focused car"
                className="inline-flex items-center rounded-lc-row border border-lc-line bg-lc-void p-0.5"
              >
                <button
                  type="button"
                  onClick={() => onCycleCar(-1)}
                  aria-label="Previous car"
                  title="Previous car (Shift+Tab)"
                  className={`inline-flex size-8 cursor-pointer items-center justify-center rounded-lc-nub text-lc-fog hover:text-lc-chalk ${HUD_CONTROL}`}
                >
                  <Icon name="previous" size="xs" />
                </button>
                <button
                  type="button"
                  onClick={() => onCycleCar(1)}
                  title="Switch focused car (Tab)"
                  className="inline-flex h-8 min-w-16 cursor-pointer items-center justify-center gap-1.5 px-2 text-[12px] font-semibold text-lc-chalk"
                >
                  <span
                    aria-hidden
                    className="h-3 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: focusedCar.color }}
                  />
                  <span className="lc-mono tracking-[0.06em]">{focusedCar.label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onCycleCar(1)}
                  aria-label="Next car"
                  title="Next car (Tab)"
                  className={`inline-flex size-8 cursor-pointer items-center justify-center rounded-lc-nub text-lc-fog hover:text-lc-chalk ${HUD_CONTROL}`}
                >
                  <Icon name="next" size="xs" />
                </button>
              </div>
            ) : null}

            {onSelectCamera ? (
              <Select
                aria-label="Replay camera angle"
                options={cameraOptions}
                value={cameraMode}
                onChange={onSelectCamera}
                className="h-9 min-w-34 text-[12px]"
              />
            ) : (
              <Button variant="secondary" size="sm" icon={<Icon name="camera" />} onClick={onCycleCamera} title="Cycle replay camera">
                {cameraLabel}
              </Button>
            )}

            {onFlashback ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Icon name="restart" />}
                prompt={<KeyCap tone="ink">F</KeyCap>}
                onClick={onFlashback}
                title="Flashback — resume driving from this moment (F, invalidates current lap)"
              >
                Flashback
              </Button>
            ) : null}

            <Button variant="secondary" size="sm" prompt={<KeyCap>{exitKeyLabel}</KeyCap>} onClick={onExit}>
              Exit
            </Button>
          </div>
        </div>
      </section>

      <div
        aria-hidden
        className="lc-ui-zoom pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+18px)] left-1/2 z-40 hidden -translate-x-1/2 items-center gap-5 text-[13px] font-semibold whitespace-nowrap text-lc-fog sm:flex pointer-coarse:hidden short:hidden"
      >
        {inFreeCam ? (
          <span className="lc-mono text-[12px] text-lc-fog">
            Free cam · Drag look · WASD fly · Q/E height · Scroll speed · R reset
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-2">
              <KeyCap>Space</KeyCap>
              Play / pause
            </span>
            <span className="inline-flex items-center gap-2">
              <ArrowKeys set="horizontal" />
              Seek {SEEK_STEP_S} s
            </span>
            <span className="inline-flex items-center gap-2">
              <KeyCap>,</KeyCap>
              <KeyCap>.</KeyCap>
              Step
            </span>
            {cars.length > 1 ? (
              <span className="inline-flex items-center gap-2">
                <KeyCap>Tab</KeyCap>
                Switch car
              </span>
            ) : null}
            {onFlashback ? (
              <span className="inline-flex items-center gap-2">
                <KeyCap>F</KeyCap>
                Flashback
              </span>
            ) : null}
          </>
        )}
      </div>
    </>
  );
};
