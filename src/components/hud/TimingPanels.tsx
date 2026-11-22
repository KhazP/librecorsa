"use client";

import { activeLapWord } from "@/lib/track-data";
import React from "react";
import type { CarTelemetry, RaceStatus, TireCompound } from "@/types/f1";
import {
  HUD_BEST,
  HUD_GAIN,
  HUD_GLASS,
  HUD_INFO,
  HUD_LBL,
  HUD_LOSS,
  HUD_SLATE,
  LAP_MARK_COLOR,
  deltaDigits,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  lapMark,
  NO_TIME,
  sectorDone,
  type LapMark,
} from "./hud-format";
import { LibreCorsaMark } from "../ui/LibreCorsaLogo";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { DeltaBadge } from "@/components/ui/badges/DeltaBadge";
import { FlagIcon } from "@/components/ui/badges/FlagIcon";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { InvalidTag, LapMarkGlyph } from "./styles/hud-style-parts";
import { skinCss, SkinPanel, useHudSkin } from "./styles/third-party-skin";
import { challengePlaceLabel, type ChallengeTarget } from "@/lib/net/challenge-target";


/** The tower's columns: position, livery bar, driver, gap, last lap against yours (the header and the rows share them) */
const TOWER_COLS = "grid grid-cols-[22px_4px_1fr_auto_40px] gap-2 pr-2.5 pl-2";

/**
 * The tower's column names, over `TowerRows`: the gap and last-lap values sit right-aligned under theirs, so the signed
 * last-lap column reads without a tooltip
 */
export const TowerHeader: React.FC<{ gaps?: "interval" | "leader" }> = ({ gaps = "interval" }) => (
  <div className={`${TOWER_COLS} items-end pt-2 pb-0.5 leading-[1.2] ${HUD_LBL}`}>
    <span />
    <span />
    <span>Driver</span>
    <span className="text-right">{gaps === "leader" ? "Gap" : "Interval"}</span>
    <span className="text-right whitespace-nowrap" title="Their last lap against yours; on your line, against your best">
      Last
      <br />
      vs you
    </span>
  </div>
);

/**
 * The tower's lines: position, livery bar, driver code with the tyre, fastest-lap and penalty badges, the gap (to the
 * car ahead or to the leader) and the last lap against the player's (yours against your best on your own line).
 * `TowerHeader` names the columns above them.
 */
export const TowerRows: React.FC<{
  race: RaceStatus;
  gaps?: "interval" | "leader";
  /** Kept for older callers: every tower now sets its rows in `lc-data` */
  mono?: boolean;
}> = ({ race, gaps = "interval" }) => {
  const st = race.standings;
  const meIdx = st.findIndex((e) => e.isPlayer);
  const me = meIdx >= 0 ? st[meIdx] : undefined;
  const fastest = st.reduce<number | null>((m, e) => (e.bestLapMs && (m === null || e.bestLapMs < m) ? e.bestLapMs : m), null);
  // Interval: on the player's row and the one behind it the split gap (the time between the two cars at the same point,
  // as the Ahead / Behind box and the chasing chip read it), so the same gap never shows two values
  const splits = race.splits;
  const splitInterval = (i: number): number | null => {
    if (gaps !== "interval" || meIdx < 0) return null;
    if (i === meIdx && i > 0 && splits?.ahead?.driverCode === st[i - 1].driverCode) return splits.ahead.gapS;
    if (i === meIdx + 1 && splits?.behind?.driverCode === st[i].driverCode) return splits.behind.gapS;
    return null;
  };
  return (
    <ol className="m-0 list-none pt-0.5 pb-2">
      {st.map((e, i) => {
        const gap =
          i === 0 ? null : gaps === "leader" ? e.gapToLeaderS : (splitInterval(i) ?? e.intervalS ?? e.gapToLeaderS - st[i - 1].gapToLeaderS);
        // Their last lap against yours: − (loss) they were quicker, + (gain) you were
        const lastD = e.isPlayer
          ? e.lastLapMs && e.bestLapMs
            ? (e.lastLapMs - e.bestLapMs) / 1000
            : null
          : e.lastLapMs && me?.lastLapMs
            ? (e.lastLapMs - me.lastLapMs) / 1000
            : null;
        // A rival's gap that rounds to 0.00 is a tie: neutral, and shown without a sign
        const tie = lastD !== null && Math.abs(lastD) < 0.005;
        const lastColor = lastD === null || tie ? HUD_SLATE : lastD < 0 ? HUD_LOSS : HUD_GAIN;
        const purple = fastest !== null && e.bestLapMs === fastest;
        return (
          <li
            key={`${i}-${e.driverCode}`}
            title={e.name && e.name !== e.driverCode ? e.name : undefined}
            className={`lc-data ${TOWER_COLS} h-7.5 items-center text-[13px] ${
              e.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"
            }`}
          >
            <span className={`text-center ${e.isPlayer ? "" : "text-lc-slate"}`}>{i + 1}</span>
            <span className="h-4 rounded-full" style={{ backgroundColor: e.isPlayer ? "var(--color-lc-void)" : e.teamColorHex }} />
            <span className="flex min-w-0 items-center gap-1.5 tracking-[0.1em]">
              <span className="truncate">{e.driverCode}</span>
              {e.compound ? <CompoundGlyph compound={e.compound} size={14} /> : null}
              {purple ? (
                <Badge tone="best" variant="solid" size="hud" title="Fastest lap" aria-label="Fastest lap">
                  FL
                </Badge>
              ) : null}
              {e.dq ? (
                <PenaltyBadge penalty={{ kind: "disqualified" }} size="hud" variant="solid" />
              ) : e.penaltyS ? (
                <PenaltyBadge penalty={{ kind: "time", seconds: Math.round(e.penaltyS) }} size="hud" variant="solid" />
              ) : null}
              {e.finished ? <FlagIcon flag="chequered" size={14} label="Finished" /> : null}
              {!e.retired && e.damage !== undefined && e.damage >= 0.15 ? (
                <span
                  className={`inline-flex shrink-0 ${e.isPlayer ? "" : e.damage >= 0.6 ? "text-lc-loss" : "text-lc-caution"}`}
                  title={`Damaged (${Math.round(e.damage * 100)}%)`}
                >
                  <Icon name="damage" size="xs" className="size-3" label={`Damaged, ${Math.round(e.damage * 100)}%`} />
                </span>
              ) : null}
            </span>
            <span className={`text-[12px] ${e.retired ? (e.isPlayer ? "" : "text-lc-loss") : e.isPlayer ? "" : i === 0 ? "text-lc-fog" : "text-lc-slate"}`}>
              {e.retired ? "Out" : gap === null ? (gaps === "leader" ? "Leader" : "Lead") : `+${formatGap(gap)}`}
            </span>
            <span
              className="text-right text-[10px]"
              style={{ color: e.isPlayer && lastD !== null ? "var(--color-lc-void)" : lastColor, opacity: lastD === null ? 0.5 : 1 }}
              title={e.isPlayer ? "Last lap against your best" : "Their last lap against yours"}
            >
              {lastD === null
                ? ""
                : e.isPlayer && lastD <= 0.0005
                  ? "PB"
                  : tie
                    ? "0.00"
                    : `${lastD > 0 ? "+" : "−"}${Math.abs(lastD).toFixed(2)}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

/** Race order (LibreCorsa telemetry timing tower): position, class/livery bar, driver code, gaps and last laps */
export const TimingTower: React.FC<{ race: RaceStatus; trackCode?: string; gaps?: "interval" | "leader" }> = ({ race, trackCode, gaps }) => (
  <section aria-label="Timing tower" className={`w-[264px] overflow-hidden rounded-lc-tile ${HUD_GLASS}`}>
    {/* Pitboard header: mark, lap of laps, position and track code */}
    <div className="flex h-11 items-center gap-2.5 rounded-t-lc-tile rounded-b-lc-row bg-lc-chalk pr-3 pl-2 text-lc-void">
      <LibreCorsaMark className="h-7 w-7 shrink-0" />
      <span className="lc-disp flex-1 text-[18px] leading-none">
        Lap {race.lap}
        {race.totalLaps ? <span className="opacity-40">/{race.totalLaps}</span> : null}
      </span>
      <span className="inline-flex items-center gap-1">
        <PositionBadge position={race.position} player size="sm" />
        <span className="lc-data text-[11px] text-lc-void/60">/{race.fieldSize}</span>
      </span>
      {trackCode ? <span className={`${HUD_LBL} text-lc-void/60`}>{trackCode}</span> : null}
    </div>
    <TowerHeader gaps={gaps} />
    <TowerRows race={race} gaps={gaps} />
  </section>
);

interface LapPanelProps {
  telemetry: CarTelemetry;
  deltaS: number | null;
  /** Minimal HUD: a lap pill with a one-line sector and lap-time strip under it */
  variant?: "full" | "minimal";
  /** The running lap was cut (`useLapInvalid`): its clock stays crimson until the next lap */
  lapInvalid: boolean;
}

/**
 * Sector state (`lapMark`): best, personal best or slower once done, info in progress, a faint line to come. A sector
 * without a time of this lap (the grid's out-lap starts in sector 3) is one to come, not a best
 */
function sectorCells(telemetry: CarTelemetry) {
  return [0, 1, 2].map((idx) => {
    const sec = (idx + 1) as 1 | 2 | 3;
    const done = sectorDone(telemetry, idx);
    const active = sec === telemetry.currentSector;
    const t = done ? telemetry.sectorTimesMs[idx] : null;
    const mark: LapMark | null = t !== null ? lapMark(t, telemetry.bestSectorTimesMs[idx], !telemetry.race) : null;
    const color = mark ? LAP_MARK_COLOR[mark] : active ? HUD_INFO : "var(--color-lc-line)";
    return { sec, t, color, done, active, mark };
  });
}

/** Current lap time, live delta bar & badge, 3-sector telemetry cells, and last / best lap comparison */
export const LapPanel: React.FC<LapPanelProps> = ({ telemetry, deltaS, variant = "full", lapInvalid }) => {
  const sectors = sectorCells(telemetry);
  const lap = Math.max(1, telemetry.lapCount);
  // On the out-lap no lap is timed yet: the clock holds at zero and the counter says so
  const lapWord = telemetry.outLap ? "Out lap" : `${activeLapWord()} ${lap}`;
  // A cut lap is invalid: the clock shows it in the loss colour, with the word, until the next lap starts
  const timeColor = lapInvalid ? HUD_LOSS : "var(--color-lc-chalk)";

  if (variant === "minimal") {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <section aria-label="Lap" className={`flex items-center gap-3 rounded-lc-tile py-1.5 pr-4 pl-1.5 ${HUD_GLASS}`}>
          <span className="lc-data inline-flex h-9 items-center rounded-lc-row bg-lc-titanium px-3 text-[12px] tracking-[0.1em] text-lc-chalk uppercase">
            {lapWord}
          </span>
          <span className="lc-data text-[30px] leading-none" style={{ color: timeColor }}>
            {formatLapClock(telemetry)}
          </span>
          {lapInvalid ? <InvalidTag /> : null}
        </section>
        {/* Sectors, delta and last / best on one quiet line */}
        <div className={`lc-data hidden items-center gap-2.5 rounded-lc-row px-2.5 py-1 text-[10px] text-lc-slate sm:flex ${HUD_GLASS}`}>
          {sectors.map((s) => (
            <span key={s.sec} className="inline-flex items-center gap-1">
              <span className="h-1.5 w-3 rounded-full" style={{ backgroundColor: s.color }} />
              <span style={{ color: s.active ? HUD_INFO : undefined }}>S{s.sec}</span>
              <span className={s.done ? "text-lc-chalk" : ""}>{s.done ? formatSectorTime(s.t) : NO_TIME}</span>
              {s.mark ? <LapMarkGlyph mark={s.mark} /> : null}
            </span>
          ))}
          {deltaS !== null ? <DeltaBadge seconds={deltaS} digits={deltaDigits(deltaS)} size="hud" /> : null}
          <span className="inline-flex items-baseline gap-1">
            <span className={HUD_LBL}>Last</span> <span className="text-lc-chalk/90">{formatLapTime(telemetry.lastLapTimeMs)}</span>
          </span>
          <span className="inline-flex items-baseline gap-1">
            <span className={HUD_LBL}>Best</span>
            <span style={{ color: telemetry.bestLapTimeMs ? HUD_BEST : undefined }}>{formatLapTime(telemetry.bestLapTimeMs)}</span>
          </span>
        </div>
      </div>
    );
  }

  // Normalized delta bar (-1.0s to +1.0s): ahead fills green to the left of centre, behind red to the right
  const deltaNorm = deltaS !== null ? Math.max(-1, Math.min(1, deltaS / 1.0)) : 0;

  return (
    <section aria-label="Lap" className={`w-[256px] rounded-lc-card p-3.5 ${HUD_GLASS}`}>
      {/* Header: lap counter and live delta pill */}
      <div className="flex items-center justify-between gap-2">
        <span className="lc-data inline-flex items-center gap-2 text-[13px] tracking-[0.1em] text-lc-chalk uppercase">
          {lapWord}
        </span>
        {deltaS !== null ? (
          <DeltaBadge seconds={deltaS} digits={deltaDigits(deltaS)} size="sm" variant="solid" />
        ) : (
          <span className={HUD_LBL}>No ref lap</span>
        )}
      </div>

      {/* Live delta gauge */}
      <div className="relative my-2.5 h-1.5 w-full overflow-hidden rounded-full bg-lc-titanium">
        {/* Each half scales from the centre (transform only, so the gauge never re-lays out) */}
        {deltaS !== null ? (
          <span
            className={`absolute inset-y-0 w-1/2 transition-transform duration-100 ease-linear ${
              deltaNorm <= 0 ? "right-1/2 origin-right bg-lc-gain" : "left-1/2 origin-left bg-lc-loss"
            }`}
            style={{ transform: `scaleX(${Math.abs(deltaNorm)})` }}
          />
        ) : null}
        <span className="absolute inset-y-0 left-1/2 w-px bg-lc-chalk/50" />
      </div>

      {/* Current lap clock */}
      <div className="flex items-center gap-2">
        <span className="lc-data text-[38px] leading-none tracking-[-0.01em]" style={{ color: timeColor }}>
          {formatLapClock(telemetry)}
        </span>
        {lapInvalid ? <InvalidTag /> : null}
      </div>

      {/* Sector cells */}
      <div className="mt-2.5 grid grid-cols-3 gap-1">
        {sectors.map((s) => (
          <div key={s.sec} className="rounded-lc-nub bg-white/5 px-2 py-1.5">
            <div className="h-1 rounded-full" style={{ backgroundColor: s.color }} />
            <div className={`${HUD_LBL} mt-1.25`} style={s.active ? { color: HUD_INFO } : undefined}>
              S{s.sec}
            </div>
            <div className="lc-data flex items-center gap-1 text-[12px]" style={{ color: s.done ? "var(--color-lc-chalk)" : HUD_SLATE }}>
              {s.done ? formatSectorTime(s.t) : NO_TIME}
              {s.mark ? <LapMarkGlyph mark={s.mark} /> : null}
            </div>
          </div>
        ))}
      </div>

      {/* Last and best lap */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-lc-line pt-2.5">
        <div>
          <div className={HUD_LBL}>Last lap</div>
          <div className="lc-data text-[15px] text-lc-chalk/90">{formatLapTime(telemetry.lastLapTimeMs)}</div>
        </div>
        <div className="text-right">
          <div className={HUD_LBL}>Best lap</div>
          <div className="lc-data text-[15px]" style={{ color: telemetry.bestLapTimeMs ? HUD_BEST : "var(--color-lc-chalk)" }}>
            {formatLapTime(telemetry.bestLapTimeMs)}
          </div>
        </div>
      </div>
    </section>
  );
};

/** The time trial's target while the weekly challenge is driven: the player's best, the week's fastest, the place */
export const ChallengeTargetPanel: React.FC<{ target: ChallengeTarget }> = ({ target }) => {
  const skin = useHudSkin();
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className={skin ? `text-[9px] font-bold tracking-[0.08em] uppercase ${skinCss.inkDim}` : HUD_LBL}>Your best</div>
          <div className={`lc-data text-[15px] ${skin ? skinCss.ink : "text-lc-chalk"}`}>{formatLapTime(target.bestMs)}</div>
        </div>
        <div className="text-right">
          <div className={skin ? `text-[9px] font-bold tracking-[0.08em] uppercase ${skinCss.inkDim}` : HUD_LBL}>This week&apos;s fastest</div>
          <div className="lc-data text-[15px]" style={{ color: HUD_BEST }}>
            {formatLapTime(target.leaderMs)}
          </div>
        </div>
      </div>
      <div className={`lc-data mt-2 border-t pt-2 text-[12px] ${skin ? `${skinCss.divider} ${skinCss.inkSoft}` : "border-lc-line text-lc-fog"}`}>
        {challengePlaceLabel(target)}
      </div>
    </>
  );
  if (skin) {
    return (
      <SkinPanel cut="sm" className="w-[256px]" innerClassName="px-3.5 py-3">
        <section aria-label="This week's challenge">{content}</section>
      </SkinPanel>
    );
  }
  return (
    <section aria-label="This week's challenge" className={`w-[256px] rounded-lc-card px-3.5 py-3 ${HUD_GLASS}`}>
      {content}
    </section>
  );
};
