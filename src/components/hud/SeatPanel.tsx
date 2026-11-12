"use client";

import React, { useEffect, useRef, useState } from "react";
import { CAMERA_MODES } from "@/lib/render/camera-modes";
import {
  NUDGE_FOV_STEP_DEG,
  NUDGE_STEP_M,
  NUDGE_TILT_STEP_DEG,
  NUDGE_VIEWS,
  type CameraNudge,
  type NudgeView,
} from "@/lib/settings/camera-nudges";
import { keyLabel } from "@/lib/input/bindings";
import { PadGlyph } from "@/components/menu/pad-glyph";
import { useInputMode } from "@/components/menu/input-mode";

export interface SeatPanelProps {
  carTitle: string;
  view: NudgeView;
  nudge: CameraNudge;
  /** The view's vertical FOV now (the FOV row shows it) */
  fovDeg: number;
  /** Moves the view a step; null puts the whole view back where the car puts it */
  onStep: (step: Partial<CameraNudge> | null) => void;
  onSetView: (view: NudgeView) => void;
  onClose: () => void;
  /** The camera key(s) and pad button, which close the panel as they opened it */
  cameraKeys: readonly string[];
  cameraButton: number | null;
}

type RowKey = "view" | keyof CameraNudge;

interface Row {
  key: RowKey;
  label: string;
  less: string;
  more: string;
  step: number;
}

const ROWS: readonly Row[] = [
  { key: "view", label: "View", less: "Cockpit view", more: "Dash view", step: 1 },
  { key: "fwd", label: "Forward", less: "Move back", more: "Move forward", step: NUDGE_STEP_M },
  { key: "up", label: "Height", less: "Move down", more: "Move up", step: NUDGE_STEP_M },
  { key: "right", label: "Side", less: "Move left", more: "Move right", step: NUDGE_STEP_M },
  { key: "tiltDeg", label: "Tilt", less: "Tilt down", more: "Tilt up", step: NUDGE_TILT_STEP_DEG },
  { key: "fovDeg", label: "FOV", less: "Narrower", more: "Wider", step: NUDGE_FOV_STEP_DEG },
];

const REPEAT_DELAY_MS = 300;
const REPEAT_RATE_MS = 60;

/** Standard-mapping buttons the panel reads */
const PAD = { a: 0, b: 1, x: 2, up: 12, down: 13, left: 14, right: 15 } as const;

const ROUND_BTN =
  "flex h-[30px] w-[30px] shrink-0 cursor-pointer touch-none items-center justify-center rounded-full border border-white/15 bg-black/30 font-f1-mono text-[15px] font-extrabold text-[#F5F7FA] transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00] active:bg-[#CCFF00] active:text-[#08090D]";

/** A − / + button that keeps stepping while it is held */
const HoldButton: React.FC<{ onStep: () => void; label: string; children: React.ReactNode }> = ({ onStep, label, children }) => {
  const timer = useRef<number | null>(null);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      tabIndex={-1}
      className={ROUND_BTN}
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault();
        stop();
        stepRef.current();
        const repeat = (delay: number) => {
          timer.current = window.setTimeout(() => {
            stepRef.current();
            repeat(REPEAT_RATE_MS);
          }, delay);
        };
        repeat(REPEAT_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {children}
    </button>
  );
};

function formatValue(row: Row, nudge: CameraNudge, fovDeg: number): string {
  if (row.key === "view") return "";
  const v = nudge[row.key];
  if (row.key === "fovDeg") return `${Math.round(fovDeg)}°`;
  if (row.key === "tiltDeg") return v === 0 ? "0°" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}°`;
  const cm = Math.round(v * 100);
  return cm === 0 ? "0 cm" : `${cm > 0 ? "+" : "−"}${Math.abs(cm)} cm`;
}

/** A key cap for the legend */
const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[6px] border border-white/25 bg-black/40 px-1.5 font-f1-mono text-[10px] font-extrabold text-[#F5F7FA]">
    {children}
  </span>
);

/**
 * The seat: moves the cockpit or dash view of the car being driven and sets its FOV, kept for that car. Held camera
 * key or button opens it (the car waits); arrows or the D-pad pick a row and change it, the mouse uses − / +. It
 * stays see-through so the view it changes shows behind it.
 */
export const SeatPanel: React.FC<SeatPanelProps> = (p) => {
  const [row, setRow] = useState(0);
  const { mode, family } = useInputMode();
  // The latest props for the key and pad handlers, which are attached once
  const latest = useRef(p);
  latest.current = p;
  const rowRef = useRef(row);
  rowRef.current = row;

  /** Changes the row by `dir` (−1 / +1): the view row switches view, the others step */
  const change = (index: number, dir: -1 | 1) => {
    const { view, onStep, onSetView } = latest.current;
    const r = ROWS[index];
    if (r.key === "view") {
      const next = NUDGE_VIEWS[(NUDGE_VIEWS.indexOf(view) + (dir > 0 ? 1 : NUDGE_VIEWS.length - 1)) % NUDGE_VIEWS.length];
      onSetView(next);
      return;
    }
    onStep({ [r.key]: dir * r.step });
  };
  /** Puts one row back where the car puts it (the view row: nothing to reset) */
  const resetRow = (index: number) => {
    const { nudge, onStep } = latest.current;
    const r = ROWS[index];
    if (r.key === "view") return;
    if (nudge[r.key] !== 0) onStep({ [r.key]: -nudge[r.key] });
  };
  const changeRef = useRef(change);
  changeRef.current = change;
  const resetRef = useRef(resetRow);
  resetRef.current = resetRow;

  // Keyboard: ↑ ↓ pick a row, ← → change it (held keys repeat), Enter resets the row, R the view, Esc or the camera key
  // closes. The drive leaves the keyboard to the panel while it is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const { onClose, onStep, cameraKeys } = latest.current;
      const code = e.code;
      let handled = true;
      if (code === "ArrowUp") setRow((r) => (r + ROWS.length - 1) % ROWS.length);
      else if (code === "ArrowDown") setRow((r) => (r + 1) % ROWS.length);
      else if (code === "ArrowLeft") changeRef.current(rowRef.current, -1);
      else if (code === "ArrowRight") changeRef.current(rowRef.current, 1);
      else if (code === "Enter" || code === "NumpadEnter") resetRef.current(rowRef.current);
      else if (code === "KeyR" && !e.repeat) onStep(null);
      else if ((code === "Escape" || cameraKeys.includes(code)) && !e.repeat) onClose();
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pad: D-pad ▲ ▼ pick a row, ◀ ▶ change it (held, it repeats), A resets the row, X the view, B or the camera button
  // closes. Buttons already down when the panel opens (the held camera button) count only once let go
  useEffect(() => {
    let raf = 0;
    let prev: boolean[] | null = null;
    const repeatAt: Record<number, number> = {};
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const pad = Array.from(navigator.getGamepads?.() ?? []).find((g) => g && g.mapping === "standard");
      if (!pad) return;
      const down = pad.buttons.map((b) => b.pressed || b.value > 0.5);
      const was = prev ?? down;
      prev = down;
      const now = performance.now();
      const pressed = (i: number) => down[i] && !was[i];
      const repeating = (i: number) => {
        if (!down[i]) return false;
        if (!was[i]) {
          repeatAt[i] = now + REPEAT_DELAY_MS;
          return true;
        }
        if (now >= (repeatAt[i] ?? Infinity)) {
          repeatAt[i] = now + REPEAT_RATE_MS;
          return true;
        }
        return false;
      };
      const { onClose, onStep, cameraButton } = latest.current;
      if (pressed(PAD.up)) setRow((r) => (r + ROWS.length - 1) % ROWS.length);
      if (pressed(PAD.down)) setRow((r) => (r + 1) % ROWS.length);
      if (repeating(PAD.left)) changeRef.current(rowRef.current, -1);
      if (repeating(PAD.right)) changeRef.current(rowRef.current, 1);
      if (pressed(PAD.a)) resetRef.current(rowRef.current);
      if (pressed(PAD.x)) onStep(null);
      if (pressed(PAD.b) || (cameraButton !== null && pressed(cameraButton))) onClose();
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, []);

  const moved = Object.values(p.nudge).some((v) => v !== 0);
  const pad = mode === "pad";
  const cameraKey = keyLabel(p.cameraKeys[0]);

  return (
    <div
      className="pointer-events-none fixed inset-y-0 left-0 z-40 flex items-center p-3 sm:p-5"
      role="dialog"
      aria-modal="false"
      aria-label={`Seat and camera, ${p.carTitle}`}
    >
      <div className="pointer-events-auto flex w-[330px] max-w-[calc(100vw-24px)] flex-col gap-2.5 rounded-[24px] border border-white/10 bg-[#0A0B10]/55 p-3 text-[#F5F7FA] shadow-[0_20px_50px_rgba(0,0,0,0.35)] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <h2 className="lc-title text-[18px] leading-none">Seat &amp; camera</h2>
          <span className="truncate font-f1-mono text-[10px] font-extrabold tracking-[0.1em] text-[#C9CFDB] uppercase">{p.carTitle}</span>
        </div>

        <div className="flex flex-col gap-1">
          {ROWS.map((r, i) => {
            const active = i === row;
            const zero = r.key !== "view" && p.nudge[r.key] === 0;
            return (
              <div
                key={r.key}
                onPointerDown={() => setRow(i)}
                className={`flex h-[42px] items-center gap-2 rounded-[14px] px-2 transition-colors ${
                  active ? "bg-[#CCFF00]/[0.14] shadow-[inset_0_0_0_1px_rgba(204,255,0,0.55)]" : "bg-black/20"
                }`}
              >
                <span className={`w-[64px] font-f1-mono text-[11px] font-extrabold tracking-[0.12em] uppercase ${active ? "text-[#CCFF00]" : "text-[#C9CFDB]"}`}>
                  {r.label}
                </span>
                {r.key === "view" ? (
                  <div className="flex flex-1 gap-1" role="radiogroup" aria-label="View">
                    {NUDGE_VIEWS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        tabIndex={-1}
                        role="radio"
                        aria-checked={p.view === v}
                        onClick={() => p.onSetView(v)}
                        className={`h-[30px] flex-1 cursor-pointer rounded-full font-f1-mono text-[11px] font-extrabold tracking-[0.1em] uppercase transition-colors ${
                          p.view === v ? "bg-[#CCFF00] text-[#08090D] [text-shadow:none]" : "bg-black/30 text-[#C9CFDB] hover:text-[#F5F7FA]"
                        }`}
                      >
                        {CAMERA_MODES[v].label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <HoldButton label={r.less} onStep={() => change(i, -1)}>
                      −
                    </HoldButton>
                    <span
                      className="flex-1 text-center font-f1-mono text-[15px] font-extrabold tabular-nums"
                      style={{ color: zero ? "#C9CFDB" : "#CCFF00" }}
                    >
                      {formatValue(r, p.nudge, p.fovDeg)}
                    </span>
                    <HoldButton label={r.more} onStep={() => change(i, 1)}>
                      +
                    </HoldButton>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            tabIndex={-1}
            disabled={!moved}
            onClick={() => p.onStep(null)}
            className="h-[36px] flex-1 cursor-pointer rounded-full bg-black/30 font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#C9CFDB] uppercase transition-colors hover:text-[#CCFF00] disabled:cursor-default disabled:opacity-40 disabled:hover:text-[#C9CFDB]"
          >
            Reset view
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={p.onClose}
            className="h-[36px] flex-1 cursor-pointer rounded-full bg-[#CCFF00] font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#08090D] uppercase [text-shadow:none]"
          >
            Done
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-1 font-f1-mono text-[10px] font-extrabold text-[#C9CFDB]">
          {pad ? (
            <>
              <span className="flex items-center gap-1">
                <PadGlyph button="dpad" family={family} /> row · change
              </span>
              <span className="flex items-center gap-1">
                <PadGlyph button="a" family={family} /> reset row
              </span>
              <span className="flex items-center gap-1">
                <PadGlyph button="x" family={family} /> reset view
              </span>
              <span className="flex items-center gap-1">
                <PadGlyph button="b" family={family} /> done
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1">
                <Key>↑↓</Key> row
              </span>
              <span className="flex items-center gap-1">
                <Key>←→</Key> change
              </span>
              <span className="flex items-center gap-1">
                <Key>Enter</Key> reset row
              </span>
              <span className="flex items-center gap-1">
                <Key>R</Key> reset view
              </span>
              <span className="flex items-center gap-1">
                <Key>Esc</Key> or <Key>{cameraKey}</Key> done
              </span>
            </>
          )}
        </div>
        <p className="px-1 text-[11px] leading-snug text-[#C9CFDB]">Kept for this car. The car waits while this is open.</p>
      </div>
    </div>
  );
};
