import React from "react";

export type TrendDirection = "up" | "down" | "level";

const SHAPE: Record<TrendDirection, React.ReactNode> = {
  up: <path d="M12 5.5 19.5 18h-15Z" />,
  down: <path d="M12 18.5 4.5 6h15Z" />,
  level: <rect x="4.5" y="10" width="15" height="4" rx="1" />,
};

const AUTO_TONE: Record<TrendDirection, string> = {
  up: "text-lc-gain",
  down: "text-lc-loss",
  level: "text-lc-slate",
};

/**
 * Gain and loss: the drawn arrow that replaces every ▲ ▼ ▴ ▾ ◂ ▸ in the game. "up" means better (places gained, time
 * gained), "down" worse. It sizes with the text around it unless given a size.
 */
export const Trend: React.FC<{
  direction: TrendDirection;
  /** Pixels, or any CSS length; defaults to 0.8em so it follows the text */
  size?: number | string;
  /** Colour it green / crimson / slate by direction; otherwise it takes the text colour */
  colored?: boolean;
  /** Spoken meaning ("3 places gained"), when no text beside it says it */
  label?: string;
  className?: string;
}> = ({ direction, size = "0.8em", colored = false, label, className = "" }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="currentColor"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinejoin="round"
    focusable="false"
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    className={`inline-block shrink-0 align-[-0.08em] ${colored ? AUTO_TONE[direction] : ""} ${className}`}
  >
    {SHAPE[direction]}
  </svg>
);
