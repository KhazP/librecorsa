"use client";

import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "use-intl/react";
import { useFocusNav } from "@/components/menu/useFocusNav";
import { IconButton } from "./Button";
import { Icon } from "./icons/Icon";
import { cx } from "./styles";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Heading rendered at the top of the modal (plain title, never preceded by an eyebrow) */
  title: React.ReactNode;
  /** Classes for the heading element; defaults to `lc-h2` */
  titleClassName?: string;
  /** Accessible name override when `title` contains complex markup */
  ariaLabel?: string;
  /** Optional content directly under the heading (e.g. driver badges or summary line) */
  subtitle?: React.ReactNode;
  /** Optional control beside the close button */
  headerAction?: React.ReactNode;
  /** Optional footer bar pinned at the bottom of the modal */
  footer?: React.ReactNode;
  /** Width preset: `md` (580 px) or `lg` (840 px, default for modal pages) */
  size?: "md" | "lg";
  children: React.ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Larger frosted modal sheet for detail pages (e.g. driver profiles). Mirrors ConfirmDialog's portal, z-layer,
 * safe-area framing, Esc capture (respecting nested dialogs such as badge popovers), Tab trap, gamepad back, and
 * focus restoration to the triggering control on close.
 */
export function Modal({
  open,
  onClose,
  title,
  titleClassName,
  ariaLabel,
  subtitle,
  headerAction,
  footer,
  size = "lg",
  children,
}: ModalProps) {
  const tx = useTranslations("common.dialog");
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeLatest = useRef(onClose);
  closeLatest.current = onClose;
  const dismiss = () => closeLatest.current();

  useFocusNav(sheetRef, { enabled: open, onBack: dismiss, autoFocus: false });

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const around: HTMLElement[] = [];
    for (let el = before?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
      around.push(el);
      if (el.hasAttribute("data-nav-zone")) break;
    }
    const raf = requestAnimationFrame(() =>
      sheetRef.current?.querySelector<HTMLElement>("[data-nav-default]")?.focus({ preventScroll: true }),
    );
    const onKey = (e: KeyboardEvent) => {
      // Leave Escape/Tab to a nested dialog portalled above this modal (such as the Fastest Lap popover)
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== sheetRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
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
      if (before?.isConnected && !(before as HTMLButtonElement).disabled) {
        before.focus({ preventScroll: true });
        return;
      }
      for (const box of around) {
        if (!box.isConnected) continue;
        const next = box.querySelector<HTMLElement>(
          'button:not([disabled]):not([data-card-reset]), input:not([disabled]):is([type="checkbox"], [type="radio"], [type="range"]), select:not([disabled])',
        );
        if (next) {
          next.focus({ preventScroll: true });
          return;
        }
      }
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-(--z-lc-notice) flex items-center justify-center bg-lc-void/72 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur-[6px] phone:pt-[max(0.5rem,env(safe-area-inset-top))] phone:pr-[max(0.5rem,env(safe-area-inset-right))] phone:pb-[max(0.5rem,env(safe-area-inset-bottom))] phone:pl-[max(0.5rem,env(safe-area-inset-left))]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        className={cx(
          "lc-glass lc-ui-zoom lc-toast-in flex max-h-full w-full [backdrop-filter:none] flex-col overflow-hidden rounded-lc-sheet text-lc-chalk shadow-lc-sheet",
          size === "lg" ? "max-w-[840px]" : "max-w-[580px]",
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-lc-line px-6 py-4 phone:px-4 phone:py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h2 id={titleId} className={cx("m-0 min-w-0", titleClassName ?? "lc-h2")}>
              {title}
            </h2>
            {subtitle ? <div className="min-w-0">{subtitle}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {headerAction}
            <IconButton
              size="sm"
              variant="ghost"
              icon={<Icon name="close" />}
              aria-label={tx("close")}
              data-nav-default=""
              onClick={dismiss}
            />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-4 phone:gap-3 phone:px-4 phone:py-3.5">
          {children}
        </div>
        {footer ? <footer className="border-t border-lc-line px-6 py-3 phone:px-4">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
