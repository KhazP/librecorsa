"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons/Icon";
import { cx, TONE_HAIRLINE, TONE_TEXT } from "./styles";

export type ToastTone = "neutral" | "info" | "good" | "warn" | "bad";

const TONE_ICON: Record<ToastTone, React.ReactNode> = {
  neutral: <Icon name="info" size="md" />,
  info: <Icon name="info" size="md" />,
  good: <Icon name="success" size="md" />,
  warn: <Icon name="warning" size="md" />,
  bad: <Icon name="error" size="md" />,
};

export interface ToastProps {
  /** Tone by icon and hairline, never by fill */
  tone?: ToastTone;
  /** Replaces the tone's own icon */
  icon?: React.ReactNode;
  /** One line */
  children: React.ReactNode;
  /** An action at the end ("Undo"), a small ghost `Button` */
  action?: React.ReactNode;
  className?: string;
}

/** One toast: a pill with an icon and one line */
export function Toast({ tone = "neutral", icon, children, action, className }: ToastProps) {
  return (
    <div
      className={cx(
        "lc-toast-in pointer-events-auto flex min-h-11 max-w-full items-center gap-2.5 rounded-full bg-lc-carbon/95 py-1.5 pl-3.5 shadow-lc-pop backdrop-blur-[14px]",
        action ? "pr-1.5" : "pr-5",
        TONE_HAIRLINE[tone],
        className,
      )}
    >
      <span aria-hidden className={cx("inline-flex shrink-0", TONE_TEXT[tone])}>
        {icon ?? TONE_ICON[tone]}
      </span>
      <span className="min-w-0 text-[14px] leading-snug font-semibold text-lc-chalk">{children}</span>
      {action ? <span className="ml-1 inline-flex shrink-0">{action}</span> : null}
    </div>
  );
}

export interface ToastItem {
  id: number;
  message: React.ReactNode;
  tone?: ToastTone;
  icon?: React.ReactNode;
}

/**
 * Where toasts appear: bottom centre, clear of the safe area, announced politely. Render it once per screen; it stays
 * in the page while empty so the first toast is read out too.
 */
export function ToastRegion({ toasts, className }: { toasts: readonly ToastItem[]; className?: string }) {
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className={cx(
        "pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] left-[max(1rem,env(safe-area-inset-left))] bottom-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] z-(--z-lc-toast) mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-col items-center gap-2",
        className,
      )}
    >
      {toasts.map((t) => (
        <Toast key={t.id} tone={t.tone} icon={t.icon}>
          {t.message}
        </Toast>
      ))}
    </div>
  );
}

/**
 * Toast state for a screen: `show` adds one that leaves on its own after `duration` ms (default 4 s), `dismiss`
 * removes one now. Pass `toasts` to a `ToastRegion`.
 */
export function useToasts(duration = 4000) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (message: React.ReactNode, options: { tone?: ToastTone; icon?: React.ReactNode } = {}) => {
      const id = next.current++;
      // At most three at once: the oldest leaves first
      setToasts((all) => [...all.slice(-2), { id, message, ...options }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss, duration],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) window.clearTimeout(t);
      map.clear();
    };
  }, []);

  return { toasts, show, dismiss };
}
