import React from "react";
import { cx } from "./styles";

export interface SkeletonProps {
  /** `block` (a tile or picture), `line` (a line of text), `circle` (an avatar or icon) */
  shape?: "block" | "line" | "circle";
  /** Size it to the content it stands for: `h-24 w-full`, `w-32`, `size-11` */
  className?: string;
}

const SHAPE = {
  block: "rounded-lc-nub",
  line: "h-3 rounded-full",
  circle: "rounded-full",
} as const;

/**
 * A titanium block at the size of the content it stands for, pulsing slowly (still under reduced motion). Hidden from
 * screen readers: the container says it is loading (`aria-busy`).
 */
export function Skeleton({ shape = "block", className }: SkeletonProps) {
  return <span aria-hidden className={cx("lc-skeleton block bg-lc-titanium", SHAPE[shape], className)} />;
}

/** Lines of text still loading: the last one shorter, as text ends */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} shape="line" className={i === lines - 1 && lines > 1 ? "w-3/5" : "w-full"} />
      ))}
    </span>
  );
}
