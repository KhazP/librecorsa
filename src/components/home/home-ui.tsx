"use client";

import React from "react";
import { QualityBadge } from "@/components/ui/badges";
import type { BadgeSize } from "@/components/ui/Badge";
import type { LapOutline } from "@/lib/home/lap-outline";
import type { CarQuality } from "@/lib/cars/car-registry";
import type { CircuitQuality } from "@/lib/track-registry";
import { CAR_QUALITY_TONE, CIRCUIT_QUALITY_TONE, type HomeCar, type HomeLayout, type HomeQualityText, type HomeQualityTexts } from "./home-data";

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

/** A car's picture. Falls back smoothly to `fallbackSrc` when a livery thumbnail is missing, or stays empty with no broken-image mark */
export const CarThumb: React.FC<{ src: string | null; fallbackSrc?: string | null; className?: string; eager?: boolean }> = ({
  src,
  fallbackSrc = null,
  className,
  eager,
}) => {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const [hiddenSrc, setHiddenSrc] = React.useState<string | null>(null);
  const effectiveSrc = src && failedSrc !== src ? src : fallbackSrc;
  if (effectiveSrc === null || hiddenSrc === effectiveSrc) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={effectiveSrc}
      alt=""
      width={640}
      height={360}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={className}
      onError={() => {
        if (src && effectiveSrc === src && fallbackSrc && fallbackSrc !== src) {
          setFailedSrc(src);
        } else {
          setHiddenSrc(effectiveSrc);
        }
      }}
    />
  );
};

/** The game's words for a layout's grade: its badge, its filter option, what it means */
export const circuitQualityText = (l: Pick<HomeLayout, "quality">, text: HomeQualityTexts): HomeQualityText => text.circuits[l.quality];
/** The game's words for a car's physics: its badge, its filter option ("Own physics"), what it means */
export const carQualityText = (c: Pick<HomeCar, "quality">, text: HomeQualityTexts): HomeQualityText => text.cars[c.quality];

/** Original, Sim grade or Scan: the game's circuit badge (TrackQualityBadge's words and tone), with what it means on hover */
export const CircuitQualityTag: React.FC<{ layout: HomeLayout; text: HomeQualityTexts; size?: BadgeSize; className?: string }> = ({
  layout,
  text,
  size = "md",
  className,
}) => {
  const { badge, description } = circuitQualityText(layout, text);
  return <QualityBadge label={badge} tone={CIRCUIT_QUALITY_TONE[layout.quality]} description={description} size={size} className={className} />;
};

/** Own physics or Shared physics: the game's car badge (CarQualityBadge's words and tone), with what it means on hover */
export const CarQualityTag: React.FC<{ car: HomeCar; text: HomeQualityTexts; size?: BadgeSize; className?: string }> = ({
  car,
  text,
  size = "md",
  className,
}) => {
  const { badge, description } = carQualityText(car, text);
  return <QualityBadge label={badge} tone={CAR_QUALITY_TONE[car.quality]} description={description} size={size} className={className} />;
};
