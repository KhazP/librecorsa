"use client";

import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { focusables, focusOnHover, useFocusNav } from "@/components/menu/useFocusNav";
import { Icon } from "@/components/ui/icons";
import { cx, CURSOR_ROW, MOTION } from "@/components/ui/styles";

export interface AccountDialogProps {
  open: boolean;
  /** The question ("Join the account of Alp (Discord)?") */
  title: string;
  /** The sentences under it, and anything to fill in or tick */
  children: React.ReactNode;
  /** The buttons, the safe or main one marked `data-nav-default` (where the focus starts) */
  actions: React.ReactNode;
  /** Esc, B and the backdrop: the safe choice, never a destructive one. Ignored while `busy` */
  onDismiss: () => void;
  /** An action is running: nothing dismisses the dialog until it ends */
  busy?: boolean;
  /** `danger` asks before a destructive action (an alert dialog); `info` asks or explains */
  tone?: "danger" | "info";
  /** What the last try said, under the body */
  error?: string | null;
  /** Wider, for a choice with two sides to compare */
  wide?: boolean;
  /** The buttons one under another, full width (three or more choices, or a phone) */
  stackActions?: boolean;
  /** A new step of the same dialog (the code checked, now the question): the focus moves to its default again */
  step?: string;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), [tabindex]:not([tabindex="-1"])';

const isTextEntry = (el: Element | null): el is HTMLInputElement =>
  el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color"].includes(el.type);

/**
 * The account screens' question sheet: ConfirmDialog's look and behaviour (portal over everything, the focus kept
 * inside, Esc and B caught before any screen below hears them, the focus handed back on close), with room for more
 * than one sentence: a code to type, a tick box, two saves side by side, three choices, and what went wrong.
 */
export function AccountDialog({
  open,
  title,
  children,
  actions,
  onDismiss,
  busy,
  tone = "info",
  error,
  wide,
  stackActions,
  step,
}: AccountDialogProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const dismissLatest = useRef(onDismiss);
  dismissLatest.current = onDismiss;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dismiss = () => {
    if (!busyRef.current) dismissLatest.current();
  };

  useFocusNav(sheetRef, { enabled: open, onBack: dismiss, autoFocus: false });

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    // Where the focus goes back to if the opener is gone on close (as ConfirmDialog): the boxes round it, up to its zone
    const around: HTMLElement[] = [];
    for (let el = before?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
      around.push(el);
      if (el.hasAttribute("data-nav-zone")) break;
    }
    const raf = requestAnimationFrame(() =>
      sheetRef.current?.querySelector<HTMLElement>("[data-nav-default]")?.focus({ preventScroll: true }),
    );
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened over this one (a confirm from inside it) takes its own keys
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== sheetRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const active = document.activeElement;
        // In the code field, Esc only leaves the field (as everywhere in the menus): onto the next control here, never
        // onto a screen below (Settings would take it to its own next row)
        if (isTextEntry(active) && sheetRef.current?.contains(active)) {
          const list = focusables(sheetRef.current);
          const next = list.slice(list.indexOf(active) + 1).find((x) => !isTextEntry(x)) ?? list.find((x) => !isTextEntry(x));
          active.blur();
          next?.focus({ preventScroll: true });
          return;
        }
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      // Ours alone: a screen's own Tab trap below (Settings) must not move the focus out from under the dialog
      e.stopImmediatePropagation();
      const items = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
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
      if (before?.isConnected && !(before as HTMLButtonElement).disabled && before !== document.body) {
        before.focus({ preventScroll: true });
        return;
      }
      for (const box of around) {
        if (!box.isConnected) continue;
        const next = box.querySelector<HTMLElement>('button:not([disabled]):not([data-card-reset])');
        if (next) {
          next.focus({ preventScroll: true });
          return;
        }
      }
    };
  }, [open]);

  // A later step of an open dialog starts on its own default, as the first did
  const firstStep = useRef(true);
  useEffect(() => {
    if (!open) {
      firstStep.current = true;
      return;
    }
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const raf = requestAnimationFrame(() =>
      sheetRef.current?.querySelector<HTMLElement>("[data-nav-default]")?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-(--z-lc-notice) flex items-center justify-center bg-lc-void/70 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur-[6px] phone:pt-[max(0.5rem,env(safe-area-inset-top))] phone:pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={sheetRef}
        role={tone === "danger" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={cx(
          "lc-glass lc-ui-zoom lc-toast-in flex max-h-full w-full [backdrop-filter:none] flex-col gap-4 overflow-y-auto overscroll-contain rounded-lc-sheet p-6 text-lc-chalk shadow-lc-sheet phone:gap-3 phone:p-4.5",
          wide ? "max-w-[36rem] short:max-w-[44rem]" : "max-w-[28rem]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-2.5">
          <h2 id={titleId} className="lc-h3 text-[20px] text-balance">
            {title}
          </h2>
          <div id={bodyId} className="lc-body flex min-w-0 flex-col gap-3">
            {children}
          </div>
        </div>
        <ErrorLine error={error} />
        <div
          className={cx(
            "flex gap-2.5 pt-1",
            // Several choices: one under another, two by two on a short screen (a landscape phone). Two buttons: side by
            // side, one under the other (the main one on top) on a narrow screen
            stackActions
              ? "flex-col items-stretch short:grid short:grid-cols-2"
              : "flex-wrap items-center justify-end max-sm:flex-col-reverse max-sm:items-stretch",
          )}
        >
          {actions}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What went wrong, in the loss colour with its icon; always in the page so a new one is read out */
export function ErrorLine({ error, className }: { error?: string | null; className?: string }) {
  return (
    <div aria-live="polite" className={cx(error ? undefined : "hidden", className)}>
      {error ? (
        <p className="m-0 flex items-start gap-1.5 text-[13px] leading-[1.4] font-medium text-lc-loss">
          <Icon name="error" size="sm" className="mt-px" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A tick box with its sentence, as one full-width row (the whole row is the target, ringed by the cursor): for a
 * choice inside a question, where a switch would read as a setting
 */
export function TickBox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onPointerEnter={focusOnHover}
      onClick={() => onChange(!checked)}
      className={cx(
        "group -mx-2 flex min-h-11 w-[calc(100%+1rem)] cursor-pointer items-start gap-3 rounded-lc-row px-2 py-2.5 text-left outline-none hover:bg-white/4 disabled:cursor-not-allowed disabled:opacity-40",
        MOTION,
        CURSOR_ROW,
      )}
    >
      <span
        aria-hidden
        className={cx(
          "inline-flex size-5.5 shrink-0 items-center justify-center rounded-lc-nub border-[1.5px] [&_svg]:size-3.5",
          MOTION,
          checked ? "border-lc-chalk bg-lc-chalk text-lc-void" : "border-lc-slate bg-transparent text-transparent",
        )}
      >
        <Icon name="check" size="xs" />
      </span>
      <span className="lc-row-label text-[15px]">{children}</span>
    </button>
  );
}
