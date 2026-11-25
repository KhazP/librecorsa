"use client";

import React, { useMemo, useRef } from "react";
import { useTranslations } from "use-intl/react";
import type { RaceStatus } from "@/types/f1";
import { FinalLapCue, finalLapState } from "@/lib/broadcast/final-lap";
import { FlagIcon } from "@/components/ui/badges/FlagIcon";
import { HUD_GLASS } from "./hud-format";
import { SkinBanner, useHudSkin } from "./styles/third-party-skin";

/**
 * The race's last lap, called at the top centre with race control's notices for a few seconds as the leader starts it
 * (`FinalLapCue`), in every layout. The lap counters say when the player is on their own last lap (`onFinalLap`).
 */
export const FinalLapNotice: React.FC<{
  race: RaceStatus | undefined;
  /** Shown whenever the race is on its last lap, whatever the timing (the HUD test page's still frame) */
  hold?: boolean;
}> = ({ race, hold = false }) => {
  const skin = useHudSkin();
  const tx = useTranslations("hud.finalLapNotice");
  const title = useMemo(() => tx("title"), [tx]);
  const cueRef = useRef<FinalLapCue | null>(null);
  cueRef.current ??= new FinalLapCue();
  // Read in the render: the HUD redraws with every telemetry tick, which is what ends the notice on time
  const shown = hold ? finalLapState(race).race : cueRef.current.update(race, performance.now());
  if (!shown) return null;
  if (skin !== null) {
    return (
      <SkinBanner role="status" cut="sm" className="relative mt-1 inline-flex min-h-10 items-center gap-2.5 py-1 pe-4 ps-2.5">
        <FlagIcon flag="chequered" size={18} />
        <span className="text-[15px] font-bold uppercase">{title}</span>
      </SkinBanner>
    );
  }
  return (
    <div role="status" className={`relative mt-1 inline-flex min-h-10 items-center gap-2 rounded-lc-row py-1 pe-4 ps-2.5 text-lc-chalk inset-ring inset-ring-white/20 ${HUD_GLASS}`}>
      <FlagIcon flag="chequered" size={22} />
      <span className="lc-disp text-[17px] leading-none whitespace-nowrap">{title}</span>
    </div>
  );
};
