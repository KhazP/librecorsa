import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import { Badge, type BadgeSize, type BadgeVariant } from "../Badge";
import { Trend } from "../icons/Trend";

const MINUS = "\u2212";

/** A signed time in seconds: "+0.214", "−0.087", "±0.000" */
export function formatDelta(seconds: number, digits = 3): string {
  const v = Math.abs(seconds).toFixed(digits);
  if (Number(v) === 0) return `\u00b1${v}`;
  return `${seconds < 0 ? MINUS : "+"}${v}`;
}

/**
 * A time gap with its sign and arrow, both always shown. Negative is time gained (green, arrow up), positive time
 * lost (crimson, arrow down), `best` marks an overall best (purple and the word "Best").
 */
export const DeltaBadge: React.FC<{
  seconds: number;
  best?: boolean;
  digits?: number;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}> = ({ seconds, best = false, digits = 3, size = "md", variant = "soft", className = "" }) => {
  const tx = useTranslations("common.delta");
  const text = formatDelta(seconds, digits);
  const level = text.startsWith("\u00b1");
  const gaining = seconds < 0;
  const trend = level ? "level" : gaining ? "faster" : "slower";
  // The HUD redraws it many times a second: the words are resolved when the gap shown or the language changes
  const spoken = useMemo(() => tx("spoken", { trend, seconds: text.slice(1), best: best ? "yes" : "no" }), [tx, trend, text, best]);
  return (
    <Badge
      tone={best ? "best" : level ? "neutral" : gaining ? "good" : "bad"}
      variant={variant}
      size={size}
      className={`lc-mono tabular-nums ${className}`}
      leading={<Trend direction={level ? "level" : gaining ? "up" : "down"} size="0.9em" />}
      aria-label={spoken}
    >
      {text}
      {/* Colour is never the only sign: an overall best says so */}
      {best ? <span>{tx("best")}</span> : null}
    </Badge>
  );
};
