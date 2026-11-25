"use client";

import { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { RaceStandingEntry } from "@/types/f1";

/**
 * A car in the pits as a timing tower's gap shows it: the crew's live clock while it stands in its box ("PIT 2.3"),
 * the word alone in the lane; null on the track, and for a car out of the race or past the flag (their own words)
 */
export function pitGapText(e: RaceStandingEntry, pit: string, clock: (seconds: string) => string): string | null {
  if (e.retired || e.finished) return null;
  if (e.pitBox) return clock(e.pitBox.elapsedS.toFixed(1));
  return e.inPit ? pit : null;
}

/** `pitGapText` in the player's language, for every tower's gap column */
export function usePitGap(): (e: RaceStandingEntry) => string | null {
  const tx = useTranslations("hud.timingPanels.tower");
  return useMemo(() => {
    const pit = tx("pit");
    return (e: RaceStandingEntry) => pitGapText(e, pit, (seconds) => tx("pitClock", { seconds }));
  }, [tx]);
}
