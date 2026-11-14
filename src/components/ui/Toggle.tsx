"use client";

import React from "react";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { useRowControl, type ControlA11yProps } from "./SettingRow";
import { cx, DISABLED, MOTION } from "./styles";

export interface ToggleProps extends ControlA11yProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The state written beside the switch, so colour is not alone (default "On" / "Off") */
  onLabel?: string;
  offLabel?: string;
  /** Leave the state word out (only where the row says it another way) */
  hideState?: boolean;
  /** Shows the cursor without the focus (the kit's state sheets); in a row the row takes it */
  forceCursor?: boolean;
  className?: string;
}

/**
 * The 30 x 56 switch: on is a chalk track with a void knob, off a titanium track with a slate knob. The state is
 * written beside it. Enter / A flips it; in a `SettingRow` the row takes the cursor ring and a click on the label
 * flips it too.
 */
export function Toggle({
  checked,
  onChange,
  onLabel = "On",
  offLabel = "Off",
  hideState,
  forceCursor,
  className,
  ...a11yProps
}: ToggleProps) {
  const { row, disabled, navDefault, a11y } = useRowControl(a11yProps);
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-2.5", className)}>
      {hideState ? null : (
        <span aria-hidden className="lc-chip-text min-w-6 text-right text-lc-slate">
          {checked ? onLabel : offLabel}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        {...a11y}
        data-row-quiet={row ? "" : undefined}
        data-nav-default={navDefault ? "" : undefined}
        data-cursor={forceCursor && !row ? "" : undefined}
        onPointerEnter={focusOnHover}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        className={cx(
          "group relative h-7.5 w-14 shrink-0 cursor-pointer rounded-full",
          // A 44 px target on touch screens without growing the drawing
          "before:absolute before:-inset-x-1 pointer-coarse:before:-inset-y-1.75",
          "focus-visible:outline-offset-3 data-cursor:outline-2 data-cursor:outline-offset-3 data-cursor:outline-lc-volt",
          MOTION,
          DISABLED,
          checked
            ? "bg-lc-chalk active:bg-lc-fog"
            : "bg-lc-titanium inset-ring inset-ring-lc-line hover:inset-ring-lc-keyline active:bg-lc-carbon",
        )}
      >
        <span
          aria-hidden
          className={cx(
            "absolute top-1.25 left-1.25 size-5 rounded-full transition-[translate,background-color] duration-200 ease-lc",
            checked ? "translate-x-6.5 bg-lc-void" : "translate-x-0 bg-lc-slate",
          )}
        />
      </button>
    </span>
  );
}
