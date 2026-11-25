"use client";

import React from "react";
import { useFormatter, useTranslations } from "use-intl/react";
import { seasonTest, testCircuit, type SeasonState } from "@/lib/career/career-state";
import { formatLapTime } from "@/components/hud/hud-format";
import { Button, Card, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { CareerCircuitOutline, StatTile, carTitle, trackLabel } from "./career-ui";

/**
 * The season's test day on the career screen: where it runs (the next round's circuit, the first before the season
 * starts) and in what, and once driven its programme's result there in the season's car: the laps run, the best clean
 * lap against the target (the pace of the promotion places). Optional: nothing waits on it.
 *
 * Before the season starts it stands out (a card of its own under the series); during the season it sits beside the
 * championship, compact (the next round's circuit is drawn above it).
 */
export const TestDayCard: React.FC<{
  season: SeasonState;
  onTestDay: () => void;
  /** Without the circuit's drawing (the season's next race shows it) */
  compact?: boolean;
  className?: string;
}> = ({ season, onTestDay, compact, className }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const at = testCircuit(season);
  if (!at) return null;
  const track = trackLabel(at.trackId);
  const car = carTitle(season.settings.car);
  const result = seasonTest(season, at.trackId, season.settings.car);
  const preseason = !season.started;
  const gapMs = result?.bestMs != null && result.targetMs != null ? result.bestMs - result.targetMs : null;
  const gap = gapMs !== null ? format.number(Math.abs(gapMs) / 1000, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : "";

  const button = (
    <Button variant="secondary" size={preseason ? "lg" : "md"} icon={<Icon name="drive" />} onClick={onTestDay}>
      {tx("testDrive")}
    </Button>
  );

  return (
    <Card
      className={className}
      title={preseason ? tx("testPreseasonTitle") : tx("testDayCircuit", { circuit: track.name })}
      description={
        preseason ? tx("testPreseasonBody", { car, circuit: track.name }) : tx("testSeasonBody", { car, round: at.roundIndex + 1 })
      }
      action={
        <Badge tone="neutral" size="sm">
          {tx("testOptional")}
        </Badge>
      }
      bodyClassName="flex flex-col gap-3"
    >
      <div className={compact ? "flex flex-col gap-3" : "grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)] short:gap-2"}>
        {compact ? null : (
          <Well className="relative flex aspect-video items-center justify-center overflow-hidden p-3 short:hidden">
            <CareerCircuitOutline trackId={at.trackId} className="max-h-full max-w-full" strokeClassName="stroke-lc-chalk" label={track.name} />
            <span className="lc-mono absolute bottom-1.5 end-2 text-[11px] font-bold text-lc-slate">{track.name}</span>
          </Well>
        )}
        <div className="flex min-w-0 flex-col justify-between gap-3 short:gap-2">
          {result ? (
            <>
              <div className="grid grid-cols-3 gap-2.5 short:gap-2">
                <StatTile label={tx("statLaps")} value={format.number(result.laps)} />
                <StatTile label={tx("testBest")} value={result.bestMs ? formatLapTime(result.bestMs) : tx("testNoBest")} />
                <StatTile label={tx("testTarget")} value={result.targetMs ? formatLapTime(result.targetMs) : tx("testNoTarget")} />
              </div>
              {gapMs !== null ? (
                <Badge tone={gapMs <= 0 ? "good" : "warn"} size="md" icon={gapMs <= 0 ? "success" : "lapTimes"} className="self-start">
                  {gapMs <= 0 ? tx("testUnderTarget", { gap }) : tx("testOverTarget", { gap })}
                </Badge>
              ) : (
                <p className="lc-hint m-0">{result.targetMs ? tx("testNoOwnLap") : tx("testNoTargetHint")}</p>
              )}
            </>
          ) : (
            <p className="lc-body m-0 max-w-[60ch]">{tx("testProgramme")}</p>
          )}
          <div className="flex flex-wrap items-center gap-2.5">{button}</div>
        </div>
      </div>
    </Card>
  );
};
