"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, RaceStatus } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { FlagIcon } from "@/components/ui/badges/FlagIcon";
import { HUD_BEST, HUD_GLASS, HUD_LBL, formatLapTime } from "./hud-format";

/** "9:41" */
const clock = (s: number) => {
  const whole = Math.max(0, Math.ceil(s));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * Qualifying's clock, one small pill at the top: the time left and the best clean lap; once the clock is out, whether
 * the lap under way still counts (finish it) or not
 */
export const QualifyingClock: React.FC<{ q: NonNullable<CarTelemetry["qualifying"]> }> = ({ q }) => {
  const tx = useTranslations("hud.qualifyingHud");
  // The clock re-renders every frame: its words are read once per language
  const words = useMemo(
    () => ({ label: tx("clock"), lastLap: tx("lastLap"), badge: tx("badge"), finishIt: tx("finishIt"), lapDeleted: tx("lapDeleted"), best: tx("best") }),
    [tx]
  );
  return (
    <div
      role="status"
      aria-label={words.label}
      className={`relative inline-flex h-8 items-center gap-2 rounded-full pe-3.5 ps-1.5 text-lc-chalk ${HUD_GLASS}`}
    >
      {q.lastLap ? (
        <Badge tone="neutral" variant="solid" size="sm" leading={<FlagIcon flag="chequered" size={14} />}>
          {words.lastLap}
        </Badge>
      ) : (
        <Badge tone="neutral" variant="solid" size="sm" icon="lapTimes">
          {words.badge}
        </Badge>
      )}
      <span className="lc-data text-[15px] leading-none">{q.lastLap ? (q.lapCounts ? words.finishIt : words.lapDeleted) : clock(q.remainingS)}</span>
      <span className={`${HUD_LBL} text-lc-fog`}>{words.best}</span>
      <span className="lc-data text-[13px] leading-none" style={{ color: q.bestMs ? HUD_BEST : undefined }}>
        {formatLapTime(q.bestMs)}
      </span>
    </div>
  );
};

/** The grid qualifying set, while it stands before the lights: place, driver and lap, the player's line marked */
export const QualifyingGrid: React.FC<{ rows: NonNullable<RaceStatus["qualifying"]> }> = ({ rows }) => {
  const tx = useTranslations("hud.qualifyingHud");
  const pole = rows[0]?.lapMs ?? null;
  const noTime = tx("noTime");
  return (
    <section aria-label={tx("grid")} className={`mt-1 w-[248px] rounded-lc-card px-3 py-2 text-lc-chalk ${HUD_GLASS}`}>
      <ol className="flex flex-col">
        {rows.map((r, i) => (
          <li
            key={r.code}
            className={`lc-data grid h-6 grid-cols-[1.5rem_1fr_auto] items-center gap-2 text-[12px] ${r.isPlayer ? "text-lc-volt" : ""}`}
          >
            <span className="text-lc-slate">{i + 1}</span>
            <span className="tracking-[0.1em]">{r.code}</span>
            <span className="text-end">
              {r.lapMs === null ? noTime : i === 0 || pole === null ? formatLapTime(r.lapMs) : `+${((r.lapMs - pole) / 1000).toFixed(3)}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
};
