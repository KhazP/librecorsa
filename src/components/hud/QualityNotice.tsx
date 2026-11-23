"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_GLASS } from "./hud-format";
import { SkinBanner, useHudSkin } from "./styles/third-party-skin";

/** How long the note stays up (ms) */
const SHOWN_MS = 4000;

/** `lowered`: the graphics stepped down; `floor`: the lowest step and still slow */
type Notice = { id: number; kind: "lowered" | "floor" };

/** Notes already shown: the HUD mounts again after the menus, and must not show the last one a second time */
const seen = new WeakSet<Notice>();

/**
 * The automatic quality's note, under the race-control notices: a small pill for a few seconds after the graphics
 * step down (drive-session.ts says so at most once a minute), never anything to press. Read out politely.
 */
export function QualityNotice({ notice }: { notice: Notice | null }) {
  const skin = useHudSkin();
  const tx = useTranslations("hud.qualityNotice");
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
  // The HUD re-renders every frame: the note's words are read when it changes
  const text = useMemo(() => (shown ? tx(shown.kind) : ""), [tx, shown]);
  return (
    <div role="status" aria-live="polite" className="contents">
      {shown ? (
        skin !== null ? (
          <SkinBanner
            key={shown.id}
            tone="caution"
            cut="sm"
            className="lc-toast-in inline-flex min-h-9 items-center gap-2 py-1 pe-4 ps-3"
          >
            <Icon name="graphics" size="xs" />
            <span className="text-[13px] leading-snug font-semibold">{text}</span>
          </SkinBanner>
        ) : (
          <div key={shown.id} className={`lc-toast-in inline-flex min-h-9 items-center gap-2 rounded-lc-row py-1 pe-3.5 ps-3 text-lc-fog ${HUD_GLASS}`}>
            <Icon name="graphics" size="xs" />
            <span className="text-[13px] leading-snug font-semibold">{text}</span>
          </div>
        )
      ) : null}
    </div>
  );
}
