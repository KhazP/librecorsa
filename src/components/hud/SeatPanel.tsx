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
import { connectedPads } from "@/lib/input/device-input";
import { useUnits } from "@/lib/settings/ui-prefs";
import { SMALL_LENGTH_LABEL, smallLengthIn } from "@/lib/settings/units";
import type { UnitSettings } from "@/lib/settings/player-settings";
import { Button, IconButton } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { PromptBar } from "@/components/ui/prompts";
import { HUD_GLASS } from "./hud-format";
import { CHOSEN_PILL, CURSOR_ROW, cx, HOVER_PILL, MOTION } from "@/components/ui/styles";

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

/** A − / + button that keeps stepping while it is held (pointer only: keys and the pad step the row) */
const HoldButton: React.FC<{ onStep: () => void; label: string; icon: "add" | "remove" }> = ({ onStep, label, icon }) => {
  const timer = useRef<number | null>(null);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  return (
    <IconButton
      size="sm"
      variant="secondary"
      tabIndex={-1}
      className="touch-none"
      aria-label={label}
      title={label}
      icon={<Icon name={icon} />}
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
    />
  );
};

function formatValue(row: Row, nudge: CameraNudge, fovDeg: number, units: UnitSettings): string {
  if (row.key === "view") return "";
  const v = nudge[row.key];
  if (row.key === "fovDeg") return `${Math.round(fovDeg)}°`;
  if (row.key === "tiltDeg") return v === 0 ? "0°" : `${v > 0 ? "+" : "\u2212"}${Math.abs(v).toFixed(1)}°`;
  // Offsets are stored in metres; shown in cm, or inches with miles per hour
  const unit = SMALL_LENGTH_LABEL[units.speed];
  const shown = smallLengthIn(v * 100, units.speed);
  const text = units.speed === "mph" ? Math.abs(shown).toFixed(1) : String(Math.abs(Math.round(shown)));
  if (Number(text) === 0) return `0 ${unit}`;
  return `${shown > 0 ? "+" : "\u2212"}${text} ${unit}`;
}

/**
 * The seat: moves the cockpit or dash view of the car being driven and sets its FOV, kept for that car. Held camera
 * key or button opens it (the car waits); arrows or the D-pad pick a row and change it, the mouse uses − / +. It
 * stays see-through so the view it changes shows behind it.
 */
export const SeatPanel: React.FC<SeatPanelProps> = (p) => {
  const [row, setRow] = useState(0);
  const units = useUnits();
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
      const pad = connectedPads().find((g) => g.mapping === "standard");
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
  const cameraKey = keyLabel(p.cameraKeys[0]);

  return (
    <div
      className="pointer-events-none fixed inset-y-0 left-0 z-(--z-lc-overlay) flex items-center p-3 sm:p-5"
      role="dialog"
      aria-modal="false"
      aria-label={`Seat and camera, ${p.carTitle}`}
    >
      {/* The HUD's own glass (74 % void, blurred), as on every panel over the scene */}
      <div
        className={`pointer-events-auto flex max-h-full w-[340px] max-w-[calc(100vw-24px)] flex-col gap-2.5 overflow-y-auto overscroll-contain rounded-lc-card p-3.5 text-lc-chalk [text-shadow:0_1px_2px_rgba(0,0,0,0.6)] ${HUD_GLASS}`}
      >
        <div className="flex flex-col gap-0.5 px-1">
          <h2 className="lc-h3">Seat and camera</h2>
          <span className="lc-hint truncate text-lc-fog" title={p.carTitle}>
            {p.carTitle}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          {ROWS.map((r, i) => {
            const active = i === row;
            const zero = r.key !== "view" && p.nudge[r.key] === 0;
            return (
              <div
                key={r.key}
                onPointerDown={() => setRow(i)}
                data-cursor={active ? "" : undefined}
                className={cx(
                  "flex min-h-11 shrink-0 items-center gap-2 rounded-lc-row px-2 py-0.5",
                  MOTION,
                  active ? CURSOR_ROW : "bg-lc-void/30",
                )}
              >
                <span className={`w-16 shrink-0 text-[13px] font-semibold ${active ? "text-lc-chalk" : "text-lc-fog"}`}>{r.label}</span>
                {r.key === "view" ? (
                  <div className="flex flex-1 gap-1 rounded-full bg-lc-void/80 p-1 inset-ring inset-ring-lc-line" role="radiogroup" aria-label="View">
                    {NUDGE_VIEWS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        tabIndex={-1}
                        role="radio"
                        aria-checked={p.view === v}
                        onClick={() => p.onSetView(v)}
                        className={cx(
                          "h-8 flex-1 cursor-pointer rounded-full text-[13px] font-semibold [text-shadow:none] pointer-coarse:h-9",
                          MOTION,
                          p.view === v ? CHOSEN_PILL : cx("text-lc-slate", HOVER_PILL),
                        )}
                      >
                        {CAMERA_MODES[v].label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <HoldButton label={r.less} icon="remove" onStep={() => change(i, -1)} />
                    <span className={`lc-mono flex-1 text-center text-[15px] font-bold ${zero ? "text-lc-slate" : "text-lc-chalk"}`}>
                      {formatValue(r, p.nudge, p.fovDeg, units)}
                    </span>
                    <HoldButton label={r.more} icon="add" onStep={() => change(i, 1)} />
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-2 [text-shadow:none]">
          <Button size="sm" variant="ghost" className="flex-1" tabIndex={-1} disabled={!moved} onClick={() => p.onStep(null)}>
            Reset view
          </Button>
          <Button size="sm" variant="primary" className="flex-1" tabIndex={-1} onClick={p.onClose}>
            Done
          </Button>
        </div>

        <PromptBar
          className="px-1 [text-shadow:none]"
          prompts={[
            { action: "move", label: "Row", key: "\u2191 \u2193", pad: "dpad-vertical" },
            { action: "adjust", label: "Change" },
            { action: "select", label: "Reset row" },
            { action: "start", label: "Reset view", key: "R", pad: "x" },
            { action: "back", label: "Done", key: `Esc / ${cameraKey}` },
          ]}
        />
        <p className="lc-hint m-0 px-1 text-lc-fog short:hidden">Kept for this car. The car waits while this is open.</p>
      </div>
    </div>
  );
};
