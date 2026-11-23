"use client";

import React, { useEffect, useRef } from "react";
import { focusOnHover, useMoveHandler } from "@/components/menu/useFocusNav";
import { useRowControl, type ControlA11yProps } from "./SettingRow";
import { CHOSEN_PILL, CURSOR_PILL, cx, DISABLED, HOVER_PILL, MOTION, PRESSED_PILL } from "./styles";

export interface SegmentedOption<T extends string> {
  id: T;
  label: React.ReactNode;
  /** Leading icon (16 px) */
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Accessible name when the label is not plain words */
  "aria-label"?: string;
}

export interface SegmentedProps<T extends string> extends ControlA11yProps {
  /** 2 to 5 short options; more, or long labels, belong in a `Select` */
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** `md` 40 px options, `sm` 36 */
  size?: "md" | "sm";
  /** Options share the full width of the container */
  fill?: boolean;
  /**
   * With `fill`: each option takes room in proportion to its label instead of an equal share, for a row whose labels
   * differ a lot in length (five tyre compounds), so a long one does not crowd its neighbour
   */
  byContent?: boolean;
  /**
   * Options share the track's width, and the track sets no width of its own: it takes what its container gives it, as
   * a block or a flex item would (the older segmented rows, laid out by their callers)
   */
  stretch?: boolean;
  /** Forces the cursor onto this option (the kit's state sheets) */
  forceCursorOn?: T;
  className?: string;
}

/**
 * Pill segmented control: the option it is set to is chosen (white), the cursor is volt. It is a radio group: left /
 * right (keys or D-pad) move to the next option and choose it, and stop at the ends instead of leaving the row;
 * a click chooses; entering the group lands on the chosen option.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  fill,
  byContent,
  stretch,
  forceCursorOn,
  className,
  ...a11yProps
}: SegmentedProps<T>) {
  const { disabled, navDefault, a11y } = useRowControl(a11yProps);
  const groupRef = useRef<HTMLDivElement>(null);
  const hasChosen = options.some((o) => o.id === value);

  /** Chooses and focuses the next usable option that way; true when the focus is in this group */
  const step = (sign: 1 | -1): boolean => {
    const group = groupRef.current;
    const active = document.activeElement;
    if (!group || !active || !group.contains(active)) return false;
    if (disabled) return true;
    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    let i = buttons.indexOf(active as HTMLButtonElement);
    for (;;) {
      i += sign;
      if (i < 0 || i >= options.length) return true;
      if (!options[i].disabled) break;
    }
    buttons[i]?.focus({ preventScroll: true });
    if (options[i].id !== value) onChange(options[i].id);
    return true;
  };

  // Changed from outside while the cursor is in the group (a shortcut key): the cursor follows the choice, so the
  // volt fill never sits on an option that is not the chosen one
  useEffect(() => {
    const group = groupRef.current;
    const active = document.activeElement;
    if (!group || !active || !group.contains(active)) return;
    const chosen = group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (chosen && chosen !== active) chosen.focus({ preventScroll: true });
  }, [value]);

  // A D-pad left / right never reaches the keydown handler: the navigation asks this first
  useMoveHandler((dir) => (dir === "left" ? step(-1) : dir === "right" ? step(1) : false));

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      {...a11y}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        if (step(e.key === "ArrowRight" ? 1 : -1)) e.preventDefault();
      }}
      className={cx(
        "flex rounded-full bg-lc-void p-1 inset-ring inset-ring-lc-line",
        stretch ? undefined : cx("max-w-full min-w-0", fill ? "w-full" : "w-fit"),
        className,
      )}
    >
      {options.map((o, i) => {
        const chosen = o.id === value;
        const off = disabled || o.disabled;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={o["aria-label"]}
            aria-disabled={off || undefined}
            tabIndex={chosen || (!hasChosen && i === 0) ? 0 : -1}
            data-nav-default={navDefault && chosen ? "" : undefined}
            data-cursor={forceCursorOn === o.id ? "" : undefined}
            onPointerEnter={focusOnHover}
            onClick={() => {
              if (!off && !chosen) onChange(o.id);
            }}
            className={cx(
              "inline-flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-full px-3.5 leading-tight font-semibold",
              "pointer-coarse:min-h-11 phone:px-2 phone:text-[13px] [&_svg]:size-4 [&_svg]:shrink-0",
              size === "md" ? "min-h-10 text-[14px]" : "min-h-9 text-[13px]",
              fill || stretch ? (byContent ? "flex-auto px-3" : "flex-1") : undefined,
              MOTION,
              DISABLED,
              chosen ? CHOSEN_PILL : cx("text-lc-slate", HOVER_PILL),
              PRESSED_PILL,
              CURSOR_PILL,
            )}
          >
            {o.icon ? <span aria-hidden className="inline-flex">{o.icon}</span> : null}
            <span className={cx("min-w-0", byContent ? "whitespace-nowrap" : "text-balance")}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
