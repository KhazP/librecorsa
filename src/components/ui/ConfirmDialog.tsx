"use client";

import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusNav } from "@/components/menu/useFocusNav";
import { Button } from "./Button";
import { cx } from "./styles";

export interface ConfirmDialogProps {
  open: boolean;
  /** The question ("Reset key bindings?") */
  title: string;
  /** One sentence on what happens */
  children: React.ReactNode;
  /** The destructive action's label, a verb ("Reset bindings") */
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Icon beside the question (24 px) */
  icon?: React.ReactNode;
  /**
   * The confirm action is running: its label pulses, and nothing dismisses the dialog (Cancel, Esc, B and the backdrop
   * do nothing) until the caller closes it
   */
  busy?: boolean;
}

/**
 * Asks before a destructive action (reset bindings, clear data, end the race for everyone): a small sheet with the
 * question, one sentence, and the safe and danger buttons. The focus starts on the safe one; Esc or B cancels. Not a
 * native `<dialog>`: in a race Esc is also the pause key, so the dialog catches Esc before anything else hears it.
 * It runs its own menu navigation while open, so the screen below takes no input.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  icon,
  busy,
}: ConfirmDialogProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const cancelLatest = useRef(onCancel);
  cancelLatest.current = onCancel;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Cancels unless the confirm action is running */
  const dismiss = () => {
    if (!busyRef.current) cancelLatest.current();
  };

  useFocusNav(sheetRef, { enabled: open, onBack: dismiss, autoFocus: false });

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    // The safe choice takes the focus first
    const raf = requestAnimationFrame(() =>
      sheetRef.current?.querySelector<HTMLElement>("[data-nav-default]")?.focus({ preventScroll: true }),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      // Ours alone: a screen's own Tab trap below (Settings) must not move the focus out from under the dialog
      e.stopImmediatePropagation();
      // Keep Tab inside the dialog
      const items = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next].focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      // Back to where the player was
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-(--z-lc-notice) flex items-center justify-center bg-lc-void/70 p-4 backdrop-blur-[6px]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={sheetRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="lc-glass lc-ui-zoom lc-toast-in flex w-full max-w-[26rem] flex-col gap-4 rounded-lc-sheet p-6 text-lc-chalk shadow-lc-sheet phone:p-5"
      >
        <div className="flex items-start gap-3">
          {icon ? (
            <span aria-hidden className="mt-px inline-flex shrink-0 text-lc-crimson [&_svg]:size-6">
              {icon}
            </span>
          ) : null}
          <div className="flex min-w-0 flex-col gap-2">
            <h2 id={titleId} className="lc-h3 text-[20px]">
              {title}
            </h2>
            <p id={bodyId} className="lc-body m-0">
              {children}
            </p>
          </div>
        </div>
        <div className={cx("flex flex-wrap items-center justify-end gap-2.5 pt-1")}>
          <Button
            variant="secondary"
            size="md"
            onClick={onCancel}
            data-nav-default=""
            disabledReason={busy ? "Wait for it to finish" : undefined}
          >
            {cancelLabel}
          </Button>
          <Button variant="danger" size="md" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
