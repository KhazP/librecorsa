"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons/Icon";
import { focusables, focusOnHover } from "@/components/menu/useFocusNav";
import { SettingsDetailProvider } from "./SettingRow";
import { CURSOR_ROW, cx, MOTION } from "./styles";

export interface DisclosureProps {
  /** The rows it reveals (advanced `SettingRow`s show inside it even in Simple mode) */
  children: React.ReactNode;
  /** Closed label (default "More") */
  moreLabel?: string;
  /** Open label (default "Less") */
  lessLabel?: string;
  /** How many rows it holds, said after the closed label ("More (3)") */
  count?: number;
  forceCursor?: boolean;
  className?: string;
}

/**
 * A "More" / "Less" row that reveals advanced rows inline, above it, the chevron turning as it opens. Opened from
 * the keys or a pad, the cursor moves onto the first revealed row. It remembers nothing: it starts closed each time
 * the screen opens.
 */
export function Disclosure({ children, moreLabel = "More", lessLabel = "Less", count, forceCursor, className }: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  /** Opened from the keys or a pad: the cursor moves onto the first revealed row */
  const moveIn = useRef(false);
  useEffect(() => {
    if (!open || !moveIn.current) return;
    moveIn.current = false;
    const first = panelRef.current ? focusables(panelRef.current)[0] : undefined;
    // A segmented row is entered on the option it is set to
    const chosen = first?.closest('[role="radiogroup"]')?.querySelector<HTMLElement>('[aria-checked="true"]');
    (chosen ?? first)?.focus({ preventScroll: false, focusVisible: true } as FocusOptions);
  }, [open]);
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      {open ? (
        <div ref={panelRef} id={panelId} className="flex min-w-0 flex-col gap-1">
          <SettingsDetailProvider value="advanced">{children}</SettingsDetailProvider>
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-cursor={forceCursor ? "" : undefined}
        onPointerEnter={focusOnHover}
        onClick={(e) => {
          // A click from Enter or a pad's A has no pointer behind it (detail 0)
          moveIn.current = !open && e.detail === 0;
          setOpen(!open);
        }}
        className={cx(
          "-mx-2 flex min-h-11 cursor-pointer items-center gap-2 rounded-lc-row px-2 text-left text-lc-slate hover:bg-white/4 hover:text-lc-chalk active:bg-white/2",
          MOTION,
          CURSOR_ROW,
        )}
      >
        <Icon
          name="expand"
          className={cx("transition-transform duration-200 ease-lc", open ? "rotate-180" : undefined)}
        />
        <span className="text-[14px] font-semibold">
          {open ? lessLabel : moreLabel}
          {!open && count ? <span className="lc-mono ml-1.5 text-lc-slate">({count})</span> : null}
        </span>
      </button>
    </div>
  );
}
