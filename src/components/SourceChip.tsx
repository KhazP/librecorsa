"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { ModelSource } from "@/lib/model-source";
import { TAKEDOWN_URL } from "@/lib/site";

const linkClass = "text-[#F5F7FA] underline decoration-[#4A5268] underline-offset-2 hover:decoration-[#F5F7FA]";

/**
 * A small "Source" button that opens where a car's or circuit's 3D model comes from: the model, its author, its
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
  const chipRef = useRef<HTMLButtonElement | null>(null);
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
      chipRef.current?.focus();
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
      <button
        ref={chipRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={`pointer-events-auto h-7 cursor-pointer rounded-full border px-2.5 text-[11px] font-semibold transition-colors duration-150 ease-out ${
          open
            ? "border-[#4A5268] bg-[#262B3D] text-[#F5F7FA]"
            : "border-[#262B3D] bg-[#08090D]/80 text-[#C5CBD8] hover:border-[#4A5268] hover:text-[#F5F7FA]"
        }`}
      >
        Source
      </button>
      {open ? (
        <span
          id={panelId}
          role="group"
          aria-label={`Source of ${source.title}`}
          className={`pointer-events-auto absolute z-30 flex flex-col gap-1.5 rounded-[14px] border border-[#262B3D] bg-[#11131A] p-3 text-left text-[12px] leading-snug font-normal text-[#C5CBD8] shadow-[0_12px_32px_rgba(0,0,0,0.55)] ${panelClassName}`}
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
              <span className="text-[#F5F7FA]">{source.author}</span>
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
          {source.note ? <span className="text-[#8E96AA]">{source.note}</span> : null}
          <a
            href={TAKEDOWN_URL}
            target="_blank"
            rel="noreferrer"
            className="self-start text-[#8E96AA] underline decoration-[#4A5268] underline-offset-2 hover:text-[#F5F7FA]"
          >
            Report a problem with it
          </a>
        </span>
      ) : null}
    </span>
  );
};
