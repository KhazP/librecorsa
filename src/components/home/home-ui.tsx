"use client";

import React from "react";
import { QualityBadge } from "@/components/ui/badges";
import type { BadgeSize } from "@/components/ui/Badge";
import type { LapOutline } from "@/lib/home/lap-outline";
import { GRADE_BADGES, GRADE_NOTES, type HomeGrade } from "./home-data";

const PAD = 70;

/** A circuit's outline, still: for cards, where a lapping dot on every one would be noise */
export const OutlineThumb: React.FC<{ outline: LapOutline | null; className?: string }> = ({ outline: o, className }) =>
  o ? (
    <svg viewBox={`${-PAD} ${-PAD} ${o.w + PAD * 2} ${o.h + PAD * 2}`} preserveAspectRatio="xMidYMid meet" className={className} aria-hidden>
      <path d={o.d} fill="none" stroke="currentColor" strokeOpacity={0.16} strokeWidth={64} strokeLinejoin="round" />
      <path d={o.d} fill="none" stroke="currentColor" strokeWidth={20} strokeLinejoin="round" />
    </svg>
  ) : (
    <span aria-hidden className={className} />
  );

/** A car's picture. A copy of the game without that car's files has none: the space stays empty, with no broken-image mark */
export const CarThumb: React.FC<{ src: string | null; className?: string; eager?: boolean }> = ({ src, className, eager }) =>
  src === null ? null : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={640}
      height={360}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={className}
      onError={(e) => {
        e.currentTarget.style.visibility = "hidden";
      }}
    />
  );

/** Sim grade or 3D model: the game's own quality badge, with what it means on hover */
export const GradeBadge: React.FC<{ grade: HomeGrade; title?: string; size?: BadgeSize; className?: string }> = ({
  grade,
  title,
  size = "md",
  className,
}) => {
  const { label, tone } = GRADE_BADGES[grade];
  return <QualityBadge label={label} tone={tone} description={title} size={size} className={className} />;
};

/** What the badges on a wall of cards mean, for the grades that appear on it */
export const GradeLegend: React.FC<{ of: keyof typeof GRADE_NOTES; shown: readonly HomeGrade[] }> = ({ of, shown }) => (
  <dl className="m-0 flex flex-wrap gap-x-8 gap-y-2.5">
    {(["sim", "model"] as const).filter((grade) => shown.includes(grade)).map((grade) => (
      <div key={grade} className="flex min-w-0 items-start gap-2.5">
        {/* Stacked on a phone: the same width for both, so the two notes start in line */}
        <dt className="shrink-0 max-sm:min-w-[96px]">
          <GradeBadge grade={grade} />
        </dt>
        <dd className="lc-body m-0 pt-0.5">{GRADE_NOTES[of][grade]}</dd>
      </div>
    ))}
  </dl>
);
