import React from "react";
import { cx, TONE_FILL, type Tone } from "./styles";

export interface MeterProps {
  label: string;
  /** 0..1 */
  value: number;
  /** Fill colour by meaning (default `good`) */
  tone?: Tone;
  /** Read-out text (default the percentage) */
  detail?: string;
  /** Width of the label column, to line up a stack of meters (default 5 rem) */
  labelClassName?: string;
  /**
   * The name and the read-out on one line above a full-width track, both in body text: for lists whose names are long
   * (a circuit, a car) or whose read-out is a phrase ("12.3 h · 45 sessions")
   */
  stacked?: boolean;
  className?: string;
}

/** A labelled 0..1 bar: the label, an 8 px titanium track, the fill in its tone, the value in `lc-data` */
export function Meter({ label, value, tone = "good", detail, labelClassName = "w-20", stacked, className }: MeterProps) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const pct = Math.round(v * 100);
  const text = detail ?? `${pct}%`;
  const aria = {
    role: "meter",
    "aria-label": label,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": pct,
    "aria-valuetext": text,
  } as const;
  const track = (
    <span aria-hidden className={cx("relative block h-2 min-w-0 overflow-hidden rounded-full bg-lc-titanium", stacked ? "w-full" : "flex-1")}>
      <span
        className={cx("absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ease-lc", TONE_FILL[tone])}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
  if (stacked) {
    return (
      <div {...aria} className={cx("flex min-w-0 flex-col gap-1.5", className)}>
        <span aria-hidden className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[14px] leading-tight font-medium text-lc-chalk">{label}</span>
          <span className="lc-data shrink-0 text-[12px] text-lc-fog">{text}</span>
        </span>
        {track}
      </div>
    );
  }
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={text}
      className={cx("flex min-w-0 items-center gap-3", className)}
    >
      <span aria-hidden className={cx("lc-lbl shrink-0 truncate", labelClassName)}>
        {label}
      </span>
      {track}
      <span aria-hidden className="lc-data w-14 shrink-0 text-right text-[12px] text-lc-chalk">
        {text}
      </span>
    </div>
  );
}
