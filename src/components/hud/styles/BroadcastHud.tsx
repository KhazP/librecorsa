"use client";

import { getActivePointToPoint } from "@/lib/track-data";
import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry } from "@/types/f1";
import {
  cornerLabel,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  HUD_BEST,
  LAP_MARK_COLOR,
  sectorDone,
  sessionWord,
} from "../hud-format";
import { LibreCorsaMark } from "../../ui/LibreCorsaLogo";
import {
  formatOnce,
  HUD_GLASS,
  HUD_LBL,
  InvalidTag,
  lapMark,
  LapMarkGlyph,
  MiniMap,
  type HudDesignProps,
} from "./hud-style-parts";
import { useDisplayLap } from "./third-party-parts";
import { TowerHeader, TowerRows } from "../TimingPanels";
import { FlagIcon } from "@/components/ui/badges/FlagIcon";
import { onFinalLap } from "./game-style-parts";

/** The words of the timing tower and map the Telemetry layout draws (once the Broadcast layout's), resolved once per language */
function useBroadcastWords() {
  const tx = useTranslations("hudStyles.broadcast");
  return useMemo(
    () => ({
      timingTower: tx("timingTower"),
      session: tx("session"),
      outLap: tx("outLap"),
      best: tx("best"),
      last: tx("last"),
      finalLap: tx("finalLap"),
      circuitMap: tx("circuitMap"),
      straight: tx("straight"),
      raceLap: formatOnce((lap: number, total: number) =>
        total
          ? tx.rich("raceLapOfTotal", { lap: String(lap), total: String(total), dim: (c) => <span className="opacity-40">{c}</span> })
          : tx("raceLap", { lap: String(lap) }),
      ),
      sessionLap: formatOnce((session: string, kind: "lap" | "run", lap: number) =>
        tx.rich("sessionLap", { session, kind, lap: String(lap), dim: (c) => <span className="opacity-45">{c}</span> }),
      ),
      sector: formatOnce((sector: number) => tx("sector", { sector: String(sector) })),
      sectorTitle: formatOnce((sector: number, corner: string) => tx("sectorTitle", { sector: String(sector), corner })),
    }),
    [tx],
  );
}

/** Timing tower in a race, the session card (lap time, sectors, best / last) in practice. Fills its parent's width. */
export const BroadcastTower: React.FC<{
  t: CarTelemetry;
  trackCode?: string;
  className?: string;
  /** `useLapInvalid`: the cut-lap reading every panel shows */
  lapInvalid: boolean;
  gaps?: "interval" | "leader";
}> = ({ t, trackCode = "LC", className = "", lapInvalid, gaps }) => {
  const race = t.race;
  const w = useBroadcastWords();
  const lap = useDisplayLap(t);
  return (
    <section aria-label={race ? w.timingTower : w.session} className={`w-full overflow-hidden rounded-lc-tile ${HUD_GLASS} ${className}`}>
      <div className="flex h-11 items-center gap-2.5 rounded-[20px_20px_14px_14px] bg-lc-chalk pr-3 pl-2 text-lc-void">
        <LibreCorsaMark className="h-7 w-7 shrink-0" />
        <div className="lc-disp flex-1 truncate text-[18px]">
          {race ? (
            // The player's own last lap (a lap down, the one after the leader's) says so in place of the count
            onFinalLap(t) ? (
              <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
                <FlagIcon flag="chequered" size={18} className="shrink-0" />
                <span className="truncate">{w.finalLap}</span>
              </span>
            ) : (
              w.raceLap(lap, race.totalLaps ?? 0)
            )
          ) : (
            <>
              {/* On the out-lap no lap is timed yet: the header says so on its own (the session word would not fit
                  beside it), as the clock holds at zero */}
              {t.outLap
                ? w.outLap
                : w.sessionLap(sessionWord(t), getActivePointToPoint() ? "run" : "lap", lap)}
            </>
          )}
        </div>
        <span className={`${HUD_LBL} text-lc-void/60`}>{trackCode}</span>
      </div>
      {race ? (
        <>
          <TowerHeader gaps={gaps} />
          <TowerRows race={race} gaps={gaps} />
        </>
      ) : (
        <div className="px-3 pt-2.5 pb-3">
          <div className="flex items-center gap-2">
            <span className={`lc-data text-[30px] leading-none ${lapInvalid ? "text-lc-loss" : "text-lc-chalk"}`}>
              {formatLapClock(t)}
            </span>
            {lapInvalid ? <InvalidTag /> : null}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => {
              // Done only with a time of this lap: the grid's out-lap starts in sector 3, with no S1 or S2 to mark
              const done = sectorDone(t, i);
              const active = i + 1 === t.currentSector;
              const ms = t.sectorTimesMs[i];
              const mark = done ? lapMark(ms, t.bestSectorTimesMs[i]) : null;
              return (
                <div key={i} className="rounded-lc-nub bg-white/5 px-1.5 py-1.5">
                  <div
                    className="h-0.75 rounded-full"
                    style={{ backgroundColor: mark ? LAP_MARK_COLOR[mark] : active ? "var(--color-lc-chalk)" : "var(--color-lc-line)" }}
                  />
                  <div className={`lc-data mt-1 flex items-center gap-1 text-[11px] ${done || active ? "text-lc-chalk" : "text-lc-slate"}`}>
                    {mark ? (
                      <>
                        {formatSectorTime(ms)}
                        <LapMarkGlyph mark={mark} />
                      </>
                    ) : (
                      `S${i + 1}`
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between gap-2">
            <span className="flex items-baseline gap-1.5">
              <span className={HUD_LBL}>{w.best}</span>
              <span className="lc-data text-[11px]" style={{ color: t.bestLapTimeMs ? HUD_BEST : undefined }}>
                {formatLapTime(t.bestLapTimeMs)}
              </span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className={HUD_LBL}>{w.last}</span>
              <span className="lc-data text-[11px] text-lc-chalk">{formatLapTime(t.lastLapTimeMs)}</span>
            </span>
          </div>
        </div>
      )}
    </section>
  );
};

/** Circuit map card with the sector and the corner you are in. Fills its parent's width. */
export const BroadcastMap: React.FC<Pick<HudDesignProps, "t" | "map" | "mapMode">> = ({ t, map, mapMode = "full" }) => {
  const corner = cornerLabel(t.currentTurnNumber, t.currentTurnName);
  const w = useBroadcastWords();
  return (
    <section aria-label={w.circuitMap} className={`w-full rounded-lc-card px-3.5 py-3 ${HUD_GLASS}`}>
      <MiniMap map={map} t={t} sectors local={mapMode === "local"} className={`block w-full ${mapMode === "local" ? "h-[180px]" : "h-[140px]"}`} stroke={22} />
      {/* The sector and the corner's number on one line, the corner's own name in full under them. Two lines are kept
          either way, so the panel under the map does not move at every corner */}
      <div className={`mt-1.5 min-h-[2lh] ${HUD_LBL}`} title={w.sectorTitle(t.currentSector, corner ? corner.full : w.straight)}>
        <div className="flex items-center justify-between gap-2">
          <span>{w.sector(t.currentSector)}</span>
          <span className="text-lc-chalk">{corner ? corner.short : w.straight}</span>
        </div>
        {corner?.name ? <div className="text-lc-chalk">{corner.name}</div> : null}
      </div>
    </section>
  );
};
