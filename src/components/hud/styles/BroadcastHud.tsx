"use client";

import { getActivePointToPoint } from "@/lib/track-data";
import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  atShiftPoint,
  cornerLabel,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  formatSpeed,
  HUD_BEST,
  HUD_CAUTION,
  HUD_GREEN,
  HUD_RED,
  HUD_SHIFT,
  LAP_MARK_COLOR,
  sectorDone,
  speedUnit,
  TYRE_CONDITION_SHOW,
  tyreHeatColor,
  sessionWord,
} from "../hud-format";
import { predictedLapMs } from "../third-party-data";
import { LibreCorsaMark } from "../../ui/LibreCorsaLogo";
import {
  AeroBadge,
  anchor,
  DeltaReadout,
  formatOnce,
  gearLabel,
  HUD_GLASS,
  HUD_LBL,
  InvalidTag,
  lapMark,
  LapMarkGlyph,
  MiniMap,
  raceNeighbours,
  type HudDesignProps,
} from "./hud-style-parts";
import { PedalBars } from "../PedalBars";
import { TowerHeader, TowerRows } from "../TimingPanels";
import { aeroReadout } from "../aero-label";

/** The Broadcast layout's words in the current language, resolved once per language (the Telemetry layout shares its tower and map) */
function useBroadcastWords() {
  const tx = useTranslations("hudStyles.broadcast");
  return useMemo(
    () => ({
      timingTower: tx("timingTower"),
      session: tx("session"),
      outLap: tx("outLap"),
      best: tx("best"),
      last: tx("last"),
      circuitMap: tx("circuitMap"),
      straight: tx("straight"),
      chasing: tx("chasing"),
      tyreTemps: tx("tyreTemps"),
      fuel: tx("fuel"),
      delta: tx("delta"),
      predicted: tx("predicted"),
      quicker: tx("quicker"),
      slower: tx("slower"),
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
  return (
    <section aria-label={race ? w.timingTower : w.session} className={`w-full overflow-hidden rounded-lc-tile ${HUD_GLASS} ${className}`}>
      <div className="flex h-11 items-center gap-2.5 rounded-[20px_20px_14px_14px] bg-lc-chalk pr-3 pl-2 text-lc-void">
        <LibreCorsaMark className="h-7 w-7 shrink-0" />
        <div className="lc-disp flex-1 truncate text-[18px]">
          {race ? (
            w.raceLap(race.lap, race.totalLaps ?? 0)
          ) : (
            <>
              {/* On the out-lap no lap is timed yet: the header says so on its own (the session word would not fit
                  beside it), as the clock holds at zero */}
              {t.outLap
                ? w.outLap
                : w.sessionLap(sessionWord(t), getActivePointToPoint() ? "run" : "lap", Math.max(1, t.lapCount))}
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

/** Rev lights: 18 segments along the top of the pod (green, red, then the shift colour) */
const LEDS = 18;
const ledColor = (i: number) => (i < 8 ? HUD_GREEN : i < 14 ? HUD_RED : HUD_SHIFT);

/**
 * Broadcast: the look of a TV world feed. Timing tower top-left, a sector-coloured map top-right,
 * and one telemetry pod along the bottom, a strip of rev lights over speed, gear, energy and the
 * delta: everything reads at a glance from the sofa, nothing covers the racing line.
 */
export const BroadcastHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  compound = "soft",
  revRange,
  scale,
  trackCode,
  mfd,
  lapInvalid,
  towerGaps,
  mapMode,
  leftExtra,
  rightExtra,
  showDeltaBar,
}) => {
  const race = t.race;
  // The pod shows the delta only where the top-centre delta bar is switched off; the bar is also down through the start
  // lights, and the pod keeps its predicted lap there rather than switching words for a few seconds
  const podDelta = showDeltaBar === false && race?.phase !== "lights";
  const predictedMs = predictedLapMs(t.bestLapTimeMs, deltaS);
  const predictedText = formatLapTime(predictedMs);
  // The tile's tone and arrow follow what it shows: no predicted lap (no best lap of this car yet), no tone
  const podTone = podDelta || predictedMs !== null ? deltaS : null;
  const [revStart, revFull] = revRange;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * LEDS);
  const shift = atShiftPoint(t.rpm, revFull);
  const hasErs = t.f12026?.hasErs ?? true;
  const aero = aeroReadout(t);
  // The car ahead found by the player's row, as the tower, the MFD and the other styles find it
  const ahead = race ? raceNeighbours(t)?.ahead ?? null : null;
  const units = useUnits();
  const w = useBroadcastWords();

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      <div className="absolute top-[clamp(14px,2.2vw,24px)] left-[clamp(14px,2.2vw,24px)] flex w-[264px] flex-col gap-2" style={anchor(scale, "top left")}>
        <BroadcastTower t={t} trackCode={trackCode} lapInvalid={lapInvalid} gaps={towerGaps} />
        {leftExtra}
      </div>

      <div className="absolute top-[clamp(14px,2.2vw,24px)] right-[clamp(14px,2.2vw,24px)] hidden w-[236px] md:block" style={anchor(scale, "top right")}>
        <BroadcastMap t={t} map={map} mapMode={mapMode} />
        {rightExtra ? <div className="mt-2">{rightExtra}</div> : null}
      </div>

      {mfd ? (
        // Beside the pod on a wide screen, above it on a laptop
        <div
          className="absolute right-[clamp(14px,2.2vw,24px)] bottom-[136px] hidden lg:block xl:bottom-[clamp(14px,2.2vw,24px)]"
          style={anchor(scale, "bottom right")}
        >
          {mfd}
        </div>
      ) : null}

      {/* Bottom telemetry pod */}
      <div
        className="absolute bottom-[clamp(14px,2.2vw,24px)] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5"
        style={anchor(scale, "bottom center")}
      >
        {race && ahead ? (
          <div className={`inline-flex h-7.5 items-center gap-2.5 rounded-lc-row pr-3.5 pl-1.5 ${HUD_GLASS}`}>
            <PositionBadge position={race.position} player size="sm" />
            <span className={HUD_LBL}>{w.chasing}</span>
            <span className="lc-data text-[11px] tracking-[0.1em]" style={{ color: ahead.color }}>
              {ahead.code}
            </span>
            <span className="lc-data text-[11px] text-lc-chalk">{formatGap(ahead.gap, true)}{Math.abs(ahead.gap) < 100 ? " s" : ""}</span>
          </div>
        ) : null}

        <div data-hud-avoid className={`flex flex-col gap-2 rounded-lc-sheet p-2 ${HUD_GLASS}`}>
          {/* Rev lights; all in the shift colour at the shift point */}
          <div className="flex gap-0.75 px-4 pt-1" aria-hidden>
            {Array.from({ length: LEDS }, (_, i) => (
              <span
                key={i}
                className="h-1.25 flex-1 rounded-full bg-white/8"
                style={shift ? { backgroundColor: HUD_SHIFT } : i < lit ? { backgroundColor: ledColor(i) } : undefined}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {/* Tyres */}
            <div className="hidden items-center gap-2.5 pr-3 pl-3 lg:flex">
              <CompoundGlyph compound={compound as TireCompound} size={34} />
              <span className="grid grid-cols-[repeat(2,15px)] gap-0.75" role="img" aria-label={w.tyreTemps}>
                {t.tireTempsC.map((c, i) => {
                  const bands = t.tireBandTempsC?.[i] ?? [c, c, c];
                  const flagged =
                    (t.tireGrainLevel?.[i] ?? 0) >= TYRE_CONDITION_SHOW ||
                    (t.tireBlisterLevel?.[i] ?? 0) >= TYRE_CONDITION_SHOW ||
                    (t.tireFlatSpotSeverity?.[i] ?? 0) >= TYRE_CONDITION_SHOW;
                  return (
                    <span
                      key={i}
                      className={`flex h-4.5 gap-px rounded-sm border-[1.5px] p-px ${flagged ? "border-dashed" : ""}`}
                      style={{ borderColor: flagged ? HUD_CAUTION : tyreHeatColor(c, t.tireOptimalTempC) }}
                    >
                      {bands.map((b, k) => (
                        <span key={k} className="flex-1 rounded-xs" style={{ backgroundColor: tyreHeatColor(b, t.tireOptimalTempC) }} />
                      ))}
                    </span>
                  );
                })}
              </span>
            </div>

            {/* Speed and pedals */}
            <div className="flex items-center gap-3.5 px-4 lg:border-l lg:border-white/[0.08]">
              <div className="flex flex-col items-end">
                <span className="lc-data w-[84px] text-right text-[42px] leading-none tracking-[-0.02em] text-lc-chalk">
                  {formatSpeed(t.speedKmh, units)}
                </span>
                <span className={HUD_LBL}>{speedUnit(units)}</span>
              </div>
              <PedalBars t={t} size="compact" />
            </div>

            {/* Gear */}
            <span
              className={`flex h-17 w-17 shrink-0 items-center justify-center rounded-lc-tile text-lc-void transition-colors duration-75 ${
                shift ? "bg-lc-cyan" : "bg-lc-volt"
              }`}
            >
              <span className="lc-disp text-[48px] leading-none">{gearLabel(t.gear)}</span>
            </span>

            {/* Energy and aero (F1), fuel (GT3) */}
            <div className="hidden w-[118px] shrink-0 flex-col gap-1.5 px-4 sm:flex">
              {hasErs ? (
                <>
                  <span className="flex items-center justify-between">
                    <span className={`inline-flex items-center gap-1 ${HUD_LBL}`}>
                      <Icon name="ers" size="xs" className={`size-3 ${t.mgukPowerKw > 0 ? "text-lc-info" : "text-lc-slate"}`} />
                      ERS
                    </span>
                    <span className="lc-data text-[11px] text-lc-chalk">{Math.round(t.ersBatteryPercent)}%</span>
                  </span>
                  <span className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-lc-info" style={{ width: `${t.ersBatteryPercent}%` }} />
                  </span>
                  <AeroBadge open={aero.open} armed={aero.armed} label={aero.label} />
                </>
              ) : t.fuelKg > 0 ? (
                <>
                  <span className={`flex items-center gap-1.5 ${HUD_LBL}`}>
                    <Icon name="fuel" size="xs" className="size-3" /> {w.fuel}
                  </span>
                  <span className="lc-data text-[18px] leading-none whitespace-nowrap text-lc-chalk">{t.fuelKg.toFixed(1)} kg</span>
                </>
              ) : (
                <>
                  <span className={HUD_LBL}>Rpm</span>
                  <span className="lc-data text-[18px] leading-none text-lc-chalk">{Math.round(t.rpm)}</span>
                </>
              )}
            </div>

            {/* The lap the live delta predicts, toned by the delta's sign, while the delta bar at the top centre shows
                the delta itself; the delta here when that bar is switched off. Fixed width, so the pod never reflows */}
            <div
              className={`flex h-17 w-33 shrink-0 flex-col justify-center gap-1 rounded-lc-tile px-3.5 ${
                podTone === null ? "bg-lc-titanium text-lc-slate" : podTone <= 0 ? "bg-lc-gain text-lc-void" : "bg-lc-loss text-lc-void"
              }`}
            >
              {podDelta ? (
                <>
                  <span className={`${HUD_LBL} text-current opacity-70`}>{w.delta}</span>
                  <DeltaReadout deltaS={deltaS} className="text-[24px]" />
                </>
              ) : (
                <>
                  <span className={`inline-flex items-center gap-1 ${HUD_LBL} text-current`}>
                    <span className="opacity-70">{w.predicted}</span>
                    {podTone !== null ? (
                      <Trend direction={podTone <= 0 ? "up" : "down"} size={9} label={podTone <= 0 ? w.quicker : w.slower} />
                    ) : null}
                  </span>
                  <span className={`lc-data leading-none whitespace-nowrap ${predictedText.length > 8 ? "text-[17px]" : "text-[20px]"}`}>
                    {predictedText}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

