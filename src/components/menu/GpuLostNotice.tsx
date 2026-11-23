"use client";

import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "use-intl/react";
import { Button, Sheet } from "@/components/ui";
import { Icon } from "@/components/ui/icons/Icon";
import { useFocusNav } from "./useFocusNav";

/**
 * Why there is no picture: the GPU context was lost with the page in view (a driver reset), lost while the page was
 * hidden (a phone or laptop reclaiming it), refused to the page after such a loss (`blocked`, as Chrome can after a
 * reset), or not there at all with no loss before it (`unavailable`: hardware acceleration off, or no WebGL)
 */
export type GpuNoticeKind = "lost" | "background" | "blocked" | "unavailable";

export interface GpuLostNoticeProps {
  kind: GpuNoticeKind;
  /** The graphics are not on Low yet: offer the switch as the main action */
  canLower: boolean;
  /** Saves Low and loads the circuit again on a new context */
  onLower: () => void;
  /** Loads the circuit again on a new context, with the same settings */
  onRetry: () => void;
  /** Reloads the whole page (the browser refused a new context) */
  onReloadPage: () => void;
}

/**
 * Over everything when the picture is gone: what happened in a line, and the way back. Every way back loads the
 * circuit on a new context and lands on the title menu, so there is no separate menu button. Nothing dismisses it
 * but its buttons: Esc is held here, so it never reaches the game's pause key underneath.
 */
export function GpuLostNotice({ kind, canLower, onLower, onRetry, onReloadPage }: GpuLostNoticeProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const tx = useTranslations("menu.gpuLost");
  const copy = {
    lost: { title: tx("lostTitle"), body: canLower ? tx("lostBodyLower") : tx("lostBody") },
    background: { title: tx("backgroundTitle"), body: tx("backgroundBody") },
    blocked: { title: tx("blockedTitle"), body: tx("blockedBody") },
    unavailable: { title: tx("unavailableTitle"), body: tx("unavailableBody") },
  }[kind];
  const lower = kind === "lost" && canLower;

  useFocusNav(sheetRef, { enabled: true, keyboardBack: false, autoFocus: false });

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      sheetRef.current?.querySelector<HTMLElement>("[data-nav-default]")?.focus({ preventScroll: true }),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [kind]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-(--z-lc-notice) flex items-center justify-center bg-lc-void/80 p-4 backdrop-blur-[6px]">
      <div ref={sheetRef} className="lc-ui-zoom w-full max-w-[36rem]">
        <Sheet
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          className="lc-toast-in flex flex-col gap-5 p-6 [backdrop-filter:none]"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden className="mt-px inline-flex shrink-0 text-lc-crimson [&_svg]:size-6">
              <Icon name="warning" size="lg" />
            </span>
            <div className="flex min-w-0 flex-col gap-2">
              <h2 id={titleId} className="lc-h3 text-[20px]">
                {copy.title}
              </h2>
              <p id={bodyId} className="lc-body m-0">
                {copy.body}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            {kind === "blocked" || kind === "unavailable" ? (
              <Button variant="primary" size="md" icon={<Icon name="refresh" />} onClick={onReloadPage} data-nav-default="">
                {tx("reloadPage")}
              </Button>
            ) : (
              <>
                <Button
                  variant={lower ? "secondary" : "primary"}
                  size="md"
                  icon={<Icon name="restart" />}
                  onClick={onRetry}
                  data-nav-default={lower ? undefined : ""}
                >
                  {tx("retry")}
                </Button>
                {lower ? (
                  <Button variant="primary" size="md" icon={<Icon name="graphics" />} onClick={onLower} data-nav-default="">
                    {tx("lower")}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </Sheet>
      </div>
    </div>,
    document.body,
  );
}
