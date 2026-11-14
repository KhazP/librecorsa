"use client";

import React, { useEffect, useRef } from "react";
import { Icon } from "./icons/Icon";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { useRowControl, type ControlA11yProps } from "./SettingRow";
import { cx, MOTION } from "./styles";

export interface StepperProps extends ControlA11yProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Read-out text (default the number) */
  format?: (value: number) => string;
  forceCursor?: boolean;
  className?: string;
}

const HOLD_DELAY_MS = 400;
const HOLD_RATE_MS = 90;

/**
 * Minus, the value, plus: for small integer ranges (laps, opponents, cars drawn in full). The part that takes the
 * focus is a range input laid over the whole control, so left / right step it from the keyboard and the D-pad alike
 * (the menu navigation adjusts range inputs), and a screen reader hears one slider. The two round buttons are for the
 * mouse and touch; they hold to repeat.
 */
export function Stepper({ value, onChange, min, max, step = 1, format, forceCursor, className, ...a11yProps }: StepperProps) {
  const { row, disabled, navDefault, a11y } = useRowControl(a11yProps);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const text = format ? format(value) : String(value);
  const width = Math.max((format ? format(min) : String(min)).length, (format ? format(max) : String(max)).length);

  const set = (next: number) => {
    if (disabled) return;
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== latest.current) {
      latest.current = clamped;
      onChange(clamped);
    }
  };
  const stopHold = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stopHold, []);

  const startHold = (sign: 1 | -1) => (e: React.PointerEvent<HTMLButtonElement>) => {
    // Keep the focus on the range input, where the keys and the row ring live
    e.preventDefault();
    inputRef.current?.focus({ preventScroll: true });
    set(latest.current + sign * step);
    const repeat = (delay: number) => {
      timer.current = window.setTimeout(() => {
        set(latest.current + sign * step);
        // At the limit the button turns disabled, and some browsers then send it no pointerup: the hold ends here, or
        // it would keep pushing a later key step straight back to the limit
        if (sign > 0 ? latest.current >= max : latest.current <= min) {
          timer.current = null;
          return;
        }
        repeat(HOLD_RATE_MS);
      }, delay);
    };
    stopHold();
    repeat(HOLD_DELAY_MS);
  };

  const stepButton = (sign: 1 | -1) => {
    const off = disabled || (sign < 0 ? value <= min : value >= max);
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        data-nav-skip=""
        disabled={off}
        onPointerDown={startHold(sign)}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
        onPointerCancel={stopHold}
        className={cx(
          "relative z-10 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-lc-fog",
          "hover:bg-white/6 hover:text-lc-chalk active:bg-lc-titanium disabled:cursor-not-allowed disabled:opacity-30",
          "pointer-coarse:size-11",
          MOTION,
        )}
      >
        <Icon name={sign < 0 ? "remove" : "add"} />
      </button>
    );
  };

  return (
    <span
      data-cursor={forceCursor && !row ? "" : undefined}
      // The input takes no pointer events (the buttons do), so hovering the control focuses it from here
      onPointerEnter={(e) => {
        if (inputRef.current) {
          focusOnHover({
            pointerType: e.pointerType,
            clientX: e.clientX,
            clientY: e.clientY,
            currentTarget: inputRef.current,
          } as unknown as React.PointerEvent<HTMLElement>);
        }
      }}
      className={cx(
        "relative inline-flex h-10 shrink-0 items-center gap-1 rounded-full bg-lc-void p-1 inset-ring inset-ring-lc-line pointer-coarse:h-12",
        // On its own the control rings itself; in a row the row does
        row ? undefined : "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-lc-volt",
        row ? undefined : "data-cursor:outline-2 data-cursor:outline-offset-2 data-cursor:outline-lc-volt",
        disabled ? "cursor-not-allowed opacity-40" : undefined,
        MOTION,
        className,
      )}
    >
      {stepButton(-1)}
      <span
        aria-hidden
        className="lc-data text-center text-[15px] text-lc-chalk"
        style={{ minWidth: `${Math.max(2, width) + 1}ch` }}
      >
        {text}
      </span>
      {stepButton(1)}
      <input
        ref={inputRef}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        {...a11y}
        aria-valuetext={text}
        data-row-quiet={row ? "" : undefined}
        data-nav-default={navDefault ? "" : undefined}
        onChange={(e) => set(Number(e.target.value))}
        className="pointer-events-none absolute inset-0 m-0 h-full w-full appearance-none opacity-0 outline-none"
      />
    </span>
  );
}
