"use client";

import React, { useRef } from "react";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { useRowControl, type ControlA11yProps } from "./SettingRow";
import { cx } from "./styles";

export interface SliderProps extends ControlA11yProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** The step while a key is held down or with Shift (default a tenth of the range) */
  bigStep?: number;
  /** Read-out text (default the value plus `unit`) */
  format?: (value: number) => string;
  /** Unit after the value in the default read-out ("%", " m") */
  unit?: string;
  /** Draws a tick at the default value */
  defaultValue?: number;
  /** Hide the read-out (only where the row shows the value another way) */
  hideValue?: boolean;
  className?: string;
}

/** Key repeats before a held arrow switches to the big step */
const ACCEL_AFTER = 6;

const decimalsOf = (n: number) => (String(n).split(".")[1] ?? "").length;

/**
 * A 6 px track with the volt fill to the value, the chalk thumb with a volt ring (`.lc-range`), and the value in
 * `lc-data` on the right. Left / right step it (held: bigger steps; Shift or LT / RT on a pad: the big step).
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  bigStep,
  format,
  unit = "",
  defaultValue,
  hideValue,
  className,
  ...a11yProps
}: SliderProps) {
  const { row, disabled, navDefault, a11y } = useRowControl(a11yProps);
  const repeats = useRef(0);
  const span = max - min || 1;
  const pct = ((Math.min(max, Math.max(min, value)) - min) / span) * 100;
  const big = bigStep ?? Math.max(step, Math.round(span / 10 / step) * step);
  const decimals = Math.max(decimalsOf(step), decimalsOf(min));
  const text = format ? format(value) : `${value.toFixed(decimals)}${unit}`;

  const commit = (next: number) => {
    if (disabled) return;
    const snapped = Math.min(max, Math.max(min, min + Math.round((next - min) / step) * step));
    const clean = Number(snapped.toFixed(decimals));
    if (clean !== value) onChange(clean);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // Handled here (the menu navigation sees defaultPrevented and leaves it): a held key speeds up
    e.preventDefault();
    repeats.current = e.repeat ? repeats.current + 1 : 0;
    const size = e.shiftKey || repeats.current >= ACCEL_AFTER ? big : step;
    commit(value + (e.key === "ArrowRight" ? size : -size));
  };

  return (
    <span className={cx("flex w-64 max-w-full min-w-0 items-center gap-3 phone:w-full", className)}>
      <span className="relative flex h-11 min-w-0 flex-1 items-center">
        {defaultValue !== undefined ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lc-fog/70"
            // The thumb's centre travels from 10 px to the width less 10 px
            style={{ left: `calc(10px + (100% - 20px) * ${(Math.min(max, Math.max(min, defaultValue)) - min) / span})` }}
          />
        ) : null}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          {...a11y}
          aria-valuetext={text}
          data-row-quiet={row ? "" : undefined}
          data-nav-default={navDefault ? "" : undefined}
          onPointerEnter={focusOnHover}
          onKeyDown={onKeyDown}
          onKeyUp={() => {
            repeats.current = 0;
          }}
          onChange={(e) => commit(Number(e.target.value))}
          className={cx(
            "lc-range relative",
            disabled ? "cursor-not-allowed opacity-40 [&::-webkit-slider-thumb]:cursor-not-allowed" : undefined,
          )}
          style={{ "--lc-fill": `${pct}%` } as React.CSSProperties}
        />
      </span>
      {hideValue ? null : (
        <span aria-hidden className="lc-data min-w-16 shrink-0 text-right text-[14px] whitespace-nowrap text-lc-chalk">
          {text}
        </span>
      )}
    </span>
  );
}
