"use client";

import React, { createContext, forwardRef, useContext } from "react";
import { THIRD_PARTY_HUD_LAYOUTS, type HudPreset } from "@/lib/settings/hud-layouts";
import skinCss from "./third-party-skin.module.css";

export type ThirdPartySkin = (typeof THIRD_PARTY_HUD_LAYOUTS)[number]["id"];
export type SkinTone = "default" | "accent" | "gain" | "caution" | "loss" | "info" | "best";
export type SkinCut = "sm" | "md" | "lg";

const SKIN_IDS = new Set<string>(THIRD_PARTY_HUD_LAYOUTS.map((l) => l.id));

const SKIN_CLASS: Record<ThirdPartySkin, string> = {
  irdashies: `${skinCss.skinRoot} ${skinCss.skin_irdashies}`,
  racevision: `${skinCss.skinRoot} ${skinCss.skin_racevision}`,
  h2h: `${skinCss.skinRoot} ${skinCss.skin_h2h}`,
  retro: `${skinCss.skinRoot} ${skinCss.skin_retro}`,
  blocks: `${skinCss.skinRoot} ${skinCss.skin_blocks}`,
  "grand-prix": `${skinCss.skinRoot} ${skinCss.skin_grand_prix}`,
};

const TONE_CLASS: Record<SkinTone, string> = {
  default: skinCss.tone_default,
  accent: skinCss.tone_accent,
  gain: skinCss.tone_gain,
  caution: skinCss.tone_caution,
  loss: skinCss.tone_loss,
  info: skinCss.tone_info,
  best: skinCss.tone_best,
};

const CUT_CLASS: Record<SkinCut, string> = {
  sm: skinCss.cut_sm,
  md: skinCss.cut_md,
  lg: skinCss.cut_lg,
};

/** Maps active HUD preset (+ phone override) to its third-party skin id, or null for built-in styles */
export function thirdPartySkinOf(preset: HudPreset, phone = false): ThirdPartySkin | null {
  if (phone) return null;
  return SKIN_IDS.has(preset) ? (preset as ThirdPartySkin) : null;
}

/** Root CSS module classes exposing the active third-party skin tokens */
export function skinRootClass(skin: ThirdPartySkin | null): string | undefined {
  return skin ? SKIN_CLASS[skin] : undefined;
}

const HudSkinContext = createContext<ThirdPartySkin | null>(null);

export const HudSkinProvider: React.FC<{ skin: ThirdPartySkin | null; children: React.ReactNode }> = ({
  skin,
  children,
}) => <HudSkinContext.Provider value={skin}>{children}</HudSkinContext.Provider>;

/** Active third-party HUD skin inside F1TelemetryHud, or null for built-in presets */
export function useHudSkin(): ThirdPartySkin | null {
  return useContext(HudSkinContext);
}

export interface SkinPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: SkinTone;
  cut?: SkinCut;
  innerClassName?: string;
}

/** A panel in the active layout's construction: irDashies' slate, RaceVision's black window, Head to Head's ruled card, Retro's cut-corner frame, a Blocks block */
export const SkinPanel = forwardRef<HTMLDivElement, SkinPanelProps>(function SkinPanel(
  { tone = "default", cut = "md", className, innerClassName, children, ...rest },
  ref,
) {
  const skin = useHudSkin();
  return (
    <div
      ref={ref}
      className={[skin ? SKIN_CLASS[skin] : "", skinCss.panel, TONE_CLASS[tone], CUT_CLASS[cut], className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      <div className={[skinCss.panelInner, innerClassName].filter(Boolean).join(" ")}>{children}</div>
    </div>
  );
});

export interface SkinBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: SkinTone;
  cut?: SkinCut;
}

/** A notice or race-control call in the active layout's construction (its frame drawn on a layer behind the content) */
export const SkinBanner = forwardRef<HTMLDivElement, SkinBannerProps>(function SkinBanner(
  { tone = "default", cut = "sm", className, children, ...rest },
  ref,
) {
  const skin = useHudSkin();
  return (
    <div
      ref={ref}
      className={[skin ? SKIN_CLASS[skin] : "", skinCss.banner, TONE_CLASS[tone], CUT_CLASS[cut], className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      <span aria-hidden className={skinCss.chrome} />
      {children}
    </div>
  );
});

export interface SkinTagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: SkinTone;
  filled?: boolean;
}

/** A chip or call in the active layout's look; filled, the tone is the fill under the layout's dark ink */
export const SkinTag: React.FC<SkinTagProps> = ({
  tone = "default",
  filled = false,
  className,
  children,
  ...rest
}) => {
  const skin = useHudSkin();
  return (
    <span
      className={[
        skin ? SKIN_CLASS[skin] : "",
        skinCss.tag,
        TONE_CLASS[tone],
        filled ? skinCss.tagFilled : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </span>
  );
};

export interface SkinButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  soft?: boolean;
}

/**
 * A control in the active layout's look (tabs, steps, folds). The frame is a layer behind the label, so a cut-corner
 * frame never clips the focus ring or the touch area. `active` is the layout's own chosen state, `soft` its quieter one.
 */
export const SkinButton = forwardRef<HTMLButtonElement, SkinButtonProps>(function SkinButton(
  { active = false, soft = false, className, type = "button", children, ...rest },
  ref,
) {
  const skin = useHudSkin();
  const activeCls = active ? (soft ? skinCss.btnSoftActive : skinCss.btnActive) : "";
  return (
    <button
      ref={ref}
      type={type}
      className={[skin ? SKIN_CLASS[skin] : "", skinCss.btn, activeCls, className].filter(Boolean).join(" ")}
      {...rest}
    >
      <span aria-hidden className={skinCss.chrome} />
      {children}
    </button>
  );
});

export { skinCss };
