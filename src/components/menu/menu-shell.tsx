"use client";

import React, { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { KeyCap } from "@/components/ui/prompts/KeyCap";
import { PadGlyph } from "@/components/ui/prompts/PadGlyph";
import { PromptBar, type Prompt } from "@/components/ui/prompts/PromptBar";
import { CHOSEN_PILL, CURSOR_PILL, cx, GROUP_CURSOR_INK, HOVER_PILL, MOTION, PRESSED_PILL } from "@/components/ui/styles";
import { useInputMode } from "./input-mode";
import { focusables, focusOnHover, useMoveHandler, type Dir } from "./useFocusNav";

/**
 * The parts the two menu shells share (the title menu and the pause menu): the rail's rows, the one main action at
 * the top of a rail, the footer prompts, and the reading-order moves inside an open panel.
 */

export type RailRowSize = "lg" | "md" | "sm";

const ROW_SIZE: Record<RailRowSize, { box: string; label: string; icon: "lg" | "md" | "sm" }> = {
  // Race AI, Multiplayer on the title screen
  lg: {
    box: "w-full min-h-15 gap-4 rounded-lc-tile px-4 py-1.5 compact:min-h-13 phone:min-h-11 phone:gap-3 phone:px-3.5 phone:py-1",
    label: "lc-disp text-[24px] leading-none compact:text-[21px] phone:text-[17px]",
    icon: "lg",
  },
  // The setup grid of the title screen, the pause rail and the slim rail beside an open panel
  md: {
    box: "w-full min-h-12 gap-3 rounded-lc-row px-3.5 py-1 phone:min-h-11",
    label: "lc-title text-[16px] leading-tight phone:text-[15px]",
    icon: "md",
  },
  // The links under the title screen's grid
  sm: {
    box: "w-auto min-h-11 gap-2 rounded-full px-3",
    label: "text-[14px] font-semibold",
    icon: "sm",
  },
};

export interface RailRowProps {
  /** `data-rail-id`: the shells focus an entry by it, and the capture script finds it */
  id: string;
  label: string;
  /** One line under the label */
  detail?: string;
  icon: IconName;
  size?: RailRowSize;
  /** Its panel is open: chosen (chalk on line) while the cursor is elsewhere, volt only under the cursor */
  chosen?: boolean;
  /** `aria-expanded` for an entry that opens a panel (false while closed); absent for actions and links */
  expanded?: boolean;
  /** A link out, opened in a new tab, instead of an action */
  href?: string;
  onClick?: () => void;
  /** A tag after the label ("2 in lobby") */
  badge?: React.ReactNode;
  /** Label colour at rest: chalk, or slate for a quiet list (the slim rail beside a panel) */
  tone?: "chalk" | "slate";
  className?: string;
}

/** One entry of a menu rail: icon, label, an optional line under it; the cursor fills it volt */
export const RailRow: React.FC<RailRowProps> = ({ id, label, detail, icon, size = "md", chosen, expanded, href, onClick, badge, tone = "chalk", className }) => {
  const s = ROW_SIZE[size];
  const classes = cx(
    "group flex min-w-0 cursor-pointer items-center border-0 text-left no-underline",
    s.box,
    MOTION,
    chosen ? CHOSEN_PILL : cx("bg-transparent", tone === "slate" ? "text-lc-slate" : "text-lc-chalk", HOVER_PILL),
    PRESSED_PILL,
    CURSOR_PILL,
    className,
  );
  const inner = (
    <>
      <span className={cx("inline-flex shrink-0", chosen ? "text-lc-chalk" : "text-lc-slate group-hover:text-lc-fog", GROUP_CURSOR_INK)}>
        <Icon name={icon} size={s.icon} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className={cx("min-w-0 truncate", s.label)} title={label}>
            {label}
          </span>
          {badge ? <span className="inline-flex shrink-0 not-italic">{badge}</span> : null}
        </span>
        {detail ? (
          <span className={cx("truncate text-[12px] leading-snug text-lc-slate group-focus:text-lc-void/75 phone:text-[11px]")} title={detail}>
            {detail}
          </span>
        ) : null}
      </span>
      {href ? (
        <span className={cx("inline-flex shrink-0 text-lc-slate", GROUP_CURSOR_INK)}>
          <Icon name="externalLink" size="xs" label="Opens in a new tab" />
        </span>
      ) : null}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" data-rail-id={id} onPointerEnter={focusOnHover} className={classes}>
      {inner}
    </a>
  ) : (
    <button type="button" data-rail-id={id} onPointerEnter={focusOnHover} onClick={onClick} aria-expanded={expanded} className={classes}>
      {inner}
    </button>
  );
};

/** The main action's three sizes: the title screen's hero, the pause rail, and the slim rail beside an open panel */
export type HeroSize = "hero" | "rail" | "slim";

const HERO_SIZE: Record<HeroSize, { box: string; disc: string; icon: "sm" | "md"; label: string; prompt: boolean; detail: boolean }> = {
  hero: {
    box: "min-h-22 gap-4.5 rounded-lc-card bg-lc-volt/6 py-3 pr-5 pl-3.5 inset-ring-2 inset-ring-lc-volt/40 hover:bg-lc-volt/10 compact:min-h-18 short:min-h-15 phone:min-h-13 phone:gap-3 phone:rounded-lc-tile phone:py-1.5 phone:pl-2.5",
    disc: "size-14 compact:size-12 short:size-10 phone:size-9",
    icon: "md",
    label: "text-[44px] compact:text-[36px] short:text-[28px] phone:text-[24px]",
    prompt: true,
    detail: true,
  },
  rail: {
    box: "mb-1 min-h-17 gap-3.5 rounded-lc-card bg-lc-volt/6 py-2 pr-4 pl-3 inset-ring-2 inset-ring-lc-volt/40 hover:bg-lc-volt/10 short:min-h-14 phone:min-h-13 phone:rounded-lc-tile",
    disc: "size-11 short:size-9 phone:size-8",
    icon: "md",
    label: "text-[30px] short:text-[24px] phone:text-[20px]",
    prompt: false,
    detail: true,
  },
  slim: {
    box: "min-h-13 gap-3 rounded-lc-row bg-transparent px-3 hover:bg-white/4",
    disc: "size-8",
    icon: "sm",
    label: "text-[24px]",
    prompt: false,
    detail: false,
  },
};

/**
 * The rail's main action (Drive on the title screen, Resume in pause): the one volt thing at rest, a play disc and a
 * display label, where the focus starts.
 */
export const HeroAction: React.FC<{
  id: string;
  label: string;
  detail?: string;
  onClick: () => void;
  size?: HeroSize;
}> = ({ id, label, detail, onClick, size = "hero" }) => {
  const { mode, family } = useInputMode();
  const s = HERO_SIZE[size];
  return (
    <button
      type="button"
      data-rail-id={id}
      data-nav-default=""
      onPointerEnter={focusOnHover}
      onClick={onClick}
      className={cx(
        "group flex w-full min-w-0 cursor-pointer items-center border-0 text-left text-lc-chalk",
        MOTION,
        "outline-none focus-visible:outline-none focus:bg-lc-volt focus:text-lc-void focus:shadow-lc-focus focus:inset-ring-transparent active:bg-lc-volt-dim",
        s.box,
      )}
    >
      <span
        aria-hidden
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-full bg-lc-volt text-lc-void",
          MOTION,
          "group-focus:bg-lc-void group-focus:text-lc-volt",
          s.disc,
        )}
      >
        <Icon name="play" size={s.icon} className="translate-x-px" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 phone:gap-0.5">
        <span className={cx("lc-disp leading-none", s.label)}>{label}</span>
        {detail && s.detail ? (
          <span className="truncate text-[14px] font-semibold text-lc-fog group-focus:text-lc-void/75 phone:text-[12px]">{detail}</span>
        ) : null}
      </span>
      {s.prompt ? (
        <span className={cx("hidden shrink-0 sm:inline-flex", mode === "pad" ? undefined : "pointer-coarse:hidden")}>
          {mode === "pad" ? <PadGlyph button="a" family={family} /> : <KeyCap>Enter</KeyCap>}
        </span>
      ) : null}
    </button>
  );
};

/**
 * A shell's footer prompts. Phones get the short list (`phonePrompts`) so the footer stays on one line.
 */
/**
 * In the Garage a changed row can be put back with Delete or the pad's X (`useFocusNav`'s `rowReset`). True while the
 * cursor is on such a row, so the prompt bar names the key only when it does something.
 */
export function useRowResettable(on: boolean): boolean {
  const [resettable, setResettable] = useState(false);
  useEffect(() => {
    if (!on) return;
    const check = () =>
      setResettable(Boolean(document.activeElement?.closest("[data-setting-row]")?.querySelector("[data-row-reset]")));
    check();
    // A row gains its reset when its value changes, with no focus move: look again after any change in the panel
    document.addEventListener("focusin", check);
    document.addEventListener("input", check);
    document.addEventListener("click", check);
    return () => {
      document.removeEventListener("focusin", check);
      document.removeEventListener("input", check);
      document.removeEventListener("click", check);
    };
  }, [on]);
  return on && resettable;
}

/** The prompt for it, the same words as in Settings */
export const RESET_ROW_PROMPT = { action: "select", label: "Reset row", key: "Delete", pad: "x" } as const;

export const ShellPrompts: React.FC<{ prompts: readonly Prompt[]; phonePrompts: readonly Prompt[] }> = ({ prompts, phonePrompts }) => (
  <>
    <div className="min-w-0 phone:hidden">
      <PromptBar prompts={prompts} rule={false} />
    </div>
    <div className="hidden min-w-0 phone:block">
      <PromptBar prompts={phonePrompts} rule={false} className="flex-nowrap" />
    </div>
  </>
);

/**
 * A control's box for the up / down moves below: the whole setting row it sits in, even a row of several options (a
 * segmented control), so a row on the right of a narrow column is not passed over for a full-width one further down.
 */
function boxOf(el: HTMLElement): DOMRect {
  const row = el.closest("[data-setting-row]");
  return (row ?? el).getBoundingClientRect();
}

/** The nearest control in `items` straight up or down from `from` */
function nearestVertical(from: HTMLElement, items: HTMLElement[], dir: "up" | "down"): HTMLElement | null {
  const a = boxOf(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const b = boxOf(el);
    const ahead = dir === "down" ? b.top + b.height / 2 - (a.top + a.height / 2) : a.top + a.height / 2 - (b.top + b.height / 2);
    if (ahead <= 2) continue;
    const gap = Math.max(0, dir === "down" ? b.top - a.bottom : a.top - b.bottom);
    let side = Math.max(0, b.left - a.right, a.left - b.right);
    if (side === 0) side = Math.abs(b.left + b.width / 2 - (a.left + a.width / 2)) * 0.05;
    const score = gap + side * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function land(target: HTMLElement) {
  // A row of options is entered on the one it is set to (moving inside the group goes where it points)
  const group = target.closest('[role="radiogroup"]');
  const from = document.activeElement;
  const el = (group && !(from && group.contains(from)) ? group.querySelector<HTMLElement>('[aria-checked="true"]') : null) ?? target;
  (el.focus as (o?: object) => void)({ preventScroll: true, focusVisible: true });
  (el.closest("label") ?? el).scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * Up and down inside a shell's open panel follow reading order and stay in the panel:
 * - In a block of side-by-side columns (`data-nav-columns` on their container), down runs to the end of a column,
 *   then on to the top of the next one; up runs back the same way. Without this, down from the end of a short left
 *   column jumps sideways into the middle of the right one.
 * - Down from the panel's last control stays in the panel (the rail sits lower on the left and used to take it); the
 *   screen scrolls on instead, to any text below.
 */
export function usePanelReadingOrder(rootRef: React.RefObject<HTMLElement | null>, zone = "panel"): void {
  const scrollingRef = useRef(false);
  useMoveHandler((dir: Dir) => {
    if (dir !== "up" && dir !== "down") return false;
    const root = rootRef.current;
    const panel = root?.querySelector<HTMLElement>(`[data-nav-zone="${zone}"]`);
    const active = document.activeElement as HTMLElement | null;
    if (!root || !panel || !active || !panel.contains(active)) return false;
    // A control that takes up / down itself (a slider) is the navigation's to handle
    if (active instanceof HTMLSelectElement) return false;

    const grid = active.closest<HTMLElement>("[data-nav-columns]");
    if (grid && panel.contains(grid)) {
      const cols = Array.from(grid.children).filter((c): c is HTMLElement => c instanceof HTMLElement && focusables(c).length > 0);
      const col = cols.find((c) => c.contains(active));
      if (col) {
        const inCol = nearestVertical(active, focusables(col), dir);
        if (inCol) {
          land(inCol);
          return true;
        }
        const i = cols.indexOf(col);
        const next = cols[dir === "down" ? i + 1 : i - 1];
        if (next) {
          const items = focusables(next);
          const target = dir === "down" ? items[0] : items[items.length - 1];
          if (target) {
            land(target);
            return true;
          }
        }
      }
    }

    // A bar pinned over the bottom of the panel (the race's start bar, `data-nav-pinned`) sits on top of the rows that
    // scroll under it: it is the end of the reading order, never a stop on the way down to them
    const pinned = (el: Element) => el.closest("[data-nav-pinned]") !== null;
    if (pinned(active)) {
      if (dir === "down") return true;
    } else {
      const next = nearestVertical(active, focusables(panel), dir);
      if (next && pinned(next)) {
        const unpinned = nearestVertical(
          active,
          focusables(panel).filter((el) => !pinned(el)),
          dir,
        );
        if (unpinned) {
          land(unpinned);
          return true;
        }
      }
    }

    if (dir === "down" && !nearestVertical(active, focusables(panel), "down")) {
      // Nothing further down in the panel: hold the cursor and show the rest of the page
      if (!scrollingRef.current) {
        scrollingRef.current = true;
        root.scrollBy({ top: 120, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        window.setTimeout(() => (scrollingRef.current = false), 120);
      }
      return true;
    }
    return false;
  });
}
