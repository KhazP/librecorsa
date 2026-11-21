"use client";

import React, { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_GLASS } from "./hud-format";
import { SkinBanner, useHudSkin } from "./styles/third-party-skin";

/** How long the note stays up (ms) */
const SHOWN_MS = 4000;

const TEXT = {
  lowered: "Graphics scaled down",
  floor: "Low FPS · 30 fps cap available in Settings",
} as const;

type Notice = { id: number; kind: keyof typeof TEXT };

/** Notes already shown: the HUD mounts again after the menus, and must not show the last one a second time */
const seen = new WeakSet<Notice>();

/**
 * The automatic quality's note, under the race-control notices: a small pill for a few seconds after the graphics
 * step down (drive-session.ts says so at most once a minute), never anything to press. Read out politely.
 */
export function QualityNotice({ notice }: { notice: Notice | null }) {
  const skin = useHudSkin();
  const [shown, setShown] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice || seen.has(notice)) return;
    seen.add(notice);
    setShown(notice);
  }, [notice]);
  // The hide timer goes with the note on screen, not with the prop: the prop going back to null, or an effect run
  // twice (dev Strict Mode), must not leave the note up for good
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(null), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return (
    <div role="status" aria-live="polite" className="contents">
      {shown ? (
        skin !== null ? (
          <SkinBanner
            key={shown.id}
            tone="caution"
            cut="sm"
            className="lc-toast-in inline-flex min-h-9 items-center gap-2 py-1 pr-4 pl-3"
          >
            <Icon name="graphics" size="xs" />
            <span className="text-[13px] leading-snug font-semibold">{TEXT[shown.kind]}</span>
          </SkinBanner>
        ) : (
          <div key={shown.id} className={`lc-toast-in inline-flex min-h-9 items-center gap-2 rounded-lc-row py-1 pr-3.5 pl-3 text-lc-fog ${HUD_GLASS}`}>
            <Icon name="graphics" size="xs" />
            <span className="text-[13px] leading-snug font-semibold">{TEXT[shown.kind]}</span>
          </div>
        )
      ) : null}
    </div>
  );
}
