"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { ModelSource } from "@/lib/model-source";
import { TAKEDOWN_URL } from "@/lib/site";
import { IconButton } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";

const linkClass = "text-lc-chalk underline decoration-lc-keyline underline-offset-2 hover:decoration-lc-chalk";

/**
 * A small round "Source" button (the kit's secondary `IconButton`) that opens where a car's or circuit's 3D model comes from: the model, its author, its
 * licence or permission, and a link to report a problem with it. It sits beside a card's own button, never inside it,
 * so pressing it doesn't pick the car or circuit.
 */
export const SourceChip: React.FC<{
  source: ModelSource;
  /** The chip's box, which the panel is placed in (absent: inline, the panel opening above it to the left) */
  className?: string;
  /** Where the panel sits in that box and how wide it is */
  panelClassName?: string;
}> = ({ source, className = "relative inline-flex", panelClassName = "right-0 bottom-full mb-2 w-[min(264px,calc(100vw-32px))]" }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelId = useId();

  // Closes on a press elsewhere or on Escape (which hands the focus back to the chip)
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={className}>
      <IconButton
        size="sm"
        variant="secondary"
        icon={<Icon name="source" />}
        aria-label={`Source of ${source.title}`}
        title="Source"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="pointer-events-auto"
      />
      {open ? (
        <span
          id={panelId}
          role="group"
          aria-label={`Source of ${source.title}`}
          className={`pointer-events-auto absolute z-30 flex flex-col gap-1.5 rounded-lc-tile border border-white/7 bg-lc-carbon p-3.5 text-left text-[13px] leading-snug font-normal text-lc-fog shadow-lc-pop ${panelClassName}`}
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
        </span>
      ) : null}
    </span>
  );
};
