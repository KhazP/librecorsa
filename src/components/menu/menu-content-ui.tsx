"use client";

import React from "react";
import type { BadgeSize, BadgeTone } from "@/components/ui/Badge";
import { QualityBadge } from "@/components/ui/badges/QualityBadge";
import { circuitQualityMeta, type CircuitQuality, type TrackInfo } from "@/lib/track-registry";
import { carById, carQualityMeta, PHYSICS_CHECK, type CarClassId, type CarDefinition, type CarId, type CarQuality } from "@/lib/cars/car-registry";
import { ClassTag } from "@/components/ui/badges/ClassTag";
import type { CarClassCode } from "@/components/ui/badges/class-colors";
import { setCarSkin, useCarSkinId } from "@/lib/cars/car-skins";
import { carPhysics, useF1ModPhysics } from "@/lib/cars/f1-mod-physics";
import type { CustomLiveryColors, LiveryCategory, LiveryConfig } from "@/types/f1";
import { buildCustomLivery, LIVERY_CATEGORY_LABELS } from "@/lib/track-data";
/** The older size names the callers pass (xs is the small badge) */
export type ChipSize = "md" | "sm" | "xs";
import { focusOnHover } from "./useFocusNav";

/**
 * The menu parts that read the car and track registries or car data. Kept apart from the UI standard's own parts
 * (src/components/ui), which the home, press and admin pages use without pulling the registries in.
 */

const BADGE_SIZE: Record<ChipSize, BadgeSize> = { md: "md", sm: "sm", xs: "sm" };

/** Where a circuit's model comes from, by meaning (signed off: an original circuit is information, not volt) */
const CIRCUIT_TONE: Record<CircuitQuality, Exclude<BadgeTone, "player">> = { original: "info", sim: "good", sketchfab: "warn" };

/** How a car's physics are graded */
const CAR_TONE: Record<CarQuality, Exclude<BadgeTone, "player">> = { own: "good", shared: "warn", era: "neutral" };

/** Where a circuit's model comes from (track-registry `CircuitQuality`), with its description on hover */
export const TrackQualityBadge: React.FC<{
  track: Pick<TrackInfo, "quality">;
  size?: ChipSize;
  className?: string;
}> = ({ track, size = "md", className = "" }) => {
  const q = circuitQualityMeta(track);
  return (
    <QualityBadge
      label={q.badge}
      tone={CIRCUIT_TONE[track.quality]}
      description={q.description}
      size={BADGE_SIZE[size]}
      className={className}
    />
  );
};

/**
 * Whether a car's physics belong to it (car-registry `CarQuality`). On hover, the grade's description and how far the
 * physics it drives on now have been checked (a ported F1 car follows the physics switch).
 */
export const CarQualityBadge: React.FC<{
  car: Pick<CarDefinition, "id" | "quality">;
  size?: ChipSize;
  className?: string;
}> = ({ car, size = "md", className = "" }) => {
  const q = carQualityMeta(car);
  const physics = carPhysics(car.id, useF1ModPhysics());
  return (
    <QualityBadge
      label={q.badge}
      tone={CAR_TONE[car.quality]}
      description={`${q.description} ${PHYSICS_CHECK[physics]}`}
      size={BADGE_SIZE[size]}
      className={className}
    />
  );
};

/* A swatch: the chosen one has a white ring, the cursor a volt one with its halo; the ring's gap is the surface behind */
const SWATCH = [
  "h-9 w-12 cursor-pointer rounded-full outline-none transition-[box-shadow] duration-200 ease-lc pointer-coarse:h-11 pointer-coarse:w-14 focus-visible:outline-none in-data-[input=keyboard]:focus:transition-none in-data-[input=pad]:focus:transition-none",
  "focus:shadow-[0_0_0_2px_var(--lc-swatch-gap),0_0_0_4px_var(--color-lc-volt),0_0_0_9px_color-mix(in_srgb,var(--color-lc-volt)_14%,transparent)]",
].join(" ");
const SWATCH_CHOSEN = "shadow-[0_0_0_2px_var(--lc-swatch-gap),0_0_0_4px_var(--color-lc-chalk)]";
const SWATCH_IDLE = "inset-ring inset-ring-white/15 hover:shadow-[0_0_0_1px_var(--color-lc-slate)]";

const LIVERY_GROUPS: readonly Exclude<LiveryCategory, "custom">[] = ["house", "grid2026", "retro"];
const CUSTOM_WHEEL_GRADIENT =
  "conic-gradient(from 0deg, hsl(0 90% 56%), hsl(55 95% 54%), hsl(125 80% 48%), hsl(195 90% 52%), hsl(255 85% 60%), hsl(315 88% 58%), hsl(360 90% 56%))";

/**
 * Native `<input type="color">` fires React's `onChange` (native `input`) on every drag pixel. Keeping draft state
 * locally and committing only on native `change` / `blur` prevents repainting full 2K livery textures mid-drag.
 */
const CustomColorSlot: React.FC<{
  label: string;
  value: string;
  onDraft: (hex: string) => void;
  onCommit: (hex: string) => void;
}> = ({ label, value, onDraft, onCommit }) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const commitRef = React.useRef(onCommit);
  commitRef.current = onCommit;

  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handleNativeChange = () => commitRef.current(el.value);
    el.addEventListener("change", handleNativeChange);
    return () => el.removeEventListener("change", handleNativeChange);
  }, []);

  return (
    <label className="flex min-w-0 cursor-pointer flex-col gap-1">
      <span className="text-[11px] font-semibold text-lc-slate">{label}</span>
      <span className="flex items-center gap-1.5 rounded-lc-nub border border-lc-line bg-lc-carbon px-1.5 py-1">
        <input
          ref={inputRef}
          type="color"
          aria-label={`Custom livery ${label.toLowerCase()} colour`}
          value={value}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={(e) => onCommit(e.target.value)}
          className="size-5 shrink-0 cursor-pointer border-0 bg-transparent p-0"
        />
        <span className="lc-mono min-w-0 truncate text-[11px] text-lc-fog uppercase">{value}</span>
      </span>
    </label>
  );
};

/**
 * Livery swatches grouped by collection (LibreCorsa, 2026 Grid, Retro) plus a Custom colour picker (primary,
 * secondary, accent). The chosen swatch has a white ring, the cursor a volt one, and the caption follows the cursor.
 */
export const LiveryPicker: React.FC<{
  liveries: readonly LiveryConfig[];
  value: LiveryConfig;
  onChange: (livery: LiveryConfig) => void;
  /** The ring's gap matches the surface behind it (a CSS colour) */
  surface?: string;
}> = ({ liveries, value, onChange, surface = "var(--color-lc-void)" }) => {
  const [hover, setHover] = React.useState<LiveryConfig | null>(null);
  const shown = hover ?? value;
  const isCustom = value.id === "custom";
  const [draft, setDraft] = React.useState<CustomLiveryColors>({
    primary: value.primary,
    secondary: value.secondary,
    accent: value.accent,
  });
  React.useEffect(() => {
    setDraft({ primary: value.primary, secondary: value.secondary, accent: value.accent });
  }, [value.id, value.primary, value.secondary, value.accent]);

  const draftRef = React.useRef(draft);
  draftRef.current = draft;

  const updateDraft = (slot: keyof CustomLiveryColors, hex: string) => {
    setDraft((prev) => ({ ...prev, [slot]: hex }));
  };
  const commitSlot = (slot: keyof CustomLiveryColors, hex: string) => {
    const next: CustomLiveryColors = { ...draftRef.current, [slot]: hex };
    setDraft(next);
    if (
      value.id === "custom" &&
      next.primary.toLowerCase() === value.primary.toLowerCase() &&
      next.secondary.toLowerCase() === value.secondary.toLowerCase() &&
      next.accent.toLowerCase() === value.accent.toLowerCase()
    ) {
      return;
    }
    onChange(buildCustomLivery(next));
  };

  const groups = LIVERY_GROUPS.map((cat) => ({
    cat,
    label: LIVERY_CATEGORY_LABELS[cat],
    items: liveries.filter((l) => (l.category ?? "house") === cat),
  })).filter((g) => g.items.length > 0);

  const shownGroup = shown.category && shown.category !== "custom" ? LIVERY_CATEGORY_LABELS[shown.category] : null;
  const captionRight =
    shownGroup && !shown.team.toLowerCase().includes(shownGroup.toLowerCase()) ? `${shownGroup} · ${shown.team}` : shown.team;

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-lc-chalk" title={shown.name}>
          {shown.name}
        </span>
        <span className="shrink-0 truncate text-[12px] text-lc-slate">{captionRight}</span>
      </div>

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Livery">
        {groups.map((g, gi) => (
          <div
            key={g.cat}
            aria-label={g.label}
            className={`flex flex-wrap items-center gap-2 ${gi > 0 ? "border-t border-lc-line/60 pt-2" : ""}`}
          >
            {g.items.map((liv) => {
              const on = value.id === liv.id;
              return (
                <button
                  key={liv.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`${liv.name} · ${g.label} · ${liv.team}`}
                  onClick={() => onChange(liv)}
                  onPointerEnter={focusOnHover}
                  onFocus={() => setHover(liv)}
                  onBlur={() => setHover(null)}
                  className={`${SWATCH} ${on ? SWATCH_CHOSEN : SWATCH_IDLE}`}
                  style={
                    {
                      "--lc-swatch-gap": surface,
                      background: `linear-gradient(135deg, ${liv.primary} 0 55%, ${liv.accent} 55% 65%, ${liv.secondary} 65% 100%)`,
                    } as React.CSSProperties
                  }
                />
              );
            })}
            {gi === 0 ? (
              <button
                type="button"
                role="radio"
                aria-checked={isCustom}
                aria-label="Custom Paint · Custom colour picker"
                onClick={() => onChange(buildCustomLivery(draft))}
                onPointerEnter={focusOnHover}
                onFocus={() => setHover(buildCustomLivery(draft))}
                onBlur={() => setHover(null)}
                className={`${SWATCH} ${isCustom ? SWATCH_CHOSEN : SWATCH_IDLE}`}
                style={
                  {
                    "--lc-swatch-gap": surface,
                    background: CUSTOM_WHEEL_GRADIENT,
                  } as React.CSSProperties
                }
              />
            ) : null}
          </div>
        ))}
      </div>

      {isCustom ? (
        <div className="grid grid-cols-3 gap-2 rounded-lc-row border border-lc-line bg-lc-well p-2">
          {(
            [
              ["primary", "Primary"],
              ["secondary", "Secondary"],
              ["accent", "Accent"],
            ] as const
          ).map(([slot, label]) => (
            <CustomColorSlot
              key={slot}
              label={label}
              value={draft[slot]}
              onDraft={(hex) => updateDraft(slot, hex)}
              onCommit={(hex) => commitSlot(slot, hex)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The liveries of a car that has its own (its mod's skins, `CarDefinition.skins`): one swatch each in its two main
 * colours, the picked one ringed, its name beside them. The pick is kept per car and goes onto the car at once.
 */
export const CarSkinPicker: React.FC<{ carId: CarId; surface?: string }> = ({ carId, surface = "var(--color-lc-void)" }) => {
  const skins = carById(carId).skins ?? [];
  const value = useCarSkinId(carId) ?? skins[0]?.id;
  const [hover, setHover] = React.useState<string | null>(null);
  const shown = skins.find((s) => s.id === (hover ?? value));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Livery">
        {skins.map((skin) => {
          const on = value === skin.id;
          return (
            <button
              key={skin.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={skin.name}
              onClick={() => setCarSkin(carId, skin.id)}
              onPointerEnter={focusOnHover}
              onFocus={() => setHover(skin.id)}
              onBlur={() => setHover(null)}
              className={`${SWATCH} ${on ? SWATCH_CHOSEN : SWATCH_IDLE}`}
              style={
                {
                  "--lc-swatch-gap": surface,
                  background: `linear-gradient(135deg, ${skin.swatch[0]} 0 60%, ${skin.swatch[1]} 60% 100%)`,
                } as React.CSSProperties
              }
            />
          );
        })}
      </div>
      <span className="min-w-0 truncate text-[13px] font-semibold text-lc-fog" title={shown?.name}>{shown?.name}</span>
    </div>
  );
};

/** The registry's class ids on the kit's class codes (one colour table, in class-colors.ts) */
const CLASS_CODE: Record<CarClassId, CarClassCode> = { f1: "openWheel", gt3: "gt3", proto: "proto", classic: "classic", road: "road" };

/** A car on the online board of every car (src/lib/cars/board-tag.ts, shared with the home page) */
export { carBoardTag } from "@/lib/cars/board-tag";

/** A car's class as the kit's `ClassTag` */
export const CarClassTag: React.FC<{ car: Pick<CarDefinition, "classId">; size?: BadgeSize; className?: string }> = ({
  car,
  size = "sm",
  className,
}) => <ClassTag carClass={CLASS_CODE[car.classId] ?? "road"} size={size} className={className} />;
