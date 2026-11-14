"use client";

import React from "react";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { Icon } from "./icons/Icon";
import { CHOSEN_TILE, CURSOR_TILE, cx, DISABLED, IDLE_TILE, MOTION } from "./styles";

export interface OptionTileGroupProps {
  /** Accessible name of the group (a row or card heading names it on screen) */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Columns from `sm` up (one column on phones); default 3 */
  columns?: 2 | 3 | 4;
  children: React.ReactNode;
  className?: string;
}

const COLUMNS = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" } as const;

/** The radio group around a set of `OptionTile`s, laid out as a grid */
export function OptionTileGroup({ columns = 3, children, className, ...aria }: OptionTileGroupProps) {
  return (
    <div role="radiogroup" {...aria} className={cx("grid grid-cols-1 gap-2", COLUMNS[columns], className)}>
      {children}
    </div>
  );
}

export interface OptionTileProps {
  checked: boolean;
  onSelect: () => void;
  title: React.ReactNode;
  /** One line under the title */
  description?: React.ReactNode;
  /** A picture or diagram above the title */
  media?: React.ReactNode;
  disabled?: boolean;
  forceCursor?: boolean;
  /** Where a controller lands when it enters the group */
  navDefault?: boolean;
  /** A click on the chosen tile calls `onSelect` again (a preset tile that puts its values back) */
  reselect?: boolean;
  className?: string;
}

/**
 * A choice tile: title, one line of description, an optional picture. Chosen is the 1.5 px white edge with a check,
 * the cursor the volt edge and halo. The D-pad moves the cursor between tiles; Enter / A or a click chooses.
 */
export function OptionTile({
  checked,
  onSelect,
  title,
  description,
  media,
  disabled,
  forceCursor,
  navDefault,
  reselect,
  className,
}: OptionTileProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      data-cursor={forceCursor ? "" : undefined}
      data-own-ring=""
      data-nav-default={navDefault ? "" : undefined}
      onPointerEnter={focusOnHover}
      onClick={() => {
        if (!disabled && (reselect || !checked)) onSelect();
      }}
      className={cx(
        "group relative flex min-h-14 min-w-0 cursor-pointer flex-col items-start gap-1 rounded-lc-tile border-[1.5px] p-3 text-left",
        "active:bg-white/2",
        MOTION,
        DISABLED,
        checked ? CHOSEN_TILE : IDLE_TILE,
        CURSOR_TILE,
        className,
      )}
    >
      {media ? <span className="mb-1.5 block w-full overflow-hidden rounded-lc-nub">{media}</span> : null}
      <span className="flex w-full items-start justify-between gap-2">
        <span className={cx("min-w-0 text-[15px] leading-tight font-semibold", checked ? "text-lc-chalk" : "text-lc-fog")}>
          {title}
        </span>
        {checked ? <Icon name="success" className="mt-px text-lc-chalk" /> : null}
      </span>
      {description ? (
        <span className={cx("line-clamp-2 text-[12px] leading-[1.4]", checked ? "text-lc-fog" : "text-lc-slate")}>
          {description}
        </span>
      ) : null}
    </button>
  );
}
