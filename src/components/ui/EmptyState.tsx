import React from "react";
import { cx } from "./styles";

export interface EmptyStateProps {
  /** One icon (24 px) */
  icon: React.ReactNode;
  /** One sentence: what will appear here and how to make it appear */
  children: React.ReactNode;
  /** The action that fills it, a `Button` */
  action?: React.ReactNode;
  className?: string;
}

/** What an empty list shows: an icon, one sentence that teaches, and the action that fills it */
export function EmptyState({ icon, children, action, className }: EmptyStateProps) {
  return (
    <div className={cx("flex flex-col items-center gap-3.5 px-6 py-9 text-center", className)}>
      <span
        aria-hidden
        className="inline-flex size-12 items-center justify-center rounded-full bg-lc-titanium text-lc-slate inset-ring inset-ring-lc-line [&_svg]:size-6"
      >
        {icon}
      </span>
      <p className="lc-body m-0 max-w-[36ch] text-balance">{children}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
