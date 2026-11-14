"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelSource } from "@/lib/model-source";
import { TAKEDOWN_URL } from "@/lib/site";
import { IconButton } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";
import { uiZoomOf } from "@/components/ui/styles";

const linkClass = "text-lc-chalk underline decoration-lc-keyline underline-offset-2 hover:decoration-lc-chalk";

/** Space between the button and its panel, and between the panel and the window's edge */
const GAP = 8;
const MARGIN = 12;

interface Place {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * A small round "Source" button (the kit's secondary `IconButton`) that opens where a car's or circuit's 3D model comes from: the model, its author, its
 * licence or permission, and a link to report a problem with it. It sits beside a card's own button, never inside it,
 * so pressing it doesn't pick the car or circuit. The menu cursor passes over it.
 *
 * The panel is a portal placed against the window, so no card or scrolling list clips it: above the button where it
 * fits, below it otherwise, and never past the window's edge.
 */
export const SourceChip: React.FC<{
  source: ModelSource;
  /** The chip's box */
  className?: string;
}> = ({ source, className = "inline-flex" }) => {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  // Whether the button sits in a zoomed screen (TV distance, the UI scale setting): the panel then takes the same zoom
  const [zoomed, setZoomed] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLSpanElement | null>(null);
  const panelId = useId();

  const button = () => rootRef.current?.querySelector<HTMLButtonElement>("button") ?? null;

  const measure = useCallback(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const zoom = uiZoomOf(root);
    const r = root.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const above = r.top - MARGIN - GAP;
    const below = vh - r.bottom - MARGIN - GAP;
    const up = p.height <= above || above >= below;
    const top = up ? r.top - GAP - p.height : r.bottom + GAP;
    setPlace({
      left: Math.max(MARGIN, Math.min(r.right - p.width, vw - p.width - MARGIN)) / zoom,
      top: Math.max(MARGIN, Math.min(top, vh - p.height - MARGIN)) / zoom,
      maxHeight: (vh - 2 * MARGIN) / zoom,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  // Closes on a press elsewhere or on Escape (which hands the focus back to the chip); follows the button when the
  // page scrolls or the window changes size
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button()?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  // The panel is not next to the button in the page, so Tab is carried by hand: from the button into the panel's
  // links, and off either end of them back to the button
  const links = () => Array.from(panelRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  const onButtonKey = (e: React.KeyboardEvent) => {
    // React carries the panel's key events up to this span through the portal: only the button's own Tab is handled here
    if (panelRef.current?.contains(e.target as Node)) return;
    if (e.key !== "Tab" || e.shiftKey || !open) return;
    const first = links()[0];
    if (!first) return;
    e.preventDefault();
    first.focus();
  };
  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const all = links();
    const edge = e.shiftKey ? all[0] : all[all.length - 1];
    if (document.activeElement !== edge) return;
    e.preventDefault();
    if (!e.shiftKey) setOpen(false);
    button()?.focus();
  };

  return (
    // Skipped by the arrow keys and the D-pad (a card's neighbour is the next card, not its chip); Tab, a click and a
    // tap still reach it
    <span ref={rootRef} className={className} data-nav-skip="" onKeyDown={onButtonKey}>
      <IconButton
        size="sm"
        variant="secondary"
        icon={<Icon name="source" />}
        aria-label={`Source of ${source.title}`}
        title="Source"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setZoomed(!!rootRef.current?.closest(".lc-ui-zoom"));
          setOpen((o) => !o);
        }}
        className="pointer-events-auto"
      />
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={panelRef}
              id={panelId}
              role="group"
              aria-label={`Source of ${source.title}`}
              onKeyDown={onPanelKey}
              className={`pointer-events-auto fixed z-(--z-lc-notice) flex w-[min(264px,calc(100vw-32px))] flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-lc-tile border border-white/7 bg-lc-carbon p-3.5 text-left text-[13px] leading-snug font-normal text-lc-fog shadow-lc-pop ${zoomed ? "lc-ui-zoom" : ""}`}
              // Laid out unseen at the corner first, measured, then put by the button
              style={
                place
                  ? { left: place.left, top: place.top, maxHeight: place.maxHeight }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
            >
              <span>
                &ldquo;
                <a href={source.url} target="_blank" rel="noreferrer" className={linkClass}>
                  {source.title}
                </a>
                &rdquo; by{" "}
                {source.authorUrl ? (
                  <a href={source.authorUrl} target="_blank" rel="noreferrer" className={linkClass}>
                    {source.author}
                  </a>
                ) : (
                  <span className="text-lc-chalk">{source.author}</span>
                )}
              </span>
              <span>
                {source.licenseUrl ? (
                  <a href={source.licenseUrl} target="_blank" rel="noreferrer" className={linkClass}>
                    {source.license}
                  </a>
                ) : (
                  source.license
                )}
              </span>
              {source.note ? <span className="text-lc-slate">{source.note}</span> : null}
              <a
                href={TAKEDOWN_URL}
                target="_blank"
                rel="noreferrer"
                className="self-start text-lc-slate underline decoration-lc-keyline underline-offset-2 hover:text-lc-chalk"
              >
                Report a problem with it
              </a>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
};
