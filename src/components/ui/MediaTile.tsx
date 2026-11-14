"use client";

import React from "react";
import Link from "next/link";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { Icon } from "./icons/Icon";
import { CHOSEN_TILE, CURSOR_TILE, cx, DISABLED, IDLE_TILE, MOTION } from "./styles";

interface CommonProps {
  /** The picture: an <img>, an outline, a render. It fills the frame; give it `object-cover` or `object-contain` */
  media: React.ReactNode;
  /** Shape of the picture frame (default 16 / 9) */
  aspect?: "video" | "wide" | "square" | "auto";
  title: React.ReactNode;
  /** One line of key facts under the title */
  meta?: React.ReactNode;
  /** Badges under the facts (`Badge`, `ClassTag`, `QualityBadge`) */
  badges?: React.ReactNode;
  /** Over the picture's top-left corner: a state badge ("Current", "New") */
  overlay?: React.ReactNode;
  /**
   * A second control such as a favourite `IconButton` or a source chip: on the picture's top-right corner (side by
   * side: on its own row under the text). It is a sibling of the tile's button, never inside it, so each has its
   * own focus.
   */
  action?: React.ReactNode;
  /** The tile is the one in use (white edge); the cursor is the volt edge */
  chosen?: boolean;
  /** Text and picture side by side from `sm` up instead of stacked */
  horizontal?: boolean;
  disabled?: boolean;
  forceCursor?: boolean;
  navDefault?: boolean;
  /**
   * Extra attributes and handlers for the tile's own button or link (a `data-*` hook, `onFocus`, `onDoubleClick`,
   * `aria-label`). Its look is not open: `className` goes on the wrapper.
   */
  controlProps?: Omit<React.HTMLAttributes<HTMLElement>, "className" | "children" | "onClick"> & {
    [key: `data-${string}`]: string | undefined;
  };
  className?: string;
}

type AsButton = { href?: undefined; onSelect: () => void; "aria-pressed"?: boolean };
type AsLink = { href: string; onSelect?: undefined; "aria-pressed"?: undefined };

export type MediaTileProps = CommonProps & (AsButton | AsLink);

const ASPECT = { video: "aspect-video", wide: "aspect-[2/1]", square: "aspect-square", auto: "" } as const;

/**
 * A picture tile: a car, a circuit, a livery. The whole tile is one button (or one link) with a picture frame, a
 * title, a line of facts and a row of badges; a second control goes in `action`. Chosen is the white edge with a check, the cursor
 * the volt edge and halo, as on `OptionTile`.
 */
export function MediaTile(props: MediaTileProps) {
  const {
    media,
    aspect = "video",
    title,
    meta,
    badges,
    overlay,
    action,
    chosen,
    horizontal,
    disabled,
    forceCursor,
    navDefault,
    controlProps,
    className,
  } = props;
  const classes = cx(
    "group relative flex h-full w-full min-w-0 cursor-pointer overflow-hidden rounded-lc-tile border-[1.5px] text-left",
    horizontal ? "flex-col sm:flex-row" : "flex-col",
    "active:bg-white/2",
    MOTION,
    DISABLED,
    chosen ? CHOSEN_TILE : IDLE_TILE,
    CURSOR_TILE,
  );
  const inner = (
    <>
      <span
        className={cx(
          "relative block shrink-0 overflow-hidden bg-lc-well [&>img]:size-full [&>svg]:size-full",
          ASPECT[aspect],
          horizontal ? "w-full sm:w-2/5" : "w-full",
        )}
      >
        {media}
        {overlay ? <span className="absolute top-2 left-2 flex flex-wrap gap-1">{overlay}</span> : null}
      </span>
      {/* Side by side, the action sits on its own row under the text; stacked, it sits on the picture */}
      <span className={cx("flex min-w-0 flex-1 flex-col gap-1 p-3", action && horizontal ? "pb-12" : undefined)}>
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span
            // A name cut short reads in full on hover (the tile's accessible name has all of it)
            title={typeof title === "string" ? title : undefined}
            className={cx("lc-title min-w-0 truncate text-[17px] leading-tight", chosen ? "text-lc-chalk" : "text-lc-fog group-hover:text-lc-chalk group-focus:text-lc-chalk")}
          >
            {title}
          </span>
          {chosen ? <Icon name="success" label="Chosen" className="mt-px shrink-0 text-lc-chalk" /> : null}
        </span>
        {meta ? <span className="lc-hint line-clamp-2">{meta}</span> : null}
        {badges ? <span className="mt-1 flex flex-wrap items-center gap-1">{badges}</span> : null}
      </span>
    </>
  );
  const shared = {
    ...controlProps,
    "aria-disabled": disabled || undefined,
    "data-cursor": forceCursor ? "" : undefined,
    "data-own-ring": "",
    "data-nav-default": navDefault ? "" : undefined,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      focusOnHover(e);
      controlProps?.onPointerEnter?.(e);
    },
    className: classes,
  };
  return (
    <div className={cx("relative min-w-0", className)}>
      {props.href !== undefined ? (
        <Link
          href={props.href}
          {...shared}
          // A disabled link tile stays put, as the button form does
          onClick={(e) => {
            if (disabled) e.preventDefault();
          }}
        >
          {inner}
        </Link>
      ) : (
        <button
          type="button"
          aria-pressed={props["aria-pressed"]}
          {...shared}
          onClick={() => {
            if (!disabled) props.onSelect();
          }}
        >
          {inner}
        </button>
      )}
      {action ? <span className={cx("absolute right-2 flex", horizontal ? "bottom-2" : "top-2")}>{action}</span> : null}
    </div>
  );
}
