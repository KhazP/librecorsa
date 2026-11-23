"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import type { BadgeSize, BadgeTone } from "@/components/ui/Badge";
import { QualityBadge } from "@/components/ui/badges/QualityBadge";
import { circuitQualityMeta, type CircuitQuality, type TrackInfo } from "@/lib/track-registry";
import {
  carById,
  carQualityMeta,
  carSkinSwatchBackground,
  PHYSICS_CHECK,
  type CarClassId,
  type CarDefinition,
  type CarId,
  type CarQuality,
} from "@/lib/cars/car-registry";
import { ClassTag } from "@/components/ui/badges/ClassTag";
import type { CarClassCode } from "@/components/ui/badges/class-colors";
import { setCarSkin, useCarSkinId } from "@/lib/cars/car-skins";
import { carPhysics, useF1ModPhysics } from "@/lib/cars/f1-mod-physics";
import type { CustomLiveryColors, LiveryCategory, LiveryConfig } from "@/types/f1";
import { buildCustomLivery, CUSTOM_LIVERY_PALETTE, LIVERY_CATEGORY_LABELS } from "@/lib/track-data";
import { liverySwatchBackground } from "@/lib/render/livery-repaint";
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
  "relative h-9 w-14 cursor-pointer overflow-hidden rounded-full outline-none transition-[box-shadow] duration-200 ease-lc pointer-coarse:h-11 pointer-coarse:w-16 focus-visible:outline-none in-data-[input=keyboard]:focus:transition-none in-data-[input=pad]:focus:transition-none",
  "focus:shadow-[0_0_0_2px_var(--lc-swatch-gap),0_0_0_4px_var(--color-lc-volt),0_0_0_9px_color-mix(in_srgb,var(--color-lc-volt)_14%,transparent)]",
].join(" ");
const SWATCH_CHOSEN = "shadow-[0_0_0_2px_var(--lc-swatch-gap),0_0_0_4px_var(--color-lc-chalk)]";
const SWATCH_IDLE = "inset-ring inset-ring-white/15 hover:shadow-[0_0_0_1px_var(--color-lc-slate)]";
const MINI_SWATCH = [
  "size-5 shrink-0 cursor-pointer rounded-full outline-none transition-[box-shadow] duration-200 ease-lc pointer-coarse:size-7 focus-visible:outline-none in-data-[input=keyboard]:focus:transition-none in-data-[input=pad]:focus:transition-none",
  "focus:shadow-[0_0_0_2px_var(--lc-swatch-gap),0_0_0_4px_var(--color-lc-volt),0_0_0_8px_color-mix(in_srgb,var(--color-lc-volt)_14%,transparent)]",
].join(" ");

const LIVERY_GROUPS: readonly Exclude<LiveryCategory, "custom">[] = ["house", "grid2026", "retro"];
const CUSTOM_WHEEL_GRADIENT =
  "conic-gradient(from 0deg, hsl(0 90% 56%), hsl(55 95% 54%), hsl(125 80% 48%), hsl(195 90% 52%), hsl(255 85% 60%), hsl(315 88% 58%), hsl(360 90% 56%))";

/**
 * Native `<input type="color">` fires React's `onChange` (native `input`) on every drag pixel. Keeping draft state
 * locally and committing only on native `change` / `blur` prevents repainting full 2K livery textures mid-drag.
 * A focusable preset swatch row sits alongside it so controller and keyboard users can pick colours without a mouse.
 */
const CustomColorSlot: React.FC<{
  slot: keyof CustomLiveryColors;
  value: string;
  onDraft: (hex: string) => void;
  onCommit: (hex: string) => void;
}> = ({ slot, value, onDraft, onCommit }) => {
  const tx = useTranslations("menu.livery");
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

  const lower = value.toLowerCase();

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-lc-slate">{tx("slot", { slot })}</span>
        <label
          data-nav-skip=""
          className="flex cursor-pointer items-center gap-1.5 rounded-lc-nub border border-lc-line bg-lc-carbon px-1.5 py-0.5 focus-within:border-lc-volt"
        >
          <input
            ref={inputRef}
            type="color"
            aria-label={tx("slotInput", { slot })}
            value={value}
            onChange={(e) => onDraft(e.target.value)}
            onBlur={(e) => onCommit(e.target.value)}
            className="size-4 shrink-0 cursor-pointer border-0 bg-transparent p-0 outline-none"
          />
          <span className="lc-mono text-[11px] text-lc-fog uppercase">{value}</span>
        </label>
      </div>
      <div role="group" aria-label={tx("slotPresets", { slot })} className="flex flex-wrap items-center gap-1.5">
        {CUSTOM_LIVERY_PALETTE.map((preset) => {
          const active = lower === preset.hex.toLowerCase();
          return (
            <button
              key={preset.hex}
              type="button"
              aria-label={tx("slotPreset", { slot, colour: preset.name })}
              aria-pressed={active}
              onClick={() => onCommit(preset.hex)}
              onPointerEnter={focusOnHover}
              className={`${MINI_SWATCH} ${active ? SWATCH_CHOSEN : SWATCH_IDLE}`}
              style={
                {
                  "--lc-swatch-gap": "var(--color-lc-well)",
                  backgroundColor: preset.hex,
                } as React.CSSProperties
              }
            />
          );
        })}
      </div>
    </div>
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
  /** Fires when a swatch is hovered or focused, and clears (`null`) on blur or mouse leave */
  onHover?: (livery: LiveryConfig | null) => void;
  /** The ring's gap matches the surface behind it (a CSS colour) */
  surface?: string;
}> = ({ liveries, value, onChange, onHover, surface = "var(--color-lc-void)" }) => {
  const tx = useTranslations("menu.livery");
  const [hover, setHover] = React.useState<LiveryConfig | null>(null);
  const hoverRef = React.useRef<LiveryConfig | null>(null);
  const onHoverRef = React.useRef(onHover);
  onHoverRef.current = onHover;
  const updateHover = React.useCallback((next: LiveryConfig | null) => {
    const prev = hoverRef.current;
    if (
      prev === next ||
      (prev &&
        next &&
        prev.id === next.id &&
        prev.primary === next.primary &&
        prev.secondary === next.secondary &&
        prev.accent === next.accent)
    ) {
      return;
    }
    hoverRef.current = next;
    setHover(next);
    onHoverRef.current?.(next);
  }, []);
  React.useEffect(
    () => () => {
      if (hoverRef.current !== null) {
        hoverRef.current = null;
        onHoverRef.current?.(null);
      }
    },
    [],
  );

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
    const next: CustomLiveryColors = { ...draftRef.current, [slot]: hex };
    draftRef.current = next;
    setDraft(next);
  };
  const commitSlot = (slot: keyof CustomLiveryColors, hex: string) => {
    const next: CustomLiveryColors = { ...draftRef.current, [slot]: hex };
    draftRef.current = next;
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

      <div
        className="flex flex-col gap-2"
        role="radiogroup"
        aria-label={tx("group")}
        onMouseLeave={() => updateHover(null)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) updateHover(null);
        }}
      >
        {groups.map((g, gi) => (
          <div
            key={g.cat}
            role="group"
            aria-label={g.label}
            className={`flex flex-wrap items-center gap-2 ${gi > 0 ? "border-t border-lc-line/60 pt-2" : ""}`}
          >
            {g.items.map((liv) => {
              const on = value.id === liv.id;
              const sponsor = liv.visual?.sponsors.title;
              return (
                <button
                  key={liv.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={sponsor ? `${liv.name} · ${sponsor} · ${g.label}` : `${liv.name} · ${g.label} · ${liv.team}`}
                  onClick={() => onChange(liv)}
                  onPointerEnter={(e) => {
                    focusOnHover(e);
                    if (e.pointerType === "mouse") updateHover(liv);
                  }}
                  onFocus={() => updateHover(liv)}
                  className={`${SWATCH} ${on ? SWATCH_CHOSEN : SWATCH_IDLE}`}
                  style={
                    {
                      "--lc-swatch-gap": surface,
                      background: liverySwatchBackground(liv),
                    } as React.CSSProperties
                  }
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent"
                  />
                </button>
              );
            })}
            {gi === 0 ? (
              <button
                type="button"
                role="radio"
                aria-checked={isCustom}
                aria-label={tx("custom")}
                onClick={() => onChange(buildCustomLivery(draft))}
                onPointerEnter={(e) => {
                  focusOnHover(e);
                  if (e.pointerType === "mouse") updateHover(buildCustomLivery(draft));
                }}
                onFocus={() => updateHover(buildCustomLivery(draft))}
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
        <div className="flex flex-col gap-2.5 rounded-lc-row border border-lc-line bg-lc-well p-2.5">
          {(["primary", "secondary", "accent"] as const).map((slot) => (
            <CustomColorSlot
              key={slot}
              slot={slot}
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
export const CarSkinPicker: React.FC<{
  carId: CarId;
  /** Fires when a skin swatch is hovered or focused, and clears (`null`) on blur or mouse leave */
  onHover?: (skinId: string | null) => void;
  surface?: string;
}> = ({ carId, onHover, surface = "var(--color-lc-void)" }) => {
  const tx = useTranslations("menu.livery");
  const skins = carById(carId).skins ?? [];
  const value = useCarSkinId(carId) ?? skins[0]?.id;
  const [hover, setHover] = React.useState<string | null>(null);
  const hoverRef = React.useRef<string | null>(null);
  const onHoverRef = React.useRef(onHover);
  onHoverRef.current = onHover;
  const updateHover = React.useCallback((next: string | null) => {
    if (hoverRef.current === next) return;
    hoverRef.current = next;
    setHover(next);
    onHoverRef.current?.(next);
  }, []);
  React.useEffect(() => {
    updateHover(null);
  }, [carId, updateHover]);
  React.useEffect(
    () => () => {
      if (hoverRef.current !== null) {
        hoverRef.current = null;
        onHoverRef.current?.(null);
      }
    },
    [],
  );

  const shown = skins.find((s) => s.id === (hover ?? value));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="flex flex-wrap items-center gap-2"
        role="radiogroup"
        aria-label={tx("skinGroup")}
        onMouseLeave={() => updateHover(null)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) updateHover(null);
        }}
      >
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
              onPointerEnter={(e) => {
                focusOnHover(e);
                if (e.pointerType === "mouse") updateHover(skin.id);
              }}
              onFocus={() => updateHover(skin.id)}
              className={`${SWATCH} ${on ? SWATCH_CHOSEN : SWATCH_IDLE}`}
              style={
                {
                  "--lc-swatch-gap": surface,
                  background: carSkinSwatchBackground(skin),
                } as React.CSSProperties
              }
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent"
              />
            </button>
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
